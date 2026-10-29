// ui/smoothing-windows-figure.js
// The Settings ▸ Temporal Smoothing figure: what the Median window and the
// Gaussian window each do, as two cards side by side (stage 1, stage 2).
//
// Both cards plot the same made-up trace: one node's x position over 40 frames
// (a slow back-and-forth movement, dashed), as triangulation would give it with
// a little jitter (rings), one one-frame spike (red) and, on the right, a fast
// real movement: a quick dart up and back over a few frames, which too long a
// window flattens (over-smoothing). Each card draws what its
// stage makes of its input, the window around one frame (shaded), and for the
// Gaussian the weights inside that window (a bell of stems). The median's
// output is green in both cards, a line on the left and the Gaussian's input
// dots on the right, so the hand-off reads; the Gaussian's output is blue.
//
// The filtering is NOT hand-drawn: it runs LUC3D's own `smoothSignalInto` on
// the trace, one segment, so the sketch is exactly what the filter does to it.
// `update(params)` redraws from the panel's working values, so the cards follow
// the windows as they are typed. A stage that is off (0) is drawn with an
// example window instead, labelled as an example.
//
// Each card has two sliders. Window (1 = no smoothing) sets that stage's window size and reports
// it through `onWindow(id, value)`, so the panel can set its number field (and
// the stage turns on). Frame slides the shaded window along the trace, and its
// play button animates the slide: while a frame is picked, the output is drawn
// solid up to that frame and faint after it, so the line builds frame by frame.
// The Gaussian
// card's input is the median's output, as in the real pass, except when the
// median is off and the Gaussian is on: then it is the raw trace, and the card
// shows the spike being spread into a bump (why the median runs first).
//
// Depends on: pose/temporal-smoothing.js (`smoothSignalInto`, `normalizeWindow`,
// `sigmaForWindow`). Colours come from `styles.css` (`.smooth-fig`).

import { smoothSignalInto, normalizeWindow, sigmaForWindow } from '../pose/temporal-smoothing.js?v=7a9a2de1fb85';

var N = 40;                              // frames in the trace
var SPIKES = [[11, 13]];                 // [frame, mm] one-frame spikes
var FAST = { frame: 25, height: 16, sigma: 2 };     // fast real movement: a quick dart, mm and frames
var EXAMPLE = { median: 5, gaussian: 9 };
var MEDIAN_FOCUS = SPIKES[0][0];         // frame card 1's window starts on (the spike)
var GAUSSIAN_FOCUS = FAST.frame;         // frame card 2's window starts on (the fast move)

