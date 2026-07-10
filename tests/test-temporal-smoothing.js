/**
 * test-temporal-smoothing.js — unit tests for pose/temporal-smoothing.js
 * (anipose-style temporal smoothing of 3D trajectories, issue #134). Bridged
 * to window in test-runner.html.
 *
 * Covers the finite-difference operator + its adjoint, the penalised-least-
 * squares CG smoother (jitter reduction, polynomial preservation, passthrough,
 * missing-sample handling), the anipose scale_smooth auto-normaliser, and the
 * per-trajectory 3D wrapper.
 */
(function () {
    var describe = TestFramework.describe;
    var it = TestFramework.it;
    var assertTrue = TestFramework.assertTrue;
    var assertEqual = TestFramework.assertEqual;

    function dot(a, b) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
    function variance(a) {
        var m = 0, n = 0;
        for (var i = 0; i < a.length; i++) if (a[i] != null) { m += a[i]; n++; }
        m /= n; var v = 0;
        for (var j = 0; j < a.length; j++) if (a[j] != null) v += (a[j] - m) * (a[j] - m);
        return v / n;
    }
    // Total squared n-th-difference — the quantity the smoother penalises.
    function roughness(a, order) {
        var d = nthDiff(a, order), s = 0;
        for (var i = 0; i < d.length; i++) s += d[i] * d[i];
        return s;
    }

    describe('temporal-smoothing: finite-difference operator + adjoint', function () {
        it('nthDiff order 1/2/3 match the signed binomial stencils', function () {
            assertEqual(JSON.stringify(nthDiff([1, 2, 4, 7], 1)), JSON.stringify([1, 2, 3]), 'Δ¹');
            assertEqual(JSON.stringify(nthDiff([1, 2, 4, 7], 2)), JSON.stringify([1, 1]), 'Δ²');
            assertEqual(JSON.stringify(nthDiff([1, 2, 4, 7], 3)), JSON.stringify([0]), 'Δ³');
        });
        it('<Dⁿx, g> == <x, Dⁿᵀg> (adjoint correctness) for n=1..3', function () {
            var x = [3, 1, 4, 1, 5, 9, 2, 6];
            for (var order = 1; order <= 3; order++) {
                var Dx = nthDiff(x, order);
                var g = Dx.map(function (_v, i) { return (i * 7 + 1) % 5 - 2; }); // arbitrary
                var lhs = dot(Dx, g);
                var rhs = dot(x, nthDiffT(g, order, x.length));
                assertTrue(Math.abs(lhs - rhs) < 1e-9, 'adjoint identity order ' + order + ' (' + lhs + ' vs ' + rhs + ')');
            }
        });
    });

    describe('temporal-smoothing: smoothSeries', function () {
        it('scale_smooth 0 (λ 0) is an exact passthrough', function () {
            var y = [1, 5, 2, 8, 3];
            var out = smoothSeries(y, null, 0, 3);
            assertEqual(JSON.stringify(out), JSON.stringify(y), 'unchanged');
        });
        it('reduces jitter: noisy flat signal → lower variance', function () {
            var y = [0, 1, -1, 1, -1, 1, -1, 1, -1, 0]; // zero-mean jitter around 0
            var out = smoothSeries(y, null, 50, 2);
            assertTrue(variance(out) < variance(y) * 0.5, 'variance at least halved (' + variance(out).toFixed(3) + ' < ' + variance(y).toFixed(3) + ')');
        });
        it('higher λ ⇒ smoother (monotone roughness decrease)', function () {
            var y = [0, 2, -2, 2, -2, 2, -2, 2, -2, 0];
            var r0 = roughness(smoothSeries(y, null, 1, 2), 2);
            var r1 = roughness(smoothSeries(y, null, 20, 2), 2);
            var r2 = roughness(smoothSeries(y, null, 500, 2), 2);
            assertTrue(r1 < r0 && r2 < r1, 'roughness decreases with λ (' + r0.toFixed(2) + ' > ' + r1.toFixed(2) + ' > ' + r2.toFixed(2) + ')');
        });
        it('preserves a pure line under an order-2 (acceleration) penalty', function () {
            // A straight line has zero 2nd derivative, so the penalty is 0 and the
            // data term keeps it exactly — smoothing must not bend it.
            var y = []; for (var i = 0; i < 12; i++) y.push(3 + 2 * i);
            var out = smoothSeries(y, null, 1000, 2);
            var maxDev = 0; for (var k = 0; k < y.length; k++) maxDev = Math.max(maxDev, Math.abs(out[k] - y[k]));
            assertTrue(maxDev < 1e-4, 'line preserved (max dev ' + maxDev.toExponential(2) + ')');
        });
        it('missing samples (null) are bridged by the smoothness prior', function () {
            var y = [0, 1, 2, null, null, 5, 6, 7];
            var out = smoothSeries(y, null, 5, 2);
            assertTrue(isFinite(out[3]) && isFinite(out[4]), 'gap filled with finite values');
            assertTrue(out[3] > 1.5 && out[3] < 5 && out[4] > out[3], 'gap values interpolate monotonically upward');
        });
        it('too few observations for the penalty order → returns observations as-is', function () {
            var y = [null, 2, null, null, null]; // 1 observed, order 3 needs > 3
            var out = smoothSeries(y, null, 10, 3);
            assertEqual(out[1], 2, 'lone observation preserved');
        });
    });

    describe('temporal-smoothing: auto-normaliser', function () {
        it('scale-invariance: doubling all motion halves default_smooth (∝ 1/mean|Δ|)', function () {
            // The exact value depends on median edge-truncation + averaging over
            // all 3 axes, but 1/mean|Δp| must scale as 1/motion regardless.
            var slow = [], fast = [];
            for (var t = 0; t < 10; t++) { slow.push([[2 * t, t, 0]]); fast.push([[4 * t, 2 * t, 0]]); }
            var nSlow = computeSmoothNormalizer(slow, 1);
            var nFast = computeSmoothNormalizer(fast, 1);
            assertTrue(nSlow > 0 && isFinite(nSlow), 'positive finite normaliser');
            assertTrue(Math.abs(nFast - nSlow / 2) < 1e-9, '2× motion → ½ normaliser (' + nFast + ' vs ' + (nSlow / 2) + ')');
        });
        it('static trajectory (no motion) → normaliser 0 (no divide-by-zero)', function () {
            var traj = []; for (var t = 0; t < 8; t++) traj.push([[5, 5, 5]]);
            assertEqual(computeSmoothNormalizer(traj, 1), 0, 'zero motion → 0');
        });
    });

    describe('temporal-smoothing: smoothTrajectory (3D wrapper)', function () {
        function jitterTraj(n) {
            var traj = [];
            for (var t = 0; t < n; t++) {
                var jx = (t % 2 === 0) ? 0.5 : -0.5;
                traj.push([[t + jx, 10 - jx, 3 * t]]); // node 0: x ramps+jitter, y flat+jitter, z clean ramp
            }
            return traj;
        }
        it('scaleSmooth 0 → deep-copied passthrough (not the same array)', function () {
            var traj = jitterTraj(6);
            var out = smoothTrajectory(traj, { scaleSmooth: 0 });
            assertEqual(JSON.stringify(out), JSON.stringify(traj), 'values identical');
            assertTrue(out[0] !== traj[0], 'but a copy (frame refs differ)');
        });
        it('reduces per-axis jitter on a real trajectory', function () {
            var traj = jitterTraj(12);
            var out = smoothTrajectory(traj, { scaleSmooth: 5, order: 2 });
            var xin = traj.map(function (f) { return f[0][0]; });
            var xout = out.map(function (f) { return f[0][0]; });
            assertTrue(roughness(xout, 2) < roughness(xin, 2), 'x-axis roughness reduced');
            var yin = traj.map(function (f) { return f[0][1]; });
            var yout = out.map(function (f) { return f[0][1]; });
            assertTrue(roughness(yout, 2) < roughness(yin, 2), 'y-axis roughness reduced');
        });
        it('preserves null nodes / never fabricates 3D at missing frames', function () {
            var traj = jitterTraj(8);
            traj[3][0] = null; // node missing at frame 3
            var out = smoothTrajectory(traj, { scaleSmooth: 5, order: 2 });
            assertEqual(out[3][0], null, 'missing frame stays null (no fabricated 3D)');
            assertTrue(out[0][0] != null && out[7][0] != null, 'observed frames present');
        });
        it('output shape matches input (frames × nodes)', function () {
            var traj = jitterTraj(5);
            var out = smoothTrajectory(traj, { scaleSmooth: 3 });
            assertEqual(out.length, 5, 'frame count');
            assertEqual(out[0].length, 1, 'node count');
            assertEqual(out[0][0].length, 3, 'xyz');
        });
    });

    // ---- End-to-end: real triangulation → applyTemporalSmoothing post-pass ----
    // Needs the bridged Camera/Session/InstanceGroup + triangulation exports and
    // the app-state `state` singleton (all present in test-runner.html).
    describe('temporal-smoothing: applyTemporalSmoothing over a real triangulated trajectory', function () {
        function cam(name, rvec, tvec) {
            return new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
        }
        // Deterministic LCG so the injected 2D noise is reproducible.
        function lcg(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; }; }
        function thirdDiffEnergy(seriesXYZ) {
            var e = 0;
            for (var a = 0; a < 3; a++) {
                var s = seriesXYZ.map(function (p) { return p ? p[a] : null; }).filter(function (v) { return v != null; });
                var d = nthDiff(s, 3);
                for (var i = 0; i < d.length; i++) e += d[i] * d[i];
            }
            return e;
        }

        function runPipeline(scaleSmooth) {
            var cams = [cam('c1', [0, 0, 0], [0, 0, 0]), cam('c2', [0, 0.35, 0], [25, 0, 0]), cam('c3', [0.2, 0, 0], [0, 18, 0])];
            var skeleton = new Skeleton('s', ['nodeA', 'nodeB'], [[0, 1]]);
            var session = new Session(cams, skeleton, ['t0'], 'RT');
            var identity = session.addIdentity('animal');
            var nFrames = 24;
            var rnd = lcg(12345);

            state.session = session;
            state.triangulationResults = new Map();

            // Ground-truth smooth 3D motion (a slow arc) + per-view 2D jitter,
            // triangulated per frame exactly like the real multi-frame flow.
            for (var f = 0; f < nFrames; f++) {
                var gtA = [10 + 0.5 * f, 5 + 3 * Math.sin(f * 0.3), 50 + 0.2 * f];
                var gtB = [12 + 0.5 * f, 8 + 3 * Math.sin(f * 0.3), 52 + 0.2 * f];
                var group = new InstanceGroup(f + 1, identity.id);
                var fg = new FrameGroup(f); session.addFrameGroup(fg);
                for (var c = 0; c < cams.length; c++) {
                    var pA = cams[c].project(gtA), pB = cams[c].project(gtB);
                    var jitter = 2.5; // px of 2D noise → visible 3D jitter
                    var inst = new Instance([
                        [pA[0] + rnd() * jitter, pA[1] + rnd() * jitter],
                        [pB[0] + rnd() * jitter, pB[1] + rnd() * jitter],
                    ], 0, 'predicted', 0.9);
                    group.addInstance(cams[c].name, inst);
                    fg.addInstance(cams[c].name, inst);
                }
                session.instanceGroups.set(f, [group]);
                var res = triangulateAndReproject(group, cams, { method: 'dlt' });
                group.points3d = res.points3d;
                group.reprojections = res.reprojections;
                state.triangulationResults.set(f, [{
                    group: group, points3d: res.points3d, reprojections: res.reprojections,
                    errors: res.errors, errorsUndistorted: res.errorsUndistorted,
                    meanError: res.meanError, meanErrorUndistorted: res.meanErrorUndistorted, method: res.method,
                }]);
            }

            // Collect nodeA's 3D trajectory before smoothing.
            var before = [];
            for (var fb = 0; fb < nFrames; fb++) before.push(state.session.instanceGroups.get(fb)[0].points3d[0]);
            var out = applyTemporalSmoothing(session, scaleSmooth);
            var after = [];
            for (var fa = 0; fa < nFrames; fa++) after.push(state.session.instanceGroups.get(fa)[0].points3d[0]);
            return { session: session, before: before, after: after, out: out, nFrames: nFrames };
        }

        it('scale_smooth 0 leaves the trajectory untouched', function () {
            var r = runPipeline(0);
            assertEqual(r.out.trajectories, 0, 'no trajectories processed');
            var same = true;
            for (var f = 0; f < r.nFrames; f++) if (JSON.stringify(r.before[f]) !== JSON.stringify(r.after[f])) same = false;
            assertTrue(same, 'points3d unchanged when disabled');
        });

        it('reduces 3D jitter (3rd-difference energy) across the trajectory', function () {
            var r = runPipeline(3);
            assertEqual(r.out.trajectories, 1, 'one identity trajectory smoothed');
            assertTrue(r.out.groupsSmoothed >= 20, 'most frames updated (' + r.out.groupsSmoothed + ')');
            var e0 = thirdDiffEnergy(r.before), e1 = thirdDiffEnergy(r.after);
            assertTrue(e1 < e0 * 0.6, 'jitter energy cut by >40% (' + e1.toFixed(2) + ' < ' + e0.toFixed(2) + ')');
        });

        it('recomputes reprojections + per-view errors for smoothed groups', function () {
            var r = runPipeline(3);
            var g = r.session.instanceGroups.get(12)[0];
            assertTrue(!!g.reprojections && Object.keys(g.reprojections).length >= 2, 'reprojections present');
            assertTrue(g.reprojectedInstances && g.reprojectedInstances.size >= 2, 'reprojected instances stored');
            var rr = state.triangulationResults.get(12)[0];
            assertTrue(rr.meanError != null && isFinite(rr.meanError), 'cached meanError refreshed');
        });
    });
})();
