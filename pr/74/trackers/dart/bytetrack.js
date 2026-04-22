/**
 * trackers/dart/bytetrack.js — Two-pass greedy assignment for DART.
 *
 * Implements the ByteTrack-style association described in
 * `prompts/DART_tracker.md`:
 *
 *   Pass 1 (high-confidence):
 *     - Consider only pairs whose score is strictly greater than `highThresh`.
 *     - Greedily assign the best-scoring pair in descending order, locking each
 *       pair as it is chosen. A row or column involved in a locked pair is
 *       removed from the pool.
 *
 *   Pass 2 (low-confidence gap-fill):
 *     - From rows and columns unmatched by pass 1, greedily assign the
 *       best-scoring remaining pair.
 *     - Reject any score that is not strictly greater than `lowThresh` so that
 *       obviously bad matches are left unmatched for the caller to handle
 *       (Kalman prediction, "lost" marking, etc.).
 *
 * Both passes break ties deterministically by (rowIdx, colIdx) ascending.
 * `NaN` entries are treated as `-Infinity` so they never participate in a
 * match.
 *
 * Exposes:
 *   window.LucidDART.byteTrackAssign(scoreMatrix, opts)
 *   window.LucidDART.byteTrackAssignArray(scoreMatrix, opts)
 *
 * Pure JS, no dependencies. Attaches exports as an IIFE to match the LUCID
 * convention used by `trackers/registry.js` and `trackers/default.js`.
 */

