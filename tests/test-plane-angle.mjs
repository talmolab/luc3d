/**
 * test-plane-angle.mjs — setting the angle between two annotated planes.
 *
 * The geometry throughout is a floor and a wall hinged along a shared edge,
 * which is the case the feature exists for (the user's open-top box). Because
 * the fixture states both `planeFit`s EXACTLY rather than fitting them, every
 * expected angle here is analytic and the tolerances can be tight enough to
 * catch a wrong branch rather than just a wrong order of magnitude.
 *
 * What is actually at risk, and therefore what this file pins:
 *
 *   * **The normal's sign is arbitrary.** `fitPlaneToPoints3d` takes an
 *     eigenvector straight from `jacobiEigen` and never stabilizes its sign, so
 *     every result has to be invariant under negating either plane's normal.
 *     §2 and §7 assert exactly that.
 *   * **The rotation must be the SMALLEST one.** Four candidate angles solve
 *     the equation; three of them are wrong for a user who typed "90" meaning
 *     "straighten this wall up a little". §5 asserts the wall does not flip
 *     through the floor.
 *   * **Shared corners must not move AT ALL.** They belong to the fixed plane
 *     too, so an ulp of drift is the silent divergence the shared node pool
 *     exists to prevent. Asserted bit-exactly, not approximately.
 *   * **A planner must not mutate.** Every refusal path is checked to leave the
 *     model's 3D untouched, because the UI shows a preview from this and may
 *     never commit.
 *
 * ESM, so `tests/run-mjs-tests.mjs` picks it up automatically. `pose/plane-angle.js`
 * imports only `origin-frame.js` and `plane-data.js`, both DOM-free, so this
 * needs no stubs and no loader hook.
 */

import { PlaneModel } from '../pose/plane-data.js';
import { normalize3, cross3, dot3, rotationAboutAxis, mulMat3Vec3 } from '../pose/origin-frame.js';
import {
    planeAngleDeg, sharedNodeIds, hingeAxis, sharedNodesSpanAPlane,
    solveAngleRotation, applyRotationToPoints3d, rotatePlaneFit, planAngleEdit,
} from '../pose/plane-angle.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol);
const vnear = (a, b, tol) => a.length === b.length && a.every((v, i) => near(v, b[i], tol));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const DEG = Math.PI / 180;

/**
 * A floor on z = 0 and a wall hinged to it along the x axis, leaning at
 * `beta` degrees from the floor.
 *
 *              wall
 *          f3---------w3        floor: (0,0,0) (10,0,0) (10,10,0) (0,10,0)
 *         /          /          wall:  the two hinge corners plus two more
 *        /   beta   /                  at 5 * (0, cos b, sin b)
 *   h0==*==========*==h1  <- the SHARED edge, along +x
 *       |  floor   |
 *
 * The plane-to-plane angle is exactly `beta`: the wall's normal is
 * (0, -sin b, cos b) and the floor's is (0, 0, 1), so |n.n| = |cos b|.
 */
function floorAndWall(beta) {
    const m = new PlaneModel();
    const h0 = m.addNode('h0'), h1 = m.addNode('h1');
    const f2 = m.addNode('f2'), f3 = m.addNode('f3');
    const w2 = m.addNode('w2'), w3 = m.addNode('w3');

    const b = beta * DEG;
    const d = [0, Math.cos(b), Math.sin(b)];

    h0.setPoint3d([0, 0, 0]);
    h1.setPoint3d([10, 0, 0]);
    f2.setPoint3d([10, 10, 0]);
    f3.setPoint3d([0, 10, 0]);
    w2.setPoint3d([10 + 5 * d[0], 5 * d[1], 5 * d[2]]);
    w3.setPoint3d([0 + 5 * d[0], 5 * d[1], 5 * d[2]]);

    const floor = m.createPlane('floor');
    [h0, h1, f2, f3].forEach(n => m.addNodeToPlane(floor, n.id));
    const wall = m.createPlane('wall');
    [h0, h1, w2, w3].forEach(n => m.addNodeToPlane(wall, n.id));

    // Set the fits AFTER membership: addNodeToPlane calls clearTriangulation.
    floor.planeFit = { centroid: [5, 5, 0], normal: [0, 0, 1], rms: 0, nPoints: 4 };
    wall.planeFit = {
        centroid: [5, 2.5 * Math.cos(b), 2.5 * Math.sin(b)],
        normal: [0, -Math.sin(b), Math.cos(b)],
        rms: 0, nPoints: 4,
    };
    return { m, floor, wall, h0, h1, f2, f3, w2, w3 };
}

