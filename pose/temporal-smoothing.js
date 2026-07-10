// pose/temporal-smoothing.js — anipose-style temporal smoothing of 3D pose
// trajectories (issue #134). Pure, DOM-free, no project imports so it is
// unit-testable in isolation (bridged into the browser test runner).
//
// WHAT / WHY
// ----------
// Per-frame triangulation solves each frame independently, so small 2D
// detection noise turns into visible 3D jitter frame-to-frame. anipose removes
// this with a spatiotemporal optimization whose temporal term penalizes the
// n-th time-derivative of every 3D coordinate trajectory (config `scale_smooth`
// / `n_deriv_smooth`; aniposelib `CameraGroup.triangulate_optim`). anipose
// keeps that penalty inside a joint reprojection bundle-adjust over all frames
// and all views at once (scipy `least_squares`).
//
// LUCID has no scipy solver and triangulates per frame, so we apply the SAME
// temporal penalty as a post-triangulation smoother: for each trajectory we
// minimise, per node and per world axis independently,
//
//     minimise_p   Σ_t w_t (p_t − y_t)²  +  λ Σ_t (Dⁿ p)_t²
//
// where y_t is the frame-t triangulated coordinate (the per-frame least-squares
// fit to that frame's 2D observations — so anchoring to it is a first-order
// stand-in for anipose's reprojection data term), w_t is a per-frame confidence
// weight (0 on frames with no 3D estimate — those neighbours still couple across
// the gap through the penalty), Dⁿ is the n-th finite-difference operator
// (n = `order`, anipose `n_deriv_smooth`), and λ = the EFFECTIVE smoothing
// weight. The normal equations
//
//     (W + λ DⁿᵀDⁿ) p = W y
//
// are symmetric positive (semi-)definite and solved with conjugate gradient
// (matrix-free — only finite differences), which needs no banded factorisation
// and handles any derivative order. This is exactly a Whittaker–Henderson /
// Tikhonov smoother; larger λ ⇒ smoother (less jitter), λ = 0 ⇒ identity.
//
// FAITHFULNESS TO ANIPOSE
// -----------------------
// - The penalty is anipose's verbatim: `diff(p3ds, n, axis=time) * scale_smooth`
//   (aniposelib `_error_fun_triangulation`), for `n` = `n_deriv_smooth`.
// - `scale_smooth` is auto-normalised exactly as anipose does: the effective
//   weight is `scale_smooth · default_smooth`, `default_smooth =
//   1 / mean(|Δ p̃|)` where `p̃` is the interpolated init passed through a
//   temporal median filter (k = 7) and Δ is the first difference over time
//   (`optim_points`). Without this the raw knob is unit-dependent and useless.
// - anipose defaults: `scale_smooth = 2`, `n_deriv_smooth = 3` (a jerk penalty
//   ⇒ constant-acceleration prior), and the whole optim is OFF unless enabled.
// The ONE deliberate simplification vs anipose: the data term is the per-frame
// triangulated 3D point, not a joint reprojection bundle over all views/frames
// (which would need a sparse non-linear least-squares solver LUCID doesn't
// have). anipose's separate limb-length spatial constraint is not implemented
// here — this addresses temporal jitter (issue #134) only.

/**
 * n-th order forward finite difference. diff¹(x)[i] = x[i+1] − x[i].
 * @param {number[]} x
 * @param {number} order
 * @returns {number[]} length x.length − order (>= 0)
 */
export function nthDiff(x, order) {
    var out = x.slice();
    for (var d = 0; d < order; d++) {
        var next = new Array(Math.max(0, out.length - 1));
        for (var i = 0; i < out.length - 1; i++) next[i] = out[i + 1] - out[i];
        out = next;
    }
    return out;
}

