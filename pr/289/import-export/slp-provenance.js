/**
 * slp-provenance.js — keep a loaded .slp's provenance through LUC3D's saves.
 *
 * An .slp carries a free-form `provenance` dict (in the `metadata` json). Other
 * programs keep real records there — campy-live-export (olinesn/campy,
 * `campy/liveexport.py` `Provenance()`) stores the recording's session.json,
 * its campy-live-session.json, `animalIds` and `calibrationDiffers` — so a
 * LUC3D save must not replace it. The loaders keep each session's provenance on
 * `session.fileProvenance` (in memory only; never in `metadata.lucid`), and the
 * project savers write `buildSaveProvenance(sessions)`.
 *
 * Rules:
 *  - Every key the file had is written back unchanged.
 *  - LUC3D's own pair is `source: 'lucid'` + `exported_at`, refreshed on each
 *    save. It only ever replaces LUC3D's own earlier pair: when another program
 *    already wrote a `source` or `exported_at`, those stay and LUC3D's pair goes
 *    under `lucid` instead.
 *  - A project whose sessions came from different files: the first session with
 *    a provenance gives the top level; every session whose provenance differs
 *    from it is kept whole under `lucid_sessions`, by session name (`{}` = it
 *    had none), and goes back to that session on reopen.
 *  - No session with a provenance → exactly `{ source, exported_at }`, the
 *    provenance LUC3D always wrote (`tests/e2e/save-golden-digest.mjs`).
 *  - The 2D exports (one camera, multi-session export) do not use this: they
 *    are new files and keep `{ source, exported_at }`.
 *
 * DOM-free (tests: `tests/test-slp-provenance.mjs`).
 */

export const LUCID_PROVENANCE_SOURCE = 'lucid';
/** Where LUC3D's pair goes when another program owns `source`/`exported_at`. */
export const LUCID_PROVENANCE_KEY = 'lucid';
/** Per-session provenances that differ from the top level, by session name. */
export const PROVENANCE_SESSIONS_KEY = 'lucid_sessions';

// 'mv-gui' is LUC3D's earlier name (the JSON export still writes it).
var LUCID_SOURCES = [LUCID_PROVENANCE_SOURCE, 'mv-gui'];

function isPlainObject(v) {
    return v != null && typeof v === 'object' && !Array.isArray(v);
}

function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
}

function isLucidPair(v) {
    return isPlainObject(v) && LUCID_SOURCES.indexOf(v.source) >= 0;
}

/**
 * The part of a provenance dict that is not LUC3D's own bookkeeping (its
 * `source`/`exported_at` pair, a `lucid` pair, `lucid_sessions`), as a deep
 * copy. Null when nothing else is left or `prov` is not a dict.
 * @param {*} prov
 * @returns {Object|null}
 */
export function foreignProvenance(prov) {
    if (!isPlainObject(prov)) return null;
    var lucidTop = LUCID_SOURCES.indexOf(prov.source) >= 0;
    var out = {};
    var n = 0;
    for (var k in prov) {
        if (!hasOwn(prov, k)) continue;
        if (k === PROVENANCE_SESSIONS_KEY) continue;
        if (k === LUCID_PROVENANCE_KEY && isLucidPair(prov[k])) continue;
        if (lucidTop && (k === 'source' || k === 'exported_at')) continue;
        out[k] = prov[k];
        n++;
    }
    // A JSON copy: provenance came from JSON and goes back to JSON, and no
    // session may share (and so edit) another's dict.
    return n ? JSON.parse(JSON.stringify(out)) : null;
}

/**
 * The `lucid_sessions` key of each session, in order: its name, and for a
 * repeated name `name #2`, `name #3`, ... (skipping any taken). The writer and
 * the reader both walk sessions in file order, so they agree.
 * @param {Array<string|null|undefined>} names
 * @returns {string[]}
 */
export function provenanceSessionKeys(names) {
    var used = Object.create(null);
    var out = [];
    for (var i = 0; i < names.length; i++) {
        var base = names[i] == null ? '' : String(names[i]);
        var key = base;
        for (var n = 2; used[key]; n++) key = base + ' #' + n;
        used[key] = true;
        out.push(key);
    }
    return out;
}

/**
 * The session names the writer keyed `lucid_sessions` by, from a file's raw
 * `sessions_json` dicts (`metadata.lucid.sessionName`, which LUC3D writes from
 * `session.name`).
 * @param {Array<Object>} rawSessions
 * @returns {string[]}
 */
export function fileSessionNames(rawSessions) {
    return (rawSessions || []).map(function (s) {
        var lucid = s && s.metadata && s.metadata.lucid;
        return (lucid && lucid.sessionName) || '';
    });
}

/**
 * The provenance one session of a loaded file keeps (`session.fileProvenance`).
 * @param {Object|null|undefined} fileProv - the file's whole provenance dict
 * @param {string[]} names - `fileSessionNames` of the file's sessions
 * @param {number} index - this session's index in the file (a file with no
 *   sessions_json still gives one session: index 0, no names)
 * @returns {Object|null}
 */
export function fileSessionProvenance(fileProv, names, index) {
    if (!isPlainObject(fileProv)) return null;
    var per = fileProv[PROVENANCE_SESSIONS_KEY];
    if (isPlainObject(per) && index < names.length) {
        var key = provenanceSessionKeys(names)[index];
        if (hasOwn(per, key)) return foreignProvenance(per[key]);
    }
    return foreignProvenance(fileProv);
}

/**
 * The provenance a project save writes.
 * @param {Array<{name:string, fileProvenance:(Object|null)}>} sessions - in save order
 * @param {string} [exportedAt] - ISO time (default now)
 * @returns {Object}
 */
export function buildSaveProvenance(sessions, exportedAt) {
    var at = exportedAt || new Date().toISOString();
    var list = sessions || [];
    var provs = list.map(function (s) { return foreignProvenance(s && s.fileProvenance); });
    var top = null;
    for (var i = 0; i < provs.length && !top; i++) top = provs[i];
    if (!top) return { source: LUCID_PROVENANCE_SOURCE, exported_at: at };

    var topJson = JSON.stringify(top);
    var keys = provenanceSessionKeys(list.map(function (s) { return s && s.name; }));
    var per = null;
    for (var j = 0; j < provs.length; j++) {
        if (JSON.stringify(provs[j]) === topJson) continue;
        if (!per) per = {};
        per[keys[j]] = provs[j] || {};
    }

    var out = JSON.parse(topJson);
    var pair = { source: LUCID_PROVENANCE_SOURCE, exported_at: at };
    if (hasOwn(out, 'source') || hasOwn(out, 'exported_at')) out[LUCID_PROVENANCE_KEY] = pair;
    else { out.source = pair.source; out.exported_at = pair.exported_at; }
    if (per) out[PROVENANCE_SESSIONS_KEY] = per;
    return out;
}
