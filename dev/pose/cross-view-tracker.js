/**
 * cross-view-tracker.js — `CrossViewTracker`, LUCID's cross-view 3D tracker.
 *
 * Adapted from the `CrossViewTracker` written by Liezl Maree in the
 * talmolab/sleap-3d repository (Python) and reimplemented here in JavaScript.
 *
 * A re-implementation of the cross-view 3D multi-target tracker from
 * `/root/vast/eric/sleap-3d/sleap_3d/tracker.py` (`CrossViewTracker`, L1158).
 * It associates per-camera 2D detections to a running list of 3D targets, one
 * camera-view at a time, via Hungarian assignment on a cost that sums a 2D
 * reprojection term and a 3D point-to-ray term. There is still NO Kalman filter
 * and NO velocity model, matching the reference — but as of 2026-08-14 it is no
 * longer a byte-faithful port: see "THE STALE-ANCHOR FIX" below.
 *
 * Coordinate conventions (verified against sleap_3d/geometry.py + geometry_legacy.py):
 *   - The tracker works entirely in NORMALIZED camera coordinates. 2D detections
 *     are undistorted and K^-1-applied on ingest (== cv2.undistortPoints without
 *     a P matrix). See `normalizePoint`.
 *   - The "projection matrix" is the camera's bare 3x4 extrinsic [R|t] (no K).
 *     LUCID's Camera exposes this as `camera.extrinsicMatrix`.
 *   - `distance_threshold` is in world units (mm); `velocity_threshold` is in
 *     normalized image units (so the 2D term is near-saturated and the 3D term
 *     dominates — which is why `correspondence_weight_3d` is the meaningful knob).
 *
 * -----------------------------------------------------------------------
 * THE STALE-ANCHOR FIX (2026-08-14) — no longer a byte-faithful port
 * -----------------------------------------------------------------------
 * The reference `Target` keeps exactly one detection per camera FOREVER — a
 * `detsByCam` entry is only ever overwritten, never expired — and re-fuses
 * whatever it is holding into `points3d` by mutating the SHARED target list
 * mid-frame, one camera's Hungarian at a time. Two consequences, both measured
 * on real multi-view rodent corpora (`talmolab/luc3d@eric/figs`,
 * `figs/fig8-bench/xv_experimental.js`, methods M1 `sync` / `stale`):
 *   1. After an occlusion, an animal's target keeps a 3D pose frozen at wherever
 *      it was last seen, indefinitely. On re-entry, the surviving animal's OWN
 *      detection can sit closer to that frozen ghost than to its own
 *      (correctly-tracking) target, so the two identities permanently swap —
 *      and nothing downstream can detect it, because both targets stay
 *      internally consistent with their (now-swapped) detections.
 *   2. Because one camera's match mutates `points3d` before the next camera in
 *      the same frame is scored, a single frame runs a Gauss-Seidel update
 *      instead of a Jacobi one: camera 2's assignment is judged against a state
 *      camera 1 already perturbed this same frame, not against where the frame
 *      actually started.
 * Fixed by two changes, both gated behind hyperparameters and both verified
 * additive (empty/zero config reproduces the pre-fix tracker exactly):
 *   - **`stale` (frames, default 20)** — at the start of each frame, evict any
 *     `detsByCam` entry older than `stale` frames, BEFORE that frame's
 *     association runs. A target can no longer be re-triangulated from one
 *     fresh view fused with four ancient ones.
 *   - **Frame-synchronous association ("sync", unconditional, no flag)** — a
 *     target's `points3d` is no longer mutated mid-frame. Every camera's
 *     Hungarian this frame is scored against the SAME state (however it stood
 *     at frame start); the one, single re-fuse happens once, after every
 *     camera has been processed. Implemented by deferring `_retriangulate()`
 *     to `_endFrame()` rather than a separate frozen-snapshot field, so a
 *     target's `points3d` is always live and directly readable outside the
 *     `trackFrame()` call (`_adjacency2d`/`_adjacency3d` still take a `target`
 *     and read `target.points3d`/`target.detsByCam` directly when called
 *     outside a frame — e.g. from tests — for exactly this reason).
 * Measured on the validated recommended configuration (`stale: 20` +
 * `distanceThreshold: 25`, `corr3dWeight` unchanged at 6): BMimica cross-view
 * IDF1 switches 2,071 → 413 (50 sessions); SLAP-2M within-view (42 multi-animal
 * sessions, predictions pool) switches 3,094 → 1,312, IDF1 0.7040 → 0.7212. Full
 * derivation: `figs/out/tmp/corr12_run.log` and the manuscript pick-up notes in
 * the `talmolab/luc3d@eric/figs` worktree (2026-08-13/14).
 *
 * -----------------------------------------------------------------------
 * THE MATCH GATE (2026-10-03) — a second divergence from the reference
 * -----------------------------------------------------------------------
 * The reference Hungarian gives every target a detection whenever a view has
 * at least as many detections as there are targets, however bad the match:
 * `velocity_threshold` / `distance_threshold` only drive the adjacency
 * negative, they never reject. So one extra detection (a reflection in the
 * arena wall) plus one target with nothing real to follow (a spare target
 * left over from an earlier false birth) is enough for the solver to trade a
 * correct match away. Measured on a real 5-mouse, 8-camera recording
 * (194366_05mice_flippers, frame 3,620, Camera4_topR): the spare target's
 * forced match was cheapest on the real mouse (-26.7) while that mouse's own
 * target scored +55.9 on it, and the reflection scored about -600 for both.
 * Summed, giving the mouse to the spare and its own target the reflection
 * won by ~21, and the mouse's identity moved to the reflection and stayed
 * there.
 * `matchGate` (default OFF since 2026-10-07, #285: it helps SLAP but gave ~6x the
 * ID switches on Mouse-Dyad-10M and ~10x on s-DANNCE; 1 = on, 0 = the pre-gate
 * tracker exactly) splits each view's assignment into two stages:
 *   1. **Tracked targets** (still holding a detection after stale eviction)
 *      are matched with one "no match" option each at adjacency 0, so a
 *      tracked target only takes a detection it scores POSITIVELY on — i.e.
 *      within roughly `distanceThreshold` of where it is — and never has to
 *      take a bad one to make the totals work.
 *   2. **Lost targets** (every detection evicted as stale — the animal was
 *      unseen for `stale` frames) then compete for the leftovers exactly as
 *      before, forced. That is how an animal that vanished and reappeared
 *      elsewhere is re-acquired; gating them too would orphan it for good.
 *
 * -----------------------------------------------------------------------
 * MISPLACED NODES (2026-10-20) — three opt-in changes, all off by default
 * -----------------------------------------------------------------------
 * Ported from campy's live port of this tracker (olinesn/campy#85). When the
 * 2D model puts a node in the wrong place, that node triangulates far from its
 * animal — on a 3-camera rig with a model trained elsewhere, 5% of target
 * nodes were over 2 m away (the cage is 0.44 m) — and the per-node 3D term
 * `corr3d * (1 - d / distanceThreshold)` has no floor, so that one node's term
 * differs by thousands between detections while a good node's differs by
 * tens: it alone decides the Hungarian, the target takes the wrong detection,
 * and its next 3D is built from it.
 *   - **`maxPenalty`** (× corr3d; 0 = off): the per-node 3D term is never below
 *     `-maxPenalty × corr3d`. 4 = flat beyond 5 × distanceThreshold.
 *   - **`matchReproj`** (px; 0 = off): the target's `match3d` — what the cost
 *     terms read — is `points3d` solved again so every node's views agree
 *     within it (`checkedPoints3d`). `points3d`, written to the groups, stays
 *     the plain DLT.
 *   - **`birthMedian`** (0/1): births pair detections by the MEDIAN epipolar
 *     distance over nodes instead of the mean.
 * Measured with an exact offline replay of Track All (8 cameras): on 22
 * proofread SLAP sessions, maxPenalty 4 + matchReproj 20 took lasting
 * identity switches 360 → 168 and mean accuracy 88.2% → 90.5% (every
 * combination of 1–8 and 10–40 px halved the switches), but on the 5-mouse
 * recording no combination beat the default (4 lasting relabels → 4–14).
 * With 3 of the cameras at a time (3 triples × 22 sessions) the gain was
 * larger: switches 1,598 → 704, mean accuracy 82.8% → 89.8%. birthMedian
 * changed nothing, with 8 cameras or 3. Hence opt-in.
 *
 * Faithful-port quirks still preserved from the reference (do NOT "fix" these
 * without new measurement — they were not implicated by the fig8-bench search):
 *   - `velocity_threshold` / `distance_threshold` are SOFT (drive the cost term
 *     negative), not hard gates. With `matchGate` off, negative-cost matches
 *     are not filtered out; with it on, see "THE MATCH GATE" above.
 *   - The 3D term ignores the time gap (Δt forced to 0 in the reference).
 *   - 3D velocity is zero (no motion prediction); re-triangulation is plain DLT
 *     over all of a target's (now freshness-filtered) per-view detections.
 *
 * Depends on: pose/triangulation.js, reused directly by passing the bare
 * extrinsic + normalized points.
 *
 * ## THE GEOMETRY MUST BE COORDINATE-AGNOSTIC, AND ONE PIECE OF IT WAS NOT
 *
 * Both cost terms are geometric GIVEN `target.points3d`: `_adjacency2d`
 * projects that 3D into the view and measures normalized-pixel distance,
 * `_adjacency3d` measures point-to-ray distance in mm. `reprojectPoint`,
 * `backProjectToRays`, `pointsToRayDistances` and `epipolarErrorMatrix` are all
 * invariant to a rigid change of world frame (the fundamental matrix is the
 * relative pose, invariant to 1e-19 under a re-base). So `points3d` is the ONLY
 * frame-dependent input — and `_retriangulate` builds it with plain DLT, which
 * until the fix in `triangulatePointDLT` was NOT invariant: minimizing an
 * algebraic error under `‖x‖ = 1` on a homogeneous 4-vector weights direction
 * against scale, so moving the origin moved the answer.
 *
 * `Set as New Calibration` moves it ~1.2 m. Measured on the real cage session
 * that shifted `points3d` by up to 15 mm, and since `_adjacency3d` divides
 * millimetre distances by `distanceThreshold` (default 1.0) that is a cost
 * swing of ~15 PER NODE — so 21% of frames came out grouped differently, three
 * times worse by reprojection, purely from swapping the calibration file.
 *
 * Keep it that way: anything added to the cost must be a function of the rays
 * and the pixels, or of `points3d`, and never of absolute world coordinates.
 * Note this path calls `triangulatePoints` (DLT) unconditionally — the
 * Settings "Refined" / `ba` method does NOT reach the tracker.
 */

