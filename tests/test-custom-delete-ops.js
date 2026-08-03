/**
 * test-custom-delete-ops.js — unit tests for ui/custom-delete-ops.js, the
 * filter/collect/cascade logic behind "Custom Instance Delete…".
 *
 * Companion to test-custom-delete-store.js (which pins the columnar-store
 * durability primitive). This file pins the parts a user actually sees:
 *
 *  - the two ORTHOGONAL axes: type (user/predicted/all) x grouping
 *    (any/grouped/ungrouped). "Delete grouped instances" is type=all +
 *    grouping=grouped, not a type of its own — a grouped instance is still user
 *    or predicted.
 *  - view / track / identity filters, with identity resolved PER FRAME via
 *    `getIdentityIdForTrack` (never the stale `group.identityId`).
 *  - the >=2-member cascade: dissolve / auto-ungroup / mixed->user promotion,
 *    and that `previewCascade` predicts it before anything is mutated (the
 *    dialog has to warn about it).
 *  - `frameIdentityMap` pruning through `deleteFrameIdentity`, i.e. the PACKED
 *    keys. PR #153 compared raw "frame:cam:track" strings, which silently
 *    matched nothing after #185 repacked them — so its prune was dead code and
 *    both the ghost-identity and the group-resurrection-on-triangulate bugs
 *    remained.
 *  - that `_rawInstIndex` is renumbered on survivors, which is what keeps
 *    `refFor` and `finalizeLazyFrameGroup` pointing at the right store rows.
 *
 * Requires the test-runner bridge: window.__CustomDeleteOps plus the pose-data
 * classes (Session/Camera/Skeleton/Instance/InstanceGroup/FrameGroup/UnlinkedInstance).
 */

