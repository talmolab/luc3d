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
 * Opt-in, before the tracker sees them: DUPLICATE detections — a second
 * instance SLEAP placed on an animal it already detected — can be left out
 * (`duplicateDetections`, Tracking Wizard `scRemoveDuplicates`, off by
 * default). The port itself is untouched.
 *
 * Eager sessions only: a lazy (> 150 MB) single-camera project is refused with
 * a reason rather than tracked from its resident window.
 *
 * DOM-free. Depends on: pose/sleap-tracker.js.
 */

import { runSleapTrackerAsync } from './sleap-tracker.js';

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
 *          fps?: number, look?: object, duplicates?: object}} [opts]  `look` overrides
 *          `CANDIDATE_DEFAULTS`; `duplicates` (DUPLICATE_DEFAULTS overrides, or null/absent
 *          for off) leaves each frame's duplicate detections out of the tracking — they
 *          keep no track, and stay in the session
 * @returns {Promise<{numIdentities: number, frames: number, tracked: number, untracked: number,
 *          duplicates: number, moments: Array}>}  `untracked` excludes the `duplicates`
 */
export async function trackSingleCamera(session, cfg, opts) {
    var cam = singleCameraName(session);
    if (!cam) throw new Error('not a single-camera session');
    if (session.lazyLoader) throw new Error(SINGLE_CAMERA_LAZY_REASON);
    var frameIdx = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });
    var dupOpts = opts && opts.duplicates ? opts.duplicates : null, removed = [];
    var frames = [], insts = [], inputTracks = [];
    for (var i = 0; i < frameIdx.length; i++) {
        var list = instancesOf(session.frameGroups.get(frameIdx[i]), cam);
        if (!list.length) continue;
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
    // Duplicates were not tracked: no track, no identity (they stay in the session, as the over-count ones do).
    removed.forEach(function (inst) { inst.identityId = null; inst.trackIdx = null; });
    // A single-camera session normally has no groups; keep any it has in step with its member's track.
    for (var groups of session.instanceGroups.values()) {
        for (var g = 0; g < groups.length; g++) {
            var m = groups[g].instances.get(cam);
            groups[g].identityId = m && m.trackIdx != null ? m.trackIdx : null;
        }
    }
    var moments = candidateMoments(frames, out, inputTracks, ambiguous, look, (opts && opts.fps) || session.fps || 30);
    return { numIdentities: nTracks, frames: frames.length, tracked: tracked, untracked: untracked,
             duplicates: removed.length, moments: moments };
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
export function candidateMoments(frames, out, inputTracks, ambiguous, look, fps) {
    var cands = [];
    var push = function (f, a, b, cue) {
        if (a == null || b == null || a === b) return;
        cands.push({ f: f, a: Math.min(a, b), b: Math.max(a, b), cue: cue });
    };
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
