// pose/calibration-compare.js — do the sessions of a multi-session project
// agree about where the world is?
//
// A multi-session project loads one session per subfolder, and each subfolder
// carries its own calibration. Nothing makes them agree. Usually they are
// copies of one file and the question never comes up — but two things make them
// diverge, and the two want completely different words:
//
//  1. **A leftover `calibration-rebased.toml` in ONE session's folder.** Set as
//     New Calibration re-bases every session in memory and writes ONE file, and
//     `pickCalibrationFile` then PREFERS that file on the next load. So one
//     session comes back in the re-based frame while the rest come back in the
//     original one. Same cameras, same lenses, different origin. This is the
//     case the modal exists for, and it is recoverable: delete the file, or
//     re-base the others to match.
//  2. **Sessions genuinely calibrated apart** — a rig moved, or a camera was
//     re-focused between recordings. Different lenses, or extrinsics that do
//     not relate by one rigid motion. Nothing is recoverable by moving a file;
//     the 3D of those sessions simply is not in a shared space.
//
// Telling them apart is a measurement, not a guess. For one physical camera
// described by two calibrations A and B, a world point obeys
//
//     x = R_A·p_A + t_A        and        x = R_B·p_B + t_B
//
// so if the two worlds are related at all, they are related by
// `p_A = R_f·p_B + t_f`, and substituting gives
//
//     R_f = R_Aᵀ·R_B           t_f = R_Aᵀ·(t_B − t_A)
//
// computed per camera. If EVERY camera agrees on `(R_f, t_f)`, the two
// calibrations differ only by where the origin is — case 1, and `t_f` is
// literally the position of B's origin in A's coordinates, which is the number
// worth quoting. If the cameras disagree, no single frame change explains them
// and it is case 2. On the real `small_multi_session` folder the eight cameras
// agree to 3e-14 in rotation and 5e-13 mm in translation, which is why the
// spread tolerances below can be loose and still decide the question.
//
// DOM-free, and its only import is the rotation maths it would otherwise
// duplicate, so `tests/test-calibration-compare.mjs` can run it under Node.

import { rotationAboutAxis, rotationMatrixToAxisAngle, normalize3 } from './origin-frame.js?v=7c6023efb126';

// "The same number", for values that came from parsing the same file twice, or
// from one f64 round trip through a `.slp`. Deliberately not `===`: a TOML
// re-export prints 15 significant digits and the last bit can move.
var ROT_TOL = 1e-9;          // max abs entry difference between rotation matrices
var TRANS_TOL = 1e-6;        // mm
var INTRINSIC_REL_TOL = 1e-9; // relative — focal lengths here are ~800

// "One rigid frame change explains every camera." Far looser than the
// equality tolerances above, because this is separating a re-base (agreement to
// ~1e-13) from two independent calibrations (disagreement of whole millimetres
// and degrees). Loose enough to survive a calibration that went through a
// float32 file on the way; tight enough that two real rigs never pass.
var FRAME_ROT_SPREAD = 1e-6;
var FRAME_TRANS_SPREAD = 1e-3; // mm

var IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * The 3x3 world→camera rotation, whatever shape the camera keeps it in.
 *
 * A `Camera` memoizes one on `rotationMatrix`; a plain test fixture or a
 * freshly parsed anipose TOML may carry either a Rodrigues `rvec` or a 3x3
 * matrix under the same `rvec` name. `rotationAboutAxis` IS the Rodrigues
 * formula with the angle separated out, so an `rvec` converts by handing it the
 * vector and its own magnitude — no second copy of the formula lives here.
 */
function rotOf(cam) {
    if (!cam) return null;
    if (cam.rotationMatrix) return cam.rotationMatrix;
    var r = cam.rvec;
    if (!r || !r.length) return null;
    if (Array.isArray(r[0])) return r;
    var th = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
    if (!isFinite(th)) return null;
    if (th < 1e-12) return IDENTITY;
    return rotationAboutAxis(r, th);
}

function tvecOf(cam) {
    var t = cam && (cam.tvec || cam.translation);
    if (!t || t.length < 3) return null;
    if (!isFinite(t[0]) || !isFinite(t[1]) || !isFinite(t[2])) return null;
    return [t[0], t[1], t[2]];
}

function sameRot(a, b) {
    if (!a || !b) return false;
    for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) {
            if (Math.abs(a[i][j] - b[i][j]) > ROT_TOL) return false;
        }
    }
    return true;
}

function sameTrans(a, b) {
    if (!a || !b) return false;
    for (var i = 0; i < 3; i++) if (Math.abs(a[i] - b[i]) > TRANS_TOL) return false;
    return true;
}

