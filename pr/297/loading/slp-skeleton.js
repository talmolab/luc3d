/**
 * slp-skeleton.js — a SLEAP `.slp`'s skeleton, read from its `metadata.json`,
 * and the node-order reconciliation a per-camera folder load needs.
 *
 * ## Two layouts for one skeleton entry
 *
 * `metadata.json.skeletons[i]` is a networkx node-link graph, stored either
 *
 *   FLAT    `{ directed, graph, links, multigraph, nodes }`, or
 *   NESTED  `{ description, nx_graph: { directed, graph, links, multigraph,
 *              nodes }, preview_image }` — classic PyQt-SLEAP's jsonpickled
 *           template skeleton (seen in a SLEAP 1.2.9 prediction file).
 *
 * Reading `entry.nodes` / `entry.links` off a NESTED entry finds neither, and
 * the fallback for "no node ids" — adopt the GLOBAL `metadata.nodes` list
 * as-is — then names every keypoint column after the wrong node, while the
 * empty `links` drops every edge. Nothing errors: geometry by column index is
 * untouched, so tracking and triangulation look fine, and everything BY NAME
 * (labels, node weights, body-node choices, crop orientation) is silently
 * wrong. `skeletonGraph` unwraps the entry once, and every reader goes through
 * it. The vendored sleap-io.js `parseSkeletons` had the same blind spot; it is
 * patched to the same rule (upstream sleap-io.js#250, see CLAUDE.md).
 *
 * ## Column order
 *
 * `metadata.nodes` is the GLOBAL node list in arbitrary order. Points in the
 * HDF5 `points` / `pred_points` tables are stored in SKELETON order, which is
 * `graph.nodes[i].id` — an index INTO the global list. So column `i` is named
 * `nodes[graph.nodes[i].id]`, and a link's `source` / `target` are global ids
 * that have to be re-expressed as column positions.
 *
 * ## Edge types
 *
 * jsonpickle writes each distinct `EdgeType` IN FULL the first time it appears
 * (`py/reduce`, or a bare `py/tuple`) and by reference afterwards
 * (`{"py/id": n}`), numbering them in order of first appearance. A skeleton
 * with two symmetric pairs therefore spells its SECOND symmetry `{"py/id": 2}`,
 * so reading only the inline form makes it a body edge. `resolveEdgeType`
 * mirrors the vendored reader's cache exactly, so the two readers agree.
 *
 * ## Cross-camera node order
 *
 * A per-camera session folder holds one file per camera and the session has
 * ONE skeleton. `nodeOrderRemap` compares a camera's own column order with the
 * session's: the same names in a different order are REMAPPED (lossless, by
 * name), different names are reported so the loader can say so — never loaded
 * by column under another file's names in silence.
 *
 * Imports NOTHING, so it loads in the SLP import worker, on the main thread
 * and in Node (`tests/test-slp-skeleton.mjs`).
 */

/** BODY edge type (SLEAP `EdgeType.BODY`). */
export var EDGE_BODY = 1;
/** SYMMETRY edge type (SLEAP `EdgeType.SYMMETRY`). */
export var EDGE_SYMMETRY = 2;

/**
 * The node-link graph of one `metadata.skeletons[i]` entry, whichever of the
 * two layouts it is stored in.
 *
 * @param {Object} entry - one `skeletons[i]`
 * @returns {Object} the dict holding `nodes` / `links` / `graph`
 */
export function skeletonGraph(entry) {
    if (!entry || typeof entry !== 'object') return {};
    return (entry.nx_graph && typeof entry.nx_graph === 'object') ? entry.nx_graph : entry;
}

/**
 * Resolve a link's jsonpickled `type` to its EdgeType value, registering every
 * inline definition so a later `{"py/id": n}` reference resolves to it. Same
 * rule as the vendored sleap-io.js `resolveEdgeType` (an unknown `py/id` falls
 * back to the id itself; a missing type is a body edge).
 *
 * @param {*} edgeType - `link.type`
 * @param {Map<number, number>} cache - py/id -> EdgeType value, per skeleton
 * @param {{nextId: number}} state - next py/id to assign, per skeleton
 * @returns {number}
 */
export function resolveEdgeType(edgeType, cache, state) {
    if (!edgeType || typeof edgeType !== 'object') return EDGE_BODY;
    var tuple = null;
    if (edgeType['py/reduce']) {
        var reduce = edgeType['py/reduce'];
        tuple = Array.isArray(reduce) && reduce[1] ? reduce[1]['py/tuple'] : null;
    } else if (edgeType['py/tuple']) {
        tuple = edgeType['py/tuple'];
    } else if (edgeType['py/id'] !== undefined) {
        var known = cache.get(edgeType['py/id']);
        return known !== undefined ? known : edgeType['py/id'];
    } else {
        return EDGE_BODY;
    }
    var value = (tuple && tuple[0] != null) ? tuple[0] : EDGE_BODY;
    cache.set(state.nextId, value);
    state.nextId += 1;
    return value;
}

