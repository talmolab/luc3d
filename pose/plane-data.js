// pose/plane-data.js — data model for user-annotated PLANES.
//
// Step 1 of re-defining the 3D viewer's origin: the user marks up a plane in
// 2D across views, and a later step solves it into a translation vector +
// rotation matrix. This module owns the two types that annotation produces and
// nothing about the solve or the UI (that lives in `ui/plane-definition.js`).
//
//   PlaneSkeleton — a named TEMPLATE: node names, the connections between
//                   them, and a per-node colour. One template can be placed on
//                   many views.
//   PlaneInstance — one template PLACED on one view: the 2D points. This is
//                   the thing the later triangulation consumes.
//
// Both subclass their pose counterparts (`Skeleton` / `Instance`) rather than
// re-implementing them. That is deliberate on two counts:
//   1. `Skeleton.removeNode`'s edge-index fixup and `Instance`'s flat-`_xy`
//      accessors are non-trivial and already covered by tests.
//   2. `ui/interaction.js` drags a PlaneInstance through the SAME code path it
//      drags a UserInstance — `hasPoint`/`getX`/`getY`/`setPoint`/`numNodes`
//      are the whole interface that path needs, so inheriting them means
//      plane editing is not a parallel implementation that can drift.
//
// PlaneInstances live on `session.planePlacements`, NOT in `frameGroups` /
// `instanceGroups`. Nothing in the existing pose pipeline can see them, so
// `type: 'plane'` never has to be handled by code that switches on
// user/predicted/reprojected.

import { Skeleton, Instance } from './pose-data.js';

/** Seed-ring radius, as a fraction of the video's shorter side. */
export const PLACEMENT_RADIUS_FRAC = 0.12;

/** Per-SKELETON colours, assigned round-robin as skeletons are created. */
export const PLANE_COLORS = [
    '#4dd0e1', '#ffb74d', '#ba68c8', '#81c784',
    '#f06292', '#7986cb', '#fff176', '#a1887f',
];

/**
 * Default per-NODE colours, assigned by node index. Chosen to stay legible on
 * video and to be tellable apart from each other — a plane node's colour is
 * the cross-view correspondence cue (red-in-camA must be the same physical
 * corner as red-in-camB), so these need to be distinguishable at a glance.
 */
export const PLANE_NODE_COLORS = [
    '#ff5252', '#40c4ff', '#69f0ae', '#ffd740',
    '#e040fb', '#ff6e40', '#18ffff', '#b2ff59',
    '#ff4081', '#7c4dff', '#eeff41', '#64ffda',
];

/** Default colour for node `i`. @param {number} i @returns {string} */
export function defaultNodeColor(i) {
    return PLANE_NODE_COLORS[i % PLANE_NODE_COLORS.length];
}

/**
 * A named plane template. Geometry is NOT stored here — see `PlaneInstance`.
 *
 * Adds `nodeColors`, kept parallel to `nodes` by overriding `addNode` /
 * `removeNode`. The overrides are what stop a colour from silently attaching
 * to the wrong node after a removal shifts every later index down.
 */
export class PlaneSkeleton extends Skeleton {
    /**
     * @param {number} id - Stable id, unique within the app session.
     * @param {string} name
     * @param {string[]} [nodes]
     * @param {[number, number][]} [edges]
     * @param {string[]} [nodeColors] - Defaults to `defaultNodeColor(i)`.
     */
    constructor(id, name, nodes, edges, nodeColors) {
        super(name, nodes || [], edges || []);
        this.id = id;
        this.color = PLANE_COLORS[(id - 1) % PLANE_COLORS.length];
        /** @type {string[]} Parallel to `nodes`. */
        this.nodeColors = [];
        for (var i = 0; i < this.nodes.length; i++) {
            this.nodeColors.push((nodeColors && nodeColors[i]) || defaultNodeColor(i));
        }
        /**
         * @type {boolean} Draw the plane's polygon filled with `color`. A plane
         * IS a polygon, so this is the shape readout — see `planePolygonOrder`.
         */
        this.filled = false;
        /**
         * @type {Float64Array|null} Flat [X,Y,Z] per node from the last
         * triangulation across the views this plane is placed on, or null if it
         * has not been triangulated. Untriangulable nodes are an all-NaN triple
         * (the same `points3d` representation `InstanceGroup` uses).
         */
        this.points3d = null;
        /**
         * @type {{views:string[], nNodes:number, meanError:number|null,
         *         nodeErrors:(number|null)[]}|null}
         * Provenance for `points3d` — which views contributed and how well it
         * reprojects. Null whenever `points3d` is null.
         */
        this.triangulation = null;
        /**
         * @type {{centroid:number[], normal:number[], rms:number,
         *         nPoints:number}|null}
         * The last plane of best fit, once `Fit` has run. `rms` is how far the
         * raw triangulated corners were off that plane BEFORE they were
         * flattened onto it. This is what a later step turns into the
         * translation + rotation that re-defines the 3D origin.
         */
        this.planeFit = null;
    }