/**
 * Adjoint (transpose) of the n-th forward-difference operator, mapping a vector
 * of length N − order back to length N. The transpose of one forward diff D
 * (length N → N−1) is (Dᵀg)[0] = −g[0]; (Dᵀg)[i] = g[i−1] − g[i]; (Dᵀg)[N−1] =
 * g[N−2]. Applied `order` times.
 * @param {number[]} g   length N − order
 * @param {number} order
 * @param {number} N     target length
 * @returns {number[]} length N
 */
export function nthDiffT(g, order, N) {
    var cur = g.slice();
    var len = N - order; // current logical length climbing back up
    for (var d = 0; d < order; d++) {
        var up = len + 1;
        var out = new Array(up).fill(0);
        for (var i = 0; i < up; i++) {
            var left = (i - 1 >= 0 && i - 1 < cur.length) ? cur[i - 1] : 0;
            var here = (i < cur.length) ? cur[i] : 0;
            out[i] = left - here;
        }
        cur = out;
        len = up;
    }
    return cur;
}

/**
 * Apply A = W + λ·DⁿᵀDⁿ to a vector p. Matrix-free.
 * @param {number[]} p
 * @param {number[]} w    diagonal weights, length p.length
 * @param {number} lambda
 * @param {number} order
 * @returns {number[]}
 */
function applyA(p, w, lambda, order) {
    var n = p.length;
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = w[i] * p[i];
    if (lambda > 0 && order > 0 && n > order) {
        var dtd = nthDiffT(nthDiff(p, order), order, n);
        for (var j = 0; j < n; j++) out[j] += lambda * dtd[j];
    }
    return out;
}

/**
 * Solve the penalised least-squares smoother for one 1-D series via conjugate
 * gradient on (W + λ DⁿᵀDⁿ) p = W y.
 *
 * @param {number[]} y        observations; entries may be null/NaN when missing
 * @param {number[]} [w]      per-sample weights (default 1 where observed, 0 where missing)
 * @param {number} lambda     smoothing strength (anipose scale_smooth); 0 ⇒ passthrough
 * @param {number} order      derivative order to penalise (anipose n_deriv_smooth)
 * @param {number} [iters]    max CG iterations (default min(2N, 500))
 * @param {number} [tol]      relative residual tolerance (default 1e-8)
 * @returns {number[]} smoothed series (length y.length); missing samples are filled
 */
export function smoothSeries(y, w, lambda, order, iters, tol) {
    var n = y.length;
    if (n === 0) return [];
    order = order == null ? 2 : order | 0;
    lambda = lambda || 0;

    // Resolve observations + weights. Missing (null/NaN) ⇒ weight 0.
    var yy = new Array(n);
    var ww = new Array(n);
    var observed = 0;
    for (var i = 0; i < n; i++) {
        var yi = y[i];
        var valid = yi != null && isFinite(yi);
        var wi = w ? (w[i] != null && isFinite(w[i]) ? w[i] : 0) : (valid ? 1 : 0);
        if (!valid) wi = 0;
        yy[i] = valid ? yi : 0;
        ww[i] = wi;
        if (wi > 0) observed++;
    }

    // Nothing to solve, or a passthrough. Need at least (order+1) observed
    // samples for the penalty's null space (polynomials of degree < order) to be
    // pinned down; otherwise the system is singular — return observations as-is.
    if (lambda <= 0 || order <= 0 || observed <= order || n <= order) {
        return yy.slice();
    }

    // CG on A p = b, b = W y, initial guess = observations.
    var b = new Array(n);
    for (var k = 0; k < n; k++) b[k] = ww[k] * yy[k];
    var x = yy.slice();
    var r = new Array(n);
    var Ax = applyA(x, ww, lambda, order);
    var rr = 0;
    for (var a = 0; a < n; a++) { r[a] = b[a] - Ax[a]; rr += r[a] * r[a]; }
    var bnorm = 0; for (var bi = 0; bi < n; bi++) bnorm += b[bi] * b[bi];
    var thresh = (tol == null ? 1e-8 : tol);
    thresh = thresh * thresh * (bnorm > 0 ? bnorm : 1);
    if (rr <= thresh) return x;
    var p = r.slice();
    var maxIters = iters || Math.min(2 * n, 500);
    for (var it = 0; it < maxIters; it++) {
        var Ap = applyA(p, ww, lambda, order);
        var pAp = 0; for (var q = 0; q < n; q++) pAp += p[q] * Ap[q];
        if (pAp <= 0) break; // numerical guard (A is SPD, shouldn't happen)
        var alpha = rr / pAp;
        var rrNew = 0;
        for (var m = 0; m < n; m++) { x[m] += alpha * p[m]; r[m] -= alpha * Ap[m]; rrNew += r[m] * r[m]; }
        if (rrNew <= thresh) break;
        var beta = rrNew / rr;
        for (var s = 0; s < n; s++) p[s] = r[s] + beta * p[s];
        rr = rrNew;
    }
    return x;
}

