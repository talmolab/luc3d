/**
 * ui/image-embedder.js — appearance embeddings for the image ID-switch check
 * (pose/id-switch-check.js `checkImageSwitches`).
 *
 * For a sampled frame and the identities present, this decodes that frame in
 * every camera (`view.decoder.getFrame`), cuts a MASKED, POSE-ALIGNED crop of
 * each identity from its own 2D keypoints, and embeds the crops with DINOv2-small
 * (the CLS token, 384 values) on the GPU.
 *
 * The crop reproduces the offline pipeline the check was calibrated with
 * (2026-10-03; cosine 0.991 between this model's fp16 WebGPU output and the
 * PyTorch/timm model on the same crop): rotate so nose points right (Nose − TTI
 * direction), centre on the mean of the body keypoints, side = 1.3 × body length
 * (Nose–TTI), 160 × 160, greyscale; everything outside the animal's convex hull
 * dilated by a quarter body length is black, and so are the other animals' hulls
 * in that view (so an overlapping neighbour is not learned as this animal); then
 * resized to 224 × 224 (bilinear) and normalised with the ImageNet mean/SD.
 *
 * The model and runtime (transformers.js, pinned to 4.3.0, + onnx-community/
 * dinov2-small: fp16 ~44 MB, or fp32 ~88 MB on GPUs without 'shader-f16') are
 * fetched from the CDN on FIRST USE and cached by
 * the browser; nothing about the user's data is sent anywhere. It runs on a
 * hardware GPU through WebGPU when there is one (`pickImageDevice`); otherwise on
 * the CPU — the fp32 model on WebAssembly, in module workers
 * (ui/image-model-worker.js, `createCpuModelPool`), ~15x slower with 4 workers on
 * an M2 Pro (9.7 vs ~150 crops/s), and the same embeddings (cosine 1.00000 vs the
 * WebGPU fp32 model; the CPU runtime's default int8 model is what drifted).
 *
 * Decoding: the frames are STREAMED per camera (`prepareFrames`), and on
 * recordings whose keyframes are about as dense as the samples (e.g. one every
 * 0.5 s) each sample is moved to its nearest keyframe and decoded as that ONE
 * frame — see `planKeyframeSamples` (pose/id-switch-check.js) and keyframeIndices.
 *
 * Depends on: ui/app-state.js (state.views), pose/id-switch-check.js
 * (planKeyframeSamples, KEYFRAME_GAP_TOLERANCE), mediabunny (EncodedPacketSink, imported lazily, for the keyframe index);
 * spawns ui/image-crop-worker.js and ui/image-model-worker.js.
 */

import { state } from './app-state.js?v=538c9836a5e6';
import { planKeyframeSamples, KEYFRAME_GAP_TOLERANCE } from '../pose/id-switch-check.js?v=538c9836a5e6';
import { hydrateFrameMembers2d, releaseFrameMembers2d } from '../pose/lazy-residency.js?v=538c9836a5e6';

export const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm';
export const IMAGE_MODEL_ID = 'onnx-community/dinov2-small';
export const IMAGE_MODEL_MB = 44;

/** Crop side (px) and model input side (px). */
export const CROP = 160, INPUT = 224;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const NOSE = 'Nose', TTI = 'TTI';


/**
 * fp16 when the GPU supports 16-bit floats in shaders ('shader-f16'; fastest: 155
 * crops/s measured), else fp32 on the GPU (103 crops/s, and as close to the
 * calibrated embeddings: cosine 0.992 vs 0.991).
 */
async function gpuDtype() {
    try {
        const a = navigator.gpu && await navigator.gpu.requestAdapter();
        return a && a.features && a.features.has('shader-f16') ? 'fp16' : 'fp32';
    } catch (e) { return 'fp32'; }
}

let _modelPromise = null;
/** Load (once) the runtime + model. `onStatus(text)` reports the download. */
export function loadImageModel(onStatus) {
    if (_modelPromise) return _modelPromise;
    _modelPromise = (async function () {
        const dtype = await gpuDtype();
        if (onStatus) onStatus('Loading the image model (' + (dtype === 'fp16' ? IMAGE_MODEL_MB : 2 * IMAGE_MODEL_MB) + ' MB on first use, cached afterwards)…');
        const T = await import(TRANSFORMERS_URL);
        const model = await T.AutoModel.from_pretrained(IMAGE_MODEL_ID, {
            device: 'webgpu', dtype: dtype,
            // Keep the output ON THE GPU: the model's only output is last_hidden_state [n, 257, 384]
            // (5.9 MB for 15 crops) and the check uses 1 of those 257 tokens — clsFromGpu copies just it.
            session_options: { preferredOutputLocation: 'gpu-buffer' },
            progress_callback: function (p) {
                if (onStatus && p && p.status === 'progress' && p.total) {
                    onStatus('Downloading the image model: ' + Math.round(100 * p.loaded / p.total) + '% (first use only)');
                }
            },
        });
        let device = null, ortAdapter = null;
        try { device = await T.env.backends.onnx.webgpu.device; } catch (e) { /* clsFromGpu falls back to a full read */ }
        try { ortAdapter = await T.env.backends.onnx.webgpu.adapter; } catch (e) { /* gpuAdapterInfo asks for one */ }
        return { T: T, model: model, dtype: dtype, device: device, adapter: await gpuAdapterInfo(device, ortAdapter) };
    })();
    _modelPromise.catch(function () { _modelPromise = null; });   // allow a retry after a failure
    return _modelPromise;
}

const GPU_VENDORS = { nvidia: 'NVIDIA', amd: 'AMD', ati: 'AMD', intel: 'Intel', apple: 'Apple', qualcomm: 'Qualcomm', arm: 'Arm', google: 'Google', microsoft: 'Microsoft' };

/**
 * A GPUAdapterInfo as a name for the progress dialog: its `description` when the
 * browser exposes one (often withheld for privacy), else vendor + architecture
 * ("Apple metal-3", "NVIDIA lovelace"); '' when it says nothing.
 */
export function describeAdapter(info) {
    if (!info) return '';
    if (info.description) return String(info.description);
    const v = String(info.vendor || '');
    return [GPU_VENDORS[v.toLowerCase()] || v, String(info.architecture || '')].filter(Boolean).join(' ');
}

/**
 * The adapter WebGPU runs the model on: `{name, fallback}`. `fallback` is a
 * SOFTWARE adapter (e.g. SwiftShader, in a VM with no GPU): WebGPU, but on the
 * CPU — which `pickImageDevice` routes to the CPU workers instead.
 * Read from the model's own device (`GPUDevice.adapterInfo`), else onnxruntime's
 * adapter, else a fresh default one; whichever is missing `isFallbackAdapter`
 * (older Chrome kept it on the adapter) falls through to the next.
 */
export async function gpuAdapterInfo(device, adapter) {
    try {
        let info = device && device.adapterInfo, fallback = info ? info.isFallbackAdapter : undefined;
        if (fallback === undefined) {
            const a = adapter || (typeof navigator !== 'undefined' && navigator.gpu ? await navigator.gpu.requestAdapter() : null);
            const ai = a && (a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : null));
            if (!info) info = ai;
            if (a) fallback = !!(a.isFallbackAdapter || (ai && ai.isFallbackAdapter));
        }
        return { name: describeAdapter(info), fallback: !!fallback };
    } catch (e) { return { name: '', fallback: false }; }
}

/**
 * Where the image model runs: a HARDWARE WebGPU adapter, else the CPU — no
 * WebGPU, no adapter, or only a software one. The last is SwiftShader (headless
 * Chromium's default, and what a VM with no GPU gets): it ran the model at 0.27
 * crops/s, 10x slower than ONE CPU worker, so a software adapter is never used.
 * `why` says, for the dialog, why there is no GPU.
 * @returns {Promise<{kind: 'webgpu'|'cpu', adapter: ?{name, fallback}, why: string}>}
 */
