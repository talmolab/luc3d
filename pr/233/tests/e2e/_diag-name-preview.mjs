/**
 * _diag-name-preview.mjs — investigation tool.
 *
 * Where does the burned-in camera caption actually land in the LIVE PREVIEW, per
 * tile, and is anything drawn on top of it? Reads each tile's own overlay canvas
 * (so this is what was drawn, not what survived compositing) AND screenshots the
 * tile's top-left corner region (so this is what the user sees).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8176);
const CAMS = Number(process.env.CAMS || 5);

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
        const names = Array.from({ length: n }, (_, i) => 'cam' + (i + 1));
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = names.map((nm, i) => new Camera(
            nm, K, [0, 0, 0, 0, 0], [100 * (i + 1), 0, 0], [0.1 * (i + 1), 0.2, 0.3], [640, 480]));
        const s = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0'], 'NamePrev');
        for (let f = 0; f < 2; f++) s.addFrameGroup(new FrameGroup(f));
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

    const setNames = async (on) => {
        await page.evaluate((want) => {
            const boxes = Array.from(document.querySelectorAll('#ovSettings input[type=checkbox]'));
            const el = boxes.find(b => {
                const row = b.closest('div');
                return row && /Render Video Names/i.test(row.textContent || '');
            });
            if (el && el.checked !== want) { el.checked = want; el.dispatchEvent(new Event('change', { bubbles: true })); }
        }, on);
        await page.waitForTimeout(900);
    };

    for (const on of [true, false]) {
        await setNames(on);
        console.log(`\n=== Render Video Names ${on ? 'ON' : 'OFF'} ===`);
        const rows = await page.evaluate(() => {
            const out = [];
            const tiles = window.__ov._tiles();
            for (const [name, tile] of tiles) {
                const oc = tile.overlayCanvas;
                const el = tile.element;
                const r = el ? el.getBoundingClientRect() : null;
                if (!oc || !oc.width) { out.push({ name, note: 'no overlay canvas' }); continue; }
                const ctx = oc.getContext('2d');
                // Count white-ish ink in the canvas's own top-left corner.
                const w = Math.min(oc.width, Math.round(oc.width * 0.6));
                const h = Math.min(oc.height, Math.max(14, Math.round(oc.height * 0.2)));
                const d = ctx.getImageData(0, 0, w, h).data;
                let white = 0, dark = 0;
                for (let i = 0; i < d.length; i += 4) {
                    if (d[i + 3] < 30) continue;
                    if (d[i] > 190 && d[i + 1] > 190 && d[i + 2] > 190) white++;
                    else if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60) dark++;
                }
                out.push({
                    name, white, dark,
                    canvas: oc.width + 'x' + oc.height,
                    domTop: r ? Math.round(r.top) : null,
                    domLeft: r ? Math.round(r.left) : null,
                });
            }
            return out.sort((a, b) => (a.domTop - b.domTop) || (a.domLeft - b.domLeft));
        });
        rows.forEach(r => console.log('  ', JSON.stringify(r)));

        // What the user actually SEES: is the caption region covered by the tab chip?
        const seen = await page.evaluate(() => {
            const out = [];
            const tiles = window.__ov._tiles();
            for (const [name, tile] of tiles) {
                const el = tile.element;
                if (!el) continue;
                const r = el.getBoundingClientRect();
                // A few points inside where the caption is drawn.
                const pts = [[6, 6], [10, 10], [14, 8], [20, 12]];
                const hits = pts.map(([dx, dy]) => {
                    const t = document.elementFromPoint(r.left + dx, r.top + dy);
                    if (!t) return 'null';
                    const cls = String(t.className || '');
                    if (cls.includes('dv-')) return 'TAB/BAND:' + cls.split(' ')[0];
                    return t.tagName;
                });
                out.push({ name, top: Math.round(r.top), atCaption: hits.join(',') });
            }
            return out.sort((a, b) => a.top - b.top);
        });
        seen.forEach(s => console.log('   hit-test', JSON.stringify(s)));
    }
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}
