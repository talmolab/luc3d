/**
 * pose/training-models.js — the models a training run trains (the Training panel's "Models to train" modal):
 * each model has a name, a colour and the camera views whose labelled frames train it; its settings
 * (model type, configs, hyperparameters) are held with it by `ui/training-panel.js`. A view may train
 * several models; a view in no model trains nothing.
 *
 * DOM-free (Node tests: tests/test-training-models.mjs).
 *
 * A view is a camera NAME: it stands for that camera in every session (cam2 of session A and cam2 of
 * session B are one view), as Inference ▸ Assign models… maps models to views. A model made by
 * "One model, all views" (the default) is `auto`: it follows every view of the project, also views of
 * a session opened later, until its views are edited.
 *
 * After training, inference runs ONE model per view (`inferenceModelOf`): the one the user picked for that
 * view, else the model of that view with the fewest views (the most specific), the first in the list on a tie.
 *
 * Run names follow sleap-app (`trainingStore.ts` `YYMMDD_HHMMSS.<head>.n=<N>`, N = user-labelled frames) and add
 * the model's name when the run trains more than one model: `YYMMDD_HHMMSS.<head>.<model>.n=<N>`.
 */

/** Same palette as the Inference panel's models (`MODEL_COLORS`), so a model keeps its colour there. */
export const MODEL_COLORS = Object.freeze(['#6fcf8f', '#f0a35e', '#5cc4ee', '#e284d6', '#e6d460', '#9b8cf2', '#f07f7f', '#7fe0c8']);

export const ALL_VIEWS_NAME = 'All views';

function unique(list) {
    const out = [];
    (list || []).forEach(function (v) {
        const s = v == null ? '' : String(v);
        if (s !== '' && out.indexOf(s) === -1) out.push(s);
    });
    return out;
}

/** `list` in the project's view order (`allViews`); views the project does not show (yet) keep their place at the end. */
export function orderedViews(list, allViews) {
    const want = unique(list);
    const all = unique(allViews);
    return all.filter(function (v) { return want.indexOf(v) !== -1; })
        .concat(want.filter(function (v) { return all.indexOf(v) === -1; }));
}

/** The first palette colour no model wears (cycling once all are taken). */
export function freeColor(models) {
    const used = (models || []).map(function (m) { return m.color; });
    for (const c of MODEL_COLORS) if (used.indexOf(c) === -1) return c;
    return MODEL_COLORS[(models || []).length % MODEL_COLORS.length];
}

function nextId(models) {
    let n = 0;
    (models || []).forEach(function (m) {
        const k = /^m(\d+)$/.exec(String(m.id));
        if (k) n = Math.max(n, Number(k[1]));
    });
    return 'm' + (n + 1);
}

/** "Model 3", or the next free "Model N". */
export function newModelName(models) {
    const names = (models || []).map(function (m) { return m.name; });
    for (let n = (models || []).length + 1; ; n++) if (names.indexOf('Model ' + n) === -1) return 'Model ' + n;
}

/**
 * A new model (not added to `models`): a fresh id, the first free colour, `o.name` or "Model N", `o.views`
 * (de-duplicated) and `o.extra` (the panel's settings) merged in.
 * @param {object[]} models the models it will join
 * @param {{name?: string, views?: string[], auto?: boolean, extra?: object}} [o]
 */
export function createModel(models, o) {
    const oo = o || {};
    return Object.assign({
        id: nextId(models),
        name: oo.name && String(oo.name).trim() ? String(oo.name).trim() : newModelName(models),
        color: freeColor(models),
        views: unique(oo.views),
        auto: !!oo.auto,
    }, oo.extra || {});
}

/** The views a model trains on among `available` (an `auto` model: all of them). */
export function modelViews(model, available) {
    const all = unique(available);
    if (!model) return [];
    if (model.auto) return all;
    return all.filter(function (v) { return model.views.indexOf(v) !== -1; });
}

/** Edit a model's views (it stops being `auto`). */
export function setModelViews(model, views, allViews) {
    model.views = orderedViews(views, allViews);
    model.auto = false;
}

/** Add `view` to the model or take it out. */
export function toggleModelView(model, view, allViews) {
    const cur = modelViews(model, allViews).concat(model.auto ? [] : model.views);
    const has = cur.indexOf(view) !== -1;
    setModelViews(model, has ? cur.filter(function (v) { return v !== view; }) : cur.concat([view]), allViews);
}

export function addModelViews(model, views, allViews) {
    setModelViews(model, modelViews(model, allViews).concat(model.auto ? [] : model.views).concat(views || []), allViews);
}

export function removeModelViews(model, views, allViews) {
    const drop = unique(views);
    const cur = modelViews(model, allViews).concat(model.auto ? [] : model.views);
    setModelViews(model, cur.filter(function (v) { return drop.indexOf(v) === -1; }), allViews);
}

