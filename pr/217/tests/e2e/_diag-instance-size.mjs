/**
 * _diag-instance-size.mjs — measures the REAL `Instance` class (not a synthetic
 * stand-in) in a live renderer, splitting its cost into the CAGE (V8's
 * pointer-compressed heap, hard-capped near 4 GB — the resource a large project
 * runs out of) and EXTERNAL typed-array backing stores (outside that cap).
 *
 * `usedJSHeapSize` counts both, so it understates the win: converting boxed rows
 * to a Float64Array moves bytes from the scarce pool to the free one, and the
 * headline delta hides that.
 *
 * Not a test. Usage: node _diag-instance-size.mjs [nodes] [count] [port]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const NODES = Number(process.argv[2] || 15);
const N = Number(process.argv[3] || 200000);
const PORT = Number(process.argv[4] || 8103);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch({ args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] });
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid, { timeout: 20000 });

    const r = await page.evaluate(async ({ NODES, N }) => {
        const pd = await import('/pose/pose-data.js');
        const gc = () => { for (let i = 0; i < 4; i++) window.gc && window.gc(); };
        const settle = async () => { gc(); await new Promise(r => setTimeout(r, 120)); gc(); };

        const boxed = [];
        for (let k = 0; k < NODES; k++) boxed.push([k + 0.5, k + 1.5]);

        await settle();
        const before = performance.memory.usedJSHeapSize;
        const keep = new Array(N);
        for (let i = 0; i < N; i++) keep[i] = new pd.Instance(boxed, i & 31, 'predicted', 0.9);
        await settle();
        const after = performance.memory.usedJSHeapSize;
        if (keep.length === -1) console.log('never');

        const totalPer = (after - before) / N;
        // The only external allocation is the coordinate backing store; the
        // occlusion bit set is a plain Number at <=32 nodes.
        const externalPer = NODES * 2 * 8;
        return {
            nodes: NODES, count: N,
            totalPerObj: Math.round(totalPer),
            externalPerObj: externalPer,
            cagePerObj: Math.round(totalPer - externalPer),
            occIsNumber: typeof keep[0]._occ === 'number',
            limitMB: +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0),
        };
    }, { NODES, N });

    const REAL = 2630632;   // instances in the real bug-report project
    const BOXED_CAGE = 824; // measured for the old representation (_diag-repr-sizing.mjs)
    console.log(JSON.stringify(r));
    console.log(`\n  real Instance, ${r.nodes} nodes  (occlusion stored as a Number: ${r.occIsNumber})`);
    console.log(`    total      ${r.totalPerObj} B/obj   (what usedJSHeapSize reports)`);
    console.log(`    external   ${r.externalPerObj} B/obj   (backing store — OUTSIDE the ~4 GB cap)`);
    console.log(`    CAGE       ${r.cagePerObj} B/obj   (the constrained resource)`);
    console.log(`\n  at the real project's ${REAL.toLocaleString()} instances:`);
    console.log(`    was  ${(BOXED_CAGE * REAL / 1048576).toFixed(0)} MB of cage (boxed rows + boolean[])`);
    console.log(`    now  ${(r.cagePerObj * REAL / 1048576).toFixed(0)} MB of cage`);
    console.log(`    freed ${((BOXED_CAGE - r.cagePerObj) * REAL / 1048576).toFixed(0)} MB of cage`);
} catch (e) {
    console.error('FATAL', String(e).slice(0, 400));
} finally {
    if (browser) await browser.close();
    server.kill();
}
