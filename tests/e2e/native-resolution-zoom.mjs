/**
 * native-resolution-zoom.mjs — View ▸ Native Resolution (Shift+0) shows a
 * video at ONE VIDEO PIXEL PER DEVICE PIXEL, and a wheel / key zoom that
 * passes through that scale stops on it.
 *
 * The claim is about pixels, so this checks pixels. Every camera's canvas is
 * filled with seeded noise and the REAL screen is screenshotted at device
 * resolution: at 1:1 each screen pixel must equal its own source pixel. Noise
 * makes that unforgiving — any resampling (a scale a hair off 1, or a
 * half-pixel offset) averages unrelated neighbours, and no integer shift of
 * the source then matches more than a few percent of the screen.
 *
 * Two negative controls pin WHY it is exact, each confirmed to break it:
 *   - the canvas box is floored to whole CSS px, so its aspect is a hair off
 *     the video's: one uniform scale leaves the vertical axis resampled by
 *     ~0.3%. The test layout is chosen so that is true (it asserts so).
 *   - a half-device-pixel pan resamples even at the exact scale.
 *
 * Also covered: the badge (the zoom as a % of 1:1) and the menu tick, OFF
 * back to fit, the wheel snap
 * (from both sides, the hold that stops a fast spin, release after a rest,
 * a reversal is never held), the `+` key snap, the point under the cursor
 * staying put through a snap, 1:1 surviving a window resize, a pane rebuild
 * (grid → solo, cycling the solo camera) and a devicePixelRatio change, a
 * 90°-rotated view staying exact, and clicks still mapping to the right video
 * pixel there.
 *
 * Exactness holds at an INTEGER devicePixelRatio. At a fractional one
 * (browser zoom, Windows 125%/150%) Chrome's compositor resamples the canvas
 * whatever the transform says, so section 9 only checks the size there.
 *
 * Run: node tests/e2e/native-resolution-zoom.mjs
 *      HEADED=1 node tests/e2e/native-resolution-zoom.mjs   (a visible, GPU-
 *      composited window — on a Retina Mac its dpr-2 sections are the real
 *      display's; takes the machine-wide browser lock)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBrowserLock } from '../../scripts/browser-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8273);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const HEADED = !!process.env.HEADED;
const releaseLock = HEADED ? await acquireBrowserLock({ label: 'native-resolution-zoom (headed)' }) : null;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

/** A project of `cams` ([{name, w, h}]), each canvas filled with its own noise. */
async function loadProject(page, cams) {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    await page.evaluate(async (cams) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Skeleton, Camera, Session } = pd;
        const cameras = cams.map(c => new Camera(c.name, [[600, 0, c.w / 2], [0, 600, c.h / 2], [0, 0, 1]],
            [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [c.w, c.h]));
        const session = new Session(cameras, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], 'Native');
        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 10;
        AS.state.currentFrame = 0;
        AS.state.fps = 30;
        AS.state.isPlaying = false;
        AS.state.triangulationResults = new Map();
        // A stub decoder per view: the zoom keys (+ / − / 0 / Shift+0) are live
        // only while `hasRealVideo()`. It never yields a frame, so nothing
        // overwrites the noise painted below.
        const decoder = { getFrame: () => Promise.resolve(null), releaseFrames() {} };
        AS.state.views = cams.map(c => ({ name: c.name, videoWidth: c.w, videoHeight: c.h, canvas: null, decoder }));
        AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name }));
        AS.state.viewMode = 'grid';
        AS.state.singleViewIndex = 0;
        AS.paneManager.clearAll();
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
        await new Promise(r => requestAnimationFrame(r));
        sp.refreshPaneInteractions();
        await new Promise(r => requestAnimationFrame(r));
        window.__noise = {};
        window.__paintNoise = function () {
            AS.state.views.forEach(function (v, k) {
                if (!v.ctx) return;
                const w = v.videoWidth, h = v.videoHeight;
                if (!window.__noise[v.name]) {
                    const id = new ImageData(w, h);
                    let seed = 1234567 + 7919 * k;
                    for (let i = 0; i < w * h; i++) {
                        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                        const g = (seed >> 8) & 255;
                        id.data[4 * i] = g; id.data[4 * i + 1] = g; id.data[4 * i + 2] = g; id.data[4 * i + 3] = 255;
                    }
                    window.__noise[v.name] = id;
                }
                v.ctx.putImageData(window.__noise[v.name], 0, 0);
                // Only the video canvas is under test: hide the pose overlay.
                if (v.overlayCanvas) v.overlayCanvas.style.visibility = 'hidden';
            });
        };
        window.__paintNoise();
        // Pane chrome drawn over the picture (the badge, the selection frame)
        // would read as mismatched pixels; the badge's text is still checked.
        const st = document.createElement('style');
        st.textContent = '.video-cell .unzoom-btn, .video-cell .view-legend, #viewModeIndicator { visibility: hidden !important; }'
            + ' .video-cell::after { display: none !important; } .video-cell .canvas-wrapper { outline: none !important; }';
        document.head.appendChild(st);
    }, cams);
    await page.waitForTimeout(300);
}

