// import-export/skeleton-json.js
// Pure, DOM-free (de)serialization for standalone .skeleton.json files in the
// SLEAP jsonpickle node-link format. Kept separate from ui/info-panel.js (which
// owns the download / file-picker wrappers) so the round-trip logic is unit
// testable without a browser.

import { Skeleton } from '../pose/pose-data.js';

/**
 * Build the SLEAP-compatible jsonpickle skeleton object for `skeleton`.
 * Returns a plain object ready for JSON.stringify — no I/O.
 *
 * Each node's full `py/object` (which carries its name) is emitted exactly once,
 * at its first occurrence: in `links` if the node participates in an edge,
 * otherwise directly in the `nodes` array. This guarantees edgeless nodes keep
 * their names on re-import (the previous version only ever wrote full node
 * objects into `links`, so nodes with no edges lost their names and came back as
 * "node_<i>").
 *
 * @param {Skeleton} skeleton
 * @returns {Object} skeleton JSON (networkx node-link / jsonpickle shape)
 */
export function buildSkeletonJSON(skeleton) {
    var pyIdCounter = 0;
    var edgeTypeId = null;
    var links = [];
    var nodeIdMap = {};  // node index -> py/id (only for nodes emitted in links)

    function getNodeRef(nodeIdx) {
        if (nodeIdMap[nodeIdx] !== undefined) {
            return { 'py/id': nodeIdMap[nodeIdx] };
        }
        pyIdCounter++;
        nodeIdMap[nodeIdx] = pyIdCounter;
        return {
            'py/object': 'sleap.skeleton.Node',
            'py/state': { 'py/tuple': [skeleton.nodes[nodeIdx], 1.0] }
        };
    }

    function getEdgeType() {
        if (edgeTypeId !== null) {
            return { 'py/id': edgeTypeId };
        }
        pyIdCounter++;
        edgeTypeId = pyIdCounter;
        return {
            'py/reduce': [
                { 'py/type': 'sleap.skeleton.EdgeType' },
                { 'py/tuple': [1] }
            ]
        };
    }

    for (var i = 0; i < skeleton.edges.length; i++) {
        var edge = skeleton.edges[i];
        links.push({
            edge_insert_idx: i,
            key: 0,
            source: getNodeRef(edge[0]),
            target: getNodeRef(edge[1]),
            type: getEdgeType()
        });
    }

    // Build the nodes array. Nodes already emitted as full objects in `links`
    // are referenced by py/id; edgeless nodes get their full object here so their
    // name survives the round-trip.
    var nodes = [];
    for (var j = 0; j < skeleton.nodes.length; j++) {
        if (nodeIdMap[j] !== undefined) {
            nodes.push({ id: { 'py/id': nodeIdMap[j] } });
        } else {
            nodes.push({ id: {
                'py/object': 'sleap.skeleton.Node',
                'py/state': { 'py/tuple': [skeleton.nodes[j], 1.0] }
            } });
        }
    }

    return {
        directed: true,
        graph: {
            name: skeleton.name || 'skeleton',
            num_edges_inserted: skeleton.edges.length
        },
        links: links,
        multigraph: true,
        nodes: nodes
    };
}

/**
 * Read a node's name out of a jsonpickle node reference, or null if `ref` is
 * not a full node object (a `py/id` back-reference, an EdgeType, ...).
 */
function jsonPickleNodeName(ref) {
    if (!ref || typeof ref !== 'object') return null;
    var state = ref['py/state'];
    if (!state) return null;
    var tuple = state['py/tuple'];
    if (!tuple || typeof tuple[0] !== 'string') return null;
    return tuple[0];
}

