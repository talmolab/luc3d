/**
 * ui/training-models-modal.js — the Training panel's "Models to train" modal (Training ▸ Edit models…): the
 * reverse of Inference ▸ Assign models…. The user makes models (+ New model, or a split of the views), gives
 * each one camera views (the views whose labelled frames train it; a view may train several models) and sets
 * each model's settings in a side panel.
 *
 * Layout:
 *   - the centre column: "Start from" (one model for all views / one per view / by name; the new models start
 *     from the shown model's settings, as + New model does), then the MODELS:
 *     one card per model with its view tags (✕ takes a view out, "+ Add view" puts one in), its type and a
 *     line of its settings; then the Views table, folded by default and scrolling within a capped height
 *     (one row per camera: its labelled frames, a toggle per model, and which model's predictions it gets
 *     after training when several models train it); then the run's settings, folded (built by the panel);
 *   - the side panel: the selected model's name and settings (built by the panel: Model Type & Configs,
 *     Hyperparameters, Full Configuration…), and Delete; it folds to a strip;
 *   - the 3D view (`ui/models-3d-pane.js`, the Inference modal's): each camera wears its model's colour, the
 *     selected model's pyramids are lit, and HOVER lights a camera (a tag, a row or the camera itself in 3D)
 *     or a model's cameras (its card). A click on a camera in 3D puts it in the selected model or takes it out.
 *
 * Edits go to the working copy the panel passes (`o.work`: `{models, runCfg}`); Apply hands it back, Cancel /
 * Esc / ✕ drop it. The card moves by dragging its header and resizes from its corner; ⤢ fills the window.
 * A `data-shortcut-modal` scrim, so no app shortcut acts on the view behind it.
 *
 * Data: `pose/training-models.js` (plain, Node-tested).
 */
import { trapModal } from './connect/layers.js';
import { createModels3DPane } from './models-3d-pane.js';
import {
    modelViews, modelsOfView, toggleModelView, addModelViews, removeModelViews, splitViews, viewTokens, inferenceModelOf,
} from '../pose/training-models.js';

const UNASSIGNED_COLOR = '#6b6b6b';

let current = null;

/** The open modal's handle, or null. */
export function trainingModelsModal() { return current; }

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

function swatch(color) {
    const s = el('span', 'inf-mm-swatch');
    s.style.background = color;
    return s;
}

/** A swatch split between the colours of every model a view trains (grey: none). */
function viewSwatchBg(ms) {
    if (!ms.length) return UNASSIGNED_COLOR;
    if (ms.length === 1) return ms[0].color;
    const step = 100 / ms.length;
    return 'conic-gradient(' + ms.map(function (m, i) { return m.color + ' ' + (i * step) + '% ' + ((i + 1) * step) + '%'; }).join(', ') + ')';
}

/**
 * Open the modal (one at a time).
 *
 * @param {{
 *   work: {models: object[], runCfg: {inferWith: Object<string,string>}},   // the copy the modal edits
 *   allViews: () => string[],                // every camera of the project, in order
 *   available: () => string[],               // the views that can train (labelled, checked)
 *   viewStats: (view: string) => {frames: number, instances: number},
 *   newModel: (models: object[], o: {name?: string, views?: string[], auto?: boolean}, template: object|null) => object,  // starts from `template`'s settings
 *   typeLabel: (m: object) => string,
 *   metaText: (m: object) => string,
 *   status: () => {warn: boolean, text: string},
 *   buildDrawer: (container: HTMLElement, selected: () => object|null) => void,
 *   buildRunSettings: (container: HTMLElement) => void,
 *   refreshForms: (selected: object|null) => void,
 *   isBusy: () => boolean,
 *   onApply: (work: object) => void,
 *   onClose: () => void,
 *   initialModelId?: string|null,
 *   openRun?: boolean,
 * }} o
 */
