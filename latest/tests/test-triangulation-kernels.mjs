/**
 * test-triangulation-kernels.mjs — the allocation-free triangulation kernels
 * must be BIT-IDENTICAL to the code they replaced.
 *
 * Track All and Triangulate All spent most of their time allocating: the DLT
 * solve (row arrays -> matTranspose -> matMul -> jacobiEigen, four arrays per
 * Givens rotation), the per-call camera-centre / pseudo-inverse recomputation in
 * back-projection, and the refinement inner loop's per-projection Jacobian
 * arrays. The replacements keep every floating-point operation and its order,
 * so results must match exactly — not approximately: a last-bit difference in a
 * 3D point can flip a tracker assignment and change identities downstream. Each
 * comparison here uses Object.is per value (so NaN, -0 and +0 count).
 *
 * ONE deliberate exception: the DLT's 4x4 null-vector solve. Its M = AᵀA is
 * still bit-identical, and so is the Jacobi kernel, which stays as the
 * fallback; but the solve itself is now inverse iteration (5x faster — it was
 * 23% of Track All), which agrees with Jacobi to well under a nanometre rather
 * than bit for bit. Those groups test the claims that change makes instead:
 * agreement, a null vector no worse than Jacobi's, rotation invariance, and the
 * fallback. Identities were checked unchanged by a before/after Track All on
 * real recordings (see the PR that made the change).
 *
 * Run: node tests/test-triangulation-kernels.mjs
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) { if (cond) passed++; else { failed++; failures.push(msg); console.error('  ✗ ' + msg); } }
function group(name) { console.log('\n• ' + name); }
function sameArr(a, b) {
    if (a == null || b == null) return a === b;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
}

globalThis.__BENCH = { nodeWeights: {}, thresholds: {} };
globalThis.document = { getElementById: () => null };
globalThis.window = globalThis;
register(pathToFileURL(path.join(ROOT, 'scripts', 'bench', 'hooks.mjs')).href);
const pd = await import(pathToFileURL(path.join(ROOT, 'pose', 'pose-data.js')).href);
const tri = await import(pathToFileURL(path.join(ROOT, 'pose', 'triangulation.js')).href);
const K = tri.__triangulationKernelsForTest;

// Deterministic PRNG so failures reproduce.
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const rr = (a, b) => a + (b - a) * rnd();

function randCamera(i, distorted) {
    const f = rr(500, 1500);
    const Km = [[f, 0, rr(300, 700)], [0, f * rr(0.95, 1.05), rr(200, 550)], [0, 0, 1]];
    const dist = distorted ? [rr(-0.4, 0.2), rr(-0.2, 0.2), rr(-0.01, 0.01), rr(-0.01, 0.01), rr(-0.1, 0.1)] : [0, 0, 0, 0, 0];
    return new pd.Camera('c' + i, Km, dist, [rr(-0.6, 0.6), rr(-0.6, 0.6), rr(-0.6, 0.6)],
        [rr(-200, 200), rr(-200, 200), rr(800, 1500)], [1280, 1024]);
}

// Random DLT systems, as built for the original `svd3x4(A)`: 2–8 views of a point.
//   kind 'clean'        one point, ±3 px noise — what triangulation normally sees
//   kind 'wild'         one point, ±300 px in x
//   kind 'inconsistent' a DIFFERENT point in every view
// In the last two the two smallest eigenvalues of M are close, so the null
// vector is barely determined and inverse iteration converges slowly or hands
// over to Jacobi.
function dltSystems(count) {
    const out = [];
    for (let trial = 0; trial < count; trial++) {
        const kind = trial % 5 === 0 ? 'wild' : trial % 5 === 1 ? 'inconsistent' : 'clean';
        const nObs = 2 + Math.floor(rnd() * 7);              // 2..8 views
        const cams = Array.from({ length: nObs }, (_, i) => randCamera(i, false));
        const xs = [], ys = [], Ps = [];
        let X = [rr(-300, 300), rr(-300, 300), rr(-100, 300)];
        for (let i = 0; i < nObs; i++) {
            const P = cams[i].projectionMatrix;
            if (kind === 'inconsistent') X = [rr(-300, 300), rr(-300, 300), rr(-100, 300)];
            const w = P[2][0] * X[0] + P[2][1] * X[1] + P[2][2] * X[2] + P[2][3];
            xs.push((P[0][0] * X[0] + P[0][1] * X[1] + P[0][2] * X[2] + P[0][3]) / w + rr(-3, 3) * (kind === 'wild' ? 100 : 1));
            ys.push((P[1][0] * X[0] + P[1][1] * X[1] + P[1][2] * X[2] + P[1][3]) / w + rr(-3, 3));
            Ps.push(P);
        }
        const A = [];
        for (let i = 0; i < nObs; i++) {
            const P = Ps[i], x = xs[i], y = ys[i];
            A.push([x * P[2][0] - P[0][0], x * P[2][1] - P[0][1], x * P[2][2] - P[0][2], x * P[2][3] - P[0][3]]);
            A.push([y * P[2][0] - P[1][0], y * P[2][1] - P[1][1], y * P[2][2] - P[1][2], y * P[2][3] - P[1][3]]);
        }
        out.push({ kind, X, xs, ys, Ps, nObs, A });
    }
    return out;
}
const SYSTEMS = dltSystems(3000);
const flatOf = (rows) => Float64Array.from(rows.flat());
const rayleigh = (M, v) => { let r = 0; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) r += v[i] * M[i * 4 + j] * v[j]; return r; };
const toXYZ = (h) => [h[0] / h[3], h[1] / h[3], h[2] / h[3]];
const dist3 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

group('DLT normal matrix M = AᵀA == the one svd3x4 builds, bit for bit');
{
    let bad = 0;
    for (const s of SYSTEMS) {
        const ref = flatOf(K.matMul(K.matTranspose(s.A), s.A));
        const got = K.dltNormalMatrixFlat(s.xs, s.ys, s.Ps, s.nObs);
        if (!sameArr(ref, got)) { bad++; if (bad <= 3) console.error('   mismatch', ref, got); }
    }
    ok(bad === 0, `${SYSTEMS.length} random 2–8-view systems: ${bad} differ (the upper-triangle sums mirrored are exact)`);
}

group('Jacobi kernel (the fallback) == solveSmallestEigenvector4x4, bit for bit');
{
    let bad = 0;
    for (const s of SYSTEMS) {
        const M = flatOf(K.matMul(K.matTranspose(s.A), s.A));
        const ref = K.solveSmallestEigenvector4x4(K.matMul(K.matTranspose(s.A), s.A));
        const got = Array.from(K.smallestEigvec4Flat(M, new Float64Array(4)));
        if (!sameArr(ref, got)) bad++;
    }
    ok(bad === 0, `${SYSTEMS.length} systems: ${bad} differ`);
}

group('DLT kernel (inverse iteration) agrees with svd3x4 (Jacobi)');
{
    // Clean systems: the same 3D point to well under a nanometre. Wild and
    // inconsistent ones have no well-determined point, so the claim there is the
    // one that matters: a null vector at least as good as Jacobi's — Rayleigh
    // quotient vᵀMv, which the true smallest eigenvector minimizes, no larger.
    let maxClean = 0, nClean = 0, worse = 0, nonUnit = 0;
    for (const s of SYSTEMS) {
        const M = flatOf(K.matMul(K.matTranspose(s.A), s.A));
        const ref = K.svd3x4(s.A);
        const got = Array.from(K.dltHomogeneousFlat(s.xs, s.ys, s.Ps, s.nObs, new Float64Array(4)));
        if (!(Math.abs(Math.hypot(...got) - 1) <= 1e-12)) nonUnit++;   // a NaN result counts
        if (s.kind === 'clean') { nClean++; maxClean = Math.max(maxClean, dist3(toXYZ(ref), toXYZ(got))); }
        const tr = M[0] + M[5] + M[10] + M[15];
        if (rayleigh(M, got) > rayleigh(M, ref) * (1 + 1e-9) + 1e-15 * tr) worse++;
    }
    ok(maxClean < 1e-6, `${nClean} clean systems: largest 3D difference ${maxClean.toExponential(2)} mm (< 1e-6)`);
    ok(worse === 0, `${SYSTEMS.length} systems: ${worse} with a worse null vector than Jacobi's`);
    ok(nonUnit === 0, `${SYSTEMS.length} systems: ${nonUnit} results not unit length`);
}

group('inverse iteration: rotating the world rotates the answer (the frame-invariance argument)');
{
    // A rigid change of world frame turns M into QᵀMQ with Q = diag(R, 1) (see
    // triangulatePointDLT). The null vector must turn with it.
    const ax = [0.48, 0.6, 0.64], an = 2.84, c = Math.cos(an), sn = Math.sin(an), C = 1 - c;
    const R = [[c + ax[0] * ax[0] * C, ax[0] * ax[1] * C - ax[2] * sn, ax[0] * ax[2] * C + ax[1] * sn],
        [ax[1] * ax[0] * C + ax[2] * sn, c + ax[1] * ax[1] * C, ax[1] * ax[2] * C - ax[0] * sn],
        [ax[2] * ax[0] * C - ax[1] * sn, ax[2] * ax[1] * C + ax[0] * sn, c + ax[2] * ax[2] * C]];
    let worst = 0, n = 0;
    for (const s of SYSTEMS) {
        if (s.kind !== 'clean') continue;
        const M = K.dltNormalMatrixFlat(s.xs, s.ys, s.Ps, s.nObs).slice();
        const v = Array.from(K.smallestEigvec4Inverse(M, new Float64Array(4)));
        const Mq = new Float64Array(16);
        const Q = (i, j) => (i < 3 && j < 3 ? R[i][j] : (i === j ? 1 : 0));
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) for (let l = 0; l < 4; l++) sum += Q(k, i) * M[k * 4 + l] * Q(l, j);
            Mq[i * 4 + j] = sum;
        }
        const vq = K.smallestEigvec4Inverse(Mq, new Float64Array(4));
        const back = [0, 1, 2, 3].map(i => Q(i, 0) * vq[0] + Q(i, 1) * vq[1] + Q(i, 2) * vq[2] + Q(i, 3) * vq[3]);
        worst = Math.max(worst, dist3(toXYZ(v), toXYZ(back)));
        n++;
    }
    ok(worst < 1e-6, `${n} clean systems: largest drift ${worst.toExponential(2)} mm (< 1e-6)`);
}

group('inverse iteration: degenerate inputs are Jacobi\'s answer (the fallback), or a true null vector');
{
    const jac = (M) => Array.from(K.smallestEigvec4Flat(Float64Array.from(M), new Float64Array(4)));
    const inv = (M) => Array.from(K.smallestEigvec4Inverse(Float64Array.from(M), new Float64Array(4)));
    const zero = new Array(16).fill(0);
    ok(sameArr(inv(zero), jac(zero)), 'all-zero M (no observations) -> the Jacobi fallback');
    const withNaN = Array.from(flatOf(K.matMul(K.matTranspose(SYSTEMS[2].A), SYSTEMS[2].A))); withNaN[5] = NaN;
    ok(sameArr(inv(withNaN), jac(withNaN)), 'NaN in M -> the Jacobi fallback');
    const withInf = withNaN.slice(); withInf[5] = Infinity;
    ok(sameArr(inv(withInf), jac(withInf)), 'Infinity in M -> the Jacobi fallback');
    // Noise-free observations of one point: A has an exact null vector (rank 3) and
    // M is singular, which a plain Cholesky cannot factor — the shift must make it.
    const cams = [0, 1, 2].map(i => randCamera(i + 20, false));
    const X = [12, -40, 150], xs = [], ys = [], Ps = [];
    for (const cam of cams) {
        const P = cam.projectionMatrix, w = P[2][0] * X[0] + P[2][1] * X[1] + P[2][2] * X[2] + P[2][3];
        xs.push((P[0][0] * X[0] + P[0][1] * X[1] + P[0][2] * X[2] + P[0][3]) / w);
        ys.push((P[1][0] * X[0] + P[1][1] * X[1] + P[1][2] * X[2] + P[1][3]) / w);
        Ps.push(P);
    }
    const exact = toXYZ(K.dltHomogeneousFlat(xs, ys, Ps, 3, new Float64Array(4)));
    ok(dist3(exact, X) < 1e-6, `noise-free 3-view point recovered to ${dist3(exact, X).toExponential(2)} mm`);
    // Rank 2 (one view seen twice: the null space is a whole ray) — any unit vector in it will do.
    const twice = K.dltHomogeneousFlat([xs[0], xs[0]], [ys[0], ys[0]], [Ps[0], Ps[0]], 2, new Float64Array(4));
    const M2 = K.dltNormalMatrixFlat([xs[0], xs[0]], [ys[0], ys[0]], [Ps[0], Ps[0]], 2).slice();
    const tr2 = M2[0] + M2[5] + M2[10] + M2[15];
    ok(Math.abs(Math.hypot(...twice) - 1) < 1e-12 && rayleigh(M2, twice) <= 1e-12 * tr2, 'one view twice (rank 2): a unit null vector');
}

group('triangulatePointDLT end to end (null views, degenerate inputs)');
{
    const cams = [0, 1, 2, 3].map(i => randCamera(i, false));
    const Ps = cams.map(c => c.projectionMatrix);
    const got = tri.triangulatePointDLT([[640, 512], null, [600, 500], [700, 480]], Ps);
    ok(Array.isArray(got) && got.length === 3 && got.every(Number.isFinite), 'returns a finite [X,Y,Z] with a null view');
    ok(tri.triangulatePointDLT([[640, 512], null, null, null], Ps) === null, '< 2 views -> null');
    // Same answer twice in a row: no state leaks between calls through the scratch buffers.
    const a = tri.triangulatePointDLT([[640, 512], [610, 505], null, [700, 480]], Ps);
    tri.triangulatePointDLT([[1, 2], [3, 4], [5, 6], [7, 8]], Ps);
    const b = tri.triangulatePointDLT([[640, 512], [610, 505], null, [700, 480]], Ps);
    ok(sameArr(a, b), 'repeat calls are independent of what ran in between');
}

group('refinement projection: scratch version == original, bit for bit');
{
    let bad = 0, n = 0, nullsAgree = true;
    for (let trial = 0; trial < 4000; trial++) {
        const cam = randCamera(trial, trial % 4 !== 0);     // 1 in 4 distortion-free
        const pt = [rr(-400, 400), rr(-400, 400), rr(-1600, 400)];
        const ref = K.projectAndJacobianCamera(pt, cam);
        const out = { u: 0, v: 0, Ju: new Float64Array(3), Jv: new Float64Array(3) };
        const got = K._projectAndJacobianCameraInto(pt, cam, out);
        n++;
        if ((ref == null) !== (got == null)) { nullsAgree = false; continue; }
        if (ref == null) continue;
        if (!(Object.is(ref.u, got.u) && Object.is(ref.v, got.v) && sameArr(ref.Ju, got.Ju) && sameArr(ref.Jv, got.Jv))) bad++;
        const ref2 = K.projectAndJacobian(pt, cam.projectionMatrix);
        const got2 = K._projectAndJacobianInto(pt, cam.projectionMatrix, out);
        if (ref2 && !(Object.is(ref2.u, got2.u) && sameArr(ref2.Ju, got2.Ju) && sameArr(ref2.Jv, got2.Jv))) bad++;
    }
    ok(nullsAgree, 'degenerate (behind-camera / on-plane) cases agree');
    ok(bad === 0, `${n} random points × cameras (distorted and not): ${bad} differ`);
}

group('triangulatePointBA end to end is deterministic and refines');
{
    const cams = [0, 1, 2, 3, 4].map(i => randCamera(i, true));
    const Ps = cams.map(c => c.projectionMatrix);
    const X = [20, -30, 100];
    const obs = cams.map(c => { const p = c.distortPoint(c.project(X)); return [p[0] + rr(-2, 2), p[1] + rr(-2, 2)]; });
    const r1 = tri.triangulatePointBA(obs, Ps, [25, -25, 110], { cameras: cams });
    const r2 = tri.triangulatePointBA(obs, Ps, [25, -25, 110], { cameras: cams });
    ok(sameArr(r1, r2), 'same inputs -> same bits (no scratch-state leakage)');
    ok(Math.hypot(r1[0] - X[0], r1[1] - X[1], r1[2] - X[2]) < 5, 'converges near the true point');
}

group('inverse iteration, unrolled into locals == the loop form it replaced, bit for bit');
{
    // The loop form, verbatim from before the unrolling (Cholesky and both
    // triangular solves through 16- and 4-entry scratch arrays).
    const L = new Float64Array(16), y = new Float64Array(4);
    function loopForm(M, out) {
        const tr = M[0] + M[5] + M[10] + M[15];
        if (!(tr > 0) || tr === Infinity) return K.smallestEigvec4Flat(M, out);
        const shift = tr * 1e-15;
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j <= i; j++) {
                let sum = M[i * 4 + j];
                if (i === j) sum += shift;
                for (let k = 0; k < j; k++) sum -= L[i * 4 + k] * L[j * 4 + k];
                if (i === j) {
                    if (!(sum > 0)) return K.smallestEigvec4Flat(M, out);
                    L[i * 5] = Math.sqrt(sum);
                } else {
                    L[i * 4 + j] = sum / L[j * 5];
                }
            }
        }
        let v0 = 0.5, v1 = 0.5, v2 = 0.5, v3 = 0.5;
        for (let it = 0; it < 50; it++) {
            y[0] = v0 / L[0];
            y[1] = (v1 - L[4] * y[0]) / L[5];
            y[2] = (v2 - L[8] * y[0] - L[9] * y[1]) / L[10];
            y[3] = (v3 - L[12] * y[0] - L[13] * y[1] - L[14] * y[2]) / L[15];
            out[3] = y[3] / L[15];
            out[2] = (y[2] - L[14] * out[3]) / L[10];
            out[1] = (y[1] - L[9] * out[2] - L[13] * out[3]) / L[5];
            out[0] = (y[0] - L[4] * out[1] - L[8] * out[2] - L[12] * out[3]) / L[0];
            const norm = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2] + out[3] * out[3]);
            if (!(norm > 0) || norm === Infinity) return K.smallestEigvec4Flat(M, out);
            const a = out[0] / norm, b = out[1] / norm, c = out[2] / norm, d = out[3] / norm;
            const moved = Math.max(Math.abs(a - v0), Math.abs(b - v1), Math.abs(c - v2), Math.abs(d - v3));
            v0 = a; v1 = b; v2 = c; v3 = d;
            if (moved <= 1e-15) { out[0] = v0; out[1] = v1; out[2] = v2; out[3] = v3; return out; }
        }
        return K.smallestEigvec4Flat(M, out);
    }
    const Ms = SYSTEMS.map((s) => flatOf(K.matMul(K.matTranspose(s.A), s.A)));
    // and matrices that take each fallback: indefinite (a failed pivot at
    // every position), zero, NaN, Infinity
    for (let p = 0; p < 4; p++) {
        const M = Ms[p].slice(); M[p * 5] = -M[p * 5] - 1; Ms.push(M);
        const M2 = Ms[p + 4].slice(); M2[p * 5] = 1e-300; Ms.push(M2);
    }
    Ms.push(new Float64Array(16), Float64Array.from(Ms[0], (x, i) => i === 6 ? NaN : x),
        Float64Array.from(Ms[0], (x, i) => i === 15 ? Infinity : x));
    let bad = 0;
    for (const M of Ms) {
        const ref = Array.from(loopForm(M, new Float64Array(4)));
        const got = Array.from(K.smallestEigvec4Inverse(M, new Float64Array(4)));
        if (!sameArr(ref, got)) { bad++; if (bad <= 3) console.error('   mismatch', ref, got); }
    }
    ok(bad === 0, `${Ms.length} matrices: ${bad} differ`);
}

group('DltViewSystem: every subset of views == triangulatePointDLT with the rest nulled, bit for bit');
{
    // The tracker's reprojection check (checkedPoints3d) leaves views out one
    // at a time through this; it must give exactly the solve it replaced, or
    // Track All's identities move. Every subset of each system, half of them
    // through a fresh copy of the matrices (a new normalizing-frame cache key),
    // with a missing observation in some.
    const sys = new K.DltViewSystem();
    const out = [0, 0, 0];
    let solves = 0, bad = 0, nulls = 0;
    for (let t = 0; t < 600; t++) {
        const s = SYSTEMS[t];
        const obs = s.xs.map((x, i) => [x, s.ys[i]]);
        if (t % 7 === 3 && s.nObs > 2) obs[1] = null;
        const exts = t % 2 === 1 ? s.Ps.map((P) => P.map((r) => r.slice())) : s.Ps;
        sys.prepare(obs, exts);
        const use = new Uint8Array(s.nObs);
        for (let mask = 0; mask < (1 << s.nObs); mask++) {
            for (let v = 0; v < s.nObs; v++) use[v] = (mask >> v) & 1;
            const ref = K.triangulatePointDLT(obs.map((o, v) => use[v] ? o : null), exts);
            const got = sys.solve(use, out) ? out.slice() : null;
            solves++;
            if (ref == null) nulls++;
            if (!sameArr(ref, got)) { bad++; if (bad <= 3) console.error('   mismatch', mask, ref, got); }
        }
    }
    ok(bad === 0 && solves > 10000 && nulls > 0, `${solves} subset solves (${nulls} null): ${bad} differ`);

    // Re-preparing for another node must not leak the previous node's views.
    const a = SYSTEMS[2], b = SYSTEMS[3];
    const obsA = a.xs.map((x, i) => [x, a.ys[i]]), obsB = b.xs.map((x, i) => [x, b.ys[i]]);
    sys.prepare(obsA, a.Ps);
    sys.prepare(obsB, b.Ps);
    const all = new Uint8Array(b.nObs).fill(1);
    ok(sameArr(sys.solve(all, out) ? out.slice() : null, K.triangulatePointDLT(obsB, b.Ps)), 'prepare() replaces the previous system');
}

group('camera-geometry memo (cameraCenter / backProjectToRays)');
{
    const cam = randCamera(7, false);
    const P = cam.extrinsicMatrix;
    const c1 = tri.cameraCenter(P);
    const c2 = tri.cameraCenter(P);
    ok(sameArr(c1, c2) && c1 !== c2, 'memoized centre is returned as a fresh copy');
    c2[0] = 999;
    ok(tri.cameraCenter(P)[0] !== 999, 'mutating a returned centre cannot poison the memo');
    const pts = [[0.1, 0.2], null, [-0.3, 0.05]];
    const r1 = tri.backProjectToRays(pts, P);
    const r2 = tri.backProjectToRays(pts, P);
    ok(sameArr(r1.origin, r2.origin) && sameArr(r1.directions[0], r2.directions[0]) && r2.directions[1] === null,
        'back-projection is stable across memo hits');
    // Mutate P IN PLACE: the memo must notice and recompute.
    const P2 = P.map(r => r.slice());
    const before = tri.cameraCenter(P2);
    P2[0][3] += 50;
    const after = tri.cameraCenter(P2);
    const fresh = tri.cameraCenter(P2.map(r => r.slice()));     // unseen array: computed from scratch
    ok(!sameArr(before, after) && sameArr(after, fresh), 'an in-place-mutated P is recomputed, not served stale');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error('\nFailures:'); for (const f of failures) console.error('  - ' + f); process.exit(1); }
