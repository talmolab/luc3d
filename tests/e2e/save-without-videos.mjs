/**
 * save-without-videos.mjs — a project saved with its videos not loaded keeps what the file
 * says about them. It used to write 0 frames, size 0 × 0 and `<camera>.mp4`, which then
 * stopped sleap-app leaving frame 0, and lost the path to the video for good.
 *
 * Each route: opens a file whose videos are not there, saves it, and reads the videos back
 * through sleap-io. A project with its videos loaded keeps theirs, frame count included.
 *
 * Run: node tests/e2e/save-without-videos.mjs
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const server = await startServer(repoRoot);
const PORT = server.port;

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (!c && extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 700) : ''));
    if (!c) fails++;
};


let browser;
try {
    browser = await launchBrowser({ headless: true });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm && window.__lucid, null, { timeout: 120000 });

    await page.evaluate(async () => {
        const SIO = window.SleapIO;
        const pd = await import('/pose/pose-data.js');
        const fileio = await import('/import-export/file-io.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const nodeNames = ['a', 'b'];
        const camNames = ['top', 'side'];
        const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
        const cameras = camNames.map((n, i) => new Camera(n, M, [0, 0, 0, 0, 0], [0, i * 0.3, 0], [i * 10, 0, 0], [512, 512]));
        const skeleton = new Skeleton('skeleton', nodeNames, [[0, 1]]);
        const session = new Session(cameras, skeleton, ['t'], 'Videos');
        session.identities = [new pd.Identity(0, 'id_0')];
        for (let f = 0; f < 5; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            const g = new InstanceGroup(f + 1, 0);
            camNames.forEach((cn, ci) => {
                const inst = new Instance([[f + ci, 1], [f + ci + 1, 2]], 0, 'predicted', 0.9);
                fg.addInstance(cn, inst);
                g.addInstance(cn, inst);
            });
            session.instanceGroups.set(f, [g]);
        }
        const views = camNames.map((n, i) => ({ name: n, videoWidth: 1280 + i, videoHeight: 1024 + i }));
        const videoFiles = camNames.map((n, i) => ({ name: n, assignedCamera: n, videoPath: `rec/${n}/${n}.mp4`, frameCount: 600 + i }));
        window.__project = await SIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(session, views, videoFiles));

        // The same, with three-channel videos, as another tool's file might say.
        const typed = await SIO.readSlpStreaming(new File([window.__project], 'x.slp'), {
            openVideos: false, h5wasmUrl: new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href,
        });
        for (const v of typed.videos) {
            v.shape = [v.shape[0], v.shape[1], v.shape[2], 3];
            v.backendMetadata = Object.assign({}, v.backendMetadata, { shape: v.shape });
        }
        window.__rgb = await SIO.saveSlpToBytes(typed);

        // One camera's model output, for a per-camera folder.
        window.__plain = (cam) => {
            const sk = new SIO.Skeleton({ name: 'sk', nodes: nodeNames });
            const video = new SIO.Video({ filename: `/data/${cam}/predicted.mp4`, shape: [700, 200, 300, 1] });
            video.backendMetadata = { type: 'MediaVideo', shape: [700, 200, 300, 1], filename: `/data/${cam}/predicted.mp4` };
            const inst = new SIO.PredictedInstance({ points: [[1, 2], [3, 4]], skeleton: sk, track: null, score: 0.9 });
            return SIO.saveSlpToBytes(new SIO.Labels({
                skeletons: [sk], videos: [video],
                labeledFrames: [new SIO.LabeledFrame({ video, frameIdx: 3, instances: [inst] })],
            }));
        };

        // sleap-nn's output knows a video's frame count but not its size.
        window.__sizeUnknown = await (async () => {
            const sk = new SIO.Skeleton({ name: 'sk', nodes: nodeNames });
            const video = new SIO.Video({ filename: '/data/top.mp4', openBackend: false,
                backendMetadata: { type: 'MediaVideo', shape: [800, 0, 0, 1], filename: '/data/top.mp4' } });
            const inst = new SIO.PredictedInstance({ points: [[1, 2], [3, 4]], skeleton: sk, track: null, score: 0.9 });
            return SIO.saveSlpToBytes(new SIO.Labels({
                skeletons: [sk], videos: [video],
                labeledFrames: [new SIO.LabeledFrame({ video, frameIdx: 3, instances: [inst] })],
            }));
        })();
        window.__rawVideos = async (bytes) => {
            const h5 = await import('h5wasm');
            const m = await h5.ready;
            const p = '/tmp/__videos_' + Math.random().toString(16).slice(2) + '.slp';
            m.FS.writeFile(p, bytes);
            const f = new h5.File(p, 'r');
            try { return f.get('videos_json').value.map((v) => JSON.parse(v).backend.shape); }
            finally { f.close(); m.FS.unlink(p); }
        };

        window.__videosOf = async (bytes) => {
            const labels = await SIO.readSlpStreaming(new File([bytes], 'x.slp'), {
                openVideos: false, h5wasmUrl: new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href,
            });
            return labels.videos.map((v) => [v.filename, v.shape]);
        };
        window.__saveEager = async (withViews) => {
            const AS = await import('/ui/app-state.js');
            window.__saved = await SIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(AS.state.session,
                withViews ? views : AS.state.views, withViews ? videoFiles : AS.state.videoFiles));
        };
        window.__saveLazy = async () => {
            const saveLoad = await import('/import-export/save-load.js');
            const AS = await import('/ui/app-state.js');
            window.__saved = await saveLoad.saveAllSessionsStreaming(AS.state.sessions);
        };
    });

    async function waitLoad() {
        for (let i = 0; i < 400; i++) {
            const s = await page.evaluate(() => {
                const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || ''));
                if (b) b.click();
                return { done: window.__loadDone, prompt: !!document.getElementById('videoSelectOverlay') };
            });
            if (s.prompt) await page.keyboard.press('Escape');
            if (s.done) return s.done;
            await page.waitForTimeout(100);
        }
        return 'timeout';
    }
    const loadSlp = async (g) => {
        await page.evaluate(async (g) => {
            const imp = await import('/import-export/slp-import.js');
            window.__loadDone = false;
            imp.handleLoadSlpFile(new File([window[g]], 'in.slp'))
                .then(() => { window.__loadDone = true; }, (e) => { window.__loadDone = 'ERR ' + (e && e.stack || e); });
        }, g);
        return waitLoad();
    };
    const loadLazy = async (g) => {
        await page.evaluate((g) => {
            window.__loadDone = false;
            (async () => {
                try {
                    const sl = await import('/loading/session-loader.js');
                    await sl.handleLoadProjectSlpLazy(new File([window[g]], 'in.slp'));
                    window.__loadDone = true;
                } catch (e) { window.__loadDone = 'ERR ' + String(e && e.stack || e).slice(0, 500); }
            })();
        }, g);
        return waitLoad();
    };
    const savedVideos = async (fn) => {
        await page.evaluate(fn);
        return page.evaluate(() => window.__videosOf(window.__saved));
    };
    const eq = (a, b, m) => check(JSON.stringify(a) === JSON.stringify(b), m, { got: a, want: b });

    console.log('\n-- a project saved with its videos loaded --');
    const fresh = await page.evaluate(() => window.__videosOf(window.__project));
    const WANT = [['rec/top/top.mp4', [600, 1024, 1280, 1]], ['rec/side/side.mp4', [601, 1025, 1281, 1]]];
    eq(fresh, WANT, "keeps each video's path, size and frame count");

    console.log('\n-- Load SLP, no video, save --');
    check((await loadSlp('__project')) === true, 'loads');
    eq(await savedVideos(() => window.__saveEager(false)), WANT, 'the file says what it said');
    console.log('\n-- ... and again --');
    await page.evaluate(() => { window.__again = window.__saved; });
    check((await loadSlp('__again')) === true, 'loads');
    eq(await savedVideos(() => window.__saveEager(false)), WANT, 'still');

    console.log('\n-- Lazy reopen, no video, save --');
    check((await loadLazy('__project')) === true, 'loads');
    eq(await savedVideos(() => window.__saveLazy()), WANT, 'the file says what it said');

    console.log('\n-- Load SLP, then its videos, save --');
    check((await loadSlp('__project')) === true, 'loads');
    eq(await savedVideos(() => window.__saveEager(true)), WANT, "the loaded videos' own values win");

    console.log('\n-- A three-channel video, no video loaded --');
    check((await loadSlp('__rgb')) === true, 'loads');
    const rgb = await savedVideos(() => window.__saveEager(false));
    eq(rgb.map((v) => v[1][3]), [3, 3], 'keeps its channels');

    console.log('\n-- A file that knows the frame count but not the size --');
    check((await loadSlp('__sizeUnknown')) === true, 'loads');
    await page.evaluate(() => window.__saveEager(false));
    eq(await page.evaluate(() => window.__rawVideos(window.__saved)), [[800, 0, 0, 1]], 'keeps its frame count');

    console.log('\n-- Per-camera folder, videos deferred --');
    const folder = await page.evaluate(async () => {
        const loader = await import('/loading/session-loader.js');
        const AS = await import('/ui/app-state.js');
        AS.state.sessions = []; AS.state.activeSessionIdx = 0;
        AS.state.videoFiles = []; AS.state.session = null; AS.state.views = [];
        const named = (f, rel) => { Object.defineProperty(f, 'webkitRelativePath', { value: rel }); return f; };
        const toml = ['top', 'side'].map((name, i) => `[cam_${i}]\nname = "${name}"\nsize = [ 64, 64,]\nmatrix = [ [ 900.0, 0.0, 32.0,], [ 0.0, 900.0, 32.0,], [ 0.0, 0.0, 1.0,],]\ndistortions = [ 0.0, 0.0, 0.0, 0.0, 0.0,]\nrotation = [ 0.0, ${i * 0.3}, 0.0,]\ntranslation = [ ${i * 10}.0, 0.0, 0.0,]\n`).join('');
        const files = [named(new File([toml], 'calibration.toml'), 'sess/calibration.toml')];
        for (const cam of ['top', 'side']) {
            files.push(named(new File([await window.__plain(cam)], 'labels.slp'), `sess/${cam}/labels.slp`));
            files.push(named(new File([new Uint8Array(16)], `${cam}.mp4`, { type: 'video/mp4' }), `sess/${cam}/${cam}.mp4`));
        }
        await loader.handleLoadSessionFolderPerCamera(files, true);
        await window.__saveEager(false);
        return window.__videosOf(window.__saved);
    });
    eq(folder.map((v) => v[1]), [[700, 200, 300, 1], [700, 200, 300, 1]], "the size and frame count are its file's");

    check(errs.length === 0, 'no page errors', errs);
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
