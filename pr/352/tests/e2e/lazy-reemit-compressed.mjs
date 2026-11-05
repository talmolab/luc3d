/**
 * lazy-reemit-compressed.mjs — the sleap-io.js lazy fast path
 * (`saveSlpToBytes` on lazy Labels → `writeSlpToFileLazy`, LUCID local patch
 * "lazy re-emit"), which By Cam uses to export a camera of a folder-loaded
 * project from its own store.
 *
 *  1. A table past SESSION_FLUSH_ROWS (8,192 rows) is written gzip level 1 in
 *     column chunks [min(65,536, rows), 1], and every value of all four tables
 *     reads back exactly as in the source file. The file is well under the size
 *     of the same tables uncompressed (it used to be ~200 MB per camera on a
 *     108,000-frame, 5-mouse recording; over an SMB share Chrome's close()
 *     reads a file back at ~10 MB/s, so size is time).
 *  2. A small file (every table at most 8,192 rows) is written exactly as
 *     before: contiguous, no filters.
 *
 * Run: PORT=9365 node tests/e2e/lazy-reemit-compressed.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9365);
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));
let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(300000);
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });

    /** Source file (eager save of one camera) → lazy read → lazy re-emit; both read back with h5wasm. */
    const run = (FRAMES) => page.evaluate(async (FRAMES) => {
        const [pd, fileio] = await Promise.all([import('/pose/pose-data.js'), import('/import-export/file-io.js')]);
        const NODES = ['a', 'b', 'c', 'd'];
        const cam = new pd.Camera('c0', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
        const s = new pd.Session([cam], new pd.Skeleton('sk', NODES, [[0, 1]]), ['t0', 't1', 't2'], 'fixture');
        const val = (k) => Math.sin(k * 12.9898) * 300.123457 + 320;
        let seed = 0;
        for (let f = 0; f < FRAMES; f++) {
            const fg = new pd.FrameGroup(f);
            for (let t = 0; t < 3; t++) {
                const k = seed++ * 4;
                const pred = new pd.Instance(NODES.map((_, i) => [val(k + i), val(k + i + 0.5)]), t, 'predicted', 0.9);
                pred.setPointScores(NODES.map((_, i) => Math.abs(Math.sin(k + i)) * 0.99));
                fg.addInstance('c0', pred);
            }
            if (f % 50 === 0) fg.addInstance('c0', new pd.Instance(NODES.map((_, i) => [val(f + i), 7 + i]), 0, 'user', null));
            s.addFrameGroup(fg);
        }
        const SIO = window.SleapIO;
        const src = await SIO.saveSlpToBytes(fileio.buildSlpLabels(s, 'c0', null, { name: 'c0', videoPath: 'c0.mp4' }, null));
        const h5url = new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href;
        const lazy = await SIO.readSlpStreaming(new File([src], 'c0.slp'), { lazy: true, openVideos: false, h5wasmUrl: h5url });
        if (!lazy.isLazy) return { err: 'not lazy' };
        const out = await SIO.saveSlpToBytes(lazy);

        const h5 = await import('h5wasm');
        await h5.ready;
        const read = (bytes, tag) => {
            const p = '/__reemit_' + tag + '.slp';
            h5.FS.writeFile(p, bytes);
            const f = new h5.File(p, 'r'), o = {};
            for (const n of ['frames', 'instances', 'points', 'pred_points']) {
                const d = f.get(n);
                o[n] = { shape: d.shape, chunks: d.metadata.chunks || null, filters: (d.filters || []).map(x => x.name || x.id),
                         value: Array.from(d.value, Number), fields: d.attrs.field_names && d.attrs.field_names.value };
            }
            f.close();
            h5.FS.unlink(p);
            return o;
        };
        const a = read(src, 'src'), b = read(out, 'out');
        const tables = {};
        let rawBytes = 0;
        for (const n of Object.keys(a)) {
            let diff = 0;
            for (let i = 0; i < Math.max(a[n].value.length, b[n].value.length); i++) {
                const x = a[n].value[i], y = b[n].value[i];
                if (!(x === y || (Number.isNaN(x) && Number.isNaN(y)))) diff++;
            }
            tables[n] = { rows: b[n].shape[0], cols: b[n].shape[1], sameShape: JSON.stringify(a[n].shape) === JSON.stringify(b[n].shape),
                          sameFields: a[n].fields === b[n].fields, diff, chunks: b[n].chunks, filters: b[n].filters };
            rawBytes += b[n].shape[0] * b[n].shape[1] * 8;
        }
        return { srcBytes: src.length, outBytes: out.length, rawTableBytes: rawBytes, tables };
    }, FRAMES);

    console.log('1. Large tables: gzip column chunks, every value unchanged');
    const big = await run(20000);
    if (big.err) check(false, 'fixture', big.err);
    else {
        for (const [n, t] of Object.entries(big.tables)) {
            check(t.sameShape && t.sameFields && t.diff === 0, `${n}: ${t.rows.toLocaleString('en-US')} rows read back value for value`, t.diff ? t : undefined);
            if (t.rows > 8192) {
                check(JSON.stringify(t.chunks) === JSON.stringify([Math.min(65536, t.rows), 1]) && t.filters.some(f => /deflate|gzip|^1$/i.test(String(f))),
                    `${n}: gzip in column chunks`, { chunks: t.chunks, filters: t.filters });
            }
        }
        check(big.outBytes < big.rawTableBytes / 2, 'the file is under half the tables\' uncompressed size',
            { outMB: +(big.outBytes / 1e6).toFixed(2), rawMB: +(big.rawTableBytes / 1e6).toFixed(2) });
    }

    console.log('2. Small tables: written as before (contiguous, no filters)');
    const small = await run(300);
    if (small.err) check(false, 'fixture', small.err);
    else {
        for (const [n, t] of Object.entries(small.tables)) {
            check(t.rows <= 8192 && !t.chunks && t.filters.length === 0 && t.diff === 0, `${n}: ${t.rows} rows, contiguous, values unchanged`, t.chunks || t.filters.length ? t : undefined);
        }
    }
    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
