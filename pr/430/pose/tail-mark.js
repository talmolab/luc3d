/**
 * pose/tail-mark.js — which of two tracked identities is the animal with dark
 * bands painted on its tail, at every moment of a session. DOM-free: pixels come
 * from a provider (`ui/tail-mark-reader.js` in the app).
 *
 * Two white mice look the same to a tracker, which keeps their labels only by
 * following them, so the labels can change hands when they touch. A band of dark
 * marks on one tail settles it from the video: Track All runs as usual, then
 * `resolveTailMarks` reads each identity's tail in every camera at sampled frames
 * and swaps the identities over every stretch where the wrong one holds the marks.
 *
 * What marks look like differs from animal to animal (narrow bands, or one wide one),
 * and a plain tail in the shade by a wall dims along part of its length in every
 * camera, so no fixed measure tells them apart. What holds is that marks stay at the
 * same place along that animal's tail while shade moves with the arena. So each
 * session teaches the pass its own patterns (`learnTailTemplates`): the samples where
 * one tail reads far more banded than the other (`tailBandScore`) give a marked and a
 * plain brightness profile, position by position. Then every view of every tail votes
 * (`tailVote`): marked, plain, or, when it fits neither, nothing.
 *
 * The decision (`decodeMarkedStates`) is a two-state Viterbi over the samples: the
 * state is which identity holds the marks; a sample costs what its votes contradict;
 * a change costs little across a contact and more elsewhere, since labels change
 * hands when the animals touch.
 */

import { buildGrid, contactEpisodes, SIZE_CHECK_DEFAULTS } from './id-switch-check.js?v=6a08874aa4a2';

export const TAIL_MARK_DEFAULTS = {
    /** The profile's length: positions read along the tail, whatever its length in pixels. */
    profileLength: 64,
    /** The widest gap the banding score counts, in profile positions. */
    bandWindow: 25,
    /** Below this many pixels from base to end, a tail is too foreshortened to show bands. */
    minTailPixels: 16,
    /** A sample teaches the templates when one tail's banding is this many times the other's... */
    teachRatio: 2,
    /** ...and at least this. */
    teachMinScore: 0.03,
    /**
     * A session has marks when at least this share of its samples teach (and this many),
     * and the two templates differ by this (RMS). Over the 96 test recordings the share
     * was 0.50-0.98; on two plain tails, 0.23, and the pass would have relabelled them 30
     * times from noise.
     */
    minTeachingShare: 0.4,
    /**
     * Below this share the marks are faint, and the result says to check it: on the test
     * recordings the three sessions under it were the ones the eye could not confirm, and
     * in one of them body size disagreed with a relabelled stretch.
     */
    faintTeachingShare: 0.75,
    minTeachingSamples: 10,
    minTemplateDifference: 0.03,
    /** How far a profile may slide along the template, in positions (keypoints move along the tail). */
    maxShift: 4,
    /** A view votes nothing when its nearer template is further than this share of the templates' own distance. */
    fitTolerance: 0.5,
    /** What a sample costs when it contradicts the state, at most (1 = the session's typical sample). */
    maxSampleCost: 2,
    /** What a label change costs across a contact, and across a gap with no contact. */
    contactChangeCost: 1,
    apartChangeCost: 2.5,
    /** Finding a change's frame stops when it is bracketed this closely (seconds). */
    refineSeconds: 0.1,
    /** Ignore a sample in refining when its evidence is below this share of the typical sample. */
    refineMinEvidence: 0.25,
};

/**
 * How the band-counting cue reads a tail (`ui/tail-mark-reader.js`). Bands packed near the
 * base (4 bands with 3 short bright gaps before Tail_0) blur in the two-animal pass's wide,
 * bright line (`readTailProfile`'s defaults: 0.85 percentile, 1/12 of the length each side),
 * and the base keypoint often lands past the first band. On a 5-mouse recording with 0-4
 * bands the default read counted the 4-band tail as 3; this read counts all five right.
 * The two-animal pass keeps its validated read.
 */
export const TAIL_BAND_READ = { baseExtension: 0.2, percentile: 0.5, widthShare: 1 / 30 };

/** The largest number of frames the sampler may leave between samples, in seconds. */
export const MAX_SAMPLE_GAP_SECONDS = 3;

/**
 * The tail nodes to read, base first: a TTI / tail-base node, then numbered tail
 * nodes, the first two. On the test skeleton: TTI, Tail_0, Tail_1 (the marks end
 * near Tail_1). Node names, so any skeleton naming them this way works.
 * @param {string[]} nodes  the skeleton's node names
 * @returns {?number[]}  node indices, or null when the skeleton has no such nodes
 */
export function tailMarkNodeIndices(nodes) {
    var names = (nodes || []).map(function (n) { return typeof n === 'string' ? n : (n && n.name) || ''; });
    var base = names.findIndex(function (n) { return /^(tti|tail_?base|base_?of_?tail)$/i.test(n); });
    var numbered = [];
    names.forEach(function (n, i) {
        var m = /^tail_?(\d+)$/i.exec(n);
        if (m) numbered.push({ i: i, at: Number(m[1]) });
    });
    numbered.sort(function (a, b) { return a.at - b.at; });
    if (base < 0 || !numbered.length) return null;
    return [base].concat(numbered.slice(0, 2).map(function (x) { return x.i; }));
}

