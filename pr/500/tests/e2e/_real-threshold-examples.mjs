/**
 * _real-threshold-examples.mjs — the threshold card's "In this session" panel on a
 * real recording, in real Chrome (headed, under the browser lock): load a
 * per-camera session folder, Track All, then screenshot the panel at a few values
 * and report how long the scan took. An investigation tool, no assertions.
 *
 * Run: DATASET=<folder> OUT=<dir> NANIMALS=3 node tests/e2e/_real-threshold-examples.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBrowserLock } from '../../scripts/browser-lock.mjs';
import { answerTrackSetup } from './fixtures/track-setup.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATASET = process.env.DATASET, OUT = process.env.OUT, NANIMALS = String(process.env.NANIMALS || 3);
const PORT = Number(process.env.PORT || 8502);
const EXCLUDE = new RegExp(process.env.EXCLUDE || '(^|/)\\.|/troubleshooting/|proofread|reprojections|static\\.externals|\\.analysis\\.h5$|(^|/)points3d\\.h5$|\\.npy$');
const log = (m) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await sleep(1200);
const release = await acquireBrowserLock({ label: '_real-threshold-examples' });
let browser;
try {
    browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--window-size=1500,1050'] });
    const page = await browser.newPage({ viewport: { width: 1480, height: 1000 }, deviceScaleFactor: 2 });
    page.on('pageerror', e => log('pageerror: ' + String(e).slice(0, 300)));
    page.on('dialog', d => d.accept(NANIMALS));
    await answerTrackSetup(page, NANIMALS);
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    await page.evaluate(async () => {
        const st = await import('./ui/settings.js');
        st.setTrackingThresholds({ autoImageSwitchCheck: 0, autoSwitchCheck: 0 });
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.webkitdirectory = true; inp.id = '__dir';
        inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
        setInterval(() => {
            for (const b of document.querySelectorAll('button')) {
                const t = b.textContent.trim();
                if ((t === 'Continue' || t === 'OK') && b.offsetParent !== null) b.click();
            }
        }, 300);
    });
    await page.setInputFiles('#__dir', DATASET);
    await page.evaluate((src) => {
        window.__load = { done: false, err: null };
        (async () => {
            try {
                const sl = await import('./loading/session-loader.js');
                const ex = new RegExp(src);
                const files = Array.from(document.getElementById('__dir').files).filter(f => !ex.test(f.webkitRelativePath || f.name));
                await sl.handleLoadSessionFolderPerCamera(files, false);
                window.__load.done = true;
            } catch (e) { window.__load.err = String(e && e.stack || e).slice(0, 600); }
        })();
    }, EXCLUDE.source);
    await page.waitForFunction(() => window.__load.done || window.__load.err, null, { timeout: 30 * 60000, polling: 1000 });
    const err = await page.evaluate(() => window.__load.err);
    if (err) throw new Error('load failed: ' + err);
    log('loaded');
    await sleep(2000);
    await page.evaluate(() => document.getElementById('tbTrackAll').click());
    await page.waitForFunction(() => /Assigned \d+ identities/.test(document.getElementById('statusText').textContent)
        && document.getElementById('loadingOverlay').classList.contains('hidden'), null, { timeout: 60 * 60000, polling: 1000 });
    log('tracked');
    await sleep(1500);
    // Track All's summary box, if any, must not cover Settings.
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
        window.__t0 = performance.now();
        (await import('./ui/settings-modal.js')).showSettingsModal('triangulation');
    });
    const ready = () => page.waitForFunction(() => { const m = document.querySelector('.thr-ex-message'); return m && m.hidden; }, null, { timeout: 30 * 60000, polling: 100 });
    await ready();
    log(`DLT scan ${((await page.evaluate(() => performance.now() - window.__t0)) / 1000).toFixed(1)} s: ${await page.textContent('.thr-ex-pos')}`);
    const shot = async (name) => {
        await sleep(2500);
        await (await page.$('.thr-ex')).screenshot({ path: path.join(OUT, name + '.png') });
        log(`${name}: ${await page.textContent('.thr-ex-where')} | ${await page.textContent('.thr-ex-result')} | ${await page.textContent('.thr-ex-summary')}`);
    };
    await page.evaluate(() => document.querySelector('.settings-modal').style.cssText += ';height:960px;top:10px');
    await shot('off');
    for (const t of [100, 50, 25, 10]) {
        await page.fill('.tri-thr [data-try="threshold"] .fig-num', String(t));
        await shot('t' + t);
    }
    await page.fill('.tri-thr [data-try="threshold"] .fig-num', '25');
    await page.click('.tri-thr [data-demo-method="ba"]');
    await page.waitForFunction(() => !/Counting/.test(document.querySelector('.thr-ex-summary').textContent), null, { timeout: 30 * 60000 });
    await shot('ba-t25');
    await page.click('.tri-thr [data-demo-method="dlt"]');
    for (let i = 0; i < 4; i++) {
        await page.click('.thr-ex-prev');
        await shot('prev' + (i + 1));
    }
} finally {
    if (browser) await browser.close();
    server.kill();
    await release();
}
