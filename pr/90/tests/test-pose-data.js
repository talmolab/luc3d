/**
 * test-pose-data.js - Unit tests for pose-data.js
 */

(function () {
    const { describe, it, beforeEach, assertEqual, assertDeepEqual, assertNotNull,
        assertNull, assertTrue, assertFalse, assertGreaterThan } = TestFramework;

    // ---- Skeleton ----

    describe('Skeleton', function () {
        it('constructor sets name, nodes, edges', function () {
            const sk = new Skeleton('test', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            assertEqual(sk.name, 'test');
            assertEqual(sk.nodes.length, 3);
            assertEqual(sk.edges.length, 2);
        });

        it('defaultMouse creates 6 nodes and 5 edges', function () {
            const sk = Skeleton.defaultMouse();
            assertEqual(sk.nodes.length, 6);
            assertEqual(sk.edges.length, 5);
            assertEqual(sk.name, 'mouse');
        });

        it('addNode appends and returns index', function () {
            const sk = new Skeleton('t', ['a', 'b'], []);
            const idx = sk.addNode('c');
            assertEqual(idx, 2);
            assertEqual(sk.nodes.length, 3);
            assertEqual(sk.nodes[2], 'c');
        });

        it('removeNode splices node and adjusts edges', function () {
            const sk = new Skeleton('t', ['a', 'b', 'c'], [[0, 1], [1, 2], [0, 2]]);
            const removed = sk.removeNode(1); // remove 'b'
            assertEqual(removed, 'b');
            assertEqual(sk.nodes.length, 2);
            assertDeepEqual(sk.nodes, ['a', 'c']);
            // Edge [0,1] and [1,2] referenced node 1 -> removed
            // Edge [0,2] -> [0,1] (index 2 shifted to 1)
            assertEqual(sk.edges.length, 1);
            assertDeepEqual(sk.edges[0], [0, 1]);
        });

        it('removeNode returns null for invalid index', function () {
            const sk = new Skeleton('t', ['a'], []);
            assertNull(sk.removeNode(-1));
            assertNull(sk.removeNode(5));
        });

        it('addEdge adds and returns true', function () {
            const sk = new Skeleton('t', ['a', 'b', 'c'], []);
            assertTrue(sk.addEdge(0, 1));
            assertEqual(sk.edges.length, 1);
            assertDeepEqual(sk.edges[0], [0, 1]);
        });

        it('addEdge rejects duplicate edges', function () {
            const sk = new Skeleton('t', ['a', 'b'], [[0, 1]]);
            assertFalse(sk.addEdge(0, 1));
            assertFalse(sk.addEdge(1, 0)); // reversed duplicate
            assertEqual(sk.edges.length, 1);
        });

        it('addEdge rejects self-loops', function () {
            const sk = new Skeleton('t', ['a', 'b'], []);
            assertFalse(sk.addEdge(0, 0));
        });

        it('addEdge rejects out of range indices', function () {
            const sk = new Skeleton('t', ['a', 'b'], []);
            assertFalse(sk.addEdge(-1, 0));
            assertFalse(sk.addEdge(0, 5));
        });

        it('removeEdge removes by index', function () {
            const sk = new Skeleton('t', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            assertTrue(sk.removeEdge(0));
            assertEqual(sk.edges.length, 1);
            assertDeepEqual(sk.edges[0], [1, 2]);
        });

        it('removeEdge returns false for invalid index', function () {
            const sk = new Skeleton('t', ['a'], []);
            assertFalse(sk.removeEdge(0));
            assertFalse(sk.removeEdge(-1));
        });
    });

    // ---- Camera ----

    describe('Camera', function () {
        it('constructor stores all parameters', function () {
            const cam = new Camera('test', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            assertEqual(cam.name, 'test');
            assertEqual(cam.size[0], 640);
            assertEqual(cam.size[1], 480);
        });

        it('rotationMatrix returns identity for zero rvec', function () {
            const cam = new Camera('t', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            const R = cam.rotationMatrix;
            assertEqual(R[0][0], 1);
            assertEqual(R[1][1], 1);
            assertEqual(R[2][2], 1);
            assertEqual(R[0][1], 0);
        });

        it('projectionMatrix is 3x4', function () {
            const cam = new Camera('t', [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0.1, 0.2, 0.3], [10, 20, 30], [640, 480]);
            const P = cam.projectionMatrix;
            assertEqual(P.length, 3);
            assertEqual(P[0].length, 4);
        });

        it('project returns 2D point', function () {
            const cam = new Camera('t', [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 100], [640, 480]);
            const pt = cam.project([0, 0, 0]);
            // Point at origin, camera at z=100 looking at origin
            assertEqual(pt.length, 2);
            // Should be finite numbers
            assertTrue(!isNaN(pt[0]));
            assertTrue(!isNaN(pt[1]));
        });
    });

    // ---- Instance ----

    describe('Instance', function () {
        it('constructor sets properties', function () {
            const inst = new Instance([[10, 20], null, [30, 40]], 0, 'predicted', 0.95);
            assertEqual(inst.points.length, 3);
            assertEqual(inst.trackIdx, 0);
            assertEqual(inst.type, 'predicted');
            assertEqual(inst.score, 0.95);
            assertFalse(inst.modified);
        });

        it('setPointVisible hides and restores', function () {
            const inst = new Instance([[10, 20], [30, 40]], 0, 'user', 1);
            inst.backupPoints();
            inst.setPointVisible(0, false);
            assertNull(inst.points[0]);
            inst.setPointVisible(0, true);
            assertDeepEqual(inst.points[0], [10, 20]);
        });

        it('backupPoints creates deep copy', function () {
            const inst = new Instance([[10, 20]], 0, 'user', 1);
            inst.backupPoints();
            inst.points[0][0] = 999;
            assertEqual(inst._originalPoints[0][0], 10);
        });
    });

    // ---- FrameGroup ----

    describe('FrameGroup', function () {
        it('addInstance and getInstances work', function () {
            const fg = new FrameGroup(0);
            const inst = new Instance([[1, 2]], 0, 'user', 1);
            fg.addInstance('cam1', inst);
            assertEqual(fg.getInstances('cam1').length, 1);
            assertEqual(fg.getInstances('cam2').length, 0);
        });

        it('addUnlinkedInstance and getUnlinkedInstances work', function () {
            const fg = new FrameGroup(0);
            const inst = new Instance([[1, 2]], 0, 'predicted', 0.9);
            const ul = new UnlinkedInstance(inst, 'cam1');
            fg.addUnlinkedInstance('cam1', ul);
            assertEqual(fg.getUnlinkedInstances('cam1').length, 1);
        });

        it('removeUnlinkedById removes correct instance', function () {
            const fg = new FrameGroup(0);
            const i1 = new Instance([[1, 2]], 0, 'predicted', 0.9);
            const i2 = new Instance([[3, 4]], 0, 'predicted', 0.8);
            const u1 = new UnlinkedInstance(i1, 'cam1');
            const u2 = new UnlinkedInstance(i2, 'cam1');
            fg.addUnlinkedInstance('cam1', u1);
            fg.addUnlinkedInstance('cam1', u2);

            const removed = fg.removeUnlinkedById(u1.id);
            assertEqual(removed.id, u1.id);
            assertEqual(fg.getUnlinkedInstances('cam1').length, 1);
            assertEqual(fg.getUnlinkedInstances('cam1')[0].id, u2.id);
        });
    });

    // ---- InstanceGroup ----

    describe('InstanceGroup', function () {
        it('addInstance and getInstance work', function () {
            const group = new InstanceGroup(1, 0);
            const inst = new Instance([[10, 20]], 0, 'user', 1);
            group.addInstance('cam1', inst);
            assertEqual(group.getInstance('cam1'), inst);
            assertEqual(group.getInstance('cam2'), undefined);
        });

        it('cameraNames returns correct list', function () {
            const group = new InstanceGroup(1, 0);
            group.addInstance('cam1', new Instance([], 0, 'user', 1));
            group.addInstance('cam2', new Instance([], 0, 'user', 1));
            const names = group.cameraNames;
            assertEqual(names.length, 2);
            assertTrue(names.indexOf('cam1') >= 0);
            assertTrue(names.indexOf('cam2') >= 0);
        });

        it('dirty flag management', function () {
            const group = new InstanceGroup(1, 0);
            assertFalse(group.dirty);
            group.markDirty();
            assertTrue(group.dirty);
            group.markClean();
            assertFalse(group.dirty);
        });
    });

    // ---- Session ----

    describe('Session', function () {
        let session;

        beforeEach(function () {
            const cameras = [
                new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
                new Camera('cam2', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            const skeleton = new Skeleton('test', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            session = new Session(cameras, skeleton, ['track_0', 'track_1']);
        });

        it('constructor sets properties', function () {
            assertEqual(session.cameras.length, 2);
            assertEqual(session.skeleton.name, 'test');
            assertEqual(session.tracks.length, 2);
        });

        it('addFrameGroup and getFrameGroup work', function () {
            const fg = new FrameGroup(5);
            session.addFrameGroup(fg);
            assertEqual(session.getFrameGroup(5), fg);
            assertEqual(session.getFrameGroup(99), undefined);
        });

        it('frameIndices returns sorted list', function () {
            session.addFrameGroup(new FrameGroup(10));
            session.addFrameGroup(new FrameGroup(3));
            session.addFrameGroup(new FrameGroup(7));
            assertDeepEqual(session.frameIndices, [3, 7, 10]);
        });

        it('addNewInstance creates and stores instance', function () {
            const inst = session.addNewInstance(0, 'cam1', session.skeleton, 0);
            assertNotNull(inst);
            assertEqual(inst.points.length, 3); // 3 nodes
            assertEqual(inst.type, 'user');
            assertTrue(inst.modified);
            assertEqual(session.getFrameGroup(0).getInstances('cam1').length, 1);
        });

        it('removeInstanceGroup removes group and its instances', function () {
            // Create a group with instances
            const fg = new FrameGroup(0);
            session.addFrameGroup(fg);

            const inst1 = new Instance([[1, 2], [3, 4], null], 0, 'user', 1);
            const inst2 = new Instance([[5, 6], null, [7, 8]], 0, 'user', 1);
            const group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst1);
            group.addInstance('cam2', inst2);
            fg.addInstance('cam1', inst1);
            fg.addInstance('cam2', inst2);

            // Store in instanceGroups
            session.instanceGroups.set(0, [group]);

            // Verify setup
            assertEqual(session.getInstanceGroupsForFrame(0).length, 1);
            assertEqual(fg.getInstances('cam1').length, 1);
            assertEqual(fg.getInstances('cam2').length, 1);

            // Delete
            const removed = session.removeInstanceGroup(0, group);
            assertTrue(removed);
            assertEqual(session.getInstanceGroupsForFrame(0).length, 0);
            assertEqual(fg.getInstances('cam1').length, 0);
            assertEqual(fg.getInstances('cam2').length, 0);
        });

        it('removeInstanceGroup cleans up empty structures', function () {
            const fg = new FrameGroup(0);
            session.addFrameGroup(fg);
            const inst = new Instance([[1, 2], null, null], 0, 'user', 1);
            const group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst);
            fg.addInstance('cam1', inst);
            session.instanceGroups.set(0, [group]);

            session.removeInstanceGroup(0, group);
            // Empty frame group should be cleaned up
            assertFalse(session.instanceGroups.has(0));
        });

        it('propagateNodeAdded extends all instance points', function () {
            const inst = session.addNewInstance(0, 'cam1', session.skeleton, 0);
            assertEqual(inst.points.length, 3);
            session.skeleton.addNode('new_node');
            session.propagateNodeAdded();
            assertEqual(inst.points.length, 4);
            assertNull(inst.points[3]);
        });

        it('propagateNodeRemoved splices all instance points', function () {
            const inst = session.addNewInstance(0, 'cam1', session.skeleton, 0);
            inst.points[0] = [10, 20];
            inst.points[1] = [30, 40];
            inst.points[2] = [50, 60];
            session.skeleton.removeNode(1); // removes 'b'
            session.propagateNodeRemoved(1);
            assertEqual(inst.points.length, 2);
            assertDeepEqual(inst.points[0], [10, 20]);
            assertDeepEqual(inst.points[1], [50, 60]);
        });

        it('createGroupFromUnlinked creates a group', function () {
            const fg = new FrameGroup(0);
            session.addFrameGroup(fg);

            const inst1 = new Instance([[1, 2], null, null], 0, 'predicted', 0.9);
            const ul1 = new UnlinkedInstance(inst1, 'cam1');
            fg.addUnlinkedInstance('cam1', ul1);

            const inst2 = new Instance([[3, 4], null, null], 0, 'predicted', 0.8);
            const ul2 = new UnlinkedInstance(inst2, 'cam2');
            fg.addUnlinkedInstance('cam2', ul2);

            const group = session.createGroupFromUnlinked(0, [ul1, ul2]);
            assertNotNull(group);
            assertEqual(group.cameraNames.length, 2);
            assertEqual(fg.getUnlinkedInstances('cam1').length, 0);
            assertEqual(fg.getUnlinkedInstances('cam2').length, 0);
        });
    });

    // ---- clonePoints ----

    describe('clonePoints', function () {
        it('deep clones point arrays', function () {
            const original = [[10, 20], null, [30, 40]];
            const cloned = clonePoints(original);
            assertEqual(cloned.length, 3);
            assertDeepEqual(cloned[0], [10, 20]);
            assertNull(cloned[1]);
            // Verify deep copy
            cloned[0][0] = 999;
            assertEqual(original[0][0], 10);
        });

        it('returns null for null input', function () {
            assertNull(clonePoints(null));
        });
    });

    // ---- Identity uniqueness invariant ----
    //
    // At most one trackIdx per camera per FRAME may resolve to a given
    // identity. Across frames, multiple trackIdx values may share an
    // identity (legitimate "tracklet stitching" use case). Regression:
    // propagateIdentity used to overwrite per-frame overrides without
    // checking for colliders, causing two distinct instances in the same
    // view at the same frame to render as the same identity.

    describe('Session.propagateIdentity — per-frame per-camera uniqueness', function () {
        function buildSession() {
            const sk = new Skeleton('test', ['a'], []);
            const cam = new Camera('cam0', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            const session = new Session([cam], sk, ['t0', 't1'], 'S');
            session.addIdentity('id_A'); // 1
            session.addIdentity('id_B'); // 2
            // Two instances per frame on cam0: trackIdx 0 and trackIdx 1.
            // Frame 50 and 100 both have both tracks present.
            for (const fi of [50, 100]) {
                const fg = new FrameGroup(fi);
                fg.addInstance('cam0', new Instance([[0, 0]], 0, 'user', 0));
                fg.addInstance('cam0', new Instance([[1, 1]], 1, 'user', 0));
                session.frameGroups.set(fi, fg);
            }
            return session;
        }

        it('swaps colliders per-frame instead of duplicating identities', function () {
            const session = buildSession();
            // Initial state: globally t0 → A, t1 → B
            session.assignTrackToIdentity(0, 1, 'cam0');
            session.assignTrackToIdentity(1, 2, 'cam0');
            // User now decides at frame 50 onwards, t0 should be B
            session.propagateIdentity(50, 'cam0', 0, 2);
            // For frame 50 and 100, both trackIdx 0 and 1 must have UNIQUE
            // identities. The propagation must have swapped t1 → A per-frame.
            for (const fi of [50, 100]) {
                const id0 = session.getIdentityIdForTrack('cam0', 0, fi);
                const id1 = session.getIdentityIdForTrack('cam0', 1, fi);
                assertEqual(id0, 2); // B
                assertEqual(id1, 1); // A — swapped, not duplicated
                assertTrue(id0 !== id1);
            }
        });

        it('past frames (< startFrame) are untouched', function () {
            const session = buildSession();
            // Add frame 10 (before propagation start)
            const fg10 = new FrameGroup(10);
            fg10.addInstance('cam0', new Instance([[0, 0]], 0, 'user', 0));
            fg10.addInstance('cam0', new Instance([[1, 1]], 1, 'user', 0));
            session.frameGroups.set(10, fg10);

            session.assignTrackToIdentity(0, 1, 'cam0');
            session.assignTrackToIdentity(1, 2, 'cam0');
            session.propagateIdentity(50, 'cam0', 0, 2);

            // Frame 10 has no per-frame override — falls back to global.
            // Note: the global also got swapped (by our caller's assignTrackToIdentity
            // step in real usage), so this test isolates propagateIdentity by
            // checking that it didn't write any frameIdentityMap entry for fi < 50.
            assertFalse(session.frameIdentityMap.has('10:cam0:0'));
            assertFalse(session.frameIdentityMap.has('10:cam0:1'));
        });

        it('does nothing for frames where the trackIdx is absent', function () {
            const session = buildSession();
            // Frame 200: only trackIdx 0 present (trackIdx 1 absent)
            const fg200 = new FrameGroup(200);
            fg200.addInstance('cam0', new Instance([[0, 0]], 0, 'user', 0));
            session.frameGroups.set(200, fg200);

            session.assignTrackToIdentity(0, 1, 'cam0');
            session.assignTrackToIdentity(1, 2, 'cam0');
            session.propagateIdentity(50, 'cam0', 0, 2);

            // Frame 200: t0 written (B), but t1 doesn't exist there
            // so no per-frame override is created for it.
            assertEqual(session.frameIdentityMap.get('200:cam0:0'), 2);
            assertFalse(session.frameIdentityMap.has('200:cam0:1'));
        });

        it('returns the count of frames updated', function () {
            const session = buildSession();
            session.assignTrackToIdentity(0, 1, 'cam0');
            const count = session.propagateIdentity(50, 'cam0', 0, 2);
            assertEqual(count, 2); // frames 50 and 100
        });
    });

    describe('Session.assignIdentityToGroup — per-frame group uniqueness', function () {
        function buildSessionWithGroups() {
            const sk = new Skeleton('test', ['a'], []);
            const cam = new Camera('cam0', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            const session = new Session([cam], sk, ['t0', 't1'], 'S');
            session.addIdentity('id_A'); // 1
            session.addIdentity('id_B'); // 2
            // Two groups in frame 100, distinct identities to start.
            const fg = new FrameGroup(100);
            session.frameGroups.set(100, fg);
            const gA = new InstanceGroup(1, 1); // identityId = id_A
            const gB = new InstanceGroup(2, 2); // identityId = id_B
            session.instanceGroups.set(100, [gA, gB]);
            return { session, gA, gB };
        }

        it('swaps when assigning an identity already held by a sibling group', function () {
            const { session, gA, gB } = buildSessionWithGroups();
            // Move gA from id_A → id_B. gB should swap to id_A.
            session.assignIdentityToGroup(gA, 2);
            assertEqual(gA.identityId, 2);
            assertEqual(gB.identityId, 1);
        });

        it('clears the colliding group to -1 if `group` had no prior identity', function () {
            const { session, gB } = buildSessionWithGroups();
            const gNew = new InstanceGroup(3, -1);
            session.instanceGroups.get(100).push(gNew);
            // gNew has identityId=-1; assign it id_B (already held by gB)
            session.assignIdentityToGroup(gNew, 2);
            assertEqual(gNew.identityId, 2);
            assertEqual(gB.identityId, -1);
        });

        it('is a no-op when the identity is already set', function () {
            const { session, gA } = buildSessionWithGroups();
            session.assignIdentityToGroup(gA, 1);
            assertEqual(gA.identityId, 1);
        });

        it('does not affect groups in other frames', function () {
            const { session, gA } = buildSessionWithGroups();
            // A group in a different frame with id_B should not be touched.
            const fg2 = new FrameGroup(200);
            session.frameGroups.set(200, fg2);
            const gFar = new InstanceGroup(99, 2); // also id_B
            session.instanceGroups.set(200, [gFar]);
            session.assignIdentityToGroup(gA, 2);
            assertEqual(gA.identityId, 2);
            assertEqual(gFar.identityId, 2); // untouched (different frame)
        });

        it('handles identityId = -1 (clearing) without firing the swap path', function () {
            const { session, gA, gB } = buildSessionWithGroups();
            session.assignIdentityToGroup(gA, -1);
            assertEqual(gA.identityId, -1);
            assertEqual(gB.identityId, 2); // unchanged
        });
    });

    describe('Session.deduplicateFrameIdentities — repair existing data', function () {
        it('clears identityId on duplicate holders, keeping the first', function () {
            const sk = new Skeleton('test', ['a'], []);
            const cam = new Camera('cam0', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            const session = new Session([cam], sk, ['t0'], 'S');
            const fg = new FrameGroup(50);
            session.frameGroups.set(50, fg);
            const g1 = new InstanceGroup(1, 5);
            const g2 = new InstanceGroup(2, 5); // duplicate
            const g3 = new InstanceGroup(3, 7);
            const g4 = new InstanceGroup(4, 5); // also duplicate
            session.instanceGroups.set(50, [g1, g2, g3, g4]);

            const cleared = session.deduplicateFrameIdentities();
            assertEqual(cleared, 2);
            assertEqual(g1.identityId, 5); // kept (first)
            assertEqual(g2.identityId, -1); // cleared
            assertEqual(g3.identityId, 7); // kept
            assertEqual(g4.identityId, -1); // cleared
        });

        it('leaves identityId=-1 groups alone', function () {
            const sk = new Skeleton('test', ['a'], []);
            const cam = new Camera('cam0', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            const session = new Session([cam], sk, ['t0'], 'S');
            const fg = new FrameGroup(50);
            session.frameGroups.set(50, fg);
            const g1 = new InstanceGroup(1, -1);
            const g2 = new InstanceGroup(2, -1);
            session.instanceGroups.set(50, [g1, g2]);

            const cleared = session.deduplicateFrameIdentities();
            assertEqual(cleared, 0);
            assertEqual(g1.identityId, -1);
            assertEqual(g2.identityId, -1);
        });

        it('treats different frames independently', function () {
            const sk = new Skeleton('test', ['a'], []);
            const cam = new Camera('cam0', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            const session = new Session([cam], sk, ['t0'], 'S');
            session.frameGroups.set(10, new FrameGroup(10));
            session.frameGroups.set(20, new FrameGroup(20));
            const a1 = new InstanceGroup(1, 5);
            const b1 = new InstanceGroup(2, 5); // OK — different frame
            session.instanceGroups.set(10, [a1]);
            session.instanceGroups.set(20, [b1]);

            const cleared = session.deduplicateFrameIdentities();
            assertEqual(cleared, 0);
            assertEqual(a1.identityId, 5);
            assertEqual(b1.identityId, 5);
        });
    });

    describe('Session.scrubOrphanInstances — repair linked-but-ungrouped', function () {
        function buildEnv() {
            const sk = new Skeleton('test', ['a'], []);
            const cam = new Camera('cam0', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            const session = new Session([cam], sk, ['t0'], 'S');
            const fg = new FrameGroup(50);
            session.frameGroups.set(50, fg);
            return { session, fg };
        }

        it('moves orphan instances (in fg.instances, not in any group) to unlinked', function () {
            const { session, fg } = buildEnv();
            // Two instances on cam0; only one is in a group.
            const grouped = new Instance([[1, 1]], 0, 'user', 0);
            const orphan = new Instance([[2, 2]], 1, 'predicted', 0.5);
            fg.addInstance('cam0', grouped);
            fg.addInstance('cam0', orphan);
            const g = new InstanceGroup(1, -1);
            g.addInstance('cam0', grouped);
            session.instanceGroups.set(50, [g]);

            assertEqual(fg.getInstances('cam0').length, 2);
            assertEqual((fg.getUnlinkedInstances('cam0') || []).length, 0);

            const moved = session.scrubOrphanInstances();
            assertEqual(moved, 1);
            // Grouped instance stays in fg.instances; orphan moved to unlinked.
            assertEqual(fg.getInstances('cam0').length, 1);
            assertEqual(fg.getInstances('cam0')[0], grouped);
            assertEqual(fg.getUnlinkedInstances('cam0').length, 1);
            assertEqual(fg.getUnlinkedInstances('cam0')[0].instance, orphan);
        });

        it('leaves a healthy frame untouched', function () {
            const { session, fg } = buildEnv();
            const grouped = new Instance([[1, 1]], 0, 'user', 0);
            fg.addInstance('cam0', grouped);
            const g = new InstanceGroup(1, -1);
            g.addInstance('cam0', grouped);
            session.instanceGroups.set(50, [g]);

            const moved = session.scrubOrphanInstances();
            assertEqual(moved, 0);
            assertEqual(fg.getInstances('cam0').length, 1);
            assertEqual((fg.getUnlinkedInstances('cam0') || []).length, 0);
        });

        it('does not double-list an instance already present in unlinked', function () {
            const { session, fg } = buildEnv();
            const dup = new Instance([[3, 3]], 2, 'predicted', 0.7);
            fg.addInstance('cam0', dup); // also in fg.instances...
            fg.addUnlinkedInstance('cam0', new UnlinkedInstance(dup, 'cam0')); // ...AND in unlinked
            session.instanceGroups.set(50, []);

            assertEqual(fg.getInstances('cam0').length, 1);
            assertEqual(fg.getUnlinkedInstances('cam0').length, 1);

            const moved = session.scrubOrphanInstances();
            // Already in unlinked — don't add again. Just remove from
            // fg.instances so it stops being double-counted by the viewer.
            assertEqual(moved, 0);
            assertEqual(fg.getInstances('cam0').length, 0);
            assertEqual(fg.getUnlinkedInstances('cam0').length, 1);
        });

        it('handles multiple frames + cameras independently', function () {
            const sk = new Skeleton('test', ['a'], []);
            const camA = new Camera('cam0', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            const camB = new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            const session = new Session([camA, camB], sk, ['t0'], 'S');

            const fg10 = new FrameGroup(10);
            session.frameGroups.set(10, fg10);
            const orphanA = new Instance([[1, 1]], 0, 'predicted', 0);
            fg10.addInstance('cam0', orphanA);
            session.instanceGroups.set(10, []);

            const fg20 = new FrameGroup(20);
            session.frameGroups.set(20, fg20);
            const groupedB = new Instance([[2, 2]], 0, 'user', 0);
            const orphanB = new Instance([[3, 3]], 1, 'predicted', 0);
            fg20.addInstance('cam1', groupedB);
            fg20.addInstance('cam1', orphanB);
            const g20 = new InstanceGroup(1, -1);
            g20.addInstance('cam1', groupedB);
            session.instanceGroups.set(20, [g20]);

            const moved = session.scrubOrphanInstances();
            assertEqual(moved, 2); // one in each frame

            assertEqual(fg10.getInstances('cam0').length, 0);
            assertEqual(fg10.getUnlinkedInstances('cam0').length, 1);

            assertEqual(fg20.getInstances('cam1').length, 1);
            assertEqual(fg20.getInstances('cam1')[0], groupedB);
            assertEqual(fg20.getUnlinkedInstances('cam1').length, 1);
            assertEqual(fg20.getUnlinkedInstances('cam1')[0].instance, orphanB);
        });
    });
})();
