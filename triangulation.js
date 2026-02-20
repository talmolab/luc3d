/**
 * triangulation.js - Triangulation and reprojection for multi-view 3D reconstruction
 *
 * Implements DLT (Direct Linear Transform) triangulation in pure JavaScript.
 * Uses the Jacobi eigenvalue algorithm for solving the 4x4 symmetric eigenproblem.
 *
 * All functions are vanilla JS globals -- no imports/exports.
 */

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
function triangulatePointDLT(observations, projectionMatrices) {
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
function triangulatePoints(allObservations, projectionMatrices) {
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
function reprojectPoint(point3d, projectionMatrix) {
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
function reprojectPoints(points3d, projectionMatrix) {
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
function computeReprojectionError(observed2d, reprojected2d) {
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
function computeReprojectionErrors(observed2d, reprojected2d) {
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
function computeMeanReprojectionError(observed2d, reprojected2d) {
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
function triangulateAndReproject(instanceGroup, cameras) {
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
    // allObservations[k][c] = [x,y] or null
    const allObservations = [];
    for (let k = 0; k < numKeypoints; k++) {
        const obsForKeypoint = [];
        for (let c = 0; c < cameraNames.length; c++) {
            const inst = instanceGroup.getInstance(cameraNames[c]);
            if (inst && inst.points && inst.points[k] != null) {
                obsForKeypoint.push(inst.points[k]);
            } else {
                obsForKeypoint.push(null);
            }
        }
        allObservations.push(obsForKeypoint);
    }

    // Step 2: Triangulate
    const points3d = triangulatePoints(allObservations, projMatrices);

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
            if (inst && inst.points && inst.points[k] != null) {
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
