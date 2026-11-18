/**
 * connect-open-predictions.mjs — Connect's "Open as new project" (luc3d #450): Jobs tab ▸ Fetch & Load ▸
 * Load predictions opens a remote inference RUN (one `track` job per camera) as a new, unsaved project
 * (`ui/connect/merge-predictions-dialog.js`, naming in `pose/connect/open-predictions-plan.js`, loaded by
 * `handleLoadSlpFile(file, {slpData})`), against the fake sleap-connect worker. The Jobs tab is mounted
 * straight onto a host div, as in `connect-jobs.mjs`; its `onCloseWindow` is a spy.
 *
 *  A. No project open, a run THIS page submitted (cam1, cam2 done; cam3 failed): the dialog says "No project
 *     open", names the run's cameras and the job left out, offers Open as new project (primary) + Download,
 *     no Merge. Open asks nothing, closes the Connect window, prompts for the videos; the result is ONE
 *     session named after the tracked session ("rec"), cameras cam1, cam2 (uncalibrated, bound to the
 *     picked cam1.mp4 / cam2.mp4), 20 + 20 ungrouped predicted instances, tracks "<camera>: <track>", the
 *     project dirty with no file handle, both jobs marked fetched, a toast naming the session.
 *  B. A project open (dirty, with a file handle), a run from ANOTHER LUCID device (untagged here; its
 *     output names carry session "rec2" and views top / side): Merge into view and Open as new project
 *     are both offered. Open asks first (the question names unsaved changes, the session and cameras);
 *     declining changes nothing (same project, same file handle, dialog still up). Accepting opens rec2
 *     with cameras top, side and drops the old file handle (Save cannot overwrite the old project).
 *  C. A run whose cameras' skeletons differ: refused with a toast, nothing opened or changed.
 *  D. The other-session route (this project's job for a session that is not current) offers no Open.
 *
 * Usage: node tests/e2e/connect-open-predictions.mjs   (PORT= to move its server)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeWorker } from '../connect/fake-worker.mjs';
import { runConnectE2E, check, fail, watchPage, pair } from './fixtures/connect-e2e.mjs';

const WS = 'ws://127.0.0.1:9632';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-open-preds-'));

await runConnectE2E(9398, async ({ browser, BASE }) => {
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    watchPage(page, { consoleTypes: /error/i });
    const dialogs = [];
    let dialogAnswer = true;
    page.on('dialog', (d) => { dialogs.push(d.message()); if (dialogAnswer) d.accept(); else d.dismiss(); });

    const worker = await FakeWorker.create({ mounts: [{ path: '/data', label: 'Data' }], serveFolder: '/data', workerInfo: { hostname: 'gpu-box' } });
    await worker.startBlobServer();
    await worker.serveOnPage(page, /^ws:\/\/127\.0\.0\.1:9632/);

    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    await page.waitForSelector('.panel-rail-btn[data-tab="tabConnect"]');
    await pair(page, worker, WS);
    const nodeId = worker.nodeId;
    const until = async (fn, arg, ms = 30000) => {
        const t = Date.now();
        while (Date.now() - t < ms) { if (await page.evaluate(fn, arg)) return true; await page.waitForTimeout(150); }
        throw new Error('until timed out: ' + fn.toString().slice(0, 120));
    };
    await until(() => import('./pose/connect/store.js').then((m) => m.useConnectStore.getState().connectionStatus === 'connected'), null, 20000);

    // Fixtures made in the page: a 12-frame mp4 and, per camera, a sleap-nn-like predictions .slp whose
    // video is the given worker path (20 predicted instances: frames 0-9, two animals, tracks t0/t1).
    const mp4b64 = await page.evaluate(async () => {
        const enc = await import('./ui/video-encode.js');
        const W = 160, H = 120, N = 12;
        const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
        const c = canvas.getContext('2d');
        const wr = await enc.createMp4Writer({ canvas, width: W, height: H, fps: 10, bitrate: 300000, frameCount: N, keyFrameEveryFrames: 4 });
        for (let i = 0; i < N; i++) { c.fillStyle = 'rgb(' + (10 * i) + ',60,90)'; c.fillRect(0, 0, W, H); await wr.addFrame(i); }
        const b = new Uint8Array(await (await wr.finish()).blob.arrayBuffer());
        let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
        return btoa(s);
    });
    const mp4 = Buffer.from(mp4b64, 'base64');
    const predSlp = (videoPath, nodes = ['A', 'B']) => page.evaluate(async ([videoPath, nodes]) => {
        const fio = await import('./import-export/file-io.js');
        const pd = await import('./pose/pose-data.js');
        const cam = 'v';
        const s = new pd.Session([new pd.Camera(cam, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [160, 120])],
            new pd.Skeleton('sk', nodes, [[0, 1]]), ['t0', 't1'], 'gen');
        for (let f = 0; f < 10; f++) {
            const fg = new pd.FrameGroup(f); s.addFrameGroup(fg);
            fg.addInstance(cam, new pd.Instance([[10 + f, 20], [30 + f, 40]], 0, 'predicted', 0.9));
            fg.addInstance(cam, new pd.Instance([[90 - f, 20], [70 - f, 40]], 1, 'predicted', 0.8));
        }
        const blob = await fio.exportSlpClientSide(s, cam, false, { videoPath, file: null, videoWidth: 160, videoHeight: 120, frameCount: 12 }, 'p.slp', null);
        const b = new Uint8Array(await blob.arrayBuffer());
        let out = ''; for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i]);
        return btoa(out);
    }, [videoPath, nodes]).then((b64) => new Uint8Array(Buffer.from(b64, 'base64')));
    let nDir = 0;
    const videos = (names) => {
        const dir = path.join(tmpRoot, 'pick' + (nDir++));
        fs.mkdirSync(dir);
        return names.map((n) => { const p = path.join(dir, n); fs.writeFileSync(p, mp4); return p; });
    };

    const mount = () => page.evaluate(async (wid) => {
        if (window.__wj) { window.__wj.destroy(); window.__wj = null; }
        document.getElementById('jobsHost')?.remove();
        const host = document.createElement('div');
        host.id = 'jobsHost';
        host.style.cssText = 'position:fixed;left:20px;top:20px;width:640px;height:600px;overflow:auto;z-index:9000;background:#222;padding:8px;box-sizing:border-box';
        document.body.appendChild(host);
        window.__closedWindow = 0;
        const m = await import('./ui/connect/worker-jobs.js');
        window.__wj = m.createWorkerJobs(host, { workerId: wid, workerLabel: 'gpu-box', pollIntervalMs: 600000, onCloseWindow: () => { window.__closedWindow++; } });
    }, nodeId);
    const reset = () => { worker.jobs.clear(); dialogs.length = 0; dialogAnswer = true; worker.calls.length = 0; };
    const fetchBtnOf = (jobId) => page.locator(`#jobsHost .cj-job[data-job-id="${jobId}"] button[data-act="fetch"]`);
    const dialogState = () => page.evaluate(() => {
        const d = document.querySelector('.cj-merge');
        return d ? {
            text: d.textContent, merge: !!document.getElementById('cjMergeGo'), open: !!document.getElementById('cjOpenProject'),
            openPrimary: !!document.querySelector('#cjOpenProject.connect-btn-primary'), download: !!document.getElementById('cjMergeDownload'),
            run: (document.getElementById('cjOpenRun') || {}).textContent || null,
            leftOut: [...d.querySelectorAll('.cj-merge-leftout')].map((x) => x.textContent),
        } : null;
    });
    const project = () => page.evaluate(() => {
        const s = window.__lucid.state;
        const per = {};
        let grouped = 0;
        if (s.session) for (const [, fg] of s.session.frameGroups) {
            for (const [, xs] of fg.instances) grouped += xs.length;
            for (const [cam, xs] of fg.unlinkedInstances) for (const u of xs) { const k = cam + ':' + u.instance.type; per[k] = (per[k] || 0) + 1; }
        }
        return {
            sessions: s.sessions.map((x) => x.name), session: s.session ? s.session.name : null,
            cameras: s.session ? s.session.cameras.map((c) => c.name) : [], views: s.views.map((v) => v.name),
            bound: s.videoFiles.map((vf) => (vf.file ? vf.file.name : '-') + '→' + vf.assignedCamera),
            tracks: s.session ? s.session.tracks.slice() : [], per, grouped,
            dirty: s.isDirty, handle: s.slpFileHandle ? s.slpFileHandle.name || 'handle' : null,
        };
    });
    const fetched = (ids) => page.evaluate(async (ids) => {
        const m = await import('./pose/connect/store.js');
        return ids.map((id) => { const j = m.useConnectStore.getState().trackedJobs.find((x) => x.jobId === id); return j ? j.fetchedAt != null : 'untracked'; });
    }, ids);
    const toastText = () => page.evaluate(() => [...document.querySelectorAll('.connect-toast')].map((t) => t.textContent).join(' | '));
    const answerVideoPrompt = async (paths) => {
        await page.waitForSelector('#videoSelectOverlay', { timeout: 30000 });
        page.once('filechooser', async (fc) => { await fc.setFiles(paths); });
        await page.click('#videoSelectOverlay >> text=Select Video Files');
    };

    // ======================================================================================== A
    console.log('\nA. No project open: a run this page submitted (cam1, cam2 done, cam3 failed)');
    reset();
    const runId = 'run-open-A';
    const ids = await page.evaluate(async ([wid, runId]) => {
        const m = await import('./pose/connect/store.js');
        const st = m.useConnectStore.getState();
        const out = [];
        for (const [i, cam] of ['cam1', 'cam2', 'cam3'].entries()) {
            const spec = { type: 'track', data_path: '/data/rec/' + cam + '.mp4', model_paths: ['/data/m'], output_path: '/data/rec/predictions/rec__' + cam + '.261117_120000.predictions.slp' };
            const got = await st.submitJobsOn(wid, spec, { source: 'window', sessionId: 'rec', camera: cam, projectTag: 'deadbeef', mergeMode: 'replace',
                run: { id: runId, index: i, count: 3 }, label: 'Inference · ' + cam });
            out.push(got[0]);
        }
        return out;
    }, [nodeId, runId]);
    for (const [i, cam] of ['cam1', 'cam2'].entries()) {
        const bytes = await predSlp('/data/rec/' + cam + '.mp4');
        worker.addFile('/data/rec/predictions/rec__' + cam + '.261117_120000.predictions.slp', bytes);
        await worker.completeJob(ids[i], { predictions: bytes });
    }
    worker.failJob(ids[2], 'exit code 1');
    await until((ids) => import('./pose/connect/store.js').then((m) => { const t = m.useConnectStore.getState().trackedJobs; return ids.every((id) => t.some((j) => j.jobId === id && j.state !== 'active')); }), ids);
    await mount();
    await page.waitForFunction((id) => document.querySelector(`#jobsHost .cj-job[data-job-id="${id}"] button[data-act="fetch"]`), ids[0], { timeout: 15000 });
    check(!(await page.$(`#jobsHost .cj-job[data-job-id="${ids[2]}"] button[data-act="fetch"]`)), 'the failed job has no Fetch & Load');
    await fetchBtnOf(ids[0]).click();
    await page.waitForSelector('#cjOpenProject', { timeout: 30000 });
    let ds = await dialogState();
    check(/No project open/.test(ds.text) && !ds.merge && ds.open && ds.openPrimary && ds.download, 'no project open: Open as new project (primary) and Download .slp, no Merge', ds);
    check(ds.run === 'This run: 2 cameras (cam1, cam2)', 'the summary names the run\'s cameras', ds.run);
    check(ds.leftOut.length === 1 && /cam3 is left out: failed/.test(ds.leftOut[0]), 'and the job left out (cam3 failed)', ds.leftOut);
    await page.click('#cjOpenProject');
    await answerVideoPrompt(videos(['cam1.mp4', 'cam2.mp4']));
    await page.waitForFunction(() => [...document.querySelectorAll('.connect-toast')].some((t) => /as a new, unsaved project/.test(t.textContent)), null, { timeout: 60000 });
    check(dialogs.length === 0, 'nothing open: no question asked', dialogs);
    check(!(await page.$('.cj-merge')), 'the dialog closed');
    check(await page.evaluate(() => window.__closedWindow === 1), 'the Connect window was closed (the load prompts for videos)');
    let pj = await project();
    console.log('  measured:', JSON.stringify(pj));
    check(pj.sessions.join() === 'rec' && pj.session === 'rec', 'ONE session, named after the tracked session ("rec")', pj.sessions);
    check(pj.cameras.join() === 'cam1,cam2', 'cameras = the run\'s views (cam1, cam2)', pj.cameras);
    check(pj.views.join() === 'cam1,cam2' && pj.bound.join() === 'cam1.mp4→cam1,cam2.mp4→cam2', 'the picked videos bound by name', pj.bound);
    check(pj.per['cam1:predicted'] === 20 && pj.per['cam2:predicted'] === 20 && pj.grouped === 0, '20 + 20 ungrouped predicted instances', pj.per);
    check(['cam1: t0', 'cam1: t1', 'cam2: t0', 'cam2: t1'].every((t) => pj.tracks.includes(t)), 'tracks named "<camera>: <track>"', pj.tracks);
    check(pj.dirty === true && pj.handle === null, 'a new, unsaved project: dirty, no file handle', [pj.dirty, pj.handle]);
    check(JSON.stringify(await fetched(ids)) === '[true,true,false]', 'the two opened jobs are marked fetched (the failed one is not)', await fetched(ids));
    check(/Opened 2 cameras as a new, unsaved project \(session rec\)/.test(await toastText()) && /cam3 \(failed\)/.test(await toastText()), 'the toast names the session and what was left out', await toastText());
    await page.evaluate(() => document.querySelectorAll('.connect-toast-close').forEach((b) => b.click()));

    // ======================================================================================== B
    console.log('\nB. A project open (dirty, file handle): a run from another LUCID device');
    reset();
    await page.evaluate(() => { const s = window.__lucid.state; s.slpFileHandle = { name: 'old-project.slp', kind: 'file' }; s.isDirty = true; });
    const OTHER = { id: 'ffffffff', name: 'elsewhere.slp' };
    const bIds = [];
    for (const [i, cam] of ['top', 'side'].entries()) {
        const out = '/data/rec2/predictions/rec2__' + cam + '.261117_130000.predictions.slp';
        const bytes = await predSlp('/data/rec2/videos/' + cam + '_cam.mp4');
        worker.addFile(out, bytes);
        const j = worker.addJob({ spec: { type: 'track', data_path: '/data/rec2/videos/' + cam + '_cam.mp4', model_paths: ['/data/m'], output_path: out, run: { id: 'run-B', index: i, count: 2 } },
            state: 'running', project: OTHER, jobId: 'b_' + cam + '_aaaaaaaa' });
        await worker.completeJob(j.job_id, { predictions: bytes });
        bIds.push(j.job_id);
    }
    await page.evaluate(() => window.__wj.refresh());
    await page.waitForFunction((id) => document.querySelector(`#jobsHost .cj-job[data-job-id="${id}"] button[data-act="fetch"]`), bIds[1], { timeout: 15000 });
    await fetchBtnOf(bIds[1]).click();
    await page.waitForSelector('#cjOpenProject', { timeout: 30000 });
    ds = await dialogState();
    check(/Open project:/.test(ds.text) && ds.merge && ds.open && !ds.openPrimary, 'a project open: Merge into view AND Open as new project', ds);
    check(ds.run === 'This run: 2 cameras (top_cam.mp4, side_cam.mp4)' && ds.leftOut.length === 0, 'the run: 2 cameras, none left out', ds.run);
    const before = await project();
    dialogAnswer = false;
    await page.click('#cjOpenProject');
    await page.waitForFunction(() => document.querySelector('#cjOpenProject'), null, { timeout: 30000 });
    check(dialogs.length === 1 && /Unsaved changes to the open project will be lost/.test(dialogs[0]) && /Open session rec2 \(top, side\) as a new project\?/.test(dialogs[0]),
        'asks first, naming unsaved changes, the session and its cameras', dialogs);
    const afterNo = await project();
    check(JSON.stringify(afterNo) === JSON.stringify(before) && afterNo.handle === 'old-project.slp', 'declined: nothing changed (same project, same file handle)', afterNo);
    check(!!(await page.$('.cj-merge')), 'and the dialog is still up');
    dialogAnswer = true;
    dialogs.length = 0;
    await page.click('#cjOpenProject');
    await answerVideoPrompt(videos(['top.mp4', 'side.mp4']));
    await page.waitForFunction(() => [...document.querySelectorAll('.connect-toast')].some((t) => /session rec2/.test(t.textContent)), null, { timeout: 60000 });
    pj = await project();
    console.log('  measured:', JSON.stringify(pj));
    check(dialogs.length === 1, 'asked once', dialogs);
    check(pj.sessions.join() === 'rec2' && pj.cameras.join() === 'top,side', 'the other device\'s run: session rec2, cameras top, side (from its output names)', pj);
    check(pj.views.join() === 'top,side' && pj.per['top:predicted'] === 20 && pj.per['side:predicted'] === 20, 'videos bound, predictions loaded', pj);
    check(pj.handle === null && pj.dirty === true, 'the old project\'s file handle is gone (Save cannot overwrite it); dirty', [pj.handle, pj.dirty]);
    check(JSON.stringify(await fetched(bIds)) === '["untracked","untracked"]', 'untracked jobs: nothing to mark');
    await page.evaluate(() => document.querySelectorAll('.connect-toast-close').forEach((b) => b.click()));

    // ======================================================================================== C
    console.log('\nC. A run whose cameras\' skeletons differ');
    reset();
    for (const [i, cam] of ['left', 'right'].entries()) {
        const out = '/data/rec3/' + cam + '.predictions.slp';
        const bytes = await predSlp('/data/rec3/' + cam + '.mp4', i === 0 ? ['A', 'B'] : ['A', 'Z']);
        worker.addFile(out, bytes);
        const j = worker.addJob({ spec: { type: 'track', data_path: '/data/rec3/' + cam + '.mp4', model_paths: ['/data/m'], output_path: out, run: { id: 'run-C', index: i, count: 2 } },
            state: 'running', project: OTHER, jobId: 'c_' + cam + '_aaaaaaaa' });
        await worker.completeJob(j.job_id, { predictions: bytes });
    }
    await page.evaluate(() => window.__wj.refresh());
    await page.waitForFunction(() => document.querySelector('#jobsHost .cj-job[data-job-id="c_left_aaaaaaaa"] button[data-act="fetch"]'), null, { timeout: 15000 });
    const beforeC = await project();
    await fetchBtnOf('c_left_aaaaaaaa').click();
    await page.waitForSelector('#cjOpenProject', { timeout: 30000 });
    await page.click('#cjOpenProject');
    await page.waitForFunction(() => [...document.querySelectorAll('.connect-toast')].some((t) => /Could not open these predictions/.test(t.textContent)), null, { timeout: 30000 });
    check(/skeletons differ: right has A, Z, left has A, B/.test(await toastText()), 'refused, naming both cameras\' nodes', await toastText());
    check(dialogs.length === 0 && JSON.stringify(await project()) === JSON.stringify(beforeC), 'nothing asked, nothing changed');
    await page.waitForSelector('#cjOpenProject', { timeout: 5000 });
    check(true, 'the dialog is back to its choices');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.cj-merge'));

    // ======================================================================================== D
    console.log('\nD. This project\'s job for a session that is not current');
    reset();
    const tag = await page.evaluate(async () => {
        const pt = await import('./pose/connect/project-tag.js');
        const ri = await import('./ui/connect/remote-inference.js');
        return pt.lucidProjectTag(ri.openProjectInfo());
    });
    const dBytes = await predSlp('/data/rec2/videos/top_cam.mp4');
    worker.addFile('/data/x.predictions.slp', dBytes);
    const dId = await page.evaluate(async ([wid, tag]) => {
        const m = await import('./pose/connect/store.js');
        const ids = await m.useConnectStore.getState().submitJobsOn(wid, { type: 'track', data_path: '/data/rec2/videos/top_cam.mp4', model_paths: ['/data/m'], output_path: '/data/x.predictions.slp', project: tag },
            { source: 'window', sessionId: 'not_this_session', camera: 'top', projectTag: tag.id, mergeMode: 'replace', label: 'Inference · top' });
        return ids[0];
    }, [nodeId, tag]);
    await worker.completeJob(dId, { predictions: dBytes });
    await page.evaluate(() => window.__wj.refresh());
    await page.waitForFunction((id) => document.querySelector(`#jobsHost .cj-job[data-job-id="${id}"] button[data-act="fetch"]`), dId, { timeout: 15000 });
    await fetchBtnOf(dId).click();
    await page.waitForSelector('.cj-merge #cjMergeDownload', { timeout: 30000 });
    ds = await dialogState();
    check(/These results are for session not_this_session/.test(ds.text) && !ds.open && !ds.merge && ds.run === null, 'refused with the session name; no Open as new project (that project has the session)', ds);
    await page.keyboard.press('Escape');
}, {
    onError: async (e) => {
        console.log('  ✗ threw', e);
        fail();
    },
});
