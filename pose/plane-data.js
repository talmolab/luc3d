// pose/plane-data.js — data model for user-annotated PLANES.
//
// Step 1 of re-defining the 3D viewer's origin: the user marks up one or more
// planes in 2D across views, and a later step solves them into a translation
// vector + rotation matrix. This module owns the types that annotation
// produces and nothing about the solve or the UI (those live in
// `pose/triangulation.js` and `ui/plane-definition.js`).
//
//   PlaneNodePool — the GLOBAL pool of plane nodes (in `plane-nodes.js`).
//   PlaneSkeleton — one plane: an ORDERED LIST OF NODE IDS plus optional edges.
//   PlaneInstance — one camera view's 2D, covering the WHOLE pool.
//   PlaneModel    — the three of them together, and the invariants between.
//
// ## Nodes are plane-independent
//
// A node is not owned by a plane; a plane REFERENCES nodes. The same node may
// belong to any number of planes, which is what lets two planes meet along a
// shared line: the corners on that line are one node each, with one 3D
// position each, so the line cannot split apart when either plane is
// re-triangulated. Membership and edges are stored as NODE IDS, never index
// pairs — an index pair breaks the instant the pool shifts or a node is shared.
//
// `planeFit` stays per-plane. Two planes through the same edge genuinely have
// different fits, so that is not shared state; the triangulated POINTS are.
//
// ## 2D regroups per VIEW, not per (view, plane)
//
// There is exactly ONE `PlaneInstance` per view and its index space is the
// pool's node order. This is deliberate: `ui/interaction.js` drags a
// PlaneInstance through the SAME `hasPoint`/`getX`/`getY`/`setPoint`/`numNodes`
// path it drags a UserInstance through, and one instance per view keeps that
// path a single implementation. A node shared by two planes has ONE 2D point
// per view for the same reason it has one 3D point — because it is one node.
//
// Which planes are placed on which view is therefore EXPLICIT
// (`PlaneInstance.placedPlanes`) and cannot be inferred from "its nodes have
// positions here". Un-placing a plane from a view does NOT destroy 2D points:
// visibility is derived from the placed set, so there is no reference counting
// to get wrong, and re-placing a plane restores exactly what the user
// positioned. Deleting a NODE is what destroys its 2D, everywhere at once.
//
// ## 3D belongs to the node
//
// See `plane-nodes.js`. The consequence worth stating here: a plane's
// `clearTriangulation()` clears `planeFit` and the triangulation summary and
// NOTHING ELSE. It cannot destroy a node's 3D — which matters most for pinned
// (`immutable`) nodes, whose coordinates would otherwise evaporate the moment
// the user dragged an unrelated node in an unrelated view. Clearing node 3D is
// an explicit, node-scoped operation (`PlaneModel.invalidateNode3D`) that skips
// pinned nodes and never touches a node another plane still stands on.
//
// PlaneInstances live on `PlaneModel.placements`, NOT in `frameGroups` /
// `instanceGroups`. Nothing in the existing pose pipeline can see them, so
// `type: 'plane'` never has to be handled by code that switches on
// user/predicted/reprojected.

import { Instance } from './pose-data.js';
import {
    PlaneNode, PlaneNodePool, PLANE_NODE_COLORS, defaultNodeColor, nodeFreezeState,
} from './plane-nodes.js';

// Re-exported so callers can reach the whole plane model through one import.
export { PlaneNode, PlaneNodePool, PLANE_NODE_COLORS, defaultNodeColor, nodeFreezeState };

/** Seed-ring radius, as a fraction of the video's shorter side. */
export const PLACEMENT_RADIUS_FRAC = 0.12;

/** Per-PLANE colours, assigned round-robin as planes are created. */
export const PLANE_COLORS = [
    '#4dd0e1', '#ffb74d', '#ba68c8', '#81c784',
    '#f06292', '#7986cb', '#fff176', '#a1887f',
];

/** Golden angle, in radians — successive spread-out seeds never stack. */
const GOLDEN_ANGLE = 2.39996323;

/** Radius, in video px, a node added to an already-placed plane is spread by. */
const SPREAD_RADIUS = 25;

// ============================================
// PlaneSkeleton — an ordered list of node references
// ============================================

/**
 * One plane: an ORDERED list of node IDs, optional edges between them, and the
 * per-plane solve results.
 *
 * Deliberately NOT a `Skeleton` subclass any more. `Skeleton` models nodes it
 * OWNS — `addNode(name)` mints a node, `removeNode(idx)` renumbers edges by
 * index — and both are actively wrong for a list of references into a shared
 * pool. Node names, colours and 3D all live on the pool now; ask for them with
 * `planeNodes()` / `planeNodeColors()` / `points3dForPlane()`.
 */
export class PlaneSkeleton {
    /**
     * @param {number} id - Stable id, unique within the model.
     * @param {string} name
     * @param {number[]} [nodeIds] - Ordered node IDs (adopted by copy).
     * @param {[number, number][]} [edges] - Pairs of NODE IDS (adopted by copy).
     */
    constructor(id, name, nodeIds, edges) {
        this.id = id;
        this.name = name;
        this.color = PLANE_COLORS[(id - 1) % PLANE_COLORS.length];
        /**
         * @type {number[]} Ordered node IDs. The order is the plane's own — it
         * is what `planePolygonOrder` falls back to and what the 3D payload is
         * laid out in — and is independent of pool order.
         */
        this.nodeIds = (nodeIds || []).slice();
        /**
         * @type {[number, number][]} Connections, as unordered pairs of NODE
         * IDS. IDs rather than indices so an edge cannot silently re-point at a
         * neighbour when the pool shifts or the plane's own order changes.
         */
        this.edges = (edges || []).map(function (e) { return [e[0], e[1]]; });
        /**
         * @type {boolean} Draw the plane's polygon filled with `color`. A plane
         * IS a polygon, so this is the shape readout — see
         * `planeFillOrderPoolIndices` (2D) / `planeFillOrder3d` (3D) for how
         * its outline is decided.
         */
        this.filled = false;
        /**
         * @type {{views:string[], nNodes:number, meanError:number|null}|null}
         * Provenance for this plane's 3D — which views contributed and how well
         * it reprojects. Per-NODE errors are NOT here: one node has one error
         * however many planes share it, so it lives on the node
         * (`PlaneNode.error`, materialized by `nodeErrorsForPlane`).
         */
        this.triangulation = null;
        /**
         * @type {{centroid:number[], normal:number[], rms:number,
         *         nPoints:number}|null}
         * The last plane of best fit, once `Fit` has run. `rms` is how far the
         * raw triangulated corners were off that plane BEFORE they were
         * flattened onto it. This is what a later step turns into the
         * translation + rotation that re-defines the 3D origin. Per-plane, and
         * genuinely so: two planes sharing an edge have different fits.
         */
        this.planeFit = null;
    }

    /** How many nodes this plane references. @returns {number} */
    get size() { return this.nodeIds.length; }

    /** Does this plane reference node `id`? @param {number} id @returns {boolean} */
    hasNode(id) { return this.nodeIds.indexOf(id) >= 0; }

    /** Position of node `id` in THIS plane's order, or -1. @param {number} id @returns {number} */
    indexOfNode(id) { return this.nodeIds.indexOf(id); }

    /**
     * Reference node `id`, at the end of this plane's order.
     * @param {number} id @returns {boolean} False if already referenced.
     */
    addNode(id) {
        if (this.hasNode(id)) return false;
        this.nodeIds.push(id);
        return true;
    }

