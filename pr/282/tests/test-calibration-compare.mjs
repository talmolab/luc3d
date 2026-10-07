/**
 * test-calibration-compare.mjs — do a multi-session project's sessions agree
 * about where the world is, and when they do not, WHY not?
 *
 * A multi-session load reads one calibration per session folder and nothing
 * makes them match. The failure is invisible: each session still reprojects
 * correctly against its own cameras, so every error stays small and every
 * number looks plausible — what breaks is only the comparison BETWEEN sessions,
 * which nothing on screen performs and so nothing on screen contradicts.
 *
 * The distinction this file is really about is between two disagreements that
 * need opposite advice:
 *
 *   - a leftover `calibration-rebased.toml` in ONE folder, which is the same
 *     rig in a different ORIGIN and is fixed by moving a file;
 *   - sessions genuinely calibrated apart, where no file move helps and the 3D
 *     is simply not in a shared space.
 *
 * `compareSessionCalibrations` separates them by measurement: it solves for the
 * change of world frame each camera implies and asks whether they all agree.
 * The re-based fixtures here are built with the app's OWN `rebaseExtrinsics`
 * and `buildOriginFrame`, so if the re-base and the detector ever drift apart
 * this file fails rather than both being wrong together.
 *
 * ESM, so `tests/run-mjs-tests.mjs` picks it up.
 */
import { compareSessionCalibrations } from '../pose/calibration-compare.js';
import { buildOriginFrame, rebaseExtrinsics } from '../pose/origin-frame.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol);

// ---------------------------------------------------------------- fixtures
//
// Eight-ish cameras is what a real cage has, but four is enough and keeps the
// failures readable. Deliberately off-axis and off-origin: an axis-aligned rig
// lets a dropped or transposed rotation pass by coincidence.
const K = (f) => [[f, 0, 639.5], [0, f, 511.5], [0, 0, 1]];
const RIG = [
    { name: 'back', f: 762.5, rvec: [0.357, 0.888, 1.683], tvec: [-555.5, -294.4, -190.8] },
    { name: 'mid', f: 757.9, rvec: [-0.372, -0.400, -1.009], tvec: [170.4, -465.7, -308.5] },
    { name: 'side', f: 754.7, rvec: [-0.865, -1.179, -1.022], tvec: [260.9, -1027.1, 279.4] },
    { name: 'top', f: 958.8, rvec: [0.149, -0.357, -1.572], tvec: [320.6, -113.3, -298.2] },
];

/** Plain camera objects — `compareSessionCalibrations` reads fields, not a class. */
function rig(overrides) {
    return RIG.map((c) => Object.assign({
        name: c.name,
        matrix: K(c.f),
        dist: [-0.288, 0, 0, 0, 0],
        size: [1280, 1024],
        rvec: c.rvec.slice(),
        tvec: c.tvec.slice(),
    }, (overrides && overrides[c.name]) || {}));
}

const session = (name, cameras) => ({ name, cameras });

/** Rodrigues, so a fixture can hand a rotation MATRIX where an rvec goes. */
function rodrigues(r) {
    const th = Math.hypot(r[0], r[1], r[2]);
    if (th < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const k = r.map((v) => v / th);
    const K3 = [[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]];
    const s = Math.sin(th), c = 1 - Math.cos(th);
    const out = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            let kk = 0;
            for (let m = 0; m < 3; m++) kk += K3[i][m] * K3[m][j];
            out[i][j] += s * K3[i][j] + c * kk;
        }
    }
    return out;
}

/**
 * The same rig, re-expressed in a new origin — built the way the app builds it.
 * Returns the cameras plus the frame, so a test can assert against the frame's
 * own numbers instead of hard-coded ones.
 */
function rebasedRig(origin, zAxis) {
    const frame = buildOriginFrame(origin, zAxis);
    const cams = rig().map((c) => {
        const out = rebaseExtrinsics(rodrigues(c.rvec), c.tvec, frame);
        return Object.assign({}, c, { rvec: out.rvec, tvec: out.tvec });
    });
    return { cams, frame };
}

