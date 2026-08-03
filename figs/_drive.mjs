/**
 * Shared Playwright driver for the paper figures.
 *
 * Loads the trimmed 8-camera session built by scratch/figs/build_fig_session.py
 * into the REAL app (no mocks, no synthetic data) and hands back the page so each
 * figure script can pose the UI and screenshot it.
 *
 * The load path is the same one tests/e2e/_real-roundtrip.mjs uses: fetch the
 * session files over HTTP from the dev server, wrap them in File objects carrying
 * `webkitRelativePath`, and call the folder loader directly -- there is no way to
 * drive a real <input type=file webkitdirectory> from Playwright.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(__dirname, '..');
export const outDir = path.join(__dirname, 'out');
export const SESSION_REL = 'figs/session';
export const CAMS = ['Camera0_mid', 'Camera1_topB', 'Camera2_topC', 'Camera3_sideC',
                     'Camera4_topR', 'Camera5_topL', 'Camera6_sideL', 'Camera7_sideR'];

export function log(m) { process.stdout.write(m + '\n'); }

/** Start a dev server on `port` unless one is already answering there. */
export async function serve(port) {
    try {
        const r = await fetch(`http://localhost:${port}/index.html`);
        if (r.ok) { log(`[serve] reusing server on ${port}`); return null; }
    } catch { /* not up */ }
    const p = spawn('python3', ['-m', 'http.server', String(port)], { cwd: repoRoot, stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 1200));
    log(`[serve] started server on ${port}`);
    return p;
}

