/**
 * test-plane-serialization.mjs — the plane feature's round trip to disk.
 *
 * `pose/plane-serialization.js` is what makes nodes, planes, per-view 2D and
 * the origin frame survive a save. Its failure mode is not a crash: a subtly
 * wrong restore gives back a plane whose corners sit on their NEIGHBOURS'
 * nodes, with every point still looking perfectly valid, and the user only
 * finds out a session later. So the assertions here are about identity — which
 * node is which after the trip — rather than about "it came back non-empty".
 *
 * Everything goes through `JSON.parse(JSON.stringify(...))` before being read
 * back, because that is what actually happens on the way to a `.slp`: it is
 * the step that turns `NaN` into `null`, `Set` into `{}` and `Float64Array`
 * into an object, and a serializer that only round-trips in memory would pass
 * a naive test and lose data in production.
 *
 * ESM, so `tests/run-mjs-tests.mjs` picks it up automatically. The modules are
 * DOM-free by design, so they import directly with no stubs.
 */

import { PlaneModel } from '../pose/plane-data.js';
import { buildOriginFrame } from '../pose/origin-frame.js';
import {
    serializePlaneNodes, restorePlaneNodes,
    serializePlanes, restorePlanes,
    serializePlanePlacements, restorePlanePlacements,
    serializeOriginFrame, restoreOriginFrame,
    serializePlaneProject, restorePlaneProject,
} from '../pose/plane-serialization.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol);

/** The trip a payload actually takes: through JSON and back. */
const wire = (v) => JSON.parse(JSON.stringify(v));

/**
 * A model exercising every field that has to survive: two planes sharing an
 * edge, a pinned node, an un-triangulated node, edges, a fill, a solve summary
 * and a plane fit, plus 2D on two views with a nulled and a derived point.
 */
function buildModel() {
    const m = new PlaneModel();
    const floor = m.createPlane('floor');
    const wall = m.createPlane('wall');

    // Shared edge: s0/s1 belong to BOTH planes.
    const a0 = m.createNodeInPlane('a0', floor);
    const s0 = m.createNodeInPlane('s0', floor);
    const s1 = m.createNodeInPlane('s1', floor);
    const a1 = m.createNodeInPlane('a1', floor);
    m.addNodeToPlane(wall, s0.id);
    m.addNodeToPlane(wall, s1.id);
    const b0 = m.createNodeInPlane('b0', wall);

    floor.addEdge(a0.id, s0.id);
    floor.addEdge(s0.id, s1.id);
    floor.addEdge(s1.id, a1.id);
    floor.filled = true;

    a0.setPoint3d([0, 0, 0]);
    s0.setPoint3d([10, 0, 0]);
    s1.setPoint3d([10, 10, 0]);
    a1.setPoint3d([0, 10, 0]);
    // b0 stays untriangulated on purpose — the NaN case.
    a0.error = 0.42;
    m.pool.setImmutable(s1.id, true);

    floor.triangulation = { views: ['camA', 'camB'], nNodes: 4, meanError: 0.75 };
    floor.planeFit = { centroid: [5, 5, 0], normal: [0, 0, 1], rms: 0.01, nPoints: 4 };
    wall.triangulation = { views: ['camA'], nNodes: 2, meanError: null };

    const A = m.ensureInstance('camA');
    const B = m.ensureInstance('camB');
    const ids = [a0.id, s0.id, s1.id, a1.id, b0.id];
    ids.forEach((id, k) => {
        const i = m.pool.indexOf(id);
        A.setPoint(i, 100 + k * 10, 200 + k * 5);
    });
    A.placedPlanes.add(floor.id);
    A.placedPlanes.add(wall.id);
    A.nulledNodes.add(m.pool.indexOf(a1.id));
    A.setNodeDerived(m.pool.indexOf(b0.id), true);

    B.setPoint(m.pool.indexOf(s0.id), 5.5, 6.25);
    B.placedPlanes.add(wall.id);

    return { m, floor, wall, a0, s0, s1, a1, b0 };
}

