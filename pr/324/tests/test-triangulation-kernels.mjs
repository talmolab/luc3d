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

group('DLT kernel == svd3x4 on the same A, bit for bit');
{
    let n = 0, bad = 0;
    for (let trial = 0; trial < 3000; trial++) {
        const nObs = 2 + Math.floor(rnd() * 7);              // 2..8 views
        const cams = Array.from({ length: nObs }, (_, i) => randCamera(i, false));
        const xs = [], ys = [], Ps = [];
        for (let i = 0; i < nObs; i++) {
            // Real projections of one point plus noise; sometimes wild values.
            const P = cams[i].projectionMatrix;
            const X = [rr(-300, 300), rr(-300, 300), rr(-100, 300)];
            const w = P[2][0] * X[0] + P[2][1] * X[1] + P[2][2] * X[2] + P[2][3];
            xs.push((P[0][0] * X[0] + P[0][1] * X[1] + P[0][2] * X[2] + P[0][3]) / w + rr(-3, 3) * (trial % 5 === 0 ? 100 : 1));
            ys.push((P[1][0] * X[0] + P[1][1] * X[1] + P[1][2] * X[2] + P[1][3]) / w + rr(-3, 3));
            Ps.push(P);
        }
        const A = [];
        for (let i = 0; i < nObs; i++) {
            const P = Ps[i], x = xs[i], y = ys[i];
            A.push([x * P[2][0] - P[0][0], x * P[2][1] - P[0][1], x * P[2][2] - P[0][2], x * P[2][3] - P[0][3]]);
            A.push([y * P[2][0] - P[1][0], y * P[2][1] - P[1][1], y * P[2][2] - P[1][2], y * P[2][3] - P[1][3]]);
        }
        const ref = K.svd3x4(A);
        const got = Array.from(K.dltHomogeneousFlat(xs, ys, Ps, nObs, new Float64Array(4)));
        n++;
        if (!sameArr(ref, got)) { bad++; if (bad <= 3) console.error('   mismatch', ref, got); }
    }
    ok(bad === 0, `${n} random 2–8-view systems: ${bad} differ`);
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
