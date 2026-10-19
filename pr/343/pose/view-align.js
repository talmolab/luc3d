// pose/view-align.js — "Align Views to References" (issue #226): compute the
// in-plane display rotation for every camera view so the scene looks the same
// way round in all of them, given one or more reference views the user has
// already rotated the way they like.
//
// Pure math, NO imports: it takes Camera-like objects (`rotationMatrix`,
// `tvec`, `matrix`, optional `distortPoint` / `undistortPoint` — exactly the
// `Camera` class in `pose/pose-data.js`) and plain `{ cameraName: degrees }`
// maps, so it runs unchanged in Node (`tests/test-view-align.mjs`).
//
// ## What a reference says
//
// Fixing which way is screen-up in ONE view pins a 3D direction down only to a
// plane: every direction through the scene centre `P` that lies in the plane
// spanned by the camera's sight line and its screen-up direction projects to
// straight up. Each reference therefore contributes:
//   - its screen-up PLANE (normal `n`) — "up is somewhere in here", and
//   - its own 3D up vector `up` (in that plane, perpendicular to the sight
//     line) — "and, all else equal, about here".
//
// ## The solve, per camera
//
// For each camera k, find the unit direction `U` minimizing
//
//     (1/N) Σ_j (U·n_j)²   −   2λ U·(Σ_j w_jk up_j / Σ_j w_jk)
//
// over unit `U` (a 3x3 trust-region problem, solved exactly in `fitUp`), then
// rotate the view so `U` points up on screen. `w_jk = 1/(φ³ + ε)`, φ = angle
// between reference j's and camera k's sight lines, so nearer references win
// ties. The planes are NOT distance-weighted: they are facts about one global
// direction, and down-weighting a far reference's plane lets the tie-break
// drag a clean intersection several degrees off (measured: up to ~4° on a
// ring).
//
// The plane terms dominate (λ is small). Two references with DIFFERENT planes
// fix `U` exactly at the planes' intersection — e.g. side cameras around a
// ring all agree on gravity, and every view gets gravity up. When the planes
// COINCIDE — the natural pair on both real rigs this was tried on (HardFight,
// Mimica): a central top camera and a central front camera, both in the rig's
// symmetry plane — the plane terms leave a whole plane of choices and the
// λ-term picks, within it, the direction along the weighted SUM of the
// references' up vectors. (It must be the sum, not squared alignments: a top
// view's up is horizontal and a front view's is vertical, both are right, and
// only their sum — the diagonal — projects up in both.) That is what the issue's mockups show: side cameras keep
// gravity up, overhead cameras keep the arena's layout. A single reference
// reduces to "make this camera's up as close as possible to the reference's".
// Near-coincident planes blend smoothly between the two regimes instead of
// failing.
//
// Earlier versions (1) intersected two planes globally — and refused exactly
// the real rigs' natural pairs — and (2) carried the reference's orientation
// along the shortest orbit between sight lines, which twists cameras around a
// ring that look slightly down (the shortest orbit passes over the top), up to
// upside down opposite the reference.
//
// ## Consistency
//
// For each pair of references the same solve (weights equal) predicts each
// one's angle; the worst miss is reported as `disagreementDeg`, and a miss
// over `UPSIDE_DOWN_DEG` is refused — one reference is upside down relative
// to the other, and blending would turn the views in between arbitrarily.
//
// ## Display convention
//
// `view.rotation` is applied as CSS `rotate(θ deg)` on a y-down screen, i.e.
// CLOCKWISE for positive θ (`loading/video.js` `applyZoom`). An image-space
// direction `d` (pixels, y down) is shown on screen as `Rot(θ)·d`, so the image
// direction that appears as screen-up `(0,-1)` is `(-sin θ, -cos θ)`, and the
// rotation that makes a given image direction `d` point up is
// `θ = atan2(-dx, -dy)`.
//
// Directions are measured at the projection of `P` through the lens-distortion
// model (`distortPoint`), so "up" is up where the real image shows the scene.

