/**
 * test-tracker-collision-guard.mjs — Node test for `commitTrackedFrame`'s
 * raw-trackIdx collision guard (pose/tracker.js).
 *
 * Regression for the "2D viewer shows a different color than the 3D viewport/
 * info panel on the first frame or two, then self-corrects" report: per-camera
 * prediction files number tracks independently PER CAMERA, and a camera's own
 * raw tracker is commonly less differentiated right at the start of a video.
 * If it briefly assigns the SAME trackIdx to two DIFFERENT physical animals in
 * the same camera on the same frame, `commitTrackedFrame` used to call
 * `session.setFrameIdentity(frameIdx, camName, thatSharedTrackIdx, identityId)`
 * for BOTH — the second call silently overwrote the first's `frameIdentityMap`
 * entry. `ui/overlays.js`'s 2D color path queries that exact per-camera-
 * per-frame key and would confidently show the WRONG identity's color for
 * whichever animal got overwritten, while `group.identityId` (read by the info
 * panel and the 3D viewport's any-camera-fallback color lookup) stayed correct
 * the whole time, since it's set once per group — never through this shared
 * map key.
 *
 * Drives the REAL `commitTrackedFrame` directly (not a mock) with two fake
 * targets that intentionally collide on one shared camera, headlessly via the
 * same UI-stubbing loader test-tracker-luc3d.mjs / test-cross-view-tracker.mjs
 * use (scripts/bench/hooks.mjs) — CrossViewTracker's own Hungarian/birth
 * geometry is irrelevant here; this exercises the identity-writing/collision
 * logic in isolation.
 *
 * Run:  node tests/test-tracker-collision-guard.mjs
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const POSE_DIR = path.join(ROOT, 'pose');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
    if (cond) { passed++; } else { failed++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function eq(actual, expected, msg) {
    ok(actual === expected, `${msg} (expected ${expected}, got ${actual})`);
}
function group(name) { console.log('\n• ' + name); }

// DOM + bench globals must exist before tracker.js is imported (its
// module-level button-wiring IIFE touches document).
globalThis.__BENCH = { nodeWeights: {}, thresholds: {} };
globalThis.document = { getElementById: () => null };
globalThis.window = globalThis;

register(pathToFileURL(path.join(ROOT, 'scripts', 'bench', 'hooks.mjs')).href);
const { Camera, Skeleton, Session, FrameGroup } =
    await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);
const { commitTrackedFrame } =
    await import(pathToFileURL(path.join(POSE_DIR, 'tracker.js')).href);

function makeCam(name) {
    return new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
        [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
}
function buildSession() {
    const sk = new Skeleton('sk', ['a'], []);
    const cams = [makeCam('cam0'), makeCam('cam1'), makeCam('cam2')];
    const session = new Session(cams, sk, [], 'S');
    session.addFrameGroup(new FrameGroup(0));
    return session;
}
// Minimal fake Detection: only .frameIdx and .instance.trackIdx are read by
// commitTrackedFrame.
function fakeDet(frameIdx, trackIdx) {
    return { frameIdx: frameIdx, instance: { trackIdx: trackIdx } };
}

group('commitTrackedFrame — raw-trackIdx collision guard');
{
    const session = buildSession();
    // Two DIFFERENT targets both have a member on cam0 with the SAME raw
    // trackIdx (5) this frame — the exact ambiguity a per-camera tracker can
    // produce right at the start of a video. Each also has one OTHER,
    // non-colliding camera so both still pass the >=2-camera bundle gate.
    const target1 = {
        trackId: 'T1',
        detsByCam: new Map([
            ['cam0', fakeDet(0, 5)],
            ['cam1', fakeDet(0, 10)],
        ]),
    };
    const target2 = {
        trackId: 'T2',
        detsByCam: new Map([
            ['cam0', fakeDet(0, 5)],   // collides with target1's cam0 entry
            ['cam2', fakeDet(0, 20)],
        ]),
    };
    const trk = { targets: [target1, target2] };
    const trackToIdentity = new Map();

    commitTrackedFrame(session, trk, 0, trackToIdentity);

    const idT1 = trackToIdentity.get('T1');
    const idT2 = trackToIdentity.get('T2');
    ok(idT1 != null && idT2 != null && idT1 !== idT2, 'two distinct identities were created for the two targets');

    eq(session.getFrameIdentityValue(0, 'cam0', 5), -1,
        'the COLLIDING key (frame 0, cam0, trackIdx 5) is marked explicit "no identity" (-1), not silently won by whichever target processed last');
    eq(session.getFrameIdentityValue(0, 'cam1', 10), idT1, 'target1\'s NON-colliding cam1 entry is untouched and correct');
    eq(session.getFrameIdentityValue(0, 'cam2', 20), idT2, 'target2\'s NON-colliding cam2 entry is untouched and correct');

    const groups = session.instanceGroups.get(0) || [];
    eq(groups.length, 2, 'both groups were still created');
    const g1 = groups.find(g => g.identityId === idT1);
    const g2 = groups.find(g => g.identityId === idT2);
    ok(!!g1 && !!g2, 'each group carries its OWN correct identityId — uncorrupted by the frameIdentityMap collision ' +
        '(this is exactly what the info panel and the 3D viewport\'s any-camera-fallback color lookup read)');
}

group('commitTrackedFrame — no collision, unchanged behavior');
{
    const session = buildSession();
    // Two targets with NO shared camera+trackIdx pair — must behave exactly
    // as before (every entry written normally, no false positives).
    const target1 = {
        trackId: 'T1',
        detsByCam: new Map([
            ['cam0', fakeDet(0, 1)],
            ['cam1', fakeDet(0, 2)],
        ]),
    };
    const target2 = {
        trackId: 'T2',
        detsByCam: new Map([
            ['cam0', fakeDet(0, 3)],   // different trackIdx on the SAME camera — no collision
            ['cam2', fakeDet(0, 4)],
        ]),
    };
    const trk = { targets: [target1, target2] };
    const trackToIdentity = new Map();

    commitTrackedFrame(session, trk, 0, trackToIdentity);

    const idT1 = trackToIdentity.get('T1');
    const idT2 = trackToIdentity.get('T2');
    eq(session.getFrameIdentityValue(0, 'cam0', 1), idT1, 'target1 cam0 entry correct');
    eq(session.getFrameIdentityValue(0, 'cam1', 2), idT1, 'target1 cam1 entry correct');
    eq(session.getFrameIdentityValue(0, 'cam0', 3), idT2, 'target2 cam0 entry correct (different trackIdx, no collision)');
    eq(session.getFrameIdentityValue(0, 'cam2', 4), idT2, 'target2 cam2 entry correct');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    console.error('\nFailures:');
    failures.forEach(m => console.error('  - ' + m));
    process.exit(1);
}