// The true movement and the trace triangulation gives of it. The jitter is a
// fixed pseudo-random sequence so the figure is the same every time.
var TRUTH = new Float64Array(N);
var RAW = new Float64Array(N);
(function () {
    var seed = 7;
    function rand() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var t = 0; t < N; t++) {
        TRUTH[t] = 6 * Math.sin(2 * Math.PI * (t - 2) / 30)
            + FAST.height * Math.exp(-(t - FAST.frame) * (t - FAST.frame) / (2 * FAST.sigma * FAST.sigma));
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

/** "fast move" beside the true path's peak at the fast movement. */
function fastLabel() {
    return '<text x="' + f1(px(FAST.frame) + 9) + '" y="' + f1(py(TRUTH[FAST.frame]) + 3) + '" class="sf-note">fast move</text>';
}

/** One card's chart. The axis label steps aside when the window's label (centred on `t`) reaches it. */
function chart(label, inner, t) {
    var axisLabel = px(t) < X1 - 75
        ? '<text x="' + X1 + '" y="' + (Y1 + 11) + '" text-anchor="end" class="sf-note">frames →</text>' : '';
    return '<svg viewBox="0 0 300 140" role="img" aria-label="' + label + '">'
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
    return chart('Median filter: a one-frame spike is replaced by the median of the frames around it.',
        '<defs><marker id="sf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">'
        + '<path d="M0 0 L8 4 L0 8 Z" class="sf-arrowhead"/></marker></defs>'
        + band(t, window) + medianStems(t, window)
        + '<path d="' + path(TRUTH) + '" class="sf-true"/>'
        + outLine(out, 'sf-out sf-out-median', upto)
        + dots(out, false, 'sf-med', upto)
        + dots(RAW, true)
        + current(out, t, upto)
        + SPIKES.map(function (sp) { return spikeArrow(sp[0], out); }).join('')
        + fastLabel(), t);
}

function gaussianChart(window, input, out, inputHasSpikes, t, upto) {
    var r = shownRadius(window, t), sigma = sigmaForWindow(window);
    // The weights inside the window, as stems rising from the bottom of the band.
    var stems = '', H = 26;
    for (var d = -r; d <= r; d++) {
        var g = Math.exp(-(d * d) / (2 * sigma * sigma));
        stems += '<line x1="' + f1(px(t + d)) + '" y1="' + Y1 + '" x2="' + f1(px(t + d)) + '" y2="' + f1(Y1 - H * g) + '" class="sf-weight"/>';
    }
    return chart('Gaussian filter: each frame becomes a weighted average of the frames around it, the frame itself counting most.',
        band(t, window) + stems
        + '<path d="' + path(TRUTH) + '" class="sf-true"/>'
        + outLine(out, 'sf-out', upto)
        + dots(input, inputHasSpikes, inputHasSpikes ? 'sf-raw' : 'sf-med')
        + outNodes(out, upto)
        + current(out, t, upto)
        + fastLabel(), t);
}

function tagline(window, example) {
    if (example) return 'off (0) · example with ' + window + ' frames';
    return window === 1 ? '1 frame · no smoothing' : window + ' frames';
}

var SIZE_MAX = 31;     // the Window sliders' top; a longer typed window still shows, the slider sits at its end
var STEP_MS = 90;      // play: one frame of the slide

/** A card's sliders: window size, then the frame the window sits on, with play. */
function controls(stage) {
    var name = stage === 'median' ? 'median' : 'Gaussian';
    return '<div class="smooth-fig-ctrl">'
        + '<label class="sf-ctl"><span class="sf-ctl-name">Window</span>'
        + '<input type="range" class="sf-size" min="1" max="' + SIZE_MAX + '" step="2" aria-label="' + name + ' window size (frames)">'
        + '<output class="sf-ctl-val sf-size-val"></output></label>'
        + '<div class="sf-ctl"><span class="sf-ctl-name">Frame</span>'
        + '<input type="range" class="sf-pos" min="0" max="' + (N - 1) + '" step="1" aria-label="Frame the ' + name + ' window is on">'
        + '<output class="sf-ctl-val sf-pos-val"></output>'
        + '<button type="button" class="sf-play" aria-label="Play: slide the ' + name + ' window across the frames">▶</button></div>'
        + '</div>';
}

/**
 * Build the figure.
 * @param {{onWindow?: function(string, number): void}} [opts] `onWindow(id, value)`
 *   is called when a card's Window slider moves (`id` is `smoothMedianWindow` or
 *   `smoothGaussianWindow`), so the panel can set its field to match.
 * @returns {{el: HTMLElement, update: function(Object): void}} `update` takes the
 *   panel's working map (`smoothMedianWindow`, `smoothGaussianWindow`).
 */
export function buildSmoothingWindowsFigure(opts) {
    opts = opts || {};
    var fig = document.createElement('figure');
    fig.className = 'smooth-fig';
    fig.innerHTML =
        '<p class="smooth-fig-lead">One node\'s x position over 40 frames, made up for this sketch: the true '
        + 'movement (dashed), with one fast move on the right, and its 3D as triangulated (grey rings), with jitter and '
        + 'a one-frame spike (red). The '
        + 'median\'s output (green) is the Gaussian\'s input, and the Gaussian\'s output is blue; both are computed '
        + 'with LUC3D\'s own filter and follow the windows you enter below. y and z, and every node, are filtered '
        + 'the same way, each on its own. On each card, Window changes the window size (and the field below), and '
        + 'Frame or ▶ slides the window along the frames.</p>'
        + '<div class="smooth-fig-cols">'
        + '<div class="smooth-fig-col" data-stage="median">'
        + '<div class="smooth-fig-name">1 · Median window<small></small></div><div class="smooth-fig-chart"></div>'
        + controls('median')
        + '<p>Each frame takes the middle value of the frames in its window. The stems are the window sorted by '
        + 'value: the middle one (green) is what the frame becomes, so a one-frame spike (red) is dropped rather '
        + 'than averaged in. Real movement shorter than about half the window is erased too: raise the window and '
        + 'watch the fast move flatten.</p></div>'
        + '<div class="smooth-fig-col" data-stage="gaussian">'
        + '<div class="smooth-fig-name">2 · Gaussian window<small></small></div><div class="smooth-fig-chart"></div>'
        + controls('gaussian')
        + '<p>Runs on the median\'s output (green dots: the line on the left). A weighted average over the window: '
        + 'the frame itself counts most and the weights fall off as a bell curve (stems). Removes the jitter the '
        + 'median leaves. A long window also flattens fast real movement: compare the blue line with the dashed '
        + 'true movement at the fast move.</p>'
        + '<p class="smooth-fig-warn" hidden>The median is off, so the Gaussian spreads the spike into a bump.</p></div>'
        + '</div>'
        + '<div class="smooth-fig-legend">'
        + '<span><i class="sf-key-true"></i>true movement</span>'
        + '<span><i class="sf-key-raw"></i>3D as triangulated</span>'
        + '<span><i class="sf-key-spike"></i>one-frame spike</span>'
        + '<span><i class="sf-key-med"></i>after the median</span>'
        + '<span><i class="sf-key-out"></i>after the Gaussian</span>'
        + '<span><i class="sf-key-band"></i>window around one frame</span>'
        + '</div>';

    var PARAM = { median: 'smoothMedianWindow', gaussian: 'smoothGaussianWindow' };
    var cards = {}, state = {}, params = {}, data = null;
    ['median', 'gaussian'].forEach(function (k) {
        var el = fig.querySelector('[data-stage="' + k + '"]');
        cards[k] = el;
        // `pos` is the frame the window sits on; `upto` is set while a frame is
        // picked (the output is solid only up to it), null = the whole line.
        state[k] = { pos: k === 'median' ? MEDIAN_FOCUS : GAUSSIAN_FOCUS, upto: null, timer: 0 };
        var size = el.querySelector('.sf-size'), pos = el.querySelector('.sf-pos'), play = el.querySelector('.sf-play');
        size.addEventListener('input', function () {
            var v = +size.value, next = {};
            Object.keys(params).forEach(function (id) { next[id] = params[id]; });
            next[PARAM[k]] = v;
            update(next);
            if (opts.onWindow) opts.onWindow(PARAM[k], v);
        });
        pos.addEventListener('input', function () {
            stop(k);
            state[k].pos = state[k].upto = +pos.value;
            render(k);
        });
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
        el.querySelector('.sf-pos').value = String(st.pos);
        el.querySelector('.sf-pos-val').textContent = (st.pos + 1) + ' / ' + N;
        if (k === 'median') {
            el.querySelector('.smooth-fig-chart').innerHTML = medianChart(data.medShown, data.medOut, st.pos, st.upto);
        } else {
            el.querySelector('.smooth-fig-chart').innerHTML =
                gaussianChart(data.gauShown, data.gauIn, data.gauOut, data.rawIntoGaussian, st.pos, st.upto);
        }
    }

    function update(next) {
        params = next || {};
        // The filter treats a window under 3 as off (`normalizeWindow`), which
        // leaves the 3D as it is: drawn as a 1-frame window. Only 0 gets the example.
        var mSet = +params.smoothMedianWindow || 0, gSet = +params.smoothGaussianWindow || 0;
        var mw = normalizeWindow(mSet);
        var gw = normalizeWindow(gSet);
        var medShown = mw || (mSet > 0 ? 1 : EXAMPLE.median);
        var medOut = run(RAW, 'median', medShown);
        // The real pass feeds the Gaussian the median's output; with only the
        // Gaussian on, it gets the raw 3D, spike and all.
        var rawIntoGaussian = !mw && !!gw;
        var gauIn = rawIntoGaussian ? RAW : medOut;
        var gauShown = gw || (gSet > 0 ? 1 : EXAMPLE.gaussian);
        var gauOut = run(gauIn, 'gaussian', gauShown);
        data = { medShown: medShown, medOut: medOut, gauShown: gauShown, gauIn: gauIn, gauOut: gauOut,
            rawIntoGaussian: rawIntoGaussian };

        [['median', medShown, !(mSet > 0)], ['gaussian', gauShown, !(gSet > 0)]].forEach(function (c) {
            var el = cards[c[0]];
            el.querySelector('small').textContent = tagline(c[1], c[2]);
            el.querySelector('.sf-size').value = String(Math.min(c[1], SIZE_MAX));
            el.querySelector('.sf-size-val').textContent = c[1] + (c[2] ? ' (example)' : '');
            render(c[0]);
        });
        cards.gaussian.querySelector('.smooth-fig-warn').hidden = !rawIntoGaussian;
    }

    return { el: fig, update: update };
}
