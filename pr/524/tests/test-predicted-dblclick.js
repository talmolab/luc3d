/**
 * test-predicted-dblclick.js — regression tests for the predicted-to-user
 * double-click flow: selection transfer to the new user, multi-select
 * preservation across views, and the linked-vs-unlinked code paths.
 *
 * Bug: when the user double-clicked a predicted UnlinkedInstance, the handler
 * created a new user UnlinkedInstance and set `selectedUnlinked = newUl`, but
 * the original predicted's id remained inside `assignmentSelection` (because a
 * single-click of the predicted on its way to the double-click had auto-entered
 * assignment mode and added the predicted to the selection). As a result,
 * `drawUnlinkedInstances` (overlays.js:1371) still rendered the assignment-
 * color highlight on the OLD predicted, making it look "still selected" even
 * though `selectedUnlinked` correctly pointed at the new user.
 *
 * Fix (interaction.js, ~lines 920–980): after creating the user instance, the
 * predicted-double-click branch now clears `assignmentSelection` /
 * `assignmentMode` and fires `onAssignmentSelectionChanged(0)` BEFORE assigning
 * `selectedUnlinked = newUl`.
 *
 * These tests exercise the production double-click path
 * (`mgr.onMouseDown(makeMouseEvent('mousedown', x, y, { detail: 2 }), camera)`)
 * and assert state on the InteractionManager after the click resolves.
 */

