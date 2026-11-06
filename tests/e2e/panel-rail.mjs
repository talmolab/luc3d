/**
 * panel-rail.mjs — the info panel's panels are switched by an icon rail on the
 * window's right edge (ui/panel-rail.js), modelled on sleap-app's sidebar in
 * its one-panel-at-a-time mode. It replaced the horizontal tab bar.
 *
 * What this pins:
 *   §1  Every panel has an icon, in the old tab bar's order, each a Lucide
 *       glyph (sleap-app's for the panels the two apps share) with the panel's
 *       name as its accessible name; hovering widens the rail over the panel
 *       to show the names. The rail sits on the window edge and is the one
 *       `user-select: none` surface here.
 *   §2  A click on an icon shows its panel; a click on the active icon hides
 *       the info panel; a click while hidden brings it back on that panel.
 *       An icon is active only while its panel is on screen.
 *   §3  Every other way of hiding/showing the info panel still works and the
 *       rail follows: the `I` shortcut, the toolbar's Panel button, View ▸
 *       Toggle Info Panel, the rail's own top button.
 *   §4  Keyboard: Tab reaches an icon, focus widens the rail, Enter clicks it.
 *   §5  Code that opens a panel (`openIdSwitchPanel`, the ID-switch check's
 *       flow) shows it — from hidden too — and never hides it.
 *   §6  Define Planes disables the panel icons and restores them on exit.
 *   §7  The chosen panel is remembered across a reload (localStorage); the
 *       info panel still starts shown.
 *
 * Run: node panel-rail.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8241);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const EXPECTED = [
    ['tabInstances', 'Instances'], ['tabVisibility', 'Visibility'], ['tabIdSwitches', 'ID Switches'],
    ['tabVideos', 'Videos'], ['tabCameras', 'Cameras'], ['tabSkeleton', 'Skeleton'], ['tabSession', 'Session'],
];
// First path of the Lucide glyph each panel must show. Instances/Visibility/
// Videos/Skeleton are sleap-app's Users/Eye/Film/Bone; ID Switches is the
// two-opposing-arrows ArrowLeftRight.
const FIRST_PATH = {
    tabInstances: 'M16 21v-2a4 4 0 0 0-4-4H6',
    tabVisibility: 'M2.062 12.348',
    tabIdSwitches: 'M8 3 4 7l4 4',
    tabVideos: null, // rect first
    tabCameras: 'M13.997 4a2 2 0 0 1',
    tabSkeleton: 'M17 10c.7-.7 1.69 0 2.5 0',
    tabSession: 'M20 10a1 1 0 0 0 1-1V6',
};

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    await page.waitForTimeout(300);

    const railState = () => page.evaluate(() => {
        const wrap = document.getElementById('infoPanelWrapper');
        const btns = Array.from(document.querySelectorAll('#panelRail .panel-rail-btn[data-tab]'));
        const active = btns.filter(b => b.classList.contains('active')).map(b => b.dataset.tab);
        const pressed = btns.filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.tab);
        const content = Array.from(document.querySelectorAll('.panel-tab-content'))
            .filter(c => getComputedStyle(c).display !== 'none').map(c => c.id);
        const top = document.querySelector('#panelRail .panel-rail-collapse');
        return {
            collapsed: wrap.classList.contains('collapsed'),
            wrapWidth: Math.round(wrap.getBoundingClientRect().width),
            active, pressed, content,
            topName: top.getAttribute('aria-label'),
            panelBtn: document.getElementById('infoPanelToggleBtn').getAttribute('aria-pressed'),
        };
    });
    // Click the ICON, as a user does: once hovered, the rest of the widened
    // button is a display-only label strip over the panel.
    const click = (tab) => page.click(`#panelRail .panel-rail-btn[data-tab="${tab}"] .panel-rail-icon`);
    const moveAway = () => page.mouse.move(300, 300);

    // ---- §1 inventory, icons, names, hover labels ----
    const inv = await page.evaluate(() => {
        const rail = document.getElementById('panelRail');
        const btns = Array.from(rail.querySelectorAll('.panel-rail-btn[data-tab]'));
        const r = rail.getBoundingClientRect();
        return {
            tabs: btns.map(b => [b.dataset.tab, b.getAttribute('aria-label')]),
            labels: btns.map(b => b.querySelector('.panel-rail-label').textContent),
            firstPath: Object.fromEntries(btns.map(b => {
                const el = b.querySelector('svg > *');
                return [b.dataset.tab, el && el.tagName === 'path' ? el.getAttribute('d') : el && el.tagName];
            })),
            allSvg: btns.every(b => !!b.querySelector('svg')),
            controls: btns.every(b => !!document.getElementById(b.getAttribute('aria-controls'))),
            rightEdge: Math.round(r.right) === window.innerWidth,
            width: Math.round(r.width),
            userSelect: getComputedStyle(rail).userSelect,
            noTabBar: !document.querySelector('.panel-tabs, .panel-tab'),
        };
    });
    check(JSON.stringify(inv.tabs) === JSON.stringify(EXPECTED),
        `one icon per panel, in the old tab order, named by aria-label (${JSON.stringify(inv.tabs.map(t => t[1]))})`);
    check(JSON.stringify(inv.labels) === JSON.stringify(EXPECTED.map(e => e[1])), 'each icon carries its panel name as a label');
    check(inv.allSvg, 'every icon is an inline <svg>');
    check(Object.entries(FIRST_PATH).every(([t, d]) => d === null
        ? inv.firstPath[t] === 'rect' : String(inv.firstPath[t]).startsWith(d)),
        'each icon is the expected Lucide glyph (Users, Eye, ArrowLeftRight, Film, Camera, Bone, FolderTree)');
    check(inv.controls, 'each icon aria-controls an existing panel');
    check(inv.rightEdge && inv.width === 44, `rail is 44px on the window's right edge (width ${inv.width})`);
    check(inv.userSelect === 'none', 'rail is user-select: none');
    check(inv.noTabBar, 'the old horizontal tab bar is gone');

    await page.hover('#panelRail .panel-rail-btn[data-tab="tabVideos"] .panel-rail-icon');
    await page.waitForTimeout(300);
    const hover = await page.evaluate(() => ({
        w: Math.round(document.querySelector('#panelRail .panel-rail-inner').getBoundingClientRect().width),
        op: getComputedStyle(document.querySelector('#panelRail .panel-rail-btn[data-tab="tabVideos"] .panel-rail-label')).opacity,
        slot: Math.round(document.getElementById('panelRail').getBoundingClientRect().width),
    }));
    check(hover.w === 184 && hover.op === '1' && hover.slot === 44,
        `hover widens the rail over the panel to show names, without reflow (inner ${hover.w}, label opacity ${hover.op}, slot ${hover.slot})`);
    // The widened label strip must never cover the panel's own controls: the
    // pointer over it is over the panel, and the rail narrows again.
    const stripX = 1440 - 44 - 70, stripY = 120;
    await page.mouse.move(stripX, stripY);
    await page.waitForTimeout(300);
    const strip = await page.evaluate(([x, y]) => ({
        inRail: !!document.elementFromPoint(x, y).closest('#panelRail'),
        w: Math.round(document.querySelector('#panelRail .panel-rail-inner').getBoundingClientRect().width),
    }), [stripX, stripY]);
    check(!strip.inRail && strip.w === 44,
        `the label strip is display-only: the panel under it gets the pointer and the rail narrows (${strip.w})`);
    await moveAway();
    await page.waitForTimeout(300);
    const unhover = await page.evaluate(() =>
        Math.round(document.querySelector('#panelRail .panel-rail-inner').getBoundingClientRect().width));
    check(unhover === 44, `leaving the rail narrows it again (${unhover})`);

    // ---- §2 toggling ----
    let s = await railState();
    check(!s.collapsed && JSON.stringify(s.active) === '["tabInstances"]' && JSON.stringify(s.content) === '["tabInstances"]',
        'starts on Instances with the panel shown');
    for (const [tab] of EXPECTED.slice(1)) {
        await click(tab);
        s = await railState();
        check(!s.collapsed && JSON.stringify(s.active) === JSON.stringify([tab]) &&
            JSON.stringify(s.pressed) === JSON.stringify([tab]) && JSON.stringify(s.content) === JSON.stringify([tab]),
            `clicking ${tab} shows it, and only its icon is active`);
    }
    await click('tabSession');
    await page.waitForTimeout(400);            // the panel's 250ms width transition
    s = await railState();
    check(s.collapsed && s.active.length === 0 && s.pressed.length === 0 && s.wrapWidth === 0,
        `clicking the active icon hides the info panel; no icon is active (wrapper ${s.wrapWidth}px)`);
    check(s.panelBtn === 'false' && s.topName === 'Show panel', 'the Panel button and the rail top button follow');
    await click('tabSkeleton');
    s = await railState();
    check(!s.collapsed && JSON.stringify(s.active) === '["tabSkeleton"]' && JSON.stringify(s.content) === '["tabSkeleton"]',
        'clicking an icon while hidden shows the panel on that tab');

    // ---- §3 every other hide/show still routes ----
    await moveAway();
    await page.keyboard.press('i');
    s = await railState();
    check(s.collapsed && s.active.length === 0, '`I` hides the panel and the rail clears its active icon');
    await page.keyboard.press('i');
    s = await railState();
    check(!s.collapsed && JSON.stringify(s.active) === '["tabSkeleton"]', '`I` shows it again on the same panel');

    await page.click('#infoPanelToggleBtn');
    s = await railState();
    check(s.collapsed && s.active.length === 0, 'toolbar Panel button hides it');
    await page.click('#infoPanelToggleBtn');
    s = await railState();
    check(!s.collapsed && JSON.stringify(s.active) === '["tabSkeleton"]', 'toolbar Panel button shows it again');

    await page.evaluate(() => document.getElementById('menuToggleInfo').click());
    s = await railState();
    check(s.collapsed, 'View ▸ Toggle Info Panel hides it');
    await page.evaluate(() => document.getElementById('menuToggleInfo').click());
    s = await railState();
    check(!s.collapsed && JSON.stringify(s.active) === '["tabSkeleton"]', 'View ▸ Toggle Info Panel shows it again');

    await page.click('#panelRail .panel-rail-collapse .panel-rail-icon');
    s = await railState();
    check(s.collapsed && s.topName === 'Show panel', "the rail's top button hides it");
    await page.click('#panelRail .panel-rail-collapse .panel-rail-icon');
    s = await railState();
    check(!s.collapsed && s.topName === 'Hide panel' && JSON.stringify(s.active) === '["tabSkeleton"]',
        "the rail's top button shows it again");

    // ---- §4 keyboard ----
    await moveAway();
    await page.evaluate(() => document.querySelector('#panelRail .panel-rail-btn[data-tab="tabSession"]').focus());
    await page.keyboard.press('Shift+Tab');      // a real keyboard move, so :focus-visible applies
    const kb = await page.evaluate(() => ({
        focused: document.activeElement && document.activeElement.dataset.tab,
        w: Math.round(document.querySelector('#panelRail .panel-rail-inner').getBoundingClientRect().width),
    }));
    check(kb.focused === 'tabSkeleton' && kb.w === 184, `Tab moves between icons and keyboard focus widens the rail (${kb.focused}, ${kb.w})`);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    s = await railState();
    check(!s.collapsed && JSON.stringify(s.active) === '["tabCameras"]', 'Enter on a focused icon shows its panel');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());

    // ---- §5 programmatic opens never hide ----
    await click('tabCameras');   // hide (Cameras is active)
    s = await railState();
    check(s.collapsed, 'precondition: panel hidden');
    await page.evaluate(async () => (await import('./ui/id-switch-modal.js')).openIdSwitchPanel());
    s = await railState();
    check(!s.collapsed && JSON.stringify(s.active) === '["tabIdSwitches"]' && JSON.stringify(s.content) === '["tabIdSwitches"]',
        'openIdSwitchPanel shows the hidden panel on ID Switches');
    await page.evaluate(async () => (await import('./ui/id-switch-modal.js')).openIdSwitchPanel());
    s = await railState();
    check(!s.collapsed && JSON.stringify(s.active) === '["tabIdSwitches"]', 'calling it again while showing does NOT hide it');
    const unknown = await page.evaluate(async () => (await import('./ui/panel-rail.js')).showPanelTab('tabNope'));
    check(unknown === false, 'showPanelTab refuses an unknown id');

    // ---- §6 Define Planes locks the icons ----
    await page.evaluate(async () => (await import('./ui/plane-definition.js')).togglePlaneMode());
    const locked = await page.evaluate(() => ({
        disabled: Array.from(document.querySelectorAll('#panelRail .panel-rail-btn[data-tab]')).every(b => b.disabled),
        topLive: !document.querySelector('#panelRail .panel-rail-collapse').disabled,
        planeShown: getComputedStyle(document.getElementById('planePanel')).display !== 'none',
    }));
    check(locked.disabled && locked.topLive && locked.planeShown,
        'in Define Planes the panel icons are disabled, the top hide/show stays live');
    await page.click('#panelRail .panel-rail-btn[data-tab="tabVideos"] .panel-rail-icon', { force: true });
    s = await railState();
    check(JSON.stringify(s.active) === '["tabIdSwitches"]', 'a click on a disabled icon changes nothing');
    await page.evaluate(async () => (await import('./ui/plane-definition.js')).togglePlaneMode());
    s = await railState();
    const unlocked = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#panelRail .panel-rail-btn[data-tab]')).every(b => !b.disabled));
    check(unlocked && JSON.stringify(s.content) === '["tabIdSwitches"]', 'leaving restores the icons and the same panel');

    // ---- §7 remembered across reload ----
    await click('tabVisibility');
    await page.reload();
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    await page.waitForTimeout(300);
    s = await railState();
    check(!s.collapsed && JSON.stringify(s.active) === '["tabVisibility"]' && JSON.stringify(s.content) === '["tabVisibility"]',
        'the chosen panel is restored after a reload, with the info panel shown');
} catch (e) {
    console.log('  ✗ threw:', e && e.stack || e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
