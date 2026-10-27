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
 *  6. `singleCameraCheckOptions`: on one camera every check ignores encounters
 *     scoring exactly 0 (no samples) when finding runs — on a real video's own
 *     scores, a swap running from the session start is fixed from frame 0, not
 *     from the pair's first encounter that had evidence.
 *  7. `clearestEndLeads`: after an early swap, other pairs of a swapped animal
 *     "read right again" a second or two BEFORE the swapped pair; the clearest
 *     'end' row of such a group leads it (a real video's four 'end' rows).
 *  8. Duplicate removal (opt-in): a detection is a duplicate only when box IoU
 *     AND OKS both pass (touching animals, a reversed pose and a few exact nodes
 *     are each kept by one of the two); user instances are never removed; and a
 *     lone animal that hops onto the tracks of SLEAP's copies of it without
 *     removal keeps one track with it, its partner entering on the other.
 *  9. The review list: a handover is a LONE animal whose track changes in
 *     place (not two animals exchanging in contact, not a track appearing far
 *     away); Track All's `review` rows add handovers to the candidate moments
 *     while the checks' `moments` keep none; the lone animal's hops are on the
 *     list; a review row Fixes from the frame you are on to the end of the
 *     video; and the rows survive the .slp checklist round trip.
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

group('2b. The stand-in with a pixel camera (the Track All summary\'s identity gallery)');
{
    const v = SCT.singleCameraCheckSession(s, { pixelCamera: true });
    const cam = v.cameras[0], g = v.instanceGroups.get(10)[0];
    eq(v.cameras.length + ':' + cam.name, '1:' + CAM, 'one camera, the session\'s');
    const P = Array.from(g.points3d.subarray(0, 3)), uv = cam.project(P);
    ok(uv[0] === P[0] && uv[1] === P[1] && P[2] === 0, `it projects a stand-in point (x, y, 0) back to its pixel (${uv.map(x => x.toFixed(1))})`);
    eq(cam.size, null, 'and claims no image size (Load SLP\'s stand-in reports 640x480 whatever the video)');
    ok(SCT.singleCameraCheckSession(s).cameras === s.cameras, 'without the option: the session\'s own camera, as before');
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

group('6. On one camera, an encounter with no samples is no evidence');
{
    eq(JSON.stringify(SCT.singleCameraCheckOptions('brightness')), '{"skipEmpty":true,"clearestEndLeads":true}', 'brightness: empty encounters skipped, the clearest end leads');
    eq(JSON.stringify(SCT.singleCameraCheckOptions('size')), '{"skipEmpty":true,"clearestEndLeads":true}', 'size: empty encounters skipped, the clearest end leads');
    // 10072022143153-mid, id_0 / id_2: swapped from 0:00 to 2:16.7, but the pair's first encounter (0:03.9) had no samples
    const scores = [0, -46, -64, 0, -1, -11, 12, 41];
    const enc = () => scores.map((score, i) => ({ frame: 100 * (i + 1), startFrame: 100 * (i + 1) - 10, identityA: 0, identityB: 2,
                                                  nameA: 'id_0', nameB: 'id_2', score }));
    const O = { threshold: -25, continueBelow: 25, followSeconds: 60, fps: 30 };
    let sc = enc(), ch = CHK.markChangePoints(sc, O);
    let rows = sc.filter(x => x.flagged && !x.continues).concat(ch);
    ok(rows.length === 2 && ch[0].switchedAt === 200, `without: the empty first encounter reads as "right", so the stretch starts at 200 (${JSON.stringify(rows.map(x => [x.frame, x.kind, x.switchedAt]))})`);
    sc = enc(); ch = CHK.markChangePoints(sc, Object.assign({}, O, SCT.singleCameraCheckOptions('brightness')));
    rows = sc.filter(x => x.flagged && !x.continues).concat(ch);
    ok(rows.length === 1 && rows[0].kind === 'end' && rows[0].frame === 800 && rows[0].switchedAt === null,
        `with: one 'end' row at 800, the stretch from the session start (${JSON.stringify(rows.map(x => [x.frame, x.kind, x.switchedAt]))})`);
    ok(sc[0].flagged && sc[0].continues && sc[3].flagged && sc[3].continues, '…and the empty encounters inside the stretch are its repeats');
    sc = enc(); CHK.markChangePoints(sc, Object.assign({}, O, { skipEmpty: false }));
    ok(sc[1].kind === 'onset', 'the default (several cameras) is unchanged: the empty encounter still counts');
}

group('7. On one camera, the clearest of a group of nearby \'end\' rows leads it');
{
    // 10072022145420-back: tracks 2 and 3 swapped at 0:14.8, early, so the swapped labelling is the majority and
    // every pair of a swapped animal reads right again after it — the real pair (2,3) with +444 at 0:16.9, its
    // echoes (1,3) +69 at 0:13.5, (0,3) +37 at 0:14.6 and (1,2) +36 at 0:18.5 (windows running past the swap)
    const ENDS = [[1, 3, 405, 69], [0, 3, 438, 37], [2, 3, 507, 444], [1, 2, 555, 36]];
    const enc = () => ENDS.flatMap(([a, b, f, sc]) => [
        { frame: 100, startFrame: 90, identityA: a, identityB: b, nameA: 'id_' + a, nameB: 'id_' + b, score: -80 },
        { frame: f, startFrame: f - 10, identityA: a, identityB: b, nameA: 'id_' + a, nameB: 'id_' + b, score: sc }]).sort((x, y) => x.frame - y.frame);
    const O = { threshold: -25, continueBelow: 25, followSeconds: 60, fps: 30 };
    const lead = ch => ch.filter(x => x.followOf == null).map(x => x.nameA + '/' + x.nameB + '@' + x.frame).join(', ');
    let ch = CHK.markChangePoints(enc(), O);
    ok(ch.length === 4 && lead(ch) === 'id_1/id_3@405', `in time order the first echo leads (${lead(ch)})`);
    ch = CHK.markChangePoints(enc(), Object.assign({}, O, SCT.singleCameraCheckOptions('brightness')));
    ok(lead(ch) === 'id_2/id_3@507' && ch.filter(x => x.followOf === 507).length === 3,
        `with clearestEndLeads the swapped pair's row (+444) leads and the three echoes follow it (${lead(ch)})`);
}

group('8. Duplicate removal (opt-in): box IoU AND OKS, before the tracker');
{
    const P = pts => Float64Array.from(pts.flatMap(p => p ? p : [NaN, NaN]));
    const at = (cx, cy, k = 1, h = 0) => NODES.map(n => { const [x, y] = T[n], c = Math.cos(h), si = Math.sin(h); return [cx + k * (c * x - si * y), cy + k * (si * x + c * y)]; });
    const det = (pts, score, isUser = false) => ({ points: P(pts), score, isUser });
    const A = at(300, 200);
    const partial = A.map((p, j) => j % 3 === 0 ? null : [p[0] + 2, p[1] - 1]);           // a copy with 10 of 15 nodes, 2 px off
    eq(JSON.stringify(SCT.duplicateDetections([det(A, 0.9), det(partial, 0.7)])), '[1]', 'a partial copy of a stronger detection is a duplicate');
    eq(JSON.stringify(SCT.duplicateDetections([det(partial, 0.95), det(A, 0.9)])), '[1]', 'the WEAKER of the two goes, whichever comes first in the file');
    eq(JSON.stringify(SCT.duplicateDetections([det(A, 0.9), det(at(330, 210), 0.9)])), '[]',
        'two animals touching (boxes overlapping, keypoints 30 px apart) are not duplicates: OKS fails');
    eq(JSON.stringify(SCT.duplicateDetections([det(A, 0.9), det(at(300, 200, 1, Math.PI), 0.8)])), '[]',
        'the same box with the animal facing the other way is not a duplicate: OKS fails though the boxes match');
    const head = A.map((p, j) => ['Nose', 'Ear_R', 'Ear_L', 'Head'].includes(NODES[j]) ? p : null);
    eq(JSON.stringify(SCT.duplicateDetections([det(A, 0.9), det(head, 0.6)])), '[]',
        'a few nodes exactly on the animal (OKS 1) are not a duplicate when their box is a small part of its box: IoU fails');
    ok(SCT.duplicateOks(P(A), P(head), [Math.min(...A.map(p => p[0])), Math.min(...A.map(p => p[1])), Math.max(...A.map(p => p[0])), Math.max(...A.map(p => p[1]))], 0.1, 3) > 0.99,
        '…(their OKS alone would have called it one)');
    eq(JSON.stringify(SCT.duplicateDetections([det(A, 0.5, true), det(partial, 0.99)])), '[1]', 'a user instance is kept first, and its predicted copy goes');
    eq(JSON.stringify(SCT.duplicateDetections([det(partial, 0.99), det(A, 0.5, true)])), '[0]', '…in either order');
    eq(JSON.stringify(SCT.duplicateDetections([det(A, 0.9, true), det(partial, 0.7, true)])), '[]', 'a user instance is never removed');
    eq(JSON.stringify(SCT.duplicateDetections([det(A, NaN), det(partial, 0.3)])), '[0]', 'a detection with no score counts as the weakest');
    eq(JSON.stringify(SCT.duplicateDetections([det(A, 0.9), det(partial, 0.7)], { oks: 0.999 })), '[]', 'the thresholds are the caller\'s (OKS 0.999: kept)');

    // A lone animal and SLEAP's copies of it: on 12 frames before its partner enters, a weaker copy sits where the
    // (fast-moving) animal will be one frame later, so the animal moves onto the copy's track — and the partner,
    // when it enters, takes the animal's old one (the failure seen on a real two-mouse dataset).
    const N = 900, ENTER = 600, walk = f => [600 + 300 * Math.sin(f / 30), 240 + 40 * Math.sin(f / 50)];
    const lone = () => {
        const c = new PD.Camera(CAM, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [1280, 480]);
        const S = new PD.Session([c], new PD.Skeleton('mouse', NODES, []), ['t0', 't1'], 'lone'), dups = [];
        for (let f = 0; f < N; f++) {
            const [x, y] = walk(f);
            S.addUnlinkedInstance(f, CAM, new PD.Instance(at(x, y), 0, 'predicted', 0.9));
            if (f >= ENTER) S.addUnlinkedInstance(f, CAM, new PD.Instance(at(1150, 400 - 0.2 * (f - ENTER), 1, Math.PI), 1, 'predicted', 0.9));
            else if (f % 50 === 25) {
                const [nx, ny] = walk(f + 1), copy = new PD.Instance(at(nx, ny), null, 'predicted', 0.7);
                S.addUnlinkedInstance(f, CAM, copy); dups.push(copy);
            }
        }
        S.identities = []; S.frameIdentityMap = new Map();
        return { S, dups };
    };
    const cfg2 = SCT.singleCameraTrackerConfig(2, {});
    const tracksOfAnimal = S => { const t = new Set(); for (let f = 0; f < N; f++) t.add(S.frameGroups.get(f).getUnlinkedInstances(CAM)[0].instance.trackIdx); return t; };
    let L = lone();
    const plain = await SCT.trackSingleCamera(L.S, cfg2);
    ok(tracksOfAnimal(L.S).size > 1 && plain.duplicates === 0,
        `without removal the lone animal hops onto its copies' tracks (tracks ${[...tracksOfAnimal(L.S)]}) — the fixture reproduces the failure`);
    L = lone();
    const fixed = await SCT.trackSingleCamera(L.S, cfg2, { duplicates: {} });
    ok(tracksOfAnimal(L.S).size === 1, `with removal it keeps ONE track (${[...tracksOfAnimal(L.S)]})`);
    const partnerTracks = new Set(); for (let f = ENTER; f < N; f++) partnerTracks.add(L.S.frameGroups.get(f).getUnlinkedInstances(CAM)[1].instance.trackIdx);
    ok(partnerTracks.size === 1 && !partnerTracks.has([...tracksOfAnimal(L.S)][0]), '…and the partner enters on the other one');
    eq(fixed.duplicates, L.dups.length, `every copy removed (${fixed.duplicates})`);
    ok(L.dups.every(d => d.trackIdx === null && d.identityId == null), 'removed copies keep no track and no identity');
    let inSession = 0; for (let f = 0; f < ENTER; f++) for (const u of L.S.frameGroups.get(f).getUnlinkedInstances(CAM)) if (L.dups.includes(u.instance)) inSession++;
    ok(inSession === L.dups.length && fixed.untracked === 0,
        `…and stay in the session (${inSession}); untracked (${fixed.untracked}) counts only detections over the animal count`);
    L = lone();
    const off = await SCT.trackSingleCamera(L.S, cfg2, { duplicates: null });
    eq(off.duplicates, 0, 'duplicates: null is off');
}

group('9. The review list: handovers, rows, Fix plan, saved checklist');
{
    const RV = await imp('ui/id-switch-review.js');
    const P = pts => Float64Array.from(pts.flatMap(p => p));
    const at = (cx, cy) => NODES.map(n => [cx + T[n][0], cy + T[n][1]]);
    const fr = (f, dets) => ({ frameIdx: f, dets: dets.map(([x, y]) => ({ points: P(at(x, y)), score: 0.9, isUser: false })) });
    // (a) one animal, alone, standing still; its track changes 0 -> 1 at frame 30
    let frames = [], out = [];
    for (let f = 0; f < 60; f++) { frames.push(fr(f, [[300, 200]])); out.push([f < 30 ? 0 : 1]); }
    let h = SCT.handoverCandidates(frames, out, 30);
    ok(h.length >= 1 && h.every(c => c.cue === 'handover') && h[0].f === 30 && ((h[0].a === 1 && h[0].b === 0) || (h[0].a === 0 && h[0].b === 1)),
        `a lone animal whose track changes in place is a handover at that frame (${JSON.stringify(h[0])}, ${h.length} in the next 0.5 s)`);
    // (b) two animals in contact exchanging tracks: not alone, so no handover
    frames = []; out = [];
    for (let f = 0; f < 60; f++) { frames.push(fr(f, [[300, 200], [330, 205]])); out.push(f < 30 ? [0, 1] : [1, 0]); }
    eq(SCT.handoverCandidates(frames, out, 30).length, 0, 'two animals exchanging tracks in contact are not a handover (the checks score contacts)');
    // (c) one track appearing far from where the other was: no handover
    frames = []; out = [];
    for (let f = 0; f < 60; f++) { frames.push(fr(f, [f < 30 ? [100, 100] : [500, 400]])); out.push([f < 30 ? 0 : 1]); }
    eq(SCT.handoverCandidates(frames, out, 30).length, 0, 'a track appearing far from the last detection is not a handover');

    // The lone animal of §8 hopping onto its copies' tracks, without removal: the hops are on the review list.
    const N = 900, ENTER = 600, walk = f => [600 + 300 * Math.sin(f / 30), 240 + 40 * Math.sin(f / 50)];
    const at2 = (cx, cy, k = 1, hh = 0) => NODES.map(n => { const [x, y] = T[n], c = Math.cos(hh), si = Math.sin(hh); return [cx + k * (c * x - si * y), cy + k * (si * x + c * y)]; });
    const c = new PD.Camera(CAM, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [1280, 480]);
    const S = new PD.Session([c], new PD.Skeleton('mouse', NODES, []), ['t0', 't1'], 'lone');
    for (let f = 0; f < N; f++) {
        const [x, y] = walk(f);
        S.addUnlinkedInstance(f, CAM, new PD.Instance(at2(x, y), 0, 'predicted', 0.9));
        if (f >= ENTER) S.addUnlinkedInstance(f, CAM, new PD.Instance(at2(1150, 400 - 0.2 * (f - ENTER), 1, Math.PI), 1, 'predicted', 0.9));
        else if (f % 50 === 25) { const [nx, ny] = walk(f + 1); S.addUnlinkedInstance(f, CAM, new PD.Instance(at2(nx, ny), null, 'predicted', 0.7)); }
    }
    S.identities = []; S.frameIdentityMap = new Map();
    const res = await SCT.trackSingleCamera(S, SCT.singleCameraTrackerConfig(2, {}), { fps: 30 });
    const hops = []; let prev = null;
    for (let f = 0; f < ENTER; f++) { const t = S.frameGroups.get(f).getUnlinkedInstances(CAM)[0].instance.trackIdx; if (prev != null && t !== prev) hops.push(f); prev = t; }
    ok(hops.length > 0, `the fixture's lone animal changes track ${hops.length} times before its partner enters`);
    const onList = hops.filter(f => res.review.some(m => f >= m.startFrame - 30 && f <= m.frame + 30));
    eq(onList.length, hops.length, `every hop is within 1 s of a review row (${onList.length} of ${hops.length})`);
    ok(res.review.some(m => m.cues.includes('handover')), 'the review rows include handovers');
    ok(!res.moments.some(m => m.cues.includes('handover')), '…and the checks\' moments do not: they keep the candidates they were calibrated on');
    ok(res.moments.every(m => res.review.some(r => r.identityA === m.identityA && r.identityB === m.identityB && r.frame >= m.frame)),
        'every candidate moment is on the review list too');

    const rr = SCT.reviewResult(res.review, S, 30);
    ok(rr.ok && rr.cue === 'review' && rr.flags.length === res.review.length && rr.flags.every(m => m.kind === 'onset' && m.score === 0 &&
        m.switchBackAt === null && m.look.length > 0 && m.cue === 'review' && /^id_\d$/.test(m.nameA)),
        `reviewResult: one unscored onset row per review moment, named, with its cues (${rr.flags.length} rows)`);
    const m0 = rr.flags[0], s0 = m0.startFrame, e0 = m0.frame;
    let plan = RV.idSwitchFixPlan(m0, rr, { currentFrame: s0, totalFrames: N, window: [s0 - 60, e0 + 60] });
    ok(plan.from === s0 && plan.to === N - 1 && plan.start === 'current', `a review row Fixes from the frame you are on to the end (${plan.from}–${plan.to})`);
    // A review row's window reaches on to just before the next place: a swap that undoes itself in between is fixed
    // from that row twice (its own window here: 60 frames either side, as the tab's 2 s lead at 30 fps).
    const two = SCT.reviewResult([{ f: 110, s: 100, a: 0, b: 1, cues: ['handover'] }, { f: 305, s: 300, a: 0, b: 1, cues: ['tracklet'] }]
        .map(c => ({ frame: c.f, startFrame: c.s, identityA: c.a, identityB: c.b, cues: c.cues })), S, 30);
    const [p1, p2] = two.flags, win = m => [m.startFrame - 60, m.frame + 60];
    ok(two.flags.length === 2 && p1.frame === 110 && p2.startFrame === 300, 'a hand-made list of two places (frames 100–110 and 300–305)');
    plan = RV.idSwitchFixPlan(p1, two, { currentFrame: 299, totalFrames: N, window: win(p1) });
    ok(plan.from === 299 && plan.to === N - 1 && plan.start === 'current',
        `the first place Fixes from any frame up to just before the next one (${plan.from}), past its own window (to ${win(p1)[1]})`);
    plan = RV.idSwitchFixPlan(p1, two, { currentFrame: 300, totalFrames: N, window: win(p1) });
    ok(plan.from === 111 && plan.start === 'separate', `…and from the next place on, from just after itself (${plan.from})`);
    plan = RV.idSwitchFixPlan(p1, two, { currentFrame: 39, totalFrames: N, window: win(p1) });
    ok(plan.from === 111 && plan.start === 'separate', '…as from before its window');
    plan = RV.idSwitchFixPlan(p2, two, { currentFrame: N - 2, totalFrames: N, window: win(p2) });
    ok(plan.from === N - 2 && plan.start === 'current', 'the last place\'s window runs to the end of the video');
    const scored = { ...p1, cue: 'brightness' };
    plan = RV.idSwitchFixPlan(scored, { flags: [scored, { ...p2, cue: 'brightness' }], changes: [] }, { currentFrame: 299, totalFrames: N, window: win(p1) });
    ok(plan.start === 'separate', 'a check\'s row keeps its own window');

    // The saved checklist keeps the review rows, their cues and the ticks.
    S._idSwitch = { results: { review: rr }, reviewed: new Set([RV.idSwitchRowKey(m0)]), fixes: [] };
    RV.linkIdSwitchResults(S._idSwitch.results);
    const payload = JSON.parse(JSON.stringify(RV.serializeIdSwitchReview(S)));
    ok(payload && payload.checks.review && payload.checks.review.points.length === rr.flags.length && !('imageHz' in payload.checks.review),
        'the review rows are saved under checks.review, with no image fields');
    const S2 = { };
    RV.ingestIdSwitchReview(S2, payload);
    const back = S2._idSwitch && S2._idSwitch.results.review;
    ok(back && back.flags.length === rr.flags.length && back.flags.every((m, i) => m.cue === 'review' && m.score === 0 &&
        JSON.stringify(m.look) === JSON.stringify(rr.flags[i].look) && m.frame === rr.flags[i].frame), 'and come back from the file as they were');
    ok(S2._idSwitch.reviewed.has(RV.idSwitchRowKey(m0)), '…with their reviewed ticks');
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('\nFailures:\n - ' + failures.join('\n - ')); process.exit(1); }
