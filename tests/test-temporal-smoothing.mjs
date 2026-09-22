/**
 * test-temporal-smoothing.mjs — pose/temporal-smoothing.js (luc3d #134).
 *
 * The feature is easy to ship in a state that LOOKS smooth and is quietly
 * wrong, so these tests pin the properties that distinguish "smoothed" from
 * "damaged" rather than just checking that numbers moved:
 *
 *   - gaps are never FILLED (a node that was NaN stays NaN),
 *   - a window never spans a segment break (no straight line through an
 *     occlusion),
 *   - the window shrinks SYMMETRICALLY at a segment edge instead of leaning on
 *     whichever side still has data — the one-sided-window bias that would show
 *     up as the skeleton lurching at every occlusion boundary,
 *   - holes INSIDE a segment renormalize instead of pulling toward the origin,
 *   - 2D is never touched, and the reprojection caches derived from 3D are,
 *   - `triangulationMethod` survives (a smoothed BA group must not re-solve as
 *     DLT — the `resolveTriangulationMethod` contract).
 *
 * Run:  node tests/test-temporal-smoothing.mjs
 */
import {
    normalizeWindow,
    sigmaForWindow,
    buildSegments,
    medianOf,
    smoothSignalInto,
    resolveSmoothingParams,
    collectTrajectories,
    smoothTrajectory,
    smoothSession,
} from '../pose/temporal-smoothing.js';
import { InstanceGroup, Instance, makePoints3d, setPoint3d } from '../pose/pose-data.js';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
    if (cond) { passed++; }
    else { failed++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function eq(actual, expected, msg) {
    ok(actual === expected, `${msg} (expected ${expected}, got ${actual})`);
}
function close(actual, expected, tol, msg) {
    ok(Math.abs(actual - expected) <= tol,
        `${msg} (expected ~${expected} +/-${tol}, got ${actual})`);
}
function eqList(actual, expected, msg) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    ok(a === e, `${msg} (expected ${e}, got ${a})`);
}
function group(name) { console.log('\n• ' + name); }

const nan = NaN;
const F = (arr) => Float64Array.from(arr);
/** Render a signal for messages, with NaN as 'x'. */
const show = (a) => Array.from(a, v => (Number.isNaN(v) ? 'x' : Math.round(v * 1000) / 1000));

function runStage(values, opts) {
    const src = F(values);
    const dst = new Float64Array(src.length);
    const present = Uint8Array.from(values, v => (Number.isNaN(v) ? 0 : 1));
    const segments = buildSegments(present, opts.maxGap == null ? 0 : opts.maxGap);
    const w = Math.max(opts.window, 1);
    smoothSignalInto(src, dst, segments, {
        kernel: opts.kernel, window: opts.window,
        minSegment: opts.minSegment == null ? 1 : opts.minSegment,
    }, new Float64Array(w), new Float64Array(w));
    return dst;
}

// ---------------------------------------------------------------------------
group('normalizeWindow — odd, or off');
{
    eq(normalizeWindow(0), 0, '0 is off');
    eq(normalizeWindow(1), 0, '1 would be a no-op; treated as off');
    eq(normalizeWindow(2), 0, '2 is below the minimum usable window');
    eq(normalizeWindow(3), 3, '3 passes through');
    eq(normalizeWindow(6), 7, 'even rounds UP to odd, keeping the window centered');
    eq(normalizeWindow(7), 7, 'odd passes through');
    eq(normalizeWindow(NaN), 0, 'non-numeric is off, not a crash');
    close(sigmaForWindow(7), 1, 1e-12, 'w=7 -> sigma 1 (window spans +/-3 sigma)');
    close(sigmaForWindow(13), 2, 1e-12, 'w=13 -> sigma 2');
}

// ---------------------------------------------------------------------------
group('buildSegments — cuts only at gaps longer than maxGap');
{
    const p = (s) => Uint8Array.from(s.split(''), c => (c === '1' ? 1 : 0));

    eqList(buildSegments(p('11111'), 0).map(s => [s.start, s.end]),
        [[0, 5]], 'no gaps -> one segment');

    eqList(buildSegments(p('110011'), 0).map(s => [s.start, s.end]),
        [[0, 2], [4, 6]], 'maxGap 0 cuts at any absence');

    eqList(buildSegments(p('110011'), 2).map(s => [s.start, s.end]),
        [[0, 6]], 'a 2-frame hole does not cut when maxGap is 2');

    eqList(buildSegments(p('11000011'), 2).map(s => [s.start, s.end]),
        [[0, 2], [6, 8]], 'a 4-frame gap cuts when maxGap is 2');

    eqList(buildSegments(p('1101011'), 1).map(s => [s.start, s.end]),
        [[0, 7]], 'several 1-frame holes stay inside one segment');

    eqList(buildSegments(p('00100'), 0).map(s => [s.start, s.end]),
        [[2, 3]], 'leading/trailing absence is outside the segment');

    eqList(buildSegments(p('00000'), 5).map(s => [s.start, s.end]),
        [], 'all absent -> no segments');
}

