/**
 * _diag-zoom-drag-perf.mjs — the headed fps harness for luc3d #200 ("zoom in
 * and node dragging slows down"). An investigation tool, not an assertion:
 * `tests/e2e/zoom-overlay-budget.mjs` is what pins the fix.
 *
 * Two things about it are load-bearing, and both took a wrong answer to find:
 *
 * - **Headed, and the window must not be OCCLUDED.** The cost is compositor-side
 *   raster of the oversized overlay canvas. A hidden tab suspends rAF and
 *   composites nothing, so it measures zero — and the JS time around
 *   `drawAllOverlays` is flat at ~2-4 ms at every zoom, so measuring there tells
 *   you nothing either.
 * - **It must zoom EVERY view, because that is what the app's own `+` key
 *   does** (`videoController.zoomAllVideos`; only the scroll wheel zooms one
 *   view). This is the difference between seeing the bug and not. One zoomed
 *   view at the pre-fix sizing is a 524 MB backing store, which an
 *   Apple-silicon GPU absorbs at a flat 120 fps — zooming only view 0 is why
 *   an earlier version of this harness concluded, wrongly, that the bug needed
 *   `--disable-gpu-rasterization` to show up at all. EIGHT zoomed views is
 *   ~4.2 GB, which it does not absorb. On DEFAULT Chrome (GPU on, no extra
 *   args), 8 cameras at 1280x1024 all zoomed, the pre-fix build measured:
 *
 *       zoom  1   42 MB   120   fps    9 ms worst   1351 ms drag wall
 *       zoom  4  671 MB    95.9 fps    9 ms worst   1695 ms
 *       zoom  8 2684 MB    52.1 fps   25 ms worst   4090 ms
 *       zoom 10 4194 MB    18.5 fps  292 ms worst   9100 ms
 *
 *   and after the fix, 120 fps / 9 ms / ~1340 ms at every zoom (212 MB at
 *   zoom 10). `EXTRA_ARGS=--disable-gpu-rasterization,--disable-accelerated-2d-canvas`
 *   remains useful for seeing the same effect with fewer views, since it takes
 *   the GPU out of the picture — but it is not required.
 *
 * Per zoom level it drags one node with real mouse input at a fixed ~125 Hz and
 * records rAF frames presented (fps), main-thread long tasks, and how far the
 * node actually got. `overlay RAM` is the sum over every view.
 *
 * Env: VIDEO=1280x1024 CAMS=8 ZOOMS=1,2,4,6,8,10 MOVES=80 ZOOM_ALL=1 EXTRA_ARGS=
 *
 * Run: node tests/e2e/_diag-zoom-drag-perf.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.REPO || path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8311);
const [VW, VH] = (process.env.VIDEO || '1280x1024').split('x').map(Number);
// 8 by default: the effect scales with how many views are zoomed at once, and
// a real multi-camera session is where the issue was reported from.
const NCAM = Number(process.env.CAMS || 8);
const ZOOMS = (process.env.ZOOMS || '1,2,4,6,8,10').split(',').map(Number);
const MOVES = Number(process.env.MOVES || 80);
// ZOOM_ALL=0 zooms only view 0 (the scroll-wheel gesture) instead of every view.
const ZOOM_ALL = process.env.ZOOM_ALL !== '0';
const MOVE_HZ = 125;

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));

const EXTRA = (process.env.EXTRA_ARGS || '').split(',').filter(Boolean);
const browser = await chromium.launch({
    headless: false,
    args: ['--window-position=0,0', '--window-size=1500,1000', ...EXTRA],
});
if (EXTRA.length) console.log('extra chromium args:', EXTRA.join(' '));
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', e => console.log('  pageerror:', String(e).slice(0, 200)));

try {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    await page.bringToFront();

    await page.evaluate(async ([VW, VH, NCAM]) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        const CAMS = Array.from({ length: NCAM }, (_, i) => 'cam' + String.fromCharCode(65 + i));
        const NODES = ['nose','head','neck','spine1','spine2','tail1','tail2','fl','fr','hl','hr','earL','earR'];
        const EDGES = [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[2,7],[2,8],[4,9],[4,10],[1,11],[1,12]];
        const K = [[900,0,VW/2],[0,900,VH/2],[0,0,1]];
        const cams = CAMS.map((n,i) => new Camera(n, K, [0,0,0,0,0], [0,0.2*i,0], [100*i,0,1500], [VW,VH]));
        const session = new Session(cams, new Skeleton('sk', NODES, EDGES), ['track_0','track_1'], 'Perf200');

        const NF = 300;
        for (let f = 0; f < NF; f++) {
            const fg = new FrameGroup(f); session.addFrameGroup(fg);
            const groups = [];
            for (let gi = 0; gi < 2; gi++) {
                const g = new InstanceGroup(10 + gi, f);
                for (const cam of CAMS) {
                    const cx = VW/2 + gi*80, cy = VH/2 + gi*50;
                    const pts = NODES.map((_, k) => [cx + (k % 4) * 15, cy + Math.floor(k / 4) * 15]);
                    const inst = new Instance(pts, gi, gi === 0 ? 'user' : 'predicted', 1);
                    g.addInstance(cam, inst); fg.addInstance(cam, inst);
                }
                groups.push(g);
            }
            session.instanceGroups.set(f, groups);
        }

        Object.assign(AS.state, {
            sessions: [session], activeSessionIdx: 0, session,
            totalFrames: NF, currentFrame: 0, fps: 30, isPlaying: false,
            triangulationResults: new Map(),
            views: CAMS.map(n => ({ name: n, videoWidth: VW, videoHeight: VH, canvas: null })),
            videoFiles: CAMS.map(n => ({ name: n, assignedCamera: n })),
            viewMode: 'grid', singleViewIndex: 0,
        });
        AS.paneManager.clearAll();
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
        await new Promise(r => requestAnimationFrame(r));
        sp.refreshPaneInteractions();
        await new Promise(r => requestAnimationFrame(r));
    }, [VW, VH, NCAM]);
    await page.waitForTimeout(800);

    await page.evaluate(() => {
        window.__perf = { frames: [], long: [], running: false };
        const po = new PerformanceObserver(list => {
            if (window.__perf.running) for (const e of list.getEntries()) window.__perf.long.push(e.duration);
        });
        try { po.observe({ entryTypes: ['longtask'] }); } catch (e) {}
        (function tick(t) { if (window.__perf.running) window.__perf.frames.push(t); requestAnimationFrame(tick); })();
    });

    /** Zoom to `scale` and park the instance's node 0 at the centre of its cell. */
    const setupZoom = (scale) => page.evaluate(async ([scale, zoomAll]) => {
        const AS = await import('/ui/app-state.js');
        const R  = await import('/ui/rendering.js');
        const vc = window.__lucid.videoController;
        const v = AS.state.views[0];
        const inst = AS.state.session.instanceGroups.get(AS.state.currentFrame)[0].getInstance(v.name);
        const vx = inst.getX(0), vy = inst.getY(0);

        const screenOfNode = () => {
            const r = v.overlayCanvas.getBoundingClientRect();
            return [r.left + (vx / v.videoWidth) * r.width, r.top + (vy / v.videoHeight) * r.height];
        };

        // Scale first with no pan, then translate the node to the cell centre.
        // The wrapper transform is translate(offset) scale(s), origin 0 0, so
        // screen position is linear in offset with coefficient exactly 1.
        // Every view, as the `+` key does, unless ZOOM_ALL=0.
        var targets = zoomAll ? AS.state.views : [v];
        for (var ti = 0; ti < targets.length; ti++) {
            var tv = targets[ti];
            if (!tv.zoom) vc.initZoom(tv);
            tv.zoom.scale = scale; tv.zoom.offsetX = 0; tv.zoom.offsetY = 0;
            vc._constrainOffsets(tv.zoom, tv);
            vc.applyZoom(tv);
        }
        // View 0 is the one dragged, so re-centre it from an unpanned state.
        v.zoom.offsetX = 0; v.zoom.offsetY = 0;
        vc.applyZoom(v);
        await new Promise(r => requestAnimationFrame(r));

        const cell = v.overlayCanvas.closest('.video-cell').getBoundingClientRect();
        const [nx, ny] = screenOfNode();
        v.zoom.offsetX += (cell.left + cell.width / 2) - nx;
        v.zoom.offsetY += (cell.top + cell.height / 2) - ny;
        vc._constrainOffsets(v.zoom, v);
        vc.applyZoom(v);
        await new Promise(r => requestAnimationFrame(r));

        // The backing store is resized inside drawAllOverlays, not applyZoom.
        R.drawAllOverlays(AS.state.currentFrame);
        await new Promise(r => requestAnimationFrame(r));

        const cell2 = v.overlayCanvas.closest('.video-cell').getBoundingClientRect();
        const screen = screenOfNode();
        return {
            scale: v.zoom.scale,
            backing: v.overlayCanvas.width + 'x' + v.overlayCanvas.height,
            mbAll: +(AS.state.views.reduce((a, vv) => a + vv.overlayCanvas.width * vv.overlayCanvas.height * 4, 0) / 1e6).toFixed(0),
            node: [vx, vy], screen,
            onScreen: screen[0] > cell2.left + 60 && screen[0] < cell2.right - 60 &&
                      screen[1] > cell2.top + 40 && screen[1] < cell2.bottom - 40,
        };
    }, [scale, ZOOM_ALL]);

    const snapNode = () => page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const v = AS.state.views[0];
        const inst = AS.state.session.instanceGroups.get(AS.state.currentFrame)[0].getInstance(v.name);
        return [inst.getX(0), inst.getY(0)];
    });

    console.log(`\nluc3d #200 repro — ${NCAM} cameras @ ${VW}x${VH}, ` +
        `${ZOOM_ALL ? 'ALL views zoomed (the + key)' : 'view 0 only (the scroll wheel)'}, ` +
        `drag ${MOVES} moves @ ~${MOVE_HZ}Hz, headed\n`);
    const rows = [];

    for (const z of ZOOMS) {
        const info = await setupZoom(z);
        if (!info.onScreen) { console.log(`  zoom ${z}: node off-screen, skipped`); continue; }

        const before = await snapNode();
        const [sx, sy] = info.screen;
        await page.mouse.move(sx, sy);
        await page.waitForTimeout(150);

        await page.evaluate(() => { window.__perf.frames = []; window.__perf.long = []; window.__perf.running = true; });
        await page.mouse.down();
        const t0 = Date.now();
        for (let i = 1; i <= MOVES; i++) {
            await page.mouse.move(sx + (i % 40) * 1.2 - 24, sy + Math.sin(i / 6) * 12);
            await page.waitForTimeout(1000 / MOVE_HZ);
        }
        const wall = Date.now() - t0;
        await page.mouse.up();
        const perf = await page.evaluate(() => { window.__perf.running = false; return { frames: window.__perf.frames, long: window.__perf.long }; });
        const after = await snapNode();

        const f = perf.frames;
        const span = f.length > 1 ? f[f.length - 1] - f[0] : 0;
        const fps = span > 0 ? (f.length - 1) / (span / 1000) : 0;
        const gaps = [];
        for (let i = 1; i < f.length; i++) gaps.push(f[i] - f[i - 1]);
        gaps.sort((a, b) => a - b);
        const p95 = gaps.length ? gaps[Math.floor(gaps.length * 0.95)] : 0;
        const blocking = perf.long.reduce((a, d) => a + Math.max(0, d - 50), 0);

        rows.push({
            zoom: z, backing: info.backing, mb: info.mbAll,
            fps: +fps.toFixed(1), worstFrameMs: +p95.toFixed(0),
            longTasks: perf.long.length, blockedMs: +blocking.toFixed(0),
            dragWallMs: wall,
            nodeMovedPx: +Math.hypot(after[0] - before[0], after[1] - before[1]).toFixed(1),
        });
        console.log('  ' + JSON.stringify(rows[rows.length - 1]));
        await page.waitForTimeout(400);
    }

    console.log('\n zoom | overlay backing/view | overlay RAM |   fps | worst frame | long tasks | blocked | drag wall');
    console.log('------+----------------------+-------------+-------+-------------+------------+---------+----------');
    for (const r of rows) {
        console.log(` ${String(r.zoom).padStart(4)} | ${r.backing.padStart(20)} | ${String(r.mb + ' MB').padStart(11)} | ` +
            `${String(r.fps).padStart(5)} | ${String(r.worstFrameMs + ' ms').padStart(11)} | ${String(r.longTasks).padStart(10)} | ` +
            `${String(r.blockedMs + ' ms').padStart(7)} | ${String(r.dragWallMs + ' ms').padStart(8)}`);
    }
} finally {
    await browser.close();
    server.kill();
}
