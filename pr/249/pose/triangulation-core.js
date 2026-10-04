/**
 * triangulation-core.js — the pure triangulation math, split out of
 * `pose/triangulation.js` so a Web Worker can load it.
 *
 * Everything here depends only on `./pose-data.js` (which has no imports), so
 * `pose/triangulation-worker.js` can run the SAME `triangulateAndReproject` the
 * main thread runs — DLT, the "Refined" point stage, reprojection and errors —
 * and produce bit-identical results. `pose/triangulation.js` re-exports every
 * public name here, so no other module's imports change.
 *
 * The only app state the pipeline reads is two settings — whether a camera is
 * included in tracking (Tracking Wizard ▸ Camera Views) and the reprojection
 * error threshold. They are reached through `setTriangulationSettingsHooks`,
 * which `pose/triangulation.js` installs on the main thread. A worker installs
 * none and always receives the resolved values as `options.includedCameras` /
 * `options.reprojErrorThreshold` instead.
 */

import { makePoints3d, points3dNodeCount, hasPoint3d, getPoint3d, readPoint3d, setPoint3d, clearPoint3d } from './pose-data.js?v=858caeb3297a';

// Settings readers for `triangulateAndReproject` (see the header). Unset means
// "every camera included, no threshold" — the same defaults as before the split.
const _settingsHooks = { isCameraTracked: null, getTrackingThreshold: null };
export function setTriangulationSettingsHooks(hooks) {
    _settingsHooks.isCameraTracked = (hooks && hooks.isCameraTracked) || null;
    _settingsHooks.getTrackingThreshold = (hooks && hooks.getTrackingThreshold) || null;
}

// ============================================
// Matrix utilities (minimal linear algebra)
// ============================================

/**
 * Matrix multiplication for arbitrary sized matrices.
 * A is m x n, B is n x p, result is m x p.
 * Matrices are stored as arrays of rows: A[i][j].
 *
 * @param {number[][]} A - m x n matrix
 * @param {number[][]} B - n x p matrix
 * @returns {number[][]} m x p result
 */
export function matMul(A, B) {
    const m = A.length;
    const n = A[0].length;
    const p = B[0].length;
    const C = [];
    for (let i = 0; i < m; i++) {
        C[i] = new Array(p).fill(0);
        for (let j = 0; j < p; j++) {
            let sum = 0;
            for (let k = 0; k < n; k++) {
                sum += A[i][k] * B[k][j];
            }
            C[i][j] = sum;
        }
    }
    return C;
}

/**
 * Transpose a matrix.
 * @param {number[][]} A - m x n matrix
 * @returns {number[][]} n x m transposed matrix
 */
export function matTranspose(A) {
    const m = A.length;
    const n = A[0].length;
    const T = [];
    for (let j = 0; j < n; j++) {
        T[j] = new Array(m);
        for (let i = 0; i < m; i++) {
            T[j][i] = A[i][j];
        }
    }
    return T;
}

/**
 * Jacobi eigenvalue algorithm for an NxN symmetric matrix.
 *
 * Iteratively applies Givens (Jacobi) rotations to drive off-diagonal elements
 * to zero. Converges for any real symmetric matrix. Particularly efficient and
 * robust for small matrices (4x4 in our case).
 *
 * @param {number[][]} M - NxN symmetric matrix (will not be modified)
 * @param {number} [maxIter=100] - Maximum number of sweeps
 * @param {number} [tol=1e-12] - Convergence tolerance for off-diagonal norm
 * @returns {{ eigenvalues: number[], eigenvectors: number[][] }}
 *   eigenvalues[i] is the i-th eigenvalue.
 *   eigenvectors[i] is the i-th eigenvector (column i of the rotation matrix).
 */
export function jacobiEigen(M, maxIter, tol) {
    if (maxIter === undefined) maxIter = 100;
    if (tol === undefined) tol = 1e-12;

    const n = M.length;

    // Deep copy M into A (we will modify A in-place)
    const A = [];
    for (let i = 0; i < n; i++) {
        A[i] = M[i].slice();
    }

    // V accumulates the product of all rotation matrices -> eigenvectors
    // Start with identity
    const V = [];
    for (let i = 0; i < n; i++) {
        V[i] = new Array(n).fill(0);
        V[i][i] = 1;
    }

    for (let iter = 0; iter < maxIter; iter++) {
        // Compute off-diagonal Frobenius norm
        let offDiagNorm = 0;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                offDiagNorm += A[i][j] * A[i][j];
            }
        }
        offDiagNorm = Math.sqrt(2 * offDiagNorm); // factor of 2 because symmetric

        if (offDiagNorm < tol) {
            break; // Converged
        }

        // Sweep: zero out each off-diagonal element (i < j)
        for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) {
                if (Math.abs(A[p][q]) < tol * 1e-2) {
                    continue; // Skip tiny elements
                }

                // Compute rotation angle
                const app = A[p][p];
                const aqq = A[q][q];
                const apq = A[p][q];

                let theta;
                if (Math.abs(app - aqq) < 1e-15) {
                    theta = Math.PI / 4;
                } else {
                    theta = 0.5 * Math.atan2(2 * apq, app - aqq);
                }

                const c = Math.cos(theta);
                const s = Math.sin(theta);

                // Apply rotation to A: A' = G^T A G
                // Only rows/cols p and q change

                // First, compute new values for rows p and q
                const newRowP = new Array(n);
                const newRowQ = new Array(n);
                for (let j = 0; j < n; j++) {
                    newRowP[j] = c * A[p][j] + s * A[q][j];
                    newRowQ[j] = -s * A[p][j] + c * A[q][j];
                }
                for (let j = 0; j < n; j++) {
                    A[p][j] = newRowP[j];
                    A[q][j] = newRowQ[j];
                }

                // Now columns p and q
                const newColP = new Array(n);
                const newColQ = new Array(n);
                for (let i = 0; i < n; i++) {
                    newColP[i] = c * A[i][p] + s * A[i][q];
                    newColQ[i] = -s * A[i][p] + c * A[i][q];
                }
                for (let i = 0; i < n; i++) {
                    A[i][p] = newColP[i];
                    A[i][q] = newColQ[i];
                }

                // Accumulate rotation into V
                for (let i = 0; i < n; i++) {
                    const vip = V[i][p];
                    const viq = V[i][q];
                    V[i][p] = c * vip + s * viq;
                    V[i][q] = -s * vip + c * viq;
                }
            }
        }
    }

    // Extract eigenvalues from diagonal of A, eigenvectors from columns of V
    const eigenvalues = new Array(n);
    const eigenvectors = [];
    for (let i = 0; i < n; i++) {
        eigenvalues[i] = A[i][i];
        eigenvectors[i] = new Array(n);
        for (let j = 0; j < n; j++) {
            eigenvectors[i][j] = V[j][i]; // column i of V
        }
    }

    return { eigenvalues: eigenvalues, eigenvectors: eigenvectors };
}

/**
 * For a 4x4 symmetric matrix M, find the eigenvector corresponding to the
 * smallest eigenvalue.
 *
 * @param {number[][]} M - 4x4 symmetric matrix
 * @returns {number[]} 4-element eigenvector (unit length)
 */
export function solveSmallestEigenvector4x4(M) {
    const result = jacobiEigen(M);
    const evals = result.eigenvalues;
    const evecs = result.eigenvectors;

    // Find index of smallest eigenvalue (by absolute value for numerical safety,
    // but since M = A^T A is positive semi-definite, eigenvalues are >= 0,
    // so smallest absolute value == smallest value)
    let minIdx = 0;
    let minVal = Math.abs(evals[0]);
    for (let i = 1; i < evals.length; i++) {
        if (Math.abs(evals[i]) < minVal) {
            minVal = Math.abs(evals[i]);
            minIdx = i;
        }
    }

    return evecs[minIdx];
}

/**
 * SVD-based null-space solver for the DLT system.
 *
 * Given a (2N x 4) matrix A, computes M = A^T * A (4x4 symmetric) and finds
 * the eigenvector of M corresponding to the smallest eigenvalue. This is
 * equivalent to the right singular vector of A for its smallest singular value.
 *
 * @param {number[][]} A - (2N x 4) matrix
 * @returns {number[]} 4-element vector in the null space of A
 */
