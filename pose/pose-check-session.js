/**
 * pose/pose-check-session.js — the 2D pose check (pose/pose-check.js) applied to
 * a session: fit each camera's model, score the detections a tracking pass is
 * about to use, count what it found, and answer "what is this pose?" for the UI.
 *
 * DOM-free (it reads Session / FrameGroup / Instance and the lazy loader only),
 * so the run logic is Node-testable (`tests/test-pose-check.mjs`).
 *
 * ## Where the fit comes from
 *
 * Every camera's model is fitted on the predictions of evenly spaced frames —
 * every frame of a short session, about `POSE_SAMPLE_FRAMES` of a long one. An
 * eager session reads them from `session.frameGroups`. A lazy (windowed)
 * project, whose `frameGroups` is only the resident window, reads them from its
 * loader one frame at a time (`getFrameSync`) and releases each again unless it
 * was already cached or resident, so sampling never grows what is held.
 *
 * ## What a run records
 *
 * Counts per camera, and one entry per flagged (uncommon or outlier) detection:
 * frame, camera, score and class. Nothing is written onto an Instance — a lazy
 * project's instances come and go — so the UI scores the instance it is drawing
 * against the run's models instead (`poseCheckOf`), which costs about a
 * microsecond.
 *
 * ## Two ways to run it
 *
 * A tracking pass scores each detection as it is offered to the tracker
 * (`poseCheckExcludes`). Tracks ▸ Check Poses (`checkSessionPoses`) scores every
 * prediction of the whole project without tracking anything — the way back to
 * the marks after a reopen, since the verdicts are never saved. On a lazy
 * project it reads each RESIDENT frame from the session (what is on screen,
 * edits included) and every other frame from the loader, released again
 * unless it was already cached.
 */

import {
    createPoseSample, fitPoseModel, poseScore, poseClassOf, poseSampleStride, trimPosePatterns,
    POSE_UNCOMMON, POSE_OUTLIER, POSE_COMMON,
} from './pose-check.js';

// A windowed lazy loader — `session.frameGroups` is then only the resident window.
function isWindowedLoader(loader) {
    return !!(loader && loader.isSync && typeof loader.releaseWindow === 'function' &&
        typeof loader.getFrameSync === 'function');
}

// A lazy-loader frame entry's `points` ([x, y] | null per node) as interleaved xy.
function pointsToXY(points, out) {
    for (var k = 0, n = out.length >> 1; k < n; k++) {
        var p = points ? points[k] : null;
        if (p && isFinite(p[0]) && isFinite(p[1])) { out[2 * k] = p[0]; out[2 * k + 1] = p[1]; }
        else { out[2 * k] = NaN; out[2 * k + 1] = NaN; }
    }
    return out;
}

/**
 * Fit every camera's pose model on the session's predictions.
 * @param {Object} session
 * @param {Array<{name:string}>} cameras  the cameras to model
 * @returns {Map<string, Object|null>} camera name -> model (null: too little data to model)
 */
export function fitSessionPoseModels(session, cameras) {
    var K = session && session.skeleton && session.skeleton.nodes ? session.skeleton.nodes.length : 0;
    var samples = new Map();
    for (var c = 0; c < cameras.length; c++) samples.set(cameras[c].name, createPoseSample(K));
    var loader = session.lazyLoader;
    if (isWindowedLoader(loader)) {
        var xy = new Float64Array(2 * K);
        var stride = poseSampleStride(loader.nFrames);
        for (var fi = 0; fi < loader.nFrames; fi += stride) {
            var wasCached = !!(loader.cache && loader.cache.has(fi));
            var data = loader.getFrameSync(fi);
            if (data) {
                data.forEach(function (list, camName) {
                    var s = samples.get(camName);
                    if (!s || !list) return;
                    for (var i = 0; i < list.length; i++) {
                        var d = list[i];
                        if (d && d.type === 'predicted') s.offer(pointsToXY(d.points, xy));
                    }
                });
            }
            if (!wasCached && !session.frameGroups.has(fi) && typeof loader.releaseFrame === 'function') {
                loader.releaseFrame(fi);
            }
        }
    } else {
        var frames = session.frameIndices || [];
        var step = poseSampleStride(frames.length);
        for (var f = 0; f < frames.length; f += step) {
            var fg = session.getFrameGroup(frames[f]);
            if (!fg) continue;
            samples.forEach(function (s, camName) {
                var linked = fg.getInstances(camName);
                if (linked) for (var i = 0; i < linked.length; i++) {
                    if (linked[i].type === 'predicted') s.offer(linked[i]._xy);
                }
                var unlinked = fg.getUnlinkedInstances(camName);
                if (unlinked) for (var j = 0; j < unlinked.length; j++) {
                    if (unlinked[j].instance.type === 'predicted') s.offer(unlinked[j].instance._xy);
                }
            });
        }
    }
    var models = new Map();
    samples.forEach(function (s, camName) { models.set(camName, fitPoseModel(s.poses, K)); });
    return models;
}

