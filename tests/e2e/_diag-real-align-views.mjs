/**
 * _diag-real-align-views.mjs — View ▸ "Align Views to References…" (issue #226)
 * on a REAL per-camera session folder, for eyeballing.
 *
 * Loads DATASET through the real folder loader (disk-backed Files, as
 * `_bench-playback.mjs` does), seeks to FRAME, turns the reference views to the
 * given angles the way the Visibility table does, then opens the dialog from
 * the View menu and applies it. Screenshots before / dialog / after go to
 * OUT_DIR. Not a test (needs the dataset).
 *
 * Usage:
 *   DATASET=<dir> REFS='Camera0_mid=0,Camera3_sideC=0' FRAME=2106 OUT_DIR=<dir> \
 *     node tests/e2e/_diag-real-align-views.mjs
 *   env: HEADED=1 (show the window), PORT=8131,
 *        EXCLUDE=<regex> (default: dotfiles and troubleshooting/ dirs)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { acquireBrowserLock } from '../../scripts/browser-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const DATASET = process.env.DATASET;
const REFS = (process.env.REFS || '').split(',').filter(Boolean).map(s => {
    const i = s.lastIndexOf('=');
    return { name: s.slice(0, i), deg: Number(s.slice(i + 1)) };
});
const FRAME = Number(process.env.FRAME || 0);
const OUT_DIR = process.env.OUT_DIR || path.join(repoRoot, 'verify', 'align-views');
const PORT = Number(process.env.PORT || 8131);
const EXCLUDE = new RegExp(process.env.EXCLUDE || '(^|/)\\.|/troubleshooting/');
const log = (m) => process.stdout.write(m + '\n');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

if (!DATASET || !fs.existsSync(DATASET)) { console.error('DATASET not found: ' + DATASET); process.exit(2); }
if (REFS.length < 2) { console.error('REFS needs at least two name=deg entries'); process.exit(2); }
fs.mkdirSync(OUT_DIR, { recursive: true });
const tag = path.basename(DATASET).replace(/[^\w.-]+/g, '_');

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await sleep(1200);

// a visible browser window: one such run at a time across sessions (scripts/browser-lock.mjs)
const releaseBrowserLock = process.env.HEADED === '1' ? await acquireBrowserLock({ label: '_diag-real-align-views' }) : async () => {};
let browser;
try {
    browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    page.on('pageerror', e => log('  [pageerror] ' + String(e).slice(0, 300)));

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 30000 });

    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.webkitdirectory = true; inp.id = '__alignDir';
        inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
        // The loader can raise "Missing Camera Directories"-style popups.
        window.__alignAutoDismiss = setInterval(() => {
            for (const b of document.querySelectorAll('button')) {
                const t = b.textContent.trim();
                if ((t === 'Continue' || t === 'OK') && b.offsetParent !== null) b.click();
            }
        }, 300);
    });
    await page.setInputFiles('#__alignDir', DATASET);
    await page.evaluate((EXCLUDE_SRC) => {
        window.__alignLoad = { done: false, err: null };
        (async () => {
            try {
                const sl = await import('/loading/session-loader.js');
                const ex = new RegExp(EXCLUDE_SRC);
                const files = Array.from(document.getElementById('__alignDir').files)
                    .filter(f => !ex.test(f.webkitRelativePath || f.name));
                await sl.handleLoadSessionFolderPerCamera(files, false);
                window.__alignLoad.done = true;
            } catch (e) { window.__alignLoad.err = String(e && e.stack || e).slice(0, 600); }
        })();
    }, EXCLUDE.source);
    const deadline = Date.now() + 10 * 60 * 1000;
    for (;;) {
        const s = await page.evaluate(() => window.__alignLoad);
        if (s.err) throw new Error('load failed: ' + s.err);
        if (s.done) break;
        if (Date.now() > deadline) throw new Error('load timed out');
        await sleep(1000);
    }
    await page.evaluate(() => clearInterval(window.__alignAutoDismiss));
    log('loaded ' + path.basename(DATASET));

    // Seek, then turn the references exactly as the Visibility table does
    // (session store + view.rotation + applyZoom).
    const info = await page.evaluate(async ({ FRAME, REFS }) => {
        const L = window.__lucid;
        const init = await import('/pose/initialization.js');
        const vf = await import('/ui/video-filters.js');
        const sp = await import('/ui/sessions-panes.js');
        const rendering = await import('/ui/rendering.js');
        if (L.videoController && L.videoController.seekToFrame) await L.videoController.seekToFrame(FRAME);
        await init.navigateToFrame(FRAME);
        for (const r of REFS) {
            const v = L.state.views.find(x => x.name === r.name);
            if (!v) return { err: 'no view named ' + r.name + ' (have ' + L.state.views.map(x => x.name).join(', ') + ')' };
            v.rotation = vf.setSessionRotation(L.state.session, r.name, r.deg);
            if (L.videoController) L.videoController.applyZoom(v);
            sp.syncRotationUI(v);
        }
        rendering.drawAllOverlays(L.state.currentFrame);
        await new Promise(r => setTimeout(r, 1500));
        return { views: L.state.views.map(v => v.name), cams: L.state.session.cameras.map(c => c.name) };
    }, { FRAME, REFS });
    if (info.err) throw new Error(info.err);
    log('views: ' + info.views.join(', '));
    await page.screenshot({ path: path.join(OUT_DIR, `${tag}-1-before.png`) });

    await page.evaluate(() => document.getElementById('menuAlignViews').click());
    await page.waitForSelector('.align-views-modal');
    // Tick exactly the requested references.
    const dialog = await page.evaluate((names) => {
        const rows = [...document.querySelectorAll('.align-views-table tbody tr')];
        for (const r of rows) {
            const want = names.includes(r.querySelector('.align-views-name').textContent);
            const box = r.querySelector('input');
            if (box.checked !== want) box.click();
        }
        return {
            rows: rows.map(r => [...r.querySelectorAll('td')].slice(1).map(td => td.textContent).join(' | ')),
            summary: document.getElementById('alignViewsSummary').textContent,
            error: document.getElementById('alignViewsError').textContent,
        };
    }, REFS.map(r => r.name));
    log('dialog:\n  ' + dialog.rows.join('\n  ') + '\n  ' + dialog.summary + (dialog.error ? '\n  ERROR ' + dialog.error : ''));
    await page.screenshot({ path: path.join(OUT_DIR, `${tag}-2-dialog.png`) });

    await page.evaluate(() => document.getElementById('alignViewsApply').click());
    await page.waitForFunction(() => !document.querySelector('.align-views-modal'));
    await sleep(1500);
    log('status: ' + await page.evaluate(() => document.getElementById('statusText').textContent));
    await page.screenshot({ path: path.join(OUT_DIR, `${tag}-3-after.png`) });
    log('screenshots in ' + OUT_DIR);
} finally {
    if (browser) await browser.close();
    await releaseBrowserLock();
    server.kill();
}
