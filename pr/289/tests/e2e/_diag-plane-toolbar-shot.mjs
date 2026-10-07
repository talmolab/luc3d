// Investigation tool (not an assertion): screenshot the toolbar in and out of
// Defining Plane Mode. `node _diag-plane-toolbar-shot.mjs`
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const OUT = process.env.OUT || '/tmp';
const PORT = Number(process.env.PORT || 8195);
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
const shoot = async (name) => {
    const el = await page.$('#toolbar');
    await el.screenshot({ path: path.join(OUT, name) });
    console.log('wrote', path.join(OUT, name));
};
await shoot('toolbar-normal.png');
await page.evaluate(async () => (await import('/ui/plane-definition.js')).enterPlaneMode());
await page.waitForTimeout(200);
await shoot('toolbar-plane-mode.png');
await browser.close();
server.kill();
