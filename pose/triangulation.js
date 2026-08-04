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
import { isCameraTracked, getTrackingThreshold } from '../ui/settings.js';
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
// (aniposelib's true joint camera+structure bundle adjustment is
// `bundle_adjust_iter`, which is its *calibration* path — see
// `bundleAdjustCameras` further down for LUCID's opt-in equivalent.)
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
// Joint bundle adjustment (cameras + structure)
// ============================================
//
// THIS is bundle adjustment in the strict sense: camera poses and 3D structure
// are optimized *together*. Everything above holds the cameras fixed and is
// therefore non-linear triangulation, however it is labelled in the UI.
//
// Ported from aniposelib's `CameraGroup.bundle_adjust_iter`, which is what
// `sleap-anipose`'s `slap-calibrate` runs (via `calibrate_videos` →
// `calibrate_rows`) at stock defaults. The paradigm, and the reason it is
// "iterative" in a way the point stage is not:
//
//   * `nIters` rounds. Each round re-triangulates from the *current* cameras,
//     scores every point, hard-trims the outliers, and runs one joint LM on
//     what survives. The camera update changes which points look like outliers,
//     which changes the next camera update — that feedback is the iteration.
//   * The trim threshold `mu` is ANNEALED geometrically from `startMu` (15 px)
//     down to `endMu` (1 px), so early rounds fit loosely on almost all data and
//     later rounds fit tightly on clean data. aniposelib credits Zhou/Park/
//     Koltun's Fast Global Registration for the mu-annealing idea.
//   * `mu` is clamped by the data, not used raw: `mu = max(min(p75max, mus[i]),
//     p15max)` where p75max/p15max are the max over camera PAIRS of the 75th /
//     15th percentile of that pair's mean residual. (Both accumulators are a
//     max in aniposelib — `min_error` being a max of p15s reads like a typo but
//     is the actual behavior, and it is what stops `mu` tightening so far that
//     a round discards nearly all data.)
//   * Early exit when the median residual drops below `errorThreshold` (0.3 px).
//   * A final round deliberately LOOSENS: `mu = max(max(p75max, endMu), p15max)`,
//     so the last joint solve sees nearly everything with only gross outliers
//     removed. This runs even when the loop exited early.
//
// Deliberate deviations from aniposelib, all of them documented choices:
//
//   * EXTRINSICS ONLY (aniposelib's `only_extrinsics=True`). aniposelib's
//     default also fits a single shared focal length and k1 — and its
//     `set_params` *silently zeroes* p1/p2/k3 and ties fx=fy, destroying any
//     anisotropic focal or tangential distortion the calibration had. LUCID's
//     cameras routinely carry all five distortion coefficients, so adopting that
//     default would quietly degrade them. Intrinsics and distortion are held
//     fixed here.
//   * DETERMINISTIC point selection instead of `resample_points`' randomized
//     per-pair draw. A GUI that returns a different calibration each time it is
//     run on the same data is a bug, not a feature. Points are ranked by how
//     many cameras see them (aniposelib's own priority) and the selection
//     window is rotated by round index, which recovers the "don't keep picking
//     the same points" property that aniposelib's `+ U(0,1)` tie-break provides.
//   * NO calibration-board term. aniposelib's `errors_obj` residual pulls
//     reconstructed points onto a rigid board model, which is what supplies
//     metric scale there. LUCID bundle-adjusts on ANIMAL keypoints, where no
//     such model exists — so the 7-DoF similarity gauge must be fixed
//     explicitly instead. See `GAUGE` below.
//   * Residuals use the SOFT-L1 robust loss rather than aniposelib's
//     `loss='linear'`. aniposelib gets its robustness purely from the hard trim;
//     keeping the trim AND adding a robust loss is strictly more stable on
//     animal keypoints, where the outlier rate is far higher than on a
//     checkerboard.
//
// GAUGE: with no board, the cost is invariant under any global similarity
// transform (7 DoF), so the normal equations are rank-deficient by 7 and the
// solution would drift. Camera 0's pose is held FIXED, removing 6. The last DoF
// is global scale, which is removed by renormalizing after every accepted step
// so the camera-0-to-camera-1 baseline keeps its initial length. That
// renormalization is a pure gauge transformation — scaling all world points and
// all camera centres by the same factor leaves every projection unchanged — so
// it cannot alter the cost and cannot break the LM's monotonicity.
//
// CONSEQUENCE THE CALLER MUST KNOW: because a uniform similarity scaling
// reprojects *identically*, scale is not merely hard to estimate — it is
// unobservable from images alone. This function therefore PRESERVES the input
// calibration's scale rather than inventing one, and **it will not fix a scale
// error.** Measured: a rig uniformly 8% too large already sits at the noise
// floor before BA (0.473 px reprojection error) and comes out with its scale
// untouched, so translation errors that are really scale errors persist.
// aniposelib does not have this limitation only because it bundle-adjusts on a
// calibration BOARD and carries an `errors_obj` residual (weighted
// 2/board_square_length) pulling points onto the rigid board model — that term
// is what supplies metric scale there. Bundle-adjusting on animal keypoints has
// no equivalent reference. If metric scale matters, it must come from a board,
// a known object length, or a limb-length prior.
//
// What IS recovered, and recovered well, is relative orientation: with the
// baselines starting correct, rotation error drops to 0.007x-0.034x of the
// initial perturbation while translations stay within ~0.04 world units of
// exact. Pinned by `tests/test-triangulation-ba.js`.

