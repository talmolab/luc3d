/**
 * test-skeleton-json.js - Round-trip tests for the standalone .skeleton.json
 * (de)serialization in import-export/skeleton-json.js.
 *
 * Regression focus: edgeless nodes (typically the trailing ones) must keep their
 * names through buildSkeletonJSON -> parseSkeletonJSON. The old exporter only
 * wrote a node's full definition into `links`, so nodes with no edges came back
 * renamed to "node_<i>".
 *
 * Second regression focus (issue #205): files written by SLEAP itself, not by
 * LUCID. SLEAP's GUI export uses a different jsonpickle dialect from ours — see
 * `sleapStyleSkeletonJSON` below — and the parser used to mis-decode it into a
 * skeleton with duplicated, missing and placeholder nodes, silently.
 */

(function () {
    const { describe, it, assertEqual, assertDeepEqual, assertTrue } = TestFramework;

    function roundTrip(sk) {
        return parseSkeletonJSON(JSON.stringify(buildSkeletonJSON(sk)));
    }

    /**
     * Emit a skeleton the way SLEAP / sleap_io writes one, which differs from
     * LUCID's own exporter in the two ways that broke the parser:
     *   - a node's FULL py/object is re-emitted at every appearance in `links`
     *     (LUCID emits it once, then py/id back-references), and
     *   - node py/ids ignore the EdgeType's slot, while the decoder counts it,
     *     so a SLEAP export's `nodes` array cannot name every node.
     * Verified to reproduce the `links` and `graph` of the real GUI export
     * attached to issue #205 exactly.
     */
    function sleapStyleSkeletonJSON(name, nodes, edges, symmetries) {
        function nodeObj(n) {
            return {
                'py/object': 'sleap.skeleton.Node',
                'py/state': { 'py/tuple': [n, 1.0] }
            };
        }
        function edgeTypeRef(value, first) {
            return first
                ? {
                    'py/reduce': [
                        { 'py/type': 'sleap.skeleton.EdgeType' },
                        { 'py/tuple': [value] }
                    ]
                }
                // SLEAP numbers edge types in their own py/id space: 1 = regular,
                // 2 = symmetry. Those ids also collide with real node ids.
                : { 'py/id': value };
        }
        const links = [];
        const nodePyId = {};
        const inLinks = {};
        let nextPyId = 1;
        let firstRegular = true;
        let firstSymmetry = true;

        function track(a, b) {
            inLinks[a] = true;
            inLinks[b] = true;
            if (nodePyId[a] === undefined) nodePyId[a] = nextPyId++;
            if (nodePyId[b] === undefined) nodePyId[b] = nextPyId++;
        }

        edges.forEach(function (e, i) {
            const s = nodes[e[0]], t = nodes[e[1]];
            links.push({
                edge_insert_idx: i,
                key: 0,
                source: nodeObj(s),
                target: nodeObj(t),
                type: edgeTypeRef(1, firstRegular)
            });
            firstRegular = false;
            track(s, t);
        });
        (symmetries || []).forEach(function (e) {
            const s = nodes[e[0]], t = nodes[e[1]];
            links.push({
                key: 0,
                source: nodeObj(s),
                target: nodeObj(t),
                type: edgeTypeRef(2, firstSymmetry)
            });
            firstSymmetry = false;
            track(s, t);
        });
        nodes.forEach(function (n) {
            if (nodePyId[n] === undefined) nodePyId[n] = nextPyId++;
        });

        return {
            directed: true,
            graph: { name: name, num_edges_inserted: edges.length },
            links: links,
            multigraph: true,
            nodes: nodes.map(function (n) {
                return { id: inLinks[n] ? { 'py/id': nodePyId[n] } : nodeObj(n) };
            })
        };
    }

    // The skeleton from issue #205: one hub node ("thorax1") in 10 of the 20
    // edges, which is what made the old py/id counter drift.
    const BUG_NODES = ['thorax1', 'head1', 'abdomen1', 'forelegL1', 'forelegR1',
        'midlegL1', 'midlegR1', 'hindlegL1', 'hindlegR1', 'wingL1', 'wingR1',
        'antennaL1', 'antennaR1', 'antennaL2', 'antennaR2', 'forelegL2',
        'forelegR2', 'midlegL2', 'midlegR2', 'hindlegL2', 'hindlegR2'];
    const BUG_EDGE_NAMES = [
        ['thorax1', 'head1'], ['thorax1', 'abdomen1'], ['thorax1', 'forelegL1'],
        ['thorax1', 'forelegR1'], ['thorax1', 'midlegL1'], ['thorax1', 'midlegR1'],
        ['thorax1', 'hindlegL1'], ['thorax1', 'hindlegR1'], ['thorax1', 'wingL1'],
        ['thorax1', 'wingR1'], ['head1', 'antennaL1'], ['head1', 'antennaR1'],
        ['antennaL1', 'antennaL2'], ['antennaR1', 'antennaR2'],
        ['forelegL1', 'forelegL2'], ['forelegR1', 'forelegR2'],
        ['midlegL1', 'midlegL2'], ['midlegR1', 'midlegR2'],
        ['hindlegL1', 'hindlegL2'], ['hindlegR1', 'hindlegR2']];
    const BUG_EDGES = BUG_EDGE_NAMES.map(function (p) {
        return [BUG_NODES.indexOf(p[0]), BUG_NODES.indexOf(p[1])];
    });

    function edgeNames(sk) {
        return sk.edges.map(function (e) { return [sk.nodes[e[0]], sk.nodes[e[1]]]; });
    }

    describe('skeleton-json round-trip', function () {
        it('preserves names of trailing edgeless nodes (regression)', function () {
            // d and e have no edges — the bug renamed them to node_3 / node_4.
            const sk = new Skeleton('arm',
                ['a', 'b', 'c', 'd', 'e'],
                [[0, 1], [1, 2]]);
            const out = roundTrip(sk);
            assertDeepEqual(out.nodes, ['a', 'b', 'c', 'd', 'e']);
            assertDeepEqual(out.edges, [[0, 1], [1, 2]]);
        });

        it('preserves a fully-connected chain (names + edges)', function () {
            const sk = Skeleton.defaultMouse();
            const out = roundTrip(sk);
            assertEqual(out.name, 'mouse');
            assertDeepEqual(out.nodes,
                ['nose', 'head', 'neck', 'body', 'tail_base', 'tail_tip']);
            assertDeepEqual(out.edges, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]);
        });

        it('preserves every name when the skeleton has no edges at all', function () {
            const sk = new Skeleton('dots', ['p', 'q', 'r'], []);
            const out = roundTrip(sk);
            assertDeepEqual(out.nodes, ['p', 'q', 'r']);
            assertEqual(out.edges.length, 0);
        });

        it('does not fall back to default node_<i> names', function () {
            const sk = new Skeleton('s', ['head', 'thorax', 'abdomen', 'tail'], [[0, 1]]);
            const out = roundTrip(sk);
            out.nodes.forEach(function (name) {
                assertTrue(name.indexOf('node_') !== 0, 'name "' + name + '" should not be a default');
            });
            assertDeepEqual(out.nodes, ['head', 'thorax', 'abdomen', 'tail']);
        });

        it('keeps a hub node correct through our own export', function () {
            // The same shape that broke SLEAP imports, via LUCID's own writer.
            const out = roundTrip(new Skeleton('bug', BUG_NODES, BUG_EDGES));
            assertDeepEqual(out.nodes, BUG_NODES);
            assertDeepEqual(edgeNames(out), BUG_EDGE_NAMES);
        });

        it('keeps the node COUNT when a legacy file has a dangling py/id', function () {
            // Files written by the pre-fix exporter reference an edgeless node
            // by a py/id that was never emitted, so its name is genuinely not
            // in the file (real example: lucid_folders/skeletons/hand-arm.json,
            // nodes [1,2,4,5] where 3 is the EdgeType and 5 is nothing). The
            // node still has to survive as a placeholder — a session's
            // per-instance point arrays are sized by the node count, so
            // dropping one shifts every point after it.
            const legacy = {
                directed: true,
                graph: { name: 'skeleton', num_edges_inserted: 2 },
                multigraph: true,
                links: [
                    {
                        edge_insert_idx: 0, key: 0,
                        source: { 'py/object': 'sleap.skeleton.Node', 'py/state': { 'py/tuple': ['shoulder', 1.0] } },
                        target: { 'py/object': 'sleap.skeleton.Node', 'py/state': { 'py/tuple': ['elbow', 1.0] } },
                        type: { 'py/reduce': [{ 'py/type': 'sleap.skeleton.EdgeType' }, { 'py/tuple': [1] }] }
                    },
                    {
                        edge_insert_idx: 1, key: 0,
                        source: { 'py/id': 2 },
                        target: { 'py/object': 'sleap.skeleton.Node', 'py/state': { 'py/tuple': ['wrist', 1.0] } },
                        type: { 'py/id': 3 }
                    }
                ],
                // py/id 5 was never assigned to anything.
                nodes: [{ id: { 'py/id': 1 } }, { id: { 'py/id': 2 } },
                { id: { 'py/id': 4 } }, { id: { 'py/id': 5 } }]
            };
            const out = parseSkeletonJSON(JSON.stringify(legacy));
            assertEqual(out.nodes.length, 4, 'the 4th node must not be dropped');
            assertDeepEqual(out.nodes, ['shoulder', 'elbow', 'wrist', 'node_3']);
            assertDeepEqual(edgeNames(out), [['shoulder', 'elbow'], ['elbow', 'wrist']]);
        });
    });

    describe('skeleton-json SLEAP import (issue #205)', function () {
        it('parses SLEAP\'s list-wrapped GUI export', function () {
            // The Skeleton dock's "Save As..." always writes [{...}], even for a
            // single skeleton; this used to return null -> "Could not parse".
            const body = sleapStyleSkeletonJSON('Skeleton-1', BUG_NODES, BUG_EDGES);
            const out = parseSkeletonJSON(JSON.stringify([body]));
            assertTrue(out !== null, 'list-wrapped skeleton should parse');
            assertEqual(out.name, 'Skeleton-1');
            assertEqual(out.nodes.length, BUG_NODES.length);
        });

        it('decodes a SLEAP export with a hub node without losing nodes', function () {
            // Regression: the py/id table used to drift one slot per repeated
            // node object, yielding "thorax1" nine times, a "node_2"
            // placeholder, and only 10 of the 20 edges.
            const json = JSON.stringify([
                sleapStyleSkeletonJSON('Skeleton-1', BUG_NODES, BUG_EDGES)]);
            const out = parseSkeletonJSON(json);

            assertEqual(out.nodes.length, 21, 'should recover all 21 nodes');
            assertEqual(new Set(out.nodes).size, 21, 'node names must be unique');
            out.nodes.forEach(function (n) {
                assertTrue(n.indexOf('node_') !== 0, 'placeholder name: ' + n);
            });
            // Order is the one the file declares, not edge-traversal order.
            assertDeepEqual(out.nodes, BUG_NODES);
            assertEqual(out.edges.length, 20, 'should recover all 20 edges');
            assertDeepEqual(edgeNames(out), BUG_EDGE_NAMES);
        });

        it('keeps the declared node order, not edge-traversal order', function () {
            // The real issue-#205 file lists its nodes grouped (all the
            // antennae together, ...), which is NOT the order the edges walk
            // them in. SLEAP's node py/ids skip the EdgeType's slot, so reading
            // them in the shared memo space loses that order; sleap_io gives up
            // and returns traversal order, we recover the declared one — which
            // is also what importing the same skeleton from a .slp gives.
            const declared = ['thorax1', 'head1', 'abdomen1', 'antennaL1',
                'antennaL2', 'antennaR1', 'antennaR2', 'forelegL1', 'forelegL2',
                'forelegR1', 'forelegR2', 'midlegL1', 'midlegL2', 'midlegR1',
                'midlegR2', 'hindlegL1', 'hindlegL2', 'hindlegR1', 'hindlegR2',
                'wingL1', 'wingR1'];
            const edges = BUG_EDGE_NAMES.map(function (p) {
                return [declared.indexOf(p[0]), declared.indexOf(p[1])];
            });
            const out = parseSkeletonJSON(JSON.stringify(
                [sleapStyleSkeletonJSON('Skeleton-1', declared, edges)]));
            assertDeepEqual(out.nodes, declared);
            assertDeepEqual(edgeNames(out), BUG_EDGE_NAMES);
        });

        it('gives the same result wrapped and unwrapped', function () {
            const body = sleapStyleSkeletonJSON('Skeleton-1', BUG_NODES, BUG_EDGES);
            const wrapped = parseSkeletonJSON(JSON.stringify([body]));
            const bare = parseSkeletonJSON(JSON.stringify(body));
            assertDeepEqual(wrapped.nodes, bare.nodes);
            assertDeepEqual(wrapped.edges, bare.edges);
        });

        it('keeps edgeless nodes from a SLEAP export', function () {
            // Isolated nodes carry their full object in `nodes`, not in `links`.
            const nodes = ['a', 'b', 'c', 'lonely'];
            const body = sleapStyleSkeletonJSON('s', nodes, [[0, 1], [1, 2]]);
            const out = parseSkeletonJSON(JSON.stringify([body]));
            assertDeepEqual(out.nodes, ['a', 'b', 'c', 'lonely']);
            assertDeepEqual(edgeNames(out), [['a', 'b'], ['b', 'c']]);
        });

        it('skips symmetry edges but keeps their nodes', function () {
            // Symmetries are type 2 and are not LUCID edges, but the nodes they
            // introduce are real. The separate edge-type py/id space is what
            // makes {"py/id": 2} mean "symmetry" here and not "node #2".
            const nodes = ['spine', 'legL', 'legR'];
            const body = sleapStyleSkeletonJSON('s', nodes, [[0, 1], [0, 2]], [[1, 2]]);
            const out = parseSkeletonJSON(JSON.stringify([body]));
            assertDeepEqual(out.nodes, ['spine', 'legL', 'legR']);
            assertDeepEqual(edgeNames(out), [['spine', 'legL'], ['spine', 'legR']]);
        });

        it('unwraps the nx_graph nesting', function () {
            const body = sleapStyleSkeletonJSON('nested', ['a', 'b'], [[0, 1]]);
            const out = parseSkeletonJSON(JSON.stringify({ nx_graph: body }));
            assertDeepEqual(out.nodes, ['a', 'b']);
            assertDeepEqual(edgeNames(out), [['a', 'b']]);
        });

        it('returns null for an empty list rather than throwing', function () {
            assertEqual(parseSkeletonJSON('[]'), null);
        });
    });
})();