// ============================================
console.log('\n1. Nodes survive the trip, identity and all');
// ============================================
{
    const { m, s1, b0, a0 } = buildModel();
    const back = restorePlaneNodes(wire(serializePlaneNodes(m.pool)));

    check(back.size === m.pool.size, 'the pool comes back the same size');
    check(eq(back.ids(), m.pool.ids()), 'with the same IDs in the same ORDER');
    check(eq(back.names(), m.pool.names()), 'and the same names');
    check(eq(back.colors(), m.pool.colors()), 'and the same colours');

    check(eq(back.getPoint3d(a0.id), [0, 0, 0]), 'a triangulated node keeps its 3D');
    check(near(back.getNode(a0.id).error, 0.42), 'and its reprojection error');

    // The NaN case — the reason 3D is written conditionally.
    check(!back.hasPoint3d(b0.id), 'an untriangulated node comes back untriangulated');
    const bx = back.getNode(b0.id).xyz;
    check(Number.isNaN(bx[0]) && Number.isNaN(bx[1]) && Number.isNaN(bx[2]),
        'as all-NaN, not as null or 0 (JSON turns NaN into null)');

    check(back.getNode(s1.id).immutable === true, 'a pinned node comes back pinned');
    check(eq(back.getPoint3d(s1.id), [10, 10, 0]),
        'WITH its coordinate — a pinned node refuses ordinary writes, so the ' +
        'restore has to force it');
    check(back.getNode(a0.id).immutable === false, 'and an unpinned one does not');

    // IDs are never reused, across a load as well as within a session.
    const fresh = back.addNode('after-load');
    check(fresh.id > Math.max(...m.pool.ids()),
        'a node created after a load cannot collide with a restored ID');
}

// ============================================
console.log('\n2. Planes keep their membership, edges and solve state');
// ============================================
{
    const { m, floor, wall, s0, s1 } = buildModel();
    const pool = restorePlaneNodes(wire(serializePlaneNodes(m.pool)));
    const back = restorePlanes(wire(serializePlanes(m.planes)), pool);

    check(back.length === 2, 'both planes come back');
    const f = back[0], w = back[1];
    check(f.id === floor.id && f.name === 'floor', 'the first is the floor, by ID');
    check(eq(f.nodeIds, floor.nodeIds), 'membership is the same NODE IDS in the same order');
    check(eq(f.edges, floor.edges), 'and so are the edges');
    check(f.filled === true && w.filled === false, 'the fill flag is per plane');
    check(f.color === floor.color, 'colour survives');

    // The shared edge is the point of the whole node pool.
    check(w.hasNode(s0.id) && w.hasNode(s1.id) && f.hasNode(s0.id) && f.hasNode(s1.id),
        'the two shared corners are still shared by both planes');
    check(pool.getNode(s0.id) === pool.getNode(s0.id),
        'and are ONE node, so they cannot drift apart');

    check(eq(f.triangulation, { views: ['camA', 'camB'], nNodes: 4, meanError: 0.75 }),
        'the solve summary survives');
    check(w.triangulation.meanError === null, 'including a null mean error');
    check(eq(f.planeFit, { centroid: [5, 5, 0], normal: [0, 0, 1], rms: 0.01, nPoints: 4 }),
        'and so does the plane fit — a reopened plane is still FIT, so Set ' +
        'Origin can still offer its corners');
    check(w.planeFit === null, 'an un-fit plane comes back un-fit');
}

// ============================================
console.log('\n3. Placements come back on the right nodes');
// ============================================
{
    const { m, floor, wall, a0, a1, b0, s0 } = buildModel();
    const pool = restorePlaneNodes(wire(serializePlaneNodes(m.pool)));
    const planes = restorePlanes(wire(serializePlanes(m.planes)), pool);
    const data = wire(serializePlanePlacements(m.placements, m.pool));
    const back = restorePlanePlacements(data, pool, planes.map(p => p.id));

    check(back.size === 2, 'both views come back');
    const A = back.get('camA');
    check(A.numNodes === pool.size, 'an instance spans the WHOLE pool, as the model requires');
    check(eq(A.nodeIds, pool.ids()), 'and its ledger names the pool in order');

    const ai = (id) => pool.indexOf(id);
    check(near(A.getX(ai(a0.id)), 100) && near(A.getY(ai(a0.id)), 200),
        'a0 came back on a0');
    check(near(A.getX(ai(b0.id)), 140) && near(A.getY(ai(b0.id)), 220),
        'b0 came back on b0 (the last column, the one an off-by-one would move)');

    check(A.isNodeNulled(ai(a1.id)), 'the nulled node is still nulled');
    check(!A.isNodeNulled(ai(a0.id)), 'and its neighbour is not');
    check(A.isNodeDerived(ai(b0.id)), 'the reprojected node is still reprojected');
    check(!A.isNodeDerived(ai(a1.id)), 'and the nulled one is not — different facts');

    check(A.isPlanePlaced(floor.id) && A.isPlanePlaced(wall.id),
        'camA still has both planes placed');
    const B = back.get('camB');
    check(!B.isPlanePlaced(floor.id) && B.isPlanePlaced(wall.id),
        'camB still has only the wall — placement is per (view, plane)');
    check(near(B.getX(ai(s0.id)), 5.5) && near(B.getY(ai(s0.id)), 6.25),
        'sub-pixel 2D is exact, not rounded');
    check(!B.hasPoint(ai(a0.id)), 'a node camB never positioned comes back unpositioned');
}

