/**
 * test-bytetrack.js — Unit tests for trackers/dart/bytetrack.js
 *
 * Tests the two-pass greedy assignment module for DART.
 *
 * Expected globals (populated when this file runs in test-runner.html):
 *   - TestFramework (see tests/test-framework.js)
 *   - window.LucidDART.byteTrackAssign
 *   - window.LucidDART.byteTrackAssignArray
 */

(function () {
    'use strict';

    var TF = (typeof TestFramework !== 'undefined') ? TestFramework : null;
    if (!TF) return;
    var describe = TF.describe;
    var it       = TF.it;
    var assert   = TF.assert;
    var assertEqual      = TF.assertEqual;
    var assertDeepEqual  = TF.assertDeepEqual;
    var assertTrue       = TF.assertTrue;

    // Local helper: skip if module not loaded, instead of blowing up the suite.
    function dart() {
        if (typeof window === 'undefined') return null;
        if (!window.LucidDART || typeof window.LucidDART.byteTrackAssign !== 'function') {
            return null;
        }
        return window.LucidDART;
    }

    // Convert assignments list to a sorted array of "r->c" strings so deep
    // comparisons don't depend on the push order.
    function normAssignments(pairs) {
        return pairs
            .map(function (p) { return p[0] + '->' + p[1]; })
            .sort();
    }

    describe('ByteTrack - 3x3 identity-optimal', function () {
        it('picks the diagonal when scores concentrate there', function () {
            var D = dart(); if (!D) return;
            var matrix = [
                [0.9, 0.1, 0.1],
                [0.1, 0.9, 0.1],
                [0.1, 0.1, 0.9]
            ];
            var res = D.byteTrackAssign(matrix);
            assertEqual(res.assignments.length, 3, 'should match all 3 rows');
            assertEqual(res.highConfidenceCount, 3, 'all three should be high-confidence');
            assertEqual(res.lowConfidenceCount, 0, 'no low-confidence fallbacks');
            assertDeepEqual(
                normAssignments(res.assignments),
                ['0->0', '1->1', '2->2'],
                'diagonal should win'
            );
            assertEqual(res.unmatchedRows.length, 0, 'no unmatched rows');
            assertEqual(res.unmatchedCols.length, 0, 'no unmatched cols');
        });
    });

    describe('ByteTrack - 4x4 with ties', function () {
        it('breaks ties deterministically by (row, col) ascending', function () {
            var D = dart(); if (!D) return;
            // All diagonal entries tie at 0.9 — deterministic tie-break should
            // assign row r to col r (smallest (row, col) lexicographic wins).
            // Off-diagonal non-zero entries would tie too, but the diagonal is
            // picked first because (0,0) < (0,1), (1,1) < (1,2), etc.
            var matrix = [
                [0.9, 0.9, 0.1, 0.1],
                [0.9, 0.9, 0.1, 0.1],
                [0.1, 0.1, 0.9, 0.9],
                [0.1, 0.1, 0.9, 0.9]
            ];

            var r1 = D.byteTrackAssign(matrix);
            var r2 = D.byteTrackAssign(matrix);
            assertDeepEqual(
                normAssignments(r1.assignments),
                normAssignments(r2.assignments),
                'repeat runs identical'
            );

            // Expected order of greedy picks (all ties at 0.9):
            //   (0,0) taken first → locks row 0, col 0
            //   (1,1) next free pair → locks row 1, col 1
            //   (2,2) → locks row 2, col 2
            //   (3,3) → locks row 3, col 3
            assertDeepEqual(
                normAssignments(r1.assignments),
                ['0->0', '1->1', '2->2', '3->3'],
                'deterministic diagonal tie-break'
            );
            assertEqual(r1.highConfidenceCount, 4);
            assertEqual(r1.lowConfidenceCount, 0);
        });
    });

    describe('ByteTrack - non-square 3x2', function () {
        it('matches min(rows, cols) and reports the extra row as unmatched', function () {
            var D = dart(); if (!D) return;
            var matrix = [
                [0.95, 0.10],
                [0.10, 0.95],
                [0.50, 0.50]   // third row can't match, only 2 cols exist
            ];
            var res = D.byteTrackAssign(matrix);
            assertEqual(res.assignments.length, 2, '2 assignments only');
            assertEqual(res.highConfidenceCount, 2, 'both via pass 1');
            assertEqual(res.lowConfidenceCount, 0);
            assertDeepEqual(
                normAssignments(res.assignments),
                ['0->0', '1->1'],
                'rows 0, 1 match diagonal'
            );
            assertDeepEqual(res.unmatchedRows, [2], 'row 2 is unmatched');
            assertEqual(res.unmatchedCols.length, 0, 'no unmatched cols');
        });
    });

    describe('ByteTrack - all-low matrix (below high, above low)', function () {
        it('yields only pass-2 matches, highConfidenceCount is 0', function () {
            var D = dart(); if (!D) return;
            // Strong diagonal structure but every value below 0.8.
            var matrix = [
                [0.50, 0.10, 0.10],
                [0.10, 0.50, 0.10],
                [0.10, 0.10, 0.50]
            ];
            var res = D.byteTrackAssign(matrix);
            assertEqual(res.highConfidenceCount, 0, 'no high-confidence matches');
            assertEqual(res.lowConfidenceCount, 3, 'everything matches in pass 2');
            assertEqual(res.assignments.length, 3);
            assertDeepEqual(
                normAssignments(res.assignments),
                ['0->0', '1->1', '2->2'],
                'diagonal still wins under pass 2'
            );
        });
    });

    describe('ByteTrack - all-zero matrix', function () {
        it('produces no matches and reports everyone as unmatched', function () {
            var D = dart(); if (!D) return;
            var matrix = [
                [0, 0, 0],
                [0, 0, 0],
                [0, 0, 0]
            ];
            var res = D.byteTrackAssign(matrix);
            assertEqual(res.assignments.length, 0, 'no assignments');
            assertEqual(res.highConfidenceCount, 0);
            assertEqual(res.lowConfidenceCount, 0);
            assertDeepEqual(res.unmatchedRows, [0, 1, 2]);
            assertDeepEqual(res.unmatchedCols, [0, 1, 2]);
        });
    });

    describe('ByteTrack - 1x1 edge cases', function () {
        it('single-cell score > highThresh → 1 high-confidence match', function () {
            var D = dart(); if (!D) return;
            var res = D.byteTrackAssign([[0.9]]);
            assertEqual(res.assignments.length, 1);
            assertEqual(res.highConfidenceCount, 1);
            assertEqual(res.lowConfidenceCount, 0);
            assertDeepEqual(res.assignments[0], [0, 0]);
        });

        it('single-cell score < lowThresh → 0 matches', function () {
            var D = dart(); if (!D) return;
            var res = D.byteTrackAssign([[0.01]]);
            assertEqual(res.assignments.length, 0);
            assertEqual(res.highConfidenceCount, 0);
            assertEqual(res.lowConfidenceCount, 0);
            assertDeepEqual(res.unmatchedRows, [0]);
            assertDeepEqual(res.unmatchedCols, [0]);
        });

        it('single-cell score between thresholds → 1 low-confidence match', function () {
            var D = dart(); if (!D) return;
            var res = D.byteTrackAssign([[0.3]]);
            assertEqual(res.assignments.length, 1);
            assertEqual(res.highConfidenceCount, 0);
            assertEqual(res.lowConfidenceCount, 1);
        });
    });

    describe('ByteTrack - byteTrackAssignArray shape', function () {
        it('returns arr[row] = col with -1 for unmatched rows', function () {
            var D = dart(); if (!D) return;
            var matrix = [
                [0.95, 0.10],
                [0.10, 0.95],
                [0.00, 0.00]   // no useful score → unmatched
            ];
            var arr = D.byteTrackAssignArray(matrix);
            assertEqual(arr.length, 3, 'length equals rows');
            assertEqual(arr[0], 0, 'row 0 → col 0');
            assertEqual(arr[1], 1, 'row 1 → col 1');
            assertEqual(arr[2], -1, 'row 2 unmatched');
        });

        it('matches byteTrackAssign output on identity matrix', function () {
            var D = dart(); if (!D) return;
            var matrix = [
                [0.9, 0.1, 0.1],
                [0.1, 0.9, 0.1],
                [0.1, 0.1, 0.9]
            ];
            var res = D.byteTrackAssign(matrix);
            var arr = D.byteTrackAssignArray(matrix);

            // Rebuild a [row -> col] array from the structured result to
            // compare against.
            var expected = [-1, -1, -1];
            for (var i = 0; i < res.assignments.length; i++) {
                expected[res.assignments[i][0]] = res.assignments[i][1];
            }
            assertDeepEqual(arr, expected, 'shape matches structured output');
        });
    });

    // ---- Extra coverage for stated edge cases (NaN, empty matrices) ----

    describe('ByteTrack - extra edge cases', function () {
        it('0x0 matrix returns empty output', function () {
            var D = dart(); if (!D) return;
            var res = D.byteTrackAssign([]);
            assertEqual(res.assignments.length, 0);
            assertEqual(res.unmatchedRows.length, 0);
            assertEqual(res.unmatchedCols.length, 0);
            assertEqual(res.highConfidenceCount, 0);
            assertEqual(res.lowConfidenceCount, 0);
        });

        it('Nx0 matrix reports all rows as unmatched', function () {
            var D = dart(); if (!D) return;
            var res = D.byteTrackAssign([[], [], []]);
            assertEqual(res.assignments.length, 0);
            assertDeepEqual(res.unmatchedRows, [0, 1, 2]);
            assertEqual(res.unmatchedCols.length, 0);
        });

        it('NaN entries never match', function () {
            var D = dart(); if (!D) return;
            var matrix = [
                [NaN, 0.9],
                [0.9, NaN]
            ];
            var res = D.byteTrackAssign(matrix);
            assertEqual(res.assignments.length, 2);
            assertDeepEqual(
                normAssignments(res.assignments),
                ['0->1', '1->0'],
                'anti-diagonal picked, NaNs skipped'
            );
            assertEqual(res.highConfidenceCount, 2);
        });

        it('custom thresholds override defaults', function () {
            var D = dart(); if (!D) return;
            var matrix = [[0.6, 0.2]];

            // Default: 0.6 < 0.8 so it falls to pass 2.
            var defaultRes = D.byteTrackAssign(matrix);
            assertEqual(defaultRes.highConfidenceCount, 0);
            assertEqual(defaultRes.lowConfidenceCount, 1);

            // With highThresh=0.5, 0.6 > 0.5 so it's a pass-1 match.
            var tunedRes = D.byteTrackAssign(matrix, { highThresh: 0.5 });
            assertEqual(tunedRes.highConfidenceCount, 1);
            assertEqual(tunedRes.lowConfidenceCount, 0);

            // With lowThresh=0.7, 0.6 is rejected from both passes.
            var strictRes = D.byteTrackAssign(matrix, { lowThresh: 0.7 });
            assertEqual(strictRes.assignments.length, 0);
        });
    });
})();
