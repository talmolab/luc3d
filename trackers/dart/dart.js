/**
 * trackers/dart/dart.js — Dynamic Anchor Ranking Tracker.
 *
 * Composes four algorithm modules into a single tracking pipeline that
 * self-registers with window.LucidTrackers:
 *
 *   1. trackers/dart/camera-ranking.js   — per-frame camera quality ranking
 *   2. trackers/dart/bytetrack.js        — two-pass greedy assignment
 *   3. trackers/dart/mincostflow.js      — network-flow assignment solver
 *   4. trackers/dart/kalman.js           — constant-velocity Kalman filter
 *
 * Per-frame control flow (see DART_integration_plan.md §2.1):
 *   - Rank cameras → pick anchor pair + additional participants.
 *   - Score anchor pair via crossViewScore(+temporalBonus).
 *   - Dispatch assignment: Hungarian / ByteTrack / Min-Cost Flow.
 *   - Attach remaining participating cameras via reprojection distance.
 *   - Temporal reordering against prev targets (copied from default.js).
 *   - Triangulate groups, Kalman predict+update centroids, cull lost tracks.
 *   - Identity voting (copied from default.js).
 *   - Write per-camera `cameraRank` into session.trackerVariables.
 *
 * Depends on globals from triangulation.js:
 *   triangulatePointDLT, reprojectPoint, triangulatePoints, reprojectPoints,
 *   computeInstanceDistance, computeFundamentalMatrix, hungarianAlgorithm.
 */