    /**
     * Stop referencing node `id`, dropping any edge that used it. The node
     * itself survives — other planes may still reference it, and that is the
     * whole point of the pool.
     * @param {number} id @returns {boolean} False if it was not referenced.
     */
    removeNode(id) {
        var idx = this.nodeIds.indexOf(id);
        if (idx < 0) return false;
        this.nodeIds.splice(idx, 1);
        this.edges = this.edges.filter(function (e) {
            return e[0] !== id && e[1] !== id;
        });
        return true;
    }

    /**
     * Move a node within this plane's own order (array-splice semantics).
     * Edges are ID pairs, so they need no fixup — that is the point.
     * @param {number} from @param {number} to @returns {boolean}
     */
    moveNode(from, to) {
        var n = this.nodeIds.length;
        if (from < 0 || from >= n || to < 0 || to >= n || from === to) return false;
        var id = this.nodeIds.splice(from, 1)[0];
        this.nodeIds.splice(to, 0, id);
        return true;
    }

    /**
     * Connect two nodes. Both must be referenced by this plane.
     * @param {number} srcId @param {number} dstId
     * @returns {boolean} False if invalid, self-connecting, or a duplicate.
     */
    addEdge(srcId, dstId) {
        if (srcId === dstId) return false;
        if (!this.hasNode(srcId) || !this.hasNode(dstId)) return false;
        if (this.hasEdge(srcId, dstId)) return false;
        this.edges.push([srcId, dstId]);
        return true;
    }

    /** Are these two nodes connected (in either direction)? @returns {boolean} */
    hasEdge(srcId, dstId) {
        for (var i = 0; i < this.edges.length; i++) {
            var e = this.edges[i];
            if ((e[0] === srcId && e[1] === dstId) || (e[0] === dstId && e[1] === srcId)) {
                return true;
            }
        }
        return false;
    }

    /** Remove the edge at `edgeIdx`. @param {number} edgeIdx @returns {boolean} */
    removeEdge(edgeIdx) {
        if (edgeIdx < 0 || edgeIdx >= this.edges.length) return false;
        this.edges.splice(edgeIdx, 1);
        return true;
    }

    /** Remove the edge between two nodes, whichever way round. @returns {boolean} */
    removeEdgeBetween(srcId, dstId) {
        for (var i = 0; i < this.edges.length; i++) {
            var e = this.edges[i];
            if ((e[0] === srcId && e[1] === dstId) || (e[0] === dstId && e[1] === srcId)) {
                this.edges.splice(i, 1);
                return true;
            }
        }
        return false;
    }

    /**
     * Drop this plane's SOLVE RESULTS — the fit and the triangulation summary.
     *
     * It CANNOT touch any node's 3D, by construction: the coordinates live on
     * the pool and this object has no reference to it. That asymmetry is
     * deliberate. This is called on every 2D edit, every placement change and
     * every node-list change, so if it could still null 3D positions, a pinned
     * (`immutable`) node's surveyed coordinate would evaporate the first time
     * the user nudged an unrelated corner. Clearing node 3D is node-scoped and
     * explicit: `PlaneModel.invalidateNode3D`.
     */
    clearTriangulation() {
        this.triangulation = null;
        this.planeFit = null;
    }
}

// ============================================
// PlaneInstance — one view's 2D, over the whole pool
// ============================================

/**
 * One camera view's plane annotation: 2D points for EVERY node in the pool,
 * indexed by pool order.
 *
 * Frame-independent by design: a plane is static scene geometry, so there is
 * deliberately no `frameIdx` — the same points are what you see and edit on
 * every frame.
 *
 * Subclasses `Instance` rather than re-implementing it so `ui/interaction.js`
 * drags a plane node through the exact code path it drags a pose node through.
 */
export class PlaneInstance extends Instance {
    /**
     * @param {number} id - Stable id, unique within the model.
     * @param {string} viewName - Camera view this covers.
     * @param {(number[]|null)[]|Float64Array|number} points - Per POOL node, in
     *   video pixels; a bare number means "that many unpositioned nodes".
     * @param {number[]} [nodeIds] - The NODE ID each column belongs to.
     *   `PlaneModel` always supplies it; see the `nodeIds` field.
     */
    constructor(id, viewName, points, nodeIds) {
        // trackIdx null / score 1.0: a plane has no track and no confidence.
        super(points, null, 'plane', 1.0);
        this.id = id;
        this.viewName = viewName;
        /**
         * @type {(number|null)[]} The NODE ID each column belongs to, parallel
         * to the points. THE LEDGER, not a second addressing scheme: every
         * caller (and `ui/interaction.js` in particular) keeps addressing this
         * instance by POOL INDEX through the inherited `hasPoint`/`getX`/
         * `getY`/`setPoint`.
         *
         * It exists because a count is not an identity. An instance can be
         * DETACHED from the model — that is the whole point of per-session
         * placement maps — and while it is detached the pool can have a node
         * spliced out of the middle or moved. Re-syncing such a map by node
         * COUNT re-seats every column past the edit onto the WRONG node,
         * silently, with every point still looking perfectly valid. Matching by
         * ID is the only repair that can tell those cases apart; see
         * `resyncToNodeIds`.
         */
        this.nodeIds = (nodeIds || new Array(this.numNodes).fill(null)).slice();
        /**
         * @type {Set<number>} Nodes the user has toggled OFF (right-click),
         * BY POOL INDEX — they keep their position and still render, greyed,
         * but a triangulation must skip them in this view. Same meaning and
         * same field name as a UserInstance's nulled nodes, so
         * `hasAnyUsablePoint()` (inherited) already reads it correctly.
         */
        this.nulledNodes = new Set();
        /**
         * @type {Set<number>} Nodes whose 2D on this view was REPROJECTED from
         * the 3D rather than annotated by the user, BY POOL INDEX.
         *
         * Written by triangulation, which reprojects a solved plane into the
         * views it is not placed on so the user can see where it lands there.
         * Such a point is EXACTLY the projection of the current 3D, so it is
         * not evidence: feeding it back into the next solve would add no
         * information while dragging the reported reprojection error toward
         * zero — a quality readout that improves every time you press the
         * button. So a derived point renders, and can be dragged, but is
         * excluded from the solve until the user touches it, at which point it
         * becomes their annotation and the flag is cleared.
         *
         * Separate from `nulledNodes` on purpose: "the user turned this off"
         * and "the user never placed this" are different facts, and a
         * deliberately-nulled node must not be silently re-enabled by a drag.
         */
        this.derivedNodes = new Set();
        /**
         * @type {Set<number>} PLANE ids placed on this view. Explicit, not
         * derived: with nodes shared between planes, "this node has a position
         * here" can no longer tell you which planes the user placed here.
         */
        this.placedPlanes = new Set();
    }

    /**
     * Every index-keyed flag set on this instance, so the three index-remapping
     * paths (`resyncToNodeIds` / `removeNodeAt` / `moveNodeAt`) cannot remap one
     * and forget another — a set left un-remapped points at its neighbour's
     * node, which looks perfectly valid. Add any new per-(view, node) set here
     * and the remapping follows for free.
     * @returns {Set<number>[]}
     * @private
     */
    _indexFlagSets() { return [this.nulledNodes, this.derivedNodes]; }

    /** Is node at POOL INDEX `i`'s 2D here reprojected rather than annotated?
     * @param {number} i @returns {boolean} */
    isNodeDerived(i) {
        return this.derivedNodes.has(i);
    }

    /**
     * Flag (or un-flag) pool-index node `i` as reprojected on this view.
     * @param {number} i @param {boolean} on
     */
    setNodeDerived(i, on) {
        if (on) this.derivedNodes.add(i);
        else this.derivedNodes.delete(i);
    }

