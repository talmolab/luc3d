import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8099);
// HEADED=1 runs the suite in a real, GPU-backed browser window.
//
// This is NOT cosmetic. Headless Chromium rasterizes canvas in software and
// drives requestAnimationFrame at ~60 Hz; a real window uses the GPU and the
// display's true refresh rate. Two whole classes of bug are invisible here and
// only here: anything whose behaviour depends on frames-per-refresh (the
// playback schedule in `loading/video.js` disengages entirely at <= 60 Hz), and
// anything asserting exact canvas pixels across two rasterizer passes. A
// multi-camera playback desync that reproduced every time on a 120 Hz display
// passed headless 3/3, so run this before a release on a high-refresh machine.
const HEADED = process.env.HEADED === '1';
// DPR=2 emulates a Retina display. Canvas assertions that hold at dpr 1 can
// fail at dpr 2: the backing store doubles and content lands on different
// device-pixel boundaries, so the GPU's antialiasing noise is a different
// shape. Worth a second HEADED pass before a release.
const DPR = Number(process.env.DPR || 1);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));

let exitCode = 1;
try {
  const browser = await chromium.launch({ headless: !HEADED });
  const page = await browser.newPage({ deviceScaleFactor: DPR });
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
  console.log((HEADED ? '[headed] ' : '[headless] ') + `[dpr${DPR}] ` + (summary || '(no summary console line)'));
  if (fails.length) { console.log('\nFailures:'); fails.forEach(f => console.log(f)); }
  const text = await page.textContent('.test-summary');
  console.log('Summary element:', text.replace(/\s+/g, ' ').trim());
  // Trust the DOM, not just the console: scrape the failed cases too, so a
  // dropped console line can never turn a red run green.
  const domFails = await page.evaluate(() => Array.from(document.querySelectorAll('.test-case'))
    .filter(e => e.className.includes('failed'))
    .map(e => e.textContent.replace(/\s+/g, ' ').trim().slice(0, 300)));
  if (domFails.length) { console.log('\nFailed cases:'); domFails.forEach(f => console.log('  ' + f)); }
  exitCode = (fails.length || domFails.length) ? 1 : 0;
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
process.exit(exitCode);