/**
 * Linear-interpolate null/NaN gaps in a 1-D series over its index (time), and
 * flat-extend the ends. Used only to compute the smoothing auto-normaliser
 * (matches anipose `interpolate_data`); the smoother itself never fabricates
 * values at gaps.
 * @param {(number|null)[]} series
 * @returns {number[]|null} interpolated series, or null if no finite samples
 */
export function interpolateGaps(series) {
    var n = series.length;
    var idx = [];
    for (var i = 0; i < n; i++) if (series[i] != null && isFinite(series[i])) idx.push(i);
    if (idx.length === 0) return null;
    var out = new Array(n);
    for (var k = 0; k < n; k++) {
        if (series[k] != null && isFinite(series[k])) { out[k] = series[k]; continue; }
        // find bracketing observed samples
        var lo = -1, hi = -1;
        for (var a = 0; a < idx.length; a++) { if (idx[a] < k) lo = idx[a]; if (idx[a] > k) { hi = idx[a]; break; } }
        if (lo < 0) out[k] = series[hi];           // before first → flat
        else if (hi < 0) out[k] = series[lo];      // after last → flat
        else {
            var t = (k - lo) / (hi - lo);
            out[k] = series[lo] + t * (series[hi] - series[lo]);
        }
    }
    return out;
}

/**
 * Odd-window temporal median filter (anipose `medfilt_data`, size 7). Edges use
 * the truncated (smaller) window.
 * @param {number[]} series
 * @param {number} [k] odd kernel size (default 7)
 * @returns {number[]}
 */
export function medianFilter1d(series, k) {
    k = k || 7;
    var half = Math.floor(k / 2);
    var n = series.length;
    var out = new Array(n);
    for (var i = 0; i < n; i++) {
        var win = [];
        for (var j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
            if (series[j] != null && isFinite(series[j])) win.push(series[j]);
        }
        if (win.length === 0) { out[i] = series[i]; continue; }
        win.sort(function (a, b) { return a - b; });
        var m = win.length;
        out[i] = (m % 2) ? win[(m - 1) / 2] : 0.5 * (win[m / 2 - 1] + win[m / 2]);
    }
    return out;
}

/**
 * anipose's smoothing auto-normaliser: `default_smooth = 1 / mean(|Δ p̃|)`,
 * where `p̃` is every node×axis series interpolated over gaps then temporal-
 * median-filtered (k=7), Δ the first difference over time, averaged across all
 * series. Returns 0 when the trajectory has no motion (avoids ∞).
 *
 * @param {(number[]|null)[][]} trajectory  [frame][node] -> [x,y,z]|null
 * @param {number} nNodes
 * @returns {number} default_smooth (>= 0)
 */
