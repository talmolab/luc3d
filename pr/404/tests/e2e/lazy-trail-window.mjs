/**
 * lazy-trail-window.mjs — after a JUMP on a lazy project, node trails show the
 * frames just behind the new frame, never the frames left over from where the
 * playhead used to be.
 *
 * On a lazy project `session.frameGroups` is a residency window, so a frame
 * missing from it means "not hydrated", not "not labelled". A seek hydrates
 * the target frame plus 30 frames in the scrub direction — not the frames
 * BEHIND it — and `trailWindowFrames` used to read the missing frames as
 * unlabelled and keep walking back (sparse-project semantics) until it reached
 * whatever was still resident from before the jump. Every trail then ran from
 * each animal's position now to where it was thousands of frames earlier: the
 * long straight lines seen after picking a row in the ID Switches tab.
 *
 * The fixture makes that measurable: every node drifts DRIFT px per frame, so
 * a real trail segment is DRIFT long and one that bridges a jump is hundreds of
 * px. The skeleton has no edges, so the only other strokes on the overlay are
 * the predicted-node crosses, a few px each.
 *
 * Asserted through the real `navigateToFrame` -> `drawAllOverlays` path:
 *  1. a forward jump (the target's own hydration does not reach behind it);
 *  2. a backward jump with a trail longer than the 30-frame prefetch;
 *  3. the trail is COMPLETE after each jump — every segment of the window is
 *     drawn, because the frames behind the target are hydrated for it;
 *  4. a frame the window cannot hydrate breaks the trail instead of bridging
 *     (the lazy rule in `trailWindowFrames`, checked on its own).
 *
 * Run: node tests/e2e/lazy-trail-window.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8296);
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
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 60000 });

    const r = await page.evaluate(async () => {
        const { SioLazyLoader } = await import('/loading/sio-lazy-loader.js');
        const tri = await import('/pose/triangulation.js');
        const init = await import('/pose/initialization.js');
        const ov = await import('/ui/overlays.js');
        const { Session } = await import('/pose/pose-data.js');
        const st = window.__lucid.state;
        const SIO = window.SleapIO;

        const NF = 4000, W = 512, H = 512, DRIFT = 0.25;
        const CAMS = ['camA', 'camB'];
        const TRACKS = ['t0', 't1'];
        const NODES = ['nose', 'mid', 'tail'];
        const xAt = (f, k, n) => 10 + f * DRIFT + k * 40 + n * 6;
        const yAt = (f, k, n) => 60 + k * 150 + n * 6;

        async function slpBytes(cam) {
            const skeleton = new SIO.Skeleton({ name: 'sk', nodes: NODES });
            const video = new SIO.Video({ filename: cam + '.mp4', shape: [NF, H, W, 1] });
            const tracks = TRACKS.map(n => new SIO.Track(n));
            const lfs = [];
            for (let f = 0; f < NF; f++) {
                const insts = tracks.map((track, k) => new SIO.PredictedInstance({
                    points: NODES.map((_, n) => [xAt(f, k, n), yAt(f, k, n)]), skeleton, track, score: 0.9 }));
                lfs.push(new SIO.LabeledFrame({ video, frameIdx: f, instances: insts }));
            }
            return SIO.saveSlpToBytes(new SIO.Labels({ skeletons: [skeleton], videos: [video], tracks, labeledFrames: lfs }));
        }
        const loader = new SioLazyLoader();
        await Promise.all(CAMS.map(async cam => loader.open(cam, new File([await slpBytes(cam)], cam + '.slp'))));

        const session = new Session([], { name: 'sk', nodes: NODES, edges: [] }, loader.trackNames.slice(), 'trails');
        session.lazyLoader = loader;
        st.sessions = [session];
        st.session = session;
        st.totalFrames = NF;
        st.triangulationResults = new Map();

        // One overlay canvas per camera, recording every moveTo -> lineTo
        // segment of the most recent draw (`drawFrameOverlays` opens with a
        // clearRect, which starts a new record).
        const rec = {};
        const savedViews = st.views;
        st.views = CAMS.map(cam => {
            const canvas = document.createElement('canvas');
            canvas.width = W; canvas.height = H;
            canvas.style.width = W + 'px';
            const ctx = canvas.getContext('2d');
            const segs = rec[cam] = [];
            let at = null;
            const clearRect = ctx.clearRect.bind(ctx), moveTo = ctx.moveTo.bind(ctx), lineTo = ctx.lineTo.bind(ctx);
            ctx.clearRect = (...a) => { segs.length = 0; return clearRect(...a); };
            ctx.moveTo = (x, y) => { at = [x, y]; return moveTo(x, y); };
            ctx.lineTo = (x, y) => { if (at) segs.push(Math.hypot(x - at[0], y - at[1])); at = [x, y]; return lineTo(x, y); };
            return { name: cam, overlayCanvas: canvas, overlayCtx: ctx, videoWidth: W, videoHeight: H, zoom: { scale: 1 } };
        });

        const settle = async (f) => {
            // navigateToFrame -> drawAllOverlays; a non-resident frame hydrates
            // asynchronously and redraws when it lands.
            const t0 = performance.now();
            while (!session.frameGroups.has(f) && performance.now() - t0 < 10000) await new Promise(r => setTimeout(r, 10));
            await new Promise(r => setTimeout(r, 50));
        };
        // Per view: trail segments are DRIFT px long, a bridge is anything far
        // longer than a node cross; a complete trail is every segment of the window.
        const measure = (L) => {
            const out = {};
            for (const cam of CAMS) {
                const segs = rec[cam];
                out[cam] = {
                    trail: segs.filter(d => Math.abs(d - DRIFT) < 1e-6).length,
                    bridges: segs.filter(d => d > 40).map(d => +d.toFixed(1)),
                    want: TRACKS.length * NODES.length * L,
                };
            }
            return out;
        };

        // Played from A: A and the playback lookahead are resident, as after a
        // stretch of playback that stopped at A.
        const A = 1000, B = 3000, C = 2200;
        st.trailLength = 10;
        st.currentFrame = A;
        await tri.batchLoadLazyFrames(A - 20, 620);
        init.navigateToFrame(A);
        await settle(A);
        const atA = measure(10);

        // 1. Forward jump (the ID Switches tab's row click is a seek).
        init.navigateToFrame(B);
        await settle(B);
        const atB = measure(10);
        const residentBehindB = Array.from({ length: 10 }, (_, i) => session.frameGroups.has(B - 1 - i)).every(Boolean);

        // 2. Backward jump with a trail longer than the 30-frame scrub prefetch.
        st.trailLength = 50;
        init.navigateToFrame(C);
        await settle(C);
        const atC = measure(50);

        // 4. The lazy window rule itself: a hole in residency ends the window.
        const holey = new Map([[100, 1], [99, 1], [98, 1], [40, 1], [39, 1]]);
        const lazyWin = ov.trailWindowFrames(holey, 100, 4, true);
        const eagerWin = ov.trailWindowFrames(holey, 100, 4);

        st.views = savedViews;
        return { atA, atB, atC, residentBehindB, lazyWin, eagerWin };
    });

    console.log('Node trails on a lazy project:');
    for (const [label, m] of [['before the jump (frame 1000)', r.atA], ['after a forward jump to 3000', r.atB],
                              ['after a backward jump to 2200, 50-frame trail', r.atC]]) {
        for (const cam of Object.keys(m)) {
            check(m[cam].bridges.length === 0, `${label}, ${cam}: no segment bridges back across the jump`, m[cam].bridges);
            check(m[cam].trail === m[cam].want, `${label}, ${cam}: the whole trail is drawn (${m[cam].want} segments)`, m[cam]);
        }
    }
    check(r.residentBehindB, 'the frames behind the jump target were hydrated for the trail');
    check(JSON.stringify(r.lazyWin) === '[100,99,98]', 'lazy window stops at the first non-resident frame', r.lazyWin);
    check(JSON.stringify(r.eagerWin) === '[100,99,98,40,39]', 'eager window still skips unlabelled frames (sparse, like SLEAP)', r.eagerWin);
    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
