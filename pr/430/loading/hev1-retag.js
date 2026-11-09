/**
 * hev1-retag.js — play HEVC tagged `hev1` on engines that only play `hvc1`,
 * losslessly and without touching the file on disk.
 *
 * Safari and the macOS desktop app (WKWebView) play HEVC-in-MP4 only when its
 * sample entry is tagged `hvc1` (canPlayType: hev1 "", hvc1 "probably"); ffmpeg
 * tags HEVC `hev1` by default. `ffmpeg -c copy -tag:v hvc1` fixes such a file by
 * rewriting the 4-byte fourcc of the sample entry in `stsd` and nothing else
 * (measured: its output differs from its input in exactly those 4 bytes). That
 * is valid when the entry's `hvcC` already carries the parameter sets (VPS,
 * SPS and PPS arrays with at least one NAL unit each), as ffmpeg-written files
 * do: `hvc1` promises the decoder they are there.
 *
 * So `playbackSourceFor(file)` gives, where the engine needs it, a File
 * that reads as that re-tagged file: `new File([file.slice(0, off), "hvc1",
 * file.slice(off + 4), …])`, one 4-byte patch per hev1 sample entry. Slices of
 * a disk-backed File stay references to the file (Chromium's and WebKit's blob
 * registries keep "file" items with offset and length), so a multi-GB video is
 * not copied. The original File is never changed. The patched File keeps the
 * name, type, lastModified, `webkitRelativePath` and any own property of the
 * original, and carries `lucidHev1Retag = { original, offsets }`.
 *
 * Gate (`hev1RetagNeeded`): the `<video>` element can play `hvc1` but not
 * `hev1` — the condition under which video-codec-diagnosis.js says
 * `hevc-hev1-tag`. Chrome and Firefox play `hev1` (or neither), so they always
 * get the original File, by identity. `globalThis.__lucidHev1RetagGate`
 * (true/false) forces it for tests.
 *
 * Probe (`planHev1Retag`): walks the boxes to every `moov/trak/mdia/minf/stbl/
 * stsd` with small guarded reads (cold-read-guard.js, served from 64 KiB
 * windows), wherever `moov` is (before or after `mdat`; fragmented files keep
 * their sample entries in `moov` too). Never reads `mdat`, never throws: an
 * unreadable, truncated or non-MP4 file is "no patch".
 *
 * One plan per original File (WeakMap), so re-opening it (switchSource) gives
 * the SAME patched File object, which ui/image-embedder.js's cache keys on.
 */

import { readBlobRange } from './cold-read-guard.js?v=552ac39b914d';
import { parseBoxHeader, codecPlayable } from './video-codec-diagnosis.js?v=552ac39b914d';

const ENC = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** A VisualSampleEntry's fixed part (after its 8-byte header): 78 bytes, then child boxes. */
export const VISUAL_SAMPLE_ENTRY_FIXED = 78;
const MAX_STSD_BYTES = 1 << 20;
const MAX_CHILDREN = 4096;
const MAX_TOP_LEVEL = 64;   // as video-codec-diagnosis.js's sniff
const WINDOW_BYTES = 64 * 1024;

// HEVC NAL unit types of the parameter sets the hvcC must carry for `hvc1`.
const NAL_VPS = 32, NAL_SPS = 33, NAL_PPS = 34;

function fourccAt(b, at) {
    return String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
}

/**
 * The parameter sets in an HEVCDecoderConfigurationRecord (the payload of an
 * `hvcC` box, after its 8-byte header). Pure.
 * `complete` when it parses to its end and holds at least one non-empty VPS,
 * SPS and PPS NAL unit (each NAL's own header naming its array's type).
 * @param {Uint8Array} rec
 * @returns {{vps: number, sps: number, pps: number, complete: boolean, malformed: boolean}}
 */
