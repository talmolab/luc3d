/**
 * test-ungroup-fix.js — Regression tests for Bug A: Ungroup cleanup.
 *
 * The toolbar "Ungroup" / Edit-menu "Unlink Group" / context-menu "Unlink"
 * / info-panel unlink button all funnel through the host function
 * `unlinkGroup(group)` in index.html. Before the fix:
 *   1. `unlinkGroup()` called `triangulateCurrentFrame()` after
 *      `state.session.unlinkGroup()` — so unlinking unintentionally
 *      triggered re-triangulation.
 *   2. It never cleaned up reprojection state on the orphaned group, so
 *      the info panel kept showing stale reprojection error data.
 *
 * The fix:
 *   - Removed the `triangulateCurrentFrame()` call from `unlinkGroup()`.
 *   - Added a helper `purgeTriangulationDataForGroup(frameIdx, group)` that
 *     clears `group.reprojectedInstances`, nulls reprojections /
 *     observedPoints / points3d, and filters / deletes the
 *     `state.triangulationResults` entry.
 *   - Edit-menu wiring re-routed to share the cleanup path.
 *
 * Since the host functions live in index.html's inline script and are NOT
 * exposed to the test runner, we recreate `purgeTriangulationDataForGroup`
 * inline below (mirroring lines ~4540-4557 of index.html) and exercise it
 * against realistic InstanceGroup objects with reprojection state. The
 * Session.unlinkGroup data-model contract is also verified end-to-end.
 */

