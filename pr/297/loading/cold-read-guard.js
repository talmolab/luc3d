/**
 * cold-read-guard.js — Blob reads that survive cloud files still downloading.
 *
 * In a folder synced by Google Drive for desktop on macOS (File Provider), a
 * read of a part of a file that has not been downloaded yet can go wrong in
 * two ways, with nothing else amiss (both measured 2026-10-19):
 *
 *   - it FAILS: `arrayBuffer()` rejects (NotReadableError) and a Blob stream
 *     errors with `TypeError: network error`. On cold 8-camera loads this cost
 *     2 of 48 cameras their frame-accurate decoder (they stepped by `<video>`
 *     seeks after that). 30 of 31 failed reads succeeded when read again at
 *     once.
 *   - it returns a run of ZEROS with every other byte right: the first 64 KiB
 *     of a read that starts on a 1 MiB boundary of the file where nothing is
 *     downloaded yet (by `arrayBuffer()` and by stream alike), 16 KiB pages in
 *     h5wasm's `.slp` reads (which the `LUCID local patch (cold-read)` in
 *     lib/h5wasm guards). A re-read returned the real bytes every time.
 *
 * Drive fetches a video only in the ranges that are read, so every seek into a
 * part of a video nobody has looked at yet is such a read, not just the load.
 *
 * `readBlobRange` is a Blob read that handles both:
 *   - a read that throws is tried again, after `COLD_READ_RETRY_MS` delays,
 *     before the last error is rethrown;
 *   - every part of a read that came back all zero (per 4 KiB block of the
 *     FILE, clipped to the read; neighbouring blocks merged) is read again
 *     TOGETHER WITH THE 4 KiB BLOCK ON EACH SIDE OF IT, and the re-read is
 *     copied in only where the first read gave a zero byte — the same rule as
 *     h5wasm's `lucidColdReadGuard`, so a re-read can never make a read worse.
 *     The neighbours are there because a run of zeros need not start or end on
 *     a block boundary: the block where it ends part-way (zeros, then real
 *     bytes) is not all zero, so re-reading only the all-zero blocks left its
 *     zeros in place — on cold 167 MB `.slp` files through h5wasm's copy of
 *     the rule, every wrong block was that one (93 of 93). The repaired bytes
 *     are checked again the same way, at most three re-reads deep. Bytes that
 *     really are zero cost one small re-read.
 *
 * No imports, so a Node test can load it (tests/test-cold-read-guard.mjs).
 */

export const COLD_READ_BLOCK = 4096;

/** Delays before each retry of a read that threw; the error stands after the last. */
export const COLD_READ_RETRY_MS = [200, 1000, 3000];

/** Page-wide counts (for the console and tests): zero runs re-read / repaired, reads retried / rescued. */
export const coldReadStats = { rereads: 0, recovered: 0, retries: 0, rescued: 0 };

/**
 * The all-zero parts of `bytes`, which were read from file offset `position`:
 * `[start, end)` file ranges, per 4 KiB block of the file clipped to the read,
 * neighbouring blocks merged. Empty when no block is all zero.
 * @param {Uint8Array} bytes
 * @param {number} position
 * @returns {Array<[number, number]>}
 */
export function zeroRuns(bytes, position) {
    var runs = [];
    var end = position + bytes.length;
    for (var b = position - position % COLD_READ_BLOCK; b < end; b += COLD_READ_BLOCK) {
        var lo = b > position ? b : position;
        var hi = b + COLD_READ_BLOCK < end ? b + COLD_READ_BLOCK : end;
        var zero = true;
        for (var q = lo - position, qe = hi - position; q < qe; q++) {
            if (bytes[q] !== 0) { zero = false; break; }
        }
        if (!zero) continue;
        var last = runs[runs.length - 1];
        if (last && last[1] === lo) last[1] = hi;
        else runs.push([lo, hi]);
    }
    return runs;
}

function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
}

function nameOf(blob) {
    return (blob && blob.name) || 'file';
}

/** `[start, end)` of `blob` as bytes, trying again when the read throws. */
async function readRetrying(blob, start, end) {
    for (var attempt = 0; ; attempt++) {
        try {
            var bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer());
            if (attempt > 0) {
                coldReadStats.rescued++;
                console.warn('[cold-read] ' + nameOf(blob) + ' bytes ' + start + '-' + end + ' read on try '
                    + (attempt + 1) + ' (file still downloading?)');
            }
            return bytes;
        } catch (e) {
            if (attempt >= COLD_READ_RETRY_MS.length) throw e;
            coldReadStats.retries++;
            await sleep(COLD_READ_RETRY_MS[attempt]);
        }
    }
}

/**
 * Re-read every all-zero part of `bytes` (read from `position` of `blob`),
 * with the 4 KiB block on each side of it, and put the real bytes in place, in
 * `bytes` itself: a re-read byte is copied in only where `bytes` holds a zero.
 * @param {Blob} blob
 * @param {Uint8Array} bytes
 * @param {number} position
 * @param {number} [depth]
 * @returns {Promise<Uint8Array>} `bytes`
 */
