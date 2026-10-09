/**
 * test-slp-skeleton.mjs — a `.slp`'s skeleton, read from `metadata.json` in
 * either layout SLEAP has written (`loading/slp-skeleton.js`, and the vendored
 * sleap-io.js `parseSkeletons`, patched to the same rule), and the cross-camera
 * node-order remap a per-camera folder load applies.
 *
 * Found on real data: one camera of a Falkner Lab session
 * (`2022-10-07/10072022142111/back`) is a SLEAP 1.2.9 file whose skeleton entry
 * is NESTED — `{description, nx_graph: {nodes, links, ...}, preview_image}` —
 * and both readers read `entry.nodes` / `entry.links` only. They found
 * neither, fell back to the GLOBAL `metadata.nodes` order and no links, so
 * every keypoint column was named after the wrong node (median Nose-Head came
 * out 66 px instead of 42 px, Ear_L-Ear_R 172 px instead of 46 px) and the
 * session had no edges. That file is the first camera parsed, so the whole
 * session took its skeleton. The metadata below is that file's, verbatim in
 * every field the readers look at.
 *
 * What is pinned:
 *   - NESTED and FLAT spellings of the same graph give the same column names
 *     and the same BODY edges, in both readers, and the two readers agree;
 *   - symmetries are excluded, including the second and later ones, which
 *     jsonpickle writes as `{"py/id": n}` references only;
 *   - `nodeOrderRemap` remaps the same names in another order, and refuses
 *     (reports) different names, a different count or a repeated name;
 *   - the three permuters (columnar worker result, nested instance, lazy
 *     store rows) move each node's values with it, NaN included, and leave an
 *     instance whose span is not the skeleton's length alone.
 *
 * The real-file half — the HDF5 readers, the per-camera folder loader eager
 * and lazy — is `tests/e2e/slp-nested-skeleton.mjs`.
 */
import {
    parseSlpSkeleton, skeletonGraph, resolveEdgeType, nodeOrderRemap,
    permuteNodeAxis, permuteColumnarNodes, permuteInstanceNodes, permuteStoreNodeRows,
    EDGE_BODY, EDGE_SYMMETRY,
} from '../loading/slp-skeleton.js';
import { parseSkeletons } from '../lib/sleap-io/chunk-H7G4PJNA.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- The real nested file's skeleton -------------------------------------
const CANON = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0',
    'Tail_1', 'Tail_2', 'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
const REAL_GLOBAL = ['Ear_L', 'TailTip', 'Trunk', 'Haunch_left', 'Tail_1', 'Tail_2', 'Neck',
    'Ear_R', 'Tail_0', 'TTI', 'Haunch_right', 'Shoulder_right', 'Nose', 'Shoulder_left', 'Head'];
const REAL_IDS = [12, 7, 0, 9, 1, 14, 2, 8, 4, 5, 13, 11, 3, 10, 6];
const REAL_LINKS = [[9, 14], [9, 8], [9, 4], [9, 5], [9, 3], [9, 10], [9, 2], [9, 1],
    [14, 12], [14, 6], [14, 13], [14, 11], [14, 7], [14, 0]];
const BODY_NAMES = REAL_LINKS.map(([s, t]) => [REAL_GLOBAL[s], REAL_GLOBAL[t]]);

const reduceType = v => ({ 'py/reduce': [{ 'py/type': 'sleap.skeleton.EdgeType' }, { 'py/tuple': [v] }] });

function realGraph(extraLinks = []) {
    return {
        directed: true,
        graph: { name: 'Skeleton-0', num_edges_inserted: 20 },
        links: REAL_LINKS.map(([s, t], i) => ({
            edge_insert_idx: i, key: 0, source: s, target: t,
            type: i === 0 ? reduceType(1) : { 'py/id': 1 },
        })).concat(extraLinks),
        multigraph: true,
        nodes: REAL_IDS.map(id => ({ id })),
    };
}
const meta = (entry, global = REAL_GLOBAL) => ({
    version: '2.0.0', nodes: global.map(name => ({ name, weight: 1.0 })), skeletons: [entry],
});
const NESTED = meta({ description: null, nx_graph: realGraph(), preview_image: null });
const FLAT = meta(realGraph());
const edgeNames = (nodes, edges) => edges.map(([a, b]) => nodes[a] + '-' + nodes[b]).sort();
const BODY_SORTED = BODY_NAMES.map(([a, b]) => a + '-' + b).sort();