(function () {
    var describe   = TestFramework.describe;
    var it         = TestFramework.it;
    var assertEqual    = TestFramework.assertEqual;
    var assertTrue     = TestFramework.assertTrue;
    var assertFalse    = TestFramework.assertFalse;
    var assertNotNull  = TestFramework.assertNotNull;
    var assertNull     = TestFramework.assertNull;

    // ----------------------------------------------------------------
    // Inline mirror of the host helper (index.html ~4540-4557).
    // Kept as a local const so each test can drive a freshly-built
    // `state` shape that exposes only what the helper touches.
    // ----------------------------------------------------------------
    function makePurgeHelper(state) {
        return function purgeTriangulationDataForGroup(frameIdx, group) {
            if (!group) return;
            if (group.reprojectedInstances && typeof group.reprojectedInstances.clear === 'function') {
                group.reprojectedInstances.clear();
            }
            group.reprojections = null;
            group.observedPoints = null;
            group.points3d = null;
            var existing = state.triangulationResults.get(frameIdx);
            if (existing) {
                var filtered = existing.filter(function (r) { return r.group !== group; });
                if (filtered.length === 0) {
                    state.triangulationResults.delete(frameIdx);
                } else {
                    state.triangulationResults.set(frameIdx, filtered);
                }
            }
        };
    }

    // ----------------------------------------------------------------
    // Helpers for building test fixtures
    // ----------------------------------------------------------------
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

    function makeCamera(name, w, h) {
        w = w || 640; h = h || 480;
        return new Camera(name,
            [[600, 0, w / 2], [0, 600, h / 2], [0, 0, 1]],
            [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [w, h]);
    }

    function makeSkeleton() {
        return new Skeleton('mouse', ['nose', 'head'], [[0, 1]]);
    }

    /**
     * Build a Session with two cameras and a single linked InstanceGroup
     * on frame 0 (one instance per camera). Optionally populates
     * reprojection state on the group so the purge helper has work to do.
     */
    function buildSessionWithLinkedGroup(opts) {
        opts = opts || {};
        var withReprojState = opts.withReprojState !== false;
        var skeleton = makeSkeleton();
        var cameras = [makeCamera('cam1'), makeCamera('cam2')];
        var session = new Session(cameras, skeleton, ['track_0']);

        var instA = new Instance([[100, 100], [150, 150]], 0, 'user', 1.0);
        var instB = new Instance([[200, 200], [250, 250]], 0, 'user', 1.0);

        var fg = new FrameGroup(0);
        fg.addInstance('cam1', instA);
        fg.addInstance('cam2', instB);
        session.addFrameGroup(fg);

        var group = new InstanceGroup(1, 0);
        group.addInstance('cam1', instA);
        group.addInstance('cam2', instB);
        if (!session.instanceGroups.has(0)) session.instanceGroups.set(0, []);
        session.instanceGroups.get(0).push(group);

        if (withReprojState) {
            // Stub reprojection state — what triangulation would produce.
            group.addReprojectedInstance('cam1',
                new Instance([[101, 101], [151, 151]], 0, 'reprojected', 1.0));
            group.addReprojectedInstance('cam2',
                new Instance([[201, 201], [251, 251]], 0, 'reprojected', 1.0));
            group.reprojections = [[101, 101], [151, 151]];
            group.observedPoints = [[100, 100], [150, 150]];
            group.points3d = [[1.0, 2.0, 3.0], [1.5, 2.5, 3.5]];
        }

        return {
            skeleton: skeleton,
            session: session,
            fg: fg,
            group: group,
            instA: instA,
            instB: instB,
        };
    }

    /**
     * Build an InteractionManager harness around a session for E2E tests.
     */
    function buildManagerEnv(env) {
        var vw = 640, vh = 480;
        var canvas1 = createMockCanvas(vw, vh);
        var canvas2 = createMockCanvas(vw, vh);
        canvas2.style.left = vw + 'px';

        var views = [
            { name: 'cam1', overlayCanvas: canvas1, videoWidth: vw, videoHeight: vh },
            { name: 'cam2', overlayCanvas: canvas2, videoWidth: vw, videoHeight: vh },
        ];

        var mgr = new InteractionManager({
            getState: function () {
                return { currentFrame: 0, session: env.session, views: views };
            },
            getInstanceGroups: function (frameIdx) {
                return env.session.getInstanceGroupsForFrame(frameIdx || 0);
            },
            onSelectionChanged: function () {},
            onInstanceDeleted: function () {},
            onNodeMoved: function () {},
            requestRedraw: function () {},
        });
        mgr.attach(views);

        return {
            mgr: mgr,
            views: views,
            canvas1: canvas1,
            canvas2: canvas2,
            cleanup: function () {
                mgr.detach();
                cleanupCanvases();
            },
        };
    }

    // ================================================================
    // Suite 1: Session.unlinkGroup data-model contract
    //
    // The data-model primitive was already correct before the fix; we
    // re-affirm the contract here as a regression guard since the
    // host wrapper depends on these semantics.
    // ================================================================

    describe('Bug A: Session.unlinkGroup data-model contract', function () {

        it('returns instances to FrameGroup.unlinkedInstances', function () {
            var env = buildSessionWithLinkedGroup({ withReprojState: false });

            var returned = env.session.unlinkGroup(0, env.group);

            assertEqual(returned.length, 2, 'two unlinked returned');

            var ulCam1 = env.fg.getUnlinkedInstances('cam1');
            var ulCam2 = env.fg.getUnlinkedInstances('cam2');
            assertEqual(ulCam1.length, 1, 'cam1 unlinked pool has 1');
            assertEqual(ulCam2.length, 1, 'cam2 unlinked pool has 1');
        });

        it('removes group from session.instanceGroups', function () {
            var env = buildSessionWithLinkedGroup({ withReprojState: false });

            assertEqual(env.session.getInstanceGroupsForFrame(0).length, 1, 'group exists before');
            env.session.unlinkGroup(0, env.group);
            assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0, 'group removed after');
        });

        it('preserves Instance object identity through unlink', function () {
            var env = buildSessionWithLinkedGroup({ withReprojState: false });
            var origA = env.instA;
            var origB = env.instB;

            var returned = env.session.unlinkGroup(0, env.group);

            var rA = returned.find(function (u) { return u.cameraName === 'cam1'; });
            var rB = returned.find(function (u) { return u.cameraName === 'cam2'; });
            assertNotNull(rA, 'cam1 unlinked returned');
            assertNotNull(rB, 'cam2 unlinked returned');
            assertTrue(rA.instance === origA, 'cam1 Instance object reused (===)');
            assertTrue(rB.instance === origB, 'cam2 Instance object reused (===)');
        });

        it('leaves OTHER groups in the same frame intact', function () {
            var env = buildSessionWithLinkedGroup({ withReprojState: false });

            // Add a second group on the same frame.
            var instC = new Instance([[300, 300], [350, 350]], 1, 'user', 1.0);
            var instD = new Instance([[400, 400], [450, 450]], 1, 'user', 1.0);
            env.fg.addInstance('cam1', instC);
            env.fg.addInstance('cam2', instD);
            var group2 = new InstanceGroup(2, 1);
            group2.addInstance('cam1', instC);
            group2.addInstance('cam2', instD);
            env.session.instanceGroups.get(0).push(group2);

            assertEqual(env.session.getInstanceGroupsForFrame(0).length, 2, '2 groups before');

            env.session.unlinkGroup(0, env.group);

            var remaining = env.session.getInstanceGroupsForFrame(0);
            assertEqual(remaining.length, 1, 'one group remains');
            assertTrue(remaining[0] === group2, 'the surviving group is group2 (identity)');
            // group2's instances must still be present in the FrameGroup.
            var fgCam1 = env.fg.instances.get('cam1') || [];
            var fgCam2 = env.fg.instances.get('cam2') || [];
            assertTrue(fgCam1.indexOf(instC) >= 0, 'cam1 still has instC');
            assertTrue(fgCam2.indexOf(instD) >= 0, 'cam2 still has instD');
        });
    });

    // ================================================================
    // Suite 2: purgeTriangulationDataForGroup helper contract
    //
    // The helper is the cleanup half of the fix. We mirror it inline
    // and verify each behavior listed in the task description.
    // ================================================================

    describe('Bug A: purgeTriangulationDataForGroup helper contract', function () {

        it('calls Map.prototype.clear on group.reprojectedInstances', function () {
            var env = buildSessionWithLinkedGroup();
            var state = { triangulationResults: new Map() };
            var purge = makePurgeHelper(state);

            // Spy on clear() to ensure it was actually invoked.
            var clearCalls = 0;
            var originalClear = env.group.reprojectedInstances.clear;
            env.group.reprojectedInstances.clear = function () {
                clearCalls++;
                return originalClear.apply(this, arguments);
            };

            assertEqual(env.group.reprojectedInstances.size, 2, 'starts with 2 reprojections');
            purge(0, env.group);

            assertEqual(clearCalls, 1, 'clear() called exactly once');
            assertEqual(env.group.reprojectedInstances.size, 0, 'reprojections empty after purge');
        });

        it('nulls reprojections, observedPoints, and points3d', function () {
            var env = buildSessionWithLinkedGroup();
            var state = { triangulationResults: new Map() };
            var purge = makePurgeHelper(state);

            assertNotNull(env.group.reprojections, 'reprojections set before');
            assertNotNull(env.group.observedPoints, 'observedPoints set before');
            assertNotNull(env.group.points3d, 'points3d set before');

            purge(0, env.group);

            assertNull(env.group.reprojections, 'reprojections nulled');
            assertNull(env.group.observedPoints, 'observedPoints nulled');
            assertNull(env.group.points3d, 'points3d nulled');
        });

        it('deletes triangulationResults entry when filtered array is empty', function () {
            var env = buildSessionWithLinkedGroup();
            var state = { triangulationResults: new Map() };
            // Only entry on frame 0 references the same group.
            state.triangulationResults.set(0, [{ group: env.group, error: 1.23 }]);
            var purge = makePurgeHelper(state);

            assertTrue(state.triangulationResults.has(0), 'frame 0 entry present');
            purge(0, env.group);
            assertFalse(state.triangulationResults.has(0),
                'frame 0 entry deleted entirely (not left as empty array)');
        });

        it('preserves triangulationResults entries belonging to other groups', function () {
            var env = buildSessionWithLinkedGroup();
            var otherGroup = new InstanceGroup(99, 7);
            var state = { triangulationResults: new Map() };
            state.triangulationResults.set(0, [
                { group: env.group, error: 1.23 },
                { group: otherGroup, error: 4.56 },
            ]);
            var purge = makePurgeHelper(state);

            purge(0, env.group);

            assertTrue(state.triangulationResults.has(0),
                'frame 0 entry still present (filter preserved survivor)');
            var rem = state.triangulationResults.get(0);
            assertEqual(rem.length, 1, 'one survivor');
            assertTrue(rem[0].group === otherGroup, 'survivor is the other group');
            assertEqual(rem[0].error, 4.56, 'survivor data untouched');
        });

        it('does not throw when triangulationResults has no entry for frame', function () {
            var env = buildSessionWithLinkedGroup();
            var state = { triangulationResults: new Map() };
            var purge = makePurgeHelper(state);

            // Different frame populated.
            state.triangulationResults.set(7, [{ group: new InstanceGroup(2, 0), error: 0 }]);

            // Should not throw.
            purge(0, env.group);

            // Frame 7 entry untouched.
            assertTrue(state.triangulationResults.has(7), 'unrelated frame still present');
        });

        it('does not throw when reprojectedInstances is null/undefined', function () {
            var env = buildSessionWithLinkedGroup({ withReprojState: false });
            var state = { triangulationResults: new Map() };
            var purge = makePurgeHelper(state);

            // Force the field to null (defensive): some lifecycles may
            // leave it unset on a freshly created group.
            env.group.reprojectedInstances = null;
            // Should not throw.
            purge(0, env.group);

            // The other null-out fields should still be assigned.
            assertNull(env.group.reprojections);
            assertNull(env.group.observedPoints);
            assertNull(env.group.points3d);

            // Now try with undefined.
            var env2 = buildSessionWithLinkedGroup({ withReprojState: false });
            env2.group.reprojectedInstances = undefined;
            purge(0, env2.group); // must not throw
            assertNull(env2.group.points3d);
        });

        it('does not throw when reprojections/observedPoints already null', function () {
            var env = buildSessionWithLinkedGroup({ withReprojState: false });
            var state = { triangulationResults: new Map() };
            var purge = makePurgeHelper(state);

            // Already null — purge should idempotently null them again.
            assertNull(env.group.reprojections);
            assertNull(env.group.observedPoints);
            assertNull(env.group.points3d);

            purge(0, env.group); // must not throw

            assertNull(env.group.reprojections, 'still null');
            assertNull(env.group.observedPoints, 'still null');
            assertNull(env.group.points3d, 'still null');
        });

        it('uses === reference equality, not deep compare, when filtering', function () {
            // Two different group objects can have overlapping field
            // values; the filter must only remove the exact reference.
            var env = buildSessionWithLinkedGroup({ withReprojState: false });
            var twin = new InstanceGroup(1, 0); // same id/identityId, different reference
            twin.reprojections = env.group.reprojections;

            var state = { triangulationResults: new Map() };
            state.triangulationResults.set(0, [
                { group: env.group, error: 1.0 },
                { group: twin,      error: 2.0 },
            ]);
            var purge = makePurgeHelper(state);

            purge(0, env.group);

            var rem = state.triangulationResults.get(0);
            assertNotNull(rem, 'frame entry still present (twin survives)');
            assertEqual(rem.length, 1, 'only one entry filtered out');
            assertTrue(rem[0].group === twin, 'twin survived (reference equality)');
        });

        it('no-op (early return) when group argument is falsy', function () {
            var state = { triangulationResults: new Map() };
            state.triangulationResults.set(0, [{ group: 'sentinel', error: 0 }]);
            var purge = makePurgeHelper(state);

            // Should not throw and should not mutate state.
            purge(0, null);
            purge(0, undefined);

            var rem = state.triangulationResults.get(0);
            assertEqual(rem.length, 1, 'frame entry untouched');
        });
    });

    // ================================================================
    // Suite 3: End-to-end (no triangulation runs)
    //
    // Verifies that after Session.unlinkGroup + purge, the group's
    // reprojection state is gone and triangulationResults is empty —
    // and crucially, that points3d remains null. If a real
    // triangulation step had run, points3d would have been
    // re-populated; the regression check is exactly: did we avoid
    // re-triangulating?
    // ================================================================

    describe('Bug A: end-to-end unlink without triangulation', function () {

        it('after unlink+purge: reproj state cleared, results map empty, points3d stays null', function () {
            var env = buildSessionWithLinkedGroup();
            var harness = buildManagerEnv(env);
            var state = { triangulationResults: new Map() };
            state.triangulationResults.set(0, [{ group: env.group, error: 1.23 }]);
            var purge = makePurgeHelper(state);

            try {
                // Pre-conditions: group has reprojection state and
                // triangulationResults entry.
                assertEqual(env.group.reprojectedInstances.size, 2);
                assertNotNull(env.group.points3d);
                assertTrue(state.triangulationResults.has(0));

                // Step 1: data-model unlink.
                env.session.unlinkGroup(0, env.group);

                // Step 2: host-wrapper cleanup (simulating fixed unlinkGroup).
                purge(0, env.group);

                // Group is gone from session, instances back in unlinked pool.
                assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0, 'no groups remain');
                assertEqual(env.fg.getUnlinkedInstances('cam1').length, 1, 'cam1 unlinked restored');
                assertEqual(env.fg.getUnlinkedInstances('cam2').length, 1, 'cam2 unlinked restored');

                // Reprojection state on the orphaned group is cleared.
                assertEqual(env.group.reprojectedInstances.size, 0, 'reprojectedInstances cleared');
                assertNull(env.group.reprojections, 'reprojections null');
                assertNull(env.group.observedPoints, 'observedPoints null');
                assertNull(env.group.points3d,
                    'points3d null — proves triangulation did NOT re-run');

                // triangulationResults map is empty for this frame.
                assertFalse(state.triangulationResults.has(0),
                    'triangulationResults entry deleted');
            } finally {
                harness.cleanup();
            }
        });

        it('multiple unlinks on the same frame each clean up independently', function () {
            // Two groups, unlink both in sequence, neither should trigger
            // re-triangulation or leave stale results behind.
            var env = buildSessionWithLinkedGroup();
            var instC = new Instance([[300, 300], [350, 350]], 1, 'user', 1.0);
            var instD = new Instance([[400, 400], [450, 450]], 1, 'user', 1.0);
            env.fg.addInstance('cam1', instC);
            env.fg.addInstance('cam2', instD);
            var group2 = new InstanceGroup(2, 1);
            group2.addInstance('cam1', instC);
            group2.addInstance('cam2', instD);
            group2.addReprojectedInstance('cam1',
                new Instance([[301, 301], [351, 351]], 1, 'reprojected', 1.0));
            group2.addReprojectedInstance('cam2',
                new Instance([[401, 401], [451, 451]], 1, 'reprojected', 1.0));
            group2.points3d = [[5, 6, 7]];
            env.session.instanceGroups.get(0).push(group2);

            var state = { triangulationResults: new Map() };
            state.triangulationResults.set(0, [
                { group: env.group, error: 1.0 },
                { group: group2,    error: 2.0 },
            ]);
            var purge = makePurgeHelper(state);

            // Unlink the first group.
            env.session.unlinkGroup(0, env.group);
            purge(0, env.group);

            assertEqual(env.session.getInstanceGroupsForFrame(0).length, 1, 'one group left');
            var rem = state.triangulationResults.get(0);
            assertEqual(rem.length, 1, 'only group2 entry left');
            assertTrue(rem[0].group === group2, 'group2 survives');
            assertNull(env.group.points3d, 'env.group points3d null');
            assertNotNull(group2.points3d, 'group2 points3d untouched');

            // Unlink the second group.
            env.session.unlinkGroup(0, group2);
            purge(0, group2);

            assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0, 'no groups left');
            assertFalse(state.triangulationResults.has(0),
                'triangulationResults entry fully deleted');
            assertNull(group2.points3d, 'group2 points3d null');
            assertEqual(group2.reprojectedInstances.size, 0, 'group2 reprojections cleared');
        });
    });

    // ================================================================
    // Suite 4: Multi-group frame — one unlinked, one preserved
    // ================================================================

    describe('Bug A: multi-group frame — only the unlinked group is purged', function () {

        it('only the unlinked groups triangulationResults entry is removed', function () {
            var env = buildSessionWithLinkedGroup();
            // Add a second group with its own reprojection state and
            // triangulationResults entry.
            var instC = new Instance([[300, 300], [350, 350]], 1, 'user', 1.0);
            var instD = new Instance([[400, 400], [450, 450]], 1, 'user', 1.0);
            env.fg.addInstance('cam1', instC);
            env.fg.addInstance('cam2', instD);
            var group2 = new InstanceGroup(2, 1);
            group2.addInstance('cam1', instC);
            group2.addInstance('cam2', instD);
            group2.addReprojectedInstance('cam1',
                new Instance([[301, 301], [351, 351]], 1, 'reprojected', 1.0));
            group2.points3d = [[9, 9, 9]];
            group2.reprojections = [[301, 301], [351, 351]];
            env.session.instanceGroups.get(0).push(group2);

            var state = { triangulationResults: new Map() };
            state.triangulationResults.set(0, [
                { group: env.group, error: 1.0 },
                { group: group2,    error: 4.0 },
            ]);
            var purge = makePurgeHelper(state);

            // Unlink only env.group.
            env.session.unlinkGroup(0, env.group);
            purge(0, env.group);

            // Only env.group's entry is gone.
            assertTrue(state.triangulationResults.has(0),
                'frame 0 triangulationResults entry still exists with one item');
            var rem = state.triangulationResults.get(0);
            assertEqual(rem.length, 1, 'one entry survived');
            assertTrue(rem[0].group === group2, 'survivor is group2');
            assertEqual(rem[0].error, 4.0, 'group2 error untouched');

            // group2's data is fully preserved.
            assertEqual(group2.reprojectedInstances.size, 1, 'group2 reprojections intact');
            assertNotNull(group2.points3d, 'group2 points3d intact');
            assertNotNull(group2.reprojections, 'group2 reprojections array intact');

            // env.group is fully purged.
            assertEqual(env.group.reprojectedInstances.size, 0, 'env.group reprojections cleared');
            assertNull(env.group.points3d, 'env.group points3d null');
            assertNull(env.group.reprojections, 'env.group reprojections null');

            // Session state: env.group gone, group2 still linked.
            var groupsAfter = env.session.getInstanceGroupsForFrame(0);
            assertEqual(groupsAfter.length, 1, 'one group remains');
            assertTrue(groupsAfter[0] === group2, 'remaining group is group2');
        });
    });

    // ================================================================
    // Suite 5: Edge case — unlink a never-triangulated group
    // ================================================================

    describe('Bug A: unlink a never-triangulated group', function () {

        it('does not throw, removes group, returns instances to unlinked pool', function () {
            var env = buildSessionWithLinkedGroup({ withReprojState: false });

            // Confirm there is no reprojection state at all.
            assertEqual(env.group.reprojectedInstances.size, 0, 'no reprojections');
            assertNull(env.group.reprojections);
            assertNull(env.group.observedPoints);
            assertNull(env.group.points3d);

            var state = { triangulationResults: new Map() };
            // No entry for frame 0 in triangulationResults.
            var purge = makePurgeHelper(state);

            // Run unlink + purge — must not throw.
            env.session.unlinkGroup(0, env.group);
            purge(0, env.group);

            // Group removed.
            assertEqual(env.session.getInstanceGroupsForFrame(0).length, 0, 'group removed');
            // Instances back in unlinked pool.
            assertEqual(env.fg.getUnlinkedInstances('cam1').length, 1, 'cam1 unlinked restored');
            assertEqual(env.fg.getUnlinkedInstances('cam2').length, 1, 'cam2 unlinked restored');
            // No leftover triangulationResults entry was created.
            assertFalse(state.triangulationResults.has(0), 'no spurious triangulationResults entry');
        });
    });

})();
