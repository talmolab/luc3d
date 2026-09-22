import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = 8099;

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));

let exitCode = 1;
try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let summary = null;
  const fails = [];
  page.on('console', msg => {
    const t = msg.text();
    if (t.startsWith('Test results:')) summary = t;
    if (t.startsWith('  FAIL:')) fails.push(t);
  });
  await page.goto(`http://localhost:${PORT}/tests/test-runner.html`);
  // Wait for the run to finish (summary logged).
  await page.waitForFunction(() => {
    const el = document.querySelector('.test-summary');
    return el && /\d+\s*\/\s*\d+/.test(el.textContent);
  }, { timeout: 60000 });
  await page.waitForTimeout(300);
  console.log(summary || '(no summary console line)');
  if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log(f)); }
  const text = await page.textContent('.test-summary');
  console.log('Summary element:', text.replace(/\s+/g, ' ').trim());
  exitCode = fails.length ? 1 : 0;
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
process.exit(exitCode);