    /**
     * Clear the derived flag on `indices` (or every node when omitted) — what a
     * user edit does: a point they moved is theirs, whatever put it there.
     * @param {number[]} [indices] @returns {number} How many flags were cleared.
     */
    clearDerivedNodes(indices) {
        var n = 0;
        if (!indices) { n = this.derivedNodes.size; this.derivedNodes.clear(); return n; }
        for (var i = 0; i < indices.length; i++) {
            if (this.derivedNodes.delete(indices[i])) n++;
        }
        return n;
    }

    /** Is node at POOL INDEX `i` toggled off? @param {number} i @returns {boolean} */
    isNodeNulled(i) {
        return this.nulledNodes.has(i);
    }

    /** Toggle pool-index node `i` off/on. @param {number} i @returns {boolean} New state. */
    toggleNodeNull(i) {
        if (this.nulledNodes.has(i)) { this.nulledNodes.delete(i); return false; }
        this.nulledNodes.add(i);
        return true;
    }

    /** Is plane `planeId` placed on this view? @param {number} planeId @returns {boolean} */
    isPlanePlaced(planeId) { return this.placedPlanes.has(planeId); }

    /**
     * Centroid of the positioned nodes, or null if none.
     * @param {number[]} [indices] - Restrict to these POOL indices (e.g. one
     *   plane's nodes); omitted means every node.
     * @returns {number[]|null}
     */
    centroid(indices) {
        var sx = 0, sy = 0, c = 0;
        var n = indices ? indices.length : this.numNodes;
        for (var j = 0; j < n; j++) {
            var i = indices ? indices[j] : j;
            if (!this.hasPoint(i)) continue;
            sx += this.getX(i); sy += this.getY(i); c++;
        }
        return c > 0 ? [sx / c, sy / c] : null;
    }

    /**
     * Append one node's column, unpositioned.
     *
     * New slots are left UNPOSITIONED. That is a change from the per-plane
     * model, where an unpositioned node was unreachable (it draws nothing, so
     * there is nothing to grab) and so had to be seeded immediately: here a
     * node only becomes visible on a view once a plane referencing it is placed
     * there, and THAT is where seeding happens (`PlaneModel.placePlane` /
     * `addNodeToPlane`), with a position that means something for the plane in
     * question rather than one invented for a node no view is showing yet.
     *
     * @param {number} nodeId
     */
    appendNode(nodeId) {
        var pts = this.toPointsArray();
        pts.push(null);
        this.setPointsFrom(pts);
        this.nodeIds.push(nodeId);
    }

    /**
     * Re-seat this instance's columns onto `nextIds`, MATCHING BY NODE ID.
     *
     * The repair path for an instance that was detached from the model while
     * the pool changed (a per-session placement map, switched away and back).
     * A surviving node keeps its point and its per-node flags (nulled,
     * derived) wherever its column has moved to; a node the pool no longer holds is dropped; a node this
     * instance has never seen arrives unpositioned. Deletions and reorders in
     * the MIDDLE of the pool are exactly the cases a count-based resize gets
     * silently and catastrophically wrong — every later column lands on its
     * neighbour's node, and nothing about the result looks invalid.
     *
     * Columns whose ledger entry is null (an instance built without one) cannot
     * be identified and are therefore dropped rather than guessed at.
     *
     * @param {number[]} nextIds - The pool's node IDs, in pool order.
     * @returns {boolean} True when anything actually moved.
     */
    resyncToNodeIds(nextIds) {
        var ids = nextIds || [];
        var byId = new Map();
        for (var i = 0; i < this.nodeIds.length; i++) {
            if (this.nodeIds[i] != null) byId.set(this.nodeIds[i], i);
        }
        var changed = ids.length !== this.numNodes;
        var flagSets = this._indexFlagSets();
        var next = flagSets.map(function () { return new Set(); });
        var pts = new Array(ids.length);
        for (var j = 0; j < ids.length; j++) {
            var from = byId.has(ids[j]) ? byId.get(ids[j]) : -1;
            if (from !== j) changed = true;
            pts[j] = from >= 0 ? this.getPoint(from) : null;
            if (from < 0) continue;
            for (var f = 0; f < flagSets.length; f++) {
                if (flagSets[f].has(from)) next[f].add(j);
            }
        }
        this.nodeIds = ids.slice();
        this.setPointsFrom(pts);
        for (var g = 0; g < flagSets.length; g++) {
            flagSets[g].clear();
            next[g].forEach(function (k) { flagSets[g].add(k); });
        }
        return changed;
    }

    /**
     * Position node `idx` on a golden-angle spoke around (cx, cy).
     *
     * Used when a node joins a plane that is ALREADY placed on this view: an
     * unpositioned node draws nothing, so the user would have no way to grab it
     * and put it somewhere real. `ordinal` (the node's position within the
     * plane) is what keeps repeated additions from stacking.
     *
     * @param {number} idx - POOL index.
     * @param {number} cx @param {number} cy - Video px to spread around.
     * @param {number} ordinal
     * @param {number} [videoW] - Clamp bound; omitted means no clamp.
     * @param {number} [videoH]
     */
    seedNodeNear(idx, cx, cy, ordinal, videoW, videoH) {
        if (idx < 0 || idx >= this.numNodes) return;
        var angle = ordinal * GOLDEN_ANGLE;
        var x = cx + SPREAD_RADIUS * Math.cos(angle);
        var y = cy + SPREAD_RADIUS * Math.sin(angle);
        if (videoW) x = Math.min(Math.max(x, 0), videoW);
        if (videoH) y = Math.min(Math.max(y, 0), videoH);
        this.setPoint(idx, x, y);
    }

    /**
     * Drop the point at POOL INDEX `nodeIdx`, mirroring the pool's splice so the
     * remaining points stay aligned with the renumbered nodes. Per-node flags
     * (nulled, derived) at higher indices shift down with them.
     * @param {number} nodeIdx
     */
    removeNodeAt(nodeIdx) {
        if (nodeIdx < 0 || nodeIdx >= this.numNodes) return;
        var pts = this.toPointsArray();
        pts.splice(nodeIdx, 1);
        this.nodeIds.splice(nodeIdx, 1);
        var flagSets = this._indexFlagSets();
        var was = flagSets.map(function (set) {
            var arr = []; set.forEach(function (k) { arr.push(k); }); return arr;
        });
        this.setPointsFrom(pts);
        for (var f = 0; f < flagSets.length; f++) {
            flagSets[f].clear();
            for (var i = 0; i < was[f].length; i++) {
                var k = was[f][i];
                if (k === nodeIdx) continue;
                flagSets[f].add(k > nodeIdx ? k - 1 : k);
            }
        }
    }

    /**
     * Move the point at POOL INDEX `from` to `to`, mirroring `PlaneNodePool
     * .moveNode`. Per-node flags (nulled, derived) travel with their node.
     * @param {number} from @param {number} to
     */
    moveNodeAt(from, to) {
        var n = this.numNodes;
        if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
        var pts = this.toPointsArray();
        pts.splice(to, 0, pts.splice(from, 1)[0]);
        this.nodeIds.splice(to, 0, this.nodeIds.splice(from, 1)[0]);
        var flagSets = this._indexFlagSets();
        var next = flagSets.map(function (set) {
            var out = new Set();
            set.forEach(function (k) { out.add(remapMovedIndex(k, from, to)); });
            return out;
        });
        this.setPointsFrom(pts);
        for (var f = 0; f < flagSets.length; f++) {
            flagSets[f].clear();
            next[f].forEach(function (k) { flagSets[f].add(k); });
        }
    }
}

/**
 * Where index `k` ends up after the element at `from` is spliced in at `to`.
 * @private
 */
function remapMovedIndex(k, from, to) {
    if (k === from) return to;
    if (from < to) return (k > from && k <= to) ? k - 1 : k;
    return (k >= to && k < from) ? k + 1 : k;
}

