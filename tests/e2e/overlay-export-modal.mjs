/**
 * overlay-export-modal.mjs — real-browser test for File ▸ "Export Instance
 * Overlays" (issue #190).
 *
 * The geometry and settings arithmetic is unit tested
 * (tests/test-overlay-export-layout.js). This covers the parts only a real DOM
 * and a real dockview can:
 *
 *  - the menu item exists and sits directly ABOVE "Export 3D Video"
 *  - the modal has all three regions (views strip / composition dock / settings)
 *  - the strip lists every view plus one 3D entry, and the dock is SEEDED with
 *    a tile per view + the 3D tile (mirroring the main window)
 *  - closing a tile removes it from the dock and un-marks the strip item
 *  - the frame-range fields are 1-BASED (1 … totalFrames, not 0 … n-1) and
 *    reject illegal input by reverting rather than clamping
 *  - settings round-trip through localStorage across a close/reopen — this is
 *    what "saved across sessions within a project" means in practice
 *  - the captured dock layout actually tiles the output canvas (no seams, no
 *    out-of-bounds), which is the thing that makes the stitched export WYSIWYG
 *  - Esc closes (CLAUDE.md modal convention)
 *
 * Runs against a synthetic in-memory session — no video fixture required, so it
 * works in a worktree. The tiles therefore render black; what is under test is
 * the composition/settings plumbing, not the pixels.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8117);

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
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // ---- synthetic session: 3 CALIBRATED cameras, 40 frames, one group ------
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        // Non-zero rotation/translation on every camera → sessionHasCalibration()
        // is true, which is what gates the 3D tile.
        const names = ['cam1', 'cam2', 'cam3'];
        const cams = names.map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [100 * (i + 1), 0, 0], [0.1 * (i + 1), 0.2, 0.3], [640, 480]));
        const skel = new Skeleton('sk', ['head', 'tail'], [[0, 1]]);
        const session = new Session(cams, skel, ['t0'], 'OverlayExportTest');

        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        const g = new InstanceGroup(1, -1);
        for (const n of names) {
            const inst = new Instance([[100, 120], [200, 220]], 0, 'user', 1);
            g.addInstance(n, inst);
            fg.addInstance(n, inst);
        }
        session.instanceGroups.set(0, [g]);

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 40;
        AS.state.currentFrame = 0;
        AS.state.fps = 30;
        AS.state.triangulationResults = new Map();
        // Decoder-less views: the modal draws a black tile for each. Everything
        // under test here (docking, layout capture, settings) is decoder-free.
        AS.state.views = names.map(n => ({
            name: n, decoder: null, canvas: null, ctx: null,
            overlayCanvas: null, overlayCtx: null, videoWidth: 640, videoHeight: 480,
        }));
        try { localStorage.removeItem('overlayExportSettings.v1'); } catch (e) { /* ignore */ }
    });

    // ---- menu item ---------------------------------------------------------
    const menu = await page.evaluate(() => {
        const el = document.getElementById('menuExportOverlayVideo');
        if (!el) return null;
        const next = el.nextElementSibling;
        return { label: el.textContent.trim(), nextId: next ? next.id : null };
    });
    check(menu !== null, 'File menu has an "Export Instance Overlays" item');
    check(menu && menu.label === 'Export Instance Overlays', `label is "Export Instance Overlays" (got "${menu && menu.label}")`);
    check(menu && menu.nextId === 'menuExportVideo3d', `sits directly above "Export 3D Video" (next is ${menu && menu.nextId})`);

    // ---- open it -----------------------------------------------------------
    await page.evaluate(() => document.getElementById('menuExportOverlayVideo').click());
    await page.waitForSelector('#ovExportOverlay', { timeout: 10000 });
    // dockview lays out asynchronously; give it a frame or two.
    await page.waitForTimeout(600);

    const regions = await page.evaluate(() => ({
        strip: !!document.getElementById('ovStrip'),
        dock: !!document.getElementById('ovDock'),
        settings: !!document.getElementById('ovSettings'),
        exportBtn: !!document.getElementById('ovExport'),
    }));
    check(regions.strip && regions.dock && regions.settings && regions.exportBtn,
        'modal has views strip + composition dock + settings panel + Export button');

    // ---- views strip -------------------------------------------------------
    const strip = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#ovStrip .ov-strip-item'))
            .map(el => el.getAttribute('data-view-name')));
    check(strip.length === 4, `strip lists 3 views + the 3D entry (got ${strip.length}: ${strip.join(', ')})`);
    check(strip.includes('cam1') && strip.includes('cam2') && strip.includes('cam3'),
        'strip has an icon per video in the session');
    check(strip.includes('__3d__'), 'strip has an icon for the 3D grid itself');

    // ---- dock seeding ------------------------------------------------------
    const seeded = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#ovDock [data-view-name]'))
            .map(el => el.getAttribute('data-view-name')));
    check(seeded.length === 4, `dock seeded with a tile per view + 3D (got ${seeded.length}: ${seeded.join(', ')})`);
    check(seeded.includes('__3d__'), 'the 3D viewport is docked by default (session is calibrated)');

    const stripMarked = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#ovStrip .ov-strip-item'))
            .filter(el => el.querySelector('.ov-strip-dot').style.display !== 'none').length);
    check(stripMarked === 4, `every seeded view is marked docked in the strip (got ${stripMarked})`);

    // ---- 1-BASED frame range ----------------------------------------------
    const range = await page.evaluate(() => ({
        start: document.getElementById('ovStartField').value,
        end: document.getElementById('ovEndField').value,
        min: document.getElementById('ovStartField').min,
        max: document.getElementById('ovEndField').max,
        note: document.getElementById('ovRangeNote').textContent,
    }));
    check(range.start === '1', `start defaults to 1, not 0 (got ${range.start})`);
    check(range.end === '40', `end defaults to the frame count, not n-1 (got ${range.end})`);
    check(range.min === '1' && range.max === '40', `fields are bounded 1..40 (got ${range.min}..${range.max})`);
    check(/40 frames/.test(range.note), `range note counts 40 frames (got "${range.note}")`);

    // Illegal input must REVERT, not clamp — same contract as Export 3D Video.
    const reverted = await page.evaluate(() => {
        const f = document.getElementById('ovStartField');
        const out = {};
        for (const bad of ['0', '99', '2.5', '']) {
            f.value = bad;
            f.dispatchEvent(new Event('change', { bubbles: true }));
            out[bad === '' ? 'empty' : bad] = f.value;
        }
        return out;
    });
    check(Object.values(reverted).every(v => v === '1'),
        `illegal start values revert to 1 rather than clamping (got ${JSON.stringify(reverted)})`);

    const narrowed = await page.evaluate(() => {
        const s = document.getElementById('ovStartField'), e = document.getElementById('ovEndField');
        s.value = '5'; s.dispatchEvent(new Event('change', { bubbles: true }));
        e.value = '14'; e.dispatchEvent(new Event('change', { bubbles: true }));
        return { start: s.value, end: e.value, note: document.getElementById('ovRangeNote').textContent };
    });
    check(narrowed.start === '5' && narrowed.end === '14', 'a legal range is accepted');
    check(/^10 frames/.test(narrowed.note), `10 frames selected for 5..14 inclusive (got "${narrowed.note}")`);

    // Start must not be allowed past End.
    const crossed = await page.evaluate(() => {
        const s = document.getElementById('ovStartField');
        s.value = '20'; s.dispatchEvent(new Event('change', { bubbles: true }));
        return s.value;
    });
    check(crossed === '5', `start past end is rejected (got ${crossed})`);

    // ---- layout capture tiles the output canvas ----------------------------
    const tiling = await page.evaluate(async () => {
        const L = await import('/ui/overlay-export-layout.js');
        const dockEl = document.getElementById('ovDock');
        const dr = dockEl.getBoundingClientRect();
        const tiles = Array.from(dockEl.querySelectorAll('[data-view-name]')).map(el => {
            const r = el.getBoundingClientRect();
            return { x: r.left - dr.left, y: r.top - dr.top, width: r.width, height: r.height };
        }).filter(t => t.width >= 2 && t.height >= 2);
        const size = L.outputSizeFor(dr.width / dr.height, '1080');
        const rects = L.computeTileRects({ width: dr.width, height: dr.height }, tiles, size.width, size.height);
        // Total tile area should account for essentially the whole canvas (the
        // seeded layout has no empty regions); allow a little slack for the
        // dockview gutters between groups.
        const area = rects.reduce((a, r) => a + r.width * r.height, 0);
        return {
            n: rects.length,
            size,
            coverage: area / (size.width * size.height),
            inBounds: rects.every(r => r.x >= 0 && r.y >= 0 &&
                r.x + r.width <= size.width && r.y + r.height <= size.height),
        };
    });
    check(tiling.n === 4, `all 4 tiles captured with a real rect (got ${tiling.n})`);
    check(tiling.inBounds, 'every tile rect lands inside the output canvas');
    check(tiling.size.width % 2 === 0 && tiling.size.height % 2 === 0,
        `output size is even for the encoder (got ${tiling.size.width}×${tiling.size.height})`);
    check(tiling.coverage > 0.9, `tiles cover the output canvas (got ${(tiling.coverage * 100).toFixed(1)}%)`);

    // ---- summary reflects mode --------------------------------------------
    const stitchedSummary = await page.evaluate(() => document.getElementById('ovSummary').textContent);
    check(/4 tiles/.test(stitchedSummary), `stitched summary counts tiles (got "${stitchedSummary}")`);

    const individualSummary = await page.evaluate(() => {
        const sel = document.getElementById('ovMode');
        sel.value = 'individual';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return document.getElementById('ovSummary').textContent;
    });
    check(/4 files/.test(individualSummary), `individual mode promises one file per tile (got "${individualSummary}")`);

    // ---- close a tile ------------------------------------------------------
    const afterClose = await page.evaluate(async () => {
        // Close the first dockview tab (whichever view it belongs to).
        const closeBtn = document.querySelector('#ovDock .dv-default-tab-action');
        if (closeBtn) closeBtn.click();
        await new Promise(r => setTimeout(r, 400));
        return {
            tiles: document.querySelectorAll('#ovDock [data-view-name]').length,
            marked: Array.from(document.querySelectorAll('#ovStrip .ov-strip-item'))
                .filter(el => el.querySelector('.ov-strip-dot').style.display !== 'none').length,
            summary: document.getElementById('ovSummary').textContent,
        };
    });
    check(afterClose.tiles === 3, `closing a tab removes it from the composition (got ${afterClose.tiles})`);
    check(afterClose.marked === 3, `the strip un-marks the removed view (got ${afterClose.marked})`);
    check(/3 files/.test(afterClose.summary), `summary follows the composition (got "${afterClose.summary}")`);

    // ---- settings persist across a close/reopen ---------------------------
    await page.evaluate(() => {
        const set = (id, v) => {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('ovRes', '720');
        set('ovFps', '24');
        set('ovColorBy', 'identity');
        set('ovBackground', 'black');
        set('ovQuality', 'high');
    });
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('overlayExportSettings.v1') || 'null'));
    check(stored && stored.res === '720' && stored.fps === 24 && stored.colorBy === 'identity' &&
        stored.background === 'black' && stored.quality === 'high' && stored.mode === 'individual',
        'settings are written to localStorage as they change');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const closed = await page.evaluate(() => !document.getElementById('ovExportOverlay'));
    check(closed, 'Esc closes the modal (CLAUDE.md modal convention)');

    await page.evaluate(() => document.getElementById('menuExportOverlayVideo').click());
    await page.waitForSelector('#ovExportOverlay', { timeout: 10000 });
    await page.waitForTimeout(600);
    const restored = await page.evaluate(() => ({
        res: document.getElementById('ovRes').value,
        fps: document.getElementById('ovFps').value,
        colorBy: document.getElementById('ovColorBy').value,
        background: document.getElementById('ovBackground').value,
        quality: document.getElementById('ovQuality').value,
        mode: document.getElementById('ovMode').value,
    }));
    check(restored.res === '720' && restored.fps === '24' && restored.colorBy === 'identity' &&
        restored.background === 'black' && restored.quality === 'high' && restored.mode === 'individual',
        `settings are restored on reopen (got ${JSON.stringify(restored)})`);

    // The layout itself is deliberately NOT persisted — a reopened modal starts
    // from the mirror-the-main-window seed again.
    const reseeded = await page.evaluate(() => document.querySelectorAll('#ovDock [data-view-name]').length);
    check(reseeded === 4, `reopening re-seeds the full composition (got ${reseeded})`);

    // ---- the modal transport drives the app viewer -------------------------
    // Stepping/scrubbing/playing in the modal must move the real viewer, so the
    // app is left on the frame you stopped at. `scrubToFrame` coalesces, so the
    // assertion is "the app agrees with the playhead", not "every frame landed".
    const playhead = () => page.evaluate(() => {
        const m = /frame (\d+) \//.exec(document.getElementById('ovScrubVal').textContent);
        return m ? Number(m[1]) - 1 : -1;          // displayed 1-based -> 0-based
    });
    const appFrame = () => page.evaluate(async () => (await import('/ui/app-state.js')).state.currentFrame);

    await page.evaluate(async () => {
        document.getElementById('ovNext').click();
        await new Promise(r => setTimeout(r, 350));
    });
    const [phNext, afNext] = [await playhead(), await appFrame()];
    check(phNext > 0, `stepping forward moves the modal playhead (got frame ${phNext})`);
    check(afNext === phNext, `the app viewer follows a forward step (app ${afNext} vs playhead ${phNext})`);

    await page.evaluate(async () => {
        document.getElementById('ovPrev').click();
        await new Promise(r => setTimeout(r, 350));
    });
    const [phPrev, afPrev] = [await playhead(), await appFrame()];
    check(phPrev === phNext - 1, `stepping back moves the playhead (got frame ${phPrev})`);
    check(afPrev === phPrev, `the app viewer follows a backward step (app ${afPrev} vs playhead ${phPrev})`);

    await page.evaluate(async () => {
        document.getElementById('ovPlay').click();
        await new Promise(r => setTimeout(r, 900));
        document.getElementById('ovPlay').click();      // pause
        await new Promise(r => setTimeout(r, 350));
    });
    const [phPlay, afPlay] = [await playhead(), await appFrame()];
    check(phPlay > phPrev, `playing advances the playhead (${phPrev} -> ${phPlay})`);
    check(afPlay === phPlay, `the app viewer keeps up with playback (app ${afPlay} vs playhead ${phPlay})`);

    // ---- custom output dimensions, applied to the composition live ---------
    const custom = await page.evaluate(async () => {
        const set = (id, v) => {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('ovMode', 'stitched');
        set('ovOutW', '1000');
        const resAfterWidth = document.getElementById('ovRes').value;
        set('ovOutH', '500');
        await new Promise(r => setTimeout(r, 450));
        const dr = document.getElementById('ovDock').getBoundingClientRect();
        const fr = document.getElementById('ovDockFrame').getBoundingClientRect();
        return {
            resAfterWidth,
            w: document.getElementById('ovOutW').value,
            h: document.getElementById('ovOutH').value,
            dockAspect: dr.width / dr.height,
            fitsFrame: dr.width <= fr.width + 1 && dr.height <= fr.height + 1,
            summary: document.getElementById('ovSummary').textContent,
            stored: JSON.parse(localStorage.getItem('overlayExportSettings.v1') || 'null'),
        };
    });
    check(custom.resAfterWidth === 'custom', `typing a width switches Resolution to Custom (got "${custom.resAfterWidth}")`);
    check(Math.abs(custom.dockAspect - 2) < 0.02,
        `the composition is reshaped to the custom 2:1 aspect in real time (got ${custom.dockAspect.toFixed(3)})`);
    check(custom.fitsFrame, 'the reshaped composition still fits inside the modal');
    check(/1000×500/.test(custom.summary), `summary reports the custom output size (got "${custom.summary}")`);
    check(custom.stored && custom.stored.res === 'custom' && custom.stored.outW === 1000 && custom.stored.outH === 500,
        `a custom size persists to localStorage (got ${JSON.stringify(custom.stored && { res: custom.stored.res, outW: custom.stored.outW, outH: custom.stored.outH })})`);

    // Odd/over-large input is normalised to something the encoder will accept.
    const normalised = await page.evaluate(async () => {
        const set = (id, v) => {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('ovOutW', '1001');
        set('ovOutH', '99999');
        await new Promise(r => setTimeout(r, 300));
        return { w: document.getElementById('ovOutW').value, h: document.getElementById('ovOutH').value };
    });
    check(normalised.w === '1002', `an odd width is evened for H.264 (got ${normalised.w})`);
    check(normalised.h === '3840', `an over-large height is clamped to MAX_OUT_DIM (got ${normalised.h})`);

    // Switching back to a preset hands sizing back to the composition.
    const backToPreset = await page.evaluate(async () => {
        const el = document.getElementById('ovRes');
        el.value = '720';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 450));
        const dr = document.getElementById('ovDock').getBoundingClientRect();
        const fr = document.getElementById('ovDockFrame').getBoundingClientRect();
        return {
            h: document.getElementById('ovOutH').value,
            fills: Math.abs(dr.width - fr.width) < 2 && Math.abs(dr.height - fr.height) < 2,
        };
    });
    check(backToPreset.fills, 'choosing a preset again lets the composition fill the modal');
    check(backToPreset.h === '720', `the size fields show the preset-derived height (got ${backToPreset.h})`);

    // ---- a session with no calibration has no 3D tile ---------------------
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        for (const cam of AS.state.session.cameras) {
            cam.translation = [0, 0, 0]; cam.tvec = [0, 0, 0];
            cam.rotation = [0, 0, 0]; cam.rvec = [0, 0, 0];
        }
    });
    await page.evaluate(() => document.getElementById('menuExportOverlayVideo').click());
    await page.waitForSelector('#ovExportOverlay', { timeout: 10000 });
    await page.waitForTimeout(500);
    const uncalibrated = await page.evaluate(() => ({
        strip: Array.from(document.querySelectorAll('#ovStrip .ov-strip-item')).map(e => e.getAttribute('data-view-name')),
        tiles: Array.from(document.querySelectorAll('#ovDock [data-view-name]')).map(e => e.getAttribute('data-view-name')),
    }));
    check(!uncalibrated.strip.includes('__3d__'), 'no 3D strip entry without calibration');
    check(!uncalibrated.tiles.includes('__3d__'), 'no 3D tile without calibration');
    check(uncalibrated.tiles.length === 3, `still seeds every video (got ${uncalibrated.tiles.length})`);

    // ---- export guard rails -----------------------------------------------
    // Headless Chromium in this Playwright build has NO `VideoEncoder`, so the
    // encode loop itself can't run here (same limitation as Export 3D Video).
    // What IS testable is that the two refusal branches report instead of
    // throwing — the missing-WebCodecs one is exactly what a Firefox/Safari user
    // hits, and an empty composition is a one-click mistake.
    const emptyComposition = await page.evaluate(async () => {
        // Close every tab, then press Export.
        let guard = 0;
        while (document.querySelector('#ovDock .dv-default-tab-action') && guard++ < 20) {
            document.querySelector('#ovDock .dv-default-tab-action').click();
            await new Promise(r => setTimeout(r, 120));
        }
        document.getElementById('ovExport').click();
        await new Promise(r => setTimeout(r, 200));
        const st = document.getElementById('statusMessage') || document.getElementById('statusText');
        return {
            tiles: document.querySelectorAll('#ovDock [data-view-name]').length,
            summary: document.getElementById('ovSummary').textContent,
            status: st ? st.textContent : '',
            stillOpen: !!document.getElementById('ovExportOverlay'),
        };
    });
    check(emptyComposition.tiles === 0, `all tiles can be closed (got ${emptyComposition.tiles})`);
    check(/Add at least one view/.test(emptyComposition.summary),
        `empty composition tells the user what to do (got "${emptyComposition.summary}")`);
    check(emptyComposition.stillOpen, 'exporting an empty composition does not tear the modal down');

    // ---- a REAL export: stitched, then individual --------------------------
    // Headless Chromium here does have WebCodecs H.264 encode, so the whole
    // pipeline (tiles -> overlays -> composite -> muxed mp4) runs for real. The
    // decisive assertion is the `avc1` sample entry's width/height: it proves the
    // composed canvas that reached the encoder was the size `outputSizeFor`
    // promised, i.e. that the layout capture and the encoder config agree.
    const expected = await page.evaluate(async () => {
        const L = await import('/ui/overlay-export-layout.js');
        // Re-add two tiles and pick a small, fast range.
        const items = document.querySelectorAll('#ovStrip .ov-strip-item');
        items[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise(r => setTimeout(r, 250));
        items[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise(r => setTimeout(r, 400));

        const set = (id, v) => {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('ovRes', '360');
        set('ovMode', 'stitched');
        set('ovStartField', '2');
        set('ovEndField', '4');

        const dr = document.getElementById('ovDock').getBoundingClientRect();
        return {
            tiles: document.querySelectorAll('#ovDock [data-view-name]').length,
            size: L.outputSizeFor(dr.width / dr.height, '360'),
        };
    });
    check(expected.tiles === 2, `two tiles re-added by double-clicking strip items (got ${expected.tiles})`);

    const stitchedDl = await (async () => {
        const dl = page.waitForEvent('download', { timeout: 60000 });
        await page.evaluate(() => document.getElementById('ovExport').click());
        return dl;
    })();
    check(stitchedDl.suggestedFilename() === 'OverlayExportTest_overlay_f2-4.mp4',
        `stitched export downloads one mp4 named for the 1-based range (got "${stitchedDl.suggestedFilename()}")`);

    const fs = await import('node:fs/promises');
    const buf = await fs.readFile(await stitchedDl.path());
    check(buf.length > 1000, `stitched mp4 is non-trivial (${buf.length} bytes)`);
    check(buf.slice(4, 8).toString('latin1') === 'ftyp', 'stitched output is a real MP4 (ftyp box)');

    // VisualSampleEntry: 'avc1' + 6 reserved + 2 data_reference_index
    //                          + 16 pre_defined/reserved + width(2) + height(2)
    // 'avc1' also appears in the ftyp compatible-brand list, so scan every
    // occurrence and take the one that really is a VisualSampleEntry: 6 zero
    // reserved bytes followed by data_reference_index == 1.
    const avcDims = (b) => {
        const needle = Buffer.from('avc1', 'latin1');
        for (let at = b.indexOf(needle); at >= 0; at = b.indexOf(needle, at + 1)) {
            const body = at + 4;
            if (body + 28 > b.length) break;
            const reservedZero = b.slice(body, body + 6).every(x => x === 0);
            if (!reservedZero || b.readUInt16BE(body + 6) !== 1) continue;
            return { width: b.readUInt16BE(body + 24), height: b.readUInt16BE(body + 26) };
        }
        return null;
    };
    const dims = avcDims(buf);
    check(dims !== null, 'stitched mp4 carries an avc1 sample entry');
    check(dims && dims.width === expected.size.width && dims.height === expected.size.height,
        `stitched mp4 is the composition size the modal promised ` +
        `(got ${dims && dims.width}x${dims && dims.height}, expected ${expected.size.width}x${expected.size.height})`);

    await page.waitForTimeout(500);
    const closedAfterExport = await page.evaluate(() => !document.getElementById('ovExportOverlay'));
    check(closedAfterExport, 'a successful export closes the modal');

    // ---- individual mode produces one file per tile ------------------------
    await page.evaluate(() => document.getElementById('menuExportOverlayVideo').click());
    await page.waitForSelector('#ovExportOverlay', { timeout: 10000 });
    await page.waitForTimeout(600);
    await page.evaluate(async () => {
        // Drop everything but two video tiles so the run stays fast and the
        // filenames are predictable.
        let guard = 0;
        while (document.querySelectorAll('#ovDock [data-view-name]').length > 2 && guard++ < 20) {
            const tabs = document.querySelectorAll('#ovDock .dv-default-tab-action');
            tabs[tabs.length - 1].click();
            await new Promise(r => setTimeout(r, 150));
        }
        const set = (id, v) => {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('ovRes', '360');
        set('ovMode', 'individual');
        set('ovStartField', '2');
        set('ovEndField', '3');
    });

    const individualDls = [];
    page.on('download', d => individualDls.push(d));
    await page.evaluate(() => document.getElementById('ovExport').click());
    await page.waitForFunction(() => !document.getElementById('ovExportOverlay'), { timeout: 60000 });
    await page.waitForTimeout(1000);
    check(individualDls.length === 2,
        `individual mode downloads one mp4 per tile (got ${individualDls.length}: ` +
        individualDls.map(d => d.suggestedFilename()).join(', ') + ')');
    check(individualDls.length > 0 && individualDls.every(d => /^OverlayExportTest_overlay_f2-3_/.test(d.suggestedFilename())),
        'individual filenames carry the session, range and tile name');
    if (individualDls.length) {
        const first = await fs.readFile(await individualDls[0].path());
        const d0 = avcDims(first);
        // A 640x480 source at the 360p preset -> 480x360.
        check(d0 && d0.height === 360 && d0.width === 480,
            `an individual 2D file uses the source aspect at the preset height (got ${d0 && d0.width}x${d0 && d0.height})`);
    }

    // ---- a custom size reaches the encoder verbatim ------------------------
    // The decisive assertion for editable dimensions: the avc1 sample entry must
    // be exactly what was typed, not something re-derived from the composition.
    await page.evaluate(() => document.getElementById('menuExportOverlayVideo').click());
    await page.waitForSelector('#ovExportOverlay', { timeout: 10000 });
    await page.waitForTimeout(600);
    await page.evaluate(async () => {
        let guard = 0;
        while (document.querySelectorAll('#ovDock [data-view-name]').length > 2 && guard++ < 20) {
            const tabs = document.querySelectorAll('#ovDock .dv-default-tab-action');
            tabs[tabs.length - 1].click();
            await new Promise(r => setTimeout(r, 150));
        }
        const set = (id, v) => {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('ovMode', 'stitched');
        set('ovOutW', '322');
        set('ovOutH', '244');
        set('ovStartField', '1');
        set('ovEndField', '2');
        await new Promise(r => setTimeout(r, 400));
    });
    const customDl = await (async () => {
        const dl = page.waitForEvent('download', { timeout: 60000 });
        await page.evaluate(() => document.getElementById('ovExport').click());
        return dl;
    })();
    const customBuf = await fs.readFile(await customDl.path());
    const dc = avcDims(customBuf);
    check(dc && dc.width === 322 && dc.height === 244,
        `a custom size is encoded verbatim (got ${dc && dc.width}x${dc && dc.height}, expected 322x244)`);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // WebGL is unavailable in some headless configurations; the modal handles it
    // by showing a message instead of a viewport, so don't treat it as an error.
    const real = errs.filter(e => !/WebGL|webgl|THREE|GroupMarkerNotSet/.test(e));
    check(real.length === 0, 'no page errors / console errors' + (real.length ? ': ' + real.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL — ${fails} check(s) failed`);
process.exit(fails === 0 ? 0 : 1);