(function () {
    'use strict';

    var DEFAULT_HIGH_THRESH = 0.8;   // BYTETRACK_HIGH_THRESH
    var DEFAULT_LOW_THRESH  = 0.05;  // BYTETRACK_LOW_THRESH

    /**
     * Normalize a single matrix entry so that `NaN` becomes `-Infinity` and
     * non-finite negatives stay non-finite. Anything else is returned as a
     * plain number.
     *
     * @param {*} v
     * @returns {number}
     */
    function sanitize(v) {
        if (typeof v !== 'number' || isNaN(v)) return -Infinity;
        return v;
    }

    /**
     * Validate and measure the incoming score matrix.
     *
     * @param {number[][]} scoreMatrix
     * @returns {{ nRows: number, nCols: number }}
     */
    function shape(scoreMatrix) {
        if (!Array.isArray(scoreMatrix) || scoreMatrix.length === 0) {
            return { nRows: 0, nCols: 0 };
        }
        var nRows = scoreMatrix.length;
        var nCols = 0;
        for (var r = 0; r < nRows; r++) {
            var row = scoreMatrix[r];
            if (Array.isArray(row) && row.length > nCols) {
                nCols = row.length;
            }
        }
        return { nRows: nRows, nCols: nCols };
    }

    /**
     * Collect every (rowIdx, colIdx) pair whose score is strictly greater than
     * `threshold`. `NaN` entries are treated as `-Infinity` and skipped.
     *
     * The returned candidate list is sorted in descending order by score with a
     * deterministic tie-break by (rowIdx, colIdx) ascending.
     *
     * @param {number[][]} scoreMatrix
     * @param {Set<number>} usedRows   - row indices already locked (skipped)
     * @param {Set<number>} usedCols   - col indices already locked (skipped)
     * @param {number}      threshold  - pairs must have score > threshold
     * @returns {Array<{row: number, col: number, score: number}>}
     */
    function collectCandidates(scoreMatrix, usedRows, usedCols, threshold) {
        var candidates = [];
        for (var r = 0; r < scoreMatrix.length; r++) {
            if (usedRows.has(r)) continue;
            var row = scoreMatrix[r];
            if (!Array.isArray(row)) continue;
            for (var c = 0; c < row.length; c++) {
                if (usedCols.has(c)) continue;
                var s = sanitize(row[c]);
                if (s > threshold) {
                    candidates.push({ row: r, col: c, score: s });
                }
            }
        }
        // Descending by score, then ascending by (row, col) for determinism.
        candidates.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            if (a.row !== b.row)     return a.row - b.row;
            return a.col - b.col;
        });
        return candidates;
    }

    /**
     * Run one greedy pass. Walks the sorted candidate list once, taking each
     * pair whose row and col are still free and locking both indices.
     *
     * @param {Array<{row: number, col: number, score: number}>} candidates
     * @param {Set<number>} usedRows
     * @param {Set<number>} usedCols
     * @param {Array<[number, number]>} assignments - mutated in place
     * @returns {number} number of matches made in this pass
     */
    function greedyPass(candidates, usedRows, usedCols, assignments) {
        var made = 0;
        for (var i = 0; i < candidates.length; i++) {
            var cand = candidates[i];
            if (usedRows.has(cand.row) || usedCols.has(cand.col)) continue;
            usedRows.add(cand.row);
            usedCols.add(cand.col);
            assignments.push([cand.row, cand.col]);
            made++;
        }
        return made;
    }

    /**
     * Two-pass greedy ByteTrack assignment.
     *
     * @param {number[][]} scoreMatrix  - Rectangular similarity matrix in [0, 1]
     *                                    (non-square is fine). `NaN` cells are
     *                                    treated as -Infinity.
     * @param {Object}     [opts]
     * @param {number}     [opts.highThresh=0.8] - Pass 1 lower bound (exclusive)
     * @param {number}     [opts.lowThresh=0.05] - Pass 2 lower bound (exclusive)
     * @returns {{
     *   assignments: Array<[number, number]>,
     *   unmatchedRows: number[],
     *   unmatchedCols: number[],
     *   highConfidenceCount: number,
     *   lowConfidenceCount: number
     * }}
     */
    function byteTrackAssign(scoreMatrix, opts) {
        opts = opts || {};
        var highThresh = (typeof opts.highThresh === 'number') ? opts.highThresh : DEFAULT_HIGH_THRESH;
        var lowThresh  = (typeof opts.lowThresh  === 'number') ? opts.lowThresh  : DEFAULT_LOW_THRESH;

        var dims = shape(scoreMatrix);
        var nRows = dims.nRows;
        var nCols = dims.nCols;

        var assignments = [];
        var usedRows = new Set();
        var usedCols = new Set();

        if (nRows === 0 || nCols === 0) {
            return {
                assignments: assignments,
                unmatchedRows: nRows === 0 ? [] : rangeArray(nRows),
                unmatchedCols: nCols === 0 ? [] : rangeArray(nCols),
                highConfidenceCount: 0,
                lowConfidenceCount: 0
            };
        }

        // Pass 1 — high-confidence, score > highThresh.
        var highCandidates = collectCandidates(scoreMatrix, usedRows, usedCols, highThresh);
        var highConfidenceCount = greedyPass(highCandidates, usedRows, usedCols, assignments);

        // Pass 2 — low-confidence gap-fill on what's left. We still reject
        // scores <= lowThresh so obviously bad matches never get paired.
        var lowCandidates = collectCandidates(scoreMatrix, usedRows, usedCols, lowThresh);
        var lowConfidenceCount = greedyPass(lowCandidates, usedRows, usedCols, assignments);

        var unmatchedRows = [];
        for (var r = 0; r < nRows; r++) if (!usedRows.has(r)) unmatchedRows.push(r);
        var unmatchedCols = [];
        for (var c = 0; c < nCols; c++) if (!usedCols.has(c)) unmatchedCols.push(c);

        return {
            assignments: assignments,
            unmatchedRows: unmatchedRows,
            unmatchedCols: unmatchedCols,
            highConfidenceCount: highConfidenceCount,
            lowConfidenceCount: lowConfidenceCount
        };
    }

    /**
     * Array-shaped variant — matches the shape returned by
     * `hungarianAlgorithm(costMatrix)`: `result[rowIdx] = colIdx` (or `-1` if
     * the row was never matched). Useful as a drop-in replacement for callers
     * that index the Hungarian output directly.
     *
     * @param {number[][]} scoreMatrix
     * @param {Object}     [opts]
     * @returns {number[]} array of length `scoreMatrix.length` (0 when empty)
     */
    function byteTrackAssignArray(scoreMatrix, opts) {
        var res = byteTrackAssign(scoreMatrix, opts);
        var nRows = shape(scoreMatrix).nRows;
        var out = new Array(nRows);
        for (var i = 0; i < nRows; i++) out[i] = -1;
        for (var k = 0; k < res.assignments.length; k++) {
            var pair = res.assignments[k];
            out[pair[0]] = pair[1];
        }
        return out;
    }

    /**
     * Small helper: [0, 1, ..., n-1].
     * @param {number} n
     * @returns {number[]}
     */
    function rangeArray(n) {
        var out = new Array(n);
        for (var i = 0; i < n; i++) out[i] = i;
        return out;
    }

    // ============================================
    // Exports
    // ============================================

    window.LucidDART = window.LucidDART || {};
    window.LucidDART.byteTrackAssign      = byteTrackAssign;
    window.LucidDART.byteTrackAssignArray = byteTrackAssignArray;
})();
