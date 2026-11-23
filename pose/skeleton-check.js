/**
 * pose/skeleton-check.js — Triangulate's skeleton check: find body parts whose 3D breaks the skeleton's usual bone
 * lengths and repair only the points that need it.
 *
 * In pile-ups a mouse's 2D detections of one body part can land on a neighbour in some cameras; triangulation then
 * stretches a tail or a head onto the other mouse. The check:
 *   1. CHAINS from the skeleton (`skeletonChains`): the HUBS are the nodes with 3 or more edges (on DoublePoke's
 *      star skeleton, TTI and the Head); every group of the other nodes that hangs together once the hubs are
 *      removed is a chain (each tail node alone, the two ears, the two shoulders, ...), fixed where it joins a hub
 *      (its ANCHORS). A connected part of the skeleton without a hub uses its centre.
 *   2. USUAL LENGTHS (`measureBones`): each chain bone's median and plausible range, measured from 3D poses:
 *      [min(0.5, p2 x 0.85), max(1.5, p98 x 1.15)] times the median, p2/p98 being the bone's 2nd and 98th percentile
 *      ratios. A steady bone gets exactly the +-50 % rule; one that often shortens (TTI to TailTip when the tail
 *      curls) gets a wider lower bound but the same upper one, so a tip reaching onto a neighbour still counts.
 *   3. THE REPAIR (`checkChains`): a chain with a bone outside its range gets the FEWEST point changes that bring
 *      every bone inside: each point keeps its place, takes a candidate (a re-solve from a group of cameras that
 *      agree, from the core; with a volume also its point or the plain solve's), or, only when the caller allows it
 *      (`allowDrop`: with a volume), is dropped (no 3D). Without a volume nothing independent says a point is wrong:
 *      a short bone may mean its other end is, and a dropped nose that was right is a loss (judged by eye on July 13
 *      frame 105,413). Kept points must stay linked to an anchor through present bones, so a drop cannot cut a
 *      wrong piece loose. A LOCKED point (every camera
 *      that sees it agrees) never changes. Ties go to fewer drops, then to better-supported candidates, then to the
 *      smallest move. A chain no repair makes plausible is left as it is, but for its OUT-OF-REACH points (a chain
 *      of 2+ points, `chainReach`): a point farther from its anchor than the chain can reach, every bone on the way
 *      at its longest plausible length, is impossible whatever its neighbours are, so it still takes the repair that
 *      brings it within reach (a candidate within reach, or a drop where drops are allowed) and lowers the chain's
 *      badness most. On SLAP's 22 proofread sessions with the tail linked in order, plain triangulation put 4 tail
 *      points up to 28,014 units away inside tails no repair made plausible; the star skeleton's one-point chains
 *      fixed them and the linked tail had left them. Never a whole chain at once: one wrong point among right ones
 *      is the common case (the volfuse study's July 13 frames, judged by eye).
 *
 * Import-free and DOM-free: the core (pose/triangulation-core.js) runs it inside `triangulateAndReproject`
 * (`options.skeleton`), in the page or a worker.
 *
 * A chain: { nodes: Int32Array, anchors: Int32Array, bones: Int32Array (pairs of node indices: every edge with an
 * end in `nodes`), and once measured medians, lo, hi: Float64Array (one per bone; lo/hi as ratios of the median) }.
 */

/** The repair's penalty for a kept point no path of present bones links to an anchor. */
const ORPHAN = 1;
/** Fewest finite lengths a bone's usual length is measured from. */
export const MIN_BONE_SAMPLES = 20;
/** At most this many lengths are kept per bone while measuring (spread over the whole project). */
const MAX_BONE_SAMPLES = 20000;
/** Most option combinations the repair tries for one chain; a larger chain is left as it is. */
const MAX_REPAIR_COMBOS = 4096;

export const SKELETON_CHECK_DEFAULTS = Object.freeze({
    loFloor: 0.5, hiFloor: 1.5, rangeMargin: 0.15,   // usual range [min(0.5, p2*0.85), max(1.5, p98*1.15)]
    subsetPx: 12,          // a camera agrees with a point when it reprojects within 12 px of its detection
    maxCandidates: 3,      // re-solves offered per point (the best-supported groups of agreeing cameras)
});

