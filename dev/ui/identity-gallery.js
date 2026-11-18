// ui/identity-gallery.js — the Track All summary's "Identities" section
// (ui/track-summary-modal.js): one row per identity, with five sample images of
// that animal spread over the recording — from different cameras where it can —
// and a map of its path over one camera's view, the camera picked above the rows.
// An identity that switched between animals that look different shows up as a
// row whose images are not all the same animal, or as a path that jumps across
// the cage.
//
// The planning half is DOM-free and Node-tested (tests/test-identity-gallery.mjs):
// each identity's tracked frames and 3D centroids, which frames to sample, which
// camera to cut each sample from, the crop square, its 2D at a frame (hydrating a
// lazy project's members for the read), and the projected path. The
// drawing half decodes one frame per sample AFTER the box is on screen, one
// queue per camera with the cameras side by side, so the summary never waits on
// video, and stops when the box closes. Each frame is a caller-owned copy
// (`view.decoder.peekFrame`, closed once drawn), never `getFrame`: a jump through
// getFrame keeps the frame in the view's cache and warms the 24 frames before it
// in the background, and 25 samples left ~1.1 GB of decoded video in Chrome's
// GPU process after the summary closed (8 cameras, 1280x1024). Resting the pointer on a sample shows it enlarged beside
// the tile: the crop is copied at up to the enlarged size when it is drawn (a
// decoder's frame may be closed by the next decode), so the preview is a sharper
// image, not the 88 px tile scaled up. A map enlarges the same way — its path
// redrawn at the larger size over a larger copy of the frame — with the point
// under the pointer marked and its time in the caption.
//
// Depends on: ui/app-state.js (state), pose/lazy-residency.js
// (hydrateFrameMembers2d, releaseFrameMembers2d).

import { state } from './app-state.js?v=6bccb658b367';
import { hydrateFrameMembers2d, releaseFrameMembers2d } from '../pose/lazy-residency.js?v=6bccb658b367';
import { keyframeIndices } from './image-embedder.js?v=6bccb658b367';

/**
 * Frame `frame` of `view` for drawing, and whether the caller must close it:
 * `peekFrame`'s copy (no cache write, step cursor or back-warm; owned) when the
 * decoder has one, else `getFrame`'s (the decoder's own; never closed here).
 */
export async function galleryFrame(view, frame) {
    var d = view && view.decoder;
    if (!d) return { img: null, owned: false };
    if (typeof d.peekFrame === 'function') return { img: await d.peekFrame(frame), owned: true };
    return { img: await d.getFrame(frame), owned: false };
}

/** Close a `galleryFrame` result the caller owns. */
function releaseFrame(got) {
    if (got && got.owned && got.img && typeof got.img.close === 'function') { try { got.img.close(); } catch (e) { /* ignore */ } }
}

/** Sample images per identity. */
export const GALLERY_SAMPLES = 5;
/** Rows shown, as the summary's identity bars (`MAX_IDENTITY_ROWS`). */
export const GALLERY_MAX_ROWS = 12;
/** A sample image's side and a map's height, in CSS pixels. */
export const GALLERY_TILE = 88;
/** A sample's side when enlarged on hover, in CSS pixels — and a map's height. */
export const GALLERY_ZOOM = 320;
/** An enlarged map's widest, in CSS pixels (a wider view is shown less tall). */
export const MAP_ZOOM_MAX_WIDTH = 640;
/** Points drawn per path, at most (thinned evenly in time). */
export const MAP_MAX_POINTS = 2400;

// ---------------------------------------------------------------------------
// Planning (no DOM)
// ---------------------------------------------------------------------------

/**
 * Mean of a group's finite 3D keypoints — flat `Float64Array(3N)` or boxed
 * `[x, y, z]` rows — or null when it has none.
 */
export function groupCentroid(p3) {
    var out = [0, 0, 0];
    return groupCentroidInto(p3, out) ? out : null;
}

/** `groupCentroid` into a caller's `out` (no allocation); false when the group has no 3D point. */
function groupCentroidInto(p3, out) {
    if (!p3 || !p3.length) return false;
    var sx = 0, sy = 0, sz = 0, n = 0, i, x, y, z;
    if (typeof p3[0] === 'number') {
        for (i = 0; i + 2 < p3.length; i += 3) {
            x = p3[i]; y = p3[i + 1]; z = p3[i + 2];
            if (isFinite(x) && isFinite(y) && isFinite(z)) { sx += x; sy += y; sz += z; n++; }
        }
    } else {
        for (i = 0; i < p3.length; i++) {
            var r = p3[i];
            if (r && isFinite(r[0]) && isFinite(r[1]) && isFinite(r[2])) { sx += r[0]; sy += r[1]; sz += r[2]; n++; }
        }
    }
    if (!n) return false;
    out[0] = sx / n; out[1] = sy / n; out[2] = sz / n;
    return true;
}

/**
 * Every identity's tracked frames and 3D centroids, in frame order. A frame where
 * an identity has more than one group is ambiguous and left out, as the image
 * check does; so is a group with no 3D.
 *
 * @returns {Map<number, {frames: Int32Array, xyz: Float64Array}>}
 */
export function identityTracks(session) {
    var steps = identityTrackSteps(session, 0), r;
    while (!(r = steps.next()).done) { /* no pauses */ }
    return r.value;
}

/** The longest stretch of `identityTracksAsync` between two pauses, in ms. */
export const TRACKS_SLICE_MS = 20;

/**
 * `identityTracks` in slices: `await pause()` whenever `sliceMs` (default
 * TRACKS_SLICE_MS) of it have passed (the clock is read every 1,024 frames).
 * The same pass in the same order: the same tracks.
 * @param {function(): Promise} pause
 * @returns {Promise<Map<number, {frames: Int32Array, xyz: Float64Array}>>}
 */
export async function identityTracksAsync(session, pause, sliceMs) {
    var steps = identityTrackSteps(session, sliceMs > 0 ? sliceMs : TRACKS_SLICE_MS), r;
    while (!(r = steps.next()).done) await pause();
    return r.value;
}

