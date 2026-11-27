/**
 * The browser tab's title: "LUC3D" with nothing open, "<project> - LUC3D" once
 * a project is, and a leading "• " while there are unsaved changes.
 *
 * The project's name is the file it was opened from or last saved to (an .slp
 * or project .json), else the folder it was loaded from. Loaders that START a
 * project call `setPageProject`; ones that add a session to an open project
 * leave it alone. `markDirty` / `clearDirty` (import-export/save-load.js) call
 * `setPageDirty`. Import-free, so Node tests can load it.
 */

export const APP_TITLE = 'LUC3D';

var projectName = null;
var dirty = false;

/** The title for a project name (or none) and a dirty flag. */
export function formatPageTitle(name, isDirty) {
    var clean = typeof name === 'string' ? name.trim() : '';
    return (isDirty ? '• ' : '') + (clean ? clean + ' - ' + APP_TITLE : APP_TITLE);
}

/** Name the open project (null/empty: none) and retitle the tab. */
export function setPageProject(name) {
    projectName = typeof name === 'string' && name.trim() ? name.trim() : null;
    applyTitle();
}

/** The open project's name, or null. */
export function pageProjectName() {
    return projectName;
}

/** Note whether there are unsaved changes and retitle the tab. */
export function setPageDirty(isDirty) {
    dirty = !!isDirty;
    applyTitle();
}

function applyTitle() {
    if (typeof document !== 'undefined') document.title = formatPageTitle(projectName, dirty);
}
