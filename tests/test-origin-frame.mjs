/**
 * test-origin-frame.mjs — the origin transform, tested away from the UI.
 *
 * `pose/origin-frame.js` is the payload of the whole Define Planes feature: it
 * turns "this corner is the origin, +Z points that way" into the translation +
 * rotation that re-express the calibration frame in the user's frame. The e2e
 * (`tests/e2e/define-plane-mode.mjs` section 14) drives it through the wizard,
 * which covers the happy path but only ever exercises ONE geometry. The failure
 * modes here are numerical and live in the branches the wizard rarely reaches:
 * the 180-degree case, the near-parallel X fallback, and degenerate input.
 *
 * ESM, so `tests/run-mjs-tests.mjs` picks it up automatically. The module is
 * dependency-free by design, so it imports directly with no DOM and no stubs.
 */

import {
    buildOriginFrame, rotationMatrixToAxisAngle, rotationAboutAxis, mulMat3Vec3,
    applyOriginFrame, unapplyOriginFrame, normalize3, cross3, dot3,
} from '../pose/origin-frame.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-12 : tol);
const vnear = (a, b, tol) => a.length === b.length && a.every((v, i) => near(v, b[i], tol));

/** A frame is only a frame if R is orthonormal and right-handed. */
function assertProperFrame(f, label) {
    const R = f.R;
    const orthonormal = [0, 1, 2].every(i => near(dot3(R[i], R[i]), 1))
        && near(dot3(R[0], R[1]), 0) && near(dot3(R[1], R[2]), 0) && near(dot3(R[0], R[2]), 0);
    check(orthonormal, `${label}: R is orthonormal`);
    const det = R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1])
        - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0])
        + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
    check(near(det, 1), `${label}: R is right-handed (det ${det.toFixed(15)})`);
    // The whole point: the picked corner IS the new origin.
    check(vnear(applyOriginFrame(f, f.origin), [0, 0, 0], 1e-9),
        `${label}: the origin maps to (0,0,0)`);
}

console.log('\n1. The identity case (already the world frame)');
{
    const f = buildOriginFrame([0, 0, 0], [0, 0, 1]);
    assertProperFrame(f, 'identity');
    check(vnear(f.xAxis, [1, 0, 0]) && vnear(f.yAxis, [0, 1, 0]) && vnear(f.zAxis, [0, 0, 1]),
        'the axes come back as the world axes');
    check(vnear(f.translation, [0, 0, 0]), 't is zero');
    check(near(f.angleDeg, 0), `the rotation angle is 0 (got ${f.angleDeg})`);
    check(vnear(f.rotationVector, [0, 0, 0]),
        'the rotation vector is exactly zero, not an arbitrary axis times ~0');
}

console.log('\n2. Pure translation');
{
    const O = [10, -20, 30];
    const f = buildOriginFrame(O, [0, 0, 1]);
    assertProperFrame(f, 'translated');
    check(vnear(f.origin, O), 'the origin is reported in old-world coordinates');
    // t = -R*origin, which for R = I is just -origin. The two are DIFFERENT
    // vectors in general and confusing them silently flips a sign.
    check(vnear(f.translation, [-10, 20, -30]), 't = -R*origin, not the origin itself');
    check(vnear(applyOriginFrame(f, [11, -20, 30]), [1, 0, 0]),
        'a point 1mm along +x lands at (1,0,0)');
}

console.log('\n3. The 180-degree case (the branch the generic formula divides by zero on)');
{
    // +Z flipped: exactly the "user picked the blue arrow" case.
    const f = buildOriginFrame([1, 2, 3], [0, 0, -1]);
    assertProperFrame(f, '180deg');
    check(near(f.angleDeg, 180, 1e-9), `the angle is 180 (got ${f.angleDeg})`);
    check(near(Math.hypot(...f.axis), 1), 'the axis is still unit length');
    // A pi rotation's axis must be perpendicular to the flip.
    check(near(dot3(f.axis, [0, 0, 1]), 0, 1e-9),
        'the axis is perpendicular to the flipped Z, as a pi rotation requires');
    check(vnear(f.zAxis, [0, 0, -1]), '+Z is the direction that was asked for');
}

console.log('\n4. The near-parallel fallback for +X');
{
    // Z along world +X: projecting world +X onto the plane would be degenerate.
    const f = buildOriginFrame([0, 0, 0], [1, 0, 0]);
    assertProperFrame(f, 'z-along-x');
    check(near(dot3(f.xAxis, f.zAxis), 0, 1e-15),
        'X is still perpendicular to Z (the fallback seed was used)');
    check(near(Math.hypot(...f.xAxis), 1), 'and still unit length');

    // Just inside the switch-over, where the projection is still usable.
    const tilt = normalize3([0.85, 0, Math.sqrt(1 - 0.85 * 0.85)]);
    const g = buildOriginFrame([0, 0, 0], tilt);
    assertProperFrame(g, 'near-threshold');
    check(near(dot3(g.xAxis, g.zAxis), 0, 1e-15), 'X stays perpendicular either side of the switch');
}

