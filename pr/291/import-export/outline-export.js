// import-export/outline-export.js — the file side of Outlines ▸ Export flagged
// frames (ui/outline-flags-panel.js): a ZIP holding, per flagged camera frame,
// the frame, its current outlines as a label image and a preview, plus each
// camera's empty arena and a manifest. DOM-free (Node tests run it).
//
// Layout (README.txt in the ZIP says the same):
//   manifest.json                     format 'lucid-outline-flags' v1
//   backgrounds/<camera>.png          8-bit grey: the camera's empty arena
//   frames/<frame>_<camera>.png       the frame as decoded
//   labels/<frame>_<camera>.png       8-bit grey: 0 = no animal, k = the k-th
//                                     animal of that entry's `animals` (the
//                                     hand-corrected outline where `edited`)
//   labels_auto/<frame>_<camera>.png  a corrected entry's computed outline
//   previews/<frame>_<camera>.jpg     the frame with the outlines drawn
//
// Writers: `zipStore` (stored, no compression: PNG/JPEG are compressed
// already), `encodePngGray` (zlib through CompressionStream('deflate')),
// `crc32`. File names are sanitized by `safeFileName`.

var CRC_TABLE = null;

/** CRC-32 (IEEE) of `bytes`, optionally continuing `crc`. */
export function crc32(bytes, crc) {
    if (!CRC_TABLE) {
        CRC_TABLE = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            CRC_TABLE[n] = c >>> 0;
        }
    }
    var x = (crc == null ? 0 : crc) ^ 0xffffffff;
    for (var i = 0; i < bytes.length; i++) x = CRC_TABLE[(x ^ bytes[i]) & 0xff] ^ (x >>> 8);
    return (x ^ 0xffffffff) >>> 0;
}

/** A name safe as one path part of a file name in the ZIP. */
export function safeFileName(s) {
    return String(s == null ? '' : s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, '_').slice(0, 80) || '_';
}

