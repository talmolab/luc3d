// pose/outline-edits.js — outlines corrected by hand (the Outlines brush,
// ui/outline-brush.js): per camera frame, a label image painted over the
// computed outline (hold the left button to draw the chosen animal, the right
// to erase), kept on `session.outlineEdits` and saved in the project as
// run-length rows (`metadata.lucid.outlineEdits`, through
// import-export/outline-flags-metadata.js). They are what the export hands on
// as corrected masks. DOM-free.
//
// An edit: {frame, camera, w, h, labels: Uint8Array (0 = no animal, k =
// animals[k-1]), animals: [{name, identity, track, source, color}], at}.
// One per (frame, camera). `labels` is ONE image the size of the video, so an
// edit costs w*h bytes in memory (1.3 MB at 1280x1024) and a few KB saved.

export const BRUSH_MIN = 1, BRUSH_MAX = 60;

/** The key of a camera frame. */
export function outlineEditKey(frame, camera) { return frame + '\u0000' + camera; }

function editMap(session) {
    if (!session) return null;
    if (!(session.outlineEdits instanceof Map)) session.outlineEdits = new Map();
    return session.outlineEdits;
}

/** The session's edits (a Map by `outlineEditKey`; empty when none). */
export function outlineEdits(session) {
    return session && session.outlineEdits instanceof Map ? session.outlineEdits : new Map();
}

/** The edit of one camera frame, or null. */
export function outlineEditAt(session, frame, camera) {
    return outlineEdits(session).get(outlineEditKey(frame, camera)) || null;
}

/**
 * Start (or return) the edit of a camera frame from the outline shown there:
 * its label image (copied) and its animals. -> the edit.
 */
export function beginOutlineEdit(session, frame, camera, w, h, labels, animals) {
    var m = editMap(session);
    var key = outlineEditKey(frame, camera);
    var e = m.get(key);
    if (e) return e;
    e = {
        frame: frame, camera: camera, w: w, h: h,
        labels: labels && labels.length === w * h ? Uint8Array.from(labels) : new Uint8Array(w * h),
        animals: (animals || []).map(cleanAnimal),
        at: new Date().toISOString(),
        undo: [],
        version: 0,                                 // bumped by every change (redraws re-trace on it)
    };
    m.set(key, e);
    return e;
}

/** Drop the edit of a camera frame. -> whether there was one. */
export function revertOutlineEdit(session, frame, camera) {
    var m = outlineEdits(session);
    return m.delete(outlineEditKey(frame, camera));
}

function cleanAnimal(a) {
    a = a || {};
    var int = function (v) { return Number.isInteger(v) && v >= 0 ? v : null; };
    return {
        name: typeof a.name === 'string' ? a.name : null,
        identity: int(a.identity), track: int(a.track),
        source: a.source === '2d' || a.source === '3d' ? a.source : null,
        color: typeof a.color === 'string' ? a.color : null,
    };
}

/**
 * Paint a disc of radius `r` px centred at (x, y) into `labels` with `value`
 * (0 erases), recording each changed pixel's old value in `stroke` (`{idx:
 * number[], old: number[]}`) once per stroke. -> pixels changed.
 */
export function paintDisc(labels, w, h, x, y, r, value, stroke) {
    var R = Math.max(0, r), R2 = R * R + 0.25;
    var x0 = Math.max(0, Math.floor(x - R)), x1 = Math.min(w - 1, Math.ceil(x + R));
    var y0 = Math.max(0, Math.floor(y - R)), y1 = Math.min(h - 1, Math.ceil(y + R));
    var n = 0;
    for (var yy = y0; yy <= y1; yy++) {
        var dy = yy + 0.5 - y;
        for (var xx = x0; xx <= x1; xx++) {
            var dx = xx + 0.5 - x;
            if (dx * dx + dy * dy > R2) continue;
            var p = yy * w + xx;
            if (labels[p] === value) continue;
            if (stroke) {
                if (!stroke.seen) stroke.seen = new Set();
                if (!stroke.seen.has(p)) { stroke.seen.add(p); stroke.idx.push(p); stroke.old.push(labels[p]); }
            }
            labels[p] = value;
            n++;
        }
    }
    return n;
}

