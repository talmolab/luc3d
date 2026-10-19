/**
 * pose/pose-check.js — is this 2D pose common, uncommon, or an outlier?
 *
 * Track All checks every 2D prediction against the poses its own camera
 * usually shows, and sorts it three ways:
 *
 *   common     passes (nearly every prediction)
 *   uncommon   flagged for inspection (Tracking Wizard `poseUncommonZ`)
 *   outlier    flagged (`poseOutlierZ`); left out of tracking only when the
 *              Tracking Wizard says so (`poseExcludeOutliers`, off by default —
 *              see pose/pose-check-session.js)
 *
 * The test is a point-distribution model, the "is this shape plausible" test of
 * Active Shape Models, fitted per camera on the session itself (no labels):
 *
 *  1. Every pose is aligned to the camera's mean shape by the similarity
 *     (translation, rotation, scale) that fits it best — so WHERE the animal is,
 *     which way it faces and how far it is from the camera do not count.
 *  2. What is left is the pose's SHAPE. Its residual from the mean shape is
 *     measured against the covariance of the residuals of the camera's
 *     complete poses (Mahalanobis distance), so correlated motion the animal
 *     makes all the time (a tail swinging, a body curling) costs little and a
 *     configuration it never makes (head on the haunches, nodes stretched over
 *     two animals) costs a lot.
 *  3. The distance is normalized to a z-like number by its degrees of freedom
 *     (Wilson–Hilferty), so a pose with missing nodes reads on the same scale
 *     as a complete one. That number is the POSE SCORE here: about 0 for a
 *     typical pose, higher the rarer the shape.
 *
 * A pose with missing nodes is aligned on its visible nodes only, and its
 * covariance is computed for exactly that set of visible nodes (a "pattern"),
 * from complete poses re-aligned the same way — the sub-block of the full
 * covariance is not the same thing, because re-aligning on fewer nodes absorbs
 * a different part of the residual (measured: it costs a third of the bad poses
 * found at the same false-flag rate). Patterns are built on first use and kept.
 *
 * Measured on the six proofread 3–4-mouse SLAP sessions (2.1M predictions),
 * against each prediction's distance to the reprojection of the proofread 3D:
 * at a score of 10, 1 good pose in 542 is flagged and 65% of the flags are
 * wrong poses; at 15, 1 in 13,312 and 92%; at 20, 1 in 261,254. Above 15 nearly
 * everything flagged is an outlier by eye. The test is blind to a pose that is
 * well-shaped but in the wrong place (a duplicate, a reflection), which the
 * tracker's geometry handles instead.
 *
 * DOM-free and import-free: Node-testable (`tests/test-pose-check.mjs`).
 */

// --- Tunables (measured; see the module comment and MODULES.md) -------------

/** Fewer visible nodes than this cannot be tested: a similarity fit takes 2. */
export const POSE_MIN_NODES = 4;
/** Complete poses a camera's model is fitted on, at most. */
export const POSE_FIT_MAX = 2000;
/** A camera with fewer complete poses than this gets no model (not checked). */
export const POSE_FIT_MIN = 200;
/** Complete poses each visibility pattern's covariance is estimated from. */
export const POSE_PATTERN_SAMPLE = 300;
/** Ridge added to every pattern covariance, as a share of its mean variance. */
export const POSE_RIDGE = 0.01;
/**
 * Every node is modelled while at least this many poses have them all: below
 * it, the least-often-predicted node is dropped (repeatedly), so a skeleton with
 * a node the model rarely finds is still checked on the rest.
 */
export const POSE_FIT_ENOUGH = 1000;
/** Frames sampled (evenly spaced) to fit the models — every frame when fewer. */
export const POSE_SAMPLE_FRAMES = 3000;

/** Default thresholds on the pose score (Tracking Wizard `poseUncommonZ` / `poseOutlierZ`). */
export const POSE_UNCOMMON_DEFAULT = 10;
export const POSE_OUTLIER_DEFAULT = 15;

/** Pose classes. */
export const POSE_UNTESTED = -1;
export const POSE_COMMON = 0;
export const POSE_UNCOMMON = 1;
export const POSE_OUTLIER = 2;

/** Every Nth frame is sampled for the fit (N = 1 for a short session). */
export function poseSampleStride(nFrames) {
    return Math.max(1, Math.floor((nFrames || 0) / POSE_SAMPLE_FRAMES));
}

/**
 * The class of a pose score.
 * @param {number} z  pose score (NaN: untested)
 * @param {number} uncommonAt  score from which a pose is uncommon
 * @param {number} outlierAt   score from which it is an outlier (0 or less: never)
 */
export function poseClassOf(z, uncommonAt, outlierAt) {
    if (!(z === z)) return POSE_UNTESTED;      // NaN
    if (outlierAt > 0 && z >= outlierAt) return POSE_OUTLIER;
    if (z >= uncommonAt) return POSE_UNCOMMON;
    return POSE_COMMON;
}

