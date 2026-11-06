// ui/plane-dialog.js — the small blocking-error / confirmation modal the plane
// and origin flows share.
//
// Split out of `ui/plane-definition.js`, which had grown to 4,474 lines. This
// function was the easiest thing in it to lift: it touches no plane state, no
// model and no viewport — it is a DOM helper that happens to live in the plane
// feature because that is where the first caller was. Four modules now reach it
// (`plane-definition.js`, `plane-angle.js`, `origin-definition.js` and the node
// deletion confirm), which is what makes a shared home the honest one.
//
// It is still re-exported from `ui/plane-definition.js`, so every existing
// importer and every test that reaches `showPlaneDialog` through that path is
// unaffected.

/**
 * A small modal for the outcomes the status bar cannot carry: a blocking error
 * (OK only) and a confirmation (Cancel / confirm) for anything irreversible —
 * a fit that would move a corner metres, or deleting a node several planes are
 * standing on.
 *
 * Closes on Esc, per the project's modal rule — Esc CANCELS, so an accidental
 * dismissal can never apply the thing the user was still deciding about.
 *
 * @param {{title:string, message:string, confirmLabel?:string,
 *          onConfirm?:function}} opts
 */
export function showPlaneDialog(opts) {
    var overlay = document.createElement('div');
    overlay.className = 'plane-confirm-overlay';
    overlay.id = 'planeDialog';

    var modal = document.createElement('div');
    modal.className = 'plane-confirm-modal';

    var h = document.createElement('h3');
    h.textContent = opts.title;
    modal.appendChild(h);

    var body = document.createElement('div');
    body.className = 'plane-confirm-message';
    body.id = 'planeDialogMessage';
    body.textContent = opts.message;
    modal.appendChild(body);

    var actions = document.createElement('div');
    actions.className = 'modal-actions';

    function close() {
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.remove();
    }
    function onKey(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        close();
    }

    if (opts.onConfirm) {
        var cancel = document.createElement('button');
        cancel.id = 'btnPlaneDialogCancel';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', close);
        actions.appendChild(cancel);

        var ok = document.createElement('button');
        ok.id = 'btnPlaneDialogConfirm';
        ok.className = 'primary';
        ok.textContent = opts.confirmLabel || 'Continue';
        ok.addEventListener('click', function () {
            close();
            opts.onConfirm();
        });
        actions.appendChild(ok);
    } else {
        var dismiss = document.createElement('button');
        dismiss.id = 'btnPlaneDialogDismiss';
        dismiss.className = 'primary';
        dismiss.textContent = 'OK';
        dismiss.addEventListener('click', close);
        actions.appendChild(dismiss);
    }

    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
}
