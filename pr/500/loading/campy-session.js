// campy-session.js — what a campy recording folder says about itself.
//
// campy (olinesn/campy, 2.1.1 and later) writes <recording>/session.json
// (schema "campy-session/1") in every recording folder: the frame rate, each
// camera's name, serial and video, the experiment (name, animal IDs, notes,
// other fields), notes added afterwards, and how the recording ended. campy-live
// writes campy-live-session.json (or campy-live-session_2.json, …) beside it,
// with the calibration it tracked with and that file's SHA-256. Every field is
// documented in campy's docs/recordings.md.
//
// This module only reads them: it finds the manifests among a picked folder's
// files, turns session.json into a small record, orders cameras the way campy
// numbered them, names the video campy wrote for each camera, and compares a
// calibration's SHA-256 with the ones campy-live used. The loaders in
// `loading/session-loader.js` and `import-export/slp-import.js` call it; the
// Session tab's Recording section (`ui/recording-info.js`) shows the record.
//
// Nothing here is written to the .slp: the folder is the source, read again
// whenever it is picked. A folder without session.json gives null everywhere,
// and the loaders then behave exactly as before.
//
// No imports, so Node tests load it directly (tests/test-campy-session.mjs).

export var CAMPY_SESSION_FILE = 'session.json';
export var CAMPY_SESSION_SCHEMA = 'campy-session/1';
export var CAMPY_LIVE_SCHEMA = 'campy-live-session/1';

// A frame rate from session.json that differs from the video's own estimate by
// more than this fraction is reported (the campy rate is still used).
export var FRAME_RATE_DISAGREE_FRACTION = 0.01;

function relPathOf(file) {
    return (file && (file.webkitRelativePath || file.name)) || '';
}

function dirOf(relPath) {
    var i = relPath.lastIndexOf('/');
    return i < 0 ? '' : relPath.substring(0, i);
}

function baseOf(relPath) {
    return relPath.substring(relPath.lastIndexOf('/') + 1);
}

/** campy writes the string "None" for an experiment field that was not set. */
export function campyUnset(value) {
    return value === undefined || value === null || value === '' || value === 'None';
}

function isLiveManifestName(name) {
    // campy's own reader (campy/manifest.py Read) takes every
    // campy-live-session*.json beside session.json.
    return name.indexOf('campy-live-session') === 0 && /\.json$/i.test(name);
}

/**
 * The campy manifests among a picked folder's files.
 *
 * The recording's session.json is the SHALLOWEST file of that name (a picked
 * parent folder holds one per recording, and the caller passes one session's
 * files); campy-live's manifests are the campy-live-session*.json files in the
 * same directory.
 *
 * @param {ArrayLike<File>} files — with `webkitRelativePath` when picked as a folder
 * @returns {{session: File, live: File[], root: string}|null} `root` is the
 *   recording folder's relative path ('' when the files have no path), the
 *   prefix campy's relative `video` paths are joined to.
 */
export function findCampyManifestFiles(files) {
    var best = null, bestDepth = Infinity;
    var list = Array.from(files || []);
    for (var i = 0; i < list.length; i++) {
        var rel = relPathOf(list[i]);
        if (baseOf(rel) !== CAMPY_SESSION_FILE) continue;
        var depth = rel.split('/').length;
        if (depth < bestDepth) { best = list[i]; bestDepth = depth; }
    }
    if (!best) return null;
    var root = dirOf(relPathOf(best));
    var live = list.filter(function (f) {
        var rel = relPathOf(f);
        return dirOf(rel) === root && isLiveManifestName(baseOf(rel));
    });
    live.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    return { session: best, live: live, root: root };
}

/**
 * JSON.parse, and failing that the same text with Python's non-standard
 * `NaN`, `Infinity` and `-Infinity` (outside strings) read as null. campy
 * writes its manifests with Python's json module, which emits those for a
 * float option left at inf (campy-live's `--wait-sec` default), and strict
 * JSON.parse rejects the whole file. Null when it still is not JSON.
 */
export function parseCampyJson(text) {
    try { return JSON.parse(text); } catch (e) { /* try the Python tokens */ }
    try { return JSON.parse(pythonJsonTokensToNull(String(text))); } catch (e) { return null; }
}

function pythonJsonTokensToNull(text) {
    var out = '', i = 0, n = text.length;
    while (i < n) {
        var ch = text[i];
        if (ch === '"') {                       // copy a string as it is
            var j = i + 1;
            while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
            out += text.substring(i, j + 1);
            i = j + 1;
            continue;
        }
        var m = /^(-?Infinity|NaN)/.exec(text.substring(i, i + 9));
        if (m) { out += 'null'; i += m[1].length; continue; }
        out += ch;
        i++;
    }
    return out;
}

