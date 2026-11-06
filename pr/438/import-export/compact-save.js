// import-export/compact-save.js — File ▸ Save Compact Copy: what is rounded, how
// it is switched on for one save, and how a rounded file is recognised again.
//
// A project stores predicted keypoints, scores and 3D with far more precision
// than tracking has (float32 sub-pixel noise, float64 3D). Rounding them to a
// binary fraction (exact in float32/float64) lets gzip compress them: on a real
// 15-minute, 5-camera project, 380 MB -> about 210 MB. It is LOSSY and permanent
// in the copy, so it is never the default: the user asks for it through a dialog
// that says what is lost (`ui/compact-save-modal.js`), the rounded file carries
// `lucid_compact` in its provenance (kept by every later save, since its data
// stay rounded), and LUC3D says so whenever it is opened (`withCompactNote`).
//
// The rounding itself happens in the vendored writer (lib/sleap-io, LUCID local
// patch "compact save"), which reads `globalThis.__lucidCompactSave` only while a
// compact save runs. Hand-placed (user) keypoints are never rounded.
//
// DOM-free and import-free, so Node tests load it.

/** The rounding steps: 2D x/y in pixels, scores, 3D coordinates in calibration units (mm). */
export const COMPACT_STEPS = Object.freeze({ xy: 1 / 64, score: 1 / 1024, p3d: 1 / 1024 });

/** The provenance key a compact file carries. */
export const COMPACT_PROVENANCE_KEY = 'lucid_compact';

var _active = false;

/**
 * Run `save` with rounding switched on, and off again however it ends.
 * @template T
 * @param {() => Promise<T>} save
 * @returns {Promise<T>}
 */
export async function withCompactSave(save) {
    if (_active) throw new Error('A compact save is already running');
    _active = true;
    globalThis.__lucidCompactSave = COMPACT_STEPS;
    try {
        return await save();
    } finally {
        delete globalThis.__lucidCompactSave;
        _active = false;
    }
}

/** Is a compact save running now? */
export function compactSaveActive() {
    return _active;
}

/** The marker written into a compact file's provenance. */
export function compactMarker(steps) {
    var s = steps || COMPACT_STEPS;
    return {
        xy_px: s.xy,
        score: s.score,
        points_3d: s.p3d,
        note: 'Saved as a compact copy by LUC3D: predicted 2D keypoints, prediction scores and 3D points were rounded to these steps; user keypoints were not.',
    };
}

/**
 * Provenance fields for the file being written: the marker while a compact save
 * runs, else nothing.
 * @returns {?Object}
 */
export function compactProvenanceExtra() {
    if (!_active) return null;
    var out = {};
    out[COMPACT_PROVENANCE_KEY] = compactMarker();
    return out;
}

/**
 * The marker a file's provenance carries, or null when it was saved with full
 * precision.
 * @param {?Object} provenance  a session's `fileProvenance`
 * @returns {?{xy_px: number, score: number, points_3d: number}}
 */
export function compactRoundingOf(provenance) {
    var m = provenance && typeof provenance === 'object' ? provenance[COMPACT_PROVENANCE_KEY] : null;
    return m && typeof m === 'object' ? m : null;
}

// "1/64 px" for a binary fraction, else the number.
function stepText(v, unit) {
    if (!(v > 0)) return '';
    var inv = 1 / v;
    return (Math.abs(inv - Math.round(inv)) < 1e-9 ? '1/' + Math.round(inv) : String(v)) + (unit ? ' ' + unit : '');
}

/**
 * The end-of-load status, with a note when the file is a compact copy: the user
 * must not mistake its rounded values for the original predictions.
 * @param {string} message
 * @param {string} kind  setStatus level
 * @param {?Object} session
 * @returns {{message: string, kind: string}}
 */
export function withCompactNote(message, kind, session) {
    var m = compactRoundingOf(session && session.fileProvenance);
    if (!m) return { message: message, kind: kind };
    return {
        message: message + ' — compact copy: predicted keypoints rounded to ' + stepText(m.xy_px, 'px') +
            ', 3D to ' + stepText(m.points_3d, 'mm') + ' when it was saved',
        kind: kind === 'error' ? 'error' : 'warning',
    };
}
