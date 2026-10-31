/**
 * tracker-pool.js — Track All's cross-view tracker on a worker
 * (pose/tracker-worker.js), fed by the main thread.
 *
 * WHY: Track All ran entirely on the main thread — one core of the machine
 * (8% of 12) — hydrating frames, building detections, matching, re-solving 3D
 * and writing results, one after the other. The tracker itself is sequential
 * (each frame is matched against the targets the previous one left), so it
 * cannot be split across workers frame by frame; but it does not have to share
 * a thread with the hydration and the commit. Here ONE worker runs the tracker,
 * in frame order, while the main thread hydrates the next frames, sends their
 * 2D, and commits results as they come back. Same code, same inputs, same
 * order: the results are bit-identical to the inline run.
 *
 * Usage (main thread, pose/tracker.js):
 *
 *     const pool = await startTrackerWorker(cameras, hp, (fi, targets) => { ...commit... });
 *     if (!pool) { ...track inline... }
 *     for (...) {
 *         pool.submit(fi, perCameraXY);       // Float64Array[] per camera, slot order (copied)
 *         if (pool.saturated()) await pool.throttle();   // at most TRACKER_MAX_IN_FLIGHT batches ahead
 *     }
 *     await pool.committedThrough(fi);        // before a window holding fi is released
 *     await pool.finish();                    // everything committed (throws if the worker failed)
 *     pool.close();
 *
 * `onFrame(fi, targets, live)` — targets `[{trackId, points3d, members}]`, where
 * `members` is (camera index, slot) pairs and `points3d` a view to copy, not keep —
 * runs on the main thread IN SUBMISSION ORDER (one
 * worker, FIFO), from the worker's message handler, so a frame must still be
 * resident when its result arrives — the caller holds windows until
 * `committedThrough`. `startTrackerWorker` resolves null (track inline) when
 * workers are unavailable, `window.LUCID_TRACKER_WORKER === 0` (kill switch /
 * A-B testing), or the worker does not answer its `init` — so a worker that
 * cannot start never costs a run. A failure after that rejects the next wait.
 */
import { createBusyClock } from '../ui/load-graph.js?v=07faed6477b6';

/** Frames per message: ~30 ms of tracking at 5 mice x 8 cameras — enough to amortize messaging. */
export const TRACKER_BATCH = 100;
/**
 * Batches the main thread may run ahead of the commits — 2,000 frames, one
 * Track All sweep window, so the worker has a window's work queued while the
 * main thread hydrates the next (a few hundred ms on a large project) instead
 * of idling through it. Bounds the copies in flight (~14 MB at 5 mice x 8
 * cameras x 17 nodes) and, with the sweep's one-window release lag, the
 * resident frames (two windows).
 */
export const TRACKER_MAX_IN_FLIGHT = 20;

/** Whether Track All should try the worker (`window.LUCID_TRACKER_WORKER = 0` turns it off). */
export function trackerWorkerWanted() {
    if (typeof Worker !== 'function' || typeof document === 'undefined') return false;
    var forced = typeof window !== 'undefined' ? window.LUCID_TRACKER_WORKER : undefined;
    return forced == null || !!forced;
}

function serializeCamera(c) {
    return {
        name: c.name, matrix: c.matrix, dist: c.dist, rvec: c.rvec, tvec: c.tvec, size: c.size,
        R: c.rotationMatrix, Rt: c.extrinsicMatrix, P: c.projectionMatrix,
    };
}

/**
 * Start the worker with the run's cameras (processing order) and tracker
 * hyperparameters, and wait for it to be ready.
 * @param {Camera[]} cameras
 * @param {Object} hp  CrossViewTracker options
 * @param {function(number, Array, number)} onFrame  commit one frame's result (in order); `live` = the tracker's target count after it
 * @param {{busyDuring?: function(function)}} [opts]  `busyDuring(fn)` runs `fn` counted as
 *   main-thread CPU time even inside a wait (ui/loading-overlay.js) — the commits happen there
 * @returns {Promise<?Object>} the handle, or null to track inline
 */