export async function pickImageDevice() {
    const gpu = typeof navigator !== 'undefined' ? navigator.gpu : null;
    let a = null;
    try { a = gpu ? await gpu.requestAdapter() : null; } catch (e) { a = null; }
    const adapter = a ? await gpuAdapterInfo(null, a) : null;
    if (adapter && !adapter.fallback) return { kind: 'webgpu', adapter: adapter, why: '' };
    return { kind: 'cpu', adapter: adapter,
             why: !gpu ? 'this browser has no WebGPU' : !a ? 'WebGPU found no GPU' : 'WebGPU offers only a software adapter' };
}

/** Most CPU model workers (each holds its own ~600 MB model + runtime). */
export const CPU_MODEL_MAX_WORKERS = 4;

/**
 * How many CPU model workers to run. One model per worker, because WebAssembly
 * gets ONE thread without cross-origin isolation (which GitHub Pages cannot
 * turn on). Measured on a 12-core M2 Pro: 1 -> 2.8, 2 -> 5.1, 4 -> 9.7, 6 -> 13.8,
 * 8 -> 14.6 crops/s, at ~600 MB each. So half the cores beyond two (decoding and
 * cropping need the rest), at most one per 2 GB the browser reports
 * (`navigator.deviceMemory`, which Chrome caps at 8), at most
 * CPU_MODEL_MAX_WORKERS, and at least one.
 */
export function cpuModelWorkerCount(cores, memoryGB) {
    let k = Math.floor(((cores > 0 ? cores : 4) - 2) / 2);
    if (memoryGB > 0) k = Math.min(k, Math.floor(memoryGB / 2));
    return Math.max(1, Math.min(CPU_MODEL_MAX_WORKERS, k));
}

/**
 * The CPU model: `count` module workers (ui/image-model-worker.js), each running
 * the fp32 model on WebAssembly off the main thread — on it, one run blocks the
 * page for its whole duration (2.6 s for 8 crops). The first worker downloads the
 * model (reported through `onStatus`) and the rest load it from the browser cache,
 * so it is fetched once. A worker that fails to start is dropped; if none starts,
 * this throws. `run(data, n)` splits the n crops evenly over the workers and
 * resolves to n CLS vectors in order; a worker that dies rejects its share.
 * @returns {Promise<{size: number, run: function(Float32Array, number): Promise<Float32Array[]>, terminate: function}>}
 */
export async function createCpuModelPool(count, onStatus) {
    const SZ = 3 * INPUT * INPUT, slots = [];
    let nextId = 0;
    const start = function (reportProgress) {
        return new Promise(function (resolve, reject) {
            const slot = { w: null, pending: new Map(), dead: null };
            const fail = function (err) {                        // before 'loaded': a failed start; after: a crash
                slot.dead = err;
                slot.pending.forEach(function (p) { p.reject(err); });
                slot.pending.clear();
                try { slot.w.terminate(); } catch (e) { /* ignore */ }
                reject(err);                                     // no-op once started
            };
            try { slot.w = new Worker(new URL('./image-model-worker.js?v=538c9836a5e6', import.meta.url), { type: 'module' }); }
            catch (e) { reject(e); return; }
            slot.w.onerror = function (e) {
                if (e && e.preventDefault) e.preventDefault();
                fail(new Error('the CPU model worker failed' + (e && e.message ? ': ' + e.message : '')));
            };
            slot.w.onmessage = function (e) {
                const m = e.data;
                if (m.type === 'progress') {
                    if (reportProgress && onStatus) onStatus('Downloading the image model: ' + Math.round(100 * m.loaded / m.total) + '% (first use only)');
                } else if (m.type === 'loaded') resolve(slot);
                else if (m.id == null) fail(new Error(m.message));
                else {
                    const p = slot.pending.get(m.id);
                    if (!p) return;
                    slot.pending.delete(m.id);
                    if (m.type === 'result') p.resolve(m); else p.reject(new Error(m.message));
                }
            };
            slot.w.postMessage({ type: 'load' });
        });
    };
    slots.push(await start(true));
    if (count > 1) {
        if (onStatus) onStatus('Starting ' + count + ' CPU workers for the image model…');
        const rest = await Promise.allSettled(Array.from({ length: count - 1 }, function () { return start(false); }));
        rest.forEach(function (r) { if (r.status === 'fulfilled') slots.push(r.value); });
    }
    const runOn = function (slot, data, n) {
        return new Promise(function (resolve, reject) {
            const id = nextId++;
            slot.pending.set(id, { resolve: resolve, reject: reject });
            slot.w.postMessage({ type: 'run', id: id, data: data, n: n }, [data.buffer]);
        });
    };
    return {
        size: slots.length,
        run: async function (data, n) {
            const live = slots.filter(function (s) { return !s.dead; });
            if (!live.length) throw new Error('no CPU model worker is running');
            const k = Math.min(live.length, n), base = Math.floor(n / k), extra = n % k, parts = [];
            for (let i = 0, at = 0; i < k; i++) {
                const m = base + (i < extra ? 1 : 0);
                parts.push(runOn(live[i], data.slice(at * SZ, (at + m) * SZ), m));
                at += m;
            }
            const out = [];
            (await Promise.all(parts)).forEach(function (r) {
                for (let i = 0; i < r.cls.length / r.dim; i++) out.push(r.cls.slice(i * r.dim, (i + 1) * r.dim));
            });
            return out;
        },
        terminate: function () { slots.forEach(function (s) { try { s.w.terminate(); } catch (e) { /* ignore */ } }); slots.length = 0; },
    };
}

/** Does this browser expose WebNN? (Chrome: behind chrome://flags/#web-machine-learning-neural-network.) */
export function hasWebNN() {
    return typeof navigator !== 'undefined' && !!navigator.ml;
}

/** WebNN compiles a static graph, so it runs fixed batches of this many crops (the last one padded). */
export const WEBNN_BATCH = 8;
/** Frames on which both backends embed the same crops before the faster consistent one is kept. */
export const WEBNN_TRIAL_FRAMES = 6;

/**
 * Load the model on WebNN ('gpu' device hint, fp16, input fixed to WEBNN_BATCH
 * crops) and run it once to compile. Not cached: a model the trial rejects is
 * disposed. On Windows, Chrome's WebNN runs through Windows ML / DirectML, which
 * can use NVIDIA tensor cores; on macOS (Chrome 154) it measured CPU-only.
 */
export async function loadWebNNModel(onStatus) {
    if (onStatus) onStatus('Compiling the image model for WebNN (experimental)…');
    const T = await import(TRANSFORMERS_URL);
    const model = await T.AutoModel.from_pretrained(IMAGE_MODEL_ID, {
        device: 'webnn-gpu', dtype: 'fp16',
        session_options: { freeDimensionOverrides: { batch_size: WEBNN_BATCH, num_channels: 3, height: INPUT, width: INPUT } },
    });
    await model({ pixel_values: new T.Tensor('float32', new Float32Array(WEBNN_BATCH * 3 * INPUT * INPUT), [WEBNN_BATCH, 3, INPUT, INPUT]) });
    return model;
}

/**
 * Keep WebNN only if it agrees with the calibrated WebGPU embeddings (median
 * cosine >= 0.998, worst >= 0.98 — WebGPU fp16 itself is 0.991 from the reference)
 * and is at least 10% faster on this machine.
 * @param {{gpuMs: number, nnMs: number, crops: number, cos: number[]}} t  timed trial (warm-up frame excluded)
 * @returns {{backend: 'webgpu'|'webnn', note: string}}
 */
