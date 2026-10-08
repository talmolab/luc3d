// pose/plane-fit.js — the least-squares plane, and the eigensolver it needs.
//
// Split out of `pose/triangulation.js` for one reason: `pose/plane-data.js` has
// to be able to FIT a plane in order to enforce a `plane-locked` node's
// constraint (`constrainPoint3dForNode`), and it cannot import
// `pose/triangulation.js` to get one. That module reaches into
// `ui/app-state.js`, `ui/rendering.js`, `ui/info-panel.js`, `ui/settings.js`
// and `import-export/save-load.js`, so importing it would drag the whole UI
// into a model module whose own header promises the opposite ("nothing about
// the solve or the UI") and whose Node tests import it with no loader hooks at
// all. `pose/plane-angle.js` is kept off it for the same reason.
//
// Duplicating the maths in the model instead was the other option, and it is
// worse: a derived fit has to agree EXACTLY with the one `Fit` stores, or a
// held corner projected onto the derived plane moves AGAIN the next time the
// user clicks Fit. One definition, two importers.
//
// Nothing here touches the DOM, three.js or app state, and nothing here knows
// what a plane node is — the input is a flat `points3d` and the output is a
// centroid and a normal.

import { points3dNodeCount, readPoint3d } from './pose-data.js?v=0f0efdd2b5e3';

/**
 * Jacobi eigenvalue algorithm for an NxN symmetric matrix.
 *
 * Iteratively applies Givens (Jacobi) rotations to drive off-diagonal elements
 * to zero. Converges for any real symmetric matrix. Particularly efficient and
 * robust for small matrices — 3x3 for the plane fit below, 4x4 for the DLT
 * solver in `pose/triangulation.js`, which imports it from here.
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

// ============================================
// The intersection of several planes
// ============================================
//
// A `plane-locked` node is held by EVERY plane it belongs to, not by one of
// them, so the set it may move in is the intersection of those planes: a plane
// when there is one, the line two share, the single point three meet at. That
// is an affine subspace, and projecting onto it is what the pin does.

/**
 * How independent a normal has to be to count as a new constraint.
 *
 * After orthogonalizing against the constraints already accepted, what is left
 * of a UNIT normal is the sine of its angle to their span — so this is a
 * minimum angle of about 0.06°. Below it the plane is treated as a duplicate
 * of one already in hand and contributes nothing.
 *
 * The threshold matters because two nearly-parallel planes DO intersect, in a
 * line that runs off towards infinity as they line up: fits that sit a
 * millimetre apart and half a degree out would put that line a hundred
 * millimetres away, and snapping a held corner onto it is a worse answer than
 * admitting the second plane says nothing new. Planes meant to constrain a
 * corner in two directions — a floor and a wall — cross at a real angle.
 * @private
 */
const PLANE_INDEPENDENCE_TOL = 1e-3;

/**
 * Reduce several planes to an orthonormal description of their intersection.
 *
 * Each plane is one linear equation `n·x = d`. Gram-Schmidt over the augmented
 * rows `[n | d]` leaves an equivalent system whose directions are orthonormal,
 * which makes the projection below a sum of independent corrections instead of
 * a linear solve — and, more usefully here, makes the RANK fall out: it is how
 * many directions the node is pinned in, so 1 is a plane, 2 a line, 3 a point
 * and 0 unconstrained.
 *
 * A plane whose normal adds no independent direction is DROPPED rather than
 * averaged in. Three walls that meet at a corner already fix the node; a fourth
 * plane parallel to one of them cannot also be satisfied unless it is the same
 * plane, and there is no position that would satisfy both — so the honest
 * reading of a dependent row is "this says nothing new".
 *
 * @param {Array<{centroid:number[], normal:number[]}|null>} fits
 * @returns {{dirs:number[][], offsets:number[], used:number[]}} `dirs[j]·x =
 *   offsets[j]` for every j, `dirs` orthonormal; `used[j]` is the index in
 *   `fits` of the plane that contributed direction j.
 */
export function planeIntersectionBasis(fits) {
    var dirs = [], offsets = [], used = [];
    if (!Array.isArray(fits)) return { dirs: dirs, offsets: offsets, used: used };

    for (var i = 0; i < fits.length && dirs.length < 3; i++) {
        var f = fits[i];
        if (!f || !f.centroid || !f.normal) continue;
        var n = f.normal, c = f.centroid;
        var len = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
        if (!(len > 0)) continue;

        // The plane as `v·x = d`, with `v` a unit normal.
        var vx = n[0] / len, vy = n[1] / len, vz = n[2] / len;
        var d = vx * c[0] + vy * c[1] + vz * c[2];
        if (!isFinite(d)) continue;

        for (var j = 0; j < dirs.length; j++) {
            var u = dirs[j];
            var dot = vx * u[0] + vy * u[1] + vz * u[2];
            vx -= dot * u[0]; vy -= dot * u[1]; vz -= dot * u[2];
            d -= dot * offsets[j];
        }

        var vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (!(vl > PLANE_INDEPENDENCE_TOL)) continue;   // says nothing new
        var off = d / vl;
        if (!isFinite(off)) continue;
        dirs.push([vx / vl, vy / vl, vz / vl]);
        offsets.push(off);
        used.push(i);
    }
    return { dirs: dirs, offsets: offsets, used: used };
}

/**
 * The nearest point to `xyz` that satisfies every constraint in `basis`.
 *
 * Because the directions are orthonormal, each correction is orthogonal to the
 * ones before it and cannot undo them — so applying them in turn gives the
 * exact projection, and re-projecting a point already on the subspace is a
 * no-op. A rank-3 basis ignores `xyz` entirely, which is the point: a node in
 * three planes that meet at a corner has one position available to it.
 *
 * @param {number[]|Float64Array} xyz
 * @param {{dirs:number[][], offsets:number[]}} basis
 * @returns {number[]|null} null if the arithmetic did not stay finite.
 */
export function projectOntoPlaneIntersection(xyz, basis) {
    if (!xyz || !basis) return null;
    var x = [xyz[0], xyz[1], xyz[2]];
    for (var j = 0; j < basis.dirs.length; j++) {
        var u = basis.dirs[j];
        var gap = basis.offsets[j] - (x[0] * u[0] + x[1] * u[1] + x[2] * u[2]);
        if (!isFinite(gap)) return null;
        x[0] += gap * u[0]; x[1] += gap * u[1]; x[2] += gap * u[2];
    }
    return (isFinite(x[0]) && isFinite(x[1]) && isFinite(x[2])) ? x : null;
}
