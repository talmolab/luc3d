/**
 * compute-governor.js — guardrails for LUCID's long compute runs: how many
 * workers a pool may keep busy right now (driven by the OS's own CPU pressure),
 * a deadline on every worker round trip, a Cancel that does not wait on a
 * promise that may never settle, and a stop before the renderer's ~4 GB heap.
 *
 * DOM-free and worker-safe; tests/test-compute-governor.mjs covers it in Node.
 *
 * WHY (measured on a real 18,255-frame, 6-camera recording with a 1080p60 video
 * playing in another window — prompts/compute-guardrails-report.md):
 *   - Triangulate All (Refined) on hc - 1 = 9 workers drove the Compute
 *     Pressure API to "critical" and delayed a 10 ms timer in ANOTHER process by
 *     up to 130 ms; 6 workers: "serious", 25 ms, only 12% slower; 4: "fair",
 *     18 ms; 2: "nominal", 5 ms. Where the knee is depends on the machine and on
 *     what else it runs, so the worker count is not hand-picked: it follows the
 *     pressure the OS reports: +1 per second while "nominal", hold on "fair" and
 *     "serious", halve on "critical". The stalls other processes felt (> 50 ms
 *     late) came only with "critical"; "serious" alone kept them under 26 ms, and
 *     backing off on it made Triangulate All up to 70% slower whenever something
 *     else kept the machine busy.
 *   - Every pool's wait for a worker had no deadline, and a worker that dies
 *     without an `error` event (or a GPU that is lost) left the run waiting
 *     forever; the image check's Cancel waited on that same promise.
 */

/** Longest a pool waits for ONE reply from a worker before it gives up on it
 *  (terminates it and recovers or fails the run). The slowest round trip measured
 *  is a CPU image-model batch, a few seconds; this is ~25x that. */
export const WORKER_REPLY_TIMEOUT_MS = 120000;
/** The deadline in force: WORKER_REPLY_TIMEOUT_MS, or `globalThis.LUCID_WORKER_REPLY_TIMEOUT_MS` (tests). */
export function workerReplyTimeoutMs() {
    var o = typeof globalThis !== 'undefined' ? Number(globalThis.LUCID_WORKER_REPLY_TIMEOUT_MS) : NaN;
    return o > 0 ? o : WORKER_REPLY_TIMEOUT_MS;
}
/** How often the governor re-decides the worker count from the last pressure state. */
export const PRESSURE_STEP_MS = 1000;
/** Stop a memory-hungry run once the JS heap holds this fraction of its limit (capped at 4 GiB, CLAUDE.md). */
export const HEAP_STOP_FRACTION = 0.85;

/**
 * One step: +1 on 'nominal', hold on 'fair' / 'serious', halve on 'critical'. `state` is a Compute Pressure state ('nominal' | 'fair' |
 * 'serious' | 'critical'); anything else (no reading yet) holds.
 * @param {number} cur
 * @param {?string} state
 * @param {{floor: number, ceiling: number}} lim
 * @returns {number}
 */
export function nextConcurrency(cur, state, lim) {
    var floor = Math.max(1, lim.floor | 0), ceiling = Math.max(floor, lim.ceiling | 0);
    var n = cur;
    if (state === 'nominal') n = cur + 1;
    else if (state === 'critical') n = Math.floor(cur / 2);
    return Math.max(floor, Math.min(ceiling, n));
}

/**
 * A worker-count governor for one run. `allowed()` is how many workers may hold
 * work now; pools dispatch only to that many (never stop a job mid-way, so
 * results are unchanged — only WHEN and WHERE jobs run changes).
 * Without the Compute Pressure API (Firefox, Safari, older Chrome) it stays at
 * `start`.
 * @param {{ceiling: number, floor?: number, start?: number, Observer?: Function,
 *          setInterval?: Function, clearInterval?: Function}} opts
 *   `Observer`: the PressureObserver constructor (default: the global one; tests inject one)
 */
