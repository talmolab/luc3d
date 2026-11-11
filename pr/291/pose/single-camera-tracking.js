/**
 * single-camera-tracking.js — Track All and the ID-switch checks on a session
 * with ONE camera: a plain SLEAP predictions file opened with File ▸ Load SLP.
 *
 * With one view there is nothing to match across cameras and no 3D, so the
 * cross-view tracker does not apply. Track All instead runs SLEAP's own tracker
 * (`pose/sleap-tracker.js`, a verified port of `sleap-nn track`) on the camera's
 * detections, with the animal count as its track cap — sleap-nn's recommended
 * known-count setup (`--candidates_method local_queues --max_tracks N
 * --tracking_target_instance_count N --post_connect_single_breaks`).
 *
 * Unlike multi-camera Track All, the result is written to the TRACKS, the way
 * `sleap-nn track` writes it: on one camera a track IS an animal's identity,
 * and the tracks are what a saved `.slp` hands back to SLEAP. Each track then
 * gets its identity (`track_k` <-> `id_k`, through `frameIdentityMap`, keyed by
 * track, so identity follows the track from then on) and everything that reads
 * identities — Color: ID, the ID-switch checks, the ID Switches tab — works as
 * it does after a multi-camera Track All.
 *
 * The ID-switch checks (`pose/id-switch-check.js`) read InstanceGroups with a
 * 3D skeleton. `singleCameraCheckSession` builds a read-only stand-in from the
 * one camera's 2D: one group per identified detection, `points3d` = (x, y, 0).
 * The checks only ever compare distances relative to the median body size and
 * standardise their features, so the unit change (pixels, not millimetres)
 * costs nothing — but a 2D bone length also changes with posture and viewing
 * angle, so body size is a weaker cue on one camera, and optional there (not
 * run automatically after Track All).
 *
 * Before the tracker sees them, two things can leave detections out, and the
 * port itself is untouched:
 *  - the Tracking Wizard's detection filters (the "Min …" settings, all off by
 *    default), with the multi-camera tracker's own rule
 *    (`passesDetectionFilter`, pose/detection-filter-stats.js) — so the
 *    Wizard's readout counts exactly what is left out here;
 *  - opt-in, DUPLICATE detections — a second instance SLEAP placed on an
 *    animal it already detected (`duplicateDetections`, Tracking Wizard
 *    `scRemoveDuplicates`, off by default), looked for among the detections
 *    the filters kept.
 * Either way the detection stays in the session with no track, and is
 * counted. A frame left with no detection is skipped, as a frame that never
 * had one is.
 *
 * Eager sessions only: a lazy (> 150 MB) single-camera project is refused with
 * a reason rather than tracked from its resident window.
 *
 * DOM-free. Depends on: pose/sleap-tracker.js, pose/detection-filter-stats.js.
 */

import { runSleapTrackerAsync } from './sleap-tracker.js?v=e17cc9b31302';
import { passesDetectionFilter } from './detection-filter-stats.js?v=e17cc9b31302';

/** Why a lazy single-camera project is not tracked (shown in the status bar). */
export const SINGLE_CAMERA_LAZY_REASON = 'single-camera tracking does not support a lazily loaded (> 150 MB) project yet';

/**
 * The camera of a single-camera session, or null. One `Camera` is what File ▸
 * Load SLP makes for a one-video SLEAP file (a placeholder, no calibration).
 * @returns {string|null}
 */
export function singleCameraName(session) {
    if (!session || !Array.isArray(session.cameras) || session.cameras.length !== 1) return null;
    return session.cameras[0].name;
}

/**
 * Settings -> sleap-nn tracker config. `numAnimals` caps the tracks
 * (`max_tracks`) and is the target count for connecting single breaks.
 * @param {number} numAnimals
 * @param {{windowSize?: number, oksStddev?: number, connectBreaks?: boolean}} s
 */
export function singleCameraTrackerConfig(numAnimals, s) {
    s = s || {};
    var n = Math.max(1, Math.round(numAnimals) || 1);
    return {
        candidatesMethod: 'local_queues',
        windowSize: s.windowSize > 0 ? Math.round(s.windowSize) : 5,
        oksStddev: s.oksStddev > 0 ? s.oksStddev : 0.1,
        maxTracks: n,
        targetInstanceCount: n,
        postConnectSingleBreaks: s.connectBreaks !== false,
    };
}

/**
 * Duplicate removal, opt-in (Tracking Wizard `scRemoveDuplicates`, default off).
 * SLEAP sometimes puts a SECOND instance on an animal it already detected —
 * often partial, scoring 0.4–0.9. With the animal count as the track cap that
 * copy takes a track, and a lone animal can hop onto it: on a proofread
 * two-mouse single-camera dataset (6 sessions, 40 fps) the subject, alone
 * before its partner entered, hopped tracks at its own duplicates in 2 of 6
 * sessions, and the partner then entered on its old track (96.95% correct).
 * sleap-nn's pre-cull cannot help: it acts only on a frame with MORE detections
 * than the animal count, and a lone animal plus its copy is not.
 *
 * A detection is a duplicate of a stronger one (higher score) in the same frame
 * when BOTH its box IoU with it is at least `iou` AND their OKS is at least
 * `oks`: box overlap alone would also take two touching animals, keypoints
 * alone two look-alike poses side by side. The OKS reads the WEAKER detection's
 * nodes (a copy is often partial) against the stronger one, scaled by the
 * stronger one's box (sleap-nn's `compute_oks`, cocoeval normalisation, stddev
 * `oksStddev`). Measured 2026-10-12: on that dataset every IoU 0.3–0.7 × OKS
 * 0.5–0.8 removes both hops (99.98%, no swaps; at the defaults 91 detections,
 * none a real animal). On 87 proofread SLAP top/mid views (2–4 mice, 3.78M
 * detections) it is about neutral: 88.52% -> 88.73% correct, swaps 276 -> 257,
 * 8 views better and 8 worse — removing junk re-routes the tracker either way,
 * which is why it is not on by default. It removed 1,231 detections there, 74
 * of them a real second animal.
 */
export const DUPLICATE_DEFAULTS = {
    iou: 0.5,        // box IoU with the stronger detection at least this...
    oks: 0.6,        // ...AND OKS at least this
    oksStddev: 0.1,  // the OKS keypoint spread (the single-camera tracker's default)
    minNodes: 3,     // a detection with fewer present nodes is never called a duplicate
};

/** [xmin, ymin, xmax, ymax] over the present nodes of tracker points (x0, y0, x1, y1, …), or null. */
function pointsBox(p) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var k = 0; k < p.length; k += 2) {
        var x = p[k], y = p[k + 1];
        if (x !== x || y !== y) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

/** Box IoU, +1 px per side as sleap-nn's `compute_iou` counts it. */
export function boxIou(a, b) {
    var ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]) + 1);
    var iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]) + 1), inter = ix * iy;
    return inter / ((a[2] - a[0] + 1) * (a[3] - a[1] + 1) + (b[2] - b[0] + 1) * (b[3] - b[1] + 1) - inter);
}

