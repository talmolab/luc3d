/**
 * connect-window.mjs — the Connect window shell, worker list, sidebar queue and devices popover against two
 * fake sleap-connect workers (`tests/connect/fake-worker.mjs`, served over the page's WebSocket; no network).
 * Ports the render assertions of sleap-app's connectDialog / workerList / workerQueue unit tests:
 *
 *  1. Open (Connect panel button, View > Connect Window): the header, the description, Refresh, the two
 *     paired workers with live specs, Idle / Busy chip counts, "Pair a worker" form, resizable card.
 *  2. The window's pick is local: clicking another worker never changes the store's `selectedWorkerId`;
 *     the default pick is the backend worker; the filter chips filter.
 *  3. Sidebar queue: failed (red, mine) -> running -> queued by place, another project's run marked
 *     "from …", the "After training" row, "N runs"; clicking a failed run clears it (kept in localStorage)
 *     and opens the Jobs tab; right-click menus (Stop Early / Cancel run with confirm text, View only);
 *     Esc closes only the menu.
 *  4. Devices: "N device(s) with access", the popover, rename this device (Esc closes only the editor, then
 *     only the popover), the worker saw clients.rename.
 *  5. Forget from the header (confirm) re-picks; with none left the empty states show.
 *  6. An unpaired worker: "Unpaired", sleap-app's note, Re-pair opens the form.
 *  7. Esc closes the window, idle connections are released, focus returns, Tab stays in the card.
 *  8. Window Refresh refetches (info, Jobs list + queue, Devices -> "Devices…" meanwhile); a progress card and a
 *     toast show above the window / the wizard; an unpaired worker's panes show the error line (section 5).
 *  9. A worker that answers with a new identity: "has a new identity", Re-pair forgets the old entry.
 *
 * Stress regressions (own page; were connect-window-stress.mjs):
 * S1. Pair A, then pair B: A's still-open managed connection is NOT closed by pairing B (pairWithTicket used to
 *     close the SELECTED worker's client whatever worker it was pairing), so clientFor(A) answers at once.
 * S2. Same with a tracked ACTIVE job on A (disconnect() keeps A's connection alive for it).
 * S3. The rail panel's pairing form and the window's get different element ids (labels still point at their input).
 * S4. Layers: with the in-app ask dialog over the wizard / the job viewer, Esc closes ONLY the ask (each capture
 *     handler used to fire in registration order and close the layer beneath too); then the wizard / viewer, then
 *     the window.
 * S5. Open/close the window 25x (+ the wizard and viewer): no setInterval, document listener, store subscription,
 *     DOM node or worker socket is left behind.
 * S6. A 375px viewport: the window fills it (no 640px card cut off), no horizontal overflow, the jobs pane is
 *     reachable; at the 640x480 minimum Forget is not clipped.
 * S7. View > Connect Window… opens it.
 *
 * Usage: node tests/e2e/connect-window.mjs   (PORT= to move its server)
 */
import { FakeWorker } from '../connect/fake-worker.mjs';
import { runConnectE2E, check, watchPage, bootApp, pair, store } from './fixtures/connect-e2e.mjs';

const WS_A = 'ws://127.0.0.1:9731';
const WS_B = 'ws://127.0.0.1:9732';

