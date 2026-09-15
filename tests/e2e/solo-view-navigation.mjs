/**
 * solo-view-navigation.mjs — single-view ("solo") mode navigation in the real
 * app, driven through real keyboard and mouse events.
 *
 * `tests/test-view-mode.js` only simulates the index arithmetic in isolation, so
 * it says nothing about the four behaviours that actually changed here. Each of
 * these is only observable against the real dock + view strip:
 *
 *  1. `v` enters solo mode on the last-interacted view, and pressing it AGAIN
 *     does nothing. It used to double as the cycler, so you could never press it
 *     to confirm you were solo without landing on a different camera.
 *  2. Up / Down step through the view strip's order — which is `state.views`
 *     order, what `populateViewStrip` renders — and WRAP at both ends. The dock
 *     must actually follow: asserting `singleViewIndex` alone would pass on an
 *     implementation that never rebuilt the pane.
 *  3. A SINGLE click in the view strip opens that view, replacing the solo'd
 *     one. This previously took a double-click, and that double-click DOCKED A
 *     SECOND PANE next to the solo'd view instead of swapping it — so the
 *     one-pane assertion is the real content of this check.
 *  4. `g` returns to the grid with the last-viewed camera still selected, and
 *     pressing it AGAIN does nothing — the restore is a full `clearAll()` +
 *     `fromJSON()`, so repeating it used to rebuild every pane and move the
 *     selection to whichever panel dockview happened to activate. Concretely:
 *     yellow `strip-selected` highlight, `lastInteractedView` (which is what
 *     new instances get created on) and the 3D camera highlight all point at it.
 *     The grid comes back via `api.fromJSON()`, which builds panels behind
 *     `addVideoPanel`'s back — so this also covers `syncDockedViews()`, without
 *     which the restored grid reports nothing docked and a strip click on an
 *     on-screen view does nothing.
 *
 * Run: node solo-view-navigation.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8194);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;   // absent demo assets
        console.log('  [console.error]', t.slice(0, 300));
        fails++;
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const CAMS = ['camA', 'camB', 'camC', 'camD'];

    // Build a 4-camera session in grid mode, exactly as switchSession would.
    await page.evaluate(async (camNames) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Skeleton, Camera, Session } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const cams = camNames.map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [640, 480]));
        const session = new Session(cams, skel, ['track_0'], 'S1');

        AS.state.sessions = [session];
        AS.state.session = session;
        AS.state.activeSessionIdx = 0;
        AS.state.views = cams.map(c => ({
            name: c.name, videoWidth: 640, videoHeight: 480, canvas: null,
        }));
        AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name }));
        AS.state.viewMode = 'grid';
        AS.state.singleViewIndex = 0;
        AS.paneManager.clearAll();
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
        // Pretend the user was last working in camC, so entering solo has a
        // non-zero starting index to land on (index 0 would pass by accident).
        // The grid-mode no-op check below also clicks camC, which sets the same
        // thing through the real code path.
        if (AS.interactionManager) AS.interactionManager.lastInteractedView = 'camC';
        await new Promise(r => requestAnimationFrame(r));
    }, CAMS);

    // Snapshot of everything the dock + strip are showing right now.
    const snap = () => page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const docked = Array.from(AS.paneManager.api.panels)
            .map(p => sp.panelRenderers.get(p.id))
            .filter(Boolean)
            .map(r => r.getViewName());
        return {
            mode: AS.state.viewMode,
            idx: AS.state.singleViewIndex,
            docked,
            dockedViews: Array.from(AS.paneManager.dockedViews.entries()).sort(),
            stripSelected: Array.from(document.querySelectorAll('.view-strip-item.strip-selected'))
                .map(el => el.getAttribute('data-view-name')),
            lastInteracted: AS.interactionManager ? AS.interactionManager.lastInteractedView : null,
            selected3dCamera: AS.viewport3d ? (AS.viewport3d.selectedCamera || null) : null,
            indicator: (function () {
                const el = document.getElementById('viewModeIndicator');
                return el ? el.textContent : null;
            })(),
        };
    });

    const press = async (key) => {
        await page.evaluate(() => document.body.focus());
        await page.keyboard.press(key);
        await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
    };

    // Precondition: grid mode with every camera docked.
    let s = await snap();
    check(s.mode === 'grid', 'starts in grid mode');
    check(s.docked.length === 4, `grid docks all 4 views (got ${s.docked.length})`);

    // `g` while already in grid mode must not touch anything. Select a pane
    // first so there IS a selection for a stray rebuild to lose.
    await page.click('.view-strip-item[data-view-name="camC"]');
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
    const beforeG = await snap();
    check(beforeG.stripSelected.join() === 'camC',
        `a pane is selected before the no-op check (got [${beforeG.stripSelected}])`);
    for (let i = 0; i < 3; i++) await press('g');
    s = await snap();
    check(s.mode === 'grid' && s.docked.length === 4,
        `g in grid mode keeps the grid (mode ${s.mode}, ${s.docked.length} panes)`);
    check(s.docked.join() === beforeG.docked.join(),
        `g in grid mode does not reorder the panes (got [${s.docked}])`);
    check(s.stripSelected.join() === 'camC',
        `g in grid mode does NOT move the selection (got [${s.stripSelected}])`);
    check(s.lastInteracted === 'camC',
        `g in grid mode leaves lastInteractedView alone (got ${s.lastInteracted})`);

    // =================================================================
    // 1 — `v` enters solo on the last-interacted view; repeats do nothing
    // =================================================================
    await press('v');
    s = await snap();
    check(s.mode === 'single', 'v enters single-view mode');
    check(s.idx === 2, `v lands on the last-interacted view camC (idx ${s.idx})`);
    check(s.docked.length === 1 && s.docked[0] === 'camC',
        `dock shows only camC (got [${s.docked}])`);
    check(s.indicator === 'camC (3/4)', `indicator reads "camC (3/4)" (got "${s.indicator}")`);

    for (let i = 0; i < 3; i++) await press('v');
    s = await snap();
    check(s.mode === 'single' && s.idx === 2,
        `v pressed 3 more times does NOT cycle (mode ${s.mode}, idx ${s.idx})`);
    check(s.docked.length === 1 && s.docked[0] === 'camC',
        `dock still shows only camC (got [${s.docked}])`);

    // =================================================================
    // 2 — Up / Down walk the strip order and wrap at both ends
    // =================================================================
    await press('ArrowDown');
    s = await snap();
    check(s.idx === 3 && s.docked.join() === 'camD', `Down: camC -> camD (got [${s.docked}])`);

    await press('ArrowDown');   // wrap off the bottom
    s = await snap();
    check(s.idx === 0 && s.docked.join() === 'camA',
        `Down wraps camD -> camA (idx ${s.idx}, [${s.docked}])`);

    await press('ArrowUp');     // wrap off the top
    s = await snap();
    check(s.idx === 3 && s.docked.join() === 'camD',
        `Up wraps camA -> camD (idx ${s.idx}, [${s.docked}])`);

    await press('ArrowUp');
    s = await snap();
    check(s.idx === 2 && s.docked.join() === 'camC', `Up: camD -> camC (got [${s.docked}])`);
    check(s.indicator === 'camC (3/4)', `indicator follows the arrows (got "${s.indicator}")`);
    check(s.stripSelected.join() === 'camC',
        `strip highlights the solo'd view (got [${s.stripSelected}])`);

    // The frame-stepping arrows are untouched: left/right must NOT change view.
    const frameBefore = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        AS.state.totalFrames = 100;
        return AS.state.currentFrame;
    });
    await press('ArrowRight');
    s = await snap();
    const frameAfter = await page.evaluate(async () =>
        (await import('/ui/app-state.js')).state.currentFrame);
    check(s.idx === 2 && s.docked.join() === 'camC',
        'ArrowRight does not change the solo view');
    check(frameAfter === frameBefore + 1,
        `ArrowRight still steps the frame (${frameBefore} -> ${frameAfter})`);

    // =================================================================
    // 3 — a SINGLE click in the strip opens that view, replacing the solo'd one
    // =================================================================
    // Guard: the click has to be a real transition, so make sure camB is NOT
    // what's already on screen. Without this the check below could pass on an
    // implementation where the click does nothing at all.
    check(s.docked.join() !== 'camB', `camB is not already solo'd (showing [${s.docked}])`);
    await page.click('.view-strip-item[data-view-name="camB"]');
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
    s = await snap();
    check(s.mode === 'single', 'single click keeps single-view mode');
    check(s.idx === 1, `single click on camB solos it (idx ${s.idx})`);
    check(s.docked.length === 1 && s.docked[0] === 'camB',
        `click SWAPS the pane rather than docking a second (got [${s.docked}])`);
    check(s.indicator === 'camB (2/4)', `indicator reads "camB (2/4)" (got "${s.indicator}")`);

    // A double-click on another view must not dock a second pane either.
    await page.dblclick('.view-strip-item[data-view-name="camD"]');
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
    s = await snap();
    check(s.docked.length === 1 && s.docked[0] === 'camD',
        `double-click also swaps, staying at one pane (got [${s.docked}])`);

    // Back to camB so the grid-return assertion below has a distinct target.
    await page.click('.view-strip-item[data-view-name="camB"]');
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));

    // =================================================================
    // 4 — `g` restores the grid with the last-viewed camera selected
    // =================================================================
    await press('g');
    // The restored panels re-attach on a rAF; give them one.
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
    s = await snap();
    check(s.mode === 'grid', 'g returns to grid mode');
    check(s.docked.length === 4, `grid restores all 4 panes (got ${s.docked.length})`);
    check(s.stripSelected.join() === 'camB',
        `the last-viewed view keeps the strip highlight (got [${s.stripSelected}])`);
    check(s.lastInteracted === 'camB',
        `lastInteractedView is the last-viewed view (got ${s.lastInteracted})`);
    check(s.selected3dCamera === 'camB',
        `3D viewer highlights the last-viewed camera (got ${s.selected3dCamera})`);
    check(s.indicator === null, 'the single-view indicator is gone in grid mode');
    // syncDockedViews(): fromJSON built these panels directly, so without the
    // re-derive the counts read empty and a strip click on an on-screen view
    // would silently do nothing.
    check(s.dockedViews.length === 4 && s.dockedViews.every(([, n]) => n === 1),
        `dockedViews re-derived after fromJSON (got ${JSON.stringify(s.dockedViews)})`);

    // And a plain strip click in the restored grid focuses that pane.
    await page.click('.view-strip-item[data-view-name="camA"]');
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
    s = await snap();
    check(s.docked.length === 4, 'strip click in the grid does not add a pane');
    check(s.stripSelected.join() === 'camA',
        `strip click in the grid focuses that pane (got [${s.stripSelected}])`);

    // `g` is a no-op after the restore too, not just before the first solo.
    const afterRestore = await snap();
    for (let i = 0; i < 3; i++) await press('g');
    s = await snap();
    check(s.docked.join() === afterRestore.docked.join() &&
          s.stripSelected.join() === afterRestore.stripSelected.join(),
        `g repeated after a restore changes nothing (panes [${s.docked}], selected [${s.stripSelected}])`);

    // Re-entering solo starts on that newly focused view.
    await press('v');
    s = await snap();
    check(s.mode === 'single' && s.docked.join() === 'camA',
        `v re-enters solo on the focused view (got [${s.docked}])`);

    await browser.close();
} catch (e) {
    console.log('  ✗ threw:', e && e.message ? e.message : String(e));
    fails++;
    if (browser) await browser.close().catch(() => {});
} finally {
    server.kill();
}

console.log(fails === 0 ? '\nsolo-view-navigation: PASS' : `\nsolo-view-navigation: FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
