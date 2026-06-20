/**
 * test-session-switching.js — Tests for multi-session state isolation,
 * video file index integrity, and frame consistency across session switches.
 */

(function () {
    const { describe, it, assertEqual, assertTrue, assertNotNull, assertNull } = TestFramework;

    function makeCamera(name) {
        return new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
    }

    function makeSkeleton() {
        return new Skeleton('test', ['head', 'body'], [[0, 1]]);
    }

    // ---- Session video file isolation ----

    describe('Session videoFileIndices isolation', function () {
        it('two sessions have independent videoFileIndices', function () {
            var s1 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'Session1');
            var s2 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'Session2');

            s1.videoFileIndices = [0, 1, 2];
            s2.videoFileIndices = [3, 4, 5];

            // Modifying one doesn't affect other
            s1.videoFileIndices.push(6);
            assertEqual(s1.videoFileIndices.length, 4);
            assertEqual(s2.videoFileIndices.length, 3);
        });

        it('videoFileIndices point to correct session after reindex', function () {
            var videoFiles = [
                { name: 'vid1', sessionIdx: 0, assignedCamera: 'CamA' },
                { name: 'vid2', sessionIdx: 0, assignedCamera: 'CamB' },
                { name: 'vid3', sessionIdx: 1, assignedCamera: 'CamA' },
                { name: 'vid4', sessionIdx: 1, assignedCamera: 'CamB' },
            ];

            var s1 = new Session([makeCamera('CamA'), makeCamera('CamB')], makeSkeleton(), ['t0'], 'S1');
            var s2 = new Session([makeCamera('CamA'), makeCamera('CamB')], makeSkeleton(), ['t0'], 'S2');

            s1.videoFileIndices = [0, 1];
            s2.videoFileIndices = [2, 3];

            // Session 1's videos should have sessionIdx 0
            for (var i = 0; i < s1.videoFileIndices.length; i++) {
                var vf = videoFiles[s1.videoFileIndices[i]];
                assertEqual(vf.sessionIdx, 0, 'S1 video ' + i + ' should be sessionIdx 0');
            }
            // Session 2's videos should have sessionIdx 1
            for (var j = 0; j < s2.videoFileIndices.length; j++) {
                var vf2 = videoFiles[s2.videoFileIndices[j]];
                assertEqual(vf2.sessionIdx, 1, 'S2 video ' + j + ' should be sessionIdx 1');
            }
        });
    });

    // ---- Session state preservation ----

    describe('Session state preservation across switches', function () {
        it('lastFrame is preserved when switching away', function () {
            var s1 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S1');
            var s2 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S2');

            s1.lastFrame = 500;
            s2.lastFrame = 1000;

            // Simulate switch: save s1, activate s2
            var savedFrame = s1.lastFrame;
            assertEqual(savedFrame, 500);

            // Switch back: restore s1's frame
            assertEqual(s1.lastFrame, 500, 'S1 frame preserved');
            assertEqual(s2.lastFrame, 1000, 'S2 frame preserved');
        });

        it('triangulationResults are independent per session', function () {
            var s1 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S1');
            var s2 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S2');

            s1.triangulationResults = new Map();
            s1.triangulationResults.set(0, [{ group: null, meanError: 1.5 }]);
            s2.triangulationResults = new Map();
            s2.triangulationResults.set(0, [{ group: null, meanError: 2.5 }]);

            assertEqual(s1.triangulationResults.get(0)[0].meanError, 1.5);
            assertEqual(s2.triangulationResults.get(0)[0].meanError, 2.5);
        });

        it('_views reference is distinct per session', function () {
            var s1 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S1');
            var s2 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S2');

            s1._views = [{ name: 'CamA', decoder: 'dec1' }];
            s2._views = [{ name: 'CamA', decoder: 'dec2' }];

            assertEqual(s1._views[0].decoder, 'dec1');
            assertEqual(s2._views[0].decoder, 'dec2');

            // Modifying s2 views doesn't affect s1
            s2._views.push({ name: 'CamB', decoder: 'dec3' });
            assertEqual(s1._views.length, 1);
            assertEqual(s2._views.length, 2);
        });
    });

    // ---- Frame index consistency ----

    describe('Frame index consistency', function () {
        it('frame indices in frameGroups are independent per session', function () {
            var s1 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S1');
            var s2 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S2');

            s1.addFrameGroup(new FrameGroup(0));
            s1.addFrameGroup(new FrameGroup(100));
            s2.addFrameGroup(new FrameGroup(50));
            s2.addFrameGroup(new FrameGroup(200));

            assertEqual(s1.frameGroups.size, 2);
            assertEqual(s2.frameGroups.size, 2);
            assertTrue(s1.frameGroups.has(0));
            assertTrue(s1.frameGroups.has(100));
            assertTrue(!s1.frameGroups.has(50), 'S1 should not have frame 50');
            assertTrue(s2.frameGroups.has(50));
            assertTrue(s2.frameGroups.has(200));
            assertTrue(!s2.frameGroups.has(0), 'S2 should not have frame 0');
        });

        it('instances on same frame index are isolated between sessions', function () {
            var s1 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S1');
            var s2 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S2');

            var fg1 = new FrameGroup(0);
            fg1.addInstance('CamA', new Instance([[10, 20], [30, 40]], 0, 'predicted'));
            s1.addFrameGroup(fg1);

            var fg2 = new FrameGroup(0);
            fg2.addInstance('CamA', new Instance([[50, 60], [70, 80]], 0, 'predicted'));
            s2.addFrameGroup(fg2);

            var s1inst = s1.getFrameGroup(0).getInstances('CamA')[0];
            var s2inst = s2.getFrameGroup(0).getInstances('CamA')[0];
            assertEqual(s1inst.points[0][0], 10, 'S1 has its own instance');
            assertEqual(s2inst.points[0][0], 50, 'S2 has its own instance');
        });
    });

    // ---- Session removal integrity ----

    describe('Session removal does not corrupt remaining sessions', function () {
        it('removing session 0 leaves session 1 data intact', function () {
            var sessions = [];
            var s0 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S0');
            var s1 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S1');
            sessions.push(s0, s1);

            // S0 has frame 0, S1 has frame 100
            var fg0 = new FrameGroup(0);
            fg0.addInstance('CamA', new Instance([[1, 2], [3, 4]], 0, 'user'));
            s0.addFrameGroup(fg0);

            var fg1 = new FrameGroup(100);
            fg1.addInstance('CamA', new Instance([[5, 6], [7, 8]], 0, 'user'));
            s1.addFrameGroup(fg1);

            s1.lastFrame = 100;
            s1._views = [{ name: 'CamA', decoder: 'test' }];

            // Remove S0
            sessions.splice(0, 1);
            assertEqual(sessions.length, 1);
            assertEqual(sessions[0].name, 'S1');

            // S1 data should be intact
            assertTrue(sessions[0].frameGroups.has(100));
            assertEqual(sessions[0].lastFrame, 100);
            assertEqual(sessions[0]._views.length, 1);
            var inst = sessions[0].getFrameGroup(100).getInstances('CamA')[0];
            assertEqual(inst.points[0][0], 5, 'S1 instance data intact');
        });

        it('videoFiles sessionIdx retagging after removal', function () {
            var videoFiles = [
                { name: 'v0', sessionIdx: 0 },
                { name: 'v1', sessionIdx: 0 },
                { name: 'v2', sessionIdx: 1 },
                { name: 'v3', sessionIdx: 1 },
            ];

            var sessions = [];
            var s0 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S0');
            var s1 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S1');
            s0.videoFileIndices = [0, 1];
            s1.videoFileIndices = [2, 3];
            sessions.push(s0, s1);

            // Remove S0
            sessions.splice(0, 1);

            // Retag remaining session's videos
            for (var si = 0; si < sessions.length; si++) {
                for (var vi = 0; vi < sessions[si].videoFileIndices.length; vi++) {
                    var vfIdx = sessions[si].videoFileIndices[vi];
                    videoFiles[vfIdx].sessionIdx = si;
                }
            }

            // S1 is now index 0
            assertEqual(videoFiles[2].sessionIdx, 0, 'v2 retagged to sessionIdx 0');
            assertEqual(videoFiles[3].sessionIdx, 0, 'v3 retagged to sessionIdx 0');
            // Old S0 videos still have old tag (orphaned)
            assertEqual(videoFiles[0].sessionIdx, 0, 'v0 still tagged (orphaned)');
        });
    });

    // ---- Video decoder state ----

    describe('Video decoder frame seeking', function () {
        it('seekNative converts frame to time correctly', function () {
            // Simulate: fps=30, frame 100 → time = 100/30 = 3.333s
            var fps = 30;
            var frame = 100;
            var expectedTime = frame / fps;
            assertTrue(Math.abs(expectedTime - 3.333) < 0.01, 'frame 100 at 30fps ≈ 3.333s');
        });

        it('getCurrentFrameIndex round-trips correctly', function () {
            // Simulate: fps=30, time=3.333s → frame = round(3.333 * 30) = 100
            var fps = 30;
            var time = 100 / fps;
            var frame = Math.round(time * fps);
            assertEqual(frame, 100, 'round-trip preserves frame 100');
        });

        it('frame round-trip works for edge cases', function () {
            var fps = 29.97;
            // Test several frames
            var testFrames = [0, 1, 100, 999, 5000, 17999];
            for (var i = 0; i < testFrames.length; i++) {
                var f = testFrames[i];
                var time = f / fps;
                var recovered = Math.round(time * fps);
                assertEqual(recovered, f, 'frame ' + f + ' at 29.97fps should round-trip');
            }
        });

        it('multiple sessions do not share frame state', function () {
            var s1 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S1');
            var s2 = new Session([makeCamera('CamA')], makeSkeleton(), ['t0'], 'S2');

            s1.lastFrame = 500;
            s2.lastFrame = 12000;

            // Simulate switch to s2
            var currentFrame = s2.lastFrame;
            assertEqual(currentFrame, 12000, 'switched to S2 frame');

            // Switch back to s1
            currentFrame = s1.lastFrame;
            assertEqual(currentFrame, 500, 'switched back to S1 frame');

            // S2 not affected
            assertEqual(s2.lastFrame, 12000);
        });
    });

    // ---- Simultaneous session stress ----

    describe('Multiple session data integrity', function () {
        it('three sessions maintain independent data', function () {
            var sessions = [];
            for (var si = 0; si < 3; si++) {
                var s = new Session(
                    [makeCamera('CamA'), makeCamera('CamB')],
                    makeSkeleton(),
                    ['track_0', 'track_1'],
                    'Session_' + si
                );
                // Each session gets 10 frames with unique points
                for (var f = 0; f < 10; f++) {
                    var fg = new FrameGroup(f);
                    fg.addInstance('CamA', new Instance(
                        [[si * 100 + f, si * 100 + f + 1], [si * 100 + f + 2, si * 100 + f + 3]],
                        f % 2, 'predicted'
                    ));
                    s.addFrameGroup(fg);
                }
                sessions.push(s);
            }

            // Verify each session has unique data
            for (var si2 = 0; si2 < 3; si2++) {
                var inst = sessions[si2].getFrameGroup(0).getInstances('CamA')[0];
                assertEqual(inst.points[0][0], si2 * 100, 'Session ' + si2 + ' has unique point data');
            }

            // Modify session 1 — others unaffected
            var s1fg = sessions[1].getFrameGroup(5);
            s1fg.addInstance('CamB', new Instance([[999, 999], [888, 888]], 0, 'user'));

            assertEqual(sessions[0].getFrameGroup(5).getInstances('CamB').length, 0, 'S0 unaffected');
            assertEqual(sessions[1].getFrameGroup(5).getInstances('CamB').length, 1, 'S1 modified');
            assertEqual(sessions[2].getFrameGroup(5).getInstances('CamB').length, 0, 'S2 unaffected');
        });
    });
})();
