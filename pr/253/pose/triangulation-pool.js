/**
 * triangulation-pool.js — run `triangulateAndReproject` for many instance
 * groups across a pool of Web Workers (`pose/triangulation-worker.js`), for the
 * Triangulate All paths.
 *
 * WHY: every group is solved independently (cameras are fixed), but the solve
 * ran on the one main thread — Activity Monitor showed ~1 of 12 cores busy.
 * The workers run the identical code (`pose/triangulation-core.js`) on identical
 * inputs, so results are bit-identical to the inline solve; only WHERE the work
 * runs changes.
 *
 * Usage (main thread):
 *
 *     const solver = createGroupSolver(cameras, { method, triangulateOnly, expectedGroups });
 *     for (...) {
 *         solver.submit(group, groupCameras, (result) => { ...apply... });
 *         solver.mark(() => { ...per-frame bookkeeping... });
 *         await solver.throttle();            // bounded in-flight work
 *     }
 *     await solver.finish();                   // everything applied
 *
 * Callbacks run IN SUBMISSION ORDER (jobs and marks interleaved exactly as
 * submitted), so the order of every side effect on app state is the same as the
 * old inline loop's. The job's inputs (coordinates, nulled nodes, resolved
 * settings) are captured at `submit`, so a lazy window may be released while
 * its jobs are still in flight.
 *
 * Falls back to solving INLINE, synchronously at `submit` (callbacks still in
 * order), when workers are unavailable, the run is small (`expectedGroups` below
 * `MIN_GROUPS_FOR_WORKERS`, where pool start-up would dominate), or
 * `window.LUCID_TRIANGULATION_WORKERS === 0` (kill switch / A-B testing). Set it
 * to N > 0 to force an N-worker pool regardless of size. A batch a worker fails
 * on is re-solved inline, from the same captured inputs.
 */
import { triangulateAndReproject } from './triangulation-core.js?v=d39ae7dcd87f';
import { Instance } from './pose-data.js?v=d39ae7dcd87f';
import { isCameraTracked, getTrackingThreshold } from '../ui/settings.js?v=d39ae7dcd87f';

/** Groups per worker message: big enough to amortize messaging, small enough
 *  to load-balance (~0.25 s of Refined solves, ~20 ms of DLT). */
const BATCH = 384;
/** Below this many groups, solve inline: worker start-up would dominate. */
export const MIN_GROUPS_FOR_WORKERS = 2000;
/** Workers are kept alive between runs, then released after this idle time. */
const IDLE_TERMINATE_MS = 30000;

let pool = null;          // { workers: [{ w, busy }], idleTimer }
let poolOwner = null;     // the solver currently using the pool (one at a time)

function poolSize() {
    const forced = (typeof window !== 'undefined') ? window.LUCID_TRIANGULATION_WORKERS : undefined;
    if (forced != null) return Math.max(0, forced | 0);
    const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
    // Leave one core for the main thread (it prepares and applies batches).
    return Math.max(0, Math.min(hc - 1, 16));
}

function getPool() {
    if (typeof Worker !== 'function' || typeof document === 'undefined') return null;
    const n = poolSize();
    if (n < 1) return null;
    if (pool && pool.workers.length === n) {
        clearTimeout(pool.idleTimer);
        return pool;
    }
    if (pool) terminatePool();
    try {
        const url = new URL('pose/triangulation-worker.js?v=d39ae7dcd87f', document.baseURI);
        const workers = [];
        for (let i = 0; i < n; i++) workers.push({ w: new Worker(url, { type: 'module' }), busy: false });
        pool = { workers, idleTimer: null };
        return pool;
    } catch (e) {
        console.warn('[triangulation-pool] workers unavailable, solving inline:', e);
        pool = null;
        return null;
    }
}

function terminatePool() {
    if (!pool) return;
    clearTimeout(pool.idleTimer);
    for (const x of pool.workers) x.w.terminate();
    pool = null;
}

function serializeCamera(c) {
    return {
        name: c.name, matrix: c.matrix, dist: c.dist, rvec: c.rvec, tvec: c.tvec, size: c.size,
        R: c.rotationMatrix, Rt: c.extrinsicMatrix, P: c.projectionMatrix,
    };
}