/**
 * The brightness along a tail: at each pixel of its length, a bright percentile of
 * a line across it (keypoints sit a few pixels off the tail, and a line across
 * forgives that), resampled to `length` positions.
 *
 * @param {Uint8Array|Uint8ClampedArray} gray  width*height
 * @param {number} width
 * @param {number} height
 * @param {number[]} poly  [x0, y0, x1, y1, …] in `gray`'s pixels; non-finite points are left out
 * @param {number} [length]
 * @param {{percentile?: number, widthShare?: number}} [opts]  the percentile across (default 0.85)
 *   and the line's half width as a share of the tail's length (default 1/12)
 * @returns {?{profile: Float32Array, background: number}}  null when too short to read
 */
export function readTailProfile(gray, width, height, poly, length, opts) {
    length = length || TAIL_MARK_DEFAULTS.profileLength;
    var q = (opts && opts.percentile) || 0.85, share = (opts && opts.widthShare) || 1 / 12;
    var xs = [], ys = [], cum = [0];
    for (var p = 0; p + 1 < poly.length; p += 2) {
        var px = poly[p], py = poly[p + 1];
        if (!isFinite(px) || !isFinite(py)) continue;
        if (xs.length) {
            var d = Math.hypot(px - xs[xs.length - 1], py - ys[ys.length - 1]);
            if (d <= 0) continue;
            cum.push(cum[cum.length - 1] + d);
        }
        xs.push(px); ys.push(py);
    }
    var total = cum[cum.length - 1];
    if (xs.length < 2 || total < TAIL_MARK_DEFAULTS.minTailPixels) return null;
    var half = Math.max(3, Math.round(total * share));   // about the tail's width and its keypoints' error
    var nSteps = Math.floor(total), across = 2 * half + 1;
    var line = new Float32Array(nSteps), all = new Float32Array(nSteps * across), nAll = 0;
    var row = new Float32Array(across), seg = 0;
    for (var s = 0; s < nSteps; s++) {
        while (seg < cum.length - 2 && cum[seg + 1] <= s) seg++;
        var len = cum[seg + 1] - cum[seg], t = (s - cum[seg]) / len;
        var dx = (xs[seg + 1] - xs[seg]) / len, dy = (ys[seg + 1] - ys[seg]) / len;
        var cx = xs[seg] + t * (xs[seg + 1] - xs[seg]), cy = ys[seg] + t * (ys[seg + 1] - ys[seg]);
        var n = 0;
        for (var o = -half; o <= half; o++) {
            var ix = Math.round(cx - dy * o), iy = Math.round(cy + dx * o);
            if (ix < 0 || iy < 0 || ix >= width || iy >= height) continue;
            var v = gray[iy * width + ix];
            row[n++] = v; all[nAll++] = v;
        }
        line[s] = n ? percentileOf(row.subarray(0, n), q) : NaN;
    }
    if (!nAll) return null;
    var profile = new Float32Array(length);
    for (var i = 0; i < length; i++) {
        var at = i * (nSteps - 1) / (length - 1), a = Math.floor(at), b = Math.min(nSteps - 1, a + 1);
        profile[i] = line[a] + (at - a) * (line[b] - line[a]);
    }
    return { profile: profile, background: percentileOf(all.subarray(0, nAll), 0.10) };
}

// In place: sorts `values`.
function percentileOf(values, q) {
    values.sort();
    var at = q * (values.length - 1), a = Math.floor(at), b = Math.min(values.length - 1, a + 1);
    return values[a] + (at - a) * (values[b] - values[a]);
}

/**
 * A profile as a share of the tail's own brightness: the background taken off, lightly
 * smoothed, capped at the median (so a bright body at an end adds nothing).
 * @param {Float32Array|number[]} profile  from `readTailProfile`
 * @param {number} background
 * @returns {?Float32Array}  1 = as bright as the tail; null when there is no tail (as dark as the floor)
 */
export function normalizeTailProfile(profile, background) {
    var n = profile.length;
    if (n < 3) return null;
    var c = new Float32Array(n);
    c[0] = profile[0] - background; c[n - 1] = profile[n - 1] - background;
    for (var i = 1; i < n - 1; i++) c[i] = (profile[i - 1] + profile[i] + profile[i + 1]) / 3 - background;
    var med = Float32Array.from(c).sort()[n >> 1];
    if (!(med > 3)) return null;
    for (var j = 0; j < n; j++) c[j] = Math.max(0, Math.min(c[j] / med, 1));
    return c;
}

