/**
 * test-triangulation-threshold-figure.mjs — the reprojection error threshold
 * card in Settings ▸ Triangulation Wizard (`ui/triangulation-methods-figure.js`)
 * decides which camera is dropped, and whether the node keeps a 3D point, with
 * `thresholdPasses`. This pins that rule to the real one in
 * `triangulateAndReproject` (`pose/triangulation-core.js`), so the figure cannot
 * tell a different story from the solver.
 *
 * Asserted:
 *   1. `thresholdPasses` on the figure's own numbers: only the worst camera is
 *      dropped per pass, never below two cameras; an error equal to the
 *      threshold is not over it; a node whose last two cameras still miss
 *      loses its 3D.
 *   2. Against the solver, DLT and Refined, on scenes of 3-5 distorted cameras
 *      with noisy 2D, one or two strays per node and nodes some cameras miss:
 *      for every node and threshold, the rule — fed the solver's own errors
 *      for each set of cameras (`includedCameras`, the same observation mask
 *      the solver's loop applies) — predicts exactly which nodes keep a 3D
 *      point, and a kept node's 3D is the solve from the cameras the rule
 *      keeps, value for value.
 *   3. `FIGURE_SCENE`, which all the figure's sketches draw, is the real solvers'
 *      output: its 3D, landings and errors, for each method and set of cameras,
 *      and the outcome at every threshold from 1 to 120 px. A mismatch prints the
 *      right numbers. The captions' claims hold too: Refined lands two marker diameters from
 *      the target with the stray counted, DLT is pulled further, and dropping the stray
 *      lands nearer.
 *
 * Run: node tests/test-triangulation-threshold-figure.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error('  ✗ ' + msg); } }
function group(name) { console.log('\n• ' + name); }

const pd = await import(pathToFileURL(path.join(ROOT, 'pose', 'pose-data.js')).href);
const core = await import(pathToFileURL(path.join(ROOT, 'pose', 'triangulation-core.js')).href);
const { thresholdPasses, FIGURE_SCENE, thresholdSliderPos, thresholdFromSliderPos } = await import(pathToFileURL(path.join(ROOT, 'ui', 'triangulation-methods-figure.js')).href);

// ---------------------------------------------------------------------------
group('1. the rule on hand-made numbers');
{
    const table = { '0,1,2': [17, 24, 30], '0,1': [3, 3, 65] };
    const solve = (cams) => table[cams.join(',')];
    const at = (t) => thresholdPasses([0, 1, 2], solve, t);

    let r = at(15);
    ok(r.passes.length === 2 && r.passes[0].drop === 2, '15 px: all three over, only the worst (right) is dropped');
    ok(r.passes[1].drop === -1 && r.kept, '15 px: the two left are within after the re-solve, the node keeps its 3D');
    r = at(29);
    ok(r.passes[0].drop === 2 && r.kept, '29 px: only the right camera is over; dropped');
    r = at(30);
    ok(r.passes.length === 1 && r.kept, '30 px: an error of exactly 30 is not over 30, nothing dropped');
    r = at(2);
    ok(r.passes.length === 2 && r.passes[1].drop === -1 && !r.kept, '2 px: the last two still miss, never dropped below two, the node loses its 3D');
    r = thresholdPasses([0, 1], () => [5, 1], 2);
    ok(r.passes.length === 1 && r.passes[0].drop === -1 && !r.kept, 'two cameras from the start: none dropped, the node loses its 3D');
    r = thresholdPasses([0, 1, 2, 3], (cams) => ({ '0,1,2,3': [9, 40, 30, 2], '0,2,3': [8, NaN, 25, 2], '0,3': [1, NaN, NaN, 1] })[cams.join(',')], 10);
    ok(r.passes.map((p) => p.drop).join() === '1,2,-1' && r.kept, 'four cameras: the worst goes first, then the next worst after the re-solve');
}

// ---------------------------------------------------------------------------
group('1b. the threshold slider: off, then 640 px down to 1 px on a log scale');
{
    ok(thresholdFromSliderPos(0) === 0 && thresholdSliderPos(0) === 0, 'its left end is off');
    ok(thresholdFromSliderPos(100) === 640 && thresholdFromSliderPos(1000) === 1, 'then 640 px, then 1 px at its right end');
    let down = true;
    for (let pos = 101; pos <= 1000; pos++) if (thresholdFromSliderPos(pos) > thresholdFromSliderPos(pos - 1)) down = false;
    ok(down, 'moving right never raises the threshold');
    const a = thresholdSliderPos(640), b = thresholdSliderPos(320), c = thresholdSliderPos(160);
    ok(Math.abs((b - a) - (c - b)) <= 1, 'equal ratios take equal distances (log scale)');
    for (const px of [1, 2, 7, 10, 25, 50, 53, 100, 300, 640]) ok(Math.abs(thresholdFromSliderPos(thresholdSliderPos(px)) - px) <= Math.max(1, px * 0.01), `${px} px survives the round trip`);
}

// ---------------------------------------------------------------------------
let seed = 20261029;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const rr = (a, b) => a + (b - a) * rnd();
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

function scene(nCams, nNodes) {
    const cams = [];
    for (let i = 0; i < nCams; i++) {
        const f = rr(900, 1200);
        cams.push(new pd.Camera('c' + i, [[f, 0, 640], [0, f, 512], [0, 0, 1]],
            [rr(-0.15, -0.05), rr(-0.02, 0.02), 0, 0, 0],
            [rr(-0.4, 0.4), rr(-0.6, 0.6), rr(-0.2, 0.2)], [rr(-50, 50), rr(-50, 50), rr(1500, 2000)], [1280, 1024]));
    }
    const truth = Array.from({ length: nNodes }, () => [rr(-150, 150), rr(-150, 150), rr(-150, 150)]);
    // Per node: one or two stray cameras, and (sometimes) a camera that misses it.
    const strays = truth.map(() => {
        const s = new Map();
        const n = rnd() < 0.5 ? 1 : 2;
        while (s.size < n) s.set(Math.floor(rnd() * nCams), [rr(-120, 120), rr(-120, 120)]);
        return s;
    });
    const missing = truth.map(() => (nCams > 3 && rnd() < 0.3 ? Math.floor(rnd() * nCams) : -1));
    const g = new pd.InstanceGroup(1, 0);
    cams.forEach((cam, ci) => {
        const pts = truth.map((X, k) => {
            if (missing[k] === ci) return null;
            const q = cam.distortPoint(cam.project(X));
            const s = strays[k].get(ci) || [0, 0];
            return [q[0] + gauss() * 1.5 + s[0], q[1] + gauss() * 1.5 + s[1]];
        });
        g.addInstance(cam.name, new pd.Instance(pts, 0, 'predicted', 1));
    });
    return { cams, g, nNodes };
}

const THRESHOLDS = [1, 2, 3, 5, 8, 12, 15, 20, 30, 50, 80, 120, 200];

for (const method of ['dlt', 'ba']) {
    group(`2. ${method}: the rule predicts the solver`);
    let nodes = 0, lost = 0, dropped = 0, multi = 0, nearTie = 0;
    for (const nCams of [3, 4, 5]) {
        for (let rep = 0; rep < 3; rep++) {
            const { cams, g, nNodes } = scene(nCams, 10);
            const names = cams.map((c) => c.name);
            // One solve per set of cameras, every node at once (each node is
            // solved on its own, so node k's answer depends only on its set).
            const cache = new Map();
            const solveSet = (set) => {
                const key = set.join(',');
                if (!cache.has(key)) {
                    cache.set(key, core.triangulateAndReproject(g, cams,
                        { method, reprojErrorThreshold: 0, includedCameras: set.map((c) => names[c]) }));
                }
                return cache.get(key);
            };
            for (const t of THRESHOLDS) {
                const real = core.triangulateAndReproject(g, cams, { method, reprojErrorThreshold: t });
                for (let k = 0; k < nNodes; k++) {
                    const seen = names.map((n, c) => c).filter((c) => g.getInstance(names[c]).hasPoint(k));
                    const errorsFor = (set) => {
                        const res = solveSet(set);
                        return names.map((n) => res.errors[n][k]);
                    };
                    // Skip a threshold within a hair of an error the rule reads:
                    // there the two ways of computing one error could round apart.
                    const pred = thresholdPasses(seen, errorsFor, t);
                    if (pred.passes.some((p) => p.cameras.some((c) => Math.abs(p.errors[c] - t) < 1e-6))) { nearTie++; continue; }
                    nodes++;
                    const has = pd.hasPoint3d(real.points3d, k);
                    const last = pred.passes[pred.passes.length - 1].cameras;
                    if (!pred.kept) lost++;
                    if (last.length < seen.length) dropped++;
                    if (pred.passes.length > 2) multi++;
                    if (has !== pred.kept) {
                        ok(false, `${method} ${nCams} cams, node ${k}, ${t} px: solver ${has ? 'kept' : 'dropped'} the node, figure rule says ${pred.kept ? 'kept' : 'dropped'}`);
                        continue;
                    }
                    if (!has) { ok(true, ''); continue; }
                    const want = pd.getPoint3d(solveSet(last).points3d, k);
                    const got = pd.getPoint3d(real.points3d, k);
                    ok(got.every((v, i) => Object.is(v, want[i])),
                        `${method} ${nCams} cams, node ${k}, ${t} px: 3D is the solve from cameras ${last.join(',')} (${got} vs ${want})`);
                }
            }
        }
    }
    console.log(`  ${nodes} node × threshold cases (${dropped} with a camera dropped, ${multi} with two or more cameras dropped, ${lost} losing their 3D; ${nearTie} near-ties skipped)`);
    ok(dropped > 50 && multi > 20 && lost > 20, `${method}: every branch of the rule is exercised (${dropped} / ${multi} / ${lost})`);
}

// ---------------------------------------------------------------------------
group('3. the figure\'s scene is what the real solvers give');
{
    const PX = 3;   // image pixels per sketch unit
    const cams = FIGURE_SCENE.cameras.map((c, i) => {
        const a = c.rot * Math.PI / 180, f = [Math.cos(a), Math.sin(a)], r = [-f[1], f[0]];
        return new pd.Camera('c' + i, [[c.plane * PX, 0, 0], [0, c.plane * PX, 0], [0, 0, 1]], [0, 0, 0, 0, 0],
            [[r[0], r[1], 0], [0, 0, 1], [f[0], f[1], 0]],
            [-(r[0] * c.at[0] + r[1] * c.at[1]), 0, -(f[0] * c.at[0] + f[1] * c.at[1])], [144, 144]);
    });
    const names = cams.map((c) => c.name);
    const groupOf = (dets) => {
        const g = new pd.InstanceGroup(1, 0);
        cams.forEach((c, i) => g.addInstance(c.name, new pd.Instance([dets[i]], 0, 'predicted', 1)));
        return g;
    };
    const g = groupOf(FIGURE_SCENE.detections);
    const solveSet = (method, set, dets) => core.triangulateAndReproject(dets ? groupOf(dets) : g, cams,
        { method, reprojErrorThreshold: 0, includedCameras: set.map((c) => names[c]) });
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    for (const method of ['dlt', 'ba']) {
        for (const key of Object.keys(FIGURE_SCENE.solves[method])) {
            const want = FIGURE_SCENE.solves[method][key];
            const res = solveSet(method, key.split(',').map(Number));
            const p = pd.getPoint3d(res.points3d, 0);
            const got = {
                point: [p[0], p[1]].map((v) => +v.toFixed(1)),
                z: +p[2].toFixed(2),
                x: names.map((n) => +res.reprojections[n][0][0].toFixed(2)),
                errors: names.map((n) => +res.errors[n][0].toFixed(1)),
            };
            const same = want.point.every((v, i) => near(v, got.point[i], 0.11))
                && near(want.z, got.z, 0.011)
                && want.x.every((v, i) => near(v, got.x[i], 0.011))
                && want.errors.every((v, i) => near(v, got.errors[i], 0.11));
            ok(same, `${method} cameras ${key}: FIGURE_SCENE should be ${JSON.stringify(got)}`);
        }
        // Every whole-pixel threshold the slider and most of the box can reach.
        for (let t = 1; t <= 120; t++) {
            const pred = thresholdPasses([0, 1, 2, 3], (cams2) => FIGURE_SCENE.solves[method][cams2.join(',')].errors, t);
            const real = core.triangulateAndReproject(g, cams, { method, reprojErrorThreshold: t });
            const has = pd.hasPoint3d(real.points3d, 0);
            ok(has === pred.kept, `${method} ${t} px: solver ${has ? 'kept' : 'dropped'} the node, the figure says ${pred.kept ? 'kept' : 'dropped'}`);
            if (!has) continue;
            const last = pred.passes[pred.passes.length - 1].cameras.join(',');
            const want = FIGURE_SCENE.solves[method][last].point, got = pd.getPoint3d(real.points3d, 0);
            ok(near(got[0], want[0], 0.11) && near(got[1], want[1], 0.11), `${method} ${t} px: the 3D is the sketch's for cameras ${last}`);
        }
    }
    // The captions' claims.
    const truth = FIGURE_SCENE.truth;
    const dist = (p) => Math.hypot(p[0] - truth[0], p[1] - truth[1]);
    const off = (res) => dist(pd.getPoint3d(res.points3d, 0));
    const ALL = [0, 1, 2, 3];
    const refined = off(solveSet('ba', ALL)), dlt = off(solveSet('dlt', ALL));
    ok(refined > 18 && refined < 22, `Refined lands two marker diameters (20 units) from the target, with the stray still counted (${refined.toFixed(1)} units)`);
    ok(dlt > 25, `DLT is pulled well away (${dlt.toFixed(1)} units)`);
    const truth3d = (res) => { const p = pd.getPoint3d(res.points3d, 0); return Math.hypot(p[0] - truth[0], p[1] - truth[1], p[2]); };
    const gtDlt = truth3d(solveSet('dlt', ALL)), gtBa = truth3d(solveSet('ba', ALL));
    ok(gtBa < gtDlt * 0.6, `the ground truth error shrinks from DLT to Refined (${gtDlt.toFixed(1)} to ${gtBa.toFixed(1)})`);
    for (const method of ['dlt', 'ba']) {
        const off3 = dist(FIGURE_SCENE.solves[method]['0,1,2'].point);
        ok(off3 > 2 && off3 < dist(FIGURE_SCENE.solves[method]['0,1,2,3'].point), `${method}: dropping the stray lands nearer the target, still a little wrong (${off3.toFixed(1)} units)`);
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
