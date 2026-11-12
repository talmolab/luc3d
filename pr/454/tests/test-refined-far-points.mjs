/**
 * test-refined-far-points.mjs — Refined (`triangulatePointBA`) must not send a
 * keypoint metres away from the animal.
 *
 * Three real keypoints (tests/fixtures/refined-far-points.json): SLAP's 8-camera
 * rig (barrel distortion, k1 ≈ -0.3), sleap-nn predictions, one view on
 * something else in each. Before the fix Refined moved them:
 *   behindStray    DLT 8.6 m off, behind the stray view's camera → 351 m off,
 *                  past the distortion fold of six views;
 *   parallelSlide  DLT 2.2 m off → 36 m off, where two nearly parallel rays
 *                  "meet" (every view in front and unfolded there);
 *   behindAll      2 views, DLT 1.0 m off and behind both cameras → 51 m
 *                  further behind them.
 * The fix (see "Where Refined may go" in pose/triangulation-core.js): stay in
 * front of / inside the fold of every view the DLT seed is, at most
 * BA_MAX_DEPTH_GROWTH × the seed's depth there; a seed with no such view is
 * refined freely but kept only if it ends valid in every view, and a seed
 * behind every camera gets no answer. Everyday points must come out exactly as
 * before.
 *
 * Run: node tests/test-refined-far-points.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) { if (cond) passed++; else { failed++; failures.push(msg); console.error('  ✗ ' + msg); } }
function group(name) { console.log('\n• ' + name); }

const pd = await import(pathToFileURL(path.join(ROOT, 'pose', 'pose-data.js')).href);
const core = await import(pathToFileURL(path.join(ROOT, 'pose', 'triangulation-core.js')).href);
const { triangulateAndReproject, triangulatePointBA, triangulatePointDLT, BA_MAX_DEPTH_GROWTH } = core;
const fold = core.__triangulationKernelsForTest._distortionFoldR2;

const FIX = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'refined-far-points.json'), 'utf8'));
const cams = FIX.cameras.map(c => new pd.Camera(c.name, c.matrix, c.dist, c.rvec, c.tvec, c.size));
const names = cams.map(c => c.name);
const P = cams.map(c => c.projectionMatrix);

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const depth = (X, c) => core.cameraDepth(X, c);       // K[R|t]: P[2]·X is metric depth
function unfolded(X, c) {
    const P = c.projectionMatrix;
    const w = depth(X, c);
    const x = ((P[0][0] * X[0] + P[0][1] * X[1] + P[0][2] * X[2] + P[0][3]) / w - c.matrix[0][2]) / c.matrix[0][0];
    const y = ((P[1][0] * X[0] + P[1][1] * X[1] + P[1][2] * X[2] + P[1][3]) / w - c.matrix[1][2]) / c.matrix[1][1];
    return x * x + y * y < fold(c);
}
const holds = (X, c) => depth(X, c) > 0 && unfolded(X, c);

/** The app's path: one-node group, every camera, no threshold. */
function solve(obs, method) {
    const g = new pd.InstanceGroup(1, 0);
    obs.forEach((o, i) => { if (o) g.addInstance(names[i], new pd.Instance([o], 0, 'user', 1)); });
    const r = triangulateAndReproject(g, cams, { method, includedCameras: names, reprojErrorThreshold: 0 });
    return { X: Array.from(r.points3d.slice(0, 3)), meanError: r.meanError };
}
/** triangulatePointBA directly, from the same seed the app uses. */
function refineDirect(obs, opts) {
    const und = obs.map((o, i) => (o ? cams[i].undistortPoint(o) : null));
    const seed = triangulatePointDLT(und, P);
    return { seed, X: triangulatePointBA(obs, P, seed, Object.assign({ cameras: cams }, opts)) };
}

group('distortion fold');
{
    const c = FIX.cameras[0];
    const k1 = c.dist[0];
    ok(Math.abs(fold(cams[0]) * 3 * Math.abs(k1) - 1) < 1e-9, `k1-only fold r² = 1/(3|k1|) (${fold(cams[0])})`);
    const pin = new pd.Camera('pin', c.matrix, [0.1, 0, 0, 0, 0], c.rvec, c.tvec, c.size);
    ok(fold(pin) === Infinity, 'pincushion never folds');
    const k2 = new pd.Camera('k2', c.matrix, [-0.3, 0.12, 0, 0, 0], c.rvec, c.tvec, c.size);
    ok(fold(k2) === Infinity, 'k1 -0.3, k2 0.12: monotone everywhere (1 - 0.9u + 0.6u² > 0)');
    const k3 = new pd.Camera('k3', c.matrix, [-0.3, 0.02, 0, 0, 0.001], c.rvec, c.tvec, c.size);
    const u = fold(k3);
    ok(Math.abs(1 - 0.9 * u + 0.1 * u * u + 0.007 * u * u * u) < 1e-9 && u > 0, `k1/k2/k3 fold is a root (u = ${u})`);
}

