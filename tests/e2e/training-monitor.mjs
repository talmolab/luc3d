/**
 * training-monitor.mjs — the Training Monitor (ui/training-monitor.js), opened from a progress row of
 * a remote training run against the fake SLEAP Connect worker.
 *
 *  1. A pending row does not open anything; the running row opens "Training Monitor — Centroid · all
 *     views" with sleap-app's runtime lines ("Training Epoch 3 / Total Runtime: …", "Last Epoch
 *     Validation Loss: 2.000e-2", "Best Epoch Validation Loss: 2.000e-2 (epoch 2)", numbers bold),
 *     the loss plot (legend, canvas drawn, Log scale / Ignore outliers / Batches / Reset zoom / PNG /
 *     CSV) and Stop Early / Cancel pinned at the bottom.
 *  2. New telemetry redraws it live (epoch 3 → "Training Epoch 4", "Epochs in Plateau: 1 / 10" when
 *     the validation loss stops improving).
 *  3. Stop Early in the monitor sends jobs.cancel {mode: "stop"}; once that model is done its monitor
 *     has no Stop / Cancel; Esc closes it and playback keys stay off while it is open.
 *  4. The finished row reopens its own monitor; the second model's row opens the second model.
 *
 * Usage: node tests/e2e/training-monitor.mjs   (PORT= to move its server; SHOT=<png> saves the open monitor)
 */
import { FakeWorker } from '../connect/fake-worker.mjs';
import { runConnectE2E, check, fail, watchPage, pair, store } from './fixtures/connect-e2e.mjs';
import { loadTrainingSession } from './fixtures/training-session.js';

const WS = 'ws://127.0.0.1:9643';

