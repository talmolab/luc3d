/**
 * tracker.js — Cross-view instance matching and identity assignment.
 *
 * Two modes:
 *   - Constrained (numAnimals specified): exactly N identities, uses
 *     reprojection + epipolar scoring with Hungarian assignment.
 *   - Unconstrained: auto-discovers groups, may create variable identity count.
 *
 * Scoring uses:
 *   1. Reprojection consistency (OKS-style): triangulate pair, reproject,
 *      measure match quality.
 *   2. Epipolar constraint: how well points satisfy epipolar geometry.
 *
 * Depends on: pose-data.js, triangulation.js
 */

// ============================================
// Pairwise scoring
// ============================================

/**
 * OKS-style reprojection consistency score for a pair of instances.
 * Triangulates, reprojects, measures agreement.
 * @returns {number} Score in [0, 1], 1 = perfect
 */
function reprojectionConsistencyScore(instA, camA, instB, camB) {
    var ptsA = instA.points;
    var ptsB = instB.points;
    var numKp = Math.min(ptsA.length, ptsB.length);
    if (numKp === 0) return 0;

    var PA = camA.projectionMatrix;
    var PB = camB.projectionMatrix;
    var totalOks = 0, validCount = 0;

    for (var k = 0; k < numKp; k++) {
        if (ptsA[k] == null || ptsB[k] == null) continue;
        var uA = camA.undistortPoint ? camA.undistortPoint(ptsA[k]) : ptsA[k];
        var uB = camB.undistortPoint ? camB.undistortPoint(ptsB[k]) : ptsB[k];
        var pt3d = triangulatePointDLT([uA, uB], [PA, PB]);
        if (pt3d == null) continue;
        var repA = reprojectPoint(pt3d, PA);
        var repB = reprojectPoint(pt3d, PB);
        var errA = Math.sqrt(Math.pow(ptsA[k][0] - repA[0], 2) + Math.pow(ptsA[k][1] - repA[1], 2));
        var errB = Math.sqrt(Math.pow(ptsB[k][0] - repB[0], 2) + Math.pow(ptsB[k][1] - repB[1], 2));
        var sigma = 20.0;
        totalOks += (Math.exp(-errA * errA / (2 * sigma * sigma)) + Math.exp(-errB * errB / (2 * sigma * sigma))) / 2;
        validCount++;
    }
    return validCount > 0 ? totalOks / validCount : 0;
}

/**
 * Epipolar constraint score. Lower error = higher score.
 * @returns {number} Score in [0, 1]
 */
function epipolarConstraintScore(instA, camA, instB, camB) {
    var F = computeFundamentalMatrix(camA, camB);
    var ptsA = instA.points, ptsB = instB.points;
    var numKp = Math.min(ptsA.length, ptsB.length);
    var totalErr = 0, validCount = 0;

    for (var k = 0; k < numKp; k++) {
        if (ptsA[k] == null || ptsB[k] == null) continue;
        var x1 = ptsA[k][0], y1 = ptsA[k][1];
        var x2 = ptsB[k][0], y2 = ptsB[k][1];
        var l0 = F[0][0]*x1 + F[0][1]*y1 + F[0][2];
        var l1 = F[1][0]*x1 + F[1][1]*y1 + F[1][2];
        var l2 = F[2][0]*x1 + F[2][1]*y1 + F[2][2];
        var num = Math.abs(x2*l0 + y2*l1 + l2);
        var denom = Math.sqrt(l0*l0 + l1*l1);
        if (denom > 1e-12) { totalErr += num / denom; validCount++; }
    }
    if (validCount === 0) return 0;
    return Math.exp(-totalErr / validCount / 10.0);
}

/**
 * Combined cross-view score.
 */
function crossViewScore(instA, camA, instB, camB) {
    return 0.6 * reprojectionConsistencyScore(instA, camA, instB, camB) +
           0.4 * epipolarConstraintScore(instA, camA, instB, camB);
}


// ============================================
// Collect instances helper
// ============================================

function collectInstances(frameGroup, cameras) {
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
    return { camInstances: camInstances, camMap: camMap, activeCams: activeCams };
}


// ============================================
// Single-frame matching (constrained or unconstrained)
// ============================================

/**
 * Match instances across views for one frame.
 *
 * @param {FrameGroup} frameGroup
 * @param {Camera[]} cameras
 * @param {Session} session
 * @param {Object} [opts]
 * @param {number} [opts.numAnimals] - If set, constrain to exactly N identities
 * @param {boolean} [opts.perFrame] - Use per-frame identity storage
 * @param {Map<string, number>} [opts.prevAssignments] - Previous frame's cam:track → identityId
 * @param {Array<{points3d: number[][]|null, identityId: number}>} [opts.prevTargets3d] - Previous frame's 3D targets for reprojection matching
 * @returns {{groups: Array<Map<string, Instance>>, numIdentities: number, assignments: Map<string, number>, targets3d: Array}}
 */