/** The angle a plan's RESULT actually achieves, measured from the moved points. */
function achievedAngle(plan, floorNormal) {
    // Read the moved plane's normal off three of its points rather than off the
    // rotated fit, so this is an independent check of the points themselves.
    const p = i => [plan.after[i * 3], plan.after[i * 3 + 1], plan.after[i * 3 + 2]];
    const n = normalize3(cross3(
        [p(1)[0] - p(0)[0], p(1)[1] - p(0)[1], p(1)[2] - p(0)[2]],
        [p(2)[0] - p(0)[0], p(2)[1] - p(0)[1], p(2)[2] - p(0)[2]]));
    return planeAngleDeg(n, floorNormal);
}

console.log('\n1. planeAngleDeg: 0 is parallel, 90 is perpendicular');
{
    check(near(planeAngleDeg([0, 0, 1], [0, 0, 1]), 0), 'identical normals -> 0 (parallel)');
    check(near(planeAngleDeg([0, 0, 1], [1, 0, 0]), 90), 'orthogonal normals -> 90');
    check(near(planeAngleDeg([0, 0, 1], normalize3([0, 1, 1])), 45), 'a 45 degree case');
    check(near(planeAngleDeg([0, 0, 2], [0, 0, 5]), 0), 'non-unit input is normalized');
    check(planeAngleDeg([0, 0, 0], [0, 0, 1]) === null, 'a zero normal is refused');
    check(planeAngleDeg(null, [0, 0, 1]) === null, 'a missing normal is refused');

    // The whole reason the measurement is unsigned.
    check(near(planeAngleDeg([0, 0, 1], [0, 0, -1]), 0),
        'ANTIPARALLEL normals also read 0 — the planes are parallel either way');
    const a = normalize3([0, 1, 4]), b = normalize3([0, -3, 1]);
    check(near(planeAngleDeg(a, b), planeAngleDeg(a.map(v => -v), b)),
        'negating one normal does not change the angle');
    check(near(planeAngleDeg(a, b), planeAngleDeg(a, b.map(v => -v))),
        'negating the other does not either');
    // Never obtuse: that is what makes it reproducible.
    for (const t of [10, 30, 80, 89]) {
        const n = [0, -Math.sin(t * DEG), Math.cos(t * DEG)];
        check(near(planeAngleDeg([0, 0, 1], n), t, 1e-12),
            'a wall at ' + t + ' deg measures ' + t);
        check(planeAngleDeg([0, 0, 1], n) <= 90, 'and never exceeds 90');
    }
}

console.log('\n2. sharedNodeIds and the three hinge kinds');
{
    const { m, floor, wall, h0, h1 } = floorAndWall(60);

    check(eq(sharedNodeIds(wall, floor), [h0.id, h1.id]),
        'the two hinge corners are shared, in the moving plane’s order');
    check(eq(sharedNodeIds(floor, wall), [h0.id, h1.id]), 'and symmetrically');
    check(eq(sharedNodeIds(floor, null), []), 'a missing plane shares nothing');

    // --- 'edge': two shared corners give the line through them ---
    const ax = hingeAxis(floor, wall, m.pool);
    check(ax !== null && ax.kind === 'edge', 'two shared corners give an edge hinge');
    check(vnear(ax.point, [0, 0, 0]), 'anchored at the first shared corner');
    check(vnear(ax.dir, [1, 0, 0]) || vnear(ax.dir, [-1, 0, 0]),
        'and runs along the shared edge');
    check(eq(ax.hingeIds.slice().sort((p, q) => p - q), [h0.id, h1.id].sort((p, q) => p - q)),
        'both shared corners are reported as ON the axis');

    // --- 'node': one shared corner ---
    const one = floorAndWall(60);
    one.m.removeNodeFromPlane(one.wall, one.h1.id);
    one.wall.planeFit = { centroid: [5, 1.25, 2.165], normal: [0, -0.8660254, 0.5], rms: 0, nPoints: 3 };
    const ax1 = hingeAxis(one.floor, one.wall, one.m.pool);
    check(ax1 !== null && ax1.kind === 'node', 'one shared corner gives a node hinge');
    check(vnear(ax1.point, [0, 0, 0]), 'pivoting on that corner');
    check(near(Math.abs(dot3(ax1.dir, [1, 0, 0])), 1, 1e-9),
        'along the planes’ intersection direction, which here is +x');
    check(eq(ax1.hingeIds, [one.h0.id]), 'that corner is the only fixed one');

    // --- 'centroid': no shared corner ---
    const none = floorAndWall(60);
    none.m.removeNodeFromPlane(none.wall, none.h0.id);
    none.m.removeNodeFromPlane(none.wall, none.h1.id);
    none.wall.planeFit = { centroid: [5, 2, 3], normal: [0, -0.8660254, 0.5], rms: 0, nPoints: 2 };
    const ax0 = hingeAxis(none.floor, none.wall, none.m.pool);
    check(ax0 !== null && ax0.kind === 'centroid', 'no shared corner falls back to the centroid');
    check(vnear(ax0.point, [5, 2, 3]), 'pivoting on the moving plane’s centroid');
    check(eq(ax0.hingeIds, []), 'and nothing is guaranteed fixed');

    // --- parallel normals leave the intersection direction undetermined ---
    const par = floorAndWall(0);
    par.m.removeNodeFromPlane(par.wall, par.h0.id);
    par.m.removeNodeFromPlane(par.wall, par.h1.id);
    par.wall.planeFit = { centroid: [5, 2, 0], normal: [0, 0, 1], rms: 0, nPoints: 2 };
    const axp = hingeAxis(par.floor, par.wall, par.m.pool);
    check(axp !== null, 'parallel planes still yield an axis rather than null');
    check(near(dot3(axp.dir, [0, 0, 1]), 0, 1e-9),
        'and it is perpendicular to the normal, so rotating it does something');

    // --- no fit, no hinge ---
    const nf = floorAndWall(60);
    nf.wall.planeFit = null;
    check(hingeAxis(nf.floor, nf.wall, nf.m.pool) === null, 'an unfitted plane has no hinge');
}

