/**
 * test-mesh-object-geometry.mjs — deriving a mesh from how planes are connected.
 *
 * A 3D Mesh Object stores nothing geometric: it is a name and a list of plane
 * IDs, and its SHAPE is recomputed from the pool every time anyone asks. So
 * every way that derivation can be wrong is a way the exported cage is wrong,
 * and none of them show up as a crash:
 *
 *   - a shared corner failing to weld gives 24 vertices instead of 8 and a cage
 *     that arrives in Blender as loose, unconnected faces;
 *   - inconsistent winding gives black patches and failed boolean ops, and is
 *     invisible in a translucent viewport fill drawn `DoubleSide`;
 *   - a fan triangulation of a concave face silently covers area outside the
 *     polygon;
 *   - inward normals on a closed mesh invert "inside" for every downstream tool.
 *
 * Each of those is pinned here with an exact number, at the model level, with
 * the negative control stated where one exists.
 *
 * ESM, so `tests/run-mjs-tests.mjs` picks it up automatically. The modules
 * under test are DOM-free and THREE-free by design, so they import with no
 * stubs.
 */

import { PlaneModel } from '../pose/plane-data.js';
import { MeshObjectSet } from '../pose/mesh-object-3d.js';
import { buildOriginFrame } from '../pose/origin-frame.js';
import {
    buildMeshObjectGeometry, faceRingNodeIds, faceAdjacency,
    orientFacesCoherently, meshConnectivity, signedVolume, earClip2d, earClipFace,
    coincidentNodeReport, newellNormal, connectivitySummary,
} from '../pose/mesh-object-geometry.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol);

/**
 * Is every shared edge traversed in OPPOSITE directions by its two faces?
 *
 * The definition of a coherently oriented mesh, checked directly. Used instead
 * of a volume comparison for the negative control, because signed volume is
 * computed about the world ORIGIN and any face passing through the origin
 * contributes exactly zero however it is wound — a unit cube at [0,1]^3 has
 * three such faces, so its volume comes out +1 even when half its rings are
 * backwards. That is precisely the trap this helper avoids.
 */
function isCoherent(faces) {
    let ok = true;
    faceAdjacency(faces).forEach((list) => {
        if (list.length !== 2) return;
        const [r1, r2] = [faces[list[0]], faces[list[1]]];
        let opposite = false;
        for (let i = 0; i < r1.length; i++) {
            const u = r1[i], v = r1[(i + 1) % r1.length];
            for (let j = 0; j < r2.length; j++) {
                if (r2[j] === v && r2[(j + 1) % r2.length] === u) opposite = true;
            }
        }
        if (!opposite) ok = false;
    });
    return ok;
}

/** Build a model + object from corner positions and face rings of corner indices. */
function buildFrom(corners, faceRings, opts) {
    const model = new PlaneModel();
    const nodeIds = corners.map((p, i) => {
        const n = model.addNode('c' + i);
        if (p) n.setPoint3d(p);
        return n.id;
    });
    faceRings.forEach((ring, k) => {
        const plane = model.createPlane('f' + k);
        ring.forEach((c) => model.addNodeToPlane(plane, nodeIds[c]));
        // Explicit edges make the ring the USER'S cycle, so `planeCycleOrderIds`
        // returns it verbatim and the test controls the winding exactly.
        for (let i = 0; i < ring.length; i++) {
            plane.addEdge(nodeIds[ring[i]], nodeIds[ring[(i + 1) % ring.length]]);
        }
    });
    const set = new MeshObjectSet();
    const obj = set.createObject('o');
    model.planes.forEach((p) => obj.addPlane(p.id));
    if (opts && opts.flipNormals) obj.flipNormals = true;
    return { model, obj, nodeIds };
}

const CUBE_CORNERS = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
// DELIBERATELY inconsistent: some rings wind one way, some the other. This is
// what the annotation actually produces, because a plane's ring is seeded by a
// PCA eigenvector whose sign is arbitrary.
const CUBE_FACES = [
    [0, 1, 2, 3],   // bottom
    [4, 5, 6, 7],   // top
    [0, 1, 5, 4],   // front
    [2, 3, 7, 6],   // back
    [1, 2, 6, 5],   // right
    [3, 0, 4, 7],   // left
];