/**
 * Decode the jsonpickle node-link body (the object carrying `links` + `nodes`).
 *
 * jsonpickle refers back to an already-serialized object by `py/id`, a 1-based
 * index into the objects it has memoized in first-appearance order. Rebuilding
 * that table is the whole job, and the two writers in the wild disagree about
 * what goes into it:
 *
 *  - SLEAP / sleap_io re-emit a node's FULL `py/object` at every appearance in
 *    `links`, using `py/id` only in the `nodes` array. A node takes exactly ONE
 *    slot however many edges it touches.
 *  - LUCID's own buildSkeletonJSON emits the full object once and `py/id`
 *    back-references thereafter.
 *
 * Deduplicating by name satisfies both. Counting every `py/object` (what this
 * used to do) is only right for LUCID's own files: on a SLEAP export with a hub
 * node the table gains a bogus slot per repeat, and because a SLEAP export's
 * `nodes` array is *nothing but* `py/id` references — it carries no names at
 * all — every entry past the first repeat then resolves to the wrong node. The
 * result was a silently duplicated/missing/placeholder skeleton rather than an
 * error (issue #205).
 *
 * Node ORDER has its own wrinkle. SLEAP's encoder numbers node py/ids without
 * counting the EdgeType's slot, while its decoder counts it, so a SLEAP export's
 * `nodes` array is off by one from the table it nominally indexes. sleap_io
 * copes by giving up on the array and returning edge-traversal order; we instead
 * re-read it in the node-only space, which recovers the order SLEAP actually
 * displays — and so agrees with what importing the same skeleton via a `.slp`
 * gives. Both interpretations must yield a complete permutation of the nodes to
 * be accepted, otherwise we fall back to traversal order as sleap_io does.
 *
 * Follows sleap_io/io/skeleton.py's SkeletonDecoder, the de facto reference for
 * these files.
 *
 * @param {Object} data object with `links`, `nodes` and optionally `graph`
 * @returns {Skeleton}
 */
