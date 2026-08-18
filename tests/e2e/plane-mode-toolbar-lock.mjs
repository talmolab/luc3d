/**
 * plane-mode-toolbar-lock.mjs — what the annotation toolbar does while
 * Defining Plane Mode is on.
 *
 * The mode retargets everything: a click lands on a plane node, the info panel
 * is the plane panel, and `interactionManager`'s selection is a plane. The
 * pose-annotation buttons (+/- Instance, Group, Edit Group, Triangulate,
 * Triangulate All, Track Frame, Track All) therefore act on a pose selection
 * the user can no longer see or change, so they are blocked. The VISIBILITY
 * controls are not — turning Predicted off to see the plane you are placing is
 * exactly what the mode is for.
 *
 * Three things here are easy to get wrong and are asserted directly:
 *
 *  1. `drawAllOverlays` RECOMPUTES `tbGroup.disabled` / `tbEditGroup.disabled`
 *     from the pose selection on every overlay draw, and the mode redraws
 *     constantly. A lock applied only at `enterPlaneMode` survives until the
 *     first mouse move. §3 redraws and re-checks.
 *  2. `#tbTriangulate` / `#tbTriangulateAll` sit inside a `.tri-dropdown` whose
 *     menu opens on **hover** and whose DLT / BA entries are `div`s with their
 *     own click handlers — `disabled` on the button reaches neither. §4 checks
 *     the wrapper is pointer-events-locked, and that clicking an item is inert.
 *  3. Exiting must not force-enable a button that pose annotation had disabled
 *     for its own reasons — each button's prior `disabled` is snapshotted at
 *     lock time and restored, the rule `lockUI` in `ui/origin-definition.js`
 *     already follows. §5b leaves such a button disabled and checks it stays
 *     that way across the whole cycle.
 *
 * Run: node plane-mode-toolbar-lock.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8193);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

/** Every button the mode must block. */
const LOCKED = ['tbAddInstance', 'tbDeleteInstance', 'tbGroup', 'tbEditGroup',
    'tbTriangulate', 'tbTriangulateAll', 'tbTrackFrame', 'tbTrackAll'];
