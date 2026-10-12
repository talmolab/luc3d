// ui/seekbar-ticks.js — a time ruler under the transport seekbar: labelled
// major ticks ("05:00", "10:00", …) with unlabelled minor ticks between them,
// so a moment can be found and clicked by eye without hovering for the
// tooltip.
//
// The spacing follows the video: the major step is the SMALLEST "nice" time
// step (`TICK_STEPS` — 1/2/5 below a minute, then 1/2/5/10/15/30 min, then
// hours) whose labels clear each other at the bar's current width, so a long
// recording gets longer steps and a wider bar gets shorter ones. The minor
// step is the smallest nice step that divides the major one into at most
// `MAX_MINOR_PER_MAJOR` parts and is still `MIN_MINOR_SPACING_PX` apart.
// Neither is ever shorter than one frame — a tick finer than that could not
// be clicked onto.
//
// Positions use the seekbar's own frame -> position mapping
// (`frame / (totalFrames - 1)`, the thumb's and ui/seekbar-markers.js'), at
// the frame-start time the readout and tooltip use (`frameIdx / fps`, at the
// playback FPS). So a click on the "05:00" tick lands on the frame the
// readout then shows as 05:00.000. Labels speak the readout's format minus
// the milliseconds: `mm:ss`, `h:mm:ss` from the hour, a decimal only when
// the step is under a second. Without a frame rate (fps 0 — set while a
// session has no video yet) there are no times to mark, so no ruler.
//
// The ruler is part of the seekbar (a child of `#seekbar`): a click or drag on
// it scrubs and hovering it shows the tooltip, which makes the labels a bigger
// target rather than a dead strip. It never re-renders per frame — the
// per-frame call compares two numbers and returns — only when the frame
// count, the FPS or the bar's width (a `ResizeObserver`) changes.
//
// Dependency-free (imports NO project modules), like ui/seekbar-tooltip.js:
// `seekbarTimeTicks` is unit-tested in Node (`tests/test-seekbar-ticks.mjs`);
// ui/ui-wiring.js installs the DOM half on `#seekbarRuler`.

/** Candidate step lengths, in seconds, smallest first. */
export const TICK_STEPS = [
    0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30,
    60, 120, 300, 600, 900, 1800,
    3600, 7200, 10800, 21600, 43200, 86400,
];

/** Labels are at least this far apart, centre to centre … */
export const MIN_LABEL_SPACING_PX = 60;
/** … and at least this many label widths (so the left-aligned first label still clears the second). */
export const LABEL_SPACING_WIDTHS = 1.75;
/** Minor ticks closer than this are noise rather than a scale. */
export const MIN_MINOR_SPACING_PX = 8;
/** At most this many minor intervals per major one. */
export const MAX_MINOR_PER_MAJOR = 6;
/** Width of one label character when nothing has been measured (10 px monospace). */
export const DEFAULT_CHAR_PX = 6;

/** Decimals a label needs for a step: none from one second up, else one (the steps are tenths). */
function stepDecimals(step) { return step >= 1 ? 0 : 1; }

/**
 * A tick label: `mm:ss`, or `h:mm:ss` from one hour up, with `decimals`
 * digits of seconds when asked. Rounds first, so 59.96 s at one decimal reads
 * `01:00.0`, never `00:60.0`.
 */
export function formatTickLabel(seconds, decimals) {
    var d = decimals > 0 ? decimals : 0;
    var unit = Math.pow(10, d);
    var q = Math.round(Math.max(0, seconds) * unit);
    var whole = Math.floor(q / unit), frac = q - whole * unit;
    var pad = function (n, w) { var t = String(n); while (t.length < w) t = '0' + t; return t; };
    var h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
    var text = pad(m, 2) + ':' + pad(s, 2) + (d ? '.' + pad(frac, d) : '');
    return h > 0 ? h + ':' + text : text;
}

/**
 * The ruler for a seekbar. Pure.
 *
 * @param {number} totalFrames
 * @param {number} fps         playback FPS; no ruler without a positive, finite one
 * @param {number} widthPx     the bar's width
 * @param {{charPx?: number}} [opts]  width of one label character (monospace)
 * @returns {{step: number, minorStep: number,
 *            majors: Array<{frac: number, seconds: number, label: string|null, align: 'start'|'center'}>,
 *            minors: number[]}}
 *   `step`/`minorStep` are 0 when there is nothing to draw — including when
 *   no label after "00:00" fits. `frac` is 0..1 along the bar. A major's
 *   `label` is null when, centred, it would hang off the right end (the tick
 *   is still drawn); the label at 0 is left-aligned to the bar's start.
 */