export function hvccParameterSets(rec) {
    const out = { vps: 0, sps: 0, pps: 0, complete: false, malformed: true };
    if (!rec || rec.length < 23 || rec[0] !== 1) return out;   // configurationVersion 1
    let p = 23;
    const nArrays = rec[22];
    for (let a = 0; a < nArrays; a++) {
        if (p + 3 > rec.length) return out;
        const type = rec[p] & 0x3f;
        const nNalus = (rec[p + 1] << 8) | rec[p + 2];
        p += 3;
        for (let k = 0; k < nNalus; k++) {
            if (p + 2 > rec.length) return out;
            const len = (rec[p] << 8) | rec[p + 1];
            p += 2;
            if (p + len > rec.length) return out;
            // NAL header: forbidden_zero_bit, nal_unit_type (6 bits), …
            const ok = len >= 2 && ((rec[p] >> 1) & 0x3f) === type;
            if (ok && type === NAL_VPS) out.vps++;
            else if (ok && type === NAL_SPS) out.sps++;
            else if (ok && type === NAL_PPS) out.pps++;
            p += len;
        }
    }
    out.malformed = false;
    out.complete = out.vps > 0 && out.sps > 0 && out.pps > 0;
    return out;
}

/**
 * Every `hev1` sample entry in the bytes of one `stsd` box that starts at file
 * offset `stsdOffset`. Pure.
 * @param {Uint8Array} stsd - the whole box, header included
 * @param {number} stsdOffset
 * @returns {Array<{offset: number, parameterSets: Object}>} `offset` = file
 *   offset of the entry's fourcc (the 4 bytes to rewrite)
 */
export function hev1EntriesInStsd(stsd, stsdOffset) {
    const out = [];
    const box = parseBoxHeader(stsd, 0);
    if (!box || box.type !== 'stsd') return out;
    const end = Math.min(stsd.length, box.size || stsd.length);
    let p = box.header + 4;                          // version + flags
    if (p + 4 > end) return out;
    const count = ((stsd[p] << 24) >>> 0) + (stsd[p + 1] << 16) + (stsd[p + 2] << 8) + stsd[p + 3];
    p += 4;
    for (let i = 0; i < count && p + 8 <= end; i++) {
        const e = parseBoxHeader(stsd, p);
        if (!e || e.size < e.header || p + e.size > end) break;
        if (e.type === 'hev1') {
            let hvcc = null;
            for (let c = p + e.header + VISUAL_SAMPLE_ENTRY_FIXED; c + 8 <= p + e.size;) {
                const ch = parseBoxHeader(stsd, c);
                if (!ch || ch.size < ch.header || c + ch.size > p + e.size) break;
                if (ch.type === 'hvcC') { hvcc = stsd.subarray(c + ch.header, c + ch.size); break; }
                c += ch.size;
            }
            out.push({ offset: stsdOffset + p + 4,
                parameterSets: hvcc ? hvccParameterSets(hvcc) : { vps: 0, sps: 0, pps: 0, complete: false, malformed: true } });
        }
        p += e.size;
    }
    return out;
}

/** Guarded range reads of `blob`, served from aligned 64 KiB windows (a box walk reads many small headers). */
function windowReader(blob) {
    const wins = new Map();
    const win = (start) => {
        let w = wins.get(start);
        if (!w) { w = readBlobRange(blob, start, Math.min(blob.size, start + WINDOW_BYTES)); wins.set(start, w); }
        return w;
    };
    return async function read(start, end) {
        end = Math.min(end, blob.size);
        if (!(end > start)) return new Uint8Array(0);
        if (end - start > WINDOW_BYTES) return readBlobRange(blob, start, end);
        const a0 = Math.floor(start / WINDOW_BYTES) * WINDOW_BYTES;
        const b0 = Math.floor((end - 1) / WINDOW_BYTES) * WINDOW_BYTES;
        const a = await win(a0);
        if (a0 === b0) return a.subarray(start - a0, end - a0);
        const b = await win(b0);
        const out = new Uint8Array(end - start);
        out.set(a.subarray(start - a0));
        out.set(b.subarray(0, end - b0), a0 + a.length - start);
        return out;
    };
}

/** The child boxes of [start, end): `{type, offset, size, header}`; stops at the first malformed one. */
async function childBoxes(read, start, end, limit) {
    const out = [];
    let off = start;
    while (off + 8 <= end && out.length < (limit || MAX_CHILDREN)) {
        const box = parseBoxHeader(await read(off, Math.min(off + 16, end)), 0);
        if (!box) break;
        const size = box.size === 0 ? end - off : box.size;
        if (size < box.header || off + size > end) break;
        out.push({ type: box.type, offset: off, size, header: box.header });
        off += size;
    }
    return out;
}