export function openTrainingModelsModal(o) {
    if (current) return current;
    const work = o.work;
    let selectedId = o.initialModelId || (work.models[0] ? work.models[0].id : null);
    let drawerOpen = !!selectedId;
    let hover = null;                 // {kind: 'view'|'model', id}
    const checked = new Set();
    // Every id a model has had while the modal is open: a split rebuilds the list, and a new model must never take
    // an old model's id (open forms and the user's after-training picks refer to models by id).
    const usedIds = new Set(work.models.map(function (m) { return m.id; }));
    let idSeq = 0;
    usedIds.forEach(function (id) { const k = /^m(\d+)$/.exec(id); if (k) idSeq = Math.max(idSeq, Number(k[1])); });
    function freshModel(list, p, template) {
        const m = o.newModel(list, p, template);
        if (usedIds.has(m.id)) m.id = 'm' + (++idSeq);
        else { const k = /^m(\d+)$/.exec(m.id); if (k) idSeq = Math.max(idSeq, Number(k[1])); }
        usedIds.add(m.id);
        return m;
    }

    /** Rebuild `box` and give focus back to the control that had it (or its model's first control): keyboard users
     *  keep their place when a toggle, a tag ✕ or "+ Add view" re-renders the cards. */
    function keepFocus(box, rebuild) {
        const a = document.activeElement;
        const key = a && box.contains(a) && a.dataset ? a.dataset.fk : null;
        rebuild();
        if (!key) return;
        let next = box.querySelector('[data-fk="' + CSS.escape(key) + '"]');
        if (!next) {
            // The control went away (a tag's ✕): its card's "+ Add view", else the card's name.
            const kind = key.split('|')[0], owner = key.split('|')[1];
            const tries = kind === 'tagx' ? ['add|' + owner, 'name|' + owner] : ['name|' + owner];
            for (const t of tries) { next = box.querySelector('[data-fk="' + CSS.escape(t) + '"]'); if (next) break; }
        }
        if (next && !next.disabled) next.focus();
    }

    function selected() { return work.models.find(function (m) { return m.id === selectedId; }) || null; }
    function allViews() { return o.allViews(); }

    // ---- shell ----
    const scrim = el('div', 'inf-mm-scrim trn-mm-scrim');
    scrim.id = 'trnModelsModal';
    scrim.setAttribute('data-shortcut-modal', '1');
    const card = el('div', 'inf-mm trn-mm');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'trnMmTitle');
    scrim.appendChild(card);

    const head = el('div', 'inf-mm-head');
    const title = el('span', 'inf-mm-title', 'Models to train');
    title.id = 'trnMmTitle';
    const maxBtn = btn('inf-mm-icon', '⤢', 'Fill the window');
    const closeBtn = btn('inf-mm-icon', '✕', 'Close');
    head.appendChild(title);
    head.appendChild(maxBtn);
    head.appendChild(closeBtn);
    card.appendChild(head);

    const body = el('div', 'inf-mm-body');
    const main = el('div', 'inf-mm-main trn-mm-main');
    const drawer = el('div', 'trn-mm-drawer');
    drawer.id = 'trnMmDrawer';
    const pane3d = createModels3DPane({
        ids: { stage: 'trnMm3dStage', toggle: 'trnMm3dToggle', foot: 'trnMm3dFoot' },
        noCalibrationText: 'No calibration loaded, so the cameras can’t be placed. Models still work.',
        onCameraHover: function (name) {
            if (name) hover = { kind: 'view', id: name };
            else if (hover && hover.kind === 'view') hover = null;
            paintFocus();
        },
        onCameraClick: function (name) {
            const m = selected();
            if (!m || o.isBusy() || allViews().indexOf(name) === -1) return;
            toggleModelView(m, name, allViews());
            renderAll();
        },
    });
    body.appendChild(main);
    body.appendChild(drawer);
    body.appendChild(pane3d.el);
    card.appendChild(body);

    const foot = el('div', 'inf-mm-foot');
    const status = el('div', 'inf-mm-status');
    status.id = 'trnMmStatus';
    const cancelBtn = btn('btn btn-sm', 'Cancel');
    cancelBtn.id = 'trnMmCancel';
    const applyBtn = btn('btn btn-sm btn-primary', 'Apply');
    applyBtn.id = 'trnMmApply';
    foot.appendChild(status);
    foot.appendChild(cancelBtn);
    foot.appendChild(applyBtn);
    card.appendChild(foot);

    // ---- centre: start from, models, views, run settings ----
    const splitRow = el('div', 'trn-mm-split');
    splitRow.appendChild(el('span', 'inf-mm-label', 'Start from'));
    const splitAll = btn('btn btn-sm inf-btn-outline', 'One model, all views');
    splitAll.id = 'trnMmSplitAll';
    const splitEach = btn('btn btn-sm inf-btn-outline', 'One per view');
    splitEach.id = 'trnMmSplitEach';
    const splitName = btn('btn btn-sm inf-btn-outline', 'By name');
    splitName.id = 'trnMmSplitName';
    splitRow.appendChild(splitAll);
    splitRow.appendChild(splitEach);
    splitRow.appendChild(splitName);
    main.appendChild(splitRow);

    const modelsHead = el('div', 'inf-mm-sechead');
    modelsHead.appendChild(el('span', 'inf-mm-label', 'Models'));
    const addBtn = btn('btn btn-sm', '+ New model');
    addBtn.id = 'trnMmAddModel';
    modelsHead.appendChild(addBtn);
    main.appendChild(modelsHead);
    const modelsBox = el('div', 'trn-mm-models');
    modelsBox.id = 'trnMmModels';
    main.appendChild(modelsBox);

    const viewsFold = el('details', 'trn-mm-fold');
    viewsFold.id = 'trnMmViewsFold';
    const viewsSum = el('summary', 'trn-mm-foldhead');
    viewsSum.appendChild(el('span', 'inf-chevron'));
    viewsSum.appendChild(el('span', 'inf-mm-label', 'Views'));
    const viewsCount = el('span', 'trn-mm-foldnote');
    viewsSum.appendChild(viewsCount);
    viewsFold.appendChild(viewsSum);
    const bulk = el('div', 'inf-mm-bulk');
    viewsFold.appendChild(bulk);
    const viewsBox = el('div', 'trn-mm-views');
    viewsBox.id = 'trnMmViews';
    viewsFold.appendChild(viewsBox);
    main.appendChild(viewsFold);

    const runFold = el('details', 'trn-mm-fold');
    runFold.id = 'trnMmRunFold';
    runFold.open = !!o.openRun;
    const runSum = el('summary', 'trn-mm-foldhead');
    runSum.appendChild(el('span', 'inf-chevron'));
    runSum.appendChild(el('span', 'inf-mm-label', 'Run settings'));
    runSum.appendChild(el('span', 'trn-mm-foldnote', 'every model'));
    runFold.appendChild(runSum);
    const runBox = el('div', 'trn-mm-run inference-panel training-panel');
    runFold.appendChild(runBox);
    main.appendChild(runFold);
    o.buildRunSettings(runBox);

    // ---- side panel: the selected model's settings ----
    const drawerHead = el('div', 'trn-mm-drawerhead');
    const drawerSw = swatch(UNASSIGNED_COLOR);
    const nameInput = el('input', 'trn-mm-nameinput');
    nameInput.type = 'text';
    nameInput.id = 'trnMmName';
    nameInput.setAttribute('aria-label', 'Model name');
    nameInput.maxLength = 60;
    const foldBtn = btn('inf-mm-icon', '⟩', 'Hide the model settings');
    foldBtn.id = 'trnMmDrawerFold';
    drawerHead.appendChild(drawerSw);
    drawerHead.appendChild(nameInput);
    drawerHead.appendChild(foldBtn);
    const drawerBody = el('div', 'trn-mm-drawerbody inference-panel training-panel');
    const drawerFoot = el('div', 'trn-mm-drawerfoot');
    const delBtn = btn('btn btn-sm inf-btn-danger', 'Delete this model');
    delBtn.id = 'trnMmDelete';
    drawerFoot.appendChild(delBtn);
    const strip = btn('trn-mm-strip', '');
    strip.id = 'trnMmDrawerOpen';
    drawer.appendChild(drawerHead);
    drawer.appendChild(drawerBody);
    drawer.appendChild(drawerFoot);
    drawer.appendChild(strip);
    o.buildDrawer(drawerBody, selected);

    // ---- render ----
    let modelsKey = '';
    function renderModels() {
        const all = allViews();
        const avail = o.available();
        const key = JSON.stringify([work.models.map(function (m) {
            return [m.id, m.name, m.color, m.auto, modelViews(m, all), o.typeLabel(m), o.metaText(m)];
        }), selectedId, drawerOpen, avail, o.isBusy()]);
        if (key === modelsKey) return;
        modelsKey = key;
        keepFocus(modelsBox, function () { buildModels(all, avail); });
    }

    function buildModels(all, avail) {
        modelsBox.textContent = '';
        if (!work.models.length) {
            const p = el('p', 'inf-mm-empty', 'No models yet. + New model, or start from a split above.');
            p.id = 'trnMmNoModels';
            modelsBox.appendChild(p);
            return;
        }
        const busy = o.isBusy();
        work.models.forEach(function (m) {
            const views = modelViews(m, all);
            const c = el('div', 'trn-mm-card' + (m.id === selectedId && drawerOpen ? ' sel' : ''));
            c.dataset.model = m.id;
            const top = el('div', 'trn-mm-cardtop');
            top.appendChild(swatch(m.color));
            const name = btn('trn-mm-name', m.name);
            name.dataset.fk = 'name|' + m.id;
            name.title = 'Edit ' + m.name;
            name.addEventListener('click', function () { select(m.id); });
            top.appendChild(name);
            top.appendChild(el('span', 'trn-mm-badge', o.typeLabel(m)));
            const edit = btn('inf-mm-icon trn-mm-edit', '⚙', 'Settings of ' + m.name);
            edit.dataset.fk = 'edit|' + m.id;
            edit.addEventListener('click', function () { select(m.id); });
            top.appendChild(edit);
            const rm = btn('inf-mm-icon trn-mm-remove', '✕', 'Delete ' + m.name);
            rm.dataset.fk = 'rm|' + m.id;
            rm.disabled = busy;
            rm.addEventListener('click', function () { removeModel(m.id); });
            top.appendChild(rm);
            c.appendChild(top);

            const tags = el('div', 'trn-mm-tags');
            views.forEach(function (v) {
                const t = el('span', 'trn-mm-tag' + (avail.indexOf(v) === -1 ? ' off' : ''));
                t.dataset.view = v;
                t.appendChild(document.createTextNode(v));
                if (avail.indexOf(v) === -1) t.title = v + ' has no labelled frames to train on (or is unchecked in Run settings).';
                const x = btn('trn-mm-tagx', '✕', 'Take ' + v + ' out of ' + m.name);
                x.dataset.fk = 'tagx|' + m.id + '|' + v;
                x.disabled = busy;
                x.addEventListener('click', function () {
                    removeModelViews(m, [v], allViews());
                    // The tag under the pointer goes away: the card's model is what is hovered now.
                    if (hover && hover.kind === 'view' && hover.id === v) hover = { kind: 'model', id: m.id };
                    renderAll();
                });
                t.appendChild(x);
                hoverable(t, 'view', v);
                tags.appendChild(t);
            });
            const rest = all.filter(function (v) { return views.indexOf(v) === -1; });
            if (rest.length) {
                const add = el('select', 'trn-mm-addview');
                add.dataset.fk = 'add|' + m.id;
                add.setAttribute('aria-label', 'Add a view to ' + m.name);
                const ph = el('option', null, views.length ? '+ Add view' : '+ Add a view');
                ph.value = '';
                add.appendChild(ph);
                rest.forEach(function (v) { const op = el('option', null, v); op.value = v; add.appendChild(op); });
                if (rest.length > 1) { const op = el('option', null, 'All the other views'); op.value = '__all__'; add.appendChild(op); }
                add.disabled = busy;
                add.addEventListener('change', function () {
                    if (!add.value) return;
                    addModelViews(m, add.value === '__all__' ? rest : [add.value], allViews());
                    renderAll();
                });
                tags.appendChild(add);
            }
            if (m.auto && views.length) tags.appendChild(el('span', 'trn-mm-auto', 'follows every view'));
            c.appendChild(tags);
            c.appendChild(el('div', 'trn-mm-meta', o.metaText(m)));
            hoverable(c, 'model', m.id);
            modelsBox.appendChild(c);
        });
    }

    function renderBulk() {
        bulk.textContent = '';
        const all = allViews();
        const sel = selected();
        if (checked.size) {
            bulk.classList.add('on');
            bulk.appendChild(el('span', null, plural(checked.size, 'view') + ' selected'));
            const add = btn('btn btn-sm btn-primary', sel ? 'Add to ' + sel.name : 'Add to a new model');
            add.id = 'trnMmBulkAdd';
            add.addEventListener('click', function () {
                const vs = all.filter(function (v) { return checked.has(v); });
                if (sel) addModelViews(sel, vs, all);
                else addModel({ views: vs });
                checked.clear();
                renderAll();
            });
            bulk.appendChild(add);
            if (sel) {
                const rm = btn('btn btn-sm', 'Remove from ' + sel.name);
                rm.addEventListener('click', function () { removeModelViews(sel, Array.from(checked), all); checked.clear(); renderAll(); });
                bulk.appendChild(rm);
            }
            const none = btn('btn btn-sm', 'Unselect');
            none.addEventListener('click', function () { checked.clear(); renderAll(); });
            bulk.appendChild(none);
        } else {
            bulk.classList.remove('on');
            bulk.appendChild(el('span', 'inf-mm-hint', 'Tick several views to add them to a model at once.'));
            const allBtn = btn('btn btn-sm', 'Select all');
            allBtn.disabled = !all.length;
            allBtn.addEventListener('click', function () { all.forEach(function (v) { checked.add(v); }); renderAll(); });
            bulk.appendChild(allBtn);
        }
        if (o.isBusy()) bulk.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    }

    let viewsKey = '';
    function renderViews() {
        const all = allViews();
        const avail = o.available();
        const unused = avail.filter(function (v) { return !modelsOfView(work.models, v, all).length; });
        viewsCount.textContent = all.length ? plural(all.length, 'view') + (unused.length ? ' · ' + unused.length + ' in no model' : '') : '';
        viewsCount.classList.toggle('warn', unused.length > 0);
        const key = JSON.stringify([all, avail, work.models.map(function (m) { return [m.id, m.name, m.color, modelViews(m, all)]; }),
            work.runCfg.inferWith, Array.from(checked), o.isBusy()]);
        if (key === viewsKey) return;
        viewsKey = key;
        keepFocus(viewsBox, function () { buildViews(all, avail); });
    }

    function buildViews(all, avail) {
        viewsBox.textContent = '';
        if (!all.length) { viewsBox.appendChild(el('p', 'inf-mm-empty', 'Open a session to see its views.')); return; }
        const busy = o.isBusy();
        const t = el('div', 'trn-mm-vtable');
        const hr = el('div', 'trn-mm-vrow trn-mm-vhead');
        ['', 'View', 'Frames', 'Trains', 'After training'].forEach(function (h) { hr.appendChild(el('span', null, h)); });
        t.appendChild(hr);
        all.forEach(function (v) {
            const ms = modelsOfView(work.models, v, all);
            const st = o.viewStats(v);
            const r = el('div', 'trn-mm-vrow' + (avail.indexOf(v) === -1 ? ' off' : ''));
            r.dataset.view = v;
            const ck = el('input');
            ck.type = 'checkbox';
            ck.checked = checked.has(v);
            ck.disabled = busy;
            ck.setAttribute('aria-label', 'Select ' + v);
            ck.dataset.fk = 'ck|' + v;
            ck.addEventListener('change', function () { if (ck.checked) checked.add(v); else checked.delete(v); renderBulk(); });
            r.appendChild(ck);
            const nm = el('span', 'trn-mm-vname');
            const sw = swatch(UNASSIGNED_COLOR);
            sw.style.background = viewSwatchBg(ms);
            nm.appendChild(sw);
            nm.appendChild(document.createTextNode(' ' + v));
            r.appendChild(nm);
            r.appendChild(el('span', 'inf-mm-num', st.frames.toLocaleString('en-US')));
            const chips = el('span', 'trn-mm-chips');
            work.models.forEach(function (m) {
                const on = ms.indexOf(m) !== -1;
                const c = btn('trn-mm-chip' + (on ? ' on' : ''), '');
                c.dataset.fk = 'chip|' + v + '|' + m.id;
                c.setAttribute('aria-pressed', on ? 'true' : 'false');
                c.setAttribute('aria-label', (on ? 'Take ' + v + ' out of ' : 'Add ' + v + ' to ') + m.name);
                c.title = c.getAttribute('aria-label');
                c.style.setProperty('--m', m.color);
                c.appendChild(el('i'));
                c.appendChild(document.createTextNode(m.name));
                c.disabled = busy;
                c.addEventListener('click', function () { toggleModelView(m, v, all); renderAll(); });
                chips.appendChild(c);
            });
            r.appendChild(chips);
            const inf = el('span', 'trn-mm-infer');
            if (ms.length > 1) {
                const s = el('select', 'inf-mm-select');
                s.dataset.fk = 'inf|' + v;
                s.setAttribute('aria-label', 'Predictions for ' + v + ' after training come from');
                ms.forEach(function (m) { const op = el('option', null, m.name); op.value = m.id; s.appendChild(op); });
                s.value = inferenceModelOf(work.models, v, work.runCfg.inferWith, all).id;
                s.disabled = busy;
                s.addEventListener('change', function () { work.runCfg.inferWith[v] = s.value; renderAll(); });
                inf.appendChild(s);
            } else {
                inf.textContent = ms.length ? ms[0].name : 'not trained';
                inf.classList.add('inf-mm-muted');
            }
            r.appendChild(inf);
            hoverable(r, 'view', v);
            t.appendChild(r);
        });
        viewsBox.appendChild(t);
    }

    function renderDrawer() {
        const m = selected();
        const open = !!m && drawerOpen;
        drawer.classList.toggle('collapsed', !open);
        drawer.hidden = !m;
        if (!m) return;
        drawerSw.style.background = m.color;
        if (document.activeElement !== nameInput) nameInput.value = m.name;
        nameInput.disabled = o.isBusy();
        delBtn.disabled = o.isBusy();
        strip.textContent = '⟨ ' + m.name + ' settings';
        strip.setAttribute('aria-label', 'Show the settings of ' + m.name);
    }

    function renderStatus() {
        const st = o.status();
        status.textContent = st.text;
        status.classList.toggle('inf-mm-warn', !!st.warn);
        const tokens = viewTokens(allViews());
        splitName.disabled = tokens.length < 2 || o.isBusy();
        splitName.textContent = tokens.length >= 2 ? 'By name: ' + tokens.join(' · ') : 'By name';
        splitName.title = tokens.length >= 2 ? 'One model per word the view names share' : 'The view names share no word to group by.';
        const noViews = !allViews().length;
        splitAll.disabled = o.isBusy() || noViews;
        splitEach.disabled = o.isBusy() || noViews;
        addBtn.disabled = o.isBusy();
        applyBtn.disabled = o.isBusy();
    }

    function renderAll() {
        // The forms first: they settle each model (★ type, missing configs) that the cards then show.
        renderDrawer();
        o.refreshForms(drawerOpen ? selected() : null);
        renderModels();
        renderBulk();
        renderViews();
        renderStatus();
        paintFocus();
    }

    // ---- hover → 3D highlight ----
    function hoverable(node, kind, id) {
        node.addEventListener('mouseenter', function () {
            hover = { kind: kind, id: id };
            paintFocus();
        });
        node.addEventListener('mouseleave', function () {
            if (hover && hover.kind === kind && hover.id === id) {
                // Leaving a tag returns to its card's model.
                const cardEl = kind === 'view' ? node.closest('.trn-mm-card') : null;
                hover = cardEl ? { kind: 'model', id: cardEl.dataset.model } : null;
                paintFocus();
            }
        });
    }

    function focusViews() {
        const all = allViews();
        if (hover && hover.kind === 'view') return [hover.id];
        if (hover && hover.kind === 'model') {
            const m = work.models.find(function (x) { return x.id === hover.id; });
            return m ? modelViews(m, all) : [];
        }
        const m = drawerOpen ? selected() : null;
        return m ? modelViews(m, all) : null;
    }

    function paintFocus() {
        const all = allViews();
        const focus = focusViews();
        const hm = hover && hover.kind === 'model' ? work.models.find(function (x) { return x.id === hover.id; }) : null;
        const lead = hm || (drawerOpen ? selected() : null);
        card.querySelectorAll('.trn-mm-tag[data-view], .trn-mm-vrow[data-view]').forEach(function (n) {
            n.classList.toggle('hl', !!hover && hover.kind === 'view' && n.dataset.view === hover.id);
        });
        card.querySelectorAll('.trn-mm-card[data-model]').forEach(function (n) {
            const m = work.models.find(function (x) { return x.id === n.dataset.model; });
            const on = !!hover && !!m && (hover.kind === 'model' ? hover.id === m.id : modelViews(m, all).indexOf(hover.id) !== -1);
            n.classList.toggle('hl', on === true);
        });
        const colors = {};
        all.forEach(function (v) {
            const ms = modelsOfView(work.models, v, all);
            const m = lead && ms.indexOf(lead) !== -1 ? lead : ms[0];
            colors[v] = m ? m.color : UNASSIGNED_COLOR;
        });
        pane3d.tint({ colors: colors, defaultColor: UNASSIGNED_COLOR, focus: focus });
        if (hover && hover.kind === 'view') {
            const ms = modelsOfView(work.models, hover.id, all);
            pane3d.setFoot(hover.id + ' → ' + (ms.length ? ms.map(function (m) { return m.name; }).join(', ') : 'no model'));
        } else if (hm) {
            const vs = modelViews(hm, all);
            pane3d.setFoot(hm.name + ' → ' + (vs.length ? vs.join(', ') : 'no views yet'));
        } else {
            const m = drawerOpen ? selected() : null;
            pane3d.setFoot(!all.length ? '' : m
                ? 'Lit: ' + m.name + '. Click a camera to put it in ' + m.name + ' or take it out; hover one to see its models.'
                : 'Hover a model, a view or a camera to light its cameras.');
        }
    }

    // ---- actions ----
    function select(id) {
        selectedId = id;
        drawerOpen = true;
        renderAll();
    }
    function addModel(oo) {
        const m = freshModel(work.models, oo || {}, selected());
        work.models.push(m);
        select(m.id);
        return m;
    }
    function removeModel(id) {
        const i = work.models.findIndex(function (m) { return m.id === id; });
        if (i === -1) return;
        work.models.splice(i, 1);
        Object.keys(work.runCfg.inferWith).forEach(function (v) { if (work.runCfg.inferWith[v] === id) delete work.runCfg.inferWith[v]; });
        if (selectedId === id) selectedId = work.models[0] ? work.models[0].id : null;
        if (hover && hover.kind === 'model' && hover.id === id) hover = null;
        renderAll();
    }
    function split(kind) {
        const parts = splitViews(kind, allViews());
        if (!parts.length) return;
        // The new models start from the shown model's settings (a split keeps the recipe).
        const template = selected() || work.models[0] || null;
        work.models.length = 0;
        work.runCfg.inferWith = {};
        parts.forEach(function (p) { work.models.push(freshModel(work.models, p, template)); });
        selectedId = work.models[0].id;
        drawerOpen = true;
        hover = null;
        renderAll();
    }
    addBtn.addEventListener('click', function () {
        const vs = allViews().filter(function (v) { return checked.has(v); });
        checked.clear();
        addModel({ views: vs });
        nameInput.focus();
        nameInput.select();
    });
    splitAll.addEventListener('click', function () { split('all'); });
    splitEach.addEventListener('click', function () { split('perview'); });
    splitName.addEventListener('click', function () { split('name'); });
    nameInput.addEventListener('input', function () {
        const m = selected();
        if (!m) return;
        m.name = nameInput.value.trim() || m.name;
        renderModels();
        renderBulk();
        renderViews();
        strip.textContent = '⟨ ' + m.name + ' settings';
    });
    nameInput.addEventListener('change', function () {
        const m = selected();
        if (m && !nameInput.value.trim()) nameInput.value = m.name;   // a name cannot be empty: the model keeps its last one
        renderAll();
    });
    foldBtn.addEventListener('click', function () { drawerOpen = false; renderAll(); });
    strip.addEventListener('click', function () { drawerOpen = true; renderAll(); });
    delBtn.addEventListener('click', function () { const m = selected(); if (m) removeModel(m.id); });
    viewsFold.addEventListener('toggle', function () { viewsKey = ''; renderViews(); paintFocus(); });

    // ---- move / resize / fill (as the Inference modal) ----
    let restoreRect = null;
    function placeCentered() {
        const w = Math.min(1240, window.innerWidth - 32);
        const h = Math.min(760, window.innerHeight - 32);
        card.style.width = w + 'px';
        card.style.height = h + 'px';
        card.style.left = Math.max(16, (window.innerWidth - w) / 2) + 'px';
        card.style.top = Math.max(16, (window.innerHeight - h) / 2) + 'px';
    }
    function clampIntoWindow() {
        const r = card.getBoundingClientRect();
        card.style.left = Math.min(Math.max(r.left, 60 - r.width), window.innerWidth - 60) + 'px';
        card.style.top = Math.min(Math.max(r.top, 0), window.innerHeight - 40) + 'px';
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
    maxBtn.addEventListener('click', toggleFill);

    let trap = null;
    function close(apply) {
        if (!scrim.isConnected) return;
        if (apply) o.onApply(work);
        current = null;
        if (trap) { trap.release(); trap.restoreFocus(); }
        window.removeEventListener('resize', clampIntoWindow);
        pane3d.dispose();
        scrim.remove();
        o.onClose();
    }
    closeBtn.addEventListener('click', function () { close(false); });
    cancelBtn.addEventListener('click', function () { close(false); });
    applyBtn.addEventListener('click', function () { if (!o.isBusy()) close(true); });

    current = {
        refresh: renderAll,
        close: function (apply) { close(!!apply); },
        selected: function () { return drawerOpen ? selected() : null; },
        runCfg: function () { return work.runCfg; },
        modelCount: function () { return work.models.length; },
        select: select,
    };
    document.body.appendChild(scrim);
    placeCentered();
    window.addEventListener('resize', clampIntoWindow);
    trap = trapModal(scrim, card, { onEscape: function () { close(false); } });
    renderAll();
    pane3d.mount(allViews().length > 0);
    paintFocus();
    if (o.openRun) runFold.scrollIntoView({ block: 'nearest' });
    applyBtn.focus();
    return current;
}