console.log('\n1. parseSlpSkeleton — the real nested file');
{
    const s = parseSlpSkeleton(NESTED);
    check(eq(s.nodes, CANON), 'nodes are the COLUMN order (Nose, Ear_R, Ear_L, ...), not the global order');
    check(!eq(s.nodes, REAL_GLOBAL), 'and not the global order the old reader fell back to');
    check(s.edges.length === 14, `all 14 links read (got ${s.edges.length})`);
    check(eq(edgeNames(s.nodes, s.edges), BODY_SORTED), 'each edge joins the nodes its link names (TTI-Head, Head-Nose, ...)');
    check(s.name === 'Skeleton-0', `name from nx_graph.graph.name (got ${s.name})`);
    const f = parseSlpSkeleton(FLAT);
    check(eq(f, s), 'the FLAT spelling of the same graph parses identically');
}

console.log('\n2. Symmetries are excluded, including py/id references');
{
    // SYMMETRY first appears BETWEEN two body edges, so it is py/id 2 and the
    // body edges after it keep referring to py/id 1.
    const g = realGraph();
    const sym = (s, t, type) => ({ key: 0, source: REAL_GLOBAL.indexOf(s), target: REAL_GLOBAL.indexOf(t), type });
    g.links.splice(1, 0, sym('Ear_L', 'Ear_R', reduceType(2)));
    g.links.push(sym('Ear_R', 'Ear_L', { 'py/id': 2 }),
        sym('Shoulder_left', 'Shoulder_right', { 'py/id': 2 }),
        sym('Shoulder_right', 'Shoulder_left', { 'py/id': 2 }));
    for (const [label, m] of [['nested', meta({ nx_graph: g })], ['flat', meta(g)]]) {
        const s = parseSlpSkeleton(m);
        check(s.edges.length === 14 && eq(edgeNames(s.nodes, s.edges), BODY_SORTED),
            `${label}: exactly the 14 body edges, no symmetry (got ${s.edges.length})`);
        const v = parseSkeletons(m)[0];
        check(v.edgeIndices.length === 14 && eq(edgeNames(v.nodeNames, v.edgeIndices), BODY_SORTED),
            `${label}: vendored reader, the same 14 body edges (got ${v.edgeIndices.length})`);
        check(v.symmetries.length === 2, `${label}: vendored reader sees the 2 symmetric pairs (got ${v.symmetries.length})`);
    }
    // The inline-only `py/tuple` spelling registers an id too.
    const cache = new Map(), st = { nextId: 1 };
    check(resolveEdgeType({ 'py/tuple': [2] }, cache, st) === EDGE_SYMMETRY && resolveEdgeType({ 'py/id': 1 }, cache, st) === EDGE_SYMMETRY,
        'a bare py/tuple definition is referenced by py/id like a py/reduce one');
    check(resolveEdgeType(undefined, cache, st) === EDGE_BODY, 'a link with no type is a body edge');
}

console.log('\n3. The vendored sleap-io.js reader agrees (local patch, luc3d nested-skeleton)');
for (const [label, m] of [['nested', NESTED], ['flat', FLAT]]) {
    const v = parseSkeletons(m)[0];
    const s = parseSlpSkeleton(m);
    check(eq(v.nodeNames, s.nodes), `${label}: same column names as parseSlpSkeleton`);
    check(eq(v.edgeIndices, s.edges), `${label}: same edges, same order`);
    check(v.name === 'Skeleton-0', `${label}: name ${v.name}`);
}

console.log('\n4. skeletonGraph');
{
    const g = { nodes: [], links: [] };
    check(skeletonGraph({ nx_graph: g }) === g && skeletonGraph(g) === g, 'unwraps nx_graph, else the entry itself');
    check(eq(skeletonGraph(null), {}), 'tolerates a missing entry');
    check(eq(parseSlpSkeleton({ nodes: [{ name: 'a' }, { name: 'b' }] }), { name: 'skeleton', nodes: ['a', 'b'], edges: [] }),
        'no skeletons entry: the global list, no edges');
}

console.log('\n5. nodeOrderRemap');
{
    check(nodeOrderRemap(CANON, CANON.slice()).kind === 'same', 'identical order: same');
    const rev = CANON.slice().reverse();
    const r = nodeOrderRemap(CANON, rev);
    check(r.kind === 'reordered' && Array.from(r.perm).every((c, s) => rev[c] === CANON[s]),
        'same names reversed: reordered, perm[s] is the camera column holding session node s');
    const renamed = CANON.map(n => n === 'Nose' ? 'Snout' : n);
    const m = nodeOrderRemap(CANON, renamed);
    check(m.kind === 'mismatch' && eq(m.missing, ['Nose']) && eq(m.extra, ['Snout']), 'a renamed node: mismatch naming both');
    check(nodeOrderRemap(CANON, CANON.slice(0, 14)).kind === 'mismatch', 'one node fewer: mismatch');
    check(nodeOrderRemap(['a', 'b', 'a'], ['b', 'a', 'a']).kind === 'mismatch', 'a repeated name: mismatch (no unique remap)');
}

