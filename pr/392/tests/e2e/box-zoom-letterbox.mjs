/**
 * box-zoom-letterbox.mjs — a left-drag box zoom shows the region that was
 * dragged: the video pixel at the rectangle's centre ends up at the centre of
 * the pane, and the rectangle fills the pane along its limiting axis. In a
 * view that is LETTERBOXED (either axis) and in a ROTATED one.
 *
 * `VideoController.zoomToRect` used to turn the rectangle into canvas-box
 * coordinates with `(x − offset) / scale`. That ignores two parts of what
 * `applyZoom` actually draws: the wrapper is flex-centred in its `.video-cell`,
 * so along the letterboxed axis the box starts `f = (cell − box) / 2` px in;
 * and a rotated view turns about the wrapper's centre. A box zoom from fit to
 * scale s put the rectangle's centre `f·(1 − s)` px off the pane centre —
 * ~200 px for f ≈ 100, s = 3 — and, rotated, somewhere else entirely.
 *
 * Every check reads the picture back through the app's own click mapping
 * (`interactionManager.canvasToVideo`, which works from the canvas's on-screen
 * rect and so shares no maths with the zoom), and every section first asserts
 * the zoomed picture overflows the pane on all four sides — i.e. the edge
 * clamp in `_constrainOffsets` did not move it, so what is measured is
 * `zoomToRect` alone.
 *
 * Run: node tests/e2e/box-zoom-letterbox.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8286);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fmt = (p) => '(' + p.map(n => n.toFixed(2)).join(', ') + ')';
// A quarter video pixel. A correct zoom lands within 0.01 px (the drag uses
// whole CSS px and the read-back is exact); the flaw this guards put the
// centre 100–300 video px off. Tight enough that dividing the vertical axis by
// the horizontal 1:1 scale in section 4 (off by 0.18%) fails too: 1.1 px.
const TOL = 0.25;

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

/** A one-camera project (1680x1200) in a single grid pane. */
async function loadProject(page) {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Skeleton, Camera, Session } = pd;
        const W = 1680, H = 1200;
        const cam = new Camera('camA', [[600, 0, W / 2], [0, 600, H / 2], [0, 0, 1]],
            [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [W, H]);
        const session = new Session([cam], new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], 'BoxZoom');
        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 10;
        AS.state.currentFrame = 0;
        AS.state.fps = 30;
        AS.state.isPlaying = false;
        AS.state.triangulationResults = new Map();
        // A stub decoder: the zoom keys are live only while `hasRealVideo()`.
        const decoder = { getFrame: () => Promise.resolve(null), releaseFrames() {} };
        AS.state.views = [{ name: 'camA', videoWidth: W, videoHeight: H, canvas: null, decoder }];
        AS.state.videoFiles = [{ name: 'camA', assignedCamera: 'camA' }];
        AS.state.viewMode = 'grid';
        AS.state.singleViewIndex = 0;
        AS.paneManager.clearAll();
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
        await new Promise(r => requestAnimationFrame(r));
        sp.refreshPaneInteractions();
        await new Promise(r => requestAnimationFrame(r));
    });
    await page.waitForTimeout(300);
}

/** The pane and picture geometry (page CSS px) plus the zoom state. */
const geom = (page) => page.evaluate(async () => {
    const AS = await import('/ui/app-state.js');
    const v = AS.state.views[0];
    const cell = v.canvas.closest('.video-cell');
    const c = cell.getBoundingClientRect();
    const r = v.canvas.getBoundingClientRect(); // the rotated picture's AABB
    const boxW = parseFloat(v.canvas.style.width), boxH = parseFloat(v.canvas.style.height);
    return {
        cell: { left: c.left, top: c.top, right: c.right, bottom: c.bottom, w: cell.clientWidth, h: cell.clientHeight },
        pic: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height },
        boxW, boxH,
        fx: (cell.clientWidth - boxW) / 2, fy: (cell.clientHeight - boxH) / 2,
        scale: v.zoom.scale, scaleY: v.zoom.scaleY, native: !!v.zoom.native,
        offsetX: v.zoom.offsetX, offsetY: v.zoom.offsetY, rotation: v.rotation || 0,
    };
});

/** The video pixel under page point (x, y), via the app's own click mapping. */
const videoAt = (page, x, y) => page.evaluate(async ([x, y]) => {
    const AS = await import('/ui/app-state.js');
    return AS.interactionManager.canvasToVideo(x, y, 'camA');
}, [x, y]);

