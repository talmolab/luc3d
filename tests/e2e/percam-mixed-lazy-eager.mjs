/**
 * percam-mixed-lazy-eager.mjs — a session folder whose per-camera `.slp` files
 * straddle the lazy threshold must still load EVERY camera's annotations.
 *
 * Reported as "I exported the .slp files, put them back in the session folder,
 * reloaded, and only some of the views came back". The panes were all there;
 * some of them just had no labels, under a "Loaded N camera(s)" success line.
 *
 * `handleLoadSessionFolderPerCamera` used to route each camera's file
 * INDEPENDENTLY by size (`shouldUseLazySlp`, 150 MB), so one folder could come
 * back part eager and part lazy. The eager cameras populate
 * `session.frameGroups` during load, and `ensureLazyFrameData` opened with
 * `if (session.frameGroups.has(frameIdx)) return;` — so on every frame an eager
 * camera had already created, the lazy cameras were never hydrated at all.
 * Replacing prediction files with LUCID exports is exactly what moves a camera
 * across that fixed threshold, which is why it showed up on a reload and not on
 * the original load.
 *
 * Two independent fixes, and this asserts both:
 *   1. the folder is routed as ONE unit (`loading/session-loader.js`), so the
 *      mix cannot arise from a folder load at all; and
 *   2. `ensureLazyFrameData` hydrates the cameras missing from an existing
 *      FrameGroup instead of skipping the frame (`pose/triangulation.js`),
 *      which is asserted directly by hand-building the mixed state below.
 *
 * Real videos, encoded in-page through the app's own `ui/video-encode.js`, so
 * views are created the way they are in production. A camera is pushed over the
 * threshold by appending zero padding to its real exported bytes:
 * `shouldUseLazySlp` reads only `file.size`, and HDF5 ignores trailing bytes.
 *
 * Run: node tests/e2e/percam-mixed-lazy-eager.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8271);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const r = await page.evaluate(async () => {
        const enc = await import('/ui/video-encode.js');
        const loader = await import('/loading/session-loader.js');
        const fio = await import('/import-export/file-io.js');
        const tri = await import('/pose/triangulation.js');
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');

        const CAMS = ['cam1', 'cam2', 'cam3'];
        const NFRAMES = 12, W = 320, H = 240, ROOT = 'sess';
        const PER_CAM = 12;   // 6 frames x 2 instances

        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const cctx = canvas.getContext('2d');
        const wr = await enc.createMp4Writer({
            canvas, width: W, height: H, fps: 10,
            bitrate: 400000, frameCount: NFRAMES, keyFrameEveryFrames: 4,
        });
        for (let i = 0; i < NFRAMES; i++) {
            cctx.fillStyle = 'rgb(' + (20 * i) + ',40,80)'; cctx.fillRect(0, 0, W, H);
            await wr.addFrame(i);
        }
        const mp4 = (await wr.finish()).blob;

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
        function folderFiles(slps) {
            const files = [mkFile([toml], ROOT + '/calibration.toml', 'text/plain')];
            for (const cn of CAMS) files.push(mkFile([mp4], ROOT + '/' + cn + '/' + cn + '.mp4', 'video/mp4'));
            for (const s of (slps || [])) files.push(s);
            return files;
        }
        function perCam() {
            const s = AS.state.session, out = {};
            if (!s) return out;
            for (const c of s.cameras) out[c.name] = 0;
            for (const [, fg] of s.frameGroups) {
                for (const [cn, xs] of fg.instances) out[cn] = (out[cn] || 0) + xs.length;
                for (const [cn, xs] of fg.unlinkedInstances) out[cn] = (out[cn] || 0) + xs.length;
            }
            return out;
        }
        function resetApp() {
            AS.state.sessions = []; AS.state.activeSessionIdx = 0;
            AS.state.videoFiles = []; AS.state.session = null; AS.state.views = [];
        }

        // ---- load 1, annotate, export by cam --------------------------------
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
        const blobs = {};
        for (const vf of AS.state.videoFiles) {
            if (vf.sessionIdx !== AS.state.activeSessionIdx) continue;
            const cam = vf.assignedCamera || vf.name;
            blobs[cam] = await fio.exportSlpClientSide(s1, cam, false, vf, cam + '_v1.slp', null);
        }

        const pad = new Uint8Array(tri.LAZY_SLP_THRESHOLD + (1 << 20));
        const slpFor = (cam, big) => mkFile(
            big ? [blobs[cam], pad] : [blobs[cam]],
            ROOT + '/' + cam + '/' + cam + '_v1.slp', 'application/x-hdf5');

        async function loadAndScrub(bigCams) {
            resetApp();
            const slps = CAMS.map(cn => slpFor(cn, bigCams.includes(cn)));
            await loader.handleLoadSessionFolderPerCamera(folderFiles(slps), false);
            const s = AS.state.session;
            const atLoad = perCam();
            for (let f = 0; f < NFRAMES; f++) {
                AS.state.currentFrame = f;
                await tri.ensureLazyFrameData(f);
            }
            return {
                views: AS.state.views.map(v => v.name),
                lazyCams: s && s.lazyLoader && (s.lazyLoader.labelsByCam || s.lazyLoader.workers)
                    ? Array.from((s.lazyLoader.labelsByCam || s.lazyLoader.workers).keys()).sort() : [],
                atLoad, afterScrub: perCam(),
                status: (document.getElementById('statusText') || {}).textContent || null,
            };
        }

        const out = {
            expected: PER_CAM,
            allEager: await loadAndScrub([]),
            oneBig: await loadAndScrub(['cam1']),
            allBig: await loadAndScrub(CAMS),
        };

        // ---- the hydration guard itself, with a mix built by hand ------------
        // Fix 1 means a folder load can no longer produce a mixed session, so
        // the fix in `ensureLazyFrameData` needs to be reached directly: take
        // the all-lazy session, hydrate frame 0, then delete ONE camera's rows
        // from that FrameGroup to imitate a group an eager parse built without
        // it. The old guard returned on `frameGroups.has(0)` and left it empty.
        const s3 = AS.state.session;
        const fg0 = s3.getFrameGroup(0);
        fg0.instances.set('cam2', []);
        fg0.unlinkedInstances.set('cam2', []);
        const beforeRepair = (fg0.instances.get('cam2') || []).length
            + (fg0.getUnlinkedInstances('cam2') || []).length;
        await tri.ensureLazyFrameData(0);
        out.partialFrame = {
            beforeRepair,
            afterRepair: (fg0.instances.get('cam2') || []).length
                + (fg0.getUnlinkedInstances('cam2') || []).length,
            otherCamUnchanged: (fg0.instances.get('cam1') || []).length
                + (fg0.getUnlinkedInstances('cam1') || []).length,
        };
        // Idempotent: a second pass over an already-complete frame must not
        // duplicate anything (the #194/#195 re-materialize class).
        await tri.ensureLazyFrameData(0);
        out.partialFrame.afterSecondPass = (fg0.instances.get('cam2') || []).length
            + (fg0.getUnlinkedInstances('cam2') || []).length;

        return out;
    });

    console.log('  measured:', JSON.stringify(r, null, 1).replace(/\n\s*/g, ' ').slice(0, 900));

    const E = r.expected;
    for (const [label, res] of [['all eager', r.allEager], ['MIXED (one over the threshold)', r.oneBig], ['all lazy', r.allBig]]) {
        check(res.views.length === 3, `${label}: all 3 views exist (got ${JSON.stringify(res.views)})`);
        const got = res.afterScrub;
        const bad = Object.keys(got).filter(k => got[k] !== E);
        check(bad.length === 0,
            `${label}: every camera has its ${E} instances after scrubbing (got ${JSON.stringify(got)})`);
    }

    check(r.oneBig.lazyCams.length === 3,
        `MIXED: the whole folder is routed lazily rather than split (lazy cams = ${JSON.stringify(r.oneBig.lazyCams)})`);
    check(r.allEager.lazyCams.length === 0,
        'all-small folders still take the eager path — the unification only widens toward lazy');
    check(Object.values(r.allEager.atLoad).every(v => v === E),
        `all eager: data is present immediately at load, no scrub needed (got ${JSON.stringify(r.allEager.atLoad)})`);

    check(r.partialFrame.beforeRepair === 0, 'partial-frame setup: cam2 really was emptied');
    check(r.partialFrame.afterRepair === 2,
        `ensureLazyFrameData repairs a FrameGroup missing one camera (got ${r.partialFrame.afterRepair}, want 2)`);
    check(r.partialFrame.otherCamUnchanged === 2,
        `and leaves the cameras that were already there alone (got ${r.partialFrame.otherCamUnchanged}, want 2)`);
    check(r.partialFrame.afterSecondPass === 2,
        `and is idempotent — no duplicate rows on a second pass (got ${r.partialFrame.afterSecondPass}, want 2)`);

    check(errs.length === 0, `no page/console errors (got ${JSON.stringify(errs.slice(0, 3))})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
