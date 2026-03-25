/**
 * tracker.js — Cross-view instance matching and identity assignment.
 *
 * Scores every instance combination across views using:
 *   1. Reprojection consistency (OKS-style): triangulate a pair, reproject
 *      back to both views, measure how well reprojections match originals.
 *   2. Epipolar constraint: how well points satisfy epipolar geometry.
 *
 * Combined score drives Hungarian assignment to group instances into
 * cross-view identities.
 *
 * Depends on: pose-data.js, triangulation.js
 */

// ============================================
// Pairwise scoring functions
// ============================================

/**
 * Compute reprojection consistency score for a pair of instances from two cameras.
 *
 * Triangulates keypoints from the two views, reprojects back to both views,
 * then computes OKS-like similarity between original and reprojected points.
 *
 * @param {Instance} instA - Instance from camera A
 * @param {Camera} camA - Camera A
 * @param {Instance} instB - Instance from camera B
 * @param {Camera} camB - Camera B
 * @returns {number} Score in [0, 1] where 1 = perfect reprojection match, 0 = terrible
 */
function reprojectionConsistencyScore(instA, camA, instB, camB) {
    var ptsA = instA.points;
    var ptsB = instB.points;
    var numKp = Math.min(ptsA.length, ptsB.length);
    if (numKp === 0) return 0;

    var PA = camA.projectionMatrix;
    var PB = camB.projectionMatrix;

    var totalOks = 0;
    var validCount = 0;

    for (var k = 0; k < numKp; k++) {
        if (ptsA[k] == null || ptsB[k] == null) continue;

        // Undistort for triangulation
        var uA = camA.undistortPoint ? camA.undistortPoint(ptsA[k]) : ptsA[k];
        var uB = camB.undistortPoint ? camB.undistortPoint(ptsB[k]) : ptsB[k];

        // Triangulate this keypoint
        var pt3d = triangulatePointDLT([uA, uB], [PA, PB]);
        if (pt3d == null) continue;

        // Reproject to both views
        var repA = reprojectPoint(pt3d, PA);
        var repB = reprojectPoint(pt3d, PB);

        // Compute distance between original and reprojected (in pixels)
        var dxA = ptsA[k][0] - repA[0];
        var dyA = ptsA[k][1] - repA[1];
        var errA = Math.sqrt(dxA * dxA + dyA * dyA);

        var dxB = ptsB[k][0] - repB[0];
        var dyB = ptsB[k][1] - repB[1];
        var errB = Math.sqrt(dxB * dxB + dyB * dyB);

        // OKS-like score: exp(-err^2 / (2 * sigma^2))
        // sigma = 20 pixels is a reasonable scale for pose keypoints
        var sigma = 20.0;
        var oksA = Math.exp(-(errA * errA) / (2 * sigma * sigma));
        var oksB = Math.exp(-(errB * errB) / (2 * sigma * sigma));
        totalOks += (oksA + oksB) / 2;
        validCount++;
    }

    return validCount > 0 ? totalOks / validCount : 0;
}

/**
 * Compute epipolar constraint score for a pair of instances from two cameras.
 *
 * Lower epipolar error = higher score. Converts error to a [0, 1] similarity.
 *
 * @param {Instance} instA - Instance from camera A
 * @param {Camera} camA - Camera A
 * @param {Instance} instB - Instance from camera B
 * @param {Camera} camB - Camera B
 * @returns {number} Score in [0, 1] where 1 = perfect epipolar agreement
 */
