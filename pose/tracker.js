/**
 * tracker.js — Cross-view instance matching and identity assignment.
 *
 * Optimized: caches fundamental matrices, pre-undistorts points,
 * uses epipolar-only for initial scoring (fast), reprojection for
 * top candidates only.
 *
 * Depends on: pose-data.js, triangulation.js
 */

import {
    computeFundamentalMatrix,
    triangulatePointDLT,
    triangulatePoints,
    reprojectPoint,
    reprojectPoints,
    computeInstanceDistance,
    hungarianAlgorithm
} from './triangulation.js';

// Pass 3i-1: tracker UI/integration (was in app.js)
import { state, interactionManager, timeline, getActiveSession } from '../ui/app-state.js';
import { setStatus, showLoading, hideLoading } from '../import-export/save-load.js';
import { drawAllOverlays } from '../ui/rendering.js';
import { updateInfoPanel } from '../ui/info-panel.js';

// Explicit "no identity" per-frame value. Written for visible instances that
// landed in no group this frame so that getIdentity*ForTrack returns null for
// them (Issue #6 — prevents residual duplicate identity colors).
var EXPLICIT_NONE = -1;

// ============================================
// Caches (cleared per-frame)
// ============================================

var _fMatrixCache = {};   // "cam1:cam2" → F matrix
var _undistortCache = new WeakMap();  // Instance → undistorted points

function getCachedF(camA, camB) {
    var key = camA.name + ':' + camB.name;
    if (_fMatrixCache[key]) return _fMatrixCache[key];
    var F = computeFundamentalMatrix(camA, camB);
    _fMatrixCache[key] = F;
    return F;
}

function getUndistortedPoints(inst, cam) {
    var cached = _undistortCache.get(inst);
    if (cached) return cached;
    var pts = [];
    for (var k = 0; k < inst.points.length; k++) {
        if (inst.points[k] == null) {
            pts.push(null);
        } else if (cam.undistortPoint) {
            pts.push(cam.undistortPoint(inst.points[k]));
        } else {
            pts.push(inst.points[k]);
        }
    }
    _undistortCache.set(inst, pts);
    return pts;
}

function clearFrameCache() {
    // Keep F matrix cache — same cameras every frame
    // _fMatrixCache = {};
}

// ============================================
// Scoring functions
// ============================================

/**
 * Fast epipolar-only score (no triangulation needed).
 * @returns {number} Score in [0, 1]
 */
