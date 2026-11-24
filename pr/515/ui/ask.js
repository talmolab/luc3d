// ui/ask.js — the ONE place LUCID asks the user a yes/no or text question.
//
// Why this exists: the macOS desktop app runs in WKWebView, and wry implements
// none of WKWebView's JavaScript dialog panels. There `window.confirm()` returns
// false and `window.prompt()` returns null AT ONCE, without showing anything,
// and `window.alert()` shows nothing. So every app question goes through these
// Promise-returning helpers instead (`tests/test-no-sync-dialogs.mjs` fails on
// a direct call anywhere else in app source).
//
// In a normal browser (no `window.lucidDesktop`) each helper is exactly the old
// native dialog — same text, same window — wrapped in `Promise.resolve`. The
// dialog still runs synchronously inside the caller's event handler; awaiting
// the result adds a microtask, never a task, so a caller that follows the
// answer with a user-activation-gated call (showSaveFilePicker) keeps the
// activation it had. On desktop the shim's pickers are native dialogs that need
// no activation.
//
// In the desktop app:
//   - askConfirm → `lucidDesktop.confirm(message, {title, okLabel, cancelLabel})`
//     (a native OK/Cancel dialog added by src-tauri/js/lucid-desktop.js). A shim
//     without it, or a failed native call, falls back to the in-app modal.
//   - askText / askAlert → a small in-app modal (the shared
//     `.multi-frame-modal` card): Enter submits, Esc cancels, the key listener
//     is removed on close.
//
// Exports: askConfirm, askText, askAlert, isDesktopShell.

/** True inside the desktop shell (src-tauri/js/lucid-desktop.js installed). */
export function isDesktopShell() {
    return typeof window !== 'undefined' && !!window.lucidDesktop;
}

/**
 * Ask an OK/Cancel question.
 * @param {string} message
 * @param {{title?: string, okLabel?: string, cancelLabel?: string}} [opts]
 *   Used by the desktop dialog only; the browser shows `message` alone, as before.
 * @returns {Promise<boolean>}
 */
export function askConfirm(message, opts) {
    opts = opts || {};
    if (!isDesktopShell()) {
        return Promise.resolve(!!window.confirm(message));
    }
    var ld = window.lucidDesktop;
    if (typeof ld.confirm === 'function') {
        var p;
        try { p = ld.confirm(message, opts); } catch (e) { p = Promise.reject(e); }
        return Promise.resolve(p).then(function (ok) { return ok === true; }, function (err) {
            console.warn('[ask] lucidDesktop.confirm failed; asking in-app instead:', err);
            return showAskModal({ kind: 'confirm', message: message, opts: opts });
        });
    }
    return showAskModal({ kind: 'confirm', message: message, opts: opts });
}

/**
 * Ask for a line of text (the `window.prompt` replacement).
 * @param {string} message
 * @param {string|number} [defaultValue]
 * @param {{title?: string, okLabel?: string, cancelLabel?: string}} [opts]
 * @returns {Promise<string|null>} the entered text, or null on cancel
 */
export function askText(message, defaultValue, opts) {
    if (!isDesktopShell()) {
        // Same argument list as before: `prompt(msg)` and `prompt(msg, undefined)`
        // both show an empty field.
        return Promise.resolve(window.prompt(message, defaultValue));
    }
    return showAskModal({ kind: 'text', message: message, defaultValue: defaultValue, opts: opts || {} });
}

/**
 * Tell the user something (the `window.alert` replacement).
 * @param {string} message
 * @param {{title?: string, okLabel?: string}} [opts]
 * @returns {Promise<void>} resolves once dismissed
 */
export function askAlert(message, opts) {
    if (!isDesktopShell()) {
        window.alert(message);
        return Promise.resolve();
    }
    return showAskModal({ kind: 'alert', message: message, opts: opts || {} }).then(function () {});
}

/**
 * The in-app dialog. kind 'confirm' → boolean, 'text' → string|null,
 * 'alert' → true. One card, one scroller (the card itself), Esc cancels,
 * Enter submits; the capture-phase key listener stops those two keys so a
 * modal underneath (or a global shortcut) does not also act on them.
 */
function showAskModal(spec) {
    return new Promise(function (resolve) {
        var opts = spec.opts || {};
        var isText = spec.kind === 'text';
        var isAlert = spec.kind === 'alert';

        var overlay = document.createElement('div');
        overlay.className = 'multi-frame-modal-overlay ask-modal-overlay';
        var modal = document.createElement('div');
        modal.className = 'multi-frame-modal ask-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        if (opts.title) {
            var h = document.createElement('h3');
            h.textContent = opts.title;
            modal.appendChild(h);
        }
        var msg = document.createElement('p');
        msg.className = 'ask-modal-message';
        msg.textContent = spec.message == null ? '' : String(spec.message);
        modal.appendChild(msg);

        var input = null;
        if (isText) {
            input = document.createElement('input');
            input.type = 'text';
            input.className = 'rename-name-input ask-modal-input';
            input.value = spec.defaultValue == null ? '' : String(spec.defaultValue);
            modal.appendChild(input);
        }

        var actions = document.createElement('div');
        actions.className = 'modal-actions';
        var cancelBtn = null;
        if (!isAlert) {
            cancelBtn = document.createElement('button');
            cancelBtn.className = 'ask-modal-cancel';
            cancelBtn.textContent = opts.cancelLabel || 'Cancel';
            actions.appendChild(cancelBtn);
        }
        var okBtn = document.createElement('button');
        okBtn.className = 'primary ask-modal-ok';
        okBtn.textContent = opts.okLabel || 'OK';
        actions.appendChild(okBtn);
        modal.appendChild(actions);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        var settled = false;
        function finish(value) {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            resolve(value);
        }
        function submit() {
            finish(isText ? input.value : true);
        }
        function cancel() {
            finish(isText ? null : (isAlert ? true : false));
        }
        function onKey(e) {
            if (e.key === 'Escape') {
                e.preventDefault(); e.stopPropagation(); cancel();
            } else if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault(); e.stopPropagation(); submit();
            }
        }
        document.addEventListener('keydown', onKey, true);
        okBtn.addEventListener('click', submit);
        if (cancelBtn) cancelBtn.addEventListener('click', cancel);

        if (input) { input.focus(); input.select(); }
        else okBtn.focus();
    });
}
