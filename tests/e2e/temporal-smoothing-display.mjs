/**
 * temporal-smoothing-display.mjs — after Triangulate ▸ Temporal Smoothing the
 * 2D reprojection overlay draws the SMOOTHED 3D (luc3d #134).
 *
 * The pass writes `InstanceGroup.points3d` and drops the cached reprojections;
 * `fillLazyReprojections` (`ui/rendering.js`) then refills them on the next
 * draw. It used to re-solve from the 2D whenever the group had no
 * `triangulationMethod` (Track All's provisional 3D) or a reprojection-error
 * threshold was set — drawing the unsmoothed answer, so the pass looked as if it
 * did nothing. Driven through the real toolbar button, on the shared BA rig
 * fixture (2 px noise on every 2D observation, so a re-solve is measurably
 * different from the smoothed 3D):
 *   A. groups with no triangulation method (as Track All leaves them);
 *   B. Triangulate All's groups with a reprojection-error threshold set;
 *   C. the info panel keeps one result per group on the frame (no stale
 *      pre-smoothing entry beside the refilled one);
 *   D. re-triangulating replaces the smoothed 3D, and the display re-solves again;
 *   E. a second run replaces the first (window 9 then 3 == window 3 alone),
 *      both windows at 0 restores the original 3D, and the toolbar button is
 *      blue (`.active`) exactly while smoothing is applied; its "This frame"
 *      item runs one frame, and is lit only where that frame is smoothed.
 *
 * Run: node tests/e2e/temporal-smoothing-display.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8291);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const NF = 40, MID = 20;

    // Fresh eager fixture session, triangulated by the Triangulate All button.
    const setup = (name) => page.evaluate(async ({ name, NF }) => {
        const AS = await import('/ui/app-state.js');
        const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
        const F = window.__F || (window.__F = await buildBaRigFixture({ frames: NF }));
        const s = F.mkSession(name, { eager: true });
        AS.state.sessions = [s];
        AS.state.activeSessionIdx = 0;
        AS.state.session = s;
        AS.state.totalFrames = F.NF;
        AS.state.currentFrame = 0;
        AS.state.views = [];
        AS.state.triangulationResults = new Map();
        document.getElementById('statusText').textContent = '';
        document.getElementById('tbTriangulateAll').click();
    }, { name, NF });
    const waitStatus = (re) => page.waitForFunction(
        (src) => new RegExp(src).test(document.getElementById('statusText').textContent),
        re.source, { timeout: 60000 });

    // Smooth through the real dropdown item, then draw MID.
    const smooth = async (win = 9) => {
        await page.evaluate(async ({ MID, win }) => {
            const AS = await import('/ui/app-state.js');
            const S = await import('/ui/settings.js');
            S.setSmoothingParams({ smoothGaussianWindow: win, smoothMedianWindow: 0 });
            AS.state.currentFrame = MID;
            document.getElementById('statusText').textContent = '';
            document.getElementById('tbSmooth').click();
        }, { MID, win });
        await waitStatus(/^Smoothed |^Removed |Temporal smoothing/);
        return page.evaluate(() => document.getElementById('statusText').textContent);
    };

    // For every group on MID: how far the DRAWN reprojection is from the stored
    // 3D's projection, and from a fresh re-solve of the 2D (max px over nodes).
    const measure = (MID) => page.evaluate(async (MID) => {
        const AS = await import('/ui/app-state.js');
        const R = await import('/ui/rendering.js');
        const TRI = await import('/pose/triangulation.js');
        const CORE = await import('/pose/triangulation-core.js');
        const PD = await import('/pose/pose-data.js');
        R.drawAllOverlays(MID);
        const cams = AS.state.session.cameras;
        const groups = TRI.getInstanceGroupsForFrame(MID) || [];
        const maxDiff = (a, b) => {
            let m = 0;
            for (const cam in a) {
                if (!b[cam]) continue;
                a[cam].forEach((p, k) => {
                    const q = b[cam][k];
                    if (p && q) m = Math.max(m, Math.hypot(p[0] - q[0], p[1] - q[1]));
                });
            }
            return m;
        };
        const res = AS.state.triangulationResults.get(MID) || [];
        return groups.map(g => ({
            smoothedMark: PD.isPoints3dSmoothed(g.points3d),
            vsStored: maxDiff(g.reprojections || {}, CORE.reprojectStoredPoints3d(g, cams).reprojections),
            vsResolve: maxDiff(g.reprojections || {}, CORE.triangulateAndReproject(g, cams,
                { method: g.triangulationMethod === 'ba' ? 'ba' : 'dlt' }).reprojections),
            hasReproj: !!g.reprojections && Object.keys(g.reprojections).length > 0,
            results: res.filter(r => r.group === g).length,
            method: g.triangulationMethod,
        }));
    }, MID);
    const fmt = (rows) => JSON.stringify(rows.map(r => [r.vsStored.toFixed(3), r.vsResolve.toFixed(3)]));

    // ---- A. no triangulation method (Track All's provisional 3D) ----------------------
    await setup('smoothDisplayA');
    await waitStatus(/^(Triangulated|Grouped) /);
    const cleared = await page.evaluate(async (NF) => {
        const TRI = await import('/pose/triangulation.js');
        let n = 0;
        for (let f = 0; f < NF; f++) {
            (TRI.getInstanceGroupsForFrame(f) || []).forEach(g => { g.triangulationMethod = undefined; n++; });
        }
        return n;
    }, NF);
    check(cleared === 2 * NF, `A. precondition: every group has no triangulation method (${cleared})`);
    const msgA = await smooth();
    check(/^Smoothed [\d,]+ poses across 2 tracks/.test(msgA), `A. the pass ran ("${msgA}")`);
    const a = await measure(MID);
    check(a.length === 2 && a.every(r => r.hasReproj && r.smoothedMark && r.method == null),
        'A. both groups on the frame are marked smoothed, reprojected, and still have no method');
    check(a.every(r => r.vsResolve > 0.05), `A. the overlay is not a re-solve of the 2D (px ${fmt(a)})`);
    check(a.every(r => r.vsStored < 1e-6), `A. the overlay draws the smoothed 3D, not a re-solve (px ${fmt(a)})`);

    // ---- B. method set, reprojection-error threshold set ------------------------------
    await page.evaluate(async () => (await import('/ui/settings.js')).setTrackingThresholds({ reprojErrorThreshold: 50 }));
    await setup('smoothDisplayB');
    await waitStatus(/^(Triangulated|Grouped) /);
    await smooth();
    const b = await measure(MID);
    await page.evaluate(async () => (await import('/ui/settings.js')).setTrackingThresholds({ reprojErrorThreshold: 0 }));
    check(b.length === 2 && b.every(r => r.vsResolve > 0.05), `B. the overlay is not a re-solve of the 2D (px ${fmt(b)})`);
    check(b.every(r => r.vsStored < 1e-6), `B. with a threshold set the overlay still draws the smoothed 3D (px ${fmt(b)})`);

    // ---- C. one info-panel result per group -------------------------------------------
    check(a.every(r => r.results === 1) && b.every(r => r.results === 1),
        `C. one triangulation result per group on the frame (A ${JSON.stringify(a.map(r => r.results))}, B ${JSON.stringify(b.map(r => r.results))})`);

    // ---- D. re-triangulating drops the smoothed mark ----------------------------------
    await page.evaluate(() => {
        document.getElementById('statusText').textContent = '';
        document.getElementById('tbTriangulateAll').click();
    });
    await waitStatus(/^(Triangulated|Grouped) /);
    const d = await page.evaluate(async (MID) => {
        const TRI = await import('/pose/triangulation.js');
        const PD = await import('/pose/pose-data.js');
        return (TRI.getInstanceGroupsForFrame(MID) || []).map(g => PD.isPoints3dSmoothed(g.points3d));
    }, MID);
    check(d.length === 2 && d.every(m => !m), `D. Triangulate All replaces the smoothed 3D (marks ${JSON.stringify(d)})`);

    // ---- E. re-run replaces, 0 restores, the item is blue while applied --------------
    await setup('smoothDisplayE');
    await waitStatus(/^(Triangulated|Grouped) /);
    // Every group's 3D on every frame, and the two items' blue state as a user
    // sees it on opening each menu.
    const snapshot = () => page.evaluate(async (NF) => {
        const TRI = await import('/pose/triangulation.js');
        const out = [];
        for (let f = 0; f < NF; f++) (TRI.getInstanceGroupsForFrame(f) || []).forEach(g => out.push(...g.points3d));
        return out;
    }, NF);
    // [button blue, "This frame" lit], after a redraw like any frame change.
    const blue = (frame = MID) => page.evaluate(async (frame) => {
        (await import('/ui/rendering.js')).drawAllOverlays(frame);
        (await import('/ui/app-state.js')).state.currentFrame = frame;
        (await import('/ui/smoothing-button.js')).syncSmoothingButton();
        return [document.getElementById('tbSmooth').classList.contains('active'),
            document.querySelector('#smoothingDropdown [data-scope="frame"]').classList.contains('applied')];
    }, frame);
    const same = (x, y) => x.length === y.length && x.every((v, i) => (Number.isNaN(v) && Number.isNaN(y[i])) || Math.abs(v - y[i]) < 1e-9);
    const raw = await snapshot();
    check(JSON.stringify(await blue()) === '[false,false]', 'E. before smoothing, the button is not blue');
    await smooth(9);
    check(JSON.stringify(await blue()) === '[true,true]', 'E. after smoothing, the button and "This frame" are blue');
    await smooth(3);
    const nineThenThree = await snapshot();
    const msgOff = await smooth(0);
    check(/^Removed temporal smoothing from [\d,]+ poses/.test(msgOff), `E. both windows at 0 removes the smoothing ("${msgOff}")`);
    check(same(await snapshot(), raw), 'E. ...and gives back the original 3D exactly');
    check(JSON.stringify(await blue()) === '[false,false]', 'E. ...and the button is no longer blue');
    await smooth(3);
    check(same(nineThenThree, await snapshot()), 'E. window 9 then window 3 == window 3 alone (runs replace, never stack)');
    check(!same(nineThenThree, raw), 'E. precondition: window 3 changed the 3D');

    // "This frame" through its menu item: only that frame is written and lit.
    await smooth(0);
    await page.evaluate(async (MID) => {
        (await import('/ui/settings.js')).setSmoothingParams({ smoothGaussianWindow: 3 });
        (await import('/ui/app-state.js')).state.currentFrame = MID;
        document.getElementById('statusText').textContent = '';
        document.querySelector('#smoothingDropdown [data-scope="frame"]').click();
    }, MID);
    await waitStatus(/^Smoothed /);
    const msgFrame = await page.evaluate(() => document.getElementById('statusText').textContent);
    check(/^Smoothed 2 poses/.test(msgFrame), `E. "This frame" smooths the 2 poses on it ("${msgFrame}")`);
    check(JSON.stringify(await blue(MID)) === '[true,true]', 'E. ...the button is blue and "This frame" is lit there');
    check(JSON.stringify(await blue(MID + 1)) === '[true,false]', 'E. ...but not lit on the next frame');

    // Re-triangulating everything turns the button back off, with no menu opened.
    await page.evaluate(() => {
        document.getElementById('statusText').textContent = '';
        document.getElementById('tbTriangulateAll').click();
    });
    await waitStatus(/^(Triangulated|Grouped) /);
    check(JSON.stringify(await blue(MID)) === '[false,false]', 'E. Triangulate All turns the button back off');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
