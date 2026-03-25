/**
 * tracker.js — Detection2D and Target3D classes for cross-view tracking.
 *
 * Detection2D wraps a 2D pose detection from a single camera view.
 * Target3D represents a triangulated 3D pose built from multiple Detection2Ds.
 */

// ============================================
// Detection2D
// ============================================

class Detection2D {
    /**
     * @param {(number[]|null)[]} points - Undistorted 2D keypoints, each [x,y] or null
     * @param {number} frameIdx - Frame index
     * @param {string} cameraName - Camera name
     * @param {number[][]} projectionMatrix - 3x4 projection matrix
     * @param {Instance|null} instance - Reference to original Lucid Instance
     * @param {number} trackIdx - Track index
     */
    constructor(points, frameIdx, cameraName, projectionMatrix, instance, trackIdx) {
        this.points = points;
        this.frameIdx = frameIdx;
        this.cameraName = cameraName;
        this.projectionMatrix = projectionMatrix;
        this.instance = instance;
        this.trackIdx = trackIdx;
    }

    /**
     * Create a Detection2D from a Lucid Instance and Camera.
     * Undistorts each point via camera.undistortPoint().
     *
     * @param {Instance} instance
     * @param {Camera} camera
     * @param {number} frameIdx
     * @returns {Detection2D}
     */
    static fromInstance(instance, camera, frameIdx) {
        const undistortedPoints = instance.points.map(function (pt) {
            if (pt == null) return null;
            return camera.undistortPoint(pt);
        });
        return new Detection2D(
            undistortedPoints,
            frameIdx,
            camera.name,
            camera.projectionMatrix,
            instance,
            instance.trackIdx
        );
    }
}


// ============================================
// Target3D
// ============================================

class Target3D {
    /**
     * @param {(number[]|null)[]} points - Array of [x,y,z] or null (3D keypoints)
     * @param {number} frameIdx - Frame index
     * @param {number} trackId - Track/target ID
     */
    constructor(points, frameIdx, trackId) {
        this.points = points;
        this.frameIdx = frameIdx;
        this.trackId = trackId;
        /** @type {number} Identity ID, defaults to -1 (unassigned) */
        this.identityId = -1;
        /** @type {Map<string, {points: (number[]|null)[], projectionMatrix: number[][], frameIdx: number, trackIdx: number}>} */
        this.detectionsByCamera = new Map();
    }

    /**
     * Store a detection keyed by cameraName. Replaces existing entry for the
     * same camera. Updates frameIdx to the mean of all stored detections.
     *
     * @param {Detection2D} detection
     */
    addDetection(detection) {
        this.detectionsByCamera.set(detection.cameraName, {
            points: detection.points,
            projectionMatrix: detection.projectionMatrix,
            frameIdx: detection.frameIdx,
            trackIdx: detection.trackIdx
        });
        // Update frameIdx to mean of all detections
        var sum = 0;
        var count = 0;
        this.detectionsByCamera.forEach(function (entry) {
            sum += entry.frameIdx;
            count++;
        });
        this.frameIdx = sum / count;
    }

    /**
     * @returns {Array<{points, projectionMatrix, frameIdx, trackIdx}>}
     */
    getDetections() {
        return Array.from(this.detectionsByCamera.values());
    }

    /**
     * @returns {number[][][]} Array of 3x4 projection matrices
     */
    getProjectionMatrices() {
        var matrices = [];
        this.detectionsByCamera.forEach(function (entry) {
            matrices.push(entry.projectionMatrix);
        });
        return matrices;
    }

    /**
     * @returns {number[]} Array of frame indices
     */
    getFrameIndices() {
        var indices = [];
        this.detectionsByCamera.forEach(function (entry) {
            indices.push(entry.frameIdx);
        });
        return indices;
    }