// ============================================
console.log('\n--- 1. A closed cube welds, closes and orients outward ---');
// ============================================
{
    const { model, obj } = buildFrom(CUBE_CORNERS, CUBE_FACES);
    const g = buildMeshObjectGeometry(obj, model);

    // THE weld assertion. 6 faces x 4 corners = 24 if nothing is shared; 8 is
    // the whole point of the global node pool.
    check(g.vertices.length / 3 === 8, 'eight vertices, not twenty-four — shared nodes weld');
    check(g.vertexNodeIds.length === 8, 'and one node id per vertex');
    check(g.faces.length === 6, 'six faces');
    check(g.triangles.length / 3 === 12, 'twelve triangles');
    check(g.connectivity.edgeCount === 12, 'twelve edges (Euler: 8 - 12 + 6 = 2)');
    check(g.connectivity.nakedEdges === 0, 'no naked edges');
    check(g.connectivity.nonManifoldEdges === 0, 'no non-manifold edges');
    check(g.connectivity.isClosed === true, 'the object is closed');
    check(g.connectivity.isOriented === true, 'and unambiguously orientable');
    check(g.connectivity.shells === 1, 'one shell');
    check(near(g.connectivity.volume, 1, 1e-9), 'signed volume is +1 — normals point OUT');

    // Every face normal must point away from the centre.
    let outward = 0;
    for (let f = 0; f < g.faces.length; f++) {
        const v0 = g.faces[f][0] * 3;
        const d = (g.vertices[v0] - 0.5) * g.faceNormals[f * 3]
                + (g.vertices[v0 + 1] - 0.5) * g.faceNormals[f * 3 + 1]
                + (g.vertices[v0 + 2] - 0.5) * g.faceNormals[f * 3 + 2];
        if (d > 0) outward++;
    }
    check(outward === 6, 'all six face normals point outward');

    // NEGATIVE CONTROL. Without this the assertions above could be asserting a
    // property the input already had. The raw rings are NOT coherent, the
    // oriented ones are, and the pass really did reverse faces to get there.
    check(isCoherent(CUBE_FACES) === false,
        'NEGATIVE CONTROL: the raw input rings are NOT coherently wound');
    check(isCoherent(g.faces) === true, 'and the built faces ARE');

    const copy = CUBE_FACES.map((r) => r.slice());
    const res = orientFacesCoherently(copy);
    check(res.flipped > 0, 'orientFacesCoherently actually reversed some faces');
    check(res.shells === 1 && res.ambiguous === 0, 'one shell, nothing ambiguous');
    check(isCoherent(copy) === true, 'and its output is coherent');

    // The volume test alone would NOT have caught an incoherent cube here: a
    // unit cube at the origin has three faces through the origin, whose
    // tetrahedra are degenerate and contribute 0 whichever way they are wound.
    const rawTris = [];
    for (const ring of CUBE_FACES) {
        for (let i = 1; i < ring.length - 1; i++) rawTris.push(ring[0], ring[i], ring[i + 1]);
    }
    check(near(signedVolume(new Float64Array(CUBE_CORNERS.flat()), rawTris), 1, 1e-9),
        'documenting the trap: the un-oriented cube still measures +1 about the origin');
    // Translated CLEAR of every face's plane, the same incoherent rings measure
    // something else entirely — which is why the coherence check above, and not
    // this one, is the real control. The offset needs a non-zero component on
    // every axis: the one backwards face here is the z=0 bottom, so a shift that
    // leaves it in the z=0 plane still cancels and still reads +1.
    const moved = new Float64Array(
        CUBE_CORNERS.flatMap((p) => [p[0] + 3, p[1] + 5, p[2] + 9])
    );
    check(!near(signedVolume(moved, rawTris), 1, 1e-6),
        'and off every face plane it does not — those rings were never coherent');
}

