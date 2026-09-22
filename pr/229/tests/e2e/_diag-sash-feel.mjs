/**
 * _diag-sash-feel.mjs — investigation tool, not an assertion suite.
 *
 * Measures the sash gesture the way a USER experiences it: for each sash, how far
 * does the SASH itself travel compared to the cursor, and what does each tile do?
 * A gesture whose handle does not stay under the cursor reads as broken however
 * correct the size arithmetic is.
 *
 * Each sash is measured against a FRESHLY opened modal so no drag can contaminate
 * the next reading.
 *
 * CAMS=3|4|5 to switch between a flat axis and the nested column grid.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8161);
const CAMS = Number(process.env.CAMS || 3);
const D = Number(process.env.D || 80);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
    page.on('pageerror', e => console.log('PAGEERROR ' + e));

    const seedAndOpen = async () => {
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
            const s = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0'], 'FeelTest');
            s.addFrameGroup(new FrameGroup(0));
            AS.state.sessions = [s];
            AS.state.activeSessionIdx = 0;
            AS.state.session = s;
            AS.state.totalFrames = 1;
            AS.state.currentFrame = 0;
            AS.state.fps = 30;
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
    };

    const tiles = () => page.evaluate(() =>
        Array.from(document.querySelectorAll('#ovDock [data-view-name]')).map(el => {
            const r = el.getBoundingClientRect();
            return {
                n: el.getAttribute('data-view-name'),
                x: Math.round(r.left), y: Math.round(r.top),
                w: Math.round(r.width), h: Math.round(r.height),
            };
        }).sort((a, b) => a.y - b.y || a.x - b.x));

    const sashes = () => page.evaluate(() =>
        Array.from(document.querySelectorAll('#ovDock .dv-sash')).map((el, i) => {
            const r = el.getBoundingClientRect();
            return {
                i, vertical: r.height > r.width,
                x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                w: Math.round(r.width), h: Math.round(r.height),
            };
        }));

    await seedAndOpen();
    console.log(`\n=== CAMS=${CAMS}, drag ${D}px ===`);
    console.log('tiles:', (await tiles()).map(t => `${t.n}@(${t.x},${t.y}) ${t.w}x${t.h}`).join('  '));
    const all = await sashes();
    console.log('sashes:', all.map(s => `#${s.i}${s.vertical ? 'V' : 'H'}@(${s.x},${s.y}) ${s.w}x${s.h}`).join('  '));

    for (const ref of all) {
        await seedAndOpen();
        const live = (await sashes())[ref.i];
        const before = await tiles();
        // Grab OFF-CENTRE along the bar: a full-length sash's exact midpoint can land
        // on a crossing where a perpendicular sash wins the hit-test.
        const gx = live.vertical ? live.x : live.x - Math.round(live.w * 0.25);
        const gy = live.vertical ? live.y - Math.round(live.h * 0.25) : live.y;
        await page.mouse.move(gx, gy);
        await page.mouse.down();
        for (const f of [0.25, 0.5, 0.75, 1.0]) {
            await page.mouse.move(live.vertical ? gx + D * f : gx, live.vertical ? gy : gy + D * f);
        }
        await page.mouse.up();
        await page.waitForTimeout(400);

        const after = await tiles();
        const sAfter = (await sashes())[ref.i];
        const moved = live.vertical ? sAfter.x - live.x : sAfter.y - live.y;
        const key = live.vertical ? 'w' : 'h';
        const deltas = after.map((t, i) => {
            const d = t[key] - before[i][key];
            return `${t.n}:${d >= 0 ? '+' : ''}${d}`;
        });
        console.log(`sash #${ref.i}${live.vertical ? 'V' : 'H'}: cursor +${D} -> SASH MOVED ` +
            `${moved >= 0 ? '+' : ''}${moved} (tracking ${(moved / D * 100).toFixed(0)}%)   ${key}: ${deltas.join(' ')}`);
        console.log(`        abs: ${before.map(t => t[key]).join('/')} -> ${after.map(t => t[key]).join('/')}`);
    }
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}
