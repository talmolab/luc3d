/**
 * desktop-stage-boot.mjs — the desktop app's staged frontend boots with no
 * network, from a PLAIN static server.
 *
 * scripts/desktop/stage_frontend.py builds dist-desktop/, which the Tauri app
 * serves as-is over http://localhost:<port> (tauri-plugin-localhost): no
 * `server.py --offline` rewriting happens there, so the staged copy itself must
 * already name ./lib/ for every CDN dependency, carry every module it imports,
 * and load each one under exactly one URL after the ?v= stamp. This stages into
 * a temp dir, serves it with `python3 -m http.server`, ABORTS every non-local
 * request, and asserts:
 *   1. the app comes up (THREE r147, OrbitControls, MP4Box, h5wasm, the `yaml`
 *      importmap entry, dockview css from lib/, window.__lucid.state)
 *   2. no request left the machine, nothing 404'd, no page error
 *   3. no .js/.mjs/.css was requested twice (module identity after stamping)
 *   4. the menu bar's version label shows the stamped desktop label
 * Skips (exit 0) when the offline packages cannot be fetched.
 *
 *   node tests/e2e/desktop-stage-boot.mjs        (PORT=9431 by default)
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(process.env.PORT || 9431);
const PY = process.platform === 'win32' ? 'py' : 'python3';
const LABEL = 'desktop 9.9.9', COMMIT = 'e2edesk00001';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-desktop-boot-'));
const OUT = path.join(tmp, 'stage');
const st = spawnSync(PY, ['scripts/desktop/stage_frontend.py', '--out', OUT, '--label', LABEL, '--commit', COMMIT],
    { cwd: repoRoot, encoding: 'utf8' });
if (st.status === 3) {
    console.log('SKIP: the offline packages could not be fetched (no network?).');
    process.exit(0);
}
if (st.status !== 0) {
    console.error(st.stdout + st.stderr);
    console.error(`FAIL: stage_frontend.py exited ${st.status}`);
    process.exit(1);
}

const server = spawn(PY, ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', OUT],
    { stdio: 'ignore' });
const ORIGIN = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 100 && !up; i++) {
    try { const r = await fetch(ORIGIN + '/index.html'); await r.arrayBuffer(); up = r.ok; }
    catch { await new Promise(r => setTimeout(r, 100)); }
}

const failures = [];
const fail = (m) => { console.error('FAIL: ' + m); failures.push(m); };
let browser;
try {
    if (!up) throw new Error(`static server never came up on port ${PORT}`);
    browser = await chromium.launch();
    const context = await browser.newContext();
    const blocked = [], bad = [], errors = [], counts = new Map();
    await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(ORIGIN + '/') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
        blocked.push(url);
        return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('response', r => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
    page.on('request', r => {
        const u = r.url();
        if (u.startsWith(ORIGIN) && /\.(m?js|css)(\?|$)/.test(u)) {
            const file = u.split('?')[0];
            counts.set(file, (counts.get(file) || new Set()).add(u));
        }
    });

    await page.goto(ORIGIN + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.THREE && window.__lucid && window.__lucid.state, null, { timeout: 30000 })
        .catch(() => fail('the app never came up (window.THREE / window.__lucid.state)'));
    await page.waitForTimeout(1000);   // let late startup imports land

    const probe = await page.evaluate(async () => ({
        revision: window.THREE && window.THREE.REVISION,
        orbit: typeof (window.THREE && window.THREE.OrbitControls),
        mp4box: typeof window.MP4Box,
        h5wasm: typeof window.h5wasm,
        yaml: await import('yaml').then(m => typeof m.parse, e => 'ERROR ' + e.message),
        dockviewCss: [...document.styleSheets].some(s => (s.href || '').includes('/lib/dockview-core/dockview.css')),
        label: (document.getElementById('menuBarVersion') || {}).textContent || '',
    }));
    if (probe.revision !== '147') fail('THREE.REVISION is ' + probe.revision);
    if (probe.orbit !== 'function') fail('THREE.OrbitControls is ' + probe.orbit);
    if (probe.mp4box !== 'object' && probe.mp4box !== 'function') fail('MP4Box is ' + probe.mp4box);
    if (probe.h5wasm === 'undefined') fail('h5wasm global missing');
    if (probe.yaml !== 'function') fail('the "yaml" importmap entry did not resolve: ' + probe.yaml);
    if (!probe.dockviewCss) fail('dockview stylesheet not loaded from lib/');
    if (!probe.label.startsWith(LABEL)) fail(`menu bar version label is "${probe.label}", expected "${LABEL} · …"`);

    if (blocked.length) fail(`${blocked.length} off-origin request(s): ${[...new Set(blocked)].slice(0, 5).join(', ')}`);
    if (bad.length) fail(`${bad.length} failed response(s): ${bad.slice(0, 5).join(', ')}`);
    const real = errors.filter(e => !/favicon/i.test(e));
    if (real.length) fail(`${real.length} page error(s): ${real.slice(0, 5).join(' | ')}`);
    const twice = [...counts].filter(([, urls]) => urls.size > 1);
    if (twice.length) fail(`loaded under two URLs: ${twice.slice(0, 5).map(([f, u]) => f + ' ' + [...u].join(' ')).join('; ')}`);
    const unstamped = [...counts.values()].flatMap(s => [...s]).filter(u => !u.includes('?v=' + COMMIT));
    if (unstamped.length) fail(`requested without ?v=${COMMIT}: ${unstamped.slice(0, 5).join(', ')}`);

    if (!failures.length) {
        console.log(`PASS: staged desktop frontend booted from a plain static server, all off-origin requests blocked.`);
        console.log(`      ${counts.size} distinct .js/.css, each under one stamped URL; label "${probe.label}"`);
    }
} catch (e) {
    fail(e.message);
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failures.length ? 1 : 0);
