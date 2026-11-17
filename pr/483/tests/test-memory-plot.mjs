/**
 * test-memory-plot.mjs — the DOM-free half of the Memory panel
 * (`ui/memory-plot.js`): the sample ring, reading Chrome's
 * `performance.memory` (and telling its rounded 20-minute reading from a live
 * one), summing `measureUserAgentSpecificMemory()`, the project counters, and
 * the plot's geometry. The panel itself is covered by e2e `memory-panel.mjs`.
 */
import {
    MemoryRing, isBucketizedHeap, readHeap, summarizeUaMemory, projectCounts, formatMB, plotGeometry,
    MEMORY_GAP_MS, MEMORY_WINDOW_MS,
} from '../ui/memory-plot.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const J = JSON.stringify;

// ---- §1 the ring keeps the newest `capacity` samples, oldest first ----
{
    const r = new MemoryRing(3);
    check(r.length === 0 && r.last() === null && J(r.toArray()) === '[]', 'an empty ring');
    [1, 2].forEach(t => r.push({ t }));
    check(J(r.toArray().map(s => s.t)) === '[1,2]' && r.last().t === 2, 'below capacity: everything, in order');
    [3, 4, 5].forEach(t => r.push({ t }));
    check(J(r.toArray().map(s => s.t)) === '[3,4,5]' && r.length === 3 && r.last().t === 5,
        'past capacity: the oldest are dropped, order kept');
    r.clear();
    check(r.length === 0 && r.last() === null, 'clear empties it');
}

// ---- §2 rounded (bucketized) vs live readings ----
{
    // Values Chrome returned without --enable-precise-memory-info.
    check(isBucketizedHeap(10000000, 10000000), "Chrome's smallest bucket is rounded");
    check(isBucketizedHeap(36200000, 38100000), 'multiples of 100,000 on both sizes read as rounded');
    // Values Chrome returned WITH the flag.
    check(!isBucketizedHeap(13267961, 18956297), 'a precise reading is live');
    check(!isBucketizedHeap(36200000, 38100001), 'one size off a multiple is enough to be live');
    check(!isBucketizedHeap(900000, 1000000), 'below the smallest bucket cannot be rounded');
    check(!isBucketizedHeap(NaN, NaN), 'NaN is not rounded');
}

// ---- §3 readHeap: Chrome only ----
{
    check(readHeap({}) === null && readHeap(null) === null, 'no performance.memory (Firefox, Safari) → null');
    const h = readHeap({ memory: { usedJSHeapSize: 13267961, totalJSHeapSize: 18956297, jsHeapSizeLimit: 4395630592 } });
    check(h && h.used === 13267961 && h.total === 18956297 && h.limit === 4395630592 && h.bucketized === false,
        'Chrome: used / total / limit, live');
    const c = readHeap({ memory: { usedJSHeapSize: 10000000, totalJSHeapSize: 10000000, jsHeapSizeLimit: 3760000000 } });
    check(c && c.bucketized === true, 'Chrome without the flag: marked rounded');
}

// ---- §4 measureUserAgentSpecificMemory ----
{
    const r = summarizeUaMemory({
        bytes: 1000,
        breakdown: [
            { bytes: 600, attribution: [{ url: 'x', scope: 'Window' }], types: ['JS'] },
            { bytes: 300, attribution: [{ url: 'w', scope: 'DedicatedWorkerGlobalScope' }], types: ['JS'] },
            { bytes: 100, attribution: [], types: [] },
        ],
    });
    check(r && r.bytes === 1000 && r.workers === 300, 'the whole page, and the part in dedicated workers');
    check(summarizeUaMemory(null) === null && summarizeUaMemory({}) === null, 'no result → null');
    check(J(summarizeUaMemory({ bytes: 5 })) === '{"bytes":5,"workers":0}', 'no breakdown → no workers');
}

// ---- §5 project counters read only Map sizes and the lazy frame count ----
{
    const touchy = () => { throw new Error('walked'); };
    const map = n => {
        const m = new Map();
        for (let i = 0; i < n; i++) m.set(i, i);
        m.forEach = touchy; m.values = touchy; m.entries = touchy; m[Symbol.iterator] = touchy;
        return m;
    };
    let c;
    try {
        c = projectCounts([
            { frameGroups: map(10), instanceGroups: map(40), lazyLoader: { nFrames: 1000 } },
            { frameGroups: map(5), instanceGroups: map(7), lazyLoader: null },
            null,
        ]);
    } catch (e) { c = String(e); }
    check(J(c) === J({ sessions: 2, resident: 15, frames: 1005, groupFrames: 47, lazy: true }),
        `sums sizes without walking a Map (${J(c)})`);
    check(J(projectCounts([])) === J({ sessions: 0, resident: 0, frames: 0, groupFrames: 0, lazy: false }), 'no sessions');
    check(J(projectCounts(undefined)).includes('"sessions":0'), 'undefined sessions');
}

// ---- §6 formatMB ----
{
    check(formatMB(5734 * 1048576) === '5,734 MB', 'grouped, en-US');
    check(formatMB(0) === '0 MB' && formatMB(NaN) === '–' && formatMB(undefined) === '–', 'zero and unknown');
}

// ---- §7 plot geometry ----
{
    const MB = 1048576;
    const now = 1000000;
    const s = (dt, used, ua = NaN) => ({ t: now - dt, used, ua });
    // Three samples a second apart, a gap, then two more; one sample older than the window.
    const samples = [
        s(MEMORY_WINDOW_MS + 5000, 9000 * MB),
        s(10000, 100 * MB), s(9000, 200 * MB), s(8000, 300 * MB),
        s(1000, 400 * MB), s(0, 500 * MB),
    ];
    const g = plotGeometry(samples, { width: 300, height: 100, now, limit: 4000 * MB });
    check(g.peak === 500 * MB, 'the peak is of the window only (the 9,000 MB sample is older)');
    check(g.yMax === 4000 * MB && Math.abs(g.limitY - 0) < 1e-9, 'below the limit the scale tops out at the limit, drawn at the top');
    const moves = (g.usedPath.match(/M/g) || []).length, lines = (g.usedPath.match(/L/g) || []).length;
    check(moves === 2 && lines === 3, `a step longer than ${MEMORY_GAP_MS} ms breaks the line (M ${moves}, L ${lines})`);
    check(/L300\.0 [\d.]+$/.test(g.usedPath), 'the newest sample sits at the right edge');
    check(g.uaPath === '', 'no whole-page readings → no second line');

    const over = plotGeometry([s(1000, 6000 * MB), s(0, 5000 * MB, 7000 * MB)], { width: 100, height: 100, now, limit: 4000 * MB });
    check(Math.abs(over.yMax - 7700 * MB) < 1 && over.limitY > 0 && over.peak === 6000 * MB,
        'a reading above the limit raises the scale (typed arrays count); the limit line moves down');
    check(over.uaPath.startsWith('M') && !over.uaPath.includes('L'), 'a lone whole-page reading starts its own line');

    const nanUsed = plotGeometry([s(2000, NaN), s(1000, 10 * MB), s(0, NaN)], { width: 100, height: 100, now, limit: NaN });
    check(nanUsed.limitY === null && Number.isFinite(nanUsed.yMax) && nanUsed.yMax > 0, 'no limit → no limit line, still a finite scale');
    check(!/NaN/.test(nanUsed.usedPath), 'unknown samples are skipped, never drawn as NaN');
    const empty = plotGeometry([], { width: 100, height: 100, now, limit: NaN });
    check(empty.usedPath === '' && empty.yMax === 1 && empty.peak === 0, 'no samples: empty paths, a usable scale');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
