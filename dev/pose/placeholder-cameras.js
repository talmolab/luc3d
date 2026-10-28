/**
 * placeholder-cameras.js — the stand-in Camera a session gets for a view that
 * has no calibration, and the rule that every view and every 2D camera key of
 * an UNCALIBRATED session has one.
 *
 * Why it matters: the `.slp` writer (`buildSlpLabelsAllViews`,
 * `import-export/file-io.js`) writes one video per `session.cameras` entry and
 * skips any 2D instance whose camera is not in that list, and the save paths in
 * `import-export/save-load.js` pick the views / videos to write by the same
 * list. A folder loaded with no `calibration.toml` used to leave
 * `session.cameras` EMPTY (the per-camera and single-`.slp` folder loaders
 * deliberately created none), so File ▸ Save wrote a valid `.slp` with no
 * videos, no frames and no poses — "Saved (0.0 MB)" — and the reopened project
 * had nothing in it.
 *
 * A placeholder is the same all-zero-extrinsic camera File ▸ Load Videos has
 * always made for an uncalibrated video (`rvec = tvec = [0,0,0]`, f = 600,
 * principal point at the image centre). The app already treats that shape as
 * "no calibration": `ui/view-align-modal.js` `isCalibrated`, the view-move
 * `originHasCalib` test in `ui/sessions-panes.js`, and `handleLoadCalibration`,
 * which replaces it when a real calibration is loaded later.
 *
 * DOM-free and state-free: callers pass the session's views and videoFiles.
 */
import { Camera } from './pose-data.js?v=e218595f4da6';

/** Focal length (px) of a placeholder camera — the value Load Videos uses. */
export var PLACEHOLDER_FOCAL = 600;

/** Image size used when the video's size is not known (deferred decode). */
export var PLACEHOLDER_DEFAULT_SIZE = [640, 480];

/**
 * A placeholder (uncalibrated) camera for a view of the given size.
 * @param {string} name
 * @param {number} [width]
 * @param {number} [height]
 * @returns {Camera}
 */