/**
 * OKS of `weak`'s present nodes against `strong` (a node `strong` lacks scores 0),
 * scaled by the area of `strong`'s box `sbox`; NaN when `weak` has fewer than
 * `minNodes` present nodes.
 */
export function duplicateOks(strong, weak, sbox, stddev, minNodes) {
    var norm = (2 * stddev) * (2 * stddev) * 2 * ((sbox[2] - sbox[0]) * (sbox[3] - sbox[1]) + 2.220446049250313e-16);
    var sum = 0, n = 0;
    for (var k = 0; k < weak.length; k += 2) {
        var wx = weak[k], wy = weak[k + 1];
        if (wx !== wx || wy !== wy) continue;
        n++;
        var sx = strong[k], sy = strong[k + 1];
        if (sx !== sx || sy !== sy) continue;
        var dx = wx - sx, dy = wy - sy;
        sum += Math.exp(-(dx * dx + dy * dy) / norm);
    }
    return n >= (minNodes || 1) ? sum / n : NaN;
}

/**
 * Which of one frame's detections are duplicates (see DUPLICATE_DEFAULTS).
 * Greedy, strongest first (score; a missing score counts lowest; ties keep file
 * order): a detection is dropped when it is a duplicate of one already kept. A
 * user instance is never dropped, and is kept before any prediction.
 * @param {Array<{points: Float64Array, score: number, isUser: boolean}>} dets  tracker detections
 * @param {object} [o]  DUPLICATE_DEFAULTS overrides
 * @returns {number[]} indices into `dets`, ascending
 */
export function duplicateDetections(dets, o) {
    o = Object.assign({}, DUPLICATE_DEFAULTS, o || {});
    if (dets.length < 2) return [];
    var rank = function (d) { return d.isUser ? Infinity : (d.score === d.score ? d.score : -Infinity); };
    var order = dets.map(function (d, i) { return i; }).sort(function (a, b) { return rank(dets[b]) - rank(dets[a]) || a - b; });
    var boxes = dets.map(function (d) { return pointsBox(d.points); });
    var kept = [], drop = [];
    order.forEach(function (i) {
        var d = dets[i], dup = !d.isUser && boxes[i] && kept.some(function (j) {
            return boxes[j] && boxIou(boxes[j], boxes[i]) >= o.iou &&
                duplicateOks(dets[j].points, d.points, boxes[j], o.oksStddev, o.minNodes) >= o.oks;
        });
        if (dup) drop.push(i); else kept.push(i);
    });
    return drop.sort(function (a, b) { return a - b; });
}

/** One camera's instances on a frame, in file order (grouped first, then unlinked); reprojections excluded. */
function instancesOf(fg, cam) {
    var out = [], grouped = fg.instances.get(cam), unlinked = fg.unlinkedInstances.get(cam);
    if (grouped) for (var i = 0; i < grouped.length; i++) out.push(grouped[i]);
    if (unlinked) for (var j = 0; j < unlinked.length; j++) out.push(unlinked[j].instance);
    return out.filter(function (inst) { return inst && inst.type !== 'reprojected'; });
}

/** Points as sleap-nn reads them: NaN for a missing OR occluded node (SLEAP's invisible -> NaN). */
function trackerPoints(inst) {
    var K = inst.numNodes, p = new Float64Array(2 * K);
    for (var k = 0; k < K; k++) {
        if (inst.hasPoint(k) && !inst.isOccluded(k)) { p[2 * k] = inst.getX(k); p[2 * k + 1] = inst.getY(k); }
        else { p[2 * k] = NaN; p[2 * k + 1] = NaN; }
    }
    return p;
}

/**
 * Run SLEAP's tracker over the session's one camera and write the result:
 * `session.tracks` = track_0…, every instance's `trackIdx`, one identity per
 * track (`id_k`, identity id k), and `frameIdentityMap` entries tying them.
 * An instance the tracker dropped (over the animal count, or too few points to
 * start a track) becomes trackless, as does a prediction on a frame that has
 * user instances (sleap-nn tracks only the user instances there).
 *
 * The caller has already cleared the previous identities (as Track All does).
 *
 * Also collects the moments where an identity switch could have happened
 * (`candidateMoments`) — read from the tracking itself, so they cost nothing.
 *
 * @param {Session} session  eager, one camera
 * @param {object} cfg       from `singleCameraTrackerConfig`
 * @param {{onProgress?: function(number, number): (void|Promise), signal?: AbortSignal,
 *          fps?: number, look?: object, duplicates?: object,
 *          filter?: {minVisibleNodes?: number, minInstanceScore?: number, minMeanNodeScore?: number}}} [opts]
 *          `look` overrides `CANDIDATE_DEFAULTS`; `filter` (the Tracking Wizard's detection
 *          filters; absent, or every minimum 0, for off) and then `duplicates`
 *          (DUPLICATE_DEFAULTS overrides, or null/absent for off) leave detections out of
 *          the tracking — they keep no track, and stay in the session
 * @returns {Promise<{numIdentities: number, frames: number, tracked: number, untracked: number,
 *          filtered: number, duplicates: number, moments: Array, review: Array}>}  `frames` counts
 *          the frames with a detection before anything was left out; `untracked` excludes the
 *          `filtered` and the `duplicates`; `moments` = the candidate moments plus returns
 *          (`returnMoments`), what the checks test; `review` = the candidate moments plus
 *          handovers (`handoverCandidates`) and returns while the other animal was out of
 *          sight too (`reviewReturnCandidates`), the review list's rows, plus the lone-animal
 *          arrival row and a check row at the end of the tracking (`videoEndRow`)
 */
