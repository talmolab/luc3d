/**
 * folder-confirm-tip.mjs — the macOS tip before a folder picker
 * (ui/folder-confirm-tip.js).
 *
 * After a folder is picked, Chromium asks again ("Upload N files to this
 * site?" / "Let site view files?") with Cancel as the default button, so Return
 * cancels the load. On a Mac, Tab reaches Upload only with System Settings ▸
 * Keyboard ▸ Keyboard navigation on, which no page can read — so the tip shows
 * to every Mac user of a Chromium browser until "Don't show this again".
 *
 * The tip is skipped under automation (`navigator.webdriver`), so this file
 * clears that flag and fakes `navigator.userAgentData.platform`. Asserted:
 *  1. macOS: File ▸ Load Single Session Folder opens the tip, not the picker;
 *     Continue has focus and the copy names the setting.
 *  2. Esc and Cancel each end the load: no picker, "No folder selected".
 *  3. Return opens the REAL file chooser.
 *  4. "Don't show this again", ticked with the mouse (which releases focus to
 *     the page), then Return: the picker opens, the choice is stored, and the
 *     next load goes straight to the picker.
 *  5. Load Multi-Session Folder and the per-camera loader are gated the same
 *     way. A stubbed showDirectoryPicker records whether it was reached AND
 *     whether the page had user activation then: Return pressed after the
 *     menu click's own activation expired must still supply it (the picker
 *     needs it), with an untrusted click as the negative control.
 *  6. NEGATIVE CONTROLS: Windows, and an automated macOS browser, never see it.
 *
 * Run: node tests/e2e/folder-confirm-tip.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8347);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

/** A page on `platform`, optionally still flagged as automated. */
async function open(browser, platform, automated) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.addInitScript(({ platform, automated }) => {
        Object.defineProperty(Navigator.prototype, 'userAgentData', {
            configurable: true,
            get: () => ({ platform, mobile: false, brands: [{ brand: 'Chromium', version: '140' }] }),
        });
        if (!automated) {
            Object.defineProperty(Navigator.prototype, 'webdriver', { configurable: true, get: () => false });
        }
    }, { platform, automated });
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    // The remembered loader choice decides which loader the menu item runs.
    await page.evaluate(() => {
        localStorage.setItem('sessionFolderType', 'single-slp');
        localStorage.removeItem('folderConfirmTipDismissed');
    });
    let choosers = 0;
    page.on('filechooser', () => { choosers++; });
    return { page, ctx, choosers: () => choosers };
}

/** File ▸ Load Single Session Folder, with real pointer input (user activation). */
async function menuLoadSingle(page) {
    await page.click('.menu-item[data-menu="file"]');
    await page.click('#menuLoadSessionFolder');
}

const tipShown = (page) => page.evaluate(() => !!document.getElementById('folderTipOverlay'));
const status = (page) => page.evaluate(() => {
    const el = document.getElementById('statusText') || document.querySelector('.status-text, #status');
    return el ? el.textContent : '';
});
const settle = (page) => page.waitForTimeout(250);

