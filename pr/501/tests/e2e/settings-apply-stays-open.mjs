/**
 * settings-apply-stays-open.mjs — Settings' footer and × (ui/settings-modal.js).
 *
 * Asserted, through the real app:
 *  1. Opened with nothing changed: Apply is disabled, the other button reads Close.
 *  2. An edit enables Apply and the other button reads Cancel; undoing the edit by
 *     hand goes back.
 *  3. Apply stores the edit and leaves the window open: the button reads
 *     "Applied ✓", disabled, the other reads Close, and the demo's "not saved until
 *     you click Apply" note goes.
 *  4. The next edit makes it "Apply" again; going back to what was applied makes it
 *     "Applied ✓" again. A rebound key counts as an edit.
 *  5. × is a real, visible button of at least 28 px, and discards what is pending,
 *     as do Esc and the backdrop; what was applied stays.
 *  6. The Triangulation Wizard's footer always says the method and threshold, on
 *     that panel only; a value not yet applied is lit, with what it was; it stays
 *     on one row of buttons in a narrow window, while the panel scrolls.
 *
 * Run: node tests/e2e/settings-apply-stays-open.mjs   (PORT=… to move the server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8321);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const FIELD = '.settings-panel[data-panel="wizard"] input[aria-label="Reprojection error threshold (px)"]';
let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    const open = (panel) => page.evaluate(async (p) => (await import('/ui/settings-modal.js')).showSettingsModal(p), panel);
    const footer = () => page.evaluate(() => {
        const a = document.querySelector('.settings-btn-apply'), c = document.querySelector('.settings-btn-cancel');
        const s = a && getComputedStyle(a);
        return a ? { open: true, apply: a.textContent, disabled: a.disabled, other: c.textContent, applied: a.classList.contains('is-applied'), color: s.color, background: s.backgroundColor } : { open: false };
    });
    const type = (v) => page.fill(FIELD, String(v));
    const stored = () => page.evaluate(async () => (await import('/ui/settings.js')).getTrackingThreshold('reprojErrorThreshold'));
    const isOpen = () => page.evaluate(() => !!document.querySelector('.settings-overlay'));

    console.log('1. nothing changed');
    await open('wizard');
    let f = await footer();
    const idleLook = f;
    check(f.apply === 'Apply' && f.disabled && f.other === 'Close', `Apply is disabled, the other button reads Close (${JSON.stringify(f)})`);

    console.log('2. an edit');
    await type(30);
    f = await footer();
    check(f.apply === 'Apply' && !f.disabled && f.other === 'Cancel', `Apply is live, the other button reads Cancel (${f.other})`);
    check(await stored() === 0, 'nothing is stored yet');
    await type(0);
    f = await footer();
    check(f.apply === 'Apply' && f.disabled && f.other === 'Close', 'undoing the edit by hand: nothing to apply');

    console.log('3. Apply');
    await type(30);
    await page.click('.settings-btn-apply');
    await page.waitForTimeout(300);   // let the colour transition finish
    f = await footer();
    check(await isOpen(), 'the window stays open');
    check(await stored() === 30, `the edit is stored (${await stored()})`);
    check(f.apply === 'Applied ✓' && f.disabled && f.applied && f.other === 'Close', `the button says so (${f.apply}, other: ${f.other})`);
    check(f.color !== idleLook.color || f.background !== idleLook.background, `and looks different from a plain disabled Apply (${f.color} on ${f.background})`);
    await page.click('.settings-nav-item[data-panel="triangulation"]');
    const unsaved = await page.evaluate(() => {
        const n = document.querySelector('.tri-thr .fig-unsaved');
        return n && getComputedStyle(n).visibility !== 'hidden' && getComputedStyle(n).display !== 'none' && !n.hidden && n.offsetParent !== null;
    });
    const tag = await page.textContent('.tri-thr .fig-setting-now strong');
    check(/^30 px/.test(tag) && !unsaved, `the demo shows 30 px, no longer "not saved" (${tag}, ${unsaved})`);
    await page.click('.settings-nav-item[data-panel="wizard"]');

    console.log('4. the next edit');
    await type(40);
    f = await footer();
    check(f.apply === 'Apply' && !f.disabled && !f.applied && f.other === 'Cancel', `back to Apply (${f.apply})`);
    await type(30);
    f = await footer();
    check(f.apply === 'Applied ✓' && f.disabled, `back at what was applied: Applied ✓ (${f.apply})`);
    await page.click('.settings-nav-item[data-panel="keyboard"]');
    await page.locator('.settings-panel[data-panel="keyboard"] .settings-kbd-key:not(.fixed)').first().click();
    await page.keyboard.press('Control+Alt+Shift+F9');
    await page.click('.settings-panel[data-panel="keyboard"] .settings-kbd-hint');
    f = await footer();
    check(!f.disabled && f.apply === 'Apply', `a rebound key counts as an edit (${f.apply})`);
    await page.keyboard.press('Escape');

    console.log('5. ×, Esc and the backdrop discard what is pending');
    check(await stored() === 30, 'what was applied stays');
    await open('wizard');
    const x = await page.evaluate(() => {
        const el = document.querySelector('.settings-modal-close'), r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return { tag: el.tagName, label: el.getAttribute('aria-label'), w: r.width, h: r.height, border: s.borderTopWidth, color: s.color };
    });
    check(x.tag === 'BUTTON' && !!x.label, `× is a labelled button (${x.tag}, ${x.label})`);
    check(x.w >= 28 && x.h >= 28 && x.border !== '0px', `and a visible one (${x.w}x${x.h}, border ${x.border})`);
    await type(55);
    await page.click('.settings-modal-close');
    check(!(await isOpen()) && await stored() === 30, `× closes and discards (${await stored()})`);
    await open('wizard');
    await type(55);
    await page.keyboard.press('Escape');
    check(!(await isOpen()) && await stored() === 30, 'Esc too');
    await open('wizard');
    await type(55);
    await page.mouse.click(4, 4);
    check(!(await isOpen()) && await stored() === 30, 'the backdrop too');

    console.log('6. the Triangulation Wizard says what it will use');
    const readout = () => page.evaluate(() => {
        const el = document.querySelector('.settings-tri-readout');
        return {
            shown: !!el && el.offsetParent !== null,
            text: el ? el.innerText.replace(/\s+/g, ' ').trim() : '',
            changed: el ? el.querySelectorAll('.is-changed').length : 0,
        };
    });
    await page.setViewportSize({ width: 1000, height: 700 });
    await open('wizard');
    check(!(await readout()).shown, 'not on the Tracking Wizard');
    await page.click('.settings-nav-item[data-panel="triangulation"]');
    check(await page.textContent('.settings-panel[data-panel="triangulation"] .settings-panel-title') === 'Triangulation Wizard', 'the panel is called Triangulation Wizard');
    let r = await readout();
    check(r.shown && r.text === 'Method: DLT Reprojection error threshold: 30 px' && r.changed === 0, `it says the stored settings (${r.text})`);
    await page.click('.tri-method-choice[data-method="ba"]');
    r = await readout();
    check(r.text === 'Method: Refined (was DLT) Reprojection error threshold: 30 px' && r.changed === 1, `a new method is lit, with what it was (${r.text})`);
    await page.click('.settings-nav-item[data-panel="wizard"]');
    await type(0);
    await page.click('.settings-nav-item[data-panel="triangulation"]');
    r = await readout();
    check(r.text === 'Method: Refined (was DLT) Reprojection error threshold: off (was 30 px)' && r.changed === 2, `a threshold changed on the Tracking Wizard too (${r.text})`);
    await page.click('.settings-size-btn[data-size="narrow"]');
    await page.evaluate(() => { document.querySelector('.settings-panel-container').scrollTop = 1e6; });
    const box = await page.evaluate(() => {
        const rect = (q) => document.querySelector(q).getBoundingClientRect();
        const ro = rect('.settings-tri-readout'), size = rect('.settings-size-btns'), cancel = rect('.settings-btn-cancel'), go = rect('.settings-btn-triangulate');
        return { clear: size.right <= ro.left && ro.right <= cancel.left, oneRow: Math.abs(cancel.top - go.top) < 2, onScreen: ro.bottom <= innerHeight && ro.top >= 0, sw: ro.width };
    });
    check(box.clear && box.oneRow && box.onScreen, `in a 1000 px window it sits between the Window and Close buttons, scrolled to the end (${JSON.stringify(box)})`);
    await page.click('.settings-btn-apply:not(.settings-btn-triangulate)');
    r = await readout();
    check(r.text === 'Method: Refined Reprojection error threshold: off' && r.changed === 0, `Apply: nothing is lit (${r.text})`);
    await page.keyboard.press('Escape');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
