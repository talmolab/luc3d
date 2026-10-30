/**
 * percam-mixed-format-lazy.mjs — a per-camera folder whose cameras mix `.slp`
 * and SLEAP analysis `.h5` loads every camera when it goes lazy (#414), and a
 * camera that cannot be read neither sinks the load nor leaves the loading
 * card up (#415).
 *
 * #414: once any file is over its lazy threshold (`.h5` > 20 MB, `.slp` >
 * 150 MB) the whole folder goes lazy (#215), and ONE reader was picked for it
 * by "are they all `.slp`". One `.h5` in the set handed every `.slp` to the
 * analysis-`.h5`-only `LazyFrameLoader`: "No tracks dataset found in analysis
 * H5", no views at all. Now each `.h5` of a mixed set is rewritten as an
 * in-memory `.slp` (`convertAnalysisH5ToSlp`, in a worker, typed arrays) and
 * `SioLazyLoader` reads every camera.
 *
 * #415: a lazy open that failed rejected `Promise.all` at once, the loader
 * returned, and cameras finishing afterwards reopened the loading card, which
 * then sat over the error forever. Each camera now opens on its own: a broken
 * one is reported in the status line and the others load; only when none open
 * does the load fail — and in both cases the card stays down.
 *
 * The `.h5` is pushed over the 20 MB threshold by trailing zero padding (HDF5
 * ignores bytes past its end-of-file address; `shouldUseLazyH5` reads only the
 * size).
 *
 * Run: node tests/e2e/percam-mixed-format-lazy.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8275);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrs = [];
    page.on('pageerror', e => pageErrs.push(String(e).slice(0, 300)));

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 30000 });

    await page.evaluate(async () => {
        const enc = await import('/ui/video-encode.js');
        const fio = await import('/import-export/file-io.js');
        const pd = await import('/pose/pose-data.js');
        const SIOmod = await import('/lib/sleap-io/index.browser.js');
        const SIO = window.SleapIO;
        const NFRAMES = 12, W = 320, H = 240;
        const CAMS = ['cam1', 'cam2', 'cam3'];
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const cctx = canvas.getContext('2d');
        const wr = await enc.createMp4Writer({ canvas, width: W, height: H, fps: 10, bitrate: 400000, frameCount: NFRAMES, keyFrameEveryFrames: 4 });
        for (let i = 0; i < NFRAMES; i++) { cctx.fillStyle = 'rgb(' + (20 * i) + ',40,80)'; cctx.fillRect(0, 0, W, H); await wr.addFrame(i); }
        const mp4 = (await wr.finish()).blob;
        let toml = '';
        CAMS.forEach((cn, i) => {
            toml += '[cam_' + i + ']\nname = "' + cn + '"\nsize = [' + W + ', ' + H + ']\n'
                + 'matrix = [[600.0, 0.0, 160.0], [0.0, 600.0, 120.0], [0.0, 0.0, 1.0]]\n'
                + 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\n'
                + 'rotation = [0.0, ' + (0.2 * i) + ', 0.0]\ntranslation = [' + (15 * i) + ', 0.0, 0.0]\n\n';
        });
        const nodes = ['nose', 'body', 'tail'].map(n => new SIO.Node(n));
        const sk = new SIO.Skeleton({ nodes, edges: [new SIO.Edge(nodes[0], nodes[1]), new SIO.Edge(nodes[1], nodes[2])], name: 'sk' });
        function labels(cam, tag, perFrame) {
            const video = new SIO.Video({ filename: cam + '.mp4',
                backendMetadata: { type: 'MediaVideo', shape: [NFRAMES, H, W, 1], filename: cam + '.mp4', grayscale: false, bgr: false },
                openBackend: false });
            video.shape = [NFRAMES, H, W, 1];
            const tracks = [];
            for (let t = 0; t < perFrame; t++) tracks.push(new SIO.Track(tag + '_' + t));
            const lfs = [];
            for (let f = 0; f < 4; f++) {
                lfs.push(new SIO.LabeledFrame({ video, frameIdx: f, instances: tracks.map((tr, t) => new SIO.PredictedInstance({
                    points: [[10 + f + 40 * t, 20], [30 + f + 40 * t, 40], [NaN, NaN]].map((xy, k) =>
                        ({ xy, visible: k < 2, complete: k < 2, score: 0.5 + 0.1 * k })),
                    skeleton: sk, track: tr, score: 0.9 })) }));
            }
            return new SIO.Labels({ labeledFrames: lfs, videos: [video], skeletons: [sk], tracks, provenance: {} });
        }
        async function lucidExport(cam, tag, perFrame) {
            const K = [[600, 0, 160], [0, 600, 120], [0, 0, 1]];
            const cams = CAMS.map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [W, H]));
            const s = new pd.Session(cams, new pd.Skeleton('sk', ['nose', 'body', 'tail'], [[0, 1], [1, 2]]), [tag], 'gen');
            for (let f = 0; f < 4; f++) {
                const fg = new pd.FrameGroup(f);
                s.addFrameGroup(fg);
                for (let t = 0; t < perFrame; t++) fg.addInstance(cam, new pd.Instance([[10 + f, 20], [30 + f, 40], [50 + f, 60]], 0, 'user', 1));
            }
            return fio.exportSlpClientSide(s, cam, false, { videoPath: cam + '.mp4', file: null, videoWidth: W, videoHeight: H, frameCount: NFRAMES }, cam + '.slp', null);
        }
        const PAD = new Uint8Array(21 * 1024 * 1024);
        window.__F = {
            mp4, toml,
            h5big: new Blob([await SIOmod.saveAnalysisH5ToBytes(labels('cam1', 'H5', 2)), PAD]),
            lucid2: await lucidExport('cam2', 'LUCID2', 3),
            sleap3: new Blob([await SIO.saveSlpToBytes(labels('cam3', 'SLP3', 1))]),
            garbage: new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]),
            garbageBig: new Blob([new Uint8Array([9, 9, 9, 9]), PAD]),
        };
        window.__load = async function (root, entries) {
            const sl = await import('/loading/session-loader.js');
            const mk = (blob, rel) => { const f = new File([blob], rel.split('/').pop(), { lastModified: 1 }); Object.defineProperty(f, 'webkitRelativePath', { value: rel }); return f; };
            const F = window.__F;
            const files = [mk(new Blob([F.toml]), root + '/calibration.toml')];
            for (const cn of CAMS) files.push(mk(F.mp4, root + '/' + cn + '/' + cn + '.mp4'));
            for (const [rel, key] of entries) files.push(mk(F[key], root + '/' + rel));
            const AS = window.__lucid.state;
            AS.sessions = []; AS.activeSessionIdx = 0; AS.videoFiles = []; AS.session = null; AS.views = [];
            await sl.handleLoadSessionFolderPerCamera(files, false);
            // Let any straggling worker finish, then look at the card.
            await new Promise(r => setTimeout(r, 2500));
            const s = AS.session;
            const out = {
                views: AS.views.map(v => v.name),
                status: document.getElementById('statusText').textContent,
                statusDot: document.getElementById('statusDot').className,
                cardVisible: !document.getElementById('loadingOverlay').classList.contains('hidden'),
                lazy: !!(s && s.lazyLoader), loader: s && s.lazyLoader ? s.lazyLoader.constructor.name : null,
                store: {}, shown: {}, tracks: s ? s.tracks.slice() : null, score: null,
            };
            if (s && s.lazyLoader && s.lazyLoader.forEachInstanceRow) {
                s.lazyLoader.forEachInstanceRow((cn) => { out.store[cn] = (out.store[cn] || 0) + 1; });
                const tri = await import('/pose/triangulation.js');
                for (let f = 0; f < 4; f++) { AS.currentFrame = f; await tri.ensureLazyFrameData(f); }
                for (const [, fg] of s.frameGroups) for (const [cn, xs] of fg.unlinkedInstances) out.shown[cn] = (out.shown[cn] || 0) + xs.length;
                const fg0 = s.frameGroups.get(0);
                const u = fg0 && fg0.getUnlinkedInstances('cam1')[0];
                if (u) out.score = { node0: s.predictedNodeScore(u.instance, 'cam1', 0, 0), type: u.instance.type,
                                     x0: u.instance.getX(0), has2: u.instance.hasPoint(2) };
            }
            return out;
        };
    });

    console.log('\n-- §1 a lazy folder mixing an analysis .h5 with .slp files loads every camera (#414) --');
    const r1 = await page.evaluate(() => window.__load('mix', [
        ['cam1/cam1.analysis.h5', 'h5big'], ['cam2/cam2.slp', 'lucid2'], ['cam3/cam3.predictions.slp', 'sleap3']]));
    console.log('  ' + JSON.stringify(r1).slice(0, 600));
    check(r1.views.length === 3, `all three views (got ${JSON.stringify(r1.views)})`);
    check(r1.lazy && r1.loader === 'SioLazyLoader', `one lazy reader for every camera (got ${r1.loader})`);
    check(r1.store.cam1 === 8 && r1.store.cam2 === 12 && r1.store.cam3 === 4,
        `every camera's rows are in the store (got ${JSON.stringify(r1.store)})`);
    check(r1.shown.cam1 === 8 && r1.shown.cam2 === 12 && r1.shown.cam3 === 4,
        `and come up on screen (got ${JSON.stringify(r1.shown)})`);
    check(r1.tracks.indexOf('H5_0') >= 0 && r1.tracks.indexOf('H5_1') >= 0, `the .h5's tracks are in the session (got ${r1.tracks})`);
    check(r1.score && r1.score.type === 'predicted' && r1.score.x0 === 10 && r1.score.has2 === false,
        `the converted .h5 keeps its predictions, positions and missing nodes (got ${JSON.stringify(r1.score)})`);
    check(r1.score && Number.isNaN(r1.score.node0),
        'and, like every analysis-.h5 path, no per-node score (luc3d #322)');
    check(/^Loaded 3 camera\(s\)$/.test(r1.status) && !r1.cardVisible, `success, card down (got "${r1.status}")`);

    console.log('\n-- §2 one unreadable camera: the others load, it is named, the card stays down (#415) --');
    const r2 = await page.evaluate(() => window.__load('onebad', [
        ['cam1/cam1.analysis.h5', 'h5big'], ['cam2/cam2.slp', 'garbage'], ['cam3/cam3.predictions.slp', 'sleap3']]));
    console.log('  ' + JSON.stringify(r2).slice(0, 600));
    check(r2.views.length === 3, 'all three views');
    check(r2.store.cam1 === 8 && r2.store.cam3 === 4 && !r2.store.cam2, `cam1 and cam3 load (got ${JSON.stringify(r2.store)})`);
    check(/could not be read: cam2 \(cam2\.slp\)/.test(r2.status) && /error/.test(r2.statusDot),
        `the status names cam2's file as an error (got "${r2.status}")`);
    check(!r2.cardVisible, 'the loading card is down');

    console.log('\n-- §3 nothing readable: the load fails, and says so with the card down (#415) --');
    const r3 = await page.evaluate(() => window.__load('allbad', [
        ['cam1/cam1.analysis.h5', 'garbageBig'], ['cam2/cam2.slp', 'garbage']]));
    console.log('  ' + JSON.stringify(r3).slice(0, 400));
    check(/^Failed to load annotations \(lazy\)/.test(r3.status), `the failure is in the status line (got "${r3.status}")`);
    check(!r3.cardVisible, 'and the loading card does not come back over it');

    check(pageErrs.length === 0, `no uncaught page errors (got ${JSON.stringify(pageErrs.slice(0, 2))})`);
    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
