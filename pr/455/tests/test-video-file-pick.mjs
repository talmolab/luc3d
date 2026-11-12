/**
 * test-video-file-pick.mjs — which of a camera's candidate videos loads.
 *
 * Issue #199: an alpha tester named their session videos `cam#-calibration.mp4`
 * and NOTHING loaded, with no message saying why. The cause was that the
 * `-calibration` / `_calibration` filename stem was a HARD exclusion, sharing
 * one predicate with the `calibration_images/` path rule that actually
 * identifies a per-camera calibration clip. On the real session folders all 38
 * calibration clips live under `calibration_images/` and none outside it, so
 * the stem rule excluded only false positives.
 *
 * The two rules are now split, and the split is what this file pins:
 *   - path segment  -> HARD exclusion, whatever else the folder holds
 *   - filename stem -> SOFT, loses only to a plainly-named sibling of the SAME
 *                      camera
 *
 * Grouping per CAMERA rather than per folder is load-bearing: a folder-wide
 * rule would let one camera's plain video suppress another camera's only one.
 *
 * `loading/video-file-pick.js` has NO imports precisely so this test can exist
 * — `session-loader.js` reaches Three.js through a CDN specifier and cannot be
 * loaded by Node at all. ESM, so `tests/run-mjs-tests.mjs` picks it up.
 */
import {
    isCalibrationImagesVideo, hasCalibrationStem, preferNonCalibrationVideos,
    matchVideoToCamera, assignFolderVideos, isFolderPick, isVideoFileName,
} from '../loading/video-file-pick.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};

/** A picked file, as `webkitdirectory` hands it over. */
const f = (relPath) => ({ name: relPath.split('/').pop(), webkitRelativePath: relPath });
/** A file picked individually — no relative path at all. */
const bare = (name) => ({ name });
const names = (arr) => arr.map((x) => x.name);

console.log('\n1. The path rule is the hard one, and it is the one real clips trip');
{
    // The real layout, from every session folder on disk.
    check(isCalibrationImagesVideo(
        f('10072022145420/back/calibration_images/10072022145420-back-calibration.mp4')),
        'a clip under calibration_images/ is excluded');
    // Robust to which directory the user picked as the root — the segment is
    // matched anywhere, not at a fixed depth.
    check(isCalibrationImagesVideo(f('calibration_images/10072022145420-back-calibration.mp4')),
        'and still excluded when the user picked the camera folder itself');
    check(isCalibrationImagesVideo(f('CALIBRATION_IMAGES/x.mp4')),
        'case-insensitively');
    check(isCalibrationImagesVideo(f('back/calibration_images_old/x.mp4')) === false,
        'but a merely similar directory name is not a path match');
    check(isCalibrationImagesVideo(f('sess/back/back.mp4')) === false,
        'an ordinary session video is not excluded');
    check(isCalibrationImagesVideo(null) === false, 'null does not throw');
}

console.log('\n2. The stem rule no longer excludes anything by itself');
{
    // THE REGRESSION. On the pre-fix build both of these were dropped outright.
    check(isCalibrationImagesVideo(bare('cam1-calibration.mp4')) === false,
        'cam1-calibration.mp4 is NOT a hard exclusion (#199)');
    check(isCalibrationImagesVideo(bare('cam1_calibration.mp4')) === false,
        'nor is cam1_calibration.mp4 — the separator was never the difference');

    // It is still recognised, as a hint.
    check(hasCalibrationStem(bare('cam1-calibration.mp4')), 'but the stem is still recognised');
    check(hasCalibrationStem(bare('cam1_calibration.mp4')), 'with either separator');
    check(hasCalibrationStem(bare('CAM1-Calibration.MP4')), 'case-insensitively');
    check(hasCalibrationStem(bare('calibration-cam1.mp4')) === false,
        'the rule is positional: calibration at the FRONT is not a hint');
    check(hasCalibrationStem(bare('cam1.mp4')) === false, 'and a plain name is not');
    check(hasCalibrationStem(null) === false, 'null does not throw');
}

