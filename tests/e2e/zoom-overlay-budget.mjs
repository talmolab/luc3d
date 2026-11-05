/**
 * zoom-overlay-budget.mjs — the overlay backing store stays bounded under zoom,
 * and what the user SEES does not change (luc3d #200).
 *
 * `ui/rendering.js` used to size the overlay canvas to `videoW * zoomScale`.
 * That held backing-pixels-per-screen-pixel constant, but grew the canvas as
 * zoom² while the cell still showed only a cell-sized window onto it — at zoom
 * 10 on a 1280x1024 view, 12800x10240 (524 MB) to display ~283x226 — and the
 * app's `+` key zooms EVERY view, so a real 8-camera session allocated ~4.2 GB.
 * On default (GPU-accelerated) Chrome that dropped a node drag from 120 fps to
 * 18.5, and past Chrome's canvas limits it made the overlay go silently BLANK.
 *
 * Four things are pinned here, and §1 and §4 are the ones that would catch a
 * regression to the old formula:
 *   1. the backing store stays within a budget, and within Chrome's hard limits
 *   2. an UNZOOMED view is byte-for-byte what it always was (no blanket change)
 *   3. a node's on-screen size is constant across zoom (the invariant the old
 *      supersampling existed to protect, which the fix has to preserve)
 *   4. anti-aliasing never falls below 2 backing px per screen px — bounding by
 *      devicePixelRatio alone regressed this on a non-retina display
 *
 * Plus §5: the canvas Chrome actually gave us is drawable, which is the only
 * direct test of the blank-overlay failure (a canvas over the limit reports its
 * requested size and silently discards every draw).
 *
 * And §6-8, the visible window (`ui/overlay-window.js`): a zoomed-in overlay
 * allocates and draws only the part of the video the pane shows (plus a pan
 * margin) — §1's bound alone still sized it to the whole zoomed video, ~480 MB
 * for one 1920x1200 camera at zoom 10 in a solo pane — follows a pan or zoom
 * out past that margin, and is drawn exactly where the full canvas would be.
 *
 * Run: node tests/e2e/zoom-overlay-budget.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8313);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const MAX_DIM = 16384;
const MAX_AREA = 268435456;
const ZOOMS = [1, 2, 4, 6, 8, 10];

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    /** Build a two-camera project at the given video size, one isolated node. */
    const build = (VW, VH) => page.evaluate(async ([VW, VH]) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        const CAMS = ['camA', 'camB'];
        const K = [[900, 0, VW / 2], [0, 900, VH / 2], [0, 0, 1]];
        const cams = CAMS.map((n, i) => new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [100 * i, 0, 1500], [VW, VH]));
        // ONE node and NO edges on purpose: §3 measures the drawn blob's AREA,
        // and an edge running out of it would be counted as part of the node.
        const session = new Session(cams, new Skeleton('sk', ['a'], []), ['track_0'], 'Budget');
        const fg = new FrameGroup(0); session.addFrameGroup(fg);
        const g = new InstanceGroup(10, 0);
        for (const cam of CAMS) {
            const inst = new Instance([[VW / 2, VH / 2]], 0, 'user', 1);
            g.addInstance(cam, inst); fg.addInstance(cam, inst);
        }
        session.instanceGroups.set(0, [g]);

        Object.assign(AS.state, {
            sessions: [session], activeSessionIdx: 0, session,
            totalFrames: 1, currentFrame: 0, fps: 30, isPlaying: false,
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
    }, [VW, VH]);

    /**
     * Zoom view 0 about its cell centre (the node is at the video centre, so it
     * stays on screen) and report its backing store + the drawn node's
     * geometry. A zoomed-in overlay is a WINDOW onto the full virtual canvas
     * (`ui/overlay-window.js`), so the node is looked up at its full-canvas
     * position mapped into the window (`fullToWindow`).
     */
    const measure = (scale) => page.evaluate(async (scale) => {
        const AS = await import('/ui/app-state.js');
        const R = await import('/ui/rendering.js');
        const vc = window.__lucid.videoController;
        const v = AS.state.views[0];
        if (!v.zoom) vc.initZoom(v);
        vc._clearZoom(v);
        const cell = v.canvas.closest('.video-cell');
        vc._zoomAbout(v, scale, scale, cell.clientWidth / 2, cell.clientHeight / 2);
        vc._constrainOffsets(v.zoom, v); vc.applyZoom(v);
        await new Promise(r => requestAnimationFrame(r));
        R.drawAllOverlays(0);
        await new Promise(r => requestAnimationFrame(r));

        const c = v.overlayCanvas;
        const plan = v._overlayPlan;
        const bw = c.width, bh = c.height;
        const fw = plan.fullW, fh = plan.fullH;
        const s = Math.min(fw / v.videoWidth, fh / v.videoHeight);
        const ox = (fw - v.videoWidth * s) / 2, oy = (fh - v.videoHeight * s) / 2;
        const OW = await import('/ui/overlay-window.js');
        const wpt = OW.fullToWindow(plan, ox + (v.videoWidth / 2) * s, oy + (v.videoHeight / 2) * s);
        const cx = Math.round(wpt[0]), cy = Math.round(wpt[1]);

        // The drawn blob's AREA, not a single ray out from the centre. A ray
        // gives an integer radius in backing pixels, and the fix deliberately
        // makes that radius fractional (nodeSize * ss/zs), so ray-measuring
        // reports a ±0.5 px quantisation as if it were the size drifting.
        // Area averages over every pixel: r = sqrt(N/pi).
        //
        // FLOOD FILL from the node's centre rather than counting the whole
        // window: the view also draws a track LABEL a few pixels away, and a
        // plain area count silently measures the text as part of the node.
        const RAD = 60;
        const W = RAD * 2;
        const ctx = c.getContext('2d');
        const img = ctx.getImageData(cx - RAD, cy - RAD, W, W).data;
        const solid = (x, y) => x >= 0 && y >= 0 && x < W && y < W && img[(y * W + x) * 4 + 3] > 8;
        const seen = new Uint8Array(W * W);
        let n = 0;
        const stack = [[RAD, RAD]];
        while (stack.length) {
            const [x, y] = stack.pop();
            if (!solid(x, y) || seen[y * W + x]) continue;
            seen[y * W + x] = 1; n++;
            stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
        const rx = Math.sqrt(n / Math.PI);

        // Screen px per backing px from the FULL virtual canvas over the video
        // box (the window's own element size is a fractional CSS size that
        // offsetWidth would round).
        const boxW = parseFloat(v.canvas.style.width) || v.canvas.offsetWidth;
        const screenPerBacking = boxW > 0 ? (boxW * scale) / fw : 0;
        return {
            zoom: scale,
            videoW: v.videoWidth, videoH: v.videoHeight,
            bw, bh, fw, fh, windowed: plan.windowed, cssW: boxW,
            drewAnything: rx > 0,
            nodeRadiusScreenPx: rx * screenPerBacking,
            backingPxPerScreenPx: screenPerBacking > 0 ? 1 / screenPerBacking : 0,
        };
    }, scale);

    // ---- 1280x1024: the budget, the invariants ---------------------------
    console.log('\n§1-4  1280x1024 view across zoom 1..10');
    await build(1280, 1024);
    await page.waitForTimeout(600);

    const rows = [];
    for (const z of ZOOMS) rows.push(await measure(z));
    for (const r of rows) {
        console.log(`      zoom ${String(r.zoom).padStart(2)}: backing ${r.bw}x${r.bh}` +
            (r.windowed ? ` (window onto ${r.fw}x${r.fh})` : '') +
            `, node r ${r.nodeRadiusScreenPx.toFixed(2)} screen px` +
            `, ${r.backingPxPerScreenPx.toFixed(2)} backing px/screen px`);
    }

    // §2 — the unzoomed view is untouched. This is what makes the whole change
    // safe: whatever the budget does, zoom 1 renders as it always has.
    const z1 = rows[0];
    check(z1.bw === 1280 && z1.bh === 1024,
        `zoom 1 backing store is the video's own size (${z1.bw}x${z1.bh})`);

    // §1 — the budget. The old formula was videoW*zs, so zoom 10 was 12800 wide;
    // asserting well under that is what fails on a regression to it.
    const BUDGET_DIM = 8192;
    const worst = rows.reduce((a, r) => (r.bw > a.bw ? r : a), rows[0]);
    check(rows.every(r => r.bw <= BUDGET_DIM && r.bh <= BUDGET_DIM),
        `backing store stays within the ${BUDGET_DIM}px budget at every zoom ` +
        `(worst: ${worst.bw}x${worst.bh} at zoom ${worst.zoom})`);
    check(rows.every(r => r.bw <= MAX_DIM && r.bh <= MAX_DIM && r.bw * r.bh <= MAX_AREA),
        'and within Chrome\'s hard canvas limits (16384px/side, 2^28 px area)');
    // Negative control: the pre-fix formula WOULD have breached the budget here,
    // so §1 is testing the fix rather than restating an easy truth.
    check(1280 * 10 > BUDGET_DIM,
        `negative control: the old videoW*zoom sizing would have been ` +
        `${1280 * 10}x${1024 * 10} at zoom 10, over the budget`);

    // §3 — constant on-screen node size. The tolerance is a fifth of a pixel:
    // the residual is the rasteriser quantising a fractional radius to whole
    // backing pixels, not the size actually drifting.
    const radii = rows.map(r => r.nodeRadiusScreenPx);
    const rMin = Math.min(...radii), rMax = Math.max(...radii);
    check(rMin > 0 && (rMax - rMin) <= 0.25,
        `node keeps a constant on-screen size across zoom ` +
        `(${rMin.toFixed(2)}..${rMax.toFixed(2)} screen px)`);

    // §4 — anti-aliasing floor. Bounding by devicePixelRatio alone took a
    // non-retina display to 1.0 here and made circles visibly chunkier.
    const aaMin = Math.min(...rows.map(r => r.backingPxPerScreenPx));
    check(aaMin >= 1.99,
        `never drops below 2 backing px per screen px (min ${aaMin.toFixed(2)})`);

    check(rows.every(r => r.drewAnything), 'the node is actually drawn at every zoom');

    // ---- 5. the blank-overlay class --------------------------------------
    // 2048x1536 at zoom 10 was 20480x15360 under the old formula: over Chrome's
    // 16384px limit, which it accepts silently and then discards every draw.
    console.log('\n§5  2048x1536 view at zoom 10 (the blank-overlay case)');
    await build(2048, 1536);
    await page.waitForTimeout(600);
    const big = await measure(10);
    console.log(`      backing ${big.bw}x${big.bh}`);
    check(big.bw <= MAX_DIM && big.bh <= MAX_DIM && big.bw * big.bh <= MAX_AREA,
        `backing store is within Chrome's limits (${big.bw}x${big.bh})`);
    check(big.drewAnything,
        'and the overlay actually has pixels in it — not a silently blank canvas');
    check(2048 * 10 > MAX_DIM,
        `negative control: the old sizing would have asked for ${2048 * 10}px, ` +
        `over Chrome's ${MAX_DIM}px limit`);

    // ---- 6-8. the visible window -----------------------------------------
    // A solo-sized pane of a 1920x1200 camera at zoom 10. Bounding the
    // supersample (§1) still sized a canvas over the WHOLE zoomed video —
    // 13920x8700, ~480 MB — redrawn on every mouse move of a node drag. Only
    // the visible part (plus the pan margin) is allocated now.
    console.log('\n§6-8  1920x1200, one view filling the dock, zoom 10');
    await build(1920, 1200);
    await page.evaluate(async () => {
        const uw = await import('/ui/ui-wiring.js');
        const AS = await import('/ui/app-state.js');
        uw.enterSingleViewMode(); uw.setSoloView(AS.state.views[0].name);
    });
    await page.waitForTimeout(800);
    const soloFit = await measure(1);
    const solo = await measure(10);
    const cellPx = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const OW = await import('/ui/overlay-window.js');
        const cell = AS.state.views[0].canvas.closest('.video-cell');
        return { w: cell.clientWidth, h: cell.clientHeight, margin: OW.OVERLAY_WINDOW_MARGIN,
                 q: Math.max(2, devicePixelRatio || 1) };
    });
    console.log(`      cell ${cellPx.w}x${cellPx.h} CSS px; backing ${solo.bw}x${solo.bh}, ` +
        `a window onto ${solo.fw}x${solo.fh}`);
    // §6 — the allocation is about the PANE (times the quality ratio and the
    // margin), not the zoomed video: what the old sizing would have needed is
    // the full virtual canvas.
    // What the cell shows, in box CSS px, grown by the margin on each side and
    // rounded out to whole CSS px (+2), in full-canvas px per box px.
    const kx = solo.fw / solo.cssW;
    const winMax = (n) => (n / 10 * (1 + 2 * cellPx.margin) + 2) * kx;
    check(solo.windowed, 'a zoomed-in view draws a window, not the whole zoomed video');
    check(solo.bw <= winMax(cellPx.w) && solo.bh <= winMax(cellPx.h),
        `backing ${solo.bw}x${solo.bh} is about the pane (${cellPx.w}x${cellPx.h} CSS px, ` +
        `${(1 + 2 * cellPx.margin).toFixed(2)}x margin, ${kx.toFixed(2)} backing px per box px)`);
    check(solo.fw * solo.fh > 8 * solo.bw * solo.bh,
        `negative control: the full canvas (${solo.fw}x${solo.fh}) is many times the window`);
    check(solo.drewAnything, 'and the node in it is drawn');
    check(Math.abs(solo.nodeRadiusScreenPx - soloFit.nodeRadiusScreenPx) <= 0.25,
        `at the same on-screen size as unzoomed (${solo.nodeRadiusScreenPx.toFixed(2)} vs ` +
        `${soloFit.nodeRadiusScreenPx.toFixed(2)} screen px)`);

    // §7 — panning. Inside the margin nothing is redrawn or reallocated; past
    // it (or on a zoom out) the window follows on the next frame and covers
    // what the cell now shows.
    const pan = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const OW = await import('/ui/overlay-window.js');
        const vc = window.__lucid.videoController;
        const v = AS.state.views[0];
        const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const box = () => [parseFloat(v.canvas.style.width), parseFloat(v.canvas.style.height)];
        const covers = () => OW.overlayPlanCovers(v._overlayPlan, vc.visibleBoxRect(v), ...box());
        const p0 = v._overlayPlan;
        v.zoom.offsetX -= 20; vc._constrainOffsets(v.zoom, v); vc.applyZoom(v);
        await raf();
        const smallSame = v._overlayPlan === p0;
        const cell = v.canvas.closest('.video-cell');
        v.zoom.offsetX -= cell.clientWidth * 0.8; vc._constrainOffsets(v.zoom, v); vc.applyZoom(v);
        const coveredBefore = covers();
        await raf();
        const moved = v._overlayPlan !== p0 && v._overlayPlan.cssLeft > p0.cssLeft;
        const coveredAfter = covers();
        // a zoom OUT grows what is visible past the window
        const z = v.zoom.scale;
        vc._zoomAbout(v, z / 2, z / 2, cell.clientWidth / 2, cell.clientHeight / 2);
        vc._constrainOffsets(v.zoom, v); vc.applyZoom(v);
        const outBefore = covers();
        await raf();
        return { smallSame, coveredBefore, moved, coveredAfter, outBefore, outAfter: covers() };
    });
    check(pan.smallSame, 'a pan inside the margin keeps the drawn window (no redraw)');
    check(!pan.coveredBefore && pan.moved && pan.coveredAfter,
        'a pan past the margin moves the window, which then covers the cell');
    check(!pan.outBefore && pan.outAfter, 'so does a zoom out');

    // §8 — the window is drawn where the full canvas would have been: the
    // node's centre on SCREEN, read back from a screenshot, lands where the
    // video box says it is, panned off-centre and rotated.
    for (const rot of [0, 30]) {
        const where = await page.evaluate(async (rot) => {
            const AS = await import('/ui/app-state.js');
            const R = await import('/ui/rendering.js');
            const vc = window.__lucid.videoController;
            const v = AS.state.views[0];
            v.rotation = rot;
            vc._clearZoom(v);
            const cell = v.canvas.closest('.video-cell');
            vc._zoomAbout(v, 10, 10, cell.clientWidth / 2, cell.clientHeight / 2);
            v.zoom.offsetX += 37.3; v.zoom.offsetY -= 21.7;
            vc._constrainOffsets(v.zoom, v); vc.applyZoom(v);
            await new Promise(r => requestAnimationFrame(r));
            R.drawAllOverlays(0);
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            // Expected: the video centre through the wrapper's transform.
            const m = new DOMMatrix(getComputedStyle(v.wrapper).transform);
            const bw = parseFloat(v.canvas.style.width), bh = parseFloat(v.canvas.style.height);
            const p = m.transformPoint(new DOMPoint(bw / 2, bh / 2));
            const cr = cell.getBoundingClientRect();
            return { x: cr.left + v.wrapper.offsetLeft + p.x, y: cr.top + v.wrapper.offsetTop + p.y,
                     windowed: v._overlayPlan.windowed };
        }, rot);
        const R0 = 14;
        const png = await page.screenshot({ clip: { x: where.x - R0, y: where.y - R0, width: 2 * R0, height: 2 * R0 } });
        const c = await page.evaluate(async (b64) => {
            const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
            const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
            const x = cv.getContext('2d'); x.drawImage(img, 0, 0);
            const d = x.getImageData(0, 0, img.width, img.height).data;
            let n = 0, sx = 0, sy = 0;
            for (let y = 0; y < img.height; y++) for (let i = 0; i < img.width; i++) {
                const k = (y * img.width + i) * 4;
                if (d[k] > 150 && d[k + 1] < 140) { n++; sx += i + 0.5; sy += y + 0.5; }
            }
            return n ? { dx: sx / n - img.width / 2, dy: sy / n - img.height / 2, n } : null;
        }, png.toString('base64'));
        check(where.windowed && c && Math.hypot(c.dx, c.dy) <= 1,
            `rotation ${rot}: the node is drawn at its true screen position ` +
            (c ? `(off by ${c.dx.toFixed(2)}, ${c.dy.toFixed(2)} px)` : '(not found)'));
    }

    console.log('');
    check(errs.length === 0, 'no page errors: ' + (errs.join(' | ') || 'none'));

    await browser.close();
} finally {
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL — ${fails} check(s)`);
process.exit(fails === 0 ? 0 : 1);
