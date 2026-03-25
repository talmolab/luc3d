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

    if (prevTargets3d && prevTargets3d.length > 0) {
        // TEMPORAL MODE: assign each camera's instances directly to the
        // closest previous 3D target via reprojection. No pairwise re-matching.
        // This is much more stable than re-matching + reordering.
        groups = assignInstancesToPrevTargets(prevTargets3d, camInstances, camMap, activeCams, prevAssignments);
    } else {
        // BOOTSTRAP: first frame — use pairwise cross-view scoring
        groups = matchPairwise(camInstances, camMap, activeCams, numAnimals, prevAssignments);
    }

    // Triangulate each group for 3D targets (used for next frame's reprojection matching)
    var targets3d = [];
    for (var gi = 0; gi < groups.length; gi++) {
        var pts3d = triangulateGroup(groups[gi], camMap);
        targets3d.push({
            points3d: pts3d,
            groupIdx: gi,
            prevInstances: groups[gi]  // store for cross-view consistency check next frame
        });
    }

    // Ensure we have exactly numAnimals identities (create upfront if needed)
    var fi = frameGroup.frameIdx;
    if (numAnimals) {
        while (session.identities.length < numAnimals) {
            session.addIdentity('id_' + session.identities.length);
        }
    }

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

        // Fallback: pick any unused identity from the first N
        if (!identity) {
            var maxId = numAnimals || session.identities.length;
            for (var ei = 0; ei < Math.min(maxId, session.identities.length); ei++) {
                if (!usedIds.has(session.identities[ei].id)) {
                    identity = session.identities[ei];
                    break;
                }
            }
        }

        // Last resort (only if unconstrained): create new
        if (!identity && !numAnimals) {
            identity = session.addIdentity('id_' + session.identities.length);
        }

        // If constrained and still no identity (shouldn't happen), skip
        if (!identity) continue;

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
 * Re-order groups from the current frame's pairwise matching to be consistent
 * with previous frame's identity ordering.
 *
 * Scores each (prevTarget, currentGroup) pair using three signals:
 *   1. Reprojection distance: prev 3D → reproject into group's cameras → distance
 *   2. Cross-view OKS: triangulate group → reproject to prev target's cameras → OKS
 *   3. Track identity continuity: did group members have same identity last frame
 *
 * Combined into single cost for Hungarian assignment.
 */
/**
 * Assign instances to previous 3D targets directly (temporal mode).
 *
 * For each camera independently:
 *   1. Reproject each prev 3D target into this camera
 *   2. Build cost matrix: distance from reprojection to each instance
 *   3. Add strong bonus for track identity continuity
 *   4. Hungarian assign — each target gets at most one instance per camera
 *
 * Result: N groups (one per prev target), each with the best-matching
 * instance from each camera.
 */
function assignInstancesToPrevTargets(prevTargets3d, camInstances, camMap, activeCams, prevAssignments) {
    var nTargets = prevTargets3d.length;
    var groups = [];
    for (var t = 0; t < nTargets; t++) groups.push(new Map());

    for (var ci = 0; ci < activeCams.length; ci++) {
        var camName = activeCams[ci];
        var cam = camMap[camName];
        var insts = camInstances[camName];
        if (!insts || insts.length === 0) continue;

        // Build cost matrix: nTargets × nInstances
        var n = Math.max(nTargets, insts.length);
        var cost = [];
        for (var ti = 0; ti < n; ti++) {
            cost[ti] = [];
            for (var ii = 0; ii < n; ii++) {
                if (ti >= nTargets || ii >= insts.length) {
                    cost[ti][ii] = 10000;  // padding
                    continue;
                }

                var pts3d = prevTargets3d[ti].points3d;
                var dist = 10000;

                // Reprojection distance
                if (pts3d) {
                    var hasAny = false;
                    for (var pk = 0; pk < pts3d.length; pk++) {
                        if (pts3d[pk] != null) { hasAny = true; break; }
                    }
                    if (hasAny) {
                        var reproj = reprojectPoints(pts3d, cam.projectionMatrix);
                        var d = computeInstanceDistance(reproj, insts[ii].points);
                        if (d < Infinity) dist = d;
                    }
                }

                // Identity continuity bonus (reduce cost by a lot if same identity)
                var bonus = 0;
                if (prevAssignments && prevTargets3d[ti].identityId != null) {
                    var prevId = prevAssignments.get(camName + ':' + insts[ii].trackIdx);
                    if (prevId != null && prevId === prevTargets3d[ti].identityId) {
                        bonus = -50;  // very strong pull toward same identity
                    }
                }

                cost[ti][ii] = dist + bonus;
            }
        }

        var assignment = hungarianAlgorithm(cost);
        for (var ti2 = 0; ti2 < nTargets; ti2++) {
            var ii2 = assignment[ti2];
            if (ii2 >= 0 && ii2 < insts.length && cost[ti2][ii2] < 5000) {
                groups[ti2].set(camName, insts[ii2]);
            }
        }
    }

    return groups;
}


