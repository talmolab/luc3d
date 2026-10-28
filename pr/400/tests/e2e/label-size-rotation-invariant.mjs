/**
 * label-size-rotation-invariant.mjs — real-browser regression test for
 * "node labels get smaller when the view is rotated".
 *
 * Reported as two screenshots of the SAME view at two Video Rotation settings
 * with visibly different label text sizes. Labels are the one overlay element
 * drawn in SCREEN-relative units (nodes and edges are video-relative, so they
 * track the animal; a name is chrome and has to hold a fixed point size), and
 * the conversion from screen px to backing-store px was being measured with
 * `ctx.canvas.getBoundingClientRect().width`.
 *
 * `getBoundingClientRect()` returns the element's AXIS-ALIGNED BOUNDING BOX
 * after CSS transforms. `applyZoom` (loading/video.js) rotates the whole
 * `.canvas-wrapper`, so at any non-zero rotation that rect is WIDER than the
 * canvas's real on-screen width — by a factor that changes with the angle, and
 * that peaks at 45 degrees. Labels were therefore divided down by that factor:
 * every rotated view drew them too small, by a different amount per angle.
 * Zoom was never affected, because a uniform scale leaves the rect exact.
 *
 * `ui/rendering.js` now derives the ratio from the canvas's LAYOUT width times
 * the zoom scale (both transform-independent) and passes it as
 * `labelDisplayScale`; `resolveLabelDisplayScale` in ui/overlays.js keeps the
 * old rect math only as a fallback for callers that don't know the geometry.
 *
 * This drives the REAL render path (`drawAllOverlays` over a real wrapper/
 * overlay-canvas pair carrying the real `applyZoom` transform) and reads the
 * font that actually reached the canvas at each rotation and zoom.
 *
 * Run: node tests/e2e/label-size-rotation-invariant.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8253);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 300)); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // ---- fixture: one camera, one labeled animal, real wrapper + overlay ----
    //
    // The DOM mirrors a real pane: a `.canvas-wrapper` sized in CSS px that
    // carries the zoom/rotation transform, with the overlay canvas absolutely
    // filling it at width:100% (the stylesheet rule, NOT an inline px width —
    // that distinction is exactly what the layout-width read has to survive).
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = ['cam1'].map(n =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]));
        const skel = new Skeleton('sk', ['nose', 'tail'], [[0, 1]]);
        const session = new Session(cams, skel, ['track_0'], 'LabelSize');

        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        const g = new InstanceGroup(10, null);
        const inst = new Instance([[200, 200], [300, 300]], 0, 'user', 1);
        g.addInstance('cam1', inst);
        fg.addInstance('cam1', inst);
        session.instanceGroups.set(0, [g]);

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 1;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();

        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:-2000px;top:0;width:400px;height:400px;';
        document.body.appendChild(host);

        const wrapper = document.createElement('div');
        wrapper.className = 'canvas-wrapper';
        // 640x480 video shown at 320x240 CSS px -> 2 backing px per CSS px.
        wrapper.style.cssText = 'position:relative;display:inline-block;width:320px;height:240px;transform-origin:0 0;';
        host.appendChild(wrapper);

        const canvas = document.createElement('canvas');
        canvas.className = 'overlay-canvas';
        canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
        wrapper.appendChild(canvas);

        AS.state.views = [{
            name: 'cam1',
            wrapper: wrapper,
            canvas: canvas,
            overlayCanvas: canvas,
            overlayCtx: canvas.getContext('2d'),
            videoWidth: 640, videoHeight: 480,
            zoom: { scale: 1, offsetX: 0, offsetY: 0 },
            rotation: 0,
        }];

        // Record every font assigned while drawing. The label font is the only
        // bold one on the skeleton path; reading ctx.font afterwards is no good
        // because the draw is wrapped in save()/restore().
        const proto = CanvasRenderingContext2D.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'font');
        window.__fonts = [];
        Object.defineProperty(proto, 'font', {
            configurable: true,
            get() { return desc.get.call(this); },
            set(v) { window.__fonts.push(String(v)); desc.set.call(this, v); },
        });
    });

    /**
     * Set rotation + zoom the way the app does (`applyZoom` writes the real CSS
     * transform), redraw, and return the label font size in backing pixels.
     */
    const labelPxAt = async (rotation, zoomScale) => page.evaluate(async ({ rot, z }) => {
        const AS = await import('/ui/app-state.js');
        const rendering = await import('/ui/rendering.js');
        const view = AS.state.views[0];
        view.rotation = rot;
        view.zoom.scale = z;

        // Mirror `applyZoom`'s transform list on the wrapper.
        const cX = 160, cY = 120; // half the 320x240 CSS box
        view.wrapper.style.transform = rot === 0
            ? `scale(${z})`
            : `translate(${cX}px, ${cY}px) rotate(${rot}deg) translate(${-cX}px, ${-cY}px) scale(${z})`;
        // Force layout so the transform is live before we measure.
        void view.wrapper.offsetWidth;

        window.__fonts = [];
        rendering.drawAllOverlays(0);

        let labelPx = null;
        for (const f of window.__fonts) {
            const m = /^bold (\d+)px/.exec(f);
            if (m) { labelPx = parseInt(m[1], 10); break; }
        }
        const rect = view.overlayCanvas.getBoundingClientRect();
        return {
            labelPx,
            backingW: view.overlayCanvas.width,
            layoutW: view.overlayCanvas.offsetWidth,
            rectW: Math.round(rect.width),
        };
    }, { rot: rotation, z: zoomScale });

    // The size the Visibility panel is asking for, in CSS px — what every
    // measurement below has to come back to.
    const wantCssPx = await page.evaluate(() =>
        parseInt(document.getElementById('visUserLabelSize').value, 10) || 11);

    // ---- baseline: unrotated, unzoomed -------------------------------------
    const base = await labelPxAt(0, 1);
    check(base.labelPx != null, `the label is drawn at all (font seen: ${base.labelPx}px)`);
    check(base.backingW === 640 && base.layoutW === 320,
        `precondition: 640 backing px over a 320 CSS px layout box (got ${base.backingW}/${base.layoutW})`);
    check(base.labelPx === wantCssPx * 2,
        `baseline label is ${wantCssPx * 2} backing px = the requested ${wantCssPx} CSS px (got ${base.labelPx})`);

    // ---- every rotation must produce the SAME label size -------------------
    for (const rot of [37, 45, 90, 137, 180, 270, -45]) {
        const r = await labelPxAt(rot, 1);
        check(r.labelPx === base.labelPx,
            `rotation ${rot}deg keeps the label at ${base.labelPx}px (got ${r.labelPx})`);
    }

    // The bug's mechanism, pinned: at 45deg the bounding rect really is much
    // wider than the layout box, so the old rect-based divisor was the thing
    // shrinking the text. Without this, the loop above could pass for the
    // wrong reason (e.g. if rotation stopped reaching the DOM at all).
    const at45 = await labelPxAt(45, 1);
    check(at45.rectW > 380,
        `precondition: at 45deg getBoundingClientRect() reports ~396px for a 320px box (got ${at45.rectW})`);
    check(at45.layoutW === 320,
        `precondition: the layout width is unchanged by the rotation (got ${at45.layoutW})`);

    // ---- zoom must not change it either, rotated or not --------------------
    //
    // Zoom grows the backing store AND the CSS-transformed display by the same
    // factor, so the backing-pixel font is expected to stay put; what the
    // assertion is really about is the quotient, i.e. the size on screen.
    const onScreenCssPx = (r, z) => r.labelPx * ((r.layoutW * z) / r.backingW);
    check(onScreenCssPx(base, 1) === wantCssPx,
        `baseline lands ${wantCssPx} CSS px on screen (got ${onScreenCssPx(base, 1)})`);

    for (const z of [1.5, 2, 4]) {
        const flat = await labelPxAt(0, z);
        check(onScreenCssPx(flat, z) === wantCssPx,
            `zoom ${z}x still lands ${wantCssPx} CSS px on screen (got ${onScreenCssPx(flat, z)})`);

        const spun = await labelPxAt(45, z);
        check(spun.labelPx === flat.labelPx,
            `zoom ${z}x at 45deg matches zoom ${z}x flat (got ${spun.labelPx} vs ${flat.labelPx})`);
        check(onScreenCssPx(spun, z) === wantCssPx,
            `zoom ${z}x at 45deg still lands ${wantCssPx} CSS px on screen (got ${onScreenCssPx(spun, z)})`);
    }

    check(errs.length === 0, `no page/console errors (got ${JSON.stringify(errs)})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
