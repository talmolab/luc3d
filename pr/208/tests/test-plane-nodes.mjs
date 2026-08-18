/**
 * test-plane-nodes.mjs — the plane-independent node model, tested away from the UI.
 *
 * `pose/plane-nodes.js` + `pose/plane-data.js` moved plane nodes OUT of the
 * planes and into one global pool, so that two planes can meet along a shared
 * line: the corners on that line are ONE node with ONE 3D position. Almost
 * every failure mode of that design is an aliasing or index-shifting bug that
 * an e2e run would only surface a step later, once the wrong state had already
 * been drawn or saved — a shared corner quietly splitting into two, an edge
 * re-pointing at its neighbour after a delete, a pinned coordinate evaporating
 * because an unrelated plane was invalidated. So they are pinned here, at the
 * model level, where the assertion can be exact.
 *
 * ESM, so `tests/run-mjs-tests.mjs` picks it up automatically. The modules are
 * DOM-free by design, so they import directly with no stubs.
 */

import {
    PlaneModel, PlaneSkeleton, PlaneInstance, PlaneNodePool,
    points3dForPlane, writePoints3dForPlane, nodeErrorsForPlane,
    planePolygonOrder, planePolygonOrderIds, planePolygonOrderPoolIndices,
    planeCycleOrderIds, convexHullOrder2d, convexHullOrder3d,
    planeFillOrderPoolIndices, planeFillOrder3d,
    planeEdgesLocal, planeEdgesPoolIndices, planeNodeIndices, planeNodeNames,
    planeCentroid2d, seedPlanePoints, nodeFreezeState, defaultNodeColor,
} from '../pose/plane-data.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol);

/**
 * Two planes sharing an EDGE (two nodes), each with two nodes of its own —
 * the geometry the whole refactor exists for. Returns the model plus handles.
 *
 *   A: a0  s0  s1  a1      B: b0  s0  s1  b1
 *              \__/  the shared pair
 */
function twoPlanesSharingAnEdge() {
    const m = new PlaneModel();
    const s0 = m.addNode('shared0');
    const s1 = m.addNode('shared1');
    const a0 = m.addNode('a0');
    const a1 = m.addNode('a1');
    const b0 = m.addNode('b0');
    const b1 = m.addNode('b1');

    const A = m.createPlane('A');
    const B = m.createPlane('B');
    [a0, s0, s1, a1].forEach(n => m.addNodeToPlane(A, n.id));
    [b0, s0, s1, b1].forEach(n => m.addNodeToPlane(B, n.id));
    // Close each as a quad so the polygon walk has something to find.
    A.addEdge(a0.id, s0.id); A.addEdge(s0.id, s1.id);
    A.addEdge(s1.id, a1.id); A.addEdge(a1.id, a0.id);
    B.addEdge(b0.id, s0.id); B.addEdge(s0.id, s1.id);
    B.addEdge(s1.id, b1.id); B.addEdge(b1.id, b0.id);
    return { m, A, B, s0, s1, a0, a1, b0, b1 };
}

console.log('\n1. A node shared by two planes is ONE node with ONE 3D point');
{
    const { m, A, B, s0, s1 } = twoPlanesSharingAnEdge();
    check(A.size === 4 && B.size === 4, 'both planes reference four nodes');
    check(m.pool.size === 6, 'the pool holds six nodes, not eight (the pair is shared)');
    check(m.planesForNode(s0.id).length === 2, 'the shared node reports both planes');

    m.pool.setPoint3d(s0.id, [1, 2, 3]);
    m.pool.setPoint3d(s1.id, [4, 5, 6]);

    const pa = points3dForPlane(A, m.pool);
    const pb = points3dForPlane(B, m.pool);
    // s0 is A's index 1 and B's index 1; s1 is index 2 in both.
    check(eq([pa[3], pa[4], pa[5]], [1, 2, 3]), 'plane A sees the shared point at its own index');
    check(eq([pb[3], pb[4], pb[5]], [1, 2, 3]), 'plane B sees the SAME shared point');
    check(Number.isNaN(pa[0]), 'an untriangulated node is an all-NaN triple');
    check(Number.isNaN(pa[1]) && Number.isNaN(pa[2]), '…all three coords, not just x');

    // The killer case: re-solving one plane cannot move the other's copy,
    // because there is no other copy.
    writePoints3dForPlane(A, m.pool, new Float64Array([
        0, 0, 0, 9, 9, 9, 8, 8, 8, 0, 0, 0,
    ]));
    const pb2 = points3dForPlane(B, m.pool);
    check(eq([pb2[3], pb2[4], pb2[5]], [9, 9, 9]),
        'writing plane A moves the shared point for plane B too — one point, one value');
    check(m.pool.getPoint3d(s1.id).every((v, i) => v === [8, 8, 8][i]),
        'the second shared node follows as well');
}

