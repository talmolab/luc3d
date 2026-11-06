/**
 * test-overlay-window.mjs — `ui/overlay-window.js`, the plan that makes a
 * zoomed-in overlay canvas cover only the visible part of the video.
 *
 * Pinned here (pure math; the browser side is `tests/e2e/zoom-overlay-budget.mjs`
 * §6-8):
 *   1. a view whose whole box is on screen gets the FULL canvas, exactly the
 *      size luc3d #200's clamp gave it (so every unzoomed view is unchanged)
 *   2. a zoomed-in view gets a window about the visible part plus the margin,
 *      placed on whole CSS px, with a transform that maps full-canvas points
 *      onto it consistently with that placement
 *   3. a pan keeps the window's SIZE (no reallocation), only its position
 *   4. Chrome's canvas limits apply to the canvas actually allocated
 *   5. `overlayPlanCovers` asks for a redraw exactly when the view leaves the
 *      window (pan / zoom out past the margin, box resize)
 */
import {
    planOverlayWindow, overlayPlanCovers, fullToWindow, overlayDrawSize, OVERLAY_WINDOW_MARGIN,
} from '../ui/overlay-window.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-9 : eps);

const MAX_DIM = 16384, MAX_AREA = 268435456;
const base = { videoW: 1920, videoH: 1200, boxW: 673, boxH: 420, maxDim: MAX_DIM, maxArea: MAX_AREA };

console.log('§1 full canvas when the whole box is visible');
{
    const p = planOverlayWindow({ ...base, ss: 1, visible: null });
    check(!p.windowed && p.bw === 1920 && p.bh === 1200, 'no visible rect: full 1920x1200');
    check(p.ax === 1 && p.ay === 1 && p.ex === 0 && p.ey === 0, 'identity transform');
    const q = planOverlayWindow({ ...base, ss: 1, visible: { x0: -10, y0: -80, x1: 700, y1: 500 } });
    check(!q.windowed && q.bw === 1920, 'visible rect wider than the box: full');
    // zoom 1.2: the visible part grown by the margin still spans the box
    const z = planOverlayWindow({ ...base, ss: 1.25, visible: { x0: 56, y0: 35, x1: 617, y1: 385 } });
    check(!z.windowed && z.bw === 2400 && z.bh === 1500, 'a small zoom whose margin covers the box: full');
    // luc3d #200's clamp, unchanged for the full canvas
    const big = planOverlayWindow({ ...base, ss: 10, visible: null });
    check(big.bw <= MAX_DIM && big.bh <= MAX_DIM && big.bw === Math.floor(1920 * (MAX_DIM / 1920)),
        `full canvas still clamped to Chrome's limits (${big.bw}x${big.bh})`);
}

console.log('§2 a window about the visible part');
{
    // zoom 10 about the box centre: 67.3 x 42 box px visible
    const vis = { x0: 302.85, y0: 189, x1: 370.15, y1: 231 };
    const p = planOverlayWindow({ ...base, ss: 7.25, visible: vis });
    check(p.windowed, 'windowed');
    check(Number.isInteger(p.cssLeft) && Number.isInteger(p.cssTop) &&
        Number.isInteger(p.cssW) && Number.isInteger(p.cssH), 'placed on whole CSS px');
    const m = 1 + 2 * OVERLAY_WINDOW_MARGIN;
    check(p.cssW >= 67.3 * m - 1e-9 && p.cssW <= 67.3 * m + 1 && p.cssH >= 42 * m - 1e-9 && p.cssH <= 42 * m + 1,
        `sized to the visible part times the margin (${p.cssW}x${p.cssH} box px)`);
    check(p.cssLeft <= vis.x0 && p.cssLeft + p.cssW >= vis.x1 && p.cssTop <= vis.y0 && p.cssTop + p.cssH >= vis.y1,
        'and contains it');
    check(p.fullW === Math.floor(1920 * 7.25) && p.fullH === Math.floor(1200 * 7.25),
        `full virtual canvas ${p.fullW}x${p.fullH}, drawn into ${p.bw}x${p.bh}`);
    check(p.bw * p.bh * 40 < p.fullW * p.fullH, 'a small fraction of it');
    // A full-canvas point maps onto the window where the ELEMENT shows that
    // box point: box x -> full X = x * fullW/boxW -> window px -> back to box x.
    const kx = p.fullW / p.boxW, ky = p.fullH / p.boxH;
    let ok = true;
    for (const [bx, by] of [[vis.x0, vis.y0], [336.5, 210], [vis.x1, vis.y1]]) {
        const [wx, wy] = fullToWindow(p, bx * kx, by * ky);
        const backX = p.cssLeft + wx / p.bw * p.cssW, backY = p.cssTop + wy / p.bh * p.cssH;
        if (!near(backX, bx, 1e-9) || !near(backY, by, 1e-9)) ok = false;
    }
    check(ok, 'fullToWindow agrees with the element placement (exact)');
    check(p.ax >= 1 && p.ax < 1.01 && p.ay >= 1 && p.ay < 1.01,
        `window px per full-canvas px is a hair over 1 (${p.ax.toFixed(5)}, ${p.ay.toFixed(5)})`);
    check(p.bw * p.bh <= MAX_AREA && p.bw <= MAX_DIM && p.bh <= MAX_DIM, 'within Chrome limits');
}