function reorderGroupsByPrevTargets(groups, prevTargets3d, camMap, prevAssignments) {
    var nTargets = prevTargets3d.length;
    var nGroups = groups.length;
    var n = Math.max(nTargets, nGroups);

    // Pre-triangulate each current group's 3D
    var groupPts3d = [];
    for (var gi0 = 0; gi0 < nGroups; gi0++) {
        groupPts3d.push(triangulateGroup(groups[gi0], camMap));
    }

    // Build cost matrix: prevTarget[i] → group[j]
    var cost = [];
    for (var ti = 0; ti < n; ti++) {
        cost[ti] = [];
        for (var gi = 0; gi < n; gi++) {
            if (ti >= nTargets || gi >= nGroups) {
                cost[ti][gi] = 1000;
                continue;
            }

            var prevPts3d = prevTargets3d[ti].points3d;
            var currPts3d = groupPts3d[gi];
            var score = 0;
            var scoreCount = 0;

            // --- Signal 1: Reprojection distance (prev 3D → current instances) ---
            if (prevPts3d) {
                var reprojTotal = 0, reprojCount = 0;
                groups[gi].forEach(function(inst, camName) {
                    var cam = camMap[camName];
                    if (!cam) return;
                    var reproj = reprojectPoints(prevPts3d, cam.projectionMatrix);
                    var d = computeInstanceDistance(reproj, inst.points);
                    if (d < Infinity) { reprojTotal += d; reprojCount++; }
                });
                if (reprojCount > 0) {
                    // Convert distance to score [0,1]: lower distance = higher score
                    var meanDist = reprojTotal / reprojCount;
                    score += Math.exp(-meanDist / 50.0);
                    scoreCount++;
                }
            }

            // --- Signal 2: 3D distance (prev 3D ↔ current 3D) ---
            if (prevPts3d && currPts3d) {
                var totalDist3d = 0, count3d = 0;
                var numKp = Math.min(prevPts3d.length, currPts3d.length);
                for (var k = 0; k < numKp; k++) {
                    if (prevPts3d[k] && currPts3d[k]) {
                        var dx = prevPts3d[k][0] - currPts3d[k][0];
                        var dy = prevPts3d[k][1] - currPts3d[k][1];
                        var dz = prevPts3d[k][2] - currPts3d[k][2];
                        totalDist3d += Math.sqrt(dx*dx + dy*dy + dz*dz);
                        count3d++;
                    }
                }
                if (count3d > 0) {
                    var mean3d = totalDist3d / count3d;
                    score += Math.exp(-mean3d / 30.0);
                    scoreCount++;
                }
            }

            // --- Signal 3: Cross-view consistency (reproject current 3D → prev cameras) ---
            if (currPts3d && prevTargets3d[ti].prevInstances) {
                var prevInsts = prevTargets3d[ti].prevInstances;
                var oksTotal = 0, oksCount = 0;
                prevInsts.forEach(function(prevInst, camName) {
                    var cam = camMap[camName];
                    if (!cam || !prevInst) return;
                    var reproj = reprojectPoints(currPts3d, cam.projectionMatrix);
                    var d = computeInstanceDistance(reproj, prevInst.points);
                    if (d < Infinity) {
                        oksTotal += Math.exp(-d / 50.0);
                        oksCount++;
                    }
                });
                if (oksCount > 0) {
                    score += oksTotal / oksCount;
                    scoreCount++;
                }
            }

            // --- Signal 4: Track identity continuity ---
            if (prevAssignments && prevTargets3d[ti].identityId != null) {
                var matchingTracks = 0, totalTracks = 0;
                groups[gi].forEach(function(inst, camName) {
                    totalTracks++;
                    var prevId = prevAssignments.get(camName + ':' + inst.trackIdx);
                    if (prevId != null && prevId === prevTargets3d[ti].identityId) {
                        matchingTracks++;
                    }
                });
                if (totalTracks > 0) {
                    // Strong signal: fraction of tracks that match * weight
                    score += 2.0 * (matchingTracks / totalTracks);
                    scoreCount++;
                }
            }

            // Convert to cost (lower = better match)
            var finalScore = scoreCount > 0 ? score / scoreCount : 0;
            cost[ti][gi] = -finalScore;  // negate: Hungarian minimizes
        }
    }

    var assignment = hungarianAlgorithm(cost);

    // Reorder groups: newGroups[ti] = groups[assignment[ti]]
    var reordered = [];
    for (var ti2 = 0; ti2 < nTargets; ti2++) {
        var gi2 = assignment[ti2];
        if (gi2 >= 0 && gi2 < nGroups) {
            reordered.push(groups[gi2]);
        } else {
            reordered.push(new Map());
        }
    }
    // Append unmatched groups
    var usedGroups = new Set(assignment.filter(function(g) { return g >= 0 && g < nGroups; }));
    for (var gi3 = 0; gi3 < nGroups; gi3++) {
        if (!usedGroups.has(gi3)) reordered.push(groups[gi3]);
    }

    return reordered;
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
        if (!insts || insts.length === 0) continue;

        // Build cost matrix: targets x instances
        var cost = [];
        var hasValidCost = false;
        for (var ti = 0; ti < nTargets; ti++) {
            cost[ti] = [];
            var pts3d = prevTargets3d[ti] ? prevTargets3d[ti].points3d : null;

            // Check if pts3d has any non-null points
            var hasPoints = false;
            if (pts3d) {
                for (var pk = 0; pk < pts3d.length; pk++) {
                    if (pts3d[pk] != null) { hasPoints = true; break; }
                }
            }

            var reproj = hasPoints ? reprojectPoints(pts3d, cam.projectionMatrix) : null;

            for (var ii = 0; ii < insts.length; ii++) {
                if (reproj) {
                    var dist = computeInstanceDistance(reproj, insts[ii].points);
                    var score = dist < Infinity ? Math.exp(-dist / 30.0) : 0;
                    // Temporal bonus
                    if (prevAssignments && prevTargets3d[ti] && prevTargets3d[ti].identityId != null) {
                        var prevId = prevAssignments.get(camName + ':' + insts[ii].trackIdx);
                        if (prevId != null && prevId === prevTargets3d[ti].identityId) {
                            score += 0.3;
                        }
                    }
                    cost[ti][ii] = -score;
                    if (score > 0) hasValidCost = true;
                } else {
                    cost[ti][ii] = 0;
                }
            }
        }

        if (hasValidCost && cost.length > 0 && insts.length > 0) {
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
    // Pick the two cameras with the most instances (best chance of seeing all animals)
    var camsByCount = activeCams.slice().sort(function(a, b) {
        return camInstances[b].length - camInstances[a].length;
    });
    var bestCam1 = camsByCount[0];
    var bestCam2 = camsByCount[1];

    // Among cameras with enough instances, pick the pair with best baseline
    // (different position = better triangulation). For now just use top 2 by count.
    var cam1 = camMap[bestCam1];
    var cam2 = camMap[bestCam2];
    var insts1 = camInstances[bestCam1];
    var insts2 = camInstances[bestCam2];

    // Reorder activeCams so the chosen pair is first (for the remaining-cameras loop)
    var remainingCams = activeCams.filter(function(c) { return c !== bestCam1 && c !== bestCam2; });
    activeCams = [bestCam1, bestCam2].concat(remainingCams);

    console.log('[matchPairwise] bootstrap pair:', bestCam1, '(' + insts1.length + ')', 'vs', bestCam2, '(' + insts2.length + ')');

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

    // Collect all matches with scores
    var matches = [];
    for (var a2 = 0; a2 < assignment.length; a2++) {
        var b2 = assignment[a2];
        if (b2 < 0 || b2 >= insts2.length) continue;
        matches.push({ a: a2, b: b2, score: scoreMatrix[a2][b2] });
    }

    // Sort by score descending
    matches.sort(function(x, y) { return y.score - x.score; });

    // If numAnimals is set, keep top N matches (but may have fewer if not enough instances)
    if (numAnimals) {
        matches = matches.slice(0, numAnimals);
    } else {
        matches = matches.filter(function(m) { return m.score > 0.05; });
    }

    console.log('[matchPairwise] matches:', matches.length, 'needed:', numAnimals || 'auto',
        'scores:', matches.map(function(m) { return m.score.toFixed(3); }));

    var groups = [];
    var matched1 = new Set();
    var matched2 = new Set();
    for (var mi = 0; mi < matches.length; mi++) {
        var group = new Map();
        group.set(activeCams[0], insts1[matches[mi].a]);
        group.set(activeCams[1], insts2[matches[mi].b]);
        groups.push(group);
        matched1.add(matches[mi].a);
        matched2.add(matches[mi].b);
    }

    // If constrained and we don't have enough groups, create groups from
    // unmatched instances (single-camera groups that will get filled by
    // the remaining-cameras step)
    if (numAnimals && groups.length < numAnimals) {
        // First try unmatched from cam1
        for (var a3 = 0; a3 < insts1.length && groups.length < numAnimals; a3++) {
            if (!matched1.has(a3)) {
                var sg = new Map();
                sg.set(activeCams[0], insts1[a3]);
                groups.push(sg);
            }
        }
        // Then try unmatched from cam2
        for (var b3 = 0; b3 < insts2.length && groups.length < numAnimals; b3++) {
            if (!matched2.has(b3)) {
                var sg2 = new Map();
                sg2.set(activeCams[1], insts2[b3]);
                groups.push(sg2);
            }
        }
        console.log('[matchPairwise] padded to', groups.length, 'groups');
    }

    // Solo groups for unmatched (only if unconstrained)
    if (!numAnimals) {
        for (var a4 = 0; a4 < insts1.length; a4++) {
            if (!matched1.has(a4)) {
                var sg3 = new Map();
                sg3.set(activeCams[0], insts1[a4]);
                groups.push(sg3);
            }
        }
        for (var b4 = 0; b4 < insts2.length; b4++) {
            if (!matched2.has(b4)) {
                var sg4 = new Map();
                sg4.set(activeCams[1], insts2[b4]);
                groups.push(sg4);
            }
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
            // Only create solo groups for unmatched if unconstrained
            if (!numAnimals) {
                for (var ii3 = 0; ii3 < insts3.length; ii3++) {
                    if (!matched3.has(ii3)) {
                        var sg3 = new Map();
                        sg3.set(camName, insts3[ii3]);
                        groups.push(sg3);
                    }
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
