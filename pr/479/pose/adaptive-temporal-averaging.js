/**
 * adaptive-temporal-averaging.js — 3D adaptive temporal averaging (ATA) of one
 * node's trajectory, and the per-point covariance it weighs samples by.
 *
 * Temporal Smoothing's second method (Settings ▸ Temporal Smoothing ▸ Method:
 * Adaptive), beside the median + Gaussian windows. `pose/temporal-smoothing.js`
 * gathers each identity's trajectory and calls in here once per node; this file
 * holds only the math, so Node tests import it directly. DOM-free.
 *
 * ## The method
 *
 * A 3D, covariance-aware version of Bartovčak & Vrankić's pixel-wise adaptive
 * temporal averaging for video denoising (Engineering Review 32(2), 64-69,
 * 2012; Prasath, Engineering Review 39(3), 243-247, 2019). Port of `ata3d`
 * (`smooth`, olinesn/ata3d), itself `ata_3d` of the volfuse study. For frame t:
 *
 *   1. The window grows backward and forward one frame at a time while the
 *      added sample u stays within k standard deviations of frame t's sample:
 *        (x_u - x_t)^T (S_t + S_u)^-1 (x_u - x_t) < k^2
 *      Each side stops at its first failure, at a missing sample (an absent
 *      frame is one), or after `hmax` frames.
 *   2. Both sides are cut to the shorter one, so the window [t-h, t+h] is
 *      symmetric: over steady motion a lopsided window would shift the point
 *      toward its longer side.
 *   3. The output is the precision-weighted mean over the window:
 *        x_hat_t = (sum_u S_u^-1)^-1 sum_u S_u^-1 x_u
 *
 * No motion model, so it does not lag in fast motion: a fast-moving point fails
 * the gate after a frame or two and keeps its window short. A sample far from
 * its neighbours keeps its error (its own window stays short) but does not
 * spread to them. On DoublePoke's 60 fps mice (volfuse, 2026-11-21) it never
 * made a held-out or hand-label score worse and halved frame-to-frame jitter.
 *
 * The result at t depends only on samples in [t - hmax, t + hmax] (the gate
 * compares every sample with x_t, never with each other), which is what lets
 * Temporal Smoothing's This frame read a slice and give the All frames value.
 *
 * ## The covariance
 *
 * LUCID stores no covariance with a 3D point, so `dltPointCovarianceInto`
 * derives one from the point's views, as volfuse's `dlt_cov` does
 * (Gauss-Newton): S = s^2 (sum_v J_v^T J_v)^-1, with J_v the native-pixel
 * projection Jacobian of view v at the point (distortion included) and
 * s^2 = (k0 sigma0^2 + RSS) / (k0 + 2n - 3) the residuals' estimate of the 2D
 * noise, shrunk toward sigma0 = 2 px with k0 = 4 pseudo-degrees of freedom
 * (two or three views leave few). So a node seen by 2 cameras, or whose views
 * disagree, gets a wider covariance than one seen by 6 that agree, and the
 * depth direction of a narrow baseline is the long axis.
 *
 * A sample with no such covariance (fewer than 2 views with 2D, no calibration)
 * falls back to an isotropic per-node sigma estimated from the node's own 3D
 * (`secondDifferenceSigma`).
 *
 * Depends on: pose/triangulation-core.js
 */

import { projectAndJacobianCameraInto } from './triangulation-core.js?v=e0c5253a4e00';

/** Gate in standard deviations of the difference (ata3d's default). */
export const ATA_DEFAULT_K = 3;
/** Longest half-window: windows span at most 2 * hmax + 1 frames. */
export const ATA_DEFAULT_HMAX = 15;
/** `dltPointCovarianceInto`: prior 2D noise (px) the residuals are shrunk toward. */
export const DLT_COV_SIGMA0_PX = 2;
/** `dltPointCovarianceInto`: weight of that prior, in pseudo-degrees of freedom. */
export const DLT_COV_PSEUDO_DOF = 4;
/** Packed symmetric 3x3 covariance: [xx, xy, xz, yy, yz, zz]. */
export const COV_STRIDE = 6;

