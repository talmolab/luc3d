/**
 * id-switch-check.js — flag possible identity switches after tracking, from
 * body size and/or appearance (images).
 *
 * A tracker can only hand an identity to a different animal when two animals
 * come close (or one drops out). So instead of judging every frame, this looks
 * at each CONTACT between two identities and asks: does each animal look like
 * ITSELF across it, or like the other one did before it? Two kinds of evidence
 * answer that, through ONE pipeline (`scoreContacts`):
 *
 *   - checkSizeSwitches  — 3D bone lengths read off each identity's
 *     triangulated skeleton. Cheap, no video.
 *   - checkImageSwitches — embeddings of masked, pose-aligned crops of each
 *     identity in every camera (supplied by the caller's `getEmbeddings`; the app
 *     uses DINOv2-small in the browser, ui/image-embedder.js). Slow; catches
 *     animals of the same size that look different (coat colour, markings).
 *
 * A third check, checkBrightnessSwitches (coat brightness at the body keypoints,
 * single camera — see pose/single-camera-tracking.js), still scores the old way:
 * a classifier fitted to the tracker's labels, plus candidate moments tested on
 * both sides (`finish`, at the end of this file). It was calibrated on that.
 *
 * Neither learns from the tracker's identity labels across a contact. Both
 * checks used to: a classifier trained on the tracker's labels, flagging
 * encounters whose aftermath it disagreed with — which assumes a real switch
 * leaves a minority. When a pair swaps several times no labelling is the
 * majority (measured 2026-10-09 on a CD1 recording: the plain mouse wore id_0
 * for 36% of 15 minutes and id_1 for 50%), and the classifier learns nothing
 * about which is which: on 8 proofread or tail-marked recordings the image
 * classifier caught 5 of 12 real relabels with 98 false rows, the size one 4 of
 * 12 with 50. Instead, what tells the animals apart is learned from two facts
 * that hold however wrong the tracking is — an animal apart from the others
 * cannot change identity, and two identities in the same frame are two animals
 * (`learnIdentityMetric`) — and each contact compares each animal's features
 * just before it with just after it (`contactChangeScores`). Calibration: see
 * MODULES.md (2026-10-09/11).
 *
 * Frame-rate independence: everything time-dependent is set in SECONDS and
 * converted with the recording's frame rate (`opts.fps`, required). Contacts are
 * found on a ~`sampleHz` grid (every round(fps / sampleHz)-th frame); the image
 * check samples more sparsely (`imageHz`, on the same grid), and embeds only the
 * image samples its scoring reads plus a sparse background (`planImageSamples`).
 * A score is a difference of cosine similarities between mean features, which no
 * sample rate scales.
 *
 * Depends on: pose-data.js (readPoint3d). Pure — no DOM, no app state.
 */

import { readPoint3d } from './pose-data.js?v=db2d5e5454d3';

/** Bone (node-pair) lengths used as the size signature. Pairs whose nodes the
 *  session skeleton lacks are skipped. */
export const SIZE_BONES = [
    ['Ear_L', 'Ear_R'], ['Nose', 'Ear_L'], ['Nose', 'Ear_R'], ['Nose', 'Head'], ['Head', 'Neck'],
    ['Neck', 'Trunk'], ['Trunk', 'TTI'], ['Shoulder_left', 'Shoulder_right'], ['Haunch_left', 'Haunch_right'],
    ['TTI', 'Haunch_left'], ['TTI', 'Haunch_right'], ['TTI', 'Tail_0'], ['Tail_0', 'Tail_1'],
    ['Tail_1', 'Tail_2'], ['Tail_2', 'TailTip'], ['Nose', 'TTI'],
];

/** Options shared by both checks. */
const SWITCH_CHECK_DEFAULTS = {
    fps: null,              // REQUIRED: the recording's frame rate
    sampleHz: 15,           // contact grid: analyse ~this many frames per second (every round(fps / sampleHz)-th)
    minTrackedSeconds: 60,  // refuse with less tracked data than this: the metric can't be learned reliably
    sepFactor: 0.65,        // "close" = centroids nearer than sepFactor x median body extent
    sepDistance: null,      // override the close distance directly (world units)
    episodeGapSeconds: 3,   // contacts of a pair less than this apart are one episode...
    minApartSeconds: 3,     // ...and so are episodes with less usable time apart of either animal between them
    windowSeconds: 10,      // each side of a contact, compare up to this much of each animal's time...
    maxSpanSeconds: 60,     // ...found no further than this from it
    followSeconds: 5,       // change points of pairs sharing one identity this close together are one event
    metricPcaDims: 64,      // the identity metric (learnIdentityMetric): features reduced to this many
    metricDims: 16,         // dimensions per view, then to this many directions that tell animals apart,
    metricReg: 0.1,         // with the within-animal scatter shrunk by this fraction of its mean variance
    signal: null,           // AbortSignal: the check throws an AbortError when it fires
};

/** Size-check options. Calibration: see MODULES.md (2026-10-11). */
export const SIZE_CHECK_DEFAULTS = Object.assign({}, SWITCH_CHECK_DEFAULTS, {
    threshold: -1,          // a contact whose score is below this is a possible switch (about -4, swapped,
                            // to +4, unchanged; ~0 = can't tell); bone lengths are a weaker cue than images
    maxTrainRows: 200000,   // samples the metric is learned from (16 numbers each: every one, in practice)
});

/** Image-check options. Calibration: see MODULES.md (2026-10-09). */
export const IMAGE_CHECK_DEFAULTS = Object.assign({}, SWITCH_CHECK_DEFAULTS, {
    imageHz: 2,             // crops per second per identity (on the contact grid), where the scoring reads them;
    backgroundHz: 0.1,      // elsewhere only this many (planImageSamples), so the metric still sees the whole
                            // session; >= imageHz embeds every image sample
    threshold: -0.8,        // a contact whose score is below this is a possible switch
    maxTrainRows: 20000,    // crops per camera the metric is learned from
    getEmbeddings: null,   // REQUIRED: async (frame, items[{k, group}]) -> per item [{camera, vector}];
                           // STARTED in increasing frame order, at most `inFlight` in flight
    inFlight: 2,           // requests kept in flight (ui/image-embedder.js asks for 8, to batch frames)
    prepareFrames: null,   // optional: async (frames[], items[][], gridFrames[]) — every frame getEmbeddings will be asked
                           // for next, in order, and the items it will be asked for at each (lets the provider skip frames
                           // it has cached); gridFrames = every image sample's frame (frames is a subset of it). Called
                           // once per round (planImageSamples): a later round asks for frames an earlier one did not
    keyframes: null,       // optional: async () -> per camera, its keyframes' frame indices (increasing; null = unknown):
                           // the background is placed where decoding is cheap (planImageSamples)
    croppable: null,       // optional: async (frames[], items[][], gridFrames[]) -> per frame, per item: will getEmbeddings
                           // return at least one crop of it? (from the keypoints, before decoding; lets planImageSamples
                           // plan in one round what missing crops would otherwise make it ask for in a second)
    releaseFrames: null,   // optional: () — called when done (or cancelled)
});

/**
 * Whether a node is part of the tail, which the checks leave out of an animal's
 * body (its centroid, its crop, its coat brightness): a name starting with
 * "tail" (Tail_0, TailTip, tail_tip …), or `t` and a number (t0, t1, t2 — as some
 * SLEAP skeletons name the tail's segments), in any case.
 * @param {string} name
 * @returns {boolean}
 */
export function isTailNode(name) { return /^tail/i.test(name) || /^t\d+$/i.test(name); }

/**
 * The index of node `name` in `names`, matched regardless of case — SLEAP
 * skeletons name nodes freely (`nose`, `TTI`, `Nose`…), and the checks look
 * nodes up by name. An exact match wins, then the first case-insensitive one;
 * -1 when there is neither.
 * @param {string[]} names  the skeleton's node names, in order
 * @param {string} name
 * @returns {number}
 */
export function findNode(names, name) {
    var exact = names.indexOf(name);
    if (exact >= 0) return exact;
    var lower = String(name).toLowerCase();
    for (var i = 0; i < names.length; i++) if (typeof names[i] === 'string' && names[i].toLowerCase() === lower) return i;
    return -1;
}

function throwIfAborted(signal) {
    if (signal && signal.aborted) {
        var e = new Error('Cancelled'); e.name = 'AbortError'; throw e;
    }
}

/**
 * PCA by randomized subspace iteration (deterministic seed): the top `k`
 * principal directions of n x D rows. @returns {{project(x): Float64Array}}
 */
