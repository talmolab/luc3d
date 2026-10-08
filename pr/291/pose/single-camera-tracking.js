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
 * fit a classifier to standardised features, so the unit change (pixels, not
 * millimetres) costs nothing — but a 2D bone length also changes with posture
 * and viewing angle, which is why body size is a weak cue on one camera.
 *
 * Eager sessions only: a lazy (> 150 MB) single-camera project is refused with
 * a reason rather than tracked from its resident window.
 *
 * DOM-free. Depends on: pose/sleap-tracker.js.
 */

import { runSleapTrackerAsync } from './sleap-tracker.js?v=3b23de5d012e';

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
 *          fps?: number, look?: object}} [opts]  `look` overrides `CANDIDATE_DEFAULTS`
 * @returns {Promise<{numIdentities: number, frames: number, tracked: number, untracked: number,
 *          moments: Array}>}
 */
export async function trackSingleCamera(session, cfg, opts) {
    var cam = singleCameraName(session);
    if (!cam) throw new Error('not a single-camera session');
    if (session.lazyLoader) throw new Error(SINGLE_CAMERA_LAZY_REASON);
    var frameIdx = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });
    var frames = [], insts = [], inputTracks = [];
    for (var i = 0; i < frameIdx.length; i++) {
        var list = instancesOf(session.frameGroups.get(frameIdx[i]), cam);
        if (!list.length) continue;
        insts.push(list);
        inputTracks.push(list.map(function (inst) { return inst.trackIdx; }));   // the file's own tracklets, before they are rewritten
        frames.push({ frameIdx: frameIdx[i], dets: list.map(function (inst) {
            return { points: trackerPoints(inst), score: typeof inst.score === 'number' ? inst.score : NaN, isUser: inst.type === 'user' };
        }) });
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
    // A single-camera session normally has no groups; keep any it has in step with its member's track.
    for (var groups of session.instanceGroups.values()) {
        for (var g = 0; g < groups.length; g++) {
            var m = groups[g].instances.get(cam);
            groups[g].identityId = m && m.trackIdx != null ? m.trackIdx : null;
        }
    }
    var moments = candidateMoments(frames, out, inputTracks, ambiguous, look, (opts && opts.fps) || session.fps || 30);
    return { numIdentities: nTracks, frames: frames.length, tracked: tracked, untracked: untracked, moments: moments };
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
 * Where a run of flagged encounters ENDS in the image check on one camera
 * (`continueBelow`, pose/id-switch-check.js `markChangePoints`): only at an
 * encounter scoring above +|threshold| — the mirror of the score that starts a
 * run — instead of at any score above 0. One camera has more crowded contacts
 * than a multi-camera rig sees from any one view, and an encounter in a huddle,
 * where each animal is alone for a few seconds at most, scores near 0 either
 * way; ending the run there split one swap into two rows and left the stretch
 * between them unfixed. On the 5-mouse topC video a +24 split the id_3 / id_4
 * swap at 25:23.9 (median |score| 331), so its Fix stopped there; with this rule
 * Fixing the two rows makes the tracks 99.9% correct instead of 93.8%. On the 35
 * proofread SLAP videos (image check at -25): rows 96 -> 78 (false 71 -> 51),
 * 18 of 59 swaps caught instead of 17, and the real rows' Fixes add 66 accuracy
 * points instead of 54 — while +50 or +100 merges runs across real switch-backs
 * (15 caught). The brightness check keeps 0: its encounter scores are mostly
 * noise (hence its -800 threshold), and +800 cost it a caught swap.
 * @param {number} threshold  the image check's threshold (Tracking Wizard `imageCheckThreshold`)
 * @returns {number}
 */
export function singleCameraImageContinueBelow(threshold) {
    return Math.abs(threshold);
}

/**
 * The options every ID-switch check runs with on a single-camera session, on
 * top of its own (`ui/id-switch-modal.js` merges them in):
 *  - `skipEmpty`: runs of flagged encounters ignore encounters scoring exactly 0.
 *    Those had no samples on either side (the image check reads 2 per second, and
 *    one camera's animals are seldom alone for long), so they say nothing about the
 *    labels — yet counting them as "reads right" started a swapped stretch at the
 *    first encounter WITH evidence: a Fix from 0:04.2 for a swap running from
 *    0:00, or from 0:25.9 when all six of the pair's encounters before it were
 *    empty. On the 35 proofread SLAP videos 44.5% of the image check's encounters
 *    (24.4% of brightness's) score 0; skipping them: image rows 78 -> 68 (false
 *    51 -> 42) with the same 18 of 59 swaps caught, rows whose Fix has a wrong far
 *    edge 4 -> 2, and swaps fully undone 9 -> 11 rows (with the boundary set by
 *    the user); brightness rows 21 -> 18 (false 7 -> 4), 14 caught either way.
 *    Not measured for body size on one camera (sampled at 15 Hz, so rarely empty).
 *  - image check only: `continueBelow` = `singleCameraImageContinueBelow(threshold)`.
 * Multi-camera checks run without either (not measured there).
 * @param {'size'|'image'|'brightness'} cue
 * @param {number} threshold  that check's threshold
 * @returns {{skipEmpty: boolean, continueBelow?: number}}
 */
export function singleCameraCheckOptions(cue, threshold) {
    var o = { skipEmpty: true };
    if (cue === 'image') o.continueBelow = singleCameraImageContinueBelow(threshold);
    return o;
}

/**
 * A read-only stand-in session the ID-switch checks (and the image embedder)
 * can read for a single-camera session: one InstanceGroup-shaped object per
 * identified detection, with its 2D as `points3d` (x, y, 0) and the detection
 * itself under `instances` (what the image check crops). Returns null when the
 * session is not single-camera (use the session itself), or {fail: reason}.
 */
export function singleCameraCheckSession(session) {
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
    return {
        skeleton: session.skeleton, identities: session.identities, instanceGroups: groups,
        cameras: session.cameras, fps: session.fps, singleCamera: cam,
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
