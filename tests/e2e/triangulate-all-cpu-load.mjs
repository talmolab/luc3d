/**
 * triangulate-all-cpu-load.mjs — Triangulate All's CPU line and load graph on
 * the loading overlay (ui/loading-overlay.js `setLoadingCpu`, fed by the worker
 * pool's `cpuBusyMs()`, pose/triangulation-pool.js).
 *
 * Triangulation is pure JS math on the workers and the main thread, so the
 * overlay shows the CPU alone — no GPU line, no GPU series. The project is the
 * shared BA rig fixture's 8 valid frames repeated (fixtures/ba-rig-fixture.js;
 * its own `frames` option drifts the animals out of the cameras' valid range),
 * big enough that a Refined run lasts a few seconds. Asserted:
 *  1. Windowed (lazy) project, worker pool: a "CPU: N cores · load X%" line with
 *     the CPU legend key appears under the detail line, its graph to the right,
 *     with a CPU series and no GPU series, the newest point equal to the line;
 *     the load exceeds ONE core's share, so the workers are counted (the main
 *     thread alone could never read more); the tooltip names the workers.
 *  2. When the run ends it hides with the overlay, is cleared, and stays so.
 *  3. The in-memory (eager) project's path shows it too.
 *  4. Inline (`LUCID_TRIANGULATION_WORKERS = 0`): the main thread does it all,
 *     never waits on a worker, so the load is exactly one core's share; the
 *     tooltip says so.
 *  5. Another operation's progress (no CPU source) shows no CPU line.
 *
 * Run: node tests/e2e/triangulate-all-cpu-load.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8284);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const pd = await import('/pose/pose-data.js');
        const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
        const F = await buildBaRigFixture();
        // N frames of the fixture's 8, repeated; lazy (the windowed sweep) or eager (in memory). Track-All-shaped:
        // per-frame identities and no groups, so Triangulate All groups as it goes.
        window.__mk = (N, eager) => {
            const s = new pd.Session(F.cams, F.skel, ['track_0', 'track_1'], 'CPU_' + N);
            const ids = [s.addIdentity('Red'), s.addIdentity('Blue')];
            if (eager) {
                for (let f = 0; f < N; f++) {
                    const fg = new pd.FrameGroup(f); s.addFrameGroup(fg);
                    for (const cam of F.cams) F.mkInstances(f % F.NF, cam.name).forEach((inst, i) => { inst._rawInstIndex = i; fg.addInstance(cam.name, inst); });
                }
            } else {
                const base = F.mkLazyLoader();
                s.lazyLoader = { isSync: true, nFrames: N, getFrameSync: (fi) => fi < N ? base.getFrameSync(fi % F.NF) : null,
                    getFrame(fi) { return Promise.resolve(this.getFrameSync(fi) || new Map()); }, releaseWindow() {} };
            }
            for (let f = 0; f < N; f++) for (const cam of F.cams) for (let t = 0; t < 2; t++) s.setFrameIdentity(f, cam.name, t, ids[t].id);
            AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
            AS.state.totalFrames = N; AS.state.currentFrame = 0; AS.state.views = []; AS.state.triangulationResults = new Map();
        };
        window.__start = async (N, eager) => {
            window.__mk(N, eager);
            const TRI = await import('/pose/triangulation.js');
            window.__done = TRI.triangulateAllFrames('ba');
        };
    });
    // Everything the overlay's CPU row shows, read in one task (the line and the graph are written together).
    const readRow = () => page.evaluate(() => {
        const q = (id) => document.getElementById(id), box = (el) => el.getBoundingClientRect();
        const line = q('loadingCpu'), graph = q('loadingGraph'), svg = graph.querySelector('svg');
        const g = svg && svg.querySelector('g'), pad = g ? +g.getAttribute('transform').match(/translate\(0 ([\d.]+)\)/)[1] : 0;
        const plotH = svg ? svg.viewBox.baseVal.height - 2 * pad : 0;
        const cpuD = svg ? svg.querySelector('path.is-cpu').getAttribute('d') || '' : '', m = cpuD.match(/([\d.]+) ([\d.]+)$/);
        return {
            shown: !q('loadingHardware').classList.contains('hidden') && !q('loadingOverlay').classList.contains('hidden'),
            text: line.textContent, title: line.title, key: line.classList.contains('has-series'),
            keyColour: getComputedStyle(line, '::before').backgroundColor, stroke: svg ? getComputedStyle(svg.querySelector('path.is-cpu')).stroke : '',
            graphOn: graph.classList.contains('is-on') && getComputedStyle(graph).visibility === 'visible',
            cpuD, gpuD: svg ? svg.querySelector('path.is-gpu').getAttribute('d') || '' : '',
            newest: m ? { x: +m[1], pct: 100 * (plotH - m[2]) / plotH } : null, width: svg ? svg.viewBox.baseVal.width : 0,
            belowDetail: box(q('loadingHardware')).top >= box(q('loadingSubstatus')).bottom,
            rightOfLine: svg ? box(svg).left >= box(line).right : false,
            gpuLine: !!document.querySelector('#loadingOverlay .load-line.is-gpu'),
        };
    });
    const loadOf = (t) => { const m = /^CPU: \d+ cores? · load (\d+)%$/.exec(t); return m ? +m[1] : NaN; };
    const cores = await page.evaluate(() => navigator.hardwareConcurrency);
    const oneCore = 100 / cores;
    // the row visible AND measured — never the last run's line, which setLoadingCpu clears when it stops
    const waitLoad = () => page.waitForFunction(() => !document.getElementById('loadingHardware').classList.contains('hidden') &&
        /· load \d+%$/.test(document.getElementById('loadingCpu').textContent), null, { timeout: 30000 });

    // ---- 5 first: another operation's progress has no CPU source, so no CPU row
    const plain = await page.evaluate(async () => {
        const L = await import('/ui/loading-overlay.js');
        L.showLoadingProgress('Assigning identities', 10, 100);
        const hidden = document.getElementById('loadingHardware').classList.contains('hidden');
        L.hideLoading();
        return hidden;
    });
    check(plain, 'an operation that reports no CPU time (Track All\'s progress) shows no CPU line');

    // ---- 1. windowed project on the worker pool
    await page.evaluate(() => window.__start(60000, false));
    await waitLoad();
    await page.waitForTimeout(1500);
    const r1 = await readRow();
    const l1 = loadOf(r1.text);
    const workers = await page.evaluate(() => +(document.getElementById('loadingSubstatus').textContent.match(/(\d+) workers/) || [])[1]);
    check(r1.shown && r1.belowDetail && r1.key && new RegExp('^CPU: ' + cores + ' cores? · load \\d+%$').test(r1.text),
          `windowed run: a CPU line under the detail line, with its legend key ("${r1.text}")`);
    check(l1 > oneCore + 1 && l1 <= 100, `…counting the ${workers} workers: ${l1}% is more than one core's ${oneCore.toFixed(1)}% (the main thread alone could not)`);
    check(new RegExp('kept busy over the last 5 s by Triangulate All: ' + workers + ' workers solving, and the main thread').test(r1.title) && /other apps/.test(r1.title),
          `…its tooltip names what it counts ("${r1.title}")`);
    check(r1.graphOn && r1.rightOfLine && r1.cpuD && !r1.gpuD && !r1.gpuLine,
          'the load graph sits to its right: a CPU series, no GPU series and no GPU line (triangulation does not use one)');
    check(r1.keyColour === r1.stroke, `the line's key is the series colour (${r1.keyColour})`);
    check(r1.newest && Math.abs(r1.newest.x - r1.width) < 0.05 && Math.abs(r1.newest.pct - l1) <= 1,
          `the graph's newest point, at its right edge, is the line's load (${r1.newest && r1.newest.pct.toFixed(1)}% vs ${l1}%)`);

    // ---- 2. it ends with the overlay
    const after = await page.evaluate(async () => {
        await window.__done;
        const text = document.getElementById('loadingCpu').textContent;
        await new Promise(r => setTimeout(r, 1300));
        return { hidden: document.getElementById('loadingHardware').classList.contains('hidden') && document.getElementById('loadingOverlay').classList.contains('hidden'),
                 cleared: text === '' && document.getElementById('loadingCpu').textContent === '', status: document.getElementById('statusText').textContent };
    });
    check(/^Triangulated 60,000 frames via Refined \(120,000 groups/.test(after.status), `the run completes ("${after.status}")`);
    check(after.hidden && after.cleared, 'the CPU line hides with the overlay, cleared, and stays so (its timer stopped)');

    // ---- 3. the in-memory project's path
    await page.evaluate(() => window.__start(60000, true));
    await waitLoad();
    const r3 = await readRow(), l3 = loadOf(r3.text);
    check(r3.shown && r3.graphOn && l3 > oneCore + 1 && r3.cpuD && !r3.gpuD, `in-memory run: the same CPU line and graph ("${r3.text}")`);
    await page.evaluate(() => window.__done);

    // ---- 4. inline: the main thread alone, and never waiting on a worker -> exactly one core
    // (read as soon as it is measured: inline it is exactly one core from the first reading, and the run is short)
    await page.evaluate(() => { window.LUCID_TRIANGULATION_WORKERS = 0; return window.__start(12000, true); });
    await waitLoad();
    const r4 = await readRow(), l4 = loadOf(r4.text);
    check(Math.abs(l4 - oneCore) <= 1 && /by Triangulate All, solving on the main thread\./.test(r4.title),
          `inline: one core's share (${l4}% vs ${oneCore.toFixed(1)}%), and the tooltip says it is the main thread ("${r4.title}")`);
    await page.evaluate(async () => { await window.__done; delete window.LUCID_TRIANGULATION_WORKERS; });

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