/**
 * How banded a tail is: the share of its brightness missing in gaps a `bandWindow`-long
 * bridge would span (a morphological closing of the profile, minus the profile). About
 * 0.01 on a plain tail. Only says which samples to learn from; a shaded tail can read
 * high here, which the templates then sort out.
 * @param {?Float32Array} x  from `normalizeTailProfile`
 * @returns {number}
 */
export function tailBandScore(x) {
    if (!x) return 0;
    var n = x.length, half = TAIL_MARK_DEFAULTS.bandWindow >> 1;
    var at = function (a, k) { return a[Math.max(0, Math.min(n - 1, k))]; };
    var grown = new Float32Array(n), missing = 0, whole = 0;
    for (var g = 0; g < n; g++) {
        var hi = 0;
        for (var o = -half; o <= half; o++) hi = Math.max(hi, at(x, g + o));
        grown[g] = hi;
    }
    for (var h = 0; h < n; h++) {
        var lo = Infinity;
        for (var q = -half; q <= half; q++) lo = Math.min(lo, at(grown, h + q));
        missing += Math.max(0, lo - x[h]);
        whole += lo;
    }
    return whole > 0 ? missing / whole : 0;
}

function medianOf(list) {
    if (!list || !list.length) return 0;
    var v = list.slice().sort(function (x, y) { return x - y; });
    return v[v.length >> 1];
}

// Position by position.
function medianProfile(profiles, n) {
    var out = new Float32Array(n), col = new Float32Array(profiles.length);
    for (var i = 0; i < n; i++) {
        for (var p = 0; p < profiles.length; p++) col[p] = profiles[p][i];
        col.sort();
        out[i] = col[col.length >> 1];
    }
    return out;
}

/**
 * This session's marked and plain tails, learned without labels: in each sample where
 * one tail reads far more banded than the other, its views teach the marked template
 * and the other's the plain one. Medians, so the odd shaded tail among them drops out.
 * @param {Array<?Array<Array<Float32Array>>>} raw  per sample, `[viewsOfA, viewsOfB]`, each from `normalizeTailProfile`
 * @param {Object} [opts]  TAIL_MARK_DEFAULTS overrides
 * @returns {{marked: ?Float32Array, plain: ?Float32Array, teaching: number, difference: number}}
 */
export function learnTailTemplates(raw, opts) {
    var o = Object.assign({}, TAIL_MARK_DEFAULTS, opts || {});
    var hi = [], lo = [], teaching = 0, n = 0;
    raw.forEach(function (r) {
        if (!r || !r[0].length || !r[1].length) return;
        var a = medianOf(r[0].map(tailBandScore)), b = medianOf(r[1].map(tailBandScore));
        var aMarked = a > o.teachRatio * b && a >= o.teachMinScore;
        var bMarked = b > o.teachRatio * a && b >= o.teachMinScore;
        if (!aMarked && !bMarked) return;
        teaching++;
        n = r[0][0].length;
        (aMarked ? r[0] : r[1]).forEach(function (p) { hi.push(p); });
        (aMarked ? r[1] : r[0]).forEach(function (p) { lo.push(p); });
    });
    if (!teaching) return { marked: null, plain: null, teaching: 0, difference: 0 };
    var marked = medianProfile(hi, n), plain = medianProfile(lo, n), sum = 0;
    for (var i = 0; i < n; i++) sum += (marked[i] - plain[i]) * (marked[i] - plain[i]);
    return { marked: marked, plain: plain, teaching: teaching, difference: Math.sqrt(sum / n) };
}

// Squared distance from `x`, slid by up to `maxShift` positions, to `t`.
function nearestFit(x, t, maxShift) {
    var n = x.length, best = Infinity;
    for (var s = -maxShift; s <= maxShift; s++) {
        var e = 0;
        for (var i = 0; i < n; i++) {
            var d = x[Math.max(0, Math.min(n - 1, i - s))] - t[i];
            e += d * d;
        }
        if (e < best) best = e;
    }
    return best;
}

/**
 * One view's vote on one tail.
 * @param {Float32Array} x  from `normalizeTailProfile`
 * @param {{marked: Float32Array, plain: Float32Array}} templates
 * @param {Object} [opts]  TAIL_MARK_DEFAULTS overrides
 * @returns {number}  1 marked, -1 plain, 0 fits neither (a tail in shade, across a body, ...)
 */
export function tailVote(x, templates, opts) {
    var shift = (opts && opts.maxShift != null) ? opts.maxShift : TAIL_MARK_DEFAULTS.maxShift;
    var tol = (opts && opts.fitTolerance != null) ? opts.fitTolerance : TAIL_MARK_DEFAULTS.fitTolerance;
    var eM = nearestFit(x, templates.marked, shift), eP = nearestFit(x, templates.plain, shift), apart = 0;
    for (var i = 0; i < x.length; i++) {
        var d = templates.marked[i] - templates.plain[i];
        apart += d * d;
    }
    if (Math.min(eM, eP) > tol * apart) return 0;
    return eM < eP ? 1 : -1;
}

