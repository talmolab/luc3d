/**
 * test-hev1-retag.mjs — loading/hev1-retag.js: HEVC tagged `hev1` played as
 * `hvc1` on engines that need it (Safari, the macOS app's WKWebView), losslessly
 * and without touching the file.
 *
 * WHY: on the desktop app an 8-camera session folder of ffmpeg-written HEVC
 * loaded with no video at all — "HEVC video tagged "hev1", which this browser
 * only plays when tagged "hvc1". Fix it losslessly: ffmpeg … -c copy -tag:v
 * hvc1" — for every camera. That ffmpeg command rewrites the 4-byte fourcc of
 * the sample entry and nothing else (the fixtures' twins differ from their
 * sources in exactly those 4 bytes), which is valid because the hvcC already
 * carries the parameter sets. LUCID now does the same in memory: a File built
 * from slices of the original with "hvc1" in those 4 bytes.
 *
 * Fixtures (tests/fixtures/hev1-retag/make_fixture.sh): hev1.mp4 (moov after
 * mdat), hev1-frag.mp4 (fragmented, moov first), and each one's ffmpeg
 * `-tag:v hvc1` twin. Other layouts are built from them in memory.
 *
 *  1. Box walking finds the hev1 entry at the byte ffmpeg changes (moov at the
 *     end, fragmented, moov first, two video tracks).
 *  2. The re-tagged File equals ffmpeg's twin: sample entries, and for these
 *     files the whole file, byte for byte.
 *  3. hvcC without its parameter sets (or without an hvcC) → no patch.
 *  4. No patch, no throw: avc1, hvc1, truncated, garbage, tiny, absurd sizes.
 *  5. The probe reads box headers and the stsd, never the mdat.
 *  6. playbackSourceFor: gate off → the original File itself, synchronously;
 *     gate on → the patched File (name, type, lastModified, webkitRelativePath
 *     kept, original untouched), the SAME object on a second call.
 *  7. The gate and the status note.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    planHev1Retag, retaggedFile, hvccParameterSets, hev1EntriesInStsd, hev1RetagNeeded,
    playbackSourceFor, videoFileForPlayback, isPlayedRetagged, hev1RetagNote, withHev1RetagNote,
} from '../loading/hev1-retag.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tests/fixtures/hev1-retag');
const read = (name) => new Uint8Array(fs.readFileSync(path.join(FIX, name)));
for (const f of ['hev1.mp4', 'hvc1.mp4', 'hev1-frag.mp4', 'hvc1-frag.mp4']) {
    if (!fs.existsSync(path.join(FIX, f))) {
        console.error(`  ✗ ${f} is missing — regenerate with tests/fixtures/hev1-retag/make_fixture.sh`);
        process.exit(1);
    }
}

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const section = (t) => console.log('\n' + t);

const fileOf = (bytes, name, opts) => new File([bytes], name || 'cam.mp4', Object.assign({ type: 'video/mp4', lastModified: 1234567890000 }, opts));
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const ascii = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const diffAt = (a, b) => { const d = []; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) d.push(i); return d; };
const equal = (a, b) => a.length === b.length && diffAt(a, b).length === 0;
const u32 = (b, at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const put32 = (b, at, n) => { b[at] = n >>> 24; b[at + 1] = (n >>> 16) & 255; b[at + 2] = (n >>> 8) & 255; b[at + 3] = n & 255; };
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
function topLevel(b) {
    const out = []; let o = 0;
    while (o + 8 <= b.length) { const s = u32(b, o); out.push({ type: ascii(b, o + 4), off: o, size: s, bytes: b.subarray(o, o + s) }); o += s; }
    return out;
}
const indexOfAscii = (b, s, from) => { for (let i = from || 0; i + 4 <= b.length; i++) if (ascii(b, i) === s) return i; return -1; };
/** The sample-entry box ([size][fourcc]…) whose fourcc is at `at`. */
const entryAt = (b, at) => b.subarray(at - 4, at - 4 + u32(b, at - 4));