console.log('\n1. Sessions that agree say nothing');
{
    const r = compareSessionCalibrations([
        session('A', rig()), session('B', rig()), session('C', rig()),
    ]);
    check(r.ok === true, 'three identical calibrations report ok');
    check(r.groups.length === 1, `one group (got ${r.groups.length})`);
    check(r.groups[0].sessions.join(',') === 'A,B,C', 'with all three sessions in it');
    check(r.diffs.length === 0, 'and nothing to describe');
    check(r.comparedCount === 3 && r.withoutCalibration.length === 0,
        'all three counted as comparable');
}

console.log('\n1b. ...even when one expresses its rotations as matrices');
{
    // A calibration read from an anipose TOML can carry a 3x3 under `rvec`.
    // Same geometry, different spelling: it must NOT read as a divergence, or
    // every project mixing a .toml with a .slp would raise the modal.
    const asMatrices = rig().map((c) => Object.assign({}, c, { rvec: rodrigues(c.rvec) }));
    const r = compareSessionCalibrations([session('A', rig()), session('B', asMatrices)]);
    check(r.ok === true, 'rvec and its rotation matrix compare equal');
}

console.log('\n2. One session re-based: same rig, different ORIGIN');
{
    // The case the folder on disk is actually in: three sessions on
    // calibration.toml and one that picked up a calibration-rebased.toml.
    const { cams, frame } = rebasedRig([-10.591, 11.9, 1218.743], [0.1, -0.2, 0.97]);
    const r = compareSessionCalibrations([
        session('s1', rig()), session('s2', rig()),
        session('s3', cams), session('s4', rig()),
    ]);
    check(r.ok === false, 'reported as a divergence');
    check(r.groups.length === 2, `two groups (got ${r.groups.length})`);
    check(r.groups[r.reference].sessions.length === 3,
        'the MAJORITY is the reference, so the odd session is the one described');
    check(r.groups[r.reference].sessions.join(',') === 's1,s2,s4',
        `and it is the three unmodified sessions (got ${r.groups[r.reference].sessions.join(',')})`);
    check(r.diffs.length === 1 && r.diffs[0].sessions.join(',') === 's3',
        'exactly one odd group, naming s3');

    const d = r.diffs[0];
    check(d.kind === 'origin', `classified as an origin change (got '${d.kind}')`);
    check(r.frameOnly === true, 'and frameOnly, which is what selects the recoverable advice');
    check(d.sharedCameras === 4, 'every camera contributed to the answer');
    // t_f is where the re-based origin sits in the ORIGINAL world — which is
    // exactly the point the user picked, so the test knows it without recomputing.
    check(near(d.frame.origin[0], frame.origin[0], 1e-6)
        && near(d.frame.origin[1], frame.origin[1], 1e-6)
        && near(d.frame.origin[2], frame.origin[2], 1e-6),
        `recovers the origin the re-base used (got [${d.frame.origin.map((v) => v.toFixed(3))}])`);
    check(near(d.frame.distanceMm, Math.hypot(...frame.origin), 1e-6),
        `and its distance, ${d.frame.distanceMm.toFixed(3)} mm`);
    check(near(d.frame.angleDeg, frame.angleDeg, 1e-6),
        `and the rotation, ${d.frame.angleDeg.toFixed(3)}° vs the frame's ${frame.angleDeg.toFixed(3)}°`);
    check(d.frame.rigid === true, 'all four cameras agree on one rigid transform');
    check(d.frame.spreadRot < 1e-9 && d.frame.spreadTransMm < 1e-6,
        `to floating-point noise (spread ${d.frame.spreadRot.toExponential(1)} / ` +
        `${d.frame.spreadTransMm.toExponential(1)} mm)`);
    check(d.lensCameras.length === 0 && d.onlyHere.length === 0 && d.onlyInReference.length === 0,
        'and nothing about the lenses or the camera set changed');
}

