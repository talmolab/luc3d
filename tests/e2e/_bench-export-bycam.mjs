/**
 * _bench-export-bycam.mjs — where File ▸ Export SLEAP File By Cam spends its
 * time, on a synthetic project (investigation tool, not an assertion).
 *
 * Builds CAMS cameras × FRAMES frames × ANIMALS animals (predicted, grouped,
 * with reprojections when REPROJ=1), then times per camera:
 *   eager:  buildSlpLabelsMultiSession, SIO.saveSlpToBytes
 *   lazy:   exportSlpMultiSession on the reopened project (the streaming sweep)
 *   bycam:  every camera of the reopened project in one exportCamerasSlpStreaming
 *           call, Reprojections off (Download All's default): ROUTES lists the
 *           routes to time, default "default,sweep" ("store" forces the copy)
 * Run: PORT=9360 FRAMES=20000 node tests/e2e/_bench-export-bycam.mjs
 *      SKIP_EAGER=1 skips the per-camera eager/lazy timings.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9360);
const FRAMES = Number(process.env.FRAMES || 20000);
const CAMS = Number(process.env.CAMS || 4);
const ANIMALS = Number(process.env.ANIMALS || 5);
const NODES = Number(process.env.NODES || 10);
const ROUTES = process.env.ROUTES || '';
const SKIP_EAGER = !!process.env.SKIP_EAGER;

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));
let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(600000);
    page.on('console', m => { if (/\[export-slp-(store|streaming)\]/.test(m.text()) && !/ camera /.test(m.text())) console.log('  page: ' + m.text()); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    const out = await page.evaluate(async ({ FRAMES, CAMS, ANIMALS, NODES, ROUTES, SKIP_EAGER }) => {
        const [pd, fileio, AS] = await Promise.all([import('/pose/pose-data.js'), import('/import-export/file-io.js'), import('/ui/app-state.js')]);
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const cams = Array.from({ length: CAMS }, (_, i) => 'cam' + i);
        const nodes = Array.from({ length: NODES }, (_, i) => 'n' + i);
        const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
        const s = new Session(cams.map((n, i) => new Camera(n, M, [0, 0, 0, 0, 0], [0, 0.3 * i, 0], [0, 0, 40], [512, 512])),
            new Skeleton('skeleton', nodes, nodes.slice(1).map((_, j) => [j, j + 1])),
            Array.from({ length: ANIMALS }, (_, k) => 't' + k), 'Bench');
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            s.addFrameGroup(fg);
            const gs = [];
            for (let k = 0; k < ANIMALS; k++) {
                const g = new InstanceGroup(f * ANIMALS + k + 1, k);
                cams.forEach((cn, ci) => {
                    const inst = new Instance(nodes.map((_, j) => [50 + 40 * k + j + ci + (f % 7), 60 + 8 * j]), k, 'predicted', 0.9);
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
        const vfs = cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '/' + n + '.mp4', sessionIdx: 0 }));
        AS.state.videoFiles = vfs;
        const res = { eager: [], lazy: [] };
        const filter = { user: true, predicted: true, reprojected: false };
        for (let c = 0; c < (SKIP_EAGER ? 0 : Math.min(2, CAMS)); c++) {
            const sel = [{ session: s, cameraName: cams[c], videoFileInfo: vfs[c] }];
            let t0 = performance.now();
            const labels = fileio.buildSlpLabelsMultiSession(sel, null, filter);
            const tBuild = performance.now() - t0;
            t0 = performance.now();
            const bytes = await window.SleapIO.saveSlpToBytes(labels);
            const tSave = performance.now() - t0;
            t0 = performance.now();
            const blob = await fileio.exportSlpMultiSession(sel, null, filter);
            res.eager.push({ cam: cams[c], buildMs: Math.round(tBuild), h5Ms: Math.round(tSave), totalViaExportMs: Math.round(performance.now() - t0), MB: +(bytes.length / 1e6).toFixed(1), blobMB: +(blob.size / 1e6).toFixed(1) });
        }
        // Reopen lazily and time the streaming per-camera export (predicted off forces the sweep path).
        const bytes = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(s,
            cams.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: FRAMES })),
            cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }))));
        window.__tstLoad = { done: false, err: null };
        (async () => {
            try { await (await import('/loading/session-loader.js')).handleLoadProjectSlpLazy(new File([bytes], 'p.slp')); window.__tstLoad.done = true; }
            catch (e) { window.__tstLoad.err = String(e && e.stack || e).slice(0, 400); }
        })();
        for (let i = 0; i < 3000 && !window.__tstLoad.done && !window.__tstLoad.err; i++) {
            const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || '') && x.offsetParent);
            if (b) b.click();
            await new Promise(r => setTimeout(r, 100));
        }
        if (window.__tstLoad.err) return { err: window.__tstLoad.err };
        const ls = AS.state.session;
        res.lazyLoader = !!ls.lazyLoader;
        // reprojAsUser=false + reprojected:true is the user's setting (Reprojections on) → streaming sweep.
        for (let c = 0; c < (SKIP_EAGER ? 0 : Math.min(2, CAMS)); c++) {
            const sel = [{ session: ls, cameraName: cams[c], videoFileInfo: { name: cams[c] } }];
            const t0 = performance.now();
            const blob = await fileio.exportSlpMultiSession(sel, true, { user: true, predicted: true, reprojected: true });
            res.lazy.push({ cam: cams[c], ms: Math.round(performance.now() - t0), MB: +(blob.size / 1e6).toFixed(1) });
        }
        // By Cam's Download All with Reprojections off (the default): every
        // camera in one `exportCamerasSlpStreaming` call. 'default' is what the
        // dialog runs; 'sweep' forces the per-frame pass (where the route option
        // exists; on a build without it the default IS the per-frame pass).
        res.bycam = [];
        const all = cams.map(n => ({ cameraName: n, videoFileInfo: { videoPath: n + '.mp4' } }));
        const offFilter = { user: true, predicted: true, reprojected: false };
        for (const route of (ROUTES || 'default,sweep').split(',')) {
            const t0 = performance.now();
            const out = await fileio.exportCamerasSlpStreaming(ls, all, null, offFilter,
                route === 'default' ? {} : { route });
            res.bycam.push({ route, cameras: CAMS, ms: Math.round(performance.now() - t0),
                MBperCam: +(out.reduce((a, b) => a + b.length, 0) / CAMS / 1e6).toFixed(1) });
        }
        return res;
    }, { FRAMES, CAMS, ANIMALS, NODES, ROUTES, SKIP_EAGER });
    console.log(JSON.stringify({ FRAMES, CAMS, ANIMALS, NODES, ...out }, null, 1));
} finally {
    if (browser) await browser.close();
    server.kill();
}
