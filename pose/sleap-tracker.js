/**
 * sleap-tracker.js — SLEAP's single-camera pose tracker, ported from sleap-nn.
 *
 * A port of `sleap_nn.tracking` (talmolab/sleap-nn @ 3d21684419ca, 2026-10-02:
 * `tracker.py` `Tracker` + `run_tracker` + `connect_single_breaks`, `utils.py`,
 * `candidates/fixed_window.py`, `candidates/local_queues.py`) and of the OKS in
 * `sleap_nn/evaluation.py`. It is what `sleap-nn track` runs on an existing
 * predictions file, so a SLEAP user who re-tracks in LUCID gets the tracker they
 * already know — and the same answer: `tests/e2e/sleap-tracker-parity.mjs` runs
 * upstream sleap-nn and this module on the same detections and compares every
 * track id.
 *
 * Ported faithfully, including what decides a TIE, because ties are common:
 * OKS at the default stddev (0.025) underflows to exactly 0 for any pair more
 * than ~1.5 body lengths apart, so a detection far from several tracks scores
 * them all 0 and the assignment is decided by the solver's tie-breaking.
 *   - `linearSumAssignment` is SciPy's `rectangular_lsap.cpp` (shortest
 *     augmenting path, Crouse 2016) line for line, including its reverse
 *     `remaining` order and its transpose for tall matrices.
 *   - `fixed_window`'s track columns come from `list(set(...))` in Python, so
 *     their order is CPython's set iteration order, emulated by `pySetOrder`.
 *   - greedy matching and NMS order edges with `np.argsort`, which is not
 *     stable; `numpyArgsort` is numpy's generic introsort (what arm64 and
 *     non-AVX-512 x86 run).
 *   - OKS sums its per-node similarities in numpy's pairwise order.
 * What is NOT bit-exact: `Math.exp` vs numpy's `exp` can differ in the last
 * ulp, and `euclidean_dist` on keypoints goes through BLAS in numpy. Both only
 * matter in a near-tie, and the parity test measures how often that happens.
 *
 * Not ported: `FlowShiftTracker` (optical flow on the video), `KalmanShiftTracker`
 * (an EM-fitted Kalman filter), the appearance blend and the `embeddings` /
 * `masks` features (they need a re-ID model's vectors or segmentation masks).
 *
 * Detections are plain objects: `{ points: Float64Array(2K) [x0, y0, x1, y1, …]
 * with NaN for a missing node, score: number, isUser?: boolean }`.
 *
 * Pure — no DOM, no app state, no imports.
 */

/** sleap-nn's `run_tracker` / `Tracker.from_config` defaults (`sleap-nn track`'s). */
export const SLEAP_TRACKER_DEFAULTS = {
    windowSize: 5,
    minNewTrackPoints: 0,
    candidatesMethod: 'fixed_window',   // 'fixed_window' | 'local_queues'
    minMatchPoints: 0,
    features: 'keypoints',              // 'keypoints' | 'centroids' | 'bboxes'
    scoringMethod: 'oks',               // 'oks' | 'euclidean_dist' | 'iou' | 'cosine_sim'
    scoringReduction: 'mean',           // 'mean' | 'max' | 'robust_quantile'
    robustBestInstance: 1.0,
    oksStddev: null,                    // null -> 0.025 (the Kalman-keypoints 0.1 is not ported)
    trackMatchingMethod: 'hungarian',   // 'hungarian' | 'greedy'
    maxTracks: null,
    postConnectSingleBreaks: false,
    targetInstanceCount: null,
    preCullToTarget: 0,
    preCullIouThreshold: 0,
    cleanInstanceCount: 0,
    cleanIouThreshold: 0,
};

const EPS = 2.220446049250313e-16;   // np.spacing(1)

// ---------------------------------------------------------------------------
// numpy / CPython behaviour the tracker's decisions depend on
// ---------------------------------------------------------------------------

/** numpy's pairwise summation of a contiguous float64 run (`DOUBLE_pairwise_sum`). */
function pairwiseSum(a, off, n) {
    if (n < 8) {
        var res = 0;   // numpy starts from -0.0; identical for every sum that is not all -0.0
        for (var i = 0; i < n; i++) res += a[off + i];
        return res;
    }
    if (n <= 128) {
        var r0 = a[off], r1 = a[off + 1], r2 = a[off + 2], r3 = a[off + 3],
            r4 = a[off + 4], r5 = a[off + 5], r6 = a[off + 6], r7 = a[off + 7];
        var i2;
        for (i2 = 8; i2 < n - (n % 8); i2 += 8) {
            r0 += a[off + i2]; r1 += a[off + i2 + 1]; r2 += a[off + i2 + 2]; r3 += a[off + i2 + 3];
            r4 += a[off + i2 + 4]; r5 += a[off + i2 + 5]; r6 += a[off + i2 + 6]; r7 += a[off + i2 + 7];
        }
        var s = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7));
        for (; i2 < n; i2++) s += a[off + i2];
        return s;
    }
    var n2 = n >> 1; n2 -= n2 % 8;
    return pairwiseSum(a, off, n2) + pairwiseSum(a, off + n2, n - n2);
}