console.log('§3 a pan moves the window without resizing it');
{
    const sizes = new Set();
    let inside = true;
    for (let dx = -300; dx <= 300; dx += 7.3) {
        const vis = { x0: 302.85 + dx, y0: 189, x1: 370.15 + dx, y1: 231 };
        const p = planOverlayWindow({ ...base, ss: 7.25, visible: vis });
        sizes.add(p.bw + 'x' + p.bh + '/' + p.cssW);
        if (p.cssLeft < 0 || p.cssLeft + p.cssW > Math.floor(base.boxW)) inside = false;
    }
    check(sizes.size === 1, `one size across the whole pan (${[...sizes].join(', ')})`);
    check(inside, 'and the window never leaves the box');
}

console.log("§4 Chrome's limits apply to the canvas allocated");
{
    // A huge supersample: the full virtual canvas is far past 16384 px, the
    // window is not, so `ss` is NOT clamped to the full canvas's limit.
    const vis = { x0: 330, y0: 205, x1: 343, y1: 215 };
    const p = planOverlayWindow({ ...base, ss: 40, visible: vis });
    check(p.windowed && p.ss === 40 && p.fullW > MAX_DIM, `ss kept at 40 (full ${p.fullW} px wide, never allocated)`);
    check(p.bw <= MAX_DIM && p.bh <= MAX_DIM, `window ${p.bw}x${p.bh} within the limit`);
    // ...and a window that WOULD pass it clamps ss for itself
    const wide = planOverlayWindow({ ...base, ss: 200, visible: { x0: 100, y0: 100, x1: 300, y1: 150 } });
    check(wide.bw <= MAX_DIM && wide.bh <= MAX_DIM && wide.bw * wide.bh <= MAX_AREA && wide.ss < 200,
        `an oversized window clamps ss (${wide.ss.toFixed(2)}, ${wide.bw}x${wide.bh})`);
}

console.log('§5 when a redraw is due');
{
    const vis = { x0: 302.85, y0: 189, x1: 370.15, y1: 231 };
    const p = planOverlayWindow({ ...base, ss: 7.25, visible: vis });
    const shift = (d) => ({ x0: vis.x0 + d, y0: vis.y0, x1: vis.x1 + d, y1: vis.y1 });
    check(overlayPlanCovers(p, vis, base.boxW, base.boxH), 'covers what it was planned for');
    check(overlayPlanCovers(p, shift(10), base.boxW, base.boxH), 'a pan inside the margin: covered');
    check(!overlayPlanCovers(p, shift(40), base.boxW, base.boxH), 'a pan past it: redraw');
    const out = { x0: 269, y0: 168, x1: 404, y1: 252 };   // zoom 5 about the centre
    check(!overlayPlanCovers(p, out, base.boxW, base.boxH), 'a zoom out past it: redraw');
    const inn = { x0: 320, y0: 200, x1: 353, y1: 221 };   // zoom 20
    check(overlayPlanCovers(p, inn, base.boxW, base.boxH), 'a zoom in: covered (sharpened by the zoom redraw)');
    check(!overlayPlanCovers(p, vis, 700, 437), 'a box resize: redraw');
    const full = planOverlayWindow({ ...base, ss: 1, visible: null });
    check(overlayPlanCovers(full, shift(200), base.boxW, base.boxH), 'a full canvas covers any pan');
    check(overlayPlanCovers(null, vis, base.boxW, base.boxH), 'no plan yet: nothing to redraw');
}

console.log('§6 overlayDrawSize');
{
    const p = planOverlayWindow({ ...base, ss: 7.25, visible: { x0: 302.85, y0: 189, x1: 370.15, y1: 231 } });
    const d = overlayDrawSize({ _overlayPlan: p, overlayCanvas: { width: p.bw, height: p.bh } });
    check(d.width === p.fullW && d.height === p.fullH, 'a windowed view draws in full-canvas coordinates');
    const e = overlayDrawSize({ overlayCanvas: { width: 640, height: 480 } });
    check(e.width === 640 && e.height === 480, 'a view never planned: its canvas');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? "PASS" : "FAIL");
process.exit(failed ? 1 : 0);
