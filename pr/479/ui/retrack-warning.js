/**
 * ui/retrack-warning.js — asks before a single-camera Track All replaces
 * tracks a person made.
 *
 * Track All on one camera tracks every detection again and replaces the
 * session's tracks (`pose/single-camera-tracking.js`), and a new run clears the
 * ID Switches tab. When the session holds work that a person did — tracks they
 * named (a proofread file's subject / partner), hand-labelled instances on a
 * track, or fixes and ticked rows in the ID Switches tab — `retrackLosses`
 * counts it and this dialog says what would be lost, with no undo. Raw
 * predictions (SLEAP's own `track_<n>` names) never ask.
 *
 * Title + one sentence + counts. Cancel is focused: replacing proofreading is
 * the one choice that cannot be taken back. Esc cancels; Enter presses the
 * focused button (no Enter handler of its own). Every key stops here, so the
 * app's shortcuts do not act under the dialog.
 *
 * Exports: confirmRetrack(losses) -> Promise<boolean>
 * Depends on: nothing (DOM only)
 */

/** How many track names the dialog lists before "and N more". */
var NAMES_SHOWN = 4;

function plural(n, one, many) {
    return n.toLocaleString('en-US') + ' ' + (n === 1 ? one : (many || one + 's'));
}

/**
 * Ask before Track All replaces the tracks `losses` (from `retrackLosses`)
 * describes. Resolves true to track, false to keep them.
 * @param {{names: string[], namedDetections: number, user: number, fixes: number, reviewed: number}} losses
 * @returns {Promise<boolean>}
 */
export function confirmRetrack(losses) {
    return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.className = 'multi-frame-modal-overlay';
        var card = document.createElement('div');
        card.className = 'multi-frame-modal retrack-warning-modal';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-labelledby', 'retrackWarnTitle');
        var h = document.createElement('h3');
        h.id = 'retrackWarnTitle';
        h.textContent = 'Replace these tracks?';
        card.appendChild(h);
        var p = document.createElement('p');
        p.textContent = 'Track All tracks every detection again and replaces what is here now, with no undo:';
        card.appendChild(p);
        // Built with textContent: track names come from the file.
        var ul = document.createElement('ul');
        ul.className = 'retrack-warning-list';
        var item = function (text) { var li = document.createElement('li'); li.textContent = text; ul.appendChild(li); };
        if (losses.names && losses.names.length) {
            var shown = losses.names.slice(0, NAMES_SHOWN).join(', ');
            var more = losses.names.length - NAMES_SHOWN;
            item('tracks named ' + shown + (more > 0 ? ' and ' + more.toLocaleString('en-US') + ' more' : '') +
                 ' (' + plural(losses.namedDetections, 'detection') + ')');
        }
        if (losses.user) item(plural(losses.user, 'hand-labelled instance') + ' on a track');
        if (losses.fixes || losses.reviewed) {
            var parts = [];
            if (losses.fixes) parts.push(plural(losses.fixes, 'fix', 'fixes'));
            if (losses.reviewed) parts.push(plural(losses.reviewed, 'reviewed place'));
            item(parts.join(' and ') + ' in the ID Switches tab');
        }
        card.appendChild(ul);
        var tip = document.createElement('p');
        tip.className = 'retrack-warning-tip';
        tip.textContent = 'To keep them, cancel and save a copy of the project first.';
        card.appendChild(tip);
        var row = document.createElement('div');
        row.className = 'modal-actions';
        var cancel = document.createElement('button');
        cancel.id = 'retrackWarnCancel';
        cancel.textContent = 'Cancel';
        var ok = document.createElement('button');
        ok.id = 'retrackWarnOk';
        ok.className = 'primary';
        ok.textContent = 'Replace tracks';
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
        // Capture phase, and every key stops here; Enter / Space still press the focused button.
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