await runConnectE2E(9393, async ({ browser, BASE }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    watchPage(page);
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

    const A = await FakeWorker.create({ workerInfo: { hostname: 'alpha-box' } });
    const B = await FakeWorker.create({ workerInfo: { hostname: 'beta-box' } });
    await A.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9731/);
    await B.serveOnPage(page, /^ws:\/\/127\.0\.0.1:9732/);

    await bootApp(page, BASE);

    const S = (fn, arg) => store(page, fn, arg);
    const myProjectId = await page.evaluate(async () => (await import('./pose/connect/project-tag.js')).lucidProjectTag({}).id);

    // Seed: A has a failed + running + queued run of this project and another project's queued run.
    const mine = { id: myProjectId, name: 'untitled.slp' };
    A.addJob({ jobId: 'fail1', state: 'failed', error: 'boom\nsecond line', project: mine,
        spec: { type: 'train', model_types: ['centroid'], labels_path: '/data/a.slp', run: { id: 'R-fail', index: 0 } } });
    A.addJob({ jobId: 'run1', state: 'running', project: mine,
        spec: { type: 'train', model_types: ['centroid'], labels_path: '/data/a.slp', post_inference: true, run: { id: 'R-run', index: 0 } } });
    A.addJob({ jobId: 'q1', state: 'queued', project: mine,
        spec: { type: 'train', model_types: ['centered_instance'], labels_path: '/data/b.slp', run: { id: 'R-q1', index: 0 } } });
    A.addJob({ jobId: 'q2', state: 'queued', project: { id: 'zzzz9999', name: 'other.slp' },
        spec: { type: 'train', model_types: ['bottomup'], labels_path: '/data/c.slp', run: { id: 'R-q2', index: 0 } } });

    // Pair both through the store, then let the first one be the app's backend.
    const codeA = await A.mintPairCode({ addrs: [WS_A] });
    const codeB = await B.mintPairCode({ addrs: [WS_B] });
    await S((s, c) => s.pairWithCode(c), codeA);
    await S((s, c) => s.pairWithCode(c), codeB);
    const workers = await S((s) => s.pairedWorkers.map((w) => ({ id: w.nodeId, label: w.label })));
    check(workers.length === 2, 'two workers paired', workers);
    const [wa, wb] = workers;
    await S((s, id) => s.selectWorker(id), wa.id).catch(() => {});
    const backendBefore = await S((s) => s.selectedWorkerId);

    const win = () => page.$('#connectWindow');
    const text = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
    const cards = () => page.evaluate(() => [...document.querySelectorAll('.cw-wcard')].map((c) => ({
        id: c.dataset.nodeId, text: c.textContent, selected: c.classList.contains('selected'),
        dot: (c.querySelector('.cw-dot') || {}).className })));
    const chips = () => page.evaluate(() => [...document.querySelectorAll('.cw-chip')].map((c) => c.textContent));
    const queue = () => page.evaluate(() => [...document.querySelectorAll('.cw-qcard')].map((c) => ({
        key: c.dataset.runKey, status: c.dataset.status,
        mark: c.querySelector('.cw-qmark').textContent, title: c.querySelector('.cw-qtitle').textContent,
        sub: c.querySelector('.cw-qsub').textContent, mine: !!c.querySelector('.cw-qstar'),
        rows: [...c.querySelectorAll('.cw-qrow')].map((r) => r.querySelector('.cw-qrow-title').textContent + '|' + r.querySelector('.cw-chip-badge').textContent),
        fail: (c.querySelector('.cw-qfail') || {}).textContent })));
    const menuItems = () => page.evaluate(() => [...document.querySelectorAll('.cw-menu-item')].map((b) => ({ t: b.textContent, disabled: b.disabled })));

    console.log('\n--- 1. Open the window ---');
    await page.click('.panel-rail-btn[data-tab="tabConnect"]');
    await page.waitForSelector('#connectOpenWindow', { timeout: 5000 });
    await page.click('#connectOpenWindow');
    await page.waitForSelector('#connectWindow', { timeout: 15000 });
    check(await text('#cwTitle') === 'Connect' && await text('#cwDesc') === 'Your workers and the jobs on them', 'header: Connect + description');
    check((await text('#cwRefresh')).trim() === 'Refresh' && !!(await page.$('#cwClose[aria-label="Close"]')), 'Refresh and the close button');
    const geo = await page.evaluate(() => { const c = document.querySelector('.cw-card'); const r = c.getBoundingClientRect();
        return { w: r.width, h: r.height, resize: getComputedStyle(c).resize, side: document.querySelector('.cw-side').getBoundingClientRect().width,
            sideTopH: document.querySelector('.cw-side-top').getBoundingClientRect().height, sideH: document.querySelector('.cw-side').getBoundingClientRect().height,
            scrim: !!document.querySelector('#connectWindow[data-shortcut-modal]') }; });
    check(Math.abs(geo.w - 1440 * 0.92) < 2 && Math.abs(geo.h - 900 * 0.9) < 2 && geo.resize === 'both', '92vw x 90vh and resizable', geo);
    check(geo.side === 320 && Math.abs(geo.sideTopH / geo.sideH - 0.45) < 0.02 && geo.scrim, '320px sidebar, workers on top 45%, data-shortcut-modal', geo);
    check(/^Paired workers \(2\)$/.test(await text('.cw-wl .connect-caps')), '"Paired workers (2)"');
    await page.waitForFunction(() => document.querySelectorAll('.cw-wcard-specs').length === 2, null, { timeout: 15000 });
    let cs = await cards();
    check(cs.length === 2 && cs.every((c) => /NVIDIA Fake GPU · 24 GB ×1 · CUDA 12\.4 · sleap-nn 0\.0\.0-fake/.test(c.text)), 'each card has its specs line', cs.map((c) => c.text));
    const byId = (id) => cs.find((c) => c.id === id);
    check(/Busy/.test(byId(wa.id).text) && /Idle/.test(byId(wb.id).text), 'A is Busy (running job), B Idle', cs.map((c) => c.text));
    check(/via /.test(byId(wa.id).text), 'connected cards show "via …"');
    check(JSON.stringify(await chips()) === JSON.stringify(['All (2)', 'Idle (1)', 'Busy (1)', 'Offline (0)']), 'filter chips with counts', await chips());
    check(cs.find((c) => c.selected).id === backendBefore, "the default pick is the app's backend worker", { backendBefore, cs });
    check(await text('#cwWorkerName') === wa.label, 'right side shows the picked worker', await text('#cwWorkerName'));
    check((await page.$$eval('.cw-tab', (b) => b.map((x) => x.textContent))).join() === 'Jobs,Data access' && await page.$eval('#cwTab-jobs', (b) => b.classList.contains('on')), 'Jobs / Data access tabs, Jobs on');
    check(!!(await page.$('#cwForget')) && /with access|Devices/.test(await text('#cwDevicesBtn')), 'Forget and the Devices button');
    check(await page.evaluate(() => !!document.querySelector('#cwContent').children.length), 'the Jobs tab component mounted');

    console.log('\n--- 2. The pick is local; filters ---');
    await page.click(`.cw-wcard[data-node-id="${wb.id}"]`);
    check(await text('#cwWorkerName') === wb.label, 'clicking B shows B');
    check(await S((s) => s.selectedWorkerId) === backendBefore, "the store's selectedWorkerId did not change");
    check(await page.$eval('#cwQueueError', (e) => e.hidden) && /Queue on/.test(await text('.cw-sq-title')) && (await text('.cw-sq-title')).includes(wb.label), 'queue header follows the pick');
    check((await text('.cw-queue-empty')) === 'Nothing running or queued.', 'B: "Nothing running or queued."');
    await page.click('.cw-chip[data-filter="busy"]');
    cs = await cards();
    check(cs.length === 1 && cs[0].id === wa.id, 'Busy chip shows only A', cs.map((c) => c.id));
    await page.click('.cw-chip[data-filter="offline"]');
    check((await cards()).length === 0, 'Offline chip shows none');
    await page.click('.cw-chip[data-filter="all"]');
    await page.click(`.cw-wcard[data-node-id="${wa.id}"]`);

    console.log('\n--- 3. Sidebar queue ---');
    await page.waitForSelector('.cw-qcard', { timeout: 10000 });
    let q = await queue();
    check(q.map((e) => e.status).join() === 'failed,running,queued,queued', 'failed, running, then queued', q.map((e) => e.status));
    check(q.map((e) => e.mark).join() === '✕,▶,#1,#2', 'markers ✕ ▶ #1 #2', q.map((e) => e.mark));
    check(q.map((e) => e.mine).join() === 'true,true,true,false', 'a star on this project\'s runs only', q.map((e) => e.mine));
    check(q[3].sub === 'c.slp · from other.slp', "another project's run: 'from other.slp'", q[3].sub);
    check(q[0].fail === 'boom', 'failed run shows its first error line', q[0].fail);
    check(JSON.stringify(q[1].rows) === JSON.stringify(['centroid|Running', 'Inference|After training']), 'the "After training" row', q[1].rows);
    check(q[2].rows[0] === 'centered_instance|Queued · #1', 'queued row chip', q[2].rows);
    check(await text('.cw-sq-count') === '4 runs', '"4 runs"');

    // Right-click menus
    await page.click('.cw-qcard[data-status="running"]', { button: 'right' });
    let mi = await menuItems();
    check(JSON.stringify(mi.map((m) => m.t)) === JSON.stringify(['Open in Jobs', 'Stop Early (centroid)', 'Cancel run']), 'running run: Open / Stop Early / Cancel run', mi);
    await page.keyboard.press('Escape');
    check((await menuItems()).length === 0 && !!(await win()), 'Esc closes only the menu');
    await page.click('.cw-qcard[data-run-key="R-q2"]', { button: 'right' });
    mi = await menuItems();
    check(mi.length === 2 && mi[1].t === "View only (another project's run)" && mi[1].disabled, "another project's run: View only", mi);
    await page.keyboard.press('Escape');
    await page.click('.cw-qcard[data-status="failed"]', { button: 'right' });
    check(JSON.stringify((await menuItems()).map((m) => m.t)) === JSON.stringify(['Open in Jobs and clear']), 'failed run: only "Open in Jobs and clear"', await menuItems());
    await page.keyboard.press('Escape');

    dialogs.length = 0;
    await page.click('.cw-qcard[data-run-key="R-q1"]', { button: 'right' });
    await page.click('.cw-menu-item.destructive');
    await page.waitForFunction(() => true);
    await page.waitForTimeout(400);
    check(dialogs.length === 1 && dialogs[0] === 'Train centered_instance\n\nEvery unfinished job of this run ends now; queued ones won\'t run. Jobs behind it in the queue start next.',
        "Cancel run asks sleap-app's text", dialogs[0]);
    await page.waitForTimeout(500);
    check(A.calls.some((c) => c.method === 'jobs.cancel' && c.params.job_id === 'q1'), 'the worker got jobs.cancel for the run');
    q = await queue();
    check(!q.some((e) => e.key === 'R-q1' && e.status === 'queued'), 'the cancelled run left the queue', q.map((e) => e.key + ':' + e.status));

    dialogs.length = 0;
    await page.click('.cw-qcard[data-status="running"]', { button: 'right' });
    await page.click('.cw-menu-item:has-text("Stop Early")');
    await page.waitForTimeout(400);
    check(dialogs.length === 1 && dialogs[0] === '"Train centroid" finishes its current batch and keeps the model trained so far.', 'Stop Early asks sleap-app\'s text', dialogs[0]);
    check(A.calls.some((c) => c.method === 'jobs.cancel' && c.params.job_id === 'run1' && /stop/.test(JSON.stringify(c.params))), 'jobs.cancel with mode stop');

    await page.click('.cw-qcard[data-status="failed"]');
    await page.waitForTimeout(200);
    q = await queue();
    check(!q.some((e) => e.status === 'failed'), 'clicking the failed run clears it from the queue');
    check(await page.evaluate(() => (localStorage.getItem('lucid-connect-dismissed-failed-runs') || '').includes('R-fail')), 'cleared run kept in localStorage');
    check(await page.$eval('#cwTab-jobs', (b) => b.classList.contains('on')), 'and the Jobs tab is showing');

    console.log('\n--- 4. Devices ---');
    await page.waitForFunction(() => /^1 device with access$/.test(document.querySelector('#cwDevicesBtn').textContent), null, { timeout: 8000 });
    check(true, '"1 device with access"');
    await page.click('#cwDevicesBtn');
    await page.waitForSelector('.cw-popover .cw-dev');
    check((await text('.cw-pop-title')).includes('Devices with access to ' + wa.label), 'popover title names the worker', await text('.cw-pop-title'));
    check(await page.evaluate(() => document.activeElement === document.querySelector('.cw-popover')), 'opening the popover moves focus into it (Radix)');
    check(!!(await page.$('.cw-dev-you')) && /This device/.test(await text('.cw-dev-you')), '"This device" badge');
    check(/Browser · LUC3D /.test(await text('.cw-dev-sub')), 'row says Browser · LUC3D <version>', await text('.cw-dev-sub'));
    check(/sleap-connect clients/.test(await text('.cw-pop-foot')), 'footer points at `sleap-connect clients`');
    await page.click('[aria-label="Rename this device"]');
    await page.keyboard.press('Escape');
    check(!!(await page.$('.cw-popover')) && !(await page.$('.cw-dev-input')), 'Esc in the rename box closes only the box');
    await page.click('[aria-label="Rename this device"]');
    await page.fill('.cw-dev-input', 'Bench laptop');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    const rn = A.calls.filter((c) => c.method === 'clients.rename').pop();
    check(rn && JSON.stringify(rn.params).includes('Bench laptop'), 'clients.rename reached the worker', rn && rn.params);
    check((await text('.cw-dev-name')) === 'Bench laptop', 'the list shows the new name');
    await page.keyboard.press('Escape');
    check(!(await page.$('.cw-popover')) && !!(await win()), 'Esc closes the popover, not the window');

    console.log('\n--- 5. Unpaired worker ---');
    const me = await page.evaluate(async () => (await (await import('./pose/connect/identity.js')).getClientIdentity()).nodeId);
    B.unpair(me);
    await page.click('#cwRefresh');
    await page.waitForFunction(() => /Unpaired/.test(document.body.textContent) && document.querySelector('.cw-wl-note'), null, { timeout: 15000 }).catch(() => {});
    const note = await page.evaluate(() => (document.querySelector('.cw-wl-note') || {}).textContent || null);
    check(note && note.startsWith(`This device was unpaired by ${wb.label}. Ask for a new code (sleap-connect pair) to use it again.`), "sleap-app's unpaired note", note);
    // The picked worker's panes (sleap-app: the list calls fail with the unpaired message, shown as a red line;
    // the queue shows only that line, the Jobs tab keeps its list under it): no silent stale data.
    await page.click(`.cw-wcard[data-node-id="${wb.id}"]`);
    await page.waitForFunction(() => { const e = document.querySelector('#cwContent .cj-jobs-err'); const q = document.querySelector('#cwQueueError'); return e && e.style.display !== 'none' && /unpaired/i.test(e.textContent) && q && !q.hidden && /unpaired/i.test(q.textContent); }, null, { timeout: 15000 }).catch(() => {});
    check(await page.evaluate(() => { const e = document.querySelector('#cwContent .cj-jobs-err'); return !!e && e.style.display !== 'none' && /unpaired/i.test(e.textContent); }), 'an unpaired worker: the Jobs tab shows the unpaired error line', await page.evaluate(() => (document.querySelector('#cwContent .cj-jobs-err') || {}).textContent));
    check(await page.evaluate(() => { const q = document.querySelector('#cwQueueError'); return !!q && !q.hidden && /unpaired/i.test(q.textContent) && document.querySelector('.cw-side-queue .cw-qcard') === null; }), 'and the queue shows the error line instead of stale cards');
    await page.click(`.cw-wcard[data-node-id="${wa.id}"]`);
    await page.click('.cw-wl-note .cw-btn-xxs:has-text("Re-pair")');
    check(!!(await page.$('.cw-wl [data-pf="code"]')), 'Re-pair opens the pairing form');
    await page.fill('.cw-wl [data-pf="code"]', 'half typed');
    await page.waitForTimeout(100);
    await page.click('#cwRefresh');
    await page.waitForTimeout(500);
    check(await page.inputValue('.cw-wl [data-pf="code"]') === 'half typed', 'what is typed survives a repaint');

    console.log('\n--- 6. Forget ---');
    dialogs.length = 0;
    await page.click(`.cw-wcard[data-node-id="${wb.id}"]`);
    await page.click('#cwForget');
    await page.waitForFunction((id) => !document.querySelector(`.cw-wcard[data-node-id="${id}"]`), wb.id, { timeout: 10000 });
    check(dialogs.length === 1 && /^.+ is removed from this app\. It already unpaired this device\.$|Remove .+ from this app\? It already unpaired this device\.$/.test(dialogs[0]), 'Forget confirm (already-unpaired variant)', dialogs[0]);
    check(await text('#cwWorkerName') === wa.label, 'the pick moved to the remaining worker');
    dialogs.length = 0;
    await page.click('#cwForget');
    await page.waitForSelector('#cwEmpty:not([hidden])', { timeout: 10000 });
    check(dialogs.length === 1 && /unpaired on the worker/.test(dialogs[0]), 'Forget confirm (unpair variant)', dialogs[0]);
    check(await text('#cwEmpty') === 'Pair a worker to see its jobs here.', 'empty state: "Pair a worker to see its jobs here."');
    check(/No workers paired yet\. On the machine you want to train\/infer on, in your data folder:/.test(await text('#cwNoWorkers')) && /sleap-connect serve/.test(await text('#cwNoWorkers')), 'worker list empty state');
    check(!(await page.$('.cw-sq')) || await page.$eval('.cw-side-queue', (e) => e.hidden), 'no queue without a worker');

    console.log('\n--- 7. Pair from the window; close ---');
    const codeB2 = await B.mintPairCode({ addrs: [WS_B] });
    await page.click('#cwPairWorker');
    await page.fill('.cw-wl [data-pf="code"]', codeB2);
    await page.waitForTimeout(150);
    await page.click('.cw-wl [data-pf="pair"]');
    await page.waitForSelector('.cw-wcard', { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('#cwWorkerName') && document.querySelector('.cw-wcard-specs'), null, { timeout: 15000 });
    check(!(await page.$('.cw-wl [data-pf="code"]')), 'the form closes once paired');
    check((await cards()).length === 1 && (await cards())[0].selected, 'the new worker is listed and picked');
    // A second worker that is not the app's backend: the window connects to it just to fill its card.
    const codeA2 = await A.mintPairCode({ addrs: [WS_A] });
    await S((s, c) => s.pairWithCode(c), codeA2);
    await page.waitForFunction(() => document.querySelectorAll('.cw-wcard').length === 2, null, { timeout: 10000 });
    const backend = await S((s) => s.selectedWorkerId);
    const other = (await cards()).find((c) => c.id !== backend);
    await page.click(`.cw-wcard[data-node-id="${other.id}"]`);
    await page.waitForFunction((id) => /Idle|Busy/.test((document.querySelector(`.cw-wcard[data-node-id="${id}"]`) || {}).textContent || ''), other.id, { timeout: 15000 });
    check(true, 'a worker that is not the backend connected for the window (info refreshed on pairing)');
    await page.keyboard.press('Tab');
    const inCard = await page.evaluate(() => document.querySelector('.cw-card').contains(document.activeElement));
    check(inCard, 'Tab stays in the card');
    for (let i = 0; i < 60; i++) await page.keyboard.press('Tab');
    check(await page.evaluate(() => document.querySelector('.cw-card').contains(document.activeElement)), 'Tab is trapped in the card after many presses');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#connectWindow', { state: 'detached', timeout: 3000 });
    check(true, 'Esc closes the window');
    await page.waitForTimeout(400);
    const connectedAfter = await S((s) => Object.entries(s.connections).filter(([, c]) => c.status === 'connected').map(([id]) => id));
    check(!connectedAfter.includes(other.id), 'closing releases the idle connection', connectedAfter);

    await page.evaluate(() => document.getElementById('menuConnectWindow').click());
    await page.waitForSelector('#connectWindow', { timeout: 15000 });
    check(true, 'View > Connect Window opens it');
    await page.click('#cwClose');
    check(!(await win()), 'the close button closes it');
    // A click on the dim area closes it too, but a press that starts in the card does not.
    await page.evaluate(() => document.getElementById('menuConnectWindow').click());
    await page.waitForSelector('#connectWindow');
    await page.mouse.move(720, 450);
    await page.mouse.down();
    await page.mouse.move(28, 450);
    await page.mouse.up();
    check(!!(await win()), 'a drag that starts in the card and ends on the dim area keeps it open');
    await page.mouse.click(28, 450);
    check(!(await win()), 'a click on the dim area closes it');
    console.log('\n--- 8. Window Refresh refetches; "Devices…" while reloading; progress card over the window ---');
    await page.evaluate(() => document.getElementById('menuConnectWindow').click());
    await page.waitForSelector('#connectWindow', { timeout: 15000 });
    await page.click(`.cw-wcard[data-node-id="${wa.id}"]`);
    await page.waitForFunction(() => /device/.test((document.querySelector('#cwDevicesBtn') || {}).textContent || '') && /with access/.test(document.querySelector('#cwDevicesBtn').textContent) && document.querySelector('#cwContent .cj-jobs'), null, { timeout: 15000 });
    await page.waitForTimeout(600);
    const callCount = (m) => A.calls.filter((c) => c.method === m).length;
    const before = { info: callCount('worker.info'), jobs: callCount('jobs.list'), dev: callCount('clients.list') };
    const origDevices = A.handlers.get('clients.list');
    A.setHandler('clients.list', async (params, ctx) => { await new Promise((r) => setTimeout(r, 1500)); return origDevices(params, ctx); });
    await page.click('#cwRefresh');
    check(await text('#cwDevicesBtn') && /Devices…/.test(await text('#cwDevicesBtn')), 'Refresh sends the Devices button back to "Devices…" while it reloads (sleap-app)', await text('#cwDevicesBtn'));
    await page.waitForFunction(() => /with access/.test(document.querySelector('#cwDevicesBtn').textContent), null, { timeout: 10000 });
    A.setHandler('clients.list', origDevices);
    await page.waitForTimeout(500);
    const after = { info: callCount('worker.info'), jobs: callCount('jobs.list'), dev: callCount('clients.list') };
    check(after.info > before.info, 'Refresh re-fetches the worker info', [before, after]);
    check(after.jobs - before.jobs >= 2, 'Refresh re-fetches the Jobs list AND the sidebar queue (two jobs.list calls)', [before, after]);
    check(after.dev > before.dev, 'Refresh reloads the Devices list', [before, after]);

    const overlay = await page.evaluate(async () => {
        const m = await import('./ui/loading-overlay.js');
        m.showLoadingProgress('Fetching cam1', 1, 4, { unit: 'MB', title: 'Fetch & Load' });
        const card = document.querySelector('#loadingOverlay .loading-card');
        const r = card.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
        const z = getComputedStyle(document.getElementById('loadingOverlay')).zIndex;
        const out = { inCard: !!hit && !!hit.closest('.loading-card'), z };
        m.hideLoading();
        return out;
    });
    check(overlay.inCard && overlay.z === '10100', 'a progress card (Fetch & Load) shows ABOVE the Connect window', overlay);
    // ... and over a dialog opened from it (the New job wizard, z 10000)
    await page.click('#cjNewJob');
    await page.waitForSelector('#newJobWizard');
    const overlay2 = await page.evaluate(async () => {
        const m = await import('./ui/loading-overlay.js');
        m.showLoadingProgress('Fetching cam1', 1, 4, { unit: 'MB' });
        const r = document.querySelector('#loadingOverlay .loading-card').getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
        m.hideLoading();
        return !!hit && !!hit.closest('.loading-card');
    });
    check(overlay2, 'and above the wizard');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('newJobWizard'));
    // a toast shows above the window too
    const toastHit = await page.evaluate(async () => {
        const n = await import('./ui/connect/notify.js');
        n.notify.info('hello from a toast');
        const t = document.querySelector('.connect-toast');
        const r = t.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && !!hit.closest('.connect-toasts');
    });
    check(toastHit, 'a toast is on top of the window');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#connectWindow', { state: 'detached', timeout: 3000 });
    check(await page.evaluate(() => getComputedStyle(document.getElementById('loadingOverlay')).zIndex === '1000'), 'with no Connect layer open the progress card keeps its own z-index (1000)');

    console.log('\n--- 9. A worker with a new identity: "has a new identity", Re-pair forgets the old entry ---');
    const WS_C = 'ws://127.0.0.1:9733';
    const C = await FakeWorker.create({ workerInfo: { hostname: 'gamma-box' } });
    const D = await FakeWorker.create({ workerInfo: { hostname: 'gamma-box' } });
    const holder = { w: C };
    await page.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9733/, (ws) => holder.w.attachRoute(ws));
    await S((s, c) => s.pairWithCode(c), await C.mintPairCode({ addrs: [WS_C] }));
    const gammaId = C.nodeId;
    check(await S((s, id) => s.pairedWorkers.some((w) => w.nodeId === id), gammaId), 'the third worker is paired');
    await S((st, id) => st.selectWorker(id), wa.id).catch(() => {});   // pairing selected gamma: move the Backend off it
    holder.w = D;            // a different machine now answers at the same address
    C.closeAll();
    await page.evaluate(() => document.getElementById('menuConnectWindow').click());
    await page.waitForSelector('#connectWindow', { timeout: 15000 });
    await page.waitForTimeout(1500);
    await page.click('#cwRefresh');
    await page.waitForFunction((id) => /has a new identity/.test((document.querySelector(`.cw-wcard[data-node-id="${id}"]`) || {}).textContent || ''), gammaId, { timeout: 30000 });
    check(true, 'the card says "has a new identity"');
    check(await page.evaluate(() => /has a new identity\./.test(document.querySelector('.cw-wl-note-row').textContent) && !!document.querySelector('.cw-wl-note-row button')), 'with a note and a Re-pair button', await page.evaluate(() => document.querySelector('.cw-wl-note-row').textContent));
    await page.click('.cw-wl-note-row button:has-text("Re-pair")');
    await page.fill('.cw-wl-item [data-pf="code"]', await D.mintPairCode({ addrs: [WS_C] }));
    await page.waitForTimeout(150);
    await page.click('.cw-wl-item [data-pf="pair"]');
    await page.waitForFunction((d) => !document.querySelector(`.cw-wcard[data-node-id="${d}"]`) && document.querySelector('.cw-wcard[data-node-id="' + d + '"]') === null, gammaId, { timeout: 20000 });
    const ids = await S((s) => s.pairedWorkers.map((w) => w.nodeId));
    check(ids.includes(D.nodeId) && !ids.includes(gammaId), 're-pairing forgets the old (dead) entry and keeps only the new identity', ids);
    check(!(await page.$('.cw-wl-note-row')), 'the identity note is gone');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#connectWindow', { state: 'detached', timeout: 3000 });
    await context.close();

    // ---------------------------------------------------------------- S: stress regressions (own context and workers)
    {
        const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
        page.setDefaultTimeout(30000);
        watchPage(page);
        const A = await FakeWorker.create({ workerInfo: { hostname: 'box-a' } });
        const B = await FakeWorker.create({ workerInfo: { hostname: 'box-b' } });
        await A.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9641/);
        await B.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9642/);
        await bootApp(page, BASE, { timeout: 60000 });
        const call = (fn, ...args) => page.evaluate(async ([f, a]) => {
            const s = (await import('./pose/connect/store.js')).useConnectStore.getState();
            try { return { ok: await eval(f)(s, ...a) }; } catch (e) { return { err: String(e.message || e) }; }
        }, [fn.toString(), args]);

        console.log('\n--- S1. pair A then B ---');
        await pair(page, A, 'ws://127.0.0.1:9641');
        await pair(page, B, 'ws://127.0.0.1:9642');
        let r = await call((s, id) => s.mountsFor(id).then(() => 'ok'), A.nodeId);
        check(r.ok === 'ok', 'Data access calls on A work right after pairing B', r);
        r = await call((s, id) => s.devicesFor(id).then((d) => d.length), B.nodeId);
        check(r.ok >= 0 && !r.err, 'and on B', r);

        console.log('\n--- S2. A has an active tracked job ---');
        await page.evaluate(() => import('./pose/connect/store.js').then((m) => { const st = m.useConnectStore; st.setState({ selectedWorkerId: null }); }));
        await page.evaluate(async (id) => { const m = await import('./pose/connect/store.js'); await m.useConnectStore.getState().connectToWorker(id); }, A.nodeId);
        await page.evaluate((id) => import('./pose/connect/store.js').then((m) => m.useConnectStore.setState((s) => ({ trackedJobs: [...s.trackedJobs, { jobId: 'job_x', workerId: id, state: 'running', startedAt: Date.now() }] }))), A.nodeId);
        const C = await FakeWorker.create({});
        await C.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9643/);
        await pair(page, C, 'ws://127.0.0.1:9643');
        r = await call((s, id) => s.devicesFor(id).then(() => 'ok'), A.nodeId);
        check(r.ok === 'ok', 'A (active job, kept alive) still answers after pairing C', r);
        await page.evaluate(() => import('./pose/connect/store.js').then((m) => m.useConnectStore.setState({ trackedJobs: [] })));
        console.log('\n--- S3. unique ids ---');
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

        console.log('\n--- S4. layers ---');
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

        console.log('\n--- S5. leaks ---');
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

        console.log('\n--- S6. narrow viewports ---');
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

        console.log('\n--- S7. View menu ---');
        await page.evaluate(() => document.getElementById('menuConnectWindow').click());
        await page.waitForSelector('#connectWindow', { timeout: 5000 }).then(() => check(true, 'View > Connect Window… opens the window'), () => check(false, 'View > Connect Window… opens the window'));
    }
});
