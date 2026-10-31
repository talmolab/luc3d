/**
 * fragmented-mp4-load.mjs — real-browser regression test: a FRAGMENTED MP4
 * loads whole.
 *
 * campy writes fragmented MP4 by default (`-movflags
 * +frag_keyframe+empty_moov+delay_moov+default_base_moof -frag_duration
 * 1000000`), so a crash leaves the file readable up to its last fragment. Such
 * a file lists its samples in the fragments (`moof`/`trun`), not in the moov,
 * and its moov says duration 0. `_initMp4box` (loading/video.js) stopped
 * appending chunks at mp4box's `onReady`, which fires on the moov, so it
 * counted only the fragments in the first 1 MiB: a rig check's 1,200-frame,
 * 60 fps calibration video loaded as 420 frames at 21 fps (420 / the <video>
 * element's 20 s) in HTML5 mode. With mediabunny (the default) the frame count
 * was right, but `videoTrack.duration` was 0, so `updateTotalFrames` set
 * `state.fps` to its 30 fallback.
 *
 * Fixed by reading every fragment when the file is fragmented (jumping over
 * large mdat payloads) and taking the fps from the sample durations.
 *
 * The clip, tests/fixtures/fragmented-60/fragmented-60.mp4, is 1,200 frames at
 * 60 fps written with campy's muxer flags, each frame's number burned in as a
 * barcode. It is only 48 KB, so the test shrinks `CHUNK_SIZE` to 4 KB to put
 * most fragments past the first chunk, as a real recording's are past 1 MiB,
 * and `FRAGMENT_PROBE_SIZE` so the mdat-skipping path runs too.
 *
 * A copy cut off mid-fragment, as a crash leaves it, must count only the frames
 * whose bytes are in the file. And mp4box must not keep the media it was
 * handed: told to keep it (`createFile()`'s default) it held all 300 MB of a
 * 30-min recording.
 *
 * RIG_VIDEO=<path> also loads that file (e.g. campy's 0-calibration.mp4, which
 * is HEVC — needs CHANNEL=chrome) at the real chunk size and expects
 * RIG_FRAMES (default 1200) frames at RIG_FPS (default 60).
 *
 * Run: node tests/e2e/fragmented-mp4-load.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8131);
const CLIP = 'tests/fixtures/fragmented-60/fragmented-60.mp4';
const REGULAR = 'tests/fixtures/barcode-60/barcode-60.mp4';
for (const f of [CLIP, REGULAR]) {
    if (!fs.existsSync(path.join(repoRoot, f))) {
        console.error(`  ✗ ${f} is missing — regenerate it with ${path.dirname(f)}/make_fixture.sh`);
        process.exit(1);
    }
}
const RIG = process.env.RIG_VIDEO || '';
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch({ channel: process.env.CHANNEL || undefined });
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    if (RIG) {
        const body = fs.readFileSync(RIG);
        await page.route('**/__rig.mp4', route => route.fulfill({ status: 200, contentType: 'video/mp4', body }));
    }
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });

    // One load. `opts.backend` is 'html5' or 'mediabunny'; `chunk`/`probe`
    // shrink the read sizes; `frames` are read back by barcode.
    const load = (url, opts) => page.evaluate(async ({ url, opts }) => {
        window.LUCID_VIDEO_BACKEND = opts.backend;
        try {
            const { OnDemandVideoDecoder } = await import('/loading/video.js');
            const { updateTotalFrames } = await import('/loading/session-loader.js');
            const st = window.__lucid.state;
            const full = await (await fetch(url)).blob();
            const blob = opts.truncate ? full.slice(0, opts.truncate) : full;
            const file = new File([blob], url.split('/').pop(), { type: 'video/mp4' });
            const d = new OnDemandVideoDecoder({ cacheSize: 50 });
            if (opts.chunk) d.CHUNK_SIZE = opts.chunk;
            if (opts.probe) d.FRAGMENT_PROBE_SIZE = opts.probe;
            let bytes = 0, skips = 0, fragmentSteps = 0, held = 0;
            const rc = d.readChunk.bind(d);
            d.readChunk = async (o, n) => {
                // What mp4box still holds from earlier appends (it keeps every
                // media byte unless told to discard them).
                const st = d.mp4boxFile && d.mp4boxFile.stream;
                if (st && st.buffers) held = Math.max(held, st.buffers.reduce((a, b) => a + b.byteLength, 0));
                bytes += Math.min(n, file.size - o); return rc(o, n);
            };
            if (typeof d._nextFragmentOffset === 'function') {
                const nf = d._nextFragmentOffset.bind(d);
                d._nextFragmentOffset = (o) => {
                    fragmentSteps++;
                    const r = nf(o); if (r !== o) skips++; return r;
                };
            }
            await d.init(file);

            // What the app's fps readers compute from this decoder
            // (updateTotalFrames; playback's nativeFps uses the same formula).
            const saved = { views: st.views, totalFrames: st.totalFrames, fps: st.fps };
            st.views = [{ name: 'probe', decoder: d }];
            updateTotalFrames();
            const appFps = st.fps, appFrames = st.totalFrames;
            st.views = saved.views;
            updateTotalFrames();
            st.totalFrames = saved.totalFrames; st.fps = saved.fps;

            // Bit i of the frame number is the 16 px block [16i, 16i+16): white = 1.
            const cv = document.createElement('canvas'); cv.width = 176; cv.height = 16;
            const cx = cv.getContext('2d', { willReadFrequently: true });
            const frameNumber = (bmp) => {
                if (!bmp) return null;
                cx.drawImage(bmp, 0, 0);
                const px = cx.getImageData(0, 8, 176, 1).data;
                let v = 0;
                for (let i = 0; i < 11; i++) if (px[(8 + 16 * i) * 4] > 128) v |= 1 << i;
                return v;
            };
            const got = [];
            for (const i of (opts.frames || [])) got.push({ i, got: frameNumber(await d.getFrame(i)) });

            const kf = d.keyframeIndices;
            const out = {
                frames: d.samples.length, fps: d._fps, appFps, appFrames,
                trackSeconds: d.videoTrack && d.videoTrack.timescale ? d.videoTrack.duration / d.videoTrack.timescale : null,
                lastKeyframe: kf.length ? kf[kf.length - 1] : null, mediabunny: !!d._mbBackend,
                bytes, size: file.size, skips, fragmentSteps, held, got,
            };
            d.close();
            return out;
        } catch (e) {
            return { error: String(e && e.message || e) };
        } finally {
            delete window.LUCID_VIDEO_BACKEND;
        }
    }, { url, opts });

    const FRAMES = [0, 1, 299, 600, 1100, 1199];

    console.log('HTML5 mode (the mp4box pass alone sets the frame count and fps):');
    const h = await load('/' + CLIP, { backend: 'html5', chunk: 4096, probe: 256, frames: FRAMES });
    check(!h.error, 'loads' + (h.error ? ': ' + h.error : ''));
    check(h.frames === 1200, `all 1,200 frames counted (got ${h.frames})`);
    check(near(h.fps, 60, 0.01), `fps 60 from the sample durations (got ${h.fps})`);
    check(near(h.trackSeconds, 20, 1e-6), `videoTrack spans the samples' 20 s (got ${h.trackSeconds})`);
    check(near(h.appFps, 60, 0.01) && h.appFrames === 1200,
        `updateTotalFrames: state.fps ${h.appFps}, state.totalFrames ${h.appFrames}`);
    check(h.lastKeyframe >= 1140, `keyframe estimates reach the end (last ${h.lastKeyframe})`);
    check(h.skips > 0 && h.bytes < h.size, `mdat payloads skipped: read ${h.bytes} of ${h.size} bytes in ${h.skips} jumps`);
    check(h.held <= 4096, `mp4box holds no earlier chunk between reads (at most ${h.held} bytes)`);
    const hWrong = (h.got || []).filter(x => x.got !== x.i);
    check(h.got && hWrong.length === 0, 'frames past the first chunk decode as themselves' +
        (hWrong.length ? ` — wrong: ${JSON.stringify(hWrong)}` : ` (${FRAMES.join(', ')})`));

    // Fragments bigger than a chunk: every jump is followed by a small probe
    // read, as on a high-bitrate recording.
    const p = await load('/' + CLIP, { backend: 'html5', chunk: 512, probe: 256 });
    check(p.frames === 1200 && near(p.fps, 60, 0.01) && p.skips > 0,
        `with probe reads after long jumps: ${p.frames} frames @ ${p.fps} (${p.skips} jumps, ${p.bytes} of ${p.size} bytes)`);

    // A recording cut off mid-write: the last moof lists frames whose bytes are
    // not in the file. ffprobe decodes 1,165 frames of the first 46,000 bytes
    // (both demuxers listed 1,182). mediabunny decodes the last one; the
    // <video> element itself shows 1,160 for 1,162-1,164 (the cut B-frame
    // tail), so HTML5 mode reads back a frame short of the end.
    for (const backend of ['html5', 'mediabunny']) {
        const last = backend === 'html5' ? 1100 : 1164;
        const t = await load('/' + CLIP, { backend, chunk: 4096, probe: 256, truncate: 46000, frames: [0, last] });
        const tWrong = (t.got || []).filter(x => x.got !== x.i);
        check(t.frames === 1165 && near(t.fps, 60, 0.01) && near(t.appFps, 60, 0.01) && t.got && tWrong.length === 0,
            `${backend}, file cut at 46,000 bytes: ${t.frames} frames (want 1,165, what ffprobe decodes) @ ${t.fps}, ` +
            `state.fps ${t.appFps}` + (tWrong.length ? ` — wrong: ${JSON.stringify(tWrong)}` : `, frame ${last} decodes`));
    }

    console.log('Default mode (mediabunny):');
    const m = await load('/' + CLIP, { backend: 'mediabunny', chunk: 4096, probe: 256, frames: FRAMES });
    check(!m.error && m.mediabunny, 'loads with the mediabunny backend' + (m.error ? ': ' + m.error : ''));
    check(m.frames === 1200 && near(m.fps, 60, 0.01), `1,200 frames @ 60 fps (got ${m.frames} @ ${m.fps})`);
    check(near(m.appFps, 60, 0.01), `updateTotalFrames: state.fps 60, not the 30 fallback (got ${m.appFps})`);
    const mWrong = (m.got || []).filter(x => x.got !== x.i);
    check(m.got && mWrong.length === 0, 'frames decode as themselves' +
        (mWrong.length ? ` — wrong: ${JSON.stringify(mWrong)}` : ''));

    console.log('A regular (moov) MP4 is scanned as before:');
    const r = await load('/' + REGULAR, { backend: 'html5', chunk: 1024 });
    check(r.frames === 60 && near(r.fps, 60, 0.01), `60 frames @ 60 fps (got ${r.frames} @ ${r.fps})`);
    check(r.fragmentSteps === 0, `no fragment scan (${r.fragmentSteps} steps)`);

    if (RIG) {
        const wantFrames = Number(process.env.RIG_FRAMES || 1200), wantFps = Number(process.env.RIG_FPS || 60);
        for (const backend of ['html5', 'mediabunny']) {
            console.log(`RIG_VIDEO ${path.basename(RIG)} (${backend}):`);
            const g = await load('/__rig.mp4', { backend });
            check(!g.error, 'loads' + (g.error ? ': ' + g.error : ''));
            check(g.frames === wantFrames && near(g.fps, wantFps, 0.01) && near(g.appFps, wantFps, 0.01),
                `${g.frames} frames @ ${g.fps} fps, state.fps ${g.appFps} (want ${wantFrames} @ ${wantFps}); read ${g.bytes} of ${g.size} bytes`);
        }
    }

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
