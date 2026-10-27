/**
 * tracker-gui-hooks.mjs — UI-stubbing module loader for the GUI-contract test
 * (tests/test-tracker-gui.mjs). Like scripts/bench/hooks.mjs, it serves tiny
 * stubs for every browser/UI module pose/tracker.js imports — but here the
 * stubs are SPIES that record GUI-refresh calls on globalThis.__GUI, so a Node
 * test can assert that trackCurrentFrame()/trackAll() update the GUI the same
 * way the app does (overlays + info panel + timeline tracks).
 */
// Node weights are a real (in-memory) store, so the test can tell which
// weights a run read: the run's array is recorded on __GUI.lastNodeWeightArray.
const SETTINGS_STUB = `
let _nodeWeights = {};
export function getNodeWeight(name) {
    const w = _nodeWeights[name];
    return (typeof w === 'number' && isFinite(w)) ? w : 1;
}
export function getNodeWeights() { return Object.assign({}, _nodeWeights); }
export function setNodeWeights(map) {
    _nodeWeights = Object.assign({}, map);
    globalThis.__GUI.nodeWeightsSet = (globalThis.__GUI.nodeWeightsSet || 0) + 1;
}
export function updateNodeWeights(map) { setNodeWeights(Object.assign(getNodeWeights(), map)); }
export function getNodeWeightArray(nodeNames) {
    if (!Array.isArray(nodeNames)) return null;
    const arr = nodeNames.map(getNodeWeight);
    globalThis.__GUI.lastNodeWeightArray = arr;
    return arr;
}
const DEFAULTS = { epipolarDecay:10, reprojSigma:20, epipolarWeight:0.4, reprojWeight:0.6,
    minMatchScore:0.05, prevIdentityBonus:0.3, reprojGate2:100, reprojGate3:140, reprojGate4:180,
    track3dWeight:1, filterMinVisibleNodes:0, filterMinInstanceScore:0, filterMinMeanNodeScore:0, reprojErrorThreshold:50 };
export function getTrackingThreshold(id) {
    const ov = (globalThis.__GUI && globalThis.__GUI.thresholds) || {};
    const v = ov[id];
    return (typeof v === 'number' && isFinite(v)) ? v : DEFAULTS[id];
}
export function getTrackingThresholdDefs() {
    return ['autoImageSwitchCheck', 'imageChangeThreshold'].map(id => ({ id, label: id, value: getTrackingThreshold(id) }));
}
export function updateTrackingThresholds(map) {
    globalThis.__GUI.thresholdsSet = Object.assign({}, map);
}
export function getTrackingThresholds() {
    const out = {}; for (const id in DEFAULTS) out[id] = getTrackingThreshold(id); return out;
}
export function isCameraTracked() { return true; }
// pose/triangulation.js imports this for resolveTriangulationMethod's fallback.
// The stub must export every name the real module exports that any module under
// test imports, or the ESM link step throws before a single assertion runs.
export function getDefaultTriangulationMethod() {
    return (globalThis.__GUI && globalThis.__GUI.triangulationMethod) || 'dlt';
}
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
export function showReprojectionsOnly() { return false; }
export const REPROJ_ONLY_NOTE = '';
export function showPredictedOnly() { return false; }
export const PREDICTED_ONLY_NOTE = '';
`;

const INFO_PANEL_STUB = `
export function updateInfoPanel() { globalThis.__GUI.updateInfoPanel++; }
export function updateTriangulationBadge() {}
`;

const INITIALIZATION_STUB = `
export function update3DViewport() { globalThis.__GUI.update3DViewport++; }
`;

// The first-use dialog (animal count + node weights). Records what it was
// shown and answers with __GUI.trackSetupAnswer (null = Cancel).
const TRACK_SETUP_STUB = `
export const IMAGE_CHECK_IDS = ['autoImageSwitchCheck', 'imageChangeThreshold'];
export function showTrackSetupModal(opts) {
    globalThis.__GUI.trackSetupShown.push(opts);
    const a = globalThis.__GUI.trackSetupAnswer;
    return Promise.resolve(a == null ? null : JSON.parse(JSON.stringify(a)));
}
`;

const STUBS = [
    ['/ui/settings.js', SETTINGS_STUB],
    ['/ui/track-setup-modal.js', TRACK_SETUP_STUB],
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