(function () {
    const { describe, it, assertEqual, assertTrue, assertDeepEqual } = TestFramework;

    const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];

    /**
     * Frame 0 fixture, 3 cameras, mirroring the shapes that matter:
     *   groupA  cam1 predicted t0, cam2 predicted t0        (all-predicted pair)
     *   groupB  cam1 user t1,      cam2 predicted t1        (MIXED pair)
     *   groupC  cam1 user t2, cam2 user t2, cam3 user t2    (3-member, survives partial)
     *   ungrouped: cam1 predicted trackless, cam2 user t3
     */
    function buildSession() {
        const cams = ['cam1', 'cam2', 'cam3'].map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [640, 480]));
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const session = new Session(cams, skel, ['t0', 't1', 't2', 't3'], 'DelOps');

        const mk = (trackIdx, type, rawIdx) => {
            const inst = new Instance([[1, 2], [3, 4]], trackIdx, type, type === 'user' ? 1 : 0.9);
            if (rawIdx != null) inst._rawInstIndex = rawIdx;
            return inst;
        };

        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);

        const gA = new InstanceGroup(1, -1);
        gA.addInstance('cam1', mk(0, 'predicted', 0));
        gA.addInstance('cam2', mk(0, 'predicted', 0));
        const gB = new InstanceGroup(2, -1);
        gB.addInstance('cam1', mk(1, 'user', 1));
        gB.addInstance('cam2', mk(1, 'predicted', 1));
        const gC = new InstanceGroup(3, -1);
        gC.addInstance('cam1', mk(2, 'user', 2));
        gC.addInstance('cam2', mk(2, 'user', 2));
        gC.addInstance('cam3', mk(2, 'user', 0));

        for (const g of [gA, gB, gC]) {
            for (const [cn, inst] of g.instances) fg.addInstance(cn, inst);
            g.points3d = new Float64Array([1, 2, 3, 4, 5, 6]);
        }
        session.instanceGroups.set(0, [gA, gB, gC]);

        fg.addUnlinkedInstance('cam1', new UnlinkedInstance(mk(null, 'predicted', 3), 'cam1'));
        fg.addUnlinkedInstance('cam2', new UnlinkedInstance(mk(3, 'user', 3), 'cam2'));

        return { session, fg, gA, gB, gC };
    }

    const FILTERS = {
        type: 'all', grouping: 'any', view: null,
        trackMode: 'any', trackIdx: null,
        identityMode: 'any', identityId: null,
        frameScope: 'currentFrame',
    };
    const f = (over) => Object.assign({}, FILTERS, over || {});
    const CTX = { currentFrame: 0 };

    describe('custom-delete-ops — collection and filters', function () {

        it('counts every observed instance with the default filters', function () {
            const { session } = buildSession();
            const r = __CustomDeleteOps.collectDeletionTargets(session, f(), CTX);
            // 2 (gA) + 2 (gB) + 3 (gC) + 2 ungrouped = 9
            assertEqual(r.count, 9, 'all 9 observed instances matched');
        });

        it('splits cleanly by type — user + predicted partition "all"', function () {
            const { session } = buildSession();
            const all = __CustomDeleteOps.collectDeletionTargets(session, f(), CTX).count;
            const usr = __CustomDeleteOps.collectDeletionTargets(session, f({ type: 'user' }), CTX).count;
            const prd = __CustomDeleteOps.collectDeletionTargets(session, f({ type: 'predicted' }), CTX).count;
            assertEqual(usr, 5, 'user: gB.cam1 + gC x3 + ungrouped cam2 = 5');
            assertEqual(prd, 4, 'predicted: gA x2 + gB.cam2 + ungrouped cam1 = 4');
            assertEqual(usr + prd, all, 'user + predicted exactly partition "all" (' + usr + '+' + prd + '=' + all + ')');
        });

        it('grouping is ORTHOGONAL to type, not a type of its own', function () {
            const { session } = buildSession();
            const grouped = __CustomDeleteOps.collectDeletionTargets(session, f({ grouping: 'grouped' }), CTX);
            const ungrouped = __CustomDeleteOps.collectDeletionTargets(session, f({ grouping: 'ungrouped' }), CTX);
            assertEqual(grouped.count, 7, 'grouped only: 2+2+3');
            assertEqual(ungrouped.count, 2, 'ungrouped only: the 2 pool entries');
            assertEqual(grouped.count + ungrouped.count, 9, 'the two partition "any"');
            // and it composes with type
            const grpPred = __CustomDeleteOps.collectDeletionTargets(
                session, f({ grouping: 'grouped', type: 'predicted' }), CTX);
            assertEqual(grpPred.count, 3, 'grouped + predicted: gA x2 + gB.cam2');
            assertTrue(grouped.targets.every(t => t.kind === 'grouped'), 'kinds are all "grouped"');
            assertTrue(ungrouped.targets.every(t => t.kind === 'ungrouped'), 'kinds are all "ungrouped"');
        });

        it('filters by view', function () {
            const { session } = buildSession();
            const c1 = __CustomDeleteOps.collectDeletionTargets(session, f({ view: 'cam1' }), CTX);
            assertEqual(c1.count, 4, 'cam1: gA + gB + gC members + 1 ungrouped');
            assertEqual(c1.byCamera.cam1, 4, 'per-camera breakdown reported');
            assertTrue(!c1.byCamera.cam2, 'cam2 not counted');
            const c3 = __CustomDeleteOps.collectDeletionTargets(session, f({ view: 'cam3' }), CTX);
            assertEqual(c3.count, 1, 'cam3 only has gC\'s member');
        });

        it('filters by track, including the trackless case', function () {
            const { session } = buildSession();
            const t0 = __CustomDeleteOps.collectDeletionTargets(
                session, f({ trackMode: 'specific', trackIdx: 0 }), CTX);
            assertEqual(t0.count, 2, 'track 0 = gA\'s two members');
            const none = __CustomDeleteOps.collectDeletionTargets(session, f({ trackMode: 'none' }), CTX);
            assertEqual(none.count, 1, 'only the trackless ungrouped cam1 prediction');
            assertEqual(none.targets[0].kind, 'ungrouped', 'and it is the ungrouped one');
        });

        it('resolves identity PER FRAME, not from the stale group.identityId', function () {
            const { session, gA } = buildSession();
            const red = session.addIdentity('Red');
            // Per-frame entry for (cam1, t0) only — this is the canonical source.
            session.setFrameIdentity(0, 'cam1', 0, red.id);
            // Deliberately set a CONTRADICTORY group.identityId: if the matcher
            // read the group field it would match both of gA's members.
            gA.identityId = red.id;

            const hit = __CustomDeleteOps.collectDeletionTargets(
                session, f({ identityMode: 'specific', identityId: red.id }), CTX);
            assertEqual(hit.count, 1, 'only (cam1, t0) has a per-frame Red entry (got ' + hit.count + ')');
            assertEqual(hit.targets[0].camName, 'cam1', 'and it is cam1');

            const noId = __CustomDeleteOps.collectDeletionTargets(
                session, f({ identityMode: 'none' }), CTX);
            assertEqual(noId.count, 8, 'the other 8 have no per-frame identity');
        });
    });

    describe('custom-delete-ops — cascade preview', function () {

        it('predicts a dissolve when every member is removed', function () {
            const { session } = buildSession();
            const r = __CustomDeleteOps.collectDeletionTargets(
                session, f({ trackMode: 'specific', trackIdx: 0 }), CTX);   // both of gA
            assertEqual(r.groupsDissolved, 1, 'gA will dissolve');
            assertEqual(r.groupsUngrouped, 0, 'nothing auto-ungrouped');
            assertEqual(r.groupsLosing3d, 1, 'gA had 3D and will lose it');
        });

        it('predicts auto-ungroup AND the mixed->user promotion', function () {
            const { session } = buildSession();
            // Delete gB's PREDICTED member (cam2) -> gB drops to 1 user member.
            const r = __CustomDeleteOps.collectDeletionTargets(
                session, f({ type: 'predicted', view: 'cam2', grouping: 'grouped' }), CTX);
            assertEqual(r.count, 2, 'gA.cam2 + gB.cam2');
            assertEqual(r.groupsUngrouped, 2, 'gA and gB both drop to 1 member');
            // gB's survivor is a USER instance, so no promotion; gA's survivor is
            // predicted but gA was never mixed, so also no promotion.
            assertEqual(r.instancesPromoted, 0, 'no promotion: gB survivor already user, gA never mixed');
        });

        it('predicts the promotion when the survivor of a MIXED group is predicted', function () {
            const { session } = buildSession();
            // Delete gB's USER member (cam1) -> predicted cam2 survives a mixed group.
            const r = __CustomDeleteOps.collectDeletionTargets(
                session, f({ type: 'user', view: 'cam1', grouping: 'grouped' }), CTX);
            assertEqual(r.count, 2, 'gB.cam1 and gC.cam1 match');
            // Only gB drops below 2 members. gC has THREE members, so losing one
            // leaves two and it survives — its 3D goes stale but it is not ungrouped.
            assertEqual(r.groupsUngrouped, 1, 'only gB (2 members) auto-ungroups; gC (3) survives');
            assertEqual(r.groupsLosing3d, 2, 'both gB and gC lose their 3D');
            assertEqual(r.instancesPromoted, 1,
                'gB\'s predicted survivor gets promoted to user (got ' + r.instancesPromoted + ')');
        });

        it('a 3-member group losing one member survives but loses its 3D', function () {
            const { session } = buildSession();
            const r = __CustomDeleteOps.collectDeletionTargets(
                session, f({ view: 'cam3', grouping: 'grouped' }), CTX);
            assertEqual(r.count, 1, 'just gC.cam3');
            assertEqual(r.groupsDissolved, 0, 'gC survives');
            assertEqual(r.groupsUngrouped, 0, 'gC is not auto-ungrouped (2 members left)');
            assertEqual(r.groupsLosing3d, 1, 'but its 3D is now stale and will be purged');
        });
    });

    describe('custom-delete-ops — execution', function () {

        it('dissolves a group whose every member is deleted', function () {
            const { session, fg } = buildSession();
            const r = __CustomDeleteOps.collectDeletionTargets(
                session, f({ trackMode: 'specific', trackIdx: 0 }), CTX);
            const res = __CustomDeleteOps.executeDeletion(session, r.targets);

            assertEqual(res.deleted, 2, 'both members removed');
            assertEqual(res.groupsDissolved, 1, 'group dissolved');
            assertEqual((session.instanceGroups.get(0) || []).length, 2, 'gB and gC remain');
            // gA's members must be out of the FrameGroup too, not just the group.
            const cam1 = fg.instances.get('cam1') || [];
            assertTrue(cam1.every(i => i.trackIdx !== 0), 'no track-0 instance left in fg.instances[cam1]');
        });

        it('auto-ungroups a group that drops to one member, promoting a mixed survivor', function () {
            const { session, gB, fg } = buildSession();
            const r = __CustomDeleteOps.collectDeletionTargets(
                session, f({ type: 'user', view: 'cam1', grouping: 'grouped' }), CTX);
            const survivor = gB.instances.get('cam2');
            assertEqual(survivor.type, 'predicted', 'precondition: gB\'s cam2 member is predicted');

            const res = __CustomDeleteOps.executeDeletion(session, r.targets);

            assertEqual(res.groupsUngrouped, 1, 'only gB auto-ungroups (gC keeps 2 of its 3 members)');
            assertEqual(survivor.type, 'user', 'the mixed group\'s predicted survivor was promoted to user');
            assertTrue(survivor.modified === true, 'and flagged modified');
            const pool = fg.getUnlinkedInstances('cam2') || [];
            assertTrue(pool.some(u => u.instance === survivor), 'survivor returned to the ungrouped pool');
        });

        it('clears stale 3D on a group that survives with >=2 members', function () {
            const { session, gC } = buildSession();
            assertTrue(!!(gC.points3d && gC.points3d.length), 'precondition: gC has 3D');
            const r = __CustomDeleteOps.collectDeletionTargets(
                session, f({ view: 'cam3', grouping: 'grouped' }), CTX);
            const res = __CustomDeleteOps.executeDeletion(session, r.targets);

            assertEqual(gC.instances.size, 2, 'gC still has 2 members');
            assertEqual(gC.points3d, null, 'its stale 3D was cleared');
            assertTrue(gC.dirty === true, 'and it is marked dirty for re-triangulation');
            assertTrue(res.purgedGroups.some(p => p.group === gC),
                'gC reported in purgedGroups so the caller purges triangulationResults');
        });

        it('does not throw on group.observedPoints (read-only getter since #189)', function () {
            const { session } = buildSession();
            // A partial delete is the exact shape that used to assign
            // group.observedPoints = null and TypeError in strict mode.
            const r = __CustomDeleteOps.collectDeletionTargets(
                session, f({ view: 'cam3', grouping: 'grouped' }), CTX);
            let threw = null;
            try { __CustomDeleteOps.executeDeletion(session, r.targets); } catch (e) { threw = e; }
            assertTrue(threw === null, 'no TypeError from observedPoints (got ' + (threw && threw.message) + ')');
        });

        it('removes ungrouped instances from the pool', function () {
            const { session, fg } = buildSession();
            const r = __CustomDeleteOps.collectDeletionTargets(session, f({ grouping: 'ungrouped' }), CTX);
            const res = __CustomDeleteOps.executeDeletion(session, r.targets);
            assertEqual(res.deleted, 2, 'both pool entries deleted');
            assertEqual((fg.getUnlinkedInstances('cam1') || []).length, 0, 'cam1 pool empty');
            assertEqual((fg.getUnlinkedInstances('cam2') || []).length, 0, 'cam2 pool empty');
            assertEqual((session.instanceGroups.get(0) || []).length, 3, 'groups untouched');
        });

        it('renumbers _rawInstIndex on survivors so store refs stay aligned', function () {
            const { session, fg } = buildSession();
            // cam1 holds rawIdx 0 (gA), 1 (gB), 2 (gC), 3 (ungrouped).
            // Delete rawIdx 1 (gB.cam1, the user one) -> survivors 2,3 shift to 1,2.
            const gC = session.instanceGroups.get(0)[2];
            const before = gC.instances.get('cam1')._rawInstIndex;
            assertEqual(before, 2, 'precondition: gC.cam1 is store row offset 2');

            const r = __CustomDeleteOps.collectDeletionTargets(
                session, f({ type: 'user', view: 'cam1', grouping: 'grouped' }), CTX);
            __CustomDeleteOps.executeDeletion(session, r.targets);

            // gC.cam1 was deleted too (it is a user instance on cam1), so check the
            // ungrouped cam1 prediction, which survives (predicted, rawIdx 3).
            const pool = fg.getUnlinkedInstances('cam1') || [];
            const stillThere = pool.filter(u => u.instance.type === 'predicted');
            assertEqual(stillThere.length, 1, 'the trackless cam1 prediction survives');
            assertEqual(stillThere[0].instance._rawInstIndex, 1,
                'its _rawInstIndex shifted 3 -> 1 (two lower rows deleted), got ' +
                stillThere[0].instance._rawInstIndex);
        });

        it('is a no-op on an empty target list', function () {
            const { session } = buildSession();
            const res = __CustomDeleteOps.executeDeletion(session, []);
            assertEqual(res.deleted, 0, 'nothing deleted');
            assertEqual((session.instanceGroups.get(0) || []).length, 3, 'groups intact');
        });
    });

    describe('custom-delete-ops — frameIdentityMap pruning (packed keys)', function () {

        it('prunes orphaned entries through deleteFrameIdentity, and keeps live ones', function () {
            const { session } = buildSession();
            const red = session.addIdentity('Red');
            const blue = session.addIdentity('Blue');
            session.setFrameIdentity(0, 'cam1', 0, red.id);   // gA.cam1 -> will be deleted
            session.setFrameIdentity(0, 'cam2', 0, red.id);   // gA.cam2 -> will be deleted
            session.setFrameIdentity(0, 'cam1', 2, blue.id);  // gC.cam1 -> SURVIVES
            const sizeBefore = session.frameIdentityMap.size;
            assertEqual(sizeBefore, 3, 'precondition: 3 identity overrides');

            const r = __CustomDeleteOps.collectDeletionTargets(
                session, f({ trackMode: 'specific', trackIdx: 0 }), CTX);   // delete both of gA
            __CustomDeleteOps.executeDeletion(session, r.targets);

            assertTrue(!session.hasFrameIdentity(0, 'cam1', 0),
                'orphaned (cam1, t0) override pruned — otherwise ensureGroupsFromIdentities ' +
                'recreates the deleted group on the next Triangulate All');
            assertTrue(!session.hasFrameIdentity(0, 'cam2', 0), 'orphaned (cam2, t0) override pruned');
            assertTrue(session.hasFrameIdentity(0, 'cam1', 2),
                'the still-live (cam1, t2) override was KEPT');
            assertEqual(session.frameIdentityMap.size, 1, 'exactly one override remains');
        });

        it('prunes nothing when every override still has an instance', function () {
            const { session } = buildSession();
            const red = session.addIdentity('Red');
            session.setFrameIdentity(0, 'cam1', 2, red.id);   // gC.cam1, survives
            const r = __CustomDeleteOps.collectDeletionTargets(session, f({ grouping: 'ungrouped' }), CTX);
            __CustomDeleteOps.executeDeletion(session, r.targets);
            assertTrue(session.hasFrameIdentity(0, 'cam1', 2), 'live override untouched');
            assertEqual(session.frameIdentityMap.size, 1, 'map unchanged');
        });
    });
})();
