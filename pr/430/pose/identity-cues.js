/**
 * pose/identity-cues.js — which animal each tracked identity is, at every moment, from
 * features unique to each animal (cues). DOM-free; cue-agnostic.
 *
 * The tracker keeps identities by following the animals, so labels can change hands
 * when animals touch. A cue is something visible that tells animals apart: bands on a
 * tail (`pose/tail-mark.js`), and later fur markings or dyed ear tufts. The user says
 * what each identity should show (`expected`: per identity, per cue, a class such as
 * "2 bands" or "red"); the engine then finds, at each sampled frame, the assignment of
 * animals to tracked identities that best fits what the cues read, allowing labels to
 * change hands cheaply only while the animals touch, and relabels the session so each
 * identity holds its animal from start to end.
 *
 * Classes may be shared: four animals with two dye colours give two classes. Swaps
 * between animals of one class are then invisible to the cue and cost nothing to leave
 * alone, so the engine keeps the tracker's labels there rather than guess.
 *
 * A cue is an object:
 *   - `id`: its name, the key in `expected`.
 *   - `learn(obs, labels, classOf, ids)` -> model. `obs[t]` is a Map identityId -> features
 *     (one per camera that read it, in any form the cue likes); `labels[t]` maps each
 *     identityId to the animal (an index into `animals`) it is taken to be at sample t,
 *     or is null for the first pass, when the cue must make its own guess from the
 *     tracker's identities; `classOf(animal)` gives that animal's expected class.
 *     Returns `{ok: true, model}` or `{ok: false, reason}` (e.g. "found no tail marks").
 *   - `costs(features, model)` -> Map class -> cost (>= 0, 0 = fits best; missing = no
 *     information) for one identity at one sample, all its cameras together.
 *   - optional `check(model)` -> `{ok}` or `{ok: false, reason}`: after the last round,
 *     do the learned classes look like what the user set? A failed check relabels
 *     nothing (for tail bands: the learned tails must read as the counts set, one to one).
 *   - optional `describe(model)` -> text for the summary.
 *
 * The decision is a Viterbi over assignments (permutations of the animals onto the
 * tracked identities): a sample costs what its cues contradict; a swap of two
 * identities costs `contactSwapCost` across a gap where the two touch, and
 * `apartSwapCost` elsewhere (in units of a typical sample's evidence).
 */

import { buildGrid, contactEpisodes, SIZE_CHECK_DEFAULTS } from './id-switch-check.js?v=6a08874aa4a2';

export const IDENTITY_CUE_DEFAULTS = {
    /** Swaps across a contact, and across a gap with no contact, in typical-sample units. */
    contactSwapCost: 1,
    apartSwapCost: 2.5,
    /** One identity's cost at one sample, at most, in typical-sample units. */
    maxSampleCost: 2,
    /** Every assignment of up to this many animals is considered (6! = 720). */
    maxAnimals: 6,
    /** Learn, decide, learn again from the decision: this many rounds. */
    rounds: 3,
    /** Finding a change's frame stops when bracketed this closely (seconds). */
    refineSeconds: 0.1,
    /**
     * Around a sample that reads against the decision by more than `suspectCost` (typical-sample
     * units), read every this many seconds between its neighbours, then decide again (0: never).
     * On 05mice_flippers (keyframes 4.2 s apart) 0.25-0.5 gave the labels of reading every second
     * throughout, from a third of the frames; below 0.15 the extra reads in a long contact tipped a
     * 3 s relabel that the cameras contradict; at 1 a 6 s swap was missed.
     */
    denseSeconds: 1,
    suspectCost: 0.35,
    /**
     * Readers sample keyframes up to this far apart (`reader.plan(frames, maxGapSeconds)`):
     * cheap to decode, where every frame between keyframes costs decoding from the last one.
     */
    maxSampleGapSeconds: 10,
};

/**
 * Every ordering of `n` items, as arrays (`perm[i]` = the animal identity i carries).
 * @param {number} n
 * @returns {Int8Array[]}
 */
