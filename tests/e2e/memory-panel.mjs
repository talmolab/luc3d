/**
 * memory-panel.mjs — the Memory panel (`#tabMemory`, ui/memory-panel.js): the
 * page's JavaScript heap over time, reached from the right-edge panel rail.
 *
 * What this pins:
 *   §1  The heap is read once a second from app start, but nothing is drawn
 *       until the panel is on screen. Opened from the rail it draws the
 *       readings it already has at once: the plot gets a line, the reading is
 *       a `[\d,]+ MB` number, the JS object limit is a reference line, named
 *       so in the legend and the row (never "heap limit": typed arrays sit
 *       outside it, and a big project reads well above it), and with
 *       `--enable-precise-memory-info` the reading follows allocations. The ⓘ
 *       says what the number leaves out (workers, GPU process).
 *   §2  Folded, with the info panel hidden (`I`), or closed (✕), the panel
 *       stops DRAWING but keeps reading: shown again, the line has no gap.
 *       The samples stay in memory only: nothing in localStorage but the
 *       rail's own open/folded list.
 *   §3  The project rows count frames in memory and frames with groups (demo).
 *   §4  A rounded reading (older Chrome without the flag; stubbed, since
 *       Chrome 157 reads live) is flagged in the panel.
 *   §5  No `performance.memory` (Firefox, Safari): a "not available" line,
 *       no plot; the project rows still work.
 *   §7  Runs are marked: while the progress card is up (ui/loading-overlay.js),
 *       each reading notes its title (or, untitled, its message up to the
 *       count), and the plot shades each run with its name along the top and
 *       a tooltip with its length and peak; a run done with the panel closed
 *       is marked too.
 *   §6  A cross-origin-isolated page with `measureUserAgentSpecificMemory`
 *       (stubbed here; LUCID sends no COOP/COEP) shows the whole page and its
 *       workers as rows and a second line, asking only while the panel is on
 *       screen; where the browser refuses the call (Playwright's Chromium
 *       does), the rows go away.
 *
 * Run: node memory-panel.mjs   (serves the app itself)
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
// Never isolated (even under LUC3D_E2E_ISOLATED=1): §1 needs a plain page, and §6
// stubs isolation itself. tests/e2e/isolated-server.mjs covers the real thing.
const server = await startServer(repoRoot, { isolated: false });
const URL_ = `http://localhost:${server.port}/index.html`;

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra)));
    if (!c) fails++;
};

async function openApp(browser, initScript) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    if (initScript) await context.addInitScript(initScript);
    const page = await context.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(URL_);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.__lucidMemoryPanel, null, { timeout: 30000 });
    return { context, page };
}

const panelState = page => page.evaluate(() => {
    const m = window.__lucidMemoryPanel;
    const vis = id => { const el = document.getElementById(id); return !!el && el.getClientRects().length > 0; };
    return {
        sampling: m.isSampling(),
        drawing: m.isDrawing(),
        taken: m.samplesTaken(),
        used: m.samples().map(s => s.used),
        now: document.getElementById('memoryNow').textContent,
        path: document.getElementById('memoryUsedPath').getAttribute('d'),
        uaPath: document.getElementById('memoryUaPath').getAttribute('d'),
        limitShown: document.getElementById('memoryLimitLine').getAttribute('visibility') !== 'hidden',
        limit: document.getElementById('memoryLimit').textContent,
        coarse: vis('memoryCoarse'),
        unavailable: vis('memoryUnavailable'),
        plot: vis('memoryPlot'),
        ua: vis('memoryUa') ? document.getElementById('memoryUa').textContent : null,
        uaWorkers: vis('memoryUaWorkers') ? document.getElementById('memoryUaWorkers').textContent : null,
        uaLegend: vis('memoryLegendUa'),
        resident: document.getElementById('memoryResident').textContent,
        groups: document.getElementById('memoryGroups').textContent,
        sessions: document.getElementById('memorySessions').textContent,
        tip: document.getElementById('memoryInfo').dataset.infotip || '',
    };
});

const openPanel = page => page.click('#panelRail .panel-rail-btn[data-tab="tabMemory"]');
const waitTaken = (page, n) => page.waitForFunction(k => window.__lucidMemoryPanel.samplesTaken() >= k, n, { timeout: 15000 });
/** How many separate pieces a path has. */
const moves = p => (p.match(/M/g) || []).length;
/** Wait 2.5 sample periods: how many readings arrived, and did the plot or the reading change? */
const whileHidden = async (page) => {
    const a = await panelState(page);
    await page.waitForTimeout(2500);
    const b = await panelState(page);
    return { taken: b.taken - a.taken, redrawn: a.path !== b.path || a.now !== b.now, drawing: b.drawing };
};
const MB_RE = /^[\d,]+ MB$/;

