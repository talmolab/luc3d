/**
 * test-temporal-smoothing-adaptive.mjs — Temporal Smoothing's adaptive method
 * (3D adaptive temporal averaging) as `pose/temporal-smoothing.js` runs it on
 * a session: real 2D in four distorted cameras, DLT 3D, two identities.
 *
 *   - Settings: `smoothingMethod` 1 selects it; defaults k 3, hmax 15; hmax 0 is off.
 *   - It smooths: a still node's frame-to-frame jitter and error fall, a fast
 *     node is left nearly as it was, and every point is weighed by its views'
 *     covariance (no fallback) while cameras and 2D exist.
 *   - This frame writes exactly what All frames writes, frame by frame — with
 *     view covariances, with the sigma fallback, and with both mixed.
 *   - Gaps are never filled; 2D never changes; a second run replaces the first.
 *   - A lazy project's released members are read from the store
 *     (`storeRowPoints`): the same 3D as with their 2D resident, bit for bit.
 *   - The reprojection threshold and Camera Views change the covariances as
 *     they change the solve.
 *   - Remove / Restore: Restore puts back exactly what was removed; a change of
 *     gate or method makes it stale, a change of the windows' settings does not.
 *
 * Run:  node tests/test-temporal-smoothing-adaptive.mjs
 */