// ============================================
// PlaneModel — pool + planes + per-view 2D
// ============================================

/**
 * The whole plane annotation state, and the invariants between its three parts.
 *
 * Everything that spans them goes through here rather than through the pieces:
 * adding a node has to grow every view's 2D, deleting one has to splice every
 * view's 2D AND every plane's membership AND every plane's edges, and placing a
 * plane has to seed exactly the nodes that have no position yet. Each of those
 * is one call here; done piecemeal, any one of them left out is a silent
 * corruption of the index space.
 */
export class PlaneModel {
    constructor() {
        /** @type {PlaneNodePool} Every plane node in the project. */
        this.pool = new PlaneNodePool();
        /** @type {PlaneSkeleton[]} Every plane, in creation order. */
        this.planes = [];
        /** @type {Map<string, PlaneInstance>} viewName -> that view's 2D. */
        this.placements = new Map();
        this._nextPlaneId = 1;
        this._nextInstanceId = 1;
    }

    // --- planes ------------------------------------------------------------

    /**
     * Create an empty plane and return it.
     * @param {string} [name] @returns {PlaneSkeleton}
     */
    createPlane(name) {
        var id = this._nextPlaneId++;
        var plane = new PlaneSkeleton(id, name || ('plane_' + id));
        this.planes.push(plane);
        return plane;
    }

    /** The plane with this id, or null. @param {number} id @returns {PlaneSkeleton|null} */
    getPlane(id) {
        for (var i = 0; i < this.planes.length; i++) {
            if (this.planes[i].id === id) return this.planes[i];
        }
        return null;
    }

    /** Accept a plane or a plane id. @private @returns {PlaneSkeleton|null} */
    _plane(planeOrId) {
        if (planeOrId == null) return null;
        return typeof planeOrId === 'number' ? this.getPlane(planeOrId) : planeOrId;
    }

    /**
     * Delete a plane — the plane object and its edges, and nothing else.
     *
     * EVERY NODE SURVIVES, including nodes no remaining plane references. That
     * is the point of making nodes plane-independent: a node is a pool member
     * in its own right, the Nodes table still lists it, and the user's only
     * instrument for removing one is an explicit `deleteNode`. Auto-deleting
     * the "orphans" would silently destroy exactly the nodes worth keeping —
     * a pinned surveyed reference, a corner staged for a plane not built yet —
     * as a side effect of an unrelated action, and deletion is the one path
     * that cannot be undone by re-fitting.
     *
     * @param {number|PlaneSkeleton} planeOrId
     * @returns {{removed:boolean, keptNodeIds:number[]}} `keptNodeIds` = the
     *   nodes the deleted plane referenced, all of which are still in the pool.
     */
    deletePlane(planeOrId) {
        var plane = this._plane(planeOrId);
        var out = { removed: false, keptNodeIds: [] };
        if (!plane) return out;
        var idx = this.planes.indexOf(plane);
        if (idx < 0) return out;

        this.planes.splice(idx, 1);
        out.removed = true;
        out.keptNodeIds = plane.nodeIds.slice();

        // Every view forgets it was placed here.
        this.placements.forEach(function (inst) { inst.placedPlanes.delete(plane.id); });
        return out;
    }

    /** Every plane that references node `id`. @param {number} id @returns {PlaneSkeleton[]} */
    planesForNode(id) {
        var out = [];
        for (var i = 0; i < this.planes.length; i++) {
            if (this.planes[i].hasNode(id)) out.push(this.planes[i]);
        }
        return out;
    }

    // --- placements (per-view 2D) -------------------------------------------

    /**
     * This view's `PlaneInstance`, creating it (sized to the pool) if needed.
     * @param {string} viewName @returns {PlaneInstance}
     */
    ensureInstance(viewName) {
        var inst = this.placements.get(viewName);
        if (inst) {
            // Self-heal BY ID, never by count — see `resyncToNodeIds`.
            if (inst.numNodes !== this.pool.size) inst.resyncToNodeIds(this.pool.ids());
            return inst;
        }
        inst = new PlaneInstance(
            this._nextInstanceId++, viewName, this.pool.size, this.pool.ids());
        this.placements.set(viewName, inst);
        return inst;
    }

    /** This view's `PlaneInstance`, or null — never creates one. @returns {PlaneInstance|null} */
    getInstance(viewName) {
        return this.placements.get(viewName) || null;
    }

    /** Every view that has a `PlaneInstance`. @returns {string[]} */
    views() {
        var out = [];
        this.placements.forEach(function (_inst, name) { out.push(name); });
        return out;
    }

    /** Every `PlaneInstance`, in view-insertion order. @returns {PlaneInstance[]} */
    allInstances() {
        var out = [];
        this.placements.forEach(function (inst) { out.push(inst); });
        return out;
    }

    /**
     * Adopt an externally owned placements map (e.g. one stored per session on
     * the `Session` object) as this model's 2D.
     *
     * Re-seats every instance's columns onto the pool BY NODE ID, and drops
     * placement flags for planes that no longer exist. A map that was detached
     * while the pool changed is exactly the stale index space this model exists
     * to prevent — and a node deleted or moved in the MIDDLE of the pool while
     * the map was away cannot be repaired by matching counts: every column past
     * the edit would come back seated on its neighbour's node, still looking
     * like a perfectly good point. See `PlaneInstance.resyncToNodeIds`.
     *
     * @param {Map<string, PlaneInstance>} map
     */
    attachPlacements(map) {
        this.placements = map || new Map();
        var self = this;
        this.placements.forEach(function (inst) {
            inst.resyncToNodeIds(self.pool.ids());
            var stale = [];
            inst.placedPlanes.forEach(function (pid) {
                if (!self.getPlane(pid)) stale.push(pid);
            });
            for (var i = 0; i < stale.length; i++) inst.placedPlanes.delete(stale[i]);
            if (inst.id >= self._nextInstanceId) self._nextInstanceId = inst.id + 1;
        });
    }

    // --- nodes --------------------------------------------------------------

    /**
     * Append a node to the pool and grow every view's 2D to match.
     *
     * The new node has no position anywhere and belongs to no plane — it
     * becomes visible (and gets seeded) when a plane referencing it is placed.
     * Use `createNodeInPlane` for the common "add a corner to this plane" case.
     *
     * @param {string} name
     * @param {{color?:string, immutable?:boolean}} [opts]
     * @returns {PlaneNode}
     */
    addNode(name, opts) {
        var node = this.pool.addNode(name, opts);
        this.placements.forEach(function (inst) { inst.appendNode(node.id); });
        return node;
    }

    /**
     * Delete a node everywhere: the pool, every plane's membership, every
     * plane's edges, and every view's 2D + nulled flags.
     *
     * This is the one operation that destroys 2D. Un-placing a plane does not
     * (see the module note) — a node's points exist because the user positioned
     * them, and only removing the node itself throws that work away.
     *
     * @param {number} id @returns {boolean} False when unknown.
     */
    deleteNode(id) {
        var removed = this.pool.removeNode(id);
        if (!removed) return false;
        for (var i = 0; i < this.planes.length; i++) {
            var plane = this.planes[i];
            // `removeNode` drops the plane's edges through this node too; a
            // plane that referenced it can no longer trust its solve.
            if (plane.removeNode(id)) plane.clearTriangulation();
        }
        this.placements.forEach(function (inst) { inst.removeNodeAt(removed.index); });
        return true;
    }

    /**
     * Reorder the POOL (array-splice semantics), keeping every view's 2D and
     * nulled flags with their nodes. Plane membership and edges are IDs, so
     * they are unaffected — which is the point of storing them that way.
     * @param {number} from @param {number} to @returns {boolean}
     */
    moveNode(from, to) {
        if (!this.pool.moveNode(from, to)) return false;
        this.placements.forEach(function (inst) { inst.moveNodeAt(from, to); });
        return true;
    }

