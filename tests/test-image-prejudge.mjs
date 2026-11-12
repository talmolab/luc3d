/**
 * test-image-prejudge.mjs — pose/image-prejudge.js, the image check's pre-judge
 * of single-camera Track All's review list, on synthetic embeddings: each
 * animal a fixed random "appearance" vector plus noise.
 *  - separation (2-means, one crop per cluster per sample, started from the
 *    labels): distinct animals far apart, look-alikes close, too few samples none;
 *    labels swapped for part of the video do not hide the separation;
 *  - a row's keep − swap score: negative across a swap, positive across none;
 *  - verdicts: the gate (cos ≥ 0.7: 'alike', whatever the score), the margin
 *    ('unsure'), too few crops ('sparse'), too few samples ('unknown');
 *  - windows: ±3 s around the close spell, the spell itself left out;
 *  - the built-in model's settings (PREJUDGE_BUILTIN): no gate, margin 0.2.
 *
 * Run:  node tests/test-image-prejudge.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PJ = await import(pathToFileURL(path.join(HERE, '..', 'pose', 'image-prejudge.js')).href);

let passed = 0, failed = 0; const failures = [];
function ok(c, m) { if (c) passed++; else { failed++; failures.push(m); console.error('  ✗ ' + m); } }
function eq(a, e, m) { ok(a === e, `${m} (expected ${e}, got ${a})`); }
function group(n) { console.log('\n• ' + n); }

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }
const D = 48;
function proto(seed) { const r = rng(seed); return Float64Array.from({ length: D }, () => gauss(r)); }
// two animals' appearance at a given likeness: B = likeness·A + (1 − likeness)·other
function animals(likeness, seed) {
    const a = proto(seed), o = proto(seed + 1);
    return [a, Float64Array.from(a, (v, i) => likeness * v + (1 - likeness) * o[i])];
}
function crop(p, r, noise) { return PJ.unitVector(Float64Array.from(p, v => v + noise * gauss(r))); }

/**
 * A 2 Hz sample stream at `fps`, frames 0..`frames`, identity 0 and 1 present on every sample.
 * `swapAt`: from that frame on, labels 0 and 1 show the other animal. `gap`: frames with no crops (a close spell).
 */
function stream(P, { fps = 40, frames = 4000, swapAt = Infinity, gaps = [], noise = 0.6, seed = 5, missing = null } = {}) {
    const r = rng(seed), every = fps / 2, F = [], V = [];
    for (let f = 0; f <= frames; f += every) {
        if (gaps.some(([a, b]) => f >= a && f <= b)) continue;
        const sw = f >= swapAt;
        F.push(f);
        V.push([crop(P[sw ? 1 : 0], r, noise), crop(P[sw ? 0 : 1], r, noise)]);
    }
    return { frames: F, vector: (j, id) => (missing && missing(F[j], id)) ? null : (V[j][id] || null) };
}

group('pairSeparation — 2-means over the samples showing both animals');
{
    const far = stream(animals(0, 11));
    const near = stream(animals(0.92, 11));
    const pairsOf = (s) => s.frames.map((f, j) => [s.vector(j, 0), s.vector(j, 1)]);
    const a = PJ.pairSeparation(pairsOf(far)), b = PJ.pairSeparation(pairsOf(near));
    ok(a && a.cos < 0.3, `distinct animals: cluster means far apart (cos ${a && a.cos.toFixed(3)})`);
    ok(b && b.cos > 0.85, `look-alikes: cluster means close (cos ${b && b.cos.toFixed(3)})`);
    ok(a.agree > 0.99, `distinct animals, clean labels: the clusters keep the labels (${a.agree.toFixed(3)})`);
    eq(PJ.pairSeparation(pairsOf(far).slice(0, 9)), null, 'fewer than 10 samples: no separation');
    // labels swapped for the last 30%: started from the labels, 2-means still pulls the animals apart
    const sw = stream(animals(0, 11), { swapAt: 2800 });
    const c = PJ.pairSeparation(pairsOf(sw));
    ok(c && c.cos < 0.3, `labels swapped for 30% of the video: still far apart (cos ${c && c.cos.toFixed(3)})`);
    ok(c && Math.abs(c.agree - 0.7) < 0.03, `…and the clusters follow the animals, not the labels (keep ${c && c.agree.toFixed(3)})`);
}

