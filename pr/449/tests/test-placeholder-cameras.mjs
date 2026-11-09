/**
 * test-placeholder-cameras.mjs — `pose/placeholder-cameras.js`: an UNCALIBRATED
 * session gets a stand-in camera for every view, video and 2D camera key, and
 * a calibrated one is never touched.
 *
 * REGRESSION: a session folder loaded with no `calibration.toml` had NO
 * cameras (the per-camera and single-`.slp` folder loaders created none), and
 * the `.slp` writer writes one video per `session.cameras` entry and drops
 * every pose whose camera is not in that list — so File ▸ Save wrote an empty
 * project ("Saved (0.0 MB)") and the reopened file had no views and no poses.
 * The loaders and `buildSlpBytes` now call `ensurePlaceholderCameras`; this
 * pins the rule they share. End to end: `tests/e2e/nocalib-folder-save-reopen.mjs`.
 *
 * Run:  node tests/test-placeholder-cameras.mjs
 */
import {
    Session, Skeleton, Camera, Instance, FrameGroup, InstanceGroup,
} from '../pose/pose-data.js';
import {
    makePlaceholderCamera, isPlaceholderCamera, hasRealCalibration,
    cameraNamesInUse, ensurePlaceholderCameras, PLACEHOLDER_DEFAULT_SIZE,
} from '../pose/placeholder-cameras.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b),
    `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);

const skel = () => new Skeleton('sk', ['a', 'b'], [[0, 1]]);
const inst = (x) => new Instance([[x, x + 1], [x + 2, x + 3]], 0, 'user', 1);

console.log('\n§1 makePlaceholderCamera / isPlaceholderCamera');
{
    const c = makePlaceholderCamera('left', 1280, 720);
    eq(c.name, 'left', 'named');
    eq(c.size, [1280, 720], 'sized from the video');
    eq(c.matrix, [[600, 0, 640], [0, 600, 360], [0, 0, 1]], 'f = 600, principal point at the centre (Load Videos\' shape)');
    eq([c.rvec, c.tvec, c.dist], [[0, 0, 0], [0, 0, 0], [0, 0, 0, 0, 0]], 'all-zero extrinsics and distortion');
    check(c instanceof Camera, 'a real Camera (so getRotationMatrix etc. exist)');
    eq(makePlaceholderCamera('x').size, PLACEHOLDER_DEFAULT_SIZE, 'unknown size → the default');
    check(isPlaceholderCamera(c), 'a placeholder is recognised');
    check(!isPlaceholderCamera(new Camera('r', c.matrix, [0, 0, 0, 0, 0], [0.1, 0, 0], [0, 0, 0], [10, 10])),
        'a camera with any rotation is calibrated');
    check(!isPlaceholderCamera(new Camera('t', c.matrix, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 5], [10, 10])),
        'a camera with any translation is calibrated');
    check(!isPlaceholderCamera(new Camera('m', c.matrix, [0, 0, 0, 0, 0],
        [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0], [10, 10])),
        'an anipose 3×3 rotation matrix is calibrated (as view-align-modal isCalibrated says)');
    check(!hasRealCalibration(new Session([], skel(), ['t'], 's')), 'no cameras → no calibration');
    check(!hasRealCalibration(new Session([c], skel(), ['t'], 's')), 'only placeholders → no calibration');
}

console.log('\n§2 the per-camera folder case: views + 2D keys, no cameras');
{
    const s = new Session([], skel(), ['t'], 'nocal');
    const fg = new FrameGroup(0); s.addFrameGroup(fg);
    fg.addInstance('cam1', inst(1));
    fg.addInstance('cam2', inst(2));
    fg.instances.set('ghost-empty', []);            // an empty list is not "in use"
    const views = [
        { name: 'cam2', videoWidth: 256, videoHeight: 32 },
        { name: 'cam1', videoWidth: 320, videoHeight: 240 },
    ];
    const vfs = [
        { name: 'cam1', assignedCamera: null, videoWidth: 320, videoHeight: 240 },
        { name: 'cam2', assignedCamera: null, videoWidth: 256, videoHeight: 32 },
        { name: 'cam3', assignedCamera: null, videoWidth: 0, videoHeight: 0 },   // deferred decode
    ];
    eq(cameraNamesInUse(s, views, vfs), ['cam2', 'cam1', 'cam3'], 'views first (on-screen order), then videos');
    const added = ensurePlaceholderCameras(s, views, vfs);
    eq(added, ['cam2', 'cam1', 'cam3'], 'one camera per name, in that order');
    eq(s.cameras.map(c => c.name), ['cam2', 'cam1', 'cam3'], 'appended to session.cameras');
    eq(s.cameras.map(c => c.size), [[256, 32], [320, 240], PLACEHOLDER_DEFAULT_SIZE], 'each sized from its view / video');
    check(s.cameras.every(isPlaceholderCamera), 'all placeholders (3D stays off)');
    eq(vfs.map(v => v.assignedCamera), ['cam1', 'cam2', 'cam3'], 'every unassigned video is assigned to its camera');
    eq(ensurePlaceholderCameras(s, views, vfs), [], 'idempotent: a second call adds nothing');
    eq(s.cameras.length, 3, '…and duplicates nothing');
}

console.log('\n§3 2D keys with no view (unlinked, groups, a lazy store) still get a camera');
{
    const s = new Session([], skel(), ['t'], 'keys');
    const fg = new FrameGroup(3); s.addFrameGroup(fg);
    fg.unlinkedInstances.set('side', [{ instance: inst(5), cameraName: 'side' }]);
    const g = new InstanceGroup(1, -1);
    g.addInstance('top', inst(6));
    s.instanceGroups.set(3, [g]);
    s.lazyLoader = { labelsByCam: new Map([['back', {}], ['side', {}]]) };
    eq(cameraNamesInUse(s, [], []), ['side', 'top', 'back'], 'unlinked, then group members, then lazy stores');
    eq(ensurePlaceholderCameras(s, [], []), ['side', 'top', 'back'], 'each gets a placeholder');
}

console.log('\n§4 an existing placeholder (Load Videos) is kept; only the gaps are filled');
{
    const lv = makePlaceholderCamera('a', 640, 480);
    const s = new Session([lv], skel(), ['t'], 'mixed-placeholders');
    const vfs = [{ name: 'a', assignedCamera: 'a' }, { name: 'b', assignedCamera: null }];
    eq(ensurePlaceholderCameras(s, [{ name: 'a' }, { name: 'b' }], vfs), ['b'], 'adds only the missing camera');
    check(s.cameras[0] === lv, 'the existing camera object is untouched');
    eq(vfs[1].assignedCamera, 'b', 'and assigns its video');
}

console.log('\n§5 a CALIBRATED session is never touched (a stand-in would join triangulation)');
{
    const real = new Camera('cam1', [[1000, 0, 320], [0, 1000, 240], [0, 0, 1]],
        [0, 0, 0, 0, 0], [0.1, 0.2, 0.3], [10, 0, 0], [640, 480]);
    const s = new Session([real], skel(), ['t'], 'cal');
    const fg = new FrameGroup(0); s.addFrameGroup(fg);
    fg.addInstance('ghost', inst(1));                 // a stray key, as a bad import leaves
    const vfs = [{ name: 'other', assignedCamera: null }];
    check(hasRealCalibration(s), 'recognised as calibrated');
    eq(ensurePlaceholderCameras(s, [{ name: 'ghost' }], vfs), [], 'adds nothing');
    eq(s.cameras.map(c => c.name), ['cam1'], 'cameras unchanged');
    eq(vfs[0].assignedCamera, null, 'video assignment unchanged');
    // A rig whose reference camera sits at the origin is still calibrated.
    const ref = makePlaceholderCamera('ref', 640, 480);
    const s2 = new Session([ref, real], skel(), ['t'], 'cal-ref-at-origin');
    eq(ensurePlaceholderCameras(s2, [{ name: 'ghost' }], []), [], 'a rig with its reference camera at the origin is left alone');
}

console.log('\n§6 nothing to do');
{
    eq(ensurePlaceholderCameras(null, [], []), [], 'no session → []');
    const s = new Session([], skel(), ['t'], 'empty');
    eq(ensurePlaceholderCameras(s), [], 'no views, videos or poses → no cameras');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
