/**
 * connect-hardening.mjs — regressions found stress-testing the Connect rail tab.
 *
 *  1. Forgetting the LAST worker shows the pairing form again (not just "Pair a
 *     new worker" with nothing to pair).
 *  2. A worker paired in ANOTHER tab arrives here: the list shows, the form
 *     gives way (it closes once, as ConnectPanel.tsx; nothing typed is kept); Forget in the other tab empties it.
 *  3. The pairing form: an edit clears the last failure; the inputs are read-only
 *     while pairing; Enter in the address box submits.
 *  4. Keyboard: Connect via Enter keeps focus on the card's action button
 *     through the "Connecting…" repaint.
 *  5. The remembered open/folded state of the Connect panel survives a reload
 *     (it registers after the rail's first repaint, which used to wipe it).
 *  6. A very long worker label/address never widens the panel (375px window).
 *
 * Usage: node tests/e2e/connect-hardening.mjs   (PORT= to move its server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeWorker } from '../connect/fake-worker.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT || 9393);
const BASE = `http://localhost:${PORT}/index.html`;
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
    const worker = await FakeWorker.create({});
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const newPage = async () => {
        const p = await ctx.newPage();
        p.on('pageerror', (e) => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
        p.on('dialog', (d) => d.accept());
        await worker.serveOnPage(p, /^ws:\/\/127\.0\.0\.1:9631/);
        await p.goto(BASE);
        await p.waitForSelector('.panel-rail-btn[data-tab="tabConnect"]', { timeout: 30000 });
        if (!(await p.evaluate(() => { const e = document.getElementById('connectOpenWindow'); return !!e && !!e.offsetParent; }))) {
            await p.click('.panel-rail-btn[data-tab="tabConnect"]');
        }
        await p.waitForSelector('#connectOpenWindow', { state: 'visible' });
        await p.mouse.move(300, 300);
        return p;
    };
    const cardCount = (p) => p.evaluate(() => document.querySelectorAll('.connect-worker').length);
    const pairVia = async (p) => {
        await p.fill('[data-pf="code"]', await worker.mintPairCode({ addrs: [WS] }));
        await p.waitForTimeout(150);
        await p.click('[data-pf="pair"]');
        await p.waitForSelector('.connect-worker .connect-dot.on', { timeout: 15000 });
    };
    const page = await newPage();

    console.log('\n--- 1. Forget the last worker -> the form is back ---');
    await pairVia(page);
    await page.click('.connect-forget');
    await page.waitForFunction(() => !document.querySelector('.connect-worker'), null, { timeout: 10000 });
    check(await page.evaluate(() => !!document.querySelector('[data-pf="pair"]').offsetParent), 'the pairing form shows');
    check(await page.evaluate(() => document.querySelector('[data-pf="cancel"]').hidden), 'with no Cancel (nothing to go back to)');

    console.log('\n--- 3. Pairing form details ---');
    // a failed attempt (a worker that hangs up) sets the failure line; an edit clears it
    await page.unroute(/^ws:\/\/127\.0\.0\.1:9631/).catch(() => {});
    await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9631/, (ws) => { setTimeout(() => ws.close({ code: 1011, reason: 'boom' }), 150); });
    await page.fill('[data-pf="code"]', await worker.mintPairCode({ addrs: [WS] }));
    await page.waitForTimeout(150);
    await page.click('[data-pf="pair"]');
    check(await page.evaluate(() => document.querySelector('[data-pf="code"]').readOnly), 'the code box is read-only while pairing');
    await page.waitForFunction(() => !document.querySelector('[data-pf="error"]').hidden, null, { timeout: 20000 });
    check(true, 'a hung-up pairing shows a failure line');
    await page.fill('[data-pf="code"]', (await page.inputValue('[data-pf="code"]')) + ' ');
    await page.waitForTimeout(100);
    check(await page.evaluate(() => document.querySelector('[data-pf="error"]').hidden), 'editing the code clears it');
    check(await page.evaluate(() => !document.querySelector('[data-pf="code"]').readOnly), 'and the box is editable again');
    await page.unroute(/^ws:\/\/127\.0\.0\.1:9631/);
    await worker.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9631/);

    console.log('\n--- 2. Two tabs ---');
    const page2 = await newPage();
    await page.fill('[data-pf="code"]', await worker.mintPairCode({ addrs: [WS] }));
    await page.waitForTimeout(150);
    await page.click('[data-pf="pair"]');
    await page.waitForSelector('.connect-worker .connect-dot.on', { timeout: 15000 });
    await page2.waitForSelector('.connect-worker', { timeout: 5000 });
    check(await page2.evaluate(() => !document.querySelector('[data-pf="pair"]')?.offsetParent && !!document.getElementById('connectPairNew')?.offsetParent),
        'the other tab shows the list and "Pair a new worker", the form gave way');

    console.log('\n--- 4. Keyboard: Connect via Enter keeps focus ---');
    await page2.focus('.connect-connect');
    await page2.keyboard.press('Enter');
    await page2.waitForSelector('.connect-disconnect', { timeout: 15000 });
    check(await page2.evaluate(() => document.activeElement.classList.contains('connect-disconnect')), 'focus ends on Disconnect', await page2.evaluate(() => document.activeElement.className));
    await page2.keyboard.press('Enter');
    await page2.waitForSelector('.connect-connect:not(:disabled)', { timeout: 5000 });
    check(await page2.evaluate(() => document.activeElement.classList.contains('connect-connect')), 'and back on Connect after Disconnect');

    console.log('\n--- 2b. Forget in one tab empties the other ---');
    await page2.dblclick('.connect-forget');   // a double click asks once
    await page2.waitForFunction(() => !document.querySelector('.connect-worker'), null, { timeout: 10000 });
    await page.waitForFunction(() => !document.querySelector('.connect-worker'), null, { timeout: 5000 })
        .then(() => check(true, 'the first tab lost the worker too'), () => check(false, 'first tab still lists it'));
    check(await page.evaluate(() => !!document.querySelector('[data-pf="pair"]').offsetParent), 'and shows the form');

    console.log('\n--- 5. Open/folded state survives a reload ---');
    await page.evaluate(() => document.querySelector('.panel-section[data-tab="tabConnect"] .panel-section-toggle').click());
    await page.reload();
    await page.waitForSelector('.panel-rail-btn[data-tab="tabConnect"]', { timeout: 30000 });
    await page.waitForTimeout(400);
    const cls = await page.evaluate(() => document.querySelector('.panel-section[data-tab="tabConnect"]').className);
    check(/\bopen\b/.test(cls) && /\bfolded\b/.test(cls), 'Connect is open and folded after reload', cls);
    await page.evaluate(() => document.querySelector('.panel-section[data-tab="tabConnect"] .panel-section-toggle').click());
    await page.reload();
    await page.waitForSelector('.panel-rail-btn[data-tab="tabConnect"]', { timeout: 30000 });
    await page.waitForTimeout(400);
    check(await page.evaluate(() => { const s = document.querySelector('.panel-section[data-tab="tabConnect"]'); return s.classList.contains('open') && !s.classList.contains('folded'); }),
        'unfolded, it stays open and expanded after reload');
    await ctx.close();

    console.log('\n--- 6. A very long label and address at 375px ---');
    const long = 'W'.repeat(200) + ' gpu-server-with-an-extremely-long-hostname';
    const addr = 'ws://' + 'a'.repeat(120) + '.example.org:9631/' + 'b'.repeat(80);
    const narrow = await browser.newContext({ viewport: { width: 375, height: 800 } });
    await narrow.addInitScript(([l, a]) => {
        localStorage.setItem('lucid-connect', JSON.stringify({ state: { pairedWorkers: [{ nodeId: 'n'.repeat(52), label: l, addrs: [a], pairedAt: new Date().toISOString() }], trackedJobs: [], deviceName: null }, version: 0 }));
    }, [long, addr]);
    const np = await narrow.newPage();
    await np.goto(BASE);
    await np.waitForSelector('.panel-rail-btn[data-tab="tabConnect"]', { timeout: 30000 });
    await np.click('.panel-rail-btn[data-tab="tabConnect"]');
    await np.waitForSelector('.connect-worker', { state: 'visible' });
    const w = await np.evaluate(() => ({ panel: document.querySelector('.connect-panel').clientWidth, doc: document.documentElement.scrollWidth, vw: innerWidth }));
    check(w.panel <= 375 && w.doc <= w.vw, 'the panel stays inside the window', w);
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
