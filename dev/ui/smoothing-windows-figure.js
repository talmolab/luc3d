// ui/smoothing-windows-figure.js
// The Settings ▸ Temporal Smoothing figure: what the Median window and the
// Gaussian window each do, as two cards side by side (stage 1, stage 2).
//
// Both cards plot the same made-up trace: one node's x position over 40 frames
// (a slow back-and-forth movement, a white line under everything else), as
// triangulation would give it with a little jitter (grey rings joined by a grey
// line), one one-frame spike (red) and a fast real movement: a quick dart up and
// back over a few frames, which too long a window flattens (over-smoothing). The
// movement ends low, and each card's legend sits in its top right corner, above that end.
// Each card draws what its
// stage makes of its input, the window around one frame (shaded), and for the
// Gaussian the weights inside that window (a bell of stems). The median's
// output is the same green line and dots in both cards (on the right, as the
// Gaussian's input), so the hand-off reads; the Gaussian's output is blue. Each
// card has its own legend, which names only what that card draws.
//
// The filtering is NOT hand-drawn: it runs LUC3D's own `smoothSignalInto` on
// the trace, one segment, so the sketch is exactly what the filter does to it.
// `update(params)` redraws from the panel's working values, so the cards follow
// the windows as they are typed. A stage that is off (0) draws no window and no
// output, only its input.
//
// **Trying a value never changes a setting** (`ui/figure-try-controls.js`). Each
// card has two sliders with text boxes, which only redraw the sketch. Window (1 =
// no smoothing) tries a window size. Frame slides the shaded window along the
// trace, and its play button animates the slide: while a frame is picked, the
// output is drawn solid up to that frame and faint after it, so the line builds
// frame by frame. Only the card's Use and Turn off buttons change a setting, through
// `onParam(id, value)`, so the panel can set its working value and number field;
// Apply saves it. Each card's large value is what its sketch shows.
// The Gaussian
// card's input is the median's output, as in the real pass, except when the
// median is off and the Gaussian is on: then it is the raw trace, and the card
// shows the spike being spread into a bump (why the median runs first).
//
// A third, full-width card shows Max gap and Minimum segment length on its own
// trace (60 frames with a 2-frame hole, a 7-frame and a 6-frame absence, and a
// 3-frame stretch between them; the node is somewhere else after the first long
// absence). It runs both stages at the windows the first two cards show, over
// the segments `buildSegments` cuts, exactly as the real pass does: a short
// absence stays a hole inside its segment, a longer one splits the trace and no
// window crosses it, and a segment shorter than the minimum is left as is. Its
// two sliders try values the same way, and its Use button reports both through
// `onParam`.
//
// Depends on: pose/temporal-smoothing.js (`smoothSignalInto`, `normalizeWindow`,
// `sigmaForWindow`, `buildSegments`), ui/figure-try-controls.js. Colours come from
// `styles.css` (`.smooth-fig`).

import { smoothSignalInto, normalizeWindow, sigmaForWindow, buildSegments } from '../pose/temporal-smoothing.js?v=da15011ba119';
import { tryStrip, tryControl, wireTryControl, settingRow, wireSettingRow } from './figure-try-controls.js?v=da15011ba119';

var N = 40;                              // frames in the trace
var SPIKES = [[8, 28]];                 // [frame, mm] one-frame spikes
var FAST = { frame: 19, height: 30, sigma: 1.2 };     // fast real movement: a quick dart, mm and frames
var EXAMPLE = { median: 5, gaussian: 9 };  // the gaps card's windows while a stage is off
var MEDIAN_FOCUS = SPIKES[0][0];         // frame card 1's window starts on (the spike)
var GAUSSIAN_FOCUS = FAST.frame;         // frame card 2's window starts on (the fast move)

/** The true movement at frame `t`, which need not be a whole frame. */
function trueAt(t) {
    return 6 * Math.sin(2 * Math.PI * (t - 6) / 44)
        + FAST.height * Math.exp(-(t - FAST.frame) * (t - FAST.frame) / (2 * FAST.sigma * FAST.sigma));
}

// The true movement and the trace triangulation gives of it. The jitter is a
// fixed pseudo-random sequence so the figure is the same every time.
var TRUTH = new Float64Array(N);
var RAW = new Float64Array(N);
(function () {
    var seed = 7;
    function rand() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var t = 0; t < N; t++) {
        TRUTH[t] = trueAt(t);
        RAW[t] = TRUTH[t] + 14 * (rand() + rand() - 1);
    }
    SPIKES.forEach(function (s) { RAW[s[0]] = TRUTH[s[0]] + s[1]; });
})();

var SCRATCH_V = new Float64Array(128);
var SCRATCH_W = new Float64Array(128);

/** LUC3D's filter on one whole-trace segment. */
function run(src, kernel, window) {
    var dst = new Float64Array(src.length);
    smoothSignalInto(src, dst, [{ start: 0, end: src.length }],
        { kernel: kernel, window: window, minSegment: 1 }, SCRATCH_V, SCRATCH_W);
    return dst;
}

