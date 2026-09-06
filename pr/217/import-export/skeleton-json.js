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
 * Parse a SLEAP skeleton JSON file (jsonpickle format or simple format).
 * Returns a Skeleton object or null on failure.
 */
export function parseSkeletonJSON(jsonText) {
    var data = JSON.parse(jsonText);

    // Format 1: SLEAP jsonpickle format (has "links" array)
    if (data.links && data.nodes) {
        var name = (data.graph && data.graph.name) ? data.graph.name : 'skeleton';

        // jsonpickle assigns py/id values sequentially to objects on first
        // appearance. We scan all links to collect node names and build the
        // py/id -> name mapping.
        var nextPyId = 1;
        var pyIdToName = {};
        var edgeTypeId = null;  // py/id of the first EdgeType

        function extractNodeName(ref) {
            if (!ref || typeof ref !== 'object') return null;
            if (ref['py/id'] != null) {
                return pyIdToName[ref['py/id']] || null;
            }
            if (ref['py/object'] === 'sleap.skeleton.Node' && ref['py/state']) {
                var tuple = ref['py/state']['py/tuple'];
                var nodeName = tuple ? tuple[0] : null;
                // This object gets the next py/id
                pyIdToName[nextPyId] = nodeName;
                nextPyId++;
                return nodeName;
            }
            return null;
        }

        function extractEdgeType(ref) {
            if (!ref) return 1;
            if (ref['py/reduce']) {
                // First occurrence of EdgeType - assign py/id
                var args = ref['py/reduce'][1];
                var val = (args && args['py/tuple']) ? args['py/tuple'][0] : 1;
                edgeTypeId = nextPyId;
                nextPyId++;
                return val;
            }
            if (ref['py/id'] != null) {
                // Reference to previously seen EdgeType - assume regular (1)
                return 1;
            }
            return 1;
        }

        // Scan links to resolve all node names and edge types
        var linkData = [];
        for (var li = 0; li < data.links.length; li++) {
            var link = data.links[li];
            var srcName = extractNodeName(link.source);
            var dstName = extractNodeName(link.target);
            var eType = extractEdgeType(link.type);
            linkData.push({ src: srcName, dst: dstName, type: eType });
        }

        // Build node names from data.nodes array (preserves canonical order)
        var nodeNames = [];
        for (var ni = 0; ni < data.nodes.length; ni++) {
            var nodeEntry = data.nodes[ni];
            var nodeName = null;
            if (nodeEntry.id != null) {
                if (typeof nodeEntry.id === 'object' && nodeEntry.id['py/id'] != null) {
                    nodeName = pyIdToName[nodeEntry.id['py/id']];
                } else if (typeof nodeEntry.id === 'object' && nodeEntry.id['py/state']) {
                    var t = nodeEntry.id['py/state']['py/tuple'];
                    nodeName = t ? t[0] : null;
                } else if (typeof nodeEntry.id === 'number') {
                    nodeName = 'node_' + nodeEntry.id;
                }
            }
            nodeNames.push(nodeName || ('node_' + ni));
        }

        // Build edges (only type=1, skip symmetries)
        var edges = [];
        for (var ei = 0; ei < linkData.length; ei++) {
            if (linkData[ei].type !== 1) continue;
            var srcIdx = nodeNames.indexOf(linkData[ei].src);
            var dstIdx = nodeNames.indexOf(linkData[ei].dst);
            if (srcIdx >= 0 && dstIdx >= 0) {
                edges.push([srcIdx, dstIdx]);
            }
        }

        return new Skeleton(name, nodeNames, edges);
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