/** identityTracks' body: yields (to be resumed) whenever `sliceMs` > 0 have passed. */
function* identityTrackSteps(session, sliceMs) {
    var acc = new Map();
    if (!session || !session.instanceGroups) return new Map();
    // Runs once per Track All summary over every group (~540,000 on an 8-camera,
    // 108,000-frame project), so a frame allocates nothing: a frame holds a few
    // groups, so an identity's second group is found by scanning them, and the
    // centroid goes into `c`. Each identity is pushed in the order of its group
    // among the frame's groups, as the Map of first appearances gave.
    var c = [0, 0, 0];
    var clock = typeof performance !== 'undefined' ? performance : Date, sliceStart = sliceMs > 0 ? clock.now() : 0;
    var keys = session.instanceGroups.keys(), walked = 0;
    for (var kr = keys.next(); !kr.done; kr = keys.next()) {
        if (sliceMs > 0 && (++walked & 1023) === 0 && clock.now() - sliceStart >= sliceMs) {
            yield walked;
            sliceStart = clock.now();
        }
        var frame = kr.value, groups = session.instanceGroups.get(frame);
        if (!groups) continue;
        for (var gi = 0; gi < groups.length; gi++) {
            var g = groups[gi];
            if (!g || g.identityId == null || g.identityId < 0) continue;
            var id = g.identityId, twice = false;
            for (var gj = 0; gj < groups.length && !twice; gj++) {
                if (gj !== gi && groups[gj] && groups[gj].identityId === id) twice = true;
            }
            if (twice) continue;                         // ambiguous frame for this identity
            if (!groupCentroidInto(g.points3d, c)) continue;
            var a = acc.get(id);
            if (!a) acc.set(id, a = { frames: [], xyz: [] });
            a.frames.push(+frame); a.xyz.push(c[0], c[1], c[2]);
        }
    }
    var out = new Map();
    acc.forEach(function (a, id) {
        var n = a.frames.length, order = new Int32Array(n), sorted = true;
        for (var i = 0; i < n; i++) { order[i] = i; if (i && a.frames[i] < a.frames[i - 1]) sorted = false; }
        // Frames usually arrive in order already: a comparator sort over each
        // identity's ~100,000 frames was ~30 ms for nothing.
        if (!sorted) order.sort(function (p, q) { return a.frames[p] - a.frames[q]; });
        var frames = new Int32Array(n), xyz = new Float64Array(3 * n);
        for (var j = 0; j < n; j++) {
            var k = order[j];
            frames[j] = a.frames[k];
            xyz[3 * j] = a.xyz[3 * k]; xyz[3 * j + 1] = a.xyz[3 * k + 1]; xyz[3 * j + 2] = a.xyz[3 * k + 2];
        }
        out.set(id, { frames: frames, xyz: xyz });
    });
    return out;
}

/**
 * The identities (in `session.identities` order) with a group that has a 3D
 * point, found cheaply: the scan stops once every identity has one (usually
 * within the first frames) and allocates nothing per group. `identityTracks`
 * can still leave one out (3D only on frames where it has two groups).
 * @returns {Object[]} identity objects
 */
export function identitiesWith3d(session) {
    var idents = (session && session.identities) || [];
    if (!idents.length || !session.instanceGroups) return [];
    var want = new Map(), found = new Set(), c = [0, 0, 0];
    idents.forEach(function (id) { want.set(id.id, true); });
    var keys = session.instanceGroups.keys();
    for (var r = keys.next(); !r.done && found.size < want.size; r = keys.next()) {
        var groups = session.instanceGroups.get(r.value) || [];
        for (var gi = 0; gi < groups.length; gi++) {
            var g = groups[gi];
            if (!g || !want.has(g.identityId) || found.has(g.identityId)) continue;
            if (groupCentroidInto(g.points3d, c)) found.add(g.identityId);
        }
    }
    return idents.filter(function (id) { return found.has(id.id); });
}

/** The identity's one group at `frame` (null when it has none, or two). */
export function identityGroupAt(session, frame, identityId) {
    var found = null;
    var groups = (session && session.instanceGroups && session.instanceGroups.get(frame)) || [];
    for (var i = 0; i < groups.length; i++) {
        if (groups[i] && groups[i].identityId === identityId) {
            if (found) return null;
            found = groups[i];
        }
    }
    return found;
}

/** A group's size: the diagonal of its 3D keypoints' box (0 without them). */
function groupExtent(p3) {
    if (!p3 || !p3.length) return 0;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], flat = typeof p3[0] === 'number';
    var n = flat ? Math.floor(p3.length / 3) : p3.length;
    for (var i = 0; i < n; i++) {
        var r = flat ? [p3[3 * i], p3[3 * i + 1], p3[3 * i + 2]] : p3[i];
        if (!r || !isFinite(r[0]) || !isFinite(r[1]) || !isFinite(r[2])) continue;
        for (var d = 0; d < 3; d++) { if (r[d] < lo[d]) lo[d] = r[d]; if (r[d] > hi[d]) hi[d] = r[d]; }
    }
    return isFinite(lo[0]) ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 0;
}

/** Distance from `own` to the nearest OTHER identity's centroid at `frame` (Infinity when alone there). */
function isolationAt(session, frame, identityId, own) {
    var best = Infinity;
    var groups = (session.instanceGroups && session.instanceGroups.get(frame)) || [];
    for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        if (!g || g.identityId === identityId) continue;
        var c = groupCentroid(g.points3d);
        if (!c) continue;
        var d = Math.hypot(c[0] - own[0], c[1] - own[1], c[2] - own[2]);
        if (d < best) best = d;
    }
    return best;
}

