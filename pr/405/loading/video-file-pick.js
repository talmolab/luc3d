/**
 * video-file-pick.js — which of a camera's candidate videos is the session
 * recording.
 *
 * DOM-free and IMPORT-FREE on purpose, exactly like `loading/calibration-pick.js`:
 * `session-loader.js` reaches Three.js through a CDN specifier and so cannot be
 * loaded by a Node test, while the decision made here is pure and worth pinning.
 *
 * TWO rules, and the split between them is the whole point:
 *
 * - `isCalibrationImagesVideo` is a HARD exclusion. A clip under a
 *   `calibration_images/` path segment is a per-camera calibration recording
 *   (`back/calibration_images/<date>-back-calibration.mp4`). Its filename embeds
 *   the camera name, so the substring matchers in `session-loader.js` and
 *   `slp-import.js` would otherwise bind it to a real camera and surface it as
 *   an extra view. No such file is ever the session recording, so it is dropped
 *   whatever else the folder holds.
 *
 * - `hasCalibrationStem` is a SOFT, de-prioritizing signal. A stem ending in
 *   `-calibration` / `_calibration` used to be a hard exclusion too, and that
 *   silently dropped `cam1-calibration.mp4` — an ordinary session video an alpha
 *   tester had simply named that way, which then loaded NOTHING with no message
 *   saying why (issue #199). The name is a hint about which of several
 *   candidates is the recording, never proof that a file is not one. So it only
 *   loses to a non-calibration sibling *of the same camera*: given both
 *   `cam1.mp4` and `cam1-calibration.mp4`, `cam1.mp4` wins; given only the
 *   latter, it is the recording and it loads.
 *
 * The grouping is per CAMERA, not per folder, because that is the scope in
 * which "is there a better candidate?" is a meaningful question. A folder-wide
 * rule would let one camera's plain video suppress another camera's only video.
 */

/**
 * True for a per-camera calibration clip, identified by a `calibration_images`
 * path segment. Matched on any segment, so the answer does not depend on which
 * directory the user picked as the root.
 */
export function isCalibrationImagesVideo(file) {
    if (!file) return false;
    var relPath = (file.webkitRelativePath || file.name || '').replace(/\\/g, '/').toLowerCase();
    return relPath.split('/').indexOf('calibration_images') >= 0;
}

/** True if the filename stem ends in `-calibration` or `_calibration`. */
export function hasCalibrationStem(file) {
    if (!file) return false;
    var stem = String(file.name || '').toLowerCase().replace(/\.[^.]+$/, '');
    return stem.endsWith('-calibration') || stem.endsWith('_calibration');
}

/**
 * Drop each calibration-STEMMED video that has a non-calibration sibling under
 * the same group key; keep everything else, in the order given.
 *
 * `groupKeyFn(file, index)` names the camera a file belongs to. A file whose key
 * is null/undefined matched no camera and is never dropped — nothing says it is
 * redundant, and the caller's own matcher decides what to do with it.
 *
 * @param {ArrayLike<File>} files
 * @param {(file: File, index: number) => (string|null|undefined)} [groupKeyFn]
 * @returns {{kept: File[], dropped: File[]}}
 */
export function preferNonCalibrationVideos(files, groupKeyFn) {
    var list = files ? Array.prototype.slice.call(files) : [];
    var keys = new Array(list.length);
    // Groups that already hold a non-calibration candidate.
    var hasPlain = Object.create(null);
    for (var i = 0; i < list.length; i++) {
        var k = groupKeyFn ? groupKeyFn(list[i], i) : null;
        keys[i] = (k === null || k === undefined) ? null : String(k);
        if (keys[i] !== null && !hasCalibrationStem(list[i])) hasPlain[keys[i]] = true;
    }

    var kept = [];
    var dropped = [];
    for (var j = 0; j < list.length; j++) {
        if (keys[j] !== null && hasCalibrationStem(list[j]) && hasPlain[keys[j]]) dropped.push(list[j]);
        else kept.push(list[j]);
    }
    return { kept: kept, dropped: dropped };
}

/**
 * The camera a video belongs to, by the three signals every load path shares:
 * the parent directory name, the camera name appearing anywhere in the filename
 * stem, and the video filename the project file references for that camera.
 * All comparisons are case-insensitive. Returns null when nothing matches.
 *
 * @param {File} file
 * @param {string[]} cameraNames
 * @param {Map<string,string>} [refBaseByCam] camera name -> referenced video
 *   basename, already lowercased and stripped of its extension.
 */
export function matchVideoToCamera(file, cameraNames, refBaseByCam) {
    if (!file || !cameraNames || cameraNames.length === 0) return null;
    var rel = (file.webkitRelativePath || file.name || '').replace(/\\/g, '/');
    var parts = rel.split('/');
    var parentDir = parts.length >= 2 ? parts[parts.length - 2].toLowerCase() : null;
    var stem = String(file.name || '').replace(/\.[^.]+$/, '').toLowerCase();

    var ci;
    for (ci = 0; ci < cameraNames.length; ci++) {
        if (parentDir && parentDir === cameraNames[ci].toLowerCase()) return cameraNames[ci];
    }
    for (ci = 0; ci < cameraNames.length; ci++) {
        if (stem.indexOf(cameraNames[ci].toLowerCase()) >= 0) return cameraNames[ci];
    }
    if (refBaseByCam) {
        for (ci = 0; ci < cameraNames.length; ci++) {
            var refBase = refBaseByCam.get(cameraNames[ci]);
            if (!refBase) continue;
            if (stem === refBase || stem.indexOf(refBase) >= 0 || refBase.indexOf(stem) >= 0) return cameraNames[ci];
        }
    }
    return null;
}