export function svd3x4(A) {
    const AT = matTranspose(A);     // 4 x 2N
    const M = matMul(AT, A);       // 4 x 4
    return solveSmallestEigenvector4x4(M);
}

// ---------------------------------------------------------------------------
// Allocation-free DLT kernel (hot path: Track All, Triangulate All).
//
// `triangulatePointDLT` used to build A as an array of row arrays, then
// `matTranspose` + `matMul` (fresh arrays) and the generic `jacobiEigen`, which
// allocates four arrays per Givens rotation. Profiled on HardFight_1kModels that
// was ~5 s of an 8.6 s DLT Triangulate All and ~5 s of Track All, mostly
// allocation and GC. The kernel below performs EXACTLY the same floating-point
// operations in the same order — the same A entries, the same k-ordered sums
// for M = AᵀA (starting from 0, as matMul does), the same rotation sequence,
// angles, row-then-column update order and skip/convergence tests, and the same
// strict-< smallest-|eigenvalue| pick — on preallocated typed arrays, so its
// result is bit-identical to `svd3x4(A)` (pinned by tests/test-dlt-kernel.mjs).
// ---------------------------------------------------------------------------
let _dltA = new Float64Array(8 * 4);
const _dltM = new Float64Array(16);
const _dltJA = new Float64Array(16);
const _dltJV = new Float64Array(16);
const _dltRowP = new Float64Array(4);
const _dltRowQ = new Float64Array(4);

/**
 * Smallest-eigenvalue eigenvector of the 4x4 symmetric `M` (flat, row-major),
 * written into `out[0..3]`. Bit-identical to
 * `solveSmallestEigenvector4x4(rows(M))` — the same Jacobi sweeps
 * (maxIter 100, tol 1e-12) as `jacobiEigen`.
 */
function smallestEigvec4Flat(M, out) {
    const maxIter = 100, tol = 1e-12, n = 4;
    const A = _dltJA, V = _dltJV, rowP = _dltRowP, rowQ = _dltRowQ;
    for (let i = 0; i < 16; i++) { A[i] = M[i]; V[i] = 0; }
    V[0] = 1; V[5] = 1; V[10] = 1; V[15] = 1;
    for (let iter = 0; iter < maxIter; iter++) {
        let offDiagNorm = 0;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                offDiagNorm += A[i * 4 + j] * A[i * 4 + j];
            }
        }
        offDiagNorm = Math.sqrt(2 * offDiagNorm);
        if (offDiagNorm < tol) break;
        for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) {
                if (Math.abs(A[p * 4 + q]) < tol * 1e-2) continue;
                const app = A[p * 4 + p];
                const aqq = A[q * 4 + q];
                const apq = A[p * 4 + q];
                let theta;
                if (Math.abs(app - aqq) < 1e-15) {
                    theta = Math.PI / 4;
                } else {
                    theta = 0.5 * Math.atan2(2 * apq, app - aqq);
                }
                const c = Math.cos(theta);
                const s = Math.sin(theta);
                for (let j = 0; j < n; j++) {
                    rowP[j] = c * A[p * 4 + j] + s * A[q * 4 + j];
                    rowQ[j] = -s * A[p * 4 + j] + c * A[q * 4 + j];
                }
                for (let j = 0; j < n; j++) {
                    A[p * 4 + j] = rowP[j];
                    A[q * 4 + j] = rowQ[j];
                }
                for (let i = 0; i < n; i++) {
                    rowP[i] = c * A[i * 4 + p] + s * A[i * 4 + q];
                    rowQ[i] = -s * A[i * 4 + p] + c * A[i * 4 + q];
                }
                for (let i = 0; i < n; i++) {
                    A[i * 4 + p] = rowP[i];
                    A[i * 4 + q] = rowQ[i];
                }
                for (let i = 0; i < n; i++) {
                    const vip = V[i * 4 + p];
                    const viq = V[i * 4 + q];
                    V[i * 4 + p] = c * vip + s * viq;
                    V[i * 4 + q] = -s * vip + c * viq;
                }
            }
        }
    }
    let minIdx = 0;
    let minVal = Math.abs(A[0]);
    for (let i = 1; i < n; i++) {
        if (Math.abs(A[i * 4 + i]) < minVal) {
            minVal = Math.abs(A[i * 4 + i]);
            minIdx = i;
        }
    }
    for (let j = 0; j < n; j++) out[j] = V[j * 4 + minIdx];
    return out;
}

/**
 * DLT null vector for observations already gathered as rows: `xs[r], ys[r]`
 * with projection matrix `Ps[r]`, r < nObs. Writes the homogeneous 4-vector
 * into `out`. Same A entries and M = AᵀA sums as building A + `svd3x4`.
 */
function dltHomogeneousFlat(xs, ys, Ps, nObs, out) {
    const rows = nObs * 2;
    if (_dltA.length < rows * 4) _dltA = new Float64Array(rows * 4 * 2);
    const A = _dltA;
    for (let idx = 0; idx < nObs; idx++) {
        const x = xs[idx], y = ys[idx], P = Ps[idx];
        const o1 = (2 * idx) * 4, o2 = (2 * idx + 1) * 4;
        A[o1] = x * P[2][0] - P[0][0];
        A[o1 + 1] = x * P[2][1] - P[0][1];
        A[o1 + 2] = x * P[2][2] - P[0][2];
        A[o1 + 3] = x * P[2][3] - P[0][3];
        A[o2] = y * P[2][0] - P[1][0];
        A[o2 + 1] = y * P[2][1] - P[1][1];
        A[o2 + 2] = y * P[2][2] - P[1][2];
        A[o2 + 3] = y * P[2][3] - P[1][3];
    }
    const M = _dltM;
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            let sum = 0;
            for (let k = 0; k < rows; k++) {
                sum += A[k * 4 + i] * A[k * 4 + j];
            }
            M[i * 4 + j] = sum;
        }
    }
    return smallestEigvec4Flat(M, out);
}
const _dltXs = [], _dltYs = [], _dltPs = [];
const _dltOut = new Float64Array(4);


// ============================================
// Core triangulation
// ============================================

/**
 * Triangulate a single 3D point from 2+ 2D observations using DLT.
 *
 * DLT formulation: for each observation (x_i, y_i) and projection matrix P_i,
 * we form two equations:
 *   x_i * P_i[2] - P_i[0] = 0   (row of A)
 *   y_i * P_i[2] - P_i[1] = 0   (row of A)
 *
 * The system Ax = 0 is solved via SVD (smallest right singular vector).
 * The solution x is a homogeneous 4-vector; we convert to 3D by dividing
 * by the last component.
 *
 * @param {(number[]|null)[]} observations - 2D points [[x1,y1], [x2,y2], ...]
 *   null entries mean the point is not visible in that camera.
 * @param {number[][][]} projectionMatrices - 3x4 projection matrices [P1, P2, ...]
 *   One per camera, same ordering as observations.
 * @returns {number[]|null} [X, Y, Z] triangulated point, or null if < 2 valid observations
 */
export function triangulatePointDLT(observations, projectionMatrices) {
    // Collect valid observation indices
    const validIndices = [];
    for (let i = 0; i < observations.length; i++) {
        if (observations[i] != null && projectionMatrices[i] != null) {
            validIndices.push(i);
        }
    }

    if (validIndices.length < 2) {
        return null;
    }

    // Rows of A (2 per observation: x·P[2] − P[0], y·P[2] − P[1]) and its null
    // vector, via the allocation-free kernel — bit-identical to building A as
    // row arrays and calling `svd3x4(A)` (see `dltHomogeneousFlat`).
    for (let idx = 0; idx < validIndices.length; idx++) {
        const i = validIndices[idx];
        _dltXs[idx] = observations[i][0];
        _dltYs[idx] = observations[i][1];
        _dltPs[idx] = projectionMatrices[i];
    }
    const xHomog = dltHomogeneousFlat(_dltXs, _dltYs, _dltPs, validIndices.length, _dltOut);
    _dltPs.length = 0;   // don't pin projection matrices between calls

    // Convert from homogeneous coordinates
    const w = xHomog[3];
    if (Math.abs(w) < 1e-10) {
        // Point at infinity or degenerate case
        return null;
    }

    return [xHomog[0] / w, xHomog[1] / w, xHomog[2] / w];
}

