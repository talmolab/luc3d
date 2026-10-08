/**
 * id-switch-check.js — flag possible identity switches after tracking, from
 * body size and/or appearance (images).
 *
 * A tracker can only hand an identity to a different animal when two animals
 * come close (or one drops out). So instead of judging every frame, this looks
 * at each CLOSE ENCOUNTER between two identities and asks: do the two animals
 * that leave it look more like the identities they now carry, or like each
 * other's? Two kinds of evidence answer that question, through the SAME
 * machinery (sampling, tracklets, encounters, cross-validated classifier,
 * within-frame contrast, encounter score, change points):
 *
 *   - checkSizeSwitches  — 3D bone lengths read off each identity's
 *     triangulated skeleton. Cheap, no video.
 *   - checkImageSwitches — embeddings of masked, pose-aligned crops of each
 *     identity in every camera (supplied by the caller's `getEmbeddings`; the app
 *     uses DINOv2-small in the browser, ui/image-embedder.js). Slow; catches
 *     animals of the same size that look different (coat colour, markings).
 *
 * Either model is learned from the tracker's OWN identity labels, so no ground
 * truth is needed. Each encounter is scored by a model trained only on samples
 * at least `gapSeconds` away (blocked cross-validation), so a stretch is never
 * judged by a model that has seen it — and a real switch, which poisons the
 * labels after it, is still a minority the model can disagree with.
 *
 * Validated offline (2026-10-03) on the 5-mouse tail-mark recording
 * (194366_05mice_flippers, 108,000 frames, 8 cameras), where tail marks give
 * ground truth: by size, planted swaps at close encounters were caught with AUC
 * 0.95 (80% at a 5% false-alarm rate); the real switch in the gate-off tracker run
 * (frame 74,544) was flagged at its first encounter, and the default threshold
 * (-50) caught it with ~16 false alarms in 30 minutes. Animals of near-equal
 * size are the size check's blind spot — which is what the image check is for.
 *
 * Frame-rate independence: everything time-dependent is set in SECONDS and
 * converted with the recording's frame rate (`opts.fps`, required). Encounters
 * are found on a ~`sampleHz` grid (every round(fps / sampleHz)-th frame); each
 * sample's evidence is weighted by REFERENCE_HZ / (that cue's actual sample
 * rate), so a score is evidence per unit TIME and thresholds mean the same at
 * any frame rate (the image check samples more sparsely, `imageHz`, on the same
 * grid). The size threshold (-50) was calibrated at 15 Hz on 60 fps video, where
 * every size weight is exactly 1.
 *
 * Depends on: pose-data.js (readPoint3d). Pure — no DOM, no app state.
 */

import { readPoint3d } from './pose-data.js?v=53a379731b7a';

/** Bone (node-pair) lengths used as the size signature. Pairs whose nodes the
 *  session skeleton lacks are skipped. */
export const SIZE_BONES = [
    ['Ear_L', 'Ear_R'], ['Nose', 'Ear_L'], ['Nose', 'Ear_R'], ['Nose', 'Head'], ['Head', 'Neck'],
    ['Neck', 'Trunk'], ['Trunk', 'TTI'], ['Shoulder_left', 'Shoulder_right'], ['Haunch_left', 'Haunch_right'],
    ['TTI', 'Haunch_left'], ['TTI', 'Haunch_right'], ['TTI', 'Tail_0'], ['Tail_0', 'Tail_1'],
    ['Tail_1', 'Tail_2'], ['Tail_2', 'TailTip'], ['Nose', 'TTI'],
];

/** Sample rate (Hz) the score scale and the size threshold were calibrated at. */
export const REFERENCE_HZ = 15;

/** Options shared by both checks. */
export const SIZE_CHECK_DEFAULTS = {
    fps: null,          // REQUIRED: the recording's frame rate
    sampleHz: 15,       // encounter grid: analyse ~this many frames per second (every round(fps / sampleHz)-th)
    folds: 5,           // blocked cross-validation folds over time
    gapSeconds: 10,     // excluded either side of a test fold
    syncSeconds: 1,     // both animals must resume their own tracklets within this of each other
    threshold: -50,     // a run of flagged encounters STARTS at an encounter scoring below this...
    continueBelow: 0,   // ...and continues while the pair's next encounters still score below this
                        // (hysteresis: a persisting switch keeps scoring negative, if not always < -50)
    followSeconds: 60,  // a change point this soon after one sharing an identity is its follow-on
    minTrackedSeconds: 60, // refuse with less tracked data than this: the model can't be learned reliably
    sepFactor: 0.65,    // "close" = centroids nearer than sepFactor x median body extent
    sepDistance: null,  // override the close distance directly (world units)
    maxTrainRows: 20000,
    iterations: 300,
    signal: null,       // AbortSignal: the check throws an AbortError when it fires
};

