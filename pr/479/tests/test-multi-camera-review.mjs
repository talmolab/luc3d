/**
 * test-multi-camera-review.mjs — pose/multi-camera-review.js, the review list multi-camera Track All leaves,
 * on synthetic sessions (InstanceGroup-shaped objects with 3D):
 *  - crossings: two animals whose 3D paths cross get a row there (pair, cue 'crossing', the run's first and last
 *    frame); animals far apart, or passing at a distance, get none; a run of near-ties within 3 s is one row;
 *  - the check rows: where every identity is first in view (unless a row's clip shows it) and at the end;
 *  - flat (3N) and boxed points3d read alike; groups without an identity or without 3D are left out;
 *  - pairEncounters3d: the pair's close encounters by 3D centroid distance (1.5 body lengths, the body = the
 *    median largest node-to-node distance), read from the current labels;
 *  - fewer than two identities: no list.
 *
 * Run:  node tests/test-multi-camera-review.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MR = await import(pathToFileURL(path.join(HERE, '..', 'pose', 'multi-camera-review.js')).href);

let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
function eq(a, e, m) { ok(a === e, `${m} (expected ${e}, got ${a})`); }
function group(n) { console.log('\n• ' + n); }

// a 4-node animal 200 long along x, centred at (x, y, z); flat Float64Array(12) or boxed [[x,y,z],...]
function pose(x, y, z, boxed) {
    const pts = [[x - 100, y, z], [x - 30, y, z], [x + 30, y, z], [x + 100, y, z]];
    return boxed ? pts : Float64Array.from(pts.flat());
}
/** session from per-frame lists of [identityId, x, y, z] (z omitted = 0) */
function session(frames, opts = {}) {
    const ig = new Map();
    frames.forEach((list, f) => {
        if (!list || !list.length) return;
        ig.set(f, list.map(([id, x, y, z]) => ({ identityId: id, points3d: x == null ? null : pose(x, y, z || 0, opts.boxed) })));
    });
    return { instanceGroups: ig, fps: 30 };
}
// two animals walking towards each other along x (8 a frame each) and through the same point at frame `at`
// (`gapY` apart in y)
function crossing(N, at, gapY = 0) {
    const out = [];
    for (let f = 0; f < N; f++) { const d = (f - at) * 8; out.push([[0, 1000 - d, 0], [1, 1000 + d, gapY]]); }
    return out;
}

group('a crossing gets a row; animals apart get none');
{
    const fr = crossing(900, 450);
    const rows = MR.multiCameraReview(session(fr), 30);
    const cr = rows.filter(r => r.cues.includes('crossing'));
    eq(cr.length, 1, 'one crossing row');
    ok(cr[0] && cr[0].identityA === 0 && cr[0].identityB === 1, 'between identities 0 and 1');
    ok(cr[0] && cr[0].startFrame <= 450 && cr[0].frame >= 450 && cr[0].frame - cr[0].startFrame < 30,
        `it spans the crossing (frames ${cr[0] && cr[0].startFrame}–${cr[0] && cr[0].frame})`);
    // the same walk 600 apart in y never nearly crosses, nor 20 apart (half a stride's worth more than the steps)
    const apart = MR.multiCameraReview(session(crossing(900, 450, 600)), 30);
    eq(apart.filter(r => r.cues.includes('crossing')).length, 0, 'passing 3 body lengths apart: no crossing row');
    eq(MR.multiCameraReview(session(crossing(900, 450, 20)), 30).filter(r => r.cues.includes('crossing')).length, 0,
        'passing 20 apart at 8 a frame: no crossing row (the swapped pairing costs clearly more)');
    // the margin: kept vs swapped pairing by centroid distance
    const near = MR.crossingCandidates(MR.identityTrack(session(fr)), { margin: 0.01 });
    ok(near.length > 0 && near.every(c => Math.abs(c.f - 450) <= 2), `near-ties only at the crossing itself (${near.map(c => c.f)})`);
    eq(MR.MULTI_CAMERA_REVIEW_DEFAULTS.margin, 0.01, 'default margin 0.01');
    eq(MR.MULTI_CAMERA_REVIEW_DEFAULTS.clusterSeconds, 3, 'clusters of 3 s');
}