export async function launch({ port = 8086, width = 2560, height = 1440, scale = 2 } = {}) {
    fs.mkdirSync(outDir, { recursive: true });
    const server = await serve(port);
    const browser = await chromium.launch({
        args: ['--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
               '--use-fake-ui-for-media-stream', '--force-color-profile=srgb'],
    });
    const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: scale,
    });
    page.on('pageerror', e => log('  [pageerror] ' + String(e).slice(0, 300)));
    page.on('crash', () => log('  *** RENDERER CRASHED ***'));
    page.on('console', m => {
        const t = m.text();
        if (/error|Error|fail/i.test(t) && !/favicon/.test(t)) log('  [console] ' + t.slice(0, 220));
    });
    await page.goto(`http://localhost:${port}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO,
        { timeout: 60000 });
    log('[app] booted');
    return { browser, page, server, port };
}

/**
 * Load the trimmed session, videos included. `cams` lets a figure use a subset
 * (the calibration always declares all 8, so the loader's "missing camera
 * directories" prompt is auto-dismissed).
 */
export async function loadSession(page, { cams = CAMS, deferVideos = false } = {}) {
    await page.evaluate(() => {
        window.__dismissed = 0;
        window.__autoDismiss = setInterval(() => {
            for (const b of document.querySelectorAll('button')) {
                if (b.textContent.trim() === 'Continue' && b.offsetParent !== null) {
                    b.click(); window.__dismissed++;
                }
            }
        }, 200);
    });
    const t = Date.now();
    const res = await page.evaluate(async ({ rel, cams, deferVideos }) => {
        const sl = await import('/loading/session-loader.js');
        const root = 'figsession';
        async function grab(url, relPath) {
            const r = await fetch(url);
            if (!r.ok) throw new Error('fetch ' + url + ' -> ' + r.status);
            const f = new File([await r.arrayBuffer()], relPath.split('/').pop());
            Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
            return f;
        }
        const files = [await grab(`/${rel}/calibration.toml`, `${root}/calibration.toml`)];
        for (const cam of cams) {
            files.push(await grab(`/${rel}/${cam}/${cam}.slp`, `${root}/${cam}/${cam}.slp`));
            if (!deferVideos) {
                files.push(await grab(`/${rel}/${cam}/${cam}.mp4`, `${root}/${cam}/${cam}.mp4`));
            }
        }
        await sl.handleLoadSessionFolderPerCamera(files, deferVideos);
        const s = window.__lucid.state.session;
        return {
            hasSession: !!s,
            cameras: s ? s.cameras.map(c => c.name) : null,
            totalFrames: window.__lucid.state.totalFrames,
            tracks: s ? s.tracks.length : 0,
        };
    }, { rel: SESSION_REL, cams, deferVideos });
    await page.evaluate(() => clearInterval(window.__autoDismiss));
    log(`[load] ${Date.now() - t} ms  ${JSON.stringify(res)}`);
    if (!res.hasSession) throw new Error('session did not load');
    return res;
}

/**
 * Go to a frame and wait until it has actually been decoded and painted.
 * navigateToFrame() defers to the video controller's coalescing scrub, so the
 * frame we asked for is not current when the call returns -- poll instead of
 * sleeping a fixed amount.
 */
export async function gotoFrame(page, idx) {
    await page.evaluate(async (i) => {
        const init = await import('/pose/initialization.js');
        init.navigateToFrame(i);
    }, idx);
    await page.waitForFunction(i => window.__lucid.state.currentFrame === i, idx, { timeout: 30000 });
    await page.waitForTimeout(600);   // let the decode's overlay redraw land
}

/** Cross-view tracker over every frame. Answers its numAnimals prompt. */
export async function trackAll(page, nAnimals = 3) {
    const handler = async d => { await d.accept(String(nAnimals)); };
    page.on('dialog', handler);
    const t = Date.now();
    const res = await page.evaluate(async () => {
        const tr = await import('/pose/tracker.js');
        await tr.trackAll();
        const s = window.__lucid.state.session;
        return { identities: s.identities.length, fim: s.frameIdentityMap ? s.frameIdentityMap.size : 0 };
    });
    page.off('dialog', handler);
    log(`[trackAll] ${Date.now() - t} ms  ${JSON.stringify(res)}`);
    return res;
}

/** Group by identity + triangulate every frame (what the Triangulate All button routes to). */
export async function triangulateAll(page) {
    const t = Date.now();
    const res = await page.evaluate(async () => {
        const em = await import('/ui/export-modals.js');
        await em.groupByIdentityAndTriangulateAll();
        const s = window.__lucid.state.session;
        let groups = 0, with3d = 0;
        for (const [, gs] of s.instanceGroups) for (const g of gs) { groups++; if (g.points3d) with3d++; }
        return { groups, with3d };
    });
    log(`[triangulateAll] ${Date.now() - t} ms  ${JSON.stringify(res)}`);
    return res;
}

/**
 * Toolbar Color: 'tracks' (per-camera track colors) or 'id' (global identity
 * colors). Also forces a 2D overlay redraw and a 3D viewport rebuild, so BOTH
 * viewers show the mode -- the 3D skeletons pick their color from the same
 * getGroupColor(colorByIdentity) call, which is the whole point of the figure:
 * one color per animal in every 2D view AND in 3D.
 */
export async function setColorMode(page, mode) {
    await page.click(mode === 'id' ? '#colorById' : '#colorByTracks');
    await page.evaluate(async () => {
        const r = await import('/ui/rendering.js');
        const init = await import('/pose/initialization.js');
        const f = window.__lucid.state.currentFrame;
        r.drawAllOverlays(f);
        init.update3DViewport(f);
    });
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => window.__lucid.state.colorByIdentity);
    log(`[colorMode] ${mode} (colorByIdentity=${m})`);
}

/**
 * Timeline rows: 'tracks' (per-camera SLEAP tracks), 'identities' (global IDs) or
 * 'both'. A figure about identities must show the IDs timeline -- the Tracks
 * timeline is the per-camera fragmentation the identity step exists to fix, so
 * pairing "colored by ID" with a Tracks timeline shows the wrong thing.
 * Clicks the real toolbar button so the toggle's active state matches.
 */
export async function setTimelineMode(page, mode) {
    const clicked = await page.evaluate((m) => {
        const b = document.querySelector(`#timelineModeToggle .timeline-mode-btn[data-mode="${m}"]`);
        if (!b) return false;
        b.click();
        const tl = window.__lucid.timeline;
        if (tl && tl._displayMode !== m && typeof tl.setDisplayMode === 'function') tl.setDisplayMode(m);
        return true;
    }, mode);
    if (!clicked) { log(`[timelineMode] no button for ${mode}`); return; }
    await page.waitForTimeout(600);
    const got = await page.evaluate(() => {
        const tl = window.__lucid.timeline;
        const active = document.querySelector('#timelineModeToggle .timeline-mode-btn.active');
        return { mode: tl ? tl._displayMode : null, active: active ? active.dataset.mode : null };
    });
    log('[timelineMode] ' + JSON.stringify(got));
    if (got.mode !== mode) throw new Error(`timeline mode did not take: wanted ${mode}, got ${got.mode}`);
}

