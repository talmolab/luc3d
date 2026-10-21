// ui/animal-count-field.js — the toolbar's Animals field (`#tbNumAnimals`),
// first in the Track group.
//
// It shows and edits the active session's animal count, the number every
// tracking run caps identities at (`Session.numAnimals`, read and set through
// `pose/tracker.js`). The count used to be visible only in the first-use
// prompt, so a user who forgot what they typed had no way to find out. Blank is
// auto-detect, as it is in the first-use dialog (`ui/track-setup-modal.js`) and
// the Track Frame Range dialog.
//
// ## Two ways the shown value goes stale, two ways it is refreshed
//
//   * **The count changes** (the first-use dialog, the Track Frame Range
//     dialog, the field itself): `onTrackerNumAnimalsChange` repaints it at once.
//   * **The active session changes.** Nothing announces that — the session
//     switch and every load path assign `state.session` themselves — and the
//     count is per SESSION, so the field would keep showing the last one.
//     `syncAnimalCountField` is called from `drawAllOverlays`
//     (`ui/rendering.js`), which every one of those paths ends in, and costs
//     two comparisons when nothing changed. The same arrangement as the plane
//     toolbar lock, which is re-asserted from there for the same reason.
//
// It never rewrites the field while it has focus: the user's half-typed value
// is the one thing that must not move under the caret.
//
// Not in Defining Plane Mode's toolbar lock: it is a setting a run reads when
// it starts, not an action on annotation.

import { state } from './app-state.js?v=3f3db23497b5';
import { setStatus } from '../import-export/save-load.js?v=3f3db23497b5';
import {
    getTrackerNumAnimals, setTrackerNumAnimals, onTrackerNumAnimalsChange,
} from '../pose/tracker.js?v=3f3db23497b5';

// What the field last showed, so a redraw with nothing new is a no-op.
var _shownSession;
var _shownCount;

function fieldEl() { return document.getElementById('tbNumAnimals'); }

// Write the active session's count into the field, unconditionally.
function show(input) {
    _shownSession = state.session;
    _shownCount = getTrackerNumAnimals();
    input.value = _shownCount != null ? String(_shownCount) : '';
}

/**
 * Wire the field. Called once from `setupUI` (`ui/ui-wiring.js`).
 *
 * It commits on `change` (Enter, or focus leaving), so a half-typed "1" on the
 * way to "12" is never the count. Enter blurs, handing the keys back to the
 * shortcuts (a number field blocks them all while focused — see
 * `ui/keyboard-target.js`); Esc reverts and blurs.
 */
export function wireAnimalCountField() {
    var input = fieldEl();
    if (!input) return;
    function commit() {
        var raw = input.value.trim();
        var n = raw === '' ? null : Number(raw);
        // `badInput` is text that is not a number at all (a stray "e" or "-"),
        // which `value` reports as '' — a typo, not a request for auto-detect.
        if (input.validity.badInput || (n !== null && (!Number.isInteger(n) || n < 1))) {
            show(input);
            setStatus('Animals must be a whole number, 1 or more, or blank to auto-detect', 'error');
            return;
        }
        if (!state.session) {
            show(input);
            setStatus('Load a session first: the animal count is saved with it', 'warning');
            return;
        }
        setTrackerNumAnimals(n);
    }
    show(input);
    onTrackerNumAnimalsChange(function () { show(input); });
    input.addEventListener('change', commit);
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            input.blur();   // commits through `change`, and hands the keys back
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            show(input);
            input.blur();
        }
    });
}

/**
 * Re-show the active session's count if the session (or its count) is not the
 * one on screen. Called on every `drawAllOverlays`, so it must stay O(1).
 */
export function syncAnimalCountField() {
    var input = fieldEl();
    if (!input) return;
    if (state.session === _shownSession && getTrackerNumAnimals() === _shownCount) return;
    if (document.activeElement === input) return;
    show(input);
}