export function fitPCA(X, n, D, k, opts) {
    opts = opts || {};
    k = Math.min(k, D, Math.max(1, n - 1));
    var w = opts.weights || null, W = 0;
    var mean = new Float64Array(D);
    for (var r = 0; r < n; r++) { var wr = w ? w[r] : 1; W += wr; for (var d = 0; d < D; d++) mean[d] += wr * X[r * D + d]; }
    for (var d1 = 0; d1 < D; d1++) mean[d1] /= w ? W : Math.max(1, n);
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
            var w2 = w ? w[r2] : 1;
            for (var d8 = 0; d8 < D; d8++) { var xv = row[d8] * w2; if (!xv) continue; for (var c4 = 0; c4 < k; c4++) Z[d8 * k + c4] += xv * Y[r2 * k + c4]; }
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
// The shared pipeline
// ---------------------------------------------------------------------------

/**
 * Sample the session on the grid: per (sample, identity) its InstanceGroup, body
 * centroid and bone lengths (the size check's features), the "close" distance, and
 * the tracklets — runs where an identity is apart from every other.
 * @returns {object} grid, or {fail: reason}
 */
export function buildGrid(session, o, needSize) {
    if (!(typeof o.fps === 'number' && isFinite(o.fps) && o.fps > 0)) return { fail: 'Unknown frame rate (set the fps)' };
    if (!(o.sampleHz > 0)) return { fail: 'sampleHz must be positive' };
    var step = Math.max(1, Math.round(o.fps / o.sampleHz));
    var hz = o.fps / step;
    var secToSamples = function (sec) { return Math.max(1, Math.ceil(sec * hz)); };
    if (!session || !session.instanceGroups || !session.skeleton) return { fail: 'No tracked session' };
    var nodes = (session.skeleton.nodes || []).map(function (n) { return typeof n === 'string' ? n : n && n.name; });
    // the size bones present, found by name regardless of case (findNode), and named as the skeleton names them
    var boneIdx = [], bones = [];
    SIZE_BONES.forEach(function (b) {
        var i0 = findNode(nodes, b[0]), i1 = findNode(nodes, b[1]);
        if (i0 >= 0 && i1 >= 0) { boneIdx.push([i0, i1]); bones.push([nodes[i0], nodes[i1]]); }
    });
    if (needSize && bones.length < 4) return { fail: 'The skeleton has too few of the size nodes (need at least 4 of: ' +
        SIZE_BONES.map(function (b) { return b.join('–'); }).join(', ') + ', in any case)' };
    var B = bones.length;
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
    return { T: T, K: K, B: B, X: X, C: C, G: G, frames: frames, idents: idents, bones: bones, sep: sep,
             step: step, hz: hz, secToSamples: secToSamples, tl: tl, hasCen: hasCen };
}

/**
 * Contact episodes per pair: runs of grid samples in which the two identities
 * are in one connected component of the "close" graph — touching, or both
 * touching a third animal (labels can change hands in a three-animal pile-up
 * with no encounter between the two) — with runs less than `gapSeconds` apart
 * merged. From the episode scoring of talmolab/luc3d#286.
 * @returns {{comp: Int16Array, pairs: Array<{a: number, b: number, eps: number[][]}>}}
 *   comp[i * K + k] = identity k's component at sample i (-1: no centroid); eps = [[first, last], …]
 */
export function contactEpisodes(grid, gapSeconds) {
    var T = grid.T, K = grid.K, C = grid.C, sep = grid.sep;
    var close = function (i, a, b) {
        var x = C[(i * K + a) * 3] - C[(i * K + b) * 3], y = C[(i * K + a) * 3 + 1] - C[(i * K + b) * 3 + 1],
            z = C[(i * K + a) * 3 + 2] - C[(i * K + b) * 3 + 2];
        return Math.hypot(x, y, z) <= sep;
    };
    var comp = new Int16Array(T * K).fill(-1);
    for (var i = 0; i < T; i++) {
        var next = 0;
        for (var k = 0; k < K; k++) {
            if (!grid.hasCen(i, k) || comp[i * K + k] >= 0) continue;
            var stack = [k]; comp[i * K + k] = next;
            while (stack.length) {
                var u = stack.pop();
                for (var v = 0; v < K; v++) {
                    if (v !== u && comp[i * K + v] < 0 && grid.hasCen(i, v) && close(i, u, v)) { comp[i * K + v] = next; stack.push(v); }
                }
            }
            next++;
        }
    }
    var gap = grid.secToSamples(gapSeconds), pairs = [];
    for (var a = 0; a < K; a++) for (var b = a + 1; b < K; b++) {
        var eps = [], s0 = -1;
        for (var i2 = 0; i2 <= T; i2++) {
            var together = i2 < T && comp[i2 * K + a] >= 0 && comp[i2 * K + a] === comp[i2 * K + b];
            if (together && s0 < 0) s0 = i2;
            if (!together && s0 >= 0) {
                var last = eps[eps.length - 1];
                if (last && s0 - last[1] <= gap) last[1] = i2 - 1; else eps.push([s0, i2 - 1]);
                s0 = -1;
            }
        }
        pairs.push({ a: a, b: b, eps: eps });
    }
    return { comp: comp, pairs: pairs };
}

/**
 * Eigen-decomposition of a symmetric n x n matrix (row-major), cyclic Jacobi.
 * @returns {{values: Float64Array, vectors: Float64Array}} vectors in COLUMNS (row-major n x n)
 */
export function symmetricEigen(A, n) {
    var a = Float64Array.from(A), v = new Float64Array(n * n);
    for (var i = 0; i < n; i++) v[i * n + i] = 1;
    for (var sweep = 0; sweep < 60; sweep++) {
        var off = 0, diag = 0;
        for (var p = 0; p < n; p++) { diag += a[p * n + p] * a[p * n + p]; for (var q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q]; }
        if (off <= 1e-24 * Math.max(diag, 1e-300)) break;
        for (var p2 = 0; p2 < n; p2++) for (var q2 = p2 + 1; q2 < n; q2++) {
            var apq = a[p2 * n + q2];
            if (apq === 0) continue;
            var th = (a[q2 * n + q2] - a[p2 * n + p2]) / (2 * apq);
            var t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
            for (var k = 0; k < n; k++) {
                var akp = a[k * n + p2], akq = a[k * n + q2];
                a[k * n + p2] = c * akp - s * akq; a[k * n + q2] = s * akp + c * akq;
            }
            for (var k2 = 0; k2 < n; k2++) {
                var apk = a[p2 * n + k2], aqk = a[q2 * n + k2];
                a[p2 * n + k2] = c * apk - s * aqk; a[q2 * n + k2] = s * apk + c * aqk;
            }
            for (var k3 = 0; k3 < n; k3++) {
                var vkp = v[k3 * n + p2], vkq = v[k3 * n + q2];
                v[k3 * n + p2] = c * vkp - s * vkq; v[k3 * n + q2] = s * vkp + c * vkq;
            }
        }
    }
    var values = new Float64Array(n);
    for (var d = 0; d < n; d++) values[d] = a[d * n + d];
    return { values: values, vectors: v };
}

/**
 * A metric that tells THESE animals apart, for one view (a camera's crops, or the
 * bone lengths), learned without identity labels — a linear discriminant analysis
 * whose classes need no tracking to be right:
 *   - within one animal: features of one identity in one stretch apart from every
 *     other animal (`stretch[r]`, -1 = none) — no label can change hands there;
 *   - between animals: features of two identities in the same frame (`sample[r]`) —
 *     whatever the labels say, they are two animals.
 * The directions in which two animals differ most relative to how much one
 * animal varies (pose, view, lighting, triangulation noise) are what tells these
 * animals apart in this recording. A generic image embedding needs that on
 * look-alike animals: on five white mice the raw cosine scored real swaps at AUC
 * 0.68, with it 0.78.
 * Rows are PCA-reduced to `o.metricPcaDims` first (so the scatter matrices are
 * well conditioned and cheap), the within-animal scatter shrunk by `o.metricReg`.
 * @param {Float64Array} X  n x D rows (centred)
 * @returns {{dims: number, project: function(ArrayLike<number>): Float64Array}}  unit vectors;
 *   PCA alone when there are too few stretches or simultaneous pairs to learn from
 */
export function learnIdentityMetric(X, n, D, stretch, sample, o, weights) {
    var w = weights || null, wOf = function (r) { return w ? w[r] : 1; };
    var pca = fitPCA(X, n, D, o.metricPcaDims || 64, { weights: w }), d = pca.dims;
    var Y = new Float64Array(n * d);
    for (var r = 0; r < n; r++) Y.set(pca.project(X.subarray(r * D, (r + 1) * D)), r * d);
    var groups = function (key) {
        var m = new Map();
        for (var r2 = 0; r2 < n; r2++) { var g = key[r2]; if (g < 0) continue; if (!m.has(g)) m.set(g, []); m.get(g).push(r2); }
        return m;
    };
    // nw / nb count pairs (the "too few to learn from" test); sw / sb are their summed weights (the averages)
    var Sw = new Float64Array(d * d), Sb = new Float64Array(d * d), nw = 0, nb = 0, sw = 0, sb = 0, mu = new Float64Array(d), dv = new Float64Array(d);
    groups(stretch).forEach(function (rows) {
        if (rows.length < 2) return;
        mu.fill(0);
        var wsum = 0;
        rows.forEach(function (r3) { wsum += wOf(r3); });
        rows.forEach(function (r3) { var wr = wOf(r3); for (var x = 0; x < d; x++) mu[x] += wr * Y[r3 * d + x] / wsum; });
        rows.forEach(function (r3) {
            var wr = wOf(r3);
            for (var x = 0; x < d; x++) dv[x] = Y[r3 * d + x] - mu[x];
            for (var x2 = 0; x2 < d; x2++) for (var y2 = 0; y2 < d; y2++) Sw[x2 * d + y2] += dv[x2] * dv[y2] * wr;
            nw++; sw += wr;
        });
    });
    groups(sample).forEach(function (rows) {
        for (var p = 0; p < rows.length; p++) for (var q = p + 1; q < rows.length; q++) {
            var wp = wOf(rows[p]);                    // one sample: both rows weigh the same
            for (var x = 0; x < d; x++) dv[x] = Y[rows[p] * d + x] - Y[rows[q] * d + x];
            for (var x2 = 0; x2 < d; x2++) for (var y2 = 0; y2 < d; y2++) Sb[x2 * d + y2] += dv[x2] * dv[y2] * wp;
            nb++; sb += wp;
        }
    });
    var unit = function (z) {
        var nn = 0; for (var x = 0; x < z.length; x++) nn += z[x] * z[x];
        nn = Math.sqrt(nn) || 1; for (var x2 = 0; x2 < z.length; x2++) z[x2] /= nn;
        return z;
    };
    if (nw < 20 || nb < 20) return { dims: d, project: function (x) { return unit(pca.project(x)); } };
    var tr = 0;
    for (var x3 = 0; x3 < d; x3++) { for (var y3 = 0; y3 < d; y3++) { Sw[x3 * d + y3] /= sw; Sb[x3 * d + y3] /= sb; } tr += Sw[x3 * d + x3]; }
    for (var x4 = 0; x4 < d; x4++) Sw[x4 * d + x4] += (o.metricReg != null ? o.metricReg : 0.1) * tr / d;
    // whiten the within-animal scatter (W1 = E diag(1/sqrt(l))), then the top directions of the between-animal one
    var ew = symmetricEigen(Sw, d), W1 = new Float64Array(d * d);
    for (var x5 = 0; x5 < d; x5++) for (var c = 0; c < d; c++) W1[x5 * d + c] = ew.vectors[x5 * d + c] / Math.sqrt(Math.max(ew.values[c], 1e-12));
    var T1 = new Float64Array(d * d), M = new Float64Array(d * d);
    for (var x6 = 0; x6 < d; x6++) for (var c2 = 0; c2 < d; c2++) { var s = 0; for (var y6 = 0; y6 < d; y6++) s += Sb[x6 * d + y6] * W1[y6 * d + c2]; T1[x6 * d + c2] = s; }
    for (var x7 = 0; x7 < d; x7++) for (var c3 = 0; c3 < d; c3++) { var s2 = 0; for (var y7 = 0; y7 < d; y7++) s2 += W1[y7 * d + x7] * T1[y7 * d + c3]; M[x7 * d + c3] = s2; }
    var em = symmetricEigen(M, d);
    var order = Array.from({ length: d }, function (_, i) { return i; })
        .sort(function (p, q) { return em.values[q] - em.values[p]; }).slice(0, Math.min(o.metricDims || 16, d));
    var Q = order.length, P = new Float64Array(d * Q);       // d x Q = W1 U
    for (var x8 = 0; x8 < d; x8++) order.forEach(function (col, j) {
        var s3 = 0; for (var y8 = 0; y8 < d; y8++) s3 += W1[x8 * d + y8] * em.vectors[y8 * d + col]; P[x8 * Q + j] = s3;
    });
    return {
        dims: Q,
        project: function (x) {
            var y = pca.project(x), z = new Float64Array(Q);
            for (var j = 0; j < Q; j++) { var s4 = 0; for (var x9 = 0; x9 < d; x9++) s4 += y[x9] * P[x9 * Q + j]; z[j] = s4; }
            return unit(z);
        },
    };
}

/**
 * Score every contact episode of every pair by whether each animal still looks
 * like ITSELF across it. For identities a and b, per view (camera, or bone
 * lengths), the mean feature (unit vectors in the view's metric) of each animal
 * just BEFORE the episode (aB, bB) and just AFTER it (aA, bA):
 *
 *     S = cos(aB, aA) + cos(bB, bA) - cos(aB, bA) - cos(bB, aA)        (mean over views)
 *
 * S > 0: each looks like itself; S < 0: each looks like the other did — the
 * labels changed hands in the episode; ~0: the two can't be told apart here.
 * No classifier and no identity label across the contact is involved, so it
 * does not matter which labelling covers more of the session, nor how often the
 * tracker swapped elsewhere.
 *
 * A "usable" sample of a is one where a is not in contact with b (it may be
 * touching a third animal: a crop masks the others out, and its own skeleton is
 * its own), so huddling animals still get evidence. Each side reads up to
 * `windowSeconds` of samples, at most `maxSpanSeconds` away and never past the
 * pair's neighbouring episode. Episodes separated by less than `minApartSeconds`
 * of usable samples of either animal are one: a swap inside a long huddle is
 * judged from the stretches either side of it. Episodes with no view seeing both
 * animals on both sides are dropped.
 *
 * @param {object} grid  from buildGrid
 * @param {function(number, number): ?Array<{c: number, u: Float64Array}>} feat  features of identity k at sample i, per view c
 * @param {object} o     options (IMAGE_CHECK_DEFAULTS)
 * @param {number} every grid samples per feature sample (1 for size)
 * @returns {Array<{frame, startFrame, identityA, identityB, nameA, nameB, score, cameras}>} sorted by frame
 */
export function contactChangeScores(grid, feat, o, every) {
    var T = grid.T, K = grid.K, frames = grid.frames, idents = grid.idents;
    var ce = contactEpisodes(grid, o.episodeGapSeconds), comp = ce.comp;
    var perSide = Math.max(1, Math.round(o.windowSeconds * grid.hz / every)), span = grid.secToSamples(o.maxSpanSeconds);
    var minN = Math.max(0, Math.round((o.minApartSeconds || 0) * grid.hz / every));
    var usable = function (i, k, p) {
        return grid.hasCen(i, k) && !(comp[i * K + p] >= 0 && comp[i * K + p] === comp[i * K + k]) && !!feat(i, k);
    };
    var collect = function (k, p, from, dir, limit) {
        var got = [];
        for (var i = from, n = 0; i >= 0 && i < T && n <= span && (dir < 0 ? i >= limit : i <= limit); i += dir, n++) {
            if (usable(i, k, p)) { got.push(feat(i, k)); if (got.length >= perSide) break; }
        }
        return got;
    };
    var meanByCam = function (rows) {
        var m = new Map();
        rows.forEach(function (list) {
            list.forEach(function (e) {
                var acc = m.get(e.c);
                if (!acc) m.set(e.c, acc = new Float64Array(e.u.length));
                for (var x = 0; x < acc.length; x++) acc[x] += e.u[x];
            });
        });
        m.forEach(function (acc) { var nn = 0; for (var x = 0; x < acc.length; x++) nn += acc[x] * acc[x]; nn = Math.sqrt(nn) || 1; for (var x2 = 0; x2 < acc.length; x2++) acc[x2] /= nn; });
        return m;
    };
    var dot = function (x, y) { var s = 0; for (var j = 0; j < x.length; j++) s += x[j] * y[j]; return s; };
    var out = [];
    ce.pairs.forEach(function (pr) {
        var a = pr.a, b = pr.b, eps = [];
        // evidence-driven episodes: merge across a gap with too few usable samples of either animal
        var enough = function (lo, hi) {
            var na = 0, nb = 0;
            for (var i = lo; i <= hi && (na < minN || nb < minN); i++) { if (usable(i, a, b)) na++; if (usable(i, b, a)) nb++; }
            return na >= minN && nb >= minN;
        };
        pr.eps.forEach(function (ep) {
            var last = eps[eps.length - 1];
            if (last && minN > 0 && !enough(last[1] + 1, ep[0] - 1)) last[1] = ep[1]; else eps.push(ep.slice());
        });
        for (var q = 0; q < eps.length; q++) {
            var s = eps[q][0], e = eps[q][1];
            var lo = q > 0 ? eps[q - 1][1] + 1 : 0, hi = q + 1 < eps.length ? eps[q + 1][0] - 1 : T - 1;
            var m = [collect(a, b, s - 1, -1, lo), collect(b, a, s - 1, -1, lo), collect(a, b, e + 1, 1, hi), collect(b, a, e + 1, 1, hi)].map(meanByCam);
            var S = 0, nc = 0;
            m[0].forEach(function (aB, c) {
                var bB = m[1].get(c), aA = m[2].get(c), bA = m[3].get(c);
                if (!bB || !aA || !bA) return;
                S += (dot(aB, aA) + dot(bB, bA)) - (dot(aB, bA) + dot(bB, aA)); nc++;
            });
            if (!nc) continue;
            out.push({ frame: frames[e], startFrame: frames[s], identityA: idents[a].id, identityB: idents[b].id,
                       nameA: idents[a].name, nameB: idents[b].name, score: S / nc, cameras: nc });
        }
    });
    return out.sort(function (x, y) { return x.frame - y.frame; });
}

/**
 * Which samples `contactChangeScores` reads features of, given which (sample,
 * identity) have them (`has`): it is run on stand-in features and every sample
 * it asks about is recorded, so the answer cannot drift from the scoring. Only
 * image samples (every `every`-th) count — the check embeds no others. Reads
 * depend on `has` (a side keeps going past samples without features, and the
 * episode merge counts them), which is why `planImageSamples` repeats.
 * @param {object} grid  from buildGrid
 * @param {function(number, number): boolean} has  does identity k have features at sample i?
 * @returns {number[]} sample indices, increasing
 */
export function contactReads(grid, has, o, every) {
    var seen = new Uint8Array(grid.T), stub = [{ c: 0, u: new Float64Array([1]) }];
    contactChangeScores(grid, function (i, k) {
        if (i % every) return null;
        seen[i] = 1;
        return has(i, k) ? stub : null;
    }, o, every);
    var out = [];
    for (var i = 0; i < grid.T; i++) if (seen[i]) out.push(i);
    return out;
}

/** Never fewer background samples than one per this many seconds, however sparse the keyframes. */
export const MAX_BACKGROUND_GAP_SECONDS = 10;

/**
 * The background's blocks: runs of `len` consecutive image samples, one sample
 * embedded per block. `len` = round(imageHz / backgroundHz) (1 = every sample;
 * 0 = no background). With keyframes known, a block is at least one keyframe gap
 * (+ a sample) long, so it holds a sample just after a keyframe — at most
 * `MAX_BACKGROUND_GAP_SECONDS` long.
 * @returns {number} image samples per block (0 = none)
 */
function backgroundBlock(grid, o, every, keyframes) {
    var imgHz = grid.hz / every;
    if (!(o.backgroundHz < imgHz)) return 1;
    if (!(o.backgroundHz > 0)) return 0;
    var len = Math.max(1, Math.round(imgHz / o.backgroundHz));
    if (len > 1 && keyframes) {
        var gap = 0;
        keyframes.forEach(function (kf) {
            var d = [];
            for (var j = 1; kf && j < kf.length; j++) d.push(kf[j] - kf[j - 1]);
            if (d.length) gap = Math.max(gap, median(d));
        });
        var gapSamples = Math.ceil(gap / (grid.step * every)) + 1;
        len = Math.max(len, Math.min(gapSamples, Math.round(MAX_BACKGROUND_GAP_SECONDS * imgHz)));
    }
    return len;
}

/** Rounds of `planImageSamples` before the image check embeds every sample left (each round is a pass over the videos). */
export const MAX_PLAN_ROUNDS = 4;

/**
 * The image samples still to embed. Contact episodes, and so the windows the
 * scoring reads (`contactChangeScores`), come from the 3D alone, so they are
 * known before any frame is decoded: every image sample the scoring would read
 * (`contactReads`, assuming a sample not yet embedded will have every identity's
 * crop it is expected to have), plus a background so the identity metric
 * (centring, PCA, LDA in `scoreContacts`) still sees the whole session: one
 * sample in each block of `backgroundBlock` image samples that holds samples the
 * scoring does not read — the one cheapest to decode (fewest frames past what its
 * keyframe and the planned samples already decode, summed over cameras: on a
 * recording with a keyframe every 250 frames a sample mid-gap costs ~125 frames
 * per camera, one just after a keyframe ~1), else the first.
 * Whole samples — every identity in the frame — so "two identities in the same
 * frame" pairs remain. A crop that turns out missing makes the scoring read
 * further, so the check calls this again after each round until it returns
 * nothing; then every sample the scoring reads has been embedded, and it reads
 * exactly the samples it would have read with all of them embedded (only the
 * metric, learned from fewer crops, differs — see `backgroundWeights`).
 * @param {object} grid  from buildGrid
 * @param {object} o     options (`backgroundHz`, and the scoring's)
 * @param {number} every grid samples per image sample
 * @param {{embeddable: Uint8Array, embedded: Uint8Array, got: Uint8Array, expect: ?Uint8Array, keyframes: ?Array}} st
 *        per sample i: an image sample with at least 2 identities (one the check can ask for); already asked for;
 *        got[i * K + k]: it returned a crop of identity k; expect[i * K + k] (optional): it is expected to
 *        (`o.croppable`); keyframes (optional): per camera, its keyframes' frame indices, increasing
 * @returns {number[]} samples to embed next, increasing ([] = done)
 */
export function planImageSamples(grid, o, every, st) {
    var K = grid.K, T = grid.T, frames = grid.frames, want = new Uint8Array(T);
    var has = function (i, k) { return st.embedded[i] ? st.got[i * K + k] === 1 : st.embeddable[i] === 1 && (!st.expect || st.expect[i * K + k] === 1); };
    var reads = contactReads(grid, has, o, every);
    reads.forEach(function (i) { want[i] = 1; });
    var len = backgroundBlock(grid, o, every, st.keyframes);
    if (len > 0) {
        // per camera: how far each keyframe gap is decoded already (the planned and embedded samples)
        var kfs = (st.keyframes || []).filter(function (kf) { return kf && kf.length; });
        var gapOf = function (kf, f) {                  // index of the last keyframe <= f (-1: before the first)
            var lo = 0, hi = kf.length - 1, r = -1;
            while (lo <= hi) { var m = (lo + hi) >> 1; if (kf[m] <= f) { r = m; lo = m + 1; } else hi = m - 1; }
            return r;
        };
        var reach = kfs.map(function () { return new Map(); });   // per camera: keyframe gap -> last frame decoded in it
        var reached = function (c, g) { return reach[c].has(g) ? reach[c].get(g) : -1; };
        var cover = function (f) { kfs.forEach(function (kf, c) { var g = gapOf(kf, f); if (f > reached(c, g)) reach[c].set(g, f); }); };
        for (var i0 = 0; i0 < T; i0 += every) if (want[i0] || st.embedded[i0]) cover(frames[i0]);
        var cost = function (f) {                       // frames decoded for f beyond what is decoded anyway, all cameras
            var sum = 0;
            kfs.forEach(function (kf, c) { var g = gapOf(kf, f); sum += Math.max(0, f - Math.max(g >= 0 ? kf[g] : 0, reached(c, g))); });
            return sum;
        };
        var n = Math.ceil(T / every);
        for (var b = 0; b < n; b += len) {
            var best = -1, bestCost = Infinity, done = false;
            for (var j = b; j < Math.min(n, b + len) && !done; j++) {
                var i1 = j * every;
                if (!st.embeddable[i1] || want[i1]) continue;
                if (st.embedded[i1]) { done = true; break; }         // the block already has its background sample
                var c1 = len > 1 ? cost(frames[i1]) : 0;
                if (c1 < bestCost) { best = i1; bestCost = c1; }
            }
            if (!done && best >= 0) { want[best] = 1; if (len > 1) cover(frames[best]); }
        }
    }
    var out = [];
    for (var i = 0; i < T; i += every) if (want[i] && st.embeddable[i] && !st.embedded[i]) out.push(i);
    return out;
}

/**
 * How much each embedded sample counts in the identity metric, so it is learned
 * as if from every image sample: a sample the scoring reads counts once; the
 * background samples of a block (`backgroundBlock`) share the block's samples the
 * scoring does not read. null when every image sample was embedded (each counts
 * once — the old, unweighted fit, bit for bit).
 * @returns {?function(number): number} sample index -> weight
 */
function backgroundWeights(grid, o, every, st) {
    var T = grid.T, K = grid.K, n = Math.ceil(T / every), len = backgroundBlock(grid, o, every, st.keyframes);
    var all = true;
    for (var i = 0; i < T; i += every) if (st.embeddable[i] && !st.embedded[i]) { all = false; break; }
    if (all || len < 1) return null;
    var read = new Uint8Array(T);
    contactReads(grid, function (i2, k2) { return st.got[i2 * K + k2] === 1; }, o, every).forEach(function (i2) { read[i2] = 1; });
    var w = new Float64Array(T).fill(1);
    for (var b = 0; b < n; b += len) {
        var rest = 0, picked = [];
        for (var j = b; j < Math.min(n, b + len); j++) {
            var i3 = j * every;
            if (!st.embeddable[i3] || read[i3]) continue;
            rest++;
            if (st.embedded[i3]) picked.push(i3);
        }
        picked.forEach(function (i4) { w[i4] = rest / picked.length; });
    }
    return function (i5) { return w[i5]; };
}

/**
 * Change points from contact scores (mutates them: `flagged`, `kind`,
 * `switchBackAt` / `switchedAt`, `followOf`). Every contact scoring below
 * `o.threshold` is where a pair's labels changed hands. Taking the session's
 * start as right, a pair's 1st, 3rd, … such contact starts a swapped stretch
 * (`kind: 'onset'`, `switchBackAt` = the next one's frame, or null to the end)
 * and its 2nd, 4th, … ends it (`kind: 'end'`, `switchedAt` = the onset's frame)
 * — so fixing either row swaps the same stretch. One that follows another of a
 * different pair sharing one identity within `o.followSeconds` is part of the same
 * event (a three-way relabel): `followOf`. Exported so the threshold can be
 * re-applied to the same scores.
 * @returns {Array} the change points (the flagged contacts), by frame
 */
export function markContactChanges(scored, o) {
    var byPair = new Map();
    scored.forEach(function (sc) {
        delete sc.kind; delete sc.followOf; delete sc.switchBackAt; delete sc.switchedAt;
        sc.flagged = sc.score < o.threshold; sc.continues = false;
        var key = sc.identityA + ':' + sc.identityB;
        if (!byPair.has(key)) byPair.set(key, []);
        if (sc.flagged) byPair.get(key).push(sc);
    });
    byPair.forEach(function (F) {
        for (var j = 0; j < F.length; j += 2) {
            F[j].kind = 'onset'; F[j].switchBackAt = j + 1 < F.length ? F[j + 1].frame : null;
            if (j + 1 < F.length) { F[j + 1].kind = 'end'; F[j + 1].switchedAt = F[j].frame; }
        }
    });
    var flagged = scored.filter(function (x) { return x.flagged; }).sort(function (x, y) { return x.frame - y.frame; });
    for (var i = 0; i < flagged.length; i++) {
        var cur = flagged[i];
        for (var j2 = i - 1; j2 >= 0; j2--) {
            var prev = flagged[j2];
            if (cur.startFrame - prev.frame > o.followSeconds * o.fps) break;
            if (prev.followOf != null) continue;
            var shared = [prev.identityA, prev.identityB].filter(function (id) { return id === cur.identityA || id === cur.identityB; });
            if (shared.length === 1) { cur.followOf = prev.frame; break; }
        }
    }
    return flagged;
}

/**
 * The pipeline both checks share, from features to change points. Per view (a
 * camera's crop embeddings, or the bone lengths): centre the features — and, for
 * embeddings, scale each to unit length, since an embedding's direction is what
 * it encodes while a bone-length vector's size is the signal — learn the view's
 * identity metric (`learnIdentityMetric`, from at most `o.maxTrainRows` features,
 * whole samples at a time) and project every feature into it; then score every
 * contact (`contactChangeScores`) and mark the change points (`markContactChanges`).
 * @param {object} grid
 * @param {Array<{rows: number[], vecs: ArrayLike<number>[]}>} views  rows = sample * K + identity
 * @param {object} o
 * @param {number} every     grid samples per feature sample
 * @param {boolean} unitRows scale each centred feature to unit length
 * @param {?function(number, number): Promise} fitProgress  awaited before each view and at the end
 * @returns {Promise<Array>} the scored contacts, marked
 */
async function scoreContacts(grid, views, o, every, unitRows, fitProgress, sampleWeight) {
    var T = grid.T, K = grid.K;
    var stretchOf = new Int32Array(T * K).fill(-1);
    grid.tl.forEach(function (t, ti) { for (var i = t.start; i <= t.end; i++) stretchOf[i * K + t.k] = ti; });
    var feats = new Map();    // row (sample * K + identity) -> [{c, u}]
    for (var ci = 0; ci < views.length; ci++) {
        throwIfAborted(o.signal);
        if (fitProgress) await fitProgress(ci, views.length);
        var data = views[ci], n = data.rows.length, D = data.vecs[0].length;
        var X = new Float64Array(n * D), mean = new Float64Array(D);
        var wRow = function (r0) { return sampleWeight ? sampleWeight(Math.floor(data.rows[r0] / K)) : 1; }, W = 0;
        for (var r0 = 0; r0 < n; r0++) W += wRow(r0);
        data.vecs.forEach(function (v, r1) { var wr = wRow(r1); for (var x = 0; x < D; x++) mean[x] += wr * v[x] / W; });
        data.vecs.forEach(function (v, r) {
            var nn = 0;
            for (var x = 0; x < D; x++) { var t = v[x] - mean[x]; X[r * D + x] = t; nn += t * t; }
            if (unitRows) { nn = Math.sqrt(nn) || 1; for (var x2 = 0; x2 < D; x2++) X[r * D + x2] /= nn; }
        });
        var stride = Math.max(1, Math.ceil(n / o.maxTrainRows)), use = [];
        for (var r = 0; r < n; r++) if (Math.floor(data.rows[r] / K / every) % stride === 0) use.push(r);   // whole samples
        var Xt = new Float64Array(use.length * D), st = new Int32Array(use.length), sm = new Int32Array(use.length);
        var wt = sampleWeight ? new Float64Array(use.length) : null;
        use.forEach(function (r2, j) {
            Xt.set(X.subarray(r2 * D, (r2 + 1) * D), j * D);
            st[j] = stretchOf[data.rows[r2]]; sm[j] = Math.floor(data.rows[r2] / K);
            if (wt) wt[j] = wRow(r2);
        });
        var metric = learnIdentityMetric(Xt, use.length, D, st, sm, o, wt);
        for (var r3 = 0; r3 < n; r3++) {
            var row = data.rows[r3];
            if (!feats.has(row)) feats.set(row, []);
            feats.get(row).push({ c: ci, u: metric.project(X.subarray(r3 * D, (r3 + 1) * D)) });
        }
    }
    var scored = contactChangeScores(grid, function (i3, k3) { return feats.get(i3 * K + k3) || null; }, o, every);
    markContactChanges(scored, o);
    if (fitProgress) await fitProgress(views.length, views.length);
    return scored;
}

function failure(reason) { return { ok: false, reason: reason, flags: [], changes: [], encounters: [] }; }

/** The result both checks return. */
function result(grid, scored, o, extra) {
    return Object.assign({
        ok: true, flags: scored.filter(function (s) { return s.flagged; }), changes: [], encounters: scored,
        identities: grid.idents.map(function (id) { return id.name; }),
        sampledFrames: grid.T, closeDistance: grid.sep, threshold: o.threshold,
        fps: o.fps, step: grid.step, sampleHz: grid.hz,
    }, extra);
}

// ---------------------------------------------------------------------------
// The two checks
// ---------------------------------------------------------------------------

/**
 * Body-size check: every contact scored by whether each animal's 3D bone lengths
 * still look like its own across it (`contactChangeScores`), in a metric learned
 * per recording without identity labels — the same method as the image check,
 * with the bone lengths of every grid sample (each standardised by its spread
 * over the session) as ONE view.
 *
 * Async so a caller can keep the page painting: `opts.onProgress(done, total)`
 * is awaited before the work and at its end (seconds for a 30-minute, 5-animal
 * recording).
 *
 * @param {Session} session  needs `instanceGroups` (frame -> groups with
 *        `identityId` + flat `points3d`), `identities`, `skeleton.nodes`.
 * @param {object} opts      see SIZE_CHECK_DEFAULTS; `fps` is required. Plus `onProgress`.
 * @returns {Promise<object>} {ok, flags, changes ([]), encounters, identities,
 *   bones, sampledFrames, closeDistance, threshold, fps, step, sampleHz, cue} or
 *   {ok: false, reason}. `encounters` = the scored contact episodes: { frame (their
 *   last close frame), startFrame (their first), identityA, identityB, nameA,
 *   nameB, score, cameras, flagged, kind?, switchBackAt? / switchedAt?, followOf? };
 *   `flags` = the change points among them (see markContactChanges).
 */
export async function checkSizeSwitches(session, opts) {
    var o = Object.assign({}, SIZE_CHECK_DEFAULTS, opts || {});
    var grid = buildGrid(session, o, true);
    if (grid.fail) return failure(grid.fail);
    var T = grid.T, K = grid.K, B = grid.B, X = grid.X;
    var rows = [], vecs = [], mean = new Float64Array(B), sd = new Float64Array(B);
    for (var row = 0; row < T * K; row++) {
        var ok = true;
        for (var b = 0; b < B && ok; b++) if (!isFinite(X[row * B + b])) ok = false;
        if (ok) { rows.push(row); vecs.push(X.subarray(row * B, (row + 1) * B)); }
    }
    if (rows.length < 20) return failure('Too few triangulated skeletons with every size bone');
    vecs.forEach(function (v) { for (var b2 = 0; b2 < B; b2++) mean[b2] += v[b2] / vecs.length; });
    vecs.forEach(function (v) { for (var b3 = 0; b3 < B; b3++) sd[b3] += (v[b3] - mean[b3]) * (v[b3] - mean[b3]) / vecs.length; });
    for (var b4 = 0; b4 < B; b4++) sd[b4] = Math.sqrt(sd[b4]) || 1;
    var z = vecs.map(function (v) { var w = new Float64Array(B); for (var b5 = 0; b5 < B; b5++) w[b5] = (v[b5] - mean[b5]) / sd[b5]; return w; });
    var scored = await scoreContacts(grid, [{ rows: rows, vecs: z }], o, 1, false, o.onProgress || null);
    return result(grid, scored, o, { bones: grid.bones.map(function (bn) { return bn.join('–'); }), cue: 'size' });
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
 * Image check: image samples are every round(sampleHz / imageHz)-th grid
 * sample; at those the scoring reads, plus a sparse background
 * (`planImageSamples`: `backgroundHz`, placed by `opts.keyframes`, planned in one
 * round when `opts.croppable` says which animals will have crops),
 * `opts.getEmbeddings(frame, items)` is awaited for the identities present
 * (`items` = [{k, group}]) and returns, per item, the crops' embeddings as
 * [{camera, vector}] (any length; [] = not visible). `backgroundHz` >= `imageHz`
 * embeds every image sample, as before. Each camera is one view of
 * `scoreContacts`: its embeddings are centred and scaled to unit length, a metric
 * is learned per camera without identity labels (`learnIdentityMetric`), every
 * contact is scored by whether the two animals look like themselves across it
 * (`contactChangeScores`, mean over cameras) and the contacts below
 * `opts.threshold` are the change points (`markContactChanges`).
 *
 * `opts.onProgress(stage, done, total)` is awaited with stage 'embed' (per
 * sampled frame) and 'fit' (per camera). `opts.signal` cancels.
 *
 * @returns {Promise<object>} as checkSizeSwitches (without `bones`), plus
 *   {imageHz, crops, cameras, samples: {embedded, of, rounds}} (image samples embedded,
 *   of those with 2+ identities, in how many passes), or {ok: false, reason}.
 */
export async function checkImageSwitches(session, opts) {
    var o = Object.assign({}, IMAGE_CHECK_DEFAULTS, opts || {});
    if (typeof o.getEmbeddings !== 'function') return failure('No image embedder available');
    var grid = buildGrid(session, o, false);
    if (grid.fail) return failure(grid.fail);
    var T = grid.T, K = grid.K;
    var every = Math.max(1, Math.round(grid.hz / o.imageHz)), imgHz = grid.hz / every;
    var progress = o.onProgress || null;

    // ---- embeddings at the image samples the scoring reads (+ a background), grouped by camera
    var perCam = new Map();   // camera -> {rows: [], vecs: []}
    var crops = 0, jobAt = new Map(), gridFrames = [];
    var st = { embeddable: new Uint8Array(T), embedded: new Uint8Array(T), got: new Uint8Array(T * K), expect: null,
               keyframes: typeof o.keyframes === 'function' ? await o.keyframes() : null };
    for (var i = 0; i < T; i += every) {
        var items = [];
        for (var k = 0; k < K; k++) if (grid.G[i * K + k] && grid.hasCen(i, k)) items.push({ k: k, group: grid.G[i * K + k] });
        if (items.length >= 2) { jobAt.set(i, { i: i, frame: grid.frames[i], items: items }); st.embeddable[i] = 1; gridFrames.push(grid.frames[i]); }
    }
    // The provider may stream the frames in order instead of seeking to each one
    // (`prepareFrames`), and up to `inFlight` requests (default 2) run ahead of the
    // one being consumed — requests are STARTED in frame order, so a streaming
    // provider still sees increasing frames — letting decode/crop of later frames
    // overlap embedding (a provider can then batch several frames per model run).
    var asked = 0, answered = 0, rounds = 0;
    if (typeof o.croppable === 'function') {
        var cand = Array.from(jobAt.values()), can = await o.croppable(cand.map(function (j) { return j.frame; }), cand.map(function (j) { return j.items; }), gridFrames);
        st.expect = new Uint8Array(T * K);
        cand.forEach(function (j, ci) { j.items.forEach(function (itm, ii) { if (!can || !can[ci] || can[ci][ii]) st.expect[j.i * K + itm.k] = 1; }); });
    }
    var embedRound = async function (jobs) {
        if (typeof o.prepareFrames === 'function') {
            await o.prepareFrames(jobs.map(function (j) { return j.frame; }), jobs.map(function (j) { return j.items; }), gridFrames);
        }
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
            st.embedded[job.i] = 1;
            for (var it = 0; it < job.items.length; it++) {
                var list = (embs && embs[it]) || [];
                if (list.length) st.got[job.i * K + job.items[it].k] = 1;
                for (var e = 0; e < list.length; e++) {
                    var cam = list[e].camera;
                    if (!perCam.has(cam)) perCam.set(cam, { rows: [], vecs: [] });
                    perCam.get(cam).rows.push(job.i * K + job.items[it].k); perCam.get(cam).vecs.push(list[e].vector); crops++;
                }
            }
            answered++;
            if (progress && (ji % 5 === 0 || ji === jobs.length - 1)) await progress('embed', answered, asked);
        }
    };
    try {
        for (;;) {
            var next = planImageSamples(grid, o, every, st);
            if (!next.length) break;
            if (rounds === MAX_PLAN_ROUNDS - 1) {      // crops keep failing: embed everything left, so the scoring is still exact
                next = [];
                jobAt.forEach(function (j, i3) { if (!st.embedded[i3]) next.push(i3); });
                next.sort(function (a, b) { return a - b; });
            }
            rounds++; asked += next.length;
            await embedRound(next.map(function (i2) { return jobAt.get(i2); }));
        }
    } finally {
        if (typeof o.releaseFrames === 'function') o.releaseFrames();
    }
    if (!crops) return failure('No crops could be embedded');

    // ---- per camera: centre, learn the identity metric (weighted: backgroundWeights), score the contacts
    var sampleWeight = backgroundWeights(grid, o, every, st);
    var cams = Array.from(perCam.keys());
    if (rounds > 1) {                              // in sample order, as one round leaves them: the fit sums in row order
        perCam.forEach(function (v) {
            var ix = v.rows.map(function (r, j) { return j; }).sort(function (a, b) { return v.rows[a] - v.rows[b] || a - b; });
            v.rows = ix.map(function (j) { return v.rows[j]; }); v.vecs = ix.map(function (j) { return v.vecs[j]; });
        });
    }
    var scored = await scoreContacts(grid, cams.map(function (c) { return perCam.get(c); }), o, every, true,
        progress ? function (d, t) { return progress('fit', d, t); } : null, sampleWeight);
    return result(grid, scored, o, { cue: 'image', imageHz: imgHz, crops: crops, cameras: cams,
        // how many of the image samples were embedded (planImageSamples), in how many rounds
        samples: { embedded: answered, of: jobAt.size, rounds: rounds } });
}

// ---------------------------------------------------------------------------
// The coat-brightness check: the classifier both other checks used before
// #309 / #310 (fitted to the tracker's own labels), kept for brightness, whose
// calibration and candidate-moment rows were measured on it.
// ---------------------------------------------------------------------------

/** Sample rate (Hz) the score scale and the size threshold were calibrated at. */
export const REFERENCE_HZ = 15;

/** The classifier's options (the coat-brightness check's base; the size check's before #310). */
export const CLASSIFIER_CHECK_DEFAULTS = {
    fps: null,          // REQUIRED: the recording's frame rate
    sampleHz: 15,       // encounter grid: analyse ~this many frames per second (every round(fps / sampleHz)-th)
    folds: 5,           // blocked cross-validation folds over time
    gapSeconds: 10,     // excluded either side of a test fold
    syncSeconds: 1,     // both animals must resume their own tracklets within this of each other
    threshold: -50,     // a run of flagged encounters STARTS at an encounter scoring below this...
    continueBelow: 0,   // ...and continues while the pair's next encounters still score below this
                        // (hysteresis: a persisting switch keeps scoring negative, if not always < -50)
    followSeconds: 60,  // a change point this soon after one sharing an identity is its follow-on
    skipEmpty: false,   // runs ignore encounters scoring exactly 0 (no samples on either side, so no evidence);
                        // on for single-camera sessions (pose/single-camera-tracking.js `singleCameraCheckOptions`)
    clearestEndLeads: false, // among encounter 'end' rows within 5 s sharing an animal, the clearest leads (see
                        // linkFollowOns); on for single-camera sessions
    minTrackedSeconds: 60, // refuse with less tracked data than this: the model can't be learned reliably
    sepFactor: 0.65,    // "close" = centroids nearer than sepFactor x median body extent
    sepDistance: null,  // override the close distance directly (world units)
    maxTrainRows: 20000,
    iterations: 300,
    signal: null,       // AbortSignal: the check throws an AbortError when it fires
    moments: null,      // places a switch may have happened outside a close encounter: [{frame, startFrame,
                        // identityA, identityB, cues}] (pose/single-camera-tracking.js `candidateMoments`). Each is
                        // tested on its own: do the labels before it and after it disagree? See momentChangePoints.
    momentSeconds: 15,  // evidence read on EACH side of a moment
    momentThreshold: -200, // a moment is a change point when its two sides disagree by more than this
                           // (calibrated 2026-10-07 on images, see MODULES.md: 13 of 59 real swaps, 0 false rows)
};

/**
 * Coat-brightness check: the image and size checks' PREVIOUS scoring (a classifier
 * fitted to the tracker's labels — checkClassifierSwitches) on a much cheaper vector —
 * the brightness of the coat at each animal's body keypoints
 * (ui/brightness-sampler.js: 10th / 50th / 90th percentile and mean of the grey
 * level in a small disc at each body keypoint, log-scaled). No model and no GPU,
 * only the decoded video. The same provider options as the image check (`getEmbeddings`
 * returns these vectors), with BRIGHTNESS_CHECK_DEFAULTS. Unlike the other two checks it
 * also tests candidate moments (`opts.moments`) and takes the single-camera options. Result `cue:
 * 'brightness'`; `imageHz` / `crops` / `cameras` are its sample rate, samples
 * and views.
 */
export async function checkBrightnessSwitches(session, opts) {
    return checkClassifierSwitches(session, Object.assign({}, BRIGHTNESS_CHECK_DEFAULTS, opts || {}), 'brightness');
}

/**
 * Brightness-check options on top of the classifier's (CLASSIFIER_CHECK_DEFAULTS). Calibrated 2026-10-08 on
 * 35 proofread single-camera SLAP videos (3–4 mice of different coat colours, 59
 * real switches after single-camera Track All): its candidate-moment rows caught
 * 14 with no false rows — 12 of them the same switches the image check's moment
 * rows catch (13) — while its ENCOUNTER rows were noise at every threshold (-200:
 * 3 real, 34 false; -800: 0 and 9), hence the strict encounter threshold. Not
 * calibrated on multi-camera data.
 */
export const BRIGHTNESS_CHECK_DEFAULTS = Object.assign({}, CLASSIFIER_CHECK_DEFAULTS, {
    imageHz: 4,         // samples per second per animal and view: no model, so it can sample densely
    threshold: -800,    // encounter rows: see above
    pcaDims: 8,         // the vectors are 4-dimensional; PCA keeps them whole
    maxTrainRows: 6000,
    iterations: 200,
    getEmbeddings: null,   // REQUIRED: async (frame, items[{k, group}]) -> per item [{camera, vector}];
                           // STARTED in increasing frame order, at most `inFlight` in flight
    inFlight: 2,
    prepareFrames: null,   // optional, as for the image check
    releaseFrames: null,
});

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
 * The classifier's encounters: per identity pair, the last close sample of each
 * close spell after which BOTH animals resume a tracklet (apart from everyone)
 * within `o.syncSeconds` of each other — one encounter per pair of tracklets.
 * `finish` scores each by those two tracklets' evidence. (The label-free checks
 * score contact episodes instead, `contactEpisodes`.)
 * @returns {Array<{a, b, start, end, ta, tb}>} sample indices and tracklets
 */
