/**
 * lazy-reopen-group-identities.mjs — a project `.slp` written by another tool
 * (campy-live-export) keeps its animals when reopened lazily (File → Load
 * Project on a file over 200 MB → `handleLoadProjectSlpLazy`).
 *
 * Such a file has NO LUC3D session-level identity metadata (`lucid.identities`,
 * `frameIdentityMap`). It has the file's `/identity` catalog ("animal 0"..),
 * and on every instance group its identity twice: `identity_idx` (in
 * /session_data/instance_groups) and `metadata.lucid.identityId`. Before the
 * fix the lazy reopen read identities only from the LUC3D metadata, so the
 * catalog was ignored and every group came back with identityId -1.
 *
 * The fixture is built in the page with sleap-io.js's typed API in campy's
 * shape: tracks "animal k" on the 2D, one group per animal per frame, and each
 * camera's detections in a different order from the animals (so a member's
 * instance index is not its animal).
 *
 * Cases:
 *   A. identity_idx + metadata.lucid.identityId (what campy writes), lazy:
 *      identities = the catalog; every group's identityId = its animal; the
 *      per-detection identity map is filled, so the Identity timeline shows a
 *      row per animal per camera across every frame (not only resident ones).
 *   B. identity_idx only (no group metadata), lazy: same result.
 *   C. A and B through the EAGER File → Load SLP: identities, group
 *      identities and the Identity timeline match the lazy reopen (B: the
 *      eager path reads `identity_idx` too).
 *   D. a LUC3D-saved project with identities on its groups but an EMPTY
 *      frameIdentityMap opens exactly as before, lazy and eager: nothing is derived.
 *
 * Run: node tests/e2e/lazy-reopen-group-identities.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8247);
const FRAMES = Number(process.env.FRAMES || 400);
const CAMS = 3, ANIMALS = 4, NODES = 3;

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const fixtures = {
    campy: path.join(repoRoot, '_lazy-group-ids-campy.slp'),
    idxOnly: path.join(repoRoot, '_lazy-group-ids-idx-only.slp'),
    lucid: path.join(repoRoot, '_lazy-group-ids-lucid.slp'),
};

let browser;
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 300)); });

    const sinks = {};
    await page.exposeFunction('__tstWrite', (which, b64) => {
        if (!(which in sinks)) sinks[which] = fs.openSync(fixtures[which], 'w');
        fs.writeSync(sinks[which], Buffer.from(b64, 'base64'));
    });

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm && window.__lucid, { timeout: 120000 });

    // ---- fixtures ----
    await page.evaluate(async ({ FRAMES, CAMS, ANIMALS, NODES }) => {
        const S = window.SleapIO;
        async function send(which, bytes) {
            let s = ''; const C = 0x8000;
            for (let o = 0; o < bytes.length; o += C) s += String.fromCharCode.apply(null, bytes.subarray(o, o + C));
            await window.__tstWrite(which, btoa(s));
        }
        // Detection d of camera c at frame f is animal (d + f + c) % ANIMALS.
        const animalOf = (f, c, d) => (d + f + c) % ANIMALS;
        const detectionOf = (f, c, k) => ((k - f - c) % ANIMALS + ANIMALS) % ANIMALS;

        // campy-live-export's graph (campy/liveexport.py Export).
        async function campyLike(withMeta) {
            const nodes = Array.from({ length: NODES }, (_, j) => new S.Node('n' + j));
            const skeleton = new S.Skeleton({ nodes, edges: [new S.Edge(nodes[0], nodes[1]), new S.Edge(nodes[1], nodes[2])], name: 'campy-live' });
            const tracks = Array.from({ length: ANIMALS }, (_, k) => new S.Track('animal ' + k));
            const identities = Array.from({ length: ANIMALS }, (_, k) => new S.Identity({ name: 'animal ' + k }));
            const cams = Array.from({ length: CAMS }, (_, c) => new S.Camera({
                name: 'Camera' + c, matrix: [[900, 0, 320], [0, 900, 256], [0, 0, 1]],
                rvec: [0, 0.3 * c, 0], tvec: [0, 0, 1000], distortions: [0, 0, 0, 0, 0], size: [640, 512],
            }));
            const videos = cams.map((cam, c) => {
                const fn = 'Camera' + c + '/0.mp4';
                const v = new S.Video({ filename: fn, backendMetadata: { type: 'MediaVideo', shape: [FRAMES, 512, 640, 1], filename: fn }, openBackend: false });
                v.shape = [FRAMES, 512, 640, 1];
                return v;
            });
            const session = new S.RecordingSession({ cameraGroup: new S.CameraGroup({ cameras: cams }) });
            cams.forEach((cam, c) => session.addVideo(videos[c], cam));
            const lfs = [];   // order: camera-major, so lf index = c * FRAMES + f
            for (let c = 0; c < CAMS; c++) {
                for (let f = 0; f < FRAMES; f++) {
                    const insts = [];
                    for (let d = 0; d < ANIMALS; d++) {
                        const k = animalOf(f, c, d);
                        const pts = [];
                        for (let j = 0; j < NODES; j++) pts.push({ xy: [50 + 120 * k + 10 * j + c, 60 + 8 * j + 0.1 * f], visible: true, complete: true, score: 0.9 });
                        insts.push(new S.PredictedInstance({ points: pts, skeleton, track: tracks[k], score: 0.95 }));
                    }
                    lfs.push(new S.LabeledFrame({ video: videos[c], frameIdx: f, instances: insts }));
                }
            }
            for (let f = 0; f < FRAMES; f++) {
                const groups = [];
                const lfRefs = new Map();
                cams.forEach((cam, c) => lfRefs.set(cam, c * FRAMES + f));
                for (let k = 0; k < ANIMALS; k++) {
                    const refs = new Map();
                    cams.forEach((cam, c) => refs.set(cam, [c * FRAMES + f, detectionOf(f, c, k)]));
                    const pts3 = Array.from({ length: NODES }, (_, j) => [10 * k, j, 0.01 * f]);
                    groups.push(new S.InstanceGroup({
                        instanceRefsByCamera: refs, identity: identities[k],
                        instance3d: new S.Instance3D({ points: pts3, skeleton }),
                        metadata: withMeta ? { lucid: { identityId: k } } : {},
                    }));
                }
                session.frameGroups.set(f, new S.FrameGroup({ frameIdx: f, instanceGroups: groups, labeledFrameRefsByCamera: lfRefs }));
            }
            const labels = new S.Labels({ labeledFrames: lfs, videos, skeletons: [skeleton], tracks, identities, sessions: [session], provenance: {} });
            return await S.saveSlpToBytes(labels);
        }
        await send('campy', await campyLike(true));
        await send('idxOnly', await campyLike(false));

        // A LUC3D project: identities on the groups, empty frameIdentityMap.
        const [pd, fileio] = await Promise.all([import('/pose/pose-data.js'), import('/import-export/file-io.js')]);
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const camNames = Array.from({ length: CAMS }, (_, i) => 'cam' + i);
        const nodeNames = Array.from({ length: NODES }, (_, i) => 'n' + i);
        const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
        const cameras = camNames.map((n, i) => new Camera(n, M, [0, 0, 0, 0, 0], [0, 0.3 * i, 0], [0, 0, 40], [512, 512]));
        const session = new Session(cameras, new Skeleton('skeleton', nodeNames, [[0, 1], [1, 2]]),
            Array.from({ length: ANIMALS }, (_, k) => 't' + k), 'LucidProject');
        session.identities = Array.from({ length: ANIMALS }, (_, k) => ({ id: k, name: 'id_' + k }));
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            const gs = [];
            for (let k = 0; k < ANIMALS; k++) {
                const g = new InstanceGroup(f * ANIMALS + k + 1, k);
                camNames.forEach((cn, ci) => {
                    const inst = new Instance(nodeNames.map((_, j) => [50 + 100 * k + 10 * j + ci, 60 + 8 * j]), k, 'predicted', 1);
                    inst._rawInstIndex = k;
                    fg.addInstance(cn, inst);
                    g.addInstance(cn, inst);
                });
                g.points3d = new Float64Array(NODES * 3).map((_, i) => i + 10 * k);
                gs.push(g);
            }
            session.instanceGroups.set(f, gs);
        }
        const views = camNames.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: FRAMES }));
        const videoFiles = camNames.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        await send('lucid', await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(session, views, videoFiles)));
    }, { FRAMES, CAMS, ANIMALS, NODES });
    for (const k of Object.keys(sinks)) fs.closeSync(sinks[k]);

    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__tstPick';
        inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
    });

    /** Load `file` with `how` ('lazy' | 'eager'), dismissing the video prompt. */
    async function load(file, how) {
        await page.setInputFiles('#__tstPick', file);
        await page.evaluate((how) => {
            window.__tstLoad = { done: false, err: null };
            (async () => {
                try {
                    const f = document.getElementById('__tstPick').files[0];
                    if (how === 'lazy') await (await import('/loading/session-loader.js')).handleLoadProjectSlpLazy(f);
                    else await (await import('/import-export/slp-import.js')).handleLoadSlpFile(f);
                    window.__tstLoad.done = true;
                } catch (e) { window.__tstLoad.err = String(e && e.stack || e).slice(0, 500); }
            })();
        }, how);
        for (let i = 0; i < 400; i++) {
            const s = await page.evaluate(() => {
                const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || '') && x.offsetParent);
                if (b) { b.click(); return 'clicked'; }
                return window.__tstLoad.done ? 'done' : (window.__tstLoad.err ? 'err' : 'wait');
            });
            if (s === 'done' || s === 'err') break;
            await new Promise(r => setTimeout(r, 250));
        }
        return await page.evaluate(() => window.__tstLoad.err);
    }

    /** What the reopened session holds, and the Identity timeline's rows. */
    const inspect = () => page.evaluate(({ ANIMALS }) => {
        const s = window.__lucid.state.session;
        let groups = 0, wrong = 0, wrongMap = 0;
        for (const [f, gs] of s.instanceGroups) {
            for (const g of gs) {
                groups++;
                // Every member carries track "animal k" of its group's animal.
                const k = [...g.instances.values()][0].trackIdx;
                if (g.identityId !== k) wrong++;
                for (const [cn, inst] of g.instances) {
                    if (s.getIdentityIdForTrack(cn, inst.trackIdx, f) !== g.identityId) wrongMap++;
                }
            }
        }
        const t = window.__lucid.timeline;
        const savedUp = s._uploadedCameras; s._uploadedCameras = undefined;   // no videos attached
        t.setData(s); t.setDisplayMode('identities');
        const rows = t._trackSegments.filter(r => r.treeRole !== 'empty')
            .map(r => r.cameraName + '|' + r.trackName + '|' + r.segments.map(x => x.start + '-' + x.end).join(','));
        t.setDisplayMode('tracks'); s._uploadedCameras = savedUp;
        return {
            lazy: !!s.lazyLoader, ids: s.identities.map(i => i.name), groups, wrong, wrongMap,
            mapSize: s.frameIdentityMap.size, resident: s.frameGroups.size, rows,
            f7: (s.instanceGroups.get(7) || []).map(g => g.identityId),
        };
    }, { ANIMALS });

    const animalNames = Array.from({ length: ANIMALS }, (_, k) => 'animal ' + k);
    const fullRun = '0-' + (FRAMES - 1);

    for (const [label, file] of [['A (identity_idx + metadata, campy)', fixtures.campy], ['B (identity_idx only)', fixtures.idxOnly]]) {
        console.log('\n' + label + ' — lazy reopen');
        const err = await load(file, 'lazy');
        check(!err, 'lazy reopen completed', err || undefined);
        const r = await inspect();
        check(r.lazy, 'took the lazy path');
        check(JSON.stringify(r.ids) === JSON.stringify(animalNames), 'identities = the file\'s catalog', r.ids);
        check(r.groups === FRAMES * ANIMALS, 'every group restored', { groups: r.groups });
        check(r.wrong === 0, 'every group\'s identityId is its animal', { wrong: r.wrong, f7: r.f7 });
        check(r.mapSize === FRAMES * ANIMALS * CAMS, 'one per-detection identity per group member', { mapSize: r.mapSize });
        check(r.wrongMap === 0, 'every member resolves to its group\'s identity', { wrongMap: r.wrongMap });
        check(r.resident < FRAMES / 4, 'lazy precondition: most frames not resident', { resident: r.resident });
        const want = [];
        for (let c = 0; c < CAMS; c++) for (const n of animalNames) want.push('Camera' + c + '|' + n + '|' + fullRun);
        check(JSON.stringify(r.rows) === JSON.stringify(want), 'Identity timeline: each animal on each camera, every frame',
            r.rows.slice(0, 4));
    }

    for (const [label, file] of [['C (file A)', fixtures.campy], ['C (file B, identity_idx only)', fixtures.idxOnly]]) {
        console.log('\n' + label + ' — eager File → Load SLP');
        const err = await load(file, 'eager');
        check(!err, 'eager load completed', err || undefined);
        const r = await inspect();
        check(!r.lazy, 'took the eager path');
        check(JSON.stringify(r.ids) === JSON.stringify(animalNames), 'identities = the file\'s catalog', r.ids);
        check(r.wrong === 0 && r.groups === FRAMES * ANIMALS, 'every group\'s identityId is its animal', { wrong: r.wrong, groups: r.groups });
        check(r.mapSize === FRAMES * ANIMALS * CAMS && r.wrongMap === 0, 'per-detection identities derived, as on the lazy path',
            { mapSize: r.mapSize, wrongMap: r.wrongMap });
    }

    for (const how of ['lazy', 'eager']) {
        console.log('\nD (LUC3D project, identities on groups, empty frameIdentityMap) — ' + how);
        const err = await load(fixtures.lucid, how);
        check(!err, how + ' load completed', err || undefined);
        const r = await inspect();
        check(JSON.stringify(r.ids) === JSON.stringify(Array.from({ length: ANIMALS }, (_, k) => 'id_' + k)),
            'identities = the project\'s own list', r.ids);
        check(r.wrong === 0, 'groups keep their saved identityId', { wrong: r.wrong, f7: r.f7 });
        check(r.mapSize === 0, 'nothing derived: the map is what was saved (empty)', { mapSize: r.mapSize });
    }

    check(errs.length === 0, 'no page/console errors', errs.length ? errs.slice(0, 3) : undefined);
    await browser.close();
} finally {
    server.kill();
    if (!process.env.KEEP) for (const p of Object.values(fixtures)) { try { fs.unlinkSync(p); } catch {} }
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
