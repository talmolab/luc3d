/**
 * pose/training-groups.js — which camera views train which model (the Training panel's
 * "Models for views"), and the names of the runs that train them.
 *
 * DOM-free (Node tests: tests/test-training-groups.mjs).
 *
 * A group is a set of camera NAMES: a camera name stands for that camera in every session
 * (cam2 of session A and cam2 of session B are one view), as Inference ▸ Assign models…
 * maps models to views. Modes:
 *   - 'shared'  : one group, every view (one model for all views; the default);
 *   - 'perview' : one group per view (one model per camera, trained one after another).
 * A group has no model folders until its run ends; P5 turns finished groups into an
 * inference assignment (`ui/inference-model-assignment.js`).
 *
 * Run names follow sleap-app (`trainingStore.ts` `YYMMDD_HHMMSS.<head>.n=<N>`, N = user-labelled
 * frames) and add the view for a per-view group: `YYMMDD_HHMMSS.<head>.<view>.n=<N>`.
 */

export const TRAINING_GROUP_MODES = Object.freeze(['shared', 'perview']);
export const DEFAULT_GROUP_MODE = 'shared';

/** Same palette as the Inference panel's models (`MODEL_COLORS`), so a group keeps its colour there. */
export const GROUP_COLORS = Object.freeze(['#6fcf8f', '#f0a35e', '#5cc4ee', '#e284d6', '#e6d460', '#9b8cf2', '#f07f7f', '#7fe0c8']);

/**
 * The groups of `views` (camera names, in display order) for `mode`.
 * @param {string} mode 'shared' | 'perview'
 * @param {string[]} views
 * @returns {{id: string, name: string, views: string[], color: string}[]}
 */
export function trainingGroups(mode, views) {
    const list = uniqueNames(views);
    if (list.length === 0) return [];
    if (mode === 'perview') {
        return list.map(function (v, i) {
            return { id: 'view:' + v, name: v, views: [v], color: GROUP_COLORS[i % GROUP_COLORS.length] };
        });
    }
    return [{ id: 'all', name: 'all views', views: list, color: GROUP_COLORS[0] }];
}

function uniqueNames(views) {
    const out = [];
    (views || []).forEach(function (v) {
        const s = v == null ? '' : String(v);
        if (s !== '' && out.indexOf(s) === -1) out.push(s);
    });
    return out;
}

/** "Centroid · all views" / "Centroid · cam2": a progress row's model label. */
export function groupModelLabel(modelLabel, group) {
    return group ? modelLabel + ' · ' + group.name : modelLabel;
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
 * The run name of one model of one group.
 * @param {{timestamp: string, head: string, group?: {name: string, views: string[]}|null,
 *          mode?: string, nFrames?: number|null}} o
 * @returns {string} e.g. `251123_142211.centroid.n=168`, `251123_142211.centered_instance.cam2.n=69`
 */
export function trainingRunName(o) {
    const parts = [safeRunPart(o.timestamp), safeRunPart(o.head)];
    if (o.mode === 'perview' && o.group) parts.push(safeRunPart(o.group.name));
    let name = parts.join('.');
    if (o.nFrames != null && Number.isFinite(o.nFrames)) name += '.n=' + Math.max(0, Math.floor(o.nFrames));
    return name;
}

/** Characters a run name may hold (Rust refuses anything else, src-tauri training_prepare). */
export const RUN_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.=-]{0,199}$/;
