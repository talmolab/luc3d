// ui/seekbar-pose-flags.js — the frames the last 2D pose check flagged
// (Track All or Tracks ▸ Check Poses, pose/pose-check-session.js), as a strip
// of ticks along the transport seekbar: red where a frame holds an outlier,
// amber where it holds only uncommon poses.
//
// Drawn on one canvas, a column per device pixel, not one element per frame:
// a check can flag tens of thousands of frames (the 5-mouse recording has
// ~40,000 uncommon and ~14,000 outlier poses), far more than the bar has
// pixels. A column takes the worst class of the frames it covers, and every
// marked column is drawn at least `MIN_TICK_CSS_PX` wide so a lone flagged
// frame on an hour-long recording is still visible. Positions use the thumb's
// mapping (`frame / (totalFrames - 1)`), like ui/seekbar-markers.js.
//
// The strip never takes the pointer. `seekbarPoseFlagAt` lets the seekbar's
// handlers snap a click / the hover tooltip to the nearest flagged frame within
// a few pixels (an outlier in reach first), after the possible-ID-switch ticks
// (which win), so the frame the tooltip names is the frame a click lands on.
//
// `syncSeekbarPoseFlags(session, totalFrames)` is called on every seekbar
// update and overlay redraw; it redraws only when the session's check, the
// frame count or the bar's size changed, so it costs a few comparisons.

import { flaggedFrames, flaggedFrameClasses, describeFlagsAt } from '../pose/pose-check-session.js?v=17e9b3860106';

export var MIN_TICK_CSS_PX = 2;
export var POSE_FLAG_SNAP_PX = 3;
export var SEEKBAR_POSE_COLORS = { uncommon: '#ffb300', outlier: '#ff3b30' };   // POSE_FLAG_COLORS in ui/overlays.js

var _canvas = null;
var _pc = null;          // the poseCheck drawn
var _flags = null;       // ...and its flags array (a re-run replaces it)
var _total = 0;
var _w = 0, _h = 0, _dpr = 0;

/** Attach to the seekbar's pose-flag canvas (`#seekbarPoseFlags`). */
export function installSeekbarPoseFlags(canvas) {
    _canvas = canvas || null;
    if (_canvas && typeof ResizeObserver === 'function') {
        new ResizeObserver(function () { _w = -1; render(); }).observe(_canvas);
    }
    render();
}

/**
 * Show `session.poseCheck`'s flagged frames (none when the session has no
 * check). Cheap when nothing changed.
 */
export function syncSeekbarPoseFlags(session, totalFrames) {
    var pc = (session && session.poseCheck) || null;
    var flags = pc ? pc.flags : null;
    if (pc === _pc && flags === _flags && totalFrames === _total) return;
    _pc = pc; _flags = flags; _total = totalFrames || 0;
    render();
}

/**
 * Per bar column (0..columns-1), the worst class flagged on the frames it
 * covers: 0 none, 1 uncommon, 2 outlier. Each flagged frame falls in the
 * column under its thumb position. Pure.
 * @param {number[]} frames  ascending 0-based frames
 * @param {ArrayLike<number>} worst  the class on each (1 / 2)
 * @param {number} totalFrames
 * @param {number} columns
 * @returns {Uint8Array}
 */
export function poseFlagColumns(frames, worst, totalFrames, columns) {
    var out = new Uint8Array(Math.max(0, columns | 0));
    if (!(totalFrames > 1) || !out.length) return out;
    for (var i = 0; i < frames.length; i++) {
        var c = Math.min(out.length - 1, Math.max(0, Math.floor(frames[i] / (totalFrames - 1) * out.length)));
        if (worst[i] > out[c]) out[c] = worst[i];
    }
    return out;
}

/**
 * The flagged frame nearest a point on the bar, within `tolPx` pixels, with a
 * line saying what was flagged there; or null. An outlier frame in reach beats
 * a nearer uncommon one, so a red tick among amber ones can still be hit.
 * @param {number} frac  0..1 along the bar
 * @param {number} widthPx  the bar's width
 * @returns {{frame: number, text: string}|null}
 */
export function seekbarPoseFlagAt(frac, widthPx, tolPx) {
    if (!_pc || !(widthPx > 0) || !(_total > 1)) return null;
    var frames = flaggedFrames(_pc), worst = flaggedFrameClasses(_pc);
    if (!frames.length) return null;
    var tol = tolPx == null ? POSE_FLAG_SNAP_PX : tolPx;
    var perPx = (_total - 1) / widthPx, target = frac * (_total - 1);
    var lo = 0, hi = frames.length;     // first frame >= target - tol
    while (lo < hi) { var mid = (lo + hi) >> 1; if (frames[mid] < target - tol * perPx) lo = mid + 1; else hi = mid; }
    var best = -1, bestCls = 0, bestD = Infinity;
    for (var k = lo; k < frames.length; k++) {
        var d = Math.abs(frames[k] - target) / perPx;
        if (frames[k] > target && d > tol) break;
        if (d > tol) continue;
        if (worst[k] > bestCls || (worst[k] === bestCls && d < bestD)) { best = frames[k]; bestCls = worst[k]; bestD = d; }
    }
    if (best < 0) return null;
    return { frame: best, text: 'flagged pose: ' + describeFlagsAt(_pc, best) };
}

function render() {
    if (!_canvas) return;
    var cssW = _canvas.clientWidth, cssH = _canvas.clientHeight;
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    var w = Math.max(0, Math.round(cssW * dpr)), h = Math.max(0, Math.round(cssH * dpr));
    if (w !== _w || h !== _h || dpr !== _dpr) {
        _canvas.width = w; _canvas.height = h;
        _w = w; _h = h; _dpr = dpr;
    }
    var ctx = _canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    var frames = flaggedFrames(_pc);
    if (!frames.length || !(_total > 1) || !w || !h) return;
    var cols = poseFlagColumns(frames, flaggedFrameClasses(_pc), _total, w);
    var minW = Math.max(1, Math.round(MIN_TICK_CSS_PX * dpr));
    // Uncommon first, then outliers over them: red wins where the two meet.
    for (var pass = 1; pass <= 2; pass++) {
        ctx.fillStyle = pass === 2 ? SEEKBAR_POSE_COLORS.outlier : SEEKBAR_POSE_COLORS.uncommon;
        for (var c = 0; c < cols.length; c++) {
            if (cols[c] !== pass) continue;
            var x = Math.min(w - minW, Math.max(0, c - (minW >> 1)));
            ctx.fillRect(x, 0, minW, h);
        }
    }
}
