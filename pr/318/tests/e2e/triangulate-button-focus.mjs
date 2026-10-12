/**
 * triangulate-button-focus.mjs — the Triangulate split buttons must not keep
 * focus after a pointer click (issue #230).
 *
 * Reported: "when I click on `Triangulate` or `Triangulate All`, the button
 * enters a 'selected' state that disables keyboard shortcuts until I de-select
 * the button."
 *
 * Both symptoms are one cause. `installFocusRelease` (ui/keyboard-target.js)
 * hands focus back after a pointer activates a button — but it was a DELEGATED
 * listener on `document`, and `wireTriDropdown` (ui/ui-wiring.js) calls
 * `e.stopPropagation()` on these two buttons so their click does not also close
 * the toolbar menus. The click therefore never reached the release listener,
 * the button stayed `document.activeElement` (which is what renders as
 * "selected"), and `targetOwnsKey` correctly handed Space and Enter to the
 * focused button instead of to the app — the transport went dead until
 * something else was clicked.
 *
 * The fix registers that listener in the CAPTURE phase, so no control can opt
 * itself out of focus release by stopping propagation. Case 3 pins the general
 * property rather than these two ids, since the same trap catches any future
 * button that stops propagation.
 *
 * The keyboard path is deliberately NOT changed, and case 4 asserts it: someone
 * who TABS to Triangulate keeps focus after activating it with Enter.
 *
 * Run: node tests/e2e/triangulate-button-focus.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8263);
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

    // A project with frames but no decoder — enough for the transport to
    // observe play/pause, without shipping an .mp4 fixture. Deliberately with
    // NO group selected: what the triangulate handler does is irrelevant here,
    // and an unselected click is the cheapest way to reach the focus path.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        // Two CALIBRATED cameras on purpose: `triangulateCurrentFrame` opens a
        // blocking "calibration required" overlay when every rvec/tvec is zero
        // (`sessionHasCalibration`), and that overlay would then swallow the
        // clicks this test is here to make.
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = [
            new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.5, 0], [-200, 0, 0], [640, 480]),
        ];
        const skel = new Skeleton('sk', ['nose', 'tail'], [[0, 1]]);
        const session = new Session(cams, skel, ['track_0'], 'TriFocus');

        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        const g = new InstanceGroup(10, null);
        const instA = new Instance([[200, 200], [300, 300]], 0, 'user', 1);
        const instB = new Instance([[210, 200], [310, 300]], 0, 'user', 1);
        g.addInstance('camA', instA);
        g.addInstance('camB', instB);
        fg.addInstance('camA', instA);
        fg.addInstance('camB', instB);
        session.instanceGroups.set(0, [g]);

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 100;
        AS.state.currentFrame = 0;
        AS.state.fps = 30;
        AS.state.isPlaying = false;
        AS.state.triangulationResults = new Map();
        AS.state.views = [
            { name: 'camA', videoWidth: 640, videoHeight: 480, canvas: null },
            { name: 'camB', videoWidth: 640, videoHeight: 480, canvas: null },
        ];
        AS.state.videoFiles = [
            { name: 'camA', assignedCamera: 'camA' },
            { name: 'camB', assignedCamera: 'camB' },
        ];
        AS.state.viewMode = 'grid';
        AS.state.singleViewIndex = 0;

        AS.paneManager.clearAll();
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
        await new Promise(r => requestAnimationFrame(r));
    });

    // `installFocusRelease` blurs on a deferred turn, so every observation of
    // `activeElement` has to yield one first. Timers are FIFO: a setTimeout(0)
    // queued after the click's runs after the blur that click scheduled.
    const snap = () => page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        await new Promise(r => setTimeout(r, 0));
        const a = document.activeElement;
        return {
            frame: AS.state.currentFrame,
            playing: !!AS.state.isPlaying,
            activeId: a ? (a.id || a.tagName) : null,
        };
    });
    const reset = () => page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        AS.state.currentFrame = 0;
        AS.state.isPlaying = false;
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    });

    // ---- 1 & 2. The reported bug, once per button --------------------------
    for (const id of ['tbTriangulate', 'tbTriangulateAll']) {
        await reset();
        await page.click('#' + id);
        let s = await snap();
        check(s.activeId !== id,
            `clicking #${id} does not leave it holding focus (activeElement=${s.activeId})`);

        await page.keyboard.press('Space');
        s = await snap();
        check(s.playing === true,
            `Space after clicking #${id} reaches the transport (isPlaying=${s.playing})`);

        await reset();
        await page.click('#' + id);
        await page.keyboard.press('ArrowRight');
        s = await snap();
        check(s.frame === 1,
            `the arrow keys still step frames after clicking #${id} (frame=${s.frame})`);
    }

    // ---- 3. The general property, not just those two ids -------------------
    // A button whose own handler stops propagation is exactly the shape that
    // defeated the bubble-phase listener. Pin the rule, so the next split
    // button added to the toolbar cannot silently reintroduce this.
    await reset();
    // A REAL pointer click, not `btn.click()`: a scripted click leaves
    // :focus-visible set, which release deliberately honours (case 4), so a
    // synthetic one would pass whether or not the bug is present.
    await page.evaluate(() => {
        const btn = document.createElement('button');
        btn.id = '__stopPropProbe';
        btn.className = 'toolbar-btn';
        btn.textContent = 'probe';
        btn.addEventListener('click', function (e) { e.stopPropagation(); });
        document.getElementById('toolbar').appendChild(btn);
    });
    await page.click('#__stopPropProbe');
    const stopped = await snap();
    check(stopped.activeId !== '__stopPropProbe',
        `a button that calls stopPropagation() still gets focus released (activeElement=${stopped.activeId})`);
    await page.evaluate(() => { document.getElementById('__stopPropProbe').remove(); });

    // ---- 4. KEYBOARD focus is left alone -----------------------------------
    // Tab rather than .focus(): only a real keyboard focus sets :focus-visible,
    // which is what the blur rule keys on.
    await reset();
    await page.evaluate(() => { document.getElementById('tbEditGroup').focus(); });
    for (let i = 0; i < 6; i++) {
        await page.keyboard.press('Tab');
        const id = await page.evaluate(() => document.activeElement.id);
        if (id === 'tbTriangulate') break;
    }
    const kb = await page.evaluate(() => ({
        id: document.activeElement.id,
        focusVisible: document.activeElement.matches(':focus-visible'),
    }));
    check(kb.id === 'tbTriangulate' && kb.focusVisible === true,
        `Tab reaches #tbTriangulate with keyboard focus (id=${kb.id}, :focus-visible=${kb.focusVisible})`);

    await page.keyboard.press('Enter');
    const s = await snap();
    check(s.activeId === 'tbTriangulate',
        `Enter on a TAB-focused Triangulate keeps keyboard focus (activeElement=${s.activeId})`);
    check(s.playing === false,
        `and does not also start playback (isPlaying=${s.playing})`);

    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        AS.state.isPlaying = false;
    });

    check(errs.length === 0, `no page/console errors (got ${JSON.stringify(errs)})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
