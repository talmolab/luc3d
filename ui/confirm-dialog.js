/**
 * ui/confirm-dialog.js — a small two-button question: title, one sentence, a
 * list, an optional tip, Cancel and an action.
 *
 * Cancel is focused (the choices it guards cannot be taken back, or add what
 * the user may not want); Esc and a backdrop click cancel; Enter presses the
 * focused button (no Enter handler of its own). Every key stops at the dialog
 * (capture phase), so the app's shortcuts do not act under it. Every text is
 * set with `textContent`: list items often hold names from a file.
 *
 * Used by `ui/retrack-warning.js` (Track All replacing tracks a person made) and
 * `import-export/slp-import.js` (Load SLP on a video that may already be in the
 * session).
 *
 * Exports: confirmDialog(opts) -> Promise<boolean>
 * Depends on: nothing (DOM only)
 */

/**
 * @param {{title: string, intro: string, items?: string[], tip?: string,
 *          okLabel: string, cancelLabel?: string, className?: string,
 *          idPrefix: string}} o  `idPrefix` names the parts: `<p>Title`, `<p>Cancel`, `<p>Ok`
 * @returns {Promise<boolean>} true for the action, false for Cancel
 */
export function confirmDialog(o) {
    return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.className = 'multi-frame-modal-overlay';
        var card = document.createElement('div');
        card.className = 'multi-frame-modal confirm-dialog' + (o.className ? ' ' + o.className : '');
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-labelledby', o.idPrefix + 'Title');
        var h = document.createElement('h3');
        h.id = o.idPrefix + 'Title';
        h.textContent = o.title;
        card.appendChild(h);
        var p = document.createElement('p');
        p.textContent = o.intro;
        card.appendChild(p);
        if (o.items && o.items.length) {
            var ul = document.createElement('ul');
            ul.className = 'confirm-dialog-list';
            o.items.forEach(function (t) { var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
            card.appendChild(ul);
        }
        if (o.tip) {
            var tip = document.createElement('p');
            tip.className = 'confirm-dialog-tip';
            tip.textContent = o.tip;
            card.appendChild(tip);
        }
        var row = document.createElement('div');
        row.className = 'modal-actions';
        var cancel = document.createElement('button');
        cancel.id = o.idPrefix + 'Cancel';
        cancel.textContent = o.cancelLabel || 'Cancel';
        var ok = document.createElement('button');
        ok.id = o.idPrefix + 'Ok';
        ok.className = 'primary';
        ok.textContent = o.okLabel;
        row.appendChild(cancel);
        row.appendChild(ok);
        card.appendChild(row);
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        function done(result) {
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            resolve(result);
        }
        function onKey(e) {
            e.stopPropagation();
            if (e.key === 'Escape') { e.preventDefault(); done(false); }
        }
        document.addEventListener('keydown', onKey, true);
        cancel.addEventListener('click', function () { done(false); });
        ok.addEventListener('click', function () { done(true); });
        overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) done(false); });
        cancel.focus();
    });
}
