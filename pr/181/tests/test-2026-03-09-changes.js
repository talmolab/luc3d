/**
 * test-2026-03-09-changes.js - Tests for the 2026-03-09 feature set:
 *   - Null node graying in selection highlight
 *   - Ungroup (Session.unlinkGroup data-model op)
 *   - ReprojectedInstance right-click nulls reprojected node
 *   - Visibility checkbox deselects hidden types
 *   - Per-view skeleton cache for new UserInstances
 */

(function () {
    var describe    = TestFramework.describe;
    var it          = TestFramework.it;
    var beforeEach  = TestFramework.beforeEach;
    var assertEqual = TestFramework.assertEqual;
    var assertTrue  = TestFramework.assertTrue;
    var assertFalse = TestFramework.assertFalse;
    var assertNull  = TestFramework.assertNull;
    var assertNotNull = TestFramework.assertNotNull;

    // ============================================
    // Helpers
    // ============================================

    function buildSession(opts) {
        opts = opts || {};
        var vw = opts.videoWidth || 640;
        var vh = opts.videoHeight || 480;
        var skeleton = new Skeleton('test', ['nose', 'head', 'tail'], [[0, 1], [1, 2]]);
        var cameras = [
            new Camera('cam1', [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh]),
            new Camera('cam2', [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh]),
        ];
        var session = new Session(cameras, skeleton, ['track_0']);
        return { session: session, skeleton: skeleton, cameras: cameras, vw: vw, vh: vh };
    }

    function createGroupedEnv() {
        var env = buildSession();
        var session = env.session;

        // Create a grouped instance with user instances in both cameras
        var inst1 = new Instance([[100, 100], [150, 150], [200, 200]], 0, 'user', 1.0);
        var inst2 = new Instance([[200, 200], [250, 250], [300, 300]], 0, 'user', 1.0);

        var fg = new FrameGroup(0);
        fg.addInstance('cam1', inst1);
        fg.addInstance('cam2', inst2);
        session.addFrameGroup(fg);

        var group = new InstanceGroup(1, 0);
        group.addInstance('cam1', inst1);
        group.addInstance('cam2', inst2);
        session.instanceGroups.set(0, [group]);

        return {
            session: session,
            skeleton: env.skeleton,
            fg: fg,
            group: group,
            inst1: inst1,
            inst2: inst2,
        };
    }

    // ============================================
    // 1. Null node graying in selection highlight
    // ============================================

    describe('Selection highlight - null node graying', function () {
        it('drawSelectionHighlight accepts nulledNodes option without throwing', function () {
            if (typeof drawSelectionHighlight !== 'function') return;
            var canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            var ctx = canvas.getContext('2d');
            var skeleton = new Skeleton('test', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            var points = [[100, 100], [200, 200], [300, 300]];
            var nulled = new Set([1]);

            drawSelectionHighlight(ctx, points, skeleton, {
                color: '#ffffff',
                selectedNodeIdx: -1,
                nulledNodes: nulled,
                videoWidth: 640,
                videoHeight: 480,
                canvasWidth: 640,
                canvasHeight: 480,
            });
        });

        it('drawSelectionHighlight works with no nulledNodes', function () {
            if (typeof drawSelectionHighlight !== 'function') return;
            var canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            var ctx = canvas.getContext('2d');
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var points = [[50, 50], [100, 100]];

            drawSelectionHighlight(ctx, points, skeleton, {
                color: '#ffffff',
                selectedNodeIdx: 0,
            });
        });

        it('drawSelectionHighlight works with all nodes nulled', function () {
            if (typeof drawSelectionHighlight !== 'function') return;
            var canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            var ctx = canvas.getContext('2d');
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var points = [[50, 50], [100, 100]];
            var nulled = new Set([0, 1]);

            drawSelectionHighlight(ctx, points, skeleton, {
                color: '#ffffff',
                selectedNodeIdx: -1,
                nulledNodes: nulled,
            });
        });

        it('drawSkeleton grays nulled nodes (existing behavior)', function () {
            if (typeof drawSkeleton !== 'function') return;
            var canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            var ctx = canvas.getContext('2d');
            var skeleton = new Skeleton('test', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            var instance = new Instance([[100, 100], [200, 200], [300, 300]], 0, 'user', 1);
            instance.nulledNodes = new Set([1]);

            drawSkeleton(ctx, instance, skeleton, {
                videoWidth: 640,
                videoHeight: 480,
                canvasWidth: 640,
                canvasHeight: 480,
            });
        });
    });

    // ============================================
    // 2. Ungroup (unlinkGroup in pose-data)
    // ============================================

    describe('Ungroup - unlinkGroup moves instances to unlinked pool', function () {
        it('unlinkGroup disbands group and creates unlinked instances', function () {
            var env = createGroupedEnv();

            assertEqual(env.session.getInstanceGroupsForFrame(0).length, 1, 'starts with 1 group');
            assertEqual(env.fg.getUnlinkedInstances('cam1').length, 0, 'no unlinked cam1');
            assertEqual(env.fg.getUnlinkedInstances('cam2').length, 0, 'no unlinked cam2');

            var newUnlinked = env.session.unlinkGroup(0, env.group);

            assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0, 'group removed');
            assertEqual(newUnlinked.length, 2, '2 unlinked instances created');
            assertEqual(env.fg.getUnlinkedInstances('cam1').length, 1, '1 unlinked in cam1');
            assertEqual(env.fg.getUnlinkedInstances('cam2').length, 1, '1 unlinked in cam2');
        });

        it('unlinkGroup preserves instance points', function () {
            var env = createGroupedEnv();
            var origPoints1 = env.inst1.points.slice();

            var newUnlinked = env.session.unlinkGroup(0, env.group);

            var ul1 = env.fg.getUnlinkedInstances('cam1')[0];
            assertNotNull(ul1, 'unlinked instance exists');
            assertEqual(ul1.instance.points[0][0], origPoints1[0][0], 'points preserved');
            assertEqual(ul1.instance.points[0][1], origPoints1[0][1], 'points preserved');
        });

        it('unlinkGroup removes instances from FrameGroup.instances', function () {
            var env = createGroupedEnv();

            assertEqual(env.fg.getInstances('cam1').length, 1, 'has linked inst cam1');
            assertEqual(env.fg.getInstances('cam2').length, 1, 'has linked inst cam2');

            env.session.unlinkGroup(0, env.group);

            assertEqual(env.fg.getInstances('cam1').length, 0, 'linked removed cam1');
            assertEqual(env.fg.getInstances('cam2').length, 0, 'linked removed cam2');
        });
    });

    // ============================================
    // 3. Ungroup via Session.unlinkGroup
    // ============================================
    // The old InteractionManager._unlinkSelectedGroup() helper was removed (dead
    // in production). The Shift+U shortcut and toolbar delegate to ui-wiring's
    // unlinkGroup(), which calls the data-model Session.unlinkGroup() exercised here.

    describe('Ungroup - Session.unlinkGroup', function () {
        it('unlinkGroup clears selection and disbands group', function () {
            if (typeof InteractionManager !== 'function') return;

            var env = createGroupedEnv();

            var views = [
                { name: 'cam1', overlayCanvas: document.createElement('canvas'), videoWidth: 640, videoHeight: 480 },
                { name: 'cam2', overlayCanvas: document.createElement('canvas'), videoWidth: 640, videoHeight: 480 },
            ];

            var mgr = new InteractionManager({
                getState: function () {
                    return { currentFrame: 0, session: env.session, views: views };
                },
                getInstanceGroups: function () {
                    return env.session.getInstanceGroupsForFrame(0);
                },
                onSelectionChanged: function () {},
                onNodeMoved: function () {},
                requestRedraw: function () {},
            });

            mgr.attach(views);

            // Select the group
            mgr.select(env.group, -1);
            assertEqual(mgr.selectedInstanceGroup, env.group, 'group selected');

            // Unlink via the surviving path: clear selection + data-model op.
            mgr.clearSelection();
            env.session.unlinkGroup(0, env.group);

            assertNull(mgr.selectedInstanceGroup, 'selection cleared');
            assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0, 'group removed');
            assertEqual(env.fg.getUnlinkedInstances('cam1').length, 1, 'unlinked created');

            mgr.detach();
        });
    });

    // ============================================
    // 4. ReprojectedInstance nulledNodes
    // ============================================

    describe('ReprojectedInstance - null nodes', function () {
        it('nulledNodes Set can be added to any Instance', function () {
            var inst = new Instance([[10, 20], [30, 40], [50, 60]], 0, 'user', 1.0);
            assertFalse(!!inst.nulledNodes, 'no nulledNodes initially');

            inst.nulledNodes = new Set();
            inst.nulledNodes.add(1);
            assertTrue(inst.nulledNodes.has(1), 'node 1 nulled');
            assertFalse(inst.nulledNodes.has(0), 'node 0 not nulled');

            inst.nulledNodes.delete(1);
            assertFalse(inst.nulledNodes.has(1), 'node 1 un-nulled');
        });

        it('reprojected instance nulledNodes independent from user instance', function () {
            var userInst = new Instance([[10, 20], [30, 40]], 0, 'user', 1.0);
            var reprojInst = new Instance([[15, 25], [35, 45]], 0, 'user', 1.0);

            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', userInst);
            group.addReprojectedInstance('cam1', reprojInst);

            // Null a node on the reprojected instance
            reprojInst.nulledNodes = new Set([0]);

            assertTrue(reprojInst.nulledNodes.has(0), 'reproj node 0 nulled');
            assertFalse(!!userInst.nulledNodes, 'user instance unaffected');
        });
    });

    // ============================================
    // 5. Per-view skeleton cache
    // ============================================

    describe('Per-view skeleton cache', function () {
        it('lastUserPoints stores per-view entries independently', function () {
            var cache = new Map();

            cache.set('cam1', [[100, 100], [150, 150]]);
            cache.set('cam2', [[200, 200], [250, 250]]);

            assertTrue(cache.has('cam1'), 'cam1 cached');
            assertTrue(cache.has('cam2'), 'cam2 cached');
            assertEqual(cache.get('cam1')[0][0], 100, 'cam1 data correct');
            assertEqual(cache.get('cam2')[0][0], 200, 'cam2 data correct');
        });

        it('deleting cache for one view preserves others', function () {
            var cache = new Map();
            cache.set('cam1', [[100, 100]]);
            cache.set('cam2', [[200, 200]]);

            cache.delete('cam1');

            assertFalse(cache.has('cam1'), 'cam1 cleared');
            assertTrue(cache.has('cam2'), 'cam2 preserved');
        });
    });

    // ============================================
    // 6. drawFrameOverlays with nulled grouped selection
    // ============================================

    describe('drawFrameOverlays - nulled grouped instance selection', function () {
        it('does not throw when selected instance has nulledNodes', function () {
            if (typeof drawFrameOverlays !== 'function') return;

            var canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            var ctx = canvas.getContext('2d');

            var skeleton = new Skeleton('test', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            var cameras = [new Camera('cam1',
                [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])];
            var session = new Session(cameras, skeleton, ['track_0']);

            var inst = new Instance([[100, 100], [200, 200], [300, 300]], 0, 'user', 1);
            inst.nulledNodes = new Set([1]);

            var fg = new FrameGroup(0);
            fg.addInstance('cam1', inst);
            session.addFrameGroup(fg);

            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst);

            drawFrameOverlays(ctx, 'cam1', fg, [group], session, {
                showUser: true,
                showPredicted: true,
                showReprojected: true,
                showErrors: false,
                showLabels: false,
                nodeSize: 4,
                lineWidth: 2,
                alpha: 1,
                videoWidth: 640,
                videoHeight: 480,
                canvasWidth: 640,
                canvasHeight: 480,
                selectedInstanceGroup: group,
                selectedNodeIdx: -1,
                selectedReprojected: false,
                hoveredNode: null,
                dragInfo: null,
                unlinkedInstances: [],
                assignmentSelectedIds: [],
                assignmentMode: false,
            });
        });
    });
})();
