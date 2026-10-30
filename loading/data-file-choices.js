// data-file-choices.js — the per-camera data files a user picked in the
// chooser (`ui/data-file-chooser.js`), remembered in this browser (#413).
//
// "Save Options" stores, per session FOLDER (its name) and camera DIRECTORY,
// the file name that camera loads — or `null` for "None". The next load of a
// folder with that name uses the saved file without asking, as long as it is
// still there; a saved file that has gone missing brings the chooser back with
// that row marked. Files added to the folder later are deliberately ignored:
// the saved choice stands until the user changes it.
//
// Browser storage, not the session folder: the folder picker is read-only
// (`<input webkitdirectory>`). A project saved afterwards carries the choices
// too (`metadata.lucid.dataFileChoices`, import-export/visibility-metadata.js).
// Storage is best-effort — a private window or blocked site data throws on read
// and write, and that only means the chooser asks again.
//
// Imports nothing (no project modules, no DOM), so the browser test runner can
// load it.

/** The localStorage key. */
export var DATA_FILE_CHOICES_KEY = 'lucidDataFileChoices';

function defaultStorage() {
    try { return globalThis.localStorage || null; } catch (e) { return null; }
}

function readAll(storage) {
    var st = storage === undefined ? defaultStorage() : storage;
    if (!st) return {};
    try {
        var raw = st.getItem(DATA_FILE_CHOICES_KEY);
        var parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
        return {};
    }
}

/**
 * The saved choices for one session folder: `{ dirName: fileName | null }`,
 * or null when nothing is saved for it (or storage is unavailable).
 * @param {string} folderName
 * @param {Storage} [storage] - defaults to `localStorage`
 * @returns {Object|null}
 */
export function savedDataFileChoices(folderName, storage) {
    if (!folderName) return null;
    var all = readAll(storage);
    var entry = all[folderName];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    var out = {};
    var n = 0;
    for (var k in entry) {
        if (!Object.prototype.hasOwnProperty.call(entry, k)) continue;
        var v = entry[k];
        if (v === null || typeof v === 'string') { out[k] = v; n++; }
    }
    return n ? out : null;
}

/**
 * Merge `entries` (`{ dirName: fileName | null }`) into the saved choices for a
 * session folder. Other folders, and other directories of this folder, keep
 * what they had.
 * @returns {boolean} whether it was written
 */
export function saveDataFileChoices(folderName, entries, storage) {
    if (!folderName || !entries) return false;
    var st = storage === undefined ? defaultStorage() : storage;
    if (!st) return false;
    try {
        var all = readAll(st);
        var cur = all[folderName] && typeof all[folderName] === 'object' ? all[folderName] : {};
        for (var k in entries) {
            if (!Object.prototype.hasOwnProperty.call(entries, k)) continue;
            var v = entries[k];
            if (v === null || typeof v === 'string') cur[k] = v;
        }
        all[folderName] = cur;
        st.setItem(DATA_FILE_CHOICES_KEY, JSON.stringify(all));
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * What a saved entry means for one camera directory, given the files it holds
 * now: `{ state: 'none' }` (nothing saved), `{ state: 'use', file }` (the saved
 * file — or `file: null` for a saved "None"), or `{ state: 'missing', name }`
 * (saved, but no longer in the folder).
 * @param {Object|null} saved - `savedDataFileChoices(...)`
 * @param {string} dirName
 * @param {Array<{name: string}>} files
 */
export function applySavedChoice(saved, dirName, files) {
    if (!saved || !Object.prototype.hasOwnProperty.call(saved, dirName)) return { state: 'none' };
    var name = saved[dirName];
    if (name === null) return { state: 'use', file: null };
    for (var i = 0; i < files.length; i++) {
        if (files[i].name === name) return { state: 'use', file: files[i] };
    }
    return { state: 'missing', name: name };
}
