/**
 * Port of sleap-app src/lib/protocolV1/tauriIrohBlob.ts @ 683a159.
 *
 * Reads a worker's result blob over a dedicated iroh QUIC stream
 * (`iroh_blob_open` / `iroh_blob_read_range` / `iroh_blob_close`,
 * `src-tauri/src/iroh_client.rs`), never one stream per read: the stream is
 * opened once and reused. Chunk alignment and verification live HERE, not in
 * Rust (which stays a byte pipe): the worker registers one sha256 per
 * `chunkSize`-aligned chunk when the file was known-good, and every byte read
 * is checked against that list before it is returned (`crypto.subtle`).
 *
 * LUCID changes:
 *  - The IPC is `window.lucidDesktop.iroh` (the shim), injected as `getIroh`
 *    so Node tests fake it. `blobReadRange` resolves to a `Uint8Array`/
 *    `ArrayBuffer` (Rust sends raw bytes) or a number array (sleap-app's wire);
 *    both are accepted.
 *  - The Rust command refuses a read over `MAX_BLOB_RANGE` (4 MiB), so an
 *    aligned window is read in pieces of at most that size (a whole number of
 *    chunks, whatever the worker's `chunkSize`).
 *  - ADDED `fetchBlobOverIroh`: sleap-app streams the blob straight into
 *    `readSlpStreaming` (`createIrohBlobRangeSource`, ported as is); LUCID's
 *    Fetch & Load hands a whole `File` to `mergeViewPredictions`, so the
 *    equivalent of `WorkerClient.fetchBlob` over iroh reads the blob front to
 *    back, verifies every chunk AND the size and whole-file sha256 (like the
 *    HTTP path: `BLOB_INCOMPLETE` / `BLOB_HASH_MISMATCH`) and returns the bytes.
 *  - Plain JS; the types are JSDoc.
 *  - `fetchBlobOverIroh` calls on one connection id are serialized (one blob
 *    stream slot per connection). The range source does not open streams per
 *    call but holds the slot while open: don't run it alongside a fetch on the
 *    same connection.
 *  - P8 stress review: the worker's open reply is validated before anything is
 *    sized from it (`size` a safe integer within `MAX_FETCH_BYTES`, `chunkSize` a
 *    positive integer, one hash per chunk), a whole blob is refused over
 *    `MAX_FETCH_BYTES` rather than allocated; a failed open is not cached by the
 *    range source (the next read retries it); a chunk larger than the 4 MiB cap is
 *    read in several pieces; `readRange` refuses a negative/fractional/past-EOF
 *    range; hashes compare case-insensitively and the blob id is lowercased before
 *    it reaches Rust (which accepts only lowercase hex).
 */
import { WorkerProtocolError, BLOB_HASH_MISMATCH, BLOB_INCOMPLETE } from "./errors.js?v=82449baaa3c2";

/** Largest single `iroh_blob_read_range` (matches `MAX_BLOB_RANGE` in iroh_client.rs). */
export const MAX_BLOB_RANGE = 4 * 1024 * 1024;

/** Largest blob `fetchBlobOverIroh` allocates (a typed array cannot be much bigger). */
export const MAX_FETCH_BYTES = 2 * 1024 * 1024 * 1024 - 1;

/**
 * The worker's open reply, checked before anything is sized from it.
 * @param {string} sha256 @param {any} open
 * @returns {{size: number, chunkSize: number, chunkHashes: string[]}}
 */
export function validateBlobOpen(sha256, open) {
  const bad = (why) => new WorkerProtocolError(BLOB_INCOMPLETE, `Blob ${sha256}: malformed open reply (${why})`);
  if (!open || typeof open !== "object") throw bad("not an object");
  const { size, chunkSize, chunkHashes } = open;
  if (!Number.isSafeInteger(size) || size < 0) throw bad("size");
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw bad("chunkSize");
  if (!Array.isArray(chunkHashes) || chunkHashes.length !== Math.ceil(size / chunkSize)) {
    throw bad("chunkHashes");
  }
  return { size, chunkSize, chunkHashes };
}

/**
 * The slice of `window.lucidDesktop.iroh` the blob path needs.
 * @typedef {object} IrohBlobShim
 * @property {(connId: number, sha256: string) => Promise<{size: number, chunkSize: number, chunkHashes: string[]}>} blobOpen
 * @property {(connId: number, offset: number, length: number) => Promise<Uint8Array | ArrayBuffer | ArrayLike<number>>} blobReadRange
 * @property {(connId: number) => Promise<unknown>} blobClose
 */

