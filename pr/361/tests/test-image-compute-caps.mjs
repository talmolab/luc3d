/**
 * test-image-compute-caps.mjs — the image ID-switch check's two compute caps
 * (ui/image-embedder.js; settings `imageCheckMaxGpu`, `imageCheckMaxCpu`, both 50%
 * by default). The share of the GPU and of the CPU the check may take is the
 * user's to set, and held even when nothing else wants the rest:
 *  - GPU: smaller batches (`gpuMaxBatch`) and a rest after each run
 *    (`paceRestMs`), so busy / (busy + rest) = the cap, taken in short slices;
 *  - CPU: fewer worker threads (`imageCheckThreads`), all kept working.
 * The queue that applies the GPU cap (`createModelQueue`) is driven here with a
 * fake model, since headless runs have no GPU. The CPU cap on the real model:
 * tests/e2e/image-check-cpu.mjs §6.
 *
 * Run:  node tests/test-image-compute-caps.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ui = (f) => pathToFileURL(path.join(HERE, '..', 'ui', f)).href;
globalThis.window = globalThis;
const E = await import(ui('image-embedder.js'));
const { capPct, paceRestMs, gpuMaxBatch, imageCheckThreads, createModelQueue, cpuModelWorkerCount,
        IMAGE_CAP_MIN, EMBED_MAX_BATCH, formatEmbedTiming } = E;
const { getTrackingThresholdDefs } = await import(ui('settings.js'));
const { IMAGE_CHECK_IDS } = await import(ui('track-setup-modal.js'));

let passed = 0, failed = 0; const failures = [];
function ok(c, m) {
    if (c) passed++;
    else { failed++; failures.push(m); console.error('  ✗ ' + m); }
}
const near = (a, e) => Math.abs(a - e) < 1e-9;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- a cap is a percentage in 10..100; anything unusable is 100, uncapped ----
ok(IMAGE_CAP_MIN === 10, 'the lowest cap is 10%');
ok(capPct(50) === 50 && capPct(1) === 10 && capPct(150) === 100, 'caps are held to 10..100 (50, 1 -> 10, 150 -> 100)');
for (const v of [0, -5, NaN, undefined, null, 'x']) ok(capPct(v) === 100, `a cap of ${String(v)} is 100 (uncapped)`);

// ---- GPU, part 1: the batch shrinks with the cap ----------------------------
ok(gpuMaxBatch(100) === EMBED_MAX_BATCH, `100%: batches of ${gpuMaxBatch(100)} = EMBED_MAX_BATCH (uncapped)`);
ok(gpuMaxBatch(50) === 32 && gpuMaxBatch(25) === 16 && gpuMaxBatch(10) === 6, `50/25/10% -> batches of ${gpuMaxBatch(50)}/${gpuMaxBatch(25)}/${gpuMaxBatch(10)}`);
ok(gpuMaxBatch(undefined) === EMBED_MAX_BATCH, 'no cap -> the full batch');

// ---- GPU, part 2: busy / (busy + rest) = the cap -----------------------------
for (const pct of [10, 25, 50, 75, 90]) {
    const run = 120, rest = paceRestMs(run, pct);
    ok(near(100 * run / (run + rest), pct), `${pct}%: a ${run} ms run rests ${rest.toFixed(1)} ms (busy ${(100 * run / (run + rest)).toFixed(3)}%)`);
}
ok(paceRestMs(100, 100) === 0 && paceRestMs(100, undefined) === 0, '100% / no cap rests 0 ms');
ok(paceRestMs(0, 50) === 0 && paceRestMs(NaN, 50) === 0, 'a zero / NaN run rests 0 ms');
ok(near(paceRestMs(100, 1), 900), 'below 10% holds at 10% (a 9x rest)');

// ---- CPU: fewer threads, never more than uncapped --------------------------
{
    const up = imageCheckThreads(10, 8, 100, false), uc = imageCheckThreads(10, 8, 100, true);
    ok(up.model === 0 && up.crop === 8, `100%, GPU path, 10 cores: 8 crop workers, as before (${JSON.stringify(up)})`);
    ok(uc.model === cpuModelWorkerCount(10, 8) && uc.crop === 8, `100%, CPU path: cpuModelWorkerCount's ${uc.model} model workers + 8 crop, as before`);
    const g = imageCheckThreads(10, 8, 50, false), c = imageCheckThreads(10, 8, 50, true);
    ok(g.budget === 5 && g.model === 0 && g.crop === 5, `50%, GPU path, 10 cores: 5 crop workers (${JSON.stringify(g)})`);
    ok(c.budget === 5 && c.model === 4 && c.crop === 1, `50%, CPU path, 10 cores: 4 model + 1 crop = 5 threads (${JSON.stringify(c)})`);
    const c16 = imageCheckThreads(16, 8, 25, true);
    ok(c16.model + c16.crop === 4 && c16.model === 3, `25%, CPU path, 16 cores: 4 threads, 3 for the model (${JSON.stringify(c16)})`);
    const small = imageCheckThreads(2, 4, 10, true);
    ok(small.model === 1 && small.crop === 1, `10% of 2 cores still runs one model and one crop worker (${JSON.stringify(small)})`);
    const mem = imageCheckThreads(32, 4, 100, true);
    ok(mem.model === cpuModelWorkerCount(32, 4) && mem.model <= 2, `memory still bounds the model workers (4 GB -> ${mem.model})`);
    let never = true;
    for (const cores of [2, 4, 8, 12, 16, 24]) for (const pct of [10, 25, 50, 75, 100]) for (const onCpu of [false, true]) {
        const t = imageCheckThreads(cores, 8, pct, onCpu), u = imageCheckThreads(cores, 8, 100, onCpu);
        if (t.model > u.model || t.crop > u.crop) never = false;
    }
    ok(never, 'a cap never runs MORE threads than uncapped, for any core count');
}

// ---- the queue: batches at most maxBatch, and a rest equal to the run at 50% ----
const fakeModel = (ms, log) => async (data, n) => { log.push(n); await sleep(ms); return Array.from({ length: n }, (_, i) => new Float32Array([data[i * 2]])); };
const crops = (k, tag) => Array.from({ length: k }, (_, i) => new Float32Array([tag * 1000 + i, 0]));
const newTm = () => ({ queueMs: 0, batches: 0, maxBatch: 0, restMs: 0 });
{
    const log = [], tm = newTm();
    const q = createModelQueue(fakeModel(40, log), 2, tm, { maxBatch: 8, maxGpuPct: 50 });
    const t0 = performance.now();
    const outs = await Promise.all([q.enqueue(crops(5, 1)), q.enqueue(crops(5, 2)), q.enqueue(crops(20, 3))]);
    const wall = performance.now() - t0;
    ok(log.every(n => n <= 8), `no run took more than maxBatch = 8 crops (${log.join(', ')})`);
    ok(outs[2].length === 20 && outs[2].every((v, i) => v[0] === 3000 + i), 'a frame larger than a batch is split across runs and comes back whole, in order');
    ok(outs[0].every((v, i) => v[0] === 1000 + i) && outs[1].every((v, i) => v[0] === 2000 + i), 'every frame gets its own crops back, in order');
    await sleep(80);   // the last rest
    const busy = log.length * 40;
    ok(tm.restMs >= 0.9 * busy && tm.restMs <= 1.6 * busy, `at 50% the queue rested as long as it ran: ${Math.round(tm.restMs)} ms resting, ~${busy} ms running`);
    ok(wall >= 1.8 * (busy - 40), `…so the work took about twice its run time (${Math.round(wall)} ms for ~${busy} ms of runs)`);
}
{
    const log = [], tm = newTm();
    const q = createModelQueue(fakeModel(30, log), 2, tm, { maxBatch: EMBED_MAX_BATCH, maxGpuPct: 100 });
    await Promise.all([q.enqueue(crops(5, 1)), q.enqueue(crops(5, 2)), q.enqueue(crops(5, 3))]);
    await sleep(60);
    ok(tm.restMs === 0, 'at 100% the queue never rests');
    ok(log.length === 2 && log[0] === 5 && log[1] === 10, `…and batches what queued while a run was going, as before (${log.join(', ')})`);
}
{
    const log = [], tm = newTm();
    const q = createModelQueue(fakeModel(50, log), 2, tm, { maxBatch: 8, maxGpuPct: 10 });
    await q.enqueue(crops(4, 1));                       // runs, then a 9x rest (~450 ms)
    const queued = q.enqueue(crops(4, 2));
    await sleep(20);
    const t0 = performance.now();
    q.endRest();
    await queued;
    const settled = performance.now() - t0;
    ok(settled < 200, `endRest ends a rest at once: work queued behind it finished ${Math.round(settled)} ms later (the rest was ~450 ms)`);
}

// ---- the settings: two caps, both 50% by default ----------------------------
const defs = getTrackingThresholdDefs();
for (const id of ['imageCheckMaxGpu', 'imageCheckMaxCpu']) {
    const d = defs.find(x => x.id === id);
    ok(!!d && d.default === 50 && d.value === 50 && d.min === IMAGE_CAP_MIN && d.max === 100, `${id}: default 50%, range 10..100`);
    ok(IMAGE_CHECK_IDS.includes(id), `${id} is offered in the Track All / Track Frame Range dialogs`);
}

// ---- the run summary says what was capped ------------------------------------
const t = { crops: 90, cropsPerS: 9, seconds: 10, gpuBusyPct: 50, batches: 5, avgBatch: 18, modelMsPerCrop: 80,
    decodeMsPerFrame: 1, cropMsPerFrame: 40, queueMsPerFrame: 900, backend: 'webgpu', dtype: 'fp16' };
const both = formatEmbedTiming(Object.assign({}, t, { maxGpuPct: 50, batchLimit: 32, restS: 4.6, maxCpuPct: 50, threads: 5 }));
ok(/ · GPU capped at 50% \(batches of ≤32, 5 s resting\) · CPU capped at 50% \(5 worker threads\)$/.test(both), `both caps in the summary: "${both.slice(both.indexOf(' · GPU'))}"`);
const cpuRun = formatEmbedTiming(Object.assign({}, t, { backend: 'cpu', workers: 4, maxGpuPct: null, maxCpuPct: 50, threads: 5 }));
ok(!/GPU capped/.test(cpuRun) && / · CPU capped at 50% \(5 worker threads\)$/.test(cpuRun), 'on the CPU path only the CPU cap is reported');
ok(!/capped/.test(formatEmbedTiming(Object.assign({}, t, { maxGpuPct: 100, maxCpuPct: 100, threads: 8 }))), 'an uncapped run says nothing about caps');

console.log(`\ntest-image-compute-caps: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