const hev1 = read('hev1.mp4'), hvc1 = read('hvc1.mp4');
const hev1Frag = read('hev1-frag.mp4'), hvc1Frag = read('hvc1-frag.mp4');

// =========================================================================
section('1. box walking finds every hev1 entry at the byte ffmpeg changes');
{
    const twinDiff = diffAt(hev1, hvc1);
    const top = topLevel(hev1).map(b => b.type);
    check(top.indexOf('mdat') >= 0 && top.indexOf('mdat') < top.indexOf('moov'), `fixture keeps moov after mdat (${top.join(',')})`);
    const plan = await planHev1Retag(fileOf(hev1));
    check(plan.reason === 'ok' && plan.offsets.length === 1, `moov at the end: one entry (${plan.reason}, ${plan.offsets})`);
    check(ascii(hev1, plan.offsets[0]) === 'hev1', 'the offset holds "hev1"');
    // "hev1" -> "hvc1" differs in its middle two bytes.
    const inTag = (d, o) => d.length > 0 && d.every(i => i >= o && i < o + 4);
    check(inTag(twinDiff, plan.offsets[0]), `it is the fourcc ffmpeg's -tag:v hvc1 changes, the only change in the file (bytes ${twinDiff})`);

    const pf = await planHev1Retag(fileOf(hev1Frag));
    const fd = diffAt(hev1Frag, hvc1Frag);
    check(topLevel(hev1Frag).some(b => b.type === 'moof'), 'fragmented fixture has moof boxes');
    check(pf.reason === 'ok' && pf.offsets.length === 1 && inTag(fd, pf.offsets[0]), `fragmented: the entry ffmpeg changes (${pf.offsets} vs bytes ${fd})`);

    // moov first, not fragmented: ftyp, moov, then the rest (stco offsets are
    // wrong, which the probe never reads).
    const boxes = topLevel(hev1);
    const ftyp = boxes.find(b => b.type === 'ftyp'), moov = boxes.find(b => b.type === 'moov');
    const front = concat(ftyp.bytes, moov.bytes, ...boxes.filter(b => b !== ftyp && b !== moov).map(b => b.bytes));
    const pfr = await planHev1Retag(fileOf(front));
    check(pfr.offsets.length === 1 && pfr.offsets[0] === ftyp.size + (plan.offsets[0] - moov.off), `moov first: found at its new place (${pfr.offsets})`);

    // Two video tracks: the moov's trak copied (moov size patched).
    const trakAt = indexOfAscii(moov.bytes, 'trak') - 4;
    const trak = moov.bytes.subarray(trakAt, trakAt + u32(moov.bytes, trakAt));
    const moov2 = concat(moov.bytes, trak); put32(moov2, 0, moov2.length);
    const two = concat(ftyp.bytes, moov2);
    const p2 = await planHev1Retag(fileOf(two));
    check(p2.offsets.length === 2 && p2.offsets.every(o => ascii(two, o) === 'hev1'), `two hev1 tracks: two patches (${p2.offsets})`);
    const r2 = await bytesOf(retaggedFile(fileOf(two), p2.offsets));
    check(p2.offsets.every(o => ascii(r2, o) === 'hvc1') && diffAt(two, r2).length === 4, 'both re-tagged, nothing else changed');

    // Pure stsd parse.
    const stsdAt = indexOfAscii(hev1, 'stsd') - 4;
    const stsd = hev1.subarray(stsdAt, stsdAt + u32(hev1, stsdAt));
    const ents = hev1EntriesInStsd(stsd, stsdAt);
    check(ents.length === 1 && ents[0].offset === plan.offsets[0], 'hev1EntriesInStsd: same entry from the stsd bytes alone');
}