export function makePlaceholderCamera(name, width, height) {
    var w = width > 0 ? width : PLACEHOLDER_DEFAULT_SIZE[0];
    var h = height > 0 ? height : PLACEHOLDER_DEFAULT_SIZE[1];
    return new Camera(name,
        [[PLACEHOLDER_FOCAL, 0, w / 2], [0, PLACEHOLDER_FOCAL, h / 2], [0, 0, 1]],
        [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [w, h]);
}

function isZeroVec3(v) {
    return !!v && v.length === 3 && !Array.isArray(v[0]) &&
        v[0] === 0 && v[1] === 0 && v[2] === 0;
}

/**
 * True for a camera with no extrinsic calibration (all-zero rotation and
 * translation) — the inverse of `ui/view-align-modal.js` `isCalibrated` for a
 * camera that has a matrix. A 3×3 rotation matrix (anipose) is calibrated.
 * @param {Camera} cam
 * @returns {boolean}
 */
export function isPlaceholderCamera(cam) {
    if (!cam) return false;
    return isZeroVec3(cam.rvec || cam.rotation) && isZeroVec3(cam.tvec || cam.translation);
}

/**
 * True when the session has at least one REAL (calibrated) camera. The same
 * rule as `pose/triangulation.js` `sessionHasCalibration()` (which reads
 * `state.session`), for any session and without app state.
 * @param {{cameras: Camera[]}} session
 * @returns {boolean}
 */
export function hasRealCalibration(session) {
    var cams = (session && session.cameras) || [];
    for (var i = 0; i < cams.length; i++) {
        if (!isPlaceholderCamera(cams[i])) return true;
    }
    return false;
}

/**
 * Every camera name the session's views, videos and 2D data refer to, in
 * order: views first (their on-screen order), then videos, then any 2D camera
 * key not already listed (resident frame groups, unlinked instances, instance
 * group members, and a lazy loader's per-camera stores). Empty instance lists
 * do not count.
 *
 * @param {Object} session - a `Session`
 * @param {Array<{name:string}>} [views]
 * @param {Array<{name:string, assignedCamera:?string}>} [videoFiles]
 * @returns {string[]}
 */
export function cameraNamesInUse(session, views, videoFiles) {
    var seen = new Set();
    var out = [];
    function add(n) {
        if (typeof n !== 'string' || n === '' || seen.has(n)) return;
        seen.add(n);
        out.push(n);
    }
    var vs = views || [];
    for (var i = 0; i < vs.length; i++) if (vs[i]) add(vs[i].name);
    var vfs = videoFiles || [];
    for (var j = 0; j < vfs.length; j++) if (vfs[j]) add(vfs[j].assignedCamera || vfs[j].name);
    if (!session) return out;
    if (session.frameGroups) {
        for (var fg of session.frameGroups.values()) {
            if (fg.instances) {
                for (var [cn, insts] of fg.instances) if (insts && insts.length > 0) add(cn);
            }
            if (fg.unlinkedInstances) {
                for (var [un, ul] of fg.unlinkedInstances) if (ul && ul.length > 0) add(un);
            }
        }
    }
    if (session.instanceGroups) {
        for (var groups of session.instanceGroups.values()) {
            for (var g = 0; g < groups.length; g++) {
                var gi = groups[g] && groups[g].instances;
                if (gi) for (var gn of gi.keys()) add(gn);
            }
        }
    }
    var loader = session.lazyLoader;
    if (loader && loader.labelsByCam && typeof loader.labelsByCam.keys === 'function') {
        for (var ln of loader.labelsByCam.keys()) add(ln);
    }
    return out;
}

/**
 * Give an UNCALIBRATED session a placeholder camera for every view, video and
 * 2D camera key that has none, and assign each of its unassigned videos to the
 * camera named after it. A session with any real calibration is left alone
 * (returns `[]`): an origin-centred stand-in there would join triangulation and
 * corrupt the 3D, so a stray key in a calibrated session stays the caller's
 * problem.
 *
 * Cameras are appended in `cameraNamesInUse` order, sized from the matching
 * view, else the video, else `PLACEHOLDER_DEFAULT_SIZE`.
 *
 * @param {Object} session - a `Session` (mutated: `session.cameras`)
 * @param {Array<{name:string, videoWidth?:number, videoHeight?:number}>} [views]
 * @param {Array<Object>} [videoFiles] - THIS session's video files (mutated: `assignedCamera`)
 * @returns {string[]} the names of the cameras added
 */
export function ensurePlaceholderCameras(session, views, videoFiles) {
    if (!session) return [];
    if (!session.cameras) session.cameras = [];
    if (hasRealCalibration(session)) return [];

    var sizeByName = new Map();
    var vfs = videoFiles || [];
    for (var j = 0; j < vfs.length; j++) {
        var vf = vfs[j];
        if (vf && vf.videoWidth > 0 && vf.videoHeight > 0) {
            sizeByName.set(vf.assignedCamera || vf.name, [vf.videoWidth, vf.videoHeight]);
        }
    }
    var vs = views || [];
    for (var i = 0; i < vs.length; i++) {
        var v = vs[i];
        if (v && v.videoWidth > 0 && v.videoHeight > 0) sizeByName.set(v.name, [v.videoWidth, v.videoHeight]);
    }

    var have = new Set(session.cameras.map(function (c) { return c.name; }));
    var added = [];
    var names = cameraNamesInUse(session, views, videoFiles);
    for (var k = 0; k < names.length; k++) {
        var n = names[k];
        if (have.has(n)) continue;
        var sz = sizeByName.get(n) || [0, 0];
        session.cameras.push(makePlaceholderCamera(n, sz[0], sz[1]));
        have.add(n);
        added.push(n);
    }

    for (var a = 0; a < vfs.length; a++) {
        var avf = vfs[a];
        if (avf && !avf.assignedCamera && have.has(avf.name)) avf.assignedCamera = avf.name;
    }
    return added;
}
