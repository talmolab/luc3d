// pose/plane-serialization.js — the plane feature's on-disk form, both ways.
//
// The Define Planes pipeline builds three kinds of state, and they do NOT have
// the same scope:
//
//   PROJECT-scoped  the node pool, the planes (membership, edges, fill, the
//                   triangulation summary, the plane fit) and the origin frame.
//                   One node has one 3D position for the whole project, which
//                   is the entire reason the pool is global.
//   SESSION-scoped  the per-view 2D (`PlaneInstance`), because a view belongs
//                   to a session. Stored on `Session.planePlacements`.
//
// This module owns the mapping in both directions and NOTHING about where the
// bytes end up — `import-export/plane-metadata.js` is what decides that. Kept
// DOM-free and UI-free so the round trip can be tested directly, which matters
// more here than usual: the failure mode of a subtly wrong restore is not a
// crash but a plane whose corners come back seated on their neighbours' nodes,
// every point still looking perfectly valid.
//
// ## IDs are the wire format, indices never are
//
// Plane membership, plane edges and `PlaneInstance.placedPlanes` are stored as
// IDs in memory for exactly the reason they must be stored as IDs on disk: the
// pool's ORDER is the index space every `PlaneInstance` is keyed by, and any
// restore that re-derives IDs from position re-points every reference the
// moment two projects' orders differ. So `restorePlaneProject` adopts nodes and
// planes with the IDs the file gives them (`PlaneNodePool.adoptNode` /
// `PlaneModel.adoptPlane`), and placements name their nodes BY ID and are
// re-seated onto the live pool by `PlaneInstance.resyncToNodeIds` — the same
// repair `PlaneModel.attachPlacements` already performs on every session
// switch, so a placement map read from disk and one detached at runtime take
// exactly the same path back in.
//
// ## Absence is a value
//
// Every serializer returns `null` when there is nothing to say (no nodes, no
// planes, no placed 2D, no origin), so a project that never opened the feature
// writes no keys at all and its bytes are unchanged. Every reader tolerates
// absent, malformed and partial input: a `.slp` from SLEAP, or from a LUCID
// build older than this module, simply restores an empty model.
//
// NaN is why 3D is written CONDITIONALLY rather than as three numbers.
// `JSON.stringify(NaN)` is `null`, so an untriangulated node round-tripped
// naively comes back as `[null, null, null]` and every `isFinite` check
// downstream has to defend against it. A node with no 3D omits the key.

import { PlaneNode, PlaneNodePool } from './plane-nodes.js';
import { PlaneSkeleton, PlaneInstance } from './plane-data.js';
import { buildOriginFrame } from './origin-frame.js';

/** Finite number, or `null`. @private */
function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : null;
}

/** A finite 3-vector copied out of `v`, or null. @private */
function vec3(v) {
    if (!v || v.length < 3) return null;
    var a = num(v[0]), b = num(v[1]), c = num(v[2]);
    return (a === null || b === null || c === null) ? null : [a, b, c];
}

// ============================================
// Nodes
// ============================================

/**
 * The node pool as plain JSON, in POOL ORDER.
 *
 * Order is significant and preserved: it is the index space every
 * `PlaneInstance` uses, so restoring the pool in a different order would move
 * every 2D point onto a different node even though nothing about the nodes
 * themselves changed.
 *
 * @param {PlaneNodePool} pool
 * @returns {Object[]|null} null when the pool is empty.
 */
export function serializePlaneNodes(pool) {
    if (!pool || !pool.nodes.length) return null;
    return pool.nodes.map(function (node) {
        var out = { id: node.id, name: node.name, color: node.color };
        if (node.immutable) out.immutable = true;
        // Omitted rather than written as three nulls — see the module note.
        if (node.hasPoint3d()) out.xyz = [node.xyz[0], node.xyz[1], node.xyz[2]];
        if (num(node.error) !== null) out.error = node.error;
        return out;
    });
}

/**
 * Rebuild a pool from `serializePlaneNodes` output.
 *
 * Entries with a missing or duplicate ID are skipped rather than renumbered:
 * an ID is a reference target, so inventing one would silently attach some
 * plane's membership to the wrong node. A skipped node simply does not exist,
 * and `restorePlanes` drops the references to it.
 *
 * @param {*} data @returns {PlaneNodePool}
 */