/** Image-check options on top of the shared ones. Threshold: see the calibration notes in MODULES.md. */
export const IMAGE_CHECK_DEFAULTS = Object.assign({}, SIZE_CHECK_DEFAULTS, {
    imageHz: 2,         // crops per second per identity (on the encounter grid)
    threshold: -25,     // image-score threshold, calibrated 2026-10-03 (see MODULES.md): on the 5-mouse
                        // recording 18 false change points / 30 min (size at -50: 7) and the real switch
                        // caught (image score -46); -50 misses it and still gives 15
    pcaDims: 32,        // embeddings are reduced to this many dimensions per camera before the classifier
    maxTrainRows: 6000,
    iterations: 200,
    getEmbeddings: null,   // REQUIRED: async (frame, items[{k, group}]) -> per item [{camera, vector}];
                           // STARTED in increasing frame order, at most `inFlight` in flight
    inFlight: 2,           // requests kept in flight (ui/image-embedder.js asks for 8, to batch frames)
    prepareFrames: null,   // optional: async (frames[]) — every frame getEmbeddings will be asked for, in order
    releaseFrames: null,   // optional: () — called when done (or cancelled)
});

const isTailNode = function (name) { return /^tail/i.test(name); };

function throwIfAborted(signal) {
    if (signal && signal.aborted) {
        var e = new Error('Cancelled'); e.name = 'AbortError'; throw e;
    }
}

/**
 * Multinomial logistic regression (softmax), L2-regularised, full-batch Adam.
 * Features are standardised with the training rows' mean / SD.
 * @returns {{logProba: function(Float64Array): Float64Array}}
 */
export function fitSoftmax(X, y, nRows, D, K, opts) {
    opts = opts || {};
    var iters = opts.iterations || 300, lr = opts.lr || 0.05, l2 = opts.l2 != null ? opts.l2 : 1e-3;
    var mean = new Float64Array(D), sd = new Float64Array(D);
    for (var r = 0; r < nRows; r++) for (var d = 0; d < D; d++) mean[d] += X[r * D + d];
    for (var d2 = 0; d2 < D; d2++) mean[d2] /= Math.max(1, nRows);
    for (var r2 = 0; r2 < nRows; r2++) for (var d3 = 0; d3 < D; d3++) { var t = X[r2 * D + d3] - mean[d3]; sd[d3] += t * t; }
    for (var d4 = 0; d4 < D; d4++) sd[d4] = Math.sqrt(sd[d4] / Math.max(1, nRows)) || 1;
    var Z = new Float64Array(nRows * D);
    for (var r3 = 0; r3 < nRows; r3++) for (var d5 = 0; d5 < D; d5++) Z[r3 * D + d5] = (X[r3 * D + d5] - mean[d5]) / sd[d5];

    var P = (D + 1) * K;                     // weights + bias per class
    var W = new Float64Array(P), m = new Float64Array(P), v = new Float64Array(P), g = new Float64Array(P);
    var logits = new Float64Array(K);
    for (var it = 1; it <= iters; it++) {
        g.fill(0);
        for (var r4 = 0; r4 < nRows; r4++) {
            var mx = -Infinity;
            for (var k = 0; k < K; k++) {
                var s = W[D * K + k];
                for (var d6 = 0; d6 < D; d6++) s += Z[r4 * D + d6] * W[d6 * K + k];
                logits[k] = s; if (s > mx) mx = s;
            }
            var sum = 0;
            for (var k2 = 0; k2 < K; k2++) { logits[k2] = Math.exp(logits[k2] - mx); sum += logits[k2]; }
            for (var k3 = 0; k3 < K; k3++) {
                var err = logits[k3] / sum - (y[r4] === k3 ? 1 : 0);
                for (var d7 = 0; d7 < D; d7++) g[d7 * K + k3] += err * Z[r4 * D + d7];
                g[D * K + k3] += err;
            }
        }
        for (var p = 0; p < P; p++) {
            var gp = g[p] / nRows + (p < D * K ? l2 * W[p] : 0);
            m[p] = 0.9 * m[p] + 0.1 * gp; v[p] = 0.999 * v[p] + 0.001 * gp * gp;
            W[p] -= lr * (m[p] / (1 - Math.pow(0.9, it))) / (Math.sqrt(v[p] / (1 - Math.pow(0.999, it))) + 1e-8);
        }
    }
    return {
        logProba: function (x) {
            var out = new Float64Array(K), mx2 = -Infinity;
            for (var k4 = 0; k4 < K; k4++) {
                var s2 = W[D * K + k4];
                for (var d8 = 0; d8 < D; d8++) s2 += ((x[d8] - mean[d8]) / sd[d8]) * W[d8 * K + k4];
                out[k4] = s2; if (s2 > mx2) mx2 = s2;
            }
            var lse = 0;
            for (var k5 = 0; k5 < K; k5++) lse += Math.exp(out[k5] - mx2);
            lse = mx2 + Math.log(lse);
            for (var k6 = 0; k6 < K; k6++) out[k6] = Math.max(out[k6] - lse, -30);
            return out;
        },
    };
}

/**
 * PCA by randomized subspace iteration (deterministic seed): the top `k`
 * principal directions of n x D rows. @returns {{project(x): Float64Array}}
 */
