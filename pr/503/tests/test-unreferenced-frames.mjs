/**
 * test-unreferenced-frames.mjs — ui/image-embedder.js `referenceFormat` and
 * `isUnreferenced`: which encoded pictures no other picture is predicted from,
 * so the image ID-switch check may leave them undecoded (unless one is a sample).
 * Byte-level fixtures; the decoded-pixel side is tests/e2e/image-unreferenced-skip.mjs.
 * Run: node tests/test-unreferenced-frames.mjs
 */
import { referenceFormat, isUnreferenced } from '../ui/image-embedder.js';

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

// ---- hvcC: 23-byte header + arrays; the SPS's second header byte is followed by vps_id(4) max_sub_layers_minus1(3) nesting(1)
const hvcC = (maxSubLayersMinus1, lengthSize = 4, withSps = true) => {
    const head = new Uint8Array(23);
    head[0] = 1; head[21] = 0x0f & (0x08 | (lengthSize - 1));   // numTemporalLayers 1, temporalIdNested, lengthSizeMinusOne
    const arrays = [];
    const nal = (type, body) => { const n = Uint8Array.of(type << 1, 1, ...body); return [0x80 | type, 0, 1, n.length >> 8, n.length & 0xff, ...n]; };
    arrays.push(...nal(32, [0x0c, 1, 0xff]));                                   // VPS
    if (withSps) arrays.push(...nal(33, [(maxSubLayersMinus1 << 1) | 1, 1, 0x60])); // SPS
    arrays.push(...nal(34, [0xc1]));                                            // PPS
    head[22] = withSps ? 3 : 2;
    return Uint8Array.of(...head, ...arrays);
};
// one access unit: length-prefixed NAL units [type, temporalId]
const hevcAU = (nals, L = 4) => {
    const out = [];
    for (const [type, tid, len = 6] of nals) {
        const n = [type << 1, tid + 1]; while (n.length < len) n.push(0xa5);
        const pre = []; for (let i = L - 1; i >= 0; i--) pre.push((n.length >> (8 * i)) & 0xff);
        out.push(...pre, ...n);
    }
    return Uint8Array.from(out);
};

console.log('referenceFormat');
const f0 = referenceFormat({ codec: 'hev1.1.6.L120.90', description: hvcC(0) });
check(f0 && f0.codec === 'hevc' && f0.lengthSize === 4 && f0.maxTid === 0, `HEVC, one sub-layer: ${JSON.stringify(f0)}`);
const f2 = referenceFormat({ codec: 'hvc1.1.6.L120.90', description: hvcC(2, 2).buffer });
check(f2 && f2.maxTid === 2 && f2.lengthSize === 2, `HEVC with 3 sub-layers, 2-byte lengths, description as an ArrayBuffer: ${JSON.stringify(f2)}`);
check(referenceFormat({ codec: 'hev1.1.6.L120.90', description: hvcC(0, 4, false) }) === null, 'HEVC without an SPS in hvcC: null (decode everything)');
check(referenceFormat({ codec: 'hev1.1.6.L120.90' }) === null, 'no description (Annex B): null');
const avcC = Uint8Array.of(1, 0x64, 0, 0x1f, 0xff, 0xe1, 0, 0);
const fa = referenceFormat({ codec: 'avc1.64001f', description: avcC });
check(fa && fa.codec === 'avc' && fa.lengthSize === 4, `H.264: ${JSON.stringify(fa)}`);
check(referenceFormat({ codec: 'av01.0.08M.08', description: Uint8Array.of(0x81, 0, 0, 0) }) === null &&
      referenceFormat({ codec: 'vp09.00.10.08', description: Uint8Array.of(1) }) === null, 'AV1 / VP9: null');

console.log('isUnreferenced — HEVC');
check(isUnreferenced(hevcAU([[35, 0], [39, 0], [0, 0]]), f0), 'TRAIL_N after an AUD and an SEI, one sub-layer: unreferenced');
check(!isUnreferenced(hevcAU([[1, 0]]), f0), 'TRAIL_R: referenced');
check(isUnreferenced(hevcAU([[8, 0]]), f0) && !isUnreferenced(hevcAU([[9, 0]]), f0), 'RASL_N unreferenced, RASL_R referenced');
check(!isUnreferenced(hevcAU([[21, 0]]), f0) && !isUnreferenced(hevcAU([[19, 0]]), f0), 'CRA / IDR: referenced');
check(isUnreferenced(hevcAU([[0, 2]], 2), f2) && !isUnreferenced(hevcAU([[0, 1]], 2), f2) && !isUnreferenced(hevcAU([[2, 0]], 2), f2),
      'with 3 sub-layers a _N picture is unreferenced only at the top one (a lower one may be a higher layer\'s reference)');
check(isUnreferenced(hevcAU([[0, 0]], 2), { codec: 'hevc', lengthSize: 2, maxTid: 0 }), '2-byte NAL lengths');
const cut = hevcAU([[35, 0], [0, 0]]).slice(0, 9);
check(!isUnreferenced(cut, f0), 'a length running past the packet (no slice reached): referenced (decode it)');
check(!isUnreferenced(hevcAU([[35, 0], [39, 0]]), f0), 'no slice NAL at all: referenced');

console.log('isUnreferenced — H.264');
const avcAU = (nals) => Uint8Array.from(nals.flatMap(b => [0, 0, 0, 3, b, 0x88, 0x84]));
check(isUnreferenced(avcAU([0x09, 0x06, 0x01]), fa), 'non-IDR slice with nal_ref_idc 0 (after AUD, SEI): unreferenced');
check(!isUnreferenced(avcAU([0x21]), fa) && !isUnreferenced(avcAU([0x41]), fa), 'nal_ref_idc 1 or 2: referenced');
check(!isUnreferenced(avcAU([0x65]), fa), 'IDR: referenced');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