/**
 * Triangulate multiple keypoints from multi-view observations.
 *
 * Returns the flat `points3d` representation (see `pose-data.js`): a
 * `Float64Array(3 * nKeypoints)` where an un-triangulable keypoint is an
 * all-NaN triple rather than a `null` row.
 *
 * @param {(number[]|null)[][]} allObservations - Array of arrays, one per keypoint.
 *   allObservations[k] = [[x1,y1], [x2,y2], ...] or [null, [x2,y2], ...]
 *   (null means the keypoint is not visible in that camera)
 * @param {number[][][]} projectionMatrices - [P1, P2, ...] one per camera
 * @returns {Float64Array} Flat [X,Y,Z] per keypoint; all-NaN where untriangulable
 */
export function triangulatePoints(allObservations, projectionMatrices) {
    const results = makePoints3d(allObservations.length);
    for (let k = 0; k < allObservations.length; k++) {
        setPoint3d(results, k, triangulatePointDLT(allObservations[k], projectionMatrices));
    }
    return results;
}


// ============================================
// Point refinement ("bundle adjustment", cameras fixed)
// ============================================
//
// This is the *point* stage, and it deliberately mirrors aniposelib's
// `CameraGroup.optim_points` — which is what sleap-anipose actually runs for
// pose triangulation (`sleap_anipose.triangulate` → `triangulate_optim` →
// `optim_points`). There, as here, the cameras are held FIXED and only the 3D
// structure moves, so each keypoint is independent and the solve is a
// 3-parameter non-linear least squares per point, initialized from DLT.
//
// ## LUCID DOES NON-LINEAR TRIANGULATION ONLY. CAMERAS ARE NEVER REFINED.
//
// This is a scope decision, not a missing feature — do not "complete" it by
// re-adding joint camera+structure bundle adjustment. aniposelib's true joint
// solve is `bundle_adjust_iter`, and that is its *calibration* path: it belongs
// where calibration is produced (sleap-anipose / `slap-calibrate`, on a
// checkerboard), not in an annotation GUI. LUCID CONSUMES a calibration; it is
// not a calibration tool. Reasons this stays out:
//
//   * The calibration is an INPUT the user is entitled to trust. Silently
//     mutating extrinsics under an annotation session means the 3D a user
//     labelled against yesterday is not the 3D they get today, and every
//     already-triangulated frame in the project becomes inconsistent with the
//     new rig unless the whole project is re-solved.
//   * Metric SCALE is unobservable from images alone — a uniform similarity
//     transform of cameras plus structure reprojects identically. aniposelib only
//     escapes this because it bundle-adjusts on a rigid board and carries an
//     `errors_obj` term (weighted 2/board_square_length) that supplies the
//     reference. Animal keypoints have no such model, so a joint solve here can
//     drive reprojection error down while the geometry drifts, and it cannot fix
//     a scale error no matter how good it looks. A previous implementation had to
//     pin camera 0 and renormalize the camera-0-to-camera-1 baseline after every
//     step purely to keep the normal equations from being rank-deficient by 7.
//   * Reprojection error would then stop being a diagnostic. It is currently the
//     signal a user reads to spot a bad label or a bad calibration; if the solver
//     is free to move the cameras, low error no longer distinguishes "good
//     labels" from "cameras bent to fit bad labels".
//
// The label "Refined" ("Ref") in the UI (and `triangulationMethodLabel`) refers
// to THIS point stage, cameras fixed. It was previously called "Bundle
// Adjustment" after anipose/SLEAP's term for `optim_points`, but that name
// wrongly implied camera refinement; only the display name changed, the method
// key is still `'ba'` everywhere in code and in the saved `.slp`.
//
// DLT minimizes an *algebraic* error; this minimizes the true pixel error.
// Three properties matter, and all three were wrong before issue #113:
//
//   1. RESIDUAL SPACE. Residuals are formed in the camera's **native
//      (distorted) pixel space** — the space the detections live in, the space
//      the noise is i.i.d. in, and the space `triangulateAndReproject` reports
//      `meanError` in. aniposelib does the same: its `_error_fun_triangulation`
//      compares raw 2D against `cam.project(p3d)`, and `Camera.project` applies
//      distortion. Previously the objective was formed against *undistorted*
//      observations with an ideal pinhole projection, so BA minimized one thing
//      and the UI displayed another; with realistic radial distortion the
//      displayed error rose on 40% of instance groups.
//
//   2. ROBUST LOSS. A plain squared loss is dominated by the single worst view,
//      so one bad detection drags the 3D point toward itself. We use the same
//      soft-L1 (pseudo-Huber) loss aniposelib uses, with the same default
//      scale (`reproj_error_threshold = 15` px), applied via IRLS inside the
//      Levenberg–Marquardt normal equations.
//
//   3. MONOTONICITY ON THE REPORTED METRIC. A refinement seeded from DLT must
//      never look worse than DLT. That cannot be guaranteed by the optimizer
//      alone: the robust loss and the reported mean-of-Euclidean-distances are
//      different functions, and a step that lowers either one can raise the
//      other. So the accepted step is verified against the *reported* metric
//      and backtracked toward the DLT seed until it is non-worsening. If no
//      fraction of the step passes, the DLT point is returned unchanged. This
//      makes "BA is never worse than DLT" true by construction rather than by
//      hope.
//
// NOT changed by #113: the Levenberg–Marquardt ladder itself. It was measured
// strictly monotone in its own objective (0/3000 sum-of-squares increases) and
// converged to the local optimum (0/4000 trials left a >1e-6 relative cost gap
// versus a 500-iteration/tol=1e-16 solve). It was never the bug.

/**
 * Default soft-L1 scale, in pixels. Residuals below this are treated as inliers
 * (quadratic); beyond it the loss grows linearly. Matches aniposelib's
 * `reproj_error_threshold=15` default for `optim_points` (which sleap-anipose's
 * `slap-triangulate` re-exposes as `--reproj_error_threshold 15.0`).
 */
export const BA_ROBUST_SCALE_PX = 15;

/**
 * Jacobian of the Brown–Conrady distortion map with respect to the ideal
 * (pinhole) pixel coordinates — i.e. d(distorted u, v) / d(ideal u, v).
 *
 * `Camera.distortPoint` computes, with x = (u - cx)/fx and y = (v - cy)/fy:
 *   radial = 1 + k1 r² + k2 r⁴ + k3 r⁶
 *   xd = x·radial + 2 p1 x y + p2 (r² + 2x²)
 *   yd = y·radial + p1 (r² + 2y²) + 2 p2 x y
 *   ud = xd·fx + cx,  vd = yd·fy + cy
 * The fx/fy cancel on the diagonal and cross over on the off-diagonal.
 *
 * @param {Camera} camera
 * @param {number[]} ideal - [u, v] ideal (undistorted) pixel coordinates
 * @returns {number[][]|null} 2x2 [[du'/du, du'/dv], [dv'/du, dv'/dv]],
 *   or null when the camera has no distortion (caller should use identity).
 */
function distortJacobian(camera, ideal) {
    const d = camera && camera.dist;
    if (!d || (d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 0 &&
               (d.length < 5 || d[4] === 0))) {
        return null;
    }
    const K = camera.matrix;
    const fx = K[0][0], fy = K[1][1], cx = K[0][2], cy = K[1][2];
    const k1 = d[0], k2 = d[1], p1 = d[2], p2 = d[3], k3 = d.length > 4 ? d[4] : 0;

    const x = (ideal[0] - cx) / fx;
    const y = (ideal[1] - cy) / fy;
    const r2 = x * x + y * y;
    const radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
    // g = d(radial)/d(r²); d(radial)/dx = 2gx, d(radial)/dy = 2gy.
    const g = k1 + 2 * k2 * r2 + 3 * k3 * r2 * r2;

    const dxd_dx = radial + 2 * g * x * x + 2 * p1 * y + 6 * p2 * x;
    const dxd_dy = 2 * g * x * y + 2 * p1 * x + 2 * p2 * y;
    const dyd_dx = dxd_dy;   // symmetric for this model
    const dyd_dy = radial + 2 * g * y * y + 6 * p1 * y + 2 * p2 * x;

    return [
        [dxd_dx, (fx / fy) * dxd_dy],
        [(fy / fx) * dyd_dx, dyd_dy]
    ];
}