/**
 * @param {Camera[]} cameras  every camera a submitted group may use
 * @param {{method?: 'dlt'|'ba', triangulateOnly?: boolean, expectedGroups?: number}} [opts]
 */
export function createGroupSolver(cameras, opts) {
    opts = opts || {};
    const method = opts.method === 'ba' ? 'ba' : 'dlt';
    const triangulateOnly = !!opts.triangulateOnly;
    // The two settings `triangulateAndReproject` would read per group, resolved
    // the way it resolves them (see triangulation-core.js), once per run — the
    // loading overlay blocks the UI, so they cannot change mid-run.
    // (`typeof` guards: the flat-script test sandbox does not load ui/settings.js
    // — same defaults as triangulation-core.js uses without its hooks.)
    const reprojErrorThreshold = typeof getTrackingThreshold === 'function'
        ? getTrackingThreshold('reprojErrorThreshold') : 0;
    const tracked = new Set(cameras.filter((c) =>
        typeof isCameraTracked === 'function' ? isCameraTracked(c.name) : true).map((c) => c.name));

    // An explicit LUCID_TRIANGULATION_WORKERS > 0 forces the pool even for a
    // small run (tests use it to compare pool vs inline on a synthetic project).
    const forced = (typeof window !== 'undefined') ? window.LUCID_TRIANGULATION_WORKERS : undefined;
    const useWorkers = (forced != null && forced > 0) ||
        opts.expectedGroups == null || opts.expectedGroups >= MIN_GROUPS_FOR_WORKERS;
    // One solver owns the pool at a time (they would share onmessage handlers);
    // a second concurrent run simply solves inline.
    const P = (useWorkers && !poolOwner) ? getPool() : null;
    const owner = {};
    if (P) poolOwner = owner;

    // Ordered entries: { kind: 'job'|'mark', cb, result?, done }
    const entries = [];
    let head = 0;
    let batch = [];                // { entry, job, group, groupCameras, options }
    const queue = [];              // batches waiting for a free worker
    let nextBatchId = 1;
    const batchesById = new Map();
    let inFlight = 0;              // dispatched + queued batches
    let failure = null;
    let waiters = [];

    // Options for one group. Always carries the run's `method` explicitly —
    // never triangulateAndReproject's silent DLT default.
    function optionsFor(groupCameras) {
        return {
            method: method,
            includedCameras: groupCameras.filter((c) => tracked.has(c.name)).map((c) => c.name),
            reprojErrorThreshold: reprojErrorThreshold,
            triangulateOnly: triangulateOnly || undefined,
        };
    }
    // Every call below spells the options out, `method: method` included, so the
    // source-level guard in tests/test-triangulation-method-propagation.mjs can
    // see that the method is threaded in rather than defaulted.
    function solve(group, groupCameras, o) {
        return triangulateAndReproject(group, groupCameras, {
            method: method, includedCameras: o.includedCameras,
            reprojErrorThreshold: o.reprojErrorThreshold, triangulateOnly: o.triangulateOnly,
        });
    }

    function drain() {
        while (head < entries.length && entries[head].done) {
            const e = entries[head];
            entries[head] = null;          // release the result as soon as it's applied
            head++;
            e.cb(e.result);
        }
        if (head > 4096 && head * 2 > entries.length) { entries.splice(0, head); head = 0; }
        const w = waiters; waiters = [];
        for (const fn of w) fn();
    }

    // Re-solve a batch a worker could not, from the CAPTURED job — exactly what
    // the worker would have done (the live group's frame may already have been
    // released by a lazy sweep).
    function solveInline(b) {
        for (const it of b.items) {
            const byCam = new Map();
            it.job.camNames.forEach((n, i) => {
                const src = it.job.insts[i];
                if (!src) return;
                const inst = new Instance(src.xy.slice(), 0, 'predicted', 1);
                if (src.nulled) inst.nulledNodes = new Set(src.nulled);
                byCam.set(n, inst);
            });
            it.entry.result = solve({ getInstance: (n) => byCam.get(n) }, it.groupCameras, it.options);
            it.entry.done = true;
        }
    }

    function onWorkerMessage(slot, m) {
        const b = batchesById.get(m.id);
        if (!b) return;
        batchesById.delete(m.id);
        slot.busy = false;
        if (m.type === 'solved') {
            for (let i = 0; i < b.items.length; i++) {
                b.items[i].entry.result = m.results[i];
                b.items[i].entry.done = true;
            }
        } else {
            console.warn('[triangulation-pool] worker failed a batch; re-solving it inline:', m.message);
            try { solveInline(b); } catch (e) { failure = failure || e; }
        }
        inFlight--;
        pump();
        drain();
    }

    function pump() {
        if (!P) return;
        for (const slot of P.workers) {
            if (!queue.length) return;
            if (slot.busy) continue;
            const b = queue.shift();
            slot.busy = true;
            batchesById.set(b.id, b);
            slot.w.postMessage({ type: 'solve', id: b.id, jobs: b.items.map((it) => it.job) });
        }
    }

    function flushBatch() {
        if (!batch.length) return;
        const b = { id: nextBatchId++, items: batch };
        batch = [];
        if (!P) { solveInline(b); drain(); return; }
        inFlight++;
        queue.push(b);
        pump();
    }

    if (P) {
        const cams = cameras.map(serializeCamera);
        for (const slot of P.workers) {
            slot.busy = false;
            slot.w.onmessage = (e) => onWorkerMessage(slot, e.data);
            slot.w.onerror = (ev) => {
                // A worker that died (e.g. failed to load): re-solve its batch inline.
                ev.preventDefault && ev.preventDefault();
                for (const [id, b] of batchesById) {
                    batchesById.delete(id);
                    try { solveInline(b); } catch (e) { failure = failure || e; }
                    inFlight--;
                }
                slot.busy = true;          // never hand it more work in this run
                pump();
                drain();
            };
            slot.w.postMessage({ type: 'cameras', cameras: cams });
        }
    }

    return {
        /** True when solving on workers (false = inline). */
        get parallel() { return !!P; },
        get workers() { return P ? P.workers.length : 0; },

        /** Queue `group` (with its usable `groupCameras`); `cb(result)` runs in order. */
        submit(group, groupCameras, cb) {
            const entry = { kind: 'job', cb, result: null, done: false };
            entries.push(entry);
            const options = optionsFor(groupCameras);
            if (!P) {
                entry.result = solve(group, groupCameras, options);
                entry.done = true;
                drain();
                return;
            }
            const camNames = groupCameras.map((c) => c.name);
            const insts = camNames.map((n) => {
                const inst = group.getInstance(n);
                if (!inst) return null;
                const nn = inst.nulledNodes;
                return {
                    xy: inst._xy.slice(),
                    nulled: (nn && nn.size) ? Array.from(nn) : null,
                };
            });
            batch.push({ entry, groupCameras, options, job: { camNames, insts, options } });
            if (batch.length >= BATCH) flushBatch();
        },

        /** Run `cb()` in order, after everything submitted before it. */
        mark(cb) {
            entries.push({ kind: 'mark', cb, result: null, done: true });
            drain();
        },

        /** Resolves once in-flight work is below ~2 batches per worker. */
        throttle() {
            if (failure) return Promise.reject(failure);
            if (!P || inFlight < P.workers.length * 2) return Promise.resolve();
            return new Promise((resolve) => {
                const check = () => (inFlight < P.workers.length * 2 || failure) ? resolve() : waiters.push(check);
                waiters.push(check);
            });
        },

        /** Abandon the run (caller hit an error): drop pending work and free the
         *  pool — its workers are terminated, so no stale result can arrive. */
        cancel() {
            batch = [];
            queue.length = 0;
            if (P) {
                if (pool === P) terminatePool();
                if (poolOwner === owner) poolOwner = null;
            }
        },

        /** Flush, wait for every job, and run every remaining callback. */
        async finish() {
            flushBatch();
            drain();
            while (P && (inFlight > 0 || head < entries.length)) {
                if (failure) break;
                await new Promise((resolve) => waiters.push(resolve));
            }
            drain();
            if (P) {
                for (const slot of P.workers) { slot.w.onmessage = null; slot.w.onerror = null; slot.busy = false; }
                clearTimeout(P.idleTimer);
                P.idleTimer = setTimeout(terminatePool, IDLE_TERMINATE_MS);
                if (poolOwner === owner) poolOwner = null;
            }
            if (failure) throw failure;
        },
    };
}
