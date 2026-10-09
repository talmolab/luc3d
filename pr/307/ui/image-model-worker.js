/**
 * ui/image-model-worker.js — runs the image ID-switch check's model on the CPU
 * (WebAssembly, fp32) off the main thread (module worker, spawned by
 * ui/image-embedder.js's CPU pool when there is no hardware GPU).
 *
 * On the main thread a CPU model run blocks the page for its whole duration
 * (~0.3 s per crop: 2.6 s for 8, measured), freezing the progress dialog and its
 * Cancel; onnxruntime's own `wasm.proxy` worker cannot start from the CDN bundle
 * ("worker not ready"). Several of these run side by side, one model each,
 * because without cross-origin isolation WebAssembly gets ONE thread.
 *
 *   IN  {type: 'load'}  ->  {type: 'loaded'} | {type: 'error', message}
 *       (while downloading: {type: 'progress', loaded, total})
 *   IN  {type: 'run', id, data, n}   data: Float32Array(n x 3 x INPUT x INPUT), transferred
 *   OUT {type: 'result', id, cls: Float32Array(n x dim), dim} (transferred) | {type: 'error', id, message}
 * `cls` is each crop's CLS token, exactly as the main thread's `clsVectors` reads it.
 */

import { TRANSFORMERS_URL, IMAGE_MODEL_ID, INPUT } from './image-embedder.js?v=acbc61b54ece';

let T = null, model = null;

self.onmessage = async function (e) {
    const m = e.data;
    try {
        if (m.type === 'load') {
            T = await import(TRANSFORMERS_URL);
            // fp32: identical to the WebGPU fp32 model (cosine 1.00000), which matched the calibration;
            // the CPU runtime's default int8 model is what drifted from it
            model = await T.AutoModel.from_pretrained(IMAGE_MODEL_ID, {
                device: 'wasm', dtype: 'fp32',
                progress_callback: function (p) {
                    if (p && p.status === 'progress' && p.total) self.postMessage({ type: 'progress', loaded: p.loaded, total: p.total });
                },
            });
            self.postMessage({ type: 'loaded' });
        } else if (m.type === 'run') {
            const res = await model({ pixel_values: new T.Tensor('float32', m.data, [m.n, 3, INPUT, INPUT]) });
            const hs = res.last_hidden_state, tokens = hs.dims[1], dim = hs.dims[2], cls = new Float32Array(m.n * dim);
            for (let i = 0; i < m.n; i++) cls.set(hs.data.subarray(i * tokens * dim, i * tokens * dim + dim), i * dim);
            self.postMessage({ type: 'result', id: m.id, cls: cls, dim: dim }, [cls.buffer]);
        }
    } catch (err) {
        self.postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
    }
};