// ============================================
console.log('\n--- 2. flipNormals inverts a closed object ---');
// ============================================
{
    const { model, obj } = buildFrom(CUBE_CORNERS, CUBE_FACES, { flipNormals: true });
    const g = buildMeshObjectGeometry(obj, model);
    check(near(g.connectivity.volume, -1, 1e-9), 'volume is −1 with flipNormals set');
    check(g.connectivity.isClosed === true, 'still closed — flipping is not a topology change');

    const plain = buildMeshObjectGeometry(
        buildFrom(CUBE_CORNERS, CUBE_FACES).obj,
        buildFrom(CUBE_CORNERS, CUBE_FACES).model
    );
    check(plain.faces.length === g.faces.length, 'same face count either way');

    // THE invariant, and the regression this section exists for. The seed face
    // of the coherence walk keeps whatever winding it came in with, so whether
    // the canonical pass has to flip the whole mesh depends on the ARBITRARY
    // order the rings happened to arrive in. The result must not: the output
    // sign has to depend on `flipNormals` and nothing else.
    //
    // Reversing every input ring is what flips which side of that branch is
    // taken, so these four builds cover both. The bug this catches folded the
    // canonical correction and the user's toggle into one `||`, which collapses
    // to a single reversal when both fire — and `flipNormals` silently did
    // nothing for exactly the inputs that needed the canonical flip.
    const REVERSED = CUBE_FACES.map((r) => r.slice().reverse());
    for (const [label, rings] of [['as given', CUBE_FACES], ['all reversed', REVERSED]]) {
        const off = buildFrom(CUBE_CORNERS, rings);
        const on = buildFrom(CUBE_CORNERS, rings, { flipNormals: true });
        const vOff = buildMeshObjectGeometry(off.obj, off.model).connectivity.volume;
        const vOn = buildMeshObjectGeometry(on.obj, on.model).connectivity.volume;
        check(near(vOff, 1, 1e-9), 'rings ' + label + ': default is +1 (outward)');
        check(near(vOn, -1, 1e-9), 'rings ' + label + ': flipNormals is −1 (inward)');
    }
}

// ============================================
console.log('\n--- 3. An OPEN cage: floor + two walls, as annotated in the app ---');
// ============================================
{
    // Floor z=0, back wall y=1, side wall x=0 — three planes meeting along two
    // shared edges, which is the screenshot that prompted this feature.
    const corners = [
        [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],   // 0-3 floor
        [0, 1, 1], [1, 1, 1],                          // 4,5 top of back wall
        [0, 0, 1],                                     // 6   top of side wall
    ];
    const faces = [
        [0, 1, 2, 3],   // floor
        [3, 2, 5, 4],   // back wall  (shares edge 3-2 with the floor)
        [0, 3, 4, 6],   // side wall  (shares edge 0-3 with the floor)
    ];
    const { model, obj } = buildFrom(corners, faces);
    const g = buildMeshObjectGeometry(obj, model);

    check(g.vertices.length / 3 === 7, 'seven vertices — the two shared edges welded');
    check(g.faces.length === 3, 'three faces');
    check(g.connectivity.shells === 1, 'ONE shell: the three planes are joined');
    check(g.connectivity.isClosed === false, 'not closed — a cage with no lid');
    // 3 faces x 4 edges = 12 directed. THREE are shared, not two: the floor
    // meets each wall, and the two walls also meet each other along the vertical
    // corner. So 12 - 3 = 9 distinct edges, of which 9 - 3 = 6 are naked.
    check(g.connectivity.edgeCount === 9, 'nine distinct edges');
    check(g.connectivity.nakedEdges === 6, 'six naked edges');
    check(g.connectivity.volume === 0, 'volume is not reported for an open object');

    // Coherent orientation still applies, and is checkable: two faces sharing an
    // edge must traverse it in opposite directions.
    const adj = faceAdjacency(g.faces);
    let shared = 0, consistent = 0;
    adj.forEach((list) => {
        if (list.length !== 2) return;
        shared++;
        const [f1, f2] = list;
        const r1 = g.faces[f1], r2 = g.faces[f2];
        let opposite = false;
        for (let i = 0; i < r1.length; i++) {
            const u = r1[i], v = r1[(i + 1) % r1.length];
            for (let j = 0; j < r2.length; j++) {
                if (r2[j] === v && r2[(j + 1) % r2.length] === u) opposite = true;
            }
        }
        if (opposite) consistent++;
    });
    check(shared === 3, 'three edges are shared between faces');
    check(consistent === 3, 'and all three are traversed in OPPOSITE directions — coherent');
    check(isCoherent(g.faces) === true, 'so the open cage is coherently oriented too');

    const summary = connectivitySummary(g.connectivity);
    check(summary.level === 'warn' && /open/.test(summary.text),
        'the badge reads open, at warn level');

    // flipNormals is the user's only lever on an open object, so it must work.
    obj.flipNormals = true;
    const flipped = buildMeshObjectGeometry(obj, model);
    let inverted = 0;
    for (let i = 0; i < g.faceNormals.length; i++) {
        if (near(flipped.faceNormals[i], -g.faceNormals[i], 1e-9)) inverted++;
    }
    check(inverted === g.faceNormals.length, 'flipNormals inverts every face normal');
}