export function fitPCA(X, n, D, k, opts) {
    opts = opts || {};
    k = Math.min(k, D, Math.max(1, n - 1));
    var mean = new Float64Array(D);
    for (var r = 0; r < n; r++) for (var d = 0; d < D; d++) mean[d] += X[r * D + d];
    for (var d1 = 0; d1 < D; d1++) mean[d1] /= Math.max(1, n);
    var seed = 12345, rnd = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
    var Q = new Float64Array(D * k);
    for (var i = 0; i < Q.length; i++) Q[i] = rnd();
    var Y = new Float64Array(n * k), Z = new Float64Array(D * k), row = new Float64Array(D);
    var orth = function (M) {                        // modified Gram-Schmidt on the k columns of D x k M
        for (var c = 0; c < k; c++) {
            for (var c2 = 0; c2 < c; c2++) {
                var dot = 0; for (var d2 = 0; d2 < D; d2++) dot += M[d2 * k + c] * M[d2 * k + c2];
                for (var d3 = 0; d3 < D; d3++) M[d3 * k + c] -= dot * M[d3 * k + c2];
            }
            var nn = 0; for (var d4 = 0; d4 < D; d4++) nn += M[d4 * k + c] * M[d4 * k + c];
            nn = Math.sqrt(nn) || 1; for (var d5 = 0; d5 < D; d5++) M[d5 * k + c] /= nn;
        }
    };
    orth(Q);
    for (var it = 0; it < (opts.iterations || 6); it++) {
        Y.fill(0); Z.fill(0);
        for (var r2 = 0; r2 < n; r2++) {             // Y = (X - mean) Q
            for (var d6 = 0; d6 < D; d6++) row[d6] = X[r2 * D + d6] - mean[d6];
            for (var c3 = 0; c3 < k; c3++) { var s = 0; for (var d7 = 0; d7 < D; d7++) s += row[d7] * Q[d7 * k + c3]; Y[r2 * k + c3] = s; }
            for (var d8 = 0; d8 < D; d8++) { var xv = row[d8]; if (!xv) continue; for (var c4 = 0; c4 < k; c4++) Z[d8 * k + c4] += xv * Y[r2 * k + c4]; }
        }
        orth(Z); Q.set(Z);                           // Q <- orth((X - mean)^T (X - mean) Q)
    }
    return {
        dims: k,
        project: function (x) {
            var out = new Float64Array(k);
            for (var c5 = 0; c5 < k; c5++) { var s3 = 0; for (var d9 = 0; d9 < D; d9++) s3 += (x[d9] - mean[d9]) * Q[d9 * k + c5]; out[c5] = s3; }
            return out;
        },
    };
}

function median(arr) {
    if (!arr.length) return NaN;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var h = s.length >> 1;
    return s.length % 2 ? s[h] : 0.5 * (s[h - 1] + s[h]);
}

// ---------------------------------------------------------------------------
// Shared machinery
// ---------------------------------------------------------------------------

/**
 * Sample the session on the encounter grid and find tracklets + encounters.
 * Also reads the size signature (needed by the size check, cheap for both).
 * @returns {object} grid, or {fail: reason}
 */
