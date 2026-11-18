/**
 * desktop-native-menu.mjs — the desktop shim (`src-tauri/js/lucid-desktop.js`)
 * mirrors LUCID's in-page menu bar into the native macOS menu bar.
 *
 * The real LUCID page is loaded with a mock `__TAURI_INTERNALS__` (only the
 * commands this needs; `set_app_menu` is recorded) and a platform forced by
 * overriding navigator.platform / userAgent before the shim runs. A native
 * menu click is what Rust does: evaluate `window.__lucidNativeMenuAction(key)`
 * (Playwright's evaluate, like WKWebView's evaluateJavaScript, runs with a
 * user gesture).
 *
 *   1. macOS: the spec sent to set_app_menu is the in-page bar — top-level
 *      order; every File / Edit / Calibrate / View / Help label, in order, with
 *      separators, no shortcut hints ("Save", not "SaveCtrl+S"), "..." as "…";
 *      Hot Keys as a one-item menu; Docs / Settings bar buttons left out (they
 *      repeat Help); Tracks ▸ Node Trails as a submenu with its Length / Shade
 *      headings inert and one tick per group; keys are the element ids; the
 *      item counts match the DOM. The in-page bar is then hidden.
 *   2. A native click does what the in-page click does: View ▸ Toggle Info
 *      Panel, Hot Keys, Tracks ▸ Node Trails ▸ 1 second (and the tick moves in
 *      a resend).
 *   3. Resends: <body>.origin-mode-lock disables every page item (and a native
 *      click on one does nothing); a hidden item leaves the spec; the build
 *      label goes to About; an Edit Group toast shows the bar (menus still
 *      hidden); an unchanged page sends nothing more.
 *   4. File pickers from the native menu: with activation, File ▸ Load
 *      Calibration opens the chooser at once and loads; WITHOUT activation
 *      (what WKWebView leaves after an await) a "Choose a file" prompt appears
 *      instead, its Choose click opens the chooser, Cancel resolves the pick
 *      empty.
 *   5. set_app_menu rejecting keeps the in-page menus (and a later change
 *      retries); answering false stops for good; Linux / Windows never call it,
 *      keep the bar, and install no picker prompt.
 *
 * Usage: node tests/e2e/desktop-native-menu.mjs [PORT]   (default 9711, or $PORT)
 *        BROWSER=webkit node tests/e2e/desktop-native-menu.mjs
 */
import * as playwright from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const SHIM = path.join(repoRoot, 'src-tauri', 'js', 'lucid-desktop.js');
const CALIB = path.join(repoRoot, 'tests', 'fixtures', 'multi-session-calib', 'calibration.toml');
const PORT = Number(process.argv[2] || process.env.PORT || 9711);
const BASE = `http://localhost:${PORT}`;
const BROWSER = process.env.BROWSER || 'chromium';

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 900)));
    if (!c) fails++;
};
const section = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Runs in the page before the shim.
function installMock(cfg) {
    const UA = {
        macos: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
        windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)',
    }[cfg.platform];
    const PLATFORM = { macos: 'MacIntel', windows: 'Win32', linux: 'Linux x86_64' }[cfg.platform];
    const def = (k, v) => Object.defineProperty(Navigator.prototype, k, { get: () => v, configurable: true });
    def('userAgent', UA);
    def('platform', PLATFORM);
    def('userAgentData', undefined);
    if (!cfg.tauri) return;

    const calls = [];
    const queues = { menuFail: cfg.menuFail || 0, menuReturns: cfg.menuReturns !== undefined ? cfg.menuReturns : true };
    window.__TAURI_INTERNALS__ = {
        async invoke(cmd, args) {
            const name = String(cmd).replace('plugin:lucid|', '');
            calls.push({ cmd: name, args: JSON.parse(JSON.stringify(args === undefined ? null : args)) });
            if (name === 'set_app_menu') {
                if (queues.menuFail > 0) { queues.menuFail--; throw 'set_app_menu: mock failure'; }
                return queues.menuReturns;
            }
            if (name === 'system_info') return { os: cfg.platform, arch: 'aarch64', cpus: 8, totalMemoryBytes: 1, appVersion: '1.0.5', tauriVersion: '2', desktop: true };
            if (name === 'ask_dialog') return false;
            return null;
        },
    };
    window.__TAURI__ = { core: {}, event: { listen() { return Promise.resolve(() => {}); } } };
    window.__mock = {
        calls, queues,
        menus: () => calls.filter(c => c.cmd === 'set_app_menu'),
        last: () => { const m = calls.filter(c => c.cmd === 'set_app_menu'); return m.length ? m[m.length - 1].args : null; },
    };
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
let browser;
const consoleErrors = [];

