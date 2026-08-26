/**
 * _diag-mixed-lazy-eager.mjs — INVESTIGATION TOOL, not an assertion.
 *
 * Tests the hypothesis for "reload after replacing the .slp files only brings
 * back some of the views": `handleLoadSessionFolderPerCamera` routes each
 * camera's `.slp` INDEPENDENTLY by file size —
 *
 *     shouldUseLazySlp(bestSlp)   // > LAZY_SLP_THRESHOLD (150 MB)
 *       ? lazyJobs.push(...)      // SioLazyLoader, hydrates on scrub
 *       : parseJobs.push(...)     // parseSlpH5, materialized immediately
 *
 * so one folder can end up with SOME cameras eager and SOME lazy. The eager
 * ones populate `session.frameGroups` at load time, and `ensureLazyFrameData`
 * opens with
 *
 *     if (session.frameGroups.has(frameIdx)) return;
 *
 * — so on any frame an eager camera already created, the lazy cameras are never
 * hydrated at all. Their annotations simply never appear.
 *
 * Replacing prediction files with LUCID exports is exactly the kind of change
 * that moves a camera across the 150 MB line, which is why this would show up
 * on the reload and not on the original load.
 *
 * The `.slp` is made "large" by appending zero padding to the real exported
 * bytes: `shouldUseLazySlp` only reads `file.size`, and HDF5 ignores trailing
 * bytes, so the file still parses. PAD_CAMS controls which cameras get it.
 *
 * Run: node tests/e2e/_diag-mixed-lazy-eager.mjs
 *   PAD_CAMS=cam1        which cameras are pushed over the lazy threshold
 *                        ("" = none, "all" = every camera)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8263);
const CAMS = (process.env.CAMS || 'cam1,cam2,cam3').split(',');
const PAD_CAMS = process.env.PAD_CAMS === undefined ? 'cam1' : process.env.PAD_CAMS;

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 400)));
    page.on('console', m => {
        const t = m.text();
        if (m.type() === 'error') console.log('  [console.error]', t.slice(0, 400));
        else if (/lazy|Lazy/.test(t) && /session-folder/.test(t)) console.log('  [log]', t.slice(0, 260));
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const out = await page.evaluate(async ({ CAMS, PAD_CAMS }) => {
        const enc = await import('/ui/video-encode.js');
        const loader = await import('/loading/session-loader.js');
        const fio = await import('/import-export/file-io.js');
        const tri = await import('/pose/triangulation.js');
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');

        const NFRAMES = 12, W = 320, H = 240, ROOT = 'sess';
        const padSet = PAD_CAMS === 'all' ? new Set(CAMS)
            : new Set(PAD_CAMS ? PAD_CAMS.split(',').filter(Boolean) : []);
        const report = { threshold: tri.LAZY_SLP_THRESHOLD, padded: Array.from(padSet), steps: [] };

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
            await writer.addFrame(i);
        }
        const mp4 = (await writer.finish()).blob;

        let toml = '';
        CAMS.forEach((cn, i) => {
            toml += '[cam_' + i + ']\nname = "' + cn + '"\nsize = [' + W + ', ' + H + ']\n'
                + 'matrix = [[600.0, 0.0, 160.0], [0.0, 600.0, 120.0], [0.0, 0.0, 1.0]]\n'
                + 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\n'
                + 'rotation = [0.0, ' + (0.2 * i) + ', 0.0]\n'
                + 'translation = [' + (15 * i) + ', 0.0, 0.0]\n\n';
        });

        function mkFile(bits, relPath, type) {
            const f = new File(bits, relPath.split('/').pop(), { type: type || 'application/octet-stream' });
            Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
            return f;
        }
        function folderFiles(slps) {
            const files = [mkFile([toml], ROOT + '/calibration.toml', 'text/plain')];
            for (const cn of CAMS) files.push(mkFile([mp4], ROOT + '/' + cn + '/' + cn + '.mp4', 'video/mp4'));
            for (const s of (slps || [])) files.push(s);
            return files;
        }
        function perCamCounts() {
            const s = AS.state.session, per = {};
            if (!s) return per;
            for (const c of s.cameras) per[c.name] = 0;
            for (const [, fg] of s.frameGroups) {
                for (const [cn, xs] of fg.instances) per[cn] = (per[cn] || 0) + xs.length;
                for (const [cn, xs] of fg.unlinkedInstances) per[cn] = (per[cn] || 0) + xs.length;
            }
            return per;
        }

        // ---- load 1: videos + calibration, then annotate ---------------------
        await loader.handleLoadSessionFolderPerCamera(folderFiles([]), false);
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
                        [[10 + f + t * 50, 20], [30 + f + t * 50, 40], [50 + f + t * 50, 60]], t, 'user', 1));
                }
            }
        }
        report.steps.push({ label: 'after annotating', perCam: perCamCounts() });

        // ---- export by cam, padding the chosen cameras over the threshold ----
        const slpFiles = [];
        report.fileSizes = {};
        for (const vf of AS.state.videoFiles) {
            if (vf.sessionIdx !== AS.state.activeSessionIdx) continue;
            const cam = vf.assignedCamera || vf.name;
            const blob = await fio.exportSlpClientSide(s1, cam, false, vf, cam + '_v1.slp', null);
            const parts = [blob];
            if (padSet.has(cam)) parts.push(new Uint8Array(tri.LAZY_SLP_THRESHOLD + (1 << 20)));
            const f = mkFile(parts, ROOT + '/' + cam + '/' + cam + '_v1.slp', 'application/x-hdf5');
            report.fileSizes[cam] = { bytes: f.size, lazy: tri.shouldUseLazySlp(f) };
            slpFiles.push(f);
        }

        // ---- load 2: the fresh reload ---------------------------------------
        AS.state.sessions = []; AS.state.activeSessionIdx = 0;
        AS.state.videoFiles = []; AS.state.session = null; AS.state.views = [];
        await loader.handleLoadSessionFolderPerCamera(folderFiles(slpFiles), false);

        const s2 = AS.state.session;
        report.steps.push({
            label: 'reload — immediately after load',
            views: AS.state.views.map(v => v.name),
            hasLazyLoader: !!(s2 && s2.lazyLoader),
            lazyCams: s2 && s2.lazyLoader && s2.lazyLoader.labelsByCam
                ? Array.from(s2.lazyLoader.labelsByCam.keys()) : null,
            frameGroups: s2 ? s2.frameGroups.size : 0,
            perCam: perCamCounts(),
        });

        // ---- scrub every frame, exactly as the user would --------------------
        for (let f = 0; f < NFRAMES; f++) {
            AS.state.currentFrame = f;
            await tri.ensureLazyFrameData(f);
        }
        report.steps.push({
            label: 'reload — after scrubbing every frame',
            frameGroups: s2 ? s2.frameGroups.size : 0,
            perCam: perCamCounts(),
        });

        return report;
    }, { CAMS, PAD_CAMS });

    console.log(JSON.stringify(out, null, 2));

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
