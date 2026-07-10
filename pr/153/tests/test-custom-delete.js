/**
 * test-custom-delete.js — unit tests for the Custom Instance Delete ops
 * (ui/custom-delete-ops.js), bridged to window in test-runner.html.
 *
 * Covers collectDeletionTargets (pure filtering across LUCID's 2D datatypes:
 * grouped members, ungrouped UnlinkedInstances, reprojections; filtered by
 * type/grouping/view/track/identity/frame-scope) and executeDeletion (the
 * removeInstanceGroup / unlinkGroup / dirty cascade that mirrors
 * InteractionManager._deleteSelected). Regression guard for issue #72.
 */

(function () {
    var describe = TestFramework.describe;
    var it = TestFramework.it;
    var assertTrue = TestFramework.assertTrue;
    var assertFalse = TestFramework.assertFalse;
    var assertEqual = TestFramework.assertEqual;

    function inst(type, trackIdx) {
        return new Instance([[0, 0], [1, 1]], trackIdx, type, type === 'user' ? undefined : 0.9);
    }

    // Fresh session per call (executeDeletion mutates). Layout:
    //  Frame 0:
    //   Group A (identity idA, track 0): cam1=predicted, cam2=predicted   (fully predicted)
    //   Group B (identity idB, track 1): cam1=user,      cam2=predicted   (mixed)
    //   Unlinked: cam1=predicted track=null ; cam2=user track 3
    //   Group A reprojections: cam1, cam2   (2)
    //  Frame 1:
    //   Group C (identity idA, track 0): cam1=user, cam2=user, cam3=user  (3-member user)
    function buildSession() {
        var cams = [{ name: 'cam1' }, { name: 'cam2' }, { name: 'cam3' }];
        var s = new Session(cams, null, ['t0', 't1', 't2', 't3'], 'S1');
        var idA = s.addIdentity('A');
        var idB = s.addIdentity('B');

        // ---- Frame 0 ----
        var fg0 = new FrameGroup(0);
        var a1 = inst('predicted', 0), a2 = inst('predicted', 0);
        var b1 = inst('user', 1), b2 = inst('predicted', 1);
        var gA = new InstanceGroup(1, idA.id);
        gA.addInstance('cam1', a1); gA.addInstance('cam2', a2);
        gA.addReprojectedInstance('cam1', inst('reprojected', idA.id));
        gA.addReprojectedInstance('cam2', inst('reprojected', idA.id));
        gA.points3d = [[0, 0, 0], [1, 1, 1]];
        var gB = new InstanceGroup(2, idB.id);
        gB.addInstance('cam1', b1); gB.addInstance('cam2', b2);
        fg0.addInstance('cam1', a1); fg0.addInstance('cam2', a2);
        fg0.addInstance('cam1', b1); fg0.addInstance('cam2', b2);
        var u1 = inst('predicted', null), u2 = inst('user', 3);
        fg0.addUnlinkedInstance('cam1', new UnlinkedInstance(u1, 'cam1'));
        fg0.addUnlinkedInstance('cam2', new UnlinkedInstance(u2, 'cam2'));
        s.frameGroups.set(0, fg0);
        s.instanceGroups.set(0, [gA, gB]);
        s.setFrameIdentity(0, 'cam1', 0, idA.id);
        s.setFrameIdentity(0, 'cam2', 0, idA.id);
        s.setFrameIdentity(0, 'cam1', 1, idB.id);
        s.setFrameIdentity(0, 'cam2', 1, idB.id);

        // ---- Frame 1 ----
        var fg1 = new FrameGroup(1);
        var c1 = inst('user', 0), c2 = inst('user', 0), c3 = inst('user', 0);
        var gC = new InstanceGroup(3, idA.id);
        gC.addInstance('cam1', c1); gC.addInstance('cam2', c2); gC.addInstance('cam3', c3);
        fg1.addInstance('cam1', c1); fg1.addInstance('cam2', c2); fg1.addInstance('cam3', c3);
        s.frameGroups.set(1, fg1);
        s.instanceGroups.set(1, [gC]);

        return { s: s, idA: idA, idB: idB };
    }

    function ctxFrame(s, frame, clip) {
        return { currentSession: s, currentFrame: frame, clipRange: clip || [0, 0] };
    }
    function F(type, grouping, extra) {
        return Object.assign({
            type: type, grouping: grouping, view: null,
            trackMode: 'any', trackIdx: null, identityMode: 'any', identityId: null,
            frameScope: 'currentFrame',
        }, extra || {});
    }

    describe('collectDeletionTargets — type + grouping filters (current frame)', function () {
        it('type "all", grouping "any" → 4 grouped members + 2 unlinked = 6', function () {
            var s = buildSession().s;
            var r = collectDeletionTargets([s], F('all', 'any'), ctxFrame(s, 0));
            assertEqual(r.count, 6, 'all observed instances on frame 0');
            assertEqual(r.frameCount, 1, 'one frame');
        });
        it('type "predicted" → 3 grouped (A×2 + B cam2) + 1 unlinked = 4', function () {
            var s = buildSession().s;
            assertEqual(collectDeletionTargets([s], F('predicted', 'any'), ctxFrame(s, 0)).count, 4);
        });
        it('type "user" → 1 grouped (B cam1) + 1 unlinked (cam2) = 2', function () {
            var s = buildSession().s;
            assertEqual(collectDeletionTargets([s], F('user', 'any'), ctxFrame(s, 0)).count, 2);
        });
        it('grouping "grouped" excludes the unlinked pool → 4', function () {
            var s = buildSession().s;
            assertEqual(collectDeletionTargets([s], F('all', 'grouped'), ctxFrame(s, 0)).count, 4);
        });
        it('grouping "ungrouped" excludes groups → 2', function () {
            var s = buildSession().s;
            assertEqual(collectDeletionTargets([s], F('all', 'ungrouped'), ctxFrame(s, 0)).count, 2);
        });
        it('type "reprojected" → group A reprojections (2), observed excluded', function () {
            var s = buildSession().s;
            var r = collectDeletionTargets([s], F('reprojected', 'any'), ctxFrame(s, 0));
            assertEqual(r.count, 2, 'two reprojected instances');
            assertEqual(r.targets[0].kind, 'reprojGroup', 'group-level reproj target when no view filter');
        });
    });

    describe('collectDeletionTargets — view / track / identity filters', function () {
        it('view "cam1" → A cam1 + B cam1 grouped + cam1 unlinked = 3', function () {
            var s = buildSession().s;
            assertEqual(collectDeletionTargets([s], F('all', 'any', { view: 'cam1' }), ctxFrame(s, 0)).count, 3);
        });
        it('view "cam1" + reprojected → reprojView target (1)', function () {
            var s = buildSession().s;
            var r = collectDeletionTargets([s], F('reprojected', 'any', { view: 'cam1' }), ctxFrame(s, 0));
            assertEqual(r.count, 1);
            assertEqual(r.targets[0].kind, 'reprojView');
        });
        it('trackMode "specific" idx 0 → only group A members (2)', function () {
            var s = buildSession().s;
            assertEqual(collectDeletionTargets([s], F('all', 'any', { trackMode: 'specific', trackIdx: 0 }), ctxFrame(s, 0)).count, 2);
        });
        it('trackMode "none" → only the trackless unlinked instance (1)', function () {
            var s = buildSession().s;
            assertEqual(collectDeletionTargets([s], F('all', 'any', { trackMode: 'none' }), ctxFrame(s, 0)).count, 1);
        });
        it('identityMode "specific" idB → group B members only (2)', function () {
            var b = buildSession();
            assertEqual(collectDeletionTargets([b.s], F('all', 'grouped', { identityMode: 'specific', identityId: b.idB.id }), ctxFrame(b.s, 0)).count, 2);
        });
    });

    describe('collectDeletionTargets — frame scope', function () {
        it('"currentSession" spans both frames (6 on f0 + 3 on f1 = 9)', function () {
            var s = buildSession().s;
            var r = collectDeletionTargets([s], F('all', 'any', { frameScope: 'currentSession' }), ctxFrame(s, 0));
            assertEqual(r.count, 9);
            assertEqual(r.frameCount, 2);
        });
        it('"clip" [1,1] restricts to frame 1 → 3', function () {
            var s = buildSession().s;
            assertEqual(collectDeletionTargets([s], F('all', 'any', { frameScope: 'clip' }), ctxFrame(s, 0, [1, 1])).count, 3);
        });
        it('"exceptClip" [1,1] restricts to frame 0 → 6', function () {
            var s = buildSession().s;
            assertEqual(collectDeletionTargets([s], F('all', 'any', { frameScope: 'exceptClip' }), ctxFrame(s, 0, [1, 1])).count, 6);
        });
    });

    describe('executeDeletion — cascade', function () {
        it('delete predicted (f0): fully-predicted group removed, mixed group unlinked to survivor', function () {
            var s = buildSession().s;
            var r = collectDeletionTargets([s], F('predicted', 'any'), ctxFrame(s, 0));
            executeDeletion(r.targets);
            assertEqual(s.getInstanceGroupsForFrame(0).length, 0, 'both groups gone from frame 0');
            var fg = s.frameGroups.get(0);
            // Survivor of mixed group B (cam1 user) is back in the unlinked pool.
            var cam1Unlinked = fg.unlinkedInstances.get('cam1') || [];
            assertTrue(cam1Unlinked.length >= 1, 'a survivor lives in cam1 unlinked pool');
            var stillUser = cam1Unlinked.some(function (u) { return u.instance.type === 'user'; });
            assertTrue(stillUser, 'mixed-group survivor is user-typed');
        });
        it('delete user grouped view cam1 (f1): 3-member group shrinks to 2, marked dirty', function () {
            var s = buildSession().s;
            var r = collectDeletionTargets([s], F('user', 'grouped', { view: 'cam1', frameScope: 'clip' }), ctxFrame(s, 0, [1, 1]));
            var out = executeDeletion(r.targets);
            var groups = s.getInstanceGroupsForFrame(1);
            assertEqual(groups.length, 1, 'group C still present');
            assertEqual(groups[0].instances.size, 2, 'shrunk from 3 to 2 members');
            assertFalse(groups[0].instances.has('cam1'), 'cam1 member removed');
            assertTrue(groups[0].dirty, 'group marked dirty (3D stale)');
            assertTrue(out.purgedGroups.length >= 1, 'shrunk group reported for triangulation purge');
        });
        it('delete reprojected (f0): reprojections cleared, observed members untouched', function () {
            var s = buildSession().s;
            var gA = s.getInstanceGroupsForFrame(0)[0];
            assertEqual(gA.reprojectedInstances.size, 2, 'precondition: 2 reprojections');
            var r = collectDeletionTargets([s], F('reprojected', 'any'), ctxFrame(s, 0));
            executeDeletion(r.targets);
            assertEqual(gA.reprojectedInstances.size, 0, 'reprojections cleared');
            assertEqual(gA.instances.size, 2, 'observed members untouched');
            assertEqual(gA.points3d, null, '3D points cleared');
            assertTrue(gA.dirty, 'group marked dirty for re-triangulation');
            assertEqual(s.getInstanceGroupsForFrame(0).length, 2, 'both groups still present');
        });
        it('delete ungrouped only (f0): unlinked pool emptied, groups intact', function () {
            var s = buildSession().s;
            var r = collectDeletionTargets([s], F('all', 'ungrouped'), ctxFrame(s, 0));
            executeDeletion(r.targets);
            var fg = s.frameGroups.get(0);
            var total = 0;
            fg.unlinkedInstances.forEach(function (l) { total += l.length; });
            assertEqual(total, 0, 'no unlinked instances remain');
            assertEqual(s.getInstanceGroupsForFrame(0).length, 2, 'groups untouched');
        });
    });

    describe('executeDeletion — frameIdentityMap pruning (no orphaned overrides)', function () {
        it('delete predicted (f0): overrides for removed (cam,track) pruned, survivor kept', function () {
            var s = buildSession().s;
            // Precondition: 4 per-frame identity overrides on frame 0.
            assertEqual(s.frameIdentityMap.size, 4, 'precondition: 4 identity overrides');
            var r = collectDeletionTargets([s], F('predicted', 'any'), ctxFrame(s, 0));
            executeDeletion(r.targets);
            // Group A (track 0) removed entirely → both track-0 overrides gone.
            assertFalse(s.frameIdentityMap.has('0:cam1:0'), 'cam1 track0 override pruned (group A gone)');
            assertFalse(s.frameIdentityMap.has('0:cam2:0'), 'cam2 track0 override pruned (group A gone)');
            // Group B lost its cam2 predicted member → that override is pruned,
            // but the cam1 user survivor (track 1, now unlinked) keeps its override.
            assertFalse(s.frameIdentityMap.has('0:cam2:1'), 'cam2 track1 override pruned (member deleted)');
            assertTrue(s.frameIdentityMap.has('0:cam1:1'), 'cam1 track1 override kept (survivor lives on)');
            assertEqual(s.frameIdentityMap.size, 1, 'exactly one live override remains');
        });
        it('delete a single grouped view (f1 cam1): only the deleted view override pruned', function () {
            var s = buildSession().s;
            // Frame 1's group C (cam1/cam2/cam3, track 0) has no overrides yet;
            // add them so the prune is observable.
            s.setFrameIdentity(1, 'cam1', 0, s.identities[0].id);
            s.setFrameIdentity(1, 'cam2', 0, s.identities[0].id);
            s.setFrameIdentity(1, 'cam3', 0, s.identities[0].id);
            var r = collectDeletionTargets([s], F('user', 'grouped', { view: 'cam1', frameScope: 'clip' }), ctxFrame(s, 0, [1, 1]));
            executeDeletion(r.targets);
            assertFalse(s.frameIdentityMap.has('1:cam1:0'), 'deleted cam1 override pruned');
            assertTrue(s.frameIdentityMap.has('1:cam2:0'), 'surviving cam2 override kept');
            assertTrue(s.frameIdentityMap.has('1:cam3:0'), 'surviving cam3 override kept');
        });
    });
})();