group('rowScore — keep − swap, before vs after');
{
    const [A, B] = animals(0, 21), r = rng(3), n = (p) => Array.from({ length: 6 }, () => crop(p, r, 0.6));
    const kept = PJ.rowScore({ a0: n(A), b0: n(B), a1: n(A), b1: n(B) });
    const swapped = PJ.rowScore({ a0: n(A), b0: n(B), a1: n(B), b1: n(A) });
    ok(kept > 1, `labels kept: clearly positive (${kept.toFixed(3)})`);
    ok(swapped < -1, `labels swapped: clearly negative (${swapped.toFixed(3)})`);
    ok(Math.abs(kept + swapped) < 0.3, 'the two are mirror images (about)');
    eq(PJ.rowScore({ a0: n(A).slice(0, 1), b0: n(B), a1: n(A), b1: n(B) }), null, 'one crop of an animal on a side: no score');
    eq(PJ.rowScore({ a0: n(A).slice(0, 1), b0: n(B), a1: n(A), b1: n(B) }, 1) != null, true, 'minCrops 1: scored');
}

group('prejudgeVerdict — gate, margin, missing data');
{
    const sep = (cos) => ({ cos, agree: 1, n: 100 });
    eq(PJ.prejudgeVerdict(sep(0.3), -0.5), 'swapped', 'distinct, score −0.5');
    eq(PJ.prejudgeVerdict(sep(0.3), 0.5), 'kept', 'distinct, score +0.5');
    eq(PJ.prejudgeVerdict(sep(0.3), 0.05), 'unsure', 'distinct, |score| < margin 0.1');
    eq(PJ.prejudgeVerdict(sep(0.3), -0.1), 'unsure', 'score exactly −margin: unsure');
    eq(PJ.prejudgeVerdict(sep(0.69), -1.5), 'swapped', 'cos 0.69: under the gate');
    eq(PJ.prejudgeVerdict(sep(0.7), -1.5), 'alike', 'cos 0.70: at the gate → can\'t tell apart, whatever the score');
    eq(PJ.prejudgeVerdict(sep(0.95), 1.5), 'alike', 'cos 0.95: alike');
    eq(PJ.prejudgeVerdict(sep(0.3), null), 'sparse', 'no score: too few crops');
    eq(PJ.prejudgeVerdict(null, -1), 'unknown', 'no separation: too few samples');
    eq(PJ.prejudgeVerdict(sep(0.75), -1, { gateCos: 0.8 }), 'swapped', 'the gate is an option');
    eq(PJ.PREJUDGE_DEFAULTS.gateCos, 0.7, 'default gate 0.7 (gate_sweep, 2026-11-09)');
    eq(PJ.PREJUDGE_DEFAULTS.margin, 0.1, 'default margin 0.1');
    eq(PJ.PREJUDGE_DEFAULTS.windowSeconds, 3, 'default window ±3 s');
}

group('the built-in model — no gate, margin 0.2');
{
    const B = PJ.prejudgeSettings(true), F = PJ.prejudgeSettings(false);
    eq(B.gateCos, null, 'built-in: no gate (gate_sweep builtin_options, 2026-11-10)');
    eq(B.margin, 0.2, 'built-in: margin 0.2');
    eq(B.windowSeconds, 3, 'built-in: the rest as for a package');
    eq(F.gateCos, 0.7, 'a package: the gate');
    eq(F.margin, 0.1, 'a package: margin 0.1');
    const sep = (cos) => ({ cos, agree: 1, n: 100 });
    eq(PJ.prejudgeVerdict(sep(0.95), -0.25, B), 'swapped', 'no gate: cos 0.95 still gets a verdict');
    eq(PJ.prejudgeVerdict(sep(0.95), 0.15, B), 'unsure', 'margin 0.2: +0.15 unsure');
    eq(PJ.prejudgeVerdict(sep(0.95), 0.21, B), 'kept', 'margin 0.2: +0.21 kept');
    eq(PJ.prejudgeVerdict(null, -0.5, B), 'swapped', 'no gate: no separation needed');
    eq(PJ.prejudgeVerdict(null, null, B), 'sparse', 'no gate, no score: too few crops');
    const fps = 40, s = stream(animals(0.6, 31), { fps, swapAt: 2400, gaps: [[2380, 2420]], noise: 0.2 });
    const r = [{ frame: 2420, startFrame: 2380, identityA: 0, identityB: 1 }];
    const pk = PJ.prejudgeReviewRows(s, r, fps).rows[0];
    eq(pk.verdict, 'alike', `fairly alike (cos ${pk.cos.toFixed(3)}), the package settings: alike`);
    const b = PJ.prejudgeReviewRows(s, r, fps, B);
    eq(b.rows[0].verdict, 'swapped', `fairly alike, the built-in settings: judged by the score alone (${b.rows[0].score.toFixed(3)})`);
    eq(b.gateCos, null, 'reports no gate');
}

