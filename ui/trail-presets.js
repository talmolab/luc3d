/**
 * trail-presets.js — the node-trail presets, in SECONDS.
 *
 * A trail is chosen as a span of time (¼ s, ½ s, 1 s) and drawn as a number of
 * frames, `seconds × fps`. A fixed frame list meant something different on every
 * camera: 50 frames was ½ s of a 100 fps recording and nearly 2 s of a 30 fps
 * one. DOM-free, so the conversion is unit-tested in Node
 * (`tests/test-trail-presets.mjs`). `state.trailLength` is a getter over
 * `trailFrames(state.trailSeconds, state.fps)` (`ui/app-state.js`), so the frame
 * count follows a new video or an edited FPS without anyone having to recompute it.
 * Import-free: `ui/app-state.js` imports it.
 */

/** Off, then ¼ s, ½ s and 1 s. `key` names the Tracks ▸ Node Trails item ids. */
export const TRAIL_PRESETS = [
    { key: 'Off', seconds: 0, name: 'Off' },
    { key: 'Quarter', seconds: 0.25, name: '¼ second' },
    { key: 'Half', seconds: 0.5, name: '½ second' },
    { key: 'Second', seconds: 1, name: '1 second' },
];

/**
 * The longest trail drawn, in frames. `LAZY_KEEP_BEHIND` (512,
 * `pose/lazy-residency.js`) must stay above it — trails draw resident frames
 * only — and a 1 s trail on a 1,000 fps recording would otherwise be 1,000.
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

/**
 * A preset's menu text, e.g. "½ second (30 frames)" at 60 fps, or "Off".
 * @param {{seconds:number, name:string}} preset
 * @param {number} fps
 * @returns {string}
 */
export function trailPresetLabel(preset, fps) {
    if (!(preset.seconds > 0)) return preset.name;
    var n = trailFrames(preset.seconds, fps);
    return preset.name + ' (' + n + (n === 1 ? ' frame)' : ' frames)');
}
