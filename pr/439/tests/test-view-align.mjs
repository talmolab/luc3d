/**
 * test-view-align.mjs — "Align Views to References" solver (issue #226,
 * pose/view-align.js) on synthetic calibrated rigs.
 *
 * The check is independent of the solver's own helpers: for every aligned
 * camera it projects a world direction through the REAL `Camera` class
 * (`pose/pose-data.js`, distortion included), turns that image direction by the
 * returned rotation exactly the way CSS `rotate()` does on a y-down screen, and
 * asserts it lands on screen-up.
 *
 * Tolerances of 0.5° on "exact" cases: the solver's small pull toward the
 * references' own up vectors (`UP_PULL`) biases a clean plane intersection by
 * up to ~0.4°, and the store rounds to whole degrees anyway.
 *
 * Run:  node tests/test-view-align.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const { Camera } = await import(pathToFileURL(path.join(ROOT, 'pose', 'pose-data.js')).href);
const VA = await import(pathToFileURL(path.join(ROOT, 'pose', 'view-align.js')).href);

let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
function near(a, e, tol, m) { ok(Math.abs(a - e) <= tol, `${m} (expected ${e}, got ${a})`); }
function group(n) { console.log('\n• ' + n); }

// --- rig construction --------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return [a[0] / n, a[1] / n, a[2] / n]; };

/**
 * Camera at `C` looking at `target`, rolled `rollDeg` about its optical axis.
 * `rvec` is given as a 3x3 matrix (the anipose form `Camera` accepts as-is).
 */