// Ridges relative to each matrix's mean variance (trace / 3), so the result
// does not depend on the units: added to every covariance before it is inverted
// into a precision weight, and to the summed precision before the final solve
// (ata3d's `_PRECISION_RIDGE` / `_SOLVE_RIDGE`).
const PRECISION_RIDGE = 1e-6;
const SOLVE_RIDGE = 1e-9;
// Ridge on the information matrix sum J^T J before inversion (dlt_cov's).
const INFO_RIDGE = 1e-9;
// 1.4826 * MAD = sigma for a Gaussian.
const MAD_TO_SIGMA = 1.4826;
// Fewest second differences `secondDifferenceSigma` estimates from.
const MIN_SECOND_DIFFERENCES = 5;

/**
 * Invert the packed symmetric 3x3 `c[o..o+5]` into `out[oo..oo+5]`.
 * @returns {boolean} false (out untouched) when it is not positive definite
 *   enough to invert (determinant not > 0, or not finite)
 */
export function invertSym3Into(c, o, out, oo) {
    var a = c[o], b = c[o + 1], d = c[o + 2], e = c[o + 3], f = c[o + 4], g = c[o + 5];
    // Cofactors of [[a b d] [b e f] [d f g]].
    var A = e * g - f * f;
    var B = d * f - b * g;
    var C = b * f - d * e;
    var det = a * A + b * B + d * C;
    if (!(det > 0) || !isFinite(det)) return false;
    var inv = 1 / det;
    out[oo] = A * inv;
    out[oo + 1] = B * inv;
    out[oo + 2] = C * inv;
    out[oo + 3] = (a * g - d * d) * inv;
    out[oo + 4] = (b * d - a * f) * inv;
    out[oo + 5] = (a * e - b * b) * inv;
    return true;
}

/**
 * Squared Mahalanobis distance between samples t and u of a series, under
 * S_t + S_u — the gate. NaN when the sum is not invertible (the gate fails).
 */
function gateDistanceSq(x, cov, t, u) {
    var ct = t * COV_STRIDE, cu = u * COV_STRIDE;
    var a = cov[ct] + cov[cu], b = cov[ct + 1] + cov[cu + 1], d = cov[ct + 2] + cov[cu + 2];
    var e = cov[ct + 3] + cov[cu + 3], f = cov[ct + 4] + cov[cu + 4], g = cov[ct + 5] + cov[cu + 5];
    var A = e * g - f * f, B = d * f - b * g, C = b * f - d * e;
    var det = a * A + b * B + d * C;
    if (!(det > 0)) return NaN;
    var dx = x[u * 3] - x[t * 3], dy = x[u * 3 + 1] - x[t * 3 + 1], dz = x[u * 3 + 2] - x[t * 3 + 2];
    // d^T adj(S) d / det(S)
    var q = dx * (A * dx + B * dy + C * dz) +
        dy * (B * dx + (a * g - d * d) * dy + (b * d - a * f) * dz) +
        dz * (C * dx + (b * d - a * f) * dy + (a * e - b * b) * dz);
    return q / det;
}

/**
 * Smooth one node's trajectory by 3D adaptive temporal averaging (see the
 * header).
 *
 * `x` holds T samples [x, y, z] (NaN = missing), `cov` their packed covariances
 * (NaN = missing too). A missing sample is never written and ends every window
 * that reaches it. Only samples in [from, to) are computed; each reads
 * [t - hmax, t + hmax], so a slice that holds that much around them gives the
 * same values as the whole series, bit for bit (the sums run in the same order:
 * the centre, then t-1 and t+1, then t-2 and t+2, ...).
 *
 * A sample whose window is 1 frame keeps its value exactly.
 *
 * @param {Float64Array} x T*3
 * @param {Float64Array} cov T*COV_STRIDE
 * @param {number} T
 * @param {{k?: number, hmax?: number, from?: number, to?: number}} opts
 * @param {Float64Array} out T*3; samples in [from, to): smoothed, or NaN where missing
 * @param {Int32Array} [half] T; samples in [from, to): half-width h (window
 *   1 + 2h), or -1 where missing
 */
