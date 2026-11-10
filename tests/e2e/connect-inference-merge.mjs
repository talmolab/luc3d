/**
 * connect-inference-merge.mjs — remote inference on a paired SLEAP Connect
 * worker, end to end in the WEB app against the fake worker
 * (`tests/connect/fake-worker.mjs`, over the page's WebSocket by
 * `routeWebSocket`; its blob port is a real HTTP server with no CORS, so the
 * page's blob fetch fails exactly like against a real worker and the `fs.read`
 * fallback does the download).
 *
 *  1. Web build: the Inference panel exists, Backend has no Local; before a
 *     worker is chosen Run says to connect one.
 *  2. Pair, pick the worker in Backend (it connects); the two views are "not
 *     located on the worker yet"; ONE Locate on worker… (through the worker
 *     file browser: double-click folders, double-click the file) places both
 *     (a rule for the session folder); a model is picked on the worker
 *     (Browse Worker, Choose Folder); the output folder is the session's own
 *     folder on the worker.
 *  3. Run: one `track` job per view, all in one `run`, each with its own
 *     data_path, the model, an explicit output_path
 *     /data/sess/predictions/<session>__<view>.<stamp>.predictions.slp,
 *     the project tag, no frames (whole video); progress comes from the job's
 *     log; Cancel is offered while running.
 *  4. The worker completes both jobs (predictions fixture, 20 instances on
 *     frames 0-9, also written at output_path): Fetch & Load Results is
 *     offered; clicking it downloads through fs.read, merges with Replace:
 *     20 predicted instances per view, the user label untouched, the old
 *     prediction on a re-inferred frame replaced; the jobs are marked fetched.
 *  5. Reload: completed-but-unfetched jobs come back as "Predictions ready"
 *     and Fetch & Load works after a reload; results of another session are
 *     refused with a message.
 *  6. Two views whose videos resolve to the same worker file are refused.
 *  7. Esc closes the file browser.
 *  9. A failed job says why: the worker's "exit code 1" plus the log's exception line; after the
 *     worker is forgotten the run box says nothing is left to load, not "Predictions ready".
 * 10. The worker file browser at 375 px: the card fits the window, names stay readable, and a click in it
 *     does not store the clamped size as the user's own.
 * 11. Parity fixes: Device / Runtime are hidden for a remote run; Run waits until every checked view is on the
 *     worker and until a finished run is Dismissed; progress shows frames / % / fps / ETA ("Initializing..."
 *     first), the log carries the echoed spec and each job's worker lines, with Expand and Copy Log; a
 *     result is merged with the mode recorded at Run (Keep), not the panel's current one; a big folder
 *     sorted by Size loads every batch in the background; the file browser keeps app shortcuts off the view
 *     behind it and traps Tab; long names keep their last 12 characters; its notice can be dismissed.
 *  8. The panel's 2 s refresh does not replace what the user is using: a focused view checkbox / model
 *     button keeps focus and stays the same element, and a click held across a refresh still lands.
 *
 * Usage: node tests/e2e/connect-inference-merge.mjs   (PORT= to move its server)
 */
import fs from 'node:fs';
import path from 'node:path';
import { FakeWorker } from '../connect/fake-worker.mjs';
import { runConnectE2E, check, fail, watchPage, repoRoot, pair } from './fixtures/connect-e2e.mjs';

const PRED = new Uint8Array(fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'sleap-nn-predictions', 'two-node.predictions.slp')));
const WS = 'ws://127.0.0.1:9631';

