/**
 * switchsource-mediabunny-refresh.mjs — real-browser regression test.
 *
 * Bug (issue #115 regression on eric/seeking-regression): `switchSource()`
 * (`loading/video.js`), used by the pooled-decoder session-switch/reopen path
 * (`ui/sessions-panes.js`'s `switchSession()`, "Reuse pool decoder — swap
 * source without creating new video element") to avoid recreating `<video>`
 * elements, never touched `_mbBackend`. `switchSource()` predates the
 * frame-accurate mediabunny backend added in #141 (`_initMediabunny`/
 * `_mbBackend`), and was never updated when that backend landed — so after
 * any session switch/reopen that reuses a pooled decoder, `_mbBackend` kept
 * pointing at the PREVIOUS video. Every subsequent frame-accurate `getFrame()`
 * call (stepping, the pausePlayback() snap) silently decoded from the WRONG
 * (stale) video — reproducing the exact "pose/video misalignment" symptom
 * #141 was supposed to have fixed for good, specifically on session-switch
 * paths (which is how a lazy-reopened session's videos get attached).
 *
 * This builds a decoder, inits it on video A, switchSource()s it to video B
 * (mirroring the pool-reuse path), and asserts the mediabunny backend is
 * fully refreshed: its filename updates to B AND — since sample_session's
 * fixture videos happen to share a frame count, which would let a
 * filename-only check pass by coincidence — a decoded frame's actual pixel
 * content matches video B's own ground truth (an independently, freshly
 * initialized decoder on B), not video A's.
 *
 * Run: node switchsource-mediabunny-refresh.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8099);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', msg => { if (msg.type() === 'error') console.log('  [console.error]', msg.text().slice(0, 300)); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    const r = await page.evaluate(async () => {
        const videoMod = await import('/loading/video.js');
        const OnDemandVideoDecoder = videoMod.OnDemandVideoDecoder;

        async function fileFrom(path, name) {
            const resp = await fetch(path);
            const blob = await resp.blob();
            return new File([blob], name, { type: 'video/mp4' });
        }
        async function frameSignature(decoder, idx) {
            var bmp = await decoder.getFrame(idx);
            if (!bmp) return null;
            var c = document.createElement('canvas');
            c.width = Math.min(bmp.width, 32); c.height = Math.min(bmp.height, 32);
            var ctx = c.getContext('2d');
            ctx.drawImage(bmp, 0, 0, c.width, c.height);
            var data = ctx.getImageData(0, 0, c.width, c.height).data;
            var sum = 0;
            for (var i = 0; i < data.length; i += 7) sum += data[i];
            return sum;
        }

        const fileA = await fileFrom('/sample_session/side.mp4', 'side.mp4');
        const fileB = await fileFrom('/sample_session/back.mp4', 'back.mp4');

        // Decoder that inits on A, then switches to B — the pool-reuse path.
        const decoder = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
        await decoder.init(fileA);
        const mbFilenameAfterInitA = decoder._mbBackend ? decoder._mbBackend.filename : null;
        const sigOfAAtFrame0 = await frameSignature(decoder, 0);

        await decoder.switchSource(fileB);
        const mbFilenameAfterSwitch = decoder._mbBackend ? decoder._mbBackend.filename : null;
        const sigOfSwitchedAtFrame0 = await frameSignature(decoder, 0);

        // Ground truth: a totally independent, freshly-initialized decoder on B.
        const freshDecoderB = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
        await freshDecoderB.init(fileB);
        const groundTruthSigB = await frameSignature(freshDecoderB, 0);

        return {
            mbBackendPresentAfterInit: !!decoder._mbBackend,
            mbFilenameAfterInitA,
            mbBackendPresentAfterSwitch: !!decoder._mbBackend,
            mbFilenameAfterSwitch,
            sigOfAAtFrame0,
            sigOfSwitchedAtFrame0,
            groundTruthSigB,
        };
    });

    console.log('  measured:', JSON.stringify(r, null, 2));
    check(r.mbBackendPresentAfterInit, 'mediabunny backend initializes on the first init() (video A)');
    check(r.mbFilenameAfterInitA === 'side.mp4', `backend bound to A right after init (got "${r.mbFilenameAfterInitA}")`);
    check(r.mbBackendPresentAfterSwitch, 'mediabunny backend still present after switchSource()');
    check(r.mbFilenameAfterSwitch === 'back.mp4', `backend refreshed to B's filename after switchSource() — NOT stale on A (got "${r.mbFilenameAfterSwitch}")`);
    check(r.sigOfSwitchedAtFrame0 === r.groundTruthSigB,
        `frame 0 decoded via the REUSED decoder after switchSource(B) matches B's own ground-truth content (not stale content from A) — got ${r.sigOfSwitchedAtFrame0} vs ground truth ${r.groundTruthSigB} (A's was ${r.sigOfAAtFrame0})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
