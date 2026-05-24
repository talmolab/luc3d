/**
 * test-mixed-group-integration.js — Cross-cutting integration tests
 * spanning predicted-double-click, mixed-group promotion, per-view
 * delete auto-ungroup, and the Edit Group `wasMixed` snapshot.
 *
 * Individual behaviors are covered in:
 *   - test-predicted-dblclick.js (predicted-double-click selection transfer)
 *   - test-mixed-group-promotion.js (mixed-group → user promotion)
 *   - test-delete-auto-ungroup.js (per-view delete reducing to size 1)
 *
 * This file exercises CROSS-CUTTING scenarios that span more than one of the
 * three fix sites at once:
 *
 *   Suite 1: double-click + per-view delete on a mixed group
 *            (Issue 1 selection transfer + Issue 3 auto-ungroup + Issue 2 promotion)
 *
 *   Suite 2: Edit Group reduces a mixed group to one predicted survivor
 *            (the new wasMixed snapshot in editGroupState — captured by
 *            startEditGroup, consumed by onEditGroupRemove and finishEditGroup
 *            size===1 branch). Mirrors the inline-script handlers in tests.
 *
 *   Suite 3: independence / ordering checks — confirms the cross-cutting fixes
 *            do not introduce hidden state and that scenarios work in arbitrary
 *            order.
 *
 *   Suite 4: Issue 1 + Issue 3 sequence (no mixed group at any point) — verifies
 *            the no-promotion path through the full pipeline.
 *
 * Each test is independent / idempotent: a fresh Session, FrameGroup,
 * InteractionManager, and DOM canvases are constructed inside each `it()`
 * block. No mutable globals are shared across tests.
 *
 * Mirrored host-side helpers:
 *   - editGroupRemoveBranch(...) mirrors onEditGroupRemove (index.html ~3346),
 *     INCLUDING the new srcMixed = (currentlyMixed || editGroupState.wasMixed)
 *     compound check.
 *   - finishEditGroupBranch(...) mirrors finishEditGroup (index.html ~5886),
 *     INCLUDING the size===1 path that now passes editGroupState.wasMixed as
 *     `forcePromoteToUser` to Session.unlinkGroup.
 */