console.log('\n3. A calibration-named video loses to a plain sibling of the same camera');
{
    const files = [bare('cam1-calibration.mp4'), bare('cam1.mp4')];
    const r = preferNonCalibrationVideos(files, (x) => matchVideoToCamera(x, ['cam1']));
    check(names(r.kept).join(',') === 'cam1.mp4', 'cam1.mp4 is kept');
    check(names(r.dropped).join(',') === 'cam1-calibration.mp4', 'cam1-calibration.mp4 is dropped');

    // The whole point of de-prioritizing rather than ordering: the answer must
    // not depend on which the folder enumerated first.
    const rev = preferNonCalibrationVideos(files.slice().reverse(),
        (x) => matchVideoToCamera(x, ['cam1']));
    check(names(rev.kept).join(',') === 'cam1.mp4',
        'and the answer does not depend on enumeration order');
}

console.log('\n4. ...but it WINS when it is that camera\'s only candidate');
{
    // The alpha tester's folder. Every camera's sole video is calibration-named.
    const cams = ['cam1', 'cam2', 'cam3'];
    const files = cams.map((c) => bare(c + '-calibration.mp4'));
    const r = preferNonCalibrationVideos(files, (x) => matchVideoToCamera(x, cams));
    check(r.dropped.length === 0, 'nothing is dropped');
    check(r.kept.length === 3, 'all three load (#199 — this loaded ZERO before)');
}

console.log('\n5. The grouping is per CAMERA, not per folder');
{
    // cam1 has a plain video; cam2 has only a calibration-named one. A
    // folder-wide rule would let cam1's video suppress cam2's only candidate,
    // silently costing a whole view.
    const cams = ['cam1', 'cam2'];
    const files = [bare('cam1.mp4'), bare('cam1-calibration.mp4'), bare('cam2-calibration.mp4')];
    const r = preferNonCalibrationVideos(files, (x) => matchVideoToCamera(x, cams));
    check(names(r.kept).sort().join(',') === 'cam1.mp4,cam2-calibration.mp4',
        'cam1 takes its plain video, cam2 keeps its only one');
    check(names(r.dropped).join(',') === 'cam1-calibration.mp4',
        'and only cam1\'s redundant clip is dropped');
}

console.log('\n6. A file that matches no camera is never dropped');
{
    // Nothing says it is redundant — there is no group to be redundant within.
    // What happens to it is the caller's matcher's business, not this one's.
    const r = preferNonCalibrationVideos(
        [bare('something-calibration.mp4'), bare('cam1.mp4')],
        (x) => matchVideoToCamera(x, ['cam1']));
    check(r.dropped.length === 0, 'an unmatched calibration-named file survives');
    check(r.kept.length === 2, 'alongside the matched one');
}

console.log('\n7. Order is preserved, and the caller\'s array is not mutated');
{
    const arr = [bare('cam2.mp4'), bare('cam1-calibration.mp4'), bare('cam1.mp4')];
    const before = names(arr).join(',');
    const r = preferNonCalibrationVideos(arr, (x) => matchVideoToCamera(x, ['cam1', 'cam2']));
    check(names(r.kept).join(',') === 'cam2.mp4,cam1.mp4',
        'kept files stay in the order they arrived');
    check(names(arr).join(',') === before,
        'and the caller\'s array comes back untouched');
    const empty = preferNonCalibrationVideos(null, () => 'x');
    check(empty.kept.length === 0 && empty.dropped.length === 0, 'null input does not throw');
}

console.log('\n8. matchVideoToCamera: directory beats stem beats referenced name');
{
    // Parent directory first — it is the layout the per-camera loaders rely on,
    // and a filename that happens to contain another camera's name must not
    // override the folder the file actually sits in.
    check(matchVideoToCamera(f('sess/back/20260101-mid-raw.mp4'), ['back', 'mid']) === 'back',
        'the parent directory wins over a camera name in the stem');
    check(matchVideoToCamera(bare('20260101-cam1-raw.mp4'), ['cam1']) === 'cam1',
        'the camera name is matched ANYWHERE in the stem, not only at the end (#199)');
    check(matchVideoToCamera(bare('CAM1.mp4'), ['cam1']) === 'cam1', 'case-insensitively');

    // The referenced-filename fallback, for a project file whose videos were
    // renamed on disk.
    const refs = new Map([['back', 'recording_07']]);
    check(matchVideoToCamera(bare('recording_07.mp4'), ['back'], refs) === 'back',
        'falls back to the filename the project references');
    check(matchVideoToCamera(bare('nothing.mp4'), ['back'], refs) === null,
        'and gives null when nothing matches');
    check(matchVideoToCamera(bare('x.mp4'), []) === null, 'no cameras gives null');
}

