/**
 * Port of sleap-app src/lib/protocolV1/pairCode.ts @ 683a159.
 *
 * One-line pairing codes (protocol spec §3.2). Decodes `sleap1` + lowercase,
 * unpadded RFC 4648 base32 of a small binary layout (version, node id, secret,
 * expiry, LAN addresses, iroh relay, 2-byte SHA-256 checksum). Exact mirror of
 * `sleap_rtc/protocol_v1/pair_code.py`, including the APPEND-ONLY
 * `RELAY_TABLE`. Only decoding lives here; the app never mints codes
 * (`tests/connect/pair-code.mjs` has a test-only encoder).
 * `tests/fixtures/connect/pair_code_vectors.json` holds the shared vectors.
 *
 * LUCID changes: none in behaviour (types became JSDoc; `RELAY_TABLE` is
 * frozen). Only `globalThis.crypto` / `btoa` are used, at call time.
 */
export const CODE_PREFIX = "sleap1";
const FORMAT_VERSION = 1;

// Mirrors `sleap_rtc/protocol_v1/pair_code.py`'s `RELAY_TABLE` EXACTLY —
// iroh's current default (n0) relay URLs. APPEND-ONLY: reordering or
// removing an entry would silently reinterpret already-minted, still-
// unexpired codes as the wrong relay. If iroh ever adds a region, only
// append it here AND in the Python copy at the same time.
export const RELAY_TABLE = Object.freeze([
  "https://aps1-1.relay.n0.iroh.link./",
  "https://euc1-1.relay.n0.iroh.link./",
  "https://use1-1.relay.n0.iroh.link./",
  "https://usw1-1.relay.n0.iroh.link./",
]);

const ADDR_TAG_IPV4 = 4;
const ADDR_TAG_IPV6 = 6;
const ADDR_TAG_URL = 0;

const RELAY_TAG_NONE = 0;
const RELAY_TAG_URL = 255;

const CHECKSUM_LEN = 2;
// version(1) + node_id(32) + secret(16) + expires_at(4) + addr count(1) +
// relay tag(1) + checksum(2) — the smallest a well-formed code's decoded
// body can be (no addrs, no relay).
const MIN_BODY_LEN = 1 + 32 + 16 + 4 + 1 + 1 + CHECKSUM_LEN;

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** A pairing code is malformed: bad prefix/version, truncated, or a bad checksum. */
export class PairCodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "PairCodeError";
  }
}

/** Internal-only: a low-level short-read, always converted to `PairCodeError`'s generic "too short" message by `decodePairCode`'s outer catch. */
class TruncatedCodeError extends Error {}

/**
 * The `iroh` section of a decoded ticket — see `build_iroh_section` (sleap-connect).
 * @typedef {object} DecodedPairingTicketIroh
 * @property {string} node_id
 * @property {string} relay_url
 * @property {string[]} direct_addrs Always empty — a pairing code never carries direct addresses.
 */

/**
 * What `decodePairCode` returns — the same shape `pairWithTicket` (connectStore.ts) consumes for a pasted JSON ticket.
 * @typedef {object} DecodedPairingTicket
 * @property {string} node_id
 * @property {string[]} addrs
 * @property {string} secret
 * @property {number} expires_at
 * @property {DecodedPairingTicketIroh} [iroh] Present only when the code carries a relay.
 */

/**
 * Whether `text` looks like a one-line pairing code rather than a pasted
 * JSON ticket — a cheap prefix check, no base32 decode or checksum
 * verification (that's `decodePairCode`'s job). Whitespace-tolerant and
 * case-insensitive, matching `decodePairCode`'s own normalization.
 */
export function isPairCode(text) {
  return text.trim().toLowerCase().startsWith(CODE_PREFIX);
}

/**
 * Reverse of `encode_pair_code` (sleap-connect `pair_code.py`).
 *
 * Whitespace around `code` is stripped and the whole thing is matched
 * case-insensitively (the base32 alphabet this format emits is lowercase
 * a-z/2-7, but a terminal, editor, or autocapitalizing phone keyboard might
 * upper-case a pasted code).
 *
 * @throws {PairCodeError} `code` doesn't start with the expected prefix,
 * has an unsupported format version, fails its checksum (a strong signal of
 * a truncated or mistyped paste), or is otherwise too short/malformed to
 * parse.
 */
/**
 * @param {string} code
 * @returns {Promise<DecodedPairingTicket>}
 */
