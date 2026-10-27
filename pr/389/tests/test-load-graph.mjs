/**
 * test-load-graph.mjs — the CPU / GPU load helpers shared by the image check's
 * progress dialog and the loading overlay (ui/load-graph.js): the busy clock
 * threads report to, the rolling meter, the CPU line, and the graph's path.
 * The DOM half (`createLoadGraph`, the hover readout, `setLoadingCpu`) is driven
 * in a real browser by tests/e2e/id-switch-image-check.mjs and
 * tests/e2e/triangulate-all-cpu-load.mjs.
 *
 * Run:  node tests/test-load-graph.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const G = await import(pathToFileURL(path.join(ROOT, 'ui', 'load-graph.js')).href);

let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
function eq(a, e, m) { ok(a === e, `${m} (expected ${e}, got ${a})`); }
function group(n) { console.log('\n• ' + n); }

group('createBusyClock — busy time summed over threads, spans in flight included');
{
    let t = 0;
    const clk = G.createBusyClock(() => t);
    eq(clk.ms(), 0, 'nothing begun → 0');
    clk.begin('a'); t = 100;
    eq(clk.ms(), 100, 'an open span counts up to now');
    clk.begin('a'); clk.begin('b'); t = 150;
    eq(clk.ms(), 200, 'two threads busy at once count twice: a 150 + b 50');
    clk.end('a'); t = 200;
    eq(clk.ms(), 300, 'a lane with a job still queued stays busy (nested begin)');
    clk.end('a'); t = 300;
    eq(clk.ms(), 400, '…and stops once its last job ends: a 200 + b 200 at 300 ms');
    clk.end('a'); t = 310;
    eq(clk.ms(), 410, 'an extra end is ignored');
    clk.close('b'); t = 400;
    eq(clk.ms(), 410, 'close(lane) stops a lane that still had work (a worker that failed)');
    clk.begin('c'); clk.begin('c'); clk.begin('d'); t = 450;
    clk.close(); t = 500;
    eq(clk.ms(), 510, 'close() stops every lane (terminate): c 50 + d 50, then nothing');
    const real = G.createBusyClock();
    ok(real.ms() === 0 && typeof real.begin === 'function', 'the default clock is performance.now()');
    // a pool's pattern: the main lane closed while it waits, a reply handled during the wait reopens it
    t = 0;
    const m = G.createBusyClock(() => t);
    m.begin('main'); t = 100;
    m.end('main'); t = 150;                   // waiting on the workers
    m.begin('main'); t = 160; m.end('main');  // a reply handled during the wait
    t = 200; m.begin('main'); t = 250;        // resumed
    eq(m.ms(), 100 + 10 + 50, 'main: busy, waiting (not counted), a reply handler, busy again');
    m.begin('main'); t = 260; m.end('main');  // a handler while the main lane is already open (a paint wait)
    eq(m.ms(), 170, '…a handler inside an open span is not counted twice');
}

group('createLoadMeter — share of the window spent busy');
{
    const meter = G.createLoadMeter(5000);
    eq(meter(0, 0), null, 'first sample → not measured yet');
    ok(Math.abs(meter(1000, 920 / 12) - 100 * 920 / 12 / 1000) < 1e-9, 'CPU use: thread-ms / cores, as a share of the window');
    eq(G.LOAD_WINDOW_MS, 5000, 'the last 5 s');
}

group('formatCpuLoad — the CPU line');
{
    let c = G.formatCpuLoad(12, null, 'X');
    ok(c.text === 'CPU: 12 cores' && c.title === '' && c.load === null, 'before the load is measured ("' + c.text + '")');
    c = G.formatCpuLoad(12, 91.6, 'Triangulate All: 11 workers solving');
    ok(c.text === 'CPU: 12 cores · load 92%' && c.load === 91.6, 'with its load ("' + c.text + '")');
    eq(c.title, 'The share of the CPU\'s 12 cores kept busy over the last 5 s by Triangulate All: 11 workers solving. ' +
       'Browsers do not report the CPU\'s total load, so other apps are not included.', 'the tooltip says what it counts, and what it cannot');
    eq(G.formatCpuLoad(1, 50, 'X').text, 'CPU: 1 core · load 50%', 'one core, singular');
    eq(G.formatCpuLoad(0, 50, 'X').text, 'CPU · load 50%', 'unknown core count → no count claimed');
    eq(G.formatCpuLoad(undefined, null, 'X').text, 'CPU', '…nor before the load');
    ok(/^The share of the CPU kept busy/.test(G.formatCpuLoad(0, 50, 'X').title), '…in the tooltip either');
}

group('loadGraphPath — by time, newest at the right edge, 0% at the bottom, broken at gaps');
{
    eq(G.loadGraphPath([], 1000, 60000, 100, 30), '', 'no samples → no path');
    eq(G.loadGraphPath([{ t: 60000, v: 50 }], 60000, 60000, 100, 30), 'M100.0 15.0L100.0 15.0', 'a lone point is a zero-length segment (a dot with a round cap)');
    eq(G.loadGraphPath([{ t: 0, v: 0 }, { t: 30000, v: 100 }, { t: 60000, v: 25 }], 60000, 60000, 100, 30),
       'M0.0 30.0L50.0 0.0L100.0 22.5', 'placed by time across the span, 0% at the bottom, 100% at the top');
    eq(G.loadGraphPath([{ t: 50000, v: 50 }, { t: 51000, v: 50 }, { t: 57000, v: 50 }], 60000, 60000, 60, 30),
       'M50.0 15.0L51.0 15.0L57.0 15.0', 'uneven spacing (a blocked main thread) stays on the time axis');
    eq(G.loadGraphPath([{ t: 0, v: 10 }, { t: 1000, v: null }, { t: 2000, v: 20 }, { t: 3000, v: 30 }], 3000, 3000, 30, 100),
       'M0.0 90.0L0.0 90.0M20.0 80.0L30.0 70.0', 'a null breaks the line; the lone point before it stays visible');
    eq(G.loadGraphPath([{ t: 0, v: 150 }, { t: 1000, v: -5 }, { t: 2000, v: NaN }], 1000, 1000, 10, 10),
       'M0.0 0.0L10.0 10.0', 'clamped to 0-100%, NaN skipped');
    ok(G.loadGraphPath([{ t: -10000, v: 50 }, { t: 0, v: 50 }], 60000, 60000, 60, 10).startsWith('M-10.0 5.0'),
       'a point older than the span is kept left of the box, so the line enters from the edge');
    eq(G.LOAD_GRAPH_SPAN_MS, 60000, 'the graph shows the last minute');
}

console.log(`\n${failed === 0 ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`);
if (failed) { failures.forEach((f) => console.error('  - ' + f)); process.exit(1); }
