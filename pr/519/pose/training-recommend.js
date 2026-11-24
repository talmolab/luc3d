/**
 * pose/training-recommend.js — the Training panel's pipeline recommendation (★) and the
 * skeleton checks that disable or block a model type.
 *
 * Port of sleap-app `src/components/panels/TrainingPanel.tsx` (`recommendPipeline`,
 * `isSkeletonConnected`, `getSkeletonCompatibility`) and `src/lib/trainingChecks.ts`
 * (`arborescenceProblems`, `arborescenceMessage`) @ c97c6a5. Same rules and messages.
 *
 * LUCID changes: the recommendation reads the user instances of every included (session, view),
 * each against ITS OWN video's size (a "small animal" is small relative to the camera that saw
 * it); edges are `[from, to]` index pairs (LUC3D's skeleton), not node objects. DOM-free
 * (Node tests: tests/test-training-recommend.mjs).
 */

/** @typedef {{nodes: string[], edges: number[][]}} SkeletonLike */

/** Is every node reachable from the first one over undirected edges? */
export function isSkeletonConnected(sk) {
    const n = (sk && sk.nodes) ? sk.nodes.length : 0;
    if (n <= 1) return true;
    const edges = (sk && sk.edges) || [];
    if (edges.length === 0) return false;
    const adj = Array.from({ length: n }, function () { return []; });
    for (const e of edges) {
        if (e[0] >= 0 && e[0] < n && e[1] >= 0 && e[1] < n) { adj[e[0]].push(e[1]); adj[e[1]].push(e[0]); }
    }
    const seen = new Set([0]);
    const stack = [0];
    while (stack.length) {
        const c = stack.pop();
        for (const m of adj[c]) if (!seen.has(m)) { seen.add(m); stack.push(m); }
    }
    return seen.size === n;
}

const BOTTOM_UP_TYPES = ['bottom_up', 'bottom_up_id'];

/**
 * Model types the skeleton rules out, and warnings for ones it makes worse.
 * @returns {{disabledTypes: Set<string>, warnings: Map<string, string>}}
 */
export function skeletonCompatibility(sk) {
    const disabledTypes = new Set();
    const warnings = new Map();
    if (!sk) return { disabledTypes: disabledTypes, warnings: warnings };
    if (!sk.edges || sk.edges.length === 0) {
        for (const t of BOTTOM_UP_TYPES) disabledTypes.add(t);
    } else if (!isSkeletonConnected(sk)) {
        for (const t of BOTTOM_UP_TYPES) warnings.set(t, 'Bottom-Up works best with a fully connected skeleton');
    }
    return { disabledTypes: disabledTypes, warnings: warnings };
}

/**
 * Why the skeleton is not an arborescence (a directed tree with one root), or null when it is.
 * Bottom-up's part affinity fields group nodes by walking the edges from the root.
 * @returns {{roots: string[], multiParent: string[], cycles: string[][]}|null}
 */
export function arborescenceProblems(sk) {
    const names = (sk.nodes || []).slice();
    const inDegree = names.map(function () { return 0; });
    const children = names.map(function () { return []; });
    for (const e of sk.edges || []) {
        if (!(e[0] >= 0 && e[0] < names.length && e[1] >= 0 && e[1] < names.length)) continue;
        inDegree[e[1]]++;
        children[e[0]].push(e[1]);
    }
    const rootIdx = names.map(function (_, i) { return i; }).filter(function (i) { return inDegree[i] === 0; });
    const roots = rootIdx.length > 1 ? rootIdx.map(function (i) { return names[i]; }) : [];
    const multiParent = names.filter(function (_, i) { return inDegree[i] > 1; });
    const cycles = findCycles(names, children);
    if (roots.length === 0 && multiParent.length === 0 && cycles.length === 0) return null;
    return { roots: roots, multiParent: multiParent, cycles: cycles };
}