async function childOfType(read, parent, type) {
    const kids = await childBoxes(read, parent.offset + parent.header, parent.offset + parent.size);
    return kids.find(k => k.type === type) || null;
}

/**
 * Where to re-tag `blob`'s hev1 sample entries as hvc1. Never throws.
 * `offsets` is empty unless EVERY hev1 entry's hvcC has its parameter sets.
 * @param {Blob} blob
 * @returns {Promise<{offsets: number[], entries: Array, reason: string}>}
 *   reason: 'ok' | 'no-hev1' | 'incomplete-hvcc' | 'no-moov' | 'not-mp4' | 'error'
 */
export async function planHev1Retag(blob) {
    try {
        if (typeof Blob === 'undefined' || !(blob instanceof Blob) || blob.size < 16) {
            return { offsets: [], entries: [], reason: 'not-mp4' };
        }
        const read = windowReader(blob);
        // Top level: the first box must look like an MP4 one; then find moov.
        let moov = null;
        let off = 0;
        for (let n = 0; n < MAX_TOP_LEVEL && off + 8 <= blob.size; n++) {
            const box = parseBoxHeader(await read(off, Math.min(off + 16, blob.size)), 0);
            if (!box || !/^[\x20-\x7e]{4}$/.test(box.type)) break;
            const size = box.size === 0 ? blob.size - off : box.size;
            if (size < box.header) break;
            if (box.type === 'moov') { moov = { type: 'moov', offset: off, size: Math.min(size, blob.size - off), header: box.header }; break; }
            off += size;
        }
        if (!moov) return { offsets: [], entries: [], reason: off === 0 ? 'not-mp4' : 'no-moov' };
        const entries = [];
        const traks = (await childBoxes(read, moov.offset + moov.header, moov.offset + moov.size)).filter(b => b.type === 'trak');
        for (const trak of traks) {
            const mdia = await childOfType(read, trak, 'mdia');
            const minf = mdia && await childOfType(read, mdia, 'minf');
            const stbl = minf && await childOfType(read, minf, 'stbl');
            const stsd = stbl && await childOfType(read, stbl, 'stsd');
            if (!stsd || stsd.size > MAX_STSD_BYTES) continue;
            const bytes = await read(stsd.offset, stsd.offset + stsd.size);
            for (const e of hev1EntriesInStsd(bytes, stsd.offset)) entries.push(e);
        }
        if (!entries.length) return { offsets: [], entries, reason: 'no-hev1' };
        if (entries.some(e => !e.parameterSets.complete)) return { offsets: [], entries, reason: 'incomplete-hvcc' };
        return { offsets: entries.map(e => e.offset).sort((a, b) => a - b), entries, reason: 'ok' };
    } catch (e) {
        return { offsets: [], entries: [], reason: 'error', error: e };
    }
}

/**
 * A File reading as `file` with `tag` written at each of `offsets` (4 bytes
 * each), built from slices of `file` (references, not copies). Keeps the name,
 * type, lastModified, `webkitRelativePath` and own properties; `file` is not
 * changed. Pure apart from building the File.
 * @param {File} file
 * @param {number[]} offsets
 * @param {string} [tag]
 * @returns {File}
 */
export function retaggedFile(file, offsets, tag) {
    const bytes = ENC.encode(tag || 'hvc1');
    const sorted = offsets.slice().sort((a, b) => a - b);
    const parts = [];
    let at = 0;
    for (const off of sorted) {
        if (off > at) parts.push(file.slice(at, off));
        parts.push(bytes);
        at = off + bytes.length;
    }
    if (at < file.size) parts.push(file.slice(at));
    const out = new File(parts, file.name, { type: file.type, lastModified: file.lastModified });
    for (const k of Object.getOwnPropertyNames(file)) {
        try { Object.defineProperty(out, k, Object.getOwnPropertyDescriptor(file, k)); } catch (e) { /* not copyable */ }
    }
    if (!Object.prototype.hasOwnProperty.call(out, 'webkitRelativePath') && file.webkitRelativePath) {
        Object.defineProperty(out, 'webkitRelativePath', { value: file.webkitRelativePath, enumerable: true });
    }
    Object.defineProperty(out, 'lucidHev1Retag', { value: { original: file, offsets: sorted } });
    return out;
}