/**
 * The frames to sample for one identity: `k` targets spread evenly over its
 * tracked span (the middle of each of `k` equal slots), each moved, when it has
 * to be, to a frame where the animal is ISOLATED — its nearest other identity
 * more than 1.5 of its own body sizes away — so an image shows this animal
 * rather than a huddle it is part of. Among the isolated frames of a slot the
 * one nearest its middle wins (maximising isolation instead pushed every pick
 * to a slot edge, two samples a few frames apart); with none, the most isolated.
 * Only the middle 60% of a slot is searched, so neighbouring samples stay at
 * least 40% of a slot apart even in a cage too crowded for any frame to be
 * isolated. At most `maxCandidates` frames per slot are scored, evenly strided.
 * With more than `k` tracked frames there are always `k` samples: slots that a
 * long gap left without one of their own are filled evenly over the tracked frames.
 *
 * `opts.keyframes` (the video's keyframe indices, increasing): a slot's
 * candidates are then only its tracked KEYFRAMES, when it has any — the same
 * rules among fewer frames. A keyframe decodes as one frame; any other frame
 * decodes from the keyframe before it (up to 249 frames at a keyframe every 250).
 *
 * @param {Object} session
 * @param {{frames: Int32Array, xyz: Float64Array}} track  from `identityTracks`
 * @param {number} identityId
 * @param {number} [k]  GALLERY_SAMPLES
 * @param {{maxCandidates?: number, keyframes?: ArrayLike<number>}} [opts]
 * @returns {number[]} ascending, distinct
 */
export function pickSampleFrames(session, track, identityId, k, opts) {
    k = k || GALLERY_SAMPLES;
    var maxCand = (opts && opts.maxCandidates) || 40;
    var F = track && track.frames, n = F ? F.length : 0;
    if (!n) return [];
    if (n <= k) return Array.from(F);
    var lo = F[0], hi = F[n - 1], span = hi - lo, out = [];
    // index of the first tracked frame >= f
    var lower = function (f) { var a = 0, b = n; while (a < b) { var m = (a + b) >> 1; if (F[m] < f) a = m + 1; else b = m; } return a; };
    var KF = opts && opts.keyframes && opts.keyframes.length ? opts.keyframes : null;
    // the tracked frames in [a0, a1) that are keyframes, as indices into F
    var trackedKeyframes = function (a0, a1) {
        var out2 = [];
        if (!KF || a1 <= a0) return out2;
        var x = 0, y = KF.length, f0 = F[a0];
        while (x < y) { var m = (x + y) >> 1; if (KF[m] < f0) x = m + 1; else y = m; }
        for (; x < KF.length && KF[x] <= F[a1 - 1]; x++) {
            var at = lower(KF[x]);
            if (at < a1 && F[at] === KF[x]) out2.push(at);
        }
        return out2;
    };
    for (var s = 0; s < k; s++) {
        var a0 = lower(lo + span * (s + 0.2) / k), a1 = lower(lo + span * (s + 0.8) / k);
        if (s === k - 1 && a1 >= n) a1 = n;
        if (a1 <= a0) {                                  // nothing tracked in the middle of the slot: its nearest frame
            a0 = Math.min(n - 1, lower(lo + span * (s + 0.5) / k)); a1 = a0 + 1;
        }
        var target = lo + span * (s + 0.5) / k;
        // the candidates: the slot's tracked keyframes when it has any, else its tracked frames
        var cand = trackedKeyframes(a0, a1);
        if (!cand.length) { cand = []; for (var c0 = a0; c0 < a1; c0++) cand.push(c0); }
        var step = Math.max(1, Math.floor(cand.length / maxCand));
        var near = -1, nearDist = Infinity, most = -1, mostIso = -1;
        for (var ci = 0; ci < cand.length; ci += step) {
            var i = cand[ci];
            var own = [track.xyz[3 * i], track.xyz[3 * i + 1], track.xyz[3 * i + 2]];
            var iso = isolationAt(session, F[i], identityId, own), dist = Math.abs(F[i] - target);
            var g = identityGroupAt(session, F[i], identityId);
            if (iso > 1.5 * groupExtent(g && g.points3d) && dist < nearDist) { near = i; nearDist = dist; }
            if (iso > mostIso || (iso === mostIso && dist < Math.abs(F[most] - target))) { most = i; mostIso = iso; }
        }
        var pick = near >= 0 ? near : most;
        if (pick >= 0 && out.indexOf(F[pick]) < 0) out.push(F[pick]);
    }
    // A gap wider than a slot sends those slots all to the frame after it. Make up
    // the count evenly over the frames the identity WAS tracked on, so a row keeps
    // its samples and shows every stretch.
    for (var t = 0; t < k && out.length < k; t++) {
        var extra = F[Math.floor((t + 0.5) * n / k)];
        if (out.indexOf(extra) < 0) out.push(extra);
    }
    return out.sort(function (p, q) { return p - q; });
}

/**
 * Pixel bounding box of a group's 3D keypoints in one camera (projected with the
 * camera's distortion, as the overlays reproject), or null without them.
 */
export function projectedBox(points3d, camera) {
    if (!points3d || !camera || typeof camera.project !== 'function') return null;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    var flat = typeof points3d[0] === 'number', count = flat ? Math.floor(points3d.length / 3) : points3d.length;
    for (var i = 0; i < count; i++) {
        var p = flat ? [points3d[3 * i], points3d[3 * i + 1], points3d[3 * i + 2]] : points3d[i];
        if (!p || !isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2])) continue;
        var uv = camera.project(p);
        if (typeof camera.distortPoint === 'function') uv = camera.distortPoint(uv);
        if (!uv || !isFinite(uv[0]) || !isFinite(uv[1])) continue;
        if (uv[0] < x0) x0 = uv[0]; if (uv[0] > x1) x1 = uv[0];
        if (uv[1] < y0) y0 = uv[1]; if (uv[1] > y1) y1 = uv[1];
        n++;
    }
    return n ? { x0: x0, y0: y0, x1: x1, y1: y1 } : null;
}

/**
 * The camera to cut one sample from, among those where the group has a 2D
 * member. How large the animal projects there (its 3D box's diagonal, in
 * pixels) and whether it falls inside the image decide: the best is the largest
 * inside its image. Among the views good enough to use — inside the image and at
 * least 30% of the best's size (and 40 px) — the one this identity's earlier
 * samples used LEAST wins (the larger on a tie), so the five samples rotate
 * through the views where the animal is visible, but never onto one where it is
 * a speck.
 *
 * With `points2d` (camera name -> that member's 2D keypoints), a view whose 2D
 * detection is poor is passed over while any other is not: fewer than half its
 * keypoints present, or spread more than 2.5x as wide as the 3D says the animal
 * is (scattered keypoints cut a huge crop with a speck of animal in it).
 * Null without a member; a member in a camera with no calibration is used only
 * when nothing else is.
 *
 * @param {Object} group  InstanceGroup
 * @param {Object[]} cameras  session.cameras
 * @param {Map<string, number>|Set<string>} used  how often each camera was used (a Set: once)
 * @param {Map<string, Array>} [points2d]
 * @returns {string|null}
 */
