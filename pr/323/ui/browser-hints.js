/**
 * browser-hints.js — browser-specific advice for features a browser has off.
 *
 * Brave ships the File System Access API (`showSaveFilePicker`,
 * `showDirectoryPicker`, `showOpenFilePicker`) DISABLED by default, while
 * reporting itself as Chrome. LUCID uses that API to stream large saves and
 * exports straight to disk and to enumerate multi-session folders, so in
 * Brave those features quietly degrade (in-memory download, which can crash
 * the tab on a large project) or refuse ("Use Chrome or Edge"). Measured with
 * Brave 1.96 (Chromium 154) on macOS: all three pickers are `undefined` by
 * default and present with `--enable-features=FileSystemAccessAPI`, the
 * feature behind brave://flags/#file-system-access-api ("File System Access API";
 * flag id confirmed in Brave 1.96's flags page).
 *
 * Other browsers without the API (Safari, Firefox) can't turn it on, so they
 * get no hint here — the existing generic messages stand.
 */

/** Whether this is Brave (it exposes `navigator.brave.isBrave`). */
export function isBrave() {
    try {
        return typeof navigator !== 'undefined' && !!navigator.brave &&
            typeof navigator.brave.isBrave === 'function';
    } catch (e) {
        return false;
    }
}

/** Whether the File System Access pickers are available. */
export function hasFileSystemAccess() {
    return typeof window !== 'undefined' &&
        typeof window.showSaveFilePicker === 'function' &&
        typeof window.showDirectoryPicker === 'function';
}

/**
 * How to turn the File System Access API back on — only in Brave with it off;
 * '' everywhere else (append-safe).
 * @returns {string}
 */
export function fileSystemAccessHint() {
    if (!isBrave() || hasFileSystemAccess()) return '';
    // brave:// URLs can't be opened from a web page, so the user pastes it.
    return 'Brave has the File System Access API turned off. To enable it, paste ' +
        'brave://flags/#file-system-access-api into the address bar, set "File System Access API" ' +
        'to Enabled and relaunch Brave — or use Chrome or Edge.';
}
