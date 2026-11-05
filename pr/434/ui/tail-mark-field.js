// ui/tail-mark-field.js — the Track menu's Tail marks choice (`#tbTailMarks`): which
// identity Track All gives the tail marks in the active session (pose/tail-mark.js).
// Follows the session the way the Animals field does (`ui/animal-count-field.js`):
// the listener repaints it on a change, `syncTailMarkField` on a session switch.

import { state } from './app-state.js?v=396ae18451b0';
import { setStatus } from '../import-export/save-load.js?v=396ae18451b0';
import {
    getTailMarkedIdentity, setTailMarkedIdentity, onTailMarkedIdentityChange,
} from '../pose/tracker.js?v=396ae18451b0';

var _shownSession;
var _shownValue;

function fieldEl() { return document.getElementById('tbTailMarks'); }

function show(select) {
    _shownSession = state.session;
    _shownValue = getTailMarkedIdentity();
    select.value = _shownValue || '';
}

/** Wire the field. Called once from `setupUI` (`ui/ui-wiring.js`). */
export function wireTailMarkField() {
    var select = fieldEl();
    if (!select) return;
    show(select);
    onTailMarkedIdentityChange(function () { show(select); });
    select.addEventListener('change', function () {
        if (!state.session) {
            show(select);
            setStatus('Load a session first: the tail-mark choice is saved with it', 'warning');
            return;
        }
        setTailMarkedIdentity(select.value || null);
    });
}

/** Re-show the active session's choice. Called on every `drawAllOverlays`, so O(1). */
export function syncTailMarkField() {
    var select = fieldEl();
    if (!select) return;
    if (state.session === _shownSession && getTailMarkedIdentity() === _shownValue) return;
    show(select);
}
