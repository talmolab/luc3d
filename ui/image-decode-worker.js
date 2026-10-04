/**
 * ui/image-decode-worker.js — decodes ONE camera's video for the image ID-switch
 * check and cuts its crops, off the main thread (module worker; one per camera,
 * spawned by ui/image-embedder.js).
 *
 * Why: the recordings are HEVC with only P-frames and a keyframe every 250
 * frames, so sampling 2 frames/s decodes EVERY frame (~2,000–2,700 decoded
 * frames/s for 8 cameras). Driven from the main thread, the 8 decoders shared
 * one thread for demuxing, feeding and frame handling; on an RTX 4000 Ada VM the
 * hardware decoder sat at 44% while the check waited on frames. Here each camera
 * demuxes, decodes and crops on its own thread, and only the crops' input
 * tensors (and timings) come back.
 *
 * Messages (in order; one job at a time, frames strictly increasing):
 *   IN  {type: 'open', file: Blob, times: [timestamp per frame], frames: [frame]}
 *       -> {type: 'opened'} | {type: 'error', error}
 *   IN  {type: 'crop', id, frame, crops: [{g, others}]}
 *       -> {id, tensors: [Float32Array(3 x INPUT x INPUT)] (transferred), decodeMs, cropMs} | {id, error}
 *   IN  {type: 'close'}
 * `times` are the mediabunny backend's frame timestamps (`_frameTimes`, sorted by
 * presentation time — the LUCID decode-order patch), so frame i here is frame i
 * everywhere else. The stream decodes forward once through `frames`; a frame no
 * job asks for is decoded and dropped (P-frames need it), exactly as the main
 * thread's streaming reader did. Same `cutCrop` / `writeInputTensor`, so the
 * output is bit-identical to the main-thread path.
 *
 * Imports mediabunny by RELATIVE path: module workers do not see the page's
 * importmap.
 */

import { Input, BlobSource, ALL_FORMATS, VideoSampleSink } from '../lib/mediabunny/mediabunny.min.mjs';
import { cutCrop, writeInputTensor, CROP, INPUT } from './image-embedder.js';

let input = null, it = null, ptr = 0, pos = null, canvas = null;
let chain = Promise.resolve();

async function open(msg) {
    input = new Input({ source: new BlobSource(msg.file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    const sink = new VideoSampleSink(track);
    it = sink.samplesAtTimestamps(msg.times)[Symbol.asyncIterator]();
    pos = new Map(msg.frames.map(function (f, i) { return [f, i]; }));
    ptr = 0;
    canvas = new OffscreenCanvas(CROP, CROP);
}

async function crop(msg) {
    const t0 = performance.now(), want = pos.get(msg.frame);
    if (want == null || want < ptr) throw new Error('frame ' + msg.frame + ' not ahead in this stream');
    while (ptr < want) { const r = await it.next(); ptr++; if (r.value) r.value.close(); }   // decoded, not needed
    const r = await it.next(); ptr++;
    if (!r.value) throw new Error('no sample for frame ' + msg.frame);
    const frame = r.value.toVideoFrame(); r.value.close();
    const t1 = performance.now();
    try {
        const tensors = msg.crops.map(function (c) {
            const t = new Float32Array(3 * INPUT * INPUT);
            writeInputTensor(cutCrop(frame, c.g, c.others, canvas), t, 0);
            return t;
        });
        return { tensors: tensors, decodeMs: t1 - t0, cropMs: performance.now() - t1 };
    } finally { frame.close(); }
}

self.onmessage = function (e) {
    const msg = e.data;
    chain = chain.then(async function () {
        if (msg.type === 'open') {
            try { await open(msg); self.postMessage({ type: 'opened' }); }
            catch (err) { self.postMessage({ type: 'error', error: String((err && err.message) || err) }); }
        } else if (msg.type === 'crop') {
            try {
                const out = await crop(msg);
                self.postMessage({ id: msg.id, tensors: out.tensors, decodeMs: out.decodeMs, cropMs: out.cropMs }, out.tensors.map(function (t) { return t.buffer; }));
            } catch (err) { self.postMessage({ id: msg.id, error: String((err && err.message) || err) }); }
        } else if (msg.type === 'close') {
            try { if (it && it.return) await it.return(); } catch (err) { /* ignore */ }
            try { if (input && input.dispose) input.dispose(); } catch (err) { /* ignore */ }
            it = null; input = null;
        }
    });
};