export async function startTrackerWorker(cameras, hp, onFrame, opts) {
    opts = opts || {};
    if (!trackerWorkerWanted()) return null;
    var busyDuring = opts.busyDuring || function (fn) { fn(); };
    var worker;
    try {
        worker = new Worker(new URL('pose/tracker-worker.js?v=07faed6477b6', document.baseURI), { type: 'module' });
    } catch (e) {
        console.warn('[tracker-pool] no tracker worker, tracking on the main thread:', e);
        return null;
    }
    var clock = createBusyClock();             // the worker, busy while it holds a batch
    var nCams = cameras.length, cur = null, lastUsed = 0, nextId = 1, inFlight = 0, failure = null, waiters = [];
    var submitted = -Infinity, committed = -Infinity;
    var wake = function () { var w = waiters; waiters = []; w.forEach(function (fn) { fn(); }); };
    var waitFor = function (cond) {
        return new Promise(function (resolve, reject) {
            var check = function () {
                if (failure) reject(failure);
                else if (cond()) resolve();
                else waiters.push(check);
            };
            check();
        });
    };
    // A batch's results (tracker-worker.js `r`), committed frame by frame, in order.
    var decode = function (r) {
        var t = 0, mo = 0, po = 0;
        for (var i = 0; i < r.fis.length; i++) {
            var n = r.nT[i], targets = new Array(n);
            for (var j = 0; j < n; j++, t++) {
                var k = r.nMem[t], L = r.p3len[t];
                targets[j] = { trackId: r.trackIds[t], members: r.mem.subarray(mo, mo + 2 * k),
                               points3d: L < 0 ? null : r.p3.subarray(po, po + L) };
                mo += 2 * k;
                if (L > 0) po += L;
            }
            onFrame(r.fis[i], targets, r.live[i]);
            committed = r.fis[i];
        }
    };
    var ready = new Promise(function (resolve) {
        worker.onmessage = function (e) {
            var m = e.data;
            if (m.type === 'ready') { resolve(true); return; }
            if (m.type === 'tracked') {
                clock.end('worker');
                inFlight--;
                // A commit that throws fails the run (the next wait rejects) rather than leaving it waiting forever.
                if (!failure) try {
                    busyDuring(function () { decode(m.r); });
                } catch (err) { failure = err; }
            } else {
                failure = failure || new Error('the tracker worker failed: ' + (m.message || 'unknown error'));
                resolve(false);
            }
            wake();
        };
        worker.onerror = function (ev) {
            if (ev && ev.preventDefault) ev.preventDefault();
            failure = failure || new Error('the tracker worker failed' + (ev && ev.message ? ': ' + ev.message : ''));
            resolve(false);
            wake();
        };
    });
    worker.postMessage({ type: 'init', hp: hp, cameras: cameras.map(serializeCamera) });
    if (!(await ready)) {
        console.warn('[tracker-pool] the tracker worker did not start, tracking on the main thread:', failure);
        worker.terminate();
        return null;
    }
    // The batch being filled: frame indices, per (frame, camera) detection counts, each
    // detection's length, and every `_xy` copied end to end into one buffer.
    var newBatch = function () {
        return { fis: [], counts: [], lens: [], xy: new Float64Array(Math.max(4096, lastUsed + (lastUsed >> 2))), used: 0 };
    };
    var flush = function () {
        var b = cur;
        cur = null;
        if (!b || failure) return;
        lastUsed = b.used;
        var xy = b.xy.subarray(0, b.used), fis = Float64Array.from(b.fis), counts = Int32Array.from(b.counts), lens = Int32Array.from(b.lens);
        inFlight++;
        clock.begin('worker');
        worker.postMessage({ type: 'frames', id: nextId++, fis: fis, counts: counts, lens: lens, xy: xy },
            [xy.buffer, fis.buffer, counts.buffer, lens.buffer]);
    };
    return {
        /** Queue frame `fi`: per camera (the run's order), each detection's flat 2D, in slot order — COPIED here. */
        submit: function (fi, cams) {
            var b = cur || (cur = newBatch());
            b.fis.push(fi);
            for (var ci = 0; ci < nCams; ci++) {
                var list = cams[ci] || [];
                b.counts.push(list.length);
                for (var s = 0; s < list.length; s++) {
                    var d = list[s];
                    if (b.used + d.length > b.xy.length) {
                        var grown = new Float64Array(Math.max(b.xy.length * 2, b.used + d.length));
                        grown.set(b.xy.subarray(0, b.used));
                        b.xy = grown;
                    }
                    b.xy.set(d, b.used);
                    b.used += d.length;
                    b.lens.push(d.length);
                }
            }
            submitted = fi;
            if (b.fis.length >= TRACKER_BATCH) flush();
        },
        /** Whether TRACKER_MAX_IN_FLIGHT batches are waiting (or the worker failed): time to `throttle`. */
        saturated: function () { return inFlight >= TRACKER_MAX_IN_FLIGHT || !!failure; },
        /** Resolves once fewer than TRACKER_MAX_IN_FLIGHT batches are waiting (rejects if the worker failed). */
        throttle: function () { return waitFor(function () { return inFlight < TRACKER_MAX_IN_FLIGHT; }); },
        /** Resolves once every submitted frame up to `fi` has been committed (flushes a partial batch). */
        committedThrough: function (fi) {
            var upTo = Math.min(fi, submitted);
            if (committed >= upTo) return failure ? Promise.reject(failure) : Promise.resolve();
            flush();
            return waitFor(function () { return committed >= upTo; });
        },
        /** Resolves once everything submitted has been committed. */
        finish: function () {
            flush();
            return waitFor(function () { return inFlight === 0; });
        },
        /** The worker's busy milliseconds so far (it held a batch), for the CPU line. */
        cpuBusyMs: function () { return clock.ms(); },
        close: function () { clock.close(); worker.terminate(); },
    };
}
