// pose/outline-worker.js — animal outlines off the page's thread (module
// worker, spawned by ui/animal-outlines.js's pool; one camera always goes to
// the same worker, which keeps that camera's empty-arena image).
//
// Messages in (each with an `id` the reply echoes):
//   {type: 'background', cam, frames: ImageBitmap[] | Uint8Array[] (grey),
//    w, h, nAnimals, params, poses?: per frame the animals' poses there
//    ([{body, tail}]), left out of the median}
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

import { rgbaToGray, medianImage, maskedMedian, poseMask, segmentBlobs, areaModel, singlePoseBlobs, poseAreaModel, mirrorEvidence, reflectingSurfaces, computeOutlines } from './outline-core.js?v=c0dd5c324566';

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
        // each frame's animals (`poses[i]`: their poses there) left out of the median
        var masks = Array.isArray(msg.poses) ? msg.poses.map(function (an) { return an && an.length ? poseMask(w, h, an) : null; }) : null;
        var bg = masks ? maskedMedian(grays, masks) : medianImage(grays);
        var counts = [], areas = [], singles = [];
        for (var i = 0; i < grays.length; i++) {
            var seg = segmentBlobs(grays[i], bg, w, h, msg.params);
            var a = [];
            for (var b = 1; b <= seg.n; b++) a.push(seg.area[b]);
            counts.push(seg.n);
            areas.push(a);
            // blobs holding exactly one animal's pose: what one animal looks like here
            var an = Array.isArray(msg.poses) ? msg.poses[i] : null;
            if (an && an.length) singlePoseBlobs(seg, w, h, an, msg.params).forEach(function (s) { singles.push({ frame: i, area: s.area, reach: s.reach, reach3d: s.reach3d }); });
        }
        store.bgs.set(msg.cam, { bg: bg, w: w, h: h });
        var copy = bg.slice();
        var model = poseAreaModel(singles, msg.params) || areaModel(areas, msg.nAnimals, msg.params);
        // which of the arena's surfaces reflect here: the animals' mirror images
        // (a campy cage) landing on bright pixels in the sampled frames
        if (model && model.reach3d > 0 && Array.isArray(msg.poses) && msg.poses.some(function (an) { return an && an.some(function (a) { return a && a.mirrors && a.mirrors.length; }); })) {
            var ev = {};
            for (var f = 0; f < grays.length; f++) {
                var e = msg.poses[f] ? mirrorEvidence(grays[f], bg, w, h, msg.poses[f], model.reach3d, msg.params) : {};
                for (var k in e) { ev[k] = ev[k] || { n: 0, hits: 0 }; ev[k].n += e[k].n; ev[k].hits += e[k].hits; }
            }
            model.mirrorStats = ev;
            model.mirrors = reflectingSurfaces(ev);
        }
        return { reply: { bg: copy, model: model, counts: counts, areas: areas, singles: singles }, transfer: [copy.buffer] };
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
