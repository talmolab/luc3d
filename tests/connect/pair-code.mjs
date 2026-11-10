/**
 * Test-only pairing-code codec for the Connect fake worker.
 *
 * Encoder: port of sleap-connect `sleap_connect/protocol_v1/pair_code.py`
 * (`encode_pair_code`) @ 0610a6b, which is also what sleap-app's
 * `tests/unit/buildPairCode.ts` @ 683a159 re-implements. Decoder: port of
 * sleap-app `src/lib/protocolV1/pairCode.ts` @ 683a159 (`decodePairCode`).
 * Both are checked against `tests/fixtures/connect/pair_code_vectors.json`
 * by `tests/test-connect-fake-worker.mjs`.
 *
 * Format: `sleap1` + lowercase unpadded base32 of
 *   version(1)=1 | node_id(32) | secret(16) | expires_at u32 BE |
 *   addr count(1) + addrs | relay | sha256(body)[0:2]
 * addr: tag 4 + IPv4(4) + port(2) / tag 6 + IPv6(16) + port(2) / tag 0 + len + utf-8 URL.
 * relay: 0 none / 1..n index into RELAY_TABLE / 255 + len + utf-8 URL.
 *
 * Dependency-free: only `globalThis.crypto.subtle`.
 */

export const CODE_PREFIX = 'sleap1';
export const RELAY_TABLE = [
    'https://aps1-1.relay.n0.iroh.link./',
    'https://euc1-1.relay.n0.iroh.link./',
    'https://use1-1.relay.n0.iroh.link./',
    'https://usw1-1.relay.n0.iroh.link./',
];

const FORMAT_VERSION = 1;
const CHECKSUM_LEN = 2;
const MIN_BODY_LEN = 1 + 32 + 16 + 4 + 1 + 1 + CHECKSUM_LEN;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export class PairCodeError extends Error {
    constructor(message) { super(message); this.name = 'PairCodeError'; }
}

export function b64urlEncode(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s) {
    let std = s.replace(/-/g, '+').replace(/_/g, '/');
    while (std.length % 4) std += '=';
    return Uint8Array.from(atob(std), (c) => c.charCodeAt(0));
}

function b32Encode(bytes) {
    let bits = 0, value = 0, out = '';
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}

function b32Decode(input) {
    let bits = 0, value = 0;
    const out = [];
    for (const ch of input) {
        const idx = B32.indexOf(ch);
        if (idx === -1) throw new PairCodeError(`Malformed pairing code: invalid character ${JSON.stringify(ch)}`);
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
            value &= (1 << bits) - 1;
        }
    }
    return new Uint8Array(out);
}

async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function parseIPv4(host) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return null;
    const b = m.slice(1).map(Number);
    return b.every((n) => n <= 255) ? Uint8Array.from(b) : null;
}

function parseIPv6(host) {
    if (!/^[0-9a-fA-F:]+$/.test(host) || (host.match(/::/g) || []).length > 1) return null;
    const [head, tail] = host.split('::');
    const h = head ? head.split(':') : [];
    const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
    let groups;
    if (t === null) {
        groups = h;
        if (groups.length !== 8) return null;
    } else {
        const fill = 8 - h.length - t.length;
        if (fill < 1) return null;
        groups = [...h, ...Array(fill).fill('0'), ...t];
    }
    const out = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
        const v = parseInt(groups[i], 16);
        out[2 * i] = v >> 8;
        out[2 * i + 1] = v & 0xff;
    }
    return out;
}

/** `[tag, ipBytes, port]` for exactly ws://<ipv4>:<port> or ws://[<ipv6>]:<port>, else null. */
function parseWsHostPort(addr) {
    const m = /^ws:\/\/(?:\[([0-9a-fA-F:]+)\]|([0-9.]+)):(\d{1,5})$/.exec(addr);
    if (!m) return null;
    const port = Number(m[3]);
    if (port > 65535) return null;
    if (m[1] !== undefined) {
        const ip = parseIPv6(m[1]);
        return ip ? [6, ip, port] : null;
    }
    const ip = parseIPv4(m[2]);
    return ip ? [4, ip, port] : null;
}

function encodeAddr(addr) {
    const p = parseWsHostPort(addr);
    if (p) return [p[0], ...p[1], (p[2] >> 8) & 0xff, p[2] & 0xff];
    const raw = new TextEncoder().encode(addr);
    if (raw.length > 255) throw new Error(`addr is too long to encode (${raw.length} bytes): ${addr}`);
    return [0, raw.length, ...raw];
}

function encodeRelay(relayUrl) {
    if (!relayUrl) return [0];
    const i = RELAY_TABLE.indexOf(relayUrl);
    if (i >= 0) return [i + 1];
    const raw = new TextEncoder().encode(relayUrl);
    if (raw.length > 255) throw new Error(`relay_url is too long to encode (${raw.length} bytes)`);
    return [255, raw.length, ...raw];
}

/**
 * Pack a ticket into a `sleap1...` code (mirror of `encode_pair_code`).
 * @param {{node_id:string, secret:string, expires_at:number, addrs?:string[], relay_url?:string|null}} ticket
 *   node_id / secret are URL-safe base64 of 32 / 16 raw bytes.
 * @param {{version?:number}} [opts] version override (for unsupported-version tests).
 */
