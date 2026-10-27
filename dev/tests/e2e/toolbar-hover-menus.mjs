/**
 * toolbar-hover-menus.mjs — the toolbar's Instance and Group menus, and the
 * Temporal Smoothing button.
 *
 * + Instance / - Instance and Group / Edit Group moved into menus that open on
 * HOVER (no click), to make room for Temporal Smoothing as its own button right
 * after Triangulate All. Driven with the real mouse:
 *   1. hovering "Instance" / "Group" shows the original four buttons; nothing
 *      shows before the hover;
 *   2. a real click on an item in the open menu reaches that item's button;
 *   3. the Group button is blue while Group or Edit Group is (assignment mode),
 *      so the mode shows with the menu closed;
 *   4. Temporal Smoothing is the next control after Triangulate All, and the
 *      Triangulate menus no longer carry a smoothing item.
 *
 * Run: node tests/e2e/toolbar-hover-menus.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8293);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
        const F = await buildBaRigFixture({ frames: 4 });
        const s = F.mkSession('hoverMenus', { eager: true });
        AS.state.sessions = [s];
        AS.state.activeSessionIdx = 0;
        AS.state.session = s;
        AS.state.totalFrames = F.NF;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
    });

    const visible = (ids) => Promise.all(ids.map(id => page.locator('#' + id).isVisible()));
    await page.mouse.move(700, 600);
    await page.waitForTimeout(500);   // past the menus' close delay

    // ---- 1. hover opens, no click ------------------------------------------------------
    check(JSON.stringify(await visible(['tbAddInstance', 'tbDeleteInstance', 'tbGroup', 'tbEditGroup'])) ===
        '[false,false,false,false]', '1. with no hover, the four buttons are tucked away');
    await page.hover('#tbInstanceMenu');
    await page.waitForTimeout(200);
    check(JSON.stringify(await visible(['tbAddInstance', 'tbDeleteInstance'])) === '[true,true]',
        '1. hovering Instance shows + Instance and - Instance');
    const instLabels = await page.evaluate(() => ['tbAddInstance', 'tbDeleteInstance']
        .map(id => document.getElementById(id).textContent.trim()));
    check(JSON.stringify(instLabels) === '["+ Instance","- Instance"]', `1. with their labels (${JSON.stringify(instLabels)})`);
    await page.hover('#tbGroupMenu');
    await page.waitForTimeout(200);
    check(JSON.stringify(await visible(['tbGroup', 'tbEditGroup'])) === '[true,true]',
        '1. hovering Group shows Group and Edit Group');

    // ---- 2. an item is clickable with the real mouse ------------------------------------
    // (+ Instance itself needs loaded video views; what matters here is that a
    // click in the open menu reaches the button its handler is on.)
    await page.evaluate(() => {
        window.__addClicks = 0;
        document.getElementById('tbAddInstance').addEventListener('click', () => { window.__addClicks++; });
    });
    await page.hover('#tbInstanceMenu');
    await page.waitForTimeout(200);
    await page.click('#tbAddInstance');
    check(await page.evaluate(() => window.__addClicks) === 1, '2. a mouse click on + Instance in the open menu reaches it');

    // ---- 3. the Group button mirrors its items ------------------------------------------
    await page.mouse.move(700, 600);
    await page.waitForTimeout(500);
    const groupState = (on) => page.evaluate(async (on) => {
        const AS = await import('/ui/app-state.js');
        const R = await import('/ui/rendering.js');
        AS.interactionManager.assignmentMode = on;
        R.drawAllOverlays(0);
        return [document.getElementById('tbGroup').classList.contains('active'),
            document.getElementById('tbGroupMenu').classList.contains('active')];
    }, on);
    check(JSON.stringify(await groupState(true)) === '[true,true]', '3. in assignment mode, Group and the Group button are blue');
    check(JSON.stringify(await groupState(false)) === '[false,false]', '3. and both turn off with it');

    // ---- 4. Temporal Smoothing sits after Triangulate All -------------------------------
    const order = await page.evaluate(() => {
        const all = document.getElementById('triangulateAllDropdown');
        return {
            next: all.nextElementSibling && all.nextElementSibling.id,
            nested: document.querySelectorAll('#triangulateDropdown [data-method="smooth"], #triangulateAllDropdown [data-method="smooth"]').length,
            label: document.getElementById('tbSmooth').textContent.trim(),
        };
    });
    check(order.next === 'smoothingDropdown', `4. Temporal Smoothing is the next control after Triangulate All (${order.next})`);
    check(order.nested === 0, '4. the Triangulate menus no longer hold a smoothing item');
    check(/^Temporal Smoothing/.test(order.label), `4. labelled "${order.label}"`);
    const tb = await page.evaluate(() => {
        const t = document.getElementById('toolbar');
        return { scroll: t.scrollWidth, client: t.clientWidth };
    });
    check(tb.scroll <= tb.client, `4. the toolbar still fits a 1440px window (scrollWidth ${tb.scroll} <= ${tb.client})`);

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
