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

import { countRebaseTargets, subsetRebaseTally, planOriginRebase,
    applyOriginRebase } from '../pose/origin-rebase.js';
import { buildOriginFrame, rotationAboutAxis, applyOriginFrame } from '../pose/origin-frame.js';
import { Camera, FrameGroup, Instance, InstanceGroup, UnlinkedInstance,
    makePoints3d, setPoint3d, getPoint3d } from '../pose/pose-data.js';
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
    gPred.addReprojectedInstance('camA', new Instance([[50, 60]], 1, 'reprojected', 1));
    gPred.addReprojectedInstance('camB', new Instance([[51, 61]], 1, 'reprojected', 1));
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

    // The UNLINKED pool: 2D that no InstanceGroup references. On a real
    // imported `.slp` this is the bulk of the file, and it is disjoint from the
    // group members above (`restoreGroupingAndUnlink` moves exactly the
    // instances nothing references into here).
    const fg0 = new FrameGroup(0);
    fg0.addUnlinkedInstance('camA', new UnlinkedInstance(
        new Instance([[70, 80]], 1, 'predicted', 0.7), 'camA'));
    fg0.addUnlinkedInstance('camA', new UnlinkedInstance(
        new Instance([[71, 81]], 1, 'predicted', 0.7), 'camA'));
    fg0.addUnlinkedInstance('camB', new UnlinkedInstance(
        new Instance([[72, 82]], 0, 'user', 1), 'camB'));

    // The planes' own 2D, which is SESSION-scoped (unlike the node pool) and
    // does not move. A minimal stand-in for `PlaneInstance`: the tally only
    // asks `numNodes` and `hasPoint`.
    var placed = function (flags) {
        return { numNodes: flags.length, hasPoint: function (i) { return !!flags[i]; } };
    };

    const sessA = {
        name: 'A',
        cameras: [camA, camB],
        instanceGroups: new Map([[0, [gUser, gPred]], [7, [gNo3d]]]),
        frameGroups: new Map([[0, fg0]]),
        // 3 placed + 2 placed = 5 points across two views.
        planePlacements: new Map([
            ['camA', placed([1, 1, 1, 0])],
            ['camB', placed([1, 0, 1, 0])],
        ]),
    };
    const sessB = {
        name: 'B',
        cameras: [camC],
        instanceGroups: new Map([[3, [gBare]]]),
        frameGroups: new Map(),
        planePlacements: new Map([['camC', placed([1, 0, 0, 0])]]),
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
    check(t.userKeypoints3d + t.predictedKeypoints3d + t.untypedKeypoints3d === t.keypoints3d,
        `the per-provenance keypoint counts partition the total (got ` +
        `${t.userKeypoints3d}/${t.predictedKeypoints3d}/${t.untypedKeypoints3d} of ${t.keypoints3d})`);
    check(t.userMembers === 3 && t.predictedMembers === 3,
        `2D group MEMBERS are tallied including the group with no 3D (got ${t.userMembers}/${t.predictedMembers})`);
    check(t.userInstances === 4 && t.predictedInstances === 5,
        `and the 2D totals add the UNLINKED pool, which is where an imported ` +
        `.slp's predictions live (got ${t.userInstances}/${t.predictedInstances})`);
    check(t.instanceScope === 'resident',
        `an eager project is counted from the resident model (got '${t.instanceScope}')`);
    check(t.reprojectedInstances === 2, `reprojections are reported (got ${t.reprojectedInstances})`);
    check(t.planeNodes === 3, `only triangulated pool nodes count (got ${t.planeNodes})`);
    check(t.planeFits === 1, `the un-fit plane is not counted (got ${t.planeFits})`);
    check(t.work === t.groups + t.planeNodes + t.planeFits + t.cameras,
        'the progress total is the number of things the plan loop visits');
    check(t.points3d === t.keypoints3d + t.planeNodes,
        `points3d is EVERY 3D point that moves, pose and plane (got ${t.points3d})`);
    check(t.planePoints2d === 6,
        `the planes' own 2D is counted in POINTS, across every view (got ${t.planePoints2d})`);
}