    /**
     * Build a Target3D from 2+ Detection2Ds by triangulating shared keypoints.
     *
     * @param {Detection2D[]} detections - At least 2 detections from different cameras
     * @param {number} trackId - Track/target ID
     * @returns {Target3D}
     */
    static fromDetections(detections, trackId) {
        if (detections.length < 2) {
            throw new Error('Target3D.fromDetections requires at least 2 detections');
        }

        // Determine number of keypoints from first detection
        var numKeypoints = detections[0].points.length;

        // Build observations per keypoint:
        // allObservations[k][camIdx] = [x,y] or null
        var allObservations = [];
        var projectionMatrices = [];
        for (var i = 0; i < detections.length; i++) {
            projectionMatrices.push(detections[i].projectionMatrix);
        }

        for (var k = 0; k < numKeypoints; k++) {
            var observations = [];
            for (var i = 0; i < detections.length; i++) {
                observations.push(detections[i].points[k]);
            }
            allObservations.push(observations);
        }

        // Triangulate
        var points3d = triangulatePoints(allObservations, projectionMatrices);

        // Compute mean frame index
        var sumFrame = 0;
        for (var i = 0; i < detections.length; i++) {
            sumFrame += detections[i].frameIdx;
        }
        var meanFrame = sumFrame / detections.length;

        var target = new Target3D(points3d, meanFrame, trackId);

        // Store all detections
        for (var i = 0; i < detections.length; i++) {
            target.detectionsByCamera.set(detections[i].cameraName, {
                points: detections[i].points,
                projectionMatrix: detections[i].projectionMatrix,
                frameIdx: detections[i].frameIdx,
                trackIdx: detections[i].trackIdx
            });
        }

        return target;
    }
}


// ============================================
// CrossViewTracker
// ============================================

/** Global track ID counter, reset via CrossViewTracker.prototype.reset(). */
var _trackerTrackIdCounter = 0;

class CrossViewTracker {
    /**
     * Cross-view tracker: matches 2D detections across camera views to 3D targets
     * using adjacency scoring (2D reprojection + 3D ray distance) and Hungarian
     * assignment. Ports the core algorithm from sleap-3d's CrossViewTracker.
     *
     * @param {Object} [opts]
     * @param {number} [opts.correspondenceWeight2d=1.0]
     * @param {number} [opts.correspondenceWeight3d=1.0]
     * @param {number} [opts.velocityThreshold=1.0]
     * @param {number} [opts.distanceThreshold=1.0]
     * @param {number} [opts.timePenalty=1.0]
     * @param {string} [opts.keypointAggregationMethod='mean']
     */
    constructor(opts) {
        opts = opts || {};
        this.correspondenceWeight2d = opts.correspondenceWeight2d != null ? opts.correspondenceWeight2d : 1.0;
        this.correspondenceWeight3d = opts.correspondenceWeight3d != null ? opts.correspondenceWeight3d : 1.0;
        this.velocityThreshold = opts.velocityThreshold != null ? opts.velocityThreshold : 1.0;
        this.distanceThreshold = opts.distanceThreshold != null ? opts.distanceThreshold : 1.0;
        this.timePenalty = opts.timePenalty != null ? opts.timePenalty : 1.0;
        this.keypointAggregationMethod = opts.keypointAggregationMethod || 'mean';
        /** @type {Target3D[]} */
        this.prevTargets = [];
        /** @type {Map<string, Detection2D[]>} cameraName -> unmatched detections */
        this.prevUnmatchedDetections = new Map();
        this.frameIdx = 0;
        this.algorithmIteration = 0;
    }

    /** Clear all state and reset counters. */
    reset() {
        this.prevTargets = [];
        this.prevUnmatchedDetections = new Map();
        this.frameIdx = 0;
        this.algorithmIteration = 0;
        _trackerTrackIdCounter = 0;
    }

    /**
     * Track a single frame across all camera views.
     * Port of sleap-3d's track_frame.
     *
     * @param {FrameGroup} frameGroup
     * @param {Camera[]} cameras
     * @param {Session} session
     * @returns {{targets: Target3D[], newTargets: Target3D[]}}
     */
    trackFrame(frameGroup, cameras, session) {
        /** @type {Target3D[][]} Per-view target snapshots for aggregation */
        var frameTargets = [];
        var allNewTargets = [];

        for (var ci = 0; ci < cameras.length; ci++) {
            var cam = cameras[ci];
            var instances = frameGroup.getInstances(cam.name);
            if (!instances) instances = [];

            // Convert instances to Detection2Ds
            var detections = [];
            for (var i = 0; i < instances.length; i++) {
                detections.push(Detection2D.fromInstance(instances[i], cam, this.frameIdx));
            }

            // Clear unmatched detections for this camera before processing
            this.prevUnmatchedDetections.delete(cam.name);

            // Run one algorithm iteration for this view
            var result = this.algorithmIteration_(detections);
            if (result.newTargets) {
                allNewTargets = allNewTargets.concat(result.newTargets);
            }

            // Snapshot current targets for aggregation
            frameTargets.push(this.prevTargets.slice());
        }

        // Aggregate keypoints across per-view snapshots
        this.aggregateKeypoints(frameTargets);

        // Increment frame index
        this.frameIdx++;

        return { targets: this.prevTargets, newTargets: allNewTargets };
    }

