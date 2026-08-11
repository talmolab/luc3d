/**
 * overlay-export-display-settings.mjs — "Export Video Overlays" must render each
 * view with the MAIN WINDOW's per-camera display settings: brightness, contrast,
 * rotation and zoom.
 *
 * Why this needs its own file: the main modal e2e (overlay-export-modal.mjs) runs
 * decoder-less, so every tile is black. Black pixels are invariant under
 * brightness/contrast and symmetric under rotation, so that suite CANNOT tell
 * whether these settings are applied — it only proves nothing crashed. This one
 * installs a fake decoder returning a known asymmetric test pattern and reads the
 * tile pixels back.
 *
 * The settings live as CSS on live DOM elements in the main window — `style.filter`
 * for brightness/contrast (`applyVideoFilters`), a `.canvas-wrapper` transform for
 * rotation and zoom (`applyZoom`, loading/video.js). NONE of that survives a
 * `drawImage` of the decoded frame into another canvas, so the modal has to
 * re-apply all of it. That is the exact class of bug this guards: an export that
 * silently ships raw, unfiltered, unrotated video while the app shows something
 * else.
 *
 * Test pattern (per 640x480 frame): mid-grey everywhere, EXCEPT a white
 * top-left quadrant. Mid-grey is the right base because it is the most sensitive
 * probe for both filters — `contrast(0)` collapses everything to it, and
 * `brightness(2)` saturates it to white. The white quadrant makes rotation
 * detectable by asking where the bright corner ended up.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8141);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // ---- session: 4 cameras, one per setting under test ---------------------
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const VF = await import('/ui/video-filters.js');
        const { Skeleton, Camera, Session, FrameGroup } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const names = ['plain', 'flat', 'bright', 'turned'];
        const cams = names.map((n, i) => new Camera(
            n, K, [0, 0, 0, 0, 0], [100 * (i + 1), 0, 0], [0, 0, 0], [640, 480]));
        const session = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0'], 'DispTest');
        for (let f = 0; f < 3; f++) session.addFrameGroup(new FrameGroup(f));

        // The test pattern: mid-grey with a WHITE top-left quadrant.
        const pat = document.createElement('canvas');
        pat.width = 640; pat.height = 480;
        const pc = pat.getContext('2d');
        pc.fillStyle = 'rgb(128,128,128)';
        pc.fillRect(0, 0, 640, 480);
        pc.fillStyle = 'rgb(255,255,255)';
        pc.fillRect(0, 0, 320, 240);
        const bmp = await createImageBitmap(pat);

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 3;
        AS.state.currentFrame = 0;
        AS.state.fps = 30;
        AS.state.triangulationResults = new Map();
        AS.state.views = names.map(n => ({
            name: n,
            // Minimal stand-in for OnDemandVideoDecoder: the modal only calls
            // getFrame(), and every view shares the one bitmap so any per-view
            // difference in the output can only come from the display settings.
            decoder: { getFrame: async () => bmp },
            canvas: null, ctx: null, overlayCanvas: null, overlayCtx: null,
            videoWidth: 640, videoHeight: 480,
        }));

        // One setting per camera, so a failure names itself.
        VF.setSessionContrast(session, 'flat', -100);      // contrast(0) → all mid-grey
        VF.setSessionBrightness(session, 'bright', 200);   // brightness(2) → grey saturates
        VF.setSessionRotation(session, 'turned', 90);      // portrait, quadrant moves
        window.__names = names;
    });

    await page.evaluate(async () => {
        const M = await import('/ui/overlay-export-modal.js');
        M.showOverlayExportModal();
    });
    await page.waitForTimeout(2500);

    const opened = await page.evaluate(() => !!document.getElementById('ovDock'));
    check(opened, 'the modal opened');

    // Sample the tile's VIDEO canvas (not the flattened export) per view.
    const sample = () => page.evaluate(() => {
        const out = {};
        for (const el of document.querySelectorAll('#ovDock [data-view-name]')) {
            const name = el.getAttribute('data-view-name');
            if (name === '__3d__') continue;
            const c = el.querySelector('canvas');
            if (!c || !c.width) continue;
            const ctx = c.getContext('2d');
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            const at = (x, y) => {
                const i = (Math.round(y) * c.width + Math.round(x)) * 4;
                return [d[i], d[i + 1], d[i + 2], d[i + 3]];
            };
            // Bounding box of non-black (i.e. actual video) pixels, to measure the
            // drawn content's shape independently of letterboxing.
            let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
            for (let y = 0; y < c.height; y += 2) {
                for (let x = 0; x < c.width; x += 2) {
                    const p = at(x, y);
                    if (p[0] > 16 || p[1] > 16 || p[2] > 16) {
                        if (x < x0) x0 = x; if (x > x1) x1 = x;
                        if (y < y0) y0 = y; if (y > y1) y1 = y;
                    }
                }
            }
            const cx = c.width / 2, cy = c.height / 2;
            out[name] = {
                w: c.width, h: c.height,
                centre: at(cx, cy),
                box: { w: x1 - x0, h: y1 - y0 },
                // Mean luma of each quadrant of the drawn content box, for locating
                // the white quadrant after a rotation.
                quads: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(q => {
                    let s = 0, n = 0;
                    const bx = x0 + q[0] * (x1 - x0), by = y0 + q[1] * (y1 - y0);
                    for (let dy = -6; dy <= 6; dy += 3) {
                        for (let dx = -6; dx <= 6; dx += 3) {
                            const p = at(bx + dx, by + dy);
                            s += (p[0] + p[1] + p[2]) / 3; n++;
                        }
                    }
                    return Math.round(s / n);
                }),
            };
        }
        return out;
    });

    const px = await sample();
    const have = Object.keys(px);
    check(have.length === 4, `sampled all four video tiles (got ${have.length}: ${have.join(', ')})`);

    // ---- the untouched control view ----------------------------------------
    const plain = px.plain;
    check(plain && Math.abs(plain.centre[0] - 128) <= 3,
        `an untouched view keeps the source mid-grey (got ${plain && plain.centre[0]})`);
    // Its white quadrant is top-LEFT, i.e. quadrant index 0 is the bright one.
    check(plain && plain.quads[0] > 200 && plain.quads[3] < 180,
        `an untouched view has its white quadrant top-left (quads ${plain && plain.quads})`);

    // ---- contrast ----------------------------------------------------------
    // contrast(0) collapses every channel to mid-grey, so the white quadrant
    // vanishes: all four quadrants become the same value. That is a far stronger
    // signal than "the pixels changed".
    const flat = px.flat;
    check(flat && Math.max(...flat.quads) - Math.min(...flat.quads) <= 6,
        `contrast -100 flattens the frame to one value (quads ${flat && flat.quads})`);
    check(flat && Math.abs(flat.quads[0] - 128) <= 6,
        `…and that value is mid-grey (got ${flat && flat.quads[0]})`);

    // ---- brightness --------------------------------------------------------
    // brightness(2) takes mid-grey (128) to saturation.
    const bright = px.bright;
    check(bright && bright.centre[0] >= 250,
        `brightness 200 saturates the mid-grey body to white (got ${bright && bright.centre[0]})`);

    // ---- rotation ----------------------------------------------------------
    // A 90-degree rotation makes a 640x480 view PORTRAIT, and carries the white
    // quadrant from top-left to top-right.
    const turned = px.turned;
    check(turned && turned.box.h > turned.box.w,
        `rotation 90 makes the drawn content portrait (got ${turned && turned.box.w}x${turned && turned.box.h})`);
    check(turned && turned.quads[1] > turned.quads[0] && turned.quads[1] > turned.quads[2],
        `…and moves the white quadrant to the top-right (quads ${turned && turned.quads})`);

    // ---- zoom --------------------------------------------------------------
    // Zoom is transient view state, so set it after the modal is open and confirm a
    // repaint picks it up. At scale 2 anchored top-left, the white quadrant grows to
    // fill more of the frame, so the centre pixel becomes white.
    const zoomed = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const v = AS.state.views.find(x => x.name === 'plain');
        v.zoom = { scale: 2, offsetX: 0, offsetY: 0, baseW: 400, baseH: 300 };
        const M = await import('/ui/overlay-export-modal.js');
        // Nudge a setting to force a preview repaint through the normal path.
        const el = document.getElementById('ovFps');
        el.value = '29';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1200));
        const cel = document.querySelector('#ovDock [data-view-name="plain"] canvas');
        const ctx = cel.getContext('2d');
        const i = (Math.round(cel.height / 2) * cel.width + Math.round(cel.width / 2)) * 4;
        const d = ctx.getImageData(0, 0, cel.width, cel.height).data;
        return [d[i], d[i + 1], d[i + 2]];
    });
    check(zoomed[0] >= 250,
        `zoom 2x is honoured — the magnified white quadrant now covers the centre (got ${zoomed.join(',')})`);

    // ---- the modal exposes no controls for any of them ---------------------
    // "the modal should only support video in/out": these settings belong to the
    // main window, and a duplicate control here would be a second source of truth.
    const labels = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#ovSettings label, .ov-settings label'))
            .map(l => l.textContent.trim()).filter(Boolean));
    const offending = labels.filter(l => /contrast|rotation|zoom/i.test(l));
    check(offending.length === 0,
        `no contrast/rotation/zoom control in the modal (found ${JSON.stringify(offending)})`);
    // The one "brightness" label that IS allowed is the reprojection MARKER dimming,
    // which is an overlay colour setting and unrelated to video brightness.
    const brightLabels = labels.filter(l => /brightness/i.test(l));
    check(brightLabels.length <= 1,
        `at most one brightness label, the reprojection marker one (found ${JSON.stringify(brightLabels)})`);
    const note = await page.evaluate(() => {
        const el = document.getElementById('ovDisplayNote');
        return el ? el.textContent : null;
    });
    check(note && /main window/i.test(note), `the modal says where the look comes from (got ${JSON.stringify(note)})`);

    // ---- Layers ▸ Render Video Names burns the camera name in ---------------
    // Sampled from the OVERLAY canvas (index 1), not the video canvas (index 0)
    // that every assertion above reads — the name is a caption drawn on the overlay
    // pass, so a check against canvas[0] would always see nothing. Do not "fix" it
    // by switching indices.
    const nameInk = (on) => page.evaluate(async (enable) => {
        const box = document.querySelector('[data-ov="videoNames"]');
        if (box.checked !== enable) {
            box.click();
            await new Promise(r => setTimeout(r, 900));
        }
        const out = {};
        for (const el of document.querySelectorAll('#ovDock [data-view-name]')) {
            const name = el.getAttribute('data-view-name');
            const cs = el.querySelectorAll('canvas');
            if (cs.length < 2) { out[name] = null; continue; }   // 3D tile: no overlay canvas
            const c = cs[1];
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            // Ink bounding box in the BOTTOM-LEFT quadrant, where the caption lives.
            let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1, n = 0;
            for (let y = Math.floor(c.height / 2); y < c.height; y++) {
                for (let x = 0; x < Math.floor(c.width / 2); x++) {
                    if (d[(y * c.width + x) * 4 + 3] > 8) {
                        n++;
                        if (x < x0) x0 = x; if (x > x1) x1 = x;
                        if (y < y0) y0 = y; if (y > y1) y1 = y;
                    }
                }
            }
            out[name] = n ? { n, w: x1 - x0, h: y1 - y0 } : { n: 0, w: 0, h: 0 };
        }
        return out;
    }, on);

    const inkOff = await nameInk(false);
    const inkOn = await nameInk(true);
    check(inkOff.plain && inkOff.plain.n === 0,
        `with the layer OFF nothing is drawn bottom-left (got ${inkOff.plain && inkOff.plain.n} px)`);
    check(inkOn.plain && inkOn.plain.n > 30,
        `with the layer ON the camera name is burned in (got ${inkOn.plain && inkOn.plain.n} px)`);
    // A caption must stay UPRIGHT on a rotated camera: it is drawn outside the view
    // transform, like the legend. Rotated text would come out taller than wide.
    check(inkOn.turned && inkOn.turned.w > inkOn.turned.h,
        `the name stays upright on the 90-degree camera (ink ${inkOn.turned && inkOn.turned.w}x${inkOn.turned && inkOn.turned.h})`);
    // The 3D tile has no overlay canvas at all, so it structurally cannot get one.
    check(inkOn.__3d__ === null || inkOn.__3d__ === undefined,
        `the 3D tile gets no camera name (got ${JSON.stringify(inkOn.__3d__)})`);

    // ---- and it reaches the ENCODED BYTES, not just the preview -------------
    // The one assertion that proves the rotation survived into the .mp4: in
    // individual mode each file is sized from its own tile's aspect, and a
    // 90-degree-rotated 640x480 view must come out PORTRAIT (480:640), not a
    // landscape file with the frame pillarboxed inside it.
    await page.evaluate(() => {
        const set = (id, v) => {
            const el = document.getElementById(id);
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('ovMode', 'individual');
        set('ovRes', '480');
        document.getElementById('ovEndField').value = '2';
        document.getElementById('ovEndField').dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(600);

    const downloads = [];
    page.on('download', d => downloads.push(d));
    await page.evaluate(() => {
        Array.from(document.querySelectorAll('button'))
            .find(b => /^Export/i.test(b.textContent.trim())).click();
    });
    // Wait for the downloads to SETTLE rather than for a guessed count: this
    // session is calibrated, so there is a 3D tile too, and hard-coding "4" quietly
    // truncated the wait and lost whichever file arrived last.
    let seen = -1;
    for (let i = 0; i < 90 && seen !== downloads.length; i++) {
        seen = downloads.length;
        await page.waitForTimeout(700);
    }
    const names = downloads.map(d => d.suggestedFilename());
    check(downloads.length >= 4, `individual mode produced a file per tile (got ${downloads.length}: ${names.join(', ')})`);

    const fs = await import('node:fs/promises');
    const avcDims = (b) => {
        const needle = Buffer.from('avc1', 'latin1');
        for (let at = b.indexOf(needle); at >= 0; at = b.indexOf(needle, at + 1)) {
            const body = at + 4;
            if (body + 28 > b.length) break;
            if (!b.slice(body, body + 6).every(x => x === 0)) continue;
            if (b.readUInt16BE(body + 6) !== 1) continue;
            return { width: b.readUInt16BE(body + 24), height: b.readUInt16BE(body + 26) };
        }
        return null;
    };
    const dims = {};
    for (const d of downloads) {
        const name = d.suggestedFilename();
        const m = name.match(/_(plain|flat|bright|turned)\.mp4$/);
        if (!m) continue;
        const tmp = path.join(repoRoot, 'tests', 'e2e', `.tmp-disp-${process.pid}-${m[1]}.mp4`);
        await d.saveAs(tmp);
        dims[m[1]] = avcDims(await fs.readFile(tmp));
        await fs.unlink(tmp).catch(() => {});
    }
    check(dims.plain && dims.plain.width > dims.plain.height,
        `an unrotated view exports LANDSCAPE (got ${dims.plain && dims.plain.width}x${dims.plain && dims.plain.height})`);
    check(dims.turned && dims.turned.height > dims.turned.width,
        `a 90-degree-rotated view exports PORTRAIT — the rotation reached the encoded bytes ` +
        `(got ${dims.turned && dims.turned.width}x${dims.turned && dims.turned.height})`);
    check(dims.turned && dims.plain &&
          Math.abs((dims.turned.width / dims.turned.height) - (dims.plain.height / dims.plain.width)) < 0.02,
        `…with exactly the inverted aspect of the unrotated one`);

    console.log('');
    check(errs.length === 0, 'no page errors / console errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}

console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
