/**
 * lazy-playback-eviction.mjs — a frame the playback eviction drops comes back
 * EXACTLY as it was, through the real store and the real hydration path.
 *
 * pose/lazy-residency.js decides a resident frame is safe to drop by comparing
 * it with `SioLazyLoader.describeStoreFrame`, a column read that is meant to
 * agree with what `_extractCamFrame` materializes through sleap-io.js. The
 * Node test (tests/test-lazy-residency.mjs) pins the predicate against a
 * hand-built store; this pins the two things only a real browser can:
 *
 *  1. `describeStoreFrame` agrees with the REAL materializer (`labels.frameAt`
 *     + `adaptTypedInstance`) for every camera-frame — including trackless
 *     rows, a user row, a camera with gaps, and a camera whose own track list
 *     was re-indexed into the session union (`_unifyTracks`).
 *  2. Evict -> re-hydrate through `batchLoadLazyFrames` /
 *     `finalizeLazyFrameGroup` rebuilds every evicted frame identically:
 *     same rows, same seating, group members as the SAME objects, unlinked
 *     instances with the same track, type, score, points and occlusion.
 *     Frames edited in the four ways that must pin them are NOT evicted, and
 *     the pass reports each under its own reason.
 *
 * Run: node tests/e2e/lazy-playback-eviction.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8291);
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined && !c ? '  ' + JSON.stringify(extra).slice(0, 600) : ''));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 60000 });

    const r = await page.evaluate(async () => {
        const { SioLazyLoader } = await import('/loading/sio-lazy-loader.js');
        const tri = await import('/pose/triangulation.js');
        const residency = await import('/pose/lazy-residency.js');
        const { Session, Instance, UnlinkedInstance } = await import('/pose/pose-data.js');
        const st = window.__lucid.state;
        const SIO = window.SleapIO;

        // ---- per-camera .slp fixtures ---------------------------------------
        // Frames past the residency cap, so the real wrapper's cap check fires.
        const NF = residency.LAZY_RESIDENT_CAP + 900;
        const CAMS = ['camA', 'camB', 'camC'];
        // camC lists its tracks in a different order, so `_unifyTracks`
        // rewrites its track column into the session list.
        const OWN = { camA: ['t0', 't1', 't2'], camB: ['t0', 't1', 't2'], camC: ['t2', 't0', 't1'] };
        const NODES = ['nose', 'mid', 'tail'];
        const USER_FRAME = 13;
        async function slpBytes(cam) {
            const skeleton = new SIO.Skeleton({ name: 'sk', nodes: NODES });
            const video = new SIO.Video({ filename: cam + '.mp4', shape: [NF, 64, 64, 1] });
            const tracks = OWN[cam].map(n => new SIO.Track(n));
            const byName = new Map(tracks.map(t => [t.name, t]));
            const lfs = [];
            for (let f = 0; f < NF; f++) {
                if (cam === 'camB' && f % 50 === 7) continue;        // gaps: no row at all
                const insts = [];
                for (const name of ['t' + (f % 3), 't' + ((f + 1) % 3)]) {
                    const k = Number(name[1]);
                    const pts = NODES.map((_, n) => [10 + f * 0.25 + k * 20 + n, 5 + k * 7 + n * 1.5]);
                    if (f % 11 === 0) pts[1] = [NaN, NaN];              // a missing node
                    insts.push(new SIO.PredictedInstance({ points: pts, skeleton, track: byName.get(name), score: 0.5 + k / 10 }));
                }
                if (f % 7 === 0) {                                     // a trackless prediction
                    insts.push(new SIO.PredictedInstance({
                        points: NODES.map((_, n) => [300 + n, 300 + f * 0.1]), skeleton, track: null, score: 0.3 }));
                }
                if (cam === 'camA' && f === USER_FRAME) {              // a user row in the store
                    insts.push(new SIO.Instance({ points: NODES.map((_, n) => [200 + n, 200]), skeleton, track: byName.get('t1') }));
                }
                lfs.push(new SIO.LabeledFrame({ video, frameIdx: f, instances: insts }));
            }
            return SIO.saveSlpToBytes(new SIO.Labels({ skeletons: [skeleton], videos: [video], tracks, labeledFrames: lfs }));
        }
        const loader = new SioLazyLoader();
        const files = {};
        for (const cam of CAMS) files[cam] = new File([await slpBytes(cam)], cam + '.slp');
        // In parallel, as the folder loader opens them.
        await Promise.all(CAMS.map(cam => loader.open(cam, files[cam])));

        // ---- 1. describeStoreFrame vs the real materializer ------------------
        const mism = [];
        let rows = 0;
        for (const cam of CAMS) {
            for (let f = 0; f < NF; f++) {
                const real = loader._extractCamFrame(cam, f);
                const d = loader.describeStoreFrame(cam, f);
                rows += real.length;
                if (!d || d.count !== real.length) { mism.push({ cam, f, count: d && d.count, real: real.length }); continue; }
                for (let k = 0; k < real.length; k++) {
                    const wantTrack = real[k].trackIdx;            // -1 = trackless, as the store speaks it
                    const wantPred = real[k].type === 'predicted' ? 1 : 0;
                    if (d.trackIdx[k] !== wantTrack || d.predicted[k] !== wantPred) {
                        mism.push({ cam, f, k, track: [d.trackIdx[k], wantTrack], pred: [d.predicted[k], wantPred] });
                    }
                }
            }
        }
        const camCRemapped = loader.trackNames.join(',') !== OWN.camC.join(',');

        // ---- 2. a lazy session, hydrated everywhere, some frames grouped -----
        const session = new Session([], { name: 'sk', nodes: NODES, edges: [] }, loader.trackNames.slice(), 'evict');
        session.lazyLoader = loader;
        st.sessions = [session];
        st.session = session;
        st.currentFrame = 0;
        st.triangulationResults = new Map();
        await tri.batchLoadLazyFrames(0, NF);                          // never evicts (sweep path)
        const hydrated = session.frameGroups.size;
        // Group track t0 across the cameras on every 5th frame, as Track All would.
        let grouped = 0;
        for (let f = 0; f < NF; f += 5) {
            const fg = session.frameGroups.get(f);
            const t0 = loader.trackNames.indexOf('t0');
            const pick = [];
            for (const cam of CAMS) {
                const ul = fg.getUnlinkedInstances(cam).find(u => u.instance.trackIdx === t0);
                if (ul) pick.push(ul);
            }
            if (pick.length >= 2) { session.createGroupFromUnlinked(f, pick, -1); grouped++; }
        }

        // Shape of a frame: everything re-hydration must reproduce.
        const ids = new WeakMap(); let nextId = 1;
        const oid = (o) => { if (!ids.has(o)) ids.set(o, nextId++); return ids.get(o); };
        const shape = (fg) => CAMS.map(cam => {
            const lk = fg.getInstances(cam).map(i => 'L' + i._rawInstIndex + '#' + oid(i));
            const ul = fg.getUnlinkedInstances(cam).map(u => {
                const i = u.instance;
                return ['U' + i._rawInstIndex, i.trackIdx, i.type, i.score,
                    i.toPointsArray().map(p => p ? p.join(':') : '-').join(' '),
                    i.toOccludedArray().map(Number).join('')].join('/');
            });
            return cam + '{' + lk.concat(ul).sort().join(',') + '}';
        }).join(' ');
        const before = new Map();
        for (const [f, fg] of session.frameGroups) before.set(f, shape(fg));

        // ---- edits that must PIN their frame -------------------------------
        const PIN = { user: 400, count: 401, track: 402, identity: 403 };
        const ulOf = (f, cam = 'camA') => session.frameGroups.get(f).getUnlinkedInstances(cam)[0];
        ulOf(PIN.user).instance.type = 'user';
        session.frameGroups.get(PIN.count).removeUnlinkedById(ulOf(PIN.count).id);
        ulOf(PIN.track).instance.trackIdx = (ulOf(PIN.track).instance.trackIdx + 1) % 3;
        const tl = session.frameGroups.get(PIN.identity).getUnlinkedInstances('camA').find(u => u.instance.trackIdx == null)
            || ulOf(PIN.identity);
        tl.instance.identityId = 2;
        const pinnedShape = {};
        for (const k in PIN) pinnedShape[k] = shape(session.frameGroups.get(PIN[k]));

        // A reprojection cache on a frame that will be evicted, and one that will not.
        const g0 = session.instanceGroups.get(0)[0];
        g0.reprojections = { camA: [[1, 2]] };
        st.triangulationResults.set(0, [{ group: g0 }]);
        const KEEP_F = (NF - 1) - ((NF - 1) % 5);                     // the last grouped frame
        const gKeep = session.instanceGroups.get(KEEP_F)[0];
        gKeep.reprojections = { camA: [[1, 2]] };
        st.triangulationResults.set(KEEP_F, [{ group: gKeep }]);

        // ---- evict through the real wrapper, the way the playback loader does
        st.currentFrame = NF - 1;
        const pass = tri.evictLazyFrames(NF - 1);
        const afterEvict = session.frameGroups.size;
        const stillPinned = Object.fromEntries(Object.entries(PIN).map(([k, f]) => [k, session.frameGroups.has(f)]));
        const reproj = { evictedDropped: g0.reprojections === null && !st.triangulationResults.has(0),
                         keptKept: !!gKeep.reprojections && st.triangulationResults.has(KEEP_F) };

        // ---- re-hydrate and compare --------------------------------------------
        await tri.batchLoadLazyFrames(0, NF);
        const diffs = [];
        for (const [f, s0] of before) {
            if (Object.values(PIN).includes(f)) continue;
            const s1 = shape(session.frameGroups.get(f));
            if (s1 !== s0) diffs.push({ f, before: s0.slice(0, 300), after: s1.slice(0, 300) });
        }
        const pinsIntact = Object.entries(PIN).every(([k, f]) => shape(session.frameGroups.get(f)) === pinnedShape[k]);
        // The comparator must be able to fail: neighbouring frames differ.
        const sensitive = before.get(1) !== before.get(2) && before.get(0) !== before.get(5);

        return {
            NF, rows, mism: mism.slice(0, 5), mismCount: mism.length, camCRemapped, trackNames: loader.trackNames,
            hydrated, grouped, pass, afterEvict, stillPinned, reproj,
            diffs: diffs.slice(0, 3), diffCount: diffs.length, pinsIntact, sensitive,
            userFrameKept: session.frameGroups.has(USER_FRAME),
        };
    });

    console.log(`fixture: ${r.NF} frames x 3 cameras, ${r.rows} store rows; session tracks ${JSON.stringify(r.trackNames)}`);
    console.log('pass:', JSON.stringify(r.pass));
    check(r.camCRemapped, 'precondition: camC\'s own track order differs from the session list (its column was re-indexed)');
    check(r.mismCount === 0, `describeStoreFrame agrees with the real materializer on all ${r.rows} rows`, r.mism);
    check(r.hydrated === r.NF && r.grouped > 100, `precondition: all ${r.NF} frames hydrated, ${r.grouped} grouped`);
    check(!!r.pass && r.pass.evicted > 0, 'the real wrapper ran a pass over the cap and evicted frames', r.pass);
    check(r.pass && r.pass.blocked.user === 2, 'blocked as "user": the edited frame and the store user row\'s frame', r.pass && r.pass.blocked);
    check(r.pass && r.pass.blocked.count === 1, 'blocked as "count": the deleted prediction', r.pass && r.pass.blocked);
    check(r.pass && r.pass.blocked.track === 1, 'blocked as "track": the in-memory track change', r.pass && r.pass.blocked);
    check(r.pass && r.pass.blocked.identity === 1, 'blocked as "identity": the trackless instance\'s identity', r.pass && r.pass.blocked);
    check(r.pass && Object.keys(r.pass.blocked).length === 4, 'nothing else was blocked (an unedited frame is always rebuildable)', r.pass && r.pass.blocked);
    check(Object.values(r.stillPinned).every(Boolean) && r.userFrameKept, 'every pinned frame is still resident', r.stillPinned);
    check(r.afterEvict === r.pass.resident && r.afterEvict < r.NF / 3, `resident dropped to the protected window (${r.afterEvict})`);
    check(r.reproj.evictedDropped, 'an evicted frame\'s reprojection caches were dropped');
    check(r.reproj.keptKept, 'a protected frame\'s reprojection caches were kept');
    check(r.sensitive, 'the frame comparator distinguishes different frames (so the next check can fail)');
    check(r.diffCount === 0, 'every evicted frame re-hydrated IDENTICALLY (rows, seating, member identity, track, type, score, points, occlusion)', r.diffs);
    check(r.pinsIntact, 'the four pinned frames kept their edits');
    check(errs.length === 0, 'no page errors', errs);
} catch (e) {
    console.error('FATAL', e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
