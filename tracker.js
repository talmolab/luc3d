/**
 * tracker.js — DEPRECATED back-compat shim.
 *
 * The real tracker now lives in trackers/default.js and registers itself
 * with window.LucidTrackers. This shim preserves the legacy global
 * matchFrameInstances(...) for any code that still calls it directly.
 *
 * To remove: delete this file and its <script> tag in index.html once
 * no callers reference window.matchFrameInstances.
 */

window.matchFrameInstances = function (frameGroup, cameras, session, opts) {
    if (!window.LucidTrackers) {
        throw new Error('[tracker.js shim] trackers/registry.js not loaded');
    }
    var d = window.LucidTrackers.get('default');
    if (!d) {
        throw new Error('[tracker.js shim] no "default" algorithm registered');
    }
    return d.fn(frameGroup, cameras, session, opts || {});
};