console.log('\n3. sharedNodesSpanAPlane distinguishes a line from a plane');
{
    const m = new PlaneModel();
    const a = m.addNode('a'), b = m.addNode('b'), c = m.addNode('c'), d = m.addNode('d');
    a.setPoint3d([0, 0, 0]); b.setPoint3d([10, 0, 0]);
    c.setPoint3d([5, 0, 0]);     // on the line
    d.setPoint3d([5, 7, 0]);     // off it

    check(sharedNodesSpanAPlane([a.id, b.id], m.pool) === false, 'two corners are a line');
    check(sharedNodesSpanAPlane([a.id, b.id, c.id], m.pool) === false,
        'three COLLINEAR corners are still just a line');
    check(sharedNodesSpanAPlane([a.id, b.id, d.id], m.pool) === true,
        'three non-collinear corners span a plane');
    check(sharedNodesSpanAPlane([a.id], m.pool) === false, 'one corner cannot span anything');
    check(sharedNodesSpanAPlane([], m.pool) === false, 'nor can none');
}

console.log('\n4. solveAngleRotation finds the smallest rotation that works');
{
    const nF = [0, 0, 1];
    const u = [1, 0, 0];
    const wallNormal = t => [0, -Math.sin(t * DEG), Math.cos(t * DEG)];

    for (const [from, to] of [[60, 90], [87, 90], [90, 60], [30, 0], [0, 45], [45, 45]]) {
        const phi = solveAngleRotation(nF, wallNormal(from), u, to);
        check(phi !== null, from + ' -> ' + to + ': solved');
        if (phi === null) continue;
        const R = rotationAboutAxis(u, phi);
        check(near(planeAngleDeg(nF, mulMat3Vec3(R, wallNormal(from))), to, 1e-9),
            from + ' -> ' + to + ': the target is actually reached');
        // The smallest rotation that reaches the target is |from - to|.
        check(near(Math.abs(phi) / DEG, Math.abs(from - to), 1e-6),
            from + ' -> ' + to + ': and it is the MINIMAL rotation (' +
            (Math.abs(phi) / DEG).toFixed(3) + ' deg)');
    }

    // Already there: no rotation at all.
    check(near(solveAngleRotation(nF, wallNormal(45), u, 45), 0, 1e-9),
        'a plane already at the target needs no rotation');

    // Degenerate: the moving normal lies ALONG the hinge, so rotating about it
    // cannot change the angle.
    check(solveAngleRotation(nF, [1, 0, 0], [1, 0, 0], 45) === null,
        'a normal parallel to the hinge is refused, not approximated');

    // Out-of-domain targets.
    check(solveAngleRotation(nF, wallNormal(60), u, -1) === null, 'a negative target is refused');
    check(solveAngleRotation(nF, wallNormal(60), u, 91) === null, 'a target over 90 is refused');
    check(solveAngleRotation(nF, wallNormal(60), u, NaN) === null, 'NaN is refused');
    check(solveAngleRotation([0, 0, 0], wallNormal(60), u, 45) === null,
        'a zero normal is refused');

    // Unreachable about a skew axis: tilt the hinge out of the fixed plane so
    // the swept cone never crosses the target.
    const skew = normalize3([1, 0, 4]);
    let sawUnreachable = false;
    for (const t of [0, 5, 10, 90]) {
        if (solveAngleRotation(nF, mulMat3Vec3(rotationAboutAxis(skew, 0.3), wallNormal(60)),
            skew, t) === null) sawUnreachable = true;
    }
    check(sawUnreachable, 'a skew hinge reports the targets it cannot reach');
}