// ============================================
console.log('\n--- 4. Shells: planes that share no node are not one object ---');
// ============================================
{
    const corners = [
        [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
        [0, 0, 5], [1, 0, 5], [1, 1, 5], [0, 1, 5],
    ];
    const { model, obj } = buildFrom(corners, [[0, 1, 2, 3], [4, 5, 6, 7]]);
    const g = buildMeshObjectGeometry(obj, model);
    check(g.connectivity.shells === 2, 'two disjoint planes report two shells');
    check(g.vertices.length / 3 === 8, 'and nothing was welded');
    check(connectivitySummary(g.connectivity).text === '2 shells', 'the badge says so');
}

// ============================================
console.log('\n--- 5. Ear clipping vs the fan it replaces ---');
// ============================================
{
    // A U: the outer 3x3 square minus a 1x2 notch. Area 7.
    const U = [[0, 0], [3, 0], [3, 3], [2, 3], [2, 1], [1, 1], [1, 3], [0, 3]];
    const area2 = (P, t) => Math.abs(
        (P[t[1]][0] - P[t[0]][0]) * (P[t[2]][1] - P[t[0]][1]) -
        (P[t[2]][0] - P[t[0]][0]) * (P[t[1]][1] - P[t[0]][1])
    ) / 2;

    const clip = earClip2d(U);
    check(clip.stalled === false, 'the U-shape clips without stalling');
    check(clip.triangles.length === 6, 'n-2 = 6 triangles');
    check(near(clip.triangles.reduce((s, t) => s + area2(U, t), 0), 7, 1e-9),
        'ear-clipped area is exactly the polygon area (7)');

    // NEGATIVE CONTROL: the fan the viewport's overlay uses covers 11 — it spans
    // the notch. That is fine for a translucent fill and wrong for geometry.
    const fan = [];
    for (let i = 1; i < U.length - 1; i++) fan.push([0, i, i + 1]);
    check(near(fan.reduce((s, t) => s + area2(U, t), 0), 11, 1e-9),
        'NEGATIVE CONTROL: a fan over the same ring covers 11, not 7');

    // An L-shape is the degenerate case: its reflex corner lands exactly ON the
    // first candidate ear's diagonal, so a STRICT point-in-triangle test lets a
    // triangle through that pokes outside the polygon.
    const L = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
    const lc = earClip2d(L);
    check(near(lc.triangles.reduce((s, t) => s + area2(L, t), 0), 3, 1e-9),
        'an L-shape clips to exactly its area (3) — the on-edge vertex blocks the ear');

    // Clockwise input must give the same tessellation.
    const LCW = L.slice().reverse();
    const cw = earClip2d(LCW);
    check(near(cw.triangles.reduce((s, t) => s + area2(LCW, t), 0), 3, 1e-9),
        'and so does the same ring wound clockwise');

    // In 3D, on a tilted plane, through the face path.
    const tilted = new Float64Array(L.flatMap(([x, y]) => [x, y, 0.5 * x]));
    const face = earClipFace([0, 1, 2, 3, 4, 5], tilted);
    const a3 = face.triangles.reduce((s, t) => {
        const p = (i) => [tilted[i * 3], tilted[i * 3 + 1], tilted[i * 3 + 2]];
        const [A, B, C] = [p(t[0]), p(t[1]), p(t[2])];
        const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
        const v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        return s + Math.hypot(c[0], c[1], c[2]) / 2;
    }, 0);
    check(near(a3, 3 * Math.sqrt(1.25), 1e-9),
        'the same L on a tilted plane clips to its true 3D area');
    check(near(Math.hypot(...face.normal), 1, 1e-12), 'and the face normal is unit length');
}

// ============================================
console.log('\n--- 6. Newell normal follows the winding ---');
// ============================================
{
    const square = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const n = newellNormal(square);
    check(near(n[0], 0) && near(n[1], 0) && n[2] > 0, 'CCW about +Z gives +Z');
    const rev = newellNormal(square.slice().reverse());
    check(rev[2] < 0, 'reversing the ring reverses the normal');
    // Non-planar rings are the real case; Newell must not blow up on one.
    const warped = [[0, 0, 0], [1, 0, 0.1], [1, 1, 0], [0, 1, -0.1]];
    check(newellNormal(warped).every(Number.isFinite), 'a non-planar ring still gives a finite normal');
}

// ============================================
console.log('\n--- 7. Coincident but unshared nodes are reported, never merged ---');
// ============================================
{
    // Two planes that LOOK joined along an edge but whose corners are separate
    // nodes a hair apart. Topologically open; visually identical to a real join.
    const corners = [
        [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
        [0, 1 + 1e-9, 0], [1, 1 + 1e-9, 0], [1, 2, 0], [0, 2, 0],
    ];
    const { model, obj } = buildFrom(corners, [[0, 1, 2, 3], [4, 5, 6, 7]]);
    const g = buildMeshObjectGeometry(obj, model);

    check(g.connectivity.shells === 2, 'they are NOT joined — two shells');
    check(g.vertices.length / 3 === 8, 'and nothing was silently merged');
    check(g.connectivity.coincident.length === 2,
        'two coincident node pairs are reported');
    const pair = g.connectivity.coincident[0];
    check(pair.a !== pair.b && pair.distance < 1e-6, 'each names two DIFFERENT nodes, near-zero apart');

    // The pool is untouched: reporting must not have side effects.
    check(model.pool.size === 8, 'the pool still holds all eight nodes');

    // A genuinely joined cage reports nothing.
    const joined = buildFrom(
        [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [1, 2, 0], [0, 2, 0]],
        [[0, 1, 2, 3], [3, 2, 4, 5]]
    );
    const gj = buildMeshObjectGeometry(joined.obj, joined.model);
    check(gj.connectivity.coincident.length === 0, 'a properly joined pair reports none');
    check(gj.connectivity.shells === 1, 'and is one shell');

    // Explicit eps, so a caller can widen the search.
    const rep = coincidentNodeReport([1, 2], new Float64Array([0, 0, 0, 0.5, 0, 0]), 1);
    check(rep.pairs.length === 1 && near(rep.pairs[0].distance, 0.5), 'an explicit eps is honoured');
}

// ============================================
console.log('\n--- 8. The origin frame and the units scale ---');
// ============================================
{
    const { model, obj, nodeIds } = buildFrom(CUBE_CORNERS, CUBE_FACES);
    // Origin at corner 6 = [1,1,1], +Z along world +Z.
    const frame = buildOriginFrame([1, 1, 1], [0, 0, 1]);
    const g = buildMeshObjectGeometry(obj, model, { frame: frame });

    const vi = g.vertexNodeIds.indexOf(nodeIds[6]);
    check(vi >= 0, 'the origin node is in the vertex set');
    check(near(g.vertices[vi * 3], 0, 1e-9) &&
          near(g.vertices[vi * 3 + 1], 0, 1e-9) &&
          near(g.vertices[vi * 3 + 2], 0, 1e-9),
        'with a frame applied, the origin node lands exactly at [0,0,0]');
    check(near(Math.abs(g.connectivity.volume), 1, 1e-9),
        'a rigid frame does not change the enclosed volume');

    const scaled = buildMeshObjectGeometry(obj, model, { scale: 0.001 });
    const plain = buildMeshObjectGeometry(obj, model);
    let allScaled = true;
    for (let i = 0; i < plain.vertices.length; i++) {
        if (!near(scaled.vertices[i], plain.vertices[i] * 0.001, 1e-12)) allScaled = false;
    }
    check(allScaled, 'scale 0.001 divides every coordinate by 1000');
    check(near(scaled.connectivity.volume, 1e-9, 1e-18), 'and cubes the volume');

    // A non-positive scale would MIRROR the mesh and invert every normal, so it
    // is refused rather than honoured.
    const bad = buildMeshObjectGeometry(obj, model, { scale: -2 });
    check(near(bad.connectivity.volume, 1, 1e-9), 'a negative scale is ignored, not applied');
}

// ============================================
console.log('\n--- 9. Rings come from the user cycle, else the hull ---');
// ============================================
{
    const model = new PlaneModel();
    const pts = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0], [1, 1, 0]];
    const ids = pts.map((p, i) => { const n = model.addNode('n' + i); n.setPoint3d(p); return n.id; });
    const plane = model.createPlane('p');
    ids.forEach((id) => model.addNodeToPlane(plane, id));

    // No edges: the hull is used, and the INTERIOR node is excluded from it.
    const hullRing = faceRingNodeIds(plane, model.pool);
    check(hullRing.length === 4, 'with no user edges the hull gives four corners');
    check(hullRing.indexOf(ids[4]) < 0, 'and drops the interior node');

    // With a user cycle, the cycle wins verbatim — including that interior node.
    const order = [0, 1, 4, 2, 3];
    for (let i = 0; i < order.length; i++) {
        plane.addEdge(ids[order[i]], ids[order[(i + 1) % order.length]]);
    }
    const cycleRing = faceRingNodeIds(plane, model.pool);
    check(cycleRing.length === 5, 'with a user cycle all five are in the ring');
    check(cycleRing.indexOf(ids[4]) >= 0, 'including the interior one — their edges are honoured');

    // An untriangulated corner has no position, so it cannot be a vertex.
    const ghost = model.addNode('ghost');
    model.addNodeToPlane(plane, ghost.id);
    check(faceRingNodeIds(plane, model.pool).indexOf(ghost.id) < 0,
        'a node with no 3D is dropped from the ring');
}

