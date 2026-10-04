/**
 * ui/panel-visibility.js — is the 3D viewport / info panel actually on screen?
 *
 * The two collapsible right-hand panels (`#viewport3dContainer`,
 * `#infoPanelWrapper`) used to be pure CSS: `toggle3DViewport` /
 * `toggleInfoPanel` flipped a `collapsed` class and nothing else in the app
 * ever learned about it. So a hidden 3D viewport kept rendering the whole
 * Three.js scene ~60x/second into a zero-width canvas, and a hidden info panel
 * kept rebuilding its instance / reprojection-error tables on every frame —
 * both entirely for the benefit of pixels nobody can see. Hiding a panel is
 * how the user asks for that work to STOP (screen space or CPU/GPU), so the
 * collapse state has to be readable by the code doing the work.
 *
 * This is a LEAF module — it imports nothing. `ui/info-panel.js`,
 * `ui/viewport3d.js`, `ui/ui-wiring.js` and `pose/initialization.js` all need
 * to ask "am I visible?", and several of those already import each other, so
 * anything with its own imports would close an import cycle.
 *
 * The DOM is the single source of truth (no mirrored boolean that can drift
 * out of sync with the class the CSS actually reacts to). Both panels start
 * expanded in `index.html`, so a `collapsed` class present means the user
 * asked for it — that is what lets `setup3DViewport()` stop force-expanding
 * the 3D panel on every session load.
 *
 * A missing element means "not gated": the unit-test runner
 * (`tests/test-runner.html`) has no app chrome, and silently skipping every
 * panel refresh there would turn these gates into invisible test failures.
 */

const VIEWPORT3D_CONTAINER_ID = 'viewport3dContainer';
const INFO_PANEL_WRAPPER_ID = 'infoPanelWrapper';

/**
 * Work these gates have skipped, purely for diagnostics — exposed on
 * `window.__lucidPanelVis` so a headless test (and DevTools) can assert that
 * hiding a panel really does stop the work rather than just hiding its output.
 * A gate that looks right and still does the work is invisible otherwise.
 */
export const skipped = { infoPanel: 0, viewport3d: 0 };

function isShown(elementId) {
    if (typeof document === 'undefined') return true;
    const el = document.getElementById(elementId);
    if (!el) return true;
    if (el.classList.contains('collapsed')) return false;
    // `display:none` is the 3D container's Three.js-init-failure state
    // (`setup3DViewport`'s catch) — also "not on screen".
    if (el.style.display === 'none') return false;
    return true;
}

/** True when the 3D viewport panel is expanded (not collapsed / not hidden). */
export function isViewport3DVisible() {
    return isShown(VIEWPORT3D_CONTAINER_ID);
}

/** True when the info panel is expanded (not collapsed). */
export function isInfoPanelVisible() {
    return isShown(INFO_PANEL_WRAPPER_ID);
}

// --- Deferred-refresh bookkeeping -------------------------------------------
// A skipped refresh is not a lost refresh: every info-panel populate function
// is a stateless full rebuild from current `state`, so one call on re-show
// restores the panel no matter how many were skipped. This flag records
// whether ANY were, so re-showing a panel that never went stale doesn't pay
// for a redundant rebuild (`populateVideosTable` walks every frame of the
// session, so that rebuild is not cheap).

let infoPanelStale = false;

/** Record that an info-panel refresh was skipped because it was hidden. */
export function markInfoPanelStale() {
    infoPanelStale = true;
    skipped.infoPanel++;
}

/** Read-and-clear: true if the info panel needs one rebuild to catch up. */
export function consumeInfoPanelStale() {
    const wasStale = infoPanelStale;
    infoPanelStale = false;
    return wasStale;
}

/** Record that a 3D viewport refresh was skipped because it was hidden. */
export function markViewport3DSkipped() {
    skipped.viewport3d++;
}

if (typeof window !== 'undefined') {
    window.__lucidPanelVis = {
        get skipped() { return skipped; },
        isViewport3DVisible,
        isInfoPanelVisible,
        get infoPanelStale() { return infoPanelStale; },
    };
}