/** Toggle the right-hand info panel (more room for the 3D viewport). */
export async function togglePanel(page) {
    const btn = await page.$('#infoPanelToggleBtn');
    if (btn) { await btn.click(); await page.waitForTimeout(500); }
    else log('[panel] no toggle found');
}

/**
 * Resize the panes for a figure. The 3D viewport defaults to 400 px wide, which
 * on a real rig leaves the animals a few dozen pixels across; a figure that pairs
 * the 3D render with a camera's 2D pane wants them at comparable size and aspect.
 * `threeDWidth: 'match'` sizes the 3D pane to the active camera's aspect ratio so
 * "Show Camera View" is a true like-for-like of that 2D pane.
 */
export async function setLayout(page, { threeDWidth, hideInfoPanel, timelineHeight } = {}) {
    if (hideInfoPanel !== undefined) {
        const collapsed = await page.evaluate(() =>
            document.getElementById('infoPanelWrapper').classList.contains('collapsed'));
        if (collapsed !== hideInfoPanel) await togglePanel(page);
    }
    const res = await page.evaluate(({ threeDWidth, timelineHeight }) => {
        const v3 = document.getElementById('viewport3dContainer');
        const tl = document.getElementById('timelineContainer');
        if (timelineHeight !== undefined && tl) {
            if (timelineHeight === 0) tl.classList.add('collapsed');
            else { tl.classList.remove('collapsed'); tl.style.height = timelineHeight + 'px'; }
        }
        if (threeDWidth !== undefined && v3) {
            let w = threeDWidth;
            if (w === 'match') {
                const s = window.__lucid.state.session;
                const cam = (window.__lucid.viewport3d && window.__lucid.viewport3d._viewingCamera) ||
                            (s && s.cameras[0] && s.cameras[0].name);
                const c = s && s.cameras.find(x => x.name === cam);
                const ar = c && c.size ? (c.size[0] / c.size[1]) : (4 / 3);
                w = Math.round(v3.offsetHeight * ar);
            }
            v3.style.width = w + 'px';
        }
        const vp = window.__lucid.viewport3d;
        if (vp) vp.resize();
        if (window.__lucid.timeline) window.__lucid.timeline.resize();
        return { threeD: v3 ? [v3.offsetWidth, v3.offsetHeight] : null };
    }, { threeDWidth, timelineHeight });
    await page.waitForTimeout(500);
    log('[layout] ' + JSON.stringify(res));
    return res;
}

/** Hide the 3D viewport's floating buttons so they stay out of a figure crop. */
export async function hide3dButtons(page, hidden = true) {
    await page.evaluate((h) => {
        for (const id of ['btnShowCameraView', 'btnShowInitialView', 'btnSetEnv', 'btnClearEnv']) {
            const b = document.getElementById(id);
            if (b) b.style.visibility = h ? 'hidden' : '';
        }
    }, hidden);
}

/**
 * Aim the 3D viewport at the triangulated animals in the current frame.
 * The default camera sits at (500,-500,400) looking at the origin, which on a
 * real rig leaves the mice a few pixels across.
 */