(function () {
    var describe       = TestFramework.describe;
    var it             = TestFramework.it;
    var assertEqual    = TestFramework.assertEqual;
    var assertTrue     = TestFramework.assertTrue;
    var assertFalse    = TestFramework.assertFalse;
    var assertNotNull  = TestFramework.assertNotNull;
    var assertNull     = TestFramework.assertNull;

    // ============================================================
    // Shared fixture helpers
    // ============================================================

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

    function makeCamera(name, vw, vh) {
        return new Camera(
            name,
            [[600, 0, vw / 2], [0, 600, vh / 2], [0, 0, 1]],
            [0, 0, 0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
            [vw, vh]
        );
    }

    function makeSkeleton() {
        return new Skeleton('mouse', ['nose', 'head'], [[0, 1]]);
    }

    /**
     * Build a Session with N cameras, an empty FrameGroup at frame 0, an
     * InteractionManager with reasonable callbacks, and DOM-backed canvases
     * for each view. Does NOT pre-populate any groups or instances.
     */
    function buildBaseEnv(opts) {
        opts = opts || {};
        var camNames = opts.cameras || ['cam1', 'cam2'];
        var vw = 640, vh = 480;

        var skeleton = makeSkeleton();
        var cameras = camNames.map(function (n) { return makeCamera(n, vw, vh); });
        var session = new Session(cameras, skeleton, ['track_0', 'track_1', 'track_2', 'track_3']);

        var fg = new FrameGroup(0);
        session.addFrameGroup(fg);

        var canvases = {};
        var views = camNames.map(function (camName, idx) {
            var c = createMockCanvas(vw, vh);
            c.style.left = (idx * vw) + 'px';
            canvases[camName] = c;
            return { name: camName, overlayCanvas: c, videoWidth: vw, videoHeight: vh };
        });

        var deletedNotifs = [];
        var assignmentCounts = [];
        var userInstancesCreated = [];
        var clonedGroups = [];

        var mgr = new InteractionManager({
            getState: function () {
                return { currentFrame: 0, session: session, views: views };
            },
            getInstanceGroups: function (frameIdx) {
                return session.getInstanceGroupsForFrame(frameIdx || 0);
            },
            onSelectionChanged: function () {},
            onInstanceDeleted: function (frameIdx, group, deletedViews) {
                deletedNotifs.push({ frameIdx: frameIdx, group: group, deletedViews: deletedViews });
            },
            onNodeMoved: function () {},
            onAssignmentSelectionChanged: function (n) { assignmentCounts.push(n); },
            onClonePredictedGroup: function (g) { clonedGroups.push(g); },
            onUserInstanceCreated: function (v, p) {
                userInstancesCreated.push({ viewName: v, points: p });
            },
            requestRedraw: function () {},
        });
        mgr.attach(views);

        return {
            skeleton: skeleton,
            session: session,
            fg: fg,
            mgr: mgr,
            views: views,
            canvases: canvases,
            cameras: cameras,
            camNames: camNames,
            videoWidth: vw,
            videoHeight: vh,
            deletedNotifs: deletedNotifs,
            assignmentCounts: assignmentCounts,
            userInstancesCreated: userInstancesCreated,
            clonedGroups: clonedGroups,
            cleanup: function () {
                mgr.detach();
                cleanupCanvases();
            },
        };
    }

    /**
     * Find an UnlinkedInstance in the FrameGroup pool for `camName` that wraps
     * the given Instance object. Returns null if not present.
     */
    function findUnlinkedFor(fg, camName, instance) {
        var pool = fg.getUnlinkedInstances(camName) || [];
        for (var i = 0; i < pool.length; i++) {
            if (pool[i].instance === instance) return pool[i];
        }
        return null;
    }

    /**
     * Mirror of the production `onEditGroupRemove` body (index.html ~3346) —
     * pure data ops only. INCLUDES the new wasMixed-aware compound check:
     *   srcMixed = (currentlyMixed) OR (editGroupState.wasMixed === true)
     *
     * Returns the removed Instance.
     */
    function editGroupRemoveBranch(group, viewName, fg, editGroupState) {
        var inst = group.getInstance(viewName);
        if (!inst) return null;

        // Currently-mixed detection.
        var hasUser = false, hasPred = false;
        for (var entry of group.instances) {
            var _gInst = entry[1];
            if (_gInst.type === 'user') hasUser = true;
            else if (_gInst.type === 'predicted') hasPred = true;
        }
        var srcMixed = (hasUser && hasPred) ||
            !!(editGroupState && editGroupState.wasMixed);

        if (srcMixed && inst.type === 'predicted') {
            inst.type = 'user';
            inst.modified = true;
        }

        // Remove from group.
        group.instances.delete(viewName);

        // Sync observedPoints (Bug B2 invariant).
        if (group.observedPoints) {
            delete group.observedPoints[viewName];
        }

        // Move from FrameGroup linked → unlinked.
        if (fg) {
            var camInstances = fg.instances.get(viewName);
            if (camInstances) {
                var idx = camInstances.indexOf(inst);
                if (idx >= 0) camInstances.splice(idx, 1);
                if (camInstances.length === 0) fg.instances.delete(viewName);
            }
            var ul = new UnlinkedInstance(inst, viewName);
            fg.addUnlinkedInstance(viewName, ul);
        }

        return inst;
    }

    /**
     * Mirror of the production `finishEditGroup` size dispatch (index.html
     * ~5886) — pure data ops only. The size===1 branch now passes
     * editGroupState.wasMixed as the `forcePromoteToUser` arg to
     * Session.unlinkGroup.
     *
     * Returns one of:
     *   'removed'  — empty group removed
     *   'unlinked' — single-member group demoted (with possible promotion)
     *   'kept'     — multi-member group survives
     */
    function finishEditGroupBranch(session, frameIdx, group, editGroupState) {
        if (group.instances.size === 0) {
            session.removeInstanceGroup(frameIdx, group);
            return 'removed';
        } else if (group.instances.size === 1) {
            session.unlinkGroup(frameIdx, group,
                !!(editGroupState && editGroupState.wasMixed));
            return 'unlinked';
        }
        return 'kept';
    }

    /**
     * Mirror of `startEditGroup`'s wasMixed snapshot (index.html ~5805).
     * Returns the editGroupState object.
     */
    function startEditGroupSnapshot(group) {
        var hasUser = false, hasPred = false;
        var originalInstances = new Map();
        for (var entry of group.instances) {
            var camName = entry[0];
            var inst = entry[1];
            originalInstances.set(camName, inst);
            if (inst.type === 'user') hasUser = true;
            else if (inst.type === 'predicted') hasPred = true;
        }
        return {
            group: group,
            originalInstances: originalInstances,
            wasMixed: hasUser && hasPred,
        };
    }

    // ============================================================
    // Suite 1 — double-click + per-view delete on a mixed group
    //
    // Cross-cutting: Issue 1 (predicted-double-click creates user) +
    // Issue 3 (per-view delete reducing to size 1) + Issue 2 (mixed-group
    // promotion of the survivor).
    // ============================================================

    describe('Mixed group + delete-survivor — predicted survivor promoted to user', function () {

        it('double-click predicted → new user is selected; original predicted survives in pool', function () {
            // Phase 1: drive Issue 1 path through InteractionManager. The
            // predicted unlinked starts at (120, 120) on cam1.
            var env = buildBaseEnv({ cameras: ['cam1', 'cam2'] });
            try {
                var predInst = new Instance([[120, 120], [180, 180]], 0, 'predicted', 0.9);
                var predUl = env.session.addUnlinkedInstance(0, 'cam1', predInst);

                env.mgr.onMouseDown(
                    makeMouseEvent('mousedown', 120, 120, { detail: 2 }),
                    'cam1'
                );

                // New user UnlinkedInstance was created and selected.
                var pool = env.fg.getUnlinkedInstances('cam1') || [];
                var newUser = null;
                for (var i = 0; i < pool.length; i++) {
                    if (pool[i].instance.type === 'user') { newUser = pool[i]; break; }
                }
                assertNotNull(newUser, 'a new user UnlinkedInstance was created');
                assertEqual(env.mgr.selectedUnlinked, newUser,
                    'selectedUnlinked is the new user (not the original predicted)');
                assertTrue(env.mgr.selectedUnlinked !== predUl,
                    'selectedUnlinked is NOT the original predicted');
                // The new user is the active assignment selection so the
                // user can see which instance they just created (gold
                // highlight). Matches the regular unlinked-click flow.
                assertEqual(env.mgr.assignmentSelection.length, 1,
                    'assignmentSelection has exactly the new user');
                assertEqual(env.mgr.assignmentSelection[0].id, newUser.id,
                    'assignmentSelection[0] is the new user');
                // The original predicted is NOT in the assignment list:
                // addToAssignmentSelection replaced its same-camera entry
                // with the new user.
                var ids = env.mgr.getAssignmentSelectedIds();
                assertEqual(ids.indexOf(predUl.id), -1,
                    'original predicted id replaced in assignmentSelection');

                // Original predicted is still in pool (Issue 1 does not destroy it).
                var stillPredicted = null;
                for (var j = 0; j < pool.length; j++) {
                    if (pool[j].instance.type === 'predicted') { stillPredicted = pool[j]; break; }
                }
                assertNotNull(stillPredicted, 'original predicted still in pool');
                assertEqual(stillPredicted.id, predUl.id, 'predicted UnlinkedInstance retains id');
            } finally {
                env.cleanup();
            }
        });

        it('mixed group {cam1: user, cam2: pred} → delete user via _deleteSelected promotes survivor', function () {
            // Build a 2-member mixed group directly (the double-click of
            // Issue 1 produces an unlinked user instance, but linking that
            // up uses createGroupFromUnlinked, which we exercise here for
            // a clean cross-cutting scenario).
            var env = buildBaseEnv({ cameras: ['cam1', 'cam2'] });
            try {
                var userInst = new Instance([[150, 150], [220, 220]], 1, 'user', 1.0);
                userInst.modified = false;
                var predInst = new Instance([[300, 300], [360, 360]], 1, 'predicted', 0.85);
                predInst.modified = false;

                var userUl = env.session.addUnlinkedInstance(0, 'cam1', userInst);
                var predUl = env.session.addUnlinkedInstance(0, 'cam2', predInst);

                var group = env.session.createGroupFromUnlinked(0, [userUl, predUl], 1);

                // Sanity: createGroupFromUnlinked with mixed input now
                // eagerly promotes predicted → user, so the resulting group
                // is uniformly user. (Previously this would have been left
                // mixed; the promote-on-detach path was the only trigger.)
                assertEqual(group.instances.size, 2, 'group has 2 members');
                assertEqual(group.getInstance('cam1').type, 'user',
                    'cam1 is user (was already user)');
                assertEqual(group.getInstance('cam2').type, 'user',
                    'cam2 promoted to user at group creation (eager mixed → user)');

                // Delete the user via per-view delete on cam1.
                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam1';
                env.mgr._deleteSelected(false);

                // Group is gone (auto-ungrouped).
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 0, 'group dissolved');

                // Surviving predicted on cam2 was promoted to user.
                assertEqual(predInst.type, 'user',
                    'survivor (was predicted) PROMOTED to user (wasMixed flag honored)');
                assertTrue(predInst.modified === true,
                    'survivor flagged modified=true (promotion side-effect)');

                // Survivor lives in fg.unlinkedInstances under cam2.
                var ulCam2 = findUnlinkedFor(env.fg, 'cam2', predInst);
                assertNotNull(ulCam2, 'survivor in unlinked pool under cam2');

                // The deleted cam1 user is destructively gone (per-view delete is destructive).
                assertNull(findUnlinkedFor(env.fg, 'cam1', userInst),
                    'deleted cam1 user instance NOT in unlinked pool');
                assertFalse(env.fg.instances.has('cam1'),
                    'cam1 not in fg linked map');
            } finally {
                env.cleanup();
            }
        });

        it('mixed group {cam1: user, cam2: pred} → delete predicted leaves user untouched', function () {
            // Symmetric case: deleting the predicted leaves the user as the
            // sole survivor — it is already user, so promotion is a no-op
            // and modified stays whatever it was.
            var env = buildBaseEnv({ cameras: ['cam1', 'cam2'] });
            try {
                var userInst = new Instance([[150, 150], [220, 220]], 2, 'user', 1.0);
                userInst.modified = false;
                var predInst = new Instance([[300, 300], [360, 360]], 2, 'predicted', 0.85);
                predInst.modified = false;

                var userUl = env.session.addUnlinkedInstance(0, 'cam1', userInst);
                var predUl = env.session.addUnlinkedInstance(0, 'cam2', predInst);
                var group = env.session.createGroupFromUnlinked(0, [userUl, predUl], 2);

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam2';
                env.mgr._deleteSelected(false);

                assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0,
                    'group dissolved');
                assertEqual(userInst.type, 'user', 'survivor stays user');
                assertFalse(userInst.modified,
                    'survivor.modified untouched (already user — no promotion)');

                var ulCam1 = findUnlinkedFor(env.fg, 'cam1', userInst);
                assertNotNull(ulCam1, 'survivor user in cam1 unlinked pool');
            } finally {
                env.cleanup();
            }
        });
    });

    // ============================================================
    // Suite 2 — Edit Group reduces mixed group to one predicted
    //
    // The cross-cutting case for the new wasMixed snapshot in
    // editGroupState. Removing members during the edit can leave the group
    // with no current evidence of being mixed — but the snapshot taken at
    // edit-start preserves the rule.
    // ============================================================

    describe('Edit Group — wasMixed snapshot promotes lone predicted at finish', function () {

        it('Mixed {user, pred1, pred2} → remove user + pred1 → finishEditGroup size===1 promotes lone pred2', function () {
            var env = buildBaseEnv({ cameras: ['cam1', 'cam2', 'cam3'] });
            try {
                // Build mixed group {cam1: user, cam2: pred1, cam3: pred2}.
                // We DELIBERATELY bypass `createGroupFromUnlinked` here:
                // that path now eagerly promotes mixed groups to all-user
                // at construction time, which would defeat this test's
                // purpose. Building the group via the InstanceGroup
                // constructor + addInstance preserves the mixed state, as
                // would happen for groups loaded from a (non-LUCID) SLP.
                var userInst  = new Instance([[100, 100], [150, 150]], 1, 'user', 1.0);
                userInst.modified = false;
                var pred1Inst = new Instance([[200, 200], [250, 250]], 1, 'predicted', 0.85);
                pred1Inst.modified = false;
                var pred2Inst = new Instance([[300, 300], [360, 360]], 1, 'predicted', 0.80);
                pred2Inst.modified = false;

                env.fg.addInstance('cam1', userInst);
                env.fg.addInstance('cam2', pred1Inst);
                env.fg.addInstance('cam3', pred2Inst);
                var group = new InstanceGroup(101, 1);
                group.addInstance('cam1', userInst);
                group.addInstance('cam2', pred1Inst);
                group.addInstance('cam3', pred2Inst);
                if (!env.session.instanceGroups.has(0)) {
                    env.session.instanceGroups.set(0, []);
                }
                env.session.instanceGroups.get(0).push(group);

                // Pre-populate observedPoints so the B2 invariant is exercised too.
                group.observedPoints = {
                    cam1: userInst.points,
                    cam2: pred1Inst.points,
                    cam3: pred2Inst.points,
                };

                // ENTER edit-group mode → snapshot wasMixed=true.
                var editGroupState = startEditGroupSnapshot(group);
                assertTrue(editGroupState.wasMixed,
                    'precondition: edit-start snapshot has wasMixed=true');

                // Remove cam1 (user). The compound check sees mixed (user+pred
                // still present) → no promotion of removed user (no-op).
                var removedUser = editGroupRemoveBranch(group, 'cam1', env.fg, editGroupState);
                assertEqual(removedUser, userInst, 'removed instance is the user');
                assertEqual(removedUser.type, 'user', 'user stays user');
                assertFalse(removedUser.modified,
                    'removed user.modified untouched (no promotion fired on user)');
                var ulCam1 = findUnlinkedFor(env.fg, 'cam1', userInst);
                assertNotNull(ulCam1, 'cam1 user moved to unlinked pool');

                // Remove cam2 (pred1). Now group = {cam3: pred2} — currently
                // ALL-PREDICTED. Without the wasMixed snapshot, this removal
                // would leave pred1 unpromoted. With the snapshot, pred1 is
                // PROMOTED because editGroupState.wasMixed === true.
                var removedPred1 = editGroupRemoveBranch(group, 'cam2', env.fg, editGroupState);
                assertEqual(removedPred1, pred1Inst, 'removed instance is pred1');
                assertEqual(removedPred1.type, 'user',
                    'pred1 PROMOTED via wasMixed snapshot (group is no longer currently-mixed)');
                assertTrue(removedPred1.modified === true,
                    'pred1.modified=true after promotion');
                var ulCam2 = findUnlinkedFor(env.fg, 'cam2', pred1Inst);
                assertNotNull(ulCam2, 'cam2 pred1 in unlinked pool');

                // Group is now {cam3: pred2} — size 1, all-predicted CURRENTLY,
                // but wasMixed=true at snapshot.
                assertEqual(group.instances.size, 1, 'group reduced to size 1');
                assertEqual(group.getInstance('cam3'), pred2Inst, 'cam3 pred2 still in group');

                // Now FINISH edit group via the size===1 branch. The mirrored
                // helper passes editGroupState.wasMixed as forcePromoteToUser.
                var outcome = finishEditGroupBranch(env.session, 0, group, editGroupState);
                assertEqual(outcome, 'unlinked', 'size===1 branch fired');

                // Group is gone from session.
                assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0,
                    'group destroyed');

                // The lone pred2 was PROMOTED to user via forcePromoteToUser=true.
                assertEqual(pred2Inst.type, 'user',
                    'pred2 PROMOTED on finishEditGroup size===1 (force=wasMixed=true)');
                assertTrue(pred2Inst.modified === true,
                    'pred2.modified=true after promotion');

                // pred2 lives in fg.unlinkedInstances under cam3.
                var ulCam3 = findUnlinkedFor(env.fg, 'cam3', pred2Inst);
                assertNotNull(ulCam3, 'pred2 in cam3 unlinked pool (FrameGroup)');

                // Sanity: all three originals are now type='user' and accounted for.
                assertEqual(userInst.type, 'user', 'cam1 user is user (no promotion needed)');
                assertEqual(pred1Inst.type, 'user', 'cam2 pred1 promoted to user');
                assertEqual(pred2Inst.type, 'user', 'cam3 pred2 promoted to user');
            } finally {
                env.cleanup();
            }
        });

        it('Mixed → remove only the user → group all-predicted by current state but wasMixed snapshot still active', function () {
            // Verifies the wasMixed snapshot persists across multiple
            // onEditGroupRemove calls, NOT just the first.
            var env = buildBaseEnv({ cameras: ['cam1', 'cam2', 'cam3'] });
            try {
                // Bypass `createGroupFromUnlinked` (which eagerly promotes
                // mixed groups) so the group truly starts mixed at
                // edit-time — modeling an SLP-loaded mixed group.
                var userInst  = new Instance([[100, 100]], 1, 'user', 1.0);
                userInst.modified = false;
                var pred1Inst = new Instance([[200, 200]], 1, 'predicted', 0.85);
                pred1Inst.modified = false;
                var pred2Inst = new Instance([[300, 300]], 1, 'predicted', 0.80);
                pred2Inst.modified = false;

                env.fg.addInstance('cam1', userInst);
                env.fg.addInstance('cam2', pred1Inst);
                env.fg.addInstance('cam3', pred2Inst);
                var group = new InstanceGroup(102, 1);
                group.addInstance('cam1', userInst);
                group.addInstance('cam2', pred1Inst);
                group.addInstance('cam3', pred2Inst);
                if (!env.session.instanceGroups.has(0)) {
                    env.session.instanceGroups.set(0, []);
                }
                env.session.instanceGroups.get(0).push(group);

                var editGroupState = startEditGroupSnapshot(group);
                assertTrue(editGroupState.wasMixed, 'wasMixed=true at start');

                // Remove the only user first. Group is now {pred1, pred2} —
                // currently all-predicted, but wasMixed=true.
                editGroupRemoveBranch(group, 'cam1', env.fg, editGroupState);
                assertEqual(group.instances.size, 2, 'group at size 2 (both predicted)');

                // Now remove pred1. wasMixed snapshot says SOURCE was mixed,
                // so pred1 must be promoted even though the current group is
                // all-predicted.
                var removed = editGroupRemoveBranch(group, 'cam2', env.fg, editGroupState);
                assertEqual(removed, pred1Inst, 'removed pred1');
                assertEqual(removed.type, 'user',
                    'pred1 promoted to user (wasMixed snapshot persists across removals)');
                assertTrue(removed.modified === true, 'pred1.modified=true');

                // Group now {cam3: pred2} — finishing demotes & promotes.
                var outcome = finishEditGroupBranch(env.session, 0, group, editGroupState);
                assertEqual(outcome, 'unlinked', 'size===1 branch');
                assertEqual(pred2Inst.type, 'user', 'pred2 promoted on finish');
                assertTrue(pred2Inst.modified === true, 'pred2.modified=true');
            } finally {
                env.cleanup();
            }
        });

        it('All-predicted edit (wasMixed=false) → finishEditGroup size===1 does NOT promote', function () {
            // Negative case: a non-mixed group's edit should NOT trigger
            // promotion via wasMixed (it stays false).
            var env = buildBaseEnv({ cameras: ['cam1', 'cam2'] });
            try {
                var pred1 = new Instance([[100, 100]], 1, 'predicted', 0.9);
                pred1.modified = false;
                var pred2 = new Instance([[200, 200]], 1, 'predicted', 0.8);
                pred2.modified = false;

                var ul1 = env.session.addUnlinkedInstance(0, 'cam1', pred1);
                var ul2 = env.session.addUnlinkedInstance(0, 'cam2', pred2);
                var group = env.session.createGroupFromUnlinked(0, [ul1, ul2], 1);

                var editGroupState = startEditGroupSnapshot(group);
                assertFalse(editGroupState.wasMixed,
                    'precondition: all-predicted snapshot has wasMixed=false');

                // Remove cam1 → group reduces to {cam2: pred2}.
                editGroupRemoveBranch(group, 'cam1', env.fg, editGroupState);
                assertEqual(pred1.type, 'predicted',
                    'pred1 NOT promoted (wasMixed=false, currently all-predicted)');

                // Finish via size===1 branch — passes wasMixed=false.
                var outcome = finishEditGroupBranch(env.session, 0, group, editGroupState);
                assertEqual(outcome, 'unlinked', 'size===1 branch fired');

                assertEqual(pred2.type, 'predicted',
                    'pred2 stays predicted (wasMixed=false → no force promotion)');
                assertFalse(pred2.modified, 'pred2.modified untouched');
            } finally {
                env.cleanup();
            }
        });
    });

    // ============================================================
    // Suite 3 — independence and ordering
    //
    // Each scenario is run in its own `it()` block with a fresh env to
    // confirm the cross-cutting behavior does not depend on shared mutable
    // state. The suite as a whole should produce identical results regardless
    // of `it()` execution order.
    // ============================================================

    describe('Promotion semantics — independence across orderings and re-runs', function () {

        it('Scenario A: pure all-predicted group → ungroup via Session.unlinkGroup → no promotion', function () {
            var env = buildBaseEnv({ cameras: ['cam1', 'cam2'] });
            try {
                var pred1 = new Instance([[100, 100]], 0, 'predicted', 0.9);
                pred1.modified = false;
                var pred2 = new Instance([[200, 200]], 0, 'predicted', 0.85);
                pred2.modified = false;
                var ul1 = env.session.addUnlinkedInstance(0, 'cam1', pred1);
                var ul2 = env.session.addUnlinkedInstance(0, 'cam2', pred2);
                var group = env.session.createGroupFromUnlinked(0, [ul1, ul2], 0);

                // Auto-detect path (no force flag) — group is not mixed.
                var newUnlinked = env.session.unlinkGroup(0, group);

                assertEqual(newUnlinked.length, 2, 'two unlinked produced');
                assertEqual(pred1.type, 'predicted',
                    'pred1 stays predicted (wasMixed mechanism does not leak)');
                assertEqual(pred2.type, 'predicted',
                    'pred2 stays predicted (wasMixed mechanism does not leak)');
                assertFalse(pred1.modified, 'pred1.modified untouched');
                assertFalse(pred2.modified, 'pred2.modified untouched');
                assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0,
                    'group removed');
            } finally {
                env.cleanup();
            }
        });

        it('Scenario B: pure all-user group → ungroup via Session.unlinkGroup → no-op (types unchanged)', function () {
            var env = buildBaseEnv({ cameras: ['cam1', 'cam2'] });
            try {
                var u1 = new Instance([[100, 100]], 0, 'user', 1.0);
                u1.modified = false;
                var u2 = new Instance([[200, 200]], 0, 'user', 1.0);
                u2.modified = true; // arbitrary distinct value to verify preservation

                var ul1 = env.session.addUnlinkedInstance(0, 'cam1', u1);
                var ul2 = env.session.addUnlinkedInstance(0, 'cam2', u2);
                var group = env.session.createGroupFromUnlinked(0, [ul1, ul2], 0);

                env.session.unlinkGroup(0, group);

                assertEqual(u1.type, 'user', 'u1 still user');
                assertEqual(u2.type, 'user', 'u2 still user');
                // The promotion path only mutates predicted-typed members;
                // user.modified is preserved.
                assertFalse(u1.modified, 'u1.modified preserved (false)');
                assertTrue(u2.modified, 'u2.modified preserved (true)');
                assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0,
                    'group removed');
            } finally {
                env.cleanup();
            }
        });

        it('Scenario C: mixed group → ungroup via Session.unlinkGroup (no force) → auto-detect promotes', function () {
            var env = buildBaseEnv({ cameras: ['cam1', 'cam2', 'cam3'] });
            try {
                var u = new Instance([[100, 100]], 0, 'user', 1.0);
                u.modified = false;
                var p1 = new Instance([[200, 200]], 0, 'predicted', 0.85);
                p1.modified = false;
                var p2 = new Instance([[300, 300]], 0, 'predicted', 0.80);
                p2.modified = false;

                var ul1 = env.session.addUnlinkedInstance(0, 'cam1', u);
                var ul2 = env.session.addUnlinkedInstance(0, 'cam2', p1);
                var ul3 = env.session.addUnlinkedInstance(0, 'cam3', p2);
                var group = env.session.createGroupFromUnlinked(0, [ul1, ul2, ul3], 0);

                // No force flag — auto-detect from current composition.
                env.session.unlinkGroup(0, group);

                assertEqual(u.type, 'user', 'cam1 still user');
                assertEqual(p1.type, 'user', 'cam2 promoted via auto-detect');
                assertEqual(p2.type, 'user', 'cam3 promoted via auto-detect');
                assertTrue(p1.modified === true, 'p1.modified=true');
                assertTrue(p2.modified === true, 'p2.modified=true');
                // user side untouched.
                assertFalse(u.modified, 'u.modified untouched');
            } finally {
                env.cleanup();
            }
        });

        it('Scenario D: re-running Scenario A in the same test body produces same result', function () {
            // Independence sanity: run A's setup twice in one test to confirm
            // no leakage between back-to-back runs.
            for (var iter = 0; iter < 2; iter++) {
                var env = buildBaseEnv({ cameras: ['cam1', 'cam2'] });
                try {
                    var pred1 = new Instance([[100, 100]], 0, 'predicted', 0.9);
                    pred1.modified = false;
                    var pred2 = new Instance([[200, 200]], 0, 'predicted', 0.85);
                    pred2.modified = false;
                    var ul1 = env.session.addUnlinkedInstance(0, 'cam1', pred1);
                    var ul2 = env.session.addUnlinkedInstance(0, 'cam2', pred2);
                    var group = env.session.createGroupFromUnlinked(0, [ul1, ul2], 0);

                    env.session.unlinkGroup(0, group);

                    assertEqual(pred1.type, 'predicted',
                        'iter ' + iter + ': pred1 stays predicted');
                    assertEqual(pred2.type, 'predicted',
                        'iter ' + iter + ': pred2 stays predicted');
                } finally {
                    env.cleanup();
                }
            }
        });

        it('Scenario E: independence — Scenario A after a mixed-group fixture in same `it` does not leak', function () {
            // First, build a mixed group and unlink it (auto-detect promotes).
            var env1 = buildBaseEnv({ cameras: ['camA', 'camB'] });
            try {
                var um = new Instance([[100, 100]], 0, 'user', 1.0);
                var pm = new Instance([[200, 200]], 0, 'predicted', 0.85);
                pm.modified = false;
                var ulm1 = env1.session.addUnlinkedInstance(0, 'camA', um);
                var ulm2 = env1.session.addUnlinkedInstance(0, 'camB', pm);
                var gm = env1.session.createGroupFromUnlinked(0, [ulm1, ulm2], 0);
                env1.session.unlinkGroup(0, gm);
                assertEqual(pm.type, 'user', 'mixed: pm promoted');
            } finally {
                env1.cleanup();
            }

            // Now build a SECOND, independent all-predicted env and confirm
            // it does NOT promote.
            var env2 = buildBaseEnv({ cameras: ['cam1', 'cam2'] });
            try {
                var pred1 = new Instance([[100, 100]], 0, 'predicted', 0.9);
                pred1.modified = false;
                var pred2 = new Instance([[200, 200]], 0, 'predicted', 0.85);
                pred2.modified = false;
                var ul1 = env2.session.addUnlinkedInstance(0, 'cam1', pred1);
                var ul2 = env2.session.addUnlinkedInstance(0, 'cam2', pred2);
                var group = env2.session.createGroupFromUnlinked(0, [ul1, ul2], 0);
                env2.session.unlinkGroup(0, group);

                assertEqual(pred1.type, 'predicted',
                    'second env: pred1 stays predicted (no leakage from mixed env)');
                assertEqual(pred2.type, 'predicted',
                    'second env: pred2 stays predicted (no leakage from mixed env)');
            } finally {
                env2.cleanup();
            }
        });
    });

    // ============================================================
    // Suite 4 — Issue 1 + Issue 3 sequence (no mixed group)
    //
    // Drives the full flow: double-click predicted → new user → link to a
    // second user-unlinked → 2-user group → per-view delete one member →
    // group dissolved, survivor demoted (no promotion needed).
    // ============================================================

    describe('Predicted dblclick + group + delete — non-mixed end-to-end sequence', function () {

        it('double-click predicted on cam1 → group new user with cam2 user → per-view delete dissolves cleanly', function () {
            var env = buildBaseEnv({ cameras: ['cam1', 'cam2'] });
            try {
                // Step 1: place a predicted unlinked on cam1 and a user
                // unlinked on cam2.
                var predInst = new Instance([[120, 120], [180, 180]], 0, 'predicted', 0.9);
                env.session.addUnlinkedInstance(0, 'cam1', predInst);

                var cam2User = new Instance([[400, 400], [450, 450]], 0, 'user', 1.0);
                cam2User.modified = false;
                var cam2UserUl = env.session.addUnlinkedInstance(0, 'cam2', cam2User);

                // Step 2: drive Issue 1 double-click on cam1 predicted.
                env.mgr.onMouseDown(
                    makeMouseEvent('mousedown', 120, 120, { detail: 2 }),
                    'cam1'
                );

                // Verify: selectedUnlinked is the new user on cam1, NOT the
                // original predicted. assignmentSelection is empty.
                var pool1 = env.fg.getUnlinkedInstances('cam1') || [];
                var newUserUl = null;
                for (var i = 0; i < pool1.length; i++) {
                    if (pool1[i].instance.type === 'user') { newUserUl = pool1[i]; break; }
                }
                assertNotNull(newUserUl, 'new user UnlinkedInstance created on cam1');
                assertEqual(env.mgr.selectedUnlinked, newUserUl,
                    'selectedUnlinked is the new user (Issue 1 fix)');
                // The dblclick enters assignment mode with the new user as
                // the sole entry (matches the single-click flow). Multi-
                // select on other cameras would be preserved if any.
                assertEqual(env.mgr.assignmentSelection.length, 1,
                    'assignmentSelection has the new user');
                assertEqual(env.mgr.assignmentSelection[0].id, newUserUl.id,
                    'assignmentSelection[0] is the new user');
                assertTrue(env.mgr.assignmentMode,
                    'assignmentMode enabled (so subsequent unlinked clicks ' +
                    'multi-select naturally)');

                // Step 3: link the new cam1 user with the cam2 user.
                var group = env.session.createGroupFromUnlinked(
                    0, [newUserUl, cam2UserUl], 0
                );
                assertEqual(group.instances.size, 2, '2-user group formed');
                assertEqual(group.getInstance('cam1').type, 'user', 'cam1 in group is user');
                assertEqual(group.getInstance('cam2').type, 'user', 'cam2 in group is user');

                // Step 4: per-view delete cam1 (the new user) — the
                // surviving cam2 user must NOT be promoted (group was never
                // mixed).
                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam1';
                env.mgr._deleteSelected(false);

                // Group is gone (auto-ungrouped from 2 → 1).
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 0, 'group dissolved by per-view delete');

                // Survivor on cam2 stays user, modified untouched.
                assertEqual(cam2User.type, 'user', 'cam2 survivor stays user');
                assertFalse(cam2User.modified,
                    'cam2.modified untouched (no promotion needed — group was never mixed)');

                // cam2 survivor is in unlinked pool.
                var ulCam2 = findUnlinkedFor(env.fg, 'cam2', cam2User);
                assertNotNull(ulCam2, 'cam2 survivor in unlinked pool');

                // cam1 user is destructively gone.
                assertNull(findUnlinkedFor(env.fg, 'cam1', newUserUl.instance),
                    'deleted cam1 user destructively removed');
                assertFalse(env.fg.instances.has('cam1'),
                    'cam1 not in fg linked map');

                // Original predicted unlinked on cam1 still survives in pool
                // (Issue 1 contract).
                var stillPred = null;
                var pool1After = env.fg.getUnlinkedInstances('cam1') || [];
                for (var j = 0; j < pool1After.length; j++) {
                    if (pool1After[j].instance.type === 'predicted') {
                        stillPred = pool1After[j]; break;
                    }
                }
                assertNotNull(stillPred,
                    'original predicted still in cam1 unlinked pool');
            } finally {
                env.cleanup();
            }
        });

        it('double-click predicted, then per-view delete the new user before grouping → predicted survives in pool', function () {
            // Variant: confirm that Issue 1's new-user creation followed by an
            // immediate delete of that user leaves the original predicted
            // intact in the pool.
            var env = buildBaseEnv({ cameras: ['cam1', 'cam2'] });
            try {
                var predInst = new Instance([[120, 120], [180, 180]], 0, 'predicted', 0.9);
                var predUl = env.session.addUnlinkedInstance(0, 'cam1', predInst);

                env.mgr.onMouseDown(
                    makeMouseEvent('mousedown', 120, 120, { detail: 2 }),
                    'cam1'
                );

                // The new user is now selected (selectedUnlinked).
                var newUserUl = env.mgr.selectedUnlinked;
                assertNotNull(newUserUl, 'new user is selected');
                assertEqual(newUserUl.instance.type, 'user',
                    'selected unlinked is the new user');
                assertTrue(newUserUl !== predUl,
                    'selected unlinked is NOT the original predicted');

                // Delete the new user via the unlinked-delete branch in
                // _deleteSelected (selectedUnlinked path).
                env.mgr.lastInteractedView = 'cam1';
                env.mgr._deleteSelected(false);

                // The new user is gone from the unlinked pool, but the
                // original predicted still survives.
                assertNull(findUnlinkedFor(env.fg, 'cam1', newUserUl.instance),
                    'new user removed from unlinked pool');
                var stillPred = findUnlinkedFor(env.fg, 'cam1', predInst);
                assertNotNull(stillPred,
                    'original predicted still in unlinked pool (Issue 1 does not destroy)');
                assertEqual(stillPred.id, predUl.id,
                    'predicted UnlinkedInstance retains its id');

                // Selection cleared.
                assertNull(env.mgr.selectedUnlinked,
                    'selectedUnlinked cleared after delete');
            } finally {
                env.cleanup();
            }
        });
    });

})();