function epipolarScore(instA, camA, instB, camB) {
    var F = getCachedF(camA, camB);
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
 * OKS reprojection consistency score (expensive — only use for refinement).
 * @returns {number} Score in [0, 1]
 */
function reprojectionScore(instA, camA, instB, camB) {
    var uA = getUndistortedPoints(instA, camA);
    var uB = getUndistortedPoints(instB, camB);
    var PA = camA.projectionMatrix, PB = camB.projectionMatrix;
    var numKp = Math.min(uA.length, uB.length);
    var totalOks = 0, validCount = 0;
    var sigma2x2 = 2 * 20.0 * 20.0;

    for (var k = 0; k < numKp; k++) {
        if (uA[k] == null || uB[k] == null) continue;
        var pt3d = triangulatePointDLT([uA[k], uB[k]], [PA, PB]);
        if (pt3d == null) continue;
        var repA = reprojectPoint(pt3d, PA);
        var repB = reprojectPoint(pt3d, PB);
        var dxA = instA.points[k][0] - repA[0], dyA = instA.points[k][1] - repA[1];
        var dxB = instB.points[k][0] - repB[0], dyB = instB.points[k][1] - repB[1];
        totalOks += (Math.exp(-(dxA*dxA + dyA*dyA) / sigma2x2) +
                     Math.exp(-(dxB*dxB + dyB*dyB) / sigma2x2)) / 2;
        validCount++;
    }
    return validCount > 0 ? totalOks / validCount : 0;
}

/**
 * Combined score: fast epipolar + reprojection OKS.
 */
function crossViewScore(instA, camA, instB, camB) {
    return 0.4 * epipolarScore(instA, camA, instB, camB) +
           0.6 * reprojectionScore(instA, camA, instB, camB);
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
// Single-frame matching
// ============================================

/**
 * Match instances across views for one frame.
 */
export function matchFrameInstances(frameGroup, cameras, session, opts) {
    opts = opts || {};
    var numAnimals = opts.numAnimals || null;
    var prevAssignments = opts.prevAssignments || null;
    var prevTargets3d = opts.prevTargets3d || null;

    clearFrameCache();

    var collected = collectInstances(frameGroup, cameras);
    var camInstances = collected.camInstances;
    var camMap = collected.camMap;
    var activeCams = collected.activeCams;

    if (activeCams.length < 2) {
        return { groups: [], numIdentities: 0, assignments: new Map(), targets3d: [] };
    }

    // Always do pairwise cross-view matching (geometry within current frame)
    var groups = matchPairwise(camInstances, camMap, activeCams, numAnimals, prevAssignments);

    // If we have previous 3D targets, re-order groups to match prev identities
    if (prevTargets3d && prevTargets3d.length > 0 && groups.length > 0) {
        groups = reorderGroupsByPrevTargets(groups, prevTargets3d, camMap, prevAssignments);
    }

    // Triangulate each group
    var targets3d = [];
    for (var gi = 0; gi < groups.length; gi++) {
        var pts3d = triangulateGroup(groups[gi], camMap);
        targets3d.push({
            points3d: pts3d,
            groupIdx: gi,
            prevInstances: groups[gi]
        });
    }

    // Assign identities
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

        // A single-view group is just one instance with no cross-view partner,
        // so it can't be triangulated or geometrically verified. Assigning it an
        // identity writes a per-frame entry that makes the ID panel show that
        // identity as "present" at this frame on the strength of an unverified
        // lone detection (Issue #5). Skip it — the Issue #6 guard below then
        // writes EXPLICIT_NONE for it, so getIdentity*ForTrack returns null.
        if (groups[g].size < 2) continue;

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
        if (!identity && !numAnimals) {
            identity = session.addIdentity('id_' + session.identities.length);
        }
        if (!identity) continue;

        usedIds.add(identity.id);
        targets3d[g].identityId = identity.id;

        groups[g].forEach(function(inst, cn) {
            // Identity is recorded per-frame only (no global default map).
            if (session.setFrameIdentity) {
                session.setFrameIdentity(fi, cn, inst.trackIdx, identity.id);
            }
            assignments.set(cn + ':' + inst.trackIdx, identity.id);
        });
    }

    // Issue #6: every VISIBLE instance that did not land in a group this frame
    // gets an explicit "no identity" per-frame marker, so getIdentity*ForTrack
    // returns null for it instead of leaving it unmapped. Never clobber an
    // existing per-frame entry (e.g. a manual user assignment).
    if (session.setFrameIdentity) {
        for (var aci = 0; aci < activeCams.length; aci++) {
            var acn = activeCams[aci];
            var aInsts = camInstances[acn];
            if (!aInsts) continue;
            for (var aii = 0; aii < aInsts.length; aii++) {
                var aTrack = aInsts[aii].trackIdx;
                if (assignments.has(acn + ':' + aTrack)) continue;
                if (session.frameIdentityMap &&
                    session.frameIdentityMap.has(fi + ':' + acn + ':' + aTrack)) continue;
                session.setFrameIdentity(fi, acn, aTrack, EXPLICIT_NONE);
            }
        }
    }

    return { groups: groups, numIdentities: groups.length, assignments: assignments, targets3d: targets3d };
}


// ============================================
// Temporal reordering
// ============================================

/**
 * Re-order groups to match previous identity ordering using multi-signal scoring.
 */
function reorderGroupsByPrevTargets(groups, prevTargets3d, camMap, prevAssignments) {
    var nTargets = prevTargets3d.length;
    var nGroups = groups.length;
    if (nTargets === 0 || nGroups === 0) return groups;

    // Pre-triangulate current groups
    var groupPts3d = [];
    for (var gi0 = 0; gi0 < nGroups; gi0++) {
        groupPts3d.push(triangulateGroup(groups[gi0], camMap));
    }

    // Build the real nTargets x nGroups cost matrix only. hungarianAlgorithm
    // pads to square internally and strips padded-row claims via its
    // p[j4] <= n guard, so passing a true rectangle prevents padded rows
    // from stealing real groups (the duplicate-identity bug).
    var cost = [];
    for (var ti = 0; ti < nTargets; ti++) {
        cost[ti] = [];
        for (var gi = 0; gi < nGroups; gi++) {
            var prevPts3d = prevTargets3d[ti].points3d;
            var currPts3d = groupPts3d[gi];
            var score = 0, scoreCount = 0;

            // Signal 1: Reprojection distance (prev 3D → current instances)
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
                    score += Math.exp(-(reprojTotal / reprojCount) / 50.0);
                    scoreCount++;
                }
            }

            // Signal 2: 3D distance
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
                    score += Math.exp(-(totalDist3d / count3d) / 30.0);
                    scoreCount++;
                }
            }

            // Signal 3: Cross-view consistency
            if (currPts3d && prevTargets3d[ti].prevInstances) {
                var prevInsts = prevTargets3d[ti].prevInstances;
                var oksTotal = 0, oksCount = 0;
                prevInsts.forEach(function(prevInst, camName) {
                    var cam = camMap[camName];
                    if (!cam || !prevInst) return;
                    var reproj = reprojectPoints(currPts3d, cam.projectionMatrix);
                    var d = computeInstanceDistance(reproj, prevInst.points);
                    if (d < Infinity) { oksTotal += Math.exp(-d / 50.0); oksCount++; }
                });
                if (oksCount > 0) { score += oksTotal / oksCount; scoreCount++; }
            }

            // Signal 4: Track identity continuity (2x weight)
            if (prevAssignments && prevTargets3d[ti].identityId != null) {
                var matchingTracks = 0, totalTracks = 0;
                groups[gi].forEach(function(inst, camName) {
                    totalTracks++;
                    var prevId = prevAssignments.get(camName + ':' + inst.trackIdx);
                    if (prevId != null && prevId === prevTargets3d[ti].identityId) matchingTracks++;
                });
                if (totalTracks > 0) {
                    score += 2.0 * (matchingTracks / totalTracks);
                    scoreCount++;
                }
            }

            cost[ti][gi] = -(scoreCount > 0 ? score / scoreCount : 0);
        }
    }

    var assignment = hungarianAlgorithm(cost);

    var reordered = [];
    for (var ti2 = 0; ti2 < nTargets; ti2++) {
        var gi2 = assignment[ti2];
        reordered.push(gi2 >= 0 && gi2 < nGroups ? groups[gi2] : new Map());
    }
    var usedGroups = new Set(assignment.filter(function(g) { return g >= 0 && g < nGroups; }));
    for (var gi3 = 0; gi3 < nGroups; gi3++) {
        if (!usedGroups.has(gi3)) reordered.push(groups[gi3]);
    }
    return reordered;
}