/**
 * The iteration order of `list(set(ints))` in CPython 3.11 after inserting
 * `keys` in order (`set().update(...)` on each list): open addressing with 9
 * linear probes then perturbation, resized ×4 once 3/5 full. For non-negative
 * ints hash(i) == i. sleap-nn's `FixedWindowCandidates.current_tracks` is
 * exactly this, and its order is the score matrix's column order.
 */
export function pySetOrder(keys) {
    var LINEAR_PROBES = 9, PERTURB_SHIFT = 5;
    var mask = 7, table = new Array(8).fill(null), fill = 0;
    var insertClean = function (tbl, msk, key) {
        var perturb = key, i = key & msk;
        for (;;) {
            if (tbl[i] === null) { tbl[i] = key; return; }
            if (i + LINEAR_PROBES <= msk) {
                for (var j = 1; j <= LINEAR_PROBES; j++) if (tbl[i + j] === null) { tbl[i + j] = key; return; }
            }
            perturb = Math.floor(perturb / 32);   // >>= PERTURB_SHIFT on a size_t
            i = (i * 5 + 1 + perturb) & msk;
        }
    };
    for (var q = 0; q < keys.length; q++) {
        var key = keys[q];
        var perturb = key, i = key & mask, found = false, placed = -1;
        outer: for (;;) {
            var probes = (i + LINEAR_PROBES <= mask) ? LINEAR_PROBES : 0;
            for (var j = 0; j <= probes; j++) {
                var e = table[i + j];
                if (e === null) { placed = i + j; break outer; }
                if (e === key) { found = true; break outer; }
            }
            perturb = Math.floor(perturb / Math.pow(2, PERTURB_SHIFT));
            i = (i * 5 + 1 + perturb) & mask;
        }
        if (found) continue;
        table[placed] = key; fill++;
        if (fill * 5 >= mask * 3) {
            var used = fill, newsize = 8, minused = used > 50000 ? used * 2 : used * 4;
            while (newsize <= minused) newsize *= 2;
            var nt = new Array(newsize).fill(null);
            for (var t = 0; t <= mask; t++) if (table[t] !== null) insertClean(nt, newsize - 1, table[t]);
            table = nt; mask = newsize - 1;
        }
    }
    return table.filter(function (k) { return k !== null; });
}

/**
 * `np.argsort(values)` (kind 'quicksort') as numpy runs it on arm64 and on x86
 * without AVX-512: its generic introsort (`aquicksort_`, npysort/quicksort.cpp)
 * — median-of-3 partitions down to 16 elements, then insertion sort. It is NOT
 * stable, and greedy matching and NMS read their ties from it. (With AVX-512,
 * numpy dispatches argsort to x86-simd-sort instead, whose tie order differs —
 * so upstream sleap-nn itself breaks those ties differently on such machines.)
 * NaN sorts last. The depth-limited heapsort fallback is unreachable at the
 * sizes a tracker sorts and is not ported.
 */
export function numpyArgsort(v) {
    var n = v.length, ix = new Int32Array(n);
    for (var i = 0; i < n; i++) ix[i] = i;
    var less = function (a, b) { return a < b || (b !== b && a === a); };
    var swap = function (a, b) { var t = ix[a]; ix[a] = ix[b]; ix[b] = t; };
    var stack = [], pl = 0, pr = n - 1;
    for (;;) {
        while (pr - pl > 15) {          // SMALL_QUICKSORT = 15
            var pm = pl + ((pr - pl) >> 1);
            if (less(v[ix[pm]], v[ix[pl]])) swap(pm, pl);
            if (less(v[ix[pr]], v[ix[pm]])) swap(pr, pm);
            if (less(v[ix[pm]], v[ix[pl]])) swap(pm, pl);
            var vp = v[ix[pm]], pi = pl, pj = pr - 1;
            swap(pm, pj);
            for (;;) {
                do { ++pi; } while (less(v[ix[pi]], vp));
                do { --pj; } while (less(vp, v[ix[pj]]));
                if (pi >= pj) break;
                swap(pi, pj);
            }
            swap(pi, pr - 1);
            if (pi - pl < pr - pi) { stack.push(pi + 1, pr); pr = pi - 1; }
            else { stack.push(pl, pi - 1); pl = pi + 1; }
        }
        for (var a = pl + 1; a <= pr; a++) {          // insertion sort
            var vi = ix[a], val = v[vi], b = a;
            while (b > pl && less(val, v[ix[b - 1]])) { ix[b] = ix[b - 1]; b--; }
            ix[b] = vi;
        }
        if (!stack.length) break;
        pr = stack.pop(); pl = stack.pop();
    }
    return ix;
}