export function permutationsOf(n) {
    var out = [];
    var a = [];
    for (var i = 0; i < n; i++) a.push(i);
    (function rec(k) {
        if (k === n) { out.push(Int8Array.from(a)); return; }
        for (var j = k; j < n; j++) {
            var t = a[k]; a[k] = a[j]; a[j] = t;
            rec(k + 1);
            t = a[k]; a[k] = a[j]; a[j] = t;
        }
    })(0);
    out.sort(function (x, y) {
        for (var q = 0; q < n; q++) if (x[q] !== y[q]) return x[q] - y[q];
        return 0;
    });
    return out;
}

/**
 * Where each pair of identities touches, from the 3D: frame spans per pair.
 * @param {Object} session
 * @param {number} fps
 * @param {Array} ids  identity ids, in the order the decision uses
 * @returns {?Object<string, Array<number[]>>}  "a|b" (indices into ids, a < b) -> [from, to]
 *   frame spans, increasing; null when the session has no usable 3D
 */
export function pairContactRuns(session, fps, ids) {
    var grid = buildGrid(session, Object.assign({}, SIZE_CHECK_DEFAULTS, { fps: fps, minTrackedSeconds: 0 }), false);
    if (grid.fail) return null;
    var kOf = new Map(grid.idents.map(function (id, k) { return [id.id, k]; }));
    var col = ids.map(function (id) { return kOf.has(id) ? kOf.get(id) : -1; });
    var out = {};
    contactEpisodes(grid, 0).pairs.forEach(function (p) {
        var a = col.indexOf(p.a), b = col.indexOf(p.b);
        if (a < 0 || b < 0) return;
        out[Math.min(a, b) + '|' + Math.max(a, b)] = p.eps.map(function (e) { return [grid.frames[e[0]] - grid.step, grid.frames[e[1]] + grid.step]; });
    });
    return out;
}

/**
 * For each gap between consecutive samples, which identity pairs touch in it.
 * @param {?Object<string, Array<number[]>>} runs  from `pairContactRuns`; null: every pair, every gap
 * @param {number[]} samples  frames, increasing
 * @returns {(gap: number, a: number, b: number) => boolean}  a, b are indices into the ids
 */
export function touchingFromRuns(runs, samples) {
    if (!runs) return function () { return true; };
    var touch = new Map();   // "a|b" -> Uint8Array per gap
    Object.keys(runs).forEach(function (key) {
        var rs = runs[key], gaps = new Uint8Array(Math.max(0, samples.length - 1)), r = 0;
        for (var i = 0; i < gaps.length; i++) {
            while (r < rs.length && rs[r][1] < samples[i]) r++;
            gaps[i] = r < rs.length && rs[r][0] <= samples[i + 1] ? 1 : 0;
        }
        touch.set(key, gaps);
    });
    return function (gap, a, b) {
        var g = touch.get(Math.min(a, b) + '|' + Math.max(a, b));
        return !!(g && g[gap]);
    };
}

/**
 * For each gap between consecutive samples, which identity pairs touch in it.
 * Falls back to "every pair, every gap" when the session has no usable 3D.
 * @param {Object} session
 * @param {number[]} samples  frames, increasing
 * @param {number} fps
 * @param {Array} ids  identity ids, in the order the decision uses
 * @returns {(gap: number, a: number, b: number) => boolean}  a, b are indices into `ids`
 */
export function pairContacts(session, samples, fps, ids) {
    return touchingFromRuns(pairContactRuns(session, fps, ids), samples);
}

/**
 * The most likely assignment at each sample.
 * @param {Array<?Float64Array>} cost  per sample, K*K: cost[i*K + j] = identity i carrying animal j (null: no information)
 * @param {number} K
 * @param {(gap: number, a: number, b: number) => boolean} touching
 * @param {Object} [opts]  IDENTITY_CUE_DEFAULTS overrides; costs must already be in typical-sample units
 * @returns {{perms: Int8Array[], states: Int32Array, total: number}}  states[t] indexes perms
 */
