/**
 * test-image-rest-timer.mjs — the image check's rests are timed in a worker
 * (`restTimer`, ui/image-embedder.js), because a hidden page's setTimeout is
 * throttled to ~1 s (and to 1 min after 5 min hidden), which turned an 80% cap into
 * ~20% of the uncapped throughput whenever LUCID's window was behind another app's
 * (measured on an M5 MacBook Pro: 124 -> 26 crops/s; with worker-timed rests, 125).
 * Node has no page and no Worker, so the page path runs against a fake Worker that
 * records what it is asked and answers like the real one; the fallback path runs
 * against Node's own setTimeout.
 *
 * Run:  node tests/test-image-rest-timer.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const embedderUrl = pathToFileURL(path.join(HERE, '..', 'ui', 'image-embedder.js')).href;
globalThis.window = globalThis;
let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- 1. no page (Node, a worker): plain setTimeout ----------------------------
{
    const E = await import(embedderUrl + '?no-page');
    let fired = 0;
    E.restTimer(20, () => { fired++; });
    const cancel = E.restTimer(20, () => { fired += 10; });
    cancel();
    await sleep(80);
    ok(fired === 1, `without a page the rest falls back to setTimeout and a cancelled one never fires (fired ${fired})`);
}

// ---- 2. a page: one worker times every rest -------------------------------------
{
    const made = [], asked = [];
    globalThis.document = {};
    globalThis.Worker = class {
        constructor(url) { this.url = url; made.push(this); }
        postMessage(d) { asked.push(d); setTimeout(() => { if (this.onmessage) this.onmessage({ data: d.id }); }, d.ms); }
        terminate() {}
    };
    const E = await import(embedderUrl + '?page');
    const order = [];
    const t0 = Date.now();
    E.restTimer(40, () => order.push('b'));
    E.restTimer(10, () => order.push('a'));
    const cancel = E.restTimer(20, () => order.push('cancelled'));
    cancel();
    await sleep(100);
    ok(made.length === 1, `one rest worker for every rest (${made.length} made)`);
    ok(made[0] && /^blob:/.test(String(made[0].url)), 'the worker is a blob: script (no file of its own to stamp or vendor)');
    ok(asked.length === 3 && asked.every(d => typeof d.id === 'number' && d.ms > 0), 'each rest is handed to the worker with its length');
    ok(order.join(',') === 'a,b', `rests end in the worker's time and a cancelled one never runs its callback (${order.join(',')})`);
    ok(Date.now() - t0 < 1000, 'nothing waited on a page timer');

    // a worker that fails: the rests waiting on it still end, and later ones fall back
    let late = 0;
    E.restTimer(10_000, () => { late++; });
    made[0].onerror({});
    await sleep(30);
    ok(late === 1, 'a rest waiting on a worker that failed ends at once rather than never');
    let after = 0;
    E.restTimer(5, () => { after++; });
    await sleep(40);
    ok(after === 1 && made.length === 1, 'after a failure, rests use setTimeout (no new worker)');
    delete globalThis.document; delete globalThis.Worker;
}

console.log(`\ntest-image-rest-timer: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
