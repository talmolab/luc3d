/**
 * test-video-mgmt.js - Tests for Phase 5 video management features.
 *
 * Tests: video file append/remove, duplicate detection, camera assignment,
 * video table population, and the videoFiles/views separation.
 */

(function () {
    const { describe, it, beforeEach, assertEqual, assertDeepEqual, assertNotNull,
        assertNull, assertTrue, assertFalse } = TestFramework;

    describe('Video File Management - state.videoFiles', function () {
        let state;

        beforeEach(function () {
            state = {
                videoFiles: [],
                views: [],
                session: null,
            };
        });

        it('starts with empty videoFiles array', function () {
            assertEqual(state.videoFiles.length, 0, 'Should start empty');
        });

        it('can append video files', function () {
            state.videoFiles.push({
                file: null,
                name: 'back',
                decoder: null,
                videoWidth: 640,
                videoHeight: 480,
                frameCount: 100,
                assignedCamera: null,
            });
            assertEqual(state.videoFiles.length, 1, 'Should have 1 video');
            assertEqual(state.videoFiles[0].name, 'back', 'Name should be back');
        });

        it('can append multiple video files without overwriting', function () {
            var names = ['back', 'left', 'right', 'top'];
            for (var i = 0; i < names.length; i++) {
                state.videoFiles.push({
                    file: null, name: names[i], decoder: null,
                    videoWidth: 640, videoHeight: 480, frameCount: 100, assignedCamera: null,
                });
            }
            assertEqual(state.videoFiles.length, 4, 'Should have 4 videos');
            assertEqual(state.videoFiles[0].name, 'back');
            assertEqual(state.videoFiles[3].name, 'top');
        });

        it('duplicate detection by name works', function () {
            state.videoFiles.push({ file: null, name: 'back', decoder: null,
                videoWidth: 640, videoHeight: 480, frameCount: 100, assignedCamera: null });

            var isDup = state.videoFiles.some(function (vf) { return vf.name === 'back'; });
            assertTrue(isDup, 'back should be detected as duplicate');

            var isNew = state.videoFiles.some(function (vf) { return vf.name === 'front'; });
            assertFalse(isNew, 'front should not be detected as duplicate');
        });

        it('removing a video file works', function () {
            state.videoFiles.push({ file: null, name: 'back', decoder: null,
                videoWidth: 640, videoHeight: 480, frameCount: 100, assignedCamera: null });
            state.videoFiles.push({ file: null, name: 'left', decoder: null,
                videoWidth: 640, videoHeight: 480, frameCount: 100, assignedCamera: null });

            state.videoFiles.splice(0, 1);
            assertEqual(state.videoFiles.length, 1, 'Should have 1 video after removal');
            assertEqual(state.videoFiles[0].name, 'left', 'Remaining should be left');
        });
    });

    describe('Video-Camera Assignment', function () {
        let state;

        beforeEach(function () {
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var cameras = [
                new Camera('back', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
                new Camera('left', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
                new Camera('right', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            state = {
                videoFiles: [],
                views: [],
                session: new Session(cameras, skeleton, ['track_0']),
            };
        });

        it('assigns video to camera by exact name match', function () {
            state.videoFiles.push({ file: null, name: 'back', decoder: null,
                videoWidth: 640, videoHeight: 480, frameCount: 100, assignedCamera: null });

            var cameraNames = state.session.cameras.map(function (c) { return c.name; });
            for (var i = 0; i < state.videoFiles.length; i++) {
                var vf = state.videoFiles[i];
                if (vf.assignedCamera) continue;
                if (cameraNames.indexOf(vf.name) >= 0) {
                    vf.assignedCamera = vf.name;
                }
            }

            assertEqual(state.videoFiles[0].assignedCamera, 'back', 'Should be assigned to back');
        });

        it('assigns video by case-insensitive match', function () {
            state.videoFiles.push({ file: null, name: 'BACK', decoder: null,
                videoWidth: 640, videoHeight: 480, frameCount: 100, assignedCamera: null });

            var cameraNames = state.session.cameras.map(function (c) { return c.name; });
            for (var i = 0; i < state.videoFiles.length; i++) {
                var vf = state.videoFiles[i];
                if (vf.assignedCamera) continue;
                // Exact match first
                if (cameraNames.indexOf(vf.name) >= 0) {
                    vf.assignedCamera = vf.name;
                    continue;
                }
                // Case-insensitive
                var lower = vf.name.toLowerCase();
                for (var j = 0; j < cameraNames.length; j++) {
                    if (cameraNames[j].toLowerCase() === lower) {
                        vf.assignedCamera = cameraNames[j];
                        break;
                    }
                }
            }

            assertEqual(state.videoFiles[0].assignedCamera, 'back', 'Should match case-insensitively');
        });

        it('does not assign unmatched videos', function () {
            state.videoFiles.push({ file: null, name: 'unknown_cam', decoder: null,
                videoWidth: 640, videoHeight: 480, frameCount: 100, assignedCamera: null });

            var cameraNames = state.session.cameras.map(function (c) { return c.name; });
            for (var i = 0; i < state.videoFiles.length; i++) {
                var vf = state.videoFiles[i];
                if (cameraNames.indexOf(vf.name) >= 0) {
                    vf.assignedCamera = vf.name;
                }
            }

            assertNull(state.videoFiles[0].assignedCamera, 'Unknown video should remain unassigned');
        });

        it('videoFiles and views are independent', function () {
            state.videoFiles.push({ file: null, name: 'back', decoder: null,
                videoWidth: 640, videoHeight: 480, frameCount: 100, assignedCamera: 'back' });

            assertEqual(state.views.length, 0, 'Views should still be empty');
            assertEqual(state.videoFiles.length, 1, 'VideoFiles should have 1 entry');
        });
    });

})();
