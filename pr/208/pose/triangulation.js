/**
 * triangulation.js - Triangulation and reprojection for multi-view 3D reconstruction
 *
 * Implements DLT (Direct Linear Transform) triangulation in pure JavaScript.
 * Uses the Jacobi eigenvalue algorithm for solving the 4x4 symmetric eigenproblem.
 */

import { mat3x3Multiply, Camera, FrameGroup, Instance, UnlinkedInstance, InstanceGroup,
         makePoints3d, points3dNodeCount, hasPoint3d, getPoint3d, readPoint3d,
         setPoint3d, clearPoint3d, someValidPoint3d, countPoints3d } from './pose-data.js';
import { state, timeline, viewport3d } from '../ui/app-state.js';
// Pass 3i-2: triangulation orchestration moved out of app.js
import { setReprojErrorVisible, drawAllOverlays } from '../ui/rendering.js';
import { updateTriangulationBadge } from '../ui/info-panel.js';
import { isCameraTracked, getTrackingThreshold, getDefaultTriangulationMethod } from '../ui/settings.js';
import { markDirty, setStatus, showLoading, hideLoading } from '../import-export/save-load.js';
// Pass 3i-3: update3DViewport moved to pose/initialization.js.
import { update3DViewport } from './initialization.js';

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
function matMul(A, B) {
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
function matTranspose(A) {
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
function jacobiEigen(M, maxIter, tol) {
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
function solveSmallestEigenvector4x4(M) {
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
function svd3x4(A) {
    const AT = matTranspose(A);     // 4 x 2N
    const M = matMul(AT, A);       // 4 x 4
    return solveSmallestEigenvector4x4(M);
}


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

    // Build the A matrix (2*N x 4) where N = number of valid observations
    const numRows = validIndices.length * 2;
    const A = [];

    for (let idx = 0; idx < validIndices.length; idx++) {
        const i = validIndices[idx];
        const x = observations[i][0];
        const y = observations[i][1];
        const P = projectionMatrices[i];

        // Row 1: x * P[2] - P[0]
        A[2 * idx] = [
            x * P[2][0] - P[0][0],
            x * P[2][1] - P[0][1],
            x * P[2][2] - P[0][2],
            x * P[2][3] - P[0][3]
        ];

        // Row 2: y * P[2] - P[1]
        A[2 * idx + 1] = [
            y * P[2][0] - P[1][0],
            y * P[2][1] - P[1][1],
            y * P[2][2] - P[1][2],
            y * P[2][3] - P[1][3]
        ];
    }

    // Solve via SVD (null space of A)
    const xHomog = svd3x4(A);

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
// The label "Bundle Adjustment" in the UI (and `triangulationMethodLabel`) refers
// to THIS point stage, cameras fixed. It is the term users of anipose/SLEAP
// expect for `optim_points`, hence kept, but it does not imply camera refinement.
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
    function projectView(pt, idx) {
        return cameras && cameras[idx]
            ? projectAndJacobianCamera(pt, cameras[idx])
            : projectAndJacobian(pt, projectionMatrices[idx]);
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
 * The homogeneous depth `w` of a 3D point in a camera's projective frame:
 * POSITIVE in front of the camera, negative behind it, ~0 on the plane through
 * the centre of projection.
 *
 * `reprojectPoint` divides by `w` without checking its sign, so a point BEHIND
 * the camera comes back as a mirrored pixel coordinate that is finite,
 * plausible, and geometrically meaningless. Any caller reprojecting into a
 * camera it did not choose — one the user never annotated in, e.g. filling in
 * the views a plane was not placed on — has to gate on this. Callers
 * reprojecting into the camera an observation CAME from do not: the point is
 * in front by construction there.
 *
 * @param {number[]} point3d - [X, Y, Z]
 * @param {Camera} camera - Needs `.projectionMatrix`.
 * @returns {number} `w`, or NaN if the camera has no projection matrix.
 */
export function cameraDepth(point3d, camera) {
    const P = camera && camera.projectionMatrix;
    if (!P || !P[2]) return NaN;
    return P[2][0] * point3d[0] + P[2][1] * point3d[1] + P[2][2] * point3d[2] + P[2][3];
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
 * Compute mean Euclidean distance between two sets of 2D keypoints.
 * Used for temporal tracking cost matrix — comparing projected 3D targets
 * with observed 2D detections.
 *
 * @param {(number[]|null)[]} pointsA - Array of [x,y] or null
 * @param {(number[]|null)[]} pointsB - Array of [x,y] or null
 * @param {number[]} [weights] - Optional per-node weights (parallel to points).
 *   Each node's distance is scaled by its weight and the mean is weighted
 *   accordingly; a node with weight 0 is ignored. Omitted ⇒ all weights 1.
 * @returns {number} (Weighted) mean pixel distance, or Infinity if no valid pairs
 */
export function computeInstanceDistance(pointsA, pointsB, weights) {
    var totalDist = 0, count = 0;
    var len = Math.min(pointsA.length, pointsB.length);
    for (var i = 0; i < len; i++) {
        if (pointsA[i] != null && pointsB[i] != null) {
            var w = weights ? (weights[i] != null ? weights[i] : 1) : 1;
            if (w <= 0) continue;
            var dx = pointsA[i][0] - pointsB[i][0];
            var dy = pointsA[i][1] - pointsB[i][1];
            totalDist += w * Math.sqrt(dx * dx + dy * dy);
            count += w;
        }
    }
    return count > 0 ? totalDist / count : Infinity;
}

/**
 * Mean weighted distance between boxed 2D points and an `Instance`'s coords.
 * Instance-aware sibling of `computeInstanceDistance` — every caller had an
 * `Instance` on one side, and materializing `inst.toPointsArray()` just to
 * measure a distance would allocate nNodes arrays per comparison inside the
 * tracker's per-frame matching loops (luc3d #189 follow-up #1).
 *
 * @param {(number[]|null)[]} pointsA
 * @param {Instance} instB
 * @param {(number|null)[]} [weights]
 * @returns {number} mean distance, or Infinity when nothing overlaps
 */
export function computeInstanceDistanceTo(pointsA, instB, weights) {
    var totalDist = 0, count = 0;
    var len = Math.min(pointsA.length, instB.numNodes);
    for (var i = 0; i < len; i++) {
        var a = pointsA[i];
        if (a == null || !instB.hasPoint(i)) continue;
        var w = weights ? (weights[i] != null ? weights[i] : 1) : 1;
        if (w <= 0) continue;
        var dx = a[0] - instB.getX(i);
        var dy = a[1] - instB.getY(i);
        totalDist += w * Math.sqrt(dx * dx + dy * dy);
        count += w;
    }
    return count > 0 ? totalDist / count : Infinity;
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
        return (typeof isCameraTracked === 'function') ? isCameraTracked(n) : true;
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
        : ((typeof getTrackingThreshold === 'function') ? getTrackingThreshold('reprojErrorThreshold') : 0);
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
 * Human-readable label for a triangulation method key.
 * @param {string} method - 'dlt' or 'ba'
 * @returns {string}
 */
export function triangulationMethodLabel(method) {
    return method === 'ba' ? 'Bundle Adjustment' : 'DLT';
}

// ============================================
// Hungarian Algorithm (Kuhn-Munkres)
// ============================================

/**
 * Solve the assignment problem using the Hungarian algorithm.
 * Given an n x m cost matrix, returns the optimal assignment
 * that minimizes total cost.
 *
 * @param {number[][]} costMatrix - n x m cost matrix (n <= m)
 * @returns {number[]} assignment - assignment[i] = column assigned to row i (-1 if unassigned)
 */
export function hungarianAlgorithm(costMatrix) {
    var n = costMatrix.length;
    if (n === 0) return [];
    var m = costMatrix[0].length;
    if (m === 0) return new Array(n).fill(-1);

    // Clamp non-finite (Infinity / NaN) entries to a large finite sentinel.
    // An all-Infinity cost matrix would otherwise leave delta/j1 unchanged
    // inside the augmenting-path search (Infinity < Infinity === false),
    // sending j0 to -1 and dereferencing cost[NaN] on the next iteration.
    // Callers gate matches by a threshold (e.g., cost < 100) so spurious
    // assignments at the sentinel value are naturally filtered out.
    var SENTINEL = 1e15;
    var hasFinite = false;
    for (var ri = 0; ri < n; ri++) {
        for (var ci = 0; ci < m; ci++) {
            if (Number.isFinite(costMatrix[ri][ci])) { hasFinite = true; break; }
        }
        if (hasFinite) break;
    }
    if (!hasFinite) return new Array(n).fill(-1);

    // Ensure n <= m (more columns than rows)
    var transposed = false;
    var C;
    if (n > m) {
        transposed = true;
        C = [];
        for (var j = 0; j < m; j++) {
            C[j] = [];
            for (var i = 0; i < n; i++) {
                var v0 = costMatrix[i][j];
                C[j][i] = Number.isFinite(v0) ? v0 : SENTINEL;
            }
        }
        var tmp = n; n = m; m = tmp;
    } else {
        C = [];
        for (var i2 = 0; i2 < n; i2++) {
            C[i2] = new Array(m);
            for (var c2 = 0; c2 < m; c2++) {
                var v1 = costMatrix[i2][c2];
                C[i2][c2] = Number.isFinite(v1) ? v1 : SENTINEL;
            }
        }
    }

    // Pad to square if needed
    var sz = Math.max(n, m);
    var cost = [];
    for (var r = 0; r < sz; r++) {
        cost[r] = [];
        for (var c = 0; c < sz; c++) {
            cost[r][c] = (r < n && c < m) ? C[r][c] : 0;
        }
    }

    // u[i] and v[j] are potentials
    var u = new Array(sz + 1).fill(0);
    var v = new Array(sz + 1).fill(0);
    var p = new Array(sz + 1).fill(0);   // p[j] = row assigned to col j
    var way = new Array(sz + 1).fill(0); // way[j] = previous col in path

    for (var i1 = 1; i1 <= sz; i1++) {
        p[0] = i1;
        var j0 = 0;
        var minv = new Array(sz + 1).fill(Infinity);
        var used = new Array(sz + 1).fill(false);

        do {
            used[j0] = true;
            var i0 = p[j0];
            var delta = Infinity;
            var j1 = -1;

            for (var j = 1; j <= sz; j++) {
                if (used[j]) continue;
                var cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
                if (cur < minv[j]) {
                    minv[j] = cur;
                    way[j] = j0;
                }
                if (minv[j] < delta) {
                    delta = minv[j];
                    j1 = j;
                }
            }

            for (var j2 = 0; j2 <= sz; j2++) {
                if (used[j2]) {
                    u[p[j2]] += delta;
                    v[j2] -= delta;
                } else {
                    minv[j2] -= delta;
                }
            }

            j0 = j1;
        } while (p[j0] !== 0);

        do {
            var j3 = way[j0];
            p[j0] = p[j3];
            j0 = j3;
        } while (j0);
    }

    // Extract assignment
    var result;
    if (!transposed) {
        result = new Array(n).fill(-1);
        for (var j4 = 1; j4 <= sz; j4++) {
            if (p[j4] > 0 && p[j4] <= n && j4 <= m) {
                result[p[j4] - 1] = j4 - 1;
            }
        }
    } else {
        result = new Array(costMatrix.length).fill(-1);
        for (var j5 = 1; j5 <= sz; j5++) {
            if (p[j5] > 0 && p[j5] <= n && j5 <= m) {
                // transposed: row in C = col in original, col in C = row in original
                var origRow = j5 - 1;
                var origCol = p[j5] - 1;
                if (origRow < costMatrix.length && origCol < costMatrix[0].length) {
                    result[origRow] = origCol;
                }
            }
        }
    }

    return result;
}


// ============================================
// Plane fitting (View ▸ Define Planes)
// ============================================

/**
 * Least-squares plane of best fit through a flat `points3d` set.
 *
 * Total-least-squares via PCA: the plane through the centroid whose normal is
 * the eigenvector of the SMALLEST eigenvalue of the points' 3x3 covariance.
 * That minimizes the sum of squared PERPENDICULAR distances, which is the
 * right objective here — the corners carry error in all three axes (they come
 * out of triangulation), so an ordinary least-squares fit of z on (x, y) would
 * both privilege an arbitrary axis and blow up for a plane seen edge-on.
 *
 * Rejects degenerate input. Three or more points always admit *a* plane, but
 * COLLINEAR points admit infinitely many — the normal is then arbitrary within
 * a pencil, and "fitting" to it would silently rotate the annotation to
 * nonsense. The middle eigenvalue is the spread along the plane's minor
 * in-plane axis, so comparing it against the largest detects exactly that case.
 *
 * @param {Float64Array} points3d - Flat [X,Y,Z] per node; all-NaN = missing.
 * @returns {{centroid:number[], normal:number[], rms:number, nPoints:number}|null}
 *   null when fewer than 3 nodes are present, all coincide, or they are collinear.
 */
export function fitPlaneToPoints3d(points3d) {
    const n = points3dNodeCount(points3d);
    const p = [0, 0, 0];

    let cx = 0, cy = 0, cz = 0, count = 0;
    for (let k = 0; k < n; k++) {
        if (!readPoint3d(points3d, k, p)) continue;
        cx += p[0]; cy += p[1]; cz += p[2];
        count++;
    }
    if (count < 3) return null;
    cx /= count; cy /= count; cz /= count;

    // Covariance of the centered points (symmetric — only 6 unique terms).
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let k = 0; k < n; k++) {
        if (!readPoint3d(points3d, k, p)) continue;
        const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
        xx += dx * dx; xy += dx * dy; xz += dx * dz;
        yy += dy * dy; yz += dy * dz; zz += dz * dz;
    }

    // jacobiEigen returns eigenvectors as ROWS already paired with
    // `eigenvalues[i]`, and does NOT sort them — find the extremes ourselves.
    const eig = jacobiEigen([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]]);
    let minIdx = 0, maxIdx = 0;
    for (let i = 1; i < 3; i++) {
        if (Math.abs(eig.eigenvalues[i]) < Math.abs(eig.eigenvalues[minIdx])) minIdx = i;
        if (Math.abs(eig.eigenvalues[i]) > Math.abs(eig.eigenvalues[maxIdx])) maxIdx = i;
    }
    if (minIdx === maxIdx) return null;          // all eigenvalues equal — no structure
    const midIdx = 3 - minIdx - maxIdx;

    const largest = Math.abs(eig.eigenvalues[maxIdx]);
    if (!(largest > 0)) return null;                                      // coincident
    if (Math.abs(eig.eigenvalues[midIdx]) / largest < 1e-10) return null; // collinear

    const v = eig.eigenvectors[minIdx];
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (!(len > 1e-12)) return null;
    const normal = [v[0] / len, v[1] / len, v[2] / len];

    // RMS perpendicular distance — how planar the annotation already was.
    let sq = 0;
    for (let k = 0; k < n; k++) {
        if (!readPoint3d(points3d, k, p)) continue;
        const d = (p[0] - cx) * normal[0] + (p[1] - cy) * normal[1] + (p[2] - cz) * normal[2];
        sq += d * d;
    }

    return {
        centroid: [cx, cy, cz],
        normal: normal,
        rms: Math.sqrt(sq / count),
        nPoints: count,
    };
}

/**
 * Orthogonally project every present point onto `plane`, returning a NEW flat
 * `points3d` (the input is left intact, so a caller can keep the raw
 * triangulation alongside the flattened version). Missing nodes stay missing.
 *
 * @param {Float64Array} points3d
 * @param {{centroid:number[], normal:number[]}} plane
 * @returns {Float64Array}
 */
export function projectPoints3dOntoPlane(points3d, plane) {
    const n = points3dNodeCount(points3d);
    const out = makePoints3d(n);
    const p = [0, 0, 0];
    const c = plane.centroid, nv = plane.normal;
    for (let k = 0; k < n; k++) {
        if (!readPoint3d(points3d, k, p)) continue;
        const d = (p[0] - c[0]) * nv[0] + (p[1] - c[1]) * nv[1] + (p[2] - c[2]) * nv[2];
        setPoint3d(out, k, [p[0] - d * nv[0], p[1] - d * nv[1], p[2] - d * nv[2]]);
    }
    return out;
}


// ============================================
// CONSTRAINED plane fitting (immutable / frozen nodes)
// ============================================
//
// A plane node may be flagged IMMUTABLE: its 3D position is FROZEN and must not
// be moved by 2D editing, by triangulation, or by the plane fit. The fit then
// stops being a free total-least-squares problem and becomes the SAME residual
// minimized subject to hard linear constraints — the plane must pass through
// every frozen point.
//
// ## The unified solve
//
// Every case is "pin the plane's OFFSET with an anchor, then restrict its
// NORMAL to an admissible subspace":
//
//   a  = anchor point (one frozen point, or the frozen set's centroid)
//   r_i = p_i − a  over the MUTABLE points that have 3D
//   M  = Σ r_i r_iᵀ            (scatter about `a`, NOT about the centroid —
//                               M = S_c + m·(c−a)(c−a)ᵀ, so this is genuinely a
//                               different matrix from the free fit's)
//   N  = orthonormal 3×q basis of admissible normals
//   n  = N·y, where y is the eigenvector of the SMALLEST eigenvalue of NᵀMN
//
// q falls out of the frozen set's rank:
//
//   rank 0 (1 frozen point, or several coincident)  → q = 3, N = I
//   rank 1 (2 frozen points, or 3+ collinear)       → q = 2, N spans d⊥
//   rank 2 (3+ frozen points, non-collinear)        → q = 1, the anchors alone
//                                                     determine the plane and
//                                                     the mutable points get
//                                                     ZERO weight (the
//                                                     constraints are hard, not
//                                                     weighted)
//
// For exactly 3 non-collinear anchors the normal is the exact cross product
// (b−a)×(c−a) — no eigen solve, because the scatter of three points is exactly
// rank 2 and Jacobi round-off buys nothing there. For 4+ the anchors are
// OVER-determined and only admit a plane if they are already coplanar; that is
// checked before anything is fitted.
//
// ## The 0-frozen case is deliberately NOT handled here
//
// `fitPlaneConstrained` returns `not_constrained` when nothing is frozen. The
// unconstrained path stays on `fitPlaneToPoints3d` above, bit-for-bit — its
// behavior is pinned by `tests/e2e/define-plane-mode.mjs` and routing it through
// this code would move floats for no benefit.
//
// ## Every threshold is SCALE-RELATIVE
//
// Scene units are whatever the calibration used, so an absolute millimetre
// tolerance would misfire on either a bench rig or an arena. Coplanarity and
// conditioning are both expressed as fractions of the point set's diameter.

/**
 * Coplanarity tolerance for an over-determined (4+) frozen set, as a fraction
 * of that set's diameter. 1e-3 = "flat to one part in a thousand of its own
 * size".
 */
export const PLANE_COPLANAR_TOL_FRAC = 1e-3;

/**
 * Absolute floor under {@link PLANE_COPLANAR_TOL_FRAC}, so a frozen set whose
 * diameter is (near) zero cannot demand exact-zero deviation.
 */
export const PLANE_COPLANAR_TOL_FLOOR = 1e-9;

/**
 * Conditioning fraction κ. A length must exceed κ × diameter to count as a
 * direction: anchor separation, anchor collinearity (a sine, not an area), and
 * the mutable spread that resolves the remaining freedom. Eigenvalue ratios are
 * compared against κ² because eigenvalues are squared lengths.
 */
export const PLANE_ANCHOR_COND_FRAC = 1e-3;

/**
 * Safety margin over machine epsilon for the one test that has NO defensible
 * set-relative scale: "are two frozen points the same point?". A ratio test is
 * circular there (`|b−a| ≤ κ·|b−a|` never fires) and the whole-scene diameter
 * is unrelated geometry, so the reference is the floating-point noise floor of
 * the subtraction `b − a` itself: `factor · ε · max|anchor coordinate|`.
 */
export const PLANE_ANCHOR_NOISE_FACTOR = 1e3;

/**
 * Default "this flatten would be absurd" threshold for MUTABLE points, as a
 * fraction of the point set's diameter. Purely advisory — it produces a
 * `warning`, never an error, because the geometry is well defined; only its
 * consequence is drastic.
 */
export const PLANE_MUTABLE_DEVIATION_FRAC = 0.05;

/** Display name for node `k`. @private */
function planeNodeName(nodeNames, k) {
    const n = nodeNames && nodeNames[k];
    return (typeof n === 'string' && n.length) ? n : ('node ' + k);
}

/**
 * "A", "A and B", "A, B, C" — the two-item case reads as prose, longer lists as
 * a list. @private
 */
function nameList(names) {
    if (!names || names.length === 0) return '(none)';
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + ' and ' + names[1];
    return names.join(', ');
}

/** `"Floor": ` prefix, or `Plane: ` when the caller gave no name. @private */
function planePrefix(planeName) {
    return (typeof planeName === 'string' && planeName.length)
        ? '"' + planeName + '": '
        : '';
}

/** Format a length in the caller's unit. @private */
function fmtLen(v, unit) {
    if (!isFinite(v)) return '—';
    const a = Math.abs(v);
    const s = a >= 100 ? v.toFixed(1) : (a >= 1 ? v.toFixed(2) : v.toPrecision(3));
    return s + (unit ? ' ' + unit : '');
}

/**
 * Normalize a per-node immutability spec into a boolean mask of length `n`.
 *
 * Accepts a `Set` of node indices, a boolean array parallel to the nodes, or an
 * array of node indices (numbers). Booleans and numbers are told apart by
 * element type, so a mask MUST be booleans — `[0, 1, 1]` is read as the indices
 * 0 and 1, not as a mask.
 *
 * @param {Set<number>|boolean[]|number[]|null|undefined} immutable
 * @param {number} n
 * @returns {boolean[]}
 */
export function normalizeImmutableMask(immutable, n) {
    const mask = new Array(n).fill(false);
    if (!immutable) return mask;
    const mark = function (k) { if (k >= 0 && k < n) mask[k] = true; };
    if (typeof Set !== 'undefined' && immutable instanceof Set) {
        immutable.forEach(mark);
        return mask;
    }
    if (Array.isArray(immutable)) {
        let allBool = immutable.length > 0;
        for (let i = 0; i < immutable.length; i++) {
            if (typeof immutable[i] !== 'boolean') { allBool = false; break; }
        }
        if (allBool) {
            for (let i = 0; i < immutable.length && i < n; i++) if (immutable[i]) mask[i] = true;
        } else {
            for (let i = 0; i < immutable.length; i++) {
                if (typeof immutable[i] === 'number') mark(immutable[i] | 0);
            }
        }
    }
    return mask;
}

/** Is node `k` a usable 3D point (present AND finite)? @private */
function finitePoint3d(points3d, k) {
    if (!hasPoint3d(points3d, k)) return false;
    const o = k * 3;
    return isFinite(points3d[o]) && isFinite(points3d[o + 1]) && isFinite(points3d[o + 2]);
}

/** Max pairwise distance over a small boxed point list. @private */
function pointSetDiameter(pts) {
    let d2 = 0;
    for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
            const dx = pts[i][0] - pts[j][0];
            const dy = pts[i][1] - pts[j][1];
            const dz = pts[i][2] - pts[j][2];
            const s = dx * dx + dy * dy + dz * dz;
            if (s > d2) d2 = s;
        }
    }
    return Math.sqrt(d2);
}

/**
 * Centroid + eigen-decomposition of a boxed point list's scatter matrix,
 * eigenvalues sorted DESCENDING (jacobiEigen does not sort). @private
 * @returns {{centroid:number[], values:number[], vectors:number[][]}}
 */
function scatterEigen(pts) {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < pts.length; i++) { cx += pts[i][0]; cy += pts[i][1]; cz += pts[i][2]; }
    const m = pts.length || 1;
    cx /= m; cy /= m; cz /= m;
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let i = 0; i < pts.length; i++) {
        const dx = pts[i][0] - cx, dy = pts[i][1] - cy, dz = pts[i][2] - cz;
        xx += dx * dx; xy += dx * dy; xz += dx * dz;
        yy += dy * dy; yz += dy * dz; zz += dz * dz;
    }
    const eig = jacobiEigen([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]]);
    const order = [0, 1, 2].sort(function (a, b) {
        return Math.abs(eig.eigenvalues[b]) - Math.abs(eig.eigenvalues[a]);
    });
    return {
        centroid: [cx, cy, cz],
        values: order.map(function (i) { return Math.abs(eig.eigenvalues[i]); }),
        vectors: order.map(function (i) { return eig.eigenvectors[i]; }),
    };
}