// Weight λ of the "toward the references' own up vectors" term relative to
// the plane terms: small, so it only decides where the planes leave freedom.
// It biases a clean intersection slightly (≤0.4° on the synthetic rings, below
// the integer-degree store). The real rigs' answers move <1° for λ anywhere in
// 0.003..0.03, so the choice is not delicate.
export const UP_PULL = 0.003;
// A camera whose sight line is within ~5° of `U` sees it nearly end-on, so
// its projected direction — and therefore its rotation — would be noise.
export const MAX_LINE_OF_SIGHT_ALIGNMENT = Math.cos(5 * Math.PI / 180);
// References disagreeing by more than this are refused as upside down
// relative to each other.
export const UPSIDE_DOWN_DEG = 120;

// --- tiny vector helpers -----------------------------------------------------

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a) { return Math.sqrt(dot(a, a)); }
function unit(a) { var n = norm(a); return n > 0 ? scale(a, 1 / n) : [0, 0, 0]; }
// R is world->camera, so R^T maps a camera-frame vector into the world.
function mulT(R, v) {
    return [
        R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2],
        R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2],
        R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2],
    ];
}
function mul(R, v) {
    return [
        R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
        R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
        R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
    ];
}
/** Wrap degrees into (-180, 180]. */
export function wrapDeg(d) {
    d = ((d % 360) + 360) % 360;
    if (d > 180) d -= 360;
    return d === 0 ? 0 : d;  // no -0
}

// --- camera geometry -----------------------------------------------------------

/** World-space camera centre, `C = -R^T t`. */
export function cameraCenterWorld(cam) {
    return scale(mulT(cam.rotationMatrix, cam.tvec), -1);
}

/** World-space optical axis (unit), `R^T [0,0,1]`. */
export function opticalAxisWorld(cam) {
    return unit(mulT(cam.rotationMatrix, [0, 0, 1]));
}

/**
 * Project a world point into the camera's native (distorted) pixel space.
 * Returns `null` for a point at or behind the camera — the caller must not read
 * a direction off a projection that has flipped through infinity.
 */
export function projectToImage(cam, X) {
    var Xc = add(mul(cam.rotationMatrix, X), cam.tvec);
    if (!(Xc[2] > 1e-12)) return null;
    var K = cam.matrix;
    var x = Xc[0] / Xc[2], y = Xc[1] / Xc[2];
    var ideal = [K[0][0] * x + K[0][1] * y + K[0][2], K[1][1] * y + K[1][2]];
    return cam.distortPoint ? cam.distortPoint(ideal) : ideal;
}

/** World-space direction (unit) of the ray through a native pixel. */
export function backProjectToWorldDir(cam, uv) {
    var p = cam.undistortPoint ? cam.undistortPoint(uv) : uv;
    var K = cam.matrix;
    var y = (p[1] - K[1][2]) / K[1][1];
    var x = (p[0] - K[0][2] - K[0][1] * y) / K[0][0];
    return unit(mulT(cam.rotationMatrix, [x, y, 1]));
}

// --- display rotation <-> image direction ------------------------------------

/** Image-space unit direction (y down) that a view rotated `deg` shows as screen-up. */
export function screenUpImageDir(deg) {
    var t = deg * Math.PI / 180;
    return [-Math.sin(t), -Math.cos(t)];
}

/** Rotation (degrees, in (-180, 180]) that makes image direction `d` point screen-up. */
export function rotationForImageDir(d) {
    return wrapDeg(Math.atan2(-d[0], -d[1]) * 180 / Math.PI);
}

// --- scene centre ------------------------------------------------------------

/**
 * The point closest (least squares) to every camera's optical axis — where the
 * rig is aimed. Calibration-only on purpose: it needs no labels or triangulated
 * data, so it behaves identically on a fresh session and on a lazily-loaded
 * project whose frames are not resident.
 *
 * @returns {{ok:true, center:number[]}|{ok:false, error:string}}
 */