    /**
     * Reference an existing node from a plane, seeding its 2D on every view the
     * plane is already placed on (an unpositioned node draws nothing, so it
     * would be unreachable there). A node that already has a position on a view
     * keeps it — that is what makes a shared corner shared.
     *
     * @param {number|PlaneSkeleton} planeOrId
     * @param {number} nodeId
     * @param {{viewBounds?:function(string):number[]}} [opts] - `viewBounds`
     *   maps a view name to `[videoW, videoH]` for clamping.
     * @returns {boolean}
     */
    addNodeToPlane(planeOrId, nodeId, opts) {
        var plane = this._plane(planeOrId);
        if (!plane || !this.pool.has(nodeId)) return false;
        if (!plane.addNode(nodeId)) return false;

        var poolIdx = this.pool.indexOf(nodeId);
        var ordinal = plane.indexOfNode(nodeId);
        var self = this;
        var bounds = (opts && opts.viewBounds) || null;
        this.placements.forEach(function (inst, viewName) {
            if (!inst.isPlanePlaced(plane.id)) return;
            if (inst.hasPoint(poolIdx)) return;
            var c = inst.centroid(self.planeNodeIndices(plane)) || [0, 0];
            var wh = bounds ? (bounds(viewName) || [0, 0]) : [0, 0];
            inst.seedNodeNear(poolIdx, c[0], c[1], ordinal, wh[0], wh[1]);
        });
        // The plane's shape changed, so any solve of it is stale. Node 3D is
        // untouched: the node's position is still the node's position.
        plane.clearTriangulation();
        return true;
    }

    /**
     * Mint a node and reference it from `planeOrId` in one step — the "+ Add
     * node" action.
     * @param {string} name
     * @param {number|PlaneSkeleton} planeOrId
     * @param {{color?:string, immutable?:boolean,
     *          viewBounds?:function(string):number[]}} [opts]
     * @returns {PlaneNode|null}
     */
    createNodeInPlane(name, planeOrId, opts) {
        var plane = this._plane(planeOrId);
        if (!plane) return null;
        var node = this.addNode(name, opts);
        this.addNodeToPlane(plane, node.id, opts);
        return node;
    }

    /**
     * Stop referencing a node from ONE plane. The node itself SURVIVES by
     * default, in the pool, even if no plane is left referencing it — same rule
     * as `deletePlane`, and for the same reason: destroying a node (with its
     * 3D, its 2D on every view, and its pinned flag) is a separate, explicit,
     * irreversible act. A caller that has actually confirmed that intent with
     * the user can opt in with `deleteIfOrphan: true`.
     *
     * @param {number|PlaneSkeleton} planeOrId
     * @param {number} nodeId
     * @param {{deleteIfOrphan?:boolean}} [opts] - Defaults to FALSE.
     * @returns {{removed:boolean, deletedNode:boolean}}
     */
    removeNodeFromPlane(planeOrId, nodeId, opts) {
        var plane = this._plane(planeOrId);
        var out = { removed: false, deletedNode: false };
        if (!plane || !plane.removeNode(nodeId)) return out;
        out.removed = true;
        plane.clearTriangulation();
        if (opts && opts.deleteIfOrphan && this.planesForNode(nodeId).length === 0) {
            out.deletedNode = this.deleteNode(nodeId);
        }
        return out;
    }

    // --- placing a plane on a view ------------------------------------------

    /**
     * Place `planeOrId` on `viewName`, centred at (cx, cy) in video pixels.
     *
     * Only nodes with NO position on this view are seeded, on the same ring
     * `seedPlanePoints` has always produced (node-in-plane order, starting at
     * 12 o'clock) so a fresh 4-node plane still lands as a recognisable quad.
     * Nodes that already have a position — because another plane sharing them
     * was positioned here first, or because this plane was un-placed and is
     * being re-placed — keep it. Re-placing therefore restores exactly what the
     * user had, and a shared edge lands on the corners it already occupies.
     *
     * @param {number|PlaneSkeleton} planeOrId
     * @param {string} viewName
     * @param {number} cx @param {number} cy
     * @param {number} [videoW] @param {number} [videoH]
     * @returns {{placed:boolean, seeded:number[]}} `seeded` = pool indices given
     *   a fresh position.
     */
    placePlane(planeOrId, viewName, cx, cy, videoW, videoH) {
        var plane = this._plane(planeOrId);
        var out = { placed: false, seeded: [] };
        if (!plane) return out;
        var inst = this.ensureInstance(viewName);
        inst.placedPlanes.add(plane.id);
        out.placed = true;

        var ring = seedPlanePoints(plane.size, cx, cy, videoW || 0, videoH || 0);
        for (var i = 0; i < plane.nodeIds.length; i++) {
            var poolIdx = this.pool.indexOf(plane.nodeIds[i]);
            if (poolIdx < 0 || inst.hasPoint(poolIdx)) continue;
            inst.setPoint(poolIdx, ring[i][0], ring[i][1]);
            out.seeded.push(poolIdx);
        }
        return out;
    }

    /**
     * Un-place a plane from a view. 2D points are DELIBERATELY kept: visibility
     * is derived from the placed set, so nothing renders or solves from them,
     * and re-placing restores the user's positions instead of a fresh ring.
     * Nothing is reference-counted, so nothing can be double-freed.
     * @param {number|PlaneSkeleton} planeOrId @param {string} viewName
     * @returns {boolean} False if it was not placed there.
     */
    unplacePlane(planeOrId, viewName) {
        var plane = this._plane(planeOrId);
        var inst = plane ? this.getInstance(viewName) : null;
        if (!inst || !inst.placedPlanes.delete(plane.id)) return false;
        // The 3D was solved from a view set that no longer holds.
        plane.clearTriangulation();
        return true;
    }

    /** Is this plane placed on this view? @returns {boolean} */
    isPlanePlaced(planeOrId, viewName) {
        var plane = this._plane(planeOrId);
        var inst = plane ? this.getInstance(viewName) : null;
        return !!inst && inst.isPlanePlaced(plane.id);
    }

    /** Views a plane is placed on. @returns {string[]} */
    placedViews(planeOrId) {
        var plane = this._plane(planeOrId);
        if (!plane) return [];
        var out = [];
        this.placements.forEach(function (inst, viewName) {
            if (inst.isPlanePlaced(plane.id)) out.push(viewName);
        });
        return out;
    }

    /** Planes placed on a view, in creation order. @returns {PlaneSkeleton[]} */
    placedPlanes(viewName) {
        var inst = this.getInstance(viewName);
        if (!inst) return [];
        return this.planes.filter(function (p) { return inst.isPlanePlaced(p.id); });
    }

    // --- derived visibility --------------------------------------------------

    /**
     * Is node `id` shown on `viewName`? Derived, never stored: a node is
     * visible exactly when some plane placed here references it. That is why
     * un-placing can safely leave 2D behind — nothing consults the points to
     * decide what to draw.
     * @param {string} viewName @param {number} id @returns {boolean}
     */
    isNodeVisibleOn(viewName, id) {
        var placed = this.placedPlanes(viewName);
        for (var i = 0; i < placed.length; i++) if (placed[i].hasNode(id)) return true;
        return false;
    }

