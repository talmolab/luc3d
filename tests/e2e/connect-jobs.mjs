/**
 * connect-jobs.mjs — the Connect window's Jobs tab (`ui/connect/worker-jobs.js`, `job-viewer.js`,
 * `loss-plot.js`, `merge-predictions-dialog.js`) against the fake sleap-connect worker
 * (`tests/connect/fake-worker.mjs` over the page's WebSocket, `routeWebSocket`). The tab is mounted
 * straight onto a host div (`createWorkerJobs`), not through the window shell, so it is tested alone.
 * Ports the render assertions of sleap-app tests/unit/{workerJobs,jobViewerDialog}.test.tsx.
 *
 *  A. Rendering (workerJobs.test.tsx): mine pinned first with ONE ★, others "from <project>" and
 *     view-only; run tag "run 2/2"; the failure's first line; button sets per state (Watch live /
 *     View / Logs / Stop Early / Cancel / Run again / Fetch & Load), "Queued · #1" and Cancel run on a
 *     queued run, model name in mono, "→ inference", short job / run ids; grouping (a split run, a
 *     chained inference under its training run), search and "No jobs match.", focusRun ring.
 *  B. Actions: Stop Early / Cancel / Cancel run confirm and send the worker's modes ("Canceling…"
 *     until the run is gone); the trash removes every job of the run (confirm text, a dismissed confirm
 *     does nothing, a failure toasts); "+ New job" opens the wizard; Run again is offered only on a
 *     failed train job that is mine.
 *  C. Stable rows: a refresh bump re-fetches without blanking and keeps the card elements; the poll
 *     repaints only the changed card, keeps the scroll position, keeps focus (also in a repainted card).
 *  D. The viewer (jobViewerDialog.test.tsx): header label + status + replay note, Logs / Monitor toggle,
 *     history replayed, live lines, Errors only, Wrap, Copy, an inference job has logs only, Stop Early /
 *     Cancel only while running and `canStop`, failure detail, the loss plot draws, Esc / X close, and
 *     the stream resumes after the worker reconnects.
 *  E. Fetch & Load: with no project open the dialog offers only Download .slp; a job this page
 *     submitted for a view of the open session merges straight into it (Replace, 20 predictions, the
 *     user label kept, marked fetched); one for another session is refused with its name; a job with no
 *     LUCID tag asks for the view (skeleton check, merges into the picked view) or downloads the .slp.
 *
 * Usage: node tests/e2e/connect-jobs.mjs   (PORT= to move its server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeWorker } from '../connect/fake-worker.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRED = new Uint8Array(fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'sleap-nn-predictions', 'two-node.predictions.slp')));
const PORT = Number(process.env.PORT || 9395);
const BASE = `http://localhost:${PORT}`;
const WS = 'ws://127.0.0.1:9631';

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 700)));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
let browser, context;
try {
    await new Promise((r) => setTimeout(r, 800));
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('console', (m) => { if (/error/i.test(m.type())) console.log('  [console.' + m.type() + ']', m.text().slice(0, 300)); });
    page.on('pageerror', (e) => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    const dialogs = [];
    let dialogAnswer = true;
    page.on('dialog', (d) => { dialogs.push(d.message()); if (dialogAnswer) d.accept(); else d.dismiss(); });

    const worker = await FakeWorker.create({ mounts: [{ path: '/data', label: 'Data' }], serveFolder: '/data', workerInfo: { hostname: 'gpu-box' } });
    await worker.startBlobServer();
    await worker.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9631/);

    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    await page.waitForSelector('.panel-rail-btn[data-tab="tabConnect"]');
    const code = await worker.mintPairCode({ addrs: [WS] });
    await page.evaluate((c) => import('./pose/connect/store.js').then((m) => m.useConnectStore.getState().pairWithCode(c)), code);
    const nodeId = worker.nodeId;

    // waitForFunction does not await a promise: poll store state from node.
    const until = async (fn, arg, ms = 30000) => {
        const t = Date.now();
        while (Date.now() - t < ms) { if (await page.evaluate(fn, arg)) return true; await page.waitForTimeout(150); }
        throw new Error('until timed out: ' + fn.toString().slice(0, 120));
    };
    await until(() => import('./pose/connect/store.js').then((m) => m.useConnectStore.getState().connectionStatus === 'connected'), null, 20000);
    const myTag = () => page.evaluate(async () => {
        const pt = await import('./pose/connect/project-tag.js');
        const ri = await import('./ui/connect/remote-inference.js');
        return pt.lucidProjectTag(ri.openProjectInfo());
    });
    let me = await myTag();
    const OTHER = { id: 'ffffffff', name: 'mice.slp' };

    let n = 0;
    const mkJob = (o = {}) => {
        const { kind = 'train', state = 'running', model = 'centroid', labels = '/data/flies.slp', project = me, run, error = null, result = null,
            postInference = false, extra = {} } = o;
        const spec = kind === 'track'
            ? { type: 'track', data_path: labels, model_paths: ['/data/model'], ...extra }
            : { type: 'train', labels_path: labels, model_types: [model], config_contents: ['a: 1'], ...extra };
        if (run) spec.run = run;
        if (postInference) spec.post_inference = true;
        n++;
        return worker.addJob({ spec, state, project, jobId: o.jobId || ('job_' + String(n).padStart(2, '0') + 'abcdefgh'), error, result });
    };
    const reset = () => { worker.jobs.clear(); dialogs.length = 0; dialogAnswer = true; worker.calls.length = 0; };

    const mount = (props = {}) => page.evaluate(async (props) => {
        if (window.__wj) { window.__wj.destroy(); window.__wj = null; }
        document.getElementById('jobsHost')?.remove();
        const host = document.createElement('div');
        host.id = 'jobsHost';
        host.style.cssText = 'position:fixed;left:20px;top:20px;width:640px;height:600px;overflow:auto;z-index:9000;background:#222;padding:8px;box-sizing:border-box';
        document.body.appendChild(host);
        const m = await import('./ui/connect/worker-jobs.js');
        window.__wj = m.createWorkerJobs(host, { workerId: props.workerId, workerLabel: 'gpu-box', pollIntervalMs: 600000, ...props });
    }, { workerId: nodeId, ...props });
    const cards = () => page.evaluate(() => [...document.querySelectorAll('#jobsHost .cj-run')].map((c) => ({
        key: c.dataset.runKey, text: c.textContent, mine: c.classList.contains('mine'), star: !!c.querySelector('.cj-star'),
        title: c.querySelector('.cj-run-title').textContent, sub: c.querySelector('.cj-run-sub').textContent,
        buttons: [...c.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()),
        rows: [...c.querySelectorAll('.cj-job')].map((r) => ({
            id: r.dataset.jobId, text: r.textContent, title: r.querySelector('.cj-job-title').textContent,
            buttons: [...r.querySelectorAll('button')].map((b) => b.textContent.trim()),
            chip: r.querySelector('.cj-chip').textContent,
        })),
    })));
    const rowsOf = async (id) => (await cards()).flatMap((c) => c.rows).find((r) => r.id === id);
    const btn = (text) => page.locator('#jobsHost').getByRole('button', { name: text, exact: true });
    const waitCards = (k) => page.waitForFunction((k) => document.querySelectorAll('#jobsHost .cj-run').length === k, k);
    const waitCall = async (method, pred = () => true) => {
        for (let i = 0; i < 100; i++) {
            const c = worker.calls.filter((x) => x.method === method).filter((x) => pred(x.params));
            if (c.length) return c[c.length - 1];
            await page.waitForTimeout(100);
        }
        return null;
    };
    const toasts = () => page.evaluate(() => [...document.querySelectorAll('.connect-toast')].map((t) => t.textContent));
    const clearToasts = () => page.evaluate(() => document.querySelectorAll('.connect-toast-close').forEach((b) => b.click()));

    // ======================================================================================== A. rendering
    console.log('\nA. Rendering');
    reset();
    const t0 = Date.now() / 1000;
    mkJob({ jobId: 'other_aaaaaaaa', project: OTHER });
    mkJob({ jobId: 'mine_bbbbbbbb' });
    await mount();
    await waitCards(2);
    let cs = await cards();
    check(cs[0].mine && cs[0].star && cs[0].rows[0].id === 'mine_bbbbbbbb' && !cs[1].mine && !cs[1].star, 'this project\'s run is first and has the ★; the other has none', cs.map((c) => [c.rows[0].id, c.star]));
    check(cs.every((c) => c.rows[0].title === 'Train centroid'), 'row title "Train centroid"');
    check(/from mice\.slp/.test(cs[1].sub) && /flies\.slp/.test(cs[0].sub) && !/from/.test(cs[0].sub), 'sub line: labels name, "from <project>" for another project', cs.map((c) => c.sub));
    check(cs[0].text.includes('Running') && /started/.test(cs[0].text), 'chip "Running" and a "started …" time', cs[0].text);
    check(await page.evaluate(() => /Search labels file, job id, run id, or model/.test(document.getElementById('cjJobsSearch').placeholder)), 'search placeholder');

    reset();
    mkJob({ jobId: 'jr1_aaaaaaaa', run: { id: 'run_zzzzzzzz9999', index: 1, count: 2 } });
    await page.evaluate(() => window.__wj.refresh());
    await page.waitForFunction(() => /run 2\/2/.test(document.getElementById('jobsHost').textContent));
    check(true, 'run tag "run 2/2"');
    cs = await cards();
    check(cs[0].text.includes('job_aaaa') === false && cs[0].rows[0].text.includes('jr1_aaaa') && cs[0].text.includes('run_zzzz'), 'short job id in the row and a different short run id in the header', cs[0].text);

    reset();
    mkJob({ jobId: 'f1', state: 'failed', error: 'CUDA out of memory\nexit code 1' });
    await page.evaluate(() => window.__wj.refresh());
    await page.waitForFunction(() => /CUDA out of memory/.test(document.getElementById('jobsHost').textContent));
    check(!/exit code 1/.test((await cards())[0].text), 'a failed job shows the failure\'s first line only');

    reset();
    mkJob({ jobId: 'tr_running' });
    mkJob({ jobId: 'ti_running', kind: 'track', project: me });
    mkJob({ jobId: 'q1', state: 'queued', model: 'centered_instance' });
    mkJob({ jobId: 'c_track', kind: 'track', state: 'completed', result: { blobs: {} } });
    mkJob({ jobId: 'c_train', state: 'completed', result: { model_dir: '/data/models/260922_015758.centroid.n=1' } });
    mkJob({ jobId: 'o_run', state: 'running', project: OTHER });
    mkJob({ jobId: 'o_track', kind: 'track', state: 'completed', project: OTHER, result: { blobs: {} } });
    mkJob({ jobId: 'chain', state: 'completed', postInference: true, run: { id: 'run_chain', index: 0, count: 1 } });
    await page.evaluate(() => window.__wj.refresh());
    await waitCards(8);
    check((await rowsOf('tr_running')).buttons.join() === 'Watch live,Logs,Stop Early,Cancel', 'running train (mine): Watch live, Logs, Stop Early, Cancel; no Fetch & Load', (await rowsOf('tr_running')).buttons);
    check((await rowsOf('ti_running')).buttons.join() === 'Watch live,Logs,Cancel', 'running inference: Cancel but not Stop Early', (await rowsOf('ti_running')).buttons);
    const q1 = await rowsOf('q1');
    check(q1.buttons.join() === 'Logs' && /Queued · #1/.test(q1.chip) && !/started|finished/.test(q1.text), 'queued: "Queued · #1", no time, only Logs (Cancel run is the run\'s)', q1);
    check((await cards()).find((c) => c.rows[0].id === 'q1').buttons.includes('Cancel run'), 'a queued run of mine has Cancel run');
    check((await rowsOf('c_track')).buttons.join() === 'View,Logs,Fetch & Load', 'completed track: View, Logs, Fetch & Load', (await rowsOf('c_track')).buttons);
    check((await rowsOf('c_train')).buttons.join() === 'View,Logs', 'completed train: View, no Fetch & Load', (await rowsOf('c_train')).buttons);
    check(await page.evaluate(() => {
        const m = [...document.querySelectorAll('#jobsHost .cj-model')].find((e) => e.textContent === '260922_015758.centroid.n=1');
        return !!m && m.classList.contains('cj-mono') && m.classList.contains('cj-muted');
    }), 'a finished train job\'s model name, mono and muted');
    check((await rowsOf('tr_running')).text.indexOf('n=1') === -1, 'no model-name row for a job with none');
    check((await rowsOf('o_run')).buttons.join() === 'Watch live,Logs', 'another project\'s running job is view-only (no Stop / Cancel)', (await rowsOf('o_run')).buttons);
    check((await rowsOf('o_track')).buttons.join() === 'View,Logs,Fetch & Load', 'Fetch & Load is offered on ANY completed track job', (await rowsOf('o_track')).buttons);
    check(/→ inference/.test((await rowsOf('chain')).text), '"→ inference" tag on a train job that chains inference');
    check((await rowsOf('c_train')).chip === 'Completed' && (await rowsOf('c_train')).text.includes('finished'), '"Completed" chip with a "finished …" time');
    const trash = (await cards()).filter((c) => c.buttons.includes('Remove this run')).length;
    check(trash === 4, 'the trash is on runs with nothing queued or running (c_track, c_train, o_track, chain)', trash);

    console.log('\n   grouping + search');
    reset();
    const RUN = { id: 'run_split', index: 0, count: 2 };
    mkJob({ jobId: 'g_centroid', run: RUN });
    mkJob({ jobId: 'g_ci', model: 'centered_instance', run: { ...RUN, index: 1 } });
    mkJob({ jobId: 'g_train', state: 'completed', run: { id: 'run_chained', index: 0, count: 1 }, labels: '/root/a.slp' });
    mkJob({ jobId: 'g_infer', kind: 'track', state: 'completed', run: { id: 'run_chained', index: 0, count: 1, stage: 'inference' }, labels: '/root/a.slp' });
    mkJob({ jobId: 'g_mice', labels: '/root/mice.slp', project: { id: 'other', name: 'mice project' } });
    await page.evaluate(() => window.__wj.refresh());
    await waitCards(3);
    cs = await cards();
    const split = cs.find((c) => c.key === 'run_split'), chained = cs.find((c) => c.key === 'run_chained');
    check(split.title === 'Top-down training run' && split.rows.map((r) => r.title).join() === 'Train centroid,Train centered_instance' && split.star, 'a split run is one card (one ★) with both model rows', split);
    check(chained.title === 'Training run (centroid)' && chained.rows.map((r) => r.title).join() === 'Train centroid,Inference' && chained.star, 'a chained inference sits under its training run', chained);
    const stars = cs.filter((c) => c.star).length;
    check(stars === 2, 'one star per mine-run', stars);
    await page.fill('#cjJobsSearch', 'mice');
    await waitCards(1);
    check((await cards())[0].rows[0].id === 'g_mice', 'search keeps only the groups with a matching job');
    await page.fill('#cjJobsSearch', 'g_infer');
    await waitCards(1);
    check((await cards())[0].rows.length === 2, 'a query matching only the chained inference still surfaces its whole run');
    await page.fill('#cjJobsSearch', 'nonexistent');
    await waitCards(0);
    check(await page.evaluate(() => /No jobs match\./.test(document.getElementById('jobsHost').textContent)), '"No jobs match."');
    await page.fill('#cjJobsSearch', '');
    await waitCards(3);
    await mount({ pollIntervalMs: 600000, focusRun: { key: 'run_chained', nonce: 1 } });
    await page.waitForFunction(() => document.querySelector('#jobsHost [data-run-key="run_chained"]')?.classList.contains('cj-hl'), null, { timeout: 8000 });
    check(true, 'focusRun rings that run\'s card');
    await page.waitForFunction(() => !document.querySelector('#jobsHost .cj-hl'), null, { timeout: 5000 });
    check(true, 'and the ring fades');
    await page.evaluate(() => window.__wj.update({ focusRun: { key: 'run_split', nonce: 2 } }));
    await page.waitForFunction(() => document.querySelector('#jobsHost [data-run-key="run_split"]')?.classList.contains('cj-hl'), null, { timeout: 5000 });
    check(true, 'a second click (new nonce) rings again');

    reset();
    await mount();
    await page.waitForFunction(() => /No jobs yet\./.test(document.getElementById('jobsHost').textContent));
    check(true, '"No jobs yet." on an empty worker');

    // ======================================================================================== B. actions
    console.log('\nB. Actions');
    reset();
    mkJob({ jobId: 'b_run' });
    mkJob({ jobId: 'b_run2' });
    mkJob({ jobId: 'b_track', kind: 'track', project: me });
    await mount();
    await waitCards(3);
    await page.locator('#jobsHost .cj-job[data-job-id="b_run"]').getByRole('button', { name: 'Stop Early', exact: true }).click();
    let call = await waitCall('jobs.cancel', (p) => p.job_id === 'b_run');
    check(call && call.params.mode === 'stop', 'Stop Early sends mode stop', call);
    check(dialogs.length === 1 && /finishes its current batch and keeps the model trained so far/.test(dialogs[0]), 'after sleap-app\'s confirm text', dialogs[0]);
    await page.locator('#jobsHost .cj-job[data-job-id="b_run2"]').getByRole('button', { name: 'Cancel', exact: true }).click();
    call = await waitCall('jobs.cancel', (p) => p.job_id === 'b_run2' && p.mode === 'cancel');
    check(!!call && /ends now without a result/.test(dialogs[1]), 'Cancel sends mode cancel (confirm: "ends now without a result")', dialogs[1]);
    dialogAnswer = false;
    const before = worker.calls.filter((c) => c.method === 'jobs.cancel').length;
    await page.locator('#jobsHost .cj-job[data-job-id="b_track"]').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForTimeout(400);
    check(worker.calls.filter((c) => c.method === 'jobs.cancel').length === before, 'a dismissed confirm cancels nothing');
    dialogAnswer = true;

    reset();
    mkJob({ jobId: 'r_done', state: 'completed', run: { id: 'run_a', index: 0, count: 2 } });
    mkJob({ jobId: 'r_run', state: 'running', model: 'centered_instance', run: { id: 'run_a', index: 1, count: 2 } });
    mkJob({ jobId: 'r_other', state: 'running', project: OTHER, run: { id: 'run_o', index: 0, count: 1 } });
    mkJob({ jobId: 'r_fin', state: 'completed', run: { id: 'run_f', index: 0, count: 1 } });
    await mount();
    await waitCards(3);
    cs = await cards();
    check(cs.find((c) => c.key === 'run_a').buttons.includes('Cancel run') && !cs.find((c) => c.key === 'run_o').buttons.includes('Cancel run') && !cs.find((c) => c.key === 'run_f').buttons.includes('Cancel run'),
        'Cancel run on an active run of this project; none on another project\'s or a finished one');
    worker.cancelRunning = 'manual'; // the worker takes its time: the run stays listed as running
    await page.locator('#jobsHost [data-run-key="run_a"]').getByRole('button', { name: 'Cancel run', exact: true }).click();
    call = await waitCall('jobs.cancel', (p) => p.job_id === 'r_run');
    check(call && call.params.mode === 'cancel' && !worker.calls.some((c) => c.method === 'jobs.cancel' && c.params.job_id === 'r_done'), 'Cancel run ends only the unfinished jobs', call);
    check(/Every unfinished job of this run ends now/.test(dialogs[0]), 'with its confirm text', dialogs[0]);
    await page.waitForFunction(() => [...document.querySelectorAll('#jobsHost [data-run-key="run_a"] button')].some((b) => b.textContent === 'Canceling…' && b.disabled));
    check(true, 'the button reads "Canceling…" (disabled) while the worker still lists the run');
    worker.setJobState('r_run', 'canceled', { detail: 'canceled by request' });
    await page.evaluate(() => window.__wj.refresh());
    await page.waitForFunction(() => !document.querySelector('#jobsHost [data-run-key="run_a"] .cj-cancel'), null, { timeout: 10000 });
    worker.cancelRunning = 'immediate';
    check(true, 'and goes away once nothing is running or queued');

    console.log('\n   remove run');
    reset();
    mkJob({ jobId: 'd_train', state: 'completed', run: { id: 'run_d', index: 0, count: 1 }, extra: {} });
    mkJob({ jobId: 'd_infer', kind: 'track', state: 'completed', run: { id: 'run_d', index: 0, count: 1, stage: 'inference' }, result: { blobs: {} } });
    worker.jobs.get('d_train').result = { model_dir: '/data/models/260101_000000.centroid.n=1' };
    await page.evaluate(() => window.__wj.refresh());
    await page.waitForFunction(() => document.querySelectorAll('#jobsHost .cj-job').length === 2);
    dialogAnswer = false;
    await page.getByRole('button', { name: 'Remove this run' }).click();
    await page.waitForTimeout(500);
    check(dialogs.length === 1 && /Nothing is deleted from disk/.test(dialogs[0]) && /Train centroid \(260101_000000\.centroid\.n=1\)/.test(dialogs[0]) && /Inference/.test(dialogs[0]), 'the confirm lists each job (with its model name) and the disk-safety note', dialogs[0]);
    check(!worker.calls.some((c) => c.method === 'jobs.delete'), 'dismissing it deletes nothing');
    dialogAnswer = true;
    await page.getByRole('button', { name: 'Remove this run' }).click();
    call = await waitCall('jobs.delete');
    check(call && JSON.stringify(call.params.job_ids.slice().sort()) === '["d_infer","d_train"]', 'confirming removes every job of the run', call);
    await waitCards(0);
    check(true, 'and the list refreshes');
    reset();
    mkJob({ jobId: 'd_gone', state: 'completed' });
    await page.evaluate(() => window.__wj.refresh());
    await waitCards(1);
    worker.jobs.delete('d_gone'); // the worker no longer knows it: jobs.delete fails
    await clearToasts();
    await page.getByRole('button', { name: 'Remove this run' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.connect-toast')].some((t) => /Failed to remove run/.test(t.textContent)), null, { timeout: 10000 });
    check(true, 'a delete failure toasts "Failed to remove run" instead of crashing');

    console.log('\n   + New job / Run again');
    reset();
    mkJob({ jobId: 'ra_train', state: 'failed', error: 'boom', labels: '/data/flies.slp', model: 'single_instance' });
    mkJob({ jobId: 'ra_other', kind: 'track', state: 'failed', error: 'boom', project: OTHER });
    mkJob({ jobId: 'ra_mine', kind: 'track', state: 'failed', error: 'boom', labels: '/data/flies.slp' });
    await mount();
    await waitCards(3);
    cs = await cards();
    check(cs.flatMap((c) => c.rows).filter((r) => r.buttons.includes('Run again')).map((r) => r.id).join() === 'ra_mine', 'Run again is hidden on a failed TRAIN job (training is out of scope) and offered only on a failed inference job that is mine', cs.flatMap((c) => c.rows).map((r) => [r.id, r.buttons]));
    await page.click('#cjNewJob');
    await page.waitForSelector('#newJobWizard', { timeout: 10000 });
    check(true, '+ New job opens the wizard');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('newJobWizard'));
    check(true, 'Esc closes it');
    await page.getByRole('button', { name: 'Run again' }).click();
    await page.waitForSelector('#newJobWizard', { timeout: 10000 });
    check(!!(await waitCall('jobs.status', (p) => p.job_id === 'ra_mine')), 'Run again reads the run\'s own job detail (jobs.status) and opens the wizard seeded');
    check(await page.evaluate(() => /flies\.slp/.test(document.getElementById('newJobWizard').textContent)), 'the wizard shows the run\'s labels path');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('newJobWizard'));

    // ======================================================================================== C. stable rows
    console.log('\nC. Stable rows');
    reset();
    for (let i = 0; i < 12; i++) mkJob({ jobId: 'st_' + String(i).padStart(2, '0'), state: 'completed', project: i < 2 ? me : OTHER });
    mkJob({ jobId: 'st_queued', state: 'queued' });
    await mount({ pollIntervalMs: 500 });
    await waitCards(13);
    let calls = worker.calls.filter((c) => c.method === 'jobs.list').length;
    await page.evaluate(() => { window.__marks = [...document.querySelectorAll('#jobsHost .cj-run')]; });
    await page.evaluate(() => window.__wj.update({ refreshToken: 1 }));
    await page.waitForFunction((c) => true, calls);
    for (let i = 0; i < 50 && worker.calls.filter((c) => c.method === 'jobs.list').length <= calls; i++) await page.waitForTimeout(100);
    check(worker.calls.filter((c) => c.method === 'jobs.list').length > calls, 'a refresh bump re-fetches now');
    check(await page.evaluate(() => !/Loading jobs/.test(document.getElementById('jobsHost').textContent) && document.querySelectorAll('#jobsHost .cj-run').length === 13), 'the rows never blank to "Loading jobs…" during a refresh');
    await page.waitForTimeout(1500); // a few polls
    check(await page.evaluate(() => { const now = [...document.querySelectorAll('#jobsHost .cj-run')]; return now.length === window.__marks.length && now.every((n, i) => n === window.__marks[i]); }),
        'unchanged cards are the SAME elements after polls (nothing is rebuilt)');
    // scroll + focus survive a poll that changes one card
    await page.evaluate(() => {
        const h = document.getElementById('jobsHost');
        h.scrollTop = h.scrollHeight;
        const last = [...document.querySelectorAll('#jobsHost .cj-run')].pop().querySelector('button');
        window.__lastBtn = last; last.focus();
        window.__scroll = h.scrollTop;
    });
    const scrollBefore = await page.evaluate(() => window.__scroll);
    check(scrollBefore > 100, 'the list scrolls', scrollBefore);
    worker.setJobState('st_queued', 'running');
    await page.waitForFunction(() => /Running/.test(document.querySelector('#jobsHost [data-run-key="st_queued"]')?.textContent || ''), null, { timeout: 10000 });
    const kept = await page.evaluate(() => ({
        scroll: document.getElementById('jobsHost').scrollTop, same: document.activeElement === window.__lastBtn,
        n: [...document.querySelectorAll('#jobsHost .cj-run')].filter((n, i) => n !== window.__marks[i]).length,
    }));
    check(Math.abs(kept.scroll - scrollBefore) < 3, 'the scroll position survives a repaint', kept);
    check(kept.same, 'a focused button in an unchanged card keeps focus (same element)', kept);
    // focus inside the repainted card is restored
    const sq = '#jobsHost [data-run-key="st_queued"]';
    await page.evaluate((sq) => document.querySelector(sq).querySelector('button[data-act="logs"]').focus(), sq);
    worker.setJobState('st_queued', 'completed');
    await page.waitForFunction((sq) => /Completed/.test(document.querySelector(sq)?.textContent || ''), sq, { timeout: 10000 });
    check(await page.evaluate((sq) => document.activeElement && document.activeElement.dataset.fk === 'logs:st_queued' && document.querySelector(sq).contains(document.activeElement), sq),
        'focus on a button of the repainted card moves to its replacement');
    await page.fill('#cjJobsSearch', 'st_0');
    await page.waitForTimeout(1300);
    check(await page.evaluate(() => document.getElementById('cjJobsSearch').value === 'st_0'), 'the search text survives polls');
    await page.fill('#cjJobsSearch', '');

    console.log('\n   polling: 10 s by default, a refresh restarts the timer (Jobs tab and sidebar queue)');
    reset();
    mkJob({ jobId: 'pl_1', state: 'completed' });
    const listCalls = () => worker.calls.filter((c) => c.method === 'jobs.list').length;
    const waitListCalls = async (n) => { for (let i = 0; i < 100 && listCalls() < n; i++) await page.waitForTimeout(100); return listCalls() >= n; };
    const pollKinds = [['worker-jobs.js', 'createWorkerJobs', {}], ['sidebar-queue.js', 'createSidebarQueue', { workerLabel: 'gpu-box', onChanged() {}, onOpenRun() {} }]];
    for (const [file, fn] of pollKinds) {
        const base = listCalls();
        const first = await page.evaluate(async ([file, fn, id]) => {
            const mod = await import('./ui/connect/' + file);
            const { DEFAULT_POLL_MS } = await import('./pose/connect/worker-ui-helpers.js');
            const host = document.createElement('div'); host.id = 'pollHost'; document.body.appendChild(host);
            const t = { set: [], cleared: [], cbs: new Map(), n: 0 };
            window.__poll = t;
            const props = { workerId: id, workerLabel: 'gpu-box', refreshToken: 0, onChanged() {}, onOpenRun() {},
                setIntervalImpl: (cb, ms) => { const h = ++t.n; t.set.push(ms); t.cbs.set(h, cb); return h; }, clearIntervalImpl: (h) => { t.cleared.push(h); t.cbs.delete(h); } };
            window.__pollProps = props; window.__pollComp = mod[fn](host, props);
            return { def: DEFAULT_POLL_MS, set: t.set.slice() };
        }, [file, fn, nodeId]);
        check(first.def === 10000 && first.set.join() === '10000', file + ': the default poll is 10,000 ms (the timer is set with it)', first);
        check(await waitListCalls(base + 1), file + ': it lists on mount');
        const afterMount = listCalls();
        await page.evaluate(() => { [...window.__poll.cbs.values()].forEach((cb) => cb()); });
        check(await waitListCalls(afterMount + 1), file + ': a timer tick lists again');
        await page.evaluate(() => window.__pollComp.update({ ...window.__pollProps, refreshToken: 1 }));
        const r = await page.evaluate(() => ({ set: window.__poll.set.slice(), cleared: window.__poll.cleared.slice() }));
        check(r.cleared.length === 1 && r.set.length === 2, file + ': a refresh bump restarts the timer (old one cleared, a new one set)', r);
        check(await waitListCalls(afterMount + 2), file + ': and re-fetches now');
        await page.evaluate(() => { window.__pollComp.destroy(); document.getElementById('pollHost').remove(); });
        check(await page.evaluate(() => window.__poll.cbs.size === 0), file + ': destroy clears the timer');
    }
    await mount();

    // ======================================================================================== D. viewer
    console.log('\nD. Viewer');
    reset();
    mkJob({ jobId: 'v_run', state: 'running' });
    mkJob({ jobId: 'v_track', kind: 'track', state: 'running' });
    mkJob({ jobId: 'v_other', state: 'running', project: OTHER });
    mkJob({ jobId: 'v_fail', state: 'failed', error: 'CUDA out of memory' });
    for (const id of ['v_run', 'v_track', 'v_other']) worker.setJobState(id, 'running'); // the worker announces it
    worker.log('v_run', 'line one'); worker.log('v_run', 'ERROR boom happened'); worker.log('v_run', 'epoch 1 *** best ***'); worker.log('v_run', '— section');
    worker.log('v_track', 'predicting 5/10');
    worker.log('v_other', 'other log');
    worker.log('v_fail', 'Traceback (most recent call last)');
    worker.setJobState('v_fail', 'failed', { detail: 'CUDA out of memory' });
    await mount();
    await waitCards(4);
    const inRow = (id) => page.locator(`#jobsHost .cj-job[data-job-id="${id}"]`);
    await inRow('v_run').getByRole('button', { name: 'Logs', exact: true }).click();
    await page.waitForSelector('.cj-viewer');
    const hv = await page.evaluate(() => ({
        title: document.querySelector('.cj-card-title-text').textContent, status: document.querySelector('.cj-card-status').textContent,
        desc: document.querySelector('.cj-card-desc').textContent, btns: [...document.querySelectorAll('.cj-viewer button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()),
        modal: !!document.querySelector('.cj-scrim[data-shortcut-modal]'),
    }));
    check(hv.title === 'Train centroid' && /Replayed from the worker's history; per-epoch timing for earlier epochs isn't available\./.test(hv.desc), 'header label + the replay note', hv);
    await page.waitForFunction(() => document.querySelector('.cj-card-status').textContent === 'running');
    check(true, 'the stream\'s status in the header ("running")');
    check(hv.modal, 'the scrim keeps app shortcuts off (data-shortcut-modal)');
    await page.waitForFunction(() => /line one/.test(document.querySelector('.cj-viewer-pre').textContent));
    const lines = await page.evaluate(() => [...document.querySelectorAll('.cj-viewer-pre > div')].map((d) => [d.textContent, d.className]));
    check(lines.length === 4 && lines[0][0] === 'line one', 'the worker\'s history is replayed', lines);
    check(lines[1][1] === 'cj-log-err' && lines[2][1] === 'cj-log-best' && lines[3][1] === 'cj-log-mark', 'error / best / section lines are coloured', lines.map((l) => l[1]));
    check(['Monitor', 'Logs', 'Stop Early', 'Cancel', 'Close'].every((b) => hv.btns.includes(b)), 'Monitor, Logs, Stop Early, Cancel and Close are there', hv.btns);
    worker.log('v_run', 'a live line');
    await page.waitForFunction(() => /a live line/.test(document.querySelector('.cj-viewer-pre').textContent), null, { timeout: 5000 });
    check(true, 'a live line arrives');
    await page.click('.cj-viewer .cj-viewer-tools input >> nth=0');
    await page.waitForFunction(() => document.querySelectorAll('.cj-viewer-pre > div').length === 1);
    check(await page.evaluate(() => document.querySelector('.cj-viewer-pre').textContent === 'ERROR boom happened'), '"Errors only" keeps the error lines');
    await page.click('.cj-viewer .cj-viewer-tools input >> nth=0');
    await page.click('.cj-viewer .cj-viewer-tools input >> nth=1');
    check(await page.evaluate(() => document.querySelector('.cj-viewer-pre').classList.contains('nowrap')), '"Wrap" off stops wrapping');
    await page.click('.cj-viewer .cj-viewer-tools input >> nth=1');
    await page.click('.cj-viewer .cj-viewer-tools button');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check(clip.split('\n').length === 5 && clip.startsWith('line one'), 'Copy puts the log on the clipboard', clip);
    // monitor + loss plot
    await page.getByRole('button', { name: 'Monitor', exact: true }).click();
    check(await page.evaluate(() => /Waiting for first epoch…/.test(document.querySelector('.cj-loss-title').textContent) && /Loss curves will appear after the first epoch completes\./.test(document.querySelector('.cj-loss-empty').textContent)), 'Monitor before the first epoch: "Waiting for first epoch…"');
    worker.epoch('v_run', 0, 0.9, 0.95); worker.epoch('v_run', 1, 0.5, 0.6); worker.epoch('v_run', 2, 0.2, 0.3);
    worker.curve('v_run', [[0, 1.0], [10, 0.8], [20, 0.5], [30, 0.3]]);
    worker.metric('v_run', { epoch: 2, total_epochs: 10, latest_train_loss: 0.2 });
    await page.waitForFunction(() => /Epoch/.test(document.querySelector('.cj-loss-title').textContent) && document.querySelector('.cj-loss-canvas').style.display !== 'none', null, { timeout: 5000 });
    const plot = await page.evaluate(() => {
        const c = document.querySelector('.cj-loss-canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let drawn = 0; for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) drawn++;
        return { title: document.querySelector('.cj-loss-title').textContent, drawn, w: c.width, legend: document.querySelector('.cj-loss-legend').textContent };
    });
    check(plot.drawn > 2000 && /train loss 0\.2000/.test(plot.title) && /val loss 0\.3000/.test(plot.title), 'the loss plot draws the epochs (canvas has pixels; title carries the latest losses)', plot);
    check(/Epoch Training Loss/.test(plot.legend) && /Epoch Validation Loss/.test(plot.legend) && /Best Validation Loss/.test(plot.legend), 'legend');
    // loss plot: title numbering, tooltip, zoom, Batches, PNG / CSV
    check(/^Epoch 3 \/ 10 · /.test(plot.title), 'the title counts completed epochs like sleap-app (model.epoch: "Epoch 3 / 10")', plot.title);
    check(await page.evaluate(() => import('./ui/connect/loss-plot.js').then((m) => m.lossTitle({ epoch: 1, maxEpochs: 100, epochSamples: [{ epoch: 0, trainLoss: 0.5, valLoss: 0.6 }], bestValLoss: 0.6, metrics: { bestValEpoch: 0 } }) === 'Epoch 1 / 100 · train loss 0.5000 · val loss 0.6000 · best val 0.6000 @ epoch 1')), 'one finished epoch reads "Epoch 1 / 100" and best "@ epoch 1" (bestValEpoch + 1)');
    const lp = await page.evaluate(() => { const c = document.querySelector('.cj-loss-canvas'); const r = c.getBoundingClientRect(); const pt = c.__scene.pts.find((q) => q.label === 'Epoch Validation Loss'); return { x: r.left + pt.px, y: r.top + pt.py, left: r.left, top: r.top, sc: { L: c.__scene.L, T: c.__scene.T, pw: c.__scene.pw, ph: c.__scene.ph, x0: c.__scene.x0, x1: c.__scene.x1 } }; });
    await page.mouse.move(lp.x + 2, lp.y + 1);
    await page.waitForFunction(() => !document.querySelector('.cj-loss-tip').hidden);
    check(await page.evaluate(() => /^Epoch (Validation|Training) Loss · batch [\d,]+ · 0\.\d+$/.test(document.querySelector('.cj-loss-tip').textContent)), 'hovering a point shows a tooltip (series, batch, loss)', await page.evaluate(() => document.querySelector('.cj-loss-tip').textContent));
    await page.mouse.move(lp.left + lp.sc.L + 3, lp.top + lp.sc.T + lp.sc.ph - 2);
    await page.mouse.move(lp.left + lp.sc.L + lp.sc.pw / 2, lp.top + lp.sc.T + 2);
    check(await page.evaluate(() => document.querySelector('.cj-loss-tip').hidden), 'the tooltip hides away from every point');
    await page.mouse.move(lp.left + lp.sc.L + lp.sc.pw * 0.25, lp.top + lp.sc.T + 10);
    await page.mouse.down(); await page.mouse.move(lp.left + lp.sc.L + lp.sc.pw * 0.6, lp.top + lp.sc.T + 10); await page.mouse.up();
    const z1 = await page.evaluate(() => { const s = document.querySelector('.cj-loss-canvas').__scene; return [s.x0, s.x1]; });
    check(z1[0] > lp.sc.x0 + 1 && z1[1] < lp.sc.x1 - 1, 'dragging across the plot zooms the batch axis', [z1, lp.sc.x0, lp.sc.x1]);
    await page.click('#cjLossReset');
    check(await page.evaluate((x) => { const s = document.querySelector('.cj-loss-canvas').__scene; return Math.abs(s.x0 - x[0]) < 1e-6 && Math.abs(s.x1 - x[1]) < 1e-6; }, [lp.sc.x0, lp.sc.x1]), 'Reset zoom restores the whole range');
    await page.mouse.move(lp.left + lp.sc.L + lp.sc.pw * 0.25, lp.top + lp.sc.T + 10);
    await page.mouse.down(); await page.mouse.move(lp.left + lp.sc.L + lp.sc.pw * 0.6, lp.top + lp.sc.T + 10); await page.mouse.up();
    await page.mouse.dblclick(lp.left + lp.sc.L + 20, lp.top + lp.sc.T + 30);
    check(await page.evaluate((x) => Math.abs(document.querySelector('.cj-loss-canvas').__scene.x0 - x) < 1e-6, lp.sc.x0), 'double-click also resets');
    check(await page.evaluate(() => [...document.querySelectorAll('.cj-loss-batches option')].map((o) => o.textContent).join() === '200,1000,5000,All' && document.querySelector('.cj-loss-batches').value === '-1'), 'Batches: 200 / 1000 / 5000 / All, default All');
    await page.selectOption('.cj-loss-batches', '200');
    check(await page.evaluate(() => document.querySelector('.cj-loss-batches').value === '200' && document.querySelector('.cj-loss-canvas').__scene.pts.length > 0), 'choosing a Batches window redraws');
    const [dl1] = await Promise.all([page.waitForEvent('download'), page.click('#cjLossCsv')]);
    const csv = fs.readFileSync(await dl1.path(), 'utf8');
    check(dl1.suggestedFilename() === 'Train centroid-loss.csv' && csv === 'epoch,train_loss,val_loss\n1,0.9,0.95\n2,0.5,0.6\n3,0.2,0.3\n', 'CSV export: epoch,train_loss,val_loss (1-based)', [dl1.suggestedFilename(), csv]);
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#cjLossPng')]);
    const png = fs.readFileSync(await dl2.path());
    check(dl2.suggestedFilename() === 'Train centroid-loss.png' && png[0] === 0x89 && png.slice(1, 4).toString() === 'PNG', 'PNG export downloads a PNG', dl2.suggestedFilename());
    // Toasts and progress cards sit above the viewer (they used to hide under its scrim)
    const over = await page.evaluate(async () => {
        const n = await import('./ui/connect/notify.js');
        window.__toastClicks = 0;
        n.notify.info('over the viewer', { action: { label: 'Poke', onClick: () => { window.__toastClicks++; } } });
        const t = document.querySelector('.connect-toast');
        const r = t.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const lo = await import('./ui/loading-overlay.js');
        lo.showLoadingProgress('Fetching cam1', 1, 4, { unit: 'MB' });
        const cr = document.querySelector('#loadingOverlay .loading-card').getBoundingClientRect();
        const ch = document.elementFromPoint(cr.left + cr.width / 2, cr.top + 20);
        lo.hideLoading();
        return { toastOnTop: !!hit && !!hit.closest('.connect-toasts'), cardOnTop: !!ch && !!ch.closest('.loading-card') };
    });
    check(over.toastOnTop, 'a toast raised while the viewer is open is above its scrim', over);
    check(over.cardOnTop, 'a progress card is above the viewer');
    await page.getByRole('button', { name: 'Poke', exact: true }).click();
    check(await page.evaluate(() => window.__toastClicks === 1), 'a toast action is clickable over the viewer');
    check(!!(await page.$('.cj-viewer')), 'and the click did not close the viewer');
    // Stop Early / Cancel from the viewer
    await page.getByRole('button', { name: 'Stop Early', exact: true }).last().click();
    call = await waitCall('jobs.cancel', (p) => p.job_id === 'v_run' && p.mode === 'stop');
    check(!!call, 'Stop Early in the viewer confirms and sends mode stop');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.cj-viewer'));
    check(true, 'Esc closes the viewer');
    // inference job: logs only
    await inRow('v_track').getByRole('button', { name: 'Watch live', exact: true }).click();
    await page.waitForSelector('.cj-viewer');
    await page.waitForFunction(() => /predicting 5\/10/.test(document.querySelector('.cj-viewer-pre').textContent));
    const tv = await page.evaluate(() => ({ btns: [...document.querySelectorAll('.cj-viewer .cj-viewer-bar button')].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim()), desc: document.querySelector('.cj-card-desc').textContent }));
    check(tv.btns.join() === 'Cancel' && tv.desc === "Replayed from the worker's history.", 'an inference job: only its logs, Cancel but no Stop Early / Monitor', tv);
    await page.click('.cj-card-x');
    await page.waitForFunction(() => !document.querySelector('.cj-viewer'));
    check(true, 'the X closes it');
    // view-only job of another project
    await inRow('v_other').getByRole('button', { name: 'Watch live', exact: true }).click();
    await page.waitForSelector('.cj-viewer');
    await page.waitForFunction(() => document.querySelector('.cj-card-status').textContent === 'running');
    check(await page.evaluate(() => [...document.querySelectorAll('.cj-viewer .cj-viewer-ends')].every((e) => e.style.display === 'none')), 'never offers Stop / Cancel for a view-only job, even while running');
    await page.keyboard.press('Escape');
    // a failed job
    await inRow('v_fail').getByRole('button', { name: 'View', exact: true }).click();
    await page.waitForSelector('.cj-viewer');
    await page.waitForFunction(() => /CUDA out of memory/.test(document.querySelector('.cj-viewer-detail').textContent) && document.querySelector('.cj-card-status').textContent === 'failed');
    check(await page.evaluate(() => document.querySelector('.cj-viewer-detail').style.display !== 'none' && document.querySelector('.cj-viewer .cj-viewer-ends').style.display === 'none'), 'the failure detail shows; Stop is hidden once the job is not running');
    check(await page.evaluate(() => /No loss data/.test(document.querySelector('.cj-loss-title').textContent)), 'a finished job with no epochs says "No loss data"');
    await page.keyboard.press('Escape');

    console.log('\n   resume on reconnect');
    await inRow('v_run').getByRole('button', { name: 'Logs', exact: true }).click();
    await page.waitForFunction(() => /a live line/.test(document.querySelector('.cj-viewer-pre')?.textContent || ''));
    worker.closeAll(1001, 'going away');
    await page.waitForTimeout(500);
    await until(() => import('./pose/connect/store.js').then((m) => Object.values(m.useConnectStore.getState().connections).every((c) => c.status === 'connected')), null, 40000);
    worker.log('v_run', 'after the reconnect');
    await page.waitForFunction(() => /after the reconnect/.test(document.querySelector('.cj-viewer-pre').textContent), null, { timeout: 15000 });
    check(true, 'after the worker reconnects the viewer is live again (resumed from the last seq)');
    check(await page.evaluate(() => (document.querySelector('.cj-viewer-pre').textContent.match(/a live line/g) || []).length === 1), 'without duplicating the lines already shown');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.__wj.destroy(); window.__wj = null; document.getElementById('jobsHost').remove(); });

    // ======================================================================================== E. Fetch & Load
    console.log('\nE. Fetch & Load');
    reset();
    mkJob({ jobId: 'e_untagged', kind: 'track', state: 'completed', project: OTHER, labels: '/data/sess/cam2/cam2.mp4', extra: { output_path: '/data/sess/predictions/u.predictions.slp' } });
    worker.addFile('/data/sess/predictions/u.predictions.slp', PRED);
    await worker.completeJob('e_untagged', { predictions: PRED });
    await mount();
    await waitCards(1);
    await btn('Fetch & Load').click();
    await page.waitForSelector('.cj-merge');
    await page.waitForFunction(() => document.querySelector('#cjMergeDownload'), null, { timeout: 30000 });
    const nopro = await page.evaluate(() => ({ text: document.querySelector('.cj-merge').textContent, merge: !!document.getElementById('cjMergeGo'), title: document.querySelector('.cj-merge .cj-card-title-text').textContent }));
    check(nopro.title === 'Load predictions' && /No project open/.test(nopro.text) && !nopro.merge, 'no project open: "Load predictions" says so and offers only Download .slp', nopro);
    const dl = page.waitForEvent('download');
    await page.click('#cjMergeDownload');
    const dlf = await dl;
    const dlPath = await dlf.path();
    check(dlf.suggestedFilename() === 'e_untagged.predictions.slp' && fs.readFileSync(dlPath).length === PRED.length, 'Download .slp saves the worker\'s file', [dlf.suggestedFilename(), fs.readFileSync(dlPath).length, PRED.length]);
    check(await page.evaluate(() => /From inference on/.test(document.querySelector('.cj-merge .cj-card-desc').textContent)), 'the description says where it came from');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.cj-merge'));
    check(true, 'Esc closes the dialog');

    // Fetch & Load connects to the worker first when it is not the selected backend, not when it is
    await page.evaluate(async () => {
        const m = await import('./pose/connect/store.js');
        window.__connCalls = [];
        window.__realConn = m.useConnectStore.getState().connectToWorker;
        m.useConnectStore.setState({ connectToWorker: async (w) => { window.__connCalls.push(w); m.useConnectStore.setState({ selectedWorkerId: w }); } });
    });
    await btn('Fetch & Load').click();
    await page.waitForSelector('.cj-merge');
    check(await page.evaluate(() => window.__connCalls.length === 0), 'the worker is the backend: Fetch & Load does not reconnect');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.cj-merge'));
    await page.evaluate(async () => { const m = await import('./pose/connect/store.js'); m.useConnectStore.setState({ selectedWorkerId: 'some-other-backend' }); });
    await btn('Fetch & Load').click();
    await page.waitForSelector('.cj-merge');
    check(await page.evaluate((id) => window.__connCalls.join() === id, nodeId), 'another worker is the backend: Fetch & Load connects to this one first', await page.evaluate(() => window.__connCalls));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.cj-merge'));
    await page.evaluate(async (id) => { const m = await import('./pose/connect/store.js'); m.useConnectStore.setState({ connectToWorker: window.__realConn, selectedWorkerId: id }); }, nodeId);

    // A project: two views, a user label on cam1 frame 0, an old prediction on frame 1
    const sess = await page.evaluate(async () => {
        const enc = await import('./ui/video-encode.js');
        const fio = await import('./import-export/file-io.js');
        const pd = await import('./pose/pose-data.js');
        const loader = await import('./loading/session-loader.js');
        const AS = await import('./ui/app-state.js');
        const CAMS = ['cam1', 'cam2'], W = 320, H = 240, N = 12, ROOT = 'rec';
        async function mp4(shade) {
            const canvas = document.createElement('canvas');
            canvas.width = W; canvas.height = H;
            const c = canvas.getContext('2d');
            const wr = await enc.createMp4Writer({ canvas, width: W, height: H, fps: 10, bitrate: 300000, frameCount: N, keyFrameEveryFrames: 4 });
            for (let i = 0; i < N; i++) { c.fillStyle = 'rgb(' + shade + ',' + (10 * i) + ',80)'; c.fillRect(0, 0, W, H); await wr.addFrame(i); }
            return (await wr.finish()).blob;
        }
        let toml = '';
        CAMS.forEach((cn, i) => {
            toml += '[cam_' + i + ']\nname = "' + cn + '"\nsize = [' + W + ', ' + H + ']\n'
                + 'matrix = [[600.0, 0.0, 160.0], [0.0, 600.0, 120.0], [0.0, 0.0, 1.0]]\n'
                + 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\nrotation = [0.0, ' + (0.2 * i) + ', 0.0]\n'
                + 'translation = [' + (15 * i) + ', 0.0, 0.0]\n\n';
        });
        function mkFile(bits, rel, type) {
            const f = new File(bits, rel.split('/').pop(), { type: type || 'application/octet-stream' });
            Object.defineProperty(f, 'webkitRelativePath', { value: rel });
            return f;
        }
        async function slp(cam) {
            const K = [[600, 0, 160], [0, 600, 120], [0, 0, 1]];
            const cams = CAMS.map((nm, i) => new pd.Camera(nm, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [W, H]));
            const s = new pd.Session(cams, new pd.Skeleton('sk', ['A', 'B'], [[0, 1]]), ['t0'], 'gen');
            if (cam === 'cam1') {
                const f0 = new pd.FrameGroup(0); s.addFrameGroup(f0);
                f0.addInstance(cam, new pd.Instance([[11, 22], [33, 44]], 0, 'user', 1));
                const f1 = new pd.FrameGroup(1); s.addFrameGroup(f1);
                f1.addInstance(cam, new pd.Instance([[1, 2], [3, 4]], 0, 'predicted', 0.5));
            }
            return fio.exportSlpClientSide(s, cam, false, { videoPath: ROOT + '/' + cam + '/' + cam + '.mp4', file: null,
                videoWidth: W, videoHeight: H, frameCount: N }, cam + '.slp', null);
        }
        const v1 = await mp4(10), v2 = await mp4(200);
        const files = [mkFile([toml], ROOT + '/calibration.toml', 'text/plain'),
            mkFile([v1], ROOT + '/cam1/cam1.mp4', 'video/mp4'), mkFile([v2], ROOT + '/cam2/cam2.mp4', 'video/mp4'),
            mkFile([await slp('cam1')], ROOT + '/cam1/cam1.slp'), mkFile([await slp('cam2')], ROOT + '/cam2/cam2.slp')];
        AS.state.sessions = []; AS.state.activeSessionIdx = 0; AS.state.videoFiles = []; AS.state.session = null; AS.state.views = [];
        await loader.handleLoadSessionFolderPerCamera(files, false);
        return { views: AS.state.views.map((v) => v.name), name: AS.state.session.name };
    });
    check(sess.views.join() === 'cam1,cam2', 'a project is open (2 views)', sess);
    me = await myTag();
    const counts = () => page.evaluate(() => {
        const s = window.__lucid.state.session; const per = {};
        for (const [, fg] of s.frameGroups) {
            for (const [cam, xs] of fg.instances) for (const i of xs) { const k = cam + ':' + i.type; per[k] = (per[k] || 0) + 1; }
            for (const [cam, xs] of fg.unlinkedInstances) for (const u of xs) { const k = cam + ':' + u.instance.type; per[k] = (per[k] || 0) + 1; }
        }
        return per;
    });
    const submitTagged = (spec, camera, sessionId, tagId) => page.evaluate(async ([spec, camera, sessionId, tagId, wid]) => {
        const m = await import('./pose/connect/store.js');
        const st = m.useConnectStore.getState();
        const ids = await st.submitJobsOn(wid, spec, { source: 'window', sessionId, camera, projectTag: tagId, mergeMode: 'replace', label: 'Inference · ' + camera });
        return ids;
    }, [spec, camera, sessionId, tagId, nodeId]);

    console.log('\n   a job this page submitted for a view of the open session');
    reset();
    worker.addFile('/data/sess/predictions/cam1.predictions.slp', PRED);
    await submitTagged({ type: 'track', data_path: '/data/sess/cam1/cam1.mp4', model_paths: ['/data/m'], output_path: '/data/sess/predictions/cam1.predictions.slp', project: me }, 'cam1', sess.name, me.id);
    const tagged = [...worker.jobs.values()][0];
    await worker.completeJob(tagged.job_id, { predictions: PRED });
    await page.evaluate(() => window.__wj.refresh());
    await page.waitForFunction(() => document.querySelector('#jobsHost .cj-job .cj-cam'), null, { timeout: 10000 });
    check(await page.evaluate(() => document.querySelector('#jobsHost .cj-job .cj-cam').textContent === '· cam1'), 'the row shows the view this page submitted it for ("· cam1")');
    await btn('Fetch & Load').click();
    await until(() => import('./pose/connect/store.js').then((m) => m.useConnectStore.getState().trackedJobs.some((j) => j.fetchedAt != null)), null, 60000);
    check(!(await page.$('.cj-merge')), 'merged straight away, no dialog (it is unambiguously ours)');
    const c1 = await counts();
    check(c1['cam1:predicted'] === 20, '20 predicted instances in cam1 (Replace: the old prediction on a re-inferred frame is gone)', c1);
    check(await page.evaluate(() => { const fg = window.__lucid.state.session.frameGroups.get(0); const xs = [...(fg.instances.get('cam1') || []), ...(fg.unlinkedInstances.get('cam1') || []).map((u) => u.instance)].filter((i) => i.type === 'user'); return xs.length === 1; }), 'the user label is untouched');
    check(await page.evaluate(() => window.__lucid.state.isDirty === true), 'the project is dirty');
    await page.waitForFunction(() => [...document.querySelectorAll('.connect-toast')].some((t) => /Predictions merged into cam1/.test(t.textContent)), null, { timeout: 5000 });
    check(true, 'toast "Loaded. Predictions merged into cam1."');

    console.log('\n   another session');
    reset();
    worker.addFile('/data/sess/predictions/x.predictions.slp', PRED);
    await submitTagged({ type: 'track', data_path: '/data/sess/cam1/cam1.mp4', model_paths: ['/data/m'], output_path: '/data/sess/predictions/x.predictions.slp', project: me }, 'cam1', 'some_other_session', me.id);
    const otherSess = [...worker.jobs.values()][0];
    await worker.completeJob(otherSess.job_id, { predictions: PRED });
    await page.evaluate(() => window.__wj.refresh());
    await page.waitForFunction(() => document.querySelector('#jobsHost .cj-job button[data-act="fetch"]'), null, { timeout: 10000 });
    await btn('Fetch & Load').click();
    await page.waitForSelector('.cj-merge #cjMergeDownload', { timeout: 30000 });
    const os = await page.evaluate(() => ({ text: document.querySelector('.cj-merge').textContent, merge: !!document.getElementById('cjMergeGo') }));
    check(/These results are for session some_other_session/.test(os.text) && !os.merge, 'refused with the session name; only Download .slp', os);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.cj-merge'));
    check(!(await counts())['cam2:predicted'], 'nothing was merged');

    console.log('\n   a job with no LUCID tag');
    reset();
    mkJob({ jobId: 'e_untagged2', kind: 'track', state: 'completed', project: OTHER, labels: '/data/sess/cam2/cam2.mp4', extra: { output_path: '/data/sess/predictions/u2.predictions.slp' } });
    worker.addFile('/data/sess/predictions/u2.predictions.slp', PRED);
    await worker.completeJob('e_untagged2', { predictions: PRED });
    await page.evaluate(() => window.__wj.refresh());
    await page.waitForFunction(() => document.querySelector('#jobsHost .cj-job button[data-act="fetch"]'), null, { timeout: 10000 });
    await btn('Fetch & Load').click();
    await page.waitForSelector('#cjMergeGo', { timeout: 30000 });
    const ask = await page.evaluate(() => ({
        text: document.querySelector('.cj-merge').textContent, views: [...document.querySelectorAll('#cjMergeView option')].map((o) => o.value), picked: document.getElementById('cjMergeView').value,
    }));
    check(/Predictions: .*· 10 frames|Predictions: .*· [\d,]+ frames?/.test(ask.text), 'the box names the predictions\' video and its frame count before merging', ask.text);
    check(/Open project:/.test(ask.text) && /✓Skeletonmatches/.test(ask.text.replace(/\s+/g, '')), 'the summary box: open project and the skeleton check ✓', ask.text);
    check(ask.views.join() === 'cam1,cam2' && ask.picked === 'cam2', 'asks which view; the one named in the job\'s data path (cam2) is preselected', ask);
    await page.click('#cjMergeGo');
    await page.waitForFunction(() => !document.querySelector('.cj-merge'), null, { timeout: 60000 });
    const c2 = await counts();
    check(c2['cam2:predicted'] === 20 && c2['cam1:predicted'] === 20, 'merged into cam2 only (20 predicted instances there, cam1 unchanged)', c2);
    await page.waitForFunction(() => [...document.querySelectorAll('.connect-toast')].some((t) => /Merged 20 predicted instances into cam2/.test(t.textContent)), null, { timeout: 5000 });
    check(true, 'toast reports the merge');

    console.log('\n   an untagged job whose video matches no view');
    reset();
    mkJob({ jobId: 'e_nomatch', kind: 'track', state: 'completed', project: OTHER, labels: '/data/sess/zzz/zzz.mp4', extra: { output_path: '/data/sess/predictions/nm.predictions.slp' } });
    worker.addFile('/data/sess/predictions/nm.predictions.slp', PRED);
    await worker.completeJob('e_nomatch', { predictions: PRED });
    await page.evaluate(() => window.__wj.refresh());
    await page.waitForFunction(() => document.querySelector('#jobsHost .cj-job button[data-act="fetch"]'), null, { timeout: 10000 });
    await btn('Fetch & Load').click();
    await page.waitForSelector('#cjMergeGo', { timeout: 30000 });
    const nm = await page.evaluate(() => ({ picked: document.getElementById('cjMergeView').value, disabled: document.getElementById('cjMergeGo').disabled, text: document.querySelector('.cj-merge').textContent }));
    check(nm.picked === '' && nm.disabled && /No view of this session matches/.test(nm.text), 'no view matches: nothing is preselected and Merge is disabled', nm);
    const beforeNm = await counts();
    await page.selectOption('#cjMergeView', 'cam1');
    check(await page.evaluate(() => !document.getElementById('cjMergeGo').disabled), 'picking a view enables Merge');
    check(JSON.stringify(await counts()) === JSON.stringify(beforeNm), 'nothing merged until the user clicks it');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.cj-merge'));

    console.log('\n   a job with no predictions');
    reset();
    mkJob({ jobId: 'e_none', kind: 'track', state: 'completed', result: { blobs: {} } });
    await page.evaluate(() => window.__wj.refresh());
    await page.waitForFunction(() => document.querySelector('#jobsHost .cj-job button[data-act="fetch"]'), null, { timeout: 10000 });
    await btn('Fetch & Load').click();
    await page.waitForSelector('.cj-merge .cj-merge-error', { timeout: 15000 });
    check(await page.evaluate(() => document.querySelector('.cj-merge-error').textContent === 'No predictions were found for this job.'), '"No predictions were found for this job."');
    await page.keyboard.press('Escape');
} catch (e) {
    console.log('  ✗ threw', e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
