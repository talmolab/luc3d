/**
 * test-image-compute-caps.mjs — the image ID-switch check's two compute caps
 * (ui/image-embedder.js; settings `imageCheckGpuTimePct`, `imageCheckCpuTimePct`:
 * whole percentages 1-100, both 80 by default). The share of the GPU's and of the CPU's time the check may
 * take is the user's to set, and held even when nothing else wants the rest. Both are a duty cycle
 * (`paceRestMs`): busy / (busy + idle) = the cap.
 *  - GPU: full batches and an idle after each run (`createModelQueue`);
 *  - CPU: every crop worker idles after each job (`createCropPool`), and on the CPU
 *    path the model workers after each (smaller) batch (`createModelQueue` again).
 * The queue and the pool are driven here with a fake model and a fake Worker, since
 * Node has neither a GPU nor workers. The CPU cap on the real model:
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
const { capPct, paceRestMs, createModelQueue, createCropPool, CPU_CAP_CROPS_PER_WORKER,
        IMAGE_CAP_MIN, EMBED_MAX_BATCH, formatEmbedTiming } = E;
const { getTrackingThresholdDefs, formatThresholdValue } = await import(ui('settings.js'));
const { IMAGE_CHECK_IDS } = await import(ui('track-setup-modal.js'));

let passed = 0, failed = 0; const failures = [];
function ok(c, m) {
    if (c) passed++;
    else { failed++; failures.push(m); console.error('  ✗ ' + m); }
}
const near = (a, e) => Math.abs(a - e) < 1e-9;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- a cap is a percentage in 10..100; anything unusable is 100, uncapped ----
ok(IMAGE_CAP_MIN === 1, 'the lowest cap is 1%');
ok(capPct(50) === 50 && capPct(1) === 1 && capPct(0.4) === 1 && capPct(150) === 100, 'caps are held to 1..100 (50, 1, 0.4 -> 1, 150 -> 100)');
for (const v of [0, -5, NaN, undefined, null, 'x']) ok(capPct(v) === 100, `a cap of ${String(v)} is 100 (uncapped)`);

// ---- GPU, part 1: the batch shrinks with the cap ----------------------------
ok(!('gpuMaxBatch' in E), 'batches no longer shrink with the GPU cap (no gpuMaxBatch): only the idle time follows it');
{
    // the embedder hands the queue full batches whatever the cap (source check: there is no GPU here to run it on)
    const src = (await import('node:fs')).readFileSync(path.join(HERE, '..', 'ui', 'image-embedder.js'), 'utf8');
    ok(/: \{ maxBatch: EMBED_MAX_BATCH, maxPct: maxGpuPct \}\);/.test(src),
        'createImageEmbedder gives the queue EMBED_MAX_BATCH on the GPU path, paced by the GPU cap');
    ok(/\? \{ maxBatch: maxCpuPct < 100 \? Math\.min\(EMBED_MAX_BATCH, CPU_CAP_CROPS_PER_WORKER \* cpuWorkers\) : EMBED_MAX_BATCH, maxPct: maxCpuPct \}/.test(src),
        'on the CPU path the queue is paced by the CPU cap, in batches of CPU_CAP_CROPS_PER_WORKER a worker while capped');
    ok(/createCropPool\(cpuClock, maxCpuPct\)/.test(src), 'the crop pool is paced by the CPU cap');
    ok(CPU_CAP_CROPS_PER_WORKER === 4, 'a capped CPU model worker takes 4 crops a run');
}
ok(!('imageCheckThreads' in E), 'the thread-count cap is gone (imageCheckThreads)');

// ---- GPU, part 2: busy / (busy + rest) = the cap -----------------------------
for (const pct of [10, 25, 50, 75, 90]) {
    const run = 120, rest = paceRestMs(run, pct);
    ok(near(100 * run / (run + rest), pct), `${pct}%: a ${run} ms run rests ${rest.toFixed(1)} ms (busy ${(100 * run / (run + rest)).toFixed(3)}%)`);
}
ok(paceRestMs(100, 100) === 0 && paceRestMs(100, undefined) === 0, '100% / no cap rests 0 ms');
ok(paceRestMs(0, 50) === 0 && paceRestMs(NaN, 50) === 0, 'a zero / NaN run rests 0 ms');
ok(near(paceRestMs(100, 1), 9900), '1%: a 99x idle');
ok(near(paceRestMs(100, 0.5), 9900), 'below 1% holds at 1%');

// ---- CPU: each crop worker idles after each job --------------------------------
// A fake crop worker: answers each job after JOB_MS, and records how many jobs it held at once
// and when each ran, so the pool's pacing can be read back per worker.
const JOB_MS = 40;
const fakeWorkers = [];
globalThis.Worker = class {
    constructor() { this.held = 0; this.maxHeld = 0; this.runs = []; this.dead = false; fakeWorkers.push(this); }
    postMessage(m) {
        this.held++; this.maxHeld = Math.max(this.maxHeld, this.held);
        const from = performance.now();
        setTimeout(() => {
            if (this.dead) return;
            this.held--; this.runs.push([from, performance.now()]);
            this.onmessage({ data: { id: m.id, tensors: m.crops.map(c => new Float32Array([c])) } });
        }, JOB_MS);
    }
    terminate() { this.dead = true; }
};
const cropRun = async (pct, workers, jobs) => {
    fakeWorkers.length = 0;
    window.LUCID_CROP_WORKERS = workers;
    const pool = createCropPool(null, pct);
    const t0 = performance.now();
    const outs = await Promise.all(Array.from({ length: jobs }, (_, j) => pool.run({ close() {} }, [j])));
    const wall = performance.now() - t0;
    pool.terminate();
    return { outs, wall, ws: fakeWorkers.slice() };
};
{
    const u = await cropRun(100, 2, 8);
    ok(u.outs.every((o, j) => o.length === 1 && o[0][0] === j), 'every crop job comes back with its own tensors');
    ok(u.ws.every(w => w.maxHeld === 1), 'a worker holds one job at a time (the queue is the pool\'s)');
    ok(u.ws.every(w => w.runs.length === 4), `the jobs are shared out over the workers (${u.ws.map(w => w.runs.length).join(', ')})`);
    ok(u.wall < 4 * JOB_MS * 1.6, `at 100% no worker idles: 8 jobs on 2 workers took ${Math.round(u.wall)} ms (~${4 * JOB_MS} ms of work each)`);
    const h = await cropRun(50, 2, 8);
    // each worker: 4 runs and the 3 idles between them, each as long as a run
    let duty = true;
    h.ws.forEach(w => {
        for (let i = 1; i < w.runs.length; i++) {
            const run = w.runs[i - 1][1] - w.runs[i - 1][0], idle = w.runs[i][0] - w.runs[i - 1][1];
            if (idle < 0.8 * run || idle > 2 * run) duty = false;
        }
    });
    ok(duty, 'at 50% each worker idles about as long as its last job ran, before the next');
    ok(h.wall >= 7 * JOB_MS * 0.9, `…so the same jobs took about twice as long: ${Math.round(h.wall)} ms vs ${Math.round(u.wall)} ms`);
    ok(h.ws.length === u.ws.length, 'and the cap runs as many workers as uncapped: every thread works part of the time');
}
{
    // terminate: queued jobs are rejected (their images closed), an idling worker never picks one up again
    fakeWorkers.length = 0;
    window.LUCID_CROP_WORKERS = 1;
    const pool = createCropPool(null, 10);              // a 9x idle after each job
    let closed = 0;
    const img = () => ({ close() { closed++; } });
    const first = pool.run(img(), [0]), queued = pool.run(img(), [1]);
    await first;                                        // the worker is idling now, with one job queued
    pool.terminate();
    let rejected = false;
    await queued.catch(() => { rejected = true; });
    ok(rejected && closed === 1, 'terminate rejects a job still queued and closes its image');
    await sleep(JOB_MS * 2);
    ok(fakeWorkers[0].runs.length === 1, 'a terminated pool starts nothing once its worker\'s idle ends');
    let late = false;
    await pool.run(img(), [2]).catch(() => { late = true; });
    ok(late, 'a terminated pool rejects new jobs');
}
{
    // a worker that fails: its job is rejected, the pool is `broken`, the others finish the queue
    fakeWorkers.length = 0;
    window.LUCID_CROP_WORKERS = 2;
    const pool = createCropPool(null, 100);
    const jobs = Array.from({ length: 4 }, (_, j) => pool.run({ close() {} }, [j]).then(() => 'ok', () => 'failed'));
    fakeWorkers[0].dead = true;
    fakeWorkers[0].onerror({ preventDefault() {}, message: 'boom' });
    const res = await Promise.all(jobs);
    ok(pool.broken && res.filter(r => r === 'failed').length === 1 && res.filter(r => r === 'ok').length === 3,
        `a failed worker rejects only its own job; the other worker finishes the queue (${res.join(', ')})`);
    pool.terminate();
}
delete globalThis.Worker;
delete window.LUCID_CROP_WORKERS;

// ---- the queue: batches at most maxBatch, and a rest equal to the run at 50% ----
const fakeModel = (ms, log) => async (data, n) => { log.push(n); await sleep(ms); return Array.from({ length: n }, (_, i) => new Float32Array([data[i * 2]])); };
const crops = (k, tag) => Array.from({ length: k }, (_, i) => new Float32Array([tag * 1000 + i, 0]));
const newTm = () => ({ queueMs: 0, batches: 0, maxBatch: 0, restMs: 0 });
{
    const log = [], tm = newTm();
    const q = createModelQueue(fakeModel(40, log), 2, tm, { maxBatch: 8, maxPct: 50 });
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
    const q = createModelQueue(fakeModel(30, log), 2, tm, { maxBatch: EMBED_MAX_BATCH, maxPct: 100 });
    await Promise.all([q.enqueue(crops(5, 1)), q.enqueue(crops(5, 2)), q.enqueue(crops(5, 3))]);
    await sleep(60);
    ok(tm.restMs === 0, 'at 100% the queue never rests');
    ok(log.length === 2 && log[0] === 5 && log[1] === 10, `…and batches what queued while a run was going, as before (${log.join(', ')})`);
}
{
    const log = [], tm = newTm();
    const q = createModelQueue(fakeModel(50, log), 2, tm, { maxBatch: 8, maxPct: 10 });
    await q.enqueue(crops(4, 1));                       // runs, then a 9x rest (~450 ms)
    const queued = q.enqueue(crops(4, 2));
    await sleep(20);
    const t0 = performance.now();
    q.endRest();
    await queued;
    const settled = performance.now() - t0;
    ok(settled < 200, `endRest ends a rest at once: work queued behind it finished ${Math.round(settled)} ms later (the rest was ~450 ms)`);
}

// ---- the settings: two caps as whole percentages 1-100, both 80 by default ----
const defs = getTrackingThresholdDefs();
for (const [id, label, tip] of [['imageCheckGpuTimePct', 'Image check: GPU time (%)', 'Fraction of GPU time to run image check, idling the remaining time.'],
                                ['imageCheckCpuTimePct', 'Image check: CPU time (%)', 'Fraction of CPU time to run image check, idling the remaining time.']]) {
    const d = defs.find(x => x.id === id);
    ok(!!d && d.label === label, `${id} is labelled "${d && d.label}"`);
    ok(!!d && d.tip === tip, `${id}'s tip: "${d && d.tip}"`);
    ok(!!d && !('note' in d), `${id} has no per-machine note (a duty cycle means the same on every machine)`);
    ok(!!d && d.default === 80 && d.value === 80 && d.min === IMAGE_CAP_MIN && d.max === 100 && d.step === 1 && !d.decimals,
        `${id}: default 80, whole numbers 1..100`);
    ok(!!d && formatThresholdValue(d, d.value) === '80' && formatThresholdValue(d, 100) === '100', `${id} reads "80" (and "100") in its field`);
    ok(IMAGE_CHECK_IDS.includes(id), `${id} is offered in the Track All / Track Frame Range dialogs`);
}
ok(!defs.some(d => ['imageCheckMaxGpu', 'imageCheckMaxCpu', 'imageCheckGpuTime', 'imageCheckCpuCores', 'imageCheckCpuCoresPct'].includes(d.id)),
    'the earlier ids are gone (a stored 0.5 cannot be read as 1%, nor a share of the cores as a share of the time)');
ok(formatThresholdValue(defs.find(d => d.id === 'imageCheckHz'), 2) === '2', 'a setting without `decimals` is shown as before');

// ---- the run summary says what was capped ------------------------------------
const t = { crops: 90, cropsPerS: 9, seconds: 10, gpuBusyPct: 50, batches: 5, avgBatch: 18, modelMsPerCrop: 80,
    decodeMsPerFrame: 1, cropMsPerFrame: 40, queueMsPerFrame: 900, backend: 'webgpu', dtype: 'fp16' };
const both = formatEmbedTiming(Object.assign({}, t, { maxGpuPct: 50, restS: 4.6, maxCpuPct: 50 }));
ok(/ · GPU time capped at 50% \(5 s idle\) · CPU time capped at 50%$/.test(both), `both caps in the summary: "${both.slice(both.indexOf(' · GPU'))}"`);
const cpuRun = formatEmbedTiming(Object.assign({}, t, { backend: 'cpu', workers: 4, maxGpuPct: null, maxCpuPct: 50 }));
ok(!/GPU time capped/.test(cpuRun) && / · CPU time capped at 50%$/.test(cpuRun), 'on the CPU path only the CPU cap is reported');
ok(!/capped/.test(formatEmbedTiming(Object.assign({}, t, { maxGpuPct: 100, maxCpuPct: 100 }))), 'an uncapped run says nothing about caps');

console.log(`\ntest-image-compute-caps: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
