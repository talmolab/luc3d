/**
 * isolated-server.mjs — `server.py --isolated`: every response carries COOP
 * `same-origin` + COEP `credentialless`, so the page is cross-origin isolated
 * and the Memory panel (ui/memory-panel.js) can show
 * `measureUserAgentSpecificMemory()`: the whole page, web workers included.
 *
 * What this pins:
 *   §1  The headers are on a page, a module, and an error response; without
 *       the flag there are none (the deployed site sends none either).
 *   §2  The app boots isolated with no page or console error: the CDN scripts
 *       (three.js, mp4box), the importmap modules and the demo all load.
 *   §3  The Memory panel reads the heap live (no rounding note) and shows the
 *       whole page and its workers.
 *
 * Runs in Google Chrome: Playwright's bundled Chromium has neither live reading.
 * Spawns server.py itself (it is what is under test), on a free port.
 *   node tests/e2e/isolated-server.mjs
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './lib/harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PY = process.platform === 'win32' ? 'py' : 'python3';

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra)));
    if (!c) fails++;
};

const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
});

async function startPy(args) {
    const port = await freePort();
    const proc = spawn(PY, ['server.py', String(port), ...args], { cwd: repoRoot, stdio: 'ignore' });
    for (let i = 0; i < 150; i++) {
        try {
            const r = await fetch(`http://localhost:${port}/index.html`);
            await r.arrayBuffer(); // drain, or undici trips an assert when the socket closes
            if (r.ok) return { port, proc };
        } catch { /* not up yet */ }
        await new Promise(r => setTimeout(r, 100));
    }
    proc.kill('SIGTERM');
    throw new Error(`server.py ${args.join(' ')} never came up on port ${port}`);
}

async function headersOf(port, p) {
    const r = await fetch(`http://localhost:${port}/${p}`);
    await r.arrayBuffer();
    return { status: r.status, coop: r.headers.get('cross-origin-opener-policy'), coep: r.headers.get('cross-origin-embedder-policy') };
}

const servers = [];
let browser;
try {
    // ---- §1 headers ----
    const iso = await startPy(['--isolated']);
    servers.push(iso.proc);
    const plain = await startPy([]);
    servers.push(plain.proc);
    for (const p of ['index.html', 'ui/memory-panel.js', 'no-such-file.js']) {
        const h = await headersOf(iso.port, p);
        check(h.coop === 'same-origin' && h.coep === 'credentialless', `--isolated: ${p} (${h.status}) carries COOP same-origin + COEP credentialless`, h);
    }
    const hp = await headersOf(plain.port, 'index.html');
    check(hp.coop === null && hp.coep === null, 'without --isolated: no COOP / COEP', hp);

    // ---- §2 the app boots isolated ----
    // Real Chrome (CI's channel too), NO --enable-precise-memory-info. Playwright's
    // own Chromium (153) rounds performance.memory and refuses
    // measureUserAgentSpecificMemory, isolated or not; Chrome (157) gives both.
    browser = await launchBrowser({ channel: process.env.LUC3D_E2E_CHANNEL || 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
    await page.goto(`http://localhost:${iso.port}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.__lucidMemoryPanel, null, { timeout: 60000 });
    const boot = await page.evaluate(async () => {
        const yaml = await import('yaml').then(m => typeof m.parse === 'function', () => false);
        return { iso: self.crossOriginIsolated, three: !!window.THREE, mp4box: !!window.MP4Box, yaml };
    });
    check(boot.iso && boot.three && boot.mp4box && boot.yaml,
        'the page is cross-origin isolated and the CDN scripts and importmap modules load', boot);
    await page.evaluate(async () => {
        await (await import(new URL('pose/initialization.js', document.baseURI).href)).loadDemoSession();
    });
    const demo = await page.evaluate(() => window.__lucid.state.session && window.__lucid.state.session.frameGroups.size);
    check(demo > 0, `the demo loads isolated (${demo} frames)`);

    // ---- §3 the Memory panel gets live readings ----
    await page.click('#panelRail .panel-rail-btn[data-tab="tabMemory"]');
    await page.waitForFunction(() => window.__lucidMemoryPanel.samplesTaken() >= 2, null, { timeout: 15000 });
    const live = await page.evaluate(() => ({
        coarse: document.getElementById('memoryCoarse').getClientRects().length > 0,
        used: window.__lucidMemoryPanel.samples().map(s => s.used),
    }));
    check(!live.coarse && live.used.some(u => u % 100000 !== 0),
        'the heap reading is live without --enable-precise-memory-info: no rounding note', live);
    // measureUserAgentSpecificMemory waits for a garbage collection (~20 s).
    await page.waitForFunction(() => /^[\d,]+ MB$/.test(document.getElementById('memoryUa').textContent), null, { timeout: 60000 });
    const ua = await page.evaluate(() => ({
        page: document.getElementById('memoryUa').textContent,
        workers: document.getElementById('memoryUaWorkers').textContent,
        line: document.getElementById('memoryUaPath').getAttribute('d'),
    }));
    check(/^[\d,]+ MB$/.test(ua.workers), `the whole page (${ua.page}) and its workers (${ua.workers}) are shown`, ua);
    check(errors.length === 0, 'no page or console error while isolated', errors);
} catch (e) {
    console.log('  ✗ threw:', e && e.stack || e);
    fails++;
} finally {
    if (browser) await browser.close();
    for (const p of servers) p.kill('SIGTERM');
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
