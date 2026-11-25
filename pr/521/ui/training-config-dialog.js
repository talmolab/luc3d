/**
 * ui/training-config-dialog.js — the Training panel's Full Configuration dialog, a replica of sleap-app's
 * `src/components/dialogs/TrainingConfigDialog.tsx` (@ c97c6a5): "Training Configuration" with a Pipeline
 * tab and one tab per model, "Search parameters...", a left nav of the tab's sections, every field with its
 * hint, edits saved as you type ("All changes saved"), and the footer's Reset to profile defaults… / Copy to
 * clipboard / Save configuration files… / Done. A model tab starts with its training mode (Train from scratch /
 * Fine-tune / Resume training) and checkpoint; Fine-tune locks the Model section, Resume every section of the
 * tab (sleap-app: the run continues with its own settings).
 *
 * The fields are `ui/training-config-fields.js` (each one sleap-nn config path). The dialog edits the
 * panel's configs IN PLACE through `host`: Pipeline fields go to every model's config, a model tab's to
 * that model's; after each edit `host.changed(slot)` lets the panel re-read its own fields from the config.
 *
 * LUCID changes: no W&B (forced off), no Number of Devices / Multi-GPU strategy (one device, forced by
 * Rust), no Export Training Job Package and no run scripts in Save (one YAML per model); the backbone is
 * shown, only UNet's settings edited. Read-only while a run goes (sleap-app: the same).
 *
 * Vanilla DOM card: Esc / Done / scrim close, Tab trapped, `data-shortcut-modal`. One scroller (the
 * content column).
 */
import { CONFIG_FIELDS, SECTIONS, searchFields, coerce } from './training-config-fields.js?v=8802bcaa2489';
import { trapModal } from './connect/layers.js?v=8802bcaa2489';
import { el, button, createPanelForm } from './panel-form.js?v=8802bcaa2489';
import { askConfirm } from './ask.js?v=8802bcaa2489';
import { TRAINING_MODES } from './training-args.js?v=8802bcaa2489';

let open = null;

/** The open dialog, or null. */
export function trainingConfigDialog() { return open; }

/**
 * @param {{
 *   slots: () => {slot: string, label: string}[],
 *   doc: (slot: string) => object,          the live config the dialog edits
 *   changed: (slot: string) => void,        after each edit
 *   reset: (slots: string[]) => void,       Reset to profile defaults (after the confirm): the tab's configs
 *   yamlOf: (slot: string) => string,       the config as it would be sent (Copy / Save)
 *   fileNameOf: (slot: string) => string,
 *   isBusy: () => boolean,
 *   initialTab?: string,
 *   mode?: (slot: string) => {mode, checkpoint, note, problem, local} | null,   a model's training mode
 *   setMode?: (slot: string, mode: string) => void,
 *   setCheckpoint?: (slot: string, path: string) => void,   a worker path (remote)
 *   chooseCheckpoint?: (slot: string) => Promise<void>,     a trained model folder (local)
 * }} host
 */