console.log('\n5. planAngleEdit: a 60 degree wall is squared to 90');
{
    const { m, floor, wall, h0, h1, w2, w3 } = floorAndWall(60);
    const before = [w2.getPoint3d(), w3.getPoint3d()];
    const hingeBefore = [h0.getPoint3d(), h1.getPoint3d()];

    const plan = planAngleEdit(floor, wall, 90, m);
    check(plan.ok === true, 'the plan succeeds');
    check(plan.code === 'ok', 'with code ok');
    check(near(plan.currentDeg, 60, 1e-9), 'it reports the current angle as 60');
    check(near(Math.abs(plan.deltaDeg), 30, 1e-6), 'and a 30 degree rotation');
    check(plan.axis.kind === 'edge', 'rotating about the shared edge');

    // The result, measured from the moved POINTS, not from the rotated fit.
    check(near(achievedAngle(plan, [0, 0, 1]), 90, 1e-9),
        'the moved points really are at 90 degrees to the floor');
    check(near(planeAngleDeg(plan.newMovingFit.normal, [0, 0, 1]), 90, 1e-9),
        'and so is the rotated fit');

    // The hinge corners must be BIT-identical, not merely close.
    const idx = id => wall.nodeIds.indexOf(id);
    for (const [name, id] of [['h0', h0.id], ['h1', h1.id]]) {
        const o = idx(id) * 3;
        check(plan.after[o] === plan.before[o] &&
              plan.after[o + 1] === plan.before[o + 1] &&
              plan.after[o + 2] === plan.before[o + 2],
            'shared corner ' + name + ' is bit-identical before and after');
    }
    check(eq(plan.movedNodeIds.slice().sort((a, b) => a - b),
             [w2.id, w3.id].sort((a, b) => a - b)),
        'only the two non-hinge corners move');

    // A vertical wall's free corners sit directly above the hinge.
    const o2 = idx(w2.id) * 3;
    check(near(plan.after[o2 + 1], 0, 1e-9) && near(plan.after[o2 + 2], 5, 1e-9),
        'w2 ends up straight up from the hinge (y = 0, z = 5)');

    // PURITY: planning wrote nothing.
    check(eq(w2.getPoint3d(), before[0]) && eq(w3.getPoint3d(), before[1]),
        'the planner did NOT move the real nodes');
    check(eq(h0.getPoint3d(), hingeBefore[0]) && eq(h1.getPoint3d(), hingeBefore[1]),
        'nor the hinge nodes');
    check(near(planeAngleDeg(wall.planeFit.normal, [0, 0, 1]), 60, 1e-9),
        'and the stored fit is untouched');

    // The floor shares both hinge nodes, but they did not move, so its fit is
    // NOT stale — this is the assertion that a locked/unmoved shared corner
    // costs the other plane nothing.
    check(eq(plan.stalePlaneIds, []), 'the fixed plane’s fit is not invalidated');
}

console.log('\n6. The minimal rotation keeps the wall on the side it was already on');
{
    // 87 -> 90 is the realistic case: a nearly-square wall being straightened.
    // The wrong branch would swing it to -90, mirroring it through the floor.
    const { m, floor, wall, w2, w3 } = floorAndWall(87);
    const plan = planAngleEdit(floor, wall, 90, m);
    check(plan.ok, '87 -> 90 plans');
    check(near(Math.abs(plan.deltaDeg), 3, 1e-6), 'by only 3 degrees');
    check(near(achievedAngle(plan, [0, 0, 1]), 90, 1e-9), 'reaching 90');

    const idx = id => wall.nodeIds.indexOf(id);
    for (const [name, nd] of [['w2', w2], ['w3', w3]]) {
        const o = idx(nd.id) * 3;
        check(plan.after[o + 2] > 0,
            name + ' stays ABOVE the floor (z > 0), not flipped through it');
        check(Math.abs(plan.after[o + 1]) < 1e-9 ||
              Math.sign(plan.after[o + 1]) === Math.sign(nd.getPoint3d()[1]),
            name + ' stays on its original side of the hinge');
    }

    // The opposite direction must work too: over-square back down to 60.
    const b = floorAndWall(87);
    const p2 = planAngleEdit(b.floor, b.wall, 60, b.m);
    check(p2.ok && near(Math.abs(p2.deltaDeg), 27, 1e-6), '87 -> 60 rotates 27 degrees');
    check(near(achievedAngle(p2, [0, 0, 1]), 60, 1e-9), 'and reaches 60');
}

console.log('\n7. The result does not depend on either normal’s arbitrary sign');
{
    // Four sign combinations of two eigenvector-derived normals. All four must
    // produce the same achieved angle and the same moved points, or the feature
    // is at the mercy of jacobiEigen's round-off.
    const results = [];
    for (const sf of [1, -1]) {
        for (const sm of [1, -1]) {
            const { m, floor, wall } = floorAndWall(60);
            floor.planeFit.normal = floor.planeFit.normal.map(v => v * sf);
            wall.planeFit.normal = wall.planeFit.normal.map(v => v * sm);
            const plan = planAngleEdit(floor, wall, 90, m);
            check(plan.ok, 'signs (' + sf + ', ' + sm + '): plans');
            check(near(achievedAngle(plan, [0, 0, 1]), 90, 1e-9),
                'signs (' + sf + ', ' + sm + '): reaches 90');
            check(near(Math.abs(plan.deltaDeg), 30, 1e-6),
                'signs (' + sf + ', ' + sm + '): same 30 degree rotation');
            results.push(Array.from(plan.after).map(v => Number(v.toFixed(10))));
        }
    }
    check(results.every(r => eq(r, results[0])),
        'all four sign combinations move the points to the SAME place');
}

