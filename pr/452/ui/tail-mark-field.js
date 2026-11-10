// ui/tail-mark-field.js — the Track menu's Tail marks choice (`#tbTailMarks`): which
// identity Track All gives the tail marks in the active session (pose/tail-mark.js),
// or "Bands per id…", which asks each identity's number of tail bands
// (ui/identity-marks-modal.js) for the identity engine (pose/identity-cues.js).
// Follows the session the way the Animals field does (`ui/animal-count-field.js`):
// the listener repaints it on a change, `syncTailMarkField` on a session switch.

import { state } from './app-state.js?v=ecdf4c85283a';
import { setStatus } from '../import-export/save-load.js?v=ecdf4c85283a';
import {
    getTailMarkedIdentity, setTailMarkedIdentity, onTailMarkedIdentityChange,
    getIdentityMarks, setIdentityMarks, getTrackerNumAnimals,
} from '../pose/tracker.js?v=ecdf4c85283a';
import { showIdentityMarksModal } from './identity-marks-modal.js?v=ecdf4c85283a';

var _shownSession;
var _shownValue;

function fieldEl() { return document.getElementById('tbTailMarks'); }

// What the select shows: 'bands' while per-identity marks are set, else the marked identity.
function current() {
    return getIdentityMarks() ? 'bands' : (getTailMarkedIdentity() || '');
}

function show(select) {
    _shownSession = state.session;
    _shownValue = current();
    select.value = _shownValue;
}

/**
 * The identities to ask about: the ones already set, else id_0 … for the animal count
 * (or the session's identities, at least two).
 */
export function identityNamesForMarks(session, marks) {
    if (marks && marks.tailBands && Object.keys(marks.tailBands).length) return Object.keys(marks.tailBands);
    var n = getTrackerNumAnimals() || Math.max(2, (session && session.identities ? session.identities.length : 0));
    var out = [];
    for (var i = 0; i < n; i++) out.push('id_' + i);
    return out;
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
        if (select.value !== 'bands') {
            setIdentityMarks(null);
            setTailMarkedIdentity(select.value || null);
            return;
        }
        var marks = getIdentityMarks();
        showIdentityMarksModal(identityNamesForMarks(state.session, marks), marks && marks.tailBands).then(function (ans) {
            if (ans) setIdentityMarks({ tailBands: ans.counts });
            show(select);
        });
    });
}

/** Re-show the active session's choice. Called on every `drawAllOverlays`, so O(1). */
export function syncTailMarkField() {
    var select = fieldEl();
    if (!select) return;
    if (state.session === _shownSession && current() === _shownValue) return;
    if (document.activeElement === select) return;
    show(select);
}
