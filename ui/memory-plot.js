/**
 * ui/memory-plot.js — the DOM-free half of the Memory panel (`ui/memory-panel.js`):
 * the sample ring buffer, how to read Chrome's `performance.memory`, the
 * project counters, and the plot's geometry. Import-free, so Node tests load it
 * (`tests/test-memory-plot.mjs`).
 *
 * Nothing here is stored anywhere but in memory: no `.slp`, no `localStorage`.
 */

/** Sample every second while the panel is on screen. */
export const MEMORY_SAMPLE_MS = 1000;
/** The plot spans the last five minutes. */
export const MEMORY_WINDOW_MS = 5 * 60 * 1000;
/** Ring capacity: the window at one sample a second, with slack for late ticks. */
export const MEMORY_RING_CAPACITY = 360;
/** A step between two samples longer than this breaks the line (the panel was folded, or the page was busy). */
export const MEMORY_GAP_MS = 3 * MEMORY_SAMPLE_MS;
/** How often to ask `performance.measureUserAgentSpecificMemory()` (it waits for a GC, so it is slow). */
export const UA_MEMORY_EVERY_MS = 10 * 1000;

const MB = 1024 * 1024;

/**
 * A fixed-size ring of `{ t, used, total, ua }` samples (`t` in ms, sizes in
 * bytes, NaN where unknown), oldest first when read.
 */
export class MemoryRing {
    constructor(capacity) {
        this.capacity = capacity || MEMORY_RING_CAPACITY;
        this._buf = new Array(this.capacity);
        this._start = 0;
        this.length = 0;
    }

    push(sample) {
        const i = (this._start + this.length) % this.capacity;
        this._buf[i] = sample;
        if (this.length < this.capacity) this.length++;
        else this._start = (this._start + 1) % this.capacity;
    }

    /** The samples, oldest first. */
    toArray() {
        const out = new Array(this.length);
        for (let k = 0; k < this.length; k++) out[k] = this._buf[(this._start + k) % this.capacity];
        return out;
    }

    last() {
        return this.length ? this._buf[(this._start + this.length - 1) % this.capacity] : null;
    }

    clear() {
        this._start = 0;
        this.length = 0;
    }
}

/**
 * Chrome's `performance.memory` without `--enable-precise-memory-info` is
 * "bucketized": every size is one of 100 fixed values, all multiples of
 * 100,000 bytes from 10,000,000 up to about 4 GB, and the reading refreshes
 * once every 20 minutes. A precise reading lands on a multiple of 100,000 for
 * both sizes about once in ten billion.
 */
export function isBucketizedHeap(used, total) {
    return Number.isFinite(used) && Number.isFinite(total) &&
        used >= 10000000 && used % 100000 === 0 && total % 100000 === 0;
}

/**
 * Read `perf.memory` (Chrome and Edge only). Returns null where the browser
 * has none (Firefox, Safari).
 */
export function readHeap(perf) {
    const m = perf && perf.memory;
    if (!m || typeof m.usedJSHeapSize !== 'number') return null;
    return {
        used: m.usedJSHeapSize,
        total: m.totalJSHeapSize,
        limit: m.jsHeapSizeLimit,
        bucketized: isBucketizedHeap(m.usedJSHeapSize, m.totalJSHeapSize),
    };
}

/**
 * Sum a `measureUserAgentSpecificMemory()` result: the whole page in bytes,
 * and the part attributed to dedicated workers.
 */
export function summarizeUaMemory(result) {
    if (!result || typeof result.bytes !== 'number') return null;
    let workers = 0;
    (result.breakdown || []).forEach(function (b) {
        const attr = b.attribution || [];
        if (attr.some(function (a) { return a && a.scope === 'DedicatedWorkerGlobalScope'; })) workers += b.bytes || 0;
    });
    return { bytes: result.bytes, workers: workers };
}

/**
 * What the project holds, from sizes the sessions already keep (Map sizes and
 * one number per lazy loader): never a walk over frames or instances, so it
 * costs the same during Track All as at rest.
 */
export function projectCounts(sessions) {
    const out = { sessions: 0, resident: 0, frames: 0, groupFrames: 0, lazy: false };
    (sessions || []).forEach(function (s) {
        if (!s) return;
        out.sessions++;
        const resident = s.frameGroups ? s.frameGroups.size : 0;
        out.resident += resident;
        // instanceGroups is keyed by frame: its size is the frames with a group.
        out.groupFrames += s.instanceGroups ? s.instanceGroups.size : 0;
        const loader = s.lazyLoader;
        if (loader) {
            out.lazy = true;
            out.frames += Math.max(loader.nFrames || 0, resident);
        } else {
            out.frames += resident;
        }
    });
    return out;
}

/** Bytes → "1,234 MB" (MiB, rounded, en-US grouping). Unknown → "–". */
export function formatMB(bytes) {
    if (!Number.isFinite(bytes)) return '–';
    return Math.round(bytes / MB).toLocaleString('en-US') + ' MB';
}

/**
 * Lay the samples of the last `windowMs` out in a `width` x `height` box.
 *
 * The y scale runs from 0 to the larger of the heap limit and the window's
 * peak (plus headroom), so the limit line is always drawn and a reading above
 * the limit (typed arrays count, see the panel's ⓘ) still fits. The line is
 * broken wherever two samples are more than `MEMORY_GAP_MS` apart.
 *
 * @returns {{ usedPath: string, uaPath: string, limitY: number|null, yMax: number, peak: number }}
 *   SVG path data (`M`/`L` commands, '' when empty); `peak` is the window's
 *   largest heap-used sample (0 when none).
 */
export function plotGeometry(samples, opts) {
    const width = opts.width, height = opts.height;
    const now = opts.now;
    const windowMs = opts.windowMs || MEMORY_WINDOW_MS;
    const t0 = now - windowMs;
    const shown = samples.filter(function (s) { return s.t >= t0 && s.t <= now; });
    let peak = 0;
    let top = 0;
    shown.forEach(function (s) {
        if (s.used > peak) peak = s.used;
        if (s.ua > top) top = s.ua;
    });
    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 0;
    let yMax = Math.max(limit, Math.max(peak, top) * 1.1);
    if (!(yMax > 0)) yMax = 1;
    const x = function (t) { return (t - t0) / windowMs * width; };
    const y = function (v) { return height - v / yMax * height; };
    const path = function (key) {
        let d = '';
        let prevT = -Infinity;
        shown.forEach(function (s) {
            const v = s[key];
            if (!Number.isFinite(v)) { prevT = -Infinity; return; }
            const cmd = s.t - prevT > MEMORY_GAP_MS ? 'M' : 'L';
            d += cmd + x(s.t).toFixed(1) + ' ' + y(v).toFixed(1);
            prevT = s.t;
        });
        return d;
    };
    return {
        usedPath: path('used'),
        uaPath: path('ua'),
        limitY: limit ? y(limit) : null,
        yMax: yMax,
        peak: peak,
    };
}
