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

    describe('hungarianAlgorithm degenerate inputs', function () {
        // Regression: an all-Infinity cost matrix used to throw
        // "Cannot read properties of undefined (reading '<col>')" inside the
        // augmenting-path loop. Hit during Track All on frames where every
        // group failed to triangulate against the camera being matched.

        it('returns all -1 for an all-Infinity cost matrix (no valid assignments)', function () {
            if (typeof hungarianAlgorithm !== 'function') return;
            const cost = [
                [Infinity, Infinity, Infinity, Infinity],
                [Infinity, Infinity, Infinity, Infinity],
                [Infinity, Infinity, Infinity, Infinity],
            ];
            const result = hungarianAlgorithm(cost);
            assertEqual(result.length, 3);
            for (let i = 0; i < result.length; i++) {
                assertEqual(result[i], -1);
            }
        });

        it('handles a row of Infinity mixed with finite rows', function () {
            if (typeof hungarianAlgorithm !== 'function') return;
            const cost = [
                [1, 5, 9],
                [Infinity, Infinity, Infinity],
                [3, 1, 8],
            ];
            const result = hungarianAlgorithm(cost);
            assertEqual(result.length, 3);
            // Row 0 and Row 2 should get assigned to finite-cost columns;
            // Row 1 gets whatever's left (the algorithm doesn't reject the
            // sentinel entry, but its real cost would be filtered by the
            // caller's threshold check). The key assertion is no crash.
            assertTrue(result[0] >= 0 && result[0] < 3);
            assertTrue(result[2] >= 0 && result[2] < 3);
        });

        it('returns all -1 when m === 0 (zero-column matrix)', function () {
            if (typeof hungarianAlgorithm !== 'function') return;
            const cost = [[], [], []];
            const result = hungarianAlgorithm(cost);
            assertEqual(result.length, 3);
            for (let i = 0; i < result.length; i++) {
                assertEqual(result[i], -1);
            }
        });

        it('returns [] when n === 0 (zero-row matrix)', function () {
            if (typeof hungarianAlgorithm !== 'function') return;
            const result = hungarianAlgorithm([]);
            assertEqual(result.length, 0);
        });

        it('handles NaN entries (treated as Infinity)', function () {
            if (typeof hungarianAlgorithm !== 'function') return;
            const cost = [
                [1, NaN, 9],
                [NaN, 2, NaN],
            ];
            const result = hungarianAlgorithm(cost);
            assertEqual(result.length, 2);
            // Should not crash; should prefer finite entries when possible.
            assertTrue(result[0] >= 0);
            assertTrue(result[1] >= 0);
        });
    });

    // Regression: after "Track All" (per-frame identities, no groups yet),
    // triangulation must auto-create groups from those identities so the 3D
    // viewer populates. Both triangulateCurrentFrame and triangulateAllFrames
    // go through ensureGroupsFromIdentities.
    describe('ensureGroupsFromIdentities (auto-group from per-frame identities)', function () {
        function cam(n) {
            return new Camera(n, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [1, 2, 3], [640, 480]);
        }
        function mkSession() {
            return new Session([cam('CamA'), cam('CamB')],
                new Skeleton('s', ['a', 'b'], [[0, 1]]), ['t0', 't1'], 'tri');
        }

        it('creates a group from a shared identity across 2 cameras (post Track All)', function () {
            if (typeof ensureGroupsFromIdentities !== 'function') return;
            var session = mkSession();
            var fg = new FrameGroup(0);
            fg.addInstance('CamA', new Instance([[1, 1], [2, 2]], 0, 'predicted', 1));
            fg.addInstance('CamB', new Instance([[3, 3], [4, 4]], 0, 'predicted', 1));
            session.addFrameGroup(fg);
            var idMouse = session.addIdentity('mouse');
            // Simulate Track All: per-frame identity for track 0 in both cameras.
            session.setFrameIdentity(0, 'CamA', 0, idMouse.id);
            session.setFrameIdentity(0, 'CamB', 0, idMouse.id);

            assertTrue(!session.instanceGroups.get(0) || session.instanceGroups.get(0).length === 0,
                'no groups before auto-create');
            var groups = ensureGroupsFromIdentities(session, 0);
            assertEqual(groups.length, 1, 'one group created from the shared identity');
            assertEqual(groups[0].identityId, idMouse.id, 'group carries the identity');
            assertEqual(groups[0].cameraNames.length, 2, 'group spans 2 cameras');
        });

        it('does NOT create a group for a single-view identity', function () {
            if (typeof ensureGroupsFromIdentities !== 'function') return;
            var session = mkSession();
            var fg = new FrameGroup(0);
            fg.addInstance('CamA', new Instance([[1, 1], [2, 2]], 0, 'predicted', 1)); // only CamA
            session.addFrameGroup(fg);
            var id = session.addIdentity('mouse');
            session.setFrameIdentity(0, 'CamA', 0, id.id);

            var groups = ensureGroupsFromIdentities(session, 0);
            assertEqual(groups.length, 0, 'single-view identity does not form a group');
        });

        it('is a no-op when groups already exist (returns existing untouched)', function () {
            if (typeof ensureGroupsFromIdentities !== 'function') return;
            var session = mkSession();
            var fg = new FrameGroup(0);
            fg.addInstance('CamA', new Instance([[1, 1], [2, 2]], 0, 'predicted', 1));
            session.addFrameGroup(fg);
            var existing = new InstanceGroup(99, 0);
            existing.addInstance('CamA', fg.getInstances('CamA')[0]);
            session.instanceGroups.set(0, [existing]);

            var groups = ensureGroupsFromIdentities(session, 0);
            assertEqual(groups.length, 1);
            assertEqual(groups[0].id, 99, 'returns the pre-existing group, does not rebuild');
        });

        it('no identities → no groups and instances left untouched', function () {
            if (typeof ensureGroupsFromIdentities !== 'function') return;
            var session = mkSession();
            var fg = new FrameGroup(0);
            fg.addInstance('CamA', new Instance([[1, 1], [2, 2]], 0, 'predicted', 1));
            fg.addInstance('CamB', new Instance([[3, 3], [4, 4]], 0, 'predicted', 1));
            session.addFrameGroup(fg);

            var groups = ensureGroupsFromIdentities(session, 0);
            assertEqual(groups.length, 0, 'no identities → no groups');
            assertEqual(fg.getInstances('CamA').length, 1, 'CamA instance untouched');
            assertEqual(fg.getInstances('CamB').length, 1, 'CamB instance untouched');
        });
    });

    describe('Bundle Adjustment - triangulatePointBA', function () {
        it('recovers a known 3D point from 2 clean views', function () {
            if (typeof triangulatePointBA !== 'function') return;
            var point3d = [10, 5, 50];
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var p1 = cam1.project(point3d);
            var p2 = cam2.project(point3d);

            var result = triangulatePointBA(
                [p1, p2],
                [cam1.projectionMatrix, cam2.projectionMatrix]
            );
            assertNotNull(result);
            assertApprox(result[0], point3d[0], 1e-3, 'X coordinate');
            assertApprox(result[1], point3d[1], 1e-3, 'Y coordinate');
            assertApprox(result[2], point3d[2], 1e-3, 'Z coordinate');
        });

        it('returns null with fewer than 2 valid observations', function () {
            if (typeof triangulatePointBA !== 'function') return;
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var result = triangulatePointBA(
                [[100, 100], null],
                [cam1.projectionMatrix, cam2.projectionMatrix]
            );
            assertNull(result);
        });

        it('refines a noisy DLT estimate to lower reprojection error', function () {
            if (typeof triangulatePointBA !== 'function') return;
            var point3d = [3, -2, 40];
            var cam1 = makeTestCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('c2', [0, 0.25, 0], [18, 0, 0]);
            var cam3 = makeTestCamera('c3', [0.15, 0, 0], [0, 12, 0]);
            var cams = [cam1, cam2, cam3];
            var mats = cams.map(function (c) { return c.projectionMatrix; });

            // Add small, deterministic noise to each observation.
            var noise = [[0.8, -0.6], [-0.5, 0.7], [0.4, 0.5]];
            var obs = cams.map(function (c, i) {
                var p = c.project(point3d);
                return [p[0] + noise[i][0], p[1] + noise[i][1]];
            });

            function meanReproj(pt) {
                var sum = 0, n = 0;
                for (var i = 0; i < cams.length; i++) {
                    var r = reprojectPoint(pt, mats[i]);
                    var dx = obs[i][0] - r[0], dy = obs[i][1] - r[1];
                    sum += Math.sqrt(dx * dx + dy * dy); n++;
                }
                return sum / n;
            }

            var dlt = triangulatePointDLT(obs, mats);
            var ba = triangulatePointBA(obs, mats);
            assertNotNull(ba);
            // BA minimizes geometric error, so it should be <= the DLT error.
            assertLessThan(meanReproj(ba), meanReproj(dlt) + 1e-9,
                'BA error should not exceed DLT error');
        });
    });

    describe('Bundle Adjustment - triangulateAndReproject method option', function () {
        function mkGroup() {
            var cam1 = makeTestCamera('CamA', [0, 0, 0], [0, 0, 0]);
            var cam2 = makeTestCamera('CamB', [0, 0.3, 0], [20, 0, 0]);
            var pt = [4, 1, 45];
            var g = new InstanceGroup(1, 0);
            g.addInstance('CamA', new Instance([cam1.project(pt)], 0, 'user', 1));
            g.addInstance('CamB', new Instance([cam2.project(pt)], 0, 'user', 1));
            return { group: g, cameras: [cam1, cam2], pt: pt };
        }

        it('defaults to DLT and reports method', function () {
            if (typeof triangulateAndReproject !== 'function') return;
            var t = mkGroup();
            var res = triangulateAndReproject(t.group, t.cameras);
            assertEqual(res.method, 'dlt');
        });

        it('runs BA when method:"ba" and reports method', function () {
            if (typeof triangulateAndReproject !== 'function') return;
            var t = mkGroup();
            var res = triangulateAndReproject(t.group, t.cameras, { method: 'ba' });
            assertEqual(res.method, 'ba');
            assertNotNull(res.points3d[0]);
            assertApprox(res.points3d[0][2], t.pt[2], 1e-2, 'Z recovered by BA');
        });

        it('reports both distorted and undistorted reprojection error', function () {
            if (typeof triangulateAndReproject !== 'function') return;
            var t = mkGroup();
            var res = triangulateAndReproject(t.group, t.cameras, { method: 'ba' });
            assertNotNull(res.meanError, 'distorted mean error present');
            assertNotNull(res.meanErrorUndistorted, 'undistorted mean error present');
            assertNotNull(res.errorsUndistorted, 'per-camera undistorted errors present');
            // With distortion-free test cameras the two spaces coincide.
            assertApprox(res.meanErrorUndistorted, res.meanError, 1e-9,
                'distorted == undistorted error when there is no distortion');
        });
    });

    describe('Bundle Adjustment - triangulationMethodLabel', function () {
        it('maps method keys to human labels', function () {
            if (typeof triangulationMethodLabel !== 'function') return;
            assertEqual(triangulationMethodLabel('ba'), 'Bundle Adjustment');
            assertEqual(triangulationMethodLabel('dlt'), 'DLT');
            assertEqual(triangulationMethodLabel(undefined), 'DLT');
        });
    });

    describe('Distortion - Camera.distortPoint', function () {
        // Camera with non-trivial radial + tangential distortion.
        function distortedCamera(name, rvec, tvec) {
            return new Camera(
                name,
                [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [-0.28, 0.07, 0.001, -0.0005, 0.0],
                rvec, tvec, [640, 480]
            );
        }

        it('is the inverse of undistortPoint (round-trip)', function () {
            var cam = distortedCamera('d', [0, 0, 0], [0, 0, 0]);
            // A point near the frame edge, where distortion is largest.
            var distorted = [590, 70];
            var ideal = cam.undistortPoint(distorted);
            var back = cam.distortPoint(ideal);
            assertApprox(back[0], distorted[0], 0.5, 'u round-trips through undistort∘distort');
            assertApprox(back[1], distorted[1], 0.5, 'v round-trips');
        });

        it('is a no-op when there is no distortion', function () {
            var cam = makeTestCamera('z', [0, 0, 0], [0, 0, 0]);
            var p = cam.distortPoint([500, 100]);
            assertApprox(p[0], 500, 1e-9, 'u unchanged');
            assertApprox(p[1], 100, 1e-9, 'v unchanged');
        });

        it('moves edge points outward (radial barrel distortion)', function () {
            var cam = distortedCamera('d', [0, 0, 0], [0, 0, 0]);
            // Negative k1 → barrel: distorted points pulled toward the center,
            // so distorting an ideal edge point moves it closer to the principal
            // point than the ideal location.
            var ideal = [620, 460];
            var dist = cam.distortPoint(ideal);
            var cx = 320, cy = 240;
            var rIdeal = Math.hypot(ideal[0] - cx, ideal[1] - cy);
            var rDist = Math.hypot(dist[0] - cx, dist[1] - cy);
            assertLessThan(rDist, rIdeal, 'barrel distortion pulls edge points inward');
        });
    });

    describe('Distortion - reprojection in native pixel space', function () {
        function distortedCamera(name, rvec, tvec) {
            return new Camera(
                name,
                [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [-0.28, 0.07, 0.001, -0.0005, 0.0],
                rvec, tvec, [640, 480]
            );
        }

        it('reprojectPointCamera re-distorts so it matches the observed keypoint', function () {
            if (typeof reprojectPointCamera !== 'function') return;
            var cam1 = distortedCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = distortedCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var point3d = [14, 8, 38]; // projects near a frame edge

            // The "observed" 2D keypoint is the distorted projection (what the
            // real camera records). Build it as project(ideal) then distort.
            function observe(cam) { return cam.distortPoint(cam.project(point3d)); }
            var obs1 = observe(cam1);
            var obs2 = observe(cam2);

            // Triangulate from UNDISTORTED observations (the real pipeline).
            var und = [cam1.undistortPoint(obs1), cam2.undistortPoint(obs2)];
            var pt = triangulatePointDLT(und, [cam1.projectionMatrix, cam2.projectionMatrix]);
            assertNotNull(pt);

            // Distorted reprojection should land on the observed keypoint;
            // the ideal (matrix-only) reprojection should be measurably off.
            var reDist = reprojectPointCamera(pt, cam1);
            var reIdeal = reprojectPoint(pt, cam1.projectionMatrix);
            var errDist = Math.hypot(reDist[0] - obs1[0], reDist[1] - obs1[1]);
            var errIdeal = Math.hypot(reIdeal[0] - obs1[0], reIdeal[1] - obs1[1]);
            assertLessThan(errDist, 0.5, 'distorted reprojection matches observed keypoint');
            assertGreaterThan(errIdeal, errDist, 'ideal reprojection is worse (the old bug)');
        });

        it('triangulateAndReproject reports distorted and undistorted error separately under real distortion', function () {
            if (typeof triangulateAndReproject !== 'function') return;
            var cam1 = distortedCamera('c1', [0, 0, 0], [0, 0, 0]);
            var cam2 = distortedCamera('c2', [0, 0.3, 0], [20, 0, 0]);
            var point3d = [14, 8, 38]; // near a frame edge, where distortion bites
            function observe(cam) { return cam.distortPoint(cam.project(point3d)); }

            var g = new InstanceGroup(1, 0);
            g.addInstance('c1', new Instance([observe(cam1)], 0, 'user', 1));
            g.addInstance('c2', new Instance([observe(cam2)], 0, 'user', 1));

            var res = triangulateAndReproject(g, [cam1, cam2], { method: 'ba' });
            assertNotNull(res.meanError, 'distorted mean error present');
            assertNotNull(res.meanErrorUndistorted, 'undistorted mean error present');
            // Both are small (observations are exact), but computed in different
            // spaces, so they need not be byte-identical.
            assertLessThan(res.meanError, 1.0, 'distorted error small');
            assertLessThan(res.meanErrorUndistorted, 1.0, 'undistorted error small');
        });
    });
})();