function buildGrid(session, o, needSize) {
    if (!(typeof o.fps === 'number' && isFinite(o.fps) && o.fps > 0)) return { fail: 'Unknown frame rate (set the fps)' };
    if (!(o.sampleHz > 0)) return { fail: 'sampleHz must be positive' };
    var step = Math.max(1, Math.round(o.fps / o.sampleHz));
    var hz = o.fps / step;
    var secToSamples = function (sec) { return Math.max(1, Math.ceil(sec * hz)); };
    if (!session || !session.instanceGroups || !session.skeleton) return { fail: 'No tracked session' };
    var nodes = (session.skeleton.nodes || []).map(function (n) { return typeof n === 'string' ? n : n && n.name; });
    var nodeIdx = new Map(nodes.map(function (n, i) { return [n, i]; }));
    var bones = SIZE_BONES.filter(function (b) { return nodeIdx.has(b[0]) && nodeIdx.has(b[1]); });
    if (needSize && bones.length < 4) return { fail: 'The skeleton has too few of the size nodes (need at least 4 of: ' +
        SIZE_BONES.map(function (b) { return b.join('–'); }).join(', ') + ')' };
    var B = bones.length;
    var boneIdx = bones.map(function (b) { return [nodeIdx.get(b[0]), nodeIdx.get(b[1])]; });
    var bodyNodes = nodes.map(function (n, i) { return i; }).filter(function (i) { return nodes[i] && !isTailNode(nodes[i]); });

    var idents = session.identities || [];
    var kOf = new Map(idents.map(function (id, i) { return [id.id, i]; }));
    var K = idents.length;
    if (K < 2) return { fail: 'Need at least 2 identities — run Track All first' };

    var frames = [];
    for (var f of session.instanceGroups.keys()) if (f % step === 0) frames.push(f);
    frames.sort(function (a, b) { return a - b; });
    var T = frames.length;
    var trackedSec = T / hz;
    if (T < 20 || trackedSec < o.minTrackedSeconds) {
        return { fail: 'needs at least ' + o.minTrackedSeconds + ' s of tracking to learn the animals (has ' +
            (trackedSec < 10 ? trackedSec.toFixed(1) : Math.round(trackedSec)) + ' s)' };
    }
    var X = new Float64Array(T * K * Math.max(B, 1)).fill(NaN), C = new Float64Array(T * K * 3).fill(NaN);
    var G = new Array(T * K).fill(null);      // the InstanceGroup behind each (sample, identity)
    var p = [0, 0, 0], q = [0, 0, 0], extents = [];
    for (var i = 0; i < T; i++) {
        var groups = session.instanceGroups.get(frames[i]) || [];
        var seen = new Set();
        for (var gi = 0; gi < groups.length; gi++) {
            var g = groups[gi], k = kOf.get(g.identityId);
            if (k == null || !g.points3d) continue;
            if (seen.has(k)) {                          // duplicate identity this frame: ambiguous
                for (var c0 = 0; c0 < 3; c0++) C[(i * K + k) * 3 + c0] = NaN;
                G[i * K + k] = null; continue;
            }
            seen.add(k); G[i * K + k] = g;
            var P3 = g.points3d;
            for (var b = 0; b < B; b++) {
                if (readPoint3d(P3, boneIdx[b][0], p) && readPoint3d(P3, boneIdx[b][1], q)) {
                    X[(i * K + k) * B + b] = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
                }
            }
            var sx = 0, sy = 0, sz = 0, n = 0, pts = [];
            for (var bn = 0; bn < bodyNodes.length; bn++) {
                if (readPoint3d(P3, bodyNodes[bn], p)) { sx += p[0]; sy += p[1]; sz += p[2]; n++; pts.push([p[0], p[1], p[2]]); }
            }
            if (n) {
                C[(i * K + k) * 3] = sx / n; C[(i * K + k) * 3 + 1] = sy / n; C[(i * K + k) * 3 + 2] = sz / n;
                if (i % 7 === 0 && pts.length >= 2) {           // body extent, sampled sparsely
                    var ext = 0;
                    for (var a1 = 0; a1 < pts.length; a1++) for (var a2 = a1 + 1; a2 < pts.length; a2++) {
                        var e = Math.hypot(pts[a1][0] - pts[a2][0], pts[a1][1] - pts[a2][1], pts[a1][2] - pts[a2][2]);
                        if (e > ext) ext = e;
                    }
                    extents.push(ext);
                }
            }
        }
    }
    var sep = o.sepDistance != null ? o.sepDistance : o.sepFactor * median(extents);
    if (!isFinite(sep)) return { fail: 'Could not estimate body size from the triangulated skeletons' };
    var hasCen = function (i, k) { return isFinite(C[(i * K + k) * 3]); };
    var dist = function (i, a, b) {
        if (!hasCen(i, a) || !hasCen(i, b)) return Infinity;
        var r1 = (i * K + a) * 3, r2 = (i * K + b) * 3;
        return Math.hypot(C[r1] - C[r2], C[r1 + 1] - C[r2 + 1], C[r1 + 2] - C[r2 + 2]);
    };

    // tracklets: runs where identity k is visible and apart from every other identity
    var tl = [];   // {k, start, end}  (inclusive sample indices)
    for (var k1 = 0; k1 < K; k1++) {
        var s0 = -1;
        for (var i2 = 0; i2 <= T; i2++) {
            var ok = false;
            if (i2 < T && hasCen(i2, k1)) {
                ok = true;
                for (var j = 0; j < K; j++) if (j !== k1 && dist(i2, k1, j) <= sep) { ok = false; break; }
            }
            if (ok && s0 < 0) s0 = i2;
            if (!ok && s0 >= 0) { tl.push({ k: k1, start: s0, end: i2 - 1 }); s0 = -1; }
        }
    }
    var nextTl = function (k, e) {
        var best = null;
        for (var t = 0; t < tl.length; t++) if (tl[t].k === k && tl[t].start > e && (!best || tl[t].start < best.start)) best = tl[t];
        return best;
    };
    // encounters: last close sample of each close spell, per identity pair
    var enc = [], seenPair = new Set();
    for (var a = 0; a < K; a++) for (var bb = a + 1; bb < K; bb++) {
        var startClose = -1;
        for (var i3 = 0; i3 < T; i3++) {
            var close = dist(i3, a, bb) < sep;
            if (close && startClose < 0) startClose = i3;
            if (close && (i3 + 1 === T || !(dist(i3 + 1, a, bb) < sep))) {
                var ta = nextTl(a, i3), tb = nextTl(bb, i3);
                if (ta && tb && Math.abs(ta.start - tb.start) <= secToSamples(o.syncSeconds)) {
                    var key = tl.indexOf(ta) + ':' + tl.indexOf(tb);
                    if (!seenPair.has(key)) { seenPair.add(key); enc.push({ a: a, b: bb, start: startClose, end: i3, ta: ta, tb: tb }); }
                }
                startClose = -1;
            }
        }
    }
    return { T: T, K: K, B: B, X: X, C: C, G: G, frames: frames, idents: idents, bones: bones, sep: sep,
             step: step, hz: hz, secToSamples: secToSamples, tl: tl, enc: enc, hasCen: hasCen };
}

/**
 * Blocked cross-validation: for each fold, `fit(trainRows)` returns a model with
 * `logProba(row)` (or null to skip the fold), applied to the fold's rows.
 * Rows are (sample * K + identity) indices; `present(row)` says which have
 * evidence. Writes class log-probabilities into LP (rows x K) and returns it.
 */
