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
// Which session folder to load, relative to the repo root. Fig 1/2 use the trimmed
// 8-camera HardFight clip; Fig 6 points this at a SLAP-2M session instead.
export const SESSION_REL = process.env.SESSION_REL || 'figs/session';
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

/**
 * Frame the WHOLE RIG -- every camera frustum plus the animals -- from a chosen
 * orbit angle, zoomed out only as far as it takes to fit.
 *
 * `showInitialView()` (the app's own fit) frames the scene's own bounds, which on
 * this rig leaves the animals a few pixels across: unusable in print. This instead
 * fits a bounding sphere over the camera positions AND the 3D points, so "zoomed
 * out just enough" is computed rather than guessed.
 *
 *   startCam     take the orbit AZIMUTH from this real camera, so the view is
 *                anchored to an actual viewpoint in the rig rather than an
 *                arbitrary angle. Its own elevation is returned for reference.
 *   elevation    degrees above the horizontal. Low elevation puts the overhead
 *                cameras high in the frame and the animals low, which is what a
 *                reader needs to see that the rig looks DOWN at the arena.
 *   pad          multiplies the fitting distance (1.0 = tight fit).
 *   targetBias   raises the look-at point by this fraction of the scene radius,
 *                which pushes the animals toward the bottom of the frame and gives
 *                the cameras the upper part of it.
 */
