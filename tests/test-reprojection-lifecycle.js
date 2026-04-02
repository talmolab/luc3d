/**
 * test-reprojection-lifecycle.js — Tests for reprojection creation, update,
 * and display lifecycle during the proofreading workflow.
 */

(function () {
    const { describe, it, assertEqual, assertNotNull, assertNull, assertTrue, assertFalse } = TestFramework;

    function makeCamera(name) {
        return new Camera(
            name,
            [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0],
            [0.1, 0.2, 0.3],
            [10, 20, 30],
            [640, 480]
        );
    }

    function makeSkeleton() {
        return new Skeleton('test', ['head', 'body', 'tail'], [[0, 1], [1, 2]]);
    }

    function makeInstance(points, trackIdx, type) {
        return new Instance(
            points || [[100, 200], [150, 250], [200, 300]],
            trackIdx || 0,
            type || 'predicted',
            1.0
        );
    }

    // ---- InstanceGroup reprojection storage ----

    describe('InstanceGroup reprojectedInstances Map', function () {
        it('stores one reprojection per camera name', function () {
            var group = new InstanceGroup(1, 0);
            var reproj1 = makeInstance(null, 0, 'reprojected');
            var reproj2 = makeInstance([[10, 20], [30, 40], [50, 60]], 0, 'reprojected');

            group.addReprojectedInstance('CamA', reproj1);
            group.addReprojectedInstance('CamA', reproj2); // overwrites

            assertEqual(group.reprojectedInstances.size, 1, 'should have exactly 1 entry for CamA');
            var stored = group.getReprojectedInstance('CamA');
            assertEqual(stored, reproj2, 'should be the second (overwritten) instance');
        });

        it('stores separate reprojections per camera', function () {
            var group = new InstanceGroup(1, 0);
            group.addReprojectedInstance('CamA', makeInstance(null, 0, 'reprojected'));
            group.addReprojectedInstance('CamB', makeInstance(null, 0, 'reprojected'));
            group.addReprojectedInstance('CamC', makeInstance(null, 0, 'reprojected'));

            assertEqual(group.reprojectedInstances.size, 3);
            assertNotNull(group.getReprojectedInstance('CamA'));
            assertNotNull(group.getReprojectedInstance('CamB'));
            assertNotNull(group.getReprojectedInstance('CamC'));
        });

        it('getReprojectedInstance returns null for missing camera', function () {
            var group = new InstanceGroup(1, 0);
            group.addReprojectedInstance('CamA', makeInstance(null, 0, 'reprojected'));

            assertNull(group.getReprojectedInstance('CamX'));
        });

        it('in-place update preserves Map size', function () {
            var group = new InstanceGroup(1, 0);
            var original = makeInstance([[10, 20], [30, 40], [50, 60]], 0, 'reprojected');
            group.addReprojectedInstance('CamA', original);

            // Simulate in-place update (what storeReprojectedInstances does)
            var existing = group.getReprojectedInstance('CamA');
            existing.points = [[11, 21], [31, 41], [51, 61]];

            assertEqual(group.reprojectedInstances.size, 1, 'size should not change');
            assertEqual(group.getReprojectedInstance('CamA').points[0][0], 11, 'points should be updated');
        });
    });

    // ---- Group-by-track creates one group per track ----

    describe('Group-by-track produces one group per track', function () {
        it('two tracks produce two groups', function () {
            var session = new Session(
                [makeCamera('CamA'), makeCamera('CamB')],
                makeSkeleton(),
                ['track_0', 'track_1']
            );

            var fg = new FrameGroup(0);
            fg.addInstance('CamA', makeInstance(null, 0, 'predicted'));
            fg.addInstance('CamA', makeInstance(null, 1, 'predicted'));
            fg.addInstance('CamB', makeInstance(null, 0, 'predicted'));
            fg.addInstance('CamB', makeInstance(null, 1, 'predicted'));
            session.addFrameGroup(fg);

            // Simulate group-by-track
            var trackBuckets = {};
            for (var [camName, instances] of fg.instances) {
                for (var i = 0; i < instances.length; i++) {
                    var tid = instances[i].trackIdx;
                    if (!trackBuckets[tid]) trackBuckets[tid] = {};
                    if (!trackBuckets[tid][camName]) trackBuckets[tid][camName] = instances[i];
                }
            }

            var groups = [];
            for (var tidStr in trackBuckets) {
                var trackIdx = parseInt(tidStr);
                var bucket = trackBuckets[trackIdx];
                var camNames = Object.keys(bucket);
                var group = new InstanceGroup(Date.now() + trackIdx, trackIdx);
                for (var ci = 0; ci < camNames.length; ci++) {
                    group.addInstance(camNames[ci], bucket[camNames[ci]]);
                }
                groups.push(group);
            }

            assertEqual(groups.length, 2, 'should have 2 groups');
            assertEqual(groups[0].identityId, 0);
            assertEqual(groups[1].identityId, 1);
        });
    });

    // ---- Adding user instance to existing group ----

    describe('Adding user instance from reprojection to existing group', function () {
        it('user instance is added to the same group, not a new one', function () {
            var group = new InstanceGroup(1, 0);
            group.addInstance('CamA', makeInstance(null, 0, 'predicted'));
            group.addInstance('CamB', makeInstance(null, 0, 'predicted'));

            // Simulate reprojection exists for CamC (excluded from triangulation)
            var reproj = makeInstance([[50, 60], [70, 80], [90, 100]], 0, 'reprojected');
            group.addReprojectedInstance('CamC', reproj);

            // User double-clicks reprojection in CamC → add user instance to same group
            var userInst = new Instance(
                reproj.points.map(function (p) { return p ? [p[0], p[1]] : null; }),
                0, 'user', 1.0
            );
            group.addInstance('CamC', userInst);

            // Same group now has 3 cameras
            assertEqual(group.cameraNames.length, 3, 'group should have 3 cameras');
            var camCInst = group.getInstance('CamC');
            assertNotNull(camCInst, 'CamC should have an instance');
            assertEqual(camCInst.type, 'user', 'CamC instance should be user type');
        });

        it('reprojection should not be shown when view has grouped instance', function () {
            var group = new InstanceGroup(1, 0);
            group.addInstance('CamA', makeInstance(null, 0, 'predicted'));
            group.addInstance('CamB', makeInstance(null, 0, 'predicted'));

            // Add reprojections for all cameras
            group.addReprojectedInstance('CamA', makeInstance(null, 0, 'reprojected'));
            group.addReprojectedInstance('CamB', makeInstance(null, 0, 'reprojected'));
            group.addReprojectedInstance('CamC', makeInstance(null, 0, 'reprojected'));

            // CamA and CamB have grouped instances → should NOT show reprojection
            // CamC has no grouped instance → SHOULD show reprojection
            var hasGroupedA = group.getInstance('CamA');
            var hasGroupedB = group.getInstance('CamB');
            var hasGroupedC = group.getInstance('CamC');

            assertTrue(!!hasGroupedA, 'CamA has grouped instance');
            assertTrue(!!hasGroupedB, 'CamB has grouped instance');
            assertNull(hasGroupedC, 'CamC has no grouped instance');

            // Rendering rule: only show reprojection if !hasGroupedInst
            var showReprojA = !hasGroupedA;
            var showReprojB = !hasGroupedB;
            var showReprojC = !hasGroupedC;

            assertFalse(showReprojA, 'should NOT show reproj for CamA (has grouped)');
            assertFalse(showReprojB, 'should NOT show reproj for CamB (has grouped)');
            assertTrue(showReprojC, 'SHOULD show reproj for CamC (no grouped)');
        });

        it('after adding user instance to CamC, reprojection hides for CamC too', function () {
            var group = new InstanceGroup(1, 0);
            group.addInstance('CamA', makeInstance(null, 0, 'predicted'));
            group.addInstance('CamB', makeInstance(null, 0, 'predicted'));
            group.addReprojectedInstance('CamC', makeInstance(null, 0, 'reprojected'));

            // Before: CamC shows reprojection
            assertNull(group.getInstance('CamC'));
            assertTrue(!!group.getReprojectedInstance('CamC'), 'CamC has reprojection before');

            // User adds instance to CamC
            group.addInstance('CamC', makeInstance(null, 0, 'user'));

            // After: CamC has grouped instance → reprojection should not render
            var hasGrouped = group.getInstance('CamC');
            assertTrue(!!hasGrouped, 'CamC now has grouped instance');
            // Rendering rule: !hasGroupedInst → false, so reproj hidden
            assertFalse(!hasGrouped, 'reproj should be hidden for CamC');
        });
    });

    // ---- Re-triangulation updates reprojections ----

    describe('Re-triangulation reprojection lifecycle', function () {
        it('reprojectedInstances Map is updated in-place, not duplicated', function () {
            var group = new InstanceGroup(1, 0);

            // Initial reprojections
            group.addReprojectedInstance('CamA', makeInstance([[10, 20], [30, 40], [50, 60]], 0, 'reprojected'));
            group.addReprojectedInstance('CamB', makeInstance([[15, 25], [35, 45], [55, 65]], 0, 'reprojected'));
            assertEqual(group.reprojectedInstances.size, 2);

            // Simulate re-triangulation: update existing
            var existingA = group.getReprojectedInstance('CamA');
            existingA.points = [[11, 21], [31, 41], [51, 61]];

            var existingB = group.getReprojectedInstance('CamB');
            existingB.points = [[16, 26], [36, 46], [56, 66]];

            // Still 2, not 4
            assertEqual(group.reprojectedInstances.size, 2, 'should still be 2 after update');
            assertEqual(group.getReprojectedInstance('CamA').points[0][0], 11);
            assertEqual(group.getReprojectedInstance('CamB').points[0][0], 16);
        });

        it('new camera reprojection is added during re-triangulation', function () {
            var group = new InstanceGroup(1, 0);
            group.addReprojectedInstance('CamA', makeInstance(null, 0, 'reprojected'));
            assertEqual(group.reprojectedInstances.size, 1);

            // Re-triangulation adds CamB reprojection
            group.addReprojectedInstance('CamB', makeInstance(null, 0, 'reprojected'));
            assertEqual(group.reprojectedInstances.size, 2);
        });
    });

    // ---- Track finding for double-click ----

    describe('Finding existing group by trackIdx', function () {
        it('finds predicted group by trackIdx', function () {
            var groups = [
                new InstanceGroup(1, 0),
                new InstanceGroup(2, 1),
            ];
            groups[0].addInstance('CamA', makeInstance(null, 0, 'predicted'));
            groups[1].addInstance('CamA', makeInstance(null, 1, 'predicted'));

            // Find group with trackIdx 1
            var found = null;
            for (var i = 0; i < groups.length; i++) {
                if (groups[i].identityId === 1) { found = groups[i]; break; }
            }

            assertNotNull(found, 'should find group with identityId 1');
            assertEqual(found.identityId, 1);
        });

        it('finds group regardless of instance type', function () {
            var group = new InstanceGroup(1, 0);
            group.addInstance('CamA', makeInstance(null, 0, 'predicted'));

            // Search should find it even though it's predicted
            var found = (group.identityId === 0) ? group : null;
            assertNotNull(found, 'should find predicted group by identityId');
        });
    });

    // ---- No duplicate groups after reprojection-to-user workflow ----

    describe('No duplicate groups in reprojection-to-user workflow', function () {
        it('converting reprojection to user label stays in same group', function () {
            var session = new Session(
                [makeCamera('CamA'), makeCamera('CamB'), makeCamera('CamC')],
                makeSkeleton(),
                ['track_0']
            );

            // Create group with CamA, CamB (predicted) + reprojection for CamC
            var fg = new FrameGroup(0);
            session.addFrameGroup(fg);

            var group = new InstanceGroup(1, 0);
            var instA = makeInstance(null, 0, 'predicted');
            var instB = makeInstance(null, 0, 'predicted');
            group.addInstance('CamA', instA);
            group.addInstance('CamB', instB);
            fg.addInstance('CamA', instA);
            fg.addInstance('CamB', instB);

            if (!session.instanceGroups.has(0)) session.instanceGroups.set(0, []);
            session.instanceGroups.get(0).push(group);

            group.addReprojectedInstance('CamC', makeInstance([[50, 60], [70, 80], [90, 100]], 0, 'reprojected'));

            // Count groups before
            var groupsBefore = session.getInstanceGroupsForFrame(0);
            assertEqual(groupsBefore.length, 1, 'should have 1 group before');

            // Simulate double-click: find existing group, add user instance
            var existingGroup = null;
            for (var i = 0; i < groupsBefore.length; i++) {
                if (groupsBefore[i].identityId === 0) { existingGroup = groupsBefore[i]; break; }
            }
            assertNotNull(existingGroup);

            var userInst = new Instance([[50, 60], [70, 80], [90, 100]], 0, 'user', 1.0);
            existingGroup.addInstance('CamC', userInst);
            fg.addInstance('CamC', userInst);

            // Count groups after — should still be 1
            var groupsAfter = session.getInstanceGroupsForFrame(0);
            assertEqual(groupsAfter.length, 1, 'should STILL have 1 group after');
            assertEqual(groupsAfter[0].cameraNames.length, 3, 'group should now have 3 cameras');
        });
    });

})();
