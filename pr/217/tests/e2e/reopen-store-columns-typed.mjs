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
 * Re-run after any sleap-io.js re-vendor (`grep -n 'luc3d #193' lib/sleap-io/`).
 *
 * Run: node tests/e2e/reopen-store-columns-typed.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8198);

let fails = 0;
const check = (msg, cond, extra) => {
    console.log((cond ? '  ok   ' : '  FAIL ') + msg + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
    if (!cond) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('[pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm, { timeout: 120000 });

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

    // The columns must be f64: `point_id_start/end` exceed f32's exact range
    // (2^24) on real projects — the sleap-io.js#231 failure class.
    const idCols = res.tables.filter(t => /^(point_id_start|point_id_end|instance_id|frame_id)$/.test(t.col));
    check(`id/index columns are Float64Array (${idCols.length} checked)`,
        idCols.length > 0 && idCols.every(t => t.ctor === 'Float64Array'),
        idCols.map(t => `${t.col}=${t.ctor}`));

    if (res.sample) {
        const e = res.expect, s = res.sample;
        check('point coordinates read back exactly off the typed columns',
            s.x0 === e.x0 && s.y0 === e.y0 && s.x1 === e.x1 && s.y1 === e.y1,
            { got: s, want: e });
    } else {
        check('point coordinates available to spot-check', false);
    }
} catch (err) {
    console.log('FATAL ' + String(err).slice(0, 500));
    fails++;
} finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