/**
 * Sample frames: every keyframe (the cheap ones to decode), or one sample per second
 * when the keyframes are further apart than `maxGapSeconds`, or unknown.
 * @param {number[]} frames  the frames that have tracked groups, increasing
 * @param {?ArrayLike<number>} keyframes  of one camera, increasing
 * @param {number} fps
 * @param {number} [maxGapSeconds]  default `MAX_SAMPLE_GAP_SECONDS`; the identity engine asks for
 *   more (`maxSampleGapSeconds`): it reads densely where sparse samples disagree with its decision
 * @returns {number[]}
 */
export function planTailMarkSamples(frames, keyframes, fps, maxGapSeconds) {
    if (!frames.length) return [];
    var maxGap = Math.max(1, Math.round((maxGapSeconds || MAX_SAMPLE_GAP_SECONDS) * fps));
    var out = [];
    if (keyframes && keyframes.length > 1) {
        var first = frames[0], last = frames[frames.length - 1];
        var gaps = [];
        for (var g = 1; g < keyframes.length; g++) gaps.push(keyframes[g] - keyframes[g - 1]);
        gaps.sort(function (a, b) { return a - b; });
        if (gaps[gaps.length >> 1] <= maxGap) {
            for (var k = 0; k < keyframes.length; k++) if (keyframes[k] >= first && keyframes[k] <= last) out.push(keyframes[k]);
            if (out.length) return out;
        }
    }
    var step = Math.max(1, Math.round(fps));
    for (var i = 0; i < frames.length; i += step) out.push(frames[i]);
    return out;
}

/**
 * Which gaps between consecutive samples hold a contact between the two identities.
 * Falls back to "every gap" when the session has no usable 3D: labels can then
 * change anywhere, and the evidence alone decides.
 * @param {Object} session
 * @param {number[]} samples  frames, increasing
 * @param {number} fps
 * @returns {boolean[]} length samples.length - 1
 */
export function contactGaps(session, samples, fps) {
    var out = new Array(Math.max(0, samples.length - 1)).fill(true);
    var grid = buildGrid(session, Object.assign({}, SIZE_CHECK_DEFAULTS, { fps: fps, minTrackedSeconds: 0 }), false);
    if (grid.fail) return out;
    var pair = contactEpisodes(grid, 0).pairs[0];
    if (!pair) return out;
    var runs = pair.eps.map(function (e) { return [grid.frames[e[0]] - grid.step, grid.frames[e[1]] + grid.step]; });
    var r = 0;
    for (var i = 0; i < out.length; i++) {
        while (r < runs.length && runs[r][1] < samples[i]) r++;
        out[i] = r < runs.length && runs[r][0] <= samples[i + 1];
    }
    return out;
}

/**
 * The evidence's scale: the typical sample's difference between the two animals, and
 * per view that read a tail.
 * @param {Array<?{a: number, b: number, views: number}>} evidence
 * @returns {{typical: number, perView: number, used: number}}
 */
export function evidenceScale(evidence) {
    var abs = [], perView = [];
    evidence.forEach(function (e) {
        if (!e || !(e.views > 0)) return;
        var d = Math.abs(e.a - e.b);
        abs.push(d); perView.push(d / e.views);
    });
    var mid = function (v) { v.sort(function (x, y) { return x - y; }); return v.length ? v[v.length >> 1] : 0; };
    return { typical: mid(abs), perView: mid(perView), used: abs.length };
}

/**
 * One sample's evidence: each animal's votes, summed. A plain vote counts against that
 * animal even when the other was not detected in the frame.
 * @param {?Array<number[]>} votes  `[votesOfA, votesOfB]`
 * @returns {?{a: number, b: number, views: number}}
 */
export function evidenceOf(votes) {
    if (!votes) return null;
    var views = Math.max(votes[0].length, votes[1].length);
    if (!views) return null;
    var sum = function (list) { return list.reduce(function (acc, v) { return acc + v; }, 0); };
    return { a: sum(votes[0]), b: sum(votes[1]), views: views };
}

/**
 * The most likely holder of the marks at each sample.
 * @param {Array<?{a: number, b: number}>} evidence  per sample, each identity's score summed over views
 * @param {boolean[]} contact  per gap, from `contactGaps`
 * @param {number} typical  from `evidenceScale`
 * @param {Object} [opts]  TAIL_MARK_DEFAULTS overrides
 * @returns {Uint8Array} per sample: 0 = identity a holds the marks, 1 = identity b
 */