export function chooseBackend(t) {
    if (!t.crops || !t.cos.length) return { backend: 'webgpu', note: 'WebNN: too few frames to compare — used WebGPU' };
    const c = t.cos.slice().sort(function (a, b) { return a - b; }), med = c[c.length >> 1], min = c[0];
    const gpu = t.crops / (t.gpuMs / 1000), nn = t.crops / (t.nnMs / 1000);
    const rates = 'WebNN ' + Math.round(nn) + ' vs WebGPU ' + Math.round(gpu) + ' crops/s';
    if (!(med >= 0.998 && min >= 0.98)) {
        return { backend: 'webgpu', note: 'WebNN embeddings differ from the calibrated model (cosine median ' + med.toFixed(4) + ', worst ' + min.toFixed(3) + ') — used WebGPU' };
    }
    if (!(nn >= 1.1 * gpu)) return { backend: 'webgpu', note: rates + ' — WebNN not faster here, used WebGPU' };
    return { backend: 'webnn', note: rates + ' — using WebNN (embeddings agree: cosine ' + med.toFixed(4) + ')' };
}

/** The CLS token (post-layernorm) of the first `n` items of a model output. */
function clsVectors(res, n) {
    const hs = res.last_hidden_state, tokens = hs.dims[1], dim = hs.dims[2], flat = hs.data, out = [];
    for (let i = 0; i < n; i++) {
        const v = new Float32Array(dim);
        for (let d = 0; d < dim; d++) v[d] = Number(flat[(i * tokens) * dim + d]);
        out.push(v);
    }
    return out;
}

/**
 * The CLS token of each of the first `n` items of a model output that stayed on
 * the GPU (`preferredOutputLocation: 'gpu-buffer'`): one small copy per crop of
 * row 0 into a staging buffer, mapped once — 1/257 of the full readback. Falls
 * back to reading the whole tensor when the output or the device isn't a GPU
 * buffer. Disposes the output either way. Bit-identical to `clsVectors`.
 */
async function clsFromGpu(res, n, device) {
    const t = res.last_hidden_state, ort = (t && t.ort_tensor) || t;
    try {
        if (!device || !ort || ort.location !== 'gpu-buffer' || !ort.gpuBuffer) {
            if (ort && ort.location === 'gpu-buffer' && ort.getData) {   // no device handle: download it all
                const data = await ort.getData();
                return clsVectors({ last_hidden_state: { dims: ort.dims, data: data } }, n);
            }
            return clsVectors(res, n);
        }
        const tokens = ort.dims[1], dim = ort.dims[2], bpe = ort.type === 'float16' ? 2 : 4, row = dim * bpe;
        const staging = device.createBuffer({ size: n * row, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const enc = device.createCommandEncoder();
        for (let i = 0; i < n; i++) enc.copyBufferToBuffer(ort.gpuBuffer, i * tokens * row, staging, i * row, row);
        device.queue.submit([enc.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const raw = staging.getMappedRange().slice(0);
        staging.unmap(); staging.destroy();
        const out = [];
        if (bpe === 4) { const a = new Float32Array(raw); for (let i = 0; i < n; i++) out.push(a.slice(i * dim, (i + 1) * dim)); }
        else { const h = new Float16Array(raw); for (let i = 0; i < n; i++) out.push(Float32Array.from(h.subarray(i * dim, (i + 1) * dim))); }
        return out;
    } finally {
        if (ort && ort.dispose && ort.location === 'gpu-buffer') { try { ort.dispose(); } catch (e) { /* ignore */ } }
    }
}

function cosine(a, b) {
    let ab = 0, aa = 0, bb = 0;
    for (let d = 0; d < a.length; d++) { ab += a[d] * b[d]; aa += a[d] * a[d]; bb += b[d] * b[d]; }
    return ab / Math.sqrt(aa * bb);
}

/** Body-node indices of a skeleton (everything but the tail), plus Nose / TTI. */
export function skeletonIndex(nodes) {
    const names = nodes.map(function (n) { return typeof n === 'string' ? n : n && n.name; });
    return {
        nose: names.indexOf(NOSE), tti: names.indexOf(TTI),
        body: names.map(function (n, i) { return i; }).filter(function (i) { return names[i] && !/^tail/i.test(names[i]); }),
        n: names.length,
    };
}

/** Convex hull (monotone chain) of [x, y] points. */
export function convexHull(pts) {
    const p = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    if (p.length < 3) return p;
    const cross = function (o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); };
    const lo = [], hi = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
    hi.pop(); lo.pop();
    return lo.concat(hi);
}

function pointsOf(inst, idx) {
    const out = [];
    for (const i of idx) { const p = inst.getPoint ? inst.getPoint(i) : null; if (p && isFinite(p[0]) && isFinite(p[1])) out.push([p[0], p[1]]); }
    return out;
}

/**
 * The crop geometry for one instance, or null when the keypoints don't allow one.
 * @returns {{cx, cy, angle, scale, L, hull}} angle in radians (nose direction), scale = CROP / side
 */
export function cropGeometry(inst, sk) {
    const nose = inst.getPoint(sk.nose), tti = inst.getPoint(sk.tti);
    const body = pointsOf(inst, sk.body);
    if (!nose || !tti || body.length < 6) return null;
    const vx = nose[0] - tti[0], vy = nose[1] - tti[1], L = Math.hypot(vx, vy);
    if (!(L >= 15)) return null;
    let cx = 0, cy = 0; for (const q of body) { cx += q[0]; cy += q[1]; }
    cx /= body.length; cy /= body.length;
    // every keypoint (NaN when missing), for the dialog's skeleton overlay (cropPointsToInput); not used by the crop
    const pts = new Float64Array(2 * (sk.n || 0));
    for (let i = 0; i < (sk.n || 0); i++) {
        const p = inst.getPoint(i), ok = p && isFinite(p[0]) && isFinite(p[1]);
        pts[2 * i] = ok ? p[0] : NaN; pts[2 * i + 1] = ok ? p[1] : NaN;
    }
    return { cx: cx, cy: cy, angle: Math.atan2(vy, vx), scale: CROP / (1.3 * L), L: L, hull: convexHull(body), pts: pts };
}

/** identity -> its InstanceGroup at `frame` (an identity seen twice there is ambiguous: left out). */
function identityGroupsAt(session, frame) {
    const out = new Map(), dup = new Set();
    for (const g of (session.instanceGroups && session.instanceGroups.get(frame)) || []) {
        if (g.identityId == null) continue;
        if (out.has(g.identityId)) dup.add(g.identityId); else out.set(g.identityId, g);
    }
    dup.forEach(function (id) { out.delete(id); });
    return out;
}

/**
 * Crop geometry (`cropGeometry`, or null) for each camera `cams[vi]` and each
 * item (`{ group }`, an InstanceGroup at `frame`), from the 2D keypoints alone.
 * `atFrames[vi]` is the frame view vi actually decodes: a keyframe sample may
 * move it, and that view then crops each animal (same identity) from THAT
 * frame's keypoints.
 *
 * On a lazy project the group members of a frame that is not resident hold no
 * 2D — it has been given back to the store (`releaseFrameMembers2d`,
 * pose/lazy-residency.js), as a reopened project's members never had it — so
 * each frame read is hydrated for the read and released after it. Reading the
 * members directly found no keypoints on every such frame, i.e. the check
 * silently embedded nothing there.
 *
 * @param {Session} session
 * @param {number} frame
 * @param {Array<{group: Object}>} items
 * @param {string[]} cams
 * @param {number[]} atFrames
 * @param {Object} sk - `skeletonIndex(...)`
 * @returns {Array<Array<Object|null>>} geo[vi][itemIndex]
 */
export function frameCropGeometry(session, frame, items, cams, atFrames, sk) {
    const touched = new Set([frame]);
    atFrames.forEach(function (f) { touched.add(f); });
    const hydrated = [];
    touched.forEach(function (f) { if (hydrateFrameMembers2d(session, f) > 0) hydrated.push(f); });
    try {
        return cams.map(function (cam, vi) {
            const at = atFrames[vi];
            const groups = at === frame ? null : identityGroupsAt(session, at);
            return items.map(function (it) {
                const g = groups ? groups.get(it.group.identityId) : it.group;
                const inst = g && g.instances && g.instances.get(cam);
                return inst ? cropGeometry(inst, sk) : null;
            });
        });
    } finally {
        hydrated.forEach(function (f) { releaseFrameMembers2d(session, f); });
    }
}

/**
 * Cut one masked, pose-aligned greyscale crop (Uint8Array CROP*CROP) from `image`.
 * `others` = hulls of the other animals in this view (source pixel coords).
 */
export function cutCrop(image, g, others, canvas) {
    canvas = canvas || new OffscreenCanvas(CROP, CROP);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const toCrop = function (c) {      // source px -> crop px: translate, rotate by -angle, scale
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.translate(CROP / 2, CROP / 2); c.scale(g.scale, g.scale); c.rotate(-g.angle); c.translate(-g.cx, -g.cy);
    };
    const hullPath = function (c, hull) { c.beginPath(); hull.forEach(function (q, i) { i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); }); c.closePath(); };
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, CROP, CROP);
    // 1. the mask: this animal's hull, dilated by a quarter body length (round-joined stroke of width L/2)
    toCrop(ctx);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round'; ctx.lineWidth = g.L / 2;
    hullPath(ctx, g.hull); ctx.fill(); ctx.stroke();
    // 2. minus the other animals' (undilated) hulls
    ctx.globalCompositeOperation = 'destination-out';
    for (const h of others) if (h.length >= 3) { hullPath(ctx, h); ctx.fill(); }
    // 3. the frame, kept only where the mask is
    ctx.globalCompositeOperation = 'source-in';
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over';
    const px = ctx.getImageData(0, 0, CROP, CROP).data, out = new Uint8Array(CROP * CROP);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
        out[i] = px[j + 3] ? Math.round(0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2]) : 0;
    }
    return out;
}

