/**
 * folder-picker-start.js — where a `showDirectoryPicker` opens.
 *
 * A page cannot read the folder around a file it was given, but it can open the
 * folder picker THERE: `showDirectoryPicker({ startIn: fileHandle })` opens in the
 * folder holding that file. The project's `.slp` handle is `state.slpFileHandle`
 * (Load Project, Load SLP and Save As keep it; it is the file File ▸ Save writes).
 *
 * Without `startIn` or `id`, Chromium opens wherever ANY picker of this origin
 * last picked (Load Project, Save As, an export, …), or Documents — so where an
 * export's folder picker opened depended on the browser's history, not on the
 * project. An `id` gives a picker its own memory; a `startIn` handle wins over it.
 *
 * Import-light (app-state only) so export modules can use it without a cycle
 * through `loading/session-loader.js`.
 */

import { state } from '../ui/app-state.js?v=4b5d39f5e9c5';

/** The by-camera export's own picker memory (used when there is no project file to start at). */
export var EXPORT_FOLDER_PICKER_ID = 'lucid-export-folder';

/**
 * The project's `.slp` handle, for `startIn`, when there is one and the browser
 * has `showDirectoryPicker`; else null.
 * @returns {?FileSystemFileHandle}
 */
export function projectFolderStart() {
    var h = state.slpFileHandle;
    if (!h || typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') return null;
    return h;
}

/**
 * Pick a folder to write an export into, opening in the project's folder
 * (`projectFolderStart`); without a project file, where the last export went
 * (`EXPORT_FOLDER_PICKER_ID`; Chromium's Documents the first time).
 * @returns {Promise<FileSystemDirectoryHandle>}  rejects with AbortError on cancel
 */
export function pickExportFolder() {
    var opts = { id: EXPORT_FOLDER_PICKER_ID, mode: 'readwrite' };
    var start = projectFolderStart();
    if (start) opts.startIn = start;
    return window.showDirectoryPicker(opts);
}
