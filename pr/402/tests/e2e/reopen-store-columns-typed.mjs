/**
 * reopen-store-columns-typed.mjs — guards the luc3d #193 vendored-bundle patch.
 *
 * WHAT #193 FIXES. A LUCID-written `.slp` stores `frames`/`instances`/`points`/
 * `pred_points` as flat 2D matrices carrying a `field_names` attr. A
 * PYTHON-written `.slp` stores them as HDF5 compound dtypes. Those two shapes take
 * DIFFERENT column builders in the vendored reader, and only the compound one
 * built typed columns:
 *
 *   compound dtype  -> readCompoundColumnsWorker  -> Float64Array columns  (always did)
 *   flat + field_names -> normalizeStructData     -> plain JS Array columns (the bug)
 *
 * So reopening OUR OWN project was the one path that materialized every column as
 * boxed numbers. Measured on the real 180,210-frame x 5-camera project
 * (`_diag-post-reload-bytes.mjs`): 24 columns, 228,108,600 entries, ~1.8 GB living
 * INSIDE V8's pointer-compressed cage — which a Chrome renderer hard-caps near
 * 4 GB. The save cannot free it (pass 2 streams 2D straight out of that store), so
 * the writer opened with no headroom and the renderer died in save phase 2/4.
 * Editing a reopened project and saving again crashed every time; with typed
 * columns the same save completes (1,405 MB in 142 s).
 *
 * WHAT THIS ASSERTS. Build a small project, save it through the real writer,
 * reopen it through the real `SioLazyLoader.openProjectSlp`, then require that
 * every store column is an ArrayBuffer VIEW and not a plain Array — plus that the
 * values still read back exactly. A plain-array regression here is invisible at
 * small scale (everything still works, just in the wrong memory space), which is
 * exactly why it needs a test rather than a benchmark: it would only resurface as
 * an OOM on a multi-hundred-MB project.
 *
 * NARROW COLUMNS (LUCID local patch (narrow columns)). The columns are not all
 * Float64Array any more: each is the narrowest typed array that holds every value
 * exactly (`LUCID_NARROW_COLUMNS` / `lucidNarrowKindW`): x/y/score Float32Array,
 * visible/complete/instance_type/skeleton Uint8Array, point_id_start/end
 * Uint32Array; the columns LUCID writes into a loaded store (track,
 * from_predicted, every frames column) and instance_id/frame_id stay
 * Float64Array. Asserted here on both builders: the LUCID-written flat matrices
 * (`normalizeStructData`) and a Python-written compound file
 * (`tests/fixtures/slp-compound/sleap-compound-small.slp`, the worker's
 * `readCompoundColumnsWorker`), whose every column must equal h5wasm's own
 * `Dataset.value`, value for value (`Object.is`, so NaN and -0 count).
 *
 * Re-run after any sleap-io.js re-vendor (`grep -n 'luc3d #193\|narrow columns' lib/sleap-io/`).
 *
 * Run: node tests/e2e/reopen-store-columns-typed.mjs
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const server = await startServer(repoRoot);
const PORT = server.port;

let fails = 0;
const check = (msg, cond, extra) => {
    console.log((cond ? '  ok   ' : '  FAIL ') + msg + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
    if (!cond) fails++;
};

let browser;
try {
    browser = await launchBrowser({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('[pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm, null, { timeout: 120000 });

    console.log('reopen-store-columns-typed:');

    const res = await page.evaluate(async () => {
        const CAMS = ['camA', 'camB'];
        const NODES = ['nose', 'neck', 'tail'];
        const NFRAMES = 6;
        const [pd, fileio, lazyMod] = await Promise.all([
            import('/pose/pose-data.js'),
            import('/import-export/file-io.js'),
            import('/loading/sio-lazy-loader.js'),
        ]);
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const M = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
        const cameras = CAMS.map((n, i) => new Camera(
            n, M, [-0.1, 0.01, 0, 0, 0], [0.1 * i, 0.2, 0.3], [10 + i, -3, 1], [512, 512]));
        const skeleton = new Skeleton('skeleton', NODES, [[0, 1], [1, 2]]);
        const session = new Session(cameras, skeleton, ['track_0'], 'TypedCols');

        // Distinctive, exactly-representable coordinates so a value regression is
        // unambiguous (and non-integral, to catch an accidental integer column).
        const xyFor = (f, c, k) => [100 + f * 10 + c + k * 0.5, 200 + f * 10 + c * 2 + k * 0.25];
        for (let f = 0; f < NFRAMES; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            const group = new InstanceGroup(f + 1, -1);
            CAMS.forEach((cn, ci) => {
                const inst = new Instance(NODES.map((_, k) => xyFor(f, ci, k)), 0, 'user', 1);
                fg.addInstance(cn, inst);
                group.addInstance(cn, inst);
            });
            group.points3d = new Float64Array([1 + f, 2 + f, 3 + f, 4 + f, 5 + f, 6 + f, 7 + f, 8 + f, 9 + f]);
            session.instanceGroups.set(f, [group]);
        }
        const views = CAMS.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: NFRAMES }));
        const videoFiles = CAMS.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));

        const labels = fileio.buildSlpLabelsAllViews(session, views, videoFiles);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);

        // Reopen through the REAL project-reopen path.
        const file = new File([bytes], 'typedcols.slp', { type: 'application/octet-stream' });
        const loader = new lazyMod.SioLazyLoader();
        await loader.openProjectSlp(file);

        const out = { bytes: bytes.length, cams: loader.labelsByCam.size, tables: [], sample: null };
        const storesSeen = new Set();
        for (const [, lbl] of loader.labelsByCam) {
            const store = lbl && lbl._lazyDataStore;
            if (!store || storesSeen.has(store)) continue;
            storesSeen.add(store);
            for (const key of ['framesData', 'instancesData', 'pointsData', 'predPointsData']) {
                const tbl = store[key];
                if (!tbl) continue;
                for (const col of Object.keys(tbl)) {
                    const v = tbl[col];
                    out.tables.push({
                        table: key,
                        col,
                        isView: ArrayBuffer.isView(v),
                        isPlainArray: Array.isArray(v),
                        ctor: v && v.constructor ? v.constructor.name : String(v),
                        len: v && v.length !== undefined ? v.length : -1,
                    });
                }
            }
            // Value spot-check straight off the typed columns.
            const p = store.pointsData;
            if (p && p.x && p.x.length >= 2) {
                out.sample = { x0: p.x[0], y0: p.y[0], x1: p.x[1], y1: p.y[1] };
            }
        }
        out.nStores = storesSeen.size;
        out.expect = { x0: xyFor(0, 0, 0)[0], y0: xyFor(0, 0, 0)[1], x1: xyFor(0, 0, 1)[0], y1: xyFor(0, 0, 1)[1] };
        return out;
    });

    check(`reopened the saved project (${res.bytes} bytes, ${res.cams} cameras, ${res.nStores} store)`,
        res.bytes > 0 && res.cams === 2);
    check(`found store columns to check (${res.tables.length})`, res.tables.length > 0, res.tables.length);

    const plain = res.tables.filter(t => t.isPlainArray);
    const notView = res.tables.filter(t => !t.isView);
    check('NO store column is a plain JS Array (luc3d #193)', plain.length === 0,
        plain.map(t => `${t.table}.${t.col}`));
    check('EVERY store column is a typed-array view (luc3d #193)', notView.length === 0,
        notView.map(t => `${t.table}.${t.col}=${t.ctor}`));

    // Never f32: `point_id_start/end` exceed f32's exact range (2^24) on real
    // projects — the sleap-io.js#231 failure class. Uint32Array is exact.
    const idCols = res.tables.filter(t => /^(point_id_start|point_id_end|instance_id|frame_id)$/.test(t.col));
    check(`id/index columns are Float64Array or Uint32Array (${idCols.length} checked)`,
        idCols.length > 0 && idCols.every(t => t.ctor === 'Float64Array' ||
            (t.ctor === 'Uint32Array' && /^point_id_/.test(t.col))),
        idCols.map(t => `${t.col}=${t.ctor}`));

    // Narrow columns: what this all-fitting project's store holds, column by column.
    const want = (table, col) => {
        if (table === 'framesData') return 'Float64Array';
        if (/^(x|y|score|tracking_score)$/.test(col)) return 'Float32Array';
        if (/^(visible|complete|instance_type|skeleton)$/.test(col)) return 'Uint8Array';
        if (/^point_id_(start|end)$/.test(col)) return 'Uint32Array';
        return 'Float64Array';
    };
    const wrongType = res.tables.filter(t => t.len > 0 && t.ctor !== want(t.table, t.col));
    check('LUCID-written store: every column has its narrow type (narrow columns)', wrongType.length === 0,
        wrongType.map(t => `${t.table}.${t.col}=${t.ctor} (want ${want(t.table, t.col)})`));
    const written = res.tables.filter(t => /^(track|from_predicted)$/.test(t.col) || t.table === 'framesData');
    check(`columns LUCID writes into stay Float64Array (${written.length} checked)`,
        written.length > 0 && written.every(t => t.ctor === 'Float64Array'),
        written.filter(t => t.ctor !== 'Float64Array').map(t => `${t.table}.${t.col}=${t.ctor}`));

    if (res.sample) {
        const e = res.expect, s = res.sample;
        check('point coordinates read back exactly off the typed columns',
            s.x0 === e.x0 && s.y0 === e.y0 && s.x1 === e.x1 && s.y1 === e.y1,
            { got: s, want: e });
    } else {
        check('point coordinates available to spot-check', false);
    }

    // ---- A Python-written compound .slp: the worker's builder. Every store
    // column must equal h5wasm's Dataset.value for that member, value for value.
    const cmp = await page.evaluate(async () => {
        const bytes = new Uint8Array(await (await fetch('/tests/fixtures/slp-compound/sleap-compound-small.slp')).arrayBuffer());
        const labels = await window.SleapIO.readSlpStreaming(new File([bytes], 'sleap-compound-small.slp'),
            { lazy: true, openVideos: false });
        const store = labels._lazyDataStore;
        window.h5wasm.FS.writeFile('/_narrow_cols.slp', bytes);
        const h5 = new window.h5wasm.File('/_narrow_cols.slp', 'r');
        const out = { tables: [], diffs: [], compound: 0 };
        try {
            const map = { frames: 'framesData', instances: 'instancesData', points: 'pointsData', pred_points: 'predPointsData' };
            for (const [ds, key] of Object.entries(map)) {
                const d = h5.get(ds);
                const members = d && d.metadata && d.metadata.compound_type && d.metadata.compound_type.members;
                if (!members) continue;
                out.compound++;
                const rows = d.value;
                members.forEach((m, mi) => {
                    const col = store[key][m.name];
                    out.tables.push({ table: key, col: m.name, ctor: col ? col.constructor.name : String(col),
                        len: col ? col.length : -1, fileType: (m.type === 1 ? 'f' : 'i') + m.size });
                    if (!col || col.length !== rows.length) { out.diffs.push(`${key}.${m.name}: length`); return; }
                    for (let i = 0; i < rows.length; i++) {
                        const v = Number(rows[i][mi]);
                        if (!Object.is(col[i], v)) { out.diffs.push(`${key}.${m.name}[${i}] ${col[i]} != ${v}`); return; }
                    }
                });
            }
        } finally { h5.close(); window.h5wasm.FS.unlink('/_narrow_cols.slp'); }
        return out;
    });
    console.log('  compound fixture columns: ' + cmp.tables.filter(t => t.len > 0)
        .map(t => `${t.table.replace('Data', '')}.${t.col}(${t.fileType})=${t.ctor.replace('Array', '')}`).join(' '));
    check(`compound fixture: four compound tables read (${cmp.compound})`, cmp.compound === 4);
    check('compound fixture: every store column equals Dataset.value, value for value', cmp.diffs.length === 0,
        cmp.diffs.slice(0, 5));
    const cWritten = cmp.tables.filter(t => /^(track|from_predicted)$/.test(t.col) || t.table === 'framesData');
    check('compound fixture: columns LUCID writes into stay Float64Array',
        cWritten.length > 0 && cWritten.every(t => t.ctor === 'Float64Array'),
        cWritten.filter(t => t.ctor !== 'Float64Array').map(t => `${t.table}.${t.col}=${t.ctor}`));
    const cFlags = cmp.tables.filter(t => t.len > 0 && /^(visible|complete)$/.test(t.col));
    check('compound fixture: visible/complete are Uint8Array', cFlags.length >= 4 &&
        cFlags.every(t => t.ctor === 'Uint8Array'), cFlags.map(t => `${t.table}.${t.col}=${t.ctor}`));
} catch (err) {
    console.log('FATAL ' + String(err).slice(0, 500));
    fails++;
} finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
