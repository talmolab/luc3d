/**
 * mediabunny-fallback-status-warning.mjs — real-browser regression test.
 *
 * Follow-up to issue #115: when the frame-accurate mediabunny backend fails
 * to initialize for a decoder (falls back to less-precise HTML5 seeking),
 * the ONLY signal was a `console.warn` — invisible unless devtools was open.
 * A user with no reason to suspect the backend silently failed (it's
 * default-on, no configuration needed) had no way to confirm whether
 * misaligned stepping/playback was due to a fallback or something else,
 * short of typing into the console themselves.
 *
 * `rebuildVideoController()` (`loading/session-loader.js`) — called after
 * every fresh load, session switch, and lazy-reopen video attach — now
 * checks every view's decoder for a missing `_mbBackend` and posts a
 * `setStatus(..., 'warning')` naming how many camera(s) fell back, so it's
 * visible in the app's own status bar with zero console interaction.
 *
 * This drives `rebuildVideoController()` directly with synthetic view/decoder
 * stand-ins (no real video decode needed — the check only reads
 * `view.decoder._mbBackend`) and asserts the status bar reflects both the
 * failure case and the all-good case (without falsely clobbering an
 * unrelated prior status message when nothing is wrong).
 *
 * Run: node mediabunny-fallback-status-warning.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8100);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const r = await page.evaluate(async () => {
        const sessionLoader = await import('/loading/session-loader.js');
        const AS = await import('/ui/app-state.js');

        // Case 1: one of two decoders never got a mediabunny backend
        // (simulated init failure) — should surface a warning.
        AS.state.views = [
            { name: 'camA', decoder: { _mbBackend: null } },
            { name: 'camB', decoder: { _mbBackend: {} } },
        ];
        AS.state.totalFrames = 10;
        AS.state.fps = 30;
        sessionLoader.rebuildVideoController();
        const statusAfterMissing = document.getElementById('statusText').textContent;

        // Case 2: both decoders have a mediabunny backend — should NOT
        // touch the status bar (proves it doesn't clobber an unrelated
        // message some other part of the load flow already set).
        document.getElementById('statusText').textContent = 'unrelated prior status';
        AS.state.views = [
            { name: 'camA', decoder: { _mbBackend: {} } },
            { name: 'camB', decoder: { _mbBackend: {} } },
        ];
        sessionLoader.rebuildVideoController();
        const statusAfterAllGood = document.getElementById('statusText').textContent;

        return { statusAfterMissing, statusAfterAllGood };
    });

    console.log('  measured:', JSON.stringify(r, null, 2));
    check(/1 of 2 camera\(s\) fell back to HTML5/.test(r.statusAfterMissing),
        `warning names the exact fallback count when a decoder lacks _mbBackend (got "${r.statusAfterMissing}")`);
    check(r.statusAfterAllGood === 'unrelated prior status',
        `no warning (and no clobbering of an unrelated prior status) when every decoder has _mbBackend (got "${r.statusAfterAllGood}")`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
