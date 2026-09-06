/**
 * test-tracker-gui.mjs — Node test that the tracker drives the GUI "in all the
 * right ways", exactly like the current luc3d tracker: trackCurrentFrame()
 * assigns tracks + identities on the session AND refreshes the overlays, info
 * panel and timeline tracks. Uses tracker-gui-hooks.mjs (spy UI stubs).
 *
 * Run:  node tests/test-tracker-gui.mjs
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

// GUI spy sink + DOM shims, set before importing the tracker.
globalThis.__GUI = {
    thresholds: {}, drawOverlays: 0, updateInfoPanel: 0, refreshTracks: 0,
    update3DViewport: 0, markDirty: 0, lastStatus: null, lastDrawFrame: null,
};
globalThis.document = { getElementById: () => null };
globalThis.window = globalThis;
// trackCurrentFrame() prompts for the animal count on first use; answer "2".
globalThis.prompt = () => '2';

register(pathToFileURL(path.join(HERE, 'tracker-gui-hooks.mjs')).href);
const { Camera, Instance, FrameGroup, Session } =
    await import(pathToFileURL(path.join(POSE_DIR, 'pose-data.js')).href);
const appState = await import(pathToFileURL(path.join(ROOT, 'ui', 'app-state.js')).href);
const { trackCurrentFrame } =
    await import(pathToFileURL(path.join(POSE_DIR, 'tracker.js')).href);

// --- synthetic 2-animal × 3-view frame -------------------------------------
const NODES = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
const OFFSETS = [[0, 0, 0], [2, 1, 0], [-2, 1, 0], [0, -2, 1], [1.5, 0, -1.5], [-1.5, 0, 1.5]];
function cam(name, rvec, tvec) {
    return new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
}
const CAMS = [cam('c0', [0, 0, 0], [0, 0, 0]), cam('c1', [0, 0.35, 0], [-12, 0, 3]), cam('c2', [0.35, 0, 0], [0, -12, 3])];
function instance(c, centroid, trackIdx) {
    return new Instance(OFFSETS.map(o => c.project([centroid[0] + o[0], centroid[1] + o[1], centroid[2] + o[2]])),
        trackIdx, 'predicted', 1.0);
}

const session = new Session(CAMS, { nodes: NODES }, ['track_0', 'track_1'], 'gui');
const fg = new FrameGroup(0);
[[-7, 0, 48], [7, 0, 48]].forEach((ctr, ai) => CAMS.forEach(c => fg.addInstance(c.name, instance(c, ctr, ai))));
session.addFrameGroup(fg);

// Wire the session into the (stubbed) app state, then run the app entry point.
appState.state.session = session;
appState.state.currentFrame = 0;

console.log('• trackCurrentFrame() updates tracks/identities + GUI');
trackCurrentFrame();

// Track/identity assignment happened.
eq(session.identities.length, 2, 'two identities created on the session');
// GUI refreshed in all the right ways.
ok(globalThis.__GUI.drawOverlays >= 1, 'overlays redrawn (drawAllOverlays called)');
eq(globalThis.__GUI.lastDrawFrame, 0, 'overlays redrawn for the current frame');
ok(globalThis.__GUI.updateInfoPanel >= 1, 'info panel updated (updateInfoPanel called)');
ok(globalThis.__GUI.refreshTracks >= 1, 'timeline tracks refreshed (timeline.refreshTracks called)');
ok(globalThis.__GUI.lastStatus && /identit/i.test(globalThis.__GUI.lastStatus.msg || ''),
    'status reports identities to the user');
eq(globalThis.__GUI.lastStatus && globalThis.__GUI.lastStatus.level, 'success', 'status level is success');

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
