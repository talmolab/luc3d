/**
 * image-keyframe-sampling.mjs — the image ID-switch check decodes ONE frame per
 * sample on recordings with dense keyframes (ui/image-embedder.js
 * `keyframeIndices` + pose/id-switch-check.js `planKeyframeSamples`), and the
 * pictures it gets that way are the same pictures.
 *
 * Two generated H.264 videos, 60 fps, P-frames only (no B-frames, like the
 * HEVC recordings this is for): keyframe every 30 frames (0.5 s) and one
 * keyframe only (as sparse as the field recordings' 250). The image samples are
 * the check's real ones at 60 fps: every 32nd frame. Asserted:
 *  1. keyframeIndices reads the keyframes from the packet index (0, 30, 60, …;
 *     just 0 for the sparse video).
 *  2. Dense: every sample moves to a keyframe ≤ 15 frames (0.25 s) away, and
 *     decoding the planned list runs the decoder on exactly ONE packet per
 *     sample — vs every frame since each sample's keyframe in place.
 *  3. A keyframe decoded alone is BIT-IDENTICAL (raw decoded planes) to the same
 *     frame decoded inside the full stream, so embeddings of it are too.
 *  4. Sparse: no sample moves — the decode list is exactly today's, which
 *     decodes every frame up to the last sample (the cost this removes).
 *
 * Needs ffmpeg (libx264); skipped with a note if absent.
 * Run: node tests/e2e/image-keyframe-sampling.mjs
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8276);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-keyframes-'));
const N = 600;   // 10 s at 60 fps
const make = (name, gop) => {
    const out = path.join(tmp, name);
    const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x256:rate=60',
        '-frames:v', String(N), '-c:v', 'libx264', '-bf', '0', '-g', String(gop), '-keyint_min', String(gop),
        '-sc_threshold', '0', '-pix_fmt', 'yuv420p', out]);
    return r.status === 0 && fs.existsSync(out) ? out : null;
};
const dense = make('dense.mp4', 30), sparse = make('sparse.mp4', 1000);
if (!dense || !sparse) {
    console.log('  (ffmpeg with libx264 unavailable — skipped)');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.SleapIO && window.SleapIO.MediaBunnyVideoBackend, { timeout: 20000 });
    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__vid';
        document.body.appendChild(inp);
        // count packets handed to any VideoDecoder (mediabunny decodes through WebCodecs)
        window.__decoded = 0;
        const orig = VideoDecoder.prototype.decode;
        VideoDecoder.prototype.decode = function (chunk) { window.__decoded++; return orig.call(this, chunk); };
    });

    const run = async (file) => {
        await page.setInputFiles('#__vid', file);
        return page.evaluate(async (N) => {
            const file = document.getElementById('__vid').files[0];
            const E = await import('./ui/image-embedder.js');
            const SC = await import('./pose/id-switch-check.js');
            const be = await window.SleapIO.MediaBunnyVideoBackend.fromBlob(file, file.name, {});
            const kf = await E.keyframeIndices({ _mbBackend: be });
            const frames = []; for (let f = 0; f < N; f += 32) frames.push(f);
            const plan = SC.planKeyframeSamples(frames, kf);
            // decode a list of frames with the same call the image check streams through; raw planes per frame
            const decodeList = async (list) => {
                window.__decoded = 0;
                const out = [];
                for await (const s of be.sink.samplesAtTimestamps(list.map(f => be._frameTimes[f]))) {
                    const vf = s.toVideoFrame(); s.close();
                    const buf = new Uint8Array(vf.allocationSize()); await vf.copyTo(buf); vf.close();
                    out.push(buf);
                }
                return { out, decoded: window.__decoded };
            };
            const planned = await decodeList(plan.decode);
            const inPlace = await decodeList(frames);
            // the same keyframes, decoded inside a stream of EVERY frame
            const all = []; for (let f = 0; f <= plan.decode[plan.decode.length - 1]; f++) all.push(f);
            const stream = await decodeList(all);
            let identical = 0, compared = 0;
            plan.decode.forEach((f, i) => {
                const a = planned.out[i], b = stream.out[f];
                compared++;
                if (a && b && a.length === b.length && a.every((v, j) => v === b[j])) identical++;
            });
            be.close();
            return { kf: Array.from(kf), frames, decode: plan.decode, snapped: plan.snapped,
                maxMove: Math.max(...plan.decode.map((f, i) => Math.abs(f - frames[i]))),
                plannedDecoded: planned.decoded, inPlaceDecoded: inPlace.decoded, identical, compared };
        }, N);
    };

    console.log('\n• keyframe every 30 frames (0.5 s at 60 fps)');
    const d = await run(dense);
    check(d.kf.length === N / 30 && d.kf.every((f, i) => f === 30 * i), `keyframes read from the packet index: ${d.kf.slice(0, 4).join(', ')}, … (${d.kf.length})`);
    check(d.snapped === d.frames.length, `every sample moved to a keyframe (${d.snapped}/${d.frames.length})`);
    check(d.maxMove <= 15, `largest move ${d.maxMove} frames (≤ 15 = 0.25 s)`);
    check(d.plannedDecoded === d.frames.length, `planned list: one decoded packet per sample (${d.plannedDecoded} for ${d.frames.length} samples)`);
    const sinceKey = d.frames.reduce((a, f) => a + (f % 30) + 1, 0);
    check(d.inPlaceDecoded === sinceKey, `in place each sample costs every frame since its keyframe (${d.inPlaceDecoded} packets, expected ${sinceKey})`);
    check(d.identical === d.compared, `a keyframe decoded alone is bit-identical to it decoded mid-stream (${d.identical}/${d.compared})`);

    console.log('\n• one keyframe (sparse, like the recordings\' every 250 frames)');
    const s = await run(sparse);
    check(s.kf.length === 1 && s.kf[0] === 0, `keyframes: ${s.kf.join(', ')}`);
    check(s.snapped === 0 && s.decode.every((f, i) => f === s.frames[i]), 'no sample moves: decode list is exactly today\'s');
    const last = s.frames[s.frames.length - 1];
    check(s.inPlaceDecoded === last + 1, `…which decodes every frame up to the last sample (${s.inPlaceDecoded} packets for frames 0–${last})`);
} finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
