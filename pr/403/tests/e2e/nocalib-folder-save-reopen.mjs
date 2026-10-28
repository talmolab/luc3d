/**
 * nocalib-folder-save-reopen.mjs — a session folder loaded WITHOUT a
 * `calibration.toml` saves as a project `.slp` and reopens with its views and
 * every pose where it was.
 *
 * The bug (seen on a real annotator's project, 2026-10-22): the folder loaders
 * created NO cameras when there was no calibration, and the `.slp` writer
 * writes one video per `session.cameras` entry and drops every pose whose
 * camera is not in that list. So File ▸ Save reported "Saved" and wrote a valid
 * file with no videos, no frames and no poses, and reopening it showed nothing.
 * The per-camera loader also named each view after its video's STEM, so the
 * documented layout (`cam1/video.mp4`, `cam2/video.mp4`) gave two views both
 * called `video`, and the folder's own poses (keyed `cam1`, `cam2`) reached no
 * view at all.
 *
 *   1. Per-camera folder, no .toml: `cam1/video.mp4 + cam1.slp`,
 *      `cam2/video.mp4 + cam2.slp`, `cam3/video.mp4` (no poses yet). Loads as
 *      views cam1..cam3 with placeholder cameras (all-zero extrinsics, 3D off),
 *      the folder's poses in their views. A new pose is drawn in every view,
 *      then the REAL Save As (`buildSlpBytes`) writes the file.
 *   2. The file holds 3 videos and every pose (read back with the app's own
 *      `parseSlpViaSleapIO`).
 *   3. File ▸ Open (`handleLoadSlpFile`) in a FRESH page, answering its video
 *      prompt with the folder: the views come back by camera-folder name and
 *      every pose is at the same position; no 3D viewer for placeholder cameras.
 *      (Scenario 1 also checks Track All asks for a calibration instead of
 *      tracking on cameras that all sit at the origin.)
 *   4. Deferred videos (the multi-session folder load decodes on session
 *      switch): every camera folder still gets its camera, and the save keeps
 *      all poses.
 *   5. The save-side net: a session built with views and poses but no cameras
 *      (as any loader might leave it) saves its videos and poses too.
 *   6. "Single .slp" folder (`labels.slp` + `videos/`, `handleLoadSessionFolderSingleSlp`)
 *      with a plain SLEAP file that carries no calibration: placeholder camera
 *      per view, saves every pose, and the saved project reopened through the
 *      same loader keeps 3D off (its embedded cameras are placeholders).
 *
 * Run: node tests/e2e/nocalib-folder-save-reopen.mjs   (spawns its own http.server)
 *      KEEP_SLP=/tmp/nocal.slp keeps scenario 1's saved project.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8296);
const VIDEO = path.join(repoRoot, 'tests', 'fixtures', 'barcode-60', 'barcode-60.mp4');
const ROOT = 'nocal';
const CAMS = ['cam1', 'cam2', 'cam3'];
const CAMS_WITH_SLP = ['cam1', 'cam2'];

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Open the app on a fresh page; collect page errors. */
async function openApp(browser) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 20000 });
    return { page, errs };
}

/**
 * In the page: build the folder's files (videos + per-camera .slp files) and
 * run it through "Load Single Session Folder" (per-camera mode). Shared by
 * scenarios 1 and 4.
 */
