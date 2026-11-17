// ui/overlay-window.js — the overlay canvas covers only the VISIBLE part of a
// zoomed-in video (DOM-free planning; `ui/rendering.js` applies the plan).
//
// The overlay canvas sits inside the `.canvas-wrapper` that `applyZoom`
// scales, so a backing store covering the whole video box has to grow with
// the zoom to stay sharp — at zoom 10 in a solo pane, 13920x8700 (~480 MB) for
// ONE 1920x1200 view, all of it cleared and redrawn on every mouse move of a
// node drag, to show the ~1% of it the pane has room for. luc3d #200 bounded
// the supersample; this bounds the AREA: the canvas element is placed over the
// visible part of the box (plus a pan margin) and only that is allocated and
// drawn. Drawing code keeps working in the coordinates of the FULL virtual
// canvas (`fullW` x `fullH`); a transform on the context maps them into the
// window.
//
// Whenever the window would cover the whole box — every unzoomed view, and any
// zoom at which the whole video still fits — the plan is the full canvas,
// exactly what was drawn before this module existed.

/** Fraction of the visible size added on EACH side, so panning redraws rarely. */
export const OVERLAY_WINDOW_MARGIN = 0.25;

/**
 * Plan a view's overlay canvas.
 *
 * @param {object} p
 * @param {number} p.videoW, p.videoH - video size (px)
 * @param {number} p.boxW, p.boxH - the canvas box, CSS px, before the zoom transform
 * @param {number} p.ss - backing px per video px (already quality-bounded)
 * @param {?{x0:number,y0:number,x1:number,y1:number}} p.visible - the part of
 *   the box on screen, in box CSS px (null: unknown, so draw the full canvas)
 * @param {number} [p.margin] - pan margin, default OVERLAY_WINDOW_MARGIN
 * @param {number} p.maxDim, p.maxArea - the browser's canvas limits
 * @returns {{windowed:boolean, ss:number, fullW:number, fullH:number,
 *   bw:number, bh:number, ax:number, ay:number, ex:number, ey:number,
 *   cssLeft:number, cssTop:number, cssW:number, cssH:number,
 *   boxW:number, boxH:number}}
 *   The canvas is `bw` x `bh`, drawn through `setTransform(ax, 0, 0, ay, ex,
 *   ey)` from full-canvas coordinates (identity when not windowed); `css*`
 *   place the element in the box, on whole CSS px.
 */
