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
            assertEqual(inst.numNodes, 3);
            assertEqual(inst.trackIdx, 0);
            assertEqual(inst.type, 'predicted');
            assertEqual(inst.score, 0.95);
            assertFalse(inst.modified);
        });

        it('setPointVisible hides and restores', function () {
            const inst = new Instance([[10, 20], [30, 40]], 0, 'user', 1);
            inst.backupPoints();
            inst.setPointVisible(0, false);
            assertNull(inst.getPoint(0));
            inst.setPointVisible(0, true);
            assertDeepEqual(inst.getPoint(0), [10, 20]);
        });

        it('backupPoints creates a deep copy', function () {
            const inst = new Instance([[10, 20]], 0, 'user', 1);
            inst.backupPoints();
            inst.setPoint(0, 999, 20);
            assertEqual(inst.getX(0), 999, 'live value moved');
            inst.restorePoints();
            assertEqual(inst.getX(0), 10, 'backup was an independent copy');
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
            assertEqual(inst.numNodes, 3); // 3 nodes
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
            assertEqual(inst.numNodes, 3);
            session.skeleton.addNode('new_node');
            session.propagateNodeAdded();
            assertEqual(inst.numNodes, 4);
            assertNull(inst.getPoint(3));
        });

        it('propagateNodeRemoved splices all instance points', function () {
            const inst = session.addNewInstance(0, 'cam1', session.skeleton, 0);
            inst.setPoint(0, 10, 20);
            inst.setPoint(1, 30, 40);
            inst.setPoint(2, 50, 60);
            session.skeleton.removeNode(1); // removes 'b'
            session.propagateNodeRemoved(1);
            assertEqual(inst.numNodes, 2);
            assertDeepEqual(inst.getPoint(0), [10, 20]);
            assertDeepEqual(inst.getPoint(1), [50, 60]);
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

            session.propagateIdentity(50, 'cam0', 0, 2);

            // propagateIdentity starts at frame 50, so it must not write any
            // per-frame entry for the earlier frame 10.
            assertFalse(session.hasFrameIdentity(10, 'cam0', 0));
            assertFalse(session.hasFrameIdentity(10, 'cam0', 1));
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
            assertEqual(session.getFrameIdentityValue(200, 'cam0', 0), 2);
            assertFalse(session.hasFrameIdentity(200, 'cam0', 1));
        });

        it('returns the count of frames updated', function () {
            const session = buildSession();
            session.assignTrackToIdentity(0, 1, 'cam0');
            const count = session.propagateIdentity(50, 'cam0', 0, 2);
            assertEqual(count, 2); // frames 50 and 100
        });

        // RESIDENT-ONLY REGRESSION (the luc3d #194/#195 class). Assigning an
        // identity in the info panel propagates it forward via this method, which
        // walked `session.frameGroups` — the RESIDENT window (31 of 180,210 on the
        // real project). So on a reopened project "propagate forward" silently
        // stopped at the edge of the current window: nothing corrupted, almost
        // nothing done. It now also sweeps the columnar store's track column.
        it('propagates to NON-RESIDENT frames via the lazy store', function () {
            const session = buildSession();          // resident: frames 50, 100
            session.assignTrackToIdentity(0, 1, 'cam0');
            session.assignTrackToIdentity(1, 2, 'cam0');
            // `assignTrackToIdentity` is itself resident-only, so it wrote nothing
            // for frame 4000. Set that frame's per-frame state explicitly: t0 → A,
            // t1 → B, so propagating B onto t0 there is a genuine collider.
            session.setFrameIdentity(4000, 'cam0', 0, 1);
            session.setFrameIdentity(4000, 'cam0', 1, 2);
            // The store knows about far more frames than are resident, including
            // frames before startFrame and a trackless row.
            const rows = [
                ['cam0', 10, 0], ['cam0', 10, 1],       // before startFrame — untouched
                ['cam0', 50, 0], ['cam0', 50, 1],       // resident — handled by the resident pass
                ['cam0', 4000, 0], ['cam0', 4000, 1],   // non-resident, collider present
                ['cam0', 4001, 0],                      // non-resident, no collider
                ['cam0', 4002, -1],                     // trackless only — track absent
                ['cam1', 4003, 0],                      // another camera — must be ignored
            ];
            session.lazyLoader = {
                forEachInstanceRow: function (visitFn) {
                    rows.forEach(function (r) { visitFn(r[0], r[1], r[2]); });
                },
            };

            const count = session.propagateIdentity(50, 'cam0', 0, 2);

            assertEqual(session.getIdentityIdForTrack('cam0', 0, 4000), 2,
                'non-resident frame got the new identity');
            assertEqual(session.getIdentityIdForTrack('cam0', 1, 4000), 1,
                'collider on a non-resident frame was swapped, not duplicated');
            assertEqual(session.getIdentityIdForTrack('cam0', 0, 4001), 2,
                'non-resident frame with no collider got the new identity');
            assertFalse(session.hasFrameIdentity(4002, 'cam0', 0),
                'a frame where the track is absent is not written');
            assertFalse(session.hasFrameIdentity(4003, 'cam1', 0),
                'another camera is never touched');
            assertFalse(session.hasFrameIdentity(10, 'cam0', 0),
                'store frames before startFrame stay untouched');
            assertEqual(count, 4, 'counts resident (50, 100) and non-resident (4000, 4001) frames once each');
        });

        it('resident state wins over the store for a frame that is both', function () {
            // A resident frame can carry in-memory edits and unlinked instances the
            // store does not know about, so the store pass must not re-derive it.
            // Here the store claims frame 100 has only track 0, while the resident
            // FrameGroup has both — the collider swap must still happen.
            const session = buildSession();
            session.assignTrackToIdentity(0, 1, 'cam0');
            session.assignTrackToIdentity(1, 2, 'cam0');
            session.lazyLoader = {
                forEachInstanceRow: function (visitFn) { visitFn('cam0', 100, 0); },
            };

            session.propagateIdentity(50, 'cam0', 0, 2);

            assertEqual(session.getIdentityIdForTrack('cam0', 0, 100), 2);
            assertEqual(session.getIdentityIdForTrack('cam0', 1, 100), 1,
                'the resident view of frame 100 drove the collider swap');
        });
    });

    describe('Session.propagateIdentitiesToTracks — null IDs → null tracks', function () {
        function buildSession() {
            const sk = new Skeleton('test', ['a'], []);
            const cam = new Camera('cam0', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            const session = new Session([cam], sk, ['t0', 't1'], 'S');
            // Identity ids come from a module-global counter, so capture the id.
            session._idA = session.addIdentity('id_A');
            const fg = new FrameGroup(50);
            fg.addInstance('cam0', new Instance([[0, 0]], 0, 'user', 0)); // track 0
            fg.addInstance('cam0', new Instance([[1, 1]], 1, 'user', 0)); // track 1
            session.frameGroups.set(50, fg);
            return session;
        }

        it('explicit "no identity" propagates to a null (trackless) track, not a "No ID" track', function () {
            const session = buildSession();
            session.setFrameIdentity(50, 'cam0', 0, session._idA.id);  // track 0 → id_A
            session.setFrameIdentity(50, 'cam0', 1, -1);  // track 1 → explicit none
            assertTrue(session.isExplicitNoIdentity('cam0', 1, 50), 'precondition: track1 is explicit-none');

            const res = session.propagateIdentitiesToTracks();

            // Exactly one track (id_A). No dedicated "No ID" track is created.
            assertEqual(res.tracks, 1, 'one track (id_A) only');
            assertEqual(session.tracks.length, 1, 'tracks list has a single entry');
            assertEqual(session.tracks.indexOf(NO_ID_TRACK_NAME), -1, 'no "No ID" track created');
            assertEqual(session.tracks[0], 'id_A', 'the one track is the used identity');

            const insts = session.frameGroups.get(50).instances.get('cam0');
            const idA = insts.find(function (i) { return i.trackIdx === 0; });
            const none = insts.find(function (i) { return i.trackIdx == null; });
            assertTrue(!!idA, 'identified instance keeps a real track (idx 0)');
            assertTrue(!!none, 'explicit-none instance becomes trackless (null)');
        });

        it('instances with no identity entry at all also become trackless', function () {
            const session = buildSession();
            session.setFrameIdentity(50, 'cam0', 0, session._idA.id);  // track 0 → id_A
            // track 1: no frameIdentityMap entry at all.

            session.propagateIdentitiesToTracks();

            const insts = session.frameGroups.get(50).instances.get('cam0');
            const none = insts.find(function (i) { return i.trackIdx == null; });
            assertTrue(!!none, 'unidentified instance becomes trackless (null)');
            assertEqual(session.tracks.indexOf(NO_ID_TRACK_NAME), -1, 'still no "No ID" track');
        });
    });

    describe('Session.propagateIdentitiesToTracks — whole-project correctness under lazy eviction', function () {
        // Regression for the "ID view goes gray after Propagate IDs -> Tracks"
        // bug on large lazy-loaded sessions: frameIdentityMap is the single,
        // always-resident, WHOLE-PROJECT identity record (Track All writes it
        // for every frame it processes; nothing ever evicts it). `frameGroups`,
        // by contrast, is only a resident window on a lazy session — most
        // frames are evicted/never-visited. The old implementation derived its
        // replacement frameIdentityMap ONLY from a `frameGroups` walk, so
        // committing it silently destroyed identity data for every frame
        // outside whatever was resident at click time.
        function buildSession() {
            const sk = new Skeleton('test', ['a'], []);
            const cam = new Camera('cam0', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            return new Session([cam], sk, ['t0', 't1'], 'S');
        }

        it('does not destroy identity data for frames absent from frameGroups (simulated eviction)', function () {
            const session = buildSession();
            const idA = session.addIdentity('Alice');
            const idB = session.addIdentity('Bob');

            // Frame 50 is "resident" (has a real FrameGroup/Instance).
            const fg50 = new FrameGroup(50);
            fg50.addInstance('cam0', new Instance([[0, 0]], 0, 'user', 0));  // track 0
            session.frameGroups.set(50, fg50);
            session.setFrameIdentity(50, 'cam0', 0, idA.id);

            // Frame 90000 is "evicted" — identity was assigned when it WAS
            // resident (e.g. during Track All), but nothing keeps a lazy
            // session's predicted-only FrameGroup around forever, so by the
            // time the user clicks Propagate, frame 90000 has no FrameGroup at
            // all. Only frameIdentityMap remembers it.
            session.setFrameIdentity(90000, 'cam0', 1, idB.id);
            assertFalse(session.frameGroups.has(90000), 'precondition: frame 90000 is NOT resident');

            const res = session.propagateIdentitiesToTracks();

            assertEqual(res.tracks, 2, 'both used identities become tracks');
            assertEqual(session.frameIdentityMap.size, 2,
                'frameIdentityMap still has an entry for BOTH frames, not just the resident one');

            const aliceTrack = session.tracks.indexOf('Alice');
            const bobTrack = session.tracks.indexOf('Bob');
            assertTrue(aliceTrack >= 0 && bobTrack >= 0, 'both identity names became track names');
            assertEqual(session.getFrameIdentityValue(90000, 'cam0', bobTrack), idB.id,
                'the evicted frame\'s identity survives, remapped to its new trackIdx');
            assertEqual(session.getFrameIdentityValue(50, 'cam0', aliceTrack), idA.id,
                'the resident frame\'s identity also survives, remapped consistently');

            // Resident instance gets its live trackIdx updated too (GUI feedback).
            const inst = session.frameGroups.get(50).instances.get('cam0')[0];
            assertEqual(inst.trackIdx, aliceTrack, 'resident instance trackIdx mutated to match its identity');
        });

        it('delegates a project-wide columnar remap to a lazy loader when present', function () {
            const session = buildSession();
            const idA = session.addIdentity('Alice');
            session.setFrameIdentity(90000, 'cam0', 3, idA.id);  // frame never resident at all

            const calls = [];
            session.lazyLoader = {
                remapTracksFromIdentity: function (newTrackNames, remapFn) {
                    calls.push(newTrackNames.slice());
                    // Exercise remapFn the way SioLazyLoader would: one row,
                    // camera cam0, frame 90000, old track 3. Compare against
                    // newTrackNames (not session.tracks — that only commits
                    // AFTER this call returns, in step 5).
                    const newTrk = remapFn('cam0', 90000, 3);
                    assertEqual(newTrk, newTrackNames.indexOf('Alice'),
                        'remapFn resolves the evicted frame\'s new track from identity alone');
                    // Real SioLazyLoader.remapTracksFromIdentity returns
                    // {changed, errorRows, firstError}, not a bare number (see
                    // its diagnostic note — surfacing row-level failures
                    // instead of silently swallowing them).
                    return { changed: 1, errorRows: 0, firstError: null };
                },
            };

            const res = session.propagateIdentitiesToTracks();
            assertEqual(calls.length, 1, 'lazyLoader.remapTracksFromIdentity was invoked exactly once');
            assertDeepEqual(calls[0], ['Alice'], 'lazy loader gets the same new-track-names list as session.tracks');
            assertEqual(res.instances, 1, 'lazy-remapped row count is folded into the returned instance count');
            assertEqual(res.lazyErrorRows, 0, 'no row errors reported');
        });

        it('surfaces lazyLoader row-remap errors instead of silently swallowing them', function () {
            // Regression for "export only has tracks on the first frame(s)":
            // if remapTracksFromIdentity fails partway through the columnar
            // store (any reason), that must be visible on the result, not
            // just quietly absorbed while the live session already looks
            // fully correct (frameIdentityMap/instanceGroups/resident
            // trackIdx are all fixed up BEFORE this call, in steps 1-3b).
            const session = buildSession();
            const idA = session.addIdentity('Alice');
            session.setFrameIdentity(50, 'cam0', 0, idA.id);

            session.lazyLoader = {
                remapTracksFromIdentity: function () {
                    return { changed: 3, errorRows: 41, firstError: new Error('boom') };
                },
            };

            const res = session.propagateIdentitiesToTracks();
            assertEqual(res.lazyErrorRows, 41, 'row-error count from the lazy loader is passed through, not dropped');
            assertEqual(res.instances, 3, 'changed count still folds in normally alongside the error count');
        });

        it('back-compat: a lazyLoader.remapTracksFromIdentity returning a bare number still works', function () {
            const session = buildSession();
            const idA = session.addIdentity('Alice');
            session.setFrameIdentity(50, 'cam0', 0, idA.id);
            session.lazyLoader = { remapTracksFromIdentity: function () { return 7; } };

            const res = session.propagateIdentitiesToTracks();
            assertEqual(res.lazyErrorRows, 0, 'no error count available from a bare-number return — defaults to 0');
        });

        it('remaps session.instanceGroups member trackIdx project-wide, not just resident frameGroups', function () {
            // Regression for "2D viewer updates but 3D viewport/Timeline/info
            // panel stay stale after Propagate IDs -> Tracks": on a lazy
            // session, instanceGroups is populated PROJECT-WIDE at reopen with
            // its OWN lightweight per-camera Instance members — separate
            // objects from whatever's in frameGroups until that frame is
            // scrubbed to (and even then, hydration never refreshes trackIdx).
            // The 3D viewport, info panel, and Timeline's instanceGroups scan
            // all read trackIdx off THESE objects, so leaving them stale after
            // session.tracks is replaced with a new (shorter) list points them
            // at wrong/out-of-range tracks.
            const session = buildSession();
            const idB = session.addIdentity('Bob');

            // Frame 90000 has NO FrameGroup at all (never materialized) — only
            // an instanceGroups entry, exactly the lazy "reopened but not
            // scrubbed to" shape.
            const group = new InstanceGroup(1, -1);
            const member = new Instance([[3, 3]], 1, 'predicted', 0.9);  // OLD track 1
            group.addInstance('cam0', member);
            session.instanceGroups.set(90000, [group]);
            session.setFrameIdentity(90000, 'cam0', 1, idB.id);
            assertFalse(session.frameGroups.has(90000), 'precondition: frame 90000 is NOT resident');

            session.propagateIdentitiesToTracks();

            const bobTrack = session.tracks.indexOf('Bob');
            assertTrue(bobTrack >= 0, 'Bob became a track');
            assertEqual(member.trackIdx, bobTrack,
                'the instanceGroups member (never touched by the frameGroups walk) got remapped too');
        });

        it('replaces an auto-generated "id_N" identity name with the app\'s track_N convention; custom names survive', function () {
            // Regression: propagating IDs -> Tracks after a prior Tracks -> IDs
            // pass (which names identities "id_<n>" via getOrCreateIdentityForTrack)
            // used to carry that literal "id_N" string over as the new track
            // name — so a round trip renamed track_0/track_1 to id_0/id_1
            // instead of restoring the app's normal track_N naming. A
            // genuinely custom identity name (e.g. "Alice") must still be
            // preserved verbatim.
            const session = buildSession();
            const idAuto = session.addIdentity('id_7');   // mimics getOrCreateIdentityForTrack's placeholder
            const idCustom = session.addIdentity('Alice');
            session.setFrameIdentity(10, 'cam0', 0, idAuto.id);
            session.setFrameIdentity(10, 'cam0', 1, idCustom.id);

            session.propagateIdentitiesToTracks();

            assertEqual(session.tracks.indexOf('id_7'), -1, 'the placeholder "id_7" name is NOT carried over literally');
            assertTrue(session.tracks.some(function (t) { return /^track_\d+$/.test(t); }),
                'the auto-named identity falls back to the track_N convention');
            assertTrue(session.tracks.indexOf('Alice') >= 0, 'a genuinely custom identity name is preserved');
        });
    });

    describe('Session.propagateIdentitiesToTracks — single-view ID switch (duplicate-ID regression)', function () {
        // A single-view ID switch (luc3d #201: ungroup, switch the ID on that
        // view's Ungrouped row) swaps identity VALUES in frameIdentityMap for
        // that camera only, and deliberately leaves InstanceGroup.identityId
        // alone — it is one field shared by every view. So after the switch the
        // map and the group field DISAGREE in that camera, by design, and every
        // display consumer resolves map-first with the group as fallback
        // (getGroupColor). Propagate IDs -> Tracks must use the same precedence:
        // its group-first repairs for the raw-track-collision case (#183's
        // instanceToIdentity, #204's rowClaim) resurrected the stale group
        // identity on the still-grouped animal while the switched instance
        // correctly followed the map — the SAME ID/track landing on both
        // animals on the switch frame, in memory and in the columnar store.
        function buildSwitchedSession() {
            const sk = new Skeleton('test', ['a'], []);
            const cam0 = new Camera('cam0', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            const cam1 = new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            const session = new Session([cam0, cam1], sk, ['t0', 't1'], 'S');
            const idA = session.addIdentity('Alice');
            const idB = session.addIdentity('Bob');
            const fg = new FrameGroup(50);
            session.frameGroups.set(50, fg);
            // Animal 1: the row being corrected — ungrouped on cam0, raw track 0.
            const inst1 = new Instance([[0, 0]], 0, 'user', 0);
            session.addUnlinkedInstance(50, 'cam0', inst1);
            // Animal 2: still grouped cross-view (identity Bob), raw track 1 on cam0.
            const inst2 = new Instance([[1, 1]], 1, 'user', 0);
            inst2._rawInstIndex = 1;   // its row offset in the columnar store
            const inst2cam1 = new Instance([[2, 2]], 0, 'user', 0);
            const gB = new InstanceGroup(1, idB.id);
            gB.addInstance('cam0', inst2);
            gB.addInstance('cam1', inst2cam1);
            fg.addInstance('cam0', inst2);
            fg.addInstance('cam1', inst2cam1);
            session.instanceGroups.set(50, [gB]);
            // Pre-switch identity state: cam0 t0 -> Alice, t1 -> Bob.
            session.setFrameIdentity(50, 'cam0', 0, idA.id);
            session.setFrameIdentity(50, 'cam0', 1, idB.id);
            session.setFrameIdentity(50, 'cam1', 0, idB.id);
            // The correction: on cam0 only, animal 1 is really Bob. Map now
            // reads t0 -> Bob, t1 -> Alice; gB.identityId stays Bob (correct —
            // the switch must not leak into cam1).
            session.swapIdentitiesForwardInCamera(50, 'cam0', idA.id, idB.id);
            return { session, idA, idB, inst1, inst2, inst2cam1, gB };
        }

        it('the switch frame\'s two animals get DIFFERENT tracks, each following the map (in-memory)', function () {
            const { session, idA, idB, inst1, inst2, inst2cam1 } = buildSwitchedSession();
            assertEqual(session.getIdentityIdForTrack('cam0', 0, 50), idB.id, 'precondition: t0 reads Bob after the switch');
            assertEqual(session.getIdentityIdForTrack('cam0', 1, 50), idA.id, 'precondition: t1 reads Alice after the switch');

            session.propagateIdentitiesToTracks();

            const aliceTrack = session.tracks.indexOf('Alice');
            const bobTrack = session.tracks.indexOf('Bob');
            assertTrue(aliceTrack >= 0 && bobTrack >= 0, 'both identities became tracks');
            assertEqual(inst1.trackIdx, bobTrack, 'the switched (ungrouped) instance follows the map -> Bob');
            assertEqual(inst2.trackIdx, aliceTrack,
                'the still-grouped instance follows the map (Alice), not its stale group.identityId (Bob)');
            assertTrue(inst1.trackIdx !== inst2.trackIdx,
                'one ID must not be duplicated onto both animals on the switch frame');
            assertEqual(inst2cam1.trackIdx, bobTrack, 'the un-switched camera still reads Bob');
        });

        it('the columnar-store remap agrees: rowClaim must not resurrect the pre-switch identity', function () {
            const { session, idA } = buildSwitchedSession();
            let capturedRemapFn = null, capturedTracks = null;
            session.lazyLoader = {
                remapTracksFromIdentity: function (newTrackNames, remapFn) {
                    capturedTracks = newTrackNames.slice();
                    capturedRemapFn = remapFn;
                    return { changed: 0, errorRows: 0, firstError: null };
                },
            };

            session.propagateIdentitiesToTracks();

            const aliceTrack = capturedTracks.indexOf('Alice');
            const bobTrack = capturedTracks.indexOf('Bob');
            // Row 0 = the switched instance (old track 0), row 1 = the grouped
            // one (old track 1, _rawInstIndex 1).
            assertEqual(capturedRemapFn('cam0', 50, 0, 0), bobTrack,
                'store row of the switched instance follows the map -> Bob');
            assertEqual(capturedRemapFn('cam0', 50, 1, 1), aliceTrack,
                'store row of the still-grouped instance follows the map (Alice) — rowClaim must not override it with the stale group identity');
            // Sanity for the identical duplicate the store used to get.
            assertTrue(capturedRemapFn('cam0', 50, 0, 0) !== capturedRemapFn('cam0', 50, 1, 1),
                'the two store rows must not land on one track');
        });

        it('the #183/#204 collision repair still works: an absent/-1 map entry falls back to the group', function () {
            const { session, idA } = buildSwitchedSession();
            // Frame 60: a raw-tracker collision frame — the map entry for this
            // (frame, cam, track) was marked -1/ambiguous by commitTrackedFrame's
            // writtenThisFrame guard, so the GROUP is the only usable source.
            const inst3 = new Instance([[3, 3]], 0, 'user', 0);
            inst3._rawInstIndex = 0;
            const gC = new InstanceGroup(2, idA.id);
            gC.addInstance('cam0', inst3);
            const fg60 = new FrameGroup(60);
            fg60.addInstance('cam0', inst3);
            session.frameGroups.set(60, fg60);
            session.instanceGroups.set(60, [gC]);
            session.setFrameIdentity(60, 'cam0', 0, -1);

            let capturedRemapFn = null, capturedTracks = null;
            session.lazyLoader = {
                remapTracksFromIdentity: function (newTrackNames, remapFn) {
                    capturedTracks = newTrackNames.slice();
                    capturedRemapFn = remapFn;
                    return { changed: 0, errorRows: 0, firstError: null };
                },
            };

            session.propagateIdentitiesToTracks();

            const aliceTrack = session.tracks.indexOf('Alice');
            assertEqual(inst3.trackIdx, aliceTrack,
                'in-memory: the -1-marked instance resolves via its group identity');
            assertEqual(capturedRemapFn('cam0', 60, 0, 0), capturedTracks.indexOf('Alice'),
                'store: the -1-marked row resolves via rowClaim from its group identity');
        });
    });

    describe('Session.propagateTracksToIdentities — lazy sessions', function () {
        it('sweeps a lazy loader for instances outside frameGroups', function () {
            const sk = new Skeleton('test', ['a'], []);
            const cam = new Camera('cam0', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            const session = new Session([cam], sk, ['t0', 't1'], 'S');

            const rows = [
                ['cam0', 90000, 0],
                ['cam0', 90001, 1],
                ['cam0', 90002, -1],  // trackless — must be skipped
            ];
            session.lazyLoader = {
                forEachInstanceRow: function (visitFn) {
                    rows.forEach(function (r) { visitFn(r[0], r[1], r[2]); });
                },
            };

            const res = session.propagateTracksToIdentities();

            assertEqual(session.getIdentityIdForTrack('cam0', 0, 90000), session.getOrCreateIdentityForTrack(0).id,
                'evicted frame 90000 got its identity stamped from the lazy sweep');
            assertEqual(session.getIdentityIdForTrack('cam0', 1, 90001), session.getOrCreateIdentityForTrack(1).id,
                'evicted frame 90001 got its identity stamped from the lazy sweep');
            assertFalse(session.hasFrameIdentity(90002, 'cam0', -1), 'trackless row produces no identity entry');
        });

        it('aligns instanceGroups.identityId across many frames without O(frames^2) blowup (freeze regression)', function () {
            // Regression: the "Align grouped frames' group.identityId" pass
            // at the end of propagateTracksToIdentities walks EVERY frame of
            // session.instanceGroups (project-wide on a lazy session, not
            // just the resident frameGroups window) and used to call
            // assignIdentityToGroup(group, id) with no frame hint — which
            // itself re-derives the host frame by scanning ALL of
            // instanceGroups per call. Doing that once per group while
            // already iterating every frame is O(frames^2); this test builds
            // enough frames that the fix must still complete correctly (and
            // fast) with NO frameGroups populated at all — the exact lazy
            // "instanceGroups populated, frameGroups mostly empty" shape.
            const sk = new Skeleton('test', ['a'], []);
            const cam = new Camera('cam0', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            const session = new Session([cam], sk, [], 'S');

            const N_FRAMES = 300;
            let nextGroupId = 1;
            for (let f = 0; f < N_FRAMES; f++) {
                const gEven = new InstanceGroup(nextGroupId++, -1);
                gEven.addInstance('cam0', new Instance([[1, 1]], 0, 'predicted', 0.9));   // track 0
                const gOdd = new InstanceGroup(nextGroupId++, -1);
                gOdd.addInstance('cam0', new Instance([[2, 2]], 1, 'predicted', 0.9));    // track 1
                session.instanceGroups.set(f, [gEven, gOdd]);
            }
            assertEqual(session.frameGroups.size, 0, 'precondition: frameGroups is empty (nothing materialized)');

            const res = session.propagateTracksToIdentities();

            const idTrack0 = session.getOrCreateIdentityForTrack(0).id;
            const idTrack1 = session.getOrCreateIdentityForTrack(1).id;
            assertEqual(res.identities, 2, 'exactly 2 identities created (one per distinct track)');
            for (let f = 0; f < N_FRAMES; f++) {
                const [gEven, gOdd] = session.instanceGroups.get(f);
                assertEqual(gEven.identityId, idTrack0, 'frame ' + f + ' track-0 group aligned to its track\'s identity');
                assertEqual(gOdd.identityId, idTrack1, 'frame ' + f + ' track-1 group aligned to its track\'s identity');
            }
        });

        it('does not create a duplicate identity per repeated row for the same track (freeze regression)', function () {
            // Regression for "Propagate Tracks -> IDs freezes on a large
            // heavily-tracked project": getOrCreateIdentityForTrack does a
            // LINEAR SCAN over session.identities. Before the fix, the lazy
            // sweep called it once per INSTANCE ROW — with many distinct
            // tracks repeated across many frames that's O(rows x identities).
            // This drives many rows per track through the sweep and asserts
            // exactly one identity gets created per distinct track (proving
            // the memoized lookup still finds/reuses the same identity
            // instead of scanning-and-recreating), not a timing assertion
            // (unreliable in CI) — the fix's complexity change is what
            // eliminates the freeze, not something a small unit test can
            // directly clock.
            const sk = new Skeleton('test', ['a'], []);
            const cam = new Camera('cam0', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            const session = new Session([cam], sk, [], 'S');

            const N_TRACKS = 50, REPEATS_PER_TRACK = 20;
            const rows = [];
            let frameIdx = 0;
            for (let t = 0; t < N_TRACKS; t++) {
                for (let r = 0; r < REPEATS_PER_TRACK; r++) {
                    rows.push(['cam0', frameIdx++, t]);
                }
            }
            session.lazyLoader = {
                forEachInstanceRow: function (visitFn) {
                    rows.forEach(function (row) { visitFn(row[0], row[1], row[2]); });
                },
            };

            const res = session.propagateTracksToIdentities();

            assertEqual(session.identities.length, N_TRACKS,
                'exactly one identity per distinct track, not one per row (' + rows.length + ' rows)');
            assertEqual(res.identities, N_TRACKS, 'returned identity count matches');
            // Every row's frame got the SAME identity as every other row for
            // that track (not a fresh/duplicate identity per occurrence).
            for (let t = 0; t < N_TRACKS; t++) {
                const expectedId = session.getOrCreateIdentityForTrack(t).id;
                for (let r = 0; r < REPEATS_PER_TRACK; r++) {
                    const f = t * REPEATS_PER_TRACK + r;
                    assertEqual(session.getIdentityIdForTrack('cam0', t, f), expectedId,
                        'track ' + t + ' frame ' + f + ' stamped with its track\'s single identity');
                }
            }
        });
    });

    describe('Session.createGroupFromUnlinked — trackless grouping', function () {
        function build() {
            const sk = new Skeleton('test', ['a'], []);
            const camA = new Camera('camA', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            const camB = new Camera('camB', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
            return new Session([camA, camB], sk, ['t0'], 'S');
        }

        it('grouping trackless instances yields a group with NO identity (-1), not id_null', function () {
            const session = build();
            const idsBefore = session.identities.length;
            // Two unlinked instances with NULL tracks.
            const ulA = session.addUnlinkedInstance(0, 'camA', new Instance([[0, 0]], null, 'user', 0));
            const ulB = session.addUnlinkedInstance(0, 'camB', new Instance([[1, 1]], null, 'user', 0));

            const group = session.createGroupFromUnlinked(0, [ulA, ulB]);

            assertEqual(group.identityId, -1, 'group has no identity');
            assertEqual(session.identities.length, idsBefore, 'no "id_null" identity fabricated');
            // Members stay trackless.
            assertNull(group.instances.get('camA').trackIdx, 'camA member stays trackless');
            assertNull(group.instances.get('camB').trackIdx, 'camB member stays trackless');
        });

        it('grouping tracked instances still derives identity from the first track', function () {
            const session = build();
            const ulA = session.addUnlinkedInstance(0, 'camA', new Instance([[0, 0]], 0, 'user', 0));
            const ulB = session.addUnlinkedInstance(0, 'camB', new Instance([[1, 1]], 0, 'user', 0));

            const group = session.createGroupFromUnlinked(0, [ulA, ulB]);

            assertTrue(group.identityId >= 0, 'group gets a real identity from track 0');
            assertEqual(session.getIdentity(group.identityId).name, 'id_0', 'identity is id_0');
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

        it('passing hostFrameIdx explicitly (propagate\'s fast path) matches the fallback-search behavior', function () {
            // Regression for the O(frames^2) freeze: propagateTracksToIdentities
            // now passes the already-known frameIdx as a 3rd arg instead of
            // making assignIdentityToGroup re-derive it by scanning ALL of
            // instanceGroups. Same swap/collision scenario as "swaps when
            // assigning an identity already held by a sibling group" above,
            // but with the frame passed explicitly — must produce the
            // identical outcome.
            const { session, gA, gB } = buildSessionWithGroups();
            session.assignIdentityToGroup(gA, 2, 100);   // 100 = the real host frame
            assertEqual(gA.identityId, 2);
            assertEqual(gB.identityId, 1, 'swap still fires correctly with an explicit hostFrameIdx');
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

    // ---- Per-session track independence ----

    describe('Session tracks are per-session (no shared array)', function () {
        // NOTE: instantiate inside each it() — the bridged globals (Skeleton,
        // Session) are assigned by a deferred module script that runs AFTER this
        // classic test script loads, so describe-body construction would throw.
        it('constructor copies the tracks array so sessions never share it', function () {
            const sk = new Skeleton('m', ['a', 'b'], []);
            const shared = ['track_0', 'track_1'];
            const s1 = new Session([], sk, shared);
            const s2 = new Session([], sk, shared);
            assertFalse(s1.tracks === s2.tracks, 'each session has its own array');
            assertFalse(s1.tracks === shared, 'session does not alias the source array');
            // Mutating one session's tracks leaves the other (and the source) intact.
            s1.tracks.push('track_2');
            assertEqual(s2.tracks.length, 2);
            assertEqual(shared.length, 2);
        });

        it('deleteTrackAt on one session does not affect another', function () {
            const sk = new Skeleton('m', ['a', 'b'], []);
            const src = ['back', 'left', 'right'];
            const s1 = new Session([], sk, src);
            const s2 = new Session([], sk, src);
            const removed = deleteTrackAt(s1, 1); // delete 'left' from s1 only
            assertEqual(removed, 'left');
            assertDeepEqual(s1.tracks, ['back', 'right']);
            assertDeepEqual(s2.tracks, ['back', 'left', 'right']);
        });

        it('adding/renaming a track in one session leaves the other unchanged', function () {
            const sk = new Skeleton('m', ['a', 'b'], []);
            const src = ['t0', 't1'];
            const s1 = new Session([], sk, src);
            const s2 = new Session([], sk, src);
            s1.tracks.push('t2');
            s1.tracks[0] = 'renamed';
            assertDeepEqual(s2.tracks, ['t0', 't1']);
        });
    });

    // ---- Skeleton.compatibilityKey (instance copy/paste) ----

    describe('Skeleton.compatibilityKey', function () {
        it('is identical for skeletons with the same names and edges', function () {
            const a = new Skeleton('a', ['head', 'thorax', 'abdomen'], [[0, 1], [1, 2]]);
            const b = new Skeleton('b', ['head', 'thorax', 'abdomen'], [[0, 1], [1, 2]]);
            assertEqual(a.compatibilityKey(), b.compatibilityKey());
        });

        it('ignores node ordering as long as names and edges match', function () {
            // Same shape, different node order: edges reference the same NAME pairs.
            const a = new Skeleton('a', ['head', 'thorax', 'abdomen'], [[0, 1], [1, 2]]);
            // order: abdomen, head, thorax → edges head-thorax [1,2], thorax-abdomen [2,0]
            const b = new Skeleton('b', ['abdomen', 'head', 'thorax'], [[1, 2], [2, 0]]);
            assertEqual(a.compatibilityKey(), b.compatibilityKey());
        });

        it('treats edges as undirected (source/target swap is equal)', function () {
            const a = new Skeleton('a', ['x', 'y'], [[0, 1]]);
            const b = new Skeleton('b', ['x', 'y'], [[1, 0]]);
            assertEqual(a.compatibilityKey(), b.compatibilityKey());
        });

        it('differs when node names differ', function () {
            const a = new Skeleton('a', ['head', 'thorax'], [[0, 1]]);
            const b = new Skeleton('b', ['head', 'tail'], [[0, 1]]);
            assertTrue(a.compatibilityKey() !== b.compatibilityKey());
        });

        it('differs when edges differ', function () {
            const a = new Skeleton('a', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            const b = new Skeleton('b', ['a', 'b', 'c'], [[0, 1]]);
            assertTrue(a.compatibilityKey() !== b.compatibilityKey());
        });

        it('differs when an edge connects a different pair of the same names', function () {
            const a = new Skeleton('a', ['a', 'b', 'c'], [[0, 1]]); // a-b
            const b = new Skeleton('b', ['a', 'b', 'c'], [[0, 2]]); // a-c
            assertTrue(a.compatibilityKey() !== b.compatibilityKey());
        });
    });

    describe('One skeleton per project (app-state)', function () {
        function cam(name) {
            return new Camera(name, [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]);
        }

        it('setProjectSkeleton shares ONE skeleton object across all sessions', function () {
            var sk = new Skeleton('proj', ['a', 'b'], [[0, 1]]);
            var s1 = new Session([cam('c')], new Skeleton('s1', [], []), ['t0']);
            var s2 = new Session([cam('c')], new Skeleton('s2', ['x'], []), ['t0']);
            var savedSessions = state.sessions, savedSession = state.session;
            try {
                state.sessions = [s1, s2];
                state.session = s1;
                setProjectSkeleton(sk);
                assertTrue(s1.skeleton === sk, 'session 1 points at the project skeleton');
                assertTrue(s2.skeleton === sk, 'session 2 points at the SAME object');
                assertTrue(getProjectSkeleton() === sk, 'getProjectSkeleton returns it');
                // New sessions inherit the shared reference (not an independent clone).
                assertTrue(buildRememberedSkeleton() === sk, 'buildRememberedSkeleton returns the shared object');
                // Editing the shared skeleton is visible in every session (one object).
                sk.addNode('c');
                assertEqual(s1.skeleton.nodes.length, 3);
                assertEqual(s2.skeleton.nodes.length, 3, 'skeleton edits propagate to all sessions');
            } finally {
                state.sessions = savedSessions;
                state.session = savedSession;
            }
        });
    });

    // ---- Instance flat coordinate storage ----
    //
    // `Instance` stores 2D keypoints in a flat Float64Array(2n) with NaN = no
    // point, and occlusion in a bit set. The public `points`/`occluded` fields
    // are GONE on purpose (a missed call site must throw, not silently read a
    // doubled length or an undefined occlusion flag), so these pin the accessor
    // contract that replaced them.

    describe('Instance flat coordinate storage', function () {
        it('constructs from the legacy boxed shape', function () {
            var i = new Instance([[1, 2], null, [5, 6]], 0, 'user', 1);
            assertEqual(i.numNodes, 3, 'numNodes is NODES, not 2*nodes');
            assertTrue(i.hasPoint(0));
            assertFalse(i.hasPoint(1), 'a null row becomes "no point"');
            assertTrue(i.hasPoint(2));
            assertDeepEqual(i.getPoint(0), [1, 2]);
            assertNull(i.getPoint(1));
            assertEqual(i.getX(2), 5);
            assertEqual(i.getY(2), 6);
        });

        it('adopts an already-flat Float64Array without copying', function () {
            var xy = new Float64Array([1, 2, 3, 4]);
            var i = new Instance(xy, 0, 'user', 1);
            assertEqual(i.numNodes, 2);
            assertDeepEqual(i.getPoint(1), [3, 4]);
            xy[0] = 99;
            assertEqual(i.getX(0), 99, 'adopted by reference, not copied');
        });

        it('round-trips through the boxed form', function () {
            var boxed = [[1.5, 2.5], null, [-3, 0]];
            assertDeepEqual(new Instance(boxed, 0, 'user', 1).toPointsArray(), boxed);
        });

        it('keeps full f64 precision', function () {
            var v = 0.1 + 0.2;                 // not representable in f32
            var i = new Instance([[v, 12345678.90123456]], 0, 'user', 1);
            assertTrue(i.getX(0) === v, 'x exact');
            assertTrue(i.getY(0) === 12345678.90123456, 'y exact');
        });

        it('set / clear a point', function () {
            var i = new Instance([[1, 2], [3, 4]], 0, 'user', 1);
            i.setPoint(0, 9, 8);
            assertDeepEqual(i.getPoint(0), [9, 8]);
            i.clearPoint(0);
            assertFalse(i.hasPoint(0));
            assertNull(i.getPoint(0));
            i.setPointFrom(0, [7, 7]);
            assertDeepEqual(i.getPoint(0), [7, 7]);
            i.setPointFrom(0, null);
            assertFalse(i.hasPoint(0), 'setPointFrom(null) clears');
        });

        it('readPoint fills a caller buffer without allocating', function () {
            var i = new Instance([[1, 2], null], 0, 'user', 1);
            var out = [0, 0];
            assertTrue(i.readPoint(0, out) === out, 'returns the same buffer');
            assertDeepEqual(out, [1, 2]);
            assertNull(i.readPoint(1, out), 'missing node returns null');
        });

        it('counts and predicates', function () {
            var i = new Instance([[1, 2], null, [5, 6]], 0, 'user', 1);
            assertEqual(i.countPoints(), 2);
            assertTrue(i.hasAnyPoint());
            var empty = new Instance([null, null], 0, 'user', 1);
            assertEqual(empty.countPoints(), 0);
            assertFalse(empty.hasAnyPoint());
        });

        it('hasAnyUsablePoint honours nulledNodes', function () {
            var i = new Instance([[1, 2], [3, 4]], 0, 'user', 1);
            assertTrue(i.hasAnyUsablePoint());
            i.nulledNodes = new Set([0, 1]);
            assertFalse(i.hasAnyUsablePoint(), 'all positioned nodes are nulled');
            i.nulledNodes = new Set([0]);
            assertTrue(i.hasAnyUsablePoint(), 'node 1 still usable');
        });

        it('occlusion round-trips through the bit set', function () {
            var i = new Instance([[1, 2], [3, 4], [5, 6]], 0, 'user', 1);
            assertFalse(i.isOccluded(1));
            assertFalse(i.anyOccluded());
            i.setOccluded(1, true);
            assertTrue(i.isOccluded(1));
            assertFalse(i.isOccluded(0), 'neighbours unaffected');
            assertFalse(i.isOccluded(2));
            assertTrue(i.anyOccluded());
            assertDeepEqual(i.toOccludedArray(), [false, true, false]);
            i.setOccluded(1, false);
            assertFalse(i.anyOccluded());
        });

        it('occlusion works past 32 nodes (Uint32Array path)', function () {
            // <=32 nodes uses a Number bitmask; beyond that a Uint32Array. Bit 40
            // lands in the second word, which is where an off-by-one would show.
            var boxed = [];
            for (var k = 0; k < 50; k++) boxed.push([k, k]);
            var i = new Instance(boxed, 0, 'user', 1);
            assertEqual(i.numNodes, 50);
            i.setOccluded(40, true);
            i.setOccluded(3, true);
            assertTrue(i.isOccluded(40), 'bit in the second word');
            assertTrue(i.isOccluded(3), 'bit in the first word');
            assertFalse(i.isOccluded(41));
            assertFalse(i.isOccluded(39));
            assertEqual(i.toOccludedArray().filter(Boolean).length, 2);
        });

        it('setOccludedFrom ingests a boolean array', function () {
            var i = new Instance([[1, 2], [3, 4], [5, 6]], 0, 'user', 1);
            i.setOccludedFrom([false, true, true]);
            assertDeepEqual(i.toOccludedArray(), [false, true, true]);
            i.setOccludedFrom(null);
            assertFalse(i.anyOccluded(), 'null clears');
        });

        it('clearing a point clears its occlusion flag', function () {
            var i = new Instance([[1, 2]], 0, 'user', 1);
            i.setOccluded(0, true);
            i.clearPoint(0);
            assertFalse(i.isOccluded(0), 'an absent point cannot be occluded');
        });

        it('toggleOccluded only applies to positioned nodes', function () {
            var i = new Instance([[1, 2], null], 0, 'user', 1);
            i.toggleOccluded(0);
            assertTrue(i.isOccluded(0));
            i.toggleOccluded(1);
            assertFalse(i.isOccluded(1), 'no position => no toggle');
        });

        it('setPointsFrom replaces every coordinate', function () {
            var i = new Instance([[1, 2], [3, 4]], 0, 'user', 1);
            i.setPointsFrom([[9, 9], null]);
            assertDeepEqual(i.getPoint(0), [9, 9]);
            assertFalse(i.hasPoint(1));
        });

        it('adoptPointsFrom shares buffers (lazy-2D hydration)', function () {
            var a = new Instance([[1, 2]], 0, 'predicted', 1);
            var b = new Instance([null], 0, 'predicted', 1);
            b.adoptPointsFrom(a);
            assertDeepEqual(b.getPoint(0), [1, 2]);
            a.setPoint(0, 7, 7);
            assertDeepEqual(b.getPoint(0), [7, 7], 'shares the same buffer');
        });

        it('backup / restore covers coordinates AND occlusion', function () {
            var i = new Instance([[1, 2], [3, 4]], 0, 'user', 1);
            i.setOccluded(1, true);
            i.backupPoints();
            assertTrue(i.hasBackup());
            i.setPoint(0, 99, 99);
            i.setOccluded(1, false);
            i.restorePoints();
            assertDeepEqual(i.getPoint(0), [1, 2], 'coords restored');
            assertTrue(i.isOccluded(1), 'occlusion restored');
        });

        it('setPointVisible(false) clears, (true) restores from backup', function () {
            var i = new Instance([[1, 2], [3, 4]], 0, 'user', 1);
            i.backupPoints();
            i.setPointVisible(0, false);
            assertFalse(i.hasPoint(0));
            i.setPointVisible(0, true);
            assertDeepEqual(i.getPoint(0), [1, 2], 'restored from the backup');
        });

        it('insertNodeAt / removeNodeAt keep coords, occlusion and backup aligned', function () {
            var i = new Instance([[1, 1], [2, 2], [3, 3]], 0, 'user', 1);
            i.setOccluded(2, true);
            i.backupPoints();

            i.insertNodeAt(3);                       // append, as propagateNodeAdded does
            assertEqual(i.numNodes, 4);
            assertFalse(i.hasPoint(3), 'new node starts empty');
            assertTrue(i.isOccluded(2), 'existing occlusion survives');

            i.removeNodeAt(1);                       // drop the middle node
            assertEqual(i.numNodes, 3);
            assertDeepEqual(i.getPoint(0), [1, 1]);
            assertDeepEqual(i.getPoint(1), [3, 3], 'node 2 shifted down to 1');
            assertTrue(i.isOccluded(1), 'its occlusion bit shifted with it');
            assertFalse(i.hasPoint(2), 'the appended empty node is now last');

            i.restorePoints();
            assertEqual(i.numNodes, 3, 'backup was resized alongside');
        });

        it('out-of-range access is safe', function () {
            var i = new Instance([[1, 2]], 0, 'user', 1);
            assertFalse(i.hasPoint(5));
            assertNull(i.getPoint(5));
            assertFalse(i.isOccluded(5));
            i.setPoint(5, 1, 1);
            i.setOccluded(5, true);
            i.clearPoint(-1);
            assertEqual(i.numNodes, 1, 'no growth from out-of-range writes');
        });

        it('a zero-node instance is inert', function () {
            var i = new Instance([], 0, 'user', 1);
            assertEqual(i.numNodes, 0);
            assertFalse(i.hasAnyPoint());
            assertDeepEqual(i.toPointsArray(), []);
            assertDeepEqual(i.toOccludedArray(), []);
        });

        it('the removed fields really are gone (missed call sites must throw)', function () {
            var i = new Instance([[1, 2]], 0, 'user', 1);
            assertEqual(i.points, undefined, 'no `points` field');
            assertEqual(i.occluded, undefined, 'no `occluded` field');
        });
    });

    // ---- points3d flat-array codec ----
    //
    // `InstanceGroup.points3d` is a flat Float64Array(3*nNodes) with an all-NaN
    // triple for a missing node, replacing boxed `[x,y,z]|null` rows. These pin
    // the codec's edge cases: the NaN sentinel, partial-NaN triples, and the
    // dual-format ingest that keeps legacy readers/projects loading.

    describe('points3d codec', function () {
        it('makePoints3d allocates all-missing nodes', function () {
            var p = makePoints3d(4);
            assertTrue(p instanceof Float64Array, 'flat Float64Array');
            assertEqual(p.length, 12, '3 coords per node');
            assertEqual(points3dNodeCount(p), 4);
            assertFalse(someValidPoint3d(p), 'nothing triangulated yet');
            assertEqual(countPoints3d(p), 0);
        });

        it('set/get/clear round-trips a node', function () {
            var p = makePoints3d(3);
            setPoint3d(p, 1, [1.5, -2.25, 300.125]);
            assertTrue(hasPoint3d(p, 1));
            assertDeepEqual(getPoint3d(p, 1), [1.5, -2.25, 300.125]);
            assertNull(getPoint3d(p, 0), 'untouched node reads as missing');
            assertEqual(countPoints3d(p), 1);
            clearPoint3d(p, 1);
            assertNull(getPoint3d(p, 1), 'cleared node reads as missing');
            assertFalse(someValidPoint3d(p));
        });

        it('setPoint3d(null) marks a node missing', function () {
            var p = makePoints3d(2);
            setPoint3d(p, 0, [1, 2, 3]);
            setPoint3d(p, 0, null);
            assertFalse(hasPoint3d(p, 0));
        });

        it('preserves full f64 precision (bit-exact, so the golden digest holds)', function () {
            var p = makePoints3d(1);
            // A value that is NOT representable in f32 — would quantize if the
            // backing store were Float32Array.
            var v = 0.1 + 0.2; // 0.30000000000000004
            setPoint3d(p, 0, [v, 1e-300, 12345678.90123456]);
            var got = getPoint3d(p, 0);
            assertTrue(got[0] === v, 'x survives exactly');
            assertTrue(got[1] === 1e-300, 'denormal-ish y survives exactly');
            assertTrue(got[2] === 12345678.90123456, 'z survives exactly');
        });

        it('a partially-NaN triple counts as missing, not present', function () {
            // A node with a NaN in any coordinate has no meaningful 3D position;
            // treating it as present would push NaN geometry into the 3D view.
            var p = makePoints3d(1);
            p[0] = 1; p[1] = NaN; p[2] = 3;
            assertFalse(hasPoint3d(p, 0), 'NaN in y => missing');
            assertNull(getPoint3d(p, 0));
        });

        it('readPoint3d fills a caller buffer without allocating', function () {
            var p = makePoints3d(2);
            setPoint3d(p, 1, [7, 8, 9]);
            var out = [0, 0, 0];
            assertTrue(readPoint3d(p, 1, out) === out, 'returns the same buffer');
            assertDeepEqual(out, [7, 8, 9]);
            assertNull(readPoint3d(p, 0, out), 'missing node returns null');
        });

        it('toBoxedPoints3d emits the legacy [x,y,z]|null shape', function () {
            var p = makePoints3d(3);
            setPoint3d(p, 0, [1, 2, 3]);
            setPoint3d(p, 2, [4, 5, 6]);
            assertDeepEqual(toBoxedPoints3d(p), [[1, 2, 3], null, [4, 5, 6]]);
        });

        it('fromBoxedPoints3d ingests the legacy shape', function () {
            var p = fromBoxedPoints3d([[1, 2, 3], null, [4, 5, 6]]);
            assertTrue(p instanceof Float64Array);
            assertEqual(points3dNodeCount(p), 3);
            assertDeepEqual(getPoint3d(p, 0), [1, 2, 3]);
            assertNull(getPoint3d(p, 1));
            assertDeepEqual(getPoint3d(p, 2), [4, 5, 6]);
        });

        it('boxed -> flat -> boxed round-trips', function () {
            var boxed = [[1.25, 2.5, 3.75], null, [-4, 0, 6]];
            assertDeepEqual(toBoxedPoints3d(fromBoxedPoints3d(boxed)), boxed);
        });

        it('asPoints3d normalizes every ingest form', function () {
            var flat = makePoints3d(2);
            assertTrue(asPoints3d(flat) === flat, 'flat passes through WITHOUT copying');
            assertNull(asPoints3d(null));
            var fromBoxed = asPoints3d([[1, 2, 3]]);
            assertTrue(fromBoxed instanceof Float64Array, 'boxed rows convert');
            assertDeepEqual(getPoint3d(fromBoxed, 0), [1, 2, 3]);
            // A reader could hand back a different typed view (e.g. f32).
            var f32 = asPoints3d(new Float32Array([1, 2, 3]));
            assertTrue(f32 instanceof Float64Array, 'other typed views are widened');
            assertDeepEqual(getPoint3d(f32, 0), [1, 2, 3]);
        });

        it('an explicit NaN row ingests as missing (matches what SLP stores)', function () {
            // The SLP format writes NaN for missing 3D keypoints, so a reload has
            // always erased the null-vs-NaN distinction. Ingest must agree.
            var p = fromBoxedPoints3d([[NaN, NaN, NaN], [1, 2, 3]]);
            assertFalse(hasPoint3d(p, 0));
            assertTrue(hasPoint3d(p, 1));
            assertEqual(countPoints3d(p), 1);
        });

        it('clonePoints3d copies rather than aliases', function () {
            var p = makePoints3d(2);
            setPoint3d(p, 0, [1, 2, 3]);
            var c = clonePoints3d(p);
            setPoint3d(c, 0, [9, 9, 9]);
            assertDeepEqual(getPoint3d(p, 0), [1, 2, 3], 'original untouched');
            assertNull(clonePoints3d(null));
        });

        it('handles a zero-node array', function () {
            var p = makePoints3d(0);
            assertEqual(points3dNodeCount(p), 0);
            assertFalse(someValidPoint3d(p));
            assertDeepEqual(toBoxedPoints3d(p), []);
        });
    });
})();
