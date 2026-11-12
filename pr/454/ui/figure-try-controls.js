// ui/figure-try-controls.js — the controls shared by the Settings figures
// (`ui/triangulation-methods-figure.js`, `ui/smoothing-windows-figure.js`).
//
// A figure's demo must not look like, or act as, an input: someone playing with
// a slider forgets it is one, moves on, and clicks Apply. So:
//
//   * `tryStrip` / `tryControl`: a dashed strip saying it changes the sketch
//     only, holding sliders with a text box beside each. They only redraw.
//   * `settingRow`: an outlined row saying what the setting is, with the only
//     buttons that change it (Use, Turn off), and Reset sketch. A change is
//     marked "not saved until you click Apply" until it is.
//
// Colours come from the theme variables in `styles.css` (`.fig-try`, `.fig-setting`).
//
// Depends on: nothing.

/** The dashed strip around a figure's demo controls. */
export function tryStrip(controlsHtml) {
    return '<div class="fig-try">'
        + '<div class="fig-try-title">Try it: this changes the sketch only, not your settings</div>'
        + '<div class="fig-try-row">' + controlsHtml + '</div></div>';
}

/**
 * A slider with a text box. `o`: `name` (the label), `aria` (what it sets),
 * `min`, `max`, `step` (the text box's range), `sliderMin`, `sliderMax`, `sliderStep`
 * (the slider's, a typed value past them leaves it at its end), `unit`, `extra` (HTML
 * after the unit). A slider whose positions are not the values themselves also gives
 * `toSlider(value)`, `fromSlider(position)`, and optionally `ticks` ([[position,
 * label], …], under the track) and `zone` ({ from, to, label }, positions, a band
 * behind the track).
 */
export function tryControl(key, o) {
    var sMin = o.sliderMin != null ? o.sliderMin : o.min, sMax = o.sliderMax != null ? o.sliderMax : o.max;
    function at(pos) { return ((pos - sMin) / (sMax - sMin)).toFixed(4); }
    var input = '<input type="range" min="' + sMin + '" max="' + sMax + '" step="' + (o.sliderStep || o.step)
        + '" aria-label="' + o.aria + ' to try (slider)">';
    if (o.ticks || o.zone) {
        input = '<span class="fig-slider">'
            + (o.zone ? '<span class="fig-zone" style="--a:' + at(o.zone.from) + ';--b:' + at(o.zone.to) + '"></span>'
                + '<span class="fig-zone-label" style="--a:' + at((o.zone.from + o.zone.to) / 2) + '">' + o.zone.label + '</span>' : '')
            + input
            + (o.ticks || []).map(function (t) {
                return '<span class="fig-tick" style="--a:' + at(t[0]) + '">' + t[1] + '</span>';
            }).join('')
            + '</span>';
    }
    return '<div class="fig-ctl" data-try="' + key + '"><span class="fig-ctl-name">' + o.name + '</span>' + input
        + '<input type="number" class="fig-num" min="' + o.min + '" max="' + o.max + '" step="' + o.step + '" aria-label="' + o.aria + ' to try">'
        + '<span class="fig-ctl-unit">' + (o.unit || '') + '</span>' + (o.extra || '') + '</div>';
}

/**
 * Wire a `tryControl`. `onValue(v)` gets each value in range as it is dragged or
 * typed. A half-typed or out-of-range entry is ignored, and leaving the box shows
 * the current value again.
 * @returns {{set: function(number, number=): void}} `set(value, sliderValue)`
 *   shows a value (the slider at `sliderValue` if given); it leaves the text box
 *   alone while it has focus, so typing is never rewritten under the caret.
 */
export function wireTryControl(root, key, o, onValue) {
    var el = root.querySelector('[data-try="' + key + '"]');
    var range = el.querySelector('input[type="range"]'), num = el.querySelector('input[type="number"]');
    var last = null;
    range.addEventListener('input', function () { onValue(o.fromSlider ? o.fromSlider(+range.value) : +range.value); });
    num.addEventListener('input', function () {
        var v = parseFloat(num.value);
        if (isFinite(v) && v >= o.min && v <= o.max) onValue(v);
    });
    num.addEventListener('blur', function () { if (last != null) num.value = String(last); });
    return {
        set: function (value, sliderValue) {
            last = value;
            range.value = String(sliderValue != null ? sliderValue : o.toSlider ? o.toSlider(value) : value);
            if (o.toSlider) range.setAttribute('aria-valuetext', value > 0 ? value + ' ' + (o.unit || '') : 'off');
            if (document.activeElement !== num) num.value = String(value);
        },
    };
}

/** The row saying what the setting is, with the buttons that change it. */
export function settingRow(key) {
    return '<div class="fig-setting" data-setting="' + key + '">'
        + '<span class="fig-setting-now"></span>'
        + '<span class="fig-unsaved">not saved until you click Apply</span>'
        + '<span class="fig-actions">'
        + '<button type="button" class="fig-btn fig-use"></button>'
        + '<button type="button" class="fig-btn fig-off">Turn off</button>'
        + '<button type="button" class="fig-btn fig-reset">Reset sketch</button>'
        + '</span></div>';
}

/**
 * Wire a `settingRow`: `on.use`, `on.off`, `on.reset` are its buttons.
 * @returns {function({label: string, now: string, unsaved: boolean, use: ?string, off: boolean, reset: boolean}): void}
 *   Shows the setting: `label` ("Your setting"), `now` (its value), `use` (the Use
 *   button's text, null when the sketch already shows the setting). A button with
 *   nothing to do stays in place, hidden, so the row keeps its layout.
 */
export function wireSettingRow(root, key, on) {
    var el = root.querySelector('[data-setting="' + key + '"]');
    var use = el.querySelector('.fig-use'), off = el.querySelector('.fig-off'), reset = el.querySelector('.fig-reset');
    use.addEventListener('click', on.use);
    off.addEventListener('click', on.off);
    reset.addEventListener('click', on.reset);
    function avail(btn, yes) { btn.classList.toggle('is-unavailable', !yes); btn.disabled = !yes; }
    return function (s) {
        var now = el.querySelector('.fig-setting-now');
        now.textContent = s.label + ': ';
        var strong = document.createElement('strong');
        strong.textContent = s.now;
        now.appendChild(strong);
        el.querySelector('.fig-unsaved').classList.toggle('is-unavailable', !s.unsaved);
        use.textContent = s.use || 'Use';
        avail(use, !!s.use);
        avail(off, s.off);
        avail(reset, s.reset);
    };
}