function trackletEncounters(grid, o) {
    var T = grid.T, K = grid.K, C = grid.C, sep = grid.sep, tl = grid.tl;
    var dist = function (i, a, b) {
        if (!grid.hasCen(i, a) || !grid.hasCen(i, b)) return Infinity;
        var r1 = (i * K + a) * 3, r2 = (i * K + b) * 3;
        return Math.hypot(C[r1] - C[r2], C[r1 + 1] - C[r2 + 1], C[r1 + 2] - C[r2 + 2]);
    };
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
                if (ta && tb && Math.abs(ta.start - tb.start) <= grid.secToSamples(o.syncSeconds)) {
                    var key = tl.indexOf(ta) + ':' + tl.indexOf(tb);
                    if (!seenPair.has(key)) { seenPair.add(key); enc.push({ a: a, b: bb, start: startClose, end: i3, ta: ta, tb: tb }); }
                }
                startClose = -1;
            }
        }
    }
    return enc;
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
 * Within-frame contrast, encounter scores and change points (the coat-brightness check).
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
    // Candidate moments are tested separately: encounters score and flag exactly as without them, and only
    // which change points are listed changes (a moment's row can take over an encounter's, momentChangePoints).
    var moments = o.moments && o.moments.length ? testMoments(grid, LP, present, weight, o) : [];
    var added = moments.length ? momentChangePoints(moments, scored, changes, o) : [];
    var byFrame = function (x, y) { return x.frame - y.frame; };
    var flags = scored.filter(function (s) { return s.flagged; })
        .concat(added.filter(function (m) { return m.kind !== 'end'; })).sort(byFrame);
    changes = changes.concat(added.filter(function (m) { return m.kind === 'end'; })).sort(byFrame);
    return Object.assign({
        ok: true, flags: flags, changes: changes, encounters: scored, moments: moments,
        identities: idents.map(function (id) { return id.name; }),
        sampledFrames: T, closeDistance: grid.sep, threshold: o.threshold, continueBelow: o.continueBelow, skipEmpty: !!o.skipEmpty, clearestEndLeads: !!o.clearestEndLeads,
        fps: o.fps, step: grid.step, sampleHz: grid.hz,
    }, extra || {});
}

