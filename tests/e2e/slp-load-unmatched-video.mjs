/**
 * slp-load-unmatched-video.mjs — File ▸ Load SLP, then "Select Video Files",
 * with a picked video whose name matches no camera
 * (`handleLoadSlpFile` in import-export/slp-import.js).
 *
 * The picked videos are bound to cameras by name only (`slpMatchCam`: parent
 * directory, exact stem, the file name the SLP references; then
 * `autoAssignVideosToCameras`). A video none of them matched used to get no
 * view and no word: the status said "SLP loaded (…)" and the viewer showed
 * "Drag and Drop videos". Reported on a real one-camera SLEAP file whose video
 * had been picked under another name.
 *
 * The videos are written to disk and picked through the real file input
 * (Playwright's file chooser). Asserted:
 *  1. ONE camera and ONE picked video under another name (`video.mp4` for the
 *     SLP's `240615_…-0000.mp4`): the video is bound to the camera — one view,
 *     named after it, with the poses — the console says so, and the status is
 *     a plain success.
 *  2. Control: the same file picked under the name the SLP references loads by
 *     name (no fallback in the console).
 *  3. TWO cameras, one video named after its camera and one under another
 *     name: one view only (unchanged), and the status is a warning naming the
 *     unused video and the camera without a video.
 *  4. Control: both videos named after their cameras — two views, no warning.
 *
 * Negative control, run once: on the pre-fix build §1 and §3 fail (no view,
 * a success status naming nothing); §2 and §4 pass there too.
 *
 * Run: node tests/e2e/slp-load-unmatched-video.mjs   (spawns its own
 * http.server; PORT= to move it)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8391);
const REF = '240615_251B_balbc_home_top-06152024120645-0000';

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-unmatched-'));
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    const logs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    page.on('console', m => logs.push(m.text()));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    // Fixtures: a 20-frame mp4; a one-camera SLEAP .slp referencing REF.mp4;
    // a two-camera project .slp referencing cam0.mp4 / cam1.mp4. Both .slp
    // files hold one predicted animal on every frame of every camera.
    const fx = await page.evaluate(async (REF) => {
        const enc = await import('/ui/video-encode.js'), fio = await import('/import-export/file-io.js');
        const pd = await import('/pose/pose-data.js');
        const N = 20, W = 160, H = 120;
        const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
        const cx = canvas.getContext('2d');
        const wr = await enc.createMp4Writer({ canvas, width: W, height: H, fps: 10, bitrate: 300000, frameCount: N, keyFrameEveryFrames: 5 });
        for (let i = 0; i < N; i++) { cx.fillStyle = 'rgb(' + (10 * i) + ',60,90)'; cx.fillRect(0, 0, W, H); await wr.addFrame(i); }
        const mp4 = new Uint8Array(await (await wr.finish()).blob.arrayBuffer());
        const session = (cams) => {
            const s = new pd.Session(cams.map(c => new pd.Camera(c, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [W, H])),
                new pd.Skeleton('sk', ['nose', 'body', 'tail'], [[0, 1], [1, 2]]), ['track_0'], 'gen');
            for (let f = 0; f < N; f++) {
                const fg = new pd.FrameGroup(f); s.addFrameGroup(fg);
                for (const c of cams) fg.addInstance(c, new pd.Instance([[40 + f, 50], [60 + f, 55], [80 + f, 60]], 0, 'predicted', 0.9));
            }
            return s;
        };
        const one = await fio.exportSlpClientSide(session(['top']), 'top', false,
            { videoPath: REF + '.mp4', file: null, videoWidth: W, videoHeight: H, frameCount: N }, REF + '.slp', null);
        const two = session(['cam0', 'cam1']);
        const labels = fio.buildSlpLabelsAllViews(two,
            two.cameras.map(c => ({ name: c.name, videoWidth: W, videoHeight: H, frameCount: N })),
            two.cameras.map(c => ({ name: c.name, assignedCamera: c.name, videoPath: c.name + '.mp4' })));
        window.__oneCam = new Uint8Array(await one.arrayBuffer());
        window.__twoCam = await window.SleapIO.saveSlpToBytes(labels);
        let s = ''; for (let i = 0; i < mp4.length; i++) s += String.fromCharCode(mp4[i]);
        return { mp4: btoa(s), oneLen: window.__oneCam.length, twoLen: window.__twoCam.length };
    }, REF);
    const mp4 = Buffer.from(fx.mp4, 'base64');
    check(fx.oneLen > 0 && fx.twoLen > 0 && mp4.length > 0,
        `fixtures: one-camera .slp (${fx.oneLen.toLocaleString('en-US')} B), two-camera .slp (${fx.twoLen.toLocaleString('en-US')} B), mp4`);

    /** Write videos named `names` into a fresh folder; returns their paths. */
    let nDir = 0;
    const videos = (names) => {
        const dir = path.join(tmpRoot, 'pick' + (nDir++));
        fs.mkdirSync(dir);
        return names.map(n => { const p = path.join(dir, n); fs.writeFileSync(p, mp4); return p; });
    };

    /** File ▸ Load SLP on page-global bytes, answering the video prompt with `paths`. */
    async function loadSlp(globalName, slpName, paths) {
        await page.evaluate(async () => {
            const sl = await import('/import-export/save-load.js');
            sl.newProject(true);
        });
        logs.length = 0;
        await page.evaluate(([g, name]) => {
            window.__loadDone = false;
            (async () => {
                const si = await import('/import-export/slp-import.js');
                await si.handleLoadSlpFile(new File([window[g]], name));
            })().then(() => { window.__loadDone = true; }, e => { window.__loadDone = 'ERR ' + (e && e.stack || e); });
        }, [globalName, slpName]);
        await page.waitForSelector('#videoSelectOverlay', { timeout: 20000 });
        page.once('filechooser', async (fc) => { await fc.setFiles(paths); });
        await page.click('#videoSelectOverlay >> text=Select Video Files');
        await page.waitForFunction(() => window.__loadDone !== false, null, { timeout: 60000 });
        return page.evaluate(() => {
            const s = window.__lucid.state;
            let poses = 0;
            if (s.session) for (const [, fg] of s.session.frameGroups) for (const [, xs] of fg.unlinkedInstances) poses += xs.length;
            return {
                done: window.__loadDone,
                cameras: s.session ? s.session.cameras.map(c => c.name) : [],
                views: s.views.map(v => v.name),
                viewFrames: s.views.map(v => v.decoder ? v.decoder.samples.length : 0),
                bound: s.videoFiles.map(vf => vf.file.name + '→' + vf.assignedCamera),
                poses,
                status: document.getElementById('statusText').textContent,
                statusKind: document.getElementById('statusDot').className,
            };
        });
    }
    const fallbackLogged = () => logs.some(t => /\[load-slp\] video "video\.mp4" matches no camera by name; bound to the session's only camera/.test(t));

    console.log('\n1. One camera, the video picked under another name');
    {
        const r = await loadSlp('__oneCam', REF + '.slp', videos(['video.mp4']));
        console.log('  measured:', JSON.stringify(r).slice(0, 500));
        check(r.done === true, 'the load finished' + (r.done === true ? '' : ': ' + r.done));
        check(r.cameras.length === 1 && JSON.stringify(r.views) === JSON.stringify(r.cameras),
            `one view, the session's only camera (${JSON.stringify(r.cameras)} / views ${JSON.stringify(r.views)})`);
        check(r.viewFrames[0] === 20, `with the picked video's 20 frames (${r.viewFrames})`);
        check(r.poses === 20, `and the 20 poses on it (${r.poses})`);
        check(fallbackLogged(), 'the console says the video was bound to the only camera');
        check(/success/.test(r.statusKind) && /^SLP loaded \(.*1 views\)$/.test(r.status), `status bar: ${r.status}`);
    }

    console.log('\n2. Control: one camera, the video under the name the SLP references');
    {
        const r = await loadSlp('__oneCam', REF + '.slp', videos([REF + '.mp4']));
        console.log('  measured:', JSON.stringify(r).slice(0, 500));
        check(r.cameras.length === 1 && JSON.stringify(r.views) === JSON.stringify(r.cameras) && r.viewFrames[0] === 20,
            `bound by name (${JSON.stringify(r.bound)})`);
        check(!logs.some(t => /matches no camera by name/.test(t)), 'no fallback in the console');
        check(/success/.test(r.statusKind), `status bar: ${r.status}`);
    }

    console.log('\n3. Two cameras, one video under another name');
    {
        const r = await loadSlp('__twoCam', 'project.slp', videos(['cam0.mp4', 'renamed.mp4']));
        console.log('  measured:', JSON.stringify(r).slice(0, 500));
        check(r.done === true, 'the load finished' + (r.done === true ? '' : ': ' + r.done));
        check(JSON.stringify(r.cameras) === '["cam0","cam1"]' && JSON.stringify(r.views) === '["cam0"]',
            `only the matched video gets a view, as before (views ${JSON.stringify(r.views)}, bound ${JSON.stringify(r.bound)})`);
        check(!logs.some(t => /matches no camera by name/.test(t)), 'no one-camera fallback with two cameras');
        check(/warning/.test(r.statusKind), `the status is a warning (${r.statusKind})`);
        check(/video renamed\.mp4 matched no camera, not loaded; no video for cam1$/.test(r.status),
            `it names the unused video and the camera without one: ${r.status}`);
    }

    console.log('\n4. Control: two cameras, both videos named after their cameras');
    {
        const r = await loadSlp('__twoCam', 'project.slp', videos(['cam0.mp4', 'cam1.mp4']));
        console.log('  measured:', JSON.stringify(r).slice(0, 500));
        check(JSON.stringify(r.views) === '["cam0","cam1"]', `two views (${JSON.stringify(r.views)})`);
        check(/success/.test(r.statusKind) && !/matched no camera/.test(r.status), `no warning: ${r.status}`);
    }

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
