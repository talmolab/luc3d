// ui/skeleton-check-field.js — the Triangulate menu's "Skeleton check" checkbox (`#tbSkeletonCheck`), like its
// Reprojection error field (`ui/reproj-threshold-field.js`).
//
// It edits the browser-local skeleton-check setting (pose/skeleton-check-run.js `getSkeletonCheckSettings().enabled`,
// off by default), which every Triangulate run reads when it starts: This frame and Range check inline, Triangulate
// All in a pass after its solve. The tooltip names the chains the session's skeleton gives.
//
// Not in Defining Plane Mode's toolbar lock: it is a setting a run reads when it starts, not an action.

import { state } from './app-state.js';
import { getSkeletonCheckSettings, setSkeletonCheckSettings, sessionSkeletonChains } from '../pose/skeleton-check-run.js';
import { setStatus } from '../import-export/save-load.js';

const INFO = 'Skeleton check: after Triangulate, a body part whose bones are far outside their usual lengths ' +
    '(measured on this project\'s own 3D) is repaired with the fewest point changes: each point re-solved from a ' +
    'group of cameras that agree on it, or left out (no 3D) when none fits. A point every camera agrees on is never ' +
    'changed. Used by the next Triangulate.';

function refresh(input, label) {
    input.checked = !!getSkeletonCheckSettings().enabled;
    if (!label) return;
    const session = state.session;
    const chains = sessionSkeletonChains(session);
    label.title = INFO + (!session || !session.skeleton ? ''
        : chains.length ? ' This skeleton\'s parts: ' + chains.map(function (c) { return c.name; }).join(', ') + '.'
        : ' This skeleton has no part to check (it needs edges).');
}

/** Wire the checkbox. Called once from `setupUI` (`ui/ui-wiring.js`). */
export function wireSkeletonCheckField() {
    const input = document.getElementById('tbSkeletonCheck');
    if (!input) return;
    const label = input.closest('label');
    refresh(input, label);
    input.addEventListener('change', function () {
        setSkeletonCheckSettings({ enabled: input.checked });
        setStatus('Skeleton check ' + (input.checked ? 'on' : 'off') + ': used by the next Triangulate', 'info');
    });
    const menu = document.getElementById('triangulateDropdown');
    if (menu) {
        menu.addEventListener('mouseenter', function () { refresh(input, label); });
        menu.addEventListener('focusin', function () { refresh(input, label); });
    }
}