// ============================================
// Pairwise bootstrap
// ============================================

/**
 * Adaptive reprojection acceptance gate (px) for attaching an instance to a
 * group, scaled by how many views back the group's triangulated 3D estimate.
 *
 * A 2-view bootstrap seed is fragile, so it keeps the original tight 100px
 * cutoff (a large reprojection there may mean a wrong association). Once 3+
 * views constrain the 3D the estimate is trustworthy, so the gate loosens to
 * tolerate detection noise and recover a correct instance that a fixed 100px
 * cutoff would have dropped (Issue #1 / Issue #2).
 *
 * @param {number} nViews - number of views currently in the group
 * @returns {number} acceptance threshold in pixels
 */
function reprojectionGate(nViews) {
    if (nViews <= 2) return 100;
    if (nViews === 3) return 140;
    return 180;
}

/**
 * Bootstrap: pairwise cross-view matching using epipolar-first scoring.
 */
function matchPairwise(camInstances, camMap, activeCams, numAnimals, prevAssignments) {
    // Pick two cameras with most instances
    var camsByCount = activeCams.slice().sort(function(a, b) {
        return camInstances[b].length - camInstances[a].length;
    });
    var bestCam1 = camsByCount[0], bestCam2 = camsByCount[1];
    var cam1 = camMap[bestCam1], cam2 = camMap[bestCam2];
    var insts1 = camInstances[bestCam1], insts2 = camInstances[bestCam2];
    var remainingCams = activeCams.filter(function(c) { return c !== bestCam1 && c !== bestCam2; });
    activeCams = [bestCam1, bestCam2].concat(remainingCams);

    // Fast epipolar-only score matrix first
    var scoreMatrix = [];
    for (var a = 0; a < insts1.length; a++) {
        scoreMatrix[a] = [];
        for (var b = 0; b < insts2.length; b++) {
            var score = epipolarScore(insts1[a], cam1, insts2[b], cam2);
            if (prevAssignments) {
                var pidA = prevAssignments.get(bestCam1 + ':' + insts1[a].trackIdx);
                var pidB = prevAssignments.get(bestCam2 + ':' + insts2[b].trackIdx);
                if (pidA != null && pidB != null && pidA === pidB) score += 0.3;
            }
            scoreMatrix[a][b] = score;
        }
    }

    var costMatrix = scoreMatrix.map(function(row) { return row.map(function(v) { return -v; }); });
    var assignment = hungarianAlgorithm(costMatrix);

    // Collect matches with scores
    var matches = [];
    for (var a2 = 0; a2 < assignment.length; a2++) {
        var b2 = assignment[a2];
        if (b2 < 0 || b2 >= insts2.length) continue;
        matches.push({ a: a2, b: b2, score: scoreMatrix[a2][b2] });
    }
    matches.sort(function(x, y) { return y.score - x.score; });

    // Refine top candidates with full reprojection score
    var topN = numAnimals ? Math.min(numAnimals * 2, matches.length) : matches.length;
    for (var mi = 0; mi < topN; mi++) {
        var m = matches[mi];
        var fullScore = crossViewScore(insts1[m.a], cam1, insts2[m.b], cam2);
        if (prevAssignments) {
            var pA = prevAssignments.get(bestCam1 + ':' + insts1[m.a].trackIdx);
            var pB = prevAssignments.get(bestCam2 + ':' + insts2[m.b].trackIdx);
            if (pA != null && pB != null && pA === pB) fullScore += 0.3;
        }
        matches[mi].score = fullScore;
    }
    matches.sort(function(x, y) { return y.score - x.score; });

    if (numAnimals) {
        matches = matches.slice(0, numAnimals);
    } else {
        matches = matches.filter(function(m) { return m.score > 0.05; });
    }

    var groups = [];
    var matched1 = new Set(), matched2 = new Set();
    for (var mi2 = 0; mi2 < matches.length; mi2++) {
        var group = new Map();
        group.set(activeCams[0], insts1[matches[mi2].a]);
        group.set(activeCams[1], insts2[matches[mi2].b]);
        groups.push(group);
        matched1.add(matches[mi2].a);
        matched2.add(matches[mi2].b);
    }

    // Pad to numAnimals if needed
    if (numAnimals && groups.length < numAnimals) {
        for (var a3 = 0; a3 < insts1.length && groups.length < numAnimals; a3++) {
            if (!matched1.has(a3)) {
                var sg = new Map();
                sg.set(activeCams[0], insts1[a3]);
                groups.push(sg);
            }
        }
        for (var b3 = 0; b3 < insts2.length && groups.length < numAnimals; b3++) {
            if (!matched2.has(b3)) {
                var sg2 = new Map();
                sg2.set(activeCams[1], insts2[b3]);
                groups.push(sg2);
            }
        }
    }

    // Solo groups for unmatched (unconstrained only)
    if (!numAnimals) {
        for (var a4 = 0; a4 < insts1.length; a4++) {
            if (!matched1.has(a4)) {
                var sg3 = new Map(); sg3.set(activeCams[0], insts1[a4]); groups.push(sg3);
            }
        }
        for (var b4 = 0; b4 < insts2.length; b4++) {
            if (!matched2.has(b4)) {
                var sg4 = new Map(); sg4.set(activeCams[1], insts2[b4]); groups.push(sg4);
            }
        }
    }

    // Add remaining cameras via reprojection, with iterative refinement.
    //
    // Issue #1 (incremental triangulation): rather than reprojecting every
    // group from its fragile 2-view bootstrap seed exactly once, iterate. Each
    // pass re-triangulates every group from ALL views attached so far — an
    // increasingly well-conditioned estimate — and attaches still-unmatched
    // instances. A group that gains a 3rd/4th view in one pass reprojects more
    // accurately into the remaining cameras on the next, so a visible instance
    // that a fragile seed had pushed past the gate is recovered.
    //
    // Issue #2 (adaptive gate): reprojectionGate() scales the acceptance
    // threshold with the group's view count, so loosening only happens once the
    // estimate is trustworthy (see that function).
    var remainingCams = activeCams.slice(2);
    var attachedInsts = {};   // camName → Set of instance indices already grouped
    for (var rc = 0; rc < remainingCams.length; rc++) attachedInsts[remainingCams[rc]] = new Set();

    var MAX_REFINE_PASSES = 3;
    for (var pass = 0; pass < MAX_REFINE_PASSES; pass++) {
        var attachedAny = false;
        for (var rci = 0; rci < remainingCams.length; rci++) {
            var camName = remainingCams[rci];
            var cam3 = camMap[camName];
            var insts3 = camInstances[camName];
            if (!insts3 || insts3.length === 0) continue;
            var used = attachedInsts[camName];

            // Rectangular cost matrix over only the groups still missing this
            // camera; re-triangulate each from all views attached so far.
            var rows = [];     // parallel to cost3 rows: { gi, gate }
            var cost3 = [];
            for (var gi = 0; gi < groups.length; gi++) {
                if (groups[gi].has(camName)) continue;
                var pts3d = triangulateGroup(groups[gi], camMap);
                if (!pts3d) continue;
                var reproj3 = reprojectPoints(pts3d, cam3.projectionMatrix);
                var costRow = [];
                for (var ii = 0; ii < insts3.length; ii++) {
                    costRow[ii] = used.has(ii) ? Infinity
                        : computeInstanceDistance(reproj3, insts3[ii].points);
                }
                rows.push({ gi: gi, gate: reprojectionGate(groups[gi].size) });
                cost3.push(costRow);
            }
            if (rows.length === 0) continue;

            var assign3 = hungarianAlgorithm(cost3);
            for (var r = 0; r < assign3.length; r++) {
                var ii2 = assign3[r];
                if (ii2 < 0 || ii2 >= insts3.length || used.has(ii2)) continue;
                if (cost3[r][ii2] < rows[r].gate) {
                    groups[rows[r].gi].set(camName, insts3[ii2]);
                    used.add(ii2);
                    attachedAny = true;
                }
            }
        }
        if (!attachedAny) break;   // converged — no group grew this pass
    }

    // Solo groups for unmatched instances (unconstrained only).
    if (!numAnimals) {
        for (var sci = 0; sci < remainingCams.length; sci++) {
            var scn = remainingCams[sci];
            var sInsts = camInstances[scn];
            if (!sInsts) continue;
            var sUsed = attachedInsts[scn];
            for (var si = 0; si < sInsts.length; si++) {
                if (!sUsed.has(si)) {
                    var sg5 = new Map(); sg5.set(scn, sInsts[si]); groups.push(sg5);
                }
            }
        }
    }

    return groups;
}