console.log('\n2. Deleting a shared node cleans up BOTH planes');
{
    const { m, A, B, s0, s1, a0 } = twoPlanesSharingAnEdge();
    const before = { a: A.edges.length, b: B.edges.length };
    check(before.a === 4 && before.b === 4, 'each plane starts with four edges');

    check(m.deleteNode(s0.id) === true, 'the shared node is deleted');
    check(!A.hasNode(s0.id) && !B.hasNode(s0.id), 'neither plane still references it');
    check(A.size === 3 && B.size === 3, 'both memberships shrank by exactly one');
    check(A.edges.length === 2 && B.edges.length === 2,
        'the two edges through it are gone from EACH plane');
    check(A.edges.every(e => e[0] !== s0.id && e[1] !== s0.id),
        'no dangling edge names the deleted node');
    check(m.pool.getNode(s0.id) === null, 'the pool no longer holds it');
    // The surviving edges must still name the nodes they always named, not
    // whatever slid into the vacated slot.
    check(A.hasEdge(s1.id, a0.id) === false && A.hasEdge(a0.id, m.pool.nodeAt(0).id) === false,
        'no edge was invented between the neighbours of the deleted node');
    check(m.planesForNode(s1.id).length === 2, 'the OTHER shared node is untouched');
}

console.log('\n3. Edges survive node deletion and reordering (they are ID pairs)');
{
    const m = new PlaneModel();
    const n = ['p0', 'p1', 'p2', 'p3'].map(name => m.addNode(name));
    const P = m.createPlane('quad');
    n.forEach(x => m.addNodeToPlane(P, x.id));
    P.addEdge(n[0].id, n[1].id);
    P.addEdge(n[2].id, n[3].id);

    // Delete a node that is in NO edge — with index pairs this is exactly the
    // case that silently re-points every later edge one slot down.
    const spare = m.addNode('spare');
    m.addNodeToPlane(P, spare.id);
    m.moveNode(m.pool.indexOf(spare.id), 0);   // …and put it FIRST, to shift everyone
    check(m.pool.nodeAt(0).id === spare.id, 'the spare node moved to pool index 0');
    m.deleteNode(spare.id);

    check(P.hasEdge(n[0].id, n[1].id) && P.hasEdge(n[2].id, n[3].id),
        'both edges still connect the same two node PAIRS after a delete+reorder');
    check(eq(planeEdgesLocal(P), [[0, 1], [2, 3]]),
        'local (plane-order) edge indices are re-derived correctly');
    check(eq(planeEdgesPoolIndices(P, m.pool), [[0, 1], [2, 3]]),
        'pool-index edges match too');

    // Reorder the PLANE's own order; edges must follow the nodes, not the slots.
    P.moveNode(0, 3);
    check(P.hasEdge(n[0].id, n[1].id), 'the edge survives a plane-order move');
    check(eq(planeEdgesLocal(P), [[3, 0], [1, 2]]),
        'and its local indices track the new order');
}

console.log('\n4. 2D regroups per VIEW: one instance covering the whole pool');
{
    const { m, A, B, s0 } = twoPlanesSharingAnEdge();
    const placed = m.placePlane(A, 'camA', 100, 100, 640, 480);
    check(placed.placed && placed.seeded.length === 4, 'placing A on camA seeds its four nodes');
    const inst = m.getInstance('camA');
    check(inst instanceof PlaneInstance, 'the view holds a PlaneInstance');
    check(inst.numNodes === m.pool.size,
        `the instance covers the whole pool (${inst.numNodes} of ${m.pool.size})`);
    check(inst.type === 'plane' && inst.trackIdx === null,
        'it is still an Instance in the pose sense — same drag path as a UserInstance');

    const idx = m.pool.indexOf(s0.id);
    const shared2d = [inst.getX(idx), inst.getY(idx)];
    // Placing B reuses the shared corner rather than re-seeding it: that is
    // what makes the intersection line one line in 2D as well as in 3D.
    const placedB = m.placePlane(B, 'camA', 300, 300, 640, 480);
    check(placedB.seeded.length === 2, 'placing B seeds only the two nodes B alone has');
    check(eq([inst.getX(idx), inst.getY(idx)], shared2d),
        'the shared corner keeps the position it already had');

    check(m.isNodeVisibleOn('camA', s0.id), 'a node of a placed plane is visible');
    check(eq(m.visibleNodeIndices('camA'), [0, 1, 2, 3, 4, 5]), 'all six nodes are visible now');
}

console.log('\n5. Un-placing keeps 2D; deleting the node destroys it');
{
    const { m, A, B, s0, a0 } = twoPlanesSharingAnEdge();
    m.placePlane(A, 'camA', 100, 100, 640, 480);
    m.placePlane(B, 'camA', 300, 300, 640, 480);
    const inst = m.getInstance('camA');
    const iA0 = m.pool.indexOf(a0.id);
    const before = [inst.getX(iA0), inst.getY(iA0)];

    check(m.unplacePlane(A, 'camA') === true, 'A is un-placed from camA');
    check(!m.isNodeVisibleOn('camA', a0.id), 'A-only nodes stop being visible');
    check(m.isNodeVisibleOn('camA', s0.id), 'the shared node stays visible via B');
    check(inst.hasPoint(iA0), 'but A-only 2D points are NOT destroyed');
    check(eq(m.visibleNodeIndices('camA'), [0, 1, 4, 5]),
        'visibility is derived from the placed set, not from which points exist');

    m.placePlane(A, 'camA', 999, 999, 640, 480);
    check(eq([inst.getX(iA0), inst.getY(iA0)], before),
        're-placing restores the user positions instead of a fresh ring');

    const nBefore = inst.numNodes;
    m.deleteNode(a0.id);
    check(inst.numNodes === nBefore - 1, 'deleting the node shrinks every view');
    check(m.pool.indexOf(a0.id) === -1, 'and the pool');
}

