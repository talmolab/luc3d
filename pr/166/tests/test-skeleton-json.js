/**
 * test-skeleton-json.js - Round-trip tests for the standalone .skeleton.json
 * (de)serialization in import-export/skeleton-json.js.
 *
 * Regression focus: edgeless nodes (typically the trailing ones) must keep their
 * names through buildSkeletonJSON -> parseSkeletonJSON. The old exporter only
 * wrote a node's full definition into `links`, so nodes with no edges came back
 * renamed to "node_<i>".
 */

(function () {
    const { describe, it, assertEqual, assertDeepEqual, assertTrue } = TestFramework;

    function roundTrip(sk) {
        return parseSkeletonJSON(JSON.stringify(buildSkeletonJSON(sk)));
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
    });
})();