async function loadFolder(page, deferVideos) {
    return page.evaluate(async ({ ROOT, CAMS, CAMS_WITH_SLP, deferVideos }) => {
        const loader = await import('/loading/session-loader.js');
        const fio = await import('/import-export/file-io.js');
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const vid = await (await fetch('/tests/fixtures/barcode-60/barcode-60.mp4')).blob();
        const mkFile = (bits, rel, type) => {
            const f = new File(bits, rel.split('/').pop(), { type });
            Object.defineProperty(f, 'webkitRelativePath', { value: rel });
            return f;
        };
        const files = CAMS.map(cn => mkFile([vid], `${ROOT}/${cn}/video.mp4`, 'video/mp4'));
        for (const [ci, cn] of CAMS_WITH_SLP.entries()) {
            // A per-camera SLEAP file: no calibration, poses on frames 0..3.
            const s = new pd.Session([new pd.Camera(cn, [[600, 0, 128], [0, 600, 16], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [256, 32])],
                new pd.Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0'], 'gen');
            for (let f = 0; f < 4; f++) {
                const fg = new pd.FrameGroup(f); s.addFrameGroup(fg);
                fg.addInstance(cn, new pd.Instance([[10 + f + 100 * ci, 5], [40 + f, 20 + ci]], 0, 'user', 1));
            }
            const bytes = await fio.exportSlpClientSide(s, cn, false,
                { videoPath: `${ROOT}/${cn}/video.mp4`, file: null, videoWidth: 256, videoHeight: 32, frameCount: 60 },
                cn + '.slp', null);
            files.push(mkFile([bytes], `${ROOT}/${cn}/${cn}.slp`, 'application/x-hdf5'));
        }
        AS.state.sessions = []; AS.state.activeSessionIdx = 0;
        AS.state.videoFiles = []; AS.state.session = null; AS.state.views = []; AS.state.decoderPool = [];
        await loader.handleLoadSessionFolderPerCamera(files, deferVideos);
        await new Promise(r => setTimeout(r, 300));
        const S = AS.state;
        return {
            status: document.getElementById('statusText').textContent,
            views: S.views.map(v => v.name),
            cams: S.session.cameras.map(c => ({ name: c.name, rvec: c.rvec, tvec: c.tvec, size: c.size })),
            vfs: S.videoFiles.map(v => v.name + '->' + v.assignedCamera),
            msg3dHidden: (() => { const m = document.getElementById('viewport3dMessage'); return m ? m.classList.contains('hidden') : null; })(),
        };
    }, { ROOT, CAMS, CAMS_WITH_SLP, deferVideos });
}

/** In the page: every pose of the active session, as "cam@frame" → sorted point lists. */
const posesOf = () => {
    const sess = window.__lucid.state.session;
    const out = {};
    const add = (cam, f, inst) => {
        const pts = [];
        for (let k = 0; k < inst.numNodes; k++) {
            const p = inst.getPoint ? inst.getPoint(k) : inst.points[k];
            pts.push(p ? [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000] : null);
        }
        (out[cam + '@' + f] = out[cam + '@' + f] || []).push(JSON.stringify(pts));
    };
    for (const [f, fg] of sess.frameGroups) {
        for (const [cam, arr] of fg.instances) for (const i of arr) add(cam, f, i);
        for (const [cam, arr] of fg.unlinkedInstances) for (const u of arr) add(cam, f, u.instance || u);
    }
    for (const k in out) out[k].sort();
    return out;
};

/** In the page: save through the real Save As into a stand-in file handle. */
const saveAsBytes = async () => {
    const saveLoad = await import('/import-export/save-load.js');
    const chunks = [];
    window.showSaveFilePicker = async () => ({
        name: 'project.slp',
        createWritable: async () => ({
            write: async (c) => { chunks.push(new Uint8Array(c.buffer ? c.slice(0) : c)); },
            close: async () => {}, abort: async () => {},
        }),
    });
    await saveLoad.saveAs();
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const bytes = new Uint8Array(total); let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
    return { status: document.getElementById('statusText').textContent, bytes: Array.from(bytes) };
};

/** In the page: what the saved file holds, read back with the app's own reader. */
const fileSummary = async (bytes) => {
    const fio = await import('/import-export/file-io.js');
    const d = await fio.parseSlpViaSleapIO(new File([new Uint8Array(bytes)], 'project.slp'), () => {});
    const sd = (d.sessions || [])[0] || {};
    const calib = sd.calibration || {};
    let nInst = 0;
    for (const fr of d.frames || []) nInst += (fr.instances || []).length;
    return {
        videos: (d.videos || []).map(v => v.sourceFilename || v.filename),
        frames: (d.frames || []).length,
        instances: nInst,
        cameras: Object.keys(calib).filter(k => k !== 'metadata').map(k => calib[k].name),
    };
};

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-nocalib-'));
const fixtureDir = path.join(fixtureRoot, ROOT);
for (const cn of CAMS) {
    fs.mkdirSync(path.join(fixtureDir, cn), { recursive: true });
    fs.copyFileSync(VIDEO, path.join(fixtureDir, cn, 'video.mp4'));
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch();

try {
    // ---------------------------------------------------------------- 1 --
    console.log('\n-- 1. per-camera folder with no calibration.toml loads with a camera per view --');
    const { page, errs } = await openApp(browser);
    const loaded = await loadFolder(page, false);
    console.log('  measured:', JSON.stringify(loaded));
    check(eq(loaded.views, CAMS), `views are named by camera folder, no 'video' collision (got ${JSON.stringify(loaded.views)})`);
    check(eq(loaded.cams.map(c => c.name), CAMS), 'one camera per camera folder');
    check(loaded.cams.every(c => eq(c.rvec, [0, 0, 0]) && eq(c.tvec, [0, 0, 0])), 'all are placeholders (all-zero extrinsics)');
    check(loaded.cams.every(c => eq(c.size, [256, 32])), 'each sized from its video');
    check(eq(loaded.vfs, CAMS.map(c => c + '->' + c)), 'every video is assigned to its camera');
    check(loaded.msg3dHidden !== true, 'the 3D viewer stays off (no calibration)');
    check(/no calibration/.test(loaded.status), `status still says there is no calibration ("${loaded.status}")`);

    const before = await page.evaluate(posesOf);
    check(CAMS_WITH_SLP.every(cn => [0, 1, 2, 3].every(f => (before[cn + '@' + f] || []).length === 1)),
        "the folder's own poses are keyed by the camera their view now has");

    // Draw a new pose in every view (keyed by the view's name, as the canvas does).
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const S = window.__lucid.state;
        if (!S.session.frameGroups.has(7)) S.session.addFrameGroup(new pd.FrameGroup(7));
        S.views.forEach((v, i) => S.session.getFrameGroup(7)
            .addInstance(v.name, new pd.Instance([[60 + i, 6], [90 + i, 26]], 0, 'user', 1)));
    });
    const annotated = await page.evaluate(posesOf);
    const nPoses = Object.values(annotated).reduce((n, a) => n + a.length, 0);
    check(nPoses === 4 * CAMS_WITH_SLP.length + CAMS.length, `${nPoses} poses in the project before saving`);

    const saved = await page.evaluate(saveAsBytes);
    check(/^Saved/.test(saved.status), `Save As went through ("${saved.status}")`);

    // Placeholder cameras all sit at the origin: Track All must refuse (as
    // Triangulate does) rather than build groups from 3D with no baseline.
    const track = await page.evaluate(async () => {
        const tracker = await import('/pose/tracker.js');
        const r = await tracker.trackAll();
        const popup = [...document.querySelectorAll('div')].some(d => d.textContent === 'Calibration Required');
        let groups = 0;
        for (const gs of window.__lucid.state.session.instanceGroups.values()) groups += gs.length;
        [...document.querySelectorAll('button')].filter(b => b.textContent === 'OK').forEach(b => b.click());
        return { ok: r && r.ok, popup, groups };
    });
    check(track.popup && track.ok === false && track.groups === 0,
        `Track All asks for a calibration and builds no groups (${JSON.stringify(track)})`);

    // ---------------------------------------------------------------- 2 --
    console.log('\n-- 2. the saved file holds the videos and every pose --');
    // KEEP_SLP=<path> keeps the saved file, e.g. for scripts/validate_slp_sleap_compat.py.
    if (process.env.KEEP_SLP) fs.writeFileSync(process.env.KEEP_SLP, Buffer.from(saved.bytes));
    const summary = await page.evaluate(fileSummary, saved.bytes);
    console.log('  file:', JSON.stringify(summary));
    check(eq(summary.cameras, CAMS), 'the session\'s cameras are in the file');
    check(eq(summary.videos, CAMS.map(c => `${ROOT}/${c}/video.mp4`)), 'one video per camera, by its path in the folder');
    check(summary.instances === nPoses, `every pose was written (${summary.instances} of ${nPoses})`);
    check(errs.length === 0, `no page errors (${JSON.stringify(errs)})`);
    await page.close();

    // ---------------------------------------------------------------- 3 --
    console.log('\n-- 3. File ▸ Open in a fresh page brings back the views and the poses --');
    const { page: p2, errs: errs2 } = await openApp(browser);
    await p2.evaluate((arr) => { window.__bytes = new Uint8Array(arr); }, saved.bytes);
    p2.on('filechooser', fc => fc.setFiles(fixtureDir));
    await p2.evaluate(() => {
        window.__done = false;
        import('/import-export/slp-import.js')
            .then(m => m.handleLoadSlpFile(new File([window.__bytes], 'project.slp')))
            .then(() => { window.__done = true; }, e => { window.__done = 'ERR ' + (e && e.stack || e); });
    });
    let answered = false;
    for (let i = 0; i < 200; i++) {
        const s = await p2.evaluate(() => {
            const btn = [...document.querySelectorAll('#videoSelectOverlay button')]
                .find(b => /Select Session Folder/.test(b.textContent));
            return { done: window.__done, prompt: !!btn };
        });
        if (s.prompt && !answered) {
            answered = true;
            await p2.click('#videoSelectOverlay button:has-text("Select Session Folder")');
        }
        if (s.done) break;
        await p2.waitForTimeout(250);
    }
    const reopened = await p2.evaluate(() => {
        const S = window.__lucid.state;
        return {
            done: window.__done,
            views: S.views.map(v => v.name + ':' + v.videoWidth + 'x' + v.videoHeight),
            cams: S.session ? S.session.cameras.map(c => c.name) : [],
            vfs: S.videoFiles.map(v => v.assignedCamera + '<-' + (v.file && v.file.webkitRelativePath)),
            status: document.getElementById('statusText').textContent,
        };
    });
    const vp3d = await p2.evaluate(async () => !!(await import('/ui/app-state.js')).viewport3d);
    console.log('  measured:', JSON.stringify(reopened));
    check(reopened.done === true, 'handleLoadSlpFile completed');
    check(answered, 'it asked for the videos, and was given the folder');
    check(eq(reopened.cams, CAMS), 'the cameras come back');
    check(!vp3d, 'the 3D viewer is not set up for placeholder cameras');
    // Compared as sets: File ▸ Open lays views out in the picker's file order
    // (only a campy recording is re-ordered), calibrated or not.
    check(eq([...reopened.views].sort(), CAMS.map(c => c + ':256x32')), 'every view comes back, by camera-folder name');
    check(eq([...reopened.vfs].sort(), CAMS.map(c => `${c}<-${ROOT}/${c}/video.mp4`)), "each camera got its own folder's video");
    const after = await p2.evaluate(posesOf);
    check(eq(after, annotated), 'every pose is back, on the same frame, in the same view, at the same position');
    if (!eq(after, annotated)) console.log('  before:', JSON.stringify(annotated), '\n  after: ', JSON.stringify(after));
    check(errs2.length === 0, `no page errors (${JSON.stringify(errs2)})`);
    await p2.close();

    // ---------------------------------------------------------------- 4 --
    console.log('\n-- 4. deferred videos (multi-session folder load): every camera folder still gets its camera --');
    const { page: p3, errs: errs3 } = await openApp(browser);
    const deferred = await loadFolder(p3, true);
    console.log('  measured:', JSON.stringify(deferred));
    check(eq(deferred.cams.map(c => c.name), CAMS), 'one camera per camera folder, with no video decoded yet');
    check(eq(deferred.vfs, CAMS.map(c => c + '->' + c)), 'every deferred video is assigned to its camera');
    const deferredPoses = await p3.evaluate(posesOf);
    const nDeferred = Object.values(deferredPoses).reduce((n, a) => n + a.length, 0);
    const savedDeferred = await p3.evaluate(saveAsBytes);
    const sumDeferred = await p3.evaluate(fileSummary, savedDeferred.bytes);
    console.log('  file:', JSON.stringify(sumDeferred));
    check(nDeferred === 4 * CAMS_WITH_SLP.length && sumDeferred.instances === nDeferred,
        `every pose was written (${sumDeferred.instances} of ${nDeferred})`);
    check(eq(sumDeferred.cameras, CAMS), 'with every camera');
    check(errs3.length === 0, `no page errors (${JSON.stringify(errs3)})`);
    await p3.close();

    // ---------------------------------------------------------------- 5 --
    console.log('\n-- 5. the save-side net: a session with views and poses but NO cameras still saves them --');
    const { page: p4, errs: errs4 } = await openApp(browser);
    const net = await p4.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const S = AS.state;
        const sess = new pd.Session([], new pd.Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], 'handmade');
        const fg = new pd.FrameGroup(2); sess.addFrameGroup(fg);
        fg.addInstance('left', new pd.Instance([[11, 12], [13, 14]], 0, 'user', 1));
        fg.addInstance('right', new pd.Instance([[21, 22], [23, 24]], 0, 'user', 1));
        S.sessions = [sess]; S.activeSessionIdx = 0; S.session = sess;
        S.views = [{ name: 'left', videoWidth: 320, videoHeight: 240 }, { name: 'right', videoWidth: 320, videoHeight: 240 }];
        S.videoFiles = [
            { name: 'left', assignedCamera: null, videoPath: 'rec/left.mp4', videoWidth: 320, videoHeight: 240, frameCount: 10, sessionIdx: 0 },
            { name: 'right', assignedCamera: null, videoPath: 'rec/right.mp4', videoWidth: 320, videoHeight: 240, frameCount: 10, sessionIdx: 0 },
        ];
        sess.videoFileIndices = [0, 1];
        return { camsBefore: sess.cameras.length };
    });
    const netSaved = await p4.evaluate(saveAsBytes);
    const netSum = await p4.evaluate(fileSummary, netSaved.bytes);
    const netCams = await p4.evaluate(() => window.__lucid.state.session.cameras.map(c => c.name));
    console.log('  file:', JSON.stringify(netSum));
    check(net.camsBefore === 0, 'the session starts with no cameras');
    check(eq(netSum.videos, ['rec/left.mp4', 'rec/right.mp4']), 'both videos were written');
    check(netSum.instances === 2, `both poses were written (${netSum.instances})`);
    check(eq(netCams, ['left', 'right']), 'and the session now has a placeholder camera per view');
    check(errs4.length === 0, `no page errors (${JSON.stringify(errs4)})`);
    await p4.close();

    // ---------------------------------------------------------------- 6 --
    console.log('\n-- 6. single-.slp folder (labels.slp + videos/, no calibration anywhere): load, save, reopen --');
    const SINGLE_CAMS = ['back', 'side'];
    const { page: p5, errs: errs5 } = await openApp(browser);
    // A plain SLEAP file: two videos, poses on frames 0..2, NO recording session
    // (so no calibration is embedded either).
    const sleap = await p5.evaluate(async (cams) => {
        const pd = await import('/pose/pose-data.js');
        const fio = await import('/import-export/file-io.js');
        const s = new pd.Session(cams.map(n => new pd.Camera(n, [[600, 0, 128], [0, 600, 16], [0, 0, 1]],
            [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [256, 32])),
            new pd.Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], 'sleap');
        for (let f = 0; f < 3; f++) {
            const fg = new pd.FrameGroup(f); s.addFrameGroup(fg);
            cams.forEach((cn, ci) => fg.addInstance(cn, new pd.Instance([[30 + f, 4 + ci], [70 + ci, 24]], 0, 'user', 1)));
        }
        const labels = fio.buildSlpLabelsAllViews(s,
            cams.map(n => ({ name: n, videoWidth: 256, videoHeight: 32, frameCount: 60 })),
            cams.map(n => ({ name: n, assignedCamera: n, videoPath: 'videos/' + n + '.mp4' })));
        labels.sessions.length = 0;
        return Array.from(await window.SleapIO.saveSlpToBytes(labels));
    }, SINGLE_CAMS);
    const sleapSum = await p5.evaluate(fileSummary, sleap);
    check(sleapSum.cameras.length === 0 && sleapSum.instances === 6, `the fixture has poses and no calibration (${JSON.stringify(sleapSum)})`);

    const writeSingleFolder = (name, slpName, bytes) => {
        const dir = path.join(fixtureRoot, name);
        fs.mkdirSync(path.join(dir, 'videos'), { recursive: true });
        fs.writeFileSync(path.join(dir, slpName), Buffer.from(bytes));
        for (const cn of SINGLE_CAMS) fs.copyFileSync(VIDEO, path.join(dir, 'videos', cn + '.mp4'));
        return dir;
    };
    const loadSingle = async (pg, dir) => {
        pg.once('filechooser', fc => fc.setFiles(dir));
        await pg.evaluate(async () => {
            const m = await import('/loading/session-loader.js');
            await m.handleLoadSessionFolderSingleSlp();
        });
        await pg.waitForTimeout(300);
        return pg.evaluate(() => {
            const S = window.__lucid.state;
            const m = document.getElementById('viewport3dMessage');
            return {
                views: S.views.map(v => v.name).sort(),
                cams: S.session.cameras.map(c => ({ name: c.name, placeholder: c.rvec.every(x => x === 0) && c.tvec.every(x => x === 0) })),
                vfs: S.videoFiles.map(v => v.name + '->' + v.assignedCamera).sort(),
                msg3dHidden: m ? m.classList.contains('hidden') : null,
            };
        });
    };

    const single = await loadSingle(p5, writeSingleFolder('single', 'labels.slp', sleap));
    console.log('  loaded:', JSON.stringify(single));
    check(eq(single.views, SINGLE_CAMS), 'a view per video');
    check(eq(single.cams.map(c => c.name).sort(), SINGLE_CAMS) && single.cams.every(c => c.placeholder),
        'a placeholder camera per view');
    check(eq(single.vfs, SINGLE_CAMS.map(c => c + '->' + c)), 'every video assigned to its camera');
    check(single.msg3dHidden !== true, 'the 3D viewer stays off');
    const singlePoses = await p5.evaluate(posesOf);
    const singleSaved = await p5.evaluate(saveAsBytes);
    const singleSum = await p5.evaluate(fileSummary, singleSaved.bytes);
    console.log('  file:', JSON.stringify(singleSum));
    check(singleSum.instances === 6 && eq(singleSum.cameras.slice().sort(), SINGLE_CAMS),
        `every pose and camera was written (${singleSum.instances} of 6)`);
    check(errs5.length === 0, `no page errors (${JSON.stringify(errs5)})`);
    await p5.close();

    // Reopen the SAVED project through the same loader: its cameras are now
    // embedded, but they are placeholders, so 3D must stay off.
    const { page: p6, errs: errs6 } = await openApp(browser);
    const single2 = await loadSingle(p6, writeSingleFolder('single-reopen', 'project.slp', singleSaved.bytes));
    console.log('  reopened:', JSON.stringify(single2));
    check(eq(single2.views, SINGLE_CAMS), 'reopened: every view is back');
    check(eq(single2.vfs, SINGLE_CAMS.map(c => c + '->' + c)), 'reopened: every video assigned to its camera');
    check(single2.msg3dHidden !== true, 'reopened: embedded placeholder cameras do not switch the 3D viewer on');
    check(eq(await p6.evaluate(posesOf), singlePoses), 'reopened: every pose is back at the same position');
    check(errs6.length === 0, `no page errors (${JSON.stringify(errs6)})`);
    await p6.close();
} finally {
    await browser.close();
    server.kill();
    try { fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(fails === 0
    ? '\nPASS: an uncalibrated session folder saves and reopens with its views and poses.'
    : `\nFAIL: ${fails} assertion(s) failed.`);
process.exit(fails === 0 ? 0 : 1);