export async function trackSingleCamera(session, cfg, opts) {
    var cam = singleCameraName(session);
    if (!cam) throw new Error('not a single-camera session');
    if (session.lazyLoader) throw new Error(SINGLE_CAMERA_LAZY_REASON);
    var frameIdx = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });
    var dupOpts = opts && opts.duplicates ? opts.duplicates : null, removed = [];
    var flt = opts && opts.filter ? opts.filter : {}, filtered = [];
    var minVis = Number(flt.minVisibleNodes) || 0, minScore = Number(flt.minInstanceScore) || 0;
    var minNode = Number(flt.minMeanNodeScore) || 0, filtering = minVis > 0 || minScore > 0 || minNode > 0;
    var frames = [], insts = [], inputTracks = [], seenFrames = 0;
    for (var i = 0; i < frameIdx.length; i++) {
        var list = instancesOf(session.frameGroups.get(frameIdx[i]), cam);
        if (!list.length) continue;
        seenFrames++;
        if (filtering) {
            list = list.filter(function (inst) {
                if (passesDetectionFilter(inst, minVis, minScore, minNode, session, cam, frameIdx[i])) return true;
                filtered.push(inst);
                return false;
            });
            if (!list.length) continue;
        }
        var dets = list.map(function (inst) {
            return { points: trackerPoints(inst), score: typeof inst.score === 'number' ? inst.score : NaN, isUser: inst.type === 'user' };
        });
        if (dupOpts && dets.length > 1) {
            var drop = new Set(duplicateDetections(dets, dupOpts));
            if (drop.size) {
                list.forEach(function (inst, q) { if (drop.has(q)) removed.push(inst); });
                list = list.filter(function (_, q) { return !drop.has(q); });
                dets = dets.filter(function (_, q) { return !drop.has(q); });
            }
        }
        insts.push(list);
        inputTracks.push(list.map(function (inst) { return inst.trackIdx; }));   // the file's own tracklets, before they are rewritten
        frames.push({ frameIdx: frameIdx[i], dets: dets });
    }
    var look = Object.assign({}, CANDIDATE_DEFAULTS, (opts && opts.look) || {});
    var ambiguous = [], posOf = new Map();
    frames.forEach(function (fr, p) { posOf.set(fr.frameIdx, p); });
    var out = await runSleapTrackerAsync(frames, cfg, Object.assign({}, opts, {
        observe: function (m) { collectAmbiguous(m, posOf.get(m.frameIdx), look.ambiguityMargin, ambiguous); },
    }));
    var fps = (opts && opts.fps) || session.fps || 30;
    // While only one animal has been in view it keeps ONE track (loneAnimalPhase, opt-out `opts.lone`): its
    // detections are relabelled in `out` before anything is written, so every count, row and check below reads the
    // result, and the review list gets a row where the second animal arrives.
    var lone = opts && opts.lone ? loneAnimalPhase(frames, out, fps, opts.lone === true ? null : opts.lone) : null;

    var nTracks = 0;
    out.forEach(function (ids) { ids.forEach(function (t) { if (t != null && t + 1 > nTracks) nTracks = t + 1; }); });
    session.tracks = [];
    for (var t = 0; t < nTracks; t++) session.tracks.push('track_' + t);
    for (var k = 0; k < nTracks; k++) session.addIdentity('id_' + k);   // ids 0..n-1 (identities were cleared)
    var tracked = 0, untracked = 0;
    for (var f = 0; f < frames.length; f++) {
        for (var q = 0; q < insts[f].length; q++) {
            var tid = out[f][q];
            var inst = insts[f][q];
            inst.identityId = null;          // a fresh run: no instance keeps an identity of its own
            if (tid == null) { inst.trackIdx = null; untracked++; continue; }
            inst.trackIdx = tid;             // its identity lives in the map, keyed by this track
            session.setFrameIdentity(frames[f].frameIdx, cam, tid, tid);
            tracked++;
        }
    }
    // Filtered detections and duplicates were not tracked: no track, no identity (they stay in the session,
    // as the over-count ones do).
    filtered.concat(removed).forEach(function (inst) { inst.identityId = null; inst.trackIdx = null; });
    // A single-camera session normally has no groups; keep any it has in step with its member's track.
    for (var groups of session.instanceGroups.values()) {
        for (var g = 0; g < groups.length; g++) {
            var m = groups[g].instances.get(cam);
            groups[g].identityId = m && m.trackIdx != null ? m.trackIdx : null;
        }
    }
    // The checks test the candidate moments plus every RETURN (an animal back after more than a second out of
    // sight, returnMoments): the coat-brightness check then compares the labels before it went out of sight with
    // the labels after it came back. The review list adds handovers (where a lone animal's track changes) instead,
    // and only the returns while the other animal was out of sight too (reviewReturnCandidates).
    var moments = candidateMoments(frames, out, inputTracks, ambiguous, look, fps).concat(returnMoments(frames, out, fps))
        .sort(function (x, y) { return x.frame - y.frame || x.identityA - y.identityA || x.identityB - y.identityB; });
    var review = candidateMoments(frames, out, inputTracks, ambiguous, look, fps,
        handoverCandidates(frames, out, fps).concat(reviewReturnCandidates(frames, out, fps)));
    if (lone && lone.arrival) {
        review.push({ frame: lone.arrival.frame, startFrame: lone.arrival.startFrame, identityA: Math.min(lone.arrival.a, lone.arrival.b),
                      identityB: Math.max(lone.arrival.a, lone.arrival.b), cues: ['arrival'] });
        review.sort(function (x, y) { return x.frame - y.frame || x.identityA - y.identityA || x.identityB - y.identityB; });
    }
    // a check row at the end of the tracking, unless a row already ends near it: a swap after the last place shows only there
    var endRow = videoEndRow(frames, out, review, fps);
    if (endRow) review.push(endRow);
    return { numIdentities: nTracks, frames: seenFrames, tracked: tracked, untracked: untracked,
             filtered: filtered.length, duplicates: removed.length, moments: moments, review: review,
             lone: lone && lone.fired ? { until: lone.until, relabelled: lone.relabelled, untracked: lone.untracked } : null };
}

/**
 * Where to look for an identity switch on one camera. Most real switches are NOT
 * at an encounter the checks score — they happen in contacts of three animals, or
 * while one animal's detection is missing for seconds and its track takes another
 * animal — so the checks also test these moments, both read from the tracking:
 *   - 'ambiguity': two tracks whose EXCHANGED assignment would have cost the
 *     tracker less than `ambiguityMargin` more than the one it chose (its own
 *     OKS-similarity cost, so the margin is in OKS units).
 *   - 'tracklet': a tracklet of the INPUT file (SLEAP's own tracking, before
 *     Track All rewrote it) that passes from one identity to another within
 *     `trackletGapFrames`: two independent trackers disagreeing about which
 *     animal this is. Only when the input had tracks.
 * On 35 proofread 10-min SLAP videos the two together put a candidate within
 * 3 s of 44 of the 59 real switches (the contact episodes alone: see MODULES.md).
 */
export const CANDIDATE_DEFAULTS = {
    ambiguityMargin: 0.1,
    trackletGapFrames: 5,
    clusterSeconds: 3,     // per pair, candidates this close are one moment (at the run's last frame)
};

/** Observer for the tracker: keep each pair of matched detections whose exchange is nearly as cheap. */
function collectAmbiguous(m, pos, maxMargin, outList) {
    for (var i = 0; i < m.pairs.length; i++) for (var j = i + 1; j < m.pairs.length; j++) {
        var r1 = m.pairs[i][0], c1 = m.pairs[i][1], r2 = m.pairs[j][0], c2 = m.pairs[j][1];
        var keep = m.cost[r1 * m.nc + c1] + m.cost[r2 * m.nc + c2];
        var swap = m.cost[r1 * m.nc + c2] + m.cost[r2 * m.nc + c1];
        if (isFinite(keep) && isFinite(swap) && swap - keep < maxMargin) {
            outList.push({ pos: pos, d1: m.dets[r1], d2: m.dets[r2] });
        }
    }
}

