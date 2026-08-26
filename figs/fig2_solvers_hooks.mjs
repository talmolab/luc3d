/**
 * ESM loader hooks for figs/fig4_measure.mjs.
 *
 * WHY THIS EXISTS RATHER THAN REUSING scripts/bench/hooks.mjs. The bundle-adj
 * branch's pose/triangulation.js imports `getDefaultTriangulationMethod` from
 * ui/settings.js, but that branch's own bench stub does not export it, so
 * importing pose/triangulation.js through those hooks fails at link time with
 *
 *   SyntaxError: The requested module '../ui/settings.js' does not provide an
 *   export named 'getDefaultTriangulationMethod'
 *
 * which also means `scripts/bench/bench_crossview.mjs` is currently broken on
 * that branch. Rather than edit someone else's in-progress branch, this file
 * carries the stubs with the missing export added. If that branch's stub is
 * fixed, this file can be deleted in favour of scripts/bench/hooks.mjs.
 *
 * ESM is linked by NAME, so a catch-all Proxy cannot stand in for a stub: each
 * stub has to declare exactly the bindings its importer asks for. The list below
 * is therefore derived from `grep '^import' pose/triangulation.js` and will need
 * updating if that import list grows.
 *
 * pose/triangulation.js and pose/pose-data.js load REAL and unmodified — the
 * measurement exercises the production solvers. pose-data.js has no imports of
 * its own, so only triangulation.js's dependencies need stubbing.
 */
const THRESHOLD_DEFAULTS = {
    epipolarDecay: 10, reprojSigma: 20, epipolarWeight: 0.4, reprojWeight: 0.6,
    minMatchScore: 0.05, prevIdentityBonus: 0.3, reprojGate2: 100, reprojGate3: 140,
    reprojGate4: 180, track3dWeight: 1, filterMinVisibleNodes: 0,
    filterMinInstanceScore: 0, corr2dWeight: 1, corr3dWeight: 6,
    velocityThreshold: 10, distanceThreshold: 50, timePenalty: 0.1,
    // 0 = robust re-triangulation disabled, matching ui/settings.js's default, so
    // the measurement compares plain DLT against plain BA.
    reprojErrorThreshold: 0,
};

const STUBS = new Map([
    ['/ui/settings.js', `
const THRESHOLD_DEFAULTS = ${JSON.stringify(THRESHOLD_DEFAULTS)};
export function getTrackingThreshold(id) {
    const ov = (globalThis.__BENCH && globalThis.__BENCH.thresholds) || {};
    const v = ov[id];
    if (typeof v === 'number' && isFinite(v)) return v;
    return THRESHOLD_DEFAULTS[id];
}
export function isCameraTracked() { return true; }
// The export the branch's own stub is missing. 'dlt' is the app's real default
// (ui/settings.js DEFAULTS.triangulationMethod); the stub must not hand back 'ba'
// and quietly flatter the method under test.
export function getDefaultTriangulationMethod() {
    return (globalThis.__BENCH && globalThis.__BENCH.triangulationMethod) || 'dlt';
}
`],
    ['/ui/app-state.js', `
export const state = { session: null, currentFrame: 0, triangulationResults: new Map() };
export const timeline = null;
export const viewport3d = null;
`],
    ['/ui/rendering.js', `
export function setReprojErrorVisible() {}
export function drawAllOverlays() {}
`],
    ['/ui/info-panel.js', `
export function updateTriangulationBadge() {}
`],
    ['/import-export/save-load.js', `
export function markDirty() {}
export function setStatus() {}
export function showLoading() {}
export function hideLoading() {}
`],
    ['/pose/initialization.js', `
export function update3DViewport() {}
`],
]);

export async function load(url, context, next) {
    for (const [suffix, source] of STUBS) {
        if (url.endsWith(suffix)) {
            return { format: 'module', source, shortCircuit: true };
        }
    }
    return next(url, context);
}
