/**
 * training-data.mjs — the Training panel's training files (import-export/training-slp.js):
 * what goes in, and that a lazy project gives the same file as the eager one.
 *
 * Fixture: 2 cameras x 40 frames x 2 animals, every frame grouped (a prediction per camera and
 * animal, with 3D, so reprojections exist), identities Ann (track 0) and Bob (track 1):
 *   - frames 0, 4, …, 36: animal 0 is a USER instance in both cameras (node 1 of cam0 at frame 0
 *     occluded);
 *   - frame 15: an unlinked user instance in cam1 on track 1;
 *   - frame 25: a user instance in cam0 with every node occluded (nothing visible: skipped).
 *
 *  1. Eager: user instances only (no predictions, no reprojections), one video per view in
 *     selection order and the same table in both files, tracks = identity names, the occluded
 *     node stored invisible, the all-occluded instance skipped, every view of a moment on the
 *     same side of the split, reproducible.
 *  2. Lazy: save → reopen with Load Project (lazy), evict the labelled frames, then edit one
 *     user instance on a resident frame and add an unsaved one: the lazy file has the store rows
 *     of non-resident frames, the edit and the new instance, and the same tracks as eager.
 *  3. Checks: a `${` node name, a skeleton mismatch and a project without labels are refused;
 *     two sessions keep their moments apart.
 *
 * Run: PORT=9391 node tests/e2e/training-data.mjs   (DUMP_DIR=<dir> also writes train.slp / val.slp)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9391);
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 700) : ''));
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

    await page.evaluate(() => {
        window.__td = {
            async build() {
                const pd = await import('/pose/pose-data.js');
                const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session, UnlinkedInstance } = pd;
                const cams = ['cam0', 'cam1'];
                const nodes = ['head', 'thorax', 'tail'];
                const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
                const s = new Session(cams.map((n, i) => new Camera(n, M, [0, 0, 0, 0, 0], [0, 0.3 * i, 0], [0, 0, 40], [512, 512])),
                    new Skeleton('skeleton', nodes, [[0, 1], [1, 2]]), ['t0', 't1'], 'TrainRec');
                const ann = s.addIdentity('Ann'), bob = s.addIdentity('Bob');
                const mk = (f, ci, k, type) => new Instance(nodes.map((_, j) => [40 + 30 * k + 7 * j + ci + f * 0.25, 50 + 9 * j + k]), k, type, 0.8);
                let gid = 1;
                for (let f = 0; f < 40; f++) {
                    const fg = new FrameGroup(f);
                    s.addFrameGroup(fg);
                    const gs = [];
                    for (let k = 0; k < 2; k++) {
                        const g = new InstanceGroup(gid++, k === 0 ? ann.id : bob.id);
                        cams.forEach((cn, ci) => {
                            const user = (f % 4 === 0 && k === 0) || (f === 25 && k === 1 && cn === 'cam0');
                            const inst = mk(f, ci, k, user ? 'user' : 'predicted');
                            if (f === 0 && k === 0 && cn === 'cam0') inst.setOccluded(1, true);
                            if (f === 25 && k === 1 && cn === 'cam0') for (let j = 0; j < 3; j++) inst.setOccluded(j, true);
                            inst._rawInstIndex = k;
                            fg.addInstance(cn, inst);
                            g.addInstance(cn, inst);
                            s.setFrameIdentity(f, cn, k, k === 0 ? ann.id : bob.id);
                        });
                        g.points3d = new Float64Array([0, 0, 0, 1, 1, 1, 2, 2, 2].map(v => v + k));
                        gs.push(g);
                    }
                    s.instanceGroups.set(f, gs);
                    if (f === 15) {
                        const u = mk(f, 1, 2, 'user');
                        u.trackIdx = 1;
                        u._rawInstIndex = 2;
                        fg.addUnlinkedInstance('cam1', new UnlinkedInstance(u, 'cam1'));
                    }
                }
                return s;
            },
            sels(s, idx) {
                return ['cam0', 'cam1'].map((c, i) => ({ sessionIndex: idx || 0, session: s, cameraName: c,
                    videoFileInfo: { videoWidth: 512, videoHeight: 512, frameCount: 40 }, videoFilename: 'lucid-video-' + i + '.mp4' }));
            },
            // A plain description of a Labels object: per labeled frame, its video index, frame,
            // and each instance's kind, track and points.
            describe(labels) {
                const vids = labels.videos;
                return {
                    videos: vids.map(v => v.filename),
                    tracks: labels.tracks.map(t => t.name),
                    frames: labels.labeledFrames.map(lf => ({
                        v: vids.indexOf(lf.video), f: lf.frameIdx,
                        inst: lf.instances.map(i => ({
                            kind: i instanceof window.SleapIO.PredictedInstance ? 'predicted' : 'user',
                            track: i.track ? i.track.name : null,
                            pts: i.points.map(p => [Math.round(p.xy[0] * 100) / 100, Math.round(p.xy[1] * 100) / 100, p.visible ? 1 : 0]),
                        })),
                    })).sort((a, b) => a.v - b.v || a.f - b.f),
                };
            },
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
        };
    });

    console.log('1. Eager session');
    const eager = await page.evaluate(async () => {
        const ts = await import('/import-export/training-slp.js');
        const s = await window.__td.build();
        window.__tdEager = s;
        const out = ts.buildTrainingLabels(window.__td.sels(s), { split: { fraction: 0.1, seed: 5 } });
        const again = ts.buildTrainingLabels(window.__td.sels(s), { split: { fraction: 0.1, seed: 5 } });
        const train = window.__td.describe(out.train), val = window.__td.describe(out.val);
        const bytes = await ts.trainingSlpBytes(out.train);
        const valBytes = await ts.trainingSlpBytes(out.val);
        let loaded = null;
        try {
            // Read the file back with h5wasm: frames, instance types, videos, tracks.
            const h5 = await import('h5wasm');
            await h5.ready;
            const p = '/__td_' + Math.random().toString(36).slice(2) + '.slp';
            h5.FS.writeFile(p, bytes);
            const f = new h5.File(p, 'r');
            const inst = f.get('instances');
            const cols = JSON.parse(inst.attrs.field_names.value);
            const v = Array.from(inst.value, Number), nc = cols.length, ti = cols.indexOf('instance_type');
            const types = new Set();
            for (let r = 0; r < v.length / nc; r++) types.add(v[r * nc + ti]);
            const videos = Array.from(f.get('videos_json').value, s => JSON.parse(s).backend.filename);
            const tracks = Array.from(f.get('tracks_json').value, s => JSON.parse(s)[1]);
            loaded = { frames: f.get('frames').shape[0], types: [...types], videos, tracks };
            f.close();
            h5.FS.unlink(p);
        } catch (e) { loaded = { err: String(e && e.stack || e).slice(0, 400) }; }
        return { stats: out.stats, train, val, sameVal: [...again.split.val].sort().join() === [...out.split.val].sort().join(), loaded,
            dump: [Array.from(bytes), Array.from(valBytes)] };
    });
    if (process.env.DUMP_DIR) {
        // DUMP_DIR=… writes the two files, e.g. to read them with Python sleap-io.
        const fs = await import('node:fs');
        fs.mkdirSync(process.env.DUMP_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.DUMP_DIR, 'train.slp'), Buffer.from(eager.dump[0]));
        fs.writeFileSync(path.join(process.env.DUMP_DIR, 'val.slp'), Buffer.from(eager.dump[1]));
        console.log('  (wrote train.slp and val.slp to ' + process.env.DUMP_DIR + ')');
    }
    const all = eager.train.frames.concat(eager.val.frames);
    const insts = all.flatMap(fr => fr.inst);
    check(eager.stats.frames === 21 && eager.stats.instances === 21, '21 labelled frames, 21 user instances', eager.stats);
    check(eager.stats.skipped === 1, 'the instance with every node occluded is skipped', eager.stats.skipped);
    check(insts.every(i => i.kind === 'user'), 'only user Instances (no predictions, no reprojections)', [...new Set(insts.map(i => i.kind))]);
    check(JSON.stringify(eager.train.videos) === JSON.stringify(['lucid-video-0.mp4', 'lucid-video-1.mp4'])
        && JSON.stringify(eager.val.videos) === JSON.stringify(eager.train.videos), 'one video per view, same table in both files', eager.train.videos);
    check(JSON.stringify(eager.train.tracks) === '["Ann","Bob"]', 'tracks are the identity names', eager.train.tracks);
    check(insts.filter(i => i.track === 'Ann').length === 20 && insts.filter(i => i.track === 'Bob').length === 1,
        'identity per instance: 20 Ann, the unlinked one Bob', insts.map(i => i.track));
    const f0c0 = all.find(fr => fr.v === 0 && fr.f === 0);
    check(!!f0c0 && f0c0.inst[0].pts[1][2] === 0 && f0c0.inst[0].pts[0][2] === 1, 'the occluded node is stored invisible', f0c0 && f0c0.inst[0].pts);
    const valFrames = new Set(eager.val.frames.map(fr => fr.f));
    const trainFrames = new Set(eager.train.frames.map(fr => fr.f));
    check(eager.stats.moments === 11 && eager.stats.valMoments === 1 && valFrames.size === 1, '11 moments, 1 in validation', eager.stats);
    check([...valFrames].every(f => !trainFrames.has(f)), 'a moment is never on both sides', { val: [...valFrames] });
    check(eager.val.frames.length === ([...valFrames][0] === 15 ? 1 : 2), 'both views of the validation moment are in validation', eager.val.frames.map(fr => [fr.v, fr.f]));
    check(eager.sameVal, 'the split is reproducible');
    check(eager.loaded && !eager.loaded.err && eager.loaded.frames === eager.train.frames.length
        && JSON.stringify(eager.loaded.types) === '[0]' && eager.loaded.videos.length === 2,
        'the training file reads back: its frames, user instances only (instance_type 0), 2 videos', eager.loaded);

    console.log('2. Lazy project');
    const lazy = await page.evaluate(async () => {
        const ts = await import('/import-export/training-slp.js');
        const fileio = await import('/import-export/file-io.js');
        const s0 = window.__tdEager;
        const views = ['cam0', 'cam1'].map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: 40 }));
        const videoFiles = ['cam0', 'cam1'].map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const bytes = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(s0, views, videoFiles));
        const err = await window.__td.reopen(bytes, 'train-lazy.slp');
        if (err) return { err };
        const s = window.__lucid.state.session;
        // Evict every frame except 8 and 12, so the rest comes from the store.
        for (const f of [...s.frameGroups.keys()]) if (f !== 8 && f !== 12) s.frameGroups.delete(f);
        const residentBefore = s.frameGroups.size;
        const counts = ts.countUserLabels(s, ['cam0', 'cam1']);
        const base = window.__td.describe(ts.buildTrainingLabels(window.__td.sels(s), { split: { overfit: true } }).train);
        // Edit a resident user instance (frame 8, cam1) and add an unsaved one (frame 12, cam0).
        const pd = await import('/pose/pose-data.js');
        const fg8 = s.frameGroups.get(8);
        const u8 = (fg8.instances.get('cam1') || []).find(i => i.type === 'user');
        u8._ownXY ? u8._ownXY() : null;
        u8.setPoint(0, 300, 301);
        const fg12 = s.frameGroups.get(12);
        const extra = new pd.Instance([[200, 200], [210, 210], [220, 220]], null, 'user', 1);
        fg12.addUnlinkedInstance('cam0', new pd.UnlinkedInstance(extra, 'cam0'));
        const edited = window.__td.describe(ts.buildTrainingLabels(window.__td.sels(s), { split: { overfit: true } }).train);
        return { residentBefore, residentAfter: s.frameGroups.size, counts: Object.fromEntries(counts), base, edited };
    });
    if (lazy.err) {
        check(false, 'lazy reopen', lazy.err);
    } else {
        const eagerAll = { frames: eager.train.frames.concat(eager.val.frames).sort((a, b) => a.v - b.v || a.f - b.f) };
        check(lazy.residentBefore === 2 && lazy.residentAfter === 2, 'building did not hydrate the store frames', lazy);
        check(lazy.counts.cam0 && lazy.counts.cam0.frames === 11 && lazy.counts.cam1.frames === 11,
            'countUserLabels counts store rows and resident frames (cam0 also has frame 25)', lazy.counts);
        check(JSON.stringify(lazy.base.frames) === JSON.stringify(eagerAll.frames), 'lazy file = eager file (points, visibility, tracks)',
            { lazyN: lazy.base.frames.length, eagerN: eagerAll.frames.length });
        const e8 = lazy.edited.frames.find(fr => fr.v === 1 && fr.f === 8);
        check(!!e8 && e8.inst[0].pts[0][0] === 300 && e8.inst[0].pts[0][1] === 301, 'an edit on a resident frame is in the file', e8 && e8.inst[0].pts[0]);
        const e12 = lazy.edited.frames.find(fr => fr.v === 0 && fr.f === 12);
        check(!!e12 && e12.inst.length === 2 && e12.inst.some(i => i.pts[0][0] === 200 && i.track === null), 'an unsaved new instance is in the file, trackless', e12 && e12.inst.length);
    }

    console.log('3. Checks');
    const refusals = await page.evaluate(async () => {
        const ts = await import('/import-export/training-slp.js');
        const pd = await import('/pose/pose-data.js');
        const s = window.__tdEager;
        const out = {};
        const bad = await window.__td.build();
        bad.skeleton = new pd.Skeleton('skeleton', ['head', '${oc.env:HOME}', 'tail'], [[0, 1], [1, 2]]);
        try { ts.buildTrainingLabels(window.__td.sels(bad)); out.interp = 'built'; } catch (e) { out.interp = String(e.message); }
        const other = await window.__td.build();
        other.skeleton = new pd.Skeleton('skeleton', ['head', 'thorax', 'tail', 'extra'], [[0, 1], [1, 2]]);
        try { ts.buildTrainingLabels(window.__td.sels(s).concat(window.__td.sels(other, 1))); out.mismatch = 'built'; } catch (e) { out.mismatch = String(e.message); }
        const empty = await window.__td.build();
        for (const fg of empty.frameGroups.values()) {
            for (const list of fg.instances.values()) for (const i of list) i.type = 'predicted';
            for (const list of fg.unlinkedInstances.values()) for (const u of list) u.instance.type = 'predicted';
        }
        try { ts.buildTrainingLabels(window.__td.sels(empty)); out.empty = 'built'; } catch (e) { out.empty = String(e.message); }
        const two = ts.buildTrainingLabels(window.__td.sels(s).concat(window.__td.sels(s, 1)), { split: { fraction: 0.5, seed: 1 } });
        out.twoSessions = { moments: two.stats.moments, videos: two.stats.videos, val: two.stats.valMoments };
        return out;
    });
    check(/contains "\$\{"/.test(refusals.interp), 'a `${` node name is refused', refusals.interp);
    check(/differs/.test(refusals.mismatch), 'a skeleton mismatch is refused', refusals.mismatch);
    check(/No labelled instances/.test(refusals.empty), 'a project without user labels is refused', refusals.empty);
    check(refusals.twoSessions.moments === 22 && refusals.twoSessions.videos === 4 && refusals.twoSessions.val === 11,
        'two sessions: moments do not merge across sessions', refusals.twoSessions);

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
