/**
 * test-single-camera-tracking.mjs — Track All and the ID-switch checks on a
 * single-camera session (pose/single-camera-tracking.js), on a synthetic Session.
 *
 * Three mouse-shaped animals of different size walk in one 640x480 view for
 * 75 s at 30 fps, starting on fragmented "SLEAP" tracklets (a new track every
 * few seconds), with a spurious fourth detection now and then and one frame
 * that has a user instance. Asserted:
 *  1. Track All writes the TRACKS (track_0..2, one per animal, each animal on
 *     one track throughout) and one identity per track through the map; the
 *     detection over the animal count and the predictions on the user frame are
 *     left trackless; the user instance is tracked.
 *  2. The check view: one stand-in group per identified detection, its 2D as
 *     (x, y, 0), the detection under `instances`; and the real size check runs
 *     on it and finds a planted swap (tracks exchanged after an encounter, for
 *     the last 30% of the session) as an onset — and nothing on the clean tracks.
 *  3. A fix swaps the TRACKS on the range (identity follows), and the same call
 *     undoes it; with identities edited apart from their tracks it falls back
 *     to the identity layer and says so.
 *  4. Not single-camera / lazy: null / a reason, never a partial result.
 *
 * Run:  node tests/test-single-camera-tracking.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const imp = p => import(pathToFileURL(path.join(ROOT, p)).href);
const PD = await imp('pose/pose-data.js');
const SCT = await imp('pose/single-camera-tracking.js');
const CHK = await imp('pose/id-switch-check.js');

let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
function eq(a, e, m) { ok(a === e, `${m} (expected ${e}, got ${a})`); }
function group(n) { console.log('\n• ' + n); }

const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
    'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
const T = { Nose: [45, 0], Ear_R: [25, -11], Ear_L: [25, 11], Head: [30, 0], Neck: [20, 0], Trunk: [-5, 0], TTI: [-40, 0],
    Shoulder_left: [10, 12], Shoulder_right: [10, -12], Haunch_left: [-25, 15], Haunch_right: [-25, -15],
    Tail_0: [-65, 0], Tail_1: [-88, 0], Tail_2: [-110, 0], TailTip: [-132, 0] };
const FPS = 30, FRAMES = 75 * FPS, SIZES = [0.5, 0.8, 1.0];   // px per template mm
const CAM = 'cam0';
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

// Where animal a is at frame f: 0 and 1 meet every 10 s near the middle (frames 150, 450, … 1950), 2 keeps to itself.
function pose(a, f) {
    const t = f / FPS, phase = (t % 10) / 10;
    let cx, cy;
    if (a === 2) { cx = 520 + 40 * Math.sin(t / 3); cy = 380 + 30 * Math.cos(t / 4); }
    else {
        const d = 140 * Math.abs(Math.cos(Math.PI * phase));     // 140 px apart, 0 at the half-way point
        cx = 280 + (a === 0 ? -d : d); cy = 200 + 20 * Math.sin(t + a);
    }
    const h = a === 2 ? t / 2 : (a === 0 ? 0 : Math.PI) + 0.3 * Math.sin(t), c = Math.cos(h), s = Math.sin(h);
    return NODES.map(n => { const [x, y] = T[n]; const X = x * SIZES[a], Y = y * SIZES[a]; return [cx + c * X - s * Y + (rnd() - 0.5), cy + s * X + c * Y + (rnd() - 0.5)]; });
}

function build() {
    const cam = new PD.Camera(CAM, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
    const tracks = []; for (let i = 0; i < 60; i++) tracks.push('track_' + i);
    const s = new PD.Session([cam], new PD.Skeleton('mouse', NODES, []), tracks, 'single');
    for (let f = 0; f < FRAMES; f++) {
        const frag = Math.floor(f / 120);                     // a new "SLEAP" tracklet every 4 s
        for (let a = 0; a < 3; a++) {
            const type = (f === 900 && a === 1) ? 'user' : 'predicted';
            // the input's own tracker crosses animals 0 and 1 at frame 1000 (far apart), until its tracklets break at 1080
            const inTrack = f >= 1000 && f < 1080 && a < 2 ? (3 * frag + (1 - a)) % 60 : (3 * frag + a) % 60;
            s.addUnlinkedInstance(f, CAM, new PD.Instance(pose(a, f), inTrack, type, 0.9));
        }
        if (f % 211 === 7) s.addUnlinkedInstance(f, CAM, new PD.Instance(pose(2, f).map(([x, y]) => [x - 300, y - 250]), null, 'predicted', 0.2));
    }
    return s;
}
const instancesAt = (s, f) => s.frameGroups.get(f).getUnlinkedInstances(CAM).map(u => u.instance);
const animalOf = (s, f, q) => q;   // instances are added animal 0, 1, 2 (then the spurious one) on every frame
const cfg = SCT.singleCameraTrackerConfig(3, { windowSize: 5, oksStddev: 0.1, connectBreaks: true });

group('1. Track All writes one track per animal, and one identity per track');
const s = build();
eq(SCT.singleCameraName(s), CAM, 'a one-camera session is single-camera');
s.identities = []; s.frameIdentityMap = new Map();
const res = await SCT.trackSingleCamera(s, cfg);
eq(res.numIdentities, 3, 'three identities');
eq(JSON.stringify(s.tracks), JSON.stringify(['track_0', 'track_1', 'track_2']), 'session.tracks replaced by track_0..2 (sleap-nn names)');
eq(s.identities.map(i => i.id + ':' + i.name).join(','), '0:id_0,1:id_1,2:id_2', 'identity k <-> track k');
{
    const trackOfAnimal = [new Set(), new Set(), new Set()];
    let bad = 0, mapBad = 0;
    for (let f = 0; f < FRAMES; f++) {
        const L = instancesAt(s, f), seen = new Set();
        for (let q = 0; q < 3; q++) {
            const inst = L[q];
            if (f === 900 && q !== 1) { if (inst.trackIdx !== null) bad++; continue; }   // predictions on the user frame
            trackOfAnimal[animalOf(s, f, q)].add(inst.trackIdx);
            if (seen.has(inst.trackIdx)) bad++; seen.add(inst.trackIdx);
            if (s.getIdentityIdForUnlinkedInstance(CAM, inst, f) !== inst.trackIdx) mapBad++;
        }
        if (L.length === 4 && L[3].trackIdx !== null) bad++;
    }
    eq(bad, 0, 'one track per animal per frame; the spurious 4th detection and the user frame\'s predictions are trackless');
    eq(mapBad, 0, 'every tracked detection\'s identity is its track\'s');
    ok(trackOfAnimal.every(t => t.size === 1) && new Set(trackOfAnimal.map(t => [...t][0])).size === 3,
        'each animal keeps one track for all 75 s, across the 18 tracklet breaks of the input: ' + trackOfAnimal.map(t => [...t].join('/')).join(', '));
    eq(instancesAt(s, 900)[1].trackIdx, trackOfAnimal[1].values().next().value, 'the user instance is tracked, on its animal\'s track');
    ok(res.untracked >= Math.floor(FRAMES / 211) + 2, `untracked counted (${res.untracked})`);
}

group('1b. Where to look: candidate moments from the tracking');
{
    const t0 = instancesAt(s, 0)[0].trackIdx, t1 = instancesAt(s, 0)[1].trackIdx, t2 = instancesAt(s, 0)[2].trackIdx;
    const pair = (m, x, y) => (m.identityA === Math.min(x, y) && m.identityB === Math.max(x, y));
    const tl = res.moments.filter(m => m.cues.includes('tracklet'));
    ok(tl.some(m => pair(m, t0, t1) && m.frame === 1000),
        'the input tracklet crossing animals 0 and 1 at frame 1000 is a moment for their two identities: ' + JSON.stringify(tl.map(m => [m.frame, m.cues.join('+')])));
    ok(tl.every(m => m.frame === 1000 || m.frame === 1080), 'no other tracklet moment (its tracklets end at 1080, where the crossing undoes)');
    eq(res.moments.filter(m => m.cues.includes('ambiguity')).length, 0,
        'no ambiguity moment where poses never look alike (different sizes, meeting head to head)');
    ok(!res.moments.some(m => pair(m, t0, t2) || pair(m, t1, t2)), 'nothing for the animal that keeps to itself');

    // Two animals of the SAME size walking side by side, merging for a moment every 8 s: there the
    // tracker cannot tell them apart, and those are the ambiguity moments.
    const cam = new PD.Camera(CAM, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
    const twins = new PD.Session([cam], new PD.Skeleton('mouse', NODES, []), ['t'], 'twins');
    const MERGES = [120, 360, 600, 840];
    for (let f = 0; f < 960; f++) {
        const gap = Math.min(...MERGES.map(m => Math.abs(f - m))), dy = Math.min(90, 3 * gap);   // 0 at a merge
        for (let a = 0; a < 2; a++) {
            const cx = 100 + 0.45 * f, cy = 240 + (a ? dy / 2 : -dy / 2);
            twins.addUnlinkedInstance(f, CAM, new PD.Instance(NODES.map(n => [cx + 0.7 * T[n][0] + (rnd() - 0.5), cy + 0.7 * T[n][1] + (rnd() - 0.5)]), null, 'predicted', 0.9));
        }
    }
    twins.identities = []; twins.frameIdentityMap = new Map();
    const tw = await SCT.trackSingleCamera(twins, SCT.singleCameraTrackerConfig(2, {}), { fps: FPS });
    const amb = tw.moments.filter(m => m.cues.includes('ambiguity'));
    ok(amb.length >= 3 && amb.every(m => MERGES.some(c => m.startFrame <= c + 15 && m.frame >= c - 15)),
        `ambiguity moments at the merges (${amb.map(m => m.startFrame + '-' + m.frame).join(', ')})`);
    eq(tw.moments.filter(m => m.cues.includes('tracklet')).length, 0, 'no tracklet moments when the input has no tracks');
    ok(tw.moments.every((m, i) => i === 0 || m.frame >= tw.moments[i - 1].frame), 'moments come sorted by frame');
}

group('2. The check view, and the size check on it');
{
    const v = SCT.singleCameraCheckSession(s);
    let n = 0, z0 = true, inst = true;
    for (const L of v.instanceGroups.values()) for (const g of L) {
        n++;
        if (g.points3d.length !== 3 * NODES.length || g.points3d[2] !== 0) z0 = false;
        if (!(g.instances.get(CAM) instanceof PD.Instance)) inst = false;
    }
    eq(n, res.tracked, 'one stand-in group per identified detection');
    ok(z0 && inst, 'points3d = (x, y, 0) per node; the detection is under instances');
    const clean = await CHK.checkSizeSwitches(v, { fps: FPS });
    ok(clean.ok && clean.encounters.length >= 4, `size check runs on 2D (${clean.ok ? clean.encounters.length + ' encounters' : clean.reason})`);
    eq(clean.flags.length + clean.changes.length, 0, 'clean tracks: nothing flagged');
    // plant a tracker swap: animals 0 and 1 exchange tracks after their encounter at 55 s (frame 1650) — the
    // swapped stretch must be the MINORITY, since the check learns from whichever labelling covers more
    const t0 = instancesAt(s, 0)[0].trackIdx, t1 = instancesAt(s, 0)[1].trackIdx;
    const s2 = build(); s2.identities = []; s2.frameIdentityMap = new Map();
    await SCT.trackSingleCamera(s2, cfg);
    for (let f = 1655; f < FRAMES; f++) for (const i of instancesAt(s2, f)) {
        if (i.trackIdx === t0) i.trackIdx = t1; else if (i.trackIdx === t1) i.trackIdx = t0;
    }
    const sw = await CHK.checkSizeSwitches(SCT.singleCameraCheckSession(s2), { fps: FPS });
    const onsets = sw.flags.filter(x => x.kind === 'onset');
    ok(onsets.length === 1 && Math.abs(onsets[0].frame - 1650) < 60,
        `the planted swap is found as an onset at its encounter (${onsets.map(o => o.frame).join(',') || 'none'})`);
}

group('3. A fix swaps the TRACKS; the same call undoes it; else the identity layer');
{
    const before = []; for (let f = 0; f < FRAMES; f++) before.push(instancesAt(s, f).map(i => i.trackIdx));
    const r = SCT.swapSingleCameraIdentities(s, 300, 599, 0, 1);
    eq(r.tracks, true, 'tracks swapped');
    eq(r.frames, 300, 'on every frame of the range');
    let inside = true, outside = true, idFollows = true;
    for (let f = 0; f < FRAMES; f++) instancesAt(s, f).forEach((i, q) => {
        const b = before[f][q], inRange = f >= 300 && f <= 599;
        const want = inRange && (b === 0 || b === 1) ? 1 - b : b;
        if (i.trackIdx !== want) { if (inRange) inside = false; else outside = false; }
        if (i.trackIdx != null && s.getIdentityIdForUnlinkedInstance(CAM, i, f) !== i.trackIdx) idFollows = false;
    });
    ok(inside && outside, 'tracks 0 and 1 exchanged inside the range only');
    ok(idFollows, 'identity follows the track');
    SCT.swapSingleCameraIdentities(s, 300, 599, 0, 1);
    let restored = true;
    for (let f = 0; f < FRAMES; f++) instancesAt(s, f).forEach((i, q) => { if (i.trackIdx !== before[f][q]) restored = false; });
    ok(restored, 'the same call undoes it');
    // edit identity 0 apart from its track on one frame: the swap must not guess
    const i0 = instancesAt(s, 450).find(i => i.trackIdx === 0);
    s.setFrameIdentity(450, CAM, 0, 2);
    const r2 = SCT.swapSingleCameraIdentities(s, 300, 599, 0, 1);
    eq(r2.tracks, false, 'identities edited apart from tracks: falls back to the identity layer');
    eq(i0.trackIdx, 0, '…and leaves the tracks alone');
}

group('4. Not single-camera, or lazy');
{
    const two = new PD.Session([new PD.Camera('a', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]),
        new PD.Camera('b', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10])], new PD.Skeleton('m', NODES, []), [], 'two');
    eq(SCT.singleCameraName(two), null, 'two cameras: not single-camera');
    eq(SCT.singleCameraCheckSession(two), null, '…and the checks read the session itself');
    eq(SCT.swapSingleCameraIdentities(two, 0, 10, 0, 1), null, '…and a fix swaps identities as before');
    const lazy = build(); lazy.lazyLoader = { isSync: true };
    let msg = '';
    try { await SCT.trackSingleCamera(lazy, cfg); } catch (e) { msg = e.message; }
    eq(msg, SCT.SINGLE_CAMERA_LAZY_REASON, 'a lazy project is refused, not tracked from its resident window');
    eq(SCT.singleCameraCheckSession(lazy).fail, SCT.SINGLE_CAMERA_LAZY_REASON, '…and the checks say why');
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
