/**
 * label-upright-on-rotation.mjs — real-browser test for issue #162, "when
 * rotating views, the labels should also rotate".
 *
 * A view is rotated by a CSS transform on the whole `.canvas-wrapper`
 * (`applyZoom`, loading/video.js). The overlay canvas's own drawing transform
 * is untouched, so every glyph drawn into it rotates with the video: past ~45
 * degrees the node names stop being readable, and at 180 they are upside down.
 * The video and the skeleton MUST stay rotated — the skeleton is pinned to the
 * animal — so the only fix is for the labels to cancel the rotation themselves.
 *
 * Two halves, and this drives both through the real render path:
 *
 *  1. ORIENTATION — the transform in force at each `fillText` must cancel the
 *     view's rotation, so glyphs land horizontal on screen. Asserted on the
 *     composed CTM, not on a flag, so it is the thing the user sees.
 *
 *  2. WHEN IT REPAINTS — labels are drawn at `Math.round(view.rotation)`, so
 *     the overlays have to be redrawn at each whole-degree change. The
 *     Visibility panel's rotation field already redrew; the Shift+R+Arrow
 *     hold-to-rotate chord deliberately did NOT (it repainted once, on keyup),
 *     which would have left labels spinning with the video for the length of
 *     the gesture and snapping upright only when the key came up.
 *
 * Run: node tests/e2e/label-upright-on-rotation.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8254);
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

    // ---- fixture: one camera, one grouped animal, in a REAL dock pane -------
    //
    // The pane is real (`paneManager.addAllViewsAsGrid`) rather than a
    // hand-built wrapper, because the Shift+R+Arrow chord resolves its target
    // through `getActiveView()` -> `paneManager.api.activePanel` ->
    // `panelRenderers`. A faked canvas would leave the chord inert and the
    // second half of this test asserting nothing.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cam = new Camera('cam1', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
        const skel = new Skeleton('sk', ['nose', 'tail'], [[0, 1]]);
        const session = new Session([cam], skel, ['track_0'], 'UprightLabels');

        // Edge straight down the canvas, so the largest gap — and therefore the
        // label — is unambiguously on the other side of the node.
        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        const g = new InstanceGroup(10, null);
        const inst = new Instance([[320, 200], [320, 400]], 0, 'user', 1);
        g.addInstance('cam1', inst);
        fg.addInstance('cam1', inst);
        session.instanceGroups.set(0, [g]);

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 1;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = [{ name: 'cam1', videoWidth: 640, videoHeight: 480, canvas: null }];
        AS.state.videoFiles = [{ name: 'cam1', assignedCamera: 'cam1' }];
        AS.state.viewMode = 'grid';
        AS.state.singleViewIndex = 0;

        AS.paneManager.clearAll();
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
        await new Promise(r => requestAnimationFrame(r));

        // Record, for every fillText, the rotation the glyphs carry and where
        // the anchor lands once the transform is applied. The composition is
        // the point: a counter-rotation that moved the text somewhere useless
        // would sail through an orientation-only check.
        const proto = CanvasRenderingContext2D.prototype;
        const origFill = proto.fillText;
        window.__placed = [];
        proto.fillText = function (t, x, y) {
            const m = this.getTransform();
            window.__placed.push({
                text: String(t),
                rotationDeg: Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI),
                x: m.a * x + m.c * y + m.e,
                y: m.b * x + m.d * y + m.f,
            });
            return origFill.call(this, t, x, y);
        };

        // Count real repaints. `drawAllOverlays` is imported by value in
        // ui-wiring.js so it cannot be patched from outside; clearRect on the
        // view's overlay is the first thing every redraw does, and nothing else
        // touches that canvas.
        window.__draws = 0;
        const ctx = AS.state.views[0].overlayCtx;
        const origClear = ctx.clearRect.bind(ctx);
        ctx.clearRect = function (x, y, w, h) { window.__draws++; return origClear(x, y, w, h); };
    });

    const paneOk = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const v = AS.state.views[0];
        return { hasCanvas: !!v.overlayCanvas, hasWrapper: !!v.wrapper };
    });
    check(paneOk.hasCanvas && paneOk.hasWrapper,
        'precondition: the dock built a real canvas + wrapper for the view');

    // Rotate the way the app does. `applyZoom` writes the CSS transform the
    // labels have to cancel; with no video loaded there is no videoController,
    // so the same transform is written directly — it is what the user sees, and
    // what the orientation assertions below are stated against.
    const drawAt = async (rotation) => page.evaluate(async (rot) => {
        const AS = await import('/ui/app-state.js');
        const rendering = await import('/ui/rendering.js');
        const view = AS.state.views[0];
        view.rotation = rot;
        if (AS.videoController) {
            AS.videoController.applyZoom(view);
        } else if (view.wrapper) {
            const cX = view.wrapper.offsetWidth / 2, cY = view.wrapper.offsetHeight / 2;
            view.wrapper.style.transformOrigin = '0 0';
            view.wrapper.style.transform = rot
                ? `translate(${cX}px, ${cY}px) rotate(${rot}deg) translate(${-cX}px, ${-cY}px)`
                : '';
        }
        window.__placed = [];
        rendering.drawAllOverlays(0);
        return window.__placed.slice();
    }, rotation);

    // ---- 1. orientation -----------------------------------------------------
    const flat = await drawAt(0);
    const flatNose = flat.find(p => p.text === 'nose');
    check(!!flatNose, `the node label is drawn (saw ${JSON.stringify(flat.map(p => p.text))})`);
    check(flatNose && flatNose.rotationDeg === 0,
        `an unrotated view draws glyphs unrotated (got ${flatNose && flatNose.rotationDeg})`);

    for (const rot of [30, 45, 90, 137, 180, 270, -45]) {
        const placed = await drawAt(rot);
        const nose = placed.find(p => p.text === 'nose');
        if (!nose) { check(false, `label present at ${rot}deg`); continue; }
        // The wrapper is rotated +rot by CSS; the glyphs must carry -rot so the
        // two cancel and the text lands horizontal on screen.
        const net = ((nose.rotationDeg + rot) % 360 + 360) % 360;
        check(net === 0,
            `at ${rot}deg the glyphs are drawn at ${nose.rotationDeg}deg — upright on screen`);
        // And the label still belongs to the node it NAMES rather than being
        // flung off. Measured against the other node (200px away down the
        // skeleton) instead of a fixed pixel budget: the offset scales with the
        // label's own width, so an absolute threshold would just be a magic
        // number tuned to the word "nose".
        const toNose = Math.hypot(nose.x - 320, nose.y - 200);
        const toTail = Math.hypot(nose.x - 320, nose.y - 400);
        check(toNose < toTail,
            `at ${rot}deg the label stays with the node it names ` +
            `(${Math.round(toNose)}px to nose vs ${Math.round(toTail)}px to tail)`);
    }

    // The track-name pill takes a different path (`drawNamePill`) and carries a
    // background plate, which has to rotate WITH the text or the text escapes it.
    const pilled = await drawAt(180);
    const pill = pilled.find(p => p.text === 'track_0');
    check(!!pill, `the track pill is drawn (saw ${JSON.stringify(pilled.map(p => p.text))})`);
    check(pill && ((pill.rotationDeg + 180) % 360 + 360) % 360 === 0,
        `the track pill is upright at 180deg too (got ${pill && pill.rotationDeg})`);

    // ---- 2. the Visibility panel's rotation field ---------------------------
    // Already redrew before #162; assert it, because the labels are only correct
    // if a repaint follows every discrete change.
    const fieldResult = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const panes = await import('/ui/sessions-panes.js');
        AS.state.views[0].rotation = 0;
        // Builds the Visibility panel's brightness / contrast / rotation tables.
        panes.populateViewStrip();
        const container = document.getElementById('visVideoRotationTable');
        const num = container && container.querySelector('input[type=number]');
        if (!num) return { ok: false, why: 'no rotation field' };
        window.__draws = 0;
        num.value = '75';
        num.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, draws: window.__draws, rotation: AS.state.views[0].rotation };
    });
    check(fieldResult.ok, `the Visibility panel exposes a rotation field (${fieldResult.why || 'yes'})`);
    check(fieldResult.rotation === 75, `typing 75 sets the view rotation (got ${fieldResult.rotation})`);
    check(fieldResult.draws >= 1, `a discrete field change repaints the overlays (got ${fieldResult.draws})`);

    // ---- 3. the Shift+R+Arrow chord ----------------------------------------
    // The chord's rAF loop advances `view.rotation` fractionally. Labels are
    // drawn at the ROUNDED degree, so a repaint is owed on each whole-degree
    // step — and owed only then, which is what keeps this off a per-frame
    // redraw of every view.
    const chord = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const rendering = await import('/ui/rendering.js');
        const view = AS.state.views[0];
        view.rotation = 0;

        // Calibrate: one `drawAllOverlays` clears each view's overlay exactly
        // once, but measure it rather than assume, so the counts below are in
        // REDRAWS and stay honest if the draw path changes.
        window.__draws = 0;
        rendering.drawAllOverlays(0);
        const clearsPerDraw = window.__draws;

        const press = (init) => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
        const release = (init) => document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, ...init }));

        window.__draws = 0;
        const frameAtStart = AS.state.currentFrame;
        // Shift goes down first, so the R keydown carries shiftKey — the
        // gesture as documented ("hold Shift + R + arrow"). It matters: a BARE
        // `r` is the catalog binding for Toggle Reprojections, and pressing R
        // before Shift fires that too. Not this change's to fix, but a test
        // that pressed R bare would be measuring that toggle's repaint as well.
        press({ code: 'KeyR', key: 'r', shiftKey: true });
        press({ key: 'ArrowRight', shiftKey: true });
        const afterStep = { rotation: view.rotation, draws: window.__draws, frame: AS.state.currentFrame };

        await new Promise(r => setTimeout(r, 350));
        const duringHold = { rotation: view.rotation, draws: window.__draws };

        release({ key: 'ArrowRight' });
        release({ code: 'KeyR', key: 'r', shiftKey: true });
        await new Promise(r => setTimeout(r, 50));
        const afterRelease = { rotation: view.rotation, draws: window.__draws };

        return { clearsPerDraw, frameAtStart, afterStep, duringHold, afterRelease };
    });

    // The chord only engages when a pane is active; if this environment has no
    // dock panel the gesture is inert, and saying so beats a misleading pass.
    const chordEngaged = chord.afterStep.rotation !== 0;
    check(chordEngaged,
        `the Shift+R+Arrow chord engages (rotation went to ${chord.afterStep.rotation})`);
    if (chordEngaged) {
        check(chord.clearsPerDraw === 1,
            `calibration: one redraw clears the single view's overlay once (got ${chord.clearsPerDraw})`);
        const redraws = (n) => n / chord.clearsPerDraw;

        check(redraws(chord.afterStep.draws) === 1,
            `the first discrete 1-degree step repaints exactly once ` +
            `(got ${redraws(chord.afterStep.draws)})`);
        // The chord must not ALSO step the frame. This project has no decoder,
        // and the video-less arrow handler used to run before the chord guard
        // was reached — so rotating stepped frames underneath the user.
        check(chord.afterStep.frame === chord.frameAtStart,
            `the chord does not also step the frame (${chord.frameAtStart} -> ${chord.afterStep.frame})`);

        const degreesTurned = Math.abs(chord.duringHold.rotation - chord.afterStep.rotation);
        check(degreesTurned >= 2,
            `the hold actually turned the view (${degreesTurned.toFixed(1)}deg over ~350ms)`);

        // One repaint per whole degree crossed, give or take the partial degree
        // at each end. The UPPER bound is the assertion that matters: it is
        // what holds this to a per-degree redraw instead of an unconditional
        // per-animation-frame redraw of every view.
        const held = redraws(chord.duringHold.draws) - redraws(chord.afterStep.draws);
        check(held >= 2,
            `the hold repaints as it turns, not only on keyup (got ${held} redraws)`);
        check(held <= Math.ceil(degreesTurned) + 1,
            `and repaints per DEGREE, not per frame (got ${held} redraws for ` +
            `${degreesTurned.toFixed(1)}deg)`);

        check(Number.isInteger(chord.afterRelease.rotation),
            `keyup snaps to a whole degree (got ${chord.afterRelease.rotation})`);
        check(redraws(chord.afterRelease.draws) === redraws(chord.duringHold.draws) + 1,
            `keyup repaints exactly once more, at the final angle ` +
            `(${redraws(chord.duringHold.draws)} -> ${redraws(chord.afterRelease.draws)})`);
    }

    check(errs.length === 0, `no page/console errors (got ${JSON.stringify(errs)})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