function matchFrameInstances(frameGroup, cameras, session, opts) {
    opts = opts || {};
    var numAnimals = opts.numAnimals || null;
    var prevAssignments = opts.prevAssignments || null;
    var prevTargets3d = opts.prevTargets3d || null;

    var collected = collectInstances(frameGroup, cameras);
    var camInstances = collected.camInstances;
    var camMap = collected.camMap;
    var activeCams = collected.activeCams;

    if (activeCams.length < 2) {
        return { groups: [], numIdentities: 0, assignments: new Map(), targets3d: [] };
    }

    var groups;

    // If we have previous 3D targets, match instances to them directly via reprojection
    if (prevTargets3d && prevTargets3d.length > 0) {
        groups = matchViaReprojection(prevTargets3d, camInstances, camMap, activeCams, prevAssignments);
    } else {
        // Bootstrap: build groups from pairwise cross-view scoring
        groups = matchPairwise(camInstances, camMap, activeCams, numAnimals, prevAssignments);
    }

    // Constrain to numAnimals: keep top N groups by size, merge rest
    if (numAnimals && groups.length > numAnimals) {
        // Sort by number of cameras (larger groups = more confident)
        groups.sort(function(a, b) { return b.size - a.size; });
        groups = groups.slice(0, numAnimals);
    }

    // Triangulate each group for 3D targets (used for next frame's reprojection matching)
    var targets3d = [];
    for (var gi = 0; gi < groups.length; gi++) {
        var pts3d = triangulateGroup(groups[gi], camMap);
        targets3d.push({ points3d: pts3d, groupIdx: gi });
    }

    // Assign identities with stable mapping from prev frame
    var fi = frameGroup.frameIdx;
    var assignments = new Map();
    var usedIds = new Set();

    for (var g = 0; g < groups.length; g++) {
        var identity = null;

        // Vote from prev assignments
        if (prevAssignments) {
            var votes = {};
            groups[g].forEach(function(inst, cn) {
                var pid = prevAssignments.get(cn + ':' + inst.trackIdx);
                if (pid != null) votes[pid] = (votes[pid] || 0) + 1;
            });
            var bestVote = -1, bestId = null;
            for (var vid in votes) {
                if (votes[vid] > bestVote && !usedIds.has(parseInt(vid))) {
                    bestVote = votes[vid];
                    bestId = parseInt(vid);
                }
            }
            if (bestId != null) identity = session.getIdentity(bestId);
        }

        // Fallback: create/reuse
        if (!identity) {
            var idName = 'id_' + g;
            for (var ei = 0; ei < session.identities.length; ei++) {
                if (session.identities[ei].name === idName && !usedIds.has(session.identities[ei].id)) {
                    identity = session.identities[ei];
                    break;
                }
            }
        }
        if (!identity) {
            identity = session.addIdentity('id_' + session.identities.length);
        }

        usedIds.add(identity.id);
        targets3d[g].identityId = identity.id;

        groups[g].forEach(function(inst, cn) {
            session.trackIdentityMap.set(cn + ':' + inst.trackIdx, identity.id);
            if (opts.perFrame && session.setFrameIdentity) {
                session.setFrameIdentity(fi, cn, inst.trackIdx, identity.id);
            }
            assignments.set(cn + ':' + inst.trackIdx, identity.id);
        });
    }

    return { groups: groups, numIdentities: groups.length, assignments: assignments, targets3d: targets3d };
}


/**
 * Match instances to previous frame's 3D targets via reprojection distance.
 * Each camera's instances are assigned to the closest reprojected target.
 */
