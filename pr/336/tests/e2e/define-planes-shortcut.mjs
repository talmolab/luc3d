/**
 * define-planes-shortcut.mjs — Mod+Shift+P toggles Defining Plane Mode.
 *
 * Define Planes had no keyboard shortcut at all: it was reachable only from
 * View ▸ Define Planes. This pins the binding that was added, and — more
 * usefully — the two ways such a binding goes wrong.
 *
 *  1. It works, both ways, and lands in the same state the MENU ITEM produces.
 *     Entering and leaving the mode has real unwinding to do (Set Origin Mode,
 *     the angle dialog, the toolbar lock), so a shortcut that took a second
 *     code path would be a second place to forget it.
 *  2. NEGATIVE CONTROL: bare `p` still toggles Predicted keypoints and does NOT
 *     touch plane mode. `p` was already taken when this binding was chosen, and
 *     `matchChord`'s rule that a bare letter requires shift to be UP is the only
 *     thing keeping them apart.
 *  3. It is suppressed while a text field has focus. The plane panel is full of
 *     name inputs, so a shortcut that fired while renaming a plane would be
 *     actively hostile.
 *  4. It is in `ACTION_CATALOG`, which is what puts it in Settings ▸ Keyboard
 *     Shortcuts and makes it rebindable — the maintenance rule in CLAUDE.md.
 *
 * Run: node define-planes-shortcut.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8232);

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
        if (/Failed to load resource|net::ERR|404/.test(t)) return;
        console.log('  [console.error]', t.slice(0, 300));
        fails++;
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // The chord as the user types it. Playwright maps Control on Linux/Windows
    // and Meta on macOS; `matchChord`'s `mod` accepts EITHER, which is the whole
    // point of writing the binding as `Mod+`, so pressing Control here exercises
    // the same path a Mac user's Cmd does.
    const CHORD = 'Control+Shift+P';
    const planeActive = () => page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        return P.planeState.active;
    });
    const panelShown = () => page.evaluate(() => {
        const el = document.getElementById('planePanel');
        return !!el && el.style.display !== 'none';
    });

    console.log('\n--- 1. The chord toggles the mode ---');
    check(await planeActive() === false, 'the app starts outside Defining Plane Mode');

    await page.keyboard.press(CHORD);
    check(await planeActive() === true, 'Mod+Shift+P enters it');
    check(await panelShown() === true, 'and the Define Plane panel is shown');

    await page.keyboard.press(CHORD);
    check(await planeActive() === false, 'pressing it again leaves');
    check(await panelShown() === false, 'and the panel is hidden again');

    console.log('\n--- 2. The menu item is the SAME code path ---');
    await page.evaluate(() => document.getElementById('menuDefinePlanes').click());
    const viaMenu = await planeActive();
    await page.evaluate(() => document.getElementById('menuDefinePlanes').click());
    await page.keyboard.press(CHORD);
    const viaKey = await planeActive();
    check(viaMenu === true && viaKey === true,
        'menu and shortcut both enter the mode');
    await page.keyboard.press(CHORD);
    check(await planeActive() === false, 'and it is off again for what follows');

    console.log('\n--- 3. NEGATIVE CONTROL: bare `p` is a different action ---');
    const predictedOn = () => page.evaluate(() => {
        const cb = document.getElementById('visPredicted');
        return cb ? cb.checked : null;
    });
    const before = await predictedOn();
    await page.keyboard.press('p');
    check(await planeActive() === false,
        '`p` alone does NOT enter plane mode — shift being up is what separates them');
    check(await predictedOn() === !before,
        'it still toggles Predicted keypoints, which owned `p` first');
    await page.keyboard.press('p');
    check(await predictedOn() === before, '(restored)');

    // Shift+P without the modifier must also miss: `p` requires shift UP and the
    // new binding requires Ctrl/Cmd, so neither claims it.
    await page.keyboard.press('Shift+P');
    check(await planeActive() === false, 'and Shift+P without Ctrl/Cmd does nothing either');
    check(await predictedOn() === before, 'including to Predicted');

    console.log('\n--- 4. Suppressed while typing ---');
    await page.keyboard.press(CHORD);
    check(await planeActive() === true, 'in the mode, with its name fields on screen');
    const typed = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        P.createPlane('wall');
        P.refreshPlanePanel();
        const input = document.getElementById('planeSkeletonName');
        if (!input) return { missing: true };
        input.focus();
        return { missing: false, focused: document.activeElement === input };
    });
    check(typed.missing !== true && typed.focused === true, 'a plane name field has focus');
    await page.keyboard.press(CHORD);
    check(await planeActive() === true,
        'the chord is IGNORED while a text field owns the keyboard — renaming a ' +
        'plane must not drop you out of the mode');
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press(CHORD);
    check(await planeActive() === false, 'and works again once focus leaves it');

    console.log('\n--- 5. Catalogued, so Settings lists it and it rebinds ---');
    const cat = await page.evaluate(async () => {
        const S = await import('/ui/settings.js');
        // `getActions()` is the catalog as the Settings modal sees it, which is
        // the surface that matters: if it is not here, it is not listed and not
        // rebindable.
        const all = S.getActions();
        const a = all.find(x => x.id === 'definePlanes');
        if (!a) return { present: false };
        return {
            present: true,
            binding: a.binding,
            category: a.category,
            editable: a.editable,
            dispatched: a.dispatched,
            // A `dispatched` action whose chord does not match is silently dead,
            // which is exactly the failure the catalog exists to prevent.
            handled: S.matchesBinding('definePlanes', {
                key: 'P', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false,
            }),
            handledOnMac: S.matchesBinding('definePlanes', {
                key: 'p', ctrlKey: false, metaKey: true, shiftKey: true, altKey: false,
            }),
            collides: all.filter(x => x.binding === a.binding).length,
        };
    });
    check(cat.present === true, 'the action is in ACTION_CATALOG');
    check(cat.binding === 'Mod+Shift+P', 'bound to Mod+Shift+P: ' + cat.binding);
    check(cat.category === 'View', 'in the View category');
    check(cat.editable === true && cat.dispatched === true,
        'dispatched and editable, so Settings can rebind it');
    check(cat.handled === true, 'Ctrl+Shift+P matches that binding');
    check(cat.handledOnMac === true,
        'and so does Cmd+Shift+p — `Mod+` accepts either, so Mac and Windows agree');
    check(cat.collides === 1, 'no other catalogued action claims the same chord');

    // The actual user-visible list. The help renders straight from
    // `getActions()`, so this is the end of the chain the CLAUDE.md maintenance
    // rule is about: catalogued => discoverable.
    //
    // Opened with `?`, its own catalogued binding. That used to throw
    // `ReferenceError: showHotkeysHelp is not defined` — the function was
    // declared inside `setupMenus`'s closure while `setHandler('showHotkeys',
    // ...)` runs in `setupUI`, so the help had never opened from the keyboard at
    // all, for any shortcut. Asserting it here is what keeps it from regressing.
    await page.keyboard.press('?');
    await page.waitForTimeout(150);
    const help = await page.evaluate(() => {
        const text = document.body.innerText || '';
        return {
            open: /Keyboard Shortcuts/i.test(text),
            hasRow: /Toggle Defining Plane Mode/.test(text),
            // However the platform formats it, the chord has to be shown.
            hasChord: /(⌘|Ctrl)[^\n]*⇧?[^\n]*P|Shift\+P/i.test(text),
            // One overlay, not two: the catalog dispatcher does not consume the
            // keydown for the listeners after it.
            overlays: document.querySelectorAll('#hotkeysClose').length,
        };
    });
    check(help.open === true, '`?` opens the Keyboard Shortcuts help');
    check(help.overlays === 1, 'exactly one help overlay, not a stack: ' + help.overlays);
    check(help.hasRow === true,
        'and it LISTS Toggle Defining Plane Mode — catalogued means discoverable');
    check(help.hasChord === true, 'with its chord shown');

    // Pressing it again while it is up must not stack a second copy.
    await page.keyboard.press('?');
    await page.waitForTimeout(100);
    check(await page.evaluate(() => document.querySelectorAll('#hotkeysClose').length) === 1,
        'and pressing `?` again does not open another on top of it');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    check(await page.evaluate(() => document.querySelectorAll('#hotkeysClose').length) === 0,
        'Esc closes it');

    // The menu item is the same one function, so it must land in the same place.
    await page.evaluate(() => document.getElementById('menuHotkeys').click());
    await page.waitForTimeout(150);
    check(await page.evaluate(() => /Toggle Defining Plane Mode/.test(document.body.innerText || '')) === true,
        'the Hot Keys menu item shows the same list');
    await page.keyboard.press('Escape');

    console.log(fails === 0 ? '\nPASS — 0 failure(s)' : `\nFAIL — ${fails} failure(s)`);
} catch (err) {
    console.log('  ✗ threw: ' + (err && err.message ? err.message : String(err)));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
process.exit(fails === 0 ? 0 : 1);
