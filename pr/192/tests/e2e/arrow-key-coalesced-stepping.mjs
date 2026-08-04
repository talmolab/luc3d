/**
 * arrow-key-coalesced-stepping.mjs — real-browser regression test.
 *
 * Bug (issue #115 followup regression): after adding `_mbSeekLock` to
 * serialize concurrent mediabunny decode calls, arrow-key stepping got
 * WORSE, not better, on real (large/slow-decoding) video — because arrow
 * keys, Home/End, and the transport Next/Prev/First/Last buttons all called
 * `videoController.seekToFrame(...)` directly, with NO coalescing. Under
 * rapid presses (faster than one decode round-trip), every single
 * intermediate frame queued up behind the new serializing lock and had to
 * fully decode + paint, in order, before the display caught up to wherever
 * the user actually was — visibly "pulling frames in the wrong order" /
 * badly misaligned, reported directly against a real 5-camera project.
 *
 * The seekbar/scrub path never had this problem: `scrubToFrame()` already
 * coalesces rapid requests to just the latest target, dropping stale
 * intermediate ones (`_scrubTarget`/`_isSeeking`). The fix routes every
 * rapid-fire, repeatable user-input path (arrow keys, Home/End,
 * seekToLabeledFrame, and `navigateToFrame`'s real-video branch used by the
 * transport buttons) through `scrubToFrame` instead of calling
 * `seekToFrame` directly, so they get the same coalescing for free.
 *
 * This drives the REAL keydown handler (not a reimplementation) against a
 * decoder with artificial decode latency, fires several rapid ArrowRight
 * presses, and asserts `scrubToFrame` (not raw `seekToFrame`) is what the
 * handler calls, and that not every intermediate frame gets individually
 * decoded.
 *
 * Run: node arrow-key-coalesced-stepping.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8101);
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
        const AS = await import('/ui/app-state.js');
        const sessionLoader = await import('/loading/session-loader.js');

        var decodeCalls = [];
        var fakeDecoder = {
            _mbBackend: {},
            getFrame: function (idx) {
                decodeCalls.push(idx);
                return new Promise(function (resolve) {
                    setTimeout(function () { resolve(document.createElement('canvas')); }, 25);
                });
            },
        };
        AS.state.views = [{ name: 'camA', decoder: fakeDecoder, canvas: document.createElement('canvas'), ctx: document.createElement('canvas').getContext('2d'), overlayCanvas: document.createElement('canvas'), overlayCtx: document.createElement('canvas').getContext('2d') }];
        AS.state.totalFrames = 1000;
        AS.state.fps = 30;
        AS.state.currentFrame = 0;
        AS.state.session = { lazyLoader: null, frameGroups: new Map(), tracks: [] }; // truthy, so hasRealVideo() only depends on views having a decoder
        sessionLoader.rebuildVideoController();

        var vc = AS.videoController;
        // Wrap ONLY scrubToFrame. (Wrapping seekToFrame too would double-count:
        // scrubToFrame's own internal _processScrub calls `this.seekToFrame`
        // on this SAME instance, so a seekToFrame wrapper can't distinguish "the
        // arrow handler called it directly" from "scrubToFrame called it
        // internally, as designed." scrubCalls alone already fully proves
        // there's no direct bypass: if the handler called seekToFrame
        // directly instead, scrubToFrame would never be invoked for that
        // press and scrubCalls would fall short of the press count.)
        var scrubCalls = 0;
        var origScrub = vc.scrubToFrame.bind(vc);
        vc.scrubToFrame = function (f) { scrubCalls++; return origScrub(f); };

        // Fire 6 rapid ArrowRight keydowns — faster than the 25ms simulated
        // decode — exactly what holding the key (or fast tapping) produces.
        for (var i = 0; i < 6; i++) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
            await new Promise(function (r) { setTimeout(r, 4); });
        }
        await new Promise(function (r) { setTimeout(r, 300); }); // let it all settle

        return {
            scrubCalls,
            decodeCallCount: decodeCalls.length,
            finalCurrentFrame: AS.state.currentFrame,
        };
    });

    console.log('  measured:', JSON.stringify(r, null, 2));
    check(r.scrubCalls === 6, `all 6 ArrowRight presses routed through scrubToFrame, not a direct seekToFrame bypass (got ${r.scrubCalls})`);
    check(r.decodeCallCount < 6, `fewer decoder.getFrame calls than key presses — intermediate frames coalesced, not individually decoded (got ${r.decodeCallCount})`);
    check(r.finalCurrentFrame > 0, `still advanced forward from frame 0 (got ${r.finalCurrentFrame})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
