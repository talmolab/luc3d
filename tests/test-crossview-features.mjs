/**
 * test-crossview-features.mjs — tests for LUCID's extensions to the
 * `CrossViewTracker` (pose/cross-view-tracker.js) that are NOT in the sleap-3d
 * reference: the `maxTargets` target cap, per-node association weights and the
 * misplaced-node options.
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

// --- a misplaced node: one view's 2D for node `k` moved `dy` pixels ---
function misplaced(det, k, dy) {
    const px = det.instance.toPointsArray();
    px[k] = [px[k][0], px[k][1] + dy];
    return new Detection(new Instance(px, det.instance.trackIdx, 'predicted', 1.0), det.cam, det.frameIdx, det.slot);
}
const finite3 = (p, k) => Number.isFinite(p[3 * k]) && Number.isFinite(p[3 * k + 1]) && Number.isFinite(p[3 * k + 2]);
const dist3 = (p, k, q) => Math.hypot(p[3 * k] - q[0], p[3 * k + 1] - q[1], p[3 * k + 2] - q[2]);

// ===========================================================================
group('maxPenalty — a node far from the ray costs at most maxPenalty x corr3d');
{
    // distanceThreshold 1 in this rig's units, so 300 px is ~24 thresholds off.
    const H = Object.assign({}, HP, { distanceThreshold: 1 });
    const base = new CrossViewTracker(H);
    base.trackFrame(frameDetections(0, [[0, 0, 48]]), CAMS);
    const target = base.targets[0];
    const good = frameDetections(1, [[0, 0, 48]]).get('c0')[0];
    const bad = misplaced(good, 0, 300);   // node 0 pulled 300 px off its animal

    const off = new CrossViewTracker(H);
    const zero = new CrossViewTracker(Object.assign({}, H, { maxPenalty: 0 }));
    const cap = new CrossViewTracker(Object.assign({}, H, { maxPenalty: 4 }));
    eq(off.maxPenalty, 0, 'maxPenalty unset → 0 (off)');
    eq(zero._adjacency3d(target, bad, bad.cam), off._adjacency3d(target, bad, bad.cam), 'maxPenalty 0 == today\'s 3D cost');
    eq(cap._adjacency3d(target, good, good.cam), off._adjacency3d(target, good, good.cam),
        'nodes near their rays: cost unchanged by the floor');
    // Each good node sits on its ray and scores corr3d, so the bad node's
    // term is the total minus five of those.
    const rest = 5 * H.corr3dWeight;
    ok(off._adjacency3d(target, bad, bad.cam) - rest < -10 * H.corr3dWeight,
        'without the floor the misplaced node costs over 10 x corr3d (precondition)');
    ok(Math.abs(cap._adjacency3d(target, bad, bad.cam) - (rest - 4 * H.corr3dWeight)) < 1e-6,
        'with maxPenalty 4 it costs exactly -4 x corr3d');
}

// ===========================================================================
group('matchReproj — the target is matched against 3D its views agree on');
{
    const truth = nodes3d([0, 0, 48]);
    const dets = frameDetections(0, [[0, 0, 48]]);
    dets.set('c2', [misplaced(dets.get('c2')[0], 0, 80)]);   // node 0 wrong in one of three views

    const off = new CrossViewTracker(HP);
    off.trackFrame(dets, CAMS);
    const t0 = off.targets[0];
    eq(t0.match3d, null, 'matchReproj off: no separate match3d');
    ok(dist3(t0.points3d, 0, truth[0]) > 0.5, 'plain DLT: node 0 pulled off by the bad view (precondition)');

    const on = new CrossViewTracker(Object.assign({}, HP, { matchReproj: 20 }));
    on.trackFrame(dets, CAMS);
    const t1 = on.targets[0];
    ok(t1.match3d instanceof Float64Array, 'matchReproj 20: match3d is set');
    ok(dist3(t1.match3d, 0, truth[0]) < 1e-6, 'node 0 solved again from the two views that agree');
    ok(dist3(t1.match3d, 1, truth[1]) < 1e-6, 'a node whose views agree is kept');
    ok(t1.points3d.every((v, i) => Object.is(v, t0.points3d[i])), 'points3d (written to the group) is still the plain DLT');

    // Two views that disagree: nothing to drop down to, so the node is dropped.
    const two = new CrossViewTracker(Object.assign({}, HP, { matchReproj: 20 }));
    const d2 = frameDetections(0, [[0, 0, 48]]);
    d2.set('c1', [misplaced(d2.get('c1')[0], 0, 80)]);
    d2.set('c2', []);
    two.trackFrame(d2, CAMS);
    ok(!finite3(two.targets[0].match3d, 0), '2 views over the threshold: node dropped from match3d');
    ok(finite3(two.targets[0].match3d, 1), '...the others kept');
    ok(finite3(two.targets[0].points3d, 0), '...and points3d still has it');
}

// ===========================================================================
group('matchReproj — match3d is bit-identical to solving every trial from scratch');
{
    // checkedPoints3d leaves views out through DltViewSystem and takes trials
    // and views worst first. Neither may change a single bit: this is the
    // original implementation, verbatim (one triangulatePointDLT per trial,
    // trials and views in index order), run on the target's own inputs.
    const { triangulatePointDLT, reprojectPoint } =
        await import(pathToFileURL(path.join(POSE_DIR, 'triangulation-core.js')).href);
    function viewErrors(p, obs, exts, dets, use, out) {
        for (var v = 0; v < obs.length; v++) {
            if (!use[v]) { out[v] = -1; continue; }
            if (p == null) { out[v] = Infinity; continue; }
            var q = reprojectPoint(p, exts[v]), K = dets[v].cam.matrix;
            var dx = (q[0] - obs[v][0]) * K[0][0], dy = (q[1] - obs[v][1]) * K[1][1];
            var e = Math.sqrt(dx * dx + dy * dy);
            out[v] = isFinite(e) ? e : Infinity;
        }
        return out;
    }
    function maxOf(a) { var m = -1; for (var i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }
    function referenceChecked(points3d, allObs, exts, dets, thresh) {
        var out = new Float64Array(points3d), V = dets.length;
        var use = new Array(V), err = new Array(V), trialErr = new Array(V);
        for (var k = 0; k < allObs.length; k++) {
            var obs = allObs[k], n = 0;
            for (var v = 0; v < V; v++) { use[v] = obs[v] != null; if (use[v]) n++; }
            if (!finite3(points3d, k)) continue;
            var X = [points3d[3 * k], points3d[3 * k + 1], points3d[3 * k + 2]];
            viewErrors(X, obs, exts, dets, use, err);
            while (n > 2 && maxOf(err) > thresh) {
                var best = -1, bestErr = Infinity, bestX = null;
                for (var drop = 0; drop < V; drop++) {
                    if (!use[drop]) continue;
                    use[drop] = false;
                    var trial = obs.map(function (o, i) { return use[i] ? o : null; });
                    var Xt = triangulatePointDLT(trial, exts);
                    var e = maxOf(viewErrors(Xt, obs, exts, dets, use, trialErr));
                    if (Xt == null) e = Infinity;
                    use[drop] = true;
                    if (e < bestErr) { bestErr = e; best = drop; bestX = Xt; }
                }
                if (best < 0) break;
                use[best] = false; n--;
                X = bestX;
                viewErrors(X, obs, exts, dets, use, err);
            }
            if (X == null || maxOf(err) > thresh) out[3 * k] = out[3 * k + 1] = out[3 * k + 2] = NaN;
            else { out[3 * k] = X[0]; out[3 * k + 1] = X[1]; out[3 * k + 2] = X[2]; }
        }
        return out;
    }
    // Six cameras around the animal, every node a little noisy, and 0–3
    // views per node misplaced by 10–200 px (some nodes missing in a view),
    // so trials run 1–4 rounds and some nodes end up dropped.
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const RIG = [0, 1, 2, 3, 4, 5].map(i => makeCam('r' + i,
        [0.3 * Math.sin(i), 0.4 * Math.cos(1.3 * i), 0.1 * i], [3 * Math.cos(i), 3 * Math.sin(i), 40 + i]));
    let nodesChecked = 0, dropped = 0, bad = 0;
    for (const thresh of [5, 20]) {
        for (let f = 0; f < 150; f++) {
            const tr = new CrossViewTracker(Object.assign({}, HP, { matchReproj: thresh }));
            const pts = nodes3d([rnd() * 4 - 2, rnd() * 4 - 2, 48]);
            const detsByCam = new Map();
            RIG.forEach((cam, ci) => {
                const px = pts.map((p) => {
                    if (rnd() < 0.05) return null;
                    const q = cam.project(p);
                    const off = rnd() < 0.25 ? 10 + 190 * rnd() : 0.5 * rnd();
                    return [q[0] + off * (rnd() - 0.5) * 2, q[1] + off * (rnd() - 0.5) * 2];
                });
                detsByCam.set(cam.name, [new Detection(new Instance(px, 0, 'predicted', 1.0), cam, 0, 0)]);
            });
            tr.trackFrame(detsByCam, RIG);
            for (const t of tr.targets) {
                const dets = Array.from(t.detsByCam.values());
                const exts = dets.map(d => d.cam.extrinsicMatrix);
                const allObs = [];
                for (let k = 0; k < dets[0].pointsNorm.length; k++) allObs.push(dets.map(d => d.pointsNorm[k]));
                const ref = referenceChecked(t.points3d, allObs, exts, dets, thresh);
                nodesChecked += allObs.length;
                for (let k = 0; k < allObs.length; k++) if (finite3(t.points3d, k) && !finite3(ref, k)) dropped++;
                if (!ref.every((v, i) => Object.is(v, t.match3d[i]))) bad++;
            }
        }
    }
    ok(bad === 0 && nodesChecked > 1000 && dropped > 0,
        `${nodesChecked} nodes over 300 random frames (${dropped} dropped): ${bad} targets differ from the reference`);
}

// ===========================================================================
group('birthMedian — new targets paired by the median epipolar distance');
{
    // Two animals one above the other. In c1, animal 0's node 0 is misplaced
    // ONTO animal 1's node-0 epipolar line, 300 px off its own: by the mean
    // over nodes that one node makes the right pairing dearer than the wrong
    // one. Births pair c0 with c1 (the first two views with leftovers).
    const ANIMALS = [[0, -1.5, 48], [0, 1.5, 48]];
    const { computeFundamentalMatrix } =
        await import(pathToFileURL(path.join(POSE_DIR, 'triangulation-core.js')).href);
    const F = computeFundamentalMatrix(CAMS[0], CAMS[1]);
    const line = (p) => [0, 1, 2].map(r => F[r][0] * p[0] + F[r][1] * p[1] + F[r][2]);
    function births(hp) {
        const dets = frameDetections(0, ANIMALS);
        const A = dets.get('c0'), B = dets.get('c1');
        const l0 = line(A[0].pointsPixel[0]), l1 = line(A[1].pointsPixel[0]);
        const p1 = B[1].pointsPixel[0], dir = [-l1[1], l1[0]], n0 = Math.hypot(l0[0], l0[1]);
        const off0 = (t) => (l0[0] * (p1[0] + t * dir[0]) + l0[1] * (p1[1] + t * dir[1]) + l0[2]) / n0;
        const t = (300 - off0(0)) / (off0(1) - off0(0));   // linear in t
        const px = B[0].instance.toPointsArray();
        px[0] = [p1[0] + t * dir[0], p1[1] + t * dir[1]];
        dets.set('c1', [new Detection(new Instance(px, 0, 'predicted', 1.0), CAMS[1], 0, 0), B[1]]);
        dets.set('c2', []);
        const trk = new CrossViewTracker(Object.assign({}, HP, hp));
        trk.trackFrame(dets, CAMS);
        return trk.targets.map(tg => tg.detsByCam.get('c0').slot === tg.detsByCam.get('c1').slot);
    }
    const mean = births({}), med = births({ birthMedian: 1 });
    eq(mean.length, 2, 'two targets born');
    ok(mean.every(x => !x), 'mean (today): each animal is paired with the other (precondition)');
    ok(med.length === 2 && med.every(x => x), 'median: each animal paired with itself');
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