(function () {
    var describe = TestFramework.describe;
    var it = TestFramework.it;
    var assertEqual = TestFramework.assertEqual;
    var assertTrue = TestFramework.assertTrue;
    var assertFalse = TestFramework.assertFalse;
    var assertNotNull = TestFramework.assertNotNull;
    var assertNull = TestFramework.assertNull;

    // ============================================
    // Helpers (mirrors test-assignment.js patterns)
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
     * Build an env with one predicted unlinked instance on cam1 by default.
     * @param {object} [opts]
     *   - predictedPoints: number[][] of points for the predicted unlinked.
     *   - extraCallbacks: extra callbacks merged into the InteractionManager.
     */
    function buildEnv(opts) {
        opts = opts || {};
        var vw = 640, vh = 480;
        var predictedPoints = opts.predictedPoints || [[120, 120], [180, 180]];

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

        var predicted = new Instance(
            predictedPoints.map(function (p) { return p ? [p[0], p[1]] : null; }),
            0, 'predicted', 0.9
        );
        var predictedUl = session.addUnlinkedInstance(0, 'cam1', predicted);

        var canvas1 = createMockCanvas(vw, vh);
        var canvas2 = createMockCanvas(vw, vh);
        canvas2.style.left = vw + 'px';

        var views = [
            { name: 'cam1', overlayCanvas: canvas1, videoWidth: vw, videoHeight: vh },
            { name: 'cam2', overlayCanvas: canvas2, videoWidth: vw, videoHeight: vh },
        ];

        var assignmentCounts = [];
        var clonedGroups = [];
        var userInstancesCreated = [];

        var callbacks = {
            getState: function () {
                return { currentFrame: 0, session: session, views: views };
            },
            getInstanceGroups: function (frameIdx) {
                return session.getInstanceGroupsForFrame(frameIdx || 0);
            },
            onSelectionChanged: function () {},
            onInstanceDeleted: function () {},
            onNodeMoved: function () {},
            onAssignmentSelectionChanged: function (count) { assignmentCounts.push(count); },
            onClonePredictedGroup: function (group) { clonedGroups.push(group); },
            onUserInstanceCreated: function (viewName, points) {
                userInstancesCreated.push({ viewName: viewName, points: points });
            },
            requestRedraw: function () {},
        };
        if (opts.extraCallbacks) {
            for (var k in opts.extraCallbacks) {
                if (Object.prototype.hasOwnProperty.call(opts.extraCallbacks, k)) {
                    callbacks[k] = opts.extraCallbacks[k];
                }
            }
        }

        var mgr = new InteractionManager(callbacks);
        mgr.attach(views);

        var fg = session.getFrameGroup(0);

        return {
            session: session,
            skeleton: skeleton,
            mgr: mgr,
            views: views,
            canvas1: canvas1,
            canvas2: canvas2,
            fg: fg,
            predicted: predicted,
            predictedUl: predictedUl,
            predictedPoints: predictedPoints,
            assignmentCounts: assignmentCounts,
            clonedGroups: clonedGroups,
            userInstancesCreated: userInstancesCreated,
            cleanup: function () {
                mgr.detach();
                cleanupCanvases();
            },
        };
    }

    /**
     * Find the first user-typed UnlinkedInstance in the FrameGroup for a view.
     */
    function findUserUnlinked(fg, viewName) {
        var list = fg.getUnlinkedInstances(viewName);
        for (var i = 0; i < list.length; i++) {
            if (list[i].instance.type === 'user') return list[i];
        }
        return null;
    }

    /**
     * Find the first predicted-typed UnlinkedInstance in the FrameGroup for a
     * view. Used to confirm the original predicted is still in the pool after
     * the double-click.
     */
    function findPredictedUnlinked(fg, viewName) {
        var list = fg.getUnlinkedInstances(viewName);
        for (var i = 0; i < list.length; i++) {
            if (list[i].instance.type === 'predicted') return list[i];
        }
        return null;
    }

    // ================================================================
    // Suite: Issue 1 — predicted double-click selection transfer
    // ================================================================

    describe('Predicted double-click — selection transfers to new user instance', function () {

        it('double-click predicted unlinked → new user UnlinkedInstance is selected', function () {
            var env = buildEnv();
            var p = env.predictedPoints[0];

            env.mgr.onMouseDown(
                makeMouseEvent('mousedown', p[0], p[1], { detail: 2 }),
                'cam1'
            );

            var newUserUl = findUserUnlinked(env.fg, 'cam1');
            assertNotNull(newUserUl, 'a new user UnlinkedInstance was created');
            assertEqual(newUserUl.instance.type, 'user',
                'newly created instance is type "user"');

            assertNotNull(env.mgr.selectedUnlinked,
                'selectedUnlinked is set after double-click');
            assertEqual(env.mgr.selectedUnlinked.id, newUserUl.id,
                'selectedUnlinked points at the NEW user (not the predicted)');
            assertTrue(env.mgr.selectedUnlinked !== env.predictedUl,
                'selectedUnlinked is NOT the original predicted UnlinkedInstance');

            // Existing fix does NOT remove the original predicted from the pool.
            var stillPredicted = findPredictedUnlinked(env.fg, 'cam1');
            assertNotNull(stillPredicted,
                'original predicted unlinked is still in the unlinked pool');
            assertEqual(stillPredicted.id, env.predictedUl.id,
                'predicted UnlinkedInstance retains its original id');

            env.cleanup();
        });

        it('original predicted is replaced by the new user in assignmentSelection', function () {
            var env = buildEnv();
            var p = env.predictedPoints[0];

            env.mgr.onMouseDown(
                makeMouseEvent('mousedown', p[0], p[1], { detail: 2 }),
                'cam1'
            );

            var ids = env.mgr.getAssignmentSelectedIds();
            assertEqual(ids.indexOf(env.predictedUl.id), -1,
                'predicted unlinked id removed from assignmentSelection');

            // The new user is now the active assignment selection so the
            // user can SEE which instance they just created (gold highlight).
            var newUserUl = findUserUnlinked(env.fg, 'cam1');
            assertNotNull(newUserUl, 'new user UnlinkedInstance created');
            assertEqual(env.mgr.assignmentSelection.length, 1,
                'assignmentSelection now holds exactly the new user');
            assertEqual(env.mgr.assignmentSelection[0].id, newUserUl.id,
                'assignmentSelection[0] is the new user');
            assertTrue(env.mgr.assignmentMode,
                'assignmentMode is on so the user can immediately add more ' +
                'instances to a new group, matching single-click behavior');

            env.cleanup();
        });

        it('selection transfer fires onAssignmentSelectionChanged(1) for the new user', function () {
            var counts = [];
            var env = buildEnv({
                extraCallbacks: {
                    onAssignmentSelectionChanged: function (n) { counts.push(n); },
                },
            });
            var p = env.predictedPoints[0];

            // Single-click the predicted to put it into assignment selection
            // (auto-enters assignment mode + adds the predicted).
            env.mgr.onMouseDown(
                makeMouseEvent('mousedown', p[0], p[1], { detail: 1 }),
                'cam1'
            );
            assertTrue(env.mgr.assignmentMode,
                'assignmentMode enabled after single-click on predicted');
            assertEqual(env.mgr.assignmentSelection.length, 1,
                'predicted added to assignment selection');
            assertEqual(env.mgr.assignmentSelection[0].id, env.predictedUl.id,
                'assignmentSelection contains the predicted id');

            // Drop counts gathered up to now; we only care about callbacks
            // fired during the double-click clear-and-reselect.
            var beforeCount = counts.length;

            env.mgr.onMouseDown(
                makeMouseEvent('mousedown', p[0], p[1], { detail: 2 }),
                'cam1'
            );

            // After double-click, the new user is the sole entry; the host
            // should see at least one callback firing with count=1.
            var sawOne = false;
            for (var i = beforeCount; i < counts.length; i++) {
                if (counts[i] === 1) { sawOne = true; break; }
            }
            assertTrue(sawOne,
                'onAssignmentSelectionChanged fired with count=1 once the ' +
                'new user was added');
            assertEqual(env.mgr.getAssignmentSelectedIds().length, 1,
                'assignment selection contains exactly one entry post-dblclick');

            env.cleanup();
        });

        it('selection transfer when nothing was previously selected', function () {
            var env = buildEnv();
            var p = env.predictedPoints[0];

            // Sanity: pre-conditions — clean state.
            assertEqual(env.mgr.assignmentSelection.length, 0,
                'assignmentSelection empty before double-click');
            assertFalse(env.mgr.assignmentMode,
                'assignmentMode false before double-click');
            assertNull(env.mgr.selectedUnlinked,
                'no selectedUnlinked before double-click');

            // Should not throw.
            var threw = null;
            try {
                env.mgr.onMouseDown(
                    makeMouseEvent('mousedown', p[0], p[1], { detail: 2 }),
                    'cam1'
                );
            } catch (err) {
                threw = err;
            }
            assertNull(threw, 'double-click did not throw');

            var newUserUl = findUserUnlinked(env.fg, 'cam1');
            assertNotNull(newUserUl, 'new user UnlinkedInstance created');
            assertEqual(env.mgr.selectedUnlinked, newUserUl,
                'selectedUnlinked is the new user');
            // Even when nothing was selected before, the dblclick puts the
            // new user into assignment selection so it shows the
            // selected-color highlight (matching single-click behavior).
            assertEqual(env.mgr.assignmentSelection.length, 1,
                'assignmentSelection holds the new user');
            assertEqual(env.mgr.assignmentSelection[0].id, newUserUl.id,
                'assignmentSelection[0] is the new user');
            assertTrue(env.mgr.assignmentMode,
                'assignmentMode is on after dblclick');

            env.cleanup();
        });

        it('old selection cleared — selectedInstanceGroup not set', function () {
            var env = buildEnv();
            var p = env.predictedPoints[0];

            // Build an unrelated InstanceGroup and select it as the current
            // linked selection — this is the "old selection" we expect to be
            // cleared by the existing `select(null, -1)` line in the handler.
            var groupInst = new Instance([[400, 400], [450, 450]], 0, 'user', 1.0);
            var group = new InstanceGroup(99, 0);
            group.addInstance('cam2', groupInst);
            env.session.instanceGroups.set(0, [group]);
            env.mgr.select(group, -1);
            assertEqual(env.mgr.selectedInstanceGroup, group,
                'group is selected before double-click');

            // Now double-click the unrelated predicted on cam1.
            env.mgr.onMouseDown(
                makeMouseEvent('mousedown', p[0], p[1], { detail: 2 }),
                'cam1'
            );

            assertNull(env.mgr.selectedInstanceGroup,
                'selectedInstanceGroup cleared by select(null, -1)');
            assertEqual(env.mgr.selectedNodeIdx, -1,
                'selectedNodeIdx cleared');

            var newUserUl = findUserUnlinked(env.fg, 'cam1');
            assertNotNull(newUserUl, 'new user UnlinkedInstance created');
            assertEqual(env.mgr.selectedUnlinked, newUserUl,
                'selectedUnlinked is the new user');

            env.cleanup();
        });

        it('preserves multi-select on other views — only the same-camera entry is replaced', function () {
            // User observation (Prompt 7): when an unlinked predicted on cam1
            // is double-clicked, any in-progress assignment selection on
            // OTHER cameras must survive. addToAssignmentSelection's
            // same-camera-replace handles this naturally — only the cam1
            // predicted's slot is swapped for the new user; cam2 entries
            // are untouched.
            var env = buildEnv();

            // Seed an unrelated user unlinked on cam2 and put it in the
            // assignment selection (simulates a multi-select in progress).
            var cam2User = new Instance([[400, 400], [450, 450]], 0, 'user', 1.0);
            cam2User.modified = false;
            var cam2UserUl = env.session.addUnlinkedInstance(0, 'cam2', cam2User);

            env.mgr.setAssignmentMode(true);
            env.mgr.addToAssignmentSelection(env.predictedUl);
            env.mgr.addToAssignmentSelection(cam2UserUl);
            assertEqual(env.mgr.assignmentSelection.length, 2,
                'pre-condition: two entries selected (one per camera)');

            // Double-click the predicted on cam1 — should replace its
            // entry with the new user but leave cam2's entry intact.
            var p = env.predictedPoints[0];
            env.mgr.onMouseDown(
                makeMouseEvent('mousedown', p[0], p[1], { detail: 2 }),
                'cam1'
            );

            assertEqual(env.mgr.assignmentSelection.length, 2,
                'multi-select preserved (still 2 entries)');

            // cam2 entry untouched.
            var cam2Entry = null, cam1Entry = null;
            for (var i = 0; i < env.mgr.assignmentSelection.length; i++) {
                var e = env.mgr.assignmentSelection[i];
                if (e.cameraName === 'cam2') cam2Entry = e;
                else if (e.cameraName === 'cam1') cam1Entry = e;
            }
            assertNotNull(cam2Entry, 'cam2 entry survived');
            assertEqual(cam2Entry.id, cam2UserUl.id,
                'cam2 entry is the SAME UnlinkedInstance as before');

            // cam1 entry was swapped for the new user.
            assertNotNull(cam1Entry, 'cam1 entry exists');
            assertTrue(cam1Entry.id !== env.predictedUl.id,
                'cam1 entry is NOT the original predicted');
            assertEqual(cam1Entry.instance.type, 'user',
                'cam1 entry is the new user');

            env.cleanup();
        });

        it('linked predicted double-click flow remains correct', function () {
            // Build a fresh env where the predicted lives inside an
            // InstanceGroup (linked), NOT in the unlinked pool. The linked
            // predicted double-click should route through
            // `onClonePredictedGroup`, NOT through the unlinked branch we
            // touched in Issue 1.
            cleanupCanvases();

            var vw = 640, vh = 480;
            var skeleton = new Skeleton('mouse', ['nose', 'head'], [[0, 1]]);
            var cameras = [
                new Camera('cam1',
                    [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [vw, vh])
            ];
            var session = new Session(cameras, skeleton, ['track_0']);

            var predInst = new Instance([[150, 150], [220, 220]], 0, 'predicted', 0.9);
            var group = new InstanceGroup(7, 0);
            group.addInstance('cam1', predInst);
            session.instanceGroups.set(0, [group]);

            // Ensure the FrameGroup tracks this instance so the production
            // hit-testing surfaces a linked hit (mirrors test-predicted-conversion.js).
            var fg = new FrameGroup(0);
            fg.addInstance('cam1', predInst);
            session.addFrameGroup(fg);

            var canvas1 = createMockCanvas(vw, vh);
            var views = [
                { name: 'cam1', overlayCanvas: canvas1, videoWidth: vw, videoHeight: vh },
            ];

            var clonedGroups = [];
            var userInstancesCreated = [];
            var assignmentCounts = [];
            var mgr = new InteractionManager({
                getState: function () {
                    return { currentFrame: 0, session: session, views: views };
                },
                getInstanceGroups: function () { return [group]; },
                onSelectionChanged: function () {},
                onNodeMoved: function () {},
                onClonePredictedGroup: function (g) { clonedGroups.push(g); },
                onUserInstanceCreated: function (v, p) {
                    userInstancesCreated.push({ viewName: v, points: p });
                },
                onAssignmentSelectionChanged: function (n) { assignmentCounts.push(n); },
                requestRedraw: function () {},
            });
            mgr.attach(views);

            // Double-click on the linked predicted's first node.
            mgr.onMouseDown(
                makeMouseEvent('mousedown', 150, 150, { detail: 2 }),
                'cam1'
            );

            assertEqual(clonedGroups.length, 1,
                'onClonePredictedGroup callback fired exactly once');
            assertEqual(clonedGroups[0], group,
                'callback received the predicted group');
            assertEqual(userInstancesCreated.length, 0,
                'unlinked-branch callback (onUserInstanceCreated) NOT fired ' +
                'for linked predicted');

            mgr.detach();
            cleanupCanvases();
        });

    });
})();
