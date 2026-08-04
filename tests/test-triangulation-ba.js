/**
 * test-triangulation-ba.js — Bundle-adjustment correctness (issue #113).
 *
 * The issue's symptom: **"error sometimes goes up compared to DLT"**. Bundle
 * adjustment is initialized FROM the DLT solution and only refines it, so the
 * reprojection error the app reports must never be worse than DLT's. These tests
 * pin that invariant across the scenarios that broke it, and pin the accuracy
 * gain that a robust loss buys under outliers.
 *
 * Three independent mechanisms were reproduced on the pre-fix code (counts are
 * from the harness below, and are what these tests assert away):
 *
 *   1. SPACE MISMATCH — BA minimized squared error against the *undistorted*
 *      observations, while `triangulateAndReproject` reports `meanError` in the
 *      camera's *native (distorted)* pixel space. With realistic radial
 *      distortion the reported error rose in 162/400 groups (40%), while the
 *      undistorted-space error rose in 0/400. The optimizer was right; it was
 *      optimizing a different thing than the number on screen.
 *
 *   2. LOSS MISMATCH — BA minimized the SUM of SQUARED residuals (dominated by
 *      the worst view) while the report is the MEAN of Euclidean residuals. With
 *      one gross outlier and zero distortion the reported error rose in 134/400
 *      groups (34%) even though the sum of squares strictly fell every time.
 *
 *   3. OUTLIER CHASING — a plain squared loss pulls the 3D point toward a bad
 *      observation, so BA's distance to ground truth was WORSE than DLT's in
 *      1345/3000 single-point trials (up to 1.48x). Fixed by the robust loss.
 *
 * NOT a bug (verified, 0 violations): the Levenberg-Marquardt loop itself. It is
 * strictly monotone in its own objective (0/3000 sum-of-squares increases) and
 * reaches the local optimum (0/4000 trials left a >1e-6 relative cost gap versus
 * a 500-iteration/1e-16 solve). Do not "fix" the LM ladder.
 *
 * Runs under the browser runner and the Node `vm` harness (run-node.js).
 */