// Bilinear 160 -> 224 sample positions, fixed, so computed once (same arithmetic as per pixel).
let _resizeLUT = null;
function resizeLUT() {
    if (_resizeLUT) return _resizeLUT;
    const S = CROP, D = INPUT, i0 = new Int32Array(D), i1 = new Int32Array(D), f = new Float64Array(D);
    for (let k = 0; k < D; k++) {
        const sk = Math.min(Math.max((k + 0.5) * S / D - 0.5, 0), S - 1);
        i0[k] = Math.floor(sk); i1[k] = Math.min(i0[k] + 1, S - 1); f[k] = sk - i0[k];
    }
    return (_resizeLUT = { i0: i0, i1: i1, f: f });
}

/**
 * A model input back to grey pixels, for showing the crop: channel 0 of the
 * normalised tensor (the crop is greyscale, so all three are the same image)
 * into `rgba`, INPUT x INPUT x 4. The inverse of writeInputTensor's
 * normalisation — what the model sees, after the 160 -> 224 resize.
 */
export function inputTensorToPixels(tensor, rgba) {
    const n = INPUT * INPUT, m = MEAN[0], sd = STD[0];
    for (let i = 0; i < n; i++) {
        const v = Math.round((tensor[i] * sd + m) * 255);
        rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
        rgba[4 * i + 3] = 255;
    }
    return rgba;
}

/**
 * Keypoints (`g.pts`, source pixels) where they land in the model input, for
 * drawing the skeleton over the progress dialog's sample crop: cutCrop's
 * transform — about the body centre, rotated by -angle so the nose points
 * right, scaled — then the 160 -> 224 resize, which with align_corners=false
 * scales continuous coordinates by exactly INPUT / CROP. Float32Array(2N) of
 * INPUT-pixel x, y; NaN where a keypoint is missing.
 */
export function cropPointsToInput(g) {
    const pts = g.pts || [], out = new Float32Array(pts.length), k = g.scale * INPUT / CROP;
    const c = Math.cos(g.angle), s = Math.sin(g.angle);
    for (let i = 0; i < pts.length; i += 2) {
        const dx = pts[i] - g.cx, dy = pts[i + 1] - g.cy;
        out[i] = INPUT / 2 + k * (c * dx + s * dy);
        out[i + 1] = INPUT / 2 + k * (-s * dx + c * dy);
    }
    return out;
}

/** Bilinear 160 -> 224 resize (align_corners=false, like torch interpolate) + ImageNet normalisation, into `data` at `offset`. */
export function writeInputTensor(crop, data, offset) {
    const S = CROP, D = INPUT, plane = D * D, L = resizeLUT();
    const m0 = MEAN[0], m1 = MEAN[1], m2 = MEAN[2], s0 = STD[0], s1 = STD[1], s2 = STD[2];
    for (let y = 0; y < D; y++) {
        const r0 = L.i0[y] * S, r1 = L.i1[y] * S, fy = L.f[y], o = offset + y * D;
        for (let x = 0; x < D; x++) {
            const x0 = L.i0[x], x1 = L.i1[x], fx = L.f[x];
            const v = ((crop[r0 + x0] * (1 - fx) + crop[r0 + x1] * fx) * (1 - fy) +
                       (crop[r1 + x0] * (1 - fx) + crop[r1 + x1] * fx) * fy) / 255;
            data[o + x] = (v - m0) / s0; data[o + plane + x] = (v - m1) / s1; data[o + 2 * plane + x] = (v - m2) / s2;
        }
    }
}

/** Index of `t` in the sorted timestamps `times` (nearest, within half a frame), or -1. */
function frameAtTime(times, t) {
    let lo = 0, hi = times.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] < t) lo = m + 1; else hi = m; }
    let i = lo;
    if (i > 0 && Math.abs(times[i - 1] - t) < Math.abs(times[i] - t)) i--;
    const half = times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) / 2 : Infinity;
    return Math.abs(times[i] - t) <= half ? i : -1;
}

const _keyframes = new WeakMap();   // mediabunny backend -> Promise<?Int32Array>
/**
 * A decoder's keyframe indices (increasing), read from the container's packet
 * index — metadata only, no frame data — once per video. null when the decoder
 * has no mediabunny backend (the HTML5 fallback) or the index can't be read.
 * @returns {Promise<?Int32Array>}
 */
export function keyframeIndices(decoder) {
    const be = decoder && decoder._mbBackend;
    if (!be || !be.input || !be._frameTimes || !be._frameTimes.length) return Promise.resolve(null);
    if (!_keyframes.has(be)) {
        _keyframes.set(be, (async function () {
            const { EncodedPacketSink } = await import('mediabunny');   // lazily: keeps this module loadable in Node tests
            const track = await be.input.getPrimaryVideoTrack();
            const out = [];
            for await (const pk of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
                if (pk.type === 'key') { const i = frameAtTime(be._frameTimes, pk.timestamp); if (i >= 0) out.push(i); }
            }
            return Int32Array.from(out.sort(function (a, b) { return a - b; }));
        })().catch(function () { return null; }));
    }
    return _keyframes.get(be);
}

/**
 * A per-camera reader that STREAMS a known, increasing list of frames instead of
 * seeking to each one. `decoder.getFrame(i)` asks mediabunny for one sample at a
 * time, which decodes from the previous keyframe every call (up to a whole GOP —
 * 250 frames in the recordings measured); `samplesAtTimestamps` over the whole
 * list decodes forward once, and jumps straight to a later keyframe when a target
 * sits in a later GOP. `decode[i]` is the frame actually decoded for `frames[i]`
 * (planKeyframeSamples: a keyframe up to half a sample spacing away, so each
 * sample is ONE decoded frame; or the frame itself). Returns null when the
 * decoder has no mediabunny backend (the HTML5 fallback), so the caller uses
 * `getFrame`.
 */