/**
 * Test each of `o.moments` — a place a switch may have happened outside a close
 * encounter — on its own. The evidence for "a is a, b is b" (a-as-a against
 * a-as-b, and b-as-b against b-as-a) is summed over the `momentSeconds` BEFORE
 * the moment and, separately, the `momentSeconds` AFTER it, from samples in
 * which each animal is apart from every other. If the labels changed there, the
 * two sides disagree in sign; the score is then minus the weaker side's evidence
 * (so a confident change is very negative), and otherwise plus it.
 *
 * Why both sides: the classifier learns from the tracker's own labels, so when a
 * swap covers MOST of the session it is the swapped labelling that reads as
 * right, and evidence after the swap alone agrees with it. Which side disagrees
 * (`side`) says which one to fix. Measured on 35 proofread single-camera SLAP
 * videos with the image check: reading only after each moment added 1 of 59 real
 * swaps; the two-sided test adds 7 (13 on its own at -200, with no false rows).
 * Windows are fixed, NOT cut at the pair's neighbouring encounters: mice in
 * contact meet every few seconds, and cut windows left almost no evidence.
 * A moment with no evidence on either side is skipped. Returns every tested
 * moment, sorted by frame: {frame, startFrame, identityA, identityB, nameA,
 * nameB, score, side: 'before'|'after', look: cues}.
 */