export function decodeAssignments(cost, K, touching, opts) {
    var o = Object.assign({}, IDENTITY_CUE_DEFAULTS, opts || {});
    var perms = permutationsOf(K), P = perms.length, T = cost.length;
    var index = new Map(perms.map(function (p, i) { return [p.join(','), i]; }));
    var pairs = [];
    for (var a = 0; a < K; a++) for (var b = a + 1; b < K; b++) pairs.push([a, b]);
    // neighbour[s * nPairs + q] = the state with identities a, b of pair q exchanged
    var neighbour = new Int32Array(P * pairs.length);
    perms.forEach(function (p, s) {
        pairs.forEach(function (ab, q) {
            var x = Array.from(p), t = x[ab[0]]; x[ab[0]] = x[ab[1]]; x[ab[1]] = t;
            neighbour[s * pairs.length + q] = index.get(x.join(','));
        });
    });
    var emit = function (t, s) {
        var c = cost[t];
        if (!c) return 0;
        var p = perms[s], e = 0;
        for (var i = 0; i < K; i++) e += Math.min(c[i * K + p[i]], o.maxSampleCost);
        return e;
    };
    var prev = new Float64Array(P), cur = new Float64Array(P);
    var from = new Int32Array(T * P);
    for (var s0 = 0; s0 < P; s0++) prev[s0] = emit(0, s0);
    for (var t = 1; t < T; t++) {
        var swapCost = pairs.map(function (ab) { return touching(t - 1, ab[0], ab[1]) ? o.contactSwapCost : o.apartSwapCost; });
        for (var s = 0; s < P; s++) {
            var best = prev[s], arg = s;
            for (var q = 0; q < pairs.length; q++) {
                var n = neighbour[s * pairs.length + q], v = prev[n] + swapCost[q];
                if (v < best) { best = v; arg = n; }
            }
            from[t * P + s] = arg;
            cur[s] = best + emit(t, s);
        }
        var tmp = prev; prev = cur; cur = tmp;
    }
    var end = 0;
    for (var e = 1; e < P; e++) if (prev[e] < prev[end]) end = e;
    var states = new Int32Array(T), total = prev[end];
    for (var b2 = T - 1; b2 >= 0; b2--) { states[b2] = end; end = from[b2 * P + end]; }
    return { perms: perms, states: states, total: total };
}

/**
 * Swaps (pairs of identity indices) that turn labels as tracked into labels where each
 * identity i holds the animal `perm[i]` names: the cycles of the permutation, each as
 * exchanges with its first member, applied in order.
 * @param {ArrayLike<number>} perm  identity i currently carries animal perm[i]
 * @returns {Array<[number, number]>}
 */
export function swapsFor(perm) {
    var n = perm.length, seen = new Uint8Array(n), out = [];
    for (var i = 0; i < n; i++) {
        if (seen[i]) continue;
        var cycle = [], j = i;
        while (!seen[j]) { seen[j] = 1; cycle.push(j); j = perm[j]; }
        for (var c = 1; c < cycle.length; c++) out.push([cycle[0], cycle[c]]);
    }
    return out;
}

/**
 * Sum every cue's costs for every identity and animal, scaled to typical-sample units: the
 * median spread of one identity's costs at one sample, or `typicalGiven` when set.
 * @returns {{cost: Array<?Float64Array>, typical: number}}
 */
export function combineCosts(perCue, K, typicalGiven) {
    var T = perCue.length ? perCue[0].length : 0, cost = new Array(T), spread = [];
    for (var t = 0; t < T; t++) {
        var c = null;
        perCue.forEach(function (rows) {
            var r = rows[t];
            if (!r) return;
            if (!c) c = new Float64Array(K * K);
            for (var x = 0; x < K * K; x++) c[x] += r[x];
        });
        cost[t] = c;
        if (c) {
            for (var i = 0; i < K; i++) {
                var lo = Infinity, hi = -Infinity;
                for (var j = 0; j < K; j++) { lo = Math.min(lo, c[i * K + j]); hi = Math.max(hi, c[i * K + j]); }
                if (hi > lo) spread.push(hi - lo);
            }
        }
    }
    spread.sort(function (a, b) { return a - b; });
    var typical = typicalGiven > 0 ? typicalGiven : spread.length ? spread[spread.length >> 1] : 0;
    if (typical > 0) cost.forEach(function (c2) { if (c2) for (var x2 = 0; x2 < c2.length; x2++) c2[x2] /= typical; });
    return { cost: cost, typical: typical };
}