/**
 * Chains from a skeleton's edges. `edges`: [[a, b], ...] node indices. -> { chains: [{ nodes, anchors, bones }],
 * hubs: Int32Array }. Hubs: nodes with 3+ edges; a connected part without one gets its centre (smallest
 * eccentricity, lowest index on ties). Nodes with no edge belong to no chain.
 */
export function skeletonChains(nodeCount, edges) {
    const adj = Array.from({ length: nodeCount }, function () { return new Set(); });
    for (const e of edges || []) {
        const a = e[0], b = e[1];
        if (!(a >= 0 && b >= 0 && a < nodeCount && b < nodeCount) || a === b) continue;
        adj[a].add(b); adj[b].add(a);
    }
    const isHub = new Uint8Array(nodeCount);
    for (let k = 0; k < nodeCount; k++) if (adj[k].size >= 3) isHub[k] = 1;
    const part = new Int32Array(nodeCount).fill(-1);
    for (let s = 0; s < nodeCount; s++) {
        if (part[s] >= 0 || !adj[s].size) continue;
        const members = [s];
        part[s] = s;
        for (let i = 0; i < members.length; i++) for (const q of adj[members[i]]) if (part[q] < 0) { part[q] = s; members.push(q); }
        if (members.some(function (k) { return isHub[k]; })) continue;
        let best = -1, bestEcc = Infinity;
        for (const k of members.slice().sort(function (a, b) { return a - b; })) {
            const dist = new Map([[k, 0]]), queue = [k];
            for (let i = 0; i < queue.length; i++) for (const q of adj[queue[i]]) if (!dist.has(q)) { dist.set(q, dist.get(queue[i]) + 1); queue.push(q); }
            let ecc = 0;
            for (const d of dist.values()) if (d > ecc) ecc = d;
            if (ecc < bestEcc) { bestEcc = ecc; best = k; }
        }
        if (best >= 0) isHub[best] = 1;
    }
    const seen = new Uint8Array(nodeCount), chains = [];
    for (let s = 0; s < nodeCount; s++) {
        if (seen[s] || isHub[s] || !adj[s].size) continue;
        const nodes = [s], anchors = new Set();
        seen[s] = 1;
        for (let i = 0; i < nodes.length; i++) {
            for (const q of adj[nodes[i]]) {
                if (isHub[q]) anchors.add(q);
                else if (!seen[q]) { seen[q] = 1; nodes.push(q); }
            }
        }
        if (!anchors.size) continue;
        nodes.sort(function (a, b) { return a - b; });
        const inChain = new Set(nodes), bones = [];
        for (const a of nodes) for (const b of Array.from(adj[a]).sort(function (x, y) { return x - y; })) {
            if (inChain.has(b) && b < a) continue;   // an edge inside the chain once
            bones.push(a, b);
        }
        chains.push({ nodes: Int32Array.from(nodes),
                      anchors: Int32Array.from(Array.from(anchors).sort(function (a, b) { return a - b; })),
                      bones: Int32Array.from(bones) });
    }
    const hubs = [];
    for (let k = 0; k < nodeCount; k++) if (isHub[k]) hubs.push(k);
    return { chains: chains, hubs: Int32Array.from(hubs) };
}

/**
 * Each chain bone's usual length and plausible range from 3D poses. `forEachPose(fn)` calls fn(points3d) for every
 * pose (flat 3N, NaN = missing). -> the measured chains (with `medians`, `lo`, `hi`) minus those with a bone
 * measured on fewer than MIN_BONE_SAMPLES poses; `.skipped` lists those ({ chain, reason }).
 */
