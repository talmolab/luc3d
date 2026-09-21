/**
 * test-origin-rebase.mjs — "Set as New Calibration"'s engine, away from the UI.
 *
 * `pose/origin-rebase.js` rewrites every 3D number in the project. Two
 * properties carry the whole feature and both are asserted here over a real
 * `PlaneModel` and real `Camera`s rather than mocks:
 *
 *   1. **Nothing moves on screen.** Points and cameras transform together, so a
 *      3D point's reprojection lands on exactly the pixel it landed on before.
 *      Get one of the two transforms wrong — the classic being a normal fed
 *      through the affine map, or `frame.translation` used where `frame.origin`
 *      belongs — and every reprojection error in the project silently explodes.
 *   2. **Planning writes nothing.** Cancel has to be free and exact, which is
 *      only true if `planOriginRebase` never touches a stored value. That is
 *      pinned by snapshotting the entire project before planning and comparing
 *      bit-for-bit after.
 *
 * ESM, so `tests/run-mjs-tests.mjs` picks it up automatically.
 */

import { countRebaseTargets, planOriginRebase, applyOriginRebase } from '../pose/origin-rebase.js';
import { buildOriginFrame, rotationAboutAxis, applyOriginFrame } from '../pose/origin-frame.js';
import { Camera, Instance, InstanceGroup, makePoints3d, setPoint3d, getPoint3d } from '../pose/pose-data.js';
import { PlaneModel } from '../pose/plane-data.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol);

const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];

/** World -> camera, the mapping a calibration's extrinsics express. */
function toCamera(cam, p) {
    const R = cam.rotationMatrix, t = cam.tvec;
    return [0, 1, 2].map(i => R[i][0] * p[0] + R[i][1] * p[1] + R[i][2] * p[2] + t[i]);
}

/** …and on to pixels, which is what actually has to stay put. */
function toPixel(cam, p) {
    const c = toCamera(cam, p);
    return [K[0][0] * c[0] / c[2] + K[0][2], K[1][1] * c[1] / c[2] + K[1][2]];
}

/**
 * A small but non-degenerate project: two sessions, three cameras between them,
 * user / predicted / untyped groups, a NaN keypoint, two planes (one fitted,
 * one not) and a Locked node.
 */
function buildProject() {
    const camA = new Camera('camA', K, [0, 0, 0, 0, 0],
        [0.05, -0.2, 0.01], [40, -15, 900], [640, 480]);
    const camB = new Camera('camB', K, [0, 0, 0, 0, 0],
        [-0.3, 0.12, 0.4], [-60, 25, 870], [640, 480]);
    const camC = new Camera('camC', K, [0, 0, 0, 0, 0],
        [0.9, 0.1, -0.2], [10, 10, 1000], [640, 480]);

    // A group whose members are USER instances.
    const gUser = new InstanceGroup(1, 0);
    gUser.addInstance('camA', new Instance([[10, 20], [30, 40]], 0, 'user', 1));
    gUser.addInstance('camB', new Instance([[11, 21], [31, 41]], 0, 'user', 1));
    gUser.points3d = makePoints3d(3);
    setPoint3d(gUser.points3d, 0, [12.5, -7.25, 210]);
    setPoint3d(gUser.points3d, 1, [-40, 33, 195]);
    // node 2 deliberately left NaN — an untriangulated node must come back
    // untriangulated, not sitting at the new origin.

    // …and one whose members are all PREDICTED.
    const gPred = new InstanceGroup(2, 1);
    gPred.addInstance('camA', new Instance([[50, 60]], 1, 'predicted', 0.8));
    gPred.addInstance('camB', new Instance([[51, 61]], 1, 'predicted', 0.8));
    gPred.addInstance('camC', new Instance([[52, 62]], 1, 'predicted', 0.8));
    gPred.reprojectedInstances.set('camA', new Instance([[50, 60]], 1, 'reprojected', 1));
    gPred.reprojectedInstances.set('camB', new Instance([[51, 61]], 1, 'reprojected', 1));
    gPred.points3d = makePoints3d(2);
    setPoint3d(gPred.points3d, 0, [300, -120, 88]);
    setPoint3d(gPred.points3d, 1, [5, 5, 1000]);

    // A group with NO members at all — grouping restored from a file whose 2D
    // has not been hydrated. Its 3D still has to move.
    const gBare = new InstanceGroup(3, 2);
    gBare.points3d = makePoints3d(1);
    setPoint3d(gBare.points3d, 0, [-1, -2, -3]);

    // A group with members but no 3D: counted as instances, not as work.
    const gNo3d = new InstanceGroup(4, 3);
    gNo3d.addInstance('camA', new Instance([[1, 2]], 2, 'user', 1));

    const sessA = {
        cameras: [camA, camB],
        instanceGroups: new Map([[0, [gUser, gPred]], [7, [gNo3d]]]),
    };
    const sessB = {
        cameras: [camC],
        instanceGroups: new Map([[3, [gBare]]]),
    };

    const model = new PlaneModel();
    const floor = model.createPlane('Ground');
    ['c0', 'c1', 'c2', 'free'].forEach(nm => model.createNodeInPlane(nm, floor));
    const pool = model.pool.nodes;
    const setXyz = (node, v) => { node.xyz[0] = v[0]; node.xyz[1] = v[1]; node.xyz[2] = v[2]; };
    setXyz(pool[0], [-40.678, -30.234, 216.588]);
    setXyz(pool[1], [40, -30, 220]);
    setXyz(pool[2], [40, 30, 225]);
    // pool[3] stays all-NaN — never triangulated.
    // A pin must not exempt a node from the world moving.
    pool[2].pin = 'locked';

    floor.planeFit = {
        centroid: [13.107, -10.078, 220.529],
        normal: [0.046, 0.078, -0.996],
        rms: 0.4, nPoints: 3,
    };
    const wall = model.createPlane('Wall');   // no fit — must not be counted

    return { sessions: [sessA, sessB], model, cams: [camA, camB, camC],
             groups: { gUser, gPred, gBare, gNo3d }, floor, wall, pool };
}