export function planOverlayWindow(p) {
    var videoW = p.videoW || 1, videoH = p.videoH || 1;
    var boxW = p.boxW, boxH = p.boxH;
    var margin = p.margin != null ? p.margin : OVERLAY_WINDOW_MARGIN;
    var ss = p.ss;
    var vis = p.visible;

    var win = null;
    if (vis && boxW > 0 && boxH > 0) {
        var x0 = Math.max(0, Math.min(boxW, vis.x0)), x1 = Math.max(0, Math.min(boxW, vis.x1));
        var y0 = Math.max(0, Math.min(boxH, vis.y0)), y1 = Math.max(0, Math.min(boxH, vis.y1));
        // Window SIZE depends only on the visible size, never on where it is,
        // so a pan moves the window without reallocating it.
        var ww = Math.min(boxW, Math.max(1, x1 - x0) * (1 + 2 * margin));
        var wh = Math.min(boxH, Math.max(1, y1 - y0) * (1 + 2 * margin));
        if (ww < boxW || wh < boxH) {
            var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
            win = {
                x: Math.max(0, Math.min(boxW - ww, cx - ww / 2)),
                y: Math.max(0, Math.min(boxH - wh, cy - wh / 2)),
                w: ww, h: wh,
            };
        }
    }

    // Chrome's limits apply to the canvas actually allocated: the whole video
    // unwindowed (luc3d #200's clamp, unchanged), only the window otherwise.
    var fracW = win ? win.w / boxW : 1, fracH = win ? win.h / boxH : 1;
    var aw = videoW * fracW, ah = videoH * fracH;
    ss = Math.min(ss, p.maxDim / aw, p.maxDim / ah, Math.sqrt(p.maxArea / (aw * ah)));

    // `Math.floor`, not `round`: rounding up at the clamp is what would put
    // the canvas back over the limit it was just clamped to.
    var fullW = Math.max(1, Math.floor(videoW * ss));
    var fullH = Math.max(1, Math.floor(videoH * ss));

    if (!win) {
        return { windowed: false, ss: ss, fullW: fullW, fullH: fullH,
            bw: fullW, bh: fullH, ax: 1, ay: 1, ex: 0, ey: 0,
            cssLeft: 0, cssTop: 0, cssW: boxW, cssH: boxH, boxW: boxW, boxH: boxH };
    }

    // The element is placed on WHOLE box CSS px. Blink paints a canvas into its
    // pixel-snapped content rect in its own (pre-zoom) coordinates, so a
    // fractional left/top/width is rounded there — and then magnified by the
    // zoom: a 0.3 px snap at zoom 10 drew the skeleton 2-3 screen px off.
    var bW = Math.floor(boxW), bH = Math.floor(boxH);
    var w = Math.min(bW, Math.ceil(win.w)), h = Math.min(bH, Math.ceil(win.h));
    var x0 = Math.max(0, Math.min(bW - w, Math.round(win.x)));
    var y0 = Math.max(0, Math.min(bH - h, Math.round(win.y)));
    var kx = fullW / boxW, ky = fullH / boxH;   // full-canvas px per box CSS px
    var bw = Math.max(1, Math.ceil(w * kx));
    var bh = Math.max(1, Math.ceil(h * ky));
    // Full-canvas px X lands on window px  X * ax + ex  (ax a hair over 1:
    // the window's whole backing px over its whole CSS px).
    var ax = bw / (w * kx), ay = bh / (h * ky);
    return { windowed: true, ss: ss, fullW: fullW, fullH: fullH,
        bw: bw, bh: bh, ax: ax, ay: ay, ex: -x0 * bw / w, ey: -y0 * bh / h,
        cssLeft: x0, cssTop: y0, cssW: w, cssH: h, boxW: boxW, boxH: boxH };
}

/** Where full-canvas point (X, Y) is on a plan's (window) canvas. */
export function fullToWindow(plan, X, Y) {
    return [X * plan.ax + plan.ex, Y * plan.ay + plan.ey];
}

/**
 * Whether a drawn `plan` still shows everything that is `visible` (box CSS
 * px) in a box of `boxW` x `boxH`. False means a redraw is due: a pan or a
 * zoom out moved the view past the window's margin, or the box was resized.
 */
export function overlayPlanCovers(plan, visible, boxW, boxH) {
    if (!plan) return true;
    if (Math.abs(plan.boxW - boxW) > 0.5 || Math.abs(plan.boxH - boxH) > 0.5) return false;
    if (!plan.windowed) return true;
    if (!visible) return false;
    var eps = 0.5;
    var x0 = Math.max(0, visible.x0), y0 = Math.max(0, visible.y0);
    var x1 = Math.min(boxW, visible.x1), y1 = Math.min(boxH, visible.y1);
    return x0 >= plan.cssLeft - eps && y0 >= plan.cssTop - eps &&
        x1 <= plan.cssLeft + plan.cssW + eps && y1 <= plan.cssTop + plan.cssH + eps;
}

/**
 * The size of the FULL virtual overlay canvas a view's drawing code works in
 * (= the canvas itself when not windowed). For code that maps video px to
 * overlay px outside `drawFrameOverlays`.
 */
export function overlayDrawSize(view) {
    var plan = view && view._overlayPlan;
    if (plan) return { width: plan.fullW, height: plan.fullH };
    var c = view && view.overlayCanvas;
    return { width: c ? c.width : 0, height: c ? c.height : 0 };
}
