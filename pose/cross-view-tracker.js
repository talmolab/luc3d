/**
 * cross-view-tracker.js — `CrossViewTracker`, LUCID's cross-view 3D tracker.
 *
 * Adapted from the `CrossViewTracker` written by Liezl Maree in the
 * talmolab/sleap-3d repository (Python) and reimplemented here in JavaScript.
 *
 * A faithful re-implementation of the cross-view 3D multi-target tracker from
 * `/root/vast/eric/sleap-3d/sleap_3d/tracker.py` (`CrossViewTracker`, L1158).
 * It associates per-camera 2D detections to a running list of 3D targets, one
 * camera-view at a time, via Hungarian assignment on a cost that sums a 2D
 * reprojection term and a 3D point-to-ray term. There is NO Kalman filter, NO
 * velocity model, and NO track aging — matching the reference.
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
 * Faithful-port quirks preserved from the reference (do NOT "fix" these):
 *   - Association is per-view-per-frame; each camera's Hungarian mutates the
 *     shared target list before the next camera is processed.
 *   - `velocity_threshold` / `distance_threshold` are SOFT (drive the cost term
 *     negative), not hard gates; negative-cost matches are not filtered out.
 *   - The 3D term ignores the time gap (Δt forced to 0 in the reference).
 *   - 3D velocity is zero (no motion prediction); re-triangulation is plain DLT
 *     over all of a target's stored per-view detections (time weights unused).
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
    this.pointsPixel = instance.points;                // raw pixel keypoints ([x,y]|null)
    this.pointsNorm = instance.points.map(function (p) { return normalizePoint(p, cam); });
}

// ---------------------------------------------------------------------------
// Target — a running 3D track fused from per-view detections
// ---------------------------------------------------------------------------

function Target(trackId) {
    this.trackId = trackId;
    this.detsByCam = new Map();   // camName -> Detection (one current det per view)
    this.points3d = null;         // [N] of [x,y,z]|null (world coords)
    this.identityId = null;       // filled at commit time
}

Target.prototype.frameIdxMean = function () {
    var s = 0, n = 0;
    this.detsByCam.forEach(function (d) { s += d.frameIdx; n++; });
    return n > 0 ? s / n : 0;
};

Target.prototype.addDetection = function (det) {
    this.detsByCam.set(det.cam.name, det);
    this._retriangulate();
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
     *   (indexed to match `Instance.points`) from the Tracking Wizard. Each
     *   node's contribution to the 2D + 3D association cost is scaled by its
     *   weight; a weight of 0 drops the node from matching entirely. null
     *   (default) == every node weighted 1 (faithful reference behavior).
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

        this.targets = [];                 // list of live Target
        this.unmatchedByCam = new Map();   // camName -> Detection[] (births buffer)
        this._nextTrackId = 0;
        this._fCache = {};                 // "camA:camB" -> fundamental matrix
    }

    /**
     * Process one frame. `detsByCam` is Map(camName -> Detection[]); `camsOrder`
     * is the array of Camera processed in sequence (mirrors the reference, which
     * associates one view at a time within a frame).
     */
    trackFrame(detsByCam, camsOrder) {
        for (var ci = 0; ci < camsOrder.length; ci++) {
            var cam = camsOrder[ci];
            var dets = detsByCam.get(cam.name) || [];
            // clear_unmatched_detections(view): drop this view's stale leftovers
            // before re-populating them this frame.
            this.unmatchedByCam.set(cam.name, []);
            this._trackView(dets, cam);
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
                    this.targets[ti].addDetection(dets[di]);   // match: fuse + re-triangulate
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
    _adjacency(target, det, cam) {
        var dt = det.frameIdx - target.frameIdxMean();
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
        var n = Math.min(target.points3d.length, det.pointsNorm.length);
        for (var k = 0; k < n; k++) {
            var w = this._nodeWeight(k);
            if (w === 0) continue;                               // node dropped from matching
            var tp = target.points3d[k], dp = det.pointsNorm[k];
            if (tp == null || dp == null) continue;             // np.nansum skips NaN
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
