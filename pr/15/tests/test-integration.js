/**
 * test-integration.js - Integration tests for the mv-gui application.
 * Tests full workflows that span multiple modules.
 */

(function () {
    const { describe, it, beforeEach, assertEqual, assertDeepEqual, assertNotNull,
        assertNull, assertTrue, assertFalse, assertApprox, assertGreaterThan,
        assertLessThan } = TestFramework;

    // ---- Full Workflow: Create session -> add skeleton -> instances -> triangulate -> export ----

    describe('Integration: Full workflow', function () {
        it('creates session, adds instances, triangulates, and exports', function () {
            // 1. Create cameras at known positions
            const cam1 = new Camera('back',
                [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 100], [640, 480]);
            const cam2 = new Camera('side',
                [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0.5, 0], [50, 0, 80], [640, 480]);

            // 2. Create skeleton
            const skeleton = new Skeleton('mouse', ['nose', 'head', 'body'], [[0, 1], [1, 2]]);

            // 3. Create session
            const session = new Session([cam1, cam2], skeleton, ['track_0']);

            // 4. Generate 3D points and project to 2D
            const point3d_0 = [5, 3, 0];
            const point3d_1 = [8, 3, 0];
            const point3d_2 = [12, 3, 0];
            const points3d = [point3d_0, point3d_1, point3d_2];

            const pts_cam1 = points3d.map(function (p) { return cam1.project(p); });
            const pts_cam2 = points3d.map(function (p) { return cam2.project(p); });

            // 5. Create instances
            const inst1 = new Instance(pts_cam1, 0, 'predicted', 0.95);
            const inst2 = new Instance(pts_cam2, 0, 'predicted', 0.90);

            // 6. Create frame group
            const fg = new FrameGroup(0);
            fg.addInstance('back', inst1);
            fg.addInstance('side', inst2);
            session.addFrameGroup(fg);

            // 7. Create instance group
            const group = new InstanceGroup(1, 0);
            group.addInstance('back', inst1);
            group.addInstance('side', inst2);
            session.instanceGroups.set(0, new Map([[0, [group]]]));

            // 8. Triangulate (if available)
            if (typeof triangulateAndReproject === 'function') {
                const result = triangulateAndReproject(group, [cam1, cam2]);
                assertNotNull(result.points3d, 'Should produce 3D points');
                assertEqual(result.points3d.length, 3, 'Should have 3 keypoints');

                // Verify 3D points are close to originals
                for (let i = 0; i < 3; i++) {
                    assertApprox(result.points3d[i][0], points3d[i][0], 2.0, 'Point ' + i + ' X');
                    assertApprox(result.points3d[i][1], points3d[i][1], 2.0, 'Point ' + i + ' Y');
                    assertApprox(result.points3d[i][2], points3d[i][2], 2.0, 'Point ' + i + ' Z');
                }

                group.points3d = result.points3d;
            }

            // 9. Export SLP data
            if (typeof buildSlpExportData === 'function') {
                const views = [
                    { name: 'back', videoWidth: 640, videoHeight: 480 },
                    { name: 'side', videoWidth: 640, videoHeight: 480 },
                ];
                const slpData = buildSlpExportData(session, views);

                assertNotNull(slpData, 'SLP export should not be null');
                assertEqual(slpData.format_id, 1.4);
                assertEqual(slpData.videos.length, 2);
                assertGreaterThan(slpData.frames.length, 0, 'Should have frames');
                assertGreaterThan(slpData.instances.length, 0, 'Should have instances');
                assertEqual(slpData.metadata.nodes.length, 3, 'Should have 3 nodes');
                assertEqual(slpData.metadata.skeletons[0].links.length, 2, 'Should have 2 edges');
            }

            // 10. Export 3D points
            if (typeof buildPoints3dExportData === 'function') {
                const pts3dData = buildPoints3dExportData(session);
                if (group.points3d) {
                    assertEqual(pts3dData.frame_indices.length, 1, 'Should have 1 frame');
                    assertEqual(pts3dData.node_names.length, 3, 'Should have 3 nodes');
                }
            }

            // 11. Export calibration TOML
            if (typeof exportCalibrationTOML === 'function') {
                const toml = exportCalibrationTOML([cam1, cam2]);
                assertTrue(toml.indexOf('[cam_0]') >= 0);
                assertTrue(toml.indexOf('"back"') >= 0);
                assertTrue(toml.indexOf('[cam_1]') >= 0);
                assertTrue(toml.indexOf('"side"') >= 0);
            }
        });
    });

    // ---- Deletion Cascade ----

    describe('Integration: Deletion cascade', function () {
        it('removing instance group clears all data structures', function () {
            var cameras = [
                new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
                new Camera('cam2', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            var skeleton = new Skeleton('test', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            var session = new Session(cameras, skeleton, ['track_0', 'track_1']);

            // Create two instance groups in frame 0
            var fg = new FrameGroup(0);
            session.addFrameGroup(fg);

            var inst1a = new Instance([[10, 20], [30, 40], null], 0, 'user', 1);
            var inst1b = new Instance([[50, 60], null, [70, 80]], 0, 'user', 1);
            var group1 = new InstanceGroup(1, 0);
            group1.addInstance('cam1', inst1a);
            group1.addInstance('cam2', inst1b);
            fg.addInstance('cam1', inst1a);
            fg.addInstance('cam2', inst1b);

            var inst2a = new Instance([[100, 200], [300, 400], [500, 600]], 1, 'user', 1);
            var group2 = new InstanceGroup(2, 1);
            group2.addInstance('cam1', inst2a);
            fg.addInstance('cam1', inst2a);

            session.instanceGroups.set(0, new Map([
                [0, [group1]],
                [1, [group2]]
            ]));

            // Verify setup
            assertEqual(session.getInstanceGroupsForFrame(0).length, 2);
            assertEqual(fg.getInstances('cam1').length, 2); // inst1a + inst2a
            assertEqual(fg.getInstances('cam2').length, 1); // inst1b

            // Delete group1
            var removed = session.removeInstanceGroup(0, group1);
            assertTrue(removed, 'Should return true on removal');

            // Verify group1 gone, group2 remains
            assertEqual(session.getInstanceGroupsForFrame(0).length, 1);
            assertEqual(session.getInstanceGroupsForFrame(0)[0], group2);

            // Verify cam1 only has inst2a, cam2 has nothing
            assertEqual(fg.getInstances('cam1').length, 1);
            assertEqual(fg.getInstances('cam1')[0], inst2a);
            // cam2 had inst1b which belonged to group1, should be gone
            assertEqual(fg.getInstances('cam2').length, 0);
        });

        it('deleting all groups from a frame cleans up', function () {
            var cameras = [
                new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            var skeleton = new Skeleton('test', ['a'], []);
            var session = new Session(cameras, skeleton, ['track_0']);

            var fg = new FrameGroup(0);
            session.addFrameGroup(fg);
            var inst = new Instance([[10, 20]], 0, 'user', 1);
            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst);
            fg.addInstance('cam1', inst);
            session.instanceGroups.set(0, new Map([[0, [group]]]));

            session.removeInstanceGroup(0, group);

            // Frame should be cleaned up
            assertFalse(session.instanceGroups.has(0), 'instanceGroups should clean up empty frame');
        });
    });

    // ---- Skeleton Edit Cascade ----

    describe('Integration: Skeleton edit cascade', function () {
        it('adding a node extends all instance point arrays', function () {
            var cameras = [
                new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var session = new Session(cameras, skeleton, ['track_0']);

            // Create instances
            var inst1 = session.addNewInstance(0, 'cam1', skeleton, 0);
            inst1.points[0] = [10, 20];
            inst1.points[1] = [30, 40];

            var inst2 = session.addNewInstance(5, 'cam1', skeleton, 0);
            inst2.points[0] = [50, 60];
            inst2.points[1] = [70, 80];

            // Add node to skeleton
            skeleton.addNode('c');
            session.propagateNodeAdded();

            // Verify all instances have 3 points now
            assertEqual(inst1.points.length, 3, 'Instance 1 should have 3 points');
            assertNull(inst1.points[2], 'New point should be null');
            assertDeepEqual(inst1.points[0], [10, 20], 'Existing points preserved');

            assertEqual(inst2.points.length, 3, 'Instance 2 should have 3 points');
            assertNull(inst2.points[2], 'New point should be null');
        });

        it('removing a node splices all instance point arrays', function () {
            var cameras = [
                new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            var skeleton = new Skeleton('test', ['a', 'b', 'c'], [[0, 1], [1, 2]]);
            var session = new Session(cameras, skeleton, ['track_0']);

            var inst = session.addNewInstance(0, 'cam1', skeleton, 0);
            inst.points[0] = [10, 20];
            inst.points[1] = [30, 40];
            inst.points[2] = [50, 60];

            // Add an InstanceGroup so we can verify dirty marking
            var group = new InstanceGroup(1, 0);
            group.addInstance('cam1', inst);
            group.points3d = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
            session.instanceGroups.set(0, new Map([[0, [group]]]));

            // Remove middle node 'b'
            skeleton.removeNode(1);
            session.propagateNodeRemoved(1);

            // Verify instance points updated
            assertEqual(inst.points.length, 2);
            assertDeepEqual(inst.points[0], [10, 20]);
            assertDeepEqual(inst.points[1], [50, 60]);

            // Verify skeleton edges updated
            assertEqual(skeleton.edges.length, 0, 'Both edges referenced node 1, should be removed');
            assertEqual(skeleton.nodes.length, 2);
            assertDeepEqual(skeleton.nodes, ['a', 'c']);

            // Verify InstanceGroup marked dirty and 3D points cleared
            assertTrue(group.dirty, 'Group should be marked dirty');
            assertNull(group.points3d, '3D points should be cleared');
        });

        it('adding an edge updates skeleton correctly', function () {
            var skeleton = new Skeleton('test', ['a', 'b', 'c'], []);
            assertEqual(skeleton.edges.length, 0);

            assertTrue(skeleton.addEdge(0, 1));
            assertTrue(skeleton.addEdge(1, 2));
            assertEqual(skeleton.edges.length, 2);

            // Duplicate should fail
            assertFalse(skeleton.addEdge(0, 1));
            assertFalse(skeleton.addEdge(1, 0));
            assertEqual(skeleton.edges.length, 2);
        });
    });

    // ---- Export Round-Trip ----

    describe('Integration: Export round-trip', function () {
        it('calibration TOML export -> parse -> matches original', function () {
            if (typeof exportCalibrationTOML !== 'function') return;
            if (typeof parseCalibrationTOML !== 'function') return;

            var cameras = [
                new Camera('back', [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                    [0.1, -0.05, 0.001, 0.002, 0.01], [0.5, -0.3, 0.1], [15.2, -8.7, 102.5], [1280, 1024]),
                new Camera('side', [[500, 0, 256], [0, 500, 192], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [1.2, 0.8, -0.5], [-20, 5, 80], [512, 384]),
            ];

            var toml = exportCalibrationTOML(cameras);
            var parsed = parseCalibrationTOML(toml);

            assertEqual(parsed.length, 2, 'Should parse 2 cameras');
            assertEqual(parsed[0].name, 'back');
            assertEqual(parsed[1].name, 'side');

            // Check values match
            for (var i = 0; i < cameras.length; i++) {
                assertDeepEqual(parsed[i].size, cameras[i].size, 'Camera ' + i + ' size');
                assertDeepEqual(parsed[i].matrix, cameras[i].matrix, 'Camera ' + i + ' matrix');
                assertDeepEqual(parsed[i].dist, cameras[i].dist, 'Camera ' + i + ' distortion');

                for (var j = 0; j < 3; j++) {
                    assertApprox(parsed[i].rvec[j], cameras[i].rvec[j], 1e-10, 'Camera ' + i + ' rvec[' + j + ']');
                    assertApprox(parsed[i].tvec[j], cameras[i].tvec[j], 1e-10, 'Camera ' + i + ' tvec[' + j + ']');
                }
            }
        });

        it('SLP export preserves skeleton data', function () {
            if (typeof buildSlpExportData !== 'function') return;
            if (typeof serializeSkeleton !== 'function') return;

            var skeleton = new Skeleton('mouse', ['nose', 'head', 'neck', 'body'], [[0, 1], [1, 2], [2, 3]]);
            var cameras = [
                new Camera('cam1', [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            var session = new Session(cameras, skeleton, ['track_0']);

            // Add instance data
            var inst = session.addNewInstance(0, 'cam1', skeleton, 0);
            inst.points = [[100, 200], [150, 180], [200, 250], [280, 300]];

            var views = [{ name: 'cam1', videoWidth: 640, videoHeight: 480 }];
            var data = buildSlpExportData(session, views);

            // Verify skeleton in metadata
            assertEqual(data.metadata.nodes.length, 4);
            assertEqual(data.metadata.nodes[0].name, 'nose');
            assertEqual(data.metadata.nodes[3].name, 'body');
            assertEqual(data.metadata.skeletons[0].links.length, 3);
            assertEqual(data.metadata.skeletons[0].name, 'mouse');

            // Verify points are present
            var totalPoints = data.points.length + data.pred_points.length;
            assertGreaterThan(totalPoints, 0, 'Should have exported points');

            // Check a specific point
            var firstPoint = data.points[0];
            if (firstPoint) {
                assertApprox(firstPoint.x, 100, 0.01, 'First point X');
                assertApprox(firstPoint.y, 200, 0.01, 'First point Y');
                assertTrue(firstPoint.visible, 'First point should be visible');
            }
        });
    });

    // ---- Coordinate Pipeline ----

    describe('Integration: Coordinate pipeline', function () {
        it('video -> canvas -> video round-trip preserves coordinates', function () {
            if (typeof videoToCanvas !== 'function') return;

            // Test with different aspect ratios
            var testCases = [
                { vw: 640, vh: 480, cw: 640, ch: 480 },   // 1:1
                { vw: 1280, vh: 1024, cw: 640, ch: 512 },  // 2:1 scale
                { vw: 320, vh: 240, cw: 960, ch: 720 },    // 3:1 upscale
            ];

            for (var t = 0; t < testCases.length; t++) {
                var tc = testCases[t];
                var testPoints = [[0, 0], [tc.vw / 2, tc.vh / 2], [tc.vw - 1, tc.vh - 1], [100, 200]];

                for (var p = 0; p < testPoints.length; p++) {
                    var vx = testPoints[p][0];
                    var vy = testPoints[p][1];

                    // Video -> Canvas
                    var canvasCoords = videoToCanvas(vx, vy, tc.vw, tc.vh, tc.cw, tc.ch);

                    // Canvas -> Video (reverse)
                    var scaleX = tc.vw / tc.cw;
                    var scaleY = tc.vh / tc.ch;
                    var recoveredVx = canvasCoords[0] * scaleX;
                    var recoveredVy = canvasCoords[1] * scaleY;

                    assertApprox(recoveredVx, vx, 1.0,
                        'Round-trip X at ' + vx + ',' + vy + ' (' + tc.vw + 'x' + tc.vh + '->' + tc.cw + 'x' + tc.ch + ')');
                    assertApprox(recoveredVy, vy, 1.0,
                        'Round-trip Y at ' + vx + ',' + vy + ' (' + tc.vw + 'x' + tc.vh + '->' + tc.cw + 'x' + tc.ch + ')');
                }
            }
        });

        it('camera project -> triangulate -> project gives consistent 2D points', function () {
            if (typeof triangulatePointDLT !== 'function') return;

            var cam1 = new Camera('c1',
                [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [-15, 0, 80], [640, 480]);
            var cam2 = new Camera('c2',
                [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0.4, 0], [15, 0, 80], [640, 480]);

            var testPoints3d = [
                [0, 0, 0],
                [10, 5, -20],
                [-5, 8, 15],
            ];

            for (var i = 0; i < testPoints3d.length; i++) {
                var pt3d = testPoints3d[i];
                var p1 = cam1.project(pt3d);
                var p2 = cam2.project(pt3d);

                var recovered = triangulatePointDLT(
                    [p1, p2],
                    [cam1.projectionMatrix, cam2.projectionMatrix]
                );

                if (recovered) {
                    var rp1 = cam1.project(recovered);
                    var rp2 = cam2.project(recovered);

                    assertLessThan(Math.abs(rp1[0] - p1[0]), 1.0,
                        'Cam1 X consistency for point ' + i);
                    assertLessThan(Math.abs(rp1[1] - p1[1]), 1.0,
                        'Cam1 Y consistency for point ' + i);
                    assertLessThan(Math.abs(rp2[0] - p2[0]), 1.0,
                        'Cam2 X consistency for point ' + i);
                    assertLessThan(Math.abs(rp2[1] - p2[1]), 1.0,
                        'Cam2 Y consistency for point ' + i);
                }
            }
        });
    });

    // ---- Unlinked Instance Assignment Workflow ----

    describe('Integration: Unlinked instance assignment', function () {
        it('creates group from unlinked instances across views', function () {
            var cameras = [
                new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
                new Camera('cam2', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
                new Camera('cam3', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            ];
            var skeleton = new Skeleton('test', ['a', 'b'], [[0, 1]]);
            var session = new Session(cameras, skeleton, ['track_0']);

            // Add unlinked instances
            var inst1 = new Instance([[100, 200], [300, 400]], 0, 'predicted', 0.9);
            var inst2 = new Instance([[150, 250], [350, 450]], 0, 'predicted', 0.85);
            var inst3 = new Instance([[120, 220], [320, 420]], 0, 'predicted', 0.88);

            var ul1 = session.addUnlinkedInstance(0, 'cam1', inst1);
            var ul2 = session.addUnlinkedInstance(0, 'cam2', inst2);
            var ul3 = session.addUnlinkedInstance(0, 'cam3', inst3);

            // Verify unlinked instances exist
            var fg = session.getFrameGroup(0);
            assertEqual(fg.getUnlinkedInstances('cam1').length, 1);
            assertEqual(fg.getUnlinkedInstances('cam2').length, 1);
            assertEqual(fg.getUnlinkedInstances('cam3').length, 1);

            // Create group from all 3
            var group = session.createGroupFromUnlinked(0, [ul1, ul2, ul3]);
            assertNotNull(group, 'Group should be created');
            assertEqual(group.cameraNames.length, 3, 'Group should have 3 cameras');

            // Unlinked should be removed
            assertEqual(fg.getUnlinkedInstances('cam1').length, 0);
            assertEqual(fg.getUnlinkedInstances('cam2').length, 0);
            assertEqual(fg.getUnlinkedInstances('cam3').length, 0);

            // Linked instances should be in frame group
            assertGreaterThan(fg.getInstances('cam1').length, 0, 'cam1 should have instances');
            assertGreaterThan(fg.getInstances('cam2').length, 0, 'cam2 should have instances');
            assertGreaterThan(fg.getInstances('cam3').length, 0, 'cam3 should have instances');

            // Instance group should be in session
            var groups = session.getInstanceGroupsForFrame(0);
            assertEqual(groups.length, 1);
            assertEqual(groups[0], group);
        });
    });
})();
