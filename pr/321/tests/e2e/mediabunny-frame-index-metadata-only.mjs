/**
 * mediabunny-frame-index-metadata-only.mjs — the vendored
 * MediaBunnyVideoBackend builds its frame index (`_frameTimes`) from
 * `EncodedPacketSink.packets(…, { metadataOnly: true })` (LUCID local patch
 * "luc3d frame-index", lib/sleap-io/chunk-X76PRJK6.js). Without that option the
 * walk reads every packet's BYTES — the whole file, 254 MB per HardFight camera —
 * only to collect timestamps.
 *
 * The patch is only safe if metadata-only iteration yields exactly the same
 * packets, so this pins, per video:
 *   - the metadata-only walk's timestamps equal the full walk's, in the same
 *     (decode) order, `Object.is` per value;
 *   - the backend's `getFrameTimes()` equals the full walk's timestamps sorted
 *     ascending (the #115 presentation-order rule), and its frame count matches;
 *   - for a real file, the metadata-only walk is faster.
 *
 * Inputs: a B-frame H.264 video generated here with ffmpeg (`-bf 3 -g 10`, so
 * decode order != presentation order — the case where an index bug would show),
 * skipped with a note if ffmpeg is absent; `DATASET=<folder>` adds every `.mp4`
 * under it (e.g. the 8 HardFight_1kModels cameras). Files go in through a file
 * input, so they need not live under the served root.
 *
 * Decode correctness on top of the index is covered by
 * mediabunny-bframe-decode-order.mjs.
 *
 * Run: node tests/e2e/mediabunny-frame-index-metadata-only.mjs
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8145);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const videos = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-frameindex-'));
const bf = path.join(tmp, 'bframes.mp4');
const ff = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc=size=320x240:rate=10', '-frames:v', '30',
    '-c:v', 'libx264', '-bf', '3', '-g', '10', '-pix_fmt', 'yuv420p', bf]);
if (ff.status === 0 && fs.existsSync(bf)) videos.push({ file: bf, real: false });
else console.log('  (ffmpeg unavailable — skipping the generated B-frame video)');
if (process.env.DATASET) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(d, e.name))
            : (/\.mp4$/i.test(e.name) && !e.name.startsWith('.') ? [path.join(d, e.name)] : []));
    for (const f of walk(process.env.DATASET).sort()) videos.push({ file: f, real: true });
}
if (videos.length === 0) { console.error('  ✗ no videos to test'); process.exit(1); }

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.SleapIO && window.SleapIO.MediaBunnyVideoBackend,
        { timeout: 20000 });
    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__vid';
        document.body.appendChild(inp);
    });

    for (const v of videos) {
        console.log(`\n• ${v.real ? path.relative(process.env.DATASET, v.file) : 'generated B-frame video (-bf 3 -g 10)'}`);
        await page.setInputFiles('#__vid', v.file);
        const r = await page.evaluate(async () => {
            const file = document.getElementById('__vid').files[0];
            const mb = await import('mediabunny');
            const walk = async (opts) => {
                const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
                const track = await input.getPrimaryVideoTrack();
                const sink = new mb.EncodedPacketSink(track);
                const t0 = performance.now();
                const ts = [];
                for await (const p of (opts ? sink.packets(undefined, undefined, opts) : sink.packets())) ts.push(p.timestamp);
                return { ts, ms: performance.now() - t0 };
            };
            const full = await walk(null);
            const meta = await walk({ metadataOnly: true });
            let firstDiff = -1;
            if (full.ts.length === meta.ts.length) {
                for (let i = 0; i < full.ts.length; i++) if (!Object.is(full.ts[i], meta.ts[i])) { firstDiff = i; break; }
            }
            const be = await window.SleapIO.MediaBunnyVideoBackend.fromBlob(file, file.name, {});
            const idx = await be.getFrameTimes();
            const sorted = full.ts.slice().sort((a, b) => a - b);
            const idxSame = idx.length === sorted.length && idx.every((t, i) => Object.is(t, sorted[i]));
            let reordered = 0;
            for (let i = 1; i < full.ts.length; i++) if (full.ts[i] < full.ts[i - 1]) reordered++;
            const out = { n: full.ts.length, metaN: meta.ts.length, firstDiff, idxSame, frameCount: be.numFrames,
                reordered, fullMs: Math.round(full.ms), metaMs: Math.round(meta.ms), mb: file.size / 1048576 };
            be.close();
            return out;
        });
        console.log(`  ${r.n} packets (${r.reordered} out of presentation order), ${r.mb.toFixed(0)} MB; ` +
            `full walk ${r.fullMs} ms vs metadata-only ${r.metaMs} ms`);
        check(r.n > 0 && r.metaN === r.n, `same packet count (${r.metaN} vs ${r.n})`);
        check(r.firstDiff === -1, 'metadata-only timestamps identical to the full walk, in the same order' +
            (r.firstDiff >= 0 ? ` — first difference at packet ${r.firstDiff}` : ''));
        check(r.idxSame && r.frameCount === r.n,
            'backend frame index = full walk sorted by presentation time (#115), same frame count');
        if (!v.real) check(r.reordered > 0, 'the generated video really has B-frames (decode order != presentation order)');
        else check(r.metaMs < r.fullMs, `metadata-only walk is faster on a real file (${r.metaMs} < ${r.fullMs} ms)`);
    }
    await browser.close();
} finally {
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
