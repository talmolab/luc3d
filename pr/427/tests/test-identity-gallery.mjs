/**
 * test-identity-gallery.mjs — the planning half of the Track All summary's
 * Identities section (ui/identity-gallery.js): each identity's tracked frames
 * and centroids, which frames to sample (spread over its span, each the most
 * isolated in its slot), which camera to cut each sample from (largest view,
 * different cameras where it can), the crop square, the projected path with its
 * breaks, the default map camera, and the time colour ramp. The drawing half is
 * covered by tests/e2e/identity-gallery.mjs.
 *
 * Run:  node tests/test-identity-gallery.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const imp = (f) => import(pathToFileURL(path.join(HERE, '..', f)).href);
globalThis.window = globalThis;
const G = await imp('ui/identity-gallery.js');
const { InstanceGroup, Instance, lazyPlaceholderXY } = await imp('pose/pose-data.js');

let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
function eq(a, e, m) { ok(JSON.stringify(a) === JSON.stringify(e), `${m} (expected ${JSON.stringify(e)}, got ${JSON.stringify(a)})`); }
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// A group for identity `id` whose 3 keypoints sit around (x, y, z), with 2D members in `cams`.
function group(id, x, y, z, cams = ['top'], spread = 10) {
    const g = new InstanceGroup(id * 1000 + Math.round(x), id);
    g.points3d = new Float64Array([x - spread, y, z, x + spread, y, z, x, y + spread, z]);
    cams.forEach(c => g.instances.set(c, new Instance([[x, y], [x + 5, y], [x, y + 5]], 0, 'predicted', 1)));
    return g;
}
function session(byFrame) {
    return { instanceGroups: new Map(byFrame), identities: [], cameras: [] };
}
// A pinhole camera looking down +z from the origin: u = f x / z + cx.
function camera(name, f, w = 640, h = 480, ox = 0) {
    return { name, size: [w, h], project: (p) => [f * (p[0] - ox) / p[2] + w / 2, f * p[1] / p[2] + h / 2], distortPoint: (q) => q };
}

console.log('1. groupCentroid');
{
    eq(G.groupCentroid(new Float64Array([0, 0, 0, 2, 4, 6])), [1, 2, 3], 'flat Float64Array(3N)');
    eq(G.groupCentroid([[0, 0, 0], null, [2, 4, 6]]), [1, 2, 3], 'boxed rows, a null row skipped');
    eq(G.groupCentroid(new Float64Array([NaN, 0, 0, 2, 4, 6])), [2, 4, 6], 'a keypoint with a NaN coordinate skipped');
    ok(G.groupCentroid(null) === null && G.groupCentroid(new Float64Array([NaN, NaN, NaN])) === null, 'nothing finite: null');
}

console.log('2. identityTracks');
{
    const s = session([
        [20, [group(0, 20, 0, 100), group(1, 0, 0, 100)]],
        [10, [group(0, 10, 0, 100)]],                                  // inserted out of order
        [30, [group(0, 30, 0, 100), group(0, 31, 0, 100), group(1, 5, 0, 100)]],   // identity 0 twice: ambiguous
        [40, [Object.assign(group(1, 7, 0, 100), { points3d: null }), group(-1, 0, 0, 100)]],   // no 3D; unidentified
    ]);
    const t = G.identityTracks(s);
    eq(Array.from(t.get(0).frames), [10, 20], 'identity 0: frames in order, the ambiguous frame left out');
    ok(close(t.get(0).xyz[0], 10) && close(t.get(0).xyz[3], 20), '…with each frame\'s centroid');
    eq(Array.from(t.get(1).frames), [20, 30], 'identity 1: a group with no 3D left out');
    ok(!t.has(-1), 'an unidentified group (-1) is no identity');
    eq(G.identityTracks(null).size, 0, 'no session: empty');
}

console.log('3. pickSampleFrames');
{
    // identity 0 tracked on frames 0..999; identity 1 sits ON it at every slot middle (frames 100, 300, ...)
    // and far away elsewhere — so each sample must move off the middle to an isolated frame
    const by = [];
    for (let f = 0; f < 1000; f++) {
        const gs = [group(0, 0, 0, 100)];
        const mid = (f % 200) === 100;
        gs.push(group(1, mid ? 1 : (f % 200 < 100 ? 500 : 50), 0, 100));
        by.push([f, gs]);
    }
    const s = session(by), t = G.identityTracks(s);
    const fr = G.pickSampleFrames(s, t.get(0), 0, 5);
    eq(fr.length, 5, 'five samples');
    ok(fr.every((f, i) => f >= 200 * i && f < 200 * (i + 1)), `one per fifth of the span: ${fr}`);
    // candidates are scored every 5th frame here (200 per slot / 40), so "nearest" is within 5
    ok(fr.every(f => (f % 200) !== 100 && Math.abs((f % 200) - 100) <= 5), `each moved off the huddle at its slot's middle, to the nearest isolated frame: ${fr}`);
    ok(fr.every((f, i) => i === 0 || f > fr[i - 1]), 'ascending and distinct');
    // always apart, by a distance that grows across each slot: still the slot's middle, not its edge
    const apart = session(Array.from({ length: 1000 }, (_, f) => [f, [group(0, 0, 0, 100), group(1, 200 + (f % 200), 0, 100)]]));
    const tp = G.identityTracks(apart);
    eq(G.pickSampleFrames(apart, tp.get(0), 0, 5, { maxCandidates: 1000 }), [100, 300, 499, 699, 899],
        'apart throughout: the middle of each slot, wherever isolation peaks');
    // all equally isolated: the frame nearest each slot's middle
    const alone = session(Array.from({ length: 1000 }, (_, f) => [f, [group(0, 0, 0, 100)]]));
    const ta = G.identityTracks(alone);
    const mids = G.pickSampleFrames(alone, ta.get(0), 0, 5, { maxCandidates: 1000 });
    // the span is frames 0..999: slot middles 99.9, 299.7, 499.5, 699.3, 899.1 (a tie keeps the earlier)
    eq(mids, [100, 300, 499, 699, 899], 'alone everywhere: the frame nearest each slot\'s middle');
    eq(G.pickSampleFrames(alone, { frames: new Int32Array([3, 9]), xyz: new Float64Array(6) }, 0, 5), [3, 9], 'fewer frames than samples: all of them');
    eq(G.pickSampleFrames(alone, { frames: new Int32Array(0), xyz: new Float64Array(0) }, 0, 5), [], 'no frames: none');
}

console.log('4. pickCamera');
{
    const near = camera('near', 1200), far = camera('far', 400), off = camera('off', 1200, 640, 480, 5000);
    const g = group(0, 0, 0, 100, ['near', 'far', 'off'], 10);
    eq(G.pickCamera(g, [far, near, off], new Set()), 'near', 'the camera where the animal projects largest');
    eq(G.pickCamera(g, [far, near], new Set(['near'])), 'far', 'once the best camera is used, another good view wins (a third of the size here)');
    eq(G.pickCamera(g, [far, near], new Map([['near', 2], ['far', 1]])), 'far', 'the view used least wins…');
    eq(G.pickCamera(g, [far, near], new Map([['near', 1], ['far', 1]])), 'near', '…the larger on a tie: five samples rotate near, far, near, far, near');
    const speck = camera('speck', 100);
    eq(G.pickCamera(group(0, 0, 0, 100, ['near', 'speck'], 10), [near, speck], new Set(['near'])), 'near',
        '…but never a view where the animal is a speck (under 30% of the best, or 40 px): the best is reused');
    eq(G.pickCamera(group(0, 0, 0, 100, ['far', 'off'], 10), [far, off], new Set()), 'far',
        'a camera whose projection falls outside its image counts for a tenth');
    eq(G.pickCamera(group(0, 0, 0, 100, ['far'], 10), [near, far], new Set()), 'far', 'only cameras with a 2D member');
    eq(G.pickCamera(group(0, 0, 0, 100, ['uncalibrated'], 10), [near], new Set()), 'uncalibrated', 'a member only in a camera with no calibration: still used');
    ok(G.pickCamera(group(0, 0, 0, 100, [], 10), [near], new Set()) === null && G.pickCamera(null, [near], new Set()) === null, 'no member: null');
    // a view whose 2D detection is poor is passed over while another is not
    const good2d = [[310, 230], [330, 230], [320, 250]];
    eq(G.pickCamera(g, [far, near], new Set(), new Map([['near', [[0, 0], null, null]], ['far', good2d]])), 'far', 'the best view with under half its keypoints present is passed over');
    eq(G.pickCamera(g, [far, near], new Set(), new Map([['near', [[0, 0], [600, 470], [320, 240]]], ['far', good2d]])), 'far',
        '…and one whose keypoints spread far wider than the 3D says the animal is');
    eq(G.pickCamera(g, [far, near], new Set(), new Map([['near', [[0, 0], null, null]], ['far', [null, null, null]]])), 'near',
        'every view poor: chosen as without the 2D');
    eq(G.pickCamera(g, [far, near], new Set(), new Map([['near', good2d], ['far', good2d]])), 'near', 'good 2D everywhere: the best view, as before');
    const b = G.projectedBox(g.points3d, near);
    ok(b && close(b.x0, 320 - 120) && close(b.x1, 320 + 120), `projectedBox in pixels: ${JSON.stringify(b)}`);
}

console.log('5. cropSquare');
{
    const sq = G.cropSquare([[100, 100], [200, 150], null, [NaN, 3]]);
    ok(close(sq.side, 1.4 * 100 + 12) && close(sq.x + sq.side / 2, 150) && close(sq.y + sq.side / 2, 125), `1.4 x the larger extent + 12 px, centred: ${JSON.stringify(sq)}`);
    eq(G.cropSquare([[10, 10], [11, 11]]).side, 40, 'at least 40 px');
    ok(G.cropSquare([[10, 10], null]) === null && G.cropSquare([]) === null, 'fewer than two points: null');
}

console.log('6. projectTrack');
{
    const cam = camera('c', 100);
    const frames = new Int32Array([0, 1, 2, 3, 10, 11]), xyz = new Float64Array(18);
    for (let i = 0; i < 6; i++) { xyz[3 * i] = i; xyz[3 * i + 2] = 100; }
    const p = G.projectTrack({ frames, xyz }, cam, 100, 2);
    eq(Array.from(p.frames), [0, 1, 2, 3, 10, 11], 'every point when under the cap');
    eq(Array.from(p.breaks), [1, 0, 0, 0, 1, 0], 'a break where the next frame is more than gapFrames later');
    ok(close(p.uv[2], 321, 1e-4), 'projected through the camera');
    const thin = G.projectTrack({ frames: new Int32Array(Array.from({ length: 1000 }, (_, i) => i)), xyz: new Float64Array(3000).fill(1) }, cam, 100, 2);
    ok(thin.frames.length <= 100 && thin.frames[1] - thin.frames[0] === 10, `thinned evenly to the cap: ${thin.frames.length} points, every 10th`);
    ok(thin.breaks.slice(1).every(b => b === 0), '…and the gap test scales with the thinning (no false breaks)');
    const behind = G.projectTrack({ frames: new Int32Array([0, 1, 2]), xyz: new Float64Array([0, 0, 100, 0, 0, NaN, 0, 0, 100]) }, cam, 100, 5);
    eq(Array.from(behind.breaks), [1, 1, 1], 'a point that does not project breaks the path on both sides');
}

console.log('7. defaultMapCamera');
{
    const s = session([[0, [group(0, 0, 0, 100, ['a', 'b']), group(1, 0, 0, 100, ['b'])]], [1, [group(0, 0, 0, 100, ['b', 'c'])]]]);
    s.cameras = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    eq(G.defaultMapCamera(s), 'b', 'the camera with the most 2D members');
    s.cameras = [{ name: 'x' }, { name: 'y' }];
    eq(G.defaultMapCamera(s), 'x', 'no members in any: the first camera');
    eq(G.defaultMapCamera({ cameras: [] }), null, 'no cameras: null');
}

console.log('8. timeColor');
{
    const rgb = (s) => s.match(/\d+/g).map(Number);
    const lum = (c) => { const [r, g, b] = rgb(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    eq(G.timeColor(0), 'rgb(37,106,191)', 'start: the ramp\'s darker end (#256abf)');
    eq(G.timeColor(1), 'rgb(205,226,251)', 'end: its lightest (#cde2fb)');
    let mono = true; for (let i = 1; i <= 20; i++) if (!(lum(G.timeColor(i / 20)) > lum(G.timeColor((i - 1) / 20)))) mono = false;
    ok(mono, 'lightness rises with time (one hue, sequential)');
    ok(G.timeColor(-1) === G.timeColor(0) && G.timeColor(2) === G.timeColor(1) && G.timeColor(NaN) === G.timeColor(0), 'clamped');
}

console.log('9. memberPointsByCamera: a lazy project\'s released members are read through hydration');
{
    // As tests/test-lazy-residency.mjs does for the image check: a member whose 2D was given back
    // to the store holds only the shared placeholder, so reading it directly finds no keypoints.
    const pts = [[100, 200], [140, 210], [120, 260]], F = 42, cam = 'A';
    const member = new Instance(lazyPlaceholderXY(3), 0, 'predicted', 0.9);
    member._rawInstIndex = 0; member._lazy2d = true;
    const g = new InstanceGroup(1, 7); g.addInstance(cam, member);
    const s = {
        instanceGroups: new Map([[F, [g]]]), frameGroups: new Map(),
        lazyLoader: {
            labelsByCam: new Map([[cam, {}]]), numNodesByCam: new Map([[cam, 3]]),
            describeStoreFrame: () => ({ count: 1, trackIdx: Int32Array.of(0), predicted: Uint8Array.of(1) }),
            getFrameSync: (f) => new Map([[cam, f === F ? [{ points: pts, trackIdx: 0, type: 'predicted', score: 0.9 }] : []]]),
        },
    };
    ok(G.cropSquare([0, 1, 2].map(k => member.getPoint(k))) === null, 'control: read directly, a released member gives no crop');
    const got = G.memberPointsByCamera(s, F, 7).get(cam);
    eq(got, pts, 'read through hydration: the row\'s real 2D');
    ok(member._lazy2d && member._xy === lazyPlaceholderXY(3), '…and the 2D is given back afterwards');
    eq(G.memberPointsByCamera(s, F, 99).size, 0, 'an identity with no group there: nothing');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