import {
    resolveSmoothingParams, smoothSession, smoothFrame, removeSmoothing, restoreSmoothing,
    describeSmoothingConfig, SMOOTH_METHOD_ADAPTIVE,
} from '../pose/temporal-smoothing.js';
import { triangulateAndReproject, setTriangulationSettingsHooks } from '../pose/triangulation-core.js';
import {
    noteSmoothingRun, smoothingRunOf, writeSmoothingMetadata, readSmoothingMetadata,
} from '../import-export/smoothing-metadata.js';
import {
    Camera, Instance, InstanceGroup, POINT3D_STRIDE, pooledPoints3d, isPoints3dSmoothed,
} from '../pose/pose-data.js';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
    if (cond) passed++;
    else { failed++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function group(name) { console.log('\n• ' + name); }

const K = [[900, 0, 640], [0, 900, 512], [0, 0, 1]];
const CAMS = [
    new Camera('c0', K, [-0.2, 0.03, 0, 0, 0], [0, 0, 0], [0, 0, 700], [1280, 1024]),
    new Camera('c1', K, [-0.25, 0, 0, 0, 0], [0, 0.7, 0], [0, 0, 720], [1280, 1024]),
    new Camera('c2', K, [-0.15, 0, 0, 0, 0], [0.6, -0.2, 0], [0, 0, 690], [1280, 1024]),
    new Camera('c3', K, [0, 0, 0, 0, 0], [-0.5, -0.6, 0.1], [0, 0, 740], [1280, 1024]),
];
const NF = 120, NODES = 3, NOISE_PX = 1.5;

/**
 * Truth per identity and node: node 0 still, node 1 steady 1 mm/frame, node 2
 * a fast oscillation (up to ~6 mm/frame).
 */
function truth(id, k, f) {
    const base = id === 0 ? [-30, 10, 0] : [40, -20, 15];
    if (k === 0) return base;
    if (k === 1) return [base[0] + 5 + (f - 60) * 1.0, base[1] + 8, base[2]];
    return [base[0] - 6 + 25 * Math.sin(f / 4), base[1] - 4, base[2] + 10 * Math.cos(f / 3)];
}

/**
 * Build a session from a seed: 2D = distorted projection + noise in every
 * camera, 3D = DLT. `opts.drop(id, f, k, c)` true removes that observation
 * before the solve, `opts.hide` after it; `opts.skipFrame(f)` leaves a frame
 * out; `opts.noCameras` gives the session no calibration; `opts.lazy` releases
 * every member's 2D to a fake store.
 */
function buildSession(opts = {}) {
    let s = opts.seed || 777;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const instanceGroups = new Map();
    const store = new Map();   // `${cam}|${f}` -> rows [{xy}]
    for (let f = 0; f < NF; f++) {
        if (opts.skipFrame && opts.skipFrame(f)) continue;
        const groups = [];
        for (let id = 0; id < 2; id++) {
            const g = new InstanceGroup(id + 1, id);
            CAMS.forEach((cam, c) => {
                const pts = [];
                for (let k = 0; k < NODES; k++) {
                    const X = truth(id, k, f);
                    const p = cam.distortPoint(cam.project(X));
                    const obs = [p[0] + NOISE_PX * gauss(), p[1] + NOISE_PX * gauss()];
                    pts.push(opts.drop && opts.drop(id, f, k, c) ? null : obs);
                }
                const inst = new Instance(pts, id, 'predicted', 0.9);
                g.instances.set(cam.name, inst);
                if (opts.lazy) {
                    const key = cam.name + '|' + f;
                    const rows = store.get(key) || [];
                    inst._rawInstIndex = rows.length;
                    rows.push(Float64Array.from(inst._xy));
                    store.set(key, rows);
                }
            });
            const r = triangulateAndReproject(g, CAMS, { method: 'dlt', reprojErrorThreshold: 0, includedCameras: CAMS.map(c => c.name) });
            g.points3d = pooledPoints3d(r.points3d);
            // 2D taken away after the solve (an edit not yet re-solved): the 3D
            // stays, its views are gone.
            if (opts.hide) CAMS.forEach((cam, c) => {
                for (let k = 0; k < NODES; k++) if (opts.hide(id, f, k, c)) g.instances.get(cam.name)._xy[2 * k] = NaN;
            });
            g.triangulationMethod = 'dlt';
            groups.push(g);
        }
        instanceGroups.set(f, groups);
    }
    const session = { instanceGroups, cameras: opts.noCameras ? [] : CAMS };
    if (opts.lazy === 'frames') {
        // A loader that can only build whole frames (`getFrameSync`, as
        // `hydrateFrameMembers2d` reads it), not single store rows.
        for (const groups of instanceGroups.values()) for (const g of groups) for (const m of g.instances.values()) {
            m._xy = new Float64Array(m._xy.length).fill(NaN);
            m._lazy2d = true;
        }
        session.lazyLoader = {
            getFrameSync(f) {
                const out = new Map();
                for (const cam of CAMS) {
                    const rows = store.get(cam.name + '|' + f);
                    if (!rows) continue;
                    out.set(cam.name, rows.map(xy => ({
                        points: Array.from({ length: xy.length >> 1 }, (_, k) => (Number.isNaN(xy[2 * k]) ? null : [xy[2 * k], xy[2 * k + 1]])),
                        type: 'predicted', score: 0.9,
                    })));
                }
                return out;
            },
        };
    } else if (opts.lazy) {
        // Release every member's 2D, as `releaseFrameMembers2d` does.
        for (const groups of instanceGroups.values()) for (const g of groups) for (const m of g.instances.values()) {
            m._xy = new Float64Array(m._xy.length).fill(NaN);
            m._lazy2d = true;
        }
        session.lazyLoader = {
            storeRowPoints(cam, f, off) {
                const rows = store.get(cam + '|' + f);
                const xy = rows && rows[off];
                if (!xy) return null;
                const n = xy.length >> 1, x = new Float64Array(n), y = new Float64Array(n);
                for (let k = 0; k < n; k++) { x[k] = xy[2 * k]; y[k] = xy[2 * k + 1]; }
                return { x, y, start: 0, end: n };
            },
        };
    }
    return session;
}

const groupOf = (session, f, id) => (session.instanceGroups.get(f) || []).find(g => g.identityId === id);
const snapshot3d = (session) => {
    const out = [];
    for (const [f, groups] of session.instanceGroups) for (const g of groups) out.push([f, g.identityId, Array.from(g.points3d)]);
    return JSON.stringify(out, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v));
};
const ADAPTIVE = { smoothingMethod: 1 };