let context; // read by onError's diagnostic dump
await runConnectE2E(9393, async ({ browser, BASE }) => {
    context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    watchPage(page, { consoleTypes: /error|warn/i });

    const worker = await FakeWorker.create({ mounts: [{ path: '/data', label: 'Data' }], serveFolder: '/data', workerInfo: { hostname: 'gpu-box' } });
    await worker.startBlobServer();
    for (const p of ['/data/models/td/training_config.yaml', '/data/sess/cam1/cam1.mp4', '/data/sess/cam2/cam2.mp4', '/data/sess/notes.txt']) worker.addFile(p, 'x');
    worker.addDir('/data/sess/predictions');
    await worker.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9631/);

    const loadSession = () => page.evaluate(async () => {
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
            const cams = CAMS.map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [W, H]));
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
    const boot = async () => {
        await page.goto(`${BASE}/index.html`);
        await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
        await page.waitForSelector('.panel-rail-btn[data-tab="tabInference"]');
        await page.waitForSelector('.panel-rail-btn[data-tab="tabConnect"]');
    };
    const openPanel = () => page.evaluate(async () => { (await import('./ui/inference-panel.js')).showInferencePanel(); await new Promise((r) => setTimeout(r, 300)); });
    const store = (fn, ...a) => page.evaluate(([f, args]) => import('./pose/connect/store.js').then((m) => (0, eval)('(' + f + ')')(m.useConnectStore.getState(), ...args)), [fn.toString(), a]);
    const viewRows = () => page.evaluate(() => Array.from(document.querySelectorAll('#infRemoteViews .inf-view')).map((r) => ({
        view: r.dataset.view, text: r.querySelector('.inf-view-file').textContent, locate: !!r.querySelector('.inf-locate'),
    })));
    const dbl = (name) => page.dblclick(`#remoteFileBrowser .rfb-entry[data-name="${name}"]`);
    const browserOpen = () => page.waitForSelector('#remoteFileBrowser .rfb-entry');

    console.log('\n1. Web build');
    await boot();
    const w1 = await page.evaluate(() => ({
        backend: Array.from(document.querySelectorAll('#infBackend option')).map((o) => o.textContent).filter((t) => !/Select a worker/.test(t)),
        empty: { hidden: document.getElementById('infBackendEmpty').hidden, text: document.getElementById('infBackendEmpty').textContent },
        selectHidden: document.getElementById('infBackend').hidden,
        devRt: Array.from(document.querySelectorAll('#tabInference .inf-row')).filter((r) => /^(Device|Runtime)/.test(r.textContent)).map((r) => r.hidden),
        why: Array.from(document.querySelectorAll('#tabInference .inf-run ~ .inf-muted')).map((e) => e.textContent).join('|'),
        order: Array.from(document.querySelectorAll('#panelRail .panel-rail-btn')).map((b) => b.dataset.tab).slice(-2),
    }));
    check(w1.backend.length === 0 && w1.empty.hidden === false && /Connect to a worker in the Connect tab to start remote inference\./.test(w1.empty.text) && w1.selectHidden,
        'web with no worker paired: no blank select, sleap-app\'s empty-state text instead', w1);
    check(w1.devRt.length === 2 && w1.devRt.every(Boolean), 'Device and Runtime are hidden when the backend is remote', w1.devRt);
    check(w1.order.join() === 'tabInference,tabConnect', 'rail order: Inference before Connect', w1.order);
    await openPanel();
    check(await page.evaluate(() => document.getElementById('infRun').disabled), 'Run disabled with nothing set up');

    console.log('\n2. Pair, select the worker, Locate once, pick a model');
    const sess = await loadSession();
    check(sess.views.join() === 'cam1,cam2', 'session loaded', sess);
    await pair(page, worker, WS);
    await page.waitForFunction(() => document.querySelectorAll('#infBackend option').length >= 1 && !document.getElementById('infBackend').hidden);
    const chosen = await page.evaluate(() => { const sel = document.getElementById('infBackend'); return sel.selectedIndex < 0 ? null : sel.options[sel.selectedIndex].textContent; });
    check(chosen !== null, 'paired but not yet chosen: the select is never blank', chosen);
    const nodeId = worker.nodeId;
    await page.selectOption('#infBackend', nodeId);
    await page.waitForFunction(() => /Connected/.test(document.getElementById('infBackendStatus').textContent), null, { timeout: 20000 });
    check(true, 'selecting the worker connected to it');
    await page.waitForFunction(() => document.querySelectorAll('#infRemoteViews .inf-view').length === 2 && /not located/.test(document.querySelector('#infRemoteViews').textContent));
    let rows = await viewRows();
    check(rows.every((r) => r.locate && /not located on the worker yet/.test(r.text)), 'both views are "not located on the worker yet"', rows);

    await page.click('#infRemoteViews .inf-view[data-view="cam1"] .inf-locate');
    await browserOpen();
    check(await page.evaluate(() => /Shows/.test(document.querySelector('#remoteFileBrowser .rfb-foot-hint').textContent)), 'the browser shows the video filter');
    await dbl('sess'); await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="cam1"]');
    await dbl('cam1'); await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="cam1.mp4"]');
    await dbl('cam1.mp4');
    await page.waitForFunction(() => !document.getElementById('remoteFileBrowser'));
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#infRemoteViews .inf-view-why')).every((e) => /^\/data\/sess\/cam\d\/cam\d\.mp4$/.test(e.textContent)), null, { timeout: 20000 });
    rows = await viewRows();
    check(rows[0].text === '/data/sess/cam1/cam1.mp4' && rows[1].text === '/data/sess/cam2/cam2.mp4', 'one Locate placed BOTH views (a rule for the session folder)', rows);
    const rules = await store((s) => s.pairedWorkers[0].pathRules);
    check(rules.length === 1 && rules[0].local === 'rec' && rules[0].worker === '/data/sess', 'the rule is rec → /data/sess', rules);

    await page.click('#infAddRemoteModel');
    await browserOpen();
    await page.evaluate(() => { document.querySelector('#remoteFileBrowser .rfb-side-item[title="/data"]').click(); });
    await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="models"]');
    await dbl('models'); await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="td"]');
    await dbl('td');
    await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="training_config.yaml"]');
    check(await page.evaluate(() => /Folders? |Choose Folder/.test(document.querySelector('#remoteFileBrowser .rfb-btn-primary').textContent)), 'directory mode: Choose Folder');
    await page.click('#remoteFileBrowser .rfb-btn-primary');
    await page.waitForFunction(() => !document.getElementById('remoteFileBrowser'));
    const models = await page.evaluate(() => Array.from(document.querySelectorAll('#infRemoteModels .inf-model-name')).map((e) => e.textContent));
    check(models.join() === '/data/models/td', 'the model is a worker path', models);
    await page.waitForFunction(() => /^\/data\/sess/.test(document.getElementById('infOutputDir').textContent));
    check(await page.evaluate(() => document.getElementById('infOutputDir').textContent) === '/data/sess', 'output folder: the session\'s own folder on the worker');
    await page.waitForFunction(() => !document.getElementById('infRun').disabled);
    check(true, 'Run enabled');
    // Run waits until every CHECKED view is on the worker.
    await page.evaluate(async () => {
        const m = await import('./pose/connect/store.js');
        const st = m.useConnectStore.getState();
        st.addPathRule(st.selectedWorkerId, { local: 'rec/cam2/cam2.mp4', worker: '/data/sess/missing.mp4' });
    });
    await page.waitForFunction(() => document.getElementById('infRun').disabled && /not found on the worker/.test(document.querySelector('#infRemoteViews .inf-view[data-view="cam2"]').textContent), null, { timeout: 15000 });
    const gate = await page.evaluate(() => Array.from(document.querySelectorAll('#tabInference .inf-run ~ .inf-muted')).map((e) => e.textContent).join('|'));
    check(/Not on the worker: cam2\./.test(gate) && /Locate on worker… or uncheck it/.test(gate), 'Run is blocked and names the view that is not on the worker', gate);
    await page.click('#infRemoteViews .inf-view[data-view="cam2"] input[type=checkbox]');
    await page.waitForFunction(() => !document.getElementById('infRun').disabled);
    check(true, 'unchecking the unresolved view lets Run through');
    await page.click('#infRemoteViews .inf-view[data-view="cam2"] input[type=checkbox]');
    await page.evaluate(async () => {
        const m = await import('./pose/connect/store.js');
        const st = m.useConnectStore.getState();
        st.clearPathRule(st.selectedWorkerId, 'rec/cam2/cam2.mp4');
    });
    await page.waitForFunction(() => !document.getElementById('infRun').disabled && /^\/data\/sess\/cam2/.test(document.querySelector('#infRemoteViews .inf-view[data-view="cam2"] .inf-view-why').textContent), null, { timeout: 15000 });

    console.log('\n3. Run');
    await page.click('#infRun');
    await page.waitForFunction(() => document.querySelectorAll('#infRemoteJobs .inf-view').length === 2);
    const subs = [...worker.jobs.values()];
    check(subs.length === 2, 'two jobs submitted', subs.length);
    check(await page.evaluate(() => /Initializing\.\.\./.test(document.getElementById('infRemoteCounts').textContent)), 'before the first progress: "Initializing..."');
    const [j1, j2] = subs;
    check(j1.spec.type === 'track' && j1.spec.data_path === '/data/sess/cam1/cam1.mp4' && j2.spec.data_path === '/data/sess/cam2/cam2.mp4', 'each job reads its own view\'s video on the worker', [j1.spec.data_path, j2.spec.data_path]);
    check(JSON.stringify(j1.spec.model_paths) === '["/data/models/td"]', 'model_paths', j1.spec.model_paths);
    check(/^\/data\/sess\/predictions\/[^/]+__cam1\.\d{6}_\d{6}\.predictions\.slp$/.test(j1.spec.output_path), 'explicit output_path in the predictions folder', j1.spec.output_path);
    check(j1.spec.output_path.includes('__cam1.') && j2.spec.output_path.includes('__cam2.'), 'one output file per view');
    check(!('frames' in j1.spec) && !('video_index' in j1.spec) && !('exclude_user_labeled' in j1.spec), 'whole video: no frames / video_index');
    check(j1.spec.project && j1.spec.project.id === j2.spec.project.id && /^[0-9a-f]{8}$/.test(j1.spec.project.id), 'the project tag');
    check(j1.spec.run && j1.spec.run.id === j2.spec.run.id && j1.spec.run.count === 2 && j1.spec.run.index === 0 && j2.spec.run.index === 1, 'both jobs share one run', [j1.spec.run, j2.spec.run]);
    check(j1.spec.batch_size === 4 && j1.spec.peak_threshold === 0.2, 'panel settings reach the spec');
    check(await page.evaluate(() => !document.getElementById('infRemoteCancel').hidden), 'Cancel is offered while running');
    worker.setJobState(j1.job_id, 'running');
    worker.log(j1.job_id, '{"n_processed": 5, "n_total": 10, "rate": 2.0, "eta": 3}', { progress: true });
    await page.waitForFunction(() => /5 \/ 10 frames/.test(document.querySelector('#infRemoteJobs .inf-view[data-view="cam1"]').textContent), null, { timeout: 10000 });
    check(true, 'progress shows "5 / 10 frames" from the job log');
    await page.waitForFunction(() => /5 \/ 10 frames/.test(document.getElementById('infRemoteCounts').textContent) && /50\.0%/.test(document.getElementById('infRemoteCounts').textContent), null, { timeout: 10000 });
    const stats = await page.evaluate(() => document.getElementById('infRemoteStats').textContent);
    check(/2\.0 fps/.test(stats) && /ETA 3s/.test(stats), 'the run shows the frames, percent, fps and ETA', stats);
    worker.setJobState(j2.job_id, 'running');
    worker.log(j2.job_id, 'Loading model weights', {});
    worker.log(j2.job_id, 'Predicting: 50%|#####     | 5/10 [00:05<00:05, 1.0it/s]', { progress: true });
    await page.waitForFunction(() => /5 \/ 10 frames · 1\.0 fps · ETA 5s/.test(document.querySelector('#infRemoteJobs .inf-view[data-view="cam2"]').textContent), null, { timeout: 10000 });
    check(true, 'a rich progress-bar line (NN% a/b) is read as progress too');
    await page.waitForFunction(() => /\[cam2\] Loading model weights/.test(document.getElementById('infRemoteLog').textContent), null, { timeout: 10000 });
    check(true, 'the worker\'s own output is in the log, tagged with its view');
    await page.click('#infRemoteLogExpand');
    const dlg = await page.evaluate(() => document.querySelector('#infLogDialog .inf-log-full').textContent);
    check(/\$ Remote \(2 videos\): \[/.test(dlg) && /"data_path": "\/data\/sess\/cam1\/cam1\.mp4"/.test(dlg) && /-> |→ cam1 submitted/.test(dlg), 'Expand shows the whole log: the echoed spec and the submit lines', dlg.slice(0, 200));
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => !document.getElementById('infLogDialog') && document.getElementById('infRemoteLogCopy').hidden), 'Esc closes it; Copy Log waits for the run to end');
    check(await page.evaluate(() => document.getElementById('infFetchLoad').hidden), 'no Fetch while running');

    console.log('\n4. Completion, Fetch & Load');
    for (const j of [j1, j2]) {
        worker.addFile(j.spec.output_path, PRED);
        await worker.completeJob(j.job_id, { predictions: PRED });
    }
    await page.waitForFunction(() => !document.getElementById('infFetchLoad').hidden, null, { timeout: 15000 });
    check(await page.evaluate(() => /Complete/.test(document.querySelector('#infRemoteRun .inf-status-text').textContent)), 'status Complete');
    check(await page.evaluate(() => !document.getElementById('infRemoteLogCopy').hidden), 'Copy Log is offered once the run ends');
    await page.click('#infFetchLoad');
    await page.waitForFunction(() => /✓ cam2/.test(document.getElementById('infRemoteLog').textContent), null, { timeout: 60000 });
    const p4 = await page.evaluate(async () => {
        const s = window.__lucid.state.session;
        const per = {};
        for (const [, fg] of s.frameGroups) {
            for (const [cam, xs] of fg.instances) for (const i of xs) { const k = cam + ':' + i.type; per[k] = (per[k] || 0) + 1; }
            for (const [cam, xs] of fg.unlinkedInstances) for (const u of xs) { const k = cam + ':' + u.instance.type; per[k] = (per[k] || 0) + 1; }
        }
        const all = (f, cam) => { const fg = s.frameGroups.get(f); return [...(fg.instances.get(cam) || []), ...(fg.unlinkedInstances.get(cam) || []).map((u) => u.instance)]; };
        const m = await import('./pose/connect/store.js');
        return {
            per, log: document.getElementById('infRemoteLog').textContent, dirty: window.__lucid.state.isDirty,
            userAt0: all(0, 'cam1').filter((i) => i.type === 'user').map((i) => [i.getPoint(0), i.getPoint(1)]),
            oldPred: all(1, 'cam1').filter((i) => i.type === 'predicted' && i.getPoint(0) && i.getPoint(0)[0] === 1).length,
            fetched: m.useConnectStore.getState().trackedJobs.map((j) => j.fetchedAt != null),
            fetchBtnHidden: document.getElementById('infFetchLoad').hidden,
        };
    });
    check(p4.per['cam1:predicted'] === 20 && p4.per['cam2:predicted'] === 20, '20 predicted instances per view', p4.per);
    check(p4.userAt0.length === 1 && JSON.stringify(p4.userAt0[0]) === '[[11,22],[33,44]]', 'the user label is untouched (Replace)', p4.userAt0);
    check(p4.oldPred === 0, 'the old prediction on a re-inferred frame was replaced');
    check(/✓ cam1: 20 predicted instances on 10 frames/.test(p4.log), 'the log reports the merge', p4.log);
    check(p4.dirty === true, 'the project is dirty');
    check(p4.fetched.length === 2 && p4.fetched.every(Boolean), 'both jobs are marked fetched', p4.fetched);
    check(p4.fetchBtnHidden, 'Fetch & Load is gone once everything is loaded');
    check(await page.evaluate(() => document.getElementById('infRun').disabled && /Dismiss the finished run/.test(Array.from(document.querySelectorAll('#tabInference .inf-run ~ .inf-muted')).map((e) => e.textContent).join('|'))), 'a finished run must be Dismissed before Run is enabled again');
    check(worker.calls.some((c) => c.method === 'fs.read' && /predictions\.slp/.test(JSON.stringify(c.params))), 'the download went through fs.read (the blob port has no CORS)');

    console.log('\n5. Reload: results still on the worker are offered again');
    await page.click('#infRemoteDismiss');
    // Submitted from the page so the store tracks it (a run of one view).
    await page.evaluate(async ([spec, sessionName]) => {
        const m = await import('./pose/connect/store.js');
        const pt = await import('./pose/connect/project-tag.js');
        const t = pt.lucidProjectTag({ fileName: null, sessionFolders: [sessionName] });
        const st = m.useConnectStore.getState();
        await st.submitJobsOn(st.selectedWorkerId, spec, { source: 'window', sessionId: sessionName, camera: 'cam1', projectTag: t.id, mergeMode: 'keep', label: 'Inference · cam1' });
    }, [{ ...j1.spec, output_path: '/data/sess/predictions/reload.cam1.predictions.slp' }, sess.name]);
    worker.addFile('/data/sess/predictions/reload.cam1.predictions.slp', PRED);
    const newJob = [...worker.jobs.values()].find((j) => j.spec.output_path === '/data/sess/predictions/reload.cam1.predictions.slp');
    await worker.completeJob(newJob.job_id, { predictions: PRED });
    await page.waitForFunction(() => import('./pose/connect/store.js').then((m) => m.useConnectStore.getState().trackedJobs.some((j) => j.state === 'completed' && j.fetchedAt === null)));
    await boot();
    await loadSession();
    await openPanel();
    await page.waitForFunction(() => !document.getElementById('infFetchLoad').hidden, null, { timeout: 20000 });
    const rl = await page.evaluate(() => ({
        rows: Array.from(document.querySelectorAll('#infRemoteJobs .inf-view')).map((r) => r.textContent),
        status: document.querySelector('#infRemoteRun .inf-status-text').textContent,
    }));
    check(/Predictions ready/.test(rl.status) && rl.rows.length === 1 && /cam1/.test(rl.rows[0]), 'after a reload the finished job is offered (Predictions ready)', rl);
    await page.click('#infFetchLoad');
    await page.waitForFunction(() => /✓ cam1/.test(document.getElementById('infRemoteLog').textContent), null, { timeout: 60000 });
    check(await page.evaluate(() => document.getElementById('infFetchLoad').hidden), 'loaded after the reload; Fetch is gone');
    const kept = await page.evaluate(() => {
        const s = window.__lucid.state.session; let n = 0;
        for (const [, fg] of s.frameGroups) {
            for (const i of (fg.instances.get('cam1') || [])) if (i.type === 'predicted') n++;
            for (const u of (fg.unlinkedInstances.get('cam1') || [])) if (u.instance.type === 'predicted') n++;
        }
        return { n };
    });
    // The reloaded session has one old prediction on frame 1: Replace would drop it (20 left); Keep adds 20 to it.
    check(kept.n === 21, 'the mode recorded at Run (Keep) is used after a reload, though the panel is back on Replace: 1 old + 20 new predictions', kept);

    console.log('\n   another session\'s results are refused');
    await page.evaluate(async () => {
        const m = await import('./pose/connect/store.js');
        const pt = await import('./pose/connect/project-tag.js');
        const AS = await import('./ui/app-state.js');
        const t = pt.lucidProjectTag({ fileName: null, sessionFolders: AS.state.sessions.map((s) => s.name) });
        m.useConnectStore.setState((s) => ({ trackedJobs: [...s.trackedJobs, {
            workerId: s.pairedWorkers[0].nodeId, jobId: 'other-1', lastSeq: 0, kind: 'track', label: 'x', source: 'window', state: 'completed', seen: true,
            submittedAt: Date.now(), sessionId: 'Other session', camera: 'cam1', projectTag: t.id, fetchedAt: null }] }));
    });
    await page.waitForFunction(() => !document.getElementById('infFetchLoad').hidden);
    await page.click('#infFetchLoad');
    await page.waitForFunction(() => !document.getElementById('infRemoteError').hidden);
    const refusal = await page.evaluate(() => document.getElementById('infRemoteError').textContent);
    check(/Other session/.test(refusal) && /Switch to it first/.test(refusal), 'a result of another session is refused with a clear message', refusal);

    console.log('\n6. Two views on one worker file are refused');
    await page.evaluate(async () => {
        const m = await import('./pose/connect/store.js');
        const st = m.useConnectStore.getState();
        st.addPathRule(st.selectedWorkerId, { local: 'rec/cam2/cam2.mp4', worker: '/data/sess/cam1/cam1.mp4' });
    });
    await page.waitForFunction(() => /\/data\/sess\/cam1\/cam1\.mp4/.test(document.querySelector('#infRemoteViews .inf-view[data-view="cam2"]').textContent));
    // (models are not remembered across a reload)
    await page.click('#infAddRemoteModel');
    await browserOpen();
    await page.evaluate(() => { document.querySelector('#remoteFileBrowser .rfb-side-item[title="/data"]').click(); });
    await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="models"]');
    await dbl('models'); await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="td"]');
    await dbl('td');
    await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="training_config.yaml"]');
    await page.click('#remoteFileBrowser .rfb-btn-primary');
    await page.waitForFunction(() => !document.getElementById('remoteFileBrowser'));
    await page.click('#infRemoteDismiss').catch(() => {});
    await page.waitForFunction(() => !document.getElementById('infRun').disabled);
    const before = worker.jobs.size;
    await page.click('#infRun');
    await page.waitForFunction(() => !document.getElementById('infRemoteError').hidden && /point at the same file/.test(document.getElementById('infRemoteError').textContent));
    check(worker.jobs.size === before, 'nothing was submitted');
    check(await page.evaluate(() => /cam1 and cam2 point at the same file on the worker \(\/data\/sess\/cam1\/cam1\.mp4\)/.test(document.getElementById('infRemoteError').textContent)), 'the refusal names both views and the file');

    console.log('\n7. Esc closes the file browser');
    await page.click('#infAddRemoteModel');
    await browserOpen();
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => !document.getElementById('remoteFileBrowser')), 'Esc closes it');

    console.log('\n11. The file browser: big folders, keys, Tab, long names, notice');
    for (let i = 0; i < 250; i++) worker.addFile('/data/zbig/f' + String(i).padStart(4, '0') + '.png', i === 249 ? 'x'.repeat(5000) : 'x');
    const LONG = '2026-10-20_courtship_assay_arena_B_session_0042_proofread.v003.slp';
    worker.addFile('/data/zbig/' + LONG, 'x');
    await page.click('#infAddRemoteModel');
    await browserOpen();
    await page.evaluate(() => { document.querySelector('#remoteFileBrowser .rfb-side-item[title="/data"]').click(); });
    await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="zbig"]');
    await dbl('zbig'); await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="f0000.png"]');
    await page.evaluate(() => { document.querySelector('#remoteFileBrowser .rfb-list').scrollTop = 0; });
    await page.click('#remoteFileBrowser .rfb-hbtn[data-key="size"]');
    await page.click('#remoteFileBrowser .rfb-hbtn[data-key="size"]'); // descending
    await page.waitForFunction(() => !/Loading more/.test(document.querySelector('#remoteFileBrowser .rfb-list').textContent), null, { timeout: 20000 });
    const biggest = await page.evaluate(() => document.querySelector('#remoteFileBrowser .rfb-entry').dataset.name);
    check(biggest === 'f0249.png', 'sorted by Size in a folder of 251 files, every batch loads in the background (the biggest file is on top)', biggest);
    await page.evaluate(() => { try { localStorage.removeItem('lucid-connect-remote-browser'); } catch (e) {} });
    await page.click('#remoteFileBrowser .rfb-hbtn[data-key="name"]');
    const nm = await page.evaluate((long) => {
        const row = Array.from(document.querySelectorAll('#remoteFileBrowser .rfb-entry')).find((r) => r.dataset.name === long);
        const t = row && row.querySelector('.rfb-name-text');
        return t ? { title: t.title, tail: t.querySelector('.rfb-name-tail') && t.querySelector('.rfb-name-tail').textContent, sr: !!t.querySelector('.rfb-sr-only') } : null;
    }, LONG);
    check(nm && nm.title === LONG && nm.tail === 'ead.v003.slp' && nm.sr, 'a long name keeps its last 12 characters, with the whole name on hover', nm);
    // Keys: app shortcuts do not act on the view behind the open browser.
    const f0 = await page.evaluate(() => window.__lucid.state.currentFrame);
    await page.evaluate(() => document.querySelector('#remoteFileBrowser .rfb-card').focus());
    for (const k of ['ArrowRight', 'ArrowRight', 'Space', 'ArrowLeft', 'KeyL']) await page.keyboard.press(k);
    await page.waitForTimeout(150);
    check(await page.evaluate((f) => window.__lucid.state.currentFrame === f && !!document.getElementById('remoteFileBrowser'), f0), 'ArrowRight / Space / L inside the browser do not step or play the view behind it', f0);
    const inCard = async () => page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('#remoteFileBrowser'));
    let trapped = true;
    for (let i = 0; i < 24; i++) { await page.keyboard.press('Tab'); if (!(await inCard())) trapped = false; }
    for (let i = 0; i < 24; i++) { await page.keyboard.press('Shift+Tab'); if (!(await inCard())) trapped = false; }
    check(trapped, 'Tab and Shift+Tab never leave the browser');
    // The fallback notice can be dismissed.
    await page.keyboard.press('Control+Shift+G');
    await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains('rfb-goto'));
    await page.keyboard.type('/data/nope/deeper');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => { const n = document.querySelector('#remoteFileBrowser .rfb-notice'); return n && !n.hidden; }, null, { timeout: 10000 }).catch(() => {});
    const hadNotice = await page.evaluate(() => { const n = document.querySelector('#remoteFileBrowser .rfb-notice'); return !!n && !n.hidden; });
    if (hadNotice) {
        await page.click('#remoteFileBrowser .rfb-notice-x');
        check(await page.evaluate(() => document.querySelector('#remoteFileBrowser .rfb-notice').hidden), 'the fallback notice has a Dismiss');
    } else check(false, 'a missing folder falls back with a notice (could not provoke it)');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('remoteFileBrowser'));

    console.log('\n8. The 2 s refresh leaves the panel\'s controls alone');
    await page.waitForSelector('#infRemoteModels .inf-x');
    const keep = await page.evaluate(() => new Promise((res) => {
        const cb = document.querySelector('#infRemoteViews .inf-view[data-view="cam2"] input[type=checkbox]');
        const rm = document.querySelector('#infRemoteModels .inf-x');
        cb.__mark = rm.__mark = 1;
        cb.focus();
        setTimeout(() => {
            const cb2 = document.querySelector('#infRemoteViews .inf-view[data-view="cam2"] input[type=checkbox]');
            const rm2 = document.querySelector('#infRemoteModels .inf-x');
            res({ focus: document.activeElement === cb, sameCb: cb2 === cb, sameRm: rm2 === rm });
        }, 4600);
    }));
    check(keep.focus && keep.sameCb && keep.sameRm, 'a focused checkbox keeps focus; checkbox and model button are the same elements after two refreshes', keep);
    const box = await (await page.$('#infRemoteViews .inf-view[data-view="cam2"] input[type=checkbox]')).boundingBox();
    const was = await page.evaluate(() => document.querySelector('#infRemoteViews .inf-view[data-view="cam2"] input').checked);
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.down();
    await page.waitForTimeout(2600);
    await page.mouse.up();
    check(await page.evaluate((w) => document.querySelector('#infRemoteViews .inf-view[data-view="cam2"] input').checked !== w, was), 'a click held across a refresh still toggles the checkbox');
    await page.evaluate(() => document.querySelector('#infRemoteViews .inf-view[data-view="cam2"] input').click());

    console.log('\n10. The file browser on a phone-width window (runs before §9, which forgets the worker)');
    await page.evaluate(() => { try { localStorage.removeItem('lucid-connect-remote-browser'); } catch (e) {} });
    await page.setViewportSize({ width: 375, height: 667 });
    await page.click('#infOutputChange').catch(async () => { await page.evaluate(() => document.getElementById('infOutputChange').click()); });
    await browserOpen();
    const nar = await page.evaluate(() => {
        const card = document.querySelector('#remoteFileBrowser .rfb-card').getBoundingClientRect();
        const name = document.querySelector('#remoteFileBrowser .rfb-entry .rfb-name-text');
        const btns = [...document.querySelectorAll('#remoteFileBrowser .rfb-btn')].map((b) => b.getBoundingClientRect());
        return { left: card.left, right: card.right, vw: innerWidth, nameW: name ? name.getBoundingClientRect().width : 0,
            btnsIn: btns.every((r) => r.left >= 0 && r.right <= innerWidth) };
    });
    check(nar.left >= 0 && nar.right <= nar.vw, 'the card fits a 375 px window', nar);
    check(nar.nameW > 40 && nar.btnsIn, 'entry names are readable and Cancel / Open are on screen', nar);
    await page.click('#remoteFileBrowser .rfb-foot-info', { force: true });
    check(await page.evaluate(() => { try { return !localStorage.getItem('lucid-connect-remote-browser') || !JSON.parse(localStorage.getItem('lucid-connect-remote-browser')).state.size; } catch (e) { return true; } }),
        'a click inside the clamped card does not store its size');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1500, height: 950 });

    console.log('\n9. A failed job says why; Forget leaves no stale "ready"');
    await page.evaluate(async () => {
        const m = await import('./pose/connect/store.js');
        const st = m.useConnectStore.getState();
        st.clearPathRule(st.selectedWorkerId, 'rec/cam2/cam2.mp4');
        m.useConnectStore.setState((x) => ({ trackedJobs: x.trackedJobs.filter((j) => j.jobId !== 'other-1') })); // §5's stand-in for another session's result
    });
    await page.waitForFunction(() => !document.getElementById('infRun').disabled, null, { timeout: 8000 }).catch(async () => { console.log('  run disabled:', await page.evaluate(() => JSON.stringify({ why: document.querySelector('#tabInference .inf-run ~ .inf-muted')?.textContent, views: document.getElementById('infRemoteViews').textContent, err: document.getElementById('infRemoteError').textContent }))); throw new Error('Run stayed disabled'); });
    await page.click('#infRemoteDismiss').catch(() => {});
    const nBefore = worker.jobs.size;
    await page.click('#infRun');
    await page.waitForFunction(() => document.querySelectorAll('#infRemoteJobs .inf-view').length === 2);
    const newJobs = [...worker.jobs.values()].slice(nBefore);
    worker.setJobState(newJobs[0].job_id, 'running');
    worker.log(newJobs[0].job_id, 'Traceback (most recent call last):');
    worker.log(newJobs[0].job_id, "PermissionError: [Errno 13] Unable to create file (name = '/data/ro/x.slp')");
    await new Promise((r) => setTimeout(r, 300));
    worker.failJob(newJobs[0].job_id, 'exit code 1');
    await page.waitForFunction(() => /Failed/.test(document.querySelector('#infRemoteJobs .inf-view[data-view="cam1"]').textContent), null, { timeout: 15000 });
    const failTxt = await page.evaluate(() => document.querySelector('#infRemoteJobs .inf-view[data-view="cam1"]').textContent);
    check(/exit code 1/.test(failTxt) && /PermissionError: \[Errno 13\]/.test(failTxt), 'the failed row shows the exit code and the exception line', failTxt);
    check(await page.evaluate(() => /✗ cam1: PermissionError/.test(document.getElementById('infRemoteLog').textContent)), 'the log carries the exception line');
    await page.evaluate(async () => {
        const m = await import('./pose/connect/store.js');
        const st = m.useConnectStore.getState();
        await st.forgetWorker(st.selectedWorkerId);
    });
    await page.waitForFunction(() => document.querySelectorAll('#infRemoteJobs .inf-view').length === 0);
    check(await page.evaluate(() => !/Predictions ready/.test(document.querySelector('#infRemoteRun .inf-status-text').textContent)), 'after Forget the run box does not claim predictions are ready');

}, {
    onError: async (e) => {
        console.log('  ✗ threw', e);
        fail();
        try {
            console.log(await context.pages()[0].evaluate(() => JSON.stringify({
                views: document.getElementById('infRemoteViews') && document.getElementById('infRemoteViews').textContent,
                note: document.getElementById('infRemoteNote') && document.getElementById('infRemoteNote').textContent,
                vis: document.getElementById('infRemoteViews') && document.getElementById('infRemoteViews').offsetParent !== null,
                status: document.getElementById('infBackendStatus').textContent,
            })));
        } catch (e2) { /* page gone */ }
    },
});