/** A class as a word: 'common' | 'uncommon' | 'outlier' | '' (untested). */
export function poseClassName(cls) {
    return cls === POSE_COMMON ? 'common' : cls === POSE_UNCOMMON ? 'uncommon' : cls === POSE_OUTLIER ? 'outlier' : '';
}

// --- Order-independent hashing ------------------------------------------------
// The fit set is chosen by a hash of each pose's own coordinates, so the same
// predictions give the same model however they were enumerated (an eager load
// lists a frame's grouped instances before its ungrouped ones; the lazy store
// lists them in file order).

var _f64 = new Float64Array(1);
var _u32 = new Uint32Array(_f64.buffer);

function hashPose(xy) {
    var h = 0x811c9dc5 | 0;
    for (var i = 0; i < xy.length; i++) {
        var v = xy[i];
        if (v !== v) { h = Math.imul(h ^ 0x9e3779b9, 0x01000193); continue; }
        _f64[0] = v;
        h = Math.imul(h ^ _u32[0], 0x01000193);
        h = Math.imul(h ^ _u32[1], 0x01000193);
    }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
}

// --- Fitting -------------------------------------------------------------------

/**
 * Collects a camera's predicted poses for `fitPoseModel`: `offer(xy)` copies a
 * pose with at least POSE_MIN_NODES visible nodes.
 * @param {number} numNodes
 */
export function createPoseSample(numNodes) {
    var poses = [];
    return {
        numNodes: numNodes,
        poses: poses,
        offer: function (xy) {
            if (!xy || xy.length !== 2 * numNodes) return;
            var v = 0;
            for (var k = 0; k < numNodes; k++) if (xy[2 * k] === xy[2 * k]) v++;
            if (v >= POSE_MIN_NODES) poses.push(Float64Array.from(xy));
        },
    };
}

// Centre and scale a shape (re, im over n nodes) to unit norm, in place.
function normalizeShape(re, im, o, n) {
    var mr = 0, mi = 0, k;
    for (k = 0; k < n; k++) { mr += re[o + k]; mi += im[o + k]; }
    mr /= n; mi /= n;
    var ss = 0;
    for (k = 0; k < n; k++) { re[o + k] -= mr; im[o + k] -= mi; ss += re[o + k] * re[o + k] + im[o + k] * im[o + k]; }
    var s = ss > 0 ? 1 / Math.sqrt(ss) : 0;
    for (k = 0; k < n; k++) { re[o + k] *= s; im[o + k] *= s; }
}

// Generalized Procrustes: the mean shape of the first `count` shapes (rows of
// re/im, n nodes each), centred, unit norm. Rotation is anchored to the first.
function procrustesMean(re, im, count, n) {
    var nr = re.slice(0, count * n), ni = im.slice(0, count * n), k;
    for (var r = 0; r < count; r++) normalizeShape(nr, ni, r * n, n);
    var mr = nr.slice(0, n), mi = ni.slice(0, n);
    var ar = new Float64Array(n), ai = new Float64Array(n);
    for (var it = 0; it < 50; it++) {
        ar.fill(0); ai.fill(0);
        for (r = 0; r < count; r++) {
            var o = r * n, pr = 0, pi = 0;
            // a = sum(conj(z) * mu); |z| = 1, so a is the best similarity onto mu
            for (k = 0; k < n; k++) {
                pr += nr[o + k] * mr[k] + ni[o + k] * mi[k];
                pi += nr[o + k] * mi[k] - ni[o + k] * mr[k];
            }
            for (k = 0; k < n; k++) {
                ar[k] += pr * nr[o + k] - pi * ni[o + k];
                ai[k] += pr * ni[o + k] + pi * nr[o + k];
            }
        }
        normalizeShape(ar, ai, 0, n);
        var delta = 0;
        for (k = 0; k < n; k++) delta = Math.max(delta, Math.abs(ar[k] - mr[k]), Math.abs(ai[k] - mi[k]));
        mr.set(ar); mi.set(ai);
        if (delta < 1e-10) break;
    }
    return { re: mr, im: mi };
}

/**
 * Fit one camera's pose model.
 * @param {Float64Array[]} poses  interleaved x,y per node (NaN = missing), e.g. `createPoseSample().poses`
 * @param {number} numNodes
 * @returns {Object|null}  null when the camera has too few complete poses to model
 */