    /** POOL INDICES visible on `viewName`, ascending. @returns {number[]} */
    visibleNodeIndices(viewName) {
        var placed = this.placedPlanes(viewName);
        var seen = new Set();
        for (var i = 0; i < placed.length; i++) {
            for (var j = 0; j < placed[i].nodeIds.length; j++) {
                var idx = this.pool.indexOf(placed[i].nodeIds[j]);
                if (idx >= 0) seen.add(idx);
            }
        }
        var out = [];
        seen.forEach(function (k) { out.push(k); });
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    /** POOL INDICES of a plane's nodes, in the PLANE's order. @returns {number[]} */
    planeNodeIndices(planeOrId) {
        return planeNodeIndices(this._plane(planeOrId), this.pool);
    }

    // --- 3D invalidation -----------------------------------------------------

    /**
     * Drop one node's 3D, and the solve results of every plane that stands on
     * it. Called when the evidence behind that point changes — its 2D was
     * dragged, or its observation in a view was toggled off.
     *
     * A pinned (`immutable`) node is SKIPPED: its coordinate is an input to the
     * solve, not an output of it, so an edit elsewhere must not silently erase
     * it. The planes' `planeFit` is still cleared either way — the fit was
     * derived from 2D that has changed.
     *
     * `setPoint3d`'s `force` is deliberately NOT reachable from here.
     * Invalidation is a CASCADE — it fires off edits the user made somewhere
     * else entirely — so a `force` threaded through it would strip pinned nodes
     * as a side effect of an unrelated action. The one caller that really means
     * "wipe the pinned ones too" says so by name.
     *
     * @param {number} id
     * @param {{forceClearImmutable?:boolean}} [opts]
     * @returns {boolean} True when the node's 3D was actually cleared.
     */
    invalidateNode3D(id, opts) {
        var node = this.pool.getNode(id);
        if (!node) return false;
        var planes = this.planesForNode(id);
        for (var i = 0; i < planes.length; i++) planes[i].clearTriangulation();
        return node.clearPoint3d(clearOpts(opts));
    }

    /**
     * Drop a plane's solve: its fit and summary always, and the 3D of the nodes
     * that belong to THIS PLANE ALONE.
     *
     * A node another plane also references keeps its 3D — clearing it would
     * split the shared intersection line the two planes were annotated to
     * meet along, which is the exact failure this data model exists to prevent.
     * Pinned nodes keep theirs too (see `invalidateNode3D`).
     *
     * @param {number|PlaneSkeleton} planeOrId
     * @param {{clearNodes?:boolean, forceClearImmutable?:boolean}} [opts] -
     *   `clearNodes` defaults to true. `forceClearImmutable` is the ONLY way to
     *   clear a pinned node here, and it is named rather than being `force`
     *   precisely so it cannot be inherited from an options object a caller
     *   passed for some other reason (see `invalidateNode3D`).
     * @returns {{clearedNodeIds:number[], keptSharedIds:number[],
     *            keptFrozenIds:number[]}}
     */
    invalidatePlane3D(planeOrId, opts) {
        var plane = this._plane(planeOrId);
        var out = { clearedNodeIds: [], keptSharedIds: [], keptFrozenIds: [] };
        if (!plane) return out;
        plane.clearTriangulation();
        if (opts && opts.clearNodes === false) return out;

        for (var i = 0; i < plane.nodeIds.length; i++) {
            var id = plane.nodeIds[i];
            if (this.planesForNode(id).length > 1) { out.keptSharedIds.push(id); continue; }
            var node = this.pool.getNode(id);
            if (!node) continue;
            if (node.clearPoint3d(clearOpts(opts))) out.clearedNodeIds.push(id);
            else out.keptFrozenIds.push(id);
        }
        return out;
    }
}

/**
 * Translate an invalidation's options into `PlaneNode.clearPoint3d`'s.
 *
 * The whole job is that `force` does NOT survive the trip: only the explicitly
 * named `forceClearImmutable` reaches the leaf. Passing a caller's options
 * object straight through is how a `force` meant for one narrow purpose ends up
 * silently unpinning nodes three calls away.
 * @private
 */
function clearOpts(opts) {
    return (opts && opts.forceClearImmutable) ? { force: true } : undefined;
}

// ============================================
// Per-plane materializers
// ============================================

/**
 * POOL INDICES of a plane's nodes, in the PLANE's order. -1 for an id the pool
 * no longer holds (which `PlaneModel` prevents, but callers may hold a stale
 * plane object).
 * @param {PlaneSkeleton} plane @param {PlaneNodePool} pool @returns {number[]}
 */
export function planeNodeIndices(plane, pool) {
    if (!plane || !pool) return [];
    return plane.nodeIds.map(function (id) { return pool.indexOf(id); });
}

/** A plane's node objects, in plane order (null for a missing id). @returns {(PlaneNode|null)[]} */
export function planeNodes(plane, pool) {
    if (!plane || !pool) return [];
    return plane.nodeIds.map(function (id) { return pool.getNode(id); });
}

/** A plane's node names, in plane order. @returns {string[]} */
export function planeNodeNames(plane, pool) {
    return planeNodes(plane, pool).map(function (n) { return n ? n.name : ''; });
}

/** A plane's node colours, in plane order. @returns {string[]} */
export function planeNodeColors(plane, pool) {
    return planeNodes(plane, pool).map(function (n, i) {
        return n ? n.color : defaultNodeColor(i);
    });
}

/**
 * Pinned-ness in ONE plane's node order, parallel to `planeNodeColors`.
 *
 * Pinning is a property of the NODE, so a corner shared between two planes
 * reads pinned in BOTH — which is the point: the shared corner is exactly what
 * the user freezes to hold an intersection line still while either plane is
 * re-fitted.
 *
 * A missing node reads `false` rather than throwing; the caller is a renderer.
 *
 * @param {PlaneSkeleton} plane @param {PlaneNodePool} pool
 * @returns {boolean[]}
 */
export function planeNodeImmutability(plane, pool) {
    return planeNodes(plane, pool).map(function (n) {
        return !!(n && n.immutable);
    });
}

/**
 * The pool's 3D laid out in ONE plane's node order — the flat
 * `Float64Array(3n)` every existing consumer (the 3D viewport payload, the
 * plane fit, the origin frame) already reads, with an all-NaN triple for a node
 * that has none.
 *
 * Freshly allocated and NOT a view, so writing to it does not write back; the
 * pool is the single source of truth and `writePoints3dForPlane` is the way in.
 *
 * @param {PlaneSkeleton} plane @param {PlaneNodePool} pool
 * @returns {Float64Array}
 */
export function points3dForPlane(plane, pool) {
    var n = plane ? plane.nodeIds.length : 0;
    var out = new Float64Array(n * 3);
    for (var i = 0; i < n; i++) {
        var node = pool ? pool.getNode(plane.nodeIds[i]) : null;
        var o = i * 3;
        if (node) {
            out[o] = node.xyz[0]; out[o + 1] = node.xyz[1]; out[o + 2] = node.xyz[2];
        } else {
            out[o] = NaN; out[o + 1] = NaN; out[o + 2] = NaN;
        }
    }
    return out;
}

/**
 * Write a plane-ordered flat `Float64Array(3n)` back into the pool — the
 * inverse of `points3dForPlane`, and the ONLY way a solve should publish its
 * result.
 *
 * Pinned (`immutable`) nodes are skipped and reported rather than silently
 * overwritten: they are what a constrained fit is holding fixed, so a writer
 * that clobbered them would quietly undo the constraint it was solving under.
 *
 * @param {PlaneSkeleton} plane @param {PlaneNodePool} pool
 * @param {Float64Array|number[]} flat - Plane-ordered `[x,y,z]` per node.
 * @param {{force?:boolean}} [opts]
 * @returns {{written:number, skippedIds:number[]}} `skippedIds` = pinned nodes.
 */
export function writePoints3dForPlane(plane, pool, flat, opts) {
    var out = { written: 0, skippedIds: [] };
    if (!plane || !pool || !flat) return out;
    var n = Math.min(plane.nodeIds.length, (flat.length / 3) | 0);
    for (var i = 0; i < n; i++) {
        var id = plane.nodeIds[i];
        var node = pool.getNode(id);
        if (!node) continue;
        var o = i * 3;
        if (node.setPoint3d([flat[o], flat[o + 1], flat[o + 2]], opts)) out.written++;
        else out.skippedIds.push(id);
    }
    return out;
}

/**
 * A plane's per-node reprojection errors, in plane order — the shape the panel
 * used to read off `skeleton.triangulation.nodeErrors`. Derived from
 * `PlaneNode.error` so a shared node reports one error, not two.
 * @param {PlaneSkeleton} plane @param {PlaneNodePool} pool
 * @returns {(number|null)[]}
 */
export function nodeErrorsForPlane(plane, pool) {
    return planeNodes(plane, pool).map(function (n) {
        return n && n.error != null ? n.error : null;
    });
}

/**
 * A plane's edges as pairs of LOCAL indices (into the plane's own node order) —
 * what the 3D viewport payload wants, since it is handed `points3dForPlane`.
 * Edges naming a node the plane no longer references are dropped.
 * @param {PlaneSkeleton} plane @returns {[number, number][]}
 */
export function planeEdgesLocal(plane) {
    if (!plane) return [];
    var out = [];
    for (var i = 0; i < plane.edges.length; i++) {
        var a = plane.indexOfNode(plane.edges[i][0]);
        var b = plane.indexOfNode(plane.edges[i][1]);
        if (a >= 0 && b >= 0) out.push([a, b]);
    }
    return out;
}

/**
 * A plane's edges as pairs of POOL indices — what the 2D overlay and
 * `ui/interaction.js`'s edge hit-testing want, since both index a
 * `PlaneInstance`.
 * @param {PlaneSkeleton} plane @param {PlaneNodePool} pool
 * @returns {[number, number][]}
 */
export function planeEdgesPoolIndices(plane, pool) {
    if (!plane || !pool) return [];
    var out = [];
    for (var i = 0; i < plane.edges.length; i++) {
        var a = pool.indexOf(plane.edges[i][0]);
        var b = pool.indexOf(plane.edges[i][1]);
        if (a >= 0 && b >= 0) out.push([a, b]);
    }
    return out;
}

/**
 * The RING the user drew, as NODE IDS, or `null` when their connections do not
 * form one.
 *
 * A ring is a single simple cycle covering every node the plane references:
 * each node at degree exactly 2, one closed walk. Anything else — an open
 * chain, a partial cycle, a branch, two disjoint cycles, no edges at all —
 * returns null, because those state an outline only partially and guessing the
 * rest of it is how a fill ends up self-intersecting.
 *
 * This is the TOPOLOGICAL half of a plane's outline and it ignores coordinates
 * entirely, so it is the only form that can express a CONCAVE outline (an
 * L-shaped floor): the user's edges say so explicitly. Callers that need an
 * outline for a plane with no ring fall back to geometry — see
 * `planeFillOrderPoolIndices` / `planeFillOrder3d`.
 *
 * @param {PlaneSkeleton} plane
 * @returns {number[]|null} Node IDs in ring order, or null.
 */
export function planeCycleOrderIds(plane) {
    if (!plane) return null;
    var ids = plane.nodeIds;
    var n = ids.length;
    if (n < 3) return null;

    // Work in local indices; the adjacency algorithm is identical, and the
    // result is mapped back to IDs at the end.
    var adj = [];
    for (var a = 0; a < n; a++) adj.push(new Set());
    for (var e = 0; e < plane.edges.length; e++) {
        var s = plane.indexOfNode(plane.edges[e][0]);
        var d = plane.indexOfNode(plane.edges[e][1]);
        if (s < 0 || d < 0 || s === d) continue;
        adj[s].add(d);
        adj[d].add(s);
    }
    // A simple cycle has every node at degree exactly 2.
    for (var c = 0; c < n; c++) if (adj[c].size !== 2) return null;

    var walk = [0];
    var seen = new Set([0]);
    var prev = -1, cur = 0;
    for (var step = 1; step < n; step++) {
        var next = -1;
        adj[cur].forEach(function (x) { if (x !== prev && next === -1) next = x; });
        // A second disjoint cycle would revisit before covering every node.
        if (next === -1 || seen.has(next)) return null;
        walk.push(next);
        seen.add(next);
        prev = cur;
        cur = next;
    }
    // …and the walk has to close back to where it started.
    if (!adj[cur].has(0)) return null;
    return walk.map(function (i) { return ids[i]; });
}

/**
 * The order to walk a plane's nodes as a POLYGON, as NODE IDS: the user's ring
 * when there is one, otherwise MEMBERSHIP order.
 *
 * Purely topological, and kept as the coordinate-free form of the question —
 * the FILL does not use this, because membership order draws a
 * self-intersecting shape for any plane whose nodes were not added in ring
 * order. `planeFillOrderPoolIndices` / `planeFillOrder3d` are what the
 * renderers call.
 *
 * @param {PlaneSkeleton} plane
 * @returns {number[]} Node IDs in polygon order.
 */
export function planePolygonOrderIds(plane) {
    if (!plane) return [];
    return planeCycleOrderIds(plane) || plane.nodeIds.slice();
}

/**
 * `planePolygonOrderIds` as LOCAL indices into the plane's node order — the
 * shape the 3D viewport payload's `polygonOrder` has always been.
 * @param {PlaneSkeleton} plane @returns {number[]}
 */
export function planePolygonOrder(plane) {
    if (!plane) return [];
    return planePolygonOrderIds(plane).map(function (id) { return plane.indexOfNode(id); });
}

/**
 * `planePolygonOrderIds` as POOL indices. The coordinate-free form; the 2D
 * overlay's fill uses `planeFillOrderPoolIndices` instead, which falls back to
 * the convex hull rather than to membership order.
 * @param {PlaneSkeleton} plane @param {PlaneNodePool} pool @returns {number[]}
 */
export function planePolygonOrderPoolIndices(plane, pool) {
    if (!plane || !pool) return [];
    return planePolygonOrderIds(plane).map(function (id) { return pool.indexOf(id); });
}

/**
 * Indices of the CONVEX HULL of a 2D point set, as indices into `pts`, in ring
 * order.
 *
 * Andrew's monotone chain. Points strictly INSIDE the hull are dropped, which
 * is the whole point of using it: a node the user placed in the middle of a
 * plane is enclosed by the fill instead of being dragged out to the boundary as
 * a reflex vertex. Points lying exactly ON a hull edge are dropped too — they
 * are boundary vertices that do not change the shape.
 *
 * Fewer than 3 hull vertices means every point is coincident or collinear:
 * there is no outline, so the input order is returned unchanged rather than a
 * degenerate 2-gon (both fill to nothing, but the caller's own `< 3` guards
 * then read the same as they always did).
 *
 * @param {number[][]} pts - `[x, y]` per point; every coordinate must be finite.
 * @returns {number[]} Indices into `pts`.
 */
export function convexHullOrder2d(pts) {
    var n = pts ? pts.length : 0;
    var all = [];
    for (var i = 0; i < n; i++) all.push(i);
    if (n < 3) return all;

    var byX = all.slice().sort(function (a, b) {
        return (pts[a][0] - pts[b][0]) || (pts[a][1] - pts[b][1]);
    });
    var cross = function (o, a, b) {
        return (pts[a][0] - pts[o][0]) * (pts[b][1] - pts[o][1])
            - (pts[a][1] - pts[o][1]) * (pts[b][0] - pts[o][0]);
    };
    var chain = function (seq) {
        var out = [];
        for (var k = 0; k < seq.length; k++) {
            while (out.length >= 2
                && cross(out[out.length - 2], out[out.length - 1], seq[k]) <= 0) out.pop();
            out.push(seq[k]);
        }
        return out;
    };
    var lower = chain(byX);
    var upper = chain(byX.slice().reverse());
    // Each chain ends where the other begins, so drop both closing vertices.
    var hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    return hull.length >= 3 ? hull : all;
}

/** @returns {number} */
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
/** @returns {number[]} */
function cross3(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
/** @returns {number[]|null} Null for a zero-length (or non-finite) vector. */
function unit3(a) {
    var L = Math.sqrt(dot3(a, a));
    if (!(L > 0) || !isFinite(L)) return null;
    return [a[0] / L, a[1] / L, a[2] / L];
}

/**
 * Convex-hull ring for 3D points that lie (near enough) on a common plane, as
 * indices into the point list.
 *
 * A hull is a 2D question, so the points are projected onto an in-plane basis
 * first. `normal` — a `planeFit`'s, when the plane has been fit — fixes that
 * projection plane; without one, a normal is estimated from the two longest
 * independent directions in the set, which is exact for coplanar points and
 * adequate for near-coplanar ones. Either way this only ever decides vertex
 * ORDER: no coordinate is read back out of the projection.
 *
 * @param {number[][]} qs - `[x, y, z]` per point; every coordinate finite.
 * @param {number[]|null} [normal]
 * @returns {number[]} Indices into `qs`.
 */
export function convexHullOrder3d(qs, normal) {
    var n = qs ? qs.length : 0;
    var all = [];
    for (var i = 0; i < n; i++) all.push(i);
    if (n < 3) return all;

    var c = [0, 0, 0];
    for (var a = 0; a < n; a++) { c[0] += qs[a][0]; c[1] += qs[a][1]; c[2] += qs[a][2]; }
    c[0] /= n; c[1] /= n; c[2] /= n;
    var rel = qs.map(function (q) { return [q[0] - c[0], q[1] - c[1], q[2] - c[2]]; });

    // First in-plane axis: the longest spoke from the centroid. Longest rather
    // than "the first one" so a near-coincident pair cannot define the basis.
    var u = null, best = 0;
    for (var b = 0; b < n; b++) {
        var L = dot3(rel[b], rel[b]);
        if (L > best) { best = L; u = rel[b]; }
    }
    u = unit3(u || [0, 0, 0]);
    if (!u) return all;

    var w = unit3(normal && normal.length === 3 ? normal : [0, 0, 0]);
    if (!w) {
        // No fit to borrow a normal from: take the spoke with the largest
        // component perpendicular to `u`. Zero for every spoke means the whole
        // set is collinear, which has no outline.
        var bestPerp = 0, wRaw = null;
        for (var d = 0; d < n; d++) {
            var x = cross3(u, rel[d]);
            var m = dot3(x, x);
            if (m > bestPerp) { bestPerp = m; wRaw = x; }
        }
        w = unit3(wRaw || [0, 0, 0]);
        if (!w) return all;
    }
    // `u` came from the data and `w` may have come from a fit, so they are not
    // orthogonal in general — Gram-Schmidt before building `v`. If `u` is
    // (anti)parallel to the normal the points are not on that plane at all;
    // fall back to any perpendicular rather than dividing by ~0.
    var uPerp = unit3([
        u[0] - dot3(u, w) * w[0], u[1] - dot3(u, w) * w[1], u[2] - dot3(u, w) * w[2],
    ]);
    if (!uPerp) {
        uPerp = unit3(cross3(w, Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
        if (!uPerp) return all;
    }
    var v = cross3(w, uPerp);

    var flatPts = rel.map(function (r) { return [dot3(r, uPerp), dot3(r, v)]; });
    return convexHullOrder2d(flatPts);
}

/**
 * Vertex ring for one plane's FILL on ONE view, as POOL indices.
 *
 * The user's ring wins when they drew one — edges are the only way to state a
 * CONCAVE outline, so an explicit ring must never be second-guessed. Failing
 * that the fill is the CONVEX HULL of whatever this view has positioned, so a
 * node in the middle of the plane sits INSIDE the fill: the outline is the
 * outermost points, which is what "fill the plane" means to someone who just
 * dropped a 5th node in the middle of a quad.
 *
 * Hulling per VIEW rather than once in 3D is deliberate: the fill is a 2D
 * silhouette drawn from that view's 2D points, and those exist before anything
 * has been triangulated.
 *
 * Unpositioned nodes are skipped — they have no vertex to contribute here.
 *
 * @param {PlaneSkeleton} plane @param {PlaneNodePool} pool
 * @param {PlaneInstance} instance
 * @returns {number[]} Pool indices, in ring order.
 */
export function planeFillOrderPoolIndices(plane, pool, instance) {
    if (!plane || !pool || !instance) return [];
    var ring = planeCycleOrderIds(plane);
    if (ring) {
        var out = [];
        for (var r = 0; r < ring.length; r++) {
            var kr = pool.indexOf(ring[r]);
            if (kr >= 0 && instance.hasPoint(kr)) out.push(kr);
        }
        return out;
    }
    var ks = [], pts = [];
    for (var i = 0; i < plane.nodeIds.length; i++) {
        var k = pool.indexOf(plane.nodeIds[i]);
        if (k < 0 || !instance.hasPoint(k)) continue;
        ks.push(k);
        pts.push([instance.getX(k), instance.getY(k)]);
    }
    return convexHullOrder2d(pts).map(function (h) { return ks[h]; });
}

/**
 * Vertex ring for one plane's 3D FILL, as LOCAL indices into the plane's node
 * order — the shape the 3D viewport payload's `polygonOrder` has.
 *
 * Same rule as the 2D half (`planeFillOrderPoolIndices`): the user's ring when
 * they drew one, otherwise the convex hull, here computed in the plane's own
 * basis so an interior node is enclosed rather than pulled onto the boundary.
 * Nodes with no 3D yet are skipped by the hull; the ring path leaves them in
 * and the viewport skips them, which is what it has always done.
 *
 * @param {PlaneSkeleton} plane @param {PlaneNodePool} pool
 * @returns {number[]} Local indices, in ring order.
 */
export function planeFillOrder3d(plane, pool) {
    if (!plane) return [];
    var ring = planeCycleOrderIds(plane);
    if (ring) return ring.map(function (id) { return plane.indexOfNode(id); });
    if (!pool) return [];

    var idx = [], qs = [];
    for (var i = 0; i < plane.nodeIds.length; i++) {
        var node = pool.getNode(plane.nodeIds[i]);
        if (!node || !node.hasPoint3d()) continue;
        var q = node.xyz;
        if (!isFinite(q[0]) || !isFinite(q[1]) || !isFinite(q[2])) continue;
        idx.push(i);
        qs.push([q[0], q[1], q[2]]);
    }
    var normal = plane.planeFit ? plane.planeFit.normal : null;
    return convexHullOrder3d(qs, normal).map(function (h) { return idx[h]; });
}

/**
 * Centroid of ONE plane's positioned nodes on ONE view, in video pixels, or
 * null if none are positioned. Where the plane's name label goes — per-plane
 * rather than per-instance now that a view's instance covers every plane.
 * @param {PlaneSkeleton} plane @param {PlaneNodePool} pool
 * @param {PlaneInstance} instance @returns {number[]|null}
 */
export function planeCentroid2d(plane, pool, instance) {
    if (!instance) return null;
    return instance.centroid(planeNodeIndices(plane, pool));
}

/**
 * Seed 2D points for a freshly dropped plane: node 0 at 12 o'clock and the rest
 * evenly around a ring centred on the drop point, so a 4-node plane lands as a
 * recognisable quad the user can drag onto the real feature rather than a pile
 * of coincident dots. Clamped into the frame.
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
