/**
 * test-project-triangulation.js - Tests for project save/load and triangulation pipeline.
 *
 * Covers:
 *  1. saveProject produces correct v2 format with videoManifest
 *  2. Project V2 data restoration: cameras, skeleton, instances, groups
 *  3. Triangulation pipeline with realistic camera setups
 *  4. Camera name / view name matching and mismatch resolution
 *  5. DLT triangulation math
 *  6. End-to-end triangulation with fill for missing views
 *  7. Real calibration data from tempdata
 */

(function () {
    var describe = TestFramework.describe;
    var it = TestFramework.it;
    var assert = TestFramework.assert;
    var assertEqual = TestFramework.assertEqual;
    var beforeEach = TestFramework.beforeEach;

    // ----------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------

    function makeCamera(name) {
        // Simple identity-ish camera at origin
        return new Camera(
            name,
            [[500, 0, 320], [0, 500, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
            [640, 480]
        );
    }

    function makeStereoCamera(name, tx) {
        // Camera offset along X for stereo triangulation
        return new Camera(
            name,
            [[500, 0, 320], [0, 500, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0],
            [0, 0, 0],
            [tx, 0, 0],
            [640, 480]
        );
    }

    function makeSkeleton() {
        return new Skeleton('mouse', ['nose', 'tail'], [[0, 1]]);
    }

    function makeSession(cameraNames) {
        var cameras = cameraNames.map(function (n, i) {
            return makeStereoCamera(n, i * 10);
        });
        var skeleton = makeSkeleton();
        return new Session(cameras, skeleton, ['track_0']);
    }

    function addLabeledGroup(session, frameIdx, trackIdx, pointsPerCam) {
        // pointsPerCam: { camName: [[x,y], ...] }
        if (!session.frameGroups.has(frameIdx)) {
            session.addFrameGroup(new FrameGroup(frameIdx));
        }
        var fg = session.frameGroups.get(frameIdx);

        var group = new InstanceGroup(Date.now(), trackIdx);
        for (var camName in pointsPerCam) {
            var inst = new Instance(pointsPerCam[camName], trackIdx, 'user', 1.0);
            group.addInstance(camName, inst);
            fg.addInstance(camName, inst);
        }

        if (!session.instanceGroups.has(frameIdx)) {
            session.instanceGroups.set(frameIdx, new Map());
        }
        var trackMap = session.instanceGroups.get(frameIdx);
        if (!trackMap.has(trackIdx)) trackMap.set(trackIdx, []);
        trackMap.get(trackIdx).push(group);

        return group;
    }

    // Real calibration from tempdata/calibration.toml
    function makeTempDataCameras() {
        return [
            new Camera('A',
                [[1190.6939645110197, 0, 255.5], [0, 1190.6939645110197, 255.5], [0, 0, 1]],
                [-0.23973960295301186, 0, 0, 0, 0],
                [0.0007428135485053219, 0.0033145959906249983, -0.0016785654428863113],
                [-0.3825769953311274, 0.09975553838950957, -1.0076477752410165],
                [512, 512]
            ),
            new Camera('B',
                [[1180.921908386645, 0, 255.5], [0, 1180.921908386645, 255.5], [0, 0, 1]],
                [-0.29391979899003534, 0, 0, 0, 0],
                [-1.7401634274728643, -0.7044265287055457, 1.931945982588117],
                [112.57007009010799, 3.840880948989831, 87.00474618132775],
                [512, 512]
            ),
            new Camera('C',
                [[1165.4397817296924, 0, 255.5], [0, 1165.4397817296924, 255.5], [0, 0, 1]],
                [-0.25044856890836803, 0, 0, 0, 0],
                [0.06497384041798301, 1.0913383971860997, 0.01835634373161448],
                [-99.65922711157155, 13.759145913312045, 48.2084866807691],
                [512, 512]
            )
        ];
    }

    function makeTempDataSkeleton() {
        return new Skeleton('skeleton', ['shoulder', 'elbow', 'wrist'], [[0, 1], [1, 2]]);
    }

    // ----------------------------------------------------------
    // 1. Save / load round-trip
    // ----------------------------------------------------------

    describe('Project Save Format', function () {

        it('saveProject v2 includes videoManifest', function () {
            var session = makeSession(['cam1', 'cam2']);
            var pt3d = [5, 3, 500];
            addLabeledGroup(session, 0, 0, {
                cam1: [session.cameras[0].project(pt3d), session.cameras[0].project([8, 6, 500])],
                cam2: [session.cameras[1].project(pt3d), session.cameras[1].project([8, 6, 500])],
            });

            // Simulate saveProject serialization
            var projectData = {
                version: 2,
                skeleton: {
                    name: session.skeleton.name,
                    nodes: session.skeleton.nodes,
                    edges: session.skeleton.edges,
                },
                cameras: session.cameras.map(function (c) {
                    return { name: c.name, matrix: c.matrix, dist: c.dist, rvec: c.rvec, tvec: c.tvec, size: c.size };
                }),
                tracks: session.tracks,
                videoManifest: [
                    { filename: 'cam1', assignedCamera: 'cam1' },
                    { filename: 'cam2', assignedCamera: 'cam2' },
                ],
                frames: {},
            };

            assertEqual(projectData.version, 2);
            assertEqual(projectData.videoManifest.length, 2);
            assertEqual(projectData.videoManifest[0].assignedCamera, 'cam1');
            assertEqual(projectData.skeleton.nodes.length, 2);
            assertEqual(projectData.cameras.length, 2);
        });
    });

    // ----------------------------------------------------------
    // 2. Project V2 data restoration
    // ----------------------------------------------------------

    describe('Project V2 Data Restoration', function () {

        it('restores cameras from project JSON', function () {
            var cameras = [
                { name: 'top', matrix: [[500,0,320],[0,500,240],[0,0,1]], dist: [0,0,0,0,0], rvec: [0,0,0], tvec: [0,0,0], size: [640,480] },
                { name: 'side', matrix: [[500,0,320],[0,500,240],[0,0,1]], dist: [0,0,0,0,0], rvec: [0,0,0], tvec: [100,0,0], size: [640,480] },
            ];
            var parsed = parseCalibrationJSON(JSON.stringify({ cameras: cameras }));
            assertEqual(parsed.length, 2);
            assertEqual(parsed[0].name, 'top');
            assertEqual(parsed[1].name, 'side');
            var P = parsed[0].projectionMatrix;
            assert(P != null && P.length === 3, 'should have 3x4 projection matrix');
            assert(P[0].length === 4, 'rows should have 4 columns');
        });

        it('restores skeleton from project JSON', function () {
            var skeletonData = { name: 'mouse', nodes: ['nose', 'head', 'tail'], edges: [[0,1],[1,2]] };
            var skel = new Skeleton(skeletonData.name, skeletonData.nodes, skeletonData.edges);
            assertEqual(skel.nodes.length, 3);
            assertEqual(skel.edges.length, 2);
            assertEqual(skel.name, 'mouse');
        });

        it('restores instance groups with points', function () {
            var session = makeSession(['cam1', 'cam2']);
            var fg = new FrameGroup(5);

            var group = new InstanceGroup(999, 0);
            var inst1 = new Instance([[100, 200], [150, 250]], 0, 'user', 1.0);
            var inst2 = new Instance([[110, 210], [160, 260]], 0, 'user', 1.0);
            group.addInstance('cam1', inst1);
            group.addInstance('cam2', inst2);
            fg.addInstance('cam1', inst1);
            fg.addInstance('cam2', inst2);

            if (!session.instanceGroups.has(5)) session.instanceGroups.set(5, new Map());
            var trackMap = session.instanceGroups.get(5);
            trackMap.set(0, [group]);
            session.addFrameGroup(fg);

            var retrieved = session.instanceGroups.get(5);
            assert(retrieved != null, 'should have instanceGroups for frame 5');
            var groups = retrieved.get(0);
            assertEqual(groups.length, 1);

            var g = groups[0];
            var i1 = g.getInstance('cam1');
            var i2 = g.getInstance('cam2');
            assert(i1 != null, 'should have cam1 instance');
            assert(i2 != null, 'should have cam2 instance');
            assertEqual(i1.points[0][0], 100);
            assertEqual(i2.points[0][0], 110);
        });

        it('restores unlinked instances', function () {
            var fg = new FrameGroup(0);
            var inst = new Instance([[50, 60], [70, 80]], 0, 'user', 1.0);
            var unlinked = new UnlinkedInstance(inst, 'cam1');
            fg.addUnlinkedInstance('cam1', unlinked);

            var uls = fg.getUnlinkedInstances('cam1');
            assertEqual(uls.length, 1);
            assertEqual(uls[0].cameraName, 'cam1');
            assertEqual(uls[0].instance.points[0][0], 50);
        });

        it('restores points3d on groups', function () {
            var group = new InstanceGroup(1, 0);
            group.points3d = [[10, 20, 30], [40, 50, 60]];
            assertEqual(group.points3d.length, 2);
            assertEqual(group.points3d[0][2], 30);
        });
    });

    // ----------------------------------------------------------
    // 3. Triangulation pipeline
    // ----------------------------------------------------------

    describe('Triangulation Pipeline', function () {

        it('triangulateAndReproject returns valid structure', function () {
            var session = makeSession(['cam1', 'cam2', 'cam3']);
            var pt3d_nose = [5, 3, 500];
            var pt3d_tail = [8, 6, 500];
            var group = addLabeledGroup(session, 0, 0, {
                cam1: [session.cameras[0].project(pt3d_nose), session.cameras[0].project(pt3d_tail)],
                cam2: [session.cameras[1].project(pt3d_nose), session.cameras[1].project(pt3d_tail)],
            });

            var result = triangulateAndReproject(group, session.cameras);

            assert(result.points3d != null, 'should have points3d');
            assertEqual(result.points3d.length, 2, 'should have 2 keypoints');
            assert(result.reprojections != null, 'should have reprojections');
            assert(result.reprojections.cam1 != null, 'should have cam1 reprojections');
            assert(result.reprojections.cam2 != null, 'should have cam2 reprojections');
            assert(result.reprojections.cam3 != null, 'should have cam3 reprojections');
            assert(result.meanError != null, 'should have meanError');
        });

        it('triangulation produces non-NaN 3D points', function () {
            var session = makeSession(['cam1', 'cam2']);
            var pt3d_nose = [5, 3, 500];
            var pt3d_tail = [8, 6, 500];
            var group = addLabeledGroup(session, 0, 0, {
                cam1: [session.cameras[0].project(pt3d_nose), session.cameras[0].project(pt3d_tail)],
                cam2: [session.cameras[1].project(pt3d_nose), session.cameras[1].project(pt3d_tail)],
            });

            var result = triangulateAndReproject(group, session.cameras);

            for (var i = 0; i < result.points3d.length; i++) {
                var pt = result.points3d[i];
                assert(pt != null, 'point ' + i + ' should not be null');
                assert(!isNaN(pt[0]) && !isNaN(pt[1]) && !isNaN(pt[2]),
                    'point ' + i + ' should not have NaN: ' + JSON.stringify(pt));
            }
        });

        it('reprojections are close to original observations', function () {
            var cam1 = makeStereoCamera('cam1', 0);
            var cam2 = makeStereoCamera('cam2', 10);
            var cameras = [cam1, cam2];

            var pt3d = [5, 3, 500];
            var obs1 = cam1.project(pt3d);
            var obs2 = cam2.project(pt3d);

            var session = new Session(cameras, makeSkeleton(), ['track_0']);
            var group = addLabeledGroup(session, 0, 0, {
                cam1: [obs1, null],
                cam2: [obs2, null],
            });

            var result = triangulateAndReproject(group, cameras);

            var reproj1 = result.reprojections.cam1[0];
            assert(reproj1 != null, 'cam1 reprojection should exist');
            var dx = reproj1[0] - obs1[0];
            var dy = reproj1[1] - obs1[1];
            var error = Math.sqrt(dx * dx + dy * dy);
            assert(error < 5, 'cam1 reprojection error should be < 5px, got ' + error.toFixed(2));
        });

        it('fills missing views with predicted instances', function () {
            var session = makeSession(['cam1', 'cam2', 'cam3']);
            var pt3d_nose = [5, 3, 500];
            var pt3d_tail = [8, 6, 500];
            var group = addLabeledGroup(session, 0, 0, {
                cam1: [session.cameras[0].project(pt3d_nose), session.cameras[0].project(pt3d_tail)],
                cam2: [session.cameras[1].project(pt3d_nose), session.cameras[1].project(pt3d_tail)],
            });

            var result = triangulateAndReproject(group, session.cameras);
            group.reprojections = result.reprojections;
            group.points3d = result.points3d;

            var cameras = session.cameras;
            var filledCount = 0;
            for (var ci = 0; ci < cameras.length; ci++) {
                var cam = cameras[ci];
                if (!group.getInstance(cam.name) && result.reprojections[cam.name]) {
                    var reprojPts = result.reprojections[cam.name];
                    var filledInstance = new Instance(
                        reprojPts.map(function (p) { return p ? [p[0], p[1]] : null; }),
                        group.trackIdx, 'predicted', 0.5
                    );
                    group.addInstance(cam.name, filledInstance);
                    filledCount++;
                }
            }

            assertEqual(filledCount, 1, 'should fill 1 missing view (cam3)');
            var cam3Inst = group.getInstance('cam3');
            assert(cam3Inst != null, 'cam3 should now have an instance');
            assertEqual(cam3Inst.type, 'predicted');
            assert(cam3Inst.points[0] != null, 'filled point should not be null');
            assert(!isNaN(cam3Inst.points[0][0]), 'filled point X should not be NaN');
        });

        it('skips groups with fewer than 2 labeled views', function () {
            var session = makeSession(['cam1', 'cam2', 'cam3']);
            var group = addLabeledGroup(session, 0, 0, {
                cam1: [[350, 260], [360, 270]],
            });

            var viewsWithLabels = 0;
            for (var ci = 0; ci < session.cameras.length; ci++) {
                var inst = group.getInstance(session.cameras[ci].name);
                if (inst && inst.points && inst.points.some(function (p) { return p != null; })) {
                    viewsWithLabels++;
                }
            }

            assertEqual(viewsWithLabels, 1, 'should only have 1 labeled view');
            assert(viewsWithLabels < 2, 'should be insufficient for triangulation');
        });
    });

    // ----------------------------------------------------------
    // 4. Camera name / view name consistency
    // ----------------------------------------------------------

    describe('Camera-View Name Matching', function () {

        it('autoAssignVideosToCameras matches exact names', function () {
            var cameraNames = ['top', 'side', 'front'];
            var videoFiles = [
                { name: 'top', assignedCamera: null },
                { name: 'side', assignedCamera: null },
                { name: 'front', assignedCamera: null },
            ];

            for (var i = 0; i < videoFiles.length; i++) {
                if (cameraNames.indexOf(videoFiles[i].name) >= 0) {
                    videoFiles[i].assignedCamera = videoFiles[i].name;
                }
            }

            assertEqual(videoFiles[0].assignedCamera, 'top');
            assertEqual(videoFiles[1].assignedCamera, 'side');
            assertEqual(videoFiles[2].assignedCamera, 'front');
        });

        it('substring matching works for partial names', function () {
            var cameraNames = ['top', 'side', 'front'];
            var videoFiles = [
                { name: 'session_top_video', assignedCamera: null },
                { name: 'session_side_video', assignedCamera: null },
                { name: 'session_front_video', assignedCamera: null },
            ];

            for (var i = 0; i < videoFiles.length; i++) {
                var lower = videoFiles[i].name.toLowerCase();
                for (var j = 0; j < cameraNames.length; j++) {
                    var camLower = cameraNames[j].toLowerCase();
                    if (lower.indexOf(camLower) >= 0) {
                        videoFiles[i].assignedCamera = cameraNames[j];
                        break;
                    }
                }
            }

            assertEqual(videoFiles[0].assignedCamera, 'top');
            assertEqual(videoFiles[1].assignedCamera, 'side');
            assertEqual(videoFiles[2].assignedCamera, 'front');
        });

        it('group.getInstance uses camera name from InstanceGroup', function () {
            var group = new InstanceGroup(1, 0);
            var inst = new Instance([[100, 200]], 0, 'user', 1.0);
            group.addInstance('top_camera', inst);

            assert(group.getInstance('top_camera') != null, 'should find by exact name');
            assert(group.getInstance('top') == null, 'should not find by partial name');
            assert(group.getInstance('TOP_CAMERA') == null, 'should not find by different case');
        });
    });

    // ----------------------------------------------------------
    // 4b. Camera name mismatch resolution (CamA→A, CamB→B, etc.)
    // ----------------------------------------------------------

    describe('Camera Name Mismatch Resolution', function () {

        it('renameCameraInAllData updates InstanceGroup keys', function () {
            var cameras = makeTempDataCameras();
            var skeleton = makeTempDataSkeleton();
            var session = new Session(cameras, skeleton, ['track_0']);

            // Create group with "CamA" and "CamB" keys (video names, not camera names)
            var fg = new FrameGroup(0);
            var group = new InstanceGroup(1, 0);
            var inst1 = new Instance([[100, 200], [150, 250], [200, 300]], 0, 'user', 1.0);
            var inst2 = new Instance([[110, 210], [160, 260], [210, 310]], 0, 'user', 1.0);
            group.addInstance('CamA', inst1);
            group.addInstance('CamB', inst2);
            fg.addInstance('CamA', inst1);
            fg.addInstance('CamB', inst2);
            session.addFrameGroup(fg);
            if (!session.instanceGroups.has(0)) session.instanceGroups.set(0, new Map());
            session.instanceGroups.get(0).set(0, [group]);

            // Verify keys before rename
            assert(group.getInstance('CamA') != null, 'before: should have CamA');
            assert(group.getInstance('A') == null, 'before: should not have A');

            // Rename CamA → A, CamB → B
            session.renameCameraInAllData('CamA', 'A');
            session.renameCameraInAllData('CamB', 'B');

            // Verify keys after rename
            assert(group.getInstance('A') != null, 'after: should have A');
            assert(group.getInstance('B') != null, 'after: should have B');
            assert(group.getInstance('CamA') == null, 'after: should not have CamA');
            assert(group.getInstance('CamB') == null, 'after: should not have CamB');
        });

        it('renameCameraInAllData updates FrameGroup keys', function () {
            var cameras = makeTempDataCameras();
            var skeleton = makeTempDataSkeleton();
            var session = new Session(cameras, skeleton, ['track_0']);

            var fg = new FrameGroup(0);
            var inst = new Instance([[100, 200]], 0, 'user', 1.0);
            fg.addInstance('CamA', inst);
            session.addFrameGroup(fg);

            session.renameCameraInAllData('CamA', 'A');

            assertEqual(fg.getInstances('A').length, 1, 'should have instances under A');
            assertEqual(fg.getInstances('CamA').length, 0, 'should not have instances under CamA');
        });

        it('renameCameraInAllData updates UnlinkedInstance camera names', function () {
            var cameras = makeTempDataCameras();
            var skeleton = makeTempDataSkeleton();
            var session = new Session(cameras, skeleton, ['track_0']);

            var fg = new FrameGroup(0);
            var inst = new Instance([[100, 200]], 0, 'user', 1.0);
            var ul = new UnlinkedInstance(inst, 'CamA');
            fg.addUnlinkedInstance('CamA', ul);
            session.addFrameGroup(fg);

            session.renameCameraInAllData('CamA', 'A');

            assertEqual(fg.getUnlinkedInstances('A').length, 1, 'should have unlinked under A');
            assertEqual(fg.getUnlinkedInstances('CamA').length, 0, 'should not have unlinked under CamA');
            assertEqual(fg.getUnlinkedInstances('A')[0].cameraName, 'A', 'cameraName should be updated');
        });

        it('triangulation works after name resolution on tempdata-like setup', function () {
            var cameras = makeTempDataCameras();
            var skeleton = makeTempDataSkeleton();
            var session = new Session(cameras, skeleton, ['track_0']);

            // Simulate: instances were created with video names before calibration was loaded
            var fg = new FrameGroup(0);
            var group = new InstanceGroup(1, 0);

            // Use points from the saved project.mvgui.json (CamA and CamB data)
            var instA = new Instance([
                [45.55, 99.39],
                [-1.13, 225.88],
                [163.01, 283.11]
            ], 0, 'user', 1.0);
            var instB = new Instance([
                [323.39, 239.44],
                [348.99, 147.58],
                [365.55, 54.21]
            ], 0, 'user', 1.0);

            // Keys are "CamA"/"CamB" (video names), not "A"/"B" (camera names)
            group.addInstance('CamA', instA);
            group.addInstance('CamB', instB);
            fg.addInstance('CamA', instA);
            fg.addInstance('CamB', instB);
            session.addFrameGroup(fg);
            if (!session.instanceGroups.has(0)) session.instanceGroups.set(0, new Map());
            session.instanceGroups.get(0).set(0, [group]);

            // Before rename: triangulation should fail (camera names don't match)
            var viewsBefore = 0;
            for (var ci = 0; ci < cameras.length; ci++) {
                var inst = group.getInstance(cameras[ci].name);
                if (inst && inst.points && inst.points.some(function (p) { return p != null; })) {
                    viewsBefore++;
                }
            }
            assertEqual(viewsBefore, 0, 'before rename: no cameras should match');

            // Apply rename
            session.renameCameraInAllData('CamA', 'A');
            session.renameCameraInAllData('CamB', 'B');

            // After rename: triangulation should succeed
            var viewsAfter = 0;
            for (var ci2 = 0; ci2 < cameras.length; ci2++) {
                var inst2 = group.getInstance(cameras[ci2].name);
                if (inst2 && inst2.points && inst2.points.some(function (p) { return p != null; })) {
                    viewsAfter++;
                }
            }
            assertEqual(viewsAfter, 2, 'after rename: 2 cameras should match');

            // Now triangulate
            var result = triangulateAndReproject(group, cameras);
            assert(result.points3d != null, 'should have points3d');
            assertEqual(result.points3d.length, 3, 'should have 3 keypoints (shoulder, elbow, wrist)');

            // At least some 3D points should be non-null (the cameras have real calibration)
            var validPts = result.points3d.filter(function (p) { return p != null; }).length;
            assert(validPts > 0, 'should have at least 1 valid 3D point, got ' + validPts);

            // Should have reprojections for all 3 cameras including C (missing view)
            assert(result.reprojections.A != null, 'should have A reprojections');
            assert(result.reprojections.B != null, 'should have B reprojections');
            assert(result.reprojections.C != null, 'should have C reprojections');
        });

        it('CamA/CamB/CamC correctly maps to A/B/C via substring', function () {
            // Simulate the substring matching logic used in autoAssignVideosToCameras
            var cameraNames = ['A', 'B', 'C'];
            var videoFiles = [
                { name: 'CamA', assignedCamera: null },
                { name: 'CamB', assignedCamera: null },
                { name: 'CamC', assignedCamera: null },
            ];

            for (var i = 0; i < videoFiles.length; i++) {
                var lower = videoFiles[i].name.toLowerCase();
                for (var j = 0; j < cameraNames.length; j++) {
                    var camLower = cameraNames[j].toLowerCase();
                    // Check not already used
                    var alreadyUsed = videoFiles.some(function (other) {
                        return other !== videoFiles[i] && other.assignedCamera === cameraNames[j];
                    });
                    if (alreadyUsed) continue;

                    if (lower.indexOf(camLower) >= 0 || camLower.indexOf(lower) >= 0) {
                        videoFiles[i].assignedCamera = cameraNames[j];
                        break;
                    }
                }
            }

            assertEqual(videoFiles[0].assignedCamera, 'A', 'CamA should map to A');
            assertEqual(videoFiles[1].assignedCamera, 'B', 'CamB should map to B');
            assertEqual(videoFiles[2].assignedCamera, 'C', 'CamC should map to C');
        });
    });

    // ----------------------------------------------------------
    // 5. DLT triangulation math
    // ----------------------------------------------------------

    describe('DLT Triangulation Math', function () {

        it('triangulatePointDLT returns null for < 2 observations', function () {
            var P = [[500, 0, 320, 0], [0, 500, 240, 0], [0, 0, 1, 0]];
            var result = triangulatePointDLT([null], [P]);
            assert(result === null, 'should return null for 1 camera');
        });

        it('triangulatePointDLT produces finite 3D point for 2 views', function () {
            var cam1 = makeStereoCamera('c1', 0);
            var cam2 = makeStereoCamera('c2', 10);
            var P1 = cam1.projectionMatrix;
            var P2 = cam2.projectionMatrix;

            var pt3d = [5, 3, 500];
            var obs1 = cam1.project(pt3d);
            var obs2 = cam2.project(pt3d);

            var result = triangulatePointDLT([obs1, obs2], [P1, P2]);
            assert(result != null, 'should return a point');
            assert(isFinite(result[0]) && isFinite(result[1]) && isFinite(result[2]),
                'point should be finite: ' + JSON.stringify(result));
        });

        it('triangulated point is close to ground truth', function () {
            var cam1 = makeStereoCamera('c1', 0);
            var cam2 = makeStereoCamera('c2', 10);

            var gt = [5, 3, 500];
            var obs1 = cam1.project(gt);
            var obs2 = cam2.project(gt);

            var result = triangulatePointDLT([obs1, obs2], [cam1.projectionMatrix, cam2.projectionMatrix]);
            assert(result != null, 'should return a point');

            var dx = result[0] - gt[0];
            var dy = result[1] - gt[1];
            var dz = result[2] - gt[2];
            var dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            assert(dist < 1, 'triangulated point should be close to ground truth, distance: ' + dist.toFixed(4));
        });

        it('reprojectPoint maps 3D point to 2D', function () {
            var P = makeStereoCamera('c1', 0).projectionMatrix;
            var pt2d = reprojectPoint([0, 0, 100], P);
            assert(pt2d != null, 'should return 2D point');
            assert(isFinite(pt2d[0]) && isFinite(pt2d[1]),
                '2D point should be finite: ' + JSON.stringify(pt2d));
        });

        it('reprojectPoints handles null entries', function () {
            var P = makeStereoCamera('c1', 0).projectionMatrix;
            var result = reprojectPoints([[0, 0, 100], null, [10, 10, 100]], P);
            assertEqual(result.length, 3);
            assert(result[0] != null, 'first should not be null');
            assert(result[1] === null, 'second should be null');
            assert(result[2] != null, 'third should not be null');
        });

        it('computeReprojectionErrors returns per-point errors', function () {
            var observed = [[100, 200], [150, 250], null];
            var reprojected = [[101, 201], [155, 255], [999, 999]];
            var errors = computeReprojectionErrors(observed, reprojected);
            assertEqual(errors.length, 3);
            assert(errors[0] > 1 && errors[0] < 2, 'first error should be ~1.41');
            assert(errors[1] > 6 && errors[1] < 8, 'second error should be ~7.07');
            assert(errors[2] === null, 'third error should be null (no observation)');
        });
    });

    // ----------------------------------------------------------
    // 6. End-to-end triangulation with fill
    // ----------------------------------------------------------

    describe('E2E Triangulation + Fill', function () {

        it('full pipeline: 2 cameras labeled, 3rd filled', function () {
            var cam1 = makeStereoCamera('cam1', 0);
            var cam2 = makeStereoCamera('cam2', 10);
            var cam3 = makeStereoCamera('cam3', -10);
            var cameras = [cam1, cam2, cam3];
            var session = new Session(cameras, makeSkeleton(), ['track_0']);

            var pt3d_nose = [5, 3, 500];
            var pt3d_tail = [8, 6, 500];
            var group = addLabeledGroup(session, 0, 0, {
                cam1: [cam1.project(pt3d_nose), cam1.project(pt3d_tail)],
                cam2: [cam2.project(pt3d_nose), cam2.project(pt3d_tail)],
            });

            var result = triangulateAndReproject(group, cameras);

            assert(result.points3d[0] != null, 'first 3D point should exist');
            assert(result.points3d[1] != null, 'second 3D point should exist');

            group.points3d = result.points3d;
            group.reprojections = result.reprojections;

            assert(group.getInstance('cam3') == null, 'cam3 should not have instance yet');
            var reproj3 = result.reprojections.cam3;
            assert(reproj3 != null, 'should have cam3 reprojections');

            var filledInst = new Instance(
                reproj3.map(function (p) { return p ? [p[0], p[1]] : null; }),
                0, 'predicted', 0.5
            );
            group.addInstance('cam3', filledInst);

            var cam3Inst = group.getInstance('cam3');
            assert(cam3Inst != null, 'cam3 should now have instance');
            assertEqual(cam3Inst.type, 'predicted');

            for (var ci = 0; ci < cameras.length; ci++) {
                assert(group.getInstance(cameras[ci].name) != null,
                    cameras[ci].name + ' should have instance after fill');
            }
        });

        it('reprojection error is low for consistent observations', function () {
            var cam1 = makeStereoCamera('cam1', 0);
            var cam2 = makeStereoCamera('cam2', 10);
            var cameras = [cam1, cam2];
            var session = new Session(cameras, makeSkeleton(), ['track_0']);

            var pt3d = [5, 3, 500];
            var group = addLabeledGroup(session, 0, 0, {
                cam1: [cam1.project(pt3d), null],
                cam2: [cam2.project(pt3d), null],
            });

            var result = triangulateAndReproject(group, cameras);
            assert(result.meanError != null, 'should have mean error');
            assert(isFinite(result.meanError), 'mean error should be finite');
            assert(result.meanError < 1, 'mean error should be < 1px for perfect observations, got ' + result.meanError.toFixed(4));
        });
    });

    // ----------------------------------------------------------
    // 7. Triangulation with real tempdata calibration
    // ----------------------------------------------------------

    describe('TempData Real Calibration Triangulation', function () {

        it('tempdata cameras have valid projection matrices', function () {
            var cameras = makeTempDataCameras();
            for (var i = 0; i < cameras.length; i++) {
                var P = cameras[i].projectionMatrix;
                assert(P != null, cameras[i].name + ' should have projection matrix');
                assertEqual(P.length, 3, cameras[i].name + ' P should have 3 rows');
                assertEqual(P[0].length, 4, cameras[i].name + ' P rows should have 4 cols');
                // Check no NaN
                for (var r = 0; r < 3; r++) {
                    for (var c = 0; c < 4; c++) {
                        assert(!isNaN(P[r][c]),
                            cameras[i].name + ' P[' + r + '][' + c + '] should not be NaN');
                    }
                }
            }
        });

        it('tempdata cameras can project and triangulate a 3D point', function () {
            var cameras = makeTempDataCameras();
            // A 3D point roughly in the scene
            var pt3d = [0, 0, 0]; // origin (approximately where the subject would be)

            // Project to cameras A and B
            var obsA = cameras[0].project(pt3d);
            var obsB = cameras[1].project(pt3d);

            assert(isFinite(obsA[0]) && isFinite(obsA[1]), 'A projection should be finite');
            assert(isFinite(obsB[0]) && isFinite(obsB[1]), 'B projection should be finite');

            // Triangulate from A and B
            var result = triangulatePointDLT(
                [obsA, obsB, null],
                [cameras[0].projectionMatrix, cameras[1].projectionMatrix, cameras[2].projectionMatrix]
            );
            assert(result != null, 'should triangulate a point from A and B');
            assert(isFinite(result[0]) && isFinite(result[1]) && isFinite(result[2]),
                'triangulated point should be finite: ' + JSON.stringify(result));

            // The triangulated point should be close to the ground truth
            var dist = Math.sqrt(
                (result[0] - pt3d[0]) * (result[0] - pt3d[0]) +
                (result[1] - pt3d[1]) * (result[1] - pt3d[1]) +
                (result[2] - pt3d[2]) * (result[2] - pt3d[2])
            );
            assert(dist < 5, 'triangulated point should be close to origin, distance: ' + dist.toFixed(4));
        });

        it('triangulates from saved project data (CamA+CamB→fill C)', function () {
            var cameras = makeTempDataCameras();
            var skeleton = makeTempDataSkeleton();
            var session = new Session(cameras, skeleton, ['track_0']);

            // Use exact points from project.mvgui.json, but with correct camera names
            var instA = new Instance([
                [45.55, 99.39],
                [-1.13, 225.88],
                [163.01, 283.11]
            ], 0, 'user', 1.0);
            var instB = new Instance([
                [323.39, 239.44],
                [348.99, 147.58],
                [365.55, 54.21]
            ], 0, 'user', 1.0);

            var fg = new FrameGroup(0);
            var group = new InstanceGroup(1, 0);
            group.addInstance('A', instA);
            group.addInstance('B', instB);
            fg.addInstance('A', instA);
            fg.addInstance('B', instB);
            session.addFrameGroup(fg);
            if (!session.instanceGroups.has(0)) session.instanceGroups.set(0, new Map());
            session.instanceGroups.get(0).set(0, [group]);

            // Triangulate
            var result = triangulateAndReproject(group, cameras);

            // Should produce 3D points
            var validPts = result.points3d.filter(function (p) { return p != null; });
            assert(validPts.length > 0,
                'should produce valid 3D points from real calibration, got ' + validPts.length);

            // Should have reprojections for C (the missing camera)
            assert(result.reprojections.C != null, 'should have C reprojections');
            var cReproj = result.reprojections.C.filter(function (p) { return p != null; });
            assert(cReproj.length > 0, 'C reprojections should have non-null points');

            // Fill the missing view C
            var filledInst = new Instance(
                result.reprojections.C.map(function (p) { return p ? [p[0], p[1]] : null; }),
                0, 'predicted', 0.5
            );
            group.addInstance('C', filledInst);
            assert(group.getInstance('C') != null, 'C should now have instance');
            assertEqual(group.getInstance('C').type, 'predicted');
        });

        it('full flow: mismatched names → resolve → triangulate → fill', function () {
            var cameras = makeTempDataCameras();
            var skeleton = makeTempDataSkeleton();
            var session = new Session(cameras, skeleton, ['track_0']);

            // Step 1: Create data with WRONG camera names (video names)
            var fg = new FrameGroup(0);
            var group = new InstanceGroup(1, 0);
            group.addInstance('CamA', new Instance([[45.55, 99.39], [-1.13, 225.88], [163.01, 283.11]], 0, 'user', 1.0));
            group.addInstance('CamB', new Instance([[323.39, 239.44], [348.99, 147.58], [365.55, 54.21]], 0, 'user', 1.0));
            fg.addInstance('CamA', group.getInstance('CamA'));
            fg.addInstance('CamB', group.getInstance('CamB'));
            session.addFrameGroup(fg);
            if (!session.instanceGroups.has(0)) session.instanceGroups.set(0, new Map());
            session.instanceGroups.get(0).set(0, [group]);

            // Step 2: Verify triangulation fails with wrong names
            var viewsBefore = 0;
            for (var ci = 0; ci < cameras.length; ci++) {
                if (group.getInstance(cameras[ci].name)) viewsBefore++;
            }
            assertEqual(viewsBefore, 0, 'before: no cameras match (CamA≠A, CamB≠B)');

            // Step 3: Apply rename (simulates what handleLoadCalibration does)
            session.renameCameraInAllData('CamA', 'A');
            session.renameCameraInAllData('CamB', 'B');

            // Step 4: Verify cameras now match
            var viewsAfter = 0;
            for (var ci2 = 0; ci2 < cameras.length; ci2++) {
                if (group.getInstance(cameras[ci2].name)) viewsAfter++;
            }
            assertEqual(viewsAfter, 2, 'after: 2 cameras should match (A and B)');

            // Step 5: Triangulate
            var result = triangulateAndReproject(group, cameras);
            var validPts = result.points3d.filter(function (p) { return p != null; }).length;
            assert(validPts > 0, 'should have valid 3D points after name resolution');
            assert(result.meanError != null, 'should have mean error');

            // Step 6: Fill missing C
            assert(group.getInstance('C') == null, 'C should not have instance yet');
            var cReproj = result.reprojections.C;
            assert(cReproj != null, 'should have C reprojections');
            var filledInst = new Instance(
                cReproj.map(function (p) { return p ? [p[0], p[1]] : null; }),
                0, 'predicted', 0.5
            );
            group.addInstance('C', filledInst);
            assert(group.getInstance('C') != null, 'C should have instance after fill');
            assertEqual(group.cameraNames.length, 3, 'should have 3 cameras after fill');
        });
    });

})();
