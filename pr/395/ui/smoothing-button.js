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
 * The last run's scope is kept with its settings by
 * import-export/smoothing-metadata.js, which also saves it, so a reopened
 * project lights the same item.
 *
 * Depends on: ui/app-state.js, pose/temporal-smoothing.js,
 * import-export/smoothing-metadata.js
 */

import { state } from './app-state.js?v=0b7f03dc8f41';
import { hasSmoothed3d } from '../pose/temporal-smoothing.js?v=0b7f03dc8f41';
import { noteSmoothingRun, smoothingRunOf } from '../import-export/smoothing-metadata.js?v=0b7f03dc8f41';

/** Record the scope and settings a smoothing run just used (`runTemporalSmoothing`). */
export function noteSmoothingScope(session, scope, config) {
    noteSmoothingRun(session, scope, config);
}

/** Re-derive the button's and its menu items' on-state from the session. */
export function syncSmoothingButton() {
    var btn = document.getElementById('tbSmooth');
    if (!btn) return;
    var session = state.session;
    var any = hasSmoothed3d(session);
    var run = smoothingRunOf(session);
    var scope = run ? run.scope : 'all';
    btn.classList.toggle('active', any);
    var all = document.querySelector('#smoothingDropdown [data-scope="all"]');
    var frame = document.querySelector('#smoothingDropdown [data-scope="frame"]');
    if (all) all.classList.toggle('applied', any && scope === 'all');
    if (frame) frame.classList.toggle('applied',
        any && scope === 'frame' && hasSmoothed3d(session, state.currentFrame));
}