console.log('\n3. A picked recording folder: one video per camera, extras left out');
{
    const cams = ['Camera1_topB', 'Camera2_topB'];
    // campy's layout: every camera's video is 0.mp4, beside cameras the file
    // does not name, a calibration clip and a non-video.
    const files = [
        f('rec/Camera5_side/0.mp4'),
        f('rec/Camera2_topB/0.mp4'),
        f('rec/Camera1_topB/0.mp4'),
        f('rec/Camera1_topB/calibration_images/x.mp4'),
    ];
    const refs = new Map([['Camera1_topB', '/data/rec/Camera1_topB/0.mp4'], ['Camera2_topB', '/data/rec/Camera2_topB/0.mp4']]);
    const r = assignFolderVideos(files.slice(0, 3), cams, refs);
    check(r.cameraOf.get(files[2]) === 'Camera1_topB' && r.cameraOf.get(files[1]) === 'Camera2_topB',
        'each video goes to the camera its folder names');
    check(r.unused.length === 1 && r.unused[0] === files[0],
        'the side camera\'s 0.mp4 is left out, not bound by its shared name');
    check(names(r.assigned).length === 2 && r.assigned[0] === files[2], 'assigned comes back in camera order');

    // Cameras renamed on the way in (Add SLP suffixes a taken name): the
    // referenced folder + name still finds them, and still not the extra.
    const renamed = ['Camera1_topB_2', 'Camera2_topB_2'];
    const refs2 = new Map([[renamed[0], refs.get(cams[0])], [renamed[1], refs.get(cams[1])]]);
    const r2 = assignFolderVideos(files.slice(0, 3), renamed, refs2);
    check(r2.cameraOf.get(files[2]) === renamed[0] && r2.cameraOf.get(files[1]) === renamed[1] && r2.unused[0] === files[0],
        'the referenced folder and file name match when the camera name does not');

    // The referenced file name alone counts only when one picked video has it.
    const r3 = assignFolderVideos([f('new/a/0.mp4'), f('new/b/0.mp4')], ['cam'], new Map([['cam', 'old/x/0.mp4']]));
    check(r3.assigned.length === 0, 'a shared file name binds nothing');
    const r4 = assignFolderVideos([f('new/a/take3.mp4'), f('new/b/other.mp4')], ['cam'], new Map([['cam', 'C:\\old\\x\\take3.mp4']]));
    check(r4.cameraOf.get(r4.assigned[0]) === 'cam' && r4.assigned[0].name === 'take3.mp4',
        'a unique referenced file name binds, in a moved folder and with Windows separators');

    // One video per camera, and a calibration-named one loses a tie.
    const both = [f('rec/cam1/cam1-calibration.mp4'), f('rec/cam1/cam1.mp4')];
    const r5 = assignFolderVideos(both, ['cam1'], null);
    check(r5.assigned[0] === both[1] && r5.unused[0] === both[0], 'a plain sibling beats a -calibration stem');
    check(assignFolderVideos([f('r/x/20260101-cam2-raw.mp4')], ['cam2']).assigned.length === 1,
        'the camera name in the stem still binds');
    check(assignFolderVideos([], ['cam']).assigned.length === 0 && assignFolderVideos(null, null).unused.length === 0,
        'empty input');

    check(isFolderPick([bare('a.mp4'), f('rec/a/a.mp4')]) && !isFolderPick([bare('a.mp4')]) && !isFolderPick(null),
        'isFolderPick: a relative path with a folder in it');
    check(isVideoFileName('X.MOV') && !isVideoFileName('session.json') && !isVideoFileName('mp4'),
        'isVideoFileName');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
