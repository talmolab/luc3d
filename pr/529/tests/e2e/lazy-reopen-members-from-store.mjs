/**
 * lazy-reopen-members-from-store.mjs — a lazy project reopen rebuilds its 3D
 * groups' members from the lazy store's rows, and gets exactly what the typed
 * frames gave.
 *
 * `reconstructInstanceGroupsFromSessionLazy` (import-export/slp-import.js)
 * needs only each member's type, track and score. It used to read them through
 * `typedIG.instanceByCamera`, which materializes every grouped frame (typed
 * instances, points and all): 1.2 s and most of the load's garbage collection
 * on an 8-camera, 108,000-frame project. Given `opts.labels`
 * (`handleLoadProjectSlpLazy` passes it), it reads them from the store's rows
 * instead (`storeMembers`), the way `LazyDataStore.materializeFrame` builds them.
 *
 * The fixture (sleap-io.js's typed API) mixes what a member can be: predicted
 * with and without a track, predicted with a NaN score, user instances (one
 * from a prediction, one without a track), and a ref past its frame's last
 * instance (left out by both paths). Cases:
 *   A. from the store (opts.labels) = through instanceByCamera: identity, 3D,
 *      and per member camera, track index, type, score, `_rawInstIndex`;
 *      and the store path materializes no frame.
 *   B. a frame already materialized: the store path stands aside (falls back
 *      to instanceByCamera) and the result is still the same.
 *   C. the real File ▸ Load Project path (`handleLoadProjectSlpLazy`) restores
 *      the same groups and members (identity aside: the fixture has no
 *      identity catalog, so that path leaves it at -1).
 *
 * Run: node tests/e2e/lazy-reopen-members-from-store.mjs
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
        const FRAMES = 300, CAMS = 3, ANIMALS = 3, NODES = 3;
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
        const pts = (k, c, f, j) => ({ xy: [50 + 120 * k + 10 * j + c, 60 + 8 * j + 0.1 * f], visible: true, complete: true, score: 0.9 });
        // Instance d of camera c, frame f: what it is varies with (f, c, d).
        const lfs = [];
        for (let c = 0; c < CAMS; c++) {
            for (let f = 0; f < FRAMES; f++) {
                const insts = [];
                for (let d = 0; d < ANIMALS; d++) {
                    const kind = (f + 2 * c + d) % 5;
                    const points = Array.from({ length: NODES }, (_, j) => pts(d, c, f, j));
                    const track = kind === 1 ? null : tracks[(d + f) % ANIMALS];
                    if (kind === 3 || kind === 4) {
                        insts.push(new S.Instance({ points: points.map(p => ({ xy: p.xy, visible: true, complete: true })), skeleton, track: kind === 4 ? null : track }));
                    } else {
                        insts.push(new S.PredictedInstance({ points, skeleton, track, score: kind === 2 ? NaN : 0.5 + 0.001 * f + 0.1 * d }));
                    }
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
                cams.forEach((cam, c) => {
                    // Every 7th frame, camera 2's ref points past the frame's last instance.
                    const d = (c === 2 && f % 7 === 0) ? ANIMALS + 1 : (k + c) % ANIMALS;
                    refs.set(cam, [c * FRAMES + f, d]);
                });
                groups.push(new S.InstanceGroup({
                    instanceRefsByCamera: refs,
                    instance3d: new S.Instance3D({ points: Array.from({ length: NODES }, (_, j) => [10 * k, j, 0.01 * f]), skeleton }),
                    metadata: { lucid: { identityId: k } },
                }));
            }
            session.frameGroups.set(f, new S.FrameGroup({ frameIdx: f, instanceGroups: groups, labeledFrameRefsByCamera: lfRefs }));
        }
        const labels0 = new S.Labels({ labeledFrames: lfs, videos, skeletons: [skeleton], tracks, sessions: [session], provenance: {} });
        const file = new File([await S.saveSlpToBytes(labels0)], 'members.slp');
        window.__membersFile = file;

        const pd = await import('./pose/pose-data.js');
        const imp = await import('./import-export/slp-import.js');
        const SioLazyLoader = (await import('./loading/sio-lazy-loader.js')).SioLazyLoader;
        const digest = (s) => {
            const out = [];
            for (const f of [...s.instanceGroups.keys()].sort((a, b) => a - b)) {
                for (const g of s.instanceGroups.get(f)) {
                    let line = f + '|' + g.identityId + '|' + (g.points3d ? Array.from(g.points3d).join(',') : '-');
                    for (const [cam, inst] of g.instances) {
                        line += `|${cam}:${inst.trackIdx}:${inst.type}:${inst.score}:${inst._rawInstIndex}`;
                    }
                    out.push(line);
                }
            }
            return out;
        };
        const rebuild = async ({ withLabels, materializeFirst }) => {
            const loader = new SioLazyLoader();
            const o = await loader.openProjectSlp(file);
            const s = new pd.Session(cams.map(c => new pd.Camera(c.name, [[900, 0, 320], [0, 900, 256], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 512])),
                new pd.Skeleton('sk', nodes.map(n => n.name), [[0, 1]]), o.labels.tracks.map(t => t.name), 'p');
            s.addIdentity('a'); s.addIdentity('b'); s.addIdentity('c');
            if (materializeFirst) o.labels.frameAt(0);
            await imp.reconstructInstanceGroupsFromSessionLazy(s, o.typedSession, loader, nodes.map(n => n.name),
                withLabels ? { labels: o.labels } : {});
            return { d: digest(s), cached: o.labels._lazyFrameList.cache.size };
        };
        const old = await rebuild({ withLabels: false });
        const store = await rebuild({ withLabels: true });
        const fallback = await rebuild({ withLabels: true, materializeFirst: true });
        const firstDiff = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return [i, a[i], b[i]]; return null; };
        let members = 0, kinds = new Set();
        for (const line of old.d) for (const m of line.split('|').slice(3)) { members++; const p = m.split(':'); kinds.add(p[1] + '/' + p[2] + '/' + (p[3] === '0' ? '0' : 'x')); }
        return {
            groups: old.d.length, members, kinds: [...kinds].sort(),
            storeDiff: firstDiff(old.d, store.d), fallbackDiff: firstDiff(old.d, fallback.d),
            oldCached: old.cached, storeCached: store.cached, fallbackCached: fallback.cached,
            old: old.d,
        };
    });
    check(res.groups === 900 && res.members > 2000 && res.members < 900 * 3,
        `the fixture restores ${res.groups} groups with ${res.members} members (refs past a frame's end left out)`, { groups: res.groups, members: res.members });
    check(res.kinds.some(k => k.startsWith('null/predicted')) && res.kinds.some(k => k.includes('/user/')) && res.kinds.some(k => /predicted\/0$/.test(k)),
        'members include trackless predictions, user instances and a NaN score (restored as 0)', res.kinds);
    check(res.storeDiff === null, 'A. members read from the store = members read through instanceByCamera', res.storeDiff);
    check(res.storeCached === 0 && res.oldCached > 0, 'A. the store path materializes no frame', { store: res.storeCached, old: res.oldCached });
    check(res.fallbackDiff === null, 'B. with a frame already materialized the result is the same', res.fallbackDiff);

    // C. the real reopen path
    const real = await page.evaluate(async () => {
        const sl = await import('./loading/session-loader.js');
        const clicker = setInterval(() => { for (const b of document.querySelectorAll('button')) { const t = b.textContent.trim(); if ((t.startsWith('Skip') || t === 'Continue' || t === 'OK') && b.offsetParent !== null) b.click(); } }, 100);
        try { await sl.handleLoadProjectSlpLazy(window.__membersFile); } finally { clearInterval(clicker); }
        const s = window.__lucid.state.session;
        const out = [];
        for (const f of [...s.instanceGroups.keys()].sort((a, b) => a - b)) {
            for (const g of s.instanceGroups.get(f)) {
                let line = f + '|' + g.identityId + '|' + (g.points3d ? Array.from(g.points3d).join(',') : '-');
                for (const [cam, inst] of g.instances) line += `|${cam}:${inst.trackIdx}:${inst.type}:${inst.score}:${inst._rawInstIndex}`;
                out.push(line);
            }
        }
        return { lazy: !!s.lazyLoader, d: out };
    });
    // The fixture has no identity catalog, so the real loader leaves every
    // group's identity at -1 (the direct calls above made three): compare all
    // the rest of each line.
    const noId = (l) => l.replace(/^(\d+)\|-?\d+\|/, '$1||');
    check(real.lazy && real.d.length === res.old.length && real.d.every((l, i) => noId(l) === noId(res.old[i])),
        'C. File ▸ Load Project (handleLoadProjectSlpLazy) restores the same groups and members',
        { i: real.d.findIndex((l, i) => noId(l) !== noId(res.old[i])), real: real.d[0], direct: res.old[0] });
    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close();
    server.close();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