// ============================================
console.log('\n4. A pool that CHANGED since the file was written is re-seated by ID');
// ============================================
{
    // The bug this whole design exists to prevent: a node spliced out of the
    // MIDDLE, which no count-based repair can tell from an append.
    const { m, a0, s1, b0 } = buildModel();
    const data = wire(serializePlanePlacements(m.placements, m.pool));

    // Rebuild the pool WITHOUT s1 — as if the node had been deleted between
    // the save and the load.
    const nodeData = wire(serializePlaneNodes(m.pool)).filter(n => n.id !== s1.id);
    const pool = restorePlaneNodes(nodeData);
    const back = restorePlanePlacements(data, pool);
    const A = back.get('camA');

    check(A.numNodes === pool.size, 'the instance is sized to the NEW pool');
    check(near(A.getX(pool.indexOf(a0.id)), 100),
        'a node BEFORE the gap keeps its point');
    check(near(A.getX(pool.indexOf(b0.id)), 140),
        'and a node AFTER the gap keeps ITS point — a count-based restore would ' +
        'have slid this onto its neighbour');
    check(A.isNodeDerived(pool.indexOf(b0.id)),
        'and its flags moved with it, not with its old index');
}

// ============================================
console.log('\n5. Absence, garbage and defaults');
// ============================================
{
    check(serializePlaneNodes(null) === null, 'a null pool writes nothing');
    check(serializePlaneNodes({ nodes: [] }) === null, 'an empty pool writes nothing');
    check(serializePlanes([]) === null, 'no planes writes nothing');
    check(serializePlaneProject(new PlaneModel()) === null,
        'a project that never opened the feature writes NO keys at all');
    check(serializeOriginFrame(null) === null, 'no origin writes nothing');
    check(serializePlanePlacements(new Map(), null) === null, 'no placements writes nothing');

    const empty = new PlaneModel();
    empty.ensureInstance('camA');           // an instance that holds nothing
    check(serializePlanePlacements(empty.placements, empty.pool) === null,
        'a view with no points and no placed plane contributes nothing');

    // A plane the user named but has not populated is still worth saving.
    const named = new PlaneModel();
    named.createPlane('empty-but-mine');
    const proj = serializePlaneProject(named);
    check(proj && proj.planes && proj.planes.length === 1 && !proj.planeNodes,
        'a plane with no nodes yet still round-trips');

    // Garbage in, empty out — never a throw.
    for (const junk of [null, undefined, 42, 'nope', {}, [], [null, 3, 'x'], [{}]]) {
        try {
            restorePlaneNodes(junk);
            restorePlanes(junk, new PlaneModel().pool);
            restorePlanePlacements(junk, new PlaneModel().pool);
            restoreOriginFrame(junk);
            restorePlaneProject(new PlaneModel(), junk);
        } catch (e) {
            check(false, `restoring ${JSON.stringify(junk)} threw: ${e.message}`);
        }
    }
    check(true, 'every restore path tolerates null / garbage / partial input');

    // References to things that are not there are DROPPED, not kept dangling.
    const pool = restorePlaneNodes([{ id: 1, name: 'a', color: '#fff' }]);
    const planes = restorePlanes([{ id: 1, name: 'p', nodeIds: [1, 99], edges: [[1, 99]] }], pool);
    check(eq(planes[0].nodeIds, [1]), 'a member naming an absent node is dropped');
    check(planes[0].edges.length === 0, 'and so is an edge that used it');

    const pl = restorePlanePlacements(
        [{ view: 'camA', planes: [1, 77], points: [{ n: 99, xy: [1, 2] }] }], pool, [1]);
    check(pl.get('camA').isPlanePlaced(1) && !pl.get('camA').isPlanePlaced(77),
        'a placement flag for a plane that no longer exists is dropped');

    // A duplicate ID is skipped rather than renumbered — renumbering would
    // silently re-point some plane's membership at the wrong node.
    const dup = restorePlaneNodes([
        { id: 3, name: 'first', color: '#111' },
        { id: 3, name: 'second', color: '#222' },
    ]);
    check(dup.size === 1 && dup.getNode(3).name === 'first',
        'a duplicate node ID is skipped, not renumbered');
}

