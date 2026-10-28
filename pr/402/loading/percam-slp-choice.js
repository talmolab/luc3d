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
