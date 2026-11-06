/**
 * test-embedding-cache.mjs — pose/embedding-cache.js, the store behind the
 * image ID-switch check's repeat runs (ui/image-embedder.js).
 *
 * The cache is only safe if a hit is the vector a fresh run would produce, so
 * `cropKeyHash` must change with EVERY input of `cutCrop` besides the image —
 * centre, angle, scale, the body length that sets the mask's dilation, the
 * animal's hull and each masked hull — down to the last bit (no rounding), and
 * must not change with what the crop ignores (the keypoints kept for the dialog's
 * overlay); only masks that can reach the crop square count (`hullsReachingCrop`,
 * whose pixel-level losslessness tests/e2e/image-check-cache.mjs checks). The LRU must stay bounded, recycle slots without leaking one entry's
 * values into another, and hand out copies.
 * (The end-to-end proof — same flags, scores and vectors with and without the
 * cache — is tests/e2e/image-check-cache.mjs.)
 *
 * ESM, so `tests/run-mjs-tests.mjs` picks it up.
 */
import { cropKeyHash, hullsReachingCrop, MASK_REACH_MARGIN, EmbeddingCache, EMBED_CACHE_MAX_ENTRIES } from '../pose/embedding-cache.js';

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('  ✗ ' + m); } };

// ---- cropKeyHash
const geo = () => ({ cx: 312.25, cy: 140.5, angle: 0.7312, scale: 1.8, L: 68.4,
                     hull: [[290, 120], [340, 125], [338, 160], [292, 158]], pts: new Float64Array([1, 2, 3, 4]) });
const others = () => [[[400, 200], [420, 210], [410, 230]], [[100, 100], [120, 100], [110, 130]]];
const base = cropKeyHash(geo(), others());
ok(/^[0-9a-f]{16}$/.test(base), `a 64-bit hex key (${base})`);
ok(cropKeyHash(geo(), others()) === base, 'the same inputs give the same key');
const bump = (x) => { const f = new Float64Array([x]), u = new Uint32Array(f.buffer); u[0] ^= 1; return f[0]; };   // the next double over
for (const k of ['cx', 'cy', 'angle', 'scale', 'L']) {
    const g = geo(); g[k] = bump(g[k]);
    ok(cropKeyHash(g, others()) !== base, `one bit of ${k} changes the key`);
}
{ const g = geo(); g.hull[2][1] = bump(g.hull[2][1]); ok(cropKeyHash(g, others()) !== base, 'one bit of one hull corner changes the key'); }
{ const g = geo(); g.hull.push([300, 165]); ok(cropKeyHash(g, others()) !== base, 'an extra hull corner changes the key'); }
{ const o = others(); o[1][0][0] = bump(o[1][0][0]); ok(cropKeyHash(geo(), o) !== base, 'one bit of a masked hull changes the key'); }
ok(cropKeyHash(geo(), others().slice(0, 1)) !== base, 'one masked hull fewer changes the key');
ok(cropKeyHash(geo(), []) !== cropKeyHash(geo(), [[]]), 'no masked hull and an empty one differ');
{ // moving a point from one hull to the next must not collide (lengths are hashed)
    const a = { ...geo(), hull: [[1, 2], [3, 4], [5, 6]] }, b = { ...geo(), hull: [[1, 2], [3, 4]] };
    ok(cropKeyHash(a, [[[7, 8]]]) !== cropKeyHash(b, [[[5, 6], [7, 8]]]), 'hull boundaries are part of the key');
}
{ const g = geo(); g.pts = new Float64Array([9, 9, 9, 9]); ok(cropKeyHash(g, others()) === base, 'the overlay keypoints (not used by the crop) do not change the key'); }
{ // no collisions over many nearby geometries
    const seen = new Set();
    for (let i = 0; i < 20000; i++) { const g = geo(); g.cx += i * 1e-9; seen.add(cropKeyHash(g, others())); }
    ok(seen.size === 20000, `20,000 geometries a nanopixel apart: ${seen.size.toLocaleString('en-US')} distinct keys`);
}

