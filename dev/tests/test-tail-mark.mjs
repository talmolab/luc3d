/**
 * test-tail-mark.mjs — pose/tail-mark.js: telling a banded tail from a plain one
 * on synthetic images, deciding who holds the marks when, finding a change's
 * frame, and the whole pass on a fake session and reader. The app half (the Track
 * menu, the dialog, Track All) is tests/e2e/tail-mark-track-all.mjs.
 *
 * Run:  node tests/test-tail-mark.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { tailMarkNodeIndices, readTailProfile, normalizeTailProfile, tailBandScore, learnTailTemplates, tailVote,
    planTailMarkSamples, contactGaps, evidenceScale, evidenceOf, decodeMarkedStates, refineChange, stretchesToSwap, resolveTailMarks, countBands, TAIL_BAND_READ } =
    await import(pathToFileURL(path.join(HERE, '..', 'pose', 'tail-mark.js')).href);

let passed = 0, failed = 0; const failures = [];
function eq(a, e, m) {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) passed++;
    else { failed++; failures.push(`${m} (expected ${E}, got ${A})`); console.error('  ✗ ' + m); }
}
function ok(c, m) { eq(!!c, true, m); }

// ---- which nodes -------------------------------------------------------------
const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2'];
eq(tailMarkNodeIndices(NODES), [3, 7, 8], 'base first, then the first two numbered tail nodes, by number');
eq(tailMarkNodeIndices(['tailbase', 'tail2', 'tail1']), [0, 2, 1], 'other spellings; numbered order, not skeleton order');
eq(tailMarkNodeIndices(['Nose', 'Tail_0']), null, 'no base');
eq(tailMarkNodeIndices(['Nose', 'TTI']), null, 'no tail nodes');

// ---- the measure, on drawn tails ----------------------------------------------
const W = 200, H = 120;
function floor(v = 12) { return new Uint8Array(W * H).fill(v); }
function disk(img, x, y, r, v) {
    for (let j = Math.floor(y - r); j <= y + r; j++) for (let i = Math.floor(x - r); i <= x + r; i++) {
        if (i >= 0 && j >= 0 && i < W && j < H && Math.hypot(i - x, j - y) <= r) img[j * W + i] = v;
    }
}
// A tail from (x0, y) to (x0 + len, y); `bands` = dark gaps as [from, to] fractions of its length.
function tail(img, x0, y, len, bands = [], v = 90) {
    for (let s = 0; s <= len; s += 0.5) {
        const f = s / len;
        const dark = bands.some(([a, b]) => f >= a && f < b);
        disk(img, x0 + s, y, 2.5, dark ? 14 : v);
    }
}
const read = (img, poly) => { const r = readTailProfile(img, W, H, poly); return r ? normalizeTailProfile(r.profile, r.background) : null; };
const score = (img, poly) => tailBandScore(read(img, poly));
const BANDS = [[0.2, 0.26], [0.45, 0.51], [0.7, 0.76]], WIDE = [[0.3, 0.55]];
const POLY = [20, 40, 80, 40, 140, 40];
function drawn(bands, v) { const img = floor(); tail(img, 20, 40, 120, bands, v); return img; }
const P_PLAIN = read(drawn([]), POLY), P_BANDS = read(drawn(BANDS), POLY), P_WIDE = read(drawn(WIDE), POLY);
ok(tailBandScore(P_PLAIN) < 0.02, 'a plain tail scores about 0, got ' + tailBandScore(P_PLAIN));
ok(tailBandScore(P_BANDS) > 0.05, 'narrow bands score high, got ' + tailBandScore(P_BANDS));
ok(tailBandScore(P_WIDE) > 0.05, 'one wide band scores high, got ' + tailBandScore(P_WIDE));
ok(score(drawn(BANDS, 45), POLY) > 0.05, 'a dim banded tail still scores');
ok(Math.abs(score(drawn(BANDS), [20, 44, 80, 36, 140, 43]) - tailBandScore(P_BANDS)) < 0.06, 'keypoints off the tail read the same bands');
ok(score(drawn([]), [20, 44, 80, 36, 140, 43]) < 0.03, 'keypoints off a plain tail do not invent bands');
{
    const bodies = floor(); tail(bodies, 20, 40, 120); disk(bodies, 20, 40, 18, 230); disk(bodies, 140, 40, 18, 230);
    ok(score(bodies, POLY) < 0.02, 'bright bodies at both ends are not bands');
}
eq(readTailProfile(floor(), W, H, [10, 10, 12, 12, 14, 14]), null, 'a foreshortened tail is too short to read');
{
    // four narrow bands packed before Tail_0, the first right at the base keypoint, with the
    // body behind and bright haunches beside the base (the 4-band mouse of 05mice_flippers)
    const img = floor();
    disk(img, 18, 40, 16, 200);
    tail(img, 30, 40, 120, [[0, 0.035], [0.075, 0.11], [0.15, 0.185], [0.225, 0.26]]);
    disk(img, 38, 30, 5, 200); disk(img, 38, 50, 5, 200);
    const poly = [30, 40, 90, 40, 150, 40], e = TAIL_BAND_READ.baseExtension;
    ok(countBands(read(img, poly)) < 4, 'the wide read blurs packed bands: counts ' + countBands(read(img, poly)));
    const r = readTailProfile(img, W, H, [30 + e * (30 - 90), 40].concat(poly), undefined, TAIL_BAND_READ);
    eq(countBands(normalizeTailProfile(r.profile, r.background)), 4, 'the band-counting read, started before the base, counts all four');
    const same = readTailProfile(img, W, H, poly, undefined, { percentile: 0.85, widthShare: 1 / 12 });
    eq(Array.from(same.profile), Array.from(readTailProfile(img, W, H, poly).profile), 'the default options are the default read');
}

eq(readTailProfile(floor(), W, H, [NaN, NaN, 50, 50]), null, 'a missing node leaves too little');
eq(normalizeTailProfile(new Float32Array(64).fill(13), 12), null, 'nothing brighter than the floor: no tail');
eq(tailBandScore(null), 0, 'no tail, no score');

// ---- the templates, and the votes ----------------------------------------------
{
    const sample = (m, p) => [[m, m, m, m, m], [p, p, p, p, p]];
    const raw = [...Array(12)].map((_, i) => (i % 2 ? sample(P_BANDS, P_PLAIN) : [sample(P_BANDS, P_PLAIN)[1], sample(P_BANDS, P_PLAIN)[0]]));
    raw.push(null, [[], [P_PLAIN]]);
    const tpl = learnTailTemplates(raw);
    eq(tpl.teaching, 12, 'each sample where one tail is far more banded teaches');
    ok(tpl.difference > 0.1, 'the templates differ: ' + tpl.difference);
    eq(tailVote(P_BANDS, tpl), 1, 'a marked tail votes marked');
    eq(tailVote(P_PLAIN, tpl), -1, 'a plain tail votes plain');
    const shifted = Float32Array.from(P_BANDS, (_, i) => P_BANDS[Math.max(0, i - 3)]);
    eq(tailVote(shifted, tpl), 1, 'keypoints a little along the tail still vote marked');
    // the bug behind templates: a plain tail in the shade over a broad stretch of its length
    const shade = floor();
    for (let s2 = 0; s2 <= 120; s2 += 0.5) disk(shade, 20 + s2, 40, 2.5, s2 > 8 && s2 < 50 ? 30 : 90);
    const P_SHADE = read(shade, POLY);
    ok(tailBandScore(P_SHADE) > tailBandScore(P_BANDS) / 2, 'shade reads as banded to a score alone');
    eq(tailVote(P_SHADE, tpl), 0, 'but fits neither template, so it votes nothing');
    // one wide band, the other kind of mark
    const wide = learnTailTemplates([...Array(12)].map(() => sample(P_WIDE, P_PLAIN)));
    eq(tailVote(P_WIDE, wide), 1, 'a session of one wide band learns that');
    eq(tailVote(P_PLAIN, wide), -1, 'and a plain tail still votes plain');
    // no marks: nothing teaches
    const none = learnTailTemplates([...Array(12)].map(() => sample(P_PLAIN, P_PLAIN)));
    eq(none.teaching, 0, 'two plain tails teach nothing');
    eq(none.marked, null, 'and give no template');
}

// ---- where to sample -----------------------------------------------------------
const framesTo = (n) => Array.from({ length: n }, (_, i) => i);
eq(planTailMarkSamples(framesTo(1001), [0, 250, 500, 750, 1000], 150), [0, 250, 500, 750, 1000], 'the keyframes, when dense enough');
eq(planTailMarkSamples(framesTo(601).slice(100, 501), [0, 250, 500], 150), [250, 500], 'only keyframes among the tracked frames');
eq(planTailMarkSamples(framesTo(100), null, 30), [0, 30, 60, 90], 'no keyframes: one per second');
eq(planTailMarkSamples(framesTo(100), [0, 90], 30), [0, 90], 'keyframes at the gap limit (3 s) kept');
eq(planTailMarkSamples(framesTo(100), [0, 90], 10).length, 10, 'keyframes further than the limit: one per second');
eq(planTailMarkSamples([], [0, 1], 30), [], 'no tracked frames');
eq(planTailMarkSamples(framesTo(100), [0, 90], 10, 10), [0, 90], 'a larger limit given (the identity engine): keyframes 9 s apart kept');

// ---- the decision ---------------------------------------------------------------
const ev = (ds) => ds.map((d) => d == null ? null : ({ a: d > 0 ? d : 0, b: d < 0 ? -d : 0, views: 5 }));
const contactAll = (n) => new Array(n - 1).fill(true);
eq(Array.from(decodeMarkedStates(ev([1, 1, 1, 1]), contactAll(4), 1)), [0, 0, 0, 0], 'all say a');
eq(Array.from(decodeMarkedStates(ev([-1, -1, -1]), contactAll(3), 1)), [1, 1, 1], 'all say b');
eq(Array.from(decodeMarkedStates(ev([1, 1, -0.9, 1, 1]), contactAll(5), 1)), [0, 0, 0, 0, 0], 'one contradicting sample does not make a stretch');
eq(Array.from(decodeMarkedStates(ev([1, 1, -1.2, -1.2, 1, 1]), contactAll(6), 1)), [0, 0, 1, 1, 0, 0], 'two do, across contacts');
eq(Array.from(decodeMarkedStates(ev([1, 1, -1, -1, 1, 1]), new Array(5).fill(false), 1)), [0, 0, 0, 0, 0, 0], 'the same two, apart, are not worth two changes');
eq(Array.from(decodeMarkedStates(ev([1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1]), new Array(11).fill(false), 1)), [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1], 'a long enough run changes even with no contact');
eq(Array.from(decodeMarkedStates(ev([1, null, null, -1, -1]), contactAll(5), 1)).length, 5, 'unreadable samples cost nothing');
eq(Array.from(decodeMarkedStates(ev([0.3, 0, -0.3, -1, -1]), [true, true, true, true], 1))[4], 1, 'weak samples count for less');
eq(Array.from(decodeMarkedStates([], [], 1)), [], 'no samples');
{
    eq(evidenceOf(null), null, 'no read');
    eq(evidenceOf([[], []]), null, 'no view');
    eq(evidenceOf([[1], []]).views, 1, 'one animal seen');
    eq(evidenceOf([[1, 1, 0, -1], [-1, -1]]), { a: 1, b: -2, views: 4 }, 'votes add up, unknown counting nothing');
    const alone = evidenceOf([[-1, -1, -1], []]);
    ok(alone.a < alone.b, 'a plain tail, the other animal undetected: it does not hold the marks');
}
eq(evidenceScale([{ a: 1, b: 0, views: 5 }, { a: 0, b: 2, views: 4 }, null, { a: 0, b: 0, views: 0 }]).used, 2, 'scale ignores unread samples');

// ---- finding the frame ------------------------------------------------------------
{
    const truth = (f) => (f < 137 ? { a: 1, b: 0 } : { a: 0, b: 1 });
    const r = await refineChange(0, 250, 0, async (f) => truth(f), 1, 30);
    ok(r.frame >= 137 && r.frame <= 140, 'bisects to the change, got ' + r.frame);
    ok(r.reads <= 8, 'in a few reads, got ' + r.reads);
    const hidden = await refineChange(0, 250, 0, async () => null, 1, 30);
    eq(hidden.frame, 125, 'nothing readable: the middle');
    const partly = await refineChange(0, 250, 0, async (f) => (f > 100 && f < 150 ? null : truth(f)), 1, 30);
    ok(partly.frame > 100 && partly.frame <= 170, 'steps past hidden frames, got ' + partly.frame);
}

// ---- which stretches --------------------------------------------------------------
eq(stretchesToSwap([{ frame: 0, state: 0 }], 0), [], 'already right');
eq(stretchesToSwap([{ frame: 0, state: 1 }], 0).map((s) => s.to === Infinity), [true], 'wrong throughout: to the end');
eq(stretchesToSwap([{ frame: 0, state: 0 }, { frame: 100, state: 1 }, { frame: 200, state: 0 }], 0), [{ from: 100, to: 199 }], 'the middle only');
eq(stretchesToSwap([{ frame: 0, state: 0 }, { frame: 100, state: 1 }, { frame: 200, state: 0 }], 1).length, 2, 'the two ends, for the other target');

// ---- the whole pass, labels crossing at contacts -----------------------------------
function fakeSession(nFrames, marksOnA, identities) {
    const ids = identities || [{ id: 10, name: 'id_0' }, { id: 11, name: 'id_1' }];
    const groups = new Map();
    for (let f = 0; f < nFrames; f++) groups.set(f, ids.map((i) => ({ identityId: i.id, instances: new Map(), points3d: null })));
    return {
        identities: ids, instanceGroups: groups, skeleton: { nodes: NODES },
        swapIdentitiesInRange(from, to, a, b) {
            for (const [f, list] of groups) {
                if (f < from || f > to) continue;
                list.forEach((g) => { if (g.identityId === a) g.identityId = b; else if (g.identityId === b) g.identityId = a; });
            }
        },
    };
}
// The reader sees the marks on whichever identity the fixture's truth says, re-read live, so a swap shows.
function fakeReader(session, isMarked, step, opts = {}) {
    let open = 0;
    const readAt = async (f) => {
        const scores = new Map();
        for (const g of session.instanceGroups.get(f) || []) {
            const marked = isMarked(f, g);
            scores.set(g.identityId, opts.plain || !marked ? [P_PLAIN, P_PLAIN, P_PLAIN, P_PLAIN, P_PLAIN]
                : [P_BANDS, P_BANDS, P_BANDS, P_PLAIN, P_BANDS]);
        }
        return { scores };
    };
    return {
        plan: async (frames) => frames.filter((f) => f % step === 0),
        open: async () => { open++; }, next: readAt, at: readAt,
        close: () => { open--; }, get opened() { return open; },
    };
}
// Truth: frames [300, 700) have the labels crossed by the tracker.
const crossed = (f) => f >= 300 && f < 700;
const fixture = (n = 1000) => {
    const s = fakeSession(n);
    // the animal under identity 10 at frame f, for the labels as tracked: the truth is fixed per group object
    for (const [f, list] of s.instanceGroups) list.forEach((g) => { g.truthMarked = crossed(f) ? g.identityId === 11 : g.identityId === 10; });
    return s;
};
const holder = (s, f) => s.instanceGroups.get(f).find((g) => g.truthMarked).identityId;
{
    const s = fixture(), reader = fakeReader(s, (f, g) => g.truthMarked, 50);
    const r = await resolveTailMarks(s, { markedName: 'id_0', fps: 30, reader });
    ok(r.ok, 'runs');
    eq(r.changes, 2, 'finds both label changes');
    eq(r.swapped, 1, 'swaps one stretch');
    eq(r.faint, false, 'marks in every sample are not faint');
    let wrong = 0;
    for (let f = 0; f < 1000; f++) if (holder(s, f) !== 10) wrong++;
    ok(wrong <= 8, 'the chosen identity holds the marks, within a few frames of each change: ' + wrong + ' wrong');
    eq(reader.opened, 0, 'the streaming readers are closed');
}
{
    const s = fixture(), reader = fakeReader(s, (f, g) => g.truthMarked, 50);
    const r = await resolveTailMarks(s, { markedName: 'id_1', fps: 30, reader });
    eq(r.swapped, 2, 'for the other identity: the two outer stretches');
    let wrong = 0;
    for (let f = 0; f < 1000; f++) if (holder(s, f) !== 11) wrong++;
    ok(wrong <= 8, 'id_1 then holds the marks throughout: ' + wrong + ' wrong');
}
{
    const s = fixture(), reader = fakeReader(s, (f, g) => g.truthMarked, 50, { plain: true });
    const before = s.instanceGroups.get(500).map((g) => g.identityId);
    const r = await resolveTailMarks(s, { markedName: 'id_0', fps: 30, reader });
    eq(r.ok, false, 'no marks on either animal: refused');
    ok(/no tail marks/.test(r.reason), 'and says so: ' + r.reason);
    eq(s.instanceGroups.get(500).map((g) => g.identityId), before, 'and changes no label');
}
{
    // marks seen in too few samples: the session is refused, as two plain tails are
    const s = fixture(), reader = fakeReader(s, (f, g) => g.truthMarked && f % 200 === 0, 50);
    const before = s.instanceGroups.get(500).map((g) => g.identityId);
    const r = await resolveTailMarks(s, { markedName: 'id_0', fps: 30, reader });
    ok(!r.ok && /no tail marks/.test(r.reason), 'marks in a quarter of the samples: refused, ' + r.teaching + ' of 20 teach');
    eq(s.instanceGroups.get(500).map((g) => g.identityId), before, 'and no label changes');
}
{
    const s = fakeSession(100, true, [{ id: 1, name: 'id_0' }, { id: 2, name: 'id_1' }, { id: 3, name: 'id_2' }]);
    const r = await resolveTailMarks(s, { markedName: 'id_0', fps: 30, reader: fakeReader(s, () => false, 50) });
    ok(!r.ok && /exactly two/.test(r.reason), 'three identities: refused');
    const s2 = fakeSession(100);
    const r2 = await resolveTailMarks(s2, { markedName: 'nobody', fps: 30, reader: fakeReader(s2, () => false, 50) });
    ok(!r2.ok && /nobody/.test(r2.reason), 'an unknown identity name: refused');
    const r3 = await resolveTailMarks(s2, { markedName: 'id_0', fps: 0, reader: fakeReader(s2, () => false, 50) });
    ok(!r3.ok, 'no frame rate: refused');
}

// ---- contacts come from the 3D ---------------------------------------------------
{
    const FPS = 30, T = 30 * FPS;
    const NODES3 = ['Nose', 'Head', 'Trunk', 'TTI'];
    const pts = (cx) => { const a = new Float64Array(12); NODES3.forEach((_, i) => { a[3 * i] = cx + 10 * i; }); return a; };
    const s = { identities: [{ id: 1, name: 'id_0' }, { id: 2, name: 'id_1' }], skeleton: { nodes: NODES3 }, instanceGroups: new Map() };
    for (let f = 0; f < T; f++) {
        const together = f >= 300 && f < 360;
        s.instanceGroups.set(f, [{ identityId: 1, points3d: pts(0) }, { identityId: 2, points3d: pts(together ? 4 : 400) }]);
    }
    const samples = [0, 150, 280, 320, 400, 800];
    eq(contactGaps(s, samples, FPS), [false, false, true, true, false], 'a gap holds a contact only when the animals touch in it');
    const none = { identities: [{ id: 1 }, { id: 2 }], skeleton: { nodes: NODES3 }, instanceGroups: new Map() };
    eq(contactGaps(none, [0, 10, 20], FPS), [true, true], 'no 3D: every gap may hold a change');
}

console.log(`\ntest-tail-mark: ${passed} passed, ${failed} failed`);
if (failed) { failures.forEach((f) => console.error(' - ' + f)); process.exit(1); }
