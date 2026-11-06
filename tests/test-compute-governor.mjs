/**
 * test-compute-governor.mjs — pose/compute-governor.js (the worker count that
 * follows the OS's CPU pressure, deadlines, abortable waits, the heap stop) and
 * the guardrails it gives the pools:
 *   - pose/triangulation-pool.js: a worker that dies, or stops answering, has
 *     ITS batch re-solved inline and the run still finishes (the old error
 *     handler re-solved every batch in flight and left the other workers
 *     marked busy for good — once all were, finish() waited forever);
 *   - pose/tracker-pool.js: a worker that stops answering fails the run
 *     instead of leaving it waiting.
 * Node, fake workers; ESM, so `tests/run-mjs-tests.mjs` picks it up.
 */
import { nextConcurrency, createComputeGovernor, withTimeout, abortable, heapNearLimit, timeoutError,
    workerReplyTimeoutMs, WORKER_REPLY_TIMEOUT_MS } from '../pose/compute-governor.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p.then(() => 'done', (e) => 'rejected: ' + (e && e.message)), sleep(ms).then(() => 'HUNG')]);

console.log('§1 nextConcurrency (AIMD on the pressure state)');
const L = { floor: 1, ceiling: 9 };
check(nextConcurrency(5, 'nominal', L) === 6, 'nominal: +1');
check(nextConcurrency(9, 'nominal', L) === 9, 'nominal: capped at the ceiling');
check(nextConcurrency(5, 'fair', L) === 5, 'fair: hold');
check(nextConcurrency(5, 'serious', L) === 5, 'serious: hold (stalls came only with critical)');
check(nextConcurrency(8, 'critical', L) === 4, 'critical: halve');
check(nextConcurrency(1, 'critical', L) === 1, 'never below the floor');
check(nextConcurrency(5, null, L) === 5 && nextConcurrency(5, 'bogus', L) === 5, 'no reading: hold');
check(nextConcurrency(3, 'critical', { floor: 3, ceiling: 3 }) === 3, 'floor = ceiling: fixed');

console.log('§2 createComputeGovernor with an injected PressureObserver and timers');
{
    let cb = null, ticks = [], observed = null, disconnected = false, cleared = false;
    class FakeObserver { constructor(f) { cb = f; } observe(src, o) { observed = [src, o]; return Promise.resolve(); } disconnect() { disconnected = true; } }
    const g = createComputeGovernor({ ceiling: 9, start: 5, Observer: FakeObserver,
        setInterval: (f) => { ticks.push(f); return 1; }, clearInterval: () => { cleared = true; } });
    check(g.adaptive && g.allowed() === 5, 'starts at `start`, adaptive');
    check(observed && observed[0] === 'cpu', "observes the 'cpu' source");
    const tick = () => ticks[0]();
    tick();
    check(g.allowed() === 5, 'no reading yet: holds');
    cb([{ state: 'nominal' }]); tick(); tick();
    check(g.allowed() === 7, 'nominal for 2 steps: 7');
    cb([{ state: 'critical' }]); tick();
    check(g.allowed() === 3, 'critical: halved to 3');
    cb([{ state: 'fair' }]); tick(); tick();
    check(g.allowed() === 3, 'fair: holds');
    const s = g.summary();
    check(s.lowest === 3 && s.highest === 7 && s.seconds.critical === 1 && s.seconds.nominal === 2, 'summary: range and seconds per state');
    g.close();
    check(disconnected && cleared, 'close disconnects and stops the timer');
}
{
    const g = createComputeGovernor({ ceiling: 4, start: 2, Observer: null });
    check(!g.adaptive && g.allowed() === 2, 'no PressureObserver: fixed at `start`');
    g.close();
    class Throws { constructor() { throw new Error('policy'); } }
    const g2 = createComputeGovernor({ ceiling: 4, start: 4, Observer: Throws });
    check(!g2.adaptive && g2.allowed() === 4, 'an observer that cannot start: fixed');
    g2.close();
    class Rejects { constructor() {} observe() { return Promise.reject(new Error('NotAllowedError')); } disconnect() {} }
    const g3 = createComputeGovernor({ ceiling: 4, start: 3, Observer: Rejects, setInterval: () => 1, clearInterval: () => {} });
    await sleep(0);
    check(g3.allowed() === 3, 'observe() rejecting: holds at start');
    g3.close();
}