export function measureBones(chains, forEachPose, opts) {
    const o = Object.assign({}, SKELETON_CHECK_DEFAULTS, opts || {});
    const samples = chains.map(function (ch) { return Array.from({ length: ch.bones.length >> 1 }, function () { return []; }); });
    const seen = chains.map(function (ch) { return new Float64Array(ch.bones.length >> 1); });
    forEachPose(function (P) {
        for (let c = 0; c < chains.length; c++) {
            const b = chains[c].bones;
            for (let i = 0; i < b.length >> 1; i++) {
                const p = 3 * b[2 * i], q = 3 * b[2 * i + 1];
                const L = Math.hypot(P[p] - P[q], P[p + 1] - P[q + 1], P[p + 2] - P[q + 2]);
                if (!(L > 0) || !Number.isFinite(L)) continue;
                const S = samples[c][i], n = ++seen[c][i];
                if (S.length < MAX_BONE_SAMPLES) { S.push(L); continue; }
                // reservoir sampling with a fixed hash, so the same project always measures the same
                const j = (Math.imul(n, 2654435761) >>> 0) % n;
                if (j < MAX_BONE_SAMPLES) S[j] = L;
            }
        }
    });
    const quant = function (sorted, p) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]; };
    const out = [];
    out.skipped = [];
    chains.forEach(function (ch, c) {
        const nb = ch.bones.length >> 1;
        const medians = new Float64Array(nb), lo = new Float64Array(nb), hi = new Float64Array(nb);
        for (let i = 0; i < nb; i++) {
            const S = samples[c][i].slice().sort(function (x, y) { return x - y; });
            if (S.length < MIN_BONE_SAMPLES) { out.skipped.push({ chain: ch, reason: 'too few 3D poses to measure its bones' }); return; }
            const m = quant(S, 0.5);
            medians[i] = m;
            lo[i] = Math.min(o.loFloor, quant(S, 0.02) / m * (1 - o.rangeMargin));
            hi[i] = Math.max(o.hiFloor, quant(S, 0.98) / m * (1 + o.rangeMargin));
        }
        out.push(Object.assign({}, ch, { medians: medians, lo: lo, hi: hi }));
    });
    return out;
}

/** How far one bone of length L is outside its range, as a fraction of its usual length (0 = inside). */
function boneOff(L, m, lo, hi) {
    const r = L / m;
    return r < lo ? lo - r : (r > hi ? r - hi : 0);
}
function has3(P, q) { return Number.isFinite(P[q]) && Number.isFinite(P[q + 1]) && Number.isFinite(P[q + 2]); }

/** The TRIGGER: the sum over a measured chain's bones with both ends present of how far each is outside its range
 *  (a missing point is absent, not implausible). 0 = plausible. `P` flat, node k at 3k. */
export function chainBadness(P, chain) {
    const b = chain.bones;
    let s = 0;
    for (let i = 0; i < b.length >> 1; i++) {
        const p = 3 * b[2 * i], q = 3 * b[2 * i + 1];
        if (!has3(P, p) || !has3(P, q)) continue;
        s += boneOff(Math.hypot(P[p] - P[q], P[p + 1] - P[q + 1], P[p + 2] - P[q + 2]), chain.medians[i], chain.lo[i], chain.hi[i]);
    }
    return s;
}

/**
 * How far a candidate REPAIR is from plausible: bones with both ends present are judged (as in the trigger); a
 * dropped or missing end leaves its bone unjudged; and each present chain point that no path of present bones
 * links to a present anchor costs ORPHAN (a drop cannot cut a wrong piece loose). 0 = plausible.
 */
export function chainRepairBadness(P, chain) {
    const b = chain.bones, nb = b.length >> 1;
    const reached = new Set();
    for (const a of chain.anchors) if (has3(P, 3 * a)) reached.add(a);
    let grew = true;
    while (grew) {
        grew = false;
        for (let i = 0; i < nb; i++) {
            const p = b[2 * i], q = b[2 * i + 1];
            if (!has3(P, 3 * p) || !has3(P, 3 * q) || reached.has(p) === reached.has(q)) continue;
            reached.add(reached.has(p) ? q : p);
            grew = true;
        }
    }
    let s = 0;
    for (let i = 0; i < nb; i++) {
        const p = 3 * b[2 * i], q = 3 * b[2 * i + 1];
        if (!has3(P, p) || !has3(P, q)) continue;
        s += boneOff(Math.hypot(P[p] - P[q], P[p + 1] - P[q + 1], P[p + 2] - P[q + 2]), chain.medians[i], chain.lo[i], chain.hi[i]);
    }
    for (const k of chain.nodes) if (has3(P, 3 * k) && !reached.has(k)) s += ORPHAN;
    return s;
}

/**
 * How far each point of a measured chain can be from the chain's anchors: the shortest path from an anchor along the
 * chain's bones, each bone at its longest plausible length (median x hi). -> Map(node -> { reach, anchor })
 */
