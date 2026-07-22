/**
 * test-delete-auto-ungroup.js — Regression tests for per-view delete
 * (Del key) that drops a multi-member group to a single survivor.
 *
 * Fix under test (interaction.js _deleteSelected, ~lines 1828-1885):
 *   BEFORE: per-view delete only handled the "drops to 0" case (full
 *   removal). A 2-member group reduced to 1 silently violated the
 *   "groups have ≥ 2 members" invariant.
 *
 *   AFTER: the per-view delete path now also handles the "drops to 1"
 *   case: it captures the pre-deletion `wasMixed` flag, then calls
 *   `session.unlinkGroup(frameIdx, group, wasMixed)` to demote the
 *   lone survivor back to the unlinked pool. This is also the
 *   cross-cutting case for Issue 2: when the deleted partner was a
 *   user and the survivor is predicted, `wasMixed=true` forces the
 *   survivor to be promoted to user (`type='user'`, `modified=true`).
 *
 * The host-side reprojection cleanup (`onInstanceDeleted` in
 * index.html → `purgeTriangulationDataForGroup`) lives in the inline
 * SPA script and isn't directly testable here. Suite 3 mirrors that
 * helper in-test and uses the data-model invariant
 * `session.instanceGroups[frameIdx]` to verify the demoted group is
 * fully gone.
 */

