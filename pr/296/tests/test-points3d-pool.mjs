/**
 * test-points3d-pool.mjs — `pooledPoints3d` (pose/pose-data.js), the slab pool
 * the bulk paths (Triangulate All, Track All, reopen, origin re-base) store
 * `InstanceGroup.points3d` in, so a project's 539,545 groups share ~185
 * ArrayBuffers instead of owning one each (every full GC sweeps every
 * ArrayBuffer).
 *
 * The contract a pooled array has to keep is "behaves like an owned
 * Float64Array of exactly its 3N doubles": values, length, in-place writes that
 * stay inside its own region, copies that copy only it. Pinned here, plus the
 * pool's own bookkeeping.
 *
 * Run:  node tests/test-points3d-pool.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const { pooledPoints3d, isPooledPoints3d, makePoints3d } =
    await import(pathToFileURL(path.join(ROOT, 'pose', 'pose-data.js')).href);

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
    if (cond) passed++;
    else { failed++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function group(name) { console.log('\n• ' + name); }
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

group('a pooled array is exactly its own 3N doubles');
{
    const src = Float64Array.from({ length: 45 }, (_, i) => i * 1.5 + (i % 7 === 0 ? NaN : 0));
    const p = pooledPoints3d(src);
    ok(p instanceof Float64Array && p.length === 45, 'Float64Array of the same length');
    ok(same(Array.from(p), Array.from(src)), 'same values, NaN included (bit-exact)');
    ok(p !== src && isPooledPoints3d(p) && !isPooledPoints3d(src), 'a copy, in the pool');
    ok(p.buffer.byteLength > p.byteLength, 'a view into a larger slab');
    const was = p[1];
    src[1] = 999;
    ok(p[1] === was && was === 1.5, 'independent of the source after the copy');
}

group('neighbours in one slab never see each other');
{
    const a = pooledPoints3d(new Float64Array(45).fill(1));
    const b = pooledPoints3d(new Float64Array(45).fill(2));
    ok(a.buffer === b.buffer, 'fixture: consecutive groups share a slab');
    a.fill(7); a[44] = 8;
    ok(b.every(v => v === 2), "writing all of one leaves its neighbour untouched");
    const c = a.slice();
    ok(c.buffer.byteLength === 45 * 8 && same(Array.from(c), Array.from(a)), 'slice() copies only the view');
    const d = new Float64Array(b);
    ok(d.buffer.byteLength === 45 * 8 && d.every(v => v === 2), 'new Float64Array(view) copies only the view');
    ok(ArrayBuffer.isView(a) && a.length / 3 === 15, 'isView / length as the save writer reads them');
}

group('many groups, few buffers');
{
    const bufs = new Set();
    for (let i = 0; i < 20000; i++) bufs.add(pooledPoints3d(new Float64Array(45).fill(i)).buffer);
    ok(bufs.size <= 8, `20,000 groups of 15 nodes share ${bufs.size} buffers (1 MB slabs)`);
}

group('pass-throughs');
{
    ok(pooledPoints3d(null) === null && pooledPoints3d(undefined) == null, 'null/undefined pass through');
    const empty = new Float64Array(0);
    ok(pooledPoints3d(empty) === empty, 'an empty array passes through');
    const p = pooledPoints3d(new Float64Array(9).fill(3));
    ok(pooledPoints3d(p) === p, 'an already-pooled array is returned unchanged (no second copy)');
    const boxed = pooledPoints3d([[1, 2, 3], null, [4, 5, 6]]);
    ok(isPooledPoints3d(boxed) && boxed.length === 9 && boxed[3] !== boxed[3] && boxed[6] === 4,
        'boxed rows are normalized (asPoints3d) and pooled');
    const big = new Float64Array(3 * 5000);
    ok(pooledPoints3d(big) === big, 'larger than a slab share -> keeps its own buffer');
    const made = makePoints3d ? makePoints3d(15) : null;
    if (made) ok(isPooledPoints3d(pooledPoints3d(made)), 'makePoints3d output pools');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