function parseJsonPickleSkeleton(data) {
    var name = (data.graph && data.graph.name) ? data.graph.name : 'skeleton';
    var links = Array.isArray(data.links) ? data.links : [];
    var nodeRefs = Array.isArray(data.nodes) ? data.nodes : [];

    var memo = [];                          // py/id - 1 -> {node:}|{edgeType:}
    var seen = Object.create(null);         // node name -> true
    var edgeTypeIds = Object.create(null);  // edge type value -> its own py/id
    var nextEdgeTypeId = 1;

    function memoizeNode(nodeName) {
        if (nodeName == null || seen[nodeName]) return;
        seen[nodeName] = true;
        memo.push({ node: nodeName });
    }

    function reducedEdgeType(ref) {
        var args = ref['py/reduce'][1];
        return (args && args['py/tuple']) ? args['py/tuple'][0] : 1;
    }

    // Pass 1: rebuild the memo table in first-appearance order. Field order
    // within a link (source, target, type) is the order jsonpickle wrote them.
    var LINK_FIELDS = ['source', 'target', 'type'];
    for (var li = 0; li < links.length; li++) {
        var link = links[li] || {};
        for (var fi = 0; fi < LINK_FIELDS.length; fi++) {
            var ref = link[LINK_FIELDS[fi]];
            if (!ref || typeof ref !== 'object') continue;
            var nodeName = jsonPickleNodeName(ref);
            if (nodeName != null) { memoizeNode(nodeName); continue; }
            if (ref['py/reduce']) {
                var typeVal = reducedEdgeType(ref);
                memo.push({ edgeType: typeVal });
                // SLEAP's writer numbers edge types in a SEPARATE py/id space
                // (1 = regular, 2 = symmetry) that overlaps the node ids, so
                // keep both mappings and try the shared one first.
                if (edgeTypeIds[typeVal] === undefined) {
                    edgeTypeIds[typeVal] = nextEdgeTypeId++;
                }
            }
        }
    }
    // A node in no edge at all appears only in `nodes`, as a full object.
    for (var ni = 0; ni < nodeRefs.length; ni++) {
        var bareId = nodeRefs[ni] && nodeRefs[ni].id;
        if (typeof bareId === 'string') memoizeNode(bareId);
        else memoizeNode(jsonPickleNodeName(bareId));
    }

    function resolveNode(ref) {
        if (!ref || typeof ref !== 'object') return null;
        var direct = jsonPickleNodeName(ref);
        if (direct != null) return direct;
        if (ref['py/id'] != null) {
            var entry = memo[ref['py/id'] - 1];
            if (entry && entry.node !== undefined) return entry.node;
        }
        return null;
    }

    function resolveEdgeType(ref) {
        if (!ref || typeof ref !== 'object') return 1;
        if (ref['py/reduce']) return reducedEdgeType(ref);
        if (ref['py/id'] != null) {
            // LUCID's writer puts the EdgeType in the shared memo table...
            var entry = memo[ref['py/id'] - 1];
            if (entry && entry.edgeType !== undefined) return entry.edgeType;
            // ...SLEAP's numbers it in its own space, where that same py/id is
            // also a legitimate node id, so only consult this on a miss.
            for (var key in edgeTypeIds) {
                if (edgeTypeIds[key] === ref['py/id']) return Number(key);
            }
        }
        return 1;
    }

    // Pass 2: node order. `nodes` carries the order the skeleton was authored
    // in, which is the order we want to show, but its py/ids have to be read in
    // the right space (see the note above): LUCID's files index the shared memo
    // table, SLEAP's index the nodes alone. Try both and take whichever yields a
    // complete permutation of the nodes we found.
    var allNodes = [];
    for (var mi = 0; mi < memo.length; mi++) {
        if (memo[mi].node !== undefined) allNodes.push(memo[mi].node);
    }

    // Read the `nodes` array with `resolvePyId` deciding what a py/id means.
    // Returns null the moment an entry cannot be named, since a partial order
    // is not usable.
    function readOrder(resolvePyId) {
        var out = [];
        for (var oi = 0; oi < nodeRefs.length; oi++) {
            var id = nodeRefs[oi] && nodeRefs[oi].id;
            var nm = null;
            if (typeof id === 'string') nm = id;
            else if (id && typeof id === 'object') {
                nm = jsonPickleNodeName(id);
                if (nm == null && id['py/id'] != null) nm = resolvePyId(id['py/id']);
            }
            if (nm == null) return null;   // a bare index, or an unresolved id
            out.push(nm);
        }
        return out;
    }

    function isCompleteOrder(order) {
        if (!order || order.length !== allNodes.length) return false;
        var uniq = Object.create(null), n = 0;
        for (var i = 0; i < order.length; i++) {
            if (!seen[order[i]]) return false;           // not a node we know
            if (!uniq[order[i]]) { uniq[order[i]] = true; n++; }
        }
        return n === allNodes.length;                    // no repeats, none lost
    }

    // Shared space first: it is what LUCID writes, and for the first two ids it
    // agrees with the node-only space anyway.
    var sharedOrder = readOrder(function (pyId) {
        var entry = memo[pyId - 1];
        return (entry && entry.node !== undefined) ? entry.node : null;
    });
    var nodeOnlyOrder = null;
    if (!isCompleteOrder(sharedOrder)) {
        nodeOnlyOrder = readOrder(function (pyId) {
            return pyId >= 1 && pyId <= allNodes.length ? allNodes[pyId - 1] : null;
        });
    }

    var nodeNames;
    if (isCompleteOrder(sharedOrder)) {
        nodeNames = sharedOrder;
    } else if (isCompleteOrder(nodeOnlyOrder)) {
        nodeNames = nodeOnlyOrder;
    } else {
        // Neither space names every node. Resolve per entry and fill the gaps
        // with placeholders, KEEPING the array's length: a file written by the
        // old exporter that dropped edgeless nodes' names (see the regression
        // note in tests/test-skeleton-json.js) leaves a py/id pointing at
        // nothing, and its name is simply not in the file — but the node still
        // counts, because a session's per-instance point arrays are sized by
        // the node count. Losing one would shift every point after it.
        var best = [];
        var named = 0;
        for (var bi = 0; bi < nodeRefs.length; bi++) {
            var bid = nodeRefs[bi] && nodeRefs[bi].id;
            var bname = null;
            if (typeof bid === 'string') bname = bid;
            else if (bid && typeof bid === 'object') {
                bname = jsonPickleNodeName(bid);
                if (bname == null && bid['py/id'] != null) {
                    var bentry = memo[bid['py/id'] - 1];
                    if (bentry && bentry.node !== undefined) bname = bentry.node;
                }
            }
            if (bname != null) named++;
            best.push(bname != null ? bname : ('node_' + bi));
        }
        if (named === 0 && allNodes.length) {
            // The array carries nothing usable (bare networkx indices). The
            // links still name every node — sleap_io's traversal-order fallback.
            nodeNames = allNodes;
        } else {
            // Anything the array failed to mention but the links did name is
            // still a real node; keep it rather than silently dropping it.
            for (var ai = 0; ai < allNodes.length; ai++) {
                if (best.indexOf(allNodes[ai]) < 0) best.push(allNodes[ai]);
            }
            nodeNames = best;
        }
    }

    // Build edges (only type=1; skip symmetries)
    var edges = [];
    for (var ei = 0; ei < links.length; ei++) {
        var edgeLink = links[ei] || {};
        if (resolveEdgeType(edgeLink.type) !== 1) continue;
        var srcIdx = nodeNames.indexOf(resolveNode(edgeLink.source));
        var dstIdx = nodeNames.indexOf(resolveNode(edgeLink.target));
        if (srcIdx >= 0 && dstIdx >= 0) {
            edges.push([srcIdx, dstIdx]);
        }
    }

    return new Skeleton(name, nodeNames, edges);
}

