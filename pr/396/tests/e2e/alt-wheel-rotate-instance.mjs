/**
 * alt-wheel-rotate-instance.mjs — Alt/Option + mouse wheel over a node turns
 * the whole instance about that node (issue #198, SLEAP parity).
 *
 * The unit suite (`tests/test-instance-rotate.js`) covers the arithmetic and
 * the gesture state machine against a synthetic canvas. What it structurally
 * cannot cover is the part that actually broke the feature's usefulness: the
 * overlay canvas lives INSIDE the `.video-cell` that owns wheel-to-zoom
 * (`loading/video.js` `setupZoomHandlers`), so rotation and zoom are two
 * listeners on the same wheel event. This drives the real app with real
 * Chromium wheel input and asserts they do not both fire:
 *
 *   - Alt+wheel over a node   → the instance turns, the zoom does NOT change.
 *   - plain wheel over a node → the zoom changes, the instance does NOT turn.
 *   - Alt+wheel over EMPTY canvas, and over the cell's letterbox margin where
 *     no overlay canvas is under the cursor at all → nothing happens. While
 *     Option is held the wheel belongs to rotation, so a scroll that strays
 *     off the skeleton cannot zoom the view out from under a rotation in
 *     progress. The margin case only `loading/video.js`'s own `altKey` guard
 *     can cover, which is why it is asserted here and not in the unit suite.
 *   - releasing Alt hands zoom straight back.
 *
 * It also pins the 6-degrees-per-notch rate and the clockwise-on-scroll-up
 * sense against a real browser's wheel deltas rather than a synthesized one.
 *
 * Run: node tests/e2e/alt-wheel-rotate-instance.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8271);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// The fixture instance: a pivot and one arm 80 video-px to its right.
const PIVOT = [200, 200];
const ARM = [280, 200];

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // ---- A one-camera project with a single two-node user instance --------
    await page.evaluate(async ([pivot, arm]) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = [new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])];
        const skel = new Skeleton('sk', ['pivot', 'arm'], [[0, 1]]);
        const session = new Session(cams, skel, ['track_0'], 'Rotate');

        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        const g = new InstanceGroup(10, 0);
        const inst = new Instance([pivot.slice(), arm.slice()], 0, 'user', 1);
        g.addInstance('camA', inst);
        fg.addInstance('camA', inst);
        session.instanceGroups.set(0, [g]);

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 10;
        AS.state.currentFrame = 0;
        AS.state.fps = 30;
        AS.state.isPlaying = false;
        AS.state.triangulationResults = new Map();
        AS.state.views = [{ name: 'camA', videoWidth: 640, videoHeight: 480, canvas: null }];
        AS.state.videoFiles = [{ name: 'camA', assignedCamera: 'camA' }];
        AS.state.viewMode = 'grid';
        AS.state.singleViewIndex = 0;

        AS.paneManager.clearAll();
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
        await new Promise(r => requestAnimationFrame(r));
        // Attaches the InteractionManager AND the video cell's wheel-to-zoom —
        // both listeners this test is here to disambiguate.
        sp.refreshPaneInteractions();
        await new Promise(r => requestAnimationFrame(r));
    }, [PIVOT, ARM]);

    /** Read the instance points and the view's zoom scale. */
    const snap = () => page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const inst = AS.state.session.instanceGroups.get(0)[0].getInstance('camA');
        const v = AS.state.views[0];
        return {
            pts: [[inst.getX(0), inst.getY(0)], [inst.getX(1), inst.getY(1)]],
            zoom: v.zoom ? v.zoom.scale : 1,
            modified: !!inst.modified,
        };
    });

    /** Screen position of a video-space point on camA's overlay canvas. */
    const screenOf = (vx, vy) => page.evaluate(async ([x, y]) => {
        const AS = await import('/ui/app-state.js');
        const c = AS.state.views[0].overlayCanvas;
        const r = c.getBoundingClientRect();
        const vw = AS.state.views[0].videoWidth;
        const vh = AS.state.views[0].videoHeight;
        return [r.left + (x / vw) * r.width, r.top + (y / vh) * r.height];
    }, [vx, vy]);

    const base = await snap();
    check(near(base.pts[0][0], PIVOT[0], 1e-6) && near(base.pts[1][0], ARM[0], 1e-6),
        'fixture instance starts where it was placed');

    const overlayOk = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const c = AS.state.views[0].overlayCanvas;
        return !!c && c.getBoundingClientRect().width > 50;
    });
    check(overlayOk, 'camA overlay canvas is laid out on screen');

    // ---- 1. Alt + wheel up over the pivot node ---------------------------
    let [px, py] = await screenOf(PIVOT[0], PIVOT[1]);
    await page.mouse.move(px, py);
    await page.keyboard.down('Alt');
    for (let i = 0; i < 15; i++) await page.mouse.wheel(0, -100); // 15 notches up
    await page.keyboard.up('Alt');
    await page.waitForTimeout(500); // past the gesture's idle-commit window

    let s = await snap();
    check(near(s.pts[0][0], PIVOT[0], 0.5) && near(s.pts[0][1], PIVOT[1], 0.5),
        `pivot node holds still (${s.pts[0].map(n => n.toFixed(2))})`);
    // 15 notches * 6 degrees = 90 degrees clockwise: the arm at +x swings to +y.
    check(near(s.pts[1][0], PIVOT[0], 0.5) && near(s.pts[1][1], PIVOT[1] + 80, 0.5),
        `arm swung 90 degrees clockwise (${s.pts[1].map(n => n.toFixed(2))}, expected ${[PIVOT[0], PIVOT[1] + 80]})`);
    check(near(s.zoom, base.zoom, 1e-9),
        `the view did NOT also zoom (scale ${s.zoom}, was ${base.zoom})`);
    check(s.modified, 'the instance is marked modified');

    // ---- 2. The other direction ------------------------------------------
    await page.keyboard.down('Alt');
    for (let i = 0; i < 15; i++) await page.mouse.wheel(0, 100); // 15 notches down
    await page.keyboard.up('Alt');
    await page.waitForTimeout(500);

    s = await snap();
    check(near(s.pts[1][0], ARM[0], 0.5) && near(s.pts[1][1], ARM[1], 0.5),
        `scrolling back down returns the arm to where it started (${s.pts[1].map(n => n.toFixed(2))})`);

    // ---- 3. A plain wheel over the same node must still zoom -------------
    const beforeZoom = await snap();
    [px, py] = await screenOf(PIVOT[0], PIVOT[1]);
    await page.mouse.move(px, py);
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(200);

    s = await snap();
    check(s.zoom > beforeZoom.zoom,
        `plain wheel still zooms in (scale ${s.zoom} > ${beforeZoom.zoom})`);
    check(near(s.pts[1][0], ARM[0], 1e-6) && near(s.pts[1][1], ARM[1], 1e-6),
        'plain wheel leaves the instance alone');

    // ---- 4. Alt + wheel over empty canvas must do NOTHING ---------------
    const beforeEmpty = await snap();
    const [ex, ey] = await screenOf(560, 420); // far from either node
    await page.mouse.move(ex, ey);
    await page.keyboard.down('Alt');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Alt');
    await page.waitForTimeout(200);

    s = await snap();
    check(near(s.zoom, beforeEmpty.zoom, 1e-9),
        `Alt+wheel over empty canvas does NOT zoom (scale ${s.zoom}, was ${beforeEmpty.zoom})`);
    check(near(s.pts[1][0], ARM[0], 1e-6),
        'Alt+wheel over empty canvas leaves the instance alone');

    // ---- 5. ...including the letterbox margin outside the overlay canvas -
    // The rotation listener is on the overlay canvas, which does not fill the
    // cell. Only `loading/video.js`'s own altKey guard covers this gap.
    const margin = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const c = AS.state.views[0].overlayCanvas;
        const cell = c.closest('.video-cell');
        if (!cell) return null;
        const cr = cell.getBoundingClientRect();
        const kr = c.getBoundingClientRect();
        // A point inside the cell but outside the canvas, if there is one.
        if (kr.top - cr.top > 6) return [kr.left + kr.width / 2, cr.top + 3];
        if (kr.left - cr.left > 6) return [cr.left + 3, kr.top + kr.height / 2];
        if (cr.bottom - kr.bottom > 6) return [kr.left + kr.width / 2, cr.bottom - 3];
        if (cr.right - kr.right > 6) return [cr.right - 3, kr.top + kr.height / 2];
        return null;
    });
    if (margin) {
        const beforeMargin = await snap();
        await page.mouse.move(margin[0], margin[1]);
        await page.keyboard.down('Alt');
        await page.mouse.wheel(0, -100);
        await page.keyboard.up('Alt');
        await page.waitForTimeout(200);
        s = await snap();
        check(near(s.zoom, beforeMargin.zoom, 1e-9),
            `Alt+wheel in the cell's letterbox margin does NOT zoom (scale ${s.zoom}, was ${beforeMargin.zoom})`);
    } else {
        console.log("  - (no letterbox margin in this layout; margin case not exercised)");
    }

    // ---- 6. Releasing Alt hands zoom straight back ----------------------
    const beforeRestore = await snap();
    await page.mouse.move(px, py);
    await page.mouse.wheel(0, -100); // no Alt held
    await page.waitForTimeout(200);
    s = await snap();
    check(s.zoom > beforeRestore.zoom,
        `zoom works again as soon as Alt is released (scale ${s.zoom} > ${beforeRestore.zoom})`);

    check(errs.length === 0, 'no page errors: ' + (errs[0] || 'none'));

    await browser.close();
} finally {
    server.kill('SIGTERM');
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL — ${fails} check(s)`);
process.exit(fails === 0 ? 0 : 1);