// Plot area inside a 300 x 150 viewBox; one y scale for both cards.
var X0 = 6, X1 = 294, Y0 = 10, Y1 = 124;
var Y_MIN = Infinity, Y_MAX = -Infinity;
[RAW, TRUTH].forEach(function (trace) {
    trace.forEach(function (v) { Y_MIN = Math.min(Y_MIN, v); Y_MAX = Math.max(Y_MAX, v); });
});
function px(t) { return X0 + (X1 - X0) * t / (N - 1); }
function py(v) { return Y1 - (Y1 - Y0) * (v - Y_MIN) / (Y_MAX - Y_MIN); }
function f1(v) { return Math.round(v * 10) / 10; }
function path(values, to) {
    var d = '', end = to == null ? values.length - 1 : to;
    for (var t = 0; t <= end; t++) d += (t ? 'L' : 'M') + f1(px(t)) + ' ' + f1(py(values[t]));
    return d;
}

/**
 * A stage's output line. With `upto` set (a frame is picked on the slider), the
 * part after it is faint and the line is solid only up to it.
 */
function outLine(values, cls, upto) {
    if (upto == null) return '<path d="' + path(values) + '" class="' + cls + '"/>';
    return '<path d="' + path(values) + '" class="' + cls + ' sf-ahead"/>'
        + '<path d="' + path(values, upto) + '" class="' + cls + '"/>';
}

/** A ring on the picked frame's output value. */
function current(values, t, upto) {
    return upto == null ? '' : '<circle cx="' + f1(px(t)) + '" cy="' + f1(py(values[t])) + '" r="4.6" class="sf-current"/>';
}
function isSpike(t) { return SPIKES.some(function (s) { return s[0] === t; }); }

/** Radius of `window` around frame `t`, shrunk at the trace's ends as the filter does. */
function shownRadius(window, t) {
    return Math.min((window - 1) >> 1, t, N - 1 - t);
}

/** The shaded window around frame `t` and its width label. */
function band(t, window) {
    var r = shownRadius(window, t), half = (X1 - X0) / (N - 1) / 2;
    var x = px(t - r) - half, w = px(t + r) + half - x;
    return '<rect x="' + f1(x) + '" y="' + Y0 + '" width="' + f1(w) + '" height="' + (Y1 - Y0) + '" class="sf-band"/>'
        + '<text x="' + f1(x + w / 2) + '" y="' + (Y1 + 11) + '" text-anchor="middle" class="sf-note">'
        + (2 * r + 1) + (r ? ' frames' : ' frame') + '</text>';
}

/**
 * Dots for a trace (class `cls`, default the raw grey); spikes still in it are
 * drawn red. Raw samples are open rings, a little larger than the filled dots
 * and drawn over them: a median keeps many samples exactly (its output IS one
 * of the window's samples), so a filled raw dot would hide under the green one.
 */
function dots(values, showSpikes, cls, upto) {
    var s = '';
    for (var t = 0; t < values.length; t++) {
        var c = showSpikes && isSpike(t) ? 'sf-spike' : cls || 'sf-raw';
        s += '<circle cx="' + f1(px(t)) + '" cy="' + f1(py(values[t])) + '" r="' + (c === 'sf-raw' ? 3.4 : 2.2)
            + '" class="' + c + (upto != null && t > upto ? ' sf-ahead' : '') + '"/>';
    }
    return s;
}

/** The Gaussian's output at every frame: open black circles on the blue line. */
function outNodes(values, upto) {
    var s = '';
    for (var t = 0; t < values.length; t++) {
        s += '<circle cx="' + f1(px(t)) + '" cy="' + f1(py(values[t])) + '" r="2.2" class="sf-out-node'
            + (upto != null && t > upto ? ' sf-ahead' : '') + '"/>';
    }
    return s;
}

/** The true movement as a smooth curve: a real movement has no corners at the frames. */
function truePath() {
    var d = '', steps = (N - 1) * 4;
    for (var i = 0; i <= steps; i++) {
        var t = i / 4;
        d += (i ? 'L' : 'M') + f1(px(t)) + ' ' + f1(py(trueAt(t)));
    }
    return d;
}

/** One card's chart, the true movement under everything else. The axis label steps aside when the window's label (centred on `t`) reaches it. */
function chart(label, inner, t) {
    var axisLabel = px(t) < X1 - 75
        ? '<text x="' + X1 + '" y="' + (Y1 + 11) + '" text-anchor="end" class="sf-note">frames →</text>' : '';
    return '<svg viewBox="0 0 300 140" role="img" aria-label="' + label + '">'
        + '<path d="' + truePath() + '" class="sf-true"/>'
        + '<line x1="' + X0 + '" y1="' + (Y1 + 3) + '" x2="' + X1 + '" y2="' + (Y1 + 3) + '" class="sf-axis"/>'
        + inner + axisLabel
        + '</svg>';
}