(function () {
    var describe       = TestFramework.describe;
    var it             = TestFramework.it;
    var assert         = TestFramework.assert;
    var assertEqual    = TestFramework.assertEqual;
    var assertTrue     = TestFramework.assertTrue;
    var assertFalse    = TestFramework.assertFalse;
    var assertNotNull  = TestFramework.assertNotNull;
    var assertNull     = TestFramework.assertNull;

    // ============================================================
    // Test environment helpers
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
     * Build a Session with N cameras and one InstanceGroup containing
     * one Instance per camera. Each instance's type can be specified
     * via opts.types (a parallel array, default 'user' for all).
     *
     * Mirrors the buildGroupedEnv pattern from test-edit-group-fixes.js,
     * with the added `types` knob to construct mixed/predicted groups
     * for Issue 3 / Issue 2 cross-cutting tests.
     */
    function buildGroupedEnv(opts) {
        opts = opts || {};
        var camNames = opts.cameras || ['cam1', 'cam2'];
        var types    = opts.types    || camNames.map(function () { return 'user'; });
        var vw = opts.videoWidth  || 640;
        var vh = opts.videoHeight || 480;
        var trackIdx = opts.trackIdx != null ? opts.trackIdx : 3;

        var skeleton = makeSkeleton();
        var cameras  = camNames.map(function (n) { return makeCamera(n, vw, vh); });
        var session  = new Session(cameras, skeleton, ['track_0', 'track_1', 'track_2', 'track_3', 'track_4']);

        var fg = new FrameGroup(0);

        var instances = {};
        camNames.forEach(function (camName, idx) {
            var base = 100 + idx * 100;
            var t = types[idx] || 'user';
            var inst = new Instance([[base, base], [base + 50, base + 50]], trackIdx, t, t === 'user' ? 1.0 : 0.7);
            instances[camName] = inst;
            fg.addInstance(camName, inst);
        });
        session.addFrameGroup(fg);

        var group = new InstanceGroup(42, trackIdx);
        camNames.forEach(function (camName) {
            group.addInstance(camName, instances[camName]);
        });
        if (!session.instanceGroups.has(0)) session.instanceGroups.set(0, []);
        session.instanceGroups.get(0).push(group);

        // Build views + canvases for InteractionManager attach
        var canvases = {};
        var views = camNames.map(function (camName, idx) {
            var c = createMockCanvas(vw, vh);
            c.style.left = (idx * vw) + 'px';
            canvases[camName] = c;
            return { name: camName, overlayCanvas: c, videoWidth: vw, videoHeight: vh };
        });

        var deletedNotifs = [];
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
            requestRedraw: function () {},
        });
        mgr.attach(views);

        return {
            skeleton: skeleton,
            session: session,
            fg: fg,
            group: group,
            instances: instances,
            mgr: mgr,
            views: views,
            canvases: canvases,
            cameras: cameras,
            camNames: camNames,
            trackIdx: trackIdx,
            deletedNotifs: deletedNotifs,
            cleanup: function () {
                mgr.detach();
                cleanupCanvases();
            },
        };
    }

    /**
     * Find the UnlinkedInstance in fg's unlinked pool for the given
     * camera name that wraps the given Instance. Returns null if not
     * found.
     */
    function findUnlinkedFor(fg, camName, instance) {
        var pool = fg.getUnlinkedInstances(camName) || [];
        for (var i = 0; i < pool.length; i++) {
            if (pool[i].instance === instance) return pool[i];
        }
        return null;
    }

    /**
     * Mirrors purgeTriangulationDataForGroup from index.html — used for
     * the data-model invariant checks in Suite 3 (the host calls this
     * helper from onInstanceDeleted whenever the group is no longer
     * in session.instanceGroups).
     */
    function purgeTriangulationDataForGroup(frameIdx, group) {
        if (!group) return;
        if (group.reprojectedInstances && typeof group.reprojectedInstances.clear === 'function') {
            group.reprojectedInstances.clear();
        }
        group.reprojections = null;
        group.observedPoints = null;
        group.points3d = null;
    }

    // ============================================================
    // Suite 1 — delete from a 2-member group auto-ungroups survivor
    // ============================================================

    describe('Per-view delete — 2-member group auto-ungroups its survivor', function () {

        it('{cam1: user, cam2: user}: deleting cam2 dissolves group; cam1 survives as user (no promotion)', function () {
            var env = buildGroupedEnv({
                cameras: ['cam1', 'cam2'],
                types: ['user', 'user'],
                trackIdx: 7,
            });
            try {
                var group = env.group;
                var loneInst = env.instances.cam1;
                var doomedInst = env.instances.cam2;

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam2';

                env.mgr._deleteSelected(false); // per-view delete

                // Group is gone from session.instanceGroups
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 0, 'group dissolved (auto-ungrouped)');

                // cam1's user survives in the unlinked pool
                var ul1 = findUnlinkedFor(env.fg, 'cam1', loneInst);
                assertNotNull(ul1, 'cam1 instance is in unlinked pool');
                assertEqual(loneInst.type, 'user', 'survivor stays user');
                assertFalse(loneInst.modified,
                    'survivor not flagged modified (no promotion needed)');
                assertEqual(loneInst.trackIdx, 7, 'trackIdx preserved');

                // cam2's instance is fully gone (per-view delete is destructive)
                var ul2 = findUnlinkedFor(env.fg, 'cam2', doomedInst);
                assertNull(ul2, 'deleted cam2 instance NOT in unlinked pool');
                assertFalse(env.fg.instances.has('cam2'),
                    'cam2 not in fg linked map either');
            } finally {
                env.cleanup();
            }
        });

        it('{cam1: pred, cam2: pred}: deleting cam2 dissolves group; cam1 survives as predicted (no promotion)', function () {
            var env = buildGroupedEnv({
                cameras: ['cam1', 'cam2'],
                types: ['predicted', 'predicted'],
                trackIdx: 5,
            });
            try {
                var group = env.group;
                var loneInst = env.instances.cam1;

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam2';

                env.mgr._deleteSelected(false);

                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 0, 'group dissolved');

                var ul1 = findUnlinkedFor(env.fg, 'cam1', loneInst);
                assertNotNull(ul1, 'cam1 predicted survives in unlinked pool');
                assertEqual(loneInst.type, 'predicted',
                    'survivor stays predicted (group was not mixed)');
                assertFalse(loneInst.modified,
                    'survivor not flagged modified (no promotion)');
            } finally {
                env.cleanup();
            }
        });

        it('{cam1: user, cam2: pred}: deleting cam2 (predicted) leaves cam1 user untouched', function () {
            var env = buildGroupedEnv({
                cameras: ['cam1', 'cam2'],
                types: ['user', 'predicted'],
                trackIdx: 2,
            });
            try {
                var group = env.group;
                var loneInst = env.instances.cam1;

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam2';

                env.mgr._deleteSelected(false);

                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 0, 'group dissolved');

                var ul1 = findUnlinkedFor(env.fg, 'cam1', loneInst);
                assertNotNull(ul1, 'cam1 user survives in unlinked pool');
                assertEqual(loneInst.type, 'user',
                    'survivor stays user (already user — no promotion needed)');
                // The user instance was NOT modified by this op; we only
                // deleted its predicted partner. The survivor's `modified`
                // flag should remain whatever it was pre-delete (false here).
                assertFalse(loneInst.modified,
                    'survivor.modified untouched (no promotion fired on already-user)');
            } finally {
                env.cleanup();
            }
        });

        it('CROSS-CUTTING: {cam1: pred, cam2: user}: deleting cam2 (user) PROMOTES cam1 predicted -> user', function () {
            // Phase 2's cross-cutting case: the deleted partner was the
            // user, so the surviving predicted gets promoted to user
            // (type='user', modified=true) via the wasMixed flag.
            var env = buildGroupedEnv({
                cameras: ['cam1', 'cam2'],
                types: ['predicted', 'user'],
                trackIdx: 1,
            });
            try {
                var group = env.group;
                var survivor = env.instances.cam1;

                // Sanity: survivor starts as predicted, not modified.
                assertEqual(survivor.type, 'predicted', 'precondition: cam1 predicted');
                assertFalse(survivor.modified, 'precondition: not modified');

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam2'; // delete the user

                env.mgr._deleteSelected(false);

                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 0, 'group dissolved');

                var ul1 = findUnlinkedFor(env.fg, 'cam1', survivor);
                assertNotNull(ul1, 'cam1 instance is in unlinked pool');
                assertEqual(survivor.type, 'user',
                    'survivor PROMOTED to user (wasMixed → forcePromoteToUser)');
                assertTrue(survivor.modified,
                    'survivor flagged modified (promotion side-effect)');
                assertEqual(survivor.trackIdx, 1, 'trackIdx preserved through promotion');
            } finally {
                env.cleanup();
            }
        });
    });

    // ============================================================
    // Suite 2 — delete from a 3-member group preserves the group
    // ============================================================

    describe('Per-view delete — 3-member group survives at size 2', function () {

        it('{cam1: user, cam2: pred, cam3: pred}: deleting cam2 keeps the group at size 2', function () {
            var env = buildGroupedEnv({
                cameras: ['cam1', 'cam2', 'cam3'],
                types: ['user', 'predicted', 'predicted'],
                trackIdx: 2,
            });
            try {
                var group = env.group;
                var cam1Inst = env.instances.cam1;
                var cam2Inst = env.instances.cam2;
                var cam3Inst = env.instances.cam3;

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam2';

                env.mgr._deleteSelected(false);

                // Group survives at size 2.
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 1, 'group still in session');
                assertTrue(groups[0] === group, 'same group object');
                assertEqual(group.instances.size, 2, 'group has 2 members left');
                assertTrue(group.instances.has('cam1'), 'cam1 still in group');
                assertTrue(group.instances.has('cam3'), 'cam3 still in group');
                assertFalse(group.instances.has('cam2'), 'cam2 removed from group');

                // Survivors keep their original types — no auto-ungroup,
                // so no promotion is triggered.
                assertEqual(cam1Inst.type, 'user', 'cam1 still user');
                assertEqual(cam3Inst.type, 'predicted', 'cam3 still predicted');
                assertFalse(cam1Inst.modified, 'cam1 not flagged modified');
                assertFalse(cam3Inst.modified, 'cam3 not flagged modified');

                // Deleted instance is gone from FrameGroup AND not in
                // unlinked pool (per-view delete is destructive).
                var cam2Linked = env.fg.getInstances('cam2') || [];
                assertEqual(cam2Linked.length, 0, 'cam2 not in fg linked');
                var cam2Unlinked = findUnlinkedFor(env.fg, 'cam2', cam2Inst);
                assertNull(cam2Unlinked,
                    'deleted cam2 instance NOT pushed to unlinked pool');
            } finally {
                env.cleanup();
            }
        });

        it('{cam1: user, cam2: user, cam3: user}: deleting cam3 keeps group at size 2; survivors stay user', function () {
            var env = buildGroupedEnv({
                cameras: ['cam1', 'cam2', 'cam3'],
                types: ['user', 'user', 'user'],
                trackIdx: 4,
            });
            try {
                var group = env.group;
                var cam1Inst = env.instances.cam1;
                var cam2Inst = env.instances.cam2;
                var cam3Inst = env.instances.cam3;

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam3';

                env.mgr._deleteSelected(false);

                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 1, 'group preserved');
                assertEqual(group.instances.size, 2, 'group at size 2');
                assertTrue(group.instances.has('cam1'), 'cam1 still in');
                assertTrue(group.instances.has('cam2'), 'cam2 still in');
                assertFalse(group.instances.has('cam3'), 'cam3 removed');

                assertEqual(cam1Inst.type, 'user', 'cam1 still user');
                assertEqual(cam2Inst.type, 'user', 'cam2 still user');

                var cam3Unlinked = findUnlinkedFor(env.fg, 'cam3', cam3Inst);
                assertNull(cam3Unlinked, 'cam3 destructively removed');
            } finally {
                env.cleanup();
            }
        });
    });

    // ============================================================
    // Suite 3 — group entry removed from session.instanceGroups
    // after auto-ungroup (data-model invariant)
    // ============================================================

    describe('Per-view delete — instanceGroups entry is removed after auto-ungroup', function () {

        it('pre-delete count=1; post-delete the group is no longer in session.instanceGroups[frameIdx]', function () {
            var env = buildGroupedEnv({
                cameras: ['cam1', 'cam2'],
                types: ['user', 'user'],
            });
            try {
                var group = env.group;

                // Pre-delete invariant.
                var preGroups = env.session.instanceGroups.get(0) || [];
                assertEqual(preGroups.length, 1, 'precondition: one group registered');
                assertTrue(preGroups.indexOf(group) >= 0,
                    'precondition: group is registered');

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam2';

                env.mgr._deleteSelected(false);

                // Post-delete: the group object is no longer in the
                // session's instanceGroups map (Session.unlinkGroup may
                // have deleted the frame entry entirely if it became
                // empty — handle both shapes by defaulting to []).
                var postGroups = env.session.instanceGroups.get(0) || [];
                assertTrue(postGroups.indexOf(group) < 0,
                    'group entry removed from session.instanceGroups[0]');
            } finally {
                env.cleanup();
            }
        });

        it('mirrored purge after auto-ungroup clears triangulation data without throwing', function () {
            // This test mirrors the host's onInstanceDeleted →
            // purgeTriangulationDataForGroup behavior. The host calls
            // purge whenever the group is no longer registered on the
            // frame; we assert the same condition holds and that the
            // helper runs cleanly.
            var env = buildGroupedEnv({
                cameras: ['cam1', 'cam2'],
                types: ['user', 'predicted'],
            });
            try {
                var group = env.group;

                // Pre-populate triangulation data so purge has work to do.
                group.points3d       = [[0, 0, 0], [1, 1, 1]];
                group.observedPoints = {
                    cam1: env.instances.cam1.points,
                    cam2: env.instances.cam2.points,
                };
                group.reprojections  = {
                    cam1: [[1, 1], [2, 2]],
                    cam2: [[3, 3], [4, 4]],
                };

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam2'; // user survives, no promotion

                env.mgr._deleteSelected(false);

                // Group is no longer registered → host would purge.
                var registered = env.session.instanceGroups.get(0) || [];
                assertTrue(registered.indexOf(group) < 0,
                    'group not in instanceGroups → host triggers purge');

                // Mirror the purge and assert it clears cleanly.
                var threw = false;
                try { purgeTriangulationDataForGroup(0, group); } catch (e) { threw = true; }
                assertFalse(threw, 'purge does not throw on demoted group');

                assertNull(group.points3d, 'points3d cleared');
                assertNull(group.observedPoints, 'observedPoints cleared');
                assertNull(group.reprojections, 'reprojections cleared');
            } finally {
                env.cleanup();
            }
        });

        it('after auto-ungroup, interactionManager.selectedInstanceGroup is cleared', function () {
            // _deleteSelected calls clearSelection() before mutating
            // data, so by the time the size-1 branch fires, selection
            // is already null. Verify post-delete invariant.
            var env = buildGroupedEnv({
                cameras: ['cam1', 'cam2'],
                types: ['user', 'user'],
            });
            try {
                env.mgr.select(env.group, -1);
                env.mgr.lastInteractedView = 'cam2';

                assertTrue(env.mgr.selectedInstanceGroup === env.group,
                    'precondition: group is selected');

                env.mgr._deleteSelected(false);

                assertNull(env.mgr.selectedInstanceGroup,
                    'selectedInstanceGroup cleared after auto-ungroup');
            } finally {
                env.cleanup();
            }
        });
    });

    // ============================================================
    // Suite 4 — Shift+Del still removes the whole group
    // ============================================================

    describe('Shift+Del — full-group removal path is unchanged', function () {

        it('Shift+Del on multi-member group: all members gone; group removed; deletedViews has all camera names', function () {
            var env = buildGroupedEnv({
                cameras: ['cam1', 'cam2', 'cam3'],
                types: ['user', 'predicted', 'user'],
                trackIdx: 6,
            });
            try {
                var group = env.group;

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam2';

                env.mgr._deleteSelected(true); // Shift+Del → full removal

                // Group fully gone — NOT auto-ungrouped, removed.
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 0, 'group fully removed');

                // Notification reports all 3 view names.
                var lastNotif = env.deletedNotifs[env.deletedNotifs.length - 1];
                assertNotNull(lastNotif, 'onInstanceDeleted callback fired');
                assertEqual(lastNotif.deletedViews.length, 3,
                    'all 3 views reported deleted');
                assertTrue(lastNotif.deletedViews.indexOf('cam1') >= 0, 'cam1 reported');
                assertTrue(lastNotif.deletedViews.indexOf('cam2') >= 0, 'cam2 reported');
                assertTrue(lastNotif.deletedViews.indexOf('cam3') >= 0, 'cam3 reported');

                // None of the destroyed instances ended up in the
                // unlinked pool (Shift+Del is destructive across the
                // whole group, just like the existing behavior).
                assertNull(findUnlinkedFor(env.fg, 'cam1', env.instances.cam1),
                    'cam1 instance not in unlinked pool');
                assertNull(findUnlinkedFor(env.fg, 'cam2', env.instances.cam2),
                    'cam2 instance not in unlinked pool');
                assertNull(findUnlinkedFor(env.fg, 'cam3', env.instances.cam3),
                    'cam3 instance not in unlinked pool');
            } finally {
                env.cleanup();
            }
        });

        it('Shift+Del on 2-member group: group removed (not auto-ungrouped)', function () {
            // Sanity check: even when the group has exactly 2 members,
            // Shift+Del takes the deleteAll branch and removes the
            // whole group rather than auto-ungrouping the survivor.
            var env = buildGroupedEnv({
                cameras: ['cam1', 'cam2'],
                types: ['predicted', 'user'],
                trackIdx: 0,
            });
            try {
                var group = env.group;
                var cam1Inst = env.instances.cam1;

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam2';

                env.mgr._deleteSelected(true);

                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 0, 'group removed');

                // No auto-ungroup → no promotion → cam1 NOT in unlinked
                // pool (Shift+Del is fully destructive).
                assertNull(findUnlinkedFor(env.fg, 'cam1', cam1Inst),
                    'cam1 NOT auto-ungrouped (Shift+Del is destructive)');
                // And critically: cam1Inst.type was NOT promoted to user
                // (because unlinkGroup was never called).
                assertEqual(cam1Inst.type, 'predicted',
                    'cam1 type unchanged (no promotion path on Shift+Del)');
            } finally {
                env.cleanup();
            }
        });
    });

    // ============================================================
    // Suite 5 — full-empty path still works (size===0 case)
    //
    // The size-1 branch fires only when starting from a 2-member
    // group. A 1-member group entering _deleteSelected with per-view
    // delete drops to size 0 and takes the existing
    // removeInstanceGroup path. Verify we did NOT regress that path.
    // ============================================================

    describe('Per-view delete — size-0 path still calls removeInstanceGroup', function () {

        it('1-member group + per-view delete -> group fully removed via removeInstanceGroup', function () {
            // Construct a 2-member env, then manually trim it to 1
            // member up-front so the group is in the (invariant-
            // violating but possible) size-1 state when delete fires.
            var env = buildGroupedEnv({
                cameras: ['cam1', 'cam2'],
                types: ['user', 'user'],
            });
            try {
                var group = env.group;
                // Manually reduce group to a single member without
                // going through unlinkGroup (we want the size==0
                // branch in _deleteSelected to trigger).
                group.instances.delete('cam2');
                env.fg.instances.delete('cam2');
                assertEqual(group.instances.size, 1,
                    'precondition: lone-member group');

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam1'; // delete the only member

                env.mgr._deleteSelected(false);

                // Group fully removed via the size===0 branch
                // (removeInstanceGroup), NOT via unlinkGroup.
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 0, 'group fully removed');

                // cam1 instance was destroyed, NOT pushed to unlinked
                // pool. (Per-view delete on the last member is
                // destructive — only the size===1 auto-ungroup path
                // demotes survivors, and that path only fires when
                // STARTING from size>=2.)
                assertNull(findUnlinkedFor(env.fg, 'cam1', env.instances.cam1),
                    'cam1 instance destroyed (not unlinked) — size===0 path');
            } finally {
                env.cleanup();
            }
        });

        it('2-member group + per-view delete twice still ends with group fully gone', function () {
            // First delete drops 2 → 1 (auto-ungroup, cam1 lands in
            // unlinked pool). The group is gone after the FIRST delete,
            // so a second per-view delete on the same (now-stale)
            // selection would have no group to act on. Re-selecting
            // the (now demoted) survivor as an unlinked instance and
            // deleting that takes the unlinked-delete path, which is
            // outside the scope of this issue. We just verify that
            // a single per-view delete on a 2-member group leaves
            // session.instanceGroups[0] empty.
            var env = buildGroupedEnv({
                cameras: ['cam1', 'cam2'],
                types: ['user', 'user'],
            });
            try {
                env.mgr.select(env.group, -1);
                env.mgr.lastInteractedView = 'cam2';

                env.mgr._deleteSelected(false);

                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 0,
                    '2-member → 1 → auto-ungrouped → no groups left');

                // The survivor IS in the unlinked pool (this is the
                // auto-ungroup signature, vs. the size===0 branch which
                // is destructive). This distinguishes the two paths.
                var ul1 = findUnlinkedFor(env.fg, 'cam1', env.instances.cam1);
                assertNotNull(ul1,
                    'survivor in unlinked pool — proves we took the unlinkGroup path');
            } finally {
                env.cleanup();
            }
        });
    });

})();
