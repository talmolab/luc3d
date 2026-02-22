/**
 * test-multi-video.js - Tests for multi-video loading and session management.
 *
 * Tests: dynamic camera creation, view creation for multiple videos,
 * grid layout computation, and camera assignment for incrementally loaded videos.
 */

(function () {
    const { describe, it, beforeEach, assertEqual, assertNotNull,
        assertTrue, assertFalse } = TestFramework;

    // Helper: create a minimal video file entry
    function makeVideoFile(name, width, height, frameCount) {
        return {
            file: null,
            name: name,
            decoder: null,
            videoWidth: width || 640,
            videoHeight: height || 480,
            frameCount: frameCount || 100,
            assignedCamera: null,
        };
    }

    describe('Multi-Video - Session Creation', function () {
        it('creates session with cameras for all initial videos', function () {
            var videoFiles = [makeVideoFile('back'), makeVideoFile('left'), makeVideoFile('right')];
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);

            // Simulate: create session with cameras for each video
            var cameras = videoFiles.map(function (vf) {
                return new Camera(vf.name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            });
            var session = new Session(cameras, skeleton, ['track_0']);

            assertEqual(session.cameras.length, 3);
            assertEqual(session.cameras[0].name, 'back');
            assertEqual(session.cameras[1].name, 'left');
            assertEqual(session.cameras[2].name, 'right');
        });
    });

    describe('Multi-Video - Dynamic Camera Addition', function () {
        var state;

        beforeEach(function () {
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var cameras = [
                new Camera('back', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            state = {
                videoFiles: [makeVideoFile('back')],
                views: [],
                session: new Session(cameras, skeleton, ['track_0']),
            };
            state.videoFiles[0].assignedCamera = 'back';
        });

        it('adds camera for new video to existing session', function () {
            // Add a second video
            var newVf = makeVideoFile('left');
            state.videoFiles.push(newVf);

            // Simulate the logic from handleLoadVideos: add camera if not exists
            var vf = state.videoFiles[1];
            if (!vf.assignedCamera) {
                var cameraExists = state.session.cameras.some(function (c) { return c.name === vf.name; });
                if (!cameraExists) {
                    state.session.cameras.push(
                        new Camera(vf.name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                            [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])
                    );
                }
                vf.assignedCamera = vf.name;
            }

            assertEqual(state.session.cameras.length, 2, 'Should have 2 cameras');
            assertEqual(state.session.cameras[1].name, 'left');
            assertEqual(vf.assignedCamera, 'left');
        });

        it('does not duplicate camera if it already exists', function () {
            // Try to add another video with same name as existing camera
            var dupVf = makeVideoFile('back');
            state.videoFiles.push(dupVf);

            var vf = state.videoFiles[1];
            var cameraExists = state.session.cameras.some(function (c) { return c.name === vf.name; });
            if (!cameraExists) {
                state.session.cameras.push(
                    new Camera(vf.name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                        [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])
                );
            }
            vf.assignedCamera = vf.name;

            assertEqual(state.session.cameras.length, 1, 'Should still have 1 camera');
        });

        it('adds multiple new cameras incrementally', function () {
            var newNames = ['left', 'right', 'top'];
            for (var k = 0; k < newNames.length; k++) {
                var vf = makeVideoFile(newNames[k]);
                state.videoFiles.push(vf);

                if (!vf.assignedCamera) {
                    var exists = state.session.cameras.some(function (c) { return c.name === vf.name; });
                    if (!exists) {
                        state.session.cameras.push(
                            new Camera(vf.name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])
                        );
                    }
                    vf.assignedCamera = vf.name;
                }
            }

            assertEqual(state.session.cameras.length, 4, 'Should have 4 cameras total');
            assertEqual(state.videoFiles.length, 4, 'Should have 4 video files');
        });
    });

    describe('Multi-Video - View Creation Logic', function () {
        it('creates views for all assigned videos', function () {
            var views = [];
            var videoFiles = [
                makeVideoFile('back'),
                makeVideoFile('left'),
                makeVideoFile('right'),
            ];

            // Assign all
            videoFiles[0].assignedCamera = 'back';
            videoFiles[1].assignedCamera = 'left';
            videoFiles[2].assignedCamera = 'right';

            // Simulate createViewForVideoFile logic (simplified)
            for (var i = 0; i < videoFiles.length; i++) {
                var vf = videoFiles[i];
                if (vf.assignedCamera) {
                    var hasView = views.some(function (v) { return v.name === vf.assignedCamera; });
                    if (!hasView) {
                        views.push({ name: vf.assignedCamera, videoWidth: vf.videoWidth, videoHeight: vf.videoHeight });
                    }
                }
            }

            assertEqual(views.length, 3);
            assertEqual(views[0].name, 'back');
            assertEqual(views[1].name, 'left');
            assertEqual(views[2].name, 'right');
        });

        it('does not create duplicate views', function () {
            var views = [{ name: 'back' }];
            var videoFiles = [makeVideoFile('back')];
            videoFiles[0].assignedCamera = 'back';

            for (var i = 0; i < videoFiles.length; i++) {
                var vf = videoFiles[i];
                if (vf.assignedCamera) {
                    var hasView = views.some(function (v) { return v.name === vf.assignedCamera; });
                    if (!hasView) {
                        views.push({ name: vf.assignedCamera });
                    }
                }
            }

            assertEqual(views.length, 1, 'Should still have only 1 view');
        });

        it('handles incremental video loading (add second video later)', function () {
            var views = [];
            var videoFiles = [];

            // First load: 1 video
            videoFiles.push(makeVideoFile('back'));
            videoFiles[0].assignedCamera = 'back';

            for (var i = 0; i < videoFiles.length; i++) {
                var vf = videoFiles[i];
                if (vf.assignedCamera) {
                    var hasView = views.some(function (v) { return v.name === vf.assignedCamera; });
                    if (!hasView) {
                        views.push({ name: vf.assignedCamera });
                    }
                }
            }
            assertEqual(views.length, 1, 'After first load: 1 view');

            // Second load: add another video
            videoFiles.push(makeVideoFile('left'));
            videoFiles[1].assignedCamera = 'left';

            for (var j = 0; j < videoFiles.length; j++) {
                var vf2 = videoFiles[j];
                if (vf2.assignedCamera) {
                    var hasView2 = views.some(function (v) { return v.name === vf2.assignedCamera; });
                    if (!hasView2) {
                        views.push({ name: vf2.assignedCamera });
                    }
                }
            }
            assertEqual(views.length, 2, 'After second load: 2 views');
            assertEqual(views[1].name, 'left');
        });
    });

    describe('Multi-Video - Grid Layout', function () {
        it('1 video = 1 column', function () {
            var cols = Math.ceil(Math.sqrt(1));
            assertEqual(cols, 1);
        });

        it('2 videos = 2 columns', function () {
            var cols = Math.ceil(Math.sqrt(2));
            assertEqual(cols, 2);
        });

        it('3 videos = 2 columns', function () {
            var cols = Math.ceil(Math.sqrt(3));
            assertEqual(cols, 2);
        });

        it('4 videos = 2 columns', function () {
            var cols = Math.ceil(Math.sqrt(4));
            assertEqual(cols, 2);
        });

        it('5 videos = 3 columns', function () {
            var cols = Math.ceil(Math.sqrt(5));
            assertEqual(cols, 3);
        });

        it('9 videos = 3 columns', function () {
            var cols = Math.ceil(Math.sqrt(9));
            assertEqual(cols, 3);
        });
    });

    describe('Multi-Video - Total Frames Computation', function () {
        it('totalFrames is max across all video files', function () {
            var videoFiles = [
                makeVideoFile('back', 640, 480, 100),
                makeVideoFile('left', 640, 480, 200),
                makeVideoFile('right', 640, 480, 150),
            ];

            var totalFrames = 0;
            for (var i = 0; i < videoFiles.length; i++) {
                if (videoFiles[i].frameCount > totalFrames) {
                    totalFrames = videoFiles[i].frameCount;
                }
            }

            assertEqual(totalFrames, 200, 'Total frames should be max across videos');
        });

        it('totalFrames stays same when shorter video is added', function () {
            var totalFrames = 200;
            var newVideo = makeVideoFile('top', 640, 480, 100);

            if (newVideo.frameCount > totalFrames) {
                totalFrames = newVideo.frameCount;
            }

            assertEqual(totalFrames, 200, 'Should not decrease');
        });

        it('totalFrames updates when longer video is added', function () {
            var totalFrames = 200;
            var newVideo = makeVideoFile('top', 640, 480, 500);

            if (newVideo.frameCount > totalFrames) {
                totalFrames = newVideo.frameCount;
            }

            assertEqual(totalFrames, 500, 'Should increase to 500');
        });
    });

    describe('Multi-Video - Auto-Assignment', function () {
        it('auto-assigns videos to cameras with matching names', function () {
            var skeleton = new Skeleton('test', ['a'], []);
            var cameras = [
                new Camera('back', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
                new Camera('left', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            var session = new Session(cameras, skeleton, ['track_0']);

            var videoFiles = [makeVideoFile('back'), makeVideoFile('left')];
            var cameraNames = session.cameras.map(function (c) { return c.name; });

            for (var i = 0; i < videoFiles.length; i++) {
                var vf = videoFiles[i];
                if (!vf.assignedCamera && cameraNames.indexOf(vf.name) >= 0) {
                    vf.assignedCamera = vf.name;
                }
            }

            assertEqual(videoFiles[0].assignedCamera, 'back');
            assertEqual(videoFiles[1].assignedCamera, 'left');
        });

        it('leaves unmatched videos unassigned', function () {
            var skeleton = new Skeleton('test', ['a'], []);
            var cameras = [
                new Camera('back', [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            var session = new Session(cameras, skeleton, ['track_0']);

            var videoFiles = [makeVideoFile('front')]; // no matching camera
            var cameraNames = session.cameras.map(function (c) { return c.name; });

            for (var i = 0; i < videoFiles.length; i++) {
                var vf = videoFiles[i];
                if (!vf.assignedCamera && cameraNames.indexOf(vf.name) >= 0) {
                    vf.assignedCamera = vf.name;
                }
            }

            assertTrue(videoFiles[0].assignedCamera === null, 'Should remain unassigned');
        });
    });

})();