console.log('\n5. A tilted plane, end to end');
{
    const z = normalize3([0.3, -0.5, 0.81]);
    const O = [12.5, -7.25, 301.75];
    const f = buildOriginFrame(O, z);
    assertProperFrame(f, 'tilted');
    check(vnear(f.zAxis, z, 1e-15), '+Z is exactly the requested direction, normalized');
    check(vnear(f.yAxis, cross3(f.zAxis, f.xAxis), 1e-15), 'Y = Z x X closes the triple');

    // Anything on the plane through O with normal z must land at w = 0.
    const inPlane = [
        [O[0] + f.xAxis[0] * 40, O[1] + f.xAxis[1] * 40, O[2] + f.xAxis[2] * 40],
        [O[0] + f.yAxis[0] * -17, O[1] + f.yAxis[1] * -17, O[2] + f.yAxis[2] * -17],
    ];
    const worstW = Math.max(...inPlane.map(p => Math.abs(applyOriginFrame(f, p)[2])));
    check(worstW < 1e-12, `in-plane points land at z=0 (worst ${worstW.toExponential(2)})`);

    // A point one unit along the normal is at exactly z = 1: the transform is
    // rigid, so distances are preserved.
    const off = [O[0] + z[0] * 5, O[1] + z[1] * 5, O[2] + z[2] * 5];
    check(vnear(applyOriginFrame(f, off), [0, 0, 5], 1e-12),
        '5mm along the normal lands at (0,0,5) — the transform is rigid');

    // Round-trip.
    const probe = [-88.125, 4.5, 210.0625];
    check(vnear(unapplyOriginFrame(f, applyOriginFrame(f, probe)), probe, 1e-9),
        'apply then unapply is the identity');
    // Rigidity, stated directly: distances survive.
    const a = [1, 2, 3], b = [-4, 5, -6];
    const dBefore = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const qa = applyOriginFrame(f, a), qb = applyOriginFrame(f, b);
    const dAfter = Math.hypot(qa[0] - qb[0], qa[1] - qb[1], qa[2] - qb[2]);
    check(near(dBefore, dAfter, 1e-12), `distances are preserved (${dBefore} vs ${dAfter})`);
}

console.log('\n6. The rotation vector really is the rotation');
{
    const f = buildOriginFrame([0, 0, 0], normalize3([0.2, 0.4, 0.9]));
    const aa = rotationMatrixToAxisAngle(f.R);
    check(near(Math.hypot(...f.rotationVector), aa.angleRad, 1e-12),
        'its magnitude is the rotation angle in radians');
    check(vnear(f.axis, aa.axis, 1e-12), 'its direction is the rotation axis');
    check(near(f.angleDeg, f.angleRad * 180 / Math.PI, 1e-12), 'degrees and radians agree');
    // Rodrigues: rotating the axis by the rotation leaves it fixed.
    const spun = [
        dot3(f.R[0], f.axis), dot3(f.R[1], f.axis), dot3(f.R[2], f.axis),
    ];
    check(vnear(spun, f.axis, 1e-12), 'R leaves its own axis fixed');
}

console.log('\n7. Degenerate input is refused, not guessed at');
{
    check(buildOriginFrame([0, 0, 0], [0, 0, 0]) === null,
        'a zero-length +Z has no direction, so there is no frame');
    check(buildOriginFrame([0, 0, 0], [1e-20, 0, 0]) === null,
        'and neither does a vanishingly short one');
    check(buildOriginFrame([NaN, 0, 0], [0, 0, 1]) === null, 'a non-finite origin is refused');
    check(buildOriginFrame([0, 0, 0], [0, NaN, 1]) === null, 'a non-finite +Z is refused');
    check(buildOriginFrame(null, [0, 0, 1]) === null, 'a missing origin is refused');
    check(buildOriginFrame([0, 0], [0, 0, 1]) === null, 'a 2D origin is refused');
    check(normalize3([0, 0, 0]) === null, 'normalize3 refuses the zero vector');
}

console.log('\n8. An in-plane hint steers +X when it is usable');
{
    const z = [0, 0, 1];
    // A hint 45 degrees round from world +X, in the plane.
    const f = buildOriginFrame([0, 0, 0], z, [1, 1, 0]);
    check(vnear(f.xAxis, normalize3([1, 1, 0]), 1e-15), 'a usable hint becomes +X');
    assertProperFrame(f, 'hinted');
    // A hint along Z has no in-plane component, so it must be ignored rather
    // than producing a zero-length X.
    const g = buildOriginFrame([0, 0, 0], z, [0, 0, 1]);
    check(g !== null && vnear(g.xAxis, [1, 0, 0]),
        'a hint parallel to Z is ignored and the default seed is used');
}

