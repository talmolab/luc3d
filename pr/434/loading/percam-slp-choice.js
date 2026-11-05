// percam-slp-choice.js — which `.slp` a camera directory is loaded from, and
// what File ▸ Export SLEAP File By Cam names its proofread file next to it.
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
 * Pick the ONE `.slp` a camera directory should be loaded from.
 *
 * A camera dir accumulates successive exports (`<stem>_v1.slp`,
 * `<stem>_v2.slp`, …) — "Export SLEAP File By Cam" writes `_v<N+1>` every time
 * — and parsing all of them stacks every version's instances into the same
 * (frame, camera) slot. The rule is the highest `_vN`, with an unversioned name
 * counting as 0.
 *
 * Two things this adds over a bare max():
 *
 *  - **`lastModified` breaks a tie.** Two files at the same version used to be
 *    resolved by folder-enumeration order, which is arbitrary.
 *  - **It reports when the version suffix disagrees with the disk.** The
 *    suffix is a naming convention, not a fact: writing fresh annotations to
 *    the UNVERSIONED name while an older `_v1` export is still in the directory
 *    — which is what "replacing the .slp file" means when the original had no
 *    suffix — makes the stale file win. The version rule is deliberately left
 *    intact (mtime survives neither copying nor syncing reliably, so it must
 *    not decide), but the caller can now say so instead of logging a line that
 *    calls the stale file "highest version".
 *
 * Pure — no DOM, no app state — so `tests/test-percam-slp-choice.js` can
 * exercise it directly.
 *
 * @param {Array<{name: string, lastModified?: number}>} slps - one dir's `.slp` files, non-empty
 * @returns {{file: Object, version: number, newer: Object|null}} `newer` is the
 *   most-recently-modified candidate when it is NOT the chosen one, else null.
 */
export function chooseCameraSlp(slps) {
    var versionOf = function (f) {
        var stem = f.name.replace(/\.[^.]+$/, '');
        var m = stem.match(/_(?:3D_)?v(\d+)$/);
        return m ? parseInt(m[1]) : 0;
    };
    var mtimeOf = function (f) {
        return typeof f.lastModified === 'number' ? f.lastModified : 0;
    };

    var best = slps[0];
    var bestVersion = versionOf(slps[0]);
    for (var i = 1; i < slps.length; i++) {
        var v = versionOf(slps[i]);
        if (v > bestVersion || (v === bestVersion && mtimeOf(slps[i]) > mtimeOf(best))) {
            best = slps[i];
            bestVersion = v;
        }
    }

    // Strictly newer, so an equal timestamp (common when a whole folder is
    // copied at once) never raises a warning nobody can act on.
    var newest = null;
    for (var j = 0; j < slps.length; j++) {
        if (slps[j] === best) continue;
        if (mtimeOf(slps[j]) > mtimeOf(best) && (!newest || mtimeOf(slps[j]) > mtimeOf(newest))) {
            newest = slps[j];
        }
    }

    return { file: best, version: bestVersion, newer: newest };
}

/** Appended to a camera's source `.slp` stem by File ▸ Export SLEAP File By Cam. */
export var PROOFREAD_SUFFIX = '_proofread';

/** True for a name By Cam wrote (`<stem>_proofread.slp`), which is never a source. */
export function isProofreadSlp(name) {
    return /_proofread\.slp$/i.test(String(name || ''));
}

/**
 * The name By Cam writes next to a camera's source `.slp`:
 * `21241563-20260921105806_nn.slp` → `21241563-20260921105806_nn_proofread.slp`.
 * @param {string} sourceName  a file name (or a video name, when the camera has no `.slp`)
 * @returns {string}
 */
export function proofreadSlpName(sourceName) {
    var stem = String(sourceName).replace(/\.[^.\/]+$/, '');
    return stem + PROOFREAD_SUFFIX + '.slp';
}

/**
 * Which `.slp` in a camera folder the project's 2D came from, for naming the
 * proofread export. Our own `_proofread` outputs never count. The file the
 * folder load recorded (`loadedName`, `videoFiles[].slpFilename`) wins when it is
 * still there; otherwise the loader's own rule (`chooseCameraSlp`), so an
 * unchanged folder gives the file the project was built from.
 * @param {Array<{name: string, lastModified?: number}>} slps  the folder's `.slp` files
 * @param {?string} [loadedName]
 * @returns {?Object}  one of `slps`, or null when there is no candidate
 */
export function chooseProofreadSource(slps, loadedName) {
    var cands = (slps || []).filter(function (f) { return !isProofreadSlp(f.name); });
    if (cands.length === 0) return null;
    if (loadedName) {
        for (var i = 0; i < cands.length; i++) if (cands[i].name === loadedName) return cands[i];
    }
    return chooseCameraSlp(cands).file;
}
