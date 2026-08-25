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
 * Faithful-port quirks still preserved from the reference (do NOT "fix" these
 * without new measurement — they were not implicated by the fig8-bench search):
 *   - `velocity_threshold` / `distance_threshold` are SOFT (drive the cost term
 *     negative), not hard gates; negative-cost matches are not filtered out.
 *   - The 3D term ignores the time gap (Δt forced to 0 in the reference).
 *   - 3D velocity is zero (no motion prediction); re-triangulation is plain DLT
 *     over all of a target's (now freshness-filtered) per-view detections.
 *
 * Depends on: pose/triangulation.js (all geometry is coordinate-agnostic and
 * reused directly by passing the bare extrinsic + normalized points).
 */

import {
    triangulatePoints,
    reprojectPoint,
    backProjectToRays,
    pointsToRayDistances,
    hungarianAlgorithm,
    computeFundamentalMatrix,
    epipolarErrorMatrix,
} from './triangulation.js';
import { points3dNodeCount, readPoint3d } from './pose-data.js';

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
}

// ---------------------------------------------------------------------------
// Target — a running 3D track fused from per-view detections
// ---------------------------------------------------------------------------

function Target(trackId) {
    this.trackId = trackId;
    this.detsByCam = new Map();   // camName -> Detection (one current det per view)
    this.points3d = null;         // Float64Array(3N) world coords, all-NaN = missing
    this.identityId = null;       // filled at commit time
    this._touched = false;        // got a matched detection this frame (sync: re-fuse at frame end)
    this._snapMean = null;        // frame-start frameIdxMean() snapshot (sync); null outside a frame
}

Target.prototype.frameIdxMean = function () {
    var s = 0, n = 0;
    this.detsByCam.forEach(function (d) { s += d.frameIdx; n++; });
    return n > 0 ? s / n : 0;
};

// Immediate fuse: used for births, where the target does not exist yet at
// frame start and so has nothing for `_endFrame` to defer.
Target.prototype.addDetection = function (det) {
    this.detsByCam.set(det.cam.name, det);
    this._retriangulate();
};

// Frame-synchronous fuse: record the match but defer `_retriangulate()` to
// `_endFrame()`, so every camera's Hungarian this frame sees the SAME
// `points3d` regardless of what earlier cameras in this frame matched.
Target.prototype._deferDetection = function (det) {
    this.detsByCam.set(det.cam.name, det);
    this._touched = true;
};

Target.prototype._retriangulate = function () {
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
};

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
        }
    }

    // Stale-anchor fix, part 2 (frame-synchronous association): re-fuse every
    // target touched this frame exactly once, after all cameras have been
    // processed, instead of mid-frame inside `_trackView`.
    _endFrame() {
        for (var t = 0; t < this.targets.length; t++) {
            var tg = this.targets[t];
            if (tg._touched) tg._retriangulate();
            tg._touched = false;
            tg._snapMean = null;
        }
    }

    _trackView(dets, cam) {
        var self = this;
        var N = this.targets.length, M = dets.length;
        var matchedDet = new Array(M).fill(false);

        if (N > 0 && M > 0) {
            // adjacency[t][d] = 2D term + 3D term (higher = better). We negate for
            // LUCID's minimizing Hungarian (== maximize adjacency).
            var cost = [];
            for (var t = 0; t < N; t++) {
                cost[t] = [];
                for (var d = 0; d < M; d++) {
                    cost[t][d] = -this._adjacency(this.targets[t], dets[d], cam);
                }
            }
            var assign = hungarianAlgorithm(cost);   // assign[t] = det col, or out-of-range
            for (var ti = 0; ti < N; ti++) {
                var di = assign[ti];
                if (di != null && di >= 0 && di < M) {
                    // Sync fix: record the match now but defer re-triangulation to
                    // _endFrame(), so a later camera THIS frame is scored against
                    // the same points3d an earlier camera this frame was.
                    this.targets[ti]._deferDetection(dets[di]);
                    matchedDet[di] = true;
                }
            }
        }

        // Unmatched detections in this view accumulate for cross-view birth.
        var leftover = [];
        for (var m = 0; m < M; m++) if (!matchedDet[m]) leftover.push(dets[m]);
        this.unmatchedByCam.set(cam.name, leftover);

        this._initializeTargets();
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
        var n = Math.min(points3dNodeCount(target.points3d), det.pointsNorm.length);
        var tp = [0, 0, 0];
        for (var k = 0; k < n; k++) {
            var w = this._nodeWeight(k);
            if (w === 0) continue;                               // node dropped from matching
            var dp = det.pointsNorm[k];
            if (dp == null || !readPoint3d(target.points3d, k, tp)) continue;  // np.nansum skips NaN
            var proj = projectNorm(tp, ext);
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
        var ray = backProjectToRays(det.pointsNorm, ext);        // origin + per-node dirs
        var dists = pointsToRayDistances(target.points3d, ray.origin, ray.directions);
        var sum = 0;
        for (var k = 0; k < dists.length; k++) {
            var w = this._nodeWeight(k);
            if (w === 0) continue;                               // node dropped from matching
            if (dists[k] == null || !isFinite(dists[k])) continue;  // np.nansum: skip NaN/degenerate
            var distanceWeight = dists[k] / this.distThresh;
            var correspondence = this.corr3d * (1 - distanceWeight);  // may go negative
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
        var cost = epipolarErrorMatrix(ptsA, ptsB, F);           // minimize epipolar error
        var assign = hungarianAlgorithm(cost);

        var usedA = new Set(), usedB = new Set();
        for (var i = 0; i < listA.length; i++) {
            // Stop mid-frame if this frame's births would exceed the cap.
            if (this.maxTargets != null && this.targets.length >= this.maxTargets) break;
            var j = assign[i];
            if (j == null || j < 0 || j >= listB.length) continue;
            var target = new Target(this._nextTrackId++);
            target.addDetection(listA[i]);
            target.addDetection(listB[j]);
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

function num(v, dflt) {
    return (typeof v === 'number' && isFinite(v)) ? v : dflt;
}
