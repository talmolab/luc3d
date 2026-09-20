/**
 * Measure the REAL per-object heap cost of the candidate representations in a
 * pointer-compressed Chrome renderer (the actual constrained resource).
 *
 * Not a test — a sizing experiment for the luc3d #189 follow-up.
 */
import { chromium } from 'playwright';

const N_NODES = 15;
const N = 200000; // enough to swamp fixed overhead

const page = await (await chromium.launch({
    args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
})).newPage();

await page.goto('about:blank');

const result = await page.evaluate(async ({ N_NODES, N }) => {
    const gc = () => { for (let i = 0; i < 4; i++) window.gc && window.gc(); };
    const used = () => performance.memory.usedJSHeapSize;

    async function measure(name, build) {
        gc(); await new Promise(r => setTimeout(r, 50)); gc();
        const before = used();
        const keep = build();
        gc(); await new Promise(r => setTimeout(r, 50)); gc();
        const after = used();
        const bytes = after - before;
        // touch keep so it cannot be optimized away
        if (keep.length === -1) console.log('never');
        return { name, totalMB: +(bytes / 1048576).toFixed(1), perObj: Math.round(bytes / N) };
    }

    const out = [];

    // ---- current: Instance with boxed points + boxed occluded ----
    out.push(await measure('Instance: boxed points[][] + occluded[]', () => {
        const a = new Array(N);
        for (let i = 0; i < N; i++) {
            const pts = new Array(N_NODES);
            for (let n = 0; n < N_NODES; n++) pts[n] = [n + 0.5, n + 1.5];
            a[i] = { points: pts, trackIdx: i & 31, type: 'predicted', score: 0.9,
                     modified: false, _originalPoints: null,
                     occluded: new Array(N_NODES).fill(false) };
        }
        return a;
    }));

    // ---- per-instance typed arrays ----
    out.push(await measure('Instance: Float32Array(2N) + Uint8Array(N)', () => {
        const a = new Array(N);
        for (let i = 0; i < N; i++) {
            const xy = new Float32Array(N_NODES * 2);
            for (let n = 0; n < N_NODES; n++) { xy[2 * n] = n + 0.5; xy[2 * n + 1] = n + 1.5; }
            a[i] = { _xy: xy, trackIdx: i & 31, type: 'predicted', score: 0.9,
                     modified: false, _originalPoints: null,
                     _occ: new Uint8Array(N_NODES) };
        }
        return a;
    }));

    // ---- per-instance typed coords + occlusion as a bitmask int ----
    out.push(await measure('Instance: Float32Array(2N) + int bitmask', () => {
        const a = new Array(N);
        for (let i = 0; i < N; i++) {
            const xy = new Float32Array(N_NODES * 2);
            for (let n = 0; n < N_NODES; n++) { xy[2 * n] = n + 0.5; xy[2 * n + 1] = n + 1.5; }
            a[i] = { _xy: xy, trackIdx: i & 31, type: 'predicted', score: 0.9,
                     modified: false, _originalPoints: null, _occ: 0 };
        }
        return a;
    }));

    // ---- pooled arena: one big Float32Array, instance holds a base offset ----
    out.push(await measure('Instance: pooled arena + base offset', () => {
        const pool = new Float32Array(N * N_NODES * 2);
        const occPool = new Uint32Array(N); // 15 nodes -> 1 word of occlusion bits
        const a = new Array(N);
        for (let i = 0; i < N; i++) {
            const base = i * N_NODES * 2;
            for (let n = 0; n < N_NODES; n++) { pool[base + 2 * n] = n + 0.5; pool[base + 2 * n + 1] = n + 1.5; }
            a[i] = { _pool: pool, _occPool: occPool, _base: base, _slot: i,
                     trackIdx: i & 31, type: 'predicted', score: 0.9,
                     modified: false, _originalPoints: null };
        }
        a.push(pool, occPool);
        return a;
    }));

    // ---- points3d: boxed vs Float64Array vs Float32Array ----
    out.push(await measure('points3d: boxed [x,y,z][]', () => {
        const a = new Array(N);
        for (let i = 0; i < N; i++) {
            const p = new Array(N_NODES);
            for (let n = 0; n < N_NODES; n++) p[n] = [n + 0.5, n + 1.5, n + 2.5];
            a[i] = p;
        }
        return a;
    }));

    out.push(await measure('points3d: Float64Array(3N)', () => {
        const a = new Array(N);
        for (let i = 0; i < N; i++) {
            const p = new Float64Array(N_NODES * 3);
            for (let n = 0; n < N_NODES * 3; n++) p[n] = n + 0.5;
            a[i] = p;
        }
        return a;
    }));

    out.push(await measure('points3d: pooled Float64Array arena', () => {
        const pool = new Float64Array(N * N_NODES * 3);
        const a = new Array(N);
        for (let i = 0; i < N; i++) { a[i] = i * N_NODES * 3; }
        a.push(pool);
        return a;
    }));

    return { out, heapLimit: +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(0) };
}, { N_NODES, N });

console.log(`\nChrome jsHeapSizeLimit: ${result.heapLimit} MB`);
console.log(`Measured with N=${N.toLocaleString()} objects, ${N_NODES} nodes each\n`);
console.log('representation'.padEnd(46), 'B/obj'.padStart(7), 'MB@200k'.padStart(9), 'MB@2.63M'.padStart(10));
console.log('-'.repeat(76));
for (const r of result.out) {
    const scaled = (r.perObj * 2627453 / 1048576).toFixed(0);
    console.log(r.name.padEnd(46), String(r.perObj).padStart(7), String(r.totalMB).padStart(9), String(scaled).padStart(10));
}
process.exit(0);