const setRotation = (page, deg) => page.evaluate(async (deg) => {
    const AS = await import('/ui/app-state.js');
    const v = AS.state.views[0];
    v.rotation = deg;
    AS.videoController.resetZoom(v);
}, deg);

/**
 * Drag a box over page rect (x1, y1)–(x2, y2) — given as fractions of the
 * fitted PICTURE's on-screen rect, rounded to whole CSS px — and check the
 * result. `how` is 'drag' (a real left-drag) or 'call' (zoomToRect directly,
 * for a start state a drag would pan instead of box-zoom).
 */
async function boxZoomAndCheck(page, label, fr, how = 'drag') {
    const g0 = await geom(page);
    const P = g0.pic;
    const x1 = Math.round(P.left + fr[0] * P.w), y1 = Math.round(P.top + fr[1] * P.h);
    const x2 = Math.round(P.left + fr[2] * P.w), y2 = Math.round(P.top + fr[3] * P.h);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const rw = x2 - x1, rh = y2 - y1;
    const k = Math.min(g0.cell.w / rw, g0.cell.h / rh); // screen magnification asked for
    const byWidth = g0.cell.w / rw <= g0.cell.h / rh;
    // The video pixels at the rectangle's centre and at the middles of the
    // two edges on its limiting axis.
    const vCentre = await videoAt(page, mx, my);
    const vEdgeA = byWidth ? await videoAt(page, x1, my) : await videoAt(page, mx, y1);
    const vEdgeB = byWidth ? await videoAt(page, x2, my) : await videoAt(page, mx, y2);

    if (how === 'drag') {
        await page.mouse.move(x1, y1);
        await page.mouse.down();
        await page.mouse.move(x2, y2, { steps: 8 });
        await page.mouse.up();
    } else {
        await page.evaluate(async ([x1, y1, x2, y2]) => {
            const AS = await import('/ui/app-state.js');
            const v = AS.state.views[0];
            const cell = v.canvas.closest('.video-cell');
            const c = cell.getBoundingClientRect();
            AS.videoController.zoomToRect(v, x1 - c.left, y1 - c.top, x2 - c.left, y2 - c.top, cell);
        }, [x1, y1, x2, y2]);
    }
    await page.waitForTimeout(150);

    const g = await geom(page);
    const C = g.cell;
    const cx = C.left + C.w / 2, cy = C.top + C.h / 2;
    // The screen scale along the limiting axis grows by k (unrotated, at 1:1
    // the vertical scale is its own).
    const s0 = !byWidth && g0.native && g0.scaleY > 0 ? g0.scaleY : g0.scale;
    check(near(g.scale, s0 * k, 1e-9 * g.scale),
        `${label}: zoomed to ${g.scale.toFixed(4)} (the ${byWidth ? 'width' : 'height'} of the ${rw}x${rh} box fills the pane: ${(s0 * k).toFixed(4)})`);
    // Precondition for everything below: the picture overflows the pane on all
    // four sides, so `_constrainOffsets` had nothing to clamp.
    const m = 2;
    check(g.pic.left < C.left - m && g.pic.right > C.right + m && g.pic.top < C.top - m && g.pic.bottom > C.bottom + m,
        `${label}: the zoomed picture overflows the pane on every side (no edge clamp) — picture ${g.pic.left.toFixed(0)}..${g.pic.right.toFixed(0)} x ${g.pic.top.toFixed(0)}..${g.pic.bottom.toFixed(0)}, pane ${C.left.toFixed(0)}..${C.right.toFixed(0)} x ${C.top.toFixed(0)}..${C.bottom.toFixed(0)}`);
    const aCentre = await videoAt(page, cx, cy);
    check(near(aCentre[0], vCentre[0], TOL) && near(aCentre[1], vCentre[1], TOL),
        `${label}: the video pixel at the box centre ${fmt(vCentre)} is now at the pane centre ${fmt(aCentre)}`);
    const aEdgeA = byWidth ? await videoAt(page, C.left, cy) : await videoAt(page, cx, C.top);
    const aEdgeB = byWidth ? await videoAt(page, C.right, cy) : await videoAt(page, cx, C.bottom);
    check(near(aEdgeA[0], vEdgeA[0], TOL) && near(aEdgeA[1], vEdgeA[1], TOL)
        && near(aEdgeB[0], vEdgeB[0], TOL) && near(aEdgeB[1], vEdgeB[1], TOL),
        `${label}: the box's ${byWidth ? 'left/right' : 'top/bottom'} edges ${fmt(vEdgeA)} ${fmt(vEdgeB)} are the pane's ${fmt(aEdgeA)} ${fmt(aEdgeB)}`);
    return g;
}