console.log('\n6. Nulled flags are per-(view, node) and survive the regrouping');
{
    const { m, A, B, s0, s1, a0 } = twoPlanesSharingAnEdge();
    m.placePlane(A, 'camA', 100, 100, 640, 480);
    m.placePlane(B, 'camA', 300, 300, 640, 480);
    m.placePlane(A, 'camB', 100, 100, 640, 480);
    const ia = m.getInstance('camA'), ib = m.getInstance('camB');

    ia.toggleNodeNull(m.pool.indexOf(s1.id));
    check(ia.isNodeNulled(m.pool.indexOf(s1.id)), 'the node is off on camA');
    check(!ib.isNodeNulled(m.pool.indexOf(s1.id)),
        'and still on in camB — the flag is per (view, node)');

    // Delete a node BELOW it in pool order: the flag must ride down with its
    // node, not stay on the slot number.
    m.deleteNode(s0.id);
    check(ia.isNodeNulled(m.pool.indexOf(s1.id)),
        'the flag follows its node through a delete-induced shift');
    check(ia.nulledNodes.size === 1, 'and no phantom flag was left behind');

    // …and through a reorder.
    const from = m.pool.indexOf(s1.id);
    m.moveNode(from, m.pool.size - 1);
    check(ia.isNodeNulled(m.pool.indexOf(s1.id)), 'the flag follows a reorder too');
    const ia0 = m.pool.indexOf(a0.id);
    check(!ia.isNodeNulled(ia0), 'no neighbour picked the flag up');
}

console.log('\n7. Immutability round-trips and nothing moves a pinned node');
{
    const m = new PlaneModel();
    const free = m.addNode('free');
    const pin = m.addNode('pinned', { immutable: true });
    const P = m.createPlane('P');
    m.addNodeToPlane(P, free.id);
    m.addNodeToPlane(P, pin.id);

    check(pin.immutable === true && free.immutable === false, 'the flag round-trips off the pool');
    check(m.pool.getNode(pin.id).immutable === true, 'and off a fresh lookup by id');
    check(nodeFreezeState(free) === 'mutable', 'an unpinned node is "mutable"');
    check(nodeFreezeState(pin) === 'frozen-unsolved',
        'pinned with no 3D is "frozen-unsolved" — a real dead end, named not hidden');

    check(m.pool.setPoint3d(pin.id, [1, 1, 1]) === false, 'a plain write to a pinned node is refused');
    check(m.pool.hasPoint3d(pin.id) === false, 'and left it with no 3D at all');
    check(m.pool.setPoint3d(pin.id, [1, 1, 1], { force: true }) === true,
        'an explicit force writes it (the user re-entering a known coordinate)');
    check(nodeFreezeState(pin) === 'frozen', 'now it reports "frozen"');

    m.pool.setPoint3d(free.id, [5, 5, 5]);
    const res = writePoints3dForPlane(P, m.pool, new Float64Array([7, 7, 7, 7, 7, 7]));
    check(res.written === 1 && eq(res.skippedIds, [pin.id]),
        'a solve writing the whole plane skips the pinned node and SAYS which');
    check(eq(m.pool.getPoint3d(pin.id), [1, 1, 1]), 'the pinned coordinate is untouched');
    check(eq(m.pool.getPoint3d(free.id), [7, 7, 7]), 'the free one moved');

    // Setting/clearing the flag must not invent or destroy geometry.
    m.pool.setImmutable(pin.id, false);
    check(eq(m.pool.getPoint3d(pin.id), [1, 1, 1]), 'un-pinning does not clear the 3D');
    m.pool.setImmutable(pin.id, true);
    check(eq(m.pool.getPoint3d(pin.id), [1, 1, 1]), 're-pinning does not fabricate or change one');
    check(eq(m.pool.mutableIds(), [free.id]), 'mutableIds names exactly what a solve may move');
}

console.log('\n8. clearTriangulation can never destroy a node\'s 3D');
{
    const { m, A, B, s0, a0 } = twoPlanesSharingAnEdge();
    m.pool.setPoint3d(s0.id, [1, 2, 3]);
    m.pool.setPoint3d(a0.id, [4, 5, 6]);
    A.planeFit = { centroid: [0, 0, 0], normal: [0, 0, 1], rms: 0.1, nPoints: 4 };
    A.triangulation = { views: ['camA', 'camB'], nNodes: 4, meanError: 0.5 };

    A.clearTriangulation();
    check(A.planeFit === null && A.triangulation === null, 'the plane-level solve is dropped');
    check(eq(m.pool.getPoint3d(s0.id), [1, 2, 3]),
        'the shared node keeps its 3D — a 2D drag on one plane cannot erase it');
    check(eq(m.pool.getPoint3d(a0.id), [4, 5, 6]), 'so does a node this plane alone uses');
    check(typeof PlaneSkeleton.prototype.clearTriangulation === 'function'
        && !('pool' in A), 'a plane holds no reference to the pool, so it CANNOT reach a node');
}