console.log('\n8. Parallel (0 degrees) and idempotence');
{
    const { m, floor, wall } = floorAndWall(60);
    const flat = planAngleEdit(floor, wall, 0, m);
    check(flat.ok, 'a target of 0 plans');
    check(near(achievedAngle(flat, [0, 0, 1]), 0, 1e-9), 'and lays the wall parallel to the floor');
    check(near(Math.abs(dot3(normalize3(flat.newMovingFit.normal), [0, 0, 1])), 1, 1e-9),
        'so the normals end up parallel');

    // Applying the same angle twice must be a no-op the second time. Simulate
    // the commit by writing the plan's result into the model by hand.
    const a = floorAndWall(60);
    const p1 = planAngleEdit(a.floor, a.wall, 90, a.m);
    for (let k = 0; k < a.wall.nodeIds.length; k++) {
        const nd = a.m.pool.getNode(a.wall.nodeIds[k]);
        nd.setPoint3d([p1.after[k * 3], p1.after[k * 3 + 1], p1.after[k * 3 + 2]]);
    }
    a.wall.planeFit = p1.newMovingFit;

    const p2 = planAngleEdit(a.floor, a.wall, 90, a.m);
    check(p2.ok, 'planning 90 again still succeeds');
    check(near(p2.currentDeg, 90, 1e-9), 'the current angle now reads 90');
    check(near(Math.abs(p2.deltaDeg), 0, 1e-6), 'and the rotation is zero');
    check(p2.movedNodeIds.length === 0, 'so nothing would move');
    check(p2.warnings.some(w => w.code === 'already_there'),
        'which is reported as a warning rather than a refusal');
}

console.log('\n9. A LOCKED node that would move is a refusal, and nothing is touched');
{
    const { m, floor, wall, w2, w3, h0 } = floorAndWall(60);
    m.pool.setPin(w2.id, 'locked');
    const snapshot = wall.nodeIds.map(id => m.pool.getNode(id).getPoint3d());

    const plan = planAngleEdit(floor, wall, 90, m);
    check(plan.ok === false, 'the plan is refused');
    check(plan.code === 'locked_nodes', 'with code locked_nodes');
    check(eq(plan.blockedNodeNames, ['w2']), 'naming the offending node');
    check(/Locked/.test(plan.message) && /w2/.test(plan.message),
        'and the message says which node and why');
    check(/Plane-locked|unpinned/.test(plan.message),
        'and tells the user how to proceed');

    // Nothing moved, and no plan payload was produced to commit by accident.
    check(eq(wall.nodeIds.map(id => m.pool.getNode(id).getPoint3d()), snapshot),
        'no node moved');
    check(plan.after === undefined, 'and no result geometry was returned');

    // Two locked nodes are both named.
    const two = floorAndWall(60);
    two.m.pool.setPin(two.w2.id, 'locked');
    two.m.pool.setPin(two.w3.id, 'locked');
    const p2 = planAngleEdit(two.floor, two.wall, 90, two.m);
    check(p2.code === 'locked_nodes' && p2.blockedNodeNames.length === 2,
        'both locked nodes are named');
    check(/2 Locked nodes/.test(p2.message), 'and the count is pluralized');

    // A locked HINGE node does not block: it never moves. This is the
    // documented use of pinning — freezing a shared intersection line.
    const hinged = floorAndWall(60);
    hinged.m.pool.setPin(hinged.h0.id, 'locked');
    hinged.m.pool.setPin(hinged.h1.id, 'locked');
    const p3 = planAngleEdit(hinged.floor, hinged.wall, 90, hinged.m);
    check(p3.ok === true, 'locking BOTH hinge corners does not block the edit');
    check(near(achievedAngle(p3, [0, 0, 1]), 90, 1e-9), 'and it still reaches 90');
    check(h0 !== null, 'sanity');
}