/**
 * The candidate moments, in FINAL identity ids (track k = identity k): one per
 * pair per run of candidates no more than `clusterSeconds` apart, placed at the
 * run's last frame (`frame`; `startFrame` = its first). Ambiguity is observed
 * before connect-single-breaks renumbers tracks, so ids are read through the
 * final output, never from the observer.
 */
export function candidateMoments(frames, out, inputTracks, ambiguous, look, fps, extra) {
    var cands = [];
    var push = function (f, a, b, cue) {
        if (a == null || b == null || a === b) return;
        cands.push({ f: f, a: Math.min(a, b), b: Math.max(a, b), cue: cue });
    };
    (extra || []).forEach(function (c) { push(c.f, c.a, c.b, c.cue); });
    ambiguous.forEach(function (x) { push(frames[x.pos].frameIdx, out[x.pos][x.d1], out[x.pos][x.d2], 'ambiguity'); });
    var last = new Map();
    for (var p = 0; p < frames.length; p++) {
        var f = frames[p].frameIdx;
        for (var q = 0; q < out[p].length; q++) {
            var t = inputTracks[p][q], id = out[p][q];
            if (t == null || t < 0 || id == null) continue;
            var prev = last.get(t);
            if (prev && prev.id !== id && f - prev.f <= look.trackletGapFrames) push(f, prev.id, id, 'tracklet');
            last.set(t, { id: id, f: f });
        }
    }
    var byPair = new Map(), moments = [], gap = look.clusterSeconds * fps;
    cands.forEach(function (c) {
        var k = c.a + ':' + c.b;
        if (!byPair.has(k)) byPair.set(k, []);
        byPair.get(k).push(c);
    });
    byPair.forEach(function (L) {
        L.sort(function (x, y) { return x.f - y.f; });
        var run = [L[0]];
        for (var i = 1; i <= L.length; i++) {
            if (i < L.length && L[i].f - run[run.length - 1].f <= gap) { run.push(L[i]); continue; }
            var cues = Array.from(new Set(run.map(function (c) { return c.cue; }))).sort();
            moments.push({ frame: run[run.length - 1].f, startFrame: run[0].f, identityA: run[0].a, identityB: run[0].b, cues: cues });
            if (i < L.length) run = [L[i]];
        }
    });
    return moments.sort(function (x, y) { return x.frame - y.frame || x.identityA - y.identityA || x.identityB - y.identityB; });
}

/** The handover look: a lone detection whose nearest detection in the last `lookSeconds` lay within
 *  `nearBody` body lengths and wore another track. "Lone" = no other detection within one body length.
 *  1 s, not 0.5: a mouse often drops out of detection for over half a second and comes back on the other
 *  track (sham_gdx R289: 0.6 s); on proofread data 1 s put 225 of 232 SLAP held-out switches on the list
 *  (0.5 s: 222) at 1.06 places a minute (0.97), and the review fixed 95 of 108 erroneous sham_gdx videos to
 *  >= 99.9% (92); 2 s added places without catching more. */
export const HANDOVER_DEFAULTS = { lookSeconds: 1, nearBody: 0.5 };

/** Mean of the present nodes of tracker points, or null. */
function pointsCentroid(p) {
    var x = 0, y = 0, n = 0;
    for (var k = 0; k < p.length; k += 2) { if (p[k] !== p[k] || p[k + 1] !== p[k + 1]) continue; x += p[k]; y += p[k + 1]; n++; }
    return n ? [x / n, y / n] : null;
}

/**
 * Where a track changes while its animal is ALONE: the place an animal is, one
 * moment ago with one track and now with another, and nobody else near it. That
 * is how most single-camera switches look that no contact sees — a lone animal
 * hopping onto the track of a stray detection, or onto a track another animal
 * left. Read from the detections and the tracker's output only, in final ids,
 * as candidates `{f, a, b, cue: 'handover'}` for `candidateMoments`' `extra`.
 * The body length is the median detection extent (sampled), so the look is
 * resolution-free.
 */
export function handoverCandidates(frames, out, fps, opts) {
    var o = Object.assign({}, HANDOVER_DEFAULTS, opts || {});
    var body = bodyLengthOf(frames), out2 = [];
    if (!(body > 0)) return out2;
    var look = Math.max(1, Math.round(o.lookSeconds * (fps || 30))), near = o.nearBody * body, recent = [];
    for (var p = 0; p < frames.length; p++) {
        var f = frames[p].frameIdx, ids = out[p], cs = frames[p].dets.map(function (d) { return pointsCentroid(d.points); });
        while (recent.length && recent[0].f < f - look) recent.shift();
        for (var q = 0; q < cs.length; q++) {
            var c = cs[q], t = ids[q];
            if (!c || t == null) continue;
            var alone = true;
            for (var r = 0; r < cs.length && alone; r++) if (r !== q && cs[r] && Math.hypot(cs[r][0] - c[0], cs[r][1] - c[1]) <= body) alone = false;
            if (!alone) continue;
            var best = null, bd = near;
            for (var j = recent.length - 1; j >= 0; j--) {
                var e = recent[j], dd = Math.hypot(e.c[0] - c[0], e.c[1] - c[1]);
                if (dd < bd) { best = e; bd = dd; }
            }
            if (best && best.t !== t) out2.push({ f: f, a: t, b: best.t, cue: 'handover' });
        }
        for (var q2 = 0; q2 < cs.length; q2++) if (cs[q2] && ids[q2] != null) recent.push({ f: f, c: cs[q2], t: ids[q2] });
    }
    return out2;
}

/** The median detection extent (the larger side of its box over present nodes), from up to ~5,000 detections
 *  sampled evenly; 0 when there is none. Resolution-free unit for the looks below. */
function bodyLengthOf(frames) {
    var ext = [], total = 0;
    frames.forEach(function (fr) { total += fr.dets.length; });
    var every = Math.max(1, Math.floor(total / 5000)), i = 0;
    frames.forEach(function (fr) { fr.dets.forEach(function (d) {
        if (i++ % every) return;
        var b = pointsBox(d.points); if (b) ext.push(Math.max(b[2] - b[0], b[3] - b[1]));
    }); });
    ext.sort(function (x, y) { return x - y; });
    return ext.length ? ext[ext.length >> 1] : 0;
}