// =========================================================================
section('2. the re-tagged File equals ffmpeg\'s -tag:v hvc1 twin');
for (const [src, twin, label] of [[hev1, hvc1, 'moov at end'], [hev1Frag, hvc1Frag, 'fragmented']]) {
    const f = fileOf(src, 'cam.mp4');
    const plan = await planHev1Retag(f);
    const out = await bytesOf(retaggedFile(f, plan.offsets));
    const at = plan.offsets[0];
    check(equal(entryAt(out, at), entryAt(twin, at)), `${label}: sample entry (with its hvcC) equals ffmpeg's`);
    check(equal(out, twin), `${label}: whole file equals ffmpeg's twin byte for byte (${out.length} bytes)`);
    check(equal(await bytesOf(f), src), `${label}: the original File still reads hev1`);
}

// =========================================================================
section('3. hvcC without its parameter sets → no patch');
{
    const at = (await planHev1Retag(fileOf(hev1))).offsets[0];
    const hvcCAt = indexOfAscii(hev1, 'hvcC', at) - 4;
    const rec = hev1.subarray(hvcCAt + 8, hvcCAt + u32(hev1, hvcCAt));
    const ps = hvccParameterSets(rec);
    check(ps.complete && ps.vps === 1 && ps.sps === 1 && ps.pps === 1 && !ps.malformed, `fixture's hvcC: VPS ${ps.vps}, SPS ${ps.sps}, PPS ${ps.pps}`);
    // Arrays are VPS, SPS, PPS, (x265's SEI): claim only 2 arrays.
    const types = []; { let p = 23; for (let a = 0; a < rec[22]; a++) { types.push(rec[p] & 63); const n = (rec[p + 1] << 8) | rec[p + 2]; p += 3; for (let k = 0; k < n; k++) p += 2 + ((rec[p] << 8) | rec[p + 1]); } }
    check(types.slice(0, 3).join() === '32,33,34', `array order ${types}`);
    const cases = [
        ['no PPS array (numOfArrays 2)', (b) => { b[hvcCAt + 8 + 22] = 2; }],
        ['an empty PPS array (numNalus 0, NAL dropped)', null],
        ['PPS array relabelled SEI (type 39)', (b) => { let p = hvcCAt + 8 + 23; for (let a = 0; a < 2; a++) { const n = (b[p + 1] << 8) | b[p + 2]; p += 3; for (let k = 0; k < n; k++) p += 2 + ((b[p] << 8) | b[p + 1]); } b[p] = (b[p] & 0xc0) | 39; }],
        ['no hvcC box', (b) => { b[hvcCAt + 4] = 0x78; }],
        ['hvcC cut short (array runs past the box)', (b) => { b[hvcCAt + 8 + 22] = 9; }],
        ['configurationVersion 0', (b) => { b[hvcCAt + 8] = 0; }],
    ];
    for (const [label, mutate] of cases) {
        let b;
        if (mutate) { b = hev1.slice(); mutate(b); }
        else {
            // Remove the PPS NAL bytes and set numNalus 0; shrink hvcC, entry,
            // stsd, stbl, minf, mdia, trak and moov by the same amount.
            let p = hvcCAt + 8 + 23;
            for (let a = 0; a < 2; a++) { const n = (hev1[p + 1] << 8) | hev1[p + 2]; p += 3; for (let k = 0; k < n; k++) p += 2 + ((hev1[p] << 8) | hev1[p + 1]); }
            const nalLen = 2 + ((hev1[p + 3] << 8) | hev1[p + 4]);
            b = concat(hev1.subarray(0, p + 3 + 0), hev1.subarray(p + 3 + nalLen));
            b[p + 1] = 0; b[p + 2] = 0;
            for (const t of ['hvcC', 'hev1', 'stsd', 'stbl', 'minf', 'mdia', 'trak', 'moov']) {
                const i = t === 'hvcC' ? hvcCAt : (t === 'hev1' ? at - 4 : (() => { let j = -1, k = 0; while ((k = indexOfAscii(hev1, t, k)) >= 0 && k < p) { j = k - 4; k++; } return j; })());
                put32(b, i, u32(b, i) - nalLen);
            }
        }
        const plan = await planHev1Retag(fileOf(b));
        check(plan.offsets.length === 0 && plan.reason === 'incomplete-hvcc', `${label}: no patch (${plan.reason})`);
    }
}