/** Relative comparison of two flat or nested numeric arrays. */
function sameNumbers(a, b) {
    var fa = flatten(a), fb = flatten(b);
    if (fa === null || fb === null) return fa === fb;
    if (fa.length !== fb.length) return false;
    for (var i = 0; i < fa.length; i++) {
        var scale = Math.max(1, Math.abs(fa[i]), Math.abs(fb[i]));
        if (Math.abs(fa[i] - fb[i]) > INTRINSIC_REL_TOL * scale) return false;
    }
    return true;
}

function flatten(v) {
    if (v == null) return null;
    if (!Array.isArray(v)) return [v];
    var out = [];
    for (var i = 0; i < v.length; i++) {
        if (Array.isArray(v[i])) {
            for (var j = 0; j < v[i].length; j++) out.push(v[i][j]);
        } else {
            out.push(v[i]);
        }
    }
    return out;
}

/** Intrinsics, distortion and image size: the lens, which an origin never moves. */
function sameLens(a, b) {
    return sameNumbers(a.matrix, b.matrix)
        && sameNumbers(a.dist || a.distortions, b.dist || b.distortions)
        && sameNumbers(a.size, b.size);
}

function mulT(A, B) {
    // Aᵀ·B
    var out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (var r = 0; r < 3; r++) {
        for (var c = 0; c < 3; c++) {
            var s = 0;
            for (var k = 0; k < 3; k++) s += A[k][r] * B[k][c];
            out[r][c] = s;
        }
    }
    return out;
}

function mulTVec(A, v) {
    // Aᵀ·v
    return [
        A[0][0] * v[0] + A[1][0] * v[1] + A[2][0] * v[2],
        A[0][1] * v[0] + A[1][1] * v[1] + A[2][1] * v[2],
        A[0][2] * v[0] + A[1][2] * v[1] + A[2][2] * v[2],
    ];
}

/**
 * Index a session's cameras by name, dropping any whose geometry cannot be
 * read. A camera with a broken rotation is not evidence of anything, and
 * letting it through would make one malformed entry look like a divergence.
 */
function indexCameras(session) {
    var byName = {};
    var names = [];
    var cams = (session && session.cameras) || [];
    for (var i = 0; i < cams.length; i++) {
        var c = cams[i];
        if (!c || !c.name) continue;
        var R = rotOf(c), t = tvecOf(c);
        if (!R || !t) continue;
        if (byName[c.name]) continue; // first wins; a duplicate name is not a second camera
        byName[c.name] = { name: c.name, R: R, t: t, matrix: c.matrix, dist: c.dist, size: c.size };
        names.push(c.name);
    }
    names.sort();
    return { byName: byName, names: names };
}

function sameCalibration(a, b) {
    if (a.names.length !== b.names.length) return false;
    for (var i = 0; i < a.names.length; i++) {
        if (a.names[i] !== b.names[i]) return false;
        var ca = a.byName[a.names[i]], cb = b.byName[b.names[i]];
        if (!sameLens(ca, cb)) return false;
        if (!sameRot(ca.R, cb.R)) return false;
        if (!sameTrans(ca.t, cb.t)) return false;
    }
    return true;
}

/**
 * Is one rigid change of world frame enough to explain every shared camera?
 *
 * @returns {{rigid: boolean, origin: number[], distanceMm: number,
 *            angleDeg: number, axis: number[], spreadRot: number,
 *            spreadTransMm: number, cameras: number}|null}
 *   null when there is nothing to compare. `origin` is where THIS calibration's
 *   origin sits in the reference's coordinates.
 */
function frameChange(ref, other, shared) {
    if (!shared.length) return null;
    var Rs = [], ts = [];
    for (var i = 0; i < shared.length; i++) {
        var a = ref.byName[shared[i]], b = other.byName[shared[i]];
        Rs.push(mulT(a.R, b.R));
        ts.push(mulTVec(a.R, [b.t[0] - a.t[0], b.t[1] - a.t[1], b.t[2] - a.t[2]]));
    }
    // Spread against the first camera's answer. A max-vs-first spread is enough
    // to reject disagreement and avoids inventing an average frame that no
    // camera actually reports.
    var spreadR = 0, spreadT = 0;
    for (var k = 1; k < Rs.length; k++) {
        for (var r = 0; r < 3; r++) {
            for (var c = 0; c < 3; c++) {
                var d = Math.abs(Rs[k][r][c] - Rs[0][r][c]);
                if (d > spreadR) spreadR = d;
            }
            var dt = Math.abs(ts[k][r] - ts[0][r]);
            if (dt > spreadT) spreadT = dt;
        }
    }
    var aa = rotationMatrixToAxisAngle(Rs[0]);
    return {
        rigid: spreadR <= FRAME_ROT_SPREAD && spreadT <= FRAME_TRANS_SPREAD,
        origin: ts[0],
        distanceMm: Math.sqrt(ts[0][0] * ts[0][0] + ts[0][1] * ts[0][1] + ts[0][2] * ts[0][2]),
        angleDeg: aa.angleRad * 180 / Math.PI,
        axis: normalize3(aa.axis) || [1, 0, 0],
        spreadRot: spreadR,
        spreadTransMm: spreadT,
        cameras: shared.length,
    };
}