export function openTrainingConfigDialog(host) {
    if (open) { open.focus(); return open; }
    const slots = host.slots();
    let tab = host.initialTab && slots.some(function (s) { return s.slot === host.initialTab; }) ? host.initialTab : 'pipeline';

    const scrim = el('div', 'tcd-scrim');
    scrim.id = 'trnConfigDialog';
    scrim.setAttribute('data-shortcut-modal', '1');
    const card = el('div', 'tcd-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'tcdTitle');
    scrim.appendChild(card);

    // Header: title · tabs · saved
    const head = el('div', 'tcd-head');
    const title = el('h2', 'tcd-title', 'Training Configuration');
    title.id = 'tcdTitle';
    head.appendChild(title);
    const tabs = el('div', 'trn-seg tcd-tabs');
    const tabBtns = [['pipeline', 'Pipeline']].concat(slots.map(function (s) { return [s.slot, s.label]; })).map(function (t) {
        const b = el('button', 'trn-seg-btn', t[1]);
        b.type = 'button';
        b.dataset.tab = t[0];
        b.addEventListener('click', function () { setTab(t[0]); });
        tabs.appendChild(b);
        return b;
    });
    head.appendChild(tabs);
    const saved = el('span', 'tcd-saved', '✓ All changes saved');
    saved.title = 'Edits are saved automatically as you type';
    head.appendChild(saved);
    card.appendChild(head);

    // Search
    const searchRow = el('div', 'tcd-search');
    const search = el('input', 'inf-text tcd-search-input');
    search.type = 'search';
    search.placeholder = 'Search parameters...';
    search.id = 'tcdSearch';
    searchRow.appendChild(search);
    const results = el('div', 'tcd-results');
    results.hidden = true;
    searchRow.appendChild(results);
    card.appendChild(searchRow);

    // Body: nav · content
    const body = el('div', 'tcd-body');
    const nav = el('nav', 'tcd-nav');
    const content = el('div', 'tcd-content');
    body.appendChild(nav); body.appendChild(content);
    card.appendChild(body);

    // Footer
    const foot = el('div', 'tcd-foot');
    const resetBtn = button('Reset to profile defaults…', 'btn btn-sm inf-btn-ghost');
    resetBtn.id = 'tcdReset';
    const copyBtn = button('Copy to clipboard', 'btn btn-sm inf-btn-outline', 'copy');
    copyBtn.id = 'tcdCopy';
    const saveBtn = button('Save configuration files…', 'btn btn-sm inf-btn-outline');
    saveBtn.id = 'tcdSave';
    saveBtn.title = 'Save one training_config YAML per model, as it would be sent';
    const doneBtn = button('Done', 'btn btn-sm btn-primary');
    doneBtn.id = 'tcdDone';
    const left = el('div', 'tcd-foot-left'); left.appendChild(resetBtn);
    const right = el('div', 'tcd-foot-right');
    right.appendChild(copyBtn); right.appendChild(saveBtn); right.appendChild(doneBtn);
    foot.appendChild(left); foot.appendChild(right);
    card.appendChild(foot);

    const form = createPanelForm({ isBusy: host.isBusy, refresh: function () { form.runRefreshers(); } });
    const rowsById = new Map();

    /** The configs a field writes: every model's (Pipeline) or the shown model's. */
    function targets(field) {
        return field.tab === 'pipeline' ? slots.map(function (s) { return s.slot; }) : [tab];
    }
    function readDoc(field) { return host.doc(targets(field)[0]); }
    function write(field, raw) {
        const v = coerce(field, raw);
        if (v === undefined) return;
        targets(field).forEach(function (slot) {
            const d = host.doc(slot);
            if (d) { field.set(d, v); host.changed(slot); }
        });
    }

    /** sleap-app `modelLocked` / `allLocked`: Fine-tune keeps the architecture, Resume everything. */
    function locked(f) {
        if (f.tab === 'pipeline' || !host.mode) return false;
        const m = host.mode(tab);
        return !!m && (m.mode === 'resume' || (m.mode === 'finetune' && f.section === 'Model'));
    }

    function fieldRow(parent, f) {
        const get = function () { const d = readDoc(f); const v = d ? f.get(d) : undefined; return v; };
        const off = function () { return locked(f); };
        let row;
        if (f.readOnly) {
            row = el('div', 'inf-row');
            row.appendChild(form.fieldLabel(f.label, f.hint));
            const val = el('span', 'tcd-ro');
            row.appendChild(val);
            parent.appendChild(row);
            form.onRefresh(function () { const v = get(); val.textContent = v == null || v === '' ? '—' : String(v); });
        } else if (f.kind === 'bool') {
            row = form.check(parent, f.label, f.hint, function () { return !!get(); }, function (v) { write(f, v); }, off);
        } else if (f.kind === 'select') {
            row = form.selectField(parent, f.label, f.hint, f.options, function () { const v = get(); return v == null ? '' : String(v); },
                function (v) { write(f, v); }, { wide: true, disabledIf: off });
        } else {
            row = form.numField(parent, f.label, f.hint, function () { return get(); }, function (v) { write(f, v); },
                { min: f.min, max: f.max, step: f.step, integer: f.kind === 'int', nullable: !!f.nullable, placeholder: f.nullable ? 'Auto' : null, disabledIf: off });
        }
        row.classList.add('tcd-field');
        row.dataset.field = f.id;
        if (f.note) row.appendChild(el('span', 'tcd-note', f.note));
        if (f.id === 'cropSize' && host.cropInfo) cropNote(row);
        rowsById.set(f.id, row);
        if (f.when) form.onRefresh(function () { const d = readDoc(f); row.hidden = !d || !f.when(d); });
    }

    /**
     * Under Crop Size: the size Auto comes to (sleap-app's "Auto: N px" in its model diagram) and sleap-app's
     * crop warnings (`cropWarnings.ts`), from the panel's `host.cropInfo(slot)`.
     */
    function cropNote(row) {
        const note = el('div', 'tcd-crop');
        note.id = 'tcdCropNote';
        row.after(note);
        let key = null;
        form.onRefresh(function () {
            const info = host.cropInfo(tab);
            note.hidden = row.hidden || !info;
            const lines = !info ? [] : (info.auto ? [['tcd-note', 'Auto: ' + (info.low !== info.cropSize
                ? info.low.toLocaleString('en-US') + '–' : '') + info.cropSize.toLocaleString('en-US') + ' px from your labels.']] : [])
                .concat(info ? info.warnings.map(function (w) { return ['trn-warnline', w]; }) : []);
            const k = JSON.stringify(lines);
            if (k === key) return;
            key = k;
            note.textContent = '';
            lines.forEach(function (l) { note.appendChild(el('p', l[0], l[1])); });
        });
    }

    /** sleap-app's training mode block at the top of a model tab. */
    function modeBlock() {
        const slot = tab;
        const box = el('section', 'tcd-section tcd-mode');
        box.id = 'tcdMode';
        box.appendChild(el('h3', 'tcd-section-title', 'Training mode'));
        const radios = el('div', 'tcd-mode-radios');
        const inputs = TRAINING_MODES.map(function (o) {
            const l = el('label', 'inf-check');
            const r = el('input');
            r.type = 'radio';
            r.name = 'tcd-mode-' + slot;
            r.value = o[0];
            r.addEventListener('change', function () { if (r.checked) { host.setMode(slot, o[0]); form.runRefreshers(); } });
            l.appendChild(r);
            l.appendChild(document.createTextNode(o[1]));
            radios.appendChild(l);
            return r;
        });
        box.appendChild(radios);
        const ck = el('div', 'tcd-ckpt');
        const path = el('span', 'tcd-ckpt-path');
        const text = el('input', 'inf-text tcd-ckpt-input');
        text.type = 'text';
        text.id = 'tcdCheckpoint';
        text.addEventListener('change', function () { host.setCheckpoint(slot, text.value.trim()); form.runRefreshers(); });
        const choose = button('Choose\u2026', 'btn btn-sm inf-btn-outline');
        choose.id = 'tcdChooseCheckpoint';
        choose.title = 'Pick the trained model\u2019s folder (read-only to the app); its checkpoint is used';
        choose.addEventListener('click', function () { Promise.resolve(host.chooseCheckpoint(slot)).then(function () { form.runRefreshers(); }); });
        ck.appendChild(path); ck.appendChild(text); ck.appendChild(choose);
        box.appendChild(ck);
        const msg = el('p', 'tcd-ckpt-msg');
        box.appendChild(msg);
        const lockNote = el('p', 'tcd-note');
        box.appendChild(lockNote);
        form.onRefresh(function () {
            const m = host.mode(slot);
            if (!m) return;
            inputs.forEach(function (r) { r.checked = r.value === m.mode; r.disabled = host.isBusy(); });
            ck.hidden = m.mode === 'scratch';
            path.hidden = !m.local; choose.hidden = !m.local; text.hidden = m.local;
            path.textContent = m.checkpoint || 'none chosen';
            text.placeholder = m.mode === 'finetune' ? 'Path to .ckpt or .h5 file on the worker' : 'Path to .ckpt file on the worker';
            if (document.activeElement !== text) text.value = m.checkpoint || '';
            choose.disabled = text.disabled = host.isBusy();
            const problem = m.mode !== 'scratch' && m.checkpoint ? m.problem : null;
            msg.textContent = problem || m.note || '';
            msg.className = 'tcd-ckpt-msg' + (problem ? ' tcd-ckpt-bad' : m.note ? ' tcd-ckpt-warn' : '');
            msg.hidden = !msg.textContent || m.mode === 'scratch';
            lockNote.textContent = m.mode === 'resume' ? 'Resume continues the run with its own settings, so they can\u2019t change here.'
                : m.mode === 'finetune' ? 'Fine-tune starts from the model\u2019s weights, so its architecture (Model) stays.' : '';
            lockNote.hidden = !lockNote.textContent;
        });
        return box;
    }

    function render() {
        content.textContent = '';
        nav.textContent = '';
        rowsById.clear();
        form.clear();
        const kind = tab === 'pipeline' ? 'pipeline' : 'head';
        if (kind === 'head' && host.mode && host.mode(tab)) content.appendChild(modeBlock());
        for (const name of SECTIONS[kind]) {
            const fields = CONFIG_FIELDS.filter(function (f) { return f.tab === kind && f.section === name; });
            if (!fields.length) continue;
            const sec = el('section', 'tcd-section');
            const sid = 'tcd-sec-' + name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
            sec.id = sid;
            sec.appendChild(el('h3', 'tcd-section-title', name));
            fields.forEach(function (f) { fieldRow(sec, f); });
            content.appendChild(sec);
            const nb = el('button', 'tcd-nav-btn', name);
            nb.type = 'button';
            nb.addEventListener('click', function () { sec.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
            nav.appendChild(nb);
        }
        tabBtns.forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.tab === tab ? 'true' : 'false'); });
        form.runRefreshers();
    }

    function setTab(t) {
        if (t === tab) return;
        tab = t;
        render();
        content.scrollTop = 0;
    }

    function showResults() {
        // The best 8 (no scrolling list inside the dialog: one scroller per modal).
        const hits = searchFields(search.value).slice(0, 8);
        results.textContent = '';
        results.hidden = !hits.length;
        hits.forEach(function (f) {
            const r = el('button', 'tcd-result');
            r.type = 'button';
            r.appendChild(el('span', null, f.label));
            r.appendChild(el('span', 'tcd-result-tab', f.tab === 'pipeline' ? 'Training Pipeline' : 'Per-Head'));
            r.addEventListener('click', function () { goTo(f); });
            results.appendChild(r);
        });
    }
    function goTo(f) {
        search.value = '';
        results.hidden = true;
        if (f.tab === 'pipeline') setTab('pipeline');
        else if (tab === 'pipeline') setTab(slots[0].slot);
        let row = rowsById.get(f.id);
        if (!row) return;
        // A field shown only with another one on (e.g. Step Size with the Step scheduler): point at the
        // nearest shown field above it, which is the one that shows it.
        while (row && row.hidden) row = row.previousElementSibling;
        if (!row || !row.classList.contains('tcd-field')) return;
        row.scrollIntoView({ block: 'center' });
        row.classList.add('tcd-flash');
        setTimeout(function () { row.classList.remove('tcd-flash'); }, 1500);
    }
    search.addEventListener('input', showResults);
    search.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !results.hidden && results.firstChild) results.firstChild.click();
    });

    function allYaml() {
        return slots.map(function (s) { return '# ' + host.fileNameOf(s.slot) + '\n' + host.yamlOf(s.slot); }).join('\n');
    }
    copyBtn.addEventListener('click', function () {
        const text = allYaml();
        const done = function () { copyBtn.lastChild.textContent = ' Copied'; setTimeout(function () { copyBtn.lastChild.textContent = ' Copy to clipboard'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    });
    saveBtn.addEventListener('click', function () {
        slots.forEach(function (s) {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([host.yamlOf(s.slot)], { type: 'text/yaml' }));
            a.download = host.fileNameOf(s.slot);
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
        });
    });
    resetBtn.addEventListener('click', async function () {
        const one = tab !== 'pipeline' ? slots.find(function (s) { return s.slot === tab; }) : null;
        const scope = one ? 'the ' + one.label + ' config' : 'all model configs';
        const ok = await askConfirm('Reset to profile defaults? This restores ' + scope +
            ' to the values loaded from the baseline profile, discarding your edits.', { okLabel: 'Reset' });
        if (!ok) return;
        host.reset(one ? [one.slot] : slots.map(function (s) { return s.slot; }));
        form.runRefreshers();
    });
    doneBtn.addEventListener('click', close);
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });

    document.body.appendChild(scrim);
    // Esc clears a search first, then closes (trapModal sees Esc before the search box does).
    const trap = trapModal(scrim, card, {
        onEscape: function () {
            if (search.value) { search.value = ''; results.hidden = true; return; }
            close();
        },
    });
    render();
    search.focus();

    function close() {
        if (!open) return;
        trap.release();
        trap.restoreFocus();
        scrim.remove();
        open = null;
    }
    function update() {
        form.runRefreshers();
        resetBtn.disabled = host.isBusy();
    }
    open = { close: close, update: update, focus: function () { search.focus(); }, isOpen: function () { return !!open; } };
    update();
    return open;
}
