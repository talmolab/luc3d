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
// `Target.points3d` is a FLAT `Float64Array(3N)` (luc3d #189), not an array of
// boxed `[x,y,z]` rows, and a missing keypoint is NaN rather than null. Iterating
// it with `for (const p of pts3d)` yields NUMBERS, so `p[0]` was `undefined` and
// every centroid came out NaN — which is why these assertions failed against a
// perfectly healthy tracker. Boxed input is still accepted for older callers.
function centroidOf(pts3d) {
    if (!pts3d) return null;
    let sx = 0, sy = 0, sz = 0, n = 0;
    if (ArrayBuffer.isView(pts3d)) {
        for (let k = 0; k + 2 < pts3d.length; k += 3) {
            const x = pts3d[k], y = pts3d[k + 1], z = pts3d[k + 2];
            if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                sx += x; sy += y; sz += z; n++;
            }
        }
    } else {
        for (const p of pts3d) if (p) { sx += p[0]; sy += p[1]; sz += p[2]; n++; }
    }
    return n ? [sx / n, sy / n, sz / n] : null;
}

/** Count of fully-finite keypoints in a flat-or-boxed 3D point set. */
function nFinite3d(pts3d) {
    if (!pts3d) return 0;
    let n = 0;
    if (ArrayBuffer.isView(pts3d)) {
        for (let k = 0; k + 2 < pts3d.length; k += 3) {
            if (Number.isFinite(pts3d[k]) && Number.isFinite(pts3d[k + 1]) && Number.isFinite(pts3d[k + 2])) n++;
        }
    } else {
        for (const p of pts3d) if (p && p.every(Number.isFinite)) n++;
    }
    return n;
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
        // NOT `.every(p => p != null)`: on a Float64Array that iterates NUMBERS,
        // and `NaN != null` is true — so an entirely NaN (i.e. completely
        // un-triangulated) point set passed this check. Count finite keypoints.
        ok(nFinite3d(t.points3d) === OFFSETS.length,
            `target ${i} fully triangulated (${nFinite3d(t.points3d)}/${OFFSETS.length} finite)`);
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

// ===========================================================================
// Match gate (pose/cross-view-tracker.js, "THE MATCH GATE"). Detections built
// from arbitrary per-camera 3D point sets, so a view can carry an extra
// detection (a "reflection") the other views do not.
function det(cam, frameIdx, slot, pts3) {
    return new Detection(new Instance(pts3.map(p => cam.project(p)), slot, 'predicted', 1.0), cam, frameIdx, slot);
}
function viewDets(frameIdx, perCam) {
    const m = new Map();
    CAMS.forEach(c => m.set(c.name, (perCam[c.name] || []).map((p, i) => det(c, frameIdx, i, p))));
    return m;
}
function nearestTarget(trk, c) {
    return trk.targets.reduce((b, t) => dist3(centroidOf(t.points3d), c) < dist3(centroidOf(b.points3d), c) ? t : b);
}
const GATE_HP = { corr2dWeight: 1, corr3dWeight: 6, velocityThreshold: 10, distanceThreshold: 5, timePenalty: 0.1 };

group('Match gate — a spare target cannot trade an animal onto a reflection');
{
    // The real-data failure (5-mouse recording, frame 3,620, Camera4_topR) in
    // miniature: a spare target sits right behind animal A along c0's viewing
    // rays, so in c0 it scores almost as well on A's detection as A's own
    // target does — and a reflection appears in c0 only, far from both. Forced
    // assignment (gate off) must place all three targets; giving A's detection
    // to the spare and the reflection to A costs slightly less in total, so A's
    // target is moved onto the reflection.
    function run(matchGate) {
        const trk = new CrossViewTracker(Object.assign({ maxTargets: 3, matchGate }, GATE_HP));
        const A = [-7, 0, 48], B = [7, 0, 48], G = [0, 8, 48];
        const three = [nodes3d(A), nodes3d(B), nodes3d(G)];
        trk.trackFrame(viewDets(0, { c0: three, c1: three, c2: three }), CAMS);
        const tA = nearestTarget(trk, A), tG = nearestTarget(trk, G);
        // White-box: park the spare 8 units behind A along c0's rays (+1 to the side).
        const C0 = [0, 0, -40];
        tG.points3d = Float64Array.from(nodes3d(A).flatMap(p => {
            const v = p.map((x, i) => x - C0[i]), L = Math.hypot(...v);
            return [p[0] + 8 * v[0] / L + 1, p[1] + 8 * v[1] / L, p[2] + 8 * v[2] / L];
        }));
        const reflection = nodes3d([A[0], A[1] - 30, A[2]]);
        trk.trackFrame(viewDets(1, {
            c0: [nodes3d(A), nodes3d(B), reflection],   // slot 2 = the reflection
            c1: [nodes3d(A), nodes3d(B)],
            c2: [nodes3d(A), nodes3d(B)],
        }), CAMS);
        return { a: tA.detsByCam.get('c0'), g: tG.detsByCam.get('c0') };
    }
    const off = run(0);
    eq(off.a.slot, 2, 'gate OFF reproduces the bug: A\'s target is forced onto the reflection');
    ok(off.g.frameIdx === 1 && off.g.slot === 0, 'gate OFF: the spare target takes A\'s real detection');
    const on = run(1);
    ok(on.a.frameIdx === 1 && on.a.slot === 0, 'gate ON: A\'s target keeps A\'s detection');
    eq(on.g.frameIdx, 0, 'gate ON: the spare target is left unmatched this frame');
}

group('Match gate — a LOST target still re-acquires its animal far from where it vanished');
{
    // Animal A disappears for longer than `stale`, so every one of its target's
    // detections is evicted, then reappears 12 units away (well beyond the 5-unit
    // distance threshold, so the adjacency is negative). The cap stops a new
    // birth; only the ungated lost-target stage can pick A back up.
    const trk = new CrossViewTracker(Object.assign({ maxTargets: 2, stale: 20 }, GATE_HP));
    const A = [-7, 0, 48], B = [7, 0, 48], A2 = [-7, 12, 48];
    const both = [nodes3d(A), nodes3d(B)];
    for (let f = 0; f < 3; f++) trk.trackFrame(viewDets(f, { c0: both, c1: both, c2: both }), CAMS);
    const tA = nearestTarget(trk, A);
    const onlyB = [nodes3d(B)];
    for (let f = 3; f < 31; f++) trk.trackFrame(viewDets(f, { c0: onlyB, c1: onlyB, c2: onlyB }), CAMS);
    eq(tA.detsByCam.size, 0, 'A\'s target is lost (every detection evicted as stale)');
    const back = [nodes3d(A2), nodes3d(B)];
    trk.trackFrame(viewDets(31, { c0: back, c1: back, c2: back }), CAMS);
    eq(trk.targets.length, 2, 'no extra target was born');
    eq(tA.detsByCam.size, 3, 'the lost target re-acquired A in all three views');
    ok(dist3(centroidOf(tA.points3d), A2) < 1.0, 'and re-triangulated at A\'s new position');
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
