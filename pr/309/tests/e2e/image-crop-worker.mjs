/**
 * image-crop-worker.mjs — the image ID-switch check's crop workers
 * (ui/image-crop-worker.js, pooled by ui/image-embedder.js `createCropPool`).
 *
 * The check was calibrated on crops cut on the main thread, so the workers must
 * produce EXACTLY the same model inputs. A synthetic frame (gradients + shapes,
 * so masking, rotation and resampling all matter) holds three animals in a
 * view; asserted:
 *  1. Pool output == inline `cutCrop` + `writeInputTensor`, bit for bit, from a
 *     transferred VideoFrame and from an ImageBitmap.
 *  2. Several views in flight at once come back to the right callers.
 *  3. A bad job rejects (with the worker's message) without breaking the pool.
 *  4. `LUCID_CROP_WORKERS = 0` turns the pool off (the caller crops inline).
 *
 * Run: node tests/e2e/image-crop-worker.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8276);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const r = await page.evaluate(async () => {
        const E = await import('/ui/image-embedder.js');
        const W = 640, H = 480, cv = new OffscreenCanvas(W, H), c = cv.getContext('2d');
        const grad = c.createLinearGradient(0, 0, W, H); grad.addColorStop(0, '#203040'); grad.addColorStop(1, '#e0c0a0');
        c.fillStyle = grad; c.fillRect(0, 0, W, H);
        for (let i = 0; i < 40; i++) { c.fillStyle = `hsl(${i * 37 % 360},60%,${30 + i % 50}%)`; c.beginPath(); c.arc((i * 97) % W, (i * 61) % H, 6 + i % 17, 0, 7); c.fill(); }
        // three animals: body keypoints (non-tail) around a centre, nose along a heading
        const sk = { nose: 0, tti: 3, body: [0, 1, 2, 3, 4, 5, 6] };
        const animal = (cx, cy, h, s) => {
            const t = [[45, 0], [25, -11], [25, 11], [-40, 0], [30, 0], [-5, 0], [10, 12]];
            const pts = t.map(([x, y]) => [cx + s * (Math.cos(h) * x - Math.sin(h) * y), cy + s * (Math.sin(h) * x + Math.cos(h) * y)]);
            return E.cropGeometry({ getPoint: i => pts[i] || null }, sk);
        };
        const geos = [animal(200, 200, 0.3, 1.2), animal(300, 260, 2.5, 1.0), animal(450, 150, -1.2, 0.9)];
        const crops = geos.map((g, i) => ({ g, others: geos.filter((x, j) => j !== i).map(x => x.hull) }));
        const SZ = 3 * E.INPUT * E.INPUT, canvas = new OffscreenCanvas(E.CROP, E.CROP);
        const vf0 = new VideoFrame(cv, { timestamp: 0 });
        const inline = crops.map(cc => { const t = new Float32Array(SZ); E.writeInputTensor(E.cutCrop(vf0, cc.g, cc.others, canvas), t, 0); return t; });
        const same = (a, b) => a.length === b.length && a.every((t, i) => t.length === b[i].length && t.every((v, k) => Object.is(v, b[i][k])));
        const nonBlank = inline.every(t => new Set(t).size > 200 && t.some(v => v < -2) && t.some(v => v > 0));

        window.LUCID_CROP_WORKERS = 3;
        const pool = E.createCropPool();
        const fromFrame = await pool.run(vf0.clone(), crops);
        // an ImageBitmap source (the getFrame fallback's cached frames) against inline crops of the same bitmap
        const bm = await createImageBitmap(vf0);
        const inlineBm = crops.map(cc => { const t = new Float32Array(SZ); E.writeInputTensor(E.cutCrop(bm, cc.g, cc.others, canvas), t, 0); return t; });
        const fromBitmap = await pool.run(await createImageBitmap(bm), crops);
        // several in flight: each a different subset, so a mix-up shows
        const subsets = [[0], [1, 2], [2], [0, 1, 2], [1]];
        const many = await Promise.all(subsets.map(ix => pool.run(vf0.clone(), ix.map(i => crops[i]))));
        const manyOk = many.every((ts, k) => same(ts, subsets[k].map(i => inline[i])));
        let badMsg = null;
        try { await pool.run(vf0.clone(), [{ g: null, others: [] }]); } catch (e) { badMsg = e.message; }
        const afterBad = await pool.run(vf0.clone(), crops);
        const broken = pool.broken;
        pool.terminate();
        window.LUCID_CROP_WORKERS = 0;
        const off = E.createCropPool();
        delete window.LUCID_CROP_WORKERS;
        vf0.close();
        return { nonBlank, frameOk: same(fromFrame, inline), bitmapOk: same(fromBitmap, inlineBm), manyOk,
                 badMsg, afterBadOk: same(afterBad, inline), broken, off };
    });
    check(r.nonBlank, 'fixture crops have real content (masking/resampling are exercised)');
    check(r.frameOk, 'worker crops from a transferred VideoFrame are bit-identical to inline crops');
    check(r.bitmapOk, 'worker crops from an ImageBitmap are bit-identical to inline crops');
    check(r.manyOk, 'five views in flight at once each come back to their caller');
    check(r.badMsg && r.afterBadOk && !r.broken, `a bad job rejects ("${r.badMsg}") and the pool keeps working`);
    check(r.off === null, 'LUCID_CROP_WORKERS = 0 → no pool (inline cropping)');
    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (e) {
    console.error(e); fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `FAIL (${fails})` : 'PASS');
process.exit(fails ? 1 : 0);