export function decodeMarkedStates(evidence, contact, typical, opts) {
    var o = Object.assign({}, TAIL_MARK_DEFAULTS, opts || {});
    var T = evidence.length, out = new Uint8Array(T);
    if (!T) return out;
    var costOf = function (e, state) {
        if (!e || !(typical > 0)) return 0;
        var d = (e.a - e.b) / typical;             // > 0: a looks marked
        var against = state === 0 ? -d : d;
        return against > 0 ? Math.min(against, o.maxSampleCost) : 0;
    };
    var from = new Uint8Array(T * 2);
    var c0 = costOf(evidence[0], 0), c1 = costOf(evidence[0], 1);
    for (var t = 1; t < T; t++) {
        var change = contact[t - 1] ? o.contactChangeCost : o.apartChangeCost;
        var stay0 = c0, swap0 = c1 + change, stay1 = c1, swap1 = c0 + change;
        from[t * 2] = swap0 < stay0 ? 1 : 0;
        from[t * 2 + 1] = swap1 < stay1 ? 0 : 1;
        c0 = Math.min(stay0, swap0) + costOf(evidence[t], 0);
        c1 = Math.min(stay1, swap1) + costOf(evidence[t], 1);
    }
    var s = c1 < c0 ? 1 : 0;
    for (var b = T - 1; b >= 0; b--) { out[b] = s; s = from[b * 2 + s]; }
    return out;
}

/**
 * The frame a label change lands on, from a sample that says one thing to the next
 * that says the other: bisect, asking `score(frame)` for the evidence. A frame with
 * too little evidence is stepped past (the tails may be hidden there).
 *
 * @param {number} lo  a frame in state `stateLo`
 * @param {number} hi  a frame in the other state
 * @param {number} stateLo  0 or 1
 * @param {(frame: number) => Promise<?{a: number, b: number}>} score
 * @param {number} typical
 * @param {number} fps
 * @param {Object} [opts]
 * @returns {Promise<{frame: number, reads: number}>}  the first frame of the new state
 */
export async function refineChange(lo, hi, stateLo, score, typical, fps, opts) {
    var o = Object.assign({}, TAIL_MARK_DEFAULTS, opts || {});
    var close = Math.max(1, Math.round(o.refineSeconds * fps)), reads = 0;
    while (hi - lo > close) {
        var mid = (lo + hi) >> 1, verdict = null;
        // the middle, then a little either side when the tails are hidden there
        var tries = [mid, mid - Math.round((hi - lo) / 6), mid + Math.round((hi - lo) / 6)];
        for (var i = 0; i < tries.length && verdict == null; i++) {
            if (tries[i] <= lo || tries[i] >= hi) continue;
            var e = await score(tries[i]);
            reads++;
            if (!e || Math.abs(e.a - e.b) < o.refineMinEvidence * typical) continue;
            verdict = { frame: tries[i], state: e.a > e.b ? 0 : 1 };
        }
        if (!verdict) break;   // nothing readable between them: the middle is as good as any frame
        if (verdict.state === stateLo) lo = verdict.frame; else hi = verdict.frame;
    }
    return { frame: hi - lo > close ? (lo + hi) >> 1 : hi, reads: reads };
}

/**
 * The frame ranges to swap so `target` (0 or 1, the identity that should hold the
 * marks) holds them throughout.
 * @param {Array<{frame: number, state: number}>} runs  in order: each from its frame until the next one's
 * @param {number} target
 * @returns {Array<{from: number, to: number}>}  `to` is Infinity for the last
 */
export function stretchesToSwap(runs, target) {
    var out = [];
    runs.forEach(function (r, i) {
        if (r.state === target) return;
        var to = i + 1 < runs.length ? runs[i + 1].frame - 1 : Infinity;
        out.push({ from: i === 0 ? -Infinity : r.frame, to: to });
    });
    return out;
}

/**
 * The whole pass: read the samples, decide who holds the marks when, find each
 * change's frame, and swap labels so `markedName` holds them from start to end.
 *
 * @param {Object} session  tracked, with exactly two identities
 * @param {Object} opts
 * @param {string} opts.markedName  the identity to give the marks (e.g. "id_0")
 * @param {number} opts.fps
 * @param {Object} opts.reader  `{plan(frames) -> Promise<samples[]>, open(samples),
 *   next(frame) -> Promise<evidence>, at(frame) -> Promise<evidence>, close()}`.
 *   Evidence is `{scores: Map<identityId, Float32Array[] per view>}` (each from
 *   `normalizeTailProfile`) or null.
 * @param {(done: number, total: number) => (void|Promise)} [opts.onProgress]  awaited
 * @returns {Promise<Object>}  `{ok: true, faint, swapped, changes, samples, typical, perView,
 *   markedName, stretches, states, sampleFrames, votes, marked, plain, teaching, difference}` or `{ok: false, reason}`
 */
