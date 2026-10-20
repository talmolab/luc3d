/**
 * test-skeleton-edit-impact.mjs — what the skeleton-edit confirmation counts.
 *
 * The dialog's whole job is to state, truthfully and before anything is
 * mutated, how much annotation a node/edge edit is about to re-shape. Three
 * ways that goes wrong, each pinned here:
 *
 *  1. **Counting `frameGroups` on a LAZY project.** `session.frameGroups` is a
 *     small resident window (31 of 180,210 frames on the real project), so a
 *     tally built from it returns a plausible, tiny, wrong number — and a
 *     confirmation that understates the damage is worse than none. The lazy
 *     branch goes through `lazyLoader.forEachInstanceRow`, the columnar store.
 *  2. **Counting only grouped instances.** Most of an imported `.slp` is
 *     ungrouped predictions in `FrameGroup.unlinkedInstances`. This is the same
 *     mistake `pose/origin-rebase.js` already made once and the reason both
 *     modules walk the project the same way.
 *  3. **Counting sessions the edit does not reach.** "One skeleton per project"
 *     means every session moves together, but a session carrying a
 *     DIFFERENT-shaped skeleton does not, and must not be in the total.
 *
 * Plus the gate: a project with nothing annotated must apply the edit straight
 * through, or building the first skeleton raises a modal per node typed.
 *
 * DOM-free, so `tests/run-mjs-tests.mjs` picks it up. `pose/pose-data.js` is
 * importable from Node, so the fixtures are REAL `Session`/`Instance` objects
 * rather than shapes that only look like them.
 */
import {
    Skeleton, Camera, Session, Instance, InstanceGroup, FrameGroup, UnlinkedInstance,
} from '../pose/pose-data.js';
import {
    splitSessionsBySkeleton, countSkeletonEditImpact, skeletonEditNeedsConfirmation,
} from '../pose/skeleton-edit-impact.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};

const MTX = [[1000, 0, 256], [0, 1000, 256], [0, 0, 1]];
const cams = (names) => names.map((n) => new Camera(n, MTX, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [512, 512]));
const skel = () => new Skeleton('mouse', ['nose', 'tail'], [[0, 1]]);
const inst = (type) => new Instance([[1, 2], [3, 4]], 0, type, 1);

/**
 * A session with `nGrouped` grouped instances per camera and `nUnlinked`
 * ungrouped ones, on frame 0. The two pools are disjoint, exactly as
 * `restoreGroupingAndUnlink` leaves them.
 */
function eagerSession(name, sk, nGrouped, nUnlinked, withPoints3d) {
    const s = new Session(cams(['cam1', 'cam2']), sk, ['t0'], name);
    const fg = new FrameGroup(0);
    s.addFrameGroup(fg);
    const groups = [];
    for (let g = 0; g < nGrouped; g++) {
        const ig = new InstanceGroup(g + 1, -1);
        for (const cn of ['cam1', 'cam2']) {
            const i = inst(g === 0 ? 'user' : 'predicted');
            ig.addInstance(cn, i);
            fg.addInstance(cn, i);
        }
        if (withPoints3d) {
            ig.points3d = new Float64Array([1, 2, 3, 4, 5, 6]);
            ig.addReprojectedInstance('cam1', inst('reprojected'));
        }
        groups.push(ig);
    }
    if (groups.length) s.instanceGroups.set(0, groups);
    for (let u = 0; u < nUnlinked; u++) {
        fg.addUnlinkedInstance('cam1', new UnlinkedInstance(inst('predicted'), 'cam1'));
    }
    return s;
}

console.log('\n1. An eager project counts grouped AND ungrouped instances');
{
    // 2 groups x 2 cameras = 4 grouped (2 user in group 1, 2 predicted in
    // group 2), plus 3 ungrouped predictions. Counting only the grouped half
    // would say 4 on a project holding 7.
    const s = eagerSession('S', skel(), 2, 3, true);
    const t = countSkeletonEditImpact([s]);
    check(t.userInstances === 2, `2 user 2D instances (got ${t.userInstances})`);
    check(t.predictedInstances === 5,
        `5 predicted — 2 grouped + 3 ungrouped (got ${t.predictedInstances})`);
    check(t.instances === 7, `7 instances in total (got ${t.instances})`);
    check(t.groups === 2, `2 instance groups (got ${t.groups})`);
    check(t.keypoints3d === 4, `4 triangulated keypoints, 2 per group (got ${t.keypoints3d})`);
    check(t.reprojectedInstances === 2, `2 cached reprojections (got ${t.reprojectedInstances})`);
    check(t.anyLazy === false, 'an eager project is not flagged lazy');
    check(t.perSession.length === 1 && t.perSession[0].name === 'S',
        'and there is one perSession record, named after the session');
}

