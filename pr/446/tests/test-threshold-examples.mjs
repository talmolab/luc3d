/**
 * test-threshold-examples.mjs — the threshold card's session examples
 * (`pose/threshold-examples.js`) tell the same story as a real Triangulate.
 *
 * Asserted, DLT and Refined, on distorted cameras with noisy 2D and strays:
 *   1. `scanThresholdExamples` lists nodes seen by 3+ cameras, smallest worst
 *      error first, each worst error being the real solver's with the threshold off.
 *   2. `firstOverThreshold` splits the list at the threshold; equal is not over.
 *   3. For every example and threshold, `solveExample`'s last solve has the same 3D
 *      and errors as `triangulateAndReproject` at that threshold, and agrees on
 *      whether the node keeps a 3D point. Only the worst camera goes per pass.
 *   4. It never writes to the session, and a nulled or missing node is not counted.
 *   5. Fewer than 3 calibrated cameras, or no groups: an empty list, no error.
 *   7. `pickShownCameras`: the largest errors, no prediction last, session order, the
 *      top one named.
 *   9. `lineOfSight` passes through the prediction, and through the solved point of a
 *      camera that agrees; `solveExample3d` is a real Triangulate's 3D.
 *   8. `pickRepresentativeExamples`: a fixed set spread evenly on a log scale of
 *      error, reaching the largest, none twice, the same every time.
 *   6. A lazy project's members are read from the store and given back, and it
 *      lists the same nodes with the same errors as the eager project.
 *
 * Run: node tests/test-threshold-examples.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error('  ✗ ' + msg); } }
function group(name) { console.log('\n• ' + name); }

const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const pd = await load('pose/pose-data.js');
const core = await load('pose/triangulation-core.js');
const ex = await load('pose/threshold-examples.js');

let seed = 7;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = (s) => (rand() + rand() + rand() - 1.5) * s;

function makeCameras(n) {
    const cams = [];
    for (let i = 0; i < n; i++) {
        const a = 2 * Math.PI * i / n;
        const rvec = [0.5 * Math.cos(a), 0.9 * Math.sin(a), 0.1 * i];
        const cam = new pd.Camera('cam' + i, [[900, 0, 640], [0, 900, 512], [0, 0, 1]], [-0.05, 0, 0, 0, 0], rvec, [0, 0, 700 + 10 * i]);
        cams.push(cam);
    }
    return cams;
}

const observe = (cam, X) => {
    const p = cam.project(X);
    return cam.distortPoint ? cam.distortPoint(p) : p;
};

function makeSession(cams, frames, nodes) {
    const names = Array.from({ length: nodes }, (_, i) => 'n' + i);
    const skeleton = new pd.Skeleton('s', names, []);
    const session = new pd.Session(cams, skeleton, [], 'test');
    session.instanceGroups = new Map();
    for (let f = 0; f < frames; f++) {
        const g = new pd.InstanceGroup(f, 0);
        for (const cam of cams) {
            const pts = [];
            for (let k = 0; k < nodes; k++) {
                const X = [k * 12 - 20 + f, k * 5 - 8, k * 4];
                let p = observe(cam, X);
                p = [p[0] + noise(4), p[1] + noise(4)];
                if (rand() < 0.2) p = [p[0] + 40 + rand() * 120, p[1] - 30];
                if (rand() < 0.12) p = null;
                pts.push(p);
            }
            g.addInstance ? g.addInstance(cam.name, new pd.Instance(pts)) : g.instances.set(cam.name, new pd.Instance(pts));
        }
        session.instanceGroups.set(f, [g]);
    }
    return session;
}

const cams = makeCameras(5);
const session = makeSession(cams, 12, 5);
const included = cams.map(c => c.name);

for (const method of ['dlt', 'ba']) {
    group('1. the scan, ' + method);
    const scan = await ex.scanThresholdExamples(session, { method });
    const list = scan.examples;
    ok(list.length > 20, `plenty of nodes (${list.length})`);
    ok(scan.frames === 12, `all frames sampled (${scan.frames})`);
    let sorted = true;
    for (let i = 1; i < list.length; i++) if (list[i].worst < list[i - 1].worst) sorted = false;
    ok(sorted, 'smallest worst error first');
    for (const e of list) {
        const g = session.instanceGroups.get(e.frame)[e.group];
        const r = core.triangulateAndReproject(g, cams, { method, reprojErrorThreshold: 0, includedCameras: included });
        const errs = included.map(n => r.errors[n][e.node]).filter(v => v != null);
        ok(errs.length >= 3, `seen by 3+ cameras (${e.frame}/${e.node})`);
        ok(Math.abs(Math.max(...errs) - e.worst) < 1e-9, `worst is the solver's (${e.frame}/${e.node})`);
        ok(r.errors[e.worstCamera][e.node] === e.worst, 'and names its camera');
    }

    group('2. firstOverThreshold, ' + method);
    for (const t of [1, 5, 20, 60, 200]) {
        const at = ex.firstOverThreshold(list, t);
        ok(list.slice(0, at).every(e => e.worst <= t) && list.slice(at).every(e => e.worst > t), `splits at ${t} px`);
    }
    if (list.length) ok(ex.firstOverThreshold(list, list[0].worst) > 0, 'equal is not over');

    group('3. solveExample agrees with the solver, ' + method);
    let compared = 0, droppedAny = 0, lostAny = 0;
    for (const e of list) {
        const g = session.instanceGroups.get(e.frame)[e.group];
        for (const t of [0, 3, 8, 15, 30, 60, 150]) {
            const real = core.triangulateAndReproject(g, cams, { method, reprojErrorThreshold: t, includedCameras: included });
            const s = ex.solveExample(session, e, { method, threshold: t, included });
            const realHas = pd.hasPoint3d(real.points3d, e.node);
            ok(realHas === !s.lost, `${method} ${e.frame}/${e.node} at ${t}: 3D agrees (real ${realHas}, lost ${s.lost})`);
            if (s.dropped.length) droppedAny++;
            if (s.lost) lostAny++;
            if (realHas) {
                const last = s.passes[s.passes.length - 1];
                for (const n of included) {
                    const a = last.errors[n], b = real.errors[n][e.node];
                    ok(a === b || (a != null && b != null && Math.abs(a - b) < 1e-9), `${method} ${e.frame}/${e.node} at ${t}: ${n}'s error (${a} vs ${b})`);
                }
            }
            s.passes.forEach((pass) => {
                if (!pass.drop) return;
                const over = pass.cameras.map(n => pass.errors[n]).filter(v => v != null);
                ok(pass.errors[pass.drop] === Math.max(...over) && pass.errors[pass.drop] > t, 'only the worst, and only if over, goes');
                ok(pass.cameras.length > 2, 'never below two cameras');
            });
            compared++;
        }
    }
    ok(compared > 100 && droppedAny > 20 && lostAny > 0, `the comparison exercised drops and lost nodes (${compared} compared, ${droppedAny} with drops, ${lostAny} lost)`);
}

group('4. read-only; nulled nodes do not count');
{
    const g = session.instanceGroups.get(3)[0];
    const before = JSON.stringify([...g.instances].map(([n, i]) => [n, i.numNodes, Array.from(i._xy)]));
    const scan = await ex.scanThresholdExamples(session, { method: 'dlt' });
    ex.solveExample(session, scan.examples[0], { method: 'dlt', threshold: 5, included });
    ok(JSON.stringify([...g.instances].map(([n, i]) => [n, i.numNodes, Array.from(i._xy)])) === before, 'the 2D is untouched');
    ok(g.points3d == null, 'no 3D is stored');
    const s2 = makeSession(makeCameras(3), 2, 2);
    s2.instanceGroups.forEach((gs) => gs.forEach((gr) => gr.instances.forEach((inst) => { inst.nulledNodes = new Set([0]); })));
    const nulled = await ex.scanThresholdExamples(s2, { method: 'dlt' });
    ok(nulled.examples.every(e => e.node !== 0), 'a nulled node is not listed');
}

group('5. nothing to show');
{
    const two = await ex.scanThresholdExamples(makeSession(makeCameras(2), 3, 2), { method: 'dlt' });
    ok(two.examples.length === 0, 'two cameras: an empty list');
    const none = makeSession(makeCameras(4), 1, 2);
    none.instanceGroups = new Map();
    ok((await ex.scanThresholdExamples(none, { method: 'dlt' })).examples.length === 0, 'no groups: an empty list');
    ok(ex.calibratedCameras(null).length === 0, 'no session: no cameras');
    let cancelled = 0;
    const c = await ex.scanThresholdExamples(session, { method: 'dlt', isCancelled: () => (++cancelled > 2) });
    ok(c === null, 'a cancelled scan returns null');
}

group('6. a lazy project');
{
    const eager = makeSession(makeCameras(4), 6, 3);
    const stored = new Map();
    const lazy = makeSession(makeCameras(4), 0, 3);
    eager.instanceGroups.forEach((gs, f) => {
        const rows = new Map(), g = new pd.InstanceGroup(f, 0);
        gs[0].instances.forEach((inst, cam) => {
            const points = [];
            for (let k = 0; k < inst.numNodes; k++) points.push(inst.hasPoint(k) ? inst.getPoint(k) : null);
            rows.set(cam, [{ points, type: 'predicted', score: 1 }]);
            const m = new pd.Instance(points.map(() => null), null, 'predicted', 1);
            m._lazy2d = true;
            m._rawInstIndex = 0;
            g.instances.set(cam, m);
        });
        stored.set(f, rows);
        lazy.instanceGroups.set(f, [g]);
    });
    lazy.lazyLoader = {
        getFrameSync: (f) => stored.get(f),
        describeStoreFrame: () => ({ count: 1, predicted: [1] }),
        numNodesByCam: new Map(lazy.cameras.map(c => [c.name, 3])),
    };
    const stillLazy = () => [...lazy.instanceGroups.values()].flat().every(g => [...g.instances.values()].every(m => m._lazy2d));
    const a = await ex.scanThresholdExamples(eager, { method: 'dlt' });
    const b = await ex.scanThresholdExamples(lazy, { method: 'dlt' });
    ok(a.examples.length > 5 && a.examples.length === b.examples.length, `the same nodes (${a.examples.length}, ${b.examples.length})`);
    ok(a.examples.every((e, i) => e.frame === b.examples[i].frame && e.node === b.examples[i].node && Math.abs(e.worst - b.examples[i].worst) < 1e-9), 'with the same errors');
    ok(stillLazy(), 'a scan gives every member back to the store');
    const last = b.examples[b.examples.length - 1];
    const s = ex.solveExample(lazy, last, { method: 'dlt', threshold: 5 });
    ok(s && s.passes[0].errors[last.worstCamera] === a.examples[a.examples.length - 1].worst, 'an example reads the store too');
    ok(stillLazy(), 'and gives them back');
    ok(s.skeletons.get(last.worstCamera).some(Boolean), 'keeping its own copy of the 2D');
}

group('7. which cameras get a tile');
{
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const errors = { a: 55, b: 203, c: 60, d: 14, e: 167, f: 60, g: 102, h: null };
    const predictions = new Map(names.map(n => [n, n === 'h' ? null : [1, 2]]));
    const base = { passes: [{ errors }], predictions };
    let r = ex.pickShownCameras(base, names, 4);
    ok(r.shown.join() === 'b,e,f,g' || r.shown.join() === 'b,c,e,g', `the four largest, in session order (${r.shown})`);
    ok(r.first === 'b', `the largest is enlarged first (${r.first})`);
    ok(r.others.length === 4 && r.others.includes('h') && r.others.includes('d'), `the rest are named (${r.others})`);
    r = ex.pickShownCameras(base, ['a', 'h'], 6);
    ok(r.shown.join() === 'a,h' && r.others.length === 0 && r.first === 'a', 'fewer cameras than slots: all of them, no prediction ranked last');
    ok(ex.pickShownCameras(base, [], 6).first === null, 'no cameras: nothing to enlarge');
}

group('8. a representative set');
{
    // Like a real session: nearly all small errors, a few enormous.
    const list = [];
    for (let i = 0; i < 9000; i++) {
        const worst = i < 8700 ? 1 + 9 * (i / 8700) : i < 8990 ? 10 + 90 * ((i - 8700) / 290) : 100 + 65 * (i - 8990);
        list.push({ frame: i % 240, group: 0, node: i % 13, worst, worstCamera: 'a' });
    }
    const set = ex.pickRepresentativeExamples(list);
    ok(set.length === ex.EXAMPLE_SET_SIZE, `the set's size (${set.length})`);
    ok(set.every((e, i) => !i || e.worst >= set[i - 1].worst), 'smallest error first');
    ok(new Set(set).size === set.length, 'none twice');
    ok(set[set.length - 1].worst > 500, `it reaches the largest errors (${set[set.length - 1].worst})`);
    ok(set[0].worst < 2, `and the smallest (${set[0].worst})`);
    const inZone = set.filter(e => e.worst >= 15 && e.worst <= 100).length;
    ok(inZone >= 3, `the recommended range has several, though it is 3% of the nodes (${inZone})`);
    ok(new Set(set.map(e => e.node)).size >= 6, `body parts vary (${new Set(set.map(e => e.node)).size})`);
    ok(JSON.stringify(ex.pickRepresentativeExamples(list)) === JSON.stringify(set), 'the same every time');
    const few = list.slice(0, 5);
    ok(ex.pickRepresentativeExamples(few).length === 5, 'fewer nodes than the set: all of them');
    ok(ex.pickRepresentativeExamples([]).length === 0, 'none: an empty set');
}

group('9. the 3D view\'s geometry');
{
    const sCams = makeCameras(5);
    for (const cam of sCams) {
        const X = [12, -8, 20];
        const pred = observe(cam, X);
        const ray = ex.lineOfSight(cam, pred);
        ok(!!ray && Math.abs(Math.hypot(...ray.dir) - 1) < 1e-9, `${cam.name}: a unit direction`);
        // Along the line, the camera still sees the same pixel: the ray is its own.
        for (const t of [300, 700, 1100]) {
            const p = [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t, ray.origin[2] + ray.dir[2] * t];
            const q = observe(cam, p);
            ok(Math.hypot(q[0] - pred[0], q[1] - pred[1]) < 1e-3, `${cam.name}: the line stays on its prediction at ${t} (${q} vs ${pred})`);
        }
        const t0 = (X[0] - ray.origin[0]) * ray.dir[0] + (X[1] - ray.origin[1]) * ray.dir[1] + (X[2] - ray.origin[2]) * ray.dir[2];
        const miss = Math.hypot(ray.origin[0] + ray.dir[0] * t0 - X[0], ray.origin[1] + ray.dir[1] * t0 - X[1], ray.origin[2] + ray.dir[2] * t0 - X[2]);
        ok(miss < 1e-3, `${cam.name}: and passes through the point it saw (${miss})`);
    }
    const scan = await ex.scanThresholdExamples(session, { method: 'dlt' });
    const e = scan.examples[scan.examples.length - 1];
    const g = session.instanceGroups.get(e.frame)[e.group];
    for (const t of [0, 10, 40]) {
        const real = core.triangulateAndReproject(g, cams, { method: 'dlt', reprojErrorThreshold: t, includedCameras: included });
        const mine = ex.solveExample3d(session, e, { method: 'dlt', threshold: t, included });
        ok(Array.from(mine).every((v, i) => Object.is(v, real.points3d[i]) || Math.abs(v - real.points3d[i]) < 1e-9), `at ${t} px: a real Triangulate's 3D`);
        const all = ex.solveFrame3d(session, e.frame, { method: 'dlt', threshold: t, included });
        ok(all.length === session.instanceGroups.get(e.frame).length && all[e.group].source === g, 'every animal in the frame, each with its group');
        ok(Array.from(all[e.group].points3d).every((v, i) => Object.is(v, mine[i]) || Math.abs(v - mine[i]) < 1e-9), 'with the same 3D');
    }
    const fr = ex.frameFromPoints([0, 0, 0, 10, 0, 0, 20, 0, 0, NaN, NaN, NaN]);
    ok(fr.centre.join() === '10,0,0' && fr.radius === 10, `a frame around the solved points (${JSON.stringify(fr)})`);
    ok(ex.frameFromPoints([NaN, NaN, NaN]) === null, 'no solved point: no frame');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