function epipolarConstraintScore(instA, camA, instB, camB) {
    var F = computeFundamentalMatrix(camA, camB);
    var ptsA = instA.points;
    var ptsB = instB.points;
    var numKp = Math.min(ptsA.length, ptsB.length);

    var totalErr = 0;
    var validCount = 0;

    for (var k = 0; k < numKp; k++) {
        if (ptsA[k] == null || ptsB[k] == null) continue;

        var x1 = ptsA[k][0], y1 = ptsA[k][1];
        var x2 = ptsB[k][0], y2 = ptsB[k][1];

        // Epipolar line l = F * [x1, y1, 1]^T
        var l0 = F[0][0] * x1 + F[0][1] * y1 + F[0][2];
        var l1 = F[1][0] * x1 + F[1][1] * y1 + F[1][2];
        var l2 = F[2][0] * x1 + F[2][1] * y1 + F[2][2];

        // Distance from x2 to epipolar line
        var num = Math.abs(x2 * l0 + y2 * l1 + l2);
        var denom = Math.sqrt(l0 * l0 + l1 * l1);
        if (denom > 1e-12) {
            totalErr += num / denom;
            validCount++;
        }
    }

    if (validCount === 0) return 0;
    var meanErr = totalErr / validCount;

    // Convert error to similarity score: exp(-err / sigma)
    // sigma = 10 pixels — generous for epipolar
    return Math.exp(-meanErr / 10.0);
}

/**
 * Combined score for a pair of instances across two cameras.
 *
 * @param {Instance} instA
 * @param {Camera} camA
 * @param {Instance} instB
 * @param {Camera} camB
 * @param {number} [wReproj=0.6] - Weight for reprojection consistency
 * @param {number} [wEpipolar=0.4] - Weight for epipolar constraint
 * @returns {number} Combined score in [0, 1]
 */
function crossViewScore(instA, camA, instB, camB, wReproj, wEpipolar) {
    if (wReproj == null) wReproj = 0.6;
    if (wEpipolar == null) wEpipolar = 0.4;

    var reproj = reprojectionConsistencyScore(instA, camA, instB, camB);
    var epi = epipolarConstraintScore(instA, camA, instB, camB);

    return wReproj * reproj + wEpipolar * epi;
}


// ============================================
// Single-frame cross-view matching
// ============================================

/**
 * Match instances across all camera views for a single frame.
 *
 * Algorithm:
 *   1. Collect all instances per camera (linked + unlinked)
 *   2. Pick first two cameras — build score matrix, Hungarian for optimal pairs
 *   3. For each additional camera, score its instances against existing groups
 *      (using mean reprojection distance from group's triangulated 3D), Hungarian match
 *   4. Assign Identity IDs to each group
 *
 * @param {FrameGroup} frameGroup
 * @param {Camera[]} cameras
 * @param {Session} session
 * @param {Object} [opts]
 * @param {boolean} [opts.perFrame=false] - If true, use per-frame identity overrides instead of global
 * @returns {{groups: Array<Map<string, Instance>>, numIdentities: number}}
 */