/**
 * The first skeleton of a `.slp`'s parsed `metadata.json`, in COLUMN order.
 *
 * @param {Object} metadataJson - the parsed `metadata` group's `json` attr
 * @returns {{name: string, nodes: string[], edges: Array<[number, number]>}}
 *   `nodes[i]` names keypoint column `i`; `edges` are the BODY edges as column
 *   positions (symmetries excluded), in file order.
 */
export function parseSlpSkeleton(metadataJson) {
    var meta = metadataJson || {};
    var globalNodes = (meta.nodes || []).map(function (n) {
        return (n && typeof n === 'object') ? n.name : n;
    });
    var entries = meta.skeletons || [];
    if (entries.length === 0) return { name: 'skeleton', nodes: globalNodes, edges: [] };

    var entry = entries[0];
    var graph = skeletonGraph(entry);
    var name = (graph.graph && graph.graph.name) || entry.name || 'skeleton';

    // graph.nodes[i].id = the global node id at column i.
    var graphNodes = graph.nodes || [];
    var hasIdMapping = graphNodes.length > 0 && graphNodes[0] && typeof graphNodes[0].id === 'number';
    var nodes;
    var idToPos = new Map();
    if (hasIdMapping) {
        nodes = [];
        for (var i = 0; i < graphNodes.length; i++) {
            var gid = graphNodes[i].id;
            idToPos.set(gid, i);
            nodes.push(gid < globalNodes.length ? globalNodes[gid] : 'node_' + i);
        }
    } else {
        // No id mapping: the global order IS the column order.
        nodes = globalNodes;
    }

    var edges = [];
    var typeCache = new Map();
    var typeState = { nextId: 1 };
    var links = graph.links || [];
    for (var li = 0; li < links.length; li++) {
        var link = links[li];
        // Resolve the type of EVERY link, kept or not, so py/id numbering
        // stays in step with the file.
        var type = resolveEdgeType(link && link.type, typeCache, typeState);
        if (!link || typeof link.source !== 'number' || typeof link.target !== 'number') continue;
        if (type === EDGE_SYMMETRY) continue;
        var src = hasIdMapping ? idToPos.get(link.source) : (link.source < nodes.length ? link.source : undefined);
        var dst = hasIdMapping ? idToPos.get(link.target) : (link.target < nodes.length ? link.target : undefined);
        if (src !== undefined && dst !== undefined) edges.push([src, dst]);
    }
    return { name: name, nodes: nodes, edges: edges };
}

/**
 * How one camera's keypoint columns relate to the session skeleton's.
 *
 * @param {string[]} sessionNodes - the session skeleton's node names
 * @param {string[]} camNodes - this camera's file's node names, column order
 * @returns {{kind: 'same'} |
 *           {kind: 'reordered', perm: Int32Array} |
 *           {kind: 'mismatch', missing: string[], extra: string[]}}
 *   `reordered`: `perm[s]` is the camera column holding session node `s`.
 *   `mismatch`: not the same set of names (or a name repeats), so no
 *   by-name remap exists; `missing` are session nodes the camera lacks and
 *   `extra` camera nodes the session lacks (both empty for a count/duplicate
 *   mismatch over equal sets).
 */
export function nodeOrderRemap(sessionNodes, camNodes) {
    var s = sessionNodes || [], c = camNodes || [];
    var same = s.length === c.length;
    for (var i = 0; same && i < s.length; i++) same = s[i] === c[i];
    if (same) return { kind: 'same' };

    var camPos = new Map();
    var dup = false;
    for (var j = 0; j < c.length; j++) {
        if (camPos.has(c[j])) dup = true;
        camPos.set(c[j], j);
    }
    var sessSet = new Set(s);
    if (sessSet.size !== s.length) dup = true;
    var missing = s.filter(function (n) { return !camPos.has(n); });
    var extra = c.filter(function (n) { return !sessSet.has(n); });
    if (dup || missing.length > 0 || extra.length > 0 || s.length !== c.length) {
        return { kind: 'mismatch', missing: missing, extra: extra };
    }
    var perm = new Int32Array(s.length);
    for (var k = 0; k < s.length; k++) perm[k] = camPos.get(s[k]);
    return { kind: 'reordered', perm: perm };
}