/** `np.nanquantile(values, q)` (method 'linear'). */
function nanQuantile(values, q) {
    var v = values.filter(function (x) { return x === x; }).sort(function (a, b) { return a - b; });
    if (!v.length) return NaN;
    var idx = (v.length - 1) * q, lo = Math.floor(idx), hi = Math.min(lo + 1, v.length - 1), t = idx - lo;
    var a = v[lo], b = v[hi], d = b - a;
    return t >= 0.5 ? b - d * (1 - t) : a + d * t;   // numpy's _lerp
}

/** `np.nanmedian` of one coordinate across nodes. */
function nanMedian(vals) {
    var v = vals.filter(function (x) { return x === x; }).sort(function (a, b) { return a - b; });
    if (!v.length) return NaN;
    var m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * SciPy's `linear_sum_assignment` (rectangular_lsap.cpp). `cost` is row-major
 * nr x nc with no NaN / -Infinity. Returns {rows, cols} exactly as SciPy does
 * (rows ascending; a tall matrix is solved transposed and sorted back by row),
 * or null when infeasible.
 */
export function linearSumAssignment(cost, nr, nc) {
    if (nr === 0 || nc === 0) return { rows: [], cols: [] };
    var transpose = nc < nr, C = cost;
    if (transpose) {
        C = new Float64Array(nr * nc);
        for (var i0 = 0; i0 < nr; i0++) for (var j0 = 0; j0 < nc; j0++) C[j0 * nr + i0] = cost[i0 * nc + j0];
        var tmp = nr; nr = nc; nc = tmp;
    }
    var u = new Float64Array(nr), v = new Float64Array(nc), spc = new Float64Array(nc);
    var path = new Int32Array(nc).fill(-1), col4row = new Int32Array(nr).fill(-1), row4col = new Int32Array(nc).fill(-1);
    var SR = new Uint8Array(nr), SC = new Uint8Array(nc), remaining = new Int32Array(nc);
    for (var curRow = 0; curRow < nr; curRow++) {
        // augmenting_path
        var minVal = 0, numRemaining = nc, i = curRow;
        for (var it = 0; it < nc; it++) remaining[it] = nc - it - 1;
        SR.fill(0); SC.fill(0); spc.fill(Infinity);
        var sink = -1;
        while (sink === -1) {
            var index = -1, lowest = Infinity;
            SR[i] = 1;
            for (var it2 = 0; it2 < numRemaining; it2++) {
                var j = remaining[it2];
                var r = minVal + C[i * nc + j] - u[i] - v[j];
                if (r < spc[j]) { path[j] = i; spc[j] = r; }
                if (spc[j] < lowest || (spc[j] === lowest && row4col[j] === -1)) { lowest = spc[j]; index = it2; }
            }
            minVal = lowest;
            if (minVal === Infinity) return null;
            var jj = remaining[index];
            if (row4col[jj] === -1) sink = jj; else i = row4col[jj];
            SC[jj] = 1;
            remaining[index] = remaining[--numRemaining];
        }
        // update dual variables
        u[curRow] += minVal;
        for (var i2 = 0; i2 < nr; i2++) if (SR[i2] && i2 !== curRow) u[i2] += minVal - spc[col4row[i2]];
        for (var j2 = 0; j2 < nc; j2++) if (SC[j2]) v[j2] -= minVal - spc[j2];
        // augment previous solution
        var jcur = sink;
        for (;;) {
            var ip = path[jcur];
            row4col[jcur] = ip;
            var sw = col4row[ip]; col4row[ip] = jcur; jcur = sw;
            if (ip === curRow) break;
        }
    }
    var rows = [], cols = [];
    if (transpose) {
        var order = Array.from(col4row.keys()).sort(function (a, b) { return col4row[a] - col4row[b]; });
        for (var q = 0; q < order.length; q++) { rows.push(col4row[order[q]]); cols.push(order[q]); }
    } else {
        for (var q2 = 0; q2 < nr; q2++) { rows.push(q2); cols.push(col4row[q2]); }
    }
    return { rows: rows, cols: cols };
}

/** `hungarian_matching`: non-finite costs are replaced by 10 x the largest |finite| + 1. */
function hungarianMatching(cost, nr, nc) {
    var C = cost, maxAbs = -1, invalid = false;
    for (var k = 0; k < cost.length; k++) {
        if (Number.isFinite(cost[k])) { if (Math.abs(cost[k]) > maxAbs) maxAbs = Math.abs(cost[k]); } else invalid = true;
    }
    if (invalid) {
        var fillV = maxAbs >= 0 ? maxAbs * 10 + 1 : 1e6;
        C = Float64Array.from(cost, function (x) { return Number.isFinite(x) ? x : fillV; });
    }
    return linearSumAssignment(C, nr, nc) || { rows: [], cols: [] };
}

/** `greedy_matching`: cheapest edge first, edges in `np.argsort(cost, axis=None)` order (ties included). */
function greedyMatching(cost, nr, nc) {
    var idx = numpyArgsort(cost);
    var usedR = new Uint8Array(nr), usedC = new Uint8Array(nc), rows = [], cols = [];
    for (var q = 0; q < idx.length; q++) {
        var r = Math.floor(idx[q] / nc), c = idx[q] % nc;
        if (usedR[r] || usedC[c]) continue;
        usedR[r] = 1; usedC[c] = 1; rows.push(r); cols.push(c);
    }
    return { rows: rows, cols: cols };
}

// ---------------------------------------------------------------------------
// Features and scores (sleap_nn/tracking/utils.py, evaluation.compute_oks)
// ---------------------------------------------------------------------------

/** Nodes with both coordinates present (`count_valid_points`). */
export function countValidPoints(points) {
    var n = 0;
    for (var k = 0; k < points.length; k += 2) if (points[k] === points[k] && points[k + 1] === points[k + 1]) n++;
    return n;
}

function featureOf(kind, points) {
    if (kind === 'keypoints') return points;
    var K = points.length / 2;
    if (kind === 'centroids') {
        var xs = [], ys = [];
        for (var k = 0; k < K; k++) { xs.push(points[2 * k]); ys.push(points[2 * k + 1]); }
        return Float64Array.of(nanMedian(xs), nanMedian(ys));
    }
    if (kind === 'bboxes') return bboxOf(points);
    throw new Error('Unsupported tracker features: ' + kind + ' (keypoints, centroids or bboxes)');
}

/** [xmin, ymin, xmax, ymax] over present nodes (`get_bbox`). */
function bboxOf(points) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
    for (var k = 0; k < points.length; k += 2) {
        var x = points[k], y = points[k + 1];
        if (x === x) { any = true; if (x < x0) x0 = x; if (x > x1) x1 = x; }
        if (y === y) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return any ? Float64Array.of(x0, y0, x1, y1) : Float64Array.of(NaN, NaN, NaN, NaN);
}

/**
 * `compute_oks(points_gt=gt, points_pr=pr, stddev)` for one pair (cocoeval
 * normalization): the scale is the area of gt's bounding box.
 */
export function computeOks(gt, pr, stddev) {
    var K = gt.length / 2, b = bboxOf(gt);
    var scale = (b[2] - b[0]) * (b[3] - b[1]);
    var norm = ((2 * stddev) * (2 * stddev)) * (2 * (scale + EPS));
    var ks = new Float64Array(K), nVis = 0;
    for (var k = 0; k < K; k++) {
        var gx = gt[2 * k], gy = gt[2 * k + 1];
        if (gx !== gx || gy !== gy) { ks[k] = 0; continue; }
        nVis++;
        var px = pr[2 * k], py = pr[2 * k + 1];
        if (px !== px || py !== py) { ks[k] = 0; continue; }   // exp(-inf)
        var dx = gx - px, dy = gy - py;
        ks[k] = Math.exp(-((dx * dx + dy * dy) / norm));
    }
    return pairwiseSum(ks, 0, K) / nVis;   // 0/0 -> NaN, as in numpy
}

function euclideanScore(a, b) {
    if (a.length !== b.length || !a.length) return NaN;
    var s = 0;
    for (var k = 0; k < a.length; k++) { var d = a[k] - b[k]; s += d * d; }
    var dist = Math.sqrt(s);
    return Number.isFinite(dist) ? -dist : NaN;
}

function iouScore(a, b) {
    var ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]) + 1);
    var iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]) + 1);
    var inter = ix * iy;
    var area1 = (a[2] - a[0] + 1) * (a[3] - a[1] + 1), area2 = (b[2] - b[0] + 1) * (b[3] - b[1] + 1);
    return inter / (area1 + area2 - inter);
}

