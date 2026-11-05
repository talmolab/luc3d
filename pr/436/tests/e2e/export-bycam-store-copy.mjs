/**
 * export-bycam-store-copy.mjs — File ▸ Export SLEAP File By Cam on a project
 * reopened with Load Project copies each camera's rows out of the shared store
 * (`exportCamerasFromSharedStore`, import-export/file-io.js) instead of
 * hydrating every frame, and writes what the per-frame pass writes.
 *
 * Fixture: 3 cameras x FRAMES (9,000) frames x 2 animals, so every table of
 * every camera's file is past 8,192 rows (the writer's buffer and gzip
 * switch). Each prediction carries its own per-node scores (one NaN), some
 * nodes are missing, some instances are the user's (one with a node stored
 * placed-but-invisible), some unlinked, some trackless. After reopening:
 *   - RESIDENT edits the store does not have: a user-edited instance, a deleted
 *     instance, an added user instance;
 *   - in-memory drift on NON-resident frames: a group member's track and
 *     another's score changed without touching the store;
 *   - an ungrouped row on a non-resident frame (the pass writes group members
 *     first, so that frame's instances come out in a different order than
 *     the store's rows).
 *
 *  1. Both routes (`opts.route` 'store' and 'sweep') write, per camera, the same
 *     four tables value for value — frames, instances (type, track, score, ids,
 *     ranges), user points and predicted points with their per-node scores and
 *     visibility — in the same order. A node the file stores as placed but not
 *     visible stays not visible in both (hydration applies the file's flag,
 *     `lazyRowInstance` in pose/lazy-residency.js).
 *  2. Negative controls: the comparison fails for the bare store (resident
 *     edits and drift dropped), for the copy with only the added instance's
 *     frame hidden, without per-node scores (no score column), or without the
 *     drift frames and member order (no group members). Hiding a frame whose
 *     group member was edited cannot drop the edit: the drift scan sends that
 *     frame to hydration instead.
 *  3. The default route takes the store copy (its console line), and the drift
 *     frames are the two expected ones.
 *  4. Export workers (`import-export/slp-rows-worker.js`, the default): the
 *     store copy written and gzipped in one worker per camera equals the copy
 *     on this thread (`opts.workers: false`) value for value, with the same
 *     chunking and filters per table; and with `Worker` unavailable the copy
 *     falls back to this thread and still writes the same tables.
 *
 * Run: PORT=9371 node tests/e2e/export-bycam-store-copy.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9371);
const FRAMES = Number(process.env.FRAMES || 9000);
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 600) : ''));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(600000);
    const errs = [];
    const logs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { const t = m.text(); if (/export-slp-store|per-frame pass/.test(t)) logs.push(t); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });

    console.log('Building and reopening the project');
    const loadErr = await page.evaluate(async (FRAMES) => {
        const [pd, fileio] = await Promise.all([import('/pose/pose-data.js'), import('/import-export/file-io.js')]);
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session, UnlinkedInstance } = pd;
        const cams = ['cam0', 'cam1', 'cam2'];
        const nodes = ['n0', 'n1', 'n2', 'n3'];
        const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
        const s = new Session(cams.map((n, i) => new Camera(n, M, [0, 0, 0, 0, 0], [0, 0.3 * i, 0], [0, 0, 40], [512, 512])),
            new Skeleton('skeleton', nodes, [[0, 1], [1, 2], [2, 3]]), ['t0', 't1', 't2'], 'StoreCopy');
        let gid = 1;
        const mk = (f, ci, k, type) => {
            const pts = nodes.map((_, j) => ((f + 3 * j + 5 * ci + k) % 97 === 0) ? null
                : [40 + 30 * k + 7 * j + ci + (f % 11) * 0.25, 50 + 9 * j + k + (f % 13) * 0.5]);
            const inst = new Instance(pts, k, type, 0.5 + 0.01 * ((f + ci + k) % 40));
            if (type === 'predicted') {
                inst.setPointScores(nodes.map((_, j) => (j === 3 && f % 13 === 0) ? NaN : 0.1 + 0.2 * j + 0.001 * ((f + ci) % 50)));
            }
            return inst;
        };
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            s.addFrameGroup(fg);
            const gs = [];
            for (let k = 0; k < 2; k++) {
                const g = new InstanceGroup(gid++, k);
                cams.forEach((cn, ci) => {
                    const user = f % 1000 === 7 && k === 0;
                    const inst = mk(f, ci, k, user ? 'user' : 'predicted');
                    // A user node saved placed but not visible.
                    if (user && f % 2000 === 7 && inst.hasPoint(1)) inst.setOccluded(1, true);
                    inst._rawInstIndex = k;
                    fg.addInstance(cn, inst);
                    g.addInstance(cn, inst);
                });
                g.points3d = new Float64Array(12).map((_, i) => i + k);
                gs.push(g);
            }
            s.instanceGroups.set(f, gs);
            // Unlinked: a tracked prediction in cam1 every 50 frames, a trackless one in cam2 every 77.
            if (f % 50 === 3) fg.addUnlinkedInstance('cam1', new UnlinkedInstance(mk(f, 1, 2, 'predicted'), 'cam1'));
            if (f % 77 === 5) {
                const tl = mk(f, 2, 2, 'predicted');
                tl.trackIdx = null;
                fg.addUnlinkedInstance('cam2', new UnlinkedInstance(tl, 'cam2'));
            }
        }
        const views = cams.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: FRAMES }));
        const videoFiles = cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const bytes = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(s, views, videoFiles));
        window.__tstLoad = { done: false, err: null };
        (async () => {
            try { await (await import('/loading/session-loader.js')).handleLoadProjectSlpLazy(new File([bytes], 'store-copy.slp')); window.__tstLoad.done = true; }
            catch (e) { window.__tstLoad.err = String(e && e.stack || e).slice(0, 500); }
        })();
        for (let i = 0; i < 1200 && !window.__tstLoad.done && !window.__tstLoad.err; i++) {
            const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || '') && x.offsetParent);
            if (b) b.click();
            await new Promise(r => setTimeout(r, 100));
        }
        if (window.__tstLoad.err) return window.__tstLoad.err;
        const st = window.__lucid.state;
        if (!st.session.lazyLoader || !st.session.lazyLoader._sharedStore) return 'not a shared-store lazy project';
        return null;
    }, FRAMES);
    check(!loadErr, 'project reopened lazily from one file', loadErr || undefined);

    console.log('Editing: resident edits, and in-memory drift on non-resident frames');
    const edits = await page.evaluate(async () => {
        const [pd, tri] = await Promise.all([import('/pose/pose-data.js'), import('/pose/triangulation.js')]);
        const { Instance, UnlinkedInstance } = pd;
        const s = window.__lucid.state.session;
        await tri.batchLoadLazyFrames(200, 60);
        const out = {};
        // 1. A user edit on frame 210, cam0 (pins the frame).
        const fg210 = s.frameGroups.get(210);
        const e = fg210.instances.get('cam0')[0];
        e._ownXY();
        e.setPoint(2, 123.25, 234.5);
        e.type = 'user';
        e.modified = true;
        out.edited = [e.getX(2), e.getY(2)];
        // 2. A deletion on frame 220 (pinned by a user edit in cam0): cam1's second member goes.
        const fg220 = s.frameGroups.get(220);
        const p = fg220.instances.get('cam0')[0];
        p.type = 'user';
        const c1 = fg220.instances.get('cam1');
        const gone = c1.splice(1, 1)[0];
        for (const g of s.instanceGroups.get(220)) if (g.instances.get('cam1') === gone) g.instances.delete('cam1');
        out.c1After = c1.length;
        // 3. An added user instance on frame 230, cam2.
        const fg230 = s.frameGroups.get(230);
        fg230.addUnlinkedInstance('cam2', new UnlinkedInstance(
            new Instance([[11, 12], [13, 14], null, [15, 16]], 2, 'user', 0), 'cam2'));
        // 4. Drift on non-resident frames: a member's track, another's score.
        out.resident5000 = s.frameGroups.has(5000) || s.frameGroups.has(6000);
        s.instanceGroups.get(5000)[0].instances.get('cam0').trackIdx = 2;
        s.instanceGroups.get(6000)[1].instances.get('cam1').score = 0.123;
        // 5. Frame 7000 (not resident): cam2's first row leaves its group, so the
        //    per-frame pass writes the still-grouped row 1 before it.
        s.instanceGroups.get(7000)[0].instances.delete('cam2');
        return out;
    });
    check(edits.c1After === 1 && !edits.resident5000, 'edits made (frames 5000/6000 not resident)', edits);

    console.log('Exporting both routes');
    const res = await page.evaluate(async () => {
        const fileio = await import('/import-export/file-io.js');
        const s = window.__lucid.state.session;
        const cams = ['cam0', 'cam1', 'cam2'].map(n => ({ cameraName: n, videoFileInfo: { videoPath: n + '.mp4' } }));
        const filter = { user: true, predicted: true, reprojected: false };
        const h5 = await import('h5wasm');
        await h5.ready;
        let seq = 0;
        const tables = (bytes) => {
            const p = '/__sc_' + (seq++) + '.slp';
            h5.FS.writeFile(p, bytes);
            const f = new h5.File(p, 'r');
            const out = {};
            for (const name of ['frames', 'instances', 'points', 'pred_points']) {
                const d = f.get(name);
                out[name] = { shape: d.shape, cols: JSON.parse(d.attrs.field_names.value), v: Array.from(d.value, Number),
                    layout: JSON.stringify({ chunks: d.metadata.chunks, filters: d.filters, dtype: d.dtype }) };
            }
            f.close();
            h5.FS.unlink(p);
            return out;
        };
        const ctx = fileio.sharedStoreCopyContext(s, null, filter);
        if (ctx.blocker) return { err: 'blocker: ' + ctx.blocker };
        const drift = ['cam0', 'cam1', 'cam2'].map(c => fileio.storeCopyDriftFrames(s, ctx, c, filter));
        const resident = [...s.frameGroups.keys()];
        const t0 = performance.now();
        const store = await fileio.exportCamerasSlpStreaming(s, cams, null, filter, { route: 'store' });
        const tStore = performance.now() - t0;
        const auto = await fileio.exportCamerasSlpStreaming(s, cams, null, filter);
        const mainThread = await fileio.exportCamerasSlpStreaming(s, cams, null, filter, { route: 'store', workers: false });
        const RealWorker = window.Worker;
        window.Worker = function () { throw new Error('no workers in this test'); };
        let fellBack;
        try { fellBack = await fileio.exportCamerasSlpStreaming(s, cams, null, filter, { route: 'store' }); }
        finally { window.Worker = RealWorker; }
        // Negative controls: the copy with resident edits, per-node scores or drift frames dropped.
        // (a) The bare store: no resident frames, no group members.
        const bare = Object.create(s);
        bare.frameGroups = { get: () => undefined, has: () => false, delete: () => false, keys: () => [][Symbol.iterator]() };
        bare.instanceGroups = new Map();
        const noEdits = await fileio.exportCamerasFromSharedStore(bare, cams, ctx, filter, { force: true });
        // (b) Only the frame with the added instance hidden (its rows are not drift).
        const real = s.frameGroups;
        const noAdded = Object.create(s);
        noAdded.frameGroups = {
            get: k => k === 230 ? undefined : real.get(k),
            has: k => k !== 230 && real.has(k),
            delete: k => real.delete(k),
            keys: () => [...real.keys()].filter(k => k !== 230)[Symbol.iterator](),
        };
        const noAddedOut = await fileio.exportCamerasFromSharedStore(noAdded, cams, ctx, filter, { force: true });
        const noScores = await fileio.exportCamerasFromSharedStore(s, cams,
            Object.assign({}, ctx, { pps: Object.assign({}, ctx.pps, { score: null }) }), filter, { force: true });
        const noGroups = Object.create(s);
        noGroups.instanceGroups = new Map();
        const noDrift = await fileio.exportCamerasFromSharedStore(noGroups, cams, ctx, filter, { force: true });
        const t1 = performance.now();
        const sweep = await fileio.exportCamerasSlpStreaming(s, cams, null, filter, { route: 'sweep' });
        const tSweep = performance.now() - t1;
        return {
            drift, resident, tStore: Math.round(tStore), tSweep: Math.round(tSweep),
            store: store.map(tables), auto: auto.map(tables), sweep: sweep.map(tables),
            mainThread: mainThread.map(tables), fellBack: fellBack.map(tables),
            noEdits: noEdits.map(tables), noAdded: noAddedOut.map(tables), noScores: noScores.map(tables), noDrift: noDrift.map(tables),
        };
    });
    if (res.err) { check(false, res.err); throw new Error(res.err); }
    console.log(`  store copy ${res.tStore} ms, per-frame pass ${res.tSweep} ms`);

    const same = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));
    // Differences between two exports of one camera, value for value.
    function diff(A, B) {
        const out = { other: [] };
        for (const name of ['frames', 'instances', 'points', 'pred_points']) {
            const a = A[name], b = B[name];
            if (JSON.stringify(a.shape) !== JSON.stringify(b.shape) || JSON.stringify(a.cols) !== JSON.stringify(b.cols)) {
                out.other.push(`${name}: shape ${JSON.stringify(a.shape)} vs ${JSON.stringify(b.shape)}`);
                continue;
            }
            const nc = a.cols.length;
            for (let i = 0; i < a.v.length; i++) {
                if (same(a.v[i], b.v[i])) continue;
                const r = Math.floor(i / nc), c = i % nc;
                if (out.other.length < 5) out.other.push(`${name}[${r}].${a.cols[c]}: ${a.v[i]} vs ${b.v[i]}`);
                else out.other.length === 5 && out.other.push('…');
            }
        }
        return out;
    }

    console.log('1. Same tables from both routes');
    // Nodes the file holds placed-but-invisible: user instances (k = 0) on
    // frames f % 2000 === 7, node 1 where placed, every camera. Both routes
    // must write each of them visible 0.
    const expectInvisible = (ci) => {
        let n = 0;
        for (let f = 7; f < FRAMES; f += 2000) if ((f + 3 + 5 * ci) % 97 !== 0) n++;
        return n;
    };
    const invisibleUserNodes = (T) => {
        const p = T.points, nc = p.cols.length, xi = p.cols.indexOf('x'), vi = p.cols.indexOf('visible');
        let n = 0;
        for (let r = 0; r < p.shape[0]; r++) if (Number.isFinite(p.v[r * nc + xi]) && p.v[r * nc + vi] === 0) n++;
        return n;
    };
    check(res.resident.length > 0 && res.resident.length < 200, 'a few frames resident at export', res.resident.length);
    ['cam0', 'cam1', 'cam2'].forEach((cam, ci) => {
        const S = res.sweep[ci], T = res.store[ci];
        const rows = ['frames', 'instances', 'points', 'pred_points'].map(n => T[n].shape[0]);
        check(rows[0] > 8192 && rows[1] > 8192 && rows[3] > 8192 && rows[2] > 0,
            `${cam}: frames/instances/pred_points past 8,192 rows, user points present`, rows);
        const d = diff(S, T);
        check(d.other.length === 0, `${cam}: store copy = per-frame pass, value for value (visibility included)`, d.other);
        const inv = [invisibleUserNodes(S), invisibleUserNodes(T)];
        check(inv[0] === expectInvisible(ci) && inv[1] === expectInvisible(ci),
            `${cam}: both routes write the ${expectInvisible(ci)} placed-but-invisible node(s) visible 0`, inv);
        const da = diff(T, res.auto[ci]);
        check(da.other.length === 0, `${cam}: the default route writes the store copy`, da);
    });
    const sc = res.store[0].pred_points, scoreCol = sc.cols.indexOf('score');
    const distinct = new Set();
    for (let r = 0; r < sc.shape[0]; r++) distinct.add(sc.v[r * sc.cols.length + scoreCol].toFixed(3));
    check(distinct.size > 100, 'per-node scores are each node\'s own (many distinct values)', distinct.size);

    console.log('2. Negative controls: the comparison catches a dropped edit, score or drift frame');
    const anyDiff = (X) => [0, 1, 2].some(ci => diff(res.sweep[ci], X[ci]).other.length > 0);
    check(anyDiff(res.noEdits), 'the bare store differs (edit, deletion, addition and drift lost)');
    check(diff(res.sweep[2], res.noAdded[2]).other.length > 0, 'copy without the added instance\'s frame differs');
    check(anyDiff(res.noScores), 'copy without per-node scores differs');
    check(anyDiff(res.noDrift), 'copy without the drift frames differs');

    console.log('3. Drift frames and route');
    check(res.drift[0].includes(5000) && res.drift[1].includes(6000) &&
        res.drift.flat().every(f => f === 5000 || f === 6000), 'drift frames: 5000 (cam0 track), 6000 (cam1 score)', res.drift);
    check(logs.some(l => /\[export-slp-store\] 3 camera\(s\) from the store/.test(l)), 'the store copy logged its run', logs.slice(-3));

    console.log('4. Export workers');
    ['cam0', 'cam1', 'cam2'].forEach((cam, ci) => {
        const W = res.store[ci], M = res.mainThread[ci];
        check(diff(M, W).other.length === 0, `${cam}: workers = this thread, value for value`, diff(M, W).other);
        const lay = ['frames', 'instances', 'points', 'pred_points'].filter(n => W[n].layout !== M[n].layout)
            .map(n => `${n}: ${W[n].layout} vs ${M[n].layout}`);
        check(lay.length === 0, `${cam}: workers = this thread, same chunks, filters and dtypes`, lay);
        check(diff(M, res.fellBack[ci]).other.length === 0, `${cam}: without Worker the copy falls back and writes the same`);
    });
    check(/gzip|deflate|"1"|id":1/i.test(res.store[0].pred_points.layout), 'pred_points is gzipped in the worker\'s file', res.store[0].pred_points.layout);
    check(logs.some(l => /from the store: .*\(3 workers\)/.test(l)), 'the default copy ran in 3 workers', logs.filter(l => /from the store/.test(l)));
    check(logs.some(l => /from the store: .*\(this thread\)/.test(l)), 'workers: false copied on this thread');
    check(logs.some(l => /export workers unavailable/.test(l)), 'the fallback said why');
    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
