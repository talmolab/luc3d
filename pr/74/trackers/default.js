/**
 * trackers/default.js — the default LUCID tracking algorithm.
 *
 * Three-stage pipeline:
 *   1. Pairwise cross-view matching (epipolar-first, reprojection refinement)
 *   2. Temporal reordering (Hungarian over 4 signals)
 *   3. Identity assignment (voting from previous assignments)
 *
 * Depends on globals from pose-data.js / triangulation.js:
 *   triangulatePointDLT, reprojectPoint, triangulatePoints, reprojectPoints,
 *   computeInstanceDistance, computeFundamentalMatrix, hungarianAlgorithm
 *
 * Registers itself with window.LucidTrackers as 'default'.
 */

(function () {
    'use strict';

    // ============================================
    // Default hyperparameters
    // ============================================
    // Wired v1: scoreThreshold, temporalBonus, continuityWeight.
    // Other values currently referenced as inline constants in this file;
    // parameterize in a future pass.
    var DEFAULT_HP = {
        epipolarWeight: 0.4,
        reprojectionWeight: 0.6,     // computed at wizard read-time; included here for registry symmetry
        epipolarScalePx: 10.0,
        oksSigmaPx: 20.0,
        temporalBonus: 0.3,
        scoreThreshold: 0.05,
        reprojScalePx: 50.0,
        threeDScale: 30.0,
        reprojMatchCutoffPx: 100,
        continuityWeight: 2.0,
        invalidCost: 1000
    };

    // ============================================
    // Caches (per-module-load)
    // ============================================
    var _fMatrixCache = {};           // "cam1:cam2" -> F matrix
    var _undistortCache = new WeakMap();  // Instance -> undistorted points

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
    }

    // ============================================
    // Scoring
    // ============================================

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
        return Math.exp(-totalErr / validCount / 10.0);  // TODO(hyperparam): hp.epipolarScalePx
    }

    function reprojectionScore(instA, camA, instB, camB) {
        var uA = getUndistortedPoints(instA, camA);
        var uB = getUndistortedPoints(instB, camB);
        var PA = camA.projectionMatrix, PB = camB.projectionMatrix;
        var numKp = Math.min(uA.length, uB.length);
        var totalOks = 0, validCount = 0;
        var sigma2x2 = 2 * 20.0 * 20.0;  // TODO(hyperparam): hp.oksSigmaPx

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

    function crossViewScore(instA, camA, instB, camB) {
        // TODO(hyperparam): hp.epipolarWeight / hp.reprojectionWeight
        return 0.4 * epipolarScore(instA, camA, instB, camB) +
               0.6 * reprojectionScore(instA, camA, instB, camB);
    }

    // ============================================
    // Collect instances
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
    // Pairwise bootstrap
    // ============================================

    function matchPairwise(camInstances, camMap, activeCams, numAnimals, prevAssignments, hp) {
        var camsByCount = activeCams.slice().sort(function(a, b) {
            return camInstances[b].length - camInstances[a].length;
        });
        var bestCam1 = camsByCount[0], bestCam2 = camsByCount[1];
        var cam1 = camMap[bestCam1], cam2 = camMap[bestCam2];
        var insts1 = camInstances[bestCam1], insts2 = camInstances[bestCam2];
        var remainingCams = activeCams.filter(function(c) { return c !== bestCam1 && c !== bestCam2; });
        activeCams = [bestCam1, bestCam2].concat(remainingCams);

        var scoreMatrix = [];
        for (var a = 0; a < insts1.length; a++) {
            scoreMatrix[a] = [];
            for (var b = 0; b < insts2.length; b++) {
                var score = epipolarScore(insts1[a], cam1, insts2[b], cam2);
                if (prevAssignments) {
                    var pidA = prevAssignments.get(bestCam1 + ':' + insts1[a].trackIdx);
                    var pidB = prevAssignments.get(bestCam2 + ':' + insts2[b].trackIdx);
                    if (pidA != null && pidB != null && pidA === pidB) score += hp.temporalBonus;
                }
                scoreMatrix[a][b] = score;
            }
        }

        var costMatrix = scoreMatrix.map(function(row) { return row.map(function(v) { return -v; }); });
        var assignment = hungarianAlgorithm(costMatrix);

        var matches = [];
        for (var a2 = 0; a2 < assignment.length; a2++) {
            var b2 = assignment[a2];
            if (b2 < 0 || b2 >= insts2.length) continue;
            matches.push({ a: a2, b: b2, score: scoreMatrix[a2][b2] });
        }
        matches.sort(function(x, y) { return y.score - x.score; });

        var topN = numAnimals ? Math.min(numAnimals * 2, matches.length) : matches.length;
        for (var mi = 0; mi < topN; mi++) {
            var m = matches[mi];
            var fullScore = crossViewScore(insts1[m.a], cam1, insts2[m.b], cam2);
            if (prevAssignments) {
                var pA = prevAssignments.get(bestCam1 + ':' + insts1[m.a].trackIdx);
                var pB = prevAssignments.get(bestCam2 + ':' + insts2[m.b].trackIdx);
                if (pA != null && pB != null && pA === pB) fullScore += hp.temporalBonus;
            }
            matches[mi].score = fullScore;
        }
        matches.sort(function(x, y) { return y.score - x.score; });

        if (numAnimals) {
            matches = matches.slice(0, numAnimals);
        } else {
            matches = matches.filter(function(m) { return m.score > hp.scoreThreshold; });
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

        // Add remaining cameras via reprojection
        for (var ci2 = 2; ci2 < activeCams.length; ci2++) {
            var camName = activeCams[ci2];
            var cam3 = camMap[camName];
            var insts3 = camInstances[camName];
            if (!insts3 || insts3.length === 0) continue;

            var cost3 = [];
            for (var gi = 0; gi < groups.length; gi++) {
                cost3[gi] = [];
                var pts3d = triangulateGroup(groups[gi], camMap);
                var reproj3 = pts3d ? reprojectPoints(pts3d, cam3.projectionMatrix) : null;
                for (var ii = 0; ii < insts3.length; ii++) {
                    cost3[gi][ii] = reproj3 ? computeInstanceDistance(reproj3, insts3[ii].points) : Infinity;
                }
            }
            if (cost3.length > 0 && insts3.length > 0) {
                var assign3 = hungarianAlgorithm(cost3);
                var matched3 = new Set();
                for (var gi2 = 0; gi2 < assign3.length; gi2++) {
                    var ii2 = assign3[gi2];
                    if (ii2 >= 0 && ii2 < insts3.length && cost3[gi2][ii2] < 100) {
                        // TODO(hyperparam): hp.reprojMatchCutoffPx
                        groups[gi2].set(camName, insts3[ii2]);
                        matched3.add(ii2);
                    }
                }
                if (!numAnimals) {
                    for (var ii3 = 0; ii3 < insts3.length; ii3++) {
                        if (!matched3.has(ii3)) {
                            var sg5 = new Map(); sg5.set(camName, insts3[ii3]); groups.push(sg5);
                        }
                    }
                }
            }
        }

        return groups;
    }

    // ============================================
    // Temporal reordering
    // ============================================

    function reorderGroupsByPrevTargets(groups, prevTargets3d, camMap, prevAssignments, hp) {
        var nTargets = prevTargets3d.length;
        var nGroups = groups.length;
        var n = Math.max(nTargets, nGroups);

        var groupPts3d = [];
        for (var gi0 = 0; gi0 < nGroups; gi0++) {
            groupPts3d.push(triangulateGroup(groups[gi0], camMap));
        }

        var cost = [];
        for (var ti = 0; ti < n; ti++) {
            cost[ti] = [];
            for (var gi = 0; gi < n; gi++) {
                if (ti >= nTargets || gi >= nGroups) { cost[ti][gi] = 1000; continue; }
                // TODO(hyperparam): hp.invalidCost

                var prevPts3d = prevTargets3d[ti].points3d;
                var currPts3d = groupPts3d[gi];
                var score = 0, scoreCount = 0;

                // Signal 1: Reprojection distance
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
                        // TODO(hyperparam): hp.reprojScalePx
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
                        // TODO(hyperparam): hp.threeDScale
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

                // Signal 4: Track identity continuity (weighted)
                if (prevAssignments && prevTargets3d[ti].identityId != null) {
                    var matchingTracks = 0, totalTracks = 0;
                    groups[gi].forEach(function(inst, camName) {
                        totalTracks++;
                        var prevId = prevAssignments.get(camName + ':' + inst.trackIdx);
                        if (prevId != null && prevId === prevTargets3d[ti].identityId) matchingTracks++;
                    });
                    if (totalTracks > 0) {
                        score += hp.continuityWeight * (matchingTracks / totalTracks);
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
    // Public entry point
    // ============================================

    function defaultTracker(frameGroup, cameras, session, opts) {
        opts = opts || {};
        var numAnimals = opts.numAnimals || null;
        var prevAssignments = opts.prevAssignments || null;
        var prevTargets3d = opts.prevTargets3d || null;
        var hp = Object.assign({}, DEFAULT_HP, opts.hyperparameters || {});

        clearFrameCache();

        var collected = collectInstances(frameGroup, cameras);
        var camInstances = collected.camInstances;
        var camMap = collected.camMap;
        var activeCams = collected.activeCams;

        if (activeCams.length < 2) {
            return { groups: [], numIdentities: 0, assignments: new Map(), targets3d: [] };
        }

        var groups = matchPairwise(camInstances, camMap, activeCams, numAnimals, prevAssignments, hp);

        if (prevTargets3d && prevTargets3d.length > 0 && groups.length > 0) {
            groups = reorderGroupsByPrevTargets(groups, prevTargets3d, camMap, prevAssignments, hp);
        }

        var targets3d = [];
        for (var gi = 0; gi < groups.length; gi++) {
            var pts3d = triangulateGroup(groups[gi], camMap);
            targets3d.push({
                points3d: pts3d,
                groupIdx: gi,
                prevInstances: groups[gi]
            });
        }

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
                session.trackIdentityMap.set(cn + ':' + inst.trackIdx, identity.id);
                if (opts.perFrame && session.setFrameIdentity) {
                    session.setFrameIdentity(fi, cn, inst.trackIdx, identity.id);
                }
                assignments.set(cn + ':' + inst.trackIdx, identity.id);
            });
        }

        return { groups: groups, numIdentities: groups.length, assignments: assignments, targets3d: targets3d };
    }

    // ============================================
    // Registration
    // ============================================

    if (!window.LucidTrackers) {
        throw new Error('trackers/default.js loaded before trackers/registry.js');
    }

    window.LucidTrackers.register('default', defaultTracker, {
        name: 'default',
        description: 'Epipolar + reprojection cross-view matching with Hungarian temporal reordering (current LUCID tracker).',
        hyperparameters: [
            { key: 'epipolarWeight', label: 'Epipolar weight', type: 'number',
              default: 0.4, min: 0, max: 1, step: 0.05,
              help: 'crossViewScore = epipolarWeight * epipolar + reprojectionWeight * reprojection.' },
            { key: 'reprojectionWeight', label: 'Reprojection weight', type: 'number',
              default: 0.6, readOnly: true,
              computed: function (v) {
                  var e = (v.epipolarWeight != null) ? v.epipolarWeight : 0.4;
                  return 1 - e;
              },
              help: 'Derived as 1 - epipolarWeight.' },
            { key: 'epipolarScalePx', label: 'Epipolar scale (px)', type: 'number',
              default: 10.0, min: 0.1, step: 0.1,
              help: 'Denominator in exp(-err / scale).' },
            { key: 'oksSigmaPx', label: 'OKS sigma (px)', type: 'number',
              default: 20.0, min: 0.1, step: 0.1,
              help: 'Reprojection-consistency sigma; sigma2x2 = 2 * sigma * sigma.' },
            { key: 'temporalBonus', label: 'Previous-assignment bonus', type: 'number',
              default: 0.3, min: 0, max: 2, step: 0.05,
              help: 'Score bonus when previous identity assignments match. [wired]' },
            { key: 'scoreThreshold', label: 'Min match score', type: 'number',
              default: 0.05, min: 0, max: 1, step: 0.01,
              help: 'Unconstrained matches below this are dropped. [wired]' },
            { key: 'reprojScalePx', label: 'Reprojection distance scale', type: 'number',
              default: 50.0, min: 1, step: 1,
              help: 'Denominator in exp(-d / scale) for temporal reordering.' },
            { key: 'threeDScale', label: '3D distance scale', type: 'number',
              default: 30.0, min: 1, step: 1,
              help: 'Denominator in exp(-d3d / scale) for temporal reordering.' },
            { key: 'reprojMatchCutoffPx', label: '3D match cutoff (px)', type: 'number',
              default: 100, min: 1, step: 1,
              help: 'Max reprojection distance to accept a cross-frame 3D match.' },
            { key: 'continuityWeight', label: 'Track continuity weight', type: 'number',
              default: 2.0, min: 0, max: 10, step: 0.1,
              help: 'Weight for track-identity-continuity signal in reordering. [wired]' },
            { key: 'invalidCost', label: 'Invalid-slot cost', type: 'number',
              default: 1000, min: 1, step: 1,
              help: 'Padding cost for Hungarian dummy slots in temporal reordering.' }
        ]
    });
})();
