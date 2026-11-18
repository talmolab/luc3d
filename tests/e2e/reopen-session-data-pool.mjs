/**
 * reopen-session-data-pool.mjs — a project reopen reads `/session_data` (the 3D
 * groups: frame_groups, instance_groups, instance_group_members, points_3d,
 * unsmoothed_points_3d, the meta blobs) on the reader's worker pool, one
 * dataset per worker, side by side (LUCID local patch, column reads:
 * `readSessionDataStreaming`). Without a pool the one worker reads them one
 * after another, as before. The pool is opened at the start of the read
 * (`lucidPool.warm()`), so its workers are ready when the 3D is reached.
 * On an 8-camera, 108,000-frame project this step went from ~1.0 to ~0.5 s.
 *
 * Asserts on a fixture (sleap-io.js's typed API) with 3D on every group, a
 * smoothing source (`Instance3D.lucidUnsmoothed`) on some, and group metadata:
 *   - read with a pool (`lucidReadWorkers: 4`), the session equals the
 *     one-worker read: every frame group's frame and refs, every instance
 *     group's refs, metadata, score, 3D and smoothing source, value for value;
 *   - the pool's reads really went to more than one worker;
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

        // Which worker each session_data read went to.
        const orig = Worker.prototype.postMessage;
        let wseq = 0, sessMsgs = [];
        Worker.prototype.postMessage = function (m, t) {
            if (m && m.payload && typeof m.payload.path === 'string' && m.payload.path.startsWith('session_data/') &&
                (m.type === 'getDatasetValue' || m.type === 'lucidReadColumn')) {
                if (!this.__wid) this.__wid = ++wseq;
                sessMsgs.push(this.__wid);
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
        const read = async (workers) => {
            sessMsgs = [];
            const labels = await S.readSlpStreaming(file, { lazy: true, openVideos: false, h5wasmUrl, lucidReadWorkers: workers });
            return { d: digest(labels), workers: new Set(sessMsgs).size, msgs: sessMsgs.length };
        };
        const one = await read(undefined);
        const pool = await read(4);
        sessMsgs = [];
        const SioLazyLoader = (await import('./loading/sio-lazy-loader.js')).SioLazyLoader;
        const o = await new SioLazyLoader().openProjectSlp(file);
        const lucid = { d: digest(o.labels), workers: new Set(sessMsgs).size };
        Worker.prototype.postMessage = orig;
        const firstDiff = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return [i, (a[i] || '').slice(0, 300), (b[i] || '').slice(0, 300)]; return null; };
        const withUns = one.d.filter(l => !l.includes('|-]')).length;
        return {
            frames: one.d.length, withUns, oneWorkers: one.workers, oneMsgs: one.msgs,
            poolWorkers: pool.workers, poolDiff: firstDiff(one.d, pool.d),
            lucidWorkers: lucid.workers, lucidDiff: firstDiff(one.d, lucid.d),
            cores: navigator.hardwareConcurrency,
        };
    });
    check(res.frames === 2000 && res.withUns > 0 && res.oneMsgs >= 5 && res.oneWorkers === 1,
        `one worker reads /session_data one dataset after another (${res.frames} frame groups, ${res.oneMsgs} reads)`, res);
    check(res.poolDiff === null, 'with a pool of 4 the sessions are the same, value for value (3D, smoothing source, refs, metadata)', res.poolDiff);
    check(res.poolWorkers > 1, `the pool's /session_data reads went to ${res.poolWorkers} workers`, res);
    const expected = Math.max(1, Math.min(5, (res.cores || 2) - 1));
    check(res.lucidDiff === null && (expected === 1 ? res.lucidWorkers === 1 : res.lucidWorkers > 1),
        `SioLazyLoader.openProjectSlp reads them on its pool too (${res.lucidWorkers} workers) and gets the same`, res);
    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close();
    server.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