/** An arrow from the spike at frame `t` to where the median puts it, and its label. */
function spikeArrow(t, out) {
    var down = out[t] < RAW[t] ? 1 : -1, y0 = py(RAW[t]), y1 = py(out[t]);
    var label = '<text x="' + f1(px(t) + 6) + '" y="' + f1(y0 + 4) + '" class="sf-note sf-note-spike">spike</text>';
    if (Math.abs(y1 - y0) < 10) return label;     // a 1-frame window leaves it where it is
    return '<line x1="' + f1(px(t)) + '" y1="' + f1(y0 + 4 * down) + '" x2="' + f1(px(t)) + '" y2="' + f1(y1 - 4 * down)
        + '" class="sf-move" marker-end="url(#sf-arrow)"/>' + label;
}

/**
 * The median's counterpart of the Gaussian's weight stems: the window around
 * frame `t` sorted by value, as stems rising from the bottom of the band (lowest
 * value on the left, height relative to the window's lowest). The middle one is
 * the median (green), the value the filter writes at `t`; a spike is red.
 */
function medianStems(t, window) {
    var r = shownRadius(window, t), order = [], H = 26, lo = Infinity, hi = -Infinity;
    for (var d = -r; d <= r; d++) {
        order.push(t + d);
        lo = Math.min(lo, RAW[t + d]); hi = Math.max(hi, RAW[t + d]);
    }
    order.sort(function (a, b) { return RAW[a] - RAW[b]; });
    var s = '';
    order.forEach(function (f, k) {
        var h = 3 + (H - 3) * (hi > lo ? (RAW[f] - lo) / (hi - lo) : 0), x = f1(px(t - r + k));
        s += '<line x1="' + x + '" y1="' + Y1 + '" x2="' + x + '" y2="' + f1(Y1 - h) + '" class="sf-rank'
            + (k === r ? ' sf-rank-mid' : isSpike(f) ? ' sf-rank-spike' : '') + '"/>';
    });
    return s;
}

function medianChart(window, out, t, upto) {
    var on = window > 0;
    return chart('Median filter: a one-frame spike is replaced by the median of the frames around it.',
        '<defs><marker id="sf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">'
        + '<path d="M0 0 L8 4 L0 8 Z" class="sf-arrowhead"/></marker></defs>'
        + (on ? band(t, window) + medianStems(t, window) : '')
        + '<path d="' + path(RAW) + '" class="sf-raw-line"/>'
        + (on ? outLine(out, 'sf-out sf-out-median', upto) + dots(out, false, 'sf-med', upto) : '')
        + dots(RAW, true)
        + (on ? current(out, t, upto) : '')
        + SPIKES.map(function (sp) { return spikeArrow(sp[0], out); }).join(''), on ? t : 0);
}

function gaussianChart(window, input, out, inputHasSpikes, t, upto) {
    var on = window > 0, stems = '';
    if (on) {
        var r = shownRadius(window, t), sigma = sigmaForWindow(window), H = 26;
        // The weights inside the window, as stems rising from the bottom of the band.
        for (var d = -r; d <= r; d++) {
            var g = Math.exp(-(d * d) / (2 * sigma * sigma));
            stems += '<line x1="' + f1(px(t + d)) + '" y1="' + Y1 + '" x2="' + f1(px(t + d)) + '" y2="' + f1(Y1 - H * g) + '" class="sf-weight"/>';
        }
    }
    return chart('Gaussian filter: each frame becomes a weighted average of the frames around it, the frame itself counting most.',
        (on ? band(t, window) + stems : '')
        + '<path d="' + path(input) + '" class="' + (inputHasSpikes ? 'sf-raw-line' : 'sf-in-median') + '"/>'
        + (on ? outLine(out, 'sf-out', upto) : '')
        + dots(input, inputHasSpikes, inputHasSpikes ? 'sf-raw' : 'sf-med')
        + (on ? outNodes(out, upto) + current(out, t, upto) : '')
        + (inputHasSpikes ? SPIKES.map(function (sp) { return spikeArrow(sp[0], input); }).join('') : ''), on ? t : 0);
}

// ---- Card 3: gaps and segments ----------------------------------------------

var GN = 60;                                     // frames in the gap card's trace
// Frames with no 3D: a 2-frame hole, a 7-frame absence, then (after a 3-frame
// stretch) a 6-frame one. The node comes back 12 mm away after the 7-frame one, and
// is moving fast as it comes back from the 6-frame one, so a window that only has
// data from that side lands visibly ahead of it. The jitter's seed leaves the first
// frame back close to the true movement, so what the sketch shows is that pull.
var ABSENT = [[9, 10], [20, 26], [30, 35]];
var GAP_DEFAULT = { maxGap: 5, minSegment: 5 };  // the settings' defaults (`ui/settings.js`)
var GAP_SLIDER_MAX = 15;
var GTRUTH = new Float64Array(GN), GRAW = new Float64Array(GN), PRESENT = new Uint8Array(GN);
(function () {
    var seed = 215;
    function rand() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var t = 0; t < GN; t++) {
        GTRUTH[t] = 5 * Math.sin(2 * Math.PI * t / 34) + 12 / (1 + Math.exp(-(t - 23)))
            + 22 / (1 + Math.exp(-(t - 38) / 1.6));
        var absent = ABSENT.some(function (a) { return t >= a[0] && t <= a[1]; });
        PRESENT[t] = absent ? 0 : 1;
        var noise = 6 * (rand() + rand() - 1);
        GRAW[t] = absent ? NaN : GTRUTH[t] + noise;
    }
})();
var GX0 = 8, GX1 = 592, GY0 = 22, GY1 = 104;
var G_MIN = Infinity, G_MAX = -Infinity;
GTRUTH.forEach(function (v) { G_MIN = Math.min(G_MIN, v); G_MAX = Math.max(G_MAX, v); });
GRAW.forEach(function (v) { if (v === v) { G_MIN = Math.min(G_MIN, v); G_MAX = Math.max(G_MAX, v); } });
function gx(t) { return GX0 + (GX1 - GX0) * t / (GN - 1); }
function gy(v) { return GY1 - (GY1 - GY0) * (v - G_MIN) / (G_MAX - G_MIN); }