function findCycles(names, children) {
    const state = new Map();
    const stack = [];
    const cycles = [];
    const inCycle = new Set();
    function visit(n) {
        state.set(n, 'visiting');
        stack.push(n);
        for (const c of children[n]) {
            if (state.get(c) === 'visiting') {
                if (!inCycle.has(c)) {
                    const cycle = stack.slice(stack.indexOf(c));
                    cycle.forEach(function (m) { inCycle.add(m); });
                    cycles.push(cycle.concat([c]).map(function (i) { return names[i]; }));
                }
            } else if (!state.has(c)) {
                visit(c);
            }
        }
        stack.pop();
        state.set(n, 'done');
    }
    for (let i = 0; i < names.length; i++) if (!state.has(i)) visit(i);
    return cycles;
}

/** Legacy SLEAP's message for a skeleton bottom-up cannot train on. */
export function arborescenceMessage(p) {
    const parts = ['Bottom-Up needs a skeleton that is a tree with one root.'];
    if (p.roots.length > 0) parts.push('There are several root nodes (nodes no edge points to): ' + p.roots.join(', ') + '.');
    if (p.multiParent.length > 0) parts.push('These nodes are the target of more than one edge: ' + p.multiParent.join(', ') + '.');
    if (p.cycles.length > 0) parts.push('The edges form a cycle: ' + p.cycles.map(function (c) { return c.join(' → '); }).join('; ') + '.');
    return parts.join(' ');
}

/**
 * Suggest a pipeline from the project's GROUND TRUTH (user instances), or null with nothing to
 * go on (no user instance anywhere: absence of labels is not evidence of a single animal).
 *
 * @param {{frames: Array<{instances: Array<Array<[number, number, boolean]>>, maxDim: number}>,
 *          numEdges: number, trackCount: number}} summary
 *   one entry per labelled (session, view, frame): each user instance's points as
 *   `[x, y, visible]`, and the larger side of that view's video (0 when unknown)
 * @returns {{recommended: string, reason: string, alternatives: string[]}|null}
 */
export function recommendPipeline(summary) {
    if (!summary || !summary.frames || summary.frames.length === 0) return null;
    let maxInstances = 0;
    let ratioSum = 0, ratioCount = 0;
    for (const fr of summary.frames) {
        if (fr.instances.length > maxInstances) maxInstances = fr.instances.length;
        for (const pts of fr.instances) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, valid = 0, maxCoord = 0;
            for (const p of pts) {
                if (!p[2] || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
                minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
                maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
                maxCoord = Math.max(maxCoord, p[0], p[1]);
                valid++;
            }
            if (valid < 2) continue;
            const dim = fr.maxDim > 0 ? fr.maxDim : maxCoord;
            if (!(dim > 0)) continue;
            ratioSum += Math.max(maxX - minX, maxY - minY) / dim;
            ratioCount++;
        }
    }
    if (maxInstances === 0) return null;
    const ratio = ratioCount > 0 ? ratioSum / ratioCount : 0;
    const hasTracks = (summary.trackCount || 0) > 1;
    if (maxInstances <= 1) {
        return { recommended: 'single_animal', reason: 'Only one animal per frame', alternatives: ['top_down'] };
    }
    if (ratio < 0.20) {
        const alts = ['bottom_up'];
        if (hasTracks) alts.push('top_down_id');
        return {
            recommended: 'top_down',
            reason: 'Animals are small (~' + Math.round(ratio * 100) + '% of frame) — top-down recommended',
            alternatives: alts,
        };
    }
    if (!summary.numEdges) {
        return {
            recommended: 'top_down',
            reason: 'No skeleton edges — bottom-up requires edges for Part Affinity Fields',
            alternatives: hasTracks ? ['top_down_id'] : [],
        };
    }
    const alts = ['top_down'];
    if (hasTracks) alts.push('bottom_up_id');
    return {
        recommended: 'bottom_up',
        reason: 'Larger animals (~' + Math.round(ratio * 100) + '% of frame) — bottom-up handles occlusions well',
        alternatives: alts,
    };
}