var parseJson = parseCampyJson;

function str(v) { return v === undefined || v === null ? '' : String(v); }

/**
 * session.json's text → the record LUC3D uses, or null when it is not JSON or
 * not schema "campy-session/1".
 *
 * @returns {{
 *   schema: string, status: string|null, startedAt: string|null,
 *   campyVersion: string|null, frameRate: number|null,
 *   experiment: {name: string|null, animalIds: string[], notes: string|null, fields: Array<[string, string]>},
 *   annotations: Array<{at: string, text: string}>,
 *   cameras: Array<{index: number, name: string, serial: string|null, folder: string|null, video: string|null}>,
 *   failures: Array<{camera: string, reason: string}>, error: string|null,
 *   live: Array, calibrationCheck: object|null, cameraMismatch: object|null,
 *   videoFrameRate: number|null,
 * }|null}
 */
export function parseCampySession(text) {
    var d = parseJson(text);
    if (!d || typeof d !== 'object' || d.schema !== CAMPY_SESSION_SCHEMA) return null;

    var eff = d.config && d.config.effective;
    var fr = eff && eff.frameRate && Number(eff.frameRate.value);
    var exp = (d.experiment && typeof d.experiment === 'object') ? d.experiment : {};
    var fields = [];
    if (exp.fields && typeof exp.fields === 'object' && !Array.isArray(exp.fields)) {
        for (var k in exp.fields) {
            if (!campyUnset(exp.fields[k])) {
                var fv = exp.fields[k];
                fields.push([k, typeof fv === 'object' ? JSON.stringify(fv) : String(fv)]);
            }
        }
    }
    var cams = Array.isArray(d.cameras) ? d.cameras.filter(function (c) {
        return c && !campyUnset(c.name);
    }).map(function (c, i) {
        return {
            index: Number.isFinite(Number(c.index)) ? Number(c.index) : i,
            name: String(c.name),
            serial: campyUnset(c.serial) ? null : String(c.serial),
            folder: campyUnset(c.folder) ? null : String(c.folder),
            video: campyUnset(c.video) ? null : String(c.video),
        };
    }) : [];
    cams.sort(function (a, b) { return a.index - b.index; });

    var failures = [];
    var end = d.end && typeof d.end === 'object' ? d.end : null;
    if (end && end.failures && typeof end.failures === 'object') {
        if (Array.isArray(end.failures)) {
            end.failures.forEach(function (f) { failures.push({ camera: str(f), reason: '' }); });
        } else {
            for (var fc in end.failures) {
                var why = end.failures[fc];
                failures.push({ camera: fc, reason: typeof why === 'object' ? JSON.stringify(why) : str(why) });
            }
        }
    }

    return {
        schema: d.schema,
        status: typeof d.status === 'string' ? d.status : null,
        startedAt: (d.written && typeof d.written.start === 'string') ? d.written.start : null,
        campyVersion: (d.campy && !campyUnset(d.campy.version)) ? String(d.campy.version) : null,
        frameRate: Number.isFinite(fr) && fr > 0 ? fr : null,
        experiment: {
            name: campyUnset(exp.name) ? null : String(exp.name),
            // Display only: campy-live numbers animals in the order it first
            // matches them, which says nothing of which ID each one is, so these
            // never name LUC3D's identities.
            animalIds: Array.isArray(exp.animalIds) ? exp.animalIds.filter(function (a) {
                return !campyUnset(a);
            }).map(String) : [],
            notes: campyUnset(exp.notes) ? null : String(exp.notes),
            fields: fields,
        },
        annotations: Array.isArray(d.annotations) ? d.annotations.filter(function (a) {
            return a && !campyUnset(a.text);
        }).map(function (a) { return { at: str(a.at), text: String(a.text) }; }) : [],
        cameras: cams,
        failures: failures,
        error: end && !campyUnset(end.error) ? str(end.error) : null,
        // Filled by the loader:
        live: [],                 // parseCampyLiveSession results
        calibrationCheck: null,   // compareCalibrationSha256
        cameraMismatch: null,     // compareCampyCameraNames
        videoFrameRate: null,     // the video's own estimate, when it disagrees
    };
}

/**
 * campy-live-session*.json's text → {file, calibration: {path, sha256,
 * cameraNames}|null}, or null when it is not that schema. `calibration` is
 * null when campy-live ran 2D only.
 */
export function parseCampyLiveSession(text, fileName) {
    var d = parseJson(text);
    if (!d || typeof d !== 'object' || d.schema !== CAMPY_LIVE_SCHEMA) return null;
    var cal = d.calibration && typeof d.calibration === 'object' ? d.calibration : null;
    var sha = cal && typeof cal.sha256 === 'string' && cal.sha256 ? cal.sha256.toLowerCase() : null;
    return {
        file: fileName || null,
        calibration: sha ? {
            path: str(cal.path),
            sha256: sha,
            cameraNames: Array.isArray(cal.cameraNames) ? cal.cameraNames.map(String) : [],
        } : null,
    };
}