export function pickCamera(group, cameras, used, points2d) {
    if (!group || !group.instances || !group.instances.size) return null;
    var cands = [];
    (cameras || []).forEach(function (cam) {
        if (!cam || !group.instances.has(cam.name)) return;
        var b = projectedBox(group.points3d, cam), size = 0, inside = true;
        if (b) {
            size = Math.hypot(b.x1 - b.x0, b.y1 - b.y0);
            var w = cam.size && cam.size[0], h = cam.size && cam.size[1];
            var cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
            if (w > 0 && h > 0) inside = cx >= 0 && cx < w && cy >= 0 && cy < h;
        }
        var times = !used ? 0 : typeof used.get === 'function' ? (used.get(cam.name) || 0) : (used.has(cam.name) ? 1 : 0);
        cands.push({ name: cam.name, size: size, inside: inside, times: times, poor: points2d ? poor2d(points2d.get(cam.name), size) : false });
    });
    if (!cands.length) return group.instances.keys().next().value || null;
    if (cands.some(function (c) { return !c.poor; })) cands = cands.filter(function (c) { return !c.poor; });
    var better = function (a, b) { return !b || (a.inside !== b.inside ? a.inside : a.size > b.size); };
    var best = null;
    cands.forEach(function (c) { if (better(c, best)) best = c; });
    var floor = Math.max(40, 0.3 * best.size);
    var good = cands.filter(function (c) { return c === best || (c.inside && c.size >= floor); });
    var least = Math.min.apply(null, good.map(function (c) { return c.times; })), pick = null;
    good.forEach(function (c) { if (c.times === least && (!pick || c.size > pick.size)) pick = c; });
    return pick.name;
}

/** A member's 2D detection is too poor to crop from (see `pickCamera`). */
function poor2d(pts, size3d) {
    if (!pts || !pts.length) return true;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    pts.forEach(function (p) {
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) return;
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
        n++;
    });
    if (n < Math.max(2, pts.length / 2)) return true;
    return size3d > 0 && Math.hypot(x1 - x0, y1 - y0) > 2.5 * size3d + 20;
}

/**
 * A square around the finite 2D points (pixels): side = 1.4 x the larger extent
 * plus 12 px, at least 40 px, centred on the box. Null with fewer than 2 points.
 *
 * @param {Array<number[]|null>} pts
 * @returns {{x: number, y: number, side: number}|null}  x, y = top-left
 */
export function cropSquare(pts) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
    (pts || []).forEach(function (p) {
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) return;
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
        n++;
    });
    if (n < 2) return null;
    var side = Math.max(40, 1.4 * Math.max(x1 - x0, y1 - y0) + 12);
    return { x: (x0 + x1) / 2 - side / 2, y: (y0 + y1) / 2 - side / 2, side: side };
}

/**
 * An identity's path in one camera's pixels: its 3D centroid projected (with the
 * camera's distortion), thinned evenly to at most `maxPoints`, with `breaks[i]`
 * set where point i does not join the one before it — its frame is more than
 * `gapFrames` after it, or either did not project.
 *
 * @returns {{uv: Float32Array, frames: Int32Array, breaks: Uint8Array}}
 */
export function projectTrack(track, camera, maxPoints, gapFrames) {
    var n = track ? track.frames.length : 0;
    var step = Math.max(1, Math.ceil(n / (maxPoints || MAP_MAX_POINTS)));
    var m = Math.ceil(n / step);
    var uv = new Float32Array(2 * m), frames = new Int32Array(m), breaks = new Uint8Array(m);
    var gap = (gapFrames > 0 ? gapFrames : Infinity) * step, prevFrame = null, prevOk = false;
    for (var j = 0, i = 0; i < n; i += step, j++) {
        var p = [track.xyz[3 * i], track.xyz[3 * i + 1], track.xyz[3 * i + 2]];
        var q = camera && typeof camera.project === 'function' ? camera.project(p) : null;
        if (q && typeof camera.distortPoint === 'function') q = camera.distortPoint(q);
        var ok = !!q && isFinite(q[0]) && isFinite(q[1]);
        uv[2 * j] = ok ? q[0] : NaN; uv[2 * j + 1] = ok ? q[1] : NaN;
        frames[j] = track.frames[i];
        breaks[j] = (j === 0 || !ok || !prevOk || track.frames[i] - prevFrame > gap) ? 1 : 0;
        prevFrame = track.frames[i]; prevOk = ok;
    }
    return { uv: uv, frames: frames, breaks: breaks };
}

/**
 * The camera the maps start on: the one with the most 2D members over (a
 * thinned sample of) the session's groups — the view that sees the animals
 * most. Ties keep the session's camera order.
 */
export function defaultMapCamera(session) {
    var cams = (session && session.cameras) || [];
    if (!cams.length) return null;
    var count = new Map(cams.map(function (c) { return [c.name, 0]; }));
    var keys = session.instanceGroups ? Array.from(session.instanceGroups.keys()) : [];
    var step = Math.max(1, Math.floor(keys.length / 2000));
    for (var i = 0; i < keys.length; i += step) {
        (session.instanceGroups.get(keys[i]) || []).forEach(function (g) {
            if (g && g.instances) g.instances.forEach(function (_, cam) { if (count.has(cam)) count.set(cam, count.get(cam) + 1); });
        });
    }
    var best = cams[0].name;
    cams.forEach(function (c) { if (count.get(c.name) > count.get(best)) best = c.name; });
    return best;
}

