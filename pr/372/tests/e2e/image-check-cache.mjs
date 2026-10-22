/**
 * image-check-cache.mjs — the image ID-switch check's embedding cache
 * (ui/image-embedder.js over pose/embedding-cache.js): a repeat run reuses the
 * vectors of crops cut identically before, and changes nothing about the result.
 *
 * The real embedder runs — crop geometry, keyframe-snapped decode planning,
 * streaming readers, crop workers, batching — over camera "videos" that render
 * each frame (a frame-dependent background plus every animal's body hull in its
 * own grey), streamed through a fake mediabunny backend (`samplesAtTimestamps`)
 * whose requests are recorded. Only the model is replaced (`opts.model`): a
 * fixed random projection of the input tensor, so any pixel difference in a crop
 * changes its vector — a cache key that missed one of the crop's inputs would
 * show up as a vector that differs from a fresh run's. Keyframes every 32 frames,
 * offset from the samples, so samples decode a nearby keyframe (`atFrames`).
 * Asserted:
 *  1. With the cache on, the first run equals a run with it off (same flags and
 *     scores, every vector bit for bit).
 *  2. A second run takes every crop from the cache: no model run, no frame
 *     streamed or fetched — and the same flags, scores and vectors.
 *  3. Negative control: one animal's 2D keypoint moved in one camera on one
 *     decoded frame. The next run re-embeds exactly the crops whose geometry or
 *     masks changed (that animal's, and its neighbours' in that view whose crops
 *     its hull reaches), decodes only that frame in only that camera, and equals a
 *     run with the cache off on the edited session.
 *  4. Changing the videos (a new decoder) empties the session's cache.
 *  5. The key leaves out masked hulls that cannot reach the crop square
 *     (`hullsReachingCrop`), so a neighbour moving far away does not invalidate a
 *     crop: cutting with only those hulls gives the very same pixels.
 *
 * Run: node tests/e2e/image-check-cache.mjs   (PORT=… to pick the server port)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8291);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 300)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js'), AS = await import('/ui/app-state.js');
        const E = await import('/ui/image-embedder.js'), SC = await import('/pose/id-switch-check.js');
        // ---- a tracked session with 2D: 3 animals, 3 cameras, one pair's labels swapped after encounter #16
        const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
            'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
        const TEMPLATE = { Nose: [45, 0, 0], Ear_R: [25, -11, 4], Ear_L: [25, 11, 4], Head: [30, 0, 3], Neck: [20, 0, 2],
            Trunk: [-5, 0, 4], TTI: [-40, 0, 0], Shoulder_left: [10, 12, 0], Shoulder_right: [10, -12, 0],
            Haunch_left: [-25, 15, 0], Haunch_right: [-25, -15, 0], Tail_0: [-65, 0, 0], Tail_1: [-88, 0, 0],
            Tail_2: [-110, 0, 0], TailTip: [-132, 0, 0] };
        const CAMS = ['camA', 'camB', 'camC'], STEP = 4, SWAP = 16, FPS = 60;
        const pose = (cx, cy, h) => { const out = new Float64Array(45), c = Math.cos(h), s = Math.sin(h);
            NODES.forEach((n, i) => { const [x, y, z] = TEMPLATE[n]; out[i * 3] = cx + c * x - s * y; out[i * 3 + 1] = cy + s * x + c * y; out[i * 3 + 2] = z; }); return out; };
        const inst = (P, ci) => { const pts = []; for (let i = 0; i < NODES.length; i++) pts.push([130 + 12 * ci + 0.8 * P[i * 3], 130 + 8 * ci + 0.8 * P[i * 3 + 1]]);
            return { getPoint: (i) => pts[i] }; };
        const home = [[0, 0], [400, 0], [200, 350]], PAIRS = [[0, 1], [1, 2], [0, 2]];
        const events = []; for (let e = 0; e < 24; e++) events.push({ pair: PAIRS[e % 3], t0: 300 + e * 260 });
        const T = 300 + 24 * 260 + 300;
        const session = new pd.Session([], new pd.Skeleton('m', NODES, []), [], 'CacheFixture');
        for (let i = 0; i < 3; i++) session.addIdentity('id_' + i);
        let gid = 1; const label = [0, 1, 2];
        for (let t = 0; t < T; t++) {
            const pos = home.map(h => [h[0] + 15 * Math.sin(t / 37 + h[0]), h[1] + 15 * Math.cos(t / 41 + h[1])]);
            for (const ev of events) { const d = t - ev.t0; if (d < 0 || d > 100) continue;
                const [a, b] = ev.pair, mid = [(home[a][0] + home[b][0]) / 2, (home[a][1] + home[b][1]) / 2];
                const f = d < 40 ? d / 40 : d <= 60 ? 1 : 1 - (d - 60) / 40;
                for (const [k, side] of [[a, -1], [b, 1]]) pos[k] = [home[k][0] + f * (mid[0] + side * 10 - home[k][0]), home[k][1] + f * (mid[1] - home[k][1])]; }
            session.instanceGroups.set(t * STEP, [0, 1, 2].map(k => { const g = new pd.InstanceGroup(gid++, session.identities[label[k]].id);
                g.points3d = pose(pos[k][0], pos[k][1], (t / 50 + k) % (2 * Math.PI)); g._animal = k; g._hulls = {};
                CAMS.forEach((c, ci) => g.instances.set(c, inst(g.points3d, ci))); return g; }));
            if (t === events[SWAP].t0 + 60) { const [a, b] = events[SWAP].pair; [label[a], label[b]] = [label[b], label[a]]; }
        }
        // ---- camera "videos": a frame-dependent background, each animal's body hull in its own grey (by ANIMAL, so the
        // swapped labels show), from the fixture's original 2D (editing a keypoint later does not change the video)
        const sk = E.skeletonIndex(NODES);
        const tex = new OffscreenCanvas(900, 700), tx = tex.getContext('2d');
        for (let i = 0; i < 900; i++) { tx.fillStyle = `hsl(${(i * 37) % 360},40%,${10 + (i * 13) % 50}%)`; tx.beginPath(); tx.arc((i * 97) % 900, (i * 53) % 700, 3 + (i % 17), 0, 7); tx.fill(); }
        const hullOf = (ins) => E.convexHull(sk.body.map(i => ins.getPoint(i)));
        const render = (cam, f) => {   // frames between grid samples show the previous sample's animals
            const cv = new OffscreenCanvas(640, 480), cx = cv.getContext('2d');
            cx.drawImage(tex, -((f * 7) % 250), -((f * 3) % 200));
            for (const g of session.instanceGroups.get(f - (f % STEP)) || []) {
                const h = g._hulls[cam] || (g._hulls[cam] = hullOf(g.instances.get(cam))); cx.fillStyle = `rgb(${70 + 70 * g._animal},${70 + 70 * g._animal},${70 + 70 * g._animal})`;
                cx.beginPath(); h.forEach((q, i) => i ? cx.lineTo(q[0], q[1]) : cx.moveTo(q[0], q[1])); cx.closePath(); cx.fill();
            }
            return cv;
        };
        const io = { streamed: {}, fetched: {} };
        const frameTimes = Float64Array.from({ length: T * STEP }, (v, i) => i / FPS);
        const makeDecoder = (cam) => ({
            getFrame: async (f) => { io.fetched[cam].push(f); return createImageBitmap(render(cam, f)); },
            _mbBackend: { _frameTimes: frameTimes, sink: { samplesAtTimestamps: (ts) => (async function* () {
                for (const t of ts) { const f = Math.round(t * FPS); io.streamed[cam].push(f);
                    const vf = new VideoFrame(render(cam, f), { timestamp: Math.round(t * 1e6) });
                    yield { toVideoFrame: () => vf.clone(), close: () => vf.close() }; }
            })() } },
        });
        AS.state.sessions = [session]; AS.state.activeSessionIdx = 0; AS.state.session = session;
        AS.state.totalFrames = T * STEP; AS.state.currentFrame = 0; AS.state.fps = FPS;
        AS.state.views = CAMS.map(c => ({ cameraName: c, decoder: makeDecoder(c) }));
        // ---- the model: a fixed random projection of the input (any changed pixel moves the vector), plus the crop's mean
        const SZ = 3 * E.INPUT * E.INPUT, D = 384, TAPS = 48;
        let seed = 99; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
        const idx = Int32Array.from({ length: D * TAPS }, () => Math.floor(rnd() * SZ)), w = Float32Array.from({ length: D * TAPS }, () => rnd() - 0.5);
        const model = { crops: 0 };
        const fakeModel = async (data, n) => {
            model.crops += n; const out = [];
            for (let c = 0; c < n; c++) {
                const off = c * SZ, v = new Float32Array(D);
                // the centre of the crop is the animal's body: its grey says which animal it is
                let m = 0; for (let y = 92; y < 132; y++) for (let x = 92; x < 132; x++) m += data[off + y * E.INPUT + x];
                for (let d = 0; d < 32; d++) v[d] = 3 * Math.cos((d + 1) * 0.9 * m / 1600);   // a non-linear map: three greys, three directions
                for (let d = 32; d < D; d++) { let s = 0; for (let j = 0; j < TAPS; j++) s += w[d * TAPS + j] * data[off + idx[d * TAPS + j]]; v[d] = s / 8; }
                out.push(v);
            }
            return out;
        };
        const KF = Int32Array.from({ length: Math.ceil(T * STEP / 32) }, (v, i) => 16 + 32 * i).filter(f => f < T * STEP);
        window.__fx = { session, CAMS, sk, E, SC, AS, makeDecoder, render };
        // one check through the real embedder; every returned vector recorded as frame|identity|camera
        window.__run = async (cache) => {
            CAMS.forEach(c => { io.streamed[c] = []; io.fetched[c] = []; }); model.crops = 0;
            const emb = await E.createImageEmbedder(session, { model: fakeModel, cache, maxViewsPerAnimal: 0, keyframes: () => KF });
            const vecs = new Map(), fresh = [];
            const res = await SC.checkImageSwitches(session, { fps: FPS, prepareFrames: emb.prepareFrames, inFlight: emb.inFlight, releaseFrames: emb.releaseFrames,
                getEmbeddings: async (frame, items) => { const out = await emb.getEmbeddings(frame, items);
                    out.forEach((l, ii) => l.forEach(e => { const k = frame + '|' + items[ii].group.identityId + '|' + e.camera; vecs.set(k, e.vector); if (!e.cached) fresh.push(k); }));
                    return out; } });
            return { res, vecs, fresh, stats: emb.stats(), modelCrops: model.crops, streamed: JSON.parse(JSON.stringify(io.streamed)), fetched: JSON.parse(JSON.stringify(io.fetched)) };
        };
        window.__same = (a, b) => {   // results and vectors: identical?
            const strip = (r) => JSON.stringify({ ok: r.ok, flags: r.flags, changes: r.changes, encounters: r.encounters, crops: r.crops, cameras: r.cameras });
            let vecDiff = 0, missing = 0;
            a.vecs.forEach((v, k) => { const u = b.vecs.get(k); if (!u) { missing++; return; }
                for (let i = 0; i < v.length; i++) if (!Object.is(v[i], u[i])) { vecDiff++; break; } });
            return { result: strip(a.res) === strip(b.res), vecDiff, missing, sizes: [a.vecs.size, b.vecs.size] };
        };
        E.clearEmbeddingCache();
    });

    // ---- 1. first run with the cache on = the cache off
    const r1 = await page.evaluate(async () => {
        const off = await window.__run(false);
        window.__off = off;
        const on = await window.__run(true);
        window.__on1 = on;
        const same = window.__same(off, on);
        return { same, crops: off.res.crops, flags: off.res.flags.length, enc: off.res.encounters.length, okRes: off.res.ok,
                 modelOff: off.modelCrops, modelOn: on.modelCrops, cachedOn: on.stats.cachedCrops,
                 streamedOff: Object.values(off.streamed).map(a => a.length), streamedOn: Object.values(on.streamed).map(a => a.length),
                 info: window.__fx.E.embeddingCacheInfo() };
    });
    console.log(`  (fixture: ${r1.crops} crops, ${r1.enc} contacts scored, ${r1.flags} flagged; frames streamed per camera ${r1.streamedOff.join('/')})`);
    check(r1.okRes && r1.enc > 10 && r1.crops > 3000, 'the check runs on the fixture and scores its contacts');
    check(r1.flags >= 1, `…and flags the swap (${r1.flags} flag(s)), so the comparisons below are not of empty results`);
    check(r1.same.result && r1.same.vecDiff === 0 && r1.same.missing === 0 && r1.same.sizes[0] === r1.same.sizes[1],
          `cache on, first run = cache off: same flags and scores, ${r1.same.sizes[0]} vectors bit for bit (${JSON.stringify(r1.same)})`);
    check(r1.modelOn === r1.modelOff && r1.cachedOn === 0 && r1.streamedOn.join() === r1.streamedOff.join(),
          `…embedding every crop (${r1.modelOn}) and streaming the same frames — nothing was cached yet`);
    check(r1.info.entries === r1.modelOn, `the cache now holds those ${r1.info.entries} vectors (${(r1.info.bytes / 1048576).toFixed(0)} MB pooled)`);

    // ---- 2. second run: all from the cache
    const r2 = await page.evaluate(async () => {
        const on = await window.__run(true);
        const same = window.__same(window.__off, on);
        return { same, model: on.modelCrops, cached: on.stats.cachedCrops, cachedFrames: on.stats.cachedFrames, frames: on.stats.frames,
                 streamed: Object.values(on.streamed).map(a => a.length), fetched: Object.values(on.fetched).map(a => a.length),
                 fresh: on.fresh.length, line: window.__fx.E.formatEmbedTiming(on.stats) };
    });
    check(r2.model === 0 && r2.fresh === 0 && r2.cached === r1.modelOff, `second run: no model run, all ${r2.cached} crops from the cache`);
    check(r2.streamed.every(n => n === 0) && r2.fetched.every(n => n === 0) && r2.cachedFrames === r2.frames,
          `…and no frame decoded in any camera (streamed ${r2.streamed.join('/')}, fetched ${r2.fetched.join('/')}; ${r2.cachedFrames}/${r2.frames} frames answered from the cache)`);
    check(r2.same.result && r2.same.vecDiff === 0 && r2.same.missing === 0, `…with the same flags, scores and vectors as the uncached run (${JSON.stringify(r2.same)})`);
    check(/^all [\d,]+ crops from the cache/.test(r2.line), `run summary: "${r2.line}"`);

    // ---- 3. negative control: move one 2D keypoint of one animal in one camera on one decoded frame
    const r3 = await page.evaluate(async () => {
        const { session, CAMS, sk, E } = window.__fx;
        const EC = await import('/pose/embedding-cache.js');
        // a frame camA decodes (a keyframe near a sample) during an encounter of animal 0: its hull reaches a neighbour's crop
        const cam = 'camA', cams1 = [cam];
        const d = window.__off.streamed[cam].find(f => { const gs = session.instanceGroups.get(f), its = gs.map((g, k) => ({ k, group: g }));
            const geo = E.frameCropGeometry(session, f, its, cams1, [f], sk)[0], i0 = gs.findIndex(g => g._animal === 0);
            return f > 3000 && geo[i0] && geo.some((g, ii) => ii !== i0 && g && EC.hullsReachingCrop(g, [geo[i0].hull], E.CROP).length); });
        const groups = session.instanceGroups.get(d);
        const items = groups.map((g, k) => ({ k, group: g }));
        const hashes = () => { const geo = E.frameCropGeometry(session, d, items, cams1, [d], sk)[0];
            return geo.map((g, ii) => g ? EC.cropKeyHash(g, EC.hullsReachingCrop(g, geo.filter((g2, j) => j !== ii && g2).map(g2 => g2.hull), E.CROP)) : null); };
        const before = hashes();
        // animal 0's Haunch_left, 9 px outward: its centre and its hull (a hull corner) change
        const g0 = groups.find(g => g._animal === 0), old = g0.instances.get(cam), hl = session.skeleton.nodes.findIndex(n => (n.name || n) === 'Haunch_left');
        const p = old.getPoint(hl), moved = [p[0] + 9, p[1] + 9];
        g0.instances.set(cam, { getPoint: (i) => i === hl ? moved : old.getPoint(i) });
        const after = hashes();
        const changed = new Set(); items.forEach((it, ii) => { if (before[ii] !== after[ii]) changed.add(it.group.identityId); });
        const on = await window.__run(true);
        const fresh = on.fresh.map(k => k.split('|'));
        const off = await window.__run(false);                              // the edited session, nothing cached
        const same = window.__same(off, on);
        // and only that: the other crops are the cached ones from before the edit
        let othersSame = 0, othersDiff = 0;
        window.__off.vecs.forEach((v, k) => { if (on.fresh.includes(k)) return; const u = on.vecs.get(k);
            let eq = !!u; for (let i = 0; eq && i < v.length; i++) eq = Object.is(v[i], u[i]); eq ? othersSame++ : othersDiff++; });
        // the moved animal's crop shows different pixels; a neighbour's only if it is close enough for the moved hull to be in it
        let movedDiffers = false; on.fresh.forEach(k => { if (+k.split('|')[1] !== g0.identityId) return; const v = window.__off.vecs.get(k), u = on.vecs.get(k);
            for (let i = 0; i < v.length; i++) if (v[i] !== u[i]) { movedDiffers = true; break; } });
        return { d, changed: [...changed].sort(), g0id: g0.identityId, fresh, model: on.modelCrops,
                 streamed: on.streamed, fetched: Object.values(on.fetched).map(a => a.length), same, othersSame, othersDiff, movedDiffers,
                 line: E.formatEmbedTiming(on.stats) };
    });
    const freshIds = [...new Set(r3.fresh.map(f => +f[1]))].sort();
    check(r3.changed.includes(r3.g0id) && r3.changed.length >= 2,
          `precondition: the edit changes the moved animal's crop key in camA on frame ${r3.d}, and the neighbour's whose crop its hull reaches (${r3.changed.length} of 3 keys)`);
    check(r3.fresh.length === r3.changed.length && r3.model === r3.changed.length && r3.fresh.every(f => f[2] === 'camA') &&
          new Set(r3.fresh.map(f => f[0])).size === 1 && freshIds.join() === r3.changed.join(),
          `the next run re-embeds exactly those ${r3.model} crops: ${r3.fresh.map(f => 'frame ' + f[0] + ' id ' + f[1] + ' ' + f[2]).join(', ')}`);
    check(r3.movedDiffers, '…and the moved animal\'s new vector differs from its old one');
    check(r3.streamed.camA.length === 1 && r3.streamed.camA[0] === r3.d && r3.streamed.camB.length === 0 && r3.streamed.camC.length === 0 && r3.fetched.every(n => n === 0),
          `…decoding only frame ${r3.d} in camA (streamed: camA ${JSON.stringify(r3.streamed.camA)}, camB ${r3.streamed.camB.length}, camC ${r3.streamed.camC.length})`);
    check(r3.othersDiff === 0 && r3.othersSame > 3000, `every other crop is the cached vector from before the edit (${r3.othersSame} unchanged)`);
    check(r3.same.result && r3.same.vecDiff === 0 && r3.same.missing === 0,
          `…and the run equals a cache-off run on the edited session: same flags, scores and vectors (${JSON.stringify(r3.same)})`);
    console.log(`  (run summary: ${r3.line})`);

    // ---- 5. the key leaves out masked hulls that cannot reach the crop: prove that is lossless, pixel for pixel
    const r5 = await page.evaluate(async () => {
        const { session, CAMS, sk, E, render } = window.__fx;
        const EC = await import('/pose/embedding-cache.js');
        const canvas = new OffscreenCanvas(E.CROP, E.CROP);
        let crops = 0, reduced = 0, dropped = 0, kept = 0, differ = 0;
        for (let f = 0; f < 27000; f += 32) {
            const groups = session.instanceGroups.get(f); if (!groups) continue;
            const items = groups.map((g, k) => ({ k, group: g }));
            const geo = E.frameCropGeometry(session, f, items, CAMS, CAMS.map(() => f), sk);
            CAMS.forEach((cam, vi) => { const img = render(cam, f);
                geo[vi].forEach((g, ii) => { if (!g) return;
                    const others = geo[vi].filter((g2, j) => j !== ii && g2).map(g2 => g2.hull), reach = EC.hullsReachingCrop(g, others, E.CROP);
                    crops++; if (reach.length < others.length) { reduced++; dropped += others.length - reach.length; } if (reach.length) kept++;
                    const a = E.cutCrop(img, g, others, canvas), b = E.cutCrop(img, g, reach, canvas);
                    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { differ++; break; } }); });
        }
        return { crops, reduced, dropped, kept, differ };
    });
    check(r5.reduced > 0.2 * r5.crops && r5.kept > 50 && r5.differ === 0,
          `masking only the hulls that reach the crop gives the same pixels: ${r5.crops} crops, ${r5.reduced} with a hull left out of the key (${r5.dropped} hulls), ${r5.kept} with a neighbour's hull in reach, ${r5.differ} differ`);

    // ---- 4. new videos: the session's cache is dropped
    const r4 = await page.evaluate(async () => {
        const { CAMS, AS, E, makeDecoder } = window.__fx;
        const before = E.embeddingCacheInfo().entries;
        AS.state.views = CAMS.map(c => ({ cameraName: c, decoder: makeDecoder(c) }));
        const on = await window.__run(true);
        return { before, cached: on.stats.cachedCrops, model: on.modelCrops, after: E.embeddingCacheInfo().entries };
    });
    check(r4.before > 0 && r4.cached === 0 && r4.after === r4.model, `new videos: nothing reused (${r4.cached} cached, ${r4.model} embedded), the old ${r4.before} entries dropped (now ${r4.after})`);

    check(errs.length === 0, `no page errors${errs.length ? ': ' + errs.join(' | ') : ''}`);
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