/**
 * Project a 3D point into a camera's **native (distorted)** pixel space and
 * return the Jacobian with respect to the 3D point. This is the residual model
 * the point refinement uses, so that it optimizes the same quantity
 * `triangulateAndReproject` reports.
 *
 * @param {number[]} point - [X, Y, Z]
 * @param {Camera} camera - needs .projectionMatrix, and .dist/.matrix for distortion
 * @returns {{u:number, v:number, Ju:number[], Jv:number[]}|null}
 */
function projectAndJacobianCamera(point, camera) {
    const pr = projectAndJacobian(point, camera.projectionMatrix);
    if (pr == null) return null;
    const D = distortJacobian(camera, [pr.u, pr.v]);
    if (D == null) return pr;   // distortion-free: ideal projection is native
    const dp = camera.distortPoint([pr.u, pr.v]);
    // Chain rule: J_native = D (2x2) · J_ideal (2x3)
    return {
        u: dp[0],
        v: dp[1],
        Ju: [
            D[0][0] * pr.Ju[0] + D[0][1] * pr.Jv[0],
            D[0][0] * pr.Ju[1] + D[0][1] * pr.Jv[1],
            D[0][0] * pr.Ju[2] + D[0][1] * pr.Jv[2]
        ],
        Jv: [
            D[1][0] * pr.Ju[0] + D[1][1] * pr.Jv[0],
            D[1][0] * pr.Ju[1] + D[1][1] * pr.Jv[1],
            D[1][0] * pr.Ju[2] + D[1][1] * pr.Jv[2]
        ]
    };
}

/**
 * Project a 3D point through a 3x4 projection matrix and compute the Jacobian
 * of the projected (u, v) with respect to the 3D point (X, Y, Z).
 *
 * @param {number[]} point - [X, Y, Z]
 * @param {number[][]} P - 3x4 projection matrix
 * @returns {{u:number, v:number, Ju:number[], Jv:number[]}|null}
 *   u, v: projected pixel coordinates.
 *   Ju: [du/dX, du/dY, du/dZ], Jv: [dv/dX, dv/dY, dv/dZ].
 *   null if the point is on/behind the principal plane (degenerate).
 */
function projectAndJacobian(point, P) {
    const X = point[0], Y = point[1], Z = point[2];
    const nu = P[0][0] * X + P[0][1] * Y + P[0][2] * Z + P[0][3];
    const nv = P[1][0] * X + P[1][1] * Y + P[1][2] * Z + P[1][3];
    const den = P[2][0] * X + P[2][1] * Y + P[2][2] * Z + P[2][3];
    if (Math.abs(den) < 1e-12) return null;

    const u = nu / den;
    const v = nv / den;

    // d(u)/d(Xj) = (P0j - u*P2j) / den ; d(v)/d(Xj) = (P1j - v*P2j) / den
    const Ju = [
        (P[0][0] - u * P[2][0]) / den,
        (P[0][1] - u * P[2][1]) / den,
        (P[0][2] - u * P[2][2]) / den
    ];
    const Jv = [
        (P[1][0] - v * P[2][0]) / den,
        (P[1][1] - v * P[2][1]) / den,
        (P[1][2] - v * P[2][2]) / den
    ];
    return { u: u, v: v, Ju: Ju, Jv: Jv };
}

// ---------------------------------------------------------------------------
// Allocation-free projection for the refinement inner loop.
//
// `triangulatePointBA` projects every view on every cost evaluation and LM
// step. Through `projectAndJacobianCamera` each projection allocated a result
// object, Ju/Jv arrays (twice), the 2x2 distortion Jacobian, an [u, v] pair for
// `distortJacobian` and another from `Camera.distortPoint` — ~11.6 s of GC in an
// 80 s Refined Triangulate All on HardFight_1kModels. These write into a
// caller-owned scratch `out = {u, v, Ju: Float64Array(3), Jv: Float64Array(3)}`
// instead, with the SAME expressions as `projectAndJacobian`,
// `distortJacobian` and `Camera.distortPoint` (including their differing
// association of r²·r² vs r⁴), so results are bit-identical. The originals
// stay for the other callers.
// ---------------------------------------------------------------------------
function _projectAndJacobianInto(point, P, out) {
    const X = point[0], Y = point[1], Z = point[2];
    const nu = P[0][0] * X + P[0][1] * Y + P[0][2] * Z + P[0][3];
    const nv = P[1][0] * X + P[1][1] * Y + P[1][2] * Z + P[1][3];
    const den = P[2][0] * X + P[2][1] * Y + P[2][2] * Z + P[2][3];
    if (Math.abs(den) < 1e-12) return null;
    const u = nu / den;
    const v = nv / den;
    out.u = u;
    out.v = v;
    out.Ju[0] = (P[0][0] - u * P[2][0]) / den;
    out.Ju[1] = (P[0][1] - u * P[2][1]) / den;
    out.Ju[2] = (P[0][2] - u * P[2][2]) / den;
    out.Jv[0] = (P[1][0] - v * P[2][0]) / den;
    out.Jv[1] = (P[1][1] - v * P[2][1]) / den;
    out.Jv[2] = (P[1][2] - v * P[2][2]) / den;
    return out;
}

function _projectAndJacobianCameraInto(point, camera, out) {
    if (_projectAndJacobianInto(point, camera.projectionMatrix, out) == null) return null;
    const d = camera && camera.dist;
    if (!d || (d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 0 &&
               (d.length < 5 || d[4] === 0))) {
        return out;   // distortion-free: ideal projection is native
    }
    const K = camera.matrix;
    const fx = K[0][0], fy = K[1][1], cx = K[0][2], cy = K[1][2];
    const k1 = d[0], k2 = d[1], p1 = d[2], p2 = d[3], k3 = d.length > 4 ? d[4] : 0;
    const iu = out.u, iv = out.v;

    // distortJacobian(camera, [iu, iv])
    const x = (iu - cx) / fx;
    const y = (iv - cy) / fy;
    const r2 = x * x + y * y;
    const radialJ = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
    const g = k1 + 2 * k2 * r2 + 3 * k3 * r2 * r2;
    const dxd_dx = radialJ + 2 * g * x * x + 2 * p1 * y + 6 * p2 * x;
    const dxd_dy = 2 * g * x * y + 2 * p1 * x + 2 * p2 * y;
    const dyd_dx = dxd_dy;
    const dyd_dy = radialJ + 2 * g * y * y + 6 * p1 * y + 2 * p2 * x;
    const D00 = dxd_dx, D01 = (fx / fy) * dxd_dy;
    const D10 = (fy / fx) * dyd_dx, D11 = dyd_dy;

    // camera.distortPoint([iu, iv]) — note r4 / r6 here, as in Camera.
    const r4 = r2 * r2;
    const r6 = r4 * r2;
    const radial = 1 + k1 * r2 + k2 * r4 + k3 * r6;
    const xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
    const yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;

    const Ju0 = out.Ju[0], Ju1 = out.Ju[1], Ju2 = out.Ju[2];
    const Jv0 = out.Jv[0], Jv1 = out.Jv[1], Jv2 = out.Jv[2];
    out.u = xd * fx + cx;
    out.v = yd * fy + cy;
    out.Ju[0] = D00 * Ju0 + D01 * Jv0;
    out.Ju[1] = D00 * Ju1 + D01 * Jv1;
    out.Ju[2] = D00 * Ju2 + D01 * Jv2;
    out.Jv[0] = D10 * Ju0 + D11 * Jv0;
    out.Jv[1] = D10 * Ju1 + D11 * Jv1;
    out.Jv[2] = D10 * Ju2 + D11 * Jv2;
    return out;
}