console.log('\n10. A PLANE-LOCKED node is allowed through');
{
    // Plane-locked to the plane BEING ROTATED: a rigid rotation carries the
    // node along with its plane, so the constraint is satisfied by construction
    // and there is nothing to warn about.
    const own = floorAndWall(60);
    own.m.pool.setPin(own.w2.id, 'plane-locked', own.wall.id);
    const p1 = planAngleEdit(own.floor, own.wall, 90, own.m);
    check(p1.ok === true, 'plane-locked to the moving plane is allowed');
    check(near(achievedAngle(p1, [0, 0, 1]), 90, 1e-9), 'and the target is reached');
    check(!p1.warnings.some(w => w.code === 'plane_locked_elsewhere'),
        'with no warning, because its own plane moved with it');

    // Plane-locked to a DIFFERENT plane: allowed, but warned about, because the
    // commit will project it back and the result may miss the target.
    const other = floorAndWall(60);
    other.m.pool.setPin(other.w2.id, 'plane-locked', other.floor.id);
    const p2 = planAngleEdit(other.floor, other.wall, 90, other.m);
    check(p2.ok === true, 'plane-locked to another plane is still allowed');
    const w = p2.warnings.find(x => x.code === 'plane_locked_elsewhere');
    check(!!w, 'but it is reported as a warning');
    check(!!w && /w2/.test(w.message), 'naming the node');
    check(!!w && /1 node is/.test(w.message), 'singular for one node');
    // The names are the NODES, and must read that way. The old wording put a
    // bare node list in parentheses straight after "another plane", which read
    // as if it named the plane; pairing each node with the plane holding it is
    // what makes that impossible to misread.
    check(!!w && /w2 \(in "floor"\)/.test(w.message),
        'pairing the node with the plane that holds it');
    check(!!w && w.message.indexOf('w2') < w.message.indexOf('floor'),
        'node first, holding plane second — so the list cannot be read as planes');
    check(!!w && /w2 \(in "floor"\)/.test(w.detail || ''),
        'and the untruncated list rides along in `detail` for the tooltip');

    // More names than the narrow panel can show: capped on the line, whole in
    // `detail`. A count with no names is exactly the failure this pins.
    const many = floorAndWall(60);
    ['e1', 'e2', 'e3', 'e4'].forEach((nm, i) => {
        const n = many.m.addNode(nm);
        n.setPoint3d([1 + i, 2, 3]);          // off the hinge, so it moves
        many.m.addNodeToPlane(many.wall, n.id);
        many.m.pool.setPin(n.id, 'plane-locked', many.floor.id);
    });
    many.wall.planeFit = floorAndWall(60).wall.planeFit;   // addNodeToPlane cleared it
    const pm = planAngleEdit(many.floor, many.wall, 90, many.m);
    const wm = pm.warnings.find(x => x.code === 'plane_locked_elsewhere');
    check(!!wm && /4 nodes are/.test(wm.message), 'plural for four nodes');
    check(!!wm && /e1 \(in "floor"\)/.test(wm.message), 'the first names are inline');
    check(!!wm && /\+1 more/.test(wm.message), 'the overflow is counted, not dropped');
    check(!!wm && !/e4/.test(wm.message), 'and the capped name is off the line');
    check(!!wm && /e4 \(in "floor"\)/.test(wm.detail || ''),
        'but present in `detail`, so the tooltip still answers "which ones?"');

    // A stale pinPlaneId must not produce a spurious warning.
    const stale = floorAndWall(60);
    stale.m.pool.setPin(stale.w2.id, 'plane-locked', 9999);
    const p3 = planAngleEdit(stale.floor, stale.wall, 90, stale.m);
    check(p3.ok === true && !p3.warnings.some(x => x.code === 'plane_locked_elsewhere'),
        'a pinPlaneId naming no plane is inert');
}

console.log('\n11. Refusals: same plane, no fit, bad target, overconstrained');
{
    const { m, floor, wall, f2, w2 } = floorAndWall(60);

    check(planAngleEdit(floor, floor, 90, m).code === 'same_plane',
        'a plane cannot be set against itself');
    check(planAngleEdit(null, wall, 90, m).code === 'no_plane', 'a missing plane is refused');
    check(planAngleEdit(floor, wall, 90, null).code === 'no_model', 'a missing model is refused');
    check(planAngleEdit(floor, wall, 120, m).code === 'bad_target', '120 degrees is refused');
    check(planAngleEdit(floor, wall, -5, m).code === 'bad_target', 'a negative target is refused');
    check(/0 and 90/.test(planAngleEdit(floor, wall, 120, m).message),
        'and the message states the domain');

    const nf = floorAndWall(60);
    nf.wall.planeFit = null;
    const r = planAngleEdit(nf.floor, nf.wall, 90, nf.m);
    check(r.code === 'no_fit' && /wall/.test(r.message),
        'an unfitted moving plane is refused, by name');
    const nf2 = floorAndWall(60);
    nf2.floor.planeFit = null;
    check(/floor/.test(planAngleEdit(nf2.floor, nf2.wall, 90, nf2.m).message),
        'and so is an unfitted fixed plane');

    // Three non-collinear shared corners: the planes already share a plane.
    const over = floorAndWall(60);
    over.m.addNodeToPlane(over.wall, over.f2.id);      // f2 is off the hinge line
    over.wall.planeFit = { centroid: [5, 2.5, 2], normal: [0, -0.866, 0.5], rms: 0, nPoints: 5 };
    const ro = planAngleEdit(over.floor, over.wall, 90, over.m);
    check(ro.ok === false && ro.code === 'overconstrained',
        'three non-collinear shared corners are refused');
    check(/share a plane/.test(ro.message), 'and the message explains why');
    check(f2 !== null && w2 !== null, 'sanity');
}

