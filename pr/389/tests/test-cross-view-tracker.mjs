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

group('Soft gate — the gate\'s split with "no match" at a cost: off by default, 0 is off, the gate wins');
{
    // The same scene as above, run with the soft gate. The reflection costs A's
    // target far more than SOFT, so A's target refuses it instead of being
    // forced onto it, exactly as with the gate.
    const SOFT = 100;
    function run(extra) {
        const trk = new CrossViewTracker(Object.assign({ maxTargets: 3 }, GATE_HP, extra));
        const A = [-7, 0, 48], B = [7, 0, 48], G = [0, 8, 48];
        const three = [nodes3d(A), nodes3d(B), nodes3d(G)];
        trk.trackFrame(viewDets(0, { c0: three, c1: three, c2: three }), CAMS);
        const tA = nearestTarget(trk, A), tG = nearestTarget(trk, G);
        const C0 = [0, 0, -40];
        tG.points3d = Float64Array.from(nodes3d(A).flatMap(p => {
            const v = p.map((x, i) => x - C0[i]), L = Math.hypot(...v);
            return [p[0] + 8 * v[0] / L + 1, p[1] + 8 * v[1] / L, p[2] + 8 * v[2] / L];
        }));
        const reflection = nodes3d([A[0], A[1] - 30, A[2]]);
        const costs = [tA, tG].map(t => [0, 2].map(k => -trk._adjacency(t, det(CAMS[0], 1, k, k === 0 ? nodes3d(A) : reflection), CAMS[0])));
        trk.trackFrame(viewDets(1, {
            c0: [nodes3d(A), nodes3d(B), reflection],
            c1: [nodes3d(A), nodes3d(B)],
            c2: [nodes3d(A), nodes3d(B)],
        }), CAMS);
        return { a: tA.detsByCam.get('c0'), g: tG.detsByCam.get('c0'), costs };
    }
    const soft = run({ softGate: SOFT });
    ok(soft.costs[0][1] > SOFT && soft.costs[1][1] > SOFT, `fixture: the reflection costs both targets more than ${SOFT} (${soft.costs[0][1].toFixed(0)}, ${soft.costs[1][1].toFixed(0)})`);
    ok(soft.costs[0][0] < SOFT && soft.costs[1][0] < SOFT, 'fixture: A\'s detection costs both targets less than it');
    ok(soft.a.frameIdx === 1 && soft.a.slot === 0, 'soft gate: A\'s target keeps A\'s detection');
    eq(soft.g.frameIdx, 0, 'soft gate: the spare target is left unmatched this frame');
    for (const [extra, what] of [[{}, 'absent'], [{ softGate: 0 }, '0']]) {
        const r = run(extra);
        eq(r.a.slot, 2, `soft gate ${what}: the forced assignment, unchanged (A's target on the reflection)`);
    }
    // With the gate on, its cost of 0 is what applies: a soft gate of 1e6 would
    // let the spare keep taking A, so this run tells the two apart.
    const both = run({ matchGate: 1, softGate: 1e6 }), gate = run({ matchGate: 1 });
    ok(both.a.slot === gate.a.slot && both.a.frameIdx === gate.a.frameIdx && both.g.frameIdx === gate.g.frameIdx,
        'gate on + soft gate = the gate alone');
}

group('Soft gate — a LOST target still re-acquires far away (lost targets are never gated)');
{
    const trk = new CrossViewTracker(Object.assign({ maxTargets: 2, stale: 20, softGate: 10 }, GATE_HP));
    const A = [-7, 0, 48], B = [7, 0, 48], A2 = [-7, 12, 48];
    const both = [nodes3d(A), nodes3d(B)];
    for (let f = 0; f < 3; f++) trk.trackFrame(viewDets(f, { c0: both, c1: both, c2: both }), CAMS);
    const tA = nearestTarget(trk, A);
    const onlyB = [nodes3d(B)];
    for (let f = 3; f < 31; f++) trk.trackFrame(viewDets(f, { c0: onlyB, c1: onlyB, c2: onlyB }), CAMS);
    const back = [nodes3d(A2), nodes3d(B)];
    const far = -trk._adjacency(tA, det(CAMS[0], 31, 0, nodes3d(A2)), CAMS[0]);
    ok(far > 10, `fixture: A's new position costs its lost target more than the soft gate (${far.toFixed(0)})`);
    trk.trackFrame(viewDets(31, { c0: back, c1: back, c2: back }), CAMS);
    eq(tA.detsByCam.size, 3, 'the lost target re-acquired A in all three views');
}

