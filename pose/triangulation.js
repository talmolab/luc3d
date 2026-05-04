/**
 * triangulation.js - Triangulation and reprojection for multi-view 3D reconstruction
 *
 * Implements DLT (Direct Linear Transform) triangulation in pure JavaScript.
 * Uses the Jacobi eigenvalue algorithm for solving the 4x4 symmetric eigenproblem.
 */

import { mat3x3Multiply, FrameGroup, Instance, UnlinkedInstance } from './pose-data.js';
import { state, timeline } from '../ui/app-state.js';

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
 * @param {(number[]|null)[][]} allObservations - Array of arrays, one per keypoint.
 *   allObservations[k] = [[x1,y1], [x2,y2], ...] or [null, [x2,y2], ...]
 *   (null means the keypoint is not visible in that camera)
 * @param {number[][][]} projectionMatrices - [P1, P2, ...] one per camera
 * @returns {(number[]|null)[]} Array of [X,Y,Z] or null for each keypoint
 */
export function triangulatePoints(allObservations, projectionMatrices) {
    const results = [];
    for (let k = 0; k < allObservations.length; k++) {
        results.push(triangulatePointDLT(allObservations[k], projectionMatrices));
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
 * @param {(number[]|null)[]} points3d - Array of [X,Y,Z] or null
 * @param {number[][]} projectionMatrix - 3x4 projection matrix
 * @returns {(number[]|null)[]} Array of [x,y] or null (if input point is null)
 */
export function reprojectPoints(points3d, projectionMatrix) {
    const results = [];
    for (let i = 0; i < points3d.length; i++) {
        if (points3d[i] == null) {
            results.push(null);
        } else {
            results.push(reprojectPoint(points3d[i], projectionMatrix));
        }
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
 * @returns {number} Mean pixel distance, or Infinity if no valid pairs
 */
export function computeInstanceDistance(pointsA, pointsB) {
    var totalDist = 0, count = 0;
    var len = Math.min(pointsA.length, pointsB.length);
    for (var i = 0; i < len; i++) {
        if (pointsA[i] != null && pointsB[i] != null) {
            var dx = pointsA[i][0] - pointsB[i][0];
            var dy = pointsA[i][1] - pointsB[i][1];
            totalDist += Math.sqrt(dx * dx + dy * dy);
            count++;
        }
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
 *   - each Instance has .points array of [x,y] or null
 * @param {Camera[]} cameras
 *   - each Camera has .name and .projectionMatrix (3x4)
 *
 * @returns {{
 *   points3d: (number[]|null)[],
 *   reprojections: Object.<string, (number[]|null)[]>,
 *   errors: Object.<string, (number|null)[]>,
 *   meanError: number|null
 * }}
 *   points3d: [X,Y,Z] or null for each keypoint
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

    // Determine number of keypoints from the first available instance
    let numKeypoints = 0;
    for (let c = 0; c < cameraNames.length; c++) {
        const inst = instanceGroup.getInstance(cameraNames[c]);
        if (inst && inst.points) {
            numKeypoints = inst.points.length;
            break;
        }
    }

    if (numKeypoints === 0) {
        return {
            points3d: [],
            reprojections: {},
            errors: {},
            meanError: null
        };
    }

    // Step 1: Collect observations per keypoint across cameras
    // Undistort 2D points before triangulation for accuracy
    // Occluded keypoints are excluded (position may be imprecise)
    // allObservations[k][c] = [x,y] (undistorted) or null
    const allObservations = [];
    for (let k = 0; k < numKeypoints; k++) {
        const obsForKeypoint = [];
        for (let c = 0; c < cameraNames.length; c++) {
            const inst = instanceGroup.getInstance(cameraNames[c]);
            // Skip nulled nodes — they are excluded from triangulation
            const isNulled = inst && inst.nulledNodes && inst.nulledNodes.has(k);
            if (inst && inst.points && inst.points[k] != null && !isNulled) {
                const cam = cameraMap[cameraNames[c]];
                if (cam && cam.undistortPoint) {
                    obsForKeypoint.push(cam.undistortPoint(inst.points[k]));
                } else {
                    obsForKeypoint.push(inst.points[k]);
                }
            } else {
                obsForKeypoint.push(null);
            }
        }
        allObservations.push(obsForKeypoint);
    }

    // Step 2: Triangulate
    const points3d = triangulatePoints(allObservations, projMatrices);

    // Fast path: skip reprojections/errors when only 3D points are needed (bulk ops)
    if (options && options.triangulateOnly) {
        return { points3d: points3d, reprojections: {}, errors: {}, meanError: null };
    }

    // Step 3: Reproject to each camera
    const reprojections = {};
    for (let c = 0; c < cameraNames.length; c++) {
        reprojections[cameraNames[c]] = reprojectPoints(points3d, projMatrices[c]);
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
            if (inst && inst.points && inst.points[k] != null && !isNulled) {
                observed.push(inst.points[k]);
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

    return {
        points3d: points3d,
        reprojections: reprojections,
        errors: errorsPerCamera,
        meanError: meanError
    };
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
 * @param {(number[]|null)[]} points - Array of [x,y,z] or null
 * @param {number[]} rayOrigin - [x, y, z]
 * @param {(number[]|null)[]} rayDirs - Array of [dx,dy,dz] or null
 * @returns {(number|null)[]} distances, null where either input is null
 */
export function pointsToRayDistances(points, rayOrigin, rayDirs) {
    var results = [];
    var len = Math.min(points.length, rayDirs.length);
    for (var i = 0; i < len; i++) {
        if (points[i] == null || rayDirs[i] == null) {
            results.push(null);
        } else {
            results.push(pointToRayDistance(points[i], rayOrigin, rayDirs[i]));
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
            reprojPts = reprojectPoints(triangulationResult.points3d, cam.projectionMatrix);
        }
        if (reprojPts) {
            var existing = group.getReprojectedInstance
                ? group.getReprojectedInstance(cam.name) : null;
            if (existing) {
                existing.points = reprojPts;
            } else {
                var reprojInstance = new Instance(reprojPts, group.identityId, 'reprojected', 1.0);
                group.addReprojectedInstance(cam.name, reprojInstance);
            }
        }
    }
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
            // Root-anchored URL (not new URL(..., import.meta.url)) so this module
            // remains loadable inside the node test sandbox (vm.Script). See ISSUES.md I-8.
            var worker = new Worker('/loading/slp-import-worker.js?v=' + Date.now(), { type: 'module' });
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
            fg.addInstance(camName, inst);
        }
    }
    session.addFrameGroup(fg);

    for (var [cn, camInsts] of fg.instances) {
        for (var instItem of camInsts) {
            fg.addUnlinkedInstance(cn, new UnlinkedInstance(instItem, cn));
        }
        fg.instances.set(cn, []);
    }

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
            fg.addInstance(camName, inst);
        }
    }
    session.addFrameGroup(fg);
    for (var [cn, camInsts] of fg.instances) {
        for (var instItem of camInsts) {
            fg.addUnlinkedInstance(cn, new UnlinkedInstance(instItem, cn));
        }
        fg.instances.set(cn, []);
    }
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
    timeline.refreshTracks(state.session);
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
export async function triangulateMultiFrameInstances(startFrame, endFrame, onProgress) {
    var totalFrames = endFrame - startFrame + 1;
    var session = state.session;
    var cameras = session.cameras;
    var completed = 0;
    var triangulated = 0;
    var totalGroups = 0;
    var totalErrors = [];

    for (var f = startFrame; f <= endFrame; f++) {
        var frameGroupsList2 = session.instanceGroups.get(f);
        if (frameGroupsList2) {
            var frameResults = [];

            for (var gi = 0; gi < frameGroupsList2.length; gi++) {
                var group = frameGroupsList2[gi];

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
                                    var inst = group.getInstance(gk);
                                    group.instances.delete(gk);
                                    group.instances.set(cameras[ci].name, inst);
                                    break;
                                }
                            }
                        }
                    }
                }

                // Count views with labels
                var viewsWithLabels = 0;
                for (var cj = 0; cj < cameras.length; cj++) {
                    var inst2 = group.getInstance(cameras[cj].name);
                    if (inst2 && inst2.points && inst2.points.some(function (p, idx) { return p != null && !(inst2.nulledNodes && inst2.nulledNodes.has(idx)); })) {
                        viewsWithLabels++;
                    }
                }
                if (viewsWithLabels < 2) continue;

                var groupCamNames = group.cameraNames;
                var groupCameras = cameras.filter(function (c) { return groupCamNames.indexOf(c.name) >= 0; });
                var result = triangulateAndReproject(group, groupCameras);

                group.reprojections = result.reprojections;
                group.points3d = result.points3d;
                storeReprojectedInstances(group, result, cameras);
                group.observedPoints = {};
                group.usedCameras = new Set();
                for (var ck = 0; ck < groupCameras.length; ck++) {
                    var camInst = group.getInstance(groupCameras[ck].name);
                    if (camInst) {
                        group.observedPoints[groupCameras[ck].name] = camInst.points;
                        if (camInst.points.some(function (p) { return p != null; })) {
                            group.usedCameras.add(groupCameras[ck].name);
                        }
                    }
                }
                group.markClean();
                totalGroups++;

                frameResults.push({
                    group: group,
                    points3d: result.points3d,
                    reprojections: result.reprojections,
                    errors: result.errors,
                    meanError: result.meanError,
                });

                if (result.meanError != null) {
                    totalErrors.push(result.meanError);
                }
            }

            if (frameResults.length > 0) {
                state.triangulationResults.set(f, frameResults);
                triangulated++;
            }
        }

        completed++;
        if (onProgress) onProgress(completed, totalFrames);

        // Yield to UI for progress bar updates every 50 frames
        if (completed % 50 === 0) {
            await new Promise(function (r) { setTimeout(r, 0); });
        }
    }

    return { triangulated: triangulated, totalGroups: totalGroups, totalErrors: totalErrors };
}
