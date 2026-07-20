/**
 * test-edit-group-fixes.js — Regression tests for edit-group / per-view-delete
 * bugs related to single-instance group conversion and the synchronization of
 * `group.observedPoints` with the current `group.instances` membership.
 *
 * Bugs covered:
 *  - B1: finishEditGroup leaves a 1-member InstanceGroup intact (groups must
 *        contain >= 2 instances by definition). Fix demotes the lone member
 *        back to an UnlinkedInstance and destroys the group.
 *  - B2: onEditGroupAdd / onEditGroupRemove never updated
 *        `group.observedPoints`, so removed instances kept drawing a stale
 *        reprojection-error connector line and newly added instances drew
 *        none. Fix syncs observedPoints alongside the instances Map.
 *  - E:  Per-view delete (Del key, single-view) in interaction.js
 *        `_deleteSelected` left `observedPoints[viewName]` stale, leaving the
 *        connector line drawn on the deleted view. Fix mirrors B2 for delete.
 *
 * B1 and B2 fixes live inside the index.html inline app script (not exposed
 * to module-level test harnesses). For those, the test file recreates the
 * tiny fix snippets as helpers and exercises them directly against realistic
 * InstanceGroup state. Bug E is exercised end-to-end through the real
 * InteractionManager from interaction.js.
 */

