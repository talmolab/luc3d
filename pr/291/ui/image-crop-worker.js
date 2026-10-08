/**
 * ui/image-crop-worker.js — cuts the image ID-switch check's crops off the main
 * thread (module worker, spawned by ui/image-embedder.js's crop pool).
 *
 * One message = one camera view of one sampled frame:
 *   IN  {id, image: VideoFrame|ImageBitmap (transferred), crops: [{g, others}]}
 *       where g = cropGeometry(...) and others = the other animals' hulls there
 *   OUT {id, tensors: [Float32Array(3 x INPUT x INPUT)] (transferred)} — one model
 *       input per crop, in order — or {id, error}
 * The worker owns and closes the image. It runs the very same `cutCrop` /
 * `writeInputTensor` the main thread would, so its output is identical.
 */

import { cutCrop, writeInputTensor, CROP, INPUT } from './image-embedder.js?v=85e030a56c25';

let canvas = null;

self.onmessage = function (e) {
    const { id, image, crops } = e.data;
    try {
        canvas = canvas || new OffscreenCanvas(CROP, CROP);
        const tensors = crops.map(function (c) {
            const t = new Float32Array(3 * INPUT * INPUT);
            writeInputTensor(cutCrop(image, c.g, c.others, canvas), t, 0);
            return t;
        });
        self.postMessage({ id: id, tensors: tensors }, tensors.map(function (t) { return t.buffer; }));
    } catch (err) {
        self.postMessage({ id: id, error: String((err && err.message) || err) });
    } finally {
        try { if (image && image.close) image.close(); } catch (err) { /* ignore */ }
    }
};
