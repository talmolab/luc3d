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
 * A fixed-size ring of `{ t, used, total, limit, ua, run }` samples (`t` in
 * ms, sizes in bytes, NaN where unknown; `run` the name of what was running,
 * `runName`, or null), oldest first when read.
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
 * Older Chrome (Playwright's Chromium 153), and any Chrome on `about:blank`,
 * gives a "bucketized" `performance.memory` unless started with
 * `--enable-precise-memory-info`: every size is one of 100 fixed values, all
 * multiples of 100,000 bytes from 10,000,000 up to about 4 GB, and the reading
 * refreshes once every 20 minutes. Chrome 157 reports a live value on an
 * ordinary page, with no flag. A precise reading lands on a multiple of 100,000 for
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

/**
 * The name of what is running, from the progress card (ui/loading-overlay.js
 * `loadingCardText`): its title ("Track All", "Save"), or, for a card without
 * one, its message up to the first count or ellipsis ("Loading SLP files (3/8)…"
 * → "Loading SLP files"). Null when no card is up.
 */
export function runName(card) {
    if (!card) return null;
    const title = (card.title || '').trim();
    if (title) return title.length > 40 ? title.slice(0, 39) + '…' : title;
    let m = (card.message || '').split(/:|\(|…|\.\.\./)[0].trim();
    if (!m) return 'Working';
    return m.length > 40 ? m.slice(0, 39) + '…' : m;
}

/** A duration for a run's tooltip: "45 s", "2 min 5 s", "1 h 3 min". */
export function formatDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' s';
    if (s < 3600) return Math.floor(s / 60) + ' min' + (s % 60 ? ' ' + (s % 60) + ' s' : '');
    const m = Math.floor(s / 60);
    return Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '');
}

/**
 * The runs inside the last `windowMs`, laid out across `width`: one span per
 * stretch of consecutive samples with the same `run` name, ended by another
 * name, none, or a gap longer than `MEMORY_GAP_MS`. A span covers its samples
 * plus one sample period (a one-sample run is still a visible band), and
 * carries the largest heap reading inside it.
 *
 * @returns {Array<{ name: string, t0: number, t1: number, ms: number, x0: number, x1: number, peak: number }>}
 */
export function runSpans(samples, opts) {
    const width = opts.width;
    const now = opts.now;
    const windowMs = opts.windowMs || MEMORY_WINDOW_MS;
    const start = now - windowMs;
    const x = function (t) { return Math.max(0, Math.min(width, (t - start) / windowMs * width)); };
    const out = [];
    let cur = null;
    let prevT = -Infinity;
    const close = function () {
        if (!cur) return;
        const end = Math.min(now, cur.t1 + MEMORY_SAMPLE_MS);
        cur.ms = end - cur.t0;
        cur.x1 = Math.min(width, Math.max(x(cur.t0) + 1, x(end)));
        cur.x0 = Math.min(x(cur.t0), cur.x1 - 1);
        out.push(cur);
        cur = null;
    };
    samples.forEach(function (s) {
        if (!(s.t >= start && s.t <= now)) return;
        const name = s.run || null;
        if (cur && (name !== cur.name || s.t - prevT > MEMORY_GAP_MS)) close();
        if (name) {
            if (!cur) cur = { name: name, t0: s.t, t1: s.t, ms: 0, x0: 0, x1: 0, peak: 0 };
            cur.t1 = s.t;
            if (s.used > cur.peak) cur.peak = s.used;
        }
        prevT = s.t;
    });
    close();
    return out;
}

/**
 * Where each run's name goes along the top of the plot, in `lanes` rows, so
 * no two names in a row overlap. Names are placed newest run first (the one
 * most likely being looked at), then the longest runs: a 1-second check
 * between two long runs never takes the room their names need. In each row in
 * turn a name starts at its band and runs right when the room there holds it,
 * else ends at its band's right edge (the usual case for the run that just
 * ended, at the plot's right edge); the first row where it fits whole takes
 * it. Where none does, it is cut to the most room it has, and hidden when
 * under three characters fit (the band's tooltip still names it). `max` is
 * the width the name may take (the panel's CSS `max-width`, ellipsized past
 * it); widths are estimated at `charW` per character, on the generous side,
 * so a name never runs into the next.
 *
 * @returns {Array<{ x: number, align: 'left'|'right', max: number, lane: number, hidden: boolean }>}
 */
export function placeRunLabels(spans, width, charW, lanes) {
    const cw = charW || 6;
    const nLanes = lanes || 1;
    const PAD = 3;
    const MIN = 3 * cw + 2 * PAD;
    const taken = [];  // per row: the [start, end] of the names placed there
    for (let k = 0; k < nLanes; k++) taken.push([]);
    const inside = function (row, v) { return row.some(function (r) { return v > r[0] + 1e-9 && v < r[1] - 1e-9; }); };
    // The room from `x` rightward / leftward before a placed name or the edge.
    const roomRight = function (row, x) {
        if (inside(row, x)) return -Infinity;
        let end = width;
        row.forEach(function (r) { if (r[0] >= x - 1e-9 && r[0] < end) end = r[0]; });
        return end - x;
    };
    const roomLeft = function (row, x) {
        if (inside(row, x)) return -Infinity;
        let start = 0;
        row.forEach(function (r) { if (r[1] <= x + 1e-9 && r[1] > start) start = r[1]; });
        return x - start;
    };
    const order = spans.map(function (_, i) { return i; });
    const last = spans.length - 1;
    order.sort(function (a, b) {
        if (a === last) return -1;
        if (b === last) return 1;
        return (spans[b].ms - spans[a].ms) || (b - a);
    });
    const out = new Array(spans.length);
    order.forEach(function (i) {
        const sp = spans[i];
        const want = sp.name.length * cw + 2 * PAD;
        let place = null, best = null;
        for (let k = 0; k < nLanes && !place; k++) {
            const right = roomRight(taken[k], sp.x0);
            const left = roomLeft(taken[k], sp.x1);
            if (want <= right) place = { x: sp.x0, align: 'left', max: want, lane: k };
            else if (want <= left) place = { x: sp.x1, align: 'right', max: want, lane: k };
            else {
                const cut = right >= left ? { x: sp.x0, align: 'left', max: right, lane: k } : { x: sp.x1, align: 'right', max: left, lane: k };
                if (!best || cut.max > best.max) best = cut;
            }
        }
        if (!place) place = best;
        place.hidden = !(place.max >= MIN);
        if (!place.hidden) taken[place.lane].push(place.align === 'left' ? [place.x, place.x + place.max] : [place.x - place.max, place.x]);
        out[i] = place;
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
