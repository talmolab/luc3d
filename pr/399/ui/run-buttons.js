/**
 * run-buttons.js — the toolbar's Track and Triangulate buttons turn blue
 * (`.active`) once that step has been run on the session and while its result
 * still stands (`pose/run-state.js`), as Smooth does while smoothing is
 * applied (`ui/smoothing-button.js`). Derived on every overlay draw
 * (`ui/rendering.js`), so a session switch or a result that goes away
 * (re-tracking replaces Triangulate's 3D) needs no bookkeeping here.
 *
 * Depends on: ui/app-state.js, pose/run-state.js
 */

import { state } from './app-state.js?v=9bfcdacefa7b';
import { hasTrackResult, hasTriangulateResult } from '../pose/run-state.js?v=9bfcdacefa7b';

/** Re-derive the two buttons' blue state from the active session. */
export function syncRunButtons() {
    var session = state.session;
    var track = document.getElementById('tbTrackAll');
    if (track) track.classList.toggle('active', hasTrackResult(session));
    var tri = document.getElementById('tbTriangulateAll');
    if (tri) tri.classList.toggle('active', hasTriangulateResult(session));
}
