/**
 * test-annotation-workflow.js - End-to-end stress tests for the full annotation
 * and proofreading pipeline: import SLP -> select/convert labels -> link/unlink ->
 * triangulate -> save/load -> export.
 *
 * These tests simulate real user workflows and verify data integrity at every step.
 */

console.log('[test-annotation-workflow] Loading...');

// Canary test - proves file loaded
TestFramework.describe('Annotation Workflow: canary', function() {
    TestFramework.it('test file loaded successfully', function() {
        TestFramework.assert(true, 'canary');
    });
});

TestFramework.describe('Annotation Workflow: canary 2 (inside try)', function() {
    TestFramework.it('try block entered', function() {
        TestFramework.assert(true, 'canary2');
    });
});

try {
(function () {
    var describe = TestFramework.describe;
    var it = TestFramework.it;
    var beforeEach = TestFramework.beforeEach;
    var assertEqual = TestFramework.assertEqual;
    var assertDeepEqual = TestFramework.assertDeepEqual;
    var assertNotNull = TestFramework.assertNotNull;
    var assertNull = TestFramework.assertNull;
    var assertTrue = TestFramework.assertTrue;
    var assertFalse = TestFramework.assertFalse;
    var assertGreaterThan = TestFramework.assertGreaterThan;
    var assertLessThan = TestFramework.assertLessThan;
    var assertApprox = TestFramework.assertApprox;
    var assertThrows = TestFramework.assertThrows;
    var assert = TestFramework.assert;

    describe('Annotation Workflow: canary 3 (inside IIFE)', function() {
        it('IIFE entered successfully', function() {
            assert(true, 'canary3');
        });
    });

    // =========================================================================
    // Shared fixtures
    // =========================================================================

    /**
     * Create a realistic 3-camera session with non-trivial calibration
     * so triangulation actually produces meaningful 3D points.
     */
    function makeRealisticSession() {
        var skeleton = new Skeleton('mouse', ['nose', 'ear_L', 'ear_R', 'tail'], [[0, 1], [0, 2], [0, 3]]);
        var cameras = [
            new Camera('camA',
                [[500, 0, 320], [0, 500, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0],
                [0, 0, 0],
                [0, 0, 500],
                [640, 480]),
            new Camera('camB',
                [[500, 0, 320], [0, 500, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0],
                [0, 1.57, 0],
                [500, 0, 0],
                [640, 480]),
            new Camera('camC',
                [[500, 0, 320], [0, 500, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0],
                [1.57, 0, 0],
                [0, 500, 0],
                [640, 480]),
        ];
        return new Session(cameras, skeleton, ['track_0']);
    }

    /** Simple 2-camera session for quick tests. */
    function makeSimpleSession() {
        var skeleton = new Skeleton('test', ['nose', 'tail'], [[0, 1]]);
        var cameras = [
            new Camera('camA',
                [[500, 0, 320], [0, 500, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 500], [640, 480]),
            new Camera('camB',
                [[500, 0, 320], [0, 500, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 1.57, 0], [500, 0, 0], [640, 480]),
        ];
        return new Session(cameras, skeleton, ['track_0']);
    }

    /** Add a predicted InstanceGroup with instances across given cameras. */
    function addPredictedGroup(session, frameIdx, camNames, trackIdx) {
        trackIdx = trackIdx || 0;
        var fg = session.frameGroups.get(frameIdx);
        if (!fg) {
            fg = new FrameGroup(frameIdx);
            session.addFrameGroup(fg);
        }
        var group = new InstanceGroup(Date.now() + Math.random() * 10000, trackIdx);
        for (var i = 0; i < camNames.length; i++) {
            var nNodes = session.skeleton.nodes.length;
            var pts = [];
            for (var n = 0; n < nNodes; n++) {
                pts.push([100 + i * 50 + n * 20, 200 + i * 30 + n * 15]);
            }
            var inst = new Instance(pts, trackIdx, 'predicted', 0.85 + i * 0.03);
            group.addInstance(camNames[i], inst);
            fg.addInstance(camNames[i], inst);
        }
        if (!session.instanceGroups.has(frameIdx)) {
            session.instanceGroups.set(frameIdx, new Map());
        }
        var trackMap = session.instanceGroups.get(frameIdx);
        if (!trackMap.has(trackIdx)) {
            trackMap.set(trackIdx, []);
        }
        trackMap.get(trackIdx).push(group);
        return group;
    }

    /** Add a user InstanceGroup. */
    function addUserGroup(session, frameIdx, camNames, trackIdx) {
        trackIdx = trackIdx || 0;
        var fg = session.frameGroups.get(frameIdx);
        if (!fg) {
            fg = new FrameGroup(frameIdx);
            session.addFrameGroup(fg);
        }
        var group = new InstanceGroup(Date.now() + Math.random() * 10000, trackIdx);
        for (var i = 0; i < camNames.length; i++) {
            var nNodes = session.skeleton.nodes.length;
            var pts = [];
            for (var n = 0; n < nNodes; n++) {
                pts.push([150 + i * 40 + n * 25, 250 + i * 35 + n * 20]);
            }
            var inst = new Instance(pts, trackIdx, 'user', 1.0);
            inst.modified = true;
            group.addInstance(camNames[i], inst);
            fg.addInstance(camNames[i], inst);
        }
        if (!session.instanceGroups.has(frameIdx)) {
            session.instanceGroups.set(frameIdx, new Map());
        }
        var trackMap = session.instanceGroups.get(frameIdx);
        if (!trackMap.has(trackIdx)) {
            trackMap.set(trackIdx, []);
        }
        trackMap.get(trackIdx).push(group);
        return group;
    }

    /** Clone a predicted group into a user group, mimicking onClonePredictedGroup. */
    function clonePredictedToUser(session, frameIdx, predGroup) {
        session.removeInstanceGroup(frameIdx, predGroup);
        var unlinkedList = [];
        for (var entry of predGroup.instances) {
            var camName = entry[0];
            var inst = entry[1];
            var clonedPoints = inst.points.map(function (pt) {
                return pt != null ? [pt[0], pt[1]] : null;
            });
            var userInst = new Instance(clonedPoints, predGroup.trackIdx, 'user', 1.0);
            userInst.modified = true;
            var ul = session.addUnlinkedInstance(frameIdx, camName, userInst);
            unlinkedList.push(ul);
        }
        if (unlinkedList.length > 0) {
            return session.createGroupFromUnlinked(frameIdx, unlinkedList, predGroup.trackIdx);
        }
        return null;
    }

    /** Simulate the full save → parse → restore cycle (data model only, no DOM). */
    function saveAndRestoreSession(session) {
        // Serialize (mirrors saveProject / _buildProjectBlob)
        var projectData = {
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
            frames: {},
        };

        for (var entry of session.frameGroups) {
            var frameIdx = entry[0];
            var fg = entry[1];
            var frameData = { instanceGroups: [], unlinkedInstances: [] };

            var trackMap = session.instanceGroups.get(frameIdx);
            if (trackMap) {
                for (var trackEntry of trackMap) {
                    var groups = trackEntry[1];
                    for (var gi = 0; gi < groups.length; gi++) {
                        var group = groups[gi];
                        var groupData = {
                            id: group.id,
                            trackIdx: group.trackIdx,
                            instances: {},
                            points3d: group.points3d || null,
                        };
                        for (var instEntry of group.instances) {
                            var camName = instEntry[0];
                            var inst = instEntry[1];
                            groupData.instances[camName] = {
                                points: inst.points,
                                trackIdx: inst.trackIdx,
                                type: inst.type,
                                score: inst.score,
                                modified: inst.modified,
                                occluded: inst.occluded,
                            };
                        }
                        frameData.instanceGroups.push(groupData);
                    }
                }
            }

            for (var ulEntry of fg.unlinkedInstances) {
                var ulCamName = ulEntry[0];
                var ulList = ulEntry[1];
                for (var ui = 0; ui < ulList.length; ui++) {
                    var unlinked = ulList[ui];
                    frameData.unlinkedInstances.push({
                        cameraName: ulCamName,
                        points: unlinked.instance.points,
                        type: unlinked.instance.type || 'user',
                        score: unlinked.instance.score || 1.0,
                        modified: unlinked.instance.modified || false,
                        occluded: unlinked.instance.occluded,
                    });
                }
            }

            projectData.frames[frameIdx] = frameData;
        }

        // Serialize to JSON and parse back (round-trip)
        var json = JSON.stringify(projectData);
        var data = JSON.parse(json);

        // Restore (mirrors _restoreProjectV2)
        var cameras = parseCalibrationJSON(JSON.stringify({ cameras: data.cameras }));
        var skeleton = new Skeleton(
            data.skeleton.name,
            data.skeleton.nodes,
            data.skeleton.edges
        );
        var tracks = data.tracks || ['track_0'];
        var restored = new Session(cameras, skeleton, tracks);

        for (var frameIdxStr in data.frames) {
            var fIdx = parseInt(frameIdxStr);
            var fData = data.frames[frameIdxStr];
            var newFg = new FrameGroup(fIdx);

            if (fData.instanceGroups) {
                if (!restored.instanceGroups.has(fIdx)) {
                    restored.instanceGroups.set(fIdx, new Map());
                }
                var tMap = restored.instanceGroups.get(fIdx);

                for (var gj = 0; gj < fData.instanceGroups.length; gj++) {
                    var gData = fData.instanceGroups[gj];
                    var rGroup = new InstanceGroup(gData.id || Date.now() + gj, gData.trackIdx);
                    if (gData.points3d) rGroup.points3d = gData.points3d;

                    for (var cn in gData.instances) {
                        var iData = gData.instances[cn];
                        var rInst = new Instance(
                            iData.points,
                            iData.trackIdx || gData.trackIdx,
                            iData.type || 'user',
                            iData.score || 1.0
                        );
                        rInst.modified = iData.modified || false;
                        if (iData.occluded) rInst.occluded = iData.occluded;
                        rGroup.addInstance(cn, rInst);
                        newFg.addInstance(cn, rInst);
                    }

                    if (!tMap.has(rGroup.trackIdx)) tMap.set(rGroup.trackIdx, []);
                    tMap.get(rGroup.trackIdx).push(rGroup);
                }
            }

            if (fData.unlinkedInstances) {
                for (var uj = 0; uj < fData.unlinkedInstances.length; uj++) {
                    var ulData = fData.unlinkedInstances[uj];
                    var ulInst = new Instance(
                        ulData.points, 0,
                        ulData.type || 'user',
                        ulData.score || 1.0
                    );
                    ulInst.modified = ulData.modified || false;
                    if (ulData.occluded) ulInst.occluded = ulData.occluded;
                    var ulObj = new UnlinkedInstance(ulInst, ulData.cameraName);
                    newFg.addUnlinkedInstance(ulData.cameraName, ulObj);
                }
            }

            restored.addFrameGroup(newFg);
        }

        return { restored: restored, cameras: cameras, rawData: data };
    }

    // =========================================================================
    // 1. Save/Load Round-Trip Tests
    // =========================================================================

    describe('Save/Load: predicted instances round-trip', function () {
        it('preserves predicted instances across save/load', function () {
            var session = makeSimpleSession();
            var group = addPredictedGroup(session, 0, ['camA', 'camB']);

            var result = saveAndRestoreSession(session);
            var restored = result.restored;

            assertEqual(restored.frameGroups.size, 1, 'Should have 1 frame');
            var groups = restored.getInstanceGroupsForFrame(0);
            assertEqual(groups.length, 1, 'Should have 1 group');
            assertEqual(groups[0].cameraNames.length, 2, 'Group should have 2 cameras');

            var instA = groups[0].getInstance('camA');
            assertNotNull(instA, 'Should have camA instance');
            assertEqual(instA.type, 'predicted', 'Type should be predicted');
            assertNotNull(instA.points[0], 'Points should be preserved');
        });

        it('preserves user instances across save/load', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 5, ['camA', 'camB']);

            var result = saveAndRestoreSession(session);
            var restored = result.restored;

            var groups = restored.getInstanceGroupsForFrame(5);
            assertEqual(groups.length, 1);
            var instA = groups[0].getInstance('camA');
            assertEqual(instA.type, 'user', 'User type should be preserved');
            assertTrue(instA.modified, 'Modified flag should be preserved');
        });

        it('preserves points3d across save/load', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA', 'camB']);
            group.points3d = [[10, 20, 30], [40, 50, 60]];

            var result = saveAndRestoreSession(session);
            var groups = result.restored.getInstanceGroupsForFrame(0);
            assertNotNull(groups[0].points3d, 'points3d should be preserved');
            assertEqual(groups[0].points3d.length, 2);
            assertDeepEqual(groups[0].points3d[0], [10, 20, 30]);
        });

        it('preserves multiple frames across save/load', function () {
            var session = makeSimpleSession();
            addPredictedGroup(session, 0, ['camA', 'camB']);
            addPredictedGroup(session, 42, ['camA', 'camB']);
            addUserGroup(session, 100, ['camA']);

            var result = saveAndRestoreSession(session);
            var restored = result.restored;
            assertEqual(restored.frameGroups.size, 3, 'Should have 3 frames');
            assertEqual(restored.getInstanceGroupsForFrame(0).length, 1);
            assertEqual(restored.getInstanceGroupsForFrame(42).length, 1);
            assertEqual(restored.getInstanceGroupsForFrame(100).length, 1);
        });

        it('preserves multiple tracks across save/load', function () {
            var session = makeSimpleSession();
            session.tracks.push('track_1');
            addPredictedGroup(session, 0, ['camA'], 0);
            addPredictedGroup(session, 0, ['camA', 'camB'], 1);

            var result = saveAndRestoreSession(session);
            var restored = result.restored;
            assertEqual(restored.tracks.length, 2);
            var groups = restored.getInstanceGroupsForFrame(0);
            assertEqual(groups.length, 2, 'Should have 2 groups (one per track)');
        });

        it('preserves unlinked instances across save/load', function () {
            var session = makeSimpleSession();
            var inst = new Instance([[100, 200], [300, 400]], 0, 'user', 1.0);
            inst.modified = true;
            session.addUnlinkedInstance(0, 'camA', inst);

            var result = saveAndRestoreSession(session);
            var fg = result.restored.getFrameGroup(0);
            assertNotNull(fg, 'FrameGroup should exist');
            var unlinked = fg.getUnlinkedInstances('camA');
            assertEqual(unlinked.length, 1, 'Should have 1 unlinked instance');
            assertEqual(unlinked[0].instance.type, 'user');
        });

        it('preserves occluded array across save/load', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA']);
            var inst = group.getInstance('camA');
            inst.occluded = [true, false];

            var result = saveAndRestoreSession(session);
            var rInst = result.restored.getInstanceGroupsForFrame(0)[0].getInstance('camA');
            assertDeepEqual(rInst.occluded, [true, false], 'Occluded flags should be preserved');
        });

        it('preserves camera calibration across save/load', function () {
            var session = makeSimpleSession();
            addPredictedGroup(session, 0, ['camA']);

            var result = saveAndRestoreSession(session);
            assertEqual(result.cameras.length, 2);
            assertEqual(result.cameras[0].name, 'camA');
            assertEqual(result.cameras[1].name, 'camB');
            assertDeepEqual(result.cameras[0].matrix, [[500, 0, 320], [0, 500, 240], [0, 0, 1]]);
            assertDeepEqual(result.cameras[0].tvec, [0, 0, 500]);
        });

        it('preserves skeleton across save/load', function () {
            var session = makeSimpleSession();
            addPredictedGroup(session, 0, ['camA']);

            var result = saveAndRestoreSession(session);
            assertEqual(result.restored.skeleton.name, 'test');
            assertDeepEqual(result.restored.skeleton.nodes, ['nose', 'tail']);
            assertDeepEqual(result.restored.skeleton.edges, [[0, 1]]);
        });
    });

    // =========================================================================
    // 2. Clone + Convert workflow (predicted -> user)
    // =========================================================================

    describe('Clone predicted to user workflow', function () {
        it('removes predicted group and creates user group', function () {
            var session = makeSimpleSession();
            var predGroup = addPredictedGroup(session, 0, ['camA', 'camB']);

            var userGroup = clonePredictedToUser(session, 0, predGroup);

            assertNotNull(userGroup, 'Should create a user group');
            var groups = session.getInstanceGroupsForFrame(0);
            assertEqual(groups.length, 1, 'Should have exactly 1 group (user)');
            assertEqual(groups[0], userGroup, 'The group should be the user group');

            var instA = userGroup.getInstance('camA');
            assertEqual(instA.type, 'user', 'Instance type should be user');
            assertTrue(instA.modified, 'Instance should be marked modified');
        });

        it('preserves point coordinates during clone', function () {
            var session = makeSimpleSession();
            var predGroup = addPredictedGroup(session, 0, ['camA']);
            var origPoints = predGroup.getInstance('camA').points.map(function (p) { return [p[0], p[1]]; });

            var userGroup = clonePredictedToUser(session, 0, predGroup);
            var userPoints = userGroup.getInstance('camA').points;

            assertDeepEqual(userPoints, origPoints, 'Points should be identical after clone');
        });

        it('cloned user points are independent copies (no shared references)', function () {
            var session = makeSimpleSession();
            var predGroup = addPredictedGroup(session, 0, ['camA']);
            var origPt = predGroup.getInstance('camA').points[0];

            var userGroup = clonePredictedToUser(session, 0, predGroup);
            var userPt = userGroup.getInstance('camA').points[0];

            // Mutate user point
            userPt[0] = 9999;
            assertTrue(origPt[0] !== 9999, 'Mutating user should not affect original');
        });

        it('clone + save/load preserves user labels', function () {
            var session = makeSimpleSession();
            var predGroup = addPredictedGroup(session, 0, ['camA', 'camB']);
            var userGroup = clonePredictedToUser(session, 0, predGroup);

            var result = saveAndRestoreSession(session);
            var groups = result.restored.getInstanceGroupsForFrame(0);
            assertEqual(groups.length, 1, 'Should have 1 group after restore');
            assertEqual(groups[0].getInstance('camA').type, 'user');
            assertEqual(groups[0].getInstance('camB').type, 'user');
        });

        it('FrameGroup.instances is consistent after clone', function () {
            var session = makeSimpleSession();
            var predGroup = addPredictedGroup(session, 0, ['camA', 'camB']);

            clonePredictedToUser(session, 0, predGroup);

            var fg = session.getFrameGroup(0);
            var camAInsts = fg.getInstances('camA');
            var camBInsts = fg.getInstances('camB');

            // Should have exactly 1 instance per camera (the user one)
            assertEqual(camAInsts.length, 1, 'camA should have 1 instance');
            assertEqual(camBInsts.length, 1, 'camB should have 1 instance');
            assertEqual(camAInsts[0].type, 'user');
            assertEqual(camBInsts[0].type, 'user');
        });

        it('clone on multi-track frame only affects the target group', function () {
            var session = makeSimpleSession();
            session.tracks.push('track_1');
            var predGroup0 = addPredictedGroup(session, 0, ['camA', 'camB'], 0);
            var predGroup1 = addPredictedGroup(session, 0, ['camA', 'camB'], 1);

            // Clone only track 0
            clonePredictedToUser(session, 0, predGroup0);

            var groups = session.getInstanceGroupsForFrame(0);
            assertEqual(groups.length, 2, 'Should still have 2 groups');

            // Find each group
            var userGroups = groups.filter(function (g) {
                return g.getInstance('camA') && g.getInstance('camA').type === 'user';
            });
            var predGroups = groups.filter(function (g) {
                return g.getInstance('camA') && g.getInstance('camA').type === 'predicted';
            });
            assertEqual(userGroups.length, 1, 'Should have 1 user group');
            assertEqual(predGroups.length, 1, 'Should have 1 predicted group');
        });
    });

    // =========================================================================
    // 3. Unlink + Re-link workflow
    // =========================================================================

    describe('Unlink and re-link workflow', function () {
        it('unlinking a group creates unlinked instances', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA', 'camB']);

            var unlinked = session.unlinkGroup(0, group);
            assertEqual(unlinked.length, 2, 'Should create 2 unlinked instances');

            var groups = session.getInstanceGroupsForFrame(0);
            assertEqual(groups.length, 0, 'No groups should remain');

            var fg = session.getFrameGroup(0);
            var ulA = fg.getUnlinkedInstances('camA');
            var ulB = fg.getUnlinkedInstances('camB');
            assertEqual(ulA.length, 1, 'camA should have 1 unlinked');
            assertEqual(ulB.length, 1, 'camB should have 1 unlinked');
        });

        it('unlinked instances preserve type', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA']);
            var unlinked = session.unlinkGroup(0, group);

            assertEqual(unlinked[0].instance.type, 'user', 'Type should be preserved');
        });

        it('re-linking unlinked instances creates a new group', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA', 'camB']);
            var unlinked = session.unlinkGroup(0, group);

            var newGroup = session.createGroupFromUnlinked(0, unlinked, 0);
            assertNotNull(newGroup, 'Should create new group');
            assertEqual(newGroup.cameraNames.length, 2);
            assertNotNull(newGroup.getInstance('camA'));
            assertNotNull(newGroup.getInstance('camB'));

            var groups = session.getInstanceGroupsForFrame(0);
            assertEqual(groups.length, 1, 'Should have 1 group');
        });

        it('unlink + re-link preserves point data', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA']);
            var origPoints = group.getInstance('camA').points.map(function (p) { return [p[0], p[1]]; });

            var unlinked = session.unlinkGroup(0, group);
            var newGroup = session.createGroupFromUnlinked(0, unlinked, 0);

            assertDeepEqual(newGroup.getInstance('camA').points, origPoints);
        });

        it('unlink + delete some + re-link with remaining', function () {
            var session = makeRealisticSession();
            var group = addUserGroup(session, 0, ['camA', 'camB', 'camC']);

            var unlinked = session.unlinkGroup(0, group);
            assertEqual(unlinked.length, 3);

            // Delete camC's unlinked instance
            var fg = session.getFrameGroup(0);
            fg.removeUnlinkedById(unlinked[2].id);

            // Re-link remaining two
            var remaining = [unlinked[0], unlinked[1]];
            var newGroup = session.createGroupFromUnlinked(0, remaining, 0);

            assertEqual(newGroup.cameraNames.length, 2, 'Should have 2 cameras');
            assertNotNull(newGroup.getInstance('camA'));
            assertNotNull(newGroup.getInstance('camB'));
            assertNull(newGroup.getInstance('camC'), 'camC should not be in group');
        });

        it('unlink all + save/load preserves unlinked', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA', 'camB']);
            session.unlinkGroup(0, group);

            var result = saveAndRestoreSession(session);
            var fg = result.restored.getFrameGroup(0);
            assertNotNull(fg, 'FrameGroup should exist');
            var ulA = fg.getUnlinkedInstances('camA');
            var ulB = fg.getUnlinkedInstances('camB');
            assertEqual(ulA.length, 1);
            assertEqual(ulB.length, 1);
            assertEqual(ulA[0].instance.type, 'user');
        });
    });

    // =========================================================================
    // 4. Delete workflow
    // =========================================================================

    describe('Delete instance group workflow', function () {
        it('removeInstanceGroup cleans both instanceGroups and FrameGroup', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA', 'camB']);

            session.removeInstanceGroup(0, group);

            assertEqual(session.getInstanceGroupsForFrame(0).length, 0, 'No groups');
            // FrameGroup should be cleaned up since it has no instances or unlinked
            var fg = session.getFrameGroup(0);
            // It may or may not exist depending on cleanup logic
            if (fg) {
                var camAInsts = fg.getInstances('camA');
                var camBInsts = fg.getInstances('camB');
                assertEqual(camAInsts.length, 0, 'No camA instances');
                assertEqual(camBInsts.length, 0, 'No camB instances');
            }
        });

        it('deleting one group leaves others intact', function () {
            var session = makeSimpleSession();
            session.tracks.push('track_1');
            var group0 = addUserGroup(session, 0, ['camA'], 0);
            var group1 = addUserGroup(session, 0, ['camA', 'camB'], 1);

            session.removeInstanceGroup(0, group0);

            var remaining = session.getInstanceGroupsForFrame(0);
            assertEqual(remaining.length, 1);
            assertEqual(remaining[0], group1);
        });

        it('delete + re-add does not corrupt state', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA', 'camB']);

            session.removeInstanceGroup(0, group);
            assertEqual(session.getInstanceGroupsForFrame(0).length, 0);

            // Add a new group to the same frame
            var newGroup = addUserGroup(session, 0, ['camA'], 0);
            var groups = session.getInstanceGroupsForFrame(0);
            assertEqual(groups.length, 1);
            assertEqual(groups[0].cameraNames.length, 1);
        });
    });

    // =========================================================================
    // 5. Triangulation + Reprojection
    // =========================================================================

    describe('Triangulation and reprojection', function () {
        it('triangulateAndReproject returns valid structure', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA', 'camB']);

            var result = triangulateAndReproject(group, session.cameras);

            assertNotNull(result.points3d, 'Should have points3d');
            assertEqual(result.points3d.length, 2, 'Should have 2 3D points (nose, tail)');
            assertNotNull(result.reprojections, 'Should have reprojections');
            assertNotNull(result.reprojections.camA, 'Should have camA reprojections');
            assertNotNull(result.reprojections.camB, 'Should have camB reprojections');
            assertNotNull(result.errors, 'Should have errors');
        });

        it('reprojections have same number of points as keypoints', function () {
            var session = makeRealisticSession();
            var group = addUserGroup(session, 0, ['camA', 'camB', 'camC']);

            var result = triangulateAndReproject(group, session.cameras);

            assertEqual(result.reprojections.camA.length, 4, '4 keypoints reprojected to camA');
            assertEqual(result.reprojections.camB.length, 4, '4 keypoints reprojected to camB');
            assertEqual(result.reprojections.camC.length, 4, '4 keypoints reprojected to camC');
        });

        it('triangulate with only 1 camera returns empty', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA']);
            var singleCam = [session.cameras[0]];

            var result = triangulateAndReproject(group, singleCam);

            // With only 1 camera, no triangulation possible for any keypoint
            // points3d entries will be null for keypoints with < 2 observations
            for (var k = 0; k < result.points3d.length; k++) {
                assertNull(result.points3d[k], 'Point ' + k + ' should be null with 1 camera');
            }
        });

        it('triangulate + save/load + re-triangulate gives consistent results', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA', 'camB']);

            var result1 = triangulateAndReproject(group, session.cameras);
            group.points3d = result1.points3d;

            // Save and restore
            var sr = saveAndRestoreSession(session);
            var restoredGroups = sr.restored.getInstanceGroupsForFrame(0);
            assertEqual(restoredGroups.length, 1);

            // Re-triangulate from restored 2D points
            var result2 = triangulateAndReproject(restoredGroups[0], sr.cameras);

            // Points should be very close (floating point)
            for (var k = 0; k < result1.points3d.length; k++) {
                if (result1.points3d[k] && result2.points3d[k]) {
                    for (var d = 0; d < 3; d++) {
                        assertApprox(result2.points3d[k][d], result1.points3d[k][d], 0.01,
                            'Point ' + k + ' dim ' + d + ' should match');
                    }
                }
            }
        });

        it('reprojection errors are finite positive numbers', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA', 'camB']);

            var result = triangulateAndReproject(group, session.cameras);

            for (var camName in result.errors) {
                var errs = result.errors[camName];
                for (var k = 0; k < errs.length; k++) {
                    if (errs[k] != null) {
                        assertTrue(isFinite(errs[k]), 'Error should be finite');
                        assertTrue(errs[k] >= 0, 'Error should be non-negative');
                    }
                }
            }
        });

        it('meanError is computed correctly', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA', 'camB']);

            var result = triangulateAndReproject(group, session.cameras);

            assertNotNull(result.meanError, 'meanError should not be null');
            assertTrue(isFinite(result.meanError), 'meanError should be finite');
            assertTrue(result.meanError >= 0, 'meanError should be non-negative');
        });
    });

    // =========================================================================
    // 6. Full proofreading pipeline: import → clone → triangulate → save → load
    // =========================================================================

    describe('Full proofreading pipeline', function () {
        it('import predictions → clone to user → triangulate → save → load', function () {
            // Step 1: Import predictions (simulate SLP load)
            var session = makeSimpleSession();
            var predGroup = addPredictedGroup(session, 10, ['camA', 'camB']);

            assertEqual(session.getInstanceGroupsForFrame(10).length, 1);
            assertEqual(predGroup.getInstance('camA').type, 'predicted');

            // Step 2: Clone predicted → user
            var userGroup = clonePredictedToUser(session, 10, predGroup);
            assertEqual(userGroup.getInstance('camA').type, 'user');

            // Step 3: Triangulate
            var triResult = triangulateAndReproject(userGroup, session.cameras);
            userGroup.points3d = triResult.points3d;
            userGroup.reprojections = triResult.reprojections;

            assertNotNull(userGroup.points3d);

            // Step 4: Save and load
            var sr = saveAndRestoreSession(session);
            var restoredGroups = sr.restored.getInstanceGroupsForFrame(10);
            assertEqual(restoredGroups.length, 1, 'Should have 1 group after restore');

            var rGroup = restoredGroups[0];
            assertEqual(rGroup.getInstance('camA').type, 'user', 'Should be user after restore');
            assertEqual(rGroup.getInstance('camB').type, 'user');
            assertNotNull(rGroup.points3d, 'points3d should be preserved');

            // Step 5: Re-triangulate on restored data
            var triResult2 = triangulateAndReproject(rGroup, sr.cameras);
            for (var k = 0; k < triResult.points3d.length; k++) {
                if (triResult.points3d[k] && triResult2.points3d[k]) {
                    for (var d = 0; d < 3; d++) {
                        assertApprox(triResult2.points3d[k][d], triResult.points3d[k][d], 0.01,
                            'Re-triangulated point should match');
                    }
                }
            }
        });

        it('multi-frame pipeline: some cloned, some not', function () {
            var session = makeSimpleSession();
            var pred0 = addPredictedGroup(session, 0, ['camA', 'camB']);
            var pred5 = addPredictedGroup(session, 5, ['camA', 'camB']);
            addPredictedGroup(session, 10, ['camA', 'camB']); // Leave this one as predicted

            // Clone frames 0 and 5 only
            clonePredictedToUser(session, 0, pred0);
            clonePredictedToUser(session, 5, pred5);

            // Verify state
            assertEqual(session.getInstanceGroupsForFrame(0)[0].getInstance('camA').type, 'user');
            assertEqual(session.getInstanceGroupsForFrame(5)[0].getInstance('camA').type, 'user');
            assertEqual(session.getInstanceGroupsForFrame(10)[0].getInstance('camA').type, 'predicted');

            // Save and restore
            var sr = saveAndRestoreSession(session);
            assertEqual(sr.restored.getInstanceGroupsForFrame(0)[0].getInstance('camA').type, 'user');
            assertEqual(sr.restored.getInstanceGroupsForFrame(5)[0].getInstance('camA').type, 'user');
            assertEqual(sr.restored.getInstanceGroupsForFrame(10)[0].getInstance('camA').type, 'predicted');
        });

        it('clone → unlink → delete some → re-link → triangulate → save → load', function () {
            var session = makeRealisticSession();
            var pred = addPredictedGroup(session, 0, ['camA', 'camB', 'camC']);

            // Clone
            var userGroup = clonePredictedToUser(session, 0, pred);
            assertEqual(userGroup.cameraNames.length, 3);

            // Unlink
            var unlinked = session.unlinkGroup(0, userGroup);
            assertEqual(unlinked.length, 3);
            assertEqual(session.getInstanceGroupsForFrame(0).length, 0);

            // Delete camC
            var fg = session.getFrameGroup(0);
            fg.removeUnlinkedById(unlinked[2].id);

            // Re-link remaining
            var relinked = session.createGroupFromUnlinked(0, [unlinked[0], unlinked[1]], 0);
            assertEqual(relinked.cameraNames.length, 2);

            // Triangulate
            var triCams = session.cameras.filter(function (c) {
                return relinked.cameraNames.indexOf(c.name) >= 0;
            });
            var triResult = triangulateAndReproject(relinked, triCams);
            relinked.points3d = triResult.points3d;

            // Save and load
            var sr = saveAndRestoreSession(session);
            var restoredGroups = sr.restored.getInstanceGroupsForFrame(0);
            assertEqual(restoredGroups.length, 1);
            assertEqual(restoredGroups[0].cameraNames.length, 2);
            assertNotNull(restoredGroups[0].points3d);
        });
    });

    // =========================================================================
    // 7. Export Tests
    // =========================================================================

    describe('SLP export with mixed instance types', function () {
        it('exports both user and predicted instances correctly', function () {
            if (typeof buildSlpExportData !== 'function') return;

            var session = makeSimpleSession();
            // Frame 0: user labels
            addUserGroup(session, 0, ['camA', 'camB']);
            // Frame 5: predicted labels
            addPredictedGroup(session, 5, ['camA', 'camB']);

            var views = [
                { name: 'camA', videoWidth: 640, videoHeight: 480 },
                { name: 'camB', videoWidth: 640, videoHeight: 480 },
            ];
            var data = buildSlpExportData(session, views);

            assertNotNull(data.frames, 'Should have frames');
            assertGreaterThan(data.frames.length, 0, 'Should have at least 1 frame');
            assertGreaterThan(data.instances.length, 0, 'Should have instances');

            // Check instance types
            var userInsts = data.instances.filter(function (i) { return i.instance_type === 0; });
            var predInsts = data.instances.filter(function (i) { return i.instance_type === 1; });
            assertGreaterThan(userInsts.length, 0, 'Should have user instances');
            assertGreaterThan(predInsts.length, 0, 'Should have predicted instances');
        });

        it('exports only user labels when predicted are absent', function () {
            if (typeof buildSlpExportData !== 'function') return;

            var session = makeSimpleSession();
            addUserGroup(session, 0, ['camA']);

            var views = [{ name: 'camA', videoWidth: 640, videoHeight: 480 }];
            var data = buildSlpExportData(session, views);

            for (var i = 0; i < data.instances.length; i++) {
                assertEqual(data.instances[i].instance_type, 0, 'All instances should be user type');
            }
            assertEqual(data.pred_points.length, 0, 'No predicted points');
        });

        it('export after clone preserves user type', function () {
            if (typeof buildSlpExportData !== 'function') return;

            var session = makeSimpleSession();
            var pred = addPredictedGroup(session, 0, ['camA', 'camB']);
            clonePredictedToUser(session, 0, pred);

            var views = [
                { name: 'camA', videoWidth: 640, videoHeight: 480 },
                { name: 'camB', videoWidth: 640, videoHeight: 480 },
            ];
            var data = buildSlpExportData(session, views);

            for (var i = 0; i < data.instances.length; i++) {
                assertEqual(data.instances[i].instance_type, 0, 'Cloned instances should be user type');
            }
        });

        it('export includes point coordinates', function () {
            if (typeof buildSlpExportData !== 'function') return;

            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA']);
            var expectedPt = group.getInstance('camA').points[0];

            var views = [{ name: 'camA', videoWidth: 640, videoHeight: 480 }];
            var data = buildSlpExportData(session, views);

            assertGreaterThan(data.points.length, 0, 'Should have points');
            assertEqual(data.points[0].x, expectedPt[0], 'X should match');
            assertEqual(data.points[0].y, expectedPt[1], 'Y should match');
            assertTrue(data.points[0].visible, 'Point should be visible');
        });

        it('export includes 3D points in sessions', function () {
            if (typeof buildSlpExportData !== 'function') return;

            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA', 'camB']);
            group.points3d = [[10, 20, 30], [40, 50, 60]];

            var views = [
                { name: 'camA', videoWidth: 640, videoHeight: 480 },
                { name: 'camB', videoWidth: 640, videoHeight: 480 },
            ];
            var data = buildSlpExportData(session, views);

            assertGreaterThan(data.sessions.length, 0);
            var fgDicts = data.sessions[0].frame_group_dicts;
            assertGreaterThan(fgDicts.length, 0, 'Should have frame group dicts');
            assertDeepEqual(fgDicts[0].instance_groups[0].points, [[10, 20, 30], [40, 50, 60]]);
        });
    });

    describe('Points3D export', function () {
        it('exports triangulated points correctly', function () {
            if (typeof buildPoints3dExportData !== 'function') return;

            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA', 'camB']);
            group.points3d = [[1, 2, 3], [4, 5, 6]];

            var data = buildPoints3dExportData(session);
            assertEqual(data.frame_indices.length, 1);
            assertEqual(data.frame_indices[0], 0);
            assertEqual(data.node_names.length, 2);
            assertDeepEqual(data.node_names, ['nose', 'tail']);
        });

        it('exports multiple frames in order', function () {
            if (typeof buildPoints3dExportData !== 'function') return;

            var session = makeSimpleSession();
            var g1 = addUserGroup(session, 10, ['camA', 'camB']);
            g1.points3d = [[1, 2, 3], [4, 5, 6]];
            var g2 = addUserGroup(session, 5, ['camA', 'camB']);
            g2.points3d = [[7, 8, 9], [10, 11, 12]];

            var data = buildPoints3dExportData(session);
            assertEqual(data.frame_indices.length, 2);
        });

        it('skips frames without points3d', function () {
            if (typeof buildPoints3dExportData !== 'function') return;

            var session = makeSimpleSession();
            addUserGroup(session, 0, ['camA', 'camB']); // No points3d
            var g2 = addUserGroup(session, 5, ['camA', 'camB']);
            g2.points3d = [[1, 2, 3], [4, 5, 6]];

            var data = buildPoints3dExportData(session);
            assertEqual(data.frame_indices.length, 1);
            assertEqual(data.frame_indices[0], 5);
        });
    });

    // =========================================================================
    // 8. Calibration round-trip
    // =========================================================================

    describe('Calibration export + re-import', function () {
        it('TOML round-trip preserves camera params', function () {
            if (typeof exportCalibrationTOML !== 'function') return;

            var session = makeRealisticSession();
            var toml = exportCalibrationTOML(session.cameras);
            var parsed = parseCalibrationTOML(toml);

            assertEqual(parsed.length, 3);
            for (var i = 0; i < 3; i++) {
                assertEqual(parsed[i].name, session.cameras[i].name);
                assertDeepEqual(parsed[i].size, session.cameras[i].size);
                for (var r = 0; r < 3; r++) {
                    assertApprox(parsed[i].rvec[r], session.cameras[i].rvec[r], 1e-4,
                        'rvec[' + r + '] for camera ' + i);
                    assertApprox(parsed[i].tvec[r], session.cameras[i].tvec[r], 1e-4,
                        'tvec[' + r + '] for camera ' + i);
                }
            }
        });

        it('JSON round-trip preserves camera params', function () {
            var session = makeRealisticSession();
            var json = JSON.stringify({
                cameras: session.cameras.map(function (c) {
                    return { name: c.name, matrix: c.matrix, dist: c.dist, rvec: c.rvec, tvec: c.tvec, size: c.size };
                })
            });
            var parsed = parseCalibrationJSON(json);

            assertEqual(parsed.length, 3);
            for (var i = 0; i < 3; i++) {
                assertEqual(parsed[i].name, session.cameras[i].name);
                assertDeepEqual(parsed[i].matrix, session.cameras[i].matrix);
            }
        });
    });

    // =========================================================================
    // 9. Rapid click/unclick stress tests
    // =========================================================================

    describe('Rapid state transitions (stress)', function () {
        it('clone → delete → re-add predicted → clone again', function () {
            var session = makeSimpleSession();
            var pred = addPredictedGroup(session, 0, ['camA', 'camB']);

            // Clone
            var user = clonePredictedToUser(session, 0, pred);
            assertEqual(session.getInstanceGroupsForFrame(0).length, 1);

            // Delete
            session.removeInstanceGroup(0, user);
            assertEqual(session.getInstanceGroupsForFrame(0).length, 0);

            // Re-add predicted (simulating undo or re-import)
            var pred2 = addPredictedGroup(session, 0, ['camA', 'camB']);
            assertEqual(session.getInstanceGroupsForFrame(0).length, 1);

            // Clone again
            var user2 = clonePredictedToUser(session, 0, pred2);
            assertEqual(session.getInstanceGroupsForFrame(0).length, 1);
            assertEqual(user2.getInstance('camA').type, 'user');
        });

        it('repeated unlink → re-link cycles', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA', 'camB']);

            for (var cycle = 0; cycle < 5; cycle++) {
                var unlinked = session.unlinkGroup(0, group);
                assertEqual(session.getInstanceGroupsForFrame(0).length, 0,
                    'Cycle ' + cycle + ': no groups after unlink');

                group = session.createGroupFromUnlinked(0, unlinked, 0);
                assertEqual(session.getInstanceGroupsForFrame(0).length, 1,
                    'Cycle ' + cycle + ': 1 group after re-link');
            }

            // Final state should be valid
            assertEqual(group.cameraNames.length, 2);
            assertEqual(group.getInstance('camA').type, 'user');
        });

        it('clone → unlink → delete all → verify clean state', function () {
            var session = makeSimpleSession();
            var pred = addPredictedGroup(session, 0, ['camA', 'camB']);

            // Clone
            var user = clonePredictedToUser(session, 0, pred);

            // Unlink
            var unlinked = session.unlinkGroup(0, user);
            assertEqual(unlinked.length, 2);

            // Delete all unlinked
            var fg = session.getFrameGroup(0);
            for (var i = unlinked.length - 1; i >= 0; i--) {
                fg.removeUnlinkedById(unlinked[i].id);
            }

            // Verify completely clean
            assertEqual(session.getInstanceGroupsForFrame(0).length, 0, 'No groups');
            var ulA = fg.getUnlinkedInstances('camA');
            var ulB = fg.getUnlinkedInstances('camB');
            assertEqual(ulA.length, 0, 'No unlinked on camA');
            assertEqual(ulB.length, 0, 'No unlinked on camB');
        });

        it('interleaved operations on multiple frames', function () {
            var session = makeSimpleSession();
            var pred0 = addPredictedGroup(session, 0, ['camA', 'camB']);
            var pred5 = addPredictedGroup(session, 5, ['camA', 'camB']);

            // Clone frame 0
            var user0 = clonePredictedToUser(session, 0, pred0);

            // Unlink frame 5
            var unlinked5 = session.unlinkGroup(5, pred5);

            // Triangulate frame 0
            var tri0 = triangulateAndReproject(user0, session.cameras);
            user0.points3d = tri0.points3d;

            // Re-link frame 5
            var newGroup5 = session.createGroupFromUnlinked(5, unlinked5, 0);

            // Verify both frames are valid
            assertEqual(session.getInstanceGroupsForFrame(0).length, 1);
            assertEqual(session.getInstanceGroupsForFrame(5).length, 1);
            assertNotNull(user0.points3d);
            assertEqual(newGroup5.getInstance('camA').type, 'predicted');
        });

        it('convertPredictedToUser in-place + triangulate + save/load', function () {
            var session = makeSimpleSession();
            var pred = addPredictedGroup(session, 0, ['camA', 'camB']);

            // In-place conversion
            session.convertPredictedToUser(pred);
            assertEqual(pred.getInstance('camA').type, 'user');
            assertEqual(pred.getInstance('camB').type, 'user');

            // Triangulate
            var tri = triangulateAndReproject(pred, session.cameras);
            pred.points3d = tri.points3d;

            // Save + load
            var sr = saveAndRestoreSession(session);
            var rGroups = sr.restored.getInstanceGroupsForFrame(0);
            assertEqual(rGroups.length, 1);
            assertEqual(rGroups[0].getInstance('camA').type, 'user');
            assertNotNull(rGroups[0].points3d);
        });
    });

    // =========================================================================
    // 10. Edge cases and error conditions
    // =========================================================================

    describe('Edge cases', function () {
        it('empty session save/load produces empty session', function () {
            var session = makeSimpleSession();
            var sr = saveAndRestoreSession(session);
            assertEqual(sr.restored.frameGroups.size, 0);
            assertEqual(sr.restored.getInstanceGroupsForFrame(0).length, 0);
        });

        it('group with null points saves/loads correctly', function () {
            var session = makeSimpleSession();
            var fg = new FrameGroup(0);
            session.addFrameGroup(fg);
            var group = new InstanceGroup(12345, 0);
            var inst = new Instance([null, [100, 200]], 0, 'user', 1.0);
            group.addInstance('camA', inst);
            fg.addInstance('camA', inst);
            if (!session.instanceGroups.has(0)) session.instanceGroups.set(0, new Map());
            var tm = session.instanceGroups.get(0);
            if (!tm.has(0)) tm.set(0, []);
            tm.get(0).push(group);

            var sr = saveAndRestoreSession(session);
            var rGroup = sr.restored.getInstanceGroupsForFrame(0)[0];
            assertNull(rGroup.getInstance('camA').points[0], 'Null point should be preserved');
            assertDeepEqual(rGroup.getInstance('camA').points[1], [100, 200]);
        });

        it('group with single camera still saves/loads', function () {
            var session = makeSimpleSession();
            addUserGroup(session, 0, ['camA']);

            var sr = saveAndRestoreSession(session);
            var groups = sr.restored.getInstanceGroupsForFrame(0);
            assertEqual(groups.length, 1);
            assertEqual(groups[0].cameraNames.length, 1);
            assertNotNull(groups[0].getInstance('camA'));
            assertNull(groups[0].getInstance('camB'), 'camB should not exist');
        });

        it('large frame index values are handled', function () {
            var session = makeSimpleSession();
            addUserGroup(session, 99999, ['camA']);

            var sr = saveAndRestoreSession(session);
            var groups = sr.restored.getInstanceGroupsForFrame(99999);
            assertEqual(groups.length, 1);
        });

        it('multiple groups same track same frame', function () {
            var session = makeSimpleSession();
            // This is unusual but should not crash
            var g1 = addUserGroup(session, 0, ['camA'], 0);
            var g2 = addUserGroup(session, 0, ['camB'], 0);

            var groups = session.getInstanceGroupsForFrame(0);
            assertEqual(groups.length, 2);

            var sr = saveAndRestoreSession(session);
            var rGroups = sr.restored.getInstanceGroupsForFrame(0);
            assertEqual(rGroups.length, 2);
        });

        it('removeInstanceGroup with wrong frame is a no-op', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA']);

            // Try to remove from wrong frame
            var removed = session.removeInstanceGroup(5, group);
            assertFalse(removed, 'Should return false for wrong frame');
            assertEqual(session.getInstanceGroupsForFrame(0).length, 1, 'Group should still exist');
        });

        it('unlink empty group', function () {
            var session = makeSimpleSession();
            var fg = new FrameGroup(0);
            session.addFrameGroup(fg);
            var group = new InstanceGroup(999, 0);
            // Group has no instances - just test it doesn't crash
            if (!session.instanceGroups.has(0)) session.instanceGroups.set(0, new Map());
            var tm = session.instanceGroups.get(0);
            if (!tm.has(0)) tm.set(0, []);
            tm.get(0).push(group);

            var unlinked = session.unlinkGroup(0, group);
            assertEqual(unlinked.length, 0, 'No unlinked from empty group');
        });
    });

    // =========================================================================
    // 11. FrameGroup ↔ InstanceGroup consistency invariants
    // =========================================================================

    describe('Data structure consistency invariants', function () {
        it('every instance in InstanceGroup exists in FrameGroup', function () {
            var session = makeSimpleSession();
            addUserGroup(session, 0, ['camA', 'camB']);
            addPredictedGroup(session, 0, ['camA'], 1);

            var fg = session.getFrameGroup(0);
            var groups = session.getInstanceGroupsForFrame(0);

            for (var gi = 0; gi < groups.length; gi++) {
                for (var entry of groups[gi].instances) {
                    var camName = entry[0];
                    var inst = entry[1];
                    var fgInsts = fg.getInstances(camName);
                    var found = fgInsts.indexOf(inst) >= 0;
                    assertTrue(found, 'Instance in group ' + gi + '/' + camName +
                        ' should be in FrameGroup');
                }
            }
        });

        it('after clone, no predicted instances remain in FrameGroup', function () {
            var session = makeSimpleSession();
            var pred = addPredictedGroup(session, 0, ['camA', 'camB']);

            clonePredictedToUser(session, 0, pred);

            var fg = session.getFrameGroup(0);
            for (var camEntry of fg.instances) {
                var insts = camEntry[1];
                for (var i = 0; i < insts.length; i++) {
                    assertTrue(insts[i].type !== 'predicted',
                        'No predicted instances should remain after clone');
                }
            }
        });

        it('after unlink, FrameGroup has matching unlinked instances', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA', 'camB']);
            var originalCamNames = group.cameraNames.slice();

            session.unlinkGroup(0, group);

            var fg = session.getFrameGroup(0);
            for (var i = 0; i < originalCamNames.length; i++) {
                var cn = originalCamNames[i];
                var ul = fg.getUnlinkedInstances(cn);
                assertEqual(ul.length, 1, cn + ' should have 1 unlinked instance');
            }
        });

        it('after createGroupFromUnlinked, unlinked are removed', function () {
            var session = makeSimpleSession();
            var inst1 = new Instance([[100, 200], [300, 400]], 0, 'user', 1.0);
            var inst2 = new Instance([[150, 250], [350, 450]], 0, 'user', 1.0);
            var ul1 = session.addUnlinkedInstance(0, 'camA', inst1);
            var ul2 = session.addUnlinkedInstance(0, 'camB', inst2);

            session.createGroupFromUnlinked(0, [ul1, ul2], 0);

            var fg = session.getFrameGroup(0);
            var ulA = fg.getUnlinkedInstances('camA');
            var ulB = fg.getUnlinkedInstances('camB');
            assertEqual(ulA.length, 0, 'Unlinked should be removed from camA');
            assertEqual(ulB.length, 0, 'Unlinked should be removed from camB');
        });
    });

    // =========================================================================
    // 12. SLP merge then annotate workflow
    // =========================================================================

    describe('Multi-SLP merge + annotation', function () {
        it('merge 2 SLPs → clone on merged frame → triangulate', function () {
            if (typeof mergeSlpFramesIntoSession !== 'function') return;
            if (typeof rebuildInstanceGroupsForFrames !== 'function') return;

            var skeleton = new Skeleton('test', ['nose', 'tail'], [[0, 1]]);
            var camA = new Camera('camA',
                [[500, 0, 320], [0, 500, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 500], [640, 480]);
            var camB = new Camera('camB',
                [[500, 0, 320], [0, 500, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 1.57, 0], [500, 0, 0], [640, 480]);

            // First SLP: camA
            var session = new Session([camA], skeleton, ['track_0']);
            var fg0 = new FrameGroup(0);
            fg0.addInstance('camA', new Instance([[100, 200], [300, 400]], 0, 'predicted', 0.9));
            session.addFrameGroup(fg0);
            rebuildInstanceGroupsForFrames(session, [0]);

            // Second SLP: camB
            session.cameras.push(camB);
            var trackRemap = mergeTracksIntoSession(session, ['track_0']);
            var slpData = {
                frames: [{
                    frameIdx: 0, videoIdx: 0,
                    instances: [{ points: [[150, 250], [350, 450]], trackIdx: 0, type: 'predicted', score: 0.85 }]
                }]
            };
            var affected = mergeSlpFramesIntoSession(session, slpData, { 0: 'camB' }, [camB], trackRemap, null);
            rebuildInstanceGroupsForFrames(session, affected);

            // Verify merged frame
            var groups = session.getInstanceGroupsForFrame(0);
            assertEqual(groups.length, 1);
            assertNotNull(groups[0].getInstance('camA'));
            assertNotNull(groups[0].getInstance('camB'));

            // Clone to user
            var userGroup = clonePredictedToUser(session, 0, groups[0]);
            assertEqual(userGroup.getInstance('camA').type, 'user');
            assertEqual(userGroup.getInstance('camB').type, 'user');

            // Triangulate
            var tri = triangulateAndReproject(userGroup, session.cameras);
            assertNotNull(tri.points3d);

            // Save + restore
            var sr = saveAndRestoreSession(session);
            var rGroups = sr.restored.getInstanceGroupsForFrame(0);
            assertEqual(rGroups.length, 1);
            assertEqual(rGroups[0].getInstance('camA').type, 'user');
            assertEqual(rGroups[0].getInstance('camB').type, 'user');
        });
    });

    // =========================================================================
    // 13. Camera rename during load
    // =========================================================================

    describe('Camera rename during project restore', function () {
        it('renameCameraInAllData renames in InstanceGroups', function () {
            var session = makeSimpleSession();
            addUserGroup(session, 0, ['camA', 'camB']);

            session.renameCameraInAllData('camA', 'A');

            var groups = session.getInstanceGroupsForFrame(0);
            assertNull(groups[0].getInstance('camA'), 'Old name should not exist');
            assertNotNull(groups[0].getInstance('A'), 'New name should exist');
        });

        it('renameCameraInAllData renames in FrameGroups', function () {
            var session = makeSimpleSession();
            addUserGroup(session, 0, ['camA', 'camB']);

            session.renameCameraInAllData('camA', 'A');

            var fg = session.getFrameGroup(0);
            var oldInsts = fg.getInstances('camA');
            var newInsts = fg.getInstances('A');
            assertEqual(oldInsts.length, 0, 'Old camera name should have no instances');
            assertGreaterThan(newInsts.length, 0, 'New camera name should have instances');
        });

        it('renameCameraInAllData handles unlinked instances', function () {
            var session = makeSimpleSession();
            var inst = new Instance([[100, 200], [300, 400]], 0, 'user', 1.0);
            session.addUnlinkedInstance(0, 'camA', inst);

            session.renameCameraInAllData('camA', 'A');

            var fg = session.getFrameGroup(0);
            var oldUl = fg.getUnlinkedInstances('camA');
            var newUl = fg.getUnlinkedInstances('A');
            assertEqual(oldUl.length, 0);
            assertEqual(newUl.length, 1);
            assertEqual(newUl[0].cameraName, 'A');
        });

        it('rename to same name is no-op', function () {
            var session = makeSimpleSession();
            addUserGroup(session, 0, ['camA']);

            session.renameCameraInAllData('camA', 'camA');

            var groups = session.getInstanceGroupsForFrame(0);
            assertNotNull(groups[0].getInstance('camA'));
        });
    });

    // =========================================================================
    // 14. Serialization format validation
    // =========================================================================

    describe('Project JSON format validation', function () {
        it('saved JSON has required top-level fields', function () {
            var session = makeSimpleSession();
            addUserGroup(session, 0, ['camA']);

            var sr = saveAndRestoreSession(session);
            var data = sr.rawData;

            assertEqual(data.version, 2);
            assertNotNull(data.skeleton);
            assertNotNull(data.cameras);
            assertNotNull(data.tracks);
            assertNotNull(data.frames);
        });

        it('saved JSON frame has instanceGroups and unlinkedInstances arrays', function () {
            var session = makeSimpleSession();
            addUserGroup(session, 0, ['camA']);

            var sr = saveAndRestoreSession(session);
            var frameData = sr.rawData.frames['0'];

            assertNotNull(frameData);
            assertTrue(Array.isArray(frameData.instanceGroups));
            assertTrue(Array.isArray(frameData.unlinkedInstances));
        });

        it('instance data has all required fields', function () {
            var session = makeSimpleSession();
            var group = addUserGroup(session, 0, ['camA']);
            group.points3d = [[1, 2, 3], [4, 5, 6]];

            var sr = saveAndRestoreSession(session);
            var gData = sr.rawData.frames['0'].instanceGroups[0];

            assertNotNull(gData.id, 'Should have id');
            assertTrue(gData.trackIdx >= 0, 'Should have trackIdx');
            assertNotNull(gData.instances, 'Should have instances');
            assertNotNull(gData.instances.camA, 'Should have camA instance');
            assertNotNull(gData.instances.camA.points, 'Instance should have points');
            assertNotNull(gData.instances.camA.type, 'Instance should have type');
            assertNotNull(gData.points3d, 'Should have points3d');
        });
    });

})();
} catch(e) {
    console.error('[test-annotation-workflow] LOAD ERROR:', e);
    var errMsg = String(e.message || e);
    var errStack = e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : 'no stack';
    TestFramework.describe('LOAD ERROR: test-annotation-workflow.js', function() {
        TestFramework.it(errMsg + ' @ ' + errStack, function() {
            throw new Error(errMsg);
        });
    });
}
