/**
 * test-skeleton-check.mjs — Triangulate's skeleton check (pose/skeleton-check.js, through `triangulateAndReproject`'s
 * `options.skeleton`, and pose/skeleton-check-run.js's session side).
 *
 *   - chains from the skeleton: DoublePoke's star skeleton (hubs TTI and Head; every tail node alone, the ear pair,
 *     ...), a chain-shaped skeleton (the tail is one chain), a path without a hub (its centre), unlinked nodes;
 *   - custom parts (Settings ▸ Triangulation Wizard, stored as text): parsing, names, what a part it cannot use says,
 *     the links they give (the star's tail linked in order, every other link kept, either direction; a whole spine
 *     from the nose to the tail tip), and in the solve a tail point on a neighbour's tail at the same distance from
 *     TTI: missed by the star's links, repaired with the tail linked;
 *   - usual lengths: a steady bone gets +-50 %, one that often shortens a wider lower bound, too few poses none;
 *   - the repair: fewest changes, locked points kept, a drop when nothing fits, fewer drops on ties, better support
 *     first, a drop cannot cut a point loose, plausible chains untouched; a chain no repair makes plausible still
 *     repairs a point out of its reach (`chainReach`), and a one-point chain does not;
 *   - in the solve, on SLAP's 8 real cameras: a point half the cameras put on a neighbour comes back from the cameras
 *     that agree on the truth; a point every camera agrees on is kept; without a volume a point no camera group fits
 *     is kept, never dropped; nothing plausible is fitted; without `options.skeleton` nothing changes;
 *   - real data (tests/fixtures/skeleton-check-real.json, two DoublePoke clips, production 2D, no volume): every
 *     flagged chain is repaired to plausible or left as it was, and no plausible chain is touched; and
 *     (tests/fixtures/skeleton-check-slap-far.json) the 3 SLAP animal-frames where a linked tail held a point
 *     thousands of units off: each comes back within 100 units of the proofread 3D;
 *   - pose/skeleton-check-run.js: the setting, the session's named chains, measuring from stored 3D, flagged frames.
 *
 * Run: node tests/test-skeleton-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) { if (cond) passed++; else { failed++; failures.push(msg); console.error('  ✗ ' + msg); } return !!cond; }
function group(name) { console.log('\n• ' + name); }

const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const pd = await imp('pose/pose-data.js');
const core = await imp('pose/triangulation-core.js');
const SC = await imp('pose/skeleton-check.js');
const RUN = await imp('pose/skeleton-check-run.js');
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sameArr = (A, B) => A.length === B.length && Array.from(A).every((v, i) => Object.is(v, B[i]));

const STAR_NAMES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
    'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
const STAR_LINKS = [['TTI', 'Head'], ['TTI', 'Tail_0'], ['TTI', 'Tail_1'], ['TTI', 'Tail_2'], ['TTI', 'Haunch_left'],
    ['TTI', 'Haunch_right'], ['TTI', 'Trunk'], ['TTI', 'TailTip'], ['Head', 'Nose'], ['Head', 'Neck'], ['Head', 'Shoulder_left'],
    ['Head', 'Shoulder_right'], ['Head', 'Ear_R'], ['Head', 'Ear_L'], ['Ear_R', 'Ear_L'], ['Shoulder_right', 'Shoulder_left'],
    ['Haunch_left', 'Haunch_right']];
const ix = (names) => (pairs) => pairs.map(([a, b]) => [names.indexOf(a), names.indexOf(b)]);
const named = (names, ch) => Array.from(ch.nodes, k => names[k]).join('+');

group('chains from the skeleton');
{
    const { chains, hubs } = SC.skeletonChains(STAR_NAMES.length, ix(STAR_NAMES)(STAR_LINKS));
    ok(Array.from(hubs, k => STAR_NAMES[k]).join() === 'TTI,Head', 'star: the hubs are TTI and the Head');
    const byName = Object.fromEntries(chains.map(ch => [named(STAR_NAMES, ch), ch]));
    ok(chains.length === 10 && ['Tail_0', 'Tail_1', 'Tail_2', 'TailTip', 'Nose', 'Neck', 'Trunk'].every(n => byName[n]),
        'star: every tail node is a chain of its own (' + Object.keys(byName).join(', ') + ')');
    const ears = byName['Ear_R+Ear_L'];
    ok(ears && Array.from(ears.anchors, k => STAR_NAMES[k]).join() === 'Head' && ears.bones.length === 6,
        'star: the two ears are one chain on the Head, with three bones (each ear to the Head, and ear to ear)');
    const tail0 = byName.Tail_0;
    ok(tail0 && Array.from(tail0.anchors, k => STAR_NAMES[k]).join() === 'TTI', 'star: Tail_0 hangs on TTI');

    const CH = ['Nose', 'Head', 'Ear_L', 'Ear_R', 'Neck', 'Trunk', 'TTI', 'Tail_0', 'Tail_1', 'Tail_2', 'TailTip', 'Shoulder_left'];
    const chainLinks = [['Nose', 'Head'], ['Ear_L', 'Head'], ['Ear_R', 'Head'], ['Head', 'Neck'], ['Neck', 'Trunk'], ['Neck', 'Shoulder_left'],
        ['Trunk', 'TTI'], ['TTI', 'Tail_0'], ['Tail_0', 'Tail_1'], ['Tail_1', 'Tail_2'], ['Tail_2', 'TailTip'], ['TTI', 'Head']];
    const c2 = SC.skeletonChains(CH.length, ix(CH)(chainLinks));
    const tail = c2.chains.find(ch => named(CH, ch) === 'TTI' || named(CH, ch).includes('Tail_0'));
    ok(tail && named(CH, tail) === 'Tail_0+Tail_1+Tail_2+TailTip' && Array.from(tail.anchors, k => CH[k]).join() === 'TTI' &&
       tail.bones.length === 8, 'a chain-shaped tail is one chain on TTI, with its four bones');

    const P5 = ['a', 'b', 'c', 'd', 'e', 'lonely'];
    const c3 = SC.skeletonChains(P5.length, ix(P5)([['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']]));
    ok(Array.from(c3.hubs, k => P5[k]).join() === 'c' && c3.chains.map(ch => named(P5, ch)).join() === 'a+b,d+e',
        'a path without a hub is held at its centre; a node with no edge is in no chain');
}

group('usual lengths and ranges');
{
    const ch = { nodes: Int32Array.from([1, 2]), anchors: Int32Array.from([0]), bones: Int32Array.from([1, 0, 2, 0]) };
    let seed = 3;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const poses = [];
    for (let i = 0; i < 400; i++) {
        const L1 = 20 * (0.95 + 0.1 * rnd());                       // steady: 19-21
        const L2 = i % 5 === 0 ? 30 + 60 * rnd() : 90 + 4 * rnd();  // usually 90-94, often much shorter (a curled tail)
        poses.push(Float64Array.from([0, 0, 0, L1, 0, 0, 0, L2, 0]));
    }
    const [m] = SC.measureBones([ch], fn => poses.forEach(fn));
    ok(m && Math.abs(m.medians[0] - 20) < 0.5 && m.lo[0] === 0.5 && m.hi[0] === 1.5, 'a steady bone gets exactly +-50 %');
    ok(m && m.lo[1] < 0.4 && m.hi[1] === 1.5, `one that often shortens gets a wider lower bound only [${m && m.lo[1].toFixed(2)}, ${m && m.hi[1]}]`);
    const few = SC.measureBones([ch], fn => poses.slice(0, 10).forEach(fn));
    ok(few.length === 0 && few.skipped.length === 1, 'too few poses: not measured, and said why');
}

// a measured two-point chain on anchor 0: bones 1-0 (20 mm) and 2-0 (40 mm), +-50 %
const CH2 = { nodes: Int32Array.from([1, 2]), anchors: Int32Array.from([0]), bones: Int32Array.from([1, 0, 2, 0, 1, 2]),
              medians: Float64Array.from([20, 40, Math.hypot(20, 40)]), lo: Float64Array.from([0.5, 0.5, 0.5]), hi: Float64Array.from([1.5, 1.5, 1.5]) };
const truth = () => Float64Array.from([0, 0, 0, 20, 0, 0, 0, 40, 0]);

group('badness: the trigger and a repair');
{
    const P = truth();
    ok(SC.chainBadness(P, CH2) === 0, 'the truth is plausible');
    P[3] = 50;   // bone 1-0: 2.5x
    ok(SC.chainBadness(P, CH2) > 0, 'a bone 2.5x long is not');
    const Q = truth(); Q[3] = NaN; Q[4] = NaN; Q[5] = NaN;
    ok(SC.chainBadness(Q, CH2) === 0, 'a missing point is absent, not implausible (the trigger ignores it)');
    const R = truth(); R[0] = NaN; R[1] = NaN; R[2] = NaN;   // the anchor itself missing: both points cut loose
    ok(SC.chainRepairBadness(R, CH2) >= 2, 'points no present bone links to the anchor count against a repair');
}

group('the repair: fewest changes, locks, drops, support');
{
    const cand = (X, support) => ({ X, kind: 'subset', support });
    // point 1 is 2.5x out; a candidate puts it back; point 2 is right
    let P = truth(); P[3] = 50;
    let r = SC.checkChains(P, [CH2], k => k === 1 ? { locked: false, cands: [cand([20, 0, 0], 3)] } : { locked: false, cands: [cand([0, 80, 0], 5)] });
    ok(r.chains === 1 && r.changed.subset === 1 && r.dropped === 0 && dist3([P[3], P[4], P[5]], [20, 0, 0]) < 1e-12 && P[7] === 40,
        'the wrong point takes the candidate that fits; the right one keeps its place');
    // the same, but point 1 is locked: nothing may fix the chain without moving it -> left as it is
    P = truth(); P[3] = 50;
    const before = Float64Array.from(P);
    r = SC.checkChains(P, [CH2], k => k === 1 ? { locked: true, cands: [cand([20, 0, 0], 3)] } : { locked: false, cands: [] });
    ok(r.chains === 0 && sameArr(P, before), 'a locked point is never changed; a chain no repair fixes is left as it is');
    // no candidate fits: the point is dropped
    P = truth(); P[3] = 50;
    r = SC.checkChains(P, [CH2], k => k === 1 ? { locked: false, cands: [cand([60, 0, 0], 4)] } : { locked: true, cands: [] });
    ok(r.chains === 1 && r.dropped === 1 && Number.isNaN(P[3]) && P[7] === 40, 'when nothing fits the point is dropped (no 3D)');
    P = truth(); P[3] = 50;
    r = SC.checkChains(P, [CH2], k => k === 1 ? { locked: false, cands: [cand([60, 0, 0], 4)] } : { locked: true, cands: [] },
        { allowDrop: false });
    ok(r.chains === 0 && P[3] === 50, 'unless dropping is not allowed: then the chain is left as it is');
    // ---- out of reach: a chain no repair makes plausible still fixes a point it cannot possibly hold
    // a path 0 (anchor) - 1 - 2, bones 20 mm each, +-50 %: point 1 can be at most 30 mm from the anchor, point 2 60 mm
    const CH3 = { nodes: Int32Array.from([1, 2]), anchors: Int32Array.from([0]), bones: Int32Array.from([0, 1, 1, 2]),
                  medians: Float64Array.from([20, 20]), lo: Float64Array.from([0.5, 0.5]), hi: Float64Array.from([1.5, 1.5]) };
    const reach = SC.chainReach(CH3);
    ok(reach.get(1).reach === 30 && reach.get(2).reach === 60 && reach.get(1).anchor === 0 && !reach.has(0),
        'how far each point can reach: every bone on the way at its longest plausible length');
    // point 1 is too short (5 mm) and nothing fixes it, so no repair makes the chain plausible; point 2 is 5 m away
    P = Float64Array.from([0, 0, 0, 5, 0, 0, 5000, 0, 0]);
    r = SC.checkChains(P, [CH3], k => k === 2 ? { locked: false, cands: [cand([40, 0, 0], 3)] } : { locked: false, cands: [] },
        { allowDrop: false });
    ok(r.chains === 1 && r.partial === 1 && P[6] === 40 && P[3] === 5,
        'a point out of the chain\'s reach is still repaired from a candidate within reach; the rest is left as it is');
    P = Float64Array.from([0, 0, 0, 5, 0, 0, 5000, 0, 0]);
    r = SC.checkChains(P, [CH3], k => k === 2 ? { locked: false, cands: [cand([3000, 0, 0], 3)] } : { locked: false, cands: [] },
        { allowDrop: false });
    ok(r.chains === 0 && P[6] === 5000, 'no candidate within reach: it is left as it is (never dropped without a volume)');
    // with drops allowed (a volume) and point 1 locked, so no repair is plausible: the far point is dropped
    P = Float64Array.from([0, 0, 0, 5, 0, 0, 5000, 0, 0]);
    r = SC.checkChains(P, [CH3], k => k === 2 ? { locked: false, cands: [cand([3000, 0, 0], 3)] } : { locked: true, cands: [] });
    ok(r.chains === 1 && r.partial === 1 && r.dropped === 1 && Number.isNaN(P[6]) && P[3] === 5,
        'where drops are allowed (with a volume), a far point with no candidate within reach is dropped instead');
    // a one-point chain is judged by its one bone, as before: a too-short candidate does not make it plausible
    const CH1 = { nodes: Int32Array.from([1]), anchors: Int32Array.from([0]), bones: Int32Array.from([1, 0]),
                  medians: Float64Array.from([20]), lo: Float64Array.from([0.5]), hi: Float64Array.from([1.5]) };
    P = Float64Array.from([0, 0, 0, 5000, 0, 0]);
    r = SC.checkChains(P, [CH1], () => ({ locked: false, cands: [cand([5, 0, 0], 3)] }), { allowDrop: false });
    ok(r.chains === 0 && P[3] === 5000, 'a one-point chain is unchanged: only a plausible repair counts');
    // two fitting candidates: the better supported wins
    P = truth(); P[3] = 50;
    r = SC.checkChains(P, [CH2], k => k === 1 ? { locked: false, cands: [cand([21, 0, 0], 2), cand([19, 0, 0], 5)] } : { locked: true, cands: [] });
    ok(P[3] === 19, 'between fitting candidates, the one more cameras agree on');
    // plausible chains are not touched even when candidates exist
    P = truth();
    r = SC.checkChains(P, [CH2], () => ({ locked: false, cands: [cand([5, 5, 5], 8)] }));
    ok(r.chains === 0 && sameArr(P, truth()), 'a plausible chain is not touched');
}

// ---- in the solve, on SLAP's 8 real cameras
const FIX = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'dlt-behind-cameras.json'), 'utf8'));
const cams = FIX.cameras.map(c => new pd.Camera(c.name, c.matrix, c.dist, c.rvec, c.tvec, c.size));
const names = cams.map(c => c.name);
function arenaCentre() {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    for (const c of cams) {
        const R = c.rotationMatrix, t = c.tvec;
        const C = [0, 1, 2].map(i => -(R[0][i] * t[0] + R[1][i] * t[1] + R[2][i] * t[2]));
        const d = [R[2][0], R[2][1], R[2][2]];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { const m = (i === j ? 1 : 0) - d[i] * d[j]; A[i][j] += m; b[i] += m * C[j]; }
    }
    const inv = core.invert3x3(A);
    return [0, 1, 2].map(i => inv[i][0] * b[0] + inv[i][1] * b[1] + inv[i][2] * b[2]);
}
const centre = arenaCentre();
// a small star: hub 0, tip 1 (30 mm), tip 2 (45 mm), and a pair 3-4 hanging on the hub
const OFFS = [[0, 0, 0], [30, 0, 0], [0, 45, 0], [-20, -10, 5], [-20, 10, 5]];
const TRUTH = OFFS.map(o => [centre[0] + o[0], centre[1] + o[1], centre[2] + o[2]]);
const K = TRUTH.length;
const EDGES = [[0, 1], [0, 2], [0, 3], [0, 4], [3, 4]];
let seed = 12345;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function gauss() { return Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()); }
const native = (X, c) => cams[c].distortPoint(cams[c].project(X));
function observe(noisePx, edit) {
    const obs = cams.map((_, c) => TRUTH.map(X => { const q = native(X, c); return [q[0] + noisePx * gauss(), q[1] + noisePx * gauss()]; }));
    if (edit) edit(obs);
    return obs;
}
function makeGroup(obs) {
    const g = new pd.InstanceGroup(1, 0);
    obs.forEach((pts, c) => g.addInstance(names[c], new pd.Instance(pts, 0, 'predicted', 1)));
    return g;
}
const solve = (obs, skeleton) => core.triangulateAndReproject(makeGroup(obs), cams, { method: 'dlt', includedCameras: names, skeleton });
const pt = (r, k) => [r.points3d[3 * k], r.points3d[3 * k + 1], r.points3d[3 * k + 2]];
const measured = SC.measureBones(SC.skeletonChains(K, EDGES).chains, fn => {
    for (let i = 0; i < 60; i++) fn(Float64Array.from(TRUTH.flat().map(v => v + 0.5 * gauss())));
});
const SKEL = { chains: measured, subsetPx: 12, maxCandidates: 3 };

group('in the solve: a point half the cameras put on a neighbour comes back');
{
    seed = 1;
    const off = [TRUTH[1][0] + 80, TRUTH[1][1], TRUTH[1][2]];   // tip 1, 80 mm further out: on a neighbour
    const obs = observe(0.5, o => { for (let c = 0; c < 4; c++) { const q = native(off, c); o[c][1] = [q[0], q[1]]; } });
    const plain = solve(obs, undefined), r = solve(obs, SKEL);
    const ch1 = measured.find(ch => Array.from(ch.nodes).join() === '1');
    ok(SC.chainBadness(plain.points3d, ch1) > 0, 'plain triangulation stretches tip 1 (' + dist3(pt(plain, 1), TRUTH[1]).toFixed(0) + ' mm off)');
    ok(r.skeleton && r.skeleton.chainsRepaired === 1 && r.skeleton.nodesResolved === 1, 'one point re-solved (' + JSON.stringify(r.skeleton) + ')');
    ok(dist3(pt(r, 1), TRUTH[1]) < 1, 'from the cameras that agree on the truth (' + dist3(pt(r, 1), TRUTH[1]).toFixed(2) + ' mm)');
    ok([0, 2, 3, 4].every(k => sameArr(pt(r, k), pt(plain, k))), 'every other point keeps its place');
}

group('in the solve: a point every camera agrees on is kept');
{
    seed = 2;
    // the 2D of tip 2 is all 70 mm further out, in every camera: nothing disputes it, so it stays (implausible or not)
    const far = [TRUTH[2][0], TRUTH[2][1] + 70, TRUTH[2][2]];
    const obs = observe(0.3, o => { for (let c = 0; c < o.length; c++) { const q = native(far, c); o[c][2] = [q[0], q[1]]; } });
    const plain = solve(obs, undefined), r = solve(obs, SKEL);
    ok(r.skeleton && r.skeleton.chainsRepaired === 0 && sameArr(r.points3d, plain.points3d), 'nothing changed: every camera agrees on that point');
}

group('in the solve: without a volume a point no camera group fits is kept, not dropped');
{
    seed = 4;
    // tip 1's detections split between two wrong places, 80 mm out along x (cameras 0-3) and along z (4-7)
    const offA = [TRUTH[1][0] + 80, TRUTH[1][1], TRUTH[1][2]], offB = [TRUTH[1][0], TRUTH[1][1], TRUTH[1][2] + 80];
    const obs = observe(0.5, o => { for (let c = 0; c < o.length; c++) { const q = native(c < 4 ? offA : offB, c); o[c][1] = [q[0], q[1]]; } });
    const plain = solve(obs, undefined), r = solve(obs, SKEL);
    const ch1 = measured.find(ch => Array.from(ch.nodes).join() === '1');
    ok(SC.chainBadness(plain.points3d, ch1) > 0, 'plain triangulation puts tip 1 out of its range');
    ok(r.skeleton && r.skeleton.nodesDropped === 0 && sameArr(r.points3d, plain.points3d),
        'nothing fits, and nothing is dropped: the point stays (' + JSON.stringify(r.skeleton) + ')');
}

group('in the solve: plausible poses, and no option');
{
    seed = 3;
    const obs = observe(0.5);
    const plain = solve(obs, undefined), r = solve(obs, SKEL);
    ok(!('skeleton' in plain), 'without options.skeleton the result has no skeleton key');
    ok(r.skeleton && r.skeleton.chainsRepaired === 0 && sameArr(r.points3d, plain.points3d), 'a plausible pose is bit-identical with the check');
}

group('real data: two DoublePoke clips, production 2D, no volume');
{
    const FX = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'skeleton-check-real.json'), 'utf8'));
    const N = FX.node_names;
    for (const clip of FX.clips) {
        const rc = clip.cameras.map(c => new pd.Camera(c.name, c.matrix, c.dist, c.rvec, c.tvec, c.size));
        const rn = rc.map(c => c.name);
        const chains = clip.chains.map(c => ({ name: c.name, nodes: Int32Array.from(c.nodes), anchors: Int32Array.from(c.anchors),
            bones: Int32Array.from(c.bones), medians: Float64Array.from(c.medians), lo: Float64Array.from(c.lo), hi: Float64Array.from(c.hi) }));
        const rsolve = (cs, skeleton) => {
            const g = new pd.InstanceGroup(1, 0);
            cs.obs.forEach((pts, c) => {
                if (pts.every(p => p == null)) return;
                const inst = new pd.Instance(pts.map(p => p || [NaN, NaN]), 0, 'predicted', 1);
                const nulled = pts.map((p, k) => p == null ? k : -1).filter(k => k >= 0);
                if (nulled.length) inst.nulledNodes = new Set(nulled);
                g.addInstance(rn[c], inst);
            });
            return core.triangulateAndReproject(g, rc, { method: 'dlt', includedCameras: rn, reprojErrorThreshold: FX.reproj_px, skeleton });
        };
        let flagged = 0, repaired = 0, left = 0, broken = 0, touched = 0, resolved = 0, dropped = 0;
        for (const cs of clip.cases) {
            const a = rsolve(cs, undefined).points3d, r = rsolve(cs, { chains, subsetPx: 12, maxCandidates: 3 }), b = r.points3d;
            resolved += r.skeleton.nodesResolved; dropped += r.skeleton.nodesDropped;
            for (const ch of chains) {
                const same = Array.from(ch.nodes).every(k => [0, 1, 2].every(i => Object.is(a[3 * k + i], b[3 * k + i])));
                if (!(SC.chainBadness(a, ch) > 0)) { if (!same) touched++; continue; }
                flagged++;
                if (same) left++;
                else if (SC.chainRepairBadness(b, ch) === 0) repaired++;
                else broken++;
            }
        }
        console.log(`    ${clip.name}: ${clip.cases.length} animal-frames, ${flagged} chains flagged: ${repaired} repaired (${resolved} points re-solved, ` +
            `${dropped} dropped), ${left} left as they were`);
        // without a volume nothing is dropped: a chain no camera group fits stays as it was (July 13 24 of 30
        // repaired, the fight 21 of 29)
        ok(flagged >= 20 && broken === 0 && repaired + left === flagged && repaired >= 0.7 * flagged,
            `${clip.name}: every flagged chain is repaired to plausible or left as it was`);
        ok(dropped === 0, `${clip.name}: no point dropped without a volume`);
        ok(touched === 0, `${clip.name}: no plausible chain is touched`);
    }
}

group('custom parts: a star skeleton\'s tail judged bone by bone');
{
    ok(JSON.stringify(RUN.parseChainText(' TTI, Tail_0 → Tail_1\n\n Head,Nose; x ')) === JSON.stringify([['TTI', 'Tail_0', 'Tail_1'], ['Head', 'Nose'], ['x']]),
        'lines (or ;) of names split by commas (or →), blank lines left out');
    const TAIL = 'TTI, Tail_0, Tail_1, Tail_2, TailTip';
    const res = RUN.resolveChainText(STAR_NAMES, 'tti, Tail_0, Tail_1, Tail_2, TailTip\nTTI, Tail_O\nNose\nTTI, Head, TTI');
    ok(res.paths.length === 1 && Array.from(res.paths[0], k => STAR_NAMES[k]).join() === 'TTI,Tail_0,Tail_1,Tail_2,TailTip',
        'a name matches ignoring case when only one node does');
    ok(res.problems.length === 3 && /no node named Tail_O/.test(res.problems[0]) && /two nodes or more/.test(res.problems[1]) &&
        /listed twice/.test(res.problems[2]), 'an unknown name, a single node and a repeated node each leave their line out, and say so');
    const star = ix(STAR_NAMES)(STAR_LINKS);
    const path = RUN.resolveChainText(STAR_NAMES, TAIL).paths;
    const key = (L) => L.map(([a, b]) => [STAR_NAMES[a], STAR_NAMES[b]].sort().join('-')).sort().join();
    const links = RUN.checkLinks(star, path);
    const has = (a, b) => key(links).split(',').includes([a, b].sort().join('-'));
    ok(has('TTI', 'Tail_0') && has('Tail_0', 'Tail_1') && has('Tail_1', 'Tail_2') && has('Tail_2', 'TailTip'), 'the tail is linked in order');
    ok(!has('TTI', 'Tail_1') && !has('TTI', 'Tail_2') && !has('TTI', 'TailTip'), 'the star\'s links between tail points are gone');
    ok(has('TTI', 'Head') && has('TTI', 'Trunk') && has('Head', 'Nose') && links.length === star.length,
        'every other link stays (' + links.length + ' links)');
    ok(key(RUN.checkLinks(star, RUN.resolveChainText(STAR_NAMES, 'TailTip, Tail_2, Tail_1, Tail_0, TTI').paths)) === key(links),
        'the direction a part is listed in does not matter');
    const { chains, hubs } = SC.skeletonChains(STAR_NAMES.length, links);
    const tail = chains.find(ch => ch.nodes.length === 4);
    ok(Array.from(hubs, k => STAR_NAMES[k]).join() === 'TTI,Head' && chains.length === 7, 'still hubs TTI and the Head; 7 parts');
    ok(tail && named(STAR_NAMES, tail) === 'TailTip+Tail_0+Tail_1+Tail_2' && Array.from(tail.anchors, k => STAR_NAMES[k]).join() === 'TTI' &&
        tail.bones.length === 8, 'the tail is one chain on TTI with four bones');
    // the session side: names in the part's order, marked custom, problems carried
    const sk = new pd.Skeleton('star', STAR_NAMES.slice(), star);
    const session = { skeleton: sk, instanceGroups: new Map() };
    const typed = RUN.sessionSkeletonChains(session, TAIL + '\nHead, Snout');
    ok(typed.map(c => c.name).includes('Tail_0+Tail_1+Tail_2+TailTip') && typed.find(c => c.custom).name === 'Tail_0+Tail_1+Tail_2+TailTip',
        'the custom part is named in its order and marked custom');
    ok(typed.problems.length === 1 && /Snout/.test(typed.problems[0]), 'a part it left out is carried with the chains');
    ok(RUN.sessionSkeletonChains(session, '').length === 10 && RUN.sessionSkeletonChains(session, '').every(c => !c.custom),
        'no custom part: the skeleton\'s own chains');
    // a whole spine, nose to tail tip: the neck and trunk become one chain between the Head and TTI
    const spine = RUN.sessionSkeletonChains(session, 'Nose, Head, Neck, Trunk, TTI, Tail_0, Tail_1, Tail_2, TailTip');
    const sp = (n) => spine.find(c => c.name === n);
    ok(spine.problems.length === 0 && sp('Neck+Trunk') && sp('Nose') && sp('Tail_0+Tail_1+Tail_2+TailTip') &&
        Array.from(sp('Neck+Trunk').anchors, k => STAR_NAMES[k]).sort().join() === 'Head,TTI',
        'a whole spine: the nose on the Head, the neck and trunk between the Head and TTI, the tail on TTI (' +
        spine.map(c => c.name).join(', ') + ')');
    ok(RUN.sessionSkeletonChains(session, TAIL) === RUN.sessionSkeletonChains(session, TAIL), 'cached per skeleton and text');
    RUN.setSkeletonCheckSettings({ chains: TAIL });
    ok(RUN.sessionSkeletonChains(session).length === 7, 'without a text, the setting\'s chains');
    RUN.setSkeletonCheckSettings({ chains: '' });
}

group('in the solve: a tail point moved to a neighbour\'s tail at the same distance from TTI');
{
    // TTI (0) holds a head, two haunches and a 4-point tail running straight out along x, 15 mm apart. In half the
    // cameras Tail_1 is on a neighbour's tail: still 30 mm from TTI, but turned 90 degrees. The star judges Tail_1 only
    // by its distance from TTI, so it misses it; the tail linked in order sees Tail_0-Tail_1 and Tail_1-Tail_2 break.
    const T_NAMES = ['TTI', 'Head', 'Haunch_left', 'Haunch_right', 'Tail_0', 'Tail_1', 'Tail_2', 'TailTip'];
    const T_OFFS = [[0, 0, 0], [-60, 0, 10], [-10, -15, 0], [-10, 15, 0], [15, 0, 0], [30, 0, 0], [45, 0, 0], [60, 0, 0]];
    const T_TRUTH = T_OFFS.map(o => [centre[0] + o[0], centre[1] + o[1], centre[2] + o[2]]);
    const T_STAR = [[0, 1], [0, 2], [0, 3], [2, 3], [0, 4], [0, 5], [0, 6], [0, 7]];
    const nk = T_NAMES.indexOf('Tail_1');
    seed = 7;
    const tObserve = (noisePx, edit) => {
        const obs = cams.map((_, c) => T_TRUTH.map(X => { const q = native(X, c); return [q[0] + noisePx * gauss(), q[1] + noisePx * gauss()]; }));
        if (edit) edit(obs);
        return obs;
    };
    const tMeasure = (edges) => SC.measureBones(SC.skeletonChains(T_NAMES.length, edges).chains, fn => {
        for (let i = 0; i < 60; i++) fn(Float64Array.from(T_TRUTH.flat().map(v => v + 0.5 * gauss())));
    });
    const typedLinks = RUN.checkLinks(T_STAR, RUN.resolveChainText(T_NAMES, 'TTI, Tail_0, Tail_1, Tail_2, TailTip').paths);
    const SK_STAR = { chains: tMeasure(T_STAR), subsetPx: 12, maxCandidates: 3 };
    const SK_TAIL = { chains: tMeasure(typedLinks), subsetPx: 12, maxCandidates: 3 };
    const wrong = [T_TRUTH[0][0], T_TRUTH[0][1] + 30, T_TRUTH[0][2]];
    const obs = tObserve(0.5, o => { for (let c = 0; c < 4; c++) { const q = native(wrong, c); o[c][nk] = [q[0], q[1]]; } });
    const tSolve = (skeleton) => {
        const g = new pd.InstanceGroup(1, 0);
        obs.forEach((pts, c) => g.addInstance(names[c], new pd.Instance(pts, 0, 'predicted', 1)));
        return core.triangulateAndReproject(g, cams, { method: 'dlt', includedCameras: names, skeleton });
    };
    const P = (r, k) => [r.points3d[3 * k], r.points3d[3 * k + 1], r.points3d[3 * k + 2]];
    const plain = tSolve(undefined), rStar = tSolve(SK_STAR), rTail = tSolve(SK_TAIL);
    const plainOff = dist3(P(plain, nk), T_TRUTH[nk]);
    ok(plainOff > 5, 'plain triangulation puts Tail_1 ' + plainOff.toFixed(0) + ' mm off');
    ok(rStar.skeleton && rStar.skeleton.chainsRepaired === 0 && sameArr(rStar.points3d, plain.points3d),
        'the star\'s links miss it: Tail_1 is still about 30 mm from TTI');
    ok(rTail.skeleton && rTail.skeleton.chainsRepaired === 1 && rTail.skeleton.nodesResolved === 1 && dist3(P(rTail, nk), T_TRUTH[nk]) < 1,
        'the tail linked in order repairs it from the cameras that agree (' + dist3(P(rTail, nk), T_TRUTH[nk]).toFixed(2) + ' mm)');
    ok(T_NAMES.every((_, k) => k === nk || sameArr(P(rTail, k), P(plain, k))), 'and changes no other point');
}

group('real data: SLAP tails out of reach, the tail linked in order');
{
    // tests/fixtures/skeleton-check-slap-far.json: the 3 SLAP animal-frames (of 98,759 scored) where plain triangulation
    // put a tail point thousands of units from the proofread 3D inside a tail no repair makes plausible. The star's
    // one-point chains fixed them; with the tail linked they were left until the out-of-reach rule.
    const FX = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'skeleton-check-slap-far.json'), 'utf8'));
    const N = FX.node_names;
    let cases = 0, partial = 0, farBefore = 0, farAfter = 0, worse = 0;
    const fixed = [];
    for (const S of FX.sessions) {
        const rc = S.cameras.map(c => new pd.Camera(c.name, c.matrix, c.dist, c.rvec, c.tvec, c.size));
        const rn = rc.map(c => c.name);
        const chains = S.chains.map(c => ({ name: c.name, nodes: Int32Array.from(c.nodes), anchors: Int32Array.from(c.anchors),
            bones: Int32Array.from(c.bones), medians: Float64Array.from(c.medians), lo: Float64Array.from(c.lo), hi: Float64Array.from(c.hi) }));
        const rsolve = (cs, skeleton) => {
            const g = new pd.InstanceGroup(1, 0);
            cs.obs.forEach((pts, c) => {
                if (!pts) return;
                const inst = new pd.Instance(pts.map(p => p || [NaN, NaN]), 0, 'predicted', 1);
                const nulled = pts.map((p, k) => p ? -1 : k).filter(k => k >= 0);
                if (nulled.length) inst.nulledNodes = new Set(nulled);
                g.addInstance(rn[c], inst);
            });
            return core.triangulateAndReproject(g, rc, { method: 'dlt', includedCameras: rn, reprojErrorThreshold: FX.reproj_px, skeleton });
        };
        for (const cs of S.cases) {
            cases++;
            const a = rsolve(cs, undefined).points3d, r = rsolve(cs, { chains, subsetPx: 12, maxCandidates: 3 }), b = r.points3d;
            const err = (P, k) => { const X = cs.truth[k]; return X[0] == null ? NaN : Math.hypot(P[3 * k] - X[0], P[3 * k + 1] - X[1], P[3 * k + 2] - X[2]); };
            if (r.skeleton && r.skeleton.chainsPartial > 0) partial++;
            for (let k = 0; k < N.length; k++) {
                const e0 = err(a, k), e1 = err(b, k);
                if (e0 > 500) farBefore++;
                if (e1 > 500) farAfter++;
                if (e0 > 500 && e1 < 100) fixed.push(`${N[k]} ${e0.toFixed(0)} -> ${e1.toFixed(0)}`);
                if (!sameArr([a[3 * k], a[3 * k + 1], a[3 * k + 2]], [b[3 * k], b[3 * k + 1], b[3 * k + 2]]) && !(e1 < e0)) worse++;
            }
        }
    }
    console.log(`    ${cases} animal-frames: points over 500 units off ${farBefore} -> ${farAfter}; ${fixed.join(', ')}`);
    ok(cases === 3 && partial === 3, 'the out-of-reach rule repairs a point in each of them (' + partial + ' of ' + cases + ')');
    ok(fixed.length === 3 && farAfter === farBefore - 3, 'three points thousands of units off come back within 100 units of the proofread 3D');
    ok(worse === 0, 'and no point it changes ends farther from the proofread 3D');
}

group('pose/skeleton-check-run.js: the session side');
{
    const sk = new pd.Skeleton('star', STAR_NAMES.slice(), ix(STAR_NAMES)(STAR_LINKS));
    const session = { skeleton: sk, instanceGroups: new Map() };
    ok(RUN.getSkeletonCheckSettings().enabled === false, 'off by default');
    ok(RUN.skeletonCheckForRun(session) === null, 'off: no check');
    RUN.setSkeletonCheckSettings({ enabled: true });
    ok(RUN.sessionSkeletonChains(session).map(c => c.name).includes('Ear_R+Ear_L'), 'the chains are named by their nodes');
    ok(RUN.skeletonCheckForRun(session) === null, 'no 3D yet: nothing measured, no check');
    // 40 frames of a plausible pose, one frame with a stretched TailTip
    const base = STAR_NAMES.map((n, k) => [k * 7 % 23, k * 11 % 17, k * 5 % 13]);
    const pose = (f) => { const P = Float64Array.from(base.flat()); return P; };
    for (let f = 0; f < 40; f++) { const g = new pd.InstanceGroup(f, 0); g.points3d = pose(f); session.instanceGroups.set(f, [g]); }
    const bad = new pd.InstanceGroup(40, 0); bad.points3d = pose(40);
    const tip = STAR_NAMES.indexOf('TailTip'), tti = STAR_NAMES.indexOf('TTI');
    for (let i = 0; i < 3; i++) bad.points3d[3 * tip + i] = bad.points3d[3 * tti + i] + 3 * (base[tip][i] - base[tti][i]);
    session.instanceGroups.set(40, [bad]);
    RUN.invalidateSkeletonCheck(session);
    const run = RUN.skeletonCheckForRun(session);
    ok(run && run.chains.length === 10, 'measured from the stored 3D: ' + (run ? run.chains.length : 0) + ' chains');
    ok(run && RUN.framesNeedingSkeletonCheck(session, run).join() === '40', 'the frame with the stretched tail tip needs the check');
    RUN.setSkeletonCheckSettings({ enabled: false });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
