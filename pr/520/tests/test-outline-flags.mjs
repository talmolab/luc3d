/**
 * test-outline-flags.mjs — flags on bad animal outlines (pose/outline-flags.js),
 * their `metadata.lucid` mapping (import-export/outline-flags-metadata.js) and
 * the export's writers (import-export/outline-export.js: stored ZIP, 8-bit grey
 * PNG), and outlines corrected with the brush (pose/outline-edits.js: painting,
 * undo, run-length rows, their save and read). DOM-free; ESM, so
 * tests/run-mjs-tests.mjs picks it up.
 */
import zlib from 'node:zlib';
import {
    OUTLINE_FLAG_REASONS, addOutlineFlag, removeOutlineFlag, outlineFlags, outlineFlagsAt, serializeOutlineFlags,
    ingestOutlineFlags, normalizeOutlineFlag, outlineFlagReasonLabel, OUTLINE_NOTE_MAX,
} from '../pose/outline-flags.js';
import { OUTLINE_FLAGS_METADATA_KEYS, writeOutlineFlagsMetadata, readOutlineFlagsMetadata } from '../import-export/outline-flags-metadata.js';
import { crc32, zipStore, unzipStore, encodePngGray, safeFileName, outlineEntryBase } from '../import-export/outline-export.js';
import {
    beginOutlineEdit, outlineEditAt, outlineEdits, revertOutlineEdit, paintDisc, paintSegment, pushStroke, undoStroke,
    rleEncode, rleDecode, serializeOutlineEdits, ingestOutlineEdits,
} from '../pose/outline-edits.js';
import { labelImageContours } from '../pose/outline-core.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};

console.log('\n1. Flags on a session');
{
    const s = {};
    check(outlineFlags(s).length === 0 && outlineFlags(null).length === 0, 'none to start with');
    const a = addOutlineFlag(s, { frame: 45, camera: 'topC', animal: 'id_0', identity: 0, track: 3, source: '2d', reason: 'tail', note: 'over B' });
    addOutlineFlag(s, { frame: 0, camera: 'mid', animal: 'id_1', reason: 'limb' });
    addOutlineFlag(s, { frame: 45, camera: 'mid', animal: null, reason: 'bleed' });
    check(a && a.at && /^\d{4}-/.test(a.at), 'a flag gets its time');
    check(outlineFlags(s).map(f => f.frame + f.camera).join() === '0mid,45mid,45topC', 'kept sorted by frame, then camera');
    addOutlineFlag(s, { frame: 45, camera: 'topC', animal: 'id_0', reason: 'split' });
    check(outlineFlags(s).length === 3 && outlineFlagsAt(s, 45, 'topC')[0].reason === 'split', 'the same frame, camera and animal replaces');
    check(addOutlineFlag(s, { frame: -1, camera: 'x', reason: 'tail' }) === null && addOutlineFlag(s, { frame: 1, reason: 'tail' }) === null, 'no frame or camera: not a flag');
    check(normalizeOutlineFlag({ frame: 1, camera: 'c', reason: 'nonsense', identity: -1, track: 2.5, source: 'x' }).reason === 'other', 'an unknown reason reads as other');
    const n = normalizeOutlineFlag({ frame: 1, camera: 'c', reason: 'limb', identity: -1, track: 2.5, source: 'x', note: 'n'.repeat(500) });
    check(n.identity === null && n.track === null && n.source === null && n.note.length === OUTLINE_NOTE_MAX, 'bad ids become null; the note is capped');
    check(removeOutlineFlag(s, { frame: 0, camera: 'mid', animal: 'id_1' }) && outlineFlags(s).length === 2, 'remove by frame, camera, animal');
    check(!removeOutlineFlag(s, { frame: 9, camera: 'mid', animal: null }), 'removing a flag that is not there');
    check(OUTLINE_FLAG_REASONS.length === 6 && outlineFlagReasonLabel('tail') === 'Tail on the wrong animal', 'reasons and their labels');
}

