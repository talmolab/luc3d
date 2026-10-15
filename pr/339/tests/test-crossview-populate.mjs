/**
 * test-crossview-populate.mjs — verifies that running the CrossViewTracker (the app's
 * only tracker) populates ALL the data structures the GUI and SLP export read:
 * identities, per-frame identity map, InstanceGroups (with identityId + members
 * + points3d), and — after propagation — per-instance trackIdx + session.tracks
 * (the native-SLP path). Drives the REAL runCrossViewTracker() from pose/tracker.js
 * headlessly (UI stubbed via scripts/bench/hooks.mjs).
 *
 * Run:  node tests/test-crossview-populate.mjs
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
const { Camera, Instance, FrameGroup, Session } =
    await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);
const { runCrossViewTracker } =
    await import(pathToFileURL(path.join(POSE_DIR, 'tracker.js')).href);

// --- synthetic non-degenerate rig (no camera at [I|0]) ---
const NODES = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
function mk(name, rvec, tvec) {
    return new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
}
const CAMS = [mk('c0', [0, 0, 0], [0, 0, 40]), mk('c1', [0, 0.35, 0], [-12, 0, 43]), mk('c2', [0.35, 0, 0], [0, -12, 43])];
const OFF = [[0, 0, 0], [2, 1, 0], [-2, 1, 0], [0, -2, 1], [1.5, 0, -1.5], [-1.5, 0, 1.5]];
const nodes3d = c => OFF.map(o => [c[0] + o[0], c[1] + o[1], c[2] + o[2]]);

// Two animals across 4 frames, drifting but staying separated.
function buildSession() {
    const s = new Session(CAMS, { nodes: NODES }, [], 'crossview-pop');
    const paths = [
        [[-7, 0, 8], [7, 0, 8]],
        [[-6, 0, 8], [6, 0, 8]],
        [[-5, 1, 9], [5, -1, 7]],
        [[-4, 0, 8], [4, 0, 8]],
    ];
    paths.forEach((centroids, fi) => {
        const fg = new FrameGroup(fi);
        centroids.forEach((ctr, ai) => CAMS.forEach(cam => {
            const pix = nodes3d(ctr).map(p => cam.project(p));
            fg.addInstance(cam.name, new Instance(pix, ai, 'predicted', 1.0));
        }));
        s.addFrameGroup(fg);
    });
    return s;
}

// ===========================================================================
group('runCrossViewTracker populates every data structure');
{
    const s = buildSession();
    const frames = s.frameIndices;
    const res = runCrossViewTracker(s, s.cameras, frames, true);   // propagate = full Track All

    // 1. Identities.
    eq(s.identities.length, 2, 'two identities created');
    eq(res.numIdentities, 2, 'return value reports the identity count');

    // 2. Per-frame identity map (Color-by-Identity path).
    ok(s.frameIdentityMap.size > 0, 'frameIdentityMap populated');
    // Every entry maps to a real identity id.
    let mapOk = true;
    for (const [, id] of s.frameIdentityMap) if (id < 0 || !s.getIdentity(id)) mapOk = false;
    ok(mapOk, 'every frameIdentityMap entry points at a real identity');

    // 3. InstanceGroups (3D viewport + SIO.InstanceGroup export).
    let totalGroups = 0, groupsWith3d = 0, groupsWithIdentity = 0, groupMembers = 0;
    for (const [, groups] of s.instanceGroups) {
        for (const g of groups) {
            totalGroups++;
            if (g.identityId != null && g.identityId >= 0 && s.getIdentity(g.identityId)) groupsWithIdentity++;
            if (g.points3d && g.points3d.some(p => p != null)) groupsWith3d++;
            if (g.instances.size >= 2) groupMembers++;
        }
    }
    eq(totalGroups, frames.length * 2, 'one InstanceGroup per animal per frame');
    eq(groupsWithIdentity, totalGroups, 'every group carries a valid identityId');
    eq(groupsWith3d, totalGroups, 'every group carries triangulated points3d');
    eq(groupMembers, totalGroups, 'every group spans >= 2 camera views');

    // 4. Per-instance trackIdx + session.tracks (native SLP export path).
    eq(s.tracks.length, 2, 'session.tracks rebuilt, one per identity');
    let instTotal = 0, instTracked = 0;
    for (const [, fg] of s.frameGroups) {
        for (const [, insts] of fg.instances) {
            for (const inst of insts) {
                instTotal++;
                if (inst.trackIdx != null && inst.trackIdx >= 0 && inst.trackIdx < s.tracks.length) instTracked++;
            }
        }
    }
    eq(instTracked, instTotal, 'every instance has a valid trackIdx into session.tracks (SLP-ready)');

    // 5. The two structures agree: an instance's track resolves back to its identity.
    let consistent = true;
    for (const fi of frames) {
        const fg = s.getFrameGroup(fi);
        for (const [cam, insts] of fg.instances) {
            for (const inst of insts) {
                const id = s.getIdentityIdForTrack(cam, inst.trackIdx, fi);
                if (id == null || !s.getIdentity(id)) consistent = false;
            }
        }
    }
    ok(consistent, 'trackIdx → frameIdentityMap → identity round-trips for every instance');
}

// ===========================================================================
group('runCrossViewTracker — maxTargets caps the identity count');
{
    const s = buildSession();   // two animals
    const res = runCrossViewTracker(s, s.cameras, s.frameIndices, true, 1);   // cap at 1
    ok(s.identities.length <= 1, `cap 1 → at most one identity (got ${s.identities.length})`);
    eq(res.numIdentities, s.identities.length, 'return value matches session identity count');

    const s2 = buildSession();
    runCrossViewTracker(s2, s2.cameras, s2.frameIndices, true, 2);            // cap at 2
    eq(s2.identities.length, 2, 'cap 2 → the two animals get two identities');
}

// ===========================================================================
group('runCrossViewTracker — excluded cameras never enter the tracking');
{
    const s = buildSession();                       // rig has 3 cameras: c0, c1, c2
    const included = s.cameras.filter(c => c.name !== 'c2');   // exclude c2
    eq(included.length, 2, 'two of three cameras included');
    runCrossViewTracker(s, included, s.frameIndices, false);

    // No committed InstanceGroup references the excluded camera.
    let sawExcluded = false, sawIncluded = false;
    for (const [, groups] of s.instanceGroups) {
        for (const g of groups) {
            if (g.instances.has('c2')) sawExcluded = true;
            if (g.instances.has('c0') || g.instances.has('c1')) sawIncluded = true;
        }
    }
    ok(!sawExcluded, 'no group contains an instance from the excluded camera c2');
    ok(sawIncluded, 'groups still form across the two included cameras');
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
