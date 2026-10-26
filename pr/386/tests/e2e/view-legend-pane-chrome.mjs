/**
 * view-legend-pane-chrome.mjs — the Display Legend key is pane chrome, not
 * something painted into the rotating video.
 *
 * It used to be drawn onto the overlay CANVAS by `drawLegend`, anchored to that
 * canvas's top-right. Three consequences, all fixed by moving it into the DOM
 * as a sibling of `.canvas-wrapper` (ui/view-legend.js):
 *
 *  1. It sat INSIDE the element `applyZoom` rotates, so it tipped over with the
 *     video — upside down in the bottom-left at 180 degrees.
 *  2. "Top-right" meant the top-right of the VIDEO, so on a letterboxed pane it
 *     was pushed inside the picture with empty bar beside it.
 *  3. A fixed 310 CANVAS px is a different number of screen px per camera
 *     resolution, so legends disagreed in size between views.
 *
 * The export path still burns a legend into its frames via `drawLegend` — there
 * is no DOM in an encoded video — so this also checks that function survives.
 *
 * Run: node tests/e2e/view-legend-pane-chrome.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8255);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 300)); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // Two cameras with DIFFERENT resolutions — the third bug above only shows
    // up when the legend has two differently-scaled canvases to disagree across.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = [
            new Camera('camWide', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [1920, 1080]),
            new Camera('camSmall', K, [0, 0, 0, 0, 0], [0, 0.2, 0], [15, 0, 0], [640, 480]),
        ];
        const skel = new Skeleton('sk', ['nose', 'tail'], [[0, 1]]);
        const session = new Session(cams, skel, ['track_0'], 'LegendChrome');

        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        const g = new InstanceGroup(10, null);
        for (const c of cams) {
            const inst = new Instance([[200, 200], [300, 300]], 0, 'user', 1);
            g.addInstance(c.name, inst);
            fg.addInstance(c.name, inst);
        }
        session.instanceGroups.set(0, [g]);

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 1;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = [
            { name: 'camWide', videoWidth: 1920, videoHeight: 1080, canvas: null },
            { name: 'camSmall', videoWidth: 640, videoHeight: 480, canvas: null },
        ];
        AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name }));
        AS.state.viewMode = 'grid';
        AS.state.singleViewIndex = 0;

        AS.paneManager.clearAll();
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
        await new Promise(r => requestAnimationFrame(r));
    });

    const setLegend = async (on) => page.evaluate(async (want) => {
        const rendering = await import('/ui/rendering.js');
        const cb = document.getElementById('visLegend');
        cb.checked = want;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        rendering.drawAllOverlays(0);
        await new Promise(r => requestAnimationFrame(r));
    }, on);

    const readLegends = () => page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        return AS.state.views.map(v => {
            const cell = (v.overlayCanvas || v.canvas).closest('.video-cell');
            const el = cell && cell.querySelector(':scope > .view-legend');
            if (!el) return { view: v.name, present: false };
            const r = el.getBoundingClientRect();
            const cr = cell.getBoundingClientRect();
            return {
                view: v.name,
                present: true,
                rows: Array.from(el.querySelectorAll('.view-legend-row span')).map(s => s.textContent),
                // Distance from the PANE's corners, not the video's.
                fromPaneTop: Math.round(r.top - cr.top),
                fromPaneRight: Math.round(cr.right - r.right),
                width: Math.round(r.width),
                height: Math.round(r.height),
                // Is it a descendant of the element applyZoom transforms?
                insideWrapper: !!el.closest('.canvas-wrapper'),
                pointerEvents: getComputedStyle(el).pointerEvents,
            };
        });
    });

    // ---- off by default, and the toggle drives it ---------------------------
    await setLegend(false);
    let legends = await readLegends();
    check(legends.every(l => !l.present),
        `Display Legend off: no legend element in any pane (${JSON.stringify(legends.map(l => l.present))})`);

    await setLegend(true);
    legends = await readLegends();
    check(legends.every(l => l.present),
        `Display Legend on: every pane gets one (${JSON.stringify(legends.map(l => l.present))})`);
    check(legends.every(l => l.rows.join(',') === 'Detected,Reprojected,Error vector'),
        `and it lists the same rows drawLegend does (${JSON.stringify(legends[0].rows)})`);

    // ---- it is pane chrome, not video paint --------------------------------
    check(legends.every(l => !l.insideWrapper),
        'the legend is OUTSIDE .canvas-wrapper, so no view transform can reach it');
    check(legends.every(l => l.pointerEvents === 'none'),
        `and never eats a click meant for a keypoint (pointer-events: ${legends[0].pointerEvents})`);
    check(legends.every(l => l.fromPaneTop <= 12 && l.fromPaneRight <= 12),
        `anchored to the PANE's top-right (${JSON.stringify(legends.map(l => [l.fromPaneTop, l.fromPaneRight]))})`);

    // Same size in both panes despite 1920x1080 vs 640x480 — the old canvas
    // legend was a fixed count of CANVAS pixels, which is a different number of
    // screen pixels per camera.
    check(legends[0].width === legends[1].width && legends[0].height === legends[1].height,
        `identical size across a 1920x1080 and a 640x480 view ` +
        `(${legends[0].width}x${legends[0].height} vs ${legends[1].width}x${legends[1].height})`);

    // ---- rotation cannot touch it ------------------------------------------
    const rotated = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const rendering = await import('/ui/rendering.js');
        const out = [];
        for (const deg of [0, 45, 90, 180, 270]) {
            const view = AS.state.views[0];
            view.rotation = deg;
            if (AS.videoController) {
                AS.videoController.applyZoom(view);
            } else if (view.wrapper) {
                const cX = view.wrapper.offsetWidth / 2, cY = view.wrapper.offsetHeight / 2;
                view.wrapper.style.transformOrigin = '0 0';
                view.wrapper.style.transform = deg
                    ? `translate(${cX}px, ${cY}px) rotate(${deg}deg) translate(${-cX}px, ${-cY}px)`
                    : '';
            }
            rendering.drawAllOverlays(0);
            const cell = view.overlayCanvas.closest('.video-cell');
            const el = cell.querySelector(':scope > .view-legend');
            const m = new DOMMatrix(getComputedStyle(el).transform === 'none'
                ? 'matrix(1,0,0,1,0,0)' : getComputedStyle(el).transform);
            const r = el.getBoundingClientRect();
            const cr = cell.getBoundingClientRect();
            out.push({
                deg,
                rotationDeg: Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI),
                fromPaneTop: Math.round(r.top - cr.top),
                fromPaneRight: Math.round(cr.right - r.right),
            });
        }
        return out;
    });
    for (const r of rotated) {
        check(r.rotationDeg === 0,
            `at view rotation ${r.deg}deg the legend is still upright (got ${r.rotationDeg}deg)`);
    }
    const anchors = rotated.map(r => `${r.fromPaneTop},${r.fromPaneRight}`);
    check(new Set(anchors).size === 1,
        `and never moves from the pane's top-right (${JSON.stringify(anchors)})`);

    // ---- nothing is painted onto the canvas any more ------------------------
    const painted = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const rendering = await import('/ui/rendering.js');
        AS.state.views[0].rotation = 0;
        const proto = CanvasRenderingContext2D.prototype;
        const origDraw = proto.drawImage;
        const origFill = proto.fillText;
        let images = 0;
        const texts = [];
        proto.drawImage = function (...a) { images++; return origDraw.apply(this, a); };
        proto.fillText = function (t, x, y) { texts.push(String(t)); return origFill.call(this, t, x, y); };
        rendering.drawAllOverlays(0);
        proto.drawImage = origDraw;
        proto.fillText = origFill;
        return { images, texts };
    });
    check(!painted.texts.includes('Detected') && !painted.texts.includes('Error vector'),
        `the live redraw paints no legend text onto the canvas (${JSON.stringify(painted.texts)})`);

    // ---- but drawLegend still works, for the export -------------------------
    const exported = await page.evaluate(async () => {
        const ov = await import('/ui/overlays.js');
        const c = document.createElement('canvas');
        c.width = 800; c.height = 600;
        const ctx = c.getContext('2d');
        const texts = [];
        const origFill = CanvasRenderingContext2D.prototype.fillText;
        CanvasRenderingContext2D.prototype.fillText = function (t, x, y) {
            texts.push(String(t));
            return origFill.call(this, t, x, y);
        };
        ov.drawLegend(ctx, { showDetected: true, showReprojected: true, showErrors: true });
        CanvasRenderingContext2D.prototype.fillText = origFill;
        return texts;
    });
    check(exported.includes('Detected') && exported.includes('Reprojected') && exported.includes('Error vector'),
        `drawLegend still burns a legend in for the video export (${JSON.stringify(exported)})`);

    check(errs.length === 0, `no page/console errors (got ${JSON.stringify(errs)})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