// ============================================
// Triangulation helper
// ============================================

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

// ============================================
// Cross-View Tracker Integration
// ============================================

var globalTracker = null;
var trackerWorker = null;

function getTrackerHyperparams() {
    var el2d = document.getElementById('trackerWeight2d');
    return {
        correspondenceWeight2d: el2d ? parseFloat(el2d.value) : 1.0,
        correspondenceWeight3d: document.getElementById('trackerWeight3d') ? parseFloat(document.getElementById('trackerWeight3d').value) : 1.0,
        velocityThreshold: document.getElementById('trackerVelocity') ? parseFloat(document.getElementById('trackerVelocity').value) : 1.0,
        distanceThreshold: document.getElementById('trackerDistance') ? parseFloat(document.getElementById('trackerDistance').value) : 1.0,
        timePenalty: document.getElementById('trackerTimePenalty') ? parseFloat(document.getElementById('trackerTimePenalty').value) : 1.0
    };
}

// Tracker state: number of animals (null = unconstrained)
var trackerNumAnimals = null;

// Auto-detect cap: the largest instance count seen in any (camera, frame)
// pair across the session. Without a cap, leftover groups that survive
// reorder spawn fresh addIdentity('id_N') calls per frame and the identity
// count drifts upward; capping at the data-derived max keeps the identity
// pool stable at the true animal count.
function computeMaxInstancesPerView(session) {
    var max = 0;
    var cams = session.cameras || [];
    for (var fi of session.frameGroups.keys()) {
        var fg = session.frameGroups.get(fi);
        for (var ci = 0; ci < cams.length; ci++) {
            var cn = cams[ci].name;
            var linked = fg.getInstances(cn);
            var unlinked = fg.getUnlinkedInstances(cn);
            var count = (linked ? linked.length : 0) + (unlinked ? unlinked.length : 0);
            if (count > max) max = count;
        }
    }
    return max;
}

