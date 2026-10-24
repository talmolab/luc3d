/**
 * campy-session-folder.mjs — loading a campy recording folder reads its
 * session.json (`loading/campy-session.js`, `adoptCampyRecording` in
 * `loading/session-loader.js`, the Session tab's Recording section in
 * `ui/recording-info.js`).
 *
 * The folders are written to disk and picked through the real folder input
 * (Playwright's file chooser), in campy's layout: session.json,
 * campy-live-session.json and calibration.toml at the top, each camera's video
 * at <Camera>/0.mp4 — every camera's video has the same name, as campy's
 * default does. Camera0's folder also holds a decoy `aaa.mp4` (7 frames, listed
 * first) that is not campy's video. The calibration lists Camera1 before
 * Camera0, so the view order says whose order won.
 *
 *  1. Load Session Folder (per camera): the frame rate is session.json's (20,
 *     not the video's), the views are in campy's order, each camera loads the
 *     video campy wrote, and the Recording section shows the status, the
 *     experiment, the animal IDs (with their ⓘ), the notes, the fields, the
 *     note added afterwards, campy's version, the cameras' serials and "same as
 *     campy-live's" for the calibration. No warning.
 *  2. A calibration that is not campy-live's: warning in the status bar and in
 *     the section, naming both hashes.
 *  3. An interrupted recording whose video runs at 10 fps: the status is a
 *     warning, the frame rate is still 20, and the section says what the video
 *     says.
 *  4. No calibration: the views are named Camera0 / Camera1 (not "0"), in
 *     campy's order.
 *  5. The same folder WITHOUT session.json loads exactly as before: the video's
 *     frame rate, the calibration's order, the first video in each folder, no
 *     Recording section.
 *  6. Single-SLP mode on a campy folder (campy-live.slp at the top, no
 *     videos/): the videos come from session.json, and the .slp is read rather
 *     than the points3d.h5 beside it.
 *  7. File → Load SLP, then Select Session Folder in the video prompt.
 *  8. File → Load Calibration on a campy session checks the new calibration.
 *  9. Reopening a project lazily (Load Project), then Select Session Folder;
 *     a recording campy never finished ("recording") is a warning.
 *
 * Run: node tests/e2e/campy-session-folder.mjs   (spawns its own http.server;
 * PORT= to move it)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const FIX = path.join(repoRoot, 'tests', 'fixtures', 'campy-recording');
const PORT = Number(process.env.PORT || 8377);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const sessionJson = JSON.parse(fs.readFileSync(path.join(FIX, 'session.json'), 'utf8'));
const liveJson = JSON.parse(fs.readFileSync(path.join(FIX, 'campy-live-session.json'), 'utf8'));
// campy's default video name: every camera's video is 0.mp4.
sessionJson.cameras.forEach(c => { c.video = c.name + '/0.mp4'; });

// The fixture's two cameras, Camera1 listed first.
const calibToml = fs.readFileSync(path.join(FIX, 'calibration.toml'), 'utf8')
    .split('\n\n').filter(Boolean);
const CALIB_REORDERED = [calibToml[1].replace('[cam_1]', '[cam_0]'), calibToml[0].replace('[cam_0]', '[cam_1]'),
    ...calibToml.slice(2)].join('\n\n') + '\n';
const sha = (s) => createHash('sha256').update(s).digest('hex');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-campy-'));

/** Write a recording folder; returns its path. */
function writeRecording(name, videos, opts = {}) {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const calib = opts.calib === undefined ? CALIB_REORDERED : opts.calib;
    if (calib !== null) fs.writeFileSync(path.join(dir, 'calibration.toml'), calib);
    if (opts.session !== false) {
        const s = structuredClone(sessionJson);
        if (opts.editSession) opts.editSession(s);
        fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(s, null, 2));
        const l = structuredClone(liveJson);
        // campy-live tracked with the reordered calibration (byte for byte).
        l.calibration.sha256 = sha(CALIB_REORDERED);
        fs.writeFileSync(path.join(dir, 'campy-live-session.json'), JSON.stringify(l, null, 2));
    }
    for (const cam of ['Camera0', 'Camera1']) {
        fs.mkdirSync(path.join(dir, cam), { recursive: true });
        fs.writeFileSync(path.join(dir, cam, '0.mp4'), videos[opts.fps10 ? 'v10' : 'v20']);
    }
    fs.writeFileSync(path.join(dir, 'Camera0', 'aaa.mp4'), videos.decoy);
    for (const [rel, bytes] of Object.entries(opts.extra || {})) fs.writeFileSync(path.join(dir, rel), bytes);
    return dir;
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 300)); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    // Videos: 20 frames at 20 fps and at 10 fps, and a 7-frame decoy.
    const videos = Object.fromEntries(Object.entries(await page.evaluate(async () => {
        const enc = await import('/ui/video-encode.js');
        async function makeMp4(n, fps) {
            const canvas = document.createElement('canvas');
            canvas.width = 160; canvas.height = 120;
            const cctx = canvas.getContext('2d');
            const wr = await enc.createMp4Writer({ canvas, width: 160, height: 120, fps,
                bitrate: 300000, frameCount: n, keyFrameEveryFrames: 5 });
            for (let i = 0; i < n; i++) {
                cctx.fillStyle = 'rgb(' + (10 * i) + ',60,90)'; cctx.fillRect(0, 0, 160, 120);
                await wr.addFrame(i);
            }
            const buf = new Uint8Array(await (await wr.finish()).blob.arrayBuffer());
            let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
            return btoa(s);
        }
        return { v20: await makeMp4(20, 20), v10: await makeMp4(20, 10), decoy: await makeMp4(7, 20) };
    })).map(([k, b64]) => [k, Buffer.from(b64, 'base64')]));

    const resetApp = () => page.evaluate(async () => {
        const sl = await import('/import-export/save-load.js');
        sl.newProject(true);
        const AS = await import('/ui/app-state.js');
        AS.state.sessions = []; AS.state.activeSessionIdx = 0; AS.state.session = null;
        AS.state.videoFiles = []; AS.state.views = []; AS.state.decoderPool = [];
    });

    /** Pick `dir` in the next folder input while `fn` (in the page) runs. */
    async function withFolder(dir, fn, arg) {
        page.once('filechooser', async (fc) => { await fc.setFiles(dir); });
        return page.evaluate(fn, arg);
    }

    const inspect = () => page.evaluate(() => {
        const s = window.__lucid.state;
        const sec = document.getElementById('recordingInfoSection');
        const rows = Array.from(sec.querySelectorAll('.recording-row')).map(r =>
            r.querySelector('.label').textContent + '=' + r.querySelector('.value').textContent);
        const blocks = Array.from(sec.querySelectorAll('.recording-block')).map(b => b.textContent);
        const warns = Array.from(sec.querySelectorAll('.recording-warn')).map(b => b.textContent);
        const info = document.getElementById('recordingAnimalIdsInfo');
        return {
            fps: s.fps,
            fpsText: document.getElementById('fpsDisplay').textContent,
            fpsTitle: document.getElementById('fpsDisplay').title,
            views: s.views.map(v => v.name),
            viewFrames: s.views.map(v => v.decoder ? v.decoder.samples.length : null),
            videoPaths: s.videoFiles.map(v => v.videoPath),
            cameras: s.session ? s.session.cameras.map(c => c.name) : [],
            status: document.getElementById('statusText').textContent,
            statusKind: document.getElementById('statusDot').className,
            hidden: sec.hidden,
            rows, blocks, warns,
            animalInfo: info ? info.dataset.infotip : null,
            cameraTable: Array.from(sec.querySelectorAll('.recording-cameras tbody tr')).map(tr =>
                Array.from(tr.children).map(td => td.textContent).join('|')),
            annotations: Array.from(sec.querySelectorAll('.recording-annotations li')).map(li => li.textContent),
            campyRecording: !!(s.session && s.session.campyRecording),
        };
    });

    const loadPerCamera = () => page.evaluate(async () => {
        const loader = await import('/loading/session-loader.js');
        await loader.handleLoadSessionFolderPerCamera();
    });

    // =================================================================
    console.log('\n1. Load Session Folder on a campy recording');
    {
        const dir = writeRecording('rec1', videos);
        await resetApp();
        page.once('filechooser', async (fc) => { await fc.setFiles(dir); });
        await loadPerCamera();
        const r = await inspect();
        console.log('  measured:', JSON.stringify(r).slice(0, 1200));
        check(r.fps === 20 && r.fpsText === '20.0 fps', `the frame rate is session.json's (${r.fpsText})`);
        check(r.fpsTitle === 'Frame rate from the recording\'s session.json', 'and its hover says so');
        check(r.views.join(',') === 'Camera0,Camera1', `views in campy's order (${r.views})`);
        check(r.cameras.join(',') === 'Camera1,Camera0', 'the calibration\'s camera list keeps its own order');
        check(r.viewFrames.join(',') === '20,20', `each camera loads campy's 0.mp4, not the decoy (${r.viewFrames})`);
        check(r.videoPaths.every(p => /\/0\.mp4$/.test(p)), 'videoPaths are the 0.mp4s');
        check(!r.hidden, 'the Recording section is shown');
        for (const want of ['Status=Complete', 'Experiment=social', 'Animal IDs=M1, M2', 'cage=B3',
            'Frame rate=20 fps (session.json)', 'campy=2.1.1rc1', 'Started=2026-10-23 04:07:04',
            'Calibration=same as campy-live\'s']) {
            check(r.rows.indexOf(want) >= 0, `row "${want}"`);
        }
        check(r.blocks.some(b => b === 'Notesnew bedding'), 'the notes');
        check(r.annotations.join() === '2026-10-23 04:07:08M2 sleeping', `the note added afterwards (${r.annotations})`);
        check(/never|does not match|nothing of which/.test(r.animalInfo || ''), 'the animal IDs\' ⓘ says they are not identities');
        check(r.cameraTable.join(';') === 'Camera0|emu0|Camera0/0.mp4;Camera1|emu1|Camera1/0.mp4', `the cameras (${r.cameraTable})`);
        check(r.warns.length === 0, 'no warning');
        check(/^Loaded 2 camera\(s\)$/.test(r.status) && /success/.test(r.statusKind), `status bar: ${r.status}`);
        const ids = await page.evaluate(() => window.__lucid.state.session.identities.map(i => i.name));
        check(!ids.some(n => /^M\d$/.test(n)), 'no identity is named after an animal ID');
    }

    // =================================================================
    console.log('\n2. A calibration that is not campy-live\'s');
    {
        const dir = writeRecording('rec2', videos, { calib: CALIB_REORDERED.replace('60.0, 0.0, 32.0', '61.0, 0.0, 32.0') });
        await resetApp();
        page.once('filechooser', async (fc) => { await fc.setFiles(dir); });
        await loadPerCamera();
        const r = await inspect();
        check(/warning/.test(r.statusKind) && /different calibration/.test(r.status), `status bar warns: ${r.status}`);
        check(r.status.indexOf(sha(CALIB_REORDERED).slice(0, 12)) >= 0, 'naming campy-live\'s hash');
        check(r.warns.some(w => /^Calibration.*different calibration/.test(w)), 'and the section says so');
    }

    // =================================================================
    console.log('\n3. Interrupted, and a video at 10 fps');
    {
        const dir = writeRecording('rec3', videos, { fps10: true, editSession: s => { s.status = 'interrupted'; } });
        await resetApp();
        page.once('filechooser', async (fc) => { await fc.setFiles(dir); });
        await loadPerCamera();
        const r = await inspect();
        check(r.fps === 20, `still session.json's 20 fps (got ${r.fps})`);
        check(r.rows.indexOf('Status=Interrupted') >= 0 && r.warns.some(w => /Ctrl-C/.test(w)), 'status: interrupted, explained');
        check(r.warns.some(w => /The video says 10 fps/.test(w)), 'the section says what the video says');
        check(/warning/.test(r.statusKind) && /recording status: interrupted/.test(r.status), `status bar: ${r.status}`);
    }

    // =================================================================
    console.log('\n4. No calibration');
    {
        const dir = writeRecording('rec4', videos, { calib: null });
        await resetApp();
        page.once('filechooser', async (fc) => { await fc.setFiles(dir); });
        await loadPerCamera();
        const r = await inspect();
        check(r.views.join(',') === 'Camera0,Camera1', `views named after campy's cameras, in its order (${r.views})`);
        check(r.fps === 20 && !r.hidden, 'frame rate and section as before');
        check(!r.rows.some(x => /^Calibration/.test(x)), 'no calibration row');
    }

    // =================================================================
    console.log('\n5. Without session.json: as before');
    {
        const dir = writeRecording('rec5', videos, { session: false });
        await resetApp();
        page.once('filechooser', async (fc) => { await fc.setFiles(dir); });
        await loadPerCamera();
        const r = await inspect();
        check(!r.campyRecording && r.hidden, 'no record, no Recording section');
        check(r.fpsTitle === '', 'no "from session.json" hover');
        check(r.views.join(',') === 'Camera1,Camera0', `views in the calibration's order (${r.views})`);
        const firstVid = r.videoPaths.find(p => p.indexOf('Camera0/') >= 0);
        check(/\/Camera0\/(aaa|0)\.mp4$/.test(firstVid), `Camera0 loads the first video its folder lists (${firstVid})`);
        check(/^Loaded 2 camera\(s\)$/.test(r.status), `status bar unchanged: ${r.status}`);
    }

    // A project .slp naming Camera0 and Camera1 (no videos inside).
    const slpBytes = Buffer.from(await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const fio = await import('/import-export/file-io.js');
        const K = [[60, 0, 32], [0, 60, 24], [0, 0, 1]];
        const cams = ['Camera0', 'Camera1'].map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.3 * i, 0], [-150 * i, 0, 0], [160, 120]));
        const session = new pd.Session(cams, new pd.Skeleton('skeleton', ['a', 'b'], [[0, 1]]), ['track_0'], 'campy-live');
        const fg = new pd.FrameGroup(0); session.addFrameGroup(fg);
        const g = new pd.InstanceGroup(1, -1);
        cams.forEach(c => { const inst = new pd.Instance([[10, 20], [30, 40]], 0, 'user', 1); fg.addInstance(c.name, inst); g.addInstance(c.name, inst); });
        g.points3d = [[1, 2, 3], [4, 5, 6]];
        session.instanceGroups.set(0, [g]);
        const views = cams.map(c => ({ name: c.name, videoWidth: 160, videoHeight: 120, frameCount: 20 }));
        const vfs = cams.map(c => ({ name: c.name, assignedCamera: c.name, videoPath: c.name + '/0.mp4' }));
        return Array.from(await window.SleapIO.saveSlpToBytes(fio.buildSlpLabelsAllViews(session, views, vfs)));
    }));

    // =================================================================
    console.log('\n6. Single-SLP mode on a campy folder');
    {
        const dir = writeRecording('rec6', videos, {
            extra: { 'campy-live.slp': slpBytes, 'points3d.h5': Buffer.from('not an h5 file') },
        });
        await resetApp();
        page.once('filechooser', async (fc) => { await fc.setFiles(dir); });
        await page.evaluate(async () => {
            const loader = await import('/loading/session-loader.js');
            await loader.handleLoadSessionFolderSingleSlp();
        });
        const r = await inspect();
        console.log('  measured:', JSON.stringify(r).slice(0, 600));
        check(/campy-live\.slp/.test(r.status), `the .slp was read, not points3d.h5 (${r.status})`);
        check(r.views.join(',') === 'Camera0,Camera1' && r.viewFrames.join(',') === '20,20',
            `the videos come from session.json (${r.views} / ${r.viewFrames})`);
        check(r.fps === 20 && !r.hidden && r.rows.indexOf('Calibration=same as campy-live\'s') >= 0,
            'frame rate, Recording section and the calibration check');
    }

    // =================================================================
    console.log('\n7. File → Load SLP, then Select Session Folder');
    {
        const dir = writeRecording('rec7', videos);
        await resetApp();
        await page.evaluate((bytes) => {
            window.__slpLoad = (async () => {
                const si = await import('/import-export/slp-import.js');
                await si.handleLoadSlpFile(new File([new Uint8Array(bytes)], 'campy-live.slp'));
            })();
        }, Array.from(slpBytes));
        await page.waitForSelector('#videoSelectOverlay', { timeout: 20000 });
        page.once('filechooser', async (fc) => { await fc.setFiles(dir); });
        await page.click('#videoSelectOverlay >> text=Select Session Folder');
        await page.evaluate(() => window.__slpLoad);
        const r = await inspect();
        console.log('  measured:', JSON.stringify(r).slice(0, 600));
        check(r.views.join(',') === 'Camera0,Camera1' && r.viewFrames.join(',') === '20,20',
            `views in campy's order, campy's videos (${r.views} / ${r.viewFrames})`);
        check(r.fps === 20 && !r.hidden && r.rows.indexOf('Experiment=social') >= 0, 'frame rate and Recording section');
        check(!r.rows.some(x => /^Calibration/.test(x)), 'no calibration check: the calibration came from the .slp');
        check(/success/.test(r.statusKind), `status bar: ${r.status}`);
    }

    // =================================================================
    console.log('\n8. File → Load Calibration on a campy session');
    {
        // Still the session from 7. Load a calibration that is not campy-live's.
        const other = path.join(tmpRoot, 'other-calibration.toml');
        fs.writeFileSync(other, CALIB_REORDERED.replace('60.0, 0.0, 32.0', '62.0, 0.0, 32.0'));
        page.once('filechooser', async (fc) => { await fc.setFiles(other); });
        await page.evaluate(async () => {
            const loader = await import('/loading/session-loader.js');
            await loader.handleLoadCalibration();
        });
        let r = await inspect();
        check(/warning/.test(r.statusKind) && /other-calibration\.toml.*different calibration/.test(r.status)
            && !/recording status/.test(r.status), `status bar: ${r.status}`);
        check(r.warns.some(w => /^Calibration/.test(w)), 'the section shows it');
        const same = path.join(tmpRoot, 'calibration.toml');
        fs.writeFileSync(same, CALIB_REORDERED);
        page.once('filechooser', async (fc) => { await fc.setFiles(same); });
        await page.evaluate(async () => {
            const loader = await import('/loading/session-loader.js');
            await loader.handleLoadCalibration();
        });
        r = await inspect();
        check(r.rows.indexOf('Calibration=same as campy-live\'s') >= 0 && /success/.test(r.statusKind),
            `campy-live's own calibration: no warning (${r.status})`);
    }

    // =================================================================
    console.log('\n9. Reopening a project lazily, then Select Session Folder');
    {
        const dir = writeRecording('rec9', videos, { editSession: s => { s.status = 'recording'; } });
        await resetApp();
        await page.evaluate((bytes) => {
            window.__lazyLoad = (async () => {
                const loader = await import('/loading/session-loader.js');
                await loader.handleLoadProjectSlpLazy(new File([new Uint8Array(bytes)], 'campy-live.slp'));
            })();
        }, Array.from(slpBytes));
        await page.waitForSelector('#videoSelectOverlay', { timeout: 20000 });
        page.once('filechooser', async (fc) => { await fc.setFiles(dir); });
        await page.click('#videoSelectOverlay >> text=Select Session Folder');
        await page.evaluate(() => window.__lazyLoad);
        const r = await inspect();
        console.log('  measured:', JSON.stringify(r).slice(0, 500));
        check(r.views.join(',') === 'Camera0,Camera1' && r.viewFrames.join(',') === '20,20',
            `views in campy's order, campy's videos (${r.views} / ${r.viewFrames})`);
        check(r.fps === 20 && !r.hidden, 'frame rate and Recording section');
        check(r.rows.indexOf('Status=Did not finish') >= 0 && r.warns.some(w => /lost power/.test(w)),
            'a recording campy never finished says so');
        check(/warning/.test(r.statusKind) && /recording status: did not finish/.test(r.status), `status bar: ${r.status}`);
    }
} finally {
    if (browser) await browser.close();
    server.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
