/**
 * f32 vs f64 backing for Instance coords: does keeping full f64 precision
 * (bit-exact vs today, so the golden digest can gate the refactor) cost
 * anything IN THE CAGE, which is the resource that actually runs out?
 *
 * Not a test — a sizing experiment for the luc3d #189 follow-up.
 */
import { chromium } from 'playwright';

const N_NODES = 15, N = 200000;
const page = await (await chromium.launch({
    args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
})).newPage();
await page.goto('about:blank');

const out = await page.evaluate(async ({ N_NODES, N }) => {
    const gc = () => { for (let i = 0; i < 4; i++) window.gc && window.gc(); };
    const used = () => performance.memory.usedJSHeapSize;
    const rows = [];
    async function measure(name, externalPerObj, build) {
        gc(); await new Promise(r => setTimeout(r, 60)); gc();
        const before = used();
        const keep = build();
        gc(); await new Promise(r => setTimeout(r, 60)); gc();
        const total = Math.round((used() - before) / N);
        if (keep.length === -1) console.log('x');
        rows.push({ name, total, external: externalPerObj, cage: total - externalPerObj });
    }

    await measure('boxed points[][] + occluded[]  (TODAY)', 0, () => {
        const a = new Array(N);
        for (let i = 0; i < N; i++) {
            const pts = new Array(N_NODES);
            for (let n = 0; n < N_NODES; n++) pts[n] = [n + 0.5, n + 1.5];
            a[i] = { points: pts, trackIdx: i & 31, type: 'predicted', score: 0.9,
                     modified: false, _originalPoints: null, occluded: new Array(N_NODES).fill(false) };
        }
        return a;
    });

    await measure('Float32Array(2N) + int occ bitmask', N_NODES * 2 * 4, () => {
        const a = new Array(N);
        for (let i = 0; i < N; i++) {
            const xy = new Float32Array(N_NODES * 2);
            for (let n = 0; n < N_NODES * 2; n++) xy[n] = n + 0.5;
            a[i] = { _xy: xy, trackIdx: i & 31, type: 'predicted', score: 0.9,
                     modified: false, _originalPoints: null, _occ: 0 };
        }
        return a;
    });

    await measure('Float64Array(2N) + int occ bitmask', N_NODES * 2 * 8, () => {
        const a = new Array(N);
        for (let i = 0; i < N; i++) {
            const xy = new Float64Array(N_NODES * 2);
            for (let n = 0; n < N_NODES * 2; n++) xy[n] = n + 0.5;
            a[i] = { _xy: xy, trackIdx: i & 31, type: 'predicted', score: 0.9,
                     modified: false, _originalPoints: null, _occ: 0 };
        }
        return a;
    });

    return rows;
}, { N_NODES, N });

const INSTANCES = 2627453;
console.log('\nPer-object, split into cage (the scarce ~4 GB) vs external backing store:\n');
console.log('representation'.padEnd(40), 'total'.padStart(6), 'extern'.padStart(7), 'CAGE'.padStart(6), '| cage MB @2.63M');
console.log('-'.repeat(84));
for (const r of out) {
    console.log(r.name.padEnd(40), String(r.total).padStart(6), String(r.external).padStart(7),
        String(r.cage).padStart(6), '|', (r.cage * INSTANCES / 1048576).toFixed(0).padStart(6), 'MB');
}
process.exit(0);
