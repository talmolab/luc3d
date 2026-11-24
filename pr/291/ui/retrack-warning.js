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
 * Title + one sentence + counts, through `ui/confirm-dialog.js` (Cancel
 * focused, Esc cancels).
 *
 * Exports: confirmRetrack(losses) -> Promise<boolean>
 * Depends on: ui/confirm-dialog.js
 */

import { confirmDialog } from './confirm-dialog.js?v=b37e376d771e';

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
    var items = [];
    if (losses.names && losses.names.length) {
        var shown = losses.names.slice(0, NAMES_SHOWN).join(', ');
        var more = losses.names.length - NAMES_SHOWN;
        items.push('tracks named ' + shown + (more > 0 ? ' and ' + more.toLocaleString('en-US') + ' more' : '') +
                   ' (' + plural(losses.namedDetections, 'detection') + ')');
    }
    if (losses.user) items.push(plural(losses.user, 'hand-labelled instance') + ' on a track');
    if (losses.fixes || losses.reviewed) {
        var parts = [];
        if (losses.fixes) parts.push(plural(losses.fixes, 'fix', 'fixes'));
        if (losses.reviewed) parts.push(plural(losses.reviewed, 'reviewed place'));
        items.push(parts.join(' and ') + ' in the ID Switches tab');
    }
    return confirmDialog({
        title: 'Replace these tracks?',
        intro: 'Track All tracks every detection again and replaces what is here now, with no undo:',
        items: items,
        tip: 'To keep them, cancel and save a copy of the project first.',
        okLabel: 'Replace tracks',
        className: 'retrack-warning-modal',
        idPrefix: 'retrackWarn',
    });
}
