/**
 * panel-tabs-scroller.mjs — the info panel's tab bar is ONE horizontal
 * scroller holding every tab, not a short bar plus a "More ▾" dropdown.
 *
 * The dropdown demoted whichever tabs did not fit the panel's current width.
 * At the default width that was five of the seven, so the panel's own name
 * for the thing you were looking at was usually behind a control you had to
 * open first — and which tabs were behind it moved as the panel was resized,
 * so the bar never looked the same twice.
 *
 * What this pins:
 *   §1  Every tab is IN the bar, in markup order, and there is no "More".
 *   §2  The bar really does overflow at the default width (the precondition —
 *       asserted so the rest cannot silently stop testing a scroller).
 *   §3  A trackpad's VERTICAL two-finger swipe scrolls it sideways. That is
 *       the gesture you get over a 31px strip, and nothing else was using it:
 *       the bar sits outside `.panel-tab-content`, the panel's one vertical
 *       scroller.
 *   §4  Click and drag scrolls it — and the drag does NOT also switch tabs,
 *       while a plain click still does. This is the whole risk in making a row
 *       of buttons draggable.
 *   §5  A tab selected from code (`openIdSwitchPanel`) is scrolled into view.
 *       An active tab nobody can see reads as no tab being active.
 *   §6  The edge fades track which side has tabs behind it, and both go away
 *       once the panel is wide enough to hold everything.
 *
 * Run: node panel-tabs-scroller.mjs   (spawns its own http.server)
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

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    await page.waitForTimeout(300);

    const barState = () => page.evaluate(() => {
        const bar = document.querySelector('.panel-tabs');
        return {
            scrollLeft: bar.scrollLeft,
            scrollWidth: bar.scrollWidth,
            clientWidth: bar.clientWidth,
            left: bar.classList.contains('scroll-left'),
            right: bar.classList.contains('scroll-right'),
        };
    });
    const activeTab = () => page.evaluate(() => {
        const a = document.querySelector('.panel-tab.active');
        return a ? a.getAttribute('data-tab') : null;
    });

    // ---- §1 every tab is in the bar, and "More" is gone ----
    const inventory = await page.evaluate(() => {
        const bar = document.querySelector('.panel-tabs');
        const tabs = Array.from(bar.querySelectorAll('.panel-tab'));
        return {
            names: tabs.map(t => t.getAttribute('data-tab')),
            // Demotion worked by setting `display: none` on the losers.
            hidden: tabs.filter(t => getComputedStyle(t).display === 'none')
                .map(t => t.getAttribute('data-tab')),
            more: document.querySelectorAll(
                '.panel-tab-more, .panel-tab-more-btn, .panel-tab-more-menu, .panel-tab-more-item'
            ).length,
            overflowX: getComputedStyle(bar).overflowX,
        };
    });
    const expected = ['tabInstances', 'tabVisibility', 'tabIdSwitches', 'tabVideos',
        'tabCameras', 'tabSkeleton', 'tabSession'];
    check(JSON.stringify(inventory.names) === JSON.stringify(expected),
        `all 7 tabs are in the bar, in markup order (${inventory.names.join(', ')})`);
    check(inventory.hidden.length === 0,
        `no tab is hidden from the bar (was: 5 of 7 demoted into "More")`);
    check(inventory.more === 0, 'no "More ▾" control survives anywhere in the DOM');
    check(inventory.overflowX === 'auto' || inventory.overflowX === 'scroll',
        `the bar itself scrolls horizontally (overflow-x: ${inventory.overflowX})`);

    // ---- §2 precondition: it actually overflows at the default width ----
    const s0 = await barState();
    check(s0.scrollWidth > s0.clientWidth + 4,
        `the bar overflows at the default panel width (${s0.scrollWidth}px of tabs in ${s0.clientWidth}px) — so §3–§6 are testing a real scroller`);
    check(s0.scrollLeft === 0 && !s0.left && s0.right,
        'at rest it is scrolled to the start: right edge faded, left edge not');

    const box = await page.locator('.panel-tabs').boundingBox();
    const midY = box.y + box.height / 2;

    // ---- §3 trackpad ----
    await page.mouse.move(box.x + box.width / 2, midY);
    await page.mouse.wheel(0, 120);          // a VERTICAL two-finger swipe
    await page.waitForTimeout(120);
    const sWheelY = await barState();
    check(sWheelY.scrollLeft > s0.scrollLeft,
        `a vertical wheel over the bar scrolls it sideways (${s0.scrollLeft} → ${sWheelY.scrollLeft})`);
    check(sWheelY.left && sWheelY.right, 'mid-scroll, BOTH edges are faded');

    await page.mouse.wheel(60, 0);           // a sideways swipe
    await page.waitForTimeout(120);
    const sWheelX = await barState();
    check(sWheelX.scrollLeft > sWheelY.scrollLeft,
        `a horizontal wheel scrolls it the same way (${sWheelY.scrollLeft} → ${sWheelX.scrollLeft})`);

    await page.mouse.wheel(0, -2000);        // back past the start
    await page.waitForTimeout(150);
    const sTop = await barState();
    check(sTop.scrollLeft === 0 && !sTop.left,
        'scrolling back past the start clamps at 0 and drops the left fade');

    // ---- §4 click and drag ----
    // Start the press on a tab that is NOT active, so "the drag switched tabs"
    // is distinguishable from "nothing happened".
    const before = await activeTab();
    check(before === 'tabInstances', 'Instances is the tab in view to begin with');
    const visTab = await page.locator('.panel-tab[data-tab="tabVisibility"]').boundingBox();
    await page.mouse.move(visTab.x + visTab.width / 2, midY);
    await page.mouse.down();
    // Past the 4px threshold, in several steps so pointermove actually fires.
    for (const dx of [-10, -40, -90, -140]) {
        await page.mouse.move(visTab.x + visTab.width / 2 + dx, midY);
    }
    await page.mouse.up();
    await page.waitForTimeout(120);
    const sDrag = await barState();
    check(sDrag.scrollLeft > 100,
        `dragging left scrolls the bar right (scrollLeft ${sDrag.scrollLeft})`);
    check(await activeTab() === before,
        'the drag did NOT switch tabs, though it began on the Visibility tab');

    // A press that goes nowhere is still a click.
    const camTab = await page.locator('.panel-tab[data-tab="tabCameras"]').boundingBox();
    await page.mouse.move(camTab.x + camTab.width / 2, midY);
    await page.mouse.down();
    await page.mouse.move(camTab.x + camTab.width / 2 + 2, midY);   // under the threshold
    await page.mouse.up();
    await page.waitForTimeout(120);
    check(await activeTab() === 'tabCameras',
        'a plain click (2px of travel, under the drag threshold) still switches tabs');
    check(await page.evaluate(() =>
        document.getElementById('tabCameras').classList.contains('active')),
    'and the Cameras tab CONTENT is the one shown');

    // ---- §5 a tab selected from code is scrolled into view ----
    await page.evaluate(() => { document.querySelector('.panel-tabs').scrollLeft = 0; });
    await page.waitForTimeout(80);
    const offscreen = await page.evaluate(() => {
        const bar = document.querySelector('.panel-tabs').getBoundingClientRect();
        const t = document.querySelector('.panel-tab[data-tab="tabSession"]').getBoundingClientRect();
        return t.right > bar.right + 1;
    });
    check(offscreen, 'with the bar at the start, the Session tab is off the right edge');
    // `.click()` on the button is exactly what `openIdSwitchPanel` does.
    await page.evaluate(() => {
        document.querySelector('.panel-tab[data-tab="tabSession"]').click();
    });
    await page.waitForTimeout(150);
    const nowVisible = await page.evaluate(() => {
        const bar = document.querySelector('.panel-tabs').getBoundingClientRect();
        const t = document.querySelector('.panel-tab[data-tab="tabSession"]').getBoundingClientRect();
        return t.left >= bar.left - 1 && t.right <= bar.right + 1;
    });
    check(await activeTab() === 'tabSession' && nowVisible,
        'selecting it from code scrolls it fully into view rather than leaving the active tab off-screen');
    const sEnd = await barState();
    check(sEnd.left && !sEnd.right,
        'at the far end only the LEFT edge is faded');

    // ---- §6 a panel wide enough for every tab has no fades at all ----
    await page.evaluate(() => {
        const p = document.getElementById('infoPanel');
        p.dataset.lucidTestWidth = p.style.width || '';
        p.style.width = '900px';
    });
    await page.waitForTimeout(250);
    const sWide = await barState();
    check(sWide.scrollWidth <= sWide.clientWidth + 2,
        `widened to 900px every tab fits (${sWide.scrollWidth}px in ${sWide.clientWidth}px)`);
    check(!sWide.left && !sWide.right,
        'and neither edge is faded, so a bar that fits looks like a plain tab bar');
    const maskWide = await page.evaluate(() => {
        const cs = getComputedStyle(document.querySelector('.panel-tabs'));
        return cs.maskImage || cs.webkitMaskImage;
    });
    check(!maskWide || maskWide === 'none',
        `no mask is applied when nothing overflows (mask-image: ${maskWide})`);

} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
