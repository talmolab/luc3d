/**
 * test-mesh-object-3d.mjs — the grouping layer, and the promise that it is
 * ADDITIVE.
 *
 * A 3D Mesh Object is a name and a list of plane IDs. The interesting claim is
 * not what it does but what it does NOT do: it was added beside the plane model
 * without changing a single existing method, and in particular
 * `PlaneModel.deletePlane` does not know objects exist and never will. That is
 * only true because membership is resolved LAZILY — filtered against the live
 * planes every time it is read — so there is no cascade to forget and no window
 * in which a dangling reference is dereferenced.
 *
 * The failure this pins is a quiet one. If a cascade were added later, deleting
 * a plane would start mutating objects; if the lazy filter were dropped, a
 * deleted plane would surface as a face with no ring and the whole mesh build
 * would throw somewhere far from the cause. Section 4 asserts the plane model
 * behaves IDENTICALLY whether or not objects exist, which is the whole claim.
 *
 * ESM, so `tests/run-mjs-tests.mjs` picks it up automatically.
 */

import { PlaneModel } from '../pose/plane-data.js';
import {
    MeshObject3D, MeshObjectSet, MESH_OBJECT_COLORS, defaultMeshObjectColor,
} from '../pose/mesh-object-3d.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A model with three planes, each holding one node. */
function threePlanes() {
    const model = new PlaneModel();
    const planes = ['floor', 'back', 'side'].map((n) => {
        const p = model.createPlane(n);
        const node = model.addNode(n + '_c');
        node.setPoint3d([0, 0, 0]);
        model.addNodeToPlane(p, node.id);
        return p;
    });
    return { model, planes };
}

// ============================================
console.log('\n--- 1. Identity, naming and colour ---');
// ============================================
{
    const set = new MeshObjectSet();
    check(set.size === 0 && set.isEmpty, 'a new set is empty');

    const a = set.createObject('cage');
    const b = set.createObject();
    check(set.size === 2, 'two objects');
    check(a.name === 'cage', 'the given name is kept');
    check(/^Object \d+$/.test(b.name), 'and an omitted one is generated');
    check(a.id !== b.id, 'ids differ');
    check(a.color !== b.color, 'and so do the default colours');
    check(MESH_OBJECT_COLORS.indexOf(a.color) >= 0, 'which come from the palette');
    check(defaultMeshObjectColor(0) === defaultMeshObjectColor(MESH_OBJECT_COLORS.length),
        'the palette cycles');
    check(defaultMeshObjectColor(-1) === MESH_OBJECT_COLORS[MESH_OBJECT_COLORS.length - 1],
        'and handles a negative index');

    check(set.getObject(a.id) === a, 'lookup by id');
    check(set.getObject(9999) === null, 'and null for an unknown id');

    check(set.renameObject(a, 'arena') === true && a.name === 'arena', 'rename');
    check(set.renameObject(a, '   ') === false && a.name === 'arena',
        'a blank name is refused — an unnamed row is indistinguishable from a broken one');
    check(set.renameObject(a, 'arena') === false, 'renaming to the same name reports no change');
    check(set.recolorObject(a, '#123456') === true && a.color === '#123456', 'recolour');
    check(set.recolorObject(a, '#123456') === false, 'and reports no change when it is the same');

    // IDs are never reused — the panel's selection and the project file both
    // address objects by id.
    const idA = a.id;
    set.deleteObject(a);
    const c = set.createObject('new');
    check(c.id !== idA, 'a deleted id is never handed out again');
    check(set.deleteObject(9999) === false, 'deleting an unknown id is a no-op');
}

// ============================================
console.log('\n--- 2. Membership is by plane id, and order is preserved ---');
// ============================================
{
    const { model, planes } = threePlanes();
    const obj = model.meshObjects.createObject('cage');

    check(obj.addPlane(planes[2].id) === true, 'add reports a change');
    check(obj.addPlane(planes[0].id) === true, 'and again');
    check(obj.addPlane(planes[2].id) === false, 'adding a member twice is a no-op');
    check(eq(obj.planeIds, [planes[2].id, planes[0].id]),
        'insertion order is preserved — it is the face order an export will use');
    check(obj.hasPlane(planes[0].id) && !obj.hasPlane(planes[1].id), 'membership queries');

    check(obj.removePlane(planes[2].id) === true, 'remove reports a change');
    check(obj.removePlane(planes[2].id) === false, 'removing a non-member is a no-op');
    check(eq(obj.planeIds, [planes[0].id]), 'and only that one went');

    check(obj.planeCount(model) === 1, 'planeCount resolves against the model');
    check(obj.planeCount(null) === 0, 'and is safe with no model');
    check(obj.resolvePlanes(model)[0] === planes[0], 'resolvePlanes returns the real planes');

    check(model.meshObjects.objectsForPlane(planes[0].id).length === 1,
        'the inverse query finds the object');
    check(model.meshObjects.objectsForPlane(planes[1].id).length === 0,
        'and finds none for a plane in no object');
}

