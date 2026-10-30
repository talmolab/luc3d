/**
 * zoom-survives-pane-rebuild.mjs — a view's zoom and pan survive the dock
 * rebuilding its pane: grid → solo, cycling the solo camera, and solo → grid.
 *
 * Every one of those is a full `clearAll()` + rebuild, so each view comes back
 * on a brand-new canvas in a brand-new cell. The zoom lives on the VIEW, not
 * the pane, and the rebuild is just a resize of the box it is drawn in — so it
 * is held to the same rule as a resize (`reapplyZoom`): the same magnification
 * and the same region of the video in the middle of the cell.
 *
 * Asserted one rebuild AND several frames later, because that is where it used
 * to break: `setGridMode` / `updateVideoGridDisplay` saved and restored every
 * view's zoom around the rebuild, but each new pane's `init` schedules
 * `refreshPaneInteractions()` for the next frame, and that called `initZoom`
 * on every view unconditionally — so one frame after the restore every view
 * was back at fit. The restore was dead code.
 *
 * Checked in video pixels, through the app's own click mapping
 * (`canvasToVideo`), not in pan offsets: the offsets are in the cell's CSS px
 * and MUST change when the cell does — a zoom that kept its raw offsets in a
 * twice-as-big cell would show a different part of the video.
 *
 * Also: a view hidden while another is solo'd keeps its zoom, a view never
 * zoomed comes back fitted, the zoom badge follows the zoom onto the new
 * cell, and a brand-new view still gets a zoom state.
 *
 * Negative controls, each confirmed to fail this file:
 *   - `initZoom` unconditional in `refreshPaneInteractions` (the old code):
 *     the scale is right in the same task as the rebuild and back at 1 a
 *     frame later — 16 checks red.
 *   - the old save/restore loops left in `setGridMode` /
 *     `updateVideoGridDisplay` on top of the fix: the scale survives but the
 *     old cell's pan offsets are written over the rescaled ones, so solo
 *     shows a different region — 3 red.
 *   - no `reapplyZoom` in `refreshPaneInteractions` (only the ResizeObserver's
 *     frame-later one): the new cell's first paint is fitted — 1 red.
 *   - no join (a view coming on screen keeps its zoom while Native Resolution
 *     is on): §7 — 3 red.
 *   - no `nativeResolutionActive()` after the rebuild: the solo'd 1:1 view does
 *     not turn the mode on until something else re-derives it — §7b, 2 red.
 *
 * The video is smaller than a grid cell, so its 1:1 scale is below fit and
 * zooming in from fit never snaps to it: sections 1–6 test the kept zoom, not
 * the View ▸ Native Resolution snap.
 *
 * §7 is the one exception to keeping a view's zoom: while Native Resolution
 * is on, a camera coming on screen joins it at 1:1 — even one with a zoom of
 * its own — and the mode is re-derived after every rebuild, so whether the
 * next camera joins does not depend on whether the View menu (which also
 * re-derives it) happened to be opened in between.
 *
 * Run: node tests/e2e/zoom-survives-pane-rebuild.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8317);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fmt = (p) => p ? `(${p[0].toFixed(1)}, ${p[1].toFixed(1)})` : String(p);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;   // absent demo assets
        console.log('  [console.error]', t.slice(0, 300));
        fails++;
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    // Let the page's own startup layout finish first. A grid built inside it
    // can come out lopsided (columns of 461 and 100 px instead of 280/281),
    // which would quietly change every cell this test measures.
    await page.waitForTimeout(600);

    const CAMS = ['camA', 'camB', 'camC', 'camD'];
    // Smaller than a grid cell (281 css px), so a view's native (1:1) scale is
    // BELOW fit at every devicePixelRatio >= 1 and zooming in from fit never
    // passes through it — a build that snaps zooms to 1:1 must not turn this
    // into a test of the snap.
    const W = 240, H = 180, CX = W / 2, CY = H / 2;

    await page.evaluate(async ([camNames, W, H]) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Skeleton, Camera, Session } = pd;
        const K = [[600, 0, W / 2], [0, 600, H / 2], [0, 0, 1]];
        const cams = camNames.map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [W, H]));
        const session = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], 'Z');
        AS.state.sessions = [session];
        AS.state.session = session;
        AS.state.activeSessionIdx = 0;
        AS.state.totalFrames = 10;
        AS.state.currentFrame = 0;
        AS.state.fps = 30;
        AS.state.isPlaying = false;
        AS.state.triangulationResults = new Map();
        // A stub decoder that never yields a frame: the seek every rebuild ends
        // in must not throw, and nothing here needs pixels.
        const decoder = { getFrame: () => Promise.resolve(null), releaseFrames() {} };
        AS.state.views = cams.map(c => ({ name: c.name, videoWidth: W, videoHeight: H, canvas: null, decoder }));
        AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name }));
        AS.state.viewMode = 'grid';
        AS.state.singleViewIndex = 0;
        AS.paneManager.clearAll();
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
        await new Promise(r => requestAnimationFrame(r));
        sp.refreshPaneInteractions();
        await new Promise(r => requestAnimationFrame(r));
    }, [CAMS, W, H]);

    /** Let every frame-later callback run: the panes' rAF refresh AND the
     *  ResizeObserver's rAF reapply. */
    const settle = async () => {
        for (let i = 0; i < 4; i++) await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
        await page.waitForTimeout(150);
        for (let i = 0; i < 2; i++) await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
    };

    /** Zoom state of `name`, and the video pixel at its cell's centre (null
     *  when the view is not on screen). */
    const look = (name) => page.evaluate(async (name) => {
        const AS = await import('/ui/app-state.js');
        const v = AS.state.views.find(x => x.name === name);
        const z = v.zoom ? { scale: v.zoom.scale, offsetX: v.zoom.offsetX, offsetY: v.zoom.offsetY } : null;
        const shown = !!(v.canvas && v.canvas.isConnected);
        if (!shown) return { z, shown };
        const cell = v.canvas.closest('.video-cell');
        const c = cell.getBoundingClientRect();
        const centre = AS.interactionManager.canvasToVideo(c.left + c.width / 2, c.top + c.height / 2, name);
        // The zoom badge, as SEEN: it (or the `.zoom-badge` holding it and its
        // preset menu) is display:none at fit, so ask for rendered boxes
        // rather than reading one element's inline style.
        const badge = cell.querySelector('.unzoom-btn');
        const r = v.overlayCanvas.getBoundingClientRect();
        return {
            z, shown, centre,
            cell: [c.width, c.height],
            // On-screen width of the whole video, as a multiple of the fitted box.
            mag: r.width / parseFloat(v.canvas.style.width),
            badge: !!(badge && badge.getClientRects().length > 0),
            zoomedClass: cell.classList.contains('zoomed'),
        };
    }, name);

    const docked = () => page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        return Array.from(AS.paneManager.api.panels)
            .map(p => sp.panelRenderers.get(p.id)).filter(Boolean).map(r => r.getViewName());
    });

    // ── 0. Precondition: every view docked, every view given a zoom state ──
    console.log('\n0. Setup');
    check((await docked()).length === 4, 'grid docks all 4 views');
    const widths = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        return AS.state.views.map(v => v.canvas.closest('.video-cell').clientWidth);
    });
    check(Math.max(...widths) - Math.min(...widths) <= 2, `the grid's columns are even (cell widths ${widths})`);
    for (const n of CAMS) {
        const s = await look(n);
        check(s.z && s.z.scale === 1 && s.z.offsetX === 0 && s.z.offsetY === 0,
            `${n} starts with a fitted zoom state (got ${JSON.stringify(s.z)})`);
    }

    // ── 1. Zoom two views in the grid and PAN each with a real middle-button
    //       drag (`setupZoomHandlers`), to a chosen point of the video at the
    //       cell centre — so there is a pan to keep, not just a scale. The
    //       points are inside the range where neither the grid cell nor the
    //       bigger solo cell clamps the pan at a picture edge: a clamp moves
    //       the centre on its own, and this is not a test of the clamp. ──
    console.log('\n1. Zoom and pan camB and camD in the grid');
    const zoomAndPan = async (name, factor, fu, fv) => {
        // The drag that puts video fraction (fu, fv) at the cell centre:
        // on screen it sits at flex + offset + fu * box * scale (unrotated).
        const plan = await page.evaluate(async ([name, factor, fu, fv]) => {
            const AS = await import('/ui/app-state.js');
            const v = AS.state.views.find(x => x.name === name);
            AS.videoController.zoomVideo(v, factor);
            const cell = v.canvas.closest('.video-cell');
            const bw = parseFloat(v.canvas.style.width), bh = parseFloat(v.canvas.style.height);
            const flexX = (cell.clientWidth - bw) / 2, flexY = (cell.clientHeight - bh) / 2;
            const wantX = cell.clientWidth / 2 - flexX - fu * bw * v.zoom.scale;
            const wantY = cell.clientHeight / 2 - flexY - fv * bh * v.zoom.scale;
            const c = cell.getBoundingClientRect();
            return { dx: wantX - v.zoom.offsetX, dy: wantY - v.zoom.offsetY,
                     x: c.left + c.width / 2, y: c.top + c.height / 2 };
        }, [name, factor, fu, fv]);
        await page.mouse.move(plan.x, plan.y);
        await page.mouse.down({ button: 'middle' });
        await page.mouse.move(plan.x + plan.dx / 2, plan.y + plan.dy / 2);
        await page.mouse.move(plan.x + plan.dx, plan.y + plan.dy);
        await page.mouse.up({ button: 'middle' });
    };
    await zoomAndPan('camB', 2.5, 0.40, 0.42);
    await zoomAndPan('camD', 1.8, 0.58, 0.56);
    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        AS.interactionManager.lastInteractedView = 'camB';
    });
    await settle();
    // How far the zoomed picture reaches past the cell on its tightest side.
    const overhang = (name) => page.evaluate(async (name) => {
        const AS = await import('/ui/app-state.js');
        const v = AS.state.views.find(x => x.name === name);
        const c = v.canvas.closest('.video-cell').getBoundingClientRect();
        const r = v.overlayCanvas.getBoundingClientRect();
        return Math.min(c.left - r.left, r.right - c.right, c.top - r.top, r.bottom - c.bottom);
    }, name);
    const gridB = await look('camB');
    const gridD = await look('camD');
    const gridA = await look('camA');
    check(near(gridB.z.scale, 2.5, 1e-9), `camB is at 2.5x (got ${gridB.z.scale})`);
    check(near(gridD.z.scale, 1.8, 1e-9), `camD is at 1.8x (got ${gridD.z.scale})`);
    // The pan is real: the centre pixel is well off the video's own centre.
    check(Math.hypot(gridB.centre[0] - CX, gridB.centre[1] - CY) > W * 0.1,
        `camB is panned off-centre (centre pixel ${fmt(gridB.centre)})`);
    check(Math.hypot(gridD.centre[0] - CX, gridD.centre[1] - CY) > W * 0.06,
        `camD is panned off-centre (centre pixel ${fmt(gridD.centre)})`);
    const ohB = await overhang('camB'), ohD = await overhang('camD');
    check(ohB > 5 && ohD > 5,
        `neither pan is clamped at a picture edge (overhang ${ohB.toFixed(1)} / ${ohD.toFixed(1)} css px)`);
    check(gridB.badge && gridB.zoomedClass, 'camB shows the zoom badge');
    check(near(gridA.centre[0], CX, 1.5) && near(gridA.centre[1], CY, 1.5) && gridA.z.scale === 1,
        `camA (never zoomed) is fitted, centred on ${fmt(gridA.centre)}`);

    // ── 2. Grid → solo on the zoomed view ──
    console.log('\n2. Grid → solo (enterSingleViewMode) on camB');
    // Read back in the SAME task as the rebuild too, before any frame: the old
    // save/restore did put the scale back there, and lost it one frame later.
    // And the new cell must be drawn zoomed from its first paint, not at fit
    // until the ResizeObserver's frame-later `reapplyZoom` catches up.
    const sync = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const UW = await import('/ui/ui-wiring.js');
        UW.enterSingleViewMode();
        const v = AS.state.views.find(x => x.name === 'camB');
        const c = v.canvas.closest('.video-cell').getBoundingClientRect();
        return {
            scale: v.zoom.scale,
            centre: AS.interactionManager.canvasToVideo(c.left + c.width / 2, c.top + c.height / 2, 'camB'),
        };
    });
    check(near(sync.scale, 2.5, 1e-9), `camB is at 2.5x right after the rebuild (got ${sync.scale})`);
    check(near(sync.centre[0], gridB.centre[0], 1.5) && near(sync.centre[1], gridB.centre[1], 1.5),
        `…and the new cell already shows the zoomed region, before any frame (${fmt(sync.centre)})`);
    await settle();
    check((await docked()).join() === 'camB', `solo shows camB alone (got [${await docked()}])`);
    const soloB = await look('camB');
    check(soloB.cell[0] > gridB.cell[0] * 1.3,
        `the solo cell is bigger than the grid one (${soloB.cell[0].toFixed(0)} vs ${gridB.cell[0].toFixed(0)} px), so this is a real resize`);
    check(soloB.z && near(soloB.z.scale, 2.5, 1e-9),
        `camB is still at 2.5x a frame later (got ${soloB.z && soloB.z.scale})`);
    check(near(soloB.mag, 2.5, 0.02), `…and draws at 2.5x its fitted box (got ${soloB.mag.toFixed(3)})`);
    check(near(soloB.centre[0], gridB.centre[0], 1.5) && near(soloB.centre[1], gridB.centre[1], 1.5),
        `the same video pixel is at the cell centre: ${fmt(soloB.centre)} vs ${fmt(gridB.centre)} in the grid`);
    check(soloB.badge && soloB.zoomedClass, 'the new cell shows the zoom badge');
    const hiddenD = await look('camD');
    check(!hiddenD.shown && hiddenD.z && near(hiddenD.z.scale, 1.8, 1e-9),
        `camD, hidden while camB is solo'd, keeps its 1.8x (got ${hiddenD.z && hiddenD.z.scale})`);

    // ── 3. Cycle the solo view away and back ──
    console.log('\n3. Cycle the solo camera: camB → camC → camB');
    await page.evaluate(async () => {
        const UW = await import('/ui/ui-wiring.js');
        UW.cycleSingleView(+1);
    });
    await settle();
    check((await docked()).join() === 'camC', `solo now shows camC (got [${await docked()}])`);
    const soloC = await look('camC');
    check(soloC.z.scale === 1 && near(soloC.centre[0], CX, 1.5) && near(soloC.centre[1], CY, 1.5)
        && !soloC.badge,
        `camC (never zoomed) comes up fitted, no badge (scale ${soloC.z.scale}, centre ${fmt(soloC.centre)})`);
    await page.evaluate(async () => {
        const UW = await import('/ui/ui-wiring.js');
        UW.cycleSingleView(-1);
    });
    await settle();
    const soloB2 = await look('camB');
    check(soloB2.shown && near(soloB2.z.scale, 2.5, 1e-9)
        && near(soloB2.centre[0], gridB.centre[0], 1.5) && near(soloB2.centre[1], gridB.centre[1], 1.5),
        `back on camB: still 2.5x on ${fmt(soloB2.centre)}`);

    // ── 4. Solo → grid ──
    console.log('\n4. Solo → grid (setGridMode)');
    await page.evaluate(async () => {
        const UW = await import('/ui/ui-wiring.js');
        UW.setGridMode();
    });
    await settle();
    check((await docked()).length === 4, 'the grid is back with all 4 views');
    const backB = await look('camB');
    const backD = await look('camD');
    const backA = await look('camA');
    check(near(backB.z.scale, 2.5, 1e-9) && near(backB.mag, 2.5, 0.02),
        `camB is still at 2.5x (scale ${backB.z.scale}, drawn ${backB.mag.toFixed(3)}x)`);
    check(near(backB.centre[0], gridB.centre[0], 1.5) && near(backB.centre[1], gridB.centre[1], 1.5),
        `camB shows the same region it did before: ${fmt(backB.centre)} vs ${fmt(gridB.centre)}`);
    // Same cell size as before solo, so the round trip lands on the same pan.
    check(near(backB.z.offsetX, gridB.z.offsetX, 1) && near(backB.z.offsetY, gridB.z.offsetY, 1),
        `camB's pan is back where it was (${backB.z.offsetX.toFixed(1)}, ${backB.z.offsetY.toFixed(1)}) `
        + `vs (${gridB.z.offsetX.toFixed(1)}, ${gridB.z.offsetY.toFixed(1)})`);
    check(near(backD.z.scale, 1.8, 1e-9)
        && near(backD.centre[0], gridD.centre[0], 1.5) && near(backD.centre[1], gridD.centre[1], 1.5),
        `camD, hidden throughout solo, is still at 1.8x on ${fmt(backD.centre)} vs ${fmt(gridD.centre)}`);
    check(backB.badge && backD.badge, 'both zoomed cells show the zoom badge');
    check(backA.z.scale === 1 && !backA.badge && near(backA.centre[0], CX, 1.5) && near(backA.centre[1], CY, 1.5),
        `camA is still fitted, no badge (centre ${fmt(backA.centre)})`);

    // ── 5. A grid rebuilt with no saved layout (updateVideoGridDisplay's grid
    //       branch) keeps it too ──
    console.log('\n5. Grid rebuilt by updateVideoGridDisplay');
    await page.evaluate(async () => {
        const UW = await import('/ui/ui-wiring.js');
        UW.updateVideoGridDisplay();
    });
    await settle();
    const rebuiltB = await look('camB');
    check(near(rebuiltB.z.scale, 2.5, 1e-9)
        && near(rebuiltB.centre[0], gridB.centre[0], 1.5) && near(rebuiltB.centre[1], gridB.centre[1], 1.5),
        `camB keeps 2.5x on ${fmt(rebuiltB.centre)}`);

    // ── 6. Reset still resets: the zoom is kept because it is the user's, and
    //       `0` is how they take it back ──
    console.log('\n6. Reset All Zoom, then a rebuild');
    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        AS.videoController.resetAllZoom();
        AS.interactionManager.lastInteractedView = 'camB';
        const UW = await import('/ui/ui-wiring.js');
        UW.enterSingleViewMode();
    });
    await settle();
    const resetB = await look('camB');
    check(resetB.shown && resetB.z.scale === 1 && !resetB.badge
        && near(resetB.centre[0], CX, 1.5) && near(resetB.centre[1], CY, 1.5),
        `after a reset camB comes up fitted in solo (scale ${resetB.z.scale}, centre ${fmt(resetB.centre)})`);

    // ── 7. View ▸ Native Resolution: while it is on, a camera coming on screen
    //       joins it at 1:1 instead of keeping its own zoom ──
    console.log('\n7. Native Resolution: a camera coming on screen joins 1:1');
    /** Native state of `name` (raw `state.nativeResolution`: reading it must
     *  not re-derive it, which is the thing under test in 7b). */
    const nat = (name) => page.evaluate(async (name) => {
        const AS = await import('/ui/app-state.js');
        const v = AS.state.views.find(x => x.name === name);
        const shown = !!(v.canvas && v.canvas.isConnected);
        const n = shown ? AS.videoController.nativeZoomScales(v) : null;
        return {
            shown, native: !!v.zoom.native, scale: v.zoom.scale, natX: n ? n.x : null,
            mode: !!AS.state.nativeResolution,
            // On-screen width of the whole video: its own width at 1:1 (dpr 1).
            width: shown ? v.overlayCanvas.getBoundingClientRect().width : null,
        };
    }, name);
    const zoomBy = (name, factor) => page.evaluate(async ([name, factor]) => {
        const AS = await import('/ui/app-state.js');
        const v = AS.state.views.find(x => x.name === name);
        return AS.videoController.zoomVideo(v, factor);
    }, [name, factor]);
    const ui = (fn, arg) => page.evaluate(async ([fn, arg]) => {
        const AS = await import('/ui/app-state.js');
        const UW = await import('/ui/ui-wiring.js');
        if (arg) AS.interactionManager.lastInteractedView = arg;
        if (fn === 'off') AS.videoController.setNativeResolution(false);
        else if (fn === 'cycle') UW.cycleSingleView(+1);
        else UW[fn]();
    }, [fn, arg]);

    // 7a — camC has a zoom of its own; the solo view snaps to 1:1 (which turns
    // the mode on); cycling to camC brings it up at 1:1, not at its own 1.6x.
    await ui('setGridMode');
    await settle();
    await zoomBy('camC', 1.6);
    let c = await nat('camC');
    check(near(c.scale, 1.6, 1e-9) && !c.native && !c.mode, `camC has its own 1.6x, the mode is off`);
    await ui('enterSingleViewMode', 'camB');
    await settle();
    const snapped = await zoomBy('camB', 0.3);
    let b = await nat('camB');
    check(snapped && b.native && b.mode && near(b.width, W, 0.5),
        `zooming solo camB out snaps it to 1:1 (${b.width.toFixed(1)} css px for a ${W} px video) and turns the mode on`);
    await ui('cycle');
    await settle();
    c = await nat('camC');
    check(c.shown && c.native && c.scale === c.natX && near(c.width, W, 0.5) && c.mode,
        `cycling to camC brings it up at 1:1 (scale ${c.scale.toFixed(3)}, ${c.width.toFixed(1)} css px), not its own 1.6x`);
    await ui('off');
    await settle();
    c = await nat('camC');
    check(!c.native && c.scale === 1 && !c.mode, 'turning the mode off fits camC');

    // 7b — in the grid one view at 1:1 is not the mode (the others are not),
    // so nothing else moves. Solo'd, it is the only view shown, so the mode is
    // on — and must be on after the rebuild by itself, not only once the View
    // menu has re-derived it, or the next camera would keep its own zoom.
    await ui('setGridMode');
    await settle();
    await zoomBy('camD', 0.3);
    const d = await nat('camD'), a = await nat('camA');
    check(d.native && !d.mode && !a.native && a.scale === 1,
        `in the grid, camD alone at 1:1 leaves the mode off and camA fitted`);
    await ui('enterSingleViewMode', 'camD');
    await settle();
    const d2 = await nat('camD');
    check(d2.shown && d2.native && d2.scale === d2.natX && d2.mode,
        `solo camD: still 1:1 for the bigger cell, and the mode is on without opening the View menu`);
    await ui('cycle');
    await settle();
    const a2 = await nat('camA');
    check(a2.shown && a2.native && a2.scale === a2.natX && a2.mode,
        `so cycling to camA brings it up at 1:1 too (scale ${a2.scale.toFixed(3)})`);
    await ui('off');
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll checks passed.');
process.exit(fails ? 1 : 0);
