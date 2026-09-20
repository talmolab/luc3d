/**
 * test-occlusion-derive.js — unit tests for nulledNodesFromOcclusion
 * (import-export/import-track-resolve.js), bridged to window in test-runner.html.
 *
 * Regression guard for the UNLINKED-occlusion round-trip bug
 * (branch eric/occlusion-skeleton-issue): occluding a node on an ungrouped
 * (unlinked) user label — e.g. a prediction converted to a user label that was
 * never grouped — then saving/reopening the project dropped the occlusion. The
 * nulledNodes FLAG is only persisted in per-group metadata, but the occlusion
 * IS in the file as finite-xy + not-visible; this helper rebuilds the flag from
 * that signal on load, for user instances only.
 */

(function () {
    var describe = TestFramework.describe;
    var it = TestFramework.it;
    var assertTrue = TestFramework.assertTrue;
    var assertFalse = TestFramework.assertFalse;
    var assertNull = TestFramework.assertNull;
    var assertNotNull = TestFramework.assertNotNull;
    var assertEqual = TestFramework.assertEqual;

    var P = [[100, 200], [300, 400], [500, 600]]; // three present points

    describe('nulledNodesFromOcclusion — user occlusion is derived from invisibility', function () {
        it('a present-but-occluded node on a user instance → included in nulledNodes', function () {
            var s = nulledNodesFromOcclusion(P, [false, true, false], 'user');
            assertNotNull(s, 'returns a Set (not null)');
            assertTrue(s.has(1), 'node 1 (occluded + present) is flagged occluded');
        });

        it('a non-occluded node is NOT flagged', function () {
            var s = nulledNodesFromOcclusion(P, [false, true, false], 'user');
            assertFalse(s.has(0), 'node 0 (visible) is not occluded');
            assertFalse(s.has(2), 'node 2 (visible) is not occluded');
        });

        it('multiple occluded nodes are all flagged', function () {
            var s = nulledNodesFromOcclusion(P, [true, false, true], 'user');
            assertTrue(s.has(0) && s.has(2), 'nodes 0 and 2 both flagged');
            assertEqual(s.size, 2, 'exactly two nodes flagged');
        });

        it('returns a real Set instance', function () {
            var s = nulledNodesFromOcclusion(P, [false, true, false], 'user');
            assertTrue(s instanceof Set, 'result is a Set');
        });
    });

    describe('nulledNodesFromOcclusion — cases that must NOT flag anything', function () {
        it('a MISSING (null) point cannot be occluded, even if flagged', function () {
            var pts = [[100, 200], null, [500, 600]];
            var s = nulledNodesFromOcclusion(pts, [false, true, false], 'user');
            // node 1 has no position → not an occluded-but-placed keypoint
            assertNull(s, 'no placed+occluded node → null');
        });

        it('no occluded nodes at all → null', function () {
            assertNull(nulledNodesFromOcclusion(P, [false, false, false], 'user'),
                'all-visible user instance → null');
        });

        it('a PREDICTED instance is never derived (invisible = low-confidence, not occluded)', function () {
            assertNull(nulledNodesFromOcclusion(P, [false, true, false], 'predicted'),
                'predicted instance → null even with an invisible point');
        });

        it('a missing occluded array → null', function () {
            assertNull(nulledNodesFromOcclusion(P, null, 'user'), 'no occluded array → null');
            assertNull(nulledNodesFromOcclusion(P, undefined, 'user'), 'undefined occluded → null');
        });
    });
})();
