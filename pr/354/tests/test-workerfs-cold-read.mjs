/**
 * test-workerfs-cold-read.mjs — a File that reads back with a page of zeros
 * must still parse to the same 2D (the h5wasm "cold-read" local patch).
 *
 * WHY: Track All gave different identities for the same session depending on
 * whether its folder was loaded cold or warm from Google Drive for desktop
 * (macOS File Provider). Measured 2026-10-19: while a file is still being
 * downloaded, a slice Chrome reads from it can come back with one 16 KiB page
 * of ZEROS in the middle and every other byte right. Nothing fails, so HDF5
 * parsed the zeros as data — 630 `pred_points` rows (42 instances x 15 nodes)
 * at (0, 0) per hole — and the tracker's association diverged from the first
 * zeroed frame on (21 of the 22 proofread SLAP sessions). A warm read of the
 * same file is always right.
 *
 * Both vendored h5wasm builds now re-read any all-zero part of a WORKERFS read
 * (`lucidColdReadGuard`, between the `LUCID local patch (cold-read)` markers):
 * a hole comes back as the real bytes, and bytes that really are zero cost one
 * small re-read. Every reader of a File through h5wasm goes through it — the
 * app's SLP worker (eager parse, lazy analysis .h5), frame-worker.js, and
 * sleap-io.js's streaming worker (lazy .slp), which loads the IIFE build.
 *
 * The holes here are injected by a fake FileReaderSync: the FIRST read that
 * covers a hole page gets zeros there, later reads the real bytes — the shape
 * of the measured failure. §4 drives the app's real `slp-import-worker.js`
 * over the committed SLEAP fixture, with a negative control (the unpatched
 * WORKERFS read) showing the same holes corrupt the parse.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ESM_PATH = path.join(ROOT, 'lib/h5wasm/hdf5_util.js');
const IIFE_PATH = path.join(ROOT, 'lib/h5wasm/h5wasm.iife.js');
const FIXTURE = path.join(ROOT, 'tests/fixtures/slp-compound/sleap-compound-small.slp');

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};

// WORKERFS.mount asserts it runs in a worker; the app's SLP worker posts its result.
globalThis.WorkerGlobalScope = function () {};
const posted = [];
globalThis.postMessage = (m) => posted.push(m);
globalThis.onmessage = null;
const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => { warnings.push(a.join(' ')); };

const PAGE = 16384;

/** A blob-like `contents` over `bytes`; `slice` returns a plain range, read by the fake reader below. */
function fakeContents(bytes, name) {
    return {
        name: name || 'x.slp', size: bytes.length, lastModifiedDate: new Date(0),
        slice(a, b) { const e = Math.min(b, bytes.length); return { start: a, end: e, size: e - a }; },
    };
}

/**
 * A FileReaderSync stand-in over `bytes`. Each page start in `holes` reads as
 * zeros the first time a read covers it (a page not yet downloaded) — or the
 * first `k` times, given as `[page, k]` — and as the real bytes after that.
 * `persistent` pages read as zeros every time.
 */
function fakeReader(bytes, holes, persistent) {
    const left = new Map((holes || []).map(h => Array.isArray(h) ? h : [h, 1]));
    const r = {
        calls: 0,
        readAsArrayBuffer(blob) {
            r.calls++;
            const out = bytes.slice(blob.start, blob.end);
            const zero = (p) => out.fill(0, Math.max(0, p - blob.start), Math.min(out.length, p + PAGE - blob.start));
            for (const [p, k] of left) {
                if (k <= 0 || p + PAGE <= blob.start || p >= blob.end) continue;
                left.set(p, k - 1);
                zero(p);
            }
            for (const p of persistent || []) if (p + PAGE > blob.start && p < blob.end) zero(p);
            return out.buffer;
        },
    };
    return r;
}