/** Everything the module could possibly write, as comparable plain data. */
function snapshot(p) {
    const gs = [p.groups.gUser, p.groups.gPred, p.groups.gBare];
    return JSON.stringify({
        pts: gs.map(g => Array.from(g.points3d).map(v => Number.isNaN(v) ? 'NaN' : v)),
        nodes: p.pool.map(nd => Array.from(nd.xyz).map(v => Number.isNaN(v) ? 'NaN' : v)),
        fit: { c: p.floor.planeFit.centroid.slice(), n: p.floor.planeFit.normal.slice() },
        cams: p.cams.map(c => ({ r: c.rvec.slice(), t: c.tvec.slice() })),
    });
}

const FRAME = buildOriginFrame([-10.5, 11.25, 216.5], [0.2, -0.31, 0.93]);

console.log('\n1. countRebaseTargets buckets by provenance');
{
    const p = buildProject();
    const t = countRebaseTargets(p.sessions, p.model);
    check(t.sessions === 2 && t.cameras === 3, `2 sessions, 3 cameras (got ${t.sessions}/${t.cameras})`);
    check(t.groups === 3, `3 groups carry 3D — the member-less one included (got ${t.groups})`);
    check(t.userGroups === 1 && t.predictedGroups === 1 && t.untypedGroups === 1,
        `one group of each provenance (got ${t.userGroups}/${t.predictedGroups}/${t.untypedGroups})`);
    check(t.keypoints3d === 5,
        `only FINITE keypoints are counted — the NaN node is not work (got ${t.keypoints3d})`);
    check(t.userInstances === 3 && t.predictedInstances === 3,
        `2D members are tallied including the group with no 3D (got ${t.userInstances}/${t.predictedInstances})`);
    check(t.reprojectedInstances === 2, `reprojections are reported (got ${t.reprojectedInstances})`);
    check(t.planeNodes === 3, `only triangulated pool nodes count (got ${t.planeNodes})`);
    check(t.planeFits === 1, `the un-fit plane is not counted (got ${t.planeFits})`);
    check(t.work === t.groups + t.planeNodes + t.planeFits + t.cameras,
        'the progress total is the number of things the plan loop visits');
}

console.log('\n2. Planning writes NOTHING (what makes Cancel exact)');
{
    const p = buildProject();
    const before = snapshot(p);
    const plan = await planOriginRebase(p.sessions, p.model, FRAME);
    check(plan && !plan.failed, 'a plan comes back');
    check(snapshot(p) === before,
        'not one stored value changed while planning — the buffers are built beside the live ones');
    check(plan.groups.length === 3 && plan.nodes.length === 3 &&
          plan.fits.length === 1 && plan.cameras.length === 3,
        `the plan covers every target (${plan.groups.length}/${plan.nodes.length}/` +
        `${plan.fits.length}/${plan.cameras.length})`);
    check(plan.groups.every(g => g.next !== g.group.points3d),
        'each replacement buffer is a NEW array, not the live one written through');
}

