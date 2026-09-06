/**
 * test-sweep-frame-coverage.mjs — which frames does the shared bulk sweep visit?
 *
 * `sweepLazyFrameWindows` (pose/triangulation.js) is the single windowing engine
 * behind every "do this to every frame" operation: Triangulate All, Triangulate
 * Range, Track All, Group by Identity, Export Labels. What it chooses to SKIP is
 * therefore the blast radius for the whole resident-only bug class (luc3d
 * #194/#195), and a skip is invisible at the call site — the operation returns a
 * plausible count and only shows up a save cycle later.
 *
 * REGRESSION under test: the consolidation that created this function gated the
 * callback on `session.frameGroups.get(fi)` alone. None of the three copies it
 * replaced did — `sweepTriangulateAllFrames` called
 * `ensureGroupsFromIdentities(session, fi)` for every index in the window. So a
 * frame with 3D grouping but no resident 2D was silently dropped, while
 * Triangulate All had already wiped `reprojections` project-wide: reprojections
 * gone everywhere, 3D refreshed only where the sweep ran. That is the #194
 * symptom reproduced one layer down, and the e2e harness cannot see it — its
 * fixture gives every frame 2D in every camera, so "has a FrameGroup" and "has
 * data" coincide there. These tests pull them apart deliberately.
 *
 * Run:  node tests/test-sweep-frame-coverage.mjs
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
    if (cond) { passed++; }
    else { failed++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function eq(actual, expected, msg) {
    ok(actual === expected, `${msg} (expected ${expected}, got ${actual})`);
}
function eqList(actual, expected, msg) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    ok(a === e, `${msg} (expected ${e}, got ${a})`);
}
function group(name) { console.log('\n• ' + name); }

// DOM + bench globals must exist before the pose modules are imported.
globalThis.__BENCH = { nodeWeights: {}, thresholds: {} };
globalThis.document = { getElementById: () => null };
globalThis.window = globalThis;

register(pathToFileURL(path.join(ROOT, 'scripts', 'bench', 'hooks.mjs')).href);
const { state } = await import(pathToFileURL(path.join(ROOT, 'ui', 'app-state.js')).href);
const { sweepLazyFrameWindows } =
    await import(pathToFileURL(path.join(ROOT, 'pose', 'triangulation.js')).href);

/**
 * A session whose 2D and 3D coverage are set independently.
 *
 * `twoD` — frames with a resident FrameGroup (already hydrated, so
 *   `batchLoadLazyFrames` leaves them alone and never reaches the real builder).
 * `threeD` — frames with an `instanceGroups` entry.
 *
 * `getFrameSync` returns null for everything else, which is exactly what the
 * real `SioLazyLoader` does for a frame with no 2D rows in the store — and what
 * makes `buildLazyFrameGroupSync` decline to create a FrameGroup.
 */
function makeSession(nFrames, twoD, threeD, { windowed = true } = {}) {
    const session = {
        frameGroups: new Map(),
        instanceGroups: new Map(),
        addFrameGroup(fg) { this.frameGroups.set(fg.frameIdx, fg); },
    };
    for (const f of twoD) session.frameGroups.set(f, { frameIdx: f, instances: new Map(), unlinkedInstances: new Map() });
    for (const f of threeD) session.instanceGroups.set(f, [{ id: 'g' + f }]);
    if (windowed) {
        session.lazyLoader = {
            isSync: true,
            nFrames,
            getFrameSync() { return null; },
            releaseWindow() {},
        };
    }
    return session;
}

async function sweep(session, opts) {
    state.session = session;
    state.currentFrame = 0;
    const visited = [];
    const fgSeen = new Map();
    await sweepLazyFrameWindows(session, function (fi, fg) {
        visited.push(fi);
        fgSeen.set(fi, fg);
    }, opts);
    return { visited, fgSeen };
}

// ---------------------------------------------------------------------------
group('windowed sweep — a frame with 3D grouping but no resident 2D');
{
    // The pure regression case: every frame is 3D-only. Pre-fix this visited
    // NOTHING while the caller had already wiped all derived state.
    const threeD = [7, 12, 2500, 4999];
    const session = makeSession(5000, [], threeD);
    const { visited, fgSeen } = await sweep(session);
    eqList(visited, threeD, 'every 3D-only frame is visited across window boundaries');
    ok(threeD.every(f => fgSeen.get(f) === undefined),
        'the callback receives an undefined FrameGroup for a 3D-only frame');
}

group('windowed sweep — mixed 2D and 3D coverage');
{
    // Frames carrying only 2D, only 3D, and both. The sweep must visit the UNION;
    // the pre-fix gate visited only the 2D column.
    const twoD = [1, 4, 3000];
    const threeD = [4, 9, 2001];
    const session = makeSession(5000, twoD, threeD);
    const { visited, fgSeen } = await sweep(session);
    eqList(visited, [1, 4, 9, 2001, 3000], 'visits the union of the 2D and 3D frames, in order');
    ok(fgSeen.get(4) !== undefined, 'a frame with 2D still gets its FrameGroup');
    ok(fgSeen.get(9) === undefined, 'a 3D-only frame is visited with no FrameGroup');
    ok(fgSeen.get(1) !== undefined, 'a 2D-only frame gets its FrameGroup');
}

group('windowed sweep — an empty frame is still skipped');
{
    // The gate is narrowed, not removed: a frame with neither 2D nor 3D has
    // nothing to do and must not cost a callback across 5,000 frames.
    const session = makeSession(5000, [10], [20]);
    const { visited } = await sweep(session);
    eqList(visited, [10, 20], 'frames with no data at all are not visited');
}

group('windowed sweep — an empty instanceGroups list does not count as data');
{
    const session = makeSession(5000, [], []);
    session.instanceGroups.set(42, []);          // present but empty
    const { visited } = await sweep(session);
    eqList(visited, [], 'a frame whose instanceGroups entry is an empty list is skipped');
}

group('windowed sweep — start/end still restrict the range');
{
    const session = makeSession(5000, [100, 900], [500, 4000]);
    const { visited } = await sweep(session, { start: 200, end: 1000 });
    eqList(visited, [500, 900], 'only frames inside [start, end] are visited');
}

// ---------------------------------------------------------------------------
group('non-windowed sweep — same union rule');
{
    // The eager branch (no windowing loader) built its index list from
    // `session.frameGroups.keys()` alone, so it had the identical blind spot.
    const session = makeSession(0, [3, 8], [8, 11], { windowed: false });
    const { visited, fgSeen } = await sweep(session);
    eqList(visited, [3, 8, 11], 'eager branch visits the union too, sorted');
    ok(fgSeen.get(11) === undefined, 'eager branch also passes undefined for a 3D-only frame');
}

group('non-windowed sweep — start/end still restrict the range');
{
    const session = makeSession(0, [3, 8], [8, 11, 40], { windowed: false });
    const { visited } = await sweep(session, { start: 8, end: 11 });
    eqList(visited, [8, 11], 'eager branch honours the range');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
    console.error('\nFailures:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
}
