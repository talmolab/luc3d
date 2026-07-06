/**
 * test-node-trails.mjs — unit coverage for drawNodeTrails (issue #102).
 *
 * Exercises the node-trail renderer (ui/overlays.js) against a mock canvas
 * context + fake session. overlays.js is self-contained (no imports), so it
 * loads directly under Node. Run: `node tests/test-node-trails.mjs`.
 *
 * Verifies: length 0 is a no-op; trails match past instances by per-view
 * trackIdx and draw a fading dot+segment per node per loaded history frame;
 * unloaded/missing history frames are skipped without crashing (the perf-safe
 * "only walk loaded frames" contract).
 */
import { pathToFileURL } from 'url';
import path from 'path';

const ov = await import(pathToFileURL(path.resolve('ui/overlays.js')).href);

function mockCtx() {
    const calls = { stroke: 0, arc: 0, fill: 0, moveTo: 0, lineTo: 0 };
    return {
        calls, globalAlpha: 1, strokeStyle: '', fillStyle: '', lineWidth: 1,
        save() {}, restore() {}, beginPath() {},
        moveTo() { calls.moveTo++; }, lineTo() { calls.lineTo++; },
        stroke() { calls.stroke++; }, arc() { calls.arc++; }, fill() { calls.fill++; },
    };
}

function inst(trackIdx, x) { return { trackIdx, points: [[x, 10], [x + 1, 12]] }; }   // 2 nodes
function fg(fi, x) { return { frameIdx: fi, instances: new Map([['camA', [inst(7, x)]]]) }; }

const GEO = { videoWidth: 640, videoHeight: 480, canvasWidth: 640, canvasHeight: 480 };

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) { if (cond) passed++; else { failed++; failures.push(msg); } }

// Track 7 present across frames 8,9,10.
const frameGroups = new Map([[8, fg(8, 100)], [9, fg(9, 110)], [10, fg(10, 120)]]);
const session = {
    frameGroups,
    getFrameGroup(i) { return frameGroups.get(i); },
    tracks: ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'],
};

// 1. trailLength 0 → nothing drawn.
let ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', session, 10, Object.assign({ trailLength: 0, colorByIdentity: false }, GEO));
ok(ctx.calls.stroke === 0 && ctx.calls.arc === 0, 'length 0 is a no-op');

// 2. trailLength 5 at frame 10 → 2 loaded history frames (9, 8) × 2 nodes = 4 dots.
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', session, 10, Object.assign({ trailLength: 5, colorByIdentity: false }, GEO));
ok(ctx.calls.arc === 4, 'exactly 4 history dots (2 nodes × 2 frames), got ' + ctx.calls.arc);
ok(ctx.calls.stroke === 4, 'exactly 4 trail segments, got ' + ctx.calls.stroke);

// 3. Seed track matched across a single loaded history frame → 2 dots (2 nodes).
const fgs2 = new Map([
    [9, { frameIdx: 9, instances: new Map([['camA', [inst(99, 5)]]]) }],
    [10, { frameIdx: 10, instances: new Map([['camA', [inst(99, 6)]]]) }],
]);
const s2 = { frameGroups: fgs2, getFrameGroup(i) { return fgs2.get(i); }, tracks: [] };
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', s2, 10, Object.assign({ trailLength: 3, colorByIdentity: false }, GEO));
ok(ctx.calls.arc === 2, 'matches trackIdx across 1 history frame (2 nodes → 2 dots), got ' + ctx.calls.arc);

// 4. No loaded history (only current frame) → nothing drawn, no throw.
const fgs3 = new Map([[10, fg(10, 120)]]);
const s3 = { frameGroups: fgs3, getFrameGroup(i) { return fgs3.get(i); }, tracks: [] };
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', s3, 10, Object.assign({ trailLength: 50, colorByIdentity: false }, GEO));
ok(ctx.calls.arc === 0 && ctx.calls.stroke === 0, 'no loaded history → nothing drawn, no crash');

// 5. Seed with null trackIdx is ignored (no trail).
const fgs4 = new Map([
    [9, { frameIdx: 9, instances: new Map([['camA', [inst(null, 5)]]]) }],
    [10, { frameIdx: 10, instances: new Map([['camA', [inst(null, 6)]]]) }],
]);
const s4 = { frameGroups: fgs4, getFrameGroup(i) { return fgs4.get(i); }, tracks: [] };
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', s4, 10, Object.assign({ trailLength: 3, colorByIdentity: false }, GEO));
ok(ctx.calls.arc === 0, 'null-trackIdx seed draws no trail');

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
