/**
 * reopen-row-blocks-pool.mjs — a project saved before the column chunks (its
 * big tables in chunks of whole rows, or contiguous) is read in row blocks on
 * the reader's worker pool, side by side (LUCID local patch, column reads:
 * `lucidReadRowsPooled`). On the 8-camera HardFight project the tables went
 * from ~2.1 to ~0.8 s.
 *
 * The fixture is saved by today's writer, then copied with h5wasm into an
 * older layout: `frames`/`instances`/`points`/`pred_points` in gzip chunks of
 * 100 whole rows. Asserts:
 *   - the copy has that layout (so the column read stands aside);
 *   - read with a pool (`lucidReadWorkers: 3`, `__lucidPoolTableBytes = 1`,
 *     small blocks) the store equals the one-worker read: every column, type
 *     for type, value for value; the blocks went to all three workers, each
 *     split into narrowed columns there (`lucidReadRowColumns`; the instance
 *     score column widens to Float64Array when a later block does not fit);
 *     and the byte count goes from 0 to the total without going back;
 *   - a block that fails falls back to the one-worker read: same store, count
 *     still ends at the total;
 *   - a contiguous table (no chunks) is read in blocks too, and gives the same.
 *
 * Run: node tests/e2e/reopen-row-blocks-pool.mjs
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const server = await startServer(repoRoot);

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 800)));
    if (!c) fails++;
};

let browser;
try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.setDefaultTimeout(300000);
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    await page.goto(`${server.url}/index.html`);
    await page.waitForFunction(() => window.SleapIO && window.h5wasm && window.__lucid, null, { timeout: 120000 });

    const res = await page.evaluate(async () => {
        const S = window.SleapIO, h5 = window.h5wasm;
        const FRAMES = 3000, NODES = 4;
        const nodes = Array.from({ length: NODES }, (_, j) => new S.Node('n' + j));
        const skeleton = new S.Skeleton({ nodes, edges: [new S.Edge(nodes[0], nodes[1])], name: 'sk' });
        const tracks = [new S.Track('a'), new S.Track('b')];
        const video = new S.Video({ filename: 'cam.mp4', backendMetadata: { type: 'MediaVideo', shape: [FRAMES, 480, 640, 1], filename: 'cam.mp4' }, openBackend: false });
        video.shape = [FRAMES, 480, 640, 1];
        const val = (k) => Math.sin(k * 12.9898) * 300.123457 + 320;
        const lfs = [];
        for (let f = 0; f < FRAMES; f++) {
            const insts = [];
            for (let d = 0; d < 2; d++) {
                const points = Array.from({ length: NODES }, (_, j) => ({
                    xy: (f % 11 === 3 && j === 1) ? [NaN, NaN] : [val(f * 8 + d * 4 + j), val(f * 8 + d * 4 + j + 0.5)],
                    visible: !(f % 11 === 3 && j === 1), complete: true, score: Math.abs(Math.sin(f + j)) * 0.99,
                }));
                insts.push(new S.PredictedInstance({ points, skeleton, track: f % 13 === 0 ? null : tracks[d], score: (d && f > 2500) ? 0.1 : 0.5 }));
            }
            if (f % 4 === 0) insts.push(new S.Instance({ points: Array.from({ length: NODES }, (_, j) => ({ xy: [val(f + j), val(f + j + 0.25)], visible: true, complete: true })), skeleton, track: tracks[0] }));
            lfs.push(new S.LabeledFrame({ video, frameIdx: f, instances: insts }));
        }
        const bytes = new Uint8Array(await S.saveSlpToBytes(new S.Labels({ labeledFrames: lfs, videos: [video], skeletons: [skeleton], tracks, provenance: {} })));

        // Copy into the older layout: the four tables in gzip chunks of 100 whole rows
        // (or contiguous with `chunkRows` null); everything else as it is.
        const TABLES = ['frames', 'instances', 'points', 'pred_points'];
        const copyAttrs = (from, to) => {
            for (const [k, a] of Object.entries(from.attrs)) to.create_attribute(k, a.value, a.shape, a.dtype);
        };
        const oldLayout = (chunkRows, name) => {
            h5.FS.writeFile('/__src.slp', bytes);
            const src = new h5.File('/__src.slp', 'r'), dst = new h5.File('/__old.slp', 'w');
            const layout = {};
            for (const k of src.keys()) {
                const o = src.get(k);
                if (o instanceof h5.Group) {
                    const g = dst.create_group(k);
                    copyAttrs(o, g);
                    if (o.keys().length) throw new Error('nested group ' + k);
                    continue;
                }
                const table = TABLES.includes(k) && o.shape[0] > 0;
                const chunks = table && chunkRows ? [Math.min(chunkRows, o.shape[0]), o.shape[1]] : undefined;
                dst.create_dataset({ name: k, data: o.value, shape: o.shape, dtype: o.dtype, chunks, compression: chunks ? 1 : undefined });
                copyAttrs(o, dst.get(k));
                if (TABLES.includes(k)) layout[k] = { shape: o.shape, chunks: dst.get(k).metadata.chunks };
            }
            copyAttrs(src, dst);
            src.close(); dst.close();
            const out = h5.FS.readFile('/__old.slp');
            h5.FS.unlink('/__src.slp'); h5.FS.unlink('/__old.slp');
            return { file: new File([out], name), layout };
        };
        const chunked = oldLayout(100, 'old-chunked.slp');
        const contiguous = oldLayout(null, 'old-contiguous.slp');

        const orig = Worker.prototype.postMessage;
        let wseq = 0, msgs = [], corrupt = 0;
        Worker.prototype.postMessage = function (m, t) {
            if (m && m.payload && TABLES.includes(m.payload.path) && (m.type === 'getDatasetValue' || m.type === 'lucidReadColumn' || m.type === 'lucidReadRowColumns')) {
                if (!this.__wid) this.__wid = ++wseq;
                msgs.push([this.__wid, m.type]);
                if (corrupt && msgs.length === corrupt) m = { ...m, payload: { ...m.payload, path: 'no_such_table' } };
            }
            return orig.call(this, m, t);
        };
        const h5wasmUrl = new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href;
        const read = async (file, { workers, fail } = {}) => {
            msgs = [];
            corrupt = fail || 0;
            const counts = [], warns = [];
            const ow = console.warn;
            console.warn = (...a) => warns.push(String(a[0]));
            if (workers) { globalThis.__lucidPoolTableBytes = 1; globalThis.__lucidReadSliceElems = 1000; }
            try {
                const labels = await S.readSlpStreaming(file, { lazy: true, openVideos: false, h5wasmUrl, lucidReadWorkers: workers, onReadBytes: (d, t) => { counts.push([d, t]); } });
                return { st: labels._lazyDataStore, msgs: msgs.slice(), counts, warns };
            } finally {
                console.warn = ow;
                globalThis.__lucidPoolTableBytes = globalThis.__lucidReadSliceElems = undefined;
                corrupt = 0;
            }
        };
        const compare = (A, B) => {
            let cols = 0, values = 0;
            const diffs = [];
            for (const t of ['framesData', 'instancesData', 'pointsData', 'predPointsData']) {
                const a = A[t] || {}, b = B[t] || {};
                if (Object.keys(a).join() !== Object.keys(b).join()) diffs.push(t + ' columns');
                for (const k of Object.keys(a)) {
                    cols++;
                    const x = a[k], y = b[k];
                    if (!y || x.length !== y.length || x.constructor !== y.constructor) { diffs.push(`${t}.${k} type/length`); continue; }
                    for (let i = 0; i < x.length; i++) { values++; if (!Object.is(x[i], y[i])) { diffs.push(`${t}.${k}[${i}] ${x[i]} vs ${y[i]}`); break; } }
                }
            }
            return { cols, values, diffs: diffs.slice(0, 5) };
        };
        const countsOk = (c) => c.length > 10 && c[0][0] === 0 && c[c.length - 1][0] === c[c.length - 1][1] &&
            c.every((x, i) => x[0] <= x[1] && (i === 0 || x[0] >= c[i - 1][0]));
        const summary = (r) => ({ workers: new Set(r.msgs.map(m => m[0])).size, columnReads: r.msgs.filter(m => m[1] === 'lucidReadColumn').length, blocks: r.msgs.length, splitBlocks: r.msgs.filter(m => m[1] === 'lucidReadRowColumns').length, countsOk: countsOk(r.counts), steps: r.counts.length });

        const ref = await read(chunked.file);
        const scoreType = ref.st.instancesData.score.constructor.name;
        const pool = await read(chunked.file, { workers: 3 });
        const failed = await read(chunked.file, { workers: 3, fail: 5 });
        const cref = await read(contiguous.file);
        const cpool = await read(contiguous.file, { workers: 3 });
        Worker.prototype.postMessage = orig;
        return {
            layout: chunked.layout, clayout: contiguous.layout, scoreType,
            ref: summary(ref),
            pool: { ...compare(ref.st, pool.st), ...summary(pool) },
            failed: { ...compare(ref.st, failed.st), ...summary(failed), warns: failed.warns },
            contiguous: { ...compare(cref.st, cpool.st), ...summary(cpool) },
        };
    });
    check(Object.values(res.layout).every(t => t.chunks && t.chunks[0] === Math.min(100, t.shape[0]) && t.chunks[1] === t.shape[1]) &&
        Object.values(res.clayout).every(t => !t.chunks),
        'the fixture copies hold the older layouts (100-row chunks; contiguous)', { chunked: res.layout, contiguous: res.clayout });
    check(res.ref.workers === 1 && res.ref.columnReads === 0, 'one worker reads the older tables whole-row, as before', res.ref);
    check(res.scoreType === 'Float64Array', 'the instance score column is Float64Array (its last blocks hold 0.1, which Float32Array cannot): the pool must widen it', res.scoreType);
    const ok = (r) => r.cols >= 20 && r.values > 100000 && r.diffs.length === 0;
    check(ok(res.pool) && res.pool.workers === 3 && res.pool.columnReads === 0 && res.pool.splitBlocks === res.pool.blocks && res.pool.blocks > 10 && res.pool.countsOk,
        `three workers read the row blocks and split them into columns (${res.pool.blocks} blocks): same store, type for type; the count goes 0 → total over ${res.pool.steps} steps`, res.pool);
    check(ok(res.failed) && res.failed.warns.some(w => /pooled row read of .* failed, reading on one worker instead/.test(w)) && res.failed.countsOk,
        'a failed block falls back to the one-worker read: same store, count ends at the total', res.failed);
    check(ok(res.contiguous) && res.contiguous.workers === 3 && res.contiguous.splitBlocks > 10 && res.contiguous.countsOk,
        'a contiguous table is read in blocks on the pool too, and gives the same store', res.contiguous);
    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close();
    server.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