/**
 * One cue's K*K cost rows: identity i carrying animal j costs what the cue says about
 * i's features under the class animal j should show. An animal with no class for this
 * cue costs nothing.
 */
export function cueCostRows(cue, model, obs, ids, classes) {
    var K = ids.length;
    return obs.map(function (o) {
        if (!o) return null;
        var row = null;
        for (var i = 0; i < K; i++) {
            var f = o.get(ids[i]);
            if (!f || !f.length) continue;
            var cm = cue.costs(f, model);
            if (!cm || !cm.size) continue;
            if (!row) row = new Float64Array(K * K);
            for (var j = 0; j < K; j++) {
                var v = classes[j] == null ? undefined : cm.get(classes[j]);
                if (v != null) row[i * K + j] = v;
            }
        }
        return row;
    });
}

/**
 * The whole pass: read every cue at sampled frames, learn each class's look, decide who
 * is who when, find each change's frame, and relabel the session.
 *
 * @param {Object} session  tracked; its identities are the animals, by name
 * @param {Object} opts
 * @param {number} opts.fps
 * @param {Array<{cue: Object, reader: Object}>} opts.cues  each cue with its reader
 *   (`{plan(frames) -> samples, open(samples), next(frame), at(frame), close()}`; next/at
 *   resolve to `{scores: Map<identityId, features[]>}`); every reader must plan the same samples.
 * @param {Object<string, Object<string, *>>} opts.expected  identity name -> cue id -> class
 * @param {(done: number, total: number) => (void|Promise)} [opts.onProgress]  awaited
 * @returns {Promise<Object>}  `{ok: true, changes, stretches, swapped, samples, models, ...}`
 *   or `{ok: false, reason}`; nothing is changed unless ok
 */
