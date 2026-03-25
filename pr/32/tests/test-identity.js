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

        it('getOrCreateIdentityForTrack creates identity named id_N', function () {
            var cams = [new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480])];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['track_0', 'track_1']);
            var id = s.getOrCreateIdentityForTrack(0);
            assertEqual(id.name, 'id_0');
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

    // ---- Track reassignment with auto-swap ----

    describe('Track reassignment auto-swap', function () {
        it('assigning track_1 to instance A swaps instance B to track_0', function () {
            // Frame 0: instA=track_0, instB=track_1 in CamA
            var fg = new FrameGroup(0);
            var instA = new Instance([[10, 20]], 0, 'predicted');
            var instB = new Instance([[30, 40]], 1, 'predicted');
            fg.addInstance('CamA', instA);
            fg.addInstance('CamA', instB);

            // Assign instA to track_1 — instB should auto-swap to track_0
            var oldTrack = instA.trackIdx;  // 0
            var newTrack = 1;
            // Find conflicting instance on same camera with newTrack
            var camInsts = fg.getInstances('CamA');
            for (var i = 0; i < camInsts.length; i++) {
                if (camInsts[i] !== instA && camInsts[i].trackIdx === newTrack) {
                    camInsts[i].trackIdx = oldTrack;  // swap
                }
            }
            instA.trackIdx = newTrack;

            assertEqual(instA.trackIdx, 1, 'instA should be track_1');
            assertEqual(instB.trackIdx, 0, 'instB should auto-swap to track_0');
        });

        it('no swap needed when target track is unoccupied', function () {
            var fg = new FrameGroup(0);
            var instA = new Instance([[10, 20]], 0, 'predicted');
            var instB = new Instance([[30, 40]], 1, 'predicted');
            fg.addInstance('CamA', instA);
            fg.addInstance('CamA', instB);

            // Assign instA to track_2 (unoccupied) — no swap
            var oldTrack = instA.trackIdx;
            var newTrack = 2;
            var camInsts = fg.getInstances('CamA');
            for (var i = 0; i < camInsts.length; i++) {
                if (camInsts[i] !== instA && camInsts[i].trackIdx === newTrack) {
                    camInsts[i].trackIdx = oldTrack;
                }
            }
            instA.trackIdx = newTrack;

            assertEqual(instA.trackIdx, 2, 'instA should be track_2');
            assertEqual(instB.trackIdx, 1, 'instB unchanged');
        });

        it('swap propagates to subsequent frames', function () {
            // Setup: 3 frames, each with 2 instances
            var session = new Session(
                [new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480])],
                new Skeleton('s', ['a'], []),
                ['track_0', 'track_1']
            );

            // Frame 0: A=track_0, B=track_1 (correct)
            var fg0 = new FrameGroup(0);
            var f0a = new Instance([[10, 20]], 0, 'predicted');
            var f0b = new Instance([[30, 40]], 1, 'predicted');
            fg0.addInstance('CamA', f0a);
            fg0.addInstance('CamA', f0b);
            session.addFrameGroup(fg0);

            // Frame 1: A=track_0, B=track_1 (correct)
            var fg1 = new FrameGroup(1);
            var f1a = new Instance([[11, 21]], 0, 'predicted');
            var f1b = new Instance([[31, 41]], 1, 'predicted');
            fg1.addInstance('CamA', f1a);
            fg1.addInstance('CamA', f1b);
            session.addFrameGroup(fg1);

            // Frame 2: SWAPPED — A=track_1, B=track_0
            var fg2 = new FrameGroup(2);
            var f2a = new Instance([[12, 22]], 1, 'predicted'); // swapped!
            var f2b = new Instance([[32, 42]], 0, 'predicted'); // swapped!
            fg2.addInstance('CamA', f2a);
            fg2.addInstance('CamA', f2b);
            session.addFrameGroup(fg2);

            // Fix frame 2: swap track_0 and track_1 from frame 2 onwards
            for (var [fIdx, fg] of session.frameGroups) {
                if (fIdx < 2) continue;
                var insts = fg.getInstances('CamA');
                // Mark track_0 as temp -99
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].trackIdx === 0) insts[i].trackIdx = -99;
                }
                // track_1 → track_0
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].trackIdx === 1) insts[i].trackIdx = 0;
                }
                // temp → track_1
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].trackIdx === -99) insts[i].trackIdx = 1;
                }
            }

            // Verify all frames are now correct
            assertEqual(f0a.trackIdx, 0, 'frame 0 A unchanged');
            assertEqual(f0b.trackIdx, 1, 'frame 0 B unchanged');
            assertEqual(f1a.trackIdx, 0, 'frame 1 A unchanged');
            assertEqual(f1b.trackIdx, 1, 'frame 1 B unchanged');
            assertEqual(f2a.trackIdx, 0, 'frame 2 A fixed to track_0');
            assertEqual(f2b.trackIdx, 1, 'frame 2 B fixed to track_1');
        });

        it('sequential reassignment does not create duplicate tracks', function () {
            var fg = new FrameGroup(0);
            var instA = new Instance([[10, 20]], 0, 'predicted');
            var instB = new Instance([[30, 40]], 1, 'predicted');
            fg.addInstance('CamA', instA);
            fg.addInstance('CamA', instB);

            // Step 1: change instA from track_0 to track_1 (auto-swap instB to track_0)
            var camInsts = fg.getInstances('CamA');
            for (var i = 0; i < camInsts.length; i++) {
                if (camInsts[i] !== instA && camInsts[i].trackIdx === 1) camInsts[i].trackIdx = 0;
            }
            instA.trackIdx = 1;

            assertEqual(instA.trackIdx, 1);
            assertEqual(instB.trackIdx, 0);

            // Step 2: change instA back to track_0 (auto-swap instB back to track_1)
            camInsts = fg.getInstances('CamA');
            for (var i = 0; i < camInsts.length; i++) {
                if (camInsts[i] !== instA && camInsts[i].trackIdx === 0) camInsts[i].trackIdx = 1;
            }
            instA.trackIdx = 0;

            assertEqual(instA.trackIdx, 0, 'instA back to track_0');
            assertEqual(instB.trackIdx, 1, 'instB back to track_1');

            // Verify no duplicates
            var tracks = new Set();
            camInsts = fg.getInstances('CamA');
            for (var i = 0; i < camInsts.length; i++) tracks.add(camInsts[i].trackIdx);
            assertEqual(tracks.size, 2, 'should have 2 distinct tracks');
        });
    });

    describe('Identity color resolution', function () {
        it('getGroupColor uses identity color when useIdentity is true', function () {
            var s = new Session([], new Skeleton('s', ['a'], []), ['t0']);
            var id = s.addIdentity('mouse_A', '#ff0000');
            var group = new InstanceGroup(1, 0);
            s.assignIdentityToGroup(group, id.id);
            // Pass useIdentity=true as third param
            var color = getGroupColor(group, s, true);
            assertEqual(color, '#ff0000');
        });

        it('getGroupColor uses track color when useIdentity is false', function () {
            var s = new Session([], new Skeleton('s', ['a'], []), ['t0']);
            var id = s.addIdentity('mouse_A', '#ff0000');
            var group = new InstanceGroup(1, 0);
            s.assignIdentityToGroup(group, id.id);
            var color = getGroupColor(group, s, false);
            assertEqual(color, getTrackColor(0));
        });

        it('getGroupColor falls back to track color when unassigned', function () {
            var group = new InstanceGroup(1, 0);
            var color = getGroupColor(group, null);
            assertEqual(color, getTrackColor(0));
        });
    });

    // ---- Per-camera track-to-identity mapping ----

    describe('Per-camera trackIdentityMap', function () {
        it('starts empty', function () {
            var s = new Session([], new Skeleton('s', ['a'], []), ['t0']);
            assertEqual(s.trackIdentityMap.size, 0);
        });

        it('assignTrackToIdentity with camera sets per-camera key', function () {
            var s = new Session([new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480])],
                new Skeleton('s', ['a'], []), ['t0']);
            var id = s.addIdentity('id_0');
            s.assignTrackToIdentity(0, id.id, 'CamA');
            assertEqual(s.trackIdentityMap.get('CamA:0'), id.id);
        });

        it('assignTrackToIdentity without camera sets all cameras', function () {
            var cams = [
                new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
                new Camera('CamB', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            ];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['t0']);
            var id = s.addIdentity('id_0');
            s.assignTrackToIdentity(0, id.id);
            assertEqual(s.trackIdentityMap.get('CamA:0'), id.id);
            assertEqual(s.trackIdentityMap.get('CamB:0'), id.id);
        });

        it('getIdentityForTrack with camera returns per-camera identity', function () {
            var cams = [
                new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
                new Camera('CamB', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            ];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['t0', 't1']);
            var idA = s.addIdentity('id_0');
            var idB = s.addIdentity('id_1');
            s.assignTrackToIdentity(0, idA.id, 'CamA');
            s.assignTrackToIdentity(0, idB.id, 'CamB');  // different identity for same track!

            var foundA = s.getIdentityForTrack(0, 'CamA');
            var foundB = s.getIdentityForTrack(0, 'CamB');
            assertEqual(foundA.id, idA.id, 'CamA track 0 should be id_0');
            assertEqual(foundB.id, idB.id, 'CamB track 0 should be id_1');
        });

        it('getIdentityForTrack without camera falls back to any match', function () {
            var cams = [
                new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            ];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['t0']);
            var id = s.addIdentity('id_0');
            s.assignTrackToIdentity(0, id.id, 'CamA');

            var found = s.getIdentityForTrack(0);
            assertEqual(found.id, id.id, 'should find via fallback');
        });

        it('getIdentityForTrack returns null when not mapped', function () {
            var s = new Session([], new Skeleton('s', ['a'], []), ['t0']);
            assertNull(s.getIdentityForTrack(0, 'CamA'));
            assertNull(s.getIdentityForTrack(0));
        });
    });

    // ---- Trust tracks propagation ----

    describe('Trust tracks propagation', function () {
        it('getOrCreateIdentityForTrack creates identity and maps all cameras', function () {
            var cams = [
                new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
                new Camera('CamB', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            ];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['track_0', 'track_1']);

            var id0 = s.getOrCreateIdentityForTrack(0);
            assertEqual(id0.name, 'id_0');
            assertEqual(s.trackIdentityMap.get('CamA:0'), id0.id, 'CamA mapped');
            assertEqual(s.trackIdentityMap.get('CamB:0'), id0.id, 'CamB mapped');
        });

        it('getOrCreateIdentityForTrack returns same identity on second call', function () {
            var cams = [
                new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            ];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['track_0']);

            var id1 = s.getOrCreateIdentityForTrack(0);
            var id2 = s.getOrCreateIdentityForTrack(0);
            assertEqual(id1, id2, 'should return same identity');
            assertEqual(s.identities.length, 1, 'should not create duplicate');
        });

        it('different tracks get different identities', function () {
            var cams = [
                new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            ];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['track_0', 'track_1']);

            var id0 = s.getOrCreateIdentityForTrack(0);
            var id1 = s.getOrCreateIdentityForTrack(1);
            assertTrue(id0.id !== id1.id, 'different ids');
            assertTrue(id0.color !== id1.color, 'different colors');
        });
    });

    // ---- Tracklet stitching ----

    describe('Tracklet stitching via identity', function () {
        it('two tracklets can share one identity', function () {
            var cams = [
                new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            ];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['tracklet_0', 'tracklet_1', 'tracklet_2']);
            var id0 = s.addIdentity('mouse_A');

            // Assign tracklet 0 and tracklet 2 to same identity (stitching)
            s.assignTrackToIdentity(0, id0.id, 'CamA');
            s.assignTrackToIdentity(2, id0.id, 'CamA');

            var found0 = s.getIdentityForTrack(0, 'CamA');
            var found2 = s.getIdentityForTrack(2, 'CamA');
            assertEqual(found0.id, id0.id, 'tracklet 0 is mouse_A');
            assertEqual(found2.id, id0.id, 'tracklet 2 is also mouse_A');
            assertEqual(found0.color, found2.color, 'same color');
        });

        it('reassigning tracklet to different identity changes lookup', function () {
            var cams = [
                new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            ];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['t0']);
            var idA = s.addIdentity('mouse_A');
            var idB = s.addIdentity('mouse_B');

            s.assignTrackToIdentity(0, idA.id, 'CamA');
            assertEqual(s.getIdentityForTrack(0, 'CamA').name, 'mouse_A');

            // Reassign
            s.assignTrackToIdentity(0, idB.id, 'CamA');
            assertEqual(s.getIdentityForTrack(0, 'CamA').name, 'mouse_B');
        });
    });

    // ---- Per-camera identity independence ----

    describe('Per-camera identity independence', function () {
        it('same trackIdx can have different identities in different cameras', function () {
            var cams = [
                new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
                new Camera('CamB', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            ];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['t0']);
            var idA = s.addIdentity('mouse_A', '#00ff00');
            var idB = s.addIdentity('mouse_B', '#ff00ff');

            // Track swap: CamA has correct track, CamB has swapped
            s.assignTrackToIdentity(0, idA.id, 'CamA');
            s.assignTrackToIdentity(0, idB.id, 'CamB');

            var colorA = s.getIdentityForTrack(0, 'CamA').color;
            var colorB = s.getIdentityForTrack(0, 'CamB').color;
            assertEqual(colorA, '#00ff00', 'CamA shows green');
            assertEqual(colorB, '#ff00ff', 'CamB shows magenta');
        });

        it('changing one camera does not affect another', function () {
            var cams = [
                new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
                new Camera('CamB', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            ];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['t0']);
            var id0 = s.addIdentity('id_0');
            var id1 = s.addIdentity('id_1');

            // Both start as id_0
            s.assignTrackToIdentity(0, id0.id, 'CamA');
            s.assignTrackToIdentity(0, id0.id, 'CamB');

            // Change only CamB
            s.assignTrackToIdentity(0, id1.id, 'CamB');

            assertEqual(s.getIdentityForTrack(0, 'CamA').id, id0.id, 'CamA unchanged');
            assertEqual(s.getIdentityForTrack(0, 'CamB').id, id1.id, 'CamB changed');
        });
    });

    // ---- Identity naming ----

    describe('Identity naming', function () {
        it('default name is id_N', function () {
            var id = new Identity(0);
            assertEqual(id.name, 'id_0');
        });

        it('getOrCreateIdentityForTrack names as id_N', function () {
            var cams = [
                new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            ];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['track_0']);
            var id = s.getOrCreateIdentityForTrack(0);
            assertEqual(id.name, 'id_0');
        });

        it('identity colors differ from track colors', function () {
            var id = new Identity(0);
            assertTrue(id.color !== getTrackColor(0), 'identity 0 color should differ from track 0 color');
        });
    });

    // ---- getInstanceColor with session passed explicitly ----

    describe('getInstanceColor with explicit session', function () {
        it('returns identity color when useIdentity=true and map is populated', function () {
            var cams = [new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480])];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['track_0']);
            var id = s.addIdentity('id_0', '#00ff00');
            s.assignTrackToIdentity(0, id.id, 'CamA');

            var inst = new Instance([[10, 20]], 0, 'predicted');
            var color = getInstanceColor(inst, s, 'CamA', true);
            assertEqual(color, '#00ff00', 'should return identity color');
        });

        it('returns track color when useIdentity=false', function () {
            var cams = [new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480])];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['track_0']);
            var id = s.addIdentity('id_0', '#00ff00');
            s.assignTrackToIdentity(0, id.id, 'CamA');

            var inst = new Instance([[10, 20]], 0, 'predicted');
            var color = getInstanceColor(inst, s, 'CamA', false);
            assertEqual(color, getTrackColor(0), 'should return track color');
        });

        it('returns track color when session is null', function () {
            var inst = new Instance([[10, 20]], 0, 'predicted');
            var color = getInstanceColor(inst, null, 'CamA', true);
            assertEqual(color, getTrackColor(0), 'should fall back to track color');
        });

        it('changing identity changes color immediately', function () {
            var cams = [new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480])];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['track_0']);
            var id0 = s.addIdentity('id_0', '#00ff00');
            var id1 = s.addIdentity('id_1', '#ff00ff');
            s.assignTrackToIdentity(0, id0.id, 'CamA');

            var inst = new Instance([[10, 20]], 0, 'predicted');

            // Initially green
            var color1 = getInstanceColor(inst, s, 'CamA', true);
            assertEqual(color1, '#00ff00', 'should be green initially');

            // Change to id_1 (magenta)
            s.assignTrackToIdentity(0, id1.id, 'CamA');
            var color2 = getInstanceColor(inst, s, 'CamA', true);
            assertEqual(color2, '#ff00ff', 'should be magenta after reassign');
        });

        it('different cameras can have different identity colors', function () {
            var cams = [
                new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
                new Camera('CamB', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            ];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['track_0']);
            var id0 = s.addIdentity('id_0', '#00ff00');
            var id1 = s.addIdentity('id_1', '#ff00ff');
            s.assignTrackToIdentity(0, id0.id, 'CamA');
            s.assignTrackToIdentity(0, id1.id, 'CamB');

            var inst = new Instance([[10, 20]], 0, 'predicted');
            var colorA = getInstanceColor(inst, s, 'CamA', true);
            var colorB = getInstanceColor(inst, s, 'CamB', true);
            assertEqual(colorA, '#00ff00', 'CamA should be green');
            assertEqual(colorB, '#ff00ff', 'CamB should be magenta');
        });
    });

    // ---- trackIdentityMap serialization ----

    describe('trackIdentityMap serialization', function () {
        it('round-trips through array of entries', function () {
            var cams = [
                new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            ];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['t0', 't1']);
            var id0 = s.addIdentity('id_0');
            var id1 = s.addIdentity('id_1');
            s.assignTrackToIdentity(0, id0.id, 'CamA');
            s.assignTrackToIdentity(1, id1.id, 'CamA');

            // Serialize
            var entries = Array.from(s.trackIdentityMap.entries());
            assertEqual(entries.length, 2);

            // Restore
            var s2 = new Session(cams, new Skeleton('s', ['a'], []), ['t0', 't1']);
            for (var i = 0; i < entries.length; i++) {
                s2.trackIdentityMap.set(entries[i][0], entries[i][1]);
            }
            assertEqual(s2.trackIdentityMap.get('CamA:0'), id0.id);
            assertEqual(s2.trackIdentityMap.get('CamA:1'), id1.id);
        });
    });
})();