/**
 * Refine a single 3D point across all views via Levenberg–Marquardt with a
 * soft-L1 robust loss, guaranteed never to worsen the reported reprojection
 * error relative to its initialization (issue #113).
 *
 * ### Residual space
 * When `options.cameras` is supplied, `observations` are the **raw, native
 * (still-distorted)** 2D detections and residuals are formed against
 * `distort(P·X)` — the same space `triangulateAndReproject` reports errors in,
 * and the same convention aniposelib uses. Without `options.cameras` the legacy
 * behavior applies: `observations` are assumed already undistorted and
 * residuals are formed against the ideal pinhole projection `P·X`.
 *
 * ### Robust loss
 * Soft-L1 (pseudo-Huber) on each view's squared residual norm s:
 *   ρ(s) = 2 f² (√(1 + s/f²) − 1),  IRLS weight w = ρ'(s) = 1/√(1 + s/f²)
 * with f = `options.robustScale` (default {@link BA_ROBUST_SCALE_PX} = 15 px,
 * aniposelib's `reproj_error_threshold`). Pass `robustScale: Infinity` for a
 * plain squared loss.
 *
 * ### Two phases, then a guard
 * Phase 1 minimizes the robust loss above. Phase 2 ("polish", on by default)
 * then minimizes Σ‖rᵢ‖ — which *is* the reported mean reprojection error up to
 * a constant factor — seeded from whichever of {DLT init, phase-1 result} scores
 * better on it. Since each LM run is monotone in its own loss, phase 2 makes
 * "never worse than DLT" structural. A final backtracking guard covers the
 * residual cases (polish disabled, degenerate views), falling back to the
 * initialization if no fraction of the step is non-worsening. Only the
 * native-space metric is guarded; see the guard's own comment for why.
 *
 * @param {(number[]|null)[]} observations - 2D points [[x1,y1], ...],
 *   null where the point is not visible in that camera. Raw/native when
 *   `options.cameras` is given, otherwise undistorted.
 * @param {number[][][]} projectionMatrices - 3x4 projection matrices, one per camera.
 * @param {number[]|null} [initial] - Initial [X,Y,Z] guess. If null, DLT is used.
 * @param {{maxIterations?:number, tol?:number, robustScale?:number,
 *          cameras?:Camera[], guard?:boolean, polish?:boolean}} [options]
 *   `robustScale: Infinity` + `polish: false` + `guard: false` reproduces the
 *   pre-#113 plain-least-squares behavior, which the tests use as a baseline.
 * @returns {number[]|null} Refined [X, Y, Z], or null if < 2 valid observations.
 */
export function triangulatePointBA(observations, projectionMatrices, initial, options) {
    options = options || {};
    const maxIter = options.maxIterations || 20;
    const tol = options.tol || 1e-8;
    const cameras = options.cameras || null;
    const guard = options.guard !== false;
    const fScale = options.robustScale != null ? options.robustScale : BA_ROBUST_SCALE_PX;
    const f2 = fScale * fScale;

    // Collect valid observation indices
    const validIndices = [];
    for (let i = 0; i < observations.length; i++) {
        if (observations[i] != null && projectionMatrices[i] != null) {
            validIndices.push(i);
        }
    }
    if (validIndices.length < 2) return null;

    // Project into the residual space: native (distorted) when cameras are known.
    // Writes into one scratch object (see `_projectAndJacobianInto`) — every
    // caller below consumes the result before the next projection.
    const _pv = { u: 0, v: 0, Ju: new Float64Array(3), Jv: new Float64Array(3) };
    function projectView(pt, idx) {
        return cameras && cameras[idx]
            ? _projectAndJacobianCameraInto(pt, cameras[idx], _pv)
            : _projectAndJacobianInto(pt, projectionMatrices[idx], _pv);
    }

    // Initialize from the provided guess or fall back to DLT. NOTE: when the
    // caller supplies `cameras`, `observations` are distorted, so a DLT fallback
    // here would be biased — callers on that path (triangulatePointsBA via
    // triangulateAndReproject) always pass an undistorted-space DLT seed.
    let init;
    if (initial && initial.length === 3 &&
        isFinite(initial[0]) && isFinite(initial[1]) && isFinite(initial[2])) {
        init = [initial[0], initial[1], initial[2]];
    } else {
        init = triangulatePointDLT(observations, projectionMatrices);
    }
    if (init == null) return null;
    let p = [init[0], init[1], init[2]];

    // ---- Loss models -------------------------------------------------------
    // Each is expressed on s = ‖r‖² (per view), as {rho, weight}. `weight` is
    // 2·ρ'(s), the IRLS weight that turns Gauss–Newton on Σρ(sᵢ) into a
    // weighted linear least squares — the standard first-order (Triggs/Ceres)
    // form. Both phases below share the LM driver, differing only in the loss.

    // Phase 1: soft-L1 / pseudo-Huber, aniposelib's `optim_points` loss.
    // Quadratic within `fScale` px, linear beyond, so a gross outlier cannot
    // drag the point toward itself. `Infinity` degenerates to plain squares.
    const LOSS_SOFT_L1 = {
        rho: function (s) { return isFinite(f2) ? 2 * f2 * (Math.sqrt(1 + s / f2) - 1) : s; },
        weight: function (s) { return isFinite(f2) ? 1 / Math.sqrt(1 + s / f2) : 1; }
    };
    // Phase 2: plain Euclidean norm, ρ(s) = √s. Σρ(sᵢ) IS the (unnormalized)
    // reported reprojection error, so descending it descends the number the UI
    // shows — which is the whole point of issue #113. The IRLS weight 1/‖r‖ is
    // the Weiszfeld iteration for the geometric median.
    const L1_EPS = 1e-6;
    const LOSS_L1 = {
        rho: function (s) { return Math.sqrt(s); },
        weight: function (s) { return 1 / Math.max(Math.sqrt(s), L1_EPS); }
    };

    /** Total loss at `pt` under `loss`; Infinity if any view degenerates. */
    function costUnder(pt, loss) {
        let sum = 0;
        for (let k = 0; k < validIndices.length; k++) {
            const idx = validIndices[k];
            const pr = projectView(pt, idx);
            if (pr == null) return Infinity;
            const du = observations[idx][0] - pr.u;
            const dv = observations[idx][1] - pr.v;
            sum += loss.rho(du * du + dv * dv);
        }
        return sum;
    }

    // The *reported* metric: mean Euclidean pixel error over this point's views,
    // in the residual space. Monotonicity in this is what issue #113 is about.
    // Identical to costUnder(pt, LOSS_L1) up to the 1/nViews normalization.
    function reportedError(pt) {
        return costUnder(pt, LOSS_L1) / validIndices.length;
    }

    /**
     * Levenberg–Marquardt on the 3 point parameters under an IRLS loss, started
     * at `start`. Strictly monotone in `loss` — a step is accepted only when the
     * loss drops — so the returned point is never worse than `start` under it.
     */
    function runLM(start, loss) {
        let p = [start[0], start[1], start[2]];
        let lambda = 1e-3;
        let cost = costUnder(p, loss);
        if (!isFinite(cost)) return p;

        for (let iter = 0; iter < maxIter; iter++) {
            // Accumulate IRLS-weighted normal equations: JtJ (3x3) and Jtr (3).
            const JtJ = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
            const Jtr = [0, 0, 0];
            let ok = true;
            for (let k = 0; k < validIndices.length; k++) {
                const idx = validIndices[k];
                const pr = projectView(p, idx);
                if (pr == null) { ok = false; break; }
                const ru = observations[idx][0] - pr.u;
                const rv = observations[idx][1] - pr.v;
                const w = loss.weight(ru * ru + rv * rv);
                for (let a = 0; a < 3; a++) {
                    Jtr[a] += w * (pr.Ju[a] * ru + pr.Jv[a] * rv);
                    for (let b = 0; b < 3; b++) {
                        JtJ[a][b] += w * (pr.Ju[a] * pr.Ju[b] + pr.Jv[a] * pr.Jv[b]);
                    }
                }
            }
            if (!ok) break;

            // Levenberg–Marquardt damped step; grow lambda until the cost drops.
            let improved = false;
            let converged = false;
            for (let attempt = 0; attempt < 8; attempt++) {
                const A = [
                    [JtJ[0][0] * (1 + lambda), JtJ[0][1], JtJ[0][2]],
                    [JtJ[1][0], JtJ[1][1] * (1 + lambda), JtJ[1][2]],
                    [JtJ[2][0], JtJ[2][1], JtJ[2][2] * (1 + lambda)]
                ];
                const Ainv = invert3x3(A);
                if (Ainv == null) { lambda *= 10; continue; }

                const delta = [
                    Ainv[0][0] * Jtr[0] + Ainv[0][1] * Jtr[1] + Ainv[0][2] * Jtr[2],
                    Ainv[1][0] * Jtr[0] + Ainv[1][1] * Jtr[1] + Ainv[1][2] * Jtr[2],
                    Ainv[2][0] * Jtr[0] + Ainv[2][1] * Jtr[1] + Ainv[2][2] * Jtr[2]
                ];
                const pNew = [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]];
                const newCost = costUnder(pNew, loss);

                if (newCost < cost) {
                    const stepMag = Math.abs(delta[0]) + Math.abs(delta[1]) + Math.abs(delta[2]);
                    const rel = (cost - newCost) / (cost + 1e-12);
                    p = pNew;
                    cost = newCost;
                    lambda = Math.max(lambda * 0.3, 1e-12);
                    improved = true;
                    if (stepMag < tol || rel < tol) converged = true;
                    break;
                }
                lambda *= 10;
                if (lambda > 1e12) { converged = true; break; }
            }
            if (converged || !improved) break;
        }
        return p;
    }

    // Phase 1 — robust solve. Resists outliers, but its objective is not the
    // reported metric, so it can land somewhere with a worse displayed error.
    const robust = runLM(init, LOSS_SOFT_L1);
    p = robust;

    // Phase 2 — polish on the reported metric itself, started from whichever of
    // {DLT seed, robust solve} already scores better on it. Because runLM is
    // monotone in its loss and LOSS_L1 *is* the reported metric (up to the
    // 1/nViews factor), the result is guaranteed no worse than that starting
    // point — hence no worse than DLT. This is what makes issue #113's
    // invariant structural rather than a post-hoc veto.
    if (options.polish !== false) {
        const seed = reportedError(robust) <= reportedError(init) ? robust : init;
        p = runLM(seed, LOSS_L1);
    }

    if (!guard) return p;

    // Monotone guard: a cheap belt-and-braces check on the reported metric, for
    // the cases phase 2 cannot cover (polish disabled, or an LM that stalled on
    // a degenerate view). Backtrack toward the initialization by halving; fall
    // back to `init` outright if nothing passes.
    //
    // Deliberately guards ONLY the native-space metric — the headline
    // `meanError` and the per-view/per-node breakdowns. It does NOT guard
    // `meanErrorUndistorted`: that diagnostic is measured in a space nobody
    // labels in, and DLT is inherently favored there (DLT minimizes an
    // algebraic error in exactly those ideal-pinhole coordinates), so requiring
    // both to improve was measured to veto genuine improvements — on a 2-camera
    // rig with k1=-0.3 it discarded a 37% reduction in the reported error
    // (1.78px -> 1.12px available, 1.77px kept).
    const e0 = reportedError(init);
    const eps = 1e-9;
    let t = 1;
    for (let attempt = 0; attempt < 8; attempt++) {
        const cand = t === 1 ? p : [
            init[0] + t * (p[0] - init[0]),
            init[1] + t * (p[1] - init[1]),
            init[2] + t * (p[2] - init[2])
        ];
        if (reportedError(cand) <= e0 + eps) return cand;
        t *= 0.5;
    }
    return init;
}

