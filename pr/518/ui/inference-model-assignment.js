/**
 * ui/inference-model-assignment.js — which sleap-nn model each camera view runs
 * with (the Inference panel's "Models for each view" modal).
 *
 * A MODEL is one entry the user added: a list of model folders (one folder for
 * Bottom-Up / Single Animal; centroid + centered instance for Top-Down). Each
 * view has AT MOST ONE model, a model can serve any number of views, and a view
 * with no model is skipped at Run. Nothing is assigned until the user assigns
 * it (no fallback to "every view uses the first model").
 *
 * Plain data, no DOM and no imports, so Node tests load it directly
 * (tests/test-inference-model-assignment.mjs). The modal edits a COPY
 * (`cloneAssignment`) and the panel keeps the applied one.
 */

/** Model swatch colours (dark-UI friendly; cycles past the end). */
export const MODEL_COLORS = ['#6fcf8f', '#f0a35e', '#5cc4ee', '#e284d6', '#e6d460', '#9b8cf2', '#f07f7f', '#7fe0c8'];

/** An empty assignment: no models, no view has one. */
export function createAssignment() {
    return { models: [], byView: {}, nextId: 1 };
}

export function cloneAssignment(a) {
    return {
        models: a.models.map(function (m) { return { id: m.id, paths: m.paths.slice(), color: m.color }; }),
        byView: Object.assign({}, a.byView),
        nextId: a.nextId,
    };
}

/** The folder's last path component. */
export function folderName(p) {
    var parts = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || String(p || '');
}

/** A model's display name: its folder name(s), joined with " + ". */
export function modelLabel(m) {
    return m.paths.map(folderName).join(' + ');
}

export function modelById(a, id) {
    for (var i = 0; i < a.models.length; i++) if (a.models[i].id === id) return a.models[i];
    return null;
}

/**
 * Add a model made of `paths`. The same folder list twice is refused (returns
 * the existing model). Returns the model.
 */
export function addModel(a, paths) {
    var list = (paths || []).filter(Boolean);
    if (!list.length) return null;
    var key = list.join('\u0000');
    for (var i = 0; i < a.models.length; i++) if (a.models[i].paths.join('\u0000') === key) return a.models[i];
    var m = { id: 'model-' + a.nextId, paths: list.slice(), color: MODEL_COLORS[(a.nextId - 1) % MODEL_COLORS.length] };
    a.nextId++;
    a.models.push(m);
    return m;
}

/** Add one more folder to a model (Top-Down's second folder). No duplicates. */
export function addFolderToModel(a, id, path) {
    var m = modelById(a, id);
    if (!m || !path || m.paths.indexOf(path) !== -1) return false;
    m.paths.push(path);
    return true;
}

/** Remove a model; every view that used it goes back to no model. */
export function removeModel(a, id) {
    a.models = a.models.filter(function (m) { return m.id !== id; });
    Object.keys(a.byView).forEach(function (v) { if (a.byView[v] === id) delete a.byView[v]; });
}

/** Give `view` the model `id` (null / '' = no model). */
export function assignView(a, view, id) {
    if (id && modelById(a, id)) a.byView[view] = id;
    else delete a.byView[view];
}

/** Give every view in `views` the model `id` (null = no model). */
export function assignViews(a, views, id) {
    views.forEach(function (v) { assignView(a, v, id); });
}

/** Every view back to no model (the models stay). */
export function clearAssignments(a) { a.byView = {}; }

/** The model a view runs with, or null. */
export function modelOfView(a, view) {
    var id = a.byView[view];
    return id ? modelById(a, id) : null;
}

/** The views (of `views`, in that order) that use model `id`. */
export function viewsOfModel(a, id, views) {
    return views.filter(function (v) { return a.byView[v] === id; });
}

/** Forget assignments of views not in `views` (another session was opened). */
export function pruneViews(a, views) {
    Object.keys(a.byView).forEach(function (v) { if (views.indexOf(v) === -1) delete a.byView[v]; });
}

/**
 * `config.perViewModels` for a run: view -> its model's folders, for views that
 * have one. Views without a model are absent (planInferenceJobs skips them with
 * "no model").
 */
export function perViewModelPaths(a, views) {
    var out = {};
    views.forEach(function (v) {
        var m = modelOfView(a, v);
        if (m) out[v] = m.paths.slice();
    });
    return out;
}

/** Folder count a model needs for `pipeline` (Top-Down: 2, the rest: 1). */
export function foldersNeeded(pipeline) {
    return pipeline === 'top-down' || pipeline === 'top-down-id' ? 2 : 1;
}
