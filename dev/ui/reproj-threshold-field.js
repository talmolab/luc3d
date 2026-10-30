// ui/reproj-threshold-field.js — the Triangulate menu's Reprojection error field
// (`#tbReprojThreshold`), like Track's Animals field (`ui/animal-count-field.js`).
//
// It shows and edits the Tracking Wizard's `reprojErrorThreshold`, the setting
// every Triangulate run reads when it starts (`triangulateAndReproject`). Blank
// is off: the setting's 0 shows as blank under an "off" placeholder, and typing
// 0 means the same. The setting is browser-wide, not per session, so unlike the
// Animals field it only has to follow changes to the setting itself (Settings
// ▸ Apply), through `onTrackingThresholdsChange`.
//
// It commits on `change` (Enter, or focus leaving). Enter blurs, handing the
// keys back to the shortcuts (a number field blocks them all while focused — see
// `ui/keyboard-target.js`); Esc reverts and blurs.
//
// Not in Defining Plane Mode's toolbar lock: it is a setting a run reads when
// it starts, not an action on annotation.

import { setStatus } from '../import-export/save-load.js?v=4f933172d60c';
import {
    getTrackingThreshold, getTrackingThresholdDefs, updateTrackingThresholds, onTrackingThresholdsChange,
} from './settings.js?v=4f933172d60c';

var ID = 'reprojErrorThreshold';

function show(input) {
    var v = getTrackingThreshold(ID);
    input.value = v > 0 ? String(v) : '';
}

/** Wire the field. Called once from `setupUI` (`ui/ui-wiring.js`). */
export function wireReprojThresholdField() {
    var input = document.getElementById('tbReprojThreshold');
    if (!input) return;
    var def = getTrackingThresholdDefs().find(function (d) { return d.id === ID; });
    function commit() {
        var raw = input.value.trim();
        var n = raw === '' ? 0 : Number(raw);
        // `badInput` is text that is not a number at all (a stray "e" or "-"),
        // which `value` reports as '' — a typo, not a request to turn it off.
        if (input.validity.badInput || !isFinite(n) || n < def.min || n > def.max) {
            show(input);
            setStatus('Reprojection error must be ' + def.min + ' to ' + def.max + ' px, or blank for off', 'error');
            return;
        }
        var next = {};
        next[ID] = n;
        updateTrackingThresholds(next);
    }
    show(input);
    onTrackingThresholdsChange(function () { show(input); });
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
