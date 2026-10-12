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
 * missing history / null trackIdx draw nothing without crashing; on a LAZY
 * project a non-resident frame ends the window instead of being skipped; the
 * trail SHADE orders Very dark < Dark < Normal < Light < Very light on every
 * palette color, drawn strokes follow it (Dark when none is given), and Normal
 * is the pre-shade look.
 *
 * Segments are counted as moveTo/lineTo pairs, NOT stroke() calls: segments of
 * the same age share one path and one stroke (one per track per age step), so
 * a stroke count would measure the batching, not the trail. Both are asserted.
 */
import { pathToFileURL } from 'url';
import path from 'path';

const ov = await import(pathToFileURL(path.resolve('ui/overlays.js')).href);

function mockCtx() {
    // `segments` = lineTo count (each segment is one moveTo + one lineTo);
    // `styled` records every segment with the style it was stroked in.
    const calls = { stroke: 0, moveTo: 0, lineTo: 0, colors: [], styled: [] };
    let pending = 0;
    return {
        calls, globalAlpha: 1, strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
        get segments() { return calls.lineTo; },
        save() {}, restore() {}, beginPath() { pending = 0; },
        moveTo() { calls.moveTo++; }, lineTo() { calls.lineTo++; pending++; },
        stroke() {
            calls.stroke++; this.calls.colors.push(this.strokeStyle);
            for (let i = 0; i < pending; i++) calls.styled.push({ a: this.globalAlpha, w: this.lineWidth, c: this.strokeStyle });
        },
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
ok(ctx.segments === 0 && ctx.calls.stroke === 0, 'length 0 is a no-op');

// 2. trailLength 5 at frame 10 → 2 present past frames (9,8) × 2 nodes = 4 segments.
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', sLinked, 10, Object.assign({ trailLength: 5 }, GEO));
ok(ctx.segments === 4, 'linked: 4 segments (2 nodes × 2 past frames), got ' + ctx.segments);
// Batched: one stroke per age step (2), not per segment (4); both of a step's
// segments carry that step's alpha / width.
ok(ctx.calls.stroke === 2, 'linked: 2 strokes (one per age step), got ' + ctx.calls.stroke);
ok(ctx.calls.styled.length === 4 && ctx.calls.styled[0].a === ctx.calls.styled[1].a &&
   ctx.calls.styled[2].a < ctx.calls.styled[0].a && ctx.calls.styled[2].w < ctx.calls.styled[0].w,
   'each age step strokes its segments in its own (older = fainter, thinner) style');

// 3. UNLINKED instances get trails too (the key case: IDs before linking).
const unlinkedFG = new Map([[8, fgUnlinked(100)], [9, fgUnlinked(110)], [10, fgUnlinked(120)]]);
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', sessionOf(unlinkedFG), 10, Object.assign({ trailLength: 5 }, GEO));
ok(ctx.segments === 4, 'unlinked instances draw trails, got ' + ctx.segments);

// 4. Sparse frames: history uses last-N PRESENT frames, not contiguous indices.
const sparseFG = new Map([[0, fgLinked(0)], [50, fgLinked(50)], [100, fgLinked(100)]]);
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', sessionOf(sparseFG), 100, Object.assign({ trailLength: 3 }, GEO));
ok(ctx.segments === 4, 'sparse frames (0,50 present <100) → 2 segments × 2 nodes = 4, got ' + ctx.segments);

// 5. Only current frame present → no history → nothing drawn, no crash.
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', sessionOf(new Map([[10, fgLinked(120)]])), 10, Object.assign({ trailLength: 50 }, GEO));
ok(ctx.segments === 0, 'no history present → nothing drawn');

// 6. null-trackIdx seed draws no trail.
const nullFG = new Map([[9, { instances: new Map([['camA', [inst(null, 5)]]]), getUnlinkedInstances() { return []; } }],
                        [10, { instances: new Map([['camA', [inst(null, 6)]]]), getUnlinkedInstances() { return []; } }]]);
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', sessionOf(nullFG), 10, Object.assign({ trailLength: 3 }, GEO));
ok(ctx.segments === 0, 'null-trackIdx seed draws no trail');

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
ok(ctx.segments === 2, 'vanished track (7) still trails (1 seg × 2 nodes), got ' + ctx.segments);

// 9. A gap in one node breaks only that node's line (no segment across it),
// while the other node's segments in the same age step are still drawn.
function instGap(trackIdx, x, missingNode) {
    const o = inst(trackIdx, x);
    const has = o.hasPoint;
    o.hasPoint = (k) => k !== missingNode && has(k);
    return o;
}
const gapFG = new Map([
    [8, fgLinked(100)],
    [9, { instances: new Map([['camA', [instGap(7, 110, 1)]]]), getUnlinkedInstances() { return []; } }],
    [10, fgLinked(120)],
]);
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', sessionOf(gapFG), 10, Object.assign({ trailLength: 5 }, GEO));
ok(ctx.segments === 2, 'node 1 missing at frame 9: node 0 keeps both segments, node 1 none → 2, got ' + ctx.segments);

// 10. Trail window — walks back from the current frame on a dense project
// instead of scanning + sorting every loaded frame (the fixed per-redraw cost
// on a 36,000-frame project held in memory), and stays exact on sparse ones.
class CountingMap extends Map {
    constructor(e) { super(e); this.hasCalls = 0; this.forEachCalls = 0; }
    has(k) { this.hasCalls++; return super.has(k); }
    forEach(f, t) { this.forEachCalls++; return super.forEach(f, t); }
}
const dense = new CountingMap();
for (let f = 0; f < 36000; f++) dense.set(f, 1);
const win = ov.trailWindowFrames(dense, 30000, 100);
ok(win.length === 101 && win[0] === 30000 && win[100] === 29900, 'dense window = frames 30000..29900, nearest first');
ok(dense.forEachCalls === 0 && dense.hasCalls <= 101, 'dense: no full scan, ' + dense.hasCalls + ' lookups (want <= 101)');
const sparse = new CountingMap([[0, 1], [5000, 1], [20000, 1], [35000, 1]]);
ok(JSON.stringify(ov.trailWindowFrames(sparse, 30000, 100)) === '[20000,5000,0]',
   'sparse: falls back to the scan and returns the present frames <= current');
ok(JSON.stringify(ov.trailWindowFrames(new Map([[3, 1], [4, 1]]), 10, 5)) === '[4,3]',
   'reaches frame 0 with frames left over: returns what exists');

// 11. LAZY project: `frameGroups` is a residency window, so a missing frame is
// one not hydrated yet — the window ends there instead of skipping to frames
// still resident from before a seek. After a jump from ~1000 to 3000 the old
// window is resident and the frames just behind 3000 are not.
const afterJump = new CountingMap();
for (let f = 990; f <= 1010; f++) afterJump.set(f, 1);
for (let f = 3000; f <= 3030; f++) afterJump.set(f, 1);
ok(JSON.stringify(ov.trailWindowFrames(afterJump, 3000, 10, true)) === '[3000]',
   'lazy: the window ends at the first non-resident frame');
ok(afterJump.forEachCalls === 0, 'lazy: never falls back to the scan');
ok(JSON.stringify(ov.trailWindowFrames(afterJump, 3003, 2, true)) === '[3003,3002,3001]',
   'lazy: a fully resident window is the contiguous frames, nearest first');
ok(ov.trailWindowFrames(afterJump, 3000, 10)[1] === 1010,
   'eager rule on the same map does bridge to 1010 (why lazy needs its own rule)');
const jumpFG = new Map([[1009, fgLinked(100)], [1010, fgLinked(101)], [3000, fgLinked(700)]]);
const lazySession = Object.assign(sessionOf(jumpFG), { lazyLoader: {} });
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', lazySession, 3000, Object.assign({ trailLength: 10 }, GEO));
ok(ctx.segments === 0, 'lazy: no trail segment joins the frame to the pre-jump window, got ' + ctx.segments);
ctx = mockCtx();
ov.drawNodeTrails(ctx, 'camA', sessionOf(jumpFG), 3000, Object.assign({ trailLength: 10 }, GEO));
ok(ctx.segments === 4, 'eager (sparse) project still joins the last present frames, got ' + ctx.segments);

// 12. Trail SHADE — how much darker or lighter than its track a trail is drawn,
// so the skeleton on the current frame stands apart from its history (SLEAP's
// View ▸ Trail Shade). Default Dark.
const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
};
const keys = ov.TRAIL_SHADES.map(s => s.key);
ok(JSON.stringify(keys) === '["veryDark","dark","normal","light","veryLight"]',
   'five shades, darkest first: ' + keys.join(', '));
ok(ov.TRAIL_SHADES.every((s, i, a) => i === 0 || s.amount > a[i - 1].amount), 'ordered dark → light');
ok(ov.DEFAULT_TRAIL_SHADE === 'dark' && ov.trailShadeFor('dark').name === 'Dark', 'the default is Dark');
ok(ov.trailShadeFor('nope') === null && ov.trailShadeFor(undefined) === null, 'trailShadeFor is strict');
ok(ov.trailColor('#ff6b6b', 'normal', 0) === '#ff6b6b', 'Normal, newest segment = the track color');
ok(ov.trailColor('#ff6b6b', 'dark', 0) === '#994040', 'Dark = SLEAP\'s ×0.6 (got ' + ov.trailColor('#ff6b6b', 'dark', 0) + ')');
ok(ov.trailColor('#ff6b6b', 'light', 0) === '#ffa6a6',
   'Light blends toward white — a ×1.25 would leave the 255 channel, and a saturated color, as is (got ' + ov.trailColor('#ff6b6b', 'light', 0) + ')');
ok(ov.trailColor('#ff6b6b', 'nope', 0) === ov.trailColor('#ff6b6b', 'dark', 0) &&
   ov.trailColor('#ff6b6b', undefined, 0) === ov.trailColor('#ff6b6b', 'dark', 0), 'an unknown or missing shade is Dark');
// For EVERY palette color, at both ends of a trail: each step of the scale is
// strictly brighter than the last, the dark shades are darker than the track
// and the light ones lighter — and age moves further the same way, never
// back toward the track's own color.
let ordered = true, sided = true, aged = true;
const orderFails = [];
for (const c of ov.TRACK_COLORS) {
    for (const age of [0, 0.5, 0.95]) {
        const ls = keys.map(k => lum(ov.trailColor(c, k, age)));
        if (!ls.every((v, i) => i === 0 || v > ls[i - 1])) { ordered = false; orderFails.push(c + '@' + age); }
    }
    for (const s of ov.TRAIL_SHADES) {
        const near = lum(ov.trailColor(c, s.key, 0)), far = lum(ov.trailColor(c, s.key, 0.95));
        if (s.amount < 0 && !(near < lum(c))) sided = false;
        if (s.amount > 0 && !(near > lum(c))) sided = false;
        if (s.amount > 0 ? !(far > near) : !(far < near)) aged = false;
    }
}
ok(ordered, 'every palette color: Very dark < Dark < Normal < Light < Very light' + (orderFails.length ? ' (fails ' + orderFails.join(', ') + ')' : ''));
ok(sided, 'every palette color: dark shades below the track color, light shades above it');
ok(aged, 'every palette color: older segments move further from the track color, in the shade\'s direction');

// drawNodeTrails strokes in the shade it is given, Dark when it is given none.
// Track 7 over frames 8..10 → two age steps; window W = 3.
const trackHex = ov.getTrackColor(7);
const strokeColors = (shadeOpt) => {
    const c = mockCtx();
    ov.drawNodeTrails(c, 'camA', sLinked, 10, Object.assign({ trailLength: 5 }, shadeOpt, GEO));
    return c.calls.colors.map(x => x.toLowerCase());
};
const ages = [1 / 4, 2 / 4];   // k / (W + 1) for the two age steps k = 1, 2
const expect = (key) => ages.map(a => ov.trailColor(trackHex, key, a));
ok(JSON.stringify(strokeColors({})) === JSON.stringify(expect('dark')),
   'no trailShade → Dark: ' + strokeColors({}).join(',') + ' vs ' + expect('dark').join(','));
for (const key of keys) {
    ok(JSON.stringify(strokeColors({ trailShade: key })) === JSON.stringify(expect(key)),
       'trailShade "' + key + '" strokes ' + expect(key).join(','));
}
ok(strokeColors({ trailShade: 'light' }).every(h => lum(h) > lum(trackHex)) &&
   strokeColors({ trailShade: 'dark' }).every(h => lum(h) < lum(trackHex)),
   'drawn: a Light trail is lighter than its track, a Dark one darker');
// Normal reproduces the look trails had before shades: V scaled 1.0 → 0.55.
const legacy = [1, 2].map(k => ov.adjustColorBrightness(trackHex, 0.55 + 0.45 * (1 - k / 4)));
ok(JSON.stringify(strokeColors({ trailShade: 'normal' })) === JSON.stringify(legacy),
   'Normal = the pre-shade trail colors ' + legacy.join(','));

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
