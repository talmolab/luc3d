/**
 * track-all-cpu-load.mjs — Track All's CPU line and load graph on the loading
 * overlay (`setLoadingCpu({mainThread: true})`, ui/loading-overlay.js), and the
 * thousands commas in what its popups say.
 *
 * Track All's tracker steps the frames in order on ONE worker
 * (pose/tracker-pool.js) while the main thread hydrates frames and commits the
 * results, so the line sums the worker's busy time and the main thread's, which
 * the overlay clocks itself: busy from the start of the identity pass, except
 * while it waits in `yieldToPaint` for a paint or in `idleWhile` on the worker.
 * Asserted:
 *  1. The clock itself: an operation that only waits in `yieldToPaint` reads
 *     ~0%; one that is never in `yieldToPaint` (computing, between plain
 *     timeouts) reads exactly one core's share — the control that shows the
 *     paint waits are what is left out, and nothing else.
 *  2. A real Track All (the BA rig fixture's 8 frames repeated, a windowed lazy
 *     project): the "Assigning identities: 12,345/60,000 frames" line has
 *     commas; a CPU line with its key and graph (labelled axes), no GPU series;
 *     MORE than one core's share and at most two (the worker plus the main
 *     thread); a tooltip naming both. With the worker off
 *     (`LUCID_TRACKER_WORKER = 0`, the inline fallback): one core's share, and
 *     a tooltip saying it runs on the main thread.
 *     The popup is the image check's card (fixtures/progress-card.js): titled
 *     "Track All", opaque, the app not greyed out, the CPU line left-justified.
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
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
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
    const startTrackAll = (worker) => page.evaluate(async (worker) => {
        window.LUCID_TRACKER_WORKER = worker ? undefined : 0;
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
    }, worker);
    const firstReading = () => page.waitForFunction(() => !document.getElementById('loadingHardware').classList.contains('hidden') &&
        /· load \d+%$/.test(document.getElementById('loadingCpu').textContent), null, { timeout: 60000 });
    await startTrackAll(true);
    await firstReading();
    // read at once: the load from the first measured reading, and the run lasts only seconds
    const run = await page.evaluate(() => {
        const line = document.getElementById('loadingCpu'), svg = document.querySelector('#loadingGraph svg');
        return { status: document.getElementById('loadingStatus').textContent, text: line.textContent, title: line.title,
                 key: line.classList.contains('has-series'), shown: !document.getElementById('loadingHardware').classList.contains('hidden'),
                 cpuD: svg.querySelector('path.is-cpu').getAttribute('d') || '', gpuD: svg.querySelector('path.is-gpu').getAttribute('d') || '' };
    });
    check(/^Assigning identities: \d{1,2},\d{3}\/60,000 frames…$/.test(run.status), `the progress line has commas ("${run.status}")`);
    {   // the image check's card style: titled, opaque, the app not greyed out, the CPU line left-justified
        const st = await page.evaluate(async () => {
            const { progressCardStyle } = await import('/tests/e2e/fixtures/progress-card.js');
            const t = document.getElementById('loadingTitle');
            return Object.assign(progressCardStyle(document.querySelector('.loading-card'), document.getElementById('loadingOverlay'), document.getElementById('loadingCpu')),
                { title: t.classList.contains('hidden') ? null : t.textContent, pct: document.getElementById('loadingPct').textContent,
                  spinner: !document.getElementById('loadingSpinner').classList.contains('hidden') });
        });
        check(st.ok && st.title === 'Track All' && /^\d+%$/.test(st.pct) && !st.spinner,
              `the image check's card: "${st.title}", opaque, the app not greyed out, the CPU line left-justified, "${st.pct}" under the bar, no spinner` + (st.ok ? '' : ' — ' + st.why));
    }
    const l2 = loadOf(run.text);
    check(run.shown && run.key && run.cpuD && !run.gpuD, `a CPU line with its key and graph, no GPU series ("${run.text}")`);
    {   // its axes: "100%" / "50%" / "0%" level with what they label, "60 s ago" … "now" under it, each with a tick
        // pointing out of the plot (fixtures/load-graph-axes.js)
        const ax = await page.evaluate(async (sel) => (await import('/tests/e2e/fixtures/load-graph-axes.js')).loadGraphAxes(document.querySelector(sel)), '#loadingGraph');
        check(ax.ok, `labelled axes with out ticks: ${ax.y.map(l => l.t + ' ' + l.off.toFixed(2) + ' px off').join(', ')}; ${ax.x.map(l => '"' + l.t + '"').join(' … ')} under the plot; ${ax.ticks.length} ticks` + (ax.ok ? '' : ' — ' + ax.why));
    }
    check(l2 > oneCore + 1 && l2 <= 2 * oneCore + 1.5,
          `more than one core's share and at most two: ${l2}% vs ${oneCore.toFixed(1)}% a core — the tracker worker plus the main thread`);
    check(/kept busy over the last 5 s by Track All: its tracker worker, and the main thread loading frames and writing back the results\./.test(run.title),
          `its tooltip names both ("${run.title}")`);

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

    // ---- 4. the inline fallback (worker off): the main thread alone
    await page.evaluate(() => { document.querySelectorAll('.track-summary-modal, .modal-overlay').forEach(e => e.remove()); });
    await startTrackAll(false);
    await firstReading();
    const inl = await page.evaluate(() => { const line = document.getElementById('loadingCpu'); return { text: line.textContent, title: line.title }; });
    const l4 = loadOf(inl.text);
    check(Math.abs(l4 - oneCore) <= 1.5, `worker off: one core's share, ${l4}% vs ${oneCore.toFixed(1)}%`);
    check(/kept busy over the last 5 s by Track All, which runs on the main thread: one core at most\./.test(inl.title),
          `…and its tooltip says it runs on the main thread ("${inl.title}")`);
    const inlDone = await page.evaluate(async () => { const r = await window.__done; return r && r.ok; });
    check(inlDone, '…and it completes');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
