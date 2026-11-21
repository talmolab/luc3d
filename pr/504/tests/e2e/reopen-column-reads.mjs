/**
 * reopen-column-reads.mjs — guards the LUCID local patch (column reads) in the
 * vendored sleap-io.js reader (`lib/sleap-io/chunk-X76PRJK6.js`).
 *
 * A big table LUCID writes is stored in chunks of ONE column (65,536 x 1, the
 * column chunks patch). The streaming reader reads such a table a column at a
 * time in its worker (`lucidReadColumn`), narrows each column there and hands it
 * over, instead of reading whole rows and transposing them on the page; a project
 * reopen also spreads the columns over a few workers (`lucidReadWorkers`, set by
 * `SioLazyLoader.openProjectSlp`). On 05mice (8 cameras) the reopen went from
 * ~14.5 s to ~2.9 s.
 *
 * Asserts, on a file whose four tables are column-chunked (>65,536 pred_points
 * rows), that every way of reading it gives EXACTLY the store the row read gives
 * (`__lucidColumnReads = false`): same columns, same typed-array types, every
 * value `Object.is`-equal:
 *   - one read per column (no progress, no pool)
 *   - counted pieces (`onReadBytes`, small `__lucidReadSliceElems`), including a
 *     column whose first pieces fit Float32Array and a later one does not
 *     (instance `score` 0.1), which must widen to Float64Array
 *   - several workers (`lucidReadWorkers`), and LUCID's own `openProjectSlp`
 *   - a column read that fails part-way: the reader falls back to rows, and the
 *     byte count still ends exactly at the total
 * and that a small (contiguous) table, like an older file's, never takes it.
 *
 * Run: node tests/e2e/reopen-column-reads.mjs
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
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`${server.url}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.SleapIO && window.h5wasm, null, { timeout: 60000 });

    // ---- fixtures: one camera, written by the app's own writer ----
    const info = await page.evaluate(async () => {
        const pd = await import('./pose/pose-data.js');
        const fileio = await import('./import-export/file-io.js');
        const NODES = ['a', 'b', 'c', 'd'];
        const make = async (FRAMES) => {
            const cam = new pd.Camera('cam', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            const s = new pd.Session([cam], new pd.Skeleton('sk', NODES, [[0, 1]]), ['t0', 't1'], 'fixture');
            const val = (k) => Math.sin(k * 12.9898) * 300.123457 + 320;
            for (let f = 0; f < FRAMES; f++) {
                const fg = new pd.FrameGroup(f);
                const pts = NODES.map((_, i) => (f % 7 === 3 && i === 2) ? [NaN, NaN] : [val(f * 4 + i), val(f * 4 + i + 0.5)]);
                // Instance scores fit f32 (0.5) except one late in the table (0.1):
                // read in pieces, that column must widen to Float64Array.
                const pred = new pd.Instance(pts, f % 2, 'predicted', f === FRAMES - 1000 ? 0.1 : 0.5);
                pred.setPointScores(NODES.map((_, i) => Math.abs(Math.sin(f + i)) * 0.99));
                fg.addInstance('cam', pred);
                if (f % 2 === 0) fg.addInstance('cam', new pd.Instance(NODES.map((_, i) => [val(f + i + 0.25), val(f + i + 0.75)]), (f + 1) % 2, 'user', null));
                s.addFrameGroup(fg);
            }
            const labels = fileio.buildSlpLabels(s, 'cam', false, { videoWidth: 640, videoHeight: 480, frameCount: FRAMES, videoPath: 'cam.mp4' });
            return new Uint8Array(await window.SleapIO.saveSlpToBytes(labels));
        };
        const big = await make(17000), small = await make(500);
        window.__big = new File([big], 'big.slp');
        window.__small = new File([small], 'small.slp');
        // The tables' layout, read with h5wasm.
        const h5 = window.h5wasm;
        h5.FS.writeFile('/__big.slp', big);
        const f = new h5.File('/__big.slp', 'r');
        const layout = {};
        for (const n of ['frames', 'instances', 'points', 'pred_points']) {
            const d = f.get(n);
            layout[n] = { shape: d.shape, chunks: d.metadata.chunks };
        }
        f.close();
        h5.FS.unlink('/__big.slp');
        // Count the column reads each worker is sent; `__corrupt` breaks the Nth one.
        const orig = Worker.prototype.postMessage;
        window.__colMsgs = [];
        window.__wseq = 0;
        Worker.prototype.postMessage = function (m, t) {
            if (m && m.type === 'lucidReadColumn') {
                if (!this.__wid) this.__wid = ++window.__wseq;
                window.__colMsgs.push(this.__wid);
                if (window.__corrupt && window.__colMsgs.length === window.__corrupt) m = { ...m, payload: { ...m.payload, path: 'no_such_table' } };
            }
            return orig.call(this, m, t);
        };
        return { layout, big: big.length, small: small.length };
    });
    console.log(`  fixture: ${info.big.toLocaleString()} bytes; ${JSON.stringify(info.layout)}`);
    check(info.layout.pred_points.shape[0] > 65536 &&
        Object.values(info.layout).every(t => JSON.stringify(t.chunks) === '[65536,1]'),
        'the fixture\'s four tables are stored in one-column chunks, pred_points over one chunk', info.layout);

    // ---- every read mode gives the row read's store ----
    const res = await page.evaluate(async () => {
        const h5wasmUrl = new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href;
        const TABLES = ['framesData', 'instancesData', 'pointsData', 'predPointsData'];
        const read = async (file, { rows = false, slice, pool, workers, corrupt } = {}) => {
            globalThis.__lucidColumnReads = rows ? false : undefined;
            globalThis.__lucidReadSliceElems = slice;
            globalThis.__lucidPoolTableBytes = pool;
            window.__colMsgs = [];
            window.__corrupt = corrupt;
            const counts = [];
            const warns = [];
            const ow = console.warn;
            console.warn = (...a) => { warns.push(String(a[0])); };
            try {
                const labels = await window.SleapIO.readSlpStreaming(file, {
                    lazy: true, openVideos: false, h5wasmUrl,
                    onReadBytes: slice ? (d, t) => { counts.push([d, t]); } : undefined,
                    lucidReadWorkers: workers,
                });
                return { st: labels._lazyDataStore, msgs: window.__colMsgs.slice(), counts, warns };
            } finally {
                console.warn = ow;
                globalThis.__lucidColumnReads = globalThis.__lucidReadSliceElems = globalThis.__lucidPoolTableBytes = undefined;
                window.__corrupt = undefined;
            }
        };
        const compare = (A, B) => {
            let cols = 0, values = 0;
            const diffs = [];
            for (const t of TABLES) {
                const a = A[t] || {}, b = B[t] || {};
                const ka = Object.keys(a), kb = Object.keys(b);
                if (ka.join() !== kb.join()) diffs.push(t + ' columns ' + ka.join() + ' vs ' + kb.join());
                for (const k of ka) {
                    cols++;
                    const x = a[k], y = b[k];
                    if (!y || x.length !== y.length || x.constructor !== y.constructor) {
                        diffs.push(`${t}.${k} ${x.constructor.name}[${x.length}] vs ${y && y.constructor.name}[${y && y.length}]`);
                        continue;
                    }
                    for (let i = 0; i < x.length; i++) {
                        values++;
                        if (!Object.is(x[i], y[i])) { diffs.push(`${t}.${k}[${i}] ${x[i]} vs ${y[i]}`); break; }
                    }
                }
            }
            return { cols, values, diffs: diffs.slice(0, 6) };
        };
        const countsOk = (c) => c.length > 10 && c[0][0] === 0 && c[c.length - 1][0] === c[c.length - 1][1] &&
            c.every((x, i) => x[0] <= x[1] && (i === 0 || x[0] >= c[i - 1][0]));
        const workersOf = (m) => new Set(m).size;

        const ref = await read(window.__big, { rows: true });
        const types = {
            x: ref.st.predPointsData.x.constructor.name,
            visible: ref.st.predPointsData.visible.constructor.name,
            score: ref.st.instancesData.score.constructor.name,
            pid: ref.st.instancesData.point_id_start.constructor.name,
        };
        const whole = await read(window.__big);
        const pieces = await read(window.__big, { slice: 5000 });
        const pool = await read(window.__big, { slice: 5000, pool: 1, workers: 3 });
        const failed = await read(window.__big, { slice: 5000, pool: 1, workers: 3, corrupt: 7 });
        // LUCID's own project reopen asks for the pool.
        globalThis.__lucidPoolTableBytes = 1;
        window.__colMsgs = [];
        const SioLazyLoader = (await import('./loading/sio-lazy-loader.js')).SioLazyLoader;
        const o = await new SioLazyLoader().openProjectSlp(window.__big, null, undefined);
        globalThis.__lucidPoolTableBytes = undefined;
        const lucid = { st: o.labels._lazyDataStore, msgs: window.__colMsgs.slice() };
        const smallRows = await read(window.__small, { rows: true });
        const smallDefault = await read(window.__small, { slice: 50, pool: 1, workers: 3 });
        return {
            types,
            refMsgs: ref.msgs.length,
            whole: { ...compare(ref.st, whole.st), msgs: whole.msgs.length, workers: workersOf(whole.msgs) },
            pieces: { ...compare(ref.st, pieces.st), msgs: pieces.msgs.length, workers: workersOf(pieces.msgs), countsOk: countsOk(pieces.counts), n: pieces.counts.length },
            pool: { ...compare(ref.st, pool.st), workers: workersOf(pool.msgs), countsOk: countsOk(pool.counts), n: pool.counts.length },
            failed: { ...compare(ref.st, failed.st), warns: failed.warns, countsOk: countsOk(failed.counts), last: failed.counts[failed.counts.length - 1] },
            lucid: { ...compare(ref.st, lucid.st), workers: workersOf(lucid.msgs) },
            cores: navigator.hardwareConcurrency,
            small: { ...compare(smallRows.st, smallDefault.st), msgs: smallDefault.msgs.length },
        };
    });
    const ok = (r) => r.cols >= 20 && r.values > 500000 && r.diffs.length === 0;
    check(res.types.x === 'Float32Array' && res.types.visible === 'Uint8Array' && res.types.score === 'Float64Array' && res.types.pid === 'Uint32Array' && res.refMsgs === 0,
        'the row read (reference) narrows as before and sends no column reads', res.types);
    check(ok(res.whole) && res.whole.msgs >= 20 && res.whole.workers === 1,
        `one read per column gives the row read's store (${res.whole.cols} columns, ${res.whole.values.toLocaleString()} values, ${res.whole.msgs} column reads)`, res.whole);
    check(ok(res.pieces) && res.pieces.msgs > res.whole.msgs && res.pieces.countsOk,
        `counted pieces give the same store (instance score widens to Float64Array) and count 0 → total over ${res.pieces.n} steps`, res.pieces);
    check(ok(res.pool) && res.pool.workers === 3 && res.pool.countsOk,
        `three workers give the same store and the same count`, res.pool);
    check(ok(res.failed) && res.failed.warns.some(w => /column read of .* failed, reading rows instead/.test(w)) && res.failed.countsOk,
        'a column read that fails falls back to the row read: same store, count ends at the total', res.failed);
    const lucidWorkers = Math.max(1, Math.min(5, (res.cores || 2) - 1));
    check(ok(res.lucid) && res.lucid.workers === lucidWorkers,
        `SioLazyLoader.openProjectSlp reads on ${lucidWorkers} worker(s) and gives the same store`, res.lucid);
    check(res.small.diffs.length === 0 && res.small.msgs === 0,
        'a small (contiguous) table keeps the row read', res.small);
} finally {
    if (browser) await browser.close();
    server.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
