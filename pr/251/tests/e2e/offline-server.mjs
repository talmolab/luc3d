/**
 * Offline mode: the app must boot with every off-localhost request blocked.
 *
 * This is the only test that proves offline actually works. The unit suite and
 * the other e2e tests all run with a live network, so a dependency quietly
 * reaching out to a CDN passes them and fails only on the disconnected machine
 * the feature exists for.
 *
 * Every non-localhost request is ABORTED rather than throttled: that catches a
 * request the browser would otherwise serve from its HTTP cache, which is how an
 * "offline" page can look fine on the dev machine and die on a fresh one.
 *
 * Skips (exit 0) when the packages are not installed, so it never fails
 * spuriously in a default suite run.
 *
 *   node tests/e2e/offline-server.mjs
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8097);
const PY = process.platform === 'win32' ? 'py' : 'python3';

// Precondition: are the packages installed? If not, skip rather than fail.
const check = spawnSync(PY, ['scripts/offline_deps.py', 'check'], { cwd: repoRoot });
if (check.status !== 0) {
  console.log('SKIP: offline packages not installed.');
  console.log(`      Run: ${PY} scripts/offline_deps.py install`);
  process.exit(0);
}

const server = spawn(PY, ['server.py', String(PORT), '--offline'],
  { cwd: repoRoot, stdio: 'ignore' });

// Poll until it answers rather than sleeping a guessed interval.
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  try {
    const r = await fetch(`http://localhost:${PORT}/index.html`);
    // Drain the body. An unconsumed one leaves undici's parser paused, and it
    // then trips `assert(!this.paused)` inside Node when the socket closes --
    // an internal crash that looks nothing like the probe that caused it.
    await r.arrayBuffer();
    up = r.ok;
  } catch { await new Promise(r => setTimeout(r, 100)); }
}
if (!up) {
  console.error(`FAIL: server.py --offline never came up on port ${PORT}`);
  server.kill('SIGTERM');
  process.exit(1);
}

const failures = [];
const fail = (msg) => { console.error('FAIL: ' + msg); failures.push(msg); };
let exitCode = 1;

try {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Hard-block anything that is not our local server.
  const blocked = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url) || url.startsWith('data:')
        || url.startsWith('blob:')) {
      return route.continue();
    }
    blocked.push(url);
    return route.abort();
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });

  // The globals each vendored package is responsible for. If a rewrite is wrong
  // or a package is missing, one of these is undefined.
  await page.waitForFunction(() => window.THREE !== undefined, { timeout: 20000 })
    .catch(() => fail('THREE global never appeared (three.js did not load)'));

  const probe = await page.evaluate(() => ({
    three: typeof window.THREE,
    orbit: typeof (window.THREE && window.THREE.OrbitControls),
    mp4box: typeof window.MP4Box,
    h5wasm: typeof window.h5wasm,
    revision: window.THREE && window.THREE.REVISION,
    // dockview styles arrive as a stylesheet, so assert its CSS landed
    dockviewCss: [...document.styleSheets].some(s =>
      (s.href || '').includes('dockview-core')),
  }));

  if (probe.three !== 'object') fail('THREE is ' + probe.three);
  if (probe.orbit !== 'function') fail('THREE.OrbitControls is ' + probe.orbit);
  if (probe.mp4box !== 'object' && probe.mp4box !== 'function') fail('MP4Box is ' + probe.mp4box);
  if (probe.h5wasm === 'undefined') fail('h5wasm global missing');
  if (probe.revision !== '147') fail('THREE.REVISION is ' + probe.revision + ', expected 147');
  if (!probe.dockviewCss) fail('dockview stylesheet not loaded from lib/');

  // The yaml importmap entry is the fatal one: sleap-io's session-I/O chunk has a
  // static `import YAML from "yaml"`, so if it did not resolve the module graph
  // never finished and the app is dead even if the page painted.
  const yamlOk = await page.evaluate(async () => {
    try { return typeof (await import('yaml')).parse === 'function'; }
    catch (e) { return 'ERROR: ' + e.message; }
  });
  if (yamlOk !== true) fail('bare "yaml" specifier did not resolve: ' + yamlOk);

  // No CDN request should ever have been attempted.
  const cdnAttempts = blocked.filter(u => /jsdelivr|unpkg|cdnjs/.test(u));
  if (cdnAttempts.length) {
    fail('app attempted ' + cdnAttempts.length + ' CDN request(s) in offline mode:');
    [...new Set(cdnAttempts)].forEach(u => console.error('        ' + u));
  }

  const realErrors = pageErrors.filter(e => !/favicon/i.test(e));
  if (realErrors.length) {
    fail(realErrors.length + ' page error(s):');
    realErrors.slice(0, 5).forEach(e => console.error('        ' + e));
  }

  if (!failures.length) {
    console.log('PASS: app booted offline with all non-localhost requests blocked.');
    console.log(`      blocked ${blocked.length} off-origin request(s), 0 to a CDN`);
    console.log(`      THREE r${probe.revision}, OrbitControls, MP4Box, h5wasm, yaml, dockview css`);
    exitCode = 0;
  }

  await browser.close();
} finally {
  server.kill('SIGTERM');
}

process.exit(exitCode);
