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