// From the core, not ./triangulation.js (which re-exports them): that module pulls in
// the UI, and this one must load in a worker (pose/tracker-worker.js).
import {
    triangulatePoints,
    DltViewSystem,
    reprojectPoint,
    backProjectToRays,
    pointsToRayDistances,
    hungarianAlgorithm,
    computeFundamentalMatrix,
    epipolarErrorMatrix,
} from './triangulation-core.js?v=3c5cdc75dce6';
import { points3dNodeCount, readPoint3d } from './pose-data.js?v=3c5cdc75dce6';

// ---------------------------------------------------------------------------
// Normalized-coordinate helpers
// ---------------------------------------------------------------------------

// Undistort a distorted pixel point and map to normalized camera coords
// (K^-1 applied) — equivalent to cv2.undistortPoints(pt, K, dist) with no P.
export function normalizePoint(pt, cam) {
    if (pt == null) return null;
    var u = cam.undistortPoint(pt);   // undistorted pixels
    var K = cam.matrix;
    return [(u[0] - K[0][2]) / K[0][0], (u[1] - K[1][2]) / K[1][1]];
}

// Project a 3D world point into normalized image coords via the bare extrinsic.
function projectNorm(p3, extrinsic) {
    return reprojectPoint(p3, extrinsic);   // homogeneous P·[x,y,z,1]/w, coord-agnostic
}

