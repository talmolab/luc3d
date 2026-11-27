/**
 * _real-memory-panel-trackall.mjs — screenshots of the Memory panel
 * (ui/memory-panel.js) while Track All runs on a real per-camera folder.
 *
 * Investigation tool, not a test. Headless real Chrome with
 * `--enable-precise-memory-info` (without it Chrome's reading is rounded and
 * frozen for 20 minutes), so no browser lock is needed.
 *   DATASET=<dir> NANIMALS=5 OUT=<dir> node tests/e2e/_real-memory-panel-trackall.mjs
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { answerTrackSetup } from './fixtures/track-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const DATASET = process.env.DATASET ||
    '/Users/soline/Documents/luc3d/LabMeetingPrep/Oline/20260713_174659-194366_05mice_flippers';
const NANIMALS = process.env.NANIMALS || '5';
const OUT = process.env.OUT || path.join(os.tmpdir(), 'luc3d-memory-panel');
const EXCLUDE = new RegExp(process.env.EXCLUDE || '(^|/)\\.|/troubleshooting/');
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = await startServer(repoRoot);
const browser = await launchBrowser({ channel: 'chrome', args: ['--enable-precise-memory-info'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => log('[pageerror] ' + String(e).slice(0, 300)));
    page.on('dialog', d => d.accept(NANIMALS));
    await answerTrackSetup(page, NANIMALS);
    await page.goto(`http://localhost:${server.port}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.__lucidMemoryPanel, null, { timeout: 60000 });
    await page.click('#panelRail .panel-rail-btn[data-tab="tabMemory"]');
    await page.mouse.move(600, 400);

    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.webkitdirectory = true; inp.id = '__diagDir';
        document.body.appendChild(inp);
        setInterval(() => {
            for (const b of document.querySelectorAll('button')) {
                const t = b.textContent.trim();
                if ((t === 'Continue' || t === 'OK') && b.offsetParent !== null) b.click();
            }
        }, 300);
    });
    await page.setInputFiles('#__diagDir', DATASET);
    await page.evaluate((EX) => {
        window.__diagLoad = { done: false, err: null };
        (async () => {
            try {
                const sl = await import(new URL('loading/session-loader.js', document.baseURI).href);
                const ex = new RegExp(EX);
                const files = Array.from(document.getElementById('__diagDir').files).filter(f => !ex.test(f.webkitRelativePath || f.name));
                await sl.handleLoadSessionFolderPerCamera(files, false);
                window.__diagLoad.done = true;
            } catch (e) { window.__diagLoad.err = String(e && e.stack || e).slice(0, 500); }
        })();
    }, EXCLUDE.source);
    for (;;) {
        const s = await page.evaluate(() => window.__diagLoad);
        if (s.err) throw new Error('load failed: ' + s.err);
        if (s.done) break;
        await sleep(1000);
    }
    log('loaded');
    await sleep(3000);
    await page.screenshot({ path: path.join(OUT, '1-loaded.png') });

    await page.evaluate(() => {
        window.__track = { done: false };
        import(new URL('pose/tracker.js', document.baseURI).href).then(m => m.trackAll())
            .catch(e => { window.__track.err = String(e); })
            .then(() => { window.__track.done = true; });
    });
    let shot = 0;
    for (;;) {
        await sleep(8000);
        const done = await page.evaluate(() => window.__track.done);
        if (done) break;
        shot++;
        await page.screenshot({ path: path.join(OUT, `2-trackall-${shot}.png`) });
        const now = await page.evaluate(() => document.getElementById('memoryNow').textContent);
        log(`Track All running: ${now}`);
    }
    log('Track All done: ' + JSON.stringify(await page.evaluate(() => window.__track)));
    await sleep(3000);
    await page.screenshot({ path: path.join(OUT, '3-after-trackall.png') });
    await page.locator('#infoPanelWrapper').screenshot({ path: path.join(OUT, '4-panel-after.png') });
    const samples = await page.evaluate(() => window.__lucidMemoryPanel.samples().map(s => Math.round(s.used / 1048576)));
    log('used MB per second: ' + samples.join(' '));
} finally {
    await browser.close();
    server.close();
}
