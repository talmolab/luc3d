/**
 * pose/suggested-frames.js — the frames a `.slp`'s suggestions name, in the file's
 * order, and where a step through them lands (Navigation ▸ Previous / Next suggested
 * frame, `ui/suggested-frame-nav.js`).
 *
 * A session's suggestions (`Session.suggestions`, `pose/suggestions.js`: one per
 * camera view and frame) keep the file's order: SLEAP's "frames to label next",
 * often ranked (a scan's worst frame first, each frame once per camera). Stepping
 * follows that order, not frame order, so the first Next lands on the file's first
 * suggestion. Unlike the Suggestions panel's Prev / Next, which walk each camera
 * view's rows in turn, a frame is one stop however many views suggest it.
 *
 * Import-free and DOM-free (`tests/test-suggested-frames.mjs`).
 */

/**
 * The frames suggested on any of `cameraNames`, each once, where it first appears.
 *
 * @param {Array<{camera: (string|null), frameIdx: number}>} rows  in the file's order
 *   (`Session.suggestions`); `camera` null for a suggestion on a video no camera of
 *   the session reads
 * @param {Iterable<string>} cameraNames  the session's cameras
 * @returns {number[]} 0-based frame indices
 */
export function suggestedFrameOrder(rows, cameraNames) {
    var cameras = new Set(cameraNames);
    var seen = new Set();
    var frames = [];
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row.camera == null || !cameras.has(row.camera)) continue;
        var f = row.frameIdx;
        if (!(Number.isInteger(f) && f >= 0) || seen.has(f)) continue;
        seen.add(f);
        frames.push(f);
    }
    return frames;
}

/**
 * Where a step from the frame on screen lands.
 *
 * On a suggested frame, the step goes to its neighbour in the list. Off one, it goes
 * from the suggestion last stepped to, as if just past it: Next goes to the one after
 * it, Previous back to it. With neither, both go to the first suggestion. Steps stop
 * at the ends.
 *
 * @param {number[]} frames  `suggestedFrameOrder`
 * @param {number} current  the frame on screen
 * @param {number} direction  +1 next, -1 previous
 * @param {number} [lastFrame]  the suggested frame last stepped to, if any
 * @returns {{index: number, frame: (number|null)}|null}  null without suggestions;
 *   `frame` null at an end, with `index` the end's suggestion (0 or the last)
 */
export function stepSuggestedFrame(frames, current, direction, lastFrame) {
    if (!frames || frames.length === 0) return null;
    var at = frames.indexOf(current);
    var last = lastFrame == null ? -1 : frames.indexOf(lastFrame);
    var to;
    if (at >= 0) to = at + (direction > 0 ? 1 : -1);
    else if (last >= 0) to = direction > 0 ? last + 1 : last;
    else to = 0;
    if (to < 0) return { index: 0, frame: null };
    if (to >= frames.length) return { index: frames.length - 1, frame: null };
    return { index: to, frame: frames[to] };
}
