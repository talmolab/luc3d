/**
 * test-triangulation-ba.js — Bundle-adjustment correctness (issue #113).
 *
 * The issue's symptom: **"error sometimes goes up compared to DLT"**. The point
 * refinement is initialized FROM the DLT solution and only refines it, so the
 * reprojection error the app reports must never be worse than DLT's. These tests
 * pin that invariant, pin the accuracy gain the robust loss buys under outliers,
 * and — crucially — pin that the *pre-fix* configuration violates the invariant,
 * so the suite cannot silently stop testing the bug.
 *
 * ## Fixture correctness (read this before adding a scenario)
 * `Camera.project()` does **NOT** apply distortion (see pose-data.js). A real
 * camera observes `distortPoint(project(X))`. Every scenario below synthesizes
 * observations that way. Getting this wrong (feeding ideal pinhole points as if
 * they were raw detections) produces a fixture whose undistort/reproject
 * pipeline is self-inconsistent, with ~25 px reprojection errors from 2 px of
 * noise, and makes every measurement meaningless. Use `observe()`.
 *
 * ## What was wrong, measured on the pre-#113 configuration
 * `{ robustScale: Infinity, polish: false, guard: false }` reproduces the old
 * behavior exactly. Two mismatches between the minimized objective and the
 * displayed metric, both reproduced below:
 *
 *   1. SPACE — the objective was formed against *undistorted* observations with
 *      an ideal pinhole projection, while `triangulateAndReproject` reports
 *      `meanError` against the raw detections in the camera's *native
 *      (distorted)* space. Fixed by making the residual native-space, which is
 *      also what aniposelib does (`Camera.project` there applies distortion).
 *
 *   2. LOSS — the objective was the SUM of SQUARED residuals, dominated by the
 *      worst view, while the report is the MEAN of Euclidean residuals. A step
 *      that lowers one can raise the other. This reproduces with *zero*
 *      distortion, so it is independent of mechanism 1.
 *
 * The fix makes the invariant structural rather than post-hoc: phase 2 of the
 * solve minimizes Σ‖r‖, which *is* the reported metric, so monotonicity in the
 * displayed number follows from the LM being monotone in its own loss.
 *
 * ## NOT a bug (verified; do not "fix" the LM ladder)
 * The Levenberg–Marquardt loop was strictly monotone in its own objective
 * (0/3000 sum-of-squares increases) and reached the local optimum (0/4000 trials
 * left a >1e-6 relative cost gap versus a 500-iteration/tol=1e-16 solve).
 *
 * Runs under the browser runner and the Node `vm` harness (run-node.js).
 */