/** Unit-length copy, or null when too short to have a direction. @private */
function unit3(v) {
    const n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (!(n > 1e-300) || !isFinite(n)) return null;
    return [v[0] / n, v[1] / n, v[2] / n];
}

/** Any unit vector orthogonal to `d` (assumed unit). @private */
function anyPerp(d) {
    const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
    const axis = (ax <= ay && ax <= az) ? [1, 0, 0] : (ay <= az ? [0, 1, 0] : [0, 0, 1]);
    return unit3(cross3v(axis, d));
}

/** Cross product (local — `pose/origin-frame.js` is deliberately not imported
 * here, so this file stays free of any dependency it does not already have). */
function cross3v(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

/**
 * Flip `normal` so it agrees with `previous`, so a re-fit cannot silently
 * reverse the origin's +Z. An eigenvector's sign is arbitrary, so without this
 * the same annotation can produce ±n across runs.
 *
 * @param {number[]} normal - unit normal
 * @param {number[]|null|undefined} previous - the previous fit's unit normal
 * @returns {number[]} `normal`, possibly negated
 */
export function orientNormalLike(normal, previous) {
    if (!normal || !previous || previous.length < 3) return normal;
    if (!isFinite(previous[0]) || !isFinite(previous[1]) || !isFinite(previous[2])) return normal;
    const d = normal[0] * previous[0] + normal[1] * previous[1] + normal[2] * previous[2];
    return d < 0 ? [-normal[0], -normal[1], -normal[2]] : normal;
}

/**
 * Smallest-eigenvalue eigenvector of the symmetric 2x2 [[a,b],[b,c]].
 * Closed form — no iteration. @private
 */
function smallestEigenvector2x2(a, b, c) {
    const mid = 0.5 * (a + c);
    const half = 0.5 * (a - c);
    const disc = Math.sqrt(half * half + b * b);
    const lo = mid - disc;
    // (A − λI) v = 0 → v ∝ (b, λ−a) or (λ−c, b); take the better-conditioned one.
    const v1 = [b, lo - a];
    const v2 = [lo - c, b];
    const n1 = v1[0] * v1[0] + v1[1] * v1[1];
    const n2 = v2[0] * v2[0] + v2[1] * v2[1];
    let v = n1 >= n2 ? v1 : v2;
    const n = Math.sqrt(Math.max(n1, n2));
    if (!(n > 1e-300)) return { vector: [1, 0], value: lo, high: mid + disc };
    v = [v[0] / n, v[1] / n];
    return { vector: v, value: lo, high: mid + disc };
}

/**
 * Fit a plane CONSTRAINED to pass through every immutable ("frozen") node.
 *
 * Pure: nothing in `points3d` is read after validation fails and nothing is ever
 * written. The caller flattens with
 * {@link projectPoints3dOntoPlaneConstrained}, which leaves the frozen
 * coordinates bit-identical.
 *
 * **Requires at least one immutable node.** With none, it returns
 * `code: 'not_constrained'` and the caller must use {@link fitPlaneToPoints3d}
 * — the unconstrained path is deliberately unchanged.
 *
 * @param {Float64Array} points3d - Flat [X,Y,Z] per node; all-NaN = missing.
 * @param {{immutable?:Set<number>|boolean[]|number[], nodeNames?:string[],
 *          planeName?:string, previousNormal?:number[]|null, unit?:string,
 *          tolFrac?:number, condFrac?:number, mutableDeviationFrac?:number}} [options]
 * @returns {PlaneConstrainedFitResult} See the module docs above for codes.
 */
export function fitPlaneConstrained(points3d, options) {
    options = options || {};
    const n = points3dNodeCount(points3d);
    const nodeNames = options.nodeNames || null;
    const planeName = options.planeName;
    const unit = options.unit != null ? options.unit : 'mm';
    const tolFrac = options.tolFrac != null ? options.tolFrac : PLANE_COPLANAR_TOL_FRAC;
    const kappa = options.condFrac != null ? options.condFrac : PLANE_ANCHOR_COND_FRAC;
    const devFrac = options.mutableDeviationFrac != null
        ? options.mutableDeviationFrac : PLANE_MUTABLE_DEVIATION_FRAC;
    const mask = normalizeImmutableMask(options.immutable, n);
    const nm = function (k) { return planeNodeName(nodeNames, k); };
    const pre = planePrefix(planeName);

    /** Build a failure result. Nothing has been mutated at any call site. */
    const fail = function (code, message, extra) {
        const res = {
            ok: false, code: code, message: message, plane: null,
            anchorIndices: [], anchorNames: [], mutableIndices: [], mutableNames: [],
            warnings: [], metrics: {},
        };
        if (extra) for (const key in extra) res[key] = extra[key];
        return res;
    };

    // ---- Partition, and defend against a non-finite frozen coordinate -------
    // `hasPoint3d` only rejects NaN, so an ±Infinity would sail through it and
    // reach `jacobiEigen`, which has no NaN/Inf guard and would return a
    // garbage eigenvector. Check finiteness explicitly (decision 7).
    const anchorIdx = [], anchorPts = [], mutIdx = [], mutPts = [];
    const missingAnchors = [];
    for (let k = 0; k < n; k++) {
        if (mask[k]) {
            if (!finitePoint3d(points3d, k)) { missingAnchors.push(k); continue; }
            anchorIdx.push(k);
            anchorPts.push([points3d[k * 3], points3d[k * 3 + 1], points3d[k * 3 + 2]]);
        } else if (finitePoint3d(points3d, k)) {
            mutIdx.push(k);
            mutPts.push([points3d[k * 3], points3d[k * 3 + 1], points3d[k * 3 + 2]]);
        }
    }
    const anchorNames = anchorIdx.map(nm);
    const mutableNames = mutIdx.map(nm);

    if (missingAnchors.length) {
        const names = missingAnchors.map(nm);
        return fail('no_anchor_3d',
            pre + 'immutable ' + (names.length === 1 ? 'point ' : 'points ') + nameList(names) +
            ' ' + (names.length === 1 ? 'has' : 'have') + ' no 3D position — triangulate ' +
            (names.length === 1 ? 'it' : 'them') + ' (or unfreeze ' +
            (names.length === 1 ? 'it' : 'them') + ') before fitting.',
            { anchorIndices: missingAnchors, anchorNames: names });
    }
    if (anchorIdx.length === 0) {
        return fail('not_constrained',
            pre + 'no immutable points — use the unconstrained fit.');
    }

    // ---- Scales --------------------------------------------------------------
    // THREE different references, and mixing them up is a real bug (see the
    // coincidence tolerance below). Each threshold is scaled by the geometry it
    // is actually judging:
    //   * anchor COINCIDENCE / anchor COPLANARITY → the ANCHOR set only. These
    //     ask a question about the frozen points' mutual arrangement, so an
    //     unrelated mutable point must not be able to change the answer.
    //   * MUTABLE spread (does anything resolve the remaining freedom?) → the
    //     mutable points' own extent about the anchor (`totalR2`, below).
    //   * `diam` is retained ONLY as a reported metric and for the advisory
    //     "this flatten would be absurd" threshold, which genuinely is about
    //     the whole annotation.
    const allPts = anchorPts.concat(mutPts);
    const diam = pointSetDiameter(allPts);
    const anchorDiam = pointSetDiameter(anchorPts);
    // Largest coordinate magnitude among the ANCHORS — the magnitude of the
    // numbers `b − a` actually subtracts, hence the size of the rounding error
    // in that subtraction.
    let anchorMag = 0;
    for (let i = 0; i < anchorPts.length; i++) {
        for (let c = 0; c < 3; c++) {
            const a = Math.abs(anchorPts[i][c]);
            if (a > anchorMag) anchorMag = a;
        }
    }
    // Coincidence tolerance. NOT `κ · diam`: `diam` spans the mutable points
    // too, so a single far-away mutable node could inflate it until a real,
    // deliberately-placed anchor separation was ruled "coincident" and the line
    // constraint the user pinned was silently discarded (a 50-unit anchor gap
    // with a mutable point 1e5 away used to collapse rank 1 → 0 and then fail
    // `underdetermined` on a perfectly solvable problem).
    //
    // Nor `κ · anchorDiam`, which is circular — `anchorDiam <= κ · anchorDiam`
    // can never fire for κ < 1. There is no non-circular *set-relative* scale
    // for "is this set bigger than a point", so the honest reference is the
    // FLOATING-POINT NOISE FLOOR: `d = (b−a)/|b−a|` is well-conditioned exactly
    // when |b−a| stands clear of the rounding error in forming it, which is
    // ~ε·max|coordinate|. `PLANE_ANCHOR_NOISE_FACTOR` (1e3) is the safety
    // margin, and `PLANE_COPLANAR_TOL_FLOOR` keeps a near-origin anchor pair
    // from being trusted at absurdly small separations. Both terms are
    // anchor-intrinsic, so no mutable geometry can veto a user's constraint.
    const coincidenceTol = Math.max(
        PLANE_COPLANAR_TOL_FLOOR,
        PLANE_ANCHOR_NOISE_FACTOR * Number.EPSILON * anchorMag);

    const warnings = [];
    const metrics = {
        nAnchors: anchorIdx.length, nMutable: mutIdx.length,
        diameter: diam, anchorDiameter: anchorDiam,
        anchorMagnitude: anchorMag, coincidenceTolerance: coincidenceTol,
        anchorRms: 0, anchorTolerance: 0, anchorMaxDeviation: 0,
        rank: 0, freedom: 0,
    };

    // ---- Rank of the frozen set → the admissible-normal subspace ------------
    let anchor = anchorPts[0];
    let rank = 0;
    let lineDir = null;      // rank 1
    let normal = null;       // rank 2 (fully determined by the anchors)

    if (anchorIdx.length >= 2) {
        if (anchorDiam <= coincidenceTol) {
            // Frozen points sit on top of each other: they pin a POINT, not a
            // line. Reducing rank here is what stops a meaningless direction
            // from being amplified into the constraint.
            rank = 0;
            const se0 = scatterEigen(anchorPts);
            anchor = se0.centroid;
            warnings.push({
                code: 'anchors_coincident',
                nodeNames: anchorNames.slice(),
                message: pre + 'immutable points ' + nameList(anchorNames) +
                    ' are coincident (' + fmtLen(anchorDiam, unit) +
                    ' apart) — treated as a single anchor point.',
            });
        } else {
            const se = scatterEigen(anchorPts);
            anchor = se.centroid;
            // Collinearity as a RATIO of lengths (sqrt of the eigenvalue ratio),
            // so the test means "the off-line spread is < κ of the along-line
            // spread" in the same units the user thinks in. Both sides come
            // from the ANCHOR-only scatter, which is centred — so this is
            // already scale-free, translation-invariant, and immune to the
            // mutable-geometry pollution that broke the coincidence test. For
            // three anchors it is the eigenvalue form of the sine test
            // ‖(b−a)×(c−a)‖ ≥ κ·|b−a|·|c−a|, generalized to any anchor count.
            const along = Math.sqrt(se.values[0]);
            const across = Math.sqrt(se.values[1]);
            if (!(along > 0) || across / along < kappa) {
                rank = 1;
                lineDir = unit3(se.vectors[0]);
                if (lineDir == null) { rank = 0; }
                else if (anchorIdx.length >= 3) {
                    // Decision: a collinear 3rd+ anchor adds no information —
                    // relax to the 2-anchor (line) case and say so.
                    warnings.push({
                        code: 'anchors_collinear_relaxed',
                        nodeNames: anchorNames.slice(),
                        message: pre + 'immutable points ' + nameList(anchorNames) +
                            ' are collinear — they pin the line through them, not a plane; ' +
                            'the remaining freedom is resolved by the mutable points.',
                    });
                }
            } else {
                rank = 2;
                if (anchorIdx.length === 3) {
                    // Exact: three non-collinear points ARE a plane. No eigen
                    // solve (their scatter is exactly rank 2 and Jacobi
                    // round-off would only add noise).
                    const a = anchorPts[0], b = anchorPts[1], c = anchorPts[2];
                    normal = unit3(cross3v(
                        [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
                        [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
                    anchor = a;
                    metrics.anchorRms = 0;
                    metrics.anchorMaxDeviation = 0;
                    metrics.anchorTolerance = Math.max(tolFrac * anchorDiam, PLANE_COPLANAR_TOL_FLOOR);
                } else {
                    // 4+ non-collinear frozen points are OVER-determined: they
                    // only admit a plane if they are already coplanar. Free-fit
                    // them alone (reusing the tested unconstrained fit) and test
                    // the residual against a scale-relative tolerance.
                    //
                    // Scaled by `anchorDiam`, NOT the whole-scene `diam`: it is
                    // the ANCHORS' mutual coplanarity being judged, and both
                    // sides of the comparison (`af.rms` and the tolerance) come
                    // from the anchor set alone, so no mutable point can move
                    // the verdict.
                    const anchorFlat = makePoints3d(anchorPts.length);
                    for (let i = 0; i < anchorPts.length; i++) setPoint3d(anchorFlat, i, anchorPts[i]);
                    const af = fitPlaneToPoints3d(anchorFlat);
                    const tol = Math.max(tolFrac * anchorDiam, PLANE_COPLANAR_TOL_FLOOR);
                    metrics.anchorTolerance = tol;
                    if (af == null) {
                        return fail('anchors_collinear',
                            pre + 'immutable points ' + nameList(anchorNames) +
                            ' do not determine a plane (they are collinear or coincident). ' +
                            'Unfreeze one, or add a mutable node off that line.',
                            { anchorIndices: anchorIdx, anchorNames: anchorNames,
                              mutableIndices: mutIdx, mutableNames: mutableNames,
                              metrics: metrics });
                    }
                    let maxDev = 0;
                    for (let i = 0; i < anchorPts.length; i++) {
                        const d = Math.abs(
                            (anchorPts[i][0] - af.centroid[0]) * af.normal[0] +
                            (anchorPts[i][1] - af.centroid[1]) * af.normal[1] +
                            (anchorPts[i][2] - af.centroid[2]) * af.normal[2]);
                        if (d > maxDev) maxDev = d;
                    }
                    metrics.anchorRms = af.rms;
                    metrics.anchorMaxDeviation = maxDev;
                    if (af.rms > tol) {
                        return fail('anchors_noncoplanar',
                            pre + 'points ' + nameList(anchorNames) +
                            ' are immutable — impossible fit, they are ' +
                            fmtLen(af.rms, unit) + ' off any common plane (limit ' +
                            fmtLen(tol, unit) + '). Unfreeze one, or re-triangulate it.',
                            { anchorIndices: anchorIdx, anchorNames: anchorNames,
                              mutableIndices: mutIdx, mutableNames: mutableNames,
                              metrics: metrics });
                    }
                    normal = af.normal;
                    anchor = af.centroid;
                }
                if (normal == null) {
                    return fail('anchors_collinear',
                        pre + 'immutable points ' + nameList(anchorNames) +
                        ' are collinear — they do not determine a plane. ' +
                        'Unfreeze one, or add a mutable node off that line.',
                        { anchorIndices: anchorIdx, anchorNames: anchorNames,
                          mutableIndices: mutIdx, mutableNames: mutableNames,
                          metrics: metrics });
                }
            }
        }
    }
    metrics.rank = rank;
    metrics.freedom = 2 - rank;   // q − 1: remaining rotational DOF of the normal

    // ---- Solve the remaining freedom against the mutable points -------------
    // The scatter is taken about the ANCHOR, not the centroid: the plane is
    // pinned there, so `M = Σ (p_i − a)(p_i − a)ᵀ` is the right matrix.
    const collinearAnchors = warnings.some(function (w) {
        return w.code === 'anchors_collinear_relaxed';
    });
    const underdetermined = function () {
        const which = rank === 1
            ? ('the rotation about ' + nameList(anchorNames))
            : ('the plane through ' + nameList(anchorNames));
        const msg = pre + (anchorNames.length === 1 ? 'point ' : 'points ') +
            nameList(anchorNames) + ' ' + (anchorNames.length === 1 ? 'is' : 'are') +
            ' immutable — impossible fit with ' +
            (mutableNames.length ? 'points ' + nameList(mutableNames) : 'the mutable points') +
            ': no mutable node has a usable 3D position to resolve ' + which + '.';
        return fail(collinearAnchors ? 'anchors_collinear' : 'underdetermined',
            collinearAnchors
                ? pre + 'immutable points ' + nameList(anchorNames) +
                  ' are collinear and no mutable node lies off that line, so no plane is ' +
                  'determined. Unfreeze one, or add a mutable node off that line.'
                : msg,
            { anchorIndices: anchorIdx, anchorNames: anchorNames,
              mutableIndices: mutIdx, mutableNames: mutableNames, metrics: metrics,
              warnings: warnings });
    };

    if (rank < 2) {
        // Scatter of the mutable points about the anchor.
        let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0, totalR2 = 0;
        const R = [];
        for (let i = 0; i < mutPts.length; i++) {
            const dx = mutPts[i][0] - anchor[0];
            const dy = mutPts[i][1] - anchor[1];
            const dz = mutPts[i][2] - anchor[2];
            R.push([dx, dy, dz]);
            xx += dx * dx; xy += dx * dy; xz += dx * dz;
            yy += dy * dy; yz += dy * dz; zz += dz * dz;
            totalR2 += dx * dx + dy * dy + dz * dz;
        }
        // Same rule as the coincidence tolerance above: judge the mutable
        // points' spread against THEIR OWN extent about the anchor, never
        // against the whole-scene diameter. Scaling by `diam` here would let a
        // large anchor separation (which is part of `diam` but not part of
        // `totalR2`) declare a perfectly adequate mutable spread "too small".
        // Both sides are squared lengths of the same mutable-about-anchor
        // vectors, so these tests are scale- and translation-invariant.
        const k2 = kappa * kappa;

        if (!(totalR2 > 0)) return underdetermined();   // every mutable point AT the anchor

        if (rank === 0) {
            // q = 3. Two independent mutable directions from the anchor are
            // needed, or the "plane" is really a pencil about a line.
            if (mutPts.length < 2) return underdetermined();
            const eig = jacobiEigen([[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]]);
            const ord = [0, 1, 2].sort(function (a, b) {
                return Math.abs(eig.eigenvalues[b]) - Math.abs(eig.eigenvalues[a]);
            });
            const lam = ord.map(function (i) { return Math.abs(eig.eigenvalues[i]); });
            if (!(lam[0] > 0)) return underdetermined();
            // The real conditioning test, and it is a pure RATIO of the mutable
            // scatter's own eigenvalues: the second direction must carry at
            // least κ² of the first, or the mutable points are collinear with
            // the anchor and the "plane" is a pencil about that line.
            if (lam[1] / lam[0] < k2) return underdetermined();
            normal = unit3(eig.eigenvectors[ord[2]]);
            if (normal == null) return underdetermined();
        } else {
            // q = 2. Restrict to the 2-space orthogonal to the frozen line.
            const d = lineDir;
            const u = anyPerp(d);
            if (u == null) return underdetermined();
            const w = unit3(cross3v(d, u));
            if (w == null) return underdetermined();
            let auu = 0, auw = 0, aww = 0;
            for (let i = 0; i < R.length; i++) {
                const al = R[i][0] * u[0] + R[i][1] * u[1] + R[i][2] * u[2];
                const be = R[i][0] * w[0] + R[i][1] * w[1] + R[i][2] * w[2];
                auu += al * al; auw += al * be; aww += be * be;
            }
            const sol = smallestEigenvector2x2(auu, auw, aww);
            // Undetermined only when EVERY mutable point is (near) parallel to
            // the frozen line — then both 2x2 eigenvalues vanish and any normal
            // in the pencil fits equally well.
            //
            // The threshold is a NOISE FLOOR, not a κ-fraction of the mutable
            // extent. A mutable point that lies ON the frozen line contributes
            // exactly zero residual for EVERY admissible normal, so it cannot
            // make the fit less determined however far away it sits — but it
            // does inflate `totalR2`, and scaling by that would let one distant
            // on-line point veto a perfectly good off-line one (the same
            // pollution as the coincidence tolerance). What actually bounds the
            // answer is the rounding error in the off-line components
            // α = r·u, β = r·w, which is ~ε·|r| — hence (factor·ε)²·totalR2 in
            // squared units.
            const offLineNoise2 = Math.pow(PLANE_ANCHOR_NOISE_FACTOR * Number.EPSILON, 2);
            if (!(sol.high > offLineNoise2 * totalR2)) return underdetermined();
            normal = unit3([
                sol.vector[0] * u[0] + sol.vector[1] * w[0],
                sol.vector[0] * u[1] + sol.vector[1] * w[1],
                sol.vector[0] * u[2] + sol.vector[1] * w[2],
            ]);
            if (normal == null) return underdetermined();
        }
        // Silence the unused-var lint on totalR2 while keeping it as a metric.
        metrics.mutableSpread = Math.sqrt(totalR2 / Math.max(1, R.length));
    }

    // ---- Sign carry-forward (decision 4) -----------------------------------
    normal = orientNormalLike(normal, options.previousNormal);

    // ---- Report the plane in the same shape as the free fit -----------------
    // `centroid` is a point ON the plane, chosen as the projection of ALL
    // present points' centroid so a plane widget draws centred on the
    // annotation. `anchor` is the exact constrained reference point.
    let gx = 0, gy = 0, gz = 0;
    for (let i = 0; i < allPts.length; i++) { gx += allPts[i][0]; gy += allPts[i][1]; gz += allPts[i][2]; }
    gx /= allPts.length; gy /= allPts.length; gz /= allPts.length;
    const gd = (gx - anchor[0]) * normal[0] + (gy - anchor[1]) * normal[1] + (gz - anchor[2]) * normal[2];
    const centroid = [gx - gd * normal[0], gy - gd * normal[1], gz - gd * normal[2]];

    const signedDist = function (p) {
        return (p[0] - anchor[0]) * normal[0] + (p[1] - anchor[1]) * normal[1] +
               (p[2] - anchor[2]) * normal[2];
    };

    let sqAll = 0;
    for (let i = 0; i < allPts.length; i++) { const d = signedDist(allPts[i]); sqAll += d * d; }
    let sqMut = 0, maxMut = 0, worstIdx = [];
    const devTol = Math.max(devFrac * diam, PLANE_COPLANAR_TOL_FLOOR);
    for (let i = 0; i < mutPts.length; i++) {
        const d = Math.abs(signedDist(mutPts[i]));
        sqMut += d * d;
        if (d > maxMut) maxMut = d;
        if (d > devTol) worstIdx.push(mutIdx[i]);
    }
    metrics.mutableRmsDeviation = mutPts.length ? Math.sqrt(sqMut / mutPts.length) : 0;
    metrics.mutableMaxDeviation = maxMut;
    metrics.mutableDeviationTolerance = devTol;

    if (worstIdx.length) {
        const worstNames = worstIdx.map(nm);
        warnings.push({
            code: 'mutable_far_from_plane',
            nodeNames: worstNames,
            nodeIndices: worstIdx,
            maxDeviation: maxMut,
            rmsDeviation: metrics.mutableRmsDeviation,
            message: pre + (anchorNames.length === 1 ? 'point ' : 'points ') +
                nameList(anchorNames) + ' ' + (anchorNames.length === 1 ? 'is' : 'are') +
                ' immutable and fix the plane. Flattening would move ' +
                (worstNames.length === 1 ? 'point ' : 'points ') + nameList(worstNames) +
                ' by ' + fmtLen(maxMut, unit) + ' (max), ' +
                fmtLen(metrics.mutableRmsDeviation, unit) + ' RMS.',
        });
    }

    return {
        ok: true,
        code: 'ok',
        message: pre + 'fitted through ' + anchorIdx.length + ' immutable point' +
            (anchorIdx.length === 1 ? '' : 's') + ' (' + nameList(anchorNames) + ')' +
            (mutIdx.length ? ' and ' + mutIdx.length + ' mutable point' +
                (mutIdx.length === 1 ? '' : 's') : '') + '.',
        plane: {
            centroid: centroid,
            normal: normal,
            rms: Math.sqrt(sqAll / allPts.length),
            nPoints: allPts.length,
            anchor: anchor,
            constrained: true,
        },
        anchorIndices: anchorIdx,
        anchorNames: anchorNames,
        mutableIndices: mutIdx,
        mutableNames: mutableNames,
        warnings: warnings,
        metrics: metrics,
    };
}

/**
 * Constrained analogue of {@link projectPoints3dOntoPlane}: project only the
 * MUTABLE points onto `plane` and copy every immutable coordinate through
 * **bit-identically**.
 *
 * The copy is a raw element copy, not "project it and rely on it already being
 * on the plane" — round-off makes that false, and a frozen point that drifts by
 * an ulp per fit is exactly the silent corruption immutability exists to
 * prevent. Missing nodes stay missing (including missing immutable ones).
 *
 * @param {Float64Array} points3d
 * @param {{centroid:number[], normal:number[]}} plane
 * @param {Set<number>|boolean[]|number[]} immutable
 * @returns {Float64Array} New array; the input is untouched.
 */
export function projectPoints3dOntoPlaneConstrained(points3d, plane, immutable) {
    const n = points3dNodeCount(points3d);
    const mask = normalizeImmutableMask(immutable, n);
    const out = makePoints3d(n);
    const c = plane.centroid, nv = plane.normal;
    for (let k = 0; k < n; k++) {
        const o = k * 3;
        if (mask[k]) {
            // Verbatim — same doubles, same bits.
            out[o] = points3d[o]; out[o + 1] = points3d[o + 1]; out[o + 2] = points3d[o + 2];
            continue;
        }
        if (!hasPoint3d(points3d, k)) continue;
        const x = points3d[o], y = points3d[o + 1], z = points3d[o + 2];
        const d = (x - c[0]) * nv[0] + (y - c[1]) * nv[1] + (z - c[2]) * nv[2];
        out[o] = x - d * nv[0];
        out[o + 1] = y - d * nv[1];
        out[o + 2] = z - d * nv[2];
    }
    return out;
}

/**
 * Carry frozen 3D into a freshly triangulated `points3d`.
 *
 * An immutable node is SKIPPED by triangulation rather than triangulated and
 * discarded, so the array a triangulation pass produces has a hole where every
 * frozen node should be. This fills those holes from the stored frozen
 * coordinates, bit-identically.
 *
 * @param {Float64Array} solved - Freshly triangulated points (not modified).
 * @param {Float64Array} frozen - Frozen coordinates, indexed the same way.
 * @param {Set<number>|boolean[]|number[]} immutable
 * @returns {Float64Array} New array.
 */
export function mergeFrozenPoints3d(solved, frozen, immutable) {
    const n = points3dNodeCount(solved);
    const mask = normalizeImmutableMask(immutable, n);
    const out = makePoints3d(n);
    const fn = frozen ? points3dNodeCount(frozen) : 0;
    for (let k = 0; k < n; k++) {
        const o = k * 3;
        if (mask[k] && k < fn) {
            out[o] = frozen[o]; out[o + 1] = frozen[o + 1]; out[o + 2] = frozen[o + 2];
        } else if (mask[k]) {
            out[o] = NaN; out[o + 1] = NaN; out[o + 2] = NaN;
        } else {
            out[o] = solved[o]; out[o + 1] = solved[o + 1]; out[o + 2] = solved[o + 2];
        }
    }
    return out;
}

/**
 * Split a plane's per-node reprojection residuals into a SOLVE summary and an
 * ANCHOR summary.
 *
 * A frozen node's residual is an OUT-OF-SAMPLE residual: no degrees of freedom
 * were spent fitting it, so folding it into `meanError` makes the solve look
 * better or worse than it is — and that number is what the user reads to judge
 * annotation quality. It is still worth showing (it says "your frozen anchor no
 * longer agrees with where you clicked"), just under a different label.
 *
 * @param {Float64Array} points3d - Flat [X,Y,Z] per node.
 * @param {(number|null)[]} nodeErrors - Per-node mean pixel residual, or null.
 * @param {Set<number>|boolean[]|number[]} immutable
 * @returns {{nNodes:number, meanError:number|null, nAnchors:number,
 *            anchorMeanError:number|null, provenance:string[]}}
 *   `nNodes`/`meanError` cover MUTABLE nodes only; `provenance[k]` is
 *   `'frozen'`, `'triangulated'` or `'missing'`.
 */
export function summarizePlaneTriangulation(points3d, nodeErrors, immutable) {
    const n = points3dNodeCount(points3d);
    const mask = normalizeImmutableMask(immutable, n);
    const provenance = new Array(n);
    let nNodes = 0, sum = 0, count = 0;
    let nAnchors = 0, aSum = 0, aCount = 0;
    for (let k = 0; k < n; k++) {
        const present = hasPoint3d(points3d, k);
        provenance[k] = !present ? 'missing' : (mask[k] ? 'frozen' : 'triangulated');
        if (!present) continue;
        const e = nodeErrors && nodeErrors[k] != null ? nodeErrors[k] : null;
        if (mask[k]) {
            nAnchors++;
            if (e != null) { aSum += e; aCount++; }
        } else {
            nNodes++;
            if (e != null) { sum += e; count++; }
        }
    }
    return {
        nNodes: nNodes,
        meanError: count > 0 ? sum / count : null,
        nAnchors: nAnchors,
        anchorMeanError: aCount > 0 ? aSum / aCount : null,
        provenance: provenance,
    };
}

/**
 * Which OTHER planes a fit has invalidated, because it moved a node they share.
 *
 * Plane nodes are global, so flattening plane A onto its fit can move a node
 * plane B was fitted against — B's stored `planeFit` is then derived from
 * geometry that no longer holds. This does not BLOCK the fit (a co-owned node
 * is ordinary work, not an error); it tells the UI whose `planeFit` to drop.
 *
 * The user's instrument for pinning a shared intersection line is the immutable
 * flag: freeze the shared nodes and neither fit can move them.
 *
 * @param {Iterable<number|string>} movedNodeIds - Nodes this fit actually moved.
 * @param {Array<{id:*, nodeIds:Array<number|string>}>} planes - Candidate planes.
 * @param {*} [excludePlaneId] - Usually the plane that was just fitted.
 * @returns {Array<*>} Plane ids, input order, deduped.
 */
export function planesInvalidatedByFit(movedNodeIds, planes, excludePlaneId) {
    const moved = new Set();
    if (movedNodeIds) {
        for (const id of movedNodeIds) moved.add(id);
    }
    const out = [];
    const seen = new Set();
    if (!planes || !moved.size) return out;
    for (let i = 0; i < planes.length; i++) {
        const pl = planes[i];
        if (!pl || pl.id === undefined || pl.id === null) continue;
        if (excludePlaneId !== undefined && pl.id === excludePlaneId) continue;
        if (seen.has(pl.id)) continue;
        const ids = pl.nodeIds || [];
        for (let j = 0; j < ids.length; j++) {
            if (moved.has(ids[j])) { out.push(pl.id); seen.add(pl.id); break; }
        }
    }
    return out;
}


// ============================================
// Back-projection and ray geometry
// ============================================

/**
 * Compute camera center from a 3x4 projection matrix P.
 * The camera center is the null space of P: P * C = 0.
 * We find it via the smallest eigenvector of P^T * P.
 *
 * @param {number[][]} P - 3x4 projection matrix
 * @returns {number[]} [X, Y, Z] camera center in world coordinates
 */
export function cameraCenter(P) {
    var PT = matTranspose(P);      // 4x3
    var PTP = matMul(PT, P);       // 4x4 symmetric
    var v = solveSmallestEigenvector4x4(PTP);
    var w = v[3];
    return [v[0] / w, v[1] / w, v[2] / w];
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

/**
 * Back-project a 2D point to a 3D ray using a 3x4 projection matrix.
 *
 * @param {number[]} point2d - [u, v] pixel coordinates
 * @param {number[][]} P - 3x4 projection matrix
 * @returns {{origin: number[], direction: number[]}} Ray origin and unit direction
 */
export function backProjectToRay(point2d, P) {
    var origin = cameraCenter(P);

    // Compute pseudo-inverse: pinv(P) = P^T * inv(P * P^T)
    var PT = matTranspose(P);       // 4x3
    var PPT = matMul(P, PT);        // 3x3
    var PPTinv = invert3x3(PPT);
    var pinvP = matMul(PT, PPTinv); // 4x3

    // Back-project: homogeneous 3D point = pinv(P) * [u, v, 1]^T
    var u = point2d[0], v = point2d[1];
    var hx = pinvP[0][0] * u + pinvP[0][1] * v + pinvP[0][2];
    var hy = pinvP[1][0] * u + pinvP[1][1] * v + pinvP[1][2];
    var hz = pinvP[2][0] * u + pinvP[2][1] * v + pinvP[2][2];
    var hw = pinvP[3][0] * u + pinvP[3][1] * v + pinvP[3][2];

    // Dehomogenize
    var px = hx / hw;
    var py = hy / hw;
    var pz = hz / hw;

    // Direction = backprojected point - origin, normalized
    var dx = px - origin[0];
    var dy = py - origin[1];
    var dz = pz - origin[2];
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-15) {
        return { origin: origin, direction: [0, 0, 1] };
    }

    return { origin: origin, direction: [dx / len, dy / len, dz / len] };
}

/**
 * Batch back-project multiple 2D points to 3D rays.
 * Computes camera center and pseudo-inverse once for efficiency.
 *
 * @param {(number[]|null)[]} points2d - Array of [u,v] or null
 * @param {number[][]} P - 3x4 projection matrix
 * @returns {{origin: number[], directions: (number[]|null)[]}} Ray origin and directions
 */
export function backProjectToRays(points2d, P) {
    var origin = cameraCenter(P);

    // Compute pseudo-inverse once
    var PT = matTranspose(P);
    var PPT = matMul(P, PT);
    var PPTinv = invert3x3(PPT);
    var pinvP = matMul(PT, PPTinv);

    var directions = [];
    for (var i = 0; i < points2d.length; i++) {
        if (points2d[i] == null) {
            directions.push(null);
            continue;
        }
        var u = points2d[i][0], v = points2d[i][1];
        var hx = pinvP[0][0] * u + pinvP[0][1] * v + pinvP[0][2];
        var hy = pinvP[1][0] * u + pinvP[1][1] * v + pinvP[1][2];
        var hz = pinvP[2][0] * u + pinvP[2][1] * v + pinvP[2][2];
        var hw = pinvP[3][0] * u + pinvP[3][1] * v + pinvP[3][2];

        var px = hx / hw;
        var py = hy / hw;
        var pz = hz / hw;

        var dx = px - origin[0];
        var dy = py - origin[1];
        var dz = pz - origin[2];
        var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-15) {
            directions.push([0, 0, 1]);
        } else {
            directions.push([dx / len, dy / len, dz / len]);
        }
    }

    return { origin: origin, directions: directions };
}

/**
 * Compute perpendicular distance from a 3D point to a ray.
 *
 * @param {number[]} point - [x, y, z]
 * @param {number[]} rayOrigin - [x, y, z]
 * @param {number[]} rayDir - [dx, dy, dz] unit direction
 * @returns {number} perpendicular distance
 */
export function pointToRayDistance(point, rayOrigin, rayDir) {
    // Vector from ray origin to point
    var vx = point[0] - rayOrigin[0];
    var vy = point[1] - rayOrigin[1];
    var vz = point[2] - rayOrigin[2];

    // Project onto ray direction
    var proj = vx * rayDir[0] + vy * rayDir[1] + vz * rayDir[2];

    // Closest point on ray
    var cx = rayOrigin[0] + proj * rayDir[0];
    var cy = rayOrigin[1] + proj * rayDir[1];
    var cz = rayOrigin[2] + proj * rayDir[2];

    // Distance
    var dx = point[0] - cx;
    var dy = point[1] - cy;
    var dz = point[2] - cz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Batch compute point-to-ray distances for arrays of points and directions.
 * Handles null entries in either array.
 *
 * @param {Float64Array} points - Flat [x,y,z] per node (all-NaN = missing)
 * @param {number[]} rayOrigin - [x, y, z]
 * @param {(number[]|null)[]} rayDirs - Array of [dx,dy,dz] or null
 * @returns {(number|null)[]} distances, null where either input is missing
 */
export function pointsToRayDistances(points, rayOrigin, rayDirs) {
    var results = [];
    var len = Math.min(points3dNodeCount(points), rayDirs.length);
    var p = [0, 0, 0];
    for (var i = 0; i < len; i++) {
        if (rayDirs[i] == null || !readPoint3d(points, i, p)) {
            results.push(null);
        } else {
            results.push(pointToRayDistance(p, rayOrigin, rayDirs[i]));
        }
    }
    return results;
}


// ============================================
// Epipolar geometry
// ============================================

/**
 * Compute the fundamental matrix from cam1 to cam2.
 * F = K2^{-T} * [t_rel]_x * R_rel * K1^{-1}
 *
 * This matches sleap-3d's compute_fundamental_matrix with normalized_points=False.
 *
 * @param {Camera} cam1 - First camera
 * @param {Camera} cam2 - Second camera
 * @returns {number[][]} 3x3 fundamental matrix
 */
export function computeFundamentalMatrix(cam1, cam2) {
    var R1 = cam1.rotationMatrix;
    var R2 = cam2.rotationMatrix;
    var t1 = cam1.tvec;
    var t2 = cam2.tvec;

    // Relative rotation: R_rel = R2 * R1^T
    var R1T = matTranspose(R1);  // 3x3
    var R_rel = mat3x3Multiply(R2, R1T);

    // Relative translation: t_rel = t2 - R_rel * t1
    var Rt1 = [
        R_rel[0][0] * t1[0] + R_rel[0][1] * t1[1] + R_rel[0][2] * t1[2],
        R_rel[1][0] * t1[0] + R_rel[1][1] * t1[1] + R_rel[1][2] * t1[2],
        R_rel[2][0] * t1[0] + R_rel[2][1] * t1[1] + R_rel[2][2] * t1[2]
    ];
    var t_rel = [t2[0] - Rt1[0], t2[1] - Rt1[1], t2[2] - Rt1[2]];

    // Skew-symmetric matrix [t_rel]_x
    var tx = [
        [0, -t_rel[2], t_rel[1]],
        [t_rel[2], 0, -t_rel[0]],
        [-t_rel[1], t_rel[0], 0]
    ];

    // Essential matrix: E = [t_rel]_x * R_rel
    var E = mat3x3Multiply(tx, R_rel);

    // Fundamental matrix: F = K2^{-T} * E * K1^{-1}
    var K1inv = invert3x3(cam1.matrix);
    var K2inv = invert3x3(cam2.matrix);
    var K2invT = matTranspose(K2inv);

    var temp = mat3x3Multiply(E, K1inv);
    var F = mat3x3Multiply(K2invT, temp);

    return F;
}

/**
 * Compute mean epipolar distance for a pair of keypoint arrays.
 * For each valid keypoint pair, computes the epiline from point1 using F,
 * then measures the distance of point2 to that epiline.
 *
 * @param {(number[]|null)[]} points1 - Keypoints in camera 1 (array of [x,y] or null)
 * @param {(number[]|null)[]} points2 - Keypoints in camera 2 (array of [x,y] or null)
 * @param {number[][]} F - 3x3 fundamental matrix (cam1 -> cam2)
 * @returns {number} Mean epipolar distance, or Infinity if no valid pairs
 */
export function epipolarError(points1, points2, F) {
    var totalError = 0;
    var count = 0;
    var len = Math.min(points1.length, points2.length);

    for (var i = 0; i < len; i++) {
        if (points1[i] == null || points2[i] == null) continue;

        var x1 = points1[i][0], y1 = points1[i][1];
        var x2 = points2[i][0], y2 = points2[i][1];

        // Epiline in camera 2: l = F * [x1, y1, 1]^T
        var la = F[0][0] * x1 + F[0][1] * y1 + F[0][2];
        var lb = F[1][0] * x1 + F[1][1] * y1 + F[1][2];
        var lc = F[2][0] * x1 + F[2][1] * y1 + F[2][2];

        // Distance of point2 to epiline: |x2^T * l| / ||l[:2]||
        var num = Math.abs(x2 * la + y2 * lb + lc);
        var den = Math.sqrt(la * la + lb * lb);
        if (den > 1e-15) {
            totalError += num / den;
            count++;
        }
    }

    return count > 0 ? totalError / count : Infinity;
}

/**
 * Compute an n x m cost matrix of epipolar errors between two arrays of
 * keypoint arrays (detections).
 *
 * @param {(number[]|null)[][]} detections1 - Array of n keypoint arrays from camera 1
 * @param {(number[]|null)[][]} detections2 - Array of m keypoint arrays from camera 2
 * @param {number[][]} F - 3x3 fundamental matrix (cam1 -> cam2)
 * @returns {number[][]} n x m cost matrix
 */
export function epipolarErrorMatrix(detections1, detections2, F) {
    var n = detections1.length;
    var m = detections2.length;
    var matrix = [];
    for (var i = 0; i < n; i++) {
        matrix[i] = [];
        for (var j = 0; j < m; j++) {
            matrix[i][j] = epipolarError(detections1[i], detections2[j], F);
        }
    }
    return matrix;
}

// ============================================
// Reprojection storage utility
// ============================================

/**
 * Persist reprojected 2D instances onto an InstanceGroup. Reprojects against
 * every camera that has calibration data (not just those used for triangulation).
 */
export function storeReprojectedInstances(group, triangulationResult, allCameras) {
    if (!triangulationResult || !triangulationResult.points3d) return;
    for (var ci = 0; ci < allCameras.length; ci++) {
        var cam = allCameras[ci];
        var reprojPts = triangulationResult.reprojections[cam.name];
        if (!reprojPts && cam.projectionMatrix) {
            // Reproject into native (distorted) pixel space to match raw keypoints.
            reprojPts = reprojectPointsCamera(triangulationResult.points3d, cam);
        }
        if (reprojPts) {
            var existing = group.getReprojectedInstance
                ? group.getReprojectedInstance(cam.name) : null;
            if (existing) {
                existing.setPointsFrom(reprojPts);
            } else {
                var reprojInstance = new Instance(reprojPts, group.identityId, 'reprojected', 1.0);
                group.addReprojectedInstance(cam.name, reprojInstance);
            }
        }
    }
}

/**
 * Get a group's reprojected Instance for `camName`, synthesizing one on
 * demand from the already-cached `group.reprojections[camName]` (raw points)
 * when `reprojectedInstances` was never eagerly built for this group.
 *
 * Bulk sweeps (`triangulateAllFrames`, `triangulateMultiFrameInstances`) stop
 * calling `storeReprojectedInstances` — building a full `Instance` (with its
 * own `occluded` array) per camera per group for the WHOLE project was a
 * major, provably-unneeded memory cost (nothing in the SLP save/export path
 * reads `reprojectedInstances`; only live 2D/3D display and the opt-in
 * "Save Reprojections" export do, and both can be served from the much
 * cheaper `.reprojections` raw-points object those sweeps still populate).
 * Single-frame paths (`triangulateCurrentFrame`, `reTriangulateGroup`) still
 * call `storeReprojectedInstances` eagerly — bounded cost, immediate feedback
 * while the user is actively working on that frame — so this only needs to
 * cover the bulk-sweep gap. Never mutates/caches onto the group; a caller
 * that wants the result retained should use `storeReprojectedInstances`
 * instead (as the single-frame paths already do).
 * @param {InstanceGroup} group
 * @param {string} camName
 * @returns {Instance|null}
 */
export function getOrComputeReprojectedInstance(group, camName) {
    var existing = group.getReprojectedInstance ? group.getReprojectedInstance(camName) : null;
    if (existing) return existing;
    var pts = group.reprojections ? group.reprojections[camName] : null;
    if (!pts) return null;
    return new Instance(pts, group.identityId, 'reprojected', 1.0);
}

// ============================================
// Lazy H5 Frame Loader
// ============================================

/**
 * Per-camera worker-backed lazy loader for analysis H5 files. Spawns one
 * `loading/slp-import-worker.js` per camera, holds metadata, and serves
 * frame requests with prefetch + LRU caching.
 */
export class LazyFrameLoader {
    constructor() {
        this.workers = new Map();
        this.metadata = new Map();
        this.cache = new Map();
        this.cacheOrder = [];
        this.maxCacheSize = 100;
        this.prefetchAhead = 20;
        this.nFrames = 0;
        this.skeleton = null;
        this.trackNames = [];
        this.videos = new Map();
        this.trackOccupancy = new Map();
        this._requestId = 0;
        this._pending = new Map();
    }

    open(cameraName, file, onProgress) {
        var self = this;
        return new Promise(function (resolve, reject) {
            // Resolve worker URL relative to the document base so this works on
            // sub-path deployments (e.g. GitHub Pages /luc3d/, /luc3d/pr/N/) as well
            // as localhost. We use document.baseURI rather than `new URL(..., import.meta.url)`
            // because triangulation.js is loaded via vm.Script in tests/run-node.js
            // (classic-script context, where `import.meta` is a parse error). See ISSUES.md I-8.
            var workerUrl = new URL('loading/slp-import-worker.js?v=' + Date.now(), document.baseURI);
            var worker = new Worker(workerUrl, { type: 'module' });
            worker.onmessage = function (e) {
                var msg = e.data;
                if (msg.type === 'metadata') {
                    self.workers.set(cameraName, worker);
                    self.metadata.set(cameraName, msg.data);
                    if (!self.skeleton) {
                        self.skeleton = msg.data.skeleton;
                        self.trackNames = msg.data.trackNames;
                    }
                    if (msg.data.nFrames > self.nFrames) self.nFrames = msg.data.nFrames;
                    self.videos.set(cameraName, msg.data.videos ? msg.data.videos[0] : null);
                    if (msg.data.trackOccupancy) {
                        self.trackOccupancy.set(cameraName, {
                            data: msg.data.trackOccupancy,
                            nTracks: msg.data.nTracks,
                            nFrames: msg.data.nFrames,
                        });
                    }
                    resolve(msg.data);
                } else if (msg.type === 'frameData') {
                    var cb = self._pending.get(msg.requestId);
                    if (cb) { self._pending.delete(msg.requestId); cb.resolve({ frameIdx: msg.frameIdx, instances: msg.instances }); }
                } else if (msg.type === 'framesData') {
                    var cb2 = self._pending.get(msg.requestId);
                    if (cb2) { self._pending.delete(msg.requestId); cb2.resolve(msg.frames); }
                } else if (msg.type === 'error') {
                    if (msg.requestId !== undefined) {
                        var cb3 = self._pending.get(msg.requestId);
                        if (cb3) { self._pending.delete(msg.requestId); cb3.reject(new Error(msg.message)); return; }
                    }
                    reject(new Error(msg.message));
                } else if (msg.type === 'progress' && onProgress) {
                    onProgress(msg.message);
                }
            };
            worker.onerror = function (e) { reject(new Error('Worker error: ' + e.message)); };
            worker.postMessage({ type: 'open', file: file });
        });
    }

    async getFrame(frameIdx) {
        if (this.cache.has(frameIdx)) { this._touchCache(frameIdx); return this.cache.get(frameIdx); }
        var self = this;
        var cameraNames = Array.from(this.workers.keys());
        var promises = cameraNames.map(function (camName) {
            var reqId = ++self._requestId;
            var worker = self.workers.get(camName);
            return new Promise(function (resolve, reject) {
                self._pending.set(reqId, { resolve: resolve, reject: reject });
                worker.postMessage({ type: 'getFrame', frameIdx: frameIdx, requestId: reqId });
            });
        });
        var results = await Promise.all(promises);
        var frameMap = new Map();
        for (var i = 0; i < cameraNames.length; i++) { frameMap.set(cameraNames[i], results[i].instances); }
        this._putCache(frameIdx, frameMap);
        return frameMap;
    }

    prefetch(frameIdx, direction) {
        var self = this;
        var start = direction > 0 ? frameIdx + 1 : Math.max(0, frameIdx - this.prefetchAhead);
        var end = direction > 0 ? Math.min(this.nFrames, frameIdx + this.prefetchAhead + 1) : frameIdx;
        var uncachedStart = -1, uncachedEnd = -1;
        for (var fi = start; fi < end; fi++) {
            if (!this.cache.has(fi)) { if (uncachedStart < 0) uncachedStart = fi; uncachedEnd = fi + 1; }
        }
        if (uncachedStart < 0) return;
        var cameraNames = Array.from(this.workers.keys());
        for (var ci = 0; ci < cameraNames.length; ci++) {
            (function (cn, rid, w) {
                self._pending.set(rid, {
                    resolve: function (frames) {
                        for (var fi2 = 0; fi2 < frames.length; fi2++) {
                            var fData = frames[fi2];
                            var entry = self.cache.get(fData.frameIdx) || new Map();
                            entry.set(cn, fData.instances);
                            if (!self.cache.has(fData.frameIdx)) self._putCache(fData.frameIdx, entry);
                        }
                    },
                    reject: function () { }
                });
                w.postMessage({ type: 'getFrames', startIdx: uncachedStart, endIdx: uncachedEnd, requestId: rid });
            })(cameraNames[ci], ++this._requestId, this.workers.get(cameraNames[ci]));
        }
    }

    _touchCache(frameIdx) {
        var idx = this.cacheOrder.indexOf(frameIdx);
        if (idx >= 0) this.cacheOrder.splice(idx, 1);
        this.cacheOrder.push(frameIdx);
    }

    _putCache(frameIdx, data) {
        if (this.cache.has(frameIdx)) { this._touchCache(frameIdx); return; }
        this.cache.set(frameIdx, data);
        this.cacheOrder.push(frameIdx);
        while (this.cacheOrder.length > this.maxCacheSize) { this.cache.delete(this.cacheOrder.shift()); }
    }

    /** Return cached frame data synchronously, or null if not cached. */
    getFrameSync(frameIdx) {
        if (this.cache.has(frameIdx)) {
            this._touchCache(frameIdx);
            return this.cache.get(frameIdx);
        }
        return null;
    }

    close() {
        for (var entry of this.workers) {
            try { entry[1].postMessage({ type: 'close' }); entry[1].terminate(); } catch (e) { }
        }
        this.workers.clear(); this.metadata.clear(); this.cache.clear();
        this.cacheOrder = []; this._pending.clear();
    }
}

// ============================================
// Helpers — file detection + frame group access
// ============================================

/**
 * Check if a file is an analysis H5 that should use lazy loading.
 * Returns true for .h5 files over 20MB.
 */
export function shouldUseLazyH5(file) {
    var name = file.name.toLowerCase();
    var isH5 = name.endsWith('.h5') || name.endsWith('.hdf5');
    return isH5 && file.size > 20 * 1024 * 1024;
}

// Large prediction `.slp` files (many 10k+ frames, 100k+ instances) must not be
// parsed eagerly — the full object graph OOMs the tab. Above this size they load
// via the sleap-io.js streaming lazy reader (SioLazyLoader). Small hand-labeled
// `.slp` stay on the eager path so their instances keep the grouped display.
export var LAZY_SLP_THRESHOLD = 150 * 1024 * 1024;

/**
 * Check if a `.slp` is large enough to require lazy loading via sleap-io.js's
 * streaming lazy reader (as opposed to the eager `parseSlpH5` path).
 */
export function shouldUseLazySlp(file) {
    var name = file.name.toLowerCase();
    return name.endsWith('.slp') && file.size > LAZY_SLP_THRESHOLD;
}

export function getInstanceGroupsForFrame(frameIdx) {
    return state.session ? (state.session.instanceGroups.get(frameIdx) || []) : [];
}

/**
 * Check whether a frame has any grouped UserInstances.
 */
export function frameHasGroupedUserInstances(frameIdx) {
    var groups = getInstanceGroupsForFrame(frameIdx);
    for (var i = 0; i < groups.length; i++) {
        for (var [, inst] of groups[i].instances) {
            if (inst.type === 'user') return true;
        }
    }
    return false;
}

// ============================================
// Lazy frame loading helpers
// ============================================

/**
 * Finalize a freshly-built lazy FrameGroup: split its raw per-camera store
 * instances (currently all in `fg.instances`) into this frame's pre-existing
 * InstanceGroups vs the unlinked pool.
 *
 * No pre-existing groups for this frame (fresh, untracked session, or a
 * frame Track All hasn't reached yet): every raw instance goes to the
 * unlinked pool (the original behavior).
 *
 * Pre-existing groups for this frame — from EITHER a reopened lazy project
 * (`reconstructInstanceGroupsFromSessionLazy`, lightweight members tagged
 * `_rawInstIndex`/`_lazy2d`) OR a fresh Track All run on this same session
 * (`commitTrackedFrame` reuses the SAME already-`_rawInstIndex`-tagged
 * Instance objects it found resident in `fg.instances`/`fg.unlinkedInstances`
 * at tracking time — see `buildLazyFrameGroupSync`/`ensureLazyFrameData`,
 * which both tag `_rawInstIndex` on every instance they materialize, so a
 * Track-All group's members carry it too, not just a reopen's): **hydrate**
 * each member's 2D from the matching raw store instance (by `_rawInstIndex`,
 * a no-op when the member already has real points, as a fresh Track-All
 * group's do) and place the member in `fg.instances` (grouped); only the
 * non-member raw instances go to the unlinked pool — mirroring an
 * eager-loaded frame so rendering / the 3D view / reprojection all work
 * unchanged.
 *
 * BUG FIXED (reported: grouped instances AND duplicate unlinked instances
 * for the same animals on every frame except the current one, after Track
 * All): this used to gate the hydration branch on `session._lazyReopened`
 * specifically — true ONLY for a reopened project, never for a session
 * that was tracked fresh in this same session. A fresh Track-All sweep
 * evicts every frame except the current one from `session.frameGroups`
 * (`sweepTrackAllFrames`'s windowed release), but `session.instanceGroups`
 * is never evicted — so when the user later scrubbed to any OTHER frame,
 * it re-materialized here, always took the "no pre-existing groups" branch
 * (since `_lazyReopened` was never set), and dumped every instance into the
 * unlinked pool even though `session.instanceGroups` already had real
 * groups for it — rendering each tracked animal twice: once via its
 * (still-resident) InstanceGroup, once again as a freshly-unlinked
 * duplicate. Only the current frame (kept resident throughout Track All,
 * never evicted/rebuilt) was unaffected. Fixed by checking
 * `session.instanceGroups` directly instead of gating on `_lazyReopened` —
 * the hydration logic below already works for both origins unchanged.
 */
function finalizeLazyFrameGroup(session, fg, frameIdx) {
    var groups = session.instanceGroups ? session.instanceGroups.get(frameIdx) : null;

    if (!groups || groups.length === 0) {
        for (var [cn, camInsts] of fg.instances) {
            for (var instItem of camInsts) {
                fg.addUnlinkedInstance(cn, new UnlinkedInstance(instItem, cn));
            }
            fg.instances.set(cn, []);
        }
        return;
    }

    // (camName -> Map(rawInstIndex -> member)) for this frame's groups.
    var memberByCamIdx = new Map();
    for (var gi = 0; gi < groups.length; gi++) {
        for (var [mcn, m] of groups[gi].instances) {
            if (m._rawInstIndex == null) continue;
            var mm = memberByCamIdx.get(mcn);
            if (!mm) { mm = new Map(); memberByCamIdx.set(mcn, mm); }
            mm.set(m._rawInstIndex, m);
        }
    }
    for (var [cn2, built] of fg.instances) {
        var mm2 = memberByCamIdx.get(cn2);
        var grouped = [];
        for (var bi = 0; bi < built.length; bi++) {
            var member = mm2 ? mm2.get(bi) : undefined;
            if (member) {
                if (member._lazy2d) {
                    // Hydrate the member's 2D from the store instance at this row.
                    member.adoptPointsFrom(built[bi]);
                    member._lazy2d = false;
                }
                grouped.push(member);
            } else {
                fg.addUnlinkedInstance(cn2, new UnlinkedInstance(built[bi], cn2));
            }
        }
        fg.instances.set(cn2, grouped);
    }
}

/**
 * Ensure frame data is loaded for lazy sessions.
 * For eager sessions, returns immediately. For lazy sessions,
 * fetches the frame data from workers and populates a temporary FrameGroup.
 */
export async function ensureLazyFrameData(frameIdx) {
    var session = state.session;
    if (!session || !session.lazyLoader) return;

    if (session.frameGroups.has(frameIdx)) return;

    var cameraData = await session.lazyLoader.getFrame(frameIdx);

    if (session.frameGroups.has(frameIdx)) return;

    var fg = new FrameGroup(frameIdx);
    for (var [camName, instances] of cameraData) {
        for (var ii = 0; ii < instances.length; ii++) {
            var instData = instances[ii];
            var inst = new Instance(
                instData.points || [],
                instData.trackIdx,
                instData.type || 'predicted',
                instData.score || 0
            );
            // `ii` is this instance's position in the frame's raw instance list,
            // i.e. its row offset within the lazy store's [start,end) range for
            // this (camera, frame) — see slp-streaming-write.js's `refFor`, which
            // uses this to resolve the exact store row on save instead of
            // guessing via trackIdx (ambiguous/wrong whenever a frame has more
            // than one instance and the grouped one is trackless).
            inst._rawInstIndex = ii;
            fg.addInstance(camName, inst);
        }
    }
    session.addFrameGroup(fg);

    finalizeLazyFrameGroup(session, fg, frameIdx);

    var direction = frameIdx >= (state._lastLazyFrame || 0) ? 1 : -1;
    state._lastLazyFrame = frameIdx;
    session.lazyLoader.prefetch(frameIdx, direction);

    var ahead = direction > 0 ? 1 : -1;
    for (var pfi = 1; pfi <= 30; pfi++) {
        var pfIdx = frameIdx + pfi * ahead;
        if (pfIdx < 0 || pfIdx >= session.lazyLoader.nFrames) break;
        if (session.frameGroups.has(pfIdx)) continue;
        buildLazyFrameGroupSync(pfIdx);
    }
}

/**
 * Build a FrameGroup from cached lazy data (synchronous).
 * Returns true if data was available and FrameGroup was created.
 */
export function buildLazyFrameGroupSync(frameIdx) {
    var session = state.session;
    if (!session || !session.lazyLoader) return false;
    if (session.frameGroups.has(frameIdx)) return true;

    var cached = session.lazyLoader.getFrameSync(frameIdx);
    if (!cached) return false;

    var fg = new FrameGroup(frameIdx);
    for (var [camName, instances] of cached) {
        for (var ii = 0; ii < instances.length; ii++) {
            var instData = instances[ii];
            var inst = new Instance(
                instData.points || [],
                instData.trackIdx,
                instData.type || 'predicted',
                instData.score || 0
            );
            // See the identical tag in ensureLazyFrameData above — this is
            // the store row offset `refFor` (slp-streaming-write.js) needs to
            // resolve this instance's exact raw row on save.
            inst._rawInstIndex = ii;
            fg.addInstance(camName, inst);
        }
    }
    session.addFrameGroup(fg);
    finalizeLazyFrameGroup(session, fg, frameIdx);
    return true;
}

/**
 * Batch-load a range of frames from lazy loader into session.frameGroups.
 * Uses the getFrames batch endpoint for efficiency (~100ms per 500 frames).
 */
export async function batchLoadLazyFrames(startIdx, count, onProgress) {
    var session = state.session;
    if (!session || !session.lazyLoader) return 0;
    var loader = session.lazyLoader;
    var endIdx = Math.min(startIdx + count, loader.nFrames);

    var needStart = -1, needEnd = -1;
    for (var fi = startIdx; fi < endIdx; fi++) {
        if (!session.frameGroups.has(fi)) {
            if (needStart < 0) needStart = fi;
            needEnd = fi + 1;
        }
    }
    if (needStart < 0) return 0;

    // Main-thread lazy loaders (SioLazyLoader) have no workers — materialize the
    // range synchronously via buildLazyFrameGroupSync (getFrameSync builds on
    // demand). Keeps the same FrameGroup/unlinked-instance shape as the worker path.
    if (loader.isSync) {
        var syncLoaded = 0;
        for (var syncFi = needStart; syncFi < needEnd; syncFi++) {
            if (session.frameGroups.has(syncFi)) continue;
            if (buildLazyFrameGroupSync(syncFi)) syncLoaded++;
            if (onProgress && syncLoaded % 100 === 0) onProgress(syncLoaded, needEnd - needStart);
        }
        return syncLoaded;
    }

    var cameraNames = Array.from(loader.workers.keys());
    var batchPromises = cameraNames.map(function (camName) {
        var reqId = ++loader._requestId;
        var worker = loader.workers.get(camName);
        return new Promise(function (resolve, reject) {
            loader._pending.set(reqId, { resolve: resolve, reject: reject });
            worker.postMessage({ type: 'getFrames', startIdx: needStart, endIdx: needEnd, requestId: reqId });
        });
    });

    var batchResults = await Promise.all(batchPromises);

    var loaded = 0;
    for (var bi = 0; bi < batchResults[0].length; bi++) {
        var frameIdx = batchResults[0][bi].frameIdx;
        if (session.frameGroups.has(frameIdx)) continue;

        var fg = new FrameGroup(frameIdx);
        for (var ci = 0; ci < cameraNames.length; ci++) {
            var camData = batchResults[ci][bi];
            if (!camData || !camData.instances) continue;
            for (var ii = 0; ii < camData.instances.length; ii++) {
                var instData = camData.instances[ii];
                var inst = new Instance(
                    instData.points || [], instData.trackIdx,
                    instData.type || 'predicted', instData.score || 0
                );
                // See ensureLazyFrameData's identical tag above.
                inst._rawInstIndex = ii;
                fg.addInstance(cameraNames[ci], inst);
            }
        }
        session.addFrameGroup(fg);
        for (var [cn, camInsts] of fg.instances) {
            for (var instItem of camInsts) {
                fg.addUnlinkedInstance(cn, new UnlinkedInstance(instItem, cn));
            }
            fg.instances.set(cn, []);
        }
        loaded++;
        if (onProgress && loaded % 100 === 0) onProgress(loaded, needEnd - needStart);
    }
    return loaded;
}

/**
 * Load ALL lazy frames in batches with progress UI.
 * Used before bulk operations (triangulate all, etc.) that need every frame.
 *
 * `onStatus` is an optional callback the caller wires to its loading-toast/status
 * function — kept as a parameter to avoid a circular import back into app.js.
 */
export async function loadAllLazyFrames(onStatus) {
    var session = state.session;
    if (!session || !session.lazyLoader) return;
    var loader = session.lazyLoader;
    var BATCH = 5000;
    var totalLoaded = 0;
    for (var start = 0; start < loader.nFrames; start += BATCH) {
        if (onStatus) onStatus('Loading frames ' + start + '/' + loader.nFrames + '...');
        var loaded = await batchLoadLazyFrames(start, BATCH);
        totalLoaded += loaded;
    }
    return totalLoaded;
}

/**
 * Evict old lazy-loaded frames to keep memory bounded.
 */
export function evictLazyFrames(currentFrame) {
    var session = state.session;
    if (!session || !session.lazyLoader) return;

    // (The loader's internal per-camera typed-frame cache is bounded automatically
    // by `frameCacheLimit`, set in SioLazyLoader.open — no manual cap needed here.)
    var maxKeep = 500;
    var keys = Array.from(session.frameGroups.keys());
    if (keys.length <= maxKeep) return;

    if (!evictLazyFrames._counter) evictLazyFrames._counter = 0;
    if (++evictLazyFrames._counter % 50 !== 0) return;

    keys.sort(function (a, b) {
        return Math.abs(a - currentFrame) - Math.abs(b - currentFrame);
    });

    var evicted = 0;
    for (var i = maxKeep; i < keys.length; i++) {
        var fIdx = keys[i];
        if (fIdx === currentFrame) continue;

        var fgEvict = session.frameGroups.get(fIdx);
        if (!fgEvict) continue;

        var hasUserData = false;
        for (var [, insts] of fgEvict.instances) {
            for (var instCheck of insts) {
                if (instCheck.type === 'user') { hasUserData = true; break; }
            }
            if (hasUserData) break;
        }
        if (!hasUserData) {
            for (var [, uInsts] of fgEvict.unlinkedInstances) {
                for (var uInst of uInsts) {
                    if (uInst.instance && uInst.instance.type === 'user') { hasUserData = true; break; }
                }
                if (hasUserData) break;
            }
        }
        if (!hasUserData && session.instanceGroups.has(fIdx)) {
            hasUserData = true;
        }

        if (!hasUserData) {
            session.frameGroups.delete(fIdx);
            evicted++;
        }
    }
}

/**
 * Update timeline markers and track bars for a frame after group changes.
 * Sets the white modified tick only if grouped UserInstances remain,
 * and rebuilds track bars so removed groups disappear.
 */
export function updateTimelineForFrame(frameIdx) {
    if (!timeline) return;
    timeline.setFrameModified(frameIdx, frameHasGroupedUserInstances(frameIdx));
    // `{ cap: true }`: group/link/track changes add track rows, and an uncapped
    // refresh grows the container to getPreferredHeight() — which for a lazy
    // prediction session (up to MAX_TRACK_ROWS_PER_CAMERA per camera) is thousands
    // of px, ballooning the timeline over the camera views. Cap re-clamps to 30% of
    // the window and scrolls the overflow. (triangulateCurrentFrame caps afterward,
    // but grouping/linking/navigation callers relied on this being capped.)
    timeline.refreshTracks(state.session, { cap: true });
}

// ============================================
// Multi-frame triangulation orchestration (BACKEND only)
// ============================================

/**
 * Backend orchestration for multi-frame triangulation. Runs through
 * `[startFrame, endFrame]` and triangulates every InstanceGroup that has
 * ≥2 views with labels. Yields to UI every 50 frames so a progress bar
 * can repaint. The modal UI wrapper lives in `ui/export-modals.js` (`runMultiFrameTriangulation`)
 * and is responsible for DOM updates, post-loop redraws, and timeline syncs.
 *
 * `onProgress(completed, total)` is invoked per frame; pass it to drive a
 * progress bar.
 *
 * Returns `{triangulated, totalGroups, totalErrors}`.
 */
export async function triangulateMultiFrameInstances(startFrame, endFrame, onProgress, method) {
    method = (method === 'ba') ? 'ba' : 'dlt';
    var totalFrames = endFrame - startFrame + 1;
    var session = state.session;
    var cameras = session.cameras;
    var completed = 0;
    var triangulated = 0;
    var totalGroups = 0;
    var totalErrors = [];

    // MEMORY / CORRECTNESS (luc3d #195): sweep the range through
    // `sweepLazyFrameWindows` so each frame's 2D is HYDRATED before it is
    // triangulated. This loop used to read `session.instanceGroups.get(f)`
    // directly and triangulate from whatever 2D happened to be resident — which
    // on a lazily reopened project is a handful of frames, so a range
    // re-triangulation silently did almost nothing (the same defect as
    // `triangulateAllFrames`, luc3d #194). The sweep hydrates and releases in
    // 2,000-frame windows, so a range covering the whole project is bounded.
    await sweepLazyFrameWindows(session, function (f) {
        var frameGroupsList2 = session.instanceGroups.get(f);
        if (!frameGroupsList2) return;
        var frameResults = [];

        for (var gi = 0; gi < frameGroupsList2.length; gi++) {
            var group = frameGroupsList2[gi];
            // Camera-name fixup + >=2-usable-view gate + points3d/usedCameras
            // stores are shared with the other two paths (see
            // `_triangulateGroupStep`).
            var step = _triangulateGroupStep(group, cameras, method);
            if (!step) continue;
            var result = step.result;

            group.reprojections = result.reprojections;
            // NOT storeReprojectedInstances here — this is a bulk sweep (the range
            // can span the entire project); eagerly building a full Instance (+ its
            // own `occluded` array) per camera per group here was a major memory
            // cost never needed by SLP save/export. Display and export instead
            // resolve on demand via getOrComputeReprojectedInstance.
            group.markClean();
            totalGroups++;

            frameResults.push({
                group: group,
                points3d: result.points3d,
                reprojections: result.reprojections,
                errors: result.errors,
                errorsUndistorted: result.errorsUndistorted,
                meanError: result.meanError,
                meanErrorUndistorted: result.meanErrorUndistorted,
                method: result.method,
            });

            if (result.meanError != null) {
                totalErrors.push(result.meanError);
            }
        }

        if (frameResults.length > 0) {
            state.triangulationResults.set(f, frameResults);
            triangulated++;
        }
        completed++;
    }, {
        start: startFrame,
        end: endFrame,
        onProgress: function () { if (onProgress) onProgress(completed, totalFrames); },
    });

    return { triangulated: triangulated, totalGroups: totalGroups, totalErrors: totalErrors };
}

// ============================================
// Method preservation (luc3d: "exported 3D must equal displayed 3D")
// ============================================

/**
 * Which method should be used to (re-)triangulate `group`?
 *
 * `triangulateAndReproject`'s `options.method` default is SILENT DLT, so every
 * caller that omits it quietly downgrades a bundle-adjusted group to DLT. The
 * rule, in priority order:
 *
 *   1. The group's OWN recorded method — a group already refined with BA must
 *      stay BA, otherwise a re-solve replaces the 3D the user is looking at (and
 *      that a subsequent save/export writes) with a *different*, worse solution.
 *   2. Otherwise the user's global default (Settings ▸ Triangulation Method),
 *      which is what an explicit user action on a brand-new group should honor.
 *      Never a bare `'dlt'` literal.
 *
 * `typeof` guard on the settings getter for the flat-script test harness
 * (`tests/run-node.js`), which does not resolve the ES import — same pattern as
 * `isCameraTracked` / `getTrackingThreshold` above.
 *
 * NOT used by `ui/rendering.js`'s lazy reprojection fill, deliberately. That
 * path re-derives reprojections for 3D it does NOT own and does not write back,
 * so it must REPRODUCE the existing solve (`=== 'ba' ? 'ba' : 'dlt'`); falling
 * back to the global default there would report the error of a solution the
 * group does not hold. Rule of thumb: writes `points3d` → use this; only reads
 * it → match the recorded method exactly.
 *
 * @param {InstanceGroup|null} [group] - the group about to be triangulated, or
 *   the equivalent PRIOR group when a rebuild produced a fresh object.
 * @returns {'ba'|'dlt'}
 */
export function resolveTriangulationMethod(group) {
    if (group && group.triangulationMethod === 'ba') return 'ba';
    if (group && group.triangulationMethod === 'dlt') return 'dlt';
    var pref = (typeof getDefaultTriangulationMethod === 'function')
        ? getDefaultTriangulationMethod() : 'dlt';
    return pref === 'ba' ? 'ba' : 'dlt';
}

/**
 * Find the group in `priorGroups` that is the SAME group as `group` — i.e. its
 * membership is identical, camera for camera, by Instance object identity.
 *
 * The regrouping sweeps (`groupByIdentityAndTriangulateAll`,
 * `groupByTrackAndTriangulateAll`) delete a frame's `instanceGroups` and build
 * fresh `InstanceGroup` objects around the SAME `Instance` objects. The fresh
 * object carries no `points3d` and no `triangulationMethod`, so without this
 * lookup a regroup cannot tell "I just rebuilt the identical group, its existing
 * 3D is still exactly right" from "this is a genuinely new grouping". It used to
 * assume the latter for every group and re-solve with DLT — silently replacing
 * a whole project's BA 3D, and with it what gets saved/exported.
 *
 * Identical membership means identical 2D input, so the prior 3D is still the
 * correct solution: nothing to recompute. (2D edits cannot hide here — moving or
 * nulling a node already routes through `reTriangulateGroup`, which refreshes
 * the group's 3D at edit time, preserving its method.)
 *
 * @param {InstanceGroup[]|null} priorGroups
 * @param {InstanceGroup} group
 * @returns {InstanceGroup|null}
 */
export function findEquivalentPriorGroup(priorGroups, group) {
    if (!priorGroups || !priorGroups.length || !group) return null;
    for (var i = 0; i < priorGroups.length; i++) {
        var prior = priorGroups[i];
        if (!prior || prior === group) continue;
        if (prior.instances.size !== group.instances.size) continue;
        var same = true;
        for (var [cn, inst] of group.instances) {
            if (prior.instances.get(cn) !== inst) { same = false; break; }
        }
        if (same) return prior;
    }
    return null;
}

/**
 * Adopt `prior`'s already-valid 3D onto `group` instead of re-solving it —
 * but ONLY when doing so is a genuine no-op with respect to `method`.
 *
 * Only call with a `prior` from `findEquivalentPriorGroup` (identical
 * membership). Adoption requires BOTH:
 *   * identical membership (the caller's job) — so the 2D input is unchanged; and
 *   * `prior.triangulationMethod === method` — so the stored 3D already IS the
 *     solution this operation was asked to produce.
 *
 * The method check is load-bearing, not defensive. The grouping sweeps are
 * GOVERNED by the requested method (the Settings default, or an explicit pick):
 * with Bundle Adjustment selected, "Group by Track / Group by ID & Triangulate
 * All" must leave BA 3D on every group — including groups that already had
 * perfectly good DLT 3D with unchanged membership. Adopting on membership alone
 * would silently keep that DLT solution and make the setting a no-op for exactly
 * the groups a user is most likely to have. Conversely a DLT re-run over a
 * DLT-solved project adopts everything and solves nothing, which is the free fast
 * path this exists for.
 *
 * Copies `points3d`, `triangulationMethod` and `usedCameras`.
 *
 * `reprojections` is deliberately NOT copied. It is pure derived state, and
 * leaving it empty is what lets `ui/rendering.js`'s lazy fill regenerate both it
 * AND `state.triangulationResults` for the displayed frame using the adopted
 * `triangulationMethod` — so the reported error matches the adopted 3D. Copying
 * it would instead SUPPRESS that fill (its condition is "has points3d but no
 * reprojections"), leaving the Info Panel with no results to show. Same reason
 * the memory-bounded sweeps drop it; `points3d` is what save/export reads.
 *
 * `triangulationMethod` IS persisted (per-group
 * `metadata.lucid.triangulationMethod`, written by both SLP writers and restored
 * by the importer), so this check still works on a REOPENED project. It was not,
 * originally: a reopened project had 3D with an undefined method, so nothing could
 * ever be adopted and `ui/rendering.js`'s fill reported DLT's error for BA points.
 *
 * @param {InstanceGroup} group
 * @param {InstanceGroup|null} prior
 * @param {'ba'|'dlt'} method - the method this operation is required to produce
 * @returns {boolean} true if 3D was adopted and `group` needs no triangulation
 */
export function adoptPrior3d(group, prior, method) {
    if (!group || !prior) return false;
    if (!someValidPoint3d(prior.points3d)) return false;
    // Only adopt a solution produced by the method being asked for. An undefined
    // prior method is NOT assumed to be DLT: it is unknown, so it never matches
    // and the group is re-solved rather than trusted.
    var want = (method === 'ba') ? 'ba' : 'dlt';
    if (prior.triangulationMethod !== want) return false;
    group.points3d = prior.points3d;
    group.triangulationMethod = want;
    if (prior.usedCameras && prior.usedCameras.size) group.usedCameras = prior.usedCameras;
    return true;
}

/**
 * Re-triangulate a single instance group if it was previously triangulated.
 * Called automatically when a node is moved or nulled to keep reprojections in sync.
 */
export function reTriangulateGroup(instanceGroup) {
    if (!instanceGroup) return;
    if (!state.session || state.session.cameras.length < 2) return;

    var cameras = state.session.cameras;
    var groupCamNames = instanceGroup.cameraNames;
    var groupCameras = cameras.filter(function (c) { return groupCamNames.indexOf(c.name) >= 0; });
    if (groupCameras.length < 2) return;

    // Save old reprojections in case re-triangulation fails
    var oldReprojInstances = instanceGroup.reprojectedInstances
        ? new Map(instanceGroup.reprojectedInstances) : null;
    var oldReprojections = instanceGroup.reprojections;
    var oldPoints3d = instanceGroup.points3d;

    // Preserve whichever method this group was last triangulated with so a node
    // move re-refines consistently (e.g. a BA group stays BA); a group with no
    // recorded method (e.g. 3D loaded from file) takes the user's global default.
    var method = resolveTriangulationMethod(instanceGroup);
    var result = triangulateAndReproject(instanceGroup, groupCameras, { method: method });
    instanceGroup.triangulationMethod = result.method;

    // Only update if we got valid results
    var validPts = someValidPoint3d(result.points3d);
    if (validPts) {
        instanceGroup.points3d = result.points3d;
        instanceGroup.reprojections = result.reprojections;
        storeReprojectedInstances(instanceGroup, result, cameras);
    } else {
        // Restore old data
        console.warn('[reTriangulate] Failed — keeping old reprojections');
        instanceGroup.points3d = oldPoints3d;
        instanceGroup.reprojections = oldReprojections;
        if (oldReprojInstances) instanceGroup.reprojectedInstances = oldReprojInstances;
    }
    instanceGroup.markClean();

    // Update triangulation results for error display
    var frameIdx = state.currentFrame;
    var frameResults = state.triangulationResults.get(frameIdx) || [];
    var newEntry = { group: instanceGroup, points3d: result.points3d,
        reprojections: result.reprojections, errors: result.errors,
        meanError: result.meanError, method: result.method };
    var replaced = false;
    for (var ri = 0; ri < frameResults.length; ri++) {
        if (frameResults[ri].group === instanceGroup) {
            frameResults[ri] = newEntry;
            replaced = true;
            break;
        }
    }
    if (!replaced) frameResults.push(newEntry);
    state.triangulationResults.set(frameIdx, frameResults);

    // Update 3D viewport
    if (viewport3d) {
        var groups = getInstanceGroupsForFrame(state.currentFrame);
        viewport3d.setFrame(groups);
    }
}

/**
 * Ensure a frame has InstanceGroups, auto-creating them from the per-frame
 * identity assignments when none exist yet. This is the state right after
 * "Track All", which assigns identities per-frame but does NOT group:
 * instances sharing an identity across >=2 cameras form a group; instances
 * explicitly marked "no identity" stay in the unlinked/ungrouped pool. No-op
 * (returns the existing list) when the frame already has groups or the session
 * has no identities. Both triangulateCurrentFrame and triangulateAllFrames use
 * this so each works directly after Track All (without it, Triangulate All
 * found no groups and never populated the 3D viewer).
 * @param {Session} session
 * @param {number} frameIdx
 * @returns {InstanceGroup[]} the frame's group list (possibly empty)
 */
export function ensureGroupsFromIdentities(session, frameIdx) {
    var frameGroupsList = session.instanceGroups.get(frameIdx);
    if (frameGroupsList && frameGroupsList.length > 0) return frameGroupsList;
    if (session.identities.length === 0) return frameGroupsList || [];
    var fg = session.getFrameGroup(frameIdx);
    if (!fg) return frameGroupsList || [];

    var idBuckets = {};
    var allInstancesByCam = {};

    // Collect from grouped instances
    for (var [_cn, _insts] of fg.instances) {
        for (var _i = 0; _i < _insts.length; _i++) {
            var _inst = _insts[_i];
            if (!allInstancesByCam[_cn]) allInstancesByCam[_cn] = [];
            allInstancesByCam[_cn].push(_inst);
            var _idId = session.getIdentityIdForTrack(_cn, _inst.trackIdx, frameIdx);
            if (_idId == null) continue;
            if (!idBuckets[_idId]) idBuckets[_idId] = {};
            if (!idBuckets[_idId][_cn]) idBuckets[_idId][_cn] = _inst;
        }
    }
    // Collect from unlinked instances
    for (var [_cn2, _ulList] of fg.unlinkedInstances) {
        for (var _u = 0; _u < _ulList.length; _u++) {
            var _ulInst = _ulList[_u].instance;
            if (!allInstancesByCam[_cn2]) allInstancesByCam[_cn2] = [];
            allInstancesByCam[_cn2].push(_ulInst);
            var _idId2 = session.getIdentityIdForTrack(_cn2, _ulInst.trackIdx, frameIdx);
            if (_idId2 == null) continue;
            if (!idBuckets[_idId2]) idBuckets[_idId2] = {};
            if (!idBuckets[_idId2][_cn2]) idBuckets[_idId2][_cn2] = _ulInst;
        }
    }

    // Nothing groupable on this frame (no identity shared across >=2 cameras)
    // → leave it untouched. Important when sweeping ALL frames so frames with
    // no cross-view identity aren't needlessly reorganized.
    var hasGroupable = false;
    for (var _bk in idBuckets) {
        if (Object.keys(idBuckets[_bk]).length >= 2) { hasGroupable = true; break; }
    }
    if (!hasGroupable) return frameGroupsList || [];

    // Clear and re-add instances. Grouping is by identity, so an instance the
    // tracker explicitly marked as "no identity" (-1) cannot belong to a group
    // — it stays in the unlinked/ungrouped pool. Everything else is re-added as
    // linked so the identity buckets below can form their groups.
    session.instanceGroups.delete(frameIdx);
    for (var _cn3 in allInstancesByCam) fg.instances.set(_cn3, []);
    for (var _cn4 of fg.unlinkedInstances.keys()) fg.unlinkedInstances.set(_cn4, []);
    for (var _cn5 in allInstancesByCam) {
        for (var _ai = 0; _ai < allInstancesByCam[_cn5].length; _ai++) {
            var _reInst = allInstancesByCam[_cn5][_ai];
            if (session.isExplicitNoIdentity &&
                session.isExplicitNoIdentity(_cn5, _reInst.trackIdx, frameIdx)) {
                fg.addUnlinkedInstance(_cn5, new UnlinkedInstance(_reInst, _cn5));
            } else {
                fg.addInstance(_cn5, _reInst);
            }
        }
    }

    // Create InstanceGroups from identity buckets (>=2 cameras only).
    for (var _idStr in idBuckets) {
        var _identityId = parseInt(_idStr);
        var _bucket = idBuckets[_idStr];
        var _camNames = Object.keys(_bucket);
        if (_camNames.length < 2) continue;
        var _group = new InstanceGroup(Date.now() + _identityId, _identityId);
        for (var _ci = 0; _ci < _camNames.length; _ci++) {
            _group.addInstance(_camNames[_ci], _bucket[_camNames[_ci]]);
        }
        if (!session.instanceGroups.has(frameIdx)) {
            session.instanceGroups.set(frameIdx, []);
        }
        session.instanceGroups.get(frameIdx).push(_group);
    }
    return session.instanceGroups.get(frameIdx) || [];
}

/**
 * On-demand triangulation for the current frame's selected instance group.
 * Re-triangulates from whatever views have labels and updates reprojections.
 */
export function triangulateCurrentFrame(method) {
    if (!state.session) return;

    if (!sessionHasCalibration()) {
        showCalibrationRequiredPopup();
        return;
    }

    method = (method === 'ba') ? 'ba' : 'dlt';
    const frameIdx = state.currentFrame;
    const cameras = state.session.cameras;
    var session = state.session;
    // Auto-create groups from identities when needed (e.g. right after Track All).
    var frameGroupsList = ensureGroupsFromIdentities(session, frameIdx);

    if (!frameGroupsList || frameGroupsList.length === 0) {
        console.warn('[triangulate] No instanceGroups for frame', frameIdx);
        setStatus('No instance groups on frame ' + (frameIdx + 1) + ' - assign instances to groups first (A key)', 'warning');
        updateTriangulationBadge('needs-triangulation', 'No groups');
        return;
    }

    markDirty();
    console.log('[triangulate] Frame', frameIdx, '| cameras:', cameras.map(c => c.name),
        '| views:', state.views.map(v => v.name));

    const frameResults = [];

    for (const group of frameGroupsList) {
            // Resolve any camera name mismatches in this group
            // (e.g., instances keyed by video name "CamA" but camera named "A")
            const groupKeys = group.cameraNames;
            for (const gk of groupKeys) {
                if (!cameras.some(c => c.name === gk)) {
                    // This key doesn't match any camera - try to resolve
                    const gkLower = gk.toLowerCase();
                    for (const cam of cameras) {
                        const camLower = cam.name.toLowerCase();
                        if (gkLower === camLower || gkLower.indexOf(camLower) >= 0 || camLower.indexOf(gkLower) >= 0) {
                            if (!group.getInstance(cam.name)) {
                                const inst = group.getInstance(gk);
                                group.instances.delete(gk);
                                group.instances.set(cam.name, inst);
                                console.log('[triangulate] Resolved instance key "' + gk + '" -> "' + cam.name + '"');
                                break;
                            }
                        }
                    }
                }
            }

            // Count how many views have at least one non-null point
            let viewsWithLabels = 0;
            const camStatus = {};
            for (const cam of cameras) {
                const inst = group.getInstance(cam.name);
                if (inst && inst.numNodes > 0) {
                    const hasAny = inst.hasAnyUsablePoint();
                    if (hasAny) viewsWithLabels++;
                    camStatus[cam.name] = hasAny ? 'labeled' : 'empty';
                } else {
                    camStatus[cam.name] = inst ? 'no-points' : 'missing';
                }
            }
            console.log('[triangulate] Identity', group.identityId, '| views with labels:', viewsWithLabels,
                '| cam status:', camStatus);

            if (viewsWithLabels < 2) {
                // Not enough views for triangulation
                updateTriangulationBadge('needs-triangulation', viewsWithLabels + '/2+ views needed');
                continue;
            }

            // Only use cameras that have instances in this group (assigned views)
            const groupCamNames = group.cameraNames;
            const groupCameras = cameras.filter(c => groupCamNames.indexOf(c.name) >= 0);

            const result = triangulateAndReproject(group, groupCameras, { method: method });
            group.triangulationMethod = result.method;

            // Watch for a NaN-poisoned solve. An all-NaN triple is now just the
            // "missing" sentinel, so it can no longer stand in for corruption —
            // check the actual root cause (a NaN in a projection matrix) plus the
            // one NaN pattern a clean solve can never produce: a PARTIALLY NaN
            // triple, where some but not all coordinates came back NaN.
            const nPts = points3dNodeCount(result.points3d);
            const validPts = countPoints3d(result.points3d);
            let partialNaN = false;
            for (let _k = 0; _k < nPts && !partialNaN; _k++) {
                const _o = _k * 3;
                let _nans = 0;
                for (let _c = 0; _c < 3; _c++) if (isNaN(result.points3d[_o + _c])) _nans++;
                if (_nans > 0 && _nans < 3) partialNaN = true;
            }
            const badCalib = groupCameras.some(c => !c.projectionMatrix ||
                c.projectionMatrix.some(row => row.some(isNaN)));
            let _sample = null;
            for (let _k = 0; _k < nPts && !_sample; _k++) _sample = getPoint3d(result.points3d, _k);
            console.log('[triangulate] points3d:', validPts, 'valid /', nPts,
                '| partialNaN:', partialNaN, '| meanError:', result.meanError,
                '| cameras used:', groupCamNames,
                '| sample:', _sample);
            if (partialNaN || badCalib) {
                console.error('[triangulate] WARNING: NaN in 3D points! Check calibration matrices.');
                for (const cam of groupCameras) {
                    console.log('[triangulate] Camera', cam.name, 'P=', cam.projectionMatrix);
                }
            }

            // Log reprojections per camera
            for (const cam of groupCameras) {
                const reproj = result.reprojections[cam.name];
                const validReproj = reproj ? reproj.filter(p => p != null).length : 0;
                console.log('[triangulate] Reprojection', cam.name, ':', validReproj, 'pts',
                    '| sample:', reproj ? reproj.find(p => p != null) : null);
            }

            group.reprojections = result.reprojections;
            group.points3d = result.points3d;
            storeReprojectedInstances(group, result, cameras);
            group.usedCameras = new Set();
            for (const cam of groupCameras) {
                const inst = group.getInstance(cam.name);
                if (inst) {
                    const hasAny = inst.hasAnyPoint();
                    if (hasAny) group.usedCameras.add(cam.name);
                }
            }

            group.markClean();

            frameResults.push({
                group: group,
                points3d: result.points3d,
                reprojections: result.reprojections,
                errors: result.errors,
                errorsUndistorted: result.errorsUndistorted,
                meanError: result.meanError,
                meanErrorUndistorted: result.meanErrorUndistorted,
                method: result.method,
            });
        }

    state.triangulationResults.set(frameIdx, frameResults);

    console.log('[triangulate] viewport3d exists:', !!viewport3d,
        '| frameResults:', frameResults.length,
        '| views:', state.views.map(v => v.name));

    // Log what each group has after triangulation
    for (const fr of frameResults) {
        console.log('[triangulate] Group result:',
            '| cameras in group:', fr.group.cameraNames,
            '| has reprojections:', Object.keys(fr.group.reprojections || {}),
            '| points3d valid:', countPoints3d(fr.points3d));
    }

    // Show reproj/error UI elements now that triangulation has been run
    setReprojErrorVisible(true);

    // Update displays
    drawAllOverlays(frameIdx);
    update3DViewport(frameIdx);

    // Re-fit the 3D camera so the new skeleton points are visible
    if (viewport3d && frameResults.length > 0) {
        viewport3d.fitToScene();
    }

    var methodLabel = triangulationMethodLabel(method);
    if (frameResults.length > 0 && frameResults[0].meanError != null) {
        updateTriangulationBadge('triangulated',
            methodLabel + ' • Error: ' + frameResults[0].meanError.toFixed(2) + 'px');
        setStatus('Triangulated frame ' + (frameIdx + 1) + ' via ' + methodLabel + ' (' +
            frameResults.length + ' group(s), error: ' +
            frameResults[0].meanError.toFixed(2) + 'px)', 'success');
    } else if (frameResults.length > 0) {
        updateTriangulationBadge('triangulated', 'Triangulated');
        setStatus('Triangulated frame ' + (frameIdx + 1) + ' (' + frameResults.length + ' group(s))', 'success');
    } else {
        updateTriangulationBadge('needs-triangulation', 'No groups triangulated');
        setStatus('No groups could be triangulated on frame ' + (frameIdx + 1) +
            ' - check that instance groups have labels in 2+ camera views', 'warning');
    }

    // Update timeline: mark frame only if it has grouped UserInstances,
    // then re-apply the 30% cap (triangulation can add track rows).
    updateTimelineForFrame(frameIdx);
    if (timeline) timeline.refreshTracks(state.session, { cap: true });
}

/**
 * Triangulate all frames in the session.
 * Uses the same logic as triangulateCurrentFrame but batched across all frames.
 */
/**
 * Mirrors `pose/tracker.js`'s private `frameGroupHasUserInstances` (which itself
 * mirrors `ui/export-modals.js`'s). Kept local because `tracker.js` already
 * imports from this module, and widening that into a two-way import for one
 * predicate is not worth it. **Keep the three in sync.**
 */
function _fgHasUserInstances(fg) {
    if (!fg) return false;
    for (var [, insts] of fg.instances) {
        for (var i = 0; i < insts.length; i++) {
            if (insts[i] && insts[i].type === 'user') return true;
        }
    }
    if (fg.unlinkedInstances) {
        for (var [, ul] of fg.unlinkedInstances) {
            for (var u = 0; u < ul.length; u++) {
                if (ul[u] && ul[u].instance && ul[u].instance.type === 'user') return true;
            }
        }
    }
    return false;
}

/**
 * Mirrors `pose/tracker.js`'s private `encourageGC` — see its comment for why
 * allocating toward the ceiling is what actually forces the mark-compact that
 * reclaims a released window's promoted object graph. **Keep in sync.**
 */
async function _encourageGC(totalMB) {
    var junk = [];
    try {
        var chunkMB = 100;
        var n = Math.ceil((totalMB || 800) / chunkMB);
        for (var i = 0; i < n; i++) {
            var buf = new ArrayBuffer(chunkMB * 1024 * 1024);
            new Uint8Array(buf)[0] = 1;
            junk.push(buf);
        }
    } catch (e) { /* ignore — hitting real pressure is the point */ }
    junk = null;
    await new Promise(function (r) { setTimeout(r, 50); });
}

/**
 * Shared per-group step for both Triangulate All paths: fix up camera-name
 * mismatches, require >=2 views carrying usable 2D, then triangulate.
 *
 * Returns `null` when the group cannot be triangulated (fewer than 2 usable
 * views) — callers must leave such a group's existing `points3d` ALONE rather
 * than clearing it.
 *
 * @returns {{result: Object, groupCameras: Array}|null}
 */
function _triangulateGroupStep(group, cameras, method) {
    // Resolve camera name mismatches
    var groupKeys = group.cameraNames;
    for (var ki = 0; ki < groupKeys.length; ki++) {
        var gk = groupKeys[ki];
        if (!cameras.some(function (c) { return c.name === gk; })) {
            var gkLower = gk.toLowerCase();
            for (var ci = 0; ci < cameras.length; ci++) {
                var camLower = cameras[ci].name.toLowerCase();
                if (gkLower === camLower || gkLower.indexOf(camLower) >= 0 || camLower.indexOf(gkLower) >= 0) {
                    if (!group.getInstance(cameras[ci].name)) {
                        var mvInst = group.getInstance(gk);
                        group.instances.delete(gk);
                        group.instances.set(cameras[ci].name, mvInst);
                        break;
                    }
                }
            }
        }
    }

    var viewsWithLabels = 0;
    for (var cj = 0; cj < cameras.length; cj++) {
        var inst2 = group.getInstance(cameras[cj].name);
        if (inst2 && inst2.hasAnyUsablePoint()) viewsWithLabels++;
    }
    if (viewsWithLabels < 2) return null;

    var groupCamNames = group.cameraNames;
    var groupCameras = cameras.filter(function (c) { return groupCamNames.indexOf(c.name) >= 0; });
    var result = triangulateAndReproject(group, groupCameras, { method: method });
    group.triangulationMethod = result.method;
    group.points3d = result.points3d;
    group.usedCameras = new Set();
    for (var ck = 0; ck < groupCameras.length; ck++) {
        var camInst = group.getInstance(groupCameras[ck].name);
        if (camInst && camInst.hasAnyPoint()) group.usedCameras.add(groupCameras[ck].name);
    }
    return { result: result, groupCameras: groupCameras };
}

/**
 * THE memory-bounded frame sweep. Hydrate a window of lazy frames → run
 * `onFrame` over it → release it → periodically force a real collection.
 *
 * Every bulk operation over "every frame" must go through this. A loop over
 * `session.frameGroups` sees only what is RESIDENT, which on a lazily reopened
 * project is a handful of frames (measured: 31 of 180,210) — so such a loop
 * silently processes ~nothing, returns a plausible count, and its result gets
 * saved. That single mistake has produced every bug in this class so far:
 * `trackAll` (luc3d #185 notes), `triangulateAllFrames` (#194),
 * `exportLabels`/`swapTracks` (#195). Conversely, `loadAllLazyFrames` +
 * iterate-everything is the OTHER failure mode — materializing 2D for 180,210
 * frames × 5 cameras at once is the renderer OOM the memory work exists to
 * prevent. This is the shape that is neither.
 *
 * Consolidated from three previously-independent copies (`sweepTrackAllFrames`
 * in `pose/tracker.js`, the private `sweepTriangulationFrames` in
 * `ui/export-modals.js`, and the windowing formerly inlined in
 * `sweepTriangulateAllFrames` below) — they had identical mechanics, and a
 * fourth was about to be written for the #195 fixes. Lives here because
 * `tracker.js` and `export-modals.js` already import from this module, so no new
 * import cycle is created.
 *
 * `onFrame(frameIdx, frameGroup)` is called once per frame that has data, with
 * that frame's 2D guaranteed hydrated. It may be async.
 *
 * "Has data" means a hydrated `FrameGroup` **or** an `instanceGroups` entry —
 * NOT `FrameGroup` alone. `frameGroup` is therefore `undefined` for a frame that
 * has 3D grouping but no resident 2D, and a callback that dereferences it must
 * guard (`exportLabels` does; the triangulation callbacks read `instanceGroups`
 * and do not care).
 *
 * That distinction is load-bearing, and getting it wrong caused a REGRESSION of
 * luc3d #194 (fixed here). The consolidation that created this function gated on
 * `session.frameGroups.get(fi)` alone, which the three lifted copies never did —
 * `sweepTriangulateAllFrames` had called `ensureGroupsFromIdentities(session, fi)`
 * for every index in the window unconditionally. So every frame whose 2D did not
 * come back on hydration was silently skipped, while Triangulate All had ALREADY
 * wiped `reprojections` project-wide up front: reprojections gone everywhere, 3D
 * refreshed only where the sweep ran. Exactly the #194 symptom, one layer down.
 * The synthetic harness could not see it — its fixture gives every frame 2D in
 * every camera, so the two conditions coincide.
 *
 * IMPORTANT — what does NOT survive: after each window, non-user frames are
 * dropped from `session.frameGroups` and the loader window is released, so any
 * mutation `onFrame` made to a *predicted* instance's fields is LOST (the frame
 * is rebuilt from the columnar store on next hydration). Mutations must either
 * land in a durable structure (the store's own columns, `frameIdentityMap`,
 * `instanceGroups`) or mark the instance user-edited so its frame is pinned.
 *
 * `opts.start`/`opts.end` (inclusive) restrict the sweep to a frame range — used
 * by the range operations (Triangulate Range). Omit both to sweep everything.
 *
 * @param {Object} session                LUCID Session
 * @param {(frameIdx:number, fg:Object)=>void|Promise<void>} onFrame
 * @param {{window?:number, onProgress?:Function, yieldEvery?:number,
 *          gcEveryWindows?:number, gcMB?:number, start?:number, end?:number}} [opts]
 * @returns {Promise<number>} frames processed
 */
function _hasFrameData(session, frameIdx) {
    if (session.frameGroups.has(frameIdx)) return true;
    var ig = session.instanceGroups && session.instanceGroups.get(frameIdx);
    return !!(ig && ig.length > 0);
}

export async function sweepLazyFrameWindows(session, onFrame, opts) {
    opts = opts || {};
    var loader = session.lazyLoader;
    var windowed = loader && loader.isSync && typeof loader.releaseWindow === 'function';
    var YIELD_EVERY = opts.yieldEvery || 100;
    var gcEvery = opts.gcEveryWindows || 5;
    var gcMB = opts.gcMB || 800;
    var processed = 0;

    if (windowed) {
        var W = opts.window || 2000;
        var from = opts.start != null ? Math.max(0, opts.start) : 0;
        var to = opts.end != null ? Math.min(loader.nFrames - 1, opts.end) : loader.nFrames - 1;
        var total = Math.max(0, to - from + 1);
        var windowCount = 0;
        for (var start = from; start <= to; start += W) {
            var end = Math.min(start + W, to + 1);
            await batchLoadLazyFrames(start, end - start);
            for (var fi = start; fi < end; fi++) {
                var fg = session.frameGroups.get(fi);
                // A frame counts as HAVING DATA if it has 2D (a hydrated
                // FrameGroup) *or* an `instanceGroups` entry — see `_hasFrameData`.
                if (!fg && !_hasFrameData(session, fi)) continue;
                await onFrame(fi, fg);
                processed++;
                if (processed % YIELD_EVERY === 0) {
                    // Awaited: Track All's progress callback repaints a live
                    // counter and must be allowed to finish before the next chunk.
                    if (opts.onProgress) await opts.onProgress(processed, total);
                    await new Promise(function (r) { setTimeout(r, 0); });
                }
            }
            // Release the window. Keep the on-screen current frame and any
            // user-edited frame; everything else is predicted-only and rebuildable.
            for (var rf = start; rf < end; rf++) {
                if (rf === state.currentFrame) continue;
                var rfg = session.frameGroups.get(rf);
                if (rfg && !_fgHasUserInstances(rfg)) session.frameGroups.delete(rf);
            }
            loader.releaseWindow(start, end);
            windowCount++;
            // `end` is an absolute frame index; progress is a COUNT within the
            // (possibly offset) range, so subtract the range start.
            if (opts.onProgress) await opts.onProgress(Math.min(end - from, total), total);
            if (windowCount % gcEvery === 0) await _encourageGC(gcMB);
        }
        return processed;
    }

    // Worker-backed lazy sessions (small analysis .h5, no windowing) still
    // materialize up front; non-lazy sessions already hold every frame.
    if (loader) await loadAllLazyFrames(opts.onStatus);
    var lo = opts.start != null ? opts.start : -Infinity;
    var hi = opts.end != null ? opts.end : Infinity;
    // Union of both data maps, for the same reason the windowed branch checks
    // both (see `_hasFrameData`): a 3D-only frame has an `instanceGroups` entry
    // and no `FrameGroup`, and must still be visited.
    var idxSet = new Set(session.frameGroups.keys());
    for (var [igIdx] of session.instanceGroups) idxSet.add(igIdx);
    var idxs = Array.from(idxSet)
        .filter(function (k) { return k >= lo && k <= hi; })
        .sort(function (a, b) { return a - b; });
    for (var j = 0; j < idxs.length; j++) {
        var fg2 = session.frameGroups.get(idxs[j]);
        await onFrame(idxs[j], fg2);
        processed++;
        if (processed % YIELD_EVERY === 0) {
            if (opts.onProgress) opts.onProgress(processed, idxs.length);
            await new Promise(function (r) { setTimeout(r, 0); });
        }
    }
    return processed;
}

/**
 * Memory-bounded Triangulate All for a lazily-reopened project.
 *
 * ## Why this exists
 *
 * `triangulateAllFrames`'s original loop never hydrated lazy 2D. A reopened
 * project's group members are NULL-FILLED PLACEHOLDER `Instance`s (2D
 * materializes on scrub — `reconstructInstanceGroupsFromSessionLazy`), so
 * `hasAnyUsablePoint()` was false, `viewsWithLabels < 2`, and the sweep skipped
 * almost everything. Measured on the real 180,210-frame x 5-camera project:
 * **31 frames / 93 groups triangulated out of 180,210 / 531,799** — 0.02%, in
 * 61 s — because only the frames already scrubbed through were resident. The
 * 3D on disk was never lost, but `setReprojErrorVisible(true)` then switched
 * the reprojection UI on globally, so the other 99.98% rendered blank reproj
 * columns; and where hydration was PARTIAL, the on-demand recompute in
 * `drawAllOverlays` cached a result covering only the hydrated cameras.
 *
 * `trackAll()` had exactly this defect and was fixed with
 * `sweepTrackAllFrames`: hydrate a window, process it, release it. This is the
 * same shape. The old `loadAllLazyFrames()` ("used before bulk operations
 * (triangulate all, etc.)") is deliberately NOT used — materializing 2D for
 * 180,210 frames x 5 cameras at once is the OOM this whole branch exists to
 * avoid.
 *
 * ## What is NOT stored, and why
 *
 * `group.reprojections` is ~5 cameras x 15 nodes of boxed `[x, y]` pairs per
 * group. Retaining it for 531,799 groups is on the order of **1.9 GB** — worse
 * than every allocation #185/#189/#190/#191/#193 removed. Accumulating
 * `state.triangulationResults` across 180,210 frames is the same problem. Both
 * are DERIVED and both are already recomputed on demand for the frame being
 * viewed (`ui/rendering.js` `drawAllOverlays`, which runs after
 * `ensureLazyFrameData` has hydrated that frame's real 2D). So this sweep
 * stores only `points3d` (a flat Float64Array, ~191 MB total, the same
 * representation the file uses) plus `usedCameras`, and keeps scalar error
 * stats for the summary.
 *
 * Stale derived state IS cleared up front — that is the "wipe the previous
 * triangulations first" part, and it is safe precisely because it is derived.
 * `points3d` is deliberately NOT wiped up front: it is replaced per group as
 * the sweep reaches it (the assignment drops the old array immediately, so old
 * and new never coexist), which keeps the peak identical to a global wipe while
 * ensuring an interrupted or partly-untriangulatable sweep never leaves groups
 * with no 3D at all.
 */
async function sweepTriangulateAllFrames(session, cameras, method) {
    // Windowing/hydration/release all live in `sweepLazyFrameWindows`.

    // Clear derived state project-wide before starting (see docstring).
    state.triangulationResults.clear();
    for (var [, clrGroups] of session.instanceGroups) {
        for (var cgi = 0; cgi < clrGroups.length; cgi++) {
            var cg = clrGroups[cgi];
            cg.reprojections = null;
            if (cg.reprojectedInstances && cg.reprojectedInstances.size) cg.reprojectedInstances.clear();
        }
    }

    var stats = { frames: 0, groups: 0, skipped: 0, errSum: 0, errN: 0 };
    await sweepLazyFrameWindows(session, function (fi) {
        var list = ensureGroupsFromIdentities(session, fi);
        if (!list || list.length === 0) return;
        var anyInFrame = false;
        for (var gi = 0; gi < list.length; gi++) {
            var step = _triangulateGroupStep(list[gi], cameras, method);
            if (!step) { stats.skipped++; continue; }
            list[gi].markClean();
            stats.groups++;
            anyInFrame = true;
            if (step.result.meanError != null) {
                stats.errSum += step.result.meanError;
                stats.errN++;
            }
        }
        if (anyInFrame) stats.frames++;
    }, {
        onProgress: function (done, tot) {
            showLoading('Triangulating... ' + done + '/' + tot + ' frames (' +
                stats.groups.toLocaleString() + ' groups)');
        },
    });
    return stats;
}

export async function triangulateAllFrames(method) {
    if (!state.session) {
        setStatus('No session loaded', 'warning');
        return;
    }
    if (!sessionHasCalibration()) {
        showCalibrationRequiredPopup();
        return;
    }

    method = (method === 'ba') ? 'ba' : 'dlt';
    var cameras = state.session.cameras;
    if (cameras.length < 2) {
        setStatus('Need at least 2 cameras for triangulation', 'warning');
        return;
    }

    // A windowing-capable loader (SioLazyLoader) drives `sweepTriangulateAllFrames`
    // instead: hydrate a window / triangulate / release. Without it, a reopened
    // project's 2D is never materialized and ~all frames are silently skipped
    // (measured: 31 of 180,210). Mirrors `trackAll`'s `windowed` check.
    var triLoader = state.session.lazyLoader;
    var triWindowed = triLoader && triLoader.isSync &&
        typeof triLoader.releaseWindow === 'function' && triLoader.nFrames > 0;
    if (triWindowed) {
        markDirty();
        showLoading('Triangulating ' + triLoader.nFrames.toLocaleString() + ' frames (' +
            triangulationMethodLabel(method) + ')...');
        var swept = await sweepTriangulateAllFrames(state.session, cameras, method);
        setReprojErrorVisible(true);
        drawAllOverlays(state.currentFrame);
        update3DViewport(state.currentFrame);
        if (viewport3d) viewport3d.fitToScene();
        hideLoading();
        var sweptAvg = swept.errN > 0 ? (swept.errSum / swept.errN).toFixed(2) : 'N/A';
        setStatus('Triangulated ' + swept.frames.toLocaleString() + ' frames via ' +
            triangulationMethodLabel(method) + ' (' + swept.groups.toLocaleString() +
            ' groups, avg error: ' + sweptAvg + 'px)', 'success');
        console.log('[triangulate-all] windowed sweep done:', swept.frames, 'frames,',
            swept.groups, 'groups,', swept.skipped, 'groups skipped (<2 usable views), avg error:', sweptAvg);
        if (timeline) timeline.refreshTracks(state.session, { cap: true });
        return;
    }

    // Sweep every frame that has data. Groups are auto-created from per-frame
    // identities below (ensureGroupsFromIdentities), so this works directly
    // after Track All — which assigns identities but does not group. (Union of
    // already-grouped frames and frame-group frames; the latter is a superset.)
    var frameIdxSet = {};
    for (var [fIdx] of state.session.instanceGroups) frameIdxSet[fIdx] = true;
    for (var [fIdx2] of state.session.frameGroups) frameIdxSet[fIdx2] = true;
    var frameIndices = Object.keys(frameIdxSet).map(Number).sort(function (a, b) { return a - b; });
    if (frameIndices.length === 0) {
        setStatus('No frames to triangulate', 'warning');
        return;
    }

    markDirty();
    showLoading('Triangulating ' + frameIndices.length + ' frames (' +
        triangulationMethodLabel(method) + ')...');
    var totalTriangulated = 0;
    var totalGroups = 0;
    var totalErrors = [];
    var YIELD_EVERY = 100;

    for (var fi = 0; fi < frameIndices.length; fi++) {
        var frameIdx = frameIndices[fi];
        // Auto-create groups from identities when needed (e.g. after Track All).
        var frameGroupsList = ensureGroupsFromIdentities(state.session, frameIdx);
        if (!frameGroupsList || frameGroupsList.length === 0) continue;

        var frameResults = [];

        for (var gi = 0; gi < frameGroupsList.length; gi++) {
                var group = frameGroupsList[gi];

                // Camera-name fixup, >=2-usable-view gate, triangulate, and the
                // `points3d`/`usedCameras`/`triangulationMethod` stores are shared
                // with the windowed sweep via `_triangulateGroupStep` — keeping one
                // copy of the camera-name matching so the two paths cannot drift.
                var step = _triangulateGroupStep(group, cameras, method);
                if (!step) continue;
                var result = step.result;

                // Eager-path-only: retain the derived reprojections. Safe here
                // because this path handles projects small enough to be fully
                // resident; the windowed sweep deliberately does NOT (~1.9 GB at
                // 531,799 groups) and lets `drawAllOverlays` recompute per frame.
                group.reprojections = result.reprojections;
                // NOT storeReprojectedInstances here — "Triangulate All" sweeps
                // the WHOLE project; eagerly building a full Instance (+ its
                // own `occluded` array) per camera per group here was a major
                // memory cost never needed by SLP save/export (see
                // getOrComputeReprojectedInstance's doc comment). Display and
                // export instead resolve on demand from `.reprojections` above.
                // (`group.usedCameras` is already built by `_triangulateGroupStep`.)

                group.markClean();
                totalGroups++;

                frameResults.push({
                    group: group,
                    points3d: result.points3d,
                    reprojections: result.reprojections,
                    errors: result.errors,
                    errorsUndistorted: result.errorsUndistorted,
                    meanError: result.meanError,
                    meanErrorUndistorted: result.meanErrorUndistorted,
                    method: result.method,
                });

                if (result.meanError != null) {
                    totalErrors.push(result.meanError);
                }
            }

        if (frameResults.length > 0) {
            state.triangulationResults.set(frameIdx, frameResults);
            totalTriangulated++;
        }

        // Yield to UI periodically
        if (fi > 0 && fi % YIELD_EVERY === 0) {
            showLoading('Triangulating... ' + fi + '/' + frameIndices.length + ' frames');
            await new Promise(function (r) { setTimeout(r, 0); });
        }
    }

    // Show reproj/error UI elements
    setReprojErrorVisible(true);

    // Update display for current frame
    drawAllOverlays(state.currentFrame);
    update3DViewport(state.currentFrame);
    if (viewport3d) viewport3d.fitToScene();

    hideLoading();
    var avgError = totalErrors.length > 0
        ? (totalErrors.reduce(function (a, b) { return a + b; }, 0) / totalErrors.length).toFixed(2)
        : 'N/A';
    setStatus('Triangulated ' + totalTriangulated + ' frames via ' + triangulationMethodLabel(method) +
        ' (' + totalGroups + ' groups, avg error: ' + avgError + 'px)', 'success');
    console.log('[triangulate-all] Done:', totalTriangulated, 'frames,', totalGroups, 'groups, avg error:', avgError);

    // Update timeline: mark frames with grouped UserInstances, refresh track bars
    if (timeline) {
        for (var [fIdx] of state.triangulationResults) {
            timeline.setFrameModified(fIdx, frameHasGroupedUserInstances(fIdx));
        }
        timeline.refreshTracks(state.session, { cap: true });
    }
}

export function sessionHasCalibration() {
    if (!state.session || state.session.cameras.length === 0) return false;
    // Check if any camera has non-zero rotation or translation (real calibration)
    for (var ci = 0; ci < state.session.cameras.length; ci++) {
        var cam = state.session.cameras[ci];
        var r = cam.rotation || cam.rvec;
        var t = cam.translation || cam.tvec;
        if (r && (r[0] !== 0 || r[1] !== 0 || r[2] !== 0)) return true;
        if (t && (t[0] !== 0 || t[1] !== 0 || t[2] !== 0)) return true;
    }
    return false;
}

export function showCalibrationRequiredPopup() {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10000;display:flex;align-items:center;justify-content:center;';

    var card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-secondary,#1e1e1e);border-radius:8px;padding:24px;max-width:420px;width:90%;text-align:center;';

    var icon = document.createElement('div');
    icon.style.cssText = 'font-size:36px;margin-bottom:12px;';
    icon.textContent = '\u26A0';
    card.appendChild(icon);

    var title = document.createElement('div');
    title.style.cssText = 'color:#fff;font-size:16px;font-weight:600;margin-bottom:8px;';
    title.textContent = 'Calibration Required';
    card.appendChild(title);

    var msg = document.createElement('div');
    msg.style.cssText = 'color:#aaa;font-size:13px;margin-bottom:16px;line-height:1.5;';
    msg.textContent = 'Triangulation, reprojection, and 3D features require a calibration file. Load a calibration.toml via File \u2192 Load Calibration or by loading a session folder that includes one.';
    card.appendChild(msg);

    var btn = document.createElement('button');
    btn.style.cssText = 'padding:8px 24px;font-size:14px;font-weight:600;cursor:pointer;background:var(--accent,#4a9eff);color:#fff;border:none;border-radius:6px;';
    btn.textContent = 'OK';
    function dismiss() {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
    }
    btn.addEventListener('click', dismiss);
    function onKey(e) {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); dismiss(); }
    }
    document.addEventListener('keydown', onKey);

    card.appendChild(btn);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
}
