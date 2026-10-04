/**
 * image-decode-worker.mjs — the image ID-switch check's per-camera decode
 * workers (ui/image-decode-worker.js, via ui/image-embedder.js
 * `createDecodeWorkers`).
 *
 * A worker opens the camera's video file itself, stream-decodes the check's
 * frames and cuts the crops, so the result must equal cropping the SAME frames
 * on the main thread. On the committed B-frame fixture (where decode order !=
 * presentation order, the case the frame-index patch exists for), asserted:
 *  1. Worker crops == the main-thread path's crops (frames streamed with
 *     `samplesAtTimestamps`, as the check does without workers), bit for bit, at
 *     frames spread through the file (including frames skipped between requests).
 *  2. A view needing no crop at a frame is simply not asked; the stream still
 *     advances correctly past it.
 *  3. Asking for a frame behind the stream rejects (with a message) instead of
 *     returning the wrong frame.
 *  4. `LUCID_DECODE_WORKERS = 0`, or a decoder without a local file, -> null (the
 *     caller decodes on the main thread).
 *
 * Run: node tests/e2e/image-decode-worker.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8279);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.SleapIO, { timeout: 20000 });

    const r = await page.evaluate(async () => {
        const V = await import('/loading/video.js'); const E = await import('/ui/image-embedder.js');
        const blob = await (await fetch('/tests/fixtures/bframes-test/bframes-test.mp4')).blob();
        const file = new File([blob], 'bframes-test.mp4', { type: 'video/mp4' });
        const decoder = new V.OnDemandVideoDecoder({ cacheSize: 4, lookahead: 0 }); await decoder.init(file);
        const W = decoder._mbBackend.width || 320, H = decoder._mbBackend.height || 240;
        const sk = { nose: 0, tti: 3, body: [0, 1, 2, 3, 4, 5, 6] };
        const geo = (cx, cy, h) => {
            const t = [[45, 0], [25, -11], [25, 11], [-40, 0], [30, 0], [-5, 0], [10, 12]];
            const pts = t.map(([x, y]) => [cx + 0.6 * (Math.cos(h) * x - Math.sin(h) * y), cy + 0.6 * (Math.sin(h) * x + Math.cos(h) * y)]);
            return E.cropGeometry({ getPoint: i => pts[i] || null }, sk);
        };
        const g1 = geo(W * 0.35, H * 0.5, 0.4), g2 = geo(W * 0.65, H * 0.45, 2.2);
        const crops = [{ g: g1, others: [g2.hull] }, { g: g2, others: [g1.hull] }];
        const frames = [1, 4, 5, 9, 14, 20, 27];                    // spread, with gaps the stream must decode through
        const SZ = 3 * E.INPUT * E.INPUT, canvas = new OffscreenCanvas(E.CROP, E.CROP);
        // the main-thread path the check uses without workers: stream VideoFrames (samplesAtTimestamps) and crop them
        // (NOT decoder.getFrame: that can hand back a cached ImageBitmap, which is colour-converted differently)
        const be = decoder._mbBackend, ref = new Map();
        for await (const smp of be.sink.samplesAtTimestamps(frames.map(f => be._frameTimes[f]))) {
            const f = frames[ref.size], vf = smp.toVideoFrame(); smp.close();
            ref.set(f, crops.map(c => { const t = new Float32Array(SZ); E.writeInputTensor(E.cutCrop(vf, c.g, c.others, canvas), t, 0); return t; }));
            vf.close();
        }
        const inline = async (f) => ref.get(f);
        const same = (a, b) => a.length === b.length && a.every((t, i) => t.length === b[i].length && t.every((v, k) => Object.is(v, b[i][k])));
        const views = [{ name: 'cam', decoder }];
        const dec = await E.createDecodeWorkers(views, frames);
        const out = { opened: !!dec, perFrame: [], skipOk: null, behindMsg: null };
        for (const f of frames) {
            if (f === 9) { out.skipOk = true; continue; }          // nobody needs this view at frame 9: not asked
            const m = await dec.run(0, f, crops);
            const want = await inline(f);
            let maxd = 0; m.tensors.forEach((t, i) => t.forEach((v, k) => { maxd = Math.max(maxd, Math.abs(v - want[i][k])); }));
            out.perFrame.push({ f, same: same(m.tensors, want), maxd, decodeMs: m.decodeMs >= 0 });
        }
        try { await dec.run(0, 4, crops); } catch (e) { out.behindMsg = e.message; }
        dec.terminate();
        window.LUCID_DECODE_WORKERS = 0;
        out.disabled = await E.createDecodeWorkers(views, frames);
        delete window.LUCID_DECODE_WORKERS;
        out.noFile = await E.createDecodeWorkers([{ name: 'x', decoder: { _mbBackend: decoder._mbBackend } }], frames);
        return out;
    });
    check(r.opened, 'one decode worker per camera opens the video itself');
    check(r.perFrame.length === 6 && r.perFrame.every(p => p.same),
        `worker crops == main-thread (streamed) crops, bit for bit, at frames ${r.perFrame.map(p => p.f + (p.same ? '' : '✗' + p.maxd.toFixed(3))).join(', ')} (B-frame fixture)`);
    check(r.skipOk && r.perFrame.some(p => p.f > 9 && p.same), 'a frame the view is not asked for is decoded past; later frames still match');
    check(!!r.behindMsg && /not ahead/.test(r.behindMsg), `asking for a frame behind the stream rejects ("${r.behindMsg}")`);
    check(r.disabled === null && r.noFile === null, 'LUCID_DECODE_WORKERS = 0, or no local file -> null (main-thread decoding)');
    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (e) {
    console.error(e); fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `FAIL (${fails})` : 'PASS');
process.exit(fails ? 1 : 0);