console.log('\n6. Permuters move each node\'s values with it');
{
    // 3 nodes; camera order [c, a, b], session order [a, b, c] -> perm [1, 2, 0].
    const perm = nodeOrderRemap(['a', 'b', 'c'], ['c', 'a', 'b']).perm;
    check(eq(Array.from(perm), [1, 2, 0]), 'perm for [c,a,b] -> [a,b,c]');

    const xy = new Float64Array([30, 31, 10, 11, NaN, NaN, /* row 2 */ 32, 33, 12, 13, 20, 21]);
    const occ = new Uint8Array([1, 0, 0, 0, 0, 1]);
    const col = { numNodes: 3, xy, occluded: occ };
    permuteColumnarNodes(col, perm);
    check(eq(Array.from(xy.slice(0, 6)).map(String), ['10', '11', 'NaN', 'NaN', '30', '31']) &&
        eq(Array.from(xy.slice(6)), [12, 13, 20, 21, 32, 33]), 'columnar xy: every row re-ordered, NaN moves with its node');
    check(eq(Array.from(occ), [0, 0, 1, 0, 1, 0]), 'columnar occlusion re-ordered with it');
    const other = { numNodes: 4, xy: new Float64Array(8).fill(1), occluded: new Uint8Array(4) };
    permuteColumnarNodes(other, perm);
    check(other.xy.every(v => v === 1), 'a columnar result of another node count is left alone');

    const inst = { points: [[30, 31], [10, 11], null], occluded: [true, false, false] };
    permuteInstanceNodes(inst, perm);
    check(eq(inst.points, [[10, 11], null, [30, 31]]) && eq(inst.occluded, [false, false, true]),
        'nested instance: points and occlusion re-ordered');

    const flags = [1, 2, 3, 4, 5, 6];
    permuteNodeAxis(flags, perm, 1);
    check(eq(flags, [2, 3, 1, 5, 6, 4]), 'permuteNodeAxis works on a plain array');
}

console.log('\n7. permuteStoreNodeRows — a lazy store, user and predicted tables');
{
    const perm = nodeOrderRemap(['a', 'b', 'c'], ['c', 'a', 'b']).perm;
    // Instances: 0 user [0,3), 1 predicted [0,3), 2 predicted [3,6), 3 predicted [6,8) (span 2 — left alone).
    const store = {
        instancesData: {
            instance_type: new Float64Array([0, 1, 1, 1]),
            point_id_start: new Float64Array([0, 0, 3, 6]),
            point_id_end: new Float64Array([3, 3, 6, 8]),
        },
        pointsData: {
            x: new Float64Array([30, 10, 20]), y: new Float64Array([31, 11, 21]),
            visible: [true, false, true], complete: new Uint8Array([1, 0, 0]),
        },
        predPointsData: {
            x: new Float64Array([3, 1, 2, 6, 4, NaN, 7, 8]), y: new Float64Array(8),
            visible: new Uint8Array([1, 1, 1, 1, 1, 0, 1, 1]), complete: new Uint8Array(8),
            score: new Float64Array([.3, .1, .2, .6, .4, .5, .7, .8]),
        },
    };
    const moved = permuteStoreNodeRows(store, perm);
    check(moved === 3, `3 instances re-ordered, the span-2 one skipped (got ${moved})`);
    check(eq(Array.from(store.pointsData.x), [10, 20, 30]) && eq(store.pointsData.visible, [false, true, true]) &&
        eq(Array.from(store.pointsData.complete), [0, 0, 1]), 'user table: every column re-ordered, a plain-array column included');
    check(eq(Array.from(store.predPointsData.x).map(String), ['1', '2', '3', '4', 'NaN', '6', '7', '8']) &&
        eq(Array.from(store.predPointsData.score), [.1, .2, .3, .4, .5, .6, .7, .8]) &&
        eq(Array.from(store.predPointsData.visible), [1, 1, 1, 1, 0, 1, 1, 1]),
        'predicted table: both instances re-ordered with their scores, the short one untouched');
    // Re-ordering back recovers the original exactly.
    const back = nodeOrderRemap(['c', 'a', 'b'], ['a', 'b', 'c']).perm;
    permuteStoreNodeRows(store, back);
    check(eq(Array.from(store.pointsData.x), [30, 10, 20]), 'the inverse permutation restores the store');
    const big = { instancesData: { instance_type: new BigInt64Array([1n]), point_id_start: new BigInt64Array([0n]), point_id_end: new BigInt64Array([3n]) },
        pointsData: {}, predPointsData: { x: new Float64Array([3, 1, 2]), id: new BigInt64Array([30n, 10n, 20n]) } };
    permuteStoreNodeRows(big, perm);
    check(eq(Array.from(big.predPointsData.x), [1, 2, 3]) && big.predPointsData.id[0] === 10n,
        'BigInt64Array index and data columns work');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
