// ui/smoothing-windows-figure.js
// The Settings ▸ Temporal Smoothing figure: what the Median window and the
// Gaussian window each do, as two cards side by side (stage 1, stage 2).
//
// Both cards plot the same made-up trace: one node's x position over 40 frames
// (a slow back-and-forth movement, dashed), as triangulation would give it with
// a little jitter and two one-frame spikes (dots). Each card draws what its
// stage makes of its input, the window around one frame (shaded), and for the
// Gaussian the weights inside that window (a bell of stems). The median's
// output is green in both cards, a line on the left and the Gaussian's input
// dots on the right, so the hand-off reads; the Gaussian's output is blue.
//
// The filtering is NOT hand-drawn: it runs LUC3D's own `smoothSignalInto` on
// the trace, one segment, so the sketch is exactly what the filter does to it.
// `update(params)` redraws from the panel's working values, so the cards follow
// the windows as they are typed. A stage that is off (0) is drawn with an
// example window instead, labelled as an example. The Gaussian
// card's input is the median's output, as in the real pass, except when the
// median is off and the Gaussian is on: then it is the raw trace, and the card
// shows the spikes being spread into bumps (why the median runs first).
//
// Depends on: pose/temporal-smoothing.js (`smoothSignalInto`, `normalizeWindow`,
// `sigmaForWindow`). Colours come from `styles.css` (`.smooth-fig`).

import { smoothSignalInto, normalizeWindow, sigmaForWindow } from '../pose/temporal-smoothing.js?v=81cf1144290e';

var N = 40;                              // frames in the trace
var SPIKES = [[11, 13], [28, -13]];      // [frame, mm] one-frame spikes
var EXAMPLE = { median: 5, gaussian: 9 };
var MEDIAN_FOCUS = SPIKES[0][0];         // spike whose window card 1 shades and circles
var GAUSSIAN_FOCUS = 20;                 // frame whose window card 2 shades