    /**
     * Drop any triangulation result AND the plane fit derived from it. Called
     * whenever the geometry they were derived from changes (a node
     * added/removed, a placement removed, a 2D edit) so a stale 3D solve can
     * never be shown against edited 2D.
     */
    clearTriangulation() {
        this.points3d = null;
        this.triangulation = null;
        this.planeFit = null;
    }

    /**
     * @param {string} name
     * @param {string} [color] - Defaults to this index's palette entry.
     * @returns {number} Index of the new node.
     */
    addNode(name, color) {
        var idx = super.addNode(name);
        this.nodeColors[idx] = color || defaultNodeColor(idx);
        // `points3d` is indexed by node, so it cannot survive a node-list change.
        this.clearTriangulation();
        return idx;
    }

    /**
     * Remove node `nodeIdx`, keeping `nodeColors` aligned with the shifted
     * node indices.
     * @param {number} nodeIdx
     * @returns {string|null} The removed node name, or null if invalid.
     */
    removeNode(nodeIdx) {
        if (nodeIdx < 0 || nodeIdx >= this.nodes.length) return null;
        var removed = super.removeNode(nodeIdx);
        if (removed !== null) {
            this.nodeColors.splice(nodeIdx, 1);
            this.clearTriangulation();
        }
        return removed;
    }

    /** Colour of node `i` (falls back to the palette). @returns {string} */
    getNodeColor(i) {
        return this.nodeColors[i] || defaultNodeColor(i);
    }

    /** @param {number} i @param {string} color */
    setNodeColor(i, color) {
        if (i < 0 || i >= this.nodes.length || !color) return;
        this.nodeColors[i] = color;
    }
}

/**
 * One `PlaneSkeleton` placed on one camera view.
 *
 * Frame-independent by design: a plane is static scene geometry, so there is
 * deliberately no `frameIdx` — the same placement is what you see and edit on
 * every frame.
 */
export class PlaneInstance extends Instance {
    /**
     * @param {number} id - Stable id, unique within the app session.
     * @param {number} skeletonId - The `PlaneSkeleton.id` this was placed from.
     * @param {string} viewName - Camera view this is placed on.
     * @param {(number[]|null)[]|Float64Array} points - Per node, VIDEO pixels.
     */
    constructor(id, skeletonId, viewName, points) {
        // trackIdx null / score 1.0: a plane has no track and no confidence.
        super(points, null, 'plane', 1.0);
        this.id = id;
        this.skeletonId = skeletonId;
        this.viewName = viewName;
        /**
         * @type {Set<number>} Nodes the user has toggled OFF (right-click) —
         * they keep their position and still render, greyed, but a later
         * triangulation must skip them. Same meaning and same field name as a
         * UserInstance's nulled nodes, so `hasAnyUsablePoint()` (inherited)
         * already reads it correctly.
         */
        this.nulledNodes = new Set();
    }

    /** Is node `i` toggled off? @param {number} i @returns {boolean} */
    isNodeNulled(i) {
        return this.nulledNodes.has(i);
    }

    /** Toggle node `i` off/on. @param {number} i @returns {boolean} New state. */
    toggleNodeNull(i) {
        if (this.nulledNodes.has(i)) { this.nulledNodes.delete(i); return false; }
        this.nulledNodes.add(i);
        return true;
    }

    /** Centroid of the positioned nodes, or null if none. @returns {number[]|null} */
    centroid() {
        var sx = 0, sy = 0, c = 0;
        for (var i = 0; i < this.numNodes; i++) {
            if (!this.hasPoint(i)) continue;
            sx += this.getX(i); sy += this.getY(i); c++;
        }
        return c > 0 ? [sx / c, sy / c] : null;
    }

    /**
     * Grow/shrink to `nNodes` after its skeleton gained or lost nodes.
     *
     * A node added to an already-placed skeleton is given a REAL position
     * (spread from the centroid on the golden angle so repeated adds don't
     * stack) rather than left unpositioned: an unpositioned node draws
     * nothing, which would leave the user no way to grab it and place it.
     *
     * @param {number} nNodes
     * @param {number} [videoW] - Clamp bound; omitted means no clamp.
     * @param {number} [videoH]
     */
    syncToNodeCount(nNodes, videoW, videoH) {
        if (nNodes === this.numNodes) return;
        var prev = this.toPointsArray();
        var c = this.centroid() || [0, 0];
        var next = new Array(nNodes);
        for (var i = 0; i < nNodes; i++) {
            if (i < prev.length) { next[i] = prev[i]; continue; }
            // Golden angle (137.5°) keeps successive additions apart.
            var angle = i * 2.39996323;
            var x = c[0] + 25 * Math.cos(angle);
            var y = c[1] + 25 * Math.sin(angle);
            if (videoW) x = Math.min(Math.max(x, 0), videoW);
            if (videoH) y = Math.min(Math.max(y, 0), videoH);
            next[i] = [x, y];
        }
        this.setPointsFrom(next);
        // Drop any nulled flags that now point past the end.
        var stale = [];
        this.nulledNodes.forEach(function (k) { if (k >= nNodes) stale.push(k); });
        for (var s = 0; s < stale.length; s++) this.nulledNodes.delete(stale[s]);
    }