function streamingReader(decoder, frames, decode) {
    const be = decoder && decoder._mbBackend;
    if (!be || !be.sink || typeof be.sink.samplesAtTimestamps !== 'function' || !be._frameTimes) return null;
    decode = decode || frames;
    const ts = decode.map(function (f) { return be._frameTimes[f]; });
    if (ts.some(function (t) { return t == null; })) return null;
    const pos = new Map(frames.map(function (f, i) { return [f, i]; }));
    const it = be.sink.samplesAtTimestamps(ts)[Symbol.asyncIterator]();
    let ptr = 0, chain = Promise.resolve();
    return {
        /** The frame decoded (and to crop keypoints from) for requested `frame`. */
        decodedFrame: function (frame) { const i = pos.get(frame); return i == null ? frame : decode[i]; },
        // resolves to a VideoFrame (caller closes it) or null; frames must be requested in order
        get: function (frame) {
            const want = pos.get(frame);
            const p = chain.then(async function () {
                if (want == null || want < ptr) return null;
                while (ptr < want) { const r = await it.next(); ptr++; if (r.value) r.value.close(); }   // skipped
                const r = await it.next(); ptr++;
                if (!r.value) return null;
                const vf = r.value.toVideoFrame(); r.value.close();
                return vf;
            });
            chain = p.catch(function () {});
            return p;
        },
        close: function () { try { if (it.return) it.return(); } catch (e) { /* ignore */ } },
    };
}

/**
 * Which views to embed for one animal, given its crop geometry per view (null =
 * not croppable there): all croppable views, or with `maxViews` > 0 only the
 * `maxViews` where it appears largest (Nose–TTI length in pixels, `g.L`) — a
 * close, side-on view shows more coat than a distant or foreshortened one.
 * @param {Array<?{L: number}>} geos  per view
 * @param {number} maxViews  0 = all
 * @returns {Set<number>} view indices
 */
export function selectViews(geos, maxViews) {
    const vis = [];
    geos.forEach(function (g, vi) { if (g) vis.push(vi); });
    if (maxViews > 0 && vis.length > maxViews) {
        vis.sort(function (a, b) { return geos[b].L - geos[a].L || a - b; });
        vis.length = maxViews;
    }
    return new Set(vis);
}

/** Sample crops an embedder keeps for the progress dialog (~0.6 MB each). */
export const SAMPLE_CROPS = 12;

/** Most crops one model run takes (memory: ~38 MB of input at 64). */
export const EMBED_MAX_BATCH = 64;
/**
 * Frames the image check keeps in flight, so the next batch fills while the GPU runs this one.
 * 8: 16 was tried (2026-10-04) on an RTX 2000 Ada PC and an RTX 4000 Ada VM and changed nothing
 * (131 -> 124 and 161 -> 160 crops/s) — frame supply is limited by decode THROUGHPUT, not latency,
 * so more in flight only doubled each frame's wait — while the PC's dedicated GPU memory climbed
 * from ~2.5 to 10.6 GB within a minute (vs ~2.2 GB steady at 8).
 */
export const EMBED_IN_FLIGHT = 8;

/**
 * A run's timing as numbers a person can act on. `gpuBusyPct` is the share of the
 * run's wall time spent inside model runs + readback: near 100% means the GPU is
 * the limit; well below means it waits on decode / crop / the main thread (then
 * see `decodeMsPerFrame` and `cropMsPerFrame`, which overlap across in-flight
 * frames, and `queueMsPerFrame`, the wait for a model slot — high when GPU-bound).
 */
export function summarizeEmbedTiming(tm, backend, dtype) {
    const wall = Math.max(1, tm.t1 - tm.t0), busy = tm.runMs + tm.readMs, per = function (x, d) { return d ? x / d : 0; };
    return {
        backend: backend || 'webgpu', dtype: dtype || null, frames: tm.frames, crops: tm.crops, seconds: wall / 1000,
        cropsPerS: per(tm.crops, wall / 1000), batches: tm.batches, avgBatch: per(tm.crops, tm.batches), maxBatch: tm.maxBatch,
        // submitMs: the model call (upload + queueing — it returns before the GPU finishes); gpuWaitMs: waiting
        // for the results + the CLS copy, which is where the GPU's compute time shows up
        gpuBusyPct: 100 * Math.min(1, busy / wall), modelMsPerCrop: per(busy, tm.crops), submitMs: tm.runMs, gpuWaitMs: tm.readMs,
        decodeMsPerFrame: per(tm.decodeMs, tm.frames), cropMsPerFrame: per(tm.cropMs, tm.frames), queueMsPerFrame: per(tm.queueMs, tm.frames),
    };
}

/** How far back the progress dialog's GPU load looks (ms). */
export const GPU_LOAD_WINDOW_MS = 5000;

/**
 * A rolling GPU load for the progress dialog. Fed `(now, busyMs)` — the
 * embedder's cumulative model time, `busyMs()` — it returns the percentage of
 * the last `windowMs` spent running the model, or null until it has 0.5 s of
 * history. It is THIS check's share of the GPU's time (the run summary's
 * `gpuBusyPct`, but recent rather than whole-run): no browser API reports a
 * GPU's total utilisation, so other apps' use of it is not included.
 */
export function createLoadMeter(windowMs) {
    const w = windowMs > 0 ? windowMs : GPU_LOAD_WINDOW_MS, hist = [];
    return function (now, busyMs) {
        hist.push({ t: now, busy: busyMs });
        while (hist.length > 2 && now - hist[1].t >= w) hist.shift();   // oldest sample still spanning the window
        const dt = now - hist[0].t;
        return dt >= 500 ? 100 * Math.min(1, Math.max(0, (busyMs - hist[0].busy) / dt)) : null;
    };
}

/**
 * The progress dialog's device line, from the embedder's `device()` and the
 * current load (null: not measured yet): `{text, warn, title}`.
 * "GPU: Apple metal-3 (WebGPU, fp16) · load 87%". Without a GPU it says so in
 * the warning colour — the CPU workers, or a software adapter if WebGPU was forced
 * onto one — with no load; WebNN, whose device the browser picks, is not claimed
 * to be a GPU.
 */
export function formatEmbedDevice(d, load) {
    if (!d) return { text: '', warn: false, title: '' };
    if (d.backend === 'cpu') {
        return { text: 'No GPU: running on the CPU (' + d.workers + ' worker' + (d.workers === 1 ? '' : 's') + ') — slow', warn: true,
                 title: (d.why ? d.why.charAt(0).toUpperCase() + d.why.slice(1) + ', so the' : 'The') +
                        ' image model runs on the CPU instead — the same model, much slower.' };
    }
    const pct = function (label) { return load == null ? '' : ' · ' + label + ' ' + Math.round(load) + '%'; };
    const title = load == null ? '' : 'The share of the last ' + Math.round(GPU_LOAD_WINDOW_MS / 1000) +
        ' s spent running the image model for this check. Browsers do not report the GPU\'s total load, so other apps are not included.';
    if (d.backend === 'webnn') return { text: 'WebNN, fp16 (the browser picks the GPU or the CPU)' + pct('model busy'), warn: false, title: title };
    if (d.fallback) return { text: 'No GPU: WebGPU is running on the CPU (software adapter) — very slow', warn: true, title: '' };
    const how = 'WebGPU' + (d.dtype ? ', ' + d.dtype : '') + (d.comparing ? '; comparing with WebNN' : '');
    return { text: 'GPU: ' + (d.adapter ? d.adapter + ' (' + how + ')' : how) + pct('load'), warn: false, title: title };
}