export function restorePlaneNodes(data) {
    var pool = new PlaneNodePool();
    if (!Array.isArray(data)) return pool;
    for (var i = 0; i < data.length; i++) {
        var d = data[i];
        if (!d || typeof d !== 'object') continue;
        var id = num(d.id);
        if (id === null || id !== Math.floor(id) || id < 1) continue;
        var node = new PlaneNode(
            id,
            typeof d.name === 'string' ? d.name : ('n' + id),
            typeof d.color === 'string' ? d.color : '#ffffff',
            !!d.immutable);
        var xyz = vec3(d.xyz);
        // `force` because a pinned node refuses ordinary writes, and this IS
        // the pinned coordinate the user saved.
        if (xyz) node.setPoint3d(xyz, { force: true });
        if (num(d.error) !== null) node.error = d.error;
        pool.adoptNode(node);
    }
    return pool;
}

// ============================================
// Planes
// ============================================

/** A plane's solve summary, or null. @private */
function serializeTriangulation(t) {
    if (!t) return null;
    return {
        views: Array.isArray(t.views) ? t.views.slice() : [],
        nNodes: num(t.nNodes) === null ? 0 : t.nNodes,
        meanError: num(t.meanError),
    };
}

/** A plane's fit, or null when it is absent or not finite. @private */
function serializePlaneFit(f) {
    if (!f) return null;
    var centroid = vec3(f.centroid);
    var normal = vec3(f.normal);
    if (!centroid || !normal) return null;
    return {
        centroid: centroid,
        normal: normal,
        rms: num(f.rms) === null ? 0 : f.rms,
        nPoints: num(f.nPoints) === null ? 0 : f.nPoints,
    };
}

/**
 * Every plane as plain JSON, in creation order.
 *
 * `filled`, `triangulation` and `planeFit` are included: they are the plane's
 * STATE, not a cache. A reopened project whose planes came back un-fit would
 * offer no corners to Set Origin and would report no reprojection error, so the
 * user would have to re-run a solve to get back to what they saved.
 *
 * @param {PlaneSkeleton[]} planes
 * @returns {Object[]|null} null when there are none.
 */
export function serializePlanes(planes) {
    if (!planes || !planes.length) return null;
    return planes.map(function (plane) {
        var out = {
            id: plane.id,
            name: plane.name,
            color: plane.color,
            nodeIds: plane.nodeIds.slice(),
        };
        if (plane.edges.length) {
            out.edges = plane.edges.map(function (e) { return [e[0], e[1]]; });
        }
        if (plane.filled) out.filled = true;
        var tri = serializeTriangulation(plane.triangulation);
        if (tri) out.triangulation = tri;
        var fit = serializePlaneFit(plane.planeFit);
        if (fit) out.planeFit = fit;
        return out;
    });
}

/**
 * Rebuild the planes from `serializePlanes` output, dropping every reference to
 * a node `pool` does not hold.
 *
 * Dropping rather than keeping is deliberate: a membership entry naming an
 * absent node would make `planeNodeIndices` return -1 for that slot, and a -1
 * fed to a `PlaneInstance` lookup reads whatever sits at the end of the
 * points array. The plane comes back one corner short, which is visible;
 * the alternative is a corner in a plausible but wrong place, which is not.
 *
 * @param {*} data @param {PlaneNodePool} pool @returns {PlaneSkeleton[]}
 */
export function restorePlanes(data, pool) {
    var out = [];
    if (!Array.isArray(data)) return out;
    var seen = new Set();
    for (var i = 0; i < data.length; i++) {
        var d = data[i];
        if (!d || typeof d !== 'object') continue;
        var id = num(d.id);
        if (id === null || id !== Math.floor(id) || id < 1 || seen.has(id)) continue;
        seen.add(id);

        var ids = Array.isArray(d.nodeIds) ? d.nodeIds.filter(function (nid) {
            return pool.has(nid);
        }) : [];
        var edges = Array.isArray(d.edges) ? d.edges.filter(function (e) {
            return Array.isArray(e) && e.length >= 2 &&
                ids.indexOf(e[0]) >= 0 && ids.indexOf(e[1]) >= 0;
        }) : [];

        var plane = new PlaneSkeleton(id, typeof d.name === 'string' ? d.name : ('plane_' + id), ids, edges);
        if (typeof d.color === 'string') plane.color = d.color;
        plane.filled = !!d.filled;
        plane.triangulation = serializeTriangulation(d.triangulation);
        plane.planeFit = serializePlaneFit(d.planeFit);
        out.push(plane);
    }
    return out;
}

