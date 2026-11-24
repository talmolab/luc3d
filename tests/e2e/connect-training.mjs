/**
 * connect-training.mjs — the Training panel trains on a paired SLEAP Connect worker, end to end in
 * the WEB app against the fake worker (`tests/connect/fake-worker.mjs`).
 *
 *  1. Web build: the Training panel sits between Inference and Connect (sleap-app's order); it
 *     defaults to Top-Down with the Medium RF presets; Start waits for a session.
 *  2. A session (2 views, user labels on 6 frames of each, a prediction elsewhere): the views list
 *     shows 6 labelled frames each; Start asks for a worker.
 *  3. Pair, pick the worker in the panel's Backend: both views are "not located on the worker yet";
 *     ONE Locate on worker… places both; the output folder is the session's folder on the worker.
 *  4. Start (Max Epochs 3): one `train` job per model, centroid first: inline `labels_content` (a
 *     training .slp naming the worker videos, 12 user instances, no prediction), the config with
 *     max_epochs 3, W&B off and the run name, which the store hoists into `run_name`; the project
 *     tag and output_dir. Telemetry fills the row ("Training: Centroid · all views (1/2)",
 *     "1 / 3 epochs", "loss: 0.0200").
 *  5. Stop Early: `jobs.cancel {mode: "stop"}` on the running job only; it completes (sleap-nn exits 0)
 *     and the centered-instance job follows; both done → Complete, both model folders listed, Next
 *     step, Train Again. Post-training inference (default Random sample): the Inference panel submits
 *     one `track` job per view with both trained folders; the box points to Fetch & Load.
 *  6. One per view: Train Again → Start sends cam1's job only (one video in its file); Cancel sends
 *     `mode: "cancel"`; the run ends Failed "Training cancelled", the row "cancelled", nothing more is
 *     submitted.
 *     View Metrics reads the runs ON THE WORKER (`fs.stat` / `fs.read`): run.centroid's real metrics JSON
 *     gives its numbers, run.centered_instance (no metrics file) shows "—"; no Add Trained Model(s)… there.
 *  7. Retry with Resume from a worker checkpoint (typed in Full Configuration: a worker has no folder picker)
 *     → the centroid job's config resumes from it (`resume_ckpt_path`), the other model's does not; then the
 *     failing job: the error banner names the model and "exit code 1", and Error output (sleap-nn) shows the
 *     worker's error line.
 *  8. The Inference panel's Backend keeps its own ids (two pickers on one page).
 *
 * Usage: node tests/e2e/connect-training.mjs   (PORT= to move its server)
 */
import { FakeWorker } from '../connect/fake-worker.mjs';
import { runConnectE2E, check, fail, watchPage, pair } from './fixtures/connect-e2e.mjs';
import { loadTrainingSession } from './fixtures/training-session.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const METRICS_JSON = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sleap-nn-training', 'run.full', 'metrics.val.0.json'), 'utf8');

const WS = 'ws://127.0.0.1:9641';

