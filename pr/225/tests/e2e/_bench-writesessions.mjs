/**
 * _bench-writesessions.mjs — isolates the `/session_data` writer (phase 2/4 of a
 * streaming save, i.e. `openProjectWriter` -> sleap-io `writeSessions`) and
 * scales the instance-group count, holding the 2D frame table tiny.
 *
 * Purpose: the merged save of the real 180,210-frame x 5-camera project runs
 * 30+ minutes. `writeSessions` accumulates one BOXED Array per instance-group
 * member (2,627,453 of them there) plus one per group — the same anti-pattern
 * luc3d #185 fixed for the 3D points. This measures whether that phase is
 * linear (a constant-factor/memory problem) or super-linear (an algorithmic
 * one), so the fix targets the real cause.
 *
 * Not a test. Env: GROUPS (default 50000), CAMS (5), NODES (15), PORT (8102).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.argv[3] || process.env.PORT || 8102);
const GROUPS = Number(process.argv[2] || process.env.GROUPS || 50000);
const CAMS = Number(process.env.CAMS || 5);
const NODES = Number(process.env.NODES || 15);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch({ args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] });
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.SleapIO, { timeout: 20000 });

    const r = await page.evaluate(async ({ GROUPS, CAMS, NODES }) => {
        const S = window.SleapIO;
        const nodes = Array.from({ length: NODES }, (_, i) => new S.Node('n' + i));
        const skeleton = new S.Skeleton({ nodes, edges: [], name: 'sk' });

        // A handful of real LabeledFrames — instance-group members reference
        // these by index, so the 2D tables stay small while the /session_data
        // tables scale with GROUPS.
        const videos = [], lfs = [], sioInsts = [];
        for (let c = 0; c < CAMS; c++) {
            videos.push(new S.Video({ filename: 'cam' + c + '.mp4', shape: [1, 480, 640, 3] }));
        }
        for (let c = 0; c < CAMS; c++) {
            const pts = {};
            for (let n = 0; n < NODES; n++) pts[nodes[n].name] = { x: n, y: n, visible: true };
            const inst = new S.Instance({ points: pts, skeleton });
            sioInsts.push(inst);
            lfs.push(new S.LabeledFrame({ video: videos[c], frameIdx: 0, instances: [inst] }));
        }

        const cameras = [], camGroup = new S.CameraGroup();
        for (let c = 0; c < CAMS; c++) {
            const cam = new S.Camera({
                name: 'cam' + c, rvec: [0, 0, 0], tvec: [c * 10, 0, 0],
                matrix: [[600, 0, 320], [0, 600, 240], [0, 0, 1]], distortions: [0, 0, 0, 0, 0],
                size: [640, 480],
            });
            cameras.push(cam); camGroup.cameras.push(cam);
        }
        const session = new S.RecordingSession({ cameraGroup: camGroup, metadata: {} });
        for (let c = 0; c < CAMS; c++) session.addVideo(videos[c], cameras[c]);

        // Scale: GROUPS instance groups, each with CAMS members + 3D points.
        const tB = performance.now();
        for (let g = 0; g < GROUPS; g++) {
            const refs = new Map();
            for (let c = 0; c < CAMS; c++) refs.set(cameras[c], [c, 0]);
            const pts3 = new Float64Array(NODES * 3);
            for (let n = 0; n < NODES * 3; n++) pts3[n] = n + g * 0.001;
            const ig = new S.InstanceGroup({
                instanceRefsByCamera: refs,
                instance3d: new S.Instance3D({ points: pts3, skeleton }),
            });
            session.frameGroups.set(g, new S.FrameGroup({ frameIdx: g, instanceGroups: [ig] }));
        }
        const tBuild = performance.now() - tB;

        const labels = new S.Labels({
            labeledFrames: lfs, videos, skeletons: [skeleton], tracks: [],
            sessions: [session], identities: [],
        });

        if (window.gc) { window.gc(); window.gc(); }
        await new Promise(r => setTimeout(r, 100));
        const heapBefore = performance.memory.usedJSHeapSize;

        const t0 = performance.now();
        const bytes = await S.saveSlpToBytes(labels);
        const tWrite = performance.now() - t0;

        const heapPeak = performance.memory.usedJSHeapSize;
        return {
            groups: GROUPS, cams: CAMS, members: GROUPS * CAMS,
            tBuild: Math.round(tBuild), tWrite: Math.round(tWrite),
            usPerGroup: +(tWrite * 1000 / GROUPS).toFixed(1),
            bytes: bytes.length,
            heapBeforeMB: +(heapBefore / 1048576).toFixed(0),
            heapPeakMB: +(heapPeak / 1048576).toFixed(0),
        };
    }, { GROUPS, CAMS, NODES });

    console.log(JSON.stringify(r));
} catch (e) {
    console.error('FATAL', String(e).slice(0, 300));
} finally {
    if (browser) await browser.close();
    server.kill();
}
