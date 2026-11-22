/**
 * multi-camera-review.js — the review list multi-camera Track All leaves in the
 * ID Switches tab: the places a switch is most likely, as unscored rows, as
 * single-camera Track All does (pose/single-camera-tracking.js `reviewResult`).
 *
 * The rows, all label-free, read from the committed 3D groups
 * (`session.instanceGroups`, never evicted on a lazy project):
 *  - **'crossing'** — two identities whose 3D paths nearly cross: at a frame where
 *    both have a group, pairing each with the other's previous sighting (at most
 *    `gapFrames` back) costs almost what the kept pairing does, by centroid
 *    distance: (swapped − kept) / (swapped + kept) < `margin`. One row per pair
 *    per run of them no more than `clusterSeconds` apart (`candidateMoments`).
 *  - **'videoStart'** — where every identity is first in view together, unless a
 *    row's clip shows that frame (`videoStartRow`).
 *  - **'videoEnd'** — at the last tracked frame, unless a row ends within 5 s
 *    (`videoEndRow`).
 * And `pairEncounters3d`, what the tab's "◂ Earlier encounter" steps back through
 * on a multi-camera session: the pair's close encounters by 3D centroid distance.
 *
 * Why these (measured 2026-11-16, MODULES.md): the app's own Track All on the 22
 * proofread SLAP sessions (8 cameras), the list played by the single-camera study's
 * simulated reviewer (2 s before to 5 s after each row, stepping back through the
 * pair's encounters): mean accuracy 88.21% -> 99.69%, 0.88 rows a minute, 11
 * sessions better, none worse. Close encounters themselves cover 45–97% of those
 * videos, so they are not rows.
 *
 * Pure — no DOM, no app state.
 */

import { candidateMoments, videoStartRow, videoEndRow, PAIR_ENCOUNTER_DEFAULTS } from './single-camera-tracking.js?v=34600b38020d';

/** The near-cross rows' settings: margin (scale-free), previous sighting at most `gapFrames` back, clusters. */
export const MULTI_CAMERA_REVIEW_DEFAULTS = Object.freeze({ margin: 0.01, gapFrames: 5, clusterSeconds: 3 });

/** Mean of a group's finite 3D nodes, or null. Reads flat (3N) or boxed points3d. */
function groupCentroid(g) {
    var P = g && g.points3d;
    if (!P) return null;
    var x = 0, y = 0, z = 0, n = 0, flat = typeof P[0] === 'number';
    var K = flat ? Math.floor(P.length / 3) : P.length;
    for (var k = 0; k < K; k++) {
        var a, b, c;
        if (flat) { a = P[3 * k]; b = P[3 * k + 1]; c = P[3 * k + 2]; }
        else { var p = P[k]; if (!p) continue; a = p[0]; b = p[1]; c = p[2]; }
        if (!(a === a && b === b && c === c) || a == null) continue;
        x += a; y += b; z += c; n++;
    }
    return n ? [x / n, y / n, z / n] : null;
}

/** The largest distance between two finite nodes of a group, or 0. */
function groupExtent(g) {
    var P = g && g.points3d, pts = [];
    if (!P) return 0;
    var flat = typeof P[0] === 'number', K = flat ? Math.floor(P.length / 3) : P.length;
    for (var k = 0; k < K; k++) {
        var p = flat ? [P[3 * k], P[3 * k + 1], P[3 * k + 2]] : P[k];
        if (p && p[0] === p[0] && p[1] === p[1] && p[2] === p[2] && p[0] != null) pts.push(p);
    }
    var m = 0;
    for (var i = 0; i < pts.length; i++) for (var j = i + 1; j < pts.length; j++) {
        var d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]);
        if (d > m) m = d;
    }
    return m;
}

/**
 * The tracked identities per frame, from the committed groups: `frames` ([{frameIdx}], ascending), `out` (the
 * identities per frame) and `cen` (each one's 3D centroid or null), index-aligned as `videoStartRow` /
 * `videoEndRow` / `candidateMoments` read them. Groups without an identity are left out.
 */
export function identityTrack(session) {
    var frames = [], out = [], cen = [];
    var keys = Array.from((session && session.instanceGroups) ? session.instanceGroups.keys() : []).sort(function (a, b) { return a - b; });
    keys.forEach(function (f) {
        var ids = [], cs = [];
        (session.instanceGroups.get(f) || []).forEach(function (g) {
            if (g.identityId == null || g.identityId < 0) return;
            ids.push(g.identityId); cs.push(groupCentroid(g));
        });
        if (!ids.length) return;
        frames.push({ frameIdx: f }); out.push(ids); cen.push(cs);
    });
    return { frames: frames, out: out, cen: cen };
}

