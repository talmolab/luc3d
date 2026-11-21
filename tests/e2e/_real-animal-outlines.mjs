/**
 * _real-animal-outlines.mjs — animal outlines on a real multi-camera recording
 * (an investigation tool, not an assertion): loads a recording folder (one
 * folder per camera with its video and .slp, calibration.toml at the root),
 * runs Track All and Triangulate All, turns Visibility ▸ Animal Outlines on and
 * saves, per frame asked for, the whole dock and each camera cropped around
 * the animals (2x), then flags one outline through Shift+O and exports the
 * flags. Prints each camera's empty arena, area model and per-frame blob kinds.
 *
 *   DATA=<recording folder> FRAMES=0,460 OUT=<folder> [SOLO=0:Camera0_mid,460:Camera2_topC]
 *   [FLAG=460:Camera2_topC] [CHROME=1]
 *
 * SOLO: frame:camera pairs also shot alone (single-view mode), whole and cropped.
 *   node tests/e2e/_real-animal-outlines.mjs
 *
 * The videos must be ones the browser decodes (Playwright's Chromium: H.264;
 * CHROME=1 uses installed Chrome, which decodes HEVC on a Mac).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const DATA = process.env.DATA, OUT = process.env.OUT || path.join(process.cwd(), 'outline-shots');
const FRAMES = (process.env.FRAMES || '0').split(',').map(Number);
const FLAG = process.env.FLAG || '';
const SOLO = (process.env.SOLO || '').split(',').filter(Boolean).map(x => ({ f: Number(x.split(':')[0]), c: x.split(':')[1] }));
if (!DATA) { console.log('set DATA=<recording folder>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const PORT = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1000));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);

let browser;
try {
    browser = await chromium.launch(process.env.CHROME ? { channel: 'chrome' } : {});
    const context = await browser.newContext({ viewport: { width: 1920, height: 1200 }, deviceScaleFactor: 2, acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', e => log('[pageerror] ' + String(e).slice(0, 300)));
    page.on('console', m => { if ((m.type() === 'error' || /\[outlines\]/.test(m.text())) && !/Failed to load resource|404/.test(m.text())) log('[console.' + m.type() + '] ' + m.text().slice(0, 300)); });
    await page.goto(`http://127.0.0.1:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });
    await page.evaluate(async () => { window.__ao = await import('/ui/animal-outlines.js'); });

    page.once('filechooser', async (fc) => { await fc.setFiles(DATA); });
    await page.evaluate(async () => {
        const skip = setInterval(() => { const b = document.querySelector('#folderConfirmOk, .folder-confirm-ok'); if (b) b.click(); }, 200);
        await (await import('/loading/session-loader.js')).handleLoadSessionFolderPerCamera();
        clearInterval(skip);
    });
    await page.waitForFunction(() => window.__lucid.state.views.length > 0 && window.__lucid.state.views.every(v => v.decoder && v.decoder.samples && v.decoder.samples.length) &&
        document.getElementById('loadingOverlay').classList.contains('hidden'), null, { timeout: 600000 });
    const info = await page.evaluate(() => ({ views: window.__lucid.state.views.map(v => v.name + ' ' + v.videoWidth + 'x' + v.videoHeight + ' ' + v.decoder.samples.length),
        nodes: window.__lucid.state.session.skeleton.nodes, cams: window.__lucid.state.session.cameras.map(c => c.name) }));
    log('loaded: ' + info.views.join('; '));
    log('skeleton: ' + info.nodes.join(','));

    log('Track All…');
    await page.evaluate(async () => {
        window.__lucid.state.session.numAnimals = 2;
        await (await import('/pose/tracker.js')).trackAll();
    });
    await page.waitForFunction(() => document.getElementById('loadingOverlay').classList.contains('hidden'), null, { timeout: 600000 });
    log('Triangulate All…');
    await page.evaluate(async () => { await (await import('/pose/triangulation.js')).triangulateAllFrames('dlt'); });
    await page.waitForFunction(() => document.getElementById('loadingOverlay').classList.contains('hidden'), null, { timeout: 600000 });
    // close the Track All summary (and anything else modal) so the shortcuts reach the app
    for (let i = 0; i < 3; i++) {
        const open = await page.evaluate(() => !!document.querySelector('.multi-frame-modal-overlay, .track-summary-overlay, [role="dialog"]'));
        if (!open) break;
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
    }
    log('groups on ' + await page.evaluate(() => window.__lucid.state.session.instanceGroups.size) + ' frames');

    await page.evaluate(() => { const cb = document.getElementById('visOutlines'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.evaluate(() => document.querySelector('.panel-tab[data-tab="tabOutlines"]').click());
    await page.waitForFunction(() => {
        const s = window.__lucid.state.session;
        return window.__lucid.state.views.every(v => { const c = window.__ao.outlineCameraState(s, v.name); return c && (c.status === 'ready' || c.status === 'failed'); });
    }, null, { timeout: 600000, polling: 500 });
    const cams = await page.evaluate(() => window.__lucid.state.views.map(v => {
        const c = window.__ao.outlineCameraState(window.__lucid.state.session, v.name);
        return v.name + ': ' + c.status + (c.error ? ' ' + c.error : '') + ', ' + (c.frames ? c.frames.length : 0) + ' frames, one animal ' +
            (c.model ? Math.round(c.model.median) + ' ± ' + Math.round(c.model.sd) + ' px (' + c.model.frames + ' frames with ' + c.nAnimals + ' blobs)' : 'no model');
    }));
    log('empty arenas:\n  ' + cams.join('\n  '));

    for (const f of FRAMES) {
        await page.evaluate((f) => window.__lucid.videoController.seekToFrame(f), f);
        await page.waitForFunction((f) => window.__lucid.state.currentFrame === f && window.__lucid.state.views.every(v => {
            const d = window.__ao.drawnOutlines(window.__lucid.state.session, v.name); return d && d.frame === f;
        }), f, { timeout: 120000, polling: 250 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `dock_${f}.png`) });
        const per = await page.evaluate(() => window.__lucid.state.views.map(v => {
            const d = window.__ao.drawnOutlines(window.__lucid.state.session, v.name);
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            d.result.contours.forEach(l => l.forEach(p => { for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); } }));
            const r = v.overlayCanvas.getBoundingClientRect();
            const sx = r.width / v.videoWidth, sy = r.height / v.videoHeight;
            const pad = 40;
            return { name: v.name, animals: d.animals.map(a => a.name + (a.source === '3d' ? ' (3D)' : '')), blobs: d.result.blobs.map(b => b.kind + ':' + b.area + ':' + b.animals.join('+')),
                stats: d.result.animals.map(s => s.area + 'px tail ' + s.tail + ' re ' + s.reattached),
                clip: isFinite(x0) ? { x: r.left + Math.max(0, x0 - pad) * sx, y: r.top + Math.max(0, y0 - pad) * sy, width: (Math.min(v.videoWidth, x1 + pad) - Math.max(0, x0 - pad)) * sx, height: (Math.min(v.videoHeight, y1 + pad) - Math.max(0, y0 - pad)) * sy } : null };
        }));
        for (const p of per) {
            log(`frame ${f} ${p.name}: ${p.animals.join(', ')} | blobs ${p.blobs.join(' ')} | ${p.stats.join('; ')}`);
            if (p.clip && p.clip.width > 4 && p.clip.height > 4) await page.screenshot({ path: path.join(OUT, `crop_${f}_${p.name}.png`), clip: p.clip });
        }
    }

    const crop = (c) => page.evaluate((c) => {
        const v = window.__lucid.state.views.find(v => v.name === c);
        const d = window.__ao.drawnOutlines(window.__lucid.state.session, c);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        d.result.contours.forEach(l => l.forEach(p => { for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); } }));
        const r = v.overlayCanvas.getBoundingClientRect(), sx = r.width / v.videoWidth, sy = r.height / v.videoHeight, pad = 60;
        x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(v.videoWidth, x1 + pad); y1 = Math.min(v.videoHeight, y1 + pad);
        return { x: r.left + x0 * sx, y: r.top + y0 * sy, width: (x1 - x0) * sx, height: (y1 - y0) * sy };
    }, c);
    const ui = await page.evaluate(async () => { window.__uw = await import('/ui/ui-wiring.js'); return true; });
    for (const { f, c } of SOLO) {
        await page.evaluate((c) => { window.__lucid.interactionManager.lastInteractedView = c; window.__uw.enterSingleViewMode(); window.__uw.setSoloView(c); }, c);
        const shown = await page.evaluate(() => window.__lucid.state.views.filter(v => v.overlayCanvas && v.overlayCanvas.isConnected).map(v => v.name));
        if (shown.join() !== c) log('solo shows ' + shown.join() + ', not ' + c);
        await page.waitForTimeout(500);
        await page.evaluate(async (a) => {
            await window.__lucid.videoController.seekToFrame(a.f);
            (await import('/ui/rendering.js')).drawAllOverlays(a.f);
        }, { f, c });
        try {
            await page.waitForFunction((a) => window.__lucid.state.currentFrame === a.f && (() => { const d = window.__ao.drawnOutlines(window.__lucid.state.session, a.c); return d && d.frame === a.f; })(), { f, c }, { timeout: 60000, polling: 250 });
        } catch (e) {
            log('solo wait failed: ' + JSON.stringify(await page.evaluate((c) => ({ cur: window.__lucid.state.currentFrame, playing: window.__lucid.state.isPlaying, mode: window.__lucid.state.viewMode,
                pool: window.__ao.__outlinePoolInfo(window.__lucid.state.session), drawn: (window.__ao.drawnOutlines(window.__lucid.state.session, c) || {}).frame,
                views: window.__lucid.state.views.map(v => v.name + (v.overlayCanvas && v.overlayCanvas.isConnected ? '+' : '-')) }), c)));
            throw e;
        }
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(OUT, `solo_${f}_${c}.png`) });
        const clip = await crop(c);
        if (clip.width > 4) await page.screenshot({ path: path.join(OUT, `solo_crop_${f}_${c}.png`), clip });
        log(`solo ${f} ${c}`);
    }

    if (FLAG) {
        const [ff, fc] = FLAG.split(':');
        const f = Number(ff);
        await page.evaluate((f) => window.__lucid.videoController.seekToFrame(f), f);
        await page.waitForFunction((a) => { const d = window.__ao.drawnOutlines(window.__lucid.state.session, a.c); return d && d.frame === a.f; }, { f, c: fc }, { timeout: 120000 });
        const pt = await page.evaluate((c) => {
            const v = window.__lucid.state.views.find(v => v.name === c);
            const d = window.__ao.drawnOutlines(window.__lucid.state.session, c);
            const L = d.result.labels; let sx = 0, sy = 0, n = 0;
            for (let i = 0; i < L.length; i++) if (L[i] === 1) { sx += i % d.w; sy += (i / d.w) | 0; n++; }
            const r = v.overlayCanvas.getBoundingClientRect();
            return { x: r.left + (sx / n) * r.width / v.videoWidth, y: r.top + (sy / n) * r.height / v.videoHeight };
        }, fc);
        await page.mouse.move(pt.x, pt.y); await page.mouse.move(pt.x + 1, pt.y);
        await page.keyboard.press('Shift+O');
        await page.waitForSelector('.outline-flag-modal');
        await page.click('input[name="outlineFlagReason"][value="tail"]');
        await page.fill('#outlineFlagNote', 'tail traced across the other mouse');
        await page.screenshot({ path: path.join(OUT, `flag_dialog_${f}.png`) });
        await page.click('#outlineFlagOk');
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `flag_list_${f}.png`) });
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click('#outlineExportBtn')]);
        await dl.saveAs(path.join(OUT, dl.suggestedFilename()));
        log('exported ' + dl.suggestedFilename());
        // the brush over the same animal
        await page.keyboard.press('b');
        await page.mouse.move(pt.x + 3, pt.y + 2);
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `brush_${f}.png`) });
        await page.keyboard.press('Escape');
    }
} catch (e) {
    log('threw: ' + (e && e.stack || e));
    process.exitCode = 1;
} finally {
    if (browser) await browser.close();
    server.kill();
}