/** Rotation-matrix → Rodrigues vector (matrix logarithm). Inverse of `Camera.rotationMatrix`. */
function rotationMatrixToRvec(R) {
    const trace = R[0][0] + R[1][1] + R[2][2];
    let cosT = (trace - 1) / 2;
    if (cosT > 1) cosT = 1; else if (cosT < -1) cosT = -1;
    const theta = Math.acos(cosT);
    if (theta < 1e-9) return [0, 0, 0];
    const sinT = Math.sin(theta);
    if (Math.abs(sinT) < 1e-9) {
        // theta ~ pi: recover the axis from the symmetric part (R + I)/2 = kk^T.
        const kx = Math.sqrt(Math.max(0, (R[0][0] + 1) / 2));
        const ky = Math.sqrt(Math.max(0, (R[1][1] + 1) / 2));
        const kz = Math.sqrt(Math.max(0, (R[2][2] + 1) / 2));
        // Fix relative signs from the off-diagonals of the largest component.
        let ax = kx, ay = ky, az = kz;
        if (kx >= ky && kx >= kz) {
            if (R[0][1] + R[1][0] < 0) ay = -ay;
            if (R[0][2] + R[2][0] < 0) az = -az;
        } else if (ky >= kz) {
            if (R[0][1] + R[1][0] < 0) ax = -ax;
            if (R[1][2] + R[2][1] < 0) az = -az;
        } else {
            if (R[0][2] + R[2][0] < 0) ax = -ax;
            if (R[1][2] + R[2][1] < 0) ay = -ay;
        }
        const n = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
        return [theta * ax / n, theta * ay / n, theta * az / n];
    }
    const f = theta / (2 * sinT);
    return [
        f * (R[2][1] - R[1][2]),
        f * (R[0][2] - R[2][0]),
        f * (R[1][0] - R[0][1])
    ];
}

/**
 * Camera pose as a plain 6-vector [rx, ry, rz, tx, ty, tz], regardless of
 * whether `camera.rvec` holds a Rodrigues vector or a 3x3 matrix (the anipose
 * TOML form — see `Camera.rotationMatrix`).
 */
function cameraPoseVector(camera) {
    const rvec = (Array.isArray(camera.rvec) && Array.isArray(camera.rvec[0]))
        ? rotationMatrixToRvec(camera.rvec)
        : [camera.rvec[0], camera.rvec[1], camera.rvec[2]];
    return [rvec[0], rvec[1], rvec[2], camera.tvec[0], camera.tvec[1], camera.tvec[2]];
}

/** Rebuild a Camera from a 6-vector pose, keeping intrinsics and distortion. */
function cameraFromPoseVector(template, pose) {
    return new Camera(template.name, template.matrix, template.dist,
        [pose[0], pose[1], pose[2]], [pose[3], pose[4], pose[5]], template.size);
}

/** Camera centre C = -R^T t (world coordinates). */
function cameraCentreOf(camera) {
    const R = camera.rotationMatrix, t = camera.tvec;
    return [
        -(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2]),
        -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2]),
        -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2])
    ];
}