export async function rigFit(page, { startCam = null, elevation = 22, pad = 1.12,
                                     targetBias = 0.28, fov = 50, fill = 0.86 } = {}) {
    const res = await page.evaluate(({ startCam, elevation, pad, targetBias, fov, fill }) => {
        const v = window.__lucid.viewport3d;
        const s = window.__lucid.state.session;
        if (!v || !s) return null;
        // Every rig camera's world position, via the app's own -R^T t.
        const cams = v.cameras.map(c => ({
            name: c.name,
            p: v._computeCameraPosition(c.rotationMatrix, c.tvec),
        }));
        // The animals, this frame.
        const gs = s.instanceGroups.get(window.__lucid.state.currentFrame) || [];
        const pts = [];
        for (const g of gs) {
            const p = g.points3d;
            if (!p) continue;
            for (let i = 0; i + 2 < p.length; i += 3) {
                if (Number.isFinite(p[i]) && Number.isFinite(p[i + 1]) && Number.isFinite(p[i + 2])) {
                    pts.push([p[i], p[i + 1], p[i + 2]]);
                }
            }
        }
        if (!pts.length) return { n: 0 };
        const mean = (a, k) => a.reduce((s2, q) => s2 + q[k], 0) / a.length;
        const animals = [mean(pts, 0), mean(pts, 1), mean(pts, 2)];
        const camMean = [mean(cams.map(c => c.p), 0), mean(cams.map(c => c.p), 1),
                         mean(cams.map(c => c.p), 2)];

        // WHICH WAY IS UP. This rig's calibration frame has +Z pointing DOWN: the
        // overhead cameras have a SMALLER z than the animals on the floor. Assuming
        // Z-up (the app's viewport default) renders the rig upside down -- animals
        // floating above the cameras, which is how the first pass of this panel came
        // out. So take "up" from the data: the cameras really are above the animals,
        // so whichever Z direction points from the animals toward the cameras is up.
        const zsign = camMean[2] < animals[2] ? -1 : 1;

        // Orbit azimuth: from a real camera if asked, else keep the current one.
        let az;
        const sc = startCam ? cams.find(c => c.name === startCam) : null;
        if (sc) {
            az = Math.atan2(sc.p[1] - animals[1], sc.p[0] - animals[0]);
        } else {
            az = Math.atan2(v.threeCamera.position.y - animals[1],
                            v.threeCamera.position.x - animals[0]);
        }
        // Elevation of the chosen camera above the animals, in the corrected frame.
        const startElev = sc
            ? Math.atan2(zsign * (sc.p[2] - animals[2]),
                         Math.hypot(sc.p[0] - animals[0], sc.p[1] - animals[1])) * 180 / Math.PI
            : null;

        // Aim a little way UP from the animals so they sit low in the frame and the
        // cameras get the upper part of it.
        let spread = 0;
        for (const q of cams.map(c => c.p).concat(pts)) {
            const d = Math.hypot(q[0] - animals[0], q[1] - animals[1], q[2] - animals[2]);
            if (d > spread) spread = d;
        }
        const target = [animals[0], animals[1], animals[2] + zsign * targetBias * spread];
        // Bounding sphere about that target, so nothing is cropped.
        let radius = 0;
        for (const q of cams.map(c => c.p).concat(pts)) {
            const d = Math.hypot(q[0] - target[0], q[1] - target[1], q[2] - target[2]);
            if (d > radius) radius = d;
        }
        const el = elevation * Math.PI / 180;
        // Distance that fits the sphere in the NARROWER of the two FOVs.
        const aspect = v.threeCamera.aspect || 1;
        const vfov = fov * Math.PI / 180;
        const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
        const dist = radius / Math.sin(Math.min(vfov, hfov) / 2) * pad;
        v.threeCamera.fov = fov;
        v.threeCamera.up.set(0, 0, zsign);
        v.controls.target.set(target[0], target[1], target[2]);
        v.threeCamera.position.set(
            target[0] + dist * Math.cos(el) * Math.cos(az),
            target[1] + dist * Math.cos(el) * Math.sin(az),
            target[2] + zsign * dist * Math.sin(el),
        );
        v.threeCamera.lookAt(target[0], target[1], target[2]);
        v.threeCamera.updateProjectionMatrix();
        v.controls.update();

        // SCREEN-SPACE FIT. Fitting a bounding SPHERE about a chosen target is safe
        // but both loose and off-centre: the rig is a flat-ish shell, not a ball, and
        // its centroid is not where the content lands on screen. The first pass of
        // this panel used ~40% of the frame with everything crowded into one corner.
        // Instead, iterate on what the render actually shows -- project the real
        // content, take its NDC bounding box, then (i) scale the viewing distance so
        // the box spans `fill` of the frame and (ii) PAN so the box is centred.
        // Panning moves the target and the camera together, so orientation (and
        // therefore which way is up) is untouched. Cameras still end up in the upper
        // part of the frame and animals in the lower part because that is their real
        // arrangement once the up vector is right -- it does not need to be forced.
        const content = cams.map(c => c.p).concat(pts);
        const rect0 = v.renderer.domElement.getBoundingClientRect();
        const projectNDC = (p) => new THREE.Vector3(p[0], p[1], p[2]).project(v.threeCamera);
        for (let pass = 0; pass < 4; pass++) {
            let nx0 = Infinity, ny0 = Infinity, nx1 = -Infinity, ny1 = -Infinity;
            for (const p of content) {
                const q = projectNDC(p);
                if (q.x < nx0) nx0 = q.x;
                if (q.x > nx1) nx1 = q.x;
                if (q.y < ny0) ny0 = q.y;
                if (q.y > ny1) ny1 = q.y;
            }
            const spanX = nx1 - nx0, spanY = ny1 - ny0;
            const span = Math.max(spanX, spanY);           // NDC spans [-1,1] => 2 is full
            if (!(span > 1e-6)) break;

            // --- pan so the content box is centred ---
            const cxNdc = (nx0 + nx1) / 2, cyNdc = (ny0 + ny1) / 2;
            const camPos = v.threeCamera.position;
            const fwd = new THREE.Vector3(target[0] - camPos.x, target[1] - camPos.y,
                                          target[2] - camPos.z);
            const dist2 = fwd.length();
            fwd.normalize();
            const upv0 = new THREE.Vector3(0, 0, zsign);
            const right = new THREE.Vector3().crossVectors(fwd, upv0).normalize();
            const upv = new THREE.Vector3().crossVectors(right, fwd).normalize();
            const vfov2 = v.threeCamera.fov * Math.PI / 180;
            const hfov2 = 2 * Math.atan(Math.tan(vfov2 / 2) * (v.threeCamera.aspect || 1));
            const shift = new THREE.Vector3()
                .addScaledVector(right, cxNdc * Math.tan(hfov2 / 2) * dist2)
                .addScaledVector(upv, cyNdc * Math.tan(vfov2 / 2) * dist2);
            target[0] += shift.x; target[1] += shift.y; target[2] += shift.z;
            camPos.add(shift);

            // --- scale the distance so the box fills the frame ---
            const k = span / (2 * fill);                   // >1 too big, <1 too small
            const cur = new THREE.Vector3(camPos.x - target[0], camPos.y - target[1],
                                          camPos.z - target[2]).multiplyScalar(k);
            v.threeCamera.position.set(target[0] + cur.x, target[1] + cur.y, target[2] + cur.z);
            v.controls.target.set(target[0], target[1], target[2]);
            v.threeCamera.lookAt(target[0], target[1], target[2]);
            v.threeCamera.updateProjectionMatrix();
            v.controls.update();
        }
        if (v.renderer) v.renderer.render(v.scene, v.threeCamera);

        // Where each camera and each animal LANDED in the rendered pixels. The app's
        // own 3D labels are screen-space bitmaps sized for interactive use: at print
        // size they overlap into an unreadable pile. Returning the projected
        // positions lets the figure draw its own labels, typeset to the journal's
        // spec, with leaders where they would otherwise collide.
        const rect = rect0;
        const project = (p) => {
            const q = new THREE.Vector3(p[0], p[1], p[2]).project(v.threeCamera);
            return {
                x: +(((q.x + 1) / 2) * rect.width).toFixed(1),
                y: +(((1 - q.y) / 2) * rect.height).toFixed(1),
                behind: q.z > 1,
            };
        };
        return {
            n: pts.length, nCams: cams.length, zsign,
            radius: +radius.toFixed(1), dist: +dist.toFixed(1),
            azimuth_deg: +(az * 180 / Math.PI).toFixed(1),
            elevation_deg: elevation,
            startCam, startCamElevation_deg: startElev === null ? null : +startElev.toFixed(1),
            pane: [Math.round(rect.width), Math.round(rect.height)],
            camScreen: cams.map(c => ({ name: c.name, ...project(c.p) })),
            animalsScreen: project(animals),
        };
    }, { startCam, elevation, pad, targetBias, fov, fill });
    log('[rigFit] ' + JSON.stringify(res));
    await page.waitForTimeout(400);
    return res;
}