// ============================================
// Placements (per-view 2D — SESSION-scoped)
// ============================================

/**
 * One session's placement map as plain JSON.
 *
 * Points are written as `{n: <nodeId>, xy: [x, y]}` rather than as a dense
 * array in pool order, and the two flag sets ride along on the same entry. That
 * is what makes the payload survive a pool that has changed since the file was
 * written: a dense array can only be re-seated by counting, and counting is
 * exactly the repair that cannot tell "a node was appended" from "a node was
 * spliced out of the middle" (see `PlaneInstance.resyncToNodeIds`).
 *
 * A view with no positioned point and no placed plane contributes nothing.
 *
 * @param {Map<string, PlaneInstance>} placements
 * @param {PlaneNodePool} pool - supplies the node ID for each pool index
 * @returns {Object[]|null} null when no view holds anything.
 */
export function serializePlanePlacements(placements, pool) {
    if (!placements || !placements.size || !pool) return null;
    var out = [];
    placements.forEach(function (inst, viewName) {
        var points = [];
        for (var i = 0; i < inst.numNodes; i++) {
            // Prefer the instance's own ledger; fall back to the pool for a
            // column the ledger never learned about.
            var nodeId = inst.nodeIds[i];
            if (nodeId == null) {
                var pn = pool.nodeAt(i);
                nodeId = pn ? pn.id : null;
            }
            if (nodeId == null) continue;
            var positioned = inst.hasPoint(i);
            var off = inst.isNodeNulled(i);
            var der = inst.isNodeDerived(i);
            if (!positioned && !off && !der) continue;
            var e = { n: nodeId };
            if (positioned) e.xy = [inst.getX(i), inst.getY(i)];
            if (off) e.off = true;
            if (der) e.derived = true;
            points.push(e);
        }
        var planes = [];
        inst.placedPlanes.forEach(function (pid) { planes.push(pid); });
        planes.sort(function (a, b) { return a - b; });
        if (!points.length && !planes.length) return;
        var rec = { view: viewName };
        if (planes.length) rec.planes = planes;
        if (points.length) rec.points = points;
        out.push(rec);
    });
    return out.length ? out : null;
}

/**
 * Rebuild a session's placement map from `serializePlanePlacements` output.
 *
 * Every instance is built to cover the WHOLE pool in pool order (the invariant
 * `PlaneModel` maintains), then filled in by node ID. Entries naming a node the
 * pool no longer holds are dropped, and so are `planes` ids not in `planeIds`
 * — a placement flag for a deleted plane makes that plane's nodes render on a
 * view that has no plane to explain them.
 *
 * @param {*} data
 * @param {PlaneNodePool} pool
 * @param {number[]} [planeIds] - live plane ids; omitted means accept all
 * @returns {Map<string, PlaneInstance>}
 */
export function restorePlanePlacements(data, pool, planeIds) {
    var map = new Map();
    if (!Array.isArray(data) || !pool) return map;
    var ids = pool.ids();
    var indexById = new Map();
    for (var k = 0; k < ids.length; k++) indexById.set(ids[k], k);
    var livePlanes = planeIds ? new Set(planeIds) : null;

    for (var i = 0; i < data.length; i++) {
        var d = data[i];
        if (!d || typeof d !== 'object' || typeof d.view !== 'string') continue;
        if (map.has(d.view)) continue;
        var inst = new PlaneInstance(i + 1, d.view, ids.length, ids);
        var pts = Array.isArray(d.points) ? d.points : [];
        for (var j = 0; j < pts.length; j++) {
            var e = pts[j];
            if (!e || typeof e !== 'object') continue;
            var idx = indexById.get(e.n);
            if (idx === undefined) continue;
            var x = e.xy ? num(e.xy[0]) : null;
            var y = e.xy ? num(e.xy[1]) : null;
            if (x !== null && y !== null) inst.setPoint(idx, x, y);
            if (e.off) inst.nulledNodes.add(idx);
            // A derived flag on a node with no position would mark a point
            // that is not there as reprojected, so it needs the position.
            if (e.derived && x !== null && y !== null) inst.setNodeDerived(idx, true);
        }
        var planes = Array.isArray(d.planes) ? d.planes : [];
        for (var q = 0; q < planes.length; q++) {
            var pid = planes[q];
            if (livePlanes && !livePlanes.has(pid)) continue;
            inst.placedPlanes.add(pid);
        }
        map.set(d.view, inst);
    }
    return map;
}