group('behindStray: DLT behind the stray camera; Refined went 351 m off');
{
    const c = FIX.cases.behindStray;
    const dlt = solve(c.obs, 'dlt'), ba = solve(c.obs, 'ba');
    const seedHolds = cams.map((cam, i) => !!c.obs[i] && holds(dlt.X, cam));
    ok(seedHolds.filter(Boolean).length === 6 && !seedHolds[4], 'seed holds in 6 views, not the side camera');
    const errM = dist3(ba.X, c.target) / 1000;
    ok(errM < 10, `Refined stays near DLT's answer: ${errM.toFixed(2)} m off (was 351 m)`);
    ok(cams.every((cam, i) => !seedHolds[i] || holds(ba.X, cam)), 'in front of and unfolded in every view the seed is');
    ok(cams.every((cam, i) => !seedHolds[i] || depth(ba.X, cam) <= BA_MAX_DEPTH_GROWTH * depth(dlt.X, cam) + 1e-6),
        'depth growth within the bound');
    ok(ba.meanError <= dlt.meanError + 1e-9, 'reported error still no worse than DLT (#113)');
}

group('parallelSlide: every view in front and unfolded; Refined slid to 36 m off');
{
    const c = FIX.cases.parallelSlide;
    const dlt = solve(c.obs, 'dlt'), ba = solve(c.obs, 'ba');
    const used = cams.filter((_, i) => c.obs[i]);
    ok(used.length === 3 && used.every(cam => holds(dlt.X, cam)), '3 views, seed holds in all');
    const growth = Math.max(...used.map(cam => depth(ba.X, cam) / depth(dlt.X, cam)));
    ok(growth <= BA_MAX_DEPTH_GROWTH + 1e-9, `depth grew ×${growth.toFixed(2)} ≤ ×${BA_MAX_DEPTH_GROWTH}`);
    ok(dist3(ba.X, c.target) < 12000, `${(dist3(ba.X, c.target) / 1000).toFixed(2)} m off (was 36 m)`);
    ok(ba.meanError <= dlt.meanError + 1e-9, 'reported error still no worse than DLT (#113)');
    // Teeth: without the depth bound the in-front/fold region alone does not stop it.
    const free = refineDirect(c.obs, { maxDepthGrowth: Infinity });
    ok(dist3(free.X, c.target) > 30000, `unbounded it still slides: ${(dist3(free.X, c.target) / 1000).toFixed(1)} m off`);
}

group('behindAll: DLT behind both cameras; Refined went 51 m further behind');
{
    const c = FIX.cases.behindAll;
    const dlt = solve(c.obs, 'dlt'), ba = solve(c.obs, 'ba');
    const used = cams.filter((_, i) => c.obs[i]);
    ok(used.length === 2 && used.every(cam => depth(dlt.X, cam) < 0), 'seed behind both cameras');
    ok(ba.X.every(v => Number.isNaN(v)), 'Refined gives no answer (no real point is behind both cameras)');
}

group('everyday points: unchanged (the bound never binds)');
{
    // Points around the arena, seen by all 8 cameras the way they really see
    // (distorted), 2 px noise, and one view in five 40 px off.
    let s = 7;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const T = FIX.cases.behindStray.target;
    let same = 0, n = 0, inside = 0;
    for (let t = 0; t < 400; t++) {
        const X = [T[0] + (rnd() - 0.5) * 300, T[1] + (rnd() - 0.5) * 300, T[2] + (rnd() - 0.5) * 120];
        const obs = cams.map(cam => {
            if (depth(X, cam) <= 0) return null;
            const q = cam.distortPoint(cam.project(X));
            const out = rnd() < 0.2 ? 40 : 0;
            const o = [q[0] + 2 * gauss() + out, q[1] + 2 * gauss() - out];
            return o[0] >= 0 && o[0] < 1280 && o[1] >= 0 && o[1] < 1024 ? o : null;
        });
        if (obs.filter(Boolean).length < 2) continue;
        n++;
        const a = refineDirect(obs, {}), b = refineDirect(obs, { maxDepthGrowth: Infinity });
        if (a.X.every((v, k) => Object.is(v, b.X[k]))) same++;
        if (cams.every((cam, i) => !obs[i] || holds(a.seed, cam))) inside++;
    }
    ok(n > 300, `${n} points`);
    ok(same === n, `depth bound never binds: ${same}/${n} bit-identical to unbounded`);
    ok(inside === n, `every seed holds in every view: ${inside}/${n}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
