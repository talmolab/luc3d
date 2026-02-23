/**
 * test-save-load.js - Tests for project save/load JSON serialization
 *
 * The saveProject / handleLoadProject functions live inside index.html's
 * main script block and are not globally accessible, so we replicate the
 * critical serialization logic here and verify it produces valid JSON that
 * round-trips correctly.
 */

(function () {
    const { describe, it, assertEqual, assertDeepEqual, assertNotNull, assertTrue,
        assertGreaterThan, assert } = TestFramework;

    // ---- Helper: replicate the chunked Blob serialization from saveProject ----

    /**
     * Build the project JSON string using the same chunked approach as saveProject.
     * Returns the concatenated string (instead of a Blob) for easy testing.
     */
    function buildProjectJson(projectData) {
        var header = Object.assign({}, projectData);
        delete header.frames;
        var headerJson = JSON.stringify(header);
        // Strip closing "}" so we can append frames
        headerJson = headerJson.slice(0, -1) + ',"frames":{';

        var parts = [headerJson];
        var frameKeys = Object.keys(projectData.frames);
        for (var bfi = 0; bfi < frameKeys.length; bfi++) {
            var fk = frameKeys[bfi];
            var prefix = bfi > 0 ? ',' : '';
            parts.push(prefix + JSON.stringify(fk) + ':' + JSON.stringify(projectData.frames[fk]));
        }
        parts.push('}}');

        return parts.join('');
    }

    /**
     * Build a minimal projectData structure for testing.
     */
    function makeProjectData(numFrames, numCameras, numKeypoints) {
        numFrames = numFrames != null ? numFrames : 3;
        numCameras = numCameras != null ? numCameras : 2;
        numKeypoints = numKeypoints != null ? numKeypoints : 4;

        var cameras = [];
        for (var c = 0; c < numCameras; c++) {
            cameras.push({
                name: 'cam_' + c,
                matrix: [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                dist: [0, 0, 0, 0, 0],
                rvec: [0.1 * c, 0.2 * c, 0.3 * c],
                tvec: [10 * c, 20 * c, 30 * c],
                size: [640, 480],
            });
        }

        var projectData = {
            version: 2,
            skeleton: {
                name: 'test',
                nodes: [],
                edges: [],
            },
            cameras: cameras,
            tracks: ['track_0'],
            videoManifest: cameras.map(function (c) {
                return { filename: c.name + '.mp4', assignedCamera: c.name };
            }),
            frames: {},
        };

        for (var n = 0; n < numKeypoints; n++) {
            projectData.skeleton.nodes.push('node_' + n);
        }
        if (numKeypoints >= 2) {
            projectData.skeleton.edges.push([0, 1]);
        }

        // Create frames
        for (var f = 0; f < numFrames; f++) {
            var frameIdx = f * 10; // non-contiguous frame indices
            var frameData = {
                instanceGroups: [],
                unlinkedInstances: [],
            };

            var groupData = {
                id: 'group_' + f,
                trackIdx: 0,
                instances: {},
                points3d: [],
            };

            // Create points3d with some null entries
            for (var k = 0; k < numKeypoints; k++) {
                if (k % 3 === 2) {
                    groupData.points3d.push(null); // some missing
                } else {
                    groupData.points3d.push([k * 1.5, k * 2.5, k * 3.5]);
                }
            }

            // Create per-camera instances
            for (var ci = 0; ci < numCameras; ci++) {
                var points = [];
                for (var ki = 0; ki < numKeypoints; ki++) {
                    if (ki % 4 === 3) {
                        points.push(null); // some missing
                    } else {
                        points.push([100 + ki * 10 + ci, 200 + ki * 10 + ci]);
                    }
                }
                groupData.instances['cam_' + ci] = {
                    points: points,
                    trackIdx: 0,
                    type: 'predicted',
                    score: 0.95,
                    modified: false,
                };
            }

            frameData.instanceGroups.push(groupData);
            projectData.frames[frameIdx] = frameData;
        }

        return projectData;
    }


    // ---- Tests ----

    describe('Project Save — Chunked JSON Construction', function () {

        it('produces valid JSON for a small project', function () {
            var data = makeProjectData(3, 2, 4);
            var json = buildProjectJson(data);

            // Must parse without error
            var parsed = JSON.parse(json);
            assertNotNull(parsed);
            assertEqual(parsed.version, 2);
            assertEqual(parsed.skeleton.name, 'test');
            assertEqual(parsed.cameras.length, 2);
        });

        it('produces valid JSON for empty frames', function () {
            var data = makeProjectData(0, 2, 4);
            var json = buildProjectJson(data);

            var parsed = JSON.parse(json);
            assertNotNull(parsed);
            assertDeepEqual(parsed.frames, {});
        });

        it('produces valid JSON for single frame', function () {
            var data = makeProjectData(1, 2, 4);
            var json = buildProjectJson(data);

            var parsed = JSON.parse(json);
            var frameKeys = Object.keys(parsed.frames);
            assertEqual(frameKeys.length, 1);
            assertEqual(frameKeys[0], '0');
        });

        it('produces valid JSON for many frames', function () {
            var data = makeProjectData(500, 3, 10);
            var json = buildProjectJson(data);

            var parsed = JSON.parse(json);
            var frameKeys = Object.keys(parsed.frames);
            assertEqual(frameKeys.length, 500);
        });

        it('preserves points3d including null entries', function () {
            var data = makeProjectData(1, 1, 6);
            var json = buildProjectJson(data);

            var parsed = JSON.parse(json);
            var group = parsed.frames['0'].instanceGroups[0];
            assertEqual(group.points3d.length, 6);
            // node_2 and node_5 should be null (k % 3 === 2)
            assertEqual(group.points3d[2], null);
            assertEqual(group.points3d[5], null);
            // node_0 should have values
            assertDeepEqual(group.points3d[0], [0, 0, 0]);
            assertDeepEqual(group.points3d[1], [1.5, 2.5, 3.5]);
        });

        it('preserves instance points including null entries', function () {
            var data = makeProjectData(1, 2, 8);
            var json = buildProjectJson(data);

            var parsed = JSON.parse(json);
            var instances = parsed.frames['0'].instanceGroups[0].instances;
            var cam0 = instances['cam_0'];
            assertEqual(cam0.points.length, 8);
            // node_3 and node_7 should be null (ki % 4 === 3)
            assertEqual(cam0.points[3], null);
            assertEqual(cam0.points[7], null);
            // node_0 should have values
            assertNotNull(cam0.points[0]);
        });

        it('handles NaN in points3d (serialized as null)', function () {
            var data = makeProjectData(1, 1, 2);
            data.frames['0'].instanceGroups[0].points3d = [[1, 2, NaN], [NaN, NaN, NaN]];
            var json = buildProjectJson(data);

            var parsed = JSON.parse(json);
            var pts = parsed.frames['0'].instanceGroups[0].points3d;
            // NaN becomes null in JSON
            assertDeepEqual(pts[0], [1, 2, null]);
            assertDeepEqual(pts[1], [null, null, null]);
        });

        it('handles Infinity in point values (serialized as null)', function () {
            var data = makeProjectData(1, 1, 1);
            data.frames['0'].instanceGroups[0].instances['cam_0'].points = [[Infinity, -Infinity]];
            var json = buildProjectJson(data);

            var parsed = JSON.parse(json);
            var pts = parsed.frames['0'].instanceGroups[0].instances['cam_0'].points;
            assertDeepEqual(pts[0], [null, null]);
        });

        it('produces same result as JSON.stringify for small data', function () {
            var data = makeProjectData(5, 2, 4);
            var chunked = buildProjectJson(data);
            var direct = JSON.stringify(data);

            // Both should parse to identical objects
            var parsed1 = JSON.parse(chunked);
            var parsed2 = JSON.parse(direct);
            assertEqual(JSON.stringify(parsed1), JSON.stringify(parsed2));
        });

        it('correctly handles numeric frame keys', function () {
            var data = {
                version: 2,
                skeleton: { name: 'test', nodes: ['a'], edges: [] },
                cameras: [],
                tracks: [],
                videoManifest: [],
                frames: {},
            };
            // Use various numeric keys
            data.frames[0] = { instanceGroups: [], unlinkedInstances: [] };
            data.frames[100] = { instanceGroups: [], unlinkedInstances: [] };
            data.frames[999999] = { instanceGroups: [], unlinkedInstances: [] };

            var json = buildProjectJson(data);
            var parsed = JSON.parse(json);
            var keys = Object.keys(parsed.frames).sort();
            assertEqual(keys.length, 3);
            assertTrue(keys.indexOf('0') >= 0);
            assertTrue(keys.indexOf('100') >= 0);
            assertTrue(keys.indexOf('999999') >= 0);
        });
    });


    describe('Project Save — Round-trip Integrity', function () {

        it('round-trips skeleton data', function () {
            var data = makeProjectData(1, 2, 5);
            var json = buildProjectJson(data);
            var parsed = JSON.parse(json);

            assertEqual(parsed.skeleton.name, data.skeleton.name);
            assertDeepEqual(parsed.skeleton.nodes, data.skeleton.nodes);
            assertDeepEqual(parsed.skeleton.edges, data.skeleton.edges);
        });

        it('round-trips camera data', function () {
            var data = makeProjectData(1, 3, 2);
            var json = buildProjectJson(data);
            var parsed = JSON.parse(json);

            assertEqual(parsed.cameras.length, 3);
            for (var c = 0; c < 3; c++) {
                assertEqual(parsed.cameras[c].name, data.cameras[c].name);
                assertDeepEqual(parsed.cameras[c].matrix, data.cameras[c].matrix);
                assertDeepEqual(parsed.cameras[c].rvec, data.cameras[c].rvec);
                assertDeepEqual(parsed.cameras[c].tvec, data.cameras[c].tvec);
            }
        });

        it('round-trips track data', function () {
            var data = makeProjectData(1, 1, 2);
            data.tracks = ['animal_0', 'animal_1'];
            var json = buildProjectJson(data);
            var parsed = JSON.parse(json);

            assertDeepEqual(parsed.tracks, ['animal_0', 'animal_1']);
        });

        it('round-trips video manifest', function () {
            var data = makeProjectData(1, 2, 2);
            var json = buildProjectJson(data);
            var parsed = JSON.parse(json);

            assertEqual(parsed.videoManifest.length, 2);
            assertEqual(parsed.videoManifest[0].filename, 'cam_0.mp4');
            assertEqual(parsed.videoManifest[0].assignedCamera, 'cam_0');
        });

        it('round-trips instance group data', function () {
            var data = makeProjectData(2, 2, 3);
            var json = buildProjectJson(data);
            var parsed = JSON.parse(json);

            var group = parsed.frames['0'].instanceGroups[0];
            assertEqual(group.id, 'group_0');
            assertEqual(group.trackIdx, 0);
            assertEqual(Object.keys(group.instances).length, 2);
            assertTrue('cam_0' in group.instances);
            assertTrue('cam_1' in group.instances);
        });

        it('round-trips unlinked instances', function () {
            var data = makeProjectData(1, 1, 2);
            data.frames['0'].unlinkedInstances = [{
                cameraName: 'cam_0',
                points: [[50, 60], [70, 80]],
                type: 'user',
                score: 1.0,
                modified: true,
            }];
            var json = buildProjectJson(data);
            var parsed = JSON.parse(json);

            assertEqual(parsed.frames['0'].unlinkedInstances.length, 1);
            var ul = parsed.frames['0'].unlinkedInstances[0];
            assertEqual(ul.cameraName, 'cam_0');
            assertDeepEqual(ul.points, [[50, 60], [70, 80]]);
            assertTrue(ul.modified);
        });
    });


    describe('Project Save — Edge Cases', function () {

        it('handles frame with no instance groups', function () {
            var data = makeProjectData(1, 1, 2);
            data.frames['0'].instanceGroups = [];
            var json = buildProjectJson(data);
            var parsed = JSON.parse(json);

            assertEqual(parsed.frames['0'].instanceGroups.length, 0);
        });

        it('handles frame with points3d = null', function () {
            var data = makeProjectData(1, 1, 2);
            data.frames['0'].instanceGroups[0].points3d = null;
            var json = buildProjectJson(data);
            var parsed = JSON.parse(json);

            assertEqual(parsed.frames['0'].instanceGroups[0].points3d, null);
        });

        it('handles all-null points array', function () {
            var data = makeProjectData(1, 1, 3);
            data.frames['0'].instanceGroups[0].instances['cam_0'].points = [null, null, null];
            var json = buildProjectJson(data);
            var parsed = JSON.parse(json);

            assertDeepEqual(
                parsed.frames['0'].instanceGroups[0].instances['cam_0'].points,
                [null, null, null]
            );
        });

        it('handles special characters in camera names', function () {
            var data = makeProjectData(1, 1, 1);
            data.cameras[0].name = 'cam "special" & <weird>';
            data.frames['0'].instanceGroups[0].instances = {};
            data.frames['0'].instanceGroups[0].instances['cam "special" & <weird>'] = {
                points: [[1, 2]],
                trackIdx: 0,
                type: 'user',
                score: 1.0,
                modified: false,
            };
            var json = buildProjectJson(data);
            var parsed = JSON.parse(json);

            assertEqual(parsed.cameras[0].name, 'cam "special" & <weird>');
            assertTrue('cam "special" & <weird>' in parsed.frames['0'].instanceGroups[0].instances);
        });

        it('JSON size grows linearly with frame count', function () {
            var size10 = buildProjectJson(makeProjectData(10, 2, 4)).length;
            var size100 = buildProjectJson(makeProjectData(100, 2, 4)).length;
            var size200 = buildProjectJson(makeProjectData(200, 2, 4)).length;

            // Size should roughly double when frame count doubles
            var ratio = size200 / size100;
            assert(ratio > 1.5 && ratio < 2.5,
                'Expected ~2x ratio but got ' + ratio.toFixed(2));
            // 100 frames should be larger than 10 frames
            assertGreaterThan(size100, size10);
        });
    });


    // ---- v3 NDJSON format tests ----

    /**
     * Build v3 NDJSON string (mirrors saveProject v3 logic).
     */
    function buildProjectNdjson(projectData) {
        var header = Object.assign({}, projectData, { version: 3 });
        delete header.frames;
        var lines = [JSON.stringify(header)];

        var frameKeys = Object.keys(projectData.frames);
        for (var fi = 0; fi < frameKeys.length; fi++) {
            var fk = frameKeys[fi];
            var frameData = Object.assign({ frame: parseInt(fk) }, projectData.frames[fk]);
            lines.push(JSON.stringify(frameData));
        }

        return lines.join('\n') + '\n';
    }

    describe('Project Save — v3 NDJSON Format', function () {

        it('produces valid NDJSON with one line per frame', function () {
            var data = makeProjectData(3, 2, 4);
            var ndjson = buildProjectNdjson(data);
            var lines = ndjson.trim().split('\n');

            // 1 header + 3 frame lines
            assertEqual(lines.length, 4);

            // Each line is valid JSON
            for (var i = 0; i < lines.length; i++) {
                assertNotNull(JSON.parse(lines[i]));
            }
        });

        it('header line has version 3 and no frames', function () {
            var data = makeProjectData(2, 2, 3);
            var ndjson = buildProjectNdjson(data);
            var header = JSON.parse(ndjson.split('\n')[0]);

            assertEqual(header.version, 3);
            assertEqual(header.skeleton.name, 'test');
            assertEqual(header.cameras.length, 2);
            assertTrue(header.frames === undefined);
        });

        it('frame lines contain frame index and instance data', function () {
            var data = makeProjectData(2, 2, 3);
            var ndjson = buildProjectNdjson(data);
            var lines = ndjson.trim().split('\n');

            var frame0 = JSON.parse(lines[1]);
            assertEqual(frame0.frame, 0);
            assertGreaterThan(frame0.instanceGroups.length, 0);
            assertNotNull(frame0.instanceGroups[0].instances);
        });

        it('round-trips instance data identically to v2', function () {
            var data = makeProjectData(3, 2, 4);

            // Build v2 JSON and extract frames
            var v2json = buildProjectJson(data);
            var v2parsed = JSON.parse(v2json);

            // Build v3 NDJSON and extract frames
            var ndjson = buildProjectNdjson(data);
            var lines = ndjson.trim().split('\n');

            for (var i = 1; i < lines.length; i++) {
                var v3frame = JSON.parse(lines[i]);
                var fIdx = String(v3frame.frame);
                var v2frame = v2parsed.frames[fIdx];

                // Instance groups should match
                assertEqual(v3frame.instanceGroups.length, v2frame.instanceGroups.length);
                if (v3frame.instanceGroups.length > 0) {
                    var v3group = v3frame.instanceGroups[0];
                    var v2group = v2frame.instanceGroups[0];
                    assertEqual(v3group.trackIdx, v2group.trackIdx);
                    assertEqual(
                        JSON.stringify(v3group.instances),
                        JSON.stringify(v2group.instances)
                    );
                }
            }
        });

        it('handles empty project', function () {
            var data = makeProjectData(0, 2, 4);
            var ndjson = buildProjectNdjson(data);
            var lines = ndjson.trim().split('\n');

            // Just the header line
            assertEqual(lines.length, 1);
            var header = JSON.parse(lines[0]);
            assertEqual(header.version, 3);
        });
    });

})();