export function chainReach(chain) {
    const b = chain.bones, nb = b.length >> 1;
    const best = new Map();
    for (const a of chain.anchors) best.set(a, { reach: 0, anchor: a });
    const done = new Set();
    for (;;) {
        let cur = -1, cd = Infinity;
        for (const [k, v] of best) if (!done.has(k) && v.reach < cd) { cd = v.reach; cur = k; }
        if (cur < 0) break;
        done.add(cur);
        for (let i = 0; i < nb; i++) {
            const p = b[2 * i], q = b[2 * i + 1];
            if (p !== cur && q !== cur) continue;
            const o = p === cur ? q : p;
            const d = cd + chain.medians[i] * chain.hi[i];
            const v = best.get(o);
            if (!v || d < v.reach) best.set(o, { reach: d, anchor: best.get(cur).anchor });
        }
    }
    for (const a of chain.anchors) best.delete(a);
    return best;
}

/**
 * The skeleton check on one pose (flat 3N, IN PLACE). `candidatesFor(k)` -> { locked: bool, cands: [{ X: [x, y, z],
 * kind: string, support: number }] }: what node k may become instead of its point (called only for the points of a
 * chain that is off). Each measured chain outside its ranges (`chainBadness` > 0) gets the fewest changes that make
 * it plausible (`chainRepairBadness` 0); ties: fewer drops, more support, smaller move. A chain no repair makes
 * plausible is left as it is, except that in a chain of 2+ points its out-of-reach points are still repaired
 * (`chainReach`; `partial` counts those chains). `opts.allowDrop` (default true): whether a point may be dropped.
 * -> { chains: chains repaired (partial ones included), partial, changed: { [kind]: points }, dropped: points }
 */
export function checkChains(points3d, chains, candidatesFor, opts) {
    const allowDrop = !(opts && opts.allowDrop === false);
    const out = { chains: 0, partial: 0, changed: {}, dropped: 0 };
    if (!chains || !chains.length) return out;
    let work = null;
    for (const ch of chains) {
        if (!(chainBadness(points3d, ch) > 0)) continue;
        const K = ch.nodes.length, opts = [];
        let total = 1;
        for (let i = 0; i < K; i++) {
            const q = 3 * ch.nodes[i];
            const here = has3(points3d, q);
            const c = candidatesFor(ch.nodes[i]) || { locked: false, cands: [] };
            const o = [{ kind: 'keep' }];
            if (!c.locked) {
                for (const cand of c.cands || []) {
                    const X = cand.X;
                    if (!(Number.isFinite(X[0]) && Number.isFinite(X[1]) && Number.isFinite(X[2]))) continue;
                    if (here && Math.hypot(X[0] - points3d[q], X[1] - points3d[q + 1], X[2] - points3d[q + 2]) <= 1e-6) continue;
                    o.push(cand);
                }
                if (here && allowDrop) o.push({ kind: 'drop' });
            }
            opts.push(o);
            total *= o.length;
        }
        if (total <= 1) continue;
        if (!work || work.length !== points3d.length) work = new Float64Array(points3d.length);
        work.set(points3d);
        const idx = new Int32Array(K);
        let best = null;
        for (let n = 0; total <= MAX_REPAIR_COMBOS && n < total; n++) {
            let changed = 0, drops = 0, support = 0, moved = 0;
            for (let i = 0; i < K; i++) {
                const q = 3 * ch.nodes[i], o = opts[i][idx[i]];
                if (o.kind === 'keep') { work[q] = points3d[q]; work[q + 1] = points3d[q + 1]; work[q + 2] = points3d[q + 2]; continue; }
                changed++;
                if (o.kind === 'drop') { work[q] = NaN; work[q + 1] = NaN; work[q + 2] = NaN; drops++; continue; }
                work[q] = o.X[0]; work[q + 1] = o.X[1]; work[q + 2] = o.X[2];
                support += o.support || 0;
                if (has3(points3d, q)) moved += Math.hypot(o.X[0] - points3d[q], o.X[1] - points3d[q + 1], o.X[2] - points3d[q + 2]);
            }
            const bad = chainRepairBadness(work, ch);
            const better = !best || bad < best.bad - 1e-9 || (Math.abs(bad - best.bad) <= 1e-9 &&
                (changed < best.changed || (changed === best.changed && (drops < best.drops ||
                    (drops === best.drops && (support > best.support || (support === best.support && moved < best.moved)))))));
            if (better) best = { bad: bad, changed: changed, drops: drops, support: support, moved: moved, pick: Int32Array.from(idx) };
            for (let i = 0; i < K; i++) { if (++idx[i] < opts[i].length) break; idx[i] = 0; }
        }
        let pick = best && best.bad <= 1e-9 && best.changed ? best.pick : null;
        if (!pick && K >= 2) {
            pick = outOfReachRepair(points3d, ch, opts, work);
            if (pick) out.partial++;
        }
        if (!pick) continue;
        for (let i = 0; i < K; i++) {
            const q = 3 * ch.nodes[i], o = opts[i][pick[i]];
            if (o.kind === 'keep') continue;
            if (o.kind === 'drop') { points3d[q] = NaN; points3d[q + 1] = NaN; points3d[q + 2] = NaN; out.dropped++; continue; }
            points3d[q] = o.X[0]; points3d[q + 1] = o.X[1]; points3d[q + 2] = o.X[2];
            out.changed[o.kind] = (out.changed[o.kind] || 0) + 1;
        }
        out.chains++;
    }
    return out;
}

