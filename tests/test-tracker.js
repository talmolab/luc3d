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
