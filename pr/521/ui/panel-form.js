/**
 * ui/panel-form.js — the small form toolkit of the sleap-app-style rail panels: sleap-app's
 * `Section` (a fold with a chevron), labels with an ⓘ, and check / number / select rows that
 * re-read their value on every panel refresh.
 *
 * Same markup and classes as the Inference panel's own helpers (`ui/inference-panel.js`), so the
 * panels look alike; the Training panel uses this module (the Inference panel keeps its own copy
 * for now). A form is created per panel with its `isBusy` (disables every control while a run is
 * going) and `refresh`.
 */
import { setInfoTip } from './info-tip.js?v=d8c111d6b6c2';
import { railIconSvg } from './panel-rail-icons.js?v=d8c111d6b6c2';

const INFO_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/>' +
    '<path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';

export function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

export function icon(name, cls) {
    const s = el('span', 'inf-icon' + (cls ? ' ' + cls : ''));
    s.innerHTML = railIconSvg(name);
    return s;
}

/** A button with an optional leading icon. */
export function button(text, cls, iconName) {
    const b = el('button', cls || 'btn btn-sm');
    b.type = 'button';
    if (iconName) b.appendChild(icon(iconName));
    if (text) b.appendChild(document.createTextNode((iconName ? ' ' : '') + text));
    return b;
}

/**
 * @param {{isBusy: () => boolean, refresh: () => void}} o
 */
export function createPanelForm(o) {
    const refreshers = [];
    function onRefresh(f) { refreshers.push(f); }
    function runRefreshers() { refreshers.forEach(function (f) { f(); }); }
    /** Forget every refresher (a view that rebuilds its rows, e.g. a dialog switching tabs). */
    function clear() { refreshers.length = 0; }

    function hintBtn(text) {
        const b = el('button', 'plane-section-info inf-hint');
        b.type = 'button';
        b.innerHTML = INFO_SVG;
        setInfoTip(b, text);
        return b;
    }

    function fieldLabel(label, hint) {
        const s = el('span', 'inf-label', label);
        if (hint) s.appendChild(hintBtn(hint));
        return s;
    }

    /** sleap-app `Section`: a <details> fold with a chevron (keyboard-native). */
    function section(parent, title, defaultOpen) {
        const d = el('details', 'inf-section');
        d.open = !!defaultOpen;
        const s = el('summary', 'inf-section-title');
        s.appendChild(el('span', 'inf-chevron'));
        s.appendChild(el('span', null, title));
        d.appendChild(s);
        const body = el('div', 'inf-section-body');
        d.appendChild(body);
        parent.appendChild(d);
        return body;
    }

    function sep(parent) { parent.appendChild(el('div', 'inf-sep')); }

    function check(parent, label, hint, get, set, disabledIf) {
        const l = el('label', 'inf-check');
        const box = el('input');
        box.type = 'checkbox';
        box.addEventListener('change', function () { set(box.checked); o.refresh(); });
        l.appendChild(box);
        l.appendChild(document.createTextNode(label));
        if (hint) l.appendChild(hintBtn(hint));
        parent.appendChild(l);
        onRefresh(function () {
            box.checked = !!get();
            box.disabled = o.isBusy() || !!(disabledIf && disabledIf());
        });
        return l;
    }

    function numField(parent, label, hint, get, set, opts) {
        const oo = opts || {};
        const row = el('div', 'inf-row');
        row.appendChild(fieldLabel(label, hint));
        const input = el('input', 'inf-num');
        input.type = 'number';
        if (oo.min != null) input.min = oo.min;
        if (oo.max != null) input.max = oo.max;
        input.step = oo.step != null ? oo.step : (oo.integer ? 1 : 'any');
        if (oo.id) input.id = oo.id;
        if (oo.placeholder) input.placeholder = oo.placeholder;
        input.addEventListener('change', function () {
            let n = Number(input.value.trim());
            // `nullable`: an empty box means "none" (e.g. Auto), not "keep the old value".
            if (input.value.trim() === '' && oo.nullable) { set(null); o.refresh(); return; }
            if (input.value.trim() === '' || !Number.isFinite(n)) { o.refresh(); return; }
            if (oo.integer) n = Math.round(n);
            if (oo.min != null) n = Math.max(oo.min, n);
            if (oo.max != null) n = Math.min(oo.max, n);
            set(n);
            o.refresh();
        });
        row.appendChild(input);
        parent.appendChild(row);
        onRefresh(function () {
            const v = get();
            if (document.activeElement !== input) input.value = v == null ? '' : String(v);
            input.disabled = o.isBusy() || !!(oo.disabledIf && oo.disabledIf());
        });
        return row;
    }

    /** A select; `options` is `[value, label, disabled?][]` or a function returning it. */
    function selectField(parent, label, hint, options, get, set, opts) {
        const oo = opts || {};
        const row = el('div', label ? 'inf-row' : 'inf-block');
        if (label) row.appendChild(fieldLabel(label, hint));
        const sel = el('select', 'inf-select' + (label && !oo.wide ? ' inf-select-sm' : ''));
        if (oo.id) sel.id = oo.id;
        sel.addEventListener('change', function () { set(sel.value); o.refresh(); });
        row.appendChild(sel);
        parent.appendChild(row);
        let lastKey = '';
        onRefresh(function () {
            const list = (typeof options === 'function' ? options() : options);
            const key = list.map(function (x) { return x[0] + '\u0000' + x[1] + '\u0000' + (x[2] ? 1 : 0); }).join('\u0001');
            if (key !== lastKey) {
                sel.textContent = '';
                list.forEach(function (x) {
                    const op = el('option', null, x[1]);
                    op.value = x[0];
                    if (x[2]) op.disabled = true;
                    sel.appendChild(op);
                });
                lastKey = key;
            }
            sel.value = get();
            sel.disabled = o.isBusy() || !!(oo.disabledIf && oo.disabledIf());
        });
        return row;
    }

    function shownIf(node, pred) {
        onRefresh(function () { node.hidden = !pred(); });
        return node;
    }

    return {
        onRefresh: onRefresh, runRefreshers: runRefreshers, clear: clear, hintBtn: hintBtn, fieldLabel: fieldLabel,
        section: section, sep: sep, check: check, numField: numField, selectField: selectField, shownIf: shownIf,
    };
}