console.log('\n3. A cancelled plan leaves the project untouched');
{
    const p = buildProject();
    const before = snapshot(p);
    let ticks = 0;
    const plan = await planOriginRebase(p.sessions, p.model, FRAME, {
        yieldEvery: 1,
        shouldCancel: () => { ticks++; return ticks >= 2; },
    });
    check(plan === null, 'cancelling returns null rather than a partial plan');
    check(snapshot(p) === before, 'and the project is byte-identical to before');
}

console.log('\n4. THE INVARIANT: every 3D point keeps its pixel');
{
    const p = buildProject();
    const probes = [];
    for (const g of [p.groups.gUser, p.groups.gPred, p.groups.gBare]) {
        for (let k = 0; k < g.points3d.length / 3; k++) {
            const q = getPoint3d(g.points3d, k);
            if (q) probes.push({ g, k, before: p.cams.map(c => toPixel(c, q)) });
        }
    }
    for (const nd of p.pool) {
        if (!Number.isNaN(nd.xyz[0])) {
            probes.push({ node: nd, before: p.cams.map(c => toPixel(c, Array.from(nd.xyz))) });
        }
    }
    // What the ORIGINAL calibration would say about the re-based points — the
    // control that shows the rewrite is doing real work.
    const staleCams = p.cams.map(c => new Camera(c.name, K, c.dist, c.rvec.slice(), c.tvec.slice(), c.size));

    const plan = await planOriginRebase(p.sessions, p.model, FRAME);
    applyOriginRebase(plan);

    let worst = 0, worstStale = 0;
    for (const pr of probes) {
        const after = pr.node ? Array.from(pr.node.xyz) : getPoint3d(pr.g.points3d, pr.k);
        for (let ci = 0; ci < p.cams.length; ci++) {
            const now = toPixel(p.cams[ci], after);
            const stale = toPixel(staleCams[ci], after);
            for (let a = 0; a < 2; a++) {
                worst = Math.max(worst, Math.abs(now[a] - pr.before[ci][a]));
                worstStale = Math.max(worstStale, Math.abs(stale[a] - pr.before[ci][a]));
            }
        }
    }
    check(probes.length === 8, `every finite 3D point is probed (got ${probes.length})`);
    check(worst < 1e-6,
        `each one still projects to its original pixel in all 3 cameras (worst ${worst.toExponential(2)} px)`);
    check(worstStale > 10,
        `NEGATIVE CONTROL: the un-rewritten calibration puts them ${worstStale.toFixed(0)} px away`);

    // …and the points really did move, so the invariant is not holding because
    // nothing happened.
    check(Math.abs(getPoint3d(p.groups.gUser.points3d, 0)[2]) < 100,
        'the coordinates themselves are new — the origin is no longer 216mm away in z');
}

console.log('\n5. NaN survives, Locked nodes do not');
{
    const p = buildProject();
    const lockedBefore = Array.from(p.pool[2].xyz);
    const plan = await planOriginRebase(p.sessions, p.model, FRAME);
    applyOriginRebase(plan);
    check(Number.isNaN(p.groups.gUser.points3d[6]) &&
          Number.isNaN(p.groups.gUser.points3d[7]) &&
          Number.isNaN(p.groups.gUser.points3d[8]),
        'an untriangulated keypoint comes back untriangulated, not at the origin');
    check(Number.isNaN(p.pool[3].xyz[0]), 'and so does an untriangulated pool node');
    check(p.pool[2].pin === 'locked', 'the Locked node is still Locked');
    check(!near(p.pool[2].xyz[0], lockedBefore[0], 1e-6) ||
          !near(p.pool[2].xyz[2], lockedBefore[2], 1e-6),
        'but it MOVED — a pin refuses a re-solve, not the world changing underneath it');
}