/** Both stages over `segments`, as the real pass runs them (same segments for both). */
function runSegments(medWindow, gauWindow, segments, minSegment) {
    var mid = new Float64Array(GN), out = new Float64Array(GN);
    smoothSignalInto(GRAW, mid, segments, { kernel: 'median', window: medWindow, minSegment: minSegment }, SCRATCH_V, SCRATCH_W);
    smoothSignalInto(mid, out, segments, { kernel: 'gaussian', window: gauWindow, minSegment: minSegment }, SCRATCH_V, SCRATCH_W);
    return out;
}

/** A path over frames [from, to), broken wherever a value is missing. */
function gPath(values, from, to) {
    var d = '', pen = false;
    for (var t = from; t < to; t++) {
        if (values[t] !== values[t]) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + f1(gx(t)) + ' ' + f1(gy(values[t]));
        pen = true;
    }
    return d;
}

function gapChart(medWindow, gauWindow, maxGap, minSegment) {
    var segments = buildSegments(PRESENT, maxGap), out = runSegments(medWindow, gauWindow, segments, minSegment);
    var half = (GX1 - GX0) / (GN - 1) / 2, s = '<path d="' + gPath(GTRUTH, 0, GN) + '" class="sf-true"/>';
    // Each absence: a dashed box, labelled by what it does to the trace.
    ABSENT.forEach(function (a) {
        var n = a[1] - a[0] + 1, splits = n > maxGap, x = gx(a[0]) - half, w = gx(a[1]) + half - x;
        s += '<rect x="' + f1(x) + '" y="' + GY0 + '" width="' + f1(w) + '" height="' + (GY1 - GY0) + '" class="sf-absent' + (splits ? ' sf-absent-split' : '') + '"/>'
            + '<text x="' + f1(x + w / 2) + '" y="' + (GY0 - 8) + '" text-anchor="middle" class="sf-note' + (splits ? ' sf-note-split' : '') + '">'
            + n + (splits ? ' missing · splits' : ' missing · hole') + '</text>';
    });
    // The measurements' line breaks at every absence: nothing is drawn across one.
    s += '<path d="' + gPath(GRAW, 0, GN) + '" class="sf-raw-line"/>';
    // The output, one piece per segment: blue where smoothed, grey where left as is.
    segments.forEach(function (sg) {
        var short = sg.end - sg.start < minSegment;
        s += '<path d="' + gPath(out, sg.start, sg.end) + '" class="sf-out' + (short ? ' sf-left' : '') + '"/>';
    });
    for (var t = 0; t < GN; t++) {
        if (PRESENT[t]) s += '<circle cx="' + f1(gx(t)) + '" cy="' + f1(gy(GRAW[t])) + '" r="3.4" class="sf-raw"/>';
    }
    // The segments as bars under the trace.
    segments.forEach(function (sg) {
        var short = sg.end - sg.start < minSegment, x = gx(sg.start) - half + 1, w = gx(sg.end - 1) + half - 1 - x;
        s += '<rect x="' + f1(x) + '" y="112" width="' + f1(Math.max(w, 2)) + '" height="5" rx="2" class="sf-seg' + (short ? ' sf-seg-short' : '') + '"/>'
            + '<text x="' + f1(x + w / 2) + '" y="130" text-anchor="middle" class="sf-note">'
            + (sg.end - sg.start) + (short ? ' frames · too short, left as is' : ' frames') + '</text>';
    });
    var label = 'Gaps and segments: absences up to the max gap stay holes inside a segment; longer ones split the trace; '
        + 'segments shorter than the minimum are left as they are.';
    return '<svg viewBox="0 0 600 140" role="img" aria-label="' + label + '">' + s
        + '<text x="' + GX1 + '" y="139" text-anchor="end" class="sf-note">frames →</text></svg>';
}

// ---- Legends ----------------------------------------------------------------

var KEY_TRUE = ['true', 'true movement'];
var KEY_RAW = ['raw', '3D as triangulated'];
var KEY_SPIKE = ['spike', 'one-frame spike'];
var KEY_MEDIAN = ['med', 'after the median'];
var KEY_BAND = ['band', 'window around one frame'];

