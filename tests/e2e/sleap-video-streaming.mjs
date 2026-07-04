/**
 * sleap-video-streaming.mjs — real-browser test for the sleap-io.js video loader.
 *
 * This is the crash-fix proof: it loads a video through the SleapVideoDecoder in
 * headless Chromium and asserts the memory-safe behavior that fixes the "Aw Snap"
 * OOM when loading large / server-mounted videos:
 *
 *   1. It streams over HTTP Range (206) instead of downloading the whole file.
 *   2. It creates NO HTML5 <video> element (the thing that buffers whole files).
 *   3. It actually decodes a frame via WebCodecs (functional end-to-end).
 *
 * REQUIRES a Range-capable server — use server.py, NOT `python -m http.server`
 * (which ignores Range). The runner starts `python server.py <port>`.
 *
 *   BASE=http://localhost:8085 node tests/e2e/sleap-video-streaming.mjs
 *
 * Exit 0 = pass.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8085';
const VIDEO_URL = `${BASE}/sample_session/back.mp4`;

let failures = 0;
function check(cond, msg) { console.log((cond ? '    ✓ ' : '    ✗ ') + msg); if (!cond) failures++; }

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// Track network to the video: did we stream (206 / Range) rather than full-GET?
const videoResponses = [];        // { status, contentRange }
let sawRangeRequest = false;
let totalBytes = 0;
page.on('request', req => { if (req.url().includes('back.mp4') && req.headers()['range']) sawRangeRequest = true; });
page.on('response', async resp => {
    if (!resp.url().includes('back.mp4')) return;
    videoResponses.push({ status: resp.status(), contentRange: resp.headers()['content-range'] || null });
    const len = resp.headers()['content-length'];
    if (len) totalBytes += parseInt(len, 10);
});
page.on('pageerror', e => { console.log('    [pageerror] ' + e.message); });

console.log('  Loading app + waiting for sleap-io bridge…');
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.SleapIO && typeof window.SleapIO.loadVideo === 'function', null, { timeout: 15000 });

console.log('  Driving SleapVideoDecoder against a streamed URL…');
const result = await page.evaluate(async (url) => {
    const videosBefore = document.querySelectorAll('video').length;
    try {
        const mod = await import('/loading/sleap-video-adapter.js');
        const dec = new mod.SleapVideoDecoder({});
        await dec.init(url);
        const frameCount = dec.samples.length;
        const w = dec.videoTrack && dec.videoTrack.video ? dec.videoTrack.video.width : 0;
        const h = dec.videoTrack && dec.videoTrack.video ? dec.videoTrack.video.height : 0;
        let bmpW = 0, gotFrame = false;
        try {
            const bmp = await dec.getFrame(0);
            gotFrame = !!bmp;
            bmpW = bmp && bmp.width ? bmp.width : 0;
        } catch (e) { /* decode may be codec-limited in headless; report separately */ }
        const videosAfter = document.querySelectorAll('video').length;
        dec.close();
        return { ok: true, frameCount, w, h, gotFrame, bmpW, videosBefore, videosAfter, hasVideoEl: dec._videoEl !== null };
    } catch (e) {
        return { ok: false, error: String(e && e.message || e), videosBefore, videosAfter: document.querySelectorAll('video').length };
    }
}, VIDEO_URL);

console.log('  result:', JSON.stringify(result));
console.log('  video responses:', JSON.stringify(videoResponses.slice(0, 4)), 'totalBytes≈', totalBytes);

// --- Assertions ---
check(result.ok, 'SleapVideoDecoder.init() succeeded against a URL source');
if (result.ok) {
    check(result.frameCount > 0, `parsed a non-zero frame table (frameCount=${result.frameCount})`);
    check(result.w > 0 && result.h > 0, `read video dimensions (${result.w}x${result.h})`);
    check(result.videosAfter === result.videosBefore, `created NO HTML5 <video> element (before=${result.videosBefore}, after=${result.videosAfter})`);
    check(result.hasVideoEl === false, 'decoder._videoEl stayed null (no whole-file <video> preload)');
    check(result.gotFrame && result.bmpW > 0, `decoded frame 0 via WebCodecs (bitmap width=${result.bmpW})`);
}
// Streaming: at least one 206 partial-content response, or a Range request was issued.
const saw206 = videoResponses.some(r => r.status === 206 || r.contentRange);
check(saw206 || sawRangeRequest, `streamed via HTTP Range (206 seen=${saw206}, Range request=${sawRangeRequest})`);

await browser.close();
console.log(failures === 0 ? '\nPASS: sleap-io video loader streams and decodes without a <video> element.'
                           : `\nFAIL: ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