    /**
     * Run a single iteration of the tracking algorithm for one view's detections.
     * Port of sleap-3d's algorithm_iteration.
     *
     * @param {Detection2D[]} newDetections
     * @returns {{newTargets: Target3D[]}}
     */
    algorithmIteration_(newDetections) {
        var newTargets = [];

        if (this.prevTargets.length === 0) {
            // No existing targets: all detections are unmatched
            this.updateUnmatchedDetections(newDetections);
            newTargets = this.initializeTargets();
            if (newTargets.length > 0) {
                this.prevTargets = this.prevTargets.concat(newTargets);
            }
            this.algorithmIteration++;
            return { newTargets: newTargets };
        }

        // Calculate adjacency matrices
        var adj = this.calculateAdjacencyMatrices(this.prevTargets, newDetections);

        // Combined score
        var numTargets = this.prevTargets.length;
        var numDetections = newDetections.length;
        var costMatrix = [];
        for (var ti = 0; ti < numTargets; ti++) {
            costMatrix[ti] = [];
            for (var di = 0; di < numDetections; di++) {
                // Negate because Hungarian minimizes, but we want to maximize score
                costMatrix[ti][di] = -(adj.score2d[ti][di] + adj.score3d[ti][di]);
            }
        }

        // Run Hungarian assignment
        // assignment[targetIdx] = detectionIdx (or -1 if unassigned)
        var assignment = hungarianAlgorithm(costMatrix);

        // Update matched targets via incremental reconstruction
        var matchedDetectionIndices = new Set();
        for (var ti2 = 0; ti2 < assignment.length; ti2++) {
            var di2 = assignment[ti2];
            if (di2 >= 0 && di2 < numDetections) {
                this.incrementalReconstruction(this.prevTargets[ti2], newDetections[di2]);
                matchedDetectionIndices.add(di2);
            }
        }

        // Collect unmatched detections (those not matched to any target)
        var unmatchedDetections = [];
        for (var di3 = 0; di3 < numDetections; di3++) {
            if (!matchedDetectionIndices.has(di3)) {
                unmatchedDetections.push(newDetections[di3]);
            }
        }

        // Store unmatched and try to initialize new targets from cross-view matches
        this.updateUnmatchedDetections(unmatchedDetections);
        newTargets = this.initializeTargets();
        if (newTargets.length > 0) {
            this.prevTargets = this.prevTargets.concat(newTargets);
        }

        this.algorithmIteration++;
        return { newTargets: newTargets };
    }

    /**
     * Calculate 2D and 3D adjacency matrices for target-detection pairs.
     *
     * @param {Target3D[]} targets
     * @param {Detection2D[]} detections
     * @returns {{score2d: number[][], score3d: number[][]}}
     */
    calculateAdjacencyMatrices(targets, detections) {
        var nT = targets.length;
        var nD = detections.length;
        var score2d = [];
        var score3d = [];

        for (var ti = 0; ti < nT; ti++) {
            score2d[ti] = [];
            score3d[ti] = [];
            for (var di = 0; di < nD; di++) {
                var target = targets[ti];
                var det = detections[di];
                var timeDiff = det.frameIdx - target.frameIdx;

                // 2D score: project target to detection's view, compare with detection
                var projected = reprojectPoints(target.points, det.projectionMatrix);
                score2d[ti][di] = this.calculateAdjacencyValue2d(projected, det, timeDiff);

                // 3D score: back-project detection to rays, measure point-to-ray distance
                score3d[ti][di] = this.calculateAdjacencyValue3d(target, det);
            }
        }

        return { score2d: score2d, score3d: score3d };
    }