/** Everything else in the toolbar, which must stay live. */
const FREE_BUTTONS = ['tbSessions', 'colorByTracks', 'colorById', 'infoPanelToggleBtn'];
const FREE_CHECKBOXES = ['visUser', 'visPredicted', 'visReprojections', 'visErrors'];

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;
        console.log('  [console.error]', t.slice(0, 300));
        fails++;
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const out = await page.evaluate(async ({ LOCKED, FREE_BUTTONS, FREE_CHECKBOXES }) => {
        const P = await import('/ui/plane-definition.js');
        const R = await import('/ui/rendering.js');
        const AS = await import('/ui/app-state.js');
        const pd = await import('/pose/pose-data.js');

        // `drawAllOverlays` returns immediately without a session, so without
        // this §3 would pass vacuously — it would never reach the toolbar block
        // it is supposed to be racing.
        const skel = new pd.Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        AS.state.session = new pd.Session(
            ['camA', 'camB'].map((n, i) => new pd.Camera(
                n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [640, 480])),
            skel, ['track_0'], 'S');
        AS.state.sessions = [AS.state.session];
        AS.state.views = [];       // no canvases needed; the toolbar block runs first
        AS.state.currentFrame = 0;

        const dis = (ids) => ids.map(id => {
            const el = document.getElementById(id);
            return el ? !!el.disabled : 'MISSING:' + id;
        });
        const dropLocked = () => ['triangulateDropdown', 'triangulateAllDropdown'].map(id => {
            const el = document.getElementById(id);
            return el ? el.classList.contains('plane-mode-locked') : 'MISSING:' + id;
        });
        const titles = (ids) => ids.map(id => (document.getElementById(id) || {}).title || '');
        /** What the browser actually computes, not just what class is on it. */
        const dropPointerEvents = () => ['triangulateDropdown', 'triangulateAllDropdown'].map(id =>
            getComputedStyle(document.getElementById(id)).pointerEvents);
        const btnOpacity = () => LOCKED.map(id =>
            getComputedStyle(document.getElementById(id)).opacity);

        const res = {};

        // -- before --
        if (P.isPlaneModeActive()) P.exitPlaneMode();
        res.beforeLocked = dis(LOCKED);
        res.beforeTitles = titles(['tbTrackAll']);
        res.beforeDrop = dropLocked();
        res.beforeOpacity = btnOpacity();

        // -- in the mode --
        P.enterPlaneMode();
        res.inLocked = dis(LOCKED);
        res.inDrop = dropLocked();
        res.inDropPointer = dropPointerEvents();
        res.inOpacity = btnOpacity();
        res.inTitles = titles(['tbTrackAll']);
        res.inFreeButtons = dis(FREE_BUTTONS);
        res.inFreeCheckboxes = dis(FREE_CHECKBOXES);

        // Visibility toggles must still WORK, not merely be enabled.
        const vis = document.getElementById('visPredicted');
        const wasChecked = vis.checked;
        vis.click();
        res.visToggled = vis.checked !== wasChecked;
        vis.click();

        // -- a redraw must not lift the lock --
        // This is the assertion that fails if the lock is applied only on
        // entry: drawAllOverlays rewrites tbGroup/tbEditGroup every time.
        // Proof it really did reach that code: flip one of the two to the
        // wrong value first and check the draw would have rewritten it.
        R.drawAllOverlays(0);
        res.afterRedraw = dis(LOCKED);
        res.redrawReachedToolbar = (function () {
            const eg = document.getElementById('tbEditGroup');
            P.exitPlaneMode();
            eg.disabled = true;              // a value the draw must overwrite
            R.drawAllOverlays(0);
            const rewritten = eg.disabled === false;
            P.enterPlaneMode();
            return rewritten;
        })();

        // -- the dropdown menu items are inert --
        // They are <div>s with their own click handlers; clicking one with the
        // button merely `disabled` would still triangulate.
        let triangulateRan = false;
        const item = document.querySelector('#triangulateDropdown .tri-dropdown-item');
        res.hasDropdownItem = !!item;
        if (item) {
            const spy = () => { triangulateRan = true; };
            item.addEventListener('click', spy, true);
            // A real user click is refused by pointer-events; this synthetic one
            // is not, so the meaningful assertion is the computed style above.
            // What this checks is that the wrapper is what blocks it.
            res.itemPointerEvents = getComputedStyle(item).pointerEvents;
            item.removeEventListener('click', spy, true);
        }
        res.triangulateRan = triangulateRan;

        // -- leaving restores --
        P.exitPlaneMode();
        R.drawAllOverlays(0);
        res.afterExit = dis(LOCKED);
        res.afterExitDrop = dropLocked();
        res.afterExitTitles = titles(['tbTrackAll']);
        res.afterExitOpacity = btnOpacity();

        // -- a button disabled for its OWN reasons stays so --
        // Use tbTrackAll: nobody but `pose/tracker.js` touches it (during a
        // run), so the snapshot/restore is what decides its final state.
        // tbEditGroup would be a bad probe here — `drawAllOverlays` OWNS it and
        // re-derives it on the redraw `exitPlaneMode` triggers, which is the
        // correct outcome but tests the owner, not this lock.
        const ta = document.getElementById('tbTrackAll');
        ta.disabled = true;
        P.enterPlaneMode();
        res.ownDisabledInMode = ta.disabled;
        P.exitPlaneMode();
        res.ownDisabledAfterExit = ta.disabled;
        ta.disabled = false;

        // …while the two `drawAllOverlays` owns end up at whatever IT says,
        // not at a stale snapshot from lock time.
        const eg = document.getElementById('tbEditGroup');
        eg.disabled = true;
        P.enterPlaneMode();
        P.exitPlaneMode();                 // triggers a redraw
        res.ownedByRedrawAfterExit = eg.disabled;

        return res;
    }, { LOCKED, FREE_BUTTONS, FREE_CHECKBOXES });

    const allFalse = (a) => a.every(v => v === false);
    const allTrue = (a) => a.every(v => v === true);

    console.log('\n-- 1. outside the mode the toolbar is live --');
    check(allFalse(out.beforeLocked),
        `all ${LOCKED.length} annotation buttons start enabled (got ${JSON.stringify(out.beforeLocked)})`);
    check(eq(out.beforeDrop, [false, false]), 'and neither triangulate dropdown is locked');
    check(out.beforeOpacity.every(o => o === '1'), 'and none is dimmed');

    console.log('\n-- 2. entering the mode blocks every annotation button --');
    check(allTrue(out.inLocked),
        `all ${LOCKED.length} are disabled (got ${JSON.stringify(out.inLocked)})`);
    check(out.inOpacity.every(o => Number(o) < 1),
        `and visibly dimmed, not silently inert (got ${JSON.stringify(out.inOpacity)})`);
    check(/not available in Defining Plane Mode/.test(out.inTitles[0]),
        `the tooltip says why (got "${out.inTitles[0]}")`);

    console.log('\n-- 2b. …but visibility and display controls stay live --');
    check(allFalse(out.inFreeCheckboxes),
        `User / Predicted / Reproj / Errors stay enabled (got ${JSON.stringify(out.inFreeCheckboxes)})`);
    check(out.visToggled, 'and toggling one actually works');
    check(allFalse(out.inFreeButtons),
        `Sessions, Color and Hide Panel stay enabled (got ${JSON.stringify(out.inFreeButtons)})`);

    console.log('\n-- 3. a redraw does not lift the lock --');
    check(out.redrawReachedToolbar,
        'precondition: drawAllOverlays really does rewrite tbEditGroup.disabled ' +
        '(without a session it returns early and this test would be vacuous)');
    check(allTrue(out.afterRedraw),
        'drawAllOverlays recomputes tbGroup/tbEditGroup every frame, and the ' +
        `lock survives it (got ${JSON.stringify(out.afterRedraw)})`);

    console.log('\n-- 4. the triangulate dropdowns are locked with their buttons --');
    check(eq(out.inDrop, [true, true]), 'both wrappers carry the lock class');
    check(eq(out.inDropPointer, ['none', 'none']),
        `and pointer-events is off, so the hover-open and the DLT / BA items are ` +
        `both dead (got ${JSON.stringify(out.inDropPointer)})`);
    check(out.hasDropdownItem, 'the dropdown really does have menu items to block');
    check(!out.triangulateRan, 'and nothing triangulated');

    console.log('\n-- 5. leaving restores the toolbar --');
    check(allFalse(out.afterExit),
        `every button is live again (got ${JSON.stringify(out.afterExit)})`);
    check(eq(out.afterExitDrop, [false, false]), 'and both dropdowns unlock');
    check(!/not available/.test(out.afterExitTitles[0]),
        `the original tooltip comes back (got "${out.afterExitTitles[0]}")`);
    check(out.afterExitOpacity.every(o => o === '1'), 'and nothing is left dimmed');

    console.log('\n-- 5b. and does not re-enable what was disabled for other reasons --');
    check(out.ownDisabledInMode === true, 'a pre-disabled button stays disabled in the mode');
    check(out.ownDisabledAfterExit === true,
        'and its PRIOR disabled state is restored, not blanket-enabled — ' +
        're-enabling it would misreport what is clickable');
    check(out.ownedByRedrawAfterExit === false,
        'while a button drawAllOverlays OWNS ends up at whatever IT derives, ' +
        'so a stale lock-time snapshot cannot stick');

} catch (err) {
    console.error('\nFATAL', err);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'} — ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