export async function decodePairCode(code) {
  const lowered = code.trim().toLowerCase();
  if (!lowered.startsWith(CODE_PREFIX)) {
    throw new PairCodeError(
      `Not a sleap-connect pairing code (expected it to start with "${CODE_PREFIX}")`,
    );
  }

  const payload = base32Decode(lowered.slice(CODE_PREFIX.length));
  if (payload.length < MIN_BODY_LEN) {
    throw new PairCodeError(
      "This pairing code is too short — it's probably truncated or mistyped",
    );
  }

  const body = payload.subarray(0, payload.length - CHECKSUM_LEN);
  const checksum = payload.subarray(payload.length - CHECKSUM_LEN);
  const expectedChecksum = (await sha256(body)).subarray(0, CHECKSUM_LEN);
  if (!bytesEqual(checksum, expectedChecksum)) {
    throw new PairCodeError(
      "This pairing code is incomplete or mistyped (checksum mismatch)",
    );
  }

  let pos = 0;
  const version = readByte(body, pos);
  pos += 1;
  if (version !== FORMAT_VERSION) {
    throw new PairCodeError(`Unsupported pairing code version: ${version}`);
  }

  try {
    const nodeIdBytes = readBytes(body, pos, 32);
    pos += 32;
    const secretBytes = readBytes(body, pos, 16);
    pos += 16;
    const expiresAt = readUint32(body, pos);
    pos += 4;

    const addrCount = readByte(body, pos);
    pos += 1;
    const addrs= [];
    for (let i = 0; i < addrCount; i++) {
      const [addr, next] = decodeAddr(body, pos);
      addrs.push(addr);
      pos = next;
    }

    const relayTag = readByte(body, pos);
    pos += 1;
    let relayUrl;
    if (relayTag === RELAY_TAG_NONE) {
      relayUrl = undefined;
    } else if (relayTag === RELAY_TAG_URL) {
      const len = readByte(body, pos);
      pos += 1;
      relayUrl = utf8Decode(readBytes(body, pos, len));
      pos += len;
    } else if (relayTag >= 1 && relayTag <= RELAY_TABLE.length) {
      relayUrl = RELAY_TABLE[relayTag - 1];
    } else {
      throw new PairCodeError(`Unknown relay table index: ${relayTag}`);
    }

    if (pos !== body.length) {
      throw new PairCodeError(
        "This pairing code has unexpected trailing data — it's probably mistyped",
      );
    }

    const node_id = base64UrlEncode(nodeIdBytes);
    const secret = base64UrlEncode(secretBytes);

    return {
      node_id,
      addrs,
      secret,
      expires_at: expiresAt,
      iroh: relayUrl ? { node_id, relay_url: relayUrl, direct_addrs: [] } : undefined,
    };
  } catch (err) {
    if (err instanceof PairCodeError) throw err;
    throw new PairCodeError(
      "This pairing code is too short — it's probably truncated or mistyped",
    );
  }
}

/** Decode one tagged addr entry starting at `pos`. Returns `[addr, nextPos]`. */
function decodeAddr(body, pos) {
  const tag = readByte(body, pos);
  pos += 1;
  if (tag === ADDR_TAG_IPV4) {
    const bytes = readBytes(body, pos, 4);
    pos += 4;
    const port = readUint16(body, pos);
    pos += 2;
    return [`ws://${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}:${port}`, pos];
  }
  if (tag === ADDR_TAG_IPV6) {
    const bytes = readBytes(body, pos, 16);
    pos += 16;
    const port = readUint16(body, pos);
    pos += 2;
    return [`ws://[${formatIpv6(bytes)}]:${port}`, pos];
  }
  if (tag === ADDR_TAG_URL) {
    const len = readByte(body, pos);
    pos += 1;
    const url = utf8Decode(readBytes(body, pos, len));
    pos += len;
    return [url, pos];
  }
  throw new PairCodeError(`Unknown address tag: ${tag}`);
}

/** RFC 5952 canonical compressed form — matches Python's `str(IPv6Address(...))`. */
function formatIpv6(bytes) {
  const groups= [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);

  // Longest run of zero groups (length >= 2) to compress; first such run
  // wins on a tie.
  let bestStart = -1;
  let bestLen = 0;
  let i = 0;
  while (i < 8) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    const len = j - i;
    if (len > bestLen) {
      bestLen = len;
      bestStart = i;
    }
    i = j;
  }

  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(":");

  const before = groups.slice(0, bestStart).map((g) => g.toString(16));
  const after = groups.slice(bestStart + bestLen).map((g) => g.toString(16));
  return `${before.join(":")}::${after.join(":")}`;
}

function readByte(body, pos) {
  if (pos >= body.length) throw new TruncatedCodeError();
  return body[pos];
}

function readBytes(body, pos, len) {
  if (pos + len > body.length) throw new TruncatedCodeError();
  return body.subarray(pos, pos + len);
}

function readUint16(body, pos) {
  const bytes = readBytes(body, pos, 2);
  return (bytes[0] << 8) | bytes[1];
}

function readUint32(body, pos) {
  const bytes = readBytes(body, pos, 4);
  return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
}

function utf8Decode(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TruncatedCodeError();
  }
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

/** URL-safe, unpadded base64 — matches `sleap_rtc.auth.keypair` / `identity.ts`. */
function base64UrlEncode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Lowercase RFC 4648 base32 (no padding) to raw bytes — a plain MSB-first
 * bit-accumulator, equivalent to the padded block decode Python's
 * `base64.b32decode` performs on `encode_pair_code`'s own (unpadded) output.
 */
function base32Decode(input) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of input) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new PairCodeError(`Malformed pairing code: invalid character ${JSON.stringify(ch)}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      // Keep only the not-yet-emitted low bits — otherwise `value` grows
      // without bound across a ~100-character code and overflows the 32-bit
      // range JS bitwise ops operate on.
      value &= (1 << bits) - 1;
    }
  }
  return new Uint8Array(out);
}
