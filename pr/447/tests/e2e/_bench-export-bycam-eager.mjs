/**
 * _bench-export-bycam-eager.mjs — where By Cam spends its time on a FULLY
 * LOADED (eager) project (investigation tool, not an assertion).
 *
 * Builds an eager session of CAMS cameras × FRAMES frames × ANIMALS animals ×
 * NODES nodes (predicted, grouped), then:
 *   per camera (first PER cameras): buildSlpLabelsMultiSession, saveSlpToBytes
 *   all cameras: the By Cam route for eager cameras (exportCamerasInWorkers when
 *   present, WORKERS=0 forces this thread) vs a loop of exportSlpMultiSession.
 * GZIP=0 serves the bundle with the eager 2D tables' gzip removed.
 * Run: PORT=9361 FRAMES=30000 CAMS=8 node tests/e2e/_bench-export-bycam-eager.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9361);
const FRAMES = Number(process.env.FRAMES || 30000);
const CAMS = Number(process.env.CAMS || 8);
const ANIMALS = Number(process.env.ANIMALS || 5);
const NODES = Number(process.env.NODES || 15);
const PER = Number(process.env.PER || 2);
const GZIP = process.env.GZIP !== '0';
const WORKERS = process.env.WORKERS;
const LOOP = process.env.LOOP !== '0';

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));
let browser;
try {
    browser = await chromium.launch({ args: ['--js-flags=--max-old-space-size=8192'] });
    const page = await browser.newPage();
    page.setDefaultTimeout(1800000);
    if (!GZIP) {
        await page.route('**/lib/sleap-io/chunk-X76PRJK6.js*', async route => {
            const resp = await route.fetch();
            let body = await resp.text();
            const needle = '    dtype: this.dtype\n  };\n  if (this.gzip) {';
            if (!body.includes(needle)) throw new Error('gzip needle not found');
            body = body.replace(needle, '    dtype: this.dtype\n  };\n  if (false) {');
            await route.fulfill({ response: resp, body });
        });
    }
    page.on('console', m => { if (/\[export-slp-/.test(m.text())) console.log('  page: ' + m.text()); });
    page.on('pageerror', e => console.log('  pageerror: ' + e.message));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    const out = await page.evaluate(async ({ FRAMES, CAMS, ANIMALS, NODES, PER, WORKERS, LOOP }) => {
        const [pd, fileio, AS] = await Promise.all([import('/pose/pose-data.js'), import('/import-export/file-io.js'), import('/ui/app-state.js')]);
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const cams = Array.from({ length: CAMS }, (_, i) => 'cam' + i);
        const nodes = Array.from({ length: NODES }, (_, i) => 'n' + i);
        const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
        const s = new Session(cams.map((n, i) => new Camera(n, M, [0, 0, 0, 0, 0], [0, 0.3 * i, 0], [0, 0, 40], [1280, 1024])),
            new Skeleton('skeleton', nodes, nodes.slice(1).map((_, j) => [j, j + 1])),
            Array.from({ length: ANIMALS }, (_, k) => 't' + k), 'Bench');
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            s.addFrameGroup(fg);
            const gs = [];
            for (let k = 0; k < ANIMALS; k++) {
                const g = new InstanceGroup(f * ANIMALS + k + 1, k);
                cams.forEach((cn, ci) => {
                    const inst = new Instance(nodes.map((_, j) => [50 + 40 * k + j + ci + Math.sin(f * 0.01 + j) * 30, 60 + 8 * j + Math.cos(f * 0.013 + k) * 20]), k, 'predicted', 0.9);
                    inst._rawInstIndex = k;
                    fg.addInstance(cn, inst);
                    g.addInstance(cn, inst);
                });
                gs.push(g);
            }
            s.instanceGroups.set(f, gs);
        }
        AS.state.sessions = [s]; AS.state.session = s; AS.state.activeSessionIdx = 0;
        const vfs = cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '/' + n + '.mp4', sessionIdx: 0 }));
        AS.state.videoFiles = vfs;
        const filter = { user: true, predicted: true, reprojected: false };
        const res = { per: [] };
        for (let c = 0; c < Math.min(PER, CAMS); c++) {
            const sel = [{ session: s, cameraName: cams[c], videoFileInfo: vfs[c] }];
            let t0 = performance.now();
            const labels = fileio.buildSlpLabelsMultiSession(sel, null, filter);
            const tBuild = performance.now() - t0;
            t0 = performance.now();
            const bytes = await window.SleapIO.saveSlpToBytes(labels);
            res.per.push({ cam: cams[c], buildMs: Math.round(tBuild), saveMs: Math.round(performance.now() - t0), MB: +(bytes.length / 1e6).toFixed(1) });
        }
        const sels = cams.map((cn, i) => ({ session: s, cameraName: cn, videoFileInfo: vfs[i] }));
        if (LOOP) {
            let t0 = performance.now();
            for (const sel of sels) await fileio.exportSlpMultiSession([sel], null, filter);
            res.loopMs = Math.round(performance.now() - t0);
        }
        if (typeof fileio.exportCamerasInWorkers === 'function') {
            const opts = WORKERS != null ? { workers: Number(WORKERS) } : {};
            let t0 = performance.now();
            const r = await fileio.exportCamerasInWorkers(sels, null, filter, opts);
            res.eagerRouteMs = Math.round(performance.now() - t0);
            res.eagerRouteMB = r.map(b => b ? +(b.length / 1e6).toFixed(1) : null);
        }
        return res;
    }, { FRAMES, CAMS, ANIMALS, NODES, PER, WORKERS, LOOP });
    console.log(JSON.stringify({ FRAMES, CAMS, ANIMALS, NODES, GZIP, ...out }, null, 1));
} finally {
    if (browser) await browser.close();
    server.kill();
}