console.log('\n1d. perSession: the multi-session breakdown');
{
    // A multi-session project can carry a DIFFERENT calibration.toml per
    // session, so the dialog needs the split: every session is re-based, but
    // only one calibration file comes out. What is SESSION-scoped appears per
    // session; the plane pool and the plane fits are project-scoped and must
    // NOT be split, or the dialog invents a division the data does not have.
    const p = buildProject();
    const t = countRebaseTargets(p.sessions, p.model);
    check(t.perSession.length === 2, `one record per session (got ${t.perSession.length})`);
    check(t.perSession[0].name === 'A' && t.perSession[1].name === 'B',
        `each named (got ${JSON.stringify(t.perSession.map(x => x.name))})`);
    check(t.perSession[0].cameras === 2 && t.perSession[1].cameras === 1,
        `cameras are per session (got ${t.perSession.map(x => x.cameras).join('/')})`);
    check(t.perSession[0].planePoints2d === 5 && t.perSession[1].planePoints2d === 1,
        `and so are plane placements (got ${t.perSession.map(x => x.planePoints2d).join('/')})`);
    check(!('planeNodes' in t.perSession[0]) && !('planeFits' in t.perSession[0]),
        'while the plane pool and the fits are NOT split — they are project-scoped');

    // Every per-session field must sum to its total, or the two views of one
    // project disagree and the breakdown is worse than not having it.
    const sum = (k) => t.perSession.reduce((a, x) => a + x[k], 0);
    for (const k of ['cameras', 'groups', 'keypoints3d', 'userKeypoints3d',
        'predictedKeypoints3d', 'untypedKeypoints3d', 'userGroups', 'predictedGroups',
        'untypedGroups', 'userInstances', 'predictedInstances', 'reprojectedInstances',
        'userMembers', 'predictedMembers', 'planePoints2d']) {
        check(sum(k) === t[k], `perSession sums to the total for ${k} (${sum(k)} vs ${t[k]})`);
    }
}

console.log('\n1b. A project with planes and no pose annotation still has points to move');
{
    // The reported bug: `keypoints3d` is honestly 0 here, and the dialog quoted
    // it under a heading that says "3D points to update" — directly above the
    // plane nodes it was about to rewrite. A plane node IS a 3D point.
    const p = buildProject();
    for (const sess of p.sessions) sess.instanceGroups.clear();
    const t = countRebaseTargets(p.sessions, p.model);
    check(t.keypoints3d === 0 && t.groups === 0, 'no pose 3D, by construction');
    check(t.planeNodes === 3, `the pool still has its triangulated nodes (got ${t.planeNodes})`);
    check(t.points3d === 3,
        `so the headline number is 3, not 0 (got ${t.points3d})`);
    check(t.work > 0, 'and the re-base is real work, not a no-op');
    check(t.planePoints2d === 6,
        'and the planes 2D is untouched by the pose being absent — different scope, ' +
        `different question (got ${t.planePoints2d})`);
}