    /**
     * Equation 2 from sleap-3d: 2D adjacency value.
     * Per keypoint: distance, velocity-weighted, time-decayed.
     *
     * @param {(number[]|null)[]} projectedPoints - Target projected into detection's view
     * @param {Detection2D} detection
     * @param {number} timeDiff - Frame index difference
     * @returns {number} Sum of per-keypoint 2D scores
     */
    calculateAdjacencyValue2d(projectedPoints, detection, timeDiff) {
        var total = 0;
        var numKpts = Math.min(projectedPoints.length, detection.points.length);

        for (var k = 0; k < numKpts; k++) {
            if (projectedPoints[k] == null || detection.points[k] == null) continue;

            var dx = detection.points[k][0] - projectedPoints[k][0];
            var dy = detection.points[k][1] - projectedPoints[k][1];
            var dist = Math.sqrt(dx * dx + dy * dy);

            // Velocity: modified Eq 5 to allow for 0 time difference
            var velocity = dist / (this.velocityThreshold * (1 + timeDiff));

            // Correspondence-weighted score with time decay
            var score = this.correspondenceWeight2d * (1 - velocity) *
                Math.exp(-this.timePenalty * timeDiff);

            if (!isNaN(score)) {
                total += score;
            }
        }

        return total;
    }

    /**
     * Equation 4 from sleap-3d: 3D adjacency value (no time decay, matching reference).
     * Back-project detection points to rays, measure point-to-ray distance.
     *
     * @param {Target3D} target
     * @param {Detection2D} detection
     * @returns {number} Sum of per-keypoint 3D scores
     */
    calculateAdjacencyValue3d(target, detection) {
        // Back-project detection's 2D points to rays
        var rays = backProjectToRays(detection.points, detection.projectionMatrix);
        var origin = rays.origin;
        var directions = rays.directions;

        var total = 0;
        var numKpts = Math.min(target.points.length, detection.points.length);

        for (var k = 0; k < numKpts; k++) {
            if (target.points[k] == null || directions[k] == null) continue;

            var dist = pointToRayDistance(target.points[k], origin, directions[k]);
            var weight = dist / this.distanceThreshold;

            var score = this.correspondenceWeight3d * (1 - weight);

            if (!isNaN(score)) {
                total += score;
            }
        }

        return total;
    }

    /**
     * Incremental 3D reconstruction: add detection to target, re-triangulate.
     * Port of sleap-3d's incremental_3d_reconstruction.
     *
     * @param {Target3D} target
     * @param {Detection2D} detection
     */
    incrementalReconstruction(target, detection) {
        // Add the new detection (replaces if same camera)
        target.addDetection(detection);

        // Re-triangulate using all stored detections
        var detEntries = target.getDetections();
        var projMatrices = target.getProjectionMatrices();
        var numKeypoints = target.points.length;

        // Build observations per keypoint
        var allObservations = [];
        for (var k = 0; k < numKeypoints; k++) {
            var obs = [];
            for (var c = 0; c < detEntries.length; c++) {
                obs.push(detEntries[c].points[k]);
            }
            allObservations.push(obs);
        }

        // Standard DLT triangulation (weighted is TODO, matching reference)
        var newPoints = triangulatePoints(allObservations, projMatrices);
        target.points = newPoints;
    }

    /**
     * Store unmatched detections by camera name.
     *
     * @param {Detection2D[]} detections
     */
    updateUnmatchedDetections(detections) {
        if (detections.length === 0) return;
        var cameraName = detections[0].cameraName;
        // Replace (only keep newest unmatched for this camera)
        this.prevUnmatchedDetections.set(cameraName, detections);
    }