function emptyCounts() {
    return { checked: 0, untested: 0, common: 0, uncommon: 0, outliers: 0 };
}

/**
 * A tracking pass's pose check.
 * @param {Map<string, Object|null>} models  from `fitSessionPoseModels`
 * @param {number} uncommonAt  Tracking Wizard `poseUncommonZ`
 * @param {number} outlierAt   Tracking Wizard `poseOutlierZ` (0: nothing is an outlier)
 * @param {boolean} [exclude]  Tracking Wizard `poseExcludeOutliers`: leave outliers out of tracking
 */
export function createPoseCheckRun(models, uncommonAt, outlierAt, exclude) {
    return {
        models: models, uncommonAt: uncommonAt, outlierAt: outlierAt, exclude: !!exclude,
        counts: new Map(),
        flags: [],          // {frame, camera, score, cls}, in the order checked
    };
}

/**
 * Check one detection a tracking pass is about to use, and record it.
 * User instances are never checked: a person placed them.
 * @returns {boolean} true when the detection is an outlier AND the run leaves outliers
 *   out of tracking (`exclude`) — the caller then drops it
 */
export function poseCheckExcludes(run, camName, inst, frameIdx) {
    if (!run || !inst || inst.type !== 'predicted') return false;
    return recordPose(run, camName, inst._xy, frameIdx) === POSE_OUTLIER && run.exclude;
}

// Score one predicted pose (interleaved xy), count it and flag it; its class.
function recordPose(run, camName, xy, frameIdx) {
    var c = run.counts.get(camName);
    if (!c) { c = emptyCounts(); run.counts.set(camName, c); }
    var model = run.models.get(camName);
    var z = model ? poseScore(model, xy) : NaN;
    var cls = poseClassOf(z, run.uncommonAt, run.outlierAt);
    if (cls === POSE_COMMON) { c.checked++; c.common++; return cls; }
    if (cls < 0) { c.untested++; return cls; }
    c.checked++;
    if (cls === POSE_UNCOMMON) c.uncommon++; else c.outliers++;
    run.flags.push({ frame: frameIdx, camera: camName, score: z, cls: cls });
    return cls;
}

// Score every prediction of a FrameGroup in the given cameras.
function recordFrameGroup(run, fg, cameraNames, frameIdx) {
    cameraNames.forEach(function (camName) {
        var linked = fg.getInstances(camName);
        if (linked) for (var i = 0; i < linked.length; i++) {
            if (linked[i].type === 'predicted') recordPose(run, camName, linked[i]._xy, frameIdx);
        }
        var unlinked = fg.getUnlinkedInstances(camName);
        if (unlinked) for (var j = 0; j < unlinked.length; j++) {
            if (unlinked[j].instance.type === 'predicted') recordPose(run, camName, unlinked[j].instance._xy, frameIdx);
        }
    });
}

/** Frames between progress reports in `checkSessionPoses`. */
var CHECK_PROGRESS_FRAMES = 256;

/**
 * Tracks ▸ Check Poses: fit every camera's model and score EVERY prediction of
 * the project, tracking nothing. The result is what a tracking pass leaves
 * (`finishPoseCheckRun`), with `excluded` false: nothing was left out.
 *
 * A windowed lazy project is read frame by frame from its loader, except the
 * resident frames, which are read from the session; a frame the scan loaded is
 * released again unless it was already cached. Any other session must hold
 * every frame in `frameGroups` (the caller materializes a non-windowed lazy one
 * first, as Track All does).
 *
 * @param {Object} session
 * @param {Array<{name:string}>} cameras
 * @param {number} uncommonAt  Tracking Wizard `poseUncommonZ`
 * @param {number} outlierAt   Tracking Wizard `poseOutlierZ`
 * @param {{onProgress?: function(number, number): (Promise|void)}} [opts]  called
 *   every few hundred frames with (frames done, frames in all), and awaited, so
 *   the caller can paint a progress bar
 */
