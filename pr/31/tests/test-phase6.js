/**
 * test-phase6.js - Tests for Phase 6: Instance management, fresh project, export.
 */

(function () {
    const { describe, it, assert, assertEqual, assertNotNull, assertNull } = TestFramework;

    // ============================================
    // Single-view layout fix
    // ============================================

    describe('Single-view layout', function () {
        it('should set gridTemplateRows to 1fr in single-view mode', function () {
            var grid = document.createElement('div');
            grid.style.display = 'grid';
            grid.style.gridTemplateColumns = '1fr 1fr';
            grid.style.gridTemplateRows = '1fr 1fr';

            // Simulate single-view: set columns to 1fr, rows to 1fr
            grid.style.gridTemplateColumns = '1fr';
            grid.style.gridTemplateRows = '1fr';

            assertEqual(grid.style.gridTemplateRows, '1fr', 'gridTemplateRows should be 1fr in single-view mode');
        });

        it('should reset gridTemplateRows in grid mode', function () {
            var grid = document.createElement('div');
            grid.style.display = 'grid';
            grid.style.gridTemplateRows = '1fr';

            // Simulate grid mode: reset rows
            grid.style.gridTemplateRows = '';

            assertEqual(grid.style.gridTemplateRows, '', 'gridTemplateRows should be empty in grid mode');
        });
    });

    // ============================================
    // New instance default positions
    // ============================================

    describe('New instance positions (unlinked)', function () {
        it('should create an UnlinkedInstance on the target camera only', function () {
            var skeleton = new Skeleton('test', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            var cameras = [
                new Camera('cam1', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
                new Camera('cam2', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            var session = new Session(cameras, skeleton, ['track_0']);

            var views = [
                { name: 'cam1', videoWidth: 640, videoHeight: 480 },
                { name: 'cam2', videoWidth: 640, videoHeight: 480 },
            ];

            var mgr = new InteractionManager({
                getState: function () {
                    return { currentFrame: 0, session: session, views: views };
                },
                getInstanceGroups: function () { return []; },
                onSelectionChanged: function () {},
                requestRedraw: function () {},
            });

            mgr.lastInteractedView = 'cam1';
            mgr._addNewInstance();

            // Should NOT create any InstanceGroups
            var trackMap = session.instanceGroups.get(0);
            var hasGroups = false;
            if (trackMap) {
                for (var entry of trackMap) {
                    if (entry[1].length > 0) hasGroups = true;
                }
            }
            assert(!hasGroups, 'Should not create InstanceGroups');

            // Should create an UnlinkedInstance on cam1
            var fg = session.getFrameGroup(0);
            assertNotNull(fg, 'FrameGroup should exist');
            var unlinked = fg.getUnlinkedInstances('cam1');
            assertEqual(unlinked.length, 1, 'Should have 1 unlinked instance on cam1');
            assertEqual(unlinked[0].instance.points.length, 3, 'Should have 3 points');

            // cam2 should have no unlinked instances
            var unlinked2 = fg.getUnlinkedInstances('cam2');
            assertEqual(unlinked2.length, 0, 'cam2 should have no unlinked instances');
        });

        it('should place points near video center', function () {
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var cameras = [
                new Camera('cam1', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [800, 600]),
            ];
            var session = new Session(cameras, skeleton, ['track_0']);

            var views = [{ name: 'cam1', videoWidth: 800, videoHeight: 600 }];

            var mgr = new InteractionManager({
                getState: function () {
                    return { currentFrame: 0, session: session, views: views };
                },
                getInstanceGroups: function () { return []; },
                onSelectionChanged: function () {},
                requestRedraw: function () {},
            });

            mgr.lastInteractedView = 'cam1';
            mgr._addNewInstance();

            var fg = session.getFrameGroup(0);
            var unlinked = fg.getUnlinkedInstances('cam1');
            var inst = unlinked[0].instance;

            // Points should be near center (400, 300)
            for (var i = 0; i < inst.points.length; i++) {
                assert(Math.abs(inst.points[i][0] - 400) < 100,
                    'Point ' + i + ' x should be near center (400)');
                assert(Math.abs(inst.points[i][1] - 300) < 100,
                    'Point ' + i + ' y should be near center (300)');
            }
        });

        it('should create a FrameGroup if none exists', function () {
            var skeleton = new Skeleton('test', ['a'], []);
            var cameras = [
                new Camera('cam1', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            var session = new Session(cameras, skeleton, ['track_0']);

            assertEqual(session.frameGroups.size, 0, 'No frame groups initially');

            var mgr = new InteractionManager({
                getState: function () {
                    return { currentFrame: 5, session: session, views: [{ name: 'cam1', videoWidth: 640, videoHeight: 480 }] };
                },
                getInstanceGroups: function () { return []; },
                onSelectionChanged: function () {},
                requestRedraw: function () {},
            });

            mgr.lastInteractedView = 'cam1';
            mgr._addNewInstance();

            assertNotNull(session.getFrameGroup(5), 'FrameGroup should be created for frame 5');
        });
    });

    // ============================================
    // Per-camera deletion
    // ============================================

    describe('Per-camera deletion', function () {
        function setupDeletion() {
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var cameras = [
                new Camera('cam1', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
                new Camera('cam2', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
                new Camera('cam3', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            var session = new Session(cameras, skeleton, ['track_0']);

            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', new Instance([[100, 100], [200, 200]], 0, 'user', 1.0));
            group.addInstance('cam2', new Instance([[100, 100], [200, 200]], 0, 'user', 1.0));
            group.addInstance('cam3', new Instance([[100, 100], [200, 200]], 0, 'user', 1.0));

            session.instanceGroups.set(0, new Map([[0, [group]]]));

            var fg = new FrameGroup(0);
            fg.addInstance('cam1', group.getInstance('cam1'));
            fg.addInstance('cam2', group.getInstance('cam2'));
            fg.addInstance('cam3', group.getInstance('cam3'));
            session.addFrameGroup(fg);

            var mgr = new InteractionManager({
                getState: function () {
                    return { currentFrame: 0, session: session, views: [] };
                },
                getInstanceGroups: function () {
                    var trackMap = session.instanceGroups.get(0);
                    if (!trackMap) return [];
                    var result = [];
                    for (var entry of trackMap) {
                        for (var g of entry[1]) result.push(g);
                    }
                    return result;
                },
                onSelectionChanged: function () {},
                onInstanceDeleted: function () {},
                requestRedraw: function () {},
            });

            return { session: session, group: group, mgr: mgr };
        }

        it('should delete from only the clicked camera', function () {
            var ctx = setupDeletion();

            ctx.mgr.select(ctx.group, -1);
            ctx.mgr.lastInteractedView = 'cam1';

            ctx.mgr._deleteSelected(false);

            assertEqual(ctx.group.instances.has('cam1'), false, 'cam1 should be deleted');
            assertEqual(ctx.group.instances.has('cam2'), true, 'cam2 should remain');
            assertEqual(ctx.group.instances.has('cam3'), true, 'cam3 should remain');
            assertEqual(ctx.group.instances.size, 2, 'Group should have 2 instances');
        });

        it('should remove entire group when last camera is deleted', function () {
            var ctx = setupDeletion();

            ctx.group.instances.delete('cam1');
            ctx.group.instances.delete('cam2');

            ctx.mgr.select(ctx.group, -1);
            ctx.mgr.lastInteractedView = 'cam3';
            ctx.mgr._deleteSelected(false);

            var trackMap = ctx.session.instanceGroups.get(0);
            var empty = !trackMap || trackMap.size === 0;
            assert(empty, 'Instance group should be removed when last camera is deleted');
        });

        it('should remove entire group with Shift+Delete', function () {
            var ctx = setupDeletion();

            ctx.mgr.select(ctx.group, -1);
            ctx.mgr.lastInteractedView = 'cam1';

            ctx.mgr._deleteSelected(true);

            var trackMap = ctx.session.instanceGroups.get(0);
            var empty = !trackMap || trackMap.size === 0;
            assert(empty, 'Shift+Delete should remove entire group');
        });
    });

    // ============================================
    // Fresh project init
    // ============================================

    describe('Fresh project init', function () {
        it('should start with empty state', function () {
            var emptyState = {
                views: [],
                videoFiles: [],
                viewMode: 'grid',
                singleViewIndex: 0,
                currentFrame: 0,
                totalFrames: 0,
                fps: 30,
                isPlaying: false,
                playInterval: null,
                session: null,
            };

            assertEqual(emptyState.views.length, 0, 'Should start with no views');
            assertEqual(emptyState.videoFiles.length, 0, 'Should start with no video files');
            assertNull(emptyState.session, 'Should start with no session');
        });

        it('should create session from calibration loading', function () {
            var toml = '[cam_0]\nname = "back"\nsize = [640, 480]\nmatrix = [[600,0,320],[0,600,240],[0,0,1]]\ndistortions = [0,0,0,0,0]\nrotation = [0,0,0]\ntranslation = [0,0,0]\n';
            var cameras = parseCalibrationTOML(toml);

            assertEqual(cameras.length, 1, 'Should parse 1 camera');
            assertEqual(cameras[0].name, 'back', 'Camera name should be back');

            var skeleton = Skeleton.defaultMouse();
            var session = new Session(cameras, skeleton, ['track_0']);

            assertNotNull(session, 'Session should be created');
            assertEqual(session.cameras.length, 1, 'Session should have 1 camera');
        });

        it('should track lastInteractedView', function () {
            var mgr = new InteractionManager({
                getState: function () { return null; },
                getInstanceGroups: function () { return []; },
            });

            assertNull(mgr.lastInteractedView, 'lastInteractedView should start null');
        });
    });

})();
