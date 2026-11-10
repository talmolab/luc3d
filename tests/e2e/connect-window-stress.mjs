/**
 * connect-window-stress.mjs — regressions found stress-testing the Connect window (P5).
 *
 *  1. Pair A, then pair B: A's still-open managed connection is NOT closed by pairing B (pairWithTicket used to
 *     close the SELECTED worker's client whatever worker it was pairing), so clientFor(A) answers at once.
 *  2. Same with a tracked ACTIVE job on A (disconnect() keeps A's connection alive for it).
 *  3. The rail panel's pairing form and the window's get different element ids (labels still point at their input).
 *  4. Layers: with the in-app ask dialog over the wizard / the job viewer, Esc closes ONLY the ask (each capture
 *     handler used to fire in registration order and close the layer beneath too); then the wizard / viewer, then
 *     the window.
 *  5. Open/close the window 25x (+ the wizard and viewer): no setInterval, document listener, store subscription,
 *     DOM node or worker socket is left behind.
 *  6. A 375px viewport: the window fills it (no 640px card cut off), no horizontal overflow, the jobs pane is
 *     reachable; at the 640x480 minimum Forget is not clipped.
 *  7. View > Connect Window… opens it.
 *
 * Usage: node tests/e2e/connect-window-stress.mjs   (PORT= to move its server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeWorker } from '../connect/fake-worker.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT || 9397);
const BASE = `http://localhost:${PORT}/index.html`;
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
    const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', (e) => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    const A = await FakeWorker.create({ workerInfo: { hostname: 'box-a' } });
    const B = await FakeWorker.create({ workerInfo: { hostname: 'box-b' } });
    await A.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9641/);
    await B.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9642/);
    await page.goto(BASE);
    await page.waitForSelector('.panel-rail-btn[data-tab="tabConnect"]', { timeout: 60000 });
    const pair = async (w, addr) => {
        const code = await w.mintPairCode({ addrs: [addr] });
        await page.evaluate((c) => import('./pose/connect/store.js').then((m) => m.useConnectStore.getState().pairWithCode(c)), code);
    };
    const call = (fn, ...args) => page.evaluate(async ([f, a]) => {
        const s = (await import('./pose/connect/store.js')).useConnectStore.getState();
        try { return { ok: await eval(f)(s, ...a) }; } catch (e) { return { err: String(e.message || e) }; }
    }, [fn.toString(), args]);

    console.log('\n--- 1. pair A then B ---');
    await pair(A, 'ws://127.0.0.1:9641');
    await pair(B, 'ws://127.0.0.1:9642');
    let r = await call((s, id) => s.mountsFor(id).then(() => 'ok'), A.nodeId);
    check(r.ok === 'ok', 'Data access calls on A work right after pairing B', r);
    r = await call((s, id) => s.devicesFor(id).then((d) => d.length), B.nodeId);
    check(r.ok >= 0 && !r.err, 'and on B', r);

    console.log('\n--- 2. A has an active tracked job ---');
    await page.evaluate(() => import('./pose/connect/store.js').then((m) => { const st = m.useConnectStore; st.setState({ selectedWorkerId: null }); }));
    await page.evaluate(async (id) => { const m = await import('./pose/connect/store.js'); await m.useConnectStore.getState().connectToWorker(id); }, A.nodeId);
    await page.evaluate((id) => import('./pose/connect/store.js').then((m) => m.useConnectStore.setState((s) => ({ trackedJobs: [...s.trackedJobs, { jobId: 'job_x', workerId: id, state: 'running', startedAt: Date.now() }] }))), A.nodeId);
    const C = await FakeWorker.create({});
    await C.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9643/);
    await pair(C, 'ws://127.0.0.1:9643');
    r = await call((s, id) => s.devicesFor(id).then(() => 'ok'), A.nodeId);
    check(r.ok === 'ok', 'A (active job, kept alive) still answers after pairing C', r);
    await page.evaluate(() => import('./pose/connect/store.js').then((m) => m.useConnectStore.setState({ trackedJobs: [] })));
    console.log('\n--- 3. unique ids ---');
    await page.evaluate(() => import('./ui/connect/connect-window.js').then((m) => m.openConnectWindow()));
    await page.waitForSelector('#connectWindow');
    await page.evaluate(() => document.getElementById('cwPairWorker').click());
    await page.waitForSelector('.cw-wl [data-pf="code"]');
    await page.click('.panel-rail-btn[data-tab="tabConnect"]').catch(() => {});
    const dup = await page.evaluate(() => {
        const seen = new Map(); document.querySelectorAll('[id]').forEach((e) => seen.set(e.id, (seen.get(e.id) || 0) + 1));
        const forms = document.querySelectorAll('[data-pf="code"]').length;
        const lab = document.querySelector('.cw-wl label[for]'); const target = lab && document.getElementById(lab.htmlFor);
        return { dups: [...seen].filter(([, n]) => n > 1).map(([k]) => k), forms, labelOk: !!target && target.closest('.cw-wl') !== null };
    });
    check(dup.forms >= 1 && dup.dups.length === 0, 'no duplicate ids with the window open', dup);
    check(dup.labelOk, 'the address label points at the window form\'s own input', dup);
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('connectWindow'));

    console.log('\n--- 4. layers ---');
    const has = (sel) => page.evaluate((s) => !!document.querySelector(s), sel);
    const esc = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(150); };
    await page.evaluate(() => { window.lucidDesktop = {}; }); // the in-app ask dialog (the web build asks natively)
    A.addJob({ spec: { type: 'track', data_path: '/data/a.slp', model_paths: ['/data/m'] }, state: 'running', jobId: 'jlog0abcdefgh' });
    await page.evaluate(() => import('./ui/connect/connect-window.js').then((m) => m.openConnectWindow()));
    await page.waitForSelector('#connectWindow');
    const ask = async () => { await page.evaluate(() => { import('./ui/ask.js').then((m) => { m.askConfirm('sure?', { title: 't' }); }); }); await page.waitForSelector('.ask-modal-overlay'); };
    await ask(); await esc();
    check((await has('#connectWindow')) && !(await has('.ask-modal-overlay')), 'ask over the window: Esc closes only the ask');
    await page.evaluate((id) => import('./ui/connect/new-job-wizard.js').then((m) => { m.openNewJobWizard({ workerId: id, workerLabel: 'x' }); }), A.nodeId);
    await page.waitForSelector('.njw-scrim');
    await ask(); await esc();
    check((await has('.njw-scrim')) && (await has('#connectWindow')) && !(await has('.ask-modal-overlay')), 'ask over the wizard: Esc closes only the ask');
    await esc();
    check(!(await has('.njw-scrim')) && (await has('#connectWindow')), 'then Esc closes the wizard, not the window');
    await page.evaluate((id) => import('./ui/connect/job-viewer.js').then((m) => { m.openJobViewer({ workerId: id, jobId: 'jlog0abcdefgh', label: 'L', initialView: 'logs', kind: 'track', canStop: true }); }), A.nodeId);
    await page.waitForSelector('.cj-scrim');
    await page.evaluate(() => { const b = document.querySelector('.cj-cancel'); b.style.display = ''; b.click(); });
    await page.waitForSelector('.ask-modal-overlay'); await esc();
    check((await has('.cj-scrim')) && (await has('#connectWindow')) && !(await has('.ask-modal-overlay')), 'ask over the job viewer: Esc closes only the ask');
    await esc(); await esc();
    check(!(await has('.cj-scrim')) && !(await has('#connectWindow')), 'then the viewer, then the window');
    await page.evaluate(() => { delete window.lucidDesktop; });

    console.log('\n--- 5. leaks ---');
    await page.evaluate(() => {
        window.__iv = new Set();
        const si = window.setInterval, ci = window.clearInterval;
        window.setInterval = function (...a) { const id = si.apply(window, a); window.__iv.add(id); return id; };
        window.clearInterval = function (id) { window.__iv.delete(id); return ci.call(window, id); };
        window.__dl = 0;
        const add = document.addEventListener.bind(document), rem = document.removeEventListener.bind(document);
        const live = new Set(); window.__docLive = live;
        document.addEventListener = (t, f, o) => { live.add(t + (typeof o === 'boolean' ? o : o && o.capture) + f); return add(t, f, o); };
        document.removeEventListener = (t, f, o) => { live.delete(t + (typeof o === 'boolean' ? o : o && o.capture) + f); return rem(t, f, o); };
    });
    const snap = () => page.evaluate(async () => ({ intervals: window.__iv.size, store: (await import('./pose/connect/store.js')).useConnectStore.listenerCount(), doc: window.__docLive.size, nodes: document.getElementsByTagName('*').length }));
    const cycle = async (n) => {
        for (let i = 0; i < n; i++) {
            await page.evaluate(() => import('./ui/connect/connect-window.js').then((m) => m.openConnectWindow()));
            await page.waitForSelector('#connectWindow .cw-main-head');
            await page.evaluate((id) => import('./ui/connect/new-job-wizard.js').then((m) => { m.openNewJobWizard({ workerId: id, workerLabel: 'x' }); }), A.nodeId);
            await page.waitForSelector('.njw-scrim'); await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.njw-scrim'));
            await page.evaluate((id) => import('./ui/connect/job-viewer.js').then((m) => { m.openJobViewer({ workerId: id, jobId: 'jlog0abcdefgh', label: 'L', initialView: 'monitor', kind: 'train', canStop: true }); }), A.nodeId);
            await page.waitForSelector('.cj-scrim'); await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.cj-scrim'));
            await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('connectWindow'));
        }
    };
    await cycle(2); await page.waitForTimeout(1200);
    const b4 = await snap(); const sockB = [A, B].map((w) => w.connections.size);
    await cycle(25); await page.waitForTimeout(1500);
    const af = await snap(); const sockA = [A, B].map((w) => w.connections.size);
    check(JSON.stringify(b4) === JSON.stringify(af), 'no interval / document listener / store subscription / node left after 25 open-close cycles', { b4, af });
    check(JSON.stringify(sockB) === JSON.stringify(sockA), 'no worker socket left behind', { sockB, sockA });

    console.log('\n--- 6. narrow viewports ---');
    const geom = () => page.evaluate(() => {
        const card = document.querySelector('.cw-card').getBoundingClientRect();
        const main = document.querySelector('.cw-main').getBoundingClientRect();
        const f = document.getElementById('cwForget').getBoundingClientRect();
        return { vw: innerWidth, cardW: Math.round(card.width), mainRight: Math.round(main.right), docW: document.documentElement.scrollWidth, forgetRight: Math.round(f.right) };
    });
    await page.setViewportSize({ width: 375, height: 700 });
    await page.evaluate(() => import('./ui/connect/connect-window.js').then((m) => m.openConnectWindow()));
    await page.waitForSelector('#connectWindow .cw-main-head'); await page.waitForTimeout(300);
    let g = await geom();
    check(g.cardW <= g.vw && g.mainRight <= g.vw && g.docW <= g.vw && g.forgetRight <= g.vw, '375px: the window fits, the jobs pane is inside it', g);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 640, height: 480 });
    await page.evaluate(() => import('./ui/connect/connect-window.js').then((m) => m.openConnectWindow()));
    await page.waitForSelector('#connectWindow .cw-main-head'); await page.waitForTimeout(300);
    g = await geom();
    check(g.cardW === 640 && g.forgetRight <= 640, '640x480: two columns, Forget not clipped', g);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1200, height: 800 });

    console.log('\n--- 7. View menu ---');
    await page.evaluate(() => document.getElementById('menuConnectWindow').click());
    await page.waitForSelector('#connectWindow', { timeout: 5000 }).then(() => check(true, 'View > Connect Window… opens the window'), () => check(false, 'View > Connect Window… opens the window'));
    console.log(fails ? `\n${fails} FAILED` : '\nall passed');
} finally {
    await browser?.close();
    server.kill();
}
process.exit(fails ? 1 : 0);