async function blockedCV(grid, o, present, fit, LP, progress) {
    var T = grid.T, K = grid.K, gap = grid.secToSamples(o.gapSeconds), edges = [];
    for (var fo = 0; fo <= o.folds; fo++) edges.push(Math.round(fo * T / o.folds));
    for (var fo2 = 0; fo2 < o.folds; fo2++) {
        throwIfAborted(o.signal);
        if (progress) await progress(fo2, o.folds);
        var lo = edges[fo2], hi = edges[fo2 + 1], rows = [];
        for (var i = 0; i < T; i++) {
            if (i >= lo - gap && i < hi + gap) continue;
            for (var k = 0; k < K; k++) if (present(i * K + k)) rows.push(i * K + k);
        }
        if (rows.length < 20) continue;
        var model = fit(rows);
        if (!model) continue;
        for (var i2 = lo; i2 < hi; i2++) for (var k2 = 0; k2 < K; k2++) {
            var row = i2 * K + k2;
            if (present(row)) LP.set(model.logProba(row), row * K);
        }
    }
    return LP;
}

/** Fit a softmax on (a stride-subsample of) `rows`, features from `feat(row)` (length D). */
function fitRows(rows, D, K, o, feat) {
    var stride = Math.max(1, Math.ceil(rows.length / o.maxTrainRows)), use = [];
    for (var r = 0; r < rows.length; r += stride) use.push(rows[r]);
    var Xt = new Float64Array(use.length * D), yt = new Int32Array(use.length), classes = new Set();
    for (var u = 0; u < use.length; u++) { Xt.set(feat(use[u]), u * D); yt[u] = use[u] % K; classes.add(yt[u]); }
    if (classes.size < K) return null;
    return fitSoftmax(Xt, yt, use.length, D, K, { iterations: o.iterations });
}

/**
 * Within-frame contrast, encounter scores and change points (shared by both checks).
 * `present(i, k)` = evidence exists; `weight` = per-sample weight (REFERENCE_HZ / cue Hz).
 */
function finish(grid, LP, present, weight, o, extra) {
    var T = grid.T, K = grid.K, idents = grid.idents, frames = grid.frames;
    // within-frame contrast: for each class, normalise over the identities PRESENT in that frame,
    // so anything that shifts every animal's evidence in a frame cancels out.
    for (var i6 = 0; i6 < T; i6++) for (var c = 0; c < K; c++) {
        var mx = -Infinity, ks = [];
        for (var k6 = 0; k6 < K; k6++) if (present(i6, k6)) { ks.push(k6); mx = Math.max(mx, LP[(i6 * K + k6) * K + c]); }
        if (!ks.length) continue;
        var lse = 0;
        for (var z = 0; z < ks.length; z++) lse += Math.exp(LP[(i6 * K + ks[z]) * K + c] - mx);
        lse = mx + Math.log(lse);
        for (var z2 = 0; z2 < ks.length; z2++) LP[(i6 * K + ks[z2]) * K + c] -= lse;
    }
    var sumTl = function (t, cls) {
        var s = 0;
        for (var i7 = t.start; i7 <= t.end; i7++) if (present(i7, t.k)) s += LP[(i7 * K + t.k) * K + cls];
        return s * weight;
    };
    var scored = grid.enc.map(function (e) {
        var S = (sumTl(e.ta, e.a) + sumTl(e.tb, e.b)) - (sumTl(e.ta, e.b) + sumTl(e.tb, e.a));
        return { frame: frames[e.end], startFrame: frames[e.start], identityA: idents[e.a].id, identityB: idents[e.b].id,
                 nameA: idents[e.a].name, nameB: idents[e.b].name, score: S };
    }).sort(function (x, y) { return x.frame - y.frame; });
    var changes = markChangePoints(scored, o);
    return Object.assign({
        ok: true, flags: scored.filter(function (s) { return s.flagged; }), changes: changes, encounters: scored,
        identities: idents.map(function (id) { return id.name; }),
        sampledFrames: T, closeDistance: grid.sep, threshold: o.threshold,
        fps: o.fps, step: grid.step, sampleHz: grid.hz,
    }, extra || {});
}

/**
 * Mark change points on scored encounters (mutates them: `flagged`,
 * `continues`, `kind`, `followOf`) and return the `kind: 'end'` change points.
 * Exported so the threshold can be re-applied to the same scores (calibration)
 * without re-running a check. `o` needs threshold, continueBelow, followSeconds, fps.
 * @param {Array} scored  encounters sorted by frame
 */
