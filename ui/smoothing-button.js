/**
 * smoothing-button.js — the toolbar's Temporal Smoothing button state (luc3d #134).
 *
 * The button (`#tbSmooth`) is blue (`.active`) while any 3D in the session is
 * smoothed. In its menu only the scope of the LAST run is lit (`.applied`):
 * "All frames" after an all-frames run, while anything is still smoothed;
 * "This frame" after a this-frame run, on the frames it smoothed — never both,
 * which read as if both had been picked. Smoothing lapses by itself
 * when a re-solve or edit replaces a group's 3D (`isPoints3dSmoothed` keys the
 * array), so the state is derived, never tracked: `ui/rendering.js` calls
 * `syncSmoothingButton` on every overlay draw, and the pass calls it after
 * running. `hasSmoothed3d` keeps that cheap (see its docstring).
 *
 * Depends on: ui/app-state.js, pose/temporal-smoothing.js
 */

import { state } from './app-state.js';
import { hasSmoothed3d } from '../pose/temporal-smoothing.js';

/** Session -> scope of its last smoothing run, 'all' | 'frame'. */
var _lastScope = new WeakMap();

/** Record the scope a smoothing run just used (`runTemporalSmoothing`). */
export function noteSmoothingScope(session, scope) {
    if (session) _lastScope.set(session, scope);
}

/** Re-derive the button's and its menu items' on-state from the session. */
export function syncSmoothingButton() {
    var btn = document.getElementById('tbSmooth');
    if (!btn) return;
    var session = state.session;
    var any = hasSmoothed3d(session);
    var scope = (session && _lastScope.get(session)) || 'all';
    btn.classList.toggle('active', any);
    var all = document.querySelector('#smoothingDropdown [data-scope="all"]');
    var frame = document.querySelector('#smoothingDropdown [data-scope="frame"]');
    if (all) all.classList.toggle('applied', any && scope === 'all');
    if (frame) frame.classList.toggle('applied',
        any && scope === 'frame' && hasSmoothed3d(session, state.currentFrame));
}
