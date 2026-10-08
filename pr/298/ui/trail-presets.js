/**
 * trail-presets.js — node-trail lengths, in SECONDS: the presets, and the
 * parsing, conversion and naming of a custom length (Tracks ▸ Node Trails ▸
 * Custom…, typed in seconds or in frames).
 *
 * A trail is chosen as a span of time (¼ s, ½ s, 1 s, 2 s) and drawn as a number of
 * frames, `seconds × fps`. A fixed frame list meant something different on every
 * camera: 50 frames was ½ s of a 100 fps recording and nearly 2 s of a 30 fps
 * one. DOM-free, so the conversion is unit-tested in Node
 * (`tests/test-trail-presets.mjs`). `state.trailLength` is a getter over
 * `trailFrames(state.trailSeconds, state.fps)` (`ui/app-state.js`), so the frame
 * count follows a new video or an edited FPS without anyone having to recompute it.
 * Import-free: `ui/app-state.js` imports it.
 */

/** Off, then ¼ s, ½ s, 1 s and 2 s. `key` names the Tracks ▸ Node Trails item ids. */
export const TRAIL_PRESETS = [
    { key: 'Off', seconds: 0, name: 'Off' },
    { key: 'Quarter', seconds: 0.25, name: '¼ second' },
    { key: 'Half', seconds: 0.5, name: '½ second' },
    { key: 'Second', seconds: 1, name: '1 second' },
    { key: 'TwoSeconds', seconds: 2, name: '2 seconds' },
];

/**
 * The longest trail drawn, in frames. `LAZY_KEEP_BEHIND` (512,
 * `pose/lazy-residency.js`) must stay above it — trails draw resident frames
 * only — and a 2 s trail on a 300 fps recording would otherwise be 600. From
 * 250 fps up, 2 s therefore draws 500 frames, and its label says so.
 */
export const MAX_TRAIL_FRAMES = 500;

/**
 * The rate trails are measured in: `fps`, or 30 while none is known
 * (`state.fps` is 0 before a video loads).
 * @param {number} fps
 * @returns {number}
 */
export function trailRate(fps) {
    return fps > 0 && isFinite(fps) ? fps : 30;
}

/**
 * Frames in a `seconds`-long trail at `fps`: rounded, at least 1 for any trail
 * that is on, at most `MAX_TRAIL_FRAMES`. 0 when `seconds` is 0 (off).
 * @param {number} seconds
 * @param {number} fps
 * @returns {number}
 */
export function trailFrames(seconds, fps) {
    if (!(seconds > 0)) return 0;
    return Math.min(MAX_TRAIL_FRAMES, Math.max(1, Math.round(seconds * trailRate(fps))));
}

/** The preset whose length is exactly `seconds`, or null (a custom length). */
export function trailPresetFor(seconds) {
    for (var i = 0; i < TRAIL_PRESETS.length; i++) {
        if (TRAIL_PRESETS[i].seconds === seconds) return TRAIL_PRESETS[i];
    }
    return null;
}

/**
 * A length's name: the preset's ("½ second") or, for a custom length, its
 * seconds to at most 3 decimals ("1.5 seconds", "1 second").
 * @param {number} seconds
 * @returns {string}
 */
export function trailSecondsName(seconds) {
    var p = trailPresetFor(seconds);
    if (p) return p.name;
    var v = formatTrailSeconds(seconds);
    return v + (v === '1' ? ' second' : ' seconds');
}

/**
 * Seconds as the Custom… dialog's field shows them: at most 3 decimals, no
 * trailing zeros ("1.5", "0.167", "2").
 * @param {number} seconds
 * @returns {string}
 */
export function formatTrailSeconds(seconds) {
    return String(Math.round(seconds * 1000) / 1000);
}

/**
 * The trail length in seconds that draws exactly `frames` frames at `fps` —
 * how a length typed in frames is stored. Kept exact (10 frames at 60 fps is
 * 1/6 s, not 0.167), so `trailFrames` gives back the frames that were typed.
 * @param {number} frames
 * @param {number} fps
 * @returns {number}
 */
export function trailSecondsForFrames(frames, fps) {
    return frames / trailRate(fps);
}

/**
 * A length with its frames at `fps`, e.g. "½ second (30 frames)" at 60 fps or
 * "1.5 seconds (90 frames)"; "Off" when `seconds` is 0.
 * @param {number} seconds
 * @param {number} fps
 * @returns {string}
 */
export function trailLabel(seconds, fps) {
    if (!(seconds > 0)) return 'Off';
    var n = trailFrames(seconds, fps);
    return trailSecondsName(seconds) + ' (' + n + (n === 1 ? ' frame)' : ' frames)');
}

/**
 * A typed custom length in seconds, or null when it is not a number above 0.
 * A decimal comma is accepted ("1,5"), since the field is plain text.
 * @param {string} text
 * @returns {number|null}
 */
export function parseTrailSeconds(text) {
    var t = String(text == null ? '' : text).trim().replace(',', '.');
    if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return null;
    var v = Number(t);
    return v > 0 && isFinite(v) ? v : null;
}

/**
 * A typed custom length in frames, or null when it is not a whole number of
 * at least 1.
 * @param {string} text
 * @returns {number|null}
 */
export function parseTrailFrames(text) {
    var t = String(text == null ? '' : text).trim();
    if (!/^\d+$/.test(t)) return null;
    var v = Number(t);
    return v >= 1 && isFinite(v) ? v : null;
}
