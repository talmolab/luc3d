// ui/color-by.js — the toolbar's Tracks / Identity coloring setting
// (`state.colorByIdentity`), settable from anywhere.
//
// The toggle's DOM and its redraws live in `ui/ui-wiring.js`, but the tracker
// (`pose/tracker.js`) also needs to flip it — after Track All, IDs are what
// the user wants to look at (#242). The tracker cannot import ui-wiring (it
// would close an import loop, and the tracker's Node tests stub UI modules), so
// this module is the meeting point: dependency-free, it changes the state and
// calls ONE change handler that ui-wiring registers (button highlight + 2D and
// 3D recolor). With no handler registered (Node tests) it just sets the state.

var _onChange = null;

/** Register the handler run after the setting changes (ui-wiring does this once). */
export function onColorByChange(fn) {
    _onChange = typeof fn === 'function' ? fn : null;
}

/**
 * Color by identity (`true`) or by track (`false`). Returns whether anything
 * changed; the handler runs only on a change, so setting the current value is
 * free.
 *
 * @param {{colorByIdentity: boolean}} state  the app state (`ui/app-state.js`)
 * @param {boolean} on
 * @returns {boolean}
 */
export function setColorByIdentity(state, on) {
    on = !!on;
    if (!state || !!state.colorByIdentity === on) return false;
    state.colorByIdentity = on;
    if (_onChange) {
        try { _onChange(on); } catch (e) { console.error('[color-by] change handler failed:', e); }
    }
    return true;
}