function matchFrameInstances(frameGroup, cameras, session, opts) {
    opts = opts || {};
    // Collect instances per camera
    var camInstances = {};
    var camMap = {};
    var activeCams = [];

    for (var ci = 0; ci < cameras.length; ci++) {
        var cam = cameras[ci];
        camMap[cam.name] = cam;
        var all = [];

        var linked = frameGroup.getInstances(cam.name);
        if (linked) for (var i = 0; i < linked.length; i++) all.push(linked[i]);

        var unlinked = frameGroup.getUnlinkedInstances(cam.name);
        if (unlinked) for (var j = 0; j < unlinked.length; j++) all.push(unlinked[j].instance);

        if (all.length > 0) {
            camInstances[cam.name] = all;
            activeCams.push(cam.name);
        }
    }

    console.log('[matchFrame] cameras with instances:', activeCams.map(function(c) {
        return c + '(' + camInstances[c].length + ')';
    }).join(', '));

    if (activeCams.length < 2) {
        return { groups: [], numIdentities: 0 };
    }

    // --- Step 1: Match first two cameras ---
    var cam1 = camMap[activeCams[0]];
    var cam2 = camMap[activeCams[1]];
    var insts1 = camInstances[activeCams[0]];
    var insts2 = camInstances[activeCams[1]];

    // Build score matrix (higher = better match)
    var scoreMatrix = [];
    for (var a = 0; a < insts1.length; a++) {
        scoreMatrix[a] = [];
        for (var b = 0; b < insts2.length; b++) {
            scoreMatrix[a][b] = crossViewScore(insts1[a], cam1, insts2[b], cam2);
        }
    }
    console.log('[matchFrame] score matrix (' + activeCams[0] + ' vs ' + activeCams[1] + '):', scoreMatrix);

    // Negate for Hungarian (minimizer)
    var costMatrix = scoreMatrix.map(function(row) {
        return row.map(function(v) { return -v; });
    });
    var assignment = hungarianAlgorithm(costMatrix);
    console.log('[matchFrame] assignment:', assignment);

    // Build groups from matched pairs
    var groups = [];     // Array of Map<camName, Instance>
    var matched2 = new Set();

    for (var a2 = 0; a2 < assignment.length; a2++) {
        var b2 = assignment[a2];
        if (b2 < 0 || b2 >= insts2.length) continue;

        // Only accept if score is above threshold
        var score = scoreMatrix[a2][b2];
        if (score < 0.1) continue;

        var group = new Map();
        group.set(activeCams[0], insts1[a2]);
        group.set(activeCams[1], insts2[b2]);
        groups.push(group);
        matched2.add(b2);
    }

    // Unmatched instances become solo groups
    for (var a3 = 0; a3 < insts1.length; a3++) {
        var wasMatched = false;
        for (var g = 0; g < groups.length; g++) {
            if (groups[g].get(activeCams[0]) === insts1[a3]) { wasMatched = true; break; }
        }
        if (!wasMatched) {
            var sg = new Map();
            sg.set(activeCams[0], insts1[a3]);
            groups.push(sg);
        }
    }
    for (var b3 = 0; b3 < insts2.length; b3++) {
        if (!matched2.has(b3)) {
            var sg2 = new Map();
            sg2.set(activeCams[1], insts2[b3]);
            groups.push(sg2);
        }
    }

    // --- Step 2: Add remaining cameras one at a time ---
    for (var ci2 = 2; ci2 < activeCams.length; ci2++) {
        var camName = activeCams[ci2];
        var cam3 = camMap[camName];
        var insts3 = camInstances[camName];

        // Score each group vs each instance in cam3
        // Use reprojection from group's triangulated 3D
        var costMatrix3 = [];
        for (var gi = 0; gi < groups.length; gi++) {
            costMatrix3[gi] = [];

            // Triangulate the group's 3D points
            var pts3d = triangulateGroup(groups[gi], camMap);

            // Reproject to cam3 and compare with each candidate instance
            var reproj3 = pts3d ? reprojectPoints(pts3d, cam3.projectionMatrix) : null;

            for (var ii = 0; ii < insts3.length; ii++) {
                if (reproj3) {
                    var dist = computeInstanceDistance(reproj3, insts3[ii].points);
                    // Also add epipolar score from one of the group's cameras
                    var bestEpi = 0;
                    groups[gi].forEach(function(inst, cn) {
                        var epi = epipolarConstraintScore(inst, camMap[cn], insts3[ii], cam3);
                        if (epi > bestEpi) bestEpi = epi;
                    });
                    // Convert distance to score (lower distance = higher score)
                    var distScore = Math.exp(-dist / 30.0);
                    costMatrix3[gi][ii] = -(0.6 * distScore + 0.4 * bestEpi);
                } else {
                    // No 3D available — use epipolar only
                    var bestEpi2 = 0;
                    groups[gi].forEach(function(inst, cn) {
                        var epi2 = epipolarConstraintScore(inst, camMap[cn], insts3[ii], cam3);
                        if (epi2 > bestEpi2) bestEpi2 = epi2;
                    });
                    costMatrix3[gi][ii] = -bestEpi2;
                }
            }
        }

        if (costMatrix3.length > 0 && insts3.length > 0) {
            var assignment3 = hungarianAlgorithm(costMatrix3);
            var matched3 = new Set();
            for (var gi2 = 0; gi2 < assignment3.length; gi2++) {
                var ii2 = assignment3[gi2];
                if (ii2 >= 0 && ii2 < insts3.length) {
                    // Check score is reasonable (cost was negated)
                    if (-costMatrix3[gi2][ii2] > 0.1) {
                        groups[gi2].set(camName, insts3[ii2]);
                        matched3.add(ii2);
                    }
                }
            }
            for (var ii3 = 0; ii3 < insts3.length; ii3++) {
                if (!matched3.has(ii3)) {
                    var sg3 = new Map();
                    sg3.set(camName, insts3[ii3]);
                    groups.push(sg3);
                }
            }
        }
    }

    // --- Step 3: Assign identities (reuse existing by name) ---
    var fi = frameGroup.frameIdx;
    for (var g2 = 0; g2 < groups.length; g2++) {
        var idName = 'id_' + g2;
        // Look for existing identity with this name
        var identity = null;
        for (var ei = 0; ei < session.identities.length; ei++) {
            if (session.identities[ei].name === idName) {
                identity = session.identities[ei];
                break;
            }
        }
        // Only create if it doesn't exist
        if (!identity) {
            identity = session.addIdentity(idName);
        }
        groups[g2].forEach(function(inst, cn) {
            if (opts.perFrame && session.setFrameIdentity) {
                session.setFrameIdentity(fi, cn, inst.trackIdx, identity.id);
            } else {
                session.trackIdentityMap.set(cn + ':' + inst.trackIdx, identity.id);
            }
        });
    }

    console.log('[matchFrame] assigned', groups.length, 'identities across',
        activeCams.length, 'cameras');

    return { groups: groups, numIdentities: groups.length };
}