export async function resolveTailMarks(session, opts) {
    var o = Object.assign({}, TAIL_MARK_DEFAULTS, opts);
    var ids = session.identities || [];
    if (ids.length !== 2) return { ok: false, reason: 'needs exactly two identities (found ' + ids.length + ')' };
    var targetIdx = ids.findIndex(function (id) { return id.name === o.markedName; });
    if (targetIdx < 0) return { ok: false, reason: 'no identity is named ' + o.markedName };
    if (!(o.fps > 0)) return { ok: false, reason: 'unknown frame rate' };
    var frames = Array.from(session.instanceGroups.keys()).sort(function (a, b) { return a - b; });
    if (!frames.length) return { ok: false, reason: 'no tracked frames' };

    var idA = ids[0].id, idB = ids[1].id;
    var toViews = function (read) {
        return read ? [read.scores.get(idA) || [], read.scores.get(idB) || []] : null;
    };

    var samples = await o.reader.plan(frames);
    if (!samples.length) return { ok: false, reason: 'no frames to read' };
    var raw = new Array(samples.length);   // per sample, every tail's profile: about 350 KB for a 15-minute session
    await o.reader.open(samples);
    try {
        for (var i = 0; i < samples.length; i++) {
            raw[i] = toViews(await o.reader.next(samples[i]));
            if (o.onProgress) await o.onProgress(i + 1, samples.length);
        }
    } finally { o.reader.close(); }

    if (!raw.some(function (r) { return r && (r[0].length || r[1].length); })) {
        return { ok: false, reason: 'could not read any tail (are the videos loaded?)' };
    }
    var templates = learnTailTemplates(raw, o);
    var study = { sampleFrames: samples, teaching: templates.teaching, difference: templates.difference,
        marked: templates.marked && Array.from(templates.marked), plain: templates.plain && Array.from(templates.plain) };
    if (templates.teaching < o.minTeachingSamples || templates.teaching < o.minTeachingShare * samples.length ||
        templates.difference < o.minTemplateDifference) {
        return Object.assign({ ok: false, reason: 'found no tail marks: both tails look the same' }, study);
    }
    var voteAll = function (views) {
        return views ? views.map(function (list) { return list.map(function (x) { return tailVote(x, templates, o); }); }) : null;
    };
    var votes = raw.map(voteAll);
    var evidence = votes.map(evidenceOf);
    var scale = evidenceScale(evidence);
    if (!(scale.typical > 0)) return Object.assign({ ok: false, reason: 'found no tail marks: the tails do not vote' }, study);

    var contact = contactGaps(session, samples, o.fps);
    var states = decodeMarkedStates(evidence, contact, scale.typical, o);
    var runs = [{ frame: samples[0], state: states[0] }], reads = 0;
    var scoreAt = async function (f) { return evidenceOf(voteAll(toViews(await o.reader.at(f)))); };
    for (var t = 1; t < samples.length; t++) {
        if (states[t] === states[t - 1]) continue;
        var ref = await refineChange(samples[t - 1], samples[t], states[t - 1], scoreAt, scale.typical, o.fps, o);
        reads += ref.reads;
        runs.push({ frame: ref.frame, state: states[t] });
    }

    var stretches = stretchesToSwap(runs, targetIdx);
    stretches.forEach(function (s) { session.swapIdentitiesInRange(s.from, s.to, idA, idB); });
    return Object.assign({
        ok: true, markedName: o.markedName, faint: templates.teaching < o.faintTeachingShare * samples.length,
        swapped: stretches.length, changes: runs.length - 1, stretches: stretches, runs: runs,
        samples: samples.length, reads: reads, typical: scale.typical, perView: scale.perView,
        // for the study harness: what was decided, against the labels as the tracker left them
        states: Array.from(states), contact: contact, votes: votes,
    }, study);
}

// ---------------------------------------------------------------------------
// The tail-band cue for the identity engine (pose/identity-cues.js): any number of
// animals, each expected to show a number of bands (0 = plain), or, for the
// two-animal case, 'marked' / 'plain'.
// ---------------------------------------------------------------------------

/**
 * How many dark bands a (clean, averaged) tail profile shows: dips at least
 * `minDip` below the brighter tail on both sides within `reach` positions.
 * Meant for TEMPLATES (medians of many views), where noise has averaged out.
 * @param {Float32Array|number[]} x  from `normalizeTailProfile`, or a median of such
 * @returns {number}
 */
export function countBands(x, minDip, reach) {
    minDip = minDip || 0.12;
    reach = reach || Math.round(x.length / 4);
    var n = x.length, k = 0, i = 1;
    while (i < n - 1) {
        // a local minimum (flat bottoms count once)
        if (x[i] <= x[i - 1] && x[i] <= x[i + 1]) {
            var j = i;
            while (j + 1 < n && x[j + 1] === x[i]) j++;
            var left = 0, right = 0;
            for (var a = Math.max(0, i - reach); a < i; a++) left = Math.max(left, x[a]);
            for (var b = j + 1; b <= Math.min(n - 1, j + reach); b++) right = Math.max(right, x[b]);
            if (Math.min(left, right) - x[i] >= minDip) k++;
            i = j + 1;
        } else i++;
    }
    return k;
}

function shiftedCopy(x, s) {
    var n = x.length, y = new Float32Array(n);
    for (var i = 0; i < n; i++) y[i] = x[Math.max(0, Math.min(n - 1, i - s))];
    return y;
}

// The shift of x, within maxShift, that fits t best, and that squared distance.
function bestShift(x, t, maxShift) {
    var n = x.length, best = Infinity, arg = 0;
    for (var s = -maxShift; s <= maxShift; s++) {
        var e = 0;
        for (var i = 0; i < n; i++) { var d = x[Math.max(0, Math.min(n - 1, i - s))] - t[i]; e += d * d; }
        if (e < best) { best = e; arg = s; }
    }
    return { shift: arg, err: best };
}

