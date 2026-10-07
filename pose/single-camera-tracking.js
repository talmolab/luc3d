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
 * @param {Session} session  eager, one camera
 * @param {object} cfg       from `singleCameraTrackerConfig`
 * @param {{onProgress?: function(number, number): (void|Promise), signal?: AbortSignal}} [opts]
 * @returns {Promise<{numIdentities: number, frames: number, tracked: number, untracked: number}>}
 */
export async function trackSingleCamera(session, cfg, opts) {
    var cam = singleCameraName(session);
    if (!cam) throw new Error('not a single-camera session');
    if (session.lazyLoader) throw new Error(SINGLE_CAMERA_LAZY_REASON);
    var frameIdx = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });
    var frames = [], insts = [];
    for (var i = 0; i < frameIdx.length; i++) {
        var list = instancesOf(session.frameGroups.get(frameIdx[i]), cam);
        if (!list.length) continue;
        insts.push(list);
        frames.push({ frameIdx: frameIdx[i], dets: list.map(function (inst) {
            return { points: trackerPoints(inst), score: typeof inst.score === 'number' ? inst.score : NaN, isUser: inst.type === 'user' };
        }) });
    }
    var out = await runSleapTrackerAsync(frames, cfg, opts);

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
    return { numIdentities: nTracks, frames: frames.length, tracked: tracked, untracked: untracked };
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