console.log('\n2. The total is a FOLD of perSession, across every session');
{
    // One skeleton object shared by both, which is what `setProjectSkeleton`
    // produces. The dialog prints a row each and a total, and the two must be
    // the same arithmetic — so the total is summed from the records rather
    // than counted a second way.
    const sk = skel();
    const a = eagerSession('A', sk, 1, 2, true);
    const b = eagerSession('B', sk, 2, 0, false);
    const t = countSkeletonEditImpact([a, b]);
    check(t.sessions === 2, `2 sessions (got ${t.sessions})`);
    let sumUser = 0, sumPred = 0, sumGroups = 0;
    for (const ps of t.perSession) { sumUser += ps.userInstances; sumPred += ps.predictedInstances; sumGroups += ps.groups; }
    check(sumUser === t.userInstances && sumPred === t.predictedInstances && sumGroups === t.groups,
        'every headline total equals the sum of the per-session rows');
    check(t.userInstances === 4, `4 user instances across both (got ${t.userInstances})`);
    check(t.groups === 3, `3 instance groups across both (got ${t.groups})`);
    check(t.keypoints3d === 2,
        `only session A has 3D, so 2 keypoints (got ${t.keypoints3d})`);
}

console.log('\n3. A LAZY session is counted from the STORE, not the resident window');
{
    // The failure this guards: 4 resident frames of 180,000 would report the
    // four, and the user would approve an edit against a number three orders
    // of magnitude too small. The loader stands in for `SioLazyLoader` with
    // the two members the tally reads.
    const sk = skel();
    const s = eagerSession('Lazy', sk, 1, 1, false);   // 3 resident instances
    s.lazyLoader = {
        nFrames: 180210,
        forEachInstanceRow(fn) {
            for (let i = 0; i < 500; i++) {
                fn('cam1', i, 0, { type: i < 20 ? 'user' : 'predicted' });
            }
        },
    };
    const t = countSkeletonEditImpact([s]);
    check(t.instances === 500,
        `the store's 500 rows, not the 3 resident instances (got ${t.instances})`);
    check(t.userInstances === 20 && t.predictedInstances === 480,
        `split by the store's own instance_type column (got ${t.userInstances}/${t.predictedInstances})`);
    check(t.perSession[0].instanceScope === 'store',
        'and the record says WHICH enumeration answered');

    check(t.anyLazy === true && t.lazySessions === 1, 'the session is flagged lazy');
    check(t.totalFrames === 180210, `total frames reported (got ${t.totalFrames})`);
    check(t.residentFrames === 1, `1 frame group is resident (got ${t.residentFrames})`);
    check(t.nonResidentFrames === 180209,
        `so 180,209 frames would keep the OLD skeleton (got ${t.nonResidentFrames})`);
}

console.log('\n3b. NEGATIVE CONTROL: a fully-resident loader is not "lazy"');
{
    // A project small enough to load whole still has a `lazyLoader`. Flagging
    // it would put the red "strongly not recommended" warning on a project
    // where the edit is completely safe, and a warning that fires when nothing
    // is wrong is a warning nobody reads.
    const s = eagerSession('Small', skel(), 1, 0, false);
    s.lazyLoader = { nFrames: 1, forEachInstanceRow(fn) { fn('cam1', 0, 0, { type: 'user' }); } };
    const t = countSkeletonEditImpact([s]);
    check(t.anyLazy === false,
        'resident === total is not lazy, however the project was loaded');
    check(t.nonResidentFrames === 0, 'and nothing is off-screen to warn about');
}