// ---------------------------------------------------------------------------
group('settings');
{
    const c = resolveSmoothingParams(ADAPTIVE);
    ok(c.method === SMOOTH_METHOD_ADAPTIVE && c.k === 3 && c.hmax === 15 && c.enabled, 'smoothingMethod 1: adaptive, k 3, hmax 15, enabled');
    ok(resolveSmoothingParams({ smoothingMethod: 'adaptive', smoothAtaHmax: 0 }).enabled === false, 'hmax 0 is off');
    ok(resolveSmoothingParams({ smoothingMethod: 1, smoothAtaK: -2 }).k === 3, 'a bad gate falls back to 3');
    ok(resolveSmoothingParams({}).method === 'windows' && !resolveSmoothingParams({}).enabled, 'no method: the windows, off by default (as before)');
    ok(resolveSmoothingParams({ smoothingMethod: 1, smoothMedianWindow: 0 }).enabled, 'adaptive needs no window');
    ok(/adaptive, gate 3 SD, up to 31 frames/.test(describeSmoothingConfig(c)), `described: "${describeSmoothingConfig(c)}"`);
}

// ---------------------------------------------------------------------------
group('it smooths, weighed by each point\'s views');
{
    const session = buildSession();
    const before = new Map();
    for (const [f, groups] of session.instanceGroups) for (const g of groups) before.set(f + '|' + g.identityId, Float64Array.from(g.points3d));
    const twoD = JSON.stringify(Array.from(groupOf(session, 30, 0).instances.get('c1')._xy));
    const r = smoothSession(session, ADAPTIVE);
    ok(r.ran && r.tracks === 2 && r.frames === 2 * NF, `both identities, every frame written (${r.tracks} tracks, ${r.frames} poses)`);
    ok(r.points === 2 * NF * NODES && r.fallbackPoints === 0, `every point weighed by its own views (${r.points} points, ${r.fallbackPoints} fallback)`);
    ok(JSON.stringify(Array.from(groupOf(session, 30, 0).instances.get('c1')._xy)) === twoD, '2D unchanged');
    ok(isPoints3dSmoothed(groupOf(session, 30, 0).points3d) && groupOf(session, 30, 0).triangulationMethod === 'dlt',
        'marked smoothed; the solver is still recorded');

    const stats = (id, k, which) => {
        let jit = 0, err = 0, n = 0, m = 0;
        for (let f = 15; f < NF - 15; f++) {
            const p = (ff) => which === 'raw' ? before.get(ff + '|' + id) : groupOf(session, ff, id).points3d;
            const o = k * POINT3D_STRIDE;
            const a = p(f - 1), b = p(f), c = p(f + 1);
            let d2 = 0, e2 = 0;
            for (let ax = 0; ax < 3; ax++) {
                const d = c[o + ax] - 2 * b[o + ax] + a[o + ax];
                d2 += d * d;
                const e = b[o + ax] - truth(id, k, f)[ax];
                e2 += e * e;
            }
            jit += Math.sqrt(d2); err += Math.sqrt(e2); n++; m++;
        }
        return { jit: jit / n, err: err / m };
    };
    const s0 = stats(0, 0, 'raw'), s1 = stats(0, 0, 'ata');
    ok(s1.jit < 0.4 * s0.jit && s1.err < 0.6 * s0.err,
        `still node: jitter ${s0.jit.toFixed(3)} -> ${s1.jit.toFixed(3)} mm, error ${s0.err.toFixed(3)} -> ${s1.err.toFixed(3)} mm`);
    const f0 = stats(1, 2, 'raw'), f1 = stats(1, 2, 'ata');
    ok(f1.err < f0.err * 1.1, `fast node: error not made worse (${f0.err.toFixed(3)} -> ${f1.err.toFixed(3)} mm)`);
    ok(r.meanWindow > 3, `mean window ${r.meanWindow.toFixed(1)} frames`);

    // A second run replaces the first: it reads the pre-smoothing source.
    const once = snapshot3d(session);
    smoothSession(session, ADAPTIVE);
    ok(snapshot3d(session) === once, 'a second run with the same settings writes the same 3D (never smooths its own output)');
}

