/**
 * test-memory-plot.mjs — the DOM-free half of the Memory panel
 * (`ui/memory-plot.js`): the sample ring, reading Chrome's
 * `performance.memory` (and telling its rounded 20-minute reading from a live
 * one), summing `measureUserAgentSpecificMemory()`, the project counters, and
 * the plot's geometry. The panel itself is covered by e2e `memory-panel.mjs`.
 */
import {
    MemoryRing, isBucketizedHeap, readHeap, summarizeUaMemory, projectCounts, formatMB, plotGeometry,
    runName, formatDuration, runSpans, placeRunLabels,
    MEMORY_GAP_MS, MEMORY_WINDOW_MS, MEMORY_SAMPLE_MS,
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

// ---- §8 naming a run from the progress card ----
{
    check(runName(null) === null, 'no card → no run');
    check(runName({ title: 'Track All', message: 'Assigning identities: 5/10 frames…' }) === 'Track All', 'the title names it');
    check(runName({ title: '', message: 'Loading SLP files (3/8)...' }) === 'Loading SLP files', 'untitled: the message up to its count');
    check(runName({ title: '', message: 'Assigning identities: 5/10 frames…' }) === 'Assigning identities', 'untitled: the message up to its colon');
    check(runName({ title: '  ', message: '…' }) === 'Working', 'nothing to go by → "Working"');
    check(runName({ title: 'x'.repeat(60), message: '' }).length === 40, 'a long name is cut to 40 characters');
}

// ---- §9 formatDuration ----
{
    check(formatDuration(45400) === '45 s' && formatDuration(125000) === '2 min 5 s' && formatDuration(120000) === '2 min',
        'seconds, minutes and seconds');
    check(formatDuration(3780000) === '1 h 3 min' && formatDuration(0) === '0 s', 'hours, and zero');
}

// ---- §10 runs as spans ----
{
    const MB = 1048576;
    const now = 1000000;
    const s = (dt, used, run) => ({ t: now - dt, used, ua: NaN, run: run || null });
    const samples = [
        s(MEMORY_WINDOW_MS + 2000, 1 * MB, 'Old'),       // before the window: left out
        s(30000, 10 * MB), s(29000, 20 * MB, 'Load'), s(28000, 50 * MB, 'Load'), s(27000, 30 * MB, 'Load'),
        s(26000, 40 * MB, 'Track All'), s(25000, 90 * MB, 'Track All'),
        // a gap longer than MEMORY_GAP_MS inside one name: two spans
        s(18000, 60 * MB, 'Track All'), s(17000, 70 * MB, 'Track All'),
        s(16000, 5 * MB), s(0, 5 * MB, 'Save'),
    ];
    const sp = runSpans(samples, { width: 300, now, windowMs: MEMORY_WINDOW_MS });
    const J2 = x => JSON.stringify(x);
    check(J2(sp.map(r => r.name)) === J2(['Load', 'Track All', 'Track All', 'Save']),
        `one span per stretch of a name, split by another name, none, or a gap (${J2(sp.map(r => r.name))})`);
    check(sp[0].peak === 50 * MB && sp[1].peak === 90 * MB && sp[2].peak === 70 * MB, 'each span keeps its own peak');
    check(sp[0].ms === 3 * MEMORY_SAMPLE_MS && sp[0].x1 > sp[0].x0, 'a span covers its samples plus one period');
    const last = sp[3];
    check(last.x1 <= 300 && last.x1 - last.x0 >= 1 && last.ms === 0, 'a run on the newest sample is a 1-unit band at the right edge, never past it');
    check(sp.every((r, i) => i === 0 || r.x0 >= sp[i - 1].x1 - 1e-9), 'spans never overlap');
    check(runSpans([], { width: 300, now }).length === 0, 'no samples → no spans');
}

// ---- §11 run names never overlap ----
{
    const span = (name, x0, x1, ms) => ({ name, x0, x1, ms: ms == null ? (x1 - x0) * 1000 : ms });
    const W = 260, cw = 6;
    const ends = (p) => p.align === 'left' ? [p.x, p.x + p.max] : [p.x - p.max, p.x];
    const [a] = placeRunLabels([span('Track All', 20, 40)], W, cw);
    check(a.align === 'left' && a.x === 20 && !a.hidden, 'room to the right: starts at its band');
    const [b] = placeRunLabels([span('Track All', 240, 255)], W, cw);
    check(b.align === 'right' && b.x === 255 && !b.hidden, 'at the right edge: ends at its band instead');
    const two = placeRunLabels([span('Load', 100, 140), span('Track All', 142, 200)], W, cw);
    check(two[0].align === 'left' && two[0].max <= 42 && two[1].align === 'left', 'two neighbours each fit');
    const tight = placeRunLabels([span('Triangulate All', 100, 104), span('Save', 106, 110), span('Track All', 112, 116)], W, cw);
    check(!tight[2].hidden && tight.filter(p => p.hidden).length >= 1,
        'crowded: the newest name always shows, one with no room left is hidden (its band\'s tooltip still names it)');
    const edge = placeRunLabels([span('Loading SLP files', 240, 243), span('Track All', 250, 253)], W, cw);
    check(!edge[1].hidden && edge[1].align === 'right' && edge[1].x === 253 && edge[0].hidden,
        'the run that just ended, at the right edge, keeps its name, ending at its band');
    // Track All then Triangulate All, back to back at the right edge (05mice): one row holds one name, two rows both.
    const seq = [span('Track All', 200, 222), span('Checking ID switches', 222, 223), span('Triangulate All', 228, 252)];
    const one = placeRunLabels(seq, W, cw, 1), lanes2 = placeRunLabels(seq, W, cw, 2);
    check(one[0].hidden && !one[2].hidden, 'in one row only the newest of three close runs is named');
    check(!lanes2[2].hidden && lanes2[2].lane === 0 && !lanes2[0].hidden && lanes2[0].lane === 1 && lanes2[0].max >= 'Track All'.length * cw,
        'two rows: the newest takes the first, the next one whole in the second');
    const rows = [0, 1].map(k => lanes2.map((p, i) => (!p.hidden && p.lane === k) ? ends(p, seq[i]) : null).filter(Boolean));
    check(rows.every(r => r.every((e, i) => i === 0 || e[0] >= r[i - 1][1] - 1e-9)), 'names in the same row never overlap');
    for (const sps of [
        [span('Load', 10, 30), span('Track All', 60, 90), span('Save', 250, 256)],
        [span('Opening the demo', 10, 12), span('Track All', 30, 34), span('Triangulate All', 36, 120), span('Save', 200, 259)],
        [span('Load', 0, 1), span('Track All', 2, 3), span('Save', 4, 5), span('Triangulate All', 255, 260)],
    ]) {
        const pl = placeRunLabels(sps, W, cw).map((p, i) => p.hidden ? null : ends(p, sps[i])).filter(Boolean);
        check(pl.every((r, i) => i === 0 || r[0] >= pl[i - 1][1] - 1e-9) && pl.every(r => r[0] >= -1e-9 && r[1] <= W + 1e-9),
            `the room each shown name may take never overlaps the next one's, and stays inside the plot (${sps.map(s => s.name).join(', ')})`);
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
