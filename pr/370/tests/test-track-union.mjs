/**
 * test-track-union.mjs — the session track list a multi-camera load builds
 * from each camera's own track list (`loading/track-union.js`).
 *
 * The per-camera folder loaders used to take `session.tracks` from whichever
 * camera's file finished opening FIRST. Five loads of one real 8-camera folder
 * gave 262, 863, 863, 863 and 388 tracks, and every other camera's track indices
 * pointed past the end of that list or at another camera's names. The fix is
 * one rule, applied by all three per-camera paths (eager, `SioLazyLoader`,
 * `LazyFrameLoader`): the union of the cameras' names, cameras in sorted name
 * order. What has to hold, and is pinned here:
 *
 *   - the answer depends on the SET of cameras, never on the order they are
 *     handed over (= the order their files finished opening);
 *   - every camera's own track `i` maps to a session track with the SAME NAME;
 *   - the map is injective per camera, even when a camera repeats a name;
 *   - on the real folder's shape (`track_0..track_{n-1}` everywhere) every map
 *     is the identity, so the lazy loader rewrites no column at all.
 *
 * The end-to-end half — the real folder loader, real lazy stores, real
 * resolution orders — is `tests/e2e/percam-track-union.mjs`.
 */
import { unionTrackNames, remapTrackIdx, isIdentityRemap } from '../loading/track-union.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};

const seq = (n, prefix = 'track_') => Array.from({ length: n }, (_, i) => prefix + i);

