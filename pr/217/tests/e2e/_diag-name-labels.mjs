/**
 * _diag-name-labels.mjs — investigation tool.
 *
 * With `Render Video Names` ON, are the camera captions actually present in the
 * STITCHED output, for every tile — including the top row of a multi-row grid?
 *
 * Decodes frame 0 of a real export to raw RGB with ffmpeg and counts white-ish
 * pixels inside each tile's own top-left corner, so a caption drawn in the wrong
 * place (or drawn once for the whole frame) is distinguishable from one missing.
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8173);
const CAMS = Number(process.env.CAMS || 5);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
    page.on('pageerror', e => console.log('PAGEERROR ' + e));
    page.on('console', m => { if (m.type() === 'error') console.log('console.error: ' + m.text().slice(0, 160)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    await page.evaluate(async (n) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Session, FrameGroup } = pd;
        const names = Array.from({ length: n }, (_, i) => 'cam' + (i + 1));
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = names.map((nm, i) => new Camera(
            nm, K, [0, 0, 0, 0, 0], [100 * (i + 1), 0, 0], [0.1 * (i + 1), 0.2, 0.3], [640, 480]));
        const s = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0'], 'NameTest');
        for (let f = 0; f < 2; f++) s.addFrameGroup(new FrameGroup(f));
        // Flat mid-grey video: the caption plate is dark and its text is white, so
        // both stand out and neither can be confused with the frame content.
        const pat = document.createElement('canvas');
        pat.width = 640; pat.height = 480;
        const pc = pat.getContext('2d');
        pc.fillStyle = 'rgb(110,110,110)';
        pc.fillRect(0, 0, 640, 480);
        const bmp = await createImageBitmap(pat);
        AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
        AS.state.totalFrames = 2; AS.state.currentFrame = 0; AS.state.fps = 30;
        AS.state.triangulationResults = new Map();
        AS.state.views = names.map(nm => ({
            name: nm, decoder: { getFrame: async () => bmp },
            canvas: null, ctx: null, overlayCanvas: null, overlayCtx: null,
            videoWidth: 640, videoHeight: 480,
        }));
    }, CAMS);

    await page.evaluate(async () => {
        const M = await import('/ui/overlay-export-modal.js');
        window.__ov = M.showOverlayExportModal();
    });
    await page.waitForTimeout(2500);

    // Force the layer ON explicitly, whatever the stored blob said.
    const layerState = await page.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll('#ovSettings input[type=checkbox]'));
        const el = boxes.find(b => {
            const row = b.closest('div');
            return row && /Render Video Names/i.test(row.textContent || '');
        });
        if (el && !el.checked) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
        return { found: !!el, checked: el ? el.checked : null };
    });
    console.log('Render Video Names checkbox:', layerState);
    await page.waitForTimeout(600);
    console.log('settings.layers.videoNames =',
        await page.evaluate(() => window.__ov._settings().layers.videoNames));

    // Tile rects in OUTPUT pixels, straight from the code the export uses.
    const geom = await page.evaluate(async () => {
        const L = await import('/ui/overlay-export-layout.js');
        const layout = window.__ov._captureLayout();
        const s = window.__ov._settings();
        const out = L.outputSizeFrom(s, layout.dock.width / layout.dock.height);
        const rects = L.computeTileRects(layout.dock, layout.tiles, out.width, out.height);
        return {
            out,
            tiles: rects.map((r, i) => {
                const t = layout.tiles[i].tile;
                return {
                    name: (t && (t.viewName || (t.params && t.params.viewName))) || ('#' + i),
                    x: Math.round(r.x), y: Math.round(r.y),
                    w: Math.round(r.width), h: Math.round(r.height),
                };
            }),
        };
    });
    console.log('\noutput', geom.out.width + 'x' + geom.out.height);
    geom.tiles.forEach(t => console.log(`  tile ${t.name}: (${t.x},${t.y}) ${t.w}x${t.h}`));

    // Stitched export.
    await page.evaluate(() => {
        const set = (id, v) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set('ovMode', 'stitched');
    });
    await page.waitForTimeout(400);
    const dl = page.waitForEvent('download', { timeout: 120000 });
    await page.evaluate(() => {
        Array.from(document.querySelectorAll('button'))
            .find(b => /^Export/i.test(b.textContent.trim())).click();
    });
    const download = await dl;
    const mp4 = path.join(repoRoot, 'tests', 'e2e', `.tmp-names-${process.pid}.mp4`);
    const raw = mp4.replace('.mp4', '.raw');
    await download.saveAs(mp4);

    const W = geom.out.width, H = geom.out.height;
    const r = spawnSync('ffmpeg', ['-y', '-i', mp4, '-frames:v', '1', '-f', 'rawvideo',
        '-pix_fmt', 'rgb24', raw], { encoding: 'utf8' });
    if (r.status !== 0) console.log('ffmpeg failed:', (r.stderr || '').slice(-400));
    const buf = await fs.readFile(raw);
    console.log('\nraw frame bytes', buf.length, 'expected', W * H * 3);

    const px = (x, y) => {
        const o = (y * W + x) * 3;
        return [buf[o], buf[o + 1], buf[o + 2]];
    };
    // The caption occupies roughly the left third of a tile's top ~12%. Count both
    // WHITE (glyphs) and DARK (the plate) — either proves a caption is there.
    const probe = (t) => {
        let white = 0, dark = 0, n = 0;
        const x1 = t.x + Math.round(t.w * 0.55), y1 = t.y + Math.max(6, Math.round(t.h * 0.14));
        for (let y = t.y + 1; y < Math.min(y1, H); y++) {
            for (let x = t.x + 1; x < Math.min(x1, W); x++) {
                const [R, G, B] = px(x, y);
                n++;
                if (R > 190 && G > 190 && B > 190) white++;
                if (R < 60 && G < 60 && B < 60) dark++;
            }
        }
        return { white, dark, n };
    };
    console.log('\nper-tile caption ink in its OWN top-left corner:');
    for (const t of geom.tiles) {
        const p = probe(t);
        const verdict = p.white > 20 ? 'CAPTION PRESENT' : '*** NO CAPTION ***';
        console.log(`  ${String(t.name).padEnd(8)} row y=${String(t.y).padEnd(5)} white=${String(p.white).padEnd(6)} dark=${String(p.dark).padEnd(6)} ${verdict}`);
    }
    await fs.unlink(mp4).catch(() => {});
    await fs.unlink(raw).catch(() => {});
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}
