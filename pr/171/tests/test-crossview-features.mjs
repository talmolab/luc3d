/**
 * test-crossview-features.mjs — tests for LUCID's extensions to the
 * `CrossViewTracker` (pose/cross-view-tracker.js) that are NOT in the sleap-3d
 * reference: the `maxTargets` target cap and per-node association weights.
 * Drives the real class headlessly (UI stubbed via scripts/bench/hooks.mjs).
 *
 * Run:  node tests/test-crossview-features.mjs
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

// --- synthetic rig (same well-separated three views as the other tracker tests) ---
function makeCam(name, rvec, tvec) {
    return new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
}
const CAMS = [
    makeCam('c0', [0, 0, 0], [0, 0, 40]),
    makeCam('c1', [0, 0.35, 0], [-12, 0, 43]),
    makeCam('c2', [0.35, 0, 0], [0, -12, 43]),
];
const OFFSETS = [[0, 0, 0], [2, 1, 0], [-2, 1, 0], [0, -2, 1], [1.5, 0, -1.5], [-1.5, 0, 1.5]];
function nodes3d(centroid) { return OFFSETS.map(o => [centroid[0] + o[0], centroid[1] + o[1], centroid[2] + o[2]]); }
function frameDetections(frameIdx, centroids) {
    const detsByCam = new Map();
    CAMS.forEach(cam => {
        const dets = [];
        centroids.forEach((ctr, ai) => {
            const pixels = nodes3d(ctr).map(p => cam.project(p));
            dets.push(new Detection(new Instance(pixels, ai, 'predicted', 1.0), cam, frameIdx, ai));
        });
        detsByCam.set(cam.name, dets);
    });
    return detsByCam;
}
const HP = { corr2dWeight: 1, corr3dWeight: 6, velocityThreshold: 10, distanceThreshold: 50, timePenalty: 0.1 };

// Three well-separated animals.
const THREE = [[-8, 0, 48], [0, 0, 48], [8, 0, 48]];

// ===========================================================================
group('maxTargets — cap stops births at the animal count');
{
    // Uncapped: three animals in three views → three targets born.
    const uncapped = new CrossViewTracker(HP);
    uncapped.trackFrame(frameDetections(0, THREE), CAMS);
    eq(uncapped.targets.length, 3, 'uncapped tracker births one target per animal (3)');

    // Cap at 2: births stop once two targets exist, even with a third animal present.
    const capped = new CrossViewTracker(Object.assign({}, HP, { maxTargets: 2 }));
    capped.trackFrame(frameDetections(0, THREE), CAMS);
    ok(capped.targets.length <= 2, `maxTargets:2 caps live targets at 2 (got ${capped.targets.length})`);
    eq(capped.targets.length, 2, 'exactly two targets under the cap');

    // Cap persists across frames — no new births on later frames either.
    capped.trackFrame(frameDetections(1, THREE), CAMS);
    ok(capped.targets.length <= 2, `cap still holds on frame 1 (got ${capped.targets.length})`);

    // A non-positive / non-numeric cap is treated as "no cap" (null).
    const bad = new CrossViewTracker(Object.assign({}, HP, { maxTargets: 0 }));
    eq(bad.maxTargets, null, 'maxTargets:0 → null (uncapped)');
    const nan = new CrossViewTracker(Object.assign({}, HP, { maxTargets: 'x' }));
    eq(nan.maxTargets, null, 'maxTargets:"x" → null (uncapped)');
    const frac = new CrossViewTracker(Object.assign({}, HP, { maxTargets: 2.9 }));
    eq(frac.maxTargets, 2, 'maxTargets floors to an integer');
}

// ===========================================================================
group('nodeWeights — per-node association weight (_nodeWeight mapping)');
{
    const w = new CrossViewTracker(Object.assign({}, HP, { nodeWeights: [1, 0, 0.5] }));
    eq(w._nodeWeight(0), 1, 'weight[0] = 1');
    eq(w._nodeWeight(1), 0, 'weight[1] = 0');
    eq(w._nodeWeight(2), 0.5, 'weight[2] = 0.5');
    eq(w._nodeWeight(9), 1, 'out-of-range index defaults to 1');

    const none = new CrossViewTracker(HP);
    eq(none.nodeWeights, null, 'no nodeWeights → null');
    eq(none._nodeWeight(0), 1, 'null weights ⇒ every node weighted 1');

    const bad = new CrossViewTracker(Object.assign({}, HP, { nodeWeights: 'nope' }));
    eq(bad.nodeWeights, null, 'non-array nodeWeights → null');
}

// ===========================================================================
group('nodeWeights — weights actually scale the association cost');
{
    // Establish one target from a single animal across all three views.
    const base = new CrossViewTracker(HP);
    base.trackFrame(frameDetections(0, [[0, 0, 48]]), CAMS);
    eq(base.targets.length, 1, 'one target established for the cost probe');
    const target = base.targets[0];

    // A fresh detection of the same animal in c0 at the next frame.
    const det = frameDetections(1, [[0, 0, 48]]).get('c0')[0];
    const nNodes = det.pointsNorm.length;

    // All-ones weights must equal the null (unweighted) baseline.
    const unweighted = new CrossViewTracker(HP);
    const ones = new CrossViewTracker(Object.assign({}, HP, { nodeWeights: new Array(nNodes).fill(1) }));
    const a2dBase = unweighted._adjacency2d(target, det, 1);
    const a2dOnes = ones._adjacency2d(target, det, 1);
    const a3dBase = unweighted._adjacency3d(target, det, det.cam);
    const a3dOnes = ones._adjacency3d(target, det, det.cam);
    ok(Math.abs(a2dBase - a2dOnes) < 1e-9, 'all-ones weights == unweighted 2D cost');
    ok(Math.abs(a3dBase - a3dOnes) < 1e-9, 'all-ones weights == unweighted 3D cost');

    // All-zero weights drop every node → both cost terms are exactly 0.
    const zeros = new CrossViewTracker(Object.assign({}, HP, { nodeWeights: new Array(nNodes).fill(0) }));
    eq(zeros._adjacency2d(target, det, 1), 0, 'all-zero weights ⇒ 2D cost 0');
    eq(zeros._adjacency3d(target, det, det.cam), 0, 'all-zero weights ⇒ 3D cost 0');

    // Dropping a single node changes the cost (that node did contribute).
    const dropOne = new Array(nNodes).fill(1); dropOne[0] = 0;
    const one0 = new CrossViewTracker(Object.assign({}, HP, { nodeWeights: dropOne }));
    ok(one0._adjacency2d(target, det, 1) !== a2dBase, 'zeroing one node changes the 2D cost');
    ok(one0._adjacency3d(target, det, det.cam) !== a3dBase, 'zeroing one node changes the 3D cost');
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