/**
 * The lone-animal rule (Tracking Wizard `scLoneAnimal`, on by default). Until two
 * animals are in view TOGETHER there is one animal, so it keeps one track: on
 * two-mouse recordings where the subject starts alone and the partner is put in
 * later, the lone animal otherwise moves between tracks — a hand carries it, it
 * comes back at the edge after a gap, a stray detection on its holder takes its
 * track — and nothing puts a review row there (the rows look at moments between
 * two animals). The reviewer then meets it later on whichever track it holds, so
 * the stretch before the hop keeps the other one.
 *
 * "Together": a frame with two tracked detections both at least `score` x the
 * median detection score (a missing score, a user instance, passes) and centroids
 * more than `apart` body lengths apart (`bodyLengthOf`) — low enough that huddled
 * animals count, while a duplicate of one animal (near-identical keypoints) does
 * not. The shared phase starts at the first such frame from which they fill at
 * least `fill` of the next `holdSeconds`. The lone phase ends EARLIER, where that
 * arrival's cluster starts: the first two-animal frame in the `clusterSeconds`
 * before it. From there on the tracker's own tracks stand, through the arrival
 * (while the second animal is being put in, the lone one is often undetected for a
 * frame, and following it by position alone then jumps to the newcomer). Before
 * then, the lone animal is followed by position (the best-scoring detection first,
 * then the detection nearest its last place) and keeps the track its last pick
 * before the cluster wore; every other detection before then loses its track. A
 * lone phase shorter than `holdSeconds` after the first detection changes nothing.
 *
 * Measured 2026-11-07 on proofread data (Track All, then the review list played by
 * the simulated reviewer; MODULES.md): Mae's intact two-mouse set (725 videos, held
 * out) 99.877% -> 99.9245%, videos >= 99.9% 600 -> 614, review rows 6,113 -> 4,416;
 * sham_gdx (207) 99.975% -> 99.981%; SLAP (83 views) and SLAP-2M (163), where
 * every animal is in view from the start, unchanged to within 1 detection on 2
 * views. Ending the lone phase at the arrival itself instead (the first version)
 * gave intact 99.905%: the follower jumped to the newcomer in 10 videos (2,478
 * detections, one video 100% -> 88.9%). Without the arrival row the simulated
 * reviewer met the mice later, sometimes already swapped (intact 99.31%); at 0.5
 * body lengths huddled SLAP mice read as one animal. Left: one-frame blips where
 * the follower takes the copy of a resting animal the proofreader deleted (138
 * intact videos, a median of 2 detections each) — nothing in the detections tells
 * the copies apart.
 *
 * Rewrites `out` in place (DOM-free; reads only the detections and the tracker's
 * output).
 * @returns {{fired: boolean, until: ?number, relabelled: number, untracked: number,
 *            arrival: ?{frame: number, startFrame: number, a: number, b: number}}}  `until` = the first
 *            frame the tracker's tracks stand again (the arrival cluster's start; null: never);
 *            `arrival` = the review row from there to the arrival, between the kept track and the
 *            other animal's (null without a second tracked animal)
 */
export const LONE_DEFAULTS = { apart: 0.15, score: 0.4, fill: 0.5, holdSeconds: 1, clusterSeconds: 5 };

export function loneAnimalPhase(frames, out, fps, opts) {
    var o = Object.assign({}, LONE_DEFAULTS, opts || {});
    var none = { fired: false, until: null, relabelled: 0, untracked: 0, arrival: null };
    if (!frames.length) return none;
    var body = bodyLengthOf(frames), H = Math.max(1, Math.round(o.holdSeconds * (fps || 30)));
    var scores = [];
    frames.forEach(function (fr) { fr.dets.forEach(function (d) { if (d.score === d.score) scores.push(d.score); }); });
    scores.sort(function (x, y) { return x - y; });
    var minScore = scores.length ? o.score * scores[scores.length >> 1] : -Infinity;
    var cents = frames.map(function (fr) { return fr.dets.map(function (d) { return pointsCentroid(d.points); }); });
    var tracked = function (p) { var r = []; for (var q = 0; q < out[p].length; q++) if (out[p][q] != null) r.push(q); return r; };
    // the frames (positions) with two animals together
    var twoAt = [];
    for (var p = 0; p < frames.length; p++) {
        var ks = tracked(p).filter(function (q) { var s = frames[p].dets[q].score; return !(s === s) || s >= minScore; }), two = null;
        for (var i = 0; i < ks.length && !two; i++) for (var j = i + 1; j < ks.length && !two; j++) {
            var a = cents[p][ks[i]], b = cents[p][ks[j]];
            if (a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) > o.apart * body) two = [ks[i], ks[j]];
        }
        if (two) twoAt.push({ p: p, f: frames[p].frameIdx, pair: two });
    }
    // the shared phase: the first two-animal frame from which two-animal frames fill `fill` of the next H frames
    var start = null;
    for (var s = 0, e = 0; s < twoAt.length && !start; s++) {
        if (e < s) e = s;
        while (e + 1 < twoAt.length && twoAt[e + 1].f < twoAt[s].f + H) e++;
        if (e - s + 1 >= o.fill * H) start = twoAt[s];
    }
    var until = start ? start.f : Infinity, firstP = -1;
    for (var p1 = 0; p1 < frames.length && firstP < 0; p1++) if (tracked(p1).length) firstP = p1;
    if (firstP < 0 || until - frames[firstP].frameIdx < H) return Object.assign(none, { until: start ? start.f : null });
    var bestOf = function (p, ks) { return ks.reduce(function (x, y) {
        var sx = frames[p].dets[x].score, sy = frames[p].dets[y].score;
        return (sx === sx ? sx : -Infinity) >= (sy === sy ? sy : -Infinity) ? x : y; }); };
    var nearest = function (p, ks, at) { var b = ks[0], d = Infinity;
        ks.forEach(function (q) { var c = cents[p][q], dd = c ? Math.hypot(c[0] - at[0], c[1] - at[1]) : Infinity; if (dd < d) { d = dd; b = q; } });
        return b; };
    // where the lone phase ends: the arrival cluster's first two-animal frame (the arrival itself when none is
    // within clusterSeconds before it; with no arrival, the last clusterSeconds before the last detection)
    var arriveAt = start ? start.f : frames[frames.length - 1].frameIdx + 1, end = arriveAt;
    var from = Math.max(frames[firstP].frameIdx, arriveAt - Math.round(o.clusterSeconds * (fps || 30)));
    for (var t0 = 0; t0 < twoAt.length; t0++) if (twoAt[t0].f >= from && twoAt[t0].f < arriveAt) { end = twoAt[t0].f; break; }
    // the lone animal, followed by position: which detection it is on each lone frame
    var chain = [], at = null, keep = null, counts = new Map();
    for (var p2 = firstP; p2 < frames.length && frames[p2].frameIdx < until; p2++) {
        var ks2 = tracked(p2); if (!ks2.length) continue;
        var q2 = at ? nearest(p2, ks2, at) : bestOf(p2, ks2);
        chain.push({ p: p2, q: q2, ks: ks2 });
        at = cents[p2][q2] || at;
        if (frames[p2].frameIdx >= until - H) { var tb = out[p2][bestOf(p2, ks2)]; counts.set(tb, (counts.get(tb) || 0) + 1); }
    }
    if (counts.size) keep = Array.from(counts).sort(function (x, y) { return y[1] - x[1]; })[0][0];
    // its track: the one the tracker gave the detection that continues it where the shared phase starts
    for (var p3 = 0; p3 < frames.length && at; p3++) {
        if (frames[p3].frameIdx < until) continue;
        if (frames[p3].frameIdx >= until + H) break;
        var ks3 = tracked(p3); if (!ks3.length) continue;
        keep = out[p3][nearest(p3, ks3, at)];
        break;
    }
    // the track its last pick before the cluster wore (the follower can jump to the newcomer inside the cluster)
    for (var c1 = chain.length - 1; c1 >= 0; c1--) if (frames[chain[c1].p].frameIdx < end) { keep = out[chain[c1].p][chain[c1].q]; break; }
    if (keep == null) for (var c0 = chain.length - 1; c0 >= 0 && keep == null; c0--) keep = out[chain[c0].p][chain[c0].q];
    var relabelled = 0, lost = 0;
    chain.forEach(function (c) { if (frames[c.p].frameIdx >= end) return; c.ks.forEach(function (q) {
        var want = q === c.q ? keep : null;
        if (out[c.p][q] !== want) { relabelled++; if (want == null) lost++; out[c.p][q] = want; }
    }); });
    var arrival = null;
    if (start) {
        var other = start.pair.map(function (q) { return out[start.p][q]; }).filter(function (t) { return t != null && t !== keep; })[0];
        if (other != null) arrival = { frame: start.f, startFrame: end, a: keep, b: other };
    }
    return { fired: true, until: isFinite(end) && (start || end < arriveAt) ? end : null, relabelled: relabelled, untracked: lost, arrival: arrival };
}