function testMoments(grid, LP, present, weight, o) {
    var T = grid.T, K = grid.K, frames = grid.frames, idents = grid.idents, out = [];
    var kOf = new Map(idents.map(function (id, k) { return [id.id, k]; }));
    var alone = new Uint8Array(T * K);
    grid.tl.forEach(function (t) { for (var i = t.start; i <= t.end; i++) alone[i * K + t.k] = 1; });
    var sampleOf = function (f) {             // last sample at or before frame f, or -1
        if (!(f >= frames[0])) return -1;
        var lo = 0, hi = T - 1;
        while (lo < hi) { var m = (lo + hi + 1) >> 1; if (frames[m] <= f) lo = m; else hi = m - 1; }
        return lo;
    };
    var W = grid.secToSamples(o.momentSeconds);
    var side = function (a, b, i0, i1) {      // evidence that a is a and b is b over samples [i0, i1]
        var S = 0, n = 0;
        for (var i = Math.max(0, i0); i <= Math.min(T - 1, i1); i++) {
            if (alone[i * K + a] && present(i, a)) { S += LP[(i * K + a) * K + a] - LP[(i * K + a) * K + b]; n++; }
            if (alone[i * K + b] && present(i, b)) { S += LP[(i * K + b) * K + b] - LP[(i * K + b) * K + a]; n++; }
        }
        return n ? S * weight : null;
    };
    o.moments.forEach(function (m) {
        var a = kOf.get(m.identityA), b = kOf.get(m.identityB), e = sampleOf(m.frame);
        if (a == null || b == null || a === b || e < 0) return;
        var s0 = Math.max(0, Math.min(e, sampleOf(m.startFrame != null ? m.startFrame : m.frame)));
        var before = side(a, b, s0 - W, s0 - 1), after = side(a, b, e + 1, e + W);
        if (before == null || after == null) return;
        var mag = Math.min(Math.abs(before), Math.abs(after));
        var lo = Math.min(a, b), hi = Math.max(a, b);
        out.push({ frame: frames[e], startFrame: frames[s0], identityA: idents[lo].id, identityB: idents[hi].id,
                   nameA: idents[lo].name, nameB: idents[hi].name, score: (before < 0) !== (after < 0) ? -mag : mag,
                   side: after < 0 ? 'after' : 'before', look: (m.cues || []).slice() });
    });
    return out.sort(function (x, y) { return x.frame - y.frame; });
}

