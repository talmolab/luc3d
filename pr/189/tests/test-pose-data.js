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
})();