// ---- hullsReachingCrop: which masked hulls can change the crop's pixels (cutCrop's transform)
{
    const S = 160;
    // crop centred at (500, 300), nose pointing up (angle -pi/2), 4 crop px per source px: the square spans ±20 source px
    const g = { cx: 500, cy: 300, angle: -Math.PI / 2, scale: 4 };
    const sq = (x, y, r) => [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];
    const inside = sq(505, 302, 3), far = sq(900, 900, 5), straddle = sq(521, 300, 2), justOut = sq(526, 300, 2);
    const spanning = [[400, 200], [600, 200], [600, 400], [400, 400]];   // every corner outside, the crop inside it
    const got = hullsReachingCrop(g, [far, inside, straddle, justOut, spanning, [[500, 300], [501, 301]]], S);
    ok(got.length === 3 && got[0] === inside && got[1] === straddle && got[2] === spanning,
       `kept: the hull inside, the one across the edge and one that encloses the crop; dropped: a far one, one ${MASK_REACH_MARGIN}+ px outside, a 2-corner one (got ${got.length})`);
    const ahead = sq(500, 270, 2);   // 30 source px above the centre: crop x 200 with the nose up, crop y -40 with angle 0
    ok(hullsReachingCrop(g, [ahead], S).length === 0 && hullsReachingCrop({ ...g, angle: 0 }, [ahead], S).length === 0,
       'a hull beyond the crop is dropped at either rotation');
    const corner = sq(518, 318, 1);  // near the square's corner at angle 0, but 25 px out along the diagonal axis at 45°
    ok(hullsReachingCrop({ ...g, angle: 0 }, [corner], S).length === 1 && hullsReachingCrop({ ...g, angle: Math.PI / 4 }, [corner], S).length === 0,
       'the rotation decides what reaches the crop (cutCrop\'s transform)');
    ok(cropKeyHash({ ...geo(), ...g }, hullsReachingCrop(g, [inside, far], S)) === cropKeyHash({ ...geo(), ...g }, hullsReachingCrop(g, [inside, sq(950, 120, 5)], S)),
       'so a far neighbour moving does not change the key');
    ok(cropKeyHash({ ...geo(), ...g }, hullsReachingCrop(g, [inside, far], S)) !== cropKeyHash({ ...geo(), ...g }, hullsReachingCrop(g, [sq(506, 302, 3), far], S)),
       '…and a near one does');
    ok(hullsReachingCrop(g, [[[NaN, 0], [1, 1], [2, 0]]], S).length === 1, 'a NaN corner counts as reaching (the key stays exact)');
}

// ---- EmbeddingCache
const vec = (seed, dim = 8) => Float32Array.from({ length: dim }, (v, i) => seed * 100 + i + 0.25);
{
    const c = new EmbeddingCache({ maxEntries: 3, chunk: 2 });
    ok(c.get('a') === null && c.size === 0 && c.bytes === 0, 'empty: a miss, no memory');
    c.put('a', vec(1)); c.put('b', vec(2));
    const a = c.get('a');
    ok(a && a.every((v, i) => v === vec(1)[i]), 'a hit returns the stored values');
    a[0] = -1;
    ok(c.get('a')[0] === vec(1)[0], 'get returns a copy: changing it does not change the cache');
    const src = vec(5); c.put('e', src); src[0] = -7;
    ok(c.get('e')[0] === vec(5)[0], 'put stores a copy');
    // a, b, e stored; a and e touched since b -> b is the least recently used
    c.put('f', vec(6));
    ok(c.size === 3 && !c.has('b') && c.has('a') && c.has('e') && c.has('f'), 'full: the least recently used entry is evicted');
    ok(c.get('f').every((v, i) => v === vec(6)[i]) && c.get('a').every((v, i) => v === vec(1)[i]), '…and its recycled slot holds only the new values');
    ok(c.chunks.length === 2 && c.bytes === 2 * 2 * 8 * 4, `pooled in ${c.chunks.length} chunks of 2 slots (${c.bytes} bytes), not one array per vector`);
    c.put('a', vec(9));
    ok(c.size === 3 && c.get('a')[0] === vec(9)[0], 'put over an existing key replaces it in place');
    ok(c.deleteWhere(k => k === 'a' || k === 'e') === 2 && c.size === 1 && c.has('f'), 'deleteWhere removes the matching keys');
    c.put('g', vec(7)); c.put('h', vec(8));
    ok(c.size === 3 && c.get('g')[3] === vec(7)[3] && c.get('h')[3] === vec(8)[3] && c.chunks.length === 2, 'freed slots are reused before the pool grows');
    c.deleteWhere(() => true);
    ok(c.size === 0 && c.bytes === 0, 'deleting everything releases the pool');
    c.put('x', vec(1, 4));
    ok(c.dim === 4 && c.get('x').length === 4, 'a cleared cache takes another vector length');
    c.put('y', vec(2, 6));
    ok(c.size === 1 && c.dim === 6 && !c.has('x'), 'a vector of another length starts the cache over (another model)');
    c.clear();
    ok(c.size === 0 && c.bytes === 0 && c.get('y') === null, 'clear empties it');
}
{
    const c = new EmbeddingCache();
    ok(c.maxEntries === EMBED_CACHE_MAX_ENTRIES && EMBED_CACHE_MAX_ENTRIES * 384 * 4 <= 100 * 1048576, `default bound: ${EMBED_CACHE_MAX_ENTRIES.toLocaleString('en-US')} vectors (${(EMBED_CACHE_MAX_ENTRIES * 384 * 4 / 1048576).toFixed(0)} MB at 384 floats)`);
    const n = 30000, t0 = performance.now();
    for (let i = 0; i < n; i++) c.put('k' + i, vec(i % 97, 384));
    let good = 0; for (let i = 0; i < n; i++) { const v = c.get('k' + i); if (v && v[5] === vec(i % 97, 384)[5]) good++; }
    ok(good === n, `30,000 vectors of 384 stored and read back (${good.toLocaleString('en-US')}, ${(performance.now() - t0).toFixed(0)} ms)`);
}

console.log(`test-embedding-cache: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