console.log('\n2b. A pure translation, and a pure rotation');
{
    // Two degenerate origins that a frame solver can get wrong in opposite
    // ways: no rotation at all, and a rotation about the world axes with the
    // origin left alone.
    const t = rebasedRig([100, -250, 30], [0, 0, 1]);
    const rt = compareSessionCalibrations([session('A', rig()), session('B', t.cams)]);
    // The angle is read off a trace with `acos`, whose derivative is unbounded
    // at zero: a 1e-16 error in the trace of a near-identity rotation comes out
    // as ~1e-6 degrees. "No rotation" is therefore only assertable to about
    // 1e-4 degrees, and tightening this below that pins floating-point noise
    // rather than behaviour.
    check(rt.diffs[0].kind === 'origin' && near(rt.diffs[0].frame.angleDeg, 0, 1e-4),
        `a shifted origin is an origin change with ~0° rotation (got ${rt.diffs[0].frame.angleDeg.toExponential(1)}°)`);
    check(near(rt.diffs[0].frame.distanceMm, Math.hypot(100, 250, 30), 1e-6),
        'and the full offset distance');

    const rr = rebasedRig([0, 0, 0], [1, 0, 0]);
    const rrr = compareSessionCalibrations([session('A', rig()), session('B', rr.cams)]);
    check(rrr.diffs[0].kind === 'origin' && near(rrr.diffs[0].frame.distanceMm, 0, 1e-6),
        'a rotated-but-not-moved origin is one too, with ~0 mm offset');
    check(rrr.diffs[0].frame.angleDeg > 1,
        `and a real angle (got ${rrr.diffs[0].frame.angleDeg.toFixed(2)}°)`);
}

console.log('\n3. Different LENS is not an origin change');
{
    // One camera re-focused. An origin change never touches intrinsics, so
    // this must not be offered the "move the file" advice.
    const r = compareSessionCalibrations([
        session('A', rig()), session('B', rig({ mid: { matrix: K(900) } })),
    ]);
    check(r.ok === false, 'reported');
    check(r.diffs[0].kind === 'lens', `classified as a lens difference (got '${r.diffs[0].kind}')`);
    check(r.diffs[0].lensCameras.join(',') === 'mid', 'naming the camera that changed');
    check(r.frameOnly === false, 'and NOT frameOnly, so the advice is the other one');
}

console.log('\n3b. Distortion and image size count as the lens too');
{
    const rd = compareSessionCalibrations([
        session('A', rig()), session('B', rig({ top: { dist: [-0.2, 0, 0, 0, 0] } })),
    ]);
    check(rd.diffs[0].kind === 'lens' && rd.diffs[0].lensCameras.join(',') === 'top',
        'a changed distortion coefficient is a lens difference');
    const rs = compareSessionCalibrations([
        session('A', rig()), session('B', rig({ side: { size: [1920, 1080] } })),
    ]);
    check(rs.diffs[0].kind === 'lens' && rs.diffs[0].lensCameras.join(',') === 'side',
        'and so is a different image size');
}

console.log('\n4. A different SET of cameras');
{
    const extra = rig().concat([{
        name: 'backL', matrix: K(817.6), dist: [-0.331, 0, 0, 0, 0], size: [1280, 1024],
        rvec: [-0.026, -0.010, -0.027], tvec: [9.9, -26.8, -434.1],
    }]);
    const r = compareSessionCalibrations([session('A', rig()), session('B', extra)]);
    check(r.diffs[0].kind === 'cameras', `classified by the camera set (got '${r.diffs[0].kind}')`);
    check(r.diffs[0].onlyHere.join(',') === 'backL', 'naming the camera only the odd session has');
    check(r.diffs[0].onlyInReference.length === 0, 'and nothing missing from it');

    // ...and the mirror image. The reference is the LARGER group, and with one
    // session each the tie goes to the first, so B is the odd one either way.
    const r2 = compareSessionCalibrations([session('A', extra), session('B', rig())]);
    check(r2.diffs[0].kind === 'cameras' && r2.diffs[0].onlyInReference.join(',') === 'backL',
        'a MISSING camera is reported as missing, not as an extra');
}