/**
 * Camera frustums / labels / reference grid in the 3D view.
 *
 * NOTE the rebuild call is `addCameraPyramids()`. An earlier version of this helper
 * guarded on `updateCameras()`, which does not exist on the viewport -- so the flags
 * were set and never applied, and `labels: false` silently did nothing.
 */
export async function set3dChrome(page, { labels, spheres, pyramids, grid,
                                        pyramidLength, sphereSize } = {}) {
    await page.evaluate(({ labels, spheres, pyramids, grid, pyramidLength, sphereSize }) => {
        const v = window.__lucid.viewport3d;
        if (!v) return;
        if (grid !== undefined && v.scene) {
            // The reference grid is a bare THREE.GridHelper added straight to the
            // scene at world Z=0. On this rig Z=0 is ABOVE everything, so the grid
            // floats over the frustums and reads as a mystery plane in print.
            v.scene.traverse((c) => {
                if (c.type === 'GridHelper' || c.isGridHelper) c.visible = grid;
            });
        }
        // Frustum and marker SIZE. The defaults (pyramidLength 40, sphere 3) are for
        // an interactive view; in a 58 mm panel the pyramids overlap into a thicket
        // and dwarf the animals they are pointed at.
        if (pyramidLength !== undefined) v.pyramidLength = pyramidLength;
        if (sphereSize !== undefined) v.cameraSphereSize = sphereSize;
        if (labels !== undefined) v.showCameraLabels = labels;
        if (spheres !== undefined) v.showCameraSpheres = spheres;
        if (pyramids !== undefined) v.showCameraPyramids = pyramids;
        if (typeof v.addCameraPyramids === 'function') v.addCameraPyramids();
        else if (typeof v.updateCameras === 'function') v.updateCameras();
        if (v.renderer) v.renderer.render(v.scene, v.threeCamera);
    }, { labels, spheres, pyramids, grid, pyramidLength, sphereSize });
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
/**
 * Toggle the overlay VISIBILITY checkboxes -- the app's real controls, the same ones
 * a user clicks in the Visibility panel: `user`, `predicted`, `reprojections`,
 * `errors`, `legend`. Fig 2's protocol panels turn predictions OFF in the views that
 * are standing in for "not yet labelled", so what remains in those views is only
 * what LUC3D drew for you: the reprojection.
 */
export async function setVisibility(page, opts = {}) {
    const applied = await page.evaluate(async (o) => {
        const ids = {
            user: 'visUser', predicted: 'visPredicted', reprojections: 'visReprojections',
            errors: 'visErrors', legend: 'visLegend',
        };
        const out = {};
        for (const [k, id] of Object.entries(ids)) {
            if (o[k] === undefined) continue;
            const el = document.getElementById(id);
            if (!el) { out[k] = null; continue; }
            if (el.checked !== o[k]) el.click();       // click, so the app's handler runs
            out[k] = el.checked;
        }
        const r = await import('/ui/rendering.js');
        r.drawAllOverlays(window.__lucid.state.currentFrame);
        return out;
    }, opts);
    await page.waitForTimeout(400);
    log('[visibility] ' + JSON.stringify(applied));
    return applied;
}

/**
 * Include/exclude camera views for tracking AND triangulation, through the app's own
 * Camera Views weights (Tracking Wizard ▸ Camera Views; weight 1 = included,
 * 0 = excluded). Fig 2 uses this to triangulate from ONLY the two anchor views, so
 * the reprojections drawn into the other views really are derived from two views --
 * not from all eight and then relabelled as if they were.
 *
 * `anchors` is the list of camera names to KEEP; everything else goes to weight 0.
 */
export async function setAnchorViews(page, anchors) {
    const res = await page.evaluate(async (keep) => {
        const st = await import('/ui/settings.js');
        const s = window.__lucid.state.session;
        const map = {};
        for (const c of s.cameras) map[c.name] = keep.includes(c.name) ? 1 : 0;
        st.setCameraWeights(map);
        return { weights: st.getCameraWeights(), included: keep };
    }, anchors);
    log('[anchorViews] ' + JSON.stringify(res));
    await page.waitForTimeout(200);
    return res;
}

/**
 * The app's own per-view reprojection errors for the current frame, straight out of
 * state.triangulationResults -- the same numbers the Instance Info panel shows. Used
 * so Fig 2's annotations quote what this run measured rather than a round number.
 */
export async function reprojErrors(page) {
    const res = await page.evaluate(async () => {
        const st = window.__lucid.state;
        const f = st.currentFrame;
        // state.triangulationResults ACCUMULATES per frame -- re-triangulating after
        // changing the camera weights appends a second set rather than replacing the
        // first, so reading it straight gives a mix of the old and new solves. Drop
        // the frame's entry and let the renderer recompute it, which also guarantees
        // the numbers correspond to the camera weights currently in force.
        if (st.triangulationResults) st.triangulationResults.delete(f);
        const s = st.session;
        for (const g of (s.instanceGroups.get(f) || [])) {
            // Reset to EMPTY containers, not null: getReprojectedInstance() does a
            // .get() on the Map and rendering.js does Object.keys() on the object,
            // so nulling them throws instead of forcing a recompute.
            g.reprojectedInstances = new Map();
            g.reprojections = {};
        }
        const r = await import('/ui/rendering.js');
        r.drawAllOverlays(f);
        const rs = st.triangulationResults && st.triangulationResults.get(f);
        if (!rs) return null;
        const mean = (a) => {
            const v = (a || []).filter(x => Number.isFinite(x));
            return v.length ? v.reduce((p, q) => p + q, 0) / v.length : null;
        };
        return rs.map((res2) => {
            // errors is { cameraName: [perKeypointError, ...] } -- an ARRAY per view,
            // not a scalar. Average the finite entries to get that view's error.
            const per = {};
            for (const [nm, arr] of Object.entries(res2.errors || {})) {
                const m = mean(arr);
                if (m != null) per[nm] = +m.toFixed(2);
            }
            const g = res2.group || {};
            return {
                identity: g.identity != null ? g.identity
                          : (g.identityId != null ? g.identityId : null),
                meanError: Number.isFinite(res2.meanError) ? +res2.meanError.toFixed(2) : null,
                perView: per,
                nViews: Object.keys(per).length,
            };
        });
    });
    log('[reprojErrors] ' + JSON.stringify(res));
    return res;
}

/**
 * Okabe-Ito identity colours, applied to the LIVE app rather than to the app's source.
 *
 * `pose/pose-data.js` ships IDENTITY_COLORS as saturated primaries -- '#00ff00',
 * '#ff00ff', '#00ffff' for the first three identities. Those are the three that appear
 * in every figure that shows more than one animal, and under deuteranopia the green and
 * the magenta converge: the two mice a reader is meant to tell apart become the same
 * colour. Nature requires figures to be legible to colourblind readers, so the tiles
 * have to be re-exported with an accessible palette.
 *
 * This mutates the module's exported `var` and then rewrites `.color` on every identity
 * already constructed (the constructor only reads the palette at construction time, so
 * changing the array alone would leave a loaded session on the old colours). The app on
 * disk is deliberately NOT edited: its palette is tuned for on-screen work against dark
 * video, several figures depend on the app rendering exactly what a user sees, and
 * changing a shared app constant to serve the figure pipeline is the kind of edit that
 * breaks verified-working behaviour elsewhere.
 *
 * Pass `colors` to override. Default order keeps hue separation maximal for the first
 * three, which is where it matters.
 */
export async function setIdentityPalette(page, colors = null) {
    const OKABE_ITO = [
        '#00b478',  // bluish green, lifted for contrast against dark video
        '#e69f00',  // orange
        '#56b4e9',  // sky blue
        '#cc79a7',  // reddish purple
        '#f0e442',  // yellow
        '#0072b2',  // blue
        '#d55e00',  // vermillion
        '#999999',  // grey
    ];
    const res = await page.evaluate(async (pal) => {
        const pd = await import('/pose/pose-data.js');
        // exported `var`, so assignable; splice in place so any module that captured a
        // reference to the array sees the change too
        pd.IDENTITY_COLORS.length = 0;
        for (const c of pal) pd.IDENTITY_COLORS.push(c);
        const s = window.__lucid.state.session;
        const applied = [];
        for (const id of (s.identities || [])) {
            id.color = pal[id.id % pal.length];
            applied.push({ id: id.id, name: id.name, color: id.color });
        }
        return { palette: pal.length, identities: applied };
    }, colors || OKABE_ITO);
    log('[identityPalette] ' + JSON.stringify(res));
    await page.waitForTimeout(120);
    return res;
}

/**
 * The COMPLETE 26-edge plotting skeleton for the 15-node SLAP mouse, copied
 * verbatim from figs/src/skeleton_style.py MOUSE_EDGES (itself verbatim from
 * viz_08 cell 16 via blender-images/cage_scene.py -- keep the copies in sync).
 * The sessions' own .slp skeletons carry a sparser edge set that reads as spiky
 * lines rather than a mouse at print size; the figure tiles override to this
 * list so the app's own renderer draws the full ears/shoulder/haunch/spine/tail
 * chain. A few pairs duplicate each other as unordered edges (e.g.
 * Haunch_right--TTI appears twice); that is how viz_08 drew it, the overdraw is
 * invisible (opaque strokes of one colour), so the list is kept verbatim.
 */
export const MOUSE_EDGES = [
    ['TailTip', 'Tail_2'], ['Tail_2', 'Tail_1'], ['Tail_1', 'Tail_0'], ['Tail_0', 'TTI'],
    ['TTI', 'Trunk'], ['Trunk', 'Neck'], ['Neck', 'Head'], ['Head', 'Nose'],
    ['TTI', 'Haunch_left'], ['TTI', 'Haunch_right'], ['Trunk', 'Haunch_right'], ['Trunk', 'Haunch_left'],
    ['Neck', 'Shoulder_left'], ['Neck', 'Shoulder_right'], ['Ear_L', 'Head'], ['Ear_R', 'Head'],
    ['Ear_L', 'Nose'], ['Ear_R', 'Nose'], ['Shoulder_left', 'Head'], ['Shoulder_right', 'Head'],
    ['Shoulder_left', 'Haunch_left'], ['Shoulder_right', 'Haunch_right'],
    ['Haunch_right', 'TTI'], ['Haunch_left', 'TTI'],
    ['Shoulder_left', 'Shoulder_right'], ['Haunch_left', 'Haunch_right'],
];

/**
 * Replace the loaded session's skeleton EDGE list with `namePairs` (node-name
 * pairs, default MOUSE_EDGES) and redraw, applied to the LIVE app rather than to
 * the session files or the app source (same philosophy as setIdentityPalette).
 *
 * Display-only, and verified so: nothing on the tracking/triangulation path
 * reads skeleton.edges -- the only consumers are the 2D overlay drawers
 * (ui/overlays.js drawFrameOverlays reads session.skeleton live on every draw),
 * the 3D viewport (Viewport3D captured the SAME state.session.skeleton object at
 * construction, so an in-place splice reaches it too), the info panel, and the
 * save/export writers (which the figure scripts never call). Nodes, instances,
 * and tracker settings are untouched; the figure scripts additionally prove it
 * by diffing their manifests' numeric payloads against the pre-override runs.
 *
 * Fails loudly on an unknown node name instead of silently dropping the edge --
 * a session with different node names would otherwise export a bare skeleton.
 */
export async function setSkeletonEdges(page, namePairs = MOUSE_EDGES) {
    const res = await page.evaluate(async (pairs) => {
        const s = window.__lucid.state.session;
        if (!s || !s.skeleton) return { ok: false, why: 'no session/skeleton' };
        const sk = s.skeleton;
        // nodes are plain name strings in these sessions, but the drawers also
        // accept { name } objects -- handle both.
        const names = sk.nodes.map(n => (typeof n === 'string' ? n : (n && n.name)));
        const missing = [];
        const edges = [];
        for (const [a, b] of pairs) {
            const ia = names.indexOf(a), ib = names.indexOf(b);
            if (ia < 0 || ib < 0) { missing.push(`${a}--${b}`); continue; }
            edges.push([ia, ib]);
        }
        if (missing.length) return { ok: false, why: 'unknown node(s)', missing, names };
        // REPLACE in place: Viewport3D holds a reference to this same array's
        // owner object, so mutating rather than reassigning updates 2D and 3D.
        const nBefore = sk.edges.length;
        sk.edges.length = 0;
        for (const e of edges) sk.edges.push(e);
        // Refresh the way the app's own mutators do (cf. setColorMode): redraw
        // every 2D overlay and rebuild the 3D skeletons for the current frame.
        const r = await import('/ui/rendering.js');
        const init = await import('/pose/initialization.js');
        const f = window.__lucid.state.currentFrame;
        r.drawAllOverlays(f);
        init.update3DViewport(f);
        return { ok: true, nNodes: names.length, edgesBefore: nBefore, edgesAfter: sk.edges.length };
    }, namePairs);
    log('[skeletonEdges] ' + JSON.stringify(res));
    if (!res.ok) throw new Error('setSkeletonEdges failed: ' + JSON.stringify(res));
    await page.waitForTimeout(400);
    return res;
}

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
            // 0 hides the reprojection's identity labels. A magnified crop is the
            // one place they hurt: a label sized for a whole pane covers the animal.
            reprojLabelSize: set('visReprojLabelSize', o.reprojLabelSize),
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
