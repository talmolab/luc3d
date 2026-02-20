/**
 * test-triangulation.js - Unit tests for triangulation.js
 */

(function () {
    const { describe, it, assertEqual, assertApprox, assertNotNull, assertNull,
        assertTrue, assertGreaterThan, assertLessThan } = TestFramework;

    // Helper: create a camera with known projection
    function makeTestCamera(name, rvec, tvec) {
        return new Camera(
            name,
            [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
            [0, 0, 0, 0, 0],
            rvec,
            tvec,
            [640, 480]
        );
    }

    describe('Triangulation - triangulatePointDLT', function () {
        it('triangulates with 2 views to correct 3D point', function () {
            // Skip if triangulatePointDLT not available
            if (typeof triangulatePointDLT !== 'function') return;

            // Place a 3D point at known location
            const point3d = [10, 5, 50];

            // Two cameras at different positions
            const cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            const cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);

            // Project to 2D
            const p1 = cam1.project(point3d);
            const p2 = cam2.project(point3d);

            // Triangulate back
            const result = triangulatePointDLT(
                [p1, p2],
                [cam1.projectionMatrix, cam2.projectionMatrix]
            );

            assertNotNull(result);
            // Should recover the 3D point approximately
            assertApprox(result[0], point3d[0], 1.0, 'X coordinate');
            assertApprox(result[1], point3d[1], 1.0, 'Y coordinate');
            assertApprox(result[2], point3d[2], 1.0, 'Z coordinate');
        });

        it('triangulates with 3+ views (overdetermined)', function () {
            if (typeof triangulatePointDLT !== 'function') return;

            const point3d = [5, -3, 80];

            const cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            const cam2 = makeTestCamera('c2', [0, 0.2, 0], [15, 0, 0]);
            const cam3 = makeTestCamera('c3', [0.1, 0, 0], [0, 10, 0]);

            const projections = [cam1, cam2, cam3].map(function (c) { return c.project(point3d); });
            const matrices = [cam1, cam2, cam3].map(function (c) { return c.projectionMatrix; });

            const result = triangulatePointDLT(projections, matrices);
            assertNotNull(result);
            assertApprox(result[0], point3d[0], 1.0);
            assertApprox(result[1], point3d[1], 1.0);
            assertApprox(result[2], point3d[2], 1.0);
        });

        it('returns null or NaN for <2 views', function () {
            if (typeof triangulatePointDLT !== 'function') return;

            const cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            const result = triangulatePointDLT(
                [[320, 240]],
                [cam1.projectionMatrix]
            );
            // Either null or array with NaN values
            if (result !== null) {
                assertTrue(isNaN(result[0]) || isNaN(result[1]) || isNaN(result[2]),
                    'Single view should produce NaN');
            }
        });
    });

    describe('Triangulation - reprojection error', function () {
        it('reprojection error is zero for identical points', function () {
            if (typeof computeReprojectionError !== 'function') return;

            const error = computeReprojectionError([100, 200], [100, 200]);
            assertNotNull(error);
            assertApprox(error, 0, 0.001, 'Identical points should have 0 error');
        });

        it('reprojection error is correct for known offset', function () {
            if (typeof computeReprojectionError !== 'function') return;

            // 3-4-5 triangle
            const error = computeReprojectionError([100, 200], [103, 204]);
            assertNotNull(error);
            assertApprox(error, 5.0, 0.001, 'Error should be 5px');
        });

        it('reprojection error is small after triangulate + reproject', function () {
            if (typeof triangulatePointDLT !== 'function') return;
            if (typeof computeReprojectionError !== 'function') return;

            const point3d = [10, 5, 50];
            const cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            const cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);

            const p1 = cam1.project(point3d);
            const p2 = cam2.project(point3d);

            const recovered = triangulatePointDLT([p1, p2], [cam1.projectionMatrix, cam2.projectionMatrix]);
            if (recovered) {
                const rp1 = cam1.project(recovered);
                const error = computeReprojectionError(p1, rp1);
                assertNotNull(error);
                assertLessThan(error, 1.0, 'Reprojection error after triangulation should be <1px');
            }
        });

        it('reprojection error is large for wrong reprojection', function () {
            if (typeof computeReprojectionError !== 'function') return;

            const error = computeReprojectionError([100, 200], [200, 300]);
            assertGreaterThan(error, 100, 'Error should be large for distant points');
        });

        it('returns null for null inputs', function () {
            if (typeof computeReprojectionError !== 'function') return;

            assertNull(computeReprojectionError(null, [100, 200]));
            assertNull(computeReprojectionError([100, 200], null));
        });
    });

    describe('Triangulation - round trip', function () {
        it('project -> triangulate -> project gives consistent results', function () {
            if (typeof triangulatePointDLT !== 'function') return;

            const point3d = [0, 0, 100];
            const cam1 = makeTestCamera('c1', [0, 0, 0], [-10, 0, 0]);
            const cam2 = makeTestCamera('c2', [0, 0, 0], [10, 0, 0]);

            const p1 = cam1.project(point3d);
            const p2 = cam2.project(point3d);

            const recovered = triangulatePointDLT(
                [p1, p2],
                [cam1.projectionMatrix, cam2.projectionMatrix]
            );

            if (recovered) {
                const rp1 = cam1.project(recovered);
                const rp2 = cam2.project(recovered);

                assertApprox(rp1[0], p1[0], 2.0, 'Reprojected cam1 X');
                assertApprox(rp1[1], p1[1], 2.0, 'Reprojected cam1 Y');
                assertApprox(rp2[0], p2[0], 2.0, 'Reprojected cam2 X');
                assertApprox(rp2[1], p2[1], 2.0, 'Reprojected cam2 Y');
            }
        });
    });

    describe('Linear algebra helpers', function () {
        it('matMul computes correct product (identity * A = A)', function () {
            if (typeof matMul !== 'function') return;
            const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
            const A = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
            const result = matMul(I, A);
            assertEqual(result[0][0], 1);
            assertEqual(result[1][1], 5);
            assertEqual(result[2][2], 9);
        });

        it('matMul 3x3 * 3x4 produces 3x4 result', function () {
            if (typeof matMul !== 'function') return;
            const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
            const B = [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]];
            const result = matMul(I, B);
            assertEqual(result.length, 3);
            assertEqual(result[0].length, 4);
            assertEqual(result[0][3], 4);
        });

        it('matTranspose transposes correctly', function () {
            if (typeof matTranspose !== 'function') return;
            const A = [[1, 2, 3], [4, 5, 6]];
            const T = matTranspose(A);
            assertEqual(T.length, 3);
            assertEqual(T[0].length, 2);
            assertEqual(T[0][0], 1);
            assertEqual(T[0][1], 4);
            assertEqual(T[1][0], 2);
        });
    });
})();