// ============================================
console.log('\n--- 10. Degenerate and empty inputs do not throw ---');
// ============================================
{
    check(buildMeshObjectGeometry(null, null).faces.length === 0, 'null object gives an empty mesh');

    const model = new PlaneModel();
    const set = new MeshObjectSet();
    const empty = set.createObject('empty');
    const g0 = buildMeshObjectGeometry(empty, model);
    check(g0.vertices.length === 0 && g0.connectivity.isClosed === false,
        'an object with no planes gives an empty, non-closed mesh');

    // A plane with two positioned nodes cannot be a face.
    const n0 = model.addNode('a'); n0.setPoint3d([0, 0, 0]);
    const n1 = model.addNode('b'); n1.setPoint3d([1, 0, 0]);
    const p = model.createPlane('line');
    model.addNodeToPlane(p, n0.id);
    model.addNodeToPlane(p, n1.id);
    empty.addPlane(p.id);
    const g1 = buildMeshObjectGeometry(empty, model);
    check(g1.faces.length === 0, 'a two-node plane contributes no face');
    check(g1.connectivity.degenerateFaces === 1, 'and is counted as degenerate');

    check(earClip2d([[0, 0], [1, 0]]).triangles.length === 0, 'a two-point ring clips to nothing');
    check(meshConnectivity([]).isClosed === false, 'no faces is not "closed"');
    check(orientFacesCoherently([]).shells === 0, 'and has no shells');
}

// ============================================
console.log('\n--- 11. Deleting a member plane changes nothing but the face count ---');
// ============================================
{
    const { model, obj } = buildFrom(CUBE_CORNERS, CUBE_FACES);
    const before = buildMeshObjectGeometry(obj, model);
    check(before.faces.length === 6 && before.connectivity.isClosed, 'the cube starts closed');

    const doomed = model.planes[1];
    const poolBefore = model.pool.size;
    model.deletePlane(doomed);

    // The object still names it — membership is resolved lazily, so there is no
    // cascade for `deletePlane` to have to perform.
    check(obj.planeIds.length === 6, 'the object still lists six plane ids');
    check(obj.planeCount(model) === 5, 'but only five resolve');
    check(obj.danglingCount(model) === 1, 'and one is reported dangling');

    const after = buildMeshObjectGeometry(obj, model);
    check(after.faces.length === 5, 'the mesh has five faces');
    check(after.connectivity.isClosed === false, 'and is no longer closed');
    check(after.connectivity.danglingPlaneIds.length === 1, 'the geometry reports the dangling id');
    check(model.pool.size === poolBefore, 'deleting a plane did not touch the node pool');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
