/**
 * decoder-factory.js — single place that decides which video decoder backend
 * the whole app uses, so switching between the legacy HTML5/mp4box decoder and
 * the sleap-io.js backend is one setting instead of ~10 scattered `new`s.
 *
 * Backends:
 *   'sleap'  → SleapVideoDecoder (loading/sleap-video-adapter.js) — sleap-io.js's
 *              mp4box/mediabunny/HDF5 backends. No HTML5 <video> element (so no
 *              preload buffering of huge mounted files), decodes via WebCodecs
 *              from bounded slices / HTTP Range. This is the direction the GUI
 *              is moving to ("adopt sleap-io.js").
 *   'legacy' → OnDemandVideoDecoder (loading/video.js) — HTML5 <video> +
 *              mp4box-for-metadata. Native-smooth playback; proven decode path.
 *
 * Choosing the active backend (first match wins):
 *   1. opts.backend === 'sleap' | 'legacy'      (explicit per-call)
 *   2. opts.forceSleap / opts.forceLegacy       (explicit per-call)
 *   3. localStorage.LUCID_VIDEO_BACKEND          (runtime override — flip
 *      without editing code: `localStorage.LUCID_VIDEO_BACKEND='legacy'`
 *      then reload; handy for A/B testing a video that decodes wrong)
 *   4. DEFAULT_VIDEO_BACKEND                      (build default, below)
 *
 * Revert the whole app to the old decoder by setting DEFAULT_VIDEO_BACKEND to
 * 'legacy' (or `localStorage.LUCID_VIDEO_BACKEND='legacy'` at runtime).
 */

import { OnDemandVideoDecoder } from './video.js';
import { SleapVideoDecoder } from './sleap-video-adapter.js';

/** Build-time default backend for the app. */
export const DEFAULT_VIDEO_BACKEND = 'sleap';

function resolveBackend(opts) {
    if (opts.backend === 'sleap' || opts.backend === 'legacy') return opts.backend;
    if (opts.forceSleap) return 'sleap';
    if (opts.forceLegacy) return 'legacy';
    try {
        if (typeof localStorage !== 'undefined') {
            var override = localStorage.getItem('LUCID_VIDEO_BACKEND');
            if (override === 'sleap' || override === 'legacy') return override;
        }
    } catch (e) { /* localStorage may be unavailable */ }
    return DEFAULT_VIDEO_BACKEND;
}

/**
 * Construct a video decoder. Both backends share the same interface
 * (`init(source)`, `getFrame(i) → ImageBitmap`, `.samples`, `.videoTrack`,
 * `._fps`, native-playback methods, `close()`), so callers are backend-agnostic.
 * @param {Object} [opts] { cacheSize, lookahead, onProgress, backend,
 *                          forceSleap, forceLegacy }
 */
export function createVideoDecoder(opts) {
    opts = opts || {};
    if (resolveBackend(opts) === 'sleap') {
        return new SleapVideoDecoder(opts);
    }
    return new OnDemandVideoDecoder(opts);
}
