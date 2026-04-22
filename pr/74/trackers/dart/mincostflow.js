/**
 * trackers/dart/mincostflow.js — Min-Cost Flow assignment solver (one DART module).
 *
 * Pure-JS successive-shortest-path min-cost flow using SPFA (Bellman-Ford with
 * a FIFO queue) on the residual graph. Handles the negative-weight edges that
 * arise after augmenting paths invert cost signs.
 *
 * Exposes two entry points on window.LucidDART:
 *
 *   minCostFlowAssign(scoreMatrix, opts)
 *       — single-frame bipartite assignment; drop-in replacement for
 *         hungarianAlgorithm() on cost = 1 - score. Returns result[row] = col
 *         (-1 if unmatched). Same array shape as hungarianAlgorithm().
 *
 *   minCostFlowAssignWindow(scoreMatricesByFrame, prevAssignmentsByFrame, opts)
 *       — windowed multi-frame variant; adds small-cost skip edges between
 *         same-track instances in consecutive frames so tracks survive missing
 *         frames at a bounded penalty.
 *
 * Graph representation:
 *   - edges[]            : flat list of directed edges.
 *     Each edge is { to, cap, cost, flow }. Residual edges sit at
 *     index i ^ 1 (edges are always pushed in forward/reverse pairs).
 *   - adj[node]          : array of edge indices touching `node`.
 *
 * Non-square / unmatched rows: rather than fabricate dummy columns we add a
 * single direct `S -> T` bypass edge of capacity `max(0, rows - cols)` and
 * cost 0. That way excess source supply (rows that have no column to match)
 * can still reach the sink without distorting assignment costs.
 *
 * Registers under window.LucidDART, mirroring the IIFE pattern used by
 * trackers/default.js and trackers/registry.js.
 */