(function () {
    const { describe, it, assertTrue, assertLessThan } = TestFramework;

    // Deterministic LCG + Box-Muller, so every assertion below is reproducible.
    function rng(seed) {
        let s = seed >>> 0;
        function u() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }
        return {
            u: u,
            gauss: function () { return Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()); }
        };
    }

    const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
    const NO_DIST = [0, 0, 0, 0, 0];
    // Barrel distortion of the magnitude a real wide-ish lab camera shows. The
    // undistort/distort round trip is exact to <1e-9 px over the whole frame for
    // both of these, so the fixture is self-consistent.
    const RADIAL = [-0.3, 0.12, 0.001, 0.001, 0];
    const MILD_RADIAL = [-0.08, 0.01, 0.0002, 0.0002, 0];

    // The pre-#113 objective: plain squared loss, undistorted residuals, no
    // metric-matching polish, no guard.
    const PRE_FIX = { robustScale: Infinity, polish: false, guard: false };

    // A 4-camera rig with genuinely different viewpoints.
    const RIG = [
        ['c1', [0, 0, 0], [0, 0, 0]],
        ['c2', [0, 0.4, 0], [20, 0, 0]],
        ['c3', [0.2, 0, 0], [0, 15, 0]],
        ['c4', [0.1, -0.35, 0], [-18, 4, 0]],
    ];
    function buildRig(dist, nCams) {
        return RIG.slice(0, nCams || RIG.length).map(function (r) {
            return new Camera(r[0], K, dist, r[1], r[2], [640, 480]);
        });
    }

    /** What the real camera sees: distortion applied, then pixel noise. */
    function observe(cam, point3d, noisePx, r) {
        const q = cam.distortPoint(cam.project(point3d));
        return [q[0] + r.gauss() * noisePx, q[1] + r.gauss() * noisePx];
    }

    function randomTruth(r, nNodes) {
        const out = [];
        for (let k = 0; k < nNodes; k++) {
            out.push([(r.u() - 0.5) * 24, (r.u() - 0.5) * 24, 35 + r.u() * 20]);
        }
        return out;
    }

    // ---- Group-level sweep over triangulateAndReproject ---------------------

    function makeGroup(cams, r, nNodes, noisePx, outlierPx) {
        const truth = randomTruth(r, nNodes);
        const g = new InstanceGroup(1, 0);
        for (let c = 0; c < cams.length; c++) {
            const pts = truth.map(function (p) { return observe(cams[c], p, noisePx, r); });
            g.addInstance(cams[c].name, new Instance(pts, 0, 'user', 1));
        }
        if (outlierPx > 0) {
            const ci = Math.floor(r.u() * cams.length);
            const ki = Math.floor(r.u() * nNodes);
            const inst = g.getInstance(cams[ci].name);
            const p = inst.getPoint(ki);
            inst.setPoint(ki, p[0] + outlierPx * (r.u() < 0.5 ? -1 : 1),
                              p[1] + outlierPx * (r.u() < 0.5 ? -1 : 1));
        }
        return { group: g, truth: truth };
    }

    function sweepGroups(opts) {
        const cams = buildRig(opts.dist, opts.nCams);
        const names = cams.map(function (c) { return c.name; });
        const r = rng(opts.seed);
        let worse = 0, better = 0, total = 0, worstRatio = 1;
        for (let t = 0; t < opts.trials; t++) {
            const t1 = makeGroup(cams, r, opts.nNodes, opts.noisePx, opts.outlierPx || 0);
            const rd = triangulateAndReproject(t1.group, cams,
                { method: 'dlt', includedCameras: names });
            const rb = triangulateAndReproject(t1.group, cams,
                { method: 'ba', includedCameras: names });
            if (rd.meanError == null || rb.meanError == null) continue;
            total++;
            if (rb.meanError > rd.meanError + 1e-9) {
                worse++; worstRatio = Math.max(worstRatio, rb.meanError / rd.meanError);
            } else if (rb.meanError < rd.meanError - 1e-9) better++;
        }
        return { worse: worse, better: better, total: total, worstRatio: worstRatio };
    }

    describe('BA #113 - group reported error never worse than DLT', function () {
        const SCENARIOS = [
            ['no distortion, noise only', NO_DIST, 2.0, 0],
            ['no distortion, gross outlier', NO_DIST, 1.0, 60],
            ['radial k1=-0.3, noise only', RADIAL, 2.0, 0],
            ['radial k1=-0.3, gross outlier', RADIAL, 1.0, 60],
            ['mild radial k1=-0.08, noise only', MILD_RADIAL, 2.0, 0],
        ];
        SCENARIOS.forEach(function (sc) {
            it('holds: ' + sc[0], function () {
                if (typeof triangulateAndReproject !== 'function') return;
                const s = sweepGroups({
                    dist: sc[1], seed: 99, trials: 150, nNodes: 12,
                    noisePx: sc[2], outlierPx: sc[3]
                });
                assertTrue(s.total > 100, 'sweep produced groups (' + s.total + ')');
                assertTrue(s.worse === 0,
                    'BA raised the reported mean error in ' + s.worse + '/' + s.total +
                    ' groups (worst ' + s.worstRatio.toFixed(4) + 'x)');
                assertTrue(s.better > s.total * 0.9,
                    'BA still improves nearly every group (' + s.better + '/' + s.total + ')');
            });
        });
    });

    // ---- Per-point sweep, with a pre-fix baseline for teeth -----------------

    /**
     * Sweep single points; return how often each configuration raises the mean
     * native-space Euclidean reprojection error above its DLT initialization.
     */
    function sweepPoints(opts) {
        const cams = buildRig(opts.dist, opts.nCams);
        const mats = cams.map(function (c) { return c.projectionMatrix; });
        const r = rng(opts.seed);
        const acc = { dlt3d: 0, fix3d: 0, preWorse: 0, fixWorse: 0, fixBetter: 0, total: 0,
                      preWorstRatio: 1, fixWorstRatio: 1 };
        for (let t = 0; t < opts.trials; t++) {
            const gt = randomTruth(r, 1)[0];
            const raw = cams.map(function (c) { return observe(c, gt, opts.noisePx, r); });
            if (opts.outlierPx > 0) {
                const oi = Math.floor(r.u() * cams.length);
                raw[oi] = [raw[oi][0] + opts.outlierPx * (r.u() < 0.5 ? -1 : 1),
                           raw[oi][1] + opts.outlierPx * (r.u() < 0.5 ? -1 : 1)];
            }
            const und = raw.map(function (p, i) { return cams[i].undistortPoint(p); });
            const dlt = triangulatePointDLT(und, mats);
            if (dlt == null) continue;
            // Pre-fix took undistorted observations; the fix takes raw + cameras.
            const pre = triangulatePointBA(und, mats, dlt, PRE_FIX);
            const fix = triangulatePointBA(raw, mats, dlt, { cameras: cams });
            if (pre == null || fix == null) continue;
            acc.total++;

            // Reported metric: mean Euclidean error vs the RAW detections, in
            // native space — exactly triangulateAndReproject's `meanError`.
            function reported(pt) {
                let s = 0;
                for (let i = 0; i < cams.length; i++) {
                    const q = reprojectPointCamera(pt, cams[i]);
                    s += Math.sqrt((raw[i][0] - q[0]) * (raw[i][0] - q[0]) +
                                   (raw[i][1] - q[1]) * (raw[i][1] - q[1]));
                }
                return s / cams.length;
            }
            function dist3(a) {
                return Math.sqrt((a[0] - gt[0]) * (a[0] - gt[0]) + (a[1] - gt[1]) * (a[1] - gt[1]) +
                                 (a[2] - gt[2]) * (a[2] - gt[2]));
            }
            const e0 = reported(dlt), ep = reported(pre), ef = reported(fix);
            if (ep > e0 + 1e-9) { acc.preWorse++; acc.preWorstRatio = Math.max(acc.preWorstRatio, ep / e0); }
            if (ef > e0 + 1e-9) { acc.fixWorse++; acc.fixWorstRatio = Math.max(acc.fixWorstRatio, ef / e0); }
            if (ef < e0 - 1e-9) acc.fixBetter++;
            acc.dlt3d += dist3(dlt);
            acc.fix3d += dist3(fix);
        }
        return acc;
    }

    describe('BA #113 - per-point invariant, with a pre-fix baseline', function () {
        const CASES = [
            ['no distortion, noise only', NO_DIST, 2.0, 0, 4],
            ['no distortion, gross outlier', NO_DIST, 1.0, 60, 4],
            ['radial k1=-0.3, noise only', RADIAL, 2.0, 0, 4],
            ['radial k1=-0.3, gross outlier', RADIAL, 1.0, 60, 4],
            ['radial k1=-0.3, two views only', RADIAL, 2.0, 0, 2],
        ];
        CASES.forEach(function (c) {
            it('never worsens the reported error: ' + c[0], function () {
                if (typeof triangulatePointBA !== 'function') return;
                const a = sweepPoints({
                    dist: c[1], noisePx: c[2], outlierPx: c[3], nCams: c[4],
                    seed: 31337, trials: 1200
                });
                assertTrue(a.total > 900, 'trials ran (' + a.total + ')');
                assertTrue(a.fixWorse === 0,
                    'BA raised the reported error in ' + a.fixWorse + '/' + a.total +
                    ' trials (worst ' + a.fixWorstRatio.toFixed(5) + 'x)');
                assertTrue(a.fixBetter > a.total * 0.9,
                    'BA still improves nearly every point (' + a.fixBetter + '/' + a.total + ')');
            });
        });

        // TEETH. If these ever stop failing-in-the-old-config, the tests above
        // have stopped proving anything and something has silently changed.
        it('the pre-#113 configuration DOES violate the invariant (test has teeth)', function () {
            if (typeof triangulatePointBA !== 'function') return;
            // Mechanism 2 in isolation: zero distortion, so only the
            // squared-loss-vs-mean-report mismatch can be at fault.
            const clean = sweepPoints({
                dist: NO_DIST, noisePx: 2.0, outlierPx: 0, nCams: 4,
                seed: 31337, trials: 1200
            });
            assertTrue(clean.preWorse > clean.total * 0.1,
                'pre-fix should raise the reported error on a meaningful fraction ' +
                'even with NO distortion, got ' + clean.preWorse + '/' + clean.total);
            // Mechanism 1: with distortion the failure rate should be higher still.
            const distorted = sweepPoints({
                dist: RADIAL, noisePx: 2.0, outlierPx: 0, nCams: 4,
                seed: 31337, trials: 1200
            });
            assertTrue(distorted.preWorse > clean.preWorse,
                'adding distortion should make the pre-fix failure worse: ' +
                distorted.preWorse + ' vs ' + clean.preWorse + ' of ' + clean.total);
        });
    });

    describe('BA #113 - robust loss improves 3D accuracy under outliers', function () {
        it('is far closer to ground truth than DLT when a view is an outlier', function () {
            if (typeof triangulatePointBA !== 'function') return;
            const a = sweepPoints({
                dist: NO_DIST, noisePx: 1.0, outlierPx: 60, nCams: 4,
                seed: 4242, trials: 1200
            });
            assertTrue(a.total > 900, 'trials ran (' + a.total + ')');
            // Measured ~11x better (3.46 -> 0.30 mean distance to truth).
            assertLessThan(a.fix3d / a.total, (a.dlt3d / a.total) * 0.5,
                'BA 3D error (' + (a.fix3d / a.total).toFixed(4) + ') should be far below DLT (' +
                (a.dlt3d / a.total).toFixed(4) + ') under outliers');
        });

        it('costs only a little 3D accuracy on clean Gaussian noise', function () {
            if (typeof triangulatePointBA !== 'function') return;
            // Honest counterpart of the test above: minimizing Σ‖r‖ instead of
            // Σ‖r‖² is slightly less statistically efficient when the noise
            // really is Gaussian and there are no outliers. Measured ~10%
            // (0.2101 -> 0.2309). Pinned so a future change cannot quietly
            // trade away much more than that.
            const a = sweepPoints({
                dist: NO_DIST, noisePx: 2.0, outlierPx: 0, nCams: 4,
                seed: 4242, trials: 1200
            });
            assertLessThan(a.fix3d / a.total, (a.dlt3d / a.total) * 1.25,
                'BA 3D error on clean data (' + (a.fix3d / a.total).toFixed(4) +
                ') should stay within 25% of DLT (' + (a.dlt3d / a.total).toFixed(4) + ')');
        });
    });

    describe('BA #113 - views excluded from the solve', function () {
        it('holds over the views BA is allowed to fit, not over excluded ones', function () {
            if (typeof triangulateAndReproject !== 'function') return;
            // A view excluded in the Camera Views panel does not contribute to
            // the solve but IS still reprojected into and counted in the headline
            // `meanError`. BA fitting the *included* views better can therefore
            // raise the excluded view's error, and with it the headline number.
            // That is correct behavior, not a regression: chasing an excluded
            // view is exactly what excluding it forbids. The invariant that must
            // hold is the one over the solve's own views.
            const cams = buildRig(RADIAL);
            const included = ['c1', 'c2', 'c3'];
            const r = rng(777);
            function meanOver(res, names) {
                let s = 0, n = 0;
                for (let i = 0; i < names.length; i++) {
                    const errs = res.errors[names[i]];
                    if (!errs) continue;
                    for (let k = 0; k < errs.length; k++) {
                        if (errs[k] != null) { s += errs[k]; n++; }
                    }
                }
                return n ? s / n : null;
            }
            let worseIncluded = 0, total = 0, worstRatio = 1;
            for (let t = 0; t < 150; t++) {
                const t1 = makeGroup(cams, r, 10, 2.0, 0);
                const rd = triangulateAndReproject(t1.group, cams,
                    { method: 'dlt', includedCameras: included });
                const rb = triangulateAndReproject(t1.group, cams,
                    { method: 'ba', includedCameras: included });
                const di = meanOver(rd, included), bi = meanOver(rb, included);
                if (di == null || bi == null) continue;
                total++;
                if (bi > di + 1e-9) { worseIncluded++; worstRatio = Math.max(worstRatio, bi / di); }
            }
            assertTrue(total > 100, 'sweep produced groups (' + total + ')');
            assertTrue(worseIncluded === 0,
                'BA raised the error over INCLUDED views in ' + worseIncluded + '/' + total +
                ' groups (worst ' + worstRatio.toFixed(5) + 'x)');
        });
    });

    // ---- Joint bundle adjustment (cameras + structure) ----------------------

    describe('BA #113 - joint bundle adjustment (bundleAdjustCameras)', function () {
        const JOINT_DIST = [-0.08, 0.01, 0.0002, 0.0002, 0];

        /**
         * Ground-truth rig + point cloud + observations, then a version of the
         * rig with cameras 1..N-1 perturbed. Camera 0 is never perturbed: it is
         * the gauge anchor, so perturbing it would just re-express the whole
         * solution in a different frame and make "did we recover the truth?"
         * unanswerable.
         */
        function jointFixture(rotPert, transPert, noisePx, nPoints, scale) {
            const r = rng(2024);
            const trueCams = RIG.map(function (s) {
                return new Camera(s[0], K, JOINT_DIST, s[1], s[2], [640, 480]);
            });
            const truth = [];
            for (let i = 0; i < nPoints; i++) {
                truth.push([(r.u() - 0.5) * 30, (r.u() - 0.5) * 30, 35 + r.u() * 25]);
            }
            const obs = truth.map(function (X) {
                return trueCams.map(function (c) { return observe(c, X, noisePx, r); });
            });
            const k = scale || 1;
            const badCams = RIG.map(function (s, i) {
                // Camera 0's pose is the gauge anchor and is never perturbed —
                // perturbing it would just re-express the solution in another
                // frame, making "did we recover the truth?" unanswerable. A
                // uniform `scale` is applied to EVERY camera including 0, since
                // that is what a global scale error looks like.
                if (i === 0) {
                    return new Camera(s[0], K, JOINT_DIST, s[1],
                        s[2].map(function (v) { return v * k; }), [640, 480]);
                }
                return new Camera(s[0], K, JOINT_DIST,
                    s[1].map(function (v) { return v + r.gauss() * rotPert; }),
                    s[2].map(function (v) { return v * k + r.gauss() * transPert; }),
                    [640, 480]);
            });
            return { trueCams: trueCams, badCams: badCams, obs: obs, truth: truth };
        }

        function poseDelta(cam, spec) {
            let dr = 0, dt = 0;
            for (let j = 0; j < 3; j++) {
                dr += (cam.rvec[j] - spec[1][j]) * (cam.rvec[j] - spec[1][j]);
                dt += (cam.tvec[j] - spec[2][j]) * (cam.tvec[j] - spec[2][j]);
            }
            return { dr: Math.sqrt(dr), dt: Math.sqrt(dt) };
        }

        it('recovers a badly perturbed calibration', function () {
            if (typeof bundleAdjustCameras !== 'function') return;
            const f = jointFixture(0.03, 0.6, 0.5, 200);
            const res = bundleAdjustCameras(f.obs, f.badCams, {});
            assertTrue(res != null, 'returns a result');
            // Measured on a 600-point cloud: 14.58 px -> 0.4832 px, against a
            // 0.4794 px noise floor for the true calibration.
            assertTrue(res.errorBefore > 5,
                'fixture really is badly calibrated (' + res.errorBefore.toFixed(3) + ' px)');
            assertLessThan(res.errorAfter, res.errorBefore * 0.2,
                'joint BA cuts the median reprojection error from ' +
                res.errorBefore.toFixed(3) + ' px to ' + res.errorAfter.toFixed(3) + ' px');
            assertTrue(res.improved === true, 'reports that it improved');
        });

        it('recovers the true extrinsics, not merely a reprojection-equivalent set', function () {
            if (typeof bundleAdjustCameras !== 'function') return;
            // This is the gauge test. A joint solve with a mishandled gauge can
            // drive reprojection error down while drifting the geometry
            // arbitrarily; only comparing against the TRUE poses catches that.
            // Rotation-only perturbation, so every baseline length starts exact
            // and the unobservable scale direction (next test) is not in play.
            const f = jointFixture(0.03, 0, 0.5, 200);
            const res = bundleAdjustCameras(f.obs, f.badCams, {});
            assertTrue(res != null, 'returns a result');
            for (let i = 1; i < RIG.length; i++) {
                const before = poseDelta(f.badCams[i], RIG[i]);
                const after = poseDelta(res.cameras[i], RIG[i]);
                // Measured 0.007x-0.034x.
                assertLessThan(after.dr, before.dr * 0.15,
                    RIG[i][0] + ' rotation error ' + before.dr.toFixed(5) + ' -> ' + after.dr.toFixed(5));
                // Translations started exact; they must STAY near-exact rather
                // than being traded away to absorb the rotation fit.
                assertLessThan(after.dt, 0.15,
                    RIG[i][0] + ' translation stays near truth (' + after.dt.toFixed(5) + ')');
            }
        });

        it('cannot and does not try to fix a global scale error (documented limit)', function () {
            if (typeof bundleAdjustCameras !== 'function') return;
            // A uniform similarity scaling of cameras AND structure reprojects
            // identically, so scale is unobservable from images alone. This is
            // why aniposelib carries a calibration-board term (`errors_obj`,
            // weighted 2/board_square_length) — it supplies the metric
            // reference. LUCID bundle-adjusts on animal keypoints where no such
            // model exists, so `bundleAdjustCameras` PRESERVES the input scale
            // by construction (the baseline gauge) rather than inventing one.
            //
            // Consequence for a caller: if the initial calibration's scale is
            // wrong, joint BA will not fix it, and translation errors that are
            // really scale errors will persist. Measured: an 8% oversized rig
            // already sits at the noise floor before BA (0.473 px) and comes out
            // with its scale untouched.
            const f = jointFixture(0, 0, 0.5, 200, 1.08);
            const res = bundleAdjustCameras(f.obs, f.badCams, {});
            assertTrue(res != null, 'returns a result');
            // Nothing to see: a scaled rig reprojects as well as the true one.
            assertLessThan(res.errorBefore, 1.0,
                'a purely scaled rig already reprojects at the noise floor (' +
                res.errorBefore.toFixed(4) + ' px)');
            // And the scale is left alone rather than being churned.
            for (let i = 1; i < RIG.length; i++) {
                const before = poseDelta(f.badCams[i], RIG[i]);
                const after = poseDelta(res.cameras[i], RIG[i]);
                assertTrue(after.dt > before.dt * 0.8,
                    RIG[i][0] + ' scale error is preserved, not "fixed": ' +
                    before.dt.toFixed(4) + ' -> ' + after.dt.toFixed(4));
            }
        });

        it('holds camera 0 exactly fixed (gauge anchor)', function () {
            if (typeof bundleAdjustCameras !== 'function') return;
            const f = jointFixture(0.03, 0.6, 0.5, 150);
            const res = bundleAdjustCameras(f.obs, f.badCams, {});
            for (let j = 0; j < 3; j++) {
                assertTrue(res.cameras[0].rvec[j] === RIG[0][1][j],
                    'camera 0 rvec[' + j + '] unchanged');
                assertTrue(res.cameras[0].tvec[j] === RIG[0][2][j],
                    'camera 0 tvec[' + j + '] unchanged');
            }
        });

        it('never worsens an already-optimal calibration', function () {
            if (typeof bundleAdjustCameras !== 'function') return;
            // The #113 failure mode, one level up. The per-round objective is a
            // robust loss on a TRIMMED subset and the trim moves every round, so
            // the round sequence is not monotone in the reported median error:
            // the raw aniposelib schedule was measured to drift an optimal
            // calibration from 0.4794 px to 0.4836 px. bundleAdjustCameras keeps
            // the best-scoring calibration instead.
            const f = jointFixture(0, 0, 0.5, 200);
            const res = bundleAdjustCameras(f.obs, f.badCams, {});
            assertTrue(res != null, 'returns a result');
            assertTrue(res.errorAfter <= res.errorBefore + 1e-9,
                'median error must not rise: ' + res.errorBefore.toFixed(6) +
                ' -> ' + res.errorAfter.toFixed(6));
            // NOTE: `improved` is legitimately true here. With finite noise the
            // TRUE calibration is not the reprojection-error minimizer, so BA
            // can dip below it by mildly overfitting the noise (measured
            // 0.4907 -> 0.4695). What matters is that the geometry barely moves
            // while it does so — a joint solve that "improved" the error by
            // wandering off the true poses would be the real failure.
            for (let i = 1; i < RIG.length; i++) {
                const after = poseDelta(res.cameras[i], RIG[i]);
                assertLessThan(after.dr, 0.01,
                    RIG[i][0] + ' rotation barely drifts (' + after.dr.toFixed(5) + ')');
                assertLessThan(after.dt, 0.15,
                    RIG[i][0] + ' translation barely drifts (' + after.dt.toFixed(5) + ')');
            }
        });

        it('does not mutate the input cameras', function () {
            if (typeof bundleAdjustCameras !== 'function') return;
            const f = jointFixture(0.03, 0.6, 0.5, 150);
            const snapshot = f.badCams.map(function (c) {
                return c.rvec.join(',') + '|' + c.tvec.join(',');
            });
            bundleAdjustCameras(f.obs, f.badCams, {});
            for (let i = 0; i < f.badCams.length; i++) {
                const now = f.badCams[i].rvec.join(',') + '|' + f.badCams[i].tvec.join(',');
                assertTrue(now === snapshot[i], 'input camera ' + i + ' untouched');
            }
        });

        it('anneals mu geometrically from startMu down to endMu', function () {
            if (typeof bundleAdjustCameras !== 'function') return;
            // The threshold schedule is the heart of bundle_adjust_iter. Use a
            // deliberately loose data set (large noise) so the data-driven p75
            // clamp does not immediately override the schedule, and read the mu
            // actually used out of `rounds`.
            const f = jointFixture(0.02, 0.4, 3.0, 250);
            const res = bundleAdjustCameras(f.obs, f.badCams, {
                nIters: 4, startMu: 40, endMu: 2, errorThreshold: 0
            });
            assertTrue(res != null, 'returns a result');
            const inner = res.rounds.filter(function (r) { return !r.final; });
            assertTrue(inner.length >= 2, 'ran at least two inner rounds (' + inner.length + ')');
            for (let i = 1; i < inner.length; i++) {
                assertTrue(inner[i].mu <= inner[i - 1].mu + 1e-9,
                    'mu must not increase across inner rounds: ' +
                    inner.map(function (r) { return r.mu.toFixed(3); }).join(' -> '));
            }
            const last = res.rounds[res.rounds.length - 1];
            assertTrue(last.final === true, 'the last round is the final loose one');
            // The final round loosens via `max(max(p75, endMu), p15)`, so its mu
            // is at least endMu. It is NOT comparable to the inner rounds' mu or
            // kept-count: it is recomputed from the already-improved cameras, so
            // its p75 is smaller and its threshold can legitimately be lower in
            // absolute terms while still being the loosest choice available at
            // that point (measured inner 17.844 -> 4.019, final 3.930).
            assertTrue(last.mu >= 2 - 1e-9,
                'final round mu respects endMu: ' + last.mu.toFixed(4));
        });

        it('returns null when there is nothing to solve', function () {
            if (typeof bundleAdjustCameras !== 'function') return;
            const f = jointFixture(0, 0, 0.5, 10);
            assertTrue(bundleAdjustCameras(f.obs, [f.badCams[0]], {}) === null,
                'a single camera cannot be bundle-adjusted');
            assertTrue(bundleAdjustCameras([], f.badCams, {}) === null,
                'no observations');
            // Every point visible in only one view -> nothing triangulable.
            const oneView = f.obs.map(function (row) {
                return row.map(function (o, c) { return c === 0 ? o : null; });
            });
            assertTrue(bundleAdjustCameras(oneView, f.badCams, {}) === null,
                'no point visible in two or more views');
        });
    });

    describe('BA #113 - residual space', function () {
        it('optimizes native (distorted) pixel space when cameras are supplied', function () {
            if (typeof triangulatePointBA !== 'function') return;
            // Direct evidence for the mechanism-1 fix: given RAW observations and
            // cameras, the solve must beat the pre-fix undistorted-space solve on
            // the native-space metric.
            const cams = buildRig(RADIAL);
            const mats = cams.map(function (c) { return c.projectionMatrix; });
            const r = rng(2026);
            let nativeWins = 0, total = 0;
            for (let t = 0; t < 400; t++) {
                const gt = randomTruth(r, 1)[0];
                const raw = cams.map(function (c) { return observe(c, gt, 2.0, r); });
                const und = raw.map(function (p, i) { return cams[i].undistortPoint(p); });
                const dlt = triangulatePointDLT(und, mats);
                if (dlt == null) continue;
                const pre = triangulatePointBA(und, mats, dlt, PRE_FIX);
                const fix = triangulatePointBA(raw, mats, dlt, { cameras: cams });
                if (pre == null || fix == null) continue;
                total++;
                function nativeErr(pt) {
                    let s = 0;
                    for (let i = 0; i < cams.length; i++) {
                        const q = reprojectPointCamera(pt, cams[i]);
                        s += Math.sqrt((raw[i][0] - q[0]) * (raw[i][0] - q[0]) +
                                       (raw[i][1] - q[1]) * (raw[i][1] - q[1]));
                    }
                    return s;
                }
                if (nativeErr(fix) < nativeErr(pre) - 1e-9) nativeWins++;
            }
            assertTrue(total > 300, 'trials ran (' + total + ')');
            assertTrue(nativeWins > total * 0.95,
                'native-space solve should beat the undistorted-space solve on the ' +
                'native metric in nearly every trial (' + nativeWins + '/' + total + ')');
        });

        it('reproduces the pre-#113 behavior exactly under the legacy option set', function () {
            if (typeof triangulatePointBA !== 'function') return;
            // Guards the baseline the "teeth" test depends on: with
            // robustScale=Infinity, polish=false, guard=false the solve is a
            // plain sum-of-squares LM, so it must be strictly monotone in
            // sum-of-squares (that property was never broken).
            const cams = buildRig(NO_DIST);
            const mats = cams.map(function (c) { return c.projectionMatrix; });
            const r = rng(13);
            let violations = 0, total = 0;
            for (let t = 0; t < 600; t++) {
                const gt = randomTruth(r, 1)[0];
                const obs = cams.map(function (c) { return observe(c, gt, 3.0, r); });
                const oi = Math.floor(r.u() * cams.length);
                obs[oi] = [obs[oi][0] + 150 * (r.u() - 0.5), obs[oi][1] + 150 * (r.u() - 0.5)];
                const dlt = triangulatePointDLT(obs, mats);
                if (dlt == null) continue;
                const pre = triangulatePointBA(obs, mats, dlt, PRE_FIX);
                if (pre == null) continue;
                total++;
                function sq(pt) {
                    let s = 0;
                    for (let i = 0; i < cams.length; i++) {
                        const q = reprojectPoint(pt, mats[i]);
                        s += (obs[i][0] - q[0]) * (obs[i][0] - q[0]) +
                             (obs[i][1] - q[1]) * (obs[i][1] - q[1]);
                    }
                    return s;
                }
                if (sq(pre) > sq(dlt) * (1 + 1e-9)) violations++;
            }
            assertTrue(total > 500, 'trials ran (' + total + ')');
            assertTrue(violations === 0,
                'the legacy plain-squares path must stay monotone in sum-of-squares, ' +
                violations + '/' + total + ' violations');
        });
    });
})();