console.log('\n2. metadata.lucid: written only when there are flags, read back exactly');
{
    const s = {};
    check(JSON.stringify(writeOutlineFlagsMetadata({ other: 1 }, s)) === '{"other":1}', 'no flags: no key, other keys untouched');
    check(serializeOutlineFlags(s) === null, 'serialize: null with none');
    addOutlineFlag(s, { frame: 6249, camera: 'topC', animal: 'id_0', identity: 0, track: 1, source: '3d', reason: 'tail', note: 'tail across the other mouse', at: '2026-11-21T08:00:00.000Z' });
    addOutlineFlag(s, { frame: 0, camera: 'mid', reason: 'limb', at: '2026-11-21T08:01:00.000Z' });
    const lucid = writeOutlineFlagsMetadata({ sessionName: 'x' }, s);
    check(Object.keys(lucid).join() === 'sessionName,outlineFlags' && OUTLINE_FLAGS_METADATA_KEYS.join() === 'outlineFlags,outlineEdits', 'only outlineFlags (no corrections: no outlineEdits)');
    check(JSON.stringify(lucid.outlineFlags.flags[0]) === '{"frame":0,"camera":"mid","reason":"limb","at":"2026-11-21T08:01:00.000Z"}', 'empty fields are left out');
    const back = readOutlineFlagsMetadata({ outlineFlags: [{ frame: 1, camera: 'z', reason: 'limb' }] }, JSON.parse(JSON.stringify(lucid)));
    check(JSON.stringify(back.outlineFlags) === JSON.stringify(s.outlineFlags), 'read back: the same flags, and the old ones replaced');
    const none = readOutlineFlagsMetadata({ outlineFlags: [{ frame: 1, camera: 'z', reason: 'limb' }] }, {});
    check(none.outlineFlags.length === 0, 'a file without the key leaves no flags');
    for (const junk of [null, 5, 'x', { v: 2, flags: [] }, { v: 1, flags: 'no' }, { v: 1, flags: [null, 7, { frame: 'a' }] }]) {
        const t = readOutlineFlagsMetadata({}, { outlineFlags: junk });
        if (t.outlineFlags.length) { check(false, 'garbage read as flags: ' + JSON.stringify(junk)); }
    }
    check(true, 'garbage reads as no flags, without throwing');
}

console.log('\n3. The export\'s writers');
{
    check(crc32(new TextEncoder().encode('123456789')) === 0xcbf43926, 'CRC-32 check value');
    const files = [{ name: 'README.txt', data: 'hello' }, { name: 'frames/000045_topC.png', data: new Uint8Array([1, 2, 3]) }, { name: 'café/ü.json', data: '{}' }];
    const zip = zipStore(files, new Date(2026, 10, 21, 8, 30, 0));
    const back = unzipStore(zip);
    check(back.map(f => f.name).join('|') === 'README.txt|frames/000045_topC.png|café/ü.json', 'ZIP: names (UTF-8) in order');
    check(new TextDecoder().decode(back[0].data) === 'hello' && Array.from(back[1].data).join() === '1,2,3', 'ZIP: contents');
    const w = 7, h = 3, px = new Uint8Array(w * h).map((_, i) => (i * 37) & 255);
    const png = await encodePngGray(px, w, h);
    check(png[0] === 0x89 && String.fromCharCode(...png.subarray(12, 16)) === 'IHDR', 'PNG: signature and IHDR');
    const idatLen = new DataView(png.buffer).getUint32(33);
    const raw = zlib.inflateSync(Buffer.from(png.subarray(41, 41 + idatLen)));
    let same = raw.length === (w + 1) * h;
    for (let y = 0; y < h && same; y++) for (let x = 0; x < w; x++) if (raw[y * (w + 1) + 1 + x] !== px[y * w + x] || raw[y * (w + 1)] !== 0) same = false;
    check(same, 'PNG: rows inflate back to the pixels');
    check(safeFileName('a/b:c d') === 'a_b_c_d' && outlineEntryBase(45, 'top C') === '000045_top_C', 'file names');
}