/** A return: a track's first detection after more than `gapSeconds` with none. */
export const RETURN_DEFAULTS = { gapSeconds: 1 };

/**
 * Where an animal comes back after being out of sight — handled, hidden in a
 * shelter, outside a partial view — for the coat-brightness check to test: it is
 * the commonest way a single-camera switch happens with no contact to see, and
 * the review list's handovers only look back `HANDOVER_DEFAULTS.lookSeconds`. A
 * moment per return of track a and each other track b, its `startFrame` the
 * frame a was last seen, so the check reads the labels before the animal went
 * out of sight against the labels after it came back (`testMoments`). Read from
 * the tracker's output only. Not on the review list as such: one place per return
 * would double it (measured, MODULES.md); the list takes only the returns
 * `reviewReturnCandidates` picks.
 * @returns {Array<{frame, startFrame, identityA, identityB, cues: string[]}>}
 */
export function returnMoments(frames, out, fps, opts) {
    var o = Object.assign({}, RETURN_DEFAULTS, opts || {});
    var gap = o.gapSeconds * (fps || 30), last = new Map(), moments = [];
    for (var p = 0; p < frames.length; p++) {
        var f = frames[p].frameIdx, ids = out[p] || [];
        for (var q = 0; q < ids.length; q++) {
            var t = ids[q];
            if (t == null || t < 0) continue;
            if (last.has(t) && f - last.get(t) > gap) {
                last.forEach(function (lf, u) {
                    if (u === t) return;
                    moments.push({ frame: f, startFrame: last.get(t), identityA: Math.min(t, u), identityB: Math.max(t, u), cues: ['return'] });
                });
            }
        }
        for (var q2 = 0; q2 < ids.length; q2++) if (ids[q2] != null && ids[q2] >= 0) last.set(ids[q2], f);
    }
    return moments;
}

/** The returns the review list takes: back after more than `gapSeconds` unseen, while the other track was ALSO
 *  unseen for at least `otherAwaySeconds` of that time. */
export const REVIEW_RETURN_DEFAULTS = { gapSeconds: 1, otherAwaySeconds: 0.5 };

/**
 * The returns that go on the review list: a track back after more than
 * `gapSeconds` unseen, paired with each other track that was ALSO out of sight
 * for at least `otherAwaySeconds` of that absence. With the other animal tracked
 * the whole time, the one coming back can only take the track that is left; with
 * both out of sight (both hidden in the bedding, both lifted out), the first one
 * back can take either. As candidates `{f, a, b, cue: 'return'}` (final ids) for
 * `candidateMoments`' `extra`, which clusters them with the other places.
 * Measured 2026-11-07 on proofread data (MODULES.md), with a reviewer who watches
 * only 2 s before to 5 s after each row: +0.00–0.05 rows a minute; held-out intact
 * 99.825 -> 99.840% (one video 92.9 -> 100%), sham_gdx 99.939 -> 99.942%, SLAP
 * 99.423 -> 99.620%, SLAP-2M unchanged; no video worse. Every return as a row
 * gained more but added 0.2–1.4 rows a minute and cost one SLAP-2M view 25 points.
 * @returns {Array<{f: number, a: number, b: number, cue: 'return'}>}
 */
export function reviewReturnCandidates(frames, out, fps, opts) {
    var o = Object.assign({}, REVIEW_RETURN_DEFAULTS, opts || {});
    var rate = fps || 30, gap = o.gapSeconds * rate, away = o.otherAwaySeconds * rate, seen = new Map(), cands = [];
    for (var p = 0; p < frames.length; p++) {
        var f = frames[p].frameIdx, ids = out[p] || [];
        for (var q = 0; q < ids.length; q++) {
            var t = ids[q];
            if (t == null || t < 0) continue;
            var L = seen.get(t);
            if (!L) seen.set(t, L = []);
            if (L[L.length - 1] !== f) L.push(f);
        }
    }
    // frames of L in [a, b]
    var countIn = function (L, a, b) {
        var lo = function (x) { var l = 0, h = L.length; while (l < h) { var m = (l + h) >> 1; if (L[m] < x) l = m + 1; else h = m; } return l; };
        return Math.max(0, lo(b + 1) - lo(a));
    };
    seen.forEach(function (L, t) {
        for (var i = 1; i < L.length; i++) {
            var a = L[i - 1], f = L[i];
            if (f - a <= gap) continue;
            seen.forEach(function (Lu, u) {
                if (u === t || Lu[0] >= f) return;                         // not seen before the return: nothing to swap with
                if ((f - a - 1) - countIn(Lu, a + 1, f - 1) < away) return; // tracked throughout: the return takes what is left
                cands.push({ f: f, a: Math.min(t, u), b: Math.max(t, u), cue: 'return' });
            });
        }
    });
    return cands;
}

/** The check row at the end of the tracking: none when a row already ends within `clearSeconds` of it. */
export const VIDEO_END_DEFAULTS = { clearSeconds: 5, pairSeconds: 2 };

/**
 * A review row at the last tracked frame — "check who is who at the end" —
 * unless a row already ends within `clearSeconds` of it. A swap after the last
 * place on the list shows nowhere else: the reviewer sees the labels swapped
 * there and steps back through the pair's earlier close encounters
 * (`pairEncounters`) to where it began. Its pair is the two tracks seen most in
 * the last `pairSeconds` (else the two seen last); with more tracks the Fix
 * dialog picks the pair. Null with fewer than two tracks.
 * Measured 2026-11-09 on proofread data (MODULES.md), with a reviewer who watches
 * only 2 s before to 5 s after each row and steps back through encounters:
 * +0.08–0.16 rows a minute; held-out intact 99.840 -> 99.927%, sham_gdx 99.942 ->
 * 99.980%, SLAP 99.620 -> 99.923%, SLAP-2M 98.885 -> 99.550% (the row alone,
 * without stepping back, changes almost nothing).
 * @returns {?{frame, startFrame, identityA, identityB, cues: ['videoEnd']}}
 */
