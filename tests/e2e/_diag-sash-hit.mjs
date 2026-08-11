/**
 * _diag-sash-hit.mjs — investigation tool.
 *
 * Is the sash actually the topmost element under the cursor along its whole
 * length? The overlaid tab band (negative content margin + z-index) could cover
 * a divider, which would read to a user as "dragging does nothing".
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8164);
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
        const names = Array.from({ length: n }, (_, i) => 'c' + (i + 1));
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = names.map((nm, i) => new Camera(
            nm, K, [0, 0, 0, 0, 0], [100 * (i + 1), 0, 0], [0.1 * (i + 1), 0.2, 0.3], [640, 480]));
        const s = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0'], 'HitTest');
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

    const report = await page.evaluate(() => {
        const out = [];
        const sashes = Array.from(document.querySelectorAll('#ovDock .dv-sash'));
        sashes.forEach((el, i) => {
            const r = el.getBoundingClientRect();
            const vertical = r.height > r.width;
            const probes = [0.1, 0.25, 0.5, 0.75, 0.9];
            const hits = probes.map(f => {
                const x = vertical ? r.left + r.width / 2 : r.left + r.width * f;
                const y = vertical ? r.top + r.height * f : r.top + r.height / 2;
                const top = document.elementFromPoint(x, y);
                if (!top) return 'null';
                if (top === el) return 'SASH';
                if (top.classList && top.classList.contains('dv-sash')) return 'other-sash';
                return (top.tagName + '.' + (top.className && top.className.toString ? String(top.className).slice(0, 24) : '')).slice(0, 34);
            });
            const cs = getComputedStyle(el);
            out.push({
                i, vertical,
                box: `${Math.round(r.width)}x${Math.round(r.height)}`,
                z: cs.zIndex, pe: cs.pointerEvents,
                hits: probes.map((f, j) => `${f}:${hits[j]}`).join(' '),
            });
        });
        return out;
    });
    console.log(`\n=== sash hit-testing, CAMS=${CAMS} ===`);
    report.forEach(r => {
        console.log(`sash #${r.i}${r.vertical ? 'V' : 'H'} ${r.box} z=${r.z} pointer-events=${r.pe}`);
        console.log(`    ${r.hits}`);
    });
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}
