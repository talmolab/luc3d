/**
 * image-unreferenced-skip.mjs — the image ID-switch check's streaming reader
 * does not decode the frames no other frame is predicted from, unless one is a
 * sample (ui/image-embedder.js `unreferencedSkipper` / `skippingSamples`), and the
 * samples it decodes that way are the very same pictures.
 *
 * Generated 640-frame videos with a keyframe every 250 frames, like the SLAP
 * recordings: H.264 with B-frames and no B-pyramid (every B-frame unreferenced),
 * H.264 with a B-pyramid (some B-frames are references and must be decoded),
 * H.264 with no B-frames (nothing to skip), and HEVC from libx265's defaults
 * (open GOP, B-frames — what the SLAP recordings use) when real Chrome and
 * libx265 are there. For each, three sample lists — every 15th frame (the
 * check's 2 Hz at 30 fps), frames around each keyframe (open-GOP leading
 * pictures), and every frame of a stretch — are decoded with mediabunny's plain
 * `samplesAtTimestamps` and with `skippingSamples`. Asserted:
 *  1. Every sample's raw decoded planes are bit-identical.
 *  2. B-frame videos: fewer packets reach the decoder (the skipped ones are
 *     counted); no B-frames: nothing is skipped.
 *  3. `window.LUCID_IMAGE_SKIP_UNREFERENCED = 0` turns it off (no skipper).
 *
 * Needs ffmpeg (libx264); skipped with a note if absent.
 * Run: node tests/e2e/image-unreferenced-skip.mjs
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8278);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-unref-'));
const N = 640;
const make = (name, enc) => {
    const out = path.join(tmp, name);
    const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x256:rate=30',
        '-frames:v', String(N), ...enc, '-pix_fmt', 'yuv420p', out]);
    return r.status === 0 && fs.existsSync(out) ? out : null;
};
const GOP = ['-g', '250', '-keyint_min', '250', '-sc_threshold', '0'];
const flat = make('b-flat.mp4', ['-c:v', 'libx264', '-bf', '3', '-b_strategy', '0', '-x264-params', 'b-pyramid=none', ...GOP]);
const pyramid = make('b-pyramid.mp4', ['-c:v', 'libx264', '-bf', '3', '-b_strategy', '0', '-x264-params', 'b-pyramid=normal', ...GOP]);
const ponly = make('p-only.mp4', ['-c:v', 'libx264', '-bf', '0', ...GOP]);
const hevc = make('hevc.mp4', ['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error:keyint=250:min-keyint=250:scenecut=0']);
if (!flat || !pyramid || !ponly) {
    console.log('  (ffmpeg with libx264 unavailable — skipped)');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const open = async (browser) => {
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.SleapIO && window.SleapIO.MediaBunnyVideoBackend, { timeout: 20000 });
    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__vid';
        document.body.appendChild(inp);
        window.__decoded = 0;   // packets handed to any VideoDecoder
        const orig = VideoDecoder.prototype.decode;
        VideoDecoder.prototype.decode = function (chunk) { window.__decoded++; return orig.call(this, chunk); };
    });
    return page;
};
const run = async (page, file) => {
    await page.setInputFiles('#__vid', file);
    return page.evaluate(async () => {
        const file = document.getElementById('__vid').files[0];
        const E = await import('./ui/image-embedder.js');
        const be = await window.SleapIO.MediaBunnyVideoBackend.fromBlob(file, file.name, {});
        const dec = { _mbBackend: be };
        const skipper = await E.unreferencedSkipper(dec);
        const kf = Array.from(await E.keyframeIndices(dec)), n = be._frameTimes.length;
        const lists = {
            'every 15th frame': Array.from({ length: Math.floor(n / 15) }, (v, i) => 15 * i),
            'around each keyframe': kf.filter(k => k > 0).flatMap(k => Array.from({ length: 10 }, (v, i) => k - 5 + i)).filter(f => f < n),
            'every frame of 290–339': Array.from({ length: 50 }, (v, i) => 290 + i),
        };
        const planes = async (it) => {
            const out = [];
            for await (const s of it) {
                if (!s) { out.push(null); continue; }
                const vf = s.toVideoFrame(); s.close();
                const b = new Uint8Array(vf.allocationSize()); await vf.copyTo(b); out.push({ t: vf.timestamp, b }); vf.close();
            }
            return out;
        };
        const res = [];
        for (const [name, frames] of Object.entries(lists)) {
            const ts = frames.map(f => be._frameTimes[f]);
            window.__decoded = 0;
            const a = await planes(be.sink.samplesAtTimestamps(ts));
            const plain = window.__decoded, count = { skipped: 0 };
            window.__decoded = 0;
            const b = skipper ? await planes(E.skippingSamples(skipper, ts, count)) : [];
            let same = 0;
            a.forEach((x, i) => { const y = b[i]; if (x && y && x.t === y.t && x.b.length === y.b.length && x.b.every((v, j) => v === y.b[j])) same++; });
            res.push({ name, n: frames.length, got: a.filter(Boolean).length, same, plain, skipping: window.__decoded, skipped: count.skipped });
        }
        window.LUCID_IMAGE_SKIP_UNREFERENCED = 0;
        const off = await E.unreferencedSkipper({ _mbBackend: await window.SleapIO.MediaBunnyVideoBackend.fromBlob(file, file.name, {}) });
        delete window.LUCID_IMAGE_SKIP_UNREFERENCED;
        be.close();
        return { fmt: skipper && skipper.fmt, kf, res, off };
    });
};
const report = (r, expectSkips) => {
    check(!!r.fmt, `read the stream's reference format: ${JSON.stringify(r.fmt)} (keyframes ${r.kf.join(', ')})`);
    for (const x of r.res) {
        check(x.got === x.n && x.same === x.n, `${x.name}: all ${x.n} samples bit-identical with and without skipping (${x.same})`);
        // (>=: mediabunny itself drops the leading pictures of an open-GOP keyframe a decoder starts on; skipped first here)
        if (expectSkips) check(x.skipped > 0 && x.skipping < x.plain && x.skipping + x.skipped >= x.plain,
            `…${x.skipped} unreferenced frames not decoded: ${x.skipping} packets decoded instead of ${x.plain}`);
        else check(x.skipped === 0 && x.skipping === x.plain, `…nothing to skip: ${x.skipping} packets either way`);
    }
};

let browser;
try {
    browser = await chromium.launch();
    const page = await open(browser);
    console.log('\n• H.264, B-frames, no B-pyramid (every B-frame unreferenced)');
    const rf = await run(page, flat);
    report(rf, true);
    const fFlat = rf.res[0];
    check(fFlat.skipping < 0.5 * fFlat.plain, `every 15th frame: under half the packets decoded (${fFlat.skipping} of ${fFlat.plain})`);
    check(rf.off === null, 'LUCID_IMAGE_SKIP_UNREFERENCED = 0: no skipper (every frame decoded)');
    console.log('\n• H.264, B-pyramid (the middle B-frame is a reference)');
    report(await run(page, pyramid), true);
    console.log('\n• H.264, no B-frames');
    report(await run(page, ponly), false);
    await browser.close(); browser = null;

    console.log('\n• HEVC, libx265 defaults (open GOP, B-frames — the SLAP recordings\' encoder)');
    if (!hevc) console.log('  (ffmpeg without libx265 — skipped)');
    else {
        try { browser = await chromium.launch({ channel: 'chrome' }); } catch (e) { browser = null; }
        if (!browser) console.log('  (Google Chrome not installed — HEVC needs it; skipped)');
        else {
            const p2 = await open(browser);
            const ok = await p2.evaluate(async () => (await VideoDecoder.isConfigSupported({ codec: 'hvc1.1.6.L93.90', codedWidth: 320, codedHeight: 256 })).supported);
            if (!ok) console.log('  (this Chrome cannot decode HEVC — skipped)');
            else report(await run(p2, hevc), true);
        }
    }
} finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