export function ataSmoothSeriesInto(x, cov, T, opts, out, half) {
    opts = opts || {};
    var k = opts.k == null ? ATA_DEFAULT_K : Number(opts.k);
    var k2 = k * k;
    var hmax = opts.hmax == null ? ATA_DEFAULT_HMAX : Math.max(0, Math.floor(opts.hmax));
    var from = Math.max(0, opts.from || 0);
    var to = Math.min(T, opts.to == null ? T : opts.to);
    if (!(to > from)) return;
    var lo = Math.max(0, from - hmax), hi = Math.min(T, to + hmax);
    var n = hi - lo;

    // Presence and precision weights for every sample the computed ones read.
    var ok = new Uint8Array(n);
    var prec = new Float64Array(n * COV_STRIDE);
    var px = new Float64Array(n * 3);
    var reg = new Float64Array(COV_STRIDE);
    for (var i = 0; i < n; i++) {
        var u = lo + i, o = u * COV_STRIDE;
        var x0 = x[u * 3], x1 = x[u * 3 + 1], x2 = x[u * 3 + 2];
        if (!isFinite(x0) || !isFinite(x1) || !isFinite(x2)) continue;
        var r = PRECISION_RIDGE * (cov[o] + cov[o + 3] + cov[o + 5]) / 3;
        reg[0] = cov[o] + r; reg[1] = cov[o + 1]; reg[2] = cov[o + 2];
        reg[3] = cov[o + 3] + r; reg[4] = cov[o + 4]; reg[5] = cov[o + 5] + r;
        // A NaN or non-positive-definite covariance makes the sample missing.
        if (!invertSym3Into(reg, 0, prec, i * COV_STRIDE)) continue;
        var p = i * COV_STRIDE;
        px[i * 3] = prec[p] * x0 + prec[p + 1] * x1 + prec[p + 2] * x2;
        px[i * 3 + 1] = prec[p + 1] * x0 + prec[p + 3] * x1 + prec[p + 4] * x2;
        px[i * 3 + 2] = prec[p + 2] * x0 + prec[p + 4] * x1 + prec[p + 5] * x2;
        ok[i] = 1;
    }

    var den = new Float64Array(COV_STRIDE);
    var inv = new Float64Array(COV_STRIDE);
    for (var t = from; t < to; t++) {
        var it = t - lo;
        if (!ok[it]) {
            out[t * 3] = NaN; out[t * 3 + 1] = NaN; out[t * 3 + 2] = NaN;
            if (half) half[t] = -1;
            continue;
        }
        // Forward first; backward then only needs to reach the forward length.
        var hf = 0;
        while (hf < hmax && t + hf + 1 < hi) {
            var uf = t + hf + 1;
            if (!ok[uf - lo] || !(gateDistanceSq(x, cov, t, uf) < k2)) break;
            hf++;
        }
        var hb = 0;
        while (hb < hf && t - hb - 1 >= lo) {
            var ub = t - hb - 1;
            if (!ok[ub - lo] || !(gateDistanceSq(x, cov, t, ub) < k2)) break;
            hb++;
        }
        var h = hb;   // hb <= hf by construction: min(hf, hb)
        if (half) half[t] = h;
        if (h === 0) {
            out[t * 3] = x[t * 3]; out[t * 3 + 1] = x[t * 3 + 1]; out[t * 3 + 2] = x[t * 3 + 2];
            continue;
        }
        var pc = it * COV_STRIDE;
        for (var j = 0; j < COV_STRIDE; j++) den[j] = prec[pc + j];
        var n0 = px[it * 3], n1 = px[it * 3 + 1], n2 = px[it * 3 + 2];
        for (var dd = 1; dd <= h; dd++) {
            var a = it - dd, b = it + dd;
            var pa = a * COV_STRIDE, pb = b * COV_STRIDE;
            for (var jj = 0; jj < COV_STRIDE; jj++) den[jj] += prec[pa + jj];
            n0 += px[a * 3]; n1 += px[a * 3 + 1]; n2 += px[a * 3 + 2];
            for (var jb = 0; jb < COV_STRIDE; jb++) den[jb] += prec[pb + jb];
            n0 += px[b * 3]; n1 += px[b * 3 + 1]; n2 += px[b * 3 + 2];
        }
        var rs = SOLVE_RIDGE * (den[0] + den[3] + den[5]) / 3;
        den[0] += rs; den[3] += rs; den[5] += rs;
        if (!invertSym3Into(den, 0, inv, 0)) {
            // Cannot happen for positive-definite weights; keep the input.
            out[t * 3] = x[t * 3]; out[t * 3 + 1] = x[t * 3 + 1]; out[t * 3 + 2] = x[t * 3 + 2];
            continue;
        }
        out[t * 3] = inv[0] * n0 + inv[1] * n1 + inv[2] * n2;
        out[t * 3 + 1] = inv[1] * n0 + inv[3] * n1 + inv[4] * n2;
        out[t * 3 + 2] = inv[2] * n0 + inv[4] * n1 + inv[5] * n2;
    }
}