export async function checkSessionPoses(session, cameras, uncommonAt, outlierAt, opts) {
    var onProgress = opts && opts.onProgress;
    var run = createPoseCheckRun(fitSessionPoseModels(session, cameras), uncommonAt, outlierAt, false);
    var names = cameras.map(function (c) { return c.name; });
    var wanted = new Set(names);
    var loader = session.lazyLoader;
    var total;
    if (isWindowedLoader(loader)) {
        total = loader.nFrames;
        var K = session.skeleton && session.skeleton.nodes ? session.skeleton.nodes.length : 0;
        var xy = new Float64Array(2 * K);
        for (var fi = 0; fi < total; fi++) {
            var fg = session.frameGroups.has(fi) ? session.getFrameGroup(fi) : null;
            if (fg) {
                recordFrameGroup(run, fg, names, fi);
            } else {
                var wasCached = !!(loader.cache && loader.cache.has(fi));
                var data = loader.getFrameSync(fi);
                if (data) {
                    data.forEach(function (list, camName) {
                        if (!wanted.has(camName) || !list) return;
                        for (var i = 0; i < list.length; i++) {
                            var d = list[i];
                            if (d && d.type === 'predicted') recordPose(run, camName, pointsToXY(d.points, xy), fi);
                        }
                    });
                }
                if (!wasCached && !session.frameGroups.has(fi) && typeof loader.releaseFrame === 'function') {
                    loader.releaseFrame(fi);
                }
            }
            if (onProgress && (fi + 1) % CHECK_PROGRESS_FRAMES === 0) await onProgress(fi + 1, total);
        }
    } else {
        var frames = session.frameIndices || [];
        total = frames.length;
        for (var f = 0; f < total; f++) {
            var g = session.getFrameGroup(frames[f]);
            if (g) recordFrameGroup(run, g, names, frames[f]);
            if (onProgress && (f + 1) % CHECK_PROGRESS_FRAMES === 0) await onProgress(f + 1, total);
        }
    }
    if (onProgress) await onProgress(total, total);
    return finishPoseCheckRun(run);
}

/**
 * The status line for a finished check (`session.poseCheck`):
 * "2D poses: 13 uncommon, 3 outliers of 431,112 checked — marked ? and ✕ in the
 * views; hover a node for its score".
 */
export function describePoseCheck(pc) {
    var n = function (v) { return (v || 0).toLocaleString('en-US'); };
    if (!pc || !pc.cameras || !pc.cameras.some(function (c) { return c.modelled; })) {
        return '2D poses: not checked — too few complete poses to learn from';
    }
    var t = pc.total;
    var flagged = [t.uncommon ? n(t.uncommon) + ' uncommon' : '',
        t.outliers ? n(t.outliers) + (t.outliers === 1 ? ' outlier' : ' outliers') : ''].filter(Boolean).join(', ');
    return '2D poses: ' + (flagged || 'none flagged') + ' of ' + n(t.checked) + ' checked' +
        (flagged ? ' — marked ? and ✕ in the views; hover a node for its score' : '');
}

/**
 * What a finished run leaves on the session (`session.poseCheck`): the models
 * (so the views can score what they draw), the thresholds it used, whether it
 * left outliers out of tracking (`excluded`), the counts per camera and in total,
 * and the flagged detections in frame order. Transient: never saved with the project.
 * Each model's pattern cache is trimmed to its most-used patterns first
 * (`trimPosePatterns`), since the result is kept for as long as the session is.
 */
export function finishPoseCheckRun(run) {
    var total = emptyCounts(), cameras = [];
    run.models.forEach(function (model, name) {
        trimPosePatterns(model);
        var c = run.counts.get(name) || emptyCounts();
        cameras.push(Object.assign({ name: name, modelled: !!model }, c));
        for (var k in total) total[k] += c[k];
    });
    var flags = run.flags.slice().sort(function (a, b) { return a.frame - b.frame; });
    return {
        models: run.models, uncommonAt: run.uncommonAt, outlierAt: run.outlierAt, excluded: run.exclude,
        cameras: cameras, total: total, flags: flags,
    };
}

/**
 * The pose check's verdict on one drawn instance, or null when there is none
 * (no check has run, it is a user instance, or its camera has no model).
 * @returns {{cls:number, score:number}|null}  cls -1 = too few nodes to test
 */
