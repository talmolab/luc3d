// pose/outline-flags.js — flags on bad animal outlines (ui/animal-outlines.js):
// "this camera, this frame, this animal's outline is wrong, and why". They are
// the review list the Outlines tab shows and what its export hands on as
// feedback and training data. DOM-free; the file mapping is
// import-export/outline-flags-metadata.js.
//
// A flag: {frame, camera, animal, identity, track, source, reason, note, at}
//   frame    — frame index (integer >= 0)
//   camera   — camera (view) name
//   animal   — the animal's name as the outline showed it, or null (several /
//              not sure)
//   identity — its identity id, or null; track — its track index in that
//              camera, or null; source — '2d' (its own detection) or '3d' (its
//              3D projected), or null
//   reason   — one of OUTLINE_FLAG_REASONS' ids
//   note     — optional short text ('' when none)
//   at       — when it was flagged (ISO time)
// One flag per (frame, camera, animal): flagging the same again replaces it.

export const OUTLINE_FLAG_REASONS = Object.freeze([
    { id: 'limb', label: 'Missed limb' },
    { id: 'tail', label: 'Tail on the wrong animal' },
    { id: 'bleed', label: 'Bleed onto floor or shadow' },
    { id: 'missed', label: 'Missed animal' },
    { id: 'split', label: 'Wrong split between animals' },
    { id: 'other', label: 'Other' },
]);

var REASON_IDS = OUTLINE_FLAG_REASONS.map(function (r) { return r.id; });

/** The label shown for a reason id (the id itself when unknown). */
export function outlineFlagReasonLabel(id) {
    var r = OUTLINE_FLAG_REASONS.find(function (x) { return x.id === id; });
    return r ? r.label : String(id || '');
}

export const OUTLINE_NOTE_MAX = 200;

function intOrNull(v) { return Number.isInteger(v) && v >= 0 ? v : null; }

/** A clean copy of `f`, or null when it is not a flag. */
export function normalizeOutlineFlag(f) {
    if (!f || typeof f !== 'object') return null;
    if (!(Number.isInteger(f.frame) && f.frame >= 0)) return null;
    if (typeof f.camera !== 'string' || !f.camera) return null;
    var reason = REASON_IDS.indexOf(f.reason) >= 0 ? f.reason : 'other';
    return {
        frame: f.frame,
        camera: f.camera,
        animal: typeof f.animal === 'string' && f.animal ? f.animal : null,
        identity: intOrNull(f.identity),
        track: intOrNull(f.track),
        source: f.source === '2d' || f.source === '3d' ? f.source : null,
        reason: reason,
        note: typeof f.note === 'string' ? f.note.slice(0, OUTLINE_NOTE_MAX) : '',
        at: typeof f.at === 'string' ? f.at : '',
    };
}

/** The key that makes two flags the same: frame, camera, animal. */
export function outlineFlagKey(f) {
    return f.frame + '\u0000' + f.camera + '\u0000' + (f.animal == null ? '' : f.animal);
}

function cmp(a, b) {
    return (a.frame - b.frame) || (a.camera < b.camera ? -1 : a.camera > b.camera ? 1 : 0) ||
        String(a.animal || '').localeCompare(String(b.animal || ''));
}

/** The session's flags (sorted by frame, camera, animal). Never null. */
export function outlineFlags(session) {
    return session && Array.isArray(session.outlineFlags) ? session.outlineFlags : [];
}

/**
 * Add a flag to the session (or replace the one with the same frame, camera
 * and animal). -> the stored flag, or null when `flag` is not one.
 */
export function addOutlineFlag(session, flag) {
    var f = normalizeOutlineFlag(flag);
    if (!f || !session) return null;
    if (!f.at) f.at = new Date().toISOString();
    var list = Array.isArray(session.outlineFlags) ? session.outlineFlags : (session.outlineFlags = []);
    var key = outlineFlagKey(f);
    var at = list.findIndex(function (g) { return outlineFlagKey(g) === key; });
    if (at >= 0) list.splice(at, 1);
    var i = 0;
    while (i < list.length && cmp(list[i], f) <= 0) i++;
    list.splice(i, 0, f);
    return f;
}

/** Remove the flag with `flag`'s frame, camera and animal. -> whether one went. */
export function removeOutlineFlag(session, flag) {
    var list = outlineFlags(session);
    var key = outlineFlagKey(flag);
    var at = list.findIndex(function (g) { return outlineFlagKey(g) === key; });
    if (at < 0) return false;
    list.splice(at, 1);
    return true;
}

/** Flags on one camera frame. */
export function outlineFlagsAt(session, frame, camera) {
    return outlineFlags(session).filter(function (f) { return f.frame === frame && (camera == null || f.camera === camera); });
}

/**
 * The `metadata.lucid.outlineFlags` payload: `{v: 1, flags: [...]}` with each
 * flag's empty fields left out, or null when the session has none (never
 * written then).
 */
export function serializeOutlineFlags(session) {
    var list = outlineFlags(session);
    if (!list.length) return null;
    return {
        v: 1,
        flags: list.map(function (f) {
            var o = { frame: f.frame, camera: f.camera };
            if (f.animal != null) o.animal = f.animal;
            if (f.identity != null) o.identity = f.identity;
            if (f.track != null) o.track = f.track;
            if (f.source != null) o.source = f.source;
            o.reason = f.reason;
            if (f.note) o.note = f.note;
            if (f.at) o.at = f.at;
            return o;
        }),
    };
}

/**
 * Read a payload back onto `session.outlineFlags`, REPLACING what it held (a
 * file without flags leaves none). Garbage reads as no flags; bad rows are
 * skipped. -> the number read.
 */
export function ingestOutlineFlags(session, payload) {
    if (!session) return 0;
    session.outlineFlags = [];
    var rows = payload && typeof payload === 'object' && payload.v === 1 && Array.isArray(payload.flags) ? payload.flags : [];
    var n = 0;
    for (var i = 0; i < rows.length; i++) if (addOutlineFlag(session, rows[i])) n++;
    return n;
}
