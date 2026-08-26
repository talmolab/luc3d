// Dump per-suite assertion counts from the browser unit runner for ANY tree.
// Usage: ROOT=/path/to/tree PORT=8097 node tests/e2e/_diag-suite-counts.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const root = process.env.ROOT || '/Users/joshuapark/Documents/talmolab/repos/luc3d/.claude/worktrees/expport-overlays';
const PORT = Number(process.env.PORT || 8097);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: root, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 900));
try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/tests/test-runner.html`);
  await page.waitForFunction(() => {
    const el = document.querySelector('.test-summary');
    return el && /\d+\s*\/\s*\d+/.test(el.textContent);
  }, { timeout: 90000 });

  // The summary element appears while async suites are STILL registering tests,
  // so sampling here undercounts (and does so differently run to run). Wait for
  // the total to stop moving before reading anything.
  let prev = null, stable = 0;
  while (stable < 6) {
    await page.waitForTimeout(500);
    const t = (await page.textContent('.test-summary')).replace(/\s+/g, ' ').trim();
    if (t === prev) stable++; else { stable = 0; prev = t; }
  }

  // The runner renders one heading per suite containing "name (passed/total)".
  const rows = await page.evaluate(() => {
    const seen = [];
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length) return;              // leaf text only
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const m = t.match(/^(.*?)\s*\((\d+)\/(\d+)\)$/);
      if (m) seen.push(`${m[2]}/${m[3]}\t${m[1]}`);
    });
    return seen;
  });
  rows.forEach(r => console.log(r));
  console.log('TOTAL\t' + (await page.textContent('.test-summary')).replace(/\s+/g, ' ').trim());
  await browser.close();
} finally { server.kill('SIGTERM'); }