// Sequential ramp for TIME along a path (one hue, dataviz reference blue): on the
// darkened video the early end is the darker step (500) and the late end the
// lightest (100), so the anchor recedes toward the surface as dark mode asks.
var TIME_RAMP = ['#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];
var RAMP_RGB = TIME_RAMP.map(function (h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; });

/** The path colour at time fraction `t` (0 = start of the recording, 1 = its end). */
export function timeColor(t) {
    t = Math.min(1, Math.max(0, isFinite(t) ? t : 0));
    var x = t * (RAMP_RGB.length - 1), i = Math.min(RAMP_RGB.length - 2, Math.floor(x)), f = x - i;
    var a = RAMP_RGB[i], b = RAMP_RGB[i + 1];
    return 'rgb(' + Math.round(a[0] + f * (b[0] - a[0])) + ',' + Math.round(a[1] + f * (b[1] - a[1])) + ',' + Math.round(a[2] + f * (b[2] - a[2])) + ')';
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
}

/** "12:34" from a frame index at the app's frame rate. */
function fmtTime(frame) {
    var sec = frame / (state.fps || 30);
    var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = Math.floor(sec % 60);
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function safeColor(c) {
    return typeof c === 'string' && /^#[0-9a-f]{3,8}$|^rgba?\([\d\s.,%]+\)$/i.test(c) ? c : null;
}

function pixelRatio() {
    return Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
}

/** A canvas sized for the screen's pixel density; draw in CSS pixels. */
function hiDpiCanvas(w, h, className) {
    var c = el('canvas', className), dpr = pixelRatio();
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    c.style.width = w + 'px'; c.style.height = h + 'px';
    c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    return c;
}

/** How long the gallery waits for a video's keyframes before planning without them. */
export const SAMPLE_KEYFRAMES_WAIT_MS = 1500;

/**
 * A view's keyframe indices for `pickSampleFrames`, or null: no decoder, an
 * unreadable index (`keyframeIndices`, read once per video and cached), or not
 * within SAMPLE_KEYFRAMES_WAIT_MS.
 */
function sampleKeyframes(view) {
    if (!view || !view.decoder) return Promise.resolve(null);
    var read = Promise.resolve().then(function () { return keyframeIndices(view.decoder); }).catch(function () { return null; });
    var late = new Promise(function (res) { setTimeout(function () { res(null); }, SAMPLE_KEYFRAMES_WAIT_MS); });
    return Promise.race([read, late]);
}

function viewFor(cam) {
    return (state.views || []).filter(function (v) { return v && v.name === cam && v.decoder && typeof v.decoder.getFrame === 'function'; })[0] || null;
}

function imageSize(img) {
    return img ? [img.displayWidth || img.width || img.videoWidth || 0, img.displayHeight || img.height || img.videoHeight || 0] : [0, 0];
}

/**
 * One identity's 2D keypoints at `frame`, per camera (camera name -> points),
 * hydrating a lazy project's members once for the read and giving them back
 * after it (pose/lazy-residency.js: a member of a frame that is not resident
 * holds no 2D).
 */
export function memberPointsByCamera(session, frame, identityId) {
    var out = new Map();
    var hydrated = hydrateFrameMembers2d(session, frame) > 0;
    try {
        var g = identityGroupAt(session, frame, identityId);
        if (g && g.instances) g.instances.forEach(function (inst, cam) {
            var pts = [];
            for (var k = 0; inst && k < inst.numNodes; k++) pts.push(inst.getPoint(k));
            out.set(cam, pts);
        });
        return out;
    } finally {
        if (hydrated) releaseFrameMembers2d(session, frame);
    }
}

/** One identity's keypoints, as dots in its colour, over a crop drawn `size` px square. */
function drawSampleDots(ctx, pts, box, size, color, radius) {
    var scale = size / box.side;
    ctx.fillStyle = color || '#fff'; ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'; ctx.lineWidth = 1;
    pts.forEach(function (p) {
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) return;
        ctx.beginPath(); ctx.arc((p[0] - box.x) * scale, (p[1] - box.y) * scale, radius, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    });
}

/**
 * One identity's path over a camera's view, drawn `w` x `h` CSS px: the frame
 * (`bg`, may be null) darkened — the path is the subject — then each joined step
 * in the time colour of its later point. `path` is `projectTrack`'s, in the
 * view's `vw` x `vh` pixels; `last` is the recording's last frame.
 */
function drawPath(ctx, w, h, bg, path, vw, vh, last, lineWidth) {
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, w, h);
    if (bg) { try { ctx.drawImage(bg, 0, 0, w, h); } catch (e) { /* a closed frame draws nothing */ } }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'; ctx.fillRect(0, 0, w, h);
    var sx = w / vw, sy = h / vh;
    ctx.lineWidth = lineWidth; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (var i = 1; i < path.frames.length; i++) {
        if (path.breaks[i]) continue;
        ctx.strokeStyle = timeColor(path.frames[i] / last);
        ctx.beginPath();
        ctx.moveTo(path.uv[2 * i - 2] * sx, path.uv[2 * i - 1] * sy);
        ctx.lineTo(path.uv[2 * i] * sx, path.uv[2 * i + 1] * sy);
        ctx.stroke();
    }
}

/**
 * The hover preview: one floating element per section, shown beside the tile or
 * map under the pointer. It lives in the summary's overlay (fixed, full-window),
 * not in the modal, which scrolls and would clip it; closing the box removes it.
 *
 * What it shows is the element's `_zoom`: `{kind, w, h, draw(ctx, w, h), color,
 * label, frame}` — `draw` paints `w` x `h` CSS pixels. Showing the element it
 * already shows redraws it in place (a map's marker follows the pointer).
 */
function makeZoom(section) {
    var box = null, canvas = null, cap = null, tile = null, cw = 0, ch = 0;
    var hide = function () { tile = null; if (box) box.style.display = 'none'; };
    var show = function (fig) {
        var z = fig._zoom;
        if (!z || !section.isConnected) return;
        if (!box) {
            box = el('div', 'identity-gallery-zoom');
            box.id = 'identityGalleryZoom';
            canvas = el('canvas', 'identity-gallery-zoom-img');
            cap = el('div', 'identity-gallery-zoom-caption');
            box.appendChild(canvas);
            box.appendChild(cap);
        }
        var host = section.closest('.multi-frame-modal-overlay') || document.body;
        if (box.parentNode !== host) host.appendChild(box);
        tile = fig;
        var dpr = pixelRatio();
        if (z.w !== cw || z.h !== ch) {               // a sample is square, a map the view's shape
            cw = z.w; ch = z.h;
            canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
            canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
            cap.style.maxWidth = cw + 'px';
        }
        var ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
        ctx.imageSmoothingQuality = 'high';
        z.draw(ctx, cw, ch);
        canvas.style.borderColor = z.color || '';
        cap.textContent = z.label;
        box.setAttribute('data-kind', z.kind);
        box.setAttribute('data-frame', z.frame != null ? String(z.frame) : '');
        box.style.display = 'block';
        // beside the tile — right if it fits, else left — and inside the window
        var r = fig.getBoundingClientRect(), bw = box.offsetWidth, bh = box.offsetHeight, gap = 10;
        var vw = window.innerWidth, vh = window.innerHeight;
        var left = r.right + gap + bw <= vw - 8 ? r.right + gap : r.left - gap - bw;
        left = Math.max(8, Math.min(vw - bw - 8, left));
        var top = Math.max(8, Math.min(vh - bh - 8, r.top + r.height / 2 - bh / 2));
        box.style.left = left + 'px';
        box.style.top = top + 'px';
    };
    return { show: show, hide: hide, tile: function () { return tile; } };
}

/**
 * Build the section into `host` and fill it in the background. Nothing is drawn
 * for fewer than two identities with tracked 3D.
 *
 * The rows are built at once from `identitiesWith3d`; every identity's track
 * (`identityTracks`, a pass over every group: ~50 ms on an 8-camera,
 * 108,000-frame project) is read AFTER the box paints, so opening the summary
 * does not wait for it. A row whose identity then has no track is removed, and
 * with fewer than two left so is the section (`opts.onEmpty()`).
 *
 * @param {HTMLElement} host
 * @param {Object} session
 * @param {{onPick?: function(number), onEmpty?: function()}} [opts]  onPick: a sample or a map point was
 *   clicked, go to that frame; onEmpty: the section removed itself after all
 * @returns {{done: Promise<void>, element: HTMLElement}|null}
 */
export function renderIdentityGallery(host, session, opts) {
    if (typeof document === 'undefined' || !host || !session) return null;
    opts = opts || {};
    var ids = identitiesWith3d(session);
    if (ids.length < 2) return null;
    var tracks = null;   // identityTracks(session), read after the box paints (`done`)
    var cams = (session.cameras || []).filter(function (c) { return c && c.name; });

    var section = el('div', 'identity-gallery');
    section.id = 'identityGallery';
    var head = el('div', 'identity-gallery-head');
    head.appendChild(el('div', 'track-summary-section-title', 'Identities'));
    var mapCam = session._galleryView && cams.some(function (c) { return c.name === session._galleryView; })
        ? session._galleryView : defaultMapCamera(session);
    var select = null;
    if (cams.length) {
        var pick = el('label', 'identity-gallery-view');
        pick.appendChild(el('span', null, 'Map view'));
        select = el('select');
        select.id = 'identityGalleryView';
        cams.forEach(function (c) { var o = el('option', null, c.name); o.value = c.name; select.appendChild(o); });
        select.value = mapCam;
        pick.appendChild(select);
        head.appendChild(pick);
        // the key: what the path's colour means
        var key = el('div', 'identity-gallery-key');
        key.title = 'Path colour: time in the recording';
        key.appendChild(el('span', null, fmtTime(0)));
        var bar = el('span', 'identity-gallery-key-bar');
        bar.style.background = 'linear-gradient(to right, ' + TIME_RAMP.join(', ') + ')';
        key.appendChild(bar);
        key.appendChild(el('span', null, fmtTime(Math.max(0, (state.totalFrames || 1) - 1))));
        head.appendChild(key);
    }
    section.appendChild(head);

    var shown = ids.slice(0, GALLERY_MAX_ROWS);
    var rows = shown.map(function (id) {
        var row = el('div', 'identity-gallery-row');
        row.setAttribute('data-identity', String(id.id));
        var name = el('div', 'identity-gallery-name', id.name);
        var color = safeColor(id.color);
        if (color) name.style.color = color;
        row.appendChild(name);
        var tiles = el('div', 'identity-gallery-tiles');
        var slots = [];
        for (var s = 0; s < GALLERY_SAMPLES; s++) {
            var fig = el('figure', 'identity-gallery-tile is-pending');
            fig.appendChild(el('div', 'identity-gallery-blank'));
            fig.appendChild(el('figcaption', null, ' '));
            tiles.appendChild(fig);
            slots.push(fig);
        }
        row.appendChild(tiles);
        var map = el('div', 'identity-gallery-map');
        row.appendChild(map);
        section.appendChild(row);
        return { id: id, color: color, slots: slots, map: map, el: row };
    });
    if (ids.length > shown.length) {
        section.appendChild(el('div', 'track-summary-id-more', 'and ' + (ids.length - shown.length).toLocaleString('en-US') + ' more'));
    }
    host.appendChild(section);

    var alive = function () { return section.isConnected; };
    var pickFrame = function (frame) { if (opts.onPick) opts.onPick(frame); };
    var zoom = makeZoom(section);
    // the tile moves under a still pointer when the box scrolls: drop the preview
    host.addEventListener('scroll', zoom.hide, { passive: true });

    // ---- maps --------------------------------------------------------------
    var mapToken = 0;
    var drawMaps = async function (camName) {
        if (!tracks) return;   // before the tracks are read: `done` draws the view selected then
        var token = ++mapToken;
        var cam = cams.filter(function (c) { return c.name === camName; })[0];
        var view = viewFor(camName);
        var vw = (view && view.videoWidth) || (cam && cam.size && cam.size[0]) || 640;
        var vh = (view && view.videoHeight) || (cam && cam.size && cam.size[1]) || 480;
        var H = GALLERY_TILE, W = Math.max(48, Math.min(240, Math.round(H * vw / vh)));
        var bg = null, bgGot = null;
        if (view) {
            try { bgGot = await galleryFrame(view, Math.max(0, Math.min((state.totalFrames || 1) - 1, state.currentFrame || 0))); bg = bgGot.img; }
            catch (e) { bg = null; }
        }
        if (token !== mapToken || !alive()) { releaseFrame(bgGot); return; }
        var tile = zoom.tile();
        if (tile && tile.classList.contains('identity-gallery-map-canvas')) zoom.hide();   // that map is being replaced
        var last = Math.max(1, (state.totalFrames || 1) - 1);
        // The enlarged map: the view's shape, GALLERY_ZOOM tall unless that is wider than MAP_ZOOM_MAX_WIDTH. Its
        // frame is copied now, at up to that size, since a decoder's frame may be closed by the next decode.
        var ZH = GALLERY_ZOOM, ZW = Math.round(ZH * vw / vh);
        if (ZW > MAP_ZOOM_MAX_WIDTH) { ZW = MAP_ZOOM_MAX_WIDTH; ZH = Math.max(1, Math.round(ZW * vh / vw)); }
        var bgBig = null;
        if (bg) {
            var bsz = imageSize(bg), dpr = pixelRatio();
            bgBig = el('canvas');
            bgBig.width = Math.max(1, Math.min(bsz[0] || vw, Math.round(ZW * dpr)));
            bgBig.height = Math.max(1, Math.min(bsz[1] || vh, Math.round(ZH * dpr)));
            try { bgBig.getContext('2d').drawImage(bg, 0, 0, bgBig.width, bgBig.height); } catch (e) { bgBig = null; }
        }
        rows.forEach(function (r) {
            var c = hiDpiCanvas(W, H, 'identity-gallery-map-canvas');
            var path = projectTrack(tracks.get(r.id.id), cam, MAP_MAX_POINTS, Math.round(2 * (state.fps || 30)));
            drawPath(c.getContext('2d'), W, H, bg, path, vw, vh, last, 1.5);
            var sx = W / vw, sy = H / vh;
            c.setAttribute('data-points', String(path.frames.length));
            // hover: the time at the nearest point; click: go there
            var nearest = function (ev) {
                var rect = c.getBoundingClientRect(), mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
                var best = -1, bd = 64;   // within 8 px
                for (var k = 0; k < path.frames.length; k++) {
                    var dx = path.uv[2 * k] * sx - mx, dy = path.uv[2 * k + 1] * sy - my, d = dx * dx + dy * dy;
                    if (d < bd) { bd = d; best = k; }
                }
                return best < 0 ? null : { k: best, frame: path.frames[best], x: path.uv[2 * best] * sx, y: path.uv[2 * best + 1] * sy };
            };
            // the enlarged map (makeZoom): the path redrawn at that size — once, on first hover — and a ring
            // on the point under the pointer, whose time the caption gives
            var whole = r.id.name + ' over the recording, in ' + camName + ' — click the path to go there';
            var big = null, mark = null;
            c._zoom = { kind: 'map', w: ZW, h: ZH, color: r.color, label: whole, frame: null,
                draw: function (ctx, w, h) {
                    if (!big) {
                        big = hiDpiCanvas(w, h);
                        drawPath(big.getContext('2d'), w, h, bgBig, path, vw, vh, last, 2);
                    }
                    ctx.drawImage(big, 0, 0, w, h);
                    if (!mark) return;
                    var mx = path.uv[2 * mark.k] * w / vw, my = path.uv[2 * mark.k + 1] * h / vh;
                    ctx.beginPath(); ctx.arc(mx, my, 7, 0, 2 * Math.PI);
                    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)'; ctx.stroke();
                    ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
                } };
            var tip = el('div', 'identity-gallery-map-tip');
            c.addEventListener('mouseenter', function () { zoom.show(c); });
            c.addEventListener('mousemove', function (ev) {
                var p = nearest(ev);
                if ((p && p.k) !== (mark && mark.k)) {      // the marked point changed: redraw the preview
                    mark = p;
                    c._zoom.frame = p ? p.frame : null;
                    c._zoom.label = p ? r.id.name + ' · ' + fmtTime(p.frame) + ' · ' + camName + ' — click to go there' : whole;
                    zoom.show(c);
                }
                if (!p) { tip.style.display = 'none'; c.style.cursor = ''; return; }
                tip.textContent = fmtTime(p.frame);
                tip.style.display = 'block';
                tip.style.left = Math.min(W - 30, Math.max(0, p.x - 14)) + 'px';
                tip.style.top = Math.max(0, p.y - 20) + 'px';
                c.style.cursor = 'pointer';
            });
            c.addEventListener('mouseleave', function () {
                tip.style.display = 'none'; zoom.hide();
                mark = null; c._zoom.frame = null; c._zoom.label = whole;
            });
            c.addEventListener('click', function (ev) { var p = nearest(ev); if (p) pickFrame(p.frame); });
            r.map.textContent = '';
            r.map.appendChild(c);
            r.map.appendChild(tip);
        });
        releaseFrame(bgGot);   // drawn into every map and copied into bgBig: nothing keeps it
    };
    if (select) {
        select.addEventListener('change', function () {
            session._galleryView = select.value;   // in memory: reopening the summary keeps it
            drawMaps(select.value);
        });
    }

    // ---- sample images -----------------------------------------------------
    // A row's samples are planned at once (frame, camera, crop: no video needed);
    // each that needs an image becomes a job, fetched by `fetchSamples`.
    var planRow = function (r, keyframes) {
        var frames = pickSampleFrames(session, tracks.get(r.id.id), r.id.id, GALLERY_SAMPLES, { keyframes: keyframes });
        var used = new Map(), jobs = [];
        for (var s = 0; s < r.slots.length; s++) {
            var fig = r.slots[s], frame = frames[s];
            if (frame == null) { fig.className = 'identity-gallery-tile is-empty'; continue; }
            var group = identityGroupAt(session, frame, r.id.id);
            var byCam = memberPointsByCamera(session, frame, r.id.id);
            var cam = pickCamera(group, cams, used, byCam);
            var cap = fig.querySelector('figcaption');
            cap.textContent = fmtTime(frame);
            fig.setAttribute('data-frame', String(frame));
            if (cam) fig.setAttribute('data-camera', cam);
            fig.title = r.id.name + ' · ' + fmtTime(frame) + (cam ? ' · ' + cam : '') + ' — click to go to this frame';
            fig.addEventListener('click', pickFrame.bind(null, frame));
            if (cam) used.set(cam, (used.get(cam) || 0) + 1);
            var pts = (cam && byCam.get(cam)) || [];
            var view = cam && viewFor(cam), box = cropSquare(pts);
            if (!view || !box) {
                fig.className = 'identity-gallery-tile is-missing';
                fig.querySelector('.identity-gallery-blank').textContent = view ? 'no keypoints' : 'no video';
                continue;
            }
            jobs.push({ r: r, fig: fig, frame: frame, cam: cam, view: view, box: box, pts: pts });
        }
        return jobs;
    };

    // Draw a sample's image into its tile, as soon as it is decoded (the image is
    // closed right after: the tile and its preview keep copies of the crop).
    var drawSample = function (job, img) {
        var r = job.r, fig = job.fig, frame = job.frame, cam = job.cam, box = job.box, pts = job.pts;
        var c = hiDpiCanvas(GALLERY_TILE, GALLERY_TILE, 'identity-gallery-img'), ctx = c.getContext('2d');
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, GALLERY_TILE, GALLERY_TILE);
        var drawn = false;
        if (img) {
            try { ctx.drawImage(img, box.x, box.y, box.side, box.side, 0, 0, GALLERY_TILE, GALLERY_TILE); drawn = true; }
            catch (e) { drawn = false; }
        }
        if (!drawn) {
            fig.className = 'identity-gallery-tile is-missing';
            fig.querySelector('.identity-gallery-blank').textContent = 'no frame';
            return;
        }
        // the crop again at up to the enlarged size, for the hover preview — no
        // larger than the video's own pixels, which would only be scaled up
        var bigSide = Math.max(GALLERY_TILE, Math.min(Math.ceil(box.side), Math.round(GALLERY_ZOOM * pixelRatio())));
        var big = el('canvas');
        big.width = big.height = bigSide;
        var bctx = big.getContext('2d');
        bctx.fillStyle = '#000'; bctx.fillRect(0, 0, bigSide, bigSide);
        try { bctx.drawImage(img, box.x, box.y, box.side, box.side, 0, 0, bigSide, bigSide); } catch (e) { big = null; }
        // this animal's keypoints as small dots in its colour: which one the row means when two share a crop
        drawSampleDots(ctx, pts, box, GALLERY_TILE, r.color, 1.6);
        if (big) {
            fig._zoom = { kind: 'sample', w: GALLERY_ZOOM, h: GALLERY_ZOOM, color: r.color, frame: frame,
                label: r.id.name + ' · ' + fmtTime(frame) + ' · ' + cam + ' — click to go to this frame',
                draw: (function (src, pts, box, color) {
                    return function (ctx, w, h) { ctx.drawImage(src, 0, 0, w, h); drawSampleDots(ctx, pts, box, w, color, 3); };
                })(big, pts, box, r.color) };
            fig.removeAttribute('title');   // the preview says it; a native tooltip would cover it
            fig.addEventListener('mouseenter', zoom.show.bind(null, fig));
            fig.addEventListener('mouseleave', zoom.hide);
        }
        var sz = imageSize(img);
        c.setAttribute('data-source', sz[0] + 'x' + sz[1]);
        fig.replaceChild(c, fig.querySelector('.identity-gallery-blank'));
        fig.className = 'identity-gallery-tile';
        if (r.color) fig.style.borderColor = r.color;
    };

    // Every sample's image, one queue per decoder: a decoder is asked for one frame
    // at a time, in frame order, while the cameras' queues run side by side. Each
    // fetch is a seek and a decode (~0.1 s on local disk, far more over a network);
    // one after another, the 25 of five identities took ~2.3 s on an 8-camera
    // project, now about the busiest camera's share.
    var fetchSamples = function (jobs) {
        var byView = new Map();
        jobs.forEach(function (j) {
            var q = byView.get(j.view);
            if (!q) byView.set(j.view, q = []);
            q.push(j);
        });
        return Promise.all(Array.from(byView.values()).map(async function (q) {
            q.sort(function (a, b) { return a.frame - b.frame; });
            for (var k = 0; k < q.length; k++) {
                if (!alive()) return;
                var got = null;
                try { got = await galleryFrame(q[k].view, q[k].frame); } catch (e) { got = null; }
                if (!alive()) { releaseFrame(got); return; }
                try { drawSample(q[k], got && got.img); }
                catch (e) { console.warn('[identity-gallery] ' + q[k].r.id.name + ':', e); }
                releaseFrame(got);   // drawSample copied the crop (tile + preview): nothing keeps it
            }
        }));
    };

    var done = (async function () {
        await new Promise(function (res) { setTimeout(res, 0); });   // the box paints first
        if (!alive()) return;
        // in slices, the page painting between them (~50 ms in all on a large project)
        tracks = await identityTracksAsync(session, function () { return new Promise(function (res) { setTimeout(res, 0); }); });
        if (!alive()) return;
        rows = rows.filter(function (r) {
            if (tracks.has(r.id.id)) return true;
            r.el.remove();
            return false;
        });
        if (rows.length < 2) {
            section.remove();
            if (opts.onEmpty) opts.onEmpty();
            return;
        }
        await drawMaps(select ? select.value : mapCam);
        if (!alive()) return;
        // The samples land on keyframes where they can (one decoded frame each,
        // not up to a keyframe gap's worth): the keyframes of one camera, read
        // once per video from its index — campy's cameras share them, and a camera
        // that did not would only decode slower, never show the wrong frame.
        var keyframes = await sampleKeyframes(viewFor(mapCam) || (state.views || []).filter(function (v) { return v && v.decoder; })[0]);
        if (!alive()) return;
        var jobs = [];
        for (var i = 0; i < rows.length; i++) {
            try { jobs = jobs.concat(planRow(rows[i], keyframes)); }
            catch (e) { console.warn('[identity-gallery] ' + rows[i].id.name + ':', e); }
        }
        await fetchSamples(jobs);
    })();
    return { done: done, element: section };
}
