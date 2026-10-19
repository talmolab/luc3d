/**
 * test-pose-check.mjs — the 2D pose check (pose/pose-check.js) and its session
 * glue (pose/pose-check-session.js).
 *
 * The animals are synthetic: a 12-node body (a bending, stretching 7-node spine
 * with ears and four limbs), seen in every position, orientation and size, with
 * pixel noise and nodes missing at random. Then the poses the test is FOR:
 *   - head and tail swapped, one node thrown off the body, nodes scattered, a
 *     pose stretched over two animals: outlier;
 *   - the same typical pose moved, rotated and scaled: the SAME score (to 1e-9);
 *   - typical poses with nodes missing: still common, on the same scale.
 * Also: too few poses or nodes gives no verdict rather than a wrong one; a node
 * the model rarely predicts is left out of the model rather than shrinking the
 * fit set; the fit does not depend on the order the poses were offered in; and
 * the session glue — the eager and lazy samplers agree, the lazy one releases
 * only frames it loaded itself, a tracking run counts and flags, never touches a
 * user instance, and leaves outliers out only when asked — and Tracks ▸ Check
 * Poses, which scores every prediction (a lazy project's resident frames from
 * the session, the rest from the store) and tracks nothing.
 *
 * The tracker side (a outlier detection is not grouped, the summary row) is
 * covered by tests/e2e/track-all-pose-check.mjs.
 *
 * Run:  node tests/test-pose-check.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pose = (f) => pathToFileURL(path.join(HERE, '..', 'pose', f)).href;
const PC = await import(pose('pose-check.js'));
const PS = await import(pose('pose-check-session.js'));
const {
    createPoseSample, fitPoseModel, poseScore, poseClassOf, poseClassName, wilsonHilferty, poseSampleStride,
    POSE_MIN_NODES, POSE_FIT_MAX, POSE_FIT_MIN, POSE_UNCOMMON_DEFAULT, POSE_OUTLIER_DEFAULT,
    POSE_UNTESTED, POSE_COMMON, POSE_UNCOMMON, POSE_OUTLIER, POSE_SAMPLE_FRAMES,
} = PC;

let passed = 0, failed = 0; const failures = [];
function ok(c, m) {
    if (c) passed++;
    else { failed++; failures.push(m); console.error('  ✗ ' + m); }
}
function close(a, b, tol, m) { ok(Math.abs(a - b) <= tol, `${m} (${a} vs ${b})`); }

// ---- a seeded synthetic animal ------------------------------------------------
function rng(seed) {
    let s = seed >>> 0;
    return function () {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

const K = 12;   // spine 0..6 (0 = nose, 6 = tail tip), ears 7/8 off node 1, limbs 9/10 off node 2, 11 off node 4
// A body in its own frame: the spine bends by `bend` (radians spread along it)
// and stretches by `stretch`; then the whole pose is moved, turned and scaled.
function makePose(r, opts) {
    opts = opts || {};
    const bend = opts.bend != null ? opts.bend : 0.6 * gauss(r);
    const stretch = opts.stretch != null ? opts.stretch : 1 + 0.08 * gauss(r);
    const pts = [];
    let x = 0, y = 0, a = 0;
    pts.push([0, 0]);
    for (let i = 1; i < 7; i++) {
        a += bend / 6 + 0.05 * gauss(r);
        x += 10 * stretch * Math.cos(a); y += 10 * stretch * Math.sin(a);
        pts.push([x, y]);
    }
    const side = (i, d, ang) => {
        const [px, py] = pts[i];
        const [qx, qy] = pts[i + 1];
        const t = Math.atan2(qy - py, qx - px) + ang;
        return [px + d * Math.cos(t), py + d * Math.sin(t)];
    };
    pts.push(side(1, 6, 1.9), side(1, 6, -1.9), side(2, 8, 1.6), side(2, 8, -1.6), side(4, 8, 1.5 + 0.2 * gauss(r)));
    const th = opts.theta != null ? opts.theta : 2 * Math.PI * r();
    const sc = opts.scale != null ? opts.scale : 0.7 + 0.6 * r();
    const tx = opts.tx != null ? opts.tx : 600 * r(), ty = opts.ty != null ? opts.ty : 400 * r();
    const c = Math.cos(th), s = Math.sin(th), noise = opts.noise != null ? opts.noise : 0.6;
    const xy = new Float64Array(2 * K);
    for (let k = 0; k < K; k++) {
        const [px, py] = pts[k];
        xy[2 * k] = tx + sc * (c * px - s * py) + noise * gauss(r);
        xy[2 * k + 1] = ty + sc * (s * px + c * py) + noise * gauss(r);
    }
    return xy;
}
function dropNodes(xy, r, p) {
    const out = Float64Array.from(xy);
    for (let k = 0; k < K; k++) if (r() < p) { out[2 * k] = NaN; out[2 * k + 1] = NaN; }
    return out;
}
function transform(xy, th, sc, tx, ty) {
    const out = new Float64Array(xy.length), c = Math.cos(th), s = Math.sin(th);
    for (let k = 0; k < xy.length / 2; k++) {
        const x = xy[2 * k], y = xy[2 * k + 1];
        out[2 * k] = tx + sc * (c * x - s * y); out[2 * k + 1] = ty + sc * (s * x + c * y);
    }
    return out;
}

const r = rng(1);
const train = [];
for (let i = 0; i < 6000; i++) train.push(dropNodes(makePose(r), r, 0.05));
const sample = createPoseSample(K);
train.forEach((p) => sample.offer(p));
const model = fitPoseModel(sample.poses, K);

// ---- 1. the model ---------------------------------------------------------------
ok(model && model.nCore === K, 'a model of every node');
ok(model && model.nFit === POSE_FIT_MAX, `fitted on at most ${POSE_FIT_MAX} complete poses (${model && model.nFit})`);

// ---- 2. typical poses are common ------------------------------------------------
const rt = rng(2);
const typical = [];
for (let i = 0; i < 2000; i++) typical.push(makePose(rt));
const tz = typical.map((p) => poseScore(model, p)).sort((a, b) => a - b);
const median = tz[tz.length >> 1], p99 = tz[Math.floor(0.99 * tz.length)], p995 = tz[Math.floor(0.995 * tz.length)];
ok(median < 2, `a typical pose scores about 0 (median ${median.toFixed(2)})`);
ok(p99 < POSE_UNCOMMON_DEFAULT, `99% of typical poses are below "uncommon" (${p99.toFixed(2)})`);
ok(tz[tz.length - 1] < POSE_OUTLIER_DEFAULT, `no typical pose is an outlier (max ${tz[tz.length - 1].toFixed(2)})`);

// ---- 3. where, which way and how big do not count -----------------------------
const base = makePose(rng(3), { theta: 0.3, scale: 1, tx: 100, ty: 100 });
const zBase = poseScore(model, base);
for (const [th, sc, tx, ty] of [[1.1, 1, 0, 0], [Math.PI, 0.4, 500, -200], [-2.5, 3, 1e4, 7e3]]) {
    close(poseScore(model, transform(base, th, sc, tx, ty)), zBase, 1e-9, `moved/turned/scaled (${th}, ${sc}) scores the same`);
}

// ---- 4. outlier --------------------------------------------------------------------
// Measured against the TYPICAL poses' own spread: 90% of each kind of outlier
// scores above the rarest 0.5% of typical poses. (The default thresholds are
// calibrated on real mice, whose poses vary far more than this synthetic body —
// see the MODULES.md entry; this test pins that the score separates them.)
const rg = rng(4);
function outlierCase(name, fn) {
    const zs = [];
    for (let i = 0; i < 100; i++) zs.push(poseScore(model, fn(makePose(rg))));
    zs.sort((a, b) => a - b);
    const lo = zs[Math.floor(0.1 * zs.length)];
    ok(lo > p995, `${name}: 90% score above typical poses' 99.5th percentile (10th percentile ${lo.toFixed(1)} vs ${p995.toFixed(1)})`);
}
outlierCase('head and tail swapped', (p) => {
    const q = Float64Array.from(p);
    q[0] = p[12]; q[1] = p[13]; q[12] = p[0]; q[13] = p[1];
    return q;
});
outlierCase('one ear thrown a body length off', (p) => {
    const q = Float64Array.from(p);
    const dx = p[12] - p[0], dy = p[13] - p[1];
    q[14] += -dy; q[15] += dx;
    return q;
});
outlierCase('nodes scattered', (p) => {
    const q = Float64Array.from(p), cx = p[6], cy = p[7];
    for (let k = 0; k < K; k++) { q[2 * k] = cx + 60 * (rg() - 0.5); q[2 * k + 1] = cy + 60 * (rg() - 0.5); }
    return q;
});
outlierCase('back half on another animal', (p) => {
    const q = Float64Array.from(p), other = makePose(rg);
    for (const k of [4, 5, 6, 11]) { q[2 * k] = other[2 * k]; q[2 * k + 1] = other[2 * k + 1]; }
    return q;
});

// ---- 5. missing nodes ------------------------------------------------------------
const rm = rng(5);
let partialMax = -Infinity, partialFlag = 0;
for (let i = 0; i < 500; i++) {
    const p = makePose(rm), q = Float64Array.from(p);
    for (const k of [3, 8, 10]) { q[2 * k] = NaN; q[2 * k + 1] = NaN; }
    const z = poseScore(model, q);
    if (z >= POSE_UNCOMMON_DEFAULT) partialFlag++;
    partialMax = Math.max(partialMax, z);
}
ok(partialFlag <= 5 && partialMax < POSE_OUTLIER_DEFAULT,
    `typical poses with 3 nodes missing stay common (${partialFlag}/500 uncommon, max ${partialMax.toFixed(1)})`);
outlierCase('head and tail swapped, with an ear and a limb missing', (p) => {
    const q = Float64Array.from(p);
    q[0] = p[12]; q[1] = p[13]; q[12] = p[0]; q[13] = p[1];
    for (const k of [8, 10]) { q[2 * k] = NaN; q[2 * k + 1] = NaN; }
    return q;
});
{
    const p = makePose(rng(7));
    const few = new Float64Array(2 * K).fill(NaN);
    for (let k = 0; k < POSE_MIN_NODES - 1; k++) { few[2 * k] = p[2 * k]; few[2 * k + 1] = p[2 * k + 1]; }
    ok(Number.isNaN(poseScore(model, few)), `fewer than ${POSE_MIN_NODES} nodes: no score`);
    ok(poseClassOf(poseScore(model, few), 10, 15) === POSE_UNTESTED, '...and no class');
    ok(Number.isNaN(poseScore(null, p)), 'no model: no score');
    ok(Number.isNaN(poseScore(model, p.subarray(0, 2 * K - 2))), 'a pose of another skeleton: no score');
}

// ---- 6. not enough to model ---------------------------------------------------------
ok(fitPoseModel(sample.poses.slice(0, POSE_FIT_MIN - 1), K) === null, `fewer than ${POSE_FIT_MIN} complete poses: no model`);
ok(fitPoseModel([], K) === null, 'no poses: no model');

// ---- 7. a node the model rarely finds is left out, not the fit set shrunk ----------
{
    const rr = rng(8), s = createPoseSample(K);
    for (let i = 0; i < 6000; i++) {
        const p = makePose(rr);
        if (rr() > 0.1) { p[2 * 6] = NaN; p[2 * 6 + 1] = NaN; }        // tail tip in 10% of poses
        s.offer(p);
    }
    const m = fitPoseModel(s.poses, K);
    ok(m && m.nCore === K - 1 && !Array.from(m.core).includes(6), 'a node seen in 10% of poses is not modelled');
    ok(m && m.nFit === POSE_FIT_MAX, '...so the fit set is full');
    const p = makePose(rng(9));
    ok(poseScore(m, p) < POSE_UNCOMMON_DEFAULT, '...and a typical pose (with the node) is still scored on the rest');
}

// ---- 8. the fit does not depend on the order the poses came in ----------------------
{
    const shuffled = sample.poses.slice();
    const rs = rng(10);
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rs() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const m2 = fitPoseModel(shuffled, K);
    let same = true;
    for (let i = 0; i < 300; i++) if (poseScore(m2, typical[i]) !== poseScore(model, typical[i])) same = false;
    ok(same, 'the same poses in another order give bit-identical scores');
}

// ---- 9. classes, words, the chi-square scale ---------------------------------------
ok(poseClassOf(0, 10, 15) === POSE_COMMON && poseClassOf(10, 10, 15) === POSE_UNCOMMON &&
    poseClassOf(15, 10, 15) === POSE_OUTLIER && poseClassOf(99, 10, 0) === POSE_UNCOMMON, 'classes at the thresholds; 0 = no outlier');
ok(poseClassName(POSE_OUTLIER) === 'outlier' && poseClassName(POSE_UNTESTED) === '', 'class names');
close(wilsonHilferty(20, 20), Math.sqrt(2 / 180), 1e-12, 'a chi-square at its mean: sqrt(2 / 9df), just above 0');
ok(wilsonHilferty(60, 20) > 4, 'three times its degrees of freedom: far in the tail');
ok(poseSampleStride(100) === 1 && poseSampleStride(POSE_SAMPLE_FRAMES * 36 + 5) === 36, 'frame stride for the fit');

// ---- 10. the session glue --------------------------------------------------------------
// A minimal eager session: frames of two cameras, each with two predictions and,
// on some frames, a user instance; outliers are planted on frames 7, 70 and 700.
function inst(xy, type) { return { _xy: xy, type: type || 'predicted' }; }
const NF = 1200, rS = rng(11);
const frames = new Map();
for (let f = 0; f < NF; f++) {
    const byCam = new Map();
    for (const cam of ['A', 'B']) {
        const list = [inst(makePose(rS)), inst(makePose(rS))];
        if (f % 50 === 0) list.push(inst(makePose(rS), 'user'));
        byCam.set(cam, list);
    }
    frames.set(f, byCam);
}
const OUTLIERS_AT = [7, 70, 700];
for (const f of OUTLIERS_AT) {
    const p = frames.get(f).get('A')[0]._xy;
    for (let k = 0; k < K; k++) { p[2 * k] = 300 + 80 * rS(); p[2 * k + 1] = 300 + 80 * rS(); }
}
// a scattered USER instance: a person placed it, so it is never judged
const userOutlier = frames.get(100).get('A')[2]._xy;
for (let k = 0; k < K; k++) { userOutlier[2 * k] = 50 + 80 * rS(); userOutlier[2 * k + 1] = 50 + 80 * rS(); }

function fg(f) {
    const byCam = frames.get(f);
    return {
        getInstances: (cam) => byCam.get(cam).slice(0, 1),
        getUnlinkedInstances: (cam) => byCam.get(cam).slice(1).map((i, j) => ({ id: f * 10 + j, instance: i })),
    };
}
const eager = {
    skeleton: { nodes: Array.from({ length: K }, (_, k) => 'n' + k) },
    frameGroups: new Map([...frames.keys()].map((f) => [f, true])),
    get frameIndices() { return [...frames.keys()]; },
    getFrameGroup: fg,
    lazyLoader: null,
};
const cams = [{ name: 'A' }, { name: 'B' }];
const eagerModels = PS.fitSessionPoseModels(eager, cams);
ok(eagerModels.get('A') && eagerModels.get('B'), 'eager: a model per camera');

// The same data through a lazy loader: `getFrameSync` hands out per-camera lists
// of plain entries ({type, points}), as SioLazyLoader does.
const released = [];
const lazy = {
    skeleton: eager.skeleton,
    frameGroups: new Map([[0, true], [600, true]]),          // resident: never released
    lazyLoader: {
        isSync: true, nFrames: NF, cache: new Map([[3, true]]),   // cached: never released
        releaseWindow() {},
        getFrameSync(f) {
            const out = new Map();
            frames.get(f).forEach((list, cam) => out.set(cam, list.map((i) => ({
                type: i.type,
                points: Array.from({ length: K }, (_, k) => [i._xy[2 * k], i._xy[2 * k + 1]]),
            }))));
            return out;
        },
        releaseFrame(f) { released.push(f); },
    },
};
const lazyModels = PS.fitSessionPoseModels(lazy, cams);
let agree = true;
for (let i = 0; i < 200; i++) {
    if (poseScore(lazyModels.get('A'), typical[i]) !== poseScore(eagerModels.get('A'), typical[i])) agree = false;
}
ok(agree, 'lazy and eager sampling of the same predictions give the same model');
ok(released.length === NF - 3 && !released.includes(0) && !released.includes(600) && !released.includes(3),
    `lazy: releases each frame it loaded, but not a resident or cached one (${released.length})`);

// A tracking run over every frame, as buildTrackerInputs drives it — leaving
// outlier out (Tracking Wizard `poseExcludeOutliers`).
const run = PS.createPoseCheckRun(eagerModels, POSE_UNCOMMON_DEFAULT, POSE_OUTLIER_DEFAULT, true);
const left = [];
let userJudged = false;
for (let f = 0; f < NF; f++) {
    for (const cam of ['A', 'B']) {
        for (const i of frames.get(f).get(cam)) {
            const before = run.counts.get(cam) ? run.counts.get(cam).checked + run.counts.get(cam).untested : 0;
            if (PS.poseCheckExcludes(run, cam, i, f)) left.push(f);
            const after = run.counts.get(cam).checked + run.counts.get(cam).untested;
            if (i.type === 'user' && after !== before) userJudged = true;
        }
    }
}
ok(JSON.stringify(left) === JSON.stringify(OUTLIERS_AT), `outliers left out on exactly the planted frames (${JSON.stringify(left)})`);
ok(!userJudged, 'a user instance is never checked (the scattered one included)');
const res = PS.finishPoseCheckRun(run);
ok(res.total.checked === 4 * NF && res.total.outliers === 3, `counts: ${res.total.checked} checked, ${res.total.outliers} outliers`);
ok(res.cameras.length === 2 && res.cameras.every((c) => c.modelled), 'a row per camera, each modelled');
ok(res.excluded === true, 'the result says outliers were left out');
ok(res.flags.every((fl, i) => i === 0 || res.flags[i - 1].frame <= fl.frame), 'flags in frame order');
ok(res.flags.filter((fl) => fl.cls === POSE_OUTLIER).map((fl) => fl.frame).join() === OUTLIERS_AT.join(), 'outlier flags name their frames');
ok(res.total.uncommon <= 0.005 * res.total.checked, `few typical poses flagged uncommon (${res.total.uncommon})`);

// The default: outliers are flagged and counted, but stays in tracking.
const runKeep = PS.createPoseCheckRun(eagerModels, POSE_UNCOMMON_DEFAULT, POSE_OUTLIER_DEFAULT);
let leftKeep = 0;
for (const f of OUTLIERS_AT) if (PS.poseCheckExcludes(runKeep, 'A', frames.get(f).get('A')[0], f)) leftKeep++;
const resKeep = PS.finishPoseCheckRun(runKeep);
ok(leftKeep === 0 && resKeep.total.outliers === 3 && resKeep.excluded === false,
    'by default outliers are flagged and counted, and nothing is left out');
ok(/^Pose: outlier \(score \d+\.\d\)$/.test(PS.poseTooltipLine(PS.poseCheckOf({ poseCheck: resKeep }, 'A', frames.get(7).get('A')[0]), resKeep)),
    '...and its tooltip does not say "not tracked"');

// Outlier threshold 0, even with exclusion asked for: flagged, never left out.
const run0 = PS.createPoseCheckRun(eagerModels, POSE_UNCOMMON_DEFAULT, 0, true);
let left0 = 0;
for (const f of OUTLIERS_AT) if (PS.poseCheckExcludes(run0, 'A', frames.get(f).get('A')[0], f)) left0++;
ok(left0 === 0 && run0.flags.length === 3 && run0.flags.every((fl) => fl.cls === POSE_UNCOMMON),
    'outlier threshold 0: the planted poses are uncommon, and nothing is left out');

// What the views and the tooltip are told.
const session = { poseCheck: res };
const g = frames.get(7).get('A')[0];
const v = PS.poseCheckOf(session, 'A', g);
ok(v && v.cls === POSE_OUTLIER, 'poseCheckOf: the planted pose is an outlier');
ok(/^Pose: outlier \(score \d+\.\d\), not tracked$/.test(PS.poseTooltipLine(v, res)), `tooltip: "${PS.poseTooltipLine(v, res)}"`);
ok(/^Pose: common \(score -?\d+\.\d\)$/.test(PS.poseTooltipLine(PS.poseCheckOf(session, 'A', frames.get(8).get('A')[0]), res)),
    'tooltip of a typical pose');
ok(PS.poseCheckOf(session, 'A', frames.get(100).get('A')[2]) === null, 'no verdict on a user instance');
ok(PS.poseCheckOf({}, 'A', g) === null && PS.poseCheckOf(session, 'Z', g) === null, 'no verdict without a check or a model');

// ---- 11. Tracks ▸ Check Poses: every prediction, nothing left out -------------------------
{
    const progress = [];
    const resE = await PS.checkSessionPoses(eager, cams, POSE_UNCOMMON_DEFAULT, POSE_OUTLIER_DEFAULT,
        { onProgress: (done, total) => { progress.push([done, total]); } });
    ok(resE.total.checked + resE.total.untested === 4 * NF, `check: every prediction of every frame, no user instance (${resE.total.checked + resE.total.untested})`);
    ok(resE.excluded === false, '...and nothing is left out (nothing is tracked)');
    ok(resE.flags.filter((f) => f.cls === POSE_OUTLIER).map((f) => f.frame).join() === OUTLIERS_AT.join(), 'the planted outliers are found');
    ok(progress.length > 1 && progress.every((p, i) => i === 0 || p[0] > progress[i - 1][0]) &&
        progress[progress.length - 1][0] === NF && progress[progress.length - 1][1] === NF, 'progress is reported, rising, ending at the total');
    ok(/^2D poses: (\d+ uncommon, )?3 outliers of [\d,]+ checked — marked \? and ✕ in the views; hover a node for its score$/.test(PS.describePoseCheck(resE)),
        `status line: "${PS.describePoseCheck(resE)}"`);
    ok(PS.describePoseCheck(Object.assign({}, resE, { total: Object.assign({}, resE.total, { uncommon: 0, outliers: 0 }) })) ===
        '2D poses: none flagged of ' + resE.total.checked.toLocaleString('en-US') + ' checked', 'status line: nothing flagged');
    ok(PS.describePoseCheck({ cameras: [{ name: 'A', modelled: false }], total: {} }) ===
        '2D poses: not checked — too few complete poses to learn from', 'status line: nothing could be modelled');

    // A lazy project: frame 700 is RESIDENT, and there its planted outlier has been
    // edited back to a typical pose in memory — the store still holds the outlier.
    // The check must read the resident frame from the session, the rest from the store.
    const edited = new Map([...frames.get(700)].map(([cam, list]) => [cam, list.slice()]));
    edited.get('A')[0] = inst(makePose(rng(12)));
    const released2 = [];
    const lazy2 = {
        skeleton: eager.skeleton,
        frameGroups: new Map([[700, true]]),
        getFrameGroup: (f) => f === 700 ? {
            getInstances: (cam) => edited.get(cam).slice(0, 1),
            getUnlinkedInstances: (cam) => edited.get(cam).slice(1).map((i, j) => ({ id: j, instance: i })),
        } : undefined,
        lazyLoader: Object.assign({}, lazy.lazyLoader, { cache: new Map([[3, true]]), releaseFrame(f) { released2.push(f); } }),
    };
    const resL = await PS.checkSessionPoses(lazy2, cams, POSE_UNCOMMON_DEFAULT, POSE_OUTLIER_DEFAULT);
    ok(resL.total.checked + resL.total.untested === 4 * NF, 'lazy check: every prediction, the same count');
    ok(resL.flags.filter((f) => f.cls === POSE_OUTLIER).map((f) => f.frame).join() === '7,70',
        `lazy check: the resident frame is read from the session (its edit is seen), the rest from the store (${resL.flags.filter((f) => f.cls === POSE_OUTLIER).map((f) => f.frame)})`);
    const rel = new Set(released2);
    ok(!rel.has(700) && !rel.has(3) && rel.size === NF - 2, 'lazy check: releases every frame it loaded, never a resident or cached one');
}

// ---- 12. once a check is done its pattern cache is trimmed — and no score changes ---------
{
    const m = fitPoseModel(sample.poses, K);
    const rp = rng(13), poses = [];
    for (let i = 0; i < 3000; i++) poses.push(dropNodes(makePose(rp), rp, 0.25));
    const before = poses.map((p) => poseScore(m, p));
    const n0 = m.patterns.size;
    const complete = (1 << K) - 1;
    PC.trimPosePatterns(m, 16);
    ok(n0 > 16 && m.patterns.size === 16, `trimmed to the 16 most-used patterns (from ${n0})`);
    ok(m.patterns.has(complete), '...the complete pattern, the most used, is kept');
    const after = poses.map((p) => poseScore(m, p));
    ok(after.every((z, i) => Object.is(z, before[i])), '...and every score is bit-identical (dropped patterns rebuild exactly)');
    ok(PC.POSE_PATTERN_KEEP === 128, 'a finished check keeps 128 per camera');
}

// ---- 13. Next / Previous Flagged Pose: the stops, and what the status bar says ------------
{
    const pcF = { flags: [
        { frame: 5, camera: 'A', cls: POSE_UNCOMMON, score: 11.24 },
        { frame: 5, camera: 'B', cls: POSE_OUTLIER, score: 18.04 },
        { frame: 9, camera: 'A', cls: POSE_OUTLIER, score: 22.5 },
        { frame: 1234, camera: 'B', cls: POSE_UNCOMMON, score: 10.0 },
    ] };
    ok(JSON.stringify(PS.flaggedFrames(pcF)) === '[5,9,1234]', 'the stops are the distinct flagged frames, in order');
    ok(PS.nextFlaggedFrame(pcF, 0, 1) === 5 && PS.nextFlaggedFrame(pcF, 5, 1) === 9 && PS.nextFlaggedFrame(pcF, 6, 1) === 9 &&
        PS.nextFlaggedFrame(pcF, 1234, 1) === -1, 'next: strictly after the current frame; none past the last');
    ok(PS.nextFlaggedFrame(pcF, 9, -1) === 5 && PS.nextFlaggedFrame(pcF, 8, -1) === 5 && PS.nextFlaggedFrame(pcF, 5, -1) === -1 &&
        PS.nextFlaggedFrame(pcF, 99999, -1) === 1234, 'previous: strictly before; none before the first');
    ok(PS.describeFlaggedFrame(pcF, 5) === 'Flagged frame 1 of 3 (frame 6): uncommon in A (score 11.2), outlier in B (score 18.0)',
        `status at a stop, 1-based and naming each flag: "${PS.describeFlaggedFrame(pcF, 5)}"`);
    ok(PS.describeFlaggedFrame(pcF, 1234) === 'Flagged frame 3 of 3 (frame 1,235): uncommon in B (score 10.0)', 'thousands commas');
    ok(PS.describeNoFlaggedFrame(pcF, 1234, 1) === 'No flagged pose after frame 1,235 (3 flagged frames)', 'past the last');
    ok(PS.describeNoFlaggedFrame(pcF, 5, -1) === 'No flagged pose before frame 6 (3 flagged frames)', 'before the first');
    ok(PS.describeNoFlaggedFrame(null, 0, 1) === 'No pose check on this session — run Track All or Tracks ▸ Check Poses first', 'no check yet');
    ok(PS.describeNoFlaggedFrame({ flags: [] }, 0, 1) === 'No flagged poses: the last pose check flagged nothing', 'nothing flagged');
    const pc1 = { flags: [{ frame: 3, camera: 'A', cls: POSE_OUTLIER, score: 16 }] };
    ok(PS.describeNoFlaggedFrame(pc1, 3, 1) === 'No flagged pose after frame 4 (1 flagged frame)', 'one flagged frame: singular');
    // the cache follows the flags array it was built from
    pcF.flags = pcF.flags.slice(0, 1);
    ok(JSON.stringify(PS.flaggedFrames(pcF)) === '[5]', 'a new flags array is re-read, not served stale from the cache');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { failures.forEach((f) => console.error('  ✗ ' + f)); process.exit(1); }
