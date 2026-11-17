/**
 * memory-panel.mjs — the Memory panel (`#tabMemory`, ui/memory-panel.js): the
 * page's JavaScript heap over time, reached from the right-edge panel rail.
 *
 * What this pins:
 *   §1  Nothing samples until the panel is on screen. Opened from the rail it
 *       samples once a second: the plot gets a line, the reading is a
 *       `[\d,]+ MB` number, the heap limit is a reference line, and with
 *       `--enable-precise-memory-info` the reading follows allocations. The ⓘ
 *       says what the number leaves out (workers, GPU process).
 *   §2  Sampling STOPS when the panel is folded, when the info panel is hidden
 *       (`I`), and when the panel is closed (✕), and starts again when it
 *       comes back. The samples stay in memory only: nothing in localStorage
 *       but the rail's own open/folded list.
 *   §3  The project rows count frames in memory and frames with groups (demo).
 *   §4  A rounded reading (older Chrome without the flag; stubbed, since
 *       Chrome 157 reads live) is flagged in the panel.
 *   §5  No `performance.memory` (Firefox, Safari): a "not available" line,
 *       no plot; the project rows still work.
 *   §6  A cross-origin-isolated page with `measureUserAgentSpecificMemory`
 *       (stubbed here; LUCID sends no COOP/COEP) shows the whole page and its
 *       workers as rows and a second line; where the browser refuses the call
 *       (Playwright's Chromium does), the rows go away.
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
/** Wait 2.5 sample periods and report how many samples arrived meanwhile. */
const takenOver = async (page) => {
    const a = (await panelState(page)).taken;
    await page.waitForTimeout(2500);
    return (await panelState(page)).taken - a;
};
const MB_RE = /^[\d,]+ MB$/;

let precise;
try {
    precise = await launchBrowser({ args: ['--enable-precise-memory-info'] });

    // ---- §1 sampling while on screen ----
    {
        const { context, page } = await openApp(precise);
        let s = await panelState(page);
        check(!s.sampling && s.taken === 0, 'nothing samples before the panel is opened');
        await openPanel(page);
        await waitTaken(page, 3);
        s = await panelState(page);
        check(s.sampling && s.plot && MB_RE.test(s.now) && /^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+)+$/.test(s.path),
            `opened from the rail it samples once a second and draws a line (${s.now})`, s);
        check(s.limitShown && MB_RE.test(s.limit), `the heap limit is a reference line (${s.limit})`);
        check(!s.coarse && !s.unavailable && s.ua === null && !s.uaLegend,
            'a live reading: no rounding note, no "not available", no whole-page rows on a non-isolated page');
        check(/workers/.test(s.tip) && /GPU/.test(s.tip) && /typed arrays/.test(s.tip),
            'the ⓘ says what the number leaves out (workers, GPU) and that typed arrays count');

        // The reading follows allocations.
        const before = (await panelState(page)).taken;
        const firstUsed = s.used[s.used.length - 1];
        await page.evaluate(() => { window.__hold = new Float64Array(8 * 1048576).fill(1); }); // 64 MB
        await waitTaken(page, before + 2);
        s = await panelState(page);
        const grew = s.used[s.used.length - 1] - firstUsed;
        check(grew > 48 * 1048576, `with --enable-precise-memory-info it follows allocations, typed arrays included (+${Math.round(grew / 1048576)} MB for 64 MB)`);

        // ---- §2 sampling stops when the panel is not seen ----
        await page.click('.panel-section[data-tab="tabMemory"] .panel-section-toggle');
        s = await panelState(page);
        check(!s.sampling, 'folding the panel stops the timer');
        check(await takenOver(page) === 0, 'and no sample arrives while it is folded');
        await page.click('.panel-section[data-tab="tabMemory"] .panel-section-toggle');
        s = await panelState(page);
        check(s.sampling && await takenOver(page) >= 1, 'unfolding starts it again');

        await page.mouse.move(400, 400);
        await page.keyboard.press('i');
        s = await panelState(page);
        check(!s.sampling && await takenOver(page) === 0, 'hiding the info panel (I) stops it');
        await page.keyboard.press('i');
        s = await panelState(page);
        check(s.sampling && await takenOver(page) >= 1, 'showing it again starts it again');
        const path = (await panelState(page)).path;
        check((path.match(/M/g) || []).length >= 2, 'the time it was not sampled is a gap in the line');

        await page.click('.panel-section[data-tab="tabMemory"] .panel-section-close');
        s = await panelState(page);
        check(!s.sampling && await takenOver(page) === 0, 'closing the panel (✕) stops it');

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