/**
 * The tested moments that become change points, merged with the encounters'
 * (mutates `scored` and `changes`; returns the moment change points to add).
 *
 * A moment scoring below `momentThreshold` is a change point unless one of the
 * pair's encounter change points is within 3 s (that one stands): an 'onset'
 * when its AFTER side disagrees (the stretch after it looks swapped), an 'end'
 * when its BEFORE side does. One swapped stretch keeps ONE row, and so one fix:
 *  - An onset absorbs the pair's flagged run it starts: the run's encounters
 *    after it (continuing while flagged or below `continueBelow`, as a run
 *    does), and the run's first encounter just BEFORE it, whose evidence window
 *    runs across the moment (the reason moments exist). That run's onset row
 *    becomes a repeat; `switchBackAt` = the first encounter after it that reads
 *    right again (whose 'end' row, if any, now pairs with the moment), else the
 *    pair's next moment, else null (to the session's end).
 *  - An 'end' closes the flagged run before it: `switchedAt` = the run's onset
 *    row, whose `switchBackAt` becomes the moment, and the run's own 'end' row
 *    is dropped. With no run before it, `switchedAt` = the pair's last
 *    encounter that reads right (its stretch runs back through encounters still
 *    reading swapped, below `continueBelow`, as a run does going forward), else
 *    its previous moment, else null (from the session's start). An 'end' whose
 *    previous same-pair moment is an 'end' with nothing reading right between
 *    them saw the same swapped stretch (an animal back from out of sight several
 *    times after one swap): that row stands for it, and it adds none. Two moments
 *    of the same pair on the same side within 3 s (a near-tie and a return at one
 *    contact) are one row, with both cues and the clearer score. "Before it" means ended before the
 *    moment's own contact began: an encounter ending inside that contact is
 *    the moment itself, and its score describes the labels AFTER it.
 * Encounters scoring exactly 0 (no samples on either side) are skipped: they
 * neither continue nor end a stretch, and an 'end' row on one inside the
 * stretch is dropped.
 * A moment contradicting a run is skipped — an onset after two of the run's
 * encounters, an 'end' with the run still flagged after it — so no two rows'
 * fixes overlap. Follow-ons (`followOf`) are then re-linked over every row.
 * Exported, like markChangePoints, so it can be tested on hand-made scores.
 * @param {Array} moments  tested moments (testMoments), sorted by frame
 * @param {Array} scored   encounters, sorted by frame, after markChangePoints
 * @param {Array} changes  markChangePoints' 'end' change points
 * @param {object} o       momentThreshold, continueBelow, followSeconds, fps
 */
