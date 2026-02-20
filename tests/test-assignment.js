/**
 * test-assignment.js - Tests for assignment mode: selecting unlinked instances
 * and linking them together into InstanceGroups.
 *
 * Workflow:
 *   1. Press A (or click Assign button) to enter assignment mode.
 *   2. Click unlinked instances in different camera views to select them.
 *   3. Press Enter or C to create a cross-view InstanceGroup from selection.
 *
 * These tests verify the full pipeline: mode toggling, hit-testing, selection
 * state, visual highlighting, and group creation.
 */

(function () {
    var describe   = TestFramework.describe;
    var it         = TestFramework.it;
    var beforeEach = TestFramework.beforeEach;
    var assertEqual    = TestFramework.assertEqual;
    var assertTrue     = TestFramework.assertTrue;
    var assertFalse    = TestFramework.assertFalse;
    var assertNotNull  = TestFramework.assertNotNull;
    var assertNull     = TestFramework.assertNull;
    var assertDeepEqual = TestFramework.assertDeepEqual;
    var assertGreaterThan = TestFramework.assertGreaterThan;

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

    /**
     * Build a test environment with 2 cameras and unlinked instances.
     */
    function buildEnv(opts) {
        opts = opts || {};
        var vw = opts.videoWidth || 640;
        var vh = opts.videoHeight || 480;

        var skeleton = new Skeleton('mouse', ['nose', 'head'], [[0, 1]]);
        var cameras = [
            new Camera('cam1',
                [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh]),
            new Camera('cam2',
                [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh])
        ];
        var session = new Session(cameras, skeleton, ['track_0']);

        // Add unlinked instances to both cameras
        var inst1 = new Instance([[100, 100], [150, 150]], 0, 'user', 1.0);
        var inst2 = new Instance([[200, 200], [250, 250]], 0, 'user', 1.0);

        session.addUnlinkedInstance(0, 'cam1', inst1);
        session.addUnlinkedInstance(0, 'cam2', inst2);

        var canvas1 = createMockCanvas(vw, vh);
        var canvas2 = createMockCanvas(vw, vh);
        // Position second canvas offset so they don't overlap
        canvas2.style.left = vw + 'px';

        var views = [
            { name: 'cam1', overlayCanvas: canvas1, videoWidth: vw, videoHeight: vh },
            { name: 'cam2', overlayCanvas: canvas2, videoWidth: vw, videoHeight: vh },
        ];

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

        mgr.attach(views);

        var fg = session.getFrameGroup(0);
        var unlinked1 = fg.getUnlinkedInstances('cam1')[0];
        var unlinked2 = fg.getUnlinkedInstances('cam2')[0];

        return {
            skeleton: skeleton,
            session: session,
            mgr: mgr,
            views: views,
            canvas1: canvas1,
            canvas2: canvas2,
            fg: fg,
            unlinked1: unlinked1,
            unlinked2: unlinked2,
            inst1: inst1,
            inst2: inst2,
            getRedraws: function () { return redraws; },
            cleanup: function () {
                mgr.detach();
                cleanupCanvases();
            },
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

    function makeKeyEvent(key, opts) {
        opts = opts || {};
        return new KeyboardEvent('keydown', {
            key: key,
            ctrlKey: !!opts.ctrlKey,
            metaKey: !!opts.metaKey,
            altKey: !!opts.altKey,
            shiftKey: !!opts.shiftKey,
            bubbles: true,
            cancelable: true,
        });
    }

    // ================================================================
    // Test suite 1: Assignment mode toggle
    // ================================================================

    describe('Assignment - mode toggle', function () {

        it('setAssignmentMode toggles on and off', function () {
            var env = buildEnv();
            try {
                assertFalse(env.mgr.assignmentMode, 'starts off');

                env.mgr.setAssignmentMode(true);
                assertTrue(env.mgr.assignmentMode, 'turned on');

                env.mgr.setAssignmentMode(false);
                assertFalse(env.mgr.assignmentMode, 'turned off');

                env.mgr.setAssignmentMode(); // toggle
                assertTrue(env.mgr.assignmentMode, 'toggled on');

                env.mgr.setAssignmentMode(); // toggle again
                assertFalse(env.mgr.assignmentMode, 'toggled off');
            } finally {
                env.cleanup();
            }
        });

        it('A key toggles assignment mode', function () {
            var env = buildEnv();
            try {
                assertFalse(env.mgr.assignmentMode, 'starts off');

                env.mgr.onKeyDown(makeKeyEvent('a'));
                assertTrue(env.mgr.assignmentMode, 'A key turns on');

                env.mgr.onKeyDown(makeKeyEvent('a'));
                assertFalse(env.mgr.assignmentMode, 'A key turns off');
            } finally {
                env.cleanup();
            }
        });

        it('Escape exits assignment mode', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                assertTrue(env.mgr.assignmentMode, 'on before escape');

                env.mgr.onKeyDown(makeKeyEvent('Escape'));
                assertFalse(env.mgr.assignmentMode, 'off after escape');
            } finally {
                env.cleanup();
            }
        });

        it('turning off assignment mode clears selection', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                assertEqual(env.mgr.assignmentSelection.length, 1, 'has 1 selected');

                env.mgr.setAssignmentMode(false);
                assertEqual(env.mgr.assignmentSelection.length, 0, 'selection cleared');
            } finally {
                env.cleanup();
            }
        });
    });

    // ================================================================
    // Test suite 2: Assignment selection management
    // ================================================================

    describe('Assignment - selection management', function () {

        it('addToAssignmentSelection adds unlinked instances', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                assertEqual(env.mgr.assignmentSelection.length, 1, '1 selected');
                assertEqual(env.mgr.assignmentSelection[0].id, env.unlinked1.id, 'correct id');
            } finally {
                env.cleanup();
            }
        });

        it('addToAssignmentSelection replaces same-camera selection', function () {
            var env = buildEnv();
            try {
                // Add a second unlinked instance for cam1
                var inst3 = new Instance([[300, 300], [350, 350]], 0, 'user', 1.0);
                env.session.addUnlinkedInstance(0, 'cam1', inst3);
                var unlinked3 = env.fg.getUnlinkedInstances('cam1')[1];

                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                assertEqual(env.mgr.assignmentSelection.length, 1, '1 selected');
                assertEqual(env.mgr.assignmentSelection[0].id, env.unlinked1.id, 'first cam1');

                // Adding another from cam1 replaces (only one per camera)
                env.mgr.addToAssignmentSelection(unlinked3);
                assertEqual(env.mgr.assignmentSelection.length, 1, 'still 1 (replaced)');
                assertEqual(env.mgr.assignmentSelection[0].id, unlinked3.id, 'replaced with new');
            } finally {
                env.cleanup();
            }
        });

        it('addToAssignmentSelection allows multiple cameras', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                env.mgr.addToAssignmentSelection(env.unlinked2);
                assertEqual(env.mgr.assignmentSelection.length, 2, '2 selected from 2 cameras');
            } finally {
                env.cleanup();
            }
        });

        it('getAssignmentSelectedIds returns correct IDs', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                env.mgr.addToAssignmentSelection(env.unlinked2);

                var ids = env.mgr.getAssignmentSelectedIds();
                assertEqual(ids.length, 2, '2 IDs');
                assertTrue(ids.indexOf(env.unlinked1.id) >= 0, 'includes unlinked1 id');
                assertTrue(ids.indexOf(env.unlinked2.id) >= 0, 'includes unlinked2 id');
            } finally {
                env.cleanup();
            }
        });
    });

    // ================================================================
    // Test suite 3: Hit testing for unlinked instances
    // ================================================================

    describe('Assignment - hit testing unlinked instances', function () {

        it('findNearestUnlinkedNode finds unlinked instance by position', function () {
            var env = buildEnv();
            try {
                // inst1 has a point at [100, 100] in cam1
                var hit = env.mgr.findNearestUnlinkedNode(100, 100, 'cam1', 0);
                assertNotNull(hit, 'should find unlinked node at (100,100)');
                assertEqual(hit.unlinked.id, env.unlinked1.id, 'correct unlinked instance');
                assertEqual(hit.nodeIdx, 0, 'correct node index');
            } finally {
                env.cleanup();
            }
        });

        it('findNearestUnlinkedNode returns null when too far', function () {
            var env = buildEnv();
            try {
                // Click far from any point
                var hit = env.mgr.findNearestUnlinkedNode(500, 400, 'cam1', 0);
                assertNull(hit, 'should not find anything far away');
            } finally {
                env.cleanup();
            }
        });

        it('findNearestUnlinkedNode finds correct camera', function () {
            var env = buildEnv();
            try {
                // inst2 has a point at [200, 200] in cam2
                var hit = env.mgr.findNearestUnlinkedNode(200, 200, 'cam2', 0);
                assertNotNull(hit, 'should find unlinked node in cam2');
                assertEqual(hit.unlinked.id, env.unlinked2.id, 'correct cam2 unlinked');
            } finally {
                env.cleanup();
            }
        });
    });

    // ================================================================
    // Test suite 4: Click to select in assignment mode
    // ================================================================

    describe('Assignment - click to select unlinked', function () {

        it('clicking unlinked node in assignment mode adds to selection', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);

                // Click at (100, 100) which is exactly at inst1's nose point in cam1
                env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), 'cam1');

                assertEqual(env.mgr.assignmentSelection.length, 1,
                    'should have 1 in selection after click');
                assertEqual(env.mgr.assignmentSelection[0].id, env.unlinked1.id,
                    'should select the correct unlinked instance');
                assertTrue(env.mgr.assignmentMode,
                    'should remain in assignment mode after selection');
            } finally {
                env.cleanup();
            }
        });

        it('clicking second camera unlinked adds both to selection', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);

                // Click cam1 unlinked at video (100,100) → client (100,100)
                env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), 'cam1');
                assertEqual(env.mgr.assignmentSelection.length, 1, 'cam1 selected');

                // Click cam2 unlinked at video (200,200) → client (640+200, 200)
                // because cam2 canvas is offset 640px to the right
                env.mgr.onMouseDown(makeMouseEvent('mousedown', 840, 200), 'cam2');
                assertEqual(env.mgr.assignmentSelection.length, 2, 'cam1 + cam2 selected');
            } finally {
                env.cleanup();
            }
        });

        it('clicking empty space in assignment mode exits mode', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);

                // Click far from any node
                env.mgr.onMouseDown(makeMouseEvent('mousedown', 500, 400), 'cam1');

                assertFalse(env.mgr.assignmentMode,
                    'should exit assignment mode on empty click');
                assertEqual(env.mgr.assignmentSelection.length, 0,
                    'selection should be cleared');
            } finally {
                env.cleanup();
            }
        });

        it('assignment mode triggers redraw on selection', function () {
            var env = buildEnv();
            try {
                var before = env.getRedraws();
                env.mgr.setAssignmentMode(true);
                var afterMode = env.getRedraws();
                assertGreaterThan(afterMode, before, 'redraw after mode toggle');

                env.mgr.addToAssignmentSelection(env.unlinked1);
                var afterSelect = env.getRedraws();
                assertGreaterThan(afterSelect, afterMode, 'redraw after selection');
            } finally {
                env.cleanup();
            }
        });

        it('assignment mode prefers unlinked over linked when both nearby', function () {
            // BUG: When a linked node is near an unlinked node, clicking in
            // assignment mode would pick the linked node and EXIT assignment
            // mode instead of selecting the unlinked node.
            var vw = 640, vh = 480;
            var skeleton = new Skeleton('mouse', ['nose', 'head'], [[0, 1]]);
            var cameras = [
                new Camera('cam1',
                    [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh])
            ];
            var session = new Session(cameras, skeleton, ['track_0']);

            // Create a linked instance at (100, 100)
            var linkedInst = new Instance([[100, 100], [150, 150]], 0, 'user', 1.0);
            var fg = new FrameGroup(0);
            fg.addInstance('cam1', linkedInst);
            session.addFrameGroup(fg);

            // Create a linked InstanceGroup so findNearestNode can find it
            if (!session.instanceGroups.has(0)) session.instanceGroups.set(0, new Map());
            var trackMap = session.instanceGroups.get(0);
            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', linkedInst);
            if (!trackMap.has(0)) trackMap.set(0, []);
            trackMap.get(0).push(group);

            // Create an unlinked instance at (105, 105) - very close to linked
            var unlinkedInst = new Instance([[105, 105], [160, 160]], 0, 'user', 1.0);
            var ul = new UnlinkedInstance(unlinkedInst, 'cam1');
            fg.addUnlinkedInstance('cam1', ul);

            var canvas = createMockCanvas(vw, vh);
            var views = [
                { name: 'cam1', overlayCanvas: canvas, videoWidth: vw, videoHeight: vh },
            ];

            var mgr = new InteractionManager({
                getState: function () {
                    return { currentFrame: 0, session: session, views: views };
                },
                getInstanceGroups: function (frameIdx) {
                    return session.getInstanceGroupsForFrame(frameIdx || 0);
                },
                onSelectionChanged: function () {},
                onNodeMoved: function () {},
                requestRedraw: function () {},
            });
            mgr.attach(views);

            try {
                mgr.setAssignmentMode(true);

                // Click at (105, 105) - where both linked and unlinked are nearby
                mgr.onMouseDown(makeMouseEvent('mousedown', 105, 105), 'cam1');

                // Should stay in assignment mode and select the unlinked
                assertTrue(mgr.assignmentMode,
                    'should remain in assignment mode (not exit due to linked hit)');
                assertEqual(mgr.assignmentSelection.length, 1,
                    'should have 1 unlinked in selection');
                assertEqual(mgr.assignmentSelection[0].id, ul.id,
                    'should select the unlinked instance');
            } finally {
                mgr.detach();
                cleanupCanvases();
            }
        });
    });

    // ================================================================
    // Test suite 5: Group creation from assignment
    // ================================================================

    describe('Assignment - create group from selection', function () {

        it('Enter key creates group from assignment selection', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                env.mgr.addToAssignmentSelection(env.unlinked2);

                // Press Enter
                env.mgr.onKeyDown(makeKeyEvent('Enter'));

                // Assignment mode should be off
                assertFalse(env.mgr.assignmentMode, 'mode off after Enter');
                assertEqual(env.mgr.assignmentSelection.length, 0, 'selection cleared');

                // An InstanceGroup should have been created
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 1, 'one group created');

                // The group should have instances for both cameras
                assertNotNull(groups[0].getInstance('cam1'), 'group has cam1 instance');
                assertNotNull(groups[0].getInstance('cam2'), 'group has cam2 instance');

                // Unlinked instances should be removed
                var ulCam1 = env.fg.getUnlinkedInstances('cam1');
                var ulCam2 = env.fg.getUnlinkedInstances('cam2');
                assertEqual(ulCam1.length, 0, 'cam1 unlinked cleared');
                assertEqual(ulCam2.length, 0, 'cam2 unlinked cleared');
            } finally {
                env.cleanup();
            }
        });

        it('C key creates group from assignment selection', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);

                env.mgr.onKeyDown(makeKeyEvent('c'));

                assertFalse(env.mgr.assignmentMode, 'mode off after C');
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 1, 'group created');
            } finally {
                env.cleanup();
            }
        });

        it('Enter does nothing with empty selection', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                // No selection
                env.mgr.onKeyDown(makeKeyEvent('Enter'));

                // Mode should still be on
                assertTrue(env.mgr.assignmentMode, 'mode still on');
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 0, 'no group created');
            } finally {
                env.cleanup();
            }
        });
    });

    // ================================================================
    // Test suite 6: Assignment highlight rendering
    // ================================================================

    describe('Assignment - highlight rendering', function () {

        it('drawUnlinkedInstances uses assignment color for selected', function () {
            if (typeof drawUnlinkedInstances !== 'function') return;

            var canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            var ctx = canvas.getContext('2d');

            var skeleton = new Skeleton('mouse', ['nose', 'head'], [[0, 1]]);
            var inst = new Instance([[100, 100], [150, 150]], 0, 'user', 1.0);
            var ul = new UnlinkedInstance(inst, 'cam1');

            // Spy on fillStyle to detect assignment color
            var fillStyles = [];
            var origArc = ctx.arc.bind(ctx);
            ctx.arc = function (x, y, r, sa, ea) {
                fillStyles.push(ctx.fillStyle);
                return origArc(x, y, r, sa, ea);
            };

            // Draw with assignment selection
            drawUnlinkedInstances(ctx, [ul], skeleton, {
                nodeSize: 4,
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                assignmentSelectedIds: [ul.id],
                assignmentColor: '#fbbf24',
            });

            ctx.arc = origArc;

            // The fill style for nodes should be the assignment color (#fbbf24)
            var hasAssignColor = fillStyles.some(function (s) {
                return s === '#fbbf24';
            });
            assertTrue(hasAssignColor,
                'should use assignment color #fbbf24 for selected unlinked. Got styles: [' +
                fillStyles.join(', ') + ']');
        });

        it('drawUnlinkedInstances uses default color for unselected', function () {
            if (typeof drawUnlinkedInstances !== 'function') return;

            var canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            var ctx = canvas.getContext('2d');

            var skeleton = new Skeleton('mouse', ['nose', 'head'], [[0, 1]]);
            var inst = new Instance([[100, 100], [150, 150]], 0, 'user', 1.0);
            var ul = new UnlinkedInstance(inst, 'cam1');

            var fillStyles = [];
            var origArc = ctx.arc.bind(ctx);
            ctx.arc = function (x, y, r, sa, ea) {
                fillStyles.push(ctx.fillStyle);
                return origArc(x, y, r, sa, ea);
            };

            // Draw without assignment selection (empty array)
            drawUnlinkedInstances(ctx, [ul], skeleton, {
                nodeSize: 4,
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                assignmentSelectedIds: [],
            });

            ctx.arc = origArc;

            // Should NOT use assignment color
            var hasAssignColor = fillStyles.some(function (s) {
                return s === '#fbbf24';
            });
            assertFalse(hasAssignColor,
                'should NOT use assignment color for unselected unlinked');
        });

        it('selected unlinked instance has higher alpha', function () {
            if (typeof drawUnlinkedInstances !== 'function') return;

            var canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            var ctx = canvas.getContext('2d');

            var skeleton = new Skeleton('mouse', ['nose'], []);
            var inst = new Instance([[100, 100]], 0, 'user', 1.0);
            var ul = new UnlinkedInstance(inst, 'cam1');

            // Capture globalAlpha during arc calls
            var alphas = [];
            var origArc = ctx.arc.bind(ctx);
            ctx.arc = function (x, y, r, sa, ea) {
                alphas.push(ctx.globalAlpha);
                return origArc(x, y, r, sa, ea);
            };

            // Draw selected
            drawUnlinkedInstances(ctx, [ul], skeleton, {
                nodeSize: 4,
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                assignmentSelectedIds: [ul.id],
            });

            var selectedAlpha = alphas.length > 0 ? alphas[0] : 0;

            // Reset
            alphas = [];

            // Draw unselected
            drawUnlinkedInstances(ctx, [ul], skeleton, {
                nodeSize: 4,
                videoWidth: 640, videoHeight: 480,
                canvasWidth: 640, canvasHeight: 480,
                assignmentSelectedIds: [],
            });

            var unselectedAlpha = alphas.length > 0 ? alphas[0] : 0;

            ctx.arc = origArc;

            assertGreaterThan(selectedAlpha, unselectedAlpha,
                'selected alpha (' + selectedAlpha + ') should be > unselected (' + unselectedAlpha + ')');
        });
    });

    // ================================================================
    // Test suite 7: Full E2E assignment workflow
    // ================================================================

    describe('Assignment - full E2E workflow', function () {

        it('complete workflow: A -> click cam1 -> click cam2 -> Enter', function () {
            var env = buildEnv();
            try {
                // Verify initial state: 2 unlinked, 0 groups
                assertEqual(env.fg.getUnlinkedInstances('cam1').length, 1, 'cam1 has 1 unlinked');
                assertEqual(env.fg.getUnlinkedInstances('cam2').length, 1, 'cam2 has 1 unlinked');
                assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0, 'no groups yet');

                // Step 1: Enter assignment mode
                env.mgr.onKeyDown(makeKeyEvent('a'));
                assertTrue(env.mgr.assignmentMode, 'assignment mode active');

                // Step 2: Click cam1 unlinked instance at video (100,100) → client (100,100)
                env.mgr.onMouseDown(makeMouseEvent('mousedown', 100, 100), 'cam1');
                assertEqual(env.mgr.assignmentSelection.length, 1, 'cam1 selected');

                // Step 3: Click cam2 unlinked instance at video (200,200) → client (840,200)
                env.mgr.onMouseDown(makeMouseEvent('mousedown', 840, 200), 'cam2');
                assertEqual(env.mgr.assignmentSelection.length, 2, 'cam1 + cam2 selected');

                // Step 4: Press Enter to create group
                env.mgr.onKeyDown(makeKeyEvent('Enter'));
                assertFalse(env.mgr.assignmentMode, 'assignment mode exited');

                // Verify results
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 1, 'one group created');
                assertNotNull(groups[0].getInstance('cam1'), 'group has cam1');
                assertNotNull(groups[0].getInstance('cam2'), 'group has cam2');
                assertEqual(env.fg.getUnlinkedInstances('cam1').length, 0, 'cam1 unlinked removed');
                assertEqual(env.fg.getUnlinkedInstances('cam2').length, 0, 'cam2 unlinked removed');
            } finally {
                env.cleanup();
            }
        });

        it('N key creates unlinked instance that can be assigned', function () {
            if (typeof InteractionManager === 'undefined') return;

            var vw = 640, vh = 480;
            var skeleton = new Skeleton('mouse', ['nose', 'head'], [[0, 1]]);
            var cameras = [
                new Camera('cam1',
                    [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh])
            ];
            var session = new Session(cameras, skeleton, ['track_0']);
            // Ensure frame 0 exists
            session.addFrameGroup(new FrameGroup(0));

            var canvas = createMockCanvas(vw, vh);
            var views = [
                { name: 'cam1', overlayCanvas: canvas, videoWidth: vw, videoHeight: vh },
            ];

            var mgr = new InteractionManager({
                getState: function () {
                    return { currentFrame: 0, session: session, views: views };
                },
                getInstanceGroups: function (frameIdx) {
                    return session.getInstanceGroupsForFrame(frameIdx || 0);
                },
                onSelectionChanged: function () {},
                onNodeMoved: function () {},
                requestRedraw: function () {},
            });
            mgr.attach(views);
            mgr.lastInteractedView = 'cam1';

            try {
                // Press N to add new unlinked instance
                mgr.onKeyDown(makeKeyEvent('n'));

                var ulList = session.getFrameGroup(0).getUnlinkedInstances('cam1');
                assertEqual(ulList.length, 1, 'N creates 1 unlinked instance');

                // The unlinked instance should be findable
                var hit = mgr.findNearestUnlinkedNode(
                    ulList[0].instance.points[0][0],
                    ulList[0].instance.points[0][1],
                    'cam1', 0
                );
                assertNotNull(hit, 'new unlinked is findable by hit test');
            } finally {
                mgr.detach();
                cleanupCanvases();
            }
        });
    });

})();
