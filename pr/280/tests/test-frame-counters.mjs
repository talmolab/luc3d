/**
 * test-frame-counters.mjs — the status bar's whole-project counters on a LAZY
 * project (`ui/frame-counters.js`).
 *
 * REGRESSION under test: `updateFrameCounters` walked `session.frameGroups`,
 * which on a lazy project is the RESIDENT window. After Track All + Triangulate
 * All on a 108,000-frame project the status bar read "Labeled Frames: 5789" and
 * "Triangulated: 5789" — the resident count — while every frame had 3D.
 *
 * The fix counts resident frames live and every other frame from a per-frame
 * baseline built from the columnar store plus `instanceGroups`, WITHOUT
 * hydrating. That baseline is only right if it agrees with what hydration would
 * actually put on screen, so the oracle here is the app's own hydration: the
 * real `batchLoadLazyFrames` / `finalizeLazyFrameGroup` (pose/triangulation.js)
 * over a real `SioLazyLoader` whose store is built by hand, after which every
 * frame is resident and the plain resident count IS the whole-project count.
 * The fixture deliberately makes "grouped" and "type" disagree (a promoted
 * member on a predicted row, a member past the frame's last row, a member with
 * no `_rawInstIndex`, frames with no rows), since those are the cases where a
 * baseline that guessed instead of mirroring would be off.
 *
 * Run:  node tests/test-frame-counters.mjs
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
    if (cond) { passed++; }
    else { failed++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function eq(actual, expected, msg) {
    ok(actual === expected, `${msg} (expected ${expected}, got ${actual})`);
}
function eqCounts(actual, expected, msg) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    ok(a === e, `${msg} (expected ${e}, got ${a})`);
}
function group(name) { console.log('\n• ' + name); }

// The UI modules pose/triangulation.js imports are stubbed (scripts/bench/hooks.mjs);
// pose-data.js, triangulation.js, sio-lazy-loader.js and frame-counters.js load real.
globalThis.__BENCH = { nodeWeights: {}, thresholds: {} };
globalThis.document = { getElementById: () => null };
globalThis.window = globalThis;
class FakePredictedInstance {
    constructor(points) { this.points = points; this.track = null; this.score = 0.9; }
}
globalThis.SleapIO = { PredictedInstance: FakePredictedInstance };

register(pathToFileURL(path.join(ROOT, 'scripts', 'bench', 'hooks.mjs')).href);
const { state } = await imp('ui/app-state.js');
const { batchLoadLazyFrames } = await imp('pose/triangulation.js');
const { SioLazyLoader } = await imp('loading/sio-lazy-loader.js');
const { Session, Skeleton, Camera, Instance, InstanceGroup } = await imp('pose/pose-data.js');
const FC = await imp('ui/frame-counters.js');

const CAMS = ['c0', 'c1', 'c2'];
const NODES = 2;
const N_FRAMES = 60;

/**
 * Rows per (camera, frame): 0..3, with a mix of user (0) and predicted (1)
 * rows. A few frames have no row at all for a camera, and one is present in the
 * row map with an EMPTY range, which `forEachInstanceRow` never visits.
 */
function rowsFor(cam, f) {
    const ci = CAMS.indexOf(cam);
    if ((f + ci) % 11 === 0) return null;          // absent from the row map
    if ((f + ci) % 13 === 0) return [];            // present, zero rows
    const n = 1 + ((f * 7 + ci * 3) % 3);
    const types = [];
    for (let k = 0; k < n; k++) types.push(((f + k + ci) % 4 === 0) ? 0 : 1);
    return types;
}

