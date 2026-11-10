/**
 * panel-rail.mjs — the info panel's panels are an accordion stack of
 * collapsible sections driven by an icon rail on the window's right edge
 * (ui/panel-rail.js), modelled on sleap-app's sidebar in its multi-panel
 * mode. It replaced the horizontal tab bar.
 *
 * What this pins:
 *   §1  Every panel has an icon, in the old tab bar's order, each a Lucide
 *       glyph (sleap-app's for the panels the two apps share) with the panel's
 *       name as its accessible name; hovering widens the rail over the panel
 *       to show the names. The rail sits on the window edge and is the one
 *       `user-select: none` surface here. Every pane sits in a section with a
 *       header (fold chevron + name, ✕).
 *   §2  sleap-app's accordion: a rail click opens + expands its panel and
 *       folds the other open ones; a click on the expanded panel folds it; a
 *       header chevron folds/unfolds only its own section (several can be
 *       expanded); ✕ closes a panel; every open panel's icon is active.
 *       The info panel is the one scroller: sections never scroll on their
 *       own and their headers stick. Closing the last panel hides the info
 *       panel; showing it again reopens the default panel; a rail click
 *       while hidden shows it with that panel expanded and the rest folded.
 *   §3  Every other way of hiding/showing the info panel still works, keeps
 *       the stack, and the rail follows: the `I` shortcut, the toolbar's
 *       Panel button, View ▸ Toggle Info Panel, the rail's own top button.
 *   §4  Keyboard: Tab reaches an icon, focus widens the rail, Enter clicks it;
 *       the section header buttons are keyboard buttons too.
 *   §5  Code that opens a panel (`openIdSwitchPanel`, the ID-switch check's
 *       flow) opens + expands it — from hidden too — and never hides or folds.
 *   §6  Define Planes hides the stack, disables the panel icons, and leaving
 *       restores the same open / folded sections.
 *   §7  Open and folded sections are remembered across a reload
 *       (localStorage); the info panel still starts shown.
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
    ['tabConnect', 'Connect'],   // added after init by ui/connect/index.js, web and desktop
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
    await page.waitForSelector('#panelRail .panel-rail-btn[data-tab="tabConnect"]', { timeout: 30000 });
    await page.waitForTimeout(300);

    const railState = () => page.evaluate(() => {
        const wrap = document.getElementById('infoPanelWrapper');
        const btns = Array.from(document.querySelectorAll('#panelRail .panel-rail-btn[data-tab]'));
        const active = btns.filter(b => b.classList.contains('active')).map(b => b.dataset.tab);
        const pressed = btns.filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.tab);
        const shown = el => getComputedStyle(el).display !== 'none';
        const sections = Array.from(document.querySelectorAll('.panel-section'));
        const open = sections.filter(shown).map(x => x.dataset.tab);
        const content = Array.from(document.querySelectorAll('.panel-tab-content'))
            .filter(c => shown(c) && shown(c.closest('.panel-section'))).map(c => c.id);
        const top = document.querySelector('#panelRail .panel-rail-collapse');
        return {
            collapsed: wrap.classList.contains('collapsed'),
            wrapWidth: Math.round(wrap.getBoundingClientRect().width),
            active, pressed, open, content,
            ariaExpanded: sections.filter(shown).map(x => x.querySelector('.panel-section-toggle').getAttribute('aria-expanded')),
            topName: top.getAttribute('aria-label'),
            panelBtn: document.getElementById('infoPanelToggleBtn').getAttribute('aria-pressed'),
        };
    });
    const J = JSON.stringify;
    // Click the rail BUTTON (its whole row): on hover the icon slides left
    // under the pointer, which is then over that row's name.
    // The widened rail takes the pointer (as in sleap-app), so leave it before
    // clicking anything it may cover, as a user's pointer does.
    const moveAway = () => page.mouse.move(300, 300);
    const click = async (tab) => { await page.click(`#panelRail .panel-rail-btn[data-tab="${tab}"]`); await moveAway(); };
    const fold = async (tab) => { await moveAway(); await page.click(`.panel-section[data-tab="${tab}"] .panel-section-toggle`); };
    const close = async (tab) => { await moveAway(); await page.click(`.panel-section[data-tab="${tab}"] .panel-section-close`); };

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
            sections: Array.from(document.querySelectorAll('#infoPanel > .panel-section')).map(x => [
                x.dataset.tab,
                x.querySelector('.panel-section-title').textContent,
                !!x.querySelector(':scope > .panel-section-header .panel-section-toggle svg'),
                x.querySelector(':scope > .panel-section-header .panel-section-close').getAttribute('aria-label'),
                x.querySelector(':scope > .panel-tab-content').id,
            ]),
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
    check(J(inv.sections) === J(EXPECTED.map(([t, n]) => [t, n, true, 'Close ' + n, t])),
        'every pane sits in its own section, in rail order, under a header with a fold chevron, its name and a ✕');

    await page.hover('#panelRail .panel-rail-btn[data-tab="tabVideos"] .panel-rail-icon');
    await page.waitForTimeout(300);
    const hover = await page.evaluate(() => ({
        w: Math.round(document.querySelector('#panelRail .panel-rail-inner').getBoundingClientRect().width),
        op: getComputedStyle(document.querySelector('#panelRail .panel-rail-btn[data-tab="tabVideos"] .panel-rail-label')).opacity,
        slot: Math.round(document.getElementById('panelRail').getBoundingClientRect().width),
    }));
    check(hover.w === 132 && hover.op === '1' && hover.slot === 44,
        `hover widens the rail over the panel to show names, without reflow (inner ${hover.w}, label opacity ${hover.op}, slot ${hover.slot})`);
    const lay = await page.evaluate(() => [...document.querySelectorAll('#panelRail .panel-rail-btn')].map(b => {
        const i = b.querySelector('.panel-rail-icon').getBoundingClientRect();
        const l = b.querySelector('.panel-rail-label');
        return { iconLeft: i.right <= l.getBoundingClientRect().left + 0.5, fits: l.scrollWidth <= l.clientWidth };
    }));
    check(lay.every(x => x.iconLeft), 'each icon sits LEFT of its name');
    check(lay.every(x => x.fits), 'every name fits the widened rail without truncation (incl. "ID Switches")');
    // The widened rail takes the pointer: over a name it stays wide, and a
    // click there is a click on that panel's button.
    const nameBox = await page.locator('#panelRail .panel-rail-btn[data-tab="tabVideos"] .panel-rail-label').boundingBox();
    const stripX = Math.round(nameBox.x + 10), stripY = Math.round(nameBox.y + nameBox.height / 2);
    await page.mouse.move(stripX, stripY);
    await page.waitForTimeout(300);
    const strip = await page.evaluate(([x, y]) => ({
        btn: (document.elementFromPoint(x, y).closest('.panel-rail-btn') || {}).dataset?.tab,
        w: Math.round(document.querySelector('#panelRail .panel-rail-inner').getBoundingClientRect().width),
    }), [stripX, stripY]);
    check(strip.btn === 'tabVideos' && strip.w === 132,
        `over a name the rail stays wide and the pointer is on that panel's button (${strip.btn}, ${strip.w})`);
    await moveAway();
    await page.waitForTimeout(300);
    const unhover = await page.evaluate(() =>
        Math.round(document.querySelector('#panelRail .panel-rail-inner').getBoundingClientRect().width));
    check(unhover === 44, `leaving the rail narrows it again (${unhover})`);

    // As in sleap-app, a click does NOT narrow the rail: it stays wide while
    // the pointer is on it (focus on the clicked button), and leaving with
    // the mouse narrows it even though that button keeps focus.
    const vidBtn = '#panelRail .panel-rail-btn[data-tab="tabVideos"]';
    const railW = () => page.evaluate(() =>
        Math.round(document.querySelector('#panelRail .panel-rail-inner').getBoundingClientRect().width));
    await page.hover(vidBtn);
    await page.waitForTimeout(300);
    await page.click(vidBtn);
    await page.waitForTimeout(300);
    const afterClick = await railW();
    const focusIn = await page.evaluate(() => !!document.activeElement.closest('#panelRail'));
    check(afterClick === 132, `a click keeps the rail wide while the pointer is on it (${afterClick})`);
    await moveAway();
    await page.waitForTimeout(300);
    const leftW = await railW();
    check(leftW === 44, `leaving with the mouse narrows it${focusIn ? ' though the clicked button keeps focus' : ''} (${leftW})`);
    await close('tabVideos');                       // undo: back to Instances alone, expanded
    await fold('tabInstances');
    await moveAway();

    // ---- §2 the accordion ----
    let s = await railState();
    check(!s.collapsed && J(s.open) === '["tabInstances"]' && J(s.content) === '["tabInstances"]' && J(s.active) === '["tabInstances"]',
        'starts with Instances open and expanded, the panel shown');
    const opened = ['tabInstances'];
    for (const [tab] of EXPECTED.slice(1)) {
        await click(tab);
        opened.push(tab);
        s = await railState();
        check(!s.collapsed && J(s.open) === J(opened) && J(s.content) === J([tab]) &&
            J(s.active) === J(opened) && J(s.pressed) === J(opened),
            `clicking ${tab} opens + expands it and folds the others; every open icon is active`);
    }
    check(J(s.ariaExpanded) === J(opened.map(t => t === 'tabConnect' ? 'true' : 'false')),
        'the header chevrons say which section is expanded (aria-expanded)');
    await click('tabConnect');
    s = await railState();
    check(!s.collapsed && s.content.length === 0 && J(s.open) === J(opened) && J(s.active) === J(opened),
        'clicking the expanded panel folds it to its header; the panel stays shown and every section stays open');
    await fold('tabSkeleton');
    await fold('tabVideos');
    s = await railState();
    check(J(s.content) === '["tabVideos","tabSkeleton"]',
        'a header chevron unfolds only its own section, so several can be expanded at once');
    await fold('tabSkeleton');
    s = await railState();
    check(J(s.content) === '["tabVideos"]', 'and folds it again without touching its neighbour');

    const scroll = await page.evaluate(() => {
        const ov = el => getComputedStyle(el).overflowY;
        const panes = Array.from(document.querySelectorAll('.panel-section, .panel-tab-content'));
        return {
            inner: panes.filter(el => /auto|scroll/.test(ov(el))).map(el => el.id || el.dataset.tab),
            outer: ov(document.getElementById('infoPanel')),
            sticky: Array.from(document.querySelectorAll('.panel-section-header')).every(h => getComputedStyle(h).position === 'sticky'),
        };
    });
    check(scroll.inner.length === 0 && /auto|scroll/.test(scroll.outer) && scroll.sticky,
        `the info panel is the one scroller; sections never scroll on their own and their headers stick (inner: ${J(scroll.inner)})`);

    await close('tabVideos');
    s = await railState();
    check(J(s.open) === J(opened.filter(t => t !== 'tabVideos')) && !s.active.includes('tabVideos') && s.content.length === 0,
        '✕ closes a panel: its section leaves the stack and its icon goes inactive');
    for (const t of opened.filter(t => t !== 'tabVideos')) await close(t);
    await page.waitForTimeout(400);            // the panel's 250ms width transition
    s = await railState();
    check(s.collapsed && s.open.length === 0 && s.active.length === 0 && s.wrapWidth === 0 && s.panelBtn === 'false' && s.topName === 'Show panel',
        `closing the last panel hides the info panel; the Panel button and the rail top button follow (wrapper ${s.wrapWidth}px)`);
    await moveAway();
    await page.keyboard.press('i');
    s = await railState();
    check(!s.collapsed && J(s.open) === '["tabInstances"]' && J(s.content) === '["tabInstances"]',
        'showing the info panel with nothing open reopens Instances, never an empty panel');
    await click('tabSkeleton');
    await page.keyboard.press('i');
    s = await railState();
    check(s.collapsed && s.active.length === 0, 'precondition: hidden with Instances + Skeleton open');
    await click('tabCameras');
    s = await railState();
    check(!s.collapsed && J(s.open) === '["tabInstances","tabCameras","tabSkeleton"]' && J(s.content) === '["tabCameras"]',
        'a rail click while hidden shows the panel with that section expanded and the rest folded');

    // ---- §3 every other hide/show still routes, keeping the stack ----
    await fold('tabSkeleton');                 // Cameras + Skeleton expanded, Instances folded
    const stack = await railState();
    const same = x => !x.collapsed && J(x.open) === J(stack.open) && J(x.content) === J(stack.content) && J(x.active) === J(stack.open);
    await moveAway();
    await page.keyboard.press('i');
    s = await railState();
    check(s.collapsed && s.active.length === 0, '`I` hides the panel and the rail clears its active icons');
    await page.keyboard.press('i');
    check(same(await railState()), '`I` shows it again with the same sections open and folded');

    await page.click('#infoPanelToggleBtn');
    s = await railState();
    check(s.collapsed && s.active.length === 0, 'toolbar Panel button hides it');
    await page.click('#infoPanelToggleBtn');
    check(same(await railState()), 'toolbar Panel button shows it again, stack unchanged');

    await page.evaluate(() => document.getElementById('menuToggleInfo').click());
    s = await railState();
    check(s.collapsed, 'View ▸ Toggle Info Panel hides it');
    await page.evaluate(() => document.getElementById('menuToggleInfo').click());
    check(same(await railState()), 'View ▸ Toggle Info Panel shows it again, stack unchanged');

    await page.click('#panelRail .panel-rail-collapse .panel-rail-icon');
    s = await railState();
    check(s.collapsed && s.topName === 'Show panel', "the rail's top button hides it");
    await page.click('#panelRail .panel-rail-collapse .panel-rail-icon');
    s = await railState();
    check(same(s) && s.topName === 'Hide panel', "the rail's top button shows it again, stack unchanged");

    // A mouse click must not leave a rail button focused: Chrome turns that
    // focus into :focus-visible on the next key press, and `I` then held the
    // rail widened after the pointer left.
    const innerW = () => page.evaluate(() =>
        Math.round(document.querySelector('#panelRail .panel-rail-inner').getBoundingClientRect().width));
    for (const [what, sel] of [['top button', '#panelRail .panel-rail-collapse .panel-rail-icon'],
                               ['panel icon', '#panelRail .panel-rail-btn[data-tab="tabCameras"] .panel-rail-icon']]) {
        await page.click(sel);
        await page.keyboard.press('i');
        await moveAway();
        await page.waitForTimeout(250);              // past the width transition
        check(await innerW() === 44, `click the rail's ${what}, press I, move away: the rail narrows (${await innerW()})`);
        if ((await railState()).collapsed) await page.keyboard.press('i');
    }
    s = await railState();
    check(!s.collapsed, 'precondition for §4: the panel is shown');

    // ---- §4 keyboard ----
    await moveAway();
    await page.evaluate(() => document.querySelector('#panelRail .panel-rail-btn[data-tab="tabSession"]').focus());
    await page.keyboard.press('Shift+Tab');      // a real keyboard move, so :focus-visible applies
    await page.waitForTimeout(250);              // past the width transition
    const kb = await page.evaluate(() => ({
        focused: document.activeElement && document.activeElement.dataset.tab,
        w: Math.round(document.querySelector('#panelRail .panel-rail-inner').getBoundingClientRect().width),
    }));
    check(kb.focused === 'tabSkeleton' && kb.w === 132, `Tab moves between icons and keyboard focus widens the rail (${kb.focused}, ${kb.w})`);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');          // Videos: not open → opens + expands
    s = await railState();
    check(!s.collapsed && J(s.content) === '["tabVideos"]' && s.open.includes('tabVideos'), 'Enter on a focused icon opens its panel');
    await page.evaluate(() => document.querySelector('.panel-section[data-tab="tabVideos"] .panel-section-toggle').focus());
    await page.keyboard.press('Enter');
    s = await railState();
    check(s.content.length === 0, 'Enter on a focused header chevron folds its section');
    await page.evaluate(() => document.activeElement && document.activeElement.blur());

    // ---- §5 programmatic opens never hide or fold ----
    await fold('tabCameras');                    // Cameras expanded again
    await page.keyboard.press('i');
    s = await railState();
    check(s.collapsed, 'precondition: panel hidden');
    await page.evaluate(async () => (await import('./ui/id-switch-modal.js')).openIdSwitchPanel());
    s = await railState();
    check(!s.collapsed && s.open.includes('tabIdSwitches') && J(s.content) === '["tabIdSwitches","tabCameras"]',
        'openIdSwitchPanel shows the hidden panel with ID Switches open + expanded, folding nothing else');
    await page.evaluate(async () => (await import('./ui/id-switch-modal.js')).openIdSwitchPanel());
    s = await railState();
    check(!s.collapsed && J(s.content) === '["tabIdSwitches","tabCameras"]', 'calling it again does NOT hide or fold it');
    const unknown = await page.evaluate(async () => (await import('./ui/panel-rail.js')).showPanelTab('tabNope'));
    check(unknown === false, 'showPanelTab refuses an unknown id');

    // ---- §6 Define Planes hides the stack and locks the icons ----
    const before = await railState();
    await page.evaluate(async () => (await import('./ui/plane-definition.js')).togglePlaneMode());
    const locked = await page.evaluate(() => ({
        disabled: Array.from(document.querySelectorAll('#panelRail .panel-rail-btn[data-tab]')).every(b => b.disabled),
        topLive: !document.querySelector('#panelRail .panel-rail-collapse').disabled,
        planeShown: getComputedStyle(document.getElementById('planePanel')).display !== 'none',
        sectionsHidden: Array.from(document.querySelectorAll('.panel-section')).every(x => getComputedStyle(x).display === 'none'),
    }));
    check(locked.disabled && locked.topLive && locked.planeShown && locked.sectionsHidden,
        'in Define Planes the stack is hidden, the panel icons are disabled, the top hide/show stays live');
    await page.click('#panelRail .panel-rail-btn[data-tab="tabVideos"] .panel-rail-icon', { force: true });
    await page.evaluate(async () => (await import('./ui/plane-definition.js')).togglePlaneMode());
    s = await railState();
    const unlocked = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#panelRail .panel-rail-btn[data-tab]')).every(b => !b.disabled));
    check(unlocked && J(s.open) === J(before.open) && J(s.content) === J(before.content),
        'a click on a disabled icon changed nothing; leaving restores the icons and the same open/folded sections');

    // ---- §7 remembered across reload ----
    await close('tabInstances');
    const saved = await railState();
    await page.reload();
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    await page.waitForTimeout(300);
    s = await railState();
    check(!s.collapsed && J(s.open) === J(saved.open) && J(s.content) === J(saved.content),
        `the open and folded sections are restored after a reload, with the info panel shown (${J(s.open)})`);
} catch (e) {
    console.log('  ✗ threw:', e && e.stack || e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
