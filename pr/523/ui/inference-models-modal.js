/**
 * ui/inference-models-modal.js — the Inference panel's "Models for each view"
 * modal (Models ▸ Assign models…): which sleap-nn model each camera view runs
 * with. One model per view; one model can serve several views.
 *
 * Layout: a Models table (each model a colour, its folders, how many views use
 * it) and a Views table (one row per view: its video and a model menu; tick
 * several rows to give them one model at once; Clear all puts every view back
 * to no model). Beside them a collapsible 3D view (`ui/models-3d-pane.js`, shared
 * with Training ▸ Models to train…): a second `Viewport3D` with the app viewer's
 * own display settings and scene, where each camera wears its model's colour.
 * HOVER drives the highlight: a view row (or the camera itself in the 3D view)
 * lights its camera, a model row lights all its cameras (`Viewport3D.tintCameras`).
 *
 * The card moves by dragging its header and resizes from its corner; ⤢ fills
 * the window. Edits go to a copy of the assignment; Apply hands it back, Cancel
 * / Esc / ✕ drop it. A `data-shortcut-modal` scrim, so no app shortcut (frame
 * stepping, play/pause included) acts on the view behind it.
 *
 * Data: `ui/inference-model-assignment.js` (plain, Node-tested).
 */
import { trapModal } from './connect/layers.js?v=e37e05d05839';
import { createModels3DPane } from './models-3d-pane.js?v=e37e05d05839';
import {
    cloneAssignment, addModel, addFolderToModel, removeModel, assignView, assignViews, clearAssignments,
    modelOfView, viewsOfModel, modelLabel, foldersNeeded, pruneViews,
} from './inference-model-assignment.js?v=e37e05d05839';

const UNASSIGNED_COLOR = '#6b6b6b';
const NO_VIEWS_TEXT = 'Import a session or project first.';

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

function btn(cls, text, title) {
    const b = el('button', cls, text);
    b.type = 'button';
    if (title) { b.title = title; b.setAttribute('aria-label', title); }
    return b;
}

function plural(n, word) { return n.toLocaleString('en-US') + ' ' + word + (n === 1 ? '' : 's'); }

/**
 * Open the modal (one at a time).
 *
 * @param {{
 *   assignment: Object,                        // the applied assignment (not modified)
 *   views: Array<{view:string, video:string|null, blocked:string|null}>,
 *   pipeline: string,
 *   pickModel: () => Promise<string|null>,     // a model folder the user picked
 *   onApply: (assignment:Object) => void,
 * }} o
 * @returns {{ close: () => void } | null}
 */
