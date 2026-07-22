/**
 * test-cross-view-tracker.mjs — algorithm tests for the
 * `CrossViewTracker` (pose/cross-view-tracker.js). Drives the real class
 * headlessly (UI stubbed via scripts/bench/hooks.mjs) on a synthetic
 * multi-animal × multi-view scene and checks births, 3D fusion, and identity
 * continuity across frames.
 *
 * Run:  node tests/test-cross-view-tracker.mjs
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const POSE_DIR = path.join(ROOT, 'pose');

let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
function eq(a, e, m) { ok(a === e, `${m} (expected ${e}, got ${a})`); }
function group(n) { console.log('\n• ' + n); }

globalThis.__BENCH = { nodeWeights: {}, thresholds: {} };
globalThis.document = { getElementById: () => null };
globalThis.window = globalThis;

register(pathToFileURL(path.join(ROOT, 'scripts', 'bench', 'hooks.mjs')).href);
const { Camera, Instance } = await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);
const { CrossViewTracker, Detection } =
    await import(pathToFileURL(path.join(POSE_DIR, 'cross-view-tracker.js')).href);

// --- synthetic rig (same three well-separated views as the other tracker tests) ---
function makeCam(name, rvec, tvec) {
    return new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
}
// Non-degenerate rig: no camera sits at the world origin ([I|0] would make the
// back-projection pinv produce a point at infinity), so the 3D point-to-ray term
// is genuinely exercised.
const CAMS = [
    makeCam('c0', [0, 0, 0], [0, 0, 40]),
    makeCam('c1', [0, 0.35, 0], [-12, 0, 43]),
    makeCam('c2', [0.35, 0, 0], [0, -12, 43]),
];
const OFFSETS = [[0, 0, 0], [2, 1, 0], [-2, 1, 0], [0, -2, 1], [1.5, 0, -1.5], [-1.5, 0, 1.5]];
function nodes3d(centroid) { return OFFSETS.map(o => [centroid[0] + o[0], centroid[1] + o[1], centroid[2] + o[2]]); }

// Build Map(camName -> Detection[]) for a frame from animal 3D centroids.
function frameDetections(frameIdx, centroids) {
    const detsByCam = new Map();
    CAMS.forEach(cam => {
        const dets = [];
        centroids.forEach((ctr, ai) => {
            const pixels = nodes3d(ctr).map(p => cam.project(p));         // raw pixel keypoints
            const inst = new Instance(pixels, ai, 'predicted', 1.0);
            dets.push(new Detection(inst, cam, frameIdx, ai));
        });
        detsByCam.set(cam.name, dets);
    });
    return detsByCam;
}
function centroidOf(pts3d) {
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const p of pts3d) if (p) { sx += p[0]; sy += p[1]; sz += p[2]; n++; }
    return n ? [sx / n, sy / n, sz / n] : null;
}
function dist3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
const HP = { corr2dWeight: 1, corr3dWeight: 6, velocityThreshold: 10, distanceThreshold: 50, timePenalty: 0.1 };

// ===========================================================================
group('Births — 2 animals × 3 views → 2 fused 3D targets');
{
    const trk = new CrossViewTracker(HP);
    const A = [-7, 0, 48], B = [7, 0, 48];
    trk.trackFrame(frameDetections(0, [A, B]), CAMS);

    eq(trk.targets.length, 2, 'exactly two targets born');
    trk.targets.forEach((t, i) => {
        eq(t.detsByCam.size, 3, `target ${i} fused across all 3 views`);
        ok(t.points3d && t.points3d.every(p => p != null), `target ${i} fully triangulated`);
    });
    // Triangulated centroids land on the two true animal locations.
    const cents = trk.targets.map(t => centroidOf(t.points3d));
    const nearA = Math.min(...cents.map(c => dist3(c, A)));
    const nearB = Math.min(...cents.map(c => dist3(c, B)));
    ok(nearA < 1.0, `a target sits on animal A (err ${nearA.toFixed(3)})`);
    ok(nearB < 1.0, `a target sits on animal B (err ${nearB.toFixed(3)})`);
}

// ===========================================================================
group('Identity continuity — animals move, no new births, tracks stable');
{
    const trk = new CrossViewTracker(HP);
    trk.trackFrame(frameDetections(0, [[-7, 0, 48], [7, 0, 48]]), CAMS);
    const idsAfterF0 = trk.targets.map(t => t.trackId).sort((a, b) => a - b);
    // Which trackId is the left animal?
    const leftId0 = trk.targets.reduce((best, t) =>
        centroidOf(t.points3d)[0] < centroidOf(best.points3d)[0] ? t : best).trackId;

    // Frame 1: both drift toward the midline but stay separated.
    trk.trackFrame(frameDetections(1, [[-4, 0, 48], [4, 0, 48]]), CAMS);
    eq(trk.targets.length, 2, 'still exactly two targets (no spurious births)');
    const idsAfterF1 = trk.targets.map(t => t.trackId).sort((a, b) => a - b);
    eq(JSON.stringify(idsAfterF1), JSON.stringify(idsAfterF0), 'the same two track ids persist');

    const leftId1 = trk.targets.reduce((best, t) =>
        centroidOf(t.points3d)[0] < centroidOf(best.points3d)[0] ? t : best).trackId;
    eq(leftId1, leftId0, 'the left animal keeps its track id across the frame');
    // Targets followed the motion.
    const leftT = trk.targets.find(t => t.trackId === leftId1);
    ok(Math.abs(centroidOf(leftT.points3d)[0] - (-4)) < 1.0, 'left target tracked to its new position');
}

// ===========================================================================
group('Determinism — same inputs + weight → identical assignment');
{
    function run() {
        const trk = new CrossViewTracker(HP);
        trk.trackFrame(frameDetections(0, [[-7, 0, 48], [7, 0, 48]]), CAMS);
        trk.trackFrame(frameDetections(1, [[-5, 1, 47], [5, -1, 49]]), CAMS);
        return trk.targets.map(t => [t.trackId, centroidOf(t.points3d).map(v => v.toFixed(2)).join(',')]);
    }
    eq(JSON.stringify(run()), JSON.stringify(run()), 'two runs produce identical targets');
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