// The true movement and the trace triangulation gives of it. The jitter is a
// fixed pseudo-random sequence so the figure is the same every time.
var TRUTH = new Float64Array(N);
var RAW = new Float64Array(N);
(function () {
    var seed = 7;
    function rand() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var t = 0; t < N; t++) {
        TRUTH[t] = 6 * Math.sin(2 * Math.PI * (t - 2) / 30);
        RAW[t] = TRUTH[t] + 8 * (rand() + rand() - 1);
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
RAW.forEach(function (v) { Y_MIN = Math.min(Y_MIN, v); Y_MAX = Math.max(Y_MAX, v); });
function px(t) { return X0 + (X1 - X0) * t / (N - 1); }
function py(v) { return Y1 - (Y1 - Y0) * (v - Y_MIN) / (Y_MAX - Y_MIN); }
function f1(v) { return Math.round(v * 10) / 10; }
function path(values) {
    var d = '';
    for (var t = 0; t < values.length; t++) d += (t ? 'L' : 'M') + f1(px(t)) + ' ' + f1(py(values[t]));
    return d;
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
        + (2 * r + 1) + ' frames</text>';
}

/**
 * Dots for a trace (class `cls`, default the raw grey); spikes still in it are
 * drawn red. Raw samples are open rings, a little larger than the filled dots
 * and drawn over them: a median keeps many samples exactly (its output IS one
 * of the window's samples), so a filled raw dot would hide under the green one.
 */
function dots(values, showSpikes, cls) {
    var s = '';
    for (var t = 0; t < values.length; t++) {
        var c = showSpikes && isSpike(t) ? 'sf-spike' : cls || 'sf-raw';
        s += '<circle cx="' + f1(px(t)) + '" cy="' + f1(py(values[t])) + '" r="' + (c === 'sf-raw' ? 3.4 : 2.2)
            + '" class="' + c + '"/>';
    }
    return s;
}

/** The Gaussian's output at every frame: open black circles on the blue line. */
function outNodes(values) {
    var s = '';
    for (var t = 0; t < values.length; t++) {
        s += '<circle cx="' + f1(px(t)) + '" cy="' + f1(py(values[t])) + '" r="2.2" class="sf-out-node"/>';
    }
    return s;
}

function chart(label, inner) {
    return '<svg viewBox="0 0 300 140" role="img" aria-label="' + label + '">'
        + '<line x1="' + X0 + '" y1="' + (Y1 + 3) + '" x2="' + X1 + '" y2="' + (Y1 + 3) + '" class="sf-axis"/>'
        + inner
        + '<text x="' + X1 + '" y="' + (Y1 + 11) + '" text-anchor="end" class="sf-note">frames →</text>'
        + '</svg>';
}

/** An arrow from the spike at frame `t` to where the median puts it, and its label. */
function spikeArrow(t, out) {
    var down = out[t] < RAW[t] ? 1 : -1, y0 = py(RAW[t]), y1 = py(out[t]);
    return '<line x1="' + f1(px(t)) + '" y1="' + f1(y0 + 4 * down) + '" x2="' + f1(px(t)) + '" y2="' + f1(y1 - 4 * down)
        + '" class="sf-move" marker-end="url(#sf-arrow)"/>'
        + '<text x="' + f1(px(t) + 6) + '" y="' + f1(y0 + 4) + '" class="sf-note sf-note-spike">spike</text>';
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

function medianChart(window, out) {
    var t = MEDIAN_FOCUS;
    return chart('Median filter: a one-frame spike is replaced by the median of the frames around it.',
        '<defs><marker id="sf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">'
        + '<path d="M0 0 L8 4 L0 8 Z" class="sf-arrowhead"/></marker></defs>'
        + band(t, window) + medianStems(t, window)
        + '<path d="' + path(TRUTH) + '" class="sf-true"/>'
        + '<path d="' + path(out) + '" class="sf-out sf-out-median"/>'
        + dots(out, false, 'sf-med')
        + dots(RAW, true)
        + SPIKES.map(function (sp) { return spikeArrow(sp[0], out); }).join(''));
}

function gaussianChart(window, input, out, inputHasSpikes) {
    var t = GAUSSIAN_FOCUS, r = shownRadius(window, t), sigma = sigmaForWindow(window);
    // The weights inside the window, as stems rising from the bottom of the band.
    var stems = '', H = 26;
    for (var d = -r; d <= r; d++) {
        var g = Math.exp(-(d * d) / (2 * sigma * sigma));
        stems += '<line x1="' + f1(px(t + d)) + '" y1="' + Y1 + '" x2="' + f1(px(t + d)) + '" y2="' + f1(Y1 - H * g) + '" class="sf-weight"/>';
    }
    return chart('Gaussian filter: each frame becomes a weighted average of the frames around it, the frame itself counting most.',
        band(t, window) + stems
        + '<path d="' + path(TRUTH) + '" class="sf-true"/>'
        + '<path d="' + path(out) + '" class="sf-out"/>'
        + dots(input, inputHasSpikes, inputHasSpikes ? 'sf-raw' : 'sf-med')
        + outNodes(out));
}

function tagline(window, example) {
    return example ? 'off (0) · example with ' + window + ' frames' : window + ' frames';
}

/**
 * Build the figure.
 * @returns {{el: HTMLElement, update: function(Object): void}} `update` takes the
 *   panel's working map (`smoothMedianWindow`, `smoothGaussianWindow`).
 */
export function buildSmoothingWindowsFigure() {
    var fig = document.createElement('figure');
    fig.className = 'smooth-fig';
    fig.innerHTML =
        '<p class="smooth-fig-lead">One node\'s x position over 40 frames, made up for this sketch: the true '
        + 'movement (dashed) and its 3D as triangulated (grey rings), with jitter and two one-frame spikes (red). The '
        + 'median\'s output (green) is the Gaussian\'s input, and the Gaussian\'s output is blue; both are computed '
        + 'with LUC3D\'s own filter and follow the windows you enter below. y and z, and every node, are filtered '
        + 'the same way, each on its own.</p>'
        + '<div class="smooth-fig-cols">'
        + '<div class="smooth-fig-col" data-stage="median">'
        + '<div class="smooth-fig-name">1 · Median window<small></small></div><div class="smooth-fig-chart"></div>'
        + '<p>Each frame takes the middle value of the frames in its window. The stems are the window around the '
        + 'left spike sorted by value: the middle one (green) is what that frame becomes, so a one-frame spike '
        + '(red) is dropped rather than averaged in. Real movement shorter than about half the window is erased '
        + 'too, so keep it short for fast motion.</p></div>'
        + '<div class="smooth-fig-col" data-stage="gaussian">'
        + '<div class="smooth-fig-name">2 · Gaussian window<small></small></div><div class="smooth-fig-chart"></div>'
        + '<p>Runs on the median\'s output (green dots: the line on the left). A weighted average over the window: the frame itself counts most '
        + 'and the weights fall off as a bell curve (stems). Removes the jitter the median leaves. A long window '
        + 'also flattens real peaks: compare the blue line with the dashed true movement.</p>'
        + '<p class="smooth-fig-warn" hidden>The median is off, so the Gaussian spreads each spike into a bump.</p></div>'
        + '</div>'
        + '<div class="smooth-fig-legend">'
        + '<span><i class="sf-key-true"></i>true movement</span>'
        + '<span><i class="sf-key-raw"></i>3D as triangulated</span>'
        + '<span><i class="sf-key-spike"></i>one-frame spike</span>'
        + '<span><i class="sf-key-med"></i>after the median</span>'
        + '<span><i class="sf-key-out"></i>after the Gaussian</span>'
        + '<span><i class="sf-key-band"></i>window around one frame</span>'
        + '</div>';

    var med = fig.querySelector('[data-stage="median"]');
    var gau = fig.querySelector('[data-stage="gaussian"]');

    function update(params) {
        params = params || {};
        var mw = normalizeWindow(params.smoothMedianWindow);
        var gw = normalizeWindow(params.smoothGaussianWindow);
        var medShown = mw || EXAMPLE.median;
        var medOut = run(RAW, 'median', medShown);
        // The real pass feeds the Gaussian the median's output; with only the
        // Gaussian on, it gets the raw 3D, spikes and all.
        var rawIntoGaussian = !mw && !!gw;
        var gauIn = rawIntoGaussian ? RAW : medOut;
        var gauShown = gw || EXAMPLE.gaussian;
        var gauOut = run(gauIn, 'gaussian', gauShown);

        med.querySelector('small').textContent = tagline(medShown, !mw);
        med.querySelector('.smooth-fig-chart').innerHTML = medianChart(medShown, medOut);
        gau.querySelector('small').textContent = tagline(gauShown, !gw);
        gau.querySelector('.smooth-fig-chart').innerHTML = gaussianChart(gauShown, gauIn, gauOut, rawIntoGaussian);
        gau.querySelector('.smooth-fig-warn').hidden = !rawIntoGaussian;
    }

    return { el: fig, update: update };
}