console.log('\n9. Invalidation is node-scoped and never splits a shared point');
{
    const { m, A, B, s0, a0, b0 } = twoPlanesSharingAnEdge();
    [s0, a0, b0].forEach(n => m.pool.setPoint3d(n.id, [1, 1, 1]));
    A.planeFit = { centroid: [0, 0, 0], normal: [0, 0, 1], rms: 0, nPoints: 4 };
    B.planeFit = { centroid: [0, 0, 0], normal: [0, 1, 0], rms: 0, nPoints: 4 };

    const out = m.invalidatePlane3D(A);
    check(out.clearedNodeIds.includes(a0.id), 'a node only plane A uses loses its 3D');
    check(out.keptSharedIds.includes(s0.id), 'the shared node is reported as KEPT');
    check(m.pool.hasPoint3d(s0.id),
        'and really keeps its 3D — clearing it would split the intersection line');
    check(m.pool.hasPoint3d(b0.id), 'plane B is untouched entirely');
    check(A.planeFit === null, "A's fit is dropped");
    check(B.planeFit !== null, "B's fit is NOT — different planes, different fits");

    // A pinned node is kept even when it is this plane's alone.
    m.pool.setPoint3d(a0.id, [2, 2, 2], { force: true });
    m.pool.setImmutable(a0.id, true);
    const out2 = m.invalidatePlane3D(A);
    check(out2.keptFrozenIds.includes(a0.id), 'a pinned exclusive node is reported as frozen');
    check(eq(m.pool.getPoint3d(a0.id), [2, 2, 2]), 'and keeps its coordinate');

    // The per-node path: editing one node's 2D invalidates that node and every
    // plane standing on it, and nothing else.
    B.planeFit = { centroid: [0, 0, 0], normal: [0, 1, 0], rms: 0, nPoints: 4 };
    check(m.invalidateNode3D(s0.id) === true, 'the shared node is invalidated');
    check(!m.pool.hasPoint3d(s0.id), 'its 3D is gone');
    check(B.planeFit === null, 'and BOTH planes standing on it lost their fit');
    check(m.pool.hasPoint3d(b0.id), 'while its neighbours kept their 3D');
}

console.log('\n10. planePolygonOrder still detects a cycle (and still falls back)');
{
    const m = new PlaneModel();
    const n = ['p0', 'p1', 'p2', 'p3'].map(x => m.addNode(x));
    const P = m.createPlane('quad');
    n.forEach(x => m.addNodeToPlane(P, x.id));
    check(eq(planePolygonOrder(P), [0, 1, 2, 3]), 'no edges: membership order');

    // A bowtie: connected 0-2, 2-1, 1-3, 3-0 — index order would self-intersect.
    P.addEdge(n[0].id, n[2].id);
    P.addEdge(n[2].id, n[1].id);
    P.addEdge(n[1].id, n[3].id);
    P.addEdge(n[3].id, n[0].id);
    check(eq(planePolygonOrder(P), [0, 2, 1, 3]), 'a simple cycle IS the outline');
    check(eq(planePolygonOrderIds(P), [n[0].id, n[2].id, n[1].id, n[3].id]),
        'the same walk, as node IDs');
    check(eq(planePolygonOrderPoolIndices(P, m.pool), [0, 2, 1, 3]), '…and as pool indices');

    P.removeEdgeBetween(n[3].id, n[0].id);
    check(eq(planePolygonOrder(P), [0, 1, 2, 3]), 'an open chain falls back to membership order');

    // Two disjoint triangles: EVERY node has degree 2, so the degree test
    // passes and only the walk can catch it. This is the branch that would
    // otherwise return a 3-node "outline" for a 6-node plane.
    const m2 = new PlaneModel();
    const q = ['a', 'b', 'c', 'd', 'e', 'f'].map(x => m2.addNode(x));
    const Q = m2.createPlane('two-triangles');
    q.forEach(x => m2.addNodeToPlane(Q, x.id));
    [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3]].forEach(
        e => Q.addEdge(q[e[0]].id, q[e[1]].id));
    check(Q.nodeIds.every(id => Q.edges.filter(e => e[0] === id || e[1] === id).length === 2),
        'every node of the two-triangle plane has degree exactly 2');
    check(eq(planePolygonOrder(Q), [0, 1, 2, 3, 4, 5]),
        'two disjoint cycles fall back to membership order rather than guessing');

    check(eq(planePolygonOrder(m.createPlane('empty')), []), 'an empty plane has no order');
}

