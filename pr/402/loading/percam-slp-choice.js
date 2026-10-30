// percam-slp-choice.js — which `.slp` a camera directory is loaded from.
//
// Extracted from `loading/session-loader.js` for the same reason
// `import-export/import-track-resolve.js` was: session-loader pulls app.js
// through its import graph, so it cannot be bridged into
// `tests/test-runner.html`, and this rule is worth exercising in the fast
// browser suite rather than only through a full folder load. This module
// imports NOTHING — no project modules, no DOM.
//
// session-loader re-exports `chooseCameraSlp` so its import site is unchanged.

/**
 * Pick the ONE `.slp` a camera directory should be loaded from. Parsing all of
 * them would stack every file's instances into the same (frame, camera) slot.
 *
 * **When LUC3D wrote any of the candidates, the one it wrote LAST wins** —
 * ordered by the `exported_at` LUC3D stamps inside every file it writes
 * (`opts.exportedAt`, read by the caller: `lucidExportedAt`). That stamp
 * travels with the file, so a copied or synced folder keeps its order, which
 * the filesystem's `lastModified` does not. It is what "the file I just
 * exported" means, whatever the file is called.
 *
 * **Otherwise the highest `_vN` wins**, an unversioned name counting as 0, and
 * `lastModified` breaks a same-version tie (folder enumeration order is
 * arbitrary). This is the whole rule for folders holding only files other
 * programs wrote — SLEAP's `*.predictions.slp` beside its `*.analysis.h5`, say.
 *
 * Why the stamp and not the suffix (#214): the suffix is a naming convention
 * only one of LUC3D's two exporters follows. "Export SLEAP File By Cam" writes
 * `<camera>.slp`, so a fresh By-Cam export dropped back into a camera directory
 * lost to any `_v1` already there — every view reloaded stale data, and a
 * camera whose leftover `_v1` was empty came back blank.
 *
 * A file is counted as LUC3D's only when its stamp parses; a file the caller
 * could not read, or did not ask about, simply takes part under the suffix
 * rule. Among LUC3D's files a stamp tie (same millisecond) falls back to the
 * version, then `lastModified`.
 *
 * `newer` is the candidate that looks more recently written but is NOT being
 * loaded, so the loader can say so. Under the suffix rule that is the
 * most-recently-modified other file. When the stamp decided, only files that
 * are NOT LUC3D's can be `newer`: another LUC3D file's `lastModified` is
 * overruled by its own stamp, but a file another program wrote after the
 * chosen export (a re-run of inference, say) still deserves a mention.
 *
 * Pure — no DOM, no app state — so `tests/test-percam-slp-choice.js` can
 * exercise it directly.
 *
 * @param {Array<{name: string, lastModified?: number}>} slps - one dir's `.slp` files, non-empty
 * @param {{exportedAt?: (file: Object) => number}} [opts] - when LUC3D wrote a
 *   candidate, in ms; NaN (or absent) for a file it did not write
 * @returns {{file: Object, version: number, newer: Object|null,
 *            by: 'exported'|'version', versionPick: Object}}
 *   `by` says which rule decided; `versionPick` is what the suffix rule alone
 *   would have chosen (the same object as `file` unless the stamp overruled it).
 */
