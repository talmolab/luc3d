/**
 * _diag-sash-sequence.mjs — investigation tool.
 *
 * Does a sash drag still work AFTER an earlier drag on a different sash? The
 * handler flips `viewItem.enabled` and calls `saveProportions()`, so a stuck
 * state would only appear on the SECOND gesture — which is exactly how a user
 * meets it, and exactly what a fresh-modal-per-drag harness hides.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8163);
const CAMS = Number(process.env.CAMS || 3);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
    page.on('pageerror', e => console.log('PAGEERROR ' + e));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    await page.evaluate(async (n) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Session, FrameGroup } = pd;
        const names = Array.from({ length: n }, (_, i) => 'c' + (i + 1));
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = names.map((nm, i) => new Camera(
            nm, K, [0, 0, 0, 0, 0], [100 * (i + 1), 0, 0], [0.1 * (i + 1), 0.2, 0.3], [640, 480]));
        const s = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0'], 'SeqTest');
        s.addFrameGroup(new FrameGroup(0));
        AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
        AS.state.totalFrames = 1; AS.state.currentFrame = 0; AS.state.fps = 30;
        AS.state.triangulationResults = new Map();
        AS.state.views = names.map(nm => ({
            name: nm, decoder: null, canvas: null, ctx: null,
            overlayCanvas: null, overlayCtx: null, videoWidth: 640, videoHeight: 480,
        }));
    }, CAMS);
    await page.evaluate(async () => {
        const M = await import('/ui/overlay-export-modal.js');
        M.showOverlayExportModal();
    });
    await page.waitForTimeout(2500);

    const widths = () => page.evaluate(() =>
        Array.from(document.querySelectorAll('#ovDock [data-view-name]'))
            .map(el => ({ n: el.getAttribute('data-view-name'), r: el.getBoundingClientRect() }))
            .sort((a, b) => a.r.left - b.r.left)
            .map(t => `${t.n}:${Math.round(t.r.width)}`));

    const dragSash = async (idx, dx) => {
        const s = await page.evaluate((i) => {
            const el = document.querySelectorAll('#ovDock .dv-sash')[i];
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.25) };
        }, idx);
        if (!s) { console.log(`  sash #${idx} does not exist`); return; }
        const before = await widths();
        await page.mouse.move(s.x, s.y);
        await page.mouse.down();
        for (const f of [0.34, 0.67, 1.0]) await page.mouse.move(s.x + dx * f, s.y);
        await page.mouse.up();
        await page.waitForTimeout(400);
        const after = await widths();
        const changed = before.join() !== after.join();
        console.log(`  drag sash #${idx} by ${dx >= 0 ? '+' : ''}${dx}: ${changed ? 'CHANGED' : '*** NO EFFECT ***'}`);
        console.log(`      ${before.join(' ')}`);
        console.log(`   -> ${after.join(' ')}`);
    };

    console.log(`\n=== sequential drags, CAMS=${CAMS} ===`);
    console.log('start:', (await widths()).join(' '));
    console.log('\n-- 1st: sash #0 +80 --');
    await dragSash(0, 80);
    console.log('\n-- 2nd: sash #2 +80 (a DIFFERENT sash, same axis) --');
    await dragSash(2, 80);
    console.log('\n-- 3rd: sash #2 +80 again --');
    await dragSash(2, 80);
    console.log('\n-- 4th: sash #1 -60 --');
    await dragSash(1, -60);
    console.log('\n-- 5th: sash #0 +40 (back to the first one) --');
    await dragSash(0, 40);
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}
