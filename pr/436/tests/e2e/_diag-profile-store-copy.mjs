/**
 * _diag-profile-store-copy.mjs — where By Cam's store copy
 * (`exportCamerasFromSharedStore`) spends its time on a reopened project
 * (investigation tool, not an assertion).
 *
 * Builds CAMS × FRAMES × ANIMALS predicted, grouped instances with NOISY float
 * coordinates and per-node scores (so gzip sees real-data entropy), saves and
 * reopens the project lazily, then runs the store copy with a CPU profile and
 * reports: copy total, time in the writer's appendRawRows, time in h5wasm's
 * write_slice (compression + HDF5), and the top self-time functions.
 *   GZIP=0 serves the bundle with the streaming tables' gzip removed.
 *   WORKERS=0 copies on the main thread; WORKERS=N uses N export workers.
 * Run: PORT=9361 FRAMES=40000 CAMS=2 NODES=14 node tests/e2e/_diag-profile-store-copy.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9361);
const FRAMES = Number(process.env.FRAMES || 40000);
const CAMS = Number(process.env.CAMS || 2);
const ANIMALS = Number(process.env.ANIMALS || 5);
const NODES = Number(process.env.NODES || 14);
const GZIP = process.env.GZIP !== '0';
const TOP = Number(process.env.TOP || 25);
const WORKERS = process.env.WORKERS;   // unset = default; 0 = this thread; N = that many

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));
let browser;
try {
    browser = await chromium.launch({ args: ['--js-flags=--max-old-space-size=8192'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(900000);
    if (!GZIP) {
        await page.route('**/lib/sleap-io/chunk-X76PRJK6.js*', async route => {
            const resp = await route.fetch();
            let body = await resp.text();
            const needle = 'chunks: [LUCID_COLUMN_CHUNK_ROWS, 1],\n    dtype,\n    compression: "gzip",\n    compression_opts: 1\n';
            if (!body.includes(needle)) throw new Error('gzip needle not found');
            body = body.replace(needle, 'chunks: [LUCID_COLUMN_CHUNK_ROWS, 1],\n    dtype\n');
            await route.fulfill({ response: resp, body });
        });
    }
    page.on('console', m => { if (/\[export-slp-store\]/.test(m.text()) && !/ camera /.test(m.text())) console.log('  page: ' + m.text()); });
    page.on('pageerror', e => console.log('  pageerror: ' + e.message));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    const setup = await page.evaluate(async ({ FRAMES, CAMS, ANIMALS, NODES }) => {
        const [pd, fileio, AS] = await Promise.all([import('/pose/pose-data.js'), import('/import-export/file-io.js'), import('/ui/app-state.js')]);
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const cams = Array.from({ length: CAMS }, (_, i) => 'cam' + i);
        const nodes = Array.from({ length: NODES }, (_, i) => 'n' + i);
        const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
        const s = new Session(cams.map((n, i) => new Camera(n, M, [0, 0, 0, 0, 0], [0, 0.3 * i, 0], [0, 0, 40], [1280, 1024])),
            new Skeleton('skeleton', nodes, nodes.slice(1).map((_, j) => [j, j + 1])),
            Array.from({ length: ANIMALS }, (_, k) => 't' + k), 'Bench');
        let seed = 12345;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        const pos = Array.from({ length: CAMS * ANIMALS }, () => [200 + 800 * rnd(), 200 + 600 * rnd()]);
        const sc = new Float64Array(NODES);
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            s.addFrameGroup(fg);
            const gs = [];
            for (let k = 0; k < ANIMALS; k++) {
                const g = new InstanceGroup(f * ANIMALS + k + 1, k);
                cams.forEach((cn, ci) => {
                    const p = pos[ci * ANIMALS + k];
                    p[0] += (rnd() - 0.5) * 6; p[1] += (rnd() - 0.5) * 6;
                    const inst = new Instance(nodes.map((_, j) => [p[0] + 3 * j + (rnd() - 0.5) * 4, p[1] + 2 * j + (rnd() - 0.5) * 4]), k, 'predicted', 0.5 + 0.5 * rnd());
                    for (let j = 0; j < NODES; j++) sc[j] = rnd();
                    inst.setPointScores(sc, 0);
                    inst._rawInstIndex = k;
                    fg.addInstance(cn, inst);
                    g.addInstance(cn, inst);
                });
                g.points3d = new Float64Array(NODES * 3).map((_, i) => i + k);
                gs.push(g);
            }
            s.instanceGroups.set(f, gs);
        }
        AS.state.sessions = [s]; AS.state.session = s; AS.state.activeSessionIdx = 0;
        AS.state.videoFiles = cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '/' + n + '.mp4', sessionIdx: 0 }));
        const bytes = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(s,
            cams.map(n => ({ name: n, videoWidth: 1280, videoHeight: 1024, frameCount: FRAMES })),
            cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }))));
        window.__tstLoad = { done: false, err: null };
        (async () => {
            try { await (await import('/loading/session-loader.js')).handleLoadProjectSlpLazy(new File([bytes], 'p.slp')); window.__tstLoad.done = true; }
            catch (e) { window.__tstLoad.err = String(e && e.stack || e).slice(0, 400); }
        })();
        for (let i = 0; i < 6000 && !window.__tstLoad.done && !window.__tstLoad.err; i++) {
            const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || '') && x.offsetParent);
            if (b) b.click();
            await new Promise(r => setTimeout(r, 100));
        }
        if (window.__tstLoad.err) return { err: window.__tstLoad.err };
        return { projectMB: +(bytes.length / 1e6).toFixed(1), lazy: !!AS.state.session.lazyLoader };
    }, { FRAMES, CAMS, ANIMALS, NODES });
    console.log('setup', JSON.stringify(setup));
    if (setup.err) throw new Error(setup.err);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await page.evaluate(() => {
        const SIO = window.SleapIO;
        const T = window.__prof = { raw: 0, rawCalls: 0, slice: 0, sliceCalls: 0, close: 0 };
        const open = SIO.openSlpWriter;
        let patched = false;
        SIO.openSlpWriter = async function (...a) {
            const w = await open.apply(this, a);
            if (!patched && w.file) {
                // h5wasm Dataset.write_slice: compression + HDF5 bookkeeping.
                w.file.create_dataset({ name: '__probe', data: new Float64Array(1), shape: [1], dtype: '<d' });
                const proto = Object.getPrototypeOf(w.file.get('__probe'));
                const ws = proto.write_slice;
                proto.write_slice = function (...b) { const t = performance.now(); try { return ws.apply(this, b); } finally { T.slice += performance.now() - t; T.sliceCalls++; } };
                patched = true;
            }
            const ar = w.appendRawRows.bind(w);
            w.appendRawRows = function (r) { const t = performance.now(); try { return ar(r); } finally { T.raw += performance.now() - t; T.rawCalls++; } };
            const cl = w.close.bind(w);
            w.close = function () { const t = performance.now(); try { return cl(); } finally { T.close += performance.now() - t; } };
            return w;
        };
    });
    await cdp.send('Profiler.start');
    const res = await page.evaluate(async ({ CAMS, WORKERS }) => {
        const fileio = await import('/import-export/file-io.js');
        const AS = await import('/ui/app-state.js');
        const ls = AS.state.session;
        const all = Array.from({ length: CAMS }, (_, i) => ({ cameraName: 'cam' + i, videoFileInfo: { videoPath: 'cam' + i + '.mp4' } }));
        const t0 = performance.now();
        const out = await fileio.exportCamerasSlpStreaming(ls, all, null, { user: true, predicted: true, reprojected: false }, { route: 'store', ...(WORKERS == null ? {} : { workers: Number(WORKERS) === 0 ? false : Number(WORKERS) }) });
        return { ms: Math.round(performance.now() - t0), MBperCam: +(out.reduce((a, b) => a + b.length, 0) / CAMS / 1e6).toFixed(1), prof: window.__prof };
    }, { CAMS, WORKERS });
    const { profile } = await cdp.send('Profiler.stop');
    // Self time per function from the sampled profile.
    const byId = new Map(profile.nodes.map(n => [n.id, n]));
    const self = new Map();
    const dts = profile.timeDeltas;
    for (let i = 0; i < profile.samples.length; i++) {
        const n = byId.get(profile.samples[i]);
        const cf = n.callFrame;
        const key = (cf.functionName || '(anon)') + ' ' + (cf.url || '').split('/').slice(-1)[0].split('?')[0] + ':' + cf.lineNumber;
        self.set(key, (self.get(key) || 0) + (dts[i] || 0) / 1000);
    }
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP);
    const p = res.prof;
    console.log(JSON.stringify({ FRAMES, CAMS, ANIMALS, NODES, GZIP, totalMs: res.ms, MBperCam: res.MBperCam,
        appendRawRowsMs: Math.round(p.raw), appendRawRowsCalls: p.rawCalls,
        writeSliceMs: Math.round(p.slice), writeSliceCalls: p.sliceCalls, closeMs: Math.round(p.close) }, null, 1));
    console.log('top self time (ms, of ' + Math.round(total) + ' sampled):');
    for (const [k, v] of top) console.log('  ' + String(Math.round(v)).padStart(7) + '  ' + k);
} finally {
    if (browser) await browser.close();
    server.kill();
}
