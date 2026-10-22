/**
 * node-trail-width.mjs — a node trail is as thick as the skeleton edges of the
 * instance it traces, never thicker.
 *
 * Trails used to start at TWICE the User edge weight whatever they traced, so a
 * trail of predictions (edge weight 2 by default) started at 6 px beside 2 px
 * edges. Now the newest segment takes the edge weight of its instance's type —
 * Visibility ▸ User or Predictions ▸ Edge Weight — and thins toward the past.
 *
 * Asserted through the real Visibility sliders and the real `drawAllOverlays`
 * path, on a project of PREDICTED instances:
 *  1. the newest trail segment of each animal is exactly as wide as the
 *     predicted skeleton edges stroked in the same frame;
 *  2. no trail segment is wider than those edges, and older ones are thinner;
 *  3. moving Predictions ▸ Edge Weight moves both together;
 *  4. moving User ▸ Edge Weight leaves a trail of predictions alone.
 *
 * Run: node tests/e2e/node-trail-width.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8299);
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined && !c ? '  ' + JSON.stringify(extra).slice(0, 600) : ''));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1700, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.evaluate(() => { try { localStorage.removeItem('visibilitySettings'); } catch (e) { /* none */ } });
    await page.reload();
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 60000 });

    // Two predicted animals walking circles, with skeleton edges. Every stroke
    // on the overlay is recorded with its width from the frame's opening
    // clearRect. Trails draw first (behind everything), so a frame's first
    // TRACKS × trailLength strokes are trail segments, newest first per animal.
    await page.evaluate(async () => {
        const { SioLazyLoader } = await import('/loading/sio-lazy-loader.js');
        const tri = await import('/pose/triangulation.js');
        const { Session } = await import('/pose/pose-data.js');
        const st = window.__lucid.state;
        const SIO = window.SleapIO;
        const NF = 200, W = 480, H = 320;
        const TRACKS = ['t0', 't1'];
        const NODES = ['nose', 'mid', 'tail'];
        const at = (f, k, n) => {
            const r = k ? 70 : 110, th = f * 0.05 + k * 2.4 - n * 0.22;
            return [W / 2 + r * Math.cos(th), H / 2 + r * Math.sin(th) * 0.8];
        };
        const skeleton = new SIO.Skeleton({ name: 'sk', nodes: NODES });
        const video = new SIO.Video({ filename: 'camA.mp4', shape: [NF, H, W, 1] });
        const tracks = TRACKS.map(n => new SIO.Track(n));
        const lfs = [];
        for (let f = 0; f < NF; f++) {
            lfs.push(new SIO.LabeledFrame({ video, frameIdx: f, instances: tracks.map((track, k) => new SIO.PredictedInstance({
                points: NODES.map((_, n) => at(f, k, n)), skeleton, track, score: 0.9 })) }));
        }
        const bytes = await SIO.saveSlpToBytes(new SIO.Labels({ skeletons: [skeleton], videos: [video], tracks, labeledFrames: lfs }));
        const loader = new SioLazyLoader();
        await loader.open('camA', new File([bytes], 'camA.slp'));
        const session = new Session([], { name: 'sk', nodes: NODES, edges: [[0, 1], [1, 2]] }, loader.trackNames.slice(), 'width');
        session.lazyLoader = loader;
        st.sessions = [session];
        st.session = session;
        st.totalFrames = NF;
        st.triangulationResults = new Map();

        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        const strokes = window.__widthRec = [];
        const clearRect = ctx.clearRect.bind(ctx), stroke = ctx.stroke.bind(ctx);
        ctx.clearRect = (...a) => { strokes.length = 0; return clearRect(...a); };
        ctx.stroke = (...a) => { strokes.push(ctx.lineWidth); return stroke(...a); };
        st.views = [{ name: 'camA', overlayCanvas: canvas, overlayCtx: ctx, videoWidth: W, videoHeight: H, zoom: { scale: 1 } }];
        st.trailLength = 10;
        st.currentFrame = 100;
        await tri.batchLoadLazyFrames(60, 80);
    });

    const L = 10, TRACKS = 2;
    // Draw, then split the record into trail segments (per animal, newest
    // first) and everything else (the skeletons).
    const measure = () => page.evaluate(async ({ L, TRACKS }) => {
        const r = await import('/ui/rendering.js');
        r.drawAllOverlays(window.__lucid.state.currentFrame);
        await new Promise(res => setTimeout(res, 50));
        const s = window.__widthRec.slice();
        const fg = window.__lucid.state.session.frameGroups.get(window.__lucid.state.currentFrame);
        const types = fg.getUnlinkedInstances('camA').map(u => u.instance.type);
        const trails = [];
        for (let t = 0; t < TRACKS; t++) trails.push(s.slice(t * L, (t + 1) * L));
        return { trails, rest: s.slice(TRACKS * L), types };
    }, { L, TRACKS });
    const setSlider = (id, v) => page.evaluate(({ id, v }) => {
        const el = document.getElementById(id);
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }, { id, v });
    const sliderVal = (id) => page.evaluate((id) => Number(document.getElementById(id).value), id);

    const pred0 = await sliderVal('visPredEdgeWeight'), user0 = await sliderVal('visUserEdgeWeight');
    let m = await measure();
    check(m.types.length === 2 && m.types.every(t => t === 'predicted'), `the frame holds two predicted instances (${m.types})`);
    check(m.rest.includes(pred0), `the predicted skeleton edges are stroked at Predictions ▸ Edge Weight (${pred0} px)`, m.rest);
    check(m.trails.every(t => t[0] === pred0), `1. each animal's newest trail segment is ${pred0} px, the same as those edges`, m.trails);
    check(m.trails.every(t => t.every(w => w <= pred0) && t.every((w, i) => i === 0 || w <= t[i - 1]) && t[L - 1] < t[0]),
        '2. no segment is wider than the edges, and older segments are thinner', m.trails);
    check(user0 !== pred0 && m.trails.every(t => t[0] !== 2 * user0),
        `the trail no longer starts at twice the User edge weight (${2 * user0} px)`, m.trails);

    await setSlider('visPredEdgeWeight', 6);
    m = await measure();
    check(m.rest.includes(6) && m.trails.every(t => t[0] === 6),
        '3. Predictions ▸ Edge Weight 6: the edges and the newest trail segments are both 6 px', { trails: m.trails, rest: m.rest });

    await setSlider('visUserEdgeWeight', 9);
    m = await measure();
    check(m.trails.every(t => t[0] === 6), '4. User ▸ Edge Weight 9 leaves a trail of predictions at 6 px', m.trails);

    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