const reset = (page) => page.evaluate(async () => {
    const AS = await import('/ui/app-state.js');
    AS.videoController.resetZoom(AS.state.views[0]);
});

try {
    const browser = await chromium.launch();
    const errs = [];

    // ===== A tall pane: the 1680x1200 video is letterboxed TOP AND BOTTOM ==
    {
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 1300 }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
        await loadProject(page);

        console.log('\n1. Letterboxed vertically: the box centre lands on the pane centre');
        let g = await geom(page);
        check(g.scale === 1 && g.fy > 60 && Math.abs(g.fx) < 1,
            `fitted, letterboxed top and bottom (flex offset ${g.fx.toFixed(1)}, ${g.fy.toFixed(1)} px; box ${g.boxW}x${g.boxH} in a ${g.cell.w}x${g.cell.h} pane)`);
        await boxZoomAndCheck(page, 'upper left', [0.30, 0.30, 0.55, 0.50]);
        await reset(page);
        await boxZoomAndCheck(page, 'lower right (tall box)', [0.52, 0.48, 0.70, 0.78]);
        await reset(page);

        console.log('\n2. Rotated 90°: the same, through the rotation');
        await setRotation(page, 90);
        await page.waitForTimeout(150);
        g = await geom(page);
        check(g.scale === 1 && /rotate\(90deg\)/.test(await page.evaluate(async () => (await import('/ui/app-state.js')).state.views[0].wrapper.style.transform)),
            `fitted and rotated 90° (picture ${g.pic.w.toFixed(0)}x${g.pic.h.toFixed(0)} in a ${g.cell.w}x${g.cell.h} pane)`);
        await boxZoomAndCheck(page, 'rotated 90°', [0.30, 0.35, 0.60, 0.55]);
        await reset(page);

        console.log('\n3. Rotated 30° (the rotation slider takes any angle)');
        await setRotation(page, 30);
        await page.waitForTimeout(150);
        await boxZoomAndCheck(page, 'rotated 30°', [0.40, 0.35, 0.62, 0.52]);
        await setRotation(page, 0);
        await page.waitForTimeout(150);

        console.log('\n4. From native resolution (per-axis scale, already panned)');
        // A drag on a zoomed view pans, so a box zoom starts from a non-fit
        // state only when the zoom is within 5% of fit — native resolution can
        // be. Drive zoomToRect directly from 1:1 at dpr 1, where the 1:1 scale
        // is ~3x and differs per axis (1680/561 vs 1200/400).
        await page.keyboard.press('Shift+Digit0');
        await page.waitForTimeout(250);
        await page.mouse.move(400, 500);
        await page.mouse.down({ button: 'middle' });
        await page.mouse.move(470, 455, { steps: 4 });
        await page.mouse.up({ button: 'middle' });
        await page.waitForTimeout(150);
        g = await geom(page);
        check(g.native && g.scaleY !== g.scale && (g.offsetX !== 0 || g.offsetY !== 0),
            `at 1:1 (scale ${g.scale.toFixed(5)} x ${g.scaleY.toFixed(5)}), panned (${g.offsetX.toFixed(1)}, ${g.offsetY.toFixed(1)})`);
        // Fractions of the (overflowing) picture: pick a box inside the pane.
        const C = g.cell, P = g.pic;
        const fx = (x) => (x - P.left) / P.w, fy = (y) => (y - P.top) / P.h;
        await boxZoomAndCheck(page, 'from 1:1', [fx(C.left + 0.30 * C.w), fy(C.top + 0.40 * C.h), fx(C.left + 0.70 * C.w), fy(C.top + 0.55 * C.h)], 'call');
        g = await geom(page);
        check(!g.native && g.scaleY === undefined, 'a box zoom leaves native resolution (one uniform scale again)');
        await ctx.close();
    }

    // ===== A wide pane: letterboxed LEFT AND RIGHT ==========================
    {
        console.log('\n5. Letterboxed horizontally');
        const ctx = await browser.newContext({ viewport: { width: 1700, height: 700 }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
        await loadProject(page);
        const g = await geom(page);
        check(g.scale === 1 && g.fx > 60 && Math.abs(g.fy) < 1,
            `fitted, letterboxed left and right (flex offset ${g.fx.toFixed(1)}, ${g.fy.toFixed(1)} px; box ${g.boxW}x${g.boxH} in a ${g.cell.w}x${g.cell.h} pane)`);
        await boxZoomAndCheck(page, 'left of centre', [0.28, 0.35, 0.48, 0.60]);
        await ctx.close();
    }

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await browser.close();
} finally {
    server.kill();
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
