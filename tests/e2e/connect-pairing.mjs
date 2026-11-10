/**
 * connect-pairing.mjs — the Connect panel's pairing flow against the fake
 * sleap-connect worker (`tests/connect/fake-worker.mjs`, served over the
 * page's WebSocket by Playwright's `routeWebSocket`; no real network).
 *
 *  1. A code that carries an address: live plan line ("Connects over your
 *     network (ws://…)."), Pair → the card shows the connected dot, the node id
 *     line and "Connected via local network".
 *  2. Disconnect → the card offers Connect → Connect reconnects.
 *  3. Rename this device (store `setDeviceName`; sleap-app's panel has no
 *     rename box) reaches the worker (`clients.rename`).
 *  4. Forget asks sleap-app's confirm text, then the card is gone, the worker no
 *     longer lists the device, and a SPENT code is refused with the worker's message.
 *  5. A code with no address: the needs-address message, the address box opens
 *     by itself, typing an address makes it ready and pairing works.
 *  6. A bad code: sleap-app's NOT_A_CODE line; an expired code: the expiry line;
 *     Pair stays disabled for both.
 *  7. Reload keeps the paired worker (localStorage) and the device identity
 *     (IndexedDB `lucid-connect`): Connect re-dials as the SAME device.
 *  8. A worker that unpairs us shows "Unpaired by this worker …" and Connect is
 *     no longer what pairs again (re-pair with a new code works).
 *
 *  9. Relay-only code in the browser ("The web version can only reach workers on
 *     your network or VPN…"; Pair disabled; typing an address enables it), a
 *     legacy JSON ticket pairs, and Cancel resets the form (code, plan, Advanced,
 *     address) like sleap-app's unmount.
 *
 * NOT here: the iroh cases of sleap-app's `pairWorkerFormIroh.test.tsx` (relay
 * code -> iroh route with "Connects directly when it can…", typed address over a
 * relay code -> ws): the web build has no iroh transport; they are in
 * `connect-iroh.mjs` (desktop shim). `planPairing`
 * itself is unit-tested in tests/test-connect-pairing-plan.mjs.
 *
 * Usage: node tests/e2e/connect-pairing.mjs   (PORT= to move its server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeWorker } from '../connect/fake-worker.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT || 9392);
const BASE = `http://localhost:${PORT}`;
const WS = 'ws://127.0.0.1:9631';

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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

    const worker = await FakeWorker.create({ workerInfo: { hostname: 'gpu-box' } });
    await worker.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9631/);

    const open = async () => {
        await page.waitForSelector('.panel-rail-btn[data-tab="tabConnect"]', { timeout: 30000 });
        // showPanelTab semantics: the button toggles, so only click when closed.
        if (!(await page.$('[data-pf="pair"], #connectPairNew')) || !(await page.evaluate(() =>
            (document.querySelector('[data-pf="pair"]') || document.getElementById('connectPairNew')).offsetParent !== null))) {
            await page.click('.panel-rail-btn[data-tab="tabConnect"]');
        }
    };
    const plan = () => page.evaluate(() => {
        const p = document.querySelector('[data-pf="plan"]');
        return p.hidden ? null : { kind: p.dataset.kind, text: p.textContent };
    });
    const cards = () => page.evaluate(() => [...document.querySelectorAll('.connect-worker')].map((c) => ({
        id: c.dataset.nodeId, name: c.querySelector('.connect-worker-name').textContent,
        on: !!c.querySelector('.connect-dot.on'), warn: !!c.querySelector('.connect-dot.warn'),
        text: c.textContent, btn: (c.querySelector('.connect-connect, .connect-disconnect') || {}).textContent,
        btnDisabled: !!(c.querySelector('.connect-connect') || {}).disabled,
    })));
    const typeCode = async (code) => { await page.fill('[data-pf="code"]', code); await page.waitForTimeout(150); };
    const myNodeId = () => page.evaluate(async () => (await import('./pose/connect/identity.js')).getClientIdentity().then((i) => i.nodeId));

    await page.goto(`${BASE}/index.html`);
    await open();

    console.log('\n--- 1. Pair with a code that carries an address ---');
    const code1 = await worker.mintPairCode({ addrs: [WS] });
    await typeCode(code1);
    const p1 = await plan();
    check(p1 && p1.kind === 'ready' && p1.text === `Connects over your network (${WS}).`, 'live plan line', p1);
    check(await page.evaluate(() => !document.querySelector('[data-pf="pair"]').disabled), 'Pair is enabled');
    await page.click('[data-pf="pair"]');
    await page.waitForSelector('.connect-worker .connect-dot.on', { timeout: 15000 });
    let cs = await cards();
    check(cs.length === 1 && cs[0].on, 'one card, connected dot', cs);
    check(/Connected via local network/.test(cs[0].text), '"Connected via local network"', cs[0].text);
    check(cs[0].text.includes(cs[0].id.slice(0, 16) + '…') && cs[0].text.includes(WS), 'node id + address line');
    check(cs[0].btn.trim() === 'Disconnect', 'Disconnect offered');
    check(await page.evaluate(() => document.getElementById('connectPairNew').offsetParent !== null), 'the form gave way to "Pair a new worker"');
    check(await page.evaluate(() => /^Paired workers \(1\)$/.test(document.querySelector('.connect-caps').textContent)), '"Paired workers (1)"');
    const me = await myNodeId();
    check(worker.paired.has(me), 'the worker lists this device as paired');

    console.log('\n--- 2. Disconnect / Connect ---');
    await page.click('.connect-disconnect');
    await page.waitForSelector('.connect-connect', { timeout: 5000 });
    cs = await cards();
    check(!cs[0].on && cs[0].btn.trim() === 'Connect', 'Disconnect → grey dot, Connect offered', cs);
    await page.click('.connect-connect');
    await page.waitForSelector('.connect-disconnect', { timeout: 15000 });
    check((await cards())[0].on, 'Connect → connected again');

    console.log('\n--- 3. Rename this device ---');
    await page.evaluate(() => import('./pose/connect/store.js').then((m) => m.useConnectStore.getState().setDeviceName('Bench laptop')));
    await page.waitForTimeout(500);
    const renamed = worker.calls.filter((c) => c.method === 'clients.rename').pop();
    check(renamed && JSON.stringify(renamed.params).includes('Bench laptop'), 'clients.rename reached the worker', renamed && renamed.params);

    console.log('\n--- 4. Forget (confirm) ---');
    await page.click('.connect-forget');
    await page.waitForFunction(() => !document.querySelector('.connect-worker'), null, { timeout: 10000 });
    check(dialogs.length === 1 && /^.+ is removed from this app, and this device is unpaired on the worker: to use it again you'll need a new code from 'sleap-connect pair'\.\n\nJobs already on the worker keep running\.$/.test(dialogs[0]),
        "sleap-app's confirm text", dialogs[0]);
    check((await cards()).length === 0, 'card gone');
    await page.waitForTimeout(300);
    check(!worker.paired.has(me), 'the worker dropped this device');
    // The first code's secret is spent: pairing with it again is refused with the worker's message.
    await open();
    await page.click('#connectPairNew').catch(() => {});
    await typeCode(code1);
    await page.click('[data-pf="pair"]');
    await page.waitForSelector('[data-pf="error"]:not([hidden])', { timeout: 15000 });
    const spent = await page.evaluate(() => document.querySelector('[data-pf="error"]').textContent);
    check(/already used|invalid/i.test(spent), 'a spent code shows the worker\'s refusal', spent);
    check((await cards()).length === 0, 'and nothing was paired');

    console.log('\n--- 5. A code without an address ---');
    await page.fill('[data-pf="code"]', '');
    const code2 = await worker.mintPairCode({});
    await typeCode(code2);
    const p2 = await plan();
    check(p2 && p2.kind === 'needs-address' && p2.text === "This code doesn't say how to reach the worker. Make sure it's running (sleap-connect serve), then run sleap-connect pair again.",
        'needs-address message', p2);
    check(await page.evaluate(() => document.querySelector('[data-pf="address"]').offsetParent !== null && document.querySelector('[data-pf="advanced"]').hidden),
        'the address box is open, the Advanced toggle gone');
    check(await page.evaluate(() => document.querySelector('[data-pf="pair"]').disabled), 'Pair disabled until an address');
    await page.fill('[data-pf="address"]', WS);
    await page.waitForTimeout(150);
    const p2b = await plan();
    check(p2b && p2b.kind === 'ready' && p2b.text === `Connects to ${WS}.`, 'typing an address makes it ready', p2b);
    await page.click('[data-pf="pair"]');
    await page.waitForSelector('.connect-worker .connect-dot.on', { timeout: 15000 });
    check((await cards()).length === 1, 'paired through the typed address');

    console.log('\n--- 6. Bad and expired codes ---');
    await page.click('#connectPairNew');
    for (const bad of ['hello', 'sleap1notacode']) {
        await typeCode(bad);
        const pb = await plan();
        check(pb && pb.kind === 'error' && pb.text === "That doesn't look like a pairing code. Copy the whole line starting with sleap1.", `"${bad}" → NOT_A_CODE`, pb);
        check(await page.evaluate(() => document.querySelector('[data-pf="pair"]').disabled), '  Pair disabled');
    }
    const expired = await worker.mintPairCode({ addrs: [WS], expiresAt: Math.floor(Date.now() / 1000) - 120 });
    await typeCode(expired);
    const pe = await plan();
    check(pe && pe.kind === 'error' && /^This code expired 2 min ago\. Run sleap-connect pair on the worker for a new one\.$/.test(pe.text), 'expired code', pe);
    check(await page.evaluate(() => !document.querySelector('[data-pf="cancel"]').hidden), 'Cancel is offered now a worker is paired');
    await page.click('[data-pf="cancel"]');
    check(await page.evaluate(() => document.getElementById('connectPairNew').offsetParent !== null), 'Cancel returns to "Pair a new worker"');

    console.log('\n--- 9. Relay-only code, legacy JSON ticket, Cancel resets ---');
    await page.click('#connectPairNew');
    const relayCode = await worker.mintPairCode({ relayUrl: 'https://relay.example.org' });
    await typeCode(relayCode);
    const pr = await plan();
    check(pr && pr.kind === 'needs-address' && /^The web version can only reach workers on your network/.test(pr.text), 'relay-only code: the web version message', pr);
    check(await page.evaluate(() => document.querySelector('[data-pf="pair"]').disabled && document.querySelector('[data-pf="address"]').offsetParent !== null),
        '  Pair disabled, the address box open');
    await page.fill('[data-pf="address"]', WS);
    await page.waitForTimeout(150);
    check((await plan()).kind === 'ready' && await page.evaluate(() => !document.querySelector('[data-pf="pair"]').disabled), '  an address enables Pair');
    await page.click('[data-pf="cancel"]');
    await page.click('#connectPairNew');
    check(await page.evaluate(() => document.querySelector('[data-pf="code"]').value === '' && document.querySelector('[data-pf="address"]').value === ''
        && document.querySelector('[data-pf="plan"]').hidden && document.querySelector('[data-pf="address"]').offsetParent === null
        && document.querySelector('[data-pf="error"]').hidden), 'Cancel then reopen: code, address, plan line, Advanced and error all reset');
    await typeCode(JSON.stringify(worker.mintTicket({ addrs: [WS] })));
    const pj = await plan();
    check(pj && pj.kind === 'ready', 'a legacy JSON ticket is ready', pj);
    await page.click('[data-pf="pair"]');
    await page.waitForSelector('#connectPairNew', { state: 'visible', timeout: 15000 });
    cs = await cards();
    check(cs.length === 1 && cs[0].on, 'the legacy ticket paired (card connected)', cs);

    console.log('\n--- 7. Reload keeps the worker and the device identity ---');
    const nodeBefore = (await cards())[0].id;
    await page.reload();
    await open();
    await page.waitForSelector('.connect-worker', { timeout: 15000 });
    cs = await cards();
    check(cs.length === 1 && cs[0].id === nodeBefore && !cs[0].on && cs[0].btn.trim() === 'Connect', 'the paired worker is back, not connected', cs);
    check(await myNodeId() === me, 'same device identity (IndexedDB)');
    const pairedBefore = worker.paired.size;
    await page.click('.connect-connect');
    await page.waitForSelector('.connect-disconnect', { timeout: 15000 });
    check(worker.paired.size === pairedBefore && worker.paired.has(me), 'reconnected as the same paired device (no re-pair)');

    console.log('\n--- 8. The worker unpairs us ---');
    worker.unpair(me);
    worker.closeAll(4001, 'auth.untrusted');
    await page.waitForFunction(() => /Unpaired by this worker/.test(document.querySelector('.connect-worker') ? document.querySelector('.connect-worker').textContent : ''), null, { timeout: 20000 })
        .then(() => check(true, '"Unpaired by this worker — re-pair with a new code to use it again."'),
              async () => check(false, 'Unpaired by this worker', await cards()));
    cs = await cards();
    check(cs[0] && !cs[0].on, 'and it is no longer connected', cs);
    check(/Unpaired by this worker — re-pair with a new code to use it again\./.test(cs[0].text), 'exact sentence', cs[0].text);
    const code3 = await worker.mintPairCode({ addrs: [WS] });
    await page.click('#connectPairNew');
    await typeCode(code3);
    await page.click('[data-pf="pair"]');
    await page.waitForFunction(() => !/Unpaired by this worker/.test(document.querySelector('.connect-worker').textContent), null, { timeout: 15000 })
        .then(() => check(true, 're-pairing with a new code clears it'), () => check(false, 're-pair clears Unpaired'));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
