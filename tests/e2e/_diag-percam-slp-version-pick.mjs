/**
 * _diag-percam-slp-version-pick.mjs — INVESTIGATION TOOL, not an assertion.
 *
 * Second candidate for "replaced the .slp files, reloaded, only some views came
 * back": which `.slp` `handleLoadSessionFolderPerCamera` actually picks when a
 * camera directory holds more than one.
 *
 * The rule is "highest `_vN`, unversioned counts as 0":
 *
 *     var slVer = slStem.match(/_(?:3D_)?v(\d+)$/);
 *     var ver = slVer ? parseInt(slVer[1]) : 0;
 *     if (ver > bestVersion) { bestVersion = ver; bestSlp = camDir.slps[sli]; }
 *
 * "Export SLEAP File By Cam" writes `<stem>_v<N+1>.slp`, so a directory
 * accumulates versioned exports. If the user then writes their new annotations
 * to the UNVERSIONED name — which is what "replacing the old SLP file" means
 * when the original was `<stem>.slp` — the leftover `_vN` from an earlier
 * export outranks it and the loader silently reads the STALE file. Whether a
 * given camera has such a leftover is per-directory, so this too shows up as
 * "some views are right, some aren't".
 *
 * Each camera below is set up so the report can say which file was actually
 * read (the two candidates carry different track names and instance counts):
 *
 *   cam1  a fresh unversioned file PLUS a leftover `_v1` from an older export
 *   cam2  control — only the fresh unversioned file
 *   cam3  an unreadable `.slp`, covering the third way to lose one view: the
 *         loader's `parseSlpH5(...).catch(() => null)` + `if (!slpData)
 *         continue`, under a closing status that counts DIRECTORIES rather
 *         than successful parses
 *
 * Run: node tests/e2e/_diag-percam-slp-version-pick.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8264);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 400)));
    page.on('console', m => {
        const t = m.text();
        if (m.type() === 'error') console.log('  [console.error]', t.slice(0, 400));
        else if (/\.slp files found/.test(t)) console.log('  [log]', t.slice(0, 300));
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const out = await page.evaluate(async () => {
        const enc = await import('/ui/video-encode.js');
        const loader = await import('/loading/session-loader.js');
        const fio = await import('/import-export/file-io.js');
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');

        const CAMS = ['cam1', 'cam2', 'cam3'];
        const NFRAMES = 12, W = 320, H = 240, ROOT = 'sess';

        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const cctx = canvas.getContext('2d');
        const writer = await enc.createMp4Writer({
            canvas, width: W, height: H, fps: 10,
            bitrate: 400000, frameCount: NFRAMES, keyFrameEveryFrames: 4,
        });
        for (let i = 0; i < NFRAMES; i++) {
            cctx.fillStyle = 'rgb(' + (20 * i) + ',40,80)'; cctx.fillRect(0, 0, W, H);
            await writer.addFrame(i);
        }
        const mp4 = (await writer.finish()).blob;

        let toml = '';
        CAMS.forEach((cn, i) => {
            toml += '[cam_' + i + ']\nname = "' + cn + '"\nsize = [' + W + ', ' + H + ']\n'
                + 'matrix = [[600.0, 0.0, 160.0], [0.0, 600.0, 120.0], [0.0, 0.0, 1.0]]\n'
                + 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\n'
                + 'rotation = [0.0, ' + (0.2 * i) + ', 0.0]\ntranslation = ['
                + (15 * i) + ', 0.0, 0.0]\n\n';
        });

        function mkFile(bits, relPath, type) {
            const f = new File(bits, relPath.split('/').pop(), { type: type || 'application/octet-stream' });
            Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
            return f;
        }

        // Build a one-camera .slp whose TRACK NAMES identify which file it is.
        async function makeSlp(cam, tag, nInstances) {
            const K = [[600, 0, 160], [0, 600, 120], [0, 0, 1]];
            const cams = CAMS.map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [W, H]));
            const skel = new pd.Skeleton('sk', ['nose', 'body', 'tail'], [[0, 1], [1, 2]]);
            const s = new pd.Session(cams, skel, [tag + '_track'], 'gen');
            for (let f = 0; f < 4; f++) {
                const fg = new pd.FrameGroup(f);
                s.addFrameGroup(fg);
                for (let t = 0; t < nInstances; t++) {
                    fg.addInstance(cam, new pd.Instance([[10 + f, 20], [30 + f, 40], [50 + f, 60]], 0, 'user', 1));
                }
            }
            const vfi = { videoPath: ROOT + '/' + cam + '/' + cam + '.mp4', file: null, videoWidth: W, videoHeight: H, frameCount: NFRAMES };
            return await fio.exportSlpClientSide(s, cam, false, vfi, cam + '.slp', null);
        }

        const files = [mkFile([toml], ROOT + '/calibration.toml', 'text/plain')];
        for (const cn of CAMS) files.push(mkFile([mp4], ROOT + '/' + cn + '/' + cn + '.mp4', 'video/mp4'));

        // cam1: the user overwrote the unversioned file with NEW data, but an
        //       older export (`_v1`) is still sitting in the directory.
        files.push(mkFile([await makeSlp('cam1', 'NEW', 3)], ROOT + '/cam1/cam1.slp', 'application/x-hdf5'));
        files.push(mkFile([await makeSlp('cam1', 'OLD', 1)], ROOT + '/cam1/cam1_v1.slp', 'application/x-hdf5'));
        // cam2: control — only the freshly written unversioned file.
        files.push(mkFile([await makeSlp('cam2', 'NEW', 3)], ROOT + '/cam2/cam2.slp', 'application/x-hdf5'));
        // cam3: an UNREADABLE .slp. The loader's parse is
        //   parseSlpH5(bestSlp).catch(function (e) { return null; })
        // followed by `if (!slpData) continue;`, and the closing status counts
        // matched DIRECTORIES, not successful parses — so a file the reader
        // chokes on should leave this view silently empty under a success
        // message. Third way to get "only some of the views".
        files.push(mkFile([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], ROOT + '/cam3/cam3.slp', 'application/x-hdf5'));

        AS.state.sessions = []; AS.state.activeSessionIdx = 0;
        AS.state.videoFiles = []; AS.state.session = null; AS.state.views = [];
        await loader.handleLoadSessionFolderPerCamera(files, false);

        const s = AS.state.session, per = {};
        for (const c of s.cameras) per[c.name] = 0;
        for (const [, fg] of s.frameGroups) {
            for (const [cn, xs] of fg.instances) per[cn] = (per[cn] || 0) + xs.length;
            for (const [cn, xs] of fg.unlinkedInstances) per[cn] = (per[cn] || 0) + xs.length;
        }
        return {
            note: 'NEW files hold 3 instances/frame x 4 frames = 12; OLD holds 1 x 4 = 4',
            views: AS.state.views.map(v => v.name),
            tracks: s.tracks,
            perCamInstances: per,
            status: (document.getElementById('statusText') || {}).textContent || null,
        };
    });

    console.log(JSON.stringify(out, null, 2));

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