/**
 * Parse a SLEAP skeleton JSON file (jsonpickle format or simple format).
 * Returns a Skeleton object or null on failure.
 */
export function parseSkeletonJSON(jsonText) {
    var data = JSON.parse(jsonText);

    // SLEAP's GUI skeleton export (Skeleton dock -> "Save As...") always wraps
    // the skeleton in a LIST, even for a single skeleton — SaveSkeleton calls
    // sleap_io.save_skeleton([skeleton]) unconditionally and the GUI offers no
    // unwrapped variant — so `[{...}]` is the shape most SLEAP users arrive
    // with. Accept it (issue #205). LUCID is one-skeleton-per-project, so a
    // multi-skeleton file contributes its first entry only.
    if (Array.isArray(data)) {
        if (data.length > 1) {
            console.warn('Skeleton file contains ' + data.length +
                ' skeletons; using the first. LUCID uses one skeleton per project.');
        }
        data = data.length ? data[0] : null;
    }
    if (!data || typeof data !== 'object') return null;

    // Some SLEAP files nest the node-link graph under "nx_graph".
    if (data.nx_graph && typeof data.nx_graph === 'object') data = data.nx_graph;

    // Format 1: SLEAP jsonpickle format (has "links" array)
    if (data.links && data.nodes) {
        return parseJsonPickleSkeleton(data);
    }

    // Format 2: Simple format (our own export or custom)
    if (data.skeleton) {
        return new Skeleton(
            data.skeleton.name || 'skeleton',
            data.skeleton.nodes || [],
            data.skeleton.edges || []
        );
    }

    // Format 3: Direct node/edge arrays
    if (data.nodes && Array.isArray(data.nodes) && !data.links) {
        var simpleNodes = data.nodes.map(function (n) {
            return typeof n === 'string' ? n : (n.name || 'node');
        });
        return new Skeleton(data.name || 'skeleton', simpleNodes, data.edges || []);
    }

    return null;
}