/** Near-crossings of two identities' 3D paths (see the module doc): [{f, a, b, cue: 'crossing'}], ids as stored. */
export function crossingCandidates(track, opts) {
    var o = Object.assign({}, MULTI_CAMERA_REVIEW_DEFAULTS, opts || {});
    var last = new Map(), res = [];
    var d3 = function (p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
    for (var p = 0; p < track.frames.length; p++) {
        var f = track.frames[p].frameIdx, ids = track.out[p], cs = track.cen[p];
        for (var i = 0; i < ids.length; i++) for (var j = i + 1; j < ids.length; j++) {
            var A = ids[i], B = ids[j], la = last.get(A), lb = last.get(B);
            if (!cs[i] || !cs[j] || !la || !lb || f - la.f > o.gapFrames || f - lb.f > o.gapFrames) continue;
            var kept = d3(cs[i], la.c) + d3(cs[j], lb.c), swapped = d3(cs[i], lb.c) + d3(cs[j], la.c);
            if ((swapped - kept) / (swapped + kept + 1e-9) < o.margin) res.push({ f: f, a: Math.min(A, B), b: Math.max(A, B), cue: 'crossing' });
        }
        for (var q = 0; q < ids.length; q++) if (cs[q]) last.set(ids[q], { f: f, c: cs[q] });
    }
    return res;
}

/**
 * The review list's moments for a multi-camera session after Track All: the near-crossing rows, then the check
 * rows where every identity is first in view and at the end, sorted by frame. Shape as single-camera Track All's
 * `review` (`{frame, startFrame, identityA, identityB, cues}`), for `reviewResult`.
 */
export function multiCameraReview(session, fps, opts) {
    var o = Object.assign({}, MULTI_CAMERA_REVIEW_DEFAULTS, opts || {}), rate = fps || 30;
    var track = identityTrack(session);
    if (!track.frames.length) return [];
    var noInput = track.out.map(function () { return []; });
    var review = candidateMoments(track.frames, track.out, noInput, [], { trackletGapFrames: 0, clusterSeconds: o.clusterSeconds },
        rate, crossingCandidates(track, o));
    var endRow = videoEndRow(track.frames, track.out, review, rate);
    if (endRow) review.push(endRow);
    var startRow = videoStartRow(track.frames, track.out, review, rate);
    if (startRow) review.push(startRow);
    return review.sort(function (x, y) { return x.frame - y.frame || x.identityA - y.identityA || x.identityB - y.identityB; });
}

var _bodyCache = new WeakMap();
/** A multi-camera session's 3D body length: the median of `groupExtent` over ~5,000 groups sampled evenly. */
export function sessionBodyLength3d(session) {
    var c = _bodyCache.get(session), n = session && session.instanceGroups ? session.instanceGroups.size : 0;
    if (c && c.n === n) return c.body;
    var all = [];
    if (n) session.instanceGroups.forEach(function (gs) { (gs || []).forEach(function (g) { if (g.points3d) all.push(g); }); });
    var every = Math.max(1, Math.floor(all.length / 5000)), ext = [];
    for (var i = 0; i < all.length; i += every) { var e = groupExtent(all[i]); if (e > 0) ext.push(e); }
    ext.sort(function (x, y) { return x - y; });
    var body = ext.length ? ext[ext.length >> 1] : 0;
    _bodyCache.set(session, { n: n, body: body });
    return body;
}

/**
 * The close encounters of identities `idA` and `idB` on frames [from, to] of a multi-camera session: runs of
 * frames where their groups' 3D centroids are within `closeBody` body lengths (`sessionBodyLength3d`), joined
 * across gaps of up to `gapSeconds` — the 3D counterpart of single-camera `pairEncounters`, with its defaults.
 * Read from the current labels (so after a Fix too).
 * @returns {Array<{start: number, end: number}>} ascending
 */
export function pairEncounters3d(session, idA, idB, from, to, opts) {
    if (!session || !session.instanceGroups || idA == null || idB == null) return [];
    var o = Object.assign({}, PAIR_ENCOUNTER_DEFAULTS, opts || {});
    var body = sessionBodyLength3d(session);
    if (!(body > 0)) return [];
    var lim = o.closeBody * body, gap = Math.round(o.gapSeconds * (o.fps || session.fps || 30)), runs = [];
    var keys = Array.from(session.instanceGroups.keys()).filter(function (f) { return f >= from && f <= to; }).sort(function (a, b) { return a - b; });
    for (var i = 0; i < keys.length; i++) {
        var f = keys[i], A = null, B = null;
        (session.instanceGroups.get(f) || []).forEach(function (g) {
            if (g.identityId === idA && !A) A = groupCentroid(g);
            else if (g.identityId === idB && !B) B = groupCentroid(g);
        });
        if (!A || !B || !(Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) < lim)) continue;
        var run = runs[runs.length - 1];
        if (run && f - run.end <= gap + 1) run.end = f;
        else runs.push({ start: f, end: f });
    }
    return runs;
}
