/**
 * track-all-fresh-lazy-session.mjs — real-browser regression test.
 *
 * Bug: trackAll() (pose/tracker.js) checked `session.frameIndices.length`
 * (== session.frameGroups.size, the lazy loader's currently-RESIDENT window)
 * before ever consulting the windowed-sweep branch. A freshly-opened large
 * lazy project has ZERO resident frame groups (nothing visited/scrubbed to
 * yet) even though `session.lazyLoader.nFrames` correctly reports the whole
 * project — so Track All immediately bailed with "No frames to track" the
 * very first time it was run on a project nobody had scrubbed through yet.
 * Found by an ad hoc E2E run against a real 180k-frame project.
 *
 * This test builds a small synthetic multi-frame project with real cross-view
 * geometry (so the tracker can actually find matches), saves it via the real
 * SLP writer, reopens it via the real SioLazyLoader.openProjectSlp() (leaving
 * frameGroups empty, exactly like a fresh large-project reopen), and asserts
 * the real trackAll() finds identities instead of bailing.
 *
 * Run: node track-all-fresh-lazy-session.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8097);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', msg => { if (msg.type() === 'error') console.log('  [console.error]', msg.text().slice(0, 300)); });
    page.on('dialog', async d => { await d.accept(''); }); // "Number of animals" -> auto-detect

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    const r = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const fileio = await import('/import-export/file-io.js');
        const lazyMod = await import('/loading/sio-lazy-loader.js');
        const tracker = await import('/pose/tracker.js');
        const AS = await import('/ui/app-state.js');
        const SioLazyLoader = lazyMod.SioLazyLoader || lazyMod.default;
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        // Two cameras with real relative geometry (mirrors tests/test-tracker.js's
        // makeTestCamera) so the tracker's epipolar/triangulation math has a real
        // cross-view correspondence to find, not just placeholder points.
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const camA = new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
        const camB = new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.3, 0], [20, 0, 0], [640, 480]);
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const session = new Session([camA, camB], skel, ['track_0'], 'FreshLazyTrackAll');

        const NF = 20;
        for (let f = 0; f < NF; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            const p1 = [10 + f * 0.2, 5, 50];
            const p2 = [11 + f * 0.2, 6, 51];
            for (const cam of [camA, camB]) {
                const inst = new Instance([cam.project(p1), cam.project(p2)], 0, 'predicted', 1);
                fg.addInstance(cam.name, inst);
            }
        }

        const views = [camA, camB].map(c => ({ name: c.name, videoWidth: 640, videoHeight: 480, frameCount: NF }));
        const vf = [camA, camB].map(c => ({ name: c.name, assignedCamera: c.name, videoPath: c.name + '.mp4' }));
        const labels = fileio.buildSlpLabelsAllViews(session, views, vf);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);
        const file = new File([bytes], 'fresh.slp');

        // Reopen via the REAL project-reopen lazy loader — frameGroups starts
        // EMPTY (nothing visited yet), exactly the condition that triggered
        // the bug: session.frameIndices.length === 0 even though the project
        // has real frames waiting in the lazy loader.
        const loader = new SioLazyLoader();
        const opened = await loader.openProjectSlp(file, () => {});

        const cameras2 = [camA, camB].map(c => new Camera(c.name, c.matrix, c.dist, c.rvec, c.tvec, c.size));
        const skeleton2 = new Skeleton(loader.skeleton.name, loader.skeleton.nodes, loader.skeleton.edges);
        const tracks2 = loader.trackNames.length ? loader.trackNames.slice() : ['track_0'];
        const reSession = new Session(cameras2, skeleton2, tracks2, 'FreshLazyTrackAll');
        reSession.lazyLoader = loader;
        reSession._lazyReopened = true;

        AS.state.sessions = [reSession];
        AS.state.activeSessionIdx = 0;
        AS.state.session = reSession;
        AS.state.totalFrames = loader.nFrames;
        AS.state.currentFrame = 0;

        const frameGroupsResidentBeforeTrackAll = reSession.frameGroups.size;

        await tracker.trackAll();

        return {
            frameGroupsResidentBeforeTrackAll,
            lazyLoaderNFrames: loader.nFrames,
            status: document.getElementById('statusText').textContent,
            numIdentities: reSession.identities.length,
            frameIdentityMapSize: reSession.frameIdentityMap.size,
        };
    });

    console.log('  measured:', JSON.stringify(r, null, 2));
    check(r.frameGroupsResidentBeforeTrackAll === 0, 'precondition: reopened session has ZERO resident frameGroups before Track All (the exact condition that triggered the bug)');
    check(r.lazyLoaderNFrames === 20, `precondition: lazy loader reports the real total (${r.lazyLoaderNFrames} / expected 20)`);
    check(!/no frames to track/i.test(r.status), `Track All did NOT bail with "No frames to track" (status: "${r.status}")`);
    check(!/error/i.test(r.status), `Track All did not report an error (status: "${r.status}")`);
    check(r.numIdentities > 0, `Track All found at least one identity from the synthetic cross-view geometry (got ${r.numIdentities})`);
    check(r.frameIdentityMapSize > 0, `frameIdentityMap got populated (got ${r.frameIdentityMapSize} entries)`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