await runConnectE2E(9397, async ({ browser, BASE }) => {
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
    page.setDefaultTimeout(60000);
    watchPage(page, { consoleTypes: /error/i });
    const worker = await FakeWorker.create({ mounts: [{ path: '/data', label: 'Data' }], serveFolder: '/data', cancelRunning: 'manual' });
    for (const p of ['/data/sess/cam1/cam1.mp4', '/data/sess/cam2/cam2.mp4']) worker.addFile(p, 'x');
    worker.addDir('/data/sess');
    await worker.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9643/);

    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    await page.waitForSelector('.panel-rail-btn[data-tab="tabTraining"]', { state: 'attached' });
    await page.evaluate(async () => { (await import('./ui/training-panel.js')).showTrainingPanel(); });
    await loadTrainingSession(page);
    await page.selectOption('#trnModelType', 'top_down');
    await pair(page, worker, WS);
    await page.waitForFunction(() => document.querySelectorAll('#trnBackend option').length >= 1 && !document.getElementById('trnBackend').hidden);
    await page.selectOption('#trnBackend', worker.nodeId);
    await page.waitForFunction(() => /Connected/.test(document.getElementById('trnBackendStatus').textContent), null, { timeout: 20000 });
    await store(page, (s, id) => s.addPathRule(id, { local: 'rec', worker: '/data/sess' }), worker.nodeId);
    await page.evaluate(async () => { (await import('./ui/training-panel.js'))._trainingAnalyze(); });
    await page.waitForFunction(() => !document.getElementById('trnStart').disabled, null, { timeout: 20000 });
    await page.click('#trnStart');
    await waitFor(() => worker.jobs.size >= 1, 20000);
    const j1 = [...worker.jobs.values()][0];
    worker.setJobState(j1.job_id, 'running');
    worker.epoch(j1.job_id, 0, 0.05, 0.04);
    worker.epoch(j1.job_id, 1, 0.03, 0.02);
    worker.metric(j1.job_id, { epoch: 2, total_epochs: 200, latest_train_loss: 0.03, latest_val_loss: 0.02 });
    worker.curve(j1.job_id, [[0, 0.08], [3, 0.05], [7, 0.04], [11, 0.03]]);
    await page.waitForFunction(() => /2 \/ 200 epochs/.test(document.querySelector('#trnRows .trn-row').textContent), null, { timeout: 20000 });

    console.log('\n1. Open the running model\'s monitor');
    check(await page.evaluate(() => !document.querySelectorAll('#trnRows .trn-row')[1].querySelector('.trn-row-open')), 'a pending row has nothing to open');
    await page.click('#trnRows .trn-row .trn-row-open');
    await page.waitForSelector('#trnMonitor');
    const m1 = await page.evaluate(() => ({
        title: document.getElementById('trnMonTitle').textContent,
        lines: Array.from(document.querySelectorAll('#trnMonRuntime > div')).map((d) => d.textContent),
        bold: Array.from(document.querySelectorAll('#trnMonRuntime strong')).map((s) => s.textContent).slice(0, 3),
        legend: Array.from(document.querySelectorAll('#trnMonitor .cj-loss-key')).map((k) => k.textContent),
        tools: Array.from(document.querySelectorAll('#trnMonitor .cj-loss-opts label, #trnMonitor .cj-loss-tool')).map((x) => x.textContent.trim()),
        drawn: (() => { const c = document.querySelector('#trnMonitor canvas'); return !!c && c.width > 0 && c.offsetParent !== null; })(),
        oneLineTitleHidden: document.querySelector('#trnMonitor .cj-loss-title').hidden,
        stop: !document.querySelector('#trnMonitor .trn-mon-foot').hidden,
    }));
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });   // SHOT=<png> keeps a picture of the open monitor
    check(m1.title === 'Training Monitor — Centroid · all views', 'title names the model', m1.title);
    check(/^Training Epoch 3 \/ Total Runtime: \d\d:\d\d \/ Epoch Runtime: \d\d:\d\d$/.test(m1.lines[0]) &&
        m1.lines.includes('Last Epoch Validation Loss: 2.000e-2') && m1.lines.includes('Best Epoch Validation Loss: 2.000e-2 (epoch 2)') &&
        m1.lines.some((l) => /^Mean Time per Epoch: \d\d:\d\d \/ ETA Next 10 Epochs: \d+ min$/.test(l)), 'sleap-app\'s runtime lines', m1.lines);
    check(m1.bold[0] === '3', 'numbers are bold', m1.bold);
    check(m1.legend.join() === 'Batch Training Loss,Epoch Training Loss,Epoch Validation Loss,Best Validation Loss', 'the four series', m1.legend);
    check(['Log scale', 'Ignore outliers', 'Reset zoom', 'PNG', 'CSV'].every((x) => m1.tools.some((t) => t.startsWith(x))) && m1.tools.some((t) => /^Batches:/.test(t)),
        'Log scale, Ignore outliers, Batches, Reset zoom, PNG, CSV', m1.tools);
    check(m1.drawn && m1.oneLineTitleHidden, 'the plot is drawn; its one-line title gives way to the runtime lines');
    check(m1.stop, 'Stop Early / Cancel are pinned at the bottom while this model trains');

    console.log('\n2. Live redraw');
    worker.epoch(j1.job_id, 2, 0.025, 0.021);
    await page.waitForFunction(() => {
        const ls = Array.from(document.querySelectorAll('#trnMonRuntime > div')).map((d) => d.textContent);
        return /^Training Epoch 4 /.test(ls[0]) && ls.includes('Epochs in Plateau: 1 / 10');
    }, null, { timeout: 20000 });
    check(true, 'a new epoch redraws: Training Epoch 4, Epochs in Plateau: 1 / 10 (patience from the preset)');

    console.log('\n3. Stop Early from the monitor, Esc, playback keys');
    const before = await page.evaluate(() => window.__lucid.state.currentFrame);
    await page.keyboard.press('ArrowRight');
    check(await page.evaluate(() => window.__lucid.state.currentFrame) === before, 'playback keys do nothing while the monitor is open');
    await page.click('#trnMonStopEarly');
    await waitFor(() => worker.jobs.get(j1.job_id).cancelRequested === 'stop');
    check(true, 'Stop Early → jobs.cancel {mode: "stop"}');
    await worker.completeJob(j1.job_id, { extra: { model_dir: '/data/sess/models/c1' } });
    await waitFor(() => worker.jobs.size >= 2, 20000);
    await page.waitForFunction(() => document.querySelector('#trnMonitor .trn-mon-foot').hidden, null, { timeout: 20000 });
    check(true, 'once that model is done, its monitor has no Stop / Cancel');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('trnMonitor'));
    check(true, 'Esc closes the monitor');

    console.log('\n4. Reopen per row');
    const j2 = [...worker.jobs.values()][1];
    worker.setJobState(j2.job_id, 'running');
    worker.epoch(j2.job_id, 0, 0.09, 0.08);
    await page.waitForFunction(() => document.querySelectorAll('#trnRows .trn-row-open').length === 2, null, { timeout: 20000 });
    await page.click('#trnRows .trn-row:nth-child(2) .trn-row-open');
    await page.waitForSelector('#trnMonitor');
    check(await page.evaluate(() => document.getElementById('trnMonTitle').textContent) === 'Training Monitor — Centered Instance · all views', 'row 2 opens the second model');
    await page.click('#trnMonitor .trn-mon-x');
    await page.click('#trnRows .trn-row:nth-child(1) .trn-row-open');
    await page.waitForSelector('#trnMonitor');
    const m4 = await page.evaluate(() => ({ title: document.getElementById('trnMonTitle').textContent, foot: document.querySelector('#trnMonitor .trn-mon-foot').hidden,
        lines: Array.from(document.querySelectorAll('#trnMonRuntime > div')).map((d) => d.textContent) }));
    check(m4.title === 'Training Monitor — Centroid · all views' && m4.foot && !/Epoch Runtime/.test(m4.lines[0]),
        'the finished row reopens its monitor: no Stop / Cancel, no epoch runtime', m4);

    async function waitFor(pred, ms = 10000) {
        const t0 = Date.now();
        while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 100)); }
    }
}, { onError: async (e) => { console.log('  ✗ threw: ' + (e && e.stack || e)); fail(); } });
