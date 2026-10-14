/**
 * calibration-named-videos-load.mjs — a session video named `cam#-calibration.mp4`
 * LOADS (issue #199), and still loses to a plainly-named video of the same camera.
 *
 * The bug: `isCalibrationVideoFile` excluded any stem ending in `-calibration` /
 * `_calibration` as hard as it excluded a clip under `calibration_images/`. An
 * alpha tester had named their session recordings that way, so the folder load
 * produced ZERO views and said nothing about why. On the real session folders
 * all 38 calibration clips live under `calibration_images/` and none outside it,
 * so the stem rule was excluding only false positives.
 *
 * The stem is now a de-prioritizing HINT, applied per camera
 * (`loading/video-file-pick.js`). The same synthetic folder is driven through
 * BOTH loaders, because they failed differently and a test against either one
 * alone passes on the broken build:
 *
 *   A. `attachVideosForLazyReopen` — one of the four paths that actually called
 *      `isCalibrationVideoFile`. Pre-fix, cam2 got NO video here. This is the
 *      #199 reproduction.
 *   B. `handleLoadSessionFolderPerCamera` — never called it (it collects videos
 *      at `root/<cam>/<file>` and took `videos[0]`), so pre-fix cam1 loaded the
 *      calibration-named clip simply because the folder listed it first. This is
 *      the de-prioritization half.
 *
 * Each video gets its OWN dimensions, so every assertion names WHICH file became
 * the view rather than merely counting views:
 *
 *   cam1/  cam1-calibration.mp4 (320x240)  +  cam1.mp4 (352x272)
 *          -> the plainly-named one wins. The calibration-named one is listed
 *             FIRST, so a build that took `videos[0]` fails loader B here.
 *   cam2/  cam2-calibration.mp4 (336x256)  only
 *          -> it IS the recording, so it loads. Fails loader A pre-fix.
 *   cam3/  cam3.mp4 (368x288)              only
 *          -> untouched control.
 *
 * NOT covered here, deliberately: the `calibration_images/` path rule, which is
 * unchanged. Loader B only collects at depth 3, so asserting a real clip's
 * absence there would pass for the wrong reason. The path rule is pinned at the
 * predicate level by `tests/test-video-file-pick.mjs` §1.
 *
 * Run: node tests/e2e/calibration-named-videos-load.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8291);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

/**
 * Build the folder and run it through one loader. Runs on a FRESH page each
 * time: loader B rebuilds the dock, and reusing a page that loader A already
 * populated would leave the second run asserting against the first run's panes.
 */