/** The legend's entries, each `[swatch, text, absent]` (the swatches are `.sf-key-*` in `styles.css`). */
function legendItems(items) {
    return items.map(function (it) {
        return '<span' + (it[2] ? ' class="sf-key-absent"' : '') + '><i class="sf-key-' + it[0] + '"></i>' + it[1] + '</span>';
    }).join('');
}

/**
 * The median card's legend entries. Every entry keeps its row whatever is drawn:
 * one the sketch does not draw right now is marked absent (a third element) and
 * left blank, so nothing in the legend moves as a stage is turned on or off.
 */
function medianKeys(on) {
    return [KEY_TRUE, KEY_RAW, KEY_SPIKE].concat([KEY_MEDIAN, KEY_BAND,
        ['rank', 'window sorted by value'], ['rank-mid', 'the middle value']].map(function (k) { return on ? k : k.concat(true); }));
}

/** The Gaussian card's: its second row is its input, the raw trace when the median is off. */
function gaussianKeys(on, rawInput) {
    return [KEY_TRUE, rawInput ? KEY_RAW : KEY_MEDIAN].concat([['out', 'after the Gaussian'], KEY_BAND,
        ['weight', 'each frame\'s weight']].map(function (k) { return on ? k : k.concat(true); }));
}

/** Shown only while a frame is picked, which is when the ring is drawn. */
var PICKED_KEY = '<span class="sf-picked-key" hidden><i class="sf-key-current"></i>value at the picked frame</span>';

var STAGE_LEGEND = '<div class="smooth-fig-legend"><span class="sf-legend-items"></span>' + PICKED_KEY + '</div>';
var GAP_KEYS = [KEY_TRUE, KEY_RAW, ['out-line', 'after both stages'],
    ['left', 'too short, left as is'], ['hole', 'no 3D, stays a hole'], ['split', 'no 3D, splits the trace'],
    ['seg', 'segment'], ['seg-short', 'segment too short']];
var GAP_LEGEND = '<div class="smooth-fig-legend">' + legendItems(GAP_KEYS) + '</div>';

var SIZE_OFF = -1;     // the Window sliders' off position (step 2, then 1, 3, 5…)
var SIZE_MAX = 31;     // the Window sliders' top; a longer typed window still shows, the slider sits at its end
var WINDOW_MAX = 101;  // the settings' own top (`SMOOTHING_PARAMS`, `ui/settings.js`)
var GAP_MAX = 1000;
var STEP_MS = 90;      // play: one frame of the slide

function plural(n) { return n + (n === 1 ? ' frame' : ' frames'); }

/** A stage's window as the filter takes it: 0 = off, under 3 = 1 frame, else odd. */
function effectiveWindow(v) { return v > 0 ? (normalizeWindow(v) || 1) : 0; }

function sizeControl(name) {
    // The slider's first position is off, one step before 1 frame.
    return { name: 'Window', aria: name + ' window (frames)', min: 0, max: WINDOW_MAX, step: 2, sliderMin: SIZE_OFF, sliderMax: SIZE_MAX, unit: 'frames',
        toSlider: function (v) { return v > 0 ? Math.min(v, SIZE_MAX) : SIZE_OFF; },
        fromSlider: function (pos) { return pos > 0 ? pos : 0; },
        ticks: [[SIZE_OFF, 'off']] };
}
function posControl(name) {
    return { name: 'Frame', aria: 'Frame the ' + name + ' window is on', min: 1, max: N, step: 1, unit: '/ ' + N,
        extra: '<button type="button" class="sf-play" aria-label="Play: slide the ' + name + ' window across the frames">▶</button>' };
}
var GAP_CONTROL = { name: 'Max gap', aria: 'Max gap to smooth across (frames)', min: 0, max: GAP_MAX, step: 1, sliderMax: GAP_SLIDER_MAX, unit: 'frames' };
var MINSEG_CONTROL = { name: 'Min segment', aria: 'Minimum segment length (frames)', min: 1, max: GAP_MAX, step: 1, sliderMax: GAP_SLIDER_MAX, unit: 'frames' };

/** The frames of the trace's spike and fast move, for the docs' step figures and their test. */
export var TRACE_FRAMES = { spike: MEDIAN_FOCUS, fast: GAUSSIAN_FOCUS };

/**
 * The Median or Gaussian card's sketch without its controls, for the docs' step
 * figures (`scripts/smoothing-wiki-figures.mjs`), and the numbers behind it.
 * @param {'median'|'gaussian'} stage
 * @param {number} window that stage's window, 0 = off
 * @param {{medianWindow?: number, frame?: number}} [opts] the Gaussian's input
 *   (0 = the raw trace), and the frame the window sits on (default the card's own)
 * @returns {{svg: string, keys: Array, truth: Float64Array, raw: Float64Array,
 *   medOut: Float64Array, out: Float64Array}} `keys` are the legend's entries
 */