(function () {
    var describe   = TestFramework.describe;
    var it         = TestFramework.it;
    var assert            = TestFramework.assert;
    var assertEqual       = TestFramework.assertEqual;
    var assertTrue        = TestFramework.assertTrue;
    var assertFalse       = TestFramework.assertFalse;
    var assertNotNull     = TestFramework.assertNotNull;
    var assertNull        = TestFramework.assertNull;
    var assertDeepEqual   = TestFramework.assertDeepEqual;

    // ============================================================
    // Test environment helpers (shared across suites)
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
     * one Instance per camera, all linked into the FrameGroup.
     * Returns helpers + handles for the test environment.
     */
    function buildGroupedEnv(opts) {
        opts = opts || {};
        var camNames = opts.cameras || ['cam1', 'cam2'];
        var vw = opts.videoWidth || 640;
        var vh = opts.videoHeight || 480;
        var trackIdx = opts.trackIdx || 3; // distinctive default to verify preservation

        var skeleton = makeSkeleton();
        var cameras = camNames.map(function (n) { return makeCamera(n, vw, vh); });
        var session = new Session(cameras, skeleton, ['track_0', 'track_1', 'track_2', 'track_3', 'track_4']);

        var fg = new FrameGroup(0);

        // Distinct point patterns per camera for sanity (and for hit testing)
        var instances = {};
        camNames.forEach(function (camName, idx) {
            var base = 100 + idx * 100;
            var inst = new Instance([[base, base], [base + 50, base + 50]], trackIdx, 'user', 1.0);
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

    // ============================================================
    // Suite 1 — Single-instance group auto-conversion (B1)
    //
    // The fix in finishEditGroup adds an `else if (group.instances.size === 1)`
    // branch that demotes the lone remaining instance back to an
    // UnlinkedInstance and destroys the group. We mirror that branch here as
    // a helper and verify it against realistic state.
    // ============================================================

    /**
     * Mirrors finishEditGroup's size-based dispatch from index.html (~5853).
     * Pure data ops, no DOM/markDirty. Returns one of:
     *   'removed'    — empty group removed entirely
     *   'unlinked'   — single-member group demoted (B1 path)
     *   'kept'       — multi-member group survives intact
     */
    function finishEditGroupBranch(session, frameIdx, group, purgeFn) {
        if (group.instances.size === 0) {
            session.removeInstanceGroup(frameIdx, group);
            if (purgeFn) purgeFn(frameIdx, group);
            return 'removed';
        } else if (group.instances.size === 1) {
            session.unlinkGroup(frameIdx, group);
            if (purgeFn) purgeFn(frameIdx, group);
            return 'unlinked';
        }
        return 'kept';
    }

    /**
     * Mirrors purgeTriangulationDataForGroup from index.html (~4540) sans
     * the global `state.triangulationResults` cleanup (not relevant here).
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

    describe('finishEditGroup B1 — single-instance group auto-conversion', function () {

        it('2-member group reduced to 1 by edit -> demoted to unlinked, group gone', function () {
            var env = buildGroupedEnv({ cameras: ['cam1', 'cam2'], trackIdx: 7 });
            try {
                var group = env.group;
                var loneInst = env.instances.cam1;

                // Simulate the user removing cam2 during edit-group, leaving 1 left.
                group.instances.delete('cam2');
                // FrameGroup gets cam2 removed and cam2's instance returned as
                // unlinked — match what onEditGroupRemove would do, so the
                // fixture mirrors what finishEditGroup actually sees.
                var fg = env.fg;
                var camInsts = fg.instances.get('cam2');
                var idx = camInsts.indexOf(env.instances.cam2);
                if (idx >= 0) camInsts.splice(idx, 1);
                if (camInsts.length === 0) fg.instances.delete('cam2');
                fg.addUnlinkedInstance('cam2', new UnlinkedInstance(env.instances.cam2, 'cam2'));

                assertEqual(group.instances.size, 1, 'precondition: lone-member group');

                var outcome = finishEditGroupBranch(env.session, 0, group, purgeTriangulationDataForGroup);
                assertEqual(outcome, 'unlinked', 'B1 branch fired');

                // Group is gone from session.instanceGroups
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 0, 'group removed from session.instanceGroups');

                // Lone instance is back as an UnlinkedInstance in cam1's pool
                var ul1 = fg.getUnlinkedInstances('cam1') || [];
                assertEqual(ul1.length, 1, 'cam1 has lone instance back as unlinked');
                assertTrue(ul1[0].instance === loneInst, 'same Instance object preserved (identity)');

                // Track index preserved (color stays consistent)
                assertEqual(ul1[0].instance.trackIdx, 7, 'trackIdx preserved on demoted instance');
            } finally {
                env.cleanup();
            }
        });

        it('1-member group entering finishEditGroup directly is converted', function () {
            // E.g. the user already manually removed all but one before opening
            // the edit toast — same B1 path needs to fire.
            var env = buildGroupedEnv({ cameras: ['cam1', 'cam2'], trackIdx: 4 });
            try {
                // Reduce to 1 member up-front (as if no edit occurred).
                env.group.instances.delete('cam2');
                env.fg.instances.delete('cam2');

                assertEqual(env.group.instances.size, 1, 'lone-member group');

                var outcome = finishEditGroupBranch(env.session, 0, env.group, purgeTriangulationDataForGroup);
                assertEqual(outcome, 'unlinked', 'B1 path used');

                assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0,
                    'group destroyed');
                var ul1 = env.fg.getUnlinkedInstances('cam1') || [];
                assertEqual(ul1.length, 1, 'lone instance lives in unlinked pool');
                assertEqual(ul1[0].instance.trackIdx, 4, 'trackIdx preserved');
            } finally {
                env.cleanup();
            }
        });

        it('0-member group still removed (existing behavior); nothing left in unlinked pool', function () {
            var env = buildGroupedEnv({ cameras: ['cam1', 'cam2'] });
            try {
                // Simulate the user removing all members during edit. For the
                // empty-branch contract we model the FrameGroup state finishEditGroup
                // would observe: instances are NOT in fg linked, and they were
                // moved to unlinked by onEditGroupRemove — but finishEditGroup
                // empty branch only calls removeInstanceGroup which operates on
                // the (now-empty) group.instances Map.
                env.group.instances.clear();
                env.fg.instances.delete('cam1');
                env.fg.instances.delete('cam2');
                assertEqual(env.group.instances.size, 0, 'precondition: empty group');

                var outcome = finishEditGroupBranch(env.session, 0, env.group, purgeTriangulationDataForGroup);
                assertEqual(outcome, 'removed', 'empty branch fired');

                assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0, 'group removed');

                // Unlinked pool from this group is empty (we never added the
                // instances back in this scenario; finishEditGroup with size===0
                // does NOT push instances to the unlinked pool — that is the
                // caller's job in onEditGroupRemove, which already happened
                // above).
                var ul1 = env.fg.getUnlinkedInstances('cam1') || [];
                var ul2 = env.fg.getUnlinkedInstances('cam2') || [];
                assertEqual(ul1.length, 0, 'no leftover unlinked from group in cam1');
                assertEqual(ul2.length, 0, 'no leftover unlinked from group in cam2');
            } finally {
                env.cleanup();
            }
        });

        it('2+-member group survives intact (no conversion)', function () {
            var env = buildGroupedEnv({ cameras: ['cam1', 'cam2', 'cam3'] });
            try {
                assertEqual(env.group.instances.size, 3, 'precondition: 3-member group');

                var outcome = finishEditGroupBranch(env.session, 0, env.group, purgeTriangulationDataForGroup);
                assertEqual(outcome, 'kept', 'no branch fired (multi-member)');

                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 1, 'group still present');
                assertTrue(groups[0] === env.group, 'same group object');
                assertEqual(env.group.instances.size, 3, 'all members preserved');
            } finally {
                env.cleanup();
            }
        });

        it('purgeTriangulationDataForGroup does not throw on a destroyed group', function () {
            var env = buildGroupedEnv({ cameras: ['cam1', 'cam2'] });
            try {
                // Pre-populate triangulation-y fields so purge has something to clear.
                env.group.observedPoints = { cam1: env.instances.cam1.points, cam2: env.instances.cam2.points };
                env.group.reprojections = { cam1: [[1, 1]], cam2: [[2, 2]] };
                env.group.points3d = [[0, 0, 0], [1, 1, 1]];

                // Drive B1 conversion.
                env.group.instances.delete('cam2');
                env.fg.instances.delete('cam2');
                env.fg.addUnlinkedInstance('cam2', new UnlinkedInstance(env.instances.cam2, 'cam2'));

                finishEditGroupBranch(env.session, 0, env.group, purgeTriangulationDataForGroup);

                // After the conversion the group is "destroyed" (removed from
                // the session) but is still a JS object in scope. Calling
                // purge again must not throw.
                var threw = false;
                try { purgeTriangulationDataForGroup(0, env.group); } catch (e) { threw = true; }
                assertFalse(threw, 'second purge call must not throw');

                assertNull(env.group.observedPoints, 'observedPoints cleared');
                assertNull(env.group.reprojections, 'reprojections cleared');
                assertNull(env.group.points3d, 'points3d cleared');
            } finally {
                env.cleanup();
            }
        });
    });

    // ============================================================
    // Suite 2 — observedPoints sync during edit (B2)
    //
    // Recreates the fix logic from onEditGroupAdd / onEditGroupRemove
    // (index.html ~3328-3395). Reference equality matters — overlays.js draws
    // from the same array reference live-mutated by drag, so the fix MUST
    // store a reference, not a copy.
    // ============================================================

    /** Mirrors the fix snippet inside onEditGroupRemove (index.html ~3340-3347). */
    function syncObservedOnRemove(group, viewName) {
        // Caller is responsible for `group.instances.delete(viewName)`; this
        // helper isolates the fix line we are testing.
        if (group.observedPoints) {
            delete group.observedPoints[viewName];
        }
    }

    /** Mirrors the fix snippet inside onEditGroupAdd (index.html ~3375-3379). */
    function syncObservedOnAdd(group, viewName, inst) {
        // Caller is responsible for `group.addInstance(viewName, inst)`; this
        // helper isolates the fix line we are testing.
        group.observedPoints = group.observedPoints || {};
        group.observedPoints[viewName] = inst.points;
    }

    describe('onEditGroupAdd / onEditGroupRemove B2 — observedPoints sync', function () {

        it('Add: when no observedPoints yet, initializes object and sets viewName entry by reference', function () {
            var group = new InstanceGroup(1, 0);
            var inst = new Instance([[10, 20], [30, 40]], 0, 'user', 1.0);

            assertTrue(group.observedPoints == null, 'precondition: no observedPoints');

            syncObservedOnAdd(group, 'cam1', inst);

            assertNotNull(group.observedPoints, 'observedPoints object initialized');
            assertEqual(typeof group.observedPoints, 'object', 'is object');
            assertTrue(group.observedPoints.cam1 === inst.points,
                'reference equality: observedPoints[cam1] is the same array as inst.points');
        });

        it('Add: when observedPoints already exists, preserves other-view entries', function () {
            var group = new InstanceGroup(1, 0);
            var existingPts = [[100, 200], [110, 210]];
            group.observedPoints = { cam1: existingPts };
            var inst2 = new Instance([[1, 2], [3, 4]], 0, 'user', 1.0);

            syncObservedOnAdd(group, 'cam2', inst2);

            assertTrue(group.observedPoints.cam1 === existingPts, 'cam1 entry untouched');
            assertTrue(group.observedPoints.cam2 === inst2.points, 'cam2 entry added by reference');
            assertEqual(Object.keys(group.observedPoints).length, 2, 'two entries total');
        });

        it('Remove: deletes only the named view, leaves others intact', function () {
            var group = new InstanceGroup(1, 0);
            var ptsA = [[1, 1]];
            var ptsB = [[2, 2]];
            var ptsC = [[3, 3]];
            group.observedPoints = { camA: ptsA, camB: ptsB, camC: ptsC };

            syncObservedOnRemove(group, 'camB');

            assertEqual(group.observedPoints.camB, undefined, 'camB entry gone');
            assertTrue(group.observedPoints.camA === ptsA, 'camA entry untouched');
            assertTrue(group.observedPoints.camC === ptsC, 'camC entry untouched');
            assertEqual(Object.keys(group.observedPoints).length, 2, 'two entries left');
        });

        it('Remove: when observedPoints is null, the guard prevents a TypeError', function () {
            var group = new InstanceGroup(1, 0);
            group.observedPoints = null;

            var threw = false;
            try {
                syncObservedOnRemove(group, 'camX');
            } catch (e) {
                threw = true;
            }
            assertFalse(threw, 'no exception when observedPoints is null');
            assertNull(group.observedPoints, 'still null');
        });

        it('Remove: when observedPoints is undefined, the guard prevents a TypeError', function () {
            var group = new InstanceGroup(1, 0);
            // Default state: no observedPoints field set explicitly.
            assertTrue(group.observedPoints == null, 'precondition: nullish');

            var threw = false;
            try {
                syncObservedOnRemove(group, 'camX');
            } catch (e) {
                threw = true;
            }
            assertFalse(threw, 'no exception when observedPoints is undefined');
        });

        it('Reference invariant: mutating inst.points is visible through group.observedPoints', function () {
            // overlays.js reads group.observedPoints[viewName] live during
            // draw. If a user drags a node, inst.points[i] is mutated in place
            // and the connector line MUST follow the cursor.
            var group = new InstanceGroup(1, 0);
            var inst = new Instance([[10, 20], [30, 40]], 0, 'user', 1.0);

            syncObservedOnAdd(group, 'cam1', inst);

            // Mutate inst.points after the sync.
            inst.points[0][0] = 999;
            inst.points[0][1] = 888;

            assertEqual(group.observedPoints.cam1[0][0], 999,
                'mutation visible via observedPoints (shared array reference)');
            assertEqual(group.observedPoints.cam1[0][1], 888,
                'mutation visible via observedPoints (shared array reference)');
        });
    });

    // ============================================================
    // Suite 3 — Per-view delete clears observedPoints (Bug E)
    //
    // Driven through the real InteractionManager._deleteSelected. This is the
    // symmetric fix to B2 for the Del key path in interaction.js.
    // ============================================================

    describe('InteractionManager._deleteSelected E — observedPoints sync on per-view delete', function () {

        it('per-view delete removes only the targeted view from observedPoints; reprojections preserved', function () {
            var env = buildGroupedEnv({ cameras: ['cam1', 'cam2', 'cam3'] });
            try {
                var group = env.group;
                // Pre-populate post-triangulation state.
                group.observedPoints = {
                    cam1: env.instances.cam1.points,
                    cam2: env.instances.cam2.points,
                    cam3: env.instances.cam3.points,
                };
                group.reprojections = {
                    cam1: [[1.5, 1.5], [2.5, 2.5]],
                    cam2: [[3.5, 3.5], [4.5, 4.5]],
                    cam3: [[5.5, 5.5], [6.5, 6.5]],
                };

                // Stash references that should remain reachable after delete.
                var observedCam1 = group.observedPoints.cam1;
                var observedCam3 = group.observedPoints.cam3;
                var reprojCam2 = group.reprojections.cam2;

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam2';

                env.mgr._deleteSelected(false); // per-view delete

                assertEqual(group.instances.size, 2, 'cam2 instance removed; 2 left');
                assertTrue(group.instances.has('cam1'), 'cam1 still in group');
                assertTrue(group.instances.has('cam3'), 'cam3 still in group');
                assertFalse(group.instances.has('cam2'), 'cam2 not in group');

                // The fix line:
                assertEqual(group.observedPoints.cam2, undefined,
                    'observedPoints.cam2 deleted (no stale connector line)');

                // Untouched views:
                assertTrue(group.observedPoints.cam1 === observedCam1,
                    'observedPoints.cam1 untouched (reference)');
                assertTrue(group.observedPoints.cam3 === observedCam3,
                    'observedPoints.cam3 untouched (reference)');

                // Reprojections are intentionally preserved (X-mark survives
                // because it represents the still-valid 3D point projected
                // from the other views).
                assertNotNull(group.reprojections.cam2,
                    'reprojections.cam2 preserved (X-mark stays)');
                assertTrue(group.reprojections.cam2 === reprojCam2,
                    'reprojections.cam2 same reference (no reset)');

                // Group still alive in session.
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 1, 'group still in session');
                assertTrue(groups[0] === group, 'same group object');
            } finally {
                env.cleanup();
            }
        });

        it('Shift+Del (deleteAll=true) full-group removal: group gone from session', function () {
            var env = buildGroupedEnv({ cameras: ['cam1', 'cam2', 'cam3'] });
            try {
                var group = env.group;
                group.observedPoints = {
                    cam1: env.instances.cam1.points,
                    cam2: env.instances.cam2.points,
                    cam3: env.instances.cam3.points,
                };
                group.reprojections = { cam1: [[1, 1]], cam2: [[2, 2]], cam3: [[3, 3]] };

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam2';

                env.mgr._deleteSelected(true); // Shift+Del → full group

                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 0, 'group gone from session.instanceGroups');

                // Notification fired with all three view names.
                var lastNotif = env.deletedNotifs[env.deletedNotifs.length - 1];
                assertNotNull(lastNotif, 'onInstanceDeleted callback fired');
                assertEqual(lastNotif.deletedViews.length, 3, 'all 3 views reported deleted');
                assertTrue(lastNotif.deletedViews.indexOf('cam1') >= 0, 'cam1 reported');
                assertTrue(lastNotif.deletedViews.indexOf('cam2') >= 0, 'cam2 reported');
                assertTrue(lastNotif.deletedViews.indexOf('cam3') >= 0, 'cam3 reported');
            } finally {
                env.cleanup();
            }
        });

        it('per-view delete that drops to 0 instances removes the whole group', function () {
            // Edge: start with 2-member group, delete one view, then delete
            // the other — the group reaches size 0 and must be removed via
            // Session.removeInstanceGroup (existing behavior, must not throw).
            var env = buildGroupedEnv({ cameras: ['cam1', 'cam2'] });
            try {
                var group = env.group;
                group.observedPoints = {
                    cam1: env.instances.cam1.points,
                    cam2: env.instances.cam2.points,
                };

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam1';

                env.mgr._deleteSelected(false); // remove cam1
                assertEqual(group.instances.size, 1, '1 left after first per-view delete');
                assertEqual(group.observedPoints.cam1, undefined, 'cam1 observed gone');

                // Re-select (selection was cleared on first delete) and delete cam2.
                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam2';

                var threw = false;
                try {
                    env.mgr._deleteSelected(false);
                } catch (e) {
                    threw = true;
                }
                assertFalse(threw, 'second per-view delete must not throw');

                // Group fully removed from the session.
                var groups = env.session.getInstanceGroupsForFrame(0);
                assertEqual(groups.length, 0, 'group fully removed when emptied');
            } finally {
                env.cleanup();
            }
        });

        it('per-view delete with null observedPoints does not crash', function () {
            // Edge: a group that never went through triangulation has no
            // observedPoints. The guard `if (group.observedPoints)` must
            // protect against TypeError.
            var env = buildGroupedEnv({ cameras: ['cam1', 'cam2'] });
            try {
                var group = env.group;
                // Explicitly null — fresh (un-triangulated) state.
                group.observedPoints = null;

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam1';

                var threw = false;
                try {
                    env.mgr._deleteSelected(false);
                } catch (e) {
                    threw = true;
                }
                assertFalse(threw, 'guard prevents TypeError on null observedPoints');

                assertEqual(group.instances.size, 1, 'cam1 still removed from group');
                assertNull(group.observedPoints, 'still null after delete (no implicit init)');
            } finally {
                env.cleanup();
            }
        });

        it('per-view delete with undefined observedPoints does not crash', function () {
            // Edge: a freshly constructed InstanceGroup has no observedPoints
            // field at all (undefined). Same guard handles this.
            var env = buildGroupedEnv({ cameras: ['cam1', 'cam2'] });
            try {
                var group = env.group;
                // Force undefined (default for a new InstanceGroup).
                delete group.observedPoints;
                assertTrue(group.observedPoints == null, 'precondition: observedPoints is nullish');

                env.mgr.select(group, -1);
                env.mgr.lastInteractedView = 'cam2';

                var threw = false;
                try {
                    env.mgr._deleteSelected(false);
                } catch (e) {
                    threw = true;
                }
                assertFalse(threw, 'guard prevents TypeError on undefined observedPoints');

                assertEqual(group.instances.size, 1, 'cam2 still removed from group');
            } finally {
                env.cleanup();
            }
        });
    });

})();
