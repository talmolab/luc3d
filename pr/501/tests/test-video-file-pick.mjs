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
    matchVideoToCamera,
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

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
