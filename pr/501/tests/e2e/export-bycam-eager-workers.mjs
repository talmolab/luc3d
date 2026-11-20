/**
 * export-bycam-eager-workers.mjs — By Cam's fully loaded (eager) cameras
 * compressed in workers (`exportCamerasInWorkers`, bundle patch "eager divert"
 * + `import-export/slp-rows-worker.js`).
 *
 * An eager session of three cameras: two large (every 2D table past 8,192
 * rows, user and predicted instances, per-node scores), one small (every table
 * at most 8,192 rows).
 *  1. Each camera takes the eager route (`cameraExportUsesEagerBuild`), and the
 *     files written with workers equal today's eager export
 *     (`exportSlpMultiSession`, one thread), table by table, value for value,
 *     with the same shape, chunks, filters, dtype and `field_names`; so do the
 *     rest of the file's datasets and attributes (metadata, videos, tracks…).
 *     The workers ran (console line); progress counts cameras 0/3 → 3/3.
 *  2. `workers: false` stays on this thread, same files.
 *  3. Workers that cannot start (`Worker` throws) fall back to this thread,
 *     same files, and say why.
 *  4. `saveSlpToBytes` without `lucidDivertTables` is unchanged by the patch
 *     (the plain file still holds its rows), and the hook is off after a call.
 *
 * Run: PORT=9366 node tests/e2e/export-bycam-eager-workers.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9366);
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
    const errs = [], logs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    page.on('console', m => { if (/export-slp-|export workers/.test(m.text())) logs.push(m.text()); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });

    const res = await page.evaluate(async () => {
        const [pd, fileio, AS] = await Promise.all([import('/pose/pose-data.js'), import('/import-export/file-io.js'), import('/ui/app-state.js')]);
        const NODES = ['a', 'b', 'c', 'd'];
        const cams = ['c0', 'c1', 'c2'];
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const s = new pd.Session(cams.map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [10 * i, 0, 0], [640, 480])),
            new pd.Skeleton('sk', NODES, [[0, 1], [1, 2]]), ['t0', 't1', 't2'], 'Eager');
        const val = (k) => Math.sin(k * 12.9898) * 300.123457 + 320;
        let seed = 0;
        for (let f = 0; f < 20000; f++) {
            const fg = new pd.FrameGroup(f);
            s.addFrameGroup(fg);
            for (const cn of cams) {
                if (cn === 'c1' && f >= 15000) continue;
                if (cn === 'c2' && f >= 300) continue;
                for (let t = 0; t < 3; t++) {
                    const k = seed++ * 4;
                    const pred = new pd.Instance(NODES.map((_, i) => [val(k + i), val(k + i + 0.5)]), t, 'predicted', 0.9);
                    pred.setPointScores(NODES.map((_, i) => Math.abs(Math.sin(k + i)) * 0.99));
                    fg.addInstance(cn, pred);
                }
                if (f % 2 === 0) fg.addInstance(cn, new pd.Instance(NODES.map((_, i) => [val(f + i), 7 + i]), f % 3, 'user', null));
            }
        }
        AS.state.sessions = [s]; AS.state.session = s; AS.state.activeSessionIdx = 0;
        const vfs = cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '/' + n + '.mp4', sessionIdx: 0 }));
        AS.state.videoFiles = vfs;
        const filter = { user: true, predicted: true, reprojected: false };
        const sels = cams.map((cn, i) => ({ session: s, cameraName: cn, videoFileInfo: vfs[i] }));
        const usable = sels.map(x => fileio.cameraExportUsesEagerBuild(x, null, filter));

        const plain = [];
        for (const sel of sels) plain.push(new Uint8Array(await (await fileio.exportSlpMultiSession([sel], null, filter)).arrayBuffer()));
        const progress = [];
        const workers = await fileio.exportCamerasInWorkers(sels, null, filter, { onProgress: (d, t) => progress.push(d + '/' + t) });
        const thread = await fileio.exportCamerasInWorkers(sels, null, filter, { workers: false });
        const RealWorker = window.Worker;
        window.Worker = function () { throw new Error('no workers in this test'); };
        let fallback;
        try { fallback = await fileio.exportCamerasInWorkers(sels, null, filter, { workers: 3 }); }
        finally { window.Worker = RealWorker; }
        // §4: a plain call after the diverted ones still writes its rows itself.
        const again = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsMultiSession([sels[0]], null, filter));

        const h5 = await import('h5wasm');
        await h5.ready;
        let seq = 0;
        const read = (bytes) => {
            const p = '/__eg_' + (seq++) + '.slp';
            h5.FS.writeFile(p, bytes);
            const f = new h5.File(p, 'r'), o = {};
            const walk = (g, prefix) => {
                for (const key of g.keys()) {
                    const it = g.get(key), name = prefix + key;
                    const attrs = {};
                    for (const a of Object.keys(it.attrs || {})) {
                        let v = it.attrs[a].value;
                        if (/exported_at|^provenance$/.test(a)) v = '(time)';
                        attrs[a] = typeof v === 'string' ? v.replace(/"exported_at":\s*"[^"]*"/g, '"exported_at":"(time)"') : JSON.stringify(Array.from(v && v.length != null && typeof v !== 'string' ? v : [v], x => typeof x === 'bigint' ? Number(x) : x));
                    }
                    if (it instanceof h5.Group) { o[name] = { group: true, attrs: JSON.stringify(attrs) }; walk(it, name + '/'); continue; }
                    let v = it.value;
                    if (typeof v === 'string') v = [v];
                    v = Array.from(v, x => typeof x === 'bigint' ? Number(x) : x);
                    o[name] = { v, layout: JSON.stringify({ shape: it.shape, chunks: it.metadata.chunks || null, filters: it.filters || [], dtype: it.dtype, attrs }) };
                }
            };
            walk(f, '');
            const top = {};
            for (const a of Object.keys(f.attrs || {})) top[a] = String(f.attrs[a].value);
            o['/'] = { group: true, attrs: JSON.stringify(top) };
            f.close();
            h5.FS.unlink(p);
            return o;
        };
        const cmp = (A, B) => {
            const bad = [];
            const names = new Set([...Object.keys(A), ...Object.keys(B)]);
            for (const n of names) {
                if (!A[n] || !B[n]) { bad.push(n + ' only in one file'); continue; }
                if (A[n].group) { if (A[n].attrs !== B[n].attrs && n !== '/') bad.push(n + ' attrs'); continue; }
                if (A[n].layout !== B[n].layout) { bad.push(n + ' layout ' + A[n].layout + ' vs ' + B[n].layout); continue; }
                const a = A[n].v, b = B[n].v;
                let diff = a.length !== b.length ? 1 : 0;
                for (let i = 0; i < a.length; i++) {
                    const x = a[i], y = b[i];
                    if (!(x === y || (typeof x === 'number' && Number.isNaN(x) && Number.isNaN(y)) ||
                          (typeof x === 'string' && x.replace(/"exported_at":\s*"[^"]*"/g, '') === String(y).replace(/"exported_at":\s*"[^"]*"/g, '')))) diff++;
                }
                if (diff) bad.push(n + ': ' + diff + ' values differ');
            }
            return bad;
        };
        const out = [];
        for (let i = 0; i < 3; i++) {
            const P = read(plain[i]);
            const layout = n => JSON.parse(P[n].layout);
            out.push({ cam: cams[i], rows: Object.fromEntries(['frames', 'instances', 'points', 'pred_points'].map(n => [n, layout(n).shape[0]])),
                       chunks: layout('pred_points').chunks, filters: layout('pred_points').filters.length,
                       workers: workers[i] ? cmp(P, read(workers[i])) : ['null'],
                       thread: thread[i] ? cmp(P, read(thread[i])) : ['null'],
                       fallback: fallback[i] ? cmp(P, read(fallback[i])) : ['null'] });
        }
        const againCmp = cmp(read(plain[0]), read(again));
        return { usable, out, progress, againCmp };
    });

    console.log('1. Fully loaded cameras in workers = today\'s eager export');
    check(res.usable.every(Boolean), 'all three cameras take the eager route', res.usable);
    const [big0, big1, small] = res.out;
    check(Object.values(big0.rows).every(n => n > 8192) && Object.values(big1.rows).every(n => n > 8192),
        'c0 and c1: every 2D table past 8,192 rows', [big0.rows, big1.rows]);
    check(JSON.stringify(big0.chunks) === '[65536,1]' && big0.filters > 0, 'c0 pred_points: gzip column chunks', { chunks: big0.chunks, filters: big0.filters });
    check(Object.values(small.rows).every(n => n <= 8192) && !small.chunks && small.filters === 0, 'c2: every table at most 8,192 rows, contiguous', small.rows);
    for (const r of res.out) {
        check(r.workers.length === 0, `${r.cam} (${r.rows.pred_points.toLocaleString('en-US')} pred rows): workers = eager export (every dataset: values, shape, chunks, filters, dtype, attributes)`, r.workers.slice(0, 5));
    }
    check(res.progress[0] === '0/3' && res.progress[res.progress.length - 1] === '3/3', 'progress counts cameras 0/3 → 3/3', res.progress);
    check(logs.some(l => /\[export-slp-eager\] 3 fully loaded camera\(s\) written .*\(up to \d+ workers? at once\)/.test(l)), 'the workers ran', logs.length);

    console.log('2. workers: false');
    for (const r of res.out) check(r.thread.length === 0, `${r.cam}: one thread = eager export`, r.thread.slice(0, 5));
    check(logs.some(l => /\[export-slp-eager\] .*\(this thread\)/.test(l)), 'stayed on this thread', logs.length);

    console.log('3. Workers that cannot start');
    for (const r of res.out) check(r.fallback.length === 0, `${r.cam}: fallback = eager export`, r.fallback.slice(0, 5));
    check(logs.some(l => /export workers unavailable/.test(l)), 'the fallback said why', logs.length);

    console.log('4. A plain save after diverted ones');
    check(res.againCmp.length === 0, 'saveSlpToBytes without the option writes its rows itself', res.againCmp.slice(0, 5));
    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