/** @param {Uint8Array | ArrayBuffer | ArrayLike<number>} raw */
function toBytes(raw) {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return Uint8Array.from(raw);
}

/** @param {Uint8Array} bytes */
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Reads the chunk-aligned window `[alignedOffset, alignedOffset + alignedLength)`
 * in pieces of at most `MAX_BLOB_RANGE`, each a whole number of chunks.
 *
 * @param {IrohBlobShim} iroh @param {number} connId
 * @param {number} chunkSize @param {number} alignedOffset @param {number} alignedLength
 * @returns {Promise<Uint8Array>}
 */
async function readAligned(iroh, connId, chunkSize, alignedOffset, alignedLength) {
  // Pieces of at most MAX_BLOB_RANGE (the Rust cap), whatever the chunk size:
  // verification runs on the assembled window, so a piece need not be aligned.
  const piece = MAX_BLOB_RANGE;
  if (alignedLength <= piece) {
    return toBytes(await iroh.blobReadRange(connId, alignedOffset, alignedLength));
  }
  const out = new Uint8Array(alignedLength);
  let done = 0;
  while (done < alignedLength) {
    const want = Math.min(piece, alignedLength - done);
    const got = toBytes(await iroh.blobReadRange(connId, alignedOffset + done, want));
    if (got.length > want) {
      throw new WorkerProtocolError(BLOB_INCOMPLETE, `Blob read returned ${got.length} bytes for a ${want}-byte request`);
    }
    out.set(got, done);
    done += got.length;
    if (got.length < want) break; // short read: the caller's hash check names it
  }
  return out.subarray(0, done);
}

/**
 * @param {Uint8Array} window the aligned bytes @param {number} firstChunk
 * @param {number} lastChunk @param {number} chunkSize @param {string[]} chunkHashes @param {string} sha256
 */
async function verifyChunks(window, firstChunk, lastChunk, chunkSize, chunkHashes, sha256) {
  for (let c = firstChunk; c <= lastChunk; c++) {
    const start = (c - firstChunk) * chunkSize;
    const end = Math.min(start + chunkSize, window.length);
    const actual = await sha256Hex(window.subarray(start, end));
    if (actual !== String(chunkHashes[c]).toLowerCase()) {
      throw new WorkerProtocolError(
        BLOB_HASH_MISMATCH,
        `Blob ${sha256} chunk ${c}: expected ${chunkHashes[c]}, got ${actual}`,
      );
    }
  }
}

/**
 * A sleap-io.js `RangeSource` (`{size, readRange(offset, length)}`) for one
 * blob over iroh connection `connId` (`WorkerClient.irohConnectionId`; each
 * connection has its own blob stream slot in Rust), plus a `dispose()` the
 * caller MUST run when done.
 *
 * @param {() => IrohBlobShim | Promise<IrohBlobShim>} getIroh
 * @param {number} connId @param {string} sha256 @param {number} size
 * @returns {{ source: {size: number, readRange: (offset: number, length: number) => Promise<Uint8Array>}, dispose: () => Promise<void> }}
 */
export function createIrohBlobRangeSource(getIroh, connId, sha256, size) {
  sha256 = String(sha256).toLowerCase();
  /** @type {Promise<{size: number, chunkSize: number, chunkHashes: string[]}> | null} */
  let opened = null;
  const ensureOpen = (iroh) => {
    if (!opened) {
      const attempt = Promise.resolve(iroh.blobOpen(connId, sha256)).then((open) => {
        const checked = validateBlobOpen(sha256, open);
        if (checked.size !== size) {
          throw new WorkerProtocolError(BLOB_INCOMPLETE, `Blob ${sha256}: expected ${size} bytes, got ${checked.size}`);
        }
        return checked;
      });
      opened = attempt;
      // A failed open is not remembered: the next read tries again.
      attempt.catch(() => { if (opened === attempt) opened = null; });
    }
    return opened;
  };

  return {
    source: {
      size,
      readRange: async (offset, length) => {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
          throw new RangeError(`Invalid blob range (${offset}, ${length})`);
        }
        if (length === 0) return new Uint8Array(0);
        if (offset + length > size) {
          throw new RangeError(`Blob range ${offset}+${length} is past the end (${size} bytes)`);
        }
        const iroh = await getIroh();
        const { chunkSize, chunkHashes } = await ensureOpen(iroh);
        // Expand to the chunk-aligned window so every response is checkable
        // in full; the Rust command does no alignment of its own.
        const firstChunk = Math.floor(offset / chunkSize);
        const lastChunk = Math.floor((offset + length - 1) / chunkSize);
        const alignedOffset = firstChunk * chunkSize;
        const alignedLength = Math.min(size, (lastChunk + 1) * chunkSize) - alignedOffset;
        const window = await readAligned(iroh, connId, chunkSize, alignedOffset, alignedLength);
        await verifyChunks(window, firstChunk, lastChunk, chunkSize, chunkHashes, sha256);
        return window.subarray(offset - alignedOffset, offset - alignedOffset + length);
      },
    },
    dispose: async () => {
      if (!opened) return; // never opened: nothing to close
      const iroh = await getIroh();
      await iroh.blobClose(connId);
    },
  };
}

