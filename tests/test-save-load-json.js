/**
 * test-save-load-json.js — Roundtrip tests for JSON save/load.
 *
 * Creates a fixture with all data fields (tracks, identities, instanceGroups,
 * points3d, reprojections, nulledNodes, occluded, frameIdentityMap, etc.),
 * serializes to JSON via the same logic as saveProject(), parses back, and
 * verifies every field survives the roundtrip.
 *
 * Aligned with sleap-io 3D format (Instance3D / PredictedInstance3D):
 *   - InstanceGroup ≈ Instance3D correspondence
 *   - points3d, reprojections, observedPoints, usedCameras
 *   - tracks, identities, per-frame identity overrides
 */

(function () {
    var describe = TestFramework.describe;
    var it = TestFramework.it;
    var beforeEach = TestFramework.beforeEach;
    var assertEqual = TestFramework.assertEqual;
    var assertDeepEqual = TestFramework.assertDeepEqual;
    var assertTrue = TestFramework.assertTrue;
    var assertFalse = TestFramework.assertFalse;
    var assertNotNull = TestFramework.assertNotNull;
    var assertNull = TestFramework.assertNull;

    // ============================================
    // Fixture: build a rich session with all fields
    // ============================================

    function buildFixtureSession() {
        var skeleton = new Skeleton('mouse', ['nose', 'ear', 'wrist'], [[0, 1], [1, 2]]);
        var cameras = [
            new Camera('CamA',
                [[500, 0, 320], [0, 500, 240], [0, 0, 1]],
                [0.1, -0.2, 0, 0, 0.05], [0.1, 0.2, 0.3], [10, 20, 30], [640, 480]),
            new Camera('CamB',
                [[600, 0, 256], [0, 600, 256], [0, 0, 1]],
                [-0.1, 0.1, 0, 0, 0], [0.5, 0.6, 0.7], [40, 50, 60], [512, 512]),
        ];
        var session = new Session(cameras, skeleton, ['track_0', 'track_1']);

        // Add identities
        session.addIdentity('mouse_A');
        session.addIdentity('mouse_B');

        // Set trustTracks
        session.trustTracks = true;

        // Frame identity map (per-frame overrides)
        if (!session.frameIdentityMap) session.frameIdentityMap = new Map();
        session.frameIdentityMap.set('5:CamA:0', 1); // frame 5, CamA, track 0 → identity 1
        session.frameIdentityMap.set('10:CamB:1', 0);

        // --- Frame 0: full group with triangulation data ---
        var fg0 = new FrameGroup(0);
        session.addFrameGroup(fg0);

        var instA0 = new Instance([[100, 150], [200, 250], [300, 350]], 0, 'user', 1.0);
        instA0.modified = true;
        instA0.occluded = [false, false, true]; // wrist occluded in SLP sense
        instA0.nulledNodes = new Set([2]); // wrist excluded from triangulation

        var instB0 = new Instance([[110, 160], [210, 260], [310, 360]], 0, 'user', 0.95);
        instB0.modified = true;

        var group0 = new InstanceGroup(1001, 0);
        group0.identityId = 0;
        group0.addInstance('CamA', instA0);
        group0.addInstance('CamB', instB0);
        group0.points3d = [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], null]; // wrist not triangulated
        group0.reprojections = {
            'CamA': [[101, 151], [201, 251], null],
            'CamB': [[111, 161], [211, 261], null],
        };
        group0.observedPoints = {
            'CamA': instA0.points,
            'CamB': instB0.points,
        };
        group0.usedCameras = new Set(['CamA', 'CamB']);
        group0.markClean();

        fg0.addInstance('CamA', instA0);
        fg0.addInstance('CamB', instB0);

        if (!session.instanceGroups.has(0)) session.instanceGroups.set(0, []);
        session.instanceGroups.get(0).push(group0);

        // --- Frame 0: second group (predicted, track 1) ---
        var instA0pred = new Instance([[400, 450], [500, 550], null], 1, 'predicted', 0.8);
        var instB0pred = new Instance([[410, 460], null, [510, 560]], 1, 'predicted', 0.7);
        instB0pred.nulledNodes = new Set([1]); // ear nulled

        var group1 = new InstanceGroup(1002, 1);
        group1.identityId = 1;
        group1.addInstance('CamA', instA0pred);
        group1.addInstance('CamB', instB0pred);

        fg0.addInstance('CamA', instA0pred);
        fg0.addInstance('CamB', instB0pred);

        session.instanceGroups.get(0).push(group1);

        // --- Frame 0: unlinked instance with nulledNodes ---
        var ulInst = new Instance([[50, 60], [70, 80], [90, 100]], 0, 'user', 1.0);
        ulInst.modified = true;
        ulInst.nulledNodes = new Set([1]); // ear nulled
        ulInst.occluded = [false, true, false];
        session.addUnlinkedInstance(0, 'CamA', ulInst);

        // --- Frame 5: empty group for testing sparse frames ---
        var fg5 = new FrameGroup(5);
        session.addFrameGroup(fg5);
        var instA5 = new Instance([[120, 130], [220, 230], [320, 330]], 0, 'user', 1.0);
        instA5.modified = true;
        fg5.addInstance('CamA', instA5);

        var group5 = new InstanceGroup(2001, 0);
        group5.addInstance('CamA', instA5);
        if (!session.instanceGroups.has(5)) session.instanceGroups.set(5, []);
        session.instanceGroups.get(5).push(group5);

        return session;
    }

    /**
     * Serialize a session to JSON using the same logic as saveProject() v2 format.
     * This is a self-contained version so tests don't depend on DOM state.
     */
    function serializeSession(session) {
        var data = {
            version: 2,
            skeleton: {
                name: session.skeleton.name,
                nodes: session.skeleton.nodes,
                edges: session.skeleton.edges,
            },
            cameras: session.cameras.map(function (c) {
                return { name: c.name, matrix: c.matrix, dist: c.dist, rvec: c.rvec, tvec: c.tvec, size: c.size };
            }),
            tracks: session.tracks,
            identities: session.identities.map(function (id) {
                return { id: id.id, name: id.name, color: id.color };
            }),
            trustTracks: session.trustTracks || false,
            frameIdentityMap: session.frameIdentityMap
                ? Array.from(session.frameIdentityMap.entries())
                : [],
            frames: {},
        };

        for (var [frameIdx, fg] of session.frameGroups) {
            var frameData = { instanceGroups: [], unlinkedInstances: [] };
            var frameGroups = session.instanceGroups.get(frameIdx) || [];
            for (var gi = 0; gi < frameGroups.length; gi++) {
                var group = frameGroups[gi];
                var groupData = {
                    id: group.id,
                    identityId: group.identityId != null ? group.identityId : -1,
                    instances: {},
                    points3d: group.points3d || null,
                    reprojections: group.reprojections || null,
                    observedPoints: group.observedPoints || null,
                    dirty: group.dirty || false,
                };
                if (group.usedCameras) {
                    groupData.usedCameras = Array.from(group.usedCameras);
                }
                for (var [camName, inst] of group.instances) {
                    var instData = {
                        points: inst.points,
                        trackIdx: inst.trackIdx,
                        type: inst.type,
                        score: inst.score,
                        modified: inst.modified,
                        occluded: inst.occluded,
                    };
                    if (inst.nulledNodes && inst.nulledNodes.size > 0) {
                        instData.nulledNodes = Array.from(inst.nulledNodes);
                    }
                    groupData.instances[camName] = instData;
                }
                frameData.instanceGroups.push(groupData);
            }
            for (var [camName2, unlinkedList] of fg.unlinkedInstances) {
                for (var unlinked of unlinkedList) {
                    var ulType = unlinked.instance.type || 'user';
                    {
                        var ulData = {
                            cameraName: camName2,
                            points: unlinked.instance.points,
                            trackIdx: unlinked.instance.trackIdx,
                            type: ulType,
                            score: unlinked.instance.score || 1.0,
                            modified: unlinked.instance.modified || false,
                            occluded: unlinked.instance.occluded,
                        };
                        if (unlinked.instance.nulledNodes && unlinked.instance.nulledNodes.size > 0) {
                            ulData.nulledNodes = Array.from(unlinked.instance.nulledNodes);
                        }
                        frameData.unlinkedInstances.push(ulData);
                    }
                }
            }
            if (frameData.instanceGroups.length === 0 && frameData.unlinkedInstances.length === 0) continue;
            frames_key = String(frameIdx);
            data.frames[frames_key] = frameData;
        }

        return data;
    }

    /**
     * Deserialize JSON data back into a Session (mirrors _restoreProjectV2).
     */
    function deserializeSession(data) {
        var cameras = data.cameras.map(function (c) {
            return new Camera(c.name, c.matrix, c.dist, c.rvec, c.tvec, c.size);
        });
        var skeleton = new Skeleton(data.skeleton.name, data.skeleton.nodes, data.skeleton.edges);
        var session = new Session(cameras, skeleton, data.tracks || []);

        if (data.identities) {
            for (var i = 0; i < data.identities.length; i++) {
                var idData = data.identities[i];
                session.identities.push(new Identity(idData.id, idData.name, idData.color));
            }
        }
        if (data.trustTracks != null) session.trustTracks = data.trustTracks;
        if (data.frameIdentityMap && data.frameIdentityMap.length > 0) {
            if (!session.frameIdentityMap) session.frameIdentityMap = new Map();
            for (var fmi = 0; fmi < data.frameIdentityMap.length; fmi++) {
                session.frameIdentityMap.set(data.frameIdentityMap[fmi][0], data.frameIdentityMap[fmi][1]);
            }
        }

        if (data.frames) {
            for (var frameIdxStr in data.frames) {
                var frameIdx = parseInt(frameIdxStr);
                var frameData = data.frames[frameIdxStr];
                var fg = new FrameGroup(frameIdx);

                if (frameData.instanceGroups) {
                    if (!session.instanceGroups.has(frameIdx)) {
                        session.instanceGroups.set(frameIdx, []);
                    }

                    for (var gi = 0; gi < frameData.instanceGroups.length; gi++) {
                        var groupData = frameData.instanceGroups[gi];
                        var group = new InstanceGroup(groupData.id || Date.now(), groupData.identityId);
                        if (groupData.identityId != null) group.identityId = groupData.identityId;
                        if (groupData.points3d) group.points3d = groupData.points3d;
                        if (groupData.reprojections) group.reprojections = groupData.reprojections;
                        if (groupData.observedPoints) group.observedPoints = groupData.observedPoints;
                        if (groupData.usedCameras) group.usedCameras = new Set(groupData.usedCameras);

                        for (var camName in groupData.instances) {
                            var instData = groupData.instances[camName];
                            var inst = new Instance(
                                instData.points,
                                instData.trackIdx || groupData.identityId,
                                instData.type || 'user',
                                instData.score || 1.0
                            );
                            inst.modified = instData.modified || false;
                            if (instData.occluded) inst.occluded = instData.occluded;
                            if (instData.nulledNodes && instData.nulledNodes.length > 0) {
                                inst.nulledNodes = new Set(instData.nulledNodes);
                            }
                            group.addInstance(camName, inst);
                            fg.addInstance(camName, inst);
                        }

                        if (groupData.dirty) {
                            group.markDirty();
                        } else if (group.points3d) {
                            group.markClean();
                        }

                        // Rebuild reprojectedInstances from saved reprojections
                        if (group.reprojections) {
                            for (var rCamName in group.reprojections) {
                                var rPts = group.reprojections[rCamName];
                                if (rPts) {
                                    var rInst = new Instance(rPts, group.identityId, 'reprojected', 0);
                                    group.addReprojectedInstance(rCamName, rInst);
                                }
                            }
                        }

                        session.instanceGroups.get(frameIdx).push(group);
                    }
                }

                if (frameData.unlinkedInstances) {
                    for (var ui = 0; ui < frameData.unlinkedInstances.length; ui++) {
                        var ulData = frameData.unlinkedInstances[ui];
                        var ulInst = new Instance(
                            ulData.points,
                            ulData.trackIdx != null ? ulData.trackIdx : 0,
                            ulData.type || 'user',
                            ulData.score || 1.0
                        );
                        ulInst.modified = ulData.modified || false;
                        if (ulData.occluded) ulInst.occluded = ulData.occluded;
                        if (ulData.nulledNodes && ulData.nulledNodes.length > 0) {
                            ulInst.nulledNodes = new Set(ulData.nulledNodes);
                        }
                        fg.addUnlinkedInstance(ulData.cameraName, new UnlinkedInstance(ulInst, ulData.cameraName));
                    }
                }

                session.addFrameGroup(fg);
            }
        }

        return session;
    }

    /**
     * Full roundtrip: build → serialize → JSON.stringify → JSON.parse → deserialize
     */
    function roundtrip() {
        var original = buildFixtureSession();
        var serialized = serializeSession(original);
        var json = JSON.stringify(serialized);
        var parsed = JSON.parse(json);
        var restored = deserializeSession(parsed);
        return { original: original, serialized: serialized, parsed: parsed, restored: restored };
    }

    // ============================================
    // Skeleton
    // ============================================

    describe('JSON roundtrip - skeleton', function () {
        it('skeleton name, nodes, and edges survive roundtrip', function () {
            var r = roundtrip();
            assertEqual(r.restored.skeleton.name, 'mouse');
            assertDeepEqual(r.restored.skeleton.nodes, ['nose', 'ear', 'wrist']);
            assertDeepEqual(r.restored.skeleton.edges, [[0, 1], [1, 2]]);
        });
    });

    // ============================================
    // Cameras
    // ============================================

    describe('JSON roundtrip - cameras', function () {
        it('camera count and names survive', function () {
            var r = roundtrip();
            assertEqual(r.restored.cameras.length, 2);
            assertEqual(r.restored.cameras[0].name, 'CamA');
            assertEqual(r.restored.cameras[1].name, 'CamB');
        });

        it('camera intrinsics survive', function () {
            var r = roundtrip();
            assertDeepEqual(r.restored.cameras[0].matrix, [[500, 0, 320], [0, 500, 240], [0, 0, 1]]);
        });

        it('camera distortion coefficients survive', function () {
            var r = roundtrip();
            assertDeepEqual(r.restored.cameras[0].dist, [0.1, -0.2, 0, 0, 0.05]);
        });

        it('camera extrinsics survive', function () {
            var r = roundtrip();
            assertDeepEqual(r.restored.cameras[0].rvec, [0.1, 0.2, 0.3]);
            assertDeepEqual(r.restored.cameras[0].tvec, [10, 20, 30]);
        });

        it('camera size survives', function () {
            var r = roundtrip();
            assertDeepEqual(r.restored.cameras[0].size, [640, 480]);
        });
    });

    // ============================================
    // Tracks and identities
    // ============================================

    describe('JSON roundtrip - tracks and identities', function () {
        it('tracks survive', function () {
            var r = roundtrip();
            assertDeepEqual(r.restored.tracks, ['track_0', 'track_1']);
        });

        it('identities survive with id, name, color', function () {
            var r = roundtrip();
            assertEqual(r.restored.identities.length, 2);
            assertEqual(r.restored.identities[0].name, 'mouse_A');
            assertEqual(r.restored.identities[1].name, 'mouse_B');
            assertTrue(r.restored.identities[0].id != null, 'identity has id');
        });

        it('trustTracks survives', function () {
            var r = roundtrip();
            assertTrue(r.restored.trustTracks, 'trustTracks is true');
        });

        it('frameIdentityMap survives', function () {
            var r = roundtrip();
            assertNotNull(r.restored.frameIdentityMap, 'frameIdentityMap exists');
            assertEqual(r.restored.frameIdentityMap.get('5:CamA:0'), 1);
            assertEqual(r.restored.frameIdentityMap.get('10:CamB:1'), 0);
        });
    });

    // ============================================
    // Instance groups
    // ============================================

    describe('JSON roundtrip - instance groups', function () {
        it('frame 0 has two instance groups', function () {
            var r = roundtrip();
            var groups = r.restored.getInstanceGroupsForFrame(0);
            assertEqual(groups.length, 2, 'two groups on frame 0');
        });

        it('group id and trackIdx survive', function () {
            var r = roundtrip();
            var groups = r.restored.getInstanceGroupsForFrame(0);
            var g0 = groups.find(function(g) { return g.identityId === 0; });
            assertNotNull(g0, 'found group with track 0');
            assertEqual(g0.id, 1001);
            assertEqual(g0.identityId, 0);
        });

        it('group identityId survives', function () {
            var r = roundtrip();
            var groups = r.restored.getInstanceGroupsForFrame(0);
            var g0 = groups.find(function(g) { return g.identityId === 0; });
            assertEqual(g0.identityId, 0);
            var g1 = groups.find(function(g) { return g.identityId === 1; });
            assertEqual(g1.identityId, 1);
        });

        it('group has instances for both cameras', function () {
            var r = roundtrip();
            var groups = r.restored.getInstanceGroupsForFrame(0);
            var g0 = groups.find(function(g) { return g.identityId === 0; });
            assertNotNull(g0.getInstance('CamA'), 'has CamA');
            assertNotNull(g0.getInstance('CamB'), 'has CamB');
        });

        it('frame 5 has one instance group', function () {
            var r = roundtrip();
            var groups = r.restored.getInstanceGroupsForFrame(5);
            assertEqual(groups.length, 1);
        });
    });

    // ============================================
    // Instance data
    // ============================================

    describe('JSON roundtrip - instance data', function () {
        it('2D points survive', function () {
            var r = roundtrip();
            var g0 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 0; });
            var inst = g0.getInstance('CamA');
            assertDeepEqual(inst.points[0], [100, 150]);
            assertDeepEqual(inst.points[1], [200, 250]);
            assertDeepEqual(inst.points[2], [300, 350]);
        });

        it('instance type survives', function () {
            var r = roundtrip();
            var g0 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 0; });
            assertEqual(g0.getInstance('CamA').type, 'user');

            var g1 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 1; });
            assertEqual(g1.getInstance('CamA').type, 'predicted');
        });

        it('instance score survives', function () {
            var r = roundtrip();
            var g0 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 0; });
            assertEqual(g0.getInstance('CamB').score, 0.95);
        });

        it('instance modified flag survives', function () {
            var r = roundtrip();
            var g0 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 0; });
            assertTrue(g0.getInstance('CamA').modified, 'CamA modified');
        });

        it('instance trackIdx survives', function () {
            var r = roundtrip();
            var g0 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 0; });
            assertEqual(g0.getInstance('CamA').trackIdx, 0);
        });

        it('null points survive', function () {
            var r = roundtrip();
            var g1 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 1; });
            assertNull(g1.getInstance('CamA').points[2], 'CamA wrist is null');
            assertNull(g1.getInstance('CamB').points[1], 'CamB ear is null');
        });

        it('occluded array survives', function () {
            var r = roundtrip();
            var g0 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 0; });
            var occ = g0.getInstance('CamA').occluded;
            assertDeepEqual(occ, [false, false, true]);
        });
    });

    // ============================================
    // nulledNodes (critical for triangulation exclusion)
    // ============================================

    describe('JSON roundtrip - nulledNodes', function () {
        it('grouped instance nulledNodes survive', function () {
            var r = roundtrip();
            var g0 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 0; });
            var inst = g0.getInstance('CamA');
            assertTrue(inst.nulledNodes instanceof Set, 'nulledNodes is a Set');
            assertTrue(inst.nulledNodes.has(2), 'wrist (idx 2) is nulled');
            assertFalse(inst.nulledNodes.has(0), 'nose not nulled');
            assertFalse(inst.nulledNodes.has(1), 'ear not nulled');
        });

        it('predicted instance nulledNodes survive', function () {
            var r = roundtrip();
            var g1 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 1; });
            var instB = g1.getInstance('CamB');
            assertTrue(instB.nulledNodes instanceof Set, 'nulledNodes is Set');
            assertTrue(instB.nulledNodes.has(1), 'ear nulled');
        });

        it('unlinked instance nulledNodes survive', function () {
            var r = roundtrip();
            var fg = r.restored.getFrameGroup(0);
            var ulList = fg.getUnlinkedInstances('CamA');
            assertTrue(ulList.length > 0, 'has unlinked');
            var ul = ulList[0].instance;
            assertTrue(ul.nulledNodes instanceof Set, 'nulledNodes is Set');
            assertTrue(ul.nulledNodes.has(1), 'ear nulled');
            assertFalse(ul.nulledNodes.has(0), 'nose not nulled');
        });

        it('instance without nulledNodes has no Set after load', function () {
            var r = roundtrip();
            var g0 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 0; });
            var instB = g0.getInstance('CamB');
            // CamB instance in group 0 has no nulledNodes
            assertTrue(!instB.nulledNodes || instB.nulledNodes.size === 0,
                'no nulledNodes on instance that had none');
        });
    });

    // ============================================
    // 3D data (points3d, reprojections, observedPoints)
    // ============================================

    describe('JSON roundtrip - 3D triangulation data', function () {
        it('points3d survive', function () {
            var r = roundtrip();
            var g0 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 0; });
            assertDeepEqual(g0.points3d[0], [1.0, 2.0, 3.0]);
            assertDeepEqual(g0.points3d[1], [4.0, 5.0, 6.0]);
            assertNull(g0.points3d[2], 'wrist not triangulated');
        });

        it('reprojections survive per camera', function () {
            var r = roundtrip();
            var g0 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 0; });
            assertNotNull(g0.reprojections, 'has reprojections');
            assertDeepEqual(g0.reprojections['CamA'][0], [101, 151]);
            assertDeepEqual(g0.reprojections['CamB'][1], [211, 261]);
            assertNull(g0.reprojections['CamA'][2], 'wrist reproj is null');
        });

        it('observedPoints survive per camera', function () {
            var r = roundtrip();
            var g0 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 0; });
            assertNotNull(g0.observedPoints, 'has observedPoints');
            assertNotNull(g0.observedPoints['CamA'], 'CamA observed');
            assertNotNull(g0.observedPoints['CamB'], 'CamB observed');
        });

        it('usedCameras survive', function () {
            var r = roundtrip();
            var g0 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 0; });
            assertTrue(g0.usedCameras instanceof Set, 'usedCameras is Set');
            assertTrue(g0.usedCameras.has('CamA'), 'CamA used');
            assertTrue(g0.usedCameras.has('CamB'), 'CamB used');
        });

        it('group without 3D data has null fields', function () {
            var r = roundtrip();
            var g1 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 1; });
            assertTrue(!g1.points3d, 'no points3d');
        });
    });

    // ============================================
    // Dirty flag and reprojectedInstances
    // ============================================

    describe('JSON roundtrip - dirty flag and reprojectedInstances', function () {
        it('clean group stays clean after roundtrip', function () {
            var r = roundtrip();
            var g0 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 0; });
            assertFalse(g0.dirty, 'triangulated group is clean');
        });

        it('reprojectedInstances rebuilt from reprojections', function () {
            var r = roundtrip();
            var g0 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 0; });
            assertNotNull(g0.getReprojectedInstance('CamA'), 'CamA reproj instance exists');
            assertNotNull(g0.getReprojectedInstance('CamB'), 'CamB reproj instance exists');
        });

        it('reprojected instance has correct points', function () {
            var r = roundtrip();
            var g0 = r.restored.getInstanceGroupsForFrame(0).find(function(g) { return g.identityId === 0; });
            var ri = g0.getReprojectedInstance('CamA');
            assertEqual(ri.type, 'reprojected', 'type is reprojected');
            assertDeepEqual(ri.points[0], [101, 151], 'reproj point 0');
            assertDeepEqual(ri.points[1], [201, 251], 'reproj point 1');
        });
    });

    // ============================================
    // Unlinked instances
    // ============================================

    describe('JSON roundtrip - unlinked instances', function () {
        it('unlinked instance points survive', function () {
            var r = roundtrip();
            var fg = r.restored.getFrameGroup(0);
            var ulList = fg.getUnlinkedInstances('CamA');
            assertTrue(ulList.length > 0, 'has unlinked');
            assertDeepEqual(ulList[0].instance.points[0], [50, 60]);
        });

        it('unlinked instance type and score survive', function () {
            var r = roundtrip();
            var fg = r.restored.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('CamA')[0].instance;
            assertEqual(ul.type, 'user');
            assertEqual(ul.score, 1.0);
        });

        it('unlinked instance occluded array survives', function () {
            var r = roundtrip();
            var fg = r.restored.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('CamA')[0].instance;
            assertDeepEqual(ul.occluded, [false, true, false]);
        });

        it('unlinked instance modified flag survives', function () {
            var r = roundtrip();
            var fg = r.restored.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('CamA')[0].instance;
            assertTrue(ul.modified, 'modified is true');
        });
    });

    // ============================================
    // Sparse frames
    // ============================================

    describe('JSON roundtrip - sparse frames', function () {
        it('non-contiguous frame indices survive', function () {
            var r = roundtrip();
            assertNotNull(r.restored.getFrameGroup(0), 'frame 0 exists');
            assertNotNull(r.restored.getFrameGroup(5), 'frame 5 exists');
            assertNull(r.restored.getFrameGroup(1), 'frame 1 does not exist');
        });
    });

    // ============================================
    // JSON structure validation
    // ============================================

    describe('JSON structure - sleap-io 3D format alignment', function () {
        it('serialized JSON has version field', function () {
            var r = roundtrip();
            assertEqual(r.parsed.version, 2);
        });

        it('serialized instanceGroup has all sleap-io 3D fields', function () {
            var r = roundtrip();
            var g = r.parsed.frames['0'].instanceGroups[0];
            assertTrue('id' in g, 'has id');
            assertTrue('identityId' in g, 'has identityId');
            assertTrue('instances' in g, 'has instances');
            assertTrue('points3d' in g, 'has points3d');
            assertTrue('reprojections' in g, 'has reprojections');
            assertTrue('observedPoints' in g, 'has observedPoints');
            assertTrue('usedCameras' in g, 'has usedCameras');
        });

        it('serialized instance has all per-view fields', function () {
            var r = roundtrip();
            var inst = r.parsed.frames['0'].instanceGroups[0].instances['CamA'];
            assertTrue('points' in inst, 'has points');
            assertTrue('trackIdx' in inst, 'has trackIdx');
            assertTrue('type' in inst, 'has type');
            assertTrue('score' in inst, 'has score');
            assertTrue('modified' in inst, 'has modified');
            assertTrue('nulledNodes' in inst, 'has nulledNodes');
        });

        it('nulledNodes serialized as array of indices', function () {
            var r = roundtrip();
            var inst = r.parsed.frames['0'].instanceGroups[0].instances['CamA'];
            assertTrue(Array.isArray(inst.nulledNodes), 'nulledNodes is array');
            assertDeepEqual(inst.nulledNodes, [2]);
        });

        it('usedCameras serialized as array of strings', function () {
            var r = roundtrip();
            var g = r.parsed.frames['0'].instanceGroups[0];
            assertTrue(Array.isArray(g.usedCameras), 'usedCameras is array');
            assertTrue(g.usedCameras.indexOf('CamA') >= 0, 'contains CamA');
            assertTrue(g.usedCameras.indexOf('CamB') >= 0, 'contains CamB');
        });

        it('frameIdentityMap serialized as array of pairs', function () {
            var r = roundtrip();
            assertTrue(Array.isArray(r.parsed.frameIdentityMap), 'is array');
            assertEqual(r.parsed.frameIdentityMap.length, 2, 'two entries');
        });
    });

})();