/**
 * How the samples were decoded, per camera: `cameras` decoded at keyframes (of
 * `of` streamed), `snappedPct` of their samples moved, and the median keyframe
 * gap in frames (the slowest camera's) — what to fix when it is 0 of N.
 */
export function summarizeKeyframePlans(plans) {
    const used = plans.filter(function (p) { return p && p.streamed; });
    const on = used.filter(function (p) { return p.snapped > 0; });
    const tot = on.reduce(function (a, p) { return a + p.decode.length; }, 0), moved = on.reduce(function (a, p) { return a + p.snapped; }, 0);
    const gaps = used.map(function (p) { return p.keyframeGap; }).filter(isFinite);
    return { cameras: on.length, of: used.length, snappedPct: tot ? 100 * moved / tot : 0,
             keyframeGap: gaps.length ? Math.max.apply(null, gaps) : null, spacing: used.length ? used[0].spacing : null };
}

/** One line for the dialog / console: "155 crops/s over 15 s · GPU busy 98% (41 batches of ~55, 6.3 ms/crop) · per frame: decode 37 ms, crop 146 ms, queue 199 ms · WebGPU fp16". */
export function formatEmbedTiming(t) {
    if (!t || !t.crops) return '';
    const cpu = t.backend === 'cpu';
    return Math.round(t.cropsPerS) + ' crops/s over ' + t.seconds.toFixed(0) + ' s · ' + (cpu ? 'model busy ' : 'GPU busy ') + Math.round(t.gpuBusyPct) + '% (' +
        t.batches + ' batches of ~' + Math.round(t.avgBatch) + ', ' + t.modelMsPerCrop.toFixed(1) + ' ms/crop) · per frame: decode ' +
        Math.round(t.decodeMsPerFrame) + ' ms, crop ' + Math.round(t.cropMsPerFrame) + ' ms, queue ' + Math.round(t.queueMsPerFrame) + ' ms' +
        ' · ' + (cpu ? 'CPU (' + t.workers + ' workers)' : t.backend === 'webnn' ? 'WebNN' : 'WebGPU') + (t.dtype ? ' ' + t.dtype : '') + formatKeyframes(t.keyframes);
}

function formatKeyframes(k) {
    if (!k || !k.of) return '';
    if (k.cameras) return ' · decoded at keyframes in ' + k.cameras + '/' + k.of + ' cameras (' + Math.round(k.snappedPct) + '% of samples)';
    return ' · every frame decoded' + (k.keyframeGap != null ? ' (keyframe every ' + Math.round(k.keyframeGap) + ' frames; a keyframe every 0.5 s — ' +
        Math.floor(KEYFRAME_GAP_TOLERANCE * k.spacing) + ' frames or fewer — would decode only the samples)' : '');
}

/**
 * A pool of crop workers (ui/image-crop-worker.js), or null to crop inline:
 * no Worker support, or `window.LUCID_CROP_WORKERS` = 0. Size: one per core but
 * one, at most 8 (one camera view per job, and a frame has at most a few views
 * per animal). `run(image, crops)` transfers the image (the worker closes it) and
 * resolves to one input tensor per crop; a failed worker rejects its job and
 * the pool stops taking new ones (`broken`), so the caller falls back inline.
 */
export function createCropPool() {
    const forced = typeof window !== 'undefined' ? window.LUCID_CROP_WORKERS : undefined;
    const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
    const n = forced != null ? Math.max(0, forced | 0) : Math.max(0, Math.min(hc - 1, 8));
    if (n < 1 || typeof Worker !== 'function') return null;
    const workers = [], pending = new Map();
    let nextId = 1;
    const pool = {
        broken: false,
        run: function (image, crops) {
            const w = workers.reduce(function (a, b) { return b.load < a.load ? b : a; });
            const id = nextId++;
            w.load++;
            return new Promise(function (resolve, reject) {
                pending.set(id, { resolve: resolve, reject: reject, w: w });
                w.worker.postMessage({ id: id, image: image, crops: crops }, [image]);
            });
        },
        terminate: function () {
            workers.forEach(function (w) { w.worker.terminate(); });
            pending.forEach(function (p) { p.reject(new Error('crop pool closed')); });
            pending.clear();
        },
    };
    const fail = function (w, msg) {
        pool.broken = true;
        pending.forEach(function (p, id) { if (p.w === w) { pending.delete(id); p.reject(new Error(msg)); } });
    };
    try {
        for (let i = 0; i < n; i++) {
            const w = { worker: new Worker(new URL('./image-crop-worker.js?v=538c9836a5e6', import.meta.url), { type: 'module' }), load: 0 };
            w.worker.onmessage = function (e) {
                const p = pending.get(e.data.id); if (!p) return;
                pending.delete(e.data.id); w.load--;
                if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data.tensors);
            };
            w.worker.onerror = function (e) { e.preventDefault(); fail(w, 'crop worker failed: ' + (e.message || 'error')); };
            workers.push(w);
        }
    } catch (e) {
        workers.forEach(function (w) { w.worker.terminate(); });
        return null;
    }
    return pool;
}

/**
 * Build the provider `checkImageSwitches` needs over the active session's loaded
 * videos: `getEmbeddings(frame, items)`, plus `prepareFrames(frames)` /
 * `releaseFrames()` so the frames are STREAMED per camera (see streamingReader)
 * rather than sought one by one. Loads the model first. Model calls are queued,
 * so the check's one-ahead request decodes and crops the next frame while the
 * GPU embeds the current one.
 * `opts.webnn` (true) tries WebNN on the first WEBNN_TRIAL_FRAMES frames beside
 * WebGPU and keeps it only per chooseBackend; 'force' uses it untested (for
 * benchmarking). `backend()` reports the outcome.
 * `opts.device` ('auto', default: `pickImageDevice`) can force 'webgpu' or 'cpu'
 * (tests, benchmarking); `opts.cpuWorkers` overrides `cpuModelWorkerCount`.
 * `opts.maxViewsPerAnimal` (0 = all) embeds only each animal's N largest views
 * (see selectViews): the model, not decoding, is the bottleneck once frames are
 * streamed, so time scales with the number of crops.
 * @param {Session} session
 * @param {{onStatus?: function(string), maxViewsPerAnimal?: number, webnn?: boolean|'force',
 *          device?: 'auto'|'webgpu'|'cpu', cpuWorkers?: number}} [opts]
 * @returns {Promise<{getEmbeddings: function, prepareFrames: function, releaseFrames: function, backend: function,
 *          device: function, busyMs: function, sampleCrops: function, views: string[]}>}
 */