console.log('\n11. Seeding and per-plane materializers preserve the old behaviour');
{
    const ring = seedPlanePoints(4, 320, 240, 640, 480);
    check(ring.length === 4, 'seedPlanePoints still returns one point per node');
    check(near(ring[0][0], 320) && ring[0][1] < 240, 'node 0 is still at 12 o\'clock');
    check(near(seedPlanePoints(1, 5, 6, 640, 480)[0][0], 5), 'a single node lands on the drop point');

    const { m, A, s0 } = twoPlanesSharingAnEdge();
    m.placePlane(A, 'camA', 320, 240, 640, 480);
    const inst = m.getInstance('camA');
    const expect = seedPlanePoints(4, 320, 240, 640, 480);
    const idxs = planeNodeIndices(A, m.pool);
    check(idxs.every((k, i) => near(inst.getX(k), expect[i][0]) && near(inst.getY(k), expect[i][1])),
        'a fresh placement lands exactly on the legacy ring, in PLANE order');
    check(eq(planeNodeNames(A, m.pool), ['a0', 'shared0', 'shared1', 'a1']),
        'node names materialize in plane order');

    const c = planeCentroid2d(A, m.pool, inst);
    check(near(c[0], 320, 1e-6) && near(c[1], 240, 1e-6), 'the per-plane 2D centroid is the ring centre');

    // A node added to an ALREADY-placed plane must get a real position, or the
    // user has nothing to grab.
    const extra = m.createNodeInPlane('extra', A);
    const ke = m.pool.indexOf(extra.id);
    check(inst.hasPoint(ke), 'a node added to a placed plane is seeded on that view');
    check(inst.numNodes === m.pool.size, 'and every view grew with the pool');
    check(extra.color !== undefined && extra.color !== m.pool.nodeAt(0).color,
        'it gets its own palette colour, distinct from the first node\'s');

    // …but a node added to a plane placed NOWHERE stays unpositioned.
    const B2 = m.createPlane('nowhere');
    const lone = m.createNodeInPlane('lone', B2);
    check(!inst.hasPoint(m.pool.indexOf(lone.id)),
        'a node of an unplaced plane is not invented a position');
}

console.log('\n12. Colours, ids and the error materializer');
{
    const pool = new PlaneNodePool();
    const a = pool.addNode('a'), b = pool.addNode('b');
    check(a.color === defaultNodeColor(0) && b.color === defaultNodeColor(1),
        'colours come off the palette in creation order');
    pool.removeNode(a.id);
    const c = pool.addNode('c');
    check(c.color !== b.color, 'a node created after a delete does not steal a live neighbour\'s colour');
    check(c.id !== a.id, 'and ids are never reused');
    check(pool.addNode('d', { color: '#123456' }).color === '#123456', 'an explicit colour wins');

    const m = new PlaneModel();
    const n = [m.addNode('x'), m.addNode('y')];
    const P = m.createPlane('P');
    n.forEach(q => m.addNodeToPlane(P, q.id));
    n[1].error = 0.75;
    check(eq(nodeErrorsForPlane(P, m.pool), [null, 0.75]),
        'per-node errors materialize in plane order, null where unknown');
}

console.log('\n13. Deleting a plane deletes NO nodes');
{
    const { m, A, B, s0, s1, a0, a1, b0 } = twoPlanesSharingAnEdge();
    m.placePlane(A, 'camA', 100, 100, 640, 480);
    m.placePlane(B, 'camA', 300, 300, 640, 480);
    const poolBefore = m.pool.size;
    const inst = m.getInstance('camA');
    const ia0 = m.pool.indexOf(a0.id);
    const a0xy = [inst.getX(ia0), inst.getY(ia0)];

    const out = m.deletePlane(A);
    check(out.removed, 'plane A is gone');
    check(m.pool.size === poolBefore, 'the pool is exactly as large as before');
    check(eq(out.keptNodeIds.slice().sort(), [a0.id, s0.id, s1.id, a1.id].sort()),
        'every node it referenced is reported as kept');
    check(m.pool.has(a0.id) && m.pool.has(a1.id),
        'even the nodes NO remaining plane references survive — they are pool members');
    check(m.pool.has(s0.id) && m.pool.has(b0.id), 'the shared pair is untouched');
    check(inst.hasPoint(ia0) && eq([inst.getX(ia0), inst.getY(ia0)], a0xy),
        'and their 2D is untouched too');
    check(B.size === 4, 'plane B is intact');
    check(!inst.isPlanePlaced(A.id), 'the view forgot A was placed on it');
    check(m.visibleNodeIndices('camA').indexOf(ia0) < 0,
        'the orphaned node is simply not VISIBLE any more');

    // The reviewer's repro: a pinned, surveyed node must not evaporate as a
    // side effect of deleting the one plane that happened to reference it.
    const m2 = new PlaneModel();
    const P = m2.createPlane('P');
    const pin = m2.addNode('surveyed', { immutable: true });
    m2.addNodeToPlane(P, pin.id);
    m2.pool.setPoint3d(pin.id, [10, 20, 30], { force: true });
    m2.deletePlane(P);
    check(m2.pool.has(pin.id), 'REPRO 2: the pinned node survives deletePlane');
    check(eq(m2.pool.getPoint3d(pin.id), [10, 20, 30]), 'with its surveyed 3D intact');

    // Same rule for removing a node from a plane; opting in is explicit.
    const P2 = m2.createPlane('P2');
    m2.addNodeToPlane(P2, pin.id);
    const r = m2.removeNodeFromPlane(P2, pin.id);
    check(r.removed && !r.deletedNode && m2.pool.has(pin.id),
        'removeNodeFromPlane does not delete the orphan by default');
    m2.addNodeToPlane(P2, pin.id);
    check(m2.removeNodeFromPlane(P2, pin.id, { deleteIfOrphan: true }).deletedNode,
        '…but a caller that has confirmed the intent can opt in');
    check(!m2.pool.has(pin.id), 'and then it really is gone — deleteNode has no pin gate');
}

