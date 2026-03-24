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
