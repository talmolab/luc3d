/**
 * test-proofreading-lifecycle.js - Comprehensive tests for the proofreading
 * state machine: clone predicted → user, unlink, delete, re-convert, and
 * verify FrameGroup ↔ InstanceGroup sync at every step.
 */

(function () {
    const { describe, it, assertEqual, assertDeepEqual, assertNotNull,
        assertNull, assertTrue, assertFalse, assertGreaterThan } = TestFramework;

    // ---- Helpers ----

    function makeSession(numCameras) {
        numCameras = numCameras || 3;
        var skeleton = new Skeleton('test', ['nose', 'tail'], [[0, 1]]);
        var cameras = [];
        for (var i = 0; i < numCameras; i++) {
            cameras.push(new Camera(
                'cam' + String.fromCharCode(65 + i), // camA, camB, camC
                [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]
            ));
        }
        return new Session(cameras, skeleton, ['track_0']);
    }

    /** Create a predicted InstanceGroup with instances for given cameras. */
    function makePredictedGroup(session, frameIdx, camNames) {
        var fg = session.frameGroups.get(frameIdx);
        if (!fg) {
            fg = new FrameGroup(frameIdx);
            session.addFrameGroup(fg);
        }
        var group = new InstanceGroup(Date.now() + Math.random() * 1000, 0);
        for (var i = 0; i < camNames.length; i++) {
            var pts = [[100 + i * 10, 200 + i * 10], [300 + i * 10, 400 + i * 10]];
            var inst = new Instance(pts, 0, 'predicted', 0.9);
            group.addInstance(camNames[i], inst);
            fg.addInstance(camNames[i], inst);
        }
        if (!session.instanceGroups.has(frameIdx)) {
            session.instanceGroups.set(frameIdx, new Map());
        }
        var trackMap = session.instanceGroups.get(frameIdx);
        if (!trackMap.has(0)) trackMap.set(0, []);
        trackMap.get(0).push(group);
        return group;
    }

    /** Count total instances across all cameras in a FrameGroup. */
    function countFrameGroupInstances(fg) {
        var total = 0;
        for (var [, arr] of fg.instances) total += arr.length;
        return total;
    }

    /** Count total unlinked instances in a FrameGroup. */
    function countUnlinked(fg) {
        var total = 0;
        for (var [, arr] of fg.unlinkedInstances) total += arr.length;
        return total;
    }

    /** Get all instance groups for a frame. */
    function getGroups(session, frameIdx) {
        return session.getInstanceGroupsForFrame(frameIdx);
    }

    function makeManager(session, frameIdx) {
        var canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        canvas.style.cssText = 'position:fixed;top:0;left:0;width:640px;height:480px;visibility:hidden;';
        document.body.appendChild(canvas);

        var state = {
            currentFrame: frameIdx,
            session: session,
            views: session.cameras.map(function (c) {
                return { name: c.name, overlayCanvas: canvas, videoWidth: 640, videoHeight: 480 };
            }),
        };

        var callbacks = {
            clonedGroup: null,
            deletedFrameIdx: null,
            convertedGroup: null,
        };

        var manager = new InteractionManager({
            getState: function () { return state; },
            getInstanceGroups: function (fi) { return session.getInstanceGroupsForFrame(fi); },
            onSelectionChanged: function () {},
            onInstanceDeleted: function (fi) { callbacks.deletedFrameIdx = fi; },
            onInstanceConverted: function (g) { callbacks.convertedGroup = g; },
            onClonePredictedGroup: function (g) { callbacks.clonedGroup = g; },
            requestRedraw: function () {},
        });

        return { manager: manager, state: state, canvas: canvas, callbacks: callbacks };
    }

    function cleanup(ctx) {
        if (ctx.canvas) ctx.canvas.remove();
    }

    // ============================================================
    // 1. Basic FrameGroup ↔ InstanceGroup sync
    // ============================================================

    describe('Proofreading: FrameGroup ↔ InstanceGroup sync', function () {

        it('makePredictedGroup populates both FrameGroup and InstanceGroup', function () {
            var session = makeSession(3);
            var group = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);

            var fg = session.frameGroups.get(0);
            assertNotNull(fg, 'FrameGroup exists');
            assertEqual(countFrameGroupInstances(fg), 3, 'FrameGroup has 3 instances');
            assertEqual(group.cameraNames.length, 3, 'Group has 3 cameras');
            assertEqual(getGroups(session, 0).length, 1, '1 group in session');
        });

        it('all instances are type predicted', function () {
            var session = makeSession(3);
            var group = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);

            for (var [, inst] of group.instances) {
                assertEqual(inst.type, 'predicted', 'Instance type is predicted');
            }
        });

        it('same Instance objects in FrameGroup and InstanceGroup', function () {
            var session = makeSession(3);
            var group = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);
            var fg = session.frameGroups.get(0);

            for (var [camName, inst] of group.instances) {
                var fgInsts = fg.getInstances(camName);
                assertTrue(fgInsts.indexOf(inst) >= 0,
                    'Same object in FrameGroup for ' + camName);
            }
        });
    });

    // ============================================================
    // 2. removeInstanceGroup cleans up both structures
    // ============================================================

    describe('Proofreading: removeInstanceGroup cleanup', function () {

        it('removes from both InstanceGroups and FrameGroup.instances', function () {
            var session = makeSession(3);
            var group = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);

            session.removeInstanceGroup(0, group);

            assertEqual(getGroups(session, 0).length, 0, 'No groups remain');
            var fg = session.frameGroups.get(0);
            // FrameGroup may be deleted if empty
            if (fg) {
                assertEqual(countFrameGroupInstances(fg), 0, 'No instances in FrameGroup');
            }
        });

        it('removing one of two groups keeps the other intact', function () {
            var session = makeSession(2);
            var g1 = makePredictedGroup(session, 0, ['camA']);
            // Add second group on track 1
            var fg = session.frameGroups.get(0);
            var g2 = new InstanceGroup(Date.now() + 999, 1);
            var inst2 = new Instance([[50, 60], [70, 80]], 1, 'predicted', 0.8);
            g2.addInstance('camB', inst2);
            fg.addInstance('camB', inst2);
            var trackMap = session.instanceGroups.get(0);
            trackMap.set(1, [g2]);

            session.removeInstanceGroup(0, g1);

            assertEqual(getGroups(session, 0).length, 1, '1 group remains');
            assertEqual(getGroups(session, 0)[0], g2, 'Correct group survives');
            assertTrue(fg.getInstances('camB').indexOf(inst2) >= 0,
                'camB instance still in FrameGroup');
        });
    });

    // ============================================================
    // 3. unlinkGroup: instances go to unlinked pool
    // ============================================================

    describe('Proofreading: unlinkGroup', function () {

        it('removes group and creates unlinked instances', function () {
            var session = makeSession(3);
            var group = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);

            var unlinked = session.unlinkGroup(0, group);

            assertEqual(getGroups(session, 0).length, 0, 'No linked groups');
            assertEqual(unlinked.length, 3, '3 unlinked returned');

            var fg = session.frameGroups.get(0);
            assertNotNull(fg, 'FrameGroup still exists');
            assertEqual(countFrameGroupInstances(fg), 0, 'No linked instances');
            assertEqual(countUnlinked(fg), 3, '3 unlinked in FrameGroup');
        });

        it('preserves instance type after unlinking', function () {
            var session = makeSession(2);
            var group = makePredictedGroup(session, 0, ['camA', 'camB']);

            var unlinked = session.unlinkGroup(0, group);

            for (var i = 0; i < unlinked.length; i++) {
                assertEqual(unlinked[i].instance.type, 'predicted',
                    'Unlinked instance preserves predicted type');
            }
        });

        it('preserves instance type user after unlinking user group', function () {
            var session = makeSession(2);
            var group = makePredictedGroup(session, 0, ['camA', 'camB']);
            // Convert to user type
            for (var [, inst] of group.instances) {
                inst.type = 'user';
            }

            var unlinked = session.unlinkGroup(0, group);

            for (var i = 0; i < unlinked.length; i++) {
                assertEqual(unlinked[i].instance.type, 'user',
                    'Unlinked instance preserves user type');
            }
        });
    });

    // ============================================================
    // 4. createGroupFromUnlinked
    // ============================================================

    describe('Proofreading: createGroupFromUnlinked', function () {

        it('moves unlinked instances into a new group', function () {
            var session = makeSession(2);
            var group = makePredictedGroup(session, 0, ['camA', 'camB']);
            var unlinked = session.unlinkGroup(0, group);

            var newGroup = session.createGroupFromUnlinked(0, unlinked, 0);

            assertEqual(getGroups(session, 0).length, 1, '1 group exists');
            assertEqual(newGroup.cameraNames.length, 2, 'Group has 2 cameras');

            var fg = session.frameGroups.get(0);
            assertEqual(countUnlinked(fg), 0, 'No unlinked remain');
            assertEqual(countFrameGroupInstances(fg), 2, '2 linked instances');
        });

        it('same instance objects in both structures', function () {
            var session = makeSession(2);
            var group = makePredictedGroup(session, 0, ['camA', 'camB']);
            var unlinked = session.unlinkGroup(0, group);
            var newGroup = session.createGroupFromUnlinked(0, unlinked, 0);
            var fg = session.frameGroups.get(0);

            for (var [camName, inst] of newGroup.instances) {
                var fgInsts = fg.getInstances(camName);
                assertTrue(fgInsts.indexOf(inst) >= 0,
                    'Same object reference for ' + camName);
            }
        });
    });

    // ============================================================
    // 5. Clone predicted group (onClonePredictedGroup simulation)
    // ============================================================

    describe('Proofreading: clone predicted group to user group', function () {

        it('clone removes old group and creates new user group', function () {
            var session = makeSession(3);
            var predGroup = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);
            var fg = session.frameGroups.get(0);

            // Simulate onClonePredictedGroup: remove old group from instanceGroups
            var trackMap = session.instanceGroups.get(0);
            var trackGroups = trackMap.get(predGroup.trackIdx);
            var pgIdx = trackGroups.indexOf(predGroup);
            if (pgIdx >= 0) trackGroups.splice(pgIdx, 1);

            // Also remove old predicted instances from FrameGroup
            for (var [camName, inst] of predGroup.instances) {
                var camInsts = fg.instances.get(camName);
                if (camInsts) {
                    var idx = camInsts.indexOf(inst);
                    if (idx >= 0) camInsts.splice(idx, 1);
                    if (camInsts.length === 0) fg.instances.delete(camName);
                }
            }

            // Create cloned user instances as unlinked
            var unlinkedList = [];
            for (var [camName2, inst2] of predGroup.instances) {
                var clonedPoints = inst2.points.map(function (pt) {
                    return pt ? [pt[0], pt[1]] : null;
                });
                var userInst = new Instance(clonedPoints, predGroup.trackIdx, 'user', 1.0);
                userInst.modified = true;
                var ul = session.addUnlinkedInstance(0, camName2, userInst);
                unlinkedList.push(ul);
            }

            var newGroup = session.createGroupFromUnlinked(0, unlinkedList, predGroup.trackIdx);

            // Verify: only new user group exists
            assertEqual(getGroups(session, 0).length, 1, 'Exactly 1 group');
            assertEqual(getGroups(session, 0)[0], newGroup, 'It is the new group');

            // All instances are user type
            for (var [, ni] of newGroup.instances) {
                assertEqual(ni.type, 'user', 'Instance is user type');
            }

            // FrameGroup has exactly the user instances
            assertEqual(countFrameGroupInstances(fg), 3, 'FrameGroup has 3 instances');
            assertEqual(countUnlinked(fg), 0, 'No unlinked remain');

            // No orphaned predicted instances
            for (var [cn, insts] of fg.instances) {
                for (var j = 0; j < insts.length; j++) {
                    assertEqual(insts[j].type, 'user',
                        'No predicted orphans in FrameGroup for ' + cn);
                }
            }
        });

        it('BUG CHECK: clone without FrameGroup cleanup leaves orphaned predictions', function () {
            var session = makeSession(2);
            var predGroup = makePredictedGroup(session, 0, ['camA', 'camB']);
            var fg = session.frameGroups.get(0);

            // Simulate the BUG: remove from instanceGroups but NOT from FrameGroup
            var trackMap = session.instanceGroups.get(0);
            var trackGroups = trackMap.get(predGroup.trackIdx);
            trackGroups.splice(trackGroups.indexOf(predGroup), 1);

            // Create new user group (without cleaning FrameGroup)
            var unlinkedList = [];
            for (var [camName, inst] of predGroup.instances) {
                var userInst = new Instance(
                    inst.points.map(function (pt) { return pt ? [pt[0], pt[1]] : null; }),
                    0, 'user', 1.0
                );
                var ul = session.addUnlinkedInstance(0, camName, userInst);
                unlinkedList.push(ul);
            }
            session.createGroupFromUnlinked(0, unlinkedList, 0);

            // FrameGroup now has BOTH predicted (orphaned) and user instances = BUG
            var totalInstances = countFrameGroupInstances(fg);
            // This is the bug: 4 instead of 2
            assertEqual(totalInstances, 4,
                'BUG: FrameGroup has orphaned predicted + new user instances');
        });
    });

    // ============================================================
    // 6. Per-camera deletion from a group
    // ============================================================

    describe('Proofreading: per-camera instance deletion', function () {

        it('deleting one camera instance keeps group with remaining cameras', function () {
            var session = makeSession(3);
            var group = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);
            var fg = session.frameGroups.get(0);

            // Remove camA instance from group (simulate per-camera delete)
            var instA = group.getInstance('camA');
            group.instances.delete('camA');
            var camInsts = fg.instances.get('camA');
            if (camInsts) {
                var idx = camInsts.indexOf(instA);
                if (idx >= 0) camInsts.splice(idx, 1);
                if (camInsts.length === 0) fg.instances.delete('camA');
            }

            assertEqual(group.cameraNames.length, 2, 'Group has 2 cameras remaining');
            assertEqual(countFrameGroupInstances(fg), 2, 'FrameGroup has 2 instances');
            assertNull(group.getInstance('camA'), 'camA removed from group');
        });

        it('deleting all cameras removes entire group', function () {
            var session = makeSession(2);
            var group = makePredictedGroup(session, 0, ['camA', 'camB']);

            // Delete camA
            var instA = group.getInstance('camA');
            group.instances.delete('camA');
            var fg = session.frameGroups.get(0);
            var arr = fg.instances.get('camA');
            arr.splice(arr.indexOf(instA), 1);
            if (arr.length === 0) fg.instances.delete('camA');

            // Delete camB → group empty → remove entire group
            var instB = group.getInstance('camB');
            group.instances.delete('camB');
            arr = fg.instances.get('camB');
            arr.splice(arr.indexOf(instB), 1);
            if (arr.length === 0) fg.instances.delete('camB');

            if (group.instances.size === 0) {
                session.removeInstanceGroup(0, group);
            }

            assertEqual(getGroups(session, 0).length, 0, 'Group removed when empty');
        });
    });

    // ============================================================
    // 7. Clone → delete user group → predictions should be gone
    // ============================================================

    describe('Proofreading: clone then delete user group', function () {

        it('after clone + full delete, no instances remain', function () {
            var session = makeSession(3);
            var predGroup = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);
            var fg = session.frameGroups.get(0);

            // Properly clone: clean up FrameGroup too
            for (var [camName, inst] of predGroup.instances) {
                var camInsts = fg.instances.get(camName);
                if (camInsts) {
                    var idx = camInsts.indexOf(inst);
                    if (idx >= 0) camInsts.splice(idx, 1);
                    if (camInsts.length === 0) fg.instances.delete(camName);
                }
            }
            var trackMap = session.instanceGroups.get(0);
            var tg = trackMap.get(0);
            tg.splice(tg.indexOf(predGroup), 1);

            var unlinkedList = [];
            for (var [cn, pi] of predGroup.instances) {
                var userInst = new Instance(
                    pi.points.map(function (pt) { return pt ? [pt[0], pt[1]] : null; }),
                    0, 'user', 1.0
                );
                var ul = session.addUnlinkedInstance(0, cn, userInst);
                unlinkedList.push(ul);
            }
            var userGroup = session.createGroupFromUnlinked(0, unlinkedList, 0);

            // Now delete the user group entirely
            session.removeInstanceGroup(0, userGroup);

            assertEqual(getGroups(session, 0).length, 0, 'No groups');
            fg = session.frameGroups.get(0);
            if (fg) {
                assertEqual(countFrameGroupInstances(fg), 0, 'No linked instances');
                assertEqual(countUnlinked(fg), 0, 'No unlinked instances');
            }
        });

        it('after clone + per-camera delete of one, 2 user instances remain', function () {
            var session = makeSession(3);
            var predGroup = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);
            var fg = session.frameGroups.get(0);

            // Clean clone
            for (var [camName, inst] of predGroup.instances) {
                var ci = fg.instances.get(camName);
                if (ci) { var idx = ci.indexOf(inst); if (idx >= 0) ci.splice(idx, 1); if (ci.length === 0) fg.instances.delete(camName); }
            }
            var trackMap = session.instanceGroups.get(0);
            trackMap.get(0).splice(trackMap.get(0).indexOf(predGroup), 1);

            var unlinkedList = [];
            for (var [cn, pi] of predGroup.instances) {
                var ui = new Instance(pi.points.map(function (p) { return p ? [p[0], p[1]] : null; }), 0, 'user', 1.0);
                unlinkedList.push(session.addUnlinkedInstance(0, cn, ui));
            }
            var userGroup = session.createGroupFromUnlinked(0, unlinkedList, 0);

            // Delete only camA from user group
            var instA = userGroup.getInstance('camA');
            userGroup.instances.delete('camA');
            var fgArr = fg.instances.get('camA');
            if (fgArr) { fgArr.splice(fgArr.indexOf(instA), 1); if (fgArr.length === 0) fg.instances.delete('camA'); }

            assertEqual(userGroup.cameraNames.length, 2, 'Group has 2 cameras');
            assertEqual(countFrameGroupInstances(fg), 2, 'FrameGroup has 2 instances');

            // All remaining are user type
            for (var [, ri] of userGroup.instances) {
                assertEqual(ri.type, 'user', 'Remaining instance is user');
            }
        });
    });

    // ============================================================
    // 8. Clone → unlink → predictions should be unlinked as user type
    // ============================================================

    describe('Proofreading: clone then unlink user group', function () {

        it('unlinking cloned user group creates user-type unlinked instances', function () {
            var session = makeSession(3);
            var predGroup = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);
            var fg = session.frameGroups.get(0);

            // Clean clone
            for (var [cn, inst] of predGroup.instances) {
                var ci = fg.instances.get(cn);
                if (ci) { var idx = ci.indexOf(inst); if (idx >= 0) ci.splice(idx, 1); if (ci.length === 0) fg.instances.delete(cn); }
            }
            var trackMap = session.instanceGroups.get(0);
            trackMap.get(0).splice(trackMap.get(0).indexOf(predGroup), 1);

            var unlinkedList = [];
            for (var [cn2, pi] of predGroup.instances) {
                var ui = new Instance(pi.points.map(function (p) { return p ? [p[0], p[1]] : null; }), 0, 'user', 1.0);
                unlinkedList.push(session.addUnlinkedInstance(0, cn2, ui));
            }
            var userGroup = session.createGroupFromUnlinked(0, unlinkedList, 0);

            // Now unlink
            var newUnlinked = session.unlinkGroup(0, userGroup);

            assertEqual(getGroups(session, 0).length, 0, 'No linked groups');
            assertEqual(newUnlinked.length, 3, '3 unlinked created');

            for (var i = 0; i < newUnlinked.length; i++) {
                assertEqual(newUnlinked[i].instance.type, 'user',
                    'Unlinked #' + i + ' is user type, not predicted');
            }

            assertEqual(countUnlinked(fg), 3, 'FrameGroup has 3 unlinked');
            assertEqual(countFrameGroupInstances(fg), 0, 'No linked instances');
        });
    });

    // ============================================================
    // 9. Unlinked predicted → double-click convert → still re-convertible
    // ============================================================

    describe('Proofreading: convert unlinked prediction to user', function () {

        it('converting replaces predicted unlinked with user unlinked', function () {
            var session = makeSession(2);
            var group = makePredictedGroup(session, 0, ['camA', 'camB']);
            var unlinked = session.unlinkGroup(0, group);
            var fg = session.frameGroups.get(0);

            // Convert first unlinked prediction to user (simulate onConvertUnlinkedPredictions)
            var pred = unlinked[0];
            var clonedPts = pred.instance.points.map(function (p) { return p ? [p[0], p[1]] : null; });
            var userInst = new Instance(clonedPts, pred.instance.trackIdx, 'user', 1.0);
            userInst.modified = true;
            var newUl = session.addUnlinkedInstance(0, pred.cameraName, userInst);
            fg.removeUnlinkedById(pred.id);

            // Should have 1 user unlinked + 1 predicted unlinked
            var totalUnlinked = countUnlinked(fg);
            assertEqual(totalUnlinked, 2, '2 total unlinked');

            // Check types
            var types = [];
            for (var [, ulArr] of fg.unlinkedInstances) {
                for (var j = 0; j < ulArr.length; j++) {
                    types.push(ulArr[j].instance.type);
                }
            }
            types.sort();
            assertDeepEqual(types, ['predicted', 'user'], 'One predicted, one user');
        });

        it('remaining predicted unlinked can still be converted', function () {
            var session = makeSession(2);
            var group = makePredictedGroup(session, 0, ['camA', 'camB']);
            var unlinked = session.unlinkGroup(0, group);
            var fg = session.frameGroups.get(0);

            // Convert first
            var pred0 = unlinked[0];
            var ui0 = new Instance(pred0.instance.points.map(function (p) { return p ? [p[0], p[1]] : null; }), 0, 'user', 1.0);
            session.addUnlinkedInstance(0, pred0.cameraName, ui0);
            fg.removeUnlinkedById(pred0.id);

            // Second should still be predicted and convertible
            var remaining = [];
            for (var [, ulArr] of fg.unlinkedInstances) {
                for (var j = 0; j < ulArr.length; j++) {
                    if (ulArr[j].instance.type === 'predicted') remaining.push(ulArr[j]);
                }
            }
            assertEqual(remaining.length, 1, 'One predicted remains');

            // Convert second
            var pred1 = remaining[0];
            var ui1 = new Instance(pred1.instance.points.map(function (p) { return p ? [p[0], p[1]] : null; }), 0, 'user', 1.0);
            session.addUnlinkedInstance(0, pred1.cameraName, ui1);
            fg.removeUnlinkedById(pred1.id);

            // All should be user now
            for (var [, ulArr2] of fg.unlinkedInstances) {
                for (var k = 0; k < ulArr2.length; k++) {
                    assertEqual(ulArr2[k].instance.type, 'user', 'All converted to user');
                }
            }
        });
    });

    // ============================================================
    // 10. Clone → delete user → no re-double-clickable predictions remain
    // ============================================================

    describe('Proofreading: clone + delete should not leave ghost predictions', function () {

        it('after clone + delete, FrameGroup has no predicted instances', function () {
            var session = makeSession(3);
            var predGroup = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);
            var fg = session.frameGroups.get(0);

            // Clean clone: remove predicted from both structures
            for (var [cn, inst] of predGroup.instances) {
                var ci = fg.instances.get(cn);
                if (ci) { var idx = ci.indexOf(inst); if (idx >= 0) ci.splice(idx, 1); if (ci.length === 0) fg.instances.delete(cn); }
            }
            var trackMap = session.instanceGroups.get(0);
            trackMap.get(0).splice(trackMap.get(0).indexOf(predGroup), 1);

            var unlinkedList = [];
            for (var [cn2, pi] of predGroup.instances) {
                var ui = new Instance(pi.points.map(function (p) { return p ? [p[0], p[1]] : null; }), 0, 'user', 1.0);
                unlinkedList.push(session.addUnlinkedInstance(0, cn2, ui));
            }
            var userGroup = session.createGroupFromUnlinked(0, unlinkedList, 0);

            // Delete user group
            session.removeInstanceGroup(0, userGroup);

            // Verify NO predicted instances exist anywhere
            fg = session.frameGroups.get(0);
            if (fg) {
                for (var [cn3, insts] of fg.instances) {
                    for (var j = 0; j < insts.length; j++) {
                        assertFalse(insts[j].type === 'predicted',
                            'No predicted ghost in linked instances for ' + cn3);
                    }
                }
                for (var [cn4, ulArr] of fg.unlinkedInstances) {
                    for (var k = 0; k < ulArr.length; k++) {
                        assertFalse(ulArr[k].instance.type === 'predicted',
                            'No predicted ghost in unlinked for ' + cn4);
                    }
                }
            }
        });
    });

    // ============================================================
    // 11. Clone → unlink → delete individual → re-link remaining
    // ============================================================

    describe('Proofreading: complex unlink-delete-relink workflow', function () {

        it('clone → unlink → delete one → re-group remaining', function () {
            var session = makeSession(3);
            var predGroup = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);
            var fg = session.frameGroups.get(0);

            // Clean clone
            for (var [cn, inst] of predGroup.instances) {
                var ci = fg.instances.get(cn);
                if (ci) { var idx = ci.indexOf(inst); if (idx >= 0) ci.splice(idx, 1); if (ci.length === 0) fg.instances.delete(cn); }
            }
            var tm = session.instanceGroups.get(0);
            tm.get(0).splice(tm.get(0).indexOf(predGroup), 1);

            var ulList = [];
            for (var [cn2, pi] of predGroup.instances) {
                var ui = new Instance(pi.points.map(function (p) { return p ? [p[0], p[1]] : null; }), 0, 'user', 1.0);
                ulList.push(session.addUnlinkedInstance(0, cn2, ui));
            }
            var userGroup = session.createGroupFromUnlinked(0, ulList, 0);

            // Unlink the user group
            var newUnlinked = session.unlinkGroup(0, userGroup);
            assertEqual(newUnlinked.length, 3, '3 unlinked after unlink');

            // Delete one unlinked (camA)
            var toDelete = newUnlinked.find(function (u) { return u.cameraName === 'camA'; });
            fg.removeUnlinkedById(toDelete.id);
            assertEqual(countUnlinked(fg), 2, '2 unlinked after delete');

            // Re-group remaining 2
            var remaining = [];
            for (var [, ulArr] of fg.unlinkedInstances) {
                for (var j = 0; j < ulArr.length; j++) remaining.push(ulArr[j]);
            }
            assertEqual(remaining.length, 2, '2 remaining for re-group');

            var newGroup2 = session.createGroupFromUnlinked(0, remaining, 0);
            assertEqual(newGroup2.cameraNames.length, 2, 'New group has 2 cameras');
            assertEqual(getGroups(session, 0).length, 1, '1 group total');
            assertEqual(countUnlinked(fg), 0, 'No unlinked remain');
            assertEqual(countFrameGroupInstances(fg), 2, '2 linked instances');
        });
    });

    // ============================================================
    // 12. _convertToUserInstance changes all instances in group
    // ============================================================

    describe('Proofreading: _convertToUserInstance in-place conversion', function () {

        it('converts all predicted instances to user in-place', function () {
            var session = makeSession(3);
            var group = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);
            var fg = session.frameGroups.get(0);

            // Get original instance references
            var origInstA = group.getInstance('camA');
            var origInstB = group.getInstance('camB');

            // Simulate _convertToUserInstance
            for (var [, inst] of group.instances) {
                if (inst.type === 'predicted') {
                    inst.points = inst.points.map(function (pt) { return pt ? [pt[0], pt[1]] : null; });
                    inst.type = 'user';
                    inst.modified = true;
                }
            }

            // Same objects, but type changed
            assertEqual(group.getInstance('camA'), origInstA, 'Same object reference');
            assertEqual(origInstA.type, 'user', 'Type changed to user');
            assertEqual(origInstB.type, 'user', 'Type changed to user');

            // FrameGroup instances are the same objects, so they also reflect the change
            var fgInstA = fg.getInstances('camA');
            assertTrue(fgInstA.length > 0, 'camA still in FrameGroup');
            assertEqual(fgInstA[0].type, 'user', 'FrameGroup instance also shows user');
        });
    });

    // ============================================================
    // 13. InteractionManager _deleteSelected with per-camera
    // ============================================================

    describe('Proofreading: InteractionManager per-camera delete', function () {

        it('per-camera delete removes from group and FrameGroup', function () {
            var session = makeSession(3);
            var group = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);
            // Convert to user so they're editable
            for (var [, inst] of group.instances) { inst.type = 'user'; }

            var ctx = makeManager(session, 0);
            ctx.manager.lastInteractedView = 'camA';
            ctx.manager.select(group, 0);
            ctx.manager._deleteSelected(false); // per-camera, not deleteAll

            assertEqual(group.cameraNames.length, 2, 'Group has 2 cameras');
            assertNull(group.getInstance('camA'), 'camA removed');
            assertNotNull(group.getInstance('camB'), 'camB remains');
            assertNotNull(group.getInstance('camC'), 'camC remains');

            var fg = session.frameGroups.get(0);
            assertEqual(countFrameGroupInstances(fg), 2, 'FrameGroup has 2 instances');

            cleanup(ctx);
        });

        it('per-camera delete of last camera removes entire group', function () {
            var session = makeSession(1);
            var group = makePredictedGroup(session, 0, ['camA']);
            for (var [, inst] of group.instances) { inst.type = 'user'; }

            var ctx = makeManager(session, 0);
            ctx.manager.lastInteractedView = 'camA';
            ctx.manager.select(group, 0);
            ctx.manager._deleteSelected(false);

            assertEqual(getGroups(session, 0).length, 0, 'Group removed');
            cleanup(ctx);
        });

        it('deleteAll removes entire group regardless of view', function () {
            var session = makeSession(3);
            var group = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);

            var ctx = makeManager(session, 0);
            ctx.manager.lastInteractedView = 'camA';
            ctx.manager.select(group, 0);
            ctx.manager._deleteSelected(true);

            assertEqual(getGroups(session, 0).length, 0, 'Group removed entirely');
            var fg = session.frameGroups.get(0);
            if (fg) {
                assertEqual(countFrameGroupInstances(fg), 0, 'FrameGroup cleared');
            }
            cleanup(ctx);
        });
    });

    // ============================================================
    // 14. InteractionManager _unlinkSelectedGroup
    // ============================================================

    describe('Proofreading: InteractionManager unlink group', function () {

        it('unlinking creates unlinked instances preserving type', function () {
            var session = makeSession(2);
            var group = makePredictedGroup(session, 0, ['camA', 'camB']);
            for (var [, inst] of group.instances) { inst.type = 'user'; }

            var ctx = makeManager(session, 0);
            ctx.manager.select(group, 0);
            ctx.manager._unlinkSelectedGroup();

            assertEqual(getGroups(session, 0).length, 0, 'No groups');
            var fg = session.frameGroups.get(0);
            assertEqual(countUnlinked(fg), 2, '2 unlinked');

            for (var [, ulArr] of fg.unlinkedInstances) {
                for (var j = 0; j < ulArr.length; j++) {
                    assertEqual(ulArr[j].instance.type, 'user', 'Unlinked preserved user type');
                }
            }

            cleanup(ctx);
        });

        it('selection is cleared after unlink', function () {
            var session = makeSession(2);
            var group = makePredictedGroup(session, 0, ['camA', 'camB']);

            var ctx = makeManager(session, 0);
            ctx.manager.select(group, 0);
            assertNotNull(ctx.manager.selectedInstanceGroup, 'Selected before unlink');

            ctx.manager._unlinkSelectedGroup();
            assertNull(ctx.manager.selectedInstanceGroup, 'Cleared after unlink');

            cleanup(ctx);
        });
    });

    // ============================================================
    // 15. Full round-trip: predicted → clone → edit → unlink → delete some → re-group
    // ============================================================

    describe('Proofreading: full round-trip workflow', function () {

        it('predicted → clone → unlink → delete 1 → re-group → verify types', function () {
            var session = makeSession(3);
            var predGroup = makePredictedGroup(session, 0, ['camA', 'camB', 'camC']);
            var fg = session.frameGroups.get(0);

            // Step 1: Clone predicted group (with proper cleanup)
            for (var [cn, inst] of predGroup.instances) {
                var ci = fg.instances.get(cn);
                if (ci) { var idx = ci.indexOf(inst); if (idx >= 0) ci.splice(idx, 1); if (ci.length === 0) fg.instances.delete(cn); }
            }
            var tm = session.instanceGroups.get(0);
            tm.get(0).splice(tm.get(0).indexOf(predGroup), 1);

            var ulList = [];
            for (var [cn2, pi] of predGroup.instances) {
                var ui = new Instance(pi.points.map(function (p) { return p ? [p[0], p[1]] : null; }), 0, 'user', 1.0);
                ui.modified = true;
                ulList.push(session.addUnlinkedInstance(0, cn2, ui));
            }
            var userGroup = session.createGroupFromUnlinked(0, ulList, 0);
            assertEqual(getGroups(session, 0).length, 1, 'Step 1: 1 user group');

            // Step 2: Edit a point
            var instA = userGroup.getInstance('camA');
            instA.points[0] = [150, 250];
            assertEqual(instA.points[0][0], 150, 'Step 2: point edited');

            // Step 3: Unlink
            var unlinked = session.unlinkGroup(0, userGroup);
            assertEqual(unlinked.length, 3, 'Step 3: 3 unlinked');
            assertEqual(getGroups(session, 0).length, 0, 'Step 3: no groups');

            // Step 4: Delete camC
            var ulC = unlinked.find(function (u) { return u.cameraName === 'camC'; });
            fg.removeUnlinkedById(ulC.id);
            assertEqual(countUnlinked(fg), 2, 'Step 4: 2 unlinked');

            // Step 5: Re-group remaining
            var remaining = [];
            for (var [, ulArr] of fg.unlinkedInstances) {
                for (var j = 0; j < ulArr.length; j++) remaining.push(ulArr[j]);
            }
            var finalGroup = session.createGroupFromUnlinked(0, remaining, 0);

            // Verify final state
            assertEqual(getGroups(session, 0).length, 1, 'Step 5: 1 group');
            assertEqual(finalGroup.cameraNames.length, 2, 'Step 5: 2 cameras');
            for (var [, fi] of finalGroup.instances) {
                assertEqual(fi.type, 'user', 'All instances are user type');
            }
            assertEqual(countUnlinked(fg), 0, 'No unlinked remain');
            assertEqual(countFrameGroupInstances(fg), 2, 'FrameGroup has 2 instances');

            // The edited point should be preserved
            var finalA = finalGroup.getInstance('camA');
            assertNotNull(finalA, 'camA in final group');
            assertEqual(finalA.points[0][0], 150, 'Edited point preserved');
        });
    });

    // ============================================================
    // 16. Multiple groups on same frame don't interfere
    // ============================================================

    describe('Proofreading: multiple groups independence', function () {

        it('deleting one group does not affect another on same frame', function () {
            var session = makeSession(3);
            // Group 1 on track 0
            var g1 = makePredictedGroup(session, 0, ['camA', 'camB']);
            // Group 2 on track 1
            var fg = session.frameGroups.get(0);
            var g2 = new InstanceGroup(Date.now() + 999, 1);
            var i2a = new Instance([[10, 20], [30, 40]], 1, 'user', 1.0);
            var i2b = new Instance([[50, 60], [70, 80]], 1, 'user', 1.0);
            g2.addInstance('camA', i2a);
            g2.addInstance('camC', i2b);
            fg.addInstance('camA', i2a);
            fg.addInstance('camC', i2b);
            var tm = session.instanceGroups.get(0);
            tm.set(1, [g2]);

            assertEqual(getGroups(session, 0).length, 2, '2 groups initially');

            // Delete group 1
            session.removeInstanceGroup(0, g1);

            assertEqual(getGroups(session, 0).length, 1, '1 group remains');
            assertEqual(getGroups(session, 0)[0], g2, 'Group 2 survives');

            // Group 2's instances still in FrameGroup
            assertTrue(fg.getInstances('camA').indexOf(i2a) >= 0, 'g2 camA in FrameGroup');
            assertTrue(fg.getInstances('camC').indexOf(i2b) >= 0, 'g2 camC in FrameGroup');

            // Group 1's instances should be gone from FrameGroup
            var camAInsts = fg.getInstances('camA');
            for (var k = 0; k < camAInsts.length; k++) {
                assertFalse(camAInsts[k].type === 'predicted',
                    'No predicted from g1 in camA');
            }
        });
    });

    // ============================================================
    // 17. Double-click type guard: only predicted groups are clonable
    // ============================================================

    describe('Proofreading: double-click type guard', function () {

        it('user-type group instances should not trigger clone', function () {
            var session = makeSession(2);
            var group = makePredictedGroup(session, 0, ['camA', 'camB']);
            // Convert to user
            for (var [, inst] of group.instances) { inst.type = 'user'; }

            // Check the condition used in interaction.js
            var firstInst = group.instances.values().next().value;
            assertFalse(firstInst.type === 'predicted',
                'User group should not pass predicted check');
        });

        it('predicted group passes the clone guard', function () {
            var session = makeSession(2);
            var group = makePredictedGroup(session, 0, ['camA', 'camB']);

            var firstInst = group.instances.values().next().value;
            assertTrue(firstInst.type === 'predicted',
                'Predicted group should pass clone check');
        });
    });

    // ============================================================
    // 18. Reprojection instances don't leak across operations
    // ============================================================

    describe('Proofreading: reprojection cleanup', function () {

        it('reprojectedInstances cleared after group deletion', function () {
            var session = makeSession(2);
            var group = makePredictedGroup(session, 0, ['camA', 'camB']);

            // Simulate having reprojections
            group.addReprojectedInstance('camA', new Instance([[1, 2], [3, 4]], 0, 'reprojected', 1));
            group.addReprojectedInstance('camB', new Instance([[5, 6], [7, 8]], 0, 'reprojected', 1));
            assertEqual(group.reprojectedInstances.size, 2, 'Has reprojections');

            session.removeInstanceGroup(0, group);

            // Group object still has reprojections (it's not nulled), but it's
            // no longer in the session, so they won't render.
            assertEqual(getGroups(session, 0).length, 0, 'Group removed');
        });

        it('reprojectedInstances reset on re-triangulation', function () {
            var session = makeSession(2);
            var group = makePredictedGroup(session, 0, ['camA', 'camB']);

            group.addReprojectedInstance('camA', new Instance([[1, 2], [3, 4]], 0, 'reprojected', 1));
            group.addReprojectedInstance('camB', new Instance([[5, 6], [7, 8]], 0, 'reprojected', 1));

            // Clear as storeReprojectedInstances now does
            group.reprojectedInstances.clear();
            assertEqual(group.reprojectedInstances.size, 0, 'Cleared');

            // Re-add for one camera only
            group.addReprojectedInstance('camA', new Instance([[9, 10], [11, 12]], 0, 'reprojected', 1));
            assertEqual(group.reprojectedInstances.size, 1, 'Only 1 after selective re-add');
        });
    });

})();