export function markChangePoints(scored, o) {
    scored.forEach(function (sc) { delete sc.kind; delete sc.followOf; delete sc.switchBackAt; });
    // The model learns from the tracker's labels, so it can tell that the labelling on the two sides
    // of an encounter disagrees, not which side is right: whichever side covers MORE of the session
    // reads as "correct". Mark the CHANGE POINT of each run of flagged encounters per pair:
    //   run reaches the session end             -> its start is the switch onset (kind 'onset')
    //   run starts at the pair's first encounter -> the next, unflagged encounter is where the
    //                                               labelling changes (kind 'end')
    //   run of 2+ in the middle                 -> both (switch at its start, switch back after it)
    //   a lone flag in the middle               -> that encounter only
    // Every other flagged encounter in a run is a repeat (`continues`). Runs use hysteresis (see
    // `continueBelow`) so one mildly-negative encounter inside a persisting switch doesn't split it.
    var changes = [], byPair = new Map();
    scored.forEach(function (sc) {
        sc.flagged = false; sc.continues = false;
        var key = sc.identityA + ':' + sc.identityB;
        if (!byPair.has(key)) byPair.set(key, []);
        byPair.get(key).push(sc);
    });
    byPair.forEach(function (L) {
        // hysteresis: a run starts below `threshold` and extends FORWARD while scores stay below
        // `continueBelow`. (Not backward: that would move an onset onto weaker evidence before it.)
        for (var n0 = 0; n0 < L.length; n0++) {
            if (L[n0].score >= o.threshold || L[n0].flagged) continue;
            for (var up = n0; up < L.length && L[up].score < o.continueBelow; up++) L[up].flagged = true;
        }
        for (var n = 0; n < L.length; n++) {
            if (!L[n].flagged || (n > 0 && L[n - 1].flagged)) continue;
            var m2 = n; while (m2 + 1 < L.length && L[m2 + 1].flagged) m2++;
            var atStart = n === 0, atEnd = m2 === L.length - 1;
            for (var r6 = n; r6 <= m2; r6++) L[r6].continues = r6 > n || (atStart && !atEnd);
            // Each change point also names the OTHER edge of its swapped stretch, which is what fixing it
            // swaps (ui/id-switch-modal.js): an onset, the encounter after the run where the labels look
            // right again (`switchBackAt`, null when the run reaches the session end); an 'end', the run's
            // first encounter (`switchedAt`, null when the run starts the session — swapped from frame 0).
            if (!atEnd && (atStart || m2 > n)) changes.push(Object.assign({}, L[m2 + 1], { kind: 'end', continues: false,
                switchedAt: atStart ? null : L[n].frame }));
            if (!(atStart && !atEnd)) { L[n].kind = 'onset'; L[n].switchBackAt = atEnd ? null : L[m2 + 1].frame; }
            n = m2;
        }
    });
    changes.sort(function (x, y) { return x.frame - y.frame; });
    // Follow-ons: after a switch, each swapped identity carries the wrong label into its encounters
    // with OTHER animals too, so those surface as change points of their own. Link a change point to
    // an earlier one (of a different pair) that shares an identity and lies within `followSeconds`.
    var primary = scored.filter(function (x) { return x.kind === 'onset'; }).concat(changes)
        .sort(function (x, y) { return x.frame - y.frame; });
    for (var pi = 0; pi < primary.length; pi++) {
        var cur = primary[pi];
        for (var pj = pi - 1; pj >= 0; pj--) {
            var prev = primary[pj];
            if (cur.frame - prev.frame > o.followSeconds * o.fps) break;
            if (prev.followOf != null) continue;
            var sameIds = [prev.identityA, prev.identityB].filter(function (id) { return id === cur.identityA || id === cur.identityB; });
            if (sameIds.length === 1) { cur.followOf = prev.frame; break; }
        }
    }
    return changes;
}

function failure(reason) { return { ok: false, reason: reason, flags: [], changes: [], encounters: [] }; }

// ---------------------------------------------------------------------------
// The two checks
// ---------------------------------------------------------------------------

/**
 * Body-size check: score every close encounter by 3D bone lengths, and flag the
 * ones whose post-encounter size evidence favours the swapped labelling.
 *
 * Async only so a caller can keep the page painting: `opts.onProgress(done, total)`
 * is awaited between cross-validation folds (the bulk of the ~8 s a 30-minute,
 * 5-animal recording takes).
 *
 * @param {Session} session  needs `instanceGroups` (frame -> groups with
 *        `identityId` + flat `points3d`), `identities`, `skeleton.nodes`.
 * @param {object} opts      see SIZE_CHECK_DEFAULTS; `fps` is required. Plus `onProgress`.
 * @returns {Promise<object>} {ok, flags, changes, encounters, identities, bones,
 *   sampledFrames, closeDistance, threshold, fps, step, sampleHz} or {ok:false, reason}.
 *   `encounters` entries: { frame, startFrame, identityA, identityB, nameA, nameB,
 *   score, flagged, continues, kind?, followOf? } — `frame` is the last close frame
 *   of the encounter. `flags` = the flagged encounters; a persistent switch makes
 *   every encounter of that pair on one side of it look swapped, so a flagged run
 *   has one change point (`kind: 'onset'`) and its other members are repeats
 *   (`continues: true`). When the run covers the START of the session, the change
 *   point is the first UNflagged encounter after it, returned in `changes`
 *   (`kind: 'end'`, not itself flagged). Markers to show = `flags` + `changes`.
 *   A change point with `followOf: <frame>` is a follow-on of the switch at that
 *   frame (a swapped identity's next encounter with a third animal). An onset
 *   carries `switchBackAt` (the frame of the encounter after its run, or null
 *   when the run reaches the session end); an 'end' carries `switchedAt` (the run's first
 *   encounter, or null when the run starts the session).
 */
