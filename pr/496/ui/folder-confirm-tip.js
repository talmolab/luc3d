// ui/folder-confirm-tip.js — on a Mac, say how to confirm the browser's folder
// prompt from the keyboard, just before the folder picker opens.
//
// After a folder is picked, Chromium-based browsers (Chrome, Edge, Brave) ask a
// second time: "Upload N files to this site?" for `<input webkitdirectory>`,
// "Let site view files?" for `showDirectoryPicker`. Both are built with CANCEL
// as the initially focused AND the default button, plus input protection
// (chrome/browser/file_select_helper.cc and
// chrome/browser/ui/file_system_access/file_system_access_permission_dialog.cc),
// so that a stray Return can never upload a folder. No page can change that.
//
// On a Mac, Tab reaches the other button only when System Settings ▸ Keyboard ▸
// Keyboard navigation is on, which it is not by default; then Space presses it
// (Return still presses the default, Cancel). A user without the setting has to
// reach for the mouse at the end of every folder load.
//
// **The page cannot tell whether that setting is on.** No web API exposes it.
// So the tip goes to every Mac user of a Chromium browser, before each folder
// pick, until they tick "Don't show this again". That choice is browser-local
// display preference, the same class as the Visibility panel's global prefs —
// it never reaches the project.
//
// Chromium is recognised by `navigator.userAgentData`, which only Chromium-based
// browsers have. Safari and Firefox therefore never see the tip; neither was
// checked for a second prompt.
//
// An AUTOMATED browser (`navigator.webdriver`) never sees it either: nobody is
// there to read it, and the e2e suites run on Macs and drive these loaders —
// a modal waiting for a click would stall every one of them.
// `tests/e2e/folder-confirm-tip.mjs` clears the flag to test the tip itself.
//
// The tip GATES the picker rather than appearing beside it: once the picker is
// up, the browser's dialog is tab-modal and nothing on the page can be clicked,
// so a "Don't show again" there could not be used until the load was over. The
// Continue click (or Return) is fresh user activation, which the picker needs.

export const FOLDER_TIP_STORAGE_KEY = 'folderConfirmTipDismissed';

/**
 * Whether this is a Chromium-based browser on macOS.
 * @param {Navigator} [nav]
 * @returns {boolean}
 */
export function isChromiumOnMac(nav) {
    var n = nav || (typeof navigator !== 'undefined' ? navigator : null);
    try {
        return !!(n && n.userAgentData && n.userAgentData.platform === 'macOS');
    } catch (e) {
        return false;
    }
}

/**
 * Whether the user ticked "Don't show this again". Storage is best-effort: a
 * private window or blocked site data throws, and the tip then simply shows.
 * @param {Storage} [storage]
 * @returns {boolean}
 */
function isDismissed(storage) {
    try {
        var s = storage || window.localStorage;
        return s.getItem(FOLDER_TIP_STORAGE_KEY) === '1';
    } catch (e) {
        return false;
    }
}

function dismiss(storage) {
    try {
        var s = storage || window.localStorage;
        s.setItem(FOLDER_TIP_STORAGE_KEY, '1');
    } catch (e) { /* not remembered; the tip shows again next time */ }
}

/**
 * Whether the tip should be shown before a folder pick.
 * @param {Navigator} [nav]
 * @param {Storage} [storage]
 * @returns {boolean}
 */
export function shouldShowFolderConfirmTip(nav, storage) {
    var n = nav || (typeof navigator !== 'undefined' ? navigator : null);
    if (n && n.webdriver) return false;
    return isChromiumOnMac(n) && !isDismissed(storage);
}

/**
 * Show the tip. Resolves true on Continue (or Return), false on Cancel (or Esc).
 * @returns {Promise<boolean>}
 */
export function showFolderConfirmTip() {
    return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.className = 'plane-confirm-overlay';
        overlay.id = 'folderTipOverlay';

        var modal = document.createElement('div');
        modal.className = 'plane-confirm-modal folder-tip-modal';

        var h = document.createElement('h3');
        h.textContent = 'Tip: confirm the folder from the keyboard';
        modal.appendChild(h);

        var p1 = document.createElement('p');
        p1.className = 'plane-confirm-message';
        p1.textContent = 'After you pick the folder, your browser asks you to confirm. ' +
            'Its default button is Cancel, so Return cancels the load.';
        modal.appendChild(p1);

        var p2 = document.createElement('p');
        p2.className = 'plane-confirm-message';
        p2.id = 'folderTipHowTo';
        p2.appendChild(document.createTextNode('To confirm without the mouse, turn on '));
        var path = document.createElement('strong');
        path.textContent = 'System Settings ▸ Keyboard ▸ Keyboard navigation';
        p2.appendChild(path);
        p2.appendChild(document.createTextNode('. Then press '));
        var tab = document.createElement('kbd');
        tab.textContent = 'Tab';
        p2.appendChild(tab);
        p2.appendChild(document.createTextNode(' and '));
        var space = document.createElement('kbd');
        space.textContent = 'Space';
        p2.appendChild(space);
        p2.appendChild(document.createTextNode('.'));
        modal.appendChild(p2);

        var label = document.createElement('label');
        label.className = 'folder-tip-dontshow';
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.id = 'folderTipDontShow';
        label.appendChild(box);
        label.appendChild(document.createTextNode("Don't show this again"));
        modal.appendChild(label);

        var actions = document.createElement('div');
        actions.className = 'modal-actions';
        var cancel = document.createElement('button');
        cancel.id = 'btnFolderTipCancel';
        cancel.textContent = 'Cancel';
        var cont = document.createElement('button');
        cont.id = 'btnFolderTipContinue';
        cont.className = 'primary';
        cont.textContent = 'Continue';
        actions.appendChild(cancel);
        actions.appendChild(cont);
        modal.appendChild(actions);

        function close(result) {
            document.removeEventListener('keydown', onKey, true);
            if (box.checked) dismiss();
            if (overlay.parentNode) overlay.remove();
            resolve(result);
        }
        function onKey(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close(false);
            } else if (e.key === 'Enter') {
                // A focused button activates itself; anywhere else (the
                // checkbox, or nothing once a pointer click released focus)
                // Return means Continue — the opposite of the prompt this
                // tip is about.
                if (e.target && e.target.tagName === 'BUTTON' && modal.contains(e.target)) return;
                e.preventDefault();
                e.stopPropagation();
                close(true);
            }
        }
        cancel.addEventListener('click', function () { close(false); });
        cont.addEventListener('click', function () { close(true); });

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKey, true);
        cont.focus();
    });
}

/**
 * Await before opening a folder picker. Resolves true at once where the tip
 * does not apply; otherwise shows it.
 * @returns {Promise<boolean>} false when the user cancelled
 */
export function confirmFolderPick() {
    if (!shouldShowFolderConfirmTip()) return Promise.resolve(true);
    return showFolderConfirmTip();
}
