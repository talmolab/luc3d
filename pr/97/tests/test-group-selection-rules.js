/**
 * test-group-selection-rules.js — Regression tests for group selection rules
 * (Bug C and Bug D).
 *
 * Bug C — Group selection mutual-exclusion:
 *   InteractionManager.select(group, ...) must clear any in-progress
 *   assignmentSelection / assignmentMode so a stale unlinked multi-selection
 *   cannot persist alongside a newly-selected GroupedInstance and silently
 *   form a degenerate group.
 *   addToAssignmentSelection() must defensively clear selectedInstanceGroup
 *   when it is set, for symmetry.
 *
 * Bug D — Group button must require ≥2 members:
 *   The toolbar Group button must not be highlighted or available when the
 *   assignment selection has exactly one member. The C key shortcut and
 *   _createGroupFromAssignment guard must require ≥2 members.
 *
 * Toolbar DOM state lives in index.html and is not directly testable here.
 * Suite 5 covers the structural contract the toolbar mirrors.
 */

(function () {
    var describe   = TestFramework.describe;
    var it         = TestFramework.it;
    var assertEqual    = TestFramework.assertEqual;
    var assertTrue     = TestFramework.assertTrue;
    var assertFalse    = TestFramework.assertFalse;
    var assertNotNull  = TestFramework.assertNotNull;
    var assertNull     = TestFramework.assertNull;

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
     * Build a 3-camera test environment with three unlinked instances.
     * Three cams give us enough room to (a) build a separate group from a
     * different camera set than the assignment selection and (b) test 3+
     * member assignment selections.
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
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh]),
            new Camera('cam3',
                [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh]),
        ];
        var session = new Session(cameras, skeleton, ['track_0']);

        var inst1 = new Instance([[100, 100], [150, 150]], 0, 'user', 1.0);
        var inst2 = new Instance([[200, 200], [250, 250]], 0, 'user', 1.0);
        var inst3 = new Instance([[300, 300], [350, 350]], 0, 'user', 1.0);

        session.addUnlinkedInstance(0, 'cam1', inst1);
        session.addUnlinkedInstance(0, 'cam2', inst2);
        session.addUnlinkedInstance(0, 'cam3', inst3);

        var canvas1 = createMockCanvas(vw, vh);
        var canvas2 = createMockCanvas(vw, vh);
        var canvas3 = createMockCanvas(vw, vh);
        canvas2.style.left = vw + 'px';
        canvas3.style.left = (2 * vw) + 'px';

        var views = [
            { name: 'cam1', overlayCanvas: canvas1, videoWidth: vw, videoHeight: vh },
            { name: 'cam2', overlayCanvas: canvas2, videoWidth: vw, videoHeight: vh },
            { name: 'cam3', overlayCanvas: canvas3, videoWidth: vw, videoHeight: vh },
        ];

        var spies = {
            selectionChanged: [],   // each entry: { group, nodeIdx }
            assignmentChanged: [],  // each entry: count
            groupCreated: [],       // each entry: group
        };

        var mgr = new InteractionManager({
            getState: function () {
                return { currentFrame: 0, session: session, views: views };
            },
            getInstanceGroups: function (frameIdx) {
                return session.getInstanceGroupsForFrame(frameIdx || 0);
            },
            onSelectionChanged: function (g, nodeIdx) {
                spies.selectionChanged.push({ group: g, nodeIdx: nodeIdx });
            },
            onAssignmentSelectionChanged: function (count) {
                spies.assignmentChanged.push(count);
            },
            onAssignmentGroupCreated: function (g) {
                spies.groupCreated.push(g);
            },
            onInstanceDeleted: function () {},
            onNodeMoved: function () {},
            requestRedraw: function () {},
        });

        mgr.attach(views);

        var fg = session.getFrameGroup(0);
        var unlinked1 = fg.getUnlinkedInstances('cam1')[0];
        var unlinked2 = fg.getUnlinkedInstances('cam2')[0];
        var unlinked3 = fg.getUnlinkedInstances('cam3')[0];

        return {
            skeleton: skeleton,
            session: session,
            mgr: mgr,
            views: views,
            fg: fg,
            unlinked1: unlinked1,
            unlinked2: unlinked2,
            unlinked3: unlinked3,
            spies: spies,
            cleanup: function () {
                mgr.detach();
                cleanupCanvases();
            },
        };
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

    /**
     * Build a standalone InstanceGroup unrelated to the unlinked pool, so
     * tests can call select(group, ...) without disturbing the unlinked
     * instances used to seed assignment selections.
     */
    function makeDetachedGroup(env, idStart) {
        idStart = idStart || 9000;
        var instA = new Instance([[400, 400], [450, 450]], 0, 'user', 1.0);
        var instB = new Instance([[420, 420], [470, 470]], 0, 'user', 1.0);
        var group = new InstanceGroup(idStart, 0);
        group.addInstance('cam1', instA);
        group.addInstance('cam2', instB);
        // Register it on the session so toolbar/state queries are realistic.
        if (!env.session.instanceGroups.has(0)) env.session.instanceGroups.set(0, []);
        env.session.instanceGroups.get(0).push(group);
        return group;
    }

    // ================================================================
    // Suite 1 — select(group, ...) clears assignment state
    // ================================================================

    describe('Bug C — select(group) clears in-progress assignment', function () {

        it('select(group, -1) with assignment in progress clears assignmentSelection, mode, and selectedUnlinked', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                env.mgr.addToAssignmentSelection(env.unlinked2);
                assertEqual(env.mgr.assignmentSelection.length, 2, 'precondition: 2 selected');
                assertTrue(env.mgr.assignmentMode, 'precondition: mode on');

                // Manually attach an "unlinked selection" to also verify it gets cleared.
                env.mgr.selectedUnlinked = env.unlinked3;

                var group = makeDetachedGroup(env);
                env.mgr.select(group, -1);

                assertEqual(env.mgr.assignmentSelection.length, 0,
                    'assignment selection cleared');
                assertFalse(env.mgr.assignmentMode,
                    'assignment mode exited');
                assertTrue(env.mgr.selectedInstanceGroup === group,
                    'selectedInstanceGroup is the new group');
                assertEqual(env.mgr.selectedNodeIdx, -1, 'selectedNodeIdx is -1');
                assertNull(env.mgr.selectedUnlinked,
                    'selectedUnlinked cleared');
            } finally {
                env.cleanup();
            }
        });

        it('onAssignmentSelectionChanged(0) fires when select(group) clears non-empty assignment', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                env.mgr.addToAssignmentSelection(env.unlinked2);
                // Reset spy after seeding (addToAssignmentSelection itself fires it).
                env.spies.assignmentChanged.length = 0;

                var group = makeDetachedGroup(env);
                env.mgr.select(group, -1);

                assertEqual(env.spies.assignmentChanged.length, 1,
                    'onAssignmentSelectionChanged fired exactly once');
                assertEqual(env.spies.assignmentChanged[0], 0,
                    'fired with count=0');
            } finally {
                env.cleanup();
            }
        });

        it('select(group, -1) is idempotent: second call with same group does not re-fire callbacks', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                env.mgr.addToAssignmentSelection(env.unlinked2);

                var group = makeDetachedGroup(env);
                env.mgr.select(group, -1);

                // Reset spies.
                env.spies.assignmentChanged.length = 0;
                env.spies.selectionChanged.length = 0;

                // Second call: state already matches, so neither callback should fire.
                env.mgr.select(group, -1);

                assertEqual(env.mgr.assignmentSelection.length, 0,
                    'state still clean');
                assertFalse(env.mgr.assignmentMode, 'mode still off');
                assertTrue(env.mgr.selectedInstanceGroup === group,
                    'selection unchanged');

                // onSelectionChanged is gated by `changed`, which is false here.
                assertEqual(env.spies.selectionChanged.length, 0,
                    'onSelectionChanged not re-fired (state unchanged)');
                // Assignment was already empty/false, so the inner branch
                // does not enter and the callback does not fire.
                assertEqual(env.spies.assignmentChanged.length, 0,
                    'onAssignmentSelectionChanged not re-fired');
            } finally {
                env.cleanup();
            }
        });

        it('select(null, -1) does NOT touch in-progress assignment (users can clear linked without exiting assignment)', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                env.mgr.addToAssignmentSelection(env.unlinked2);
                assertEqual(env.mgr.assignmentSelection.length, 2, 'precondition');

                env.spies.assignmentChanged.length = 0;

                env.mgr.select(null, -1);

                assertTrue(env.mgr.assignmentMode,
                    'assignment mode preserved on null select');
                assertEqual(env.mgr.assignmentSelection.length, 2,
                    'assignment selection preserved on null select');
                assertEqual(env.spies.assignmentChanged.length, 0,
                    'onAssignmentSelectionChanged NOT fired on null select');
                assertNull(env.mgr.selectedInstanceGroup,
                    'selectedInstanceGroup cleared by null select');
            } finally {
                env.cleanup();
            }
        });

        it('select(group, -1) clears selectedUnlinked even with no active assignment', function () {
            var env = buildEnv();
            try {
                env.mgr.selectedUnlinked = env.unlinked1;
                assertNotNull(env.mgr.selectedUnlinked, 'precondition: selectedUnlinked set');
                assertFalse(env.mgr.assignmentMode, 'precondition: mode off');
                assertEqual(env.mgr.assignmentSelection.length, 0, 'precondition: empty');

                env.spies.assignmentChanged.length = 0;

                var group = makeDetachedGroup(env);
                env.mgr.select(group, -1);

                assertNull(env.mgr.selectedUnlinked,
                    'selectedUnlinked cleared');
                assertTrue(env.mgr.selectedInstanceGroup === group,
                    'group is now selected');
                // The inner branch only fires the assignment callback if mode
                // was on or selection was non-empty; neither here.
                assertEqual(env.spies.assignmentChanged.length, 0,
                    'no spurious onAssignmentSelectionChanged');
            } finally {
                env.cleanup();
            }
        });
    });

    // ================================================================
    // Suite 2 — addToAssignmentSelection clears selectedInstanceGroup
    // ================================================================

    describe('Bug C — addToAssignmentSelection clears any selectedInstanceGroup', function () {

        it('addToAssignmentSelection clears a previously-selected InstanceGroup', function () {
            var env = buildEnv();
            try {
                var group = makeDetachedGroup(env);
                env.mgr.select(group, -1);
                assertTrue(env.mgr.selectedInstanceGroup === group,
                    'precondition: group selected');

                env.mgr.setAssignmentMode(true);
                env.spies.selectionChanged.length = 0;
                env.spies.assignmentChanged.length = 0;

                env.mgr.addToAssignmentSelection(env.unlinked1);

                assertNull(env.mgr.selectedInstanceGroup,
                    'selectedInstanceGroup cleared');
                assertEqual(env.mgr.selectedNodeIdx, -1, 'selectedNodeIdx reset');
                assertFalse(env.mgr.selectedReprojected, 'selectedReprojected reset');
                assertEqual(env.mgr.assignmentSelection.length, 1,
                    'unlinked added');
            } finally {
                env.cleanup();
            }
        });

        it('addToAssignmentSelection fires onSelectionChanged(null, -1) when clearing a group', function () {
            var env = buildEnv();
            try {
                var group = makeDetachedGroup(env);
                env.mgr.select(group, -1);

                env.mgr.setAssignmentMode(true);
                env.spies.selectionChanged.length = 0;

                env.mgr.addToAssignmentSelection(env.unlinked1);

                assertEqual(env.spies.selectionChanged.length, 1,
                    'onSelectionChanged fired exactly once');
                assertNull(env.spies.selectionChanged[0].group,
                    'fired with group=null');
                assertEqual(env.spies.selectionChanged[0].nodeIdx, -1,
                    'fired with nodeIdx=-1');
            } finally {
                env.cleanup();
            }
        });

        it('addToAssignmentSelection does NOT fire spurious onSelectionChanged when no group was selected', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                assertNull(env.mgr.selectedInstanceGroup,
                    'precondition: nothing selected');
                env.spies.selectionChanged.length = 0;

                env.mgr.addToAssignmentSelection(env.unlinked1);

                assertEqual(env.spies.selectionChanged.length, 0,
                    'onSelectionChanged NOT fired (no-op clearing path)');
                assertEqual(env.mgr.assignmentSelection.length, 1,
                    'unlinked still added');
            } finally {
                env.cleanup();
            }
        });
    });

    // ================================================================
    // Suite 3 — _createGroupFromAssignment requires ≥2
    // ================================================================

    describe('Bug D — _createGroupFromAssignment requires ≥2 members', function () {

        it('empty selection: no-op (mode stays on, no group, no callback)', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.spies.groupCreated.length = 0;

                env.mgr._createGroupFromAssignment();

                assertTrue(env.mgr.assignmentMode, 'mode still on');
                assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0,
                    'no group created');
                assertEqual(env.spies.groupCreated.length, 0,
                    'onAssignmentGroupCreated not fired');
            } finally {
                env.cleanup();
            }
        });

        it('1-member selection: no-op (this is the new gate)', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                assertEqual(env.mgr.assignmentSelection.length, 1, 'precondition');
                env.spies.groupCreated.length = 0;

                env.mgr._createGroupFromAssignment();

                assertTrue(env.mgr.assignmentMode, 'mode still on');
                assertEqual(env.mgr.assignmentSelection.length, 1,
                    'selection preserved');
                assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0,
                    'no group created with 1 member');
                assertEqual(env.spies.groupCreated.length, 0,
                    'onAssignmentGroupCreated not fired');
            } finally {
                env.cleanup();
            }
        });

        it('2-member selection: succeeds (group created, mode exits, selection cleared, callback fires)', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                env.mgr.addToAssignmentSelection(env.unlinked2);
                env.spies.groupCreated.length = 0;

                env.mgr._createGroupFromAssignment();

                assertFalse(env.mgr.assignmentMode, 'mode exited');
                assertEqual(env.mgr.assignmentSelection.length, 0,
                    'selection cleared');
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 1, 'one group created');
                assertEqual(env.spies.groupCreated.length, 1,
                    'onAssignmentGroupCreated fired once');
                assertTrue(env.spies.groupCreated[0] === groups[0],
                    'callback received the new group');
            } finally {
                env.cleanup();
            }
        });

        it('3-member selection: succeeds', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                env.mgr.addToAssignmentSelection(env.unlinked2);
                env.mgr.addToAssignmentSelection(env.unlinked3);
                assertEqual(env.mgr.assignmentSelection.length, 3, 'precondition');

                env.mgr._createGroupFromAssignment();

                assertFalse(env.mgr.assignmentMode, 'mode exited');
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 1, 'one group created');
                assertNotNull(groups[0].getInstance('cam1'), 'cam1 included');
                assertNotNull(groups[0].getInstance('cam2'), 'cam2 included');
                assertNotNull(groups[0].getInstance('cam3'), 'cam3 included');
            } finally {
                env.cleanup();
            }
        });
    });

    // ================================================================
    // Suite 4 — C key shortcut respects ≥2
    // ================================================================

    describe('Bug D — C key shortcut requires ≥2 members', function () {

        it('0 selected + C: no-op', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);

                env.mgr.onKeyDown(makeKeyEvent('c'));

                assertTrue(env.mgr.assignmentMode, 'mode still on');
                assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0,
                    'no group created');
            } finally {
                env.cleanup();
            }
        });

        it('1 selected + C: no-op (this is the new gate)', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);

                env.mgr.onKeyDown(makeKeyEvent('c'));

                assertTrue(env.mgr.assignmentMode,
                    'mode still on with 1-member selection');
                assertEqual(env.mgr.assignmentSelection.length, 1,
                    'selection preserved');
                assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0,
                    'no group created from single member');
            } finally {
                env.cleanup();
            }
        });

        it('2 selected + C: creates group', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                env.mgr.addToAssignmentSelection(env.unlinked2);

                env.mgr.onKeyDown(makeKeyEvent('c'));

                assertFalse(env.mgr.assignmentMode, 'mode exited');
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 1, 'group created');
            } finally {
                env.cleanup();
            }
        });

        it('Ctrl+C with 2 selected: no-op (modifier guard still holds)', function () {
            var env = buildEnv();
            try {
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                env.mgr.addToAssignmentSelection(env.unlinked2);

                env.mgr.onKeyDown(makeKeyEvent('c', { ctrlKey: true }));

                assertTrue(env.mgr.assignmentMode,
                    'mode preserved (modifier suppresses shortcut)');
                assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0,
                    'no group created on Ctrl+C');
            } finally {
                env.cleanup();
            }
        });
    });

    // ================================================================
    // Suite 5 — Toolbar state contract
    // ================================================================

    describe('Bug D — toolbar Group/Ungroup state contract', function () {

        /**
         * Mirror of the toolbar state computation in index.html ~2879-2895.
         * Given the inputs the production code reads from interactionManager,
         * return the resulting button state.
         */
        function computeTbGroupState(assignmentMode, assignmentSelectedLength, hasGroupedSelection) {
            var state = { text: 'Group', active: false, disabled: false };
            if (hasGroupedSelection && !assignmentMode) {
                state.text = 'Ungroup';
                state.active = true;
                state.disabled = false;
            } else {
                state.text = 'Group';
                var oneAssignmentSelected = assignmentMode && assignmentSelectedLength === 1;
                state.active = assignmentMode && !oneAssignmentSelected;
                state.disabled = oneAssignmentSelected;
            }
            return state;
        }

        it('idle: assignmentMode=false, length=0, no group selected -> Group, inactive, enabled', function () {
            var s = computeTbGroupState(false, 0, false);
            assertEqual(s.text, 'Group');
            assertFalse(s.active);
            assertFalse(s.disabled);
        });

        it('entering assignment mode: length=0 -> Group, active, enabled', function () {
            var s = computeTbGroupState(true, 0, false);
            assertEqual(s.text, 'Group');
            assertTrue(s.active, 'highlighted while in assignment mode');
            assertFalse(s.disabled);
        });

        it('KEY FIX: assignmentMode=true, length=1 -> Group, NOT active, DISABLED', function () {
            var s = computeTbGroupState(true, 1, false);
            assertEqual(s.text, 'Group');
            assertFalse(s.active,
                'must NOT be highlighted with degenerate single selection');
            assertTrue(s.disabled,
                'must be disabled with degenerate single selection');
        });

        it('assignmentMode=true, length=2 -> Group, active, enabled', function () {
            var s = computeTbGroupState(true, 2, false);
            assertEqual(s.text, 'Group');
            assertTrue(s.active);
            assertFalse(s.disabled);
        });

        it('assignmentMode=true, length=3 -> Group, active, enabled', function () {
            var s = computeTbGroupState(true, 3, false);
            assertEqual(s.text, 'Group');
            assertTrue(s.active);
            assertFalse(s.disabled);
        });

        it('assignmentMode=false, hasGroupedSelection=true -> Ungroup, active, enabled', function () {
            var s = computeTbGroupState(false, 0, true);
            assertEqual(s.text, 'Ungroup');
            assertTrue(s.active);
            assertFalse(s.disabled);
        });

        it('hasGroupedSelection wins only when assignmentMode is false', function () {
            // Defensive: if both flags ever coexist in the manager, the
            // production code falls through to the Group branch (because the
            // Ungroup branch requires !assignmentMode).
            var s = computeTbGroupState(true, 2, true);
            assertEqual(s.text, 'Group',
                'assignmentMode forces Group label even if a group is selected');
            assertTrue(s.active);
            assertFalse(s.disabled);
        });
    });

    // ================================================================
    // Suite 6 — Combined real-world flow
    // ================================================================

    describe('Bug C+D — combined real-world flow (Linked-Instances row click during assignment)', function () {

        it('clicking GroupedInstance row mid-assignment fully clears, then re-selecting unlinked re-enters mode', function () {
            var env = buildEnv();
            try {
                // Step 1: Enter assignment mode and select 2 unlinked.
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);
                env.mgr.addToAssignmentSelection(env.unlinked2);
                assertEqual(env.mgr.assignmentSelection.length, 2,
                    'precondition: 2 unlinked selected');

                // Step 2: User clicks a GroupedInstance's Linked-Instances row.
                // index.html does mgr.select(g, -1).
                var group = makeDetachedGroup(env);
                env.mgr.select(group, -1);

                // Bug C contract: assignment fully cleared.
                assertEqual(env.mgr.assignmentSelection.length, 0,
                    'assignment cleared by row click');
                assertFalse(env.mgr.assignmentMode,
                    'assignment mode exited by row click');
                assertTrue(env.mgr.selectedInstanceGroup === group,
                    'group now selected');

                // Step 3: User re-enters assignment mode and clicks an unlinked.
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);

                assertEqual(env.mgr.assignmentSelection.length, 1,
                    're-entered with single member');
                // Bug D contract: at length=1 the toolbar should be disabled.
                // Mirror the toolbar computation to assert the contract.
                var oneAssignmentSelected =
                    env.mgr.assignmentMode &&
                    env.mgr.getAssignmentSelectedIds().length === 1;
                assertTrue(oneAssignmentSelected,
                    'toolbar would compute oneAssignmentSelected=true');

                // Step 4: User adds the second unlinked.
                env.mgr.addToAssignmentSelection(env.unlinked2);
                assertEqual(env.mgr.assignmentSelection.length, 2,
                    'second unlinked added');
                oneAssignmentSelected =
                    env.mgr.assignmentMode &&
                    env.mgr.getAssignmentSelectedIds().length === 1;
                assertFalse(oneAssignmentSelected,
                    'toolbar would re-enable Group button at length=2');
            } finally {
                env.cleanup();
            }
        });

        it('addToAssignmentSelection after select(group) leaves no stale group selection (defensive symmetry)', function () {
            var env = buildEnv();
            try {
                var group = makeDetachedGroup(env);
                env.mgr.select(group, -1);
                assertTrue(env.mgr.selectedInstanceGroup === group,
                    'precondition');

                // User enters assignment mode and clicks an unlinked WITHOUT
                // first clearing the selected group.
                env.mgr.setAssignmentMode(true);
                env.mgr.addToAssignmentSelection(env.unlinked1);

                assertNull(env.mgr.selectedInstanceGroup,
                    'group cleared by addToAssignmentSelection');
                assertEqual(env.mgr.assignmentSelection.length, 1, '1 unlinked');

                // Add second and create the group — should succeed cleanly.
                env.mgr.addToAssignmentSelection(env.unlinked2);
                env.mgr._createGroupFromAssignment();

                var groups = env.session.getInstanceGroupsForFrame(0);
                // makeDetachedGroup added one, _createGroupFromAssignment adds another.
                assertEqual(groups.length, 2,
                    'detached group + newly created group both present');
            } finally {
                env.cleanup();
            }
        });
    });

})();
