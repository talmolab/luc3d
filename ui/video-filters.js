// ui/video-filters.js — per-view video display filters (brightness + contrast).
//
// DOM-free and dependency-free on purpose: it imports NO project modules, so it
// can be bridged into the browser test runner (`tests/test-runner.html`) and the
// `vm` sandbox runner without dragging `app.js` in. `ui/sessions-panes.js` owns
// the DOM side (the Visibility-tab tables) and calls into here for the math and
// the per-session store.
//
// ## Contrast, concretely
//
// CSS `filter: contrast(k)` is a per-channel linear transfer function pivoted on
// mid-grey:
//
//     out = k * in + (0.5 - 0.5 * k)        // in/out normalized to [0, 1]
//
// so `k = 1` is identity, `k > 1` pushes values away from 0.5 (more contrast),
// `k < 1` collapses them toward 0.5 (less contrast), and `k = 0` flattens the
// whole image to mid-grey. That makes the bipolar slider a straight affine map
// with no branch on sign:
//
//     k = 1 + s / 100        s in [-100, 100]  ->  k in [0, 2]
//
// mirroring the existing brightness slider's 0..200 % -> `brightness(0..2)`.
//
// ## Why one combined filter string
//
// Brightness and contrast both live on `view.canvas.style.filter`. Writing them
// separately means the second assignment silently erases the first, so every
// application goes through `buildVideoFilter`, which emits both.

export const CONTRAST_MIN = -100;
export const CONTRAST_MAX = 100;
export const CONTRAST_DEFAULT = 0;

export const BRIGHTNESS_MIN = 0;
export const BRIGHTNESS_MAX = 200;
export const BRIGHTNESS_DEFAULT = 100;

function clampInt(value, min, max, dflt) {
    var n = typeof value === 'number' ? value : Number(value);
    if (!isFinite(n)) return dflt;
    n = Math.round(n);
    if (n < min) return min;
    if (n > max) return max;
    // `Math.round(-0.2)` is -0; `-0 !== 0` is false but `String(-0)` is "0", so
    // this is only about keeping the stored value canonical.
    return n === 0 ? 0 : n;
}

/**
 * Coerce anything (number, slider string, null, NaN) into a valid contrast
 * setting: an integer in [-100, 100], defaulting to 0.
 */
export function clampContrast(value) {
    return clampInt(value, CONTRAST_MIN, CONTRAST_MAX, CONTRAST_DEFAULT);
}

/**
 * Coerce anything into a valid brightness setting: an integer percentage in
 * [0, 200], defaulting to 100.
 */
export function clampBrightness(value) {
    return clampInt(value, BRIGHTNESS_MIN, BRIGHTNESS_MAX, BRIGHTNESS_DEFAULT);
}

/**
 * Slider value -> CSS `contrast()` amount. -100 -> 0 (flat mid-grey),
 * 0 -> 1 (identity), +100 -> 2 (doubled contrast).
 */
export function contrastFactor(value) {
    return (100 + clampContrast(value)) / 100;
}

/**
 * Slider percentage -> CSS `brightness()` amount. 100 -> 1 (identity).
 */
export function brightnessFactor(value) {
    return clampBrightness(value) / 100;
}

/**
 * Build the combined CSS `filter` value for one view.
 *
 * Identity components are omitted, and an all-identity pair yields `''` — so a
 * project with no brightness/contrast edits leaves `style.filter` empty exactly
 * as it did before contrast existed.
 *
 * @param {number|string} brightness - percentage, 0..200 (default 100)
 * @param {number|string} contrast   - signed, -100..100 (default 0)
 * @returns {string} e.g. `''`, `'brightness(1.15)'`, `'brightness(1.15) contrast(0.6)'`
 */
export function buildVideoFilter(brightness, contrast) {
    var b = clampBrightness(brightness);
    var c = clampContrast(contrast);
    var parts = [];
    if (b !== BRIGHTNESS_DEFAULT) parts.push('brightness(' + (b / 100) + ')');
    if (c !== CONTRAST_DEFAULT) parts.push('contrast(' + ((100 + c) / 100) + ')');
    return parts.join(' ');
}

/**
 * Read one camera's contrast from a session. Missing / unknown -> 0.
 *
 * The session map — not the view object — is the source of truth: `state.views`
 * is rebuilt from scratch on every session switch, so anything parked on a view
 * would silently reset. Views are transient; sessions persist.
 *
 * @param {Object} session - a `pose/pose-data.js` Session (or null)
 * @param {string} camName
 * @returns {number} integer in [-100, 100]
 */
export function getSessionContrast(session, camName) {
    if (!session || !camName) return CONTRAST_DEFAULT;
    var map = session.videoContrast;
    if (!map) return CONTRAST_DEFAULT;
    return clampContrast(map[camName]);
}

/**
 * Store one camera's contrast on a session, returning the clamped value that was
 * actually stored. Default (0) entries are DELETED rather than written, keeping
 * the serialized map — and therefore the saved `sessions_json` — empty for any
 * project the user never adjusted.
 *
 * @returns {number} the clamped value
 */
export function setSessionContrast(session, camName, value) {
    var v = clampContrast(value);
    if (!session || !camName) return v;
    if (!session.videoContrast) session.videoContrast = {};
    if (v === CONTRAST_DEFAULT) delete session.videoContrast[camName];
    else session.videoContrast[camName] = v;
    return v;
}

/**
 * Session -> the `metadata.lucid.videoContrast` payload, or `null` when there is
 * nothing worth writing. Writers must omit the key on `null` so an untouched
 * project's bytes are unchanged.
 *
 * @param {Object} session
 * @returns {Object<string, number>|null}
 */
export function serializeVideoContrast(session) {
    if (!session || !session.videoContrast) return null;
    var out = null;
    var keys = Object.keys(session.videoContrast);
    for (var i = 0; i < keys.length; i++) {
        var v = clampContrast(session.videoContrast[keys[i]]);
        if (v === CONTRAST_DEFAULT) continue;
        if (!out) out = {};
        out[keys[i]] = v;
    }
    return out;
}

/**
 * Merge a saved `metadata.lucid.videoContrast` payload into a session, clamping
 * and dropping anything unusable (non-numeric values, defaults). Tolerates a
 * missing/garbage payload — old `.slp` files simply have no such key.
 *
 * @param {Object} session
 * @param {*} raw - whatever was on disk
 * @returns {number} count of entries applied
 */
export function ingestVideoContrast(session, raw) {
    if (!session) return 0;
    if (!session.videoContrast) session.videoContrast = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
    var applied = 0;
    var keys = Object.keys(raw);
    for (var i = 0; i < keys.length; i++) {
        var v = clampContrast(raw[keys[i]]);
        if (v === CONTRAST_DEFAULT) continue;
        session.videoContrast[keys[i]] = v;
        applied++;
    }
    return applied;
}