console.log('\n1c. A lazy project is counted from the STORE, not the resident window');
{
    // The resident-only hazard, in the shape CLAUDE.md warns about: on a lazily
    // reopened project `frameGroups` holds a handful of frames (31 of 180,210
    // on the real one), so counting it reports a plausible, tiny number. The
    // columnar store is the complete enumeration, and it covers grouped and
    // ungrouped rows alike — so the group members must NOT be added on top.
    const p = buildProject();
    let visited = 0;
    p.sessions[0].lazyLoader = {
        forEachInstanceRow(visit) {
            for (let i = 0; i < 900; i++) {
                visit('camA', i, -1, { offsetInFrame: 0, storeRow: i, instanceRow: i,
                    type: i % 3 === 0 ? 'user' : 'predicted' });
                visited++;
            }
        },
    };
    const t = countRebaseTargets(p.sessions, p.model);
    check(t.instanceScope === 'store', `the store answered (got '${t.instanceScope}')`);
    check(visited === 900, 'every store row was visited');
    // 300 user + 600 predicted from the store; session B is eager and adds its
    // own members (it has none) — nothing from session A's resident model.
    check(t.userInstances === 300 && t.predictedInstances === 600,
        `the totals are the store's, with no resident double-count ` +
        `(got ${t.userInstances}/${t.predictedInstances})`);
    check(t.userMembers === 3 && t.predictedMembers === 3,
        `the grouped subtotal is still reported beside it (got ${t.userMembers}/${t.predictedMembers})`);
    check(t.keypoints3d === 5 && t.planeNodes === 3,
        'and the 3D walk is untouched — instanceGroups is project-wide either way');
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

console.log('\n11. A SUBSET of the sessions: subsetRebaseTally re-folds the same answer');
{
    // The dialog lets the user deselect sessions, and its headline numbers have
    // to follow. Recomputing with `countRebaseTargets` on the filtered array is
    // what the COMMIT does; the dialog re-folds instead, because a re-count
    // re-walks a lazy project's whole columnar store on every checkbox click.
    // The two therefore have to agree EXACTLY, field for field — this is the
    // assertion that keeps them from drifting.
    const p = buildProject();
    const full = countRebaseTargets(p.sessions, p.model);
    const folded = subsetRebaseTally(full, (ps, i) => i === 0);
    const counted = countRebaseTargets([p.sessions[0]], p.model);

    const FIELDS = ['sessions', 'cameras', 'groups', 'userGroups', 'predictedGroups',
        'untypedGroups', 'keypoints3d', 'userKeypoints3d', 'predictedKeypoints3d',
        'untypedKeypoints3d', 'userInstances', 'predictedInstances',
        'reprojectedInstances', 'userMembers', 'predictedMembers', 'planePoints2d',
        'planeNodes', 'planeFits', 'points3d', 'work', 'instanceScope'];
    const differs = FIELDS.filter(k => folded[k] !== counted[k]);
    check(differs.length === 0,
        `a re-fold over session A equals a fresh count of session A ` +
        `(differing: ${JSON.stringify(differs)})`);
    check(folded.perSession.length === 1 && folded.perSession[0].name === 'A',
        `and lists only the kept session (got ${JSON.stringify(folded.perSession.map(x => x.name))})`);

    // NEGATIVE CONTROL: the subset must actually be smaller, or the equality
    // above is being satisfied by a re-fold that quietly ignored the predicate.
    check(folded.cameras === 2 && full.cameras === 3 &&
          folded.keypoints3d === 4 && full.keypoints3d === 5,
        `the subset is genuinely a subset (${folded.cameras}/${full.cameras} cameras, ` +
        `${folded.keypoints3d}/${full.keypoints3d} keypoints)`);

    // The PROJECT-scoped half rides along whole. Plane nodes and plane fits
    // live in one `PlaneModel`, move exactly once, and move with the active
    // session — which the dialog does not let the user deselect. Splitting them
    // would invent a division the data does not have.
    check(folded.planeNodes === full.planeNodes && folded.planeFits === full.planeFits,
        `plane nodes and fits are not reduced by dropping a session ` +
        `(${folded.planeNodes}/${folded.planeFits})`);
    check(folded.points3d === folded.keypoints3d + folded.planeNodes,
        `and the headline is still the sum of its sub-rows (got ${folded.points3d})`);
}

console.log('\n11b. Re-basing a SUBSET leaves the omitted session where it was');
{
    // The point of the choice: a session that is not handed to
    // `planOriginRebase` keeps BOTH its 3D and its cameras, so it stays
    // internally consistent — every one of its pixels is where it was, for the
    // same reason the whole-project case works, and for the opposite reason.
    const p = buildProject();
    const camA = p.cams[0], camC = p.cams[2];
    const bareBefore = Array.from(p.groups.gBare.points3d);
    const camCBefore = { r: camC.rvec.slice(), t: camC.tvec.slice() };
    const userBefore = getPoint3d(p.groups.gUser.points3d, 0);
    const pixBefore = {
        // session A's own point in session A's own camera…
        aa: toPixel(camA, userBefore),
        // …and session B's point in session B's camera.
        bb: toPixel(camC, getPoint3d(p.groups.gBare.points3d, 0)),
    };

    // Session A only. Session B is not in the array, so nothing touches it.
    const plan = await planOriginRebase([p.sessions[0]], p.model, FRAME);
    check(plan && !plan.failed, 'a plan for one session comes back');
    check(plan.groups.length === 2 && plan.cameras.length === 2,
        `covering only that session's 3D and cameras (${plan.groups.length} groups, ` +
        `${plan.cameras.length} cameras)`);
    check(plan.nodes.length === 3 && plan.fits.length === 1,
        `while the project-scoped plane model is still planned in full ` +
        `(${plan.nodes.length} nodes, ${plan.fits.length} fits)`);
    check(plan.tally.sessions === 1 && plan.tally.cameras === 2,
        `and the plan's tally describes the subset, which is what the status line quotes ` +
        `(${plan.tally.sessions} session, ${plan.tally.cameras} cameras)`);
    applyOriginRebase(plan);

    check(Array.from(p.groups.gBare.points3d).every((v, i) =>
            (Number.isNaN(v) && Number.isNaN(bareBefore[i])) || v === bareBefore[i]),
        'the omitted session\'s 3D is bit-identical — not re-based, not perturbed');
    check(camC.rvec.every((v, i) => v === camCBefore.r[i]) &&
          camC.tvec.every((v, i) => v === camCBefore.t[i]),
        'and so are its cameras, so the two moved together by not moving at all');
    check(Math.abs(toPixel(camC, getPoint3d(p.groups.gBare.points3d, 0))[0] - pixBefore.bb[0]) < 1e-9,
        'every pixel in the omitted session is exactly where it was');

    // …while the chosen session DID move, both halves of it.
    const userAfter = getPoint3d(p.groups.gUser.points3d, 0);
    check(!near(userAfter[2], userBefore[2], 1e-6),
        `the chosen session's 3D moved (z ${userBefore[2]} -> ${userAfter[2].toFixed(3)})`);
    check(Math.abs(toPixel(camA, userAfter)[0] - pixBefore.aa[0]) < 1e-6 &&
          Math.abs(toPixel(camA, userAfter)[1] - pixBefore.aa[1]) < 1e-6,
        'and its pixels did not — points and cameras moved together, as always');

    // THE HAZARD, made concrete: the plane pool is project-scoped and moved
    // with the active session, so the omitted session's 3D is now expressed in
    // a different frame from it. Nothing on screen contradicts that, which is
    // why the dialog has to say it — and why the next load's
    // `compareSessionCalibrations` note exists.
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const dBefore = d(bareBefore.slice(0, 3), [-40.678, -30.234, 216.588]);
    const dAfter = d(getPoint3d(p.groups.gBare.points3d, 0), Array.from(p.pool[0].xyz));
    check(Math.abs(dAfter - dBefore) > 1,
        `and the project now measures a DIFFERENT distance between that session's 3D ` +
        `and the project-wide plane pool — two frames in one project ` +
        `(${dBefore.toFixed(1)} mm -> ${dAfter.toFixed(1)} mm)`);
}

console.log('\n11c. NEGATIVE CONTROL: the omitted session moves when it IS included');
{
    // 11b would pass on a build where `gBare` simply never moves — because it
    // is member-less, or because the plane's session walk skips a session with
    // no `frameGroups`. Handing in both sessions has to move it.
    const p = buildProject();
    const bareBefore = Array.from(p.groups.gBare.points3d);
    const camCBefore = p.cams[2].tvec.slice();
    applyOriginRebase(await planOriginRebase(p.sessions, p.model, FRAME));
    check(!near(p.groups.gBare.points3d[2], bareBefore[2], 1e-6),
        `the same point DOES move when its session is included ` +
        `(z ${bareBefore[2]} -> ${p.groups.gBare.points3d[2].toFixed(3)})`);
    check(!near(p.cams[2].tvec[2], camCBefore[2], 1e-6),
        'and so does its camera');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
