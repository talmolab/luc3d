// pose/outline-worker.js — animal outlines off the page's thread (module
// worker, spawned by ui/animal-outlines.js's pool; one camera always goes to
// the same worker, which keeps that camera's empty-arena image).
//
// Messages in (each with an `id` the reply echoes):
//   {type: 'background', cam, frames: ImageBitmap[] | Uint8Array[] (grey),
//    w, h, nAnimals, params}
//     -> {bg: Uint8Array (a copy, transferred), model, counts: number[] (blobs
//        per sampled frame), areas: number[][]}. The worker keeps `bg` for `cam`.
//   {type: 'setBackground', cam, bg, w, h} -> {ok: true}
//   {type: 'outline', cam, frame: ImageBitmap | Uint8Array (grey), w, h,
//    animals, model, params}
//     -> computeOutlines' result, its buffers transferred; `labels` too.
//   {type: 'drop', cam} -> {ok: true}
// A failure replies {error: message}.
//
// `handleOutlineMessage` is exported so the page can run the same code inline
// where a module worker or OffscreenCanvas is missing (ui/animal-outlines.js).
//
// Depends on: pose/outline-core.js

import { rgbaToGray, medianImage, segmentBlobs, areaModel, computeOutlines } from './outline-core.js';

/**
 * Grey pixels of `src` (an ImageBitmap/VideoFrame/canvas, or already grey
 * bytes) at w x h. `makeCanvas(w, h)` gives a 2D-context canvas.
 */
function toGray(src, w, h, makeCanvas, state) {
    if (src instanceof Uint8Array) return src;
    var cv = state.canvas;
    if (!cv || cv.width !== w || cv.height !== h) cv = state.canvas = makeCanvas(w, h);
    var ctx = state.ctx && state.canvas === cv ? state.ctx : (state.ctx = cv.getContext('2d', { willReadFrequently: true }));
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    if (typeof src.close === 'function') { try { src.close(); } catch (e) { /* already closed */ } }
    return rgbaToGray(ctx.getImageData(0, 0, w, h).data);
}

/**
 * One message, computed. `store` keeps the backgrounds between calls
 * (`{bgs: Map}`); `makeCanvas` makes the canvas grey conversion draws on.
 * -> {reply, transfer}
 */
export function handleOutlineMessage(msg, store, makeCanvas) {
    store.bgs = store.bgs || new Map();
    var w = msg.w, h = msg.h;
    if (msg.type === 'background') {
        var grays = (msg.frames || []).map(function (f) { return toGray(f, w, h, makeCanvas, store); });
        if (!grays.length) throw new Error('no frames to build the empty arena from');
        var bg = medianImage(grays);
        var counts = [], areas = [];
        for (var i = 0; i < grays.length; i++) {
            var seg = segmentBlobs(grays[i], bg, w, h, msg.params);
            var a = [];
            for (var b = 1; b <= seg.n; b++) a.push(seg.area[b]);
            counts.push(seg.n);
            areas.push(a);
        }
        store.bgs.set(msg.cam, { bg: bg, w: w, h: h });
        var copy = bg.slice();
        return { reply: { bg: copy, model: areaModel(areas, msg.nAnimals, msg.params), counts: counts, areas: areas }, transfer: [copy.buffer] };
    }
    if (msg.type === 'setBackground') {
        store.bgs.set(msg.cam, { bg: msg.bg, w: w, h: h });
        return { reply: { ok: true }, transfer: [] };
    }
    if (msg.type === 'drop') {
        store.bgs.delete(msg.cam);
        return { reply: { ok: true }, transfer: [] };
    }
    if (msg.type === 'outline') {
        var entry = store.bgs.get(msg.cam);
        if (!entry || entry.w !== w || entry.h !== h) {
            if (msg.frame && typeof msg.frame.close === 'function') msg.frame.close();
            throw new Error('no empty-arena image for ' + msg.cam);
        }
        var gray = toGray(msg.frame, w, h, makeCanvas, store);
        var r = computeOutlines(gray, entry.bg, w, h, msg.animals || [], msg.model || null, msg.params);
        var transfer = [r.labels.buffer];
        r.contours.forEach(function (list) { list.forEach(function (p) { transfer.push(p.buffer); }); });
        r.unassigned.forEach(function (p) { transfer.push(p.buffer); });
        return { reply: r, transfer: transfer };
    }
    throw new Error('unknown message ' + msg.type);
}

if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope) {
    var store = { bgs: new Map() };
    var makeCanvas = function (w, h) { return new OffscreenCanvas(w, h); };
    self.onmessage = function (e) {
        var msg = e.data || {};
        try {
            var out = handleOutlineMessage(msg, store, makeCanvas);
            out.reply.id = msg.id;
            self.postMessage(out.reply, out.transfer);
        } catch (err) {
            self.postMessage({ id: msg.id, error: String(err && err.message || err) });
        }
    };
}