export function momentChangePoints(moments, scored, changes, o) {
    var near = 3 * o.fps, out = [];
    var samePair = function (x, y) { return x.identityA === y.identityA && x.identityB === y.identityB; };
    var rows = scored.filter(function (x) { return x.flagged && !x.continues; }).concat(changes);
    // The pair's encounters that carry evidence, by frame (scored is sorted). A score of exactly 0 had no
    // samples on either side: it says nothing about the labels, so a stretch runs through it.
    var pairOf = new Map();
    var encounters = function (m) {
        var key = m.identityA + ':' + m.identityB;
        if (!pairOf.has(key)) pairOf.set(key, scored.filter(function (x) { return samePair(x, m) && (x.flagged || x.score !== 0); }));
        return pairOf.get(key);
    };
    var dropEnds = function (m, lo, hi) {     // the pair's encounter 'end' rows inside a merged stretch (lo, hi]
        for (var c = changes.length - 1; c >= 0; c--) if (samePair(changes[c], m) && changes[c].frame > lo && changes[c].frame <= hi) changes.splice(c, 1);
    };
    var after = function (L, f) { var i = 0; while (i < L.length && L[i].frame <= f) i++; return i; };
    // An 'end' reads the stretch BEFORE it from encounters that ended before its own contact began: one
    // ending inside the contact is the moment itself, and its score is about the labels AFTER it.
    var beforeContact = function (L, m) { return after(L, (m.startFrame != null && m.startFrame <= m.frame ? m.startFrame : m.frame) - 1); };
    moments.forEach(function (m) {
        if (!(m.score < o.momentThreshold)) return;
        if (rows.some(function (x) { return samePair(x, m) && Math.abs(x.frame - m.frame) < near; })) return;
        var L = encounters(m), i = after(L, m.frame), next = L[i];
        var prev = L[(m.side === 'after' ? i : beforeContact(L, m)) - 1];
        if (m.side === 'after' ? prev && prev.flagged && i >= 2 && L[i - 2].flagged
            : next && next.flagged && (prev ? prev.flagged : next.continues)) return;
        // the same pair's moment on the same side within 3 s (a near-tie and a return at one contact) is the same
        // change point: one row, with both cues and the clearer score
        var twin = out.filter(function (x) { return samePair(x, m) && x.side === m.side && Math.abs(x.frame - m.frame) < near; })[0];
        if (twin) {
            (m.look || []).forEach(function (c) { if (twin.look.indexOf(c) < 0) twin.look.push(c); });
            if (m.score < twin.score) twin.score = m.score;
            return;
        }
        out.push(Object.assign({}, m, { flagged: m.side === 'after', continues: false, kind: m.side === 'after' ? 'onset' : 'end',
                                        look: (m.look || []).slice() }));
    });
    var demote = function (e) {               // an encounter row the moment's row takes over: now a repeat
        if (e.kind !== 'onset' || e.continues) return;
        e.continues = true; delete e.kind; delete e.switchBackAt; delete e.followOf;
    };
    out.forEach(function (m) {
        var L = encounters(m), i = after(L, m.frame);
        var mine = out.filter(function (x) { return x !== m && samePair(x, m); });
        if (m.kind === 'onset') {
            var lim = mine.filter(function (x) { return x.frame > m.frame; })[0], stop = null;
            var lo0 = mine.filter(function (x) { return x.frame < m.frame; }).pop();
            if (L[i - 1] && L[i - 1].flagged && !(lo0 && lo0.frame >= L[i - 1].frame)) demote(L[i - 1]);
            for (var j = i; j < L.length && !(lim && L[j].frame >= lim.frame); j++) {
                if (L[j].flagged || L[j].score < o.continueBelow) { demote(L[j]); continue; }
                stop = L[j]; break;
            }
            m.switchBackAt = stop ? stop.frame : lim ? lim.frame : null;
            dropEnds(m, m.frame, (stop ? stop.frame : lim ? lim.frame : Infinity) - 1);
            if (stop) changes.forEach(function (c) { if (samePair(c, m) && c.frame === stop.frame) c.switchedAt = m.frame; });
        } else {
            var ib = beforeContact(L, m), lo = mine.filter(function (x) { return x.frame < m.frame; }).pop(), first = null, k = ib - 1;
            // back through the pair's encounters still reading swapped — flagged, or below `continueBelow`, the
            // hysteresis a run uses going forward — to the last one that reads right
            for (; k >= 0 && !(lo && L[k].frame <= lo.frame) && (L[k].flagged || L[k].score < o.continueBelow); k--) first = L[k];
            var before = k >= 0 && !(lo && L[k].frame <= lo.frame) ? L[k] : null;
            // the pair's previous 'end' with nothing reading right between them saw the same swapped stretch:
            // that row stands for both (several returns of the same animals after one swap)
            if (lo && lo.kind === 'end' && !before) { m.sameStretchAs = lo; return; }
            if (first && first.kind === 'onset' && !first.continues) { m.switchedAt = first.frame; first.switchBackAt = m.frame; }
            else m.switchedAt = before ? before.frame : lo ? lo.frame : null;
            if (first) {
                for (var r = k + 1; r < ib; r++) if (L[r] !== first) demote(L[r]);   // later runs inside the stretch
                dropEnds(m, first.frame, L[i] ? L[i].frame : Infinity);
            }
        }
    });
    out = out.filter(function (m) { return !m.sameStretchAs; });
    if (out.length) {
        var primary = scored.filter(function (x) { return x.kind === 'onset' && !x.continues; }).concat(changes, out);
        primary.forEach(function (x) { delete x.followOf; });
        linkFollowOns(primary.sort(function (x, y) { return x.frame - y.frame; }), o);
    }
    return out;
}