/** One WORKERFS read of [position, position + length) through `W` into a fresh heap-like Int8Array. */
function readVia(W, bytes, reader, position, length) {
    W.reader = reader;
    const heap = new Int8Array(length + 64);
    const stream = { node: { size: bytes.length, contents: fakeContents(bytes) } };
    const n = W.stream_ops.read(stream, heap, 32, length, position);
    return { n, got: new Uint8Array(heap.buffer, 32, n) };
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------------------
console.log('\n1. Both builds carry the same guard, and their WORKERFS read calls it');
const blockOf = (src) => {
    const a = src.indexOf('/* LUCID local patch (cold-read) BEGIN');
    const b = src.indexOf('/* LUCID local patch (cold-read) END */');
    return a >= 0 && b > a ? src.slice(a, b) : null;
};
const esmSrc = fs.readFileSync(ESM_PATH, 'utf8'), iifeSrc = fs.readFileSync(IIFE_PATH, 'utf8');
check(blockOf(esmSrc) !== null && blockOf(iifeSrc) !== null, 'both builds hold the cold-read block');
check(blockOf(esmSrc) === blockOf(iifeSrc), 'the block is byte-identical in hdf5_util.js and h5wasm.iife.js');
check(/buffer\.set\(new Uint8Array\(ab\),offset\);\/\* LUCID local patch \(cold-read\) \*\/lucidColdReadGuard\(WORKERFS,/.test(esmSrc),
    'hdf5_util.js: WORKERFS read calls the guard after copying the slice');
check(/buffer\.set\(new Uint8Array\(ab\), offset\);\n\s*lucidColdReadGuard\(WORKERFS, /.test(iifeSrc),
    'h5wasm.iife.js: WORKERFS read calls the guard after copying the slice');

// ---------------------------------------------------------------------------
const h5 = await import(path.join(ROOT, 'lib/h5wasm/hdf5_hl.js'));
await h5.ready;
const ctx = { console, WebAssembly, TextDecoder, TextEncoder, setTimeout, clearTimeout, URL, performance, crypto: globalThis.crypto };
ctx.self = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(iifeSrc, ctx);
await ctx.h5wasm.ready;
const BUILDS = [['hdf5_util.js (ESM)', h5.FS.filesystems.WORKERFS], ['h5wasm.iife.js', ctx.h5wasm.FS.filesystems.WORKERFS]];

// A file of non-zero bytes with one really-zero 4 KiB-aligned stretch.
const N = 6 * PAGE;
const data = new Uint8Array(N);
for (let i = 0; i < N; i++) data[i] = 1 + (i * 7919) % 251;
const REAL_ZERO = [5 * PAGE + 4096, 5 * PAGE + 12288];
data.fill(0, REAL_ZERO[0], REAL_ZERO[1]);

for (const [label, W] of BUILDS) {
    console.log(`\n2. ${label}: a hole is read again and comes back as the real bytes`);
    {
        // The measured shape: a read starting before a page boundary, the page after it zeroed.
        const r = fakeReader(data, [2 * PAGE]);
        warnings.length = 0;
        const { n, got } = readVia(W, data, r, 2 * PAGE - 4054, 28366);
        check(n === 28366, `returns the requested length (${n})`);
        check(sameBytes(got, data.subarray(2 * PAGE - 4054, 2 * PAGE - 4054 + 28366)), 'bytes equal the file');
        check(r.calls === 2, `one re-read (reader calls ${r.calls})`);
        check(warnings.length === 1 && /first read as zeros were read again/.test(warnings[0]), 'says so in the console');
    }
    {
        // A hole at the read's very start (partial 4 KiB block) and one at its end.
        const r = fakeReader(data, [PAGE, 3 * PAGE]);
        const { got } = readVia(W, data, r, PAGE + 1000, 2 * PAGE + 500);
        check(sameBytes(got, data.subarray(PAGE + 1000, 3 * PAGE + 1500)), 'holes at the read\'s edges are recovered too');
    }
    {
        // Two holes in one read, the second still missing on the first re-read.
        const r = fakeReader(data, [PAGE, [2 * PAGE, 2]]);
        const { got } = readVia(W, data, r, 0, 4 * PAGE);
        check(sameBytes(got, data.subarray(0, 4 * PAGE)), 'a hole the re-read still carries is read once more');
        check(r.calls === 3, `reader calls ${r.calls} (read, re-read, re-read of what was still zero)`);
    }

    console.log(`\n3. ${label}: what is not a hole costs nothing or one small re-read`);
    {
        const r = fakeReader(data, []);
        const { got } = readVia(W, data, r, 100, 3 * PAGE);
        check(sameBytes(got, data.subarray(100, 100 + 3 * PAGE)) && r.calls === 1, `no zeros, no re-read (reader calls ${r.calls})`);
    }
    {
        const r = fakeReader(data, []);
        warnings.length = 0;
        const { got } = readVia(W, data, r, 5 * PAGE, PAGE);
        check(sameBytes(got, data.subarray(5 * PAGE, 6 * PAGE)), 'really-zero bytes stay zero');
        check(r.calls === 2, `one re-read for the zero stretch (reader calls ${r.calls})`);
        check(warnings.length === 0, 'and no warning');
    }
    {
        // A page that never arrives stays zero: the guard gives up instead of looping.
        const r = fakeReader(data, [], [PAGE]);
        const { got } = readVia(W, data, r, PAGE, PAGE);
        check(got.every(v => v === 0) && r.calls === 2, `a persistent hole is re-read once, then left (reader calls ${r.calls})`);
    }
    {
        const r = fakeReader(data, [3 * PAGE]);
        const { n } = readVia(W, data, r, N - 10, 100);
        check(n === 10, 'a read past the end still returns only what exists');
    }
}

// ---------------------------------------------------------------------------
console.log('\n4. The app\'s SLP worker parses a cold file to the same 2D as a warm one');
const fixture = new Uint8Array(fs.readFileSync(FIXTURE));
await import(path.join(ROOT, 'loading/slp-import-worker.js'));
await new Promise(r => setTimeout(r, 50));       // the worker's h5wasm init drains its queue
const W = h5.FS.filesystems.WORKERFS;
const guardedRead = W.stream_ops.read;
// Upstream h5wasm 0.10.3's WORKERFS read, for the negative control.
const unguardedRead = function (stream, buffer, offset, length, position) {
    if (position >= stream.node.size) return 0;
    const chunk = stream.node.contents.slice(position, position + length);
    const ab = W.reader.readAsArrayBuffer(chunk);
    buffer.set(new Uint8Array(ab), offset);
    return chunk.size;
};
async function parse(holes, read) {
    W.stream_ops.read = read || guardedRead;
    W.reader = fakeReader(fixture, holes);
    posted.length = 0;
    try {
        await globalThis.onmessage({ data: { type: 'parse', file: fakeContents(fixture, 'cold.slp'), columnar: true } });
    } finally { W.stream_ops.read = guardedRead; }
    const res = posted.find(m => m.type === 'result');
    if (!res) throw new Error('no result: ' + JSON.stringify(posted.find(m => m.type === 'error')));
    return res.data.columnar;
}
const diff2d = (a, b) => {
    let d = 0, z = 0;
    for (let i = 0; i < a.xy.length; i += 2) {
        if (Object.is(a.xy[i], b.xy[i]) && Object.is(a.xy[i + 1], b.xy[i + 1])) continue;
        d++;
        if (b.xy[i] === 0 && b.xy[i + 1] === 0) z++;
    }
    return { d, z };
};
// The fixture's `pred_points` (2,700 rows x 26 B) spans file offsets 16,516-86,716:
// pages 32,768 and 49,152 lie inside it.
const HOLES = [2 * PAGE, 3 * PAGE];
const warm = await parse([]);
check(warm.nInstances === 190 && warm.xy.length === 190 * 15 * 2, `warm parse: ${warm.nInstances} instances`);
const unguarded = await parse(HOLES, unguardedRead);
const u = diff2d(warm, unguarded);
check(u.z === 2 * 630, `negative control — without the guard the two holes put ${u.z} points at (0, 0) (expected 1,260)`);
const cold = await parse(HOLES);
const c = diff2d(warm, cold);
check(c.d === 0, `with the guard the cold parse equals the warm one (${c.d} points differ)`);
check(cold.nInstances === warm.nInstances && sameBytes(new Uint8Array(cold.trackIdx.buffer), new Uint8Array(warm.trackIdx.buffer)),
    'same instances and tracks');

console.warn = realWarn;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
