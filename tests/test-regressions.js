/**
 * test-regressions.js - Regression tests for known bugs
 */

(function () {
    const { describe, it, beforeEach, assertEqual, assertNotNull, assertNull,
        assertTrue, assertLessThan } = TestFramework;

    function cleanupCanvases() {
        const canvases = document.querySelectorAll('canvas[style*="position: fixed"]');
        canvases.forEach(function (c) { c.remove(); });
    }

    // ---- Bug: Delete instance does nothing ----

    describe('Regression: Delete instance must remove from data model', function () {
        it('_deleteSelected removes group from instanceGroups', function () {
            cleanupCanvases();

            const skeleton = new Skeleton('test', ['a', 'b'], []);
            const cameras = [new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])];
            const session = new Session(cameras, skeleton, ['track_0']);

            // Create data
            const inst = new Instance([[100, 200], [300, 400]], 0, 'user', 1);
            const group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst);
            const fg = new FrameGroup(0);
            fg.addInstance('cam1', inst);
            session.addFrameGroup(fg);
            session.instanceGroups.set(0, new Map([[0, [group]]]));

            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            canvas.style.cssText = 'position:fixed;top:0;left:0;width:640px;height:480px;';
            document.body.appendChild(canvas);

            const state = {
                currentFrame: 0,
                session: session,
                views: [{ name: 'cam1', overlayCanvas: canvas, videoWidth: 640, videoHeight: 480 }],
            };

            const manager = new InteractionManager({
                getState: function () { return state; },
                getInstanceGroups: function (fi) { return session.getInstanceGroupsForFrame(fi); },
                onSelectionChanged: function () {},
                onInstanceDeleted: function () {},
                requestRedraw: function () {},
            });

            // Select and delete
            manager.select(group, 0);
            assertEqual(session.getInstanceGroupsForFrame(0).length, 1, 'Before delete');
            manager._deleteSelected();
            assertEqual(session.getInstanceGroupsForFrame(0).length, 0, 'After delete');

            // Cleanup
            canvas.remove();
        });

        it('_deleteSelected also removes from FrameGroup instances', function () {
            cleanupCanvases();

            const skeleton = new Skeleton('test', ['a'], []);
            const cameras = [new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])];
            const session = new Session(cameras, skeleton, ['track_0']);

            const inst = new Instance([[50, 60]], 0, 'user', 1);
            const group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst);
            const fg = new FrameGroup(0);
            fg.addInstance('cam1', inst);
            session.addFrameGroup(fg);
            session.instanceGroups.set(0, new Map([[0, [group]]]));

            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            canvas.style.cssText = 'position:fixed;top:0;left:0;width:640px;height:480px;';
            document.body.appendChild(canvas);

            const state = {
                currentFrame: 0,
                session: session,
                views: [{ name: 'cam1', overlayCanvas: canvas, videoWidth: 640, videoHeight: 480 }],
            };

            const manager = new InteractionManager({
                getState: function () { return state; },
                getInstanceGroups: function (fi) { return session.getInstanceGroupsForFrame(fi); },
                onSelectionChanged: function () {},
                onInstanceDeleted: function () {},
                requestRedraw: function () {},
            });

            manager.select(group, 0);
            manager._deleteSelected();

            // FrameGroup should have no instances for cam1
            assertEqual(fg.getInstances('cam1').length, 0, 'FrameGroup instances should be empty');

            canvas.remove();
        });
    });

    // ---- Bug: Coordinate offset when clicking ----

    describe('Regression: No constant X offset in coordinate transforms', function () {
        it('canvasToVideo maps center of canvas to center of video', function () {
            cleanupCanvases();

            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            canvas.style.cssText = 'position:fixed;top:0;left:0;width:640px;height:480px;';
            document.body.appendChild(canvas);

            const state = {
                currentFrame: 0,
                session: null,
                views: [{ name: 'cam1', overlayCanvas: canvas, videoWidth: 640, videoHeight: 480 }],
            };

            const manager = new InteractionManager({
                getState: function () { return state; },
                getInstanceGroups: function () { return []; },
                requestRedraw: function () {},
            });

            const rect = canvas.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;

            const [vx, vy] = manager.canvasToVideo(centerX, centerY, 'cam1');
            assertLessThan(Math.abs(vx - 320), 2, 'Center X should map to 320');
            assertLessThan(Math.abs(vy - 240), 2, 'Center Y should map to 240');

            canvas.remove();
        });

        it('canvasToVideo maps top-left to (0,0)', function () {
            cleanupCanvases();

            const canvas = document.createElement('canvas');
            canvas.width = 1280;
            canvas.height = 1024;
            // Display at half size
            canvas.style.cssText = 'position:fixed;top:0;left:0;width:640px;height:512px;';
            document.body.appendChild(canvas);

            const state = {
                currentFrame: 0,
                session: null,
                views: [{ name: 'cam1', overlayCanvas: canvas, videoWidth: 1280, videoHeight: 1024 }],
            };

            const manager = new InteractionManager({
                getState: function () { return state; },
                getInstanceGroups: function () { return []; },
                requestRedraw: function () {},
            });

            const rect = canvas.getBoundingClientRect();
            const [vx, vy] = manager.canvasToVideo(rect.left, rect.top, 'cam1');
            assertLessThan(Math.abs(vx), 2, 'Top-left X should be ~0');
            assertLessThan(Math.abs(vy), 2, 'Top-left Y should be ~0');

            canvas.remove();
        });
    });

    // ---- Bug: Node click precision ----

    describe('Regression: Node click precision matches drawn position', function () {
        it('findNearestNode finds node at its exact video coordinates', function () {
            cleanupCanvases();

            const skeleton = new Skeleton('test', ['a', 'b'], []);
            const cameras = [new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])];
            const session = new Session(cameras, skeleton, ['track_0']);

            const inst = new Instance([[150, 200], [400, 300]], 0, 'user', 1);
            const group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst);
            session.instanceGroups.set(0, new Map([[0, [group]]]));

            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            canvas.style.cssText = 'position:fixed;top:0;left:0;width:640px;height:480px;';
            document.body.appendChild(canvas);

            const state = {
                currentFrame: 0,
                session: session,
                views: [{ name: 'cam1', overlayCanvas: canvas, videoWidth: 640, videoHeight: 480 }],
            };

            const manager = new InteractionManager({
                getState: function () { return state; },
                getInstanceGroups: function (fi) { return session.getInstanceGroupsForFrame(fi); },
                requestRedraw: function () {},
            });

            // Test at exact node positions
            const hit0 = manager.findNearestNode(150, 200, 'cam1', 0);
            assertNotNull(hit0, 'Should find node 0 at (150, 200)');
            assertEqual(hit0.nodeIdx, 0);

            const hit1 = manager.findNearestNode(400, 300, 'cam1', 0);
            assertNotNull(hit1, 'Should find node 1 at (400, 300)');
            assertEqual(hit1.nodeIdx, 1);

            canvas.remove();
        });
    });
})();