export function poseCheckOf(session, camName, inst) {
    var pc = session && session.poseCheck;
    if (!pc || !inst || inst.type !== 'predicted') return null;
    var model = pc.models.get(camName);
    if (!model) return null;
    var z = poseScore(model, inst._xy);
    return { cls: poseClassOf(z, pc.uncommonAt, pc.outlierAt), score: z };
}

/**
 * The node tooltip's pose line for a verdict from `poseCheckOf`:
 * "Pose: uncommon (score 12.3)", "Pose: outlier (score 18.0)" — with
 * ", not tracked" when the pass left outliers out.
 * @param {{cls:number, score:number}|null} v
 * @param {Object} pc  `session.poseCheck`
 */
export function poseTooltipLine(v, pc) {
    if (!v) return '';
    if (v.cls < 0) return 'Pose: too few nodes to check';
    var word = v.cls === POSE_OUTLIER ? 'outlier' : v.cls === POSE_UNCOMMON ? 'uncommon' : 'common';
    return 'Pose: ' + word + ' (score ' + v.score.toFixed(1) + ')' +
        (v.cls === POSE_OUTLIER && pc && pc.excluded ? ', not tracked' : '');
}

// ---- Stepping through the flagged poses (Navigation: `]` / `[`) ----------------

/**
 * The distinct frames holding a flagged (uncommon or outlier) pose, ascending —
 * the stops of Next / Previous Flagged Pose. Read off `flags`, which a finished
 * run keeps in frame order; cached on the result.
 * @param {Object|null} pc  `session.poseCheck`
 * @returns {number[]}
 */
export function flaggedFrames(pc) {
    if (!pc || !pc.flags) return [];
    if (pc._flaggedFrames && pc._flaggedFramesOf === pc.flags) return pc._flaggedFrames;
    var out = [];
    for (var i = 0; i < pc.flags.length; i++) {
        var f = pc.flags[i].frame;
        if (!out.length || out[out.length - 1] !== f) out.push(f);
    }
    pc._flaggedFrames = out;
    pc._flaggedFramesOf = pc.flags;
    return out;
}

/**
 * The next flagged frame strictly after `frame` (dir > 0), or the previous one
 * strictly before it (dir < 0); -1 when there is none. No wrap-around: the end
 * of the list says so rather than jumping back to its start unannounced.
 * @returns {number} a 0-based frame, or -1
 */
export function nextFlaggedFrame(pc, frame, dir) {
    var frames = flaggedFrames(pc);
    var lo = 0, hi = frames.length;     // first index whose frame > `frame`
    while (lo < hi) { var mid = (lo + hi) >> 1; if (frames[mid] <= frame) lo = mid + 1; else hi = mid; }
    if (dir > 0) return lo < frames.length ? frames[lo] : -1;
    var j = lo - 1;
    if (j >= 0 && frames[j] === frame) j--;
    return j >= 0 ? frames[j] : -1;
}

/**
 * The status line after stepping to a flagged frame (0-based `frame`), naming
 * what the check flagged there:
 * "Flagged frame 3 of 412 (frame 1,235): outlier in Camera1_topC (score 18.2),
 * uncommon in Camera0_topB (score 12.1)". Frames are shown 1-based, as everywhere.
 */
export function describeFlaggedFrame(pc, frame) {
    var frames = flaggedFrames(pc);
    var n = function (v) { return v.toLocaleString('en-US'); };
    var at = (pc && pc.flags ? pc.flags : []).filter(function (f) { return f.frame === frame; });
    var what = at.map(function (f) {
        return (f.cls === POSE_OUTLIER ? 'outlier' : 'uncommon') + ' in ' + f.camera + ' (score ' + f.score.toFixed(1) + ')';
    }).join(', ');
    return 'Flagged frame ' + n(frames.indexOf(frame) + 1) + ' of ' + n(frames.length) +
        ' (frame ' + n(frame + 1) + ')' + (what ? ': ' + what : '');
}

/**
 * The status line when there is nowhere to step: no check yet, nothing
 * flagged, or no flagged frame past `frame` in that direction.
 */
export function describeNoFlaggedFrame(pc, frame, dir) {
    if (!pc) return 'No pose check on this session — run Track All or Tracks ▸ Check Poses first';
    var count = flaggedFrames(pc).length;
    if (!count) return 'No flagged poses: the last pose check flagged nothing';
    return 'No flagged pose ' + (dir > 0 ? 'after' : 'before') + ' frame ' + (frame + 1).toLocaleString('en-US') +
        ' (' + count.toLocaleString('en-US') + ' flagged frame' + (count === 1 ? '' : 's') + ')';
}