    /**
     * Initialize new 3D targets from cross-view unmatched detections.
     * When 2+ cameras have unmatched detections, use epipolar geometry
     * to find cross-view correspondences, then triangulate to create new targets.
     *
     * @returns {Target3D[]} Newly created targets
     */
    initializeTargets() {
        var newTargets = [];

        // Need unmatched detections from at least 2 cameras
        if (this.prevUnmatchedDetections.size < 2) return newTargets;

        // Get the two most recent camera entries
        var entries = Array.from(this.prevUnmatchedDetections.entries());
        var lastTwo = entries.slice(-2);
        var cam1Name = lastTwo[0][0];
        var dets1 = lastTwo[0][1];
        var cam2Name = lastTwo[1][0];
        var dets2 = lastTwo[1][1];

        if (dets1.length === 0 || dets2.length === 0) return newTargets;

        // Compute fundamental matrix from projection matrices
        var P1 = dets1[0].projectionMatrix;
        var P2 = dets2[0].projectionMatrix;
        var F = this.computeFundamentalFromProjections(P1, P2);

        // Build epipolar error cost matrix
        var points1 = [];
        for (var i = 0; i < dets1.length; i++) points1.push(dets1[i].points);
        var points2 = [];
        for (var j = 0; j < dets2.length; j++) points2.push(dets2[j].points);

        var costMatrix = epipolarErrorMatrix(points1, points2, F);

        // Hungarian assignment to find cross-view pairs (minimize epipolar error)
        var assignment = hungarianAlgorithm(costMatrix);

        // Create Target3D from each matched pair
        var matchedIdx1 = [];
        var matchedIdx2 = [];
        for (var i2 = 0; i2 < assignment.length; i2++) {
            var j2 = assignment[i2];
            if (j2 >= 0 && j2 < dets2.length && i2 < dets1.length) {
                var trackId = _trackerTrackIdCounter++;
                var target = Target3D.fromDetections([dets1[i2], dets2[j2]], trackId);
                newTargets.push(target);
                matchedIdx1.push(i2);
                matchedIdx2.push(j2);
            }
        }

        // Remove matched from unmatched lists (reverse order to preserve indices)
        matchedIdx1.sort(function (a, b) { return b - a; });
        matchedIdx2.sort(function (a, b) { return b - a; });
        for (var m1 = 0; m1 < matchedIdx1.length; m1++) {
            dets1.splice(matchedIdx1[m1], 1);
        }
        for (var m2 = 0; m2 < matchedIdx2.length; m2++) {
            dets2.splice(matchedIdx2[m2], 1);
        }

        // Clean up empty entries
        if (dets1.length === 0) this.prevUnmatchedDetections.delete(cam1Name);
        if (dets2.length === 0) this.prevUnmatchedDetections.delete(cam2Name);

        return newTargets;
    }

    /**
     * Compute fundamental matrix from two 3x4 projection matrices.
     * F = [e']_x * P2 * pinv(P1)
     *
     * @param {number[][]} P1 - 3x4 projection matrix of camera 1
     * @param {number[][]} P2 - 3x4 projection matrix of camera 2
     * @returns {number[][]} 3x3 fundamental matrix
     */
    computeFundamentalFromProjections(P1, P2) {
        // Camera center C1 from P1
        var C1 = cameraCenter(P1);

        // Epipole e' = P2 * [C1; 1]
        var ep = [
            P2[0][0] * C1[0] + P2[0][1] * C1[1] + P2[0][2] * C1[2] + P2[0][3],
            P2[1][0] * C1[0] + P2[1][1] * C1[1] + P2[1][2] * C1[2] + P2[1][3],
            P2[2][0] * C1[0] + P2[2][1] * C1[1] + P2[2][2] * C1[2] + P2[2][3]
        ];

        // Skew-symmetric matrix [e']_x
        var epx = [
            [0, -ep[2], ep[1]],
            [ep[2], 0, -ep[0]],
            [-ep[1], ep[0], 0]
        ];

        // Pseudo-inverse of P1: pinv(P1) = P1^T * inv(P1 * P1^T)
        var P1T = matTranspose(P1);     // 4x3
        var P1P1T = matMul(P1, P1T);    // 3x3
        var P1P1Tinv = invert3x3(P1P1T);
        var pinvP1 = matMul(P1T, P1P1Tinv); // 4x3

        // F = [e']_x * P2 * pinv(P1)
        // P2 is 3x4, pinvP1 is 4x3 -> P2 * pinvP1 is 3x3
        var P2pinv = matMul(P2, pinvP1); // 3x3
        var F = mat3x3Multiply(epx, P2pinv);

        return F;
    }