group('Hold bonus — two near-tied targets stop trading one detection back and forth');
{
    // A and B are seen in c1 and c2 throughout; c0 sees ONE detection, roughly
    // between them, that drifts back and forth across the middle (the overlap a
    // missing animal leaves in one view). Without the bonus it changes hands
    // whenever it crosses; with it, the target that took it keeps it. The swing
    // has to cross the middle by enough to flip a target that was just pulled
    // toward it (±0.7 does not) while each step stays inside the hold radius
    // (0.02 normalized: 1.6 units at c0's ~88 depth is ~0.018; ±0.9 is not).
    const A = [-3, 0, 48], B = [3, 0, 48];
    const xs = [-0.8, 0.8, -0.8, 0.8, -0.8, 0.8];
    function run(extra) {
        const trk = new CrossViewTracker(Object.assign({ maxTargets: 2 }, GATE_HP, { distanceThreshold: 50 }, extra));
        const both = [nodes3d(A), nodes3d(B)];
        trk.trackFrame(viewDets(0, { c0: both, c1: both, c2: both }), CAMS);
        const tA = nearestTarget(trk, A), owners = [];
        xs.forEach((x, i) => {
            const f = i + 1;
            trk.trackFrame(viewDets(f, { c0: [nodes3d([x, 0, 48])], c1: both, c2: both }), CAMS);
            const d = tA.detsByCam.get('c0');
            owners.push(d.frameIdx === f ? 'A' : 'B');
        });
        return owners.join('');
    }
    const off = run({}), on = run({ holdBonus: 30 });
    ok(/AB|BA/.test(off), `without the bonus the detection changes hands (${off})`);
    ok(/^(A+|B+)$/.test(on), `with a hold bonus of 30 one target keeps it (${on})`);
    eq(run({ holdBonus: 0 }), off, 'a hold bonus of 0 is off');
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

group('Score caches — rays per detection, projection per target: same scores, recomputed when the inputs change');
{
    // Two animals born at frame 0, then scored against frame-1 detections in a camera of their own (so moving
    // it touches nothing else). The caches change no arithmetic, only how often it runs — so every score must
    // equal the one built from scratch: fresh Detections over the SAME pixel keypoints (re-projecting the 3D
    // through a moved camera would change the inputs, not test the cache), and the targets' cache dropped.
    const trk = new CrossViewTracker();
    const A = [0, 0, 0], B = [9, 0, 0];
    trk.trackFrame(frameDetections(0, [A, B]), CAMS);
    const [tA, tB] = trk.targets;
    const cam = makeCam('cx', [0, 0.2, 0.1], [-6, 2, 42]);
    const mkDets = () => [A, B].map((c, i) => det(cam, 1, i, nodes3d([c[0] + 0.4, c[1] - 0.3, c[2]])));
    const scores = (dets) => [tA, tB].map(t => dets.map(d => trk._adjacency(t, d, cam)));
    const fresh = () => { tA._proj = null; tB._proj = null; return scores(dets.map(d => new Detection(d.instance, d.cam, d.frameIdx, d.slot))); };
    const same = (x, y) => x.every((row, i) => row.every((v, j) => Object.is(v, y[i][j])));
    const dets = mkDets();
    const s1 = scores(dets), s2 = scores(dets);
    ok(same(s1, s2) && same(s1, fresh()), 'scoring twice, and scoring from scratch, give identical numbers');
    ok(dets.every(d => d._rays !== null) && tA._proj !== null, 'and the caches were filled (rays on each detection, projection on each target)');

    // A moved camera (Camera.setExtrinsics replaces its extrinsic matrix) must recast the cached rays
    const before = scores(dets);
    cam.setExtrinsics([0, 0.25, 0.05], [-5, 1, 44]);
    const moved = scores(dets);
    ok(!same(before, moved), 'control: moving the camera changes the scores');
    ok(same(moved, fresh()), 'the SAME detections, scored after the move, match freshly built ones exactly (rays recast, projection redone)');

    // A replaced points3d (only _retriangulate assigns it, never edits it) must be re-projected
    const p3 = scores(dets);
    tA.points3d = Float64Array.from(tB.points3d);
    const swapped = scores(dets);
    ok(!same(p3, swapped), 'control: replacing a target\'s 3D changes its scores');
    ok(same(swapped, fresh()), 'and the cached projection follows it exactly');
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
