/**
 * import-export/suggestions-io.js — a session's suggested frames
 * (`Session.suggestions`, the Suggestions panel) in and out of the `.slp`.
 *
 * SLEAP keeps suggestions in the file's `suggestions_json` dataset, one
 * `{"video": "<index>", "frame_idx": N, "group": G}` per entry, written by
 * sleap-io.js from `Labels.suggestions` (`SuggestionFrame`s). In LUCID every
 * camera view of a session is one video of the `.slp`, so a suggestion's
 * camera name is mapped to that session's video for the camera
 * (`RecordingSession.getVideo`) on save and back on load.
 *
 * Nothing is written for a session with no suggestions; a project with none
 * writes the same empty `suggestions_json` it always did
 * (`tests/e2e/save-golden-digest.mjs` does not move).
 *
 * Imports nothing.
 */

/** A suggestion's group as LUCID keeps it: a number (SLEAP's default is 0). */
function normalizeGroup(g) {
    var n = Number(g);
    return Number.isFinite(n) ? n : 0;
}

/**
 * The `SIO.SuggestionFrame`s for one session, against the `.slp` session it
 * was written as (whose cameras carry the LUCID camera names). A suggestion
 * whose camera has no video in `sioSession` is skipped.
 *
 * @param {Object} SIO - window.SleapIO (its `SuggestionFrame`, when there)
 * @param {{suggestions?: Array<{camera: string, frameIdx: number, group?: number}>}} session
 * @param {Object} sioSession - SIO.RecordingSession built for `session`
 * @returns {Object[]} SIO.SuggestionFrame[]
 */
export function sioSuggestionsForSession(SIO, session, sioSession) {
    var list = session && session.suggestions;
    if (!list || !list.length || !sioSession) return [];
    var videoByName = new Map();
    (sioSession.cameras || []).forEach(function (cam) {
        var v = sioSession.getVideo(cam);
        if (cam && v) videoByName.set(cam.name, v);
    });
    var out = [];
    list.forEach(function (s) {
        var video = videoByName.get(s.camera);
        if (!video) return;
        var opts = { video: video, frameIdx: s.frameIdx, group: normalizeGroup(s.group) };
        // sleap-io.js's writer reads only these fields, so a bridge without the
        // class (an older `window.SleapIO`) still writes them rather than none.
        out.push(SIO && SIO.SuggestionFrame ? new SIO.SuggestionFrame(opts)
            : { video: opts.video, frameIdx: opts.frameIdx, group: opts.group, metadata: {} });
    });
    return out;
}

/**
 * `labels.suggestions` (read by sleap-io.js) as plain entries keyed by video
 * INDEX, so a reader can map them to its own sessions and cameras.
 *
 * @param {{videos: Object[], suggestions?: Object[]}} labels - SIO.Labels
 * @returns {Array<{videoIdx: number, frameIdx: number, group: number}>}
 */
export function suggestionEntriesFromLabels(labels) {
    if (!labels || !labels.suggestions || !labels.suggestions.length) return [];
    var videos = labels.videos || [];
    var out = [];
    labels.suggestions.forEach(function (s) {
        var videoIdx = videos.indexOf(s.video);
        if (videoIdx < 0 || !(s.frameIdx >= 0)) return;
        var g = s.metadata && s.metadata.group != null ? s.metadata.group : s.group;
        out.push({ videoIdx: videoIdx, frameIdx: Number(s.frameIdx), group: normalizeGroup(g) });
    });
    return out;
}

/**
 * Set `session.suggestions` from file entries. `cameraForVideoIdx(i)` names
 * the session's camera for the file's video `i`, or returns null for a video
 * that is not this session's (its entries are skipped). Duplicates are
 * dropped; the file's order is kept.
 *
 * @param {Object} session
 * @param {Array<{videoIdx: number, frameIdx: number, group: number}>} entries
 * @param {function(number): (string|null)} cameraForVideoIdx
 * @returns {number} how many suggestions the session now has
 */
export function readSuggestions(session, entries, cameraForVideoIdx) {
    var seen = new Set();
    var out = [];
    (entries || []).forEach(function (e) {
        var cam = cameraForVideoIdx(e.videoIdx);
        if (cam == null) return;
        var k = cam + '\u0000' + e.frameIdx;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ camera: cam, frameIdx: e.frameIdx, group: normalizeGroup(e.group) });
    });
    session.suggestions = out;
    return out.length;
}
