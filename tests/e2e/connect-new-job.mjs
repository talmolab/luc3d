/**
 * connect-new-job.mjs — the New job wizard (Inference only; `ui/connect/new-job-wizard.js`, port of sleap-app
 * NewJobWizard.tsx) against the fake worker (`tests/connect/fake-worker.mjs` over the page's WebSocket).
 * Ports the Inference parts of tests/unit/newJobWizard.test.tsx; mounted by calling `openNewJobWizard` on the
 * app page (the Connect window shell is another module's).
 *
 *  1. The dialog: title / description, Train shown disabled with a note (training is out of scope), Inference
 *     chosen, Add to queue disabled with the reason; Esc and Cancel close it; one wizard at a time.
 *  2. Models: a job without `run` is its own run, a run with a still-running sibling is left out; a chosen
 *     run's model dirs come in run.index order; "Browse model folder on <worker>…" adds a folder; chips remove.
 *  3. A file on the worker, a .slp: the browser filters to .slp / video; "Random sample" is not offered;
 *     Add to queue submits ONE standalone track job (data_path, model_paths, frame_filter, project, source
 *     worker-file), a toast, the success card; Add another returns to the form.
 *  4. A file on the worker, a video: a plain track job (no view tag); a frame range sends frames "a-b"; a bad
 *     range and a non-.slp/non-video file block Add to queue with a reason.
 *  5. Esc with the worker file browser open closes only the browser.
 *  6. This project: no session -> "Open a session first."; with the session loaded but its videos not on the
 *     worker the run's own refusal is shown in the wizard; once located it submits one job per view with the
 *     wizard's models, an explicit output_path, the project / session / camera tags and the panel's options.
 *  7. A submit that the worker refuses shows the error and the toast "Couldn't submit inference job".
 *
 * Usage: node tests/e2e/connect-new-job.mjs   (PORT= to move its server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeWorker } from '../connect/fake-worker.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT || 9395);
const BASE = `http://localhost:${PORT}`;
const WS = 'ws://127.0.0.1:9635';

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 700)));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
let browser;
try {
    await new Promise((r) => setTimeout(r, 800));
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', (e) => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    const worker = await FakeWorker.create({ mounts: [{ path: '/data', label: 'Data' }], serveFolder: '/data', workerInfo: { hostname: 'gpu-box' } });
    for (const p of ['/data/models/td/training_config.yaml', '/data/models/other/training_config.yaml', '/data/sess/a.slp', '/data/sess/cam1.mp4',
        '/data/sess/cam1/cam1.mp4', '/data/sess/cam2/cam2.mp4', '/data/notes.txt']) worker.addFile(p, 'x');
    worker.addDir('/data/sess/predictions');
    // finished training runs: a single-model run, a split top-down run (listed OUT of index order) and one with a running sibling
    worker.addJob({ jobId: 'single', state: 'completed', spec: { type: 'train', model_types: ['single_instance'], labels_path: '/data/sess/a.slp' }, result: { model_dir: '/data/models/single' } });
    worker.addJob({ jobId: 'td1', state: 'completed', spec: { type: 'train', model_types: ['centered_instance'], labels_path: '/data/sess/a.slp', run: { id: 'run-td', index: 1, count: 2 } }, result: { model_dir: '/data/models/ci' } });
    worker.addJob({ jobId: 'td0', state: 'completed', spec: { type: 'train', model_types: ['centroid'], labels_path: '/data/sess/a.slp', run: { id: 'run-td', index: 0, count: 2 } }, result: { model_dir: '/data/models/cen' } });
    worker.addJob({ jobId: 'half0', state: 'completed', spec: { type: 'train', model_types: ['centroid'], labels_path: '/data/x.slp', run: { id: 'run-half', index: 0, count: 2 } }, result: { model_dir: '/data/models/h0' } });
    worker.addJob({ jobId: 'half1', state: 'running', spec: { type: 'train', model_types: ['centered_instance'], labels_path: '/data/x.slp', run: { id: 'run-half', index: 1, count: 2 } } });
    await worker.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9635/);

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

    const dbl = (name) => page.dblclick(`#remoteFileBrowser .rfb-entry[data-name="${name}"]`);
    const browserOpen = () => page.waitForSelector('#remoteFileBrowser .rfb-entry');
    const openWiz = (seed) => page.evaluate(async ([id, s]) => {
        const m = await import('./ui/connect/new-job-wizard.js');
        window.__wizClosed = false;
        m.openNewJobWizard({ workerId: id, workerLabel: 'gpu-box', seed: s }).then(() => { window.__wizClosed = true; });
    }, [worker.nodeId, seed || null]);
    const closeWiz = async () => { await page.keyboard.press('Escape'); await page.waitForFunction(() => window.__wizClosed); };
    const ui = () => page.evaluate(() => {
        const q = (s) => document.querySelector(s);
        return {
            title: q('.njw-title').textContent, desc: q('.njw-desc').textContent,
            trainDisabled: q('#njwKindTrain').disabled, trainNote: q('#njwTrainNote').textContent,
            submitDisabled: q('#njwSubmit').disabled, why: q('#njwWhy').hidden ? '' : q('#njwWhy').textContent,
            error: q('#njwError').hidden ? '' : q('#njwError').textContent,
            runs: [...document.querySelectorAll('#njwRuns button')].map((b) => b.textContent),
            dirs: [...document.querySelectorAll('#njwModelDirs .njw-chip-name')].map((e) => e.textContent),
            targets: [...document.querySelectorAll('#njwTarget option')].map((o) => o.value),
            summary: q('#njwSummary').hidden ? '' : q('#njwSummary').textContent,
            filePath: q('#njwFilePath').textContent, fileNote: q('#njwFileNote').hidden ? '' : q('#njwFileNote').textContent,
            ok: q('#njwOk') && !q('.njw-done').hidden ? q('#njwOk').textContent : '',
            source: q('#njwSrcProject').classList.contains('njw-on') ? 'project' : 'file',
        };
    });
    const toasts = () => page.evaluate(() => [...document.querySelectorAll('.connect-toast')].map((t) => t.textContent));
    const submittedSpecs = () => [...worker.jobs.values()].filter((j) => j.spec.type === 'track').map((j) => j.spec);

    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    await page.waitForSelector('.panel-rail-btn[data-tab="tabConnect"]');
    const code = await worker.mintPairCode({ addrs: [WS] });
    await page.evaluate((c) => import('./pose/connect/store.js').then((m) => m.useConnectStore.getState().pairWithCode(c)), code);
    await page.waitForFunction(() => import('./pose/connect/store.js').then((m) => m.useConnectStore.getState().connectionStatus === 'connected'));

    console.log('\n--- 1. The dialog ---');
    await openWiz();
    await page.waitForSelector('#newJobWizard');
    let u = await ui();
    check(u.title === 'New job on gpu-box' && u.desc === 'Starts a job on data that already lives on this worker.', "sleap-app's title and description", u);
    check(u.trainDisabled && /Training isn’t available in LUCID/.test(u.trainNote), 'Train is shown disabled with a one-line note', u);
    check(u.submitDisabled && u.why === 'Pick a file on the worker.', 'Add to queue is disabled and says why', u);
    check(u.source === 'file', 'with no session open the data source is the worker file');
    check(await page.evaluate(() => document.getElementById('newJobWizard').dataset.shortcutModal === '1'), 'app shortcuts are blocked behind it (data-shortcut-modal)');
    const second = await page.evaluate(async (id) => { const m = await import('./ui/connect/new-job-wizard.js'); m.openNewJobWizard({ workerId: id, workerLabel: 'gpu-box' }); return document.querySelectorAll('#newJobWizard').length; }, worker.nodeId);
    check(second === 1, 'a second call does not open a second wizard');
    await closeWiz();
    check(await page.evaluate(() => !document.getElementById('newJobWizard')), 'Esc closes it');
    await openWiz(); await page.waitForSelector('#newJobWizard');
    await page.click('#njwCancel');
    await page.waitForFunction(() => window.__wizClosed);
    check(true, 'Cancel closes it');

    console.log('\n--- 2. Models ---');
    await openWiz(); await page.waitForSelector('#newJobWizard');
    await page.waitForFunction(() => document.querySelectorAll('#njwRuns button').length >= 2);
    u = await ui();
    check(u.runs.length === 2, 'two finished runs: a job without run is its own run; the run with a running sibling is left out', u.runs);
    check(u.runs.some((t) => /^single_instance · a\.slp · /.test(t)) && u.runs.some((t) => /^centroid \+ centered_instance · a\.slp · /.test(t)), 'entries: types · labels file · age', u.runs);
    await page.click('#njwRuns button:has-text("centroid + centered_instance")');
    await page.waitForFunction(() => document.querySelectorAll('#njwModelDirs .njw-chip').length === 2);
    u = await ui();
    check(u.dirs.join() === '/data/models/cen,/data/models/ci', "a chosen run's model dirs come in run.index order", u.dirs);
    await page.click('#njwBrowseModel');
    await browserOpen();
    check(await page.evaluate(() => document.querySelector('#remoteFileBrowser .rfb-btn-primary').textContent) === 'Choose Folder', 'Browse model folder opens the worker browser in folder mode');
    await page.evaluate(() => { document.querySelector('#remoteFileBrowser .rfb-side-item[title="/data"]').click(); });
    await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="models"]');
    await dbl('models'); await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="td"]');
    await dbl('td');
    await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="training_config.yaml"]');
    await page.click('#remoteFileBrowser .rfb-btn-primary');
    await page.waitForFunction(() => !document.getElementById('remoteFileBrowser'));
    u = await ui();
    check(u.dirs.join() === '/data/models/cen,/data/models/ci,/data/models/td', 'a browsed folder is appended (a split top-down run needs two)', u.dirs);
    check(await page.evaluate(() => !document.querySelector('#njwRuns .njw-on')), 'and the picked run is deselected: the list is no longer that run alone');
    await page.click('#njwModelDirs .njw-chip:first-child .njw-x');
    u = await ui();
    check(u.dirs.join() === '/data/models/ci,/data/models/td', 'a chip is removed with its x', u.dirs);
    await closeWiz();

    console.log('\n--- 3. A file on the worker: a .slp ---');
    await openWiz(); await page.waitForSelector('#newJobWizard');
    await page.click('#njwBrowseFile');
    await browserOpen();
    const hint = await page.evaluate(() => document.querySelector('#remoteFileBrowser .rfb-foot-hint').textContent);
    check(/\.slp/.test(hint) && /\.mp4/.test(hint), 'the browser is filtered to labels and video files', hint);
    await page.evaluate(() => { document.querySelector('#remoteFileBrowser .rfb-side-item[title="/data"]').click(); });
    await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="sess"]');
    await dbl('sess'); await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="a.slp"]');
    await dbl('a.slp');
    await page.waitForFunction(() => !document.getElementById('remoteFileBrowser'));
    u = await ui();
    check(u.filePath === '/data/sess/a.slp' && /A labels file/.test(u.fileNote), 'the picked path and a note about it', u);
    check(u.targets.join() === 'suggestions,user_labeled,predicted,all_videos', 'targets: sleap-app\'s list without Random sample', u.targets);
    check(u.submitDisabled && u.why === 'Add a model folder.', 'still needs a model', u);
    await page.click('#njwRuns button:has-text("single_instance")');
    await page.waitForFunction(() => document.querySelectorAll('#njwModelDirs .njw-chip').length === 1);
    await page.selectOption('#njwTarget', 'predicted');
    u = await ui();
    check(!u.submitDisabled && /Inference · 1 model dir$/.test(u.summary.split('Labels:')[0]) && /Labels: \/data\/sess\/a\.slp/.test(u.summary) && /On: frames with predictions/.test(u.summary), 'summary box: models, labels, target', u.summary);
    const n0 = submittedSpecs().length;
    await page.click('#njwSubmit');
    await page.waitForFunction(() => !document.querySelector('.njw-done').hidden);
    const subs = submittedSpecs();
    check(subs.length === n0 + 1, 'exactly one standalone track job submitted', subs.length);
    const s1 = subs[subs.length - 1];
    check(s1.type === 'track' && s1.data_path === '/data/sess/a.slp' && JSON.stringify(s1.model_paths) === '["/data/models/single"]', 'track spec: labels path + the run\'s model dir', s1);
    check(s1.frame_filter === 'predicted' && !('frames' in s1) && !('video_index' in s1), 'the target is a worker-side frame filter', s1);
    check(s1.project && s1.project.name === 'a.slp' && /^[0-9a-f]{8}$/.test(s1.project.id), 'the project tag names the file', s1.project);
    const tracked = await page.evaluate(() => import('./pose/connect/store.js').then((m) => m.useConnectStore.getState().trackedJobs.map((j) => ({ source: j.source, kind: j.kind, camera: j.camera, sessionId: j.sessionId }))));
    check(tracked.length === 1 && tracked[0].source === 'worker-file' && tracked[0].camera === undefined, 'tracked with source worker-file and no LUCID view tag', tracked);
    u = await ui();
    check(u.ok === "Added to gpu-box\u2019s queue.", 'the success card', u.ok);
    check((await toasts()).some((t) => /Added to gpu-box queue/.test(t) && /Inference on a\.slp/.test(t)), 'the toast says what was added', await toasts());
    await page.click('#njwAnother');
    u = await ui();
    check(u.ok === '' && u.dirs.length === 1 && u.filePath === '/data/sess/a.slp', 'Add another returns to the form with its choices kept', u);
    await closeWiz();

    console.log('\n--- 4. A file on the worker: a video / bad choices ---');
    await openWiz({ labelsPath: '/data/sess/cam1.mp4' }); await page.waitForSelector('#newJobWizard');
    u = await ui();
    check(u.filePath === '/data/sess/cam1.mp4' && /A video: runs a plain track job/.test(u.fileNote), 'a seed pre-fills the file (Run again)', u);
    check(u.targets.join() === 'video,range', 'a video offers the whole video or a frame range', u.targets);
    await page.click('#njwBrowseModel'); await browserOpen();
    await page.evaluate(() => { document.querySelector('#remoteFileBrowser .rfb-side-item[title="/data"]').click(); });
    await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="models"]');
    await dbl('models'); await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="other"]');
    await dbl('other'); await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="training_config.yaml"]');
    await page.click('#remoteFileBrowser .rfb-btn-primary');
    await page.waitForFunction(() => !document.getElementById('remoteFileBrowser'));
    await page.selectOption('#njwTarget', 'range');
    await page.fill('#njwStart', '9'); await page.fill('#njwEnd', '2');
    u = await ui();
    check(u.submitDisabled && u.why === 'The last frame must be at least the first.', 'a bad range blocks Add to queue and says why', u);
    await page.fill('#njwStart', '10'); await page.fill('#njwEnd', '49');
    await page.click('#njwSubmit');
    await page.waitForFunction(() => !document.querySelector('.njw-done').hidden);
    const v1 = submittedSpecs().pop();
    check(v1.data_path === '/data/sess/cam1.mp4' && v1.frames === '10-49' && JSON.stringify(v1.model_paths) === '["/data/models/other"]', 'a video: a plain track job with frames "10-49"', v1);
    check(!('camera' in v1) && !('frame_filter' in v1) && v1.project.name === 'cam1.mp4', 'no view tag, no frame filter');
    const tr2 = await page.evaluate(() => import('./pose/connect/store.js').then((m) => m.useConnectStore.getState().trackedJobs.filter((j) => j.source === 'worker-file' && j.camera === undefined).length));
    check(tr2 === 2, 'both file jobs are tracked without a view tag', tr2);
    await closeWiz();
    await openWiz({ labelsPath: '/data/notes.txt' }); await page.waitForSelector('#newJobWizard');
    u = await ui();
    check(u.submitDisabled && u.why === 'Pick a .slp or a video file.' && /Pick a \.slp or a video file\./.test(u.fileNote), 'a file that is neither blocks Add to queue', u);
    await closeWiz();

    console.log('\n--- 5. Esc with the file browser open ---');
    await openWiz(); await page.waitForSelector('#newJobWizard');
    await page.click('#njwBrowseFile'); await browserOpen();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('remoteFileBrowser'));
    check(await page.evaluate(() => !!document.getElementById('newJobWizard') && !window.__wizClosed), 'Esc closed only the file browser, the wizard stays');
    await closeWiz();

    console.log('\n--- 7. A refused submit ---');
    await openWiz({ labelsPath: '/data/sess/a.slp' }); await page.waitForSelector('#newJobWizard');
    await page.click('#njwRuns button:has-text("single_instance")');
    await page.waitForFunction(() => document.querySelectorAll('#njwModelDirs .njw-chip').length === 1);
    const origSubmit = worker.handlers.get('jobs.submit');
    worker.setHandler('jobs.submit', () => { throw Object.assign(new Error('boom: the worker says no'), { code: 'job.spec_invalid' }); });
    await page.click('#njwSubmit');
    await page.waitForFunction(() => !document.getElementById('njwError').hidden);
    u = await ui();
    check(/boom: the worker says no/.test(u.error) && u.ok === '' && !u.submitDisabled, 'the error is shown in the wizard and Add to queue works again', u);
    check((await toasts()).some((t) => /Couldn't submit inference job/.test(t)), 'toast: Couldn\'t submit inference job', await toasts());
    worker.setHandler('jobs.submit', origSubmit);
    await closeWiz();

    console.log('\n--- 6. This project ---');
    await openWiz(); await page.waitForSelector('#newJobWizard');
    await page.click('#njwSrcProject');
    u = await ui();
    check(u.source === 'project' && /Open a session first\./.test(await page.evaluate(() => document.getElementById('njwProjectLine').textContent)) && u.submitDisabled, 'no session: "Open a session first."', u);
    await closeWiz();
    const sess = await loadSession();
    check(sess.views.join() === 'cam1,cam2', 'session loaded', sess);
    await openWiz(); await page.waitForSelector('#newJobWizard');
    check((await ui()).source === 'project', 'with a session open the data source starts on This project');
    const line = await page.evaluate(() => document.getElementById('njwProjectLine').textContent);
    check(/^rec · 2 views: one job per view/.test(line) || /· 2 views/.test(line), 'the session and its view count', line);
    await page.click('#njwBrowseModel'); await browserOpen();
    await page.evaluate(() => { document.querySelector('#remoteFileBrowser .rfb-side-item[title="/data"]').click(); });
    await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="models"]');
    await dbl('models'); await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="td"]');
    await dbl('td'); await page.waitForSelector('#remoteFileBrowser .rfb-entry[data-name="training_config.yaml"]');
    await page.click('#remoteFileBrowser .rfb-btn-primary');
    await page.waitForFunction(() => !document.getElementById('remoteFileBrowser'));
    const nBefore = submittedSpecs().length;
    // The Backend: the wizard's worker is selected here, so no note; with ANOTHER Backend it says so and gives it back.
    check(!(await page.evaluate(() => /becomes the Backend/.test(document.getElementById('njwProjectLine').textContent))), 'the worker is already the Backend: no Backend note');
    await page.evaluate(async () => {
        const m = await import('./pose/connect/store.js');
        const real = m.useConnectStore.getState().selectWorker;
        window.__selCalls = [];
        window.__realSelect = real;
        m.useConnectStore.setState({ selectedWorkerId: 'other-backend-node', selectWorker: async (id, o) => { window.__selCalls.push(id); if (id === 'other-backend-node') return undefined; return real(id, o); } });
    });
    await page.click('#njwSrcFile'); await page.click('#njwSrcProject');
    check(await page.evaluate(() => /becomes the Backend while the jobs are added/.test(document.getElementById('njwProjectLine').textContent)), 'another worker is the Backend: the project line says this worker becomes the Backend while the jobs are added');
    await page.click('#njwSubmit');
    await page.waitForFunction(() => !document.getElementById('njwError').hidden, null, { timeout: 40000 });
    check(await page.evaluate(() => window.__selCalls.join()) === worker.nodeId + ',other-backend-node', 'the failed submit still gives the previous Backend back', await page.evaluate(() => window.__selCalls));
    await page.evaluate(async (id) => {
        const m = await import('./pose/connect/store.js');
        m.useConnectStore.setState({ selectWorker: window.__realSelect });
        await m.useConnectStore.getState().selectWorker(id);
    }, worker.nodeId);
    await page.click('#njwSubmit');
    await page.waitForFunction(() => !document.getElementById('njwError').hidden, null, { timeout: 40000 });
    u = await ui();
    check(/Not on the worker: cam1, cam2\./.test(u.error), 'videos not on the worker: the run\'s own refusal is shown, nothing submitted', u.error);
    check(submittedSpecs().length === nBefore, 'no job was submitted');
    await page.evaluate(async () => {
        const m = await import('./pose/connect/store.js');
        const st = m.useConnectStore.getState();
        st.addPathRule(st.selectedWorkerId, { local: 'rec', worker: '/data/sess' });
    });
    await page.click('#njwSubmit');
    await page.waitForFunction(() => !document.querySelector('.njw-done').hidden, null, { timeout: 40000 });
    const ps = submittedSpecs().slice(nBefore);
    check(ps.length === 2, 'one job per view', ps.length);
    check(ps.every((s) => JSON.stringify(s.model_paths) === '["/data/models/td"]'), 'every job uses the wizard\'s model', ps.map((s) => s.model_paths));
    check(ps[0].data_path === '/data/sess/cam1/cam1.mp4' && ps[1].data_path === '/data/sess/cam2/cam2.mp4', 'each job reads its own view\'s video on the worker', ps.map((s) => s.data_path));
    check(/^\/data\/sess\/predictions\/rec__cam1\.\d{6}_\d{6}\.predictions\.slp$/.test(ps[0].output_path), 'explicit output_path', ps[0].output_path);
    check(ps[0].run && ps[0].run.count === 2 && ps[0].run.id === ps[1].run.id, 'both share one run', ps.map((s) => s.run));
    const t2 = await page.evaluate(() => import('./pose/connect/store.js').then((m) => m.useConnectStore.getState().trackedJobs.filter((j) => j.source === 'window').map((j) => ({ cam: j.camera, sess: j.sessionId, tag: j.projectTag, merge: j.mergeMode }))));
    check(t2.length === 2 && t2.map((j) => j.cam).sort().join() === 'cam1,cam2' && t2.every((j) => j.sess === 'rec' && /^[0-9a-f]{8}$/.test(j.tag) && j.merge), 'tracked with session / camera / project tag / merge mode (Fetch & Load works from the panel and the Jobs tab)', t2);
    u = await ui();
    check(/^Added to gpu-box\u2019s queue\. Fetch & Load Results/.test(u.ok), 'success card says where the results come back', u.ok);
    await page.click('#njwDone');
    await page.waitForFunction(() => window.__wizClosed);
    check(await page.evaluate(() => !document.getElementById('newJobWizard')), 'Done closes the wizard');

    console.log('\n--- 8. Why a worker .slp is not summarized (sleap-app workerLabels.ts) ---');
    const sab = await page.evaluate(async () => {
        const out = { isolated: !!self.crossOriginIsolated, sab: typeof SharedArrayBuffer !== 'undefined', streaming: typeof window.SleapIO.readSlpStreaming };
        try {
            await window.SleapIO.readSlpStreaming({ size: 10, readRange: async () => new Uint8Array(0) }, {});
            out.error = null;
        } catch (e) { out.error = String(e && e.message || e); }
        return out;
    });
    check(!sab.isolated && !sab.sab && sab.streaming === 'function' && /RangeSource streaming requires SharedArrayBuffer/.test(sab.error || ''),
        'the page is not cross-origin isolated, so sleap-io readSlpStreaming over a RangeSource refuses (no worker .slp summary)', sab);
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\nFAIL — ${fails} check(s) failed` : '\nPASS');
process.exit(fails ? 1 : 0);