group('prejudgeReviewRows — rows of a video with one swap');
{
    const fps = 40;
    // a swap at 1:00 (frame 2400) inside a close spell 2380–2420 with no crops; another spell at 0:30 with no swap
    const s = stream(animals(0, 31), { fps, swapAt: 2400, gaps: [[2380, 2420], [1180, 1220]] });
    const rows = [{ frame: 2420, startFrame: 2380, identityA: 0, identityB: 1 },
                  { frame: 1220, startFrame: 1180, identityA: 1, identityB: 0 },
                  { frame: 3990, identityA: 0, identityB: 1 }];          // at the end: nothing after it
    const pj = PJ.prejudgeReviewRows(s, rows, fps);
    eq(pj.rows.length, 3, 'one result per row');
    eq(pj.rows[0].verdict, 'swapped', `the swap's row (score ${pj.rows[0].score && pj.rows[0].score.toFixed(2)})`);
    eq(pj.rows[1].verdict, 'kept', `the clean encounter's row, pair given B–A (score ${pj.rows[1].score && pj.rows[1].score.toFixed(2)})`);
    eq(pj.rows[2].verdict, 'sparse', 'a row at the end of the video: no crops after it');
    eq(pj.rows[2].startFrame, 3990, 'a row without a start starts at its frame');
    eq(pj.pairs.length, 1, 'one pair, separated once');
    ok(pj.pairs[0].cos < 0.3 && pj.pairs[0].samples > 150, `the pair's separation (cos ${pj.pairs[0].cos.toFixed(3)} over ${pj.pairs[0].samples} samples)`);
    eq(pj.gateCos, 0.7, 'reports the gate it used');
    eq(PJ.prejudgeFor(pj, { frame: 1220, identityA: 0, identityB: 1 }), pj.rows[1], 'prejudgeFor: by frame and pair, either order');
    eq(PJ.prejudgeFor(pj, { frame: 1221, identityA: 0, identityB: 1 }), null, 'prejudgeFor: another frame → null');
    eq(PJ.prejudgeFor(null, rows[0]), null, 'prejudgeFor: no pre-judge → null');

    // windows are ±3 s around the spell: crops 3–6 s before a row do not count
    const far = PJ.prejudgeReviewRows(stream(animals(0, 31), { fps, swapAt: 2400, gaps: [[2160, 2420]] }),
        [{ frame: 2420, startFrame: 2400, identityA: 0, identityB: 1 }], fps);
    eq(far.rows[0].verdict, 'sparse', 'no crops in the 3 s before the spell → sparse (crops further back are not read)');

    // look-alike animals: the same swap gets no verdict
    const alike = PJ.prejudgeReviewRows(stream(animals(0.95, 31), { fps, swapAt: 2400, gaps: [[2380, 2420]] }), rows.slice(0, 1), fps);
    eq(alike.rows[0].verdict, 'alike', `look-alikes (cos ${alike.rows[0].cos.toFixed(3)}): can't tell them apart`);

    // one identity hardly ever cropped together with the other: no separation
    const lone = PJ.prejudgeReviewRows(stream(animals(0, 31), { fps, missing: (f, id) => id === 1 && f > 150 }), rows.slice(0, 1), fps);
    eq(lone.rows[0].verdict, 'unknown', 'fewer than 10 samples show both: unknown');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => ' - ' + f).join('\n')); process.exit(1); }