export async function createImageEmbedder(session, opts) {
    opts = opts || {};
    const views = (state.views || []).filter(function (v) { return v && v.decoder && typeof v.decoder.getFrame === 'function'; });
    if (!views.length) throw new Error('needs the session\'s videos to be loaded');
    const sk = skeletonIndex((session.skeleton && session.skeleton.nodes) || []);
    if (sk.nose < 0 || sk.tti < 0) throw new Error('needs Nose and TTI nodes in the skeleton to align crops');
    // A hardware GPU through WebGPU, else the CPU workers (pickImageDevice)
    const where = opts.device === 'cpu' ? { kind: 'cpu', adapter: null, why: 'the CPU was requested' }
        : opts.device === 'webgpu' ? { kind: 'webgpu' } : await pickImageDevice();
    let T = null, model = null, device = null, dtype = 'fp32', adapter = where.adapter, cpu = null, cpuWorkers = 0;
    if (where.kind === 'webgpu') ({ T, model, device, dtype, adapter } = await loadImageModel(opts.onStatus));
    else {
        if (opts.onStatus) opts.onStatus('No GPU (' + where.why + ') — loading the image model to run on the CPU (' + 2 * IMAGE_MODEL_MB + ' MB on first use, cached afterwards)…');
        const nav = typeof navigator !== 'undefined' ? navigator : {};
        cpu = await createCpuModelPool(opts.cpuWorkers > 0 ? Math.floor(opts.cpuWorkers) : cpuModelWorkerCount(nav.hardwareConcurrency, nav.deviceMemory), opts.onStatus);
        cpuWorkers = cpu.size;
    }
    // WebNN (opt-in, experimental): embed the first frames on both backends, then keep the faster consistent one
    let nnModel = null, trial = null, backend = cpu ? 'cpu' : 'webgpu';
    let note = cpu ? 'no GPU — ' + where.why + ': ran on the CPU, ' + cpuWorkers + ' worker' + (cpuWorkers === 1 ? '' : 's') : '';
    if (opts.webnn && !cpu) {                           // WebNN is judged against WebGPU, so not without it
        if (!hasWebNN()) note = 'WebNN is not available in this browser (Chrome: enable chrome://flags/#web-machine-learning-neural-network) — used WebGPU';
        else {
            try {
                nnModel = await loadWebNNModel(opts.onStatus);
                if (opts.webnn === 'force') { backend = 'webnn'; note = 'WebNN forced (benchmarking; no comparison)'; }
                else { trial = { frames: 0, gpuMs: 0, nnMs: 0, crops: 0, cos: [] }; note = 'WebNN: comparing…'; }
            } catch (e) { note = 'WebNN could not run the model (' + String((e && e.message) || e).slice(0, 120) + ') — used WebGPU'; }
        }
    }
    const dropWebNN = function () { if (nnModel) { try { nnModel.dispose(); } catch (e) { /* ignore */ } } nnModel = null; };
    const SZ = 3 * INPUT * INPUT;
    // timing breakdown for this run (stats()): where the time goes, measured on the user's machine
    const tm = { frames: 0, crops: 0, batches: 0, t0: 0, t1: 0, decodeMs: 0, cropMs: 0, queueMs: 0, runMs: 0, readMs: 0, maxBatch: 0, busySince: 0 };
    // busySince: when the model run in flight started (0: none) — busyMs() counts it while it runs
    const runWebGPU = async function (data, n) {
        const a = tm.busySince = performance.now();
        try {
            const res = await model({ pixel_values: new T.Tensor('float32', data, [n, 3, INPUT, INPUT]) });
            const b = performance.now();
            const out = await clsFromGpu(res, n, device);
            tm.runMs += b - a; tm.readMs += performance.now() - b;
            return out;
        } finally { tm.busySince = 0; }
    };
    // `timed`: count it in the run's timing (not during the WebNN trial, where the WebGPU run is the timed one)
    const runWebNN = async function (data, n, timed) {
        const out = [], B = WEBNN_BATCH, t0 = performance.now();
        if (timed) tm.busySince = t0;
        try {
            for (let i = 0; i < n; i += B) {
                const m = Math.min(B, n - i), buf = new Float32Array(B * SZ);   // the last batch zero-padded
                buf.set(data.subarray(i * SZ, (i + m) * SZ));
                clsVectors(await nnModel({ pixel_values: new T.Tensor('float32', buf, [B, 3, INPUT, INPUT]) }), m).forEach(function (v) { out.push(v); });
            }
            if (timed) tm.runMs += performance.now() - t0;   // WebNN returns results on the CPU: run + readback in one
        } finally { if (timed) tm.busySince = 0; }
        return out;
    };
    const runCpu = async function (data, n) {
        const a = tm.busySince = performance.now();
        try {
            const out = await cpu.run(data, n);
            tm.runMs += performance.now() - a;           // the workers return results on the CPU: run + readback in one
            return out;
        } finally { tm.busySince = 0; }
    };
    const embed = async function (data, n) {
        if (cpu) return runCpu(data, n);
        if (trial) {
            try {
                const t0 = performance.now(), a = await runWebGPU(data, n), t1 = performance.now(), b = await runWebNN(data, n), t2 = performance.now();
                if (trial.frames++ > 0) { trial.gpuMs += t1 - t0; trial.nnMs += t2 - t1; trial.crops += n; }   // first frame: warm-up
                a.forEach(function (v, i) { trial.cos.push(cosine(v, b[i])); });
                // full trial, or stop early once WebNN is clearly the slower one (2 timed frames at under half speed)
                if (trial.frames >= WEBNN_TRIAL_FRAMES || (trial.frames >= 3 && trial.nnMs > 2 * trial.gpuMs)) {
                    const d = chooseBackend(trial); backend = d.backend; note = d.note; trial = null;
                    if (backend !== 'webnn') dropWebNN();
                }
                return a;                                  // the calibrated backend's output during the trial
            } catch (e) {
                trial = null; dropWebNN(); backend = 'webgpu';
                note = 'WebNN failed while running (' + String((e && e.message) || e).slice(0, 120) + ') — used WebGPU';
                return runWebGPU(data, n);
            }
        }
        return backend === 'webnn' ? runWebNN(data, n, true) : runWebGPU(data, n);
    };
    const canvas = new OffscreenCanvas(CROP, CROP);
    let readers = null, pool;   // pool: undefined = not made yet, null = inline
    // per view: how its samples were decoded (keyframe sampling or streamed), for stats()
    let plans = [];
    const useKeyframes = opts.keyframes !== false &&
        !(typeof window !== 'undefined' && window.LUCID_IMAGE_KEYFRAMES === 0);
    const frameOf = function (vi, frame) {
        const r = readers && readers[vi];
        if (r) return r.get(frame);
        return views[vi].decoder.getFrame(frame);
    };
    const maxViews = opts.maxViewsPerAnimal > 0 ? Math.floor(opts.maxViewsPerAnimal) : 0;
    // ---- Batching. Model runs are serialised, but each takes EVERY crop that has queued up meanwhile
    // (up to EMBED_MAX_BATCH): the first frame runs alone, and while it runs the next frames' crops
    // accumulate into a bigger batch. With the check keeping EMBED_IN_FLIGHT frames in flight, the GPU
    // gets the next batch as soon as it finishes one instead of waiting on one frame's decode + crop.
    const queue = [];
    let running = false;
    const pump = function () {
        if (running || !queue.length) return;
        const take = [];
        let n = 0;
        while (queue.length && (n === 0 || n + queue[0].tensors.length <= EMBED_MAX_BATCH)) { const q = queue.shift(); take.push(q); n += q.tensors.length; }
        running = true;
        const now = performance.now();
        take.forEach(function (q) { tm.queueMs += now - q.at; });
        const data = new Float32Array(n * SZ);
        let at = 0;
        take.forEach(function (q) { q.tensors.forEach(function (t) { data.set(t, at); at += SZ; }); });
        tm.batches++; tm.maxBatch = Math.max(tm.maxBatch, n);
        embed(data, n).then(function (vecs) {
            let k = 0;
            take.forEach(function (q) { q.resolve(vecs.slice(k, k + q.tensors.length)); k += q.tensors.length; });
        }, function (err) {
            take.forEach(function (q) { q.reject(err); });
        }).then(function () { running = false; pump(); });
    };
    const enqueue = function (tensors) {
        return new Promise(function (resolve, reject) { queue.push({ tensors: tensors, resolve: resolve, reject: reject, at: performance.now() }); pump(); });
    };
    const getEmbeddings = async function (frame, items) {
        const tStart = performance.now();
        if (!tm.t0) tm.t0 = tStart;
        // crop geometry comes from the 2D keypoints alone, so the views to embed are known before decoding
        const geo = frameCropGeometry(session, frame, items,
            views.map(function (v) { return v.cameraName || v.name; }),
            views.map(function (v, vi) { const r = readers && readers[vi]; return r ? r.decodedFrame(frame) : frame; }),
            sk);
        const want = items.map(function (it, ii) { return selectViews(geo.map(function (g) { return g[ii]; }), maxViews); });
        const cropsFor = function (vi) {        // the crops to cut in view vi (every other animal masked out, picked for it or not)
            const gv = geo[vi], crops = [], who = [];
            items.forEach(function (it, ii) {
                if (!want[ii].has(vi)) return;
                crops.push({ g: gv[ii], others: gv.filter(function (g2, j) { return j !== ii && g2; }).map(function (g2) { return g2.hull; }) });
                who.push([ii, views[vi].cameraName || views[vi].name]);
            });
            return { vi: vi, crops: crops, who: who };
        };
        // fetch only the cameras some item needs (a streamed reader steps past a frame nobody asks for);
        // a streamed frame is ours to hand over and close, a getFrame one belongs to the decoder's cache
        const images = await Promise.all(views.map(async function (v, vi) {
            if (!want.some(function (w) { return w.has(vi); })) return null;
            try {
                const r = readers && readers[vi];
                const img = r ? await r.get(frame) : await views[vi].decoder.getFrame(frame);
                return img ? { img: img, owned: !!r } : null;
            } catch (e) { return null; }
        }));
        const tFrames = performance.now();
        tm.decodeMs += tFrames - tStart;
        // per view: the crops to cut there
        const jobs = [];
        views.forEach(function (v, vi) { if (images[vi]) jobs.push(cropsFor(vi)); });
        const inline = function (job) {
            return job.crops.map(function (c) {
                const t = new Float32Array(SZ);
                writeInputTensor(cutCrop(images[job.vi].img, c.g, c.others, canvas), t, 0);
                return t;
            });
        };
        let tensors;
        try {
            if (!pool && pool !== null) pool = createCropPool();
            tensors = await Promise.all(jobs.map(async function (job) {
                if (!pool || pool.broken) return inline(job);
                const im = images[job.vi];
                // hand the worker a frame it may close: ours as is; a cached VideoFrame as a clone (same
                // pixels — an ImageBitmap of a VideoFrame is colour-converted differently); else a copy
                const send = im.owned ? im.img
                    : (typeof VideoFrame !== 'undefined' && im.img instanceof VideoFrame) ? im.img.clone()
                    : await createImageBitmap(im.img);
                if (im.owned) im.img = null;              // transferred: the worker closes it
                return pool.run(send, job.crops).catch(function (e) {
                    console.warn('[image-embedder] crop worker failed, skipping one view of frame ' + frame + ':', e.message);
                    return [];
                });
            }));
        } finally {
            images.forEach(function (im) { if (im && im.owned && im.img && im.img.close) im.img.close(); });
        }
        tm.cropMs += performance.now() - tFrames;
        return finishFrame(frame, items, { jobs: jobs, tensors: tensors });
    };
    // The crops the progress dialog cycles through (sampleCrops): one per frame, rotating through the
    // frame's animals and cameras, the last SAMPLE_CROPS kept. Only references — the tensors are on the
    // main thread anyway, before their batch goes to the model — and nothing is converted unless the
    // dialog asks. Several, not just the latest: on the CPU frames arrive in bursts (8 cut at once,
    // then ~6 s of model time), so a single latest crop would sit still between them.
    const samples = [];
    let sampleSeq = 0;
    // Queue the frame's crops for the model and hand back {camera, vector} per item.
    const finishFrame = async function (frame, items, cut) {
        const out = items.map(function () { return []; });
        const owner = [], geos = [];   // owner[i] = [item index, camera]; geos[i] = its crop geometry
        cut.jobs.forEach(function (job, j) {
            if (cut.tensors[j].length) { job.who.forEach(function (w) { owner.push(w); }); job.crops.forEach(function (c) { geos.push(c.g); }); }
        });
        tm.frames++;
        if (!owner.length) return out;
        const flat = [];
        cut.tensors.forEach(function (ts) { ts.forEach(function (t) { flat.push(t); }); });
        const pick = sampleSeq++ % flat.length, who = items[owner[pick][0]];
        samples.push({ tensor: flat[pick], frame: frame, camera: owner[pick][1], identityId: who && who.group ? who.group.identityId : null,
                       points: cropPointsToInput(geos[pick]) });
        if (samples.length > SAMPLE_CROPS) samples.shift();
        const vecs = await enqueue(flat);
        tm.crops += vecs.length; tm.t1 = performance.now();
        vecs.forEach(function (v, i) { out[owner[i][0]].push({ camera: owner[i][1], vector: v }); });
        return out;
    };
    return {
        getEmbeddings: getEmbeddings,
        /** How many frames the check should keep in flight (so batches can fill while the GPU works). */
        inFlight: EMBED_IN_FLIGHT,
        /** Where the time went in this run — see `summarizeEmbedTiming`. */
        // the precision that actually ran: WebGPU runs fp16 only where the GPU offers 'shader-f16'
        // (fp32 measured ~1.5x slower on an M2 Pro); the WebNN path always loads fp16
        stats: function () {
            const t = summarizeEmbedTiming(tm, backend, backend === 'webnn' ? 'fp16' : dtype);
            t.keyframes = summarizeKeyframePlans(plans);
            if (cpu) t.workers = cpuWorkers;
            return t;
        },
        prepareFrames: async function (frames) {
            const tracked = function (f) { return !!(session.instanceGroups && session.instanceGroups.has(f)); };
            plans = await Promise.all(views.map(async function (v) {
                // opts.keyframes may be a function (decoder -> keyframe indices): a test / benchmark hook
                const kf = !useKeyframes ? null
                    : typeof opts.keyframes === 'function' ? await opts.keyframes(v.decoder) : await keyframeIndices(v.decoder);
                return planKeyframeSamples(frames, kf, tracked);
            }));
            readers = views.map(function (v, vi) { return streamingReader(v.decoder, frames, plans[vi].decode); });
            plans.forEach(function (p, vi) { p.streamed = !!readers[vi]; });   // (stats() runs after releaseFrames)
        },
        releaseFrames: function () {
            if (readers) readers.forEach(function (r) { if (r) r.close(); });
            readers = null;
            if (pool) pool.terminate();
            pool = undefined;
            if (trial) { const d = chooseBackend(trial); note = d.note.replace(/ — using WebNN/, ' — WebNN would have been used'); trial = null; }
            dropWebNN();
            if (cpu) cpu.terminate();                      // ~600 MB each: not kept between runs (reloading is ~1 s from cache)
        },
        /** Which model backend embedded the crops, and why (for the dialog). */
        backend: function () { return { name: backend, note: note }; },
        /** What is running the model right now, for the progress dialog's device line (formatEmbedDevice). */
        device: function () {
            return { backend: backend, comparing: !!trial, dtype: backend === 'webnn' ? 'fp16' : dtype,
                     adapter: adapter ? adapter.name : '', fallback: !!(adapter && adapter.fallback),
                     workers: cpuWorkers, why: where.why || '' };
        },
        /** The latest sample crops, oldest first: `[{tensor, frame, camera, identityId, points}]`, at most SAMPLE_CROPS —
         *  see inputTensorToPixels; `points` are the keypoints in the crop (cropPointsToInput). */
        sampleCrops: function () { return samples; },
        /** Milliseconds spent running the model so far, the run in flight included (feeds createLoadMeter). */
        busyMs: function () { return tm.runMs + tm.readMs + (tm.busySince ? performance.now() - tm.busySince : 0); },
        views: views.map(function (v) { return v.cameraName || v.name; }),
    };
}