// ============================================
// The origin frame
// ============================================

/**
 * The applied origin frame, reduced to the two things the user actually chose.
 *
 * `buildOriginFrame` derives X and Y (and therefore R, the translation and the
 * axis-angle form) DETERMINISTICALLY from an origin and a +Z, so storing the
 * derived quantities as well would create a second source of truth that a file
 * edit, a version bump or a rounding difference could put at odds with the
 * inputs. The frame is rebuilt on load instead; the round trip is exact.
 *
 * `sourcePlane` / `sourceNode` are carried because they are labels the result
 * table shows and cannot be re-derived once a plane is renamed or deleted.
 *
 * @param {Object|null} frame - from `buildOriginFrame`, possibly with the
 *   `sourcePlane` / `sourceNode` labels `ui/origin-definition.js` attaches
 * @returns {Object|null} null when no user frame is in force.
 */
export function serializeOriginFrame(frame) {
    if (!frame) return null;
    var origin = vec3(frame.origin);
    var zAxis = vec3(frame.zAxis);
    if (!origin || !zAxis) return null;
    var out = { origin: origin, zAxis: zAxis };
    if (frame.sourcePlane) out.sourcePlane = String(frame.sourcePlane);
    if (frame.sourceNode) out.sourceNode = String(frame.sourceNode);
    return out;
}

/**
 * Rebuild the applied frame from `serializeOriginFrame` output.
 * @param {*} data @returns {Object|null}
 */
export function restoreOriginFrame(data) {
    if (!data || typeof data !== 'object') return null;
    var origin = vec3(data.origin);
    var zAxis = vec3(data.zAxis);
    if (!origin || !zAxis) return null;
    var frame = buildOriginFrame(origin, zAxis);
    if (!frame) return null;
    frame.sourcePlane = typeof data.sourcePlane === 'string' ? data.sourcePlane : null;
    frame.sourceNode = typeof data.sourceNode === 'string' ? data.sourceNode : null;
    return frame;
}

// ============================================
// The project-scoped bundle
// ============================================

/**
 * Serialize the project-scoped half: pool + planes (+ nothing else).
 *
 * Placements are NOT here — they are per session, and this bundle is written
 * identically into every session of a multi-session project so that opening any
 * one of them restores the same nodes and planes.
 *
 * A plane with no nodes yet is still a plane the user named and expects back,
 * so the bundle survives an empty pool; only a model with neither nodes nor
 * planes writes nothing.
 *
 * @param {import('./plane-data.js').PlaneModel} model
 * @returns {{planeNodes:Object[]|undefined, planes:Object[]|undefined}|null}
 *   null when there is no plane state at all.
 */
export function serializePlaneProject(model) {
    if (!model) return null;
    var nodes = serializePlaneNodes(model.pool);
    var planes = serializePlanes(model.planes);
    if (!nodes && !planes) return null;
    var out = {};
    if (nodes) out.planeNodes = nodes;
    if (planes) out.planes = planes;
    return out;
}

/**
 * Restore the project-scoped half INTO `model`, replacing its pool and planes.
 *
 * Replaces rather than merges. Two projects' node IDs are unrelated, so merging
 * would either collide IDs or renumber them, and renumbering is the one thing
 * this module must never do (see the module note). The caller is responsible
 * for only calling this on a model that should be replaced — in practice, on
 * load, when the previous project has already been torn down.
 *
 * Placements are left alone: they are re-attached per session by
 * `PlaneModel.attachPlacements`, which re-seats them onto whatever pool is
 * live at the time.
 *
 * @param {import('./plane-data.js').PlaneModel} model
 * @param {*} data - `{planeNodes, planes}`, or anything at all
 * @returns {{nodes:number, planes:number}} how much was restored
 */
export function restorePlaneProject(model, data) {
    if (!model) return { nodes: 0, planes: 0 };
    var src = (data && typeof data === 'object') ? data : {};
    var pool = restorePlaneNodes(src.planeNodes);
    var planes = restorePlanes(src.planes, pool);

    model.pool = pool;
    model.planes = planes;
    model._nextPlaneId = 1;
    for (var i = 0; i < planes.length; i++) {
        if (planes[i].id >= model._nextPlaneId) model._nextPlaneId = planes[i].id + 1;
    }
    return { nodes: pool.size, planes: planes.length };
}
