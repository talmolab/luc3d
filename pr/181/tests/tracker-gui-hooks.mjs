/**
 * tracker-gui-hooks.mjs — UI-stubbing module loader for the GUI-contract test
 * (tests/test-tracker-gui.mjs). Like scripts/bench/hooks.mjs, it serves tiny
 * stubs for every browser/UI module pose/tracker.js imports — but here the
 * stubs are SPIES that record GUI-refresh calls on globalThis.__GUI, so a Node
 * test can assert that trackCurrentFrame()/trackAll() update the GUI the same
 * way the app does (overlays + info panel + timeline tracks).
 */
const SETTINGS_STUB = `
export function getNodeWeightArray(nodeNames) {
    if (!Array.isArray(nodeNames)) return null;
    return nodeNames.map(() => 1);
}
const DEFAULTS = { epipolarDecay:10, reprojSigma:20, epipolarWeight:0.4, reprojWeight:0.6,
    minMatchScore:0.05, prevIdentityBonus:0.3, reprojGate2:100, reprojGate3:140, reprojGate4:180,
    track3dWeight:1, filterMinVisibleNodes:0, filterMinInstanceScore:0 };
export function getTrackingThreshold(id) {
    const ov = (globalThis.__GUI && globalThis.__GUI.thresholds) || {};
    const v = ov[id];
    return (typeof v === 'number' && isFinite(v)) ? v : DEFAULTS[id];
}
export function getTrackingThresholds() {
    const out = {}; for (const id in DEFAULTS) out[id] = getTrackingThreshold(id); return out;
}
export function isCameraTracked() { return true; }
`;

// state + timeline are real, mutable spy objects the test can read/populate.
const APP_STATE_STUB = `
export const state = { session: null, currentFrame: 0 };
export const interactionManager = {};
export const timeline = {
    refreshTracks(session, opts) {
        globalThis.__GUI.refreshTracks++;
        globalThis.__GUI.lastRefreshArgs = { hasSession: !!session, opts };
    },
};
export const viewport3d = null;
export function getActiveSession() { return state.session; }
`;

const SAVE_LOAD_STUB = `
export function setStatus(msg, level) { globalThis.__GUI.lastStatus = { msg, level }; }
export function showLoading() {}
export function hideLoading() {}
export function markDirty() { globalThis.__GUI.markDirty++; }
`;

const RENDERING_STUB = `
export function drawAllOverlays(frame) { globalThis.__GUI.drawOverlays++; globalThis.__GUI.lastDrawFrame = frame; }
export function setReprojErrorVisible() {}
`;

const INFO_PANEL_STUB = `
export function updateInfoPanel() { globalThis.__GUI.updateInfoPanel++; }
export function updateTriangulationBadge() {}
`;

const INITIALIZATION_STUB = `
export function update3DViewport() { globalThis.__GUI.update3DViewport++; }
`;

const STUBS = [
    ['/ui/settings.js', SETTINGS_STUB],
    ['/ui/app-state.js', APP_STATE_STUB],
    ['/import-export/save-load.js', SAVE_LOAD_STUB],
    ['/ui/rendering.js', RENDERING_STUB],
    ['/ui/info-panel.js', INFO_PANEL_STUB],
    ['/pose/initialization.js', INITIALIZATION_STUB],
];

export async function load(url, context, nextLoad) {
    for (const [suffix, source] of STUBS) {
        if (url.endsWith(suffix)) return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
}