// ============================================
console.log('\n--- 3. Adoption keeps ids, the way the restore path needs ---');
// ============================================
{
    const set = new MeshObjectSet();
    const restored = new MeshObject3D(7, 'cage', '#26a69a');
    restored.addPlane(3);
    check(set.adoptObject(restored) === true, 'adopt succeeds');
    check(set.getObject(7) === restored, 'and the id from the file is kept');

    // The reason `_nextId` has to move: an object created after opening a
    // project must not collide with one that was already in it.
    const next = set.createObject('fresh');
    check(next.id > 7, '_nextId advanced past the adopted id');

    check(set.adoptObject(new MeshObject3D(7, 'dup', '#fff')) === false,
        'a duplicate id is refused rather than renumbered');
    check(set.size === 2, 'and nothing was added');

    set.clear();
    check(set.size === 0 && set.getObject(7) === null, 'clear empties the set and its index');
    check(set.createObject('after').id === 1, 'and resets the id counter');
}

// ============================================
console.log('\n--- 4. ADDITIVITY: the plane model behaves identically either way ---');
// ============================================
{
    /** Every observable of the plane model, as a comparable snapshot. */
    const snapshot = (m) => JSON.stringify({
        planes: m.planes.map((p) => ({
            id: p.id, name: p.name, nodeIds: p.nodeIds.slice(),
            edges: p.edges.map((e) => [e[0], e[1]]),
        })),
        nodes: m.pool.nodes.map((n) => ({
            id: n.id, name: n.name, immutable: n.immutable,
            xyz: Array.from(n.xyz).map((v) => (isFinite(v) ? v : null)),
        })),
        nextPlaneId: m._nextPlaneId,
    });

    // Two identical models; only one of them has objects on it.
    const plain = threePlanes();
    const grouped = threePlanes();
    const obj = grouped.model.meshObjects.createObject('cage');
    grouped.planes.forEach((p) => obj.addPlane(p.id));

    check(snapshot(plain.model) === snapshot(grouped.model),
        'building an object over the planes changes nothing about them');

    // The operation that would need a cascade if there were one.
    plain.model.deletePlane(plain.planes[1]);
    grouped.model.deletePlane(grouped.planes[1]);
    check(snapshot(plain.model) === snapshot(grouped.model),
        'and deleting a MEMBER plane leaves the plane model identical too');

    // The object absorbs it lazily rather than being mutated.
    check(obj.planeIds.length === 3, 'the object still lists all three ids — no cascade ran');
    check(obj.planeCount(grouped.model) === 2, 'but only two resolve');
    check(obj.danglingCount(grouped.model) === 1, 'and one is reported dangling');
    check(obj.resolvePlaneIds(grouped.model).indexOf(grouped.planes[1].id) < 0,
        'the deleted plane is filtered out of every resolved read');

    // Deleting the last member is still not a delete of anything else.
    const poolBefore = grouped.model.pool.size;
    grouped.model.meshObjects.deleteObject(obj);
    check(grouped.model.meshObjects.size === 0, 'the grouping is gone');
    check(grouped.model.planes.length === 2, 'its planes are NOT');
    check(grouped.model.pool.size === poolBefore, 'and neither are their nodes');
}

// ============================================
console.log('\n--- 5. PlaneModel carries the set, and reset clears it ---');
// ============================================
{
    const model = new PlaneModel();
    check(model.meshObjects instanceof MeshObjectSet, 'a fresh model has an empty set');
    check(model.meshObjects.isEmpty, 'which is empty');

    model.meshObjects.createObject('cage');
    check(model.meshObjects.size === 1, 'objects live on the model');

    // Nothing on PlaneModel reads or maintains the set — deleting a node, which
    // touches membership, edges and every view's 2D, must not reach it.
    const n = model.addNode('x');
    model.deleteNode(n.id);
    check(model.meshObjects.size === 1, 'deleting a node does not touch objects');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
