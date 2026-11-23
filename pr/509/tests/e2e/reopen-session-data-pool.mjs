/**
 * reopen-session-data-pool.mjs — a project reopen reads `/session_data` (the 3D
 * groups: frame_groups, instance_groups, instance_group_members, points_3d,
 * unsmoothed_points_3d, the meta blobs) on the reader's worker pool, every
 * dataset at once and each in pieces spread over all the workers (LUCID local
 * patch, column reads: `lucidReadSessionDataPooled`): tables in one-column
 * chunks in column pieces, older whole-row chunks in row blocks, the meta blobs
 * in ranges of entries. Without a pool one worker reads them one after
 * another, as before. On the 8-camera HardFight project these reads went from
 * ~0.88 to ~0.25 s.
 *
 * The fixture (sleap-io.js's typed API) has 3D on every group, a smoothing
 * source (`Instance3D.lucidUnsmoothed`) on some, and group metadata; a copy
 * holds its /session_data tables in 500-row chunks. With small pieces
 * (`__lucidReadSliceElems`, `__lucidVlenRangeRows`) asserts that:
 *   - a pool of 4 gives the one-worker sessions, value for value (every frame
 *     group's refs, every instance group's refs, metadata, score, 3D and
 *     smoothing source), with points_3d's column pieces and the meta ranges
 *     on more than one worker;
 *   - the older layout gives the same, one worker or pooled row blocks;
 *   - a failed meta range or column piece falls back to a whole read;
 *   - SioLazyLoader.openProjectSlp (which asks for the pool) gives it too.
 *
 * Run: node tests/e2e/reopen-session-data-pool.mjs
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
        const S = window.SleapIO;
        const FRAMES = 2000, CAMS = 3, ANIMALS = 2, NODES = 3;
        const nodes = Array.from({ length: NODES }, (_, j) => new S.Node('n' + j));
        const skeleton = new S.Skeleton({ nodes, edges: [new S.Edge(nodes[0], nodes[1])], name: 'sk' });
        const tracks = Array.from({ length: ANIMALS }, (_, k) => new S.Track('track ' + k));
        const cams = Array.from({ length: CAMS }, (_, c) => new S.Camera({
            name: 'Camera' + c, matrix: [[900, 0, 320], [0, 900, 256], [0, 0, 1]],
            rvec: [0, 0.3 * c, 0], tvec: [0, 0, 1000], distortions: [0, 0, 0, 0, 0], size: [640, 512],
        }));
        const videos = cams.map((cam, c) => {
            const fn = 'Camera' + c + '.mp4';
            const v = new S.Video({ filename: fn, backendMetadata: { type: 'MediaVideo', shape: [FRAMES, 512, 640, 1], filename: fn }, openBackend: false });
            v.shape = [FRAMES, 512, 640, 1];
            return v;
        });
        const session = new S.RecordingSession({ cameraGroup: new S.CameraGroup({ cameras: cams }) });
        cams.forEach((cam, c) => session.addVideo(videos[c], cam));
        const lfs = [];
        for (let c = 0; c < CAMS; c++) {
            for (let f = 0; f < FRAMES; f++) {
                const insts = [];
                for (let d = 0; d < ANIMALS; d++) {
                    const points = Array.from({ length: NODES }, (_, j) => ({ xy: [50 + 120 * d + 10 * j + c, 60 + 8 * j + 0.1 * f], visible: true, complete: true, score: 0.9 }));
                    insts.push(new S.PredictedInstance({ points, skeleton, track: tracks[d], score: 0.8 }));
                }
                lfs.push(new S.LabeledFrame({ video: videos[c], frameIdx: f, instances: insts }));
            }
        }
        const v3 = (f, k, j, a) => Math.sin(f * 0.37 + k * 1.9 + j * 0.53 + a) * 123.456789;
        for (let f = 0; f < FRAMES; f++) {
            const groups = [];
            const lfRefs = new Map();
            cams.forEach((cam, c) => lfRefs.set(cam, c * FRAMES + f));
            for (let k = 0; k < ANIMALS; k++) {
                const refs = new Map();
                cams.forEach((cam, c) => refs.set(cam, [c * FRAMES + f, (k + c + f) % ANIMALS]));
                const i3d = new S.Instance3D({ points: Array.from({ length: NODES }, (_, j) => [v3(f, k, j, 0), v3(f, k, j, 1), v3(f, k, j, 2)]), skeleton });
                if (f % 3 === 0) i3d.lucidUnsmoothed = Float64Array.from({ length: NODES * 3 }, (_, i) => v3(f, k, i, 7));
                groups.push(new S.InstanceGroup({
                    instanceRefsByCamera: refs, instance3d: i3d, score: 0.25 * k,
                    metadata: { lucid: { identityId: k, triangulationMethod: f % 2 ? 'ba' : 'dlt' } },
                }));
            }
            session.frameGroups.set(f, new S.FrameGroup({ frameIdx: f, instanceGroups: groups, labeledFrameRefsByCamera: lfRefs }));
        }
        const labels0 = new S.Labels({ labeledFrames: lfs, videos, skeletons: [skeleton], tracks, sessions: [session], provenance: {} });
        const file = new File([await S.saveSlpToBytes(labels0)], 'sessdata.slp');

        // The same project with its /session_data tables in an older layout:
        // gzip chunks of 500 whole rows (the root tables are copied as they are).
        const h5 = window.h5wasm;
        const copyAttrs = (from, to) => { for (const [k, a] of Object.entries(from.attrs)) to.create_attribute(k, a.value, a.shape, a.dtype); };
        const copyInto = (src, dst, inSession) => {
            for (const k of src.keys()) {
                const o = src.get(k);
                if (o instanceof h5.Group) { const g = dst.create_group(k); copyAttrs(o, g); copyInto(o, g, inSession || k === 'session_data'); continue; }
                const rowTable = inSession && o.shape.length === 2 && o.shape[0] > 0 && !o.metadata.vlen;
                const chunks = rowTable ? [Math.min(500, o.shape[0]), o.shape[1]] : undefined;
                dst.create_dataset({ name: k, data: o.value, shape: o.shape, dtype: o.dtype, chunks, compression: chunks ? 1 : undefined });
                copyAttrs(o, dst.get(k));
            }
        };
        const bytes = new Uint8Array(await file.arrayBuffer());
        h5.FS.writeFile('/__s.slp', bytes);
        const src = new h5.File('/__s.slp', 'r'), dst = new h5.File('/__o.slp', 'w');
        copyInto(src, dst, false); copyAttrs(src, dst);
        const layout = {};
        for (const k of src.get('session_data').keys()) {
            layout[k] = { new: src.get('session_data/' + k).metadata.chunks, old: dst.get('session_data/' + k).metadata.chunks, shape: src.get('session_data/' + k).shape };
        }
        src.close(); dst.close();
        const oldFile = new File([h5.FS.readFile('/__o.slp')], 'sessdata-old.slp');
        h5.FS.unlink('/__s.slp'); h5.FS.unlink('/__o.slp');

        // Which worker each session_data read went to; `corrupt` breaks the Nth read of one kind.
        const orig = Worker.prototype.postMessage;
        let wseq = 0, sessMsgs = [], corrupt = null;
        Worker.prototype.postMessage = function (m, t) {
            if (m && m.payload && typeof m.payload.path === 'string' && m.payload.path.startsWith('session_data/')) {
                if (!this.__wid) this.__wid = ++wseq;
                sessMsgs.push({ w: this.__wid, type: m.type, path: m.payload.path });
                if (corrupt && m.type === corrupt.type && sessMsgs.filter(x => x.type === corrupt.type).length === corrupt.n) {
                    m = { ...m, payload: { ...m.payload, path: 'session_data/no_such_table' } };
                }
            }
            return orig.call(this, m, t);
        };
        const h5wasmUrl = new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href;
        const digest = (labels) => {
            const out = [];
            const s = labels.sessions[0];
            for (const [fi, fg] of s.frameGroups) {
                let line = fi + '/' + fg.frameIdx + '/' + [...(fg._labeledFrameRefsByCamera || [])].map(([c, r]) => c.name + '=' + r).join(',');
                for (const ig of fg.instanceGroups) {
                    const i3 = ig.instance3d;
                    const pts = i3 && i3.points ? Array.from(i3.points.flat ? i3.points.flat(2) : i3.points).join(',') : '-';
                    const uns = i3 && i3.lucidUnsmoothed ? Array.from(i3.lucidUnsmoothed).join(',') : '-';
                    line += ` [${[...ig._instanceRefsByCamera].map(([c, r]) => c.name + '=' + r.join(':')).join(',')}|${JSON.stringify(ig.metadata)}|${ig.score}|${pts}|${uns}]`;
                }
                out.push(line);
            }
            return out;
        };
        const workersFor = (msgs, type, path) => new Set(msgs.filter(x => x.type === type && (!path || x.path === path)).map(x => x.w)).size;
        const read = async (f, { workers, small, fail } = {}) => {
            sessMsgs = [];
            corrupt = fail || null;
            if (small) { globalThis.__lucidReadSliceElems = 1000; globalThis.__lucidVlenRangeRows = 300; }
            const warns = [];
            const ow = console.warn;
            console.warn = (...a) => warns.push(String(a[0]));
            try {
                const labels = await S.readSlpStreaming(f, { lazy: true, openVideos: false, h5wasmUrl, lucidReadWorkers: workers });
                const msgs = sessMsgs.slice();
                return {
                    d: digest(labels), warns, msgs: msgs.length, workers: new Set(msgs.map(x => x.w)).size,
                    p3dColumnWorkers: workersFor(msgs, 'lucidReadColumn', 'session_data/points_3d'),
                    p3dBlockWorkers: workersFor(msgs, 'getDatasetValue', 'session_data/points_3d'),
                    metaWorkers: workersFor(msgs, 'lucidReadVlenRange'),
                };
            } finally {
                console.warn = ow;
                globalThis.__lucidReadSliceElems = globalThis.__lucidVlenRangeRows = undefined;
                corrupt = null;
            }
        };
        const firstDiff = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return [i, (a[i] || '').slice(0, 300), (b[i] || '').slice(0, 300)]; return null; };
        const one = await read(file);
        const pool = await read(file, { workers: 4, small: true });
        const oldOne = await read(oldFile);
        const oldPool = await read(oldFile, { workers: 4, small: true });
        const failMeta = await read(file, { workers: 4, small: true, fail: { type: 'lucidReadVlenRange', n: 2 } });
        const failCol = await read(file, { workers: 4, small: true, fail: { type: 'lucidReadColumn', n: 5 } });
        sessMsgs = [];
        const SioLazyLoader = (await import('./loading/sio-lazy-loader.js')).SioLazyLoader;
        const o = await new SioLazyLoader().openProjectSlp(file);
        const lucid = { d: digest(o.labels), workers: new Set(sessMsgs.map(x => x.w)).size };
        Worker.prototype.postMessage = orig;
        const summary = (r) => ({ diff: firstDiff(one.d, r.d), workers: r.workers, p3dColumnWorkers: r.p3dColumnWorkers, p3dBlockWorkers: r.p3dBlockWorkers, metaWorkers: r.metaWorkers, warns: r.warns });
        return {
            layout, frames: one.d.length, withUns: one.d.filter(l => !l.includes('|-]')).length,
            one: { workers: one.workers, msgs: one.msgs },
            pool: summary(pool), oldOne: summary(oldOne), oldPool: summary(oldPool),
            failMeta: summary(failMeta), failCol: summary(failCol),
            lucid: { diff: firstDiff(one.d, lucid.d), workers: lucid.workers },
            cores: navigator.hardwareConcurrency,
        };
    });
    const L = res.layout;
    check(JSON.stringify(L.points_3d.new) === '[65536,1]' && JSON.stringify(L.instance_group_members.new) === '[65536,1]' &&
        JSON.stringify(L.points_3d.old) === '[500,3]' && L.instance_group_meta && !L.instance_group_meta.old,
        'the fixture holds 3D tables in one-column chunks, and its copy in 500-row chunks', L);
    check(res.frames === 2000 && res.withUns > 0 && res.one.msgs >= 5 && res.one.workers === 1,
        `one worker reads /session_data one dataset after another (${res.frames} frame groups, ${res.one.msgs} reads)`, res.one);
    check(res.pool.diff === null && res.pool.p3dColumnWorkers > 1 && res.pool.metaWorkers > 1,
        `a pool of 4 reads points_3d in column pieces (${res.pool.p3dColumnWorkers} workers) and the meta blobs in ranges (${res.pool.metaWorkers} workers): same sessions, value for value`, res.pool);
    check(res.oldOne.diff === null && res.oldPool.diff === null && res.oldPool.p3dBlockWorkers > 1,
        `older layout: one worker and a pool (points_3d in row blocks on ${res.oldPool.p3dBlockWorkers} workers) give the same sessions`, { oldOne: res.oldOne, oldPool: res.oldPool });
    check(res.failMeta.diff === null && res.failMeta.warns.some(w => /pooled read of session_data\/\w+_meta failed/.test(w)),
        'a failed meta range falls back to a whole read: same sessions', res.failMeta);
    check(res.failCol.diff === null && res.failCol.warns.some(w => /pooled read of session_data\/\w*points_3d failed/.test(w) || /column read of session_data/.test(w)),
        'a failed column piece falls back to a whole read: same sessions', res.failCol);
    const expected = Math.max(1, Math.min(5, (res.cores || 2) - 1));
    check(res.lucid.diff === null && (expected === 1 ? res.lucid.workers === 1 : res.lucid.workers > 1),
        `SioLazyLoader.openProjectSlp reads them on its pool too (${res.lucid.workers} workers) and gets the same`, res.lucid);
    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close();
    server.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
