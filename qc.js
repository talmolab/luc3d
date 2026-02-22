/**
 * qc.js - Quality Control metrics engine for LUCID
 *
 * Computes per-frame and per-instance quality metrics for 3D pose data:
 *   - Reprojection error analysis (per-keypoint, per-camera, per-instance)
 *   - Limb length consistency (3D skeleton edge lengths across frames)
 *   - Temporal smoothness (velocity/jitter detection across frames)
 *   - Completeness scoring (keypoint visibility across cameras)
 *   - Composite QC score combining all metrics
 *   - Outlier detection using percentile-based thresholds
 *   - Error classification (jitter, miss, inversion, swap)
 *
 * All functions are vanilla JS globals - no imports/exports.
 */

// ============================================
// QC Metrics Engine
// ============================================

var QC = (function () {
    'use strict';

    // --------------------------------------------------
    // Configuration defaults
    // --------------------------------------------------
    var DEFAULT_CONFIG = {
        // Reprojection error thresholds (pixels)
        reprojError: {
            low: 2,       // green
            medium: 5,    // yellow
            high: 10,     // red / outlier
        },
        // Limb length consistency (coefficient of variation threshold)
        limbLength: {
            cvThreshold: 0.15,   // flag if CV > 15%
        },
        // Temporal smoothness (velocity in units/frame)
        temporal: {
            velocityPercentile: 95,  // flag above this percentile
            maxVelocity: null,       // absolute threshold (auto-computed if null)
        },
        // Completeness thresholds
        completeness: {
            minCameras: 2,       // minimum cameras per keypoint
            minKeypointRatio: 0.5, // flag if < 50% of keypoints visible
        },
        // Outlier detection
        outlier: {
            method: 'percentile',   // 'percentile' or 'threshold'
            percentile: 95,         // for percentile method
        },
        // Composite score weights
        weights: {
            reprojection: 0.35,
            limbLength: 0.20,
            temporal: 0.20,
            completeness: 0.25,
        },
        // Epipolar distance (pairwise geometric consistency)
        epipolar: {
            percentile: 95,
        },
        // Per-frame limb length outliers (z-score based)
        limbLengthOutlier: {
            zScoreThreshold: 3.0,
        },
        // Swap detection (cross-instance identity swap)
        swap: {
            marginRatio: 0.8,
        },
        // Auto-thresholding (percentile-based)
        autoThreshold: {
            percentile: 95,
        },
    };

    // --------------------------------------------------
    // Utility: vector math
    // --------------------------------------------------

    function dist3d(a, b) {
        var dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    function percentile(sortedArr, p) {
        if (sortedArr.length === 0) return 0;
        var idx = (p / 100) * (sortedArr.length - 1);
        var lo = Math.floor(idx), hi = Math.ceil(idx);
        if (lo === hi) return sortedArr[lo];
        return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
    }

    function median(arr) {
        if (arr.length === 0) return 0;
        var sorted = arr.slice().sort(function (a, b) { return a - b; });
        return percentile(sorted, 50);
    }

    function mean(arr) {
        if (arr.length === 0) return 0;
        var s = 0;
        for (var i = 0; i < arr.length; i++) s += arr[i];
        return s / arr.length;
    }

    function stddev(arr) {
        if (arr.length < 2) return 0;
        var m = mean(arr);
        var s = 0;
        for (var i = 0; i < arr.length; i++) {
            var d = arr[i] - m;
            s += d * d;
        }
        return Math.sqrt(s / (arr.length - 1));
    }

    // --------------------------------------------------
    // Utility: matrix math for epipolar geometry
    // --------------------------------------------------

    /**
     * Invert a 3x3 matrix using cofactor expansion.
     * @param {number[][]} M - 3x3 matrix
     * @returns {number[][]} 3x3 inverse, or null if singular
     */
    function invert3x3(M) {
        var a = M[0][0], b = M[0][1], c = M[0][2];
        var d = M[1][0], e = M[1][1], f = M[1][2];
        var g = M[2][0], h = M[2][1], k = M[2][2];
        var det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
        if (Math.abs(det) < 1e-12) return null;
        var invDet = 1.0 / det;
        return [
            [(e * k - f * h) * invDet, (c * h - b * k) * invDet, (b * f - c * e) * invDet],
            [(f * g - d * k) * invDet, (a * k - c * g) * invDet, (c * d - a * f) * invDet],
            [(d * h - e * g) * invDet, (b * g - a * h) * invDet, (a * e - b * d) * invDet],
        ];
    }

    /**
     * Build a 3x3 skew-symmetric matrix from a 3-vector.
     * @param {number[]} v - 3-element vector
     * @returns {number[][]} 3x3 skew-symmetric matrix
     */
    function skewMatrix(v) {
        return [
            [0, -v[2], v[1]],
            [v[2], 0, -v[0]],
            [-v[1], v[0], 0],
        ];
    }

    /**
     * Compute the fundamental matrix F from two 3x4 projection matrices.
     * F = skew(e2) * P2 * pinv(P1)
     * where e2 = P2 * C1 and C1 is the null space of P1.
     *
     * @param {number[][]} P1 - 3x4 projection matrix (camera 1)
     * @param {number[][]} P2 - 3x4 projection matrix (camera 2)
     * @returns {number[][]|null} 3x3 fundamental matrix, or null if degenerate
     */
    function computeFundamentalMatrix(P1, P2) {
        // Camera center C1: null space of P1 (4-vector, homogeneous)
        // Use P1^T * P1 -> smallest eigenvector via jacobiEigen (from triangulation.js)
        var P1T = matTranspose(P1);
        var M = matMul(P1T, P1); // 4x4
        var C1 = solveSmallestEigenvector4x4(M); // 4-vector

        // Epipole e2 = P2 * C1
        var e2 = [0, 0, 0];
        for (var i = 0; i < 3; i++) {
            for (var j = 0; j < 4; j++) {
                e2[i] += P2[i][j] * C1[j];
            }
        }

        // Skew matrix of e2
        var skewE2 = skewMatrix(e2);

        // Pseudoinverse of P1: P1+ = P1^T * inv(P1 * P1^T)
        var P1P1T = matMul(P1, P1T); // 3x3
        var P1P1Tinv = invert3x3(P1P1T);
        if (!P1P1Tinv) return null;
        var P1pinv = matMul(P1T, P1P1Tinv); // 4x3

        // F = skew(e2) * P2 * P1+
        var P2P1pinv = matMul(P2, P1pinv); // 3x3
        var F = matMul(skewE2, P2P1pinv); // 3x3

        return F;
    }

    /**
     * Compute epipolar distance: distance from x2 to the epipolar line l2 = F * x1.
     *
     * @param {number[][]} F - 3x3 fundamental matrix
     * @param {number[]} x1 - 2D point in image 1 [u, v]
     * @param {number[]} x2 - 2D point in image 2 [u, v]
     * @returns {number} distance in pixels
     */
    function computeEpipolarDistance(F, x1, x2) {
        // l2 = F * [x1; 1]
        var h1 = [x1[0], x1[1], 1];
        var l2 = [
            F[0][0] * h1[0] + F[0][1] * h1[1] + F[0][2] * h1[2],
            F[1][0] * h1[0] + F[1][1] * h1[1] + F[1][2] * h1[2],
            F[2][0] * h1[0] + F[2][1] * h1[1] + F[2][2] * h1[2],
        ];
        // distance = |l2^T * [x2; 1]| / ||l2[0:2]||
        var num = Math.abs(l2[0] * x2[0] + l2[1] * x2[1] + l2[2]);
        var denom = Math.sqrt(l2[0] * l2[0] + l2[1] * l2[1]);
        if (denom < 1e-12) return 0;
        return num / denom;
    }

    /**
     * Pre-compute fundamental matrices for all camera pairs.
     *
     * @param {Camera[]} cameras - array of Camera objects (must have .projectionMatrix())
     * @returns {Object} { 'camA|camB': F, ... } keyed by sorted camera name pair
     */
    function computeFundamentalMatrices(cameras) {
        var fMatrices = {};
        for (var i = 0; i < cameras.length; i++) {
            for (var j = i + 1; j < cameras.length; j++) {
                var P1 = cameras[i].projectionMatrix();
                var P2 = cameras[j].projectionMatrix();
                var F = computeFundamentalMatrix(P1, P2);
                if (F) {
                    var key = cameras[i].name + '|' + cameras[j].name;
                    fMatrices[key] = F;
                }
            }
        }
        return fMatrices;
    }

    // --------------------------------------------------
    // 1. Reprojection Error Metrics
    // --------------------------------------------------

    /**
     * Compute detailed reprojection error metrics for a single InstanceGroup.
     *
     * @param {Object} triResult - { errors: {camName: [err|null, ...]}, meanError }
     * @param {Object} config - reprojError config
     * @returns {{
     *   meanError: number|null,
     *   maxError: number,
     *   perKeypoint: (number|null)[],
     *   perCamera: Object.<string, {mean: number, max: number}>,
     *   outlierKeypoints: number[],
     *   severity: 'low'|'medium'|'high'
     * }}
     */
    function computeReprojMetrics(triResult, config) {
        config = config || DEFAULT_CONFIG.reprojError;
        var result = {
            meanError: triResult.meanError,
            maxError: 0,
            perKeypoint: [],
            perCamera: {},
            outlierKeypoints: [],
            severity: 'low',
        };

        if (!triResult.errors) return result;

        // Collect per-keypoint errors (mean across cameras for each keypoint)
        var camNames = Object.keys(triResult.errors);
        var numKeypoints = 0;
        for (var c = 0; c < camNames.length; c++) {
            numKeypoints = Math.max(numKeypoints, triResult.errors[camNames[c]].length);
        }

        for (var k = 0; k < numKeypoints; k++) {
            var kpErrors = [];
            for (var ci = 0; ci < camNames.length; ci++) {
                var err = triResult.errors[camNames[ci]][k];
                if (err != null) kpErrors.push(err);
            }
            if (kpErrors.length > 0) {
                var kpMean = mean(kpErrors);
                result.perKeypoint.push(kpMean);
                if (kpMean > result.maxError) result.maxError = kpMean;
                if (kpMean > config.high) {
                    result.outlierKeypoints.push(k);
                }
            } else {
                result.perKeypoint.push(null);
            }
        }

        // Per-camera stats
        for (var cc = 0; cc < camNames.length; cc++) {
            var cam = camNames[cc];
            var errs = triResult.errors[cam];
            var validErrs = [];
            for (var ki = 0; ki < errs.length; ki++) {
                if (errs[ki] != null) validErrs.push(errs[ki]);
            }
            if (validErrs.length > 0) {
                result.perCamera[cam] = {
                    mean: mean(validErrs),
                    max: Math.max.apply(null, validErrs),
                };
            }
        }

        // Severity classification
        var me = result.meanError;
        if (me == null) {
            result.severity = 'low';
        } else if (me > config.high) {
            result.severity = 'high';
        } else if (me > config.medium) {
            result.severity = 'medium';
        } else {
            result.severity = 'low';
        }

        return result;
    }

    // --------------------------------------------------
    // 2. Limb Length Consistency
    // --------------------------------------------------

    /**
     * Compute 3D limb lengths for a single frame's InstanceGroup.
     *
     * @param {(number[]|null)[]} points3d - triangulated 3D points
     * @param {[number,number][]} edges - skeleton edge pairs
     * @returns {(number|null)[]} length per edge, null if either endpoint is null
     */
    function computeLimbLengths(points3d, edges) {
        if (!points3d || !edges) return [];
        var lengths = [];
        for (var i = 0; i < edges.length; i++) {
            var a = points3d[edges[i][0]];
            var b = points3d[edges[i][1]];
            if (a && b) {
                lengths.push(dist3d(a, b));
            } else {
                lengths.push(null);
            }
        }
        return lengths;
    }

    /**
     * Compute limb length statistics across multiple frames.
     *
     * @param {Map<number, Object[]>} triResults - frameIdx -> [{group, points3d, ...}, ...]
     * @param {[number,number][]} edges - skeleton edges
     * @param {number} trackIdx - which track to analyze
     * @returns {{
     *   perEdge: {mean: number, stddev: number, cv: number, values: number[]}[],
     *   flaggedEdges: number[],
     *   allLengths: Map<number, (number|null)[]>
     * }}
     */
    function computeLimbLengthStats(triResults, edges, trackIdx, config) {
        config = config || DEFAULT_CONFIG.limbLength;

        // Collect limb lengths per edge across all frames
        var perEdge = [];
        for (var e = 0; e < edges.length; e++) {
            perEdge.push({ values: [] });
        }

        var allLengths = new Map();

        triResults.forEach(function (frameResults, frameIdx) {
            for (var r = 0; r < frameResults.length; r++) {
                var res = frameResults[r];
                if (res.group && res.group.trackIdx !== trackIdx) continue;
                if (!res.points3d) continue;

                var lengths = computeLimbLengths(res.points3d, edges);
                allLengths.set(frameIdx, lengths);

                for (var ei = 0; ei < lengths.length; ei++) {
                    if (lengths[ei] != null) {
                        perEdge[ei].values.push(lengths[ei]);
                    }
                }
            }
        });

        // Compute stats per edge
        var flaggedEdges = [];
        for (var ei = 0; ei < perEdge.length; ei++) {
            var vals = perEdge[ei].values;
            if (vals.length >= 2) {
                perEdge[ei].mean = mean(vals);
                perEdge[ei].stddev = stddev(vals);
                perEdge[ei].cv = perEdge[ei].mean > 0
                    ? perEdge[ei].stddev / perEdge[ei].mean
                    : 0;
                if (perEdge[ei].cv > config.cvThreshold) {
                    flaggedEdges.push(ei);
                }
            } else if (vals.length === 1) {
                perEdge[ei].mean = vals[0];
                perEdge[ei].stddev = 0;
                perEdge[ei].cv = 0;
            } else {
                perEdge[ei].mean = null;
                perEdge[ei].stddev = null;
                perEdge[ei].cv = null;
            }
        }

        return {
            perEdge: perEdge,
            flaggedEdges: flaggedEdges,
            allLengths: allLengths,
        };
    }

    // --------------------------------------------------
    // 3. Temporal Smoothness (Jitter Detection)
    // --------------------------------------------------

    /**
     * Compute per-keypoint velocity (displacement per frame) for a given track.
     *
     * @param {Map<number, Object[]>} triResults - frameIdx -> [{group, points3d, ...}, ...]
     * @param {number} trackIdx - which track
     * @returns {{
     *   frameIndices: number[],
     *   perKeypoint: {velocities: (number|null)[], frameIndices: number[]}[],
     *   meanVelocity: (number|null)[],
     *   maxVelocity: number,
     *   flaggedFrames: number[]
     * }}
     */
    function computeTemporalMetrics(triResults, trackIdx, numKeypoints, config) {
        config = config || DEFAULT_CONFIG.temporal;

        // Collect points3d per frame for this track, sorted by frame index
        var framePoints = [];
        triResults.forEach(function (frameResults, frameIdx) {
            for (var r = 0; r < frameResults.length; r++) {
                var res = frameResults[r];
                if (res.group && res.group.trackIdx !== trackIdx) continue;
                if (!res.points3d) continue;
                framePoints.push({ frameIdx: frameIdx, points3d: res.points3d });
            }
        });

        framePoints.sort(function (a, b) { return a.frameIdx - b.frameIdx; });

        if (framePoints.length < 2) {
            return {
                frameIndices: framePoints.map(function (fp) { return fp.frameIdx; }),
                perKeypoint: [],
                meanVelocity: [],
                maxVelocity: 0,
                flaggedFrames: [],
            };
        }

        // Compute velocities between consecutive frames
        var perKeypoint = [];
        for (var k = 0; k < numKeypoints; k++) {
            perKeypoint.push({ velocities: [], frameIndices: [] });
        }
        var meanVelocities = [];
        var allVelocities = [];

        for (var i = 1; i < framePoints.length; i++) {
            var prev = framePoints[i - 1];
            var curr = framePoints[i];
            var dt = curr.frameIdx - prev.frameIdx;
            if (dt <= 0) continue;

            var frameVelocities = [];
            for (var k = 0; k < numKeypoints; k++) {
                var pp = prev.points3d[k];
                var cp = curr.points3d[k];
                if (pp && cp) {
                    var v = dist3d(pp, cp) / dt;
                    perKeypoint[k].velocities.push(v);
                    perKeypoint[k].frameIndices.push(curr.frameIdx);
                    frameVelocities.push(v);
                    allVelocities.push(v);
                }
            }
            meanVelocities.push({
                frameIdx: curr.frameIdx,
                velocity: frameVelocities.length > 0 ? mean(frameVelocities) : null,
            });
        }

        // Determine velocity threshold
        var threshold;
        if (config.maxVelocity != null) {
            threshold = config.maxVelocity;
        } else if (allVelocities.length > 0) {
            var sorted = allVelocities.slice().sort(function (a, b) { return a - b; });
            threshold = percentile(sorted, config.velocityPercentile);
        } else {
            threshold = Infinity;
        }

        // Flag frames where mean velocity exceeds threshold
        var flaggedFrames = [];
        var maxV = 0;
        for (var mi = 0; mi < meanVelocities.length; mi++) {
            var mv = meanVelocities[mi];
            if (mv.velocity != null) {
                if (mv.velocity > maxV) maxV = mv.velocity;
                if (mv.velocity > threshold) {
                    flaggedFrames.push(mv.frameIdx);
                }
            }
        }

        return {
            frameIndices: framePoints.map(function (fp) { return fp.frameIdx; }),
            perKeypoint: perKeypoint,
            meanVelocity: meanVelocities,
            maxVelocity: maxV,
            flaggedFrames: flaggedFrames,
            threshold: threshold,
        };
    }

    // --------------------------------------------------
    // 4. Completeness Scoring
    // --------------------------------------------------

    /**
     * Compute completeness metrics for a single InstanceGroup.
     *
     * @param {InstanceGroup} group
     * @param {Camera[]} cameras
     * @param {number} numKeypoints
     * @param {Object} config
     * @returns {{
     *   keypointVisibility: number[],
     *   cameraCoverage: Object.<string, number>,
     *   overallCompleteness: number,
     *   missingKeypoints: number[],
     *   severity: 'low'|'medium'|'high'
     * }}
     */
    function computeCompletenessMetrics(group, cameras, numKeypoints, config) {
        config = config || DEFAULT_CONFIG.completeness;

        // Count how many cameras see each keypoint
        var keypointVisibility = new Array(numKeypoints);
        for (var k = 0; k < numKeypoints; k++) keypointVisibility[k] = 0;

        var cameraCoverage = {};
        for (var ci = 0; ci < cameras.length; ci++) {
            var cam = cameras[ci];
            var inst = group.getInstance ? group.getInstance(cam.name) : null;
            var count = 0;
            if (inst && inst.points) {
                for (var k = 0; k < Math.min(inst.points.length, numKeypoints); k++) {
                    if (inst.points[k] != null) {
                        keypointVisibility[k]++;
                        count++;
                    }
                }
            }
            cameraCoverage[cam.name] = numKeypoints > 0 ? count / numKeypoints : 0;
        }

        // Find missing/undersampled keypoints
        var missingKeypoints = [];
        var totalVisible = 0;
        for (var k = 0; k < numKeypoints; k++) {
            if (keypointVisibility[k] < config.minCameras) {
                missingKeypoints.push(k);
            }
            totalVisible += keypointVisibility[k];
        }

        var maxPossible = numKeypoints * cameras.length;
        var overallCompleteness = maxPossible > 0 ? totalVisible / maxPossible : 0;

        // Severity: based on ratio of visible keypoints across at least minCameras
        var visibleRatio = numKeypoints > 0
            ? (numKeypoints - missingKeypoints.length) / numKeypoints
            : 1;

        var severity;
        if (visibleRatio < config.minKeypointRatio) {
            severity = 'high';
        } else if (missingKeypoints.length > 0) {
            severity = 'medium';
        } else {
            severity = 'low';
        }

        return {
            keypointVisibility: keypointVisibility,
            cameraCoverage: cameraCoverage,
            overallCompleteness: overallCompleteness,
            missingKeypoints: missingKeypoints,
            severity: severity,
        };
    }

    // --------------------------------------------------
    // 5. Per-Keypoint Per-Camera Error Analysis
    // --------------------------------------------------

    /**
     * Build a [keypoint × camera] error table from raw triangulation results,
     * identifying which specific bodyparts have outlier errors in which cameras.
     *
     * @param {Map<number, Object[]>} triangulationResults
     * @param {string[]} nodeNames - skeleton node names
     * @param {string[]} cameraNames
     * @returns {{
     *   table: Object,
     *   outliers: Object[],
     *   perCameraSummary: Object
     * }}
     */
    function computePerKeypointCameraErrors(triangulationResults, nodeNames, cameraNames) {
        // table[ki][cam] = { errors: number[] }
        var table = {};

        triangulationResults.forEach(function (frameResults) {
            for (var r = 0; r < frameResults.length; r++) {
                var res = frameResults[r];
                if (!res.errors) continue;
                var camKeys = Object.keys(res.errors);
                for (var ci = 0; ci < camKeys.length; ci++) {
                    var cam = camKeys[ci];
                    var errs = res.errors[cam];
                    for (var ki = 0; ki < errs.length; ki++) {
                        if (errs[ki] == null) continue;
                        if (!table[ki]) table[ki] = {};
                        if (!table[ki][cam]) table[ki][cam] = { errors: [] };
                        table[ki][cam].errors.push(errs[ki]);
                    }
                }
            }
        });

        // Compute per-keypoint per-camera stats
        var allKpIndices = Object.keys(table).map(Number).sort(function (a, b) { return a - b; });
        for (var t = 0; t < allKpIndices.length; t++) {
            var ki = allKpIndices[t];
            var cams = Object.keys(table[ki]);
            for (var ci = 0; ci < cams.length; ci++) {
                var cam = cams[ci];
                var errs = table[ki][cam].errors;
                var sorted = errs.slice().sort(function (a, b) { return a - b; });
                table[ki][cam].mean = mean(errs);
                table[ki][cam].median = median(errs);
                table[ki][cam].max = Math.max.apply(null, errs);
                table[ki][cam].p95 = percentile(sorted, 95);
                table[ki][cam].count = errs.length;
            }
        }

        // Detect outlier combinations: keypoint has much higher error in one camera vs others
        var outliers = [];
        for (var oi = 0; oi < allKpIndices.length; oi++) {
            var kIdx = allKpIndices[oi];
            var kCams = Object.keys(table[kIdx]);
            if (kCams.length < 2) continue;

            var camMeans = [];
            for (var cj = 0; cj < kCams.length; cj++) {
                camMeans.push({ cam: kCams[cj], mean: table[kIdx][kCams[cj]].mean });
            }
            camMeans.sort(function (a, b) { return a.mean - b.mean; });

            // Check if worst camera is significantly worse than the rest
            var worst = camMeans[camMeans.length - 1];
            var otherMeans = [];
            for (var om = 0; om < camMeans.length - 1; om++) {
                otherMeans.push(camMeans[om].mean);
            }
            var otherMed = median(otherMeans);

            // Outlier if: worst > 5px AND (others < 2px OR worst > 3x others)
            if (worst.mean > 5 && (otherMed < 2 || worst.mean > otherMed * 3)) {
                var otherCams = [];
                for (var oc = 0; oc < camMeans.length - 1; oc++) {
                    otherCams.push({ cam: camMeans[oc].cam, mean: camMeans[oc].mean });
                }
                outliers.push({
                    keypointIdx: kIdx,
                    keypointName: nodeNames[kIdx] || ('node_' + kIdx),
                    outlierCam: worst.cam,
                    outlierMean: worst.mean,
                    otherCams: otherCams,
                });
            }
        }

        // Sort outliers by error descending
        outliers.sort(function (a, b) { return b.outlierMean - a.outlierMean; });

        // Per-camera summary (mean error across all keypoints)
        var perCameraSummary = {};
        for (var sci = 0; sci < cameraNames.length; sci++) {
            var camName = cameraNames[sci];
            var allErrs = [];
            for (var ski = 0; ski < allKpIndices.length; ski++) {
                var kk = allKpIndices[ski];
                if (table[kk] && table[kk][camName]) {
                    allErrs = allErrs.concat(table[kk][camName].errors);
                }
            }
            if (allErrs.length > 0) {
                var sSorted = allErrs.slice().sort(function (a, b) { return a - b; });
                perCameraSummary[camName] = {
                    mean: mean(allErrs),
                    median: median(allErrs),
                    p95: percentile(sSorted, 95),
                    count: allErrs.length,
                };
            }
        }

        return {
            table: table,
            outliers: outliers,
            nodeNames: nodeNames,
            cameraNames: cameraNames,
            perCameraSummary: perCameraSummary,
        };
    }

    // --------------------------------------------------
    // 5b. Epipolar Metrics
    // --------------------------------------------------

    /**
     * Compute epipolar distance metrics for a single InstanceGroup across camera pairs.
     *
     * @param {InstanceGroup} group - the instance group
     * @param {Camera[]} cameras - all cameras
     * @param {Object} fMatrices - pre-computed fundamental matrices { 'camA|camB': F }
     * @param {number} numKeypoints
     * @returns {{
     *   perKeypoint: (number|null)[],
     *   flaggedKeypoints: number[],
     *   allDistances: number[],
     *   pairDistances: Object[]
     * }}
     */
    function computeEpipolarMetrics(group, cameras, fMatrices, numKeypoints) {
        var allDistances = [];
        var pairDistances = [];
        var perKeypointSums = new Array(numKeypoints);
        var perKeypointCounts = new Array(numKeypoints);
        for (var k = 0; k < numKeypoints; k++) {
            perKeypointSums[k] = 0;
            perKeypointCounts[k] = 0;
        }

        for (var i = 0; i < cameras.length; i++) {
            for (var j = i + 1; j < cameras.length; j++) {
                var key = cameras[i].name + '|' + cameras[j].name;
                var F = fMatrices[key];
                if (!F) continue;

                var inst1 = group.getInstance ? group.getInstance(cameras[i].name) : null;
                var inst2 = group.getInstance ? group.getInstance(cameras[j].name) : null;
                if (!inst1 || !inst2 || !inst1.points || !inst2.points) continue;

                for (var ki = 0; ki < numKeypoints; ki++) {
                    var p1 = inst1.points[ki];
                    var p2 = inst2.points[ki];
                    if (p1 == null || p2 == null) continue;

                    var d = computeEpipolarDistance(F, p1, p2);
                    allDistances.push(d);
                    perKeypointSums[ki] += d;
                    perKeypointCounts[ki]++;
                    pairDistances.push({
                        cam1: cameras[i].name,
                        cam2: cameras[j].name,
                        keypoint: ki,
                        distance: d,
                    });
                }
            }
        }

        var perKeypoint = [];
        for (var kk = 0; kk < numKeypoints; kk++) {
            perKeypoint.push(
                perKeypointCounts[kk] > 0
                    ? perKeypointSums[kk] / perKeypointCounts[kk]
                    : null
            );
        }

        return {
            perKeypoint: perKeypoint,
            flaggedKeypoints: [], // filled in by caller after auto-threshold
            allDistances: allDistances,
            pairDistances: pairDistances,
        };
    }

    // --------------------------------------------------
    // 5c. Per-Frame Limb Length Outliers
    // --------------------------------------------------

    /**
     * Detect per-frame limb length outliers using z-score against the
     * pre-computed limb length stats.
     *
     * @param {Object} limbStats - output of computeLimbLengthStats for one track
     * @param {Object} config - limbLengthOutlier config
     * @returns {{
     *   flaggedFrames: Map<number, {edgeIdx: number, length: number, zScore: number}[]>,
     *   allZScores: number[]
     * }}
     */
    function computeLimbLengthOutliers(limbStats, config) {
        config = config || DEFAULT_CONFIG.limbLengthOutlier;
        var flaggedFrames = new Map();
        var allZScores = [];

        limbStats.allLengths.forEach(function (lengths, frameIdx) {
            var frameFlags = [];
            for (var ei = 0; ei < lengths.length; ei++) {
                if (lengths[ei] == null) continue;
                var edge = limbStats.perEdge[ei];
                if (edge.mean == null || edge.stddev == null || edge.stddev < 1e-9) continue;

                var zScore = Math.abs(lengths[ei] - edge.mean) / edge.stddev;
                allZScores.push(zScore);

                if (zScore > config.zScoreThreshold) {
                    frameFlags.push({ edgeIdx: ei, length: lengths[ei], zScore: zScore });
                }
            }
            if (frameFlags.length > 0) {
                flaggedFrames.set(frameIdx, frameFlags);
            }
        });

        return {
            flaggedFrames: flaggedFrames,
            allZScores: allZScores,
        };
    }

    // --------------------------------------------------
    // 5d. Swap Detection (multi-instance)
    // --------------------------------------------------

    /**
     * Detect identity swaps between instance groups in a single frame.
     * For each camera, check if instance A's detection is closer to instance B's
     * reprojected position than to A's own reprojection.
     *
     * @param {Object[]} frameResults - array of triangulation results for this frame
     * @param {Camera[]} cameras
     * @param {number} numKeypoints
     * @param {Object} config - swap config
     * @returns {Object[]} array of { type, severity, keypoints, description }
     */
    function detectSwaps(frameResults, cameras, numKeypoints, config) {
        config = config || DEFAULT_CONFIG.swap;
        if (frameResults.length < 2) return [];

        var issues = [];

        // Compare all pairs of instance results
        for (var a = 0; a < frameResults.length; a++) {
            for (var b = a + 1; b < frameResults.length; b++) {
                var resA = frameResults[a];
                var resB = frameResults[b];
                if (!resA.reprojections || !resB.reprojections) continue;
                if (!resA.group || !resB.group) continue;

                var swapCount = 0;
                var swapKeypoints = [];

                var camNames = Object.keys(resA.reprojections);
                for (var ci = 0; ci < camNames.length; ci++) {
                    var cam = camNames[ci];
                    if (!resB.reprojections[cam]) continue;

                    var instA = resA.group.getInstance ? resA.group.getInstance(cam) : null;
                    var instB = resB.group.getInstance ? resB.group.getInstance(cam) : null;
                    if (!instA || !instB || !instA.points || !instB.points) continue;

                    for (var ki = 0; ki < numKeypoints; ki++) {
                        var detA = instA.points[ki];
                        var detB = instB.points[ki];
                        var reprojA = resA.reprojections[cam][ki];
                        var reprojB = resB.reprojections[cam][ki];
                        if (!detA || !detB || !reprojA || !reprojB) continue;

                        // Distance from A's detection to A's reprojection vs B's reprojection
                        var dxAA = detA[0] - reprojA[0], dyAA = detA[1] - reprojA[1];
                        var dAA = Math.sqrt(dxAA * dxAA + dyAA * dyAA);
                        var dxAB = detA[0] - reprojB[0], dyAB = detA[1] - reprojB[1];
                        var dAB = Math.sqrt(dxAB * dxAB + dyAB * dyAB);

                        // If A's detection is closer to B's reprojection by a margin
                        if (dAB < dAA * config.marginRatio && dAA > 5) {
                            swapCount++;
                            if (swapKeypoints.indexOf(ki) < 0) swapKeypoints.push(ki);
                        }
                    }
                }

                if (swapCount > 0) {
                    issues.push({
                        type: 'swap',
                        severity: swapCount >= 3 ? 'high' : 'medium',
                        keypoints: swapKeypoints,
                        description: 'Possible identity swap between track ' +
                            resA.group.trackIdx + ' and track ' + resB.group.trackIdx +
                            ' (' + swapCount + ' keypoint(s) crossed)',
                    });
                }
            }
        }

        return issues;
    }

    // --------------------------------------------------
    // 5e. Auto-Thresholding
    // --------------------------------------------------

    /**
     * Compute percentile-based thresholds from metric distributions.
     *
     * @param {Object} distributions - { reproj: [], epipolar: [], velocity: [], limbZScore: [] }
     * @param {Object} config - autoThreshold config
     * @returns {{ reproj: number, epipolar: number, velocity: number, limbZScore: number }}
     */
    function computeAutoThresholds(distributions, config) {
        config = config || DEFAULT_CONFIG.autoThreshold;
        var p = config.percentile;
        var result = {};
        var keys = Object.keys(distributions);
        for (var i = 0; i < keys.length; i++) {
            var arr = distributions[keys[i]];
            if (arr.length > 0) {
                var sorted = arr.slice().sort(function (a, b) { return a - b; });
                result[keys[i]] = percentile(sorted, p);
            } else {
                result[keys[i]] = Infinity;
            }
        }
        return result;
    }

    // --------------------------------------------------
    // 5f. Histogram Renderer
    // --------------------------------------------------

    /**
     * Draw a compact bar histogram on a canvas element.
     *
     * @param {HTMLCanvasElement} canvas
     * @param {number[]} values - raw metric values
     * @param {number} threshold - auto-threshold to draw as a line
     * @param {Object} options - { title: string, color: string }
     */
    function drawHistogram(canvas, values, threshold, options) {
        options = options || {};
        var ctx = canvas.getContext('2d');
        var w = canvas.width;
        var h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        if (!values || values.length === 0) {
            ctx.fillStyle = '#888';
            ctx.font = '10px monospace';
            ctx.fillText('No data', 4, h / 2);
            return { displayMax: 0 };
        }

        var sorted = values.slice().sort(function (a, b) { return a - b; });
        // Clamp display range to 99th percentile to avoid long tails
        var displayMax = percentile(sorted, 99);
        if (displayMax <= 0) displayMax = sorted[sorted.length - 1] || 1;

        var padLeft = 4;
        var plotWidth = w - 8;
        var numBins = Math.min(40, Math.max(10, Math.floor(w / 6)));
        var binWidth = displayMax / numBins;
        var bins = new Array(numBins).fill(0);

        for (var i = 0; i < values.length; i++) {
            var idx = Math.min(numBins - 1, Math.floor(values[i] / binWidth));
            if (idx < 0) idx = 0;
            bins[idx]++;
        }

        var maxCount = Math.max.apply(null, bins);
        if (maxCount === 0) maxCount = 1;

        var titleHeight = 14;
        var plotTop = titleHeight;
        var plotHeight = h - titleHeight - 4;
        var barW = plotWidth / numBins;

        // Title
        if (options.title) {
            ctx.fillStyle = '#ccc';
            ctx.font = '10px monospace';
            ctx.fillText(options.title, padLeft, 10);
        }

        // Bars
        var thresholdBinIdx = Math.min(numBins - 1, Math.floor(threshold / binWidth));
        var baseColor = options.color || '#6b7280';
        var outlierColor = '#ef4444';

        for (var bi = 0; bi < numBins; bi++) {
            var barH = (bins[bi] / maxCount) * plotHeight;
            var x = padLeft + bi * barW;
            var y = plotTop + plotHeight - barH;
            ctx.fillStyle = bi >= thresholdBinIdx ? outlierColor : baseColor;
            ctx.fillRect(x, y, Math.max(1, barW - 1), barH);
        }

        // Threshold line
        var threshX = padLeft + (threshold / displayMax) * plotWidth;
        if (threshX > padLeft && threshX < padLeft + plotWidth) {
            ctx.strokeStyle = '#f97316';
            ctx.setLineDash([3, 2]);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(threshX, plotTop);
            ctx.lineTo(threshX, plotTop + plotHeight);
            ctx.stroke();
            ctx.setLineDash([]);

            // Threshold value label
            ctx.fillStyle = '#f97316';
            ctx.font = '9px monospace';
            var threshLabel = threshold.toFixed(1);
            var labelW = ctx.measureText(threshLabel).width;
            var labelX = threshX + 3;
            if (labelX + labelW > w - 2) labelX = threshX - labelW - 3;
            ctx.fillText(threshLabel, labelX, plotTop + 10);
        }

        // Outlier count label
        var outlierCount = 0;
        for (var oi = 0; oi < values.length; oi++) {
            if (values[oi] > threshold) outlierCount++;
        }
        if (outlierCount > 0) {
            ctx.fillStyle = outlierColor;
            ctx.font = '9px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(outlierCount + ' outlier' + (outlierCount > 1 ? 's' : ''), w - 4, 10);
            ctx.textAlign = 'left';
        }

        // Store layout info on canvas for drag interaction
        canvas._histLayout = {
            displayMax: displayMax,
            padLeft: padLeft,
            plotWidth: plotWidth,
        };

        return { displayMax: displayMax };
    }

    // --------------------------------------------------
    // 6. Error Classification (Ronchi & Perona taxonomy)
    // --------------------------------------------------

    /**
     * Classify errors for a single InstanceGroup.
     * Uses raw per-keypoint per-camera errors from triResult for specific descriptions.
     *
     * @param {Object} reprojMetrics - from computeReprojMetrics
     * @param {Object} completenessMetrics - from computeCompletenessMetrics
     * @param {Object} temporalInfo - { isJitter: boolean }
     * @param {Object} rawErrors - triResult.errors {camName: [err|null, ...]}
     * @param {string[]} nodeNames - skeleton node names
     * @param {Object} [extra] - { epipolarInfo, limbOutlierInfo, swapIssues }
     * @returns {Object[]} Array of { type, severity, keypoints, description }
     */
    function classifyErrors(reprojMetrics, completenessMetrics, temporalInfo, rawErrors, nodeNames, extra) {
        extra = extra || {};
        var issues = [];

        // MISS: keypoints visible in too few cameras
        if (completenessMetrics.missingKeypoints.length > 0) {
            var missingNames = completenessMetrics.missingKeypoints.map(function (ki) {
                return nodeNames && nodeNames[ki] ? nodeNames[ki] : 'kp' + ki;
            });
            issues.push({
                type: 'miss',
                severity: completenessMetrics.severity,
                keypoints: completenessMetrics.missingKeypoints,
                description: missingNames.join(', ') + ' — visible in <' +
                    (DEFAULT_CONFIG.completeness.minCameras) + ' cameras',
            });
        }

        // HIGH REPROJECTION ERROR with per-camera breakdown
        if (reprojMetrics.outlierKeypoints.length > 0 && rawErrors) {
            var camNames = Object.keys(rawErrors);
            for (var oki = 0; oki < reprojMetrics.outlierKeypoints.length; oki++) {
                var ki = reprojMetrics.outlierKeypoints[oki];
                var kpName = nodeNames && nodeNames[ki] ? nodeNames[ki] : 'kp' + ki;

                // Collect per-camera error for this keypoint
                var camErrs = [];
                for (var ci = 0; ci < camNames.length; ci++) {
                    var err = rawErrors[camNames[ci]][ki];
                    if (err != null) {
                        camErrs.push({ cam: camNames[ci], err: err });
                    }
                }
                camErrs.sort(function (a, b) { return b.err - a.err; });

                // Build description showing which camera is the outlier
                var desc;
                if (camErrs.length >= 2) {
                    var worst = camErrs[0];
                    var others = camErrs.slice(1).map(function (c) {
                        return c.cam + ': ' + c.err.toFixed(1) + 'px';
                    });
                    desc = kpName + ': ' + worst.err.toFixed(1) + 'px in ' + worst.cam +
                        ' (vs ' + others.join(', ') + ')';
                } else if (camErrs.length === 1) {
                    desc = kpName + ': ' + camErrs[0].err.toFixed(1) + 'px in ' + camErrs[0].cam;
                } else {
                    desc = kpName + ': high reprojection error';
                }

                // Determine if it's an inversion (error concentrated in one camera)
                var isInversion = false;
                if (camErrs.length >= 2) {
                    var worstErr = camErrs[0].err;
                    var otherMed = median(camErrs.slice(1).map(function (c) { return c.err; }));
                    if (worstErr > otherMed * 3 && otherMed < 3) {
                        isInversion = true;
                    }
                }

                issues.push({
                    type: isInversion ? 'inversion' : 'reprojection',
                    severity: 'high',
                    keypoints: [ki],
                    description: desc + (isInversion ? ' — possible mislabel' : ''),
                });
            }
        } else if (reprojMetrics.outlierKeypoints.length > 0) {
            // Fallback without raw errors
            issues.push({
                type: 'reprojection',
                severity: 'high',
                keypoints: reprojMetrics.outlierKeypoints,
                description: reprojMetrics.outlierKeypoints.length +
                    ' keypoint(s) with reprojection error > ' +
                    DEFAULT_CONFIG.reprojError.high + 'px',
            });
        }

        // JITTER: flagged by temporal analysis
        if (temporalInfo && temporalInfo.isJitter) {
            issues.push({
                type: 'jitter',
                severity: 'medium',
                keypoints: temporalInfo.jitterKeypoints || [],
                description: 'High frame-to-frame displacement detected',
            });
        }

        // EPIPOLAR: high pairwise epipolar distance
        if (extra.epipolarInfo && extra.epipolarInfo.flaggedKeypoints.length > 0) {
            var epiNames = extra.epipolarInfo.flaggedKeypoints.map(function (ki) {
                return nodeNames && nodeNames[ki] ? nodeNames[ki] : 'kp' + ki;
            });
            issues.push({
                type: 'epipolar',
                severity: 'medium',
                keypoints: extra.epipolarInfo.flaggedKeypoints,
                description: epiNames.join(', ') + ' — high epipolar distance',
            });
        }

        // LIMB OUTLIER: per-frame limb length z-score outlier
        if (extra.limbOutlierInfo && extra.limbOutlierInfo.length > 0) {
            var limbDescs = extra.limbOutlierInfo.map(function (f) {
                return 'edge ' + f.edgeIdx + ' (z=' + f.zScore.toFixed(1) + ')';
            });
            issues.push({
                type: 'limb_outlier',
                severity: extra.limbOutlierInfo.some(function (f) { return f.zScore > 5; }) ? 'high' : 'medium',
                keypoints: [],
                description: 'Abnormal limb length: ' + limbDescs.join(', '),
            });
        }

        // SWAP: cross-instance identity swaps (passed in directly)
        if (extra.swapIssues) {
            for (var si = 0; si < extra.swapIssues.length; si++) {
                issues.push(extra.swapIssues[si]);
            }
        }

        return issues;
    }

    // --------------------------------------------------
    // 7. Composite QC Score
    // --------------------------------------------------

    /**
     * Compute a 0-100 composite quality score.
     * 100 = perfect, 0 = worst.
     *
     * @param {Object} reprojMetrics
     * @param {Object} completenessMetrics
     * @param {number|null} limbLengthCV - coefficient of variation for this frame
     * @param {number|null} velocity - mean velocity at this frame
     * @param {number|null} velocityThreshold - threshold for velocity
     * @param {Object} weights
     * @returns {number} 0-100 score
     */
    function computeCompositeScore(reprojMetrics, completenessMetrics, limbLengthCV, velocity, velocityThreshold, weights) {
        weights = weights || DEFAULT_CONFIG.weights;

        // Reprojection score: 100 if error=0, 0 if error >= high threshold
        var reprojScore = 100;
        if (reprojMetrics.meanError != null) {
            reprojScore = Math.max(0, 100 * (1 - reprojMetrics.meanError / DEFAULT_CONFIG.reprojError.high));
        }

        // Completeness score: direct percentage
        var completenessScore = completenessMetrics.overallCompleteness * 100;

        // Limb length score: 100 if CV=0, 0 if CV >= threshold
        var limbScore = 100;
        if (limbLengthCV != null) {
            limbScore = Math.max(0, 100 * (1 - limbLengthCV / DEFAULT_CONFIG.limbLength.cvThreshold));
        }

        // Temporal score: 100 if no velocity, 0 if velocity >= threshold
        var temporalScore = 100;
        if (velocity != null && velocityThreshold != null && velocityThreshold > 0) {
            temporalScore = Math.max(0, 100 * (1 - velocity / (velocityThreshold * 2)));
        }

        return Math.round(
            weights.reprojection * reprojScore +
            weights.completeness * completenessScore +
            weights.limbLength * limbScore +
            weights.temporal * temporalScore
        );
    }

    // --------------------------------------------------
    // 8. Full QC Analysis
    // --------------------------------------------------

    /**
     * Run full QC analysis across all frames for a session.
     *
     * @param {Session} session
     * @param {Map<number, Object[]>} triangulationResults - state.triangulationResults
     * @param {Object} config - override defaults
     * @returns {{
     *   frameIssues: Map<number, Object[]>,
     *   frameSummaries: Map<number, Object>,
     *   globalStats: Object,
     *   limbLengthStats: Object,
     *   temporalStats: Object,
     *   flaggedFrames: Set<number>,
     *   sortedIssues: Object[]
     * }}
     */
    function runFullAnalysis(session, triangulationResults, config) {
        config = config || {};
        var reprojConfig = config.reprojError || DEFAULT_CONFIG.reprojError;
        var limbConfig = config.limbLength || DEFAULT_CONFIG.limbLength;
        var temporalConfig = config.temporal || DEFAULT_CONFIG.temporal;
        var completenessConfig = config.completeness || DEFAULT_CONFIG.completeness;
        var weights = config.weights || DEFAULT_CONFIG.weights;
        var limbOutlierConfig = config.limbLengthOutlier || DEFAULT_CONFIG.limbLengthOutlier;
        var swapConfig = config.swap || DEFAULT_CONFIG.swap;
        var autoThresholdConfig = config.autoThreshold || DEFAULT_CONFIG.autoThreshold;

        var skeleton = session.skeleton;
        var cameras = session.cameras;
        var numKeypoints = skeleton.nodes.length;
        var edges = skeleton.edges;

        // Determine unique track indices
        var trackIndices = new Set();
        triangulationResults.forEach(function (frameResults) {
            for (var r = 0; r < frameResults.length; r++) {
                if (frameResults[r].group) {
                    trackIndices.add(frameResults[r].group.trackIdx);
                }
            }
        });

        // Pre-compute fundamental matrices (once per session)
        var fundamentalMatrices = {};
        var hasProjMatrices = cameras.length >= 2 &&
            typeof cameras[0].projectionMatrix === 'function';
        if (hasProjMatrices) {
            try {
                fundamentalMatrices = computeFundamentalMatrices(cameras);
            } catch (e) {
                // Silently skip if camera matrices are degenerate
            }
        }

        // Limb length stats per track
        var limbLengthStats = {};
        trackIndices.forEach(function (trackIdx) {
            limbLengthStats[trackIdx] = computeLimbLengthStats(
                triangulationResults, edges, trackIdx, limbConfig
            );
        });

        // Limb length outliers per track
        var limbOutlierStats = {};
        trackIndices.forEach(function (trackIdx) {
            limbOutlierStats[trackIdx] = computeLimbLengthOutliers(
                limbLengthStats[trackIdx], limbOutlierConfig
            );
        });

        // Temporal metrics per track
        var temporalStats = {};
        trackIndices.forEach(function (trackIdx) {
            temporalStats[trackIdx] = computeTemporalMetrics(
                triangulationResults, trackIdx, numKeypoints, temporalConfig
            );
        });

        // First pass: collect all metric distributions for auto-thresholding
        var distributions = { reproj: [], epipolar: [], velocity: [], limbZScore: [] };

        // Reproj
        triangulationResults.forEach(function (frameResults) {
            for (var r = 0; r < frameResults.length; r++) {
                if (frameResults[r].meanError != null) {
                    distributions.reproj.push(frameResults[r].meanError);
                }
            }
        });

        // Velocity
        trackIndices.forEach(function (trackIdx) {
            var ts = temporalStats[trackIdx];
            for (var i = 0; i < ts.meanVelocity.length; i++) {
                if (ts.meanVelocity[i].velocity != null) {
                    distributions.velocity.push(ts.meanVelocity[i].velocity);
                }
            }
        });

        // Limb z-scores
        trackIndices.forEach(function (trackIdx) {
            var lo = limbOutlierStats[trackIdx];
            for (var i = 0; i < lo.allZScores.length; i++) {
                distributions.limbZScore.push(lo.allZScores[i]);
            }
        });

        // Epipolar: compute for all groups (first pass to gather distribution)
        var hasFMatrices = Object.keys(fundamentalMatrices).length > 0;
        if (hasFMatrices) {
            triangulationResults.forEach(function (frameResults) {
                for (var r = 0; r < frameResults.length; r++) {
                    var group = frameResults[r].group;
                    if (!group || !group.getInstance) continue;
                    var epi = computeEpipolarMetrics(group, cameras, fundamentalMatrices, numKeypoints);
                    for (var di = 0; di < epi.allDistances.length; di++) {
                        distributions.epipolar.push(epi.allDistances[di]);
                    }
                }
            });
        }

        // Auto-thresholds (allow caller overrides)
        var autoThresholds = computeAutoThresholds(distributions, autoThresholdConfig);
        if (config.overrideThresholds) {
            var ot = config.overrideThresholds;
            var otKeys = Object.keys(ot);
            for (var oti = 0; oti < otKeys.length; oti++) {
                autoThresholds[otKeys[oti]] = ot[otKeys[oti]];
            }
        }

        // Per-frame analysis
        var frameIssues = new Map();
        var frameSummaries = new Map();
        var flaggedFrames = new Set();
        var allSortedIssues = [];

        var allErrors = distributions.reproj.slice();
        allErrors.sort(function (a, b) { return a - b; });
        var errorP95 = allErrors.length > 0 ? percentile(allErrors, 95) : 10;

        // Use auto-threshold for reprojection outlier detection instead of fixed threshold.
        // This ensures only the extreme tail gets flagged, not every frame above a fixed cutoff.
        var effectiveReprojHigh = autoThresholds.reproj != null && isFinite(autoThresholds.reproj)
            ? autoThresholds.reproj
            : reprojConfig.high;
        var effectiveReprojConfig = {
            low: effectiveReprojHigh * 0.2,
            medium: effectiveReprojHigh * 0.5,
            high: effectiveReprojHigh,
        };

        var totalFrames = 0;
        var totalScore = 0;

        triangulationResults.forEach(function (frameResults, frameIdx) {
            var frameIssueList = [];

            // Swap detection (multi-instance per frame)
            var swapIssues = detectSwaps(frameResults, cameras, numKeypoints, swapConfig);

            for (var r = 0; r < frameResults.length; r++) {
                var res = frameResults[r];
                var group = res.group;
                var trackIdx = group ? group.trackIdx : 0;

                // Reprojection metrics (using auto-threshold for outlier detection)
                var reprojMetrics = computeReprojMetrics(res, effectiveReprojConfig);

                // Completeness metrics
                var completenessMetrics;
                if (group && group.getInstance) {
                    completenessMetrics = computeCompletenessMetrics(
                        group, cameras, numKeypoints, completenessConfig
                    );
                } else {
                    completenessMetrics = {
                        keypointVisibility: [],
                        cameraCoverage: {},
                        overallCompleteness: 0,
                        missingKeypoints: [],
                        severity: 'high',
                    };
                }

                // Temporal info for this frame
                var isJitter = false;
                var jitterKeypoints = [];
                if (temporalStats[trackIdx]) {
                    var ts = temporalStats[trackIdx];
                    if (ts.flaggedFrames.indexOf(frameIdx) >= 0) {
                        isJitter = true;
                    }
                }

                // Limb length CV for this frame
                var limbCV = null;
                if (limbLengthStats[trackIdx]) {
                    var ll = limbLengthStats[trackIdx];
                    var frameLengths = ll.allLengths.get(frameIdx);
                    if (frameLengths) {
                        var cvs = [];
                        for (var ei = 0; ei < frameLengths.length; ei++) {
                            if (frameLengths[ei] != null && ll.perEdge[ei].mean != null && ll.perEdge[ei].mean > 0) {
                                var dev = Math.abs(frameLengths[ei] - ll.perEdge[ei].mean) / ll.perEdge[ei].mean;
                                cvs.push(dev);
                            }
                        }
                        if (cvs.length > 0) limbCV = mean(cvs);
                    }
                }

                // Epipolar metrics for this group
                var epipolarInfo = null;
                if (hasFMatrices && group && group.getInstance) {
                    epipolarInfo = computeEpipolarMetrics(group, cameras, fundamentalMatrices, numKeypoints);
                    // Flag keypoints above auto-threshold
                    var epiThresh = autoThresholds.epipolar != null ? autoThresholds.epipolar : Infinity;
                    var flaggedKps = [];
                    for (var eki = 0; eki < epipolarInfo.perKeypoint.length; eki++) {
                        if (epipolarInfo.perKeypoint[eki] != null && epipolarInfo.perKeypoint[eki] > epiThresh) {
                            flaggedKps.push(eki);
                        }
                    }
                    epipolarInfo.flaggedKeypoints = flaggedKps;
                }

                // Limb length outliers for this frame
                var limbOutlierInfo = null;
                if (limbOutlierStats[trackIdx]) {
                    var lo = limbOutlierStats[trackIdx];
                    var frameLimbFlags = lo.flaggedFrames.get(frameIdx);
                    if (frameLimbFlags) {
                        limbOutlierInfo = frameLimbFlags;
                    }
                }

                // Velocity at this frame
                var velocity = null;
                var velThreshold = null;
                if (temporalStats[trackIdx]) {
                    var ts2 = temporalStats[trackIdx];
                    velThreshold = ts2.threshold;
                    for (var vi = 0; vi < ts2.meanVelocity.length; vi++) {
                        if (ts2.meanVelocity[vi].frameIdx === frameIdx) {
                            velocity = ts2.meanVelocity[vi].velocity;
                            break;
                        }
                    }
                }

                // Classify errors (with raw per-camera data + new metrics)
                var issues = classifyErrors(reprojMetrics, completenessMetrics, {
                    isJitter: isJitter,
                    jitterKeypoints: jitterKeypoints,
                }, res.errors, skeleton.nodes, {
                    epipolarInfo: epipolarInfo,
                    limbOutlierInfo: limbOutlierInfo,
                    swapIssues: r === 0 ? swapIssues : [], // only attach swap to first result
                });

                // Composite score
                var score = computeCompositeScore(
                    reprojMetrics, completenessMetrics, limbCV, velocity, velThreshold, weights
                );

                // Add issues with frame context
                for (var ii = 0; ii < issues.length; ii++) {
                    var issue = issues[ii];
                    issue.frameIdx = frameIdx;
                    issue.trackIdx = trackIdx;
                    issue.groupId = group ? group.id : null;
                    issue.score = score;
                    frameIssueList.push(issue);
                    allSortedIssues.push(issue);
                }

                if (issues.length > 0) {
                    flaggedFrames.add(frameIdx);
                }

                // Frame summary
                if (!frameSummaries.has(frameIdx)) {
                    frameSummaries.set(frameIdx, {
                        frameIdx: frameIdx,
                        score: score,
                        issueCount: issues.length,
                        meanError: reprojMetrics.meanError,
                        completeness: completenessMetrics.overallCompleteness,
                    });
                } else {
                    var existing = frameSummaries.get(frameIdx);
                    existing.score = Math.min(existing.score, score);
                    existing.issueCount += issues.length;
                    if (reprojMetrics.meanError != null) {
                        existing.meanError = existing.meanError != null
                            ? Math.max(existing.meanError, reprojMetrics.meanError)
                            : reprojMetrics.meanError;
                    }
                }

                totalFrames++;
                totalScore += score;
            }

            if (frameIssueList.length > 0) {
                frameIssues.set(frameIdx, frameIssueList);
            }
        });

        // Sort issues: high severity first, then by frame index
        var severityOrder = { high: 0, medium: 1, low: 2 };
        allSortedIssues.sort(function (a, b) {
            var sa = severityOrder[a.severity] != null ? severityOrder[a.severity] : 3;
            var sb = severityOrder[b.severity] != null ? severityOrder[b.severity] : 3;
            if (sa !== sb) return sa - sb;
            return a.frameIdx - b.frameIdx;
        });

        // Global stats
        var globalStats = {
            totalFrames: totalFrames,
            flaggedFrameCount: flaggedFrames.size,
            totalIssues: allSortedIssues.length,
            meanScore: totalFrames > 0 ? Math.round(totalScore / totalFrames) : 100,
            meanReprojError: allErrors.length > 0 ? mean(allErrors) : null,
            errorP95: errorP95,
            issuesByType: {},
        };

        // Count issues by type
        for (var si = 0; si < allSortedIssues.length; si++) {
            var t = allSortedIssues[si].type;
            globalStats.issuesByType[t] = (globalStats.issuesByType[t] || 0) + 1;
        }

        // Per-keypoint per-camera error analysis (the 3D-specific insight)
        var cameraNames = cameras.map(function (c) { return c.name; });
        var bodypartCameraErrors = computePerKeypointCameraErrors(
            triangulationResults, skeleton.nodes, cameraNames
        );

        return {
            frameIssues: frameIssues,
            frameSummaries: frameSummaries,
            globalStats: globalStats,
            limbLengthStats: limbLengthStats,
            temporalStats: temporalStats,
            flaggedFrames: flaggedFrames,
            sortedIssues: allSortedIssues,
            bodypartCameraErrors: bodypartCameraErrors,
            distributions: distributions,
            autoThresholds: autoThresholds,
            fundamentalMatrices: fundamentalMatrices,
            limbOutlierStats: limbOutlierStats,
        };
    }

    // --------------------------------------------------
    // 8. Navigation Helpers
    // --------------------------------------------------

    /**
     * Get the next flagged frame after currentFrame.
     * Wraps around to the beginning if needed.
     */
    function nextFlaggedFrame(flaggedFrames, currentFrame) {
        var frames = Array.from(flaggedFrames).sort(function (a, b) { return a - b; });
        if (frames.length === 0) return null;
        for (var i = 0; i < frames.length; i++) {
            if (frames[i] > currentFrame) return frames[i];
        }
        return frames[0]; // wrap around
    }

    /**
     * Get the previous flagged frame before currentFrame.
     * Wraps around to the end if needed.
     */
    function prevFlaggedFrame(flaggedFrames, currentFrame) {
        var frames = Array.from(flaggedFrames).sort(function (a, b) { return a - b; });
        if (frames.length === 0) return null;
        for (var i = frames.length - 1; i >= 0; i--) {
            if (frames[i] < currentFrame) return frames[i];
        }
        return frames[frames.length - 1]; // wrap around
    }

    // --------------------------------------------------
    // Public API
    // --------------------------------------------------

    return {
        DEFAULT_CONFIG: DEFAULT_CONFIG,
        computeReprojMetrics: computeReprojMetrics,
        computeLimbLengths: computeLimbLengths,
        computeLimbLengthStats: computeLimbLengthStats,
        computeTemporalMetrics: computeTemporalMetrics,
        computeCompletenessMetrics: computeCompletenessMetrics,
        computePerKeypointCameraErrors: computePerKeypointCameraErrors,
        classifyErrors: classifyErrors,
        computeCompositeScore: computeCompositeScore,
        runFullAnalysis: runFullAnalysis,
        nextFlaggedFrame: nextFlaggedFrame,
        prevFlaggedFrame: prevFlaggedFrame,
        // New metric functions
        computeFundamentalMatrix: computeFundamentalMatrix,
        computeEpipolarDistance: computeEpipolarDistance,
        computeFundamentalMatrices: computeFundamentalMatrices,
        computeEpipolarMetrics: computeEpipolarMetrics,
        computeLimbLengthOutliers: computeLimbLengthOutliers,
        detectSwaps: detectSwaps,
        computeAutoThresholds: computeAutoThresholds,
        drawHistogram: drawHistogram,
        // Utility exports for testing
        _dist3d: dist3d,
        _percentile: percentile,
        _mean: mean,
        _stddev: stddev,
        _median: median,
        _invert3x3: invert3x3,
        _skewMatrix: skewMatrix,
    };
})();