export async function checkSizeSwitches(session, opts) {
    var o = Object.assign({}, SIZE_CHECK_DEFAULTS, opts || {});
    var grid = buildGrid(session, o, true);
    if (grid.fail) return failure(grid.fail);
    var T = grid.T, K = grid.K, B = grid.B, X = grid.X;
    var present = function (row) {
        for (var b = 0; b < B; b++) if (!isFinite(X[row * B + b])) return false;
        return true;
    };
    var LP = new Float64Array(T * K * K);
    await blockedCV(grid, o, present, function (rows) {
        var model = fitRows(rows, B, K, o, function (row) { return X.subarray(row * B, (row + 1) * B); });
        return model && { logProba: function (row) { return model.logProba(X.subarray(row * B, (row + 1) * B)); } };
    }, LP, o.onProgress);
    var res = finish(grid, LP, function (i, k) { return present(i * K + k); }, REFERENCE_HZ / grid.hz, o,
        { bones: grid.bones.map(function (b) { return b.join('–'); }), cue: 'size' });
    if (o.onProgress) await o.onProgress(o.folds, o.folds);
    return res;
}

/**
 * How much sparser than the samples keyframes may be and still count as dense.
 * The sample spacing comes from integer rounding (every round(fps / sampleHz)-th
 * frame, every round(sampleHz / imageHz)-th of those), so it is a little under
 * 0.5 s at many frame rates — 49 frames at 100 fps, 24 at 50 — and a recorder set
 * to a keyframe every 0.5 s (`-g fps/2`) would otherwise just miss it. 1.1 covers
 * every frame rate up to 240 (worst: 119 vs 112 frames at 239 fps).
 */
export const KEYFRAME_GAP_TOLERANCE = 1.1;

/**
 * Which frame to DECODE for each image sample in one camera, given that camera's
 * keyframes. Decoding a frame costs every frame since its keyframe (P-frames
 * depend on the one before), so on recordings with a keyframe every 250 frames
 * the image samples (~2/s) still cost every frame of every camera. When the
 * keyframes are about as dense as the samples (median keyframe gap G <=
 * KEYFRAME_GAP_TOLERANCE x the median sample spacing S), each sample is moved to
 * its nearest keyframe that is at most floor(max(S, G) / 2) frames away and has
 * tracking (`hasFrame`), so it decodes as ONE frame. Moved samples stay strictly
 * increasing (two samples never share a keyframe); a sample with no such
 * keyframe keeps its own frame (decoded from its keyframe, as before). Sparser
 * keyframes leave every sample where it is — today's decoding exactly.
 * The encounter grid is untouched: the sample's evidence still counts at its
 * grid frame, only the picture (and the keypoints it is cropped with) come from
 * up to half a gap away — 0.25 s with a keyframe every 0.5 s.
 * @param {number[]} frames      requested sample frames, increasing
 * @param {?ArrayLike<number>} keyframes  this camera's keyframe indices, increasing (null = unknown)
 * @param {function(number): boolean} [hasFrame]  can a sample move to this frame? (default: any)
 * @returns {{decode: number[], snapped: number, spacing: number, keyframeGap: number, maxShift: number}}
 *   decode[i] = the frame to decode for frames[i]; snapped = how many moved (0 = sparse/unknown)
 */
export function planKeyframeSamples(frames, keyframes, hasFrame) {
    var decode = frames.slice(), n = frames.length;
    var medianGap = function (a) {
        var d = [];
        for (var i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]);
        return d.length ? median(d) : Infinity;
    };
    var spacing = medianGap(frames), kfGap = keyframes && keyframes.length >= 2 ? medianGap(keyframes) : Infinity;
    var plan = { decode: decode, snapped: 0, spacing: spacing, keyframeGap: kfGap, maxShift: 0 };
    if (!(n >= 2 && isFinite(spacing) && kfGap <= KEYFRAME_GAP_TOLERANCE * spacing)) return plan;
    var maxShift = plan.maxShift = Math.floor(Math.max(spacing, kfGap) / 2);
    var ok = hasFrame || function () { return true; };
    var j = 0, last = -Infinity;
    for (var s = 0; s < n; s++) {
        var f = frames[s];
        while (j < keyframes.length && keyframes[j] < f - maxShift) j++;
        var best = -1;
        for (var q = j; q < keyframes.length && keyframes[q] <= f + maxShift; q++) {
            var kf = keyframes[q];
            if (kf <= last || !ok(kf)) continue;
            if (best < 0 || Math.abs(kf - f) < Math.abs(best - f)) best = kf;
        }
        if (best >= 0) { decode[s] = best; plan.snapped++; }
        last = Math.max(last, decode[s]);
    }
    return plan;
}

/**
 * Image check: score every close encounter by appearance. On every
 * round(sampleHz / imageHz)-th grid sample, `opts.getEmbeddings(frame, items)` is
 * awaited for the identities present (`items` = [{k, group}]) and returns, per
 * item, the crops' embeddings as [{camera, vector}] (any length; [] = not
 * visible). A classifier per camera (PCA to `pcaDims`, then softmax) is trained
 * on the tracker's own labels with blocked CV; a sample's evidence is the mean of
 * its cameras' log-probabilities. Everything after that is shared with the size
 * check, with image samples weighted by REFERENCE_HZ / imageHz.
 *
 * `opts.onProgress(stage, done, total)` is awaited with stage 'embed' (per
 * sampled frame) and 'fit' (per fold). `opts.signal` cancels.
 *
 * @returns {Promise<object>} as checkSizeSwitches, plus {imageHz, crops, cameras}.
 */
