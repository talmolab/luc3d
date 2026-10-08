/**
 * percam-parallel-video-load.mjs — "Load Single Session Folder"
 * (`handleLoadSessionFolderPerCamera`) opens every camera's video decoder IN
 * PARALLEL, then applies the results in camera order. Pinned here:
 *
 *  1. **Order is camera order, not completion order.** The cameras' videos have
 *     different frame counts and sizes, and the first camera's video is the
 *     longest (so it finishes opening LAST); views / videoFiles / decoderPool
 *     must still come out cam1, cam3, cam4 with each camera's own dimensions and
 *     frame count — a mix-up between cameras would show here.
 *  2. **A video that fails to open is reported, not fatal.** cam2's "video" is
 *     garbage bytes. Its decoder's init rejects while cam1's is still pending;
 *     the parallel version captures that as a result rather than an unhandled
 *     rejection, cam2 gets no view, every other camera still loads, and the
 *     status line says "1 video(s) could not be played", as it did before.
 *  3. **Progress.** The overlay walks the three labelled steps — Parsing
 *     annotations, Building session, Loading videos — ending at
 *     "Loading videos: 4/4 videos (100%)…" (the failed one counts as handled).
 *
 * Run: node tests/e2e/percam-parallel-video-load.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8274);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrs = [];
    page.on('pageerror', e => pageErrs.push(String(e).slice(0, 300)));

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const r = await page.evaluate(async () => {
        const enc = await import('/ui/video-encode.js');
        const loader = await import('/loading/session-loader.js');
        const fio = await import('/import-export/file-io.js');
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');

        const unhandled = [];
        window.addEventListener('unhandledrejection', e => unhandled.push(String(e.reason).slice(0, 200)));

        const ROOT = 'sess';
        // cam1 is the LONGEST video, so its decoder finishes opening last.
        const SPEC = {
            cam1: { w: 320, h: 240, n: 60 },
            cam2: null,                        // unplayable
            cam3: { w: 336, h: 256, n: 12 },
            cam4: { w: 352, h: 272, n: 20 },
        };
        const CAMS = Object.keys(SPEC);

        async function makeMp4({ w, h, n }) {
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const cctx = canvas.getContext('2d');
            const wr = await enc.createMp4Writer({ canvas, width: w, height: h, fps: 10,
                bitrate: 400000, frameCount: n, keyFrameEveryFrames: 4 });
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
        let toml = '';
        CAMS.forEach((cn, i) => {
            toml += '[cam_' + i + ']\nname = "' + cn + '"\nsize = [320, 240]\n'
                + 'matrix = [[600.0, 0.0, 160.0], [0.0, 600.0, 120.0], [0.0, 0.0, 1.0]]\n'
                + 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\n'
                + 'rotation = [0.0, ' + (0.2 * i) + ', 0.0]\ntranslation = [' + (15 * i) + ', 0.0, 0.0]\n\n';
        });
        async function makeSlp(cam) {
            const K = [[600, 0, 160], [0, 600, 120], [0, 0, 1]];
            const cams = CAMS.map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [320, 240]));
            const s = new pd.Session(cams, new pd.Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0'], 'gen');
            for (let f = 0; f < 4; f++) {
                const fg = new pd.FrameGroup(f);
                s.addFrameGroup(fg);
                fg.addInstance(cam, new pd.Instance([[10 + f, 20], [30, 40]], 0, 'user', 1));
            }
            return await fio.exportSlpClientSide(s, cam, false,
                { videoPath: ROOT + '/' + cam + '/' + cam + '.mp4', file: null, videoWidth: 320, videoHeight: 240, frameCount: 12 },
                cam + '.slp', null);
        }

        const files = [mkFile([toml], ROOT + '/calibration.toml', 'text/plain')];
        for (const cn of CAMS) {
            const video = SPEC[cn] ? await makeMp4(SPEC[cn]) : new Uint8Array(4096).fill(7);
            files.push(mkFile([video], ROOT + '/' + cn + '/' + cn + '.mp4', 'video/mp4'));
            files.push(mkFile([await makeSlp(cn)], ROOT + '/' + cn + '/' + cn + '.slp', 'application/x-hdf5'));
        }

        // Record every overlay text the load shows.
        const texts = [];
        const status = document.getElementById('loadingStatus');
        const sub = document.getElementById('loadingSubstatus');
        const mo = new MutationObserver(() => {
            const t = status.textContent + ' | ' + (sub ? sub.textContent : '');
            if (texts[texts.length - 1] !== t) texts.push(t);
        });
        mo.observe(document.getElementById('loadingOverlay'), { subtree: true, childList: true, characterData: true, attributes: true });

        AS.state.sessions = []; AS.state.activeSessionIdx = 0;
        AS.state.videoFiles = []; AS.state.session = null; AS.state.views = [];
        AS.state.decoderPool = [];
        await loader.handleLoadSessionFolderPerCamera(files, false);
        await new Promise(r => setTimeout(r, 300));
        mo.disconnect();

        const s = AS.state.session;
        return {
            views: AS.state.views.map(v => v.name + ':' + v.videoWidth + 'x' + v.videoHeight),
            videoFiles: AS.state.videoFiles.map(v => v.name + ':' + v.frameCount + ':' + v.videoWidth + 'x' + v.videoHeight),
            decoders: AS.state.decoderPool.length,
            decoderSizes: AS.state.decoderPool.map(d => d.videoTrack.video.width),
            sessionCams: s.cameras.map(c => c.name),
            frames: s.frameGroups.size,
            status: document.getElementById('statusText').textContent,
            texts, unhandled,
        };
    });

    console.log('  measured:', JSON.stringify({ ...r, texts: r.texts.length }).slice(0, 900));

    check(JSON.stringify(r.views) === JSON.stringify(['cam1:320x240', 'cam3:336x256', 'cam4:352x272']),
        `views are in camera order with each camera's own size (got ${JSON.stringify(r.views)})`);
    check(r.videoFiles.length === 3 && /^cam1:\d+:320x240$/.test(r.videoFiles[0]) &&
        /^cam3:\d+:336x256$/.test(r.videoFiles[1]) && /^cam4:\d+:352x272$/.test(r.videoFiles[2]),
        `videoFiles in camera order (got ${JSON.stringify(r.videoFiles)})`);
    const nf = r.videoFiles.map(v => +v.split(':')[1]);
    check(nf[0] > nf[2] && nf[2] > nf[1],
        `each camera kept its OWN video's frame count (cam1 longest > cam4 > cam3: ${nf.join(', ')})`);
    check(r.decoders === 3 && JSON.stringify(r.decoderSizes) === '[320,336,352]',
        `decoderPool holds the 3 good decoders, in order (got ${r.decoderSizes})`);
    check(r.sessionCams.join(',') === 'cam1,cam2,cam3,cam4', 'all 4 calibrated cameras stay in the session');
    check(r.frames === 4, `annotations loaded for the session (got ${r.frames} frames)`);
    check(/1 video\(s\) could not be played/.test(r.status),
        `the unplayable cam2 video is reported in the status line (got "${r.status}")`);
    check(r.unhandled.length === 0, `no unhandled promise rejection (got ${JSON.stringify(r.unhandled)})`);

    const seen = (re) => r.texts.some(t => re.test(t));
    check(seen(/^Parsing annotations: \d\/4 cameras .*Step 1 of 3/), 'progress step 1: Parsing annotations');
    check(seen(/^Building session: .*Step 2 of 3/), 'progress step 2: Building session');
    check(seen(/^Loading videos: 4\/4 videos \(100%\)… \| Step 3 of 3 · Preparing instances…/),
        'progress step 3 ends at 4/4 videos (the failed one counts as handled), naming the tail');
    check(pageErrs.length === 0, `no page errors (${pageErrs.join(' | ')})`);

    await browser.close();
} finally {
    server.kill();
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
