/**
 * stamped-build.mjs — a deployed (version-stamped) copy of LUCID loads every
 * module exactly once and still passes the browser suite.
 *
 * The deploy workflows run scripts/stamp-version.mjs on the staged site so every
 * same-site code URL carries `?v=<commit>` (Cloudflare caches .js/.css for 4 h;
 * see the script's header). The risk that rewrite carries is module identity: an
 * ES module IS its URL, so one file reached as both `x.js` and `x.js?v=…` would
 * run twice (two app states). This test builds that exact artifact from the
 * working tree and asserts, through a real browser:
 *  1. The stamper reports no unstamped relative reference.
 *  2. Loading the app requests every same-site .js/.mjs/.css with `?v=<token>`,
 *     and no file under two different URLs.
 *  3. The page's `window.__lucid.state` IS the stamped `ui/app-state.js`'s
 *     `state` (one instance), and the sleap-io bridge is up.
 *  4. tests/test-runner.html on the stamped copy: every test passes, again with
 *     no file loaded twice.
 *
 * Run: node tests/e2e/stamped-build.mjs
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8277);
const TOKEN = 'e2etest0001';
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

// ---- build the artifact: the tracked files of the working tree, stamped
const site = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-stamped-'));
const files = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot }).toString().split('\0').filter(Boolean);
for (const f of files) {
    const src = path.join(repoRoot, f);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    fs.mkdirSync(path.dirname(path.join(site, f)), { recursive: true });
    fs.copyFileSync(src, path.join(site, f));
}
const { stampSite } = await import(pathToFileURL(path.join(repoRoot, 'scripts', 'stamp-version.mjs')).href);
const res = stampSite(site, TOKEN);
check(res.refs > 100 && res.problems.length === 0,
    `stamped ${res.refs} references in ${res.files} files, none left unstamped${res.problems.length ? ': ' + res.problems.slice(0, 3).join(' | ') : ''}`);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: site, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

/**
 * Same-site code LOADS (script / stylesheet / worker requests — not `fetch()`es of
 * source text, which some browser tests do to read a module's code) — and the
 * paths requested under more than one URL.
 */
function audit(reqs) {
    const code = reqs.filter(r => r.type !== 'fetch' && r.type !== 'xhr').map(r => new URL(r.url)).filter(u => u.host === `localhost:${PORT}` && /\.(m?js|css)$/.test(u.pathname));
    const byPath = new Map();
    for (const u of code) { if (!byPath.has(u.pathname)) byPath.set(u.pathname, new Set()); byPath.get(u.pathname).add(u.search); }
    const unstamped = code.filter(u => u.searchParams.get('v') !== TOKEN && !/slp-import-worker\.js$/.test(u.pathname)).map(u => u.pathname + u.search);
    const twice = [...byPath].filter(([, s]) => s.size > 1).map(([p, s]) => p + ' ' + [...s].join(','));
    return { n: code.length, unstamped, twice };
}

let browser;
try {
    browser = await chromium.launch();
    // ---- 2 + 3: the app
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errs = [], urls = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    page.on('request', r => urls.push({ url: r.url(), type: r.resourceType() }));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 30000 });
    await page.waitForTimeout(1500);                      // let lazily imported modules land too
    const a = audit(urls);
    check(a.n > 40 && a.unstamped.length === 0, `app: ${a.n} code requests, all stamped ?v=${TOKEN}${a.unstamped.length ? ' — unstamped: ' + a.unstamped.slice(0, 5).join(', ') : ''}`);
    check(a.twice.length === 0, `app: no file loaded under two URLs${a.twice.length ? ' — ' + a.twice.slice(0, 5).join(' | ') : ''}`);
    const one = await page.evaluate(async (t) => (await import('./ui/app-state.js?v=' + t)).state === window.__lucid.state, TOKEN);
    check(one, 'app: window.__lucid.state is the stamped ui/app-state.js state (one instance)');
    check(errs.length === 0, 'app: no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));

    // ---- 4: the browser suite on the stamped copy
    const tp = await browser.newPage();
    const turls = [], tfails = [];
    tp.on('request', r => turls.push({ url: r.url(), type: r.resourceType() }));
    tp.on('console', m => { if (m.text().startsWith('  FAIL:')) tfails.push(m.text()); });
    await tp.goto(`http://localhost:${PORT}/tests/test-runner.html`);
    await tp.waitForFunction(() => { const el = document.querySelector('.test-summary'); return el && /\d+\s*\/\s*\d+/.test(el.textContent); }, { timeout: 120000 });
    const summary = (await tp.textContent('.test-summary')).replace(/\s+/g, ' ').trim();
    const m = summary.match(/(\d+)\s*\/\s*(\d+)/);
    check(m && m[1] === m[2] && +m[2] > 1000 && tfails.length === 0, `browser suite on the stamped copy: ${summary}${tfails.length ? ' — ' + tfails.slice(0, 3).join(' | ') : ''}`);
    const t = audit(turls);
    check(t.unstamped.length === 0, `test runner: ${t.n} code loads (incl. its workers), all stamped${t.unstamped.length ? ' — unstamped: ' + t.unstamped.slice(0, 5).join(', ') : ''}`);
    check(t.twice.length === 0, `test runner: no file loaded under two URLs${t.twice.length ? ' — ' + t.twice.slice(0, 5).join(' | ') : ''}`);
} catch (e) {
    console.error(e); fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(site, { recursive: true, force: true });
}
console.log(fails ? `FAIL (${fails})` : 'PASS');
process.exit(fails ? 1 : 0);
