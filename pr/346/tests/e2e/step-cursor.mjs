/**
 * step-cursor.mjs — paused frame stepping keeps a decode stream open
 * (loading/video.js `OnDemandVideoDecoder._mbGetFrame`), so an arrow-key step
 * forward decodes ONE frame instead of every frame since the keyframe, and the
 * frames it shows are the same frames.
 *
 * A generated 60 fps H.264 video, P-frames only, a keyframe every 300 frames (as
 * sparse as the field recordings' 250), opened as the app's OnDemandVideoDecoder
 * (mediabunny backend). Packets handed to WebCodecs are counted. Asserted:
 *  1. 30 steps forward from a mid-GOP frame decode ONE packet each (after the
 *     stream's first run from the keyframe plus its read-ahead) — vs
 *     `LUCID_STEP_CURSOR = 0`, where every step decodes from the keyframe.
 *  2. Every stepped, stepped-back and jumped-to frame is pixel-identical to the
 *     same frame decoded with the stream off (the frame-accurate path, #115).
 *  3. Stepping back reopens the stream (no wrong frame from the old one); a jump
 *     past the next keyframe reopens it AT that keyframe, not by decoding through.
 *  4. Stepping BACK (held left arrow) decodes the run from the keyframe once per
 *     STEP_BACK_CHUNK frames instead of once per step, showing the same frames
 *     (`_decodeBackChunk`; `LUCID_STEP_BACK_CHUNK = 0` for the per-step baseline).
 *  5. Landing on a frame and pausing warms the chunk behind it; holding the left
 *     arrow then finds (nearly) every frame already cached — a background prefetch
 *     keeps a chunk ahead, and the cache evicts the frames FARTHEST from the user,
 *     not the prefetched ones — with the same pixels; a jump cancels a warm-up.
 *  6. The stream is released after STEP_CURSOR_IDLE_MS idle, by
 *     `releaseStepCursor()`, and by `close()`.
 *
 * Needs ffmpeg (libx264); skipped with a note if absent.
 * Run: node tests/e2e/step-cursor.mjs
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8277);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-stepcursor-'));
const vid = path.join(tmp, 'gop300.mp4');
const ff = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x256:rate=60',
    '-frames:v', '900', '-c:v', 'libx264', '-bf', '0', '-g', '300', '-keyint_min', '300', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', vid]);
if (ff.status !== 0 || !fs.existsSync(vid)) {
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
    // (close() itself throws a pre-existing TypeError from the <video> load listener — not this test's subject)
    page.on('pageerror', e => { if (!/reading 'error'/.test(String(e))) { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; } });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.SleapIO && window.SleapIO.MediaBunnyVideoBackend, { timeout: 20000 });
    await page.evaluate(() => {
        const inp = document.createElement('input'); inp.type = 'file'; inp.id = '__vid'; document.body.appendChild(inp);
        window.__decoded = 0;
        const orig = VideoDecoder.prototype.decode;
        VideoDecoder.prototype.decode = function (c) { window.__decoded++; return orig.call(this, c); };
    });
    await page.setInputFiles('#__vid', vid);
    const r = await page.evaluate(async () => {
        const V = await import('./loading/video.js');
        const file = document.getElementById('__vid').files[0];
        const dec = new V.OnDemandVideoDecoder({ cacheSize: 200 });
        await dec.init(file);
        const be = dec._mbBackend;
        const px = (bm) => { const c = new OffscreenCanvas(bm.width, bm.height), x = c.getContext('2d'); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height).data; };
        const clear = () => { dec.releaseStepCursor(); be.cache.forEach(b => b.close()); be.cache.clear(); };
        const run = async (on, frames) => {   // decode `frames` in order; pixels + packets per frame
            window.LUCID_STEP_CURSOR = on ? undefined : 0;
            clear();
            const out = [];
            for (const f of frames) { window.__decoded = 0; const bm = await dec.getFrame(f); out.push({ f, px: px(bm), packets: window.__decoded }); }
            return out;
        };
        const steps = []; for (let f = 400; f <= 430; f++) steps.push(f);          // land mid-GOP, then 30 steps
        const off = await run(false, steps), on = await run(true, steps);
        const same = (a, b) => a.every((x, i) => x.px.length === b[i].px.length && x.px.every((v, j) => v === b[i].px[j]));
        const res = {
            offStepPackets: off.slice(1).map(x => x.packets), onFirst: on[0].packets, onStepPackets: on.slice(1).map(x => x.packets),
            stepsIdentical: same(on, off),
        };
        // back steps beyond anything shown (reopen), then a jump past the next keyframe (600) — vs off
        const seq = [430, 420, 410, 700, 701];
        const off2 = await run(false, seq), on2 = await run(true, seq);
        res.mixedIdentical = same(on2, off2);
        res.jumpPackets = on2[3].packets;               // 700 needs only keyframe 600 onward (+ read-ahead)
        res.cursorAfterJump = dec._stepCursor ? dec._stepCursor.next : null;
        // held LEFT arrow: 30 steps back from 430 (keyframe 300) — chunked (default) vs off
        const backSeq = []; for (let f = 430; f >= 400; f--) backSeq.push(f);
        const chunkRun = async (chunk) => { window.LUCID_STEP_BACK_CHUNK = chunk; dec._lastStepFrame = null; const o = await run(true, backSeq); window.LUCID_STEP_BACK_CHUNK = undefined; return o; };
        window.LUCID_STEP_BACK_PREFETCH = 0;   // chunking alone here; the prefetch is tested below
        const back0 = await chunkRun(0), backC = await chunkRun(undefined);
        window.LUCID_STEP_BACK_PREFETCH = undefined;
        res.backOffPackets = back0.slice(1).map(x => x.packets);
        res.backChunkPackets = backC.slice(1).map(x => x.packets);
        res.backIdentical = same(backC, back0);
        res.chunkSize = V.STEP_BACK_CHUNK;
        // landing warm-up + background prefetch, under the cache pressure of a SMALL cache (30 frames →
        // chunks of 12, two chunks + what is on screen nearly fill it — where plain LRU evicted the
        // prefetched frames before they were reached)
        window.LUCID_STEP_CURSOR = undefined;
        const savedSize = be.cacheSize; be.cacheSize = 30;
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const settle = async () => { await sleep(V.STEP_BACK_WARM_MS + 60); while (dec._backPrefetch) await dec._backPrefetch.promise; };
        clear(); dec._lastStepFrame = null;
        await dec.getFrame(700);                                   // land (a jump), then look at it
        await settle();
        const n = dec._backChunkSize();
        res.warmN = n;
        res.warmed = []; for (let f = 700 - n; f < 700; f++) res.warmed.push(be.cache.has(f));
        // held left arrow at ~25 steps/s: 120 steps back from 699, across keyframe 600
        let pre = 0; const heldPx = {};
        for (let f = 699; f >= 580; f--) {
            if (be.cache.has(f)) pre++;
            const bm = await dec.getFrame(f);
            if (f % 20 === 0 || f === 601 || f === 599) heldPx[f] = px(bm);
            await sleep(40);
        }
        res.precached = pre;
        res.cacheAfterHeld = be.cache.size;
        const heldFrames = Object.keys(heldPx).map(Number).sort((a, b) => b - a);
        const heldRef = await run(false, heldFrames);
        res.heldIdentical = heldRef.every(x => { const p = heldPx[x.f]; return p && p.length === x.px.length && p.every((v, j) => v === x.px[j]); });
        res.heldCompared = heldFrames.length;
        // a jump cancels an in-flight warm-up (land on 899: its chunk decodes from keyframe 600)
        window.LUCID_STEP_CURSOR = undefined;
        clear(); dec._lastStepFrame = null;
        await dec.getFrame(899);
        let job = null; for (let i = 0; i < 100 && !job; i++) { await sleep(10); job = dec._backPrefetch; }
        res.warmStarted = !!job;
        await dec.getFrame(100);                                   // jump away
        const cnt = () => { let c = 0; for (let f = 899 - n; f < 899; f++) if (be.cache.has(f)) c++; return c; };
        const atJump = cnt(); await sleep(400);
        res.cancelled = !!job && job.cancelled === true && dec._backPrefetch !== job;
        res.grewAfterCancel = cnt() - atJump;
        be.cacheSize = savedSize;
        // release: idle, explicit, close()
        window.LUCID_STEP_CURSOR = undefined;
        await dec.getFrame(702);
        res.openBeforeIdle = !!dec._stepCursor;
        await new Promise(r => setTimeout(r, V.STEP_CURSOR_IDLE_MS + 300));
        res.closedAfterIdle = dec._stepCursor === null;
        await dec.getFrame(703); res.reopened = !!dec._stepCursor;
        dec.releaseStepCursor(); res.closedExplicit = dec._stepCursor === null;
        await dec.getFrame(704); dec.close(); res.closedOnClose = dec._stepCursor === null;
        return res;
    });
    const sumOff = r.offStepPackets.reduce((a, b) => a + b, 0), sumOn = r.onStepPackets.reduce((a, b) => a + b, 0);
    console.log('\n• 30 steps forward from frame 400 (keyframe 300)');
    check(r.offStepPackets.every((p, i) => p === 401 + i - 300 + 1), `stream off: each step decodes from the keyframe (${r.offStepPackets[0]}…${r.offStepPackets[29]} packets, ${sumOff} in all)`);
    check(r.onStepPackets.every(p => p === 1), `stream on: every step decodes ONE packet (${sumOn} for 30 steps; the frame shown was already read ahead, the packet tops the read-ahead up)`);
    check(r.onFirst >= 101 && r.onFirst <= 101 + 50, `the first frame decodes keyframe 300 → 400 plus a short read-ahead (${r.onFirst} packets)`);
    check(r.stepsIdentical, 'every stepped frame pixel-identical to the frame-accurate decode');
    console.log('\n• back steps and a jump past the next keyframe');
    check(r.mixedIdentical, 'frames 430 → 420 → 410 → 700 → 701 pixel-identical to the frame-accurate decode');
    check(r.jumpPackets <= (700 - 600 + 1) + 50, `jump to 700 reopens at keyframe 600 (${r.jumpPackets} packets, not ~${700 - 410} decoded through)`);
    check(r.cursorAfterJump === 702, `stream positioned after 701 (next ${r.cursorAfterJump})`);
    console.log('\n• held left arrow: 30 steps back from 430');
    const bo = r.backOffPackets, bc = r.backChunkPackets, decodingSteps = bc.filter(p => p > 0).length;
    check(bo.every((p, i) => p >= 429 - i - 300 + 1), `chunk off: every step back decodes from keyframe 300 (${bo[0]}…${bo[bo.length - 1]} packets, ${bo.reduce((a, b) => a + b, 0)} in all)`);
    check(decodingSteps <= Math.ceil(30 / r.chunkSize), `chunk ${r.chunkSize}: only ${decodingSteps} of 30 steps decode anything (${bc.reduce((a, b) => a + b, 0)} packets in all); the rest are cache hits`);
    check(r.backIdentical, 'every frame stepped back to is pixel-identical with and without chunking');

    console.log('\n• landing warm-up and background prefetch (30-frame cache, chunks of ' + r.warmN + ')');
    check(r.warmed.every(Boolean), `landing on 700 and pausing warms the ${r.warmN} frames behind it (${r.warmed.filter(Boolean).length}/${r.warmN} cached before any step)`);
    check(r.precached >= 118, `held left arrow 699 → 580 (across keyframe 600): ${r.precached}/120 frames already cached when asked for`);
    check(r.cacheAfterHeld <= 30, `the cache stayed within its size (${r.cacheAfterHeld} ≤ 30)`);
    check(r.heldIdentical, `stepped-back frames pixel-identical to the frame-accurate decode (${r.heldCompared} compared, incl. 601 / 599 either side of the keyframe)`);
    check(r.warmStarted && r.cancelled && r.grewAfterCancel <= 1, `a jump cancels the warm-up in flight (cancelled: ${r.cancelled}, ${r.grewAfterCancel} frame(s) cached after)`);

    console.log('\n• release');
    check(r.openBeforeIdle && r.closedAfterIdle, 'stream closed after STEP_CURSOR_IDLE_MS idle');
    check(r.reopened && r.closedExplicit, 'reopens on the next frame; releaseStepCursor() closes it');
    check(r.closedOnClose, 'close() closes it');
} finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
