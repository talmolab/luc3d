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

    // ---- Swap proofreading sequences ----

    describe('Swap proofreading: fix artificial swap across frames', function () {
        function makeSwapSession() {
            var cams = [new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480])];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['track_0', 'track_1']);
            // 5 frames: swap happens at frame 3
            for (var f = 0; f < 5; f++) {
                var fg = new FrameGroup(f);
                if (f < 3) {
                    // Correct: instA=track_0, instB=track_1
                    fg.addInstance('CamA', new Instance([[f * 10, f * 10 + 1]], 0, 'predicted'));
                    fg.addInstance('CamA', new Instance([[f * 10 + 5, f * 10 + 6]], 1, 'predicted'));
                } else {
                    // Swapped: instA=track_1, instB=track_0
                    fg.addInstance('CamA', new Instance([[f * 10, f * 10 + 1]], 1, 'predicted'));
                    fg.addInstance('CamA', new Instance([[f * 10 + 5, f * 10 + 6]], 0, 'predicted'));
                }
                s.addFrameGroup(fg);
            }
            return s;
        }

        it('detects swap: frame 3+ has inverted tracks', function () {
            var s = makeSwapSession();
            var f2 = s.getFrameGroup(2).getInstances('CamA');
            var f3 = s.getFrameGroup(3).getInstances('CamA');
            // Frame 2: first=track_0, second=track_1
            assertEqual(f2[0].trackIdx, 0);
            assertEqual(f2[1].trackIdx, 1);
            // Frame 3: first=track_1, second=track_0 (swapped)
            assertEqual(f3[0].trackIdx, 1);
            assertEqual(f3[1].trackIdx, 0);
        });

        it('swapTracks at frame 3 fixes all subsequent frames', function () {
            var s = makeSwapSession();
            // Swap track_0 and track_1 from frame 3 onwards
            for (var [fIdx, fg] of s.frameGroups) {
                if (fIdx < 3) continue;
                var insts = fg.getInstances('CamA');
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].trackIdx === 0) insts[i].trackIdx = -99;
                }
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].trackIdx === 1) insts[i].trackIdx = 0;
                }
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].trackIdx === -99) insts[i].trackIdx = 1;
                }
            }

            // Verify ALL frames are now correct
            for (var f = 0; f < 5; f++) {
                var insts = s.getFrameGroup(f).getInstances('CamA');
                assertEqual(insts[0].trackIdx, 0, 'frame ' + f + ' inst 0 should be track_0');
                assertEqual(insts[1].trackIdx, 1, 'frame ' + f + ' inst 1 should be track_1');
            }
        });

        it('fixing swap does not affect frames before the swap point', function () {
            var s = makeSwapSession();
            // Save frame 0-2 tracks before fix
            var before = [];
            for (var f = 0; f < 3; f++) {
                var insts = s.getFrameGroup(f).getInstances('CamA');
                before.push([insts[0].trackIdx, insts[1].trackIdx]);
            }

            // Fix swap at frame 3
            for (var [fIdx, fg] of s.frameGroups) {
                if (fIdx < 3) continue;
                var insts = fg.getInstances('CamA');
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].trackIdx === 0) insts[i].trackIdx = -99;
                }
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].trackIdx === 1) insts[i].trackIdx = 0;
                }
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].trackIdx === -99) insts[i].trackIdx = 1;
                }
            }

            // Verify frames 0-2 unchanged
            for (var f = 0; f < 3; f++) {
                var insts = s.getFrameGroup(f).getInstances('CamA');
                assertEqual(insts[0].trackIdx, before[f][0], 'frame ' + f + ' inst 0 unchanged');
                assertEqual(insts[1].trackIdx, before[f][1], 'frame ' + f + ' inst 1 unchanged');
            }
        });
    });

    describe('Swap proofreading: multiple swaps', function () {
        it('handles two swaps at different frames', function () {
            var cams = [new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480])];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['track_0', 'track_1']);

            // Frame 0-1: correct (0,1)
            // Frame 2-3: swapped (1,0)
            // Frame 4-5: swapped back (0,1) — double swap
            for (var f = 0; f < 6; f++) {
                var fg = new FrameGroup(f);
                var swapped = (f >= 2 && f <= 3);
                fg.addInstance('CamA', new Instance([[f, 0]], swapped ? 1 : 0, 'predicted'));
                fg.addInstance('CamA', new Instance([[f, 5]], swapped ? 0 : 1, 'predicted'));
                s.addFrameGroup(fg);
            }

            // Fix first swap at frame 2 (swap 0↔1 from frame 2 onwards)
            for (var [fIdx, fg] of s.frameGroups) {
                if (fIdx < 2) continue;
                var insts = fg.getInstances('CamA');
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].trackIdx === 0) insts[i].trackIdx = -99;
                }
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].trackIdx === 1) insts[i].trackIdx = 0;
                }
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].trackIdx === -99) insts[i].trackIdx = 1;
                }
            }

            // After first fix: frames 0-3 should be correct, but frames 4-5 are now swapped
            // (because the second swap got un-swapped by our fix)
            for (var f = 0; f < 4; f++) {
                var insts = s.getFrameGroup(f).getInstances('CamA');
                assertEqual(insts[0].trackIdx, 0, 'after fix 1: frame ' + f + ' inst 0 = track_0');
                assertEqual(insts[1].trackIdx, 1, 'after fix 1: frame ' + f + ' inst 1 = track_1');
            }
            // Frames 4-5 are now inverted (because they were already correct, our swap broke them)
            var f4 = s.getFrameGroup(4).getInstances('CamA');
            assertEqual(f4[0].trackIdx, 1, 'frame 4 now swapped by our fix');
            assertEqual(f4[1].trackIdx, 0, 'frame 4 now swapped by our fix');

            // Fix second swap at frame 4
            for (var [fIdx2, fg2] of s.frameGroups) {
                if (fIdx2 < 4) continue;
                var insts2 = fg2.getInstances('CamA');
                for (var i = 0; i < insts2.length; i++) {
                    if (insts2[i].trackIdx === 0) insts2[i].trackIdx = -99;
                }
                for (var i = 0; i < insts2.length; i++) {
                    if (insts2[i].trackIdx === 1) insts2[i].trackIdx = 0;
                }
                for (var i = 0; i < insts2.length; i++) {
                    if (insts2[i].trackIdx === -99) insts2[i].trackIdx = 1;
                }
            }

            // Now ALL frames should be correct
            for (var f = 0; f < 6; f++) {
                var insts = s.getFrameGroup(f).getInstances('CamA');
                assertEqual(insts[0].trackIdx, 0, 'final: frame ' + f + ' inst 0 = track_0');
                assertEqual(insts[1].trackIdx, 1, 'final: frame ' + f + ' inst 1 = track_1');
            }
        });
    });

    describe('Swap proofreading: sequential dropdown changes', function () {
        it('changing instance A then B does not corrupt tracks', function () {
            var fg = new FrameGroup(0);
            var instA = new Instance([[10, 20]], 0, 'predicted');
            var instB = new Instance([[30, 40]], 1, 'predicted');
            fg.addInstance('CamA', instA);
            fg.addInstance('CamA', instB);

            // User changes instA from track_0 to track_1 (swap)
            var camInsts = fg.getInstances('CamA');
            for (var i = 0; i < camInsts.length; i++) {
                if (camInsts[i] !== instA && camInsts[i].trackIdx === 1) camInsts[i].trackIdx = 0;
            }
            instA.trackIdx = 1;
            assertEqual(instA.trackIdx, 1, 'step 1: A = track_1');
            assertEqual(instB.trackIdx, 0, 'step 1: B = track_0 (swapped)');

            // User then changes instB from track_0 to track_1 (swap again)
            camInsts = fg.getInstances('CamA');
            for (var i = 0; i < camInsts.length; i++) {
                if (camInsts[i] !== instB && camInsts[i].trackIdx === 1) camInsts[i].trackIdx = 0;
            }
            instB.trackIdx = 1;
            assertEqual(instA.trackIdx, 0, 'step 2: A = track_0 (swapped back)');
            assertEqual(instB.trackIdx, 1, 'step 2: B = track_1');

            // Verify no duplicates
            var tracks = {};
            camInsts = fg.getInstances('CamA');
            for (var i = 0; i < camInsts.length; i++) {
                var t = camInsts[i].trackIdx;
                assertTrue(!tracks[t], 'no duplicate track ' + t);
                tracks[t] = true;
            }
        });

        it('three instances: assigning occupied track swaps correctly', function () {
            var fg = new FrameGroup(0);
            var instA = new Instance([[10, 20]], 0, 'predicted');
            var instB = new Instance([[30, 40]], 1, 'predicted');
            var instC = new Instance([[50, 60]], 2, 'predicted');
            fg.addInstance('CamA', instA);
            fg.addInstance('CamA', instB);
            fg.addInstance('CamA', instC);

            // Change instA from track_0 to track_2 — instC should swap to track_0
            var camInsts = fg.getInstances('CamA');
            for (var i = 0; i < camInsts.length; i++) {
                if (camInsts[i] !== instA && camInsts[i].trackIdx === 2) camInsts[i].trackIdx = 0;
            }
            instA.trackIdx = 2;

            assertEqual(instA.trackIdx, 2, 'A = track_2');
            assertEqual(instB.trackIdx, 1, 'B unchanged = track_1');
            assertEqual(instC.trackIdx, 0, 'C swapped to track_0');

            // Verify all unique
            var seen = new Set();
            camInsts = fg.getInstances('CamA');
            for (var i = 0; i < camInsts.length; i++) seen.add(camInsts[i].trackIdx);
            assertEqual(seen.size, 3, 'all 3 tracks unique');
        });
    });

    describe('Identity color resolution', function () {
        it('getGroupColor uses identity color when useIdentity is true', function () {
            var cams = [new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480])];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['t0']);
            var id = s.addIdentity('mouse_A', '#ff0000');
            var group = new InstanceGroup(1, 0);
            s.assignIdentityToGroup(group, id.id);
            var color = getGroupColor(group, s, true);
            assertEqual(color, '#ff0000');
        });

        it('getGroupColor uses track color when useIdentity is false', function () {
            var cams = [new Camera('CamA', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480])];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['t0']);
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
    // ---- Timeline tracklet stress test ----

    describe('Timeline tracklet generation', function () {
        function makeCamera(name) {
            return new Camera(name, [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]);
        }

        it('builds per-camera tracklets for 2 tracks × 3 cameras', function () {
            var cams = [makeCamera('CamA'), makeCamera('CamB'), makeCamera('CamC')];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['track_0', 'track_1']);

            // 10 frames, both tracks in all cameras
            for (var f = 0; f < 10; f++) {
                var fg = new FrameGroup(f);
                for (var ci = 0; ci < cams.length; ci++) {
                    fg.addUnlinkedInstance(cams[ci].name, new UnlinkedInstance(
                        new Instance([[f, 0]], 0, 'predicted'), cams[ci].name));
                    fg.addUnlinkedInstance(cams[ci].name, new UnlinkedInstance(
                        new Instance([[f, 5]], 1, 'predicted'), cams[ci].name));
                }
                s.addFrameGroup(fg);
            }

            // Build segments like the timeline does
            var segments = [];
            var trackNames = [];
            var numTracks = s.tracks.length;
            var trackCamFrames = {};
            for (var [frameIdx, fg2] of s.frameGroups) {
                for (var [camName, ulList] of fg2.unlinkedInstances) {
                    for (var u = 0; u < ulList.length; u++) {
                        var t = ulList[u].instance.trackIdx;
                        var key = t + ':' + camName;
                        if (!trackCamFrames[key]) trackCamFrames[key] = new Set();
                        trackCamFrames[key].add(frameIdx);
                    }
                }
            }

            for (var t2 = 0; t2 < numTracks; t2++) {
                for (var ci2 = 0; ci2 < cams.length; ci2++) {
                    var key2 = t2 + ':' + cams[ci2].name;
                    if (trackCamFrames[key2]) {
                        segments.push({ trackIdx: t2, cam: cams[ci2].name, count: trackCamFrames[key2].size });
                        trackNames.push(s.tracks[t2] + ' / ' + cams[ci2].name);
                    }
                }
            }

            // 2 tracks × 3 cameras = 6 rows
            assertEqual(segments.length, 6, 'should have 6 tracklet rows');
            assertEqual(trackNames[0], 'track_0 / CamA');
            assertEqual(trackNames[5], 'track_1 / CamC');
            // Each has 10 frames
            for (var si = 0; si < segments.length; si++) {
                assertEqual(segments[si].count, 10, 'row ' + si + ' should have 10 frames');
            }
        });

        it('handles 10 tracks × 8 cameras = 80 rows without error', function () {
            var cams = [];
            for (var ci = 0; ci < 8; ci++) cams.push(makeCamera('cam_' + ci));
            var trackNames = [];
            for (var ti = 0; ti < 10; ti++) trackNames.push('track_' + ti);
            var s = new Session(cams, new Skeleton('s', ['a'], []), trackNames);

            // 100 frames, each track appears in each camera
            for (var f = 0; f < 100; f++) {
                var fg = new FrameGroup(f);
                for (var ci2 = 0; ci2 < cams.length; ci2++) {
                    for (var ti2 = 0; ti2 < 10; ti2++) {
                        fg.addUnlinkedInstance(cams[ci2].name, new UnlinkedInstance(
                            new Instance([[f, ti2]], ti2, 'predicted'), cams[ci2].name));
                    }
                }
                s.addFrameGroup(fg);
            }

            // Count tracklet rows
            var trackCamFrames = {};
            for (var [frameIdx, fg2] of s.frameGroups) {
                for (var [camName, ulList] of fg2.unlinkedInstances) {
                    for (var u = 0; u < ulList.length; u++) {
                        var t = ulList[u].instance.trackIdx;
                        var key = t + ':' + camName;
                        if (!trackCamFrames[key]) trackCamFrames[key] = new Set();
                        trackCamFrames[key].add(frameIdx);
                    }
                }
            }

            var rowCount = Object.keys(trackCamFrames).length;
            assertEqual(rowCount, 80, 'should have 80 tracklet rows (10 tracks × 8 cameras)');

            // Each row should have 100 frames
            for (var key in trackCamFrames) {
                assertEqual(trackCamFrames[key].size, 100, key + ' should have 100 frames');
            }
        });

        it('detects gaps in tracklets', function () {
            var cams = [makeCamera('CamA')];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['track_0']);

            // Frames 0-4, then gap, then 8-9
            for (var f = 0; f < 10; f++) {
                if (f >= 5 && f <= 7) continue; // gap
                var fg = new FrameGroup(f);
                fg.addUnlinkedInstance('CamA', new UnlinkedInstance(
                    new Instance([[f, 0]], 0, 'predicted'), 'CamA'));
                s.addFrameGroup(fg);
            }

            var frames = new Set();
            for (var [frameIdx, fg2] of s.frameGroups) {
                var ulList = fg2.getUnlinkedInstances('CamA');
                for (var u = 0; u < ulList.length; u++) {
                    if (ulList[u].instance.trackIdx === 0) frames.add(frameIdx);
                }
            }

            // Build segments
            var sorted = Array.from(frames).sort(function (a, b) { return a - b; });
            var segments = [];
            var segStart = -1, segEnd = -1;
            for (var i = 0; i < sorted.length; i++) {
                if (segStart < 0) { segStart = sorted[i]; segEnd = sorted[i]; }
                else if (sorted[i] === segEnd + 1) { segEnd = sorted[i]; }
                else { segments.push({ start: segStart, end: segEnd }); segStart = sorted[i]; segEnd = sorted[i]; }
            }
            if (segStart >= 0) segments.push({ start: segStart, end: segEnd });

            assertEqual(segments.length, 2, 'should have 2 segments (gap at 5-7)');
            assertEqual(segments[0].start, 0);
            assertEqual(segments[0].end, 4);
            assertEqual(segments[1].start, 8);
            assertEqual(segments[1].end, 9);
        });

        it('camera with no instances for a track produces no row', function () {
            var cams = [makeCamera('CamA'), makeCamera('CamB')];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['track_0']);

            // Only CamA has instances
            var fg = new FrameGroup(0);
            fg.addUnlinkedInstance('CamA', new UnlinkedInstance(
                new Instance([[0, 0]], 0, 'predicted'), 'CamA'));
            s.addFrameGroup(fg);

            var trackCamFrames = {};
            for (var [frameIdx, fg2] of s.frameGroups) {
                for (var [camName, ulList] of fg2.unlinkedInstances) {
                    for (var u = 0; u < ulList.length; u++) {
                        var key = ulList[u].instance.trackIdx + ':' + camName;
                        if (!trackCamFrames[key]) trackCamFrames[key] = new Set();
                        trackCamFrames[key].add(frameIdx);
                    }
                }
            }

            assertTrue(!!trackCamFrames['0:CamA'], 'CamA should have track_0');
            assertTrue(!trackCamFrames['0:CamB'], 'CamB should NOT have track_0');
        });
    });

    // =========================================================================
    // Per-frame identity map + propagation tests
    // =========================================================================

    describe('Per-frame identity map', function () {
        function makeSession() {
            var cams = [new Camera('cam1', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480])];
            var skel = new Skeleton('s', ['a'], []);
            var session = new Session(cams, skel, ['track_0', 'track_1']);
            var id0 = session.addIdentity('id_0');
            var id1 = session.addIdentity('id_1');
            // Add 3 frames with 2 instances each
            for (var f = 0; f < 3; f++) {
                var fg = new FrameGroup(f);
                fg.addInstance('cam1', new Instance([[10, 20]], 0, 'predicted'));
                fg.addInstance('cam1', new Instance([[30, 40]], 1, 'predicted'));
                session.addFrameGroup(fg);
            }
            return { session: session, id0: id0, id1: id1 };
        }

        it('setFrameIdentity writes per-frame override', function () {
            var s = makeSession().session;
            var id0 = s.identities[0];
            s.setFrameIdentity(0, 'cam1', 0, id0.id);
            var val = s.frameIdentityMap.get('0:cam1:0');
            assertEqual(val, id0.id, 'per-frame override should be set');
        });

        it('getIdentityIdForTrack checks per-frame first', function () {
            var s = makeSession().session;
            var id0 = s.identities[0], id1 = s.identities[1];
            // Set global to id_0
            s.trackIdentityMap.set('cam1:0', id0.id);
            // Set per-frame override to id_1 for frame 5
            s.setFrameIdentity(5, 'cam1', 0, id1.id);
            // Frame 5 should return id_1 (per-frame wins)
            assertEqual(s.getIdentityIdForTrack('cam1', 0, 5), id1.id, 'per-frame should win');
            // Frame 3 (no per-frame) should return id_0 (global)
            assertEqual(s.getIdentityIdForTrack('cam1', 0, 3), id0.id, 'global fallback');
        });

        it('getIdentityForTrack returns Identity object with per-frame', function () {
            var s = makeSession().session;
            var id1 = s.identities[1];
            s.setFrameIdentity(2, 'cam1', 0, id1.id);
            var identity = s.getIdentityForTrack(0, 'cam1', 2);
            assertNotNull(identity, 'should find identity');
            assertEqual(identity.id, id1.id, 'should be id_1');
        });

        it('getIdentityForTrack without cameraName checks per-frame', function () {
            var s = makeSession().session;
            var id1 = s.identities[1];
            s.setFrameIdentity(2, 'cam1', 0, id1.id);
            var identity = s.getIdentityForTrack(0, null, 2);
            assertNotNull(identity, 'should find identity without cameraName');
            assertEqual(identity.id, id1.id, 'should be id_1');
        });

        it('propagateIdentity sets current frame and forward', function () {
            var data = makeSession();
            var s = data.session, id0 = data.id0;
            // Propagate id_0 for cam1:track_0 starting from frame 1
            var count = s.propagateIdentity(1, 'cam1', 0, id0.id);
            assertTrue(count >= 2, 'should affect frames 1 and 2');
            // Frame 0 should NOT have override
            assertNull(s.frameIdentityMap.get('0:cam1:0') != null ? 'set' : null,
                'frame 0 should not be set');
            // Frame 1 and 2 should have override
            assertEqual(s.frameIdentityMap.get('1:cam1:0'), id0.id, 'frame 1 should be set');
            assertEqual(s.frameIdentityMap.get('2:cam1:0'), id0.id, 'frame 2 should be set');
        });

        it('manual identity change overrides Track All per-frame value', function () {
            var data = makeSession();
            var s = data.session, id0 = data.id0, id1 = data.id1;
            // Simulate Track All: set per-frame for all frames to id_0
            for (var f = 0; f < 3; f++) {
                s.setFrameIdentity(f, 'cam1', 0, id0.id);
            }
            // Simulate manual change on frame 1: set to id_1
            s.setFrameIdentity(1, 'cam1', 0, id1.id);
            s.trackIdentityMap.set('cam1:0', id1.id);
            // Frame 1 should now be id_1
            assertEqual(s.getIdentityIdForTrack('cam1', 0, 1), id1.id,
                'manual change should override Track All');
            // Frame 0 should still be id_0
            assertEqual(s.getIdentityIdForTrack('cam1', 0, 0), id0.id,
                'frame 0 unchanged');
        });

        it('propagation from manual change overrides forward frames', function () {
            var data = makeSession();
            var s = data.session, id0 = data.id0, id1 = data.id1;
            // Track All: all frames id_0
            for (var f = 0; f < 3; f++) {
                s.setFrameIdentity(f, 'cam1', 0, id0.id);
            }
            // Manual change at frame 1: propagate id_1 forward
            s.propagateIdentity(1, 'cam1', 0, id1.id);
            // Frame 0: still id_0
            assertEqual(s.getIdentityIdForTrack('cam1', 0, 0), id0.id, 'frame 0 still id_0');
            // Frame 1: id_1
            assertEqual(s.getIdentityIdForTrack('cam1', 0, 1), id1.id, 'frame 1 now id_1');
            // Frame 2: id_1 (propagated)
            assertEqual(s.getIdentityIdForTrack('cam1', 0, 2), id1.id, 'frame 2 propagated to id_1');
        });
    });

    describe('Session identity state consistency', function () {
        it('assignTrackToIdentity updates global map', function () {
            var cams = [new Camera('cam1', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480])];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['t0']);
            var id = s.addIdentity('id_0');
            s.assignTrackToIdentity(0, id.id, 'cam1');
            assertEqual(s.trackIdentityMap.get('cam1:0'), id.id, 'global map updated');
        });

        it('assignTrackToIdentity without camera sets all cameras', function () {
            var cams = [
                new Camera('cam1', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
                new Camera('cam2', [[1,0,0],[0,1,0],[0,0,1]], [0,0,0,0,0], [0,0,0], [0,0,0], [640,480])
            ];
            var s = new Session(cams, new Skeleton('s', ['a'], []), ['t0']);
            var id = s.addIdentity('id_0');
            s.assignTrackToIdentity(0, id.id);
            assertEqual(s.trackIdentityMap.get('cam1:0'), id.id, 'cam1 set');
            assertEqual(s.trackIdentityMap.get('cam2:0'), id.id, 'cam2 set');
        });

        it('new tracks beyond original count are accessible', function () {
            var s = new Session([], new Skeleton('s', ['a'], []), ['track_0']);
            assertEqual(s.tracks.length, 1);
            s.tracks.push('track_1');
            assertEqual(s.tracks.length, 2);
            assertEqual(s.tracks[1], 'track_1');
        });

        it('new identity is immediately queryable', function () {
            var s = new Session([], new Skeleton('s', ['a'], []), ['t0']);
            var id = s.addIdentity('new_id');
            var found = s.getIdentity(id.id);
            assertEqual(found, id, 'new identity should be immediately queryable');
        });

        it('frameIdentityMap cleared separately from trackIdentityMap', function () {
            var s = new Session([], new Skeleton('s', ['a'], []), ['t0']);
            s.trackIdentityMap.set('cam1:0', 0);
            s.frameIdentityMap.set('5:cam1:0', 1);
            s.frameIdentityMap = new Map();
            assertEqual(s.trackIdentityMap.get('cam1:0'), 0, 'global unaffected');
            assertNull(s.frameIdentityMap.get('5:cam1:0') != null ? 'set' : null,
                'per-frame cleared');
        });
    });
})();