// ---------------------------------------------------------------------------
// Detection — one 2D observation in one camera at one frame
// ---------------------------------------------------------------------------

export function Detection(instance, cam, frameIdx, slot) {
    this.instance = instance;                          // ref to the LUCID Instance
    this.cam = cam;                                    // Camera (has extrinsicMatrix, name, matrix)
    this.frameIdx = frameIdx;
    this.slot = slot;                                  // detection index within (cam, frame)
    // Boxed snapshots taken ONCE per detection. `Instance` stores coords flat
    // (luc3d #189 follow-up #1); epipolarErrorMatrix and the matching loops below
    // want boxed rows, and a Detection is created once per (cam, frame, slot),
    // so materializing here is cheaper than converting at every read.
    this.pointsPixel = instance.toPointsArray();       // raw pixel keypoints ([x,y]|null)
    this.pointsNorm = this.pointsPixel.map(function (p) { return normalizePoint(p, cam); });
    this._rays = null;                                 // detectionRays' cache: back-projected rays...
    this._raysExt = null;                              // ...and the extrinsic they were cast with
}

// The detection back-projected to one ray per node (`backProjectToRays`), cast
// ONCE: the 3D term scores every target against the same detection, and the rays
// depend on the detection and its camera alone — recomputing them per target
// cost 4.9 s of a 67 s Track All (5 mice). Keyed on the extrinsic matrix object,
// which `Camera.setExtrinsics` replaces, so a moved camera recasts them. The
// result is only read (pointsToRayDistances), so sharing it changes nothing.
function detectionRays(det, ext) {
    if (det._rays === null || det._raysExt !== ext) {
        det._rays = backProjectToRays(det.pointsNorm, ext);
        det._raysExt = ext;
    }
    return det._rays;
}

// ---------------------------------------------------------------------------
// Target — a running 3D track fused from per-view detections
// ---------------------------------------------------------------------------

function Target(trackId) {
    this.trackId = trackId;
    this.detsByCam = new Map();   // camName -> Detection (one current det per view)
    this.points3d = null;         // Float64Array(3N) world coords, all-NaN = missing
    this.match3d = null;          // points3d with the reprojection check (matchReproj), or null = points3d
    this.identityId = null;       // filled at commit time
    this._touched = false;        // got a matched detection this frame (sync: re-fuse at frame end)
    this._snapMean = null;        // frame-start frameIdxMean() snapshot (sync); null outside a frame
    this._lost = false;           // no detection left at frame start (match gate: matched ungated)
    this._proj = null;            // targetProjection's cache: {p3, ext, pts}
}

// The target's 3D projected into one camera, per node — [x, y] normalized, or
// null where the node has no 3D — which the 2D term compares each of that view's
// detections against. Cached on the target and recomputed only when its points3d
// or the camera changes: points3d is only ever REPLACED (`_retriangulate`), never
// edited, and within a frame every view is scored against the same points3d (the
// sync fix), so this runs once per (target, view) rather than once per (target,
// detection). Same function on the same inputs, so the numbers are identical.
function targetProjection(target, ext) {
    var c = target._proj, p3 = matchPoints3d(target);
    if (c !== null && c.p3 === p3 && c.ext === ext) return c.pts;
    var n = points3dNodeCount(p3), pts = new Array(n), tp = [0, 0, 0];
    for (var k = 0; k < n; k++) pts[k] = readPoint3d(p3, k, tp) ? projectNorm(tp, ext) : null;
    target._proj = { p3: p3, ext: ext, pts: pts };
    return pts;
}

Target.prototype.frameIdxMean = function () {
    var s = 0, n = 0;
    this.detsByCam.forEach(function (d) { s += d.frameIdx; n++; });
    return n > 0 ? s / n : 0;
};

// Immediate fuse: used for births, where the target does not exist yet at
// frame start and so has nothing for `_endFrame` to defer.
Target.prototype.addDetection = function (det, matchReproj) {
    this.detsByCam.set(det.cam.name, det);
    this._retriangulate(matchReproj);
};