function cosineScore(a, b) {
    if (a.length !== b.length || !a.length) return NaN;
    var d = 0, na = 0, nb = 0;
    for (var k = 0; k < a.length; k++) { d += a[k] * b[k]; na += a[k] * a[k]; nb += b[k] * b[k]; }
    var den = Math.sqrt(na) * Math.sqrt(nb);
    if (!Number.isFinite(den) || den === 0) return NaN;
    return d / den;
}

// ---------------------------------------------------------------------------
// Culling (utils.nms_fast / _instances_over_count)
// ---------------------------------------------------------------------------

function nmsFast(boxes, scores, iouThreshold, targetCount) {
    var n = boxes.length;
    if (!n) return [];
    if (targetCount && n < targetCount) return Array.from({ length: n }, function (_, i) { return i; });
    var area = boxes.map(function (b) { return (b[2] - b[0] + 1) * (b[3] - b[1] + 1); });
    var idxs = Array.from(numpyArgsort(scores));
    var picked = [], removed = [];
    while (idxs.length) {
        var p = idxs[idxs.length - 1];
        picked.push(p);
        var rest = idxs.slice(0, -1), drop = new Set();
        for (var q = 0; q < rest.length; q++) {
            var o = rest[q];
            var w = Math.max(0, Math.min(boxes[p][2], boxes[o][2]) - Math.max(boxes[p][0], boxes[o][0]) + 1);
            var h = Math.max(0, Math.min(boxes[p][3], boxes[o][3]) - Math.max(boxes[p][1], boxes[o][1]) + 1);
            if ((w * h) / area[o] > iouThreshold) { removed.push(o); drop.add(q); }
        }
        idxs = rest.filter(function (_, q2) { return !drop.has(q2); });
    }
    if (targetCount && removed.length && picked.length < targetCount) {
        removed.sort(function (a, b) { return scores[b] - scores[a]; });
        picked = picked.concat(removed.slice(0, Math.min(removed.length, targetCount - picked.length)));
    }
    return picked;
}