export function estimateSceneCenter(cameras) {
    if (!cameras || cameras.length < 2) {
        return { ok: false, error: 'At least two calibrated cameras are needed.' };
    }
    var A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    var b = [0, 0, 0];
    for (var i = 0; i < cameras.length; i++) {
        var C = cameraCenterWorld(cameras[i]);
        var d = opticalAxisWorld(cameras[i]);
        // (I - d d^T) projects onto the plane perpendicular to the axis; summing
        // it gives the normal equations of "minimize squared distance to every axis".
        for (var r = 0; r < 3; r++) {
            for (var c = 0; c < 3; c++) {
                var m = (r === c ? 1 : 0) - d[r] * d[c];
                A[r][c] += m;
                b[r] += m * C[c];
            }
        }
    }
    var det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
            - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
            + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
    var tr3 = (A[0][0] + A[1][1] + A[2][2]) / 3;
    // Scale-free conditioning test: det / (mean eigenvalue)^3 is ~ (27/8)·sin²α
    // for axes spread by α. 0.003 ≈ all axes within ~1.7° of parallel, where the
    // depth of the "intersection" is meaningless.
    if (!(tr3 > 0) || !(det / (tr3 * tr3 * tr3) > 0.003)) {
        return { ok: false, error: 'The cameras all point in nearly the same direction, so there is no well-defined scene centre to align on.' };
    }
    var inv = 1 / det;
    var Ai = [
        [(A[1][1] * A[2][2] - A[1][2] * A[2][1]) * inv, (A[0][2] * A[2][1] - A[0][1] * A[2][2]) * inv, (A[0][1] * A[1][2] - A[0][2] * A[1][1]) * inv],
        [(A[1][2] * A[2][0] - A[1][0] * A[2][2]) * inv, (A[0][0] * A[2][2] - A[0][2] * A[2][0]) * inv, (A[0][2] * A[1][0] - A[0][0] * A[1][2]) * inv],
        [(A[1][0] * A[2][1] - A[1][1] * A[2][0]) * inv, (A[0][1] * A[2][0] - A[0][0] * A[2][1]) * inv, (A[0][0] * A[1][1] - A[0][1] * A[1][0]) * inv],
    ];
    return { ok: true, center: mul(Ai, b) };
}

// --- the solve -----------------------------------------------------------------

/**
 * Image-space direction (unit) of world direction `U` at world point `P` in
 * `cam`, via a central difference so it honours perspective and distortion.
 * `null` when `P` (or the tiny segment around it) is not in front of the camera.
 */
function projectedDirection(cam, P, U) {
    var s = 1e-3 * Math.max(norm(sub(P, cameraCenterWorld(cam))), 1e-9);
    var a = projectToImage(cam, add(P, scale(U, -s)));
    var b = projectToImage(cam, add(P, scale(U, s)));
    if (!a || !b) return null;
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var n = Math.sqrt(dx * dx + dy * dy);
    return n > 0 ? [dx / n, dy / n] : null;
}

/**
 * A reference's oriented view at `P`: its sight direction `v` (camera -> P),
 * the world direction `up` (perpendicular to `v`) its display, rotated `deg`,
 * shows as screen-up, and the normal `n` of the plane they span. `null` if
 * `P` is behind it.
 */
function referenceFrame(cam, deg, P) {
    var p = projectToImage(cam, P);
    if (!p) return null;
    var upImg = screenUpImageDir(deg);
    // A short step along screen-up, local enough that distortion is ~linear.
    var step = 1e-2 * (Math.abs(cam.matrix[0][0]) || 1);
    var v = unit(sub(P, cameraCenterWorld(cam)));
    var r2 = backProjectToWorldDir(cam, [p[0] + upImg[0] * step, p[1] + upImg[1] * step]);
    // The ray to a point slightly ABOVE P on screen, minus its component along
    // the sight line, points "up" in 3D — no sign fix-up needed.
    var up = unit(sub(r2, scale(v, dot(r2, v))));
    return { v: v, up: up, n: unit(cross(v, up)) };
}

/** Eigen-decomposition of a symmetric 3x3 (cyclic Jacobi): `{values, vectors}` (vectors as columns). */
function eigenSym3(M) {
    var A = [M[0].slice(), M[1].slice(), M[2].slice()];
    var V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var sweep = 0; sweep < 50; sweep++) {
        var off = A[0][1] * A[0][1] + A[0][2] * A[0][2] + A[1][2] * A[1][2];
        var diag = A[0][0] * A[0][0] + A[1][1] * A[1][1] + A[2][2] * A[2][2];
        if (off <= 1e-30 * (diag + 1e-300)) break;
        for (var p = 0; p < 2; p++) {
            for (var q = p + 1; q < 3; q++) {
                if (A[p][q] === 0) continue;
                var theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
                var t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                var c = 1 / Math.sqrt(t * t + 1), s = t * c;
                for (var k = 0; k < 3; k++) {
                    var akp = A[k][p], akq = A[k][q];
                    A[k][p] = c * akp - s * akq;
                    A[k][q] = s * akp + c * akq;
                }
                for (var k2 = 0; k2 < 3; k2++) {
                    var apk = A[p][k2], aqk = A[q][k2];
                    A[p][k2] = c * apk - s * aqk;
                    A[q][k2] = s * apk + c * aqk;
                }
                for (var k3 = 0; k3 < 3; k3++) {
                    var vkp = V[k3][p], vkq = V[k3][q];
                    V[k3][p] = c * vkp - s * vkq;
                    V[k3][q] = s * vkp + c * vkq;
                }
            }
        }
    }
    return {
        values: [A[0][0], A[1][1], A[2][2]],
        vectors: [0, 1, 2].map(function (i) { return [V[0][i], V[1][i], V[2][i]]; }),
    };
}