export async function resolveIdentityCues(session, opts) {
    var o = Object.assign({}, IDENTITY_CUE_DEFAULTS, opts);
    var idents = session.identities || [];
    var names = Object.keys(o.expected || {});
    if (!names.length) return { ok: false, reason: 'no identity has an expected mark' };
    var animals = names.map(function (nm) { return idents.find(function (id) { return id.name === nm; }); });
    var missing = names.filter(function (nm, i) { return !animals[i]; });
    if (missing.length) return { ok: false, reason: 'no identity is named ' + missing.join(', ') };
    if (idents.length !== names.length) {
        return { ok: false, reason: 'expected marks for ' + names.length + ' identities, but tracking found ' + idents.length };
    }
    if (!o.cues || !o.cues.length) return { ok: false, reason: 'no identity cue to read' };
    var K = names.length;
    if (K < 2) return { ok: false, reason: 'needs at least two identities' };
    if (K > o.maxAnimals) return { ok: false, reason: 'handles up to ' + o.maxAnimals + ' animals (found ' + K + ')' };
    if (!(o.fps > 0)) return { ok: false, reason: 'unknown frame rate' };
    var ids = animals.map(function (a) { return a.id; });
    var frames = Array.from(session.instanceGroups.keys()).sort(function (a, b) { return a - b; });
    if (!frames.length) return { ok: false, reason: 'no tracked frames' };

    // Read every cue at the same samples.
    var samples = await o.cues[0].reader.plan(frames, o.maxSampleGapSeconds);
    if (!samples.length) return { ok: false, reason: 'no frames to read' };
    var readAll = async function (list) {
        var got = o.cues.map(function () { return new Array(list.length); });
        for (var ci = 0; ci < o.cues.length; ci++) await o.cues[ci].reader.open(list);
        try {
            for (var t = 0; t < list.length; t++) {
                for (var c2 = 0; c2 < o.cues.length; c2++) {
                    var r = await o.cues[c2].reader.next(list[t]);
                    got[c2][t] = r ? r.scores : null;
                }
                if (o.onProgress) await o.onProgress(t + 1, list.length);
            }
        } finally { o.cues.forEach(function (c) { c.reader.close(); }); }
        return got;
    };
    var obs = await readAll(samples);
    var classesOf = o.cues.map(function (c) { return names.map(function (nm) { return o.expected[nm][c.cue.id]; }); });

    // Learn, decide, learn again from the decision.
    var labels, models, decision, rounds, combined, touching;
    // o.contactRuns: `pairContactRuns`'s result given instead (studies replaying saved reads)
    var contactRuns = o.contactRuns !== undefined ? o.contactRuns : pairContactRuns(session, o.fps, ids);
    // typical: the cost scale, given when samples were added around suspects; they bunch where
    // the cues read poorly, and a scale taken from them makes every cost loom larger against a swap
    var decide = function (typical) {
        touching = touchingFromRuns(contactRuns, samples);
        labels = null; rounds = [];
        for (var round = 0; round < o.rounds; round++) {
            models = [];
            for (var c3 = 0; c3 < o.cues.length; c3++) {
                var cls = classesOf[c3];
                var learned = o.cues[c3].cue.learn(obs[c3], labels, function (j) { return cls[j]; }, ids);
                if (!learned.ok) return Object.assign({ ok: false }, learned);
                models.push(learned.model);
            }
            var perCue = o.cues.map(function (c, k) { return cueCostRows(c.cue, models[k], obs[k], ids, classesOf[k]); });
            combined = combineCosts(perCue, K, typical);
            if (!(combined.typical > 0)) return { ok: false, reason: 'the cues could not tell the animals apart' };
            decision = decodeAssignments(combined.cost, K, touching, o);
            labels = Array.from(decision.states, function (s) {
                var p = decision.perms[s], m = new Map();
                for (var i = 0; i < K; i++) m.set(ids[i], p[i]);
                return m;
            });
            rounds.push({ total: decision.total, changes: countChanges(decision.states) });
        }
        return null;
    };
    var failed = decide();
    if (failed) return failed;

    // Sparse samples (keyframes seconds apart) can step over a short stretch: where a sample
    // reads against the decision, read the frames around it densely and decide again, on the
    // first pass's cost scale.
    var extra = [], suspectFrames = [];
    if (o.denseSeconds > 0) {
        var suspect = suspectSamples(combined.cost, decision, K, o);
        suspectFrames = suspect.map(function (t) { return samples[t]; });
        extra = denseFramesAround(samples, suspect, frames, Math.max(1, Math.round(o.denseSeconds * o.fps)));
        if (extra.length) {
            var more = await readAll(extra);
            var merged = samples.map(function (f, i) { return { f: f, at: [0, i] }; })
                .concat(extra.map(function (f, i) { return { f: f, at: [1, i] }; }))
                .sort(function (a, b) { return a.f - b.f; });
            obs = o.cues.map(function (c, k) { return merged.map(function (m) { return (m.at[0] ? more : obs)[k][m.at[1]]; }); });
            samples = merged.map(function (m) { return m.f; });
            failed = decide(combined.typical);
            if (failed) return failed;
        }
    }

    // A cue that cannot vouch for what it learned relabels nothing.
    for (var c4 = 0; c4 < o.cues.length; c4++) {
        var cueK = o.cues[c4].cue;
        if (typeof cueK.check !== 'function') continue;
        var verdict = cueK.check(models[c4]);
        if (!verdict.ok) {
            return { ok: false, reason: verdict.reason, rounds: rounds, sampleFrames: samples, states: Array.from(decision.states),
                models: o.cues.map(function (c, k) { return { cue: c.cue.id, text: c.cue.describe ? c.cue.describe(models[k]) : '' }; }) };
        }
    }

    // Each change between two samples: bisect to its frame, by the cost of the two assignments.
    var perms = decision.perms, states = decision.states;
    var runs = [{ frame: samples[0], perm: perms[states[0]] }], reads = 0;
    var costAt = async function (f, perm) {
        var rowsAt = await Promise.all(o.cues.map(async function (c, k) {
            var res = await c.reader.at(f);
            return cueCostRows(c.cue, models[k], [res ? res.scores : null], ids, classesOf[k])[0];
        }));
        var total = 0, any = false;
        rowsAt.forEach(function (row) {
            if (!row) return;
            any = true;
            for (var i = 0; i < K; i++) total += row[i * K + perm[i]];
        });
        return any ? total : null;
    };
    var close = Math.max(1, Math.round(o.refineSeconds * o.fps));
    for (var t2 = 1; t2 < samples.length; t2++) {
        if (states[t2] === states[t2 - 1]) continue;
        var pA = perms[states[t2 - 1]], pB = perms[states[t2]], lo = samples[t2 - 1], hi = samples[t2];
        while (hi - lo > close) {
            var mid = (lo + hi) >> 1, a = await costAt(mid, pA), b = await costAt(mid, pB);
            reads++;
            if (a == null || b == null || a === b) break;
            if (a < b) lo = mid; else hi = mid;
        }
        runs.push({ frame: hi - lo > close ? (lo + hi) >> 1 : hi, perm: pB });
    }

    // Relabel: on each run, identity i holds animal perm[i]; animal j is identity ids[j].
    var stretches = [], swapped = 0;
    runs.forEach(function (run, k) {
        var from = k === 0 ? -Infinity : run.frame;
        var to = k + 1 < runs.length ? runs[k + 1].frame - 1 : Infinity;
        var sw = swapsFor(run.perm);
        if (sw.length) swapped++;
        sw.forEach(function (ab) { session.swapIdentitiesInRange(from, to, ids[ab[0]], ids[ab[1]]); });
        stretches.push({ from: from, to: to, perm: Array.from(run.perm), swaps: sw.length });
    });
    return {
        ok: true, swapped: swapped, changes: runs.length - 1, stretches: stretches, runs: runs.map(function (r) { return { frame: r.frame, perm: Array.from(r.perm) }; }),
        samples: samples.length, dense: extra.length, suspects: suspectFrames, reads: reads, rounds: rounds, names: names,
        models: o.cues.map(function (c, k) { return { cue: c.cue.id, text: c.cue.describe ? c.cue.describe(models[k]) : '' }; }),
        // for the study harness
        sampleFrames: samples, states: Array.from(states), obs: o.keepObservations ? obs : undefined,
    };
}