/**
 * Read a folder's manifests into one record (session.json's, with `.live`
 * filled), or null when there is no readable session.json.
 *
 * @param {ArrayLike<File>} files
 * @param {(file: File) => Promise<string>} [readText] — defaults to `file.text()`
 */
export async function readCampyRecording(files, readText) {
    var found = findCampyManifestFiles(files);
    if (!found) return null;
    var read = readText || function (f) { return f.text(); };
    var record;
    try { record = parseCampySession(await read(found.session)); } catch (e) { record = null; }
    if (!record) return null;
    record.root = found.root;
    for (var i = 0; i < found.live.length; i++) {
        var live = null;
        try {
            live = parseCampyLiveSession(await read(found.live[i]), found.live[i].name);
        } catch (e) { live = null; }
        if (live) record.live.push(live);
        // Skipped, but said: without it the calibration check silently does
        // not run.
        else if (typeof console !== 'undefined') console.warn('[campy] ' + found.live[i].name + ' is not a readable campy-live-session/1 manifest; skipped');
    }
    return record;
}

/**
 * The campy camera a LUC3D camera (or camera folder) is: by campy's folder,
 * then by name (case-insensitive).
 */
export function campyCameraFor(record, name, dirName) {
    if (!record) return null;
    var cams = record.cameras;
    var lower = function (s) { return String(s || '').toLowerCase(); };
    if (dirName) {
        for (var i = 0; i < cams.length; i++) if (cams[i].folder && lower(cams[i].folder) === lower(dirName)) return cams[i];
    }
    for (var j = 0; j < cams.length; j++) if (lower(cams[j].name) === lower(name)) return cams[j];
    if (dirName) {
        for (var m = 0; m < cams.length; m++) if (lower(cams[m].name) === lower(dirName)) return cams[m];
    }
    return null;
}

/**
 * `items` sorted into campy's camera order; items that are no campy camera
 * keep their relative order after the others. Stable, returns a new array.
 *
 * @param {(item) => {name: string, dirName?: string}} keyOf
 */
export function orderByCampyCameras(record, items, keyOf) {
    if (!record || !record.cameras.length) return items.slice();
    return items.map(function (item, i) {
        var k = keyOf(item) || {};
        var cam = campyCameraFor(record, k.name, k.dirName);
        return { item: item, key: cam ? cam.index : Infinity, i: i };
    }).sort(function (a, b) {
        return (a.key === b.key ? 0 : (a.key < b.key ? -1 : 1)) || (a.i - b.i);
    }).map(function (o) { return o.item; });
}

/**
 * The file campy wrote as `cam`'s video, among `files`, or null. Matched by
 * its full relative path (the recording folder + campy's `video`).
 */
export function campyVideoFile(record, cam, files) {
    if (!record || !cam || !cam.video) return null;
    var want = (record.root ? record.root + '/' : '') + cam.video.replace(/\\/g, '/');
    var list = Array.from(files || []);
    for (var i = 0; i < list.length; i++) {
        if (relPathOf(list[i]) === want) return list[i];
    }
    return null;
}

/**
 * `videos` (one camera's candidates) with campy's video for that camera
 * first, or unchanged when it is not among them.
 */
export function preferCampyVideo(record, cam, videos) {
    var v = campyVideoFile(record, cam, videos);
    if (!v) return videos;
    return [v].concat(videos.filter(function (f) { return f !== v; }));
}

/**
 * Cameras in only one of session.json and the calibration, or null when they
 * agree (or either list is empty).
 */
export function compareCampyCameraNames(record, calibrationNames) {
    if (!record || !record.cameras.length || !calibrationNames || !calibrationNames.length) return null;
    var lower = function (s) { return String(s).toLowerCase(); };
    var cal = calibrationNames.map(lower);
    var campy = record.cameras.map(function (c) { return lower(c.name); });
    var onlyCampy = record.cameras.filter(function (c) { return cal.indexOf(lower(c.name)) < 0; })
        .map(function (c) { return c.name; });
    var onlyCal = calibrationNames.filter(function (n) { return campy.indexOf(lower(n)) < 0; });
    if (!onlyCampy.length && !onlyCal.length) return null;
    return { onlyInRecording: onlyCampy, onlyInCalibration: onlyCal };
}

/** Lower-case hex SHA-256 of bytes (Web Crypto; also in Node ≥ 19). */
export async function sha256Hex(buffer) {
    var digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    var bytes = new Uint8Array(digest);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return out;
}

