/**
 * smoothing-button.js — the toolbar's Temporal Smoothing button state (luc3d #134).
 *
 * The button (`#tbSmooth`) is blue (`.active`) while any 3D in the session is
 * smoothed; in its menu, "All frames" is lit (`.applied`) the same way and
 * "This frame" while the current frame's 3D is. Smoothing lapses by itself
 * when a re-solve or edit replaces a group's 3D (`isPoints3dSmoothed` keys the
 * array), so the state is derived, never tracked: `ui/rendering.js` calls
 * `syncSmoothingButton` on every overlay draw, and the pass calls it after
 * running. `hasSmoothed3d` keeps that cheap (see its docstring).
 *
 * Depends on: ui/app-state.js, pose/temporal-smoothing.js
 */

import { state } from './app-state.js?v=340619b4e8b3';
import { hasSmoothed3d } from '../pose/temporal-smoothing.js?v=340619b4e8b3';

/** Re-derive the button's and its menu items' on-state from the session. */
export function syncSmoothingButton() {
    var btn = document.getElementById('tbSmooth');
    if (!btn) return;
    var session = state.session;
    var any = hasSmoothed3d(session);
    var here = any && hasSmoothed3d(session, state.currentFrame);
    btn.classList.toggle('active', any);
    var all = document.querySelector('#smoothingDropdown [data-scope="all"]');
    var frame = document.querySelector('#smoothingDropdown [data-scope="frame"]');
    if (all) all.classList.toggle('applied', any);
    if (frame) frame.classList.toggle('applied', here);
}
