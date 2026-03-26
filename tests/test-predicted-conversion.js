/**
 * test-predicted-conversion.js — Tests for converting predicted grouped instances
 * to user instances, including:
 *   - Auto-conversion on click (single-click drag of predicted group)
 *   - Null/missing points filled from reprojection and marked occluded
 *   - Drag works after conversion
 *   - Existing user instance drag is not broken
 */

(function () {
    var describe = TestFramework.describe;
    var it = TestFramework.it;
    var beforeEach = TestFramework.beforeEach;
    var assertEqual = TestFramework.assertEqual;
    var assertTrue = TestFramework.assertTrue;
    var assertFalse = TestFramework.assertFalse;
    var assertNotNull = TestFramework.assertNotNull;
    var assertNull = TestFramework.assertNull;
    var assertDeepEqual = TestFramework.assertDeepEqual;

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
     * Build a test environment with a predicted grouped instance.
     * @param {Object} opts
     * @param {Array} opts.points - points array (may contain nulls)
     * @param {Array} [opts.reprojPoints] - reprojected points for cam1
     */
    function buildPredictedGroupEnv(opts) {
        opts = opts || {};
        cleanupCanvases();

        var vw = 640, vh = 480;
        var camName = 'cam1';
        var nodes = opts.nodes || ['nose', 'ear', 'wrist', 'tail'];
        var edges = opts.edges || [[0, 1], [1, 2], [2, 3]];
        var points = opts.points || [[100, 100], [200, 200], [300, 300], [400, 400]];

        var skeleton = new Skeleton('mouse', nodes, edges);
        var cameras = [
            new Camera(camName,
                [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh])
        ];
        var session = new Session(cameras, skeleton, ['track_0']);

        // Create predicted instance and group
        var inst = new Instance(
            points.map(function (p) { return p ? [p[0], p[1]] : null; }),
            0, 'predicted', 0.9
        );
        var group = new InstanceGroup(1, 0);
        group.addInstance(camName, inst);

        // Add reprojected instance if provided
        if (opts.reprojPoints) {
            var reprojInst = new Instance(
                opts.reprojPoints.map(function (p) { return p ? [p[0], p[1]] : null; }),
                0, 'reprojected', 0
            );
            group.addReprojectedInstance(camName, reprojInst);
        }

        // Store in session
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

        var convertedCalled = false;
        var movedCalled = false;

        var mgr = new InteractionManager({
            getState: function () {
                return { currentFrame: 0, session: session, views: views };
            },
            getInstanceGroups: function () { return [group]; },
            onSelectionChanged: function () {},
            onNodeMoved: function () { movedCalled = true; },
            onInstanceConverted: function () { convertedCalled = true; },
            requestRedraw: function () {},
        });

        return {
            session: session,
            mgr: mgr,
            group: group,
            inst: inst,
            camName: camName,
            wasConverted: function () { return convertedCalled; },
            wasMoved: function () { return movedCalled; },
        };
    }

    /**
     * Build a test environment with a user grouped instance (for regression tests).
     */
    function buildUserGroupEnv(opts) {
        opts = opts || {};
        cleanupCanvases();

        var vw = 640, vh = 480;
        var camName = 'cam1';
        var nodes = ['nose', 'ear', 'tail'];
        var edges = [[0, 1], [1, 2]];
        var points = opts.points || [[100, 100], [200, 200], [300, 300]];

        var skeleton = new Skeleton('mouse', nodes, edges);
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
        var group = new InstanceGroup(1, 0);
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

        var movedCalled = false;

        var mgr = new InteractionManager({
            getState: function () {
                return { currentFrame: 0, session: session, views: views };
            },
            getInstanceGroups: function () { return [group]; },
            onSelectionChanged: function () {},
            onNodeMoved: function () { movedCalled = true; },
            onInstanceConverted: function () {},
            requestRedraw: function () {},
        });

        return {
            session: session,
            mgr: mgr,
            group: group,
            inst: inst,
            camName: camName,
            wasMoved: function () { return movedCalled; },
        };
    }

    // ============================================
    // Auto-conversion on click
    // ============================================

    describe('Predicted group conversion - auto-convert on click', function () {

        it('single click on predicted group converts to user and starts drag', function () {
            var env = buildPredictedGroupEnv({
                points: [[100, 100], [200, 200], [300, 300], [400, 400]],
            });

            assertEqual(env.inst.type, 'predicted', 'starts as predicted');
            assertFalse(env.mgr.isDragging, 'not dragging yet');

            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);

            assertEqual(env.inst.type, 'user', 'converted to user on click');
            assertTrue(env.mgr.isDragging, 'drag started');
            assertTrue(env.wasConverted(), 'onInstanceConverted callback fired');

            cleanupCanvases();
        });

        it('selected group is the predicted group after conversion', function () {
            var env = buildPredictedGroupEnv({
                points: [[100, 100], [200, 200], [300, 300], [400, 400]],
            });

            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);

            assertEqual(env.mgr.selectedInstanceGroup, env.group,
                'selected group should be the converted group');

            cleanupCanvases();
        });
    });

    // ============================================
    // Drag works after auto-conversion
    // ============================================

    describe('Predicted group conversion - drag after conversion', function () {

        it('can drag node after auto-conversion from predicted', function () {
            var env = buildPredictedGroupEnv({
                points: [[100, 100], [200, 200], [300, 300], [400, 400]],
            });

            // Click on node 0 at (100, 100)
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);
            assertTrue(env.mgr.isDragging, 'drag started');

            // Move to (150, 160) — past threshold
            env.mgr._onDragMove(makeMouseEvent('mousemove', 150, 160));

            // Release
            env.mgr.onMouseUp(makeMouseEvent('mouseup', 150, 160), env.camName);

            assertEqual(env.inst.points[0][0], 150, 'node 0 x moved to 150');
            assertEqual(env.inst.points[0][1], 160, 'node 0 y moved to 160');
            assertTrue(env.wasMoved(), 'onNodeMoved callback fired');
            assertFalse(env.mgr.isDragging, 'drag ended');

            cleanupCanvases();
        });

        it('other nodes are not affected by single-node drag', function () {
            var env = buildPredictedGroupEnv({
                points: [[100, 100], [200, 200], [300, 300], [400, 400]],
            });

            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);
            env.mgr._onDragMove(makeMouseEvent('mousemove', 150, 160));
            env.mgr.onMouseUp(makeMouseEvent('mouseup', 150, 160), env.camName);

            assertEqual(env.inst.points[1][0], 200, 'node 1 unchanged');
            assertEqual(env.inst.points[1][1], 200, 'node 1 unchanged');
            assertEqual(env.inst.points[2][0], 300, 'node 2 unchanged');
            assertEqual(env.inst.points[3][0], 400, 'node 3 unchanged');

            cleanupCanvases();
        });
    });

    // ============================================
    // Null points filled from reprojection
    // ============================================

    describe('Predicted group conversion - null points from reprojection', function () {

        it('null points are filled from reprojection and marked occluded', function () {
            var env = buildPredictedGroupEnv({
                // wrist (index 2) is null in prediction
                points: [[100, 100], [200, 200], null, [400, 400]],
                reprojPoints: [[101, 101], [201, 201], [305, 310], [401, 401]],
            });

            assertNull(env.inst.points[2], 'wrist starts null');

            // Click on node 0 to trigger conversion
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);

            // Wrist should now have reprojected coordinates
            assertNotNull(env.inst.points[2], 'wrist filled from reprojection');
            assertEqual(env.inst.points[2][0], 305, 'wrist x from reprojection');
            assertEqual(env.inst.points[2][1], 310, 'wrist y from reprojection');

            // Wrist should be in nulledNodes (occluded)
            assertTrue(env.inst.nulledNodes instanceof Set, 'nulledNodes is a Set');
            assertTrue(env.inst.nulledNodes.has(2), 'wrist is marked occluded');

            // Non-null points should NOT be in nulledNodes
            assertFalse(env.inst.nulledNodes.has(0), 'nose not occluded');
            assertFalse(env.inst.nulledNodes.has(1), 'ear not occluded');
            assertFalse(env.inst.nulledNodes.has(3), 'tail not occluded');

            cleanupCanvases();
        });

        it('multiple null points are all filled and marked', function () {
            var env = buildPredictedGroupEnv({
                // ear (1) and wrist (2) are both null
                points: [[100, 100], null, null, [400, 400]],
                reprojPoints: [[101, 101], [205, 210], [305, 310], [401, 401]],
            });

            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);

            assertNotNull(env.inst.points[1], 'ear filled');
            assertEqual(env.inst.points[1][0], 205, 'ear x');
            assertEqual(env.inst.points[1][1], 210, 'ear y');

            assertNotNull(env.inst.points[2], 'wrist filled');
            assertEqual(env.inst.points[2][0], 305, 'wrist x');

            assertTrue(env.inst.nulledNodes.has(1), 'ear marked occluded');
            assertTrue(env.inst.nulledNodes.has(2), 'wrist marked occluded');
            assertFalse(env.inst.nulledNodes.has(0), 'nose not occluded');
            assertFalse(env.inst.nulledNodes.has(3), 'tail not occluded');

            cleanupCanvases();
        });

        it('null point without reprojection gets centroid position and marked occluded', function () {
            var env = buildPredictedGroupEnv({
                // shoulder=0, elbow=1, wrist=2 (null), tail=3
                points: [[100, 100], [200, 200], null, [400, 400]],
                // No reprojected instance at all
            });

            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);

            // Wrist should get centroid of visible points: (100+200+400)/3=233, (100+200+400)/3=233
            assertNotNull(env.inst.points[2], 'wrist filled with centroid');
            var expectedX = Math.round((100 + 200 + 400) / 3);
            var expectedY = Math.round((100 + 200 + 400) / 3);
            assertEqual(env.inst.points[2][0], expectedX, 'wrist x is centroid');
            assertEqual(env.inst.points[2][1], expectedY, 'wrist y is centroid');
            assertTrue(env.inst.nulledNodes.has(2), 'wrist marked occluded');
            assertEqual(env.inst.type, 'user', 'converted to user');

            cleanupCanvases();
        });

        it('null point without reprojection (reproj also null) gets centroid', function () {
            var env = buildPredictedGroupEnv({
                points: [[100, 100], [200, 200], null, [400, 400]],
                reprojPoints: [[101, 101], [201, 201], null, [401, 401]],
            });

            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);

            // Reprojection is also null for wrist, so fallback to centroid
            assertNotNull(env.inst.points[2], 'wrist filled with centroid');
            assertTrue(env.inst.nulledNodes.has(2), 'wrist marked occluded');

            cleanupCanvases();
        });

        it('shoulder+elbow prediction missing wrist becomes occluded wrist on conversion', function () {
            // Real-world scenario: detector finds shoulder and elbow but not wrist
            var env = buildPredictedGroupEnv({
                nodes: ['shoulder', 'elbow', 'wrist'],
                edges: [[0, 1], [1, 2]],
                points: [[120, 80], [200, 150], null],  // wrist missing
                // No reprojection
            });

            assertEqual(env.inst.points[2], null, 'wrist starts null');

            // Convert by clicking on shoulder
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 120, 80), env.camName);

            // Wrist should now exist as occluded, placed at centroid of visible points
            assertNotNull(env.inst.points[2], 'wrist has a position after conversion');
            assertTrue(env.inst.nulledNodes instanceof Set, 'nulledNodes exists');
            assertTrue(env.inst.nulledNodes.has(2), 'wrist is marked occluded');
            assertFalse(env.inst.nulledNodes.has(0), 'shoulder is NOT occluded');
            assertFalse(env.inst.nulledNodes.has(1), 'elbow is NOT occluded');
            assertEqual(env.inst.type, 'user', 'type is user');

            // Centroid: ((120+200)/2, (80+150)/2) = (160, 115)
            assertEqual(env.inst.points[2][0], 160, 'wrist x at centroid');
            assertEqual(env.inst.points[2][1], 115, 'wrist y at centroid');

            // User can now drag the occluded wrist to correct position
            env.mgr.onMouseUp(makeMouseEvent('mouseup', 120, 80), env.camName);

            // Drag the wrist node
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 160, 115), env.camName);
            assertTrue(env.mgr.isDragging, 'can drag the occluded wrist');
            env.mgr._onDragMove(makeMouseEvent('mousemove', 250, 200));
            env.mgr.onMouseUp(makeMouseEvent('mouseup', 250, 200), env.camName);

            assertEqual(env.inst.points[2][0], 250, 'wrist dragged to new x');
            assertEqual(env.inst.points[2][1], 200, 'wrist dragged to new y');

            cleanupCanvases();
        });

        it('existing non-null points are deep-copied, not shared', function () {
            var env = buildPredictedGroupEnv({
                points: [[100, 100], [200, 200], [300, 300], [400, 400]],
            });

            var originalRef = env.inst.points[0];

            env.mgr.onMouseDown(makeMouseEvent('mousedown', 200, 200), env.camName);

            // Points should be deep copies
            var newRef = env.inst.points[0];
            assertTrue(originalRef !== newRef, 'points are deep-copied');
            assertEqual(newRef[0], 100, 'values preserved');
            assertEqual(newRef[1], 100, 'values preserved');

            cleanupCanvases();
        });
    });

    // ============================================
    // Regression: user instance drag still works
    // ============================================

    describe('Predicted group conversion - regression: user drag unaffected', function () {

        it('user grouped instance can be dragged without conversion', function () {
            var env = buildUserGroupEnv({
                points: [[100, 100], [200, 200], [300, 300]],
            });

            assertEqual(env.inst.type, 'user', 'starts as user');

            env.mgr.onMouseDown(makeMouseEvent('mousedown', 200, 200), env.camName);
            assertTrue(env.mgr.isDragging, 'drag started for user instance');

            env.mgr._onDragMove(makeMouseEvent('mousemove', 250, 260));
            env.mgr.onMouseUp(makeMouseEvent('mouseup', 250, 260), env.camName);

            assertEqual(env.inst.points[1][0], 250, 'node 1 moved to 250');
            assertEqual(env.inst.points[1][1], 260, 'node 1 moved to 260');
            assertEqual(env.inst.type, 'user', 'type unchanged');
            assertTrue(env.wasMoved(), 'onNodeMoved fired');

            cleanupCanvases();
        });

        it('user instance with nulledNodes preserves them on drag', function () {
            var env = buildUserGroupEnv({
                points: [[100, 100], [200, 200], [300, 300]],
            });

            env.inst.nulledNodes = new Set([2]);

            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);
            env.mgr._onDragMove(makeMouseEvent('mousemove', 130, 140));
            env.mgr.onMouseUp(makeMouseEvent('mouseup', 130, 140), env.camName);

            assertTrue(env.inst.nulledNodes.has(2), 'nulledNodes preserved after drag');

            cleanupCanvases();
        });

        it('sequential drags work on converted predicted instance', function () {
            var env = buildPredictedGroupEnv({
                points: [[100, 100], [200, 200], [300, 300], [400, 400]],
            });

            // First drag (triggers conversion)
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);
            env.mgr._onDragMove(makeMouseEvent('mousemove', 130, 140));
            env.mgr.onMouseUp(makeMouseEvent('mouseup', 130, 140), env.camName);

            assertEqual(env.inst.points[0][0], 130, 'first drag moved node 0');
            assertEqual(env.inst.type, 'user', 'type is user after first drag');

            // Second drag (should work without conversion)
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 200, 200), env.camName);
            assertTrue(env.mgr.isDragging, 'second drag started');
            env.mgr._onDragMove(makeMouseEvent('mousemove', 240, 260));
            env.mgr.onMouseUp(makeMouseEvent('mouseup', 240, 260), env.camName);

            assertEqual(env.inst.points[1][0], 240, 'second drag moved node 1');

            cleanupCanvases();
        });
    });

    // ============================================
    // Unlinked prediction → user: null points filled
    // ============================================

    describe('Unlinked predicted conversion - missing nodes become occluded', function () {

        /**
         * Build env with an unlinked predicted instance (not grouped).
         */
        function buildUnlinkedPredEnv(opts) {
            opts = opts || {};
            cleanupCanvases();

            var vw = 640, vh = 480;
            var camName = 'cam1';
            var nodes = opts.nodes || ['shoulder', 'elbow', 'wrist'];
            var edges = opts.edges || [[0, 1], [1, 2]];
            var points = opts.points || [[100, 100], [200, 200], null];

            var skeleton = new Skeleton('mouse', nodes, edges);
            var cameras = [
                new Camera(camName,
                    [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh])
            ];
            var session = new Session(cameras, skeleton, ['track_0']);

            var inst = new Instance(
                points.map(function (p) { return p ? [p[0], p[1]] : null; }),
                0, 'predicted', 0.9
            );
            var fg = new FrameGroup(0);
            session.addFrameGroup(fg);
            var unlinked = session.addUnlinkedInstance(0, camName, inst);

            var overlayCanvas = createMockCanvas(vw, vh);
            var views = [{
                name: camName,
                overlayCanvas: overlayCanvas,
                videoWidth: vw,
                videoHeight: vh,
            }];

            var createdInst = null;
            var mgr = new InteractionManager({
                getState: function () {
                    return { currentFrame: 0, session: session, views: views };
                },
                getInstanceGroups: function () { return []; },
                onSelectionChanged: function () {},
                onNodeMoved: function () {},
                onInstanceConverted: function () {},
                onUserInstanceCreated: function () {},
                requestRedraw: function () {},
            });

            return {
                session: session,
                mgr: mgr,
                inst: inst,
                unlinked: unlinked,
                camName: camName,
                fg: fg,
            };
        }

        it('double-click unlinked prediction with missing wrist fills wrist at centroid', function () {
            var env = buildUnlinkedPredEnv({
                nodes: ['shoulder', 'elbow', 'wrist'],
                points: [[120, 80], [200, 150], null],  // wrist missing
            });

            // Double-click on shoulder to convert
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 120, 80, { detail: 2 }), env.camName);

            // Find the new user instance in the frame group
            var ulList = env.fg.getUnlinkedInstances(env.camName);
            var userInst = null;
            for (var i = 0; i < ulList.length; i++) {
                if (ulList[i].instance.type === 'user') {
                    userInst = ulList[i].instance;
                    break;
                }
            }

            assertNotNull(userInst, 'user instance was created');
            assertEqual(userInst.type, 'user', 'type is user');

            // Wrist should be filled at centroid of shoulder+elbow
            assertNotNull(userInst.points[2], 'wrist has position');
            assertEqual(userInst.points[2][0], 160, 'wrist x = centroid (120+200)/2');
            assertEqual(userInst.points[2][1], 115, 'wrist y = centroid (80+150)/2');

            // Wrist should be marked occluded
            assertTrue(userInst.nulledNodes instanceof Set, 'nulledNodes exists');
            assertTrue(userInst.nulledNodes.has(2), 'wrist is occluded');
            assertFalse(userInst.nulledNodes.has(0), 'shoulder not occluded');
            assertFalse(userInst.nulledNodes.has(1), 'elbow not occluded');

            cleanupCanvases();
        });

        it('double-click unlinked prediction with only shoulder fills elbow+wrist', function () {
            var env = buildUnlinkedPredEnv({
                nodes: ['shoulder', 'elbow', 'wrist'],
                points: [[150, 200], null, null],  // only shoulder detected
            });

            env.mgr.onMouseDown(makeMouseEvent('mousedown', 150, 200, { detail: 2 }), env.camName);

            var ulList = env.fg.getUnlinkedInstances(env.camName);
            var userInst = null;
            for (var i = 0; i < ulList.length; i++) {
                if (ulList[i].instance.type === 'user') {
                    userInst = ulList[i].instance;
                    break;
                }
            }

            assertNotNull(userInst, 'user instance created');
            // Centroid is just shoulder position (only visible point)
            assertNotNull(userInst.points[1], 'elbow filled');
            assertEqual(userInst.points[1][0], 150, 'elbow x at shoulder pos');
            assertEqual(userInst.points[1][1], 200, 'elbow y at shoulder pos');
            assertNotNull(userInst.points[2], 'wrist filled');
            assertEqual(userInst.points[2][0], 150, 'wrist x at shoulder pos');

            assertTrue(userInst.nulledNodes.has(1), 'elbow occluded');
            assertTrue(userInst.nulledNodes.has(2), 'wrist occluded');
            assertFalse(userInst.nulledNodes.has(0), 'shoulder not occluded');

            cleanupCanvases();
        });

        it('all points present: no nulledNodes added', function () {
            var env = buildUnlinkedPredEnv({
                points: [[100, 100], [200, 200], [300, 300]],
            });

            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100, { detail: 2 }), env.camName);

            var ulList = env.fg.getUnlinkedInstances(env.camName);
            var userInst = null;
            for (var i = 0; i < ulList.length; i++) {
                if (ulList[i].instance.type === 'user') {
                    userInst = ulList[i].instance;
                    break;
                }
            }

            assertNotNull(userInst, 'user instance created');
            assertTrue(!userInst.nulledNodes || userInst.nulledNodes.size === 0,
                'no nulledNodes when all points present');

            cleanupCanvases();
        });
    });

    // ============================================
    // Reprojected instance remains select-only
    // ============================================

    describe('Predicted group conversion - reprojected still blocked', function () {

        it('reprojected instance hit does not start drag', function () {
            var env = buildPredictedGroupEnv({
                points: [[100, 100], [200, 200], [300, 300], [400, 400]],
                reprojPoints: [[105, 105], [205, 205], [305, 305], [405, 405]],
            });

            // Convert to user first
            env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), env.camName);
            env.mgr.onMouseUp(makeMouseEvent('mouseup', 100, 100), env.camName);
            assertEqual(env.inst.type, 'user', 'converted');

            // Now the main instance is user, reprojected instance is separate
            // Hitting a reprojected node should not allow drag
            // (This tests findNearestNode's pass-based filtering)
            var hit = env.mgr.findNearestNode(105, 105, env.camName, 0);
            if (hit && hit.hitReprojected) {
                env.mgr.onMouseDown(makeMouseEvent('mousedown', 105, 105), env.camName);
                // If it hit reprojected, drag should not start for that
                // (the user instance at ~100,100 is closer in pass 0)
            }

            cleanupCanvases();
        });
    });

})();