// ---------------------------------------------------------------------------
group('medianOf');
{
    eq(medianOf(F([3, 1, 2]), 3), 2, 'odd count returns an actual sample');
    eq(medianOf(F([5, 1, 9, 3, 7]), 5), 5, 'median of 5');
    eq(medianOf(F([4, 2]), 2), 3, 'even count averages the two middles');
    // A spike must not survive; a mean over the same window would keep 1/5 of it.
    eq(medianOf(F([1, 1, 100, 1, 1]), 5), 1, 'a single outlier is rejected outright');
}

// ---------------------------------------------------------------------------
group('median stage — removes a spike without moving its neighbours');
{
    const out = runStage([1, 1, 1, 50, 1, 1, 1], { kernel: 'median', window: 3 });
    eq(out[3], 1, 'the spike is replaced by its neighbours');
    eq(out[0], 1, 'edge frame is untouched (window shrinks to r=0 -> skipped)');
    eq(out[6], 1, 'far edge likewise');
    ok(out.every(v => v === 1), 'a constant signal plus one spike flattens to the constant');
}

// ---------------------------------------------------------------------------
group('gaussian stage — a ramp is preserved, noise is not');
{
    // A linear ramp is the case a symmetric weighted mean reproduces exactly.
    const ramp = [0, 1, 2, 3, 4, 5, 6];
    const out = runStage(ramp, { kernel: 'gaussian', window: 5 });
    for (let i = 0; i < ramp.length; i++) {
        close(out[i], ramp[i], 1e-9, `ramp preserved at ${i} (no lag/lead)`);
    }

    // Alternating noise on a flat signal must shrink.
    const noisy = [10, -10, 10, -10, 10, -10, 10, -10, 10];
    const sm = runStage(noisy, { kernel: 'gaussian', window: 5 });
    ok(Math.abs(sm[4]) < 3, `mid-signal amplitude collapses (got ${sm[4]})`);
}

// ---------------------------------------------------------------------------
group('gaps are never filled');
{
    const out = runStage([1, 2, nan, 4, 5], { kernel: 'gaussian', window: 3, maxGap: 1 });
    ok(Number.isNaN(out[2]), `a NaN input stays NaN on output (${show(out)})`);

    // Window 5, not 3: at window 3 the median has only 2 usable samples and
    // bails on the count alone, so the test would pass even without the NaN
    // guard. At 5 it has 4 and WOULD write a value if gaps were fillable.
    const med = runStage([1, 2, nan, 4, 5], { kernel: 'median', window: 5, maxGap: 1 });
    ok(Number.isNaN(med[2]), 'median stage likewise leaves the hole alone');
}

// ---------------------------------------------------------------------------
group('a hole inside a segment renormalizes — no pull toward the origin');
{
    // Constant 100 with one hole. Zero-padding (the classic bug) would drag the
    // neighbours toward 0; renormalizing over present samples keeps them at 100.
    const out = runStage([100, 100, nan, 100, 100], {
        kernel: 'gaussian', window: 5, maxGap: 1,
    });
    close(out[1], 100, 1e-9, `neighbour of a hole stays at 100 (${show(out)})`);
    close(out[3], 100, 1e-9, 'other neighbour too');
}

// ---------------------------------------------------------------------------
group('no window spans a segment break');
{
    // Animal at x=0 for 4 frames, absent for 6, then at x=1000. Smoothing across
    // the break would drag both plateaus toward each other — the straight-line-
    // through-an-occlusion artifact that anipose's interpolate-then-filter has.
    const values = [0, 0, 0, 0, nan, nan, nan, nan, nan, nan, 1000, 1000, 1000, 1000];
    const out = runStage(values, { kernel: 'gaussian', window: 7, maxGap: 2 });
    for (let i = 0; i < 4; i++) close(out[i], 0, 1e-9, `pre-gap frame ${i} unmoved`);
    for (let i = 10; i < 14; i++) close(out[i], 1000, 1e-9, `post-gap frame ${i} unmoved`);
    for (let i = 4; i < 10; i++) ok(Number.isNaN(out[i]), `gap frame ${i} still absent`);
}