async function openApp(cfg) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 400)); fails++; });
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    await page.addInitScript(installMock, cfg);
    await page.addInitScript({ path: SHIM });
    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state &&
        document.querySelectorAll('#menuTrailsSubmenu .menu-dropdown-item').length > 0, null, { timeout: 60000 });
    return page;
}

/** Compact rendering of spec items: "Label", "---", "[off]", "[x]"/"[ ]", " >". */
function flat(items) {
    return items.map(i => i.separator ? '---'
        : i.label + (i.enabled === false ? ' [off]' : '') +
          (i.checked === true ? ' [x]' : i.checked === false ? ' [ ]' : '') + (i.submenu ? ' >' : ''));
}
const menuOf = (spec, label) => spec && spec.menus.find(m => m.label === label);
const allItems = (items) => items.flatMap(i => [i, ...(i.submenu ? allItems(i.submenu) : [])]);
const native = (page, key) => page.evaluate(k => window.__lucidNativeMenuAction(k), key);
const menuCount = (page) => page.evaluate(() => window.__mock.menus().length);
async function waitForResend(page, before, pred, what) {
    try {
        await page.waitForFunction(([n, src]) => {
            const m = window.__mock.menus();
            if (m.length <= n) return false;
            // eslint-disable-next-line no-new-func
            return new Function('spec', 'return (' + src + ')(spec)')(m[m.length - 1].args);
        }, [before, pred.toString()], { timeout: 5000 });
        return true;
    } catch (e) {
        check(false, 'resend: ' + what);
        return false;
    }
}
const barState = (page) => page.evaluate(() => {
    const bar = document.getElementById('menuBar');
    const file = bar.querySelector('.menu-item[data-menu="file"]');
    return {
        attr: document.documentElement.dataset.lucidNativeMenu || null,
        bar: getComputedStyle(bar).display,
        file: getComputedStyle(file).display,
        version: getComputedStyle(document.getElementById('menuBarVersion')).display,
    };
});