/** Indices (into `dets`) of the predicted detections to drop to get down to `count`. */
export function instancesOverCount(dets, count, iouThreshold) {
    var pred = [];
    for (var i = 0; i < dets.length; i++) if (!dets[i].isUser) pred.push(i);
    if (pred.length <= count) return [];
    var keep = pred, extra = [];
    if (iouThreshold) {
        var picks = new Set(nmsFast(pred.map(function (i2) { return bboxOf(dets[i2].points); }),
            pred.map(function (i3) { return dets[i3].score; }), iouThreshold, count));
        keep = pred.filter(function (_, q) { return picks.has(q); });
        extra = pred.filter(function (_, q) { return !picks.has(q); });
    }
    if (keep.length > count) {
        var byScore = keep.slice().sort(function (a, b) { return dets[a].score - dets[b].score || keep.indexOf(a) - keep.indexOf(b); });
        extra = extra.concat(byScore.slice(0, keep.length - count));
    }
    return extra;
}

// ---------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------

/**
 * One tracker over one video, fed frame by frame in increasing frame order
 * (sleap-nn's `Tracker`). `track(dets, frameIdx)` returns, per detection, its
 * track id (0, 1, …), null when the tracker dropped it (no track to spare under
 * `maxTracks`, or too little support to spawn one), or undefined for a
 * PREDICTED detection on a frame that has user ones (sleap-nn tracks only the
 * user instances there and leaves the predictions as they were).
 */