export async function frame3d(page, { azimuth = 45, elevation = 35, pad = 3.2 } = {}) {
    const res = await page.evaluate(({ azimuth, elevation, pad }) => {
        const v = window.__lucid.viewport3d;
        const s = window.__lucid.state.session;
        if (!v || !s) return null;
        const f = window.__lucid.state.currentFrame;
        const gs = s.instanceGroups.get(f) || [];
        let n = 0, cx = 0, cy = 0, cz = 0;
        let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const g of gs) {
            const p = g.points3d;
            if (!p) continue;
            // points3d is a flat Float64Array(3N) since luc3d #189.
            for (let i = 0; i + 2 < p.length; i += 3) {
                const x = p[i], y = p[i + 1], z = p[i + 2];
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
                cx += x; cy += y; cz += z; n++;
                lo = [Math.min(lo[0], x), Math.min(lo[1], y), Math.min(lo[2], z)];
                hi = [Math.max(hi[0], x), Math.max(hi[1], y), Math.max(hi[2], z)];
            }
        }
        if (!n) return { n: 0 };
        cx /= n; cy /= n; cz /= n;
        const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6);
        const d = span * pad;
        const az = azimuth * Math.PI / 180, el = elevation * Math.PI / 180;
        v.controls.target.set(cx, cy, cz);
        v.threeCamera.position.set(
            cx + d * Math.cos(el) * Math.cos(az),
            cy + d * Math.cos(el) * Math.sin(az),
            cz + d * Math.sin(el),
        );
        v.threeCamera.up.set(0, 0, 1);
        v.threeCamera.lookAt(cx, cy, cz);
        v.controls.update();
        if (v.renderer && v.scene && v.threeCamera) v.renderer.render(v.scene, v.threeCamera);
        return { n, centroid: [cx, cy, cz].map(x => +x.toFixed(1)), span: +span.toFixed(1), dist: +d.toFixed(1) };
    }, { azimuth, elevation, pad });
    log('[frame3d] ' + JSON.stringify(res));
    await page.waitForTimeout(400);
    return res;
}

/**
 * Put the 3D viewport at a REAL camera's perspective -- the app's own "Show
 * Camera View". This is the only 3D framing that means anything in a figure: the
 * 3D skeletons then sit exactly where that camera's 2D view shows the animals, so
 * a reader can put the two panels side by side. An arbitrary orbit angle cannot be
 * checked against anything.
 *
 * Goes through selectCamera() + showSelectedCameraView() (what the button calls),
 * so it also inherits the declutter that hides the viewed camera's own frustum.
 */
export async function showCameraView(page, camName) {
    const res = await page.evaluate(async (name) => {
        const v = window.__lucid.viewport3d;
        if (!v) return { ok: false, why: 'no viewport3d' };
        const names = v.cameras.map(c => c.name);
        if (!names.includes(name)) return { ok: false, why: 'unknown camera', names };
        if (v.selectedCamera === name) v.selectCamera(name);   // clear a stale toggle
        v.selectCamera(name);
        v.showSelectedCameraView();
        return { ok: true, camera: name, fov: v.threeCamera.fov };
    }, camName);
    log('[showCameraView] ' + JSON.stringify(res));
    if (!res.ok) throw new Error('showCameraView failed: ' + JSON.stringify(res));
    // animateToCameraPerspective runs ~500 ms and the declutter fires at 550 ms.
    await page.waitForTimeout(1400);
    return res;
}

/** Back to the fitted overview (the "Show Initial View" button). */
export async function showInitialView(page) {
    await page.evaluate(() => {
        const v = window.__lucid.viewport3d;
        if (v) v.showInitialView();
    });
    await page.waitForTimeout(800);
}

/** Hide the camera frustums/labels in the 3D view (they dominate a zoomed-in shot). */
export async function set3dChrome(page, { labels, spheres, pyramids } = {}) {
    await page.evaluate(({ labels, spheres, pyramids }) => {
        const v = window.__lucid.viewport3d;
        if (!v) return;
        if (labels !== undefined) v.showCameraLabels = labels;
        if (spheres !== undefined) v.showCameraSpheres = spheres;
        if (pyramids !== undefined) v.showCameraPyramids = pyramids;
        if (typeof v.updateCameras === 'function') v.updateCameras();
        if (v.renderer) v.renderer.render(v.scene, v.threeCamera);
    }, { labels, spheres, pyramids });
    await page.waitForTimeout(300);
}

/** Dismiss any leftover loading overlay / modal so it does not sit in the shot. */
export async function clearOverlays(page) {
    await page.evaluate(() => {
        for (const b of document.querySelectorAll('button')) {
            const t = b.textContent.trim();
            if ((t === 'Continue' || t === 'OK' || t === 'Close') && b.offsetParent !== null) b.click();
        }
        const l = document.getElementById('loadingOverlay');
        if (l) l.style.display = 'none';
    });
    await page.waitForTimeout(200);
}

