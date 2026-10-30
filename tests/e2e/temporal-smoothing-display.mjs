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
 *      blue (`.active`) exactly while smoothing is applied; its menu lights
 *      only the scope last run (never both All frames and This frame);
 *      "This frame" runs one frame and is lit only where that frame is smoothed;
 *      an all-frames run shows the progress card;
 *   F. the menu's Remove smoothing is greyed out while nothing is smoothed,
 *      live once something is (but locked in Defining Plane Mode), and a
 *      real click on it gives back the original 3D exactly, leaving the
 *      smoothing settings as they were;
 *   G. a re-run with new median AND Gaussian windows replaces the last run
 *      (median 5 + Gaussian 9, then median 3 + Gaussian 5 == median 3 +
 *      Gaussian 5 alone), and right after each run the 3D view draws the
 *      current frame's new 3D (it used to be handed no groups and go blank
 *      until the next frame change);
 *   H. Remove / Restore smoothing is a toggle: Restore puts back exactly what
 *      Remove took off, with no recompute (no progress card) and the 3D view
 *      following, any number of times; after a settings change or a 3D edit
 *      it smooths again instead, matching a plain run.
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
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

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
    const removeDisabled = () => page.evaluate(() => document.getElementById('tbSmoothToggle').disabled);
    check(await removeDisabled() === true, 'F. before smoothing, Remove smoothing is greyed out');
    // Watch the progress card while an all-frames run goes (the pass is tiny
    // here, so record what the card showed rather than racing it).
    await page.evaluate(() => {
        window.__smoothCard = [];
        const ov = document.getElementById('loadingOverlay');
        new MutationObserver(() => {
            if (!ov.classList.contains('hidden')) {
                window.__smoothCard.push((document.getElementById('loadingStatus') || {}).textContent || '');
            }
        }).observe(ov, { attributes: true, subtree: true, childList: true, characterData: true });
    });
    await smooth(9);
    const card = await page.evaluate(() => ({
        seen: window.__smoothCard,
        hidden: document.getElementById('loadingOverlay').classList.contains('hidden'),
    }));
    check(card.seen.some(t => /^Smoothing: [\d,]+\/[\d,]+ poses/.test(t)) && card.hidden,
        `E. all frames shows the progress card in poses, and closes it (${JSON.stringify(card.seen.slice(0, 2))})`);
    check(JSON.stringify(await blue()) === '[true,false]', 'E. after smoothing all frames, the button is blue and "This frame" is NOT lit');
    const allLit = await page.evaluate(() => document.querySelector('#smoothingDropdown [data-scope="all"]').classList.contains('applied'));
    check(allLit, 'E. ...only "All frames" is');
    await smooth(3);
    const nineThenThree = await snapshot();
    const msgOff = await smooth(0);
    check(/^Removed temporal smoothing from [\d,]+ poses/.test(msgOff), `E. both windows at 0 removes the smoothing ("${msgOff}")`);
    check(same(await snapshot(), raw), 'E. ...and gives back the original 3D exactly');
    check(JSON.stringify(await blue()) === '[false,false]', 'E. ...and the button is no longer blue');
    await smooth(3);
    check(same(nineThenThree, await snapshot()), 'E. window 9 then window 3 == window 3 alone (runs replace, never stack)');
    check(!same(nineThenThree, raw), 'E. precondition: window 3 changed the 3D');

    // Remove smoothing, through the menu with the real mouse.
    await blue();
    check(await removeDisabled() === false, 'F. with smoothing applied, Remove smoothing is live');
    const planeLock = (on) => page.evaluate(async ({ on, MID }) => {
        const PD = await import('/ui/plane-definition.js');
        PD.planeState.active = on;
        (await import('/ui/rendering.js')).drawAllOverlays(MID);
        PD.applyPlaneModeToolbarLock();
        (await import('/ui/smoothing-button.js')).syncSmoothingButton();
        return document.getElementById('tbSmoothToggle').disabled;
    }, { on, MID });
    check(await planeLock(true) === true, 'F. Defining Plane Mode locks Remove smoothing');
    check(await planeLock(false) === false, 'F. ...and leaving it makes it live again');
    await page.evaluate(() => { document.getElementById('statusText').textContent = ''; });
    await page.hover('#tbSmooth');
    await page.waitForTimeout(200);
    await page.click('#tbSmoothToggle');
    await waitStatus(/^Removed /);
    const msgRemove = await page.evaluate(() => document.getElementById('statusText').textContent);
    check(/^Removed temporal smoothing from [\d,]+ poses/.test(msgRemove), `F. Remove smoothing removes it ("${msgRemove}")`);
    check(same(await snapshot(), raw), 'F. ...and gives back the original 3D exactly');
    check(JSON.stringify(await blue()) === '[false,false]', 'F. ...the button is no longer blue');
    const after = await page.evaluate(() => {
        const b = document.getElementById('tbSmoothToggle');
        return { label: b.textContent.trim(), disabled: b.disabled };
    });
    check(after.label === 'Restore smoothing' && !after.disabled, `F. ...and the item now reads Restore smoothing (${JSON.stringify(after)})`);
    const keptWindow = await page.evaluate(async () =>
        (await import('/ui/settings.js')).getSmoothingParams().smoothGaussianWindow);
    check(keptWindow === 3, `F. the smoothing settings are left as they were (Gaussian ${keptWindow})`);
    await page.mouse.move(700, 600);

    // G. Re-runs with new median + Gaussian windows, and the 3D view after each.
    const smoothMG = async (med, gau) => {
        await page.evaluate(async ({ MID, med, gau }) => {
            (await import('/ui/settings.js')).setSmoothingParams({ smoothMedianWindow: med, smoothGaussianWindow: gau });
            (await import('/ui/app-state.js')).state.currentFrame = MID;
            document.getElementById('statusText').textContent = '';
            document.getElementById('tbSmooth').click();
        }, { MID, med, gau });
        await waitStatus(/^Smoothed /);
    };
    // Max |marker - stored 3D| over the current frame's nodes (Infinity if the
    // marker count differs), read with no redraw: what the run left on screen.
    const view3d = () => page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const TRI = await import('/pose/triangulation.js');
        const v = window.__lucid.viewport3d;
        if (!v || !v._skeletonGroup) return { n: 0, want: -1, off: Infinity };
        const key = p => p.join(',');
        const pos = [];
        v._skeletonGroup.children.forEach(ig => ig.children.forEach(n => {
            if (n.name && n.name.startsWith('node_')) pos.push([n.position.x, n.position.y, n.position.z]);
        }));
        const want = [];
        (TRI.getInstanceGroupsForFrame(AS.state.currentFrame) || []).forEach(g => {
            for (let i = 0; i + 2 < g.points3d.length; i += 3) {
                const p = [g.points3d[i], g.points3d[i + 1], g.points3d[i + 2]];
                if (p.every(Number.isFinite)) want.push(p);
            }
        });
        pos.sort((a, b) => key(a) < key(b) ? -1 : 1);
        want.sort((a, b) => key(a) < key(b) ? -1 : 1);
        const off = pos.length !== want.length ? Infinity
            : Math.max(0, ...pos.map((p, i) => Math.max(...p.map((c, j) => Math.abs(c - want[i][j])))));
        return { n: pos.length, want: want.length, off };
    });
    await smoothMG(3, 5);
    const mgAlone = await snapshot();
    await smoothMG(5, 9);
    let v3 = await view3d();
    check(v3.n > 0 && v3.off === 0, `G. right after a run the 3D view draws its 3D (${v3.n}/${v3.want} markers, off by ${v3.off})`);
    await smoothMG(3, 5);
    check(same(await snapshot(), mgAlone), 'G. median 5 + Gaussian 9, then median 3 + Gaussian 5 == median 3 + Gaussian 5 alone');
    v3 = await view3d();
    check(v3.n > 0 && v3.off === 0, `G. ...and the 3D view follows the re-run (${v3.n}/${v3.want} markers, off by ${v3.off})`);

    // H. Remove / Restore smoothing as a toggle, with the real mouse.
    const toggleItem = () => page.evaluate(() => {
        const b = document.getElementById('tbSmoothToggle');
        return b.textContent.trim() + (b.disabled ? ' (disabled)' : '');
    });
    const clickToggle = async () => {
        await page.evaluate(() => { window.__smoothCard = []; document.getElementById('statusText').textContent = ''; });
        await page.hover('#tbSmooth');
        await page.waitForTimeout(150);
        await page.click('#tbSmoothToggle');
        await waitStatus(/^(Removed|Restored|Smoothed) /);
        await page.mouse.move(700, 600);
        return page.evaluate(() => ({ msg: document.getElementById('statusText').textContent, card: window.__smoothCard.length }));
    };
    const stepTo = (f) => page.evaluate(async (f) => (await import('/pose/initialization.js')).navigateToFrame(f), f);
    await smoothMG(5, 9);
    const sm59 = await snapshot();
    check(await toggleItem() === 'Remove smoothing', 'H. smoothed: the item reads Remove smoothing');
    for (let round = 1; round <= 3; round++) {
        let r = await clickToggle();
        check(/^Removed temporal smoothing from [\d,]+ poses$/.test(r.msg) && same(await snapshot(), raw) &&
            await toggleItem() === 'Restore smoothing',
            `H. round ${round}: Remove gives the original 3D and the item reads Restore smoothing ("${r.msg}")`);
        await stepTo(MID + 3);   // moving around changes nothing it depends on
        await stepTo(MID);
        r = await clickToggle();
        check(/^Restored temporal smoothing on [\d,]+ poses$/.test(r.msg) && r.card === 0,
            `H. round ${round}: Restore puts it back without recomputing ("${r.msg}", progress card shown ${r.card} times)`);
        check(same(await snapshot(), sm59), `H. round ${round}: ...exactly the smoothing that was removed`);
        const vr = await view3d();
        check(await toggleItem() === 'Remove smoothing' && JSON.stringify(await blue()) === '[true,false]' && vr.n > 0 && vr.off === 0,
            `H. round ${round}: ...the button is blue, the item reads Remove smoothing, the 3D view shows it (${vr.n} markers, off ${vr.off})`);
    }

    // New settings since Remove: Restore smooths again with them.
    await clickToggle();
    await page.evaluate(async () => (await import('/ui/settings.js'))
        .setSmoothingParams({ smoothMedianWindow: 3, smoothGaussianWindow: 5 }));
    let rs = await clickToggle();
    check(/^Smoothed [\d,]+ poses .*\(median 3 \+ Gaussian 5\) — recomputed/.test(rs.msg) && rs.card > 0,
        `H. after a settings change, Restore recomputes with the new settings ("${rs.msg}", progress card shown ${rs.card} times)`);
    check(same(await snapshot(), mgAlone), 'H. ...giving what median 3 + Gaussian 5 gives on its own');
    let vr = await view3d();
    check(vr.n > 0 && vr.off === 0, `H. ...and the 3D view shows it (${vr.n} markers, off ${vr.off})`);

    // A 3D edit since Remove: Restore smooths the edited 3D.
    await clickToggle();
    const nudge = (d) => page.evaluate(async ({ MID, d }) => {
        const TRI = await import('/pose/triangulation.js');
        TRI.getInstanceGroupsForFrame(MID)[0].points3d[0] += d;
    }, { MID, d });
    await nudge(5);
    const rawEdited = await snapshot();
    rs = await clickToggle();
    check(/ — recomputed/.test(rs.msg), `H. after a 3D edit, Restore recomputes ("${rs.msg}")`);
    const restoredEdited = await snapshot();
    await smoothMG(3, 5);
    check(same(restoredEdited, await snapshot()), 'H. ...matching a plain run on the edited 3D');
    await clickToggle();
    check(same(await snapshot(), rawEdited), 'H. ...and Remove then gives back the edited 3D');
    await nudge(-5);
    check(same(await snapshot(), raw), 'H. (edit undone)');

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