async function runScenario(browser, mode) {
    const page = await browser.newPage();
    const pageErrs = [];
    page.on('pageerror', e => pageErrs.push(String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const r = await page.evaluate(async (mode) => {
        const enc = await import('/ui/video-encode.js');
        const loader = await import('/loading/session-loader.js');
        const fio = await import('/import-export/file-io.js');
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');

        const unhandled = [];
        window.addEventListener('unhandledrejection', e => unhandled.push(String(e.reason).slice(0, 200)));

        const ROOT = 'sess';
        const CAMS = ['cam1', 'cam2', 'cam3'];
        // Per camera, the videos in the order the folder enumerates them. The
        // calibration-named file is FIRST in cam1 on purpose.
        const LAYOUT = {
            cam1: [
                { file: 'cam1-calibration.mp4', w: 320, h: 240, n: 8 },
                { file: 'cam1.mp4', w: 352, h: 272, n: 20 },
            ],
            cam2: [{ file: 'cam2-calibration.mp4', w: 336, h: 256, n: 12 }],
            cam3: [{ file: 'cam3.mp4', w: 368, h: 288, n: 16 }],
        };
        const K = [[600, 0, 160], [0, 600, 120], [0, 0, 1]];
        const mkCams = () => CAMS.map((n, i) =>
            new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [320, 240]));

        async function makeMp4({ w, h, n }) {
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const cctx = canvas.getContext('2d');
            const wr = await enc.createMp4Writer({
                canvas, width: w, height: h, fps: 10,
                bitrate: 400000, frameCount: n, keyFrameEveryFrames: 4,
            });
            for (let i = 0; i < n; i++) {
                cctx.fillStyle = 'rgb(' + (4 * i) + ',40,80)'; cctx.fillRect(0, 0, w, h);
                await wr.addFrame(i);
            }
            return (await wr.finish()).blob;
        }
        function mkFile(bits, relPath, type) {
            const f = new File(bits, relPath.split('/').pop(), { type: type || 'application/octet-stream' });
            Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
            return f;
        }

        // The videos, in folder-enumeration order — the only files loader A needs.
        const videos = [];
        for (const cn of CAMS) {
            for (const v of LAYOUT[cn]) {
                videos.push(mkFile([await makeMp4(v)], ROOT + '/' + cn + '/' + v.file, 'video/mp4'));
            }
        }

        AS.state.sessions = []; AS.state.activeSessionIdx = 0;
        AS.state.videoFiles = []; AS.state.session = null; AS.state.views = [];
        AS.state.decoderPool = [];

        if (mode === 'lazy') {
            // Loader A — the reopen path, driven through its documented
            // `pickedFilesOverride` seam. An empty `loader.videos` map is a
            // project whose videos were never resolved by referenced filename,
            // so matching falls to the directory and the stem, as in the report.
            const sess = new pd.Session(mkCams(),
                new pd.Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0'], 'lazy');
            AS.state.sessions.push(sess);
            AS.state.activeSessionIdx = 0;
            AS.state.session = sess;
            await loader.attachVideosForLazyReopen(sess, { videos: new Map() }, videos);
        } else {
            // Loader B — "Load Single Session Folder", which also needs the
            // calibration and the per-camera annotations.
            let toml = '';
            CAMS.forEach((cn, i) => {
                toml += '[cam_' + i + ']\nname = "' + cn + '"\nsize = [320, 240]\n'
                    + 'matrix = [[600.0, 0.0, 160.0], [0.0, 600.0, 120.0], [0.0, 0.0, 1.0]]\n'
                    + 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\n'
                    + 'rotation = [0.0, ' + (0.2 * i) + ', 0.0]\ntranslation = [' + (15 * i) + ', 0.0, 0.0]\n\n';
            });
            async function makeSlp(cam) {
                const s = new pd.Session(mkCams(), new pd.Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0'], 'gen');
                for (let f = 0; f < 4; f++) {
                    const fg = new pd.FrameGroup(f);
                    s.addFrameGroup(fg);
                    fg.addInstance(cam, new pd.Instance([[10 + f, 20], [30, 40]], 0, 'user', 1));
                }
                return await fio.exportSlpClientSide(s, cam, false,
                    { videoPath: ROOT + '/' + cam + '/' + cam + '.mp4', file: null, videoWidth: 320, videoHeight: 240, frameCount: 12 },
                    cam + '.slp', null);
            }
            const files = [mkFile([toml], ROOT + '/calibration.toml', 'text/plain')].concat(videos);
            for (const cn of CAMS) {
                files.push(mkFile([await makeSlp(cn)], ROOT + '/' + cn + '/' + cn + '.slp', 'application/x-hdf5'));
            }
            await loader.handleLoadSessionFolderPerCamera(files, false);
        }
        await new Promise(r => setTimeout(r, 300));

        return {
            views: AS.state.views.map(v => v.name + ':' + v.videoWidth + 'x' + v.videoHeight),
            // `vf.name` is the stem, so carry the real file name explicitly.
            videoFiles: AS.state.videoFiles.map(v => v.assignedCamera + '<-' + (v.file ? v.file.name : '?')),
            sessionCams: AS.state.session.cameras.map(c => c.name),
            status: document.getElementById('statusText').textContent,
            unhandled,
        };
    }, mode);

    await page.close();
    return { ...r, pageErrs };
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();

    for (const mode of ['lazy', 'percam']) {
        const label = mode === 'lazy'
            ? 'A. attachVideosForLazyReopen (the path that excluded by stem)'
            : 'B. handleLoadSessionFolderPerCamera (the path that took videos[0])';
        console.log('\n' + label);
        const r = await runScenario(browser, mode);
        console.log('  measured:', JSON.stringify(r).slice(0, 700));

        // --- the #199 case: a calibration-named video is a real recording ---
        check(r.views.length === 3,
            `all three cameras got a view (got ${r.views.length}: ${JSON.stringify(r.views)})`);
        check(r.views.includes('cam2:336x256'),
            'cam2 loaded from its ONLY candidate, cam2-calibration.mp4 (#199)');
        check(r.videoFiles.includes('cam2<-cam2-calibration.mp4'),
            'and the videoFile entry names that file');

        // --- ...but it still loses to a plainly-named sibling --------------
        check(r.views.includes('cam1:352x272'),
            'cam1 took cam1.mp4 (352x272), not the calibration-named clip');
        check(!r.views.includes('cam1:320x240'),
            'negative control: cam1 did NOT take cam1-calibration.mp4 (320x240), ' +
            'though the folder listed it first');
        check(r.videoFiles.includes('cam1<-cam1.mp4'), 'and the videoFile entry names cam1.mp4');
        check(r.videoFiles.filter(v => v.startsWith('cam1<-')).length === 1,
            'cam1 loaded exactly one video, not both');

        // --- controls ------------------------------------------------------
        check(r.views.includes('cam3:368x288'), 'cam3 is unaffected');
        check(r.sessionCams.join(',') === 'cam1,cam2,cam3',
            'all three calibrated cameras are in the session');
        check(r.unhandled.length === 0, `no unhandled promise rejection (got ${JSON.stringify(r.unhandled)})`);
        check(r.pageErrs.length === 0, `no page errors (${r.pageErrs.join(' | ')})`);
    }

    await browser.close();
} finally {
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