// ---------------------------------------------------------------------------
group('This frame writes what All frames writes, bit for bit');
{
    const cases = [
        ['view covariances', {}, {}],
        ['the sigma fallback (no cameras)', { noCameras: true }, {}],
        // Node 1 of identity 0 seen by one camera on frames 40-49: those
        // samples take the fallback, beside view covariances everywhere else.
        ['both mixed', { hide: (id, f, k, c) => id === 0 && k === 1 && f >= 40 && f < 50 && c > 0 }, {}],
        ['a frame gap and gate 2, hmax 6', { skipFrame: f => f === 70 || f === 71 }, { smoothAtaK: 2, smoothAtaHmax: 6 }],
    ];
    for (const [label, sopts, extra] of cases) {
        const params = { ...ADAPTIVE, ...extra };
        const all = buildSession(sopts);
        const r = smoothSession(all, params);
        const each = buildSession(sopts);
        let fb = 0;
        for (const f of each.instanceGroups.keys()) fb += smoothFrame(each, params, f).fallbackPoints;
        ok(snapshot3d(each) === snapshot3d(all), `${label}: every frame equal (${r.points} points, ${r.fallbackPoints} fallback)`);
        if (label.startsWith('both')) ok(r.fallbackPoints === 10 && fb === 10, `  10 one-view samples take the fallback (${r.fallbackPoints}, This frame ${fb})`);
        if (label.startsWith('the sigma')) ok(r.fallbackPoints === r.points, '  every point takes the fallback');
    }
}

// ---------------------------------------------------------------------------
group('gaps are never filled');
{
    const session = buildSession({ drop: (id, f, k, c) => id === 1 && k === 0 && f === 60 && c > 0 });
    ok(Number.isNaN(groupOf(session, 60, 1).points3d[0]), '(fixture: node 0 of identity 1 has no 3D on frame 60)');
    smoothSession(session, ADAPTIVE);
    ok(Number.isNaN(groupOf(session, 60, 1).points3d[0]), 'still none after smoothing');
}

// ---------------------------------------------------------------------------
group('a lazy project\'s released members: read from the store, same 3D');
{
    const resident = buildSession();
    const lazy = buildSession({ lazy: true });
    ok(Number.isNaN(groupOf(lazy, 5, 0).instances.get('c0')._xy[0]), '(fixture: members released)');
    const a = smoothSession(resident, ADAPTIVE), b = smoothSession(lazy, ADAPTIVE);
    ok(snapshot3d(resident) === snapshot3d(lazy) && b.fallbackPoints === 0 && a.points === b.points,
        `same 3D, bit for bit, all from views (${b.points} points)`);
    const lazy2 = buildSession({ lazy: true });
    for (const f of lazy2.instanceGroups.keys()) smoothFrame(lazy2, ADAPTIVE, f);
    ok(snapshot3d(lazy2) === snapshot3d(lazy), 'This frame too');
    ok(Number.isNaN(groupOf(lazy, 5, 0).instances.get('c0')._xy[0]), 'no member was hydrated');
    const frames = buildSession({ lazy: 'frames' });
    smoothSession(frames, ADAPTIVE);
    ok(snapshot3d(frames) === snapshot3d(resident), 'a loader without store rows: each frame\'s members hydrated around the read, same 3D');
}