export function videoEndRow(frames, out, review, fps, opts) {
    var o = Object.assign({}, VIDEO_END_DEFAULTS, opts || {});
    if (!frames.length) return null;
    var rate = fps || 30, last = frames[frames.length - 1].frameIdx;
    if ((review || []).some(function (m) { return m.frame >= last - o.clearSeconds * rate; })) return null;
    var count = new Map(), lastSeen = new Map();
    for (var p = 0; p < frames.length; p++) {
        var f = frames[p].frameIdx, ids = out[p] || [];
        for (var q = 0; q < ids.length; q++) {
            var t = ids[q];
            if (t == null || t < 0) continue;
            lastSeen.set(t, f);
            if (f >= last - o.pairSeconds * rate) count.set(t, (count.get(t) || 0) + 1);
        }
    }
    if (lastSeen.size < 2) return null;
    var pick = Array.from(lastSeen.keys()).sort(function (a, b) {
        return (count.get(b) || 0) - (count.get(a) || 0) || lastSeen.get(b) - lastSeen.get(a) || a - b;
    });
    return { frame: last, startFrame: last, identityA: Math.min(pick[0], pick[1]), identityB: Math.max(pick[0], pick[1]), cues: ['videoEnd'] };
}

/** What counts as a close encounter when stepping back: centroids under `closeBody` body lengths apart, runs
 *  joined across gaps of up to `gapSeconds`. */
export const PAIR_ENCOUNTER_DEFAULTS = { closeBody: 1.5, gapSeconds: 0.25 };

var _bodyCache = new WeakMap();
/** A single-camera session's body length (median detection extent over ~5,000 sampled detections), cached per
 *  frame count. */
function sessionBodyLength(session, cam) {
    var c = _bodyCache.get(session);
    if (c && c.n === session.frameGroups.size) return c.body;
    var frameIdx = Array.from(session.frameGroups.keys()), every = Math.max(1, Math.floor(frameIdx.length / 5000)), frames = [];
    for (var i = 0; i < frameIdx.length; i += every) {
        frames.push({ dets: instancesOf(session.frameGroups.get(frameIdx[i]), cam).map(function (inst) { return { points: trackerPoints(inst) }; }) });
    }
    var body = bodyLengthOf(frames);
    _bodyCache.set(session, { n: session.frameGroups.size, body: body });
    return body;
}

/**
 * The close encounters of identities `idA` and `idB` on frames [from, to] of a
 * single-camera session: runs of frames where a detection of each has its
 * centroid within `closeBody` body lengths of the other's, joined across gaps of
 * up to `gapSeconds`. Read from the current labels (so after a Fix too), label
 * by identity. What the ID Switches tab's "Earlier encounter" steps back through,
 * latest first, when the labels are already swapped as a place starts: on
 * proofread data a reviewer stepping back this way recovered nearly all of what
 * a reviewer shown the exact frame recovers (MODULES.md, 2026-11-09).
 * @param {{fps?: number, closeBody?: number, gapSeconds?: number}} [opts]
 * @returns {Array<{start: number, end: number}>}  ascending; [] when not single-camera
 */
export function pairEncounters(session, idA, idB, from, to, opts) {
    var cam = singleCameraName(session);
    if (!cam || session.lazyLoader || idA == null || idB == null) return [];
    var o = Object.assign({}, PAIR_ENCOUNTER_DEFAULTS, opts || {});
    var body = sessionBodyLength(session, cam);
    if (!(body > 0)) return [];
    var lim = o.closeBody * body, gap = Math.round(o.gapSeconds * (o.fps || session.fps || 30)), runs = [];
    var frameIdx = Array.from(session.frameGroups.keys()).filter(function (f) { return f >= from && f <= to; }).sort(function (a, b) { return a - b; });
    for (var i = 0; i < frameIdx.length; i++) {
        var f = frameIdx[i], list = instancesOf(session.frameGroups.get(f), cam), A = [], B = [];
        for (var q = 0; q < list.length; q++) {
            var id = session.getIdentityIdForUnlinkedInstance(cam, list[q], f);
            if (id !== idA && id !== idB) continue;
            var c = pointsCentroid(trackerPoints(list[q]));
            if (c) (id === idA ? A : B).push(c);
        }
        var near = A.some(function (a) { return B.some(function (b) { return Math.hypot(a[0] - b[0], a[1] - b[1]) < lim; }); });
        if (!near) continue;
        var run = runs[runs.length - 1];
        if (run && f - run.end <= gap + 1) run.end = f;
        else runs.push({ start: f, end: f });
    }
    return runs;
}

/**
 * The review list single-camera Track All leaves in the ID Switches tab: every
 * candidate moment (near-ties, input-tracklet changes) plus every handover and
 * every return while the other animal was out of sight too, one row per pair per
 * run of them no more than `clusterSeconds` apart. Rows are
 * change points with no score (0) and no far edge — a Fix swaps from the frame the
 * reviewer stopped on to the end of the video, and later rows fix their own
 * stretches in turn. Measured on 87 proofread SLAP views and 207 sham_gdx
 * conditions (MODULES.md): about one row a minute, within 2 s of 86–96% of the
 * real switches, under 10% of the video inside a row's window.
 * @returns {{ok: true, cue: 'review', flags: Array, changes: [], encounters: [], fps: number}}
 */
export function reviewResult(moments, session, fps) {
    var name = function (id) { var i = session.getIdentity ? session.getIdentity(id) : null; return i ? i.name : 'id_' + id; };
    var flags = moments.map(function (m) {
        return { frame: m.frame, startFrame: m.startFrame, identityA: m.identityA, identityB: m.identityB,
                 nameA: name(m.identityA), nameB: name(m.identityB), kind: 'onset', score: 0, look: m.cues.slice(),
                 switchBackAt: null, cue: 'review' };
    });
    return { ok: true, cue: 'review', flags: flags, changes: [], encounters: [], fps: fps || 30, sampleHz: 0, step: 1 };
}

