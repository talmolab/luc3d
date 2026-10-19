/**
 * _bench-save.mjs — times the merged SLP save on a synthetic but realistically
 * shaped project, so a save-path slowdown can be measured instead of guessed at.
 *
 * Not a test. Run against two checkouts and compare:
 *   node _bench-save.mjs            # this working tree
 *   PORT=8123 node _bench-save.mjs  # a worktree at the baseline commit
 *
 * Env: FRAMES (default 6000), CAMS (3), NODES (15), PORT (8101).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8101);
const FRAMES = Number(process.env.FRAMES || 6000);
const CAMS = Number(process.env.CAMS || 3);
const NODES = Number(process.env.NODES || 15);
const NO3D = process.env.NO3D === '1';
const REPS = Number(process.env.REPS || 3);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch({ args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'] });
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)));

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    const r = await page.evaluate(async ({ FRAMES, CAMS, NODES, NO3D, REPS }) => {
        window.__BENCH_REPS = REPS;
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const fileio = await import('/import-export/file-io.js');
        const { Skeleton, Camera, Instance, FrameGroup, Session, InstanceGroup } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = [];
        for (let c = 0; c < CAMS; c++) {
            cams.push(new Camera('cam' + c, K, [0, 0, 0, 0, 0], [0, 0.3 * c, 0], [20 * c, 0, 0], [640, 480]));
        }
        const nodes = Array.from({ length: NODES }, (_, i) => 'n' + i);
        const edges = Array.from({ length: NODES - 1 }, (_, i) => [i, i + 1]);
        const skel = new Skeleton('sk', nodes, edges);
        const session = new Session(cams, skel, ['t0'], 'Bench');

        const t0 = performance.now();
        session.addIdentity('Red');
        const rid = session.identities[0].id;
        for (let f = 0; f < FRAMES; f++) {
            session.addFrameGroup(new FrameGroup(f));
            const fg = session.frameGroups.get(f);
            const grp = new InstanceGroup(f + 1, rid);
            const pts3 = new Float64Array(NODES * 3);
            for (let n = 0; n < NODES; n++) {
                pts3[n * 3] = 10 + n + f * 0.001;
                pts3[n * 3 + 1] = 5 + n;
                pts3[n * 3 + 2] = 50 + n;
            }
            for (const cam of cams) {
                const p2 = [];
                for (let n = 0; n < NODES; n++) {
                    p2.push(cam.project([pts3[n * 3], pts3[n * 3 + 1], pts3[n * 3 + 2]]));
                }
                const inst = new Instance(p2, 0, 'predicted', 1);
                fg.addInstance(cam.name, inst);
                grp.addInstance(cam.name, inst);
            }
            // Match whatever representation this checkout expects.
            if (!NO3D) {
            grp.points3d = pd.fromBoxedPoints3d
                ? pts3
                : Array.from({ length: NODES }, (_, n) => [pts3[n * 3], pts3[n * 3 + 1], pts3[n * 3 + 2]]);
            }
            if (!pd.fromBoxedPoints3d && !NO3D) {
                // Pre-#189 checkouts also stored observedPoints.
                grp.observedPoints = {};
                for (const cam of cams) grp.observedPoints[cam.name] = grp.getInstance(cam.name).points;
            }
            session.instanceGroups.set(f, [grp]);
        }
        const tBuild = performance.now() - t0;

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = FRAMES;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = cams.map(c => ({ name: c.name, videoWidth: 640, videoHeight: 480 }));
        AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name, videoPath: c.name + '.mp4' }));

        if (window.gc) { window.gc(); window.gc(); }
        await new Promise(r => setTimeout(r, 100));
        const heapBefore = performance.memory.usedJSHeapSize;

        // ---- the thing being timed: build the SLP label graph + write bytes ----
        const t1 = performance.now();
        const labels = fileio.buildSlpLabelsAllViews(session, AS.state.views, AS.state.videoFiles);
        const tBuildLabels = performance.now() - t1;

        // Repeat the write so a single GC pause cannot dominate the number.
        const writeTimes = [];
        let bytes = null;
        for (let r = 0; r < REPS; r++) {
            const t2 = performance.now();
            bytes = await window.SleapIO.saveSlpToBytes(labels);
            writeTimes.push(Math.round(performance.now() - t2));
        }
        const tWrite = Math.min.apply(null, writeTimes);

        // Settled heap: force GC so this measures RETAINED bytes, not whatever
        // the collector had not gotten to yet.
        if (window.gc) { window.gc(); window.gc(); window.gc(); }
        await new Promise(r => setTimeout(r, 150));
        const heapAfter = performance.memory.usedJSHeapSize;
        return {
            frames: FRAMES, cams: CAMS, nodes: NODES,
            tBuild: Math.round(tBuild),
            tBuildLabels: Math.round(tBuildLabels),
            tWrite: Math.round(tWrite),
            writeTimes,
            tSaveTotal: Math.round(tBuildLabels + tWrite),
            bytes: bytes ? bytes.length : -1,
            heapBeforeMB: +(heapBefore / 1048576).toFixed(0),
            heapAfterMB: +(heapAfter / 1048576).toFixed(0),
        };
    }, { FRAMES, CAMS, NODES, NO3D, REPS });

    console.log(JSON.stringify(r));
    console.log(`\n  project      : ${r.frames} frames x ${r.cams} cams x ${r.nodes} nodes`);
    console.log(`  build graph  : ${r.tBuildLabels} ms   (buildSlpLabelsAllViews)`);
    console.log(`  write bytes  : ${r.tWrite} ms   (saveSlpToBytes)`);
    console.log(`  SAVE TOTAL   : ${r.tSaveTotal} ms   -> ${(r.bytes / 1e6).toFixed(1)} MB`);
    console.log(`  heap         : ${r.heapBeforeMB} -> ${r.heapAfterMB} MB`);
} catch (e) {
    console.error('FATAL', e);
} finally {
    if (browser) await browser.close();
    server.kill();
}