// ---------------------------------------------------------------------------
group('metadata.lucid.temporalSmoothing');
{
    const s = buildSession();
    smoothSession(s, ADAPTIVE);
    noteSmoothingRun(s, 'all', resolveSmoothingParams(ADAPTIVE));
    const lucid = {};
    writeSmoothingMetadata(lucid, s);
    ok(JSON.stringify(lucid.temporalSmoothing) === '{"scope":"all","method":"adaptive","k":3,"hmax":15}',
        `an adaptive run writes its method, gate and half-window (${JSON.stringify(lucid.temporalSmoothing)})`);
    const back = {};
    readSmoothingMetadata(back, lucid);
    const r = smoothingRunOf(back);
    ok(r.scope === 'all' && r.config.method === 'adaptive' && r.config.k === 3 && r.config.hmax === 15 && r.config.enabled,
        'and reads them back');

    const sig = buildSession();
    const P = { ...ADAPTIVE, smoothAtaCovariance: 'sigma', smoothAtaK: 2.5 };
    smoothSession(sig, P);
    noteSmoothingRun(sig, 'frame', resolveSmoothingParams(P));
    const l2 = {};
    writeSmoothingMetadata(l2, sig);
    ok(JSON.stringify(l2.temporalSmoothing) === '{"scope":"frame","method":"adaptive","k":2.5,"hmax":15,"covariance":"sigma"}',
        `the sigma-only comparison says so (${JSON.stringify(l2.temporalSmoothing)})`);

    // A windows run writes exactly the keys it always did (no method key).
    const w = buildSession();
    const W = { smoothGaussianWindow: 9, smoothMaxGap: 5, smoothMinSegment: 5 };
    smoothSession(w, W);
    noteSmoothingRun(w, 'all', resolveSmoothingParams(W));
    const l3 = {};
    writeSmoothingMetadata(l3, w);
    ok(JSON.stringify(l3.temporalSmoothing) === '{"scope":"all","medianWindow":0,"gaussianWindow":9,"maxGap":5,"minSegment":5}',
        `a windows run: unchanged keys (${JSON.stringify(l3.temporalSmoothing)})`);
    const b3 = {};
    readSmoothingMetadata(b3, l3);
    ok(smoothingRunOf(b3).config.method === 'windows' && smoothingRunOf(b3).config.gaussianWindow === 9, 'read back as a windows run');

    const bad = {};
    readSmoothingMetadata(bad, { temporalSmoothing: { scope: 'all', method: 'adaptive', k: 'x' } });
    ok(smoothingRunOf(bad).scope === 'all' && smoothingRunOf(bad).config === null, 'garbage settings: the scope only');
}

// ---------------------------------------------------------------------------
group('the solve\'s settings reach the covariances');
{
    // A 30 px outlier in c3 on identity 0's node 0, frame 50. With a 15 px
    // threshold the solve drops it, and so does the covariance.
    const drift = (sess) => {
        const g = groupOf(sess, 50, 0);
        const inst = g.instances.get('c3');
        inst._xy[0] += 30;
    };
    const plain = buildSession(); drift(plain);
    const thr = buildSession(); drift(thr);
    smoothSession(plain, ADAPTIVE);
    setTriangulationSettingsHooks({ getTrackingThreshold: (id) => (id === 'reprojErrorThreshold' ? 15 : 0) });
    try { smoothSession(thr, ADAPTIVE); } finally { setTriangulationSettingsHooks(null); }
    ok(snapshot3d(plain) !== snapshot3d(thr), 'the reprojection threshold changes the result');
    const excl = buildSession();
    setTriangulationSettingsHooks({ isCameraTracked: (n) => n !== 'c3' });
    try { smoothSession(excl, ADAPTIVE); } finally { setTriangulationSettingsHooks(null); }
    const all = buildSession(); smoothSession(all, ADAPTIVE);
    ok(snapshot3d(excl) !== snapshot3d(all), 'leaving a camera out (Camera Views) changes it too');
}

// ---------------------------------------------------------------------------
group('Remove / Restore smoothing');
{
    const run = (params, scope = 'all') => ({ scope, config: resolveSmoothingParams(params) });
    const s = buildSession();
    const raw = snapshot3d(s);
    smoothSession(s, ADAPTIVE);
    const smoothed = snapshot3d(s);
    const rm = removeSmoothing(s, run(ADAPTIVE));
    ok(rm.frames === 2 * NF && snapshot3d(s) === raw, 'Remove puts back the 3D from before smoothing');
    const back = restoreSmoothing(s, { ...ADAPTIVE, smoothMedianWindow: 9 });
    ok(back.restored && snapshot3d(s) === smoothed, 'Restore puts back exactly what was removed (a windows setting changed meanwhile: not stale)');
    for (const [label, params] of [
        ['a new gate', { ...ADAPTIVE, smoothAtaK: 4 }],
        ['a new longest window', { ...ADAPTIVE, smoothAtaHmax: 10 }],
        ['the windows method', { smoothingMethod: 0, smoothGaussianWindow: 9 }],
    ]) {
        const t = buildSession();
        smoothSession(t, ADAPTIVE);
        removeSmoothing(t, run(ADAPTIVE));
        const r = restoreSmoothing(t, params);
        ok(!r.restored && r.stale && snapshot3d(t) === raw, `${label}: stale, nothing written`);
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
    console.error('\nFailures:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