export function fitPoseModel(poses, numNodes) {
    if (!poses || !(numNodes >= POSE_MIN_NODES)) return null;
    // Nodes the model covers: all of them, unless too few poses have them all —
    // then the least-often-predicted ones are dropped until enough do.
    var seen = new Int32Array(numNodes);
    for (var p = 0; p < poses.length; p++) {
        for (var k = 0; k < numNodes; k++) if (poses[p][2 * k] === poses[p][2 * k]) seen[k]++;
    }
    var byVis = [];
    for (k = 0; k < numNodes; k++) if (seen[k] > 0) byVis.push(k);
    byVis.sort(function (a, b) { return seen[b] - seen[a] || a - b; });
    var core = byVis.slice();
    while (core.length > POSE_MIN_NODES && countComplete(poses, core) < POSE_FIT_ENOUGH) core.pop();
    core.sort(function (a, b) { return a - b; });
    var n = core.length;
    if (n < POSE_MIN_NODES) return null;

    // Complete-on-core poses, in hash order (order-independent), at most POSE_FIT_MAX.
    var cand = [];
    for (p = 0; p < poses.length; p++) {
        var ok = true;
        for (var c = 0; c < n && ok; c++) ok = poses[p][2 * core[c]] === poses[p][2 * core[c]];
        if (ok) cand.push({ h: hashPose(poses[p]), xy: poses[p] });
    }
    if (cand.length < POSE_FIT_MIN) return null;
    cand.sort(function (a, b) { return a.h - b.h; });
    if (cand.length > POSE_FIT_MAX) cand.length = POSE_FIT_MAX;
    var m = cand.length;
    var re = new Float64Array(m * n), im = new Float64Array(m * n);
    for (p = 0; p < m; p++) {
        for (c = 0; c < n; c++) { re[p * n + c] = cand[p].xy[2 * core[c]]; im[p * n + c] = cand[p].xy[2 * core[c] + 1]; }
    }

    var mean = procrustesMean(re, im, m, n);
    var model = {
        numNodes: numNodes, core: Int32Array.from(core), nCore: n,
        muRe: mean.re, muIm: mean.im,
        // The fit poses themselves (core nodes, unaligned): each visibility
        // pattern's covariance is estimated from them on first use.
        fitRe: re, fitIm: im, nFit: m,
        patterns: new Map(),
        // scratch for poseScore, so scoring a pose allocates nothing
        _idx: new Int32Array(n), _r: new Float64Array(2 * n), _y: new Float64Array(2 * n),
        _zr: new Float64Array(n), _zi: new Float64Array(n),
        _rowRe: new Float64Array(n), _rowIm: new Float64Array(n),
    };
    return model;
}

function countComplete(poses, nodes) {
    var count = 0;
    for (var p = 0; p < poses.length; p++) {
        var ok = true;
        for (var c = 0; c < nodes.length && ok; c++) ok = poses[p][2 * nodes[c]] === poses[p][2 * nodes[c]];
        if (ok) count++;
    }
    return count;
}

// A visibility pattern's key: a bitmask over core slots (a string past 30 nodes).
function patternKey(model, slots) {
    if (model.nCore <= 30) {
        var b = 0;
        for (var i = 0; i < slots.length; i++) b |= 1 << slots[i];
        return b;
    }
    return Array.prototype.join.call(slots, ',');
}

// The covariance (as its ridge-regularized Cholesky factor) of the residuals of
// complete fit poses re-aligned on exactly these core slots.
function getPattern(model, key, slots) {
    var pat = model.patterns.get(key);
    if (pat) return pat;
    var v = slots.length, d = 2 * v, n = model.nCore;
    var idx = Int32Array.from(slots);
    var mcRe = new Float64Array(v), mcIm = new Float64Array(v), mr = 0, mi = 0, i, j;
    for (i = 0; i < v; i++) { mcRe[i] = model.muRe[idx[i]]; mcIm[i] = model.muIm[idx[i]]; mr += mcRe[i]; mi += mcIm[i]; }
    mr /= v; mi /= v;
    for (i = 0; i < v; i++) { mcRe[i] -= mr; mcIm[i] -= mi; }
    pat = { idx: idx, v: v, mcRe: mcRe, mcIm: mcIm, L: null, df: 2 * v - 4 };
    var C = new Float64Array(d * d), r = new Float64Array(d);
    var count = Math.min(model.nFit, POSE_PATTERN_SAMPLE);
    for (var p = 0; p < count; p++) {
        alignResidual(model, pat, model.fitRe, model.fitIm, p * n, idx, r);
        for (i = 0; i < d; i++) {
            var ri = r[i];
            if (ri === 0) continue;
            var row = i * d;
            for (j = i; j < d; j++) C[row + j] += ri * r[j];
        }
    }
    var tr = 0;
    for (i = 0; i < d; i++) {
        for (j = i; j < d; j++) { C[i * d + j] /= count; C[j * d + i] = C[i * d + j]; }
        tr += C[i * d + i];
    }
    var lam = POSE_RIDGE * tr / Math.max(1, pat.df);
    if (!(lam > 0)) lam = 1e-12;
    for (var attempt = 0; attempt < 6; attempt++) {
        var L = cholesky(C, d, lam);
        if (L) { pat.L = L; break; }
        lam *= 10;
    }
    model.patterns.set(key, pat);
    return pat;
}