function promptNumAnimals() {
    var input = prompt('Number of animals (leave empty for auto-detect):', trackerNumAnimals || '');
    if (input === null) return false;  // cancelled
    input = input.trim();
    if (input === '') {
        trackerNumAnimals = null;
    } else {
        var n = parseInt(input);
        if (isNaN(n) || n < 1) {
            setStatus('Invalid number', 'error');
            return false;
        }
        trackerNumAnimals = n;
    }
    return true;
}

export function trackCurrentFrame() {
    var session = getActiveSession();
    if (!session || !session.cameras || session.cameras.length === 0) {
        setStatus('No session with cameras loaded', 'error');
        return;
    }
    var fg = session.getFrameGroup(state.currentFrame);
    if (!fg) {
        setStatus('No frame data at frame ' + state.currentFrame, 'error');
        return;
    }

    // Prompt for number of animals on first use
    if (trackerNumAnimals == null) {
        if (!promptNumAnimals()) return;
    }

    var effectiveNumAnimals = trackerNumAnimals || computeMaxInstancesPerView(session);

    try {
        var result = matchFrameInstances(fg, session.cameras, session, {
            numAnimals: effectiveNumAnimals
        });
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.refreshTracks(state.session);
        if (result.numIdentities > 0) {
            setStatus('Frame ' + state.currentFrame + ': ' + result.numIdentities + ' identities' +
                (effectiveNumAnimals ? ' (capped at ' + effectiveNumAnimals + ')' : ''), 'success');
        } else {
            setStatus('No cross-view matches found (need instances in 2+ views)', 'warning');
        }
    } catch (e) {
        console.error('[Tracker] error:', e, e.stack);
        setStatus('Tracker error: ' + e.message + ' | ' + (e.stack ? e.stack.split('\n')[1] : ''), 'error');
    }
}