console.log('\n9. rotationAboutAxis is the inverse of rotationMatrixToAxisAngle');
{
    // A proper rotation: orthonormal rows, det +1, and its own axis fixed.
    const assertProperRotation = (R, label) => {
        check(R !== null, label + ': built');
        if (!R) return;
        for (let i = 0; i < 3; i++) {
            check(near(dot3(R[i], R[i]), 1, 1e-14), label + ': row ' + i + ' is unit');
        }
        check(near(dot3(R[0], R[1]), 0, 1e-14), label + ': rows 0,1 orthogonal');
        check(near(dot3(R[0], R[2]), 0, 1e-14), label + ': rows 0,2 orthogonal');
        check(near(dot3(R[1], R[2]), 0, 1e-14), label + ': rows 1,2 orthogonal');
        const det = dot3(R[0], cross3(R[1], R[2]));
        check(near(det, 1, 1e-14), label + ': det = +1 (a rotation, not a reflection)');
    };

    // Round trip through the axis-angle form, over axes and angles that hit
    // every branch of rotationMatrixToAxisAngle including the pi case.
    const axes = [[0, 0, 1], [1, 0, 0], [0, 1, 0], [1, 1, 0], [-2, 3, 6]];
    const angles = [0.1, Math.PI / 6, Math.PI / 2, 2.4, Math.PI - 1e-3];
    for (const a of axes) {
        const u = normalize3(a);
        for (const th of angles) {
            const R = rotationAboutAxis(a, th);
            assertProperRotation(R, 'axis ' + JSON.stringify(a) + ' @ ' + th.toFixed(3));
            const aa = rotationMatrixToAxisAngle(R);
            check(near(aa.angleRad, th, 1e-9),
                'angle survives the round trip (' + th.toFixed(3) + ')');
            // The axis may come back negated together with the angle; both
            // describe the same rotation, so compare up to that sign.
            const sameAxis = vnear(aa.axis, u, 1e-9);
            const flipped = vnear(aa.axis, u.map(v => -v), 1e-9);
            check(sameAxis || flipped, 'axis survives the round trip up to sign');
        }
    }

    // The defining property: the axis itself does not move.
    const R1 = rotationAboutAxis([1, 2, 3], 0.77);
    const u1 = normalize3([1, 2, 3]);
    check(vnear(mulMat3Vec3(R1, u1), u1, 1e-14), 'the axis is fixed by its own rotation');

    // A concrete, hand-checkable case: +90 deg about +Z sends +X to +Y
    // (right-handed, counter-clockwise looking down the axis at the origin).
    const Rz = rotationAboutAxis([0, 0, 1], Math.PI / 2);
    check(vnear(mulMat3Vec3(Rz, [1, 0, 0]), [0, 1, 0], 1e-15), '+90 about +Z: +X -> +Y');
    check(vnear(mulMat3Vec3(Rz, [0, 1, 0]), [-1, 0, 0], 1e-15), '+90 about +Z: +Y -> -X');
    check(vnear(mulMat3Vec3(Rz, [0, 0, 1]), [0, 0, 1], 1e-15), '+90 about +Z: +Z fixed');

    // Composition: two halves equal the whole, so the sense is consistent.
    const half = rotationAboutAxis([0, 1, 0], 0.5);
    const whole = rotationAboutAxis([0, 1, 0], 1.0);
    const v = [0.3, -0.7, 1.1];
    check(vnear(mulMat3Vec3(half, mulMat3Vec3(half, v)), mulMat3Vec3(whole, v), 1e-14),
        'rotating twice by t equals once by 2t');

    // Rotation preserves length and angle — it is what makes moving a plane
    // rigid rather than a deformation.
    const w = [2, -3, 5];
    check(near(dot3(mulMat3Vec3(R1, w), mulMat3Vec3(R1, w)), dot3(w, w), 1e-12),
        'length is preserved');

    // A zero angle is the identity, not a near-identity.
    const R0 = rotationAboutAxis([0, 0, 1], 0);
    check(vnear(R0[0], [1, 0, 0]) && vnear(R0[1], [0, 1, 0]) && vnear(R0[2], [0, 0, 1]),
        'a zero angle gives exactly the identity');

    // Degenerate input is refused rather than guessed at, matching normalize3.
    check(rotationAboutAxis([0, 0, 0], 1) === null, 'a zero-length axis is refused');
    check(rotationAboutAxis([1, 0, 0], NaN) === null, 'a non-finite angle is refused');
    check(rotationAboutAxis(null, 1) === null, 'a missing axis is refused');
    check(rotationAboutAxis([NaN, 0, 1], 1) === null, 'a non-finite axis is refused');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