export class SleapTracker {
    /**
     * @param {object} cfg  see SLEAP_TRACKER_DEFAULTS
     * @param {function(object)} [observe]  called after each frame's matching with
     *   `{frameIdx, dets, tracks, cost, nr, nc, pairs}` — the detection index of each
     *   row (into the frame's `dets`), the track id of each column, the row-major cost
     *   matrix (Infinity where sleap-nn scores NaN) and the kept [row, col] pairs.
     *   Read-only: it cannot change an assignment, so the port's answers stay
     *   sleap-nn's. Not called on a frame with no tracks to match against.
     */
    constructor(cfg, observe) {
        var c = Object.assign({}, SLEAP_TRACKER_DEFAULTS, cfg || {});
        this.observe = typeof observe === 'function' ? observe : null;
        // from_config: a track cap under fixed_window switches to local_queues
        if (c.maxTracks != null && c.candidatesMethod === 'fixed_window') c.candidatesMethod = 'local_queues';
        if (c.candidatesMethod !== 'fixed_window' && c.candidatesMethod !== 'local_queues') {
            throw new Error(c.candidatesMethod + ' is not a valid method. Please choose one of [`fixed_window`, `local_queues`]');
        }
        if (c.oksStddev == null) c.oksStddev = 0.025;
        this.cfg = c;
        this.local = c.candidatesMethod === 'local_queues';
        // local_queues: track id -> deque of {det, feature, frame}; fixed_window: deque of frames
        this.queues = new Map();
        this.currentTracksList = [];          // local_queues: minted ids, in order
        this.window = [];                     // fixed_window: [{dets, features, trackIds, frame}]
        this.allTracks = [];                  // fixed_window: every id ever minted
        var self = this;
        this.score = {
            oks: function (a, b) { return computeOks(a, b, self.cfg.oksStddev); },
            euclidean_dist: euclideanScore, iou: iouScore, cosine_sim: cosineScore,
        }[c.scoringMethod];
        if (!this.score) throw new Error('Invalid `scoring_method`: ' + c.scoringMethod);
        var q = c.robustBestInstance;
        this.reduce = {
            mean: function (s) { var t = 0, n = 0; for (var i = 0; i < s.length; i++) if (s[i] === s[i]) { t += s[i]; n++; } return n ? t / n : NaN; },
            max: function (s) { var m = -Infinity, any = false; for (var i = 0; i < s.length; i++) if (s[i] === s[i]) { any = true; if (s[i] > m) m = s[i]; } return any ? m : NaN; },
            robust_quantile: function (s) { return nanQuantile(s, q); },
        }[c.scoringReduction];
        if (!this.reduce) throw new Error('Invalid `scoring_reduction`: ' + c.scoringReduction);
        this.match = { hungarian: hungarianMatching, greedy: greedyMatching }[c.trackMatchingMethod];
        if (!this.match) throw new Error('Invalid `track_matching_method`: ' + c.trackMatchingMethod);
    }

    currentTracks() {
        if (this.local) return this.currentTracksList;
        if (!this.window.length) return [];
        var ids = [];
        this.window.forEach(function (w) { w.trackIds.forEach(function (t) { if (t != null) ids.push(t); }); });
        return pySetOrder(ids);
    }

    _newTrackId() {
        if (this.local) {
            var L = this.currentTracksList;
            if (!L.length) { this.queues.set(0, []); return 0; }
            var id = Math.max.apply(null, L) + 1;
            if (this.cfg.maxTracks != null && id >= this.cfg.maxTracks) return null;
            this.queues.set(id, []);
            return id;
        }
        return this.allTracks.length ? Math.max.apply(null, this.allTracks) + 1 : 0;
    }

    _availableNewTracks() {
        if (!this.local || this.cfg.maxTracks == null) return null;
        var L = this.currentTracksList;
        var next = L.length ? Math.max.apply(null, L) + 1 : 0;
        return Math.max(0, this.cfg.maxTracks - next);
    }

    _pushQueue(id, item) {
        var dq = this.queues.get(id);
        dq.push(item);
        if (dq.length > this.cfg.windowSize) dq.shift();
    }

    /** The candidates of one track: [{det, feature}] in queue order. */
    _candidates(id) {
        if (this.local) return this.queues.get(id) || [];
        var out = [];
        this.window.forEach(function (w) {
            var i = w.trackIds.indexOf(id);
            if (i >= 0) out.push({ det: w.dets[i], feature: w.features[i] });
        });
        return out;
    }