/**
 * The direction `U` that should point screen-up, from reference frames with
 * weights: minimize  Σ w (U·n)²  −  2λ U·m,  m = Σ w·up,  |U| = 1.
 *
 * Stationarity gives (A − μI)U = λm with A = Σ w n nᵀ and μ below A's smallest
 * eigenvalue (the global minimum of this trust-region problem), so in A's
 * eigenbasis U_i = λ m_i / (a_i − μ) and μ is found by bisection on |U| = 1.
 * `null` when the references' up vectors cancel out.
 */
function fitUp(frames, weights) {
    var A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    var m = [0, 0, 0];
    var wsum = 0;
    for (var w0 = 0; w0 < weights.length; w0++) wsum += weights[w0] > 0 ? weights[w0] : 0;
    if (!(wsum > 0)) return null;
    for (var j = 0; j < frames.length; j++) {
        var n = frames[j].n;
        var w = weights[j] > 0 ? weights[j] / wsum : 0;
        for (var r = 0; r < 3; r++) {
            // Planes: every reference equally (see the header).
            for (var c = 0; c < 3; c++) A[r][c] += n[r] * n[c] / frames.length;
            m[r] += w * frames[j].up[r];
        }
    }
    var lm = scale(m, UP_PULL);
    var lmNorm = norm(lm);
    if (!(lmNorm > 1e-12)) return null;
    var eig = eigenSym3(A);
    var a = eig.values;
    var mi = eig.vectors.map(function (e) { return dot(lm, e); });
    var amin = Math.min(a[0], a[1], a[2]);
    function sizeAt(mu) {
        var s2 = 0;
        for (var i = 0; i < 3; i++) { var x = mi[i] / (a[i] - mu); s2 += x * x; }
        return Math.sqrt(s2);
    }
    // |U(μ)| ≤ |λm| / (amin − μ), so μ = amin − |λm| gives |U| ≤ 1; |U| grows
    // without bound as μ -> amin from below (unless m ⟂ that eigenvector).
    var lo = amin - lmNorm, hi = amin;
    for (var it = 0; it < 200; it++) {
        var mid = 0.5 * (lo + hi);
        if (mid === lo || mid === hi) break;
        if (sizeAt(mid) > 1) hi = mid; else lo = mid;
    }
    var U = [0, 0, 0];
    for (var i2 = 0; i2 < 3; i2++) U = add(U, scale(eig.vectors[i2], mi[i2] / (a[i2] - lo)));
    var len = norm(U);
    if (len < 1 - 1e-6) {
        // "Hard case": m has no component along the smallest eigenvector, so the
        // remainder of the unit length goes there. Its sign is free; take the one
        // that agrees with the up vectors' sum, which is zero here — either.
        var kmin = a.indexOf(amin);
        U = add(U, scale(eig.vectors[kmin], Math.sqrt(Math.max(0, 1 - len * len))));
    }
    return unit(U);
}

// Cubic, not quadratic: with 1/φ² a level side camera 45° round from a front
// reference still took ~14° of a top reference's horizontal up (synthetic
// top+front rig in tests/test-view-align.mjs); 1/φ³ keeps it under 10° and
// moves the real rigs' answers by under 2°.
function proximityWeight(va, vb) {
    var phi = Math.atan2(norm(cross(va, vb)), dot(va, vb));
    return 1 / (phi * phi * phi + 1e-6);
}