/**
 * The options the coat-brightness check runs with on a single-camera session,
 * on top of its own (`ui/id-switch-modal.js` merges them in). They act on runs
 * of flagged encounters and their follow-ons (pose/id-switch-check.js
 * `markChangePoints` / `linkFollowOns`), which the image and size checks no
 * longer have: since #309 / #310 they score each contact label-free and take
 * none of them.
 *  - `skipEmpty`: runs ignore encounters scoring exactly 0. Those had no samples
 *    on either side (one camera's animals are seldom alone for long), so they say
 *    nothing about the labels — yet counting them as "reads right" started a
 *    swapped stretch at the first encounter WITH evidence: a Fix from 0:04.2 for
 *    a swap running from 0:00. Measured on the 35 proofread SLAP videos with the
 *    image check's previous scoring (44.5% of its encounters scored 0): rows
 *    78 -> 68, false 51 -> 42, the same 18 of 59 swaps caught; brightness rows
 *    21 -> 18 (false 7 -> 4), 14 caught either way.
 *  - `clearestEndLeads`: among encounter 'end' rows within 5 s of each other that
 *    share an animal, the one reading right again most clearly leads its
 *    follow-ons. After an early swap the swapped animals' other pairs end a
 *    second or two BEFORE the swapped pair (+69 leading the real +444 on one
 *    SLAP video).
 * Multi-camera checks run without either (not measured there).
 * @param {'brightness'} cue
 * @returns {{skipEmpty: boolean, clearestEndLeads: boolean}}
 */
export function singleCameraCheckOptions(cue) {
    return { skipEmpty: true, clearestEndLeads: true };
}

/**
 * A read-only stand-in session the ID-switch checks (and the image embedder)
 * can read for a single-camera session: one InstanceGroup-shaped object per
 * identified detection, with its 2D as `points3d` (x, y, 0) and the detection
 * itself under `instances` (what the image check crops). Returns null when the
 * session is not single-camera (use the session itself), or {fail: reason}.
 * It carries the session's `imageModel`, so the image check embeds with the
 * package the session chose, not the built-in model.
 *
 * `opts.pixelCamera`: its one camera is a PIXEL camera — `project` maps a stand-in
 * point (x, y, 0) back to (x, y), no size — for readers that project 3D into a
 * view, i.e. the Track All summary's identity gallery (ui/identity-gallery.js:
 * sample crops and path maps). The session's own stand-in camera (File ▸ Load
 * SLP's identity camera) cannot: it would divide by z = 0.
 */
export function singleCameraCheckSession(session, opts) {
    var cam = singleCameraName(session);
    if (!cam) return null;
    if (session.lazyLoader) return { fail: SINGLE_CAMERA_LAZY_REASON };
    var groups = new Map(), rows = [];
    var frameIdx = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });
    for (var i = 0; i < frameIdx.length; i++) {
        var f = frameIdx[i], list = instancesOf(session.frameGroups.get(f), cam);
        for (var q = 0; q < list.length; q++) {
            var id = session.getIdentityIdForUnlinkedInstance(cam, list[q], f);
            if (id != null && id >= 0) rows.push({ f: f, inst: list[q], id: id });
        }
    }
    var K = rows.length ? rows[0].inst.numNodes : 0;
    var slab = new Float64Array(rows.length * 3 * K);       // one allocation for every stand-in skeleton
    for (var r = 0; r < rows.length; r++) {
        var inst = rows[r].inst, p = slab.subarray(r * 3 * K, (r + 1) * 3 * K);
        for (var k = 0; k < K; k++) {
            var ok = k < inst.numNodes && inst.hasPoint(k) && !inst.isOccluded(k);
            p[3 * k] = ok ? inst.getX(k) : NaN;
            p[3 * k + 1] = ok ? inst.getY(k) : NaN;
            p[3 * k + 2] = ok ? 0 : NaN;
        }
        var L = groups.get(rows[r].f);
        if (!L) groups.set(rows[r].f, L = []);
        L.push({ identityId: rows[r].id, points3d: p, instances: new Map([[cam, inst]]) });
    }
    var cameras = opts && opts.pixelCamera
        ? [{ name: cam, size: null, project: function (p) { return [p[0], p[1]]; } }]
        : session.cameras;
    return {
        skeleton: session.skeleton, identities: session.identities, instanceGroups: groups,
        cameras: cameras, fps: session.fps, singleCamera: cam,
        // the session's image model (Session.imageModel): without it the image check runs the built-in model
        imageModel: session.imageModel || null,
    };
}

/**
 * Swap two identities on frames [from, to] of a single-camera session, by
 * swapping their TRACKS, so the fix is in what a saved `.slp` carries and not
 * only in the identity layer. Identity follows (the map is keyed by track).
 *
 * Done only when each identity is one track throughout the range — true after
 * a single-camera Track All. Otherwise (identities hand-edited apart from their
 * tracks) it swaps the identity layer alone, like a multi-camera fix, and says
 * so. Returns {frames, tracks: boolean}; null when the session is not single-camera.
 */
export function swapSingleCameraIdentities(session, from, to, idA, idB) {
    var cam = singleCameraName(session);
    if (!cam || session.lazyLoader) return null;
    var trackOf = new Map(), consistent = true, touched = [];
    for (var [f, fg] of session.frameGroups) {
        if (f < from || f > to) continue;
        var list = instancesOf(fg, cam), hit = false;
        for (var q = 0; q < list.length; q++) {
            var inst = list[q], id = session.getIdentityIdForUnlinkedInstance(cam, inst, f);
            if (id !== idA && id !== idB) continue;
            if (inst.trackIdx == null) { consistent = false; continue; }
            if (!trackOf.has(id)) trackOf.set(id, inst.trackIdx);
            else if (trackOf.get(id) !== inst.trackIdx) consistent = false;
            hit = true;
        }
        if (hit) touched.push(f);
    }
    var tA = trackOf.get(idA), tB = trackOf.get(idB);
    // Both tracks must also map to the OTHER identity on the far side of the swap, or swapping tracks
    // would not swap identities: check the map says tA -> idA and tB -> idB on every touched frame.
    if (consistent && tA != null && tB != null && tA !== tB) {
        for (var i = 0; i < touched.length && consistent; i++) {
            var vA = session.getIdentityIdForTrack(cam, tA, touched[i]), vB = session.getIdentityIdForTrack(cam, tB, touched[i]);
            if ((vA != null && vA !== idA) || (vB != null && vB !== idB)) consistent = false;
        }
    } else consistent = false;
    if (!consistent) {
        var r = session.swapIdentitiesInRange(from, to, idA, idB);
        return { frames: r.entries ? touched.length : 0, tracks: false };
    }
    var frames = 0;
    for (var [f2, fg2] of session.frameGroups) {
        if (f2 < from || f2 > to) continue;
        var changed = false, L = instancesOf(fg2, cam);
        for (var j = 0; j < L.length; j++) {
            if (L[j].trackIdx === tA) { L[j].trackIdx = tB; changed = true; }
            else if (L[j].trackIdx === tB) { L[j].trackIdx = tA; changed = true; }
        }
        if (changed) {
            frames++;
            // Make sure both keys exist on this frame (an animal absent here keeps whatever it had).
            if (session.getIdentityIdForTrack(cam, tA, f2) == null) session.setFrameIdentity(f2, cam, tA, idA);
            if (session.getIdentityIdForTrack(cam, tB, f2) == null) session.setFrameIdentity(f2, cam, tB, idB);
        }
    }
    return { frames: frames, tracks: true };
}