(function () {
    const { describe, it, assertTrue, assertLessThan, assertNotNull } = TestFramework;

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
    // Realistic barrel distortion (same order of magnitude as a real lab camera).
    const RADIAL = [-0.3, 0.12, 0.001, 0.001, 0];

    // A 4-camera rig with genuinely different viewpoints.
    const RIG = [
        ['c1', [0, 0, 0], [0, 0, 0]],
        ['c2', [0, 0.4, 0], [20, 0, 0]],
        ['c3', [0.2, 0, 0], [0, 15, 0]],
        ['c4', [0.1, -0.35, 0], [-18, 4, 0]],
    ];
    function buildRig(dist) {
        return RIG.map(function (r) { return new Camera(r[0], K, dist, r[1], r[2], [640, 480]); });
    }

    // A synthetic InstanceGroup: nNodes ground-truth 3D points, projected into
    // every camera with Gaussian pixel noise, optionally with one gross outlier.
    function makeGroup(cams, r, nNodes, noisePx, outlierPx) {
        const truth = [];
        for (let k = 0; k < nNodes; k++) {
            truth.push([(r.u() - 0.5) * 24, (r.u() - 0.5) * 24, 35 + r.u() * 20]);
        }
        const g = new InstanceGroup(1, 0);
        for (let c = 0; c < cams.length; c++) {
            const pts = truth.map(function (p) {
                const q = cams[c].project(p);
                return [q[0] + r.gauss() * noisePx, q[1] + r.gauss() * noisePx];
            });
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

    // Sweep `trials` synthetic groups; count how often BA's reported error beats
    // / loses to DLT's. `pick` selects which reported metric to compare.
    function sweep(opts) {
        const cams = buildRig(opts.dist);
        const names = cams.map(function (c) { return c.name; });
        const r = rng(opts.seed);
        let worse = 0, better = 0, total = 0, worstRatio = 1;
        for (let t = 0; t < opts.trials; t++) {
            const t1 = makeGroup(cams, r, opts.nNodes, opts.noisePx, opts.outlierPx || 0);
            const base = { includedCameras: names };
            const rd = triangulateAndReproject(t1.group, cams, Object.assign({ method: 'dlt' }, base));
            const rb = triangulateAndReproject(t1.group, cams, Object.assign({ method: 'ba' }, base));
            const ed = opts.pick(rd), eb = opts.pick(rb);
            if (ed == null || eb == null) continue;
            total++;
            if (eb > ed + 1e-9) { worse++; worstRatio = Math.max(worstRatio, eb / ed); }
            else if (eb < ed - 1e-9) better++;
        }
        return { worse: worse, better: better, total: total, worstRatio: worstRatio };
    }

    const distorted = function (res) { return res.meanError; };
    const undistorted = function (res) { return res.meanErrorUndistorted; };

    describe('BA #113 - reported error never worse than DLT', function () {
        it('holds in the camera-native (distorted) space with radial distortion', function () {
            if (typeof triangulateAndReproject !== 'function') return;
            // MECHANISM 1. Pre-fix: 162/400 groups worse.
            const s = sweep({
                dist: RADIAL, seed: 99, trials: 200, nNodes: 12,
                noisePx: 2.0, pick: distorted
            });
            assertTrue(s.total > 150, 'sweep produced groups (' + s.total + ')');
            assertTrue(s.worse === 0,
                'BA raised the reported distorted-space mean error in ' + s.worse + '/' +
                s.total + ' groups (worst ' + s.worstRatio.toFixed(4) + 'x)');
            assertTrue(s.better > 0, 'BA still improves most groups (' + s.better + '/' + s.total + ')');
        });

        it('holds in undistorted space with radial distortion', function () {
            if (typeof triangulateAndReproject !== 'function') return;
            const s = sweep({
                dist: RADIAL, seed: 99, trials: 200, nNodes: 12,
                noisePx: 2.0, pick: undistorted
            });
            assertTrue(s.worse === 0,
                'BA raised the undistorted-space mean error in ' + s.worse + '/' + s.total);
        });

        it('holds when a gross outlier observation is present', function () {
            if (typeof triangulateAndReproject !== 'function') return;
            // MECHANISM 2. Pre-fix: 134/400 groups worse (no distortion at all).
            const s = sweep({
                dist: NO_DIST, seed: 99, trials: 200, nNodes: 12,
                noisePx: 1.0, outlierPx: 60, pick: distorted
            });
            assertTrue(s.worse === 0,
                'BA raised the reported mean error under an outlier in ' + s.worse + '/' +
                s.total + ' groups (worst ' + s.worstRatio.toFixed(4) + 'x)');
        });

        it('holds with both distortion and an outlier', function () {
            if (typeof triangulateAndReproject !== 'function') return;
            // Pre-fix: 170/400 groups worse.
            const s = sweep({
                dist: RADIAL, seed: 31, trials: 200, nNodes: 12,
                noisePx: 1.0, outlierPx: 60, pick: distorted
            });
            assertTrue(s.worse === 0,
                'BA raised the reported mean error in ' + s.worse + '/' + s.total +
                ' groups (worst ' + s.worstRatio.toFixed(4) + 'x)');
        });

        it('holds with noise only and no distortion', function () {
            if (typeof triangulateAndReproject !== 'function') return;
            // Pre-fix: 14/400 groups worse (squared-vs-mean alone, no outliers).
            const s = sweep({
                dist: NO_DIST, seed: 7, trials: 200, nNodes: 12,
                noisePx: 2.0, pick: distorted
            });
            assertTrue(s.worse === 0, 'BA raised the reported mean error in ' + s.worse + '/' + s.total);
            assertTrue(s.better > 0, 'BA still improves groups (' + s.better + '/' + s.total + ')');
        });

        it('holds when some views are missing the keypoint', function () {
            if (typeof triangulateAndReproject !== 'function') return;
            const cams = buildRig(RADIAL);
            const names = cams.map(function (c) { return c.name; });
            const r = rng(1234);
            let worse = 0, total = 0, worstRatio = 1;
            for (let t = 0; t < 200; t++) {
                const t1 = makeGroup(cams, r, 10, 1.5, r.u() < 0.5 ? 50 : 0);
                // Drop a random node from a random view (leaving >= 2 views).
                for (let d = 0; d < 3; d++) {
                    const inst = t1.group.getInstance(names[Math.floor(r.u() * names.length)]);
                    inst.clearPoint(Math.floor(r.u() * 10));
                }
                const rd = triangulateAndReproject(t1.group, cams, { method: 'dlt', includedCameras: names });
                const rb = triangulateAndReproject(t1.group, cams, { method: 'ba', includedCameras: names });
                if (rd.meanError == null || rb.meanError == null) continue;
                total++;
                if (rb.meanError > rd.meanError + 1e-9) {
                    worse++; worstRatio = Math.max(worstRatio, rb.meanError / rd.meanError);
                }
            }
            assertTrue(total > 100, 'sweep produced groups (' + total + ')');
            assertTrue(worse === 0, 'BA raised the reported mean error in ' + worse + '/' + total +
                ' groups with missing views (worst ' + worstRatio.toFixed(4) + 'x)');
        });
    });

    describe('BA #113 - per-point invariant', function () {
        it('triangulatePointBA never increases the mean per-view pixel error vs its DLT init', function () {
            if (typeof triangulatePointBA !== 'function') return;
            const cams = buildRig(NO_DIST);
            const mats = cams.map(function (c) { return c.projectionMatrix; });
            const r = rng(2026);
            function meanAbs(pt, obs) {
                let s = 0, n = 0;
                for (let i = 0; i < obs.length; i++) {
                    if (obs[i] == null) continue;
                    const q = reprojectPoint(pt, mats[i]);
                    s += Math.sqrt((obs[i][0] - q[0]) * (obs[i][0] - q[0]) +
                                   (obs[i][1] - q[1]) * (obs[i][1] - q[1]));
                    n++;
                }
                return n ? s / n : null;
            }
            let worse = 0, total = 0, worstRatio = 1;
            for (let t = 0; t < 2000; t++) {
                const gt = [(r.u() - 0.5) * 20, (r.u() - 0.5) * 20, 35 + r.u() * 20];
                const obs = cams.map(function (c) {
                    const q = c.project(gt);
                    return [q[0] + r.gauss() * 1.0, q[1] + r.gauss() * 1.0];
                });
                const oi = Math.floor(r.u() * cams.length);
                obs[oi] = [obs[oi][0] + 50 * (r.u() - 0.5), obs[oi][1] + 50 * (r.u() - 0.5)];
                const dlt = triangulatePointDLT(obs, mats);
                if (dlt == null) continue;
                const ba = triangulatePointBA(obs, mats, dlt);
                if (ba == null) continue;
                total++;
                const ed = meanAbs(dlt, obs), eb = meanAbs(ba, obs);
                if (eb > ed + 1e-9) { worse++; worstRatio = Math.max(worstRatio, eb / ed); }
            }
            assertTrue(total > 1500, 'trials ran (' + total + ')');
            // Pre-fix: ~1105/3000 worse, up to 1.073x.
            assertTrue(worse === 0, 'per-point BA raised the mean pixel error in ' + worse + '/' +
                total + ' trials (worst ' + worstRatio.toFixed(4) + 'x)');
        });

        it('still strictly beats DLT on clean noisy data (BA is not a no-op)', function () {
            if (typeof triangulatePointBA !== 'function') return;
            const cams = buildRig(NO_DIST);
            const mats = cams.map(function (c) { return c.projectionMatrix; });
            const r = rng(555);
            let strictlyBetter = 0, total = 0;
            for (let t = 0; t < 500; t++) {
                const gt = [(r.u() - 0.5) * 20, (r.u() - 0.5) * 20, 35 + r.u() * 20];
                const obs = cams.map(function (c) {
                    const q = c.project(gt);
                    return [q[0] + r.gauss() * 2.0, q[1] + r.gauss() * 2.0];
                });
                const dlt = triangulatePointDLT(obs, mats);
                const ba = triangulatePointBA(obs, mats, dlt);
                if (dlt == null || ba == null) continue;
                total++;
                let sd = 0, sb = 0;
                for (let i = 0; i < obs.length; i++) {
                    const qd = reprojectPoint(dlt, mats[i]), qb = reprojectPoint(ba, mats[i]);
                    sd += (obs[i][0] - qd[0]) * (obs[i][0] - qd[0]) + (obs[i][1] - qd[1]) * (obs[i][1] - qd[1]);
                    sb += (obs[i][0] - qb[0]) * (obs[i][0] - qb[0]) + (obs[i][1] - qb[1]) * (obs[i][1] - qb[1]);
                }
                if (sb < sd - 1e-9) strictlyBetter++;
            }
            assertTrue(strictlyBetter > total * 0.9,
                'BA strictly reduces squared reprojection error on ' + strictlyBetter + '/' + total);
        });
    });

    describe('BA #113 - robust loss improves 3D accuracy under outliers', function () {
        it('is at least as close to ground truth as DLT on average', function () {
            if (typeof triangulatePointBA !== 'function') return;
            // MECHANISM 3. Pre-fix, a plain squared loss chased the outlier and was
            // FARTHER from truth than DLT in 1345/3000 trials. A robust loss should
            // make BA's *aggregate* 3D error strictly better than DLT's.
            const cams = buildRig(NO_DIST);
            const mats = cams.map(function (c) { return c.projectionMatrix; });
            const r = rng(4242);
            let sumD = 0, sumB = 0, total = 0;
            for (let t = 0; t < 1500; t++) {
                const gt = [(r.u() - 0.5) * 20, (r.u() - 0.5) * 20, 35 + r.u() * 20];
                const obs = cams.map(function (c) {
                    const q = c.project(gt);
                    return [q[0] + r.gauss() * 1.0, q[1] + r.gauss() * 1.0];
                });
                const oi = Math.floor(r.u() * cams.length);
                obs[oi] = [obs[oi][0] + 40 * (r.u() < 0.5 ? -1 : 1), obs[oi][1] + 40 * (r.u() < 0.5 ? -1 : 1)];
                const dlt = triangulatePointDLT(obs, mats);
                if (dlt == null) continue;
                const ba = triangulatePointBA(obs, mats, dlt);
                if (ba == null) continue;
                total++;
                sumD += Math.sqrt((dlt[0] - gt[0]) * (dlt[0] - gt[0]) + (dlt[1] - gt[1]) * (dlt[1] - gt[1]) +
                                  (dlt[2] - gt[2]) * (dlt[2] - gt[2]));
                sumB += Math.sqrt((ba[0] - gt[0]) * (ba[0] - gt[0]) + (ba[1] - gt[1]) * (ba[1] - gt[1]) +
                                  (ba[2] - gt[2]) * (ba[2] - gt[2]));
            }
            assertTrue(total > 1000, 'trials ran (' + total + ')');
            assertLessThan(sumB / total, sumD / total,
                'BA mean 3D error (' + (sumB / total).toFixed(4) + ') should beat DLT (' +
                (sumD / total).toFixed(4) + ') under outliers');
        });
    });
})();
