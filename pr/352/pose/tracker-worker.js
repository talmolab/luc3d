/**
 * tracker-worker.js — runs Track All's cross-view tracker off the main thread
 * (module worker, spawned by pose/tracker-pool.js).
 *
 * The tracker is sequential — each frame is matched against the targets the
 * previous one left — so ONE worker runs it, frame by frame, in order; what
 * moves off the main thread is the work itself, while the main thread keeps
 * hydrating frames and writing results back. It runs the SAME code the main
 * thread would (pose/cross-view-tracker.js, which imports only worker-safe
 * modules) on the same inputs in the same order, so the results are
 * bit-identical:
 *   - cameras arrive with the main thread's own cached rotation / extrinsic /
 *     projection matrices installed, so no matrix is re-derived here;
 *   - each detection arrives as a copy of its instance's flat `_xy`, the only
 *     thing `Detection` reads (`toPointsArray` -> `getPoint`), in the same
 *     per-camera slot order `buildTrackerDetections` uses on the main thread
 *     (which also applies the detection filter there).
 *
 * A batch travels as a handful of typed arrays each way, never one object or
 * buffer per detection: serializing ~2,400 small arrays per 100-frame batch cost
 * ~1 s of a 7 s Track All across the two threads (HardFight, 8 cameras) — the
 * worker run was 10% SLOWER than the inline one until this went.
 *
 * Messages in:
 *   { type: 'init', hp, cameras: [{ name, matrix, dist, rvec, tvec, size, R, Rt, P }] }
 *       -> { type: 'ready' }   (or { type: 'error', message })
 *   { type: 'frames', id, fis: Float64Array(F), counts: Int32Array(F x cameras),
 *     lens: Int32Array(detections), xy: Float64Array }
 *       frame i's camera c has counts[i*C + c] detections; each one's `_xy` is
 *       the next lens[d] values of `xy`, in frame, camera, slot order
 *       -> { type: 'tracked', id, r: { fis, nT, live, trackIds, nMem, mem, p3len, p3 } }
 *          or { type: 'error', id, message }
 * `r` is, frame by frame, exactly what `commitTrackedFrame` (pose/tracker.js)
 * reads, in the tracker's target order: frame i has nT[i] targets — each one
 * holding a detection from >= 2 cameras THIS frame — target t has trackIds[t],
 * nMem[t] members as (camera index, slot) pairs in `mem`, in its `detsByCam`
 * order, and a copy of its 3D as the next p3len[t] values of `p3` (-1: none).
 * live[i] is the tracker's target count after frame i (the run's `numTargets`).
 * All transferred. pose/tracker-pool.js decodes it.
 */
import { Camera, Instance } from './pose-data.js?v=400e65ec9232';
import { CrossViewTracker, Detection } from './cross-view-tracker.js?v=400e65ec9232';

let trk = null, cams = null, camIndex = null;

// A deep copy of what postMessage delivered, built by push. A structured clone
// arrives as V8's GENERIC arrays (boxed numbers), never the unboxed double
// arrays the main thread built, and the tracker reads these matrices in its
// innermost loops: unboxing them took the worker's tracking from 7.7 to 7.5 s
// on HardFight (36,000 frames, 8 cameras). Same values, so same results.
function unboxed(v) {
    if (!Array.isArray(v)) return v;
    const out = [];
    for (let i = 0; i < v.length; i++) out.push(unboxed(v[i]));
    return out;
}

function buildCamera(c) {
    const cam = new Camera(c.name, unboxed(c.matrix), unboxed(c.dist), unboxed(c.rvec), unboxed(c.tvec), unboxed(c.size));
    // The main thread's cached matrices, so nothing is re-derived here.
    cam._cachedR = unboxed(c.R);
    cam._cachedRt = unboxed(c.Rt);
    cam._cachedP = unboxed(c.P);
    return cam;
}

function unboxedOptions(hp) {
    const out = {};
    for (const k in hp) out[k] = unboxed(hp[k]);
    return out;
}

// A Float64Array with room for `need` more after `used` (doubling), for the 3D going back.
function grown(a, used, need) {
    if (used + need <= a.length) return a;
    let n = a.length * 2;
    while (n < used + need) n *= 2;
    const b = new Float64Array(n);
    b.set(a.subarray(0, used));
    return b;
}

function trackFrames(m) {
    const nF = m.fis.length, nC = cams.length;
    const nT = new Int32Array(nF), live = new Int32Array(nF);
    const trackIds = [], nMem = [], mem = [], p3len = [];
    let p3 = new Float64Array(4096), p3used = 0, di = 0, off = 0;
    for (let i = 0; i < nF; i++) {
        const fi = m.fis[i], detsByCam = new Map();
        for (let ci = 0; ci < nC; ci++) {
            const cam = cams[ci], n = m.counts[i * nC + ci], dets = new Array(n);
            for (let s = 0; s < n; s++) {
                const len = m.lens[di++];
                // A view into the batch's buffer, adopted by reference (Instance takes a Float64Array as is).
                dets[s] = new Detection(new Instance(m.xy.subarray(off, off + len), 0, 'predicted', 1), cam, fi, s);
                off += len;
            }
            detsByCam.set(cam.name, dets);
        }
        trk.trackFrame(detsByCam, cams);
        for (let ti = 0; ti < trk.targets.length; ti++) {
            const t = trk.targets[ti], before = mem.length;
            t.detsByCam.forEach(function (d, camName) { if (d.frameIdx === fi) mem.push(camIndex.get(camName), d.slot); });
            const k = (mem.length - before) >> 1;
            if (k < 2) { mem.length = before; continue; }        // < 2 cameras: commit skips it too
            nT[i]++;
            trackIds.push(t.trackId);
            nMem.push(k);
            if (t.points3d) {                                    // a copy: the target's array lives on
                const L = t.points3d.length;
                p3 = grown(p3, p3used, L);
                p3.set(t.points3d, p3used);
                p3used += L;
                p3len.push(L);
            } else p3len.push(-1);
        }
        live[i] = trk.targets.length;
    }
    return { fis: m.fis, nT: nT, live: live, trackIds: Float64Array.from(trackIds), nMem: Int32Array.from(nMem),
             mem: Int32Array.from(mem), p3len: Int32Array.from(p3len), p3: p3 };
}

self.onmessage = function (e) {
    const m = e.data;
    try {
        if (m.type === 'init') {
            cams = m.cameras.map(buildCamera);
            camIndex = new Map(cams.map(function (c, i) { return [c.name, i]; }));
            trk = new CrossViewTracker(unboxedOptions(m.hp));
            self.postMessage({ type: 'ready' });
        } else if (m.type === 'frames') {
            const r = trackFrames(m);
            self.postMessage({ type: 'tracked', id: m.id, r: r },
                [r.fis.buffer, r.nT.buffer, r.live.buffer, r.trackIds.buffer, r.nMem.buffer, r.mem.buffer, r.p3len.buffer, r.p3.buffer]);
        }
    } catch (err) {
        self.postMessage({ type: 'error', id: m.id, message: String((err && err.stack) || err) });
    }
};
