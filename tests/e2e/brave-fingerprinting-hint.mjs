/**
 * brave-fingerprinting-hint.mjs — the note on Brave's fingerprinting protection
 * under the progress popups' CPU line (ui/browser-hints.js), in REAL Brave.
 *
 * With Shields at their default, Brave reports a random core count to each
 * site and adds noise to canvas reads; a per-site "Allow fingerprinting"
 * exception (Shields > Advanced controls) stops both. Each Brave run here uses
 * a fresh profile (headless), the exception pre-seeded in its Preferences where
 * a case needs it. Skips cleanly when Brave is not installed. Asserted:
 *  1. Chromium: no note, whatever the popup shows.
 *  2. Brave, default Shields: the loading card's CPU line has the note under
 *     it — naming the count Brave reports, three numbered steps — even when the
 *     random draw happens to be the true count (the canvas check, not the
 *     count, is what detects the protection), and the note
 *     goes with the CPU line (hideLoading); an operation with no CPU line (a
 *     plain progress popup) shows none.
 *  3. Brave, default Shields: the image ID-switch check's dialog has it too.
 *  4. Brave with the site allowed: no note, and the true core count.
 *
 * Run: node tests/e2e/brave-fingerprinting-hint.mjs   (BRAVE=/path/to/Brave overrides the macOS default)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8286);
const BRAVE = process.env.BRAVE || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
if (!fs.existsSync(BRAVE)) { console.log('SKIP — Brave not found at ' + BRAVE + ' (set BRAVE=)'); process.exit(0); }
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

/** A fresh headless profile — Brave or Chromium, optionally with this site allowed to fingerprint. */
async function open(brave, allowSite) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-brave-'));
    if (allowSite) {
        fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ profile: { content_settings: { exceptions: {
            fingerprintingV2: { [`http://localhost:${PORT},*`]: { setting: 1 } } } } } }));
    }
    const ctx = await chromium.launchPersistentContext(dir, Object.assign({ headless: true, viewport: { width: 1280, height: 860 } },
        brave ? { executablePath: BRAVE } : {}));
    const page = ctx.pages()[0] || await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    return { page, errs, close: async () => { await ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** The loading card with a CPU line (a Triangulate All-like source), then what the note says. */
const overlayHint = (page) => page.evaluate(async () => {
    const L = await import('/ui/loading-overlay.js');
    L.showLoadingProgress('Triangulating', 10, 100, { title: 'Triangulate All' });
    L.setLoadingCpu({ counts: 'a test', cpuBusyMs: () => 0 });
    const el = document.getElementById('loadingBraveHint');
    const r = { shown: !el.hidden && el.getBoundingClientRect().height > 0, text: el.textContent, steps: el.querySelectorAll('ol > li').length,
                below: el.getBoundingClientRect().top >= document.getElementById('loadingHardware').getBoundingClientRect().bottom,
                cores: navigator.hardwareConcurrency };
    L.hideLoading();
    r.afterHide = el.hidden;
    L.showLoadingProgress('Assigning identities', 10, 100);          // a popup with no CPU line
    r.withoutCpuLine = el.hidden;
    L.hideLoading();
    return r;
});

let s;
try {
    // ---- 1. Chromium
    s = await open(false, false);
    let r = await overlayHint(s.page);
    check(!r.shown, `Chromium (${r.cores} cores): no note`);
    check(s.errs.length === 0, 'Chromium: no page errors' + (s.errs.length ? ': ' + s.errs.join(' | ') : ''));
    await s.close();

    // ---- 2. Brave, default Shields
    s = await open(true, false);
    r = await overlayHint(s.page);
    check(r.shown && r.below && new RegExp('this session: ' + r.cores + '\\)').test(r.text) && r.steps === 3 &&
          /Shields icon \(the lion\)/.test(r.text) && /Advanced controls/.test(r.text) && /Allow fingerprinting/.test(r.text) && /save your project/.test(r.text),
          `Brave, default Shields: the note under the CPU line, naming the count it reports (${r.cores}), in three steps`);
    check(r.afterHide && r.withoutCpuLine, '…gone with the popup, and never on a popup without a CPU line');

    // ---- 3. Brave: the image check's dialog
    const dlg = await s.page.evaluate(async () => {
        const src = await (await fetch('/tests/e2e/id-switch-image-check.mjs')).text();
        const L = src.split('\n');
        const start = L.findIndex(l => l.includes('// Tracked fixture: 3 animals'));
        const end = L.findIndex((l, i) => i > start && l.trim() === 'return e;') + 1;
        await (new (Object.getPrototypeOf(async function () {}).constructor)(L.slice(start, end + 1).join('\n')))();
        await window.__buildSwap([1, 1, 1]);
        const M = await import('/ui/id-switch-modal.js');
        const done = M.runIdSwitchChecks({ image: true, inject: { createEmbedder: window.__fakeEmbedder(60,
            { backend: 'webgpu', comparing: false, dtype: 'fp16', adapter: '', fallback: false }) } });
        await new Promise(res => { const w = () => document.querySelector('.id-switch-progress .progress-hint') ? res() : setTimeout(w, 50); w(); });
        await new Promise(res => setTimeout(res, 300));
        const el = document.querySelector('.id-switch-progress .progress-hint');
        const out = { shown: !el.hidden, text: el.textContent, steps: el.querySelectorAll('ol > li').length };
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await done;
        return out;
    });
    check(dlg.shown && dlg.steps === 3 && /this session: \d+\)/.test(dlg.text), 'Brave: the image check\'s dialog has the same note');
    check(s.errs.length === 0, 'Brave: no page errors' + (s.errs.length ? ': ' + s.errs.join(' | ') : ''));
    await s.close();

    // ---- 4. Brave with the site allowed to fingerprint
    s = await open(true, true);
    r = await overlayHint(s.page);
    check(!r.shown && r.cores === os.cpus().length, `Brave with the site allowed: no note, and the true core count (${r.cores} of ${os.cpus().length})`);
    await s.close();
    s = null;
} finally {
    if (s) await s.close();
    server.kill();
}
console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