export function stageSketch(stage, window, opts) {
    opts = opts || {};
    var median = stage === 'median', medWindow = median ? window : opts.medianWindow || 0;
    var medOut = run(RAW, 'median', medWindow);
    var input = median ? RAW : medWindow ? medOut : RAW;
    var out = run(input, median ? 'median' : 'gaussian', window);
    var t = opts.frame != null ? opts.frame : median ? MEDIAN_FOCUS : GAUSSIAN_FOCUS;
    return {
        svg: median ? medianChart(window, out, t, null) : gaussianChart(window, input, out, !medWindow, t, null),
        keys: median ? medianKeys(window > 0) : gaussianKeys(window > 0, !medWindow),
        truth: TRUTH, raw: RAW, medOut: medOut, out: out,
    };
}

/**
 * The gaps card's sketch without its controls, for the docs' step figure, and the
 * numbers behind it.
 * @param {{median: number, gaussian: number, maxGap: number, minSegment: number}} o
 * @returns {{svg: string, keys: Array, segments: Array<{start: number, end: number}>,
 *   truth: Float64Array, raw: Float64Array, out: Float64Array}}
 */
export function gapSketch(o) {
    var segments = buildSegments(PRESENT, o.maxGap);
    return {
        svg: gapChart(o.median, o.gaussian, o.maxGap, o.minSegment), keys: GAP_KEYS, segments: segments,
        truth: GTRUTH, raw: GRAW, out: runSegments(o.median, o.gaussian, segments, o.minSegment),
    };
}

/**
 * Build the figure.
 * @param {{onParam?: function(string, number): void, saved?: Object}} [opts]
 *   `onParam(id, value)` is called when a card's Use or Turn off button sets a
 *   setting (`smoothMedianWindow`, `smoothGaussianWindow`, `smoothMaxGap`,
 *   `smoothMinSegment`), so the panel can set its field to match. The sliders and
 *   text boxes never call it. `saved` is those settings as stored when Settings
 *   opened (for "not saved until Apply").
 * @returns {{el: HTMLElement, update: function(Object, Object=): void}} `update`
 *   takes the panel's working map (those four ids), and after an Apply what is
 *   now stored, in place of `saved`.
 */