/**
 * Refine an array of keypoints. Each keypoint is refined independently
 * (the cameras are fixed, so the keypoints do not couple), initialized from a
 * DLT estimate or the supplied initial points.
 *
 * @param {(number[]|null)[][]} allObservations - one observation array per keypoint,
 *   in the residual space implied by `options` (see {@link triangulatePointBA}).
 * @param {number[][][]} projectionMatrices - [P1, P2, ...] one per camera.
 * @param {Float64Array|(number[]|null)[]} [initialPoints] - per-keypoint [X,Y,Z]
 *   initial guesses, flat or boxed.
 * @param {object} [options] - forwarded verbatim to {@link triangulatePointBA}.
 * @returns {Float64Array} Flat refined [X,Y,Z] per keypoint; all-NaN where unrefinable.
 */
export function triangulatePointsBA(allObservations, projectionMatrices, initialPoints, options) {
    const results = makePoints3d(allObservations.length);
    const flatInit = initialPoints instanceof Float64Array ? initialPoints : null;
    for (let k = 0; k < allObservations.length; k++) {
        let init = null;
        if (flatInit) init = getPoint3d(flatInit, k);
        else if (initialPoints) init = initialPoints[k];
        setPoint3d(results, k,
            triangulatePointBA(allObservations[k], projectionMatrices, init, options));
    }
    return results;
}


// ============================================
// Reprojection
// ============================================

/**
 * Project a 3D point through a 3x4 projection matrix.
 *   p = P * [X, Y, Z, 1]^T
 *   x = p[0] / p[2],  y = p[1] / p[2]
 *
 * @param {number[]} point3d - [X, Y, Z]
 * @param {number[][]} projectionMatrix - 3x4 projection matrix
 * @returns {number[]} [x, y] projected 2D point
 */
export function reprojectPoint(point3d, projectionMatrix) {
    const P = projectionMatrix;
    const X = point3d[0];
    const Y = point3d[1];
    const Z = point3d[2];

    const u = P[0][0] * X + P[0][1] * Y + P[0][2] * Z + P[0][3];
    const v = P[1][0] * X + P[1][1] * Y + P[1][2] * Z + P[1][3];
    const w = P[2][0] * X + P[2][1] * Y + P[2][2] * Z + P[2][3];

    return [u / w, v / w];
}

/**
 * Reproject an array of 3D points through a 3x4 projection matrix.
 *
 * @param {Float64Array} points3d - Flat [X,Y,Z] per keypoint (all-NaN = missing)
 * @param {number[][]} projectionMatrix - 3x4 projection matrix
 * @returns {(number[]|null)[]} Array of [x,y] or null (if the 3D point is missing)
 */
export function reprojectPoints(points3d, projectionMatrix) {
    const n = points3dNodeCount(points3d);
    const results = new Array(n);
    const p = [0, 0, 0];
    for (let i = 0; i < n; i++) {
        results[i] = readPoint3d(points3d, i, p)
            ? reprojectPoint(p, projectionMatrix)
            : null;
    }
    return results;
}

/**
 * Reproject a 3D point into a camera's native (lens-distorted) pixel space:
 * project through the ideal pinhole matrix, then apply the camera's distortion
 * model. The result lands where the real camera observes the point, so it lines
 * up with the raw 2D keypoints (which are never undistorted on disk).
 *
 * Triangulation itself works in undistorted space (observations are undistorted
 * first), but reprojections used for display/error must be re-distorted — else
 * markers and reprojection error blow up near the frame edges where distortion
 * is largest.
 *
 * @param {number[]} point3d - [X, Y, Z]
 * @param {Camera} camera - camera with .projectionMatrix and .distortPoint
 * @returns {number[]} [x, y] distorted pixel point
 */
export function reprojectPointCamera(point3d, camera) {
    const ideal = reprojectPoint(point3d, camera.projectionMatrix);
    return camera.distortPoint ? camera.distortPoint(ideal) : ideal;
}

/**
 * Reproject an array of 3D points into a camera's native (distorted) pixel space.
 *
 * @param {Float64Array} points3d - Flat [X,Y,Z] per keypoint (all-NaN = missing)
 * @param {Camera} camera - camera with .projectionMatrix and .distortPoint
 * @returns {(number[]|null)[]} Array of [x,y] or null (if the 3D point is missing)
 */
export function reprojectPointsCamera(points3d, camera) {
    const n = points3dNodeCount(points3d);
    const results = new Array(n);
    const p = [0, 0, 0];
    for (let i = 0; i < n; i++) {
        results[i] = readPoint3d(points3d, i, p)
            ? reprojectPointCamera(p, camera)
            : null;
    }
    return results;
}