export function computeSmoothNormalizer(trajectory, nNodes) {
    var nFrames = trajectory.length;
    var totalAbs = 0, count = 0;
    for (var node = 0; node < nNodes; node++) {
        for (var axis = 0; axis < 3; axis++) {
            var series = new Array(nFrames);
            for (var t = 0; t < nFrames; t++) {
                var pt = trajectory[t] ? trajectory[t][node] : null;
                series[t] = (pt != null && isFinite(pt[axis])) ? pt[axis] : null;
            }
            var interp = interpolateGaps(series);
            if (!interp) continue;
            var med = medianFilter1d(interp, 7);
            for (var d = 0; d < med.length - 1; d++) { totalAbs += Math.abs(med[d + 1] - med[d]); count++; }
        }
    }
    if (count === 0) return 0;
    var meanAbs = totalAbs / count;
    return meanAbs > 1e-9 ? (1 / meanAbs) : 0;
}

/**
 * Smooth a set of 3D pose trajectories in place-free fashion (returns new data).
 *
 * Input `trajectory` is a time-ordered array of per-frame poses; each pose is an
 * array over nodes, each node either [x, y, z] or null (missing at that frame).
 * Each node's x/y/z is smoothed independently across time. Frames/nodes that are
 * null stay driven by the smoothness prior (gap-filled) only when the axis has
 * enough observations; otherwise the original value (null) is preserved.
 *
 * @param {(number[]|null)[][]} trajectory   [frame][node] -> [x,y,z] | null
 * @param {Object} opts
 * @param {number} opts.scaleSmooth   anipose scale_smooth (auto-normalised here); 0 ⇒ passthrough
 * @param {number} [opts.order]       anipose n_deriv_smooth (default 3, jerk)
 * @param {number} [opts.normalizer]  precomputed default_smooth (else derived from the data)
 * @param {number[][]} [opts.weights] optional [frame][node] confidence weights
 * @returns {(number[]|null)[][]} smoothed trajectory, same shape
 */
export function smoothTrajectory(trajectory, opts) {
    opts = opts || {};
    var scaleSmooth = opts.scaleSmooth || 0;
    var order = opts.order == null ? 3 : opts.order;
    var nFrames = trajectory.length;
    if (nFrames === 0 || scaleSmooth <= 0) return trajectory.map(function (f) { return f ? f.slice() : f; });

    // Determine node count from the widest frame.
    var nNodes = 0;
    for (var f = 0; f < nFrames; f++) {
        if (trajectory[f]) { nNodes = Math.max(nNodes, trajectory[f].length); }
    }

    // anipose auto-normalisation: effective λ = scale_smooth · default_smooth.
    var normalizer = opts.normalizer != null ? opts.normalizer : computeSmoothNormalizer(trajectory, nNodes);
    var lambda = scaleSmooth * normalizer;
    if (!(lambda > 0)) return trajectory.map(function (fr) { return fr ? fr.slice() : fr; });

    // Output: deep-ish copy preserving nulls.
    var out = new Array(nFrames);
    for (var fo = 0; fo < nFrames; fo++) {
        out[fo] = new Array(nNodes).fill(null);
        var pose = trajectory[fo];
        if (pose) {
            for (var nd = 0; nd < nNodes; nd++) {
                if (pose[nd] != null) out[fo][nd] = pose[nd].slice();
            }
        }
    }

    for (var node = 0; node < nNodes; node++) {
        for (var axis = 0; axis < 3; axis++) {
            var series = new Array(nFrames);
            var weights = opts.weights ? new Array(nFrames) : null;
            var anyObserved = false;
            for (var t = 0; t < nFrames; t++) {
                var pt = trajectory[t] ? trajectory[t][node] : null;
                if (pt != null && isFinite(pt[axis])) { series[t] = pt[axis]; anyObserved = true; }
                else series[t] = null;
                if (weights) weights[t] = opts.weights[t] ? opts.weights[t][node] : 1;
            }
            if (!anyObserved) continue;
            var sm = smoothSeries(series, weights, lambda, order);
            for (var t2 = 0; t2 < nFrames; t2++) {
                // Only write back where we had an observation OR the smoother
                // legitimately produced a finite fill for a previously-observed
                // trajectory; keep original nulls where the node never existed.
                if (out[t2][node] != null) {
                    out[t2][node][axis] = sm[t2];
                }
            }
        }
    }
    return out;
}