// Scratch for `dltPointCovarianceInto` (grown as views require).
var _jac = { u: 0, v: 0, Ju: new Float64Array(3), Jv: new Float64Array(3) };
var _J = new Float64Array(6 * 16);
var _r2 = new Float64Array(16);
var _keep = new Uint8Array(16);
var _info = new Float64Array(COV_STRIDE);

/**
 * The covariance of a triangulated point from its views' ray geometry and its
 * reprojection residuals (see the header; volfuse's `dlt_cov`), written packed
 * into `out[o..o+5]` (mm^2 for a calibration in mm).
 *
 * The views are those the solve could use: the caller passes each camera with
 * the node's raw (native, still distorted) 2D. With a reprojection-error
 * threshold set (`opts.reprojErrorThreshold` > 0), the view that misses by most
 * is left out while it misses by more than the threshold and more than 2 views
 * are left — as the solve dropped it.
 *
 * @param {ArrayLike<number>} point [X, Y, Z]
 * @param {Array<Camera>} cams the views' cameras (`projectionMatrix`, `dist`, `matrix`)
 * @param {Float64Array} us raw 2D x per view
 * @param {Float64Array} vs raw 2D y per view
 * @param {number} nViews
 * @param {{reprojErrorThreshold?: number, sigma0?: number, k0?: number}} opts
 * @param {Float64Array} out
 * @param {number} o
 * @returns {number} the 2D noise estimate s (px), or NaN when fewer than 2
 *   views remain (out untouched)
 */
