/**
 * test-cold-read-guard.mjs — Blob reads of a file still downloading from a
 * cloud-synced folder must come back right (`loading/cold-read-guard.js`).
 *
 * WHY: in a Google Drive for desktop folder on macOS (File Provider), a read of
 * a part of a file not downloaded yet can FAIL (`arrayBuffer()` rejects; on
 * cold 8-camera session loads 2 of 48 cameras lost their frame-accurate decoder
 * that way, 2026-10-19) or return a run of ZEROS with every other byte right
 * (the first 64 KiB of a read starting on a 1 MiB boundary of a video; 16 KiB
 * pages in the cold `.slp` parses the h5wasm `cold-read` patch guards).
 * Drive fetches a video only in the ranges that are read, so every seek into an
 * unvisited part of a video is such a read. The video decoder (mediabunny, via
 * sleap-io.js's `MediaBunnyVideoBackend.fromRangeSource`), mp4box's index scan
 * and Load 3D Points now read through `readBlobRange`, which retries a read that
 * throws and re-reads any all-zero part of a read.
 *
 * The faults are injected by a fake Blob: a hole reads as zeros the first `k`
 * times a read covers it, the real bytes after that; a failing range throws the
 * first `k` times. §5 builds the frame index and every packet of the committed
 * B-frame fixture through mediabunny — exactly as `MediaBunnyVideoBackend`
 * does — over the guard, with the unguarded read as the negative control.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    zeroRuns, readBlobRange, readBlobArrayBuffer, guardedRangeSource,
    coldReadStats, COLD_READ_RETRY_MS,
} from '../loading/cold-read-guard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/bframes-test/bframes-test.mp4');

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const warnings = [];
console.warn = (...a) => { warnings.push(a.join(' ')); };
// Retry delays: keep the schedule's LENGTH, not its waiting.
COLD_READ_RETRY_MS.splice(0, COLD_READ_RETRY_MS.length, ...COLD_READ_RETRY_MS.map(() => 1));
const RETRIES = COLD_READ_RETRY_MS.length;

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const resetStats = () => { for (const k of Object.keys(coldReadStats)) coldReadStats[k] = 0; warnings.length = 0; };

/**
 * A Blob stand-in over `bytes`. `holes`: [[start, end, k]] — reads covering
 * [start, end) get zeros there the first k times. `fails`: [[at, k]] — reads
 * covering byte `at` throw (as Chrome's NotReadableError) the first k times.
 */
function faultyBlob(bytes, { holes = [], fails = [], name = 'cold.mp4' } = {}) {
    const holeLeft = holes.map(h => [h[0], h[1], h[2] == null ? 1 : h[2]]);
    const failLeft = fails.map(f => [f[0], f[1] == null ? 1 : f[1]]);
    const blob = {
        name, size: bytes.length, reads: 0,
        slice(a, b) {
            const s = Math.max(0, a), e = Math.min(b == null ? bytes.length : b, bytes.length);
            return {
                async arrayBuffer() {
                    blob.reads++;
                    for (const f of failLeft) if (f[1] > 0 && f[0] >= s && f[0] < e) { f[1]--; throw new Error('NotReadableError: The requested file could not be read'); }
                    const out = bytes.slice(s, e);
                    for (const h of holeLeft) {
                        if (h[2] <= 0 || h[1] <= s || h[0] >= e) continue;
                        h[2]--;
                        out.fill(0, Math.max(0, h[0] - s), Math.min(out.length, h[1] - s));
                    }
                    return out.buffer;
                },
            };
        },
    };
    return blob;
}
const plainRead = async (blob, s, e) => new Uint8Array(await blob.slice(s, e).arrayBuffer());

// ---------------------------------------------------------------------------
console.log('\n1. zeroRuns: all-zero 4 KiB blocks of the FILE, clipped to the read, merged');
{
    const b = new Uint8Array(20000).fill(7);
    check(zeroRuns(b, 0).length === 0, 'no zeros, no runs');
    b.fill(0, 4096, 12288);
    check(JSON.stringify(zeroRuns(b, 0)) === '[[4096,12288]]', 'two neighbouring zero blocks merge into one run');
    b.fill(0, 4000, 4096);
    check(JSON.stringify(zeroRuns(b, 0)) === '[[4096,12288]]', 'zeros that do not fill a block are not a run');
    // the same bytes read from file offset 1000: blocks are the file's, not the read's
    const c = new Uint8Array(10000).fill(1);
    c.fill(0, 4096 - 1000, 8192 - 1000);
    check(JSON.stringify(zeroRuns(c, 1000)) === '[[4096,8192]]', 'an unaligned read is checked per FILE block');
    const d = new Uint8Array(300);   // a read inside one block, all zero
    check(JSON.stringify(zeroRuns(d, 5000)) === '[[5000,5300]]', 'a read inside one block is clipped to the read');
    const e = new Uint8Array(5000).fill(3); e.fill(0, 0, 96);   // the read starts 96 bytes before a boundary
    check(JSON.stringify(zeroRuns(e, 4000)) === '[[4000,4096]]', 'a clipped first block counts when all of it is zero');
}

