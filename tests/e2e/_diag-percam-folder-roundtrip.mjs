/**
 * _diag-percam-folder-roundtrip.mjs — INVESTIGATION TOOL, not an assertion.
 *
 * The reported workflow, end to end, in the real app:
 *
 *   load a session folder (calibration + <cam>/<cam>.mp4)
 *     -> annotate
 *     -> "Export SLEAP File By Cam"
 *     -> drop the exported .slp files back into the camera folders
 *     -> load the folder again, fresh
 *
 * and the report is that the second load brings back only some of the views.
 *
 * Videos are real: a short H.264 clip is encoded in-page through LUCID's own
 * `ui/video-encode.js` (the app's one encoding seam), so `OnDemandVideoDecoder`
 * has something genuine to open and views are created the way they are in
 * production. Everything else — the folder scan, the camera-dir matching, the
 * `.slp` version pick, the parse, the view/pane build — is the shipping
 * `handleLoadSessionFolderPerCamera` path, driven with `preloadedFiles` so no
 * folder picker is involved.
 *
 * Prints, for each of the two loads: view names, session cameras, per-camera
 * instance counts, and the status line the user would see.
 *
 * Run: node tests/e2e/_diag-percam-folder-roundtrip.mjs
 *   CAMS=cam1,cam2,cam3   camera names (default 3)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8262);
const CAMS = (process.env.CAMS || 'cam1,cam2,cam3').split(',');

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 400)));
    page.on('console', m => {
        const t = m.text();
        if (m.type() === 'error') console.log('  [console.error]', t.slice(0, 400));
        else if (/session-folder|slp-import/.test(t)) console.log('  [log]', t.slice(0, 260));
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const out = await page.evaluate(async (CAMS) => {
        const enc = await import('/ui/video-encode.js');
        const loader = await import('/loading/session-loader.js');
        const fio = await import('/import-export/file-io.js');
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');

        const NFRAMES = 12, W = 320, H = 240, ROOT = 'sess';
        const report = { steps: [] };

        // ---- a real short .mp4, encoded through the app's own encoder --------
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const cctx = canvas.getContext('2d');
        const writer = await enc.createMp4Writer({
            canvas, width: W, height: H, fps: 10,
            bitrate: 400000, frameCount: NFRAMES, keyFrameEveryFrames: 4,
        });
        for (let i = 0; i < NFRAMES; i++) {
            cctx.fillStyle = 'rgb(' + (20 * i) + ',40,80)';
            cctx.fillRect(0, 0, W, H);
            cctx.fillStyle = '#fff';
            cctx.fillRect(10 + i * 5, 30, 24, 24);
            await writer.addFrame(i);
        }
        const mp4 = (await writer.finish()).blob;
        report.mp4Bytes = mp4.size;

        // ---- calibration.toml for every camera -------------------------------
        let toml = '';
        CAMS.forEach((cn, i) => {
            toml += '[cam_' + i + ']\n';
            toml += 'name = "' + cn + '"\n';
            toml += 'size = [' + W + ', ' + H + ']\n';
            toml += 'matrix = [[600.0, 0.0, 160.0], [0.0, 600.0, 120.0], [0.0, 0.0, 1.0]]\n';
            toml += 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\n';
            toml += 'rotation = [0.0, ' + (0.2 * i) + ', 0.0]\n';
            toml += 'translation = [' + (15 * i) + ', 0.0, 0.0]\n\n';
        });

        function mkFile(bits, relPath, type) {
            const name = relPath.split('/').pop();
            const f = new File(bits, name, { type: type || 'application/octet-stream' });
            Object.defineProperty(f, 'webkitRelativePath', { value: relPath, writable: false });
            return f;
        }

        function folderFiles(extraSlps) {
            const files = [mkFile([toml], ROOT + '/calibration.toml', 'text/plain')];
            for (const cn of CAMS) {
                files.push(mkFile([mp4], ROOT + '/' + cn + '/' + cn + '.mp4', 'video/mp4'));
            }
            for (const s of (extraSlps || [])) files.push(s);
            return files;
        }

        function snapshot(label) {
            const s = AS.state.session;
            const perCam = {};
            if (s) {
                for (const cn of s.cameras.map(c => c.name)) perCam[cn] = 0;
                for (const [, fg] of s.frameGroups) {
                    for (const [cn, insts] of fg.instances) perCam[cn] = (perCam[cn] || 0) + insts.length;
                    for (const [cn, uls] of fg.unlinkedInstances) perCam[cn] = (perCam[cn] || 0) + uls.length;
                }
            }
            const statusEl = document.getElementById('statusText') || document.getElementById('status');
            return {
                label,
                views: AS.state.views.map(v => v.name),
                cameras: s ? s.cameras.map(c => c.name) : null,
                frameGroups: s ? s.frameGroups.size : 0,
                perCamInstances: perCam,
                videoFiles: AS.state.videoFiles
                    .filter(v => v.sessionIdx === AS.state.activeSessionIdx)
                    .map(v => ({ name: v.name, cam: v.assignedCamera, slp: v.slpFilename })),
                totalFrames: AS.state.totalFrames,
                status: statusEl ? statusEl.textContent : null,
            };
        }

        // ================= LOAD 1: videos + calibration, no .slp =============
        await loader.handleLoadSessionFolderPerCamera(folderFiles([]), false);
        report.steps.push(snapshot('load 1 — videos + calibration only'));

        // ---- annotate: 2 user instances per camera on 6 frames --------------
        const s1 = AS.state.session;
        AS.setProjectSkeleton(new pd.Skeleton('sk', ['nose', 'body', 'tail'], [[0, 1], [1, 2]]));
        s1.skeleton = AS.getProjectSkeleton();
        s1.tracks = ['track_0', 'track_1'];
        for (let f = 0; f < 6; f++) {
            if (!s1.frameGroups.has(f)) s1.addFrameGroup(new pd.FrameGroup(f));
            const fg = s1.getFrameGroup(f);
            for (const cn of CAMS) {
                for (let t = 0; t < 2; t++) {
                    fg.addInstance(cn, new pd.Instance(
                        [[10 + f + t * 50, 20], [30 + f + t * 50, 40], [50 + f + t * 50, 60]],
                        t, 'user', 1));
                }
            }
        }
        report.annotated = { frames: 6, perCam: 12 };

        // ---- Export SLEAP File By Cam (the real exporter, per view) ----------
        const exported = [];
        for (const vf of AS.state.videoFiles) {
            if (vf.sessionIdx !== AS.state.activeSessionIdx) continue;
            const cam = vf.assignedCamera || vf.name;
            const stem = (vf.file && vf.file.name ? vf.file.name : cam).replace(/\.[^.]+$/, '');
            const outName = stem + '_v1.slp';
            const blob = await fio.exportSlpClientSide(s1, cam, false, vf, outName, null);
            exported.push({ cam, outName, bytes: blob.size, blob });
        }
        report.exported = exported.map(e => ({ cam: e.cam, name: e.outName, bytes: e.bytes }));

        // ---- drop them back into the camera folders --------------------------
        const slpFiles = exported.map(e =>
            mkFile([e.blob], ROOT + '/' + e.cam + '/' + e.outName, 'application/x-hdf5'));

        // ================= LOAD 2: the fresh load being reported =============
        AS.state.sessions = [];
        AS.state.activeSessionIdx = 0;
        AS.state.videoFiles = [];
        AS.state.session = null;
        AS.state.views = [];
        await loader.handleLoadSessionFolderPerCamera(folderFiles(slpFiles), false);
        report.steps.push(snapshot('load 2 — same folder, now with the exported .slp files'));

        return report;
    }, CAMS);

    console.log(JSON.stringify(out, null, 2));

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