/** Zoom state + geometry of one view. */
const zoomOf = (page, name) => page.evaluate(async (name) => {
    const AS = await import('/ui/app-state.js');
    const v = AS.state.views.find(x => x.name === name);
    const nat = AS.videoController.nativeZoomScales(v);
    const cell = v.canvas.closest('.video-cell');
    const badge = cell.querySelector('.unzoom-btn');
    return {
        scale: v.zoom.scale, scaleY: v.zoom.scaleY, native: !!v.zoom.native,
        offsetX: v.zoom.offsetX, offsetY: v.zoom.offsetY,
        nat, boxW: parseFloat(v.canvas.style.width), boxH: parseFloat(v.canvas.style.height),
        vw: v.videoWidth, vh: v.videoHeight, dpr: window.devicePixelRatio,
        mode: AS.state.nativeResolution,
        badge: badge && badge.style.display !== 'none' ? badge.textContent : null,
        transform: v.wrapper.style.transform,
    };
}, name);

/**
 * Screenshot the part of `name`'s cell the video covers and score it against
 * the source noise: the fraction of screen pixels equal to their source pixel
 * under the best integer shift (rotation `rot` = 0 or 90 maps the source).
 * 1.0 means pixel-for-pixel; resampled noise scores a few percent.
 */
async function exactness(page, name, rot = 0) {
    const g = await page.evaluate(async (name) => {
        const AS = await import('/ui/app-state.js');
        const v = AS.state.views.find(x => x.name === name);
        const c = v.canvas.closest('.video-cell').getBoundingClientRect();
        const r = v.canvas.getBoundingClientRect();
        return { dpr: window.devicePixelRatio, c: [c.left, c.top, c.right, c.bottom], r: [r.left, r.top, r.right, r.bottom] };
    }, name);
    // The video's on-screen rect, inset 2 css px, clipped to the cell.
    const x0 = Math.ceil(Math.max(g.c[0], g.r[0])) + 2, y0 = Math.ceil(Math.max(g.c[1], g.r[1])) + 2;
    const x1 = Math.floor(Math.min(g.c[2], g.r[2])) - 2, y1 = Math.floor(Math.min(g.c[3], g.r[3])) - 2;
    const clip = { x: x0, y: y0, width: Math.min(x1 - x0, 360), height: Math.min(y1 - y0, 360) };
    const png = await page.screenshot({ clip });
    return page.evaluate(async ([b64, clip, g, name, rot]) => {
        const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
        const oc = new OffscreenCanvas(bmp.width, bmp.height);
        const ox = oc.getContext('2d');
        ox.drawImage(bmp, 0, 0);
        const sd = ox.getImageData(0, 0, bmp.width, bmp.height).data;
        const n = window.__noise[name];
        const W = n.width, H = n.height, dpr = g.dpr;
        // Screen device px of the rotated image's top-left (approximate; the
        // shift search absorbs the rounding).
        const L = Math.round(g.r[0] * dpr - clip.x * dpr), T = Math.round(g.r[1] * dpr - clip.y * dpr);
        let best = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            let ok = 0, tot = 0;
            for (let j = 0; j < bmp.height; j += 2) for (let i = 0; i < bmp.width; i += 2) {
                const a = i - L + dx, b = j - T + dy;
                const sx = rot === 90 ? b : a;
                const sy = rot === 90 ? H - 1 - a : b;
                if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
                tot++;
                if (sd[4 * (j * bmp.width + i)] === n.data[4 * (sy * W + sx)]) ok++;
            }
            if (tot > 1000) best = Math.max(best, ok / tot);
        }
        return best;
    }, [png.toString('base64'), clip, g, name, rot]);
}

