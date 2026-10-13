// ui/seekbar-tooltip.js — hover tooltip on the transport seekbar (#142):
// "Frame 1,234 · 00:41.133" for the point under the cursor, so you can see
// where a click or drag will land before you make it.
//
// Dependency-free on purpose (imports NO project modules): the formatting is
// unit-tested in Node (`tests/test-seekbar-tooltip.mjs`) and the DOM half is
// handed everything it needs by `ui/ui-wiring.js`, which owns the seekbar's
// scrubbing handlers.
//
// The frame shown is EXACTLY the one a click at that x would seek to — the
// caller passes its own `frameAtFraction`, the same mapping the mousedown /
// drag handlers use — and is shown 1-based, like the `#currentFrame` readout
// and every other frame number on screen (indices stay 0-based inside).
//
// A hover line (`#seekbarHoverLine`) marks that frame ON the bar: a white
// line with a dark outline, the ID Switches tab's playhead colours, bigger
// than an ID-switch tick so it reads among them, at the frame's own position — so it snaps onto an ID-switch tick exactly as a
// click does. It hides during a drag, when the thumb is already there.

/**
 * Format a time in seconds as `mm:ss.mmm`, or `h:mm:ss.mmm` from one hour up.
 * Rounds to the millisecond first, so 59.9996 s reads `01:00.000`, never
 * `00:60.000`.
 */
export function formatTimestamp(seconds) {
    var ms = Math.round(Math.max(0, seconds) * 1000);
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    var s = Math.floor((ms % 60000) / 1000);
    var frac = ms % 1000;
    var pad = function (n, w) { var t = String(n); while (t.length < w) t = '0' + t; return t; };
    var mmss = pad(m, 2) + ':' + pad(s, 2) + '.' + pad(frac, 3);
    return h > 0 ? h + ':' + mmss : mmss;
}

/**
 * Tooltip text for a 0-based frame index. The timestamp is the frame's start
 * time, `frameIdx / fps`, and is left out when the frame rate is unknown
 * (`fps` missing, 0 — set while a session has no video yet — or non-finite).
 */
export function seekbarTooltipText(frameIdx, fps) {
    var text = 'Frame ' + (frameIdx + 1).toLocaleString('en-US');
    if (typeof fps === 'number' && isFinite(fps) && fps > 0) {
        text += ' · ' + formatTimestamp(frameIdx / fps);
    }
    return text;
}

/**
 * Attach the tooltip to `seekbar` (`#seekbar`). Shown while the pointer is
 * over the bar AND throughout a scrub drag (which may leave the bar), hidden
 * otherwise. Never shown when there is nothing to seek through.
 *
 * **Layout-free while you move.** Playback draws every display refresh, so a
 * mousemove handler that reads layout (`getBoundingClientRect`, `offsetWidth`)
 * after writing would force an extra synchronous layout into the frame. So:
 *   - the bar's rect is read once on mouseenter / drag start and kept, and a
 *     `ResizeObserver` drops it if the bar changes size meanwhile (its width
 *     moves e.g. when the frame counter to its left gains a digit — `flex: 1`
 *     means any shift of its left edge is also a width change);
 *   - the bubble's width is measured only when the text LENGTH changes — the
 *     font is monospace, so equal length means equal width.
 * A move with an unchanged text length therefore only writes.
 *
 * @param {HTMLElement} seekbar
 * @param {{
 *   frameAtFraction: (f: number) => number,  // [0,1] along the bar -> 0-based frame;
 *                                            // the SAME mapping the scrub handlers use
 *   getTotalFrames: () => number,
 *   getFps: () => number,
 *   markerAt?: (frac: number, widthPx: number) => ({frame: number, text: string} | null),
 *                                            // a marker under the cursor (ui/seekbar-markers.js):
 *                                            // its frame replaces frameAtFraction's (the scrub
 *                                            // handlers snap to it too) and its text is appended
 *   hoverLine?: HTMLElement,                 // the line marking that frame on the bar; positioned
 *                                            // in px from the cached rect, so moving stays layout-free
 * }} opts
 * @returns {HTMLElement} the tooltip element
 */
export function installSeekbarTooltip(seekbar, opts) {
    var tip = document.createElement('div');
    tip.className = 'seekbar-tooltip';
    tip.id = 'seekbarTooltip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    seekbar.appendChild(tip);

    var line = opts.hoverLine || null;
    var hovering = false, dragging = false;
    var rect = null;                      // cached seekbar rect (left, width)
    var measuredLen = -1, halfWidth = 0;  // cached bubble half-width, by text length

    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(function () { rect = null; }).observe(seekbar);
    }
    window.addEventListener('resize', function () { rect = null; });

    function cacheRect() {
        var r = seekbar.getBoundingClientRect();
        rect = { left: r.left, width: r.width };
    }

    function show(e) {
        var total = opts.getTotalFrames();
        if (!(total > 1)) { hide(); return; }
        if (!rect) cacheRect();
        var x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        var frac = rect.width > 0 ? x / rect.width : 0;
        var hit = opts.markerAt ? opts.markerAt(frac, rect.width) : null;
        var frame = hit ? hit.frame : opts.frameAtFraction(frac);
        if (line) {
            // At the frame's own position, the thumb's mapping — on the tick when snapped.
            line.style.left = (frame / (total - 1) * rect.width) + 'px';
            line.hidden = dragging;
        }
        var text = seekbarTooltipText(frame, opts.getFps()) + (hit ? ' — ' + hit.text : '');
        tip.textContent = text;
        tip.hidden = false;
        if (text.length !== measuredLen) {
            measuredLen = text.length;
            halfWidth = tip.offsetWidth / 2;
        }
        // Centre over the cursor, clamped so the bubble stays over the bar
        // instead of hanging off either end.
        tip.style.left = Math.max(halfWidth, Math.min(rect.width - halfWidth, x)) + 'px';
    }
    function hide() { tip.hidden = true; if (line) line.hidden = true; }

    seekbar.addEventListener('mouseenter', function (e) { hovering = true; rect = null; show(e); });
    seekbar.addEventListener('mousemove', function (e) { if (!dragging) show(e); });
    seekbar.addEventListener('mouseleave', function () { hovering = false; if (!dragging) hide(); });
    seekbar.addEventListener('mousedown', function (e) { dragging = true; rect = null; show(e); });
    // Document-level, like the scrub handlers: a drag keeps reporting the frame
    // it is scrubbing to even once the pointer has left the bar.
    document.addEventListener('mousemove', function (e) { if (dragging) show(e); });
    document.addEventListener('mouseup', function () {
        if (!dragging) return;
        dragging = false;
        if (!hovering) hide();
        else if (line && !tip.hidden) line.hidden = false;   // back from under the thumb, where the drag left it
    });
    return tip;
}