/**
 * Euclidean distance between an observed 2D point and a reprojected 2D point.
 *
 * @param {number[]|null} observed2d - [x, y] observed point, or null
 * @param {number[]|null} reprojected2d - [x, y] reprojected point, or null
 * @returns {number|null} Pixel error (float), or null if either input is null
 */
export function computeReprojectionError(observed2d, reprojected2d) {
    if (observed2d == null || reprojected2d == null) {
        return null;
    }
    const dx = observed2d[0] - reprojected2d[0];
    const dy = observed2d[1] - reprojected2d[1];
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Compute per-point reprojection errors between two arrays of 2D points.
 *
 * @param {(number[]|null)[]} observed2d - Array of [x,y] or null
 * @param {(number[]|null)[]} reprojected2d - Array of [x,y] or null
 * @returns {(number|null)[]} Array of errors (float or null)
 */
export function computeReprojectionErrors(observed2d, reprojected2d) {
    const errors = [];
    const len = Math.max(observed2d.length, reprojected2d.length);
    for (let i = 0; i < len; i++) {
        const obs = i < observed2d.length ? observed2d[i] : null;
        const rep = i < reprojected2d.length ? reprojected2d[i] : null;
        errors.push(computeReprojectionError(obs, rep));
    }
    return errors;
}

/**
 * Mean reprojection error across all valid (non-null) point pairs.
 *
 * @param {(number[]|null)[]} observed2d - Array of [x,y] or null
 * @param {(number[]|null)[]} reprojected2d - Array of [x,y] or null
 * @returns {number|null} Mean error in pixels, or null if no valid point pairs
 */
export function computeMeanReprojectionError(observed2d, reprojected2d) {
    const errors = computeReprojectionErrors(observed2d, reprojected2d);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < errors.length; i++) {
        if (errors[i] != null) {
            sum += errors[i];
            count++;
        }
    }
    return count > 0 ? sum / count : null;
}



/**
 * Invert a 3x3 matrix using cofactors and determinant.
 *
 * @param {number[][]} M - 3x3 matrix
 * @returns {number[][]} 3x3 inverse matrix
 */
export function invert3x3(M) {
    var a = M[0][0], b = M[0][1], c = M[0][2];
    var d = M[1][0], e = M[1][1], f = M[1][2];
    var g = M[2][0], h = M[2][1], k = M[2][2];

    var det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-15) {
        return null; // Singular matrix
    }
    var invDet = 1.0 / det;

    return [
        [(e * k - f * h) * invDet, (c * h - b * k) * invDet, (b * f - c * e) * invDet],
        [(f * g - d * k) * invDet, (a * k - c * g) * invDet, (c * d - a * f) * invDet],
        [(d * h - e * g) * invDet, (b * g - a * h) * invDet, (a * e - b * d) * invDet]
    ];
}

// ============================================
// Triangulation + Reprojection pipeline
// ============================================

/**
 * Full triangulation and reprojection pipeline for an InstanceGroup.
 *
 * Given an InstanceGroup (containing one Instance per camera) and Camera objects:
 *   1. Collect 2D observations from each camera's Instance
 *   2. Get projection matrices from cameras
 *   3. Triangulate each keypoint to 3D via DLT
 *   4. Reproject 3D points back to each camera
 *   5. Compute reprojection errors
 *
 * @param {InstanceGroup} instanceGroup
 *   - has .instances Map<cameraName, Instance>
 *   - each Instance stores flat coords; read via inst.hasPoint(k)/getPoint(k)
 * @param {Camera[]} cameras
 *   - each Camera has .name and .projectionMatrix (3x4)
 *
 * @returns {{
 *   points3d: Float64Array,
 *   reprojections: Object.<string, (number[]|null)[]>,
 *   errors: Object.<string, (number|null)[]>,
 *   meanError: number|null
 * }}
 *   points3d: flat [X,Y,Z] per keypoint, all-NaN triple where untriangulable
 *   reprojections: { cameraName: [[x,y], ...] } reprojected 2D points per camera
 *   errors: { cameraName: [error, ...] } per-keypoint reprojection errors per camera
 *   meanError: scalar mean error across all cameras and keypoints
 */
