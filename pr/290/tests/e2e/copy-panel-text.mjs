/**
 * copy-panel-text.mjs — text in a panel, a modal or the status bar can be
 * SELECTED and COPIED.
 *
 * Two separate things were stopping it, and fixing either one alone leaves the
 * user exactly as stuck:
 *
 *  1. **`Mod+C` never reached the browser.** It is bound to Copy selected
 *     instance, and the catalog dispatcher `preventDefault()`s every binding it
 *     matches — which cancels the keydown's `copy` default action too. So the
 *     text could be highlighted and the keystroke did nothing but write
 *     "No instance selected to copy" into the status bar.
 *     `shouldIgnoreShortcut` (`ui/keyboard-target.js`) now hands the copy/cut
 *     chord back whenever a selection exists.
 *  2. **`user-select: none`.** Section headings in the info panel, the plane
 *     panel and the Settings modal, and the whole status bar, could not be
 *     dragged over at all.
 *
 * Both halves are asserted here, and so is the SCOPE of the second: the menu
 * bar, the toolbars, the video overlays and the modal drag handles must stay
 * non-selectable, or dragging a dialog by its title smears a selection across
 * it. §4 is the negative control that keeps the first half honest — with no
 * selection, `Mod+C` must still be Copy selected instance.
 *
 * The real clipboard is exercised, not a proxy: `page.keyboard.press` in
 * headless Chromium dispatches the key but never runs the browser's edit
 * command, so the chord goes through CDP with `commands: ['Copy']`, which IS
 * cancelled by `preventDefault` and therefore discriminates the two cases.
 *
 * Run: node copy-panel-text.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8247);
const ORIGIN = `http://localhost:${PORT}`;

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    await page.goto(`${ORIGIN}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const cdp = await ctx.newCDPSession(page);

    // The copy chord as the BROWSER sees it. `commands: ['Copy']` is what makes
    // Chromium run its own copy as the keydown's default action; Playwright's
    // own `keyboard.press` dispatches the key without it, so a headless run
    // would report "nothing copied" whether the app cancelled the event or not
    // — the test would pass on a build that still swallows the chord.
    async function copyChord() {
        const k = {
            modifiers: 2, key: 'c', code: 'KeyC',
            windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67,
        };
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', commands: ['Copy'], ...k });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
    }

    const SENTINEL = 'CLIPBOARD-UNTOUCHED';
    async function clipboard() {
        return page.evaluate(() => navigator.clipboard.readText());
    }
    async function armClipboard() {
        await page.evaluate(s => navigator.clipboard.writeText(s), SENTINEL);
    }

    // Select the contents of `selector`, returning what the browser now
    // considers selected.
    async function selectIn(selector) {
        return page.evaluate(sel => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = document.createRange();
            r.selectNodeContents(el);
            const s = window.getSelection();
            s.removeAllRanges();
            s.addRange(r);
            return String(s).replace(/\s+/g, ' ').trim();
        }, selector);
    }

    const statusText = () => page.evaluate(() => {
        const el = document.getElementById('statusText') ||
            document.querySelector('.status-bar .status-text');
        return el ? el.textContent : null;
    });

    const userSelect = sel => page.evaluate(s => {
        const el = document.querySelector(s);
        return el ? getComputedStyle(el).userSelect : null;
    }, sel);

    // =========================================================
    console.log('\n--- 1. Panel text copies ---');
    // =========================================================
    await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        if (!P.planeState.active) P.togglePlaneMode();
        document.getElementById('planeNodeNameInput').value = 'corner';
        document.getElementById('btnAddPlaneNode').click();
        P.refreshPlanePanel();
    });
    await page.waitForTimeout(250);

    await armClipboard();
    const planeSel = await selectIn('#planeNodesDetails > summary');
    check(!!planeSel && planeSel.length > 0,
        'the plane panel\'s section heading can be selected at all: ' + JSON.stringify(planeSel));
    await copyChord();
    await page.waitForTimeout(200);
    const planeClip = await clipboard();
    check(planeClip !== SENTINEL, 'Mod+C reaches the browser — the clipboard changed');
    check(planeClip.includes('Nodes'),
        'and holds what was selected: ' + JSON.stringify(planeClip.slice(0, 60)));

    // The body, not just the heading: a whole section drags over in one go.
    await armClipboard();
    const bodySel = await selectIn('#planeNodesDetails .plane-details-body');
    check(!!bodySel && bodySel.length > 10, 'a section BODY selects too');
    await copyChord();
    await page.waitForTimeout(200);
    const bodyClip = await clipboard();
    check(bodyClip !== SENTINEL && bodyClip.includes('corner'),
        'and the node name it lists lands on the clipboard');

    // =========================================================
    console.log('\n--- 2. The status bar copies — that is where errors land ---');
    // =========================================================
    await armClipboard();
    const statusSel = await selectIn('.status-bar');
    check(!!statusSel && statusSel.length > 0, 'the status bar can be selected');
    await copyChord();
    await page.waitForTimeout(200);
    const statusClip = await clipboard();
    check(statusClip !== SENTINEL, 'and copies');
    check(/\S/.test(statusClip), 'with its message in it: ' + JSON.stringify(statusClip.slice(0, 60)));

    // =========================================================
    console.log('\n--- 3. A MODAL copies ---');
    // =========================================================
    await page.evaluate(async () => {
        const S = await import('/ui/settings-modal.js');
        S.showSettingsModal();
    });
    await page.waitForTimeout(400);
    const modalOpen = await page.evaluate(() =>
        !!document.querySelector('.settings-modal, #settingsModal'));
    check(modalOpen === true, 'the Settings modal is up');

    await armClipboard();
    // Blur first, so the modal's own autofocused field is not what answers.
    //
    // This section is about SELECTABILITY, not about the dispatcher: the
    // Settings modal stops keydown before it reaches `document`, so the copy
    // chord never met the catalog dispatcher even on the old build. It passes
    // either way, and deliberately — what it pins is that a modal's text can be
    // dragged over and copied at all. §1 and §2 are the regression.
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
    // The modal's own body, not a section heading: the Settings modal opens on
    // one panel and builds the others hidden, so a heading picked by class has
    // a zero box and selects to the empty string — which would make this pass
    // for the wrong reason.
    const modalSel = await selectIn('.settings-modal-body');
    check(!!modalSel && modalSel.length > 10,
        'the modal body selects: ' + JSON.stringify(modalSel.slice(0, 50)));
    await copyChord();
    await page.waitForTimeout(200);
    const modalClip = await clipboard();
    check(modalClip !== SENTINEL, 'and copies out of the modal');
    check(/\S/.test(modalClip), 'with its text in it: ' + JSON.stringify(modalClip.slice(0, 50)));

    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);

    // =========================================================
    console.log('\n--- 4. NEGATIVE CONTROL: with no selection, Mod+C is still Copy instance ---');
    // =========================================================
    // The whole fix is scoped by "is there a selection". Without this, a build
    // that simply deleted the `copyInstance` binding would pass every check
    // above.
    await armClipboard();
    await page.evaluate(() => {
        window.getSelection().removeAllRanges();
        const el = document.getElementById('statusText') ||
            document.querySelector('.status-bar .status-text');
        if (el) el.textContent = 'idle';
    });
    await copyChord();
    await page.waitForTimeout(200);
    check((await clipboard()) === SENTINEL,
        'nothing is copied — there was nothing selected to copy');
    check(/instance/i.test(await statusText() || ''),
        'and the app acted on it instead: ' + JSON.stringify(await statusText()));

    // =========================================================
    console.log('\n--- 5. Typing in a field is untouched ---');
    // =========================================================
    // A text input already owned every key through `isTextEntryTarget`; the new
    // rule must not have changed which branch answers.
    await armClipboard();
    const fieldClip = await page.evaluate(async () => {
        const input = document.getElementById('planeNodeNameInput');
        input.value = 'typed-in-a-field';
        input.focus();
        input.setSelectionRange(0, input.value.length);
        return input.value;
    });
    await copyChord();
    await page.waitForTimeout(200);
    check((await clipboard()) === fieldClip,
        'a selection inside a text field copies as it always did');

    // =========================================================
    console.log('\n--- 6. SCOPE: chrome and drag handles stay non-selectable ---');
    // =========================================================
    check((await userSelect('.menu-bar')) === 'none', 'the menu bar is not selectable');
    check((await userSelect('.toolbar')) === 'none', 'nor the toolbar');
    check((await userSelect('.view-strip')) === 'none', 'nor the view strip');
    check((await userSelect('.controls-bar')) === 'none', 'nor the transport bar');
    check((await userSelect('.plane-mode-bar')) === 'none', 'nor the Plane Mode bar');

    // The one that would actually hurt: a dialog dragged by its title would
    // smear a selection across it on every move.
    await page.evaluate(async () => {
        const S = await import('/ui/settings-modal.js');
        S.showSettingsModal();
    });
    await page.waitForTimeout(400);
    check((await userSelect('.settings-modal-header')) === 'none',
        'a modal\'s drag handle stays non-selectable');
    check((await userSelect('.settings-section-summary')) === 'text',
        'while the section headings inside it are selectable');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    console.log(`\n${fails === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${fails} CHECK(S) FAILED`}`);
} catch (e) {
    console.error('FATAL', e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
process.exit(fails === 0 ? 0 : 1);
