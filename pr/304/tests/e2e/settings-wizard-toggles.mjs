/**
 * settings-wizard-toggles.mjs — the Tracking Wizard draws its on/off settings
 * as switches, not 0/1 number boxes (ui/settings-modal.js `makeToggle`).
 *
 * Asserted, in the real Settings ▸ Tracking Wizard:
 *  1. Every catalog setting with `kind: 'toggle'` and every camera's inclusion is
 *     a `.toggle-switch` (role="switch") reflecting the stored value; no 0/1
 *     number box remains for them; numeric settings keep their number boxes.
 *  2. Flipping a camera off greys its row live.
 *  3. Apply stores the switches as 1 / 0 (what the tracker and checks read).
 *  4. Cancel discards a flip.
 *
 * Run: node tests/e2e/settings-wizard-toggles.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8280);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = ['camA', 'camB', 'camC'].map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [640, 480]));
        const s = new pd.Session(cams, new pd.Skeleton('m', ['Nose', 'TTI'], []), [], 'S');
        AS.state.sessions = [s]; AS.state.session = s; AS.state.activeSessionIdx = 0;
    });
    const open = () => page.evaluate(() => { document.getElementById('menuSettings').click(); document.querySelector('.settings-nav-item[data-panel="wizard"]').click(); });
    const sw = (label) => `.settings-toggle input[aria-label="${label}"]`;

    await open();
    const ui = await page.evaluate(async () => {
        const S = await import('/ui/settings.js');
        const defs = S.getTrackingThresholdDefs();
        const toggleDefs = defs.filter(d => d.kind === 'toggle'), numDefs = defs.filter(d => d.kind !== 'toggle');
        const box = (l) => document.querySelector(`.settings-toggle input[aria-label="${l}"]`);
        const numbers = Array.from(document.querySelectorAll('.settings-num-input')).map(i => i.getAttribute('aria-label'));
        return {
            toggles: toggleDefs.map(d => ({ id: d.id, ok: !!box(d.label) && box(d.label).checked === (d.value > 0) && box(d.label).getAttribute('role') === 'switch' })),
            toggleIds: toggleDefs.map(d => d.id),
            noNumberForToggles: toggleDefs.every(d => numbers.indexOf(d.label) < 0),
            numbersKept: numDefs.every(d => numbers.indexOf(d.label) >= 0),
            cams: ['camA', 'camB', 'camC'].map(n => !!box('Include view ' + n + ' in tracking') && box('Include view ' + n + ' in tracking').checked),
            camNumbers: numbers.filter(l => /Include view/.test(l || '')).length,
        };
    });
    check(['matchGate', 'autoSwitchCheck', 'autoImageSwitchCheck', 'imageCheckWebNN'].every(id => ui.toggleIds.includes(id)) && ui.toggles.every(t => t.ok),
        `on/off settings are switches showing their stored value (${ui.toggles.map(t => t.id + (t.ok ? '' : '✗')).join(', ')})`);
    check(ui.noNumberForToggles && ui.camNumbers === 0, 'no 0/1 number box remains for them or for the cameras');
    check(ui.numbersKept, 'numeric settings keep their number boxes');
    check(ui.cams.every(Boolean), 'each camera has an inclusion switch, on by default');

    // flip: WebNN on, body-size check off, camB excluded -> Apply
    await page.evaluate((s) => { for (const l of s) document.querySelector(`.settings-toggle input[aria-label="${l}"]`).click(); },
        ['Image check: try WebNN (experimental)', 'Check ID switches after tracking (body size)', 'Include view camB in tracking']);
    const grey = await page.evaluate((s) => document.querySelector(s).closest('.settings-node-weight-row').classList.contains('settings-view-excluded'), sw('Include view camB in tracking'));
    check(grey, 'switching a camera off greys its row');
    await page.click('.settings-btn-apply');
    const applied = await page.evaluate(async () => { const S = await import('/ui/settings.js');
        return { webnn: S.getTrackingThreshold('imageCheckWebNN'), size: S.getTrackingThreshold('autoSwitchCheck'), camB: S.getCameraWeight('camB'), camA: S.getCameraWeight('camA') }; });
    check(applied.webnn === 1 && applied.size === 0 && applied.camB === 0 && applied.camA === 1, `Apply stores the switches as 1 / 0 (${JSON.stringify(applied)})`);

    // Cancel discards
    await open();
    await page.evaluate((s) => document.querySelector(s).click(), sw('Image check: try WebNN (experimental)'));
    await page.click('.settings-btn-cancel');
    const kept = await page.evaluate(async () => (await import('/ui/settings.js')).getTrackingThreshold('imageCheckWebNN'));
    check(kept === 1, 'Cancel discards a flip');
    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (e) {
    console.error(e); fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `FAIL (${fails})` : 'PASS');
process.exit(fails ? 1 : 0);