console.log('\n5. Extrinsics that no single origin explains');
{
    // ONE camera nudged. This is the genuinely broken case — a rig that moved
    // between recordings — and it must not be mistaken for an origin change,
    // because the advice for the two is opposite.
    const r = compareSessionCalibrations([
        session('A', rig()), session('B', rig({ side: { tvec: [280.9, -1027.1, 279.4] } })),
    ]);
    check(r.diffs[0].kind === 'extrinsics',
        `classified as inconsistent extrinsics (got '${r.diffs[0].kind}')`);
    check(r.frameOnly === false, 'not frameOnly');
    check(r.diffs[0].frame && r.diffs[0].frame.rigid === false,
        'and the frame solve explicitly says no rigid transform fits');
    check(r.diffs[0].frame.spreadTransMm > 1,
        `with a spread worth quoting (${r.diffs[0].frame.spreadTransMm.toFixed(1)} mm)`);

    // The 20 mm nudge above is far outside tolerance; a nudge well INSIDE it is
    // the control that keeps the tolerance from being vacuous.
    const tiny = compareSessionCalibrations([
        session('A', rig()), session('B', rig({ side: { tvec: [260.9 + 1e-9, -1027.1, 279.4] } })),
    ]);
    check(tiny.ok === true, 'a 1 nm difference is the same calibration, not a divergence');
}

console.log('\n6. Sessions with no calibration are excluded, not counted as different');
{
    // A per-camera folder load with no .toml leaves a session with no cameras.
    // It cannot disagree with anything, and treating it as a third calibration
    // would raise the modal on a project that is perfectly consistent.
    const r = compareSessionCalibrations([
        session('A', rig()), session('B', rig()), session('noCal', []),
    ]);
    check(r.ok === true, 'two agreeing sessions plus an uncalibrated one is still ok');
    check(r.withoutCalibration.join(',') === 'noCal', 'and the uncalibrated one is named');
    check(r.comparedCount === 2 && r.sessionCount === 3,
        'compared 2 of 3, so the modal can explain the shortfall');
}

console.log('\n7. Nothing to compare');
{
    check(compareSessionCalibrations([]).ok === true, 'no sessions');
    check(compareSessionCalibrations(null).ok === true, 'null');
    check(compareSessionCalibrations([session('only', rig())]).ok === true, 'a single session');
    const one = compareSessionCalibrations([session('only', rig())]);
    check(one.groups.length === 0, 'and a single session produces no groups to render');
}

console.log('\n8. A camera with unreadable geometry is skipped, not treated as a difference');
{
    const broken = rig();
    broken[1] = Object.assign({}, broken[1], { tvec: [NaN, 0, 0] });
    const r = compareSessionCalibrations([session('A', rig()), session('B', broken)]);
    // B is left with three usable cameras, so the sets differ — reported as a
    // camera-set difference rather than silently comparing a NaN.
    check(r.ok === false && r.diffs[0].kind === 'cameras',
        'a NaN translation drops that camera from the comparison');
    check(r.diffs[0].onlyInReference.join(',') === 'mid',
        `and it shows up as missing (got '${r.diffs[0].onlyInReference.join(',')}')`);
}

console.log('\n9. An even split keeps a stable reference');
{
    // Two against two. There is no majority, so the answer must not depend on
    // anything that can change between loads: the FIRST group wins, and the
    // report reads the same way every time.
    const { cams } = rebasedRig([50, 60, 700], [0, 0.3, 0.95]);
    const r = compareSessionCalibrations([
        session('a', rig()), session('b', cams), session('c', rig()), session('d', cams),
    ]);
    check(r.groups.length === 2, 'two groups of two');
    check(r.reference === 0 && r.groups[0].sessions.join(',') === 'a,c',
        'the earliest group is the reference on a tie');
    check(r.diffs.length === 1 && r.diffs[0].sessions.join(',') === 'b,d',
        'and both odd sessions are described together, once');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
