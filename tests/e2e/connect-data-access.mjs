/**
 * connect-data-access.mjs — the Connect window's Data access tab
 * (`ui/connect/worker-data-access.js`, port of sleap-app WorkerDataAccess.tsx) against the fake worker
 * (`tests/connect/fake-worker.mjs` over the page's WebSocket). Ports tests/unit/workerDataAccess.test.tsx.
 * Mounted in a harness div on the app page (the window shell is another module's).
 *
 *  1. The worker's mounts (path + label) come from fs.mounts; Browse files opens the look-only browser.
 *  2. A worker with no mounts: "No mounts configured." and Browse files disabled.
 *  3. A fetch error is shown, not an empty list.
 *  4. "None yet." without rules; a remembered rule shows BOTH sides, the not-in-a-shared-folder note for a
 *     worker path outside the mounts, and Clear re-renders the list at once (store-driven).
 *  5. refreshToken re-fetches the mounts; update() with another worker re-fetches; destroy() removes the DOM
 *     and stops listening to the store.
 *
 * Usage: node tests/e2e/connect-data-access.mjs   (PORT= to move its server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeWorker } from '../connect/fake-worker.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT || 9394);
const BASE = `http://localhost:${PORT}`;
const WS = 'ws://127.0.0.1:9633';
const WS2 = 'ws://127.0.0.1:9634';

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 600)));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
let browser;
try {
    await new Promise((r) => setTimeout(r, 800));
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', (e) => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    const worker = await FakeWorker.create({ mounts: [{ path: '/root/vast', label: 'lab-data' }, { path: '/data' }], serveFolder: '/data', workerInfo: { hostname: 'gpu-box' } });
    worker.addFile('/root/vast/x.txt', 'x');
    const empty = await FakeWorker.create({ mounts: [], workerInfo: { hostname: 'empty-box' } });
    await worker.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9633/);
    await empty.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9634/);

    await page.goto(`${BASE}/index.html`);
    await page.waitForSelector('.panel-rail-btn[data-tab="tabConnect"]', { timeout: 60000 });
    const pair = async (w, addr) => {
        const code = await w.mintPairCode({ addrs: [addr] });
        await page.evaluate((c) => import('./pose/connect/store.js').then((m) => m.useConnectStore.getState().pairWithCode(c)), code);
    };
    await pair(worker, WS);
    const ID = worker.nodeId;
    const mount = (workerId, token) => page.evaluate(async ([id, t]) => {
        const m = await import('./ui/connect/worker-data-access.js');
        const host = document.createElement('div'); host.id = 'harness'; document.body.appendChild(host);
        window.__cda = m.createWorkerDataAccess(host, { workerId: id, refreshToken: t });
    }, [workerId, token]);
    const unmount = () => page.evaluate(() => { window.__cda.destroy(); document.getElementById('harness').remove(); });
    const text = (sel) => page.evaluate((s) => document.querySelector(s).textContent, sel);

    console.log('\n--- 1. Mounts ---');
    await mount(ID, 0);
    await page.waitForFunction(() => document.querySelectorAll('#cdaMounts .cda-mount').length === 2).catch(async (e) => { console.log(await page.evaluate(() => document.getElementById('harness').innerText)); throw e; });
    const rows = await page.evaluate(() => [...document.querySelectorAll('#cdaMounts .cda-mount')].map((r) => r.textContent));
    check(rows[0] === '/root/vastlab-data' && rows[1] === '/data', 'the worker\'s mounts, with the label beside its path', rows);
    check(/Folders this worker shares \(where it was started, plus sleap-connect add-folder\)/.test(await text('#connectDataAccess')), 'section caption');
    check(/Remembered locations — learned when you use "Locate on worker…"/.test(await text('#connectDataAccess')), 'rules caption');
    check(await page.evaluate(() => !document.getElementById('cdaBrowse').disabled), 'Browse files is enabled');
    await page.click('#cdaBrowse');
    await page.waitForSelector('#remoteFileBrowser .rfb-entry, #remoteFileBrowser .rfb-empty');
    const brow = await page.evaluate(() => ({ sidebar: [...document.querySelectorAll('#remoteFileBrowser .rfb-side-item')].map((e) => e.textContent), primary: !!document.querySelector('#remoteFileBrowser .rfb-btn-primary') && document.querySelector('#remoteFileBrowser .rfb-btn-primary').textContent }));
    check(brow.sidebar.some((t) => /lab-data/.test(t)), 'Browse files opens the worker file browser with the labelled mount', brow);
    check(brow.primary === 'Close', 'in browse mode its action is Close', brow.primary);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('remoteFileBrowser'));
    check(true, 'Esc closes it');

    console.log('\n--- 4. Remembered locations ---');
    check(await text('#cdaRules') === 'None yet.', '"None yet." without rules');
    await page.evaluate(([id]) => import('./pose/connect/store.js').then((m) => {
        const st = m.useConnectStore.getState();
        st.addPathRule(id, { local: '/Volumes/talmo', worker: '/root/vast' });
        st.addPathRule(id, { local: '/Users/me/vids', worker: '/elsewhere/vids' });
    }), [ID]);
    await page.waitForFunction(() => document.querySelectorAll('#cdaRules .cda-rule').length === 2);
    const rules = await page.evaluate(() => [...document.querySelectorAll('#cdaRules .cda-rule')].map((r) => ({ t: r.textContent, warn: !!r.querySelector('.cda-warn') })));
    check(/This computer\/Volumes\/talmo/.test(rules[0].t) && /Worker\/root\/vast/.test(rules[0].t), 'both sides shown in full, each on its own line', rules[0]);
    check(!rules[0].warn, 'a rule inside a shared folder has no note');
    check(rules[1].warn && /Not in a shared folder: fine for videos; labels, configs or models there are refused\./.test(rules[1].t), 'a worker path outside the shared folders is flagged', rules[1]);
    await page.click('#cdaRules .cda-rule:nth-child(2) .cda-clear');
    await page.waitForFunction(() => document.querySelectorAll('#cdaRules .cda-rule').length === 1);
    check(true, 'Clear removes that rule at once');
    const left = await page.evaluate(([id]) => import('./pose/connect/store.js').then((m) => m.pathRulesFor(id)), [ID]);
    check(left.length === 1 && left[0].local === '/Volumes/talmo', 'the store kept the other rule', left);
    await page.click('#cdaRules .cda-clear');
    await page.waitForFunction(() => document.getElementById('cdaRules').textContent === 'None yet.');
    check(true, 'Clearing the last rule shows "None yet."');

    console.log('\n--- 5. refreshToken / update / destroy ---');
    const before = worker.calls.filter((c) => c.method === 'fs.mounts').length;
    await unmount();
    await mount(ID, 0);
    await page.waitForFunction(() => document.querySelectorAll('#cdaMounts .cda-mount').length === 2);
    const n0 = worker.calls.filter((c) => c.method === 'fs.mounts').length;
    await page.evaluate((id) => window.__cda.update({ workerId: id, refreshToken: 1 }), ID);
    await page.waitForFunction(() => document.querySelectorAll('#cdaMounts .cda-mount').length === 2);
    await page.waitForTimeout(200);
    check(worker.calls.filter((c) => c.method === 'fs.mounts').length > n0, 'a bumped refreshToken re-fetches the mounts', [before, n0]);
    const n1 = worker.calls.filter((c) => c.method === 'fs.mounts').length;
    await page.evaluate((id) => window.__cda.update({ workerId: id, refreshToken: 1 }), ID);
    await page.waitForTimeout(200);
    check(worker.calls.filter((c) => c.method === 'fs.mounts').length === n1, 'the same props do not re-fetch');

    console.log('\n--- 2. A worker with no mounts ---');
    await pair(empty, WS2);
    await page.evaluate((id) => window.__cda.update({ workerId: id, refreshToken: 1 }), empty.nodeId);
    await page.waitForFunction(() => document.getElementById('cdaMounts').textContent === 'No mounts configured.');
    check(await page.evaluate(() => document.getElementById('cdaBrowse').disabled), '"No mounts configured." and Browse files disabled');

    console.log('\n--- 3. A fetch error ---');
    await page.evaluate(() => window.__cda.update({ workerId: 'no-such-worker', refreshToken: 1 }));
    await page.waitForFunction(() => !document.getElementById('cdaError').hidden && document.getElementById('cdaError').textContent.length > 0);
    check(await page.evaluate(() => !document.getElementById('cdaError').hidden && document.getElementById('cdaMounts').textContent === 'No mounts configured.'), 'the error is shown (not a silent empty list)', await text('#cdaError'));

    console.log('\n--- destroy ---');
    await page.evaluate(() => { window.__cda.destroy(); });
    check(await page.evaluate(() => !document.getElementById('connectDataAccess')), 'destroy removes its DOM');
    const noThrow = await page.evaluate(() => import('./pose/connect/store.js').then((m) => { try { m.useConnectStore.getState().addPathRule('no-such-worker', { local: '/a', worker: '/b' }); return true; } catch (e) { return String(e); } }));
    check(noThrow === true, 'a store change after destroy is harmless', noThrow);
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\nFAIL — ${fails} check(s) failed` : '\nPASS');
process.exit(fails ? 1 : 0);