let browser;
try {
    browser = await chromium.launch();

    console.log('\n--- 1. macOS: the menu item opens the tip first ---');
    const mac = await open(browser, 'macOS', false);
    let p = mac.page;
    await menuLoadSingle(p);
    await p.waitForSelector('#folderTipOverlay', { timeout: 5000 });
    await settle(p);
    check(mac.choosers() === 0, 'no file chooser yet');
    check(await p.evaluate(() => document.activeElement && document.activeElement.id) === 'btnFolderTipContinue',
        'Continue has focus, so Return continues');
    const copy = await p.evaluate(() => document.querySelector('.folder-tip-modal').textContent);
    check(/System Settings ▸ Keyboard ▸ Keyboard navigation/.test(copy), 'the copy names the setting');
    check(/Tab/.test(copy) && /Space/.test(copy), 'and the keys to press');

    console.log('\n--- 2. Esc and Cancel end the load ---');
    await p.keyboard.press('Escape');
    await settle(p);
    check(!(await tipShown(p)), 'Esc closes the tip');
    check(mac.choosers() === 0, 'and opens no file chooser');
    check(/No folder selected/.test(await status(p)), 'status: No folder selected');

    await menuLoadSingle(p);
    await p.waitForSelector('#folderTipOverlay', { timeout: 5000 });
    await p.click('#btnFolderTipCancel');
    await settle(p);
    check(!(await tipShown(p)) && mac.choosers() === 0, 'Cancel closes it with no file chooser');
    check(await p.evaluate(() => localStorage.getItem('folderConfirmTipDismissed')) === null,
        'nothing is remembered when the box was not ticked');

    console.log('\n--- 3. Return opens the real file chooser ---');
    await menuLoadSingle(p);
    await p.waitForSelector('#folderTipOverlay', { timeout: 5000 });
    let fcWait = p.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
    await p.keyboard.press('Enter');
    let fc = await fcWait;
    check(!!fc, 'Return opens the file chooser');
    check(!!fc && await fc.element().evaluate(el => el.webkitdirectory), 'and it is a folder picker');
    check(!(await tipShown(p)), 'the tip is gone');
    // Release the picker without a folder.
    if (fc) await fc.setFiles([]).catch(() => {});
    await settle(p);

    console.log('\n--- 4. "Don\'t show this again" ---');
    await menuLoadSingle(p);
    await p.waitForSelector('#folderTipOverlay', { timeout: 5000 });
    await p.click('label.folder-tip-dontshow');
    await settle(p); // let the app's pointer focus release run
    check(await p.evaluate(() => document.getElementById('folderTipDontShow').checked), 'the box ticks');
    fcWait = p.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
    await p.keyboard.press('Enter');
    fc = await fcWait;
    check(!!fc, 'Return still continues with focus off the button');
    if (fc) await fc.setFiles([]).catch(() => {});
    check(await p.evaluate(() => localStorage.getItem('folderConfirmTipDismissed')) === '1', 'the choice is stored');
    await settle(p);

    const before = mac.choosers();
    fcWait = p.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
    await menuLoadSingle(p);
    fc = await fcWait;
    check(!!fc && mac.choosers() === before + 1, 'the next load goes straight to the picker');
    check(!(await tipShown(p)), 'with no tip');
    if (fc) await fc.setFiles([]).catch(() => {});
    await mac.ctx.close();

    console.log('\n--- 5. Multi-session and per-camera loads are gated too ---');
    const mac2 = await open(browser, 'macOS', false);
    p = mac2.page;
    // The stub records whether the page still had USER ACTIVATION when the
    // picker was called — the real one throws SecurityError without it.
    // Playwright's file-chooser interception does not enforce activation, so
    // this, not section 3, is what shows the gate leaves the picker callable.
    await p.evaluate(() => {
        window.__dirPickerCalls = [];
        window.showDirectoryPicker = async () => {
            window.__dirPickerCalls.push(navigator.userActivation.isActive);
            throw new DOMException('stub', 'AbortError');
        };
    });
    const dirCalls = () => p.evaluate(() => window.__dirPickerCalls.slice());
    const menuLoadMulti = async () => {
        await p.click('.menu-item[data-menu="file"]');
        await p.click('#menuLoadMultiSessionFolder');
        await p.waitForSelector('#folderTipOverlay', { timeout: 5000 });
    };
    await menuLoadMulti();
    check((await dirCalls()).length === 0, 'Load Multi-Session Folder: tip before the picker');
    await p.keyboard.press('Escape');
    await settle(p);
    check((await dirCalls()).length === 0, 'Esc: the picker is never reached');

    // Outlast the menu click's transient activation (5 s in Chromium), as a
    // user reading the tip does, so only the keystroke can supply it.
    await menuLoadMulti();
    await p.waitForTimeout(5500);
    await p.keyboard.press('Enter');
    await settle(p);
    let calls = await dirCalls();
    check(calls.length === 1, 'Return: the picker is reached');
    check(calls[0] === true, 'with user activation, 5.5 s after the menu click (the Return keystroke supplies it)');

    // NEGATIVE CONTROL: the same wait, then an untrusted click, which grants
    // none — so the check above can fail. It fires from a TIMER: Playwright's
    // page.evaluate runs with a user gesture of its own, so a click made
    // inside one would carry activation it did not earn.
    await menuLoadMulti();
    await p.evaluate(() => setTimeout(() => document.getElementById('btnFolderTipContinue').click(), 5500));
    await p.waitForTimeout(6000);
    calls = await dirCalls();
    check(calls.length === 2 && calls[1] === false, 'control: an untrusted click after the same wait reaches it WITHOUT activation');

    await p.evaluate(() => { localStorage.setItem('sessionFolderType', 'per-camera'); });
    await menuLoadSingle(p);
    await p.waitForSelector('#folderTipOverlay', { timeout: 5000 });
    check(mac2.choosers() === 0, 'per-camera loader: tip before the picker');
    await p.keyboard.press('Escape');
    await settle(p);
    check(mac2.choosers() === 0 && /No folder selected/.test(await status(p)), 'Esc ends it the same way');
    await mac2.ctx.close();

    console.log('\n--- 6. Negative controls ---');
    for (const [label, platform, automated] of [['Windows', 'Windows', false], ['automated macOS', 'macOS', true]]) {
        const o = await open(browser, platform, automated);
        const w = o.page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
        await menuLoadSingle(o.page);
        const f = await w;
        check(!!f && !(await tipShown(o.page)), label + ': straight to the picker, no tip');
        if (f) await f.setFiles([]).catch(() => {});
        await o.ctx.close();
    }
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
