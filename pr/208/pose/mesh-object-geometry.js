// pose/mesh-object-geometry.js — turn "a group of planes" into a mesh.
//
// The shape of a 3D Mesh Object is DERIVED, never stored: it is a pure function
// of the plane model, rebuilt whenever anyone asks. That follows the rule the
// whole Define Planes feature holds — the node pool is the single source of
// truth for 3D — and it is why `ui/viewport3d.js` rebuilds its plane group every
// update rather than caching geometry. A stored mesh is a second copy of every
// vertex that goes stale the moment a node is dragged, re-triangulated or
// pinned.
//
// ## How connectivity determines the shape
//
// Everything below falls out of the existing node-pool design, and none of it
// needs a merge-by-distance pass:
//
//   1. VERTICES are the pool nodes the member planes reference. Two planes
//      referencing one node produce ONE vertex, so a shared corner welds itself.
//   2. FACES are the planes, each a ring of vertex indices.
//   3. EDGES are shared automatically. An edge is an unordered pair of vertices;
//      two faces are adjacent iff they list the same pair. That adjacency graph
//      IS "how the planes are connected", and shells, naked edges, manifoldness
//      and coherent winding are all read off it.
//
// ## The two things the annotation genuinely does not determine
//
// **Winding.** A face's ring comes from the user's edge cycle when there is one
// (`planeCycleOrderIds`) and otherwise from the convex hull of its corners
// seeded by `planeFit.normal` — and that normal is a PCA eigenvector, so its
// SIGN IS ARBITRARY. Three independently-fit planes therefore have three
// unrelated windings. In Blender that means black patches, failed booleans and a
// wrong "inside". `orientFacesCoherently` fixes the relative half with the
// manifold rule (two faces sharing an edge traverse it in OPPOSITE directions),
// and `signedVolume` fixes the global half for a CLOSED mesh. For an OPEN one —
// a cage with no lid — there is no enclosed volume and nothing can decide which
// side is out, so the object carries a user-set `flipNormals` instead of this
// module guessing.
//
// **Which side of a concave face is inside.** The fan in
// `viewport3d._buildPlaneFillMesh` is right for a translucent overlay and wrong
// for exported geometry: it self-overlaps on any concave ring. `earClipFace`
// clips in the face's own 2D basis instead. The viewport's fan is deliberately
// left alone — this is a new consumer, not a replacement.
//
// ## Coordinates
//
// LUCID's world is Z-up right-handed. **So is Blender's.** No axis conversion
// belongs anywhere in this pipeline; a future exporter that "helpfully" swaps Y
// and Z will silently lay the cage on its side. The only transforms applied here
// are the user's origin frame (`applyOriginFrame`) and a uniform positive scale.
//
// DOM-free and THREE-free on purpose: this is the part worth testing directly.

import {
    planeCycleOrderIds, convexHullOrder3d,
} from './plane-data.js';
import { applyOriginFrame } from './origin-frame.js';

/** Fraction of the bounding-box diagonal two distinct nodes must be within to
 * be reported as suspiciously coincident. */
const COINCIDENT_FRAC = 1e-4;

/** Ear clipping bails out after this many failed sweeps; see `earClip2d`. */
const EAR_CLIP_GUARD = 100000;

// ============================================
// Small vector helpers (local, so this module stays dependency-light)
// ============================================

