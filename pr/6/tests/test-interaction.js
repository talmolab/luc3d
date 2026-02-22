/**
 * test-interaction.js - Unit tests for interaction.js
 */

(function () {
    const { describe, it, beforeEach, assertEqual, assertDeepEqual, assertNotNull,
        assertNull, assertTrue, assertFalse } = TestFramework;

    // Helper: create a minimal mock state
    function createMockState() {
        const skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
        const cameras = [
            new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
        ];
        const session = new Session(cameras, skeleton, ['track_0']);
        return {
            currentFrame: 0,
            session: session,
            views: [{
                name: 'cam1',
                overlayCanvas: createMockCanvas(640, 480),
                videoWidth: 640,
                videoHeight: 480,
            }],
        };
    }

    function createMockCanvas(w, h) {
        // Create a real canvas element for testing
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        // Set CSS size to match (no zoom)
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        // Add to DOM temporarily so getBoundingClientRect works
        canvas.style.position = 'fixed';
        canvas.style.top = '0';
        canvas.style.left = '0';
        document.body.appendChild(canvas);
        return canvas;
    }

    function cleanupCanvases() {
        const canvases = document.querySelectorAll('canvas[style*="position: fixed"]');
        canvases.forEach(function (c) { c.remove(); });
    }

    describe('InteractionManager - canvasToVideo', function () {
        let manager;
        let mockState;

        beforeEach(function () {
            cleanupCanvases();
            mockState = createMockState();
            manager = new InteractionManager({
                getState: function () { return mockState; },
                getInstanceGroups: function () { return []; },
                requestRedraw: function () {},
            });
        });

        it('converts coordinates correctly at 1:1 scale', function () {
            const canvas = mockState.views[0].overlayCanvas;
            const rect = canvas.getBoundingClientRect();
            // Simulate click at center of canvas
            const clientX = rect.left + rect.width / 2;
            const clientY = rect.top + rect.height / 2;
            const [vx, vy] = manager.canvasToVideo(clientX, clientY, 'cam1');

            // At 1:1, center should be (320, 240) for 640x480 canvas
            assertTrue(Math.abs(vx - 320) < 5, 'X should be near 320, got ' + vx);
            assertTrue(Math.abs(vy - 240) < 5, 'Y should be near 240, got ' + vy);
        });

        it('converts top-left corner correctly', function () {
            const canvas = mockState.views[0].overlayCanvas;
            const rect = canvas.getBoundingClientRect();
            const [vx, vy] = manager.canvasToVideo(rect.left, rect.top, 'cam1');
            assertTrue(Math.abs(vx) < 5, 'Top-left X should be near 0, got ' + vx);
            assertTrue(Math.abs(vy) < 5, 'Top-left Y should be near 0, got ' + vy);
        });

        it('returns input for unknown view', function () {
            const [vx, vy] = manager.canvasToVideo(100, 200, 'nonexistent');
            assertEqual(vx, 100);
            assertEqual(vy, 200);
        });
    });

    describe('InteractionManager - findNearestNode', function () {
        let manager;
        let mockState;

        beforeEach(function () {
            cleanupCanvases();
            mockState = createMockState();

            // Create an instance group with known node positions
            const inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1);
            const group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst);
            mockState.session.instanceGroups.set(0, new Map([[0, [group]]]));

            // Also add to frame group for rendering
            const fg = new FrameGroup(0);
            fg.addInstance('cam1', inst);
            mockState.session.addFrameGroup(fg);

            manager = new InteractionManager({
                getState: function () { return mockState; },
                getInstanceGroups: function (frameIdx) {
                    return mockState.session.getInstanceGroupsForFrame(frameIdx);
                },
                requestRedraw: function () {},
            });
        });

        it('finds node at exact position', function () {
            const hit = manager.findNearestNode(100, 100, 'cam1', 0);
            assertNotNull(hit);
            assertEqual(hit.nodeIdx, 0);
            assertTrue(hit.distance < 1);
        });

        it('finds node within threshold', function () {
            const hit = manager.findNearestNode(105, 105, 'cam1', 0);
            assertNotNull(hit);
            assertEqual(hit.nodeIdx, 0);
        });

        it('returns null when far from all nodes', function () {
            const hit = manager.findNearestNode(500, 500, 'cam1', 0);
            assertNull(hit);
        });

        it('returns closest node when multiple are near', function () {
            // Node 0 is at (100,100), node 1 is at (200,200).
            // Increase threshold so BOTH nodes are within range, then verify
            // the closer one is returned. Click at (140,140):
            //   dist to node 0 = sqrt(40^2+40^2) ≈ 56.6
            //   dist to node 1 = sqrt(60^2+60^2) ≈ 84.9
            manager.hitThreshold = 500;
            const hit = manager.findNearestNode(140, 140, 'cam1', 0);
            assertNotNull(hit, 'Should find a node within threshold');
            assertEqual(hit.nodeIdx, 0, 'Should find the closer node (0)');
        });
    });

    describe('InteractionManager - selection', function () {
        let manager;
        let lastSelection = { group: null, nodeIdx: -1 };

        beforeEach(function () {
            cleanupCanvases();
            const mockState = createMockState();
            manager = new InteractionManager({
                getState: function () { return mockState; },
                getInstanceGroups: function () { return []; },
                onSelectionChanged: function (group, nodeIdx) {
                    lastSelection = { group: group, nodeIdx: nodeIdx };
                },
                requestRedraw: function () {},
            });
        });

        it('select sets selection state', function () {
            const group = new InstanceGroup(1, 0);
            manager.select(group, 2);
            assertEqual(manager.selectedInstanceGroup, group);
            assertEqual(manager.selectedNodeIdx, 2);
        });

        it('clearSelection resets state', function () {
            const group = new InstanceGroup(1, 0);
            manager.select(group, 2);
            manager.clearSelection();
            assertNull(manager.selectedInstanceGroup);
            assertEqual(manager.selectedNodeIdx, -1);
        });

        it('onSelectionChanged callback fires', function () {
            const group = new InstanceGroup(1, 0);
            manager.select(group, 1);
            assertEqual(lastSelection.group, group);
            assertEqual(lastSelection.nodeIdx, 1);
        });
    });

    describe('InteractionManager - deleteSelected', function () {
        let manager;
        let mockState;
        let deleteCallbackCalled = false;

        beforeEach(function () {
            cleanupCanvases();
            mockState = createMockState();
            deleteCallbackCalled = false;

            // Create instance data
            const inst = new Instance([[100, 200], [300, 400]], 0, 'user', 1);
            const group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst);

            const fg = new FrameGroup(0);
            fg.addInstance('cam1', inst);
            mockState.session.addFrameGroup(fg);
            mockState.session.instanceGroups.set(0, new Map([[0, [group]]]));

            manager = new InteractionManager({
                getState: function () { return mockState; },
                getInstanceGroups: function (frameIdx) {
                    return mockState.session.getInstanceGroupsForFrame(frameIdx);
                },
                onSelectionChanged: function () {},
                onInstanceDeleted: function () {
                    deleteCallbackCalled = true;
                },
                requestRedraw: function () {},
            });

            manager.select(group, 0);
        });

        it('actually removes instance group from session', function () {
            assertEqual(mockState.session.getInstanceGroupsForFrame(0).length, 1);
            manager._deleteSelected();
            assertEqual(mockState.session.getInstanceGroupsForFrame(0).length, 0);
        });

        it('clears selection after delete', function () {
            manager._deleteSelected();
            assertNull(manager.selectedInstanceGroup);
        });

        it('fires onInstanceDeleted callback', function () {
            manager._deleteSelected();
            assertTrue(deleteCallbackCalled);
        });

        it('does nothing when no selection', function () {
            manager.clearSelection();
            manager._deleteSelected(); // should not throw
            assertEqual(mockState.session.getInstanceGroupsForFrame(0).length, 1);
        });
    });

    describe('InteractionManager - assignment mode', function () {
        let manager;

        beforeEach(function () {
            cleanupCanvases();
            const mockState = createMockState();
            manager = new InteractionManager({
                getState: function () { return mockState; },
                getInstanceGroups: function () { return []; },
                onSelectionChanged: function () {},
                requestRedraw: function () {},
            });
        });

        it('setAssignmentMode toggles mode', function () {
            assertFalse(manager.assignmentMode);
            manager.setAssignmentMode(true);
            assertTrue(manager.assignmentMode);
            manager.setAssignmentMode(false);
            assertFalse(manager.assignmentMode);
        });

        it('addToAssignmentSelection adds unique instances', function () {
            manager.setAssignmentMode(true);
            const ul1 = new UnlinkedInstance(new Instance([], 0, 'predicted', 0.9), 'cam1');
            const ul2 = new UnlinkedInstance(new Instance([], 0, 'predicted', 0.8), 'cam2');
            manager.addToAssignmentSelection(ul1);
            manager.addToAssignmentSelection(ul2);
            assertEqual(manager.assignmentSelection.length, 2);
        });
    });
})();