// Lower Cholesky factor of (C + lam I), or null when not positive definite.
function cholesky(C, d, lam) {
    var L = new Float64Array(d * d);
    for (var i = 0; i < d; i++) {
        for (var j = 0; j <= i; j++) {
            var s = C[i * d + j] + (i === j ? lam : 0);
            for (var k = 0; k < j; k++) s -= L[i * d + k] * L[j * d + k];
            if (i === j) {
                if (!(s > 0)) return null;
                L[i * d + i] = Math.sqrt(s);
            } else {
                L[i * d + j] = s / L[j * d + j];
            }
        }
    }
    return L;
}

// The pose at row offset `o` of (re, im) — n core nodes — aligned on `idx` to
// the pattern's centred mean shape by the least-squares similarity; its residual,
// realified [re..., im...], into `out` (length 2v).
//
// The residual is NOT projected off the mean shape's direction, although for a
// good pose it has almost nothing there. A pose that does not resemble the mean
// shape at all gets a best-fit scale near 0 — the fit shrinks it to a point — so
// its residual IS minus the mean shape. Projecting that direction out scored the
// most garbled poses as the most typical (a head/tail swap with an ear missing
// came out at -5), and measured on the proofread sessions it cost a third of the
// outliers found at the same false-flag rate.
function alignResidual(model, pat, re, im, o, idx, out) {
    var v = pat.v, i, zr = model._zr, zi = model._zi, cr = 0, ci = 0;
    for (i = 0; i < v; i++) { zr[i] = re[o + idx[i]]; zi[i] = im[o + idx[i]]; cr += zr[i]; ci += zi[i]; }
    cr /= v; ci /= v;
    var den = 0, nr = 0, ni = 0, mcRe = pat.mcRe, mcIm = pat.mcIm;
    for (i = 0; i < v; i++) {
        zr[i] -= cr; zi[i] -= ci;
        den += zr[i] * zr[i] + zi[i] * zi[i];
        nr += zr[i] * mcRe[i] + zi[i] * mcIm[i];      // sum conj(z) * mu
        ni += zr[i] * mcIm[i] - zi[i] * mcRe[i];
    }
    var ar = den > 0 ? nr / den : 0, ai = den > 0 ? ni / den : 0;
    for (i = 0; i < v; i++) {
        out[i] = ar * zr[i] - ai * zi[i] - mcRe[i];
        out[v + i] = ar * zi[i] + ai * zr[i] - mcIm[i];
    }
}

// Squared Mahalanobis distance of the pose at row offset `o` under `pat`.
function residualD2(model, pat, re, im, o) {
    var d = 2 * pat.v, r = model._r, y = model._y, L = pat.L;
    alignResidual(model, pat, re, im, o, pat.idx, r);
    var s = 0;
    for (var i = 0; i < d; i++) {
        var t = r[i];
        for (var k = 0; k < i; k++) t -= L[i * d + k] * y[k];
        y[i] = t / L[i * d + i];
        s += y[i] * y[i];
    }
    return s;
}

/** Wilson–Hilferty: a chi-square value with `df` degrees of freedom as a standard-normal score. */
export function wilsonHilferty(d2, df) {
    var k = Math.max(1, df), c = 2 / (9 * k);
    return (Math.cbrt(d2 / k) - (1 - c)) / Math.sqrt(c);
}

/**
 * The pose score of one pose: about 0 for a typical pose of this camera, higher
 * the rarer its shape. NaN when it cannot be tested (no model, or fewer than
 * POSE_MIN_NODES of the modelled nodes visible).
 * @param {Object|null} model  from `fitPoseModel`
 * @param {Float64Array|number[]} xy  interleaved x,y per node (NaN = missing)
 */
export function poseScore(model, xy) {
    if (!model || !xy || xy.length !== 2 * model.numNodes) return NaN;
    var n = model.nCore, slots = model._idx, v = 0;
    for (var c = 0; c < n; c++) {
        var k = model.core[c], x = xy[2 * k], y = xy[2 * k + 1];
        if (x === x && y === y) slots[v++] = c;
    }
    if (v < POSE_MIN_NODES) return NaN;
    var sl = slots.subarray(0, v);
    var key = patternKey(model, sl);
    var pat = model.patterns.get(key) || getPattern(model, key, Int32Array.from(sl));
    // Row of the pose on core slots (missing slots unread): reuse two buffers.
    var re = model._rowRe, im = model._rowIm;
    for (c = 0; c < n; c++) { re[c] = xy[2 * model.core[c]]; im[c] = xy[2 * model.core[c] + 1]; }
    return wilsonHilferty(residualD2(model, pat, re, im, 0), pat.df);
}
