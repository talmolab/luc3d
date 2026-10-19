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
 */

import {
    createPoseSample, fitPoseModel, poseScore, poseClassOf, poseSampleStride,
    POSE_UNCOMMON, POSE_OUTLIER, POSE_COMMON,
} from './pose-check.js';

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
    var windowed = loader && loader.isSync && typeof loader.releaseWindow === 'function' &&
        typeof loader.getFrameSync === 'function';
    if (windowed) {
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
    var c = run.counts.get(camName);
    if (!c) { c = emptyCounts(); run.counts.set(camName, c); }
    var model = run.models.get(camName);
    var z = model ? poseScore(model, inst._xy) : NaN;
    var cls = poseClassOf(z, run.uncommonAt, run.outlierAt);
    if (cls === POSE_COMMON) { c.checked++; c.common++; return false; }
    if (cls < 0) { c.untested++; return false; }
    c.checked++;
    if (cls === POSE_UNCOMMON) c.uncommon++; else c.outliers++;
    run.flags.push({ frame: frameIdx, camera: camName, score: z, cls: cls });
    return cls === POSE_OUTLIER && run.exclude;
}

/**
 * What a finished run leaves on the session (`session.poseCheck`): the models
 * (so the views can score what they draw), the thresholds it used, whether it
 * left outliers out of tracking (`excluded`), the counts per camera and in total,
 * and the flagged detections in frame order. Transient: never saved with the project.
 */
export function finishPoseCheckRun(run) {
    var total = emptyCounts(), cameras = [];
    run.models.forEach(function (model, name) {
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
