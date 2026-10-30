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
 *
 * Cutting crops from a frame is SERIALISED across the pool: Chrome on an M2 Pro
 * (2026-10-28) sometimes gave a worker another picture's pixels when two workers
 * drew hardware-decoded VideoFrames at once — about one frame per run of a
 * 10-minute 8-camera recording, never with one worker or on the main thread. So a
 * job first asks the pool for the read token (`{want: id}`, answered by
 * `{grant: true}`), cuts its crops (`cutCrop`, unchanged), closes the frame and
 * hands the token back (`{release: id}`); turning the crops into model inputs
 * (`writeInputTensor`) runs in parallel with the other workers. (Cutting from a 1:1
 * canvas copy of the frame instead, outside the token, is NOT the same pixels: the
 * frame's border is drawn differently, and a software-made VideoFrame differs
 * everywhere.)
 */

import { cutCrop, writeInputTensor, CROP, INPUT } from './image-embedder.js?v=a5f508ce2655';

let canvas = null;
const jobs = [];
let busy = false, granted = null;

self.onmessage = function (e) {
    if (e.data && e.data.grant) { const g = granted; granted = null; if (g) g(); return; }
    jobs.push(e.data);
    if (!busy) run();
};

/** Every crop's grey pixels (cutCrop), cut while holding the pool's read token. */
async function cutAll(id, image, crops) {
    await new Promise(function (resolve) { granted = resolve; self.postMessage({ want: id }); });
    try {
        return crops.map(function (c) { return cutCrop(image, c.g, c.others, canvas); });
    } finally {
        self.postMessage({ release: id });
    }
}

async function run() {
    busy = true;
    while (jobs.length) {
        const { id, image, crops } = jobs.shift();
        try {
            canvas = canvas || new OffscreenCanvas(CROP, CROP);
            let grey;
            try { grey = await cutAll(id, image, crops); } finally { try { if (image && image.close) image.close(); } catch (err) { /* ignore */ } }
            const tensors = grey.map(function (px) {
                const t = new Float32Array(3 * INPUT * INPUT);
                writeInputTensor(px, t, 0);
                return t;
            });
            self.postMessage({ id: id, tensors: tensors }, tensors.map(function (t) { return t.buffer; }));
        } catch (err) {
            self.postMessage({ id: id, error: String((err && err.message) || err) });
        }
    }
    busy = false;
}
