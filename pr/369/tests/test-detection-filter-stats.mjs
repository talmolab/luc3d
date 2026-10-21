/**
 * test-detection-filter-stats.mjs — the Tracking Wizard's count of what the
 * detection filters would remove (pose/detection-filter-stats.js).
 *
 *  1. The two primitives, and that the tracker's predicate is built on them
 *     (and that pose/tracker.js imports it rather than keeping its own).
 *  2. An eager session: per-camera and total counts, "removed" and "fail both",
 *     and — for a sweep of values — the counter agrees with
 *     `passesDetectionFilter` applied to every in-memory detection.
 *  3. Missing scores: all-zero instance scores and absent point scores are
 *     REPORTED (`hasInstanceScores` / `hasPointScores`), and an all-zero score
 *     is still counted the way the tracker filters it.
 *  4. An empty pool, no session and null stats.
 *  5. A lazy session: store rows read with hydration's values, resident frames
 *     read from memory and not counted twice.
 *  6. Cameras excluded from tracking stay in the rows but leave the total.
 *  7. The mean-point-confidence preview and histograms.
 *  8. The async walk equals the sync one, and stops when cancelled.
 *  9. `fmtShare` (ui/detection-filter-preview.js).
 *
 * Run:  node tests/test-detection-filter-stats.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { Instance, Session, Skeleton, FrameGroup, UnlinkedInstance } = await imp('pose/pose-data.js');
const { SioLazyLoader } = await imp('loading/sio-lazy-loader.js');
const F = await imp('pose/detection-filter-stats.js');
const { fmtShare } = await imp('ui/detection-filter-preview.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
    if (cond) passed++;
    else { failed++; console.error('  ✗ ' + msg); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const NODES = ['head', 'trunk', 'tail', 'ear'];
const P = (n) => {           // n present points out of 4
    const out = [];
    for (let k = 0; k < 4; k++) out.push(k < n ? [10 + k, 20 + k] : null);
    return out;
};
function pred(n, score, pointScores) {
    const inst = new Instance(P(n), 0, 'predicted', score);
    if (pointScores) inst.setPointScores(pointScores);
    return inst;
}
function makeSession(camNames) {
    const s = new Session(camNames.map((name) => ({ name })), new Skeleton('m', NODES.slice(), []), [], 'S');
    return s;
}
function frame(s, fi) {
    let fg = s.frameGroups.get(fi);
    if (!fg) { fg = new FrameGroup(fi); s.frameGroups.set(fi, fg); }
    return fg;
}

// ---------------------------------------------------------------------------
// 1. Primitives
// ---------------------------------------------------------------------------
{
    ok(!F.failsMinVisibleNodes(2, 0), 'min visible 0 is off');
    ok(F.failsMinVisibleNodes(2, 3) && !F.failsMinVisibleNodes(3, 3), 'fewer than the minimum fails; equal passes');
    ok(!F.failsMinInstanceScore(0.1, 0), 'min score 0 is off');
    ok(F.failsMinInstanceScore(0.4, 0.5) && !F.failsMinInstanceScore(0.5, 0.5), 'below fails; equal passes');
    ok(!F.failsMinInstanceScore(null, 0.5) && !F.failsMinInstanceScore(undefined, 0.5) && !F.failsMinInstanceScore(NaN, 0.5),
        'a detection with no score is never filtered');
    ok(F.failsMinInstanceScore(0, 0.5), 'a score of 0 is filtered (it is what loaders write for a missing score)');
    const inst = pred(2, 0.4);
    ok(!F.passesDetectionFilter(inst, 3, 0) && !F.passesDetectionFilter(inst, 0, 0.5) && F.passesDetectionFilter(inst, 2, 0.4),
        'passesDetectionFilter is the two primitives');

    const trackerSrc = fs.readFileSync(path.join(ROOT, 'pose/tracker.js'), 'utf8');
    ok(/import \{ passesDetectionFilter \} from '\.\/detection-filter-stats\.js'/.test(trackerSrc) &&
        !/function passesDetectionFilter/.test(trackerSrc),
        'pose/tracker.js filters with THIS predicate, not a copy of it');
}

// ---------------------------------------------------------------------------
// 2. Eager session
// ---------------------------------------------------------------------------
function eagerSession() {
    const s = makeSession(['top', 'side']);
    // frame 0: top has a grouped (linked) good prediction + an unlinked weak one;
    //          side has two weak ones (one also short).
    const f0 = frame(s, 0);
    f0.addInstance('top', pred(4, 0.9, [0.9, 0.9, 0.8, 0.8]));
    f0.addUnlinkedInstance('top', new UnlinkedInstance(pred(2, 0.3, [0.5, 0.5, NaN, NaN]), 'top'));
    f0.addUnlinkedInstance('side', new UnlinkedInstance(pred(4, 0.4, [0.6, 0.6, 0.7, 0.7]), 'side'));
    f0.addUnlinkedInstance('side', new UnlinkedInstance(pred(1, 0.2, [0.3, NaN, NaN, NaN]), 'side'));
    // frame 1: a hand-labelled instance on top (score 1), a good prediction on side.
    const f1 = frame(s, 1);
    f1.addInstance('top', new Instance(P(3), 0, 'user', 1));
    f1.addUnlinkedInstance('side', new UnlinkedInstance(pred(4, 0.95, [0.9, 0.95, 0.9, 0.95]), 'side'));
    return s;
}
{
    const s = eagerSession();
    const st = F.collectDetectionStats(s);
    ok(st.n === 6 && st.cameras.join() === 'top,side', `six detections over two cameras (${st.n})`);
    ok(st.perCamera[0].detections === 3 && st.perCamera[1].detections === 3, 'three per camera');
    ok(st.hasInstanceScores && st.hasPointScores, 'scores are reported present');

    const c = F.countDetectionFilters(st, { minVisibleNodes: 3, minInstanceScore: 0.5 });
    const [top, side] = c.perCamera;
    ok(top.failVisible === 1 && top.failScore === 1 && top.removed === 1 && top.failsBoth === 1,
        `top: the weak unlinked one fails both (${JSON.stringify(top)})`);
    ok(side.failVisible === 1 && side.failScore === 2 && side.removed === 2 && side.failsBoth === 1,
        `side: two removed, one of them on both counts (${JSON.stringify(side)})`);
    ok(c.total.detections === 6 && c.total.removed === 3 && c.total.failsBoth === 2 &&
        c.total.failVisible === 2 && c.total.failScore === 3, `total (${JSON.stringify(c.total)})`);

    const off = F.countDetectionFilters(st, {});
    ok(off.total.removed === 0 && off.total.failVisible === 0 && off.total.failScore === 0, 'filters at 0 remove nothing');

    // The counter and the tracker's predicate agree on every value in a sweep.
    const all = [];
    for (const [, fg] of s.frameGroups) for (const cam of ['top', 'side']) {
        fg.getInstances(cam).forEach((i) => all.push(i));
        fg.getUnlinkedInstances(cam).forEach((u) => all.push(u.instance));
    }
    let agree = true;
    for (const minVis of [0, 1, 2, 3, 4, 5]) for (const minScore of [0, 0.25, 0.3, 0.5, 0.9, 1]) {
        const expect = all.filter((i) => !F.passesDetectionFilter(i, minVis, minScore)).length;
        const got = F.countDetectionFilters(st, { minVisibleNodes: minVis, minInstanceScore: minScore }).total.removed;
        if (got !== expect) { agree = false; console.error(`    vis ${minVis} score ${minScore}: ${got} vs ${expect}`); }
    }
    ok(agree, 'for every value in a sweep, "removed" equals what passesDetectionFilter drops');

    const mp = F.countDetectionFilters(st, { minMeanPointScore: 0.75 });
    // mean point scores (over ALL 4 nodes, missing = 0): top 0.85, 0.25, (user: none) | side 0.65, 0.075, 0.925
    ok(mp.perCamera[0].failMeanPointScore === 1 && mp.perCamera[1].failMeanPointScore === 2 && mp.total.withPointScores === 5,
        `mean-point preview counts over detections that have point scores (${mp.total.failMeanPointScore}/${mp.total.withPointScores})`);
    ok(mp.total.removed === 0, 'the preview never enters "removed"');
    ok(near(st.meanPointScore[1], 0.25), 'mean point score averages ALL nodes, a missing one counting as 0 (sleap-nn\'s mean node score)');
}

// ---------------------------------------------------------------------------
// 3. Missing scores
// ---------------------------------------------------------------------------
{
    const s = makeSession(['a', 'b']);
    const fg = frame(s, 0);
    fg.addUnlinkedInstance('a', new UnlinkedInstance(pred(4, 0), 'a'));
    fg.addUnlinkedInstance('a', new UnlinkedInstance(pred(4, 0), 'a'));
    fg.addUnlinkedInstance('b', new UnlinkedInstance(pred(4, 0), 'b'));
    const st = F.collectDetectionStats(s);
    ok(!st.hasInstanceScores && st.totals.predicted === 3 && st.totals.predictedWithScore === 0,
        'all-zero instance scores are reported as missing');
    ok(!st.hasPointScores && Number.isNaN(st.meanPointScore[0]), 'no point scores: reported missing, mean is NaN');
    const c = F.countDetectionFilters(st, { minInstanceScore: 0.5, minMeanPointScore: 0.75 });
    ok(c.total.failScore === 3, 'with no scores, a minimum above 0 removes every prediction — as the tracker would');
    ok(c.total.failMeanPointScore === 0 && c.total.withPointScores === 0, 'nothing is "below" a confidence nobody has');

    // One camera with scores, one without: per-camera flags tell them apart.
    const s2 = makeSession(['a', 'b']);
    frame(s2, 0).addUnlinkedInstance('a', new UnlinkedInstance(pred(4, 0.8), 'a'));
    frame(s2, 0).addUnlinkedInstance('b', new UnlinkedInstance(pred(4, 0), 'b'));
    const st2 = F.collectDetectionStats(s2);
    ok(st2.hasInstanceScores && st2.perCamera[0].predictedWithScore === 1 && st2.perCamera[1].predictedWithScore === 0,
        'a camera whose file has no scores is identifiable on its own');

    // A user instance's score says nothing about whether predictions have one.
    const s3 = makeSession(['a']);
    frame(s3, 0).addInstance('a', new Instance(P(4), 0, 'user', 1));
    const st3 = F.collectDetectionStats(s3);
    ok(st3.totals.predicted === 0 && !st3.hasInstanceScores, 'hand labels alone do not count as instance scores');
}

// ---------------------------------------------------------------------------
// 4. Empty pool
// ---------------------------------------------------------------------------
{
    const st = F.collectDetectionStats(makeSession(['a', 'b']));
    ok(st.n === 0 && st.perCamera.length === 2 && st.perCamera.every((p) => p.detections === 0), 'empty session: no detections');
    const c = F.countDetectionFilters(st, { minVisibleNodes: 5, minInstanceScore: 0.9, minMeanPointScore: 0.9 });
    ok(c.total.detections === 0 && c.total.removed === 0 && c.perCamera.every((r) => r.removed === 0), 'empty pool counts to zero');
    ok(!st.hasInstanceScores && !st.hasPointScores, 'empty pool has no scores');

    const none = F.collectDetectionStats(null);
    ok(none.n === 0 && none.cameras.length === 0, 'no session');
    const nul = F.countDetectionFilters(null, { minVisibleNodes: 3 });
    ok(nul.perCamera.length === 0 && nul.total.detections === 0, 'null stats count to an empty result');
    ok(F.meanPointScoreHistograms(null).length === 0, 'null stats: no histograms');
}

// ---------------------------------------------------------------------------
// 5. Lazy session
// ---------------------------------------------------------------------------
{
    // camA store: frame 10 -> [pred(4 pts, score .9), user(2 pts), pred(3 pts, score NaN)]
    //             frame 11 -> [pred(1 pt, score .2)]   (frame 11 is RESIDENT)
    const N = NaN;
    const store = {
        framesData: { instance_id_start: new Float64Array([0, 3]), instance_id_end: new Float64Array([3, 4]) },
        instancesData: {
            instance_type: new Float64Array([1, 0, 1, 1]),
            skeleton: new Float64Array([0, 0, 0, 0]),
            score: new Float64Array([0.9, 0, NaN, 0.2]),
            track: new Float64Array([-1, -1, -1, -1]),
            point_id_start: new Float64Array([0, 0, 4, 8]),
            point_id_end: new Float64Array([4, 4, 8, 12]),
        },
        pointsData: { x: new Float64Array([1, 2, N, N]), y: new Float64Array([1, 2, N, N]) },
        predPointsData: {
            x: new Float64Array([1, 2, 3, 4, 1, 2, 3, N, 5, N, N, N]),
            y: new Float64Array([1, 2, 3, 4, 1, 2, 3, N, 5, N, N, N]),
            score: new Float64Array([0.8, 0.8, 0.6, 0.6, 0.5, 0.4, 0.3, 0.99, 0.1, 0.1, 0.1, 0.1]),
        },
        skeletons: [{ nodeNames: NODES.slice() }],
    };
    const loader = new SioLazyLoader();
    loader.labelsByCam.set('camA', { _lazyDataStore: store });
    loader.frameRowByCam.set('camA', new Map([[10, 0], [11, 1]]));
    loader.numNodesByCam.set('camA', 4);

    const s = makeSession(['camA', 'camB']);
    s.lazyLoader = loader;
    // Frame 11 is resident, edited in memory to a 4-point instance scoring 0.7.
    const res = new Instance(P(4), -1, 'predicted', 0.7);
    res._rawInstIndex = 0;
    frame(s, 11).addUnlinkedInstance('camA', new UnlinkedInstance(res, 'camA'));
    // camB has no store; its one resident detection still counts.
    frame(s, 11).addUnlinkedInstance('camB', new UnlinkedInstance(pred(2, 0.6), 'camB'));

    const st = F.collectDetectionStats(s);
    ok(st.n === 5, `three store rows + two resident detections, none twice (${st.n})`);
    const a = [];
    for (let i = 0; i < st.n; i++) if (st.cam[i] === 0) a.push({ v: st.visible[i], s: st.score[i], m: st.meanPointScore[i], p: st.predicted[i] });
    ok(a.length === 4, 'camA: three store rows and the resident frame');
    ok(a[0].v === 4 && near(a[0].s, 0.9) && near(a[0].m, 0.7) && a[0].p === 1, 'store prediction: points, score, mean confidence');
    ok(a[1].v === 2 && a[1].s === 0 && Number.isNaN(a[1].m) && a[1].p === 0, 'store user row: score 0 (as hydration gives it), no confidence');
    ok(a[2].v === 3 && a[2].s === 0 && near(a[2].m, 0.3), 'store NaN score hydrates to 0; the absent 4th point counts as 0');
    ok(a[3].v === 4 && near(a[3].s, 0.7) && near(a[3].m, 0.1), 'the resident frame is read from MEMORY (its edit), confidence from the store row by name');

    // What the tracker would do to the hydrated frame-10 instances.
    const hydrated = [new Instance(P(4), -1, 'predicted', 0.9), new Instance(P(2), -1, 'user', 0),
        new Instance(P(3), -1, 'predicted', 0), res];
    let agree = true;
    for (const mv of [0, 2, 3, 4]) for (const ms of [0, 0.5, 0.8, 1]) {
        const exp = hydrated.filter((i) => !F.passesDetectionFilter(i, mv, ms)).length;
        const got = F.countDetectionFilters(st, { minVisibleNodes: mv, minInstanceScore: ms }).perCamera[0].removed;
        if (exp !== got) { agree = false; console.error(`    lazy vis ${mv} score ${ms}: ${got} vs ${exp}`); }
    }
    ok(agree, 'lazy counts equal the tracker\'s verdict on the hydrated instances');
}

// ---------------------------------------------------------------------------
// 6. Excluded cameras
// ---------------------------------------------------------------------------
{
    const st = F.collectDetectionStats(eagerSession());
    const c = F.countDetectionFilters(st, { minVisibleNodes: 3, minInstanceScore: 0.5 }, (n) => n !== 'side');
    ok(c.perCamera[1].included === false && c.perCamera[1].removed === 2, 'an excluded camera keeps its own row');
    ok(c.total.detections === 3 && c.total.removed === 1, 'but leaves the total');
}

// ---------------------------------------------------------------------------
// 7. Histograms
// ---------------------------------------------------------------------------
{
    const st = F.collectDetectionStats(eagerSession());
    const h = F.meanPointScoreHistograms(st, 10);
    ok(h.length === 2 && h[0].count === 2 && h[1].count === 3, 'user instances and score-less detections are left out');
    ok(h[0].bins[8] === 1 && h[0].bins[2] === 1 && near(h[0].median, 0.55), `top: bins and median (${h[0].median})`);
    ok(h[1].bins[0] === 1 && h[1].bins[6] === 1 && h[1].bins[9] === 1 && near(h[1].median, 0.65), 'side: bins and median');

    const s = makeSession(['a']);
    frame(s, 0).addUnlinkedInstance('a', new UnlinkedInstance(pred(4, 0.9, [1.4, 1.4, 1.4, 1.4]), 'a'));
    const h2 = F.meanPointScoreHistograms(F.collectDetectionStats(s), 10);
    ok(h2[0].bins[9] === 1, 'a confidence above 1 lands in the last bin');
}

// ---------------------------------------------------------------------------
// 8. Async
// ---------------------------------------------------------------------------
{
    const s = eagerSession();
    const sync = F.collectDetectionStats(s);
    const as = await F.collectDetectionStatsAsync(s);
    ok(as.n === sync.n && Array.from(as.visible).join() === Array.from(sync.visible).join() &&
        Array.from(as.cam).join() === Array.from(sync.cam).join(), 'async walk equals the sync one');
    let calls = 0;
    const cancelled = await F.collectDetectionStatsAsync(s, { isCancelled: () => ++calls > 1 });
    ok(cancelled === null, 'a cancelled walk returns null');

    // Growth past the initial capacity.
    const big = makeSession(['a']);
    for (let f = 0; f < 1500; f++) frame(big, f).addUnlinkedInstance('a', new UnlinkedInstance(pred(1 + (f % 4), f / 1500), 'a'));
    const bs = F.collectDetectionStats(big);
    ok(bs.n === 1500 && bs.visible[1499] === 4 && near(bs.score[1499], 1499 / 1500), 'columns grow past their first capacity');
}

// ---------------------------------------------------------------------------
// 9. fmtShare
// ---------------------------------------------------------------------------
{
    ok(fmtShare(0, 0) === '—' && fmtShare(0, 10) === '0%' && fmtShare(1, 4) === '25.0%', 'plain shares');
    ok(fmtShare(1, 10000) === '<0.1%' && fmtShare(9999, 10000) === '>99.9%' && fmtShare(5, 5) === '100%', 'slivers are never rounded to 0% or 100%');
}

console.log(`\ntest-detection-filter-stats: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
