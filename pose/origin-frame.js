// pose/origin-frame.js — the payload of the whole Define Planes feature.
//
// Turns "this annotated corner is the origin, and +Z points THAT way" into the
// translation + rotation that re-express the calibration's world frame in the
// user's frame. Everything upstream (plane skeletons, placements,
// triangulation, plane fit, 3D corner dragging) exists to produce the two
// inputs this module consumes: a point and a direction.
//
// DOM-free and dependency-free on purpose — this is the part worth testing
// directly, and the part a later step will want to call from a save path.
//
// CONVENTION (stated once, used everywhere):
//
//     p_new = R · p_old + t,    t = −R · origin
//
// `R`'s ROWS are the new frame's axes expressed in old-world coordinates, so
// `R · v` gives a world vector's components in the new frame. `t` is the
// translation of that mapping — NOT the origin's position. Both are reported,
// because they answer different questions and confusing them silently flips a
// sign: `origin` is "where the new origin sits in the old frame", `t` is "what
// to add after rotating". The inverse is `p_old = Rᵀ · p_new + origin`.

/** Squared length of a 3-vector. @private */
function len2(v) {
    return v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
}

/** Unit-length copy of `v`, or null if it is too short to have a direction. */
export function normalize3(v) {
    if (!v || v.length < 3) return null;
    if (!isFinite(v[0]) || !isFinite(v[1]) || !isFinite(v[2])) return null;
    var n = Math.sqrt(len2(v));
    if (!(n > 1e-12)) return null;
    return [v[0] / n, v[1] / n, v[2] / n];
}