console.log('\n12. A moved shared node marks the OTHER plane’s fit stale');
{
    // Give the wall a third plane sharing one of its free corners, the way the
    // user's box has walls sharing vertical corners with each other.
    const { m, floor, wall, h0, w2, w3 } = floorAndWall(60);
    const side = m.createPlane('side');
    const s1 = m.addNode('s1');
    s1.setPoint3d([20, 3, 1]);
    [w2, s1, h0].forEach(n => m.addNodeToPlane(side, n.id));
    side.planeFit = { centroid: [10, 2, 2], normal: [1, 0, 0], rms: 0, nPoints: 3 };

    const plan = planAngleEdit(floor, wall, 90, m);
    check(plan.ok, 'the edit still plans');
    check(eq(plan.stalePlaneIds, [side.id]),
        'the third plane is reported stale, because it shares a corner that moves');
    check(plan.stalePlaneIds.indexOf(floor.id) < 0,
        'but the FIXED plane is not, because its corners did not move');
    const sw = plan.warnings.find(x => x.code === 'stale_fits');
    check(!!sw, 'and the user is warned');
    // The warning must name BOTH halves: which fit is lost, and which shared
    // corner costs it. A bare count ("1 other plane") leaves the user with no
    // way to find either.
    check(!!sw && /"side"/.test(sw.message), 'naming the plane whose fit is cleared');
    check(!!sw && /shares w2/.test(sw.message), 'and the shared node that causes it');
    check(!!sw && /1 other plane shares a node/.test(sw.message),
        'singular throughout for one plane sharing one node');
    check(!!sw && /its fit will be cleared/.test(sw.message), 'including "its fit"');
    check(!!sw && /"side"/.test(sw.detail || ''), 'with the full list in `detail`');

    // Two stale planes: the plural wording, and each plane paired with its own
    // culprit node rather than one merged pile of names.
    const top = m.createPlane('top');
    [w3, s1, m.addNode('t1')].forEach(n => m.addNodeToPlane(top, n.id));
    top.planeFit = { centroid: [5, 2, 2], normal: [0, 1, 0], rms: 0, nPoints: 3 };
    const plan2 = planAngleEdit(floor, wall, 90, m);
    const sw2 = plan2.warnings.find(x => x.code === 'stale_fits');
    check(eq(plan2.stalePlaneIds, [side.id, top.id]), 'both planes go stale');
    check(!!sw2 && /2 other planes share nodes/.test(sw2.message), 'plural for two');
    check(!!sw2 && /their fits will be cleared/.test(sw2.message), 'and "their fits"');
    check(!!sw2 && /"side" \(shares w2\)/.test(sw2.message), 'side is named with w2');
    check(!!sw2 && /"top" \(shares w3\)/.test(sw2.message), 'and top with w3');
}

console.log('\n13. rotatePlaneFit is rigid and keeps the normal’s sign');
{
    const fit = { centroid: [1, 2, 3], normal: normalize3([0, -1, 1]), rms: 0.25, nPoints: 7 };
    const R = rotationAboutAxis([1, 0, 0], 30 * DEG);
    const out = rotatePlaneFit(fit, R, [0, 0, 0]);

    check(near(dot3(out.normal, out.normal), 1, 1e-12), 'the normal stays unit');
    check(out.rms === 0.25 && out.nPoints === 7,
        'rms and nPoints are annotation properties and are carried through');
    check(dot3(out.normal, mulMat3Vec3(R, fit.normal)) > 0,
        'the normal is rotated, not re-derived, so its sign is preserved');
    check(vnear(out.centroid, mulMat3Vec3(R, fit.centroid), 1e-12),
        'the centroid is rotated about the pivot');

    // Rotating about a pivot leaves the pivot itself alone.
    const p = [5, 5, 5];
    const atPivot = rotatePlaneFit({ centroid: p, normal: [0, 0, 1] }, R, p);
    check(vnear(atPivot.centroid, p, 1e-12), 'a centroid AT the pivot does not move');

    check(rotatePlaneFit(null, R, [0, 0, 0]) === null, 'a missing fit is refused');
    check(rotatePlaneFit(fit, null, [0, 0, 0]) === null, 'a missing rotation is refused');

    // `constrained` rides along when present — the free fit path never sets it,
    // and losing it would repeat plane-serialization's own dropped-flag bug.
    const c = rotatePlaneFit({ centroid: [0, 0, 0], normal: [0, 0, 1], constrained: true },
        R, [0, 0, 0]);
    check(c.constrained === true, 'the constrained flag is carried through');
}

