/**
 * test-node-scores.mjs — a prediction's per-node model scores: where they are
 * kept, and how the node tooltip finds one.
 *
 *  - The shared score pool behind `Instance.setPointScores` / `pointScore`
 *    (pose/pose-data.js): every instance reads back ITS OWN scores, across the
 *    first chunk's growth and across chunk boundaries; node insert/remove keep
 *    them aligned; a shared segment is never edited in place.
 *  - `Session.predictedNodeScore`: only a 'predicted' instance has a score; an
 *    eager one answers from its own scores, a lazy one from the store, BY NAME.
 *  - `SioLazyLoader.predictedPointScore` against a hand-built columnar store —
 *    the real store is exercised by tests/e2e/node-score-tooltip.mjs.
 *  - `nodeTooltipText`: SLEAP 1.6.5's exact text.
 *
 * Run:  node tests/test-node-scores.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { Instance, Session, Skeleton } = await imp('pose/pose-data.js');
const { SioLazyLoader } = await imp('loading/sio-lazy-loader.js');
const { nodeTooltipText } = await imp('ui/node-tooltip.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
    if (cond) passed++;
    else { failed++; console.error('  ✗ ' + msg); }
}
const f32 = (v) => Math.fround(v);
const sameScore = (a, b) => (Number.isNaN(a) && Number.isNaN(b)) || a === f32(b);

// ---------------------------------------------------------------------------
// 1. One instance: round trip, defaults, bounds
// ---------------------------------------------------------------------------
{
    const inst = new Instance([[1, 2], [3, 4], [5, 6]], 0, 'predicted', 0.6);
    ok(!inst.hasPointScores(), 'a new instance carries no scores');
    ok(Number.isNaN(inst.pointScore(0)), 'and reads NaN');
    inst.setPointScores([0.91, null, 0.07]);
    ok(inst.hasPointScores(), 'setPointScores keeps them');
    ok(inst.pointScore(0) === f32(0.91) && inst.pointScore(2) === f32(0.07), 'each node reads back its own score (float32)');
    ok(Number.isNaN(inst.pointScore(1)), 'a null score reads NaN');
    ok(Number.isNaN(inst.pointScore(-1)) && Number.isNaN(inst.pointScore(3)) && Number.isNaN(inst.pointScore(null)),
        'an out-of-range node reads NaN, not a neighbour');
    inst.setPointScores(null);
    ok(!inst.hasPointScores(), 'null clears them');

    const col = new Float64Array([9, 9, 9, 0.1, 0.2, 0.3, 9]);
    const b = new Instance([[1, 2], [3, 4], [5, 6]], 0, 'predicted', 0.6);
    b.setPointScores(col, 3);
    ok([0, 1, 2].every(k => b.pointScore(k) === f32(col[3 + k])), 'a start offset reads that instance\'s slice of a column');
    col[4] = 0.99;
    ok(b.pointScore(1) === f32(0.2), 'the scores are COPIED, not a view of the caller\'s buffer');
}

// ---------------------------------------------------------------------------
// 2. Many instances: growth of the first chunk, then whole new chunks.
//    Nodes per instance chosen so segments do not divide the chunk evenly.
// ---------------------------------------------------------------------------
{
    const N = 13, COUNT = 200000;        // 2.6M scores > two 1M-score chunks
    const insts = new Array(COUNT);
    const scoreOf = (i, k) => ((i * 31 + k * 7) % 1000) / 1000;
    for (let i = 0; i < COUNT; i++) {
        const inst = new Instance(N, 0, 'predicted', 0.5);
        const s = new Array(N);
        for (let k = 0; k < N; k++) s[k] = scoreOf(i, k);
        inst.setPointScores(s);
        insts[i] = inst;
    }
    let bad = 0;
    for (let i = 0; i < COUNT; i++) {
        for (let k = 0; k < N; k++) if (!sameScore(insts[i].pointScore(k), scoreOf(i, k))) { bad++; break; }
    }
    ok(bad === 0, `all ${COUNT} instances read back their own scores across chunk growth and boundaries (${bad} wrong)`);
    const handles = new Set(insts.map(x => Math.floor(x._ps / (1 << 20))));
    ok(handles.size >= 3, `the fixture really spans several chunks (${handles.size})`);
}

// ---------------------------------------------------------------------------
// 3. Shared segments and skeleton node insert/remove
// ---------------------------------------------------------------------------
{
    const a = new Instance([[1, 1], [2, 2], [3, 3]], 0, 'predicted', 0.5);
    a.setPointScores([0.1, 0.2, 0.3]);
    const b = new Instance([[1, 1], [2, 2], [3, 3]], 0, 'predicted', 0.5);
    b.adoptPointScoresFrom(a);
    ok(b.pointScore(2) === f32(0.3), 'adoptPointScoresFrom shares the scores');

    a.removeNodeAt(1);
    ok(a.numNodes === 2 && a.pointScore(0) === f32(0.1) && a.pointScore(1) === f32(0.3),
        'removing a node removes ITS score; the next node keeps its own');
    ok(b.pointScore(1) === f32(0.2) && b.pointScore(2) === f32(0.3), 'and the instance sharing the old segment is untouched');

    a.insertNodeAt(1);
    ok(a.numNodes === 3 && a.pointScore(0) === f32(0.1) && Number.isNaN(a.pointScore(1)) && a.pointScore(2) === f32(0.3),
        'an inserted node has no score; the others keep theirs');
    a.insertNodeAt(3);
    ok(a.numNodes === 4 && Number.isNaN(a.pointScore(3)) && a.pointScore(2) === f32(0.3), 'appending a node too');

    const plain = new Instance([[1, 1], [2, 2]], 0, 'predicted', 0.5);
    plain.insertNodeAt(0);
    ok(!plain.hasPointScores(), 'an instance with no scores still has none after a node edit');
}

// ---------------------------------------------------------------------------
// 4. A hand-built lazy store: two camera-frames, multi-instance, a user row
// ---------------------------------------------------------------------------
const NODES = ['head', 'trunk', 'tail'];
function fakeLoader(storeNodeNames) {
    // Frame row 0 (video frame 10): a prediction, a user instance, a prediction.
    // Frame row 1 (video frame 11): one prediction.
    const store = {
        framesData: { instance_id_start: new Float64Array([0, 3]), instance_id_end: new Float64Array([3, 4]) },
        instancesData: {
            instance_type: new Float64Array([1, 0, 1, 1]),
            skeleton: new Float64Array([0, 0, 0, 0]),
            point_id_start: new Float64Array([0, 0, 3, 6]),   // the user row points into `points`
            point_id_end: new Float64Array([3, 3, 6, 9]),
        },
        predPointsData: { score: new Float64Array([0.11, 0.12, 0.13, 0.31, 0.32, 0.33, 0.41, 0.42, NaN]) },
        skeletons: [{ nodeNames: storeNodeNames }],
    };
    const loader = new SioLazyLoader();
    loader.labelsByCam.set('camA', { _lazyDataStore: store });
    loader.frameRowByCam.set('camA', new Map([[10, 0], [11, 1]]));
    return loader;
}
{
    const L = fakeLoader(NODES);
    ok(L.predictedPointScore('camA', 10, 0, 'trunk') === 0.12, 'offset 0, trunk');
    ok(L.predictedPointScore('camA', 10, 2, 'tail') === 0.33, 'offset 2 skips the user row between');
    ok(L.predictedPointScore('camA', 11, 0, 'head') === 0.41, 'a second frame row');
    ok(Number.isNaN(L.predictedPointScore('camA', 10, 1, 'head')), 'a USER row has no score');
    ok(Number.isNaN(L.predictedPointScore('camA', 11, 0, 'tail')), 'a NaN score stays NaN');
    ok(Number.isNaN(L.predictedPointScore('camA', 10, 3, 'head')), 'an offset past the frame\'s rows is NaN, not the next frame\'s');
    ok(Number.isNaN(L.predictedPointScore('camA', 12, 0, 'head')), 'a frame with no row');
    ok(Number.isNaN(L.predictedPointScore('camA', 10, null, 'head')), 'a null offset is not offset 0');
    ok(Number.isNaN(L.predictedPointScore('camB', 10, 0, 'head')), 'a camera the loader does not back');
    ok(Number.isNaN(L.predictedPointScore('camA', 10, 0, 'whisker')), 'a node the store\'s skeleton lacks');

    // The store's skeleton lists the nodes in another order: a name still
    // finds its own score.
    const R = fakeLoader(['tail', 'head', 'trunk']);
    ok(R.predictedPointScore('camA', 10, 0, 'head') === 0.12 && R.predictedPointScore('camA', 10, 0, 'tail') === 0.11,
        'lookup is by the store skeleton\'s node NAME');

    // A camera whose file orders the nodes differently from the session has its rows
    // RE-ORDERED into the session's order (`_unifyNodeOrder` -> `permuteStoreNodeRows`,
    // talmolab/luc3d#296), while its store skeleton keeps the file's: the name must be
    // read in the rows' CURRENT order, or every node gets its neighbour's score.
    const U = fakeLoader(['tail', 'head', 'trunk']);   // file order; the rows are in it, as read
    U.skeleton = { nodes: NODES.slice() };              // the session's order
    U._nodeOrderByCam.set('camA', ['tail', 'head', 'trunk']);
    U._unifyNodeOrder();
    const sc = U.labelsByCam.get('camA')._lazyDataStore.predPointsData.score;
    ok(sc[0] === 0.12 && sc[1] === 0.13 && sc[2] === 0.11, 'precondition: the rows were re-ordered into the session\'s order');
    ok(U.predictedPointScore('camA', 10, 0, 'head') === 0.12 && U.predictedPointScore('camA', 10, 0, 'trunk') === 0.13 &&
        U.predictedPointScore('camA', 10, 0, 'tail') === 0.11, 're-ordered rows: every node still finds its OWN score');
    // frame 11's row reads tail 0.41, head 0.42, trunk NaN in the file's order
    ok(U.predictedPointScore('camA', 11, 0, 'head') === 0.42 && U.predictedPointScore('camA', 11, 0, 'tail') === 0.41 &&
        Number.isNaN(U.predictedPointScore('camA', 11, 0, 'trunk')), 're-ordered rows: on the next frame too (and the NaN score moved with its node)');
}

// ---------------------------------------------------------------------------
// 5. Session.predictedNodeScore
// ---------------------------------------------------------------------------
{
    const sk = new Skeleton('sk', NODES.slice(), [[0, 1], [1, 2]]);
    const session = new Session([], sk, ['t0'], 'S');

    const eager = new Instance([[1, 1], [2, 2], [3, 3]], 0, 'predicted', 0.6);
    eager.setPointScores([0.9, 0.8, 0.7]);
    ok(session.predictedNodeScore('camA', 10, eager, 1) === f32(0.8), 'an eager prediction answers from its own scores');
    eager.type = 'user';
    ok(Number.isNaN(session.predictedNodeScore('camA', 10, eager, 1)), 'once edited (user) it has no score');
    eager.type = 'reprojected';
    ok(Number.isNaN(session.predictedNodeScore('camA', 10, eager, 1)), 'a reprojection has no score');
    ok(Number.isNaN(session.predictedNodeScore('camA', 10, null, 1)), 'no instance');

    session.lazyLoader = fakeLoader(NODES);
    const lazy = new Instance([[1, 1], [2, 2], [3, 3]], 0, 'predicted', 0.6);
    ok(Number.isNaN(session.predictedNodeScore('camA', 10, lazy, 0)), 'a lazy-session instance with no store row has none');
    lazy._rawInstIndex = null;
    ok(Number.isNaN(session.predictedNodeScore('camA', 10, lazy, 0)), 'nor with a null one (null >= 0 is true in JS)');
    lazy._rawInstIndex = 2;
    ok(session.predictedNodeScore('camA', 10, lazy, 0) === 0.31, 'a hydrated one reads its store row');
    ok(session.predictedNodeScore('camA', 10, lazy, 2) === 0.33, 'every node');

    // A skeleton edit after loading: 'head' removed from the session and the
    // resident instance. Node 0 is now 'trunk' — it must get trunk's score,
    // not head's, which an index lookup would return.
    sk.nodes.splice(0, 1);
    lazy.removeNodeAt(0);
    ok(session.predictedNodeScore('camA', 10, lazy, 0) === 0.32, 'after a node removal, node 0 (trunk) gets trunk\'s score');
    ok(session.predictedNodeScore('camA', 10, lazy, 1) === 0.33, 'and node 1 (tail) gets tail\'s');
    sk.nodes.push('whisker');
    lazy.insertNodeAt(2);
    ok(Number.isNaN(session.predictedNodeScore('camA', 10, lazy, 2)), 'a node added after loading has no score');
}

// ---------------------------------------------------------------------------
// 6. Tooltip text — SLEAP 1.6.5: f"{name}\n(score: {score:.2f})", else name
// ---------------------------------------------------------------------------
ok(nodeTooltipText('trunk', 0.94) === 'trunk\n(score: 0.94)', 'name and score, two decimals');
ok(nodeTooltipText('trunk', Math.fround(0.42)) === 'trunk\n(score: 0.42)', 'a float32 score prints as typed');
ok(nodeTooltipText('nose', 1) === 'nose\n(score: 1.00)', 'trailing zeros kept, as SLEAP');
ok(nodeTooltipText('nose', NaN) === 'nose', 'no score: the name alone (a user node)');
ok(nodeTooltipText('nose', undefined) === 'nose', 'undefined score: the name alone');

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