console.log('§3 withTimeout / abortable / heapNearLimit');
{
    let fired = false;
    const r = await within(withTimeout(new Promise(() => {}), 20, 'a worker', () => { fired = true; }), 500);
    check(r === 'rejected: a worker did not answer within 0 s' && fired, 'a promise that never settles: TimeoutError, onTimeout ran');
    const e = await withTimeout(new Promise(() => {}), 10, 'x').catch((x) => x);
    check(e.name === 'TimeoutError', "name 'TimeoutError'");
    check(await withTimeout(Promise.resolve(7), 1000, 'x') === 7, 'settles in time: the value');
    const p = Promise.resolve(1);
    check(withTimeout(p, 0, 'x') === p, 'ms <= 0: no deadline');
    check(timeoutError('w', 120000).message === 'w did not answer within 120 s', 'message');
    check(workerReplyTimeoutMs() === WORKER_REPLY_TIMEOUT_MS, 'default deadline');
    globalThis.LUCID_WORKER_REPLY_TIMEOUT_MS = 50;
    check(workerReplyTimeoutMs() === 50, 'override via globalThis');
    delete globalThis.LUCID_WORKER_REPLY_TIMEOUT_MS;
}
{
    const ac = new AbortController();
    const w = abortable(new Promise(() => {}), ac.signal);
    setTimeout(() => ac.abort(), 10);
    const e = await w.catch((x) => x);
    check(e && e.name === 'AbortError', 'Cancel rejects a wait on a promise that never settles');
    const ac2 = new AbortController(); ac2.abort();
    check((await abortable(Promise.resolve(1), ac2.signal).catch((x) => x)).name === 'AbortError', 'already aborted: AbortError');
    check(await abortable(Promise.resolve(3), new AbortController().signal) === 3, 'not aborted: the value');
    check(await abortable(Promise.resolve(4), null) === 4, 'no signal: the promise');
}
{
    const GB = 1024 ** 3;
    check(heapNearLimit({ usedJSHeapSize: 1 * GB, jsHeapSizeLimit: 4 * GB }) === null, '1 of 4 GB: headroom');
    const h = heapNearLimit({ usedJSHeapSize: 3.5 * GB, jsHeapSizeLimit: 4 * GB });
    check(h && h.usedMB === 3584 && h.limitMB === 4096, '3.5 of 4 GB: stop');
    check(heapNearLimit({ usedJSHeapSize: 3.5 * GB, jsHeapSizeLimit: 16 * GB }) !== null, 'the limit is capped at 4 GiB (the V8 cage)');
    check(heapNearLimit(null) === null && heapNearLimit({}) === null, 'no performance.memory: never stops');
}