console.log('\n4. Corrected outlines: paint, erase, undo, save, read');
{
    const W = 40, H = 30, s = {};
    const base = new Uint8Array(W * H);
    for (let y = 10; y < 20; y++) for (let x = 5; x < 15; x++) base[y * W + x] = 1;      // animal 1
    for (let y = 10; y < 20; y++) for (let x = 25; x < 35; x++) base[y * W + x] = 2;     // animal 2
    const animals = [{ name: 'A', identity: 0, track: 2, source: '2d', color: '#f00' }, { name: 'B', source: '3d', color: '#0f0', junk: 1 }];
    const e = beginOutlineEdit(s, 45, 'topC', W, H, base, animals);
    check(e.labels !== base && e.labels[12 * W + 6] === 1 && e.version === 0, 'an edit starts from a COPY of the outline shown');
    check(beginOutlineEdit(s, 45, 'topC', W, H, new Uint8Array(W * H), []) === e, 'the same camera frame: the same edit');
    check(JSON.stringify(e.animals[1]) === '{"name":"B","identity":null,"track":null,"source":"3d","color":"#0f0"}', 'animals kept clean');
    const st1 = { idx: [], old: [] };
    const n1 = paintSegment(e.labels, W, H, 15, 15, 22, 15, 1.5, 1, st1);           // A reaches toward B
    check(n1 > 0 && e.labels[15 * W + 20] === 1 && e.labels[15 * W + 30] === 2, `drawing A over the floor (${n1} px), B untouched`);
    pushStroke(e, st1);
    const st2 = { idx: [], old: [] };
    paintDisc(e.labels, W, H, 30.5, 15.5, 2, 0, st2);                               // erase a bit of B
    check(e.labels[15 * W + 30] === 0 && e.labels[12 * W + 30] === 2, 'erasing clears only under the brush');
    pushStroke(e, st2);
    check(st2.idx.length === new Set(st2.idx).size, 'a stroke records each pixel once');
    check(undoStroke(e) && e.labels[15 * W + 30] === 2 && e.labels[15 * W + 20] === 1, 'undo takes back the last stroke only');
    check(undoStroke(e) && Array.from(e.labels).join() === Array.from(base).join() && !undoStroke(e), 'and the one before; then nothing is left to undo');
    paintSegment(e.labels, W, H, 15, 15, 22, 15, 1.5, 1, { idx: [], old: [] });
    const c = labelImageContours(e.labels, W, H, 2);
    check(c.length === 2 && c[0].length === 1 && c[1].length === 1, 'contours re-traced from the painted image');
    // run-length rows
    const L = Uint8Array.from([0, 0, 3, 3, 3, 0, 255]);
    check(rleEncode(L).join() === '0,2,3,3,0,1,255,1' && Array.from(rleDecode(rleEncode(L), 7)).join() === Array.from(L).join(), 'run-length rows round-trip');
    check(rleDecode([1, 3], 4) === null && rleDecode([1, 5], 4) === null && rleDecode([1, 2, 3], 3) === null && rleDecode([1, 0, 1, 3], 3) === null, 'bad rows read as nothing');
    // save and read
    check(serializeOutlineEdits({}) === null && !('outlineEdits' in writeOutlineFlagsMetadata({}, {})), 'no corrections: no key');
    const lucid = writeOutlineFlagsMetadata({}, s);
    check(lucid.outlineEdits && lucid.outlineEdits.v === 1 && lucid.outlineEdits.edits.length === 1 && !('undo' in lucid.outlineEdits.edits[0]), 'written as outlineEdits, without the undo history');
    check(JSON.stringify(lucid.outlineEdits).length < 2000, `small: ${JSON.stringify(lucid.outlineEdits).length} bytes of JSON for a ${W}x${H} image`);
    const back = readOutlineFlagsMetadata({ outlineEdits: new Map([['x', 1]]) }, JSON.parse(JSON.stringify(lucid)));
    const be = outlineEditAt(back, 45, 'topC');
    check(be && Array.from(be.labels).join() === Array.from(e.labels).join() && be.animals[0].name === 'A' && be.undo.length === 0, 'read back pixel for pixel; old edits replaced');
    check(ingestOutlineEdits(back, { v: 1, edits: [{ frame: 1, camera: 'c', w: 2, h: 2, rle: [0, 3] }, null, { frame: 2, camera: 'c', w: 2, h: 2, rle: [0, 4] }] }) === 1, 'a row that does not add up is skipped');
    check(revertOutlineEdit(back, 2, 'c') && outlineEdits(back).size === 0, 'revert throws a correction away');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