/**
 * Whether this engine needs the re-tag: its `<video>` plays `hvc1` but not
 * `hev1`. `globalThis.__lucidHev1RetagGate` = true/false forces the answer.
 * @param {{canPlayType?: function(string): string}} [env]
 */
export function hev1RetagNeeded(env) {
    const forced = globalThis.__lucidHev1RetagGate;
    if (forced === true || forced === false) return forced;
    const canPlay = env && env.canPlayType;
    return !codecPlayable('hev1', canPlay) && codecPlayable('hvc1', canPlay);
}

const _plans = new WeakMap();      // original File -> Promise<File>
const _retagged = new WeakMap();   // original File -> patched File (once known)

/**
 * The File the video consumers should read for `source`: a re-tagged view of
 * it when the engine needs one and the file allows it (see the module
 * comment), else `source` itself.
 *
 * Synchronous where nothing is to be done: returns `source` itself (not a
 * Promise) when it is not a File, is already a re-tagged view, or the gate is
 * off — so on Chrome and Firefox the decoder runs exactly as before, without
 * even a microtask. Otherwise a Promise of the File to use, which never
 * rejects (a failed probe resolves to `source`).
 * @param {Blob|File|string} source
 * @param {Object} [env] - as `hev1RetagNeeded`
 * @returns {Blob|File|string|Promise<Blob|File|string>}
 */
export function playbackSourceFor(source, env) {
    if (typeof File === 'undefined' || !(source instanceof File)) return source;
    if (source.lucidHev1Retag) return source;    // already the patched view
    if (!hev1RetagNeeded(env)) return source;
    let p = _plans.get(source);
    if (!p) {
        p = planHev1Retag(source).then(function (plan) {
            if (plan.reason === 'error') _plans.delete(source);   // a failed read may succeed next time
            if (plan.reason === 'incomplete-hvcc') {
                console.warn('[hev1-retag] ' + source.name + ': HEVC tagged hev1 whose hvcC lacks parameter sets; not re-tagged');
            }
            if (!plan.offsets.length) return source;
            const out = retaggedFile(source, plan.offsets, 'hvc1');
            _retagged.set(source, out);
            console.info('[hev1-retag] ' + source.name + ': playing ' + plan.offsets.length
                + ' HEVC sample entr' + (plan.offsets.length === 1 ? 'y' : 'ies') + ' tagged hev1 as hvc1 (file on disk unchanged)');
            return out;
        }, function () { _plans.delete(source); return source; });
        _plans.set(source, p);
    }
    return p;
}

/**
 * `playbackSourceFor`, always as a Promise.
 * @param {Blob|File|string} source
 * @param {Object} [env]
 * @returns {Promise<Blob|File|string>}
 */
export function videoFileForPlayback(source, env) {
    return Promise.resolve(playbackSourceFor(source, env));
}

/**
 * Whether `file` (an original File, or `{ file }`) is played through a
 * re-tagged view.
 * @param {File|{file: File}} f
 * @returns {boolean}
 */
export function isPlayedRetagged(f) {
    const file = f && f.file ? f.file : f;
    return !!file && typeof file === 'object' && (_retagged.has(file) || !!file.lucidHev1Retag);
}

/**
 * The short status note for a load: '' when none of `files` was re-tagged,
 * else "played N HEVC video(s) tagged hev1 as hvc1 (files unchanged)".
 * @param {Array<File|{file: File}>} files
 * @returns {string}
 */
export function hev1RetagNote(files) {
    const n = (files || []).filter(isPlayedRetagged).length;
    if (!n) return '';
    return 'played ' + n.toLocaleString('en-US') + ' HEVC video' + (n === 1 ? '' : 's')
        + ' tagged hev1 as hvc1 (files unchanged)';
}

/**
 * `message` with `hev1RetagNote(files)` appended after an em dash (unchanged
 * when there is no note).
 * @param {string} message
 * @param {Array<File|{file: File}>} files
 * @returns {string}
 */
export function withHev1RetagNote(message, files) {
    const note = hev1RetagNote(files);
    return note ? message + ' — ' + note : message;
}
