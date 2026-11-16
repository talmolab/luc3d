/**
 * video-cold-read.mjs — a video File whose reads fail or come back with zeroed
 * pages (a cloud file still downloading) must still load frame-accurately.
 *
 * WHY: in a Google Drive for desktop folder on macOS (File Provider), Drive
 * fetches a video only in the ranges that are read, so the load and every seek
 * into an unvisited part of a video read parts not downloaded yet. Measured on
 * cold 8-camera sessions (2026-10-19): such Blob reads can FAIL
 * (`TypeError: network error` from a Blob stream) — that cost 2 of 48 cameras
 * their frame-accurate decoder for the whole session, so they stepped by
 * `<video>` seeks — and a read can come back with a run of ZEROS (the first
 * 64 KiB of a read starting on a 1 MiB boundary; what corrupted cold `.slp`
 * parses, as 16 KiB pages). OnDemandVideoDecoder now reads the File
 * through `loading/cold-read-guard.js`: mediabunny via sleap-io.js's
 * `MediaBunnyVideoBackend.fromRangeSource`, and mp4box's index scan via
 * `readChunk`, both retrying failed reads and re-reading all-zero blocks (with the block
 * on each side, for a run that starts or ends part-way into one).
 *
 * The faults are injected in the page, under the app: `Blob.prototype.slice`,
 * `arrayBuffer` and `stream` are wrapped so that reads of the file named
 * `cold*.mp4` get zeros over a hole the first time a read covers it, or throw
 * (a stream errors) the first time a read covers a failing byte. The `<video>`
 * element reads natively and is not affected. The fixture is the committed
 * B-frame clip, decoded by frame index and compared pixel for pixel with the
 * same clip read cleanly; the negative control is mediabunny's own BlobSource
 * (`fromBlob`, the old path) under the same faults.
 *
 * Run: node tests/e2e/video-cold-read.mjs   (spawns its own http.server; PORT=)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8577);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    const warnings = [];
    page.on('console', m => { if (/cold-read/.test(m.text())) warnings.push(m.text()); if (process.env.DEBUG) console.log('   [page] ' + m.text().slice(0, 200)); });

    await page.addInitScript(() => {
        // Fault injection for files named cold*.mp4. window.__faults = { holes: [[start, end, k]], fails: [[at, k]] }.
        const origin = new WeakMap();
        const S = Blob.prototype.slice, AB = Blob.prototype.arrayBuffer, ST = Blob.prototype.stream;
        window.__faults = { holes: [], fails: [] };
        window.__faultHits = { zeroed: 0, failed: 0 };
        const target = (b) => { const o = origin.get(b) || { root: b, start: 0 }; return o.root instanceof File && /^cold.*\.mp4$/.test(o.root.name) ? o : null; };
        Blob.prototype.slice = function (a, b, t) {
            const r = S.call(this, a, b, t);
            const o = origin.get(this) || { root: this, start: 0 };
            const s = a === undefined ? 0 : a < 0 ? Math.max(this.size + a, 0) : Math.min(a, this.size);
            origin.set(r, { root: o.root, start: o.start + s });
            return r;
        };
        const failsAt = (s, e) => { for (const f of window.__faults.fails) if (f[1] > 0 && f[0] >= s && f[0] < e) { f[1]--; window.__faultHits.failed++; return true; } return false; };
        const zero = (u8, s) => {
            const e = s + u8.length;
            for (const h of window.__faults.holes) {
                if (h[2] <= 0 || h[1] <= s || h[0] >= e) continue;
                h[2]--; window.__faultHits.zeroed++;
                u8.fill(0, Math.max(0, h[0] - s), Math.min(u8.length, h[1] - s));
            }
        };
        Blob.prototype.arrayBuffer = async function () {
            const o = target(this);
            if (o && failsAt(o.start, o.start + this.size)) throw new DOMException('The requested file could not be read', 'NotReadableError');
            const ab = await AB.call(this);
            if (o) zero(new Uint8Array(ab), o.start);
            return ab;
        };
        Blob.prototype.stream = function () {
            const o = target(this), rs = ST.call(this);
            if (!o) return rs;
            const reader = rs.getReader(); let pos = o.start;
            return new ReadableStream({
                async pull(ctl) {
                    const r = await reader.read();
                    if (r.done) { ctl.close(); return; }
                    const s = pos; pos += r.value.length;
                    if (failsAt(s, pos)) { ctl.error(new TypeError('network error')); reader.cancel(); return; }
                    zero(r.value, s);
                    ctl.enqueue(r.value);
                },
                cancel(reason) { return reader.cancel(reason); },
            }, { highWaterMark: 0 });
        };
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });

    // Helpers live on window; each case is its own evaluate, raced against a
    // timeout: an unguarded mp4box scan handed a zeroed index LOOPS on the main
    // thread ("Unlimited box size not supported"), freezing the page for good.
    await page.evaluate(async () => {
        const V = await import('./loading/video.js');
        const bytes = await (await fetch('./tests/fixtures/bframes-test/bframes-test.mp4')).arrayBuffer();
        const fileNamed = (name) => new File([bytes], name, { type: 'video/mp4' });
        const fnv = (u) => { let h = 0x811c9dc5; for (let q = 0; q < u.length; q++) { h ^= u[q]; h = Math.imul(h, 16777619) >>> 0; } return h; };
        const c = document.createElement('canvas'); c.width = 320; c.height = 240;
        const cx = c.getContext('2d', { willReadFrequently: true });
        const pixels = (bm) => { if (!bm) return null; cx.clearRect(0, 0, 320, 240); cx.drawImage(bm, 0, 0); return fnv(cx.getImageData(0, 0, 320, 240).data); };
        async function framesOf(be) {
            const frames = [];
            for (let i = 0; i < be._frameTimes.length; i++) { let bm = null; try { bm = await be.getFrame(i); } catch (_) {} frames.push(pixels(bm)); }
            return frames;
        }
        function arm(faults) { window.__faults = JSON.parse(JSON.stringify(faults)); window.__faultHits = { zeroed: 0, failed: 0 }; }
        function disarm() { const hits = Object.assign({}, window.__faultHits); window.__faults = { holes: [], fails: [] }; return hits; }
        /** The app's whole load: OnDemandVideoDecoder.init (the <video> element, mp4box's scan, mediabunny). */
        async function load(name, faults, html5Only) {
            window.LUCID_VIDEO_BACKEND = html5Only ? 'html5' : undefined;
            arm(faults);
            const dec = new V.OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
            let err = null;
            try { await dec.init(fileNamed(name)); } catch (e) { err = String(e); }
            const hits = disarm();
            window.LUCID_VIDEO_BACKEND = undefined;
            const s = { err, hits, n: dec.samples && dec.samples.length, fps: dec._fps, mb: !!dec._mbBackend, mbUnavailable: dec._mbUnavailable };
            if (dec._mbBackend) { s.times = Array.from(dec._mbBackend._frameTimes); s.frames = await framesOf(dec._mbBackend); }
            try { dec.close(); } catch (_) {}
            return s;
        }
        /** The frame-accurate backend alone (_initMediabunny: sleap-io.js's fromRangeSource over the guard). */
        async function mediabunnyOnly(name, faults) {
            const dec = new V.OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
            dec.samples = [];
            arm(faults);
            let err = null;
            try { await dec._initMediabunny(fileNamed(name)); } catch (e) { err = String(e); }
            const hits = disarm();
            const s = { err, hits, mb: !!dec._mbBackend };
            if (dec._mbBackend) { s.times = Array.from(dec._mbBackend._frameTimes); s.frames = await framesOf(dec._mbBackend); }
            try { dec.close(); } catch (_) {}
            return s;
        }
        /** The old path: mediabunny's own BlobSource over the same faults (negative control). */
        async function blobSource(name, faults) {
            arm(faults);
            let be = null, err = null;
            try { be = await window.SleapIO.MediaBunnyVideoBackend.fromBlob(fileNamed(name), name, {}); } catch (e) { err = String(e); }
            const hits = disarm();
            const s = { err, hits };
            if (be) { s.times = Array.from(be._frameTimes); s.frames = await framesOf(be); be.close(); }
            return s;
        }
        // The fixture: ftyp 0-31, mdat 40-28356 (the frames), moov 28357-29494 (the index).
        // A hole reads as zeros the FIRST time a read covers it; a failing byte makes the first read over it throw.
        // Ordered so that an unguarded build shows as much as it can before
        // the last two cases freeze it.
        const CASES = {
            'a read over the index fails': { holes: [], fails: [[29000, 1]] },
            'two reads fail, and a block is zeroed': { holes: [[20480, 24576, 1]], fails: [[4000, 2]] },
            'a 4 KiB block of zeros in the frames': { holes: [[8192, 12288, 1]], fails: [] },
            'the first page zeroed (ftyp and the first frames)': { holes: [[0, 16384, 1]], fails: [] },
            'a 16 KiB page of zeros over the frames and the index': { holes: [[16384, 32768, 1]], fails: [] },
            // a run that starts and ends part-way into a 4 KiB block: its ragged edges are not all zero
            'a run of zeros with ragged edges in the frames': { holes: [[8192 - 700, 12288 + 900, 1]], fails: [] },
            'a run of zeros over the index, ending part-way into a block': { holes: [[16384, 28672 + 400, 1]], fails: [] },
        };
        window.__vc = {
            labels: Object.keys(CASES),
            clean: async () => ({ clean: await load('warm.mp4', { holes: [], fails: [] }), cleanHtml5: await load('warm.mp4', { holes: [], fails: [] }, true) }),
            run: async (label) => ({
                load: await load('cold.mp4', CASES[label]),
                mp4box: await load('cold.mp4', CASES[label], true),
                mediabunny: await mediabunnyOnly('cold.mp4', CASES[label]),
                blobSource: await blobSource('cold-old.mp4', CASES[label]),
            }),
        };
    });
    const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out: ' + what)), ms))]);
    const r = Object.assign({ cases: {} }, await within(page.evaluate(() => window.__vc.clean()), 60000, 'clean load'));
    for (const label of await page.evaluate(() => window.__vc.labels)) {
        try {
            r.cases[label] = await within(page.evaluate((l) => window.__vc.run(l), label), 60000, label);
        } catch (e) {
            check(false, `${label}: the page froze (${e.message}) — an unguarded mp4box scan loops on a zeroed index`);
            break;
        }
    }

    const { clean, cleanHtml5 } = r;
    check(!clean.err && clean.mb && clean.n === 30 && clean.frames.length === 30 && clean.frames.every(Boolean),
        `clean load: frame-accurate backend, 30 frames decoded (${clean.err || clean.n})`);
    check(!cleanHtml5.err && cleanHtml5.n === 30 && cleanHtml5.fps === clean.fps, `clean mp4box scan alone: 30 frames at ${cleanHtml5.fps} fps`);
    const sameIndexAndFrames = (x) => !x.err && x.mb && JSON.stringify(x.times) === JSON.stringify(clean.times) && JSON.stringify(x.frames) === JSON.stringify(clean.frames);
    const reached = (x) => x.hits.zeroed + x.hits.failed > 0;
    for (const [label, c] of Object.entries(r.cases)) {
        console.log(`  ${label}:`);
        check(reached(c.load) && sameIndexAndFrames(c.load) && c.load.n === clean.n && c.load.fps === clean.fps,
            `    whole load: same frame count, fps, frame index and every frame's pixels (faults hit ${JSON.stringify(c.load.hits)})${c.load.err ? ' — ' + c.load.err : ''}`);
        check(reached(c.mp4box) && !c.mp4box.err && c.mp4box.n === clean.n && c.mp4box.fps === clean.fps,
            `    mp4box's scan alone: ${c.mp4box.n} frames at ${c.mp4box.fps} fps (faults hit ${JSON.stringify(c.mp4box.hits)})`);
        check(reached(c.mediabunny) && sameIndexAndFrames(c.mediabunny),
            `    frame-accurate backend alone: same frame index and pixels (faults hit ${JSON.stringify(c.mediabunny.hits)})${c.mediabunny.err ? ' — ' + c.mediabunny.err : ''}`);
        const brokeOld = c.blobSource.err || JSON.stringify(c.blobSource.times) !== JSON.stringify(clean.times)
            || JSON.stringify(c.blobSource.frames) !== JSON.stringify(clean.frames);
        check(reached(c.blobSource) && brokeOld,
            `    negative control: mediabunny's own BlobSource ${c.blobSource.err ? 'fails (' + c.blobSource.err.slice(0, 70) + ')' : 'gives a different index or frames'}`);
    }
    check(warnings.some(w => /first read as zeros were read again/.test(w)) && warnings.some(w => /read on try/.test(w)),
        `each repair is said in the console (${warnings.length} lines)`);

    await within(browser.close(), 10000, 'close').catch(() => {});
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
