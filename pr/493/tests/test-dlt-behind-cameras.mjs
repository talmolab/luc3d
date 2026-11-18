/**
 * test-dlt-behind-cameras.mjs — the DLT method gives no answer for a keypoint
 * behind every camera that saw it (`clearPointsBehindEveryView`, applied in
 * `triangulateAndReproject`'s 'dlt' path only).
 *
 * Three real keypoints (tests/fixtures/dlt-behind-cameras.json): SLAP's
 * 8-camera rig, sleap-nn predictions. In each, the views left after the
 * Tracking Wizard's 12 px threshold (or the only two views) diverge, and DLT
 * put the point behind both cameras — where it reprojects onto the detections
 * like a real point, so shipped DLT kept it:
 *   mirrorThreeViews  3 views → 2 after the threshold, 18.5 m off at 2.9/2.4 px
 *   mirrorFiveViews   5 views → 2 after the threshold, 5.1 m off at 11.2/11.6 px
 *   twoViewsKm        a 2-camera rig, no threshold, 1,786 km off
 * The tracker's DLT (`triangulatePointDLT` / `triangulatePoints`) must still
 * answer exactly as before, and everyday points must be untouched.
 *
 * Run: node tests/test-dlt-behind-cameras.mjs
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
const { triangulateAndReproject, triangulatePointDLT, triangulatePoints, clearPointsBehindEveryView } = core;

const FIX = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dlt-behind-cameras.json'), 'utf8'));
const cams = FIX.cameras.map(c => new pd.Camera(c.name, c.matrix, c.dist, c.rvec, c.tvec, c.size));
const names = cams.map(c => c.name);
const P = cams.map(c => c.projectionMatrix);

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const depth = (X, c) => core.cameraDepth(X, c);   // K[R|t], det > 0: positive in front
const isNone = X => X.every(v => Number.isNaN(v));

/** The app's path: one-node group, every camera. */
function solve(obs, method, threshold) {
    const g = new pd.InstanceGroup(1, 0);
    obs.forEach((o, i) => { if (o) g.addInstance(names[i], new pd.Instance([o], 0, 'user', 1)); });
    const r = triangulateAndReproject(g, cams, { method, includedCameras: names, reprojErrorThreshold: threshold });
    return Array.from(r.points3d.slice(0, 3));
}
/** Plain DLT (the tracker's) on the views in `use`, undistorted as the app does. */
function plainDlt(obs, use) {
    return triangulatePointDLT(obs.map((o, i) => (o && use[i] ? cams[i].undistortPoint(o) : null)), P);
}
/** Native-pixel reprojection error of X in view i. */
function px(X, obs, i) {
    const q = cams[i].distortPoint(cams[i].project(X));
    return Math.hypot(q[0] - obs[i][0], q[1] - obs[i][1]);
}

for (const name of ['mirrorThreeViews', 'mirrorFiveViews']) {
    group(`${name}: the 12 px threshold leaves two views that meet behind both cameras`);
    const c = FIX.cases[name];
    const views = c.obs.map((o, i) => (o ? i : -1)).filter(i => i >= 0);
    // The premise, without the app: some pair of views has a plain DLT behind
    // both cameras that passes 12 px in both, metres from the animal.
    let mirror = null;
    for (let a = 0; a < views.length; a++) {
        for (let b = a + 1; b < views.length; b++) {
            const use = c.obs.map((_, i) => i === views[a] || i === views[b]);
            const X = plainDlt(c.obs, use);
            if (X && depth(X, cams[views[a]]) < 0 && depth(X, cams[views[b]]) < 0
                && px(X, c.obs, views[a]) <= 12 && px(X, c.obs, views[b]) <= 12) mirror = X;
        }
    }
    ok(mirror != null, 'a pair of views meets behind both cameras within 12 px (the mirror point shipped DLT kept)');
    ok(mirror && dist3(mirror, c.target) > 1000, `that point is ${mirror ? (dist3(mirror, c.target) / 1000).toFixed(1) : '?'} m off`);
    ok(isNone(solve(c.obs, 'dlt', 12)), 'DLT with the 12 px threshold gives no answer');
    const all = solve(c.obs, 'dlt', 0);
    ok(!isNone(all) && views.some(i => depth(all, cams[i]) > 0),
        'without the threshold the all-views DLT is in front of a camera and still answers');
}