console.log('\n14. applyRotationToPoints3d: missing stays missing, fixed stays exact');
{
    const flat = new Float64Array([0, 0, 0, 1, 0, 0, NaN, NaN, NaN, 0, 1, 0]);
    const ids = [10, 11, 12, 13];
    const R = rotationAboutAxis([1, 0, 0], 90 * DEG);
    const out = applyRotationToPoints3d(flat, R, [0, 0, 0], ids, [11]);

    check(out !== flat, 'a NEW array is returned');
    check(Number.isNaN(out[6]) && Number.isNaN(out[7]) && Number.isNaN(out[8]),
        'an untriangulated node stays untriangulated');
    check(out[3] === 1 && out[4] === 0 && out[5] === 0,
        'a node named in fixedIds is copied bit-exactly');
    check(vnear([out[9], out[10], out[11]], [0, 0, 1], 1e-15),
        '+90 about +x sends +y to +z');
    check(vnear([out[0], out[1], out[2]], [0, 0, 0], 1e-15), 'the pivot is unmoved');

    // Without fixedIds the axis point is still fixed, just not bit-exactly by
    // construction — this documents why the copy exists.
    const out2 = applyRotationToPoints3d(flat, R, [0, 0, 0], ids, null);
    check(vnear([out2[3], out2[4], out2[5]], [1, 0, 0], 1e-15),
        'and is fixed by the maths anyway, to within round-off');
}

console.log('\n15. A plane with no STORED fit is still usable, through `fits`');
{
    // The case this exists for: pinning a node clears the stored fit of every
    // plane standing on it, so a fully triangulated plane routinely carries
    // `planeFit === null`. It still has a plane; the caller derives it (with
    // `fitPlaneToPoints3d`, which this module may not import) and passes it in.
    const ref = floorAndWall(60);
    const refPlan = planAngleEdit(ref.floor, ref.wall, 90, ref.m);

    const { m, floor, wall } = floorAndWall(60);
    const derived = wall.planeFit;
    wall.planeFit = null;

    const refused = planAngleEdit(floor, wall, 90, m);
    check(refused.ok === false && refused.code === 'no_fit',
        'with no stored fit and no override, the plan is refused as no_fit');
    check(/wall/.test(refused.message) && !/Fit "/.test(refused.message),
        'and the message names the plane and asks for triangulation, not a Fit press ' +
        `(got "${refused.message}")`);
    check(hingeAxis(floor, wall, m.pool) === null,
        'hingeAxis refuses it too');

    const axis = hingeAxis(floor, wall, m.pool, { moving: derived });
    check(axis !== null && axis.kind === 'edge' && axis.hingeIds.length === 2,
        'given the fit, the same shared-edge hinge comes back');

    const plan = planAngleEdit(floor, wall, 90, m, { moving: derived });
    check(plan.ok === true, 'and the plan goes through');
    check(wall.planeFit === null,
        'planning STILL writes nothing — the stored fit is left null');
    check(eq(Array.from(plan.after), Array.from(refPlan.after)),
        'the result is bit-identical to the same edit with the fit stored');
    check(near(achievedAngle(plan, [0, 0, 1]), 90),
        'the wall lands at 90 degrees');
    check(plan.newMovingFit !== null &&
          near(planeAngleDeg(plan.newMovingFit.normal, [0, 0, 1]), 90),
        '`newMovingFit` is the rotation of the OVERRIDE, not of the null stored fit');

    // The fixed plane too, and both at once.
    const bothNull = floorAndWall(60);
    const fFit = bothNull.floor.planeFit, wFit = bothNull.wall.planeFit;
    bothNull.floor.planeFit = null;
    bothNull.wall.planeFit = null;
    check(planAngleEdit(bothNull.floor, bothNull.wall, 90, bothNull.m).code === 'no_fit',
        'a missing FIXED fit is refused as well');
    const both = planAngleEdit(bothNull.floor, bothNull.wall, 90, bothNull.m,
        { fixed: fFit, moving: wFit });
    check(both.ok === true && near(achievedAngle(both, [0, 0, 1]), 90),
        'and both fits supplied gives the same 90 degree result');

    // An override BEATS a stored fit. Not a use case — it is what makes the
    // override honest: the planner measures what it was handed, so a caller
    // that derives a fit is not silently overruled by a stale stored one.
    const stale = floorAndWall(60);
    stale.wall.planeFit = { centroid: [5, 2.5, 0], normal: [0, 0, 1], rms: 0, nPoints: 4 };
    const over = planAngleEdit(stale.floor, stale.wall, 90, stale.m,
        { moving: floorAndWall(60).wall.planeFit });
    check(near(over.currentDeg, 60, 1e-9),
        `the override is what gets measured (got ${over.currentDeg})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