export async function encodePairCode(ticket, opts = {}) {
    const nodeId = b64urlDecode(ticket.node_id);
    if (nodeId.length !== 32) throw new Error(`node_id must decode to 32 bytes, got ${nodeId.length}`);
    const secret = b64urlDecode(ticket.secret);
    if (secret.length !== 16) throw new Error(`secret must decode to 16 bytes, got ${secret.length}`);
    const addrs = ticket.addrs || [];
    if (addrs.length > 255) throw new Error(`too many addrs (${addrs.length}); max 255`);
    const exp = new Uint8Array(4);
    new DataView(exp.buffer).setUint32(0, Math.floor(ticket.expires_at), false);
    const parts = [opts.version ?? FORMAT_VERSION, ...nodeId, ...secret, ...exp, addrs.length];
    for (const a of addrs) parts.push(...encodeAddr(a));
    parts.push(...encodeRelay(ticket.relay_url));
    const body = Uint8Array.from(parts);
    const digest = await sha256(body);
    const full = new Uint8Array(body.length + CHECKSUM_LEN);
    full.set(body, 0);
    full.set(digest.subarray(0, CHECKSUM_LEN), body.length);
    return CODE_PREFIX + b32Encode(full);
}

/** Flip one base32 character near the start of the body so the checksum fails. */
export function mistypeCode(code) {
    const idx = CODE_PREFIX.length + 3;
    return code.slice(0, idx) + (code[idx] === 'a' ? 'b' : 'a') + code.slice(idx + 1);
}

function formatIpv6(bytes) {
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
    let bestStart = -1, bestLen = 0, i = 0;
    while (i < 8) {
        if (groups[i] !== 0) { i++; continue; }
        let j = i;
        while (j < 8 && groups[j] === 0) j++;
        if (j - i > bestLen) { bestLen = j - i; bestStart = i; }
        i = j;
    }
    if (bestLen < 2) return groups.map((g) => g.toString(16)).join(':');
    const before = groups.slice(0, bestStart).map((g) => g.toString(16));
    const after = groups.slice(bestStart + bestLen).map((g) => g.toString(16));
    return `${before.join(':')}::${after.join(':')}`;
}

export function isPairCode(text) {
    return text.trim().toLowerCase().startsWith(CODE_PREFIX);
}

/**
 * Reverse of `encodePairCode` (port of sleap-app `decodePairCode`).
 * @returns {Promise<{node_id:string, addrs:string[], secret:string, expires_at:number,
 *   iroh?:{node_id:string, relay_url:string, direct_addrs:string[]}}>}
 */
export async function decodePairCode(code) {
    const lowered = code.trim().toLowerCase();
    if (!lowered.startsWith(CODE_PREFIX)) {
        throw new PairCodeError(`Not a sleap-connect pairing code (expected it to start with "${CODE_PREFIX}")`);
    }
    const payload = b32Decode(lowered.slice(CODE_PREFIX.length));
    if (payload.length < MIN_BODY_LEN) {
        throw new PairCodeError("This pairing code is too short — it's probably truncated or mistyped");
    }
    const body = payload.subarray(0, payload.length - CHECKSUM_LEN);
    const checksum = payload.subarray(payload.length - CHECKSUM_LEN);
    const expected = (await sha256(body)).subarray(0, CHECKSUM_LEN);
    if (checksum[0] !== expected[0] || checksum[1] !== expected[1]) {
        throw new PairCodeError('This pairing code is incomplete or mistyped (checksum mismatch)');
    }
    const truncated = () => new PairCodeError("This pairing code is too short — it's probably truncated or mistyped");
    let pos = 0;
    const byte = () => { if (pos >= body.length) throw truncated(); return body[pos++]; };
    const bytes = (n) => { if (pos + n > body.length) throw truncated(); const b = body.subarray(pos, pos + n); pos += n; return b; };
    const u16 = () => { const b = bytes(2); return (b[0] << 8) | b[1]; };
    const utf8 = (n) => {
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes(n)); } catch (e) {
            if (e instanceof PairCodeError) throw e;
            throw truncated();
        }
    };

    const version = byte();
    if (version !== FORMAT_VERSION) throw new PairCodeError(`Unsupported pairing code version: ${version}`);
    const nodeId = b64urlEncode(bytes(32));
    const secret = b64urlEncode(bytes(16));
    const eb = bytes(4);
    const expiresAt = ((eb[0] << 24) | (eb[1] << 16) | (eb[2] << 8) | eb[3]) >>> 0;
    const count = byte();
    const addrs = [];
    for (let i = 0; i < count; i++) {
        const tag = byte();
        if (tag === 4) {
            const ip = bytes(4);
            addrs.push(`ws://${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}:${u16()}`);
        } else if (tag === 6) {
            const ip = bytes(16);
            addrs.push(`ws://[${formatIpv6(ip)}]:${u16()}`);
        } else if (tag === 0) {
            addrs.push(utf8(byte()));
        } else {
            throw new PairCodeError(`Unknown address tag: ${tag}`);
        }
    }
    const relayTag = byte();
    let relayUrl;
    if (relayTag === 0) relayUrl = undefined;
    else if (relayTag === 255) relayUrl = utf8(byte());
    else if (relayTag >= 1 && relayTag <= RELAY_TABLE.length) relayUrl = RELAY_TABLE[relayTag - 1];
    else throw new PairCodeError(`Unknown relay table index: ${relayTag}`);
    if (pos !== body.length) {
        throw new PairCodeError("This pairing code has unexpected trailing data — it's probably mistyped");
    }
    return {
        node_id: nodeId,
        addrs,
        secret,
        expires_at: expiresAt,
        iroh: relayUrl ? { node_id: nodeId, relay_url: relayUrl, direct_addrs: [] } : undefined,
    };
}
