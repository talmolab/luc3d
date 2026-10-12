// ui/video-filters.js — per-camera video display settings (brightness,
// contrast, rotation).
//
// DOM-free and dependency-free on purpose: it imports NO project modules, so it
// can be bridged into the browser test runner (`tests/test-runner.html`) and the
// `vm` sandbox runner without dragging `app.js` in. `ui/sessions-panes.js` owns
// the DOM side (the Visibility-tab tables) and calls into here for the math and
// the per-session stores.
//
// ## One store shape, three settings
//
// All three are per-CAMERA and live on the SESSION as a plain
// `{ cameraName: value }` map, because `state.views` is rebuilt from scratch on
// every session switch — anything parked on a view silently resets. Each has a
// default that is NEVER written to the map (or to the `.slp`), so a project the
// user never adjusted serializes exactly as it did before these settings
// existed. Brightness and contrast are pure CSS `filter` components; rotation is
// a geometric transform the renderer and hit-testing consume via `view.rotation`
// (this module only owns its clamp, its store and its serialization).
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

export const ROTATION_MIN = -179;
export const ROTATION_MAX = 180;
export const ROTATION_DEFAULT = 0;

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
 * Rotation in degrees, wrapped into (-180, 180]. Deliberately does NOT round —
 * the hold-to-rotate loop in `ui/ui-wiring.js` advances `view.rotation` by a
 * fractional `60 * dt` every frame and needs the sub-degree precision to look
 * smooth. Use `clampRotationSetting` for anything that reaches the store.
 *
 * Lives here rather than in `ui/sessions-panes.js` (which re-exports it, so
 * existing importers are unaffected) because that module is DOM-bound and this
 * one is the dependency-free home the test runners can bridge.
 */
export function clampRotation(deg) {
    deg = deg % 360;
    if (deg > 180) deg -= 360;
    if (deg < -179) deg += 360;
    return deg;
}

/**
 * Rotation coerced to what the per-session store and the `.slp` hold: an
 * INTEGER degree in [-179, 180], defaulting to 0.
 *
 * Rounds BEFORE wrapping, not after. `clampRotation` maps its input into
 * (-180, 180] — an open lower bound, so it can return e.g. 180.9999 for an
 * input just under -179. Rounding that result would yield 181, out of range.
 * Rounding first and then wrapping is closed under the integer range.
 */
export function clampRotationSetting(value) {
    var n = typeof value === 'number' ? value : Number(value);
    if (!isFinite(n)) return ROTATION_DEFAULT;
    var r = clampRotation(Math.round(n));
    return r === 0 ? 0 : r;
}

// ----------------------------------------------------------------------------
// Per-session, per-camera stores
//
// All three settings share one shape — `session[mapKey][cameraName] = value`
// with default-valued entries absent — so they share one set of primitives.
// Keeping them generic is what guarantees a later change to (say) the
// default-omission rule can't apply to two of the three and silently skip the
// third.
//
// The session map, NOT the view object, is the source of truth: `state.views`
// is rebuilt from scratch on every session switch, so anything parked on a view
// would silently reset. Views are transient; sessions persist.
// ----------------------------------------------------------------------------

function readSetting(session, mapKey, camName, clampFn, dflt) {
    if (!session || !camName) return dflt;
    var map = session[mapKey];
    if (!map) return dflt;
    return clampFn(map[camName]);
}

/** Returns the clamped value that was actually stored. */
function writeSetting(session, mapKey, camName, value, clampFn, dflt) {
    var v = clampFn(value);
    if (!session || !camName) return v;
    if (!session[mapKey]) session[mapKey] = {};
    // Default entries are DELETED rather than written, keeping the serialized
    // map — and therefore the saved `sessions_json` — empty for any project the
    // user never adjusted.
    if (v === dflt) delete session[mapKey][camName];
    else session[mapKey][camName] = v;
    return v;
}

/** Session -> payload object, or `null` when there is nothing worth writing. */
function serializeSetting(session, mapKey, clampFn, dflt) {
    if (!session || !session[mapKey]) return null;
    var out = null;
    var keys = Object.keys(session[mapKey]);
    for (var i = 0; i < keys.length; i++) {
        var v = clampFn(session[mapKey][keys[i]]);
        if (v === dflt) continue;
        if (!out) out = {};
        out[keys[i]] = v;
    }
    return out;
}

