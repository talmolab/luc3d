/**
 * recording-folder.js — remember which folder a recording was opened from, so
 * File ▸ Save opens there.
 *
 * Without `startIn`, Chromium's save picker opens wherever any picker of this
 * origin last picked: after saving recording A, saving recording B opened in A's
 * folder, and B's labels were saved there. A folder picked with
 * `<input webkitdirectory>` gives the page File objects only, never the folder,
 * so the session folder loaders pick with `showDirectoryPicker` when the browser
 * has it (`pickRecordingFolder`) and keep the folder's handle on the session
 * (`session._recordingFolder`, in memory only: never written to the `.slp`).
 * `saveStartFolder` hands it to the save picker as `startIn`.
 *
 * Browsers without a READABLE `showDirectoryPicker` (Firefox, Safari, Brave with
 * the File System Access API off, Playwright's headless shell, the desktop app's
 * WebKit webviews) still pick through
 * `<input webkitdirectory>`, and Save opens where the browser chooses.
 */

import { canReadDirectoryHandles } from '../ui/browser-hints.js?v=69999949ab05';

/** The folder loaders' own picker memory: the next recording is usually beside the last one. */
export var RECORDING_FOLDER_PICKER_ID = 'lucid-recording-folder';

/**
 * Recursively enumerate all files under a FileSystemDirectoryHandle.
 * Returns File objects with webkitRelativePath set to rootName/relative/path,
 * as `<input webkitdirectory>` gives them.
 */
export async function enumerateDirectoryHandle(dirHandle, rootName, prefix) {
    var files = [];
    for await (var [name, handle] of dirHandle) {
        if (handle.kind === 'file') {
            var file = await handle.getFile();
            var relPath = prefix ? prefix + '/' + name : rootName + '/' + name;
            var wrappedFile = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
            Object.defineProperty(wrappedFile, 'webkitRelativePath', { value: relPath });
            files.push(wrappedFile);
        } else if (handle.kind === 'directory') {
            var subPrefix = prefix ? prefix + '/' + name : rootName + '/' + name;
            var subFiles = await enumerateDirectoryHandle(handle, rootName, subPrefix);
            files = files.concat(subFiles);
        }
    }
    return files;
}

/**
 * Whether to pick with `showDirectoryPicker`. An AUTOMATED browser
 * (`navigator.webdriver`) keeps the folder input while its picker is the
 * browser's own: Playwright can fill an `<input>` (its file chooser) but cannot
 * answer the native folder dialog, and the e2e suites load folders that way. A
 * test that replaces `showDirectoryPicker` with a stub (not native code) gets
 * the picker path, as a person's browser does.
 */
function useDirectoryPicker() {
    // `canReadDirectoryHandles`, not `typeof showDirectoryPicker`: the desktop
    // app's WebKit webviews have a WRITE-only polyfill whose handles give no Files.
    if (typeof window === 'undefined' || !canReadDirectoryHandles()) return false;
    var automated = typeof navigator !== 'undefined' && navigator.webdriver === true;
    if (!automated) return true;
    try {
        return !/\[native code\]/.test(Function.prototype.toString.call(window.showDirectoryPicker));
    } catch (e) {
        return false;
    }
}

/**
 * Pick a recording folder. With `showDirectoryPicker`, returns its files (as
 * `pickFolder` would) and its handle; otherwise `fallbackPick()`'s files and no
 * handle. A cancelled pick returns no files.
 * @param {() => Promise<File[]>} fallbackPick  the `<input webkitdirectory>` picker
 * @returns {Promise<{files: File[], dirHandle: ?FileSystemDirectoryHandle}>}
 */
export async function pickRecordingFolder(fallbackPick) {
    if (!useDirectoryPicker()) return { files: await fallbackPick(), dirHandle: null };
    var dir;
    try {
        dir = await window.showDirectoryPicker({ id: RECORDING_FOLDER_PICKER_ID, mode: 'read' });
    } catch (e) {
        if (e && e.name === 'AbortError') return { files: [], dirHandle: null };
        throw e;
    }
    return { files: await enumerateDirectoryHandle(dir, dir.name, null), dirHandle: dir };
}

/**
 * Where the project save picker should open: the active session's recording
 * folder, else the folder of `previousFile` (the project file Save As is
 * replacing), else nowhere in particular (null: the browser decides).
 * @param {{session: ?Object}} appState
 * @param {?FileSystemFileHandle} [previousFile]
 * @returns {?FileSystemHandle}
 */
export function saveStartFolder(appState, previousFile) {
    var s = appState && appState.session;
    if (s && s._recordingFolder) return s._recordingFolder;
    // Only a real handle: a caller wired as an event listener passes an Event.
    return previousFile && previousFile.kind === 'file' ? previousFile : null;
}