// =========================================================================
section('4. no patch, never a throw');
{
    const avc = new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/fixtures/barcode-60/barcode-60.mp4')));
    const cut = topLevel(hev1).find(b => b.type === 'moov').off;
    const garbage = new Uint8Array(50000); for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 7919 + 13) & 255;
    const huge = concat(new Uint8Array([0, 0, 0, 1, 0x6d, 0x64, 0x61, 0x74, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), new Uint8Array(64));
    const badSize = concat(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x6d, 0x6f, 0x6f, 0x76]), new Uint8Array(100));
    const zeroSize = concat(new Uint8Array([0, 0, 0, 0, 0x6d, 0x6f, 0x6f, 0x76]), new Uint8Array(100));
    const tinyBox = concat(new Uint8Array([0, 0, 0, 4, 0x66, 0x74, 0x79, 0x70]), new Uint8Array(100));
    const cases = [
        ['avc1 (H.264)', avc, 'no-hev1'], ['hvc1 already', hvc1, 'no-hev1'], ['hvc1 fragmented', hvc1Frag, 'no-hev1'],
        ['truncated before moov', hev1.subarray(0, cut), 'no-moov'], ['truncated inside the first box', hev1.subarray(0, 20), null],
        ['garbage', garbage, 'not-mp4'], ['empty', new Uint8Array(0), 'not-mp4'], ['10 bytes', hev1.subarray(0, 10), 'not-mp4'],
        ['64-bit size past the end', huge, null], ['size larger than the file', badSize, null], ['size 0 moov of zeros', zeroSize, null],
        ['box smaller than its header', tinyBox, null],
    ];
    for (const [label, bytes, reason] of cases) {
        let plan, threw = null;
        try { plan = await planHev1Retag(fileOf(bytes)); } catch (e) { threw = e; }
        check(!threw && plan.offsets.length === 0 && (reason == null || plan.reason === reason),
            `${label}: no patch (${threw ? 'THREW ' + threw.message : plan.reason})`);
    }
    const notBlob = await planHev1Retag('http://example.com/x.mp4');
    check(notBlob.offsets.length === 0, 'a URL string: no patch');
}

// =========================================================================
section('5. the probe never reads the mdat');
{
    // ftyp, a 20 MB mdat of non-zero bytes, then the fixture's moov.
    const boxes = topLevel(hev1);
    const ftyp = boxes.find(b => b.type === 'ftyp').bytes, moov = boxes.find(b => b.type === 'moov').bytes;
    const mdat = new Uint8Array(20 << 20).fill(0xab); put32(mdat, 0, mdat.length); mdat.set([0x6d, 0x64, 0x61, 0x74], 4);
    let readBytes = 0, reads = 0;
    class CountingFile extends File {
        slice(a, b) { reads++; readBytes += Math.min(b, this.size) - a; return super.slice(a, b); }
    }
    const big = new CountingFile([ftyp, mdat, moov], 'big.mp4', { type: 'video/mp4' });
    const plan = await planHev1Retag(big);
    check(plan.offsets.length === 1 && plan.offsets[0] === ftyp.length + mdat.length + (indexOfAscii(moov, 'hev1')), 'found past a 20 MB mdat');
    check(readBytes < 200 * 1024, `read ${(readBytes / 1024).toFixed(0)} KiB in ${reads} reads of a ${(big.size / 1048576).toFixed(0)} MB file`);
}

