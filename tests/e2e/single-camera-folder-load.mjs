/**
 * single-camera-folder-load.mjs — File ▸ Load Single Session Folder with ONE
 * camera and no calibration is a single-camera session
 * (loading/session-loader.js `handleLoadSessionFolderPerCamera`).
 *
 * A SLEAP user's folder for one view is a video and its predictions `.slp`.
 * Without a calibration file this loader used to load the video and the poses
 * but create NO camera — right for a multi-camera folder waiting for its
 * calibration, wrong for one view, where single-camera Track All then refused
 * ("No session with cameras loaded"). Asserted:
 *  1. `sess/Camera0/{Camera0.mp4, Camera0.slp}` picked as the session folder:
 *     one stand-in camera named after the directory, the view and the poses on
 *     it, a status saying it is a single-camera session, and Track All runs
 *     SLEAP's tracker.
 *  2. The camera's OWN folder picked (`Camera0/` with the video and `.slp` at its
 *     top and a `calibration_images/` clip below): the folder is the camera,
 *     named after it, and the calibration clip is not loaded as a view.
 *  3. An `.slp` with no video (the loader's "Missing Video Files" popup answered
 *     with Continue): the camera is still created (File ▸ Load SLP's identity
 *     stand-in), so the session is single-camera from the start.
 *  4. Negative control — TWO camera directories and no calibration load as they
 *     always did: views, no cameras, the "load calibration" status.
 *
 * Run: node tests/e2e/single-camera-folder-load.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8283);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    if (process.env.DEBUG) page.on('console', m => console.log('   [page] ' + m.text().slice(0, 160)));
    page.on('dialog', d => d.accept('2'));   // Track All asks for the animal count
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // Builders, kept on window: an mp4, a one-camera predictions .slp (two animals), and File objects with paths.
    await page.evaluate(async () => {
        const enc = await import('/ui/video-encode.js'), fio = await import('/import-export/file-io.js');
        const pd = await import('/pose/pose-data.js'), loader = await import('/loading/session-loader.js');
        const AS = await import('/ui/app-state.js');
        const N = 30, W = 320, H = 240;
        const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
        const cx = canvas.getContext('2d');
        const wr = await enc.createMp4Writer({ canvas, width: W, height: H, fps: 10, bitrate: 400000, frameCount: N, keyFrameEveryFrames: 5 });
        for (let i = 0; i < N; i++) { cx.fillStyle = 'rgb(' + (5 * i) + ',60,90)'; cx.fillRect(0, 0, W, H); await wr.addFrame(i); }
        const mp4 = (await wr.finish()).blob;
        const slpFor = async (cam) => {
            const s = new pd.Session([new pd.Camera(cam, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [W, H])],
                new pd.Skeleton('sk', ['nose', 'body', 'tail'], [[0, 1], [1, 2]]), ['track_0', 'track_1'], 'gen');
            for (let f = 0; f < N; f++) {
                const fg = new pd.FrameGroup(f); s.addFrameGroup(fg);
                for (let a = 0; a < 2; a++) {
                    const x = 60 + 160 * a + 2 * f, y = 80 + 40 * a;
                    fg.addInstance(cam, new pd.Instance([[x, y], [x + 20, y + 5], [x + 40, y + 10]], a, 'predicted', 0.9));
                }
            }
            return fio.exportSlpClientSide(s, cam, false, { videoPath: cam + '.mp4', file: null, videoWidth: W, videoHeight: H, frameCount: N }, cam + '.slp', null);
        };
        const file = (bits, rel, type) => { const f = new File(bits, rel.split('/').pop(), { type: type || 'application/octet-stream' });
            Object.defineProperty(f, 'webkitRelativePath', { value: rel }); return f; };
        const SLP = await slpFor('Camera0'), SLP_A = await slpFor('camA'), SLP_B = await slpFor('camB');
        window.__fx = { mp4, file, SLP, SLP_A, SLP_B };
        window.__load = async (files) => {
            AS.state.sessions = []; AS.state.activeSessionIdx = 0; AS.state.videoFiles = []; AS.state.session = null; AS.state.views = [];
            await loader.handleLoadSessionFolderPerCamera(files, false);
            const s = AS.state.session, SCT = await import('/pose/single-camera-tracking.js');
            let poses = 0; for (const [, fg] of s.frameGroups) for (const [, xs] of fg.unlinkedInstances) poses += xs.length;
            return { cameras: s.cameras.map(c => c.name), single: SCT.singleCameraName(s), views: AS.state.views.map(v => v.name),
                     poseCams: [...new Set([...s.frameGroups.values()].flatMap(fg => [...fg.unlinkedInstances.keys()]))], poses,
                     status: document.getElementById('statusText').textContent };
        };
    });

    console.log('\n1. A session folder with ONE camera directory and no calibration');
    const r1 = await page.evaluate(() => { const { mp4, file, SLP } = window.__fx;
        return window.__load([file([mp4], 'sess/Camera0/Camera0.mp4', 'video/mp4'), file([SLP], 'sess/Camera0/Camera0.slp')]); });
    check(JSON.stringify(r1.cameras) === '["Camera0"]' && r1.single === 'Camera0', `one stand-in camera, named after the directory (${JSON.stringify(r1.cameras)})`);
    check(JSON.stringify(r1.views) === '["Camera0"]' && JSON.stringify(r1.poseCams) === '["Camera0"]' && r1.poses === 60,
        `the view and all ${r1.poses} poses are on it (views ${JSON.stringify(r1.views)}, poses on ${JSON.stringify(r1.poseCams)})`);
    check(/single-camera session: no calibration needed/.test(r1.status), 'the status says it is a single-camera session: ' + r1.status.slice(0, 120));
    await page.evaluate(() => document.getElementById('tbTrackAll').click());
    await page.waitForFunction(() => /Tracked \d+ animal|Track All error|No session/.test(document.getElementById('statusText').textContent), { timeout: 60000 });
    const st = await page.evaluate(() => document.getElementById('statusText').textContent);
    check(/^Tracked 2 animals across 30 frames with SLEAP's tracker/.test(st), 'Track All runs SLEAP\'s tracker on it: ' + st.slice(0, 90));
    await page.evaluate(() => { const c = document.getElementById('trackSummaryClose'); if (c) c.click(); });   // its summary box

    console.log('\n2. The camera\'s own folder picked, with a calibration clip below it');
    const r2 = await page.evaluate(() => { const { mp4, file, SLP } = window.__fx;
        return window.__load([file([mp4], 'Camera0/video.mp4', 'video/mp4'), file([SLP], 'Camera0/Camera0.slp'),
                              file([mp4], 'Camera0/calibration_images/Camera0-calibration.mp4', 'video/mp4')]); });
    check(JSON.stringify(r2.cameras) === '["Camera0"]' && r2.single === 'Camera0' && r2.poses === 60,
        `the folder is the camera, named after it, with its poses (${JSON.stringify(r2.cameras)}, ${r2.poses} poses)`);
    check(JSON.stringify(r2.views) === '["Camera0"]', `one view, the camera's: the calibration clip is not loaded (${JSON.stringify(r2.views)})`);

    console.log('\n3. An .slp with no video');
    // the loader's "Missing Video Files" popup asks for the video: Continue without one
    await page.evaluate(() => { const { file, SLP } = window.__fx; window.__p = window.__load([file([SLP], 'sess/Camera0/Camera0.slp')]); });
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 30000 });
    const r3 = await page.evaluate(() => window.__p);
    check(JSON.stringify(r3.cameras) === '["Camera0"]' && r3.single === 'Camera0' && r3.poses === 60,
        `the camera exists without a video (${JSON.stringify(r3.cameras)}, ${r3.poses} poses, views ${JSON.stringify(r3.views)})`);

    console.log('\n4. Negative control: TWO camera directories, no calibration — unchanged');
    const r4 = await page.evaluate(() => { const { mp4, file, SLP_A, SLP_B } = window.__fx;
        return window.__load([file([mp4], 'sess/camA/camA.mp4', 'video/mp4'), file([SLP_A], 'sess/camA/camA.slp'),
                              file([mp4], 'sess/camB/camB.mp4', 'video/mp4'), file([SLP_B], 'sess/camB/camB.slp')]); });
    check(r4.cameras.length === 0 && r4.single === null && r4.views.length === 2,
        `views but no cameras until a calibration is loaded (${JSON.stringify(r4.cameras)}, ${r4.views.length} views)`);
    check(/no calibration — load separately/.test(r4.status), 'and the status still asks for the calibration: ' + r4.status.slice(0, 100));

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n✗ ${fails} check(s) failed` : '\n✓ all checks passed');
process.exit(fails ? 1 : 0);
