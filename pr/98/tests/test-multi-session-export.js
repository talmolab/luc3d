/**
 * test-multi-session-export.js — Tests for multi-session data isolation,
 * SLP export correctness, and session folder import merging.
 */

(function () {
    const { describe, it, beforeEach, assertEqual, assertDeepEqual, assertNotNull,
        assertTrue, assertFalse, assertGreaterThan, assertNull } = TestFramework;

    // ---- Helpers ----

    function makeCamera(name) {
        return new Camera(
            name,
            [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0],
            [0.1, 0.2, 0.3],
            [10, 20, 30],
            [640, 480]
        );
    }

    function makeSkeleton() {
        return new Skeleton('test_skeleton', ['head', 'thorax', 'tail'], [[0, 1], [1, 2]]);
    }

    function makeInstance(points, trackIdx, type, score) {
        return new Instance(points || [[100, 200], [150, 250], [200, 300]], trackIdx || 0, type || 'user', score || 1.0);
    }

    function makeSession(camNames, name) {
        var cameras = camNames.map(function (n) { return makeCamera(n); });
        return new Session(cameras, makeSkeleton(), ['track_0', 'track_1'], name || 'TestSession');
    }

    // ---- Session Data Isolation ----

    describe('Multi-Session Data Isolation', function () {
        var session1, session2;

        beforeEach(function () {
            session1 = makeSession(['CamA', 'CamB'], 'Session1');
            session2 = makeSession(['CamC', 'CamD'], 'Session2');
        });

        it('sessions have independent frameGroups', function () {
            var fg1 = new FrameGroup(0);
            fg1.addInstance('CamA', makeInstance([[10, 20], [30, 40], [50, 60]], 0, 'user'));
            session1.addFrameGroup(fg1);

            var fg2 = new FrameGroup(0);
            fg2.addInstance('CamC', makeInstance([[70, 80], [90, 100], [110, 120]], 0, 'predicted'));
            session2.addFrameGroup(fg2);

            // Session1 has frame 0 with CamA instances
            assertTrue(session1.frameGroups.has(0), 'session1 should have frame 0');
            var s1Instances = session1.getFrameGroup(0).getInstances('CamA');
            assertEqual(s1Instances.length, 1, 'session1 CamA should have 1 instance');
            assertEqual(s1Instances[0].type, 'user');

            // Session2 has frame 0 with CamC instances
            var s2Instances = session2.getFrameGroup(0).getInstances('CamC');
            assertEqual(s2Instances.length, 1, 'session2 CamC should have 1 instance');
            assertEqual(s2Instances[0].type, 'predicted');

            // Session1 should NOT have CamC data
            var s1CamC = session1.getFrameGroup(0).getInstances('CamC');
            assertEqual(s1CamC.length, 0, 'session1 should have no CamC data');
        });

        it('sessions have independent instanceGroups', function () {
            assertEqual(session1.instanceGroups.size, 0);
            assertEqual(session2.instanceGroups.size, 0);

            // Add instanceGroup to session1 only
            var ig = new InstanceGroup(0);
            ig.addInstance('CamA', makeInstance(null, 0, 'user'));
            if (!session1.instanceGroups.has(0)) session1.instanceGroups.set(0, []);
            session1.instanceGroups.get(0).push(ig);

            assertGreaterThan(session1.instanceGroups.size, 0, 'session1 should have instanceGroups');
            assertEqual(session2.instanceGroups.size, 0, 'session2 should remain empty');
        });

        it('sessions have independent skeletons', function () {
            session1.skeleton = new Skeleton('skel1', ['a', 'b'], [[0, 1]]);
            session2.skeleton = new Skeleton('skel2', ['x', 'y', 'z'], [[0, 1], [1, 2]]);

            assertEqual(session1.skeleton.nodes.length, 2);
            assertEqual(session2.skeleton.nodes.length, 3);
            assertEqual(session1.skeleton.name, 'skel1');
            assertEqual(session2.skeleton.name, 'skel2');
        });

        it('sessions have independent tracks', function () {
            session1.tracks = ['animal_1', 'animal_2'];
            session2.tracks = ['fly_A', 'fly_B', 'fly_C'];

            assertEqual(session1.tracks.length, 2);
            assertEqual(session2.tracks.length, 3);
            assertEqual(session1.tracks[0], 'animal_1');
            assertEqual(session2.tracks[0], 'fly_A');
        });

        it('sessions have independent cameras', function () {
            assertEqual(session1.cameras.length, 2);
            assertEqual(session2.cameras.length, 2);
            assertEqual(session1.cameras[0].name, 'CamA');
            assertEqual(session2.cameras[0].name, 'CamC');
        });

        it('modifying one session does not affect another', function () {
            // Add frames to session1
            for (var i = 0; i < 5; i++) {
                var fg = new FrameGroup(i);
                fg.addInstance('CamA', makeInstance(null, 0, 'user'));
                session1.addFrameGroup(fg);
            }

            assertEqual(session1.frameGroups.size, 5, 'session1 should have 5 frames');
            assertEqual(session2.frameGroups.size, 0, 'session2 should still have 0 frames');
        });
    });

    // ---- Session videoFileIndices ----

    describe('Session videoFileIndices tracking', function () {
        it('tracks which videoFiles belong to a session', function () {
            var session = makeSession(['CamA', 'CamB'], 'TestSession');
            assertEqual(session.videoFileIndices.length, 0, 'starts empty');

            session.videoFileIndices.push(0);
            session.videoFileIndices.push(1);
            assertEqual(session.videoFileIndices.length, 2);
            assertEqual(session.videoFileIndices[0], 0);
            assertEqual(session.videoFileIndices[1], 1);
        });

        it('different sessions have different videoFileIndices', function () {
            var s1 = makeSession(['CamA'], 'S1');
            var s2 = makeSession(['CamB'], 'S2');

            s1.videoFileIndices.push(0);
            s1.videoFileIndices.push(1);
            s2.videoFileIndices.push(2);
            s2.videoFileIndices.push(3);

            assertDeepEqual(s1.videoFileIndices, [0, 1]);
            assertDeepEqual(s2.videoFileIndices, [2, 3]);
        });
    });

    // ---- Camera Name Lookup in Export ----

    describe('Export camera name resolution', function () {
        it('assignedCamera is the correct key for instance lookup', function () {
            var session = makeSession(['CameraL', 'CameraR'], 'ExportTest');

            // Add user instance under camera name 'CameraL'
            var fg = new FrameGroup(0);
            fg.addInstance('CameraL', makeInstance([[100, 200], [150, 250], [200, 300]], 0, 'user'));
            session.addFrameGroup(fg);

            // Simulate videoFile with different name vs assignedCamera
            var videoFile = {
                file: null,
                name: 'recording_left',    // video filename stem
                assignedCamera: 'CameraL', // actual camera name
                videoWidth: 640,
                videoHeight: 480,
                frameCount: 100,
            };

            // Using vf.name (wrong) would find nothing
            var wrongLookup = session.getFrameGroup(0).getInstances('recording_left');
            assertEqual(wrongLookup.length, 0, 'video stem should NOT match instance camera');

            // Using vf.assignedCamera (correct) finds the instance
            var correctLookup = session.getFrameGroup(0).getInstances('CameraL');
            assertEqual(correctLookup.length, 1, 'assignedCamera should match instance camera');
            assertEqual(correctLookup[0].type, 'user');
        });

        it('unlinked instances also use camera name not video name', function () {
            var session = makeSession(['CameraL'], 'UnlinkedTest');
            var fg = new FrameGroup(0);

            var inst = makeInstance(null, 0, 'user');
            var ul = new UnlinkedInstance(inst, 'CameraL');
            fg.addUnlinkedInstance('CameraL', ul);
            session.addFrameGroup(fg);

            // Wrong key finds nothing
            var wrongUl = fg.getUnlinkedInstances('recording_left');
            assertEqual(wrongUl.length, 0);

            // Correct key finds the unlinked instance
            var correctUl = fg.getUnlinkedInstances('CameraL');
            assertEqual(correctUl.length, 1);
        });
    });

    // ---- buildSlpExportData with correct session ----

    describe('buildSlpExportData multi-session correctness', function () {
        it('exports only the given session data', function () {
            var session1 = makeSession(['CamA', 'CamB'], 'Session1');
            var session2 = makeSession(['CamC', 'CamD'], 'Session2');

            // Add data to session1
            var fg1 = new FrameGroup(0);
            fg1.addInstance('CamA', makeInstance([[10, 20], [30, 40], [50, 60]], 0, 'user'));
            fg1.addInstance('CamB', makeInstance([[15, 25], [35, 45], [55, 65]], 0, 'user'));
            session1.addFrameGroup(fg1);

            // Add data to session2
            var fg2 = new FrameGroup(0);
            fg2.addInstance('CamC', makeInstance([[70, 80], [90, 100], [110, 120]], 0, 'predicted'));
            session2.addFrameGroup(fg2);

            var views1 = [
                { name: 'CamA', videoWidth: 640, videoHeight: 480, frameCount: 100 },
                { name: 'CamB', videoWidth: 640, videoHeight: 480, frameCount: 100 },
            ];

            var data1 = buildSlpExportData(session1, views1);
            assertNotNull(data1, 'export data should not be null');
            assertEqual(data1.videos.length, 2, 'should have 2 videos for session1');

            // Instances should come from session1 only
            assertGreaterThan(data1.instances.length, 0, 'should have instances from session1');

            // Now export session2
            var views2 = [
                { name: 'CamC', videoWidth: 640, videoHeight: 480, frameCount: 100 },
                { name: 'CamD', videoWidth: 640, videoHeight: 480, frameCount: 100 },
            ];
            var data2 = buildSlpExportData(session2, views2);
            assertEqual(data2.videos.length, 2, 'should have 2 videos for session2');
            assertGreaterThan(data2.instances.length, 0, 'should have instances from session2');
        });

        it('exports correct video paths from videoFiles', function () {
            var session = makeSession(['CamA'], 'PathTest');
            var fg = new FrameGroup(0);
            fg.addInstance('CamA', makeInstance(null, 0, 'user'));
            session.addFrameGroup(fg);

            var views = [{ name: 'CamA', videoWidth: 640, videoHeight: 480, frameCount: 50 }];
            var videoFiles = [{
                name: 'recording',
                assignedCamera: 'CamA',
                videoPath: 'session1/CamA/recording.mp4',
            }];

            var data = buildSlpExportData(session, views, videoFiles);
            assertEqual(data.videos[0].filename, 'session1/CamA/recording.mp4');
        });

        it('empty session produces empty export', function () {
            var session = makeSession(['CamA'], 'EmptySession');
            var views = [{ name: 'CamA', videoWidth: 640, videoHeight: 480, frameCount: 100 }];
            var data = buildSlpExportData(session, views);
            assertEqual(data.instances.length, 0, 'no instances from empty session');
            assertEqual(data.frames.length, 0, 'no frames from empty session');
        });
    });

    // ---- FrameGroup instance merging (import) ----

    describe('FrameGroup instance merging (multi-file import)', function () {
        it('addInstance accumulates instances for same camera', function () {
            var fg = new FrameGroup(0);

            // First file: predicted instances
            fg.addInstance('CamA', makeInstance([[10, 20], [30, 40], [50, 60]], 0, 'predicted', 0.9));
            fg.addInstance('CamA', makeInstance([[12, 22], [32, 42], [52, 62]], 1, 'predicted', 0.8));

            // Second file: user instances (simulates loading .slp after .h5)
            fg.addInstance('CamA', makeInstance([[100, 200], [150, 250], [200, 300]], 0, 'user'));

            var instances = fg.getInstances('CamA');
            assertEqual(instances.length, 3, 'should have all 3 instances merged');

            // Check types
            var predicted = instances.filter(function (i) { return i.type === 'predicted'; });
            var user = instances.filter(function (i) { return i.type === 'user'; });
            assertEqual(predicted.length, 2, 'should have 2 predicted');
            assertEqual(user.length, 1, 'should have 1 user');
        });

        it('addInstance works across different cameras independently', function () {
            var fg = new FrameGroup(0);

            fg.addInstance('CamA', makeInstance(null, 0, 'predicted'));
            fg.addInstance('CamB', makeInstance(null, 0, 'user'));
            fg.addInstance('CamA', makeInstance(null, 0, 'user'));

            assertEqual(fg.getInstances('CamA').length, 2);
            assertEqual(fg.getInstances('CamB').length, 1);
        });

        it('unlinked instances from different files merge correctly', function () {
            var fg = new FrameGroup(0);

            // File 1: predictions
            var predInst = makeInstance(null, 0, 'predicted');
            fg.addUnlinkedInstance('CamA', new UnlinkedInstance(predInst, 'CamA'));

            // File 2: user labels
            var userInst = makeInstance(null, 0, 'user');
            fg.addUnlinkedInstance('CamA', new UnlinkedInstance(userInst, 'CamA'));

            var unlinked = fg.getUnlinkedInstances('CamA');
            assertEqual(unlinked.length, 2, 'both unlinked instances should be present');
            // Verify distinct IDs
            assertTrue(unlinked[0].id !== unlinked[1].id, 'unlinked instances should have unique IDs');
        });
    });

    // ---- Track merging ----

    describe('Track merging across files', function () {
        it('new tracks from a second file get appended without duplicates', function () {
            var session = makeSession(['CamA'], 'TrackMergeTest');
            // Session starts with ['track_0', 'track_1']
            assertEqual(session.tracks.length, 2);

            // Simulate second file with overlapping and new tracks
            var newTracks = ['track_0', 'track_1', 'track_2'];
            for (var i = 0; i < newTracks.length; i++) {
                if (session.tracks.indexOf(newTracks[i]) < 0) {
                    session.tracks.push(newTracks[i]);
                }
            }

            assertEqual(session.tracks.length, 3, 'should have 3 unique tracks');
            assertEqual(session.tracks[2], 'track_2');
        });

        it('tracks from different files with different names all appear', function () {
            var session = makeSession(['CamA'], 'TrackMergeTest2');
            session.tracks = ['animal_0'];

            var file2Tracks = ['fly_1', 'fly_2'];
            for (var i = 0; i < file2Tracks.length; i++) {
                if (session.tracks.indexOf(file2Tracks[i]) < 0) {
                    session.tracks.push(file2Tracks[i]);
                }
            }

            assertEqual(session.tracks.length, 3);
            assertDeepEqual(session.tracks, ['animal_0', 'fly_1', 'fly_2']);
        });
    });

    // ---- Multi-session state simulation ----

    describe('Multi-session state management', function () {
        it('sessions array holds multiple independent sessions', function () {
            var sessions = [];
            var s1 = makeSession(['CamA', 'CamB'], 'Recording1');
            var s2 = makeSession(['CamC', 'CamD'], 'Recording2');
            var s3 = makeSession(['CamE'], 'Recording3');
            sessions.push(s1, s2, s3);

            assertEqual(sessions.length, 3);
            assertEqual(sessions[0].name, 'Recording1');
            assertEqual(sessions[1].name, 'Recording2');
            assertEqual(sessions[2].name, 'Recording3');
        });

        it('videoFiles can be filtered by sessionIdx', function () {
            var videoFiles = [
                { name: 'vid1', assignedCamera: 'CamA', sessionIdx: 0 },
                { name: 'vid2', assignedCamera: 'CamB', sessionIdx: 0 },
                { name: 'vid3', assignedCamera: 'CamC', sessionIdx: 1 },
                { name: 'vid4', assignedCamera: 'CamD', sessionIdx: 1 },
                { name: 'vid5', assignedCamera: 'CamE', sessionIdx: 2 },
            ];

            var session0Files = videoFiles.filter(function (vf) { return vf.sessionIdx === 0; });
            var session1Files = videoFiles.filter(function (vf) { return vf.sessionIdx === 1; });
            var session2Files = videoFiles.filter(function (vf) { return vf.sessionIdx === 2; });

            assertEqual(session0Files.length, 2);
            assertEqual(session1Files.length, 2);
            assertEqual(session2Files.length, 1);
            assertEqual(session0Files[0].assignedCamera, 'CamA');
            assertEqual(session1Files[0].assignedCamera, 'CamC');
        });

        it('export collects correct stats per session', function () {
            var session1 = makeSession(['CamA'], 'S1');
            var session2 = makeSession(['CamA'], 'S2');

            // Session1: 3 user instances across 2 frames
            var fg1a = new FrameGroup(0);
            fg1a.addInstance('CamA', makeInstance(null, 0, 'user'));
            fg1a.addInstance('CamA', makeInstance(null, 1, 'user'));
            session1.addFrameGroup(fg1a);

            var fg1b = new FrameGroup(5);
            fg1b.addInstance('CamA', makeInstance(null, 0, 'user'));
            session1.addFrameGroup(fg1b);

            // Session2: 1 predicted instance on 1 frame
            var fg2a = new FrameGroup(0);
            fg2a.addInstance('CamA', makeInstance(null, 0, 'predicted', 0.95));
            session2.addFrameGroup(fg2a);

            // Compute stats for session1 CamA
            var s1LabeledFrames = 0, s1InstanceCount = 0;
            for (var [idx, fg] of session1.frameGroups) {
                var insts = fg.getInstances('CamA');
                var hasLabeled = false;
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].type === 'user') { hasLabeled = true; s1InstanceCount++; }
                }
                if (hasLabeled) s1LabeledFrames++;
            }

            assertEqual(s1LabeledFrames, 2, 'session1 should have 2 labeled frames');
            assertEqual(s1InstanceCount, 3, 'session1 should have 3 user instances');

            // Compute stats for session2 CamA
            var s2LabeledFrames = 0, s2InstanceCount = 0;
            for (var [idx, fg] of session2.frameGroups) {
                var insts = fg.getInstances('CamA');
                for (var i = 0; i < insts.length; i++) {
                    if (insts[i].type === 'user') s2InstanceCount++;
                    if (insts[i].type === 'predicted') s2LabeledFrames++;
                }
            }

            assertEqual(s2InstanceCount, 0, 'session2 should have 0 user instances');
            assertEqual(s2LabeledFrames, 1, 'session2 should have 1 predicted frame');
        });
    });

    // ---- buildSlpExportData per-camera view filtering ----

    describe('buildSlpExportData per-camera behavior', function () {
        it('includes instances for all cameras in session', function () {
            var session = makeSession(['CamA', 'CamB'], 'AllCamsTest');

            var fg = new FrameGroup(0);
            fg.addInstance('CamA', makeInstance(null, 0, 'user'));
            fg.addInstance('CamB', makeInstance(null, 0, 'user'));
            session.addFrameGroup(fg);

            var views = [
                { name: 'CamA', videoWidth: 640, videoHeight: 480, frameCount: 100 },
                { name: 'CamB', videoWidth: 640, videoHeight: 480, frameCount: 100 },
            ];

            var data = buildSlpExportData(session, views);
            assertEqual(data.videos.length, 2, 'should have 2 videos');
            // 2 cameras with instances on frame 0 => 2 frame entries, 2 instances
            assertEqual(data.instances.length, 2, 'should have instance per camera');
            assertEqual(data.frames.length, 2, 'should have frame entry per camera');
        });

        it('handles session with no instances gracefully', function () {
            var session = makeSession(['CamA'], 'NoInstances');
            var views = [{ name: 'CamA', videoWidth: 640, videoHeight: 480, frameCount: 50 }];
            var data = buildSlpExportData(session, views);

            assertNotNull(data);
            assertEqual(data.instances.length, 0);
            assertEqual(data.frames.length, 0);
            assertEqual(data.videos.length, 1);
        });
    });

    // ---- Unlinked instance export ----

    describe('Export includes unlinked instances', function () {
        it('buildSlpExportData includes unlinked user instances', function () {
            var session = makeSession(['CamA'], 'UnlinkedExport');
            var fg = new FrameGroup(0);

            // Add unlinked instance (as happens after session folder import)
            var inst = makeInstance([[100, 200], [150, 250], [200, 300]], 0, 'user');
            var ul = new UnlinkedInstance(inst, 'CamA');
            fg.addUnlinkedInstance('CamA', ul);
            session.addFrameGroup(fg);

            var views = [{ name: 'CamA', videoWidth: 640, videoHeight: 480, frameCount: 100 }];
            var data = buildSlpExportData(session, views);

            assertGreaterThan(data.instances.length, 0, 'should export unlinked instances');
        });

        it('buildSlpExportData includes both grouped and unlinked instances', function () {
            var session = makeSession(['CamA'], 'MixedExport');
            var fg = new FrameGroup(0);

            // Grouped instance
            fg.addInstance('CamA', makeInstance([[10, 20], [30, 40], [50, 60]], 0, 'user'));

            // Unlinked instance
            var inst = makeInstance([[100, 200], [150, 250], [200, 300]], 1, 'user');
            fg.addUnlinkedInstance('CamA', new UnlinkedInstance(inst, 'CamA'));

            session.addFrameGroup(fg);

            var views = [{ name: 'CamA', videoWidth: 640, videoHeight: 480, frameCount: 100 }];
            var data = buildSlpExportData(session, views);

            assertEqual(data.instances.length, 2, 'should have both grouped and unlinked instances');
        });

        it('exports each instance\'s track — grouped AND ungrouped keep their trackIdx', function () {
            // Regression: a flat 2D project (ungrouped/unlinked instances) must
            // export tracks, not trackless. buildSlpExportData writes
            // instance.track = trackIdx for both grouped and unlinked.
            var session = makeSession(['CamA'], 'UngroupedTrackExport'); // tracks: track_0, track_1
            var fg = new FrameGroup(0);

            // Grouped instance on track 0.
            fg.addInstance('CamA', makeInstance([[10, 20], [30, 40], [50, 60]], 0, 'user'));
            // Unlinked instance on track 1 — must keep track 1, not -1.
            var ul = makeInstance([[100, 200], [150, 250], [200, 300]], 1, 'user');
            fg.addUnlinkedInstance('CamA', new UnlinkedInstance(ul, 'CamA'));
            session.addFrameGroup(fg);

            var views = [{ name: 'CamA', videoWidth: 640, videoHeight: 480, frameCount: 100 }];
            var data = buildSlpExportData(session, views);

            assertEqual(data.instances.length, 2, 'both instances exported');
            var trackVals = data.instances.map(function (i) { return i.track; }).sort();
            assertDeepEqual(trackVals, [0, 1], 'grouped → track 0, ungrouped → track 1 (no -1)');
            assertFalse(trackVals.indexOf(-1) >= 0, 'no instance exported trackless');
        });
    });

    // ---- Session name on export ----

    describe('Session naming', function () {
        it('session stores name correctly', function () {
            var session = makeSession(['CamA'], 'My Recording');
            assertEqual(session.name, 'My Recording');
        });

        it('session name defaults to Session 1 if not provided', function () {
            var cameras = [makeCamera('CamA')];
            var session = new Session(cameras, makeSkeleton(), ['track_0']);
            assertEqual(session.name, 'Session 1', 'name should default to Session 1');
        });
    });

    // ---- cameraDirMap for export subdirectories ----

    describe('cameraDirMap for export directory resolution', function () {
        it('maps camera name to original directory name', function () {
            var cameraDirMap = {};

            // Simulate: calibration says "CameraL" but folder is "camera_left"
            cameraDirMap['CameraL'] = 'camera_left';
            cameraDirMap['CameraR'] = 'camera_right';

            assertEqual(cameraDirMap['CameraL'], 'camera_left');
            assertEqual(cameraDirMap['CameraR'], 'camera_right');

            // Fallback for unmapped camera
            var subDir = cameraDirMap['CameraX'] || 'CameraX';
            assertEqual(subDir, 'CameraX');
        });
    });

    // ---- Reprojected instance export ----

    describe('Reprojected instance export via InstanceGroup', function () {
        it('InstanceGroup stores reprojected instances per camera', function () {
            var ig = new InstanceGroup(0);
            ig.addInstance('CamA', makeInstance(null, 0, 'user'));
            ig.addInstance('CamB', makeInstance(null, 0, 'user'));

            // Simulate reprojection
            var reprojA = makeInstance([[10.5, 20.5], [30.5, 40.5], [50.5, 60.5]], 0, 'reprojected');
            var reprojB = makeInstance([[15.5, 25.5], [35.5, 45.5], [55.5, 65.5]], 0, 'reprojected');
            ig.reprojectedInstances = new Map();
            ig.reprojectedInstances.set('CamA', reprojA);
            ig.reprojectedInstances.set('CamB', reprojB);

            var rA = ig.getReprojectedInstance('CamA');
            assertNotNull(rA, 'should have reprojection for CamA');
            assertEqual(rA.type, 'reprojected');

            var rC = ig.getReprojectedInstance('CamC');
            assertNull(rC, 'should not have reprojection for CamC');
        });
    });

    // ---- Edge cases ----

    describe('Export edge cases', function () {
        it('handles session with instances on non-contiguous frames', function () {
            var session = makeSession(['CamA'], 'SparseFrames');

            var fg0 = new FrameGroup(0);
            fg0.addInstance('CamA', makeInstance(null, 0, 'user'));
            session.addFrameGroup(fg0);

            var fg100 = new FrameGroup(100);
            fg100.addInstance('CamA', makeInstance(null, 0, 'user'));
            session.addFrameGroup(fg100);

            var fg999 = new FrameGroup(999);
            fg999.addInstance('CamA', makeInstance(null, 0, 'user'));
            session.addFrameGroup(fg999);

            var views = [{ name: 'CamA', videoWidth: 640, videoHeight: 480, frameCount: 1000 }];
            var data = buildSlpExportData(session, views);

            assertEqual(data.frames.length, 3, 'should have 3 non-contiguous frames');
            assertEqual(data.instances.length, 3, 'should have 3 instances');
        });

        it('handles multiple instances per frame per camera', function () {
            var session = makeSession(['CamA'], 'MultiInstance');
            var fg = new FrameGroup(0);

            for (var i = 0; i < 5; i++) {
                fg.addInstance('CamA', makeInstance(null, i % 2, 'user'));
            }
            session.addFrameGroup(fg);

            var instances = session.getFrameGroup(0).getInstances('CamA');
            assertEqual(instances.length, 5, 'should accumulate 5 instances');

            var views = [{ name: 'CamA', videoWidth: 640, videoHeight: 480, frameCount: 100 }];
            var data = buildSlpExportData(session, views);
            assertEqual(data.instances.length, 5);
        });

        it('handles occluded points in export', function () {
            var session = makeSession(['CamA'], 'OccludedTest');
            var fg = new FrameGroup(0);

            var inst = makeInstance([[100, 200], [150, 250], [200, 300]], 0, 'user');
            inst.occluded = [false, true, false];
            fg.addInstance('CamA', inst);
            session.addFrameGroup(fg);

            var views = [{ name: 'CamA', videoWidth: 640, videoHeight: 480, frameCount: 100 }];
            var data = buildSlpExportData(session, views);

            assertGreaterThan(data.instances.length, 0);
            // Points are a flat array: {x, y, visible, complete} per node
            // 3 nodes => points[0], points[1], points[2]
            assertTrue(data.points[0].visible, 'point 0 should be visible');
            assertFalse(data.points[1].visible, 'point 1 should be occluded');
            assertTrue(data.points[2].visible, 'point 2 should be visible');
        });
    });

    // ---- Multi-skeleton / multi-file import ----

    describe('Multi-file skeleton resolution', function () {
        it('session should use skeleton with most nodes', function () {
            // Simulate: file1 has 3-node skeleton (env), file2 has 5-node skeleton (animal)
            var session = new Session(
                [makeCamera('CamA')],
                new Skeleton('env', ['a', 'b', 'c'], [[0, 1], [1, 2]]),
                ['env_track']
            );
            assertEqual(session.skeleton.nodes.length, 3);

            // After loading second file, skeleton should update to the bigger one
            var biggerSkeleton = new Skeleton('mouse', ['head', 'neck', 'body', 'tail_base', 'tail_tip'],
                [[0, 1], [1, 2], [2, 3], [3, 4]]);
            if (biggerSkeleton.nodes.length > session.skeleton.nodes.length) {
                session.skeleton = biggerSkeleton;
            }

            assertEqual(session.skeleton.nodes.length, 5, 'should use bigger skeleton');
            assertEqual(session.skeleton.name, 'mouse');
        });

        it('should NOT replace skeleton with a smaller one', function () {
            var session = new Session(
                [makeCamera('CamA')],
                new Skeleton('mouse', ['head', 'neck', 'body', 'tail_base', 'tail_tip'],
                    [[0, 1], [1, 2], [2, 3], [3, 4]]),
                ['animal_track']
            );
            assertEqual(session.skeleton.nodes.length, 5);

            // Second file has smaller skeleton — should NOT replace
            var smallerSkeleton = new Skeleton('env', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            if (smallerSkeleton.nodes.length > session.skeleton.nodes.length) {
                session.skeleton = smallerSkeleton;
            }

            assertEqual(session.skeleton.nodes.length, 5, 'should keep the bigger skeleton');
            assertEqual(session.skeleton.name, 'mouse');
        });
    });

    describe('Export with mismatched instance/skeleton node counts', function () {
        it('instances with fewer points than skeleton get padded with NaN', function () {
            // Session has 5-node skeleton
            var session = new Session(
                [makeCamera('CamA')],
                new Skeleton('mouse', ['head', 'neck', 'body', 'tail_base', 'tail_tip'],
                    [[0, 1], [1, 2], [2, 3], [3, 4]]),
                ['track_0']
            );

            // Instance only has 3 points (from env skeleton)
            var fg = new FrameGroup(0);
            var shortInst = new Instance([[10, 20], [30, 40], [50, 60]], 0, 'user');
            fg.addInstance('CamA', shortInst);
            session.addFrameGroup(fg);

            var views = [{ name: 'CamA', videoWidth: 640, videoHeight: 480, frameCount: 100 }];
            var data = buildSlpExportData(session, views);

            assertEqual(data.instances.length, 1, 'should have 1 instance');
            // Points array should have 5 entries (skeleton node count)
            var instData = data.instances[0];
            var pointCount = instData.point_id_end - instData.point_id_start;
            assertEqual(pointCount, 5, 'should have 5 point entries matching skeleton');

            // First 3 should be valid, last 2 should be NaN (no data)
            assertTrue(data.points[0].complete, 'point 0 should be complete');
            assertTrue(data.points[1].complete, 'point 1 should be complete');
            assertTrue(data.points[2].complete, 'point 2 should be complete');
            assertFalse(data.points[3].complete, 'point 3 should be incomplete (no data)');
            assertFalse(data.points[4].complete, 'point 4 should be incomplete (no data)');
            assertTrue(isNaN(data.points[3].x), 'point 3 x should be NaN');
            assertTrue(isNaN(data.points[4].x), 'point 4 x should be NaN');
        });

        it('instances with full points export all correctly', function () {
            var session = new Session(
                [makeCamera('CamA')],
                new Skeleton('mouse', ['head', 'neck', 'body'], [[0, 1], [1, 2]]),
                ['track_0']
            );

            var fg = new FrameGroup(0);
            var fullInst = new Instance([[10, 20], [30, 40], [50, 60]], 0, 'user');
            fg.addInstance('CamA', fullInst);
            session.addFrameGroup(fg);

            var views = [{ name: 'CamA', videoWidth: 640, videoHeight: 480, frameCount: 100 }];
            var data = buildSlpExportData(session, views);

            var instData = data.instances[0];
            var pointCount = instData.point_id_end - instData.point_id_start;
            assertEqual(pointCount, 3, 'should have 3 point entries');

            for (var i = 0; i < 3; i++) {
                assertTrue(data.points[i].complete, 'point ' + i + ' should be complete');
            }
        });
    });

    describe('Track index remapping across files', function () {
        it('tracks with same name map to same session index', function () {
            var session = new Session(
                [makeCamera('CamA')],
                new Skeleton('skel', ['a', 'b'], [[0, 1]]),
                ['track_0', 'track_1']
            );

            // Second file also has track_0, track_1 — should remap to existing
            var file2Tracks = ['track_0', 'track_1'];
            var trackRemap = {};
            for (var ti = 0; ti < file2Tracks.length; ti++) {
                var existingIdx = session.tracks.indexOf(file2Tracks[ti]);
                if (existingIdx >= 0) {
                    trackRemap[ti] = existingIdx;
                } else {
                    trackRemap[ti] = session.tracks.length;
                    session.tracks.push(file2Tracks[ti]);
                }
            }

            assertEqual(trackRemap[0], 0, 'track_0 should map to index 0');
            assertEqual(trackRemap[1], 1, 'track_1 should map to index 1');
            assertEqual(session.tracks.length, 2, 'no new tracks added');
        });

        it('tracks with different names get new indices', function () {
            var session = new Session(
                [makeCamera('CamA')],
                new Skeleton('skel', ['a', 'b'], [[0, 1]]),
                ['env_track']
            );

            // Second file has different track names
            var file2Tracks = ['mouse_0', 'mouse_1'];
            var trackRemap = {};
            for (var ti = 0; ti < file2Tracks.length; ti++) {
                var existingIdx = session.tracks.indexOf(file2Tracks[ti]);
                if (existingIdx >= 0) {
                    trackRemap[ti] = existingIdx;
                } else {
                    trackRemap[ti] = session.tracks.length;
                    session.tracks.push(file2Tracks[ti]);
                }
            }

            assertEqual(trackRemap[0], 1, 'mouse_0 should map to index 1');
            assertEqual(trackRemap[1], 2, 'mouse_1 should map to index 2');
            assertEqual(session.tracks.length, 3, 'session should have 3 tracks total');
            assertDeepEqual(session.tracks, ['env_track', 'mouse_0', 'mouse_1']);
        });

        it('remapped trackIdx is applied to instances correctly', function () {
            var session = new Session(
                [makeCamera('CamA')],
                new Skeleton('skel', ['a', 'b'], [[0, 1]]),
                ['env_track']
            );

            // File 2 tracks: mouse_0 (idx 0 in file) -> idx 1 in session
            var trackRemap = { 0: 1 };
            session.tracks.push('mouse_0');

            var fg = new FrameGroup(0);
            // Raw trackIdx from file is 0, remapped to 1
            var rawTrackIdx = 0;
            var remappedIdx = trackRemap[rawTrackIdx] !== undefined ? trackRemap[rawTrackIdx] : rawTrackIdx;
            var inst = new Instance([[10, 20], [30, 40]], remappedIdx, 'predicted');
            fg.addInstance('CamA', inst);
            session.addFrameGroup(fg);

            var instances = session.getFrameGroup(0).getInstances('CamA');
            assertEqual(instances[0].trackIdx, 1, 'instance should have remapped trackIdx');
        });
    });

    describe('Group by track with mixed skeletons', function () {
        it('groups same trackIdx from different cameras', function () {
            var session = new Session(
                [makeCamera('CamA'), makeCamera('CamB')],
                new Skeleton('mouse', ['head', 'neck', 'body'], [[0, 1], [1, 2]]),
                ['env_track', 'mouse_0']
            );

            var fg = new FrameGroup(0);
            // Track 0 (env) in both cameras
            fg.addInstance('CamA', new Instance([[10, 20], [30, 40], [50, 60]], 0, 'predicted'));
            fg.addInstance('CamB', new Instance([[15, 25], [35, 45], [55, 65]], 0, 'predicted'));
            // Track 1 (mouse) in both cameras
            fg.addInstance('CamA', new Instance([[100, 200], [150, 250], [200, 300]], 1, 'predicted'));
            fg.addInstance('CamB', new Instance([[105, 205], [155, 255], [205, 305]], 1, 'predicted'));
            session.addFrameGroup(fg);

            // Simulate grouping by track
            var trackBuckets = {};
            for (var [camName, instances] of fg.instances) {
                for (var ii = 0; ii < instances.length; ii++) {
                    var tid = instances[ii].trackIdx;
                    if (!trackBuckets[tid]) trackBuckets[tid] = {};
                    if (!trackBuckets[tid][camName]) trackBuckets[tid][camName] = instances[ii];
                }
            }

            // Should have 2 track buckets
            var trackIds = Object.keys(trackBuckets);
            assertEqual(trackIds.length, 2, 'should have 2 track buckets');

            // Track 0 should have 2 cameras
            var track0Cams = Object.keys(trackBuckets[0]);
            assertEqual(track0Cams.length, 2, 'track 0 should span 2 cameras');

            // Track 1 should have 2 cameras
            var track1Cams = Object.keys(trackBuckets[1]);
            assertEqual(track1Cams.length, 2, 'track 1 should span 2 cameras');
        });

        it('filtering by selected tracks excludes unselected', function () {
            var fg = new FrameGroup(0);
            fg.addInstance('CamA', new Instance([[10, 20]], 0, 'predicted'));
            fg.addInstance('CamA', new Instance([[100, 200]], 1, 'predicted'));
            fg.addInstance('CamB', new Instance([[15, 25]], 0, 'predicted'));
            fg.addInstance('CamB', new Instance([[105, 205]], 1, 'predicted'));

            var selectedTrackIndices = [1]; // only mouse, not env
            var trackBuckets = {};
            for (var [camName, instances] of fg.instances) {
                for (var ii = 0; ii < instances.length; ii++) {
                    var tid = instances[ii].trackIdx;
                    if (selectedTrackIndices.indexOf(tid) < 0) continue;
                    if (!trackBuckets[tid]) trackBuckets[tid] = {};
                    if (!trackBuckets[tid][camName]) trackBuckets[tid][camName] = instances[ii];
                }
            }

            var trackIds = Object.keys(trackBuckets);
            assertEqual(trackIds.length, 1, 'should only have track 1');
            assertEqual(trackIds[0], '1');
        });

        it('filtering by selected cameras excludes unselected', function () {
            var fg = new FrameGroup(0);
            fg.addInstance('CamA', new Instance([[10, 20]], 0, 'predicted'));
            fg.addInstance('CamB', new Instance([[15, 25]], 0, 'predicted'));
            fg.addInstance('CamC', new Instance([[20, 30]], 0, 'predicted'));

            var selectedCameraNames = ['CamA', 'CamB']; // exclude CamC
            var trackBuckets = {};
            for (var [camName, instances] of fg.instances) {
                if (selectedCameraNames.indexOf(camName) < 0) continue;
                for (var ii = 0; ii < instances.length; ii++) {
                    var tid = instances[ii].trackIdx;
                    if (!trackBuckets[tid]) trackBuckets[tid] = {};
                    if (!trackBuckets[tid][camName]) trackBuckets[tid][camName] = instances[ii];
                }
            }

            var cams = Object.keys(trackBuckets[0]);
            assertEqual(cams.length, 2, 'should only have CamA and CamB');
            assertTrue(cams.indexOf('CamA') >= 0);
            assertTrue(cams.indexOf('CamB') >= 0);
            assertTrue(cams.indexOf('CamC') < 0, 'CamC should be excluded');
        });
    });

    // ---- Environment file separation ----

    describe('Environment file detection and skeleton isolation', function () {
        it('externals files are detected by filename pattern', function () {
            var testFiles = [
                'back.mp4.predictions.static.externals.slp',
                'back.mp4.predictions.proofread.slp.analysis.h5',
                'back.mp4.predictions.slp',
                'cam1.EXTERNALS.slp',
            ];

            var slps = [];
            var envSlps = [];
            for (var i = 0; i < testFiles.length; i++) {
                var fnLower = testFiles[i].toLowerCase();
                if (fnLower.indexOf('.externals.') >= 0) {
                    envSlps.push(testFiles[i]);
                } else {
                    slps.push(testFiles[i]);
                }
            }

            assertEqual(envSlps.length, 2, 'should detect 2 env files');
            assertEqual(slps.length, 2, 'should have 2 main files');
            assertTrue(envSlps[0].indexOf('externals') >= 0);
            assertTrue(envSlps[1].indexOf('EXTERNALS') >= 0);
        });

        it('env skeleton should NOT replace main session skeleton', function () {
            var animalSkeleton = new Skeleton('mouse',
                ['head', 'neck', 'thorax', 'abdomen', 'tail_base'],
                [[0, 1], [1, 2], [2, 3], [3, 4]]);
            var envSkeleton = new Skeleton('arena',
                ['corner1', 'corner2', 'corner3', 'corner4', 'edge1', 'edge2'],
                [[0, 1], [1, 2], [2, 3], [3, 0]]);

            var session = new Session(
                [makeCamera('CamA')],
                animalSkeleton,
                ['mouse_0']
            );

            // Store env skeleton separately
            session.envSkeleton = envSkeleton;

            // Main skeleton should remain animal
            assertEqual(session.skeleton.name, 'mouse');
            assertEqual(session.skeleton.nodes.length, 5);

            // Env skeleton stored separately
            assertEqual(session.envSkeleton.name, 'arena');
            assertEqual(session.envSkeleton.nodes.length, 6);
        });

        it('env instances should NOT be in main frameGroups', function () {
            var session = new Session(
                [makeCamera('CamA')],
                new Skeleton('mouse', ['head', 'neck', 'body'], [[0, 1], [1, 2]]),
                ['mouse_0']
            );

            // Main instances
            var fg = new FrameGroup(0);
            fg.addInstance('CamA', new Instance([[100, 200], [150, 250], [200, 300]], 0, 'predicted'));
            session.addFrameGroup(fg);

            // Env instances stored separately
            session.envFrames = new Map();
            session.envFrames.set(0, {
                'CamA': [{ points: [[10, 20], [30, 40], [50, 60], [70, 80]], trackIdx: 0 }]
            });

            // Main frameGroups should only have 1 instance (animal)
            var mainInstances = session.getFrameGroup(0).getInstances('CamA');
            assertEqual(mainInstances.length, 1, 'main should have only animal instance');
            assertEqual(mainInstances[0].points.length, 3, 'animal has 3 nodes');

            // Env data is separate
            var envFrame = session.envFrames.get(0);
            assertEqual(envFrame['CamA'].length, 1, 'env should have 1 instance');
            assertEqual(envFrame['CamA'][0].points.length, 4, 'env has 4 nodes');
        });

        it('export should only include main instances, not env', function () {
            var session = new Session(
                [makeCamera('CamA')],
                new Skeleton('mouse', ['head', 'neck', 'body'], [[0, 1], [1, 2]]),
                ['mouse_0']
            );

            // Add animal instance to main frameGroups
            var fg = new FrameGroup(0);
            fg.addInstance('CamA', new Instance([[100, 200], [150, 250], [200, 300]], 0, 'user'));
            session.addFrameGroup(fg);

            // Env data stored separately (not in frameGroups)
            session.envFrames = new Map();
            session.envFrames.set(0, {
                'CamA': [{ points: [[10, 20], [30, 40]], trackIdx: 0 }]
            });

            var views = [{ name: 'CamA', videoWidth: 640, videoHeight: 480, frameCount: 100 }];
            var data = buildSlpExportData(session, views);

            // Should only export 1 instance (animal), not the env
            assertEqual(data.instances.length, 1, 'should only export animal instance');
            // Points should be 3 (animal skeleton nodes), not 2 (env)
            var pointCount = data.instances[0].point_id_end - data.instances[0].point_id_start;
            assertEqual(pointCount, 3, 'should have 3 points from animal skeleton');
        });

        it('edges from animal skeleton should not be applied to env instances', function () {
            var animalSkeleton = new Skeleton('mouse',
                ['head', 'neck', 'body'],
                [[0, 1], [1, 2]]);  // head->neck->body
            var envSkeleton = new Skeleton('arena',
                ['corner1', 'corner2', 'corner3', 'corner4'],
                [[0, 1], [1, 2], [2, 3], [3, 0]]);  // rectangle

            // These are different edge sets
            assertEqual(animalSkeleton.edges.length, 2, 'animal has 2 edges');
            assertEqual(envSkeleton.edges.length, 4, 'env has 4 edges');

            // If env instance points were rendered with animal edges,
            // edge [1,2] would connect env corner2->corner3 (wrong)
            // instead of the intended env edge pattern
            assertTrue(animalSkeleton.edges[0][0] !== envSkeleton.edges[3][0] ||
                animalSkeleton.edges[0][1] !== envSkeleton.edges[3][1],
                'different skeletons should have different edge definitions');
        });
    });

})();