// A template from many profiles: their median, then the median of them each slid onto it.
function alignedMedian(profiles, maxShift) {
    if (!profiles.length) return null;
    var n = profiles[0].length, t = medianProfile(profiles, n);
    for (var round = 0; round < 2; round++) {
        t = medianProfile(profiles.map(function (x) { return shiftedCopy(x, bestShift(x, t, maxShift).shift); }), n);
    }
    return t;
}

// Hungarian on a small square cost matrix (rows to columns), exhaustively for n <= 7.
function bestMatching(cost) {
    var n = cost.length, best = Infinity, bestPerm = null, perm = [], used = new Uint8Array(n);
    (function rec(r, acc) {
        if (acc >= best) return;
        if (r === n) { best = acc; bestPerm = perm.slice(); return; }
        for (var c = 0; c < n; c++) {
            if (used[c]) continue;
            used[c] = 1; perm.push(c);
            rec(r + 1, acc + cost[r][c]);
            perm.pop(); used[c] = 0;
        }
    })(0, 0);
    return bestPerm;
}

/**
 * The tail-band cue (see pose/identity-cues.js for the interface). Features are
 * `normalizeTailProfile` profiles, one per camera: either a profile, or `{wide, sharp}`
 * from `ui/tail-mark-reader.js` given `TAIL_BAND_READ`. The wide read decides who is who
 * (costs) and the sharp one counts the bands (naming the templates, and the check): the sharp
 * read resolves bands packed near the base but tells a plain tail from one wide band less well.
 *
 * Learning: on the first pass, each tracked identity's own tail over the whole session
 * (an aligned median) is named by its band count (`countBands`; for 'marked'/'plain',
 * by which reads more banded) and matched to the expected classes; each class's
 * template is then its identity's. Later passes rebuild each class's template from
 * every view of the identities the decision says carried an animal of that class.
 *
 * Costs: each view's distance to every class template (best shift), minus the nearest,
 * relative to how far apart the templates are; a view that fits no template
 * (`fitTolerance`) counts for nothing.
 * @param {Object} [opts]  TAIL_MARK_DEFAULTS overrides
 */
export function createTailBandCue(opts) {
    var o = Object.assign({}, TAIL_MARK_DEFAULTS, opts || {});
    return {
        id: 'tailBands',
        learn: function (obs, labels, classOf, ids) {
            var classes = [], seen = new Set();
            ids.forEach(function (id, j) { var c = classOf(j); if (c != null && !seen.has(c)) { seen.add(c); classes.push(c); } });
            if (classes.length < 2) return { ok: false, reason: 'needs at least two different tail marks among the identities' };
            var byClass = new Map(classes.map(function (c) { return [c, []]; }));
            if (!labels) {
                // each tracked identity's own tail, named, then matched to the animals
                var own = ids.map(function (id) {
                    var all = [];
                    obs.forEach(function (o2) { var f = o2 && o2.get(id); if (f) f.forEach(function (x) { all.push(x); }); });
                    return all;
                });
                if (own.some(function (l) { return l.length < o.minTeachingSamples; })) {
                    return { ok: false, reason: 'could not read every animal\'s tail (are the videos loaded?)' };
                }
                var templates = own.map(function (l) { return alignedMedian(l.map(wideOf), o.maxShift); });
                var marked = classes.every(function (c) { return c === 'marked' || c === 'plain'; });
                var guess = own.map(function (l, i) {
                    if (marked) return tailBandScore(templates[i]);
                    var bt = sharpTemplate(l, o);
                    return bt ? countBands(bt) : 0;
                });
                var cost = ids.map(function (id, i) {
                    return ids.map(function (id2, j) {
                        var c = classOf(j);
                        if (c == null) return 0;
                        if (marked) {
                            var rank = guess.filter(function (g) { return g > guess[i]; }).length;   // 0 = most banded
                            var nMarked = ids.filter(function (x, q) { return classOf(q) === 'marked'; }).length;
                            return (rank < nMarked) === (c === 'marked') ? 0 : 1;
                        }
                        return Math.abs(guess[i] - Number(c));
                    });
                });
                var match = bestMatching(cost);
                ids.forEach(function (id, i) { var c = classOf(match[i]); if (c != null) byClass.get(c).push.apply(byClass.get(c), own[i]); });
                var first = buildModel(byClass, classes, o);
                first.guess = guess; first.match = match;
                return first.ok === false ? first : { ok: true, model: first };
            }
            obs.forEach(function (o2, t) {
                if (!o2) return;
                labels[t].forEach(function (animal, id) {
                    var c = classOf(animal), f = o2.get(id);
                    if (c == null || !f) return;
                    f.forEach(function (x) { byClass.get(c).push(x); });
                });
            });
            var model = buildModel(byClass, classes, o);
            if (model.ok === false) return model;
            // keep each class's template the one whose tail reads that class: a template
            // learned for "0 bands" that now reads 3 swaps places with the one reading 0
            renameByReading(model);
            return { ok: true, model: model };
        },
        // Do the learned templates read as the marks the user set, one to one? Else no relabel.
        check: function (model) {
            var read = model.templates.map(function (t, k) { return readClass(t, model.bandTemplates[k], model.classes); });
            var want = model.classes.map(String).slice().sort().join(',');
            var got = read.map(String).slice().sort().join(',');
            var match = model.classes.every(function (c, k) { return String(read[k]) === String(c); });
            if (match) return { ok: true };
            return { ok: false, reason: 'could not tell the tails apart reliably: the learned tails read as ' +
                read.join(', ') + ' for marks ' + model.classes.join(', ') + (want === got ? ' (in another order)' : '') };
        },
        costs: function (features, model) {
            var out = new Map(), C = model.classes.length;
            var sums = new Float64Array(C), used = 0;
            features.forEach(function (f) {
                var x = wideOf(f);
                var d = model.templates.map(function (t) { return bestShift(x, t, o.maxShift).err; });
                var lo = Math.min.apply(null, d);
                if (lo > o.fitTolerance * model.apart) return;   // fits none
                for (var c = 0; c < C; c++) sums[c] += Math.min((d[c] - lo) / model.apart, 1);
                used++;
            });
            if (!used) return out;
            model.classes.forEach(function (c, k) { out.set(c, sums[k]); });
            return out;
        },
        describe: function (model) {
            return model.classes.map(function (c, k) { return String(c) + ' → reads ' + (model.bandTemplates[k] ? countBands(model.bandTemplates[k]) : '?') + ' band(s)'; }).join('; ');
        },
    };
}

