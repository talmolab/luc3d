/**
 * Port of sleap-app tests/unit/tauriIrohBlob.test.ts @ 683a159 against
 * pose/connect/iroh-blob.js (fake `window.lucidDesktop.iroh` blob shim), plus
 * the LUCID additions: reads split at the 4 MiB Rust cap, raw-byte / number-array
 * replies, and `fetchBlobOverIroh` (whole-blob download, verified like the HTTP path).
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, run } from './connect-test-utils.mjs';
import { createIrohBlobRangeSource, fetchBlobOverIroh, validateBlobOpen, MAX_BLOB_RANGE, MAX_FETCH_BYTES } from '../pose/connect/iroh-blob.js';
import { BLOB_HASH_MISMATCH, BLOB_INCOMPLETE, WorkerProtocolError } from '../pose/connect/errors.js';

const hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const chunkHashes = (bytes, size) => {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(hex(bytes.subarray(i, i + size)));
  return out;
};

const CHUNK = 4;
const BLOB = new TextEncoder().encode("0123456789abcdefghij"); // 20 bytes, 5 chunks of 4

function makeFake(blob = BLOB, chunk = CHUNK, o = {}) {
  const calls = [];
  const iroh = {
    blobOpen: async (connId, sha256) => {
      calls.push({ cmd: "open", args: { connId, sha256 } });
      return { size: blob.length, chunkSize: chunk, chunkHashes: o.chunkHashes ?? chunkHashes(blob, chunk) };
    },
    blobReadRange: async (connId, offset, length) => {
      calls.push({ cmd: "read", args: { connId, offset, length } });
      if (length > MAX_BLOB_RANGE) throw new Error("blob read over the limit");
      if (o.onRead) return o.onRead(offset, length);
      const slice = blob.subarray(offset, Math.min(offset + length, blob.length));
      return o.asArray ? Array.from(slice) : o.asBuffer ? slice.slice().buffer : slice;
    },
    blobClose: async (connId) => { calls.push({ cmd: "close", args: { connId } }); },
  };
  return { iroh, calls };
}

describe("createIrohBlobRangeSource", () => {
  it("does not open a stream until the first readRange call", async () => {
    const { iroh, calls } = makeFake();
    createIrohBlobRangeSource(async () => iroh, 7, "abc123", BLOB.length);
    expect(calls.length).toBe(0);
  });

  it("opens lazily on first read and reuses the same session for later reads", async () => {
    const { iroh, calls } = makeFake();
    const { source } = createIrohBlobRangeSource(async () => iroh, 7, "abc123", BLOB.length);
    await source.readRange(0, 4);
    await source.readRange(4, 4);
    await source.readRange(8, 4);
    expect(calls.filter((c) => c.cmd === "open").length).toBe(1);
    expect(calls.filter((c) => c.cmd === "read").length).toBe(3);
  });

  it("returns exactly the requested bytes for a read entirely inside one chunk", async () => {
    const { iroh } = makeFake();
    const { source } = createIrohBlobRangeSource(async () => iroh, 7, "abc123", BLOB.length);
    expect(new TextDecoder().decode(await source.readRange(0, 4))).toBe("0123");
  });

  it("aligns a read spanning two chunks to the chunk boundary on the wire, returning only what was asked", async () => {
    const { iroh, calls } = makeFake();
    const { source } = createIrohBlobRangeSource(async () => iroh, 7, "abc123", BLOB.length);
    expect(new TextDecoder().decode(await source.readRange(6, 4))).toBe("6789");
    expect(calls.find((c) => c.cmd === "read").args).toEqual({ connId: 7, offset: 4, length: 8 });
  });

  it("aligns a read starting mid-chunk to the enclosing chunk on the wire", async () => {
    const { iroh, calls } = makeFake();
    const { source } = createIrohBlobRangeSource(async () => iroh, 7, "abc123", BLOB.length);
    expect(new TextDecoder().decode(await source.readRange(2, 1))).toBe("2");
    expect(calls.find((c) => c.cmd === "read").args).toEqual({ connId: 7, offset: 0, length: 4 });
  });

  it("throws BLOB_HASH_MISMATCH when the returned bytes don't match the registered chunk hash", async () => {
    const { iroh } = makeFake(BLOB, CHUNK, { chunkHashes: ["0".repeat(64), ...chunkHashes(BLOB, CHUNK).slice(1)] });
    const { source } = createIrohBlobRangeSource(async () => iroh, 7, "abc123", BLOB.length);
    let error;
    try { await source.readRange(0, 4); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(WorkerProtocolError);
    expect(error.code).toBe(BLOB_HASH_MISMATCH);
  });

  it("dispose() is a no-op if readRange was never called", async () => {
    const { iroh, calls } = makeFake();
    const { dispose } = createIrohBlobRangeSource(async () => iroh, 7, "abc123", BLOB.length);
    await dispose();
    expect(calls.length).toBe(0);
  });

  it("dispose() closes the stream once it was actually opened", async () => {
    const { iroh, calls } = makeFake();
    const { source, dispose } = createIrohBlobRangeSource(async () => iroh, 7, "abc123", BLOB.length);
    await source.readRange(0, 4);
    await dispose();
    expect(calls.filter((c) => c.cmd === "close").length).toBe(1);
  });

  it("names its connection on every blob command", async () => {
    const { iroh, calls } = makeFake();
    const { source, dispose } = createIrohBlobRangeSource(async () => iroh, 7, "abc123", BLOB.length);
    await source.readRange(0, 4);
    await dispose();
    expect(calls.map((c) => c.args.connId)).toEqual([7, 7, 7]);
  });

  it("accepts a number array or an ArrayBuffer reply (both wires)", async () => {
    for (const o of [{ asArray: true }, { asBuffer: true }]) {
      const { iroh } = makeFake(BLOB, CHUNK, o);
      const { source } = createIrohBlobRangeSource(async () => iroh, 7, "x", BLOB.length);
      expect(new TextDecoder().decode(await source.readRange(6, 4))).toBe("6789");
    }
  });

  it("splits a window over the 4 MiB cap into whole-chunk pieces and reassembles it", async () => {
    const chunk = 256 * 1024; // the worker's VERIFY_CHUNK_SIZE
    const size = 9 * 1024 * 1024 + 123;
    const blob = new Uint8Array(size).map((_, i) => (i * 31 + (i >> 10)) & 255);
    const { iroh, calls } = makeFake(blob, chunk);
    const { source } = createIrohBlobRangeSource(async () => iroh, 3, "big", size);
    const got = await source.readRange(100, size - 200);
    expect(hex(got)).toBe(hex(blob.subarray(100, size - 100)));
    const reads = calls.filter((c) => c.cmd === "read");
    expect(reads.length).toBe(3); // 4 + 4 + 1.x MiB
    for (const r of reads) {
      expect(r.args.length <= MAX_BLOB_RANGE).toBe(true);
      expect(r.args.offset % chunk).toBe(0);
    }
  });
});

describe("fetchBlobOverIroh", () => {
  it("returns the whole blob, verified, and closes the stream", async () => {
    const { iroh, calls } = makeFake();
    const got = await fetchBlobOverIroh(async () => iroh, 5, hex(BLOB), BLOB.length);
    expect(new TextDecoder().decode(got)).toBe("0123456789abcdefghij");
    expect(calls.map((c) => c.cmd)).toEqual(["open", "read", "close"]);
    expect(calls.every((c) => c.args.connId === 5)).toBe(true);
  });

  it("reports progress (done, total) and lets onProgress throw to cancel", async () => {
    const chunk = 256 * 1024;
    const blob = new Uint8Array(chunk * 40 + 5).map((_, i) => i & 255); // > 10 MiB = 3 reads
    const { iroh, calls } = makeFake(blob, chunk);
    const seen = [];
    await fetchBlobOverIroh(async () => iroh, 1, hex(blob), blob.length, { onProgress: (d, t) => seen.push([d, t]) });
    expect(seen.length).toBe(3);
    expect(seen[seen.length - 1]).toEqual([blob.length, blob.length]);
    // Cancel: a throw from onProgress stops reading and still closes the stream.
    const f2 = makeFake(blob, chunk);
    let err;
    try {
      await fetchBlobOverIroh(async () => f2.iroh, 1, hex(blob), blob.length, { onProgress: () => { throw new Error("Cancelled"); } });
    } catch (e) { err = e; }
    expect(err.message).toBe("Cancelled");
    expect(f2.calls.filter((c) => c.cmd === "read").length).toBe(1);
    expect(f2.calls[f2.calls.length - 1].cmd).toBe("close");
    expect(calls.length > 0).toBe(true);
  });

  it("a size that differs from the expected size is BLOB_INCOMPLETE", async () => {
    const { iroh } = makeFake();
    let err;
    try { await fetchBlobOverIroh(async () => iroh, 1, hex(BLOB), 999); } catch (e) { err = e; }
    expect(err.code).toBe(BLOB_INCOMPLETE);
  });

  it("a whole-file hash that differs from the expected sha256 is BLOB_HASH_MISMATCH (chunks all verify)", async () => {
    const { iroh } = makeFake();
    let err;
    try { await fetchBlobOverIroh(async () => iroh, 1, "f".repeat(64), BLOB.length); } catch (e) { err = e; }
    expect(err.code).toBe(BLOB_HASH_MISMATCH);
  });

  it("a corrupted chunk is BLOB_HASH_MISMATCH naming the chunk", async () => {
    const bad = BLOB.slice(); bad[9] ^= 0xff;
    const { iroh } = makeFake(BLOB, CHUNK, { onRead: (o, l) => bad.subarray(o, o + l) });
    let err;
    try { await fetchBlobOverIroh(async () => iroh, 1, hex(BLOB), BLOB.length); } catch (e) { err = e; }
    expect(err.code).toBe(BLOB_HASH_MISMATCH);
    expect(err.message).toContain("chunk 2");
  });

  it("a short read is BLOB_INCOMPLETE; an unknown blob (open throws) never reads or closes", async () => {
    const short = makeFake(BLOB, CHUNK, { onRead: (o, l) => BLOB.subarray(o, o + l - 1) });
    let err;
    try { await fetchBlobOverIroh(async () => short.iroh, 1, hex(BLOB), BLOB.length); } catch (e) { err = e; }
    expect(err.code).toBe(BLOB_INCOMPLETE);
    const f = makeFake();
    f.iroh.blobOpen = async () => { throw new Error("not_found"); };
    let err2;
    try { await fetchBlobOverIroh(async () => f.iroh, 1, hex(BLOB), BLOB.length); } catch (e) { err2 = e; }
    expect(err2.message).toBe("not_found");
    expect(f.calls.length).toBe(0);
  });

  it("an empty blob is fine", async () => {
    const empty = new Uint8Array(0);
    const { iroh } = makeFake(empty);
    const got = await fetchBlobOverIroh(async () => iroh, 1, hex(empty), 0);
    expect(got.length).toBe(0);
  });
});

describe("P8 stress review: a hostile or broken worker's open reply", () => {
  const code = async (fn) => { try { await fn(); } catch (e) { return e.code; } return null; };

  it("validateBlobOpen refuses a size, chunk size or hash list that cannot be right", async () => {
    const ok = { size: 8, chunkSize: 4, chunkHashes: ["a", "b"] };
    expect(validateBlobOpen("h", ok).size).toBe(8);
    for (const bad of [
      null, "x", {}, { ...ok, size: -1 }, { ...ok, size: 1.5 }, { ...ok, size: Infinity }, { ...ok, size: NaN },
      { ...ok, size: "8" }, { ...ok, chunkSize: 0 }, { ...ok, chunkSize: -4 }, { ...ok, chunkSize: 2.5 },
      { ...ok, chunkSize: NaN }, { ...ok, chunkHashes: ["a"] }, { ...ok, chunkHashes: null }, { ...ok, chunkHashes: "ab" },
      { ...ok, size: 2 ** 60, chunkHashes: [] },
    ]) {
      expect(await code(async () => validateBlobOpen("h", bad))).toBe(BLOB_INCOMPLETE);
    }
    expect(validateBlobOpen("h", { size: 0, chunkSize: 4, chunkHashes: [] }).size).toBe(0);
  });

  it("a whole-blob fetch refuses a claimed size over MAX_FETCH_BYTES instead of allocating it", async () => {
    const huge = MAX_FETCH_BYTES + 1;
    const n = Math.ceil(huge / (1 << 20));
    const iroh = {
      blobOpen: async () => ({ size: huge, chunkSize: 1 << 20, chunkHashes: new Array(n).fill("0") }),
      blobReadRange: async () => { throw new Error("must not read"); },
      blobClose: async () => {},
    };
    expect(await code(() => fetchBlobOverIroh(async () => iroh, 1, "a".repeat(64), undefined))).toBe(BLOB_INCOMPLETE);
  });

  it("a whole-blob fetch with a malformed open reply (chunkSize 0) fails cleanly, never loops", async () => {
    let reads = 0;
    const iroh = {
      blobOpen: async () => ({ size: 8, chunkSize: 0, chunkHashes: [] }),
      blobReadRange: async () => { reads++; return new Uint8Array(0); },
      blobClose: async () => {},
    };
    expect(await code(() => fetchBlobOverIroh(async () => iroh, 1, "a".repeat(64), 8))).toBe(BLOB_INCOMPLETE);
    expect(reads).toBe(0);
  });

  it("a reply longer than asked is refused, not written past the buffer", async () => {
    const size = 6 * 1024 * 1024; // two reads
    const blob = new Uint8Array(size);
    const { iroh } = makeFake(blob, 1 << 20, { onRead: (o, l) => new Uint8Array(l + 5) });
    expect(await code(() => fetchBlobOverIroh(async () => iroh, 1, hex(blob), size))).toBe(BLOB_INCOMPLETE);
  });

  it("a chunk bigger than the 4 MiB cap is read in several pieces and verified", async () => {
    const chunk = 5 * 1024 * 1024;
    const size = 2 * chunk + 17;
    const blob = new Uint8Array(size).map((_, i) => (i * 7) & 255);
    const { iroh, calls } = makeFake(blob, chunk);
    const got = await fetchBlobOverIroh(async () => iroh, 1, hex(blob), size);
    expect(hex(got)).toBe(hex(blob));
    for (const r of calls.filter((c) => c.cmd === "read")) expect(r.args.length <= MAX_BLOB_RANGE).toBe(true);
  });

  it("an upper-case blob id is lowercased before it reaches Rust; upper-case chunk hashes still verify", async () => {
    const { iroh, calls } = makeFake(BLOB, CHUNK, { chunkHashes: chunkHashes(BLOB, CHUNK).map((h) => h.toUpperCase()) });
    const got = await fetchBlobOverIroh(async () => iroh, 1, hex(BLOB).toUpperCase(), BLOB.length);
    expect(hex(got)).toBe(hex(BLOB));
    expect(calls.find((c) => c.cmd === "open").args.sha256).toBe(hex(BLOB));
  });
});

describe("P8 stress review: the range source", () => {
  it("a failed open is not cached: the next read opens again", async () => {
    let opens = 0;
    const { iroh } = makeFake();
    const realOpen = iroh.blobOpen;
    iroh.blobOpen = async (...a) => { if (++opens === 1) throw new Error("worker busy"); return realOpen(...a); };
    const { source } = createIrohBlobRangeSource(async () => iroh, 1, "abc", BLOB.length);
    let first;
    try { await source.readRange(0, 4); } catch (e) { first = e; }
    expect(first.message).toBe("worker busy");
    expect(Array.from(await source.readRange(0, 4))).toEqual(Array.from(BLOB.subarray(0, 4)));
    expect(opens).toBe(2);
  });

  it("an open reply whose size differs from the expected size is refused", async () => {
    const { iroh } = makeFake();
    const { source } = createIrohBlobRangeSource(async () => iroh, 1, "abc", BLOB.length + 1);
    let err;
    try { await source.readRange(0, 4); } catch (e) { err = e; }
    expect(err.code).toBe(BLOB_INCOMPLETE);
  });

  it("refuses negative, fractional and past-the-end ranges; length 0 is empty and sends nothing", async () => {
    const { iroh, calls } = makeFake();
    const { source } = createIrohBlobRangeSource(async () => iroh, 1, "abc", BLOB.length);
    for (const [o, l] of [[-1, 4], [0, -4], [0.5, 4], [0, 1.5], [18, 10], [BLOB.length, 1], [Number.MAX_SAFE_INTEGER, 1], [NaN, 1]]) {
      let err;
      try { await source.readRange(o, l); } catch (e) { err = e; }
      expect(err instanceof RangeError).toBe(true);
    }
    expect((await source.readRange(3, 0)).length).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("concurrent reads each return their own bytes", async () => {
    const { iroh } = makeFake();
    const { source } = createIrohBlobRangeSource(async () => iroh, 1, "abc", BLOB.length);
    const parts = await Promise.all([source.readRange(0, 4), source.readRange(8, 4), source.readRange(16, 4), source.readRange(2, 10)]);
    expect(parts.map((p) => new TextDecoder().decode(p))).toEqual(["0123", "89ab", "ghij", "23456789ab"]);
  });
});

describe("fetchBlobOverIroh on one connection", () => {
  // One blob slot per connection, like Rust: open replaces it, close clears it.
  const slotFake = (blobs, failOpenFor = new Set()) => {
    let slot = null;
    const tick = () => new Promise((r) => setTimeout(r, 2));
    return {
      blobOpen: async (_c, sha) => {
        await tick();
        if (failOpenFor.has(sha)) throw new Error("open failed");
        const blob = blobs[sha];
        slot = blob;
        return { size: blob.length, chunkSize: 4, chunkHashes: chunkHashes(blob, 4) };
      },
      blobReadRange: async (_c, offset, length) => { await tick(); return slot.slice(offset, offset + length); },
      blobClose: async () => { await tick(); slot = null; },
    };
  };
  const A = new TextEncoder().encode("AAAAAAAAAAAAAAAAAAAA");
  const B = new TextEncoder().encode("bbbbbbbbbbbbbbbbbbbbbbbb");

  it("two overlapping fetches on one connection id both succeed with their own bytes", async () => {
    const iroh = slotFake({ [hex(A)]: A, [hex(B)]: B });
    const [a, b] = await Promise.all([
      fetchBlobOverIroh(async () => iroh, 9, hex(A), A.length),
      fetchBlobOverIroh(async () => iroh, 9, hex(B), B.length),
    ]);
    expect(new TextDecoder().decode(a)).toBe("AAAAAAAAAAAAAAAAAAAA");
    expect(new TextDecoder().decode(b)).toBe("bbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("a failing first fetch does not break the second", async () => {
    const iroh = slotFake({ [hex(A)]: A, [hex(B)]: B }, new Set([hex(A)]));
    const first = fetchBlobOverIroh(async () => iroh, 9, hex(A), A.length);
    const second = fetchBlobOverIroh(async () => iroh, 9, hex(B), B.length);
    let err;
    try { await first; } catch (e) { err = e; }
    expect(err.message).toBe("open failed");
    expect(new TextDecoder().decode(await second)).toBe("bbbbbbbbbbbbbbbbbbbbbbbb");
  });
});

run();
