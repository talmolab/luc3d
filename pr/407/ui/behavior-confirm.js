// ui/behavior-confirm.js — the confirmations behavior labels need: before a
// pass that hands identity names out afresh (Track All, Track Frame Range,
// Propagate), and before removing a behavior that has bouts.
//
// Behavior labels are keyed by identity NAME (pose/behavior-labels.js). An
// ID-switch fix or a rename carries them, but a re-track or a propagate can
// give a labelled animal a different name, and its labels then sit on whoever
// now has the old one. Nothing on screen would show it, so it is asked first.
//
// Same dialog shape as the skeleton-edit warning (title, one sentence, the
// counts, Cancel / go); Esc cancels.
//
// Depends on: ui/app-state.js, pose/behavior-labels.js

import { state } from './app-state.js?v=79abc800b879';
import { hasBehaviorData, listBouts } from '../pose/behavior-labels.js?v=79abc800b879';

function n(x) { return Number(x || 0).toLocaleString('en-US'); }

/**
 * A small yes/no dialog. Resolves true on the confirm button, false on Cancel
 * or Esc.
 * @param {{id:string, title:string, message:string, rows?:Array<[string,string]>, confirmLabel:string}} o
 * @returns {Promise<boolean>}
 */
export function behaviorConfirm(o) {
    return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.className = 'plane-confirm-overlay';
        overlay.id = o.id;
        var modal = document.createElement('div');
        modal.className = 'plane-confirm-modal behavior-confirm-modal';
        var h = document.createElement('h3');
        h.textContent = o.title;
        modal.appendChild(h);
        var msg = document.createElement('div');
        msg.className = 'plane-confirm-message';
        msg.textContent = o.message;
        modal.appendChild(msg);
        if (o.rows && o.rows.length) {
            var table = document.createElement('table');
            table.className = 'data-table behavior-confirm-counts';
            o.rows.forEach(function (r) {
                var tr = document.createElement('tr');
                var a = document.createElement('td'); a.textContent = r[0];
                var b = document.createElement('td'); b.textContent = r[1]; b.className = 'num';
                tr.appendChild(a); tr.appendChild(b);
                table.appendChild(tr);
            });
            modal.appendChild(table);
        }
        var actions = document.createElement('div');
        actions.className = 'modal-actions';
        var cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        var go = document.createElement('button');
        go.className = 'primary';
        go.textContent = o.confirmLabel;
        go.dataset.confirm = '1';
        actions.appendChild(cancel);
        actions.appendChild(go);
        modal.appendChild(actions);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        function done(ok) {
            document.removeEventListener('keydown', onKey, true);
            if (overlay.parentNode) overlay.remove();
            resolve(ok);
        }
        function onKey(e) {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            done(false);
        }
        document.addEventListener('keydown', onKey, true);
        cancel.addEventListener('click', function () { done(false); });
        go.addEventListener('click', function () { done(true); });
        go.focus();
    });
}

/**
 * Before a pass that reassigns identity names on `session`. Resolves true at
 * once when the session has no behavior labels.
 * @param {Session} session
 * @param {string} action the pass, as the user knows it ("Track All")
 * @returns {Promise<boolean>}
 */
export function confirmRetrackWithBehaviorLabels(session, action) {
    if (!session || !hasBehaviorData(session)) return Promise.resolve(true);
    var bouts = listBouts(session);
    var animals = new Set(bouts.map(function (b) { return b.animal; }));
    return behaviorConfirm({
        id: 'behaviorRetrackConfirm',
        title: action + ' with behavior labels',
        message: 'Behavior labels follow identity names, and ' + action + ' may give a labelled animal a ' +
            'different name — its labels would then belong to whichever animal gets the old one.',
        rows: [['Behavior bouts in this session', n(bouts.length)], ['Animals with bouts', n(animals.size)]],
        confirmLabel: action + ' anyway',
    });
}

/**
 * Before removing a behavior from the ethogram: its bouts in every loaded
 * session go with it.
 * @param {Object} behavior
 * @param {number} bouts across the project
 * @param {number} sessions sessions holding them
 * @returns {Promise<boolean>}
 */
export function confirmRemoveBehavior(behavior, bouts, sessions) {
    if (!bouts) return Promise.resolve(true);
    return behaviorConfirm({
        id: 'behaviorRemoveConfirm',
        title: 'Remove "' + behavior.name + '"',
        message: 'Removing a behavior deletes its labelled bouts in every session.',
        rows: [['Bouts', n(bouts)], ['Sessions', n(sessions || (state.sessions || []).length)]],
        confirmLabel: 'Remove behavior and bouts',
    });
}
