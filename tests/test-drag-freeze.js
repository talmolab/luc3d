/**
 * test-drag-freeze.js - Regression tests for the drag-freeze bug.
 *
 * BUG: After completing a drag on one node and releasing the mouse, a
 * subsequent mousedown on a DIFFERENT node fails to initiate a new drag.
 *
 * FIX: Drag movement is now handled by document-level listeners installed
 * by _startDrag() and removed by _endDrag(). The canvas-level onMouseMove
 * only handles hover tracking. This prevents events from being lost when
 * the mouse briefly leaves the overlay canvas.
 *
 * These tests call the InteractionManager methods directly to verify
 * correct state transitions.
 */

(function () {
    var describe = TestFramework.describe;
    var it = TestFramework.it;
    var beforeEach = TestFramework.beforeEach;
    var assert = TestFramework.assert;
    var assertEqual = TestFramework.assertEqual;
    var assertDeepEqual = TestFramework.assertDeepEqual;
    var assertNotNull = TestFramework.assertNotNull;
    var assertNull = TestFramework.assertNull;
    var assertTrue = TestFramework.assertTrue;
    var assertFalse = TestFramework.assertFalse;

    // ============================================
    // Helpers
    // ============================================

    function createMockCanvas(w, h) {
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        canvas.style.position = 'fixed';
        canvas.style.top = '0px';
        canvas.style.left = '0px';
        canvas.style.margin = '0';
        canvas.style.padding = '0';
        canvas.style.border = 'none';
        document.body.appendChild(canvas);
        return canvas;
    }

    function cleanupCanvases() {
        var canvases = document.querySelectorAll('canvas[style*="position: fixed"]');
        for (var i = 0; i < canvases.length; i++) {
            canvases[i].remove();
        }
    }

    function buildEnv(opts) {
        opts = opts || {};
        var nodeNames = opts.nodes || ['nose', 'ear', 'tail'];
        var edges = opts.edges || [[0, 1], [1, 2]];
        var points = opts.points || [[100, 100], [200, 200], [300, 300]];
        var camName = opts.camera || 'cam1';
        var vw = opts.videoWidth || 640;
        var vh = opts.videoHeight || 480;

        var skeleton = new Skeleton('mouse', nodeNames, edges);
        var cameras = [
            new Camera(camName,
                [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh])
        ];
        var session = new Session(cameras, skeleton, ['track_0']);

        var inst = new Instance(
            points.map(function (p) { return [p[0], p[1]]; }),
            0, 'user', 1.0
        );
        session.addUnlinkedInstance(0, camName, inst);

        var overlayCanvas = createMockCanvas(vw, vh);

        var views = [{
            name: camName,
            overlayCanvas: overlayCanvas,
            videoWidth: vw,
            videoHeight: vh,
        }];

        var redraws = 0;

        var mgr = new InteractionManager({
            getState: function () {
                return { currentFrame: 0, session: session, views: views };
            },
            getInstanceGroups: function (frameIdx) {
                return session.getInstanceGroupsForFrame(frameIdx || 0);
            },
            onSelectionChanged: function () {},
            onInstanceDeleted: function () {},
            onNodeMoved: function () {},
            requestRedraw: function () { redraws++; },
        });

        var fg = session.getFrameGroup(0);
        var unlinked = fg.getUnlinkedInstances(camName)[0];

        return {
            skeleton: skeleton,
            session: session,
            mgr: mgr,
            views: views,
            canvas: overlayCanvas,
            camName: camName,
            unlinked: unlinked,
            instance: inst,
            getRedraws: function () { return redraws; },
        };
    }

    function makeMouseEvent(type, clientX, clientY, opts) {
        opts = opts || {};
        return new MouseEvent(type, {
            clientX: clientX,
            clientY: clientY,
            button: opts.button !== undefined ? opts.button : 0,
            altKey: !!opts.altKey,
            shiftKey: !!opts.shiftKey,
            ctrlKey: !!opts.ctrlKey,
            detail: opts.detail || (type === 'mousedown' ? 1 : 0),
            bubbles: true,
            cancelable: true,
        });
    }

    /**
     * Simulate a complete drag sequence: mousedown, mousemove (via _onDragMove), mouseup.
     * This mirrors the real event flow where drag movement uses document-level listeners.
     */
    function simulateDrag(mgr, camName, startX, startY, endX, endY, opts) {
        opts = opts || {};
        mgr.onMouseDown(makeMouseEvent('mousedown', startX, startY, opts), camName);
        if (startX !== endX || startY !== endY) {
            mgr._onDragMove(makeMouseEvent('mousemove', endX, endY, opts));
        }
        mgr.onMouseUp(makeMouseEvent('mouseup', endX, endY, opts), camName);
    }

    // ============================================
    // Sequential drags on different nodes
    // ============================================

    describe('Drag freeze - sequential drags on different nodes', function () {
        var env;

        beforeEach(function () {
            cleanupCanvases();
            env = buildEnv();
        });

        it('mousedown on node 0 starts drag with nodeIdx=0', function () {
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);
            assertTrue(env.mgr.isDragging, 'isDragging should be true');
            assertNotNull(env.mgr.dragInfo, 'dragInfo should not be null');
            assertEqual(env.mgr.dragInfo.nodeIdx, 0, 'Should drag node 0');
            assertEqual(env.mgr.dragInfo.mode, 'node', 'Should be node mode');
            env.mgr.onMouseUp(makeMouseEvent('mouseup', 100, 100), env.camName);
        });

        it('_onDragMove updates node position during drag', function () {
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);
            env.mgr._onDragMove(makeMouseEvent('mousemove', 150, 160));
            assertEqual(env.unlinked.instance.points[0][0], 150, 'Node 0 x=150');
            assertEqual(env.unlinked.instance.points[0][1], 160, 'Node 0 y=160');
            assertEqual(env.unlinked.instance.points[1][0], 200, 'Node 1 unchanged');
            env.mgr.onMouseUp(makeMouseEvent('mouseup', 150, 160), env.camName);
        });

        it('mouseup clears drag state completely', function () {
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);
            env.mgr._onDragMove(makeMouseEvent('mousemove', 150, 160));
            env.mgr.onMouseUp(makeMouseEvent('mouseup', 150, 160), env.camName);
            assertFalse(env.mgr.isDragging, 'isDragging false');
            assertNull(env.mgr.dragInfo, 'dragInfo null');
        });

        it('FULL SEQUENCE: drag node 0, release, then drag node 1', function () {
            // Drag node 0: (100,100) -> (150,160)
            simulateDrag(env.mgr, env.camName, 100, 100, 150, 160);
            assertFalse(env.mgr.isDragging, 'Clean after drag 1');
            assertEqual(env.unlinked.instance.points[0][0], 150, 'Node 0 x=150');
            assertEqual(env.unlinked.instance.points[0][1], 160, 'Node 0 y=160');

            // Drag node 1: (200,200) -> (250,270)
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 200, 200), env.camName);
            assertTrue(env.mgr.isDragging, 'Drag 2 started');
            assertEqual(env.mgr.dragInfo.nodeIdx, 1, 'Should drag node 1');

            env.mgr._onDragMove(makeMouseEvent('mousemove', 250, 270));
            assertEqual(env.unlinked.instance.points[1][0], 250, 'Node 1 x=250');
            assertEqual(env.unlinked.instance.points[1][1], 270, 'Node 1 y=270');

            env.mgr.onMouseUp(makeMouseEvent('mouseup', 250, 270), env.camName);
            assertFalse(env.mgr.isDragging, 'Clean after drag 2');

            // Verify final positions
            assertDeepEqual(env.unlinked.instance.points[0], [150, 160], 'Final node 0');
            assertDeepEqual(env.unlinked.instance.points[1], [250, 270], 'Final node 1');
            assertDeepEqual(env.unlinked.instance.points[2], [300, 300], 'Final node 2 unchanged');
        });
    });

    // ============================================
    // Drag the SAME node twice
    // ============================================

    describe('Drag freeze - drag same node twice', function () {
        var env;

        beforeEach(function () {
            cleanupCanvases();
            env = buildEnv();
        });

        it('can drag same node a second time after release', function () {
            simulateDrag(env.mgr, env.camName, 100, 100, 120, 130);
            assertEqual(env.unlinked.instance.points[0][0], 120, 'After drag 1: x=120');

            env.mgr.onMouseDown(makeMouseEvent('mousedown', 120, 130), env.camName);
            assertTrue(env.mgr.isDragging, 'Drag 2 started');
            assertEqual(env.mgr.dragInfo.nodeIdx, 0, 'Same node 0');

            env.mgr._onDragMove(makeMouseEvent('mousemove', 180, 190));
            assertEqual(env.unlinked.instance.points[0][0], 180, 'After drag 2: x=180');

            env.mgr.onMouseUp(makeMouseEvent('mouseup', 180, 190), env.camName);
            assertFalse(env.mgr.isDragging, 'Clean after drag 2');
        });
    });

    // ============================================
    // Alt+drag then individual node drag
    // ============================================

    describe('Drag freeze - Alt+drag then individual drag', function () {
        var env;

        beforeEach(function () {
            cleanupCanvases();
            env = buildEnv();
        });

        it('Alt+drag translates all, then normal drag moves single node', function () {
            var origPts = env.unlinked.instance.points.map(function (p) {
                return [p[0], p[1]];
            });

            // Alt+drag on node 0: translate whole instance by (20, 30)
            env.mgr.onMouseDown(makeMouseEvent('mousedown', origPts[0][0], origPts[0][1], { altKey: true }), env.camName);
            assertEqual(env.mgr.dragInfo.mode, 'instance', 'Alt+drag = instance mode');

            env.mgr._onDragMove(makeMouseEvent('mousemove', origPts[0][0] + 20, origPts[0][1] + 30, { altKey: true }));
            var pts = env.unlinked.instance.points;
            for (var i = 0; i < pts.length; i++) {
                assertEqual(pts[i][0], origPts[i][0] + 20, 'Node ' + i + ' x shifted');
                assertEqual(pts[i][1], origPts[i][1] + 30, 'Node ' + i + ' y shifted');
            }

            env.mgr.onMouseUp(makeMouseEvent('mouseup', origPts[0][0] + 20, origPts[0][1] + 30), env.camName);
            assertFalse(env.mgr.isDragging, 'Clean after Alt+drag');

            // Normal drag on node 2 (now at 320, 330)
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 320, 330), env.camName);
            assertEqual(env.mgr.dragInfo.mode, 'node', 'Normal drag = node mode');
            assertEqual(env.mgr.dragInfo.nodeIdx, 2, 'Dragging node 2');

            env.mgr._onDragMove(makeMouseEvent('mousemove', 400, 400));
            assertEqual(pts[2][0], 400, 'Node 2 moved to 400');
            assertEqual(pts[0][0], origPts[0][0] + 20, 'Node 0 unchanged');
            assertEqual(pts[1][0], origPts[1][0] + 20, 'Node 1 unchanged');

            env.mgr.onMouseUp(makeMouseEvent('mouseup', 400, 400), env.camName);
        });
    });

    // ============================================
    // Click empty space to deselect, then drag
    // ============================================

    describe('Drag freeze - deselect then drag', function () {
        var env;

        beforeEach(function () {
            cleanupCanvases();
            env = buildEnv();
        });

        it('click empty space clears selection, then click node starts fresh drag', function () {
            // Click node 0 to select
            simulateDrag(env.mgr, env.camName, 100, 100, 100, 100);
            assertNotNull(env.mgr.selectedUnlinked, 'Unlinked selected');

            // Click empty space
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 500, 450), env.camName);
            assertNull(env.mgr.selectedUnlinked, 'Cleared after empty click');
            assertFalse(env.mgr.isDragging, 'Not dragging');

            // Now drag node 1
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 200, 200), env.camName);
            assertTrue(env.mgr.isDragging, 'Drag started on node 1');
            assertEqual(env.mgr.dragInfo.nodeIdx, 1, 'Node 1');

            env.mgr._onDragMove(makeMouseEvent('mousemove', 220, 230));
            assertEqual(env.unlinked.instance.points[1][0], 220, 'Moved to 220');

            env.mgr.onMouseUp(makeMouseEvent('mouseup', 220, 230), env.camName);
        });
    });

    // ============================================
    // Stale drag guard
    // ============================================

    describe('Drag freeze - stale drag guard', function () {
        var env;

        beforeEach(function () {
            cleanupCanvases();
            env = buildEnv();
        });

        it('mousedown cleans up stale drag if mouseup was missed', function () {
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);
            assertTrue(env.mgr.isDragging, 'First drag active');

            // Simulate missed mouseup - directly click another node
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 200, 200), env.camName);
            assertTrue(env.mgr.isDragging, 'New drag started');
            assertEqual(env.mgr.dragInfo.nodeIdx, 1, 'Now dragging node 1');

            env.mgr.onMouseUp(makeMouseEvent('mouseup', 200, 200), env.camName);
            assertFalse(env.mgr.isDragging, 'Clean after recovery');
        });
    });

    // ============================================
    // Rapid three-node sequence
    // ============================================

    describe('Drag freeze - rapid three-node sequence', function () {
        var env;

        beforeEach(function () {
            cleanupCanvases();
            env = buildEnv();
        });

        it('drag all three nodes in rapid sequence', function () {
            simulateDrag(env.mgr, env.camName, 100, 100, 110, 115);
            assertEqual(env.unlinked.instance.points[0][0], 110, 'Node 0 x=110');
            assertFalse(env.mgr.isDragging, 'Clean after drag 1');

            simulateDrag(env.mgr, env.camName, 200, 200, 210, 225);
            assertEqual(env.unlinked.instance.points[1][0], 210, 'Node 1 x=210');
            assertFalse(env.mgr.isDragging, 'Clean after drag 2');

            simulateDrag(env.mgr, env.camName, 300, 300, 350, 360);
            assertEqual(env.unlinked.instance.points[2][0], 350, 'Node 2 x=350');
            assertFalse(env.mgr.isDragging, 'Clean after drag 3');

            assertDeepEqual(env.unlinked.instance.points[0], [110, 115], 'Final node 0');
            assertDeepEqual(env.unlinked.instance.points[1], [210, 225], 'Final node 1');
            assertDeepEqual(env.unlinked.instance.points[2], [350, 360], 'Final node 2');
        });
    });

    // ============================================
    // Linked instance sequential drags
    // ============================================

    describe('Drag freeze - linked instance drags', function () {
        var env, group;

        beforeEach(function () {
            cleanupCanvases();

            var vw = 640, vh = 480, camName = 'cam1';
            var skeleton = new Skeleton('mouse', ['nose', 'ear', 'tail'], [[0, 1], [1, 2]]);
            var cameras = [
                new Camera(camName,
                    [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh])
            ];
            var session = new Session(cameras, skeleton, ['track_0']);

            group = new InstanceGroup(1, 0);
            var inst = new Instance([[100, 100], [200, 200], [300, 300]], 0, 'user', 1.0);
            group.addInstance(camName, inst);
            session.instanceGroups.set(0, new Map([[0, [group]]]));

            var fg = new FrameGroup(0);
            fg.addInstance(camName, inst);
            session.addFrameGroup(fg);

            var overlayCanvas = createMockCanvas(vw, vh);
            var views = [{
                name: camName,
                overlayCanvas: overlayCanvas,
                videoWidth: vw,
                videoHeight: vh,
            }];

            env = {
                camName: camName,
                inst: inst,
                mgr: new InteractionManager({
                    getState: function () {
                        return { currentFrame: 0, session: session, views: views };
                    },
                    getInstanceGroups: function () { return [group]; },
                    onSelectionChanged: function () {},
                    onNodeMoved: function () {},
                    requestRedraw: function () {},
                }),
            };
        });

        it('drag node 0, release, then drag node 1 on linked instance', function () {
            simulateDrag(env.mgr, env.camName, 100, 100, 130, 140);
            assertEqual(env.inst.points[0][0], 130, 'Node 0 x=130');
            assertFalse(env.mgr.isDragging, 'Clean after drag 1');

            env.mgr.onMouseDown(makeMouseEvent('mousedown', 200, 200), env.camName);
            assertTrue(env.mgr.isDragging, 'Drag 2 started');
            assertEqual(env.mgr.dragInfo.nodeIdx, 1, 'Node 1');

            env.mgr._onDragMove(makeMouseEvent('mousemove', 240, 260));
            env.mgr.onMouseUp(makeMouseEvent('mouseup', 240, 260), env.camName);

            assertEqual(env.inst.points[1][0], 240, 'Node 1 x=240');
            assertEqual(env.inst.points[2][0], 300, 'Node 2 unchanged');
        });
    });

    // ============================================
    // Edge cases
    // ============================================

    describe('Drag freeze - edge cases', function () {
        var env;

        beforeEach(function () {
            cleanupCanvases();
            env = buildEnv();
        });

        it('mouseup without prior drag does not crash', function () {
            env.mgr.onMouseUp(makeMouseEvent('mouseup', 100, 100), env.camName);
            assertFalse(env.mgr.isDragging, 'Still false');
            assertNull(env.mgr.dragInfo, 'Still null');
        });

        it('mousedown on empty space does not start drag', function () {
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 500, 450), env.camName);
            assertFalse(env.mgr.isDragging, 'Not dragging empty space');
        });

        it('zero-movement drag cleans up, allows next drag', function () {
            simulateDrag(env.mgr, env.camName, 100, 100, 100, 100);
            assertFalse(env.mgr.isDragging, 'Clean after zero-move');

            env.mgr.onMouseDown(makeMouseEvent('mousedown', 200, 200), env.camName);
            assertTrue(env.mgr.isDragging, 'New drag works');
            assertEqual(env.mgr.dragInfo.nodeIdx, 1, 'Node 1');
            env.mgr.onMouseUp(makeMouseEvent('mouseup', 200, 200), env.camName);
        });

        it('instance type is set to user after drag', function () {
            env.unlinked.instance.type = 'predicted';
            simulateDrag(env.mgr, env.camName, 100, 100, 120, 130);
            assertEqual(env.unlinked.instance.type, 'user', 'Type set to user');
            assertTrue(env.unlinked.instance.modified, 'Marked modified');
        });
    });

    // ============================================
    // Document-level drag listeners
    // ============================================

    describe('Drag freeze - document-level drag listeners', function () {
        var env;

        beforeEach(function () {
            cleanupCanvases();
            env = buildEnv();
        });

        it('_startDrag installs document listeners, _endDrag removes them', function () {
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);
            assertTrue(env.mgr.isDragging, 'Drag started');
            assertNotNull(env.mgr._dragMoveHandler, 'Move handler installed');
            assertNotNull(env.mgr._dragUpHandler, 'Up handler installed');

            env.mgr.onMouseUp(makeMouseEvent('mouseup', 100, 100), env.camName);
            assertFalse(env.mgr.isDragging, 'Drag ended');
            assertNull(env.mgr._dragMoveHandler, 'Move handler removed');
            assertNull(env.mgr._dragUpHandler, 'Up handler removed');
        });

        it('_onDragMove works independently of canvas mousemove', function () {
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);

            // Call _onDragMove directly (simulating document-level event)
            env.mgr._onDragMove(makeMouseEvent('mousemove', 150, 160));
            assertEqual(env.unlinked.instance.points[0][0], 150, 'Node moved via _onDragMove');

            // Canvas-level onMouseMove should be a no-op during drag
            env.mgr.onMouseMove(makeMouseEvent('mousemove', 999, 999), env.camName);
            assertEqual(env.unlinked.instance.points[0][0], 150, 'Canvas mousemove ignored during drag');

            env.mgr.onMouseUp(makeMouseEvent('mouseup', 150, 160), env.camName);
        });

        it('window.__mvguiDragging is set during drag and cleared after', function () {
            assertFalse(!!window.__mvguiDragging, 'Not set before drag');

            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);
            assertTrue(!!window.__mvguiDragging, 'Set during drag');

            env.mgr.onMouseUp(makeMouseEvent('mouseup', 100, 100), env.camName);
            assertFalse(!!window.__mvguiDragging, 'Cleared after drag');
        });
    });

    // ============================================
    // canvasToVideo verification
    // ============================================

    describe('Drag freeze - canvasToVideo verification', function () {
        var env;

        beforeEach(function () {
            cleanupCanvases();
            env = buildEnv();
        });

        it('canvasToVideo maps correctly with 1:1 fixed canvas', function () {
            var r0 = env.mgr.canvasToVideo(0, 0, env.camName);
            assert(Math.abs(r0[0]) < 2, 'Origin x near 0');
            assert(Math.abs(r0[1]) < 2, 'Origin y near 0');

            var r1 = env.mgr.canvasToVideo(320, 240, env.camName);
            assert(Math.abs(r1[0] - 320) < 2, 'Center x near 320');
            assert(Math.abs(r1[1] - 240) < 2, 'Center y near 240');
        });

        it('findNearestUnlinkedNode finds correct nodes', function () {
            var h0 = env.mgr.findNearestUnlinkedNode(100, 100, env.camName, 0);
            assertNotNull(h0, 'Found node 0');
            assertEqual(h0.nodeIdx, 0, 'Is node 0');

            var h1 = env.mgr.findNearestUnlinkedNode(200, 200, env.camName, 0);
            assertNotNull(h1, 'Found node 1');
            assertEqual(h1.nodeIdx, 1, 'Is node 1');

            var h2 = env.mgr.findNearestUnlinkedNode(300, 300, env.camName, 0);
            assertNotNull(h2, 'Found node 2');
            assertEqual(h2.nodeIdx, 2, 'Is node 2');
        });
    });

})();
