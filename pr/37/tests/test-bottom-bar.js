/**
 * test-bottom-bar.js - Tests for per-camera bottom bar counter logic.
 *
 * Tests the counting rules for Labeled Frames, Instances, and Triangulated
 * that drive the status bar. Since updateFrameCounters() is embedded in
 * index.html and depends on DOM/state, we replicate and test the counting
 * logic directly against the data model.
 */

(function () {
    var describe    = TestFramework.describe;
    var it          = TestFramework.it;
    var beforeEach  = TestFramework.beforeEach;
    var assertEqual = TestFramework.assertEqual;
    var assertTrue  = TestFramework.assertTrue;

    // Replicate the counting logic from updateFrameCounters
    function computeCounters(session, activeCam) {
        var labeledCount = 0;
        var instanceCount = 0;
        var triangulatedCount = 0;

        session.frameGroups.forEach(function (fg, frameIdx) {
            var hasLabeled = false;
            if (activeCam) {
                var camInstances = fg.instances.get(activeCam) || [];
                for (var i = 0; i < camInstances.length; i++) {
                    var t = camInstances[i].type || 'user';
                    if (t === 'user') {
                        hasLabeled = true;
                        instanceCount++;
                    } else if (t === 'predicted') {
                        hasLabeled = true;
                    }
                }
                var ulInstances = fg.getUnlinkedInstances(activeCam);
                for (var u = 0; u < ulInstances.length; u++) {
                    var ulType = ulInstances[u].instance.type || 'user';
                    if (ulType === 'user') {
                        hasLabeled = true;
                        instanceCount++;
                    }
                }
            }
            if (hasLabeled) labeledCount++;

            var trackMap = session.instanceGroups.get(frameIdx);
            if (trackMap) {
                outer:
                for (var groups of trackMap.values()) {
                    for (var g = 0; g < groups.length; g++) {
                        if (groups[g].points3d) { triangulatedCount++; break outer; }
                    }
                }
            }
        });

        return { labeled: labeledCount, instances: instanceCount, triangulated: triangulatedCount };
    }

    // ============================================
    // Helpers
    // ============================================

    function makeSession() {
        var skeleton = new Skeleton('test', ['nose', 'head'], [[0, 1]]);
        var cameras = [
            new Camera('cam1', [[600,0,320],[0,600,240],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            new Camera('cam2', [[600,0,320],[0,600,240],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
        ];
        return new Session(cameras, skeleton, ['track_0']);
    }

    // ============================================
    // Tests
    // ============================================

    describe('Bottom bar - empty session', function () {
        it('returns zeros for empty session', function () {
            var session = makeSession();
            var c = computeCounters(session, 'cam1');
            assertEqual(c.labeled, 0, 'no labeled frames');
            assertEqual(c.instances, 0, 'no instances');
            assertEqual(c.triangulated, 0, 'no triangulated');
        });

        it('returns zeros when activeCam is null', function () {
            var session = makeSession();
            var fg = new FrameGroup(0);
            var inst = new Instance([[100,100],[200,200]], 0, 'user', 1);
            fg.addInstance('cam1', inst);
            session.addFrameGroup(fg);

            var c = computeCounters(session, null);
            assertEqual(c.labeled, 0, 'null camera sees no labels');
            assertEqual(c.instances, 0, 'null camera sees no instances');
        });
    });

    describe('Bottom bar - labeled frames counting', function () {
        it('counts frame with grouped UserInstance as labeled', function () {
            var session = makeSession();
            var fg = new FrameGroup(0);
            var inst = new Instance([[100,100],[200,200]], 0, 'user', 1);
            fg.addInstance('cam1', inst);
            session.addFrameGroup(fg);

            var c = computeCounters(session, 'cam1');
            assertEqual(c.labeled, 1, '1 labeled frame');
            assertEqual(c.instances, 1, '1 user instance');
        });

        it('counts frame with grouped PredictedInstance as labeled but not as instance', function () {
            var session = makeSession();
            var fg = new FrameGroup(0);
            var inst = new Instance([[100,100],[200,200]], 0, 'predicted', 0.9);
            fg.addInstance('cam1', inst);
            session.addFrameGroup(fg);

            var c = computeCounters(session, 'cam1');
            assertEqual(c.labeled, 1, 'predicted counts as labeled');
            assertEqual(c.instances, 0, 'predicted not counted as instance');
        });

        it('counts frame with ungrouped UserInstance as labeled', function () {
            var session = makeSession();
            var inst = new Instance([[100,100],[200,200]], 0, 'user', 1);
            session.addUnlinkedInstance(0, 'cam1', inst);

            var c = computeCounters(session, 'cam1');
            assertEqual(c.labeled, 1, 'unlinked user counts as labeled');
            assertEqual(c.instances, 1, 'unlinked user counted as instance');
        });

        it('increments labeled by at most 1 per frame regardless of instance count', function () {
            var session = makeSession();
            var fg = new FrameGroup(0);
            fg.addInstance('cam1', new Instance([[100,100],[200,200]], 0, 'user', 1));
            fg.addInstance('cam1', new Instance([[300,300],[400,400]], 0, 'user', 1));
            session.addFrameGroup(fg);
            // Also add an unlinked one
            session.addUnlinkedInstance(0, 'cam1', new Instance([[50,50],[60,60]], 0, 'user', 1));

            var c = computeCounters(session, 'cam1');
            assertEqual(c.labeled, 1, 'still just 1 labeled frame');
            assertEqual(c.instances, 3, '3 total instances');
        });

        it('does not count instances from other cameras', function () {
            var session = makeSession();
            var fg = new FrameGroup(0);
            fg.addInstance('cam1', new Instance([[100,100],[200,200]], 0, 'user', 1));
            fg.addInstance('cam2', new Instance([[300,300],[400,400]], 0, 'user', 1));
            session.addFrameGroup(fg);

            var c1 = computeCounters(session, 'cam1');
            assertEqual(c1.instances, 1, 'cam1 sees 1 instance');

            var c2 = computeCounters(session, 'cam2');
            assertEqual(c2.instances, 1, 'cam2 sees 1 instance');
        });
    });

    describe('Bottom bar - instances counting', function () {
        it('counts UserInstances across multiple frames', function () {
            var session = makeSession();

            var fg0 = new FrameGroup(0);
            fg0.addInstance('cam1', new Instance([[100,100],[200,200]], 0, 'user', 1));
            session.addFrameGroup(fg0);

            var fg1 = new FrameGroup(1);
            fg1.addInstance('cam1', new Instance([[110,110],[210,210]], 0, 'user', 1));
            fg1.addInstance('cam1', new Instance([[120,120],[220,220]], 0, 'user', 1));
            session.addFrameGroup(fg1);

            var c = computeCounters(session, 'cam1');
            assertEqual(c.instances, 3, '3 total user instances across 2 frames');
            assertEqual(c.labeled, 2, '2 labeled frames');
        });

        it('does not count PredictedInstances in instance total', function () {
            var session = makeSession();
            var fg = new FrameGroup(0);
            fg.addInstance('cam1', new Instance([[100,100],[200,200]], 0, 'user', 1));
            fg.addInstance('cam1', new Instance([[300,300],[400,400]], 0, 'predicted', 0.8));
            session.addFrameGroup(fg);

            var c = computeCounters(session, 'cam1');
            assertEqual(c.instances, 1, 'only user counted');
        });
    });

    describe('Bottom bar - triangulated counting', function () {
        it('counts frames with triangulated groups', function () {
            var session = makeSession();
            var fg = new FrameGroup(0);
            var inst = new Instance([[100,100],[200,200]], 0, 'user', 1);
            fg.addInstance('cam1', inst);
            session.addFrameGroup(fg);

            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst);
            group.points3d = [[1,2,3],[4,5,6]];
            session.instanceGroups.set(0, new Map([[0, [group]]]));

            var c = computeCounters(session, 'cam1');
            assertEqual(c.triangulated, 1, '1 triangulated frame');
        });

        it('does not count groups without points3d', function () {
            var session = makeSession();
            var fg = new FrameGroup(0);
            var inst = new Instance([[100,100],[200,200]], 0, 'user', 1);
            fg.addInstance('cam1', inst);
            session.addFrameGroup(fg);

            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst);
            group.points3d = null;
            session.instanceGroups.set(0, new Map([[0, [group]]]));

            var c = computeCounters(session, 'cam1');
            assertEqual(c.triangulated, 0, 'no points3d = not triangulated');
        });

        it('triangulated is global (not per-camera)', function () {
            var session = makeSession();

            // Frame 0: group with points3d only in cam2
            var fg = new FrameGroup(0);
            var inst2 = new Instance([[100,100],[200,200]], 0, 'user', 1);
            fg.addInstance('cam2', inst2);
            session.addFrameGroup(fg);

            var group = new InstanceGroup(1, 0);
            group.addInstance('cam2', inst2);
            group.points3d = [[1,2,3],[4,5,6]];
            session.instanceGroups.set(0, new Map([[0, [group]]]));

            // Even when viewing cam1, triangulated should count the frame
            var c = computeCounters(session, 'cam1');
            assertEqual(c.triangulated, 1, 'triangulated is global');
            assertEqual(c.labeled, 0, 'cam1 has no labels');
        });

        it('increments triangulated at most once per frame', function () {
            var session = makeSession();
            var fg = new FrameGroup(0);
            var inst1 = new Instance([[100,100],[200,200]], 0, 'user', 1);
            var inst2 = new Instance([[300,300],[400,400]], 0, 'user', 1);
            fg.addInstance('cam1', inst1);
            fg.addInstance('cam1', inst2);
            session.addFrameGroup(fg);

            var g1 = new InstanceGroup(1, 0);
            g1.addInstance('cam1', inst1);
            g1.points3d = [[1,2,3]];
            var g2 = new InstanceGroup(2, 0);
            g2.addInstance('cam1', inst2);
            g2.points3d = [[4,5,6]];
            session.instanceGroups.set(0, new Map([[0, [g1, g2]]]));

            var c = computeCounters(session, 'cam1');
            assertEqual(c.triangulated, 1, 'at most 1 per frame');
        });
    });

    describe('Bottom bar - per-camera switching', function () {
        it('counters change when switching active camera', function () {
            var session = makeSession();

            var fg = new FrameGroup(0);
            fg.addInstance('cam1', new Instance([[100,100],[200,200]], 0, 'user', 1));
            fg.addInstance('cam1', new Instance([[110,110],[210,210]], 0, 'user', 1));
            fg.addInstance('cam2', new Instance([[300,300],[400,400]], 0, 'user', 1));
            session.addFrameGroup(fg);

            var c1 = computeCounters(session, 'cam1');
            assertEqual(c1.instances, 2, 'cam1 has 2 instances');
            assertEqual(c1.labeled, 1, 'cam1 has 1 labeled frame');

            var c2 = computeCounters(session, 'cam2');
            assertEqual(c2.instances, 1, 'cam2 has 1 instance');
            assertEqual(c2.labeled, 1, 'cam2 has 1 labeled frame');
        });
    });
})();