function wideOf(f) { return f && f.wide ? f.wide : f; }

// A class's band-counting template: the aligned median of its views' sharp reads (or of the
// profiles themselves, for features that carry one read).
function sharpTemplate(features, o) {
    var sharp = [];
    features.forEach(function (f) { var x = f && f.wide ? f.sharp : f; if (x) sharp.push(x); });
    return sharp.length ? alignedMedian(sharp, o.maxShift) : null;
}

// What a template reads as, among these classes: its band count (from the band-counting
// template), or 'marked' / 'plain' (from the template).
function readClass(t, bandT, classes) {
    var marked = classes.every(function (c) { return c === 'marked' || c === 'plain'; });
    if (!marked) return bandT ? countBands(bandT) : -1;
    return tailBandScore(t) >= TAIL_MARK_DEFAULTS.teachMinScore ? 'marked' : 'plain';
}

// Reorder a model's templates so each class holds the template that reads as it, when
// that is a one-to-one match; otherwise leave them (the final check says so).
function renameByReading(model) {
    if (model.classes.every(function (c) { return c === 'marked' || c === 'plain'; })) {
        var sc = model.templates.map(tailBandScore), mk = model.classes.indexOf('marked'), pl = model.classes.indexOf('plain');
        if (mk >= 0 && pl >= 0 && sc[pl] > sc[mk]) {
            var t0 = model.templates[mk]; model.templates[mk] = model.templates[pl]; model.templates[pl] = t0;
            var b0 = model.bandTemplates[mk]; model.bandTemplates[mk] = model.bandTemplates[pl]; model.bandTemplates[pl] = b0;
        }
        return;
    }
    var counts = model.bandTemplates.map(function (t) { return t ? countBands(t) : -1; });
    var cost = model.templates.map(function (t, a) {
        return model.classes.map(function (c) { return Math.abs(counts[a] - Number(c)); });
    });
    var match = bestMatching(cost);   // template a -> class match[a]
    var exact = match.every(function (b, a) { return cost[a][b] === 0; });
    if (!exact) return;
    var next = new Array(model.templates.length), nextBands = new Array(model.templates.length);
    match.forEach(function (b, a) { next[b] = model.templates[a]; nextBands[b] = model.bandTemplates[a]; });
    model.templates = next;
    model.bandTemplates = nextBands;
}

function buildModel(byClass, classes, o) {
    var templates = classes.map(function (c) { return alignedMedian(byClass.get(c).map(wideOf), o.maxShift); });
    if (templates.some(function (t) { return !t; })) return { ok: false, reason: 'no tail was read for one of the marks' };
    // how far apart the templates are: the closest pair's squared distance
    var apart = Infinity;
    for (var a = 0; a < templates.length; a++) for (var b = a + 1; b < templates.length; b++) {
        apart = Math.min(apart, bestShift(templates[a], templates[b], o.maxShift).err);
    }
    // the closest two marks must differ by `minTemplateDifference` (RMS), as in the two-animal pass
    if (!(Math.sqrt(apart / templates[0].length) >= o.minTemplateDifference)) {
        return { ok: false, reason: 'found no tail marks: two of the tails look the same' };
    }
    var bandTemplates = classes.map(function (c) { return sharpTemplate(byClass.get(c), o); });
    return { classes: classes, templates: templates, bandTemplates: bandTemplates, apart: apart };
}