function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
}
function dosDate(d) {
    return ((Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
}

/**
 * A ZIP (stored entries, UTF-8 names) of `entries` = [{name, data: Uint8Array |
 * string}]. -> Uint8Array. Under 4 GB and 65,535 entries.
 */
export function zipStore(entries, date) {
    var enc = new TextEncoder();
    var when = date || new Date();
    var t = dosTime(when), d = dosDate(when);
    var files = entries.map(function (e) {
        var data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
        return { name: enc.encode(e.name), data: data, crc: crc32(data) };
    });
    var size = 22;
    files.forEach(function (f) { size += 30 + f.name.length + f.data.length + 46 + f.name.length; });
    if (size > 0xffffffff || files.length > 0xffff) throw new Error('too much for a ZIP without ZIP64');
    var out = new Uint8Array(size);
    var dv = new DataView(out.buffer);
    var o = 0;
    var offsets = [];
    files.forEach(function (f) {
        offsets.push(o);
        dv.setUint32(o, 0x04034b50, true);
        dv.setUint16(o + 4, 20, true);
        dv.setUint16(o + 6, 0x0800, true);          // UTF-8 names
        dv.setUint16(o + 8, 0, true);               // stored
        dv.setUint16(o + 10, t, true);
        dv.setUint16(o + 12, d, true);
        dv.setUint32(o + 14, f.crc, true);
        dv.setUint32(o + 18, f.data.length, true);
        dv.setUint32(o + 22, f.data.length, true);
        dv.setUint16(o + 26, f.name.length, true);
        dv.setUint16(o + 28, 0, true);
        out.set(f.name, o + 30);
        out.set(f.data, o + 30 + f.name.length);
        o += 30 + f.name.length + f.data.length;
    });
    var cd = o;
    files.forEach(function (f, i) {
        dv.setUint32(o, 0x02014b50, true);
        dv.setUint16(o + 4, 20, true);
        dv.setUint16(o + 6, 20, true);
        dv.setUint16(o + 8, 0x0800, true);
        dv.setUint16(o + 10, 0, true);
        dv.setUint16(o + 12, t, true);
        dv.setUint16(o + 14, d, true);
        dv.setUint32(o + 16, f.crc, true);
        dv.setUint32(o + 20, f.data.length, true);
        dv.setUint32(o + 24, f.data.length, true);
        dv.setUint16(o + 28, f.name.length, true);
        dv.setUint16(o + 30, 0, true);
        dv.setUint16(o + 32, 0, true);
        dv.setUint16(o + 34, 0, true);
        dv.setUint16(o + 36, 0, true);
        dv.setUint32(o + 38, 0, true);
        dv.setUint32(o + 42, offsets[i], true);
        out.set(f.name, o + 46);
        o += 46 + f.name.length;
    });
    dv.setUint32(o, 0x06054b50, true);
    dv.setUint16(o + 4, 0, true);
    dv.setUint16(o + 6, 0, true);
    dv.setUint16(o + 8, files.length, true);
    dv.setUint16(o + 10, files.length, true);
    dv.setUint32(o + 12, o - cd, true);
    dv.setUint32(o + 16, cd, true);
    dv.setUint16(o + 20, 0, true);
    return out;
}

/** The entries of a stored ZIP made by `zipStore` (tests). -> [{name, data}] */
export function unzipStore(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var dec = new TextDecoder();
    var e = bytes.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('not a ZIP');
    var n = dv.getUint16(e + 10, true), o = dv.getUint32(e + 16, true);
    var out = [];
    for (var i = 0; i < n; i++) {
        if (dv.getUint32(o, true) !== 0x02014b50) throw new Error('bad central directory');
        var size = dv.getUint32(o + 24, true), nl = dv.getUint16(o + 28, true), xl = dv.getUint16(o + 30, true), cl = dv.getUint16(o + 32, true);
        var lo = dv.getUint32(o + 42, true);
        var name = dec.decode(bytes.subarray(o + 46, o + 46 + nl));
        var lnl = dv.getUint16(lo + 26, true), lxl = dv.getUint16(lo + 28, true);
        var start = lo + 30 + lnl + lxl;
        var data = bytes.subarray(start, start + size);
        if (crc32(data) !== dv.getUint32(o + 16, true)) throw new Error('CRC mismatch in ' + name);
        out.push({ name: name, data: data });
        o += 46 + nl + xl + cl;
    }
    return out;
}

async function deflateZlib(bytes) {
    if (typeof CompressionStream === 'undefined') throw new Error('this browser cannot compress (CompressionStream)');
    var cs = new CompressionStream('deflate');
    var stream = new Blob([bytes]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type, data) {
    var out = new Uint8Array(12 + data.length);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}

/** An 8-bit greyscale PNG of `pixels` (w*h bytes, row-major). -> Promise<Uint8Array> */
export async function encodePngGray(pixels, w, h) {
    if (pixels.length < w * h) throw new Error('encodePngGray: too few pixels');
    var raw = new Uint8Array((w + 1) * h);
    for (var y = 0; y < h; y++) {
        raw[y * (w + 1)] = 0;                       // filter: none
        raw.set(pixels.subarray(y * w, y * w + w), y * (w + 1) + 1);
    }
    var ihdr = new Uint8Array(13);
    var dv = new DataView(ihdr.buffer);
    dv.setUint32(0, w); dv.setUint32(4, h);
    ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    var parts = [
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', await deflateZlib(raw)),
        chunk('IEND', new Uint8Array(0)),
    ];
    var n = parts.reduce(function (s, p) { return s + p.length; }, 0);
    var out = new Uint8Array(n), o = 0;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
}

/** The README.txt put in every export. */
export var OUTLINE_EXPORT_README = [
    'LUC3D outline flags export (format lucid-outline-flags, version 1)',
    '',
    'manifest.json            the flags, the outline parameters, each camera\'s empty arena and area model,',
    '                         and per flagged camera frame the animals its label image numbers',
    'backgrounds/<cam>.png    8-bit grey: the camera\'s empty-arena image (per-pixel median of sampled frames)',
    'frames/<f>_<cam>.png     the frame as decoded',
    'labels/<f>_<cam>.png     8-bit grey: 0 = no animal, k = entry.animals[k-1] (the outlines as LUC3D drew them;',
    '                         corrected by hand where entry.edited is true)',
    'labels_auto/<f>_<cam>.png  for a corrected entry, the computed outline (numbered by entry.animals_auto)',
    'previews/<f>_<cam>.jpg   the frame with the outlines drawn',
    '',
    'Frame numbers are 0-based video frame indices.',
    '',
].join('\n');

/** The base name of one camera frame's files: '<frame, 6 digits>_<camera>'. */
export function outlineEntryBase(frame, camera) {
    return String(frame).padStart(6, '0') + '_' + safeFileName(camera);
}