export function buildSmoothingWindowsFigure(opts) {
    opts = opts || {};
    var saved = opts.saved || {};
    var fig = document.createElement('figure');
    fig.className = 'smooth-fig';
    fig.innerHTML =
        '<p class="smooth-fig-lead">One node\'s x position over 40 frames, made up for this sketch: the true '
        + 'movement (white), with one fast move, and its 3D as triangulated (grey), with jitter and '
        + 'a one-frame spike (red). The '
        + 'median\'s output (green) is the Gaussian\'s input, and the Gaussian\'s output is blue; both are computed '
        + 'with LUC3D\'s own filter. y and z, and every node, are filtered the same way, each on its own. On each '
        + 'card, Window tries a window size and Frame or ▶ slides the window along the frames; only Use changes '
        + 'your setting.</p>'
        + '<div class="smooth-fig-cols">'
        + '<div class="smooth-fig-col" data-stage="median">'
        + '<div class="smooth-fig-name">1 · Median window<span class="fig-big"></span><small></small>' + STAGE_LEGEND + '</div><div class="smooth-fig-chart"></div>'
        + tryStrip(tryControl('size', sizeControl('median')) + tryControl('pos', posControl('median')))
        + settingRow('median')
        + '<p>Each frame takes the middle value of the frames in its window. The stems are the window sorted by '
        + 'value: the middle one (green) is what the frame becomes, so a one-frame spike (red) is dropped rather '
        + 'than averaged in. Real movement shorter than about half the window is erased too: raise the window and '
        + 'watch the fast move flatten.</p></div>'
        + '<div class="smooth-fig-col" data-stage="gaussian">'
        + '<div class="smooth-fig-name">2 · Gaussian window<span class="fig-big"></span><small></small>' + STAGE_LEGEND + '</div><div class="smooth-fig-chart"></div>'
        + tryStrip(tryControl('size', sizeControl('Gaussian')) + tryControl('pos', posControl('Gaussian')))
        + settingRow('gaussian')
        + '<p>Runs on the median\'s output (green: the line on the left). A weighted average over the window: '
        + 'the frame itself counts most and the weights fall off as a bell curve (stems). Removes the jitter the '
        + 'median leaves. 3 frames barely changes anything (each frame keeps about 98% of its own value); 5 is '
        + 'the smallest window that smooths. A long window also damps fast real movement: raise the window and '
        + 'watch the blue line fall short of the tall white peak.</p>'
        + '<p class="smooth-fig-warn" hidden>The median is off, so the Gaussian spreads the spike into a bump.</p></div>'
        + '</div>'
        + '<div class="smooth-fig-col smooth-fig-wide" data-stage="gaps">'
        + '<div class="smooth-fig-name">3 · Gaps and segments<span class="fig-big"></span><small></small></div><div class="smooth-fig-chart"></div>'
        + GAP_LEGEND
        + tryStrip(tryControl('gap', GAP_CONTROL) + tryControl('minseg', MINSEG_CONTROL))
        + settingRow('gaps')
        + '<p>Another made-up node, 60 frames, smoothed by both stages at the windows above. Frames with no 3D are '
        + 'never filled in. An absence up to Max gap frames long is a hole inside its segment, and the windows skip '
        + 'over it. A longer one splits the trace into segments (bars), and no window reaches across a split, so the '
        + 'line never cuts straight through the time the node was missing; here it comes back 12 mm away. Raise Max '
        + 'gap past an absence and it becomes a hole: the frames next to it then average data from one side only, '
        + 'which pulls them toward that side. Try Max gap 7 with a Gaussian window of 15: the node is moving fast after '
        + 'the 6-frame absence, and the first frame back lands well ahead of it. A segment shorter than Minimum segment length is left as it is (grey). Near a segment\'s ends the window shrinks '
        + 'evenly, so smoothing is weakest there.</p></div>';

    var PARAM = { median: 'smoothMedianWindow', gaussian: 'smoothGaussianWindow' };
    // `setting` is the panel's working map; `tried` is what the sketch shows, the
    // same ids, and never leaves this figure except through a Use button.
    var setting = {}, tried = {};
    var cards = {}, state = {}, sizeCtl = {}, posCtl = {}, showSetting = {}, candidate = {}, data = null;
    ['median', 'gaussian'].forEach(function (k) {
        var el = cards[k] = fig.querySelector('[data-stage="' + k + '"]');
        var name = k === 'median' ? 'median' : 'Gaussian';
        // `pos` is the frame the window sits on; `upto` is set while a frame is
        // picked (the output is solid only up to it), null = the whole line.
        state[k] = { pos: k === 'median' ? MEDIAN_FOCUS : GAUSSIAN_FOCUS, upto: null, timer: 0 };
        sizeCtl[k] = wireTryControl(el, 'size', sizeControl(name), function (v) {
            tried[PARAM[k]] = v;
            redraw();
        });
        posCtl[k] = wireTryControl(el, 'pos', posControl(name), function (v) {
            stop(k);
            state[k].pos = state[k].upto = v - 1;
            render(k);
        });
        showSetting[k] = wireSettingRow(el, k, {
            use: function () { commit(PARAM[k], candidate[k]); redraw(); },
            off: function () { commit(PARAM[k], 0); redraw(); },
            reset: function () { tried[PARAM[k]] = setting[PARAM[k]] || 0; redraw(); },
        });
        var play = el.querySelector('.sf-play');
        play.addEventListener('click', function () {
            if (state[k].timer) { stop(k); return; }
            if (state[k].upto == null || state[k].pos >= N - 1) state[k].pos = 0;
            state[k].upto = state[k].pos;
            render(k);
            play.textContent = '❚❚';
            play.setAttribute('aria-pressed', 'true');
            state[k].timer = setInterval(function () {
                if (!fig.isConnected) { stop(k); return; }
                state[k].pos += 1;
                state[k].upto = state[k].pos;
                if (state[k].pos >= N - 1) stop(k);
                render(k);
            }, STEP_MS);
        });
    });

    // Card 3's controls: Max gap and Minimum segment length.
    var gapCard = fig.querySelector('[data-stage="gaps"]');
    var gapCtl = wireTryControl(gapCard, 'gap', GAP_CONTROL, function (v) { tried.smoothMaxGap = Math.floor(v); redraw(); });
    var minSegCtl = wireTryControl(gapCard, 'minseg', MINSEG_CONTROL, function (v) { tried.smoothMinSegment = Math.floor(v); redraw(); });
    var showGapSetting = wireSettingRow(gapCard, 'gaps', {
        use: function () {
            commit('smoothMaxGap', gapValue('smoothMaxGap', tried));
            commit('smoothMinSegment', gapValue('smoothMinSegment', tried));
            redraw();
        },
        off: function () {},
        reset: function () {
            tried.smoothMaxGap = setting.smoothMaxGap;
            tried.smoothMinSegment = setting.smoothMinSegment;
            redraw();
        },
    });

    function commit(id, value) {
        setting[id] = value;
        tried[id] = value;
        if (opts.onParam) opts.onParam(id, value);
    }

    function gapValue(id, from) {
        if (id === 'smoothMaxGap') return from.smoothMaxGap == null ? GAP_DEFAULT.maxGap : Math.max(0, Math.floor(+from.smoothMaxGap) || 0);
        return from.smoothMinSegment == null ? GAP_DEFAULT.minSegment : Math.max(1, Math.floor(+from.smoothMinSegment) || 1);
    }

    function stop(k) {
        clearInterval(state[k].timer);
        state[k].timer = 0;
        var play = cards[k].querySelector('.sf-play');
        play.textContent = '▶';
        play.setAttribute('aria-pressed', 'false');
    }

    function render(k) {
        if (!data) return;
        var st = state[k], el = cards[k];
        posCtl[k].set(st.pos + 1);
        var on = (k === 'median' ? data.medShown : data.gauShown) > 0;
        el.querySelector('.sf-picked-key').hidden = !on || st.upto == null;
        if (k === 'median') {
            el.querySelector('.smooth-fig-chart').innerHTML = medianChart(data.medShown, data.medOut, st.pos, st.upto);
        } else {
            el.querySelector('.smooth-fig-chart').innerHTML =
                gaussianChart(data.gauShown, data.gauIn, data.gauOut, data.rawInput, st.pos, st.upto);
        }
    }

    function update(next, nextSaved) {
        if (nextSaved) saved = nextSaved;
        next = next || {};
        // A value set elsewhere (a field below, or the first call) shows in the
        // sketch; values only being tried stay.
        Object.keys(next).forEach(function (id) {
            if (next[id] !== setting[id]) tried[id] = next[id];
            setting[id] = next[id];
        });
        redraw();
    }

    function redraw() {
        // The filter treats a window under 3 as off (`normalizeWindow`), which
        // leaves the 3D as it is: drawn as a 1-frame window. 0 draws no window at all.
        var mSet = +tried.smoothMedianWindow || 0, gSet = +tried.smoothGaussianWindow || 0;
        var mw = normalizeWindow(mSet);
        var gw = normalizeWindow(gSet);
        var medShown = mw || (mSet > 0 ? 1 : 0);
        var medOut = run(RAW, 'median', medShown);
        // The real pass feeds the Gaussian the median's output; with the median
        // off, it gets the raw 3D, spike and all.
        var gauIn = mw ? medOut : RAW;
        var rawIntoGaussian = !mw && !!gw;
        var gauShown = gw || (gSet > 0 ? 1 : 0);
        var gauOut = run(gauIn, 'gaussian', gauShown);
        data = { medShown: medShown, medOut: medOut, gauShown: gauShown, gauIn: gauIn, gauOut: gauOut,
            rawIntoGaussian: rawIntoGaussian, rawInput: !mw };

        [['median', medShown, mSet], ['gaussian', gauShown, gSet]].forEach(function (c) {
            var k = c[0], shown = c[1], typed = c[2], off = !(typed > 0), el = cards[k], id = PARAM[k];
            el.querySelector('.fig-big').textContent = off ? 'off' : plural(shown);
            el.querySelector('small').textContent = off ? 'set a Window below to try it' : shown === 1 ? 'no smoothing' : ' ';
            el.querySelector('.sf-legend-items').innerHTML = legendItems(k === 'median' ? medianKeys(!off) : gaussianKeys(!off, !mw));
            // With no window there is nothing for Frame to move.
            if (off) stop(k);
            el.querySelectorAll('[data-try="pos"] input, .sf-play').forEach(function (c) { c.disabled = off; });
            sizeCtl[k].set(typed, shown > 0 ? Math.min(shown, SIZE_MAX) : SIZE_OFF);
            var now = effectiveWindow(+setting[id] || 0);
            // What Use would set: the tried window, if one is being tried.
            var tryNow = candidate[k] = typed > 0 ? effectiveWindow(typed) : 0;
            showSetting[k]({
                label: 'Your setting',
                now: now > 0 ? plural(now) : 'off',
                unsaved: (+setting[id] || 0) !== (+saved[id] || 0),
                use: tryNow > 0 && tryNow !== now ? 'Use ' + plural(tryNow) : null,
                off: now > 0,
                reset: typed !== (+setting[id] || 0),
            });
            render(k);
        });
        cards.gaussian.querySelector('.smooth-fig-warn').hidden = !rawIntoGaussian;

        var maxGap = gapValue('smoothMaxGap', tried), minSeg = gapValue('smoothMinSegment', tried);
        var nowGap = gapValue('smoothMaxGap', setting), nowSeg = gapValue('smoothMinSegment', setting);
        gapCard.querySelector('.fig-big').textContent = 'Max gap ' + maxGap + ' · minimum segment ' + minSeg;
        // This card is about the segments, so a stage that is off still smooths here.
        var gapMed = medShown || EXAMPLE.median, gapGau = gauShown || EXAMPLE.gaussian;
        gapCard.querySelector('small').textContent = 'with median ' + gapMed + (medShown ? '' : ' (example)')
            + ', Gaussian ' + gapGau + (gauShown ? '' : ' (example)');
        gapCtl.set(maxGap, Math.min(maxGap, GAP_SLIDER_MAX));
        minSegCtl.set(minSeg, Math.min(minSeg, GAP_SLIDER_MAX));
        var differs = maxGap !== nowGap || minSeg !== nowSeg;
        showGapSetting({
            label: 'Your settings',
            now: 'max gap ' + nowGap + ', minimum segment ' + nowSeg,
            unsaved: nowGap !== gapValue('smoothMaxGap', saved) || nowSeg !== gapValue('smoothMinSegment', saved),
            use: differs ? 'Use max gap ' + maxGap + ', minimum segment ' + minSeg : null,
            off: false,
            reset: differs,
        });
        gapCard.querySelector('.smooth-fig-chart').innerHTML = gapChart(gapMed, gapGau, maxGap, minSeg);
    }

    return { el: fig, update: update };
}
