/**
 * node-trails-toolbar.mjs — the toolbar's Trails button (issue #102), to the
 * right of Color: Tracks / ID.
 *
 * Asserted:
 *  1. It sits right of the Color group and reads a bare "Trails ▾" — the value
 *     is NOT in the label, which would cost toolbar width.
 *  2. It opens on CLICK, not on hover — unlike the Triangulate split buttons it
 *     borrows its markup from, whose menus open on :hover.
 *  3. Its items are the Tracks ▸ Node Trails presets, in the same order.
 *  4. Picking one sets `state.trailLength`, closes the menu, updates the
 *     button's tooltip, and moves the checkmark in BOTH menus. And the other
 *     way round: a pick from the Tracks menu updates the tooltip and moves the
 *     button menu's checkmark. The label never changes.
 *  5. It closes on a second click, an outside click and Esc.
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

    // The menu fades in/out over 0.12s; wait it out before reading visibility.
    const settle = () => page.waitForTimeout(250);
    const menuOpen = () => page.evaluate(() =>
        getComputedStyle(document.getElementById('trailsMenu')).visibility === 'visible');
    const read = () => page.evaluate(() => {
        const checked = (sel) => [...document.querySelectorAll(sel)]
            .filter(el => el.querySelector('.trail-check').textContent === '✓')
            .map(el => el.textContent.replace('✓', '').trim());
        return {
            len: window.__lucid.state.trailLength,
            label: document.getElementById('tbTrails').textContent.trim(),
            tip: document.getElementById('tbTrails').title,
            expanded: document.getElementById('tbTrails').getAttribute('aria-expanded'),
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
        `the button sits right of Color: Tracks / ID, on the same row (${pos.colorRight.toFixed(0)} → ${pos.trailsLeft.toFixed(0)})`);
    let s = await read();
    check(s.label === 'Trails ▾', `it reads "Trails ▾" at startup (got "${s.label}")`);
    check(s.tip.startsWith('Node trails: off.'), `its tooltip says trails are off (got "${s.tip}")`);

    // ---- 2. click, not hover ------------------------------------------------------
    await page.hover('#tbTrails');
    await settle();
    check(!(await menuOpen()), 'hovering the button does NOT open the menu');
    await page.click('#tbTrails');
    await settle();
    check(await menuOpen(), 'clicking the button opens the menu');
    check((await read()).expanded === 'true', 'aria-expanded is "true" while open');

    // ---- 3. same presets as Tracks ▸ Node Trails ----------------------------------
    const items = await page.evaluate(() => ({
        toolbar: [...document.querySelectorAll('#trailsMenu .tri-dropdown-item')].map(e => e.textContent.replace('✓', '').trim()),
        menubar: [...document.querySelectorAll('#menuTrailsSubmenu .menu-dropdown-item')].map(e => e.textContent.replace('✓', '').trim()),
    }));
    check(items.toolbar.length === 6 && JSON.stringify(items.toolbar) === JSON.stringify(items.menubar),
        `the items match Tracks ▸ Node Trails (${items.toolbar.join(', ')})`);
    s = await read();
    check(JSON.stringify(s.toolbarChecked) === '["Off"]', 'Off is checked at startup');

    if (SHOT_DIR) {
        const box = await page.evaluate(() => {
            const a = document.getElementById('colorByTracks').getBoundingClientRect();
            const m = document.getElementById('trailsMenu').getBoundingClientRect();
            return { x: a.left - 60, y: 0, width: m.right - a.left + 160, height: m.bottom + 12 };
        });
        await page.screenshot({ path: path.join(SHOT_DIR, 'node-trails-toolbar-open.png'), clip: box });
    }

    // ---- 4. picking a preset, both directions -------------------------------------
    await page.click('#trailsMenu .tri-dropdown-item[data-trail-len="50"]');
    await settle();
    s = await read();
    check(s.len === 50, `picking "50 frames" sets state.trailLength = 50 (got ${s.len})`);
    check(!(await menuOpen()) && s.expanded === 'false', 'picking an item closes the menu');
    check(s.tip.startsWith('Node trails: 50 frames.') && s.label === 'Trails ▾',
        `the tooltip says 50 frames and the label is unchanged (got "${s.tip}", "${s.label}")`);
    check(JSON.stringify(s.toolbarChecked) === '["50 frames"]', 'its checkmark moves to 50 frames');
    check(JSON.stringify(s.menubarChecked) === '["50 frames"]', 'and so does the Tracks menu\'s');

    await page.click('.menu-item[data-menu="tracks"]');
    await page.hover('#menuTrailsParent');
    await page.click('#menuTrails100');
    await settle();
    s = await read();
    check(s.len === 100 && s.tip.startsWith('Node trails: 100 frames.'),
        `a pick from Tracks ▸ Node Trails updates the button's tooltip (got ${s.len}, "${s.tip}")`);
    check(JSON.stringify(s.toolbarChecked) === '["100 frames"]', 'and moves the button menu\'s checkmark');

    // ---- 5. closing ---------------------------------------------------------------
    await page.click('#tbTrails'); await settle();
    await page.click('#tbTrails'); await settle();
    check(!(await menuOpen()), 'a second click on the button closes it');
    await page.click('#tbTrails'); await settle();
    await page.mouse.click(400, 500); await settle();
    check(!(await menuOpen()), 'an outside click closes it');
    await page.click('#tbTrails'); await settle();
    await page.keyboard.press('Escape'); await settle();
    check(!(await menuOpen()) && (await read()).expanded === 'false', 'Esc closes it');

    await page.click('#tbTrails'); await settle();
    await page.click('#trailsMenu .tri-dropdown-item[data-trail-len="0"]'); await settle();
    s = await read();
    check(s.len === 0 && s.tip.startsWith('Node trails: off.'), `"Off" turns trails off (got ${s.len}, "${s.tip}")`);
} catch (e) {
    console.log('  ✗ threw: ' + (e && e.stack || e));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
