/**
 * _bench-smoothing-ui.mjs — Temporal Smoothing ▸ This frame vs All frames
 * through the real menu items (smoothing + redraw, click to status), on a long
 * eager and a long lazy session (ba-rig fixture, Triangulate All first).
 *
 * Run: PORT=8741 FRAMES=20000 node tests/e2e/_bench-smoothing-ui.mjs
 *      ROOT=<another checkout> serves that tree instead (A/B a base commit).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.ROOT || path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8741);
const NF = Number(process.env.FRAMES || 20000);
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: root, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.on('pageerror', e => console.log('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    const waitStatus = (re) => page.waitForFunction(
        (src) => new RegExp(src).test(document.getElementById('statusText').textContent),
        re.source, { timeout: 600000 });

    for (const eager of [true, false]) {
        const t0 = Date.now();
        await page.evaluate(async ({ NF, eager }) => {
            const AS = await import('/ui/app-state.js');
            const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
            const F = await buildBaRigFixture({ frames: NF, cycle: 50 });
            const s = F.mkSession('bench' + eager, { eager });
            AS.state.sessions = [s];
            AS.state.activeSessionIdx = 0;
            AS.state.session = s;
            AS.state.totalFrames = F.NF;
            AS.state.currentFrame = 0;
            AS.state.views = [];
            AS.state.triangulationResults = new Map();
            document.getElementById('statusText').textContent = '';
            document.getElementById('tbTriangulateAll').click();
        }, { NF, eager });
        await waitStatus(/^(Triangulated|Grouped) /);
        console.log(`${eager ? 'eager' : 'lazy '} ${NF.toLocaleString('en-US')} frames: set up + Triangulate All ${((Date.now() - t0) / 1000).toFixed(1)} s`);

        const run = (scope) => page.evaluate(async ({ scope, NF }) => {
            const AS = await import('/ui/app-state.js');
            const S = await import('/ui/settings.js');
            S.setSmoothingParams({ smoothMedianWindow: 5, smoothGaussianWindow: 9 });
            AS.state.currentFrame = Math.floor(NF / 2);
            const st = document.getElementById('statusText');
            st.textContent = '';
            const done = new Promise(res => {
                const mo = new MutationObserver(() => {
                    if (/^Smoothed |^Temporal smoothing/.test(st.textContent)) { mo.disconnect(); res(); }
                });
                mo.observe(st, { childList: true, characterData: true, subtree: true });
            });
            const t = performance.now();
            document.querySelector(`#smoothingDropdown [data-scope="${scope}"]`).click();
            await done;
            return [performance.now() - t, st.textContent];
        }, { scope, NF });
        for (const scope of ['frame', 'frame', 'frame', 'all', 'frame']) {
            const [ms, msg] = await run(scope);
            console.log(`  ${scope.padEnd(5)} ${ms.toFixed(1).padStart(8)} ms  "${msg}"`);
        }
    }
} finally {
    if (browser) await browser.close();
    server.kill();
}