console.log('\n4. Only sessions on the SAME skeleton are counted');
{
    // `splitSessionsBySkeleton` is what decides the scope of the whole dialog.
    // A session whose skeleton has a different SHAPE is not re-shaped by this
    // edit, so counting its annotations would describe work that never happens.
    const sk = skel();
    const same = eagerSession('same', sk, 1, 0, false);
    const copy = eagerSession('copy', new Skeleton('mouse', ['nose', 'tail'], [[0, 1]]), 1, 0, false);
    const other = eagerSession('other', new Skeleton('fly', ['head', 'thorax', 'abdomen'], []), 1, 0, false);

    const split = splitSessionsBySkeleton([same, copy, other], sk);
    check(split.shared.length === 2,
        `the shared object AND a same-shaped copy are in scope (got ${split.shared.length})`);
    check(split.shared.indexOf(copy) >= 0,
        'compatibilityKey, not reference identity alone, is what makes the copy count');
    check(split.others.length === 1 && split.others[0] === other,
        'the differently-shaped skeleton is reported separately, not silently dropped');

    const t = countSkeletonEditImpact(split.shared);
    check(t.sessions === 2, `and the tally covers exactly those two (got ${t.sessions})`);
}

console.log('\n4b. A node RENAME changes the shape, so the scope follows it');
{
    // compatibilityKey is the set of node NAMES plus the edges as unordered
    // name pairs — so two sessions whose skeletons differ by one node name are
    // genuinely not interchangeable, and the split says so. This is the
    // property that keeps a half-renamed project from being counted as one.
    const sk = skel();
    const renamed = eagerSession('renamed', new Skeleton('mouse', ['snout', 'tail'], [[0, 1]]), 1, 0, false);
    const split = splitSessionsBySkeleton([renamed], sk);
    check(split.shared.length === 0 && split.others.length === 1,
        'one differing node name puts the session out of scope');
}

console.log('\n5. The gate: nothing annotated means no dialog');
{
    // Building the first skeleton is N node names typed into a box. A modal
    // per node would make the feature unusable, so the dialog is skipped
    // outright when there is nothing to warn about.
    const empty = new Session(cams(['cam1']), skel(), ['t0'], 'empty');
    check(skeletonEditNeedsConfirmation(countSkeletonEditImpact([empty])) === false,
        'a session with no frames and no groups needs no confirmation');

    check(skeletonEditNeedsConfirmation(countSkeletonEditImpact([eagerSession('one', skel(), 1, 0, false)])) === true,
        'one instance is enough to need it');

    // 3D with no resident 2D still counts: a reopened lazy project can hold
    // triangulated groups whose instances have all been released.
    const only3d = new Session(cams(['cam1']), skel(), ['t0'], 'only3d');
    const g = new InstanceGroup(1, -1);
    g.points3d = new Float64Array([1, 2, 3]);
    only3d.instanceGroups.set(0, [g]);
    check(skeletonEditNeedsConfirmation(countSkeletonEditImpact([only3d])) === true,
        'so does a triangulated group with no resident 2D');

    // And a lazy session whose store has not been walked yet: the counts can
    // all be zero while the annotations are sitting in the file.
    const lazyEmpty = new Session(cams(['cam1']), skel(), ['t0'], 'lazyEmpty');
    lazyEmpty.lazyLoader = { nFrames: 1000, forEachInstanceRow() {} };
    check(skeletonEditNeedsConfirmation(countSkeletonEditImpact([lazyEmpty])) === true,
        'and a lazy project always does, whatever the counts say');
}

console.log('\n6. The tally MUTATES NOTHING');
{
    // It runs before the user has agreed to anything, so a dialog that
    // modified the project to describe it would be the worst possible bug in
    // this feature.
    const sk = skel();
    const s = eagerSession('S', sk, 1, 1, true);
    const g = s.instanceGroups.get(0)[0];
    const before = {
        nodes: sk.nodes.join(','),
        edges: JSON.stringify(sk.edges),
        pts3d: Array.from(g.points3d).join(','),
        reproj: g.reprojectedInstances.size,
        dirty: g.dirty,
        nodeCount: g.getInstance('cam1').numNodes,
    };
    countSkeletonEditImpact([s]);
    check(sk.nodes.join(',') === before.nodes && JSON.stringify(sk.edges) === before.edges,
        'the skeleton is untouched');
    check(Array.from(g.points3d).join(',') === before.pts3d, 'the 3D is untouched');
    check(g.reprojectedInstances.size === before.reproj && g.dirty === before.dirty,
        'the reprojection cache and the dirty flag are untouched');
    check(g.getInstance('cam1').numNodes === before.nodeCount, 'and no instance was re-shaped');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