/** Merge an on-disk payload into a session. Returns the count applied. */
function ingestSetting(session, mapKey, raw, clampFn, dflt) {
    if (!session) return 0;
    if (!session[mapKey]) session[mapKey] = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
    var applied = 0;
    var keys = Object.keys(raw);
    for (var i = 0; i < keys.length; i++) {
        var v = clampFn(raw[keys[i]]);
        if (v === dflt) continue;
        session[mapKey][keys[i]] = v;
        applied++;
    }
    return applied;
}

// ---- contrast (`session.videoContrast` -> `metadata.lucid.videoContrast`) ----

/** Read one camera's contrast from a session. Missing / unknown -> 0. */
export function getSessionContrast(session, camName) {
    return readSetting(session, 'videoContrast', camName, clampContrast, CONTRAST_DEFAULT);
}

/** Store one camera's contrast on a session. @returns {number} clamped value */
export function setSessionContrast(session, camName, value) {
    return writeSetting(session, 'videoContrast', camName, value, clampContrast, CONTRAST_DEFAULT);
}

/**
 * Session -> the `metadata.lucid.videoContrast` payload, or `null`. Writers must
 * omit the key on `null` so an untouched project's bytes are unchanged
 * (`tests/e2e/save-golden-digest.mjs`).
 */
export function serializeVideoContrast(session) {
    return serializeSetting(session, 'videoContrast', clampContrast, CONTRAST_DEFAULT);
}

/**
 * Merge a saved `metadata.lucid.videoContrast` payload into a session, clamping
 * and dropping anything unusable (non-numeric values, defaults). Tolerates a
 * missing/garbage payload — old `.slp` files simply have no such key.
 */
export function ingestVideoContrast(session, raw) {
    return ingestSetting(session, 'videoContrast', raw, clampContrast, CONTRAST_DEFAULT);
}

// -- brightness (`session.videoBrightness` -> `metadata.lucid.videoBrightness`) --

/** Read one camera's brightness percentage from a session. Missing -> 100. */
export function getSessionBrightness(session, camName) {
    return readSetting(session, 'videoBrightness', camName, clampBrightness, BRIGHTNESS_DEFAULT);
}

/** Store one camera's brightness on a session. @returns {number} clamped value */
export function setSessionBrightness(session, camName, value) {
    return writeSetting(session, 'videoBrightness', camName, value, clampBrightness, BRIGHTNESS_DEFAULT);
}

/** Session -> the `metadata.lucid.videoBrightness` payload, or `null`. */
export function serializeVideoBrightness(session) {
    return serializeSetting(session, 'videoBrightness', clampBrightness, BRIGHTNESS_DEFAULT);
}

/** Merge a saved `metadata.lucid.videoBrightness` payload into a session. */
export function ingestVideoBrightness(session, raw) {
    return ingestSetting(session, 'videoBrightness', raw, clampBrightness, BRIGHTNESS_DEFAULT);
}

// ---- rotation (`session.videoRotation` -> `metadata.lucid.videoRotation`) ----

/** Read one camera's rotation from a session. Missing -> 0. */
export function getSessionRotation(session, camName) {
    return readSetting(session, 'videoRotation', camName, clampRotationSetting, ROTATION_DEFAULT);
}

/** Store one camera's rotation on a session. @returns {number} clamped value */
export function setSessionRotation(session, camName, value) {
    return writeSetting(session, 'videoRotation', camName, value, clampRotationSetting, ROTATION_DEFAULT);
}

/** Session -> the `metadata.lucid.videoRotation` payload, or `null`. */
export function serializeVideoRotation(session) {
    return serializeSetting(session, 'videoRotation', clampRotationSetting, ROTATION_DEFAULT);
}

/** Merge a saved `metadata.lucid.videoRotation` payload into a session. */
export function ingestVideoRotation(session, raw) {
    return ingestSetting(session, 'videoRotation', raw, clampRotationSetting, ROTATION_DEFAULT);
}