/**
 * Follow-ons: after a switch, each swapped identity carries the wrong label into
 * its encounters with OTHER animals too, so those surface as change points of
 * their own. Link a change point to an earlier one (of a different pair) that
 * shares an identity and lies within `followSeconds` (`followOf`).
 *
 * Candidate moments (single camera only) change this twice:
 *  - A moment's change point is NEVER a follow-on. It was tested on both sides
 *    of its own place (13 of 13 real on the 35 proofread SLAP videos), so it is
 *    not another row's echo — while following any earlier row within 60 s that
 *    shares an animal hid 4 real swaps there behind false primaries up to 25 s
 *    before them. Making them primaries: the swapped pair's row the primary in 17
 *    of 23 swaps instead of 13, 9 fully undone by Fixing the primaries instead of
 *    8, false primaries 29 -> 28 (brightness: 12 of 15 instead of 10).
 *  - It also outranks encounter change points up to 3 s BEFORE it: it is taken
 *    as if it came 3 s earlier, so they follow it (an encounter row of another
 *    pair a second or two away is usually the swapped animal's wrong label).
 * With `o.clearestEndLeads` (single camera, `singleCameraCheckOptions`), among
 * encounter 'end' change points within 5 s of each other that share an animal,
 * the one whose labels read right again most clearly (highest score) leads, as
 * if it came first. After an early swap (the swapped labelling is the majority)
 * the other pairs of a swapped animal read right again too, and their encounter
 * windows can run past the swap, so their 'end' rows come a second or two BEFORE
 * the swapped pair's: on one SLAP video +69, +37 and +36 led the real +444.
 * Without moments or the option (every multi-camera check) the order is plain time.
 * @param {Array} primary  change points sorted by frame
 */
function linkFollowOns(primary, o) {
    var lead = 3 * o.fps, eff = new Map();
    var at = function (x) { return eff.has(x) ? eff.get(x) : x.look ? x.frame - lead : x.frame; };
    var shareOne = function (a, b) {
        return [a.identityA, a.identityB].filter(function (id) { return id === b.identityA || id === b.identityB; }).length === 1;
    };
    if (o.clearestEndLeads) {
        var ends = primary.filter(function (x) { return !x.look && x.kind === 'end'; }), seen = new Set();
        ends.forEach(function (x) {
            if (seen.has(x)) return;
            var g = [x];                                 // x's group: 'end' rows linked by <= 5 s and one shared animal
            for (var gi = 0; gi < g.length; gi++) ends.forEach(function (y) {
                if (g.indexOf(y) < 0 && Math.abs(y.frame - g[gi].frame) <= 5 * o.fps && shareOne(y, g[gi])) g.push(y);
            });
            g.forEach(function (y) { seen.add(y); });
            var best = g.reduce(function (b, y) { return y.score > b.score ? y : b; }, g[0]);
            var first = g.reduce(function (f, y) { return Math.min(f, y.frame); }, Infinity);
            if (best.frame !== first) eff.set(best, first - 1);
        });
    }
    if (eff.size || primary.some(function (x) { return x.look; })) {
        primary = primary.slice().sort(function (x, y) { return at(x) - at(y) || x.frame - y.frame; });
    }
    for (var pi = 0; pi < primary.length; pi++) {
        var cur = primary[pi];
        if (cur.look) continue;                        // a moment is never a follow-on
        for (var pj = pi - 1; pj >= 0; pj--) {
            var prev = primary[pj];
            if (at(cur) - at(prev) > o.followSeconds * o.fps) break;
            if (prev.followOf != null) continue;
            if (shareOne(prev, cur)) { cur.followOf = prev.frame; break; }
        }
    }
}

/**
 * Mark change points on scored encounters (mutates them: `flagged`,
 * `continues`, `kind`, `followOf`) and return the `kind: 'end'` change points.
 * Exported so the threshold can be re-applied to the same scores (calibration)
 * without re-running a check. `o` needs threshold, continueBelow, followSeconds, fps (and `skipEmpty`, optional).
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
    byPair.forEach(function (L0) {
        // `skipEmpty`: an encounter scoring exactly 0 had no samples on either side, so it says nothing about
        // the labels. Runs are then found among the others, and a 0 inside a run's stretch is one of its repeats.
        var L = o.skipEmpty ? L0.filter(function (sc) { return sc.score !== 0; }) : L0;
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
        if (L !== L0) {
            var prevEv = null, k0 = 0;
            L0.forEach(function (sc) {
                if (sc.score !== 0) { prevEv = sc; k0++; return; }
                if (prevEv ? prevEv.flagged : (L[k0] && L[k0].flagged)) { sc.flagged = true; sc.continues = true; }
            });
        }
    });
    changes.sort(function (x, y) { return x.frame - y.frame; });
    linkFollowOns(scored.filter(function (x) { return x.kind === 'onset'; }).concat(changes)
        .sort(function (x, y) { return x.frame - y.frame; }), o);
    return changes;
}

/**
 * The coat-brightness check's scoring — the image check's before #309 (and the size check's before #310): a
 * vector per (sample, animal, view),
 * one blocked-CV classifier per view fitted to the tracker's labels, then `finish` (encounters, change
 * points, candidate moments tested on both sides). Brightness was calibrated on it (see
 * BRIGHTNESS_CHECK_DEFAULTS); the image and size checks now score label-free (scoreContacts).
 */
async function checkClassifierSwitches(session, o, cue) {
    if (typeof o.getEmbeddings !== 'function') return failure(cue === 'image' ? 'No image embedder available' : 'No brightness sampler available');
    var grid = buildGrid(session, o, false);
    if (grid.fail) return failure(grid.fail);
    grid.enc = trackletEncounters(grid, o);
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
    if (!crops) return failure(cue === 'image' ? 'No crops could be embedded' : 'No coat brightness could be sampled');

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
        { cue: cue, imageHz: imgHz, crops: crops, cameras: cams });
    if (progress) await progress('fit', cams.length * o.folds, cams.length * o.folds);
    return res;
}
