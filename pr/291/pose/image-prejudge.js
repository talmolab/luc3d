/**
 * pose/image-prejudge.js — the image check's pre-judge of single-camera Track
 * All's review list: for each review row, do the two animals look like
 * themselves after it, or like each other? — given only where the image model
 * tells this video's two animals apart.
 *
 * Two numbers, both from the image check's crop embeddings (each L2-normalised),
 * label-free:
 *  - SEPARATION, per pair of identities (`pairSeparation`): 2-means over every
 *    image sample where both have a crop, one crop per cluster per sample,
 *    started from Track All's tracks; the cosine between the two cluster means.
 *    Lower = the model tells these two animals apart better.
 *  - A row's SCORE (`rowScore`): each identity's mean embedding over
 *    `windowSeconds` before the row's close spell and over as long after it;
 *    keep − swap = cos(A before, A after) + cos(B before, B after)
 *    − cos(A before, B after) − cos(B before, A after). Negative = the labels
 *    look swapped across the row.
 *
 * Verdicts (`prejudgeReviewRows`): 'alike' when the pair's separation is not
 * below `gateCos` (the model cannot tell these animals apart, so no verdict);
 * 'swapped' / 'kept' when the score is below −`margin` / above `margin`;
 * 'unsure' between; 'sparse' when a side has fewer than `minCrops` crops of an
 * animal; 'unknown' when fewer than `minPairs` samples show both animals.
 *
 * Calibration (2026-11-09, runs/2026-11-09_hard-swaps/gate_sweep on cup): 1,633
 * review rows of Mae's 395 intact two-mouse videos, 100 proofread swaps, a
 * fine-tuned dinov2-small package (held-out fold), crops every 2nd s. Score
 * alone: AUC 0.960 against the proofread files, 0.996 with the 7 rows the
 * images show to be proofreading errors set aside. Gate cos < 0.7 + margin 0.1
 * (the defaults): a verdict on 80% of rows (1,312 of 1,626), 64 of 94 swaps
 * called, 0 false alarms, 1 miss. Without the gate: 25 false alarms, 5 misses
 * (above cos 0.85 the AUC falls to ~0.8). Window lengths 1.5–8 s, gaps and
 * medians did not beat ±3 s. Other models use the same numbers, unmeasured.
 *
 * Pure — no DOM, no app state, no imports.
 */

/** The pre-judge's settings (see the module doc for how they were chosen). */
export const PREJUDGE_DEFAULTS = Object.freeze({
    windowSeconds: 3,   // each side of a row's close spell
    gateCos: 0.7,       // a verdict only for a pair whose cluster means' cosine is below this
    margin: 0.1,        // |score| below this: 'unsure'
    minCrops: 2,        // crops of each animal on each side, or 'sparse'
    minPairs: 10,       // samples showing both animals, or 'unknown'
    iterations: 15,     // 2-means rounds
});

function unitMean(vecs) {
    if (!vecs.length) return null;
    var D = vecs[0].length, m = new Float64Array(D), n = 0;
    for (var j = 0; j < vecs.length; j++) { var v = vecs[j]; for (var x = 0; x < D; x++) m[x] += v[x]; }
    for (var x2 = 0; x2 < D; x2++) n += m[x2] * m[x2];
    n = Math.sqrt(n);
    if (!(n > 0)) return null;
    for (var x3 = 0; x3 < D; x3++) m[x3] /= n;
    return m;
}

function dot(a, b) { var s = 0; for (var x = 0; x < a.length; x++) s += a[x] * b[x]; return s; }

/** A unit-length copy of `v` (Float64Array), or null for a zero / non-finite vector. */
export function unitVector(v) {
    if (!v || !v.length) return null;
    var n = 0;
    for (var x = 0; x < v.length; x++) n += v[x] * v[x];
    n = Math.sqrt(n);
    if (!(n > 0) || !isFinite(n)) return null;
    var u = new Float64Array(v.length);
    for (var x2 = 0; x2 < v.length; x2++) u[x2] = v[x2] / n;
    return u;
}

/**
 * Separation of two animals: 2-means over the samples showing both, one crop per
 * cluster per sample, started from their labels.
 * @param {Array<[Float64Array, Float64Array]>} pairs  per sample: (A's unit vector, B's)
 * @param {object} [opts] `iterations`, `minPairs`
 * @returns {?{cos: number, agree: number, n: number}} cos between the cluster means; agree = share of
 *   samples whose clusters keep the labels (A in cluster 0); null with fewer than `minPairs` samples
 */
export function pairSeparation(pairs, opts) {
    var o = Object.assign({}, PREJUDGE_DEFAULTS, opts || {});
    var n = pairs.length;
    if (n < o.minPairs || n < 1) return null;
    var P0 = unitMean(pairs.map(function (p) { return p[0]; })), P1 = unitMean(pairs.map(function (p) { return p[1]; }));
    if (!P0 || !P1) return null;
    var keepOf = new Uint8Array(n);
    for (var it = 0; it < o.iterations; it++) {
        var c0 = [], c1 = [];
        for (var i = 0; i < n; i++) {
            var a = pairs[i][0], b = pairs[i][1];
            var keep = dot(a, P0) + dot(b, P1) >= dot(a, P1) + dot(b, P0);
            keepOf[i] = keep ? 1 : 0;
            if (keep) { c0.push(a); c1.push(b); } else { c0.push(b); c1.push(a); }
        }
        var N0 = unitMean(c0), N1 = unitMean(c1);
        if (!N0 || !N1) break;
        P0 = N0; P1 = N1;
    }
    var agree = 0;
    for (var j = 0; j < n; j++) agree += keepOf[j];
    return { cos: dot(P0, P1), agree: agree / n, n: n };
}