await runConnectE2E(9395, async ({ browser, BASE }) => {
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    watchPage(page, { consoleTypes: /error/i });

    const worker = await FakeWorker.create({ mounts: [{ path: '/data', label: 'Data' }], serveFolder: '/data', cancelRunning: 'manual' });
    for (const p of ['/data/sess/cam1/cam1.mp4', '/data/sess/cam2/cam2.mp4']) worker.addFile(p, 'x');
    worker.addDir('/data/sess');
    await worker.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9641/);

    console.log('\n1. Web build');
    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    await page.waitForSelector('.panel-rail-btn[data-tab="tabTraining"]', { state: 'attached' });
    await page.waitForSelector('.panel-rail-btn[data-tab="tabConnect"]', { state: 'attached' });
    const order = await page.evaluate(() => Array.from(document.querySelectorAll('#panelRail .panel-rail-btn')).map((b) => b.dataset.tab).slice(-3));
    check(order.join() === 'tabInference,tabTraining,tabConnect', 'rail order: Inference, Training, Connect (sleap-app)', order);
    await page.evaluate(async () => { (await import('./ui/training-panel.js')).showTrainingPanel(); });
    await page.waitForFunction(() => /Open a session/.test(document.getElementById('trnWhy').textContent));
    const t1 = await page.evaluate(async () => {
        const s = (await import('./ui/training-panel.js'))._trainingState();
        return {
            type: s.cfg.modelType, slots: Object.values(s.cfg.slots).map((x) => x.name),
            options: Array.from(document.querySelectorAll('#trnModelType option')).map((o) => o.textContent + (o.disabled ? ' [off]' : '')),
            start: document.getElementById('trnStart').textContent.trim(),
        };
    });
    check(t1.type === 'top_down' && t1.slots.join() === 'Preset: Centroid (Medium RF),Preset: Centered Instance (Medium RF)', 'Top-Down with the Medium RF presets', t1);
    check(t1.options.filter((o) => /\[off\]/.test(o)).length === 2 && t1.options.some((o) => /Box Detector \(needs box labels\) \[off\]/.test(o)),
        'box-detector types are disabled with "(needs box labels)"', t1.options);
    check(t1.start === 'Start Remote Training', 'the button reads Start Remote Training', t1.start);

    console.log('\n2. A session with user labels');
    const sess = await loadTrainingSession(page);
    check(sess.views.join() === 'cam1,cam2', 'session loaded', sess);
    const rows2 = await page.evaluate(() => Array.from(document.querySelectorAll('#trnViews .trn-vrow')).map((r) => r.dataset.view + ':' + r.querySelector('.trn-vcount').textContent));
    check(rows2.join() === 'cam1:6 frames,cam2:6 frames', 'each view lists its 6 labelled frames (predictions do not count)', rows2);
    check(await page.evaluate(() => /^12 labelled frames · 12 user instances · 2 videos$/.test(document.getElementById('trnDataSummary').textContent)), 'summary: 12 frames, 12 instances, 2 videos');
    check(await page.evaluate(() => document.getElementById('trnWhy').textContent === 'Select a worker' && document.getElementById('trnStart').disabled), 'Start asks for a worker');
    const rec = await page.evaluate(() => ({ type: document.getElementById('trnModelType').value, rec: document.getElementById('trnRecommendation').textContent,
        star: Array.from(document.querySelectorAll('#trnModelType option')).find((o) => /★/.test(o.textContent)).value }));
    check(rec.type === 'single_animal' && rec.star === 'single_animal' && /Only one animal per frame/.test(rec.rec),
        'one animal per frame: Single Animal is recommended (★) and auto-selected, as sleap-app does for an untouched type', rec);
    await page.selectOption('#trnModelType', 'top_down');
    await page.evaluate(async () => { (await import('./ui/training-panel.js'))._trainingAnalyze(); });
    const picked = await page.evaluate(() => ({ type: document.getElementById('trnModelType').value, rec: document.getElementById('trnRecommendation').textContent }));
    check(picked.type === 'top_down' && /^\s*Recommended: Single Animal — Only one animal per frame$/.test(picked.rec),
        'picking Top-Down sticks; the line says what is recommended instead', picked);

    console.log('\n3. Pair, pick the worker, Locate once');
    await pair(page, worker, WS);
    await page.waitForFunction(() => document.querySelectorAll('#trnBackend option').length >= 1 && !document.getElementById('trnBackend').hidden);
    await page.selectOption('#trnBackend', worker.nodeId);
    await page.waitForFunction(() => /Connected/.test(document.getElementById('trnBackendStatus').textContent), null, { timeout: 20000 });
    check(true, 'the panel\'s Backend connected the worker');
    check(await page.evaluate(() => !!document.getElementById('infBackend') && !!document.getElementById('trnBackend') && document.querySelectorAll('#infBackend').length === 1),
        'two Backend pickers on one page keep their own ids');
    await page.waitForFunction(() => document.querySelectorAll('#trnViews .trn-locate').length === 2, null, { timeout: 20000 });
    check(await page.evaluate(() => /Locate each view/.test(document.getElementById('trnWhy').textContent)), 'Start asks to locate the videos');
    await page.click('#trnViews .trn-locate');
    await page.waitForSelector('#remoteFileBrowser .rfb-entry');
    const dbl = (name) => page.dblclick(`#remoteFileBrowser .rfb-entry[data-name="${name}"]`);
    await dbl('sess'); await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="cam1"]');
    await dbl('cam1'); await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="cam1.mp4"]');
    await dbl('cam1.mp4');
    await page.waitForFunction(() => !document.getElementById('remoteFileBrowser'));
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#trnViews .trn-vworker-text')).map((e) => e.textContent).join() ===
        '/data/sess/cam1/cam1.mp4,/data/sess/cam2/cam2.mp4', null, { timeout: 20000 });
    check(true, 'one Locate placed both views');
    await page.waitForFunction(() => document.querySelector('#trnOutput .trn-path').textContent === '/data/sess/models', null, { timeout: 20000 });
    check(true, 'output: the session\'s folder on the worker (models go in /data/sess/models)');

    console.log('\n4. Start: one train job per model');
    await page.fill('#trnMaxEpochs', '3');
    await page.dispatchEvent('#trnMaxEpochs', 'change');
    await page.click('.trn-tabs .trn-seg-btn[data-slot="centered_instance"]');
    await page.fill('#trnMaxEpochs', '3');
    await page.dispatchEvent('#trnMaxEpochs', 'change');
    await page.waitForFunction(() => !document.getElementById('trnStart').disabled, null, { timeout: 20000 });
    await page.click('#trnStart');
    await waitJobs(1);
    let jobs = [...worker.jobs.values()];
    const j1 = jobs[0];
    const spec1 = await describeSpec(j1.spec);
    check(j1.spec.type === 'train' && j1.spec.config_contents.length === 1 && j1.spec.model_types.join() === 'centroid', 'job 1 trains the centroid model', j1.spec.model_types);
    check(/^'\d{6}_\d{6}\.centroid\.n=12'$/.test(j1.spec.run_name || ''), 'the run name is hoisted from the config (Hydra-quoted)', j1.spec.run_name);
    check(spec1.config.max_epochs === 3 && spec1.config.use_wandb === false && /centroid\.n=12$/.test(spec1.config.run_name), 'config: max_epochs 3, W&B off, run name', spec1.config);
    check(spec1.labels.videos.join() === '/data/sess/cam1/cam1.mp4,/data/sess/cam2/cam2.mp4' && spec1.labels.frames === 12 && spec1.labels.types.join() === '0',
        'labels_content: the worker videos, 12 frames of user instances only', spec1.labels);
    check(j1.spec.output_dir === '/data/sess' && j1.spec.project && /^[0-9a-f]{8}$/.test(j1.spec.project.id), 'output_dir and the project tag', { out: j1.spec.output_dir, project: j1.spec.project });
    check(!j1.spec.val_labels_path && !j1.spec.labels_path, 'no worker labels path, no validation file');

    worker.setJobState(j1.job_id, 'running');
    worker.log(j1.job_id, 'Epoch 0: 100%|##########| 6/6 [00:01<00:00]');
    worker.epoch(j1.job_id, 0, 0.02, 0.03);
    worker.metric(j1.job_id, { epoch: 1, total_epochs: 3, latest_train_loss: 0.02, latest_val_loss: 0.03 });
    worker.curve(j1.job_id, [[0, 0.05], [5, 0.02]]);
    await page.waitForFunction(() => {
        const r = document.querySelector('#trnRows .trn-row');
        return r && /^Training: Centroid · all views \(1\/2\)$/.test(r.querySelector('.trn-row-text').textContent) && /1 \/ 3 epochs/.test(r.textContent) && /loss: 0\.0200/.test(r.textContent);
    }, null, { timeout: 20000 });
    check(true, 'telemetry fills the row: Training: Centroid · all views (1/2), 1 / 3 epochs, loss 0.0200');
    check(await page.evaluate(() => /Centered Instance · all views \(pending\)/.test(document.querySelectorAll('#trnRows .trn-row')[1].textContent)), 'the second model is pending');

    console.log('\n5. Stop Early, then the next model');
    await page.click('#trnStopEarly');
    await page.waitForFunction(() => true);
    await waitFor(() => worker.jobs.get(j1.job_id).cancelRequested === 'stop');
    check(worker.jobs.get(j1.job_id).cancelRequested === 'stop', 'Stop Early → jobs.cancel {mode: "stop"} on the running job');
    await worker.completeJob(j1.job_id, { extra: { model_dir: '/data/sess/models/run.centroid', labels_path: '/data/jr/labels.slp' } });
    await waitJobs(2);
    jobs = [...worker.jobs.values()];
    const j2 = jobs[1];
    check(j2.spec.model_types.join() === 'centered_instance' && /centered_instance\.n=12'$/.test(j2.spec.run_name), 'job 2 trains the centered instance model', j2.spec.run_name);
    await page.waitForFunction(() => /Centroid · all views — 1 epochs, best val_loss: 0\.0300/.test(document.querySelector('#trnRows .trn-row').textContent), null, { timeout: 20000 });
    check(true, 'row 1: 1 epochs, best val_loss 0.0300');
    worker.setJobState(j2.job_id, 'running');
    worker.epoch(j2.job_id, 0, 0.05, 0.06);
    await worker.completeJob(j2.job_id, { extra: { model_dir: '/data/sess/models/run.centered_instance' } });
    await page.waitForFunction(() => /Complete/.test(document.querySelector('#trnProgress .inf-status-text').textContent), null, { timeout: 20000 });
    const done = await page.evaluate(() => ({
        banner: document.querySelector('#trnProgress .trn-banner-ok').textContent,
        models: Array.from(document.querySelectorAll('#trnModels .trn-path-ok')).map((e) => e.textContent),
        next: !document.querySelector('.trn-banner-next').hidden,
        again: !document.getElementById('trnTrainAgain').hidden,
    }));
    check(/All 2 models trained successfully/.test(done.banner) && done.models.join() === '/data/sess/models/run.centroid,/data/sess/models/run.centered_instance' &&
        done.next && done.again, 'Complete: both model folders listed, Next step, Train Again', done);
    await page.waitForFunction(() => { const b = document.getElementById('trnPostInference'); return b && !b.hidden && !/Submitting/.test(b.textContent); }, null, { timeout: 40000 });
    const post = await page.evaluate(async () => ({ box: document.getElementById('trnPostInference').textContent,
        inf: (await import('./ui/inference-panel.js'))._inferenceState().cfg.frameRange }));
    const tracks = [...worker.jobs.values()].filter((j) => j.spec.type === 'track').map((j) => ({ data: j.spec.data_path, models: j.spec.model_paths, frames: j.spec.frames, out: j.spec.output_path }));
    check(/Post-training inference submitted/.test(post.box) && /Fetch & Load/.test(post.box) && post.inf === 'random',
        'post-training inference: submitted by the Inference panel (Random sample), Fetch & Load named', post);
    check(tracks.length === 2 && tracks.map((t) => t.data).join() === '/data/sess/cam1/cam1.mp4,/data/sess/cam2/cam2.mp4' &&
        tracks.every((t) => t.models.join() === '/data/sess/models/run.centroid,/data/sess/models/run.centered_instance' && t.frames === tracks[0].frames),
        'one track job per view with both trained folders (centroid first), the same frames', tracks);
    worker.addDir('/data/sess/models/run.centroid');
    worker.addFile('/data/sess/models/run.centroid/metrics.val.0.json', METRICS_JSON);
    worker.addFile('/data/sess/models/run.centroid/training_config.yaml',
        'model_config:\n  head_configs:\n    centroid:\n      confmaps: {sigma: 2.5}\n  backbone_config:\n    unet: {max_stride: 16, filters: 16}\ntrainer_config:\n  run_name: 261123_101500.centroid.n=12\n');
    await page.click('#trnViewMetrics');
    await page.waitForFunction(() => document.querySelectorAll('#trnMetrics .tmd-row').length === 2, null, { timeout: 20000 });
    const mt = await page.evaluate(() => ({ rows: Array.from(document.querySelectorAll('#trnMetrics .tmd-row')).map((r) => Array.from(r.cells).map((c) => c.textContent)),
        add: !document.getElementById('tmdAdd').hidden }));
    const oks = JSON.parse(METRICS_JSON).voc_metrics['oks_voc.mAP'].toFixed(4);
    check(mt.rows[0][0] === 'run.centroid' && mt.rows[0][1] === '2026-11-23 10:15:00' && mt.rows[0][2] === 'Centroid' && mt.rows[0][4] === oks &&
        mt.rows[1][4] === '\u2014' && !mt.add, 'View Metrics reads the runs on the worker: the real numbers, "—" without a metrics file, no Add', mt);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('trnMetrics'));

    console.log('\n6. One per view, then Cancel');
    await page.click('#trnTrainAgain');
    await page.click('.trn-seg-btn[data-mode="perview"]');
    await page.waitForFunction(() => document.querySelectorAll('#trnGroups .trn-chip').length === 2);
    const before = worker.jobs.size;
    await page.click('#trnStart');
    await waitJobs(before + 1);
    const j3 = [...worker.jobs.values()][before];
    const spec3 = await describeSpec(j3.spec);
    check(spec3.labels.videos.join() === '/data/sess/cam1/cam1.mp4' && spec3.labels.frames === 6 && /centroid\.cam1\.n=6'$/.test(j3.spec.run_name),
        'cam1\'s job: only its video, 6 frames, a per-view run name', { videos: spec3.labels.videos, run: j3.spec.run_name });
    worker.setJobState(j3.job_id, 'running');
    await page.click('#trnCancel');
    await waitFor(() => worker.jobs.get(j3.job_id).cancelRequested === 'cancel');
    check(true, 'Cancel → jobs.cancel {mode: "cancel"}');
    worker.setJobState(j3.job_id, 'canceled', { detail: 'canceled by request' });
    await page.waitForFunction(() => /Failed/.test(document.querySelector('#trnProgress .inf-status-text').textContent), null, { timeout: 20000 });
    const can = await page.evaluate(() => ({ err: document.getElementById('trnError').textContent, row: document.querySelector('#trnRows .trn-row').textContent }));
    check(can.err === 'Training cancelled' && /cancelled at epoch 0/.test(can.row), 'Failed: "Training cancelled", the row cancelled', can);
    await new Promise((r) => setTimeout(r, 800));
    check(worker.jobs.size === before + 1, 'nothing more was submitted after Cancel', worker.jobs.size - before);

    console.log('\n7. Retry with Resume from a worker checkpoint, then a failing job');
    await page.click('#trnRetry');
    await page.click('#trnFullConfig');
    await page.waitForSelector('#trnConfigDialog');
    await page.click('#trnConfigDialog .tcd-tabs .trn-seg-btn[data-tab="centroid"]');
    await page.check('#tcdMode input[value="resume"]');
    const rm = await page.evaluate(() => ({ text: !document.getElementById('tcdCheckpoint').hidden, choose: !document.getElementById('tcdChooseCheckpoint').hidden,
        why: document.getElementById('trnWhy').textContent }));
    check(rm.text && !rm.choose && /Centroid: Choose the checkpoint to resume from/.test(rm.why), 'remote: the checkpoint is a worker path typed in; Start waits for it', rm);
    await page.fill('#tcdCheckpoint', '/data/sess/models/run.centroid/best.ckpt');
    await page.dispatchEvent('#tcdCheckpoint', 'change');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('trnConfigDialog'));
    const before2 = worker.jobs.size;
    await page.waitForFunction(() => !document.getElementById('trnStart').disabled, null, { timeout: 20000 });
    await page.click('#trnStart');
    await waitJobs(before2 + 1);
    const rcfg = await page.evaluate(async (c) => { const Y = await import('yaml'); const d = Y.parse(c); return { resume: d.trainer_config.resume_ckpt_path, bb: d.model_config.pretrained_backbone_weights }; },
        [...worker.jobs.values()][before2].spec.config_contents[0]);
    check(rcfg.resume === '/data/sess/models/run.centroid/best.ckpt' && rcfg.bb == null, 'the centroid job resumes from the worker checkpoint (resume_ckpt_path)', rcfg);
    const j4 = [...worker.jobs.values()][before2];
    worker.setJobState(j4.job_id, 'running');
    worker.log(j4.job_id, 'Traceback (most recent call last):');
    worker.log(j4.job_id, 'RuntimeError: CUDA out of memory.');
    worker.failJob(j4.job_id, 'exit code 1');
    await page.waitForFunction(() => /Failed/.test(document.querySelector('#trnProgress .inf-status-text').textContent), null, { timeout: 20000 });
    const fl = await page.evaluate(() => ({ err: document.getElementById('trnError').textContent, out: document.querySelector('.trn-errout pre').textContent,
        outShown: !document.querySelector('.trn-errout').hidden }));
    check(/^Training Centroid · cam1 failed: exit code 1/.test(fl.err), 'the error names the model and the exit code', fl.err);
    check(fl.outShown && /CUDA out of memory/.test(fl.out), 'Error output (sleap-nn) shows the worker\'s error line', fl.out);

    async function waitJobs(n) { await waitFor(() => worker.jobs.size >= n, 20000); }
    async function waitFor(pred, ms = 10000) {
        const t0 = Date.now();
        while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 100)); }
    }
    async function describeSpec(spec) {
        return page.evaluate(async (s) => {
            const Y = await import('yaml');
            const cfg = Y.parse(s.config_contents[0]);
            const bin = atob(s.labels_content);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const h5 = await import('h5wasm');
            await h5.ready;
            const p = '/__trn_' + Math.random().toString(36).slice(2) + '.slp';
            h5.FS.writeFile(p, bytes);
            const f = new h5.File(p, 'r');
            const inst = f.get('instances');
            const cols = JSON.parse(inst.attrs.field_names.value);
            const v = Array.from(inst.value, Number), nc = cols.length, ti = cols.indexOf('instance_type');
            const types = new Set();
            for (let r = 0; r < v.length / nc; r++) types.add(v[r * nc + ti]);
            const out = {
                config: { max_epochs: cfg.trainer_config.max_epochs, use_wandb: cfg.trainer_config.use_wandb, run_name: cfg.trainer_config.run_name },
                labels: { frames: f.get('frames').shape[0], types: [...types], videos: Array.from(f.get('videos_json').value, (x) => JSON.parse(x).backend.filename) },
            };
            f.close(); h5.FS.unlink(p);
            return out;
        }, spec);
    }
}, {
    onError: async (e) => { console.log('  ✗ threw: ' + (e && e.stack || e)); fail(); },
});
