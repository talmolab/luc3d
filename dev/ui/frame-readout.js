// ui/frame-readout.js — the controls bar's frame readout: the current time /
// duration on one line, and the current frame / total frames below it.
//
//     00:41.100 / 20:00.000
//         1,234 / 36,000
//
// It speaks the seekbar tooltip's language on purpose ("Frame 1,234 ·
// 00:41.100", ui/seekbar-tooltip.js): same thousands separator, same
// `formatTimestamp`, and the same definition of time — a frame's START time,
// `frameIdx / fps`, at the playback FPS shown in the FPS pill. So hovering the
// seekbar and then clicking puts the tooltip's exact text into this readout.
// The duration is `totalFrames / fps`, which is why the last frame reads just
// under it (35,999 / 30 = 19:59.967 of 20:00.000).
//
// Every writer of `#currentFrame` / `#totalFrames` goes through here — the
// loaders, the session switch and reset, the inline frame editor, the FPS
// pill — so the time line can never fall out of step with the frame line.
// Imports only `app-state.js` and `seekbar-tooltip.js`, both import-free, so
// `frameReadoutText` is unit-tested in Node (`tests/test-frame-readout.mjs`).

import { state } from './app-state.js?v=cec4e701a884';
import { formatTimestamp } from './seekbar-tooltip.js?v=cec4e701a884';

// One formatter, built once: this runs on every frame of playback.
const NUMBER = new Intl.NumberFormat('en-US');

/** Shown in place of a time while the frame rate is unknown (fps 0 — set
 *  while a session has no video yet — missing, or non-finite). */
export const NO_TIME = '--:--.---';

/** A frame number or count with thousands separators: 36000 -> "36,000". */
export function formatFrameNumber(n) {
    return NUMBER.format(n);
}

/**
 * The readout's four strings. Pure.
 *
 * @param {number|null} frameIdx  0-based frame on screen; null for the empty
 *   state, which reads "0 / 0" exactly as it did before there was a time line.
 * @param {number} totalFrames
 * @param {number} fps
 * @returns {{frame:string, total:string, time:string, duration:string}}
 */
export function frameReadoutText(frameIdx, totalFrames, fps) {
    var total = totalFrames > 0 ? totalFrames : 0;
    var hasFps = typeof fps === 'number' && isFinite(fps) && fps > 0;
    return {
        frame: frameIdx == null ? '0' : formatFrameNumber(frameIdx + 1),
        total: formatFrameNumber(total),
        time: hasFps ? formatTimestamp(frameIdx == null ? 0 : frameIdx / fps) : NO_TIME,
        duration: hasFps ? formatTimestamp(total / fps) : NO_TIME,
    };
}

// The frame the readout shows, so a totals refresh (new frame count, edited
// FPS) can re-derive the current time without being told the frame again.
var _shown = null;

function setText(id, text) {
    var el = document.getElementById(id);
    if (el && el.textContent !== text) el.textContent = text;
}

/** Show `frameIdx` (0-based). The per-frame path — playback calls it on every frame. */
export function showReadoutFrame(frameIdx) {
    _shown = frameIdx;
    var t = frameReadoutText(frameIdx, state.totalFrames, state.fps);
    setText('currentFrame', t.frame);
    setText('currentTime', t.time);
}

/** Re-read `state.totalFrames` and `state.fps`. Call after changing either. */
export function refreshReadoutTotals() {
    var t = frameReadoutText(_shown, state.totalFrames, state.fps);
    setText('totalFrames', t.total);
    setText('totalTime', t.duration);
    setText('currentTime', t.time);
}

/** The empty state, for a project or session that has just been closed. */
export function clearReadout() {
    _shown = null;
    var t = frameReadoutText(null, 0, state.fps);
    setText('currentFrame', t.frame);
    setText('totalFrames', t.total);
    setText('currentTime', t.time);
    setText('totalTime', t.duration);
}
