/**
 * ui/lazy-select.js — a `<select>` that builds its full option list only when
 * the user reaches for it.
 *
 * The info panel's per-instance Track dropdowns are rebuilt on every frame
 * update (`updateFrameInfo`, ~10 Hz during playback), one per instance row.
 * Built eagerly, each held an `<option>` for EVERY session track: on an
 * un-tracked prediction project with 863 tracks and ~40 rows (8 cameras x 5
 * animals) that is ~35,000 options per update, and the rebuild plus its
 * style/layout took ~200 ms — so it ran on EVERY frame (the 10 Hz throttle
 * re-arms as soon as an update outlasts it) and capped playback at ~5 fps
 * (`tests/e2e/_bench-playback.mjs`).
 *
 * A closed `<select>` only ever shows its selected option. So this builds that
 * one, between the fixed head ("(none)" / "—") and tail ("(+) New …") options,
 * and fills in the rest the first time the select is pressed or focused.
 * `mousedown` and `focus` both fire BEFORE the browser opens the list or acts
 * on a key, so the user always picks from the complete list, in the order an
 * eager build would have used. Per update the cost is three options per row,
 * whatever the track count.
 *
 * The selected value and its label are exactly what the eager build showed,
 * including a value that names no entry (nothing selected, as before). The one
 * visible difference is the CLOSED width: a select sizes to its widest option,
 * which is now the widest of three rather than of every track. Filling locks
 * that width first, so the select does not grow under the pointer as it opens.
 *
 * Script that sets `.value` to an entry that was never filled selects nothing,
 * as it would on any select lacking that option — dispatch `focus` (or
 * `mousedown`) first, as the browser does for a user.
 *
 * A LEAF module — it imports nothing, so the browser suite can test it without
 * loading the app.
 */

function makeOption(value, label) {
    const opt = document.createElement('option');
    opt.value = String(value);
    opt.textContent = label;
    return opt;
}

/**
 * Build a lazily-filled `<select>`.
 *
 * @param {Object} opts
 * @param {[string|number, string]} opts.head - first option, e.g. `['-1', '(none)']`.
 * @param {[string|number, string]} opts.tail - last option, e.g. `['__new__', '(+) New Track']`.
 * @param {string|number} opts.value - the selected value.
 * @param {string} [opts.label] - the label of the entry whose value is
 *     `opts.value`, or `undefined` when no entry has that value. Ignored when
 *     `value` is the head's or the tail's.
 * @param {function(): Array<[string|number, string]>} opts.entries - every
 *     entry between head and tail, in display order. Called once, on the first
 *     press or focus.
 * @param {string} [opts.cssText] - inline style for the select.
 * @returns {HTMLSelectElement}
 */
export function buildLazySelect(opts) {
    const sel = document.createElement('select');
    if (opts.cssText) sel.style.cssText = opts.cssText;
    const head = makeOption(opts.head[0], opts.head[1]);
    const tail = makeOption(opts.tail[0], opts.tail[1]);
    const value = String(opts.value);
    sel.appendChild(head);
    if (value !== head.value && value !== tail.value && opts.label !== undefined) {
        sel.appendChild(makeOption(value, opts.label));
    }
    sel.appendChild(tail);
    sel.value = value;

    function fill() {
        sel.removeEventListener('mousedown', fill);
        sel.removeEventListener('focus', fill);
        if (sel.offsetWidth > 0) sel.style.width = sel.offsetWidth + 'px';
        const keep = sel.selectedIndex >= 0 ? sel.value : null;
        while (sel.options.length > 2) sel.remove(1);
        const frag = document.createDocumentFragment();
        const list = opts.entries();
        for (let i = 0; i < list.length; i++) frag.appendChild(makeOption(list[i][0], list[i][1]));
        sel.insertBefore(frag, tail);
        if (keep == null) sel.selectedIndex = -1;
        else sel.value = keep;
    }
    sel.addEventListener('mousedown', fill);
    sel.addEventListener('focus', fill);
    return sel;
}