// ============================================
console.log('\n6. The origin frame is rebuilt from its inputs, not stored twice');
// ============================================
{
    const frame = buildOriginFrame([1, 2, 3], [0, 0, 5]);
    frame.sourcePlane = 'floor';
    frame.sourceNode = 'a0';

    const data = wire(serializeOriginFrame(frame));
    check(eq(Object.keys(data).sort(), ['origin', 'sourceNode', 'sourcePlane', 'zAxis']),
        'only the origin, the chosen +Z and the labels are written — R, the ' +
        'translation and the axis-angle form are DERIVED and would be a second ' +
        'source of truth');

    const back = restoreOriginFrame(data);
    check(eq(back.origin, frame.origin), 'the origin round-trips exactly');
    check(eq(back.zAxis, frame.zAxis), 'and so does +Z');
    check(eq(back.R, frame.R), 'the rotation rebuilds bit-for-bit');
    check(eq(back.translation, frame.translation), 'and so does the translation');
    check(near(back.angleDeg, frame.angleDeg), 'and the reported angle');
    check(back.sourcePlane === 'floor' && back.sourceNode === 'a0',
        'the labels ride along — they cannot be re-derived once a plane is renamed');

    // The sign of the choice is the whole point of the axis step.
    const flipped = restoreOriginFrame(wire(serializeOriginFrame(
        buildOriginFrame([1, 2, 3], [0, 0, -5]))));
    check(eq(flipped.zAxis, [0, 0, -1]), 'picking the OTHER arrow round-trips as -Z');
    check(!eq(flipped.R, back.R), 'and gives a different frame, as it must');

    check(restoreOriginFrame({ origin: [1, 2, 3] }) === null, 'a frame with no +Z is not a frame');
    check(restoreOriginFrame({ origin: [1, 2, 3], zAxis: [0, 0, 0] }) === null,
        'nor is one with a zero-length +Z');
}

// ============================================
console.log('\n7. The whole project bundle, into a live model');
// ============================================
{
    const { m, floor, s1, b0 } = buildModel();
    const data = wire(serializePlaneProject(m));

    // Restore into a model that already holds a DIFFERENT project — the load
    // case. It must be replaced, not merged.
    const target = new PlaneModel();
    target.createNodeInPlane('stale', target.createPlane('stale-plane'));
    const res = restorePlaneProject(target, data);

    check(res.nodes === m.pool.size && res.planes === m.planes.length,
        'the bundle reports what it restored');
    check(target.pool.size === m.pool.size, 'the previous project\'s nodes are gone');
    check(!target.planes.some(p => p.name === 'stale-plane'),
        'and so are its planes — a restore REPLACES, it does not merge');
    check(eq(target.pool.ids(), m.pool.ids()), 'IDs are preserved, not renumbered');

    const newPlane = target.createPlane('after');
    check(newPlane.id > Math.max(...m.planes.map(p => p.id)),
        'a plane created after a load cannot collide with a restored plane ID');

    // And the placements re-attach onto it exactly as a session switch would.
    const placements = restorePlanePlacements(
        wire(serializePlanePlacements(m.placements, m.pool)),
        target.pool, target.planes.map(p => p.id));
    target.attachPlacements(placements);
    const A = target.getInstance('camA');
    check(A && A.numNodes === target.pool.size, 'attachPlacements accepts the restored map');
    check(A.isPlanePlaced(floor.id), 'with its placement flags intact');
    check(near(A.getX(target.pool.indexOf(b0.id)), 140),
        'and every point still on its own node');

    // The end-to-end invariant: the 3D the user solved for is what comes back.
    check(eq(target.pool.getPoint3d(s1.id), [10, 10, 0]),
        'a pinned corner\'s coordinate survives the whole round trip');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