export async function checkImageSwitches(session, opts) {
    var o = Object.assign({}, IMAGE_CHECK_DEFAULTS, opts || {});
    if (typeof o.getEmbeddings !== 'function') return failure('No image embedder available');
    var grid = buildGrid(session, o, false);
    if (grid.fail) return failure(grid.fail);
    var T = grid.T, K = grid.K;
    var every = Math.max(1, Math.round(grid.hz / o.imageHz)), imgHz = grid.hz / every;
    var progress = o.onProgress || null;

    // ---- embeddings at the image samples, grouped by camera
    var perCam = new Map();   // camera -> {rows: [], vecs: []}
    var crops = 0, jobs = [];
    for (var i = 0; i < T; i += every) {
        var items = [];
        for (var k = 0; k < K; k++) if (grid.G[i * K + k] && grid.hasCen(i, k)) items.push({ k: k, group: grid.G[i * K + k] });
        if (items.length >= 2) jobs.push({ i: i, frame: grid.frames[i], items: items });
    }
    // The provider may stream the frames in order instead of seeking to each one
    // (`prepareFrames`), and up to `inFlight` requests (default 2) run ahead of the
    // one being consumed — requests are STARTED in frame order, so a streaming
    // provider still sees increasing frames — letting decode/crop of later frames
    // overlap embedding (a provider can then batch several frames per model run).
    if (typeof o.prepareFrames === 'function') await o.prepareFrames(jobs.map(function (j) { return j.frame; }));
    try {
        var ahead = Math.max(1, Math.floor(o.inFlight || 2));
        var start = function (j) { var p = o.getEmbeddings(jobs[j].frame, jobs[j].items); p.catch(function () {}); return p; };   // surfaced when awaited
        var pending = [], launched = 0;
        var fill = function () { while (launched < jobs.length && pending.length < ahead) pending.push(start(launched++)); };
        fill();
        for (var ji = 0; ji < jobs.length; ji++) {
            throwIfAborted(o.signal);
            var embs = await pending.shift();
            fill();
            var job = jobs[ji];
            for (var it = 0; it < job.items.length; it++) {
                var list = (embs && embs[it]) || [];
                for (var e = 0; e < list.length; e++) {
                    var cam = list[e].camera;
                    if (!perCam.has(cam)) perCam.set(cam, { rows: [], vecs: [] });
                    perCam.get(cam).rows.push(job.i * K + job.items[it].k); perCam.get(cam).vecs.push(list[e].vector); crops++;
                }
            }
            if (progress && (ji % 5 === 0 || ji === jobs.length - 1)) await progress('embed', ji + 1, jobs.length);
        }
    } finally {
        if (typeof o.releaseFrames === 'function') o.releaseFrames();
    }
    if (!crops) return failure('No crops could be embedded');

    // ---- per-camera blocked-CV classifiers -> mean log-probabilities per (sample, identity)
    var LP = new Float64Array(T * K * K), n = new Float64Array(T * K);
    var cams = Array.from(perCam.keys()), camIdx = 0;
    for (var cam2 of cams) {
        var data = perCam.get(cam2), D = data.vecs[0].length, byRow = new Map();
        data.rows.forEach(function (row, idx) { byRow.set(row, idx); });
        var camLP = new Float64Array(T * K * K), has = function (row) { return byRow.has(row); };
        await blockedCV(grid, o, has, function (rows) {
            var stride = Math.max(1, Math.ceil(rows.length / o.maxTrainRows)), use = [];
            for (var r = 0; r < rows.length; r += stride) use.push(rows[r]);
            var Xr = new Float64Array(use.length * D);
            use.forEach(function (row, u) { Xr.set(data.vecs[byRow.get(row)], u * D); });
            var pca = fitPCA(Xr, use.length, D, o.pcaDims);
            var proj = new Map(); use.forEach(function (row, u) { proj.set(row, pca.project(Xr.subarray(u * D, (u + 1) * D))); });
            var model = fitRows(use, pca.dims, K, o, function (row) { return proj.get(row); });
            return model && { logProba: function (row) { return model.logProba(pca.project(data.vecs[byRow.get(row)])); } };
        }, camLP, progress ? function (d, t) { return progress('fit', camIdx * o.folds + d, cams.length * o.folds); } : null);
        for (var row2 = 0; row2 < T * K; row2++) {
            if (!has(row2)) continue;
            var any = false;
            for (var c2 = 0; c2 < K; c2++) if (camLP[row2 * K + c2] !== 0) { any = true; break; }
            if (!any) continue;                            // fold skipped for this camera
            for (var c3 = 0; c3 < K; c3++) LP[row2 * K + c3] += camLP[row2 * K + c3];
            n[row2]++;
        }
        camIdx++;
    }
    for (var row3 = 0; row3 < T * K; row3++) if (n[row3] > 1) for (var c4 = 0; c4 < K; c4++) LP[row3 * K + c4] /= n[row3];
    var res = finish(grid, LP, function (i2, k2) { return n[i2 * K + k2] > 0; }, REFERENCE_HZ / imgHz, o,
        { cue: 'image', imageHz: imgHz, crops: crops, cameras: cams });
    if (progress) await progress('fit', cams.length * o.folds, cams.length * o.folds);
    return res;
}
