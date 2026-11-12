/**
 * Test-only pairing-code ENCODER for the Connect fake worker (production only decodes).
 *
 * Port of sleap-connect `sleap_connect/protocol_v1/pair_code.py` (`encode_pair_code`) @ 0610a6b,
 * which is also what sleap-app's `tests/unit/buildPairCode.ts` @ 683a159 re-implements. The
 * decoder, `isPairCode`, `PairCodeError` and `RELAY_TABLE` are re-exported from
 * `pose/connect/pair-code.js`. Encoder and decoder are checked against
 * `tests/fixtures/connect/pair_code_vectors.json` by `tests/test-connect-fake-worker.mjs`.
 *
 * Format: `sleap1` + lowercase unpadded base32 of
 *   version(1)=1 | node_id(32) | secret(16) | expires_at u32 BE |
 *   addr count(1) + addrs | relay | sha256(body)[0:2]
 * addr: tag 4 + IPv4(4) + port(2) / tag 6 + IPv6(16) + port(2) / tag 0 + len + utf-8 URL.
 * relay: 0 none / 1..n index into RELAY_TABLE / 255 + len + utf-8 URL.
 *
 * Dependency-free apart from the production module: only `globalThis.crypto.subtle`.
 */
import { CODE_PREFIX, RELAY_TABLE } from '../../pose/connect/pair-code.js';

export { CODE_PREFIX, RELAY_TABLE, PairCodeError, isPairCode, decodePairCode } from '../../pose/connect/pair-code.js';

const FORMAT_VERSION = 1;
const CHECKSUM_LEN = 2;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

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