export function findMatchForSelected() {
    var session = getActiveSession();
    if (!session || !session.cameras || session.cameras.length === 0) return;
    if (!interactionManager) return;

    // Determine the selected instance and its camera
    var selectedInst = null;
    var selectedCam = null;

    if (interactionManager.selectedUnlinked) {
        // Unlinked instance: single-view, has .instance and .cameraName
        selectedInst = interactionManager.selectedUnlinked.instance;
        selectedCam = interactionManager.selectedUnlinked.cameraName;
    } else if (interactionManager.selectedInstanceGroup) {
        // Grouped instance: pick the first camera's instance
        var group = interactionManager.selectedInstanceGroup;
        var iter = group.instances.entries();
        var first = iter.next();
        if (!first.done) {
            selectedCam = first.value[0];
            selectedInst = first.value[1];
        }
    }

    if (!selectedInst || !selectedCam) {
        setStatus('Select an instance first', 'warning');
        return;
    }
    if (!globalTracker) {
        // TODO: CrossViewTracker is not defined anywhere in the codebase.
        // Pre-existing latent bug (existed in app.js before Pass 3i-1 extraction).
        // Calling findMatchForSelected() without a pre-set globalTracker will throw ReferenceError.
        globalTracker = new CrossViewTracker(getTrackerHyperparams());
    }
    var fg = session.getFrameGroup(state.currentFrame);
    if (!fg) return;

    var matches = globalTracker.findMatchesForInstance(selectedInst, selectedCam, fg, session.cameras);
    if (matches.size === 0) {
        setStatus('No matches found in other views', 'warning');
        return;
    }

    // Report matches
    var parts = [];
    matches.forEach(function (match, camName) {
        parts.push(camName + ' (err=' + match.score.toFixed(1) + ')');
    });
    setStatus('Matches: ' + parts.join(', '), 'success');

    // TODO: Visual highlight of matched instances (phase 2)
}