    track(dets, frameIdx) {
        var c = this.cfg;
        var anyUser = dets.some(function (d) { return d.isUser; });
        var out = new Array(dets.length).fill(anyUser ? undefined : null);
        // run_tracker: on a frame with user instances only those are tracked
        var idx = [];
        for (var i = 0; i < dets.length; i++) if (!anyUser || dets[i].isUser) { out[i] = null; idx.push(i); }
        var cur = idx.map(function (i2) { return dets[i2]; });
        if (c.targetInstanceCount && c.preCullToTarget) {
            var drop = new Set(instancesOverCount(cur, c.targetInstanceCount, c.preCullIouThreshold));
            idx = idx.filter(function (_, q) { return !drop.has(q); });
            cur = cur.filter(function (_, q) { return !drop.has(q); });
        }
        var feats = cur.map(function (d) { return featureOf(c.features, d.points); });
        var ids = this.currentTracks().slice();
        var assigned = new Array(cur.length).fill(null);   // track id per row
        var order = [];                                      // rows in sleap-nn's output order (local_queues)
        if (!this._hasCandidates()) {
            this._addNewTracks(cur, feats, frameIdx, assigned, order, Array.from(cur.keys()), true);
        } else {
            var nr = cur.length, nc = ids.length, cost = new Float64Array(nr * nc);
            for (var r = 0; r < nr; r++) for (var t = 0; t < nc; t++) {
                var cands = this._candidates(ids[t]), sc = [];
                for (var q2 = 0; q2 < cands.length; q2++) {
                    if (countValidPoints(cands[q2].det.points) > c.minMatchPoints) sc.push(this.score(feats[r], cands[q2].feature));
                }
                var s = sc.length ? this.reduce(sc) : NaN;
                cost[r * nc + t] = s === s ? -s : Infinity;
            }
            var m = this.match(cost, nr, nc);
            var pairs = m.rows.map(function (row, k) { return [row, m.cols[k]]; });
            pairs = this._dropInfeasible(pairs, cost, nc, cur);
            if (this.observe) this.observe({ frameIdx: frameIdx, dets: idx.slice(), tracks: ids.slice(), cost: cost, nr: nr, nc: nc,
                                             pairs: pairs.map(function (p) { return p.slice(); }) });
            if (this.local) {
                pairs.forEach(function (p) { assigned[p[0]] = p[1]; order.push(p[0]); });
                for (var r2 = 0; r2 < nr; r2++) if (assigned[r2] != null) this._pushQueue(assigned[r2], { det: cur[r2], feature: feats[r2] });
            } else {
                pairs.forEach(function (p) { assigned[p[0]] = ids[p[1]]; });
            }
            var paired = new Set(pairs.map(function (p) { return p[0]; }));
            var fresh = Array.from(cur.keys()).filter(function (r3) { return !paired.has(r3); });
            if (!this.local) this.window.push({ dets: cur, features: feats, trackIds: assigned, frame: frameIdx });
            if (fresh.length) this._addNewTracks(cur, feats, frameIdx, assigned, order, fresh, false);
            if (!this.local && this.window.length > c.windowSize) this.window.shift();
        }
        for (var r4 = 0; r4 < cur.length; r4++) out[idx[r4]] = assigned[r4];
        this.lastOrder = (this.local ? order : Array.from(cur.keys()).filter(function (r5) { return assigned[r5] != null; }))
            .map(function (r6) { return idx[r6]; });
        return out;
    }

    _hasCandidates() { return this.local ? this.queues.size > 0 : this.window.length > 0; }

    _addNewTracks(cur, feats, frameIdx, assigned, order, rows, firstFrame) {
        var c = this.cfg, isNew = false;
        for (var q = 0; q < rows.length; q++) {
            var r = rows[q];
            if (countValidPoints(cur[r].points) <= c.minNewTrackPoints) continue;
            if (this.local) {
                var id = this._newTrackId();
                if (id == null) continue;   // at the cap: the detection is dropped
                assigned[r] = id; order.push(r);
                this.currentTracksList.push(id);
                this._pushQueue(id, { det: cur[r], feature: feats[r] });
            } else if (assigned[r] == null) {
                var id2 = this._newTrackId();
                assigned[r] = id2; this.allTracks.push(id2); isNew = true;
            }
        }
        if (!this.local && firstFrame && isNew) {
            this.window.push({ dets: cur, features: feats, trackIds: assigned, frame: frameIdx });
            if (this.window.length > c.windowSize) this.window.shift();
        }
    }

    /** `Tracker.assign_tracks`: drop a non-finite pairing unless the detection could not spawn a track instead. */
    _dropInfeasible(pairs, cost, nc, cur) {
        var infeasible = pairs.filter(function (p) { return !Number.isFinite(cost[p[0] * nc + p[1]]); });
        if (!infeasible.length) return pairs;
        var slots = this._availableNewTracks(), minNew = this.cfg.minNewTrackPoints;
        var support = function (row) { return countValidPoints(cur[row].points) > minNew; };
        if (slots != null) {
            var paired = new Set(pairs.map(function (p) { return p[0]; })), unpaired = 0;
            for (var r = 0; r < cur.length; r++) if (!paired.has(r) && support(r)) unpaired++;
            slots = Math.max(0, slots - unpaired);
        }
        var spawnable = 0, forced = new Set();
        infeasible.forEach(function (p) {
            if (support(p[0]) && (slots == null || spawnable < slots)) spawnable++;
            else forced.add(p);
        });
        return pairs.filter(function (p) { return Number.isFinite(cost[p[0] * nc + p[1]]) || forced.has(p); });
    }
}

/**
 * `connect_single_breaks`: on a frame where exactly one track went missing and
 * exactly one new track appeared, the new track takes the missing one's id —
 * from then on. `frames` = [{ids: [trackId…] in sleap-nn's instance order}];
 * rewritten in place.
 */