// =========================================================================
section('6. playbackSourceFor: the File every video consumer gets');
{
    const orig = fileOf(hev1, 'back-cam_h265.mp4', { lastModified: 1700000000123 });
    Object.defineProperty(orig, 'webkitRelativePath', { value: 'session/back/back-cam_h265.mp4' });
    const before = Object.getOwnPropertyNames(orig).join();

    globalThis.__lucidHev1RetagGate = false;
    const off = playbackSourceFor(orig);
    check(off === orig, 'gate off: the original File itself, synchronously (no Promise)');
    check(await videoFileForPlayback(orig) === orig, 'gate off: videoFileForPlayback resolves to the original');

    globalThis.__lucidHev1RetagGate = true;
    const pending = playbackSourceFor(orig);
    check(pending instanceof Promise, 'gate on: a Promise (the probe reads)');
    const out = await pending;
    check(out !== orig && out instanceof File, 'a different File');
    check(out.name === orig.name && out.type === orig.type && out.size === orig.size && out.lastModified === orig.lastModified,
        `name, type, size and lastModified kept (${out.name}, ${out.type}, ${out.lastModified})`);
    check(out.webkitRelativePath === 'session/back/back-cam_h265.mp4', `webkitRelativePath kept (${out.webkitRelativePath})`);
    check(out.lucidHev1Retag && out.lucidHev1Retag.original === orig && out.lucidHev1Retag.offsets.length === 1, 'carries lucidHev1Retag { original, offsets }');
    const ob = await bytesOf(out);
    check(ascii(ob, out.lucidHev1Retag.offsets[0]) === 'hvc1' && equal(ob, hvc1), 'reads as ffmpeg\'s hvc1 twin');
    check(equal(await bytesOf(orig), hev1) && Object.getOwnPropertyNames(orig).join() === before && !('lucidHev1Retag' in orig),
        'the original File is untouched (bytes and properties)');
    check(await playbackSourceFor(orig) === out, 'a second call gives the SAME patched File (one probe per File)');
    check(playbackSourceFor(out) === out, 'the patched File passes through as it is');

    const avcFile = fileOf(new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/fixtures/barcode-60/barcode-60.mp4'))), 'avc.mp4');
    check(await playbackSourceFor(avcFile) === avcFile, 'gate on, H.264: the original File');
    const blob = new Blob([hev1]);
    check(playbackSourceFor(blob) === blob, 'a plain Blob (no name): passed through');
    check(playbackSourceFor('x.mp4') === 'x.mp4', 'a URL: passed through');

    // 7. note
    section('7. the status note and the gate');
    check(isPlayedRetagged(orig) && isPlayedRetagged({ file: orig }) && isPlayedRetagged(out) && !isPlayedRetagged(avcFile), 'isPlayedRetagged: original, {file}, patched; not the H.264');
    check(hev1RetagNote([orig, avcFile]) === 'played 1 HEVC video tagged hev1 as hvc1 (files unchanged)', hev1RetagNote([orig, avcFile]));
    check(hev1RetagNote([avcFile]) === '' && hev1RetagNote(null) === '', 'no note without a re-tag');
    check(withHev1RetagNote('Loaded 8 camera(s)', [{ file: orig }]) === 'Loaded 8 camera(s) — played 1 HEVC video tagged hev1 as hvc1 (files unchanged)', 'appended after an em dash');
    check(withHev1RetagNote('Loaded', []) === 'Loaded', 'unchanged without one');
    delete globalThis.__lucidHev1RetagGate;
}
{
    const SAFARI = (t) => /hvc1|avc1/.test(t) ? 'probably' : '';
    const CHROME = (t) => /hvc1|hev1|avc1|av01/.test(t) ? 'probably' : '';
    const NO_HEVC = (t) => /avc1|av01/.test(t) ? 'probably' : '';
    check(hev1RetagNeeded({ canPlayType: SAFARI }) === true, 'Safari / WKWebView (hvc1 yes, hev1 no): needed');
    check(hev1RetagNeeded({ canPlayType: CHROME }) === false, 'Chrome / Firefox (hev1 plays): not needed');
    check(hev1RetagNeeded({ canPlayType: NO_HEVC }) === false, 'no HEVC at all: not needed (nothing to gain)');
    globalThis.__lucidHev1RetagGate = true;
    check(hev1RetagNeeded({ canPlayType: CHROME }) === true, '__lucidHev1RetagGate = true forces it on');
    delete globalThis.__lucidHev1RetagGate;
    // Node has no <video>: canPlayType unavailable → not needed.
    check(hev1RetagNeeded() === false, 'no <video> element (Node): not needed');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