export function seekbarTimeTicks(totalFrames, fps, widthPx, opts) {
    var none = { step: 0, minorStep: 0, majors: [], minors: [] };
    if (!(totalFrames > 1) || !(typeof fps === 'number' && isFinite(fps) && fps > 0) || !(widthPx > 0)) return none;
    var charPx = opts && opts.charPx > 0 ? opts.charPx : DEFAULT_CHAR_PX;
    var lastFrame = totalFrames - 1;
    var endSec = lastFrame / fps;           // the time at the bar's right end
    var pxPerSec = widthPx / endSec;
    var frameSec = 1 / fps;
    var EPS = 1e-9;

    var count = function (step) { return Math.floor(endSec / step + EPS); };   // ticks after 0
    var labelPx = function (step) { return formatTickLabel(count(step) * step, stepDecimals(step)).length * charPx; };

    var step = 0;
    for (var i = 0; i < TICK_STEPS.length; i++) {
        var s = TICK_STEPS[i];
        if (s < frameSec - EPS) continue;
        var need = Math.max(MIN_LABEL_SPACING_PX, LABEL_SPACING_WIDTHS * labelPx(s));
        if (s * pxPerSec >= need) { step = s; break; }
    }
    if (!step) return none;   // even a day per label would crowd them

    var minorStep = 0;
    for (var j = 0; j < TICK_STEPS.length; j++) {
        var m = TICK_STEPS[j];
        if (m >= step) break;
        if (m < frameSec - EPS) continue;
        var ratio = step / m;
        if (Math.abs(ratio - Math.round(ratio)) > 1e-6 || Math.round(ratio) > MAX_MINOR_PER_MAJOR) continue;
        if (m * pxPerSec >= MIN_MINOR_SPACING_PX) { minorStep = m; break; }
    }

    var dec = stepDecimals(step);
    var majors = [];
    for (var k = 0, n = count(step); k <= n; k++) {
        var sec = k * step;
        var frac = Math.min(1, sec / endSec);
        var label = formatTickLabel(sec, dec);
        var half = label.length * charPx / 2;
        var align = k === 0 ? 'start' : 'center';
        if (align === 'center' && frac * widthPx + half > widthPx) label = null;
        majors.push({ frac: frac, seconds: sec, label: label, align: align });
    }
    // A scale is read off two labels; "00:00" alone (a bar too narrow for a
    // second one) is only noise.
    if (!majors.some(function (m, k) { return k > 0 && m.label; })) return none;

    var minors = [];
    if (minorStep) {
        var per = Math.round(step / minorStep);
        for (var q = 1, nq = Math.floor(endSec / minorStep + EPS); q <= nq; q++) {
            if (q % per) minors.push(Math.min(1, q * minorStep / endSec));
        }
    }
    return { step: step, minorStep: minorStep, majors: majors, minors: minors };
}

// ---------------------------------------------------------------------------
// DOM half
// ---------------------------------------------------------------------------

var _layer = null;          // #seekbarRuler
var _getTotal = null, _getFps = null;
var _width = 0;             // the layer's width, from the ResizeObserver
var _charPx = 0;            // measured once (0 = not yet)
var _shownTotal = NaN, _shownFps = NaN, _shownWidth = NaN;
var _html = null;           // what is in the layer, so an unchanged ruler writes nothing

/**
 * Attach to the ruler layer (`#seekbarRuler`, inside `#seekbar`).
 * @param {HTMLElement} layerEl
 * @param {{getTotalFrames: () => number, getFps: () => number}} opts
 */
export function installSeekbarTicks(layerEl, opts) {
    _layer = layerEl || null;
    _getTotal = opts.getTotalFrames;
    _getFps = opts.getFps;
    if (!_layer) return;
    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(function (entries) {
            var w = entries[entries.length - 1].contentRect.width;
            if (w !== _width) { _width = w; render(); }
        }).observe(_layer);
    } else {
        _width = _layer.getBoundingClientRect().width;
    }
    render();
}

/**
 * Re-read the frame count and FPS. The per-frame path calls this: it is two
 * comparisons and a return unless one of them changed.
 */
export function refreshSeekbarTicks() {
    if (!_layer) return;
    if (_getTotal() === _shownTotal && _getFps() === _shownFps && _width === _shownWidth) return;
    render();
}

/** One label character's width in the label font, measured once it can be. */
function charPx() {
    if (_charPx > 0) return _charPx;
    var probe = document.createElement('span');
    probe.className = 'seekbar-tick-label';
    probe.style.visibility = 'hidden';
    probe.textContent = '0000000000';
    _layer.appendChild(probe);
    var w = probe.getBoundingClientRect().width / 10;
    _layer.removeChild(probe);
    if (w > 0) _charPx = w;
    return w > 0 ? w : DEFAULT_CHAR_PX;
}

function render() {
    if (!_layer) return;
    _shownTotal = _getTotal();
    _shownFps = _getFps();
    _shownWidth = _width;
    var html = '';
    if (_width > 0) {
        var t = seekbarTimeTicks(_shownTotal, _shownFps, _width, { charPx: charPx() });
        var pct = function (f) { return (100 * f).toFixed(4) + '%'; };
        for (var i = 0; i < t.minors.length; i++) {
            html += '<div class="seekbar-tick" style="left:' + pct(t.minors[i]) + '"></div>';
        }
        for (var j = 0; j < t.majors.length; j++) {
            var m = t.majors[j];
            html += '<div class="seekbar-tick is-major" style="left:' + pct(m.frac) + '"></div>';
            if (m.label) {
                html += '<span class="seekbar-tick-label' + (m.align === 'start' ? ' is-start' : '') +
                    '" style="left:' + pct(m.frac) + '">' + m.label + '</span>';
            }
        }
    }
    if (html !== _html) { _html = html; _layer.innerHTML = html; }
}