/**
 * Paint a stroke segment from (x0, y0) to (x1, y1): discs every half radius
 * along it, so a fast drag leaves no gaps. -> pixels changed.
 */
export function paintSegment(labels, w, h, x0, y0, x1, y1, r, value, stroke) {
    var len = Math.hypot(x1 - x0, y1 - y0);
    var step = Math.max(0.5, r / 2);
    var k = Math.max(1, Math.ceil(len / step));
    var n = 0;
    for (var i = 0; i <= k; i++) {
        var t = i / k;
        n += paintDisc(labels, w, h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, value, stroke);
    }
    return n;
}

/** Keep a finished stroke for undo (at most `max` per edit). */
export function pushStroke(edit, stroke, max) {
    if (!edit || !stroke || !stroke.idx.length) return;
    edit.undo.push({ idx: Int32Array.from(stroke.idx), old: Uint8Array.from(stroke.old) });
    var cap = max || 30;
    while (edit.undo.length > cap) edit.undo.shift();
    edit.at = new Date().toISOString();
}

/** Undo an edit's last stroke. -> whether there was one. */
export function undoStroke(edit) {
    if (!edit || !edit.undo || !edit.undo.length) return false;
    var s = edit.undo.pop();
    for (var i = 0; i < s.idx.length; i++) edit.labels[s.idx[i]] = s.old[i];
    edit.version = (edit.version || 0) + 1;
    return true;
}

/** Run-length rows of a label image: [value, count, value, count, ...]. */
export function rleEncode(labels) {
    var out = [];
    var n = labels.length;
    if (!n) return out;
    var v = labels[0], c = 1;
    for (var i = 1; i < n; i++) {
        if (labels[i] === v) { c++; continue; }
        out.push(v, c);
        v = labels[i]; c = 1;
    }
    out.push(v, c);
    return out;
}

/** A label image of `n` pixels from `rleEncode` rows; null when they do not add up to n. */
export function rleDecode(rle, n) {
    if (!Array.isArray(rle) || rle.length % 2) return null;
    var out = new Uint8Array(n);
    var p = 0;
    for (var i = 0; i < rle.length; i += 2) {
        var v = rle[i], c = rle[i + 1];
        if (!(Number.isInteger(v) && v >= 0 && v <= 255 && Number.isInteger(c) && c > 0) || p + c > n) return null;
        if (v) out.fill(v, p, p + c);
        p += c;
    }
    return p === n ? out : null;
}

/**
 * The `metadata.lucid.outlineEdits` payload: `{v: 1, edits: [{frame, camera,
 * w, h, rle, animals, at}]}` sorted by frame and camera, or null with none.
 */
export function serializeOutlineEdits(session) {
    var list = Array.from(outlineEdits(session).values());
    if (!list.length) return null;
    list.sort(function (a, b) { return (a.frame - b.frame) || (a.camera < b.camera ? -1 : a.camera > b.camera ? 1 : 0); });
    return {
        v: 1,
        edits: list.map(function (e) {
            return { frame: e.frame, camera: e.camera, w: e.w, h: e.h, rle: rleEncode(e.labels), animals: e.animals.map(cleanAnimal), at: e.at };
        }),
    };
}

/** Read a payload onto `session.outlineEdits`, REPLACING what it held; bad rows skipped. -> number read. */
export function ingestOutlineEdits(session, payload) {
    if (!session) return 0;
    session.outlineEdits = new Map();
    var rows = payload && typeof payload === 'object' && payload.v === 1 && Array.isArray(payload.edits) ? payload.edits : [];
    var n = 0;
    rows.forEach(function (r) {
        if (!r || !(Number.isInteger(r.frame) && r.frame >= 0) || typeof r.camera !== 'string' || !r.camera) return;
        if (!(Number.isInteger(r.w) && r.w > 0 && Number.isInteger(r.h) && r.h > 0)) return;
        var labels = rleDecode(r.rle, r.w * r.h);
        if (!labels) return;
        session.outlineEdits.set(outlineEditKey(r.frame, r.camera), {
            frame: r.frame, camera: r.camera, w: r.w, h: r.h, labels: labels,
            animals: (Array.isArray(r.animals) ? r.animals : []).map(cleanAnimal),
            at: typeof r.at === 'string' ? r.at : '', undo: [], version: 0,
        });
        n++;
    });
    return n;
}
