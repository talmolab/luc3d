/**
 * ui/inference-video-paths.js — find each camera view's video ON DISK.
 *
 * LUCID reads videos as browser `File`s, which have no disk path, but
 * `sleap-nn` needs one. On the desktop app the user picks the recording folder
 * once with a native dialog (that grants the app access to it, and nothing
 * else); the panel lists the video files under it and this module matches
 * each view's `File` to one of them:
 *   1. by relative path: a folder load gives `File.webkitRelativePath`
 *      (`<picked>/cam1/0.mp4`, campy's layout included) — compared without
 *      its first component, so it works whatever the picked folder is called,
 *      and also as a path suffix (a parent folder was picked);
 *   2. by the path the project's `.slp` recorded (`videoPath`), as a suffix;
 *   3. by file name, when exactly one file under the folder has it.
 * Every match must also have the `File`'s byte size, so a different video
 * with the same name is never used. Anything else is unmatched, with a reason.
 *
 * Import-free (Node tests: tests/test-inference-video-paths.mjs).
 */

export const VIDEO_EXTENSIONS = ['.mp4', '.avi', '.mov', '.mkv', '.m4v'];

export function isVideoName(name) {
    var n = String(name || '').toLowerCase();
    return VIDEO_EXTENSIONS.some(function (e) { return n.endsWith(e); });
}

function norm(p) {
    return String(p || '').replace(/\\/g, '/').split('/').filter(function (s) { return s && s !== '.'; });
}

/** Does relative path `rel` (parts) end with `tail` (parts)? Case-sensitive, whole components. */
function endsWithParts(rel, tail) {
    if (tail.length === 0 || tail.length > rel.length) return false;
    for (var i = 1; i <= tail.length; i++) {
        if (rel[rel.length - i] !== tail[tail.length - i]) return false;
    }
    return true;
}

/**
 * @param {Array<{view:string, fileName:string, fileSize:number|null, relPath?:string, videoPath?:string}>} views
 * @param {Array<{rel:string, size:number}>} listing  video files under the picked folder, relative paths
 * @returns {Object<string, {rel:string}|{error:string}>} by view name
 */
export function matchViewVideos(views, listing) {
    var entries = listing.map(function (e) { return { rel: e.rel, parts: norm(e.rel), size: e.size }; });
    var used = new Set();
    var out = {};

    function sizeOk(e, v) { return v.fileSize == null || e.size === v.fileSize; }
    function pick(cands, v) {
        var ok = cands.filter(function (e) { return sizeOk(e, v) && !used.has(e.rel); });
        return ok.length === 1 ? ok[0] : (ok.length > 1 ? 'ambiguous' : null);
    }

    views.forEach(function (v) {
        var found = null, why = 'no video named ' + v.fileName + ' under the folder';
        var tails = [];
        var rp = norm(v.relPath);
        if (rp.length > 1) tails.push(rp.slice(1));          // without the picked folder's own name
        if (rp.length > 0) tails.push(rp);
        var vp = norm(v.videoPath);
        if (vp.length > 1) tails.push(vp.slice(-2));         // <cam folder>/<file>
        for (var t = 0; t < tails.length && !found; t++) {
            var hit = pick(entries.filter(function (e) { return endsWithParts(e.parts, tails[t]); }), v);
            if (hit === 'ambiguous') { why = 'several videos match ' + tails[t].join('/'); continue; }
            if (hit) found = hit;
        }
        if (!found && v.fileName) {
            var byName = entries.filter(function (e) { return e.parts[e.parts.length - 1] === v.fileName; });
            var hit2 = pick(byName, v);
            if (hit2 === 'ambiguous') why = 'several videos are named ' + v.fileName;
            else if (hit2) found = hit2;
            else if (byName.length) why = v.fileName + ' under the folder has a different size';
        }
        if (found) { used.add(found.rel); out[v.view] = { rel: found.rel }; }
        else out[v.view] = { error: why };
    });
    return out;
}