export function dltPointCovarianceInto(point, cams, us, vs, nViews, opts, out, o) {
    opts = opts || {};
    var sigma0 = opts.sigma0 == null ? DLT_COV_SIGMA0_PX : opts.sigma0;
    var k0 = opts.k0 == null ? DLT_COV_PSEUDO_DOF : opts.k0;
    var thr = opts.reprojErrorThreshold > 0 ? opts.reprojErrorThreshold : 0;
    if (nViews > _r2.length) {
        _J = new Float64Array(6 * nViews);
        _r2 = new Float64Array(nViews);
        _keep = new Uint8Array(nViews);
    }
    var m = 0;
    for (var i = 0; i < nViews; i++) {
        _keep[i] = 0;
        if (projectAndJacobianCameraInto(point, cams[i], _jac) == null) continue;
        var du = _jac.u - us[i], dv = _jac.v - vs[i];
        var r2 = du * du + dv * dv;
        if (!isFinite(r2)) continue;
        _r2[i] = r2;
        var j = i * 6;
        _J[j] = _jac.Ju[0]; _J[j + 1] = _jac.Ju[1]; _J[j + 2] = _jac.Ju[2];
        _J[j + 3] = _jac.Jv[0]; _J[j + 4] = _jac.Jv[1]; _J[j + 5] = _jac.Jv[2];
        _keep[i] = 1;
        m++;
    }
    if (thr > 0) {
        var thr2 = thr * thr;
        while (m > 2) {
            var worst = -1, worstR2 = thr2;
            for (var w = 0; w < nViews; w++) {
                if (_keep[w] && _r2[w] > worstR2) { worstR2 = _r2[w]; worst = w; }
            }
            if (worst < 0) break;
            _keep[worst] = 0;
            m--;
        }
    }
    if (m < 2) return NaN;
    _info.fill(0);
    var rss = 0;
    for (var v = 0; v < nViews; v++) {
        if (!_keep[v]) continue;
        var q = v * 6;
        var a0 = _J[q], a1 = _J[q + 1], a2 = _J[q + 2];
        var b0 = _J[q + 3], b1 = _J[q + 4], b2 = _J[q + 5];
        _info[0] += a0 * a0 + b0 * b0;
        _info[1] += a0 * a1 + b0 * b1;
        _info[2] += a0 * a2 + b0 * b2;
        _info[3] += a1 * a1 + b1 * b1;
        _info[4] += a1 * a2 + b1 * b2;
        _info[5] += a2 * a2 + b2 * b2;
        rss += _r2[v];
    }
    _info[0] += INFO_RIDGE; _info[3] += INFO_RIDGE; _info[5] += INFO_RIDGE;
    var s2 = (k0 * sigma0 * sigma0 + rss) / (k0 + Math.max(2 * m - 3, 0));
    if (!invertSym3Into(_info, 0, out, o)) return NaN;
    for (var c = 0; c < COV_STRIDE; c++) out[o + c] *= s2;
    return Math.sqrt(s2);
}

/**
 * A robust per-node noise estimate from the node's own 3D: the median absolute
 * second difference x[t+1] - 2 x[t] + x[t-1] over every three consecutive
 * present frames, per axis, as a sigma (white noise of sigma s has second
 * differences of sigma s * sqrt(6)); the root mean square over the axes. Motion
 * with acceleration inflates it, so it is the fallback, not the rule.
 *
 * @param {Float64Array} x T*3, NaN = missing
 * @param {number} T
 * @returns {number} sigma in the units of x, or NaN when fewer than
 *   MIN_SECOND_DIFFERENCES triples exist or every difference is 0
 */
export function secondDifferenceSigma(x, T) {
    var n = 0;
    var d = [new Float64Array(Math.max(0, T - 2)), new Float64Array(Math.max(0, T - 2)), new Float64Array(Math.max(0, T - 2))];
    for (var t = 1; t + 1 < T; t++) {
        var a = (t - 1) * 3, b = t * 3, c = (t + 1) * 3;
        if (!isFinite(x[a]) || !isFinite(x[b]) || !isFinite(x[c]) ||
            !isFinite(x[a + 1]) || !isFinite(x[b + 1]) || !isFinite(x[c + 1]) ||
            !isFinite(x[a + 2]) || !isFinite(x[b + 2]) || !isFinite(x[c + 2])) continue;
        for (var ax = 0; ax < 3; ax++) d[ax][n] = Math.abs(x[c + ax] - 2 * x[b + ax] + x[a + ax]);
        n++;
    }
    if (n < MIN_SECOND_DIFFERENCES) return NaN;
    var sumSq = 0;
    for (var ax2 = 0; ax2 < 3; ax2++) {
        var s = d[ax2].subarray(0, n).sort();
        var med = (n & 1) ? s[n >> 1] : 0.5 * (s[(n >> 1) - 1] + s[n >> 1]);
        var sig = MAD_TO_SIGMA * med / Math.sqrt(6);
        sumSq += sig * sig;
    }
    var sigma = Math.sqrt(sumSq / 3);
    return sigma > 0 && isFinite(sigma) ? sigma : NaN;
}
