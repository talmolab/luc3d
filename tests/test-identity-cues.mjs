/**
 * test-identity-cues.mjs — pose/identity-cues.js, the cue-agnostic identity engine, and
 * the tail-band cue that plugs into it (pose/tail-mark.js `createTailBandCue`).
 * A fake cue and fake readers make the engine's decisions exact; drawn tails test the cue.
 *
 * Run:  node tests/test-identity-cues.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ic = await import(pathToFileURL(path.join(HERE, '..', 'pose', 'identity-cues.js')).href);
const tm = await import(pathToFileURL(path.join(HERE, '..', 'pose', 'tail-mark.js')).href);

let passed = 0, failed = 0; const failures = [];
function eq(a, e, m) {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) passed++;
    else { failed++; failures.push(`${m} (expected ${E}, got ${A})`); console.error('  ✗ ' + m); }
}
function ok(c, m) { eq(!!c, true, m); }

// ---- orderings and the swaps that apply one ----------------------------------
eq(ic.permutationsOf(3).length, 6, '3 animals: 6 orderings');
eq(ic.permutationsOf(5).length, 120, '5 animals: 120');
eq(Array.from(ic.permutationsOf(3)[0]), [0, 1, 2], 'the first is "as tracked"');
eq(ic.swapsFor([0, 1, 2]), [], 'nothing to swap');
eq(ic.swapsFor([1, 0, 2]), [[0, 1]], 'one pair');
eq(ic.swapsFor([1, 2, 0]), [[0, 1], [0, 2]], 'a three-way cycle is two swaps with its first member');
{
    // applying swapsFor(perm) to labels: identity i ends up named after animal perm[i]
    const perm = [2, 0, 3, 1], label = [0, 1, 2, 3];   // label[i]: the name identity i's frames carry
    ic.swapsFor(perm).forEach(([a, b]) => { label.forEach((v, i) => { if (v === a) label[i] = b; else if (v === b) label[i] = a; }); });
    eq(label, perm, 'the swaps rename every identity to its animal');
}

// ---- the decision ---------------------------------------------------------------
// cost rows from "which animal each identity looks like": 0 for that animal, 1 for the others
function rowsFrom(seq, K) {
    return seq.map((looks) => {
        if (!looks) return null;
        const r = new Float64Array(K * K).fill(1);
        looks.forEach((j, i) => { if (j != null) r[i * K + j] = 0; else for (let q = 0; q < K; q++) r[i * K + q] = 0; });
        return r;
    });
}
const always = () => true, never = () => false;
{
    const K = 3, seq = [];
    for (let t = 0; t < 10; t++) seq.push(t < 5 ? [0, 1, 2] : [1, 0, 2]);   // identities 0 and 1 swap animals after sample 4
    const d = ic.decodeAssignments(rowsFrom(seq, K), K, always);
    eq(Array.from(d.states, (s) => d.perms[s].join('')).join(' '), '012 012 012 012 012 102 102 102 102 102', 'a swap at a contact is found');
    const touchOnly = (gap, a, b) => gap === 4 && a === 0 && b === 1;
    const d2 = ic.decodeAssignments(rowsFrom(seq, K), K, touchOnly);
    eq(d2.perms[d2.states[9]].join(''), '102', 'and when only those two touch, in that gap');
    const touchElse = (gap, a, b) => gap === 4 && a === 1 && b === 2;
    const short = [[0, 1, 2], [0, 1, 2], [1, 0, 2], [0, 1, 2], [0, 1, 2]];
    const d3 = ic.decodeAssignments(rowsFrom(short, K), K, touchElse);
    eq(Array.from(d3.states, (s) => d3.perms[s].join('')).join(' '), '012 012 012 012 012', 'one odd sample, apart: no change');
}
{
    // shared classes: animals 0 and 1 both "red"; the cue cannot tell them apart, so nothing changes between them
    const K = 3, classes = ['red', 'red', 'blue'];
    const rows = [];
    for (let t = 0; t < 8; t++) {
        const r = new Float64Array(K * K);
        for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) r[i * K + j] = classes[j] === (i === 2 ? 'blue' : 'red') ? 0 : 1;
        rows.push(r);
    }
    const d = ic.decodeAssignments(rows, K, always);
    ok(d.states.every((s) => d.perms[s].join('') === '012'), 'two animals of one class: their labels stay as tracked');
}

// ---- the whole pass, with a fake cue ------------------------------------------------
// the fake cue's feature is the animal's class itself (as a camera would read it), one per camera
const fakeCue = {
    id: 'colour',
    learn: () => ({ ok: true, model: {} }),
    costs: (features) => { const m = new Map(); ['red', 'blue', 'green'].forEach((c) => m.set(c, features.filter((f) => f !== c).length)); return m; },
};
function fakeSession(n, frames) {
    const ids = Array.from({ length: n }, (_, i) => ({ id: 100 + i, name: 'id_' + i }));
    const groups = new Map();
    for (let f = 0; f < frames; f++) groups.set(f, ids.map((i) => ({ identityId: i.id, instances: new Map(), points3d: null })));
    return { identities: ids, instanceGroups: groups, skeleton: { nodes: ['Nose', 'TTI'] },
        swapIdentitiesInRange(from, to, a, b) { for (const [f, l] of groups) { if (f < from || f > to) continue; l.forEach((g) => { if (g.identityId === a) g.identityId = b; else if (g.identityId === b) g.identityId = a; }); } } };
}
// truth: which colour each group shows; tracker labels cross: identities 100 and 101 swap animals on [300, 650)
function fixture() {
    const s = fakeSession(3, 1000), colour = ['red', 'blue', 'green'];
    for (const [f, l] of s.instanceGroups) l.forEach((g) => { const i = g.identityId - 100; g.truth = f >= 300 && f < 650 && i < 2 ? colour[1 - i] : colour[i]; });
    return s;
}
function fakeReader(s, step) {
    const read = async (f) => new Map((s.instanceGroups.get(f) || []).map((g) => [g.identityId, [g.truth, g.truth, g.truth]]));
    return { plan: async (frames) => frames.filter((f) => f % step === 0), open: async () => {}, next: async (f) => ({ scores: await read(f) }), at: async (f) => ({ scores: await read(f) }), close: () => {} };
}
const expected = { id_0: { colour: 'red' }, id_1: { colour: 'blue' }, id_2: { colour: 'green' } };
{
    const s = fixture();
    const r = await ic.resolveIdentityCues(s, { fps: 30, expected, cues: [{ cue: fakeCue, reader: fakeReader(s, 50) }] });
    ok(r.ok, 'runs: ' + r.reason);
    eq(r.changes, 2, 'finds both changes');
    let wrong = 0;
    for (const [f, l] of s.instanceGroups) l.forEach((g) => { if (g.truth !== expected[s.identities.find((i) => i.id === g.identityId).name].colour) wrong++; });
    ok(wrong <= 12, 'every identity holds its animal, within a few frames of each change: ' + wrong + ' wrong group-frames');
}
{
    // the same, but the user wants different names: id_0 green, id_2 red
    const s = fixture(), exp2 = { id_0: { colour: 'green' }, id_1: { colour: 'blue' }, id_2: { colour: 'red' } };
    const r = await ic.resolveIdentityCues(s, { fps: 30, expected: exp2, cues: [{ cue: fakeCue, reader: fakeReader(s, 50) }] });
    let wrong = 0;
    for (const [, l] of s.instanceGroups) l.forEach((g) => { if (g.truth !== exp2[s.identities.find((i) => i.id === g.identityId).name].colour) wrong++; });
    ok(r.ok && wrong <= 12, 'the user\'s choice of who is who is what the labels end up as: ' + wrong + ' wrong');
}
{
    const s = fixture();
    let r = await ic.resolveIdentityCues(s, { fps: 30, expected: { id_0: { colour: 'red' }, id_1: { colour: 'blue' } }, cues: [{ cue: fakeCue, reader: fakeReader(s, 50) }] });
    ok(!r.ok && /2 identities, but tracking found 3/.test(r.reason), 'marks for 2 of 3 identities: refused, ' + r.reason);
    r = await ic.resolveIdentityCues(s, { fps: 30, expected: { id_0: { colour: 'red' }, id_9: { colour: 'blue' }, id_2: { colour: 'green' } }, cues: [{ cue: fakeCue, reader: fakeReader(s, 50) }] });
    ok(!r.ok && /id_9/.test(r.reason), 'an unknown identity: refused');
    r = await ic.resolveIdentityCues(s, { fps: 30, expected, cues: [] });
    ok(!r.ok && /no identity cue/.test(r.reason), 'no cue: refused');
    r = await ic.resolveIdentityCues(fakeSession(7, 10), { fps: 30, expected: Object.fromEntries(Array.from({ length: 7 }, (_, i) => ['id_' + i, { colour: 'red' }])), cues: [{ cue: fakeCue, reader: fakeReader(s, 50) }] });
    ok(!r.ok && /up to 6/.test(r.reason), 'more animals than the engine handles: refused');
    const learnFails = Object.assign({}, fakeCue, { learn: () => ({ ok: false, reason: 'found no tail marks' }) });
    const before = JSON.stringify([...s.instanceGroups.get(400)].map((g) => g.identityId));
    r = await ic.resolveIdentityCues(s, { fps: 30, expected, cues: [{ cue: learnFails, reader: fakeReader(s, 50) }] });
    ok(!r.ok && /no tail marks/.test(r.reason), 'a cue that cannot learn: its reason is the result');
    eq(JSON.stringify([...s.instanceGroups.get(400)].map((g) => g.identityId)), before, 'and nothing is relabelled');
}

// ---- the tail-band cue on drawn tails -------------------------------------------------
const W = 200, H = 60;
function floor() { return new Uint8Array(W * H).fill(12); }
function disk(img, x, y, r, v) { for (let j = Math.floor(y - r); j <= y + r; j++) for (let i = Math.floor(x - r); i <= x + r; i++) if (i >= 0 && j >= 0 && i < W && j < H && Math.hypot(i - x, j - y) <= r) img[j * W + i] = v; }
function drawnTail(nBands) {
    const img = floor();
    for (let s2 = 0; s2 <= 120; s2 += 0.5) {
        const f = s2 / 120; let dark = false;
        for (let b = 0; b < nBands; b++) { const c = 0.08 + b * 0.09; if (f >= c && f < c + 0.04) dark = true; }
        disk(img, 20 + s2, 30, 2.5, dark ? 14 : 90);
    }
    const r = tm.readTailProfile(img, W, H, [20, 30, 80, 30, 140, 30]);
    return tm.normalizeTailProfile(r.profile, r.background);
}
const tails = [0, 1, 2, 3].map(drawnTail);
eq(tails.map((x) => tm.countBands(x)), [0, 1, 2, 3], 'band counts on clean drawn tails');
{
    // four identities, as tracked, each showing its own number of bands in five cameras
    const ids = [10, 11, 12, 13], obs = [];
    for (let t = 0; t < 30; t++) obs.push(new Map(ids.map((id, i) => [id, [tails[i], tails[i], tails[i], tails[i], tails[i]]])));
    const cue = tm.createTailBandCue();
    // the user says id_0 has 3 bands, id_1 none, id_2 one, id_3 two (animals in that order)
    const expect = [3, 0, 1, 2];
    const learned = cue.learn(obs, null, (j) => expect[j], ids);
    ok(learned.ok, 'learns: ' + learned.reason);
    eq(learned.model.match, [1, 2, 3, 0], 'first pass: each tracked tail named by its bands and matched to the animal expecting them');
    const costs = cue.costs([tails[2], tails[2]], learned.model);
    eq([...costs.entries()].sort((a, b) => a[1] - b[1])[0][0], 2, 'two views of a two-band tail cost least as "2 bands"');
    const plain = cue.learn(obs.map(() => new Map(ids.map((id) => [id, [tails[0], tails[0]]]))), null, (j) => expect[j], ids);
    ok(!plain.ok && /no tail marks/.test(plain.reason), 'every tail plain: refused, ' + plain.reason);
    const one = cue.learn(obs, null, () => 1, ids);
    ok(!one.ok, 'every identity expected to show the same marks: refused');
}

{
    // features carrying two reads: the wide one decides, the sharp one counts. Here the "4 bands"
    // animal's wide read shows only 3 (as packed bands do), its sharp read 4.
    const t4 = drawnTail(4);
    eq(tm.countBands(t4), 4, 'four drawn bands count four');
    const ids = [20, 21, 22, 23], expect = [0, 1, 2, 4];
    const wide = [tails[0], tails[1], tails[2], tails[3]], sharp = [tails[0], tails[1], tails[2], t4];
    const both = [], wideOnly = [];
    for (let t = 0; t < 30; t++) {
        both.push(new Map(ids.map((id, i) => [id, [0, 1, 2].map(() => ({ wide: wide[i], sharp: sharp[i] }))])));
        wideOnly.push(new Map(ids.map((id, i) => [id, [wide[i], wide[i], wide[i]]])));
    }
    const cue = tm.createTailBandCue();
    const a = cue.learn(both, null, (j) => expect[j], ids), b = cue.learn(wideOnly, null, (j) => expect[j], ids);
    ok(a.ok && b.ok, 'both learn');
    eq(a.model.match, [0, 1, 2, 3], 'named by the sharp read: the tail reading 4 is the "4 bands" animal');
    ok(cue.check(a.model).ok, 'the check counts on the sharp read: ' + (cue.check(a.model).reason || 'ok'));
    ok(!cue.check(b.model).ok, 'with the wide read alone, the "4 bands" tail reads 3 and the check refuses');
    const ca = cue.costs(both[0].get(23), a.model), cb = cue.costs(wideOnly[0].get(23), b.model);
    eq([...ca.entries()], [...cb.entries()], 'costs come from the wide read alone');
    const relearned = cue.learn(both, both.map(() => new Map(ids.map((id, i) => [id, i]))), (j) => expect[j], ids);
    ok(relearned.ok && cue.check(relearned.model).ok, 'a later round keeps each class with its sharp template');
    ok(/4 → reads 4 band/.test(cue.describe(relearned.model)), 'described by the sharp read: ' + cue.describe(relearned.model));
}

console.log(`\ntest-identity-cues: ${passed} passed, ${failed} failed`);
if (failed) { failures.forEach((f) => console.error(' - ' + f)); process.exit(1); }
