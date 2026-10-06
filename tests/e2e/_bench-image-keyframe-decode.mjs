/**
 * _bench-image-keyframe-decode.mjs — decode cost of the image ID-switch check's
 * samples, as today (each sample decoded where it is) vs moved to keyframes
 * (pose/id-switch-check.js `planKeyframeSamples`), for each camera of a session
 * decoded CONCURRENTLY — the way the check streams them.
 *
 * Per folder of .mp4s (one per camera): every camera's samples are the check's at
 * 60 fps (every 32nd frame); each mode decodes them all through mediabunny's
 * `samplesAtTimestamps` (the call `streamingReader` uses) and turns every sample
 * into a VideoFrame, as the check does. Reports wall time, samples/s over all
 * cameras, and packets handed to the decoder. Runs each mode REPEAT times,
 * alternating.
 *
 * Not a test (needs HEVC: real Google Chrome, headed). Usage:
 *     DIRS=<dir>[,<dir>…] node tests/e2e/_bench-image-keyframe-decode.mjs
 *   env: REPEAT=2  STEP=32  PORT=8132
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acquireBrowserLock } from '../../scripts/browser-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const DIRS = (process.env.DIRS || '').split(',').filter(Boolean);
const REPEAT = Number(process.env.REPEAT || 2), STEP = Number(process.env.STEP || 32), PORT = Number(process.env.PORT || 8132);
if (!DIRS.length) { console.error('set DIRS'); process.exit(2); }
const log = (m) => process.stdout.write(m + '\n');

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
// a visible browser window: one such run at a time across sessions (scripts/browser-lock.mjs)
const releaseBrowserLock = await acquireBrowserLock({ label: '_bench-image-keyframe-decode' });
let browser;
const results = [];
try {
    browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--window-size=900,600'] });
    const page = await browser.newPage();
    page.on('pageerror', e => log('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.SleapIO && window.SleapIO.MediaBunnyVideoBackend, null, { timeout: 30000 });
    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.id = '__vids'; document.body.appendChild(inp);
        window.__decoded = 0;
        const orig = VideoDecoder.prototype.decode;
        VideoDecoder.prototype.decode = function (c) { window.__decoded++; return orig.call(this, c); };
    });
    for (const dir of DIRS) {
        const files = fs.readdirSync(dir).filter(f => /\.mp4$/i.test(f)).sort().map(f => path.join(dir, f));
        await page.setInputFiles('#__vids', files);
        const setup = await page.evaluate(async (STEP) => {
            const E = await import('./ui/image-embedder.js');
            const SC = await import('./pose/id-switch-check.js');
            window.__cams = [];
            for (const file of document.getElementById('__vids').files) {
                const be = await window.SleapIO.MediaBunnyVideoBackend.fromBlob(file, file.name, {});
                const kf = await E.keyframeIndices({ _mbBackend: be });
                const frames = []; for (let f = 0; f < be.frameCount; f += STEP) frames.push(f);
                const plan = SC.planKeyframeSamples(frames, kf);
                window.__cams.push({ be, frames, plan });
            }
            return window.__cams.map(c => ({ frames: c.frames.length, n: c.be.frameCount, kfGap: c.plan.keyframeGap, snapped: c.plan.snapped }));
        }, STEP);
        log(`\n• ${dir}: ${setup.length} cameras, ${setup[0].n} frames each, ${setup[0].frames} samples/camera, ` +
            `keyframe gap ${setup.map(s => s.kfGap).join('/')}, samples moved ${setup.map(s => s.snapped).join('/')}`);
        const modes = ['inplace', 'planned'];
        for (let rep = 0; rep < REPEAT; rep++) {
            for (const mode of (rep % 2 ? modes.slice().reverse() : modes)) {
                const r = await page.evaluate(async (mode) => {
                    window.__decoded = 0;
                    const t0 = performance.now();
                    let samples = 0;
                    await Promise.all(window.__cams.map(async (c) => {
                        const list = mode === 'planned' ? c.plan.decode : c.frames;
                        for await (const s of c.be.sink.samplesAtTimestamps(list.map(f => c.be._frameTimes[f]))) {
                            if (!s) continue;
                            const vf = s.toVideoFrame(); s.close(); vf.close(); samples++;
                        }
                    }));
                    const ms = performance.now() - t0;
                    return { mode, ms, samples, decoded: window.__decoded };
                }, mode);
                const row = { dir: path.basename(dir), ...r, samplesPerS: r.samples / (r.ms / 1000), decodedPerS: r.decoded / (r.ms / 1000) };
                results.push(row);
                log(`  ${mode.padEnd(8)} ${(r.ms / 1000).toFixed(2).padStart(6)} s  ${r.samples} samples  ${row.samplesPerS.toFixed(0).padStart(5)} samples/s  ` +
                    `${r.decoded} packets decoded (${row.decodedPerS.toFixed(0)}/s)`);
            }
        }
        if (setup.some(s => s.snapped > 0)) {
            // the pictures: each camera's first 12 planned keyframes decoded alone vs inside a stream of every frame
            const bit = await page.evaluate(async () => {
                const raw = async (be, list) => {
                    const out = [];
                    for await (const s of be.sink.samplesAtTimestamps(list.map(f => be._frameTimes[f]))) {
                        const vf = s.toVideoFrame(); s.close();
                        const b = new Uint8Array(vf.allocationSize()); await vf.copyTo(b); vf.close(); out.push(b);
                    }
                    return out;
                };
                const frames = async (be, list) => {
                    const out = [];
                    for await (const s of be.sink.samplesAtTimestamps(list.map(f => be._frameTimes[f]))) { out.push(s.toVideoFrame()); s.close(); }
                    return out;
                };
                let same = 0, n = 0;
                for (const c of window.__cams) {
                    const kfs = c.plan.decode.slice(0, 12);
                    const alone = await raw(c.be, kfs);
                    const all = []; for (let f = 0; f <= kfs[kfs.length - 1]; f++) all.push(f);
                    const stream = await raw(c.be, all);
                    kfs.forEach((f, i) => { n++; const a = alone[i], b = stream[f]; if (a.length === b.length && a.every((v, j) => v === b[j])) same++; });
                }
                // embeddings with the real model: the same crop (a fixed square mid-frame) of each of the first
                // camera's keyframes, decoded alone vs mid-stream, embedded as two identical batches
                const E = await import('./ui/image-embedder.js');
                const { T, model } = await E.loadImageModel();
                const c = window.__cams[0], kfs = c.plan.decode.slice(0, 12);
                const all = []; for (let f = 0; f <= kfs[kfs.length - 1]; f++) all.push(f);
                const A = await frames(c.be, kfs), Sall = await frames(c.be, all), B = kfs.map(f => Sall[f]);
                const W = A[0].displayWidth, H = A[0].displayHeight, L = 120;
                const g = { cx: W / 2, cy: H / 2, angle: 0.3, scale: E.CROP / (1.3 * L), L,
                    hull: [[W / 2 - 50, H / 2 - 30], [W / 2 + 50, H / 2 - 30], [W / 2 + 50, H / 2 + 30], [W / 2 - 50, H / 2 + 30]] };
                const SZ = 3 * E.INPUT * E.INPUT;
                const embed = async (vfs) => {
                    const data = new Float32Array(vfs.length * SZ);
                    vfs.forEach((vf, i) => E.writeInputTensor(E.cutCrop(vf, g, []), data, i * SZ));
                    const res = await model({ pixel_values: new T.Tensor('float32', data, [vfs.length, 3, E.INPUT, E.INPUT]) });
                    const t = res.last_hidden_state, d = t.ort_tensor && t.ort_tensor.location === 'gpu-buffer' ? await t.ort_tensor.getData() : t.data;
                    return Float32Array.from(d, Number);
                };
                const ea = await embed(A), eb = await embed(B);
                let maxDiff = 0; for (let i = 0; i < ea.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ea[i] - eb[i]));
                Sall.forEach(v => v.close()); A.forEach(v => v.close());
                return { same, n, embN: kfs.length, maxDiff, embLen: ea.length };
            });
            log(`  keyframe decoded alone vs mid-stream: ${bit.same}/${bit.n} bit-identical (raw decoded planes); ` +
                `embeddings of ${bit.embN} crops: max |difference| ${bit.maxDiff} over ${bit.embLen} values`);
        }
        await page.evaluate(() => { window.__cams.forEach(c => c.be.close()); window.__cams = []; });
    }
} finally {
    fs.mkdirSync(path.join(repoRoot, 'verify', 'keyframe-snap'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'verify', 'keyframe-snap', 'decode-bench-' + Date.now() + '.json'), JSON.stringify(results, null, 1));
    if (browser) await browser.close().catch(() => {});
    await releaseBrowserLock();
    server.kill();
}