console.log('\n14. attachPlacements re-seats a detached map BY NODE ID');
{
    const m = new PlaneModel();
    const P = m.createPlane('P');
    const n = ['n0', 'n1', 'n2', 'n3', 'n4'].map(x => m.createNodeInPlane(x, P));
    m.placePlane(P, 'camA', 100, 100, 640, 480);
    const inst = m.getInstance('camA');
    // Distinct, recognisable points so a positional shift cannot hide.
    n.forEach((x, i) => inst.setPoint(m.pool.indexOf(x.id), 1000 + i, 2000 + i));
    const at = (id) => inst.getPoint(m.pool.indexOf(id));

    const detached = m.placements;
    m.placements = new Map();          // session switched away

    // …and the pool is edited in the MIDDLE while the map is detached: a
    // count-based resync re-seats every later column onto its neighbour.
    m.deleteNode(n[2].id);
    m.attachPlacements(detached);
    check(inst.numNodes === m.pool.size,
        `REPRO 1: width matches the pool (${inst.numNodes} vs ${m.pool.size})`);
    check(eq(at(n[3].id), [1003, 2003]),
        'REPRO 1: n3 still holds ITS point, not the deleted n2\'s (1002,2002)');
    check(eq(at(n[4].id), [1004, 2004]), 'REPRO 1: n4 too');
    check(eq(at(n[0].id), [1000, 2000]) && eq(at(n[1].id), [1001, 2001]),
        'columns before the edit are unmoved');

    // Now a MOVE while detached, plus a nulled flag riding along.
    inst.toggleNodeNull(m.pool.indexOf(n[4].id));
    m.placements = new Map();
    m.moveNode(m.pool.indexOf(n[4].id), 0);
    const grew = m.addNode('n5');
    m.attachPlacements(detached);
    check(eq(at(n[4].id), [1004, 2004]), 'REPRO 1: a mid-pool MOVE while detached is re-seated');
    check(eq(at(n[0].id), [1000, 2000]), 'and the node it displaced kept its own point');
    check(inst.isNodeNulled(m.pool.indexOf(n[4].id)),
        'the nulled flag followed its node across the move');
    check(inst.nulledNodes.size === 1, 'and did not smear onto a neighbour');
    check(!inst.hasPoint(m.pool.indexOf(grew.id)),
        'a node added while detached arrives unpositioned');
    check(eq(inst.nodeIds, m.pool.ids()), 'the ledger matches the pool exactly');

    // The plane-flag pruning it also does.
    const gone = m.createPlane('gone');
    inst.placedPlanes.add(gone.id);
    m.deletePlane(gone);
    m.attachPlacements(detached);
    check(!inst.isPlanePlaced(gone.id), 'a placement flag for a deleted plane is pruned');
    check(inst.isPlanePlaced(P.id), 'a live one is kept');
}

console.log('\n15. `force` cannot leak through an invalidation cascade');
{
    const m = new PlaneModel();
    const P = m.createPlane('P');
    const pin = m.createNodeInPlane('pinned', P, { immutable: true });
    const free = m.createNodeInPlane('free', P);
    m.pool.setPoint3d(pin.id, [1, 1, 1], { force: true });
    m.pool.setPoint3d(free.id, [2, 2, 2]);

    // REPRO 3: the same opts object gated `clearNodes` AND reached
    // `clearPoint3d`, so a caller forcing a wipe stripped immutability.
    const out = m.invalidatePlane3D(P, { force: true });
    check(eq(m.pool.getPoint3d(pin.id), [1, 1, 1]),
        'REPRO 3: a stray {force:true} does NOT clear the pinned node');
    check(out.keptFrozenIds.includes(pin.id), 'it is reported as kept-frozen');
    check(!m.pool.hasPoint3d(free.id), 'while the free node was cleared as asked');
    check(pin.immutable === true, 'and the node is still pinned');

    m.pool.setPoint3d(free.id, [2, 2, 2]);
    check(m.invalidateNode3D(pin.id, { force: true }) === false,
        'REPRO 3: the per-node cascade ignores {force} as well');
    check(m.pool.hasPoint3d(pin.id), 'the pinned coordinate is still there');

    // The named opt-in is the only way through.
    const out2 = m.invalidatePlane3D(P, { forceClearImmutable: true });
    check(!m.pool.hasPoint3d(pin.id), 'forceClearImmutable does clear it');
    check(out2.clearedNodeIds.includes(pin.id), 'and says so');
    check(pin.immutable === true, 'clearing the coordinate does not un-pin the node');
}