/** A real SioLazyLoader over a hand-built columnar store, one store per camera. */
function makeLoader() {
    const loader = new SioLazyLoader();
    loader.nFrames = N_FRAMES;
    for (const cam of CAMS) {
        const start = [], end = [], type = [], track = [];
        const rowMap = new Map();
        for (let f = 0; f < N_FRAMES; f++) {
            const t = rowsFor(cam, f);
            if (t === null) continue;
            rowMap.set(f, start.length);
            start.push(type.length);
            for (const v of t) { type.push(v); track.push(-1); }
            end.push(type.length);
        }
        const store = {
            framesData: { instance_id_start: Float64Array.from(start), instance_id_end: Float64Array.from(end) },
            instancesData: { instance_type: Float64Array.from(type), track: Float64Array.from(track) },
        };
        loader.labelsByCam.set(cam, {
            _lazyDataStore: store,
            tracks: [],
            // What `labels.frameAt(row)` hands `_extractCamFrame`: typed instances,
            // a PredictedInstance for instance_type 1.
            frameAt(row) {
                const out = [];
                for (let j = start[row]; j < end[row]; j++) {
                    const points = [];
                    for (let k = 0; k < NODES; k++) points.push({ xy: [10 + j, 20 + k], visible: true });
                    out.push(type[j] === 1 ? new FakePredictedInstance(points) : { points, track: null });
                }
                return { instances: out };
            },
        });
        loader.frameRowByCam.set(cam, rowMap);
        loader.numNodesByCam.set(cam, NODES);
    }
    return loader;
}

/**
 * The project-wide grouping a lazy reopen restores: placeholder members keyed by
 * `_rawInstIndex`, typed from the file's metadata rather than from the row.
 */