export function connectSingleBreaks(frames) {
    if (!frames.length) return frames;
    var fix = new Map();
    var lastGood = new Set(frames[0].ids);
    for (var f = 0; f < frames.length; f++) {
        var ids = frames[f].ids;
        var set = new Set(ids);
        var fixedBefore = false;
        set.forEach(function (t) { if (fix.has(t)) fixedBefore = true; });
        if (fixedBefore) {
            for (var i = 0; i < ids.length; i++) {
                if (fix.has(ids[i]) && !set.has(fix.get(ids[i]))) { ids[i] = fix.get(ids[i]); set = new Set(ids); }
            }
        }
        var extra = [], missing = [];
        set.forEach(function (t) { if (!lastGood.has(t)) extra.push(t); });
        lastGood.forEach(function (t) { if (!set.has(t)) missing.push(t); });
        if (extra.length === 1 && missing.length === 1) {
            for (var i2 = 0; i2 < ids.length; i2++) {
                if (ids[i2] === extra[0]) { fix.set(extra[0], missing[0]); ids[i2] = missing[0]; break; }
            }
        } else if (set.size >= lastGood.size) {
            lastGood = set;
        }
    }
    return frames;
}

/**
 * `run_tracker` over one video. `frames` = [{frameIdx, dets: [detection…]}]
 * sorted by frameIdx (sleap-nn sorts them; so must the caller). Returns, per
 * frame, an array of track ids aligned with its `dets` (null = dropped,
 * undefined = a prediction left alone on a user-labelled frame). Post-processing
 * as in `run_tracker`: the clean cull, then `connect_single_breaks`.
 * `opts.observe` is passed to the tracker (see `SleapTracker`); the track ids it
 * sees are from BEFORE post-processing, so read final ids through its `dets`.
 */
export function runSleapTracker(frames, cfg, opts) {
    var gen = sleapTrackerSteps(frames, cfg, opts);
    var r = gen.next();
    while (!r.done) r = gen.next();
    return r.value;
}

/**
 * As `runSleapTracker`, yielding to the event loop every `opts.yieldEvery` frames
 * (default 2000) — through `await opts.onProgress(done, total)` when given.
 */
export async function runSleapTrackerAsync(frames, cfg, opts) {
    var gen = sleapTrackerSteps(frames, cfg, opts);
    var r = gen.next();
    while (!r.done) {
        if (opts && opts.signal && opts.signal.aborted) { var e = new Error('Cancelled'); e.name = 'AbortError'; throw e; }
        if (opts && opts.onProgress) await opts.onProgress(r.value, frames.length);
        else await new Promise(function (res) { setTimeout(res, 0); });
        r = gen.next();
    }
    return r.value;
}

function* sleapTrackerSteps(frames, cfg, opts) {
    var c = Object.assign({}, SLEAP_TRACKER_DEFAULTS, cfg || {});
    if (c.postConnectSingleBreaks && !c.targetInstanceCount) {
        throw new Error('post_connect_single_breaks requires tracking_target_instance_count to be set');
    }
    var every = (opts && opts.yieldEvery) || 2000;
    var tracker = new SleapTracker(c, opts && opts.observe);
    var out = [], ordered = [];
    for (var f = 0; f < frames.length; f++) {
        var ids = tracker.track(frames[f].dets, frames[f].frameIdx);
        out.push(ids);
        ordered.push(tracker.lastOrder);
        if ((f + 1) % every === 0) yield f + 1;
    }
    // post-processing works on the tracked instances only, in sleap-nn's output order
    var view = function () {
        return ordered.map(function (ord, f2) {
            return { ids: ord.filter(function (i) { return out[f2][i] != null; }).map(function (i) { return out[f2][i]; }), ord: ord };
        });
    };
    var writeBack = function (v) {
        v.forEach(function (fr, f3) {
            var k = 0;
            fr.ord.forEach(function (i) { if (out[f3][i] != null) out[f3][i] = fr.ids[k++]; });
        });
    };
    if (c.cleanInstanceCount > 0) {
        frames.forEach(function (fr, f4) {
            var kept = ordered[f4].filter(function (i) { return out[f4][i] != null; });
            var drop = instancesOverCount(kept.map(function (i) { return fr.dets[i]; }), c.cleanInstanceCount, c.cleanIouThreshold);
            drop.forEach(function (q) { out[f4][kept[q]] = null; });
        });
        if (!c.postConnectSingleBreaks) { var v1 = view(); connectSingleBreaks(v1); writeBack(v1); }
    }
    if (c.postConnectSingleBreaks) { var v2 = view(); connectSingleBreaks(v2); writeBack(v2); }
    return out;
}