group('twoViewsKm: a 2-camera rig (top + topL); DLT 1,786 km off behind both cameras');
{
    // The study's 2-camera subset: a rig of only these two cameras (DLT solves
    // in a frame built from the cameras it is given, so the rig matters).
    const c = FIX.cases.twoViewsKm;
    const rig = ['top', 'topL'].map(n => names.indexOf(n));
    const rigCams = rig.map(i => cams[i]), rigP = rig.map(i => P[i]);
    const obs = rig.map(i => c.obs[i]);
    const und = obs.map((o, j) => rigCams[j].undistortPoint(o));
    const X = triangulatePointDLT(und, rigP);
    ok(X != null && rigCams.every(cam => depth(X, cam) < 0), 'plain DLT is behind both cameras');
    ok(X != null && dist3(X, c.target) > 1e6, `plain DLT is ${X ? (dist3(X, c.target) / 1e6).toFixed(0) : '?'} km off`);
    const g = new pd.InstanceGroup(1, 0);
    rig.forEach((i, j) => g.addInstance(names[i], new pd.Instance([obs[j]], 0, 'user', 1)));
    const r = triangulateAndReproject(g, rigCams, { method: 'dlt', includedCameras: ['top', 'topL'], reprojErrorThreshold: 0 });
    ok(isNone(Array.from(r.points3d.slice(0, 3))), 'DLT method gives no answer');
    // The tracker's DLT is untouched: same answer, bit for bit.
    const flat = triangulatePoints([und], rigP);
    ok(X && [0, 1, 2].every(k => Object.is(flat[k], X[k])), 'triangulatePoints still answers it (tracker unchanged)');
    // In the 8-camera frame the same two rays still meet behind both cameras.
    ok(isNone(solve(c.obs, 'dlt', 0)), 'with all 8 cameras in the session: no answer either');
}

group('clearPointsBehindEveryView: the rule');
{
    const T = FIX.cases.mirrorThreeViews.target;
    const top = names.indexOf('top'), back = names.indexOf('back');
    const obs2 = names.map((_, i) => (i === top || i === back ? [0, 0] : null));
    const run = (X, Ps, obs = obs2) => {
        const pts = pd.makePoints3d(1);
        pd.setPoint3d(pts, 0, X);
        return !isNone(Array.from(clearPointsBehindEveryView(pts, [obs], Ps).slice(0, 3)));
    };
    ok(run(T, P), 'a real point (in front of both) is kept');
    // A point behind `back` only: a step from `back`'s centre away from the target.
    const C = core.cameraCenter(P[back]);
    const behindOne = [0, 1, 2].map(k => C[k] + 0.05 * (C[k] - T[k]));
    ok(depth(behindOne, cams[back]) < 0 && depth(behindOne, cams[top]) > 0, 'probe is behind back, in front of top');
    ok(run(behindOne, P), 'behind ONE of its cameras: kept');
    const negP = P.map(M => (M ? M.map(r => r.map(v => -v)) : M));
    ok(run(T, negP) && run(behindOne, negP), 'with −P the same points are kept (sign(det M) makes it scale-free)');
    const c = FIX.cases.twoViewsKm;
    const und = c.obs.map((o, i) => (o ? cams[i].undistortPoint(o) : null));
    const Xkm = triangulatePointDLT(und, P);
    ok(!run(Xkm, P, c.obs), 'twoViewsKm\'s DLT point (behind top and topL): cleared');
    ok(!run(Xkm, negP, c.obs), '…and with −P');
    const degenerate = P.map((M, i) => (i === names.indexOf('top') ? [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]] : M));
    ok(run(Xkm, degenerate, c.obs), 'a camera with a degenerate P cannot say: kept');
    const one = names.map((_, i) => (i === top ? [0, 0] : null));
    ok(run(Xkm, P, one), 'one view only: never cleared (DLT needs two anyway)');
}

group('everyday points: DLT answers exactly as before');
{
    // Points around the arena, seen the way the cameras really see (distorted),
    // 2 px noise, one view in five 40 px off; 12 px threshold and none.
    let s = 11;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const T = FIX.cases.mirrorThreeViews.target;
    let n = 0, same0 = 0, answered12 = 0;
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
        const a = solve(obs, 'dlt', 0), b = plainDlt(obs, obs.map(Boolean));
        if (b && a.every((v, k) => Object.is(v, b[k]))) same0++;
        if (!isNone(solve(obs, 'dlt', 12))) answered12++;
    }
    ok(n > 300, `${n} points`);
    ok(same0 === n, `no threshold: ${same0}/${n} bit-identical to plain DLT`);
    ok(answered12 > 0.9 * n, `12 px threshold: ${answered12}/${n} answered`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