/** The models (in list order) that `view` trains. */
export function modelsOfView(models, view, available) {
    return (models || []).filter(function (m) { return modelViews(m, available).indexOf(view) !== -1; });
}

/**
 * The word a view's name groups by: its last part (after `_`, `-`, `.` or a space) without a trailing
 * letter-or-digit suffix, lower case: `Camera1_topB` → `top`, `Camera6_sideC` → `side`, `back2` → `back`.
 */
export function viewToken(view) {
    const parts = String(view == null ? '' : view).split(/[_\-.\s]+/).filter(Boolean);
    const last = parts.length ? parts[parts.length - 1] : '';
    const stem = last.replace(/(?:[A-Z]+|\d+)$/, '').replace(/(?:[A-Z]+|\d+)$/, '');
    return (stem || last).toLowerCase();
}

/** The distinct name tokens of `views`, in view order (one token = nothing to group by). */
export function viewTokens(views) {
    return unique(unique(views).map(viewToken));
}

/**
 * The quick splits of the modal's "Start from" row: one model for all views, one per view, or one per
 * name token ("By name": mid · top · side). Each is `{name, views, auto?}`.
 * @param {'all'|'perview'|'name'} kind
 */
export function splitViews(kind, views) {
    const list = unique(views);
    if (!list.length) return [];
    if (kind === 'perview') return list.map(function (v) { return { name: v, views: [v] }; });
    if (kind === 'name') {
        return viewTokens(list).map(function (t) {
            return { name: t.charAt(0).toUpperCase() + t.slice(1) + ' views', views: list.filter(function (v) { return viewToken(v) === t; }) };
        });
    }
    return [{ name: ALL_VIEWS_NAME, views: list, auto: true }];
}

/**
 * What stands in the way, among `available` views: views in no model (they train nothing) and models
 * with no view (they cannot train).
 */
export function modelProblems(models, available) {
    const all = unique(available);
    return {
        unused: all.filter(function (v) { return !modelsOfView(models, v, all).length; }),
        empty: (models || []).filter(function (m) { return !modelViews(m, all).length; }),
    };
}

/**
 * The model whose predictions a view gets after training: `prefs[view]` (a model id) when that model trains
 * the view, else its model with the fewest views (the most specific), the first in the list on a tie.
 */
export function inferenceModelOf(models, view, prefs, available) {
    const ms = modelsOfView(models, view, available);
    if (!ms.length) return null;
    const want = prefs && prefs[view];
    const picked = want ? ms.find(function (m) { return m.id === want; }) : null;
    if (picked) return picked;
    return ms.reduce(function (best, m) {
        return modelViews(m, available).length < modelViews(best, available).length ? m : best;
    });
}

/** A progress row's label: "Centroid" for a run of one model, "Centroid · Top views" for several. */
export function modelRunLabel(headLabel, model, multi) {
    return multi && model ? headLabel + ' · ' + model.name : headLabel;
}

/**
 * A file/folder-safe part: letters, digits, `_`, `-`, `.`; anything else becomes `_`.
 * Never empty, never `.`/`..`.
 */
export function safeRunPart(s) {
    const out = String(s == null ? '' : s).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '_');
    return out === '' ? '_' : out;
}

/**
 * The run name of one model's head.
 * @param {{timestamp: string, head: string, model?: {name: string}|null, multi?: boolean, nFrames?: number|null}} o
 * @returns {string} e.g. `251123_142211.centroid.n=168`, `251123_142211.centered_instance.Top_views.n=500`
 */
export function trainingRunName(o) {
    const parts = [safeRunPart(o.timestamp), safeRunPart(o.head)];
    if (o.multi && o.model) parts.push(safeRunPart(o.model.name));
    let name = parts.join('.');
    if (o.nFrames != null && Number.isFinite(o.nFrames)) name += '.n=' + Math.max(0, Math.floor(o.nFrames));
    return name;
}

/**
 * Each model's part of its run names, unique across the run: two models whose names make the same safe part
 * ("Top views" and "Top_views", or two names of non-ASCII letters, both `_`) get `_2`, `_3`, … after the first,
 * or their runs would share a name (Rust refuses a run name that exists).
 * @param {{id: string, name: string}[]} models in run order
 * @returns {Map<string, string>} model id -> run part
 */
export function uniqueRunParts(models) {
    const out = new Map();
    const used = new Set();
    (models || []).forEach(function (m) {
        const base = safeRunPart(m.name);
        let part = base;
        for (let n = 2; used.has(part.toLowerCase()); n++) part = base + '_' + n;
        used.add(part.toLowerCase());
        out.set(m.id, part);
    });
    return out;
}

/** Characters a run name may hold (Rust refuses anything else, src-tauri training_prepare). */
export const RUN_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.=-]{0,199}$/;