/**
 * A row's keep − swap score from each animal's crops before and after it.
 * @param {{a0: Array, b0: Array, a1: Array, b1: Array}} sides  unit vectors: A and B before (0), after (1)
 * @param {number} [minCrops]
 * @returns {?number} null when a side has too few crops of an animal
 */
export function rowScore(sides, minCrops) {
    var m = minCrops == null ? PREJUDGE_DEFAULTS.minCrops : minCrops;
    if (!(sides.a0.length >= m && sides.b0.length >= m && sides.a1.length >= m && sides.b1.length >= m)) return null;
    var A0 = unitMean(sides.a0), B0 = unitMean(sides.b0), A1 = unitMean(sides.a1), B1 = unitMean(sides.b1);
    if (!A0 || !B0 || !A1 || !B1) return null;
    return dot(A0, A1) + dot(B0, B1) - dot(A0, B1) - dot(B0, A1);
}

/** The verdict for a score in a pair of a given separation (see the module doc). */
export function prejudgeVerdict(sep, score, opts) {
    var o = Object.assign({}, PREJUDGE_DEFAULTS, opts || {});
    if (!sep) return 'unknown';
    if (!(sep.cos < o.gateCos)) return 'alike';
    if (score == null) return 'sparse';
    return score < -o.margin ? 'swapped' : score > o.margin ? 'kept' : 'unsure';
}

/**
 * Pre-judge review rows.
 * @param {object} emb
 *   frames: number[]              the image samples' frames, increasing
 *   vector: (i, identityId) => ?Float64Array   sample i's unit vector of that identity (null: no crop)
 * @param {Array<{frame: number, startFrame?: number, identityA: number, identityB: number}>} rows
 * @param {number} fps
 * @param {object} [opts] PREJUDGE_DEFAULTS overrides
 * @returns {{rows: Array<{frame, startFrame, identityA, identityB, score: ?number, cos: ?number, verdict: string}>,
 *            pairs: Array<{identityA, identityB, cos: ?number, agree: ?number, samples: number}>, gateCos, margin, windowSeconds}}
 */
export function prejudgeReviewRows(emb, rows, fps, opts) {
    var o = Object.assign({}, PREJUDGE_DEFAULTS, opts || {});
    var frames = emb.frames, T = frames.length, W = o.windowSeconds * fps;
    var sepOf = new Map(), pairs = [];
    var pairKey = function (a, b) { return a < b ? a + ':' + b : b + ':' + a; };
    var separation = function (a, b) {
        var key = pairKey(a, b);
        if (sepOf.has(key)) return sepOf.get(key);
        var lo = Math.min(a, b), hi = Math.max(a, b), both = [];
        for (var i = 0; i < T; i++) {
            var u = emb.vector(i, lo), v = emb.vector(i, hi);
            if (u && v) both.push([u, v]);
        }
        var s = pairSeparation(both, o);
        sepOf.set(key, s);
        pairs.push({ identityA: lo, identityB: hi, cos: s ? s.cos : null, agree: s ? s.agree : null, samples: both.length });
        return s;
    };
    // first sample with frame >= f
    var lowerBound = function (f) {
        var lo = 0, hi = T;
        while (lo < hi) { var m = (lo + hi) >> 1; if (frames[m] < f) lo = m + 1; else hi = m; }
        return lo;
    };
    var collect = function (id, from, to, fromOpen, toOpen) {   // unit vectors of `id` at samples in the frame range
        var out = [];
        for (var i = lowerBound(from); i < T && frames[i] <= to; i++) {
            if ((fromOpen && frames[i] <= from) || (toOpen && frames[i] >= to)) continue;
            var v = emb.vector(i, id);
            if (v) out.push(v);
        }
        return out;
    };
    var out = rows.map(function (r) {
        var a = r.identityA, b = r.identityB;
        var s = r.startFrame != null && r.startFrame >= 0 && r.startFrame <= r.frame ? r.startFrame : r.frame, e = r.frame;
        var sep = separation(a, b);
        // before: [s − W, s); after: (e, e + W]
        var score = rowScore({ a0: collect(a, s - W, s, false, true), b0: collect(b, s - W, s, false, true),
                               a1: collect(a, e, e + W, true, false), b1: collect(b, e, e + W, true, false) }, o.minCrops);
        return { frame: r.frame, startFrame: s, identityA: a, identityB: b, score: score, cos: sep ? sep.cos : null,
                 verdict: prejudgeVerdict(sep, score, o) };
    });
    return { rows: out, pairs: pairs, gateCos: o.gateCos, margin: o.margin, windowSeconds: o.windowSeconds };
}

/** The pre-judge row for a review-list row (same frame and pair, either order), or null. */
export function prejudgeFor(prejudge, m) {
    if (!prejudge || !m) return null;
    for (var i = 0; i < prejudge.rows.length; i++) {
        var p = prejudge.rows[i];
        if (p.frame === m.frame && ((p.identityA === m.identityA && p.identityB === m.identityB) ||
            (p.identityA === m.identityB && p.identityB === m.identityA))) return p;
    }
    return null;
}