// ---------------------------------------------------------------------------
group('symmetric shrink at a segment edge — no one-sided bias');
{
    // A ramp that starts at a segment edge. A one-sided window at t=0 would
    // average frames 0..3 and report ~1.5 instead of 0 — the ~15 mm lurch.
    const out = runStage([0, 1, 2, 3, 4, 5, 6], { kernel: 'gaussian', window: 7 });
    eq(out[0], 0, 'first frame of a segment is not pulled toward the future');
    eq(out[6], 6, 'last frame is not pulled toward the past');
    close(out[1], 1, 1e-9, 'frame 1 uses r=1, still centered');
    close(out[3], 3, 1e-9, 'middle frame uses the full radius');

    // And the bias really would appear without the shrink: confirm the
    // asymmetric average is a different number, so the assertion above has teeth.
    const oneSided = (0 + 1 + 2 + 3) / 4;
    ok(Math.abs(oneSided - 0) > 1, 'a one-sided window WOULD have biased frame 0');
}

// ---------------------------------------------------------------------------
group('minSegment — too-short segments are left alone');
{
    const values = [5, 99, 5, nan, nan, nan, 1, 1, 1, 1, 1, 1, 1];
    const out = runStage(values, {
        kernel: 'median', window: 3, maxGap: 1, minSegment: 5,
    });
    eq(out[1], 99, 'the 3-frame segment is not smoothed from too few samples');
}

// ---------------------------------------------------------------------------
group('resolveSmoothingParams');
{
    const off = resolveSmoothingParams({});
    eq(off.enabled, false, 'no windows -> disabled');
    const on = resolveSmoothingParams({ smoothMedianWindow: 4, smoothGaussianWindow: 0 });
    eq(on.enabled, true, 'a median window alone enables the pass');
    eq(on.medianWindow, 5, 'even window coerced up');
    eq(on.gaussianWindow, 0, 'the other stage stays off');
    eq(resolveSmoothingParams({ smoothMaxGap: -3 }).maxGap, 0, 'negative maxGap clamps to 0');
    eq(resolveSmoothingParams({ smoothMinSegment: 0 }).minSegment, 1, 'minSegment floors at 1');
}

// ---------------------------------------------------------------------------
// Session-level fixtures.
// ---------------------------------------------------------------------------
const NODES = 2;

function makeGroup(identityId, coords) {
    const g = new InstanceGroup(1, identityId);
    const pts = makePoints3d(NODES);
    for (let k = 0; k < NODES; k++) setPoint3d(pts, k, coords[k]);
    g.points3d = pts;
    return g;
}

/** A session-shaped object: only `instanceGroups` is read by the smoother. */
function makeSession(framesSpec) {
    const instanceGroups = new Map();
    for (const [frameIdx, groups] of framesSpec) instanceGroups.set(frameIdx, groups);
    return { instanceGroups };
}

group('collectTrajectories — buckets by identity');
{
    const s = makeSession([
        [0, [makeGroup(1, [[0, 0, 0], [1, 1, 1]]), makeGroup(2, [[9, 9, 9], [8, 8, 8]])]],
        [1, [makeGroup(1, [[1, 0, 0], [2, 1, 1]]), makeGroup(2, [[9, 9, 9], [8, 8, 8]])]],
    ]);
    const { tracks } = collectTrajectories(s);
    eq(tracks.size, 2, 'two identities -> two trajectories');
    eq(tracks.get(1).size, 2, 'identity 1 spans both frames');
}

group('collectTrajectories — unidentified groups');
{
    // One per frame is the ordinary single-animal case: safe to smooth.
    const single = makeSession([
        [0, [makeGroup(-1, [[0, 0, 0], [0, 0, 0]])]],
        [1, [makeGroup(-1, [[1, 0, 0], [0, 0, 0]])]],
    ]);
    eq(collectTrajectories(single).tracks.size, 1, 'a lone unidentified group forms a track');

    // Two per frame cannot be told apart across frames — smoothing them as one
    // trajectory would interleave two animals, so the bucket is dropped.
    const ambiguous = makeSession([
        [0, [makeGroup(-1, [[0, 0, 0], [0, 0, 0]]), makeGroup(-1, [[9, 9, 9], [9, 9, 9]])]],
        [1, [makeGroup(-1, [[1, 0, 0], [0, 0, 0]])]],
    ]);
    const res = collectTrajectories(ambiguous);
    eq(res.tracks.size, 0, 'ambiguous unidentified groups are skipped, not merged');
    ok(res.skipped > 0, 'and the skip is reported rather than silent');
}

group('smoothSession — end to end on a spiky trajectory');
{
    const frames = [];
    for (let f = 0; f < 11; f++) {
        // Node 0 rides a clean ramp; node 1 is constant with one spike at f=5.
        const spike = (f === 5) ? 100 : 0;
        frames.push([f, [makeGroup(7, [[f, 0, 0], [spike, 0, 0]])]]);
    }
    const session = makeSession(frames);
    const before = session.instanceGroups.get(3)[0].points3d[0];

    const stats = smoothSession(session, { smoothMedianWindow: 3 });
    eq(stats.ran, true, 'the pass ran');
    eq(stats.tracks, 1, 'one track touched');

    eq(session.instanceGroups.get(5)[0].points3d[3], 0, 'node 1 spike removed');
    eq(session.instanceGroups.get(3)[0].points3d[0], before, 'node 0 ramp unchanged by a median');
    eq(session.instanceGroups.get(5)[0].smoothed, true, 'group flagged as smoothed');
}

