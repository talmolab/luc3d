// ui/plane-toolbar-lock.js — the annotation toolbar, while Defining Plane
// Mode is on.
//
// Split out of `ui/plane-definition.js`. This cluster is self-contained: it
// reads one flag (`planeState.active`) and otherwise only touches toolbar DOM.
// It has no fan-in from the rest of the plane panel, which is what made it safe
// to lift.
//
// `applyPlaneModeToolbarLock` is still re-exported from
// `ui/plane-definition.js`, and `ui/rendering.js` keeps importing it from
// there, so no call site changed.
//
// The `planeState` import is circular (the hub imports this module's function
// back). That is the established pattern across this feature — see
// `ui/plane-angle.js` and `ui/origin-definition.js` — and it is only safe
// because the binding is read INSIDE the function body, never at module top
// level, where a circular import is still `undefined`.

import { planeState } from './plane-definition.js';

/**
 * The toolbar buttons Defining Plane Mode blocks.
 *
 * All of them act on POSE annotation — instances, groups, pose triangulation,
 * tracking — which is a different object than the plane geometry the mode is
 * for. In the mode a click lands on a plane node, the info panel is the plane
 * panel, and `interactionManager`'s selection is a plane; pressing Group or
 * Triangulate here operates on a pose selection the user can no longer see or
 * change, so the result is an edit they did not mean to make and cannot
 * observe. Blocked rather than merely ignored, because a button that silently
 * does nothing is indistinguishable from one that is broken.
 *
 * The VISIBILITY controls are deliberately absent from this list, and so are
 * Sessions, Color and Hide Panel. Those change what is DRAWN, not what is
 * annotated — turning Predicted off to see the plane you are placing is
 * exactly the kind of thing this mode is for.
 *
 * @type {string[]}
 */
const PLANE_LOCKED_TOOLBAR_IDS = [
    'tbAddInstance', 'tbDeleteInstance',
    'tbGroup', 'tbEditGroup', 'tbTriangulate', 'tbTriangulateAll',
    'tbTrackFrame', 'tbTrackAll',
];

/**
 * The dropdown WRAPPERS whose menus must be locked with their button.
 *
 * `#tbTriangulate` / `#tbTriangulateAll` each sit inside a `.tri-dropdown`
 * whose menu opens on **hover** (CSS) and whose DLT / BA entries are `div`s
 * with their own click handlers. `disabled` on the button reaches neither, so
 * without this the button greys out while its menu still triangulates.
 *
 * @type {string[]}
 */
const PLANE_LOCKED_DROPDOWN_IDS = ['triangulateDropdown', 'triangulateAllDropdown'];

/** Suffix appended to a locked button's tooltip, so "why?" is answered in place. */
const LOCKED_TITLE_SUFFIX = ' — not available in Defining Plane Mode';

/**
 * Apply (or lift) the mode's toolbar lock.
 *
 * Idempotent, and safe to call as often as you like — which it has to be,
 * because `drawAllOverlays` RECOMPUTES `tbGroup.disabled` / `tbEditGroup.disabled`
 * from the pose selection on every overlay draw, and the mode redraws
 * constantly. So this is re-asserted from there too rather than only on entry;
 * setting `disabled` once at `enterPlaneMode` would survive exactly until the
 * first mouse move.
 *
 * Each button's PRIOR `disabled` is recorded at lock time and restored on exit,
 * the same rule `lockUI` in `ui/origin-definition.js` follows: several of these
 * are disabled for their own reasons (Edit Group with a reprojected instance
 * selected, Track All mid-run), and blanket-enabling on exit would misreport
 * what is clickable. For `tbGroup` / `tbEditGroup` the snapshot is belt and
 * braces only — `drawAllOverlays` OWNS those two and re-derives them on the
 * redraw `exitPlaneMode` triggers, so a stale snapshot cannot stick.
 */
export function applyPlaneModeToolbarLock() {
    var on = planeState.active;
    for (var i = 0; i < PLANE_LOCKED_TOOLBAR_IDS.length; i++) {
        var btn = document.getElementById(PLANE_LOCKED_TOOLBAR_IDS[i]);
        if (!btn) continue;
        if (on) {
            // Snapshot once, on the transition — re-snapshotting on the
            // re-assert from `drawAllOverlays` would record the LOCKED state
            // and make the restore a no-op.
            if (!btn.classList.contains('plane-mode-locked')) {
                btn.dataset.planeUnlockedTitle = btn.title || '';
                btn.dataset.planeUnlockedDisabled = btn.disabled ? '1' : '';
                btn.title = (btn.title || btn.textContent.trim()) + LOCKED_TITLE_SUFFIX;
                btn.classList.add('plane-mode-locked');
            }
            btn.disabled = true;
        } else if (btn.classList.contains('plane-mode-locked')) {
            btn.classList.remove('plane-mode-locked');
            btn.title = btn.dataset.planeUnlockedTitle || '';
            btn.disabled = btn.dataset.planeUnlockedDisabled === '1';
            delete btn.dataset.planeUnlockedTitle;
            delete btn.dataset.planeUnlockedDisabled;
        }
    }
    for (var d = 0; d < PLANE_LOCKED_DROPDOWN_IDS.length; d++) {
        var wrap = document.getElementById(PLANE_LOCKED_DROPDOWN_IDS[d]);
        if (wrap) wrap.classList.toggle('plane-mode-locked', on);
    }
}