/** Deterministic shuffles (mulberry32), so a failure reproduces. */
function rng(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function shuffled(arr, rand) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/** Every camera's own track i must land on a session track of the same name. */
function namesPreserved(perCamera, u) {
    for (const { camName, names } of perCamera) {
        const remap = u.remapByCam.get(camName);
        if (!remap || remap.length !== names.length) return false;
        for (let i = 0; i < names.length; i++) {
            if (u.names[remap[i]] !== names[i]) return false;
        }
    }
    return true;
}
function injective(remap) { return new Set(remap).size === remap.length; }

console.log('\n1. The real folder: eight cameras, 249..863 tracks, all named track_<i>');
{
    // Camera names and per-camera track counts from
    // 20260713_174659-194366_05mice_flippers (2026-10-06).
    const real = [
        ['Camera0_topB', 262], ['Camera1_topC', 443], ['Camera2_mid', 249], ['Camera3_sideC', 863],
        ['Camera4_topR', 483], ['Camera5_topL', 405], ['Camera6_sideR', 388], ['Camera7_sideL', 414],
    ].map(([camName, n]) => ({ camName, names: seq(n) }));

    const rand = rng(20261006);
    const seen = new Set();
    let allIdentity = true, allPreserved = true;
    for (let k = 0; k < 200; k++) {
        const order = k === 0 ? real : (k === 1 ? real.slice().reverse() : shuffled(real, rand));
        const u = unionTrackNames(order);
        seen.add(JSON.stringify(u.names));
        if (!namesPreserved(real, u)) allPreserved = false;
        for (const r of u.remapByCam.values()) if (!isIdentityRemap(r)) allIdentity = false;
    }
    check(seen.size === 1, `200 opening orders give ONE track list (got ${seen.size} distinct)`);
    const u = unionTrackNames(real);
    check(u.names.length === 863, `it holds every camera's tracks: 863 = the longest (got ${u.names.length})`);
    check(u.names.every((n, i) => n === 'track_' + i), 'in index order: session track i is track_i');
    check(allPreserved, 'every camera\'s own track i maps to a session track of the same name');
    check(allIdentity, 'every camera\'s map is the identity — the lazy loader rewrites no column on this data');
    // The bug, for contrast: "first camera to open wins" on the same data.
    const firstWins = new Set(real.map(c => c.names.length));
    check(firstWins.size === 8, `(first-to-open-wins could give ${firstWins.size} different lengths here)`);
}

console.log('\n2. Lists that are NOT prefixes of each other: the order of CAMERAS decides, never of opening');
{
    const cams = [
        { camName: 'camA', names: ['track_0', 'track_1', 'track_2'] },
        { camName: 'camB', names: seq(7) },
        { camName: 'camC', names: ['track_9', 'track_0', 'mouse_x', 'track_4'] },
    ];
    const expected = ['track_0', 'track_1', 'track_2', 'track_3', 'track_4', 'track_5', 'track_6', 'track_9', 'mouse_x'];
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    let allSame = true, allPreserved = true;
    for (const p of perms) {
        const u = unionTrackNames(p.map(i => cams[i]));
        if (JSON.stringify(u.names) !== JSON.stringify(expected)) allSame = false;
        if (!namesPreserved(cams, u)) allPreserved = false;
    }
    check(allSame, `all 6 orders give camA's, then camB's new, then camC's new names: ${expected.join(',')}`);
    check(allPreserved, 'and every camera keeps its names under every order');
    const u = unionTrackNames(cams);
    check(Array.from(u.remapByCam.get('camC')).join(',') === '7,0,8,4',
        `camC's out-of-order names map to their session slots (got ${Array.from(u.remapByCam.get('camC'))})`);
    check(!isIdentityRemap(u.remapByCam.get('camC')) && isIdentityRemap(u.remapByCam.get('camB')),
        'only the camera whose names moved needs re-indexing');
    // The input array is not reordered in place.
    const input = cams.slice().reverse();
    const before = input.map(c => c.camName).join(',');
    unionTrackNames(input);
    check(input.map(c => c.camName).join(',') === before, 'the caller\'s array is left in its own order');
}

console.log('\n3. A name repeated WITHIN a camera stays two tracks');
{
    const cams = [
        { camName: 'a', names: ['x', 'y', 'x'] },
        { camName: 'b', names: ['x', 'x', 'x', 'z'] },
    ];
    const u = unionTrackNames(cams);
    check(JSON.stringify(u.names) === JSON.stringify(['x', 'y', 'x', 'x', 'z']),
        `multiset union: 'x' appears as often as the camera with the most (got ${JSON.stringify(u.names)})`);
    check(injective(u.remapByCam.get('a')) && injective(u.remapByCam.get('b')),
        'no camera has two of its tracks merged into one');
    check(namesPreserved(cams, u), 'and each still maps to its own name');
    check(Array.from(u.remapByCam.get('b')).join(',') === '0,2,3,4',
        `the k-th 'x' of a camera is the k-th 'x' slot (got ${Array.from(u.remapByCam.get('b'))})`);
}

console.log('\n4. Camera order is by code unit, so it does not move with the locale');
{
    // localeCompare puts 'a' before 'B' and, with numeric collation, 'cam2'
    // before 'cam10'; '<' compares UTF-16 code units, the same everywhere.
    const u = unionTrackNames([
        { camName: 'cam2', names: ['p'] },
        { camName: 'cam10', names: ['q'] },
        { camName: 'a', names: ['r'] },
        { camName: 'B', names: ['s'] },
    ]);
    check(u.names.join(',') === 's,r,q,p', `'B' < 'a' < 'cam10' < 'cam2' (got ${u.names.join(',')})`);
}

console.log('\n5. Degenerate inputs');
{
    const one = unionTrackNames([{ camName: 'only', names: ['t1', 't0'] }]);
    check(one.names.join(',') === 't1,t0' && isIdentityRemap(one.remapByCam.get('only')),
        'one camera: its own list, untouched');
    const empty = unionTrackNames([{ camName: 'a', names: [] }, { camName: 'b' }]);
    check(empty.names.length === 0 && empty.remapByCam.get('a').length === 0 && empty.remapByCam.get('b').length === 0,
        'cameras with no tracks contribute nothing and get an empty map');
    check(unionTrackNames([]).names.length === 0 && unionTrackNames(undefined).names.length === 0, 'no cameras at all');
    const odd = unionTrackNames([{ camName: 'a', names: [null, 3] }]);
    check(JSON.stringify(odd.names) === JSON.stringify(['', '3']), 'names are strings (null -> \'\')');
}

console.log('\n6. remapTrackIdx: trackless and out-of-range own indices are trackless');
{
    const remap = new Int32Array([4, 0, 2]);
    check(remapTrackIdx(remap, 0) === 4 && remapTrackIdx(remap, 2) === 2, 'an own index maps through');
    check(remapTrackIdx(remap, -1) === -1, '-1 (no track) stays -1');
    check(remapTrackIdx(remap, null) === -1 && remapTrackIdx(remap, undefined) === -1, 'null/undefined -> -1');
    check(remapTrackIdx(remap, NaN) === -1, 'NaN -> -1');
    check(remapTrackIdx(remap, 3) === -1,
        'an index past the camera\'s own list is trackless, not a raw index into the session list');
    check(remapTrackIdx(remap, 4294967295) === -1, 'an unsigned read-back of -1 is trackless');
    check(remapTrackIdx(remap, 1.5) === -1, 'a non-integer is trackless');
    check(remapTrackIdx({ 0: 0, 1: 5 }, 1) === 5, 'a plain-object map works too');
    check(remapTrackIdx(null, 0) === -1, 'no map at all -> -1');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
