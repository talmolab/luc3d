/**
 * load-slp-session-folder.mjs — File ▸ Load SLP… takes every camera's video at once
 * from a recording folder where each video sits in its own camera folder.
 *
 * A recording folder (`20260506_…/Camera1_topB/0.mp4`, `Camera2_topB/0.mp4`, …) cannot
 * be multi-selected in a file picker, and Load SLP with a project already open
 * (`handleAddSlp`) offered only "Select Video Files". Its prompt (`forceVideoSelection`)
 * now also has "Select Session Folder". The folder also holds a camera the `.slp` does not
 * name and campy's `session.json`, and campy names every camera's video `0.mp4`: a video
 * loads only on a camera its folder or path places it on (`assignFolderVideos`,
 * loading/video-file-pick.js); the rest are not decoded.
 *
 * The fixture: copies of the demo clips at rec/Camera1_topB/0.mp4, rec/Camera2_topB/0.mp4
 * and rec/Camera5_side/0.mp4, with a campy session.json at the root. Each `.slp` has a
 * recording session whose calibration names the cameras: `top.slp` has Camera1_topB and
 * Camera2_topB on `/data/rec/Camera1_topB/0.mp4` and `/data/rec/Camera2_topB/0.mp4`,
 * `side.slp` one camera named "side" on `/data/rec/Camera5_side/0.mp4`.
 *
 *  A. A fresh Load SLP of top.slp (`handleLoadSlpFile`, whose prompt already had the
 *     folder button): each top camera gets its own 0.mp4, the side camera's 0.mp4 is not
 *     loaded (the referenced-name rule matched it to Camera1_topB, and as the first one
 *     listed it took that camera's place), and the manifest reaches the session
 *     (`session.campyRecording`), not the videos.
 *  B. With that project open, Load SLP side.slp: the prompt offers Select Session Folder,
 *     Select Video Files and Continue Without Video; the folder adds ONE video, the side
 *     camera's (its camera is named "side", not after its folder, so only the referenced
 *     folder + name places it).
 *  C. Load SLP top.slp again: the same cameras on the same videos are not added a second
 *     time (`camerasAlreadyInSession`) and no prompt opens. The same recording referenced
 *     from another copy of it (topCopy.slp, `/mnt/backup/rec/…`): its cameras are renamed
 *     (`Camera1_topB_2`, …) because the names are taken, and each still gets its own 0.mp4
 *     by the referenced folder + name.
 *  D. Esc on the prompt (extra.slp, a camera not in the session) continues without video.
 *
 * Negative control, run once on the build before this change: in A Camera1_topB shows
 * rec/Camera5_side/0.mp4, and B finds no Select Session Folder.
 *
 * Run: node tests/e2e/load-slp-session-folder.mjs   (spawns its own http.server; PORT= to move it)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8773);
const NFRAMES = 21;   // the demo clips' length

let fails = 0;
const check = (c, m, got) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (!c && got !== undefined ? ' — got ' + JSON.stringify(got) : ''));
    if (!c) fails++;
};

// ── The recording folder ────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-slp-folder-'));
const rec = path.join(tmp, 'rec');
const CLIPS = { Camera1_topB: 'back', Camera2_topB: 'mid', Camera5_side: 'side' };
for (const [cam, clip] of Object.entries(CLIPS)) {
    fs.mkdirSync(path.join(rec, cam), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'sample_session', clip + '.mp4'), path.join(rec, cam, '0.mp4'));
}
const sessionJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests/fixtures/campy-recording/session.json'), 'utf8'));
const camTemplate = sessionJson.cameras[0];
sessionJson.cameras = Object.keys(CLIPS).map((name, i) => Object.assign({}, camTemplate,
    { index: i, selection: i, name, serial: 'emu' + i, folder: name, video: name + '/0.mp4' }));
fs.writeFileSync(path.join(rec, 'session.json'), JSON.stringify(sessionJson, null, 2));

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    await page.evaluate(() => {
        localStorage.setItem('folderConfirmTipDismissed', '1');
        // Every pick goes through an <input> the test answers.
        window.showOpenFilePicker = undefined;
    });

    // ── The .slp files, written by the app's own sleap-io.js ──────────────
    const slps = await page.evaluate(async (NFRAMES) => {
        const S = window.SleapIO;
        const nodes = ['nose', 'head', 'tail'].map(n => new S.Node(n));
        const skeleton = new S.Skeleton({ nodes, edges: [new S.Edge(nodes[0], nodes[1]), new S.Edge(nodes[1], nodes[2])], name: 'mouse' });
        const track = new S.Track('m1');
        const make = async (cams) => {
            const paths = cams.map(c => c[1]);
            const videos = paths.map(fn => {
                const v = new S.Video({ filename: fn, backendMetadata: { type: 'MediaVideo', shape: [NFRAMES, 480, 640, 3], filename: fn }, openBackend: false });
                v.shape = [NFRAMES, 480, 640, 3];
                return v;
            });
            const lfs = [];
            videos.forEach((video, vi) => {
                for (let f = 0; f < 5; f++) {
                    lfs.push(new S.LabeledFrame({ video, frameIdx: f, instances: [new S.Instance({
                        points: [0, 1, 2].map(j => ({ xy: [100 + 50 * vi + 10 * j, 100 + f + 10 * j], visible: true, complete: true })),
                        skeleton, track,
                    })] }));
                }
            });
            // A recording session: the calibration names the cameras.
            const camGroup = new S.CameraGroup();
            const sioCams = cams.map(([name], c) => {
                const cam = new S.Camera({ name, rvec: [0, 0, 0], tvec: [c * 100, 0, 0],
                    matrix: [[600, 0, 320], [0, 600, 240], [0, 0, 1]], distortions: [0, 0, 0, 0, 0], size: [640, 480] });
                camGroup.cameras.push(cam);
                return cam;
            });
            const session = new S.RecordingSession({ cameraGroup: camGroup, metadata: {} });
            videos.forEach((v, c) => session.addVideo(v, sioCams[c]));
            const bytes = await S.saveSlpToBytes(new S.Labels({ labeledFrames: lfs, videos, skeletons: [skeleton], tracks: [track], sessions: [session], provenance: {} }));
            let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
            return btoa(s);
        };
        return {
            top: await make([['Camera1_topB', '/data/rec/Camera1_topB/0.mp4'], ['Camera2_topB', '/data/rec/Camera2_topB/0.mp4']]),
            side: await make([['side', '/data/rec/Camera5_side/0.mp4']]),
            // The same recording, referenced from another copy of it: same camera names, other paths.
            topCopy: await make([['Camera1_topB', '/mnt/backup/rec/Camera1_topB/0.mp4'], ['Camera2_topB', '/mnt/backup/rec/Camera2_topB/0.mp4']]),
            extra: await make([['extra', '/data/rec/Camera9_extra/0.mp4']]),
        };
    }, NFRAMES);
    for (const [k, b64] of Object.entries(slps)) fs.writeFileSync(path.join(tmp, k + '.slp'), Buffer.from(b64, 'base64'));

    const status = () => page.evaluate(() => document.getElementById('statusText').textContent);
    const videos = () => page.evaluate(() => window.__lucid.state.videoFiles.map(v =>
        (v.assignedCamera || '(none)') + ' <- ' + (v.file ? (v.file.webkitRelativePath || v.file.name) : '(no file)')));
    const viewNames = () => page.evaluate(() => window.__lucid.state.views.map(v => v.name).sort());

    /** File ▸ Load SLP… with `slpName`; waits for the video prompt; returns its buttons. */
    async function loadSlp(slpName) {
        page.once('filechooser', fc => fc.setFiles(path.join(tmp, slpName)));
        await page.evaluate(() => document.getElementById('menuLoadSlp').click());
        await page.waitForSelector('#videoSelectOverlay', { timeout: 30000 });
        return page.$$eval('#videoSelectOverlay button', bs => bs.map(b => b.textContent));
    }
    /** Clicks Select Session Folder and answers the folder picker with rec/. */
    async function pickRecordingFolder() {
        const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
        chooser.catch(() => {});   // reported by the click or the await below
        await page.evaluate(() => [...document.querySelectorAll('#videoSelectOverlay button')]
            .find(b => b.textContent === 'Select Session Folder').click());
        await (await chooser).setFiles(rec);
    }
    const waitStatus = (re) => page.waitForFunction(re => new RegExp(re).test(document.getElementById('statusText').textContent),
        re.source, { timeout: 60000 }).then(() => true, () => false);

    // ── A ──────────────────────────────────────────────────────────────────
    console.log('A. fresh Load SLP, Select Session Folder');
    {
        const buttons = await loadSlp('top.slp');
        check(buttons.includes('Select Session Folder'), 'the prompt offers Select Session Folder', buttons);
        await pickRecordingFolder();
        check(await waitStatus(/SLP loaded|error/i), 'the load finishes', await status());
        check(!/error/i.test(await status()), 'without an error', await status());
        const v = await videos();
        check(JSON.stringify(v.sort()) === JSON.stringify([
            'Camera1_topB <- rec/Camera1_topB/0.mp4', 'Camera2_topB <- rec/Camera2_topB/0.mp4']),
        'each camera gets its own 0.mp4, and the side camera\'s is not loaded', v);
        check(JSON.stringify(await viewNames()) === JSON.stringify(['Camera1_topB', 'Camera2_topB']), 'two views', await viewNames());
        const campy = await page.evaluate(() => {
            const r = window.__lucid.state.session.campyRecording;
            return r ? r.cameras.map(c => c.name) : null;
        });
        check(campy && campy.length === 3, 'the campy session.json reaches the session, not the videos', campy);
    }

    // ── B ──────────────────────────────────────────────────────────────────
    console.log('B. Load SLP with a project open: the prompt has the folder button');
    {
        const before = (await videos()).length;
        const buttons = await loadSlp('side.slp');
        check(JSON.stringify(buttons) === JSON.stringify(['Select Session Folder', 'Select Video Files', 'Continue Without Video']),
            'Select Session Folder, Select Video Files and Continue Without Video', buttons);
        await pickRecordingFolder();
        check(await waitStatus(/Added SLP|error/i), 'the add finishes', await status());
        check(!/error/i.test(await status()), 'without an error', await status());
        const v = await videos();
        check(v.length === before + 1, 'one video added', v);
        check(v.includes('side <- rec/Camera5_side/0.mp4'), 'the camera "side" gets the side camera\'s 0.mp4', v);
        check(await page.evaluate(() => window.__lucid.state.views.some(x => x.name === 'side')), 'and a view');
        check(!v.some(x => /session\.json/.test(x)), 'the manifest is not a video', v);
    }

    // ── C ──────────────────────────────────────────────────────────────────
    console.log('C. the same file again adds nothing; another copy of it: renamed cameras, placed by the referenced path');
    {
        const before = await videos();
        page.once('filechooser', fc => fc.setFiles(path.join(tmp, 'top.slp')));
        await page.evaluate(() => document.getElementById('menuLoadSlp').click());
        check(await waitStatus(/Already in this session|Added SLP|error/i) && /Already in this session: Camera1_topB, Camera2_topB/.test(await status()),
            'the same file again: its cameras are already in the session', await status());
        check(!(await page.$('#videoSelectOverlay')) && JSON.stringify(await videos()) === JSON.stringify(before), '…no prompt, nothing added');
        await loadSlp('topCopy.slp');
        await pickRecordingFolder();
        check(await waitStatus(/Added SLP: 2 camera|error/i), 'the add finishes', await status());
        const v = await videos();
        check(v.includes('Camera1_topB_2 <- rec/Camera1_topB/0.mp4') && v.includes('Camera2_topB_2 <- rec/Camera2_topB/0.mp4'),
            'each renamed camera gets its own 0.mp4', v);
        check(v.length === 5 && v.filter(x => /Camera5_side/.test(x)).length === 1, 'and nothing else is added', v);
    }

    // Esc on the prompt still continues without video.
    console.log('D. Esc still continues without video');
    {
        const before = (await videos()).length;
        await loadSlp('extra.slp');
        await page.keyboard.press('Escape');
        check(await waitStatus(/Added SLP|error/i), 'the add finishes', await status());
        check(!(await page.$('#videoSelectOverlay')) && (await videos()).length === before, 'no prompt, no video');
    }
} catch (e) {
    console.log('  ✗ threw: ' + (e && e.stack || e));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
