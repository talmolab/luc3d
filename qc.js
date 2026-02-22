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
     * @returns {Object[]} Array of { type, severity, keypoints, description }
     */
    function classifyErrors(reprojMetrics, completenessMetrics, temporalInfo, rawErrors, nodeNames) {
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

        var skeleton = session.skeleton;
        var cameras = session.cameras;
        var numKeypoints = skeleton.nodes.length;
        var edges = skeleton.edges;
        var tracks = session.tracks || [];

        // Determine unique track indices
        var trackIndices = new Set();
        triangulationResults.forEach(function (frameResults) {
            for (var r = 0; r < frameResults.length; r++) {
                if (frameResults[r].group) {
                    trackIndices.add(frameResults[r].group.trackIdx);
                }
            }
        });

        // Limb length stats per track
        var limbLengthStats = {};
        trackIndices.forEach(function (trackIdx) {
            limbLengthStats[trackIdx] = computeLimbLengthStats(
                triangulationResults, edges, trackIdx, limbConfig
            );
        });

        // Temporal metrics per track
        var temporalStats = {};
        trackIndices.forEach(function (trackIdx) {
            temporalStats[trackIdx] = computeTemporalMetrics(
                triangulationResults, trackIdx, numKeypoints, temporalConfig
            );
        });

        // Per-frame analysis
        var frameIssues = new Map();
        var frameSummaries = new Map();
        var flaggedFrames = new Set();
        var allSortedIssues = [];

        // Collect all reprojection errors for percentile computation
        var allErrors = [];
        triangulationResults.forEach(function (frameResults) {
            for (var r = 0; r < frameResults.length; r++) {
                if (frameResults[r].meanError != null) {
                    allErrors.push(frameResults[r].meanError);
                }
            }
        });
        allErrors.sort(function (a, b) { return a - b; });
        var errorP95 = allErrors.length > 0 ? percentile(allErrors, 95) : 10;

        var totalFrames = 0;
        var totalScore = 0;

        triangulationResults.forEach(function (frameResults, frameIdx) {
            var frameIssueList = [];

            for (var r = 0; r < frameResults.length; r++) {
                var res = frameResults[r];
                var group = res.group;
                var trackIdx = group ? group.trackIdx : 0;

                // Reprojection metrics
                var reprojMetrics = computeReprojMetrics(res, reprojConfig);

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
                        // Compute per-edge deviation from mean
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

                // Classify errors (with raw per-camera data for specific descriptions)
                var issues = classifyErrors(reprojMetrics, completenessMetrics, {
                    isJitter: isJitter,
                    jitterKeypoints: jitterKeypoints,
                }, res.errors, skeleton.nodes);

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
        // Utility exports for testing
        _dist3d: dist3d,
        _percentile: percentile,
        _mean: mean,
        _stddev: stddev,
        _median: median,
    };
})();