(function () {
    'use strict';

    if (!window.LucidTrackers) {
        throw new Error('trackers/dart/dart.js loaded before trackers/registry.js');
    }
    if (!window.LucidDART ||
        !window.LucidDART.byteTrackAssignArray ||
        !window.LucidDART.minCostFlowAssign ||
        !window.LucidDART.KalmanTrack ||
        !window.LucidDART.CameraRanker) {
        throw new Error('trackers/dart/dart.js loaded before one or more DART primitives');
    }

    // ============================================
    // Inlined constants (temporal-reordering internals, copied from default.js)
    // ============================================
    var EPIPOLAR_SCALE_PX     = 10.0;
    var OKS_SIGMA_PX          = 20.0;
    var EPIPOLAR_WEIGHT       = 0.4;
    var REPROJECTION_WEIGHT   = 0.6;
    var REPROJ_SCALE_PX       = 50.0;
    var THREED_SCALE          = 30.0;
    var REPROJ_MATCH_CUTOFF   = 100;
    var CONTINUITY_WEIGHT     = 2.0;
    var INVALID_COST          = 1000;
    var SCORE_THRESHOLD       = 0.05;

    // ============================================
    // Module-scoped state
    // ============================================
    var _fMatrixCache     = {};
    var _undistortCache   = new WeakMap();
    var _cameraRanker     = null;
    var _cameraRankerSession = null;
    var _kalmanTracks     = new Map();
    var _lastCamResiduals = {};   // per-camera mean reprojection residual from the previous frame
    var _declaredCameraRank = false;

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

    // ============================================
    // Scoring (verbatim from default.js, hyperparams inlined)
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
        return Math.exp(-totalErr / validCount / EPIPOLAR_SCALE_PX);
    }

    function reprojectionScore(instA, camA, instB, camB) {
        var uA = getUndistortedPoints(instA, camA);
        var uB = getUndistortedPoints(instB, camB);
        var PA = camA.projectionMatrix, PB = camB.projectionMatrix;
        var numKp = Math.min(uA.length, uB.length);
        var totalOks = 0, validCount = 0;
        var sigma2x2 = 2 * OKS_SIGMA_PX * OKS_SIGMA_PX;

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
        return EPIPOLAR_WEIGHT     * epipolarScore(instA, camA, instB, camB) +
               REPROJECTION_WEIGHT * reprojectionScore(instA, camA, instB, camB);
    }

    // ============================================
    // Collect instances (verbatim from default.js)
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
    // Triangulation helper (verbatim from default.js)
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

    function groupCentroid(pts3d) {
        if (!pts3d) return null;
        var sx = 0, sy = 0, sz = 0, n = 0;
        for (var k = 0; k < pts3d.length; k++) {
            var p = pts3d[k];
            if (p && isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2])) {
                sx += p[0]; sy += p[1]; sz += p[2]; n++;
            }
        }
        if (n === 0) return null;
        return [sx / n, sy / n, sz / n];
    }

    function meanReprojResidual(group, pts3d, camMap) {
        if (!pts3d) return {};
        var out = {};
        group.forEach(function (inst, cn) {
            var cam = camMap[cn];
            if (!cam) return;
            var reproj = reprojectPoints(pts3d, cam.projectionMatrix);
            var total = 0, count = 0;
            for (var k = 0; k < reproj.length; k++) {
                var r = reproj[k], o = inst.points[k];
                if (!r || !o) continue;
                var dx = r[0] - o[0], dy = r[1] - o[1];
                total += Math.sqrt(dx * dx + dy * dy);
                count++;
            }
            if (count > 0) out[cn] = total / count;
        });
        return out;
    }

    // ============================================
    // Pairwise matching — DART variant
    // Replaces default.js::matchPairwise. Accepts orderedCams from the
    // camera ranker instead of count-desc ordering; dispatches assignment
    // via cfg.assignmentMethod over a full crossViewScore matrix.
    // ============================================

    function matchPairwise(camInstances, camMap, orderedCams, numAnimals, prevAssignments, cfg) {
        if (orderedCams.length < 2) return [];

        var cam1Name = orderedCams[0], cam2Name = orderedCams[1];
        var cam1 = camMap[cam1Name], cam2 = camMap[cam2Name];
        var insts1 = camInstances[cam1Name], insts2 = camInstances[cam2Name];

        if (!insts1 || !insts2 || insts1.length === 0 || insts2.length === 0) return [];

        // Full crossViewScore matrix with temporal bonus.
        var scoreMatrix = [];
        for (var a = 0; a < insts1.length; a++) {
            scoreMatrix[a] = [];
            for (var b = 0; b < insts2.length; b++) {
                var s = crossViewScore(insts1[a], cam1, insts2[b], cam2);
                if (prevAssignments) {
                    var pidA = prevAssignments.get(cam1Name + ':' + insts1[a].trackIdx);
                    var pidB = prevAssignments.get(cam2Name + ':' + insts2[b].trackIdx);
                    if (pidA != null && pidB != null && pidA === pidB) s += cfg.temporalBonus;
                }
                scoreMatrix[a][b] = s;
            }
        }

        // Dispatch on assignment method. All three branches return result[row]=col.
        var assignment;
        if (cfg.assignmentMethod === 'hungarian') {
            var costMatrix = scoreMatrix.map(function (row) {
                return row.map(function (v) { return -v; });
            });
            assignment = hungarianAlgorithm(costMatrix);
        } else if (cfg.assignmentMethod === 'mincostflow') {
            assignment = window.LucidDART.minCostFlowAssign(scoreMatrix);
        } else {
            // 'bytetrack' (default)
            assignment = window.LucidDART.byteTrackAssignArray(scoreMatrix, cfg.bytetrack);
        }

        // Build sorted matches list.
        var matches = [];
        for (var a2 = 0; a2 < assignment.length; a2++) {
            var b2 = assignment[a2];
            if (b2 < 0 || b2 >= insts2.length) continue;
            matches.push({ a: a2, b: b2, score: scoreMatrix[a2][b2] });
        }
        matches.sort(function (x, y) { return y.score - x.score; });

        if (numAnimals) {
            matches = matches.slice(0, numAnimals);
        } else {
            matches = matches.filter(function (m) { return m.score > SCORE_THRESHOLD; });
        }

        // Seed groups from anchor pair.
        var groups = [];
        var matched1 = new Set(), matched2 = new Set();
        for (var mi = 0; mi < matches.length; mi++) {
            var g = new Map();
            g.set(cam1Name, insts1[matches[mi].a]);
            g.set(cam2Name, insts2[matches[mi].b]);
            groups.push(g);
            matched1.add(matches[mi].a);
            matched2.add(matches[mi].b);
        }

        // Singletons to meet numAnimals (or include all unmatched when unconstrained).
        if (numAnimals && groups.length < numAnimals) {
            for (var a3 = 0; a3 < insts1.length && groups.length < numAnimals; a3++) {
                if (!matched1.has(a3)) {
                    var sg = new Map(); sg.set(cam1Name, insts1[a3]); groups.push(sg);
                }
            }
            for (var b3 = 0; b3 < insts2.length && groups.length < numAnimals; b3++) {
                if (!matched2.has(b3)) {
                    var sg2 = new Map(); sg2.set(cam2Name, insts2[b3]); groups.push(sg2);
                }
            }
        }
        if (!numAnimals) {
            for (var a4 = 0; a4 < insts1.length; a4++) {
                if (!matched1.has(a4)) {
                    var sg3 = new Map(); sg3.set(cam1Name, insts1[a4]); groups.push(sg3);
                }
            }
            for (var b4 = 0; b4 < insts2.length; b4++) {
                if (!matched2.has(b4)) {
                    var sg4 = new Map(); sg4.set(cam2Name, insts2[b4]); groups.push(sg4);
                }
            }
        }

        // Attach additional participating cameras by reprojection distance.
        for (var ci2 = 2; ci2 < orderedCams.length; ci2++) {
            var camName = orderedCams[ci2];
            var cam3 = camMap[camName];
            var insts3 = camInstances[camName];
            if (!cam3 || !insts3 || insts3.length === 0) continue;

            var cost3 = [];
            for (var gi = 0; gi < groups.length; gi++) {
                cost3[gi] = [];
                var pts3d = triangulateGroup(groups[gi], camMap);
                var reproj3 = pts3d ? reprojectPoints(pts3d, cam3.projectionMatrix) : null;
                for (var ii = 0; ii < insts3.length; ii++) {
                    cost3[gi][ii] = reproj3 ? computeInstanceDistance(reproj3, insts3[ii].points) : Infinity;
                }
            }
            if (cost3.length > 0) {
                var assign3 = hungarianAlgorithm(cost3);
                var matched3 = new Set();
                for (var gi2 = 0; gi2 < assign3.length; gi2++) {
                    var ii2 = assign3[gi2];
                    if (ii2 >= 0 && ii2 < insts3.length && cost3[gi2][ii2] < REPROJ_MATCH_CUTOFF) {
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
    // Temporal reordering (verbatim from default.js, constants inlined)
    // ============================================

    function reorderGroupsByPrevTargets(groups, prevTargets3d, camMap, prevAssignments) {
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
                if (ti >= nTargets || gi >= nGroups) { cost[ti][gi] = INVALID_COST; continue; }

                var prevPts3d = prevTargets3d[ti].points3d;
                var currPts3d = groupPts3d[gi];
                var score = 0, scoreCount = 0;

                if (prevPts3d) {
                    var reprojTotal = 0, reprojCount = 0;
                    groups[gi].forEach(function (inst, camName) {
                        var cam = camMap[camName];
                        if (!cam) return;
                        var reproj = reprojectPoints(prevPts3d, cam.projectionMatrix);
                        var d = computeInstanceDistance(reproj, inst.points);
                        if (d < Infinity) { reprojTotal += d; reprojCount++; }
                    });
                    if (reprojCount > 0) {
                        score += Math.exp(-(reprojTotal / reprojCount) / REPROJ_SCALE_PX);
                        scoreCount++;
                    }
                }

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
                        score += Math.exp(-(totalDist3d / count3d) / THREED_SCALE);
                        scoreCount++;
                    }
                }

                if (currPts3d && prevTargets3d[ti].prevInstances) {
                    var prevInsts = prevTargets3d[ti].prevInstances;
                    var oksTotal = 0, oksCount = 0;
                    prevInsts.forEach(function (prevInst, camName) {
                        var cam = camMap[camName];
                        if (!cam || !prevInst) return;
                        var reproj = reprojectPoints(currPts3d, cam.projectionMatrix);
                        var d = computeInstanceDistance(reproj, prevInst.points);
                        if (d < Infinity) { oksTotal += Math.exp(-d / REPROJ_SCALE_PX); oksCount++; }
                    });
                    if (oksCount > 0) { score += oksTotal / oksCount; scoreCount++; }
                }

                if (prevAssignments && prevTargets3d[ti].identityId != null) {
                    var matchingTracks = 0, totalTracks = 0;
                    groups[gi].forEach(function (inst, camName) {
                        totalTracks++;
                        var prevId = prevAssignments.get(camName + ':' + inst.trackIdx);
                        if (prevId != null && prevId === prevTargets3d[ti].identityId) matchingTracks++;
                    });
                    if (totalTracks > 0) {
                        score += CONTINUITY_WEIGHT * (matchingTracks / totalTracks);
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
        var usedGroups = new Set(assignment.filter(function (g) { return g >= 0 && g < nGroups; }));
        for (var gi3 = 0; gi3 < nGroups; gi3++) {
            if (!usedGroups.has(gi3)) reordered.push(groups[gi3]);
        }
        return reordered;
    }

    // ============================================
    // Kalman lifecycle helpers
    // ============================================

    function kalmanPredictAll() {
        _kalmanTracks.forEach(function (track) { track.predict(); });
    }

    function kalmanUpdateGroup(identityId, centroid3d, kalmanCfg) {
        if (identityId == null || !centroid3d) return;
        var track = _kalmanTracks.get(identityId);
        if (!track) {
            track = new window.LucidDART.KalmanTrack(centroid3d, kalmanCfg);
            _kalmanTracks.set(identityId, track);
        } else {
            track.update(centroid3d);
        }
    }

    function kalmanCullLost() {
        var toDelete = [];
        _kalmanTracks.forEach(function (track, id) {
            if (track.isLost()) toDelete.push(id);
        });
        for (var i = 0; i < toDelete.length; i++) _kalmanTracks.delete(toDelete[i]);
    }

    // ============================================
    // Hyperparameter reconstitution
    // ============================================

    function buildConfig(hp) {
        hp = hp || {};
        var pick = function (k, dflt) { return (hp[k] != null) ? hp[k] : dflt; };
        return {
            assignmentMethod: pick('assignmentMethod', 'bytetrack'),
            temporalBonus:    pick('temporalBonus', 0.3),
            bytetrack: {
                highThresh: pick('bt_highThresh', 0.8),
                lowThresh:  pick('bt_lowThresh',  0.05)
            },
            mincostflow: {
                windowSize:   pick('mcf_windowSize',   3),
                skipEdgeCost: pick('mcf_skipEdgeCost', 0.1)
            },
            kalman: {
                processNoise:     pick('km_processNoise',     0.1),
                measurementNoise: pick('km_measurementNoise', 10),
                maxMissedFrames:  pick('km_maxMissedFrames',  10),
                dt:               pick('km_dt',               1)
            },
            cameraRanking: {
                enabled:                pick('cr_enabled',                true),
                w1:                     pick('cr_w1',                     0.35),
                w2:                     pick('cr_w2',                     0.25),
                w3:                     pick('cr_w3',                     0.25),
                w4:                     pick('cr_w4',                     0.15),
                participationThreshold: pick('cr_participationThreshold', 0.45),
                emaAlpha:               pick('cr_emaAlpha',               0.2),
                occlusionWindow:        pick('cr_occlusionWindow',        10),
                occlusionDropThresh:    pick('cr_occlusionDropThresh',    0.3),
                maxReprojPx:            pick('cr_maxReprojPx',            50),
                hysteresisFrames:       pick('cr_hysteresisFrames',       3)
            }
        };
    }

    // ============================================
    // Camera ordering
    // ============================================

    function orderCameras(cameras, camInstances, activeCams, cfg, numAnimals, session) {
        // Fallback when ranker disabled or too few cams — count-desc (default.js behavior).
        if (!cfg.cameraRanking.enabled || activeCams.length < 2) {
            return {
                orderedCams: activeCams.slice().sort(function (a, b) {
                    return camInstances[b].length - camInstances[a].length;
                }),
                ranks: null
            };
        }

        if (_cameraRankerSession !== session) {
            _cameraRanker = new window.LucidDART.CameraRanker(cfg.cameraRanking);
            _cameraRankerSession = session;
        }

        // Feed ALL cameras (including 0-instance ones) so the ranker's cumulative
        // completeness metric correctly penalizes cameras that are frequently absent.
        var frameData = {};
        for (var i = 0; i < cameras.length; i++) {
            var cn = cameras[i].name;
            frameData[cn] = {
                instances: camInstances[cn] || [],
                reprojResidualPx: _lastCamResiduals[cn]
            };
        }

        var expected = numAnimals || 1;
        var result = _cameraRanker.rankFrame(frameData, expected);
        var ordered = result.selected.ordered.slice();

        // Drop cameras the ranker admitted but that have no instances this frame.
        // They'd just waste a Hungarian pass in matchPairwise with all-Infinity costs.
        ordered = ordered.filter(function (cn) { return (camInstances[cn] || []).length > 0; });

        // Safety net: if filtering collapsed the list below the 2-camera minimum,
        // fall back to count-desc ordering over active cams only.
        if (ordered.length < 2) {
            ordered = activeCams.slice().sort(function (a, b) {
                return camInstances[b].length - camInstances[a].length;
            });
        }

        return { orderedCams: ordered, ranks: result.ranks };
    }

    function writeCameraRankVars(session, frameIdx, ranks) {
        if (!ranks) return;
        if (!_declaredCameraRank && session && typeof session.declareTrackerVariable === 'function') {
            session.declareTrackerVariable('cameraRank', {
                label: 'Camera Rank',
                yMin: 0,
                yMax: 1
            });
            _declaredCameraRank = true;
        }
        if (!session || typeof session.setTrackerVariable !== 'function') return;
        for (var cn in ranks) {
            session.setTrackerVariable(cn, 'cameraRank', frameIdx, ranks[cn]);
        }
    }

    // ============================================
    // Public entry point
    // ============================================

    function dartTracker(frameGroup, cameras, session, opts) {
        opts = opts || {};
        var numAnimals      = opts.numAnimals      || null;
        var prevAssignments = opts.prevAssignments || null;
        var prevTargets3d   = opts.prevTargets3d   || null;
        var cfg             = buildConfig(opts.hyperparameters);

        // Kalman lifecycle: prevAssignments==null is the trackFrame entry
        // or first frame of trackAll — start fresh.
        if (prevAssignments == null) {
            _kalmanTracks = new Map();
            _lastCamResiduals = {};
        }
        if (_cameraRankerSession !== session) {
            _declaredCameraRank = false;
        }

        var collected = collectInstances(frameGroup, cameras);
        var camInstances = collected.camInstances;
        var camMap       = collected.camMap;
        var activeCams   = collected.activeCams;

        if (activeCams.length < 2) {
            return { groups: [], numIdentities: 0, assignments: new Map(), targets3d: [] };
        }

        // Camera ranking → ordered anchor + participating cams.
        var ordering = orderCameras(cameras, camInstances, activeCams, cfg, numAnimals, session);
        var orderedCams = ordering.orderedCams;
        writeCameraRankVars(session, frameGroup.frameIdx, ordering.ranks);

        // Kalman predict before assignment.
        kalmanPredictAll();

        // Assignment (dispatches on cfg.assignmentMethod).
        var groups = matchPairwise(camInstances, camMap, orderedCams, numAnimals, prevAssignments, cfg);

        // Temporal reordering (verbatim behavior from default.js).
        if (prevTargets3d && prevTargets3d.length > 0 && groups.length > 0) {
            groups = reorderGroupsByPrevTargets(groups, prevTargets3d, camMap, prevAssignments);
        }

        // Triangulate + collect per-camera residuals for next frame's ranking feed.
        var targets3d = [];
        var nextCamResiduals = {};
        var residualCounts   = {};
        for (var gi = 0; gi < groups.length; gi++) {
            var pts3d = triangulateGroup(groups[gi], camMap);
            targets3d.push({ points3d: pts3d, groupIdx: gi, prevInstances: groups[gi] });

            if (pts3d) {
                var residMap = meanReprojResidual(groups[gi], pts3d, camMap);
                for (var cn in residMap) {
                    nextCamResiduals[cn] = (nextCamResiduals[cn] || 0) + residMap[cn];
                    residualCounts[cn]   = (residualCounts[cn]   || 0) + 1;
                }
            }
        }
        for (var cn2 in nextCamResiduals) {
            nextCamResiduals[cn2] /= residualCounts[cn2];
        }
        _lastCamResiduals = nextCamResiduals;

        // Identity voting (verbatim from default.js).
        if (numAnimals) {
            while (session.identities.length < numAnimals) {
                session.addIdentity('id_' + session.identities.length);
            }
        }

        var fi = frameGroup.frameIdx;
        var assignments = new Map();
        var usedIds = new Set();

        for (var g = 0; g < groups.length; g++) {
            var identity = null;

            if (prevAssignments) {
                var votes = {};
                groups[g].forEach(function (inst, cn) {
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

            groups[g].forEach(function (inst, cn) {
                session.trackIdentityMap.set(cn + ':' + inst.trackIdx, identity.id);
                if (opts.perFrame && session.setFrameIdentity) {
                    session.setFrameIdentity(fi, cn, inst.trackIdx, identity.id);
                }
                assignments.set(cn + ':' + inst.trackIdx, identity.id);
            });

            // Kalman update on group centroid keyed by identity.
            kalmanUpdateGroup(identity.id, groupCentroid(targets3d[g].points3d), cfg.kalman);
        }

        kalmanCullLost();

        return { groups: groups, numIdentities: groups.length, assignments: assignments, targets3d: targets3d };
    }

    // ============================================
    // Registration
    // ============================================

    window.LucidTrackers.register('DART', dartTracker, {
        name: 'DART',
        description: 'Dynamic Anchor Ranking Tracker. Composes Hungarian / ByteTrack / Min-Cost Flow assignment with a Kalman filter and dynamic camera ranking.',
        hyperparameters: [
            { key: 'assignmentMethod', label: 'Assignment method', type: 'enum',
              default: 'bytetrack',
              options: [
                  { value: 'hungarian',   label: 'Hungarian',
                    tooltip: 'Single global-optimum assignment on the cross-view score matrix. Baseline; no low-confidence gap-fill.' },
                  { value: 'bytetrack',   label: 'ByteTrack',
                    tooltip: 'Two-pass greedy: pass 1 matches only high-confidence pairs (>= bt_highThresh); pass 2 fills gaps using surviving unmatched rows/cols above bt_lowThresh.' },
                  { value: 'mincostflow', label: 'Min-Cost Flow',
                    tooltip: 'Network-flow solver over the score matrix. Equivalent to Hungarian for single-frame assignment; supports temporal windowing in follow-up work.' }
              ],
              help: 'Hungarian = single global optimum. ByteTrack = two-pass greedy (hi-conf first, lo-conf gap-fill). Min-Cost Flow = network solver over a temporal window.' },

            { key: 'temporalBonus', label: 'Previous-assignment bonus', type: 'number',
              default: 0.3, min: 0, max: 2, step: 0.05,
              help: 'Score bonus when previous identity assignments match.' },

            { key: 'bt_highThresh', label: 'ByteTrack high threshold', type: 'number',
              default: 0.8, min: 0, max: 1, step: 0.05,
              help: 'Pass-1 accepts only matches above this score.' },
            { key: 'bt_lowThresh',  label: 'ByteTrack low threshold',  type: 'number',
              default: 0.05, min: 0, max: 1, step: 0.01,
              help: 'Pass-2 floor; matches below this are ignored.' },

            { key: 'mcf_windowSize',   label: 'MCF window size (frames)', type: 'number',
              default: 3, min: 1, max: 5, step: 1,
              help: 'Temporal window size for minCostFlowAssignWindow (follow-up; single-frame path ignores this).' },
            { key: 'mcf_skipEdgeCost', label: 'MCF skip-edge cost',       type: 'number',
              default: 0.1, min: 0, max: 1, step: 0.05 },

            { key: 'km_processNoise',     label: 'Kalman process noise',     type: 'number',
              default: 0.1, min: 0, step: 0.01 },
            { key: 'km_measurementNoise', label: 'Kalman measurement noise', type: 'number',
              default: 10, min: 0, step: 0.5 },
            { key: 'km_maxMissedFrames',  label: 'Kalman max missed frames', type: 'number',
              default: 10, min: 1, step: 1 },
            { key: 'km_dt',               label: 'Kalman dt (s)',            type: 'number',
              default: 1, min: 0.001, step: 0.01 },

            { key: 'cr_enabled',                label: 'Camera ranking enabled',    type: 'boolean', default: true,
              help: 'When disabled, falls back to count-desc camera ordering (default tracker behavior).' },
            { key: 'cr_w1',                     label: 'w1 meanConfidence',         type: 'number',  default: 0.35, min: 0, max: 1, step: 0.05 },
            { key: 'cr_w2',                     label: 'w2 completeness',           type: 'number',  default: 0.25, min: 0, max: 1, step: 0.05 },
            { key: 'cr_w3',                     label: 'w3 reproj quality',         type: 'number',  default: 0.25, min: 0, max: 1, step: 0.05 },
            { key: 'cr_w4',                     label: 'w4 occlusion penalty',      type: 'number',  default: 0.15, min: 0, max: 1, step: 0.05 },
            { key: 'cr_participationThreshold', label: 'Participation threshold',   type: 'number',  default: 0.45, min: 0, max: 1, step: 0.05 },
            { key: 'cr_emaAlpha',               label: 'EMA alpha',                 type: 'number',  default: 0.2,  min: 0, max: 1, step: 0.05 },
            { key: 'cr_occlusionWindow',        label: 'Occlusion window (frames)', type: 'number',  default: 10,   min: 1, step: 1 },
            { key: 'cr_occlusionDropThresh',    label: 'Occlusion drop threshold',  type: 'number',  default: 0.3,  min: 0, max: 1, step: 0.05 },
            { key: 'cr_maxReprojPx',            label: 'Max reproj (px)',           type: 'number',  default: 50,   min: 1, step: 1 },
            { key: 'cr_hysteresisFrames',       label: 'Hysteresis frames',         type: 'number',  default: 3,    min: 1, step: 1 }
        ]
    });
})();