/** Screen point (CSS px, page coords) of `name`'s cell centre. */
const cellCentre = (page, name) => page.evaluate(async (name) => {
    const AS = await import('/ui/app-state.js');
    const v = AS.state.views.find(x => x.name === name);
    const c = v.canvas.closest('.video-cell').getBoundingClientRect();
    return [c.left + c.width / 2, c.top + c.height / 2];
}, name);

/** The video pixel under page point (x, y), via the app's own click mapping. */
const videoAt = (page, name, x, y) => page.evaluate(async ([name, x, y]) => {
    const AS = await import('/ui/app-state.js');
    return AS.interactionManager.canvasToVideo(x, y, name);
}, [name, x, y]);

const openViewMenuTick = async (page) => {
    await page.click('.menu-item[data-menu="view"]');
    const tick = await page.$eval('#menuNativeResolution .trail-check', el => el.textContent);
    await page.click('.menu-item[data-menu="view"]'); // close it again
    return tick;
};

try {
    const browser = await chromium.launch({ headless: !HEADED });
    const errs = [];

    // ===== dpr 2 (a Retina Mac), one 1680x1200 camera ======================
    {
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
        const page = await ctx.newPage();
        page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
        await loadProject(page, [{ name: 'camA', w: 1680, h: 1200 }]);

        console.log('\n1. Fitted, the video is resampled');
        let z = await zoomOf(page, 'camA');
        check(z.scale === 1 && !z.native && !z.mode, `starts fitted (scale ${z.scale})`);
        const fitScore = await exactness(page, 'camA');
        check(fitScore < 0.2, `fitted, screen pixels do NOT match the source (${(fitScore * 100).toFixed(1)}% exact)`);
        // The precondition for control 2a: the floored box is NOT the video's aspect.
        check(Math.abs(z.boxW / z.boxH - z.vw / z.vh) > 1e-4,
            `the canvas box (${z.boxW}x${z.boxH}) is a hair off the video aspect (${z.vw}x${z.vh})`);

        console.log('\n2. Shift+0 → one video pixel per device pixel');
        await page.keyboard.press('Shift+Digit0');
        await page.waitForTimeout(250);
        z = await zoomOf(page, 'camA');
        check(z.native && z.mode, 'view and mode are at native resolution');
        check(z.scale === z.nat.x && z.scaleY === z.nat.y, `scale is the per-axis 1:1 scale (${z.scale.toFixed(5)}, ${z.scaleY.toFixed(5)})`);
        check(near(z.boxW * z.scale * z.dpr, 1680, 1e-9) && near(z.boxH * z.scaleY * z.dpr, 1200, 1e-9),
            'the box is drawn 1680x1200 device px');
        check(near(z.offsetX * z.dpr, Math.round(z.offsetX * z.dpr), 1e-6) && near(z.offsetY * z.dpr, Math.round(z.offsetY * z.dpr), 1e-6),
            `the pan is a whole number of device px (${z.offsetX}, ${z.offsetY})`);
        check(z.badge === '100%', `the pane badge reads "100%" (${z.badge})`);
        let score = await exactness(page, 'camA');
        check(score > 0.999, `EVERY screen pixel equals its source pixel (${(score * 100).toFixed(2)}% exact)`);
        check((await openViewMenuTick(page)) === '✓', 'View ▸ Native Resolution is ticked');

        console.log('\n2a. Control: one uniform scale resamples the vertical axis');
        await page.evaluate(async () => {
            const AS = await import('/ui/app-state.js');
            const v = AS.state.views[0];
            v.wrapper.style.transform = v.wrapper.style.transform.replace(/scale\([^)]*\)/, 'scale(' + v.zoom.scale + ')');
        });
        await page.waitForTimeout(150);
        score = await exactness(page, 'camA');
        check(score < 0.2, `uniform scale: no longer exact (${(score * 100).toFixed(1)}%)`);

        console.log('\n2b. Control: a half-device-pixel pan resamples');
        await page.evaluate(async () => {
            const AS = await import('/ui/app-state.js');
            const v = AS.state.views[0];
            AS.videoController.applyZoom(v); // back to the real transform
            v.wrapper.style.transform = v.wrapper.style.transform.replace(/^translate\(([-\d.e]+)px/, function (m, x) {
                return 'translate(' + (parseFloat(x) + 0.25) + 'px';
            });
        });
        await page.waitForTimeout(150);
        score = await exactness(page, 'camA');
        check(score < 0.2, `offset by ½ device px: no longer exact (${(score * 100).toFixed(1)}%)`);
        await page.evaluate(async () => {
            const AS = await import('/ui/app-state.js');
            AS.videoController.applyZoom(AS.state.views[0]);
        });

        console.log('\n3. Panning at 1:1 stays on the pixel grid');
        const [cx, cy] = await cellCentre(page, 'camA');
        await page.mouse.move(cx, cy);
        await page.mouse.down({ button: 'middle' });
        await page.mouse.move(cx - 37.5, cy - 21.25, { steps: 3 });
        await page.mouse.up({ button: 'middle' });
        await page.waitForTimeout(150);
        z = await zoomOf(page, 'camA');
        check(z.native, 'still native after a pan');
        score = await exactness(page, 'camA');
        check(score > 0.999, `still exact after a fractional pan (${(score * 100).toFixed(2)}%)`);

        console.log('\n4. Shift+0 again → fitted');
        await page.keyboard.press('Shift+Digit0');
        await page.waitForTimeout(250);
        z = await zoomOf(page, 'camA');
        check(z.scale === 1 && !z.native && !z.mode && z.badge === null, 'back to fit, badge hidden');
        check((await openViewMenuTick(page)) === '', 'the menu tick is cleared');

        console.log('\n4a. The menu item toggles it too');
        await page.click('.menu-item[data-menu="view"]');
        await page.click('#menuNativeResolution');
        await page.waitForTimeout(250);
        z = await zoomOf(page, 'camA');
        check(z.native && z.mode, 'View ▸ Native Resolution turns it on');
        await page.click('.menu-item[data-menu="view"]');
        await page.click('#menuNativeResolution');
        await page.waitForTimeout(250);
        z = await zoomOf(page, 'camA');
        check(!z.native && z.scale === 1, '...and off');

        console.log('\n5. A wheel zoom IN through 1:1 stops on it, and holds');
        // Native here is ~1.5x fit: 10% steps cross it on the 5th notch.
        await page.mouse.move(cx + 40, cy - 30);
        const before = await videoAt(page, 'camA', cx + 40, cy - 30);
        for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -100); // a fast spin
        await page.waitForTimeout(80);
        z = await zoomOf(page, 'camA');
        check(z.native && z.scale === z.nat.x, `a fast spin stops at 1:1 (scale ${z.scale.toFixed(4)}, 1:1 = ${z.nat.x.toFixed(4)})`);
        check(z.mode, 'which turns native resolution on (the menu follows the screen)');
        // Along x the picture overflows the pane, so the pixel under the cursor
        // must stay put. Along y it does not (600 css px tall at 1:1, in a
        // 609 px pane), and a picture that fits is kept centred.
        const after = await videoAt(page, 'camA', cx + 40, cy - 30);
        check(near(before[0], after[0], 1.0),
            `the video column under the cursor stays under it (x ${before[0].toFixed(1)} → ${after[0].toFixed(1)})`);
        // Same direction, still inside the hold window: swallowed.
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(60);
        z = await zoomOf(page, 'camA');
        check(z.native, 'another notch right away is held at 1:1');
        score = await exactness(page, 'camA');
        check(score > 0.999, `the snapped view is exact (${(score * 100).toFixed(2)}%)`);

        console.log('\n5b. Once the picture overflows the pane, a notch keeps the pixel under the cursor');
        // Past 1:1 both axes overflow. The anchor has to go through the whole
        // transform: the wrapper is flex-centred in its pane, and ignoring that
        // offset slid the picture 10% of it per notch along the letterboxed
        // axis (here ~10 css px vertically).
        await page.waitForTimeout(400);
        for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
        await page.waitForTimeout(400);
        const [ax, ay] = [cx - 90, cy + 70];
        await page.mouse.move(ax, ay);
        const b5 = await videoAt(page, 'camA', ax, ay);
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(80);
        const a5 = await videoAt(page, 'camA', ax, ay);
        check(near(b5[0], a5[0], 0.5) && near(b5[1], a5[1], 0.5),
            `the video pixel under the cursor stays under it (${b5.map(n => n.toFixed(2))} → ${a5.map(n => n.toFixed(2))})`);
        // Back to 1:1 for section 6: spin out until it snaps.
        await page.waitForTimeout(400);
        for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 100);
        await page.waitForTimeout(400);
        z = await zoomOf(page, 'camA');
        check(z.native, 'spinning back out stops at 1:1 again');

        console.log('\n6. After a rest the wheel carries on past 1:1');
        await page.waitForTimeout(400);
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(80);
        z = await zoomOf(page, 'camA');
        check(!z.native && near(z.scale, z.nat.x * 1.1, 1e-9), `one more notch zooms to 1.1x 1:1 (${z.scale.toFixed(4)})`);
        check(!z.mode && z.badge === '110%', `native resolution is off again; the badge reads 110% of 1:1 (${z.badge})`);
        // Hovered, the badge offers the action; leaving puts the read-out back.
        const badgeBox = await page.evaluate(async () => {
            const AS = await import('/ui/app-state.js');
            const b = AS.state.views[0].canvas.closest('.video-cell').querySelector('.unzoom-btn');
            b.style.setProperty('visibility', 'visible', 'important');
            const r = b.getBoundingClientRect();
            return [r.left + r.width / 2, r.top + r.height / 2];
        });
        await page.mouse.move(badgeBox[0], badgeBox[1]);
        await page.waitForTimeout(80);
        const hoverText = (await zoomOf(page, 'camA')).badge;
        await page.mouse.move(cx, cy);
        await page.waitForTimeout(80);
        const leftText = (await zoomOf(page, 'camA')).badge;
        check(hoverText === 'Unzoom' && leftText === '110%', `hover reads "${hoverText}", leaving restores "${leftText}"`);
        await page.evaluate(async () => {
            const AS = await import('/ui/app-state.js');
            AS.state.views[0].canvas.closest('.video-cell').querySelector('.unzoom-btn').style.removeProperty('visibility');
        });

        console.log('\n7. Zooming OUT through 1:1 stops on it too; a reversal is never held');
        await page.waitForTimeout(400);
        for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -100);
        await page.waitForTimeout(400);
        for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 100);
        await page.waitForTimeout(80);
        z = await zoomOf(page, 'camA');
        check(z.native, `a fast spin out stops at 1:1 (scale ${z.scale.toFixed(4)})`);
        await page.mouse.wheel(0, -100); // reverse at once
        await page.waitForTimeout(80);
        z = await zoomOf(page, 'camA');
        check(!z.native && near(z.scale, z.nat.x * 1.1, 1e-9), 'reversing direction at once is not held');

        console.log('\n8. The + key snaps to 1:1 on the way');
        await page.keyboard.press('0');
        await page.waitForTimeout(100);
        const seen = [];
        for (let i = 0; i < 4; i++) {
            await page.keyboard.press('Equal');
            await page.waitForTimeout(60);
            z = await zoomOf(page, 'camA');
            seen.push(z.native ? '1:1' : z.scale.toFixed(3));
        }
        check(seen.includes('1:1'), `one of the + steps lands on 1:1 (${seen.join(' → ')})`);
        z = await zoomOf(page, 'camA');
        check(z.badge === Math.round(100 * z.scale / z.nat.x) + '%',
            `the badge reads the zoom as a % of 1:1 (${z.badge} at ${z.scale.toFixed(3)} / ${z.nat.x.toFixed(3)})`);
        check(seen[seen.length - 1] !== '1:1', 'and the next + leaves it');

        console.log('\n9. 1:1 survives a window resize');
        await page.keyboard.press('Shift+Digit0');
        await page.waitForTimeout(200);
        z = await zoomOf(page, 'camA');
        check(z.native, 'on');
        await page.setViewportSize({ width: 1180, height: 820 });
        await page.waitForTimeout(500);
        const z2 = await zoomOf(page, 'camA');
        check(z2.boxW !== z.boxW, `the canvas box changed (${z.boxW} → ${z2.boxW} css px)`);
        check(z2.native && z2.scale === z2.nat.x && z2.scaleY === z2.nat.y, 'the 1:1 scale was re-derived for the new box');
        score = await exactness(page, 'camA');
        check(score > 0.999, `still exact after the resize (${(score * 100).toFixed(2)}%)`);

        console.log('\n10. ...and a devicePixelRatio change (window moved to another display)');
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 1, mobile: false });
        await page.waitForTimeout(300);
        // A real display change fires the `(resolution: Ndppx)` media query's
        // change event, which runs `reapplyAllZoom`. Headless DPR emulation
        // fires neither that nor a resize, so run the handler directly. (No
        // pixel check here: Playwright keeps capturing at the context's own
        // scale after a CDP override. Section 12 checks dpr 1 from the start.)
        await page.evaluate(async () => (await import('/loading/session-loader.js')).reapplyAllZoom());
        await page.waitForTimeout(300);
        z = await zoomOf(page, 'camA');
        check(z.dpr === 1, `devicePixelRatio is now ${z.dpr}`);
        check(z.native && z.scale === z.nat.x && near(z.boxW * z.scale, 1680, 1e-9), 'the 1:1 scale follows it (1680 css px wide at dpr 1)');

        console.log('\n11. A video rotated 90° is exact at 1:1, and clicks map to the right pixel');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 2, mobile: false });
        await page.waitForTimeout(300);
        await page.evaluate(async () => (await import('/loading/session-loader.js')).reapplyAllZoom());
        await page.waitForTimeout(300);
        await page.evaluate(async () => {
            const AS = await import('/ui/app-state.js');
            const v = AS.state.views[0];
            v.rotation = 90;
            AS.videoController.reapplyZoom(v);
        });
        await page.waitForTimeout(300);
        z = await zoomOf(page, 'camA');
        check(z.native && /rotate\(90deg\)/.test(z.transform), 'rotated and native');
        score = await exactness(page, 'camA', 90);
        check(score > 0.999, `rotated 90°: every screen pixel equals its source pixel (${(score * 100).toFixed(2)}%)`);
        // Click mapping: the screen point a known video pixel is drawn at must map back to it.
        const probe = await page.evaluate(async () => {
            const AS = await import('/ui/app-state.js');
            const v = AS.state.views[0];
            const r = v.canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio;
            // 90° clockwise: video (x, y) is drawn at screen (right − y − ½, top + x + ½) device px.
            const vx = 700, vy = 500;
            return { sx: r.right - (vy + 0.5) / dpr, sy: r.top + (vx + 0.5) / dpr, vx, vy };
        });
        const mapped = await videoAt(page, 'camA', probe.sx, probe.sy);
        check(near(mapped[0], probe.vx + 0.5, 0.75) && near(mapped[1], probe.vy + 0.5, 0.75),
            `a click on video pixel (${probe.vx}, ${probe.vy}) maps to (${mapped.map(n => n.toFixed(2))})`);
        await page.evaluate(async () => {
            const AS = await import('/ui/app-state.js');
            const v = AS.state.views[0];
            v.rotation = 0;
            AS.videoController.reapplyZoom(v);
        });
        await ctx.close();
    }

    // ===== Pane rebuilds: grid → solo → cycle keeps 1:1 ====================
    // Headed, only the real display's DPR is meaningful (an emulated DPR on a
    // Retina screen is not how a real display of that DPR composites), so a
    // headed run keeps to dpr 2; headless also covers dpr 1.
    for (const dpr of (HEADED ? [2] : [2, 1])) {
        console.log(`\n12. 1:1 survives pane rebuilds (grid → solo, cycling the solo camera), at dpr ${dpr}`);
        const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: dpr });
        const page = await ctx.newPage();
        page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
        await loadProject(page, [{ name: 'camA', w: 1680, h: 1200 }, { name: 'camB', w: 1288, h: 964 }]);
        await page.keyboard.press('Shift+Digit0');
        await page.waitForTimeout(250);
        let a = await zoomOf(page, 'camA'), b = await zoomOf(page, 'camB');
        check(a.native && b.native && a.mode, 'grid: Shift+0 puts BOTH views at 1:1');
        let score = await exactness(page, 'camA');
        check(score > 0.999, `grid: camA (1680x1200) exact (${(score * 100).toFixed(2)}%)`);
        score = await exactness(page, 'camB');
        check(score > 0.999, `grid: camB (1288x964) exact (${(score * 100).toFixed(2)}%)`);

        const repaint = () => page.evaluate(() => window.__paintNoise());
        const soloName = () => page.evaluate(async () => {
            const AS = await import('/ui/app-state.js');
            return AS.state.viewMode === 'single' ? AS.state.views[AS.state.singleViewIndex].name : null;
        });
        await page.evaluate(async () => (await import('/ui/ui-wiring.js')).enterSingleViewMode());
        await page.waitForTimeout(500);
        await repaint();
        await page.waitForTimeout(150);
        const first = await soloName();
        let z = await zoomOf(page, first);
        check(z.native && z.scale === z.nat.x && z.mode, `solo ${first}: still 1:1, scale re-derived for the bigger pane`);
        score = await exactness(page, first);
        check(score > 0.999, `solo ${first} exact (${(score * 100).toFixed(2)}%)`);

        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(500);
        await repaint();
        await page.waitForTimeout(150);
        const second = await soloName();
        check(second && second !== first, `ArrowDown cycles the solo camera (${first} → ${second})`);
        z = await zoomOf(page, second);
        check(z.native && z.scale === z.nat.x && z.mode, `cycling to ${second} keeps 1:1`);
        score = await exactness(page, second);
        check(score > 0.999, `solo ${second} exact (${(score * 100).toFixed(2)}%)`);

        await page.keyboard.press('Shift+Digit0');
        await page.waitForTimeout(250);
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(500);
        z = await zoomOf(page, first);
        check((await soloName()) === first && !z.native && z.scale === 1 && !z.mode,
            `after OFF, cycling back to ${first} shows it fitted, not 1:1`);

        // A wheel snap that puts the solo view at 1:1 turns native resolution on
        // (the menu follows the screen), so the next camera comes up at 1:1 too.
        // 1:1 can be BELOW fit (a 1288x964 video in a big pane at dpr 2): then
        // it is zooming OUT that reaches it, and the range stops there.
        const [sx, sy] = await cellCentre(page, first);
        await page.mouse.move(sx, sy);
        z = await zoomOf(page, first);
        const towards = z.nat.x > z.scale ? -100 : 100;
        for (let i = 0; i < 25; i++) await page.mouse.wheel(0, towards);
        await page.waitForTimeout(400);
        z = await zoomOf(page, first);
        check(z.native && z.mode, `a wheel spin ${towards < 0 ? 'in' : 'out'} snaps solo ${first} to 1:1 (scale ${z.scale.toFixed(3)}) and turns the mode on`);
        if (towards > 0) {
            await page.mouse.wheel(0, 100);
            await page.waitForTimeout(80);
            z = await zoomOf(page, first);
            check(z.native, '1:1 below fit is the floor: zooming out further stays there');
        }
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(500);
        z = await zoomOf(page, second);
        check((await soloName()) === second && z.native && z.scale === z.nat.x,
            `...so cycling to ${second} shows it at 1:1 as well`);
        await ctx.close();
    }

    // ===== Fractional devicePixelRatios: native SIZE, exactness reported ===
    console.log('\n13. At a fractional devicePixelRatio the video is shown at its native size');
    for (const dpr of [1.25, 1.5, 2.2]) {
        const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: dpr });
        const page = await ctx.newPage();
        page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
        await loadProject(page, [{ name: 'camA', w: 1680, h: 1200 }]);
        await page.keyboard.press('Shift+Digit0');
        await page.waitForTimeout(250);
        const z = await zoomOf(page, 'camA');
        check(z.native && near(z.boxW * z.scale * z.dpr, 1680, 1e-9) && near(z.boxH * z.scaleY * z.dpr, 1200, 1e-9),
            `dpr ${dpr}: drawn 1680x1200 device px`);
        const score = await exactness(page, 'camA');
        console.log(`    dpr ${dpr}: ${(score * 100).toFixed(1)}% of screen pixels equal their source pixel (not asserted)`);
        await ctx.close();
    }

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await browser.close();
} finally {
    server.kill();
    if (releaseLock) await releaseLock();
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