    /**
     * Drop node `nodeIdx`, mirroring `PlaneSkeleton.removeNode`'s splice so the
     * remaining points stay aligned with the renumbered nodes. Nulled flags at
     * higher indices shift down with them.
     * @param {number} nodeIdx
     */
    removeNodeAt(nodeIdx) {
        if (nodeIdx < 0 || nodeIdx >= this.numNodes) return;
        var pts = this.toPointsArray();
        pts.splice(nodeIdx, 1);
        var wasNulled = [];
        this.nulledNodes.forEach(function (k) { wasNulled.push(k); });
        this.setPointsFrom(pts);
        this.nulledNodes = new Set();
        for (var i = 0; i < wasNulled.length; i++) {
            var k = wasNulled[i];
            if (k === nodeIdx) continue;
            this.nulledNodes.add(k > nodeIdx ? k - 1 : k);
        }
    }
}

/**
 * The order to walk a plane skeleton's nodes as a POLYGON.
 *
 * A plane is a polygon, but node INDEX order only traces its outline when the
 * user happened to add the corners in ring order — connect them as a quad in
 * any other order and an index-ordered fill draws a self-intersecting bowtie.
 * So when the connections form a single simple cycle covering every node (each
 * node with exactly two distinct neighbours, one closed walk), that cycle IS
 * the outline and is returned. Anything else — an open chain, a partial cycle,
 * a branch, no edges at all — falls back to index order rather than guessing.
 *
 * @param {PlaneSkeleton} skeleton
 * @returns {number[]} Node indices in polygon order.
 */
export function planePolygonOrder(skeleton) {
    var n = skeleton.nodes.length;
    var order = [];
    for (var i = 0; i < n; i++) order.push(i);
    if (n < 3) return order;

    var adj = [];
    for (var a = 0; a < n; a++) adj.push(new Set());
    for (var e = 0; e < skeleton.edges.length; e++) {
        var s = skeleton.edges[e][0], d = skeleton.edges[e][1];
        if (s < 0 || s >= n || d < 0 || d >= n || s === d) continue;
        adj[s].add(d);
        adj[d].add(s);
    }
    // A simple cycle has every node at degree exactly 2.
    for (var c = 0; c < n; c++) if (adj[c].size !== 2) return order;

    var walk = [0];
    var seen = new Set([0]);
    var prev = -1, cur = 0;
    for (var step = 1; step < n; step++) {
        var next = -1;
        adj[cur].forEach(function (x) { if (x !== prev && next === -1) next = x; });
        // A second disjoint cycle would revisit before covering every node.
        if (next === -1 || seen.has(next)) return order;
        walk.push(next);
        seen.add(next);
        prev = cur;
        cur = next;
    }
    // …and the walk has to close back to where it started.
    if (!adj[cur].has(0)) return order;
    return walk;
}

/**
 * Seed 2D points for a freshly dropped skeleton: node 0 at 12 o'clock and the
 * rest evenly around a ring centred on the drop point, so a 4-node plane lands
 * as a recognisable quad the user can drag onto the real feature rather than a
 * pile of coincident dots. Clamped into the frame.
 *
 * @param {number} nNodes
 * @param {number} cx - Drop point X in video pixels.
 * @param {number} cy - Drop point Y in video pixels.
 * @param {number} videoW
 * @param {number} videoH
 * @returns {Array<[number, number]>}
 */
export function seedPlanePoints(nNodes, cx, cy, videoW, videoH) {
    var pts = [];
    if (nNodes <= 0) return pts;
    var clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
    if (nNodes === 1) return [[clamp(cx, 0, videoW), clamp(cy, 0, videoH)]];

    var radius = Math.min(videoW, videoH) * PLACEMENT_RADIUS_FRAC;
    for (var i = 0; i < nNodes; i++) {
        var angle = -Math.PI / 2 + (i * 2 * Math.PI) / nNodes;
        pts.push([
            clamp(cx + radius * Math.cos(angle), 0, videoW),
            clamp(cy + radius * Math.sin(angle), 0, videoH),
        ]);
    }
    return pts;
}
