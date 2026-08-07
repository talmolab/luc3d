/**
 * test-node-trails.mjs — unit coverage for drawNodeTrails (issue #102), mirroring
 * SLEAP's TrackTrailOverlay.
 *
 * overlays.js is self-contained (no imports), so it loads directly under Node.
 * Run: `node tests/test-node-trails.mjs`.
 *
 * Verifies: length 0 is a no-op; trails seed from LINKED *and* UNLINKED instances
 * (identities are inspected before cross-view linking); history is the last N
 * PRESENT frames (sparse-aware, not contiguous frameIdx-1..N); past instances are
 * matched by trackIdx; one polyline segment per node per available past frame;
 * missing history / null trackIdx draw nothing without crashing.
 */
import { pathToFileURL } from 'url';
import path from 'path';

const ov = await import(pathToFileURL(path.resolve('ui/overlays.js')).href);

function mockCtx() {
    const calls = { stroke: 0, moveTo: 0, lineTo: 0, colors: [] };
    return {
        calls, globalAlpha: 1, strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
        save() {}, restore() {}, beginPath() {},
        moveTo() { calls.moveTo++; }, lineTo() { calls.lineTo++; },
        stroke() { calls.stroke++; this.calls.colors.push(this.strokeStyle); },
    };
}

// 2 nodes. Mirrors the FLAT Instance read surface `drawNodeTrails` actually uses
// (`numNodes` / `hasPoint(k)` / `getX(k)` / `getY(k)`) — see pose/pose-data.js.
// This mock used to expose the pre-luc3d-#185 boxed `points: [[x,y],...]` array,
// which the overlay stopped reading when instances moved to flat typed storage;
// `numNodes` was then `undefined`, every trail loop ran zero times, and all five
// drawing assertions failed against a perfectly healthy overlay.
function inst(trackIdx, x) {
    const xy = [x, 10, x + 1, 12];
    return {
        trackIdx,
        numNodes: xy.length >> 1,
        hasPoint(k) { return k >= 0 && k < (xy.length >> 1) && !Number.isNaN(xy[k << 1]); },
        getX(k) { return xy[k << 1]; },
        getY(k) { return xy[(k << 1) + 1]; },
    };
}

// FrameGroup-like: linked instances in a Map; unlinked via getUnlinkedInstances.
function fgLinked(x) { return { instances: new Map([['camA', [inst(7, x)]]]), getUnlinkedInstances() { return []; } }; }
function fgUnlinked(x) { return { instances: new Map(), getUnlinkedInstances(v) { return v === 'camA' ? [{ instance: inst(7, x) }] : []; } }; }

const GEO = { videoWidth: 640, videoHeight: 480, canvasWidth: 640, canvasHeight: 480 };

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) { if (cond) passed++; else { failed++; failures.push(msg); } }

function sessionOf(map) { return { frameGroups: map, getFrameGroup(i) { return map.get(i); }, tracks: [] }; }

// Track 7 present (LINKED) across frames 8,9,10.
const linkedFG = new Map([[8, fgLinked(100)], [9, fgLinked(110)], [10, fgLinked(120)]]);
const sLinked = sessionOf(linkedFG);

// 1. trailLength 0 → nothing drawn.
let ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', sLinked, 10, Object.assign({ trailLength: 0 }, GEO));
ok(ctx.calls.stroke === 0, 'length 0 is a no-op');

// 2. trailLength 5 at frame 10 → 2 present past frames (9,8) × 2 nodes = 4 segments.
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', sLinked, 10, Object.assign({ trailLength: 5 }, GEO));
ok(ctx.calls.stroke === 4, 'linked: 4 segments (2 nodes × 2 past frames), got ' + ctx.calls.stroke);

// 3. UNLINKED instances get trails too (the key case: IDs before linking).
const unlinkedFG = new Map([[8, fgUnlinked(100)], [9, fgUnlinked(110)], [10, fgUnlinked(120)]]);
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', sessionOf(unlinkedFG), 10, Object.assign({ trailLength: 5 }, GEO));
ok(ctx.calls.stroke === 4, 'unlinked instances draw trails, got ' + ctx.calls.stroke);

// 4. Sparse frames: history uses last-N PRESENT frames, not contiguous indices.
const sparseFG = new Map([[0, fgLinked(0)], [50, fgLinked(50)], [100, fgLinked(100)]]);
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', sessionOf(sparseFG), 100, Object.assign({ trailLength: 3 }, GEO));
ok(ctx.calls.stroke === 4, 'sparse frames (0,50 present <100) → 2 segments × 2 nodes = 4, got ' + ctx.calls.stroke);

// 5. Only current frame present → no history → nothing drawn, no crash.
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', sessionOf(new Map([[10, fgLinked(120)]])), 10, Object.assign({ trailLength: 50 }, GEO));
ok(ctx.calls.stroke === 0, 'no history present → nothing drawn');

// 6. null-trackIdx seed draws no trail.
const nullFG = new Map([[9, { instances: new Map([['camA', [inst(null, 5)]]]), getUnlinkedInstances() { return []; } }],
                        [10, { instances: new Map([['camA', [inst(null, 6)]]]), getUnlinkedInstances() { return []; } }]]);
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', sessionOf(nullFG), 10, Object.assign({ trailLength: 3 }, GEO));
ok(ctx.calls.stroke === 0, 'null-trackIdx seed draws no trail');

// 7. Color history: on an identity/color switch, past segments keep the color
// they had AT that frame (not the current seed's color). Track 7's identity color
// differs between frame 8 and frame 9 → segment colors must not all be identical.
const switchFG = new Map([[8, fgLinked(100)], [9, fgLinked(110)], [10, fgLinked(120)]]);
const colorByFrame = { 8: '#00ff00', 9: '#ff0000', 10: '#ff0000' };  // switch between 8 and 9
const sSwitch = {
    frameGroups: switchFG,
    getFrameGroup(i) { return switchFG.get(i); },
    tracks: [],
    getIdentityForTrack(trackIdx, cam, frameIdx) { return { color: colorByFrame[frameIdx] }; },
};
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', sSwitch, 10, Object.assign({ trailLength: 5, colorByIdentity: true }, GEO));
const uniqueHues = new Set(ctx.calls.colors.map(function (c) { return c.toLowerCase(); }));
ok(uniqueHues.size >= 2, 'segments keep per-frame color across a switch (>=2 distinct), got ' + uniqueHues.size);

// 8. A track that has VANISHED from the current frame still draws its lingering
// trail (trails are seeded from the window union, not just the current frame).
const vanishFG = new Map([
    [8, fgLinked(100)],   // track 7
    [9, fgLinked(110)],   // track 7
    // current frame: only track 3 present — track 7 has vanished
    [10, { instances: new Map([['camA', [inst(3, 120)]]]), getUnlinkedInstances() { return []; } }],
]);
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', sessionOf(vanishFG), 10, Object.assign({ trailLength: 5 }, GEO));
ok(ctx.calls.stroke === 2, 'vanished track (7) still trails (1 seg × 2 nodes), got ' + ctx.calls.stroke);

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