// Frame-synchronous fuse: record the match but defer `_retriangulate()` to
// `_endFrame()`, so every camera's Hungarian this frame sees the SAME
// `points3d` regardless of what earlier cameras in this frame matched.
Target.prototype._deferDetection = function (det) {
    this.detsByCam.set(det.cam.name, det);
    this._touched = true;
};

// `matchReproj` (px, 0 = off) is the tracker's: with it, `match3d` — what the
// next frame is matched against — is solved again with the reprojection check
// (`checkedPoints3d`). `points3d`, what Track All writes to the group, is the
// plain DLT either way.
Target.prototype._retriangulate = function (matchReproj) {
    var dets = Array.from(this.detsByCam.values());
    if (dets.length < 2) {
        // Single view: keep whatever we had (can't triangulate). Reference
        // creates targets only from >=2-view clusters, so this stays null until
        // a second view attaches.
        if (dets.length === 1 && this.points3d == null) this.points3d = null;
        return;
    }
    var exts = dets.map(function (d) { return d.cam.extrinsicMatrix; });
    var nNodes = dets[0].pointsNorm.length;
    var allObs = [];
    for (var k = 0; k < nNodes; k++) {
        allObs.push(dets.map(function (d) { return d.pointsNorm[k]; }));
    }
    this.points3d = triangulatePoints(allObs, exts);   // DLT, world coords
    this.match3d = matchReproj > 0
        ? checkedPoints3d(this.points3d, allObs, exts, dets, matchReproj)
        : null;
};

// The target's 3D the cost terms read: the checked solve when there is one.
function matchPoints3d(target) {
    return target.match3d != null ? target.match3d : target.points3d;
}

// One view's reprojection error of the point (x, y, z), in undistorted pixels:
// the normalized offset scaled by that camera's focal lengths. `E` holds every
// view's bare extrinsic, flat (12 per view, row-major), and its fx, fy at
// 12V + 2v — copied once per call by `checkedPoints3d`, so the hot loops read
// one typed array instead of nested ones. The projection is `reprojectPoint`'s
// [u / w, v / w], unboxed (the same expressions, so the same bits). A
// non-finite error counts as Infinity.
function viewError(x, y, z, o, E, V, v) {
    var b = 12 * v;
    var u = E[b] * x + E[b + 1] * y + E[b + 2] * z + E[b + 3];
    var t = E[b + 4] * x + E[b + 5] * y + E[b + 6] * z + E[b + 7];
    var w = E[b + 8] * x + E[b + 9] * y + E[b + 10] * z + E[b + 11];
    var dx = (u / w - o[0]) * E[12 * V + 2 * v], dy = (t / w - o[1]) * E[12 * V + 2 * v + 1];
    var e = Math.sqrt(dx * dx + dy * dy);
    return isFinite(e) ? e : Infinity;
}

// The worst `viewError` over the views with `use[v]` set, or -1 when it uses
// none, taken in the order `ord[0..V-1]` and each written to `errOut[v]`.
// Returns as soon as the worst so far reaches `bound`: the caller only asks
// whether the max is below `bound`, and the views not yet seen cannot lower a
// max. The order changes nothing else — a max is the same whatever order it
// is taken in — but `checkedPoints3d` passes the views worst-first, so a trial
// that kept the bad view stops at the first one it looks at. No allocation:
// this runs once per view left out, per round, per node over the threshold.
function worstViewError(x, y, z, obs, E, V, use, ord, bound, errOut) {
    var m = -1;
    for (var i = 0; i < V; i++) {
        var v = ord[i];
        if (!use[v]) continue;
        var e = errOut[v] = viewError(x, y, z, obs[v], E, V, v);
        if (e > m) {
            m = e;
            if (m >= bound) return m;
        }
    }
    return m;
}

// `ord[0..V-1]` = the views, by `err[v]` descending (unused views last).
function orderWorstFirst(err, use, V, ord) {
    for (var i = 0; i < V; i++) {
        var v = i, ev = use[v] ? err[v] : -Infinity, j = i;
        while (j > 0 && (use[ord[j - 1]] ? err[ord[j - 1]] : -Infinity) < ev) { ord[j] = ord[j - 1]; j--; }
        ord[j] = v;
    }
}

// Whether any view with `use[v]` set is over `thresh` — the same answer as
// `worstViewError(...) > thresh`, stopping at the first such view.
function anyViewOver(x, y, z, obs, E, V, use, thresh) {
    for (var v = 0; v < V; v++) {
        if (use[v] && viewError(x, y, z, obs[v], E, V, v) > thresh) return true;
    }
    return false;
}

// The smallest double above `x`, for an error in pixels (finite, >= +0), so
// `m >= nextUp(x)` is exactly `m > x`: one more in the bit pattern.
var _nuF = new Float64Array(1), _nuW = new Uint32Array(_nuF.buffer);
var _nuLo = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 0 : 1;   // little-endian: low word first
function nextUp(x) {
    if (!(x >= 0 && x < Infinity)) return x;
    _nuF[0] = x;
    if (_nuW[_nuLo] === 0xffffffff) { _nuW[_nuLo] = 0; _nuW[1 - _nuLo]++; } else _nuW[_nuLo]++;
    return _nuF[0];
}

