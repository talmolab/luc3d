/**
 * test-tempdata-triangulation.js - Tests using actual tempdata calibration + pose values
 *
 * Validates the full pipeline: Camera → projection matrix → DLT triangulation → 3D points
 * Uses real calibration data from tempdata/calibration.toml and pose data from
 * tempdata/project.mvgui.json to ensure end-to-end correctness.
 */

TestFramework.describe('Tempdata Triangulation Pipeline', function () {

    // Exact calibration from tempdata/calibration.toml
    var camAData = {
        name: 'CamA',
        matrix: [[1190.6939645110197, 0.0, 255.5], [0.0, 1190.6939645110197, 255.5], [0.0, 0.0, 1.0]],
        dist: [-0.23973960295301186, 0.0, 0.0, 0.0, 0.0],
        rvec: [0.0007428135485053219, 0.0033145959906249983, -0.0016785654428863113],
        tvec: [-0.3825769953311274, 0.09975553838950957, -1.0076477752410165],
        size: [512, 512]
    };

    var camBData = {
        name: 'CamB',
        matrix: [[1180.921908386645, 0.0, 255.5], [0.0, 1180.921908386645, 255.5], [0.0, 0.0, 1.0]],
        dist: [-0.29391979899003534, 0.0, 0.0, 0.0, 0.0],
        rvec: [-1.7401634274728643, -0.7044265287055457, 1.931945982588117],
        tvec: [112.57007009010799, 3.840880948989831, 87.00474618132775],
        size: [512, 512]
    };

    var camCData = {
        name: 'CamC',
        matrix: [[1165.4397817296924, 0.0, 255.5], [0.0, 1165.4397817296924, 255.5], [0.0, 0.0, 1.0]],
        dist: [-0.25044856890836803, 0.0, 0.0, 0.0, 0.0],
        rvec: [0.06497384041798301, 1.0913383971860997, 0.01835634373161448],
        tvec: [-99.65922711157155, 13.759145913312045, 48.2084866807691],
        size: [512, 512]
    };

    // Exact 2D observations from tempdata/project.mvgui.json frame 0
    var observedPoints = {
        CamA: [[118.93805309734513, 135.929203539823], [40.40117994100295, 217.4867256637168], [91.75221238938053, 344.3539823008849]],
        CamB: [[325.0973451327434, 211.44542772861357], [359.834808259587, 120.8259587020649], [368.8967551622419, 46.82005899705015]],
        CamC: [[134.79646017699116, 235.61061946902655], [94.01769911504425, 321.6991150442478], [115.16224188790561, 422.89085545722713]]
    };

    // Expected 3D points from tempdata/project.mvgui.json (saved triangulation result)
    var expectedPoints3d = [
        [-12.38478812995982, -10.536585198814874, 107.22133040619671],
        [-18.299461615756968, -3.028001092293388, 104.78817228916503],
        [-13.967054916042189, 7.1397180775817315, 104.8071192849564]
    ];

    function createCameras() {
        return [
            new Camera(camAData.name, camAData.matrix, camAData.dist, camAData.rvec, camAData.tvec, camAData.size),
            new Camera(camBData.name, camBData.matrix, camBData.dist, camBData.rvec, camBData.tvec, camBData.size),
            new Camera(camCData.name, camCData.matrix, camCData.dist, camCData.rvec, camCData.tvec, camCData.size)
        ];
    }

    // ---- Camera math tests ----

    TestFramework.it('Camera rotation matrix computation', function () {
        var camA = createCameras()[0];
        var R = camA.rotationMatrix;
        // CamA has near-zero rvec, so R ≈ Identity
        TestFramework.assert(Math.abs(R[0][0] - 1) < 0.001, 'CamA R[0][0] ≈ 1');
        TestFramework.assert(Math.abs(R[1][1] - 1) < 0.001, 'CamA R[1][1] ≈ 1');
        TestFramework.assert(Math.abs(R[2][2] - 1) < 0.001, 'CamA R[2][2] ≈ 1');

        var camB = createCameras()[1];
        var Rb = camB.rotationMatrix;
        // CamB has large rotation, R should not be identity
        TestFramework.assert(Math.abs(Rb[0][0] - 1) > 0.1, 'CamB R is not identity');
    });

    TestFramework.it('Camera position computation (-R^T * t)', function () {
        var cameras = createCameras();

        // CamA: near identity rotation, position ≈ -tvec = [0.38, -0.10, 1.01]
        var camA = cameras[0];
        var Ra = camA.rotationMatrix;
        var posA = [
            -(Ra[0][0]*camA.tvec[0] + Ra[1][0]*camA.tvec[1] + Ra[2][0]*camA.tvec[2]),
            -(Ra[0][1]*camA.tvec[0] + Ra[1][1]*camA.tvec[1] + Ra[2][1]*camA.tvec[2]),
            -(Ra[0][2]*camA.tvec[0] + Ra[1][2]*camA.tvec[1] + Ra[2][2]*camA.tvec[2])
        ];
        TestFramework.assert(Math.abs(posA[0] - 0.38) < 0.1, 'CamA position X ≈ 0.38, got ' + posA[0].toFixed(2));
        TestFramework.assert(Math.abs(posA[2] - 1.01) < 0.1, 'CamA position Z ≈ 1.01, got ' + posA[2].toFixed(2));

        // Inter-camera distances should be reasonable (50-200 range)
        var camB = cameras[1];
        var Rb = camB.rotationMatrix;
        var posB = [
            -(Rb[0][0]*camB.tvec[0] + Rb[1][0]*camB.tvec[1] + Rb[2][0]*camB.tvec[2]),
            -(Rb[0][1]*camB.tvec[0] + Rb[1][1]*camB.tvec[1] + Rb[2][1]*camB.tvec[2]),
            -(Rb[0][2]*camB.tvec[0] + Rb[1][2]*camB.tvec[1] + Rb[2][2]*camB.tvec[2])
        ];
        var dAB = Math.sqrt((posA[0]-posB[0])**2 + (posA[1]-posB[1])**2 + (posA[2]-posB[2])**2);
        TestFramework.assert(dAB > 50 && dAB < 200, 'CamA-CamB distance reasonable: ' + dAB.toFixed(2));
    });

    TestFramework.it('Projection matrix P = K * [R|t]', function () {
        var camA = createCameras()[0];
        var P = camA.projectionMatrix;

        // P should be 3x4
        TestFramework.assertEqual(P.length, 3, 'P has 3 rows');
        TestFramework.assertEqual(P[0].length, 4, 'P has 4 columns');

        // P[2][3] should roughly equal t[2] for near-identity rotation
        // (because P = K*[R|t], P[2] = K[2]*[R|t] = [R[2]|t[2]] since K[2]=[0,0,1])
        TestFramework.assert(Math.abs(P[2][3] - camA.tvec[2]) < 0.01,
            'P[2][3] ≈ tvec[2], got ' + P[2][3].toFixed(4) + ' vs ' + camA.tvec[2].toFixed(4));
    });

    // ---- Triangulation tests ----

    TestFramework.it('DLT triangulation matches expected 3D points', function () {
        var cameras = createCameras();

        // Build InstanceGroup from observed points
        var group = new InstanceGroup(999, 0);
        for (var camName in observedPoints) {
            group.addInstance(camName, new Instance(observedPoints[camName], 0, 'user', 1.0));
        }

        var result = triangulateAndReproject(group, cameras);

        TestFramework.assert(result.points3d.length === 3, 'Got 3 triangulated points');

        for (var i = 0; i < 3; i++) {
            var pt = result.points3d[i];
            var exp = expectedPoints3d[i];
            TestFramework.assert(pt != null, 'Point ' + i + ' is not null');

            var diff = Math.sqrt((pt[0]-exp[0])**2 + (pt[1]-exp[1])**2 + (pt[2]-exp[2])**2);
            TestFramework.assert(diff < 1.0,
                'Point ' + i + ' within 1mm of expected: diff=' + diff.toFixed(4) +
                ' got=[' + pt.map(function(v){return v.toFixed(2)}).join(',') + ']' +
                ' exp=[' + exp.map(function(v){return v.toFixed(2)}).join(',') + ']');
        }
    });

    TestFramework.it('Reprojection errors are reasonable', function () {
        var cameras = createCameras();

        var group = new InstanceGroup(999, 0);
        for (var camName in observedPoints) {
            group.addInstance(camName, new Instance(observedPoints[camName], 0, 'user', 1.0));
        }

        var result = triangulateAndReproject(group, cameras);

        // Mean reprojection error should be < 15px for hand-placed points
        TestFramework.assert(result.meanError != null, 'Mean error is not null');
        TestFramework.assert(result.meanError < 15,
            'Mean reprojection error < 15px: ' + result.meanError.toFixed(2) + 'px');

        // Per-camera reprojections should all exist
        TestFramework.assert(result.reprojections['CamA'] != null, 'CamA reprojections exist');
        TestFramework.assert(result.reprojections['CamB'] != null, 'CamB reprojections exist');
        TestFramework.assert(result.reprojections['CamC'] != null, 'CamC reprojections exist');
    });

    TestFramework.it('3D points are in reasonable range', function () {
        var cameras = createCameras();

        var group = new InstanceGroup(999, 0);
        for (var camName in observedPoints) {
            group.addInstance(camName, new Instance(observedPoints[camName], 0, 'user', 1.0));
        }

        var result = triangulateAndReproject(group, cameras);

        for (var i = 0; i < result.points3d.length; i++) {
            var pt = result.points3d[i];
            if (!pt) continue;

            // Points should be within reasonable range (not at infinity)
            var magnitude = Math.sqrt(pt[0]*pt[0] + pt[1]*pt[1] + pt[2]*pt[2]);
            TestFramework.assert(magnitude < 500,
                'Point ' + i + ' magnitude < 500: ' + magnitude.toFixed(2));
            TestFramework.assert(magnitude > 0.1,
                'Point ' + i + ' magnitude > 0.1: ' + magnitude.toFixed(2));

            // No NaN values
            TestFramework.assert(!isNaN(pt[0]) && !isNaN(pt[1]) && !isNaN(pt[2]),
                'Point ' + i + ' has no NaN values');
        }
    });

    // ---- Undistortion tests ----

    TestFramework.it('Undistortion with real distortion coefficients', function () {
        var camA = createCameras()[0];
        // CamA has k1=-0.2397 which is significant barrel distortion

        var original = [300, 300]; // off-center point
        var undistorted = camA.undistortPoint(original);

        // Undistorted point should be different from original
        var diff = Math.sqrt((undistorted[0]-original[0])**2 + (undistorted[1]-original[1])**2);
        TestFramework.assert(diff > 0.01, 'Undistortion changes point: diff=' + diff.toFixed(4));

        // Undistorted point should still be in image bounds
        TestFramework.assert(undistorted[0] > 0 && undistorted[0] < 512, 'Undistorted X in bounds');
        TestFramework.assert(undistorted[1] > 0 && undistorted[1] < 512, 'Undistorted Y in bounds');
    });

    TestFramework.it('Undistortion at image center is near-identity', function () {
        var camA = createCameras()[0];
        // At the optical center, distortion should be zero
        var center = [255.5, 255.5]; // cx, cy
        var undistorted = camA.undistortPoint(center);

        var diff = Math.sqrt((undistorted[0]-center[0])**2 + (undistorted[1]-center[1])**2);
        TestFramework.assert(diff < 0.01, 'Undistortion at center is identity: diff=' + diff.toFixed(6));
    });

    // ---- Session/InstanceGroup data flow tests ----

    TestFramework.it('InstanceGroup preserves points3d through data flow', function () {
        var cameras = createCameras();
        var skeleton = new Skeleton('test', ['shoulder', 'elbow', 'wrist'], [[0,1],[1,2]]);
        var session = new Session(cameras, skeleton, ['track_0']);

        // Create a frame group
        var fg = new FrameGroup(0);
        var group = new InstanceGroup(12345, 0);

        // Add instances
        for (var camName in observedPoints) {
            var inst = new Instance(observedPoints[camName], 0, 'user', 1.0);
            group.addInstance(camName, inst);
            fg.addInstance(camName, inst);
        }

        // Set points3d (simulating triangulation result)
        group.points3d = expectedPoints3d;

        // Store in session
        if (!session.instanceGroups.has(0)) {
            session.instanceGroups.set(0, []);
        }
        session.instanceGroups.get(0).push(group);
        session.addFrameGroup(fg);

        // Retrieve through the same path as getInstanceGroupsForFrame
        var result = session.instanceGroups.get(0) || [];

        TestFramework.assertEqual(result.length, 1, 'Got 1 instance group');
        TestFramework.assert(result[0].points3d != null, 'points3d is preserved');
        TestFramework.assertEqual(result[0].points3d.length, 3, 'points3d has 3 points');
        TestFramework.assert(Math.abs(result[0].points3d[0][2] - 107.22) < 0.01,
            'First point Z ≈ 107.22');
    });

    // ---- TOML calibration parsing test ----

    TestFramework.it('TOML calibration parsing matches JSON calibration', function () {
        var tomlText = [
            '[cam_0]',
            'name = "CamA"',
            'size = [ 512, 512,]',
            'matrix = [ [ 1190.6939645110197, 0.0, 255.5,], [ 0.0, 1190.6939645110197, 255.5,], [ 0.0, 0.0, 1.0,],]',
            'distortions = [ -0.23973960295301186, 0.0, 0.0, 0.0, 0.0,]',
            'rotation = [ 0.0007428135485053219, 0.0033145959906249983, -0.0016785654428863113,]',
            'translation = [ -0.3825769953311274, 0.09975553838950957, -1.0076477752410165,]',
            '',
            '[metadata]',
            'adjusted = false'
        ].join('\n');

        var cameras = parseCalibrationTOML(tomlText);
        TestFramework.assertEqual(cameras.length, 1, 'Parsed 1 camera');
        TestFramework.assertEqual(cameras[0].name, 'CamA', 'Camera name is CamA');
        TestFramework.assert(Math.abs(cameras[0].matrix[0][0] - 1190.694) < 0.001, 'fx parsed correctly');
        TestFramework.assert(Math.abs(cameras[0].dist[0] - (-0.2397)) < 0.001, 'k1 parsed correctly');
        TestFramework.assert(Math.abs(cameras[0].rvec[0] - 0.000743) < 0.0001, 'rvec[0] parsed correctly');
        TestFramework.assert(Math.abs(cameras[0].tvec[2] - (-1.0076)) < 0.001, 'tvec[2] parsed correctly');
        TestFramework.assertEqual(cameras[0].size[0], 512, 'size parsed correctly');
    });

    // ---- Viewport3D rendering test ----

    TestFramework.it('Viewport3D renders 3D points when given groups with points3d', function () {
        // Skip in node environment — requires full Three.js for scene traversal
        if (typeof process !== 'undefined' && process.versions && process.versions.node) return;
        // Create a minimal container
        var container = document.createElement('div');
        container.style.width = '400px';
        container.style.height = '300px';
        document.body.appendChild(container);

        try {
            var cameras = createCameras();
            var skeleton = new Skeleton('test', ['shoulder', 'elbow', 'wrist'], [[0,1],[1,2]]);

            var viewport = new Viewport3D(container, {
                cameras: cameras,
                skeleton: skeleton,
                getTrackColor: function () { return '#ff0000'; }
            });

            // Create instance group with points3d
            var group = new InstanceGroup(999, 0);
            group.points3d = expectedPoints3d;

            // Set frame - should create skeleton meshes
            viewport.setFrame([group]);

            // Check that skeleton group has children (the 3D meshes)
            var skeletonGroup = viewport._skeletonGroup;
            TestFramework.assert(skeletonGroup.children.length > 0,
                'Skeleton group has children after setFrame: ' + skeletonGroup.children.length);

            // Check that node meshes were created at expected positions
            var nodeCount = 0;
            skeletonGroup.traverse(function (child) {
                if (child.isMesh && child.name.startsWith('node_')) {
                    nodeCount++;
                    // Verify position is in expected range
                    var pos = child.position;
                    TestFramework.assert(Math.abs(pos.z - 105) < 10,
                        'Node Z position near 105: ' + pos.z.toFixed(2));
                }
            });

            TestFramework.assert(nodeCount === 3, 'Created 3 node meshes: got ' + nodeCount);

            // Check that edge cylinders were created
            var edgeCount = 0;
            skeletonGroup.traverse(function (child) {
                if (child.isMesh && child.name.startsWith('edge_')) {
                    edgeCount++;
                }
            });
            TestFramework.assert(edgeCount === 2, 'Created 2 edge cylinders: got ' + edgeCount);

            // Verify fitToScene computes reasonable camera distance
            viewport.fitToScene();
            var camPos = viewport.threeCamera.position;
            var camDist = Math.sqrt(camPos.x*camPos.x + camPos.y*camPos.y + camPos.z*camPos.z);
            TestFramework.assert(camDist > 10 && camDist < 10000,
                'Camera distance reasonable after fitToScene: ' + camDist.toFixed(2));

            // Verify clipping planes are set
            TestFramework.assert(viewport.threeCamera.far > 100,
                'Far plane > 100: ' + viewport.threeCamera.far);

            viewport.dispose();
        } finally {
            document.body.removeChild(container);
        }
    });

    TestFramework.it('Viewport3D camera pyramids scale with scene', function () {
        var container = document.createElement('div');
        container.style.width = '400px';
        container.style.height = '300px';
        document.body.appendChild(container);

        try {
            var cameras = createCameras();
            var skeleton = new Skeleton('test', ['shoulder', 'elbow', 'wrist'], [[0,1],[1,2]]);

            var viewport = new Viewport3D(container, {
                cameras: cameras,
                skeleton: skeleton,
                getTrackColor: function () { return '#ff0000'; }
            });

            // Camera group should have objects for each camera (wireframe + label + sphere)
            TestFramework.assert(viewport._cameraGroup.children.length >= 3,
                'Camera group has objects: ' + viewport._cameraGroup.children.length);

            // Scene scale should be computed
            TestFramework.assert(viewport._sceneScale >= 1,
                'Scene scale >= 1: ' + viewport._sceneScale);

            viewport.dispose();
        } finally {
            document.body.removeChild(container);
        }
    });

});