function matchViaReprojection(prevTargets3d, camInstances, camMap, activeCams, prevAssignments) {
    var nTargets = prevTargets3d.length;
    var groups = [];
    for (var t = 0; t < nTargets; t++) groups.push(new Map());

    for (var ci = 0; ci < activeCams.length; ci++) {
        var camName = activeCams[ci];
        var cam = camMap[camName];
        var insts = camInstances[camName];

        // Build cost matrix: targets x instances
        var cost = [];
        for (var ti = 0; ti < nTargets; ti++) {
            cost[ti] = [];
            var pts3d = prevTargets3d[ti].points3d;
            var reproj = pts3d ? reprojectPoints(pts3d, cam.projectionMatrix) : null;

            for (var ii = 0; ii < insts.length; ii++) {
                if (reproj) {
                    var dist = computeInstanceDistance(reproj, insts[ii].points);
                    var score = Math.exp(-dist / 30.0);
                    // Temporal bonus
                    if (prevAssignments && prevTargets3d[ti].identityId != null) {
                        var prevId = prevAssignments.get(camName + ':' + insts[ii].trackIdx);
                        if (prevId != null && prevId === prevTargets3d[ti].identityId) {
                            score += 0.3;
                        }
                    }
                    cost[ti][ii] = -score;
                } else {
                    cost[ti][ii] = 0;
                }
            }
        }

        if (cost.length > 0 && insts.length > 0) {
            var assignment = hungarianAlgorithm(cost);
            for (var ti2 = 0; ti2 < assignment.length; ti2++) {
                var ii2 = assignment[ti2];
                if (ii2 >= 0 && ii2 < insts.length && -cost[ti2][ii2] > 0.05) {
                    groups[ti2].set(camName, insts[ii2]);
                }
            }
        }
    }

    return groups;
}


/**
 * Bootstrap: pairwise cross-view matching for the first frame.
 */
function matchPairwise(camInstances, camMap, activeCams, numAnimals, prevAssignments) {
    var cam1 = camMap[activeCams[0]];
    var cam2 = camMap[activeCams[1]];
    var insts1 = camInstances[activeCams[0]];
    var insts2 = camInstances[activeCams[1]];

    // Score matrix
    var scoreMatrix = [];
    for (var a = 0; a < insts1.length; a++) {
        scoreMatrix[a] = [];
        for (var b = 0; b < insts2.length; b++) {
            var geoScore = crossViewScore(insts1[a], cam1, insts2[b], cam2);
            if (prevAssignments) {
                var pidA = prevAssignments.get(activeCams[0] + ':' + insts1[a].trackIdx);
                var pidB = prevAssignments.get(activeCams[1] + ':' + insts2[b].trackIdx);
                if (pidA != null && pidB != null && pidA === pidB) geoScore += 0.3;
            }
            scoreMatrix[a][b] = geoScore;
        }
    }

    var costMatrix = scoreMatrix.map(function(row) { return row.map(function(v) { return -v; }); });
    var assignment = hungarianAlgorithm(costMatrix);

    var groups = [];
    var matched2 = new Set();
    for (var a2 = 0; a2 < assignment.length; a2++) {
        var b2 = assignment[a2];
        if (b2 < 0 || b2 >= insts2.length) continue;
        if (scoreMatrix[a2][b2] < 0.05) continue;
        var group = new Map();
        group.set(activeCams[0], insts1[a2]);
        group.set(activeCams[1], insts2[b2]);
        groups.push(group);
        matched2.add(b2);
    }

    // Solo groups for unmatched
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

    // Add remaining cameras via reprojection
    for (var ci = 2; ci < activeCams.length; ci++) {
        var camName = activeCams[ci];
        var cam3 = camMap[camName];
        var insts3 = camInstances[camName];

        var cost3 = [];
        for (var gi = 0; gi < groups.length; gi++) {
            cost3[gi] = [];
            var pts3d = triangulateGroup(groups[gi], camMap);
            var reproj3 = pts3d ? reprojectPoints(pts3d, cam3.projectionMatrix) : null;
            for (var ii = 0; ii < insts3.length; ii++) {
                if (reproj3) {
                    var dist = computeInstanceDistance(reproj3, insts3[ii].points);
                    cost3[gi][ii] = dist;
                } else {
                    cost3[gi][ii] = Infinity;
                }
            }
        }
        if (cost3.length > 0 && insts3.length > 0) {
            var assign3 = hungarianAlgorithm(cost3);
            var matched3 = new Set();
            for (var gi2 = 0; gi2 < assign3.length; gi2++) {
                var ii2 = assign3[gi2];
                if (ii2 >= 0 && ii2 < insts3.length && cost3[gi2][ii2] < 100) {
                    groups[gi2].set(camName, insts3[ii2]);
                    matched3.add(ii2);
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

    return groups;
}


/**
 * Triangulate a group's instances into 3D points.
 */
function triangulateGroup(group, camMap) {
    var cams = [], entries = [];
    group.forEach(function(inst, cn) { cams.push(camMap[cn]); entries.push(inst); });
    if (cams.length < 2) return null;

    var numKp = entries[0].points.length;
    var allObs = [];
    for (var k = 0; k < numKp; k++) {
        var obs = [];
        for (var c = 0; c < entries.length; c++) {
            var pt = entries[c].points[k];
            obs.push(pt && cams[c].undistortPoint ? cams[c].undistortPoint(pt) : pt);
        }
        allObs.push(obs);
    }
    return triangulatePoints(allObs, cams.map(function(c) { return c.projectionMatrix; }));
}