/**
 * A chain no repair makes plausible: its points farther from their anchor than the chain can reach (`chainReach`)
 * each take an option that is within reach (a candidate, or a drop where allowed), every other point is kept, and of
 * those combinations the one with the lowest `chainRepairBadness` wins (ties as in `checkChains`), if it is lower
 * than the chain's now. `opts`: checkChains' options per chain point. -> a pick per chain point, or null.
 */
function outOfReachRepair(P, chain, opts, work) {
    const reach = chainReach(chain);
    const K = chain.nodes.length;
    const far = [];
    for (let i = 0; i < K; i++) {
        const k = chain.nodes[i], r = reach.get(k), q = 3 * k;
        if (!r || !has3(P, q) || !has3(P, 3 * r.anchor) || opts[i].length < 2) continue;
        const A = 3 * r.anchor;
        if (Math.hypot(P[q] - P[A], P[q + 1] - P[A + 1], P[q + 2] - P[A + 2]) <= r.reach) continue;
        const within = [];
        opts[i].forEach(function (o, j) {
            if (o.kind === 'drop') { within.push(j); return; }
            if (o.kind === 'keep') return;
            if (Math.hypot(o.X[0] - P[A], o.X[1] - P[A + 1], o.X[2] - P[A + 2]) <= r.reach) within.push(j);
        });
        if (within.length) far.push({ i: i, within: within });
    }
    if (!far.length) return null;
    let total = 1;
    for (const f of far) total *= f.within.length;
    if (total > MAX_REPAIR_COMBOS) return null;
    const now = chainRepairBadness(P, chain);
    const pick = new Int32Array(K), idx = new Int32Array(far.length);
    let best = null;
    for (let n = 0; n < total; n++) {
        work.set(P);
        let drops = 0, support = 0, moved = 0;
        for (let f = 0; f < far.length; f++) {
            const i = far[f].i, o = opts[i][far[f].within[idx[f]]], q = 3 * chain.nodes[i];
            if (o.kind === 'drop') { work[q] = NaN; work[q + 1] = NaN; work[q + 2] = NaN; drops++; continue; }
            work[q] = o.X[0]; work[q + 1] = o.X[1]; work[q + 2] = o.X[2];
            support += o.support || 0;
            moved += Math.hypot(o.X[0] - P[q], o.X[1] - P[q + 1], o.X[2] - P[q + 2]);
        }
        const bad = chainRepairBadness(work, chain);
        const better = !best || bad < best.bad - 1e-9 || (Math.abs(bad - best.bad) <= 1e-9 && (drops < best.drops ||
            (drops === best.drops && (support > best.support || (support === best.support && moved < best.moved)))));
        if (better) best = { bad: bad, drops: drops, support: support, moved: moved, idx: Int32Array.from(idx) };
        for (let f = 0; f < far.length; f++) { if (++idx[f] < far[f].within.length) break; idx[f] = 0; }
    }
    if (!best || !(best.bad < now - 1e-9)) return null;
    for (let f = 0; f < far.length; f++) pick[far[f].i] = far[f].within[best.idx[f]];
    return pick;
}
