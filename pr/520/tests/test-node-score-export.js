/**
 * test-node-score-export.js — what `_buildSioPoints` (import-export/file-io.js)
 * writes as each point's score, which becomes `pred_points.score` on save.
 *
 * A node the model scored keeps ITS score; the instance score is only the
 * fallback for a node with none. Writing the instance score onto every node
 * (or nothing, which stores 0) is what made a reopened project's node tooltip
 * show one number for every node of an instance. The writers end to end are
 * covered by tests/e2e/node-score-tooltip.mjs; this pins the per-point rule,
 * including the multi-session `nodeOrder` remap the e2e does not reach.
 */
(function () {
    const { describe, it, assertEqual, assertTrue } = TestFramework;

    describe('SLP export: each node keeps its own model score', function () {
        it('a scored prediction writes each node\'s own score', function () {
            var inst = new Instance([[1, 2], [3, 4], [5, 6]], 0, 'predicted', 0.6);
            inst.setPointScores([0.91, 0.42, 0.07]);
            var pts = _buildSioPoints(inst, 3, 0.6);
            assertEqual(pts[0].score, Math.fround(0.91), 'node 0');
            assertEqual(pts[1].score, Math.fround(0.42), 'node 1');
            assertEqual(pts[2].score, Math.fround(0.07), 'node 2');
        });

        it('a node with no score of its own falls back to the instance score', function () {
            var inst = new Instance([[1, 2], [3, 4], [5, 6]], 0, 'predicted', 0.6);
            inst.setPointScores([0.91, NaN, 0.07]);
            assertEqual(_buildSioPoints(inst, 3, 0.6)[1].score, 0.6, 'the unscored node');
            var none = new Instance([[1, 2], [3, 4]], 0, 'predicted', 0.33);
            var pts = _buildSioPoints(none, 2, 0.33);
            assertTrue(pts[0].score === 0.33 && pts[1].score === 0.33, 'a prediction made in LUCID: the instance score on every node');
        });

        it('no score at all when the writer asks for none (a user instance)', function () {
            var inst = new Instance([[1, 2], [3, 4]], 0, 'user', 1);
            inst.setPointScores([0.5, 0.5]);   // left over from before an edit
            var pts = _buildSioPoints(inst, 2);
            assertTrue(!('score' in pts[0]) && !('score' in pts[1]), 'no score field');
        });

        it('nodeOrder: the canonical node gets its LOCAL node\'s score', function () {
            // This session lists the nodes as [tail, head]; the canonical order
            // is [head, tail, whisker], and whisker has no local node.
            var inst = new Instance([[30, 30], [10, 10]], 0, 'predicted', 0.5);
            inst.setPointScores([0.2, 0.8]);
            var pts = _buildSioPoints(inst, 3, 0.5, [1, 0, null]);
            assertEqual(pts[0].xy[0], 10, 'canonical head is local node 1');
            assertEqual(pts[0].score, Math.fround(0.8), 'and carries local node 1\'s score');
            assertEqual(pts[1].score, Math.fround(0.2), 'canonical tail: local node 0\'s score');
            assertEqual(pts[2].score, 0.5, 'a canonical node with no local node: the instance score, never node 0\'s');
        });

        it('a caller-supplied nodeScore (the lazy writer reading the store) wins', function () {
            var inst = new Instance([[1, 2], [3, 4]], 0, 'predicted', 0.5);
            var pts = _buildSioPoints(inst, 2, 0.5, null, function (k) { return k === 0 ? 0.25 : NaN; });
            assertEqual(pts[0].score, 0.25, 'the supplied score');
            assertEqual(pts[1].score, 0.5, 'NaN from it falls back to the instance score');
        });
    });
})();
