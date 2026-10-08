/**
 * _bench-trail-window.mjs — what `ensureLazyTrailWindow` costs (investigation
 * tool, not an assertion). Synthetic lazy project at the real project's shape:
 * 8 cameras, 5 animals, 15 nodes.
 *   steady:   the per-redraw check during playback (window already resident)
 *   jump:     hydrating the whole window after a seek, for trail 10/100/500
 *   playback: 2,500 steps after a jump with the playback loader's load +
 *             eviction every 10 frames — frames the check builds (want 0)
 * Run: node tests/e2e/_bench-trail-window.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8297);
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
let browser;
try {
    browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 60000 });
    const r = await page.evaluate(async () => {
        const { SioLazyLoader } = await import('/loading/sio-lazy-loader.js');
        const tri = await import('/pose/triangulation.js');
        const ov = await import('/ui/overlays.js');
        const { Session } = await import('/pose/pose-data.js');
        const st = window.__lucid.state, SIO = window.SleapIO;
        const NF = 6000, CAMS = Array.from({ length: 8 }, (_, i) => 'cam' + i);
        const TRACKS = ['t0', 't1', 't2', 't3', 't4'];
        const NODES = Array.from({ length: 15 }, (_, i) => 'n' + i);
        async function slpBytes(cam) {
            const skeleton = new SIO.Skeleton({ name: 'sk', nodes: NODES });
            const video = new SIO.Video({ filename: cam + '.mp4', shape: [NF, 1024, 1280, 1] });
            const tracks = TRACKS.map(n => new SIO.Track(n));
            const lfs = [];
            for (let f = 0; f < NF; f++) {
                const insts = tracks.map((track, k) => new SIO.PredictedInstance({
                    points: NODES.map((_, n) => [100 + f * 0.1 + k * 50 + n, 100 + k * 50 + n]), skeleton, track, score: 0.9 }));
                lfs.push(new SIO.LabeledFrame({ video, frameIdx: f, instances: insts }));
            }
            return SIO.saveSlpToBytes(new SIO.Labels({ skeletons: [skeleton], videos: [video], tracks, labeledFrames: lfs }));
        }
        const loader = new SioLazyLoader();
        await Promise.all(CAMS.map(async cam => loader.open(cam, new File([await slpBytes(cam)], cam + '.slp'))));
        const fresh = () => {
            const s = new Session([], { name: 'sk', nodes: NODES, edges: [] }, loader.trackNames.slice(), 'b');
            s.lazyLoader = loader; st.sessions = [s]; st.session = s; st.triangulationResults = new Map();
            return s;
        };
        const med = (a) => { const b = a.slice().sort((x, y) => x - y); return +b[b.length >> 1].toFixed(4); };
        const out = {};
        // steady: window resident, as during playback
        let s = fresh();
        await tri.batchLoadLazyFrames(0, 1200);
        for (const L of [10, 100, 500]) {
            const ts = [];
            for (let rep = 0; rep < 20; rep++) {
                const t = performance.now();
                for (let i = 0; i < 1000; i++) tri.ensureLazyTrailWindow(1100, L);
                ts.push((performance.now() - t) / 1000 * 1000);   // us per call
            }
            const tw = [];
            for (let rep = 0; rep < 20; rep++) {
                const t = performance.now();
                for (let i = 0; i < 1000; i++) ov.trailWindowFrames(s.frameGroups, 1100, L, true);
                tw.push((performance.now() - t) / 1000 * 1000);
            }
            out['steady' + L] = { checkUs: med(ts), windowUs: med(tw) };
        }
        // jump: hydrate the whole window behind a cold frame
        for (const L of [10, 100, 500]) {
            const ms = [];
            for (let rep = 0; rep < 5; rep++) {
                s = fresh();
                for (const k of loader.cache.keys()) loader.releaseFrame(k);
                const f = 2000 + rep * 700;
                await tri.ensureLazyFrameData(f);
                const t = performance.now();
                tri.ensureLazyTrailWindow(f, L);
                ms.push(performance.now() - t);
            }
            out['jump' + L] = { ms: med(ms) };
        }
        // playback: after a jump, step frame by frame the way playback does —
        // the playback loader's batchLoadLazyFrames(cur, 600) + evictLazyFrames(cur)
        // every 10 frames — and count frames the trail check builds per step.
        // Expected: the jump builds the window once, playback builds nothing.
        const residency = await import('/pose/lazy-residency.js');
        for (const L of [10, 500]) {
            s = fresh();
            st.trailLength = L;
            let F = 3000;
            st.currentFrame = F;
            await tri.ensureLazyFrameData(F);
            let b0 = s.frameGroups.size;
            tri.ensureLazyTrailWindow(F, L);
            const jumpBuilt = s.frameGroups.size - b0;
            let playBuilt = 0, steps = 0, evictPasses = 0;
            for (let cur = F + 1; cur < F + 2500; cur++) {
                st.currentFrame = cur;
                if ((cur - F) % 10 === 1) {
                    await tri.batchLoadLazyFrames(cur, residency.LAZY_PLAYBACK_AHEAD);
                    if (tri.evictLazyFrames(cur)) evictPasses++;
                }
                b0 = s.frameGroups.size;
                tri.ensureLazyTrailWindow(cur, L);
                playBuilt += s.frameGroups.size - b0;
                steps++;
            }
            out['playback' + L] = { jumpBuilt, playBuilt, steps, evictPasses, resident: s.frameGroups.size };
        }
        st.trailLength = 0;
        return out;
    });
    console.log(JSON.stringify(r, null, 1));
} finally {
    if (browser) await browser.close();
    server.kill();
}
