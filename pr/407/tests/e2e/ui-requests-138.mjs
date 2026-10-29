/**
 * ui-requests-138.mjs — the three UI requests of issue #138, in the real app.
 *
 *  1. Docs / Settings: a "Help" dropdown sits in the menu row after Hot Keys
 *     (holding Docs and Settings), and Docs / Settings are ALSO direct buttons
 *     at the right end of the menu bar, replacing the old right-aligned Help.
 *     Both Settings entries open the Settings dialog; both Docs entries open
 *     the docs URL in a new tab.
 *  2. The Speed popover offers 0.25x and 0.5x presets, they apply, and the
 *     (now wider) popover stays inside the window.
 *  3. The Triangulate / Triangulate All buttons say which method a plain click
 *     runs (in its tooltip; the label stays "Triangulate"), and follow Settings ▸ Default Triangulation
 *     when it is changed through the real Settings dialog — immediately, and
 *     after a reload (the setting persists in localStorage).
 *
 * Run: node tests/e2e/ui-requests-138.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8264);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1400, height: 860 } });
    const page = await context.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    // Record window.open instead of opening tabs.
    await page.addInitScript(() => {
        window.__opened = [];
        window.open = (url, target) => { window.__opened.push([url, target]); return null; };
    });
    const boot = async () => {
        await page.goto(`http://localhost:${PORT}/index.html`);
        await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    };
    await boot();
    // Start from the default method regardless of what this browser profile held.
    await page.evaluate(() => { localStorage.removeItem('lucid.settings.v1'); });
    await page.evaluate(async () => { (await import('/ui/settings.js')).setDefaultTriangulationMethod('dlt'); });

    // ---- 1. menu bar ----------------------------------------------------------------
    const bar = await page.evaluate(() => [...document.querySelectorAll('.menu-bar > .menu-item')]
        .map(el => ({ text: el.firstChild.textContent.trim(), id: el.id, left: el.getBoundingClientRect().left })));
    const names = bar.map(b => b.text);
    check(JSON.stringify(names) === JSON.stringify(['File', 'Edit', 'Calibrate', 'Tracks', 'Behavior', 'View', 'Hot Keys', 'Help', 'Docs', 'Settings']),
        'menu bar reads ' + names.join(' | '));
    const help = bar.find(b => b.text === 'Help'), hot = bar.find(b => b.text === 'Hot Keys');
    const docs = bar.find(b => b.text === 'Docs');
    check(help.left > hot.left && docs.left - help.left > 400, 'Help follows Hot Keys on the left; Docs / Settings sit at the far right');

    await page.click('.menu-item[data-menu="help"]');
    const helpItems = await page.evaluate(() => {
        const dd = document.getElementById('menuHelp');
        return { shown: getComputedStyle(dd).display !== 'none', items: [...dd.querySelectorAll('.menu-dropdown-item')].map(i => i.textContent.trim()) };
    });
    check(helpItems.shown && JSON.stringify(helpItems.items) === '["Docs","Settings"]', 'Help opens a dropdown with Docs and Settings');

    await page.click('#menuSettings');
    check(await page.isVisible('.settings-btn-cancel'), 'Help ▸ Settings opens the Settings dialog');
    await page.click('.settings-btn-cancel');
    await page.click('#menuBarSettings');
    check(await page.isVisible('.settings-btn-cancel'), 'the Settings button opens the Settings dialog');
    await page.click('.settings-btn-cancel');

    await page.click('.menu-item[data-menu="help"]');
    await page.click('#menuDocumentation');
    await page.click('#menuBarDocs');
    const opened = await page.evaluate(() => window.__opened);
    check(opened.length === 2 && opened.every(o => o[0] === 'https://talmolab.github.io/luc3d-docs/' && o[1] === '_blank'),
        'Help ▸ Docs and the Docs button both open the docs in a new tab');

    // ---- 2. speed presets ---------------------------------------------------------------
    await page.click('#speedBtn');
    const presets = await page.evaluate(() => {
        const pop = document.getElementById('speedPopover');
        const r = pop.getBoundingClientRect();
        return {
            labels: [...pop.querySelectorAll('.speed-presets button')].map(b => b.textContent),
            inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0,
            rect: [Math.round(r.left), Math.round(r.right), innerWidth],
        };
    });
    check(JSON.stringify(presets.labels) === JSON.stringify(['0.25', '0.50', '1.0', '1.25', '1.50', '2.0', '3.0']),
        'presets: ' + presets.labels.join(' '));
    check(presets.inside, `the popover stays inside the window (left ${presets.rect[0]}, right ${presets.rect[1]}, width ${presets.rect[2]})`);
    for (const [label, want] of [['0.25', 0.25], ['0.50', 0.5]]) {
        await page.click(`.speed-presets button:text-is("${label}")`);
        const st = await page.evaluate(() => ({
            mult: window.__lucid.state.speedMultiplier,
            btn: document.getElementById('speedBtnValue').textContent,
            active: document.querySelector('.speed-presets button.active')?.textContent,
        }));
        check(st.mult === want && st.btn === want.toFixed(2) + 'x' && st.active === label,
            `${label} preset sets ${want}x (state ${st.mult}, button "${st.btn}", active "${st.active}")`);
    }
    await page.mouse.click(10, 400);   // close the popover

    // ---- 3. triangulate label + the menu's Method radios ---------------------------------
    // One Triangulate button now; its menu's Method radios are the same setting.
    const labels = () => page.evaluate(() => {
        const b = document.getElementById('tbTriangulateAll');
        const on = document.querySelector('#triangulateDropdown input[name="tbTriMethod"]:checked');
        return { text: b.textContent.replace('▾', '').trim(), title: b.title, radio: on && on.value };
    });
    let l = await labels();
    check(l.text === 'Triangulate' && l.radio === 'dlt', `default DLT: "${l.text}", radio ${l.radio}`);
    check(/DLT \(fast\)/.test(l.title), 'tooltip names the method');

    // Change it the way a user does: Settings dialog -> "Refined" row -> Apply.
    await page.click('#menuBarSettings');
    // The method is picked by clicking its diagram card (no separate rows).
    await page.click('.tri-method-choice[data-method="ba"]');
    const picked = await page.evaluate(() => Array.from(document.querySelectorAll('.tri-method-choice'))
        .map(c => c.dataset.method + ':' + c.getAttribute('aria-checked') + ':' + c.classList.contains('checked')));
    check(picked.join(',') === 'dlt:false:false,ba:true:true', `clicking the Refined card selects it (${picked})`);
    await page.focus('.tri-method-choice[data-method="dlt"]');
    await page.keyboard.press('Space');
    const byKey = await page.evaluate(() => document.querySelector('.tri-method-choice[data-method="dlt"]').getAttribute('aria-checked'));
    check(byKey === 'true', 'Space on the focused DLT card selects it');
    await page.click('.tri-method-choice[data-method="ba"]');
    l = await labels();
    check(/DLT \(fast\)/.test(l.title) && l.radio === 'dlt', 'picking a card without Apply changes nothing yet');
    await page.click('.settings-btn-apply');
    l = await labels();
    check(l.text === 'Triangulate' && l.radio === 'ba', `after Apply: "${l.text}", radio ${l.radio}`);
    check(/Ref \(slower; helps when one view is clearly wrong\)/.test(l.title), 'tooltip follows too');
    const radioName = await page.evaluate(() =>
        document.querySelector('#triangulateDropdown input[value="ba"]').parentElement.textContent.trim());
    check(radioName === 'Ref', 'the tooltip uses the same name as its Method radio ("Ref")');

    await boot();
    l = await labels();
    check(/Ref \(slower; helps when one view is clearly wrong\)/.test(l.title) && l.radio === 'ba', 'after a reload the button still runs Ref');

    // Back to DLT through the menu's own radio this time, and leave the profile clean.
    await page.hover('#tbTriangulateAll');
    await page.click('#triangulateDropdown input[value="dlt"]');
    l = await labels();
    check(/DLT \(fast\)/.test(l.title) && l.radio === 'dlt', 'the menu radio switches back to DLT and updates the button');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