export function openModelsModal(o) {
    if (document.getElementById('infModelsModal')) return null;
    const work = cloneAssignment(o.assignment);
    const views = o.views.slice();
    const viewNames = views.map(function (v) { return v.view; });
    pruneViews(work, viewNames);
    const checked = new Set();
    let hover = null;            // {kind:'view'|'model', id}

    // ---- shell ----
    const scrim = el('div', 'inf-mm-scrim');
    scrim.id = 'infModelsModal';
    scrim.setAttribute('data-shortcut-modal', '1');
    const card = el('div', 'inf-mm');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'infMmTitle');
    scrim.appendChild(card);

    const head = el('div', 'inf-mm-head');
    const title = el('span', 'inf-mm-title', 'Models for each view');
    title.id = 'infMmTitle';
    const maxBtn = btn('inf-mm-icon', '⤢', 'Fill the window');
    maxBtn.id = 'infMmMax';
    const closeBtn = btn('inf-mm-icon', '✕', 'Close');
    head.appendChild(title);
    head.appendChild(maxBtn);
    head.appendChild(closeBtn);
    card.appendChild(head);

    const body = el('div', 'inf-mm-body');
    const main = el('div', 'inf-mm-main');
    const pane3d = createModels3DPane({
        ids: { stage: 'infMm3dStage', toggle: 'infMm3dToggle', foot: 'infMm3dFoot' },
        noCalibrationText: 'No calibration loaded, so the cameras can’t be placed. Assigning models still works.',
        onCameraHover: function (name) {
            if (name && viewNames.indexOf(name) !== -1) hover = { kind: 'view', id: name };
            else if (hover && hover.kind === 'view') hover = null;
            paintFocus();
        },
    });
    body.appendChild(main);
    body.appendChild(pane3d.el);
    card.appendChild(body);

    const foot = el('div', 'inf-mm-foot');
    const status = el('div', 'inf-mm-status');
    status.id = 'infMmStatus';
    const cancelBtn = btn('btn btn-sm', 'Cancel');
    const applyBtn = btn('btn btn-sm btn-primary', 'Apply');
    applyBtn.id = 'infMmApply';
    foot.appendChild(status);
    foot.appendChild(cancelBtn);
    foot.appendChild(applyBtn);
    card.appendChild(foot);

    // ---- Models table ----
    const modelsHead = el('div', 'inf-mm-sechead');
    modelsHead.appendChild(el('span', 'inf-mm-label', 'Models'));
    const addBtn = btn('btn btn-sm', '+ Add model folder…');
    addBtn.id = 'infMmAddModel';
    modelsHead.appendChild(addBtn);
    main.appendChild(modelsHead);
    const modelsBox = el('div', 'inf-mm-tablebox');
    main.appendChild(modelsBox);

    // ---- Views table ----
    const viewsHead = el('div', 'inf-mm-sechead');
    viewsHead.appendChild(el('span', 'inf-mm-label', 'Views'));
    const clearBtn = btn('btn btn-sm', 'Clear all', 'Set every view to no model');
    clearBtn.id = 'infMmClear';
    viewsHead.appendChild(clearBtn);
    main.appendChild(viewsHead);
    const bulk = el('div', 'inf-mm-bulk');
    main.appendChild(bulk);
    const viewsBox = el('div', 'inf-mm-tablebox');
    main.appendChild(viewsBox);

    // ---- render ----
    function renderModels() {
        modelsBox.textContent = '';
        if (!work.models.length) {
            modelsBox.appendChild(el('p', 'inf-mm-empty', foldersNeeded(o.pipeline) === 2
                ? 'No models yet. Add a centroid folder, then its centered-instance folder.'
                : 'No models yet. Add a model folder.'));
            return;
        }
        const t = el('table', 'inf-mm-table');
        t.id = 'infMmModels';
        const hr = el('tr');
        ['', 'Model', 'Folders', 'Views', ''].forEach(function (h) { hr.appendChild(el('th', null, h)); });
        t.appendChild(el('thead')).appendChild(hr);
        const tb = el('tbody');
        work.models.forEach(function (m) {
            const tr = el('tr');
            tr.dataset.model = m.id;
            const sw = el('td');
            sw.appendChild(swatch(m.color));
            tr.appendChild(sw);
            const name = el('td', 'inf-mm-name', modelLabel(m));
            name.title = m.paths.join('\n');
            tr.appendChild(name);
            const need = foldersNeeded(o.pipeline);
            const folders = el('td', 'inf-mm-num');
            folders.textContent = String(m.paths.length);
            if (m.paths.length < need) {
                const more = btn('btn btn-sm inf-mm-more', '+ folder', 'Add the second folder (centered instance)');
                more.addEventListener('click', async function () {
                    const p = await pick();
                    if (p) addFolderToModel(work, m.id, p);
                    renderAll();
                });
                folders.appendChild(more);
            }
            tr.appendChild(folders);
            tr.appendChild(el('td', 'inf-mm-num', String(viewsOfModel(work, m.id, viewNames).length)));
            const rmTd = el('td', 'inf-mm-act');
            const rm = btn('inf-mm-icon', '✕', 'Remove ' + modelLabel(m));
            rm.addEventListener('click', function () { removeModel(work, m.id); hover = null; renderAll(); });
            rmTd.appendChild(rm);
            tr.appendChild(rmTd);
            hoverable(tr, 'model', m.id);
            tb.appendChild(tr);
        });
        t.appendChild(tb);
        modelsBox.appendChild(t);
    }

    function modelSelect(current, disabled) {
        const s = el('select', 'inf-mm-select');
        const none = el('option', null, 'No model');
        none.value = '';
        s.appendChild(none);
        work.models.forEach(function (m) {
            const op = el('option', null, modelLabel(m));
            op.value = m.id;
            if (m.id === current) op.selected = true;
            s.appendChild(op);
        });
        if (!current) s.classList.add('inf-mm-none');
        s.disabled = !!disabled;
        return s;
    }

    function renderBulk() {
        bulk.textContent = '';
        bulk.hidden = !views.length;
        if (!views.length) return;
        const runnable = views.filter(function (v) { return !v.blocked; });
        if (checked.size) {
            bulk.classList.add('on');
            bulk.appendChild(el('span', null, plural(checked.size, 'view') + ' selected'));
            const s = modelSelect(work.models[0] ? work.models[0].id : '', !work.models.length);
            s.id = 'infMmBulkModel';
            bulk.appendChild(s);
            const go = btn('btn btn-sm btn-primary', 'Assign');
            go.id = 'infMmBulkAssign';
            go.addEventListener('click', function () {
                assignViews(work, Array.from(checked), s.value || null);
                checked.clear();
                renderAll();
            });
            bulk.appendChild(go);
            const none = btn('btn btn-sm', 'Unselect');
            none.addEventListener('click', function () { checked.clear(); renderAll(); });
            bulk.appendChild(none);
        } else {
            bulk.classList.remove('on');
            bulk.appendChild(el('span', 'inf-mm-hint', 'Tick several views to give them one model.'));
            const all = btn('btn btn-sm', 'Select all');
            all.id = 'infMmSelectAll';
            all.disabled = !runnable.length;
            all.addEventListener('click', function () { runnable.forEach(function (v) { checked.add(v.view); }); renderAll(); });
            bulk.appendChild(all);
        }
    }

    function renderViews() {
        viewsBox.textContent = '';
        clearBtn.disabled = !views.length || !Object.keys(work.byView).length;
        if (!views.length) {
            const p = el('p', 'inf-mm-empty', NO_VIEWS_TEXT);
            p.id = 'infMmNoViews';
            viewsBox.appendChild(p);
            return;
        }
        const t = el('table', 'inf-mm-table');
        t.id = 'infMmViews';
        const hr = el('tr');
        ['', 'View', 'Video', 'Model'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
        t.appendChild(el('thead')).appendChild(hr);
        const tb = el('tbody');
        views.forEach(function (v) {
            const tr = el('tr');
            tr.dataset.view = v.view;
            const m = modelOfView(work, v.view);
            const ckTd = el('td');
            const ck = el('input');
            ck.type = 'checkbox';
            ck.checked = checked.has(v.view);
            ck.disabled = !!v.blocked;
            ck.setAttribute('aria-label', 'Select ' + v.view);
            ck.addEventListener('change', function () {
                if (ck.checked) checked.add(v.view); else checked.delete(v.view);
                renderBulk();
            });
            ckTd.appendChild(ck);
            tr.appendChild(ckTd);
            const nameTd = el('td', 'inf-mm-name');
            nameTd.appendChild(swatch(m ? m.color : UNASSIGNED_COLOR));
            nameTd.appendChild(document.createTextNode(' ' + v.view));
            tr.appendChild(nameTd);
            const vid = el('td', 'inf-mm-video', v.blocked ? v.blocked : (v.video || 'no video file'));
            if (v.blocked || !v.video) vid.classList.add('inf-mm-muted');
            vid.title = v.video || '';
            tr.appendChild(vid);
            const selTd = el('td');
            const s = modelSelect(m ? m.id : '', !!v.blocked || !work.models.length);
            s.setAttribute('aria-label', 'Model for ' + v.view);
            s.addEventListener('change', function () { assignView(work, v.view, s.value || null); renderAll(); });
            selTd.appendChild(s);
            tr.appendChild(selTd);
            if (v.blocked) tr.classList.add('inf-mm-blocked');
            hoverable(tr, 'view', v.view);
            tb.appendChild(tr);
        });
        t.appendChild(tb);
        viewsBox.appendChild(t);
    }

    function renderStatus() {
        if (!views.length) { status.textContent = ''; return; }
        const runnable = views.filter(function (v) { return !v.blocked; }).map(function (v) { return v.view; });
        const without = runnable.filter(function (v) { return !work.byView[v]; });
        status.classList.toggle('inf-mm-warn', without.length > 0);
        status.textContent = without.length
            ? plural(without.length, 'view') + ' without a model will be skipped: ' + without.join(', ')
            : 'Every view has a model.';
    }

    function renderAll() {
        renderModels();
        renderBulk();
        renderViews();
        renderStatus();
        paintFocus();
    }

    function swatch(color) {
        const s = el('span', 'inf-mm-swatch');
        s.style.background = color;
        return s;
    }

    // ---- hover → 3D highlight ----
    function hoverable(node, kind, id) {
        node.addEventListener('mouseenter', function () { hover = { kind: kind, id: id }; paintFocus(); });
        node.addEventListener('mouseleave', function () {
            if (hover && hover.kind === kind && hover.id === id) { hover = null; paintFocus(); }
        });
    }

    function focusViews() {
        if (!hover) return null;
        return hover.kind === 'view' ? [hover.id] : viewsOfModel(work, hover.id, viewNames);
    }

    function paintFocus() {
        const focus = focusViews();
        main.querySelectorAll('tr[data-view], tr[data-model]').forEach(function (tr) {
            const on = !!hover && (
                (!!tr.dataset.view && focus.indexOf(tr.dataset.view) !== -1) ||
                (!!tr.dataset.model && tr.dataset.model === (hover.kind === 'model' ? hover.id : (work.byView[hover.id] || null))));
            tr.classList.toggle('inf-mm-hl', on === true);   // never undefined: toggle(x, undefined) FLIPS
        });
        if (!hover) pane3d.setFoot(views.length ? 'Hover a view or a model to see its cameras.' : '');
        else if (hover.kind === 'view') {
            const m = modelOfView(work, hover.id);
            pane3d.setFoot(hover.id + ' → ' + (m ? modelLabel(m) : 'no model'));
        } else {
            const m = work.models.find(function (x) { return x.id === hover.id; });
            pane3d.setFoot(m ? modelLabel(m) + ' → ' + (focus.length ? focus.join(', ') : 'no views yet') : '');
        }
        const colors = {};
        viewNames.forEach(function (v) {
            const m = modelOfView(work, v);
            colors[v] = m ? m.color : UNASSIGNED_COLOR;
        });
        pane3d.tint({ colors: colors, defaultColor: UNASSIGNED_COLOR, focus: focus });
    }

    // ---- move / resize / fill ----
    let restoreRect = null;
    function placeCentered() {
        const w = Math.min(1040, window.innerWidth - 32);
        const h = Math.min(640, window.innerHeight - 32);
        card.style.width = w + 'px';
        card.style.height = h + 'px';
        card.style.left = Math.max(16, (window.innerWidth - w) / 2) + 'px';
        card.style.top = Math.max(16, (window.innerHeight - h) / 2) + 'px';
    }
    function clampIntoWindow() {
        const r = card.getBoundingClientRect();
        const left = Math.min(Math.max(r.left, 60 - r.width), window.innerWidth - 60);
        const top = Math.min(Math.max(r.top, 0), window.innerHeight - 40);
        card.style.left = left + 'px';
        card.style.top = top + 'px';
    }
    function toggleFill() {
        if (card.classList.contains('inf-mm-filled')) {
            card.classList.remove('inf-mm-filled');
            if (restoreRect) Object.assign(card.style, restoreRect);
            maxBtn.title = 'Fill the window';
        } else {
            restoreRect = { left: card.style.left, top: card.style.top, width: card.style.width, height: card.style.height };
            card.classList.add('inf-mm-filled');
            Object.assign(card.style, { left: '16px', top: '16px', width: (window.innerWidth - 32) + 'px', height: (window.innerHeight - 32) + 'px' });
            maxBtn.title = 'Restore the size';
        }
        maxBtn.setAttribute('aria-label', maxBtn.title);
        pane3d.resize();
    }
    head.addEventListener('pointerdown', function (e) {
        if (e.button !== 0 || e.target.closest('button')) return;
        e.preventDefault();
        card.classList.remove('inf-mm-filled');
        const r = card.getBoundingClientRect();
        const dx = e.clientX - r.left, dy = e.clientY - r.top;
        head.setPointerCapture(e.pointerId);
        function move(ev) {
            card.style.left = (ev.clientX - dx) + 'px';
            card.style.top = (ev.clientY - dy) + 'px';
        }
        function up() {
            head.removeEventListener('pointermove', move);
            head.removeEventListener('pointerup', up);
            head.removeEventListener('pointercancel', up);
            clampIntoWindow();
        }
        head.addEventListener('pointermove', move);
        head.addEventListener('pointerup', up);
        head.addEventListener('pointercancel', up);
    });
    head.addEventListener('dblclick', function (e) { if (!e.target.closest('button')) toggleFill(); });

    // ---- actions ----
    async function pick() {
        try { return await o.pickModel(); } catch (e) { status.textContent = 'Add model failed: ' + e.message; return null; }
    }
    addBtn.addEventListener('click', async function () {
        const p = await pick();
        if (p) addModel(work, [p]);
        renderAll();
    });
    clearBtn.addEventListener('click', function () { clearAssignments(work); checked.clear(); renderAll(); });
    maxBtn.addEventListener('click', toggleFill);

    let trap = null;
    function close(apply) {
        if (!scrim.isConnected) return;
        if (apply) o.onApply(work);
        if (trap) { trap.release(); trap.restoreFocus(); }
        window.removeEventListener('resize', clampIntoWindow);
        pane3d.dispose();
        scrim.remove();
    }
    closeBtn.addEventListener('click', function () { close(false); });
    cancelBtn.addEventListener('click', function () { close(false); });
    applyBtn.addEventListener('click', function () { close(true); });

    document.body.appendChild(scrim);
    placeCentered();
    window.addEventListener('resize', clampIntoWindow);
    trap = trapModal(scrim, card, { onEscape: function () { close(false); } });
    renderAll();
    pane3d.mount(views.length > 0);
    paintFocus();
    applyBtn.focus();
    return { close: function () { close(false); } };
}