/**
 * Compare the loaded calibration file's SHA-256 with the ones campy-live
 * tracked with. Null when there is nothing to compare (no campy-live manifest
 * with a calibration, or no file hash).
 *
 * @returns {{matches: boolean, fileName: string, sha256: string,
 *   live: Array<{file: string, path: string, sha256: string}>}|null}
 */
export function compareCalibrationSha256(record, sha256, fileName) {
    if (!record || !sha256) return null;
    var live = record.live.filter(function (l) { return l.calibration; }).map(function (l) {
        return { file: l.file, path: l.calibration.path, sha256: l.calibration.sha256 };
    });
    if (!live.length) return null;
    var want = String(sha256).toLowerCase();
    return {
        matches: live.some(function (l) { return l.sha256 === want; }),
        fileName: fileName || '',
        sha256: want,
        live: live,
    };
}

/** True when two frame rates differ by more than FRAME_RATE_DISAGREE_FRACTION. */
export function frameRatesDisagree(campyFps, videoFps) {
    if (!(campyFps > 0) || !(videoFps > 0)) return false;
    return Math.abs(campyFps - videoFps) / campyFps > FRAME_RATE_DISAGREE_FRACTION;
}

/**
 * The recording's status in plain words. `ok` is false for anything but
 * "complete".
 */
export function describeCampyStatus(record) {
    var s = record && record.status;
    if (s === 'complete') return { ok: true, label: 'Complete', detail: '' };
    if (s === 'interrupted') {
        return { ok: false, label: 'Interrupted', detail: 'Stopped with Ctrl-C before its planned end.' };
    }
    if (s === 'failed') {
        var who = record.failures.map(function (f) {
            return f.camera + (f.reason ? ' (' + f.reason + ')' : '');
        });
        var detail = who.length
            ? 'These cameras did not record to the end: ' + who.join('; ') + '.'
            : 'campy stopped on an error' + (record.error ? ': ' + record.error : '') + '.';
        return { ok: false, label: 'Failed', detail: detail };
    }
    if (s === 'recording') {
        return { ok: false, label: 'Did not finish',
            detail: 'campy never reached its end (it was killed, or the computer lost power). '
                + 'The videos are there up to their last second.' };
    }
    return { ok: false, label: s ? String(s) : 'Unknown', detail: 'session.json does not say how the recording ended.' };
}

function shortSha(s) { return String(s || '').slice(0, 12); }

/** Last path component of a Windows or POSIX path. */
export function pathBaseName(p) {
    return String(p || '').replace(/^.*[\/\\]/, '');
}

/**
 * The warnings a load adds to its final status-bar message, in order: the
 * status, a calibration that is not campy-live's, cameras in only one of
 * session.json and the calibration. Empty when all is well.
 *
 * @param {{status?: boolean}} [opts] — `status: false` leaves the status out
 *   (File → Load Calibration reports only on the calibration).
 */
export function campyRecordingWarnings(record, opts) {
    if (!record) return [];
    var out = [];
    var st = describeCampyStatus(record);
    if (!st.ok && !(opts && opts.status === false)) out.push('recording status: ' + st.label.toLowerCase());
    var cc = record.calibrationCheck;
    if (cc && !cc.matches) {
        out.push(calibrationMismatchText(cc));
    }
    var cm = record.cameraMismatch;
    if (cm) {
        if (cm.onlyInRecording.length) out.push('not in the calibration: ' + cm.onlyInRecording.join(', '));
        if (cm.onlyInCalibration.length) out.push('not in session.json: ' + cm.onlyInCalibration.join(', '));
    }
    return out;
}

/** One sentence for a calibration that matches none of campy-live's. */
export function calibrationMismatchText(cc) {
    var l = cc.live[0];
    return (cc.fileName || 'the calibration') + ' (SHA-256 ' + shortSha(cc.sha256) + '…) is not the calibration '
        + 'campy-live tracked with (' + (pathBaseName(l.path) || l.file) + ', ' + shortSha(l.sha256) + '…'
        + (cc.live.length > 1 ? ', or ' + (cc.live.length - 1) + ' other run(s)' : '')
        + '): campy-live\'s 3D was made with a different calibration';
}

/**
 * A load's final status message with the recording's warnings added: kind
 * 'success' becomes 'warning'; 'error' stays. `opts` as campyRecordingWarnings.
 */
export function withCampyWarnings(message, kind, record, opts) {
    var w = campyRecordingWarnings(record, opts);
    if (!w.length) return { message: message, kind: kind };
    return {
        message: message + ' — ' + w.join('; '),
        kind: kind === 'error' ? 'error' : 'warning',
    };
}