export async function trackAll() {
    var session = getActiveSession();
    if (!session || !session.cameras || session.cameras.length === 0) {
        setStatus('No session with cameras loaded', 'error');
        return;
    }

    var cameras = session.cameras;
    if (cameras.length < 2) {
        setStatus('Need at least 2 cameras', 'warning');
        return;
    }

    var frameIndices = session.frameIndices;
    if (frameIndices.length === 0) {
        setStatus('No frames to track', 'error');
        return;
    }

    // Prompt for number of animals
    if (trackerNumAnimals == null) {
        if (!promptNumAnimals()) return;
    }
    var effectiveNumAnimals = trackerNumAnimals || computeMaxInstancesPerView(session);
    console.log('[TrackAll] numAnimals:', effectiveNumAnimals,
        trackerNumAnimals ? '(user-set)' : '(auto-detected from max instances per view)',
        'frames:', frameIndices.length);
    console.time('[TrackAll] total');

    // Clear old identities for fresh run
    session.identities = [];
    session.frameIdentityMap = new Map();

    showLoading('Assigning identities: 0/' + frameIndices.length + ' frames...');

    var YIELD_EVERY = 50;

    var prevAssignments = null;
    var prevTargets3d = null;
    try {
        for (var f = 0; f < frameIndices.length; f++) {
            var fi = frameIndices[f];
            var fg = session.getFrameGroup(fi);
            if (fg) {
                try {
                    var result = matchFrameInstances(fg, cameras, session, {
                        numAnimals: effectiveNumAnimals,
                        perFrame: true,
                        prevAssignments: prevAssignments,
                        prevTargets3d: prevTargets3d
                    });
                    if (result.assignments && result.assignments.size > 0) {
                        prevAssignments = result.assignments;
                    }
                    if (result.targets3d && result.targets3d.length > 0) {
                        prevTargets3d = result.targets3d;
                    }
                } catch (frameErr) {
                    console.error('[TrackAll] Error at frame ' + fi + ':', frameErr);
                    // Continue to next frame instead of aborting
                }
            }

            if (f % YIELD_EVERY === 0) {
                document.getElementById('loadingStatus').textContent =
                    'Assigning identities: ' + (f + 1) + '/' + frameIndices.length + ' frames...';
                await new Promise(function (r) { setTimeout(r, 0); });
            }
        }

        hideLoading();
        drawAllOverlays(state.currentFrame);
        console.timeEnd('[TrackAll] total');
        updateInfoPanel();
        if (timeline) timeline.refreshTracks(state.session);
        setStatus('Tracked ' + frameIndices.length + ' frames, ' +
            session.identities.length + ' identities', 'success');
    } catch (e) {
        hideLoading();
        console.error('[TrackAll] error:', e, e.stack);
        setStatus('Track All error: ' + e.message + ' | ' + (e.stack ? e.stack.split('\n')[1] : ''), 'error');
    }
}

// Wire up tracker buttons
(function () {
    var btnTrackFrame = document.getElementById('tbTrackFrame');
    var btnTrackAll = document.getElementById('tbTrackAll');
    var btnCancel = document.getElementById('trackerCancel');

    if (btnTrackFrame) btnTrackFrame.addEventListener('click', trackCurrentFrame);
    if (btnTrackAll) btnTrackAll.addEventListener('click', trackAll);
    if (btnCancel) btnCancel.addEventListener('click', function () {
        if (trackerWorker) trackerWorker.postMessage({ type: 'cancel' });
    });

    // Slider value display
    ['trackerWeight2d', 'trackerWeight3d', 'trackerVelocity', 'trackerDistance', 'trackerTimePenalty'].forEach(function (id) {
        var slider = document.getElementById(id);
        var valSpan = document.getElementById(id + 'Val');
        if (slider && valSpan) {
            slider.addEventListener('input', function () {
                valSpan.textContent = slider.value;
                // Reset tracker so new hyperparams take effect
                globalTracker = null;
            });
        }
    });
})();