export async function shoot(page, name, opts = {}) {
    const p = path.join(outDir, name.endsWith('.png') ? name : name + '.png');
    await page.screenshot({ path: p, ...opts });
    const kb = (fs.statSync(p).size / 1024).toFixed(0);
    log(`[shot] ${path.relative(repoRoot, p)}  ${kb} KB`);
    return p;
}

/** Screenshot one element (a pane crop), by CSS selector. */
export async function shootEl(page, selector, name) {
    const el = await page.$(selector);
    if (!el || !(await el.isVisible())) { log(`[shot] SKIP ${name} (${selector} not visible)`); return null; }
    const p = path.join(outDir, name.endsWith('.png') ? name : name + '.png');
    await el.screenshot({ path: p });
    log(`[shot] ${path.relative(repoRoot, p)}  ${(fs.statSync(p).size / 1024).toFixed(0)} KB`);
    return p;
}

/**
 * Overlay geometry for print. The app's defaults are tuned for a screen at
 * ~1:3 CSS scale, so at native resolution the markers are chunky X's that swamp a
 * 40 mm figure tile. Sets the real Visibility sliders (so the app's own
 * getVisibilitySettings() picks them up) and redraws.
 */
export async function setOverlayStyle(page, opts = {}) {
    const applied = await page.evaluate(async (o) => {
        const set = (id, v) => {
            const el = document.getElementById(id);
            if (!el || v === undefined) return null;
            el.value = String(v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return Number(el.value);
        };
        const out = {
            predNodeSize: set('visPredNodeSize', o.predNodeSize),
            predEdgeWeight: set('visPredEdgeWeight', o.predEdgeWeight),
            userNodeSize: set('visUserNodeSize', o.userNodeSize),
            userEdgeWeight: set('visUserEdgeWeight', o.userEdgeWeight),
            userLabelSize: set('visUserLabelSize', o.userLabelSize),
            reprojNodeSize: set('visReprojNodeSize', o.reprojNodeSize),
            reprojEdgeWeight: set('visReprojEdgeWeight', o.reprojEdgeWeight),
        };
        const r = await import('/ui/rendering.js');
        r.drawAllOverlays(window.__lucid.state.currentFrame);
        return out;
    }, opts);
    await page.waitForTimeout(400);
    log('[overlayStyle] ' + JSON.stringify(applied));
    return applied;
}

/**
 * Export each camera view at NATIVE video resolution, video + overlay composited,
 * plus the 2D bounding box of the animals in that view.
 *
 * Why not element screenshots: a view pane is a CSS-scaled 1280x1024 canvas laid
 * out 4-across, so a pane crop is ~300 px wide and the mice are a few dozen pixels
 * -- unreadable in print. The canvases themselves hold full-resolution pixels, and
 * `bbox` says where the animals are, so the figure can crop tight and each tile
 * carries real detail.
 *
 * Returns [{ name, width, height, file, bbox: {x0,y0,x1,y1} | null, nInstances }].
 */
export async function exportViews(page, { cams = null, prefix = 'view', pad = 0.35, brightness = 1 } = {}) {
    const frame = await page.evaluate(() => window.__lucid.state.currentFrame);
    // Expose the app's own colour function once, so tile labels use exactly the
    // colour the overlay drew rather than a hand-picked approximation.
    await page.evaluate(async () => {
        if (!window.__figColor) {
            const ov = await import('/ui/overlays.js');
            window.__figColor = ov.getInstanceColor;
        }
    });
    const data = await page.evaluate(async ({ cams, pad, brightness }) => {
        const st = window.__lucid.state;
        const s = st.session;
        const out = [];
        const views = (st.views || []).filter(v => v && v.canvas && (!cams || cams.includes(v.name)));
        for (const v of views) {
            const w = v.canvas.width, h = v.canvas.height;
            const off = document.createElement('canvas');
            off.width = w; off.height = h;
            const c = off.getContext('2d');
            // Brightness is a CSS filter on the pane in the app, so it is NOT in
            // the canvas pixels -- apply it here or a dark IR frame prints black.
            // Applied to the video only, never to the overlay.
            if (brightness !== 1) c.filter = `brightness(${brightness})`;
            c.drawImage(v.canvas, 0, 0, w, h);
            c.filter = 'none';
            if (v.overlayCanvas) c.drawImage(v.overlayCanvas, 0, 0, w, h);

            // 2D extent of every instance drawn in this view on this frame.
            // fg.instances is a Map<camera, Instance[]>, and BEFORE grouping every
            // detection lives in fg.unlinkedInstances instead -- a figure of the
            // pre-tracking state has to read both or it finds nothing.
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
            const fg = s && s.frameGroups ? s.frameGroups.get(st.currentFrame) : null;
            const insts = [];
            if (fg) {
                for (const i of (fg.instances.get(v.name) || [])) insts.push(i);
                for (const u of (fg.unlinkedInstances.get(v.name) || [])) insts.push(u.instance);
            }
            for (const inst of insts) {
                if (!inst) continue;
                n++;
                const p = inst._xy;   // flat Float64Array(2 * nNodes), NaN = absent
                if (!p) continue;
                for (let i = 0; i + 1 < p.length; i += 2) {
                    const x = p[i], y = p[i + 1];
                    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
                    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
                }
            }
            // Per-instance detail so the composer can put a leader line + label on
            // a specific animal: centroid and box in IMAGE pixels, its track and
            // per-frame identity, and the exact colour the overlay drew it in
            // (getInstanceColor is the app's own function -- a hand-picked figure
            // colour would drift from the screenshot).
            const details = [];
            for (const inst of insts) {
                if (!inst) continue;
                const p = inst._xy;
                let ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity, sx = 0, sy = 0, k = 0;
                for (let i = 0; p && i + 1 < p.length; i += 2) {
                    const x = p[i], y = p[i + 1];
                    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                    ax0 = Math.min(ax0, x); ay0 = Math.min(ay0, y);
                    ax1 = Math.max(ax1, x); ay1 = Math.max(ay1, y);
                    sx += x; sy += y; k++;
                }
                if (!k) continue;
                const ti = inst.trackIdx;
                const track = (ti != null && s.tracks[ti] !== undefined) ? s.tracks[ti] : null;
                let identity = null;
                if (ti != null && typeof s.getIdentityIdForTrack === 'function') {
                    const iid = s.getIdentityIdForTrack(v.name, ti, st.currentFrame);
                    if (iid != null) {
                        const idObj = (s.identities || []).find(o => o.id === iid);
                        identity = idObj ? idObj.name : String(iid);
                    }
                }
                let color = null;
                try {
                    color = window.__figColor
                        ? window.__figColor(inst, s, v.name, !!st.colorByIdentity, st.currentFrame) : null;
                } catch { /* colour is a nicety, not worth failing the export */ }
                details.push({
                    track, identity, type: inst.type, color,
                    centroid: [Math.round(sx / k), Math.round(sy / k)],
                    box: [Math.round(ax0), Math.round(ay0), Math.round(ax1), Math.round(ay1)],
                    nVisible: k,
                });
            }

            let bbox = null;
            if (Number.isFinite(x0)) {
                const mx = (x1 - x0) * pad, my = (y1 - y0) * pad;
                bbox = {
                    x0: Math.max(0, Math.round(x0 - mx)), y0: Math.max(0, Math.round(y0 - my)),
                    x1: Math.min(w, Math.round(x1 + mx)), y1: Math.min(h, Math.round(y1 + my)),
                };
            }
            out.push({ name: v.name, width: w, height: h, bbox, nInstances: n, details,
                       png: off.toDataURL('image/png') });
        }
        return out;
    }, { cams, pad, brightness });

    const res = [];
    for (const d of data) {
        const file = path.join(outDir, `${prefix}-f${frame}-${d.name}.png`);
        fs.writeFileSync(file, Buffer.from(d.png.split(',')[1], 'base64'));
        const { png, ...rest } = d;
        res.push({ ...rest, frame, file });
    }
    log(`[exportViews] frame ${frame}: ${res.length} views at native res -> ${prefix}-f${frame}-*.png`);
    return res;
}

/** Dump a JSON sidecar next to the PNGs (bboxes, counts) for the composer. */
export function writeManifest(name, obj) {
    const p = path.join(outDir, name.endsWith('.json') ? name : name + '.json');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    log(`[manifest] ${path.relative(repoRoot, p)}`);
    return p;
}

export async function done({ browser, server }) {
    if (browser) await browser.close();
    if (server) server.kill();
}
