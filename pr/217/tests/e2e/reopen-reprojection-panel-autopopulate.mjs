/**
 * reopen-reprojection-panel-autopopulate.mjs — real-browser regression test.
 *
 * Bug: reopening a saved lazy project via handleLoadProjectSlpLazy() (the
 * "Load Project" path for a merged multi-camera .slp) never revealed
 * #reprojErrorSection, which defaults to `style="display:none"` in
 * index.html. Every OTHER code path that populates 3D/reprojection data
 * (Triangulate All, slp-import.js, save-load.js, identity-assignment.js, …)
 * calls setReprojErrorVisible(true), but the lazy-reopen path did not — so
 * after reopening a project that already has real 3D + reprojections (e.g.
 * saved right after Track All + Triangulate All), the Instance panel's
 * reprojection-error readout stayed blank ("-") even though drawAllOverlays's
 * lazy-reproject block silently computed the real error underneath (visible
 * only via the 2D/3D viewers, which don't gate on this section). The user
 * had to manually re-run Triangulate All after every reopen just to make the
 * panel show a number that was already being computed.
 *
 * This uses TWO separate browser contexts (not one page) because the bug is
 * about a DOM style flag that persists across calls within one page — a
 * single-page repro would have the section already revealed from the
 * pre-save Track All + Triangulate All step, masking the bug. Page 1 builds
 * a small real cross-view project, tracks + triangulates it for real, and
 * saves it via the real streaming saveAs() path to an actual file on disk.
 * Page 2 is a FRESH context (section at its true HTML default) that fetches
 * that file and calls the real handleLoadProjectSlpLazy() directly.
 *
 * handleLoadProjectSlpLazy() is not fully awaited: near its end it awaits
 * attachVideosForLazyReopen(), which shows an interactive "attach videos"
 * modal that never resolves headlessly (nothing clicks Skip). Every step
 * under test (setReprojErrorVisible/drawAllOverlays/updateInfoPanel) runs
 * before that await, so this fires the call and polls the DOM instead of
 * blocking on the whole promise chain.
 *
 * Run: node reopen-reprojection-panel-autopopulate.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8098);
const SERVED_FIXTURE_NAME = `_reopen-reproj-autopopulate-${process.pid}.slp`;
const SERVED_FIXTURE_PATH = path.join(repoRoot, SERVED_FIXTURE_NAME);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

try { fs.unlinkSync(SERVED_FIXTURE_PATH); } catch (e) { /* ignore */ }

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();

    // ---- Page 1: build + Track/Triangulate + save (real streaming path) ----
    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    page1.on('pageerror', e => { console.log('  [p1 pageerror]', String(e).slice(0, 300)); fails++; });
    page1.on('dialog', async d => { await d.accept(''); });

    let bytesWritten = 0;
    const fd = fs.openSync(SERVED_FIXTURE_PATH, 'w');
    await page1.exposeFunction('__appendChunkBase64', (b64) => {
        const buf = Buffer.from(b64, 'base64');
        fs.writeSync(fd, buf);
        bytesWritten += buf.length;
    });

    await page1.goto(`http://localhost:${PORT}/index.html`);
    await page1.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    const buildResult = await page1.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const exportModals = await import('/ui/export-modals.js');
        const saveLoad = await import('/import-export/save-load.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, FrameGroup, Session } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const camA = new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
        const camB = new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.3, 0], [20, 0, 0], [640, 480]);
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const session = new Session([camA, camB], skel, ['track_0'], 'ReopenReprojAutopopulate');
        const NF = 10;
        for (let f = 0; f < NF; f++) session.addFrameGroup(new FrameGroup(f));
        for (let f = 0; f < NF; f++) {
            const fg = session.frameGroups.get(f);
            const p1 = [10 + f * 0.2, 5, 50];
            const p2 = [11 + f * 0.2, 6, 51];
            for (const cam of [camA, camB]) {
                fg.addInstance(cam.name, new Instance([cam.project(p1), cam.project(p2)], 0, 'predicted', 1));
            }
        }

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = NF;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = [];

        // Real Track All output shape (identity + per-camera track assignment)
        // via the identity API directly, then real Triangulate All — matches
        // an actual user's Track All -> Triangulate All -> Save workflow.
        session.addIdentity('Red');
        const redId = session.identities[0].id;
        for (let f = 0; f < NF; f++) {
            const grp = new pd.InstanceGroup(f + 1, redId);
            const fg = session.frameGroups.get(f);
            for (const cam of [camA, camB]) grp.addInstance(cam.name, fg.instances.get(cam.name)[0]);
            session.instanceGroups.set(f, [grp]);
        }
        session.assignTrackToIdentity(0, redId, 'camA');
        session.assignTrackToIdentity(0, redId, 'camB');
        await exportModals.groupByIdentityAndTriangulateAll();
        const g0 = session.instanceGroups.get(0)[0];

        function toBase64(bytes) {
            let binary = '';
            const CHUNK = 0x8000;
            for (let off = 0; off < bytes.length; off += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(off, off + CHUNK));
            return btoa(binary);
        }
        window.showSaveFilePicker = async () => ({
            createWritable: async () => ({
                write: async (chunk) => { await window.__appendChunkBase64(toBase64(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))); },
                close: async () => {}, abort: async () => {},
            }),
        });
        const saveStatusBefore = document.getElementById('statusText').textContent;
        await saveLoad.saveAs();

        return {
            instanceGroupsSize: session.instanceGroups.size,
            g0HasPoints3d: !!(g0.points3d && g0.points3d.length > 0),
            saveStatus: document.getElementById('statusText').textContent,
            saveStatusBefore,
        };
    });
    fs.closeSync(fd);

    console.log('  Page 1 build+save:', JSON.stringify(buildResult), `bytesWritten=${bytesWritten}`);
    check(buildResult.instanceGroupsSize === 10, `real Triangulate All grouped all 10 frames (got ${buildResult.instanceGroupsSize})`);
    check(buildResult.g0HasPoints3d, 'frame 0 group has real triangulated 3D points before save');
    check(bytesWritten > 500, `saved a non-trivial file to disk (${bytesWritten} bytes)`);
    await context1.close();

    // ---- Page 2: fresh context — #reprojErrorSection at its true HTML default ----
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    page2.on('pageerror', e => { console.log('  [p2 pageerror]', String(e).slice(0, 300)); fails++; });
    page2.on('dialog', async d => { await d.accept(''); });

    await page2.goto(`http://localhost:${PORT}/index.html`);
    await page2.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const sectionDisplay = () => page2.evaluate(() => {
        const el = document.getElementById('reprojErrorSection');
        return el ? el.style.display : 'NO_ELEMENT';
    });
    const errText = () => page2.evaluate(() => {
        const el = document.getElementById('errorDisplay');
        return el ? el.textContent : null;
    });

    const displayBefore = await sectionDisplay();
    const errBefore = await errText();
    console.log('  Page 2 BEFORE reopen — section display:', JSON.stringify(displayBefore), 'errorDisplay:', JSON.stringify(errBefore));
    check(displayBefore === 'none', `precondition: reprojErrorSection starts hidden on a fresh page (got "${displayBefore}")`);
    check(errBefore === '-', `precondition: errorDisplay starts unpopulated (got "${errBefore}")`);

    // Fire-and-forget the real entry point (see file header for why).
    await page2.evaluate(async (fixtureName) => {
        const sessionLoader = await import('/loading/session-loader.js');
        const resp = await fetch('/' + fixtureName);
        if (!resp.ok) throw new Error('fetch of saved fixture failed: ' + resp.status);
        const blob = await resp.blob();
        const file = new File([blob], 'reopen-test.slp');
        sessionLoader.handleLoadProjectSlpLazy(file);
    }, SERVED_FIXTURE_NAME);

    let displayAfter = displayBefore;
    let errAfter = errBefore;
    for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 100));
        displayAfter = await sectionDisplay();
        errAfter = await errText();
        if (displayAfter !== 'none' && errAfter && errAfter !== '-') break;
    }
    console.log('  Page 2 AFTER handleLoadProjectSlpLazy — section display:', JSON.stringify(displayAfter), 'errorDisplay:', JSON.stringify(errAfter));

    check(displayAfter !== 'none', `reprojErrorSection is revealed after reopen with NO manual re-Triangulate-All (got display="${displayAfter}")`);
    check(!!errAfter && errAfter !== '-', `errorDisplay auto-populates a real value after reopen (got "${errAfter}")`);

    await context2.close();
} finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
    try { fs.unlinkSync(SERVED_FIXTURE_PATH); } catch (e) { /* ignore */ }
}
process.exit(fails ? 1 : 0);
