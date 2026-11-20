/**
 * lazy-hydrate-visibility.mjs — a project reopened with Load Project keeps the
 * file's per-node visibility: a node stored placed but not visible comes back
 * occluded when its frame is hydrated, exactly as the eager loader gives it.
 *
 * Fixture (2 cameras x FRAMES frames x 2 animals, 3 nodes), saved with
 * `saveSlpToBytes`, reopened with `handleLoadProjectSlpLazy`:
 *   - frame 5: a grouped USER instance (cam0) with node 1 occluded;
 *   - frame 6: an UNLINKED user instance (cam1) with node 2 occluded;
 *   - frame 8: a grouped PREDICTION (cam1) with node 0 placed but not visible;
 *   - frame 9: an unlinked prediction (cam0) with node 1 placed but not visible.
 *
 *  1. Hydration (`buildLazyFrameGroupSync`, `ensureLazyFrameData`,
 *     `batchLoadLazyFrames`) sets each of those nodes occluded (`isOccluded`)
 *     and no other node; the unlinked user instance also gets the node as a
 *     nulled node (drawn occluded), as the eager loader does
 *     (`nulledNodesFromOcclusion`); a grouped member keeps the nulled nodes its
 *     group's metadata gives it.
 *  2. Residency stays lossless: the prediction member whose occlusion equals
 *     its row is released (`releaseFrameMembers2d`) and comes back occluded,
 *     from both `finalizeLazyFrameGroup` and `hydrateFrameMembers2d`; one whose
 *     occlusion was changed in memory is kept ('occlusion'). A frame whose
 *     unlinked prediction matches its row can be evicted; changed, it is kept.
 *  3. Save -> reopen -> save: the streaming save of the reopened project (the
 *     hydrated frames resident) writes the same visible column as the first
 *     file, and a second reopen shows the same occluded nodes.
 *
 * Run: PORT=9381 node tests/e2e/lazy-hydrate-visibility.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9381);
const FRAMES = 40;
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 600) : ''));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(120000);
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });

    // Shared page helpers: reopen bytes lazily; read the occlusion of the four
    // fixture instances; count placed-but-invisible points in a file.
    await page.evaluate(() => {
        window.__vis = {
            async reopen(bytes, name) {
                window.__tstLoad = { done: false, err: null };
                (async () => {
                    try { await (await import('/loading/session-loader.js')).handleLoadProjectSlpLazy(new File([bytes], name)); window.__tstLoad.done = true; }
                    catch (e) { window.__tstLoad.err = String(e && e.stack || e).slice(0, 500); }
                })();
                for (let i = 0; i < 600 && !window.__tstLoad.done && !window.__tstLoad.err; i++) {
                    const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || '') && x.offsetParent);
                    if (b) b.click();
                    await new Promise(r => setTimeout(r, 100));
                }
                if (window.__tstLoad.err) return window.__tstLoad.err;
                if (!window.__tstLoad.done) return 'reopen timed out';
                return window.__lucid.state.session.lazyLoader ? null : 'not lazy';
            },
            occ(inst) {
                if (!inst) return null;
                const o = [];
                for (let k = 0; k < inst.numNodes; k++) o.push(inst.isOccluded(k) ? 1 : 0);
                return { occ: o.join(''), nulled: [...(inst.nulledNodes || [])].sort().join(','), type: inst.type };
            },
            // The four fixture instances, by frame (cam, linked/unlinked, raw row).
            pick(s, f) {
                const fg = s.frameGroups.get(f);
                if (!fg) return null;
                const at = (cam, k) => {
                    for (const i of fg.instances.get(cam) || []) if (i._rawInstIndex === k) return i;
                    for (const u of fg.getUnlinkedInstances(cam) || []) if (u.instance._rawInstIndex === k) return u.instance;
                    return null;
                };
                if (f === 5) return at('cam0', 0);
                if (f === 6) return at('cam1', 2);
                if (f === 8) return at('cam1', 1);
                if (f === 9) return at('cam0', 2);
                return null;
            },
            async invisible(bytes) {
                const h5 = await import('h5wasm');
                await h5.ready;
                const p = '/__vis_' + Math.random().toString(36).slice(2) + '.slp';
                h5.FS.writeFile(p, bytes);
                const f = new h5.File(p, 'r');
                const out = {};
                for (const name of ['points', 'pred_points']) {
                    const d = f.get(name);
                    const cols = JSON.parse(d.attrs.field_names.value);
                    const v = Array.from(d.value, Number), nc = cols.length;
                    const xi = cols.indexOf('x'), vi = cols.indexOf('visible');
                    let n = 0;
                    for (let r = 0; r < v.length / nc; r++) if (Number.isFinite(v[r * nc + xi]) && v[r * nc + vi] === 0) n++;
                    out[name] = n;
                }
                f.close();
                h5.FS.unlink(p);
                return out;
            },
        };
    });

    console.log('Building, saving and reopening the project');
    const built = await page.evaluate(async (FRAMES) => {
        const [pd, fileio] = await Promise.all([import('/pose/pose-data.js'), import('/import-export/file-io.js')]);
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session, UnlinkedInstance } = pd;
        const cams = ['cam0', 'cam1'];
        const nodes = ['n0', 'n1', 'n2'];
        const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
        const s = new Session(cams.map((n, i) => new Camera(n, M, [0, 0, 0, 0, 0], [0, 0.3 * i, 0], [0, 0, 40], [512, 512])),
            new Skeleton('skeleton', nodes, [[0, 1], [1, 2]]), ['t0', 't1', 't2'], 'Vis');
        const mk = (f, ci, k, type) => new Instance(nodes.map((_, j) => [40 + 30 * k + 7 * j + ci + f * 0.25, 50 + 9 * j + k]), k, type, 0.8);
        let gid = 1;
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            s.addFrameGroup(fg);
            const gs = [];
            for (let k = 0; k < 2; k++) {
                const g = new InstanceGroup(gid++, k);
                cams.forEach((cn, ci) => {
                    const user = f === 5 && k === 0 && cn === 'cam0';
                    const inst = mk(f, ci, k, user ? 'user' : 'predicted');
                    if (user) inst.setOccluded(1, true);
                    if (f === 8 && k === 1 && cn === 'cam1') inst.setOccluded(0, true);
                    inst._rawInstIndex = k;
                    fg.addInstance(cn, inst);
                    g.addInstance(cn, inst);
                });
                g.points3d = new Float64Array(9).map((_, i) => i + k);
                gs.push(g);
            }
            s.instanceGroups.set(f, gs);
            if (f === 6) {
                const u = mk(f, 1, 2, 'user');
                u.trackIdx = 2;
                u.setOccluded(2, true);
                fg.addUnlinkedInstance('cam1', new UnlinkedInstance(u, 'cam1'));
            }
            if (f === 9) {
                const u = mk(f, 0, 2, 'predicted');
                u.trackIdx = 2;
                u.setOccluded(1, true);
                fg.addUnlinkedInstance('cam0', new UnlinkedInstance(u, 'cam0'));
            }
        }
        const views = cams.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: FRAMES }));
        const videoFiles = cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const bytes = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(s, views, videoFiles));
        window.__visBytes1 = bytes;
        const err = await window.__vis.reopen(bytes, 'vis.slp');
        return { err, invisible: await window.__vis.invisible(bytes) };
    }, FRAMES);
    check(!built.err, 'project reopened lazily', built.err || undefined);
    check(built.invisible.points === 2 && built.invisible.pred_points === 2,
        'the file stores 2 user + 2 predicted placed-but-invisible nodes', built.invisible);

    const EXPECT = {
        5: { occ: '010', nulled: '', type: 'user' },
        6: { occ: '001', nulled: '2', type: 'user' },
        8: { occ: '100', nulled: '', type: 'predicted' },
        9: { occ: '010', nulled: '', type: 'predicted' },
    };

    console.log('1. Hydration applies the file\'s visibility');
    const hyd = await page.evaluate(async () => {
        const tri = await import('/pose/triangulation.js');
        const s = window.__lucid.state.session;
        const out = {};
        // Three hydration paths: ensureLazyFrameData (5), buildLazyFrameGroupSync (6),
        // batchLoadLazyFrames (8, 9).
        for (const f of [5, 6, 8, 9]) s.frameGroups.delete(f);
        await tri.ensureLazyFrameData(5);
        tri.buildLazyFrameGroupSync(6);
        await tri.batchLoadLazyFrames(8, 2);
        for (const f of [5, 6, 8, 9]) out[f] = window.__vis.occ(window.__vis.pick(s, f));
        // No other node anywhere in a resident frame is occluded.
        let stray = 0;
        for (const [f, fg] of s.frameGroups) {
            const all = [...fg.instances.values()].flat().concat([...fg.unlinkedInstances.values()].flat().map(u => u.instance));
            for (const i of all) if (i.anyOccluded() && ![5, 6, 8, 9].includes(f)) stray++;
        }
        return { out, stray };
    });
    for (const f of [5, 6, 8, 9]) {
        check(JSON.stringify(hyd.out[f]) === JSON.stringify(EXPECT[f]), `frame ${f}: ${EXPECT[f].type} comes back with occ ${EXPECT[f].occ}, nulled [${EXPECT[f].nulled}]`, hyd.out[f]);
    }
    check(hyd.stray === 0, 'no other resident instance is occluded', hyd.stray);

    console.log('2. Residency stays lossless');
    const res = await page.evaluate(async () => {
        const [tri, lr] = await Promise.all([import('/pose/triangulation.js'), import('/pose/lazy-residency.js')]);
        const s = window.__lucid.state.session;
        const out = {};
        const member8 = s.instanceGroups.get(8)[1].instances.get('cam1');
        // An evictable frame (9): its unlinked prediction equals its row.
        out.evict9 = lr.frameEvictionBlocker(s, 9, s.frameGroups.get(9));
        const ul9 = window.__vis.pick(s, 9);
        ul9.setOccluded(1, false);
        out.evict9Changed = lr.frameEvictionBlocker(s, 9, s.frameGroups.get(9));
        ul9.setOccluded(1, true);
        // Frame 8 leaves residency: its occluded prediction member is released.
        out.evict8 = lr.frameEvictionBlocker(s, 8, s.frameGroups.get(8));
        s.frameGroups.delete(8);
        const desc = s.lazyLoader.describeStoreFrame('cam1', 8);
        out.blocker8 = lr.member2dReleaseBlocker(member8, desc, s.lazyLoader.numNodesByCam.get('cam1'));
        out.released = lr.releaseFrameMembers2d(s, 8);
        out.member8Lazy = member8._lazy2d;
        // hydrateFrameMembers2d brings it back occluded.
        lr.hydrateFrameMembers2d(s, 8);
        out.viaHydrateMembers = window.__vis.occ(member8);
        lr.releaseFrameMembers2d(s, 8);
        // ...and so does a full re-hydration of the frame.
        tri.buildLazyFrameGroupSync(8);
        out.viaRebuild = window.__vis.occ(member8);
        out.sameObject = window.__vis.pick(s, 8) === member8;
        // Occlusion changed in memory: the member keeps its 2D.
        member8.setOccluded(0, false);
        member8.setOccluded(2, true);
        s.frameGroups.delete(8);
        out.blockerChanged = lr.member2dReleaseBlocker(member8, desc, s.lazyLoader.numNodesByCam.get('cam1'));
        out.releasedChanged = lr.releaseFrameMembers2d(s, 8);
        // A prediction member WITHOUT occlusion on a frame with none still releases.
        tri.buildLazyFrameGroupSync(8);
        member8.setOccluded(2, false);
        member8.setOccluded(0, true);
        const plain = s.instanceGroups.get(8)[0].instances.get('cam1');
        s.frameGroups.delete(8);
        out.plainBlocker = lr.member2dReleaseBlocker(plain, desc, s.lazyLoader.numNodesByCam.get('cam1'));
        out.releasedAll = lr.releaseFrameMembers2d(s, 8);
        tri.buildLazyFrameGroupSync(8);
        out.final8 = window.__vis.occ(member8);
        return out;
    });
    check(res.evict9 === null, 'frame 9 (unlinked prediction = its row) can be evicted', res.evict9);
    check(res.evict9Changed === 'occlusion', 'frame 9 with that prediction\'s occlusion changed in memory is kept', res.evict9Changed);
    check(res.evict8 === null, 'frame 8 (occluded prediction member = its row) can be evicted', res.evict8);
    check(res.blocker8 === null && res.released === 4 && res.member8Lazy === true, 'its four prediction members are released, the occluded one too', res);
    check(JSON.stringify(res.viaHydrateMembers) === JSON.stringify(EXPECT[8]), 'hydrateFrameMembers2d gives it back occluded', res.viaHydrateMembers);
    check(JSON.stringify(res.viaRebuild) === JSON.stringify(EXPECT[8]) && res.sameObject, 're-hydrating the frame gives the same member back occluded', res.viaRebuild);
    check(res.blockerChanged === 'occlusion' && res.releasedChanged === 3, 'a member whose occlusion differs from its row keeps its 2D (the other three release)', res);
    check(res.plainBlocker === null && res.releasedAll === 4, 'with its occlusion back as the file has it, all four release again', res);
    check(JSON.stringify(res.final8) === JSON.stringify(EXPECT[8]), 'frame 8 ends as the file has it', res.final8);

    console.log('3. Save -> reopen -> save keeps it');
    const rt = await page.evaluate(async () => {
        const [sw, tri] = await Promise.all([import('/import-export/slp-streaming-write.js'), import('/pose/triangulation.js')]);
        const st = window.__lucid.state;
        // Frames 5, 6, 8, 9 are resident: the save writes them from memory.
        const resident = [5, 6, 8, 9].map(f => st.session.frameGroups.has(f));
        const bytes2 = await sw.buildSessionSlpBytesStreaming(st.session, st.views, st.videoFiles);
        const inv2 = await window.__vis.invisible(bytes2);
        const err = await window.__vis.reopen(bytes2, 'vis2.slp');
        const s = st.session;
        const out = {};
        for (const f of [5, 6, 8, 9]) { s.frameGroups.delete(f); tri.buildLazyFrameGroupSync(f); out[f] = window.__vis.occ(window.__vis.pick(s, f)); }
        const bytes3 = await sw.buildSessionSlpBytesStreaming(s, st.views, st.videoFiles);
        return { resident, inv1: await window.__vis.invisible(window.__visBytes1), inv2, inv3: await window.__vis.invisible(bytes3), err, out };
    });
    check(!rt.err && rt.resident.every(Boolean), 'saved with the four frames resident, reopened', rt);
    check(JSON.stringify(rt.inv2) === JSON.stringify(rt.inv1), 'the re-saved file stores the same placed-but-invisible nodes', { first: rt.inv1, resaved: rt.inv2 });
    check(JSON.stringify(rt.inv3) === JSON.stringify(rt.inv1), 'and so does a third save', rt.inv3);
    for (const f of [5, 6, 8, 9]) {
        check(JSON.stringify(rt.out[f]) === JSON.stringify(EXPECT[f]), `after save -> reopen, frame ${f} occ ${EXPECT[f].occ}`, rt.out[f]);
    }
    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