export function triangulateAndReproject(instanceGroup, cameras, options) {
    // Build ordered list of camera names and their projection matrices
    const cameraNames = [];
    const projMatrices = [];
    const cameraMap = {};
    for (let c = 0; c < cameras.length; c++) {
        cameraNames.push(cameras[c].name);
        projMatrices.push(cameras[c].projectionMatrix);
        cameraMap[cameras[c].name] = cameras[c];
    }

    // Feature: views excluded in the Tracking Wizard's Camera Views panel never
    // CONTRIBUTE to the 3D solve — but we still reproject INTO them below, so an
    // excluded view shows the reprojected skeleton (from the trusted views) and its
    // own error without ever influencing the geometry. `included[c]` gates only the
    // observation collection; reprojection/error steps still cover every camera.
    // Source: `options.includedCameras` (explicit list, for tests) else the live
    // Camera Views setting. `typeof` guard keeps this safe under the flat-script
    // test harness where the ES import isn't resolved.
    const included = cameraNames.map(function (n) {
        if (options && options.includedCameras) return options.includedCameras.indexOf(n) >= 0;
        return _settingsHooks.isCameraTracked ? _settingsHooks.isCameraTracked(n) : true;
    });

    // Determine number of keypoints from the first available instance
    let numKeypoints = 0;
    for (let c = 0; c < cameraNames.length; c++) {
        const inst = instanceGroup.getInstance(cameraNames[c]);
        if (inst && inst.numNodes > 0) {
            numKeypoints = inst.numNodes;
            break;
        }
    }

    if (numKeypoints === 0) {
        return {
            points3d: makePoints3d(0),
            reprojections: {},
            errors: {},
            meanError: null
        };
    }

    // Step 1: Collect observations per keypoint across cameras
    // Undistort 2D points before triangulation for accuracy
    // Occluded keypoints are excluded (position may be imprecise)
    // allObservations[k][c] = [x,y] (undistorted) or null
    // allObservationsRaw[k][c] = the same detection in the camera's NATIVE
    //   (still-distorted) pixel space, kept index-parallel so the two stay in
    //   lockstep as the outlier-rejection loop below nulls entries. DLT needs
    //   the undistorted form (it is a linear method in ideal pinhole
    //   coordinates); the 'ba' refinement needs the raw form, because it
    //   minimizes in the space the reported error is measured in (issue #113).
    const allObservations = [];
    const allObservationsRaw = [];
    for (let k = 0; k < numKeypoints; k++) {
        const obsForKeypoint = [];
        const rawForKeypoint = [];
        for (let c = 0; c < cameraNames.length; c++) {
            const inst = instanceGroup.getInstance(cameraNames[c]);
            // Skip nulled nodes — they are excluded from triangulation
            const isNulled = inst && inst.nulledNodes && inst.nulledNodes.has(k);
            if (included[c] && inst && inst.hasPoint(k) && !isNulled) {
                const cam = cameraMap[cameraNames[c]];
                const raw2d = inst.getPoint(k);
                rawForKeypoint.push(raw2d);
                if (cam && cam.undistortPoint) {
                    obsForKeypoint.push(cam.undistortPoint(raw2d));
                } else {
                    obsForKeypoint.push(raw2d);
                }
            } else {
                obsForKeypoint.push(null);
                rawForKeypoint.push(null);
            }
        }
        allObservations.push(obsForKeypoint);
        allObservationsRaw.push(rawForKeypoint);
    }

    // Step 2: Triangulate.
    //   'dlt' (default) — fast linear DLT.
    //   'ba'            — DLT to initialize, then robust non-linear refinement
    //                     of each keypoint against the native-space detections
    //                     (aniposelib `optim_points` paradigm; cameras fixed).
    //
    // CAUTION — this default is SILENT. Omitting `options.method` does not mean
    // "keep whatever method this group already used"; it means DLT. Any caller
    // that re-solves an ALREADY-TRIANGULATED group must pass
    // `{ method: group.triangulationMethod === 'ba' ? 'ba' : 'dlt' }` — see
    // `reTriangulateGroup` and `ui/rendering.js`'s lazy reprojection fill.
    // Otherwise it silently downgrades a BA solve to DLT while
    // `group.triangulationMethod` still claims 'ba', so the Info Panel labels
    // the number "Bundle Adjustment" and shows DLT's value. That was exactly
    // the "Triangulate All ▸ Bundle Adjustment appears to change nothing" bug
    // (guarded by `tests/e2e/triangulate-all-ba-display.mjs`). Callers that are
    // deliberately fast/DLT-only (the grouping sweeps in `ui/export-modals.js`,
    // the identity-assignment cost matrices) say so at the call site.
    const method = (options && options.method === 'ba') ? 'ba' : 'dlt';
    const baCameras = cameraNames.map(function (n) { return cameraMap[n]; });
    const baOptions = {
        cameras: baCameras,
        robustScale: (options && options.robustScale != null)
            ? options.robustScale : BA_ROBUST_SCALE_PX
    };
    function triangulateFrom(obs) {
        if (method === 'ba') {
            const dltPoints = triangulatePoints(obs, projMatrices);
            // Mask the raw observations to exactly the views `obs` still keeps,
            // so a view dropped by the outlier loop is dropped from BA too.
            const rawMasked = obs.map(function (perKeypoint, k) {
                return perKeypoint.map(function (o, c) {
                    return o == null ? null : allObservationsRaw[k][c];
                });
            });
            return triangulatePointsBA(rawMasked, projMatrices, dltPoints, baOptions);
        }
        return triangulatePoints(obs, projMatrices);
    }
    let points3d = triangulateFrom(allObservations);

    // Robust triangulation (opt-in via the Tracking Wizard's "Reprojection error
    // threshold (px)"): iteratively drop any 2D node whose reprojection error in a
    // view exceeds the threshold, then re-triangulate that node from the remaining
    // reliable views. A node left with <2 views triangulates to null (DLT returns
    // null) — i.e. it is dropped from 3D rather than trusted to a bad fit.
    const reprojThresh = (options && options.reprojErrorThreshold != null)
        ? options.reprojErrorThreshold
        : (_settingsHooks.getTrackingThreshold ? _settingsHooks.getTrackingThreshold('reprojErrorThreshold') : 0);
    if (reprojThresh > 0) {
        // Don't include a node-in-a-view (a single 2D keypoint) whose reprojection
        // error exceeds the threshold — re-triangulate that node from the views that
        // remain. This works PER NODE within a view; it never drops a whole view
        // (that is the Tracking Wizard's job). A node left with <2 views is null.
        const _nodeErrBuf = [0, 0, 0];
        function nodeError(k, c) {
            if (allObservations[k][c] == null) return -1;
            if (!readPoint3d(points3d, k, _nodeErrBuf)) return -1;
            const inst = instanceGroup.getInstance(cameraNames[c]);
            const raw = inst ? inst.getPoint(k) : null;
            if (raw == null) return -1;
            const rep = reprojectPointCamera(_nodeErrBuf, cameraMap[cameraNames[c]]);
            if (rep == null) return -1;
            const dx = raw[0] - rep[0], dy = raw[1] - rep[1];
            return Math.sqrt(dx * dx + dy * dy);
        }
        // Exclude the single worst over-threshold observation per node per pass and
        // re-triangulate between passes (never below 2 views). Removing one at a
        // time and re-checking is necessary because each exclusion re-triangulates
        // the node, which shifts every remaining view's error.
        const maxPasses = Math.max(1, cameraNames.length);
        for (let iter = 0; iter < maxPasses; iter++) {
            let excludedAny = false;
            for (let k = 0; k < numKeypoints; k++) {
                if (!hasPoint3d(points3d, k)) continue;
                let worstC = -1, worstErr = reprojThresh, kept = 0;
                for (let c = 0; c < cameraNames.length; c++) {
                    if (!included[c] || allObservations[k][c] == null) continue;
                    kept++;
                    const e = nodeError(k, c);
                    if (e > worstErr) { worstErr = e; worstC = c; }
                }
                if (worstC >= 0 && kept > 2) { allObservations[k][worstC] = null; excludedAny = true; }
            }
            if (!excludedAny) break;
            points3d = triangulateFrom(allObservations);
        }
        // If a node's remaining views still exceed the threshold, it has <2 views
        // under the threshold → drop it from 3D (null).
        for (let k = 0; k < numKeypoints; k++) {
            if (!hasPoint3d(points3d, k)) continue;
            for (let c = 0; c < cameraNames.length; c++) {
                if (!included[c] || allObservations[k][c] == null) continue;
                if (nodeError(k, c) > reprojThresh) { clearPoint3d(points3d, k); break; }
            }
        }
    }

    // Fast path: skip reprojections/errors when only 3D points are needed (bulk ops)
    if (options && options.triangulateOnly) {
        return { points3d: points3d, reprojections: {}, errors: {}, meanError: null, method: method };
    }

    // Step 3: Reproject to each camera, in the camera's native (distorted) pixel
    // space so reprojections align with the raw observed keypoints (the error in
    // Step 4 compares against the raw, still-distorted observations).
    const reprojections = {};
    for (let c = 0; c < cameraNames.length; c++) {
        reprojections[cameraNames[c]] = reprojectPointsCamera(points3d, cameraMap[cameraNames[c]]);
    }

    // Step 4: Compute per-camera reprojection errors
    const errorsPerCamera = {};
    let totalError = 0;
    let totalCount = 0;

    for (let c = 0; c < cameraNames.length; c++) {
        const camName = cameraNames[c];
        const inst = instanceGroup.getInstance(camName);
        const observed = [];
        for (let k = 0; k < numKeypoints; k++) {
            const isNulled = inst && inst.nulledNodes && inst.nulledNodes.has(k);
            if (inst && inst.hasPoint(k) && !isNulled) {
                observed.push(inst.getPoint(k));
            } else {
                observed.push(null);
            }
        }

        const cameraErrors = computeReprojectionErrors(observed, reprojections[camName]);
        errorsPerCamera[camName] = cameraErrors;

        for (let k = 0; k < cameraErrors.length; k++) {
            if (cameraErrors[k] != null) {
                totalError += cameraErrors[k];
                totalCount++;
            }
        }
    }

    const meanError = totalCount > 0 ? totalError / totalCount : null;

    // Step 5: Undistorted-space reprojection error. This is the space BA actually
    // optimizes in: compare the ideal (pinhole, un-distorted) reprojection against
    // the already-undistorted observations collected in Step 1. Reported alongside
    // the distorted-space error so the headline can show both; the per-view and
    // per-node breakdowns continue to use the distorted-space errors above.
    const errorsPerCameraUndistorted = {};
    let totalErrorUndist = 0;
    let totalCountUndist = 0;
    for (let c = 0; c < cameraNames.length; c++) {
        const camName = cameraNames[c];
        // Ideal reprojection (no re-distortion) for this camera.
        const idealReproj = reprojectPoints(points3d, projMatrices[c]);
        // Undistorted observations for this camera, per keypoint (from Step 1).
        const observedUndist = [];
        for (let k = 0; k < numKeypoints; k++) {
            observedUndist.push(allObservations[k][c]);
        }
        const camErrs = computeReprojectionErrors(observedUndist, idealReproj);
        errorsPerCameraUndistorted[camName] = camErrs;
        for (let k = 0; k < camErrs.length; k++) {
            if (camErrs[k] != null) {
                totalErrorUndist += camErrs[k];
                totalCountUndist++;
            }
        }
    }
    const meanErrorUndistorted = totalCountUndist > 0 ? totalErrorUndist / totalCountUndist : null;

    return {
        points3d: points3d,
        reprojections: reprojections,
        errors: errorsPerCamera,
        errorsUndistorted: errorsPerCameraUndistorted,
        meanError: meanError,
        meanErrorUndistorted: meanErrorUndistorted,
        method: method
    };
}

/**
 * TEST-ONLY: the original allocation-heavy helpers next to their fast
 * replacements, so tests/test-triangulation-kernels.mjs can require the two to
 * agree bit for bit. Not part of the app's API.
 */
export const __triangulationKernelsForTest = {
    svd3x4, dltHomogeneousFlat,
    projectAndJacobianCamera, projectAndJacobian,
    _projectAndJacobianCameraInto, _projectAndJacobianInto,
};
