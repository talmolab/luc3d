/**
 * test-tracker.js - Tests for cross-view tracker geometry and algorithm
 */
(function () {
    const { describe, it, assertApprox, assertNotNull, assertTrue,
        assertLessThan, assertGreaterThan } = TestFramework;

    function makeTestCamera(name, rvec, tvec) {
        return new Camera(
            name,
            [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0],
            rvec, tvec, [640, 480]
        );
    }

    describe('Tracker Geometry - backProjectToRay', function () {
        it('ray origin is camera center', function () {
            if (typeof backProjectToRay !== 'function') return;
            var cam = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var result = backProjectToRay([320, 240], cam.projectionMatrix);
            assertApprox(result.origin[0], 0, 1.0, 'cx');
            assertApprox(result.origin[1], 0, 1.0, 'cy');
            assertApprox(result.origin[2], 0, 1.0, 'cz');
        });

        it('ray direction points toward 3D point', function () {
            if (typeof backProjectToRay !== 'function') return;
            var cam = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var point3d = [10, 5, 50];
            var proj = cam.project(point3d);
            var result = backProjectToRay(proj, cam.projectionMatrix);
            var len = Math.sqrt(10*10 + 5*5 + 50*50);
            assertApprox(result.direction[0], 10/len, 0.1, 'dx');
            assertApprox(result.direction[1], 5/len, 0.1, 'dy');
            assertApprox(result.direction[2], 50/len, 0.1, 'dz');
        });

        it('ray from translated camera has correct origin', function () {
            if (typeof backProjectToRay !== 'function') return;
            var cam = makeTestCamera('c2', [0, 0, 0], [20, 0, 0]);
            var result = backProjectToRay([320, 240], cam.projectionMatrix);
            assertApprox(result.origin[0], -20, 1.0, 'cx');
            assertApprox(result.origin[1], 0, 1.0, 'cy');
            assertApprox(result.origin[2], 0, 1.0, 'cz');
        });
    });

    describe('Tracker Geometry - pointToRayDistance', function () {
        it('point on ray has zero distance', function () {
            if (typeof pointToRayDistance !== 'function') return;
            assertApprox(pointToRayDistance([0, 0, 10], [0, 0, 0], [0, 0, 1]), 0, 1e-6);
        });

        it('point off ray has correct perpendicular distance', function () {
            if (typeof pointToRayDistance !== 'function') return;
            assertApprox(pointToRayDistance([3, 4, 10], [0, 0, 0], [0, 0, 1]), 5.0, 1e-6);
        });
    });

    describe('Tracker Geometry - epipolar', function () {
        it('epipolar error is low for correct correspondences', function () {
            if (typeof computeFundamentalMatrix !== 'function') return;
            if (typeof epipolarErrorMatrix !== 'function') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var p1 = [10, 5, 50];
            var p2 = [-5, 8, 40];
            var det1 = [cam1.project(p1), cam1.project(p2)];
            var det2 = [cam2.project(p1), cam2.project(p2)];
            var F = computeFundamentalMatrix(cam1, cam2);
            var costMatrix = epipolarErrorMatrix(det1, det2, F);
            assertLessThan(costMatrix[0][0], costMatrix[0][1], 'correct < wrong for det1[0]');
            assertLessThan(costMatrix[1][1], costMatrix[1][0], 'correct < wrong for det1[1]');
        });
    });
})();

(function () {
    const { describe, it, assertEqual, assertApprox, assertNotNull, assertTrue } = TestFramework;

    function makeTestCamera(name, rvec, tvec) {
        return new Camera(
            name,
            [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0],
            rvec, tvec, [640, 480]
        );
    }

    describe('Detection2D', function () {
        it('fromInstance undistorts points and stores camera info', function () {
            if (typeof Detection2D === 'undefined') return;
            var cam = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var inst = new Instance([[100, 200], [300, 400]], 0, 'predicted', 0.9);
            var det = Detection2D.fromInstance(inst, cam, 5);
            assertEqual(det.cameraName, 'c1');
            assertEqual(det.frameIdx, 5);
            assertEqual(det.trackIdx, 0);
            assertEqual(det.points.length, 2);
            assertNotNull(det.points[0]);
            assertNotNull(det.points[1]);
        });

        it('handles null points', function () {
            if (typeof Detection2D === 'undefined') return;
            var cam = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var inst = new Instance([[100, 200], null], 0, 'predicted', 0.9);
            var det = Detection2D.fromInstance(inst, cam, 0);
            assertNotNull(det.points[0]);
            assertEqual(det.points[1], null);
        });
    });

    describe('Target3D', function () {
        it('can be created from 2 detections and triangulated', function () {
            if (typeof Target3D === 'undefined') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var point3d = [10, 5, 50];
            var inst1 = new Instance([cam1.project(point3d)], 0, 'predicted', 1);
            var inst2 = new Instance([cam2.project(point3d)], 0, 'predicted', 1);
            var det1 = Detection2D.fromInstance(inst1, cam1, 0);
            var det2 = Detection2D.fromInstance(inst2, cam2, 0);
            var target = Target3D.fromDetections([det1, det2], 0);
            assertNotNull(target.points);
            assertApprox(target.points[0][0], 10, 2.0, 'X');
            assertApprox(target.points[0][1], 5, 2.0, 'Y');
            assertApprox(target.points[0][2], 50, 2.0, 'Z');
            assertEqual(target.detectionsByCamera.size, 2);
        });

        it('addDetection replaces existing camera and updates frameIdx', function () {
            if (typeof Target3D === 'undefined') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var p3d = [10, 5, 50];
            var det1 = Detection2D.fromInstance(new Instance([cam1.project(p3d)], 0, 'predicted', 1), cam1, 0);
            var det2 = Detection2D.fromInstance(new Instance([cam2.project(p3d)], 0, 'predicted', 1), cam2, 0);
            var target = Target3D.fromDetections([det1, det2], 0);
            // Add new detection from cam1 at frame 1
            var det1b = Detection2D.fromInstance(new Instance([cam1.project(p3d)], 0, 'predicted', 1), cam1, 1);
            target.addDetection(det1b);
            assertEqual(target.detectionsByCamera.size, 2, 'still 2 cameras');
            assertApprox(target.frameIdx, 0.5, 0.01, 'mean frame idx');
        });

        it('stores trackIdx in detectionsByCamera', function () {
            if (typeof Target3D === 'undefined') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var p3d = [10, 5, 50];
            var inst1 = new Instance([cam1.project(p3d)], 5, 'predicted', 1);
            var inst2 = new Instance([cam2.project(p3d)], 3, 'predicted', 1);
            var det1 = Detection2D.fromInstance(inst1, cam1, 0);
            var det2 = Detection2D.fromInstance(inst2, cam2, 0);
            var target = Target3D.fromDetections([det1, det2], 0);
            assertEqual(target.detectionsByCamera.get('c1').trackIdx, 5);
            assertEqual(target.detectionsByCamera.get('c2').trackIdx, 3);
        });
    });
})();