try {
    browser = await playwright[BROWSER].launch({ headless: true });
    console.log('browser: ' + BROWSER + ' ' + browser.version());

    // =======================================================================
    section('1) macOS: the spec is the in-page menu bar; the bar hides after success');
    const page = await openApp({ platform: 'macos', tauri: true });
    await page.waitForFunction(() => document.documentElement.dataset.lucidNativeMenu === '1', null, { timeout: 10000 });
    const spec = await page.evaluate(() => window.__mock.last());
    check(spec && Array.isArray(spec.menus), 'set_app_menu called with {menus}', spec);
    check(JSON.stringify(spec.menus.map(m => m.label)) ===
        JSON.stringify(['File', 'Edit', 'Calibrate', 'Tracks', 'View', 'Hot Keys', 'Help']),
        'top-level order File, Edit, Calibrate, Tracks, View, Hot Keys, Help (Docs/Settings buttons left out)',
        spec.menus.map(m => m.label));
    const expect = {
        File: ['New Project', 'Save', 'Save As…', 'Save Compact Copy…', 'Load Project…', '---',
            'Session Folder Wizard…', 'Load Single Session Folder', 'Load Multi-Session Folder', 'Load Videos…',
            'Load Calibration…', 'Load SLP…', 'Load 3D Points (H5)…', 'Load Skeleton…', '---',
            'Save Skeleton (JSON)', 'Export Labels (JSON)', 'Export SLEAP File Per Session', 'Export SLEAP File By Cam',
            'Export Video Overlays', 'Export 3D Video', 'Export 3D Points (H5)', 'Export Reprojections (H5)',
            'Export Calibration (TOML)'],
        Edit: ['Add Instance', 'Delete Instance', 'Custom Instance Delete…', '---', 'Unlink Group', '---',
            'Triangulate Current Frame', 'Triangulate Multiple Frames', '---',
            'Group by Track & Triangulate All', 'Group by Identity & Triangulate All'],
        Calibrate: ['Calibrate in New Tab'],
        View: ['Toggle 3D Viewport', 'Toggle Timeline', 'Toggle Info Panel', '---', 'Native Resolution (1:1) [ ]', '---',
            'Reset 3D View', 'Fit 3D to Scene', '---', 'Define Planes', 'Align Views to References…', '---', 'Connect Window…'],
        'Hot Keys': ['Show Hot Keys'],
        Help: ['Docs', 'Settings'],
    };
    for (const [label, want] of Object.entries(expect)) {
        const got = flat(menuOf(spec, label).items);
        check(JSON.stringify(got) === JSON.stringify(want), `${label}: labels, order, separators, ticks`, got);
    }
    check(menuOf(spec, 'File').items[0].key === 'menuNewProject' && menuOf(spec, 'Hot Keys').items[0].key === 'menuHotkeys' &&
        menuOf(spec, 'Help').items[1].key === 'menuSettings', 'keys are the element ids');
    check(allItems(spec.menus.flatMap(m => m.items)).filter(i => !i.separator).every(i => typeof i.label === 'string' && i.label),
        'every item has a label');
    // Item counts against the DOM (direct children of each dropdown).
    const domCounts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#menuBar > .menu-item[data-menu]')]
        .map(el => [el.dataset.menu, el.querySelectorAll(':scope > .menu-dropdown > .menu-dropdown-item, :scope > .menu-dropdown > .menu-separator').length])));
    for (const [menu, label] of [['file', 'File'], ['edit', 'Edit'], ['calibrate', 'Calibrate'], ['tracks', 'Tracks'], ['view', 'View'], ['help', 'Help']]) {
        check(menuOf(spec, label).items.length === domCounts[menu], `${label}: ${domCounts[menu]} entries as in the DOM`,
            { spec: menuOf(spec, label).items.length, dom: domCounts[menu] });
    }
    const tracks = flat(menuOf(spec, 'Tracks').items);
    check(JSON.stringify(tracks) === JSON.stringify(['New Track…', 'Rename Track…', 'Delete Track…', '---', 'Swap Tracks…', '---',
        'New Identity…', 'Rename Identity…', 'Delete Identity…', '---', 'Propagate Tracks → IDs', 'Propagate IDs → Tracks', '---',
        'Check ID Switches (Body Size)…', 'Check ID Switches (Images)…', '---', 'Node Trails >', '---', 'Tracking Wizard…']),
        'Tracks: labels, order, Node Trails as a submenu', tracks);
    const trailsSpec = menuOf(spec, 'Tracks').items.find(i => i.label === 'Node Trails');
    const trailsDom = await page.evaluate(() => [...document.querySelectorAll('#menuTrailsSubmenu .menu-dropdown-item')]
        .map(el => ({ key: el.id, label: el.querySelector('.trail-label').textContent.trim(), checked: el.getAttribute('aria-checked') === 'true' })));
    const trailItems = trailsSpec.submenu.filter(i => i.key);
    check(trailsSpec.submenu[0].label === 'Length' && trailsSpec.submenu[0].enabled === false && !trailsSpec.submenu[0].key,
        'Node Trails: "Length" heading, inert');
    check(trailsSpec.submenu.some(i => i.label === 'Shade' && i.enabled === false && !i.key), 'Node Trails: "Shade" heading, inert');
    check(JSON.stringify(trailItems.map(i => [i.key, i.label, i.checked])) ===
        JSON.stringify(trailsDom.map(i => [i.key, i.label.replace(/\.\.\.$/, '…'), i.checked])),
        'Node Trails: every length and shade, with the DOM\'s labels and ticks', { spec: trailItems, dom: trailsDom });
    check(trailItems.filter(i => /Shade/.test(i.key)).filter(i => i.checked).length === 1 &&
        trailItems.filter(i => !/Shade/.test(i.key)).filter(i => i.checked).length === 1, 'one tick per group');
    check(spec.about === null, 'no build label in a working tree: about is null', spec.about);
    let st = await barState(page);
    check(st.attr === '1' && st.bar === 'none' && st.file === 'none', 'in-page bar hidden once installed', st);
    const n0 = await menuCount(page);
    await sleep(1800);   // two polls
    check(await menuCount(page) === n0, 'an unchanged page sends nothing more', { before: n0, after: await menuCount(page) });

    // =======================================================================
    section('2) a native click does what the in-page click does');
    const collapsed = () => page.evaluate(() => document.getElementById('infoPanelWrapper').classList.contains('collapsed'));
    const c0 = await collapsed();
    check(await native(page, 'menuToggleInfo') === true, 'View ▸ Toggle Info Panel: action accepted');
    const c1 = await collapsed();
    check(c1 === !c0, 'native: the info panel toggled', { c0, c1 });
    // The same item clicked in the page (bar shown for the click).
    await page.evaluate(() => { delete document.documentElement.dataset.lucidNativeMenu; });
    await page.click('#menuBar > .menu-item[data-menu="view"]');
    await page.click('#menuToggleInfo');
    check(await collapsed() === c0, 'in-page click toggles it back: the same action');
    const openDropdowns = await page.evaluate(() => [...document.querySelectorAll('#menuBar .menu-dropdown')].filter(d => d.style.display === 'block').length);
    check(openDropdowns === 0, 'no in-page dropdown left open');
    await page.click('#menuHotkeys');
    check(await page.$('#hotkeysClose') !== null, 'in-page Hot Keys opens the help');
    await page.click('#hotkeysClose');
    await page.evaluate(() => { document.documentElement.dataset.lucidNativeMenu = '1'; });
    check(await native(page, 'menuHotkeys') === true && await page.$('#hotkeysClose') !== null, 'native Hot Keys ▸ Show Hot Keys opens the same help');
    await page.keyboard.press('Escape');
    check(await page.$('#hotkeysClose') === null, 'Esc closes it');
    let n = await menuCount(page);
    check(await native(page, 'menuTrailsSecond') === true, 'Tracks ▸ Node Trails ▸ 1 second: action accepted');
    check(await page.evaluate(() => window.__lucid.state.trailSeconds) === 1, 'state.trailSeconds is 1 (as the in-page item sets it)');
    await waitForResend(page, n, (s) => {
        const t = s.menus.find(m => m.label === 'Tracks').items.find(i => i.label === 'Node Trails').submenu;
        return t.find(i => i.key === 'menuTrailsSecond').checked === true && t.find(i => i.key === 'menuTrailsOff').checked === false;
    }, 'the tick moved to 1 second');
    check(await native(page, 'no-such-key') === false, 'an unknown key does nothing');

    // =======================================================================
    section('3) resends on state changes');
    n = await menuCount(page);
    await page.evaluate(() => document.body.classList.add('origin-mode-lock'));
    if (await waitForResend(page, n, (s) => s.menus.every(m => (function all(items) {
        return items.every(i => i.separator || (i.enabled === false && (!i.submenu || all(i.submenu))));
    })(m.items)), 'origin-mode-lock disables every page item')) check(true, 'origin-mode-lock: every page item disabled');
    const cBefore = await collapsed();
    check(await native(page, 'menuToggleInfo') === false && await collapsed() === cBefore, 'a click on a disabled item does nothing');
    n = await menuCount(page);
    await page.evaluate(() => document.body.classList.remove('origin-mode-lock'));
    if (await waitForResend(page, n, (s) => s.menus.find(m => m.label === 'File').items[0].enabled === true, 'unlocked')) check(true, 'unlocked: enabled again');
    // A label LUCID only refreshes when its menu opens (Node Trails reads the
    // frame rate on mouseenter): no DOM changes, so the poll's open cue finds it.
    const secondLabel = (s) => s.menus.find(m => m.label === 'Tracks').items.find(i => i.label === 'Node Trails')
        .submenu.find(i => i.key === 'menuTrailsSecond').label;
    const label0 = secondLabel(await page.evaluate(() => window.__mock.last()));
    n = await menuCount(page);
    const fps0 = await page.evaluate(() => { const f = window.__lucid.state.fps; window.__lucid.state.fps = (f || 30) * 2; return f; });
    if (await waitForResend(page, n, new Function('s', `return s.menus.find(m => m.label === 'Tracks').items.find(i => i.label === 'Node Trails').submenu.find(i => i.key === 'menuTrailsSecond').label !== ${JSON.stringify(label0)}`),
        'frame-rate-dependent trail label')) {
        check(true, 'a label refreshed only on open (trail length at a new frame rate) reaches the native menu: ' +
            JSON.stringify(label0) + ' → ' + JSON.stringify(secondLabel(await page.evaluate(() => window.__mock.last()))));
    }
    await page.evaluate((f) => { window.__lucid.state.fps = f; }, fps0);
    n = await menuCount(page);
    await page.evaluate(() => { document.getElementById('menuAlignViews').hidden = true; });
    if (await waitForResend(page, n, (s) => !s.menus.find(m => m.label === 'View').items.some(i => i.key === 'menuAlignViews'), 'hidden item')) check(true, 'a hidden item leaves the native menu');
    await page.evaluate(() => { document.getElementById('menuAlignViews').hidden = false; });
    n = await menuCount(page);
    await page.evaluate(() => { const v = document.getElementById('menuBarVersion'); v.textContent = 'desktop 1.0.5 · abcdef12'; v.title = 'LUCID desktop 1.0.5 build (commit abcdef1234)'; v.hidden = false; });
    if (await waitForResend(page, n, (s) => s.about && s.about.text === 'desktop 1.0.5 · abcdef12' && /commit abcdef1234/.test(s.about.title), 'about')) check(true, 'the build label goes to About luc3d');
    st = await barState(page);
    check(st.bar === 'none' && st.version === 'none', 'the version label hides with the bar (it is in About now)', st);
    await page.evaluate(() => { const t = document.createElement('div'); t.className = 'auto-assign-toast'; t.id = 'testToast'; t.innerHTML = '<span>Editing Group</span><button>Cancel</button>'; document.getElementById('menuBar').appendChild(t); });
    st = await barState(page);
    const toastShown = await page.evaluate(() => { const r = document.getElementById('testToast').getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    check(st.bar !== 'none' && st.file === 'none' && toastShown, 'an Edit Group toast shows the bar, menus stay hidden', { st, toastShown });
    await page.evaluate(() => document.getElementById('testToast').remove());
    check((await barState(page)).bar === 'none', 'toast gone: the bar hides again');

    // =======================================================================
    section('4) file pickers from the native menu');
    {
        const chooserP = page.waitForEvent('filechooser', { timeout: 5000 });
        check(await native(page, 'menuLoadCalibration') === true, 'File ▸ Load Calibration: action accepted');
        const chooser = await chooserP.catch(() => null);
        check(!!chooser, 'with activation: the file chooser opens at once');
        check(await page.$('#lucidPickerGesture') === null, 'no extra prompt');
        if (chooser) {
            await chooser.setFiles(CALIB);
            await page.waitForFunction(() => window.__lucid.state.session && window.__lucid.state.session.cameras.length > 0, null, { timeout: 10000 }).catch(() => {});
            check(await page.evaluate(() => window.__lucid.state.session && window.__lucid.state.session.cameras.length) > 0, 'the calibration loaded');
        }
    }
    {
        // What WKWebView leaves a handler that picks after an await: no activation.
        await page.evaluate(() => Object.defineProperty(navigator, 'userActivation', { value: { isActive: false, hasBeenActive: true }, configurable: true }));
        let opened = false;
        const onChooser = () => { opened = true; };
        page.on('filechooser', onChooser);
        await native(page, 'menuLoadCalibration');
        await page.waitForSelector('#lucidPickerGesture', { timeout: 3000 }).catch(() => {});
        check(await page.$('#lucidPickerGesture') !== null, 'without activation: a "Choose a file" prompt instead of a dropped click');
        check(!opened, 'no chooser yet');
        check(await page.textContent('#lucidPickerGesture h3') === 'Choose a file', 'prompt title', await page.textContent('#lucidPickerGesture h3'));
        page.off('filechooser', onChooser);
        const chooserP = page.waitForEvent('filechooser', { timeout: 5000 });
        await page.click('#lucidPickerChoose');
        const chooser = await chooserP.catch(() => null);
        check(!!chooser && await page.$('#lucidPickerGesture') === null, 'Choose (a real click) opens the chooser and closes the prompt');
        if (chooser) await chooser.setFiles(CALIB);
        await page.waitForFunction(() => /calibration/i.test(document.getElementById('statusText').textContent), null, { timeout: 5000 }).catch(() => {});
        // Cancel: the pick resolves empty, LUCID says so.
        await native(page, 'menuLoadCalibration');
        await page.waitForSelector('#lucidPickerGesture', { timeout: 3000 }).catch(() => {});
        await page.click('#lucidPickerCancel');
        await page.waitForFunction(() => /No calibration loaded/.test(document.getElementById('statusText').textContent), null, { timeout: 5000 }).catch(() => {});
        check(await page.$('#lucidPickerGesture') === null, 'Cancel closes the prompt');
        check(/No calibration loaded/.test(await page.textContent('#statusText')), 'Cancel: the pick resolves empty ("No calibration loaded")', await page.textContent('#statusText'));
        // Esc cancels too.
        await native(page, 'menuLoadSlp');
        await page.waitForSelector('#lucidPickerGesture', { timeout: 3000 }).catch(() => {});
        await page.keyboard.press('Escape');
        check(await page.$('#lucidPickerGesture') === null, 'Esc closes the prompt');
        await page.evaluate(() => { delete navigator.userActivation; });
    }
    await page.close();

    // =======================================================================
    section('5) failures and other platforms keep the in-page menus');
    {
        consoleErrors.length = 0;
        const p = await openApp({ platform: 'macos', tauri: true, menuFail: 1 });
        await p.waitForFunction(() => window.__mock.menus().length >= 1, null, { timeout: 10000 });
        await sleep(300);
        let s = await barState(p);
        check(s.attr === null && s.bar !== 'none' && s.file !== 'none', 'set_app_menu rejected: the in-page menus stay', s);
        check(consoleErrors.some(e => /native menu bar was not updated/.test(e)), 'the failure is logged');
        const n1 = await menuCount(p);
        await sleep(1700);
        check(await menuCount(p) === n1, 'the same spec is not retried in a loop');
        await p.evaluate(() => { document.getElementById('menuAlignViews').hidden = true; });
        await p.waitForFunction(() => document.documentElement.dataset.lucidNativeMenu === '1', null, { timeout: 5000 }).catch(() => {});
        s = await barState(p);
        check(s.attr === '1' && s.bar === 'none', 'a later change retries, and success hides the bar', s);
        await p.close();
    }
    {
        const p = await openApp({ platform: 'macos', tauri: true, menuReturns: false });
        await p.waitForFunction(() => window.__mock.menus().length >= 1, null, { timeout: 10000 });
        await p.evaluate(() => { document.getElementById('menuAlignViews').hidden = true; });
        await sleep(1200);
        const s = await barState(p);
        check(s.attr === null && s.bar !== 'none' && await menuCount(p) === 1, 'set_app_menu → false: stops, in-page menus stay', { s, n: await menuCount(p) });
        await p.close();
    }
    for (const platform of ['linux', 'windows']) {
        const p = await openApp({ platform, tauri: true });
        await sleep(1500);
        const s = await barState(p);
        const r = await p.evaluate(() => ({
            calls: window.__mock.menus().length,
            action: typeof window.__lucidNativeMenuAction,
            style: !!document.getElementById('lucid-native-menu-style'),
            platform: window.lucidDesktop.platform,
        }));
        check(r.platform === platform, `${platform}: shim platform`, r);
        check(r.calls === 0 && r.action === 'undefined' && !r.style, `${platform}: no set_app_menu, no action hook, no style`, r);
        check(s.attr === null && s.bar !== 'none' && s.file !== 'none', `${platform}: the in-page menu bar stays`, s);
        // No picker prompt off macOS: an input click goes straight through.
        await p.evaluate(() => Object.defineProperty(navigator, 'userActivation', { value: { isActive: false, hasBeenActive: true }, configurable: true }));
        await p.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.click(); });
        await sleep(200);
        check(await p.$('#lucidPickerGesture') === null, `${platform}: no picker prompt`);
        await p.close();
    }
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