console.log('\n6. A plane fit is a point AND a direction, transformed differently');
{
    const p = buildProject();
    const fitBefore = {
        c: p.floor.planeFit.centroid.slice(),
        n: p.floor.planeFit.normal.slice(),
    };
    const plan = await planOriginRebase(p.sessions, p.model, FRAME);
    applyOriginRebase(plan);
    const c = p.floor.planeFit.centroid, nrm = p.floor.planeFit.normal;

    check(c.every((v, i) => near(v, applyOriginFrame(FRAME, fitBefore.c)[i], 1e-9)),
        'the centroid takes the full affine map');
    const len = Math.hypot(nrm[0], nrm[1], nrm[2]);
    check(near(len, Math.hypot(...fitBefore.n), 1e-12),
        `the normal keeps its length — it is a direction (got ${len.toFixed(12)})`);
    // The mistake this split exists to prevent.
    const wrong = applyOriginFrame(FRAME, fitBefore.n);
    check(!nrm.every((v, i) => near(v, wrong[i], 1e-6)),
        'NEGATIVE CONTROL: passing the normal through the affine map gives a different answer');
    check(p.floor.planeFit.rms === 0.4 && p.floor.planeFit.nPoints === 3,
        'the fit residual and point count are untouched — they are not coordinates');
    check(!p.wall.planeFit, 'the un-fit plane still has no fit');
}

console.log('\n7. Cameras: caches drop, intrinsics do not move');
{
    const p = buildProject();
    const camA = p.cams[0];
    // Force every memo to exist, so a missed invalidation would be visible.
    const pBefore = camA.projectionMatrix.map(r => r.slice());
    const rBefore = camA.rotationMatrix.map(r => r.slice());
    const distBefore = camA.dist.slice();

    const plan = await planOriginRebase(p.sessions, p.model, FRAME);
    applyOriginRebase(plan);

    const rAfter = camA.rotationMatrix;
    check(!rAfter.every((row, i) => row.every((v, j) => near(v, rBefore[i][j], 1e-9))),
        'the memoized rotationMatrix reflects the new extrinsics');
    const pAfter = camA.projectionMatrix;
    check(!pAfter.every((row, i) => row.every((v, j) => near(v, pBefore[i][j], 1e-9))),
        'and so does the memoized projectionMatrix — setExtrinsics dropped both');
    check(camA.matrix === K && camA.dist.every((v, i) => v === distBefore[i]),
        'intrinsics and distortion are not touched — an origin change moves the world, not the lens');
    check(Array.isArray(camA.rvec) && !Array.isArray(camA.rvec[0]),
        'a Rodrigues calibration stays Rodrigues');
}

console.log('\n8. A 3x3 calibration keeps its notation');
{
    const p = buildProject();
    // Anipose-style: rotation stored as a matrix, not a Rodrigues triple.
    const M = rotationAboutAxis([0.2, 0.9, -0.3], 0.77);
    p.cams[0].setExtrinsics(M, [40, -15, 900]);
    const plan = await planOriginRebase(p.sessions, p.model, FRAME);
    applyOriginRebase(plan);
    check(Array.isArray(p.cams[0].rvec) && Array.isArray(p.cams[0].rvec[0]) &&
          p.cams[0].rvec.length === 3,
        'a matrix-rotation camera comes back with a 3x3, not a triple');
    check(Array.isArray(p.cams[1].rvec) && !Array.isArray(p.cams[1].rvec[0]),
        'while its Rodrigues sibling in the same session is unaffected');
}

console.log('\n9. Degenerate input is refused');
{
    const p = buildProject();
    const before = snapshot(p);
    check(await planOriginRebase(p.sessions, p.model, null) === null, 'a missing frame is refused');
    check(await planOriginRebase(p.sessions, p.model, {}) === null, 'a frame with no R is refused');
    check(snapshot(p) === before, 'and neither refusal touched anything');

    // A camera that cannot be re-based aborts the WHOLE plan — a project with
    // one camera left in the old frame is worse than one that did not move.
    const p2 = buildProject();
    p2.cams[1].setExtrinsics([NaN, 0, 0], [0, 0, 0]);
    const bad = await planOriginRebase(p2.sessions, p2.model, FRAME);
    check(bad && bad.failed === true && bad.camera === 'camB',
        `the failure names the camera (got ${JSON.stringify(bad && bad.camera)})`);
}

console.log('\n10. Progress is reported monotonically to the declared total');
{
    const p = buildProject();
    const seen = [];
    const plan = await planOriginRebase(p.sessions, p.model, FRAME, {
        yieldEvery: 1,
        onProgress: (done, total) => seen.push([done, total]),
    });
    check(seen.length > 0, 'progress is reported');
    check(seen.every(([d, t]) => d <= t), 'and never exceeds the total');
    check(seen.every(([, t]) => t === plan.tally.work), 'the total is the tally it announced');
    check(seen[seen.length - 1][0] === plan.tally.work,
        `the bar reaches 100% (got ${seen[seen.length - 1][0]}/${plan.tally.work})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