/**
 * Compute aligned display rotations.
 *
 * @param {Camera[]} cameras        the session's cameras (calibrated)
 * @param {Object<string,number>} rotations  current rotation (deg) per camera
 *                                  name; only the references' entries are read
 * @param {string[]} referenceNames two or more reference cameras
 * @param {{center?:number[]}} [opts]  override the scene centre (else estimated
 *                                  from the optical axes)
 * @returns {{ok:false, error:string} | {
 *     ok:true, center:number[],
 *     rotations:Object<string,number>,  // fractional degrees, references unchanged
 *     skipped:{name:string, reason:string}[],
 *     disagreementDeg:number,           // worst pairwise reference mismatch
 * }}
 */
export function alignViewRotations(cameras, rotations, referenceNames, opts) {
    rotations = rotations || {};
    var refs = (referenceNames || []).filter(function (n, i, a) { return a.indexOf(n) === i; });
    if (refs.length < 2) return { ok: false, error: 'Pick at least two reference views.' };
    var byName = {};
    for (var i = 0; i < cameras.length; i++) byName[cameras[i].name] = cameras[i];
    for (var r = 0; r < refs.length; r++) {
        if (!byName[refs[r]]) return { ok: false, error: 'Reference camera "' + refs[r] + '" is not in this session.' };
    }

    var P;
    if (opts && opts.center) {
        P = opts.center;
    } else {
        var est = estimateSceneCenter(cameras);
        if (!est.ok) return est;
        P = est.center;
    }

    var frames = [];
    for (var f = 0; f < refs.length; f++) {
        var deg = wrapDeg(Number(rotations[refs[f]]) || 0);
        var fr = referenceFrame(byName[refs[f]], deg, P);
        if (!fr) return { ok: false, error: 'The scene centre is behind reference camera "' + refs[f] + '".' };
        frames.push({ name: refs[f], cam: byName[refs[f]], deg: deg, v: fr.v, up: fr.up, n: fr.n });
    }

    // Pairwise consistency: solve from each pair alone (equal weights) and see
    // how far that lands from the angle the user gave each of the two.
    var worst = 0, worstPair = null;
    for (var a = 0; a < frames.length; a++) {
        for (var b = a + 1; b < frames.length; b++) {
            var pair = [frames[a], frames[b]];
            var Uab = fitUp(pair, [1, 1]);
            if (!Uab) { worst = 180; worstPair = [pair[0].name, pair[1].name]; continue; }
            for (var e = 0; e < 2; e++) {
                var d = projectedDirection(pair[e].cam, P, Uab);
                if (!d || Math.abs(dot(Uab, pair[e].v)) > MAX_LINE_OF_SIGHT_ALIGNMENT) continue;
                var miss = Math.abs(wrapDeg(rotationForImageDir(d) - pair[e].deg));
                if (miss > worst) { worst = miss; worstPair = [pair[0].name, pair[1].name]; }
            }
        }
    }
    if (worst > UPSIDE_DOWN_DEG) {
        return {
            ok: false,
            error: '"' + worstPair[0] + '" and "' + worstPair[1] + '" disagree about which way is up by about ' +
                Math.round(worst) + '° — one of them looks upside down relative to the other. ' +
                'Turn one of them around, or untick it.',
        };
    }

    var out = {};
    var skipped = [];
    for (var k = 0; k < cameras.length; k++) {
        var cam = cameras[k];
        if (refs.indexOf(cam.name) >= 0) { out[cam.name] = wrapDeg(Number(rotations[cam.name]) || 0); continue; }
        if (!projectToImage(cam, P)) {
            skipped.push({ name: cam.name, reason: 'the scene centre is behind this camera' });
            continue;
        }
        var vk = unit(sub(P, cameraCenterWorld(cam)));
        var weights = frames.map(function (fj) { return proximityWeight(fj.v, vk); });
        var U = fitUp(frames, weights);
        if (!U) {
            skipped.push({ name: cam.name, reason: 'the references point opposite ways here' });
            continue;
        }
        if (Math.abs(dot(U, vk)) > MAX_LINE_OF_SIGHT_ALIGNMENT) {
            skipped.push({ name: cam.name, reason: 'it looks almost straight along the up direction' });
            continue;
        }
        var dk = projectedDirection(cam, P, U);
        if (!dk) {
            skipped.push({ name: cam.name, reason: 'the scene centre is behind this camera' });
            continue;
        }
        out[cam.name] = rotationForImageDir(dk);
    }
    return { ok: true, center: P, rotations: out, skipped: skipped, disagreementDeg: worst };
}