export function chooseCameraSlp(slps, opts) {
    var versionOf = function (f) {
        var stem = f.name.replace(/\.[^.]+$/, '');
        var m = stem.match(/_(?:3D_)?v(\d+)$/);
        return m ? parseInt(m[1]) : 0;
    };
    var mtimeOf = function (f) {
        return typeof f.lastModified === 'number' ? f.lastModified : 0;
    };
    var stampFn = opts && typeof opts.exportedAt === 'function' ? opts.exportedAt : null;
    var stampOf = function (f) {
        var t = stampFn ? stampFn(f) : NaN;
        return typeof t === 'number' && isFinite(t) ? t : NaN;
    };

    // The suffix rule: highest `_vN`, then newest `lastModified`, first-wins.
    var versionPick = slps[0];
    var pickVersion = versionOf(slps[0]);
    for (var i = 1; i < slps.length; i++) {
        var v = versionOf(slps[i]);
        if (v > pickVersion || (v === pickVersion && mtimeOf(slps[i]) > mtimeOf(versionPick))) {
            versionPick = slps[i];
            pickVersion = v;
        }
    }

    // The stamp rule, over LUC3D's own files only.
    var stamped = null;
    for (var k = 0; k < slps.length; k++) {
        var t = stampOf(slps[k]);
        if (!(t === t)) continue;                        // NaN: not LUC3D's
        if (!stamped) { stamped = slps[k]; continue; }
        var ts = stampOf(stamped);
        if (t > ts) { stamped = slps[k]; continue; }
        if (t < ts) continue;
        var vk = versionOf(slps[k]), vs = versionOf(stamped);
        if (vk > vs || (vk === vs && mtimeOf(slps[k]) > mtimeOf(stamped))) stamped = slps[k];
    }

    var best = stamped || versionPick;
    var by = stamped ? 'exported' : 'version';

    // Strictly newer, so an equal timestamp (common when a whole folder is
    // copied at once) never raises a warning nobody can act on.
    var newest = null;
    for (var j = 0; j < slps.length; j++) {
        if (slps[j] === best) continue;
        if (by === 'exported' && stampOf(slps[j]) === stampOf(slps[j])) continue;   // LUC3D's: stamp already ranked it
        if (mtimeOf(slps[j]) > mtimeOf(best) && (!newest || mtimeOf(slps[j]) > mtimeOf(newest))) {
            newest = slps[j];
        }
    }

    return { file: best, version: versionOf(best), newer: newest, by: by, versionPick: versionPick };
}

// ---------------------------------------------------------------------------
// Which file to load, and whether to ASK (#413 / #414)
// ---------------------------------------------------------------------------
//
// A camera folder can hold many data files: SLEAP's `*.predictions.slp`, a
// proofread `*.predictions.proofread.slp`, analysis `*.h5` exports of either,
// `*.reprojections.slp`, and LUC3D's own exports. Guessing among them by name
// or by date loaded reprojections into every view of a real SLAP-2M session
// (#413). The rule now loads a file without asking only when there is nothing
// to decide:
//
//   1. One data file → load it (`.slp` or `.h5`).
//   2. Only `.slp` files, at least one exported by LUC3D, and the newest LUC3D
//      export (by its stamp, `chooseCameraSlp`'s rule, #214) is also the newest
//      file on disk (ties allowed: a folder copied in one go) → load it.
//
// Everything else — several files with no LUC3D export among them, a NEWER
// `.slp` beside the newest LUC3D export (from the SLEAP GUI or sleap-nn, or a
// SLEAP re-save of an older export, which keeps that export's stamp), or any
// mix of `.slp` and `.h5` — is the user's call: the loader shows the chooser
// (`ui/data-file-chooser.js`) with a default picked by `DATA_FILE_KIND_RANK`.
//
// An `.h5` named after an `.slp` in the same folder (`X.slp.analysis.h5`,
// `X.slp.h5`) is SLEAP's export OF that `.slp`, the same poses again, so it
// does not count as a competitor. It is still listed in the chooser.

/** How the chooser orders a folder's files, best first (and so its default). */
export var DATA_FILE_KIND_RANK = {
    'lucid-export': 0,
    'proofread': 1,
    'predictions': 2,
    'slp': 3,
    'analysis-h5': 4,
    'reprojections': 8,
    'derived': 9,
};

function _lower(f) { return String(f && f.name || '').toLowerCase(); }
function _isSlp(f) { return /\.slp$/.test(_lower(f)); }
function _mtime(f) { return typeof f.lastModified === 'number' ? f.lastModified : 0; }
function _version(f) {
    var m = String(f.name).replace(/\.[^.]+$/, '').match(/_(?:3D_)?v(\d+)$/);
    return m ? parseInt(m[1]) : 0;
}

/**
 * The `.slp` an `.h5` was exported from, by SLEAP's naming (`X.slp.analysis.h5`,
 * `X.slp.h5`): the name of a `.slp` in `slpNames` that this file's name starts
 * with, followed by a dot. Null for anything else.
 * @param {string} name
 * @param {string[]} slpNames
 * @returns {string|null}
 */
export function derivedFromSlp(name, slpNames) {
    var lower = String(name).toLowerCase();
    if (!/\.h5$/.test(lower)) return null;
    for (var i = 0; i < slpNames.length; i++) {
        var s = String(slpNames[i]).toLowerCase();
        if (/\.slp$/.test(s) && lower.indexOf(s + '.') === 0) return slpNames[i];
    }
    return null;
}