/**
 * Percentile with numpy's default `linear` interpolation, on an
 * already-ascending array. Matching this exactly matters: `mu` is derived from
 * p15/p75 and a different interpolation rule shifts every trim decision.
 */
function percentileSorted(sorted, q) {
    const n = sorted.length;
    if (n === 0) return NaN;
    if (n === 1) return sorted[0];
    const pos = (n - 1) * q / 100;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Dense linear solve A x = b by Gaussian elimination with partial pivoting. */
function solveDense(A, b) {
    const n = b.length;
    const M = new Array(n);
    for (let i = 0; i < n; i++) {
        M[i] = new Float64Array(n + 1);
        for (let j = 0; j < n; j++) M[i][j] = A[i][j];
        M[i][n] = b[i];
    }
    for (let col = 0; col < n; col++) {
        let piv = col, best = Math.abs(M[col][col]);
        for (let r = col + 1; r < n; r++) {
            const v = Math.abs(M[r][col]);
            if (v > best) { best = v; piv = r; }
        }
        if (best < 1e-14) return null;
        if (piv !== col) { const tmp = M[piv]; M[piv] = M[col]; M[col] = tmp; }
        const d = M[col][col];
        for (let r = col + 1; r < n; r++) {
            const f = M[r][col] / d;
            if (f === 0) continue;
            for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
        }
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let s = M[i][n];
        for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
        x[i] = s / M[i][i];
    }
    return x;
}

/**
 * Per-point mean reprojection error across the cameras that see it, measured in
 * native pixel space — aniposelib's `reprojection_error(..., mean=True)`.
 * Returns NaN for a point seen by fewer than two cameras, so it is excluded by
 * every `< mu` comparison automatically.
 */
function _pointErrorNorms(observations, cams, points3d) {
    const n = observations.length;
    const out = new Float64Array(n);
    const buf = [0, 0, 0];
    // perCam[c][p] = residual magnitude, or NaN. Needed for the pairwise stats.
    const perCam = cams.map(function () { return new Float64Array(n); });
    for (let p = 0; p < n; p++) {
        if (!readPoint3d(points3d, p, buf)) {
            out[p] = NaN;
            for (let c = 0; c < cams.length; c++) perCam[c][p] = NaN;
            continue;
        }
        let sum = 0, cnt = 0;
        for (let c = 0; c < cams.length; c++) {
            const o = observations[p][c];
            if (o == null) { perCam[c][p] = NaN; continue; }
            const q = reprojectPointCamera(buf, cams[c]);
            const e = Math.sqrt((o[0] - q[0]) * (o[0] - q[0]) + (o[1] - q[1]) * (o[1] - q[1]));
            perCam[c][p] = e;
            sum += e; cnt++;
        }
        out[p] = cnt >= 2 ? sum / cnt : NaN;
    }
    return { norms: out, perCam: perCam };
}

/**
 * aniposelib's `get_error_dict` reduction: over every camera PAIR with more than
 * `minPoints` co-visible points, take the 15th and 75th percentile of the pair's
 * mean residual, and return the MAX of each across pairs.
 */
function _pairErrorBounds(perCam, minPoints) {
    const nCams = perCam.length;
    const n = nCams ? perCam[0].length : 0;
    let p75max = 0, p15max = 0;
    for (let i = 0; i < nCams; i++) {
        for (let j = i + 1; j < nCams; j++) {
            const vals = [];
            for (let p = 0; p < n; p++) {
                const a = perCam[i][p], b = perCam[j][p];
                if (isNaN(a) || isNaN(b)) continue;
                vals.push((a + b) / 2);
            }
            if (vals.length <= minPoints) continue;
            vals.sort(function (x, y) { return x - y; });
            p75max = Math.max(p75max, percentileSorted(vals, 75));
            p15max = Math.max(p15max, percentileSorted(vals, 15));
        }
    }
    return { p75max: p75max, p15max: p15max };
}

/**
 * Coverage-balanced deterministic point selection: prefer points seen by the
 * most cameras, capped at `maxPoints`, with the window rotated by `round` so
 * successive rounds do not keep re-fitting the identical subset. Replaces
 * aniposelib's randomized `resample_points` (see the header for why).
 */
function _selectPoints(candidateIdx, observations, maxPoints, round) {
    if (candidateIdx.length <= maxPoints) return candidateIdx.slice();
    const scored = candidateIdx.map(function (p) {
        let seen = 0;
        for (let c = 0; c < observations[p].length; c++) if (observations[p][c] != null) seen++;
        return { p: p, seen: seen };
    });
    // Stable: descending visibility, then ascending index.
    scored.sort(function (a, b) { return (b.seen - a.seen) || (a.p - b.p); });
    const offset = (round * maxPoints) % scored.length;
    const out = [];
    for (let i = 0; i < maxPoints; i++) out.push(scored[(offset + i) % scored.length].p);
    out.sort(function (a, b) { return a - b; });
    return out;
}

/**
 * One joint Levenberg–Marquardt solve over camera poses (cameras 1..C-1) and the
 * 3D positions of `pointIdx`, using the Schur complement to eliminate the point
 * blocks. Camera 0 is fixed (gauge); the scale gauge is renormalized after every
 * accepted step.
 *
 * Camera-block Jacobians are finite-differenced, matching aniposelib (which
 * supplies no analytic Jacobian and lets scipy do sparse 2-point differences);
 * point-block Jacobians are analytic via `projectAndJacobianCamera`.
 *
 * @returns {{cams:Camera[], points3d:Float64Array, cost:number, iterations:number}}
 */
function _jointLMStep(observations, cams, points3d, pointIdx, opts) {
    const nCams = cams.length;
    const nFree = nCams - 1;                 // camera 0 is the gauge anchor
    const nCamParams = 6 * nFree;
    const nPts = pointIdx.length;
    if (nFree < 1 || nPts < 1) return { cams: cams, points3d: points3d, cost: Infinity, iterations: 0 };

    const f2 = opts.robustScale * opts.robustScale;
    const rho = function (s) { return isFinite(f2) ? 2 * f2 * (Math.sqrt(1 + s / f2) - 1) : s; };
    const wOf = function (s) { return isFinite(f2) ? 1 / Math.sqrt(1 + s / f2) : 1; };
    const FD = 1e-6;

    // Working state: poses for every camera, and a boxed copy of the 3D points
    // being optimized (boxed here is fine — `pointIdx` is capped at `maxPoints`).
    let poses = cams.map(cameraPoseVector);
    let live = cams.slice();
    let pts = pointIdx.map(function (p) { return getPoint3d(points3d, p); });

    // Scale gauge: the initial camera-0-to-camera-1 baseline length.
    const c0 = cameraCentreOf(cams[0]), c1 = cameraCentreOf(cams[1]);
    const baseline0 = Math.sqrt((c1[0] - c0[0]) * (c1[0] - c0[0]) +
                                (c1[1] - c0[1]) * (c1[1] - c0[1]) +
                                (c1[2] - c0[2]) * (c1[2] - c0[2]));

    /** Rescale points + free camera translations so the baseline is unchanged. */
    function regauge(ps, pp) {
        if (!(baseline0 > 1e-12)) return { poses: ps, pts: pp };
        const cs = ps.map(function (pose, i) { return cameraCentreOf(cameraFromPoseVector(cams[i], pose)); });
        const b = Math.sqrt((cs[1][0] - cs[0][0]) * (cs[1][0] - cs[0][0]) +
                            (cs[1][1] - cs[0][1]) * (cs[1][1] - cs[0][1]) +
                            (cs[1][2] - cs[0][2]) * (cs[1][2] - cs[0][2]));
        if (!(b > 1e-12)) return { poses: ps, pts: pp };
        const s = baseline0 / b;
        if (Math.abs(s - 1) < 1e-15) return { poses: ps, pts: pp };
        // X -> C0 + s(X - C0); t = -R C  =>  t' = -R (C0 + s(C - C0)).
        const origin = cs[0];
        const outPoses = ps.map(function (pose, i) {
            if (i === 0) return pose;
            const C = cs[i];
            const Cn = [origin[0] + s * (C[0] - origin[0]),
                        origin[1] + s * (C[1] - origin[1]),
                        origin[2] + s * (C[2] - origin[2])];
            const R = cameraFromPoseVector(cams[i], pose).rotationMatrix;
            return [pose[0], pose[1], pose[2],
                -(R[0][0] * Cn[0] + R[0][1] * Cn[1] + R[0][2] * Cn[2]),
                -(R[1][0] * Cn[0] + R[1][1] * Cn[1] + R[1][2] * Cn[2]),
                -(R[2][0] * Cn[0] + R[2][1] * Cn[1] + R[2][2] * Cn[2])];
        });
        const outPts = pp.map(function (X) {
            return [origin[0] + s * (X[0] - origin[0]),
                    origin[1] + s * (X[1] - origin[1]),
                    origin[2] + s * (X[2] - origin[2])];
        });
        return { poses: outPoses, pts: outPts };
    }

    function camsFor(ps) { return ps.map(function (pose, i) { return i === 0 ? cams[0] : cameraFromPoseVector(cams[i], pose); }); }

    function totalCost(ls, pp) {
        let sum = 0;
        for (let k = 0; k < nPts; k++) {
            const X = pp[k];
            if (X == null || !isFinite(X[0])) continue;
            const row = observations[pointIdx[k]];
            for (let c = 0; c < nCams; c++) {
                const o = row[c];
                if (o == null) continue;
                const pr = projectAndJacobianCamera(X, ls[c]);
                if (pr == null) return Infinity;
                const du = o[0] - pr.u, dv = o[1] - pr.v;
                sum += rho(du * du + dv * dv);
            }
        }
        return sum;
    }

    let cost = totalCost(live, pts);
    if (!isFinite(cost)) return { cams: cams, points3d: points3d, cost: cost, iterations: 0 };
    let lambda = 1e-4;
    let iterations = 0;

    for (let iter = 0; iter < opts.maxIterations; iter++) {
        // ---- Accumulate the block-sparse normal equations -------------------
        const U = [];
        for (let i = 0; i < nCamParams; i++) U.push(new Float64Array(nCamParams));
        const gCam = new Float64Array(nCamParams);
        const Vs = new Array(nPts), Ws = new Array(nPts), gPts = new Array(nPts);

        // Finite-difference camera Jacobians need perturbed cameras; build the
        // 6 per free camera once per iteration, not once per observation.
        const camPlus = [];
        for (let c = 1; c < nCams; c++) {
            const row = [];
            for (let d = 0; d < 6; d++) {
                const q = poses[c].slice();
                q[d] += FD;
                row.push(cameraFromPoseVector(cams[c], q));
            }
            camPlus.push(row);
        }

        let ok = true;
        for (let k = 0; k < nPts && ok; k++) {
            const X = pts[k];
            const V = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
            const g = [0, 0, 0];
            const W = [];
            for (let i = 0; i < nCamParams; i++) W.push(new Float64Array(3));
            if (X == null || !isFinite(X[0])) { Vs[k] = V; Ws[k] = W; gPts[k] = g; continue; }
            const row = observations[pointIdx[k]];
            for (let c = 0; c < nCams; c++) {
                const o = row[c];
                if (o == null) continue;
                const pr = projectAndJacobianCamera(X, live[c]);
                if (pr == null) { ok = false; break; }
                const ru = o[0] - pr.u, rv = o[1] - pr.v;
                const w = wOf(ru * ru + rv * rv);

                // Point block (analytic).
                for (let a = 0; a < 3; a++) {
                    g[a] += w * (pr.Ju[a] * ru + pr.Jv[a] * rv);
                    for (let b = 0; b < 3; b++) {
                        V[a][b] += w * (pr.Ju[a] * pr.Ju[b] + pr.Jv[a] * pr.Jv[b]);
                    }
                }
                if (c === 0) continue;   // camera 0 contributes no camera block

                // Camera block (finite difference of the projection).
                const base = (c - 1) * 6;
                const Ju = new Float64Array(6), Jv = new Float64Array(6);
                for (let d = 0; d < 6; d++) {
                    const pd = projectAndJacobianCamera(X, camPlus[c - 1][d]);
                    if (pd == null) { ok = false; break; }
                    Ju[d] = (pd.u - pr.u) / FD;
                    Jv[d] = (pd.v - pr.v) / FD;
                }
                if (!ok) break;
                for (let a = 0; a < 6; a++) {
                    gCam[base + a] += w * (Ju[a] * ru + Jv[a] * rv);
                    for (let b = 0; b < 6; b++) {
                        U[base + a][base + b] += w * (Ju[a] * Ju[b] + Jv[a] * Jv[b]);
                    }
                    for (let b = 0; b < 3; b++) {
                        W[base + a][b] += w * (Ju[a] * pr.Ju[b] + Jv[a] * pr.Jv[b]);
                    }
                }
            }
            Vs[k] = V; Ws[k] = W; gPts[k] = g;
        }
        if (!ok) break;

        // ---- Damped Schur complement, retried with growing lambda ----------
        let accepted = false;
        let done = false;
        for (let attempt = 0; attempt < 8; attempt++) {
            const S = [];
            for (let i = 0; i < nCamParams; i++) {
                S.push(new Float64Array(nCamParams));
                for (let j = 0; j < nCamParams; j++) S[i][j] = U[i][j];
                S[i][i] += lambda * (U[i][i] || 1);
            }
            const bCam = new Float64Array(nCamParams);
            for (let i = 0; i < nCamParams; i++) bCam[i] = gCam[i];

            const Vinvs = new Array(nPts);
            for (let k = 0; k < nPts; k++) {
                const V = Vs[k];
                const Vd = [
                    [V[0][0] * (1 + lambda), V[0][1], V[0][2]],
                    [V[1][0], V[1][1] * (1 + lambda), V[1][2]],
                    [V[2][0], V[2][1], V[2][2] * (1 + lambda)]
                ];
                const Vi = invert3x3(Vd);
                Vinvs[k] = Vi;
                if (Vi == null) continue;   // point contributes nothing this step
                const W = Ws[k], g = gPts[k];
                // S -= W Vi W^T ; bCam -= W Vi g   (only rows touched by this point)
                const WVi = [];
                for (let i = 0; i < nCamParams; i++) {
                    const r = W[i];
                    if (r[0] === 0 && r[1] === 0 && r[2] === 0) { WVi.push(null); continue; }
                    WVi.push([
                        r[0] * Vi[0][0] + r[1] * Vi[1][0] + r[2] * Vi[2][0],
                        r[0] * Vi[0][1] + r[1] * Vi[1][1] + r[2] * Vi[2][1],
                        r[0] * Vi[0][2] + r[1] * Vi[1][2] + r[2] * Vi[2][2]
                    ]);
                }
                for (let i = 0; i < nCamParams; i++) {
                    const a = WVi[i];
                    if (a == null) continue;
                    bCam[i] -= a[0] * g[0] + a[1] * g[1] + a[2] * g[2];
                    for (let j = 0; j < nCamParams; j++) {
                        const b = W[j];
                        if (b[0] === 0 && b[1] === 0 && b[2] === 0) continue;
                        S[i][j] -= a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
                    }
                }
            }
            const dCam = solveDense(S, bCam);
            if (dCam == null) { lambda *= 10; if (lambda > 1e12) break; continue; }

            // Back-substitute the point updates.
            const newPts = new Array(nPts);
            for (let k = 0; k < nPts; k++) {
                const X = pts[k];
                const Vi = Vinvs[k];
                if (X == null || Vi == null) { newPts[k] = X; continue; }
                const W = Ws[k], g = gPts[k];
                const rhs = [g[0], g[1], g[2]];
                for (let i = 0; i < nCamParams; i++) {
                    const r = W[i];
                    if (r[0] === 0 && r[1] === 0 && r[2] === 0) continue;
                    const d = dCam[i];
                    rhs[0] -= r[0] * d; rhs[1] -= r[1] * d; rhs[2] -= r[2] * d;
                }
                newPts[k] = [
                    X[0] + Vi[0][0] * rhs[0] + Vi[0][1] * rhs[1] + Vi[0][2] * rhs[2],
                    X[1] + Vi[1][0] * rhs[0] + Vi[1][1] * rhs[1] + Vi[1][2] * rhs[2],
                    X[2] + Vi[2][0] * rhs[0] + Vi[2][1] * rhs[1] + Vi[2][2] * rhs[2]
                ];
            }
            const newPoses = poses.map(function (pose, c) {
                if (c === 0) return pose;
                const base = (c - 1) * 6;
                return [pose[0] + dCam[base], pose[1] + dCam[base + 1], pose[2] + dCam[base + 2],
                        pose[3] + dCam[base + 3], pose[4] + dCam[base + 4], pose[5] + dCam[base + 5]];
            });

            // Gauge-fix, then test. regauge is cost-invariant, so testing after
            // it is equivalent to testing before and keeps the state canonical.
            const rg = regauge(newPoses, newPts);
            const newLive = camsFor(rg.poses);
            const newCost = totalCost(newLive, rg.pts);
            if (newCost < cost) {
                const rel = (cost - newCost) / (cost + 1e-12);
                poses = rg.poses; pts = rg.pts; live = newLive; cost = newCost;
                lambda = Math.max(lambda * 0.3, 1e-12);
                accepted = true; iterations++;
                if (rel < opts.tol) done = true;
                break;
            }
            lambda *= 10;
            if (lambda > 1e12) break;
        }
        if (!accepted || done) break;
    }

    // Write the refined points back into a copy of the full array.
    const outPts = points3d.slice();
    for (let k = 0; k < nPts; k++) {
        const X = pts[k];
        setPoint3d(outPts, pointIdx[k], (X && isFinite(X[0])) ? X : null);
    }
    return { cams: live, points3d: outPts, cost: cost, iterations: iterations };
}

/**
 * Iterative joint bundle adjustment of camera poses and 3D structure — the
 * aniposelib `bundle_adjust_iter` paradigm. See the section header above for the
 * algorithm, and for the four deliberate deviations from aniposelib.
 *
 * Pure function: the input cameras are never mutated. Nothing in the app calls
 * this yet; it is opt-in module surface for a calibration-refinement action,
 * because rewriting a project's calibration invalidates every 3D point already
 * computed from it and that is a decision for the caller, not a side effect of
 * triangulating.
 *
 * @param {(number[]|null)[][]} observations - `observations[p][c]` = the RAW
 *   (native, still-distorted) 2D detection of point `p` in camera `c`, or null.
 *   `p` is a flat index over every (frame, node) pair the caller wants to use.
 * @param {Camera[]} cameras - initial calibration; camera 0 anchors the gauge.
 * @param {{nIters?:number, startMu?:number, endMu?:number, errorThreshold?:number,
 *          maxPoints?:number, minPairPoints?:number, robustScale?:number,
 *          maxIterations?:number, tol?:number}} [options]
 *   Defaults mirror aniposelib: `nIters` 6, `startMu` 15, `endMu` 1,
 *   `errorThreshold` 0.3, `minPairPoints` 10. `maxPoints` (default 1000) caps
 *   the joint solve, standing in for `n_samp_full`/`n_samp_iter`.
 * @returns {{cameras:Camera[], points3d:Float64Array, errorBefore:number,
 *            errorAfter:number, rounds:object[], converged:boolean}|null}
 *   null when there are fewer than 2 cameras or no triangulable point.
 */
export function bundleAdjustCameras(observations, cameras, options) {
    options = options || {};
    const nIters = options.nIters != null ? options.nIters : 6;
    const startMu = options.startMu != null ? options.startMu : 15;
    const endMu = options.endMu != null ? options.endMu : 1;
    const errorThreshold = options.errorThreshold != null ? options.errorThreshold : 0.3;
    const maxPoints = options.maxPoints != null ? options.maxPoints : 1000;
    const minPairPoints = options.minPairPoints != null ? options.minPairPoints : 10;
    const lmOpts = {
        robustScale: options.robustScale != null ? options.robustScale : BA_ROBUST_SCALE_PX,
        maxIterations: options.maxIterations != null ? options.maxIterations : 30,
        tol: options.tol != null ? options.tol : 1e-8
    };
    if (!cameras || cameras.length < 2 || !observations || observations.length === 0) return null;

    let live = cameras.slice();

    /** DLT over the current cameras: undistort, then linear triangulation. */
    function triangulateAll(cams) {
        const mats = cams.map(function (c) { return c.projectionMatrix; });
        const und = observations.map(function (row) {
            return row.map(function (o, c) {
                if (o == null) return null;
                return cams[c] && cams[c].undistortPoint ? cams[c].undistortPoint(o) : o;
            });
        });
        return triangulatePoints(und, mats);
    }

    function medianFinite(arr) {
        const v = [];
        for (let i = 0; i < arr.length; i++) if (!isNaN(arr[i])) v.push(arr[i]);
        if (!v.length) return NaN;
        v.sort(function (a, b) { return a - b; });
        return percentileSorted(v, 50);
    }

    const before = _pointErrorNorms(observations, live, triangulateAll(live));
    const errorBefore = medianFinite(before.norms);
    if (isNaN(errorBefore)) return null;

    // Geometric (log-linear) mu schedule, exactly aniposelib's
    // np.exp(np.linspace(log(startMu), log(endMu), nIters)).
    const mus = [];
    for (let i = 0; i < nIters; i++) {
        mus.push(nIters === 1 ? endMu
            : Math.exp(Math.log(startMu) + i * (Math.log(endMu) - Math.log(startMu)) / (nIters - 1)));
    }

    const rounds = [];
    let converged = false;
    let points3d = null;

    // Best-so-far tracking. The per-round objective is the robust loss on a
    // TRIMMED subset, and the trim changes every round, so the sequence of
    // rounds is NOT monotone in the reported median error — starting from an
    // already-optimal calibration, the raw schedule was measured to drift it
    // from 0.4794 px to 0.4836 px. aniposelib returns whatever its last solve
    // produced; that is precisely the "error went up" failure this issue is
    // about, so we keep the best-scoring calibration instead and never return
    // one worse than the input.
    let bestCams = cameras.slice();
    let bestError = errorBefore;
    function considerBest(cams) {
        const med = medianFinite(_pointErrorNorms(observations, cams, triangulateAll(cams)).norms);
        if (!isNaN(med) && med < bestError - 1e-12) { bestError = med; bestCams = cams.slice(); return med; }
        return med;
    }

    function roundOnce(round, muFor) {
        points3d = triangulateAll(live);
        const st = _pointErrorNorms(observations, live, points3d);
        const bounds = _pairErrorBounds(st.perCam, minPairPoints);
        const median = medianFinite(st.norms);
        const mu = muFor(bounds, round);

        const good = [];
        for (let p = 0; p < st.norms.length; p++) {
            if (!isNaN(st.norms[p]) && st.norms[p] < mu && hasPoint3d(points3d, p)) good.push(p);
        }
        return { st: st, bounds: bounds, median: median, mu: mu, good: good };
    }

    for (let i = 0; i < nIters; i++) {
        const r = roundOnce(i, function (b, round) {
            return Math.max(Math.min(b.p75max, mus[round]), b.p15max);
        });
        rounds.push({ round: i, mu: r.mu, median: r.median, kept: r.good.length,
                      total: observations.length, final: false });
        // Early exit: aniposelib breaks BEFORE that round's solve, but still
        // runs the final loose round below.
        if (r.median < errorThreshold) { converged = true; break; }
        if (r.good.length < 4) break;
        const sel = _selectPoints(r.good, observations, maxPoints, i);
        const step = _jointLMStep(observations, live, points3d, sel, lmOpts);
        live = step.cams;
        const med = considerBest(live);
        rounds[rounds.length - 1].lmIterations = step.iterations;
        rounds[rounds.length - 1].medianAfter = med;
        // Stagnation exit: the mu schedule keeps running rounds long after the
        // solve has stopped moving (measured: rounds 2-6 improved the median by
        // 0.003 px total). Deviation from aniposelib, which always runs all
        // nIters; purely a cost saving, and the final loose round still runs.
        if (!isNaN(med) && med > bestError - 1e-4 && i > 0) break;
    }

    // Final round deliberately LOOSENS the trim (max, not min) so the last joint
    // solve sees nearly all the data with only gross outliers removed.
    const fr = roundOnce(0, function (b) {
        return Math.max(Math.max(b.p75max, endMu), b.p15max);
    });
    rounds.push({ round: rounds.length, mu: fr.mu, median: fr.median, kept: fr.good.length,
                  total: observations.length, final: true });
    if (fr.good.length >= 4) {
        const sel = _selectPoints(fr.good, observations, maxPoints, nIters);
        const step = _jointLMStep(observations, live, points3d, sel, lmOpts);
        live = step.cams;
        rounds[rounds.length - 1].lmIterations = step.iterations;
        rounds[rounds.length - 1].medianAfter = considerBest(live);
    }

    // Return the best calibration seen, which is the input when nothing beat it.
    const improved = bestError < errorBefore - 1e-12;
    points3d = triangulateAll(bestCams);
    return {
        cameras: bestCams,
        points3d: points3d,
        errorBefore: errorBefore,
        errorAfter: bestError,
        rounds: rounds,
        converged: converged,
        improved: improved
    };
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
    // move re-refines consistently (e.g. a BA group stays BA).
    var method = (instanceGroup.triangulationMethod === 'ba') ? 'ba' : 'dlt';
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
