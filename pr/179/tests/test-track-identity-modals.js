/**
 * test-track-identity-modals.js
 *
 * Tests the logic backing the Tracks-menu New / Rename / Delete modals
 * (track + identity), which lives in `ui/track-identity-ops.js`:
 *   - nameExists(session, kind, name)        — duplicate-name validation
 *   - countNulledByCamera(session, kind, idx)— Delete modal's per-camera table
 *   - deleteTrackAt(session, idx)            — null + reindex on track delete
 *   - deleteIdentityAt(session, idx)         — unassign groups + clear per-frame
 *                                              identity map on identity delete
 *
 * The modal DOM glue itself lives in `ui/ui-wiring.js`, which can't be loaded
 * in this headless runner (app.js import graph). These ops are the substance
 * of "do the modals work": the counts shown, what gets nulled, and the
 * duplicate guards. The identity count/delete deliberately use the canonical
 * per-frame identity source (`getIdentityIdForTrack` / `frameIdentityMap`),
 * NOT `group.identityId` — group.identityId is only set after triangulation,
 * so reading it left the Delete-Identity table empty/stale (the reported bug).
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertEqual = TF.assertEqual;
    var assertDeepEqual = TF.assertDeepEqual;
    var assertTrue = TF.assertTrue;
    var assertFalse = TF.assertFalse;

    // ---- mock session (mirrors the pose-data.js shape used by the ops) ----

    function inst(trackIdx) { return { trackIdx: trackIdx, type: 'user' }; }

    function makeSession() {
        return {
            tracks: ['A', 'B', 'C'],
            identities: [{ id: 10, name: 'idX' }, { id: 11, name: 'idY' }],
            cameras: [{ name: 'cam1' }, { name: 'cam2' }],
            frameGroups: new Map(),
            instanceGroups: new Map(),
            frameIdentityMap: new Map(),
            _hiddenTracks: new Set(),
            _hiddenIdentities: new Set(),
            // Same contract as Session.getIdentityIdForTrack.
            getIdentityIdForTrack: function (cameraName, trackIdx, frameIdx) {
                if (frameIdx == null) return null;
                var v = this.frameIdentityMap.get(frameIdx + ':' + cameraName + ':' + trackIdx);
                if (v != null) return v < 0 ? null : v;
                return null;
            },
            // Minimal mirror of Session.unlinkGroup: drop the group, return its
            // instances to the frame's unlinked pool (same {instance} shape).
            unlinkGroup: function (frameIdx, group) {
                var groups = this.instanceGroups.get(frameIdx);
                if (groups) {
                    var gi = groups.indexOf(group);
                    if (gi >= 0) groups.splice(gi, 1);
                    if (groups.length === 0) this.instanceGroups.delete(frameIdx);
                }
                var fg = this.frameGroups.get(frameIdx);
                if (fg) {
                    for (var [cam, inst] of group.instances) {
                        var ci = fg.instances.get(cam);
                        if (ci) {
                            var k = ci.indexOf(inst);
                            if (k >= 0) ci.splice(k, 1);
                            if (ci.length === 0) fg.instances.delete(cam);
                        }
                        if (!fg.unlinkedInstances.has(cam)) fg.unlinkedInstances.set(cam, []);
                        fg.unlinkedInstances.get(cam).push({ instance: inst });
                    }
                }
            },
        };
    }

    function addFrame(session, frameIdx) {
        var fg = { instances: new Map(), unlinkedInstances: new Map() };
        session.frameGroups.set(frameIdx, fg);
        return fg;
    }
    function addGrouped(fg, cam, instance) {
        if (!fg.instances.has(cam)) fg.instances.set(cam, []);
        fg.instances.get(cam).push(instance);
    }
    function addUnlinked(fg, cam, instance) {
        if (!fg.unlinkedInstances.has(cam)) fg.unlinkedInstances.set(cam, []);
        fg.unlinkedInstances.get(cam).push({ instance: instance });
    }
    function setIdentity(session, frameIdx, cam, trackIdx, identityId) {
        session.frameIdentityMap.set(frameIdx + ':' + cam + ':' + trackIdx, identityId);
    }

    describe('track-identity-ops: nameExists', function () {
        it('detects existing / missing track and identity names', function () {
            var s = makeSession();
            assertTrue(nameExists(s, 'track', 'A'), 'track A exists');
            assertTrue(nameExists(s, 'track', 'C'), 'track C exists');
            assertFalse(nameExists(s, 'track', 'Z'), 'track Z does not exist');
            assertTrue(nameExists(s, 'identity', 'idX'), 'identity idX exists');
            assertFalse(nameExists(s, 'identity', 'idZ'), 'identity idZ does not exist');
        });
    });

    describe('track-identity-ops: countNulledByCamera (track)', function () {
        it('counts grouped + unlinked instances per camera with a total', function () {
            var s = makeSession();
            var f0 = addFrame(s, 0);
            addGrouped(f0, 'cam1', inst(1));   // B
            addGrouped(f0, 'cam1', inst(0));   // A
            addUnlinked(f0, 'cam2', inst(1));  // B (unlinked)
            var f1 = addFrame(s, 1);
            addGrouped(f1, 'cam1', inst(1));   // B

            var r1 = countNulledByCamera(s, 'track', 1);
            assertDeepEqual({ cam1: 2, cam2: 1 }, r1.perCamera, 'track 1 per-camera');
            assertEqual(r1.total, 3, 'track 1 total');

            var r0 = countNulledByCamera(s, 'track', 0);
            assertDeepEqual({ cam1: 1, cam2: 0 }, r0.perCamera, 'track 0 per-camera');
            assertEqual(r0.total, 1, 'track 0 total');

            var r2 = countNulledByCamera(s, 'track', 2);  // no instances on C
            assertDeepEqual({ cam1: 0, cam2: 0 }, r2.perCamera, 'track 2 per-camera (none)');
            assertEqual(r2.total, 0, 'track 2 total (none)');
        });
    });

    describe('track-identity-ops: countNulledByCamera (identity)', function () {
        it('counts via the per-frame identity map, not group.identityId', function () {
            var s = makeSession();
            var f0 = addFrame(s, 0);
            addGrouped(f0, 'cam1', inst(1));
            addUnlinked(f0, 'cam2', inst(1));
            var f1 = addFrame(s, 1);
            addGrouped(f1, 'cam1', inst(1));
            // Per-frame identity: frame0 track1 -> id 10 (both cams); frame1 -> id 11.
            setIdentity(s, 0, 'cam1', 1, 10);
            setIdentity(s, 0, 'cam2', 1, 10);
            setIdentity(s, 1, 'cam1', 1, 11);

            // instanceGroups intentionally left EMPTY — proves the count does
            // not rely on group.identityId (the cause of the empty-table bug).
            var rX = countNulledByCamera(s, 'identity', 0);  // id 10
            assertDeepEqual({ cam1: 1, cam2: 1 }, rX.perCamera, 'idX per-camera');
            assertEqual(rX.total, 2, 'idX total');

            var rY = countNulledByCamera(s, 'identity', 1);  // id 11
            assertDeepEqual({ cam1: 1, cam2: 0 }, rY.perCamera, 'idY per-camera');
            assertEqual(rY.total, 1, 'idY total');
        });

        it('ignores instances with no / explicit-none per-frame identity', function () {
            var s = makeSession();
            var f0 = addFrame(s, 0);
            addGrouped(f0, 'cam1', inst(0));   // track 0, no map entry -> no identity
            addGrouped(f0, 'cam1', inst(2));   // track 2, explicit none (-1)
            addUnlinked(f0, 'cam1', inst(null)); // trackless -> skipped
            setIdentity(s, 0, 'cam1', 2, -1);  // explicit "no identity"

            var rX = countNulledByCamera(s, 'identity', 0);  // id 10
            assertDeepEqual({ cam1: 0, cam2: 0 }, rX.perCamera, 'no instances carry idX');
            assertEqual(rX.total, 0, 'idX total is 0');
        });
    });

    describe('track-identity-ops: deleteTrackAt', function () {
        it('nulls the deleted track and shifts higher indices down (grouped + unlinked)', function () {
            var s = makeSession();
            var f0 = addFrame(s, 0);
            var i0 = inst(0), i1 = inst(1), i2 = inst(2);
            addGrouped(f0, 'cam1', i0);
            addGrouped(f0, 'cam1', i1);
            addGrouped(f0, 'cam2', i2);
            var u1 = inst(1), u2 = inst(2);
            addUnlinked(f0, 'cam2', u1);
            addUnlinked(f0, 'cam2', u2);

            var name = deleteTrackAt(s, 1);  // delete track 'B'

            assertEqual(name, 'B', 'returns deleted name');
            assertDeepEqual(['A', 'C'], s.tracks, 'B removed from tracks');
            assertEqual(i0.trackIdx, 0, 'track 0 unchanged');
            // Deleted-track instances become trackless (null) — NOT -1, which
            // indexes past TRACK_COLORS and crashes the overlay renderer.
            assertEqual(i1.trackIdx, null, 'deleted track nulled to null (grouped)');
            assertEqual(i2.trackIdx, 1, 'track 2 shifted down to 1 (grouped)');
            assertEqual(u1.trackIdx, null, 'deleted track nulled to null (unlinked)');
            assertEqual(u2.trackIdx, 1, 'track 2 shifted down to 1 (unlinked)');
            assertFalse(s._hiddenTracks.has('B'), 'hidden-tracks entry dropped');
        });

        it('nulls grouped instances and never double-decrements shared refs', function () {
            var s = makeSession();
            var f0 = addFrame(s, 0);
            // Grouped instances share object refs with frameGroups (as the app
            // builds them): same objects live in fg.instances AND a group.
            var gDel = inst(1);   // on the track being deleted (B)
            var gHi = inst(2);    // higher track (C) — must shift to 1, ONCE
            addGrouped(f0, 'cam1', gDel);
            addGrouped(f0, 'cam2', gHi);
            var group = { identityId: 10, instances: new Map([['cam1', gDel], ['cam2', gHi]]) };
            s.instanceGroups.set(0, [group]);

            deleteTrackAt(s, 1);  // delete track 'B'

            assertEqual(gDel.trackIdx, null, 'grouped instance on deleted track nulled');
            assertEqual(gHi.trackIdx, 1, 'grouped higher track shifted down exactly once (no double-decrement)');
        });

        it('keeps identities assigned to instances when their track is deleted', function () {
            var s = makeSession();  // tracks A,B,C
            var f0 = addFrame(s, 0);
            var iA = inst(0), iC = inst(2);
            addGrouped(f0, 'cam1', iA);   // track A (0), identity 10
            addGrouped(f0, 'cam1', iC);   // track C (2), identity 11
            setIdentity(s, 0, 'cam1', 0, 10);
            setIdentity(s, 0, 'cam1', 2, 11);
            var grpA = { identityId: 10, instances: new Map([['cam1', iA]]) };
            s.instanceGroups.set(0, [grpA]);

            deleteTrackAt(s, 1);  // delete track B (1)

            // Lower track keeps its identity at the same index.
            assertEqual(iA.trackIdx, 0, 'track A index unchanged');
            assertEqual(s.getIdentityIdForTrack('cam1', 0, 0), 10, 'track A keeps identity 10');
            // Higher track shifted down — its identity follows the remap.
            assertEqual(iC.trackIdx, 1, 'track C shifted to 1');
            assertEqual(s.getIdentityIdForTrack('cam1', 1, 0), 11, 'shifted track keeps identity 11');
            // No stale entry left at the old index 2.
            assertEqual(s.getIdentityIdForTrack('cam1', 2, 0), null, 'old index 2 has no stale identity');
            // Group-level identity is untouched.
            assertEqual(grpA.identityId, 10, 'group.identityId preserved');
        });

        it('ungroups GroupedInstances that use the deleted track', function () {
            var s = makeSession();  // tracks A,B,C
            var f0 = addFrame(s, 0);
            var iB = inst(1), iC = inst(2);
            addGrouped(f0, 'cam1', iB);   // track B (1) — the deleted one
            addGrouped(f0, 'cam2', iC);   // track C (2)
            var grp = { identityId: 5, instances: new Map([['cam1', iB], ['cam2', iC]]) };
            s.instanceGroups.set(0, [grp]);

            deleteTrackAt(s, 1);  // delete track B (1)

            // The group used track B, so it is ungrouped entirely.
            assertEqual((s.instanceGroups.get(0) || []).length, 0, 'group dissolved');
            // Both members returned to the unlinked pool...
            assertTrue(f0.unlinkedInstances.get('cam1').some(function (u) { return u.instance === iB; }),
                'iB returned to unlinked pool');
            assertTrue(f0.unlinkedInstances.get('cam2').some(function (u) { return u.instance === iC; }),
                'iC returned to unlinked pool');
            // ...with the deleted track nulled and the higher track shifted down.
            assertEqual(iB.trackIdx, null, 'deleted-track member set to no track');
            assertEqual(iC.trackIdx, 1, 'higher-track member shifted down');
        });
    });

    describe('getTrackColor: robustness after delete', function () {
        it('returns a valid hex color for null / negative / out-of-range indices', function () {
            // Regression: deleting a track left instances at trackIdx -1, and
            // getTrackColor(-1) returned undefined -> hexToRgb(undefined) threw.
            var hex = /^#[0-9a-fA-F]{6}$/;
            assertTrue(hex.test(getTrackColor(0)), 'track 0 has a hex color');
            assertTrue(hex.test(getTrackColor(-1)), 'negative index still yields a hex color');
            assertTrue(hex.test(getTrackColor(null)), 'null index still yields a hex color');
            assertTrue(hex.test(getTrackColor(9999)), 'out-of-range index wraps to a hex color');
        });
    });

    describe('track-identity-ops: deleteIdentityAt', function () {
        it('ungroups groups carrying the id, clears the per-frame map, and splices', function () {
            var s = makeSession();
            var f0 = addFrame(s, 0);
            var iX = inst(0), iY = inst(1);
            addGrouped(f0, 'cam1', iX);
            addGrouped(f0, 'cam1', iY);
            // Two groups in frame 0: one with id 10, one with id 11.
            var gX = { identityId: 10, instances: new Map([['cam1', iX]]) };
            var gY = { identityId: 11, instances: new Map([['cam1', iY]]) };
            s.instanceGroups.set(0, [gX, gY]);
            // Per-frame map: some entries point at id 10, one at id 11.
            setIdentity(s, 0, 'cam1', 0, 10);
            setIdentity(s, 0, 'cam2', 0, 10);
            setIdentity(s, 0, 'cam1', 1, 11);
            s._hiddenIdentities.add('idX');

            var name = deleteIdentityAt(s, 0);  // delete idX (id 10)

            assertEqual(name, 'idX', 'returns deleted name');
            // The group carrying idX is UNGROUPED (removed from instanceGroups);
            // the group carrying idY is left intact.
            var remaining = s.instanceGroups.get(0) || [];
            assertEqual(remaining.indexOf(gX), -1, 'group carrying idX ungrouped');
            assertTrue(remaining.indexOf(gY) >= 0, 'group carrying idY remains grouped');
            assertEqual(gY.identityId, 11, 'group carrying idY untouched');
            // Its instance returned to the unlinked pool.
            assertTrue(f0.unlinkedInstances.get('cam1').some(function (u) { return u.instance === iX; }),
                'ungrouped idX instance returned to unlinked pool');
            assertEqual(s.identities.length, 1, 'idX spliced from identities');
            assertEqual(s.identities[0].id, 11, 'idY remains');
            // The per-frame map entries that pointed at id 10 are gone, so those
            // instances now resolve to "no identity".
            assertEqual(s.getIdentityIdForTrack('cam1', 0, 0), null, 'cam1 track0 now identity-less');
            assertEqual(s.getIdentityIdForTrack('cam2', 0, 0), null, 'cam2 track0 now identity-less');
            assertEqual(s.getIdentityIdForTrack('cam1', 1, 0), 11, 'idY mapping preserved');
            assertFalse(s._hiddenIdentities.has('idX'), 'hidden-identities entry dropped');
        });
    });
})();