/**
 * Each connection has ONE blob stream slot (Rust and worker side), so whole-blob
 * fetches on one connection id run one after the other; a failure does not stop
 * the next. Different connections run freely.
 * @type {Map<number, Promise<unknown>>}
 */
const fetchChains = new Map();
function serializeOnConnection(connId, task) {
  const prev = fetchChains.get(connId) ?? Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.catch(() => {});
  fetchChains.set(connId, tail);
  tail.then(() => { if (fetchChains.get(connId) === tail) fetchChains.delete(connId); });
  return run;
}

/**
 * The iroh counterpart of `WorkerClient.fetchBlob`: the whole blob, read front
 * to back over the connection's blob stream, every chunk checked against the
 * worker's chunk hashes and the result against `sha256` / `expectedSize`.
 *
 * @param {() => IrohBlobShim | Promise<IrohBlobShim>} getIroh
 * @param {number} connId
 * @param {string} sha256 expected content hash (lowercase hex)
 * @param {number | undefined} expectedSize
 * @param {{ onProgress?: (done: number, total: number) => void }} [options]  `onProgress` may throw to cancel.
 * @returns {Promise<Uint8Array>}
 */
export function fetchBlobOverIroh(getIroh, connId, sha256, expectedSize, options = {}) {
  return serializeOnConnection(connId, () => fetchBlobOnce(getIroh, connId, sha256, expectedSize, options));
}

async function fetchBlobOnce(getIroh, connId, sha256, expectedSize, options) {
  sha256 = String(sha256).toLowerCase();
  const iroh = await getIroh();
  let opened = false;
  try {
    const open = await iroh.blobOpen(connId, sha256);
    opened = true;
    const { size, chunkSize, chunkHashes } = validateBlobOpen(sha256, open);
    if (size > MAX_FETCH_BYTES) {
      throw new WorkerProtocolError(BLOB_INCOMPLETE, `Blob ${sha256} is ${size} bytes, over the ${MAX_FETCH_BYTES}-byte limit`);
    }
    if (expectedSize !== undefined && size !== expectedSize) {
      throw new WorkerProtocolError(
        BLOB_INCOMPLETE,
        `Blob ${sha256}: expected ${expectedSize} bytes, got ${size}`,
      );
    }
    const out = new Uint8Array(size);
    // Whole chunks per step, up to MAX_BLOB_RANGE, so each step verifies fully.
    const step = Math.max(chunkSize, Math.floor(MAX_BLOB_RANGE / chunkSize) * chunkSize);
    let offset = 0;
    while (offset < size) {
      const length = Math.min(step, size - offset);
      const window = await readAligned(iroh, connId, chunkSize, offset, length);
      if (window.length !== length) {
        throw new WorkerProtocolError(
          BLOB_INCOMPLETE,
          `Blob ${sha256}: read ${window.length} of ${length} bytes at offset ${offset}`,
        );
      }
      await verifyChunks(window, offset / chunkSize, Math.ceil((offset + length) / chunkSize) - 1, chunkSize, chunkHashes, sha256);
      out.set(window, offset);
      offset += length;
      if (options.onProgress) options.onProgress(offset, size);
    }
    const actual = await sha256Hex(out);
    if (actual !== sha256) {
      throw new WorkerProtocolError(
        BLOB_HASH_MISMATCH,
        `Blob content does not match its hash (expected ${sha256}, got ${actual})`,
      );
    }
    return out;
  } finally {
    if (opened) {
      try { await iroh.blobClose(connId); } catch (_) { /* connection gone: nothing to close */ }
    }
  }
}