function lookAt(name, C, target, rollDeg, opts = {}) {
    const z = unit(sub(target, C));
    const helper = Math.abs(z[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
    let x = unit(cross(z, helper));
    let y = cross(z, x);
    const r = rollDeg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    [x, y] = [[c * x[0] + s * y[0], c * x[1] + s * y[1], c * x[2] + s * y[2]],
              [-s * x[0] + c * y[0], -s * x[1] + c * y[1], -s * x[2] + c * y[2]]];
    const R = [x, y, z];
    const t = [-(R[0][0] * C[0] + R[0][1] * C[1] + R[0][2] * C[2]),
               -(R[1][0] * C[0] + R[1][1] * C[1] + R[1][2] * C[2]),
               -(R[2][0] * C[0] + R[2][1] * C[1] + R[2][2] * C[2])];
    const f = opts.f || 900;
    return new Camera(name, [[f, 0, 640], [0, f, 512], [0, 0, 1]], opts.dist || [0, 0, 0, 0, 0], R, t, [1280, 1024]);
}

// Native-pixel projection through the real Camera class (pinhole + distortion).
function proj(cam, X) { return cam.distortPoint(cam.project(X)); }

/**
 * Screen angle error (degrees) of world direction `U` at `P` in `cam` once the
 * view is rotated `deg`: 0 means U points straight up on screen.
 */
function screenUpError(cam, P, U, deg) {
    const e = 1e-3;
    const a = proj(cam, [P[0] - U[0] * e, P[1] - U[1] * e, P[2] - U[2] * e]);
    const b = proj(cam, [P[0] + U[0] * e, P[1] + U[1] * e, P[2] + U[2] * e]);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    // CSS rotate(θ) on a y-down screen: (x, y) -> (x cosθ - y sinθ, x sinθ + y cosθ).
    const t = deg * Math.PI / 180;
    const sx = dx * Math.cos(t) - dy * Math.sin(t);
    const sy = dx * Math.sin(t) + dy * Math.cos(t);
    // Angle from screen-up (0, -1).
    return Math.abs(Math.atan2(sx, -sy) * 180 / Math.PI);
}

/** The rotation that puts U up in `cam` — found by brute force, not the solver. */
function bruteForceRotation(cam, P, U) {
    let best = 0, bestErr = Infinity;
    for (let d = -179; d <= 180; d += 0.01) {
        const err = screenUpError(cam, P, U, d);
        if (err < bestErr) { bestErr = err; best = d; }
    }
    return best;
}

// --- display-convention helpers ------------------------------------------------

group('screen-up <-> rotation convention');
{
    for (const deg of [0, 37, 90, -90, 180, -135.5]) {
        const d = VA.screenUpImageDir(deg);
        const back = VA.rotationForImageDir(d);
        near(((back - deg + 540) % 360) - 180, 0, 1e-9, `round trip ${deg}°`);
    }
    // Rotating an image 90° clockwise brings its LEFT edge to the top.
    const d90 = VA.screenUpImageDir(90);
    near(d90[0], -1, 1e-12, '90° shows image-left as screen-up (x)');
    near(d90[1], 0, 1e-12, '90° shows image-left as screen-up (y)');
    ok(!Object.is(VA.rotationForImageDir([0, -1]), -0), 'no -0 for an already-up direction');
}

// --- side-on ring: one height, so every orbit is about the vertical -------------

group('ring at one height: references keep world-up up in every view');
{
    const Z = [0, 0, 1];
    const target = [0, 0, 100];
    const rolls = [12, -30, 75, 160, -95, 5, 40, -170];
    const cams = rolls.map((roll, i) => {
        const a = (i / rolls.length) * 2 * Math.PI;
        return lookAt('cam' + i, [1500 * Math.cos(a), 1500 * Math.sin(a), 600], target, roll);
    });
    const est = VA.estimateSceneCenter(cams);
    ok(est.ok, 'scene centre found');
    near(est.center[0], 0, 1e-6, 'centre x'); near(est.center[1], 0, 1e-6, 'centre y'); near(est.center[2], 100, 1e-6, 'centre z');

    // The user turned cam0 (and, second run, cam3) so world-up is up on screen.
    const rotA = bruteForceRotation(cams[0], target, Z);
    const rotB = bruteForceRotation(cams[3], target, Z);
    const rotC = bruteForceRotation(cams[5], target, Z);
    for (const [label, refs, rot] of [
        ['two references', ['cam0', 'cam3'], { cam0: rotA, cam3: rotB }],
        ['three references', ['cam0', 'cam3', 'cam5'], { cam0: rotA, cam3: rotB, cam5: rotC }],
    ]) {
        const res = VA.alignViewRotations(cams, rot, refs);
        ok(res.ok, label + ': solve succeeds ' + (res.error || ''));
        ok(res.skipped.length === 0, label + ': nothing skipped');
        near(res.disagreementDeg, 0, 0.5, label + ': consistent references agree');
        near(res.rotations.cam0, rotA, 1e-9, label + ': reference keeps its angle');
        for (const cam of cams) {
            near(screenUpError(cam, target, Z, res.rotations[cam.name]), 0, 0.5, label + ': ' + cam.name + ' shows world-up as screen-up');
        }
    }
    const res = VA.alignViewRotations(cams, { cam0: rotA, cam3: rotB }, ['cam0', 'cam3']);
    near(res.rotations.cam6, bruteForceRotation(cams[6], target, Z), 0.5, 'cam6 agrees with brute force');
}

// --- mixed heights ---------------------------------------------------------------

group('ring at mixed heights: close to world-up, exact at the references');
{
    const Z = [0, 0, 1];
    const target = [0, 0, 100];
    const cams = [0, 1, 2, 3, 4, 5].map(i => {
        const a = (i / 6) * 2 * Math.PI;
        return lookAt('m' + i, [1500 * Math.cos(a), 1500 * Math.sin(a), 300 + 250 * (i % 3)], target, 37 * i - 80);
    });
    const rot = { m0: bruteForceRotation(cams[0], target, Z), m3: bruteForceRotation(cams[3], target, Z) };
    const res = VA.alignViewRotations(cams, rot, ['m0', 'm3']);
    ok(res.ok, 'solve succeeds');
    near(res.rotations.m0, rot.m0, 1e-9, 'm0 keeps its angle');
    near(res.rotations.m3, rot.m3, 1e-9, 'm3 keeps its angle');
    for (const cam of cams) {
        ok(screenUpError(cam, target, Z, res.rotations[cam.name]) < 8,
            cam.name + ' within 8° of world-up (' + screenUpError(cam, target, Z, res.rotations[cam.name]).toFixed(2) + '°)');
    }
}

// --- lens distortion ---------------------------------------------------------------

group('distorted lenses, scene centre off the image centre');
{
    const Z = [0, 0, 1];
    const target = [50, -20, 80];
    const dist = [-0.28, 0.09, 0.001, -0.0005, -0.01];
    const cams = [0, 1, 2, 3, 4].map(i => {
        const a = i * 1.25 + 0.3;
        return lookAt('d' + i, [1200 * Math.cos(a), 1200 * Math.sin(a), 600], target, 20 * i - 45, { dist, f: 700 });
    });
    // P is NOT where the rig is aimed, so it lands off-centre in every image,
    // where distortion actually bends the local up direction.
    const P = [150, 60, 120];
    const rot = { d1: bruteForceRotation(cams[1], P, Z), d3: bruteForceRotation(cams[3], P, Z) };
    const res = VA.alignViewRotations(cams, rot, ['d1', 'd3'], { center: P });
    ok(res.ok, 'solve succeeds: ' + (res.error || ''));
    for (const cam of cams) {
        near(screenUpError(cam, P, Z, res.rotations[cam.name]), 0, 0.5, cam.name + ' aligned under distortion');
    }
}

// --- top-down rig (the issue's second example) ------------------------------------

group('top-down rig: the arena keeps one layout in every overhead view');
{
    const north = [1, 0, 0];
    const target = [0, 0, 0];
    // Cameras overhead, each tilted a little toward the arena from a different side.
    const cams = [
        lookAt('t0', [0, 0, 1500], target, 0),
        lookAt('t1', [350, 100, 1450], target, 80),
        lookAt('t2', [-300, 250, 1450], target, -140),
        lookAt('t3', [100, -380, 1450], target, 175),
        lookAt('t4', [-250, -300, 1450], target, 33),
    ];
    const rot = { t0: bruteForceRotation(cams[0], target, north), t3: bruteForceRotation(cams[3], target, north) };
    const res = VA.alignViewRotations(cams, rot, ['t0', 't3']);
    ok(res.ok, 'solve succeeds: ' + (res.error || ''));
    for (const cam of cams) {
        const e = screenUpError(cam, target, north, res.rotations[cam.name]);
        ok(e < 2, cam.name + ' shows north within 2° of screen-up (' + e.toFixed(2) + '°)');
    }
}

// --- top + side references in the rig's symmetry plane (HardFight / Mimica) --------

group('top and front references in one plane (failed the old plane-intersection solve)');
{
    const Z = [0, 0, 1], north = [0, 1, 0];
    const target = [0, 0, 0];
    const top = lookAt('top', [0, -150, 1500], target, 25);          // overhead, a bit to the south
    const front = lookAt('front', [0, -1500, 100], target, -70);     // south side, near level
    const others = [
        lookAt('topR', [900, -600, 1000], target, 140),
        lookAt('topL', [-900, -600, 1000], target, -15),
        lookAt('sideR', [1100, -1100, 150], target, 60),
        lookAt('sideL', [-1100, -1100, 150], target, -100),
    ];
    const cams = [top, front, ...others];
    // User's intent: top view shows north up; front view shows gravity up.
    const rot = { top: bruteForceRotation(top, target, north), front: bruteForceRotation(front, target, Z) };
    const res = VA.alignViewRotations(cams, rot, ['top', 'front']);
    ok(res.ok, 'solve succeeds: ' + (res.error || ''));
    ok(res.disagreementDeg < 3, 'a north-up top view and a gravity-up front view agree (' + res.disagreementDeg.toFixed(2) + '°)');
    // Side cameras near level keep gravity up; they are nearest the front reference.
    for (const n of ['sideR', 'sideL']) {
        const cam = cams.find(c => c.name === n);
        const e = screenUpError(cam, target, Z, res.rotations[n]);
        ok(e < 10, n + ' keeps gravity close to up (' + e.toFixed(2) + '°)');
    }
    // Elevated side cameras show the far (north) side of the arena at the top:
    // the direction "north tilted up" lands within the upper half-plane.
    for (const n of ['topR', 'topL']) {
        const cam = cams.find(c => c.name === n);
        const e = screenUpError(cam, target, unit([0, 1, 1]), res.rotations[n]);
        ok(e < 30, n + ' shows the far side up (' + e.toFixed(2) + '°)');
    }
}

// --- blending -------------------------------------------------------------------

group('several references: the nearest one dominates');
{
    const Z = [0, 0, 1];
    const target = [0, 0, 0];
    const a = lookAt('a', [1000, 0, 300], target, 0);
    const b = lookAt('b', [0, 1000, 300], target, 0);
    // Same position and direction as b, different physical roll.
    const bTwin = lookAt('bTwin', [0, 1000, 300], target, 50);
    // Deliberately inconsistent references: b is turned 20° off world-up.
    const rot = { a: bruteForceRotation(a, target, Z), b: bruteForceRotation(b, target, Z) + 20 };
    const res = VA.alignViewRotations([a, b, bTwin, lookAt('c', [-1000, 0, 300], target, 0)], rot, ['a', 'b']);
    ok(res.ok, 'solve succeeds');
    // bTwin sits exactly at b, so it must look exactly like b on screen.
    near(screenUpError(bTwin, target, Z, res.rotations.bTwin), 20, 0.05, 'a camera at a reference copies that reference');
}

// --- failure modes -------------------------------------------------------------

group('failure modes');
{
    const target = [0, 0, 0];
    const Z = [0, 0, 1];
    const cams = [
        lookAt('a', [1000, 0, 300], target, 0),
        lookAt('c', [0, 1000, 300], target, 30),
        lookAt('d', [-1000, 0, 300], target, -60),
    ];
    const ra = bruteForceRotation(cams[0], target, Z);
    const rc = bruteForceRotation(cams[1], target, Z);

    const flipped = VA.alignViewRotations(cams, { a: ra, c: rc + 180 }, ['a', 'c']);
    ok(!flipped.ok && /upside down/.test(flipped.error), 'an upside-down reference is reported');

    ok(!VA.alignViewRotations(cams, {}, ['a']).ok, 'one reference is refused');
    ok(!VA.alignViewRotations(cams, { a: ra }, ['a', 'a']).ok, 'the same reference twice counts once, so is refused');
    const missing = VA.alignViewRotations(cams, {}, ['a', 'zzz']);
    ok(!missing.ok && /zzz/.test(missing.error), 'an unknown reference camera is named');

    // A camera looking straight down the up direction cannot be oriented by it.
    const overhead = lookAt('over', [0, 0, 1500], target, 0);
    const withOverhead = VA.alignViewRotations(cams.concat([overhead]), { a: ra, c: rc }, ['a', 'c']);
    ok(withOverhead.ok, 'solve still succeeds with an overhead camera present');
    ok(withOverhead.skipped.some(s => s.name === 'over' && /straight along/.test(s.reason)) && !('over' in withOverhead.rotations),
        'the overhead camera is skipped, not given a noise rotation');

    // A camera facing away from the scene.
    const away = lookAt('away', [0, -1000, 300], [0, -3000, 300], 0);
    const withAway = VA.alignViewRotations(cams.concat([away]), { a: ra, c: rc }, ['a', 'c'], { center: target });
    ok(withAway.skipped.some(s => s.name === 'away' && /behind/.test(s.reason)), 'a camera facing away is skipped');

    const parallel = [lookAt('p0', [0, 0, 1000], target, 0), lookAt('p1', [10, 0, 1000], [10, 0, 0], 0)];
    ok(!VA.estimateSceneCenter(parallel).ok, 'parallel optical axes have no scene centre');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