/**
 * What a data file is, for ranking and for the chooser's label.
 * @returns {'lucid-export'|'proofread'|'predictions'|'slp'|'analysis-h5'|'reprojections'|'derived'}
 */
export function dataFileKind(name, isLucidExport, derivedFrom) {
    if (isLucidExport) return 'lucid-export';
    if (derivedFrom) return 'derived';
    var lower = String(name).toLowerCase();
    if (lower.indexOf('reprojection') >= 0) return 'reprojections';
    if (!/\.slp$/.test(lower)) return 'analysis-h5';
    if (lower.indexOf('proofread') >= 0) return 'proofread';
    if (lower.indexOf('predictions') >= 0) return 'predictions';
    return 'slp';
}

/**
 * Decide one camera folder's data file — or that the user must.
 *
 * @param {Array<{name: string, lastModified?: number}>} files - the folder's
 *   `.slp`/`.h5` files (environment `.externals.` files excluded by the caller)
 * @param {{exportedAt?: (file: Object) => number}} [opts] - when LUC3D wrote a
 *   `.slp` (ms; NaN when it did not, or was not asked)
 * @returns {{auto: Object|null, needsChoice: boolean, reason: string,
 *            defaultFile: Object|null,
 *            options: Array<{file: Object, kind: string, derivedFrom: string|null,
 *                            exportedAt: number}>}}
 *   `auto` is the file to load without asking (null when there is none or the
 *   user must choose); `defaultFile` is the chooser's pre-selection (== `auto`
 *   when there is one); `options` are every file, best first. `reason` is one of
 *   'none', 'single', 'newest-export', 'newer-than-export', 'several-slp',
 *   'several-files'.
 */
export function planCameraDataFile(files, opts) {
    var stampFn = opts && typeof opts.exportedAt === 'function' ? opts.exportedAt : null;
    var stampOf = function (f) {
        if (!stampFn || !_isSlp(f)) return NaN;
        var t = stampFn(f);
        return typeof t === 'number' && isFinite(t) ? t : NaN;
    };
    var slpNames = files.filter(_isSlp).map(function (f) { return f.name; });
    var options = files.map(function (f) {
        var t = stampOf(f);
        var from = derivedFromSlp(f.name, slpNames);
        return { file: f, kind: dataFileKind(f.name, t === t, from), derivedFrom: from, exportedAt: t };
    });
    options.sort(function (a, b) {
        var r = DATA_FILE_KIND_RANK[a.kind] - DATA_FILE_KIND_RANK[b.kind];
        if (r) return r;
        var ta = a.exportedAt === a.exportedAt ? a.exportedAt : -Infinity;
        var tb = b.exportedAt === b.exportedAt ? b.exportedAt : -Infinity;
        if (ta !== tb) return tb - ta;
        var v = _version(b.file) - _version(a.file);
        if (v) return v;
        var m = _mtime(b.file) - _mtime(a.file);
        if (m) return m;
        return a.file.name < b.file.name ? -1 : a.file.name > b.file.name ? 1 : 0;
    });
    var out = function (auto, needsChoice, reason, def) {
        return { auto: auto, needsChoice: needsChoice, reason: reason,
                 defaultFile: def !== undefined ? def : auto, options: options };
    };

    if (files.length === 0) return out(null, false, 'none', null);
    var competing = options.filter(function (o) { return !o.derivedFrom; }).map(function (o) { return o.file; });
    if (competing.length === 1) return out(competing[0], false, 'single');

    var best = options[0].file;
    if (competing.every(_isSlp)) {
        var stamped = competing.filter(function (f) { var t = stampOf(f); return t === t; });
        if (stamped.length === 0) return out(null, true, 'several-slp', best);
        var newest = chooseCameraSlp(stamped, { exportedAt: stampOf }).file;
        // ANY other file newer on disk asks — a LUC3D-stamped one too: SLEAP
        // and sleap-io keep the provenance when they re-save a file, so a file
        // proofread in SLEAP from an older export still carries that export's
        // stamp. The stamp only picks the default; when disk order disagrees
        // with export order (that, or a sync that touched an old export), the
        // user says which.
        var newerElsewhere = competing.some(function (f) {
            return f !== newest && _mtime(f) > _mtime(newest);
        });
        if (newerElsewhere) return out(null, true, 'newer-than-export', newest);
        return out(newest, false, 'newest-export');
    }
    return out(null, true, 'several-files', best);
}