console.log('\n16. A plane\'s FILL outlines the outermost nodes, not membership order');
{
    // The reported case: a quad with a fifth node dropped in the MIDDLE. In
    // membership order that middle node is a vertex, and being interior it is
    // necessarily a REFLEX one — the fill carves a notch in to it instead of
    // covering it. Coordinates are the ones from the report (a floor marked up
    // in one view, screen pixels, y down).
    const m = new PlaneModel();
    const P = m.createPlane('floor');
    const XY = { A: [274, 817], B: [313, 445], C: [603, 536], D: [412, 867], Ground: [404, 642] };
    const names = ['A', 'B', 'C', 'D', 'Ground'];
    names.forEach(n => m.createNodeInPlane(n, P));
    const inst = m.ensureInstance('camA');
    const poolIdx = {};
    P.nodeIds.forEach((id, i) => {
        poolIdx[names[i]] = m.pool.indexOf(id);
        inst.setPoint(poolIdx[names[i]], XY[names[i]][0], XY[names[i]][1]);
    });
    const named = ks => ks.map(k => m.pool.nodeAt(k).name);

    // The old behaviour, still available and still what it always was — this is
    // what the fill USED to walk, and the reason the notch appeared.
    check(eq(planePolygonOrder(P), [0, 1, 2, 3, 4]), 'membership order includes the middle node');
    check(planeCycleOrderIds(P) === null, 'and with no edges there is no user ring');

    const fill2d = planeFillOrderPoolIndices(P, m.pool, inst);
    check(eq(named(fill2d), ['A', 'B', 'C', 'D']), '2D fill walks the four outer nodes');
    check(!named(fill2d).includes('Ground'), 'the middle node is not a vertex of the fill');
    check(fill2d.length === 4, 'so the fill is a quad, not a five-point star');

    // Enclosure is the actual claim, so test THAT rather than just the vertex
    // list: ray-cast the middle point against the fill polygon.
    const inside = (pt, ring) => {
        let hit = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i], b = ring[j];
            if ((a[1] > pt[1]) !== (b[1] > pt[1])
                && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
        }
        return hit;
    };
    const ring2d = fill2d.map(k => [inst.getX(k), inst.getY(k)]);
    check(inside(XY.Ground, ring2d), 'and the middle node lies INSIDE the filled quad');
    check(!inside([10, 10], ring2d), 'while a point outside the quad is outside (the test can fail)');

    // 3D half. Lift the same layout onto a plane and hull it there.
    P.nodeIds.forEach((id, i) => m.pool.setPoint3d(id, [XY[names[i]][0], XY[names[i]][1], 12]));
    const named3 = is => is.map(i => m.pool.getNode(P.nodeIds[i]).name);
    check(eq(named3(planeFillOrder3d(P, m.pool)).sort(), ['A', 'B', 'C', 'D']),
        '3D fill hulls to the same four nodes with no fit to borrow a normal from');
    P.planeFit = { centroid: [400, 650, 12], normal: [0, 0, 1], rms: 0, nPoints: 5 };
    check(eq(named3(planeFillOrder3d(P, m.pool)), ['A', 'B', 'C', 'D']),
        '…and again using the fit normal');

    // A node with no 3D yet contributes no 3D vertex, but still contributes a
    // 2D one — the two representations are independent.
    m.pool.clearPoint3d(P.nodeIds[2]);
    check(!named3(planeFillOrder3d(P, m.pool)).includes('C'), 'an untriangulated node is not a 3D vertex');
    check(named(planeFillOrderPoolIndices(P, m.pool, inst)).includes('C'),
        'but it is still a 2D one');
    m.pool.setPoint3d(P.nodeIds[2], [XY.C[0], XY.C[1], 12]);

    // An EXPLICIT ring is the user stating a concave outline, and must win over
    // the hull — otherwise an L-shaped floor is impossible to express.
    [['A', 'B'], ['B', 'C'], ['C', 'Ground'], ['Ground', 'D'], ['D', 'A']].forEach(e =>
        P.addEdge(P.nodeIds[names.indexOf(e[0])], P.nodeIds[names.indexOf(e[1])]));
    check(planeCycleOrderIds(P) !== null, 'the five edges form a ring');
    check(eq(named(planeFillOrderPoolIndices(P, m.pool, inst)),
        ['A', 'B', 'C', 'Ground', 'D']), 'a user-drawn ring wins over the hull in 2D');
    check(eq(named3(planeFillOrder3d(P, m.pool)), ['A', 'B', 'C', 'Ground', 'D']),
        '…and in 3D');
    check(!inside(XY.Ground, named(planeFillOrderPoolIndices(P, m.pool, inst))
        .map(n => XY[n])), 'so the concave notch the user asked for is preserved');
}

console.log('\n17. Hull ordering degenerates safely');
{
    const quad = convexHullOrder2d([[0, 0], [4, 0], [4, 4], [0, 4]]);
    check(quad.length === 4, 'a convex quad hulls to exactly four corners');
    check(eq(quad.slice().sort(), [0, 1, 2, 3]), '…all of them, each once');
    // Collinear and coincident sets have no outline at all. Returning the input
    // order keeps every caller's own `< 3` guard reading the way it always did,
    // rather than handing back a 2-gon that fills to nothing but looks valid.
    check(eq(convexHullOrder2d([[0, 0], [1, 1], [2, 2]]), [0, 1, 2]),
        'a collinear set falls back to input order');
    check(eq(convexHullOrder2d([[1, 1], [1, 1], [1, 1]]), [0, 1, 2]),
        'so does a coincident one');
    check(eq(convexHullOrder2d([[0, 0], [1, 0]]), [0, 1]), 'and fewer than 3 points');
    check(eq(convexHullOrder2d([]), []), 'and none at all');
    // A duplicate ON the hull would otherwise add a zero-area triangle to the
    // 3D fan.
    check(eq(convexHullOrder2d([[0, 0], [0, 0], [4, 0], [4, 4], [0, 4]]).length, 4),
        'a duplicated hull vertex appears once');
    // A point exactly on a hull EDGE is boundary, but not a corner.
    const mid = convexHullOrder2d([[0, 0], [4, 0], [4, 4], [0, 4], [2, 0]]);
    check(mid.length === 4 && !mid.includes(4), 'a point on a hull edge is not a vertex');
    check(eq(convexHullOrder3d([[0, 0, 0], [1, 1, 1], [2, 2, 2]]), [0, 1, 2]),
        'a collinear 3D set falls back to input order');
    // Strictly interior, not on an edge: projecting into an in-plane basis
    // perturbs an exactly-collinear point by roundoff, so a point ON a hull
    // edge may survive as a vertex in 3D where it would not in 2D. That is
    // harmless (it adds a zero-area triangle to the fan, not a notch) and is
    // deliberately not pinned; being INSIDE is what has to be dropped.
    const sq3 = convexHullOrder3d([[0, 0, 5], [4, 0, 5], [4, 4, 5], [0, 4, 5], [2, 2, 5]]);
    check(sq3.length === 4 && !sq3.includes(4), 'a 3D hull drops the interior point');
    // A normal the points do NOT lie on must not divide by ~0 building the basis.
    check(convexHullOrder3d([[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 1, 0]], [1, 0, 0]).length >= 3,
        'a normal parallel to the data\'s longest axis still yields a ring');
    check(eq(planeFillOrder3d(null, null), []), 'a null plane has no fill order');
}