let precise;
try {
    precise = await launchBrowser({ args: ['--enable-precise-memory-info'] });

    // ---- §1 sampling while on screen ----
    {
        const { context, page } = await openApp(precise);
        await waitTaken(page, 3);
        let s = await panelState(page);
        check(s.sampling && !s.drawing && s.path === '' && s.now === '–',
            `the heap is read from app start (${s.taken} readings), but nothing is drawn before the panel is opened`, s);
        await openPanel(page);
        s = await panelState(page);
        check(s.drawing && s.plot && MB_RE.test(s.now) && /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+){2,}$/.test(s.path),
            `opened from the rail it draws the readings it already has at once (${s.now})`, s);
        await waitTaken(page, s.taken + 1);
        check(s.limitShown && MB_RE.test(s.limit), `the JS object limit is a reference line (${s.limit})`);
        const names = await page.evaluate(() => ({
            legend: document.querySelector('#tabMemory .memory-legend').textContent,
            row: document.getElementById('memoryLimit').previousElementSibling.textContent,
        }));
        check(/JS object limit/.test(names.legend) && names.row === 'JS object limit' && !/heap limit/i.test(names.legend + names.row),
            'it is named "JS object limit" in the legend and the row, never "heap limit"', names);
        check(!s.coarse && !s.unavailable && s.ua === null && !s.uaLegend,
            'a live reading: no rounding note, no "not available", no whole-page rows on a non-isolated page');
        check(/workers/.test(s.tip) && /GPU/.test(s.tip) && /typed arrays/.test(s.tip) && /objects only/.test(s.tip),
            'the ⓘ says what the number leaves out (workers, GPU), that typed arrays count, and that the limit caps objects only');

        // The reading follows allocations.
        const before = (await panelState(page)).taken;
        const firstUsed = s.used[s.used.length - 1];
        await page.evaluate(() => { window.__hold = new Float64Array(8 * 1048576).fill(1); }); // 64 MB
        await waitTaken(page, before + 2);
        s = await panelState(page);
        const grew = s.used[s.used.length - 1] - firstUsed;
        check(grew > 48 * 1048576, `with --enable-precise-memory-info it follows allocations, typed arrays included (+${Math.round(grew / 1048576)} MB for 64 MB)`);

        // ---- §2 not seen: it stops drawing, keeps reading ----
        await page.click('.panel-section[data-tab="tabMemory"] .panel-section-toggle');
        let h = await whileHidden(page);
        check(!h.drawing && !h.redrawn && h.taken >= 2, `folded, it stops drawing and keeps reading (${h.taken} readings)`, h);
        await page.click('.panel-section[data-tab="tabMemory"] .panel-section-toggle');
        s = await panelState(page);
        check(s.drawing, 'unfolded, it draws again');

        await page.mouse.move(400, 400);
        await page.keyboard.press('i');
        h = await whileHidden(page);
        check(!h.drawing && !h.redrawn && h.taken >= 2, `with the info panel hidden (I), the same (${h.taken} readings)`, h);
        await page.keyboard.press('i');
        s = await panelState(page);
        check(s.drawing, 'shown again, it draws again');
        check(moves(s.path) === 1, 'and the line has no gap where the panel was not seen', s.path.slice(0, 200));

        await page.click('.panel-section[data-tab="tabMemory"] .panel-section-close');
        h = await whileHidden(page);
        check(!h.drawing && !h.redrawn && h.taken >= 2, `closed (✕), the same (${h.taken} readings)`, h);
        await openPanel(page);
        s = await panelState(page);
        check(s.drawing && moves(s.path) === 1, 'reopened, its line runs through the time it was closed');
        await page.click('.panel-section[data-tab="tabMemory"] .panel-section-close');

        const stored = await page.evaluate(() => Object.keys(localStorage));
        check(stored.every(k => !/memory/i.test(k)) && stored.includes('lucidPanelRailSections'),
            `samples are never stored: localStorage holds only the rail's list here (${JSON.stringify(stored)})`);

        // ---- §3 project rows ----
        await page.evaluate(async () => {
            await (await import(new URL('pose/initialization.js', document.baseURI).href)).loadDemoSession();
        });
        await openPanel(page);
        await page.waitForFunction(() => document.getElementById('memorySessions').textContent === '1', null, { timeout: 10000 });
        s = await panelState(page);
        const counts = await page.evaluate(() => {
            const ss = window.__lucid.state.session;
            return { resident: ss.frameGroups.size, groupFrames: ss.instanceGroups.size };
        });
        check(s.resident.startsWith(counts.resident.toLocaleString('en-US') + ' of ') &&
            s.groups === counts.groupFrames.toLocaleString('en-US'),
            `with the demo loaded it counts frames in memory and frames with groups (${s.resident}; ${s.groups})`, counts);
        await context.close();
    }

    // ---- §7 runs are marked on the plot ----
    {
        const { context, page } = await openApp(precise);
        const card = (msg, opts) => page.evaluate(async ([msg, opts]) => {
            const lo = await import(new URL('ui/loading-overlay.js', document.baseURI).href);
            if (msg === null) lo.hideLoading(); else lo.showLoading(msg, opts);
        }, [msg, opts]);
        // With the panel closed: an untitled card.
        await card('Loading SLP files (3/8)...');
        let n = (await panelState(page)).taken;
        await waitTaken(page, n + 3);
        await card(null);
        n = (await panelState(page)).taken;
        await waitTaken(page, n + 2);
        await openPanel(page);
        // With it open: a titled one, holding 64 MB.
        await card('Assigning identities: 5/10 frames…', { title: 'Track All' });
        n = (await panelState(page)).taken;
        await waitTaken(page, n + 1);
        await page.evaluate(() => { window.__runHold = new Float64Array(8 * 1048576).fill(1); });
        await waitTaken(page, n + 3);
        await card(null);
        await page.evaluate(() => { window.__runHold = null; });
        await waitTaken(page, n + 5);
        const runs = await page.evaluate(() => ({
            bands: [...document.querySelectorAll('#memoryRunBands rect')].map(r => ({ w: +r.getAttribute('width'), tip: r.textContent })),
            labels: [...document.querySelectorAll('#memoryRunLabels .memory-run-label')].map(l => ({ text: l.textContent, tip: l.title, w: l.getBoundingClientRect().width })),
            runs: window.__lucidMemoryPanel.samples().map(s => s.run),
        }));
        // The app's own start-up card ("Initializing…") is a run too, before these two.
        const two = runs.bands.slice(-2);
        check(two.length === 2 && /^Loading SLP files · \d+ s · peak [\d,]+ MB$/.test(two[0].tip) &&
            /^Track All · \d+ s · peak [\d,]+ MB$/.test(two[1].tip) && two.every(b => b.w > 0),
            'each run is a shaded band whose tooltip gives its name, length and peak (the one done closed too)', runs.bands);
        const peakMB = +two[1].tip.match(/peak ([\d,]+) MB/)[1].replace(/,/g, '');
        check(peakMB >= 64, `a run's peak is the largest reading inside it (${peakMB} MB with 64 MB held)`);
        // Seconds apart at the plot's right edge, only the newest has room for its name.
        const last = runs.labels[runs.labels.length - 1];
        check(last && last.text === 'Track All' && last.w > 0 && /peak/.test(last.tip),
            'the newest run\'s name runs along the top of the plot', runs.labels);
        check(runs.runs.includes(null) && runs.runs.includes('Track All') && runs.runs.includes('Loading SLP files'),
            'readings note what was running, and nothing when no card is up');
        await context.close();
    }

    // ---- §5 no performance.memory ----
    {
        const { context, page } = await openApp(precise, () => {
            Object.defineProperty(Performance.prototype, 'memory', { get() { return undefined; }, configurable: true });
        });
        await openPanel(page);
        await waitTaken(page, 2);
        const s = await panelState(page);
        check(s.unavailable && !s.plot && s.sessions === '0', 'without performance.memory: "not available", no plot, the project rows still update');
        await context.close();
    }

    // ---- §6 measureUserAgentSpecificMemory where the page is isolated (stubbed) ----
    {
        const { context, page } = await openApp(precise, () => {
            Object.defineProperty(window, 'crossOriginIsolated', { get() { return true; }, configurable: true });
            window.__uaCalls = 0;
            performance.measureUserAgentSpecificMemory = function () {
                window.__uaCalls++;
                return Promise.resolve({
                    bytes: 700 * 1048576,
                    breakdown: [
                        { bytes: 500 * 1048576, attribution: [{ scope: 'Window' }], types: ['JS'] },
                        { bytes: 200 * 1048576, attribution: [{ scope: 'DedicatedWorkerGlobalScope' }], types: ['JS'] },
                    ],
                });
            };
        });
        await waitTaken(page, 3);
        check(await page.evaluate(() => window.__uaCalls) === 0,
            'closed, it never asks for the whole page (Chrome would force a full GC to answer)');
        await openPanel(page);
        await page.waitForFunction(() => document.getElementById('memoryUa').textContent === '700 MB', null, { timeout: 15000 });
        await waitTaken(page, 4);
        const s = await panelState(page);
        const calls = await page.evaluate(() => window.__uaCalls);
        check(s.ua === '700 MB' && s.uaWorkers === '200 MB' && s.uaPath.length > 0 && s.uaLegend,
            'an isolated page shows the whole page and its workers, and a second line named in the legend', s);
        check(calls === 1, `it asks at most every 10 s (${calls} call in ${s.taken} samples)`);
        await context.close();
    }

    // ---- §6b ... and where the browser refuses it ----
    {
        const { context, page } = await openApp(precise, () => {
            Object.defineProperty(window, 'crossOriginIsolated', { get() { return true; }, configurable: true });
            performance.measureUserAgentSpecificMemory = function () {
                return Promise.reject(new DOMException('performance.measureUserAgentSpecificMemory is not available.', 'SecurityError'));
            };
        });
        await openPanel(page);
        await waitTaken(page, 3);
        const s = await panelState(page);
        check(s.ua === null && s.uaWorkers === null && !s.uaLegend && MB_RE.test(s.now),
            'a refused call hides the whole-page rows (never "measuring…" forever); the heap view stays', s);
        await context.close();
    }

    // ---- §4 a rounded reading (older Chrome without the flag) ----
    // Chrome 157 reads live with no flag and Playwright's Chromium 153 rounds,
    // so the rounded values are stubbed: the ones Chromium 153 returned here.
    {
        const { context, page } = await openApp(precise, () => {
            Object.defineProperty(Performance.prototype, 'memory', {
                get() { return { usedJSHeapSize: 35100000, totalJSHeapSize: 37300000, jsHeapSizeLimit: 3760000000 }; },
                configurable: true,
            });
        });
        await openPanel(page);
        await waitTaken(page, 2);
        const s = await panelState(page);
        check(s.coarse && s.now === '33 MB' && s.plot, `a rounded reading is still plotted, and flagged in the panel (${s.now})`, s);
        await context.close();
    }
} catch (e) {
    console.log('  ✗ threw:', e && e.stack || e);
    fails++;
} finally {
    if (precise) await precise.close();
    await server.close();
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
