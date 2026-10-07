/**
 * _diag-set-calibration-shot.mjs — render the Set as New Calibration
 * confirmation on a MULTI-SESSION project and save PNGs of it.
 *
 * Investigation tool, not an assertion: `_diag-*` is excluded from suite runs.
 * Everything it shows is pinned by `set-new-calibration.mjs`; this exists so the
 * dialog can be LOOKED at after a copy or layout change, which is otherwise a
 * manual app session with a staged origin.
 *
 * Three shots: both tally sections expanded (the default), both folded, and the
 * dialog with one session deselected so the subset warning is visible.
 *
 * Run: node _diag-set-calibration-shot.mjs [outDir]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const outDir = process.argv[2] || repoRoot;
const PORT = Number(process.env.PORT || 8292);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // ---- the same fixture `set-new-calibration.mjs` stages -------------
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Camera, Session, Skeleton, Instance, InstanceGroup, FrameGroup,
            UnlinkedInstance, makePoints3d, setPoint3d } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = [
            new Camera('camA', K, [0, 0, 0, 0, 0], [0.05, -0.2, 0.01], [40, -15, 900], [640, 480]),
            new Camera('camB', K, [0, 0, 0, 0, 0], [-0.3, 0.12, 0.4], [-60, 25, 870], [640, 480]),
        ];
        const session = new Session(
            cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], '10072022120554_small');

        const gUser = new InstanceGroup(1, 0);
        gUser.addInstance('camA', new Instance([[10, 20], [30, 40]], 0, 'user', 1));
        gUser.addInstance('camB', new Instance([[11, 21], [31, 41]], 0, 'user', 1));
        gUser.points3d = makePoints3d(2);
        setPoint3d(gUser.points3d, 0, [12.5, -7.25, 210]);
        setPoint3d(gUser.points3d, 1, [-40, 33, 195]);

        const gPred = new InstanceGroup(2, 1);
        gPred.addInstance('camA', new Instance([[50, 60], [70, 80]], 1, 'predicted', 0.8));
        gPred.addInstance('camB', new Instance([[51, 61], [71, 81]], 1, 'predicted', 0.8));
        gPred.addReprojectedInstance('camA', new Instance([[50, 60], [70, 80]], 1, 'reprojected', 1));
        gPred.points3d = makePoints3d(2);
        setPoint3d(gPred.points3d, 0, [300, -120, 188]);
        setPoint3d(gPred.points3d, 1, [5, 5, 230]);
        session.instanceGroups.set(0, [gUser, gPred]);

        const fg = new FrameGroup(0);
        for (let i = 0; i < 5; i++) {
            fg.addUnlinkedInstance('camA', new UnlinkedInstance(
                new Instance([[90 + i, 100 + i], [110 + i, 120 + i]], 1, 'predicted', 0.6), 'camA'));
        }
        session.frameGroups.set(0, fg);

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 10;
        AS.state.views = cams.map(c => ({ name: c.name, videoWidth: 640, videoHeight: 480, canvas: null }));
        AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name }));
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
    });
    await page.waitForFunction(
        () => window.__lucid.state.views.every(v => !!v.overlayCanvas), { timeout: 10000 });

    const TRUTH = [
        [-40.678, -30.234, 216.588], [40, -30, 220], [40, 30, 225], [-40, 30, 221],
    ];
    await page.evaluate(async (TF) => {
        const P = await import('/ui/plane-definition.js');
        const T = await import('/pose/triangulation.js');
        const AS = await import('/ui/app-state.js');
        const model = P.planeModel();
        const floor = P.createPlane('Ground');
        ['origin', 'h1', 'f2', 'f3'].forEach(nm => model.createNodeInPlane(nm, floor));
        for (let k = 0; k < 4; k++) floor.addEdge(floor.nodeIds[k], floor.nodeIds[(k + 1) % 4]);
        for (const cam of AS.state.session.cameras) {
            P.placePlaneOnView(floor, cam.name, 320, 240);
            const inst = P.getPlaneInstance(cam.name);
            const idx = floor.nodeIds.map(id => model.pool.indexOf(id));
            TF.forEach((q, k) => { const uv = cam.project(q); inst.setPoint(idx[k], uv[0], uv[1]); });
        }
        P.planeState.selectedPlaneId = floor.id;
        P.enterPlaneMode();
        P.refreshPlanePanel();
        document.getElementById('btnPlaneTriangulate').click();
        const fit = T.fitPlaneToPoints3d(P.planePoints3d(floor));
        floor.planeFit = { centroid: fit.centroid, normal: fit.normal, rms: fit.rms, nPoints: fit.nPoints };
        P.refreshPlanePanel();
        P.syncPlanes3D();
        window.__floorId = floor.id;
    }, TRUTH);

    // Three more sessions, so the by-session table and the multi-session note
    // both appear. Named like the real `small_multi_session` folders, since the
    // point of the shot is to look like what the user sees.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const extra = ['10072022131531_small', '10072022145420_small', '10072022193448_small']
            .map((name, i) => new pd.Session([
                new pd.Camera('camA', K, [0, 0, 0, 0, 0], [0.05 + i * 0.01, -0.2, 0.01], [40, -15, 900], [640, 480]),
                new pd.Camera('camB', K, [0, 0, 0, 0, 0], [-0.3, 0.12, 0.4], [-60, 25, 870], [640, 480]),
            ], AS.state.session.skeleton, ['track_0'], name));
        AS.state.sessions = [AS.state.session].concat(extra);
    });

    await page.evaluate(async () => {
        const O = await import('/ui/origin-definition.js');
        O.enterOriginMode();
        O.pickOriginNode(window.__floorId, 0);
        O.pickOriginAxis('negative');
        O.applyOrigin();
    });

    const modal = page.locator('#originRebaseConfirm .origin-rebase-modal');

    async function shot(file) {
        const dest = path.join(outDir, file);
        await modal.screenshot({ path: dest });
        const box = await modal.boundingBox();
        console.log(`${file}  ${Math.round(box.width)}x${Math.round(box.height)}px`);
    }

    // Clicked through the DOM, not through Playwright: the Danger Zone ships
    // COLLAPSED (see CLAUDE.md), so the button is not visible and
    // `page.click` waits for a visibility that never arrives.
    await page.evaluate(() => document.getElementById('btnSetCalibration').click());
    await page.waitForSelector('#originRebaseConfirm');
    await shot('set-calib-expanded.png');

    // Fold both tally sections — the default is open, so this is the other state.
    await page.evaluate(() => {
        ['originRebaseCounts', 'originRebaseKeeps'].forEach(id => {
            const d = document.getElementById(id).closest('details');
            if (d) d.open = false;
        });
    });
    await new Promise(r => setTimeout(r, 350)); // the caret rotation is transitioned
    await shot('set-calib-folded.png');

    // One session deselected, so the subset warning shows.
    await page.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll(
            '#originRebaseBySession input[type=checkbox]')).filter(b => !b.disabled);
        if (boxes.length) { boxes[boxes.length - 1].click(); }
    });
    await page.evaluate(() => {
        ['originRebaseCounts', 'originRebaseKeeps'].forEach(id => {
            const d = document.getElementById(id).closest('details');
            if (d) d.open = true;
        });
    });
    await new Promise(r => setTimeout(r, 350));
    await shot('set-calib-subset.png');

    const texts = await page.evaluate(() => ({
        titles: Array.from(document.querySelectorAll('.origin-rebase-block-title'))
            .map(e => e.textContent),
        multi: (document.getElementById('originRebaseMultiNote') || {}).textContent || '',
        subset: (document.getElementById('originRebaseSubsetWarning') || {}).textContent || '',
        stale: (document.getElementById('originRebaseStaleWarning') || {}).textContent || '',
    }));
    console.log('\ntitles:', JSON.stringify(texts.titles));
    console.log('\nmulti note:\n  ' + texts.multi);
    console.log('\nsubset warning:\n  ' + texts.subset);
    console.log('\nstale warning:\n  ' + texts.stale);
} finally {
    if (browser) await browser.close();
    server.kill();
}
