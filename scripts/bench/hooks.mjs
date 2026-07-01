// ESM loader hooks for the headless bench driver.
//
// The luc3d tracker (pose/tracker.js + pose/triangulation.js) imports a handful
// of browser/UI modules (app-state, settings, rendering, info-panel, save-load,
// initialization) that pull in the DOM and three.js. We never want to load those
// headlessly — so this hook intercepts those specifiers and serves tiny stub
// modules instead. pose-data.js, triangulation.js and tracker.js themselves load
// REAL and unmodified, so the benchmark exercises the exact production tracker.
//
// The settings stub is the important one: it routes node weights + tracking
// thresholds through globalThis.__BENCH (populated by the driver from --params),
// which is how each benchmark config injects its parameters.

// Default tracking thresholds — kept in sync with TRACKING_THRESHOLDS in
// ui/settings.js. The settings stub falls back to these when a config does not
// override a given id.
const THRESHOLD_DEFAULTS = {
    epipolarDecay: 10,
    reprojSigma: 20,
    epipolarWeight: 0.4,
    reprojWeight: 0.6,
    minMatchScore: 0.05,
    prevIdentityBonus: 0.3,
    reprojGate2: 100,
    reprojGate3: 140,
    reprojGate4: 180,
    track3dWeight: 1,
    filterMinVisibleNodes: 0,
    filterMinInstanceScore: 0,
    corr2dWeight: 1,
    corr3dWeight: 6,
    velocityThreshold: 10,
    distanceThreshold: 50,
    timePenalty: 0.1,
};

const SETTINGS_STUB = `
const THRESHOLD_DEFAULTS = ${JSON.stringify(THRESHOLD_DEFAULTS)};

export function getNodeWeightArray(nodeNames) {
    if (!Array.isArray(nodeNames)) return null;
    const map = (globalThis.__BENCH && globalThis.__BENCH.nodeWeights) || {};
    return nodeNames.map(function (n) {
        const w = map[n];
        return (typeof w === 'number' && isFinite(w)) ? Math.max(0, Math.min(1, w)) : 1;
    });
}

export function getTrackingThreshold(id) {
    const ov = (globalThis.__BENCH && globalThis.__BENCH.thresholds) || {};
    const v = ov[id];
    if (typeof v === 'number' && isFinite(v)) return v;
    return THRESHOLD_DEFAULTS[id];
}

export function getTrackingThresholds() {
    const out = {};
    for (const id in THRESHOLD_DEFAULTS) out[id] = getTrackingThreshold(id);
    return out;
}
`;

// Generic no-op UI stubs. `state` is a plain mutable object; the core matching
// path does not read from it (session is passed explicitly), but the binding
// must exist for the import to resolve.
const APP_STATE_STUB = `
export const state = { session: null, currentFrame: 0 };
export const interactionManager = {};
export const timeline = null;
export const viewport3d = null;
export function getActiveSession() { return state.session; }
`;

const SAVE_LOAD_STUB = `
export function setStatus() {}
export function showLoading() {}
export function hideLoading() {}
export function markDirty() {}
`;

const RENDERING_STUB = `
export function drawAllOverlays() {}
export function setReprojErrorVisible() {}
`;

const INFO_PANEL_STUB = `
export function updateInfoPanel() {}
export function updateTriangulationBadge() {}
`;

const INITIALIZATION_STUB = `
export function update3DViewport() {}
`;

// URL suffix → stub source. First match wins.
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
        if (url.endsWith(suffix)) {
            return { format: 'module', source, shortCircuit: true };
        }
    }
    return nextLoad(url, context);
}
