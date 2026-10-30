/**
 * toolbar-reproj-threshold.mjs — the Triangulate menu's Reprojection error field
 * (`#tbReprojThreshold`, ui/reproj-threshold-field.js), which edits the Tracking
 * Wizard's `reprojErrorThreshold` from the toolbar, like Track's Animals field.
 *
 * Asserted, through the real app:
 *  1. Hovering Triangulate shows it below Method, above Settings…, showing the
 *     50 px default, and a solve at the default drops the stray camera. Typing
 *     the default is a choice: it is stored, so a later default change cannot
 *     move it.
 *  2. Typing 25 and pressing Enter stores it, hands focus back, and survives a
 *     reload. A real solve then uses it: the same group solved with no options
 *     drops a stray camera at 25 and keeps it when the field is blank.
 *  3. Settings shows the field's value (wizard field and figure card), and
 *     Settings ▸ Apply updates the field.
 *  4. Blank and 0 both mean off. A bad entry (-3, 641, a stray "e") reverts with
 *     an error status and changes nothing. Esc throws away what was typed.
 *  5. App shortcuts do not fire while typing in it.
 *
 * Run: node tests/e2e/toolbar-reproj-threshold.mjs   (PORT=… to move the server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8320);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const WIZARD = '.settings-panel[data-panel="wizard"] input[aria-label="Reprojection error threshold (px)"]';
let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    const load = async () => {
        await page.goto(`http://localhost:${PORT}/index.html`);
        await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    };
    await load();

    const stored = () => page.evaluate(async () => (await import('/ui/settings.js')).getTrackingThreshold('reprojErrorThreshold'));
    const value = () => page.inputValue('#tbReprojThreshold');
    const hoverMenu = async () => { await page.hover('#tbTriangulateAll'); await page.waitForTimeout(150); };
    const enter = async (text, key = 'Enter') => {
        await hoverMenu();
        await page.click('#tbReprojThreshold');
        await page.fill('#tbReprojThreshold', '');
        await page.keyboard.type(text);
        await page.keyboard.press(key);
    };
    // One node, three cameras, the third's 2D point 120 px off. Solved with no
    // options, so the threshold comes from the setting, as in a real run.
    const solve = () => page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const tri = await import('/pose/triangulation.js');
        const cams = [[0.4, 0, 0], [-0.4, 0.2, 0], [0, -0.5, 0.1]].map((r, i) => new pd.Camera('c' + i,
            [[1000, 0, 640], [0, 1000, 512], [0, 0, 1]], [0, 0, 0, 0, 0], r, [10 * i, -20, 1800], [1280, 1024]));
        const X = [20, -30, 40];
        const g = new pd.InstanceGroup(1, 0);
        cams.forEach((c, i) => {
            const q = c.project(X);
            g.addInstance(c.name, new pd.Instance([[q[0] + (i === 0 ? 1 : 0), q[1] + (i === 2 ? 120 : 0)]], 0, 'predicted', 1));
        });
        const pt = (r) => Array.from(pd.getPoint3d(r.points3d, 0));
        return {
            setting: pt(tri.triangulateAndReproject(g, cams)),
            all: pt(tri.triangulateAndReproject(g, cams, { reprojErrorThreshold: 0 })),
            two: pt(tri.triangulateAndReproject(g, cams, { reprojErrorThreshold: 0, includedCameras: ['c0', 'c1'] })),
        };
    });
    const same = (a, b) => a.every((v, i) => Object.is(v, b[i]));

    console.log('1. in the Triangulate menu, on at its default');
    await hoverMenu();
    check(await page.locator('#tbReprojThreshold').isVisible(), 'shown when hovering Triangulate');
    const order = await page.evaluate(() => {
        const kids = [...document.querySelectorAll('#triangulateDropdown .tri-dropdown-menu > *')];
        const at = (f) => kids.findIndex(f);
        return [at(k => k.getAttribute('role') === 'radiogroup'), at(k => !!k.querySelector && !!k.querySelector('#tbReprojThreshold')), at(k => k.dataset && k.dataset.scope === 'settings')];
    });
    check(order[0] < order[1] && order[1] < order[2], `below Method, above Settings… (${order})`);
    check(await value() === '50' && await page.getAttribute('#tbReprojThreshold', 'placeholder') === 'off', 'shows the default, with an "off" placeholder for blank');
    check(await stored() === 50, 'setting is 50');
    let r = await solve();
    check(same(r.setting, r.two) && !same(r.setting, r.all), 'a solve at the default drops the stray camera');
    const inStorage = () => page.evaluate(() =>
        (JSON.parse(localStorage.getItem('lucid.settings.v1') || '{}').trackingThresholds || {}).reprojErrorThreshold);
    check(await inStorage() === undefined, 'untouched, the default is not stored');
    await enter('50');
    check(await inStorage() === 50, 'typing the default stores it');

    console.log('2. typing a value');
    await enter('25');
    check(await stored() === 25 && await value() === '25', `Enter stores it (${await stored()})`);
    check(await page.evaluate(() => document.activeElement.id !== 'tbReprojThreshold'), 'Enter hands focus back');
    r = await solve();
    check(same(r.setting, r.two) && !same(r.setting, r.all), 'a real solve now drops the stray camera');
    await load();
    check(await value() === '25' && await stored() === 25, 'survives a reload');

    console.log('3. stays in step with Settings');
    const settings = await page.evaluate((w) => {
        document.getElementById('menuSettings').click();
        document.querySelector('.settings-nav-item[data-panel="triangulation"]').click();
        const out = { field: document.querySelector(w).value, tag: document.querySelector('.tri-thr .fig-setting-now strong').textContent };
        const i = document.querySelector(w);
        i.value = '40'; i.dispatchEvent(new Event('input'));
        document.querySelector('.settings-btn-apply').click();
        document.querySelector('.settings-modal-close').click();
        return out;
    }, WIZARD);
    check(settings.field === '25' && /^25 px/.test(settings.tag), `Settings shows it (${settings.field}, ${settings.tag})`);
    check(await value() === '40', `Settings ▸ Apply updates the field (${await value()})`);

    console.log('4. off, bad entries, Esc');
    await enter('0');
    check(await stored() === 0 && await value() === '', 'typing 0 is off, and shows blank');
    await enter('30');
    await enter('');
    check(await stored() === 0 && await value() === '', 'blank is off');
    await enter('30');
    for (const bad of ['-3', '641', 'e']) {
        await enter(bad);
        const st = await page.evaluate(() => (document.getElementById('statusText') || document.querySelector('.status-bar') || document.body).textContent);
        check(await stored() === 30 && await value() === '30' && /must be 0 to 640 px/.test(st), `"${bad}" is refused and reverts`);
    }
    await enter('77', 'Escape');
    check(await stored() === 30 && await value() === '30', 'Esc throws away what was typed');

    console.log('5. shortcuts do not fire while typing');
    await hoverMenu();
    await page.click('#tbReprojThreshold');
    const before = await page.evaluate(() => document.querySelectorAll('.settings-modal').length);
    await page.keyboard.press('t');
    await page.keyboard.press('p');
    const focused = await page.evaluate(() => document.activeElement.id);
    check(focused === 'tbReprojThreshold' && before === 0, 'focus stays in the field');
    await page.keyboard.press('Escape');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
