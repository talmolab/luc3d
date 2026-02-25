/**
 * test-file-io.js - Unit tests for file-io.js
 */

(function () {
    const { describe, it, assertEqual, assertDeepEqual, assertNotNull, assertTrue,
        assertGreaterThan, assertThrows } = TestFramework;

    // ---- TOML Parsing ----

    describe('parseCalibrationTOML', function () {
        it('parses a valid TOML calibration', function () {
            const toml = [
                '[cam_0]',
                'name = "back"',
                'size = [1280, 1024]',
                'matrix = [[600.0, 0.0, 640.0], [0.0, 600.0, 512.0], [0.0, 0.0, 1.0]]',
                'distortions = [0.1, 0.2, 0.0, 0.0, 0.0]',
                'rotation = [0.1, 0.2, 0.3]',
                'translation = [10.0, 20.0, 30.0]',
                '',
                '[cam_1]',
                'name = "side"',
                'size = [1280, 1024]',
                'matrix = [[600.0, 0.0, 640.0], [0.0, 600.0, 512.0], [0.0, 0.0, 1.0]]',
                'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]',
                'rotation = [0.0, 0.0, 0.0]',
                'translation = [0.0, 0.0, 0.0]',
            ].join('\n');

            const cameras = parseCalibrationTOML(toml);
            assertEqual(cameras.length, 2);
            assertEqual(cameras[0].name, 'back');
            assertEqual(cameras[1].name, 'side');
            assertDeepEqual(cameras[0].size, [1280, 1024]);
            assertEqual(cameras[0].rvec[0], 0.1);
            assertEqual(cameras[0].tvec[2], 30.0);
        });

        it('handles trailing commas in arrays', function () {
            const toml = [
                '[cam_0]',
                'name = "test"',
                'size = [ 640, 480,]',
                'matrix = [[ 600.0, 0.0, 320.0,], [ 0.0, 600.0, 240.0,], [ 0.0, 0.0, 1.0,],]',
                'distortions = [ 0.0, 0.0, 0.0, 0.0, 0.0,]',
                'rotation = [ 0.0, 0.0, 0.0,]',
                'translation = [ 0.0, 0.0, 0.0,]',
            ].join('\n');

            const cameras = parseCalibrationTOML(toml);
            assertEqual(cameras.length, 1);
            assertDeepEqual(cameras[0].size, [640, 480]);
        });

        it('skips non-camera sections like [metadata]', function () {
            const toml = [
                '[metadata]',
                'board = "charuco"',
                '',
                '[cam_0]',
                'name = "only"',
                'size = [640, 480]',
                'matrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]',
                'distortions = [0, 0, 0, 0, 0]',
                'rotation = [0, 0, 0]',
                'translation = [0, 0, 0]',
            ].join('\n');

            const cameras = parseCalibrationTOML(toml);
            assertEqual(cameras.length, 1);
            assertEqual(cameras[0].name, 'only');
        });
    });

    // ---- JSON Parsing ----

    describe('parseCalibrationJSON', function () {
        it('parses cameras array format', function () {
            const json = JSON.stringify({
                cameras: [{
                    name: 'back',
                    matrix: [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                    dist: [0, 0, 0, 0, 0],
                    rvec: [0.1, 0.2, 0.3],
                    tvec: [10, 20, 30],
                    size: [640, 480],
                }],
            });
            const cameras = parseCalibrationJSON(json);
            assertEqual(cameras.length, 1);
            assertEqual(cameras[0].name, 'back');
            assertEqual(cameras[0].rvec[0], 0.1);
        });

        it('handles alternate field names (distortions, rotation, translation)', function () {
            const json = JSON.stringify({
                cameras: [{
                    name: 'test',
                    matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                    distortions: [1, 2, 3, 4, 5],
                    rotation: [0.1, 0.2, 0.3],
                    translation: [4, 5, 6],
                    size: [320, 240],
                }],
            });
            const cameras = parseCalibrationJSON(json);
            assertEqual(cameras.length, 1);
            assertDeepEqual(cameras[0].dist, [1, 2, 3, 4, 5]);
            assertDeepEqual(cameras[0].rvec, [0.1, 0.2, 0.3]);
        });

        it('throws for invalid format', function () {
            assertThrows(function () {
                parseCalibrationJSON('{"invalid": "object"}');
            });
        });
    });

    // ---- TOML Export ----

    describe('exportCalibrationTOML', function () {
        it('produces valid TOML that round-trips', function () {
            if (typeof exportCalibrationTOML !== 'function') return;

            const cameras = [
                new Camera('back', [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                    [0.1, 0.2, 0, 0, 0], [0.1, 0.2, 0.3], [10, 20, 30], [640, 480]),
                new Camera('side', [[500, 0, 256], [0, 500, 192], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [512, 384]),
            ];

            const toml = exportCalibrationTOML(cameras);
            assertTrue(toml.indexOf('[cam_0]') >= 0);
            assertTrue(toml.indexOf('[cam_1]') >= 0);
            assertTrue(toml.indexOf('"back"') >= 0);
            assertTrue(toml.indexOf('"side"') >= 0);

            // Round-trip: parse back
            const parsed = parseCalibrationTOML(toml);
            assertEqual(parsed.length, 2);
            assertEqual(parsed[0].name, 'back');
            assertEqual(parsed[1].name, 'side');
            assertEqual(parsed[0].rvec[0], 0.1);
        });
    });

    // ---- Skeleton Serialization ----

    describe('serializeSkeleton', function () {
        it('serializes skeleton to SLEAP metadata format', function () {
            if (typeof serializeSkeleton !== 'function') return;

            const sk = new Skeleton('mouse', ['nose', 'head', 'body'], [[0, 1], [1, 2]]);
            const result = serializeSkeleton(sk);

            assertEqual(result.nodes.length, 3);
            assertEqual(result.nodes[0].name, 'nose');
            assertEqual(result.skeletons.length, 1);
            assertEqual(result.skeletons[0].name, 'mouse');
            assertEqual(result.skeletons[0].links.length, 2);
            assertDeepEqual(result.skeletons[0].links[0].type, { 'py/tuple': [1] });
        });
    });

    // ---- SLP Export Data ----

    describe('buildSlpExportData', function () {
        it('builds valid SLP export structure', function () {
            if (typeof buildSlpExportData !== 'function') return;

            const cameras = [
                new Camera('cam1', [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            const skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            const session = new Session(cameras, skeleton, ['track_0']);

            // Add an instance
            const inst = session.addNewInstance(0, 'cam1', skeleton, 0);
            inst.points[0] = [100, 200];
            inst.points[1] = [300, 400];

            const views = [{ name: 'cam1', videoWidth: 640, videoHeight: 480 }];
            const data = buildSlpExportData(session, views);

            assertEqual(data.format_id, 1.4);
            assertNotNull(data.metadata);
            assertEqual(data.metadata.version, '2.0.0');
            assertEqual(data.videos.length, 1);
            assertEqual(data.tracks.length, 1);
            assertGreaterThan(data.frames.length, 0);
            assertGreaterThan(data.instances.length, 0);
            assertGreaterThan(data.points.length, 0);
        });

        it('includes calibration in sessions', function () {
            if (typeof buildSlpExportData !== 'function') return;

            const cameras = [
                new Camera('cam1', [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0.1, 0.2, 0.3], [10, 20, 30], [640, 480]),
            ];
            const skeleton = new Skeleton('test', ['a'], []);
            const session = new Session(cameras, skeleton, ['track_0']);
            const views = [{ name: 'cam1', videoWidth: 640, videoHeight: 480 }];

            const data = buildSlpExportData(session, views);
            assertEqual(data.sessions.length, 1);
            assertNotNull(data.sessions[0].calibration);
            assertNotNull(data.sessions[0].calibration['camera_0']);
        });
    });

    // ---- Points3D Export ----

    describe('buildPoints3dExportData', function () {
        it('builds valid structure with triangulated data', function () {
            if (typeof buildPoints3dExportData !== 'function') return;

            const cameras = [
                new Camera('c1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            const skeleton = new Skeleton('t', ['a', 'b'], []);
            const session = new Session(cameras, skeleton, ['track_0']);

            // Create an instance group with 3D points
            const group = new InstanceGroup(1, 0);
            group.points3d = [[10, 20, 30], [40, 50, 60]];
            session.instanceGroups.set(5, new Map([[0, [group]]]));

            const data = buildPoints3dExportData(session);
            assertEqual(data.frame_indices.length, 1);
            assertEqual(data.frame_indices[0], 5);
            assertEqual(data.node_names.length, 2);
            assertEqual(data.track_names.length, 1);
            assertGreaterThan(data.points_3d.length, 0);
        });

        it('returns empty arrays when no triangulated data', function () {
            if (typeof buildPoints3dExportData !== 'function') return;

            const session = new Session([], new Skeleton('t', [], []), []);
            const data = buildPoints3dExportData(session);
            assertEqual(data.frame_indices.length, 0);
            assertEqual(data.points_3d.length, 0);
        });
    });

    // ---- matchVideosToCameras ----

    describe('matchVideosToCameras', function () {
        it('matches exact filenames to camera names', function () {
            const files = [
                { name: 'back.mp4' },
                { name: 'side.mp4' },
            ];
            const cameras = [
                new Camera('back', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
                new Camera('side', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            const matched = matchVideosToCameras(files, cameras);
            assertEqual(matched.size, 2);
            assertTrue(matched.has('back'));
            assertTrue(matched.has('side'));
        });

        it('matches case-insensitively', function () {
            const files = [{ name: 'BACK.mp4' }];
            const cameras = [
                new Camera('back', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            const matched = matchVideosToCameras(files, cameras);
            assertEqual(matched.size, 1);
            assertTrue(matched.has('back'));
        });

        it('returns empty map for no matches', function () {
            const files = [{ name: 'unknown.mp4' }];
            const cameras = [
                new Camera('back', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            const matched = matchVideosToCameras(files, cameras);
            assertEqual(matched.size, 0);
        });
    });
})();
