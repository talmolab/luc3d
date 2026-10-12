/**
 * track-all-cpu-load.mjs — Track All's CPU line and load graph on the loading
 * overlay (`setLoadingCpu({mainThread: true})`, ui/loading-overlay.js), and the
 * thousands commas in what its popups say.
 *
 * Track All's tracker steps the frames in order on the main thread — no
 * workers — so the overlay clocks the main thread itself: busy from the start
 * of the identity pass, except while it waits in `yieldToPaint` for a paint.
 * Asserted:
 *  1. The clock itself: an operation that only waits in `yieldToPaint` reads
 *     ~0%; one that is never in `yieldToPaint` (computing, between plain
 *     timeouts) reads exactly one core's share — the control that shows the
 *     paint waits are what is left out, and nothing else.
 *  2. A real Track All (the BA rig fixture's 8 frames repeated, a windowed lazy
 *     project): the "Assigning identities: 12,345/60,000 frames" line has
 *     commas; a CPU line with its key and graph, no GPU series; one core's
 *     share; a tooltip saying it runs on the main thread.
 *  3. When it ends the CPU row is hidden and cleared; the status line and the
 *     Track All summary box give the frame count with commas.
 *
 * Run: node tests/e2e/track-all-cpu-load.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8285);
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
    const cores = await page.evaluate(() => navigator.hardwareConcurrency);
    const oneCore = 100 / cores;
    const loadOf = (t) => { const m = /^CPU: \d+ cores? · load (\d+)%$/.exec(t || ''); return m ? +m[1] : NaN; };
    const cpuText = () => page.evaluate(() => document.getElementById('loadingCpu').textContent);

    // ---- 1. the main-thread clock: paint waits are left out, nothing else
    const clockRes = await page.evaluate(async () => {
        const L = await import('/ui/loading-overlay.js');
        const text = () => document.getElementById('loadingCpu').textContent;
        L.showLoadingProgress('Waiting', 0, 10);
        L.setLoadingCpu({ mainThread: true, counts: 'a test' });
        let t0 = performance.now();
        while (performance.now() - t0 < 2600) await L.yieldToPaint();                 // only paint waits
        const waiting = text();
        L.setLoadingCpu({ mainThread: true, counts: 'a test' });                         // a fresh window
        t0 = performance.now();
        while (performance.now() - t0 < 2600) {                                          // computing, then a plain timeout
            const c = performance.now(); while (performance.now() - c < 150) { /* busy */ }
            await new Promise(r => setTimeout(r, 0));
        }
        const computing = text();
        L.hideLoading();
        return { waiting, computing };
    });
    check(loadOf(clockRes.waiting) <= 1, `an operation that only waits for paints reads ~0% ("${clockRes.waiting}")`);
    check(Math.abs(loadOf(clockRes.computing) - oneCore) <= 1,
          `one that is never in yieldToPaint reads one core's share, ${oneCore.toFixed(1)}% ("${clockRes.computing}")`);

    // ---- 2. a real Track All
    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const pd = await import('/pose/pose-data.js');
        const TR = await import('/pose/tracker.js');
        const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
        const F = await buildBaRigFixture();
        const N = 60000;
        // the fixture's 8 valid frames repeated, as a windowed lazy project with no identities yet
        const s = new pd.Session(F.cams, F.skel, ['track_0', 'track_1'], 'TRACK_' + N);
        const base = F.mkLazyLoader();
        s.lazyLoader = { isSync: true, nFrames: N, getFrameSync: (fi) => fi < N ? base.getFrameSync(fi % F.NF) : null,
            getFrame(fi) { return Promise.resolve(this.getFrameSync(fi) || new Map()); }, releaseWindow() {} };
        AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
        AS.state.totalFrames = N; AS.state.currentFrame = 0; AS.state.views = []; AS.state.triangulationResults = new Map();
        TR.setTrackerNumAnimals(2);                    // no "Number of animals" prompt
        window.__done = TR.trackAll();
    });
    await page.waitForFunction(() => !document.getElementById('loadingHardware').classList.contains('hidden') &&
        /· load \d+%$/.test(document.getElementById('loadingCpu').textContent), null, { timeout: 60000 });
    // read at once: one core's share from the first measured reading, and the run lasts only seconds
    const run = await page.evaluate(() => {
        const line = document.getElementById('loadingCpu'), svg = document.querySelector('#loadingGraph svg');
        return { status: document.getElementById('loadingStatus').textContent, text: line.textContent, title: line.title,
                 key: line.classList.contains('has-series'), shown: !document.getElementById('loadingHardware').classList.contains('hidden'),
                 cpuD: svg.querySelector('path.is-cpu').getAttribute('d') || '', gpuD: svg.querySelector('path.is-gpu').getAttribute('d') || '' };
    });
    check(/^Assigning identities: \d{1,2},\d{3}\/60,000 frames \(\d+%\)…$/.test(run.status), `the progress line has commas ("${run.status}")`);
    const l2 = loadOf(run.text);
    check(run.shown && run.key && run.cpuD && !run.gpuD, `a CPU line with its key and graph, no GPU series ("${run.text}")`);
    check(Math.abs(l2 - oneCore) <= 1.5, `one core's share: ${l2}% vs ${oneCore.toFixed(1)}% — the tracker is single-threaded`);
    check(/kept busy over the last 5 s by Track All, which runs on the main thread: one core at most\./.test(run.title),
          `its tooltip says so ("${run.title}")`);

    // ---- 3. the end
    const end = await page.evaluate(async () => {
        const r = await window.__done;
        await new Promise(res => setTimeout(res, 300));
        const box = document.querySelector('.track-summary-modal, .track-summary');
        return { ok: r && r.ok, hidden: document.getElementById('loadingHardware').classList.contains('hidden'),
                 cleared: document.getElementById('loadingCpu').textContent === '', status: document.getElementById('statusText').textContent,
                 summary: box ? box.textContent : document.body.textContent.match(/Frames[^]{0,80}/) && document.body.textContent.match(/Frames[^]{0,80}/)[0] };
    });
    check(end.ok && end.hidden && end.cleared, 'when it ends the CPU row is hidden and cleared');
    check(/across 60,000 frames/.test(end.status), `the status line: "${end.status.slice(0, 80)}…"`);
    check(/60,000/.test(end.summary || ''), `the Track All summary box: "${(end.summary || '').replace(/\s+/g, ' ').slice(0, 120)}"`);

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
