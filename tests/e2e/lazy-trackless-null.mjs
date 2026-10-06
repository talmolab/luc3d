/**
 * lazy-trackless-null.mjs — an instance with NO track must carry the same
 * in-memory trackIdx whether it was loaded eagerly or hydrated from a lazy
 * loader: `null`, the app-wide sentinel (`resolveImportTrackIdx`).
 *
 * Both lazy loaders hand over the columnar store's trackless value, `-1`, and
 * the four hydration paths in `pose/triangulation.js` — `ensureLazyFrameData`,
 * `hydrateLazyCameras`, `buildLazyFrameGroupSync` and `batchLoadLazyFrames`
 * (sync branch for `SioLazyLoader`, worker branch for `LazyFrameLoader`) —
 * passed it straight into `new Instance`. Everything that reads a trackIdx
 * tests `trackIdx == null` for "no track", so a lazily hydrated trackless
 * instance was treated as tracked:
 *   - `getInstanceColor` drew it in the palette's LAST track colour
 *     (`getTrackColor(-1)` wraps) instead of the ungrouped colour;
 *   - `getInstanceLabelName` gave it a "Track -1" pill where an eager one
 *     gets none;
 *   - both skipped the identity an ungrouped trackless instance retains
 *     (luc3d #201), so it lost its animal's colour and name.
 *
 * This hydrates the same trackless prediction through every one of those
 * paths, asserts `trackIdx === null` (and that a tracked neighbour keeps its
 * index), then checks colour, label and the retained identity against an
 * eagerly built trackless instance. Confirmed to fail on the pre-fix build.
 *
 * Run: node tests/e2e/lazy-trackless-null.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8277);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 30000 });

    const r = await page.evaluate(async () => {
        const tri = await import('/pose/triangulation.js');
        const pd = await import('/pose/pose-data.js');
        const ov = await import('/ui/overlays.js');
        const AS = await import('/ui/app-state.js');
        const { SioLazyLoader } = await import('/loading/sio-lazy-loader.js');
        const SIO = window.SleapIO;
        const { Session, Skeleton, Camera, Instance, FrameGroup, UnlinkedInstance } = pd;

        const CAMS = ['camA', 'camB'], NF = 5, NODES = ['nose', 'tail'];
        const TRACKED_X = f => 10 + f, TRACKLESS_X = f => 900 + f;
        async function cameraFile(cam) {
            const skeleton = new SIO.Skeleton({ name: 'sk', nodes: NODES });
            const video = new SIO.Video({ filename: cam + '.mp4', shape: [NF, 64, 64, 1] });
            const track = new SIO.Track('tA');
            const lfs = [];
            for (let f = 0; f < NF; f++) lfs.push(new SIO.LabeledFrame({ video, frameIdx: f, instances: [
                new SIO.PredictedInstance({ points: [[TRACKED_X(f), 1], [TRACKED_X(f) + 1, 2]], skeleton, track, score: 0.9 }),
                new SIO.PredictedInstance({ points: [[TRACKLESS_X(f), 1], [TRACKLESS_X(f) + 1, 2]], skeleton, track: null, score: 0.9 }),
            ] }));
            return new File([await SIO.saveSlpToBytes(new SIO.Labels({ skeletons: [skeleton], videos: [video], tracks: [track], labeledFrames: lfs }))], cam + '.slp');
        }
        const mtx = [[600, 0, 32], [0, 600, 32], [0, 0, 1]];
        const cameras = CAMS.map((c, i) => new Camera(c, mtx, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [10 * i, 0, 0], [64, 64]));

        /** Every instance of `cam` at frame `f`, linked or unlinked, as {x, trackIdx, inst}. */
        function instancesAt(session, f, cam) {
            const fg = session.getFrameGroup(f);
            if (!fg) return [];
            const out = (fg.instances.get(cam) || []).slice();
            for (const u of (fg.getUnlinkedInstances(cam) || [])) if (u && u.instance) out.push(u.instance);
            return out.map(inst => ({ x: inst.getX(0), trackIdx: inst.trackIdx, inst }));
        }
        function summarize(session, f, cams) {
            const rows = [];
            for (const cam of cams) for (const i of instancesAt(session, f, cam)) rows.push({ cam, x: i.x, trackIdx: i.trackIdx });
            return rows;
        }

        // ---- SioLazyLoader: the four hydration paths -------------------------
        const loader = new SioLazyLoader();
        for (const cam of CAMS) await loader.open(cam, await cameraFile(cam));
        const session = new Session(cameras, new Skeleton('sk', NODES, [[0, 1]]), loader.trackNames.slice(), 'S');
        session.lazyLoader = loader;
        AS.state.sessions = [session]; AS.state.session = session; AS.state.activeSessionIdx = 0;

        const paths = {};
        await tri.ensureLazyFrameData(0);
        paths.ensureLazyFrameData = summarize(session, 0, CAMS);
        tri.buildLazyFrameGroupSync(1);
        paths.buildLazyFrameGroupSync = summarize(session, 1, CAMS);
        await tri.batchLoadLazyFrames(2, 1);
        paths['batchLoadLazyFrames (sync)'] = summarize(session, 2, CAMS);
        // hydrateLazyCameras: frame 3 already exists holding camA (as an eager
        // parse would leave it), so only camB is hydrated from the loader.
        {
            const fg = new FrameGroup(3);
            const eagerA = new Instance([[TRACKED_X(3), 1], [TRACKED_X(3) + 1, 2]], 0, 'predicted', 0.9);
            fg.addUnlinkedInstance('camA', new UnlinkedInstance(eagerA, 'camA'));
            session.addFrameGroup(fg);
            await tri.ensureLazyFrameData(3);
            paths.hydrateLazyCameras = summarize(session, 3, ['camB']);
        }

        // ---- LazyFrameLoader: batchLoadLazyFrames' worker branch -------------
        {
            const RealWorker = window.Worker;
            const workers = [];
            window.Worker = function FakeWorker() { this.posted = []; workers.push(this); };
            window.Worker.prototype.postMessage = function (m) { this.posted.push(m); };
            window.Worker.prototype.terminate = function () {};
            try {
                const h5 = new tri.LazyFrameLoader();
                const opens = CAMS.map(cam => h5.open(cam, { name: cam + '.h5' }));
                workers.forEach((w, i) => w.onmessage({ data: { type: 'metadata', data: {
                    skeleton: { name: 'sk', nodes: NODES, edges: [] }, trackNames: ['tA'], nTracks: 1,
                    nFrames: NF, nNodes: 2, videos: [{ filename: CAMS[i] + '.mp4' }],
                } } }));
                await Promise.all(opens);
                const s2 = new Session(cameras, new Skeleton('sk', NODES, [[0, 1]]), h5.trackNames.slice(), 'S2');
                s2.lazyLoader = h5;
                AS.state.sessions = [s2]; AS.state.session = s2;
                const pending = tri.batchLoadLazyFrames(0, 1);
                for (const w of workers) {
                    const req = w.posted.filter(m => m.type === 'getFrames').pop();
                    w.onmessage({ data: { type: 'framesData', requestId: req.requestId, frames: [{ frameIdx: 0, instances: [
                        { trackIdx: 0, type: 'predicted', score: 0.9, points: [[TRACKED_X(0), 1], [TRACKED_X(0) + 1, 2]] },
                        { trackIdx: -1, type: 'predicted', score: 0.9, points: [[TRACKLESS_X(0), 1], [TRACKLESS_X(0) + 1, 2]] },
                    ] }] } });
                }
                await pending;
                paths['batchLoadLazyFrames (worker)'] = summarize(s2, 0, CAMS);
            } finally {
                window.Worker = RealWorker;
                AS.state.sessions = [session]; AS.state.session = session;
            }
        }

        // ---- what the overlays make of it ------------------------------------
        const lazyTrackless = instancesAt(session, 0, 'camA').find(i => i.x === TRACKLESS_X(0)).inst;
        const eagerTrackless = new Instance([[TRACKLESS_X(0), 1], [TRACKLESS_X(0) + 1, 2]], null, 'predicted', 0.9);
        const overlay = {
            lazyColor: ov.getInstanceColor(lazyTrackless, session, 'camA', false, 0),
            eagerColor: ov.getInstanceColor(eagerTrackless, session, 'camA', false, 0),
            ungrouped: ov.UNGROUPED_USER_COLOR,
            lastTrackColor: ov.getTrackColor(-1),
            lazyLabel: ov.getInstanceLabelName(lazyTrackless, session, 'camA', false, 0),
            eagerLabel: ov.getInstanceLabelName(eagerTrackless, session, 'camA', false, 0),
        };
        // luc3d #201: an ungrouped trackless instance keeps its animal's identity.
        const mouse = session.addIdentity('mouse', '#123456');
        lazyTrackless.identityId = mouse.id;
        eagerTrackless.identityId = mouse.id;
        overlay.lazyIdColor = ov.getInstanceColor(lazyTrackless, session, 'camA', true, 0);
        overlay.eagerIdColor = ov.getInstanceColor(eagerTrackless, session, 'camA', true, 0);
        overlay.lazyIdLabel = ov.getInstanceLabelName(lazyTrackless, session, 'camA', true, 0);

        return { paths, overlay, TRACKLESS: [0, 1, 2, 3].map(TRACKLESS_X), TRACKED: [0, 1, 2, 3].map(TRACKED_X) };
    });

    for (const [name, rows] of Object.entries(r.paths)) {
        const trackless = rows.filter(x => x.x >= 900);
        const tracked = rows.filter(x => x.x < 900);
        check(trackless.length > 0 && trackless.every(x => x.trackIdx === null),
            `${name}: the trackless prediction is trackIdx null (got ${JSON.stringify(trackless.map(x => x.cam + ':' + x.trackIdx))})`);
        check(tracked.length > 0 && tracked.every(x => x.trackIdx === 0),
            `${name}: its tracked neighbour keeps trackIdx 0 (got ${JSON.stringify(tracked.map(x => x.cam + ':' + x.trackIdx))})`);
    }

    const o = r.overlay;
    check(o.lazyColor === o.ungrouped && o.eagerColor === o.ungrouped,
        `colour: lazy and eager trackless both draw ungrouped ${o.ungrouped} (lazy ${o.lazyColor}, eager ${o.eagerColor}; the last track colour is ${o.lastTrackColor})`);
    check(o.lazyLabel === null && o.eagerLabel === null,
        `label: no track pill for either (lazy ${JSON.stringify(o.lazyLabel)}, eager ${JSON.stringify(o.eagerLabel)})`);
    check(o.lazyIdColor === '#123456' && o.eagerIdColor === '#123456' && o.lazyIdLabel === 'mouse',
        `retained identity (#201): the lazy instance shows its animal's colour and name like the eager one ` +
        `(lazy ${o.lazyIdColor} / ${JSON.stringify(o.lazyIdLabel)}, eager ${o.eagerIdColor})`);
    check(errs.length === 0, `no page/console errors (got ${JSON.stringify(errs.slice(0, 3))})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
