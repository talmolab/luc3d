(function () {
    const { describe, it, assertEqual, assertNotNull, assertTrue, assertNull } = TestFramework;

    describe('Identity', function () {
        it('creates with id, name, and color', function () {
            var id = new Identity(0, 'mouse_A', '#ff6b6b');
            assertEqual(id.id, 0);
            assertEqual(id.name, 'mouse_A');
            assertEqual(id.color, '#ff6b6b');
        });

        it('auto-assigns color from palette if not provided', function () {
            var id = new Identity(2, 'track_2');
            assertNotNull(id.color);
            assertTrue(id.color.length > 0);
        });
    });

    describe('InstanceGroup identityId', function () {
        it('defaults to -1 (unassigned)', function () {
            var group = new InstanceGroup(1, 0);
            assertEqual(group.identityId, -1);
        });

        it('can be set after construction', function () {
            var group = new InstanceGroup(1, 0);
            group.identityId = 2;
            assertEqual(group.identityId, 2);
        });

        it('trackIdx and identityId are independent', function () {
            var group = new InstanceGroup(1, 0);
            group.identityId = 5;
            assertEqual(group.trackIdx, 0);
            assertEqual(group.identityId, 5);
        });
    });

    describe('Session identity management', function () {
        it('starts with empty identities and trustTracks false', function () {
            var s = new Session([], new Skeleton('s', ['a'], []), ['t0']);
            assertEqual(s.identities.length, 0);
            assertEqual(s.trustTracks, false);
        });

        it('addIdentity creates and returns an Identity', function () {
            var s = new Session([], new Skeleton('s', ['a'], []), ['t0']);
            var id = s.addIdentity('mouse_A');
            assertEqual(id.name, 'mouse_A');
            assertEqual(s.identities.length, 1);
            assertEqual(s.identities[0], id);
        });

        it('addIdentity auto-increments id', function () {
            var s = new Session([], new Skeleton('s', ['a'], []), ['t0']);
            var id0 = s.addIdentity('A');
            var id1 = s.addIdentity('B');
            assertTrue(id0.id !== id1.id);
        });

        it('getIdentity returns by id', function () {
            var s = new Session([], new Skeleton('s', ['a'], []), ['t0']);
            var id = s.addIdentity('mouse_A');
            var found = s.getIdentity(id.id);
            assertEqual(found, id);
        });

        it('getIdentity returns null for unknown id', function () {
            var s = new Session([], new Skeleton('s', ['a'], []), ['t0']);
            assertNull(s.getIdentity(999));
        });

        it('getOrCreateIdentityForTrack creates identity matching track name', function () {
            var s = new Session([], new Skeleton('s', ['a'], []), ['track_0', 'track_1']);
            var id = s.getOrCreateIdentityForTrack(0);
            assertEqual(id.name, 'track_0');
            var id2 = s.getOrCreateIdentityForTrack(0);
            assertEqual(id, id2);
        });

        it('assignIdentityToGroup sets identityId on group', function () {
            var s = new Session([], new Skeleton('s', ['a'], []), ['t0']);
            var id = s.addIdentity('mouse_A');
            var group = new InstanceGroup(1, 0);
            s.assignIdentityToGroup(group, id.id);
            assertEqual(group.identityId, id.id);
        });
    });

    describe('Identity serialization', function () {
        it('round-trips through plain object', function () {
            var original = new Identity(3, 'fly_B', '#4ecdc4');
            var data = { id: original.id, name: original.name, color: original.color };
            var restored = new Identity(data.id, data.name, data.color);
            assertEqual(restored.id, 3);
            assertEqual(restored.name, 'fly_B');
            assertEqual(restored.color, '#4ecdc4');
        });

        it('identityId persists on InstanceGroup serialization', function () {
            var group = new InstanceGroup(1, 0);
            group.identityId = 5;
            var data = { identityId: group.identityId };
            var restored = new InstanceGroup(1, 0);
            if (data.identityId != null) restored.identityId = data.identityId;
            assertEqual(restored.identityId, 5);
        });
    });

    describe('Track swap logic', function () {
        it('swaps trackIdx between two tracks', function () {
            var fg = new FrameGroup(0);
            var instA = new Instance([[10, 20]], 0, 'predicted');
            var instB = new Instance([[30, 40]], 1, 'predicted');
            fg.addInstance('CamA', instA);
            fg.addInstance('CamA', instB);

            // Swap track 0 <-> track 1
            var instances = fg.getInstances('CamA');
            for (var i = 0; i < instances.length; i++) {
                if (instances[i].trackIdx === 0) instances[i].trackIdx = -99;
                else if (instances[i].trackIdx === 1) instances[i].trackIdx = 0;
            }
            for (var i = 0; i < instances.length; i++) {
                if (instances[i].trackIdx === -99) instances[i].trackIdx = 1;
            }

            assertEqual(instA.trackIdx, 1);
            assertEqual(instB.trackIdx, 0);
        });
    });

    describe('Identity color resolution', function () {
        it('getGroupColor uses identity color when assigned', function () {
            var s = new Session([], new Skeleton('s', ['a'], []), ['t0']);
            var id = s.addIdentity('mouse_A', '#ff0000');
            var group = new InstanceGroup(1, 0);
            s.assignIdentityToGroup(group, id.id);
            var color = getGroupColor(group, s);
            assertEqual(color, '#ff0000');
        });

        it('getGroupColor falls back to track color when unassigned', function () {
            var group = new InstanceGroup(1, 0);
            var color = getGroupColor(group, null);
            assertEqual(color, getTrackColor(0));
        });
    });
})();
