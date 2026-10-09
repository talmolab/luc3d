/**
 * node-trails-toolbar.mjs — the toolbar's Trails button (issue #102), to the
 * right of the Tracks / Identity coloring toggle.
 *
 * Asserted:
 *  1. It sits right of the coloring toggle and reads a bare "Trails ▾" — the value
 *     is NOT in the label, which would cost toolbar width.
 *  2. It opens on HOVER, like the Triangulate split buttons, and closes once
 *     the pointer leaves. A click on the button does not latch it open.
 *  3. Its items are the Tracks ▸ Node Trails presets, in the same order:
 *     Off, ¼ s, ½ s, 1 s, 2 s, each naming its frame count at the current fps.
 *  4. Picking one sets `state.trailSeconds` (and so `state.trailLength`),
 *     updates the button's tooltip, and moves the checkmark in BOTH menus. And
 *     the other way round: a pick from the Tracks menu updates the tooltip and
 *     moves the button menu's checkmark. The label never changes.
 *  5. The presets are TIME: editing the FPS pill changes the frame count drawn
 *     (`state.trailLength`), and both menus and the tooltip say so the next
 *     time they open — 25/50/100/200 frames at 100 fps, 15/30/60/120 at 60.
 *  6. "Custom…" (last in both menus) opens a dialog with a Seconds and a
 *     Frames field: typing in either fills the other at the current fps, an
 *     invalid entry blanks the other and disables Apply, the 500-frame cap is
 *     noted, Esc / Cancel change nothing and Enter applies the field typed in
 *     last. A length typed in frames draws exactly those frames. A custom
 *     length is checked and named in both menus, follows the FPS pill like a
 *     preset, and picking a preset clears it.
 *  7. While any trail is on (preset or custom) the button wears the toolbar's
 *     `.active` blue — the same computed colours as the 3D button — so it reads
 *     as on without hovering it; Off takes it away.
 *
 * Run: node tests/e2e/node-trails-toolbar.mjs     (SHOT_DIR=… to save a screenshot)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8297);
const SHOT_DIR = process.env.SHOT_DIR || '';
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1700, height: 900 }, deviceScaleFactor: 2 });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // Opening fades in over 0.12s; closing waits out the menu's 0.35s hover
    // grace period first (styles.css `.tri-dropdown-menu`).
    const settleOpen = () => page.waitForTimeout(250);
    const settleClose = () => page.waitForTimeout(700);
    const menuOpen = () => page.evaluate(() =>
        getComputedStyle(document.getElementById('trailsMenu')).visibility === 'visible');
    const awayFromMenu = () => page.mouse.move(400, 500);
    const read = () => page.evaluate(() => {
        const checked = (sel) => [...document.querySelectorAll(sel)]
            .filter(el => el.querySelector('.trail-check').textContent === '✓')
            .map(el => el.textContent.replace('✓', '').trim());
        return {
            sec: window.__lucid.state.trailSeconds,
            len: window.__lucid.state.trailLength,
            label: document.getElementById('tbTrails').textContent.trim(),
            active: document.getElementById('tbTrails').classList.contains('active'),
            tip: document.getElementById('tbTrails').title,
            toolbarChecked: checked('#trailsMenu .tri-dropdown-item'),
            menubarChecked: checked('#menuTrailsSubmenu .menu-dropdown-item'),
        };
    });

    // ---- 1. placement + initial label --------------------------------------------
    const pos = await page.evaluate(() => {
        const r = (id) => document.getElementById(id).getBoundingClientRect();
        return { colorRight: r('colorById').right, trailsLeft: r('tbTrails').left,
            colorMid: (r('colorById').top + r('colorById').bottom) / 2,
            trailsMid: (r('tbTrails').top + r('tbTrails').bottom) / 2 };
    });
    check(pos.trailsLeft > pos.colorRight && Math.abs(pos.trailsMid - pos.colorMid) < 1,
        `the button sits right of Tracks / Identity, on the same row (${pos.colorRight.toFixed(0)} → ${pos.trailsLeft.toFixed(0)})`);
    let s = await read();
    check(s.label === 'Trails ▾', `it reads "Trails ▾" at startup (got "${s.label}")`);
    check(s.tip === 'Node trails: off', `its tooltip says trails are off (got "${s.tip}")`);
    check(!s.active, 'it is not blue while trails are off');

    // ---- 2. hover opens, leaving closes, a click does not latch it -----------------
    check(!(await menuOpen()), 'the menu is closed at startup');
    await page.hover('#tbTrails');
    await settleOpen();
    check(await menuOpen(), 'hovering the button opens the menu');
    await awayFromMenu();
    await settleClose();
    check(!(await menuOpen()), 'moving the pointer away closes it');
    await page.click('#tbTrails');
    await awayFromMenu();
    await settleClose();
    check(!(await menuOpen()), 'a click on the button does not keep it open after the pointer leaves');

    // ---- 3. same presets as Tracks ▸ Node Trails ----------------------------------
    // Startup has no video, so the rate is the 30 fps default.
    const fps0 = await page.evaluate(() => window.__lucid.state.fps);
    check(fps0 === 30, `the rate is 30 fps at startup (got ${fps0})`);
    const labels = () => page.evaluate(() => ({
        toolbar: [...document.querySelectorAll('#trailsMenu .tri-dropdown-item')].map(e => e.textContent.replace('✓', '').trim()),
        menubar: [...document.querySelectorAll('#menuTrailsSubmenu .menu-dropdown-item')].map(e => e.textContent.replace('✓', '').trim()),
    }));
    let items = await labels();
    const at30 = ['Off', '¼ second (8 frames)', '½ second (15 frames)', '1 second (30 frames)', '2 seconds (60 frames)', 'Custom…'];
    check(JSON.stringify(items.toolbar) === JSON.stringify(at30),
        `the items are Off / ¼ s / ½ s / 1 s / 2 s / Custom… with their frames at 30 fps (${items.toolbar.join(', ')})`);
    check(JSON.stringify(items.menubar) === JSON.stringify(items.toolbar),
        `and match Tracks ▸ Node Trails (${items.menubar.join(', ')})`);
    s = await read();
    check(JSON.stringify(s.toolbarChecked) === '["Off"]', 'Off is checked at startup');

    // ---- 4. picking a preset, both directions -------------------------------------
    await page.hover('#tbTrails');
    await settleOpen();
    if (SHOT_DIR) {
        const box = await page.evaluate(() => {
            const a = document.getElementById('colorByTracks').getBoundingClientRect();
            const m = document.getElementById('trailsMenu').getBoundingClientRect();
            return { x: a.left - 60, y: 0, width: m.right - a.left + 160, height: m.bottom + 12 };
        });
        await page.screenshot({ path: path.join(SHOT_DIR, 'node-trails-toolbar-open.png'), clip: box });
    }
    await page.click('#trailsMenu .tri-dropdown-item[data-trail-sec="0.5"]');
    s = await read();
    check(s.sec === 0.5 && s.len === 15, `picking "½ second" sets 0.5 s = 15 frames at 30 fps (got ${s.sec} s, ${s.len})`);
    check(s.tip === 'Node trails: ½ second (15 frames)' && s.label === 'Trails ▾',
        `the tooltip names it and the label is unchanged (got "${s.tip}", "${s.label}")`);
    check(JSON.stringify(s.toolbarChecked) === '["½ second (15 frames)"]', 'its checkmark moves to ½ second');
    check(s.active, 'the button turns blue (.active) once a trail is on');
    check(JSON.stringify(s.menubarChecked) === '["½ second (15 frames)"]', 'and so does the Tracks menu\'s');
    await awayFromMenu();
    await settleClose();
    check(!(await menuOpen()), 'after a pick, the menu closes once the pointer leaves');
    // Away from the button, so no :hover: the same blue as the 3D button.
    const looks = await page.evaluate(() => {
        const cs = (id) => { const c = getComputedStyle(document.getElementById(id)); return { bg: c.backgroundColor, fg: c.color }; };
        return { trails: cs('tbTrails'), threeD: cs('viewport3dToggleBtn'),
                 threeDOn: document.getElementById('viewport3dToggleBtn').classList.contains('active') };
    });
    check(looks.threeDOn && JSON.stringify(looks.trails) === JSON.stringify(looks.threeD),
        `not hovered, it is the same blue as 3D (${JSON.stringify(looks.trails)} vs ${JSON.stringify(looks.threeD)})`);
    if (SHOT_DIR) {
        const box = await page.evaluate(() => {
            const a = document.getElementById('colorByTracks').getBoundingClientRect();
            const b = document.getElementById('infoPanelToggleBtn').getBoundingClientRect();
            return { x: a.left - 20, y: 0, width: b.right - a.left + 28, height: b.bottom + 8 };
        });
        await page.screenshot({ path: path.join(SHOT_DIR, 'node-trails-active.png'), clip: box });
    }

    await page.click('.menu-item[data-menu="tracks"]');
    await page.hover('#menuTrailsParent');
    await page.click('#menuTrailsSecond');
    s = await read();
    check(s.len === 30 && s.tip === 'Node trails: 1 second (30 frames)',
        `a pick from Tracks ▸ Node Trails updates the button's tooltip (got ${s.len}, "${s.tip}")`);
    check(JSON.stringify(s.toolbarChecked) === '["1 second (30 frames)"]', 'and moves the button menu\'s checkmark');

    // ---- 5. the frame count follows the FPS pill ------------------------------------
    const setFps = async (v) => {
        await page.dblclick('#fpsDisplay');
        await page.fill('#fpsDisplay input', String(v));
        await page.press('#fpsDisplay input', 'Enter');
    };
    await awayFromMenu();
    await settleClose();
    await setFps(100);
    s = await read();
    check(s.sec === 1 && s.len === 100, `at 100 fps the 1 s trail is 100 frames (got ${s.sec} s, ${s.len})`);
    await page.hover('#tbTrails');
    await settleOpen();
    items = await labels();
    check(JSON.stringify(items.toolbar) === JSON.stringify(['Off', '¼ second (25 frames)', '½ second (50 frames)', '1 second (100 frames)', '2 seconds (200 frames)', 'Custom…']),
        `reopening the menu shows 25 / 50 / 100 / 200 frames (${items.toolbar.join(', ')})`);
    s = await read();
    check(s.tip === 'Node trails: 1 second (100 frames)', `and the tooltip says 100 frames (got "${s.tip}")`);
    await awayFromMenu();
    await settleClose();
    await setFps(60);
    await page.click('.menu-item[data-menu="tracks"]');
    await page.hover('#menuTrailsParent');
    items = await labels();
    check(JSON.stringify(items.menubar) === JSON.stringify(['Off', '¼ second (15 frames)', '½ second (30 frames)', '1 second (60 frames)', '2 seconds (120 frames)', 'Custom…']),
        `at 60 fps Tracks ▸ Node Trails shows 15 / 30 / 60 / 120 frames (${items.menubar.join(', ')})`);
    await page.click('#menuTrailsQuarter');
    s = await read();
    check(s.sec === 0.25 && s.len === 15, `picking ¼ second at 60 fps draws 15 frames (got ${s.sec} s, ${s.len})`);
    await page.hover('#tbTrails');
    await settleOpen();
    await page.click('#trailsMenu .tri-dropdown-item[data-trail-sec="2"]');
    s = await read();
    check(s.sec === 2 && s.len === 120 && s.tip === 'Node trails: 2 seconds (120 frames)',
        `picking 2 seconds at 60 fps draws 120 frames (got ${s.sec} s, ${s.len}, "${s.tip}")`);

    // ---- 6. Custom… -------------------------------------------------------------------
    // At 60 fps, with the 2 s preset on.
    const dialog = () => page.evaluate(() => {
        if (!document.getElementById('trailCustomModal')) return null;
        const sec = document.getElementById('trailCustomSeconds');
        return {
            sec: sec.value,
            frames: document.getElementById('trailCustomFrames').value,
            focused: document.activeElement === sec,
            note: document.getElementById('trailCustomNote').textContent,
            error: document.getElementById('trailCustomError').textContent,
            applyDisabled: document.getElementById('trailCustomApply').disabled,
        };
    });
    const openCustomFromToolbar = async () => {
        await awayFromMenu();
        await settleClose();
        await page.hover('#tbTrails');
        await settleOpen();
        await page.click('#trailsMenu [data-trail-custom]');
    };
    await openCustomFromToolbar();
    let d = await dialog();
    check(d && d.focused && d.sec === '2' && d.frames === '120' && d.note === 'At 60 fps.' && !d.applyDisabled,
        `"Custom…" opens on the current length in both fields, Seconds focused (${JSON.stringify(d)})`);
    if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'node-trails-custom.png') });
    await page.fill('#trailCustomSeconds', '1.5');
    d = await dialog();
    check(d.frames === '90', `typing 1.5 seconds fills Frames with 90 (got "${d.frames}")`);
    await page.fill('#trailCustomFrames', '45');
    d = await dialog();
    check(d.sec === '0.75', `typing 45 frames fills Seconds with 0.75 (got "${d.sec}")`);
    await page.fill('#trailCustomSeconds', 'abc');
    d = await dialog();
    check(d.applyDisabled && d.frames === '' && /seconds/.test(d.error),
        `seconds that are not a number blank Frames, disable Apply and say why ("${d.error}")`);
    await page.press('#trailCustomSeconds', 'Enter');
    check((await dialog()) !== null, 'Enter does nothing while the value is invalid');
    await page.fill('#trailCustomFrames', '12.5');
    d = await dialog();
    check(d.applyDisabled && d.sec === '' && /whole number of frames/.test(d.error),
        `a fractional frame count blanks Seconds and is refused ("${d.error}")`);
    await page.fill('#trailCustomFrames', '0');
    d = await dialog();
    check(d.applyDisabled, '0 frames disables Apply');
    await page.keyboard.press('Escape');
    s = await read();
    check((await dialog()) === null && s.sec === 2 && s.len === 120, `Esc closes it and changes nothing (got ${s.sec} s, ${s.len})`);

    await page.click('.menu-item[data-menu="tracks"]');
    await page.hover('#menuTrailsParent');
    await page.click('#menuTrailsCustom');
    await page.fill('#trailCustomSeconds', '1.5');
    await page.press('#trailCustomSeconds', 'Enter');
    s = await read();
    check((await dialog()) === null && s.sec === 1.5 && s.len === 90,
        `Tracks ▸ Node Trails ▸ Custom… opens it too; Enter applies 1.5 s = 90 frames (got ${s.sec} s, ${s.len})`);
    check(s.tip === 'Node trails: 1.5 seconds (90 frames)', `the tooltip names it (got "${s.tip}")`);
    check(JSON.stringify(s.toolbarChecked) === '["Custom: 1.5 seconds (90 frames)…"]' &&
          JSON.stringify(s.menubarChecked) === JSON.stringify(s.toolbarChecked),
        `"Custom" is checked and shows the length in both menus (${s.toolbarChecked}; ${s.menubarChecked})`);
    check(s.active, 'a custom length turns the button blue too');

    // Typed in frames: 10 frames at 60 fps is 1/6 s, which the Seconds field
    // shows as 0.167 — but it is stored exactly, so it draws exactly 10.
    await openCustomFromToolbar();
    d = await dialog();
    check(d.sec === '1.5' && d.frames === '90', `it reopens on the custom length (${d.sec} s, ${d.frames} frames)`);
    await page.fill('#trailCustomFrames', '10');
    d = await dialog();
    check(d.sec === '0.167', `10 frames fills Seconds with 0.167 (got "${d.sec}")`);
    await page.click('#trailCustomApply');
    s = await read();
    check(s.len === 10 && Math.abs(s.sec - 1 / 6) < 1e-12 && s.tip === 'Node trails: 0.167 seconds (10 frames)',
        `a length typed in frames draws exactly those frames (got ${s.len}, ${s.sec} s, "${s.tip}")`);
    await openCustomFromToolbar();
    d = await dialog();
    await page.keyboard.press('Enter');
    s = await read();
    check(d.sec === '0.167' && d.frames === '10' && Math.abs(s.sec - 1 / 6) < 1e-12 && s.len === 10,
        `re-applying it untouched keeps it exact, not its 0.167 display (got ${s.sec} s, ${s.len})`);

    await setFps(100);
    s = await read();
    check(Math.abs(s.sec - 1 / 6) < 1e-12 && s.len === 17, `a custom length follows the FPS pill: 1/6 s is 17 frames at 100 fps (got ${s.len})`);
    await page.hover('#tbTrails');
    await settleOpen();
    s = await read();
    check(JSON.stringify(s.toolbarChecked) === '["Custom: 0.167 seconds (17 frames)…"]', `and its menu item says so (${s.toolbarChecked})`);
    await page.click('#trailsMenu [data-trail-custom]');
    d = await dialog();
    check(d.note === 'At 100 fps.' && d.frames === '17', `the dialog converts at the new rate (${d.note} ${d.frames} frames)`);
    await page.fill('#trailCustomFrames', '600');
    d = await dialog();
    check(d.sec === '6' && d.note === 'At 100 fps. A trail draws at most 500 frames.',
        `past the cap the dialog says so (got "${d.sec}", "${d.note}")`);
    await page.fill('#trailCustomSeconds', '10');
    d = await dialog();
    check(d.frames === '500' && /at most 500/.test(d.note), `and the Frames field shows the 500 drawn (got "${d.frames}")`);
    await page.click('#trailCustomCancel');
    s = await read();
    check((await dialog()) === null && s.len === 17, `Cancel changes nothing (got ${s.len})`);

    await page.hover('#tbTrails');
    await settleOpen();
    await page.click('#trailsMenu .tri-dropdown-item[data-trail-sec="0.5"]');
    await page.hover('#tbTrails');
    s = await read();
    const customLabel = await page.evaluate(() => document.querySelector('#trailsMenu [data-trail-custom]').textContent.replace('✓', '').trim());
    check(s.sec === 0.5 && JSON.stringify(s.toolbarChecked) === '["½ second (50 frames)"]' && customLabel === 'Custom…',
        `picking a preset clears the custom length (${s.toolbarChecked}; "${customLabel}")`);

    await page.hover('#tbTrails');
    await settleOpen();
    await page.click('#trailsMenu .tri-dropdown-item[data-trail-sec="0"]');
    s = await read();
    check(s.len === 0 && s.tip === 'Node trails: off', `"Off" turns trails off (got ${s.len}, "${s.tip}")`);
    check(!s.active, '…and the button is no longer blue');
} catch (e) {
    console.log('  ✗ threw: ' + (e && e.stack || e));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