export async function repairZeroRuns(blob, bytes, position, depth) {
    depth = depth || 0;
    var end = position + bytes.length;
    var runs = zeroRuns(bytes, position);
    for (var i = 0; i < runs.length; i++) {
        // A run need not end (or start) on a block boundary: the partly-zero
        // block on each side is read again with it.
        var from = Math.max(position, runs[i][0] - COLD_READ_BLOCK);
        var to = Math.min(end, runs[i][1] + COLD_READ_BLOCK);
        var again = await readRetrying(blob, from, to);
        coldReadStats.rereads++;
        var fixed = 0;
        for (var k = 0, at = from - position, n = Math.min(again.length, to - from); k < n; k++, at++) {
            if (bytes[at] === 0 && again[k] !== 0) { bytes[at] = again[k]; fixed++; }
        }
        if (!fixed) continue;
        coldReadStats.recovered++;
        console.warn('[cold-read] ' + nameOf(blob) + ' bytes ' + from + '-' + to
            + ' first read as zeros were read again (file still downloading?)');
        // The re-read can carry a hole of its own.
        if (depth < 2) await repairZeroRuns(blob, bytes.subarray(from - position, to - position), from, depth + 1);
    }
    return bytes;
}

/**
 * Bytes `[start, end)` of `blob`, retried when the read throws and with every
 * all-zero part re-read (see the module comment).
 * @param {Blob} blob
 * @param {number} start
 * @param {number} end
 * @returns {Promise<Uint8Array>}
 */
export async function readBlobRange(blob, start, end) {
    var bytes = await readRetrying(blob, start, end);
    return repairZeroRuns(blob, bytes, start);
}

/**
 * The whole of `blob` as an ArrayBuffer, guarded like `readBlobRange` —
 * `blob.arrayBuffer()` for files that may be in a cloud-synced folder.
 * @param {Blob} blob
 * @returns {Promise<ArrayBuffer>}
 */
export async function readBlobArrayBuffer(blob) {
    return (await readBlobRange(blob, 0, blob.size)).buffer;
}

/** guardedRangeSource reads whole aligned windows of this size ... */
export const RANGE_WINDOW_BYTES = 1 << 20;
/** ... and keeps the most recent ones up to this many bytes. */
export const RANGE_CACHE_BYTES = 4 << 20;

/**
 * A `{ size, readRange(start, length) }` range source over `blob` whose reads
 * are guarded like `readBlobRange` — the shape sleap-io.js's
 * `MediaBunnyVideoBackend.fromRangeSource` takes (it drives mediabunny's
 * `StreamSource` with it), so the video decoder reads a File through the
 * guard instead of through mediabunny's own `BlobSource`.
 *
 * mediabunny asks a `StreamSource` for ~64–192 KiB at a time, and a Blob read
 * costs about the same however small it is: one read per request made reading
 * packets ~6x slower than `BlobSource`, which streams. So a request is served
 * from a `RANGE_WINDOW_BYTES`-aligned window read whole (one guarded read per
 * window, the last few kept), and sequential reads cost one Blob read per MiB.
 * A request is answered with a copy, so mediabunny's own cache never pins a
 * whole window.
 * @param {Blob} blob
 * @param {{ windowBytes?: number, cacheBytes?: number }} [opts]
 */
export function guardedRangeSource(blob, opts) {
    var W = (opts && opts.windowBytes) || RANGE_WINDOW_BYTES;
    var cap = (opts && opts.cacheBytes) || RANGE_CACHE_BYTES;
    var size = blob.size;
    var windows = [];   // { start, end, bytes: Promise<Uint8Array> }, most recently used last

    function lookup(start, end) {
        for (var i = windows.length - 1; i >= 0; i--) {
            var w = windows[i];
            if (w.start <= start && end <= w.end) {
                if (i !== windows.length - 1) { windows.splice(i, 1); windows.push(w); }
                return w;
            }
        }
        return null;
    }

    function load(start, end) {
        var w = { start: Math.floor(start / W) * W, end: Math.min(size, Math.ceil(end / W) * W), bytes: null };
        w.bytes = readBlobRange(blob, w.start, w.end);
        // a failed read must not stay cached: the next request reads again
        w.bytes.catch(function () { var i = windows.indexOf(w); if (i >= 0) windows.splice(i, 1); });
        windows.push(w);
        var held = 0;
        for (var i = windows.length - 1; i >= 0; i--) {
            held += windows[i].end - windows[i].start;
            if (held > cap && i < windows.length - 1) { windows.splice(0, i + 1); break; }
        }
        return w;
    }

    return {
        size: size,
        readRange: async function (start, length) {
            var end = start + length;
            var w = lookup(start, end) || load(start, end);
            var bytes = await w.bytes;
            return bytes.slice(start - w.start, end - w.start);
        },
    };
}