group('smoothSession — off by default is a no-op');
{
    const session = makeSession([[0, [makeGroup(1, [[0, 0, 0], [5, 5, 5]])]]]);
    const stats = smoothSession(session, {});
    eq(stats.ran, false, 'disabled config does not run');
    eq(stats.frames, 0, 'nothing written');
    eq(session.instanceGroups.get(0)[0].smoothed, undefined, 'no flag set');
}

group('smoothSession — writeFrames limits WRITES but not READS');
{
    const frames = [];
    for (let f = 0; f < 9; f++) {
        frames.push([f, [makeGroup(7, [[(f === 4 ? 100 : 0), 0, 0], [0, 0, 0]])]]);
    }
    const session = makeSession(frames);
    const stats = smoothSession(session, { smoothMedianWindow: 3 }, {
        writeFrames: new Set([4]),
    });
    eq(stats.frames, 1, 'exactly one frame written');
    eq(session.instanceGroups.get(4)[0].points3d[0], 0,
        'the current frame IS smoothed, using neighbours it did not write');
    eq(session.instanceGroups.get(3)[0].smoothed, undefined, 'neighbour left unflagged');
}

group('2D is never touched; derived reprojections are invalidated');
{
    const g = makeGroup(1, [[0, 0, 0], [0, 0, 0]]);
    const inst = new Instance([[10, 20], [30, 40]], 0, 'user', 1);
    g.addInstance('camA', inst);
    g.reprojections = { camA: [[1, 1], [2, 2]] };
    g.reprojectedInstances.set('camA', new Instance([[1, 1], [2, 2]], 0, 'reprojected', 1));
    g.triangulationMethod = 'ba';

    const frames = [[0, [g]]];
    for (let f = 1; f < 7; f++) {
        frames.push([f, [makeGroup(1, [[(f === 3 ? 50 : 0), 0, 0], [0, 0, 0]])]]);
    }
    const session = makeSession(frames);
    smoothSession(session, { smoothMedianWindow: 3 });

    eqList(inst.getPoint(0), [10, 20], 'user 2D point untouched');
    eqList(inst.getPoint(1), [30, 40], 'second user 2D point untouched');
    eq(inst.type, 'user', 'instance type unchanged');
    eq(g.reprojections, null, 'stale raw reprojections cleared');
    eq(g.reprojectedInstances.size, 0, 'stale reprojected Instances cleared');
    eq(g.triangulationMethod, 'ba',
        'triangulationMethod survives — a smoothed BA group must not re-solve as DLT');
}

group('an occlusion split survives the session path');
{
    // Present 0..3 at x=0, absent 4..9 (no groups at all), present 10..13 at
    // x=1000. The absence is expressed as MISSING FRAMES, not NaN nodes — the
    // whole-skeleton case — and must still cut the trajectory.
    const frames = [];
    for (let f = 0; f < 4; f++) frames.push([f, [makeGroup(3, [[0, 0, 0], [0, 0, 0]])]]);
    for (let f = 10; f < 14; f++) frames.push([f, [makeGroup(3, [[1000, 0, 0], [0, 0, 0]])]]);
    const session = makeSession(frames);

    smoothSession(session, { smoothGaussianWindow: 7, smoothMaxGap: 2, smoothMinSegment: 1 });

    close(session.instanceGroups.get(3)[0].points3d[0], 0, 1e-9,
        'last frame before the absence is not dragged toward the far plateau');
    close(session.instanceGroups.get(10)[0].points3d[0], 1000, 1e-9,
        'first frame after it is not dragged back');
}

group('partially-missing nodes within a present skeleton');
{
    // Node 1 is missing on frame 3 only; node 0 is present throughout. The
    // frame is skeleton-level PRESENT, so node 0 smooths normally while node 1's
    // hole is preserved.
    const frames = [];
    for (let f = 0; f < 7; f++) {
        const g = makeGroup(2, [[(f === 3 ? 60 : 0), 0, 0], [0, 0, 0]]);
        if (f === 3) setPoint3d(g.points3d, 1, null);
        frames.push([f, [g]]);
    }
    const session = makeSession(frames);
    smoothSession(session, { smoothMedianWindow: 3, smoothMaxGap: 2 });

    const g3 = session.instanceGroups.get(3)[0];
    eq(g3.points3d[0], 0, 'node 0 spike on the same frame is smoothed away');
    ok(Number.isNaN(g3.points3d[3]), 'node 1 stays missing — not resurrected by the filter');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
    console.error('\nFailures:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
