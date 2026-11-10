/**
 * Port of sleap-app tests/unit/pairCode.test.ts @ 683a159.
 * Pairing-code decoder against the shared vectors (pose/connect/pair-code.js).
 */
/**
 * PR6a §a.1 — `pairCode.ts`'s decode side of the one-line pairing code
 * format (protocol spec §3.2). `tests/fixtures/connect/pair_code_vectors.json` is a
 * byte-for-byte copy of sleap-connect's own
 * `tests/protocol_v1/pair_code_vectors.json` — the two suites assert
 * against the SAME fixture so a format drift between languages is always
 * caught.
 */
import { describe, it, expect, run } from './connect-test-utils.mjs';
import { decodePairCode, isPairCode, PairCodeError, RELAY_TABLE } from '../pose/connect/pair-code.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodePairCode, mistypeCode, b64urlEncode } from './connect/pair-code.mjs';

/** A deterministic byte array `seed, seed+1, ...` mod 256 (a fake node id / secret). */
const fakeBytes = (length, seed = 1) => new Uint8Array(Array.from({ length }, (_, i) => (seed + i) % 256));

// The same vectors sleap-connect's own suite asserts against.
const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/connect/pair_code_vectors.json', import.meta.url)), 'utf8'),
);

describe("isPairCode", () => {
  it("is true for a sleap1-prefixed string, whitespace/case tolerant", () => {
    expect(isPairCode("sleap1abc")).toBe(true);
    expect(isPairCode("  SLEAP1abc\n")).toBe(true);
  });

  it("is false for a pasted JSON ticket", () => {
    expect(isPairCode('{"node_id": "abc"}')).toBe(false);
    expect(isPairCode("")).toBe(false);
  });
});

describe("decodePairCode — shared vectors", () => {
  for (const vector of vectors) {
    it(vector.description, async () => {
      const ticket = await decodePairCode(vector.code);
      expect(ticket.node_id).toBe(vector.ticket.node_id);
      expect(ticket.secret).toBe(vector.ticket.secret);
      expect(ticket.expires_at).toBe(vector.ticket.expires_at);
      expect(ticket.addrs).toEqual(vector.ticket.addrs);
      if (vector.ticket.relay_url) {
        expect(ticket.iroh).toEqual({
          node_id: vector.ticket.node_id,
          relay_url: vector.ticket.relay_url,
          direct_addrs: [],
        });
      } else {
        expect(ticket.iroh).toBeUndefined();
      }
    });
  }

  it("is case-insensitive and whitespace-tolerant", async () => {
    const vector = vectors[0];
    const noisy = `  ${vector.code.toUpperCase()}\n`;
    const ticket = await decodePairCode(noisy);
    expect(ticket.node_id).toBe(vector.ticket.node_id);
  });

  it("known relay indices resolve into RELAY_TABLE", async () => {
    const vector = vectors.find((v) => v.description.includes("known relay"));
    const ticket = await decodePairCode(vector.code);
    const relayUrl = ticket.iroh?.relay_url;
    expect(relayUrl).toBe(vector.ticket.relay_url ?? undefined);
    expect(RELAY_TABLE).toContain(relayUrl);
  });
});

describe("decodePairCode — errors", () => {
  it("rejects a string with the wrong prefix", async () => {
    await expect(decodePairCode("notacode")).rejects.toThrow(PairCodeError);
    await expect(decodePairCode("notacode")).rejects.toThrow(/sleap-connect pairing code/);
  });

  it("rejects a truncated code", async () => {
    const short = "sleap1aeaqeayeaudaocajbi"; // valid prefix, far too short
    await expect(decodePairCode(short)).rejects.toThrow(PairCodeError);
    await expect(decodePairCode(short)).rejects.toThrow(/too short/);
  });

  it("rejects a mistyped code (bad checksum)", async () => {
    const mistyped = mistypeCode(vectors[0].code);
    await expect(decodePairCode(mistyped)).rejects.toThrow(PairCodeError);
    await expect(decodePairCode(mistyped)).rejects.toThrow(/incomplete or mistyped/);
  });

  it("rejects an unsupported format version", async () => {
    const code = await encodePairCode(
      {
        node_id: b64urlEncode(fakeBytes(32)),
        secret: b64urlEncode(fakeBytes(16, 101)),
        expires_at: 1700000000,
      },
      { version: 99 },
    );
    await expect(decodePairCode(code)).rejects.toThrow(PairCodeError);
    await expect(decodePairCode(code)).rejects.toThrow(/Unsupported pairing code version/);
  });
});

await run();