// ---------------------------------------------------------------------------
console.log('\n2. Holes read as zeros: a re-read brings back the real bytes');
const real = new Uint8Array(1 << 20);
for (let i = 0; i < real.length; i++) real[i] = (i * 2654435761 >>> 13) & 255 | 1;   // no zero bytes
{
    resetStats();
    const blob = faultyBlob(real, { holes: [[65536, 81920], [262144, 278528]] });
    const plain = await plainRead(faultyBlob(real, { holes: [[65536, 81920], [262144, 278528]] }), 0, real.length);
    check(zeroRuns(plain, 0).length === 2, 'negative control: an unguarded read keeps both 16 KiB holes');
    const got = await readBlobRange(blob, 0, real.length);
    check(sameBytes(got, real), 'guarded read of the whole file equals the file');
    check(coldReadStats.rereads === 2 && coldReadStats.recovered === 2, `two re-reads, two recovered (${JSON.stringify(coldReadStats)})`);
    check(warnings.length === 2 && /bytes 65536-81920 first read as zeros were read again/.test(warnings[0]),
        'each recovery is said in the console');
}
{
    resetStats();
    // the re-read of one hole carries a SECOND hole further on (inside the first's range)
    const blob = faultyBlob(real, { holes: [[16384, 49152, 1], [32768, 36864, 2]] });
    const got = await readBlobRange(blob, 0, 65536);
    check(sameBytes(got, real.subarray(0, 65536)), 'a hole inside a re-read is re-read in turn');
}
{
    resetStats();
    const zeros = real.slice(); zeros.fill(0, 8192, 16384);   // bytes that REALLY are zero
    const got = await readBlobRange(faultyBlob(zeros), 0, 65536);
    check(sameBytes(got, zeros.subarray(0, 65536)), 'really-zero bytes stay zero');
    check(coldReadStats.rereads === 1 && coldReadStats.recovered === 0, 'and cost one re-read, no recovery');
}
{
    resetStats();
    const blob = faultyBlob(real, { holes: [[16384, 32768, 99]] });   // never fills
    const got = await readBlobRange(blob, 0, 65536);
    const expect = real.slice(0, 65536); expect.fill(0, 16384, 32768);
    check(sameBytes(got, expect), 'a hole that never fills is left as read: the guard never makes a read worse');
    check(blob.reads === 2, `one read plus one re-read, no loop (${blob.reads} reads)`);
}

// ---------------------------------------------------------------------------
console.log('\n3. Reads that throw are tried again');
{
    resetStats();
    const blob = faultyBlob(real, { fails: [[500000, 2]] });
    let threw = false; try { await plainRead(faultyBlob(real, { fails: [[500000, 2]] }), 400000, 600000); } catch (e) { threw = true; }
    check(threw, 'negative control: an unguarded read throws');
    const got = await readBlobRange(blob, 400000, 600000);
    check(sameBytes(got, real.subarray(400000, 600000)), 'a read that fails twice succeeds on the third try');
    check(coldReadStats.retries === 2 && coldReadStats.rescued === 1, `two retries, one rescue (${JSON.stringify(coldReadStats)})`);
    check(/read on try 3/.test(warnings.join('\n')), 'the rescue is said in the console');
}
{
    resetStats();
    const blob = faultyBlob(real, { fails: [[500000, 99]] });
    let err = null; try { await readBlobRange(blob, 400000, 600000); } catch (e) { err = e; }
    check(err && /NotReadableError/.test(err.message), 'a read that keeps failing rethrows the error');
    check(blob.reads === RETRIES + 1, `after ${RETRIES} retries (${blob.reads} reads)`);
}
{
    resetStats();
    // a hole whose re-read fails once first
    const blob = faultyBlob(real, { holes: [[16384, 32768]], fails: [[20000, 0]] });
    blob.slice = ((orig) => function (a, b) {
        const r = orig.call(blob, a, b);
        if (a === 16384 && b === 32768 && !blob._failedOnce) { blob._failedOnce = true; return { async arrayBuffer() { throw new Error('NotReadableError'); } }; }
        return r;
    })(blob.slice);
    const got = await readBlobRange(blob, 0, 65536);
    check(sameBytes(got, real.subarray(0, 65536)), 'a re-read of a hole that throws is retried too');
}
{
    resetStats();
    const buf = await readBlobArrayBuffer(faultyBlob(real, { holes: [[0, 4096]], fails: [[0, 1]] }));
    check(buf instanceof ArrayBuffer && sameBytes(new Uint8Array(buf), real), 'readBlobArrayBuffer: the whole file, both faults handled');
}

