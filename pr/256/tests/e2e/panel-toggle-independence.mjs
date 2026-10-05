/**
 * panel-toggle-independence.mjs — the `\` (3D viewport) and `I` (info panel)
 * toggles: independent sizing, and no work done for a hidden panel.
 *
 * The reported bug: hide the 3D viewport with `\`, then hide the info panel
 * with `I`, and the 3D viewport REAPPEARS in the space the info panel just
 * vacated. `toggleInfoPanel` handed the freed width to the 3D viewport as an
 * inline `style.width`, and an inline width outranks `.collapsed { width: 0 }`
 * — so the "hidden" viewport was only hidden until something else wrote a
 * width to it. A screenshot after step 2 is the only way that shows up; no
 * unit test reaches it, because the failure lives in the interaction between
 * two CSS-class toggles and one inline style.
 *
 * On top of the layout half, this pins the part that has no visual signature
 * at all: a hidden panel must stop doing its work, not just stop showing it.
 * Hiding the 3D viewport has to pause the Three.js render loop (a collapsed
 * container is still a perfectly good render target as far as WebGL is
 * concerned, so it happily rendered the full scene ~60x/second into pixels
 * nobody composites) and skip the per-frame scene rebuild; hiding the info
 * panel has to skip the reprojection-error aggregation and the instance-table
 * rebuild. Both are pure-CPU regressions — the app looks and behaves exactly
 * the same whether the gates work or not, which is precisely why they need a
 * test that reads the counters and the rAF handle rather than the screen.
 *
 * Finally it asserts the CATCH-UP, because "skip while hidden" turns into data
 * loss the moment a skipped refresh is never replayed: re-showing each panel
 * must resync it to the current frame.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8149);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 300)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // ---- A calibrated session with triangulated 3D, over several frames ----
    // Calibration (non-zero rvec/tvec) is what makes `sessionHasCalibration()`
    // true and therefore what lets the 3D viewport initialize at all; without
    // it every 3D assertion below would pass for the wrong reason.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        const K = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
        const cams = [
            new Camera('cam1', K, [0, 0, 0, 0, 0], [0.01, 0.02, 0.03], [0, 0, 500], [512, 512]),
            new Camera('cam2', K, [0, 0, 0, 0, 0], [0.04, 0.05, 0.06], [100, 0, 500], [512, 512]),
        ];
        const skel = new Skeleton('skeleton', ['nose', 'tail'], [[0, 1]]);
        const session = new Session(cams, skel, ['mouseA'], 'ToggleTest');

        const NFRAMES = 8;
        for (let f = 0; f < NFRAMES; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            const g = new InstanceGroup(f + 1, 0);
            g.addInstance('cam1', new Instance([[10 + f, 20], [30, 40 + f]], 0, 'user', 1));
            g.addInstance('cam2', new Instance([[12 + f, 22], [32, 42 + f]], 0, 'user', 1));
            for (const [cn, inst] of g.instances) fg.addInstance(cn, inst);
            // Distinct 3D per frame so a stale scene is detectable, and a
            // distinct mean error per frame so a stale panel is too.
            g.points3d = new Float64Array([0, 0, 10 * (f + 1), 0, 0, 20 * (f + 1)]);
            // Pre-populate `reprojections` so `drawAllOverlays`' lazy fill
            // doesn't re-solve and APPEND its own real results to the
            // synthetic ones below — the panel aggregates every entry for the
            // frame, so a fill would make the headline error unpredictable.
            g.reprojections = { cam1: [[10 + f, 20], [30, 40 + f]], cam2: [[12 + f, 22], [32, 42 + f]] };
            session.instanceGroups.set(f, [g]);
            AS.state.triangulationResults.set(f, [{
                group: g,
                errors: { cam1: [f + 1, f + 1], cam2: [f + 1, f + 1] },
                meanError: f + 1,
                method: 'dlt',
            }]);
        }

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = NFRAMES;
        AS.state.currentFrame = 0;

        const init = await import('/pose/initialization.js');
        init.setup3DViewport();
        const IP = await import('/ui/info-panel.js');
        IP.updateInfoPanel();
    });

    // Let the 3D viewport's deferred fitToScene (200ms) and a few rAF ticks land.
    await page.waitForTimeout(500);

    const geom = () => page.evaluate(() => {
        const vp = document.getElementById('viewport3dContainer');
        const wrap = document.getElementById('infoPanelWrapper');
        const grid = document.querySelector('.video-grid-section');
        return {
            vp3dWidth: vp.getBoundingClientRect().width,
            vp3dCollapsed: vp.classList.contains('collapsed'),
            infoWidth: wrap.getBoundingClientRect().width,
            infoCollapsed: wrap.classList.contains('collapsed'),
            gridWidth: grid.getBoundingClientRect().width,
        };
    });

    // Count real WebGL draws. `_rafId === 0` alone is not enough: the loop is
    // stopped by two independent mechanisms (the cancel in `setVisible`, the
    // guard in `_animate`) and either one on its own zeroes the handle, so a
    // regression in one would go unnoticed. What must hold is that no frame is
    // drawn while the panel is hidden, whatever the mechanism — including by
    // the camera fly-in's separate loop, which renders without touching
    // `_rafId` at all.
    await page.evaluate(() => {
        const vp = window.__lucid.viewport3d;
        window.__renderCount = 0;
        const real = vp.renderer.render.bind(vp.renderer);
        vp.renderer.render = function (...a) { window.__renderCount++; return real(...a); };
    });

    const probe = () => page.evaluate(() => {
        const vp = window.__lucid.viewport3d;
        return {
            exists: !!vp,
            visible: vp ? vp.isVisible() : null,
            rafId: vp ? vp._rafId : null,
            renderCount: window.__renderCount,
            // Number of instance-group meshes currently in the 3D scene.
            sceneGroups: vp && vp._skeletonGroup ? vp._skeletonGroup.children.length : null,
            // Z of the first rendered keypoint — identifies WHICH frame the
            // scene is showing (10*(frame+1) by construction above).
            firstNodeZ: (function () {
                if (!vp || !vp._skeletonGroup || !vp._skeletonGroup.children.length) return null;
                const inst = vp._skeletonGroup.children[0];
                for (const c of inst.children) {
                    if (c.name && c.name.indexOf('node_') === 0) return c.position.z;
                }
                return null;
            })(),
            skipped: { ...window.__lucidPanelVis.skipped },
            // Inside the panel — must go stale while hidden.
            errorDisplay: document.getElementById('errorDisplay').textContent,
            // In the bottom status bar, OUTSIDE the panel and always on
            // screen — must keep updating while hidden.
            statusError: document.getElementById('statusError').textContent,
        };
    });

    const press = async (key) => {
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        await page.keyboard.press(key);
        await page.waitForTimeout(450); // CSS width transition is 250ms
    };
    const step = async (n) => {
        for (let i = 0; i < n; i++) {
            await page.keyboard.press('ArrowRight');
            await page.waitForTimeout(80);
        }
    };

    const base = await geom();
    const baseProbe = await probe();
    await page.waitForTimeout(200);
    const baseProbe2 = await probe();
    console.log('\nBaseline (both panels shown)');
    check(baseProbe2.renderCount > baseProbe.renderCount,
        `render counter is wired and ticking (+${baseProbe2.renderCount - baseProbe.renderCount} in 200ms)`);
    check(!base.vp3dCollapsed && base.vp3dWidth > 100, `3D viewport shown (${base.vp3dWidth.toFixed(0)}px)`);
    check(!base.infoCollapsed && base.infoWidth > 100, `info panel shown (${base.infoWidth.toFixed(0)}px)`);
    check(baseProbe.exists && baseProbe.visible === true, '3D viewport initialized and visible');
    check(baseProbe.rafId !== 0 && baseProbe.rafId != null, 'render loop running');
    check(baseProbe.sceneGroups === 1, `skeleton in scene (${baseProbe.sceneGroups} group)`);
    check(baseProbe.errorDisplay.indexOf('1.00') === 0, `panel shows frame 0 error ("${baseProbe.errorDisplay}")`);

    // ---- The reported repro -------------------------------------------------
    console.log('\nReported repro: hide 3D with "\\", then hide info panel with "I"');
    await press('\\');
    const after3d = await geom();
    check(after3d.vp3dCollapsed && after3d.vp3dWidth < 2,
        `3D viewport collapsed to 0 (${after3d.vp3dWidth.toFixed(1)}px)`);
    check(Math.abs(after3d.infoWidth - base.infoWidth) < 2,
        `info panel width unchanged by the 3D toggle (${base.infoWidth.toFixed(0)} -> ${after3d.infoWidth.toFixed(0)})`);
    check(after3d.gridWidth > base.gridWidth + 100,
        `video grid absorbed the 3D width (${base.gridWidth.toFixed(0)} -> ${after3d.gridWidth.toFixed(0)})`);

    await press('i');
    const afterBoth = await geom();
    // THE BUG: this used to be ~301px wide and visible again.
    check(afterBoth.vp3dCollapsed && afterBoth.vp3dWidth < 2,
        `3D viewport STAYS collapsed after hiding the info panel (${afterBoth.vp3dWidth.toFixed(1)}px)`);
    check(afterBoth.infoCollapsed && afterBoth.infoWidth < 2,
        `info panel collapsed to 0 (${afterBoth.infoWidth.toFixed(1)}px)`);
    check(afterBoth.gridWidth > after3d.gridWidth + 100,
        `video grid absorbed the info-panel width too (${after3d.gridWidth.toFixed(0)} -> ${afterBoth.gridWidth.toFixed(0)})`);

    // ---- No work while hidden ----------------------------------------------
    console.log('\nHidden panels do no work');
    const hidden = await probe();
    check(hidden.visible === false, '3D viewport reports itself hidden');
    check(hidden.rafId === 0, 'render loop STOPPED (rafId === 0)');

    const before = await probe();
    await step(4);
    const after = await probe();
    check(after.renderCount === before.renderCount,
        `ZERO frames rendered while hidden, across 4 frame steps (count held at ${after.renderCount})`);
    check(after.skipped.viewport3d > before.skipped.viewport3d,
        `frame steps skipped the 3D update (+${after.skipped.viewport3d - before.skipped.viewport3d})`);
    check(after.skipped.infoPanel > before.skipped.infoPanel,
        `frame steps skipped the info-panel rebuild (+${after.skipped.infoPanel - before.skipped.infoPanel})`);
    check(after.rafId === 0, 'render loop still stopped after stepping frames');
    check(after.errorDisplay === before.errorDisplay,
        `hidden panel did NOT rebuild its reprojection-error tables ("${after.errorDisplay}")`);
    // …but the status bar is NOT part of the panel. `updateFrameInfo`'s tail
    // writes `#statusError` and calls `updateFrameCounters()`, both of which
    // live in the always-visible bottom bar, so gating the whole function
    // would silently freeze them.
    check(after.statusError === 'Error: 5.00 px',
        `the always-visible status bar still tracks the frame ("${after.statusError}", was "${before.statusError}")`);
    check(after.sceneGroups === before.sceneGroups && after.firstNodeZ === before.firstNodeZ,
        'hidden 3D scene was not rebuilt');

    const frameNow = await page.evaluate(() => window.__lucid.state.currentFrame);
    check(frameNow === 4, `frames actually advanced while hidden (currentFrame=${frameNow})`);

    // ---- Catch-up on re-show ------------------------------------------------
    console.log('\nRe-showing each panel resyncs it to the current frame');
    await press('i');
    const infoBack = await probe();
    const infoGeom = await geom();
    check(!infoGeom.infoCollapsed && Math.abs(infoGeom.infoWidth - base.infoWidth) < 2,
        `info panel back at its original width (${infoGeom.infoWidth.toFixed(0)}px)`);
    check(infoGeom.vp3dCollapsed && infoGeom.vp3dWidth < 2,
        '3D viewport still collapsed after re-showing the info panel');
    check(infoBack.errorDisplay.indexOf('5.00') === 0,
        `panel caught up to frame 4's error ("${infoBack.errorDisplay}")`);
    check(infoBack.rafId === 0, '3D render loop still stopped (info panel does not restart it)');

    await press('\\');
    const vpBack = await probe();
    const vpGeom = await geom();
    check(!vpGeom.vp3dCollapsed && Math.abs(vpGeom.vp3dWidth - base.vp3dWidth) < 2,
        `3D viewport back at its original width (${vpGeom.vp3dWidth.toFixed(0)}px)`);
    check(Math.abs(vpGeom.infoWidth - base.infoWidth) < 2,
        `info panel width unchanged by re-showing the 3D viewport (${vpGeom.infoWidth.toFixed(0)}px)`);
    check(vpBack.visible === true && vpBack.rafId !== 0, 'render loop restarted');
    check(vpBack.renderCount > after.renderCount,
        `rendering resumed (+${vpBack.renderCount - after.renderCount} frames)`);
    check(vpBack.sceneGroups === 1, `skeleton rebuilt in scene (${vpBack.sceneGroups} group)`);
    check(vpBack.firstNodeZ === 50,
        `3D scene resynced to frame 4, not the frame it was hidden on (node z=${vpBack.firstNodeZ}, expected 50)`);

    // ---- Toggling one never resizes the other (both shown) -----------------
    console.log('\nWith both shown, each toggle only moves the video grid');
    const bothShown = await geom();
    await press('i');
    const infoHidden = await geom();
    check(Math.abs(infoHidden.vp3dWidth - bothShown.vp3dWidth) < 2,
        `hiding the info panel left the 3D viewport width alone (${bothShown.vp3dWidth.toFixed(0)} -> ${infoHidden.vp3dWidth.toFixed(0)})`);
    check(infoHidden.gridWidth > bothShown.gridWidth + 100,
        `the video grid took the space (${bothShown.gridWidth.toFixed(0)} -> ${infoHidden.gridWidth.toFixed(0)})`);
    await press('i');
    const restored = await geom();
    check(Math.abs(restored.vp3dWidth - bothShown.vp3dWidth) < 2,
        `showing it again left the 3D viewport width alone (${restored.vp3dWidth.toFixed(0)}px)`);
    check(Math.abs(restored.gridWidth - bothShown.gridWidth) < 2,
        `and gave the space back to the video grid (${restored.gridWidth.toFixed(0)}px)`);

    // ---- A session load while collapsed must not re-open the panel ---------
    // `setup3DViewport` runs on EVERY session load and used to clear the
    // `collapsed` class, re-opening a panel the user had deliberately hidden.
    // It now stops at the gate — and releases the old viewport rather than
    // leaving it alive, because an alive-but-stale one would show the PREVIOUS
    // session's cameras and skeleton when the panel is expanded. That makes
    // the singleton null, so the expand path has to auto-init it.
    console.log('\nA session load while the 3D panel is collapsed');
    await press('\\');
    const loadWhileHidden = await page.evaluate(async () => {
        const init = await import('/pose/initialization.js');
        const AS = await import('/ui/app-state.js');
        AS.state.currentFrame = 6;
        init.setup3DViewport();
        const vp = document.getElementById('viewport3dContainer');
        return {
            released: window.__lucid.viewport3d === null,
            stillCollapsed: vp.classList.contains('collapsed'),
            // No leftover renderer canvas mounted in the container.
            canvases: document.querySelectorAll('#viewport3dCanvas canvas').length,
        };
    });
    check(loadWhileHidden.stillCollapsed,
        'setup3DViewport did NOT re-open the collapsed panel');
    check(loadWhileHidden.released, 'the stale viewport was released (singleton null)');
    check(loadWhileHidden.canvases === 0, `no orphaned WebGL canvas left mounted (${loadWhileHidden.canvases})`);

    await press('\\');
    const rebuilt = await page.evaluate(() => {
        const vp = window.__lucid.viewport3d;
        return {
            exists: !!vp,
            visible: vp ? vp.isVisible() : null,
            rafId: vp ? vp._rafId : null,
            groups: vp && vp._skeletonGroup ? vp._skeletonGroup.children.length : null,
            firstNodeZ: (function () {
                if (!vp || !vp._skeletonGroup || !vp._skeletonGroup.children.length) return null;
                for (const c of vp._skeletonGroup.children[0].children) {
                    if (c.name && c.name.indexOf('node_') === 0) return c.position.z;
                }
                return null;
            })(),
        };
    });
    check(rebuilt.exists && rebuilt.visible === true, 'expanding auto-initialized a fresh viewport');
    check(rebuilt.rafId !== 0 && rebuilt.rafId != null, 'and started its render loop');
    check(rebuilt.groups === 1 && rebuilt.firstNodeZ === 70,
        `showing frame 6, from the live session (${rebuilt.groups} group, node z=${rebuilt.firstNodeZ}, expected 70)`);

    // ---- A dragged info-panel width must still collapse --------------------
    // splitHandle2 writes an inline width + min-width onto #infoPanel, which
    // outranks `.collapsed .info-panel { width: 0 }` exactly the way the 3D
    // container's inline width did — the same bug, one element over.
    console.log('\nA resized info panel still collapses');
    await page.evaluate(() => {
        const p = document.getElementById('infoPanel');
        p.style.width = '420px';
        p.style.minWidth = '420px';
    });
    await page.waitForTimeout(100);
    const widened = await geom();
    check(widened.infoWidth > base.infoWidth + 20,
        `info panel dragged wider (${base.infoWidth.toFixed(0)} -> ${widened.infoWidth.toFixed(0)}px)`);
    await press('i');
    const widenedCollapsed = await geom();
    check(widenedCollapsed.infoCollapsed && widenedCollapsed.infoWidth < 2,
        `a dragged-wide info panel still collapses to 0 (${widenedCollapsed.infoWidth.toFixed(1)}px)`);
    await press('i');
    const widenedBack = await geom();
    check(widenedBack.infoWidth > base.infoWidth + 20,
        `and comes back at the dragged width (${widenedBack.infoWidth.toFixed(0)}px)`);

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
} catch (e) {
    console.error('FATAL', e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL — ${fails} check(s) failed`);
process.exit(fails === 0 ? 0 : 1);
