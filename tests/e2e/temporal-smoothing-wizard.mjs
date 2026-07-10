/**
 * temporal-smoothing-wizard.mjs — real-browser check that the Tracking Wizard
 * surfaces the "Temporal smoothing (scale_smooth)" control (issue #134) and
 * that setting + applying it persists via the settings store.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8090);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

  // Open the Tracking Wizard (Settings modal focused on 'wizard').
  await page.evaluate(async () => {
    const m = await import('/ui/settings-modal.js');
    m.showSettingsModal('wizard');
  });
  await page.waitForSelector('.settings-modal', { timeout: 5000 });

  const sel = 'input[aria-label="Temporal smoothing (scale_smooth)"]';
  const present = await page.$(sel);
  check(!!present, 'wizard shows the Temporal smoothing control');

  // Default should read 0 (disabled) — read the live property, not the attr.
  const def = await page.inputValue(sel);
  check(def === '0', 'defaults to 0 / disabled (got ' + def + ')');

  // Set to 2 (anipose's recommended value), fire input+change, then Apply.
  await page.fill(sel, '2');
  await page.dispatchEvent(sel, 'change');
  // Click the wizard Apply button (persists working.thresholds).
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.settings-modal button, .settings-modal .btn, .settings-modal [role=button]'));
    const apply = btns.find(b => /apply/i.test(b.textContent));
    if (apply) apply.click();
  });

  const persisted = await page.evaluate(async () => {
    const s = await import('/ui/settings.js');
    return s.getTrackingThreshold('temporalSmoothing');
  });
  check(persisted === 2, 'setting persists via getTrackingThreshold (got ' + persisted + ')');
  check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));

  await browser.close();
} finally {
  server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