// ---------------------------------------------------------------------------
console.log('\n4. guardedRangeSource: the { size, readRange } shape fromRangeSource takes');
{
    const src = guardedRangeSource(faultyBlob(real, { holes: [[4096, 8192]] }));
    check(src.size === real.length, 'size is the blob size');
    const got = await src.readRange(1000, 9000);
    check(got instanceof Uint8Array && got.length === 9000 && sameBytes(got, real.subarray(1000, 10000)),
        'readRange(start, LENGTH) returns exactly length bytes, hole repaired');
}
{
    // windows: one Blob read serves every request inside it
    const blob = faultyBlob(real);
    const src = guardedRangeSource(blob, { windowBytes: 65536, cacheBytes: 131072 });
    const parts = [];
    for (let s = 0; s < 65536; s += 8192) parts.push(await src.readRange(s, 8192));
    check(blob.reads === 1, `eight sequential requests inside one window cost one Blob read (${blob.reads})`);
    check(sameBytes(new Uint8Array(parts.flatMap(p => Array.from(p))), real.subarray(0, 65536)), 'and return the file');
    parts[0][0] ^= 0xff;
    const again = await src.readRange(0, 16);
    check(again[0] === real[0], 'each answer is a copy: changing one does not change the window');
    const span = await src.readRange(60000, 20000);   // crosses into the next window
    check(sameBytes(span, real.subarray(60000, 80000)), 'a request crossing a window boundary reads both windows at once');
    await src.readRange(200000, 10);
    await src.readRange(300000, 10);
    const before = blob.reads;
    await src.readRange(0, 10);
    check(blob.reads === before + 1, 'windows past the cache size are dropped, oldest first');
    const last = await src.readRange(real.length - 100, 100);
    check(sameBytes(last, real.subarray(real.length - 100)), 'the last window is clipped to the file');
}
{
    // a window whose read keeps failing is not cached: the next request reads again
    const blob = faultyBlob(real, { fails: [[70000, RETRIES + 1]] });
    const src = guardedRangeSource(blob, { windowBytes: 65536 });
    let err = null; try { await src.readRange(66000, 100); } catch (e) { err = e; }
    check(err !== null, 'a request whose window cannot be read rejects');
    const got = await src.readRange(66000, 100);
    check(sameBytes(got, real.subarray(66000, 66100)), 'and the next request for it reads it again');
}

// ---------------------------------------------------------------------------
console.log('\n5. mediabunny over the guard: frame index and packets as from a clean read');
const mb = await import(path.join(ROOT, 'lib/mediabunny/mediabunny.min.mjs'));
const video = new Uint8Array(fs.readFileSync(FIXTURE));
/** What MediaBunnyVideoBackend.initialize builds (sorted packet timestamps), plus every packet's bytes. */
async function indexOf(rangeSource) {
    // exactly MediaBunnyVideoBackend.fromRangeSource's source (lib/sleap-io/chunk-X76PRJK6.js)
    const input = new mb.Input({
        source: new mb.StreamSource({
            getSize: () => rangeSource.size,
            read: (start, end) => rangeSource.readRange(start, end - start),
            prefetchProfile: 'fileSystem',
        }),
        formats: mb.ALL_FORMATS,
    });
    try {
        const track = await input.getPrimaryVideoTrack();
        const times = [], packets = [];
        for await (const p of new mb.EncodedPacketSink(track).packets()) { times.push(p.timestamp); packets.push(Array.from(p.data)); }
        times.sort((a, b) => a - b);
        return { times, packets };
    } catch (e) {
        return { err: String(e && e.message || e) };
    } finally {
        input.dispose && input.dispose();
    }
}
const unguarded = (blob) => ({ size: blob.size, readRange: (s, n) => plainRead(blob, s, s + n) });
const clean = await indexOf(unguarded(faultyBlob(video)));
check(!clean.err && clean.times.length === 30, `the clean read indexes all 30 frames (${clean.err || clean.times.length})`);
const same = (a) => !a.err && JSON.stringify(a.times) === JSON.stringify(clean.times) && JSON.stringify(a.packets) === JSON.stringify(clean.packets);
// The fixture: ftyp 0-31, mdat 40-28356, moov 28357-29494.
const CASES = [
    ['a 4 KiB hole in the frames (mdat)', { holes: [[8192, 12288]] }],
    ['a 4 KiB hole over the index (moov)', { holes: [[28672, 32768]] }],
    ['a 16 KiB page over mdat and moov', { holes: [[16384, 32768]] }],
    ['the first page (ftyp + the first frames)', { holes: [[0, 16384]] }],
    ['a read that fails over the moov', { fails: [[29000, 1]] }],
    ['a read that fails in the frames, and a hole', { fails: [[10000, 2]], holes: [[20480, 24576]] }],
];
for (const [label, faults] of CASES) {
    resetStats();
    const bad = await indexOf(unguarded(faultyBlob(video, faults)));
    const good = await indexOf(guardedRangeSource(faultyBlob(video, faults)));
    check(!same(bad), `${label}: negative control — unguarded ${bad.err ? 'fails (' + bad.err.slice(0, 60) + ')' : 'gives a different index or frames'}`);
    check(same(good), `${label}: guarded index and every packet equal the clean read`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
