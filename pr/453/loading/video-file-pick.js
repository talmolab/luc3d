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

/** The video extensions every folder prompt keeps. */
export var FOLDER_VIDEO_EXTENSIONS = ['.mp4', '.avi', '.webm', '.mov', '.mkv'];

/** True for a file name with one of `FOLDER_VIDEO_EXTENSIONS` (any case). */
export function isVideoFileName(name) {
    var lower = String(name || '').toLowerCase();
    var dot = lower.lastIndexOf('.');
    return dot >= 0 && FOLDER_VIDEO_EXTENSIONS.indexOf(lower.substring(dot)) >= 0;
}

/**
 * True when the files came from a folder pick (`webkitdirectory`): at least one
 * has a relative path with a directory in it. Files picked one by one have none.
 */
export function isFolderPick(files) {
    if (!files) return false;
    for (var i = 0; i < files.length; i++) {
        var rel = files[i] && files[i].webkitRelativePath;
        if (rel && rel.replace(/\\/g, '/').indexOf('/') >= 0) return true;
    }
    return false;
}

function pathSegments(p) {
    return String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
}

/**
 * One video per camera from a picked FOLDER, which can hold videos the project
 * does not name (a recording folder also has the side cameras) and videos that
 * all share one name (campy writes `<camera>/0.mp4` for every camera). So a
 * video goes to a camera only on a signal that tells the cameras apart, and a
 * video with none is left out rather than bound by elimination.
 *
 * The signals, strongest first (all case-insensitive):
 *  1. the video's folder is named like the camera;
 *  2. the video's folder and file name are those of the path the project
 *     references for the camera (`.../Camera1_topB/0.mp4`);
 *  3. the file stem is the camera name;
 *  4. the file name is the referenced one, and no other picked video has it;
 *  5. the camera name appears in the stem;
 *  6. the referenced stem appears in the stem, and in no other picked video's.
 * Each camera takes the strongest candidate (a `-calibration` stem loses a tie,
 * as in `preferNonCalibrationVideos`, then the order given), and each video
 * goes to one camera at most.
 *
 * @param {ArrayLike<File>} files - the folder's videos
 * @param {string[]} cameraNames
 * @param {Map<string,string>} [refPathByCam] camera name -> the video path the
 *   project references for it (as written; '' or '.' = none)
 * @returns {{cameraOf: Map<File,string>, assigned: File[], unused: File[]}}
 *   `assigned` in camera order, `unused` in the order given.
 */
export function assignFolderVideos(files, cameraNames, refPathByCam) {
    var list = files ? Array.prototype.slice.call(files) : [];
    var cams = cameraNames || [];
    var info = list.map(function (file) {
        var segs = pathSegments(file.webkitRelativePath || file.name);
        var base = String(file.name || segs[segs.length - 1] || '').toLowerCase();
        return {
            base: base,
            stem: base.replace(/\.[^.]+$/, ''),
            dir: segs.length >= 2 ? segs[segs.length - 2].toLowerCase() : null,
        };
    });
    var refs = cams.map(function (cam) {
        var p = refPathByCam ? refPathByCam.get(cam) : null;
        if (!p || p === '.') return null;
        var segs = pathSegments(p);
        if (!segs.length) return null;
        var base = segs[segs.length - 1].toLowerCase();
        return {
            base: base,
            stem: base.replace(/\.[^.]+$/, ''),
            dir: segs.length >= 2 ? segs[segs.length - 2].toLowerCase() : null,
        };
    });
    function countWhere(pred) {
        var n = 0;
        for (var i = 0; i < info.length; i++) if (pred(info[i])) n++;
        return n;
    }

    var pairs = [];
    for (var fi = 0; fi < list.length; fi++) {
        var v = info[fi];
        for (var ci = 0; ci < cams.length; ci++) {
            var cam = cams[ci].toLowerCase();
            var ref = refs[ci];
            var rank = 0;
            if (v.dir && v.dir === cam) rank = 1;
            else if (ref && ref.dir && v.dir && v.base === ref.base && v.dir === ref.dir) rank = 2;
            else if (v.stem === cam) rank = 3;
            else if (ref && v.base === ref.base
                && countWhere(function (o) { return o.base === ref.base; }) === 1) rank = 4;
            else if (cam && v.stem.indexOf(cam) >= 0) rank = 5;
            else if (ref && ref.stem && v.stem.indexOf(ref.stem) >= 0
                && countWhere(function (o) { return o.stem.indexOf(ref.stem) >= 0; }) === 1) rank = 6;
            if (rank) pairs.push({ rank: rank, calib: hasCalibrationStem(list[fi]) ? 1 : 0, fi: fi, ci: ci });
        }
    }
    pairs.sort(function (a, b) {
        return (a.rank - b.rank) || (a.calib - b.calib) || (a.fi - b.fi) || (a.ci - b.ci);
    });

    var fileTaken = new Array(list.length);
    var camFile = new Array(cams.length);
    for (var pi = 0; pi < pairs.length; pi++) {
        var pr = pairs[pi];
        if (fileTaken[pr.fi] || camFile[pr.ci] !== undefined) continue;
        fileTaken[pr.fi] = true;
        camFile[pr.ci] = pr.fi;
    }

    var cameraOf = new Map();
    var assigned = [];
    for (var cj = 0; cj < cams.length; cj++) {
        if (camFile[cj] === undefined) continue;
        cameraOf.set(list[camFile[cj]], cams[cj]);
        assigned.push(list[camFile[cj]]);
    }
    var unused = list.filter(function (_, i) { return !fileTaken[i]; });
    return { cameraOf: cameraOf, assigned: assigned, unused: unused };
}