// One DLT system and one scratch set for `checkedPoints3d`, reused: the
// tracker runs one target at a time.
var _checkSystem = new DltViewSystem();
var _checkScratch = null;
function checkScratch(V) {
    if (_checkScratch == null || _checkScratch.use.length < V) {
        var n = Math.max(8, 2 * V);
        _checkScratch = {
            use: new Uint8Array(n), E: new Float64Array(14 * n), ord: new Int32Array(n),
            err: new Float64Array(n), trialErr: new Float64Array(n), bestErr: new Float64Array(n),
        };
    }
    return _checkScratch;
}

// `points3d` solved again so that every node's views agree within `thresh` px
// (campy's TriangulateChecked, olinesn/campy#85). While a node's worst view is
// over it and it has more than 2 views, it loses the view WITHOUT which its
// other views fit best — the DLT spreads one bad view's error over the rest,
// so the view with the largest error is not always the bad one. A node still
// over it with 2 views is dropped (NaN). A misplaced 2D node triangulates
// far from its animal, often metres away; matched against, that one node can
// decide which detection the target takes.
//
// Every result is bit-identical to solving each trial from scratch with
// `triangulatePointDLT` and keeping the first strict improvement in view-index
// order; only the work is less. The leave-one-view-out solves go through
// `DltViewSystem`, which forms each view's DLT rows once per node and only sums
// them per subset (see pose/triangulation-core.js), and the errors are taken
// worst view first so a losing trial stops at its first view (`worstViewError`).
// With maxPenalty 4 + matchReproj 20 that took the tracker from 5.1 to 4.0 s
// on the 4-mouse SLAP session 145420 (3.0 s with matchReproj off) and from
// 51 to 39 s on the 5-mouse recording (25.5 s off), identities unchanged.
function checkedPoints3d(points3d, allObs, exts, dets, thresh) {
    var out = new Float64Array(points3d), V = dets.length, sys = _checkSystem, sc = checkScratch(V);
    var use = sc.use, E = sc.E, ord = sc.ord, err = sc.err, X = [0, 0, 0], xt = [0, 0, 0];
    for (var v = 0; v < V; v++) {
        var P = exts[v], K = dets[v].cam.matrix;
        for (var r = 0; r < 3; r++) for (var c = 0; c < 4; c++) E[12 * v + 4 * r + c] = P[r][c];
        E[12 * V + 2 * v] = K[0][0]; E[12 * V + 2 * v + 1] = K[1][1];
        ord[v] = v;
    }
    for (var k = 0; k < allObs.length; k++) {
        var obs = allObs[k], n = 0;
        for (v = 0; v < V; v++) { use[v] = obs[v] != null ? 1 : 0; n += use[v]; }
        if (readPoint3d(points3d, k, X) == null) continue;        // already NaN
        var over = anyViewOver(X[0], X[1], X[2], obs, E, V, use, thresh);
        if (n > 2 && over) {
            sys.prepare(obs, exts);
            for (v = 0; v < V; v++) ord[v] = v;
            worstViewError(X[0], X[1], X[2], obs, E, V, use, ord, Infinity, err);
        }
        while (n > 2 && over) {
            orderWorstFirst(err, use, V, ord);
            // Leave out each view in turn and keep the trial whose worst view is
            // best; on a tie, the lowest view index (what trying them in index
            // order and keeping the first strict improvement gives). They are
            // TRIED worst view first, which is usually the winner, so every
            // trial after it can stop at its first view over that bound.
            var best = -1, bestErr = Infinity, bx = 0, by = 0, bz = 0;
            for (var i = 0; i < V; i++) {
                var drop = ord[i];
                if (!use[drop]) continue;
                use[drop] = 0;
                // a trial that cannot beat the best so far stops early; it loses
                // either way. It can win a tie only with a lower index.
                var bound = best >= 0 && drop < best ? nextUp(bestErr) : bestErr;
                var e = sys.solve(use, xt)
                    ? worstViewError(xt[0], xt[1], xt[2], obs, E, V, use, ord, bound, sc.trialErr)
                    : Infinity;
                use[drop] = 1;
                if (e < bestErr || (e === bestErr && best >= 0 && drop < best)) {
                    bestErr = e; best = drop; bx = xt[0]; by = xt[1]; bz = xt[2];
                    var tmp = sc.bestErr; sc.bestErr = sc.trialErr; sc.trialErr = tmp;   // it ran to the end
                }
            }
            if (best < 0) break;                                  // no solve without any one view
            use[best] = 0; n--;
            X[0] = bx; X[1] = by; X[2] = bz;
            over = bestErr > thresh;                              // the winning trial's own worst view
            for (v = 0; v < V; v++) err[v] = sc.bestErr[v];       // ...and its errors, to order the next round
        }
        if (over) {
            out[3 * k] = out[3 * k + 1] = out[3 * k + 2] = NaN;
        } else {
            out[3 * k] = X[0]; out[3 * k + 1] = X[1]; out[3 * k + 2] = X[2];
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// CrossViewTracker
// ---------------------------------------------------------------------------

export class CrossViewTracker {
    /**
     * @param {object} hp - hyperparameters (bench G_keeptrack_3d6 in parens):
     *   corr2dWeight (1.0), corr3dWeight (6.0), velocityThreshold (10),
     *   distanceThreshold (50), timePenalty (0.1).
     *   maxTargets (null) — DIVERGENCE FROM REFERENCE. The sleap_3d
     *   `CrossViewTracker` has NO target cap; births are unbounded and IDs are
     *   kept in check purely by upstream detection filtering. This LUCID-only
     *   opt-in caps the number of live targets so "Track All" can honor a
     *   user-supplied animal count. null (default) == faithful reference
     *   behavior; a positive integer stops births once that many targets exist.
     *   nodeWeights (null) — DIVERGENCE FROM REFERENCE. Per-node weight array
     *   (indexed to match the skeleton's nodes) from the Tracking Wizard. Each
     *   node's contribution to the 2D + 3D association cost is scaled by its
     *   weight; a weight of 0 drops the node from matching entirely. null
     *   (default) == every node weighted 1 (faithful reference behavior).
     *   stale (20) — THE STALE-ANCHOR FIX (see file header). Evict a target's
     *   per-camera detection once it is more than this many frames old, before
     *   that frame's association runs. 0 disables eviction (reproduces the
     *   pre-fix, unbounded-staleness reference behavior) for reproducibility/
     *   debugging; any positive number is floored to an integer.
     *   matchGate (0) — THE MATCH GATE (see file header). A tracked target only
     *   takes a detection it scores positively on; lost targets re-acquire
     *   ungated. 0 (the default since #285) is the pre-gate forced assignment.
     *   maxPenalty (0), matchReproj (0), birthMedian (0) — MISPLACED NODES (see
     *   file header). 0 = today's tracker exactly.
     */
    constructor(hp) {
        hp = hp || {};
        this.corr2d = num(hp.corr2dWeight, 1.0);
        this.corr3d = num(hp.corr3dWeight, 1.0);
        this.velThresh = num(hp.velocityThreshold, 1.0);
        this.distThresh = num(hp.distanceThreshold, 1.0);
        this.timePenalty = num(hp.timePenalty, 1.0);
        // LUCID extension (not in reference): cap live targets. null = uncapped.
        this.maxTargets = (typeof hp.maxTargets === 'number' && isFinite(hp.maxTargets)
            && hp.maxTargets > 0) ? Math.floor(hp.maxTargets) : null;
        // LUCID extension (not in reference): per-node association weights.
        // null = every node weighted 1.
        this.nodeWeights = Array.isArray(hp.nodeWeights) ? hp.nodeWeights : null;
        // Stale-anchor fix (see file header). Default 20; 0 = off (pre-fix behavior).
        this.stale = Math.max(0, Math.floor(num(hp.stale, 20)));
        // Match gate (see file header). Default off (#285); 1 = on.
        this.matchGate = num(hp.matchGate, 0) > 0;
        // Misplaced-node robustness (see file header). All three off by default.
        this.maxPenalty = Math.max(0, num(hp.maxPenalty, 0));
        this.matchReproj = Math.max(0, num(hp.matchReproj, 0));
        this.birthMedian = num(hp.birthMedian, 0) > 0;

        this.targets = [];                 // list of live Target
        this.unmatchedByCam = new Map();   // camName -> Detection[] (births buffer)
        this._nextTrackId = 0;
        this._fCache = {};                 // "camA:camB" -> fundamental matrix
        this._frame = null;                // current frame index, for staleness eviction
    }

    /**
     * Process one frame. `detsByCam` is Map(camName -> Detection[]); `camsOrder`
     * is the array of Camera processed in sequence (mirrors the reference, which
     * associates one view at a time within a frame).
     */
    trackFrame(detsByCam, camsOrder) {
        this._beginFrame(detsByCam, camsOrder);
        for (var ci = 0; ci < camsOrder.length; ci++) {
            var cam = camsOrder[ci];
            var dets = detsByCam.get(cam.name) || [];
            // clear_unmatched_detections(view): drop this view's stale leftovers
            // before re-populating them this frame.
            this.unmatchedByCam.set(cam.name, []);
            this._trackView(dets, cam);
        }
        this._endFrame();
    }

    // Stale-anchor fix, part 1: evict per-camera detections this target has not
    // seen fresh in `stale` frames, before this frame's association runs. The
    // frame index is derived from the detections themselves (no frame counter
    // is threaded through the call site) — the max frameIdx seen this call, or
    // one past the previous frame if this call carries no detections at all.
    _beginFrame(detsByCam, camsOrder) {
        var f = null;
        for (var ci = 0; ci < camsOrder.length; ci++) {
            var list = detsByCam.get(camsOrder[ci].name) || [];
            for (var i = 0; i < list.length; i++) {
                if (f == null || list[i].frameIdx > f) f = list[i].frameIdx;
            }
        }
        if (f == null) f = (this._frame == null ? 0 : this._frame + 1);
        this._frame = f;

        var cutoff = this.stale > 0 ? f - this.stale : null;
        for (var t = 0; t < this.targets.length; t++) {
            var tg = this.targets[t];
            if (cutoff != null) {
                var drop = [];
                tg.detsByCam.forEach(function (d, name) {
                    if (d.frameIdx < cutoff) drop.push(name);
                });
                for (var k = 0; k < drop.length; k++) tg.detsByCam.delete(drop[k]);
            }
            // Sync fix: freeze the mean this frame's dt is measured against, so a
            // camera processed later this frame doesn't see a mean already moved
            // by an earlier camera's match this same frame.
            tg._snapMean = tg.frameIdxMean();
            // Match gate: a target with nothing left to anchor it is "lost" for
            // the whole frame, even once an earlier camera re-acquires it.
            tg._lost = tg.detsByCam.size === 0;
        }
    }

    // Stale-anchor fix, part 2 (frame-synchronous association): re-fuse every
    // target touched this frame exactly once, after all cameras have been
    // processed, instead of mid-frame inside `_trackView`.
    _endFrame() {
        for (var t = 0; t < this.targets.length; t++) {
            var tg = this.targets[t];
            if (tg._touched) tg._retriangulate(this.matchReproj);
            tg._touched = false;
            tg._snapMean = null;
            tg._lost = false;
        }
    }

    _trackView(dets, cam) {
        var N = this.targets.length, M = dets.length;
        var matchedDet = new Array(M).fill(false);

        if (N > 0 && M > 0) {
            if (!this.matchGate) {
                this._assign(this.targets, dets, cam, matchedDet, false);
            } else {
                // Match gate (see file header): tracked targets first, gated;
                // lost targets then take what is left, forced, as before.
                var tracked = [], lost = [];
                for (var t = 0; t < N; t++) {
                    (this.targets[t]._lost ? lost : tracked).push(this.targets[t]);
                }
                this._assign(tracked, dets, cam, matchedDet, true);
                this._assign(lost, dets, cam, matchedDet, false);
            }
        }

        // Unmatched detections in this view accumulate for cross-view birth.
        var leftover = [];
        for (var m = 0; m < M; m++) if (!matchedDet[m]) leftover.push(dets[m]);
        this.unmatchedByCam.set(cam.name, leftover);

        this._initializeTargets();
    }

    // One Hungarian over `targets` × this view's still-unmatched detections.
    // adjacency[t][d] = 2D term + 3D term (higher = better), negated for LUCID's
    // minimizing Hungarian (== maximize adjacency). Ungated, every target takes
    // a detection while any are free (reference behavior). Gated, each target
    // also gets a "no match" column at adjacency 0, so it takes a detection only
    // when that raises the total — i.e. never one it scores at or below 0.
    _assign(targets, dets, cam, matchedDet, gated) {
        var cols = [];
        for (var d = 0; d < dets.length; d++) if (!matchedDet[d]) cols.push(d);
        var N = targets.length, M = cols.length;
        if (N === 0 || M === 0) return;
        var width = gated ? M + N : M;
        var cost = [];
        for (var t = 0; t < N; t++) {
            cost[t] = new Array(width).fill(0);   // gated "no match" columns stay 0
            for (var c = 0; c < M; c++) {
                cost[t][c] = -this._adjacency(targets[t], dets[cols[c]], cam);
            }
        }
        var assign = hungarianAlgorithm(cost);   // assign[t] = column, or out-of-range
        for (var ti = 0; ti < N; ti++) {
            var ci = assign[ti];
            if (ci == null || ci < 0 || ci >= M) continue;   // unmatched / "no match"
            if (gated && !(cost[ti][ci] < 0)) continue;      // tie at 0 or NaN: not a match
            // Sync fix: record the match now but defer re-triangulation to
            // _endFrame(), so a later camera THIS frame is scored against
            // the same points3d an earlier camera this frame was.
            targets[ti]._deferDetection(dets[cols[ci]]);
            matchedDet[cols[ci]] = true;
        }
    }

    // Cost = adjacency_2d + adjacency_3d (reference `set_adjacency_matrix`).
    // Sync fix: `_snapMean` is the frame-start snapshot when called from inside
    // trackFrame()/_trackView(); it is null outside that lifecycle (e.g. a test
    // calling this directly), in which case the live mean is used, unchanged
    // from before the fix.
    _adjacency(target, det, cam) {
        var mean = target._snapMean != null ? target._snapMean : target.frameIdxMean();
        var dt = det.frameIdx - mean;
        return this._adjacency2d(target, det, dt) + this._adjacency3d(target, det, cam);
    }

    // Per-node association weight (LUCID extension). null weights ⇒ 1 for every
    // node; a missing/out-of-range entry also defaults to 1.
    _nodeWeight(k) {
        if (this.nodeWeights == null) return 1;
        var w = this.nodeWeights[k];
        return (typeof w === 'number' && isFinite(w)) ? w : 1;
    }

    // 2D term (reference Eq.2). prev = target projected into this view (normalized).
    _adjacency2d(target, det, dt) {
        if (target.points3d == null) return 0;
        var ext = det.cam.extrinsicMatrix;
        var decay = Math.exp(-this.timePenalty * dt);
        var sum = 0;
        var projs = targetProjection(target, ext);              // once per (target, view), not per detection
        var n = Math.min(projs.length, det.pointsNorm.length);
        for (var k = 0; k < n; k++) {
            var w = this._nodeWeight(k);
            if (w === 0) continue;                               // node dropped from matching
            var dp = det.pointsNorm[k], proj = projs[k];
            if (dp == null || proj === null) continue;           // np.nansum skips NaN
            var dx = dp[0] - proj[0], dy = dp[1] - proj[1];
            var distance = Math.sqrt(dx * dx + dy * dy);
            if (!isFinite(distance)) continue;                   // np.nansum: skip degenerate
            var velocity = distance / (this.velThresh * (1 + dt));
            var correspondence = this.corr2d * (1 - velocity);   // may go negative
            sum += w * correspondence * decay;
        }
        return sum;
    }

    // 3D term (reference Eq.4). Back-project the detection to rays; measure the
    // target's per-node distance to those rays. Δt forced to 0 (reference quirk).
    _adjacency3d(target, det, cam) {
        if (target.points3d == null) return 0;
        var ext = det.cam.extrinsicMatrix;
        var ray = detectionRays(det, ext);                       // origin + per-node dirs, cast once per detection
        var dists = pointsToRayDistances(matchPoints3d(target), ray.origin, ray.directions);
        var floor = this.maxPenalty > 0 ? -this.maxPenalty : -Infinity;
        var sum = 0;
        for (var k = 0; k < dists.length; k++) {
            var w = this._nodeWeight(k);
            if (w === 0) continue;                               // node dropped from matching
            if (dists[k] == null || !isFinite(dists[k])) continue;  // np.nansum: skip NaN/degenerate
            var distanceWeight = dists[k] / this.distThresh;
            // May go negative; with maxPenalty, never below -maxPenalty.
            var correspondence = this.corr3d * Math.max(1 - distanceWeight, floor);
            sum += w * correspondence;                           // decay factor exp(0)=1
        }
        return sum;
    }

    // Birth: when >=2 views have leftover detections, epipolar-match the last two
    // and spawn a fresh target per matched cross-view pair (reference
    // `initialize_targets` / `match_unmatched_detections`).
    _initializeTargets() {
        // LUCID cap (divergence): once at the target ceiling, spawn no more.
        // Leftover detections are simply dropped this frame (cleared next frame);
        // the persistent targets re-acquire them via matching. null == uncapped
        // (faithful reference behavior).
        if (this.maxTargets != null && this.targets.length >= this.maxTargets) return;

        var viewsWithLeftovers = [];
        this.unmatchedByCam.forEach(function (list, camName) {
            if (list && list.length > 0) viewsWithLeftovers.push(camName);
        });
        if (viewsWithLeftovers.length < 2) return;

        var camNameA = viewsWithLeftovers[viewsWithLeftovers.length - 2];
        var camNameB = viewsWithLeftovers[viewsWithLeftovers.length - 1];
        var listA = this.unmatchedByCam.get(camNameA);
        var listB = this.unmatchedByCam.get(camNameB);
        var camA = listA[0].cam, camB = listB[0].cam;

        var F = this._fundamental(camA, camB);
        var ptsA = listA.map(function (d) { return d.pointsPixel; });
        var ptsB = listB.map(function (d) { return d.pointsPixel; });
        var cost = this.birthMedian                              // minimize epipolar error
            ? epipolarMedianMatrix(ptsA, ptsB, F)
            : epipolarErrorMatrix(ptsA, ptsB, F);
        var assign = hungarianAlgorithm(cost);

        var usedA = new Set(), usedB = new Set();
        for (var i = 0; i < listA.length; i++) {
            // Stop mid-frame if this frame's births would exceed the cap.
            if (this.maxTargets != null && this.targets.length >= this.maxTargets) break;
            var j = assign[i];
            if (j == null || j < 0 || j >= listB.length) continue;
            var target = new Target(this._nextTrackId++);
            target.addDetection(listA[i], this.matchReproj);
            target.addDetection(listB[j], this.matchReproj);
            this.targets.push(target);
            usedA.add(i); usedB.add(j);
        }
        // Remove consumed detections from the birth buffers.
        this.unmatchedByCam.set(camNameA, listA.filter(function (_, i) { return !usedA.has(i); }));
        this.unmatchedByCam.set(camNameB, listB.filter(function (_, j) { return !usedB.has(j); }));
    }

    _fundamental(camA, camB) {
        var key = camA.name + ':' + camB.name;
        if (!this._fCache[key]) this._fCache[key] = computeFundamentalMatrix(camA, camB);
        return this._fCache[key];
    }
}

// Birth pairing cost with `birthMedian`: the MEDIAN over nodes of the epipolar
// distance (`epipolarError` takes the mean), the middle two averaged for an
// even count. One misplaced node can make the mean larger for the right pair
// than for a wrong one. Infinity when no node is in both.
function epipolarMedian(points1, points2, F) {
    var d = [], len = Math.min(points1.length, points2.length);
    for (var i = 0; i < len; i++) {
        if (points1[i] == null || points2[i] == null) continue;
        var x1 = points1[i][0], y1 = points1[i][1];
        var la = F[0][0] * x1 + F[0][1] * y1 + F[0][2];
        var lb = F[1][0] * x1 + F[1][1] * y1 + F[1][2];
        var lc = F[2][0] * x1 + F[2][1] * y1 + F[2][2];
        var den = Math.sqrt(la * la + lb * lb);
        if (den > 1e-15) d.push(Math.abs(points2[i][0] * la + points2[i][1] * lb + lc) / den);
    }
    if (d.length === 0) return Infinity;
    d.sort(function (a, b) { return a - b; });
    var h = d.length >> 1;
    return d.length % 2 ? d[h] : (d[h - 1] + d[h]) / 2;
}

function epipolarMedianMatrix(detections1, detections2, F) {
    return detections1.map(function (a) {
        return detections2.map(function (b) { return epipolarMedian(a, b, F); });
    });
}

function num(v, dflt) {
    return (typeof v === 'number' && isFinite(v)) ? v : dflt;
}