(function (global) {
    'use strict';

    global.LucidDART = global.LucidDART || {};

    // ============================================================
    // Constants
    // ============================================================

    var INF = Number.POSITIVE_INFINITY;
    // Cost sentinel for "this edge should never be used". Chosen large enough
    // to dominate any realistic path sum (windowSize <= 5, costs in [0,1],
    // node count modest) but well under Number.MAX_SAFE_INTEGER so sums are
    // still representable without precision loss.
    var BIG_COST = 1e9;

    // ============================================================
    // Min-cost flow solver (SPFA / successive shortest paths)
    // ============================================================

    /**
     * Build an empty directed graph with `n` nodes.
     */
    function makeGraph(n) {
        var adj = new Array(n);
        for (var i = 0; i < n; i++) adj[i] = [];
        return { n: n, edges: [], adj: adj };
    }

    /**
     * Add a forward/reverse edge pair. Forward carries cap/cost;
     * reverse starts with cap 0 and negated cost. The pair lives at
     * indices (k, k+1) so we can flip direction with XOR 1.
     */
    function addEdge(g, from, to, cap, cost) {
        var k = g.edges.length;
        g.edges.push({ to: to, cap: cap, cost: cost, flow: 0 });
        g.edges.push({ to: from, cap: 0, cost: -cost, flow: 0 });
        g.adj[from].push(k);
        g.adj[to].push(k + 1);
        return k;
    }

    /**
     * SPFA (Bellman-Ford with a FIFO queue) on the residual graph.
     * Fills `dist[]` with shortest-path cost from S, and `prevEdge[]`
     * with the edge index used to reach each node. Returns true iff T
     * is reachable.
     */
    function spfa(g, S, T, dist, prevEdge) {
        var n = g.n;
        for (var i = 0; i < n; i++) { dist[i] = INF; prevEdge[i] = -1; }
        dist[S] = 0;
        var inQueue = new Uint8Array(n);
        var queue = [S];
        inQueue[S] = 1;

        while (queue.length > 0) {
            var u = queue.shift();
            inQueue[u] = 0;
            var edgeIdxs = g.adj[u];
            for (var e = 0; e < edgeIdxs.length; e++) {
                var ei = edgeIdxs[e];
                var edge = g.edges[ei];
                var residual = edge.cap - edge.flow;
                if (residual <= 0) continue;
                var nd = dist[u] + edge.cost;
                if (nd < dist[edge.to] - 1e-12) {
                    dist[edge.to] = nd;
                    prevEdge[edge.to] = ei;
                    if (!inQueue[edge.to]) {
                        inQueue[edge.to] = 1;
                        queue.push(edge.to);
                    }
                }
            }
        }

        return dist[T] < INF;
    }

    /**
     * Successive-shortest-path min-cost max-flow. Returns {flow, cost}
     * and mutates `g.edges[*].flow` in place so callers can read off
     * which augmenting edges were used (i.e. which assignments fired).
     *
     * The negative-weight edges introduced by residuals are the reason
     * we use SPFA rather than Dijkstra — no need for Johnson's potentials
     * for a module this size, and path counts are bounded by the number
     * of source-edges anyway.
     */
    function minCostFlow(g, S, T) {
        var dist = new Array(g.n);
        var prevEdge = new Array(g.n);
        var totalFlow = 0;
        var totalCost = 0;

        while (spfa(g, S, T, dist, prevEdge)) {
            // Find bottleneck along the path from T back to S.
            var pushable = INF;
            var v = T;
            while (v !== S) {
                var ei = prevEdge[v];
                var edge = g.edges[ei];
                var residual = edge.cap - edge.flow;
                if (residual < pushable) pushable = residual;
                v = g.edges[ei ^ 1].to;
            }
            if (!isFinite(pushable) || pushable <= 0) break;

            // Apply flow.
            v = T;
            while (v !== S) {
                var ei2 = prevEdge[v];
                g.edges[ei2].flow += pushable;
                g.edges[ei2 ^ 1].flow -= pushable;
                v = g.edges[ei2 ^ 1].to;
            }
            totalFlow += pushable;
            totalCost += pushable * dist[T];
        }

        return { flow: totalFlow, cost: totalCost };
    }

    // ============================================================
    // Single-frame bipartite assignment
    // ============================================================

    /**
     * Single-frame bipartite min-cost-flow assignment.
     * Drop-in replacement for hungarianAlgorithm(costMatrix) where
     * costMatrix = scoreMatrix.map(row => row.map(v => -v)).
     *
     * @param {number[][]} scoreMatrix - Non-negative similarities in [0,1].
     *                                   May be non-square or empty.
     * @param {Object}    [opts]
     * @param {number}    [opts.epsilon=1e-9] - Pairs with score < epsilon
     *                    are treated as forbidden (infinite cost).
     * @returns {number[]} result[rowIdx] = colIdx (-1 if unmatched).
     *                     length === scoreMatrix.length.
     */
    global.LucidDART.minCostFlowAssign = function minCostFlowAssign(scoreMatrix, opts) {
        opts = opts || {};
        var epsilon = (opts.epsilon != null) ? opts.epsilon : 1e-9;

        if (!scoreMatrix || scoreMatrix.length === 0) return [];
        var nRows = scoreMatrix.length;
        var nCols = (scoreMatrix[0] && scoreMatrix[0].length) || 0;

        var result = new Array(nRows).fill(-1);
        if (nCols === 0) return result;

        // Node layout:
        //   0           : S
        //   1           : T
        //   2..2+nR-1   : row nodes
        //   2+nR..end   : col nodes
        var S = 0, T = 1;
        var rowBase = 2;
        var colBase = 2 + nRows;
        var nNodes = 2 + nRows + nCols;

        var g = makeGraph(nNodes);

        // Source supply edges.
        var srcEdges = new Array(nRows);
        for (var r = 0; r < nRows; r++) {
            srcEdges[r] = addEdge(g, S, rowBase + r, 1, 0);
        }

        // Sink demand edges.
        for (var c = 0; c < nCols; c++) {
            addEdge(g, colBase + c, T, 1, 0);
        }

        // Assignment edges (record forward index so we can read assignments).
        var assignEdges = [];  // [{ row, col, edgeIdx }]
        for (var rr = 0; rr < nRows; rr++) {
            var row = scoreMatrix[rr];
            for (var cc = 0; cc < nCols; cc++) {
                var s = row[cc];
                if (s == null || s < epsilon) continue;  // skip forbidden pairs
                var cost = 1 - s;
                var idx = addEdge(g, rowBase + rr, colBase + cc, 1, cost);
                assignEdges.push({ row: rr, col: cc, edgeIdx: idx });
            }
        }

        // Bypass edge S -> T lets excess supply (rows > cols, or rows with no
        // valid column) reach the sink without taking a costly assignment.
        // Capacity = max rows lacking a column = nRows (safely high; zero-cost
        // so no distortion to optimal assignments).
        addEdge(g, S, T, nRows, 0);

        minCostFlow(g, S, T);

        // Read off assignments from flowed edges.
        for (var k = 0; k < assignEdges.length; k++) {
            var ae = assignEdges[k];
            if (g.edges[ae.edgeIdx].flow > 0) {
                result[ae.row] = ae.col;
            }
        }

        return result;
    };

    // ============================================================
    // Windowed multi-frame assignment
    // ============================================================

    /**
     * Windowed multi-frame min-cost flow.
     *
     * Solves all frames jointly with skip edges linking same-track slots
     * across consecutive frames at a small fixed penalty, so a track can
     * survive a dropped frame.
     *
     * Skip-edge semantics: we can't know ahead of time which row in frame
     * f is "the same track" as which row in frame f+1 — that's the very
     * thing we're solving for. So we model skip flow at the col-slot level:
     * each column index is treated as a persistent "slot" across frames,
     * and a skip edge of cost `skipEdgeCost` lets the slot's flow propagate
     * col_f -> col_{f+1} even when frame f has no row to fill it. This
     * mirrors the common DART formulation where column indices serve as
     * stable track anchors within the window.
     *
     * @param {number[][][]} scoreMatricesByFrame - per-frame bipartite matrices.
     * @param {Array<Array<[number, number]>>|null} [prevAssignmentsByFrame] -
     *   optional per-frame assignment hints (currently unused placeholder;
     *   preserved to keep the public interface stable).
     * @param {Object}       [opts]
     * @param {number}       [opts.windowSize=3] - clamped to [1, 5].
     * @param {number}       [opts.skipEdgeCost=0.1]
     * @param {number}       [opts.epsilon=1e-9]
     * @returns {Array<number[]>} one assignment-array per input frame.
     */
    global.LucidDART.minCostFlowAssignWindow = function minCostFlowAssignWindow(
        scoreMatricesByFrame, prevAssignmentsByFrame, opts
    ) {
        opts = opts || {};
        var windowSize = (opts.windowSize != null) ? opts.windowSize : 3;
        windowSize = Math.max(1, Math.min(5, windowSize | 0));
        var skipEdgeCost = (opts.skipEdgeCost != null) ? opts.skipEdgeCost : 0.1;
        var epsilon = (opts.epsilon != null) ? opts.epsilon : 1e-9;

        if (!scoreMatricesByFrame || scoreMatricesByFrame.length === 0) return [];

        var nFrames = scoreMatricesByFrame.length;
        var effectiveWindow = Math.min(windowSize, nFrames);

        // Degenerate case: windowSize=1 collapses to per-frame independent
        // bipartite assignment (no skip edges).
        if (effectiveWindow <= 1) {
            var out = new Array(nFrames);
            for (var f0 = 0; f0 < nFrames; f0++) {
                out[f0] = global.LucidDART.minCostFlowAssign(
                    scoreMatricesByFrame[f0], { epsilon: epsilon }
                );
            }
            return out;
        }

        // Figure out max col count across the window so col-slot indices align.
        var maxCols = 0;
        for (var f = 0; f < nFrames; f++) {
            var sm = scoreMatricesByFrame[f];
            if (sm && sm.length > 0 && sm[0] && sm[0].length > maxCols) {
                maxCols = sm[0].length;
            }
        }

        // If no frame has any columns there's nothing to assign.
        if (maxCols === 0) {
            var empty = new Array(nFrames);
            for (var fe = 0; fe < nFrames; fe++) {
                empty[fe] = (scoreMatricesByFrame[fe] || []).map(function () { return -1; });
            }
            return empty;
        }

        // Per-frame row count.
        var rowsPerFrame = new Array(nFrames);
        var totalRows = 0;
        for (var fr = 0; fr < nFrames; fr++) {
            rowsPerFrame[fr] = (scoreMatricesByFrame[fr] || []).length;
            totalRows += rowsPerFrame[fr];
        }

        // Node layout:
        //   0                                      : S
        //   1                                      : T
        //   rowStart[f] + r  (2 <= ...)            : row node for frame f, row r
        //   colStart[f] + c                        : col-slot node for frame f, col c
        //
        // (maxCols columns per frame even if a given frame has fewer, so skip
        // edges can traverse empty frames.)
        var S = 0, T = 1;
        var rowStart = new Array(nFrames);
        var colStart = new Array(nFrames);
        var cursor = 2;
        for (var fi = 0; fi < nFrames; fi++) {
            rowStart[fi] = cursor;
            cursor += rowsPerFrame[fi];
            colStart[fi] = cursor;
            cursor += maxCols;
        }
        var nNodes = cursor;

        var g = makeGraph(nNodes);

        // Record assignment edges per frame so we can decode results.
        var assignEdgesByFrame = new Array(nFrames);
        for (var ff = 0; ff < nFrames; ff++) assignEdgesByFrame[ff] = [];

        // Per-frame source/sink edges and intra-frame assignment edges.
        for (var frm = 0; frm < nFrames; frm++) {
            var smx = scoreMatricesByFrame[frm] || [];
            var nR = rowsPerFrame[frm];
            var nC = (smx[0] && smx[0].length) || 0;

            // S -> row
            for (var rIdx = 0; rIdx < nR; rIdx++) {
                addEdge(g, S, rowStart[frm] + rIdx, 1, 0);
            }
            // row -> col (assignment edges)
            for (var rI = 0; rI < nR; rI++) {
                var rowArr = smx[rI];
                if (!rowArr) continue;
                for (var cI = 0; cI < nC; cI++) {
                    var sc = rowArr[cI];
                    if (sc == null || sc < epsilon) continue;
                    var ec = 1 - sc;
                    var aidx = addEdge(g, rowStart[frm] + rI, colStart[frm] + cI, 1, ec);
                    assignEdgesByFrame[frm].push({ row: rI, col: cI, edgeIdx: aidx });
                }
            }
            // col -> T (only for cols that actually exist in this frame, so
            // the sink demand matches what the frame can supply).
            // We use `maxCols` cols for skip plumbing but sink edges should
            // cover all of them so skip-propagated flow has somewhere to go.
            for (var cT = 0; cT < maxCols; cT++) {
                // Sink capacity 1 per (frame, col-slot). Cost 0.
                addEdge(g, colStart[frm] + cT, T, 1, 0);
            }

            // Per-frame bypass S -> T for unmatched supply (see single-frame).
            if (nR > 0) addEdge(g, S, T, nR, 0);
        }

        // Skip edges: col-slot_f -> col-slot_{f+1}, for every pair of
        // consecutive frames within the window. Capacity 1 per slot is
        // enough for a single-track skip; we use 1 to keep the model clean.
        for (var fs = 0; fs + 1 < nFrames; fs++) {
            for (var cs = 0; cs < maxCols; cs++) {
                addEdge(g, colStart[fs] + cs, colStart[fs + 1] + cs, 1, skipEdgeCost);
            }
        }

        minCostFlow(g, S, T);

        // Decode: for each frame, look at flowed assignment edges.
        var results = new Array(nFrames);
        for (var df = 0; df < nFrames; df++) {
            var assignArr = new Array(rowsPerFrame[df]).fill(-1);
            var aes = assignEdgesByFrame[df];
            for (var ae = 0; ae < aes.length; ae++) {
                var entry = aes[ae];
                if (g.edges[entry.edgeIdx].flow > 0) {
                    assignArr[entry.row] = entry.col;
                }
            }
            results[df] = assignArr;
        }
        return results;
    };

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