function makeSession() {
    const cameras = CAMS.map(n => new Camera(n, [[500, 0, 256], [0, 500, 256], [0, 0, 1]],
        [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [512, 512]));
    const session = new Session(cameras, new Skeleton('s', ['a', 'b'], [[0, 1]]), ['t0'], 'S');
    session.lazyLoader = makeLoader();
    let gid = 1;
    const placeholder = (type, raw) => {
        const inst = new Instance(new Array(NODES).fill(null), null, type, 0);
        if (raw != null) inst._rawInstIndex = raw;
        inst._lazy2d = true;
        return inst;
    };
    for (let f = 0; f < N_FRAMES; f++) {
        if (f % 5 === 4) continue;                    // ungrouped frame: every row unlinked
        const groups = [];
        const g = new InstanceGroup(gid++, 0);
        for (const cam of CAMS) {
            const t = rowsFor(cam, f);
            // Grouped at offset 0 — as the row's own type, except on every 3rd
            // frame where the member was PROMOTED to user over a predicted row.
            const rowType = (t && t.length) ? (t[0] === 1 ? 'predicted' : 'user') : 'predicted';
            g.addInstance(cam, placeholder(f % 3 === 0 ? 'user' : rowType, 0));
        }
        if (f % 2 === 0) g.points3d = new Float64Array(NODES * 3).fill(f);
        groups.push(g);
        if (f % 7 === 0) {
            // A member past the frame's last row (hydration drops it) and one
            // with no `_rawInstIndex` at all (never placed) — both 'user', so a
            // baseline that counted members instead of rows would over-count.
            const g2 = new InstanceGroup(gid++, 1);
            g2.addInstance('c0', placeholder('user', 9));
            g2.addInstance('c1', placeholder('user', null));
            groups.push(g2);
        }
        session.instanceGroups.set(f, groups);
    }
    // A 3D-only frame past nFrames: no 2D anywhere, but it IS triangulated.
    const g3 = new InstanceGroup(gid++, 0);
    g3.points3d = new Float64Array(NODES * 3).fill(1);
    session.instanceGroups.set(N_FRAMES + 5, [g3]);
    return session;
}

/** Make `frames` resident through the app's real hydration path. */
async function hydrate(session, from, count) {
    state.session = session;
    state.currentFrame = from;
    await batchLoadLazyFrames(from, count);
}

/**
 * Ground truth. Labeled Frames / Instances: hydrate EVERYTHING, then the plain
 * resident count is the whole count. Triangulated: frames with 3D, counted
 * straight off `instanceGroups` — hydration cannot see the 3D-only frame (it has
 * no 2D, so it never becomes a FrameGroup), and it is still a frame with 3D.
 */
async function oracle(build, cam, mutate) {
    const s = build();
    if (mutate) await mutate(s);
    await hydrate(s, 0, N_FRAMES);
    eq(s.frameGroups.size, [...s.lazyLoader.frameRowByCam.values()]
        .reduce((u, m) => { for (const k of m.keys()) u.add(k); return u; }, new Set()).size,
    'oracle: every frame with a row is resident');
    const c = FC.countFrameCounters(s, cam, null);
    let tri = 0;
    for (const [, gs] of s.instanceGroups) if (gs.some(g => g.points3d)) tri++;
    return { labeled: c.labeled, instances: c.instances, triangulated: tri };
}

// ---------------------------------------------------------------------------
group('forEachInstanceRow(visit, {camera, start, end}) narrows the walk');
{
    const loader = makeLoader();
    const seen = new Set();
    let rows = 0;
    loader.forEachInstanceRow((cam) => { seen.add(cam); rows++; }, { camera: 'c1' });
    eqCounts([...seen], ['c1'], 'only c1 visited');
    let want = 0;
    for (let f = 0; f < N_FRAMES; f++) { const t = rowsFor('c1', f); if (t) want += t.length; }
    eq(rows, want, 'every c1 row visited');
    let all = 0;
    loader.forEachInstanceRow(() => { all++; });
    ok(all > rows, 'without options every camera is still visited');

    // A frame range: ascending frames, only those in [start, end), and each
    // frame's rows contiguous with offsets 0..n-1 (what the counters rely on).
    const frames = [], offsets = new Map();
    loader.forEachInstanceRow((cam, f, trk, info) => {
        if (frames[frames.length - 1] !== f) frames.push(f);
        if (!offsets.has(f)) offsets.set(f, []);
        offsets.get(f).push(info.offsetInFrame);
    }, { camera: 'c0', start: 10, end: 25 });
    ok(frames.every(f => f >= 10 && f < 25), 'only frames in [10, 25)');
    ok(frames.every((f, i) => i === 0 || f > frames[i - 1]), 'ascending, each frame once');
    const wantFrames = [];
    for (let f = 10; f < 25; f++) { const t = rowsFor('c0', f); if (t && t.length) wantFrames.push(f); }
    eqCounts(frames, wantFrames, 'every c0 frame with rows in the range');
    ok([...offsets.values()].every(o => o.every((v, i) => v === i)), 'offsets 0..n-1 per frame');
}

// ---------------------------------------------------------------------------
group('lazy project, small resident window: whole-project counts match hydration');
for (const cam of CAMS) {
    const truth = await oracle(makeSession, cam);
    const s = makeSession();
    await hydrate(s, 20, 6);                         // a resident window, frames 20..25
    ok(s.frameGroups.size > 0 && s.frameGroups.size < N_FRAMES / 4,
        `${cam}: precondition — only a window is resident (${s.frameGroups.size})`);
    const base = FC.computeFrameCounterBaseline(s, cam);
    const got = FC.countFrameCounters(s, cam, base);
    eqCounts(got, truth, `${cam}: counts equal the fully-hydrated count`);

    // Negative control: the old resident-only count is the bug, and must differ,
    // or this fixture could not tell the two apart.
    const residentOnly = FC.countFrameCounters(s, cam, null);
    ok(residentOnly.labeled < truth.labeled && residentOnly.triangulated < truth.triangulated,
        `${cam}: the resident-only count is smaller (${JSON.stringify(residentOnly)} vs ${JSON.stringify(truth)})`);
}

// ---------------------------------------------------------------------------
group('a build spread over many small steps equals a one-shot build');
{
    const s = makeSession();
    await hydrate(s, 5, 4);
    const whole = FC.computeFrameCounterBaseline(s, 'c1');
    const builder = FC.createFrameCounterBaselineBuilder(s, 'c1');
    let steps = 0;
    while (!builder.step(7)) steps++;               // 7 frames / entries per step
    ok(steps > 10, `the build really was sliced (${steps} steps)`);
    const sliced = builder.result;
    eq(sliced.tri.total, whole.tri.total, 'same Triangulated total');
    ok(sliced.tri.byFrame.every((v, i) => v === (whole.tri.byFrame[i] || 0)), 'same per-frame 3D');
    const a = sliced.cams.get('c1'), b = whole.cams.get('c1');
    eq(a.labeledTotal, b.labeledTotal, 'same Labeled total');
    eq(a.usersTotal, b.usersTotal, 'same Instances total');
    ok(a.byFrame.every((v, i) => v === b.byFrame[i]), 'same per-frame camera values');
    eqCounts(FC.countFrameCounters(s, 'c1', sliced), FC.countFrameCounters(s, 'c1', whole), 'same counts');
    const camOnly = FC.computeLazyCameraBaseline(s, 'c1');
    ok(camOnly && camOnly.byFrame.every((v, i) => v === b.byFrame[i]), 'computeLazyCameraBaseline = the camera half');
}

// ---------------------------------------------------------------------------
group('nothing resident at all');
{
    const truth = await oracle(makeSession, 'c0');
    const s = makeSession();
    eq(s.frameGroups.size, 0, 'precondition: no frame resident');
    eqCounts(FC.countFrameCounters(s, 'c0', FC.computeFrameCounterBaseline(s, 'c0')), truth,
        'counts come entirely from the baseline');
}

// ---------------------------------------------------------------------------
group('the resident set can change without rebuilding the baseline');
{
    const truth = await oracle(makeSession, 'c2');
    const s = makeSession();
    await hydrate(s, 0, 10);
    const base = FC.computeFrameCounterBaseline(s, 'c2');
    eqCounts(FC.countFrameCounters(s, 'c2', base), truth, 'window 0..9');
    // Scrub: hydrate another window, then evict the first (what
    // `evictLazyFrames` / the sweeps' release do) — same baseline throughout.
    await hydrate(s, 40, 15);
    eqCounts(FC.countFrameCounters(s, 'c2', base), truth, 'windows 0..9 + 40..54');
    for (let f = 0; f < 10; f++) s.frameGroups.delete(f);
    eqCounts(FC.countFrameCounters(s, 'c2', base), truth, 'after evicting 0..9');
}

// ---------------------------------------------------------------------------
group('an edit to a RESIDENT frame shows without a rebuild');
{
    const s = makeSession();
    await hydrate(s, 30, 3);
    const base = FC.computeFrameCounterBaseline(s, 'c0');
    const before = FC.countFrameCounters(s, 'c0', base);
    // A brand-new user instance the store has never seen.
    s.addUnlinkedInstance(31, 'c0', new Instance([[1, 2], [3, 4]], null, 'user', 1));
    const after = FC.countFrameCounters(s, 'c0', base);
    eq(after.instances, before.instances + 1, 'Instances +1 with the same baseline');
    // Triangulating the current frame is equally immediate.
    const groups = s.instanceGroups.get(31);
    const had3d = FC.groupsHaveTriangulation(groups);
    for (const g of groups) g.points3d = had3d ? null : new Float64Array(NODES * 3);
    const tri = FC.countFrameCounters(s, 'c0', base).triangulated;
    eq(tri, before.triangulated + (had3d ? -1 : 1), 'Triangulated follows a resident frame live');
}

// ---------------------------------------------------------------------------
group('a bulk change to NON-resident frames needs the rebuild');
{
    // What Track All / Triangulate All do: rewrite frames that are not resident.
    const mutate = async (s) => {
        for (const [f, groups] of s.instanceGroups) {
            if (f >= N_FRAMES) continue;
            for (const g of groups) g.points3d = new Float64Array(NODES * 3).fill(2);
        }
        s.instanceGroups.delete(12);                 // and one frame ungrouped outright
    };
    const truth = await oracle(makeSession, 'c1', mutate);
    const s = makeSession();
    await hydrate(s, 50, 3);
    const stale = FC.computeFrameCounterBaseline(s, 'c1');
    await mutate(s);
    const withStale = FC.countFrameCounters(s, 'c1', stale);
    ok(JSON.stringify(withStale) !== JSON.stringify(truth),
        'a baseline from before the bulk change is stale (which is why updateFrameCounters rebuilds it)');
    eqCounts(FC.countFrameCounters(s, 'c1', FC.computeFrameCounterBaseline(s, 'c1')), truth,
        'a rebuilt baseline is exact again');
}

// ---------------------------------------------------------------------------
group('nonResidentCameraCounts: an edit moves only resident frames, a bulk change does not');
{
    // `updateFrameCounters` keeps the other views' camera halves across a
    // rebuild unless THIS view's non-resident part moved. That is only sound if
    // an ordinary edit (on a resident frame) leaves it alone and a bulk change
    // to non-resident frames does not.
    const s = makeSession();
    await hydrate(s, 30, 3);
    const before = FC.computeLazyCameraBaseline(s, 'c0');
    s.addUnlinkedInstance(31, 'c0', new Instance([[1, 2], [3, 4]], null, 'user', 1));
    const afterEdit = FC.computeLazyCameraBaseline(s, 'c0');
    eqCounts(FC.nonResidentCameraCounts(s, afterEdit), FC.nonResidentCameraCounts(s, before),
        'a resident edit leaves the non-resident part unchanged');
    // Frame 17 is not resident, and c0's rows there are all predictions, held
    // by a group: ungrouping it unlabels the frame.
    ok(!s.frameGroups.has(17) && rowsFor('c0', 17).every(t => t === 1), 'precondition: frame 17');
    s.instanceGroups.delete(17);
    const afterBulk = FC.computeLazyCameraBaseline(s, 'c0');
    eq(FC.nonResidentCameraCounts(s, afterBulk).labeled, FC.nonResidentCameraCounts(s, before).labeled - 1,
        'ungrouping a non-resident frame moves it');
}

// ---------------------------------------------------------------------------
group('a baseline built for another camera is not applied');
{
    const s = makeSession();
    await hydrate(s, 0, 4);
    const baseC0 = FC.computeFrameCounterBaseline(s, 'c0');
    const residentOnly = FC.countFrameCounters(s, 'c1', null);
    const got = FC.countFrameCounters(s, 'c1', baseC0);
    eq(got.labeled, residentOnly.labeled, "c0's per-frame values never reach c1's Labeled Frames");
    eq(got.instances, residentOnly.instances, "…nor its Instances");
}

// ---------------------------------------------------------------------------
group('a loader that cannot enumerate rows falls back to the resident count');
{
    const s = makeSession();
    await hydrate(s, 0, 8);
    const base = FC.computeFrameCounterBaseline(s, 'c0');
    s.lazyLoader = { nFrames: N_FRAMES };            // e.g. the worker-backed .h5 loader
    eq(FC.computeLazyCameraBaseline(s, 'c0'), null, 'no camera baseline without forEachInstanceRow');
    const nb = FC.computeFrameCounterBaseline(s, 'c0');
    const c = FC.countFrameCounters(s, 'c0', nb);
    eq(c.labeled, FC.countFrameCounters(s, 'c0', null).labeled, 'Labeled Frames = resident count');
    eq(c.triangulated, FC.countFrameCounters(s, 'c0', base).triangulated,
        'Triangulated still covers the whole project (it never needed the store)');
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
    console.log('\nFailures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
}