/**
 * Compare every session's calibration and report what, if anything, disagrees.
 *
 * Sessions are grouped by identical calibration, and every group but the
 * largest is described relative to it — so with three sessions agreeing and one
 * odd, the odd one is the one the report talks about. Ties go to the
 * earliest-loaded group, which keeps the wording stable across reloads.
 *
 * @param {Array<Object>} sessions - `state.sessions`; each needs `.cameras` and
 *   ideally `.name`.
 * @returns {{
 *   ok: boolean,
 *   sessionCount: number,
 *   comparedCount: number,
 *   withoutCalibration: string[],
 *   groups: Array<{sessions: string[], cameraCount: number, cameraNames: string[]}>,
 *   reference: number,
 *   diffs: Array<Object>,
 *   frameOnly: boolean,
 * }} `ok` is true when there is nothing to tell the user: fewer than two
 *   comparable sessions, or every one of them agreeing. `frameOnly` is true
 *   when every difference found is a rigid change of origin and nothing else —
 *   the recoverable case.
 */
export function compareSessionCalibrations(sessions) {
    var list = sessions || [];
    var withoutCalibration = [];
    var indexed = [];
    for (var i = 0; i < list.length; i++) {
        var s = list[i];
        var name = (s && s.name) || ('Session ' + (i + 1));
        var idx = indexCameras(s);
        if (!idx.names.length) { withoutCalibration.push(name); continue; }
        idx.sessionName = name;
        indexed.push(idx);
    }

    var report = {
        ok: true,
        sessionCount: list.length,
        comparedCount: indexed.length,
        withoutCalibration: withoutCalibration,
        groups: [],
        reference: 0,
        diffs: [],
        frameOnly: false,
    };
    if (indexed.length < 2) return report;

    // ---- group by identical calibration -------------------------------
    var groups = [];
    for (var g = 0; g < indexed.length; g++) {
        var placed = false;
        for (var q = 0; q < groups.length; q++) {
            if (sameCalibration(groups[q].rep, indexed[g])) {
                groups[q].sessions.push(indexed[g].sessionName);
                placed = true;
                break;
            }
        }
        if (!placed) {
            groups.push({ rep: indexed[g], sessions: [indexed[g].sessionName] });
        }
    }
    report.groups = groups.map(function (gr) {
        return {
            sessions: gr.sessions.slice(),
            cameraCount: gr.rep.names.length,
            cameraNames: gr.rep.names.slice(),
        };
    });
    if (groups.length < 2) return report;

    // ---- the reference is the largest group, earliest on a tie --------
    var refI = 0;
    for (var m = 1; m < groups.length; m++) {
        if (groups[m].sessions.length > groups[refI].sessions.length) refI = m;
    }
    report.reference = refI;
    report.ok = false;

    var ref = groups[refI].rep;
    var allFrameOnly = true;
    for (var d = 0; d < groups.length; d++) {
        if (d === refI) continue;
        var other = groups[d].rep;

        var shared = [], onlyHere = [], onlyInReference = [];
        for (var a = 0; a < other.names.length; a++) {
            if (ref.byName[other.names[a]]) shared.push(other.names[a]);
            else onlyHere.push(other.names[a]);
        }
        for (var b = 0; b < ref.names.length; b++) {
            if (!other.byName[ref.names[b]]) onlyInReference.push(ref.names[b]);
        }

        var lensCameras = [];
        for (var c2 = 0; c2 < shared.length; c2++) {
            if (!sameLens(ref.byName[shared[c2]], other.byName[shared[c2]])) {
                lensCameras.push(shared[c2]);
            }
        }

        // Only the cameras whose LENS matches can speak about the world frame:
        // a re-focused camera's extrinsics are not a statement about the origin.
        var geomCameras = shared.filter(function (nm) { return lensCameras.indexOf(nm) < 0; });
        var fc = frameChange(ref, other, geomCameras);

        var kind;
        if (onlyHere.length || onlyInReference.length) kind = 'cameras';
        else if (lensCameras.length) kind = 'lens';
        else if (fc && fc.rigid) kind = 'origin';
        else kind = 'extrinsics';
        if (kind !== 'origin') allFrameOnly = false;

        report.diffs.push({
            group: d,
            sessions: groups[d].sessions.slice(),
            kind: kind,
            sharedCameras: shared.length,
            onlyHere: onlyHere,
            onlyInReference: onlyInReference,
            lensCameras: lensCameras,
            frame: fc,
        });
    }
    report.frameOnly = allFrameOnly;
    return report;
}
