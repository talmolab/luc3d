/**
 * html5-step-mid-frame.mjs — real-browser regression test for stepping when
 * this browser's WebCodecs cannot decode the video (Firefox 157 + HEVC).
 *
 * Two fixes, both in loading/video.js:
 *  1. `_initMediabunny` asks mediabunny's `track.canDecode()`
 *     (`VideoDecoder.isConfigSupported`) once and, on false, drops the backend
 *     (`_mbUnavailable = { reason: 'codec', … }`) instead of letting EVERY
 *     getFrame fail twice before the <video> fallback (1,544 warnings in one
 *     8-camera Firefox stepping run).
 *  2. `_getFrameHTML5` seeks to the frame's MIDDLE, `(i + 0.5) / fps`. A seek to
 *     the frame start sits on the boundary with i-1 and browsers round it either
 *     way — Firefox showed i-1 for every third frame, Chrome for most frames.
 *
 * Firefox is not drivable here, so this makes Chromium answer "cannot decode"
 * (`VideoDecoder.isConfigSupported` stubbed to `supported: false`, which is all
 * mediabunny's canDecode consults) and steps the REAL decoder through
 * tests/fixtures/barcode-60/barcode-60.mp4 — 60 fps, each frame's number
 * burned in as a barcode — forward, backward and by jumps, reading the number
 * back from every returned bitmap. A second decoder seeking to the frame START
 * is the negative control: it must land on the wrong frame in this browser
 * (measured headless: 19 of 58 right), or the test could not tell the two seek
 * targets apart. 60 fps matters — at 10 fps both targets land exactly.
 *
 * Run: node tests/e2e/html5-step-mid-frame.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8118);
const CLIP = 'tests/fixtures/barcode-60/barcode-60.mp4';
if (!fs.existsSync(path.join(repoRoot, CLIP))) {
    console.error(`  ✗ ${CLIP} is missing — regenerate it with tests/fixtures/barcode-60/make_fixture.sh`);
    process.exit(1);
}
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

    const r = await page.evaluate(async (CLIP) => {
        const { OnDemandVideoDecoder } = await import('/loading/video.js');
        const warnings = [];
        const origWarn = console.warn;
        console.warn = (...a) => { warnings.push(a.join(' ')); origWarn(...a); };

        // Bit i of the frame number is the 16 px block [16i, 16i+16): white = 1.
        const cv = document.createElement('canvas'); cv.width = 256; cv.height = 32;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        const frameNumber = (bmp) => {
            if (!bmp) return null;
            cx.drawImage(bmp, 0, 0);
            const d = cx.getImageData(0, 16, 256, 1).data;
            let v = 0;
            for (let i = 0; i < 16; i++) if (d[(8 + 16 * i) * 4] > 128) v |= 1 << i;
            return v;
        };

        const blob = await (await fetch('/' + CLIP)).blob();
        const file = new File([blob], 'barcode-60.mp4', { type: 'video/mp4' });

        // This browser's WebCodecs CAN decode H.264 — make it say it cannot, for
        // the whole run: mediabunny also asks before each decode, so a backend
        // that was kept fails every frame, exactly as in Firefox + HEVC.
        const origSupported = VideoDecoder.isConfigSupported;
        VideoDecoder.isConfigSupported = async (cfg) => ({ supported: false, config: cfg });
        try {
        const dec = new OnDemandVideoDecoder({ cacheSize: 200 });
        const ctl = new OnDemandVideoDecoder({ cacheSize: 200 });
        const warn0 = warnings.length;
        await dec.init(file); await ctl.init(file);
        ctl.html5SeekTime = (i) => i / ctl._fps;   // negative control: the old frame-START target

        const n = dec.samples.length;
        const order = {
            fwd: Array.from({ length: n - 2 }, (_, k) => k + 1),
            back: Array.from({ length: n - 2 }, (_, k) => n - 2 - k),
            jump: [37, 5, 52, 20, 44, 11, 29, 58, 2, 47, 14, 33],
        };
        const run = async (d) => {
            const out = {};
            for (const [k, frames] of Object.entries(order)) {
                for (const v of d.cache.values()) if (v && v.close) v.close();
                d.cache.clear();   // every request is a real seek, not an earlier pass's bitmap
                out[k] = [];
                for (const i of frames) out[k].push({ i, got: frameNumber(await d.getFrame(i)) });
            }
            return out;
        };
        const mid = await run(dec);
        const fallbackWarnings = warnings.slice(warn0).filter(w => /Mediabunny decode failed|falling back to HTML5|Step cursor failed/.test(w));
        const start = await run(ctl);
        return {
            backend: dec._mbBackend, unavailable: dec._mbUnavailable, fps: dec._fps, frames: n,
            seekTime5: typeof dec.html5SeekTime === 'function' ? dec.html5SeekTime(5) : null,
            mid, start, fallbackWarnings: fallbackWarnings.length,
        };
        } finally { VideoDecoder.isConfigSupported = origSupported; console.warn = origWarn; }
    }, CLIP);

    check(r.backend === null, 'backend dropped when WebCodecs cannot decode the track');
    check(r.unavailable && r.unavailable.reason === 'codec' && r.unavailable.codec === 'avc',
        `reason recorded (${JSON.stringify(r.unavailable)})`);
    check(r.frames === 60 && Math.abs(r.fps - 60) < 1e-6, `frame count and fps still adopted (${r.frames} frames @ ${r.fps})`);
    check(r.seekTime5 != null && Math.abs(r.seekTime5 - 5.5 / 60) < 1e-12, `seek target is the frame middle (frame 5 → ${r.seekTime5} s)`);
    check(r.fallbackWarnings === 0, `no per-frame "decode failed, falling back" warnings (${r.fallbackWarnings})`);
    for (const k of ['fwd', 'back', 'jump']) {
        const wrong = r.mid[k].filter(x => x.got !== x.i);
        check(wrong.length === 0, `${k}: every <video> step lands on the requested frame` +
            (wrong.length ? ` — wrong: ${JSON.stringify(wrong.slice(0, 8))}` : ` (${r.mid[k].length} steps)`));
    }
    const all = ['fwd', 'back', 'jump'].flatMap(k => r.start[k]);
    const ctlWrong = all.filter(x => x.got !== x.i);
    check(ctlWrong.length > 0, `negative control: seeking to the frame START lands wrong here ` +
        `(${ctlWrong.length} of ${all.length}, e.g. ${JSON.stringify(ctlWrong.slice(0, 3))})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