/** @private */
function cross3(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

/** @private */
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/** @private Unit copy, or null when too short to have a direction. */
function unit3(v) {
    var n = Math.sqrt(dot3(v, v));
    if (!(n > 1e-12)) return null;
    return [v[0] / n, v[1] / n, v[2] / n];
}

/** Canonical key for an UNDIRECTED edge between two vertex indices. @private */
function edgeKey(a, b) {
    return a < b ? (a + ':' + b) : (b + ':' + a);
}

// ============================================
// Rings — a plane's corners in polygon order, as NODE IDS
// ============================================

/**
 * One plane's corners in polygon order, as node IDs, keeping only those with 3D.
 *
 * The same dispatch `planeFillOrder3d` uses — the user's edge cycle when the
 * plane has one, else the convex hull of its positioned corners — but expressed
 * in NODE IDS rather than plane-local indices, because IDs are the only index
 * space shared between two different planes. That sharing is the entire
 * mechanism by which faces discover they are adjacent.
 *
 * An untriangulated corner is DROPPED rather than treated as a hole: a node with
 * no 3D has no position to contribute, and leaving a gap in the ring is exactly
 * what the viewport already does.
 *
 * @param {import('./plane-data.js').PlaneSkeleton} plane
 * @param {import('./plane-nodes.js').PlaneNodePool} pool
 * @returns {number[]} Node IDs, in ring order. Possibly shorter than the plane.
 */
export function faceRingNodeIds(plane, pool) {
    if (!plane || !pool) return [];

    var positioned = function (id) {
        var node = pool.getNode(id);
        return !!(node && node.hasPoint3d());
    };

    var cycle = planeCycleOrderIds(plane);
    if (cycle) return cycle.filter(positioned);

    // No user ring: hull the corners that have 3D, oriented by the plane's fit
    // when it has one. `convexHullOrder3d` needs positions and indices in step.
    var ids = [], qs = [];
    for (var i = 0; i < plane.nodeIds.length; i++) {
        var id = plane.nodeIds[i];
        var node = pool.getNode(id);
        if (!node || !node.hasPoint3d()) continue;
        ids.push(id);
        qs.push([node.xyz[0], node.xyz[1], node.xyz[2]]);
    }
    var normal = plane.planeFit ? plane.planeFit.normal : null;
    return convexHullOrder3d(qs, normal).map(function (h) { return ids[h]; });
}

// ============================================
// Normals, area, volume
// ============================================

/**
 * Newell's normal for a polygon ring — the area-weighted normal, unnormalized.
 *
 * Newell rather than a cross product of the first three edges because a face
 * built from triangulated annotation is never exactly planar, and a three-point
 * cross product would key the whole face's orientation off whichever three
 * corners happen to come first (and degenerate outright if they are collinear).
 * Newell averages over every edge, so it degrades gracefully.
 *
 * Follows the right-hand rule with respect to the ring's winding.
 *
 * @param {number[][]} pts - Ring positions, in order.
 * @returns {number[]} `[x,y,z]`, unnormalized.
 */
export function newellNormal(pts) {
    var nx = 0, ny = 0, nz = 0;
    var n = pts.length;
    for (var i = 0; i < n; i++) {
        var a = pts[i], b = pts[(i + 1) % n];
        nx += (a[1] - b[1]) * (a[2] + b[2]);
        ny += (a[2] - b[2]) * (a[0] + b[0]);
        nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return [nx, ny, nz];
}

/**
 * Signed volume enclosed by a triangulated surface, by the divergence theorem:
 * `V = Σ (1/6) · v0 · (v1 × v2)`.
 *
 * Only MEANINGFUL for a closed surface, where a positive result means the
 * normals point outward. Every term is computed about the world origin, which is
 * legitimate for a closed mesh (the origin-dependent parts cancel) and is why
 * this must not be trusted on an open one.
 *
 * @param {Float64Array|number[]} vertices - 3V, flat.
 * @param {Uint32Array|number[]} triangles - 3T, flat.
 * @returns {number}
 */
export function signedVolume(vertices, triangles) {
    var v = 0;
    for (var t = 0; t + 2 < triangles.length; t += 3) {
        var i0 = triangles[t] * 3, i1 = triangles[t + 1] * 3, i2 = triangles[t + 2] * 3;
        var a = [vertices[i0], vertices[i0 + 1], vertices[i0 + 2]];
        var b = [vertices[i1], vertices[i1 + 1], vertices[i1 + 2]];
        var c = [vertices[i2], vertices[i2 + 1], vertices[i2 + 2]];
        v += dot3(a, cross3(b, c)) / 6;
    }
    return v;
}

// ============================================
// Ear clipping
// ============================================

/** 2D cross product of (b−a) and (c−b). @private */
function cross2(a, b, c) {
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/**
 * Does `p` lie inside triangle abc, INCLUDING its boundary? `abc` must be CCW.
 *
 * Non-strict deliberately, and this is the subtle part of ear clipping. A
 * vertex sitting exactly ON a candidate ear's edge is the textbook degeneracy:
 * with a strict test it does not block the ear, so the ear gets clipped and the
 * resulting triangle pokes outside the polygon. That is not hypothetical here —
 * a plain L-shaped ring hits it, because the reflex corner lands exactly on the
 * diagonal of the first ear tried.
 *
 * `eps` is an AREA tolerance (`cross2` returns twice a signed area), so it has
 * to be scaled by the polygon's extent squared by the caller. Slightly-outside
 * points are treated as blocking: refusing a legitimate ear costs another sweep,
 * while accepting a bad one silently corrupts the mesh.
 *
 * @private
 */
function pointInTriangle2d(p, a, b, c, eps) {
    return cross2(a, b, p) >= -eps
        && cross2(b, c, p) >= -eps
        && cross2(c, a, p) >= -eps;
}

/** Twice the signed area of a 2D ring. @private */
function signedArea2(pts) {
    var s = 0, n = pts.length;
    for (var i = 0; i < n; i++) {
        var a = pts[i], b = pts[(i + 1) % n];
        s += a[0] * b[1] - b[0] * a[1];
    }
    return s;
}

/**
 * Ear-clip a simple 2D polygon into triangles.
 *
 * Returns index triples into `pts`. Falls back to a fan and sets `.stalled` when
 * no ear can be found — which happens for a self-intersecting ring, and is a
 * case the user CAN produce by drawing a bowtie of edges. Falling back is
 * deliberate: a wrong-but-visible triangulation is easier to diagnose than a
 * silently empty face, and the connectivity report flags it separately.
 *
 * @param {number[][]} pts - `[x,y]` per vertex, in ring order.
 * @returns {{triangles:number[][], stalled:boolean}}
 */
export function earClip2d(pts) {
    var n = pts.length;
    if (n < 3) return { triangles: [], stalled: false };
    if (n === 3) return { triangles: [[0, 1, 2]], stalled: false };

    // Work CCW; `remain` holds original indices so the result maps back.
    var ccw = signedArea2(pts) >= 0;
    var remain = [];
    for (var i = 0; i < n; i++) remain.push(ccw ? i : (n - 1 - i));

    // Area tolerance for the containment test, scaled to this polygon so it
    // means the same thing whether coordinates are in millimetres or metres.
    var ext = 0;
    for (var e = 0; e < n; e++) {
        ext = Math.max(ext, Math.abs(pts[e][0]), Math.abs(pts[e][1]));
    }
    var eps = (ext > 0 ? ext * ext : 1) * 1e-12;

    var tris = [];
    var guard = 0;
    var stalled = false;

    while (remain.length > 3) {
        var m = remain.length;
        var clipped = false;
        for (var k = 0; k < m; k++) {
            var ia = remain[(k - 1 + m) % m], ib = remain[k], ic = remain[(k + 1) % m];
            var a = pts[ia], b = pts[ib], c = pts[ic];
            // Reflex or collinear vertices cannot be ears.
            if (cross2(a, b, c) <= 0) continue;
            var clean = true;
            for (var j = 0; j < m; j++) {
                var ij = remain[j];
                if (ij === ia || ij === ib || ij === ic) continue;
                if (pointInTriangle2d(pts[ij], a, b, c, eps)) { clean = false; break; }
            }
            if (!clean) continue;
            tris.push([ia, ib, ic]);
            remain.splice(k, 1);
            clipped = true;
            break;
        }
        if (!clipped || ++guard > EAR_CLIP_GUARD) { stalled = true; break; }
    }

    if (stalled) {
        // Fan over whatever is left, in the ORIGINAL order — see the note above.
        tris = [];
        for (var f = 1; f < n - 1; f++) tris.push([0, f, f + 1]);
        return { triangles: tris, stalled: true };
    }

    tris.push([remain[0], remain[1], remain[2]]);
    return { triangles: tris, stalled: false };
}

/**
 * Triangulate one face by ear clipping in its own plane.
 *
 * Projects the ring onto a 2D basis built from its Newell normal, clips there,
 * and maps the triples back to the caller's vertex indices. The basis is
 * right-handed (`u × v = n`), so a ring wound CCW about its own normal comes out
 * with positive area and the clipped triangles inherit the face's winding —
 * which is what makes `signedVolume` meaningful afterwards.
 *
 * @param {number[]} ring - Vertex indices, in order.
 * @param {Float64Array|number[]} vertices - 3V, flat.
 * @returns {{triangles:number[][], normal:number[]|null, stalled:boolean}}
 */
export function earClipFace(ring, vertices) {
    if (!ring || ring.length < 3) return { triangles: [], normal: null, stalled: false };

    var pts3 = ring.map(function (vi) {
        return [vertices[vi * 3], vertices[vi * 3 + 1], vertices[vi * 3 + 2]];
    });
    var normal = unit3(newellNormal(pts3));
    if (!normal) {
        // Collinear or zero-area face: nothing sane to triangulate.
        return { triangles: [], normal: null, stalled: true };
    }

    // Any vector not parallel to the normal seeds the in-plane basis.
    var seed = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    var u = unit3(cross3(normal, seed));
    if (!u) return { triangles: [], normal: normal, stalled: true };
    var v = cross3(normal, u);

    var pts2 = pts3.map(function (p) { return [dot3(p, u), dot3(p, v)]; });
    var res = earClip2d(pts2);
    return {
        triangles: res.triangles.map(function (t) {
            return [ring[t[0]], ring[t[1]], ring[t[2]]];
        }),
        normal: normal,
        stalled: res.stalled,
    };
}

// ============================================
// Adjacency and coherent orientation
// ============================================

/**
 * Map every undirected edge to the faces that use it.
 *
 * This IS the "how are the planes connected" question, answered once. Because
 * vertices are shared pool nodes, two faces land on the same key without any
 * distance test — the welding is topological, not geometric.
 *
 * @param {number[][]} faces - Rings of vertex indices.
 * @returns {Map<string, number[]>} edge key -> face indices.
 */
export function faceAdjacency(faces) {
    var edges = new Map();
    for (var f = 0; f < faces.length; f++) {
        var ring = faces[f];
        for (var i = 0; i < ring.length; i++) {
            var a = ring[i], b = ring[(i + 1) % ring.length];
            if (a === b) continue;
            var key = edgeKey(a, b);
            var list = edges.get(key);
            if (!list) { list = []; edges.set(key, list); }
            // A face that lists the same edge twice (a degenerate ring) is
            // recorded once, so it cannot masquerade as non-manifold.
            if (list.indexOf(f) < 0) list.push(f);
        }
    }
    return edges;
}

/** Does `ring` traverse u→v in that direction? @private */
function traversesDirected(ring, u, v) {
    for (var i = 0; i < ring.length; i++) {
        if (ring[i] === u && ring[(i + 1) % ring.length] === v) return true;
    }
    return false;
}

/**
 * Make every face's winding agree with its neighbours, in place.
 *
 * The rule, and the whole reason this is only a BFS: **in a coherently oriented
 * mesh, two faces sharing an edge traverse it in OPPOSITE directions.** So walk
 * the adjacency graph from an arbitrary seed and reverse any neighbour that
 * traverses the shared edge the same way the current face does. The seed's own
 * orientation is arbitrary — that is the global half, which `signedVolume`
 * settles for a closed mesh and the user settles for an open one.
 *
 * Direction is read LIVE from `faces`, never from a precomputed table, because
 * a face reversed earlier in the walk must be compared in its new orientation.
 *
 * @param {number[][]} faces - Rings of vertex indices; MUTATED.
 * @param {Map<string, number[]>} [edges] - From `faceAdjacency`; rebuilt if absent.
 * @returns {{shells:number, flipped:number, ambiguous:number}}
 *   `ambiguous` counts edges shared by three or more faces, where "the other
 *   face" is not a well-defined thing and orientation is a guess.
 */
export function orientFacesCoherently(faces, edges) {
    var adj = edges || faceAdjacency(faces);
    var visited = new Array(faces.length).fill(false);
    var shells = 0, flipped = 0, ambiguous = 0;

    var seenAmbiguous = new Set();
    adj.forEach(function (list, key) {
        if (list.length > 2 && !seenAmbiguous.has(key)) {
            seenAmbiguous.add(key);
            ambiguous++;
        }
    });

    for (var seed = 0; seed < faces.length; seed++) {
        if (visited[seed]) continue;
        shells++;
        visited[seed] = true;
        var queue = [seed];
        while (queue.length) {
            var f = queue.shift();
            var ring = faces[f];
            for (var i = 0; i < ring.length; i++) {
                var u = ring[i], v = ring[(i + 1) % ring.length];
                if (u === v) continue;
                var neighbours = adj.get(edgeKey(u, v)) || [];
                for (var k = 0; k < neighbours.length; k++) {
                    var g = neighbours[k];
                    if (g === f || visited[g]) continue;
                    // Same direction as us ⇒ inconsistent ⇒ reverse it.
                    if (traversesDirected(faces[g], u, v)) {
                        faces[g].reverse();
                        flipped++;
                    }
                    visited[g] = true;
                    queue.push(g);
                }
            }
        }
    }

    return { shells: shells, flipped: flipped, ambiguous: ambiguous };
}

// ============================================
// Connectivity report
// ============================================

/**
 * Naked / non-manifold edge counts and closedness, from the adjacency map.
 *
 * A **naked** edge is used by exactly one face — the object is open there. A
 * **non-manifold** edge is used by three or more, which no exporter and no
 * modelling tool can interpret consistently. Closed means neither exists.
 *
 * @param {number[][]} faces @param {Map<string, number[]>} [edges]
 * @returns {{edgeCount:number, nakedEdges:number, nonManifoldEdges:number, isClosed:boolean}}
 */
export function meshConnectivity(faces, edges) {
    var adj = edges || faceAdjacency(faces);
    var naked = 0, nonManifold = 0, total = 0;
    adj.forEach(function (list) {
        total++;
        if (list.length === 1) naked++;
        else if (list.length > 2) nonManifold++;
    });
    return {
        edgeCount: total,
        nakedEdges: naked,
        nonManifoldEdges: nonManifold,
        isClosed: total > 0 && naked === 0 && nonManifold === 0,
    };
}

/**
 * Distinct nodes that sit on top of each other but were never joined.
 *
 * The "I thought I joined it" case, and the most useful thing this module can
 * tell a user: two planes drawn to meet, whose corners are separate pool nodes
 * a hair apart. Topologically the mesh is open there and no amount of
 * re-triangulating will close it — the fix is to make one plane REFERENCE the
 * other's node.
 *
 * Reported, never acted on. Merging two nodes would destroy one of them, and
 * with it its 2D placement on every view — a side effect this feature is not
 * allowed to have.
 *
 * @param {number[]} nodeIds - The object's vertex node IDs.
 * @param {Float64Array|number[]} vertices - 3V, flat, parallel to `nodeIds`.
 * @param {number} [eps] - Defaults to 1e-4 x the bounding-box diagonal.
 * @returns {{pairs:Array<{a:number,b:number,distance:number}>, eps:number}}
 */
export function coincidentNodeReport(nodeIds, vertices, eps) {
    var n = nodeIds.length;
    var pairs = [];
    if (n < 2) return { pairs: pairs, eps: eps || 0 };

    var tol = eps;
    if (!(tol > 0)) {
        var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (var i = 0; i < n; i++) {
            for (var d = 0; d < 3; d++) {
                var c = vertices[i * 3 + d];
                if (c < lo[d]) lo[d] = c;
                if (c > hi[d]) hi[d] = c;
            }
        }
        var diag = Math.sqrt(
            (hi[0] - lo[0]) * (hi[0] - lo[0]) +
            (hi[1] - lo[1]) * (hi[1] - lo[1]) +
            (hi[2] - lo[2]) * (hi[2] - lo[2])
        );
        tol = (diag > 0 ? diag : 1) * COINCIDENT_FRAC;
    }

    var tol2 = tol * tol;
    for (var a = 0; a < n; a++) {
        for (var b = a + 1; b < n; b++) {
            var dx = vertices[a * 3] - vertices[b * 3];
            var dy = vertices[a * 3 + 1] - vertices[b * 3 + 1];
            var dz = vertices[a * 3 + 2] - vertices[b * 3 + 2];
            var d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= tol2) {
                pairs.push({ a: nodeIds[a], b: nodeIds[b], distance: Math.sqrt(d2) });
            }
        }
    }
    return { pairs: pairs, eps: tol };
}

// ============================================
// The build
// ============================================

/**
 * Build a 3D Mesh Object's geometry from the plane model.
 *
 * Pure: nothing is written back to the model, and calling twice with the same
 * inputs gives the same output. Order of operations matters and is fixed —
 * transform, then weld, then ring, then orient, then triangulate — because
 * orientation is defined on the final coordinates and the volume test on the
 * final triangles.
 *
 * @param {import('./mesh-object-3d.js').MeshObject3D} obj
 * @param {import('./plane-data.js').PlaneModel} model
 * @param {{frame?:Object|null, scale?:number, eps?:number}} [opts]
 *   `frame` - an origin frame from `buildOriginFrame`; applied when present, so
 *             the object comes out in the frame the user established.
 *   `scale` - uniform, positive. Units live outside the calibration, so this is
 *             the user's (e.g. 0.001 for mm -> m). A non-positive value is
 *             ignored rather than allowed to mirror the mesh.
 * @returns {Object} See the `MeshObjectGeometry` typedef in MODULES.md.
 */
export function buildMeshObjectGeometry(obj, model, opts) {
    var o = opts || {};
    var scale = (typeof o.scale === 'number' && o.scale > 0) ? o.scale : 1;
    var frame = o.frame || null;

    var empty = {
        vertices: new Float64Array(0),
        vertexNodeIds: [],
        faces: [],
        facePlaneIds: [],
        faceNormals: new Float64Array(0),
        triangles: new Uint32Array(0),
        connectivity: {
            vertices: 0, faces: 0,
            shells: 0, edgeCount: 0, nakedEdges: 0, nonManifoldEdges: 0,
            isClosed: false, isOriented: true, nonManifoldFaces: 0,
            degenerateFaces: 0, stalledFaces: 0, danglingPlaneIds: [],
            coincident: [], coincidentEps: 0, volume: 0,
        },
    };
    if (!obj || !model || !model.pool) return empty;

    var planes = obj.resolvePlanes(model);
    var dangling = [];
    for (var di = 0; di < obj.planeIds.length; di++) {
        if (!model.getPlane(obj.planeIds[di])) dangling.push(obj.planeIds[di]);
    }
    if (!planes.length) {
        empty.connectivity.danglingPlaneIds = dangling;
        return empty;
    }

    // --- Rings, and the welded vertex set they imply -------------------------
    // First appearance order, so a project that has not changed exports the same
    // vertex order twice running.
    var vertexNodeIds = [];
    var indexOfNode = new Map();
    var faces = [], facePlaneIds = [];
    var degenerate = 0;

    for (var p = 0; p < planes.length; p++) {
        var ringIds = faceRingNodeIds(planes[p], model.pool);
        if (ringIds.length < 3) { degenerate++; continue; }
        var ring = [];
        for (var r = 0; r < ringIds.length; r++) {
            var id = ringIds[r];
            var vi = indexOfNode.get(id);
            if (vi === undefined) {
                vi = vertexNodeIds.length;
                indexOfNode.set(id, vi);
                vertexNodeIds.push(id);
            }
            // A ring listing the same node twice would make a zero-length edge.
            if (ring.length && ring[ring.length - 1] === vi) continue;
            ring.push(vi);
        }
        while (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop();
        if (ring.length < 3) { degenerate++; continue; }
        faces.push(ring);
        facePlaneIds.push(planes[p].id);
    }

    if (!faces.length) {
        empty.connectivity.degenerateFaces = degenerate;
        empty.connectivity.danglingPlaneIds = dangling;
        return empty;
    }

    // --- Vertices, in the requested frame and units --------------------------
    var V = vertexNodeIds.length;
    var vertices = new Float64Array(V * 3);
    for (var v = 0; v < V; v++) {
        var node = model.pool.getNode(vertexNodeIds[v]);
        var q = [node.xyz[0], node.xyz[1], node.xyz[2]];
        if (frame) q = applyOriginFrame(frame, q);
        vertices[v * 3] = q[0] * scale;
        vertices[v * 3 + 1] = q[1] * scale;
        vertices[v * 3 + 2] = q[2] * scale;
    }

    // --- Connectivity, then coherent winding --------------------------------
    var edges = faceAdjacency(faces);
    var topo = meshConnectivity(faces, edges);
    var oriented = orientFacesCoherently(faces, edges);

    // --- Triangulate, and take the global orientation decision ---------------
    var built = triangulateFaces(faces, vertices);
    var volume = topo.isClosed ? signedVolume(vertices, built.triangles) : 0;

    // Two INDEPENDENT decisions, applied in this order. Folding them into one
    // `||` looks equivalent and is not: when a mesh needs the canonical flip AND
    // the user has set `flipNormals`, both conditions are true, they collapse to
    // a SINGLE reversal, and the toggle silently does nothing. Whether that
    // happens depends on the arbitrary order the rings arrived in, so it shows up
    // for some projects and not others.
    //
    //   1. Canonical. A closed mesh with inward normals is unambiguously wrong,
    //      so it is corrected here rather than left for the user to notice.
    //   2. The user's override, applied ON TOP of the canonical result, so the
    //      toggle always means "the opposite of whatever the default was".
    var canonicalFlip = topo.isClosed && volume < 0;
    var reversals = (canonicalFlip ? 1 : 0) + (obj.flipNormals ? 1 : 0);
    if (reversals % 2 === 1) {
        for (var f = 0; f < faces.length; f++) faces[f].reverse();
        built = triangulateFaces(faces, vertices);
        volume = topo.isClosed ? signedVolume(vertices, built.triangles) : 0;
    }

    var coincident = coincidentNodeReport(vertexNodeIds, vertices, o.eps);

    return {
        vertices: vertices,
        vertexNodeIds: vertexNodeIds,
        faces: faces,
        facePlaneIds: facePlaneIds,
        faceNormals: built.normals,
        triangles: built.triangles,
        connectivity: {
            vertices: V,
            faces: faces.length,
            shells: oriented.shells,
            edgeCount: topo.edgeCount,
            nakedEdges: topo.nakedEdges,
            nonManifoldEdges: topo.nonManifoldEdges,
            isClosed: topo.isClosed,
            // Orientation is only trustworthy when every edge had at most two
            // faces; past that, "the other face" is not well defined.
            isOriented: oriented.ambiguous === 0,
            nonManifoldFaces: oriented.ambiguous,
            degenerateFaces: degenerate,
            stalledFaces: built.stalled,
            danglingPlaneIds: dangling,
            coincident: coincident.pairs,
            coincidentEps: coincident.eps,
            volume: volume,
        },
    };
}

/**
 * Ear-clip every face and collect its normal. @private
 * @param {number[][]} faces @param {Float64Array} vertices
 * @returns {{triangles:Uint32Array, normals:Float64Array, stalled:number}}
 */
function triangulateFaces(faces, vertices) {
    var tris = [];
    var normals = new Float64Array(faces.length * 3);
    var stalled = 0;
    for (var f = 0; f < faces.length; f++) {
        var res = earClipFace(faces[f], vertices);
        if (res.stalled) stalled++;
        if (res.normal) {
            normals[f * 3] = res.normal[0];
            normals[f * 3 + 1] = res.normal[1];
            normals[f * 3 + 2] = res.normal[2];
        }
        for (var t = 0; t < res.triangles.length; t++) {
            tris.push(res.triangles[t][0], res.triangles[t][1], res.triangles[t][2]);
        }
    }
    return { triangles: Uint32Array.from(tris), normals: normals, stalled: stalled };
}

/**
 * A one-line summary of an object's connectivity, for the table's badge.
 * @param {Object} connectivity - From `buildMeshObjectGeometry`.
 * @returns {{text:string, level:'ok'|'warn'|'error'}}
 */
export function connectivitySummary(connectivity) {
    var c = connectivity;
    if (!c || !c.edgeCount) return { text: 'empty', level: 'warn' };
    if (c.nonManifoldEdges) {
        return { text: c.nonManifoldEdges + ' non-manifold', level: 'error' };
    }
    if (c.shells > 1) return { text: c.shells + ' shells', level: 'warn' };
    if (c.isClosed) return { text: 'closed', level: 'ok' };
    return { text: 'open — ' + c.nakedEdges + ' naked', level: 'warn' };
}