/**
 * Triangulate a group's instances into 3D points.
 *
 * @param {Map<string, Instance>} group - camName -> Instance
 * @param {Object} camMap - camName -> Camera
 * @returns {(number[]|null)[]|null} Array of [x,y,z] or null per keypoint
 */
function triangulateGroup(group, camMap) {
    var cams = [];
    var entries = [];
    group.forEach(function(inst, cn) {
        cams.push(camMap[cn]);
        entries.push(inst);
    });

    if (cams.length < 2) return null;

    var numKp = entries[0].points.length;
    var allObs = [];
    for (var k = 0; k < numKp; k++) {
        var obs = [];
        for (var c = 0; c < entries.length; c++) {
            var pt = entries[c].points[k];
            if (pt && cams[c].undistortPoint) {
                obs.push(cams[c].undistortPoint(pt));
            } else {
                obs.push(pt);
            }
        }
        allObs.push(obs);
    }

    var projMats = cams.map(function(c) { return c.projectionMatrix; });
    return triangulatePoints(allObs, projMats);
}


// ============================================
// Track All — batch process every frame
// ============================================

/**
 * Run cross-view matching on all frames in a session.
 *
 * @param {Session} session
 * @param {Function} [onProgress] - Called with (framesDone, totalFrames)
 * @returns {{totalIdentities: number, framesProcessed: number}}
 */
function matchAllFrames(session, onProgress) {
    var cameras = session.cameras;
    if (!cameras || cameras.length < 2) return { totalIdentities: 0, framesProcessed: 0 };

    var frameIndices = session.frameIndices;
    var totalIdentities = 0;

    // Clear existing identity assignments
    session.identities = [];
    session.trackIdentityMap = new Map();

    // Global identity counter to maintain consistency across frames
    var globalIdCounter = 0;

    for (var f = 0; f < frameIndices.length; f++) {
        var fi = frameIndices[f];
        var fg = session.getFrameGroup(fi);
        if (!fg) continue;

        var result = matchFrameInstances(fg, cameras, session);
        totalIdentities = Math.max(totalIdentities, result.numIdentities);

        if (onProgress && f % 50 === 0) {
            onProgress(f + 1, frameIndices.length);
        }
    }

    if (onProgress) onProgress(frameIndices.length, frameIndices.length);

    return { totalIdentities: session.identities.length, framesProcessed: frameIndices.length };
}