export function createComputeGovernor(opts) {
    var ceiling = Math.max(1, opts.ceiling | 0);
    var floor = Math.max(1, Math.min(ceiling, opts.floor != null ? opts.floor | 0 : 1));
    var cur = Math.max(floor, Math.min(ceiling, opts.start != null ? opts.start | 0 : ceiling));
    var Obs = opts.Observer !== undefined ? opts.Observer : (typeof PressureObserver === 'function' ? PressureObserver : null);
    var setI = opts.setInterval || setInterval, clearI = opts.clearInterval || clearInterval;
    var state = null, observer = null, timer = null, closed = false;
    var seen = { nominal: 0, fair: 0, serious: 0, critical: 0 }, lowest = cur, highest = cur;
    var adaptive = !!Obs && ceiling > floor;
    if (adaptive) {
        try {
            observer = new Obs(function (records) {
                if (records && records.length) state = records[records.length - 1].state;
            });
            var p = observer.observe('cpu', { sampleInterval: PRESSURE_STEP_MS });
            if (p && typeof p.catch === 'function') p.catch(function () { state = null; });   // permission policy / unsupported source
        } catch (e) { observer = null; adaptive = false; }
    }
    if (adaptive) {
        timer = setI(function () {
            if (state && seen[state] != null) seen[state]++;
            cur = nextConcurrency(cur, state, { floor: floor, ceiling: ceiling });
            if (cur < lowest) lowest = cur;
            if (cur > highest) highest = cur;
        }, PRESSURE_STEP_MS);
    }
    return {
        /** Workers that may hold work now (floor..ceiling). */
        allowed: function () { return cur; },
        /** Whether the count follows the OS's pressure (false: fixed at `start`). */
        get adaptive() { return adaptive; },
        /** The last pressure state seen (null: none). */
        get state() { return state; },
        /** For the report / console: seconds in each state, and the range of counts used. */
        summary: function () { return { adaptive: adaptive, seconds: Object.assign({}, seen), lowest: lowest, highest: highest, now: cur }; },
        close: function () {
            if (closed) return;
            closed = true;
            if (timer != null) clearI(timer);
            try { if (observer) observer.disconnect(); } catch (e) { /* ignore */ }
        },
    };
}

/** An Error with `name` 'TimeoutError'. */
export function timeoutError(what, ms) {
    var e = new Error(what + ' did not answer within ' + Math.round(ms / 1000) + ' s');
    e.name = 'TimeoutError';
    return e;
}

/** An Error with `name` 'AbortError' (what `throwIfAborted` throws). */
export function abortError() {
    var e = new Error('Cancelled');
    e.name = 'AbortError';
    return e;
}

/**
 * `promise`, or a rejection with an AbortError as soon as `signal` fires — so a
 * Cancel never waits on a promise that might not settle. The promise itself is
 * not stopped (its owner must clean up), and its later rejection is swallowed.
 */
export function abortable(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) { Promise.resolve(promise).catch(function () {}); return Promise.reject(abortError()); }
    return new Promise(function (resolve, reject) {
        var onAbort = function () { reject(abortError()); };
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(function (v) { signal.removeEventListener('abort', onAbort); resolve(v); },
            function (e) { signal.removeEventListener('abort', onAbort); reject(e); });
    });
}

/**
 * `promise`, or a TimeoutError after `ms` (then `onTimeout()` runs: terminate
 * the worker that did not answer). ms <= 0 or not finite: no deadline.
 */
export function withTimeout(promise, ms, what, onTimeout, timers) {
    if (!(ms > 0) || !isFinite(ms)) return promise;
    var setT = (timers && timers.setTimeout) || setTimeout, clearT = (timers && timers.clearTimeout) || clearTimeout;
    return new Promise(function (resolve, reject) {
        var done = false;
        var t = setT(function () {
            if (done) return;
            done = true;
            try { if (onTimeout) onTimeout(); } catch (e) { /* ignore */ }
            reject(timeoutError(what, ms));
        }, ms);
        Promise.resolve(promise).then(function (v) { if (done) return; done = true; clearT(t); resolve(v); },
            function (e) { if (done) return; done = true; clearT(t); reject(e); });
    });
}

/**
 * Is the JS heap close to its limit? Reads Chrome's `performance.memory`
 * (absent elsewhere: false). The limit is capped at 4 GiB: the renderer's V8
 * heap cage (CLAUDE.md, the memory rule behind #185-#193).
 * @param {?{usedJSHeapSize: number, jsHeapSizeLimit: number}} [mem]
 * @returns {?{usedMB: number, limitMB: number}}  null when there is headroom
 */
export function heapNearLimit(mem) {
    if (mem === undefined) mem = (typeof performance !== 'undefined' && performance.memory) || null;
    if (!mem || !(mem.usedJSHeapSize > 0) || !(mem.jsHeapSizeLimit > 0)) return null;
    var limit = Math.min(mem.jsHeapSizeLimit, 4 * 1024 * 1024 * 1024);
    if (mem.usedJSHeapSize < HEAP_STOP_FRACTION * limit) return null;
    return { usedMB: Math.round(mem.usedJSHeapSize / 1048576), limitMB: Math.round(limit / 1048576) };
}