console.log('\n18. Derived (reprojected) 2D flags are per-(view, node) and travel with their node');
{
    // `derivedNodes` marks a point that triangulation reprojected into a view
    // the user never annotated. It is an INDEX-keyed set, exactly like
    // `nulledNodes` — which is the aliasing bug class this whole model was
    // rebuilt to avoid: a flag set left un-remapped points at its neighbour's
    // node, and every point still looks perfectly valid.
    const m = new PlaneModel();
    const n = ['q0', 'q1', 'q2', 'q3', 'q4'].map(x => m.addNode(x));
    const P = m.createPlane('quad');
    n.forEach(x => m.addNodeToPlane(P, x.id));
    const inst = m.ensureInstance('camA');
    n.forEach((x, i) => inst.setPoint(i, 100 + i, 200 + i));

    check(inst.isNodeDerived(2) === false, 'nothing is derived to begin with');
    inst.setNodeDerived(2, true);
    inst.setNodeDerived(4, true);
    check(inst.isNodeDerived(2) && inst.isNodeDerived(4), 'two nodes flagged');
    check(!inst.isNodeDerived(0) && !inst.isNodeDerived(3), 'and only those two');

    // Independent of nulled: both can be set, and neither implies the other.
    inst.toggleNodeNull(2);
    check(inst.isNodeNulled(2) && inst.isNodeDerived(2), 'nulled and derived coexist');
    check(!inst.isNodeNulled(4) && inst.isNodeDerived(4), 'and are independent');
    inst.toggleNodeNull(2);

    // A view the user never touched has its own (empty) set — the flag is
    // per-(view, node), because a corner can be hand-placed on one view and
    // reprojected on another.
    const other = m.ensureInstance('camB');
    check(!other.isNodeDerived(2), 'the flag does not leak to another view');

    // Deleting a node from the MIDDLE of the pool: flags above it shift down
    // with their node, and the deleted node's flag goes.
    m.deleteNode(n[1].id);
    check(eq(inst.nodeIds, [n[0].id, n[2].id, n[3].id, n[4].id]), 'the ledger spliced');
    check(inst.isNodeDerived(1) && inst.isNodeDerived(3),
        'derived flags followed their nodes down a deletion');
    check(!inst.isNodeDerived(2), 'and did not smear onto the neighbour');
    check(eq(inst.getPoint(1), [102, 202]), 'the point moved with the flag, not past it');

    // Reordering the pool.
    m.moveNode(0, 3);   // q0 to the end: q2 q3 q4 q0
    check(eq(inst.nodeIds, [n[2].id, n[3].id, n[4].id, n[0].id]), 'the ledger reordered');
    check(inst.isNodeDerived(0) && inst.isNodeDerived(2),
        'derived flags followed a reorder');
    check(!inst.isNodeDerived(1) && !inst.isNodeDerived(3), 'and nothing else moved');

    // The detach/reattach repair path — the one that must match BY ID.
    const detached = new Map();
    detached.set('camA', inst);
    m.addNode('q5');                       // pool changed while detached
    m.attachPlacements(detached);
    check(inst.numNodes === m.pool.size, 'reattached instance spans the pool');
    const derivedNames = [];
    for (let i = 0; i < inst.numNodes; i++) {
        if (inst.isNodeDerived(i)) derivedNames.push(m.pool.nodeAt(i).name);
    }
    check(eq(derivedNames.slice().sort(), ['q2', 'q4']),
        `the same NODES are derived after a resync (got ${JSON.stringify(derivedNames)})`);

    // Clearing: a user edit clears only what it touched.
    const i2 = m.pool.indexOf(n[2].id);
    check(inst.clearDerivedNodes([i2]) === 1, 'clearing one reports one');
    check(!inst.isNodeDerived(i2), 'and it is cleared');
    check(inst.isNodeDerived(m.pool.indexOf(n[4].id)), 'while the other survives');
    check(inst.clearDerivedNodes([i2]) === 0, 'clearing it again reports nothing');
    check(inst.clearDerivedNodes() === 1, 'clearing all reports the remainder');
    check(inst.derivedNodes.size === 0, 'and the set is empty');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
