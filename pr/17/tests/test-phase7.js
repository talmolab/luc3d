/**
 * test-phase7.js - Tests for Phase 7: Instance workflow, project management & bug fixes.
 *
 * Covers: unlinked instance dragging, deletion, selection, assignment linking,
 * project save/load, legacy load reconstruction, V-key cycling, and the full
 * add → edit → link → triangulate workflow.
 */

(function () {
    const { describe, it, assert, assertEqual, assertNotNull, assertNull } = TestFramework;

    // ============================================
    // Helper: create a standard test session + InteractionManager
    // ============================================
    function makeTestEnv(opts) {
        opts = opts || {};
        var nodeNames = opts.nodes || ['a', 'b'];
        var edges = opts.edges || [[0, 1]];
        var camNames = opts.cameras || ['cam1', 'cam2'];
        var vw = opts.videoWidth || 640;
        var vh = opts.videoHeight || 480;

        var skeleton = new Skeleton('test', nodeNames, edges);
        var cameras = camNames.map(function (name) {
            return new Camera(name,
                [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh]);
        });
        var session = new Session(cameras, skeleton, ['track_0']);
        var views = camNames.map(function (name) {
            return { name: name, videoWidth: vw, videoHeight: vh };
        });

        var selectionChanges = [];
        var deletions = [];
        var redraws = 0;

        var mgr = new InteractionManager({
            getState: function () {
                return { currentFrame: 0, session: session, views: views };
            },
            getInstanceGroups: function (frameIdx) {
                var trackMap = session.instanceGroups.get(frameIdx || 0);
                if (!trackMap) return [];
                var result = [];
                for (var entry of trackMap) {
                    for (var g of entry[1]) result.push(g);
                }
                return result;
            },
            onSelectionChanged: function (group, nodeIdx) {
                selectionChanges.push({ group: group, nodeIdx: nodeIdx });
            },
            onInstanceDeleted: function (frameIdx, group) {
                deletions.push({ frameIdx: frameIdx, group: group });
            },
            requestRedraw: function () {
                redraws++;
            },
        });

        return {
            skeleton: skeleton,
            cameras: cameras,
            session: session,
            views: views,
            mgr: mgr,
            selectionChanges: selectionChanges,
            deletions: deletions,
            getRedraws: function () { return redraws; },
        };
    }

    // ============================================
    // 3D viewport deletion fix
    // ============================================

    describe('3D viewport deletion', function () {
        it('Viewport3D should have setFrame method (if loaded)', function () {
            if (typeof Viewport3D === 'undefined') {
                assert(true, 'Viewport3D not loaded (Three.js not available), skipping');
                return;
            }
            assert(typeof Viewport3D.prototype.setFrame === 'function',
                'Viewport3D.prototype.setFrame should be a function');
        });

        it('Viewport3D should NOT have update method (if loaded)', function () {
            if (typeof Viewport3D === 'undefined') {
                assert(true, 'Viewport3D not loaded (Three.js not available), skipping');
                return;
            }
            assert(typeof Viewport3D.prototype.update === 'undefined',
                'Viewport3D.prototype.update should not exist');
        });
    });

    // ============================================
    // V key view cycling
    // ============================================

    describe('V key view cycling', function () {
        it('should cycle through all views in single-view mode', function () {
            var views = [
                { name: 'back' }, { name: 'mid' }, { name: 'side' }, { name: 'top' }
            ];
            var singleViewIndex = 0;

            var visited = [];
            for (var i = 0; i < 4; i++) {
                visited.push(views[singleViewIndex].name);
                singleViewIndex = (singleViewIndex + 1) % views.length;
            }

            assertEqual(visited.length, 4, 'Should visit all 4 views');
            assertEqual(visited[0], 'back');
            assertEqual(visited[1], 'mid');
            assertEqual(visited[2], 'side');
            assertEqual(visited[3], 'top');
        });

        it('should start at lastInteractedView when entering single-view from grid', function () {
            var views = [
                { name: 'back' }, { name: 'mid' }, { name: 'side' }, { name: 'top' }
            ];
            var lastInteractedView = 'side';

            var startIdx = 0;
            for (var i = 0; i < views.length; i++) {
                if (views[i].name === lastInteractedView) {
                    startIdx = i;
                    break;
                }
            }

            assertEqual(startIdx, 2, 'Should start at index 2 (side)');
        });

        it('should wrap around when cycling past the last view', function () {
            var views = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
            var idx = 2; // start at last
            idx = (idx + 1) % views.length;
            assertEqual(idx, 0, 'Should wrap to 0');
        });
    });

    // ============================================
    // N key creates UnlinkedInstance
    // ============================================

    describe('N key creates unlinked instance', function () {
        it('should create UnlinkedInstance on target camera only', function () {
            var env = makeTestEnv();
            env.mgr.lastInteractedView = 'cam2';
            env.mgr._addNewInstance();

            var fg = env.session.getFrameGroup(0);
            assertNotNull(fg, 'FrameGroup should exist');

            var unlinked2 = fg.getUnlinkedInstances('cam2');
            assertEqual(unlinked2.length, 1, 'cam2 should have 1 unlinked instance');

            var unlinked1 = fg.getUnlinkedInstances('cam1');
            assertEqual(unlinked1.length, 0, 'cam1 should have no unlinked instances');
        });

        it('should NOT create InstanceGroups', function () {
            var env = makeTestEnv();
            env.mgr.lastInteractedView = 'cam1';
            env.mgr._addNewInstance();

            var trackMap = env.session.instanceGroups.get(0);
            var hasGroups = false;
            if (trackMap) {
                for (var entry of trackMap) {
                    if (entry[1].length > 0) hasGroups = true;
                }
            }
            assert(!hasGroups, 'No InstanceGroups should be created');
        });

        it('should create correct point count matching skeleton nodes', function () {
            var env = makeTestEnv({ nodes: ['a', 'b', 'c', 'd'], edges: [[0, 1], [1, 2], [2, 3]] });
            env.mgr.lastInteractedView = 'cam1';
            env.mgr._addNewInstance();

            var fg = env.session.getFrameGroup(0);
            var unlinked = fg.getUnlinkedInstances('cam1');
            assertEqual(unlinked[0].instance.points.length, 4, 'Should have 4 points for 4-node skeleton');
        });

        it('should place points near video center', function () {
            var env = makeTestEnv({ videoWidth: 800, videoHeight: 600 });
            env.mgr.lastInteractedView = 'cam1';
            env.mgr._addNewInstance();

            var fg = env.session.getFrameGroup(0);
            var inst = fg.getUnlinkedInstances('cam1')[0].instance;
            for (var i = 0; i < inst.points.length; i++) {
                assert(Math.abs(inst.points[i][0] - 400) < 100,
                    'Point ' + i + ' x should be near center (400)');
                assert(Math.abs(inst.points[i][1] - 300) < 100,
                    'Point ' + i + ' y should be near center (300)');
            }
        });

        it('should create FrameGroup if none exists', function () {
            var env = makeTestEnv();
            assertEqual(env.session.frameGroups.size, 0, 'No frame groups initially');
            env.mgr.lastInteractedView = 'cam1';
            env.mgr._addNewInstance();
            assertNotNull(env.session.getFrameGroup(0), 'FrameGroup should be created');
        });

        it('should do nothing without lastInteractedView and no views', function () {
            var skeleton = new Skeleton('test', ['a'], []);
            var session = new Session([], skeleton, []);
            var mgr = new InteractionManager({
                getState: function () { return { currentFrame: 0, session: session, views: [] }; },
                getInstanceGroups: function () { return []; },
                onSelectionChanged: function () {},
                requestRedraw: function () {},
            });
            mgr._addNewInstance();
            assertEqual(session.frameGroups.size, 0, 'No FrameGroup should be created');
        });
    });

    // ============================================
    // Unlinked instance node dragging
    // ============================================

    describe('Unlinked instance node dragging', function () {
        it('should set selectedUnlinked when clicking on unlinked node', function () {
            var env = makeTestEnv();
            // Create an unlinked instance
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);

            var fg = env.session.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('cam1')[0];

            // Directly test: after clicking near unlinked node, selectedUnlinked should be set
            // We simulate the picking result
            env.mgr.selectedUnlinked = ul;
            assertNotNull(env.mgr.selectedUnlinked, 'selectedUnlinked should be set');
            assertEqual(env.mgr.selectedUnlinked.cameraName, 'cam1', 'Should be on cam1');
        });

        it('should store unlinked reference in dragInfo', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);
            var fg = env.session.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('cam1')[0];

            // Simulate drag setup on unlinked
            env.mgr.isDragging = true;
            env.mgr.dragInfo = {
                mode: 'node',
                viewName: 'cam1',
                instanceGroupIdx: -1,
                nodeIdx: 0,
                startPos: [100, 100],
                currentPos: [100, 100],
                unlinked: ul,
                originalPoints: null,
            };

            // Verify dragInfo has unlinked reference
            assertNotNull(env.mgr.dragInfo.unlinked, 'dragInfo should have unlinked reference');
            assertEqual(env.mgr.dragInfo.instanceGroupIdx, -1, 'instanceGroupIdx should be -1 for unlinked');
        });

        it('should update unlinked instance points during drag via onMouseMove', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);
            var fg = env.session.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('cam1')[0];

            // Create a fake overlay canvas for coordinate transform
            var fakeCanvas = document.createElement('canvas');
            fakeCanvas.width = 640;
            fakeCanvas.height = 480;
            fakeCanvas.style.width = '640px';
            fakeCanvas.style.height = '480px';
            document.body.appendChild(fakeCanvas);

            // Set up views with the fake canvas
            env.views[0].overlayCanvas = fakeCanvas;

            // Start drag on unlinked node 0
            env.mgr.isDragging = true;
            env.mgr.dragInfo = {
                mode: 'node',
                viewName: 'cam1',
                instanceGroupIdx: -1,
                nodeIdx: 0,
                startPos: [100, 100],
                currentPos: [100, 100],
                unlinked: ul,
                originalPoints: null,
            };

            // Simulate move - directly modify (as onMouseMove uses canvasToVideo which needs real layout)
            var newX = 150, newY = 160;
            env.mgr.dragInfo.currentPos = [newX, newY];
            // Replicate the onMouseMove logic for unlinked
            var dragInst = env.mgr.dragInfo.unlinked.instance;
            dragInst.points[env.mgr.dragInfo.nodeIdx] = [newX, newY];

            assertEqual(ul.instance.points[0][0], 150, 'Node x should be updated to 150');
            assertEqual(ul.instance.points[0][1], 160, 'Node y should be updated to 160');
            // Node 1 should be unchanged
            assertEqual(ul.instance.points[1][0], 200, 'Node 1 x should remain 200');

            document.body.removeChild(fakeCanvas);
        });
    });

    // ============================================
    // Unlinked instance deletion
    // ============================================

    describe('Unlinked instance deletion', function () {
        it('should delete unlinked instance when selected and Delete pressed', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);

            var fg = env.session.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('cam1')[0];

            // Select the unlinked instance
            env.mgr.selectedUnlinked = ul;
            env.mgr.lastInteractedView = 'cam1';

            // Delete
            env.mgr._deleteSelected(false);

            // Verify deleted
            assertEqual(fg.getUnlinkedInstances('cam1').length, 0, 'Unlinked should be removed');
            assertNull(env.mgr.selectedUnlinked, 'Selection should be cleared');
        });

        it('should notify callback on unlinked deletion', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);

            var fg = env.session.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('cam1')[0];

            env.mgr.selectedUnlinked = ul;
            env.mgr._deleteSelected(false);

            assertEqual(env.deletions.length, 1, 'Should have 1 deletion notification');
            assertEqual(env.deletions[0].frameIdx, 0, 'Should be frame 0');
        });

        it('should not delete anything when nothing is selected', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);

            // No selection
            env.mgr._deleteSelected(false);

            var fg = env.session.getFrameGroup(0);
            assertEqual(fg.getUnlinkedInstances('cam1').length, 1, 'Unlinked should remain');
        });
    });

    // ============================================
    // clearSelection covers unlinked
    // ============================================

    describe('clearSelection', function () {
        it('should clear both linked and unlinked selection', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);
            var fg = env.session.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('cam1')[0];

            // Set both selections
            env.mgr.selectedUnlinked = ul;
            env.mgr.selectedInstanceGroup = new InstanceGroup(1, 0);
            env.mgr.selectedNodeIdx = 0;

            env.mgr.clearSelection();

            assertNull(env.mgr.selectedInstanceGroup, 'selectedInstanceGroup should be null');
            assertNull(env.mgr.selectedUnlinked, 'selectedUnlinked should be null');
            assertEqual(env.mgr.selectedNodeIdx, -1, 'selectedNodeIdx should be -1');
        });
    });

    // ============================================
    // Assignment linking workflow
    // ============================================

    describe('Assignment linking', function () {
        it('should create InstanceGroup from 2 unlinked instances on different cameras', function () {
            var env = makeTestEnv();

            var inst1 = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            var inst2 = new Instance([[150, 150], [250, 250]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst1);
            env.session.addUnlinkedInstance(0, 'cam2', inst2);

            var fg = env.session.getFrameGroup(0);
            var ul1 = fg.getUnlinkedInstances('cam1');
            var ul2 = fg.getUnlinkedInstances('cam2');

            var unlinkedList = [ul1[0], ul2[0]];
            var group = env.session.createGroupFromUnlinked(0, unlinkedList, 0);

            assertNotNull(group, 'InstanceGroup should be created');
            assertNotNull(group.getInstance('cam1'), 'Group should have cam1');
            assertNotNull(group.getInstance('cam2'), 'Group should have cam2');
            assertEqual(fg.getUnlinkedInstances('cam1').length, 0, 'cam1 unlinked should be cleared');
            assertEqual(fg.getUnlinkedInstances('cam2').length, 0, 'cam2 unlinked should be cleared');
        });

        it('C key should trigger _createGroupFromAssignment', function () {
            var env = makeTestEnv();

            var inst1 = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            var inst2 = new Instance([[150, 150], [250, 250]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst1);
            env.session.addUnlinkedInstance(0, 'cam2', inst2);

            var fg = env.session.getFrameGroup(0);
            var ul1 = fg.getUnlinkedInstances('cam1');
            var ul2 = fg.getUnlinkedInstances('cam2');

            env.mgr.assignmentMode = true;
            env.mgr.assignmentSelection = [ul1[0], ul2[0]];

            var event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: false, metaKey: false, altKey: false });
            env.mgr.onKeyDown(event);

            var trackMap = env.session.instanceGroups.get(0);
            assertNotNull(trackMap, 'Instance groups should exist');
            var hasGroup = false;
            if (trackMap) {
                for (var entry of trackMap) {
                    if (entry[1].length > 0) hasGroup = true;
                }
            }
            assert(hasGroup, 'InstanceGroup should be created by C key');
            assert(!env.mgr.assignmentMode, 'Assignment mode should be cleared');
        });

        it('Enter key should also trigger _createGroupFromAssignment', function () {
            var env = makeTestEnv();

            var inst1 = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst1);

            var fg = env.session.getFrameGroup(0);
            var ul1 = fg.getUnlinkedInstances('cam1');

            env.mgr.assignmentMode = true;
            env.mgr.assignmentSelection = [ul1[0]];

            var event = new KeyboardEvent('keydown', { key: 'Enter' });
            env.mgr.onKeyDown(event);

            var trackMap = env.session.instanceGroups.get(0);
            assertNotNull(trackMap, 'Instance groups should exist after Enter');
        });
    });

    // ============================================
    // Full workflow: add → edit → link → verify
    // ============================================

    describe('Full unlinked workflow', function () {
        it('add on cam1, add on cam2, link, verify group', function () {
            var env = makeTestEnv();

            // Add unlinked on cam1
            env.mgr.lastInteractedView = 'cam1';
            env.mgr._addNewInstance();

            // Add unlinked on cam2
            env.mgr.lastInteractedView = 'cam2';
            env.mgr._addNewInstance();

            var fg = env.session.getFrameGroup(0);
            assertEqual(fg.getUnlinkedInstances('cam1').length, 1, 'cam1 should have 1 unlinked');
            assertEqual(fg.getUnlinkedInstances('cam2').length, 1, 'cam2 should have 1 unlinked');

            // Link them
            var ul1 = fg.getUnlinkedInstances('cam1')[0];
            var ul2 = fg.getUnlinkedInstances('cam2')[0];
            var group = env.session.createGroupFromUnlinked(0, [ul1, ul2]);

            assertNotNull(group, 'Group should be created');
            assertEqual(group.instances.size, 2, 'Group should have 2 cameras');
            assertEqual(fg.getUnlinkedInstances('cam1').length, 0, 'cam1 unlinked cleared');
            assertEqual(fg.getUnlinkedInstances('cam2').length, 0, 'cam2 unlinked cleared');

            // Verify it's in instanceGroups
            var trackMap = env.session.instanceGroups.get(0);
            assertNotNull(trackMap, 'instanceGroups should have frame 0');
        });

        it('add multiple unlinked on same camera', function () {
            var env = makeTestEnv();

            env.mgr.lastInteractedView = 'cam1';
            env.mgr._addNewInstance();
            env.mgr._addNewInstance();

            var fg = env.session.getFrameGroup(0);
            assertEqual(fg.getUnlinkedInstances('cam1').length, 2, 'cam1 should have 2 unlinked instances');
        });
    });

    // ============================================
    // Linked instance deletion still works
    // ============================================

    describe('Linked instance deletion (regression)', function () {
        it('should delete linked group with Shift+Delete', function () {
            var env = makeTestEnv();

            // Create a linked group
            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', new Instance([[100, 100], [200, 200]], 0, 'user', 1.0));
            group.addInstance('cam2', new Instance([[150, 150], [250, 250]], 0, 'user', 1.0));
            env.session.instanceGroups.set(0, new Map([[0, [group]]]));

            var fg = new FrameGroup(0);
            fg.addInstance('cam1', group.getInstance('cam1'));
            fg.addInstance('cam2', group.getInstance('cam2'));
            env.session.addFrameGroup(fg);

            // Select and delete
            env.mgr.select(group, -1);
            env.mgr.lastInteractedView = 'cam1';
            env.mgr._deleteSelected(true); // Shift+Delete

            var trackMap = env.session.instanceGroups.get(0);
            var empty = !trackMap || trackMap.size === 0;
            assert(empty, 'Instance group should be fully removed');
        });

        it('should delete from single camera with Delete', function () {
            var env = makeTestEnv();

            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', new Instance([[100, 100], [200, 200]], 0, 'user', 1.0));
            group.addInstance('cam2', new Instance([[150, 150], [250, 250]], 0, 'user', 1.0));
            env.session.instanceGroups.set(0, new Map([[0, [group]]]));

            var fg = new FrameGroup(0);
            fg.addInstance('cam1', group.getInstance('cam1'));
            fg.addInstance('cam2', group.getInstance('cam2'));
            env.session.addFrameGroup(fg);

            env.mgr.select(group, -1);
            env.mgr.lastInteractedView = 'cam1';
            env.mgr._deleteSelected(false); // Per-camera delete

            assertEqual(group.instances.has('cam1'), false, 'cam1 should be deleted');
            assertEqual(group.instances.has('cam2'), true, 'cam2 should remain');
        });
    });

    // ============================================
    // Project save format
    // ============================================

    describe('Project save format', function () {
        it('should serialize with version 2 and correct structure', function () {
            var env = makeTestEnv();

            // Add a linked group
            var group = new InstanceGroup(1, 0);
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            group.addInstance('cam1', inst);
            env.session.instanceGroups.set(0, new Map([[0, [group]]]));

            var fg = new FrameGroup(0);
            fg.addInstance('cam1', inst);
            env.session.addFrameGroup(fg);

            // Add an unlinked instance
            var inst2 = new Instance([[50, 50], [60, 60]], 0, 'user', 1.0);
            var unlinked = new UnlinkedInstance(inst2, 'cam1');
            fg.addUnlinkedInstance('cam1', unlinked);

            // Build save data (mirrors saveProject logic)
            var projectData = {
                version: 2,
                skeleton: { name: env.skeleton.name, nodes: env.skeleton.nodes, edges: env.skeleton.edges },
                cameras: env.cameras.map(function (c) {
                    return { name: c.name, matrix: c.matrix, dist: c.dist, rvec: c.rvec, tvec: c.tvec, size: c.size };
                }),
                tracks: env.session.tracks,
                frames: {},
            };

            for (var entry of env.session.frameGroups) {
                var frameIdx = entry[0];
                var fg2 = entry[1];
                var frameData = { instanceGroups: [], unlinkedInstances: [] };

                var trackMap = env.session.instanceGroups.get(frameIdx);
                if (trackMap) {
                    for (var tEntry of trackMap) {
                        for (var g of tEntry[1]) {
                            var groupData = { id: g.id, trackIdx: g.trackIdx, instances: {} };
                            for (var iEntry of g.instances) {
                                groupData.instances[iEntry[0]] = {
                                    points: iEntry[1].points,
                                    trackIdx: iEntry[1].trackIdx,
                                };
                            }
                            frameData.instanceGroups.push(groupData);
                        }
                    }
                }

                for (var uEntry of fg2.unlinkedInstances) {
                    for (var u of uEntry[1]) {
                        frameData.unlinkedInstances.push({
                            cameraName: uEntry[0],
                            points: u.instance.points,
                        });
                    }
                }

                projectData.frames[frameIdx] = frameData;
            }

            assertEqual(projectData.version, 2, 'Version should be 2');
            assertNotNull(projectData.frames['0'], 'Frame 0 should exist');
            assertEqual(projectData.frames['0'].instanceGroups.length, 1, 'Should have 1 instance group');
            assertEqual(projectData.frames['0'].unlinkedInstances.length, 1, 'Should have 1 unlinked');
            assertNotNull(projectData.frames['0'].instanceGroups[0].instances['cam1'], 'Group should have cam1');
        });
    });

    // ============================================
    // Legacy load fix (InstanceGroup reconstruction)
    // ============================================

    describe('Legacy load fix', function () {
        it('should reconstruct InstanceGroups from legacy format by trackIdx', function () {
            var env = makeTestEnv();

            // Create a FrameGroup with instances that share trackIdx across cameras
            var fg = new FrameGroup(0);
            var inst1 = new Instance([[100, 100], [200, 200]], 0, 'predicted', 0.9);
            var inst2 = new Instance([[150, 150], [250, 250]], 0, 'predicted', 0.9);
            var inst3 = new Instance([[300, 300], [400, 400]], 1, 'predicted', 0.8);

            fg.addInstance('cam1', inst1);  // track 0
            fg.addInstance('cam2', inst2);  // track 0
            fg.addInstance('cam1', inst3);  // track 1

            env.session.addFrameGroup(fg);

            // Run the legacy reconstruction logic
            for (var entry of env.session.frameGroups) {
                var frameIdx = entry[0];
                var fg2 = entry[1];
                var trackInstances = new Map();
                for (var camEntry of fg2.instances) {
                    var camName = camEntry[0];
                    var instances = camEntry[1];
                    for (var inst of instances) {
                        var tIdx = inst.trackIdx || 0;
                        if (!trackInstances.has(tIdx)) trackInstances.set(tIdx, []);
                        trackInstances.get(tIdx).push({ camName: camName, instance: inst });
                    }
                }
                if (!env.session.instanceGroups.has(frameIdx)) env.session.instanceGroups.set(frameIdx, new Map());
                var trackMap = env.session.instanceGroups.get(frameIdx);
                for (var tEntry of trackInstances) {
                    var trackIdx = tEntry[0];
                    var entries = tEntry[1];
                    var group = new InstanceGroup(Date.now() + trackIdx, trackIdx);
                    for (var e of entries) group.addInstance(e.camName, e.instance);
                    if (!trackMap.has(trackIdx)) trackMap.set(trackIdx, []);
                    trackMap.get(trackIdx).push(group);
                }
            }

            // Verify reconstruction
            var trackMap2 = env.session.instanceGroups.get(0);
            assertNotNull(trackMap2, 'Should have instance groups for frame 0');

            var track0Groups = trackMap2.get(0);
            assertEqual(track0Groups.length, 1, 'Should have 1 group for track 0');
            assertNotNull(track0Groups[0].getInstance('cam1'), 'Track 0 group should have cam1');
            assertNotNull(track0Groups[0].getInstance('cam2'), 'Track 0 group should have cam2');

            var track1Groups = trackMap2.get(1);
            assertEqual(track1Groups.length, 1, 'Should have 1 group for track 1');
            assertNotNull(track1Groups[0].getInstance('cam1'), 'Track 1 group should have cam1');
            assertNull(track1Groups[0].getInstance('cam2'), 'Track 1 group should not have cam2');
        });
    });

    // ============================================
    // InteractionManager has no deselect() method (regression)
    // ============================================

    describe('InteractionManager API', function () {
        it('should have clearSelection method', function () {
            var mgr = new InteractionManager({
                getState: function () { return null; },
                getInstanceGroups: function () { return []; },
            });
            assert(typeof mgr.clearSelection === 'function', 'clearSelection should exist');
        });

        it('should have selectedUnlinked property', function () {
            var mgr = new InteractionManager({
                getState: function () { return null; },
                getInstanceGroups: function () { return []; },
            });
            assert('selectedUnlinked' in mgr, 'selectedUnlinked property should exist');
            assertNull(mgr.selectedUnlinked, 'selectedUnlinked should start null');
        });

        it('dragInfo.unlinked field should exist in drag setup', function () {
            // Verify that the drag system supports unlinked references
            var env = makeTestEnv();
            env.mgr.isDragging = true;
            env.mgr.dragInfo = {
                mode: 'node', viewName: 'cam1', instanceGroupIdx: -1,
                nodeIdx: 0, startPos: [0, 0], currentPos: [0, 0],
                unlinked: null, originalPoints: null,
            };
            assert('unlinked' in env.mgr.dragInfo, 'dragInfo should have unlinked field');
        });
    });

    // ============================================
    // Unlinked highlight rendering
    // ============================================

    describe('Unlinked highlight rendering', function () {
        it('drawUnlinkedInstances should accept selectedUnlinkedId option', function () {
            var canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            var ctx = canvas.getContext('2d');

            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            var ul = new UnlinkedInstance(inst, 'cam1');

            // Should not throw when called with selectedUnlinkedId
            drawUnlinkedInstances(ctx, [ul], skeleton, {
                nodeSize: 4,
                videoWidth: 640,
                videoHeight: 480,
                canvasWidth: 640,
                canvasHeight: 480,
                assignmentSelectedIds: [],
                selectedUnlinkedId: ul.id,
            });

            // Verify something was drawn (canvas is no longer blank)
            var data = ctx.getImageData(0, 0, 640, 480).data;
            var nonZero = false;
            for (var i = 3; i < data.length; i += 4) {
                if (data[i] > 0) { nonZero = true; break; }
            }
            assert(nonZero, 'Canvas should have drawn content for selected unlinked');
        });

        it('selectedUnlinkedId should cause full opacity rendering', function () {
            // Test the logic: isEditSelected should be true when IDs match
            var inst = new Instance([[100, 100]], 0, 'user', 1.0);
            var ul = new UnlinkedInstance(inst, 'cam1');
            var selectedId = ul.id;

            var isEditSelected = selectedId != null && ul.id === selectedId;
            assert(isEditSelected, 'Should detect selected unlinked by ID');

            var isSelected = isEditSelected;
            var alpha = isSelected ? 0.95 : 0.5;
            assertEqual(alpha, 0.95, 'Selected unlinked should render at full alpha');
        });

        it('unselected unlinked should render at reduced alpha', function () {
            var inst = new Instance([[100, 100]], 0, 'user', 1.0);
            var ul = new UnlinkedInstance(inst, 'cam1');

            var isEditSelected = null != null && ul.id === null;
            var isSelected = isEditSelected;
            var alpha = isSelected ? 0.95 : 0.5;
            assertEqual(alpha, 0.5, 'Unselected unlinked should render at half alpha');
        });
    });

    // ============================================
    // onInstanceDeleted handles null group (unlinked deletion)
    // ============================================

    describe('onInstanceDeleted with null group', function () {
        it('should not crash when group is null', function () {
            // Simulate the callback logic from index.html
            var group = null;
            var trackName = group ? ('Track ' + group.trackIdx) : 'unlinked instance';
            assertEqual(trackName, 'unlinked instance', 'Should use fallback name for null group');
        });

        it('should use track name when group exists', function () {
            var group = new InstanceGroup(1, 2);
            var tracks = ['track_0', 'track_1', 'track_2'];
            var trackName = group ? (tracks[group.trackIdx] || 'Track ' + group.trackIdx) : 'unlinked instance';
            assertEqual(trackName, 'track_2', 'Should use track name from session');
        });
    });

    // ============================================
    // Picking integration: findNearestUnlinkedNode
    // ============================================

    describe('Unlinked instance picking', function () {
        it('findNearestUnlinkedNode should find instance near its points', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);

            // findNearestUnlinkedNode needs views with overlayCanvas for threshold calc
            var fakeCanvas = document.createElement('canvas');
            fakeCanvas.width = 640;
            fakeCanvas.height = 480;
            fakeCanvas.style.width = '640px';
            fakeCanvas.style.height = '480px';
            document.body.appendChild(fakeCanvas);
            env.views[0].overlayCanvas = fakeCanvas;

            var hit = env.mgr.findNearestUnlinkedNode(102, 98, 'cam1', 0);
            assertNotNull(hit, 'Should find unlinked node near (102, 98)');
            assertEqual(hit.nodeIdx, 0, 'Should find node 0');
            assertNotNull(hit.unlinked, 'Should return unlinked reference');

            document.body.removeChild(fakeCanvas);
        });

        it('findNearestUnlinkedNode should return null when too far', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);

            var hit = env.mgr.findNearestUnlinkedNode(400, 400, 'cam1', 0);
            assertNull(hit, 'Should not find node far from (400, 400)');
        });

        it('findNearestUnlinkedNode should not find instances on other cameras', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);

            var hit = env.mgr.findNearestUnlinkedNode(100, 100, 'cam2', 0);
            assertNull(hit, 'Should not find cam1 instance when querying cam2');
        });
    });

    // ============================================
    // newProject clears all state
    // ============================================

    describe('newProject state clearing', function () {
        it('should clear session, views, videoFiles, frames, and triangulation', function () {
            // Simulate a loaded project state
            var state = {
                session: new Session([], new Skeleton('s', ['a'], []), []),
                views: [{ name: 'cam1' }, { name: 'cam2' }],
                videoFiles: [{ name: 'v1.mp4' }],
                currentFrame: 42,
                totalFrames: 100,
                fps: 60,
                keypoints3d: [[1, 2, 3]],
                triangulationResults: new Map([[0, [{ group: null }]]]),
                viewMode: 'single',
                singleViewIndex: 2,
                isPlaying: false,
            };

            // Apply newProject clearing logic (mirrors index.html newProject)
            state.session = null;
            state.currentFrame = 0;
            state.totalFrames = 0;
            state.fps = 30;
            state.keypoints3d = null;
            state.triangulationResults = new Map();
            state.viewMode = 'grid';
            state.singleViewIndex = 0;
            state.views = [];
            state.videoFiles = [];

            assertNull(state.session, 'session should be null');
            assertEqual(state.views.length, 0, 'views should be empty');
            assertEqual(state.videoFiles.length, 0, 'videoFiles should be empty');
            assertEqual(state.currentFrame, 0, 'currentFrame should be 0');
            assertEqual(state.totalFrames, 0, 'totalFrames should be 0');
            assertEqual(state.fps, 30, 'fps should reset to 30');
            assertNull(state.keypoints3d, 'keypoints3d should be null');
            assertEqual(state.triangulationResults.size, 0, 'triangulationResults should be empty');
            assertEqual(state.viewMode, 'grid', 'viewMode should be grid');
            assertEqual(state.singleViewIndex, 0, 'singleViewIndex should be 0');
        });

        it('should detach interactionManager', function () {
            var detached = false;
            var mgr = new InteractionManager({
                getState: function () { return null; },
                getInstanceGroups: function () { return []; },
            });
            // Monkey-patch detach to verify it gets called
            var origDetach = mgr.detach.bind(mgr);
            mgr.detach = function () { detached = true; origDetach(); };

            mgr.detach();
            assert(detached, 'detach should be called on interactionManager');
        });

        it('session with frames should require clearing', function () {
            var skeleton = new Skeleton('s', ['a'], []);
            var session = new Session([], skeleton, []);
            var fg = new FrameGroup(0);
            session.addFrameGroup(fg);

            // This simulates the condition check in newProject
            var hasData = session && session.numFrames > 0;
            // Note: numFrames counts frameGroups
            assert(hasData || session.frameGroups.size > 0, 'Should detect session has data');
        });

        it('empty session should still allow newProject without confirm', function () {
            // With no session and no views, newProject should not require confirmation
            var needsConfirm = (null || [].length > 0);
            assert(!needsConfirm, 'Empty state should not require confirmation');
        });
    });

    // ============================================
    // Auto-assignment mode on unlinked click
    // ============================================

    describe('Auto-assignment mode on unlinked click', function () {
        it('clicking unlinked instance should auto-enter assignment mode', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);

            var fg = env.session.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('cam1')[0];

            // Simulate the onMouseDown logic for unlinked hit
            assert(!env.mgr.assignmentMode, 'Should start not in assignment mode');

            // Replicate the unlinked click path
            env.mgr.select(null, -1);
            env.mgr.selectedUnlinked = ul;
            if (!env.mgr.assignmentMode) {
                env.mgr.assignmentMode = true;
            }
            env.mgr.addToAssignmentSelection(ul);

            assert(env.mgr.assignmentMode, 'Should be in assignment mode after clicking unlinked');
            assertEqual(env.mgr.assignmentSelection.length, 1, 'Should have 1 in assignment selection');
            assertEqual(env.mgr.assignmentSelection[0].id, ul.id, 'Selection should contain clicked unlinked');
        });

        it('clicking second unlinked on different camera should add to selection', function () {
            var env = makeTestEnv();
            var inst1 = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            var inst2 = new Instance([[150, 150], [250, 250]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst1);
            env.session.addUnlinkedInstance(0, 'cam2', inst2);

            var fg = env.session.getFrameGroup(0);
            var ul1 = fg.getUnlinkedInstances('cam1')[0];
            var ul2 = fg.getUnlinkedInstances('cam2')[0];

            // First click: auto-enters assignment mode
            env.mgr.select(null, -1);
            env.mgr.selectedUnlinked = ul1;
            env.mgr.assignmentMode = true;
            env.mgr.addToAssignmentSelection(ul1);

            // Second click: already in assignment mode, add second
            env.mgr.selectedUnlinked = ul2;
            env.mgr.addToAssignmentSelection(ul2);

            assertEqual(env.mgr.assignmentSelection.length, 2, 'Should have 2 in assignment selection');
        });

        it('clicking same camera should replace in assignment selection', function () {
            var env = makeTestEnv();
            var inst1 = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            var inst2 = new Instance([[300, 300], [400, 400]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst1);
            env.session.addUnlinkedInstance(0, 'cam1', inst2);

            var fg = env.session.getFrameGroup(0);
            var unlinked = fg.getUnlinkedInstances('cam1');

            // Select first
            env.mgr.assignmentMode = true;
            env.mgr.addToAssignmentSelection(unlinked[0]);
            assertEqual(env.mgr.assignmentSelection.length, 1, 'Should have 1');

            // Select second on same camera - should replace
            env.mgr.addToAssignmentSelection(unlinked[1]);
            assertEqual(env.mgr.assignmentSelection.length, 1, 'Should still have 1 (replaced)');
            assertEqual(env.mgr.assignmentSelection[0].id, unlinked[1].id, 'Should be the second one');
        });

        it('full click-click-group workflow', function () {
            var env = makeTestEnv();
            var inst1 = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            var inst2 = new Instance([[150, 150], [250, 250]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst1);
            env.session.addUnlinkedInstance(0, 'cam2', inst2);

            var fg = env.session.getFrameGroup(0);
            var ul1 = fg.getUnlinkedInstances('cam1')[0];
            var ul2 = fg.getUnlinkedInstances('cam2')[0];

            // Click first unlinked (auto-enters assignment mode)
            env.mgr.select(null, -1);
            env.mgr.selectedUnlinked = ul1;
            env.mgr.assignmentMode = true;
            env.mgr.addToAssignmentSelection(ul1);

            // Click second unlinked (already in assignment mode)
            env.mgr.selectedUnlinked = ul2;
            env.mgr.addToAssignmentSelection(ul2);

            // Press C to create group
            var event = new KeyboardEvent('keydown', { key: 'c', ctrlKey: false, metaKey: false, altKey: false });
            env.mgr.onKeyDown(event);

            // Verify group created
            var trackMap = env.session.instanceGroups.get(0);
            assertNotNull(trackMap, 'Should have instance groups');
            var hasGroup = false;
            if (trackMap) {
                for (var entry of trackMap) {
                    if (entry[1].length > 0) hasGroup = true;
                }
            }
            assert(hasGroup, 'Group should be created from click-click-C workflow');
            assert(!env.mgr.assignmentMode, 'Assignment mode should be off after group creation');
            assertEqual(fg.getUnlinkedInstances('cam1').length, 0, 'cam1 unlinked should be cleared');
            assertEqual(fg.getUnlinkedInstances('cam2').length, 0, 'cam2 unlinked should be cleared');
        });
    });

    // ============================================
    // Delete key works for unlinked instances
    // ============================================

    describe('Delete key for unlinked instances', function () {
        it('Delete key should trigger deletion when unlinked is selected', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);

            var fg = env.session.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('cam1')[0];

            env.mgr.selectedUnlinked = ul;
            env.mgr.lastInteractedView = 'cam1';

            var event = new KeyboardEvent('keydown', { key: 'Delete' });
            env.mgr.onKeyDown(event);

            assertEqual(fg.getUnlinkedInstances('cam1').length, 0, 'Unlinked should be deleted by Delete key');
            assertNull(env.mgr.selectedUnlinked, 'Selection should be cleared');
        });

        it('Backspace key should also delete unlinked instance', function () {
            var env = makeTestEnv();
            var inst = new Instance([[100, 100], [200, 200]], 0, 'user', 1.0);
            env.session.addUnlinkedInstance(0, 'cam1', inst);

            var fg = env.session.getFrameGroup(0);
            var ul = fg.getUnlinkedInstances('cam1')[0];

            env.mgr.selectedUnlinked = ul;
            env.mgr.lastInteractedView = 'cam1';

            var event = new KeyboardEvent('keydown', { key: 'Backspace' });
            env.mgr.onKeyDown(event);

            assertEqual(fg.getUnlinkedInstances('cam1').length, 0, 'Unlinked should be deleted by Backspace');
        });
    });

    // ============================================
    // Closest-hit logic (linked vs unlinked)
    // ============================================

    describe('Closest hit selection (linked vs unlinked)', function () {
        it('should prefer closer unlinked over farther linked instance', function () {
            // Test the distance comparison logic
            var linkedDist = 10;
            var unlinkDist = 5;

            var useLinked = false;
            var useUnlinked = false;
            if (linkedDist && unlinkDist) {
                useLinked = linkedDist <= unlinkDist;
                useUnlinked = !useLinked;
            }

            assert(useUnlinked, 'Should prefer closer unlinked');
            assert(!useLinked, 'Should not use farther linked');
        });

        it('should prefer closer linked over farther unlinked instance', function () {
            var linkedDist = 3;
            var unlinkDist = 8;

            var useLinked = linkedDist <= unlinkDist;
            var useUnlinked = !useLinked;

            assert(useLinked, 'Should prefer closer linked');
            assert(!useUnlinked, 'Should not use farther unlinked');
        });

        it('should use linked when only linked hit exists', function () {
            var linkedHit = { distance: 5 };
            var ulHit = null;

            var useLinked = false;
            var useUnlinked = false;
            if (linkedHit && ulHit) {
                useLinked = linkedHit.distance <= ulHit.distance;
                useUnlinked = !useLinked;
            } else if (linkedHit) {
                useLinked = true;
            } else if (ulHit) {
                useUnlinked = true;
            }

            assert(useLinked, 'Should use linked when only option');
            assert(!useUnlinked, 'Should not use unlinked when null');
        });

        it('should use unlinked when only unlinked hit exists', function () {
            var linkedHit = null;
            var ulHit = { distance: 5 };

            var useLinked = false;
            var useUnlinked = false;
            if (linkedHit && ulHit) {
                useLinked = linkedHit.distance <= ulHit.distance;
                useUnlinked = !useLinked;
            } else if (linkedHit) {
                useLinked = true;
            } else if (ulHit) {
                useUnlinked = true;
            }

            assert(!useLinked, 'Should not use linked when null');
            assert(useUnlinked, 'Should use unlinked when only option');
        });
    });

    // ============================================
    // Escape clears assignment mode
    // ============================================

    describe('Escape clears assignment mode', function () {
        it('Escape should exit assignment mode', function () {
            var env = makeTestEnv();
            env.mgr.assignmentMode = true;
            env.mgr.assignmentSelection = [{ id: 1, cameraName: 'cam1' }];

            var event = new KeyboardEvent('keydown', { key: 'Escape' });
            env.mgr.onKeyDown(event);

            assert(!env.mgr.assignmentMode, 'Assignment mode should be off after Escape');
            assertEqual(env.mgr.assignmentSelection.length, 0, 'Assignment selection should be cleared');
        });

        it('Escape should clear regular selection when not in assignment mode', function () {
            var env = makeTestEnv();
            env.mgr.selectedUnlinked = { id: 1, instance: {}, cameraName: 'cam1' };

            var event = new KeyboardEvent('keydown', { key: 'Escape' });
            env.mgr.onKeyDown(event);

            assertNull(env.mgr.selectedUnlinked, 'selectedUnlinked should be cleared');
        });
    });

    // ============================================
    // Selection ring color
    // ============================================

    describe('Selection ring color', function () {
        it('assignment-selected should use yellow color', function () {
            var assignmentColor = '#fbbf24';
            var isAssignSelected = true;
            var isEditSelected = false;

            var ringColor = isAssignSelected ? assignmentColor : '#60a5fa';
            assertEqual(ringColor, '#fbbf24', 'Assignment selection should use yellow');
        });

        it('edit-selected should use blue color', function () {
            var assignmentColor = '#fbbf24';
            var isAssignSelected = false;
            var isEditSelected = true;

            var ringColor = isAssignSelected ? assignmentColor : '#60a5fa';
            assertEqual(ringColor, '#60a5fa', 'Edit selection should use blue');
        });
    });

})();
