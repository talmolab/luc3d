/**
 * reopen-reprojects-stored-3d.mjs — the display draws the 3D the project HOLDS,
 * never a re-solve of it.
 *
 * ## The bug
 * A saved project stores 3D but not reprojections or errors. On reopen (and
 * after the windowed Triangulate All, which drops them) two display paths derive
 * them: `ui/rendering.js`'s lazy fill (overlay, per-node errors, Info Panel) and
 * `ui/overlay-export-modal.js`'s `ensureReprojections` (the exported video).
 * Both RE-SOLVED each group with `triangulateAndReproject` and kept the file's
 * 3D. That was harmless while a re-solve reproduced the stored 3D exactly; once
 * the reprojection error threshold defaulted to 50 px, a project solved at 0
 * re-solved to a DIFFERENT 3D in every group with an outlier view, so the
 * overlay, the panel and the exported video described a 3D that was not the one
 * in the 3D view or the saved file (found in review of PR #289: 173 of 500
 * synthetic groups, up to 80 mm on a node). Both now call
 * `reprojectStoredPoints3d`.
 *
 * ## What this pins, in the real app
 *   - Precondition: the setting is at its 50 px default, and the fixture's 3D
 *     was solved at 0 — the "project solved before the new default" case.
 *   - Negative control: the old fill's own call, on this fixture, re-solves to
 *     different reprojections in a good share of groups. Without that, every
 *     check below would pass on the broken build.
 *   - The main window (`drawAllOverlays`): every group's reprojections are
 *     exactly its stored 3D's, the errors written to
 *     `state.triangulationResults` are that 3D's errors, the Info Panel headline
 *     agrees, and the stored 3D is untouched.
 *   - The overlay export: opening Export Video Overlays on a frame the main
 *     window never drew fills it with the stored 3D's reprojections — and
 *     `state.triangulationResults` stays empty there, which proves it was the
 *     export's fill, not the main window's, that did it.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8139);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // ---- fixture: 4 cameras, 20 frames x 5 groups, solved at threshold 0 ----
    const setup = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const TRI = await import('/pose/triangulation.js');
        const S = await import('/ui/settings.js');

        let seed = 289;
        const u = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        const gauss = () => { let a = 0; for (let i = 0; i < 6; i++) a += u(); return a - 3; };

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const RIG = [
            ['camA', [0.05, 0, 0], [2, 1, 0]],
            ['camB', [0, 0.4, 0], [20, 0, 0]],
            ['camC', [0.2, 0, 0], [0, 15, 0]],
            ['camD', [0.1, -0.35, 0], [-18, 4, 0]],
        ];
        const cams = RIG.map(r => new pd.Camera(r[0], K, [-0.08, 0.01, 0.0002, 0.0002, 0], r[1], r[2], [640, 480]));
        const NODES = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
        const skel = new pd.Skeleton('sk', NODES, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]);
        const session = new pd.Session(cams, skel, ['t0'], 'ReprojectStored');

        const NF = 20, PER = 5;
        let gid = 0, withOutlier = 0;
        for (let f = 0; f < NF; f++) {
            const fg = new pd.FrameGroup(f);
            session.addFrameGroup(fg);
            const groups = [];
            for (let i = 0; i < PER; i++) {
                const g = new pd.InstanceGroup(gid++, i);
                const truth = NODES.map(() => [(u() - 0.5) * 24, (u() - 0.5) * 24, 35 + u() * 20]);
                const outlierCam = (gid % 2 === 0) ? gid % cams.length : -1;
                if (outlierCam >= 0) withOutlier++;
                cams.forEach((c, ci) => {
                    const pts = truth.map(p => { const q = c.distortPoint(c.project(p)); return [q[0] + gauss() * 1.5, q[1] + gauss() * 1.5]; });
                    if (ci === outlierCam) {
                        const k = gid % NODES.length, d = 60 + 90 * u();
                        pts[k] = [pts[k][0] + d * 0.8, pts[k][1] - d * 0.6];
                    }
                    const inst = new pd.Instance(pts, i, 'user', 1);
                    g.addInstance(c.name, inst);
                    fg.addInstance(c.name, inst);
                });
                // The project as an older build saved it: 3D solved with NO
                // threshold, and no reprojections (a file does not store them).
                const r = TRI.triangulateAndReproject(g, cams, { method: 'dlt', reprojErrorThreshold: 0 });
                g.points3d = r.points3d;
                g.triangulationMethod = 'dlt';
                groups.push(g);
            }
            session.instanceGroups.set(f, groups);
        }

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = NF;
        AS.state.currentFrame = 0;
        AS.state.fps = 30;
        AS.state.views = [];
        AS.state.triangulationResults = new Map();

        // Negative control: what the old fill computed — `triangulateAndReproject`
        // with the group's method and the threshold left to the setting.
        let wouldMove = 0, total = 0;
        for (const [, groups] of session.instanceGroups) {
            for (const g of groups) {
                total++;
                const old = TRI.triangulateAndReproject(g, cams, { method: 'dlt' });
                const moved = cams.some(c => {
                    const a = old.reprojections[c.name], b = TRI.reprojectPointsCamera(g.points3d, c);
                    return a.some((p, k) => (p == null) !== (b[k] == null) ||
                        (p && (p[0] !== b[k][0] || p[1] !== b[k][1])));
                });
                if (moved) wouldMove++;
            }
        }
        return { threshold: S.getTrackingThreshold('reprojErrorThreshold'), NF, total, withOutlier, wouldMove };
    });

    check(setup.threshold === 50, `the setting is at its 50 px default (got ${setup.threshold})`);
    check(setup.wouldMove >= setup.total / 5,
        `negative control: the old fill's re-solve draws a different 3D in ${setup.wouldMove}/${setup.total} groups ` +
        `(${setup.withOutlier} have an outlier view)`);

    // ---- the main window: drawAllOverlays' lazy fill -----------------------
    const main = await page.evaluate(async (NF) => {
        const AS = await import('/ui/app-state.js');
        const TRI = await import('/pose/triangulation.js');
        const RND = await import('/ui/rendering.js');
        const IP = await import('/ui/info-panel.js');
        const cams = AS.state.session.cameras;

        let groups = 0, reprojExact = 0, instancesBuilt = 0, errorsMatch = 0, pointsKept = 0, sameArray = 0;
        let worstErrDelta = 0, headlinesOk = 0, frames = 0;
        const headlines = [];
        for (let f = 0; f < NF / 2; f++) {
            const gs = TRI.getInstanceGroupsForFrame(f);
            const before = gs.map(g => Float64Array.from(g.points3d));
            AS.state.currentFrame = f;
            RND.drawAllOverlays(f);
            const results = AS.state.triangulationResults.get(f) || [];
            let tot = 0, cnt = 0;
            gs.forEach((g, gi) => {
                groups++;
                if (cams.every(c => JSON.stringify(g.reprojections[c.name]) ===
                    JSON.stringify(TRI.reprojectPointsCamera(g.points3d, c)))) reprojExact++;
                if (cams.every(c => g.reprojectedInstances && g.reprojectedInstances.get(c.name))) instancesBuilt++;
                if (before[gi].every((v, k) => Object.is(v, g.points3d[k]))) pointsKept++;
                const r = results.find(x => x.group === g);
                if (!r) return;
                if (r.points3d === g.points3d) sameArray++;
                // Independent errors of the STORED 3D against the 2D.
                let ok = true;
                for (const c of cams) {
                    const inst = g.getInstance(c.name), rep = TRI.reprojectPointsCamera(g.points3d, c);
                    for (let k = 0; k < rep.length; k++) {
                        const obs = inst.hasPoint(k) ? inst.getPoint(k) : null;
                        const want = (obs && rep[k]) ? Math.hypot(obs[0] - rep[k][0], obs[1] - rep[k][1]) : null;
                        const got = r.errors[c.name][k];
                        if ((want == null) !== (got == null)) { ok = false; continue; }
                        if (want != null) {
                            worstErrDelta = Math.max(worstErrDelta, Math.abs(want - got));
                            tot += want; cnt++;
                        }
                    }
                }
                if (ok) errorsMatch++;
            });
            // What the user reads: the Info Panel headline for this frame.
            IP.updateFrameInfo(f, gs);
            const shown = ((document.getElementById('errorDisplay') || {}).textContent || '').trim();
            const want = (tot / cnt).toFixed(2) + ' px';
            frames++;
            if (shown === want) headlinesOk++; else headlines.push(`f${f}: "${shown}" vs "${want}"`);
        }
        return { groups, reprojExact, instancesBuilt, errorsMatch, pointsKept, sameArray, worstErrDelta, headlinesOk, frames, headlines };
    }, setup.NF);

    check(main.reprojExact === main.groups,
        `main window: every group's reprojections are its STORED 3D's (${main.reprojExact}/${main.groups})`);
    check(main.instancesBuilt === main.groups, `...and every group's reprojected instances were built (${main.instancesBuilt}/${main.groups})`);
    check(main.errorsMatch === main.groups && main.worstErrDelta < 1e-9,
        `the errors in triangulationResults are the stored 3D's (${main.errorsMatch}/${main.groups}, worst Δ ${main.worstErrDelta.toExponential(1)} px)`);
    check(main.sameArray === main.groups, `...and their points3d IS the group's own array (${main.sameArray}/${main.groups})`);
    check(main.pointsKept === main.groups, `the stored 3D is untouched by the redraw (${main.pointsKept}/${main.groups})`);
    check(main.headlinesOk === main.frames,
        `the Info Panel headline is the stored 3D's mean error on every frame (${main.headlinesOk}/${main.frames})` +
        (main.headlines.length ? ' — ' + main.headlines.slice(0, 3).join('; ') : ''));

    // ---- the overlay export: ensureReprojections ---------------------------
    const FE = setup.NF - 2;   // never drawn by the main window
    const pre = await page.evaluate(async (FE) => {
        const AS = await import('/ui/app-state.js');
        const TRI = await import('/pose/triangulation.js');
        const names = AS.state.session.cameras.map(c => c.name);
        AS.state.currentFrame = FE;      // the modal previews the current frame
        AS.state.views = names.map(n => ({
            name: n, decoder: null, canvas: null, ctx: null,
            overlayCanvas: null, overlayCtx: null, videoWidth: 640, videoHeight: 480,
        }));
        const box = document.getElementById('visReprojections');
        if (box) box.checked = true;     // the export seeds its layers from the panel
        try { localStorage.removeItem('overlayExportSettings.v1'); } catch (e) { /* ignore */ }
        const gs = TRI.getInstanceGroupsForFrame(FE);
        return {
            empty: gs.every(g => !g.reprojections || Object.keys(g.reprojections).length === 0),
            noResults: !AS.state.triangulationResults.has(FE),
            reprojBox: !!(box && box.checked),
        };
    }, FE);
    check(pre.empty && pre.noResults && pre.reprojBox,
        `before export: frame ${FE + 1} has no reprojections or results, and the Reproj layer is on`);

    // Opening the modal also seeks the MAIN window to the preview frame
    // (`VideoController.seekToFrame` -> `drawAllOverlays`), and either fill may
    // get there first; once one has, the other finds the reprojections present
    // and skips. So the main window's redraw callback is disconnected while the
    // modal opens, leaving the export's fill the only one that can reach FE.
    const opened = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const cb = AS.videoController && AS.videoController.callbacks;
        window.__savedDrawOverlays = cb ? cb.drawOverlays : undefined;
        if (cb) cb.drawOverlays = null;
        document.getElementById('menuExportOverlayVideo').click();
        return { took: !!document.getElementById('ovExportOverlay'), disconnected: !!cb };
    });
    check(opened.disconnected, 'the main window\'s redraw callback is disconnected for the export check');
    opened.took = opened.took && opened.disconnected;
    check(opened.took, 'the Export Video Overlays modal opened');
    await page.waitForSelector('#ovExportOverlay', { timeout: 10000 });
    await page.waitForFunction(async (FE) => {
        const TRI = await import('/pose/triangulation.js');
        return TRI.getInstanceGroupsForFrame(FE).every(g => g.reprojections && Object.keys(g.reprojections).length > 0);
    }, FE, { timeout: 10000 }).catch(() => {});

    const exp = await page.evaluate(async (FE) => {
        const AS = await import('/ui/app-state.js');
        const TRI = await import('/pose/triangulation.js');
        const cams = AS.state.session.cameras;
        const gs = TRI.getInstanceGroupsForFrame(FE);
        return {
            groups: gs.length,
            filled: gs.filter(g => g.reprojections && Object.keys(g.reprojections).length > 0).length,
            exact: gs.filter(g => g.reprojections && cams.every(c => JSON.stringify(g.reprojections[c.name]) ===
                JSON.stringify(TRI.reprojectPointsCamera(g.points3d, c)))).length,
            noResults: !AS.state.triangulationResults.has(FE),
        };
    }, FE);
    check(exp.filled === exp.groups, `export: opening the modal filled frame ${FE + 1}'s reprojections (${exp.filled}/${exp.groups})`);
    check(exp.exact === exp.groups, `...with the STORED 3D's reprojections (${exp.exact}/${exp.groups})`);
    check(exp.noResults, '...and through the export\'s own fill: the main window\'s, which writes triangulationResults, never ran there');

    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        if (AS.videoController && AS.videoController.callbacks) AS.videoController.callbacks.drawOverlays = window.__savedDrawOverlays;
    });
    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
} catch (e) {
    console.error(e); fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