group('near-ties within 3 s are one row; further apart, two');
{
    const N = 1200, fr = [];
    // they cross at 300 and back at 360 (2 s): one row; and again at 900 (20 s later): another
    for (let f = 0; f < N; f++) {
        const x = f < 330 ? (f - 300) * 8 : f < 600 ? (360 - f) * 8 : (f - 900) * 8;
        fr.push([[0, 1000 - x, 0], [1, 1000 + x, 0]]);
    }
    const cr = MR.multiCameraReview(session(fr), 30).filter(r => r.cues.includes('crossing'));
    eq(cr.length, 2, `two rows (${cr.map(r => r.startFrame + '–' + r.frame).join(', ')})`);
    ok(cr[0].startFrame <= 300 && cr[0].frame >= 360, 'the first spans both near-ties 2 s apart');
}

group('check rows: every identity first in view, and the end');
{
    // identity 1 arrives at frame 300; apart throughout (no crossing)
    const fr = [];
    for (let f = 0; f < 3000; f++) fr.push(f < 300 ? [[0, 0, 0]] : [[0, 0, 0], [1, 2000, 0]]);
    const rows = MR.multiCameraReview(session(fr), 30);
    const st = rows.find(r => r.cues.includes('videoStart')), en = rows.find(r => r.cues.includes('videoEnd'));
    ok(st && st.frame === 300 && st.identityA === 0 && st.identityB === 1, `a start row where both are first in view (${JSON.stringify(st)})`);
    ok(en && en.frame === 2999, `an end row at the last tracked frame (${JSON.stringify(en)})`);
    ok(rows.every((r, i) => !i || rows[i - 1].frame <= r.frame), 'rows sorted by frame');
    // a crossing 1 s after both are in view: its clip shows that frame, so no start row
    const fr2 = crossing(3000, 330).map((l, f) => f < 300 ? [l[0]] : l);
    const rows2 = MR.multiCameraReview(session(fr2), 30);
    ok(!rows2.some(r => r.cues.includes('videoStart')) && rows2.some(r => r.cues.includes('crossing')),
        'a crossing whose clip (2 s before to 5 s after) shows that frame: no start row');
    // a crossing within 5 s of the end: no end row
    const rows3 = MR.multiCameraReview(session(crossing(900, 880)), 30);
    ok(!rows3.some(r => r.cues.includes('videoEnd')), 'a row ending within 5 s of the last frame: no end row');
}

group('what is read');
{
    const fr = crossing(900, 450);
    const a = MR.multiCameraReview(session(fr), 30), b = MR.multiCameraReview(session(fr, { boxed: true }), 30);
    eq(JSON.stringify(b), JSON.stringify(a), 'boxed points3d give the same rows as flat');
    // groups without an identity or without 3D: left out of the crossings (an identity with no 3D still counts as in view)
    const fr2 = fr.map((l, f) => f >= 440 && f <= 460 ? [l[0], [1]] : l.concat([[-1, 1000, 10]]));
    const c2 = MR.multiCameraReview(session(fr2), 30);
    eq(c2.filter(r => r.cues.includes('crossing')).length, 0, 'no 3D at the crossing: no crossing row (nothing to compare)');
    eq(MR.identityTrack(session(fr2)).out[0].length, 2, 'a group with identity -1 is left out');
    eq(MR.multiCameraReview(session(fr.map(l => [l[0]])), 30).length, 0, 'one identity: no list');
    eq(MR.multiCameraReview({ instanceGroups: new Map() }, 30).length, 0, 'no groups: no list');
}

group('pairEncounters3d');
{
    const s = session(crossing(900, 450));
    eq(MR.sessionBodyLength3d(s), 200, 'body length: the median largest node-to-node distance (200)');
    const enc = MR.pairEncounters3d(s, 0, 1, 0, 899, { fps: 30 });
    // closer than 1.5 × 200 = 300: |2·(f − 450)·8| < 300 → |f − 450| < 18.75
    ok(enc.length === 1 && enc[0].start === 432 && enc[0].end === 468, `one encounter, frames 432–468 (${JSON.stringify(enc)})`);
    eq(MR.pairEncounters3d(s, 0, 1, 0, 400, { fps: 30 }).length, 0, 'none before it');
    eq(MR.pairEncounters3d(s, 0, 2, 0, 899, { fps: 30 }).length, 0, 'an identity not in the session: none');
    // read from the current labels: swap the identities on the encounter's second half
    s.instanceGroups.forEach((gs, f) => { if (f >= 450) gs.forEach(g => { g.identityId = 1 - g.identityId; }); });
    const enc2 = MR.pairEncounters3d(s, 0, 1, 0, 899, { fps: 30 });
    ok(enc2.length === 1 && enc2[0].start === 432 && enc2[0].end === 468, 'a swap of both labels changes nothing (same pair)');
    eq(MR.pairEncounters3d({ instanceGroups: new Map() }, 0, 1, 0, 10).length, 0, 'no groups: none');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => ' - ' + f).join('\n')); process.exit(1); }