/**
 * Samples that read against the decision: the decided assignment costs more than the best
 * one there by over `suspectCost`.
 * @returns {number[]} sample indices
 */
export function suspectSamples(cost, decision, K, opts) {
    var o = Object.assign({}, IDENTITY_CUE_DEFAULTS, opts || {}), out = [];
    var perms = decision.perms;
    cost.forEach(function (c, t) {
        if (!c) return;
        var at = function (p) { var e = 0; for (var i = 0; i < K; i++) e += Math.min(c[i * K + p[i]], o.maxSampleCost); return e; };
        var best = Infinity;
        for (var s = 0; s < perms.length; s++) best = Math.min(best, at(perms[s]));
        if (at(perms[decision.states[t]]) - best > o.suspectCost) out.push(t);
    });
    return out;
}

/**
 * Tracked frames every `step` frames strictly between each suspect sample's neighbours,
 * not already samples; none where the samples are already that close.
 * @param {number[]} samples  increasing
 * @param {number[]} suspect  indices into samples
 * @param {number[]} frames  tracked frames, increasing
 * @param {number} step
 * @returns {number[]} increasing
 */
export function denseFramesAround(samples, suspect, frames, step) {
    var have = new Set(samples), out = new Set();
    suspect.forEach(function (t) {
        var lo = t > 0 ? samples[t - 1] : samples[t], hi = t + 1 < samples.length ? samples[t + 1] : samples[t];
        if (hi - lo <= 2 * step) return;
        var next = lo + step;
        for (var i = lowerBound(frames, lo + 1); i < frames.length && frames[i] < hi; i++) {
            if (frames[i] < next) continue;
            if (!have.has(frames[i])) out.add(frames[i]);
            next = frames[i] + step;
        }
    });
    return Array.from(out).sort(function (a, b) { return a - b; });
}

function lowerBound(a, x) {
    var lo = 0, hi = a.length;
    while (lo < hi) { var m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
    return lo;
}

function countChanges(states) {
    var n = 0;
    for (var t = 1; t < states.length; t++) if (states[t] !== states[t - 1]) n++;
    return n;
}