// ---- the pools, with fake workers
globalThis.window = globalThis;
globalThis.document = { baseURI: 'file:///lucid/' };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const behaviours = [];      // per worker index: 'ok' | 'die' | 'silent'
let made = 0;
class FakeWorker {
    constructor() { this.i = made++; this.mode = behaviours[this.i] || 'ok'; this.terminated = false; this.onmessage = null; this.onerror = null; }
    postMessage(m) {
        if (this.terminated) return;
        if (m.type === 'cameras' || m.type === 'init') { if (m.type === 'init') setTimeout(() => this.onmessage && this.onmessage({ data: { type: 'ready' } }), 1); return; }
        if (this.mode === 'silent') return;
        if (this.mode === 'die') { setTimeout(() => this.onerror && this.onerror({ message: 'boom', preventDefault() {} }), 5); return; }
        if (m.type === 'solve') setTimeout(() => !this.terminated && this.onmessage && this.onmessage({ data: { type: 'solved', id: m.id, results: m.jobs.map(() => ({ fromWorker: true })) } }), 3);
        if (m.type === 'frames') setTimeout(() => !this.terminated && this.onmessage && this.onmessage({ data: { type: 'tracked', id: m.id, r: { fis: m.fis, nT: new Int32Array(m.fis.length), live: new Int32Array(m.fis.length), trackIds: new Float64Array(0), nMem: new Int32Array(0), mem: new Int32Array(0), p3len: new Int32Array(0), p3: new Float64Array(0) } } }), 3);
    }
    terminate() { this.terminated = true; }
}
globalThis.Worker = FakeWorker;
const { Camera, Instance } = await import('../pose/pose-data.js');
const { createGroupSolver } = await import('../pose/triangulation-pool.js');
const cams = [
    new Camera('a', [[800, 0, 640], [0, 800, 512], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 500], [1280, 1024]),
    new Camera('b', [[800, 0, 640], [0, 800, 512], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0.5, 0], [-200, 0, 500], [1280, 1024]),
];
const group = () => {
    const xy = { a: new Float64Array([640, 512, 660, 520]), b: new Float64Array([600, 512, 620, 520]) };
    return { getInstance: (n) => new Instance(xy[n].slice(), 0, 'predicted', 1) };
};
async function runSolver(modes, groups, label) {
    behaviours.length = 0; behaviours.push(...modes); made = 0;
    globalThis.LUCID_TRIANGULATION_WORKERS = modes.length;
    const solver = createGroupSolver(cams, { method: 'dlt' });
    let applied = 0, inOrder = true, last = -1;
    const run = (async () => {
        for (let i = 0; i < groups; i++) {
            const k = i;
            solver.submit(group(), cams, () => { applied++; if (k < last) inOrder = false; last = k; });
            await solver.throttle();
        }
        await solver.finish();
    })();
    const r = await within(run, 4000);
    check(made === modes.length, label + ': a fresh pool of ' + modes.length);
    check(r === 'done', label + ': finishes (' + r + ')');
    check(applied === groups && inOrder, label + ': every callback, in order (' + applied + '/' + groups + ')');
}
console.log('§4 triangulation pool: dead and silent workers');
// (a healthy pool is kept for the next run of the same size, so it gets its own size; a pool with a
// retired worker is discarded at finish)
await runSolver(['ok', 'ok', 'ok', 'ok', 'ok'], 1600, 'healthy pool');
await runSolver(['die', 'ok', 'ok'], 6000, 'one worker dies while the others hold batches (the old deadlock)');
await runSolver(['die', 'die', 'die'], 1600, 'every worker dies');
globalThis.LUCID_WORKER_REPLY_TIMEOUT_MS = 60;
await runSolver(['silent', 'ok', 'ok'], 1600, 'one worker never answers (watchdog)');
await runSolver(['silent', 'silent'], 800, 'no worker answers (watchdog, then inline)');
delete globalThis.LUCID_WORKER_REPLY_TIMEOUT_MS;

console.log('§5 tracker pool: a silent worker fails the run');
{
    const { startTrackerWorker } = await import('../pose/tracker-pool.js');
    behaviours.length = 0; behaviours.push('silent'); made = 0;
    globalThis.LUCID_TRACKER_WORKER = 1;
    const pool = await startTrackerWorker(cams, {}, () => {}, { replyTimeoutMs: 60 });
    check(!!pool, 'started');
    pool.submit(0, [[new Float64Array(4)], []]);
    const r = await within(pool.finish(), 2000);
    check(/^rejected: the tracker worker did not answer/.test(r), 'finish rejects instead of hanging (' + r + ')');
    pool.close();
    // a worker that never answers `init`: null (track inline), not a hang
    behaviours.length = 0; behaviours.push('mute'); made = 0;
    const origPost = FakeWorker.prototype.postMessage;
    FakeWorker.prototype.postMessage = function (m) { if (this.mode === 'mute') return; return origPost.call(this, m); };
    const r0 = await within(startTrackerWorker(cams, {}, () => {}, { replyTimeoutMs: 60 }).then((p) => { if (p !== null) throw new Error('got a pool'); }), 2000);
    check(r0 === 'done', 'a worker that never answers init: null, track inline (' + r0 + ')');
    FakeWorker.prototype.postMessage = origPost;
    behaviours.length = 0; behaviours.push('ok'); made = 0;
    const pool2 = await startTrackerWorker(cams, {}, () => {}, { replyTimeoutMs: 60 });
    for (let f = 0; f < 250; f++) pool2.submit(f, [[new Float64Array(4)], []]);
    await sleep(150);   // longer than the deadline, but the worker answers: no false alarm
    check(await within(pool2.finish(), 2000) === 'done', 'a worker that answers is never timed out');
    pool2.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
