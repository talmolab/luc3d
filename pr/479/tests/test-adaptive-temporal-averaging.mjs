/**
 * test-adaptive-temporal-averaging.mjs — pose/adaptive-temporal-averaging.js,
 * the math behind Temporal Smoothing's adaptive method.
 *
 *   - Same answer as the reference implementation, ata3d's `smooth` (olinesn/ata3d):
 *     outputs and window lengths on a fixture with still, steady and fast
 *     series, a jump, a gap and single holes, at three gates
 *     (tests/fixtures/ata3d/reference.json, made by make_reference.py beside it).
 *   - A slice that holds [t - hmax, t + hmax] gives t's value bit for bit
 *     (what This frame relies on); a window of 1 keeps the input exactly;
 *     scaling the points by c and covariances by c^2 scales the output by c.
 *   - Synthetic behaviour: a still point's noise falls a lot, steady motion is
 *     not shifted (symmetric windows), a jump far outside the gate ends windows.
 *   - The point covariance equals s^2 (sum J^T J)^-1 with J taken numerically
 *     through the camera's own projection (distortion included); the
 *     reprojection threshold drops the worst view as the solve does; more
 *     views shrink it; fewer than 2 give none.
 *   - The per-node sigma from second differences recovers white noise and
 *     ignores constant velocity.
 *
 * Run:  node tests/test-adaptive-temporal-averaging.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ATA_DEFAULT_K, ATA_DEFAULT_HMAX, COV_STRIDE, DLT_COV_SIGMA0_PX, DLT_COV_PSEUDO_DOF,
    invertSym3Into, ataSmoothSeriesInto, dltPointCovarianceInto, secondDifferenceSigma,
} from '../pose/adaptive-temporal-averaging.js';
import { reprojectPointCamera } from '../pose/triangulation-core.js';
import { Camera } from '../pose/pose-data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
    if (cond) passed++;
    else { failed++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function group(name) { console.log('\n• ' + name); }

// Deterministic noise.
let _s = 12345;
const rnd = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

function isoCov(T, sigma) {
    const c = new Float64Array(T * COV_STRIDE);
    for (let t = 0; t < T; t++) { c[t * 6] = sigma * sigma; c[t * 6 + 3] = sigma * sigma; c[t * 6 + 5] = sigma * sigma; }
    return c;
}
function run(x, cov, T, opts) {
    const out = new Float64Array(T * 3), half = new Int32Array(T);
    ataSmoothSeriesInto(x, cov, T, opts, out, half);
    return { out, half };
}

// ---------------------------------------------------------------------------
group('defaults');
{
    ok(ATA_DEFAULT_K === 3 && ATA_DEFAULT_HMAX === 15, 'k 3, hmax 15 (ata3d\'s defaults)');
    ok(DLT_COV_SIGMA0_PX === 2 && DLT_COV_PSEUDO_DOF === 4, 'covariance prior: 2 px with 4 pseudo-degrees of freedom');
}

// ---------------------------------------------------------------------------
group('invertSym3Into');
{
    const c = Float64Array.from([4, 1, 0.5, 3, -0.2, 2]);
    const inv = new Float64Array(6);
    ok(invertSym3Into(c, 0, inv, 0), 'a positive-definite matrix inverts');
    const full = (p) => [[p[0], p[1], p[2]], [p[1], p[3], p[4]], [p[2], p[4], p[5]]];
    const A = full(c), B = full(inv);
    let worst = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j];
        const d = Math.abs(s - (i === j ? 1 : 0));
        if (!(d <= worst)) worst = d;
    }
    ok(worst < 1e-12, `A * inv(A) = I (worst ${worst})`);
    ok(!invertSym3Into(Float64Array.from([1, 0, 0, 0, 0, 1]), 0, inv, 0), 'a singular matrix is refused');
    ok(!invertSym3Into(Float64Array.from([NaN, 0, 0, 1, 0, 1]), 0, inv, 0), 'a NaN matrix is refused');
}

// ---------------------------------------------------------------------------
group('same answer as ata3d (the reference implementation)');
{
    const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ata3d', 'reference.json'), 'utf8'));
    const T = ref.frames;
    for (const c of ref.cases) {
        for (let s = 0; s < ref.series.length; s++) {
            const x = Float64Array.from(ref.series[s].x, v => (v == null ? NaN : v));
            const cov = Float64Array.from(ref.series[s].cov);
            const { out, half } = run(x, cov, T, { k: c.k, hmax: c.hmax });
            // ata3d solves (P + ridge) x = P x_t on a 1-frame window too, which
            // moves the sample by ~1e-9 of its distance from the origin times
            // the covariance's condition number; the port keeps it exactly.
            let worst = 0, worst1 = 0, badWin = 0, badNan = 0, kept = 0, ones = 0;
            for (let t = 0; t < T; t++) {
                const w = half[t] < 0 ? 0 : 1 + 2 * half[t];
                if (w !== c.window[s][t]) badWin++;
                if (w === 1) {
                    ones++;
                    if (out[t * 3] === x[t * 3] && out[t * 3 + 1] === x[t * 3 + 1] && out[t * 3 + 2] === x[t * 3 + 2]) kept++;
                }
                for (let a = 0; a < 3; a++) {
                    const e = c.x[s][t * 3 + a];
                    const got = out[t * 3 + a];
                    if (e == null) { if (!Number.isNaN(got)) badNan++; continue; }
                    const d = Math.abs(got - e);
                    if (w === 1) { if (!(d <= worst1)) worst1 = d; }
                    else if (!(d <= worst)) worst = d;
                }
            }
            const tag = `k ${c.k}, hmax ${c.hmax}, series ${s}`;
            ok(badWin === 0, `${tag}: every window length equals ata3d's (${badWin} differ)`);
            ok(badNan === 0, `${tag}: missing samples stay missing`);
            ok(worst < 1e-9, `${tag}: windows over 1 frame within 1e-9 mm of ata3d's (worst ${worst.toExponential(2)})`);
            ok(kept === ones && worst1 < 1e-5, `${tag}: ${ones} 1-frame windows keep their sample (ata3d: within ${worst1.toExponential(1)} mm)`);
        }
    }
}

// ---------------------------------------------------------------------------
group('a slice around t gives the whole series\' value at t, bit for bit');
{
    const T = 400, hmax = 15;
    const x = new Float64Array(T * 3), cov = new Float64Array(T * 6);
    for (let t = 0; t < T; t++) {
        const pos = t < 200 ? 0 : (t - 200) * 1.5;         // still, then steady
        x[t * 3] = pos + gauss(); x[t * 3 + 1] = gauss(); x[t * 3 + 2] = 5 * Math.sin(t / 7) + gauss();
        const a = 0.5 + rnd(), b = 0.3 * (rnd() - 0.5);
        cov.set([a, b, 0, a + 0.2, 0, 1.2], t * 6);
    }
    for (let t = 120; t < 124; t++) x[t * 3] = NaN;        // a gap
    const whole = run(x, cov, T, { k: 3, hmax });
    let mism = 0;
    for (const t of [0, 1, 5, 15, 16, 119, 124, 125, 150, 199, 200, 201, 300, 384, 385, 398, 399]) {
        const lo = Math.max(0, t - hmax), hi = Math.min(T, t + hmax + 1);
        const xs = x.slice(lo * 3, hi * 3), cs = cov.slice(lo * 6, hi * 6);
        const part = run(xs, cs, hi - lo, { k: 3, hmax, from: t - lo, to: t - lo + 1 });
        for (let a = 0; a < 3; a++) {
            const p = part.out[(t - lo) * 3 + a], w = whole.out[t * 3 + a];
            if (!(p === w || (Number.isNaN(p) && Number.isNaN(w)))) mism++;
        }
        if (part.half[t - lo] !== whole.half[t]) mism++;
    }
    ok(mism === 0, `17 frames (edges, gap edges, still and moving): slice == whole (${mism} differ)`);
    // from/to restricts what is computed: the rest of `out` is left as it was.
    const out = new Float64Array(T * 3).fill(7);
    ataSmoothSeriesInto(x, cov, T, { from: 50, to: 60 }, out, null);
    ok(out[49 * 3] === 7 && out[60 * 3] === 7 && out[55 * 3] !== 7, 'only [from, to) is written');
}

// ---------------------------------------------------------------------------
group('a window of 1 keeps the sample exactly; units do not matter');
{
    const T = 60;
    const x = new Float64Array(T * 3);
    for (let t = 0; t < T; t++) { x[t * 3] = 40 * t + 0.3 * gauss(); x[t * 3 + 1] = 0.3 * gauss(); x[t * 3 + 2] = 0.3 * gauss(); }
    const r = run(x, isoCov(T, 0.3), T, { k: 3, hmax: 15 });
    let ones = 0, exact = 0;
    for (let t = 0; t < T; t++) {
        if (r.half[t] !== 0) continue;
        ones++;
        if (r.out[t * 3] === x[t * 3] && r.out[t * 3 + 1] === x[t * 3 + 1] && r.out[t * 3 + 2] === x[t * 3 + 2]) exact++;
    }
    ok(ones === T && exact === T, `40 mm/frame at 0.3 mm noise: every window is 1 and keeps its sample (${exact}/${ones}/${T})`);

    const T2 = 200, c = 1000;
    const y = new Float64Array(T2 * 3);
    for (let i = 0; i < y.length; i++) y[i] = gauss();
    const cov = new Float64Array(T2 * 6);
    for (let t = 0; t < T2; t++) cov.set([1 + rnd(), 0.2, 0.1, 1 + rnd(), -0.1, 1 + rnd()], t * 6);
    const a = run(y, cov, T2, {});
    const yc = y.map(v => v * c), covc = cov.map(v => v * c * c);
    const b = run(yc, covc, T2, {});
    let worst = 0, winDiff = 0;
    for (let i = 0; i < a.out.length; i++) {
        const d = Math.abs(b.out[i] / c - a.out[i]);
        if (!(d <= worst)) worst = d;
    }
    for (let t = 0; t < T2; t++) if (a.half[t] !== b.half[t]) winDiff++;
    ok(winDiff === 0 && worst < 1e-9, `points x1000, covariances x1000^2: same windows, output x1000 (worst ${worst.toExponential(2)})`);
}

// ---------------------------------------------------------------------------
group('synthetic: still, steady, a jump');
{
    const T = 3000, sigma = 1;
    const err = (out, truth, t0, t1) => {
        let s = 0, n = 0;
        for (let t = t0; t < t1; t++) {
            let d2 = 0;
            for (let a = 0; a < 3; a++) { const d = out[t * 3 + a] - truth(t, a); d2 += d * d; }
            s += Math.sqrt(d2); n++;
        }
        return s / n;
    };
    // Still point.
    const still = (t, a) => [10, -4, 50][a];
    const xs = new Float64Array(T * 3);
    for (let t = 0; t < T; t++) for (let a = 0; a < 3; a++) xs[t * 3 + a] = still(t, a) + sigma * gauss();
    const rs = run(xs, isoCov(T, sigma), T, {});
    const rawS = err(xs, still, 15, T - 15), ataS = err(rs.out, still, 15, T - 15);
    ok(ataS < 0.4 * rawS, `still point: mean 3D error ${rawS.toFixed(2)} -> ${ataS.toFixed(2)} mm (ata3d README: 1.60 -> 0.51)`);

    // Steady 3 mm/frame: no shift along the motion.
    const steady = (t, a) => (a === 0 ? 3 * t : 0);
    const xm = new Float64Array(T * 3);
    for (let t = 0; t < T; t++) for (let a = 0; a < 3; a++) xm[t * 3 + a] = steady(t, a) + sigma * gauss();
    const rm = run(xm, isoCov(T, sigma), T, {});
    let bias = 0;
    for (let t = 15; t < T - 15; t++) bias += rm.out[t * 3] - steady(t, 0);
    bias /= (T - 30);
    const rawM = err(xm, steady, 15, T - 15), ataM = err(rm.out, steady, 15, T - 15);
    ok(Math.abs(bias) < 0.05, `steady 3 mm/frame: no shift along the motion (mean ${bias.toFixed(3)} mm)`);
    ok(ataM < rawM, `steady 3 mm/frame: mean error ${rawM.toFixed(2)} -> ${ataM.toFixed(2)} mm (ata3d README: 1.60 -> 1.42)`);

    // A 12-sigma jump (a swap) at 500: no window crosses it.
    const xj = new Float64Array(1000 * 3);
    for (let t = 0; t < 1000; t++) for (let a = 0; a < 3; a++) xj[t * 3 + a] = (t >= 500 && a === 0 ? 12 : 0) + sigma * gauss();
    const rj = run(xj, isoCov(1000, sigma), 1000, {});
    let crossing = 0;
    for (let t = 0; t < 1000; t++) if (t - rj.half[t] < 500 && t + rj.half[t] >= 500 && rj.half[t] > 0) crossing++;
    ok(crossing === 0, `a 12-sigma jump ends every window (${crossing} cross it)`);
    // A missing sample ends windows too.
    xj[700 * 3 + 1] = NaN;
    const rg = run(xj, isoCov(1000, sigma), 1000, {});
    let overHole = 0;
    for (let t = 0; t < 1000; t++) if (t !== 700 && rg.half[t] > 0 && t - rg.half[t] <= 700 && t + rg.half[t] >= 700) overHole++;
    ok(Number.isNaN(rg.out[700 * 3]) && rg.half[700] === -1 && overHole === 0, 'a missing sample stays missing and no window reaches over it');
}

// ---------------------------------------------------------------------------
group('dltPointCovarianceInto: s^2 (sum J^T J)^-1, J through the camera\'s own projection');
{
    // Five cameras around the origin, 1280x1024, f 1000, real barrel distortion.
    const K = [[1000, 0, 640], [0, 1000, 512], [0, 0, 1]];
    const cams = [
        new Camera('a', K, [-0.2, 0.05, 0.001, -0.001, 0], [0, 0, 0], [0, 0, 600], [1280, 1024]),
        new Camera('b', K, [-0.25, 0, 0, 0, 0], [0, 0.6, 0], [0, 0, 650], [1280, 1024]),
        new Camera('c', K, [-0.1, 0, 0, 0, 0], [0.5, 0, 0], [0, 0, 620], [1280, 1024]),
        new Camera('d', K, [0, 0, 0, 0, 0], [-0.4, -0.5, 0], [0, 0, 700], [1280, 1024]),
        new Camera('e', K, [-0.3, 0.02, 0, 0, 0], [0.3, -0.7, 0.1], [0, 0, 580], [1280, 1024]),
    ];
    const X = [12, -8, 20];
    const offs = [[0.8, -0.3], [-1.1, 0.4], [0.2, 1.5], [-0.6, -0.9], [1.3, 0.7]];
    const us = new Float64Array(5), vs = new Float64Array(5);
    cams.forEach((c, i) => { const p = reprojectPointCamera(X, c); us[i] = p[0] + offs[i][0]; vs[i] = p[1] + offs[i][1]; });

    const reference = (n) => {
        const info = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        let rss = 0;
        for (let i = 0; i < n; i++) {
            const J = [[], []];
            for (let j = 0; j < 3; j++) {
                const e = 1e-4, Xp = X.slice(), Xm = X.slice();
                Xp[j] += e; Xm[j] -= e;
                const pp = reprojectPointCamera(Xp, cams[i]), pm = reprojectPointCamera(Xm, cams[i]);
                J[0][j] = (pp[0] - pm[0]) / (2 * e); J[1][j] = (pp[1] - pm[1]) / (2 * e);
            }
            for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) info[a][b] += J[0][a] * J[0][b] + J[1][a] * J[1][b];
            const p = reprojectPointCamera(X, cams[i]);
            rss += (p[0] - us[i]) ** 2 + (p[1] - vs[i]) ** 2;
        }
        const s2 = (4 * 4 + rss) / (4 + Math.max(2 * n - 3, 0));
        const packed = Float64Array.from([info[0][0] + 1e-9, info[0][1], info[0][2], info[1][1] + 1e-9, info[1][2], info[2][2] + 1e-9]);
        const inv = new Float64Array(6);
        invertSym3Into(packed, 0, inv, 0);
        return { cov: inv.map(v => v * s2), s: Math.sqrt(s2) };
    };
    for (const n of [2, 3, 5]) {
        const out = new Float64Array(6);
        const s = dltPointCovarianceInto(X, cams, us, vs, n, {}, out, 0);
        const ref = reference(n);
        let worst = 0;
        for (let i = 0; i < 6; i++) {
            const d = Math.abs(out[i] - ref.cov[i]) / Math.max(1e-12, Math.abs(ref.cov[0]));
            if (!(d <= worst)) worst = d;
        }
        ok(worst < 1e-5 && Math.abs(s - ref.s) < 1e-9, `${n} views: matches the numerical reference (worst ${worst.toExponential(2)} of var x; s ${s.toFixed(4)} px)`);
    }
    const tr = (n) => { const o = new Float64Array(6); dltPointCovarianceInto(X, cams, us, vs, n, {}, o, 0); return o[0] + o[3] + o[5]; };
    ok(tr(5) < tr(3) && tr(3) < tr(2), `more views, smaller covariance (trace ${tr(2).toFixed(4)} > ${tr(3).toFixed(4)} > ${tr(5).toFixed(4)} mm^2)`);
    const none = new Float64Array(6).fill(-1);
    ok(Number.isNaN(dltPointCovarianceInto(X, cams, us, vs, 1, {}, none, 0)) && none[0] === -1, 'one view: no covariance, out untouched');

    // A 40 px outlier in view 4: with a 15 px threshold it is dropped (as the solve drops it).
    const us2 = us.slice(); us2[4] += 40;
    const withOutlier = new Float64Array(6), dropped = new Float64Array(6), firstFour = new Float64Array(6);
    const sOut = dltPointCovarianceInto(X, cams, us2, vs, 5, {}, withOutlier, 0);
    const sDrop = dltPointCovarianceInto(X, cams, us2, vs, 5, { reprojErrorThreshold: 15 }, dropped, 0);
    dltPointCovarianceInto(X, cams, us, vs, 4, {}, firstFour, 0);
    ok(sOut > 10, `the outlier inflates the 2D noise estimate (s ${sOut.toFixed(1)} px)`);
    ok(Array.from(dropped).every((v, i) => v === firstFour[i]) && sDrop < 2,
        `threshold 15 px drops it: the covariance of the other 4 views (s ${sDrop.toFixed(2)} px)`);
    const keep2 = new Float64Array(6), two = new Float64Array(6);
    const us3 = us.slice(); us3[1] += 50;
    dltPointCovarianceInto(X, cams, us3, vs, 2, { reprojErrorThreshold: 15 }, keep2, 0);
    ok(keep2[0] > 0, 'never below 2 views: a 2-view point keeps both');
    dltPointCovarianceInto(X, cams, us3, vs, 2, {}, two, 0);
    ok(Array.from(keep2).every((v, i) => v === two[i]), '(the same covariance as without the threshold)');
}

// ---------------------------------------------------------------------------
group('secondDifferenceSigma');
{
    const T = 5000;
    const x = new Float64Array(T * 3);
    for (let t = 0; t < T; t++) { x[t * 3] = 2 * t + 1.5 * gauss(); x[t * 3 + 1] = -t + 1.5 * gauss(); x[t * 3 + 2] = 1.5 * gauss(); }
    const s = secondDifferenceSigma(x, T);
    ok(Math.abs(s - 1.5) < 0.1, `white noise of sigma 1.5 under constant velocity: ${s.toFixed(3)}`);
    x[100 * 3] = NaN;
    ok(Math.abs(secondDifferenceSigma(x, T) - s) < 0.01, 'a hole only drops the triples it is in');
    ok(Number.isNaN(secondDifferenceSigma(x.slice(0, 12), 4)), 'fewer than 5 triples: NaN');
    ok(Number.isNaN(secondDifferenceSigma(new Float64Array(30), 10)), 'all differences 0: NaN (no usable sigma)');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
    console.error('\nFailures:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
