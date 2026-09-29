/**
 * mediabunny-bframe-decode-order.mjs — real-browser regression test.
 *
 * Bug: the vendored MediaBunnyVideoBackend.initialize() (lib/sleap-io/
 * chunk-X76PRJK6.js) builds its frame-index → timestamp map by pushing
 * EncodedPacketSink.packets()' timestamps in ITERATION order:
 *
 *   for await (const packet of packetSink.packets()) {
 *       this._frameTimes.push(packet.timestamp);
 *   }
 *
 * Per mediabunny's own docs, packets() yields packets in DECODE order, not
 * presentation order — each packet's `.timestamp` is its real presentation
 * timestamp, but the ITERATION order is not sorted by it. For any
 * B-frame-encoded video (routine for real camera recordings; the original
 * issue #115 report specifically suspected "keyframes versus B-frames"),
 * decode order != presentation order, so `_frameTimes[i]` was NOT the i-th
 * frame in playback order — decodeSingleFrame(i) then looked up the WRONG
 * timestamp for any i displaced by B-frame reordering, deterministically
 * returning the wrong frame's pixel content for a CORRECT, requested frame
 * index. This is NOT a race — it reproduces on a single, deliberate,
 * non-concurrent request, which is why every earlier race/cache fix in this
 * area didn't touch it, and why it didn't show up against sample_session's
 * simple (B-frame-less) test clips.
 *
 * Fixed by sorting `_frameTimes` ascending by timestamp after collection.
 *
 * This test builds a REAL H.264 video with actual B-frames (ffmpeg, `-bf 3`)
 * where each frame has a burned-in, human-readable frame number, and
 * independently extracts ground-truth PNGs for each display-order frame via
 * `ffmpeg -vsync 0` (both fixtures are checked in — see
 * tests/fixtures/bframes-test/). It decodes every frame through the REAL
 * MediaBunnyVideoBackend (via OnDemandVideoDecoder) and asserts each
 * decoded frame's pixel content matches its ground-truth PNG — proving
 * decode ORDER correctness, not just that mediabunny is "active."
 *
 * Run: node mediabunny-bframe-decode-order.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8102);
const NUM_FRAMES = 30;
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    const r = await page.evaluate(async (numFrames) => {
        const videoMod = await import('/loading/video.js');
        const OnDemandVideoDecoder = videoMod.OnDemandVideoDecoder;

        // Crop to the CENTER of the frame — where drawtext placed the
        // black-boxed frame number ("x=(w-tw)/2:y=(h-th)/2") — and take the
        // FULL (not sparsely sampled) pixel array there. A wrong frame from
        // B-frame reordering displacement shows a DIFFERENT number in that
        // exact box (large, unambiguous black/white swings), so this is far
        // more sensitive than sampling the whole frame's slowly-drifting
        // test pattern.
        function canvasSignature(source, srcW, srcH) {
            var cropW = Math.round(srcW * 0.34), cropH = Math.round(srcH * 0.34);
            var cropX = Math.round((srcW - cropW) / 2), cropY = Math.round((srcH - cropH) / 2);
            var c = document.createElement('canvas');
            c.width = 40; c.height = 40;
            var ctx = c.getContext('2d');
            ctx.drawImage(source, cropX, cropY, cropW, cropH, 0, 0, 40, 40);
            return ctx.getImageData(0, 0, 40, 40).data;
        }

        function sigDistance(a, b) {
            var n = Math.min(a.length, b.length);
            var sum = 0;
            for (var i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
            return sum / n;
        }

        const resp = await fetch('/tests/fixtures/bframes-test/bframes-test.mp4');
        const blob = await resp.blob();
        const file = new File([blob], 'bframes-test.mp4', { type: 'video/mp4' });

        const decoder = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
        await decoder.init(file);

        var results = [];
        for (var i = 0; i < numFrames; i++) {
            var decodedFrame = await decoder.getFrame(i);
            var decodedSig = decodedFrame ? canvasSignature(decodedFrame, 320, 240) : null;

            var pngName = '/tests/fixtures/bframes-test/frame_' + String(i + 1).padStart(3, '0') + '.png';
            var img = await new Promise(function (resolve, reject) {
                var im = new Image();
                im.onload = function () { resolve(im); };
                im.onerror = reject;
                im.src = pngName;
            });
            var groundTruthSig = canvasSignature(img, 320, 240);

            results.push({
                frameIndex: i,
                distance: decodedSig ? sigDistance(decodedSig, groundTruthSig) : Infinity,
            });
        }

        return {
            mbBackendActive: !!decoder._mbBackend,
            results: results,
        };
    }, NUM_FRAMES);

    check(r.mbBackendActive, 'mediabunny backend is active for this real B-frame video (not silently falling back)');

    // A correctly-decoded frame should match its own ground truth almost
    // exactly (small distance); a WRONG frame (from B-frame reordering
    // displacement) differs substantially because the test pattern +
    // frame-number overlay changes noticeably frame to frame.
    var THRESHOLD = 12;
    var mismatches = r.results.filter(function (x) { return x.distance > THRESHOLD; });
    console.log('  distances per frame:', JSON.stringify(r.results.map(function (x) { return Math.round(x.distance); })));
    check(mismatches.length === 0,
        `every one of ${NUM_FRAMES} frames decodes to its correct ground-truth content (${mismatches.length} mismatched: ${JSON.stringify(mismatches.map(function (m) { return m.frameIndex; }))})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
