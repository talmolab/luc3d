/**
 * ui/timeline-controller.js — timeline toggle/fit/shortcut controller.
 *
 * Encapsulates:
 *   - toggleTimeline()        — collapse/expand the timeline, caching the
 *                                prior height so the next expand restores it.
 *   - fitTimelineToData()     — size the timeline container to fit all tracks,
 *                                capped at 30% of window.innerHeight.
 *   - syncTimelineToggleButton() — keep the toolbar button's `.active` class
 *                                in sync with the container's collapsed state.
 *   - installTimelineShortcuts() — register the Ctrl/Cmd+J (toggle) and
 *                                Ctrl/Cmd+Shift+J (legacy "Change Frame
 *                                Number") keyboard shortcuts. Idempotent.
 *
 * Module-level cache:
 *   _cachedHeight — last known explicit container height in pixels. Saved on
 *                   collapse, restored on the next expand. Cleared / reset
 *                   via the test accessors `getCachedTimelineHeight()` /
 *                   `setCachedTimelineHeight(px)`.
 *
 * The module reads the Timeline instance via `state.timeline` from
 * `ui/app-state.js`. That module is intentionally lightweight — it does not
 * transitively import `app.js` — so this module can be safely bridged into
 * the test runner.
 */

import { state } from './app-state.js';

// ----------------------------------------------------------------------------
// Module-level state
// ----------------------------------------------------------------------------

var _cachedHeight = 0;
var _installed = false;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function _getTimeline() {
    // `state.timeline` is the canonical reference — `setTimeline()` from
    // `app-state.js` writes to it. We read it lazily on every call so the
    // controller works regardless of module-load order.
    return state && state.timeline ? state.timeline : null;
}

function _getContainer() {
    if (typeof document === 'undefined' || !document.getElementById) return null;
    return document.getElementById('timelineContainer');
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * Toggle the timeline between collapsed (height:0) and expanded states.
 * Caches the explicit height on collapse and restores it on the next expand.
 * Null-safe — if the timeline instance has not been created yet (e.g., in
 * test environments without full app init) the function still flips the
 * `.collapsed` class and updates the toolbar button.
 */
export function toggleTimeline() {
    var container = _getContainer();
    if (!container) return;

    var timeline = _getTimeline();
    var willCollapse = !container.classList.contains('collapsed');

    if (willCollapse) {
        // Cache the current explicit height so the next expand can
        // restore it. Prefer the inline style value (set by user resize
        // or `fitTimelineToData`); fall back to the measured client rect
        // when no inline height is set.
        var styleH = parseFloat(container.style && container.style.height);
        if (!isNaN(styleH) && styleH > 0) {
            _cachedHeight = styleH;
        } else if (typeof container.getBoundingClientRect === 'function') {
            var rect = container.getBoundingClientRect();
            if (rect && rect.height > 0) _cachedHeight = rect.height;
        }
        container.classList.add('collapsed');
        // Clear inline height so the CSS `.collapsed { height: 0 }` rule
        // takes effect cleanly.
        if (container.style) container.style.height = '';
    } else {
        container.classList.remove('collapsed');
        // Unconditionally restore the cached height when we have one;
        // only fall back to fitTimelineToData() when no cache exists
        // (e.g., first-ever expand on a fresh project).
        if (_cachedHeight > 0) {
            container.style.height = _cachedHeight + 'px';
        } else {
            fitTimelineToData();
        }
        if (timeline && typeof timeline.resize === 'function') {
            setTimeout(function () {
                var tl = _getTimeline();
                if (tl && typeof tl.resize === 'function') tl.resize();
            }, 16);
        }
    }

    syncTimelineToggleButton();
}

/**
 * Resize the timeline container to fit the currently loaded tracks,
 * capped at 30% of `window.innerHeight`. Skips when the user has
 * explicitly collapsed the timeline via the toolbar button.
 */
export function fitTimelineToData() {
    var timeline = _getTimeline();
    if (!timeline) return;
    var container = _getContainer();
    if (!container) return;
    if (container.classList && container.classList.contains('collapsed')) return;

    var preferred = (typeof timeline.getPreferredHeight === 'function')
        ? timeline.getPreferredHeight()
        : 0;
    var winH = (typeof window !== 'undefined' && window.innerHeight)
        ? window.innerHeight
        : 1080;
    var cap = Math.floor(0.3 * winH);
    var target = Math.min(preferred, cap);
    if (target > 0) container.style.height = target + 'px';
    if (typeof timeline.resize === 'function') timeline.resize();
}

/**
 * Update the toolbar toggle button's `.active` class so it reflects the
 * current collapsed/expanded state. No-op if the button isn't in the DOM.
 */
export function syncTimelineToggleButton() {
    if (typeof document === 'undefined' || !document.getElementById) return;
    var btn = document.getElementById('timelineToggleBtn');
    if (!btn) return;
    var container = _getContainer();
    var collapsed = container && container.classList && container.classList.contains('collapsed');
    btn.classList.toggle('active', !collapsed);
}

/**
 * Install the global Ctrl/Cmd+J (toggle timeline) and Ctrl/Cmd+Shift+J
 * (legacy "Change Frame Number" dblclick on #currentFrame) keyboard
 * shortcuts. Idempotent — subsequent calls are a no-op.
 */
export function installTimelineShortcuts() {
    if (_installed) return;
    if (typeof document === 'undefined' || !document.addEventListener) return;
    document.addEventListener('keydown', _shortcutHandler);
    _installed = true;
}

function _shortcutHandler(e) {
    if (!e) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.altKey) return;
    var key = (e.key || '').toLowerCase();
    if (key !== 'j') return;

    if (e.shiftKey) {
        // Ctrl/Cmd+Shift+J — legacy "Change Frame Number" shortcut, which
        // fires a dblclick on the visible frame label so the user can edit
        // the frame number inline.
        if (typeof e.preventDefault === 'function') e.preventDefault();
        var frameEl = (typeof document !== 'undefined' && document.getElementById)
            ? document.getElementById('currentFrame')
            : null;
        if (frameEl && typeof frameEl.dispatchEvent === 'function') {
            frameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        }
    } else {
        // Plain Ctrl/Cmd+J — toggle the timeline visibility.
        if (typeof e.preventDefault === 'function') e.preventDefault();
        toggleTimeline();
    }
}

// ----------------------------------------------------------------------------
// Test accessors
// ----------------------------------------------------------------------------

/**
 * Test helper: read the module-level height cache. Used by the
 * timeline-toggle test to verify the cache is updated on collapse.
 */
export function getCachedTimelineHeight() {
    return _cachedHeight;
}

/**
 * Test helper / future resize-handle hook: explicitly set the cached
 * timeline height. The cache is otherwise updated only on collapse, so
 * drag-resize logic can call this directly to keep "restore on re-show"
 * accurate without round-tripping through collapse.
 */
export function setCachedTimelineHeight(px) {
    var n = parseFloat(px);
    if (!isNaN(n) && n >= 0) _cachedHeight = n;
}