/** Cross product a × b. */
export function cross3(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

/** Dot product a · b. */
export function dot3(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Build a right-handed frame from an origin point and a +Z direction.
 *
 * Z is what the user chose. X and Y are NOT — the user gave no in-plane
 * reference, so they have to be derived, and the derivation must be
 * deterministic or the same two clicks would produce a different rotation each
 * time. X is the old world +X projected onto the plane and renormalized
 * (Gram-Schmidt), falling back to old +Y when Z is within ~26° of X and the
 * projection would be numerically unstable. Y = Z × X closes the right-handed
 * triple.
 *
 * That choice fixes the roll about Z arbitrarily but consistently. If a later
 * step needs a meaningful X (say, "the direction of this plane edge"), it
 * belongs here as an optional hint rather than as a re-derivation elsewhere.
 *
 * @param {number[]} origin - new origin, in old-world coordinates
 * @param {number[]} zAxis - desired +Z direction (need not be unit length)
 * @param {number[]} [xHint] - optional in-plane direction to prefer for +X
 * @returns {{origin:number[], xAxis:number[], yAxis:number[], zAxis:number[],
 *            R:number[][], translation:number[], rotationVector:number[],
 *            axis:number[], angleDeg:number, angleRad:number}|null}
 *   null if the inputs do not define a frame (non-finite, or a zero-length Z).
 */
export function buildOriginFrame(origin, zAxis, xHint) {
    if (!origin || origin.length < 3) return null;
    if (!isFinite(origin[0]) || !isFinite(origin[1]) || !isFinite(origin[2])) return null;

    var z = normalize3(zAxis);
    if (!z) return null;

    // Pick the seed for X. `xHint` wins when it is usable; otherwise world +X,
    // or world +Y when X is too close to Z for the projection to be stable.
    var seed = null;
    if (xHint) {
        var h = normalize3(xHint);
        if (h && Math.abs(dot3(h, z)) < 0.9) seed = h;
    }
    if (!seed) seed = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];

    var d = dot3(seed, z);
    var x = normalize3([seed[0] - d * z[0], seed[1] - d * z[1], seed[2] - d * z[2]]);
    if (!x) return null;
    var y = cross3(z, x);

    // Rows are the new axes in old-world coords: (R·v)_i = axis_i · v.
    var R = [x.slice(), y.slice(), z.slice()];
    var t = [
        -(R[0][0] * origin[0] + R[0][1] * origin[1] + R[0][2] * origin[2]),
        -(R[1][0] * origin[0] + R[1][1] * origin[1] + R[1][2] * origin[2]),
        -(R[2][0] * origin[0] + R[2][1] * origin[1] + R[2][2] * origin[2]),
    ];

    var aa = rotationMatrixToAxisAngle(R);
    return {
        origin: [origin[0], origin[1], origin[2]],
        xAxis: x, yAxis: y, zAxis: z,
        R: R,
        translation: t,
        rotationVector: [aa.axis[0] * aa.angleRad, aa.axis[1] * aa.angleRad, aa.axis[2] * aa.angleRad],
        axis: aa.axis,
        angleRad: aa.angleRad,
        angleDeg: aa.angleRad * 180 / Math.PI,
    };
}

/**
 * Axis-angle (Rodrigues) form of a 3x3 rotation matrix.
 *
 * Two degenerate cases are handled explicitly rather than left to the generic
 * formula, which divides by sin(angle):
 *   - angle ~ 0: no rotation, so the axis is arbitrary. Returns +X and 0, which
 *     makes the rotation vector the zero vector — the only honest answer.
 *   - angle ~ pi: sin(angle) ~ 0 and the antisymmetric part vanishes. Recovered
 *     from the diagonal of R + I, taking the largest column for conditioning.
 *
 * @param {number[][]} R - 3x3, rows-major
 * @returns {{axis:number[], angleRad:number}}
 */
export function rotationMatrixToAxisAngle(R) {
    var trace = R[0][0] + R[1][1] + R[2][2];
    var cos = (trace - 1) / 2;
    if (cos > 1) cos = 1;
    if (cos < -1) cos = -1;
    var angle = Math.acos(cos);

    if (angle < 1e-9) return { axis: [1, 0, 0], angleRad: 0 };

    if (Math.PI - angle < 1e-6) {
        // R + I = 2·nnᵀ for a pi rotation about unit n; read n off its
        // largest-diagonal column so the square root is well conditioned.
        var m = [
            [R[0][0] + 1, R[0][1], R[0][2]],
            [R[1][0], R[1][1] + 1, R[1][2]],
            [R[2][0], R[2][1], R[2][2] + 1],
        ];
        var best = 0;
        if (m[1][1] > m[best][best]) best = 1;
        if (m[2][2] > m[best][best]) best = 2;
        var col = normalize3([m[0][best], m[1][best], m[2][best]]);
        return { axis: col || [1, 0, 0], angleRad: Math.PI };
    }

    var s = 2 * Math.sin(angle);
    var axis = normalize3([
        (R[2][1] - R[1][2]) / s,
        (R[0][2] - R[2][0]) / s,
        (R[1][0] - R[0][1]) / s,
    ]);
    return { axis: axis || [1, 0, 0], angleRad: angle };
}

/**
 * Express an old-world point in the frame: `p_new = R · p_old + t`.
 * @param {Object} frame - from `buildOriginFrame`
 * @param {number[]} p
 * @returns {number[]}
 */
export function applyOriginFrame(frame, p) {
    var R = frame.R, t = frame.translation;
    return [
        R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2] + t[0],
        R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2] + t[1],
        R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2] + t[2],
    ];
}

/**
 * The inverse: `p_old = Rᵀ · p_new + origin`.
 * @param {Object} frame - from `buildOriginFrame`
 * @param {number[]} q
 * @returns {number[]}
 */
export function unapplyOriginFrame(frame, q) {
    var R = frame.R, o = frame.origin;
    return [
        R[0][0] * q[0] + R[1][0] * q[1] + R[2][0] * q[2] + o[0],
        R[0][1] * q[0] + R[1][1] * q[1] + R[2][1] * q[2] + o[1],
        R[0][2] * q[0] + R[1][2] * q[1] + R[2][2] * q[2] + o[2],
    ];
}