    /**
     * Aggregate 3D keypoints across per-view target snapshots.
     * For each target, compute nanmean of 3D points across view snapshots.
     *
     * @param {Target3D[][]} frameTargets - Per-view target snapshots
     */
    aggregateKeypoints(frameTargets) {
        if (this.keypointAggregationMethod !== 'mean') return;
        if (frameTargets.length === 0) return;

        // Find max number of targets across all view snapshots
        var maxTargets = 0;
        for (var v = 0; v < frameTargets.length; v++) {
            if (frameTargets[v].length > maxTargets) {
                maxTargets = frameTargets[v].length;
            }
        }
        if (maxTargets === 0) return;

        // For each target (by index in prevTargets), average across view snapshots
        for (var ti = 0; ti < this.prevTargets.length; ti++) {
            var target = this.prevTargets[ti];
            var numKpts = target.points.length;

            for (var k = 0; k < numKpts; k++) {
                var sumX = 0, sumY = 0, sumZ = 0, count = 0;

                for (var v2 = 0; v2 < frameTargets.length; v2++) {
                    // Find matching target by trackId
                    var viewTargets = frameTargets[v2];
                    for (var vt = 0; vt < viewTargets.length; vt++) {
                        if (viewTargets[vt].trackId === target.trackId &&
                            viewTargets[vt].points[k] != null) {
                            sumX += viewTargets[vt].points[k][0];
                            sumY += viewTargets[vt].points[k][1];
                            sumZ += viewTargets[vt].points[k][2];
                            count++;
                        }
                    }
                }

                if (count > 0) {
                    target.points[k] = [sumX / count, sumY / count, sumZ / count];
                }
            }
        }
    }

    /**
     * Create Identities for targets and map camera:trackIdx to identityId in session.
     *
     * @param {Session} session
     */
    applyResults(session) {
        for (var ti = 0; ti < this.prevTargets.length; ti++) {
            var target = this.prevTargets[ti];

            // Create identity if not yet assigned
            if (target.identityId < 0) {
                var identity = session.addIdentity('track_' + target.trackId);
                target.identityId = identity.id;
            }

            // Map each camera:trackIdx to the identity
            target.detectionsByCamera.forEach(function (entry, cameraName) {
                var key = cameraName + ':' + entry.trackIdx;
                session.trackIdentityMap.set(key, target.identityId);
            });
        }
    }

    /**
     * Find the best matching instance in other views for a selected instance.
     * Uses epipolar geometry to score matches.
     *
     * @param {Instance} selectedInstance - The instance selected by the user
     * @param {string} selectedCameraName - Camera name of the selected instance
     * @param {FrameGroup} frameGroup - Current frame's FrameGroup
     * @param {Camera[]} cameras - All cameras
     * @returns {Map<string, {instance: Instance, score: number}>} cameraName -> best match
     */
    findMatchesForInstance(selectedInstance, selectedCameraName, frameGroup, cameras) {
        var selectedCam = null;
        for (var c = 0; c < cameras.length; c++) {
            if (cameras[c].name === selectedCameraName) { selectedCam = cameras[c]; break; }
        }
        if (!selectedCam) return new Map();

        var selectedDet = Detection2D.fromInstance(selectedInstance, selectedCam, frameGroup.frameIdx);
        var matches = new Map();

        for (var c2 = 0; c2 < cameras.length; c2++) {
            var cam = cameras[c2];
            if (cam.name === selectedCameraName) continue;

            var instances = frameGroup.getInstances(cam.name);
            if (!instances || instances.length === 0) continue;

            // Compute fundamental matrix between the two views
            var F = this.computeFundamentalFromProjections(
                selectedCam.projectionMatrix, cam.projectionMatrix
            );

            var bestScore = Infinity;
            var bestInst = null;
            for (var i = 0; i < instances.length; i++) {
                var candidateDet = Detection2D.fromInstance(instances[i], cam, frameGroup.frameIdx);
                var error = epipolarError(selectedDet.points, candidateDet.points, F);
                if (error < bestScore) {
                    bestScore = error;
                    bestInst = instances[i];
                }
            }

            if (bestInst) {
                matches.set(cam.name, { instance: bestInst, score: bestScore });
            }
        }

        return matches;
    }
}