/**
 * Re-order the node axis of a flat per-node buffer IN PLACE:
 * `buf[(r * n + s) * width + w] <- old buf[(r * n + perm[s]) * width + w]`
 * for every row `r` of `n` nodes.
 *
 * @param {ArrayLike<number>} buf - typed array (or array) of `rows * n * width`
 * @param {Int32Array} perm - from `nodeOrderRemap`
 * @param {number} width - values per node (2 for xy, 1 for a flag)
 */
export function permuteNodeAxis(buf, perm, width) {
    var n = perm.length;
    var stride = n * width;
    if (!buf || stride === 0) return;
    var tmp = new Float64Array(stride);
    for (var base = 0; base + stride <= buf.length; base += stride) {
        for (var t = 0; t < stride; t++) tmp[t] = buf[base + t];
        for (var s = 0; s < n; s++) {
            var from = perm[s] * width, to = s * width;
            for (var w = 0; w < width; w++) buf[base + to + w] = tmp[from + w];
        }
    }
}

/**
 * Re-order the node axis of the SLP import worker's COLUMNAR result
 * (`buildColumnarFrames`: `xy` = rows x n x 2, `occluded` = rows x n) in place,
 * so camera column `perm[s]` becomes session column `s`.
 *
 * @param {{numNodes: number, xy: Float64Array, occluded: Uint8Array}} col
 * @param {Int32Array} perm
 */
export function permuteColumnarNodes(col, perm) {
    if (!col || col.numNodes !== perm.length) return;
    permuteNodeAxis(col.xy, perm, 2);
    permuteNodeAxis(col.occluded, perm, 1);
}

/**
 * Re-order one nested-shape instance (`{ points: [[x,y]|null], occluded: [] }`,
 * the worker's default `frames` shape and `parseSlpViaSleapIO`'s) in place.
 *
 * @param {{points?: Array, occluded?: Array}} inst
 * @param {Int32Array} perm
 */
export function permuteInstanceNodes(inst, perm) {
    if (!inst) return;
    if (Array.isArray(inst.points) && inst.points.length === perm.length) {
        var p = inst.points.slice();
        for (var s = 0; s < perm.length; s++) inst.points[s] = p[perm[s]];
    }
    if (inst.occluded && inst.occluded.length === perm.length) {
        var o = Array.prototype.slice.call(inst.occluded);
        for (var t = 0; t < perm.length; t++) inst.occluded[t] = o[perm[t]];
    }
}

/**
 * Re-order the node axis of a sleap-io.js lazy `LazyDataStore` IN PLACE: each
 * instance's point rows `[point_id_start, point_id_end)` — in `pointsData`
 * (user) or `predPointsData` (predicted), by `instance_type` — every column.
 * The store is read by POSITION everywhere (the materializer, the streaming
 * writer's `appendStore`, `describeStoreFrame`, member-2D re-adoption), so
 * permuting the rows once is what makes every one of them see session order.
 * An instance whose span is not exactly `perm.length` rows is left alone.
 *
 * @param {{instancesData: Object, pointsData: Object, predPointsData: Object}} store
 * @param {Int32Array} perm - from `nodeOrderRemap`
 * @returns {number} instances re-ordered
 */
export function permuteStoreNodeRows(store, perm) {
    var idn = store && store.instancesData;
    if (!idn || !idn.point_id_start || !idn.point_id_end) return 0;
    var n = perm.length;
    var columnsOf = function (table) {
        if (!table) return [];
        return Object.keys(table).map(function (k) { return table[k]; }).filter(function (c) {
            return c && typeof c.length === 'number';
        });
    };
    var tables = [columnsOf(store.pointsData), columnsOf(store.predPointsData)];
    var tmps = tables.map(function (cols) {
        return cols.map(function (c) { return ArrayBuffer.isView(c) ? new c.constructor(n) : new Array(n); });
    });
    var starts = idn.point_id_start, ends = idn.point_id_end, types = idn.instance_type;
    var moved = 0;
    for (var j = 0; j < starts.length; j++) {
        var s = Number(starts[j]), e = Number(ends[j]);
        if (e - s !== n) continue;
        var t = (types && Number(types[j]) === 1) ? 1 : 0;
        var cols = tables[t], tmp = tmps[t];
        for (var ci = 0; ci < cols.length; ci++) {
            var col = cols[ci], buf = tmp[ci];
            if (col.length < e) continue;
            for (var k = 0; k < n; k++) buf[k] = col[s + k];
            for (var m = 0; m < n; m++) col[s + m] = buf[perm[m]];
        }
        moved++;
    }
    return moved;
}
