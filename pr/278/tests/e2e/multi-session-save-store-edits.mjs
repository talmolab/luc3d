/**
 * multi-session-save-store-edits.mjs — a MULTI-session streaming save must
 * write the lazy store AS EDITED IN MEMORY, not as it is in the source files.
 *
 * `saveAllSessionsStreaming` (import-export/save-load.js) saves N lazy sessions
 * in two passes. PASS 1 builds each session's ref graph — the header track
 * list and every camera's `trackBase`, and each instance group's
 * `(labeled frame, instance offset)` refs — from the session's LIVE
 * `SioLazyLoader` stores, then evicts the loader. PASS 2 re-opens every camera
 * from its retained source `File` and appends THOSE stores. Two operations
 * edit the live store in place and are therefore not in the files:
 *
 *   - `remapTracksFromIdentity` (Propagate IDs → Tracks, track swap / rename /
 *     delete): rewrites `instancesData.track` and every `labels.tracks`;
 *   - `deleteInstanceRows` (Custom Instance Delete): compacts every
 *     `instancesData` column and renumbers each frame's
 *     `instance_id_start/end`.
 *
 * Pass 2 used to append the ORIGINAL columns under pass 1's header, so a
 * propagate came out with every instance on the wrong track name, deleted
 * instances came back, and a group whose member sat after a deleted row in the
 * same camera-frame pointed at the deleted instance's points. The single-session
 * save streams from the live loader and never had this.
 *
 * This edits one of two lazy sessions in both ways — swapping and renaming its
 * tracks, deleting rows, and grouping an instance whose row offset the delete
 * shifted — saves through the real `saveAllSessionsStreaming`, and reads the
 * file back two ways: raw (`readSlpStreaming`, so track names and points are
 * checked with no LUCID adapter in between) and through the real reopen +
 * group reconstruction. The other session is untouched and must come back
 * exactly as it went in.
 *
 * Confirmed to fail on the pre-fix build. Run: node tests/e2e/multi-session-save-store-edits.mjs
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
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 30000 });

    const r = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const fileio = await import('/import-export/file-io.js');
        const { SioLazyLoader } = await import('/loading/sio-lazy-loader.js');
        const AS = await import('/ui/app-state.js');
        const saveLoad = await import('/import-export/save-load.js');
        const slpimp = await import('/import-export/slp-import.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const SIO = window.SleapIO;

        const NF = 5, NODE_NAMES = ['nose', 'tail'];
        const SPECS = [
            { name: 'sessA', cams: ['a_cam0', 'a_cam1'], fx: 1000 },
            { name: 'sessB', cams: ['b_cam0', 'b_cam1'], fx: 2000 },
        ];
        // Instance on own track t (0 or 1) at frame f in camera ci: node 0 at
        // x = 10*(t+1) + f + 100*ci. Unique per (camera, frame, track), so a
        // point read back from the file says exactly which row it came from.
        const xOf = (t, f, ci) => 10 * (t + 1) + f + 100 * ci;

        async function cameraFile(cam, ci) {
            const skeleton = new SIO.Skeleton({ name: 'sk', nodes: NODE_NAMES });
            const video = new SIO.Video({ filename: cam + '.mp4', shape: [NF, 64, 64, 1] });
            const tracks = [new SIO.Track('t0'), new SIO.Track('t1')];
            const lfs = [];
            for (let f = 0; f < NF; f++) {
                const insts = [0, 1].map(t => new SIO.PredictedInstance({
                    points: [[xOf(t, f, ci), 5], [xOf(t, f, ci) + 1, 6]], skeleton, track: tracks[t], score: 0.9,
                }));
                lfs.push(new SIO.LabeledFrame({ video, frameIdx: f, instances: insts }));
            }
            const bytes = await SIO.saveSlpToBytes(new SIO.Labels({ skeletons: [skeleton], videos: [video], tracks, labeledFrames: lfs }));
            return new File([bytes], cam + '.slp');
        }
        function lucidInstance(t, f, ci, trackIdx, rawIdx) {
            const inst = new Instance([[xOf(t, f, ci), 5], [xOf(t, f, ci) + 1, 6]], trackIdx, 'predicted', 0.9);
            inst._rawInstIndex = rawIdx;
            return inst;
        }

        const sessions = [], views = [], videoFiles = [];
        for (const spec of SPECS) {
            const mtx = [[spec.fx, 0, 32], [0, spec.fx, 32], [0, 0, 1]];
            const cams = spec.cams.map((cn, ci) => new Camera(cn, mtx, [0, 0, 0, 0, 0], [0, 0.1 * ci, 0], [10 * ci, 0, 0], [64, 64]));
            const session = new Session(cams, new Skeleton('sk', NODE_NAMES, [[0, 1]]), ['t0', 't1'], spec.name);
            const loader = new SioLazyLoader();
            for (let ci = 0; ci < spec.cams.length; ci++) await loader.open(spec.cams[ci], await cameraFile(spec.cams[ci], ci));
            session.lazyLoader = loader;
            sessions.push(session);
            for (const cn of spec.cams) {
                views.push({ name: cn, videoWidth: 64, videoHeight: 64, frameCount: NF });
                videoFiles.push({ name: cn, assignedCamera: cn, videoPath: cn + '.mp4' });
            }
        }
        const [A, B] = sessions;

        // ---- edit session A's store in memory ------------------------------
        // 1. Delete a_cam0's t0 row at frame 2 (so its t1 row moves from
        //    offset 1 to 0) and BOTH of a_cam1's rows at frame 4.
        const del = A.lazyLoader.deleteInstanceRows(function (cam, f, offset) {
            return (cam === 'a_cam0' && f === 2 && offset === 0) || (cam === 'a_cam1' && f === 4);
        });
        // 2. Swap and rename: own t0 -> animal_y, t1 -> animal_x (what a
        //    Propagate IDs -> Tracks does to the column and the track lists).
        const NEW_TRACKS = ['animal_x', 'animal_y'];
        const remap = A.lazyLoader.remapTracksFromIdentity(NEW_TRACKS, function (cam, f, oldTrk) {
            return oldTrk === 0 ? 1 : (oldTrk === 1 ? 0 : -1);
        });
        A.tracks = NEW_TRACKS.slice();
        // A group at frame 2 over the t1 animal (now animal_x, index 0). Its
        // a_cam0 member is at offset 0 AFTER the delete — the case a restream
        // of the original rows resolves to the deleted t0 instance instead.
        {
            const fg = new FrameGroup(2); A.addFrameGroup(fg);
            const g = new InstanceGroup(1, null);
            const m0 = lucidInstance(1, 2, 0, 0, 0), m1 = lucidInstance(1, 2, 1, 0, 1);
            g.addInstance('a_cam0', m0); fg.addInstance('a_cam0', m0);
            g.addInstance('a_cam1', m1); fg.addInstance('a_cam1', m1);
            g.points3d = [[1, 2, 3], [4, 5, 6]];
            A.instanceGroups.set(2, [g]);
        }
        // Session B: untouched store, one group at frame 1 over t0.
        {
            const fg = new FrameGroup(1); B.addFrameGroup(fg);
            const g = new InstanceGroup(2, null);
            const m0 = lucidInstance(0, 1, 0, 0, 0), m1 = lucidInstance(0, 1, 1, 0, 0);
            g.addInstance('b_cam0', m0); fg.addInstance('b_cam0', m0);
            g.addInstance('b_cam1', m1); fg.addInstance('b_cam1', m1);
            g.points3d = [[7, 8, 9], [1, 1, 1]];
            B.instanceGroups.set(1, [g]);
        }

        AS.state.sessions = sessions; AS.state.session = A; AS.state.activeSessionIdx = 0;
        AS.state.views = views; AS.state.videoFiles = videoFiles;

        // `saveAllSessionsStreaming` is exactly begin + commit-each + finalize;
        // driving the three here lets the test see what pass 1 kept.
        let bytes, saveErr = null, kept = null;
        try {
            const handle = saveLoad.beginMultiSessionSave();
            for (const s of sessions) await saveLoad.commitSessionForMultiSessionSave(handle, s);
            kept = handle.pending.map(p => p.editedColumns ? Array.from(p.editedColumns.keys()).sort() : null);
            bytes = await saveLoad.finalizeMultiSessionSave(handle);
        } catch (e) { saveErr = String(e && e.stack || e); }
        if (saveErr) return { saveErr };

        // ---- read back, raw ------------------------------------------------
        const file = new File([bytes], 'multi.slp');
        const raw = await SIO.readSlpStreaming(file, {
            openVideos: false, h5wasmUrl: new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href,
        });
        const rows = {};   // "cam:frame" -> sorted ["trackName@x"]
        for (const lf of raw.labeledFrames) {
            const cam = String(lf.video.filename).replace(/\.mp4$/, '');
            const key = cam + ':' + lf.frameIdx;
            rows[key] = rows[key] || [];
            for (const inst of lf.instances) {
                rows[key].push((inst.track ? inst.track.name : '-') + '@' + inst.points[0].xy[0]);
            }
            rows[key].sort();
        }

        // ---- read back, through the real reopen + group reconstruction ------
        const slpData = await fileio.parseSlpViaSleapIO(new File([bytes], 'multi.slp'), () => {});
        const groups = [];
        for (let si = 0; si < (slpData.sessions || []).length; si++) {
            const s0 = slpData.sessions[si];
            const calibKeys = Object.keys(s0.calibration || {}).filter(k => k !== 'metadata');
            const fresh = new Session(
                calibKeys.map(k => { const c = s0.calibration[k]; return new Camera(c.name || k, c.matrix, c.distortions, c.rotation, c.translation, c.size); }),
                new Skeleton(slpData.skeleton.name, slpData.skeleton.nodes, slpData.skeleton.edges),
                slpData.tracks, 'reopened' + si);
            await slpimp.reconstructInstanceGroupsFromSession(fresh, s0._typedSession, s0, slpData.skeleton.nodes, {});
            for (const [f, gs] of fresh.instanceGroups) for (const g of gs) {
                const members = {};
                for (const [cam, inst] of g.instances) members[cam] = inst ? inst.getX(0) : null;
                groups.push({ session: si, frame: f, members });
            }
        }

        // ---- the guard: a source file that changed after loading ------------
        // Edit a one-camera session, then swap its source file for one with
        // MORE frames before pass 2 re-opens it. Writing the kept instance
        // columns against that file's rows would be silent corruption.
        let guardErr = null;
        {
            const mtx = [[900, 0, 32], [0, 900, 32], [0, 0, 1]];
            const C = new Session([new Camera('c_cam0', mtx, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [64, 64])],
                new Skeleton('sk', NODE_NAMES, [[0, 1]]), ['t0', 't1'], 'sessC');
            C.lazyLoader = new SioLazyLoader();
            await C.lazyLoader.open('c_cam0', await cameraFile('c_cam0', 0));
            C.lazyLoader.deleteInstanceRows((cam, f, offset) => f === 0 && offset === 0);
            AS.state.sessions = [C]; AS.state.session = C;
            AS.state.views = [{ name: 'c_cam0', videoWidth: 64, videoHeight: 64, frameCount: NF }];
            AS.state.videoFiles = [{ name: 'c_cam0', assignedCamera: 'c_cam0', videoPath: 'c_cam0.mp4' }];
            const handle = saveLoad.beginMultiSessionSave();
            await saveLoad.commitSessionForMultiSessionSave(handle, C);
            const skeleton = new SIO.Skeleton({ name: 'sk', nodes: NODE_NAMES });
            const video = new SIO.Video({ filename: 'c_cam0.mp4', shape: [NF + 3, 64, 64, 1] });
            const lfs = [];
            for (let f = 0; f < NF + 3; f++) lfs.push(new SIO.LabeledFrame({ video, frameIdx: f, instances: [
                new SIO.PredictedInstance({ points: [[1, 1], [2, 2]], skeleton, track: null, score: 0.5 })] }));
            const other = await SIO.saveSlpToBytes(new SIO.Labels({ skeletons: [skeleton], videos: [video], tracks: [], labeledFrames: lfs }));
            handle.pending[0].sourceFiles[0][1] = new File([other], 'c_cam0.slp');
            try { await saveLoad.finalizeMultiSessionSave(handle); }
            catch (e) { guardErr = String(e && e.message || e); }
        }

        return { del, remap: { changed: remap.changed, errorRows: remap.errorRows }, kept, rows, groups, guardErr };
    });

    if (r.saveErr) {
        check(false, 'saveAllSessionsStreaming did not throw: ' + r.saveErr);
    } else {
        const xOf = (t, f, ci) => 10 * (t + 1) + f + 100 * ci;
        check(r.del.deleted === 3 && r.remap.changed > 0 && r.remap.errorRows === 0,
            `setup: 3 rows deleted, ${r.remap.changed} track ids remapped in session A's live store`);

        // Session A: what the live store said, frame by frame.
        const wantA = {};
        ['a_cam0', 'a_cam1'].forEach((cam, ci) => {
            for (let f = 0; f < 5; f++) {
                const list = [];
                if (!(cam === 'a_cam0' && f === 2)) list.push('animal_y@' + xOf(0, f, ci));   // own t0
                list.push('animal_x@' + xOf(1, f, ci));                                       // own t1
                wantA[cam + ':' + f] = (cam === 'a_cam1' && f === 4) ? [] : list.sort();
            }
        });
        const badA = Object.keys(wantA).filter(k => JSON.stringify(r.rows[k] || []) !== JSON.stringify(wantA[k]));
        check(badA.length === 0,
            'session A: every frame written as edited — renamed/swapped tracks, deleted rows gone' +
            (badA.length ? ` — ${badA.length} wrong, e.g. ${badA.slice(0, 3).map(k => k + ' got ' + JSON.stringify(r.rows[k] || []) + ' want ' + JSON.stringify(wantA[k])).join('; ')}` : ''));

        // Session B: exactly as it went in.
        const wantB = {};
        ['b_cam0', 'b_cam1'].forEach((cam, ci) => {
            for (let f = 0; f < 5; f++) wantB[cam + ':' + f] = ['t0@' + xOf(0, f, ci), 't1@' + xOf(1, f, ci)].sort();
        });
        const badB = Object.keys(wantB).filter(k => JSON.stringify(r.rows[k] || []) !== JSON.stringify(wantB[k]));
        check(badB.length === 0, 'session B (not edited): every frame as in its source files' +
            (badB.length ? ` — e.g. ${badB.slice(0, 2).map(k => k + ' got ' + JSON.stringify(r.rows[k])).join('; ')}` : ''));

        check(JSON.stringify(r.kept) === JSON.stringify([['a_cam0', 'a_cam1'], null]),
            `pass 1 kept columns for the edited session only (got ${JSON.stringify(r.kept)}) — an unedited ` +
            'session is still fully evicted');

        const gA = r.groups.find(g => g.session === 0 && g.frame === 2);
        check(!!gA && gA.members.a_cam0 === xOf(1, 2, 0) && gA.members.a_cam1 === xOf(1, 2, 1),
            `session A's group resolves to the instances it grouped, past the deleted row ` +
            `(a_cam0 x=${gA && gA.members.a_cam0}, want ${xOf(1, 2, 0)}; a_cam1 x=${gA && gA.members.a_cam1}, want ${xOf(1, 2, 1)})`);
        const gB = r.groups.find(g => g.session === 1 && g.frame === 1);
        check(!!gB && gB.members.b_cam0 === xOf(0, 1, 0) && gB.members.b_cam1 === xOf(0, 1, 1),
            `session B's group is untouched (b_cam0 x=${gB && gB.members.b_cam0}, b_cam1 x=${gB && gB.members.b_cam1})`);
    }
    if (!r.saveErr) {
        check(!!r.guardErr && /no longer matches/.test(r.guardErr),
            `a source file that changed after loading is refused, not written against the wrong rows (got ${JSON.stringify(r.guardErr)})`);
    }
    // The guard's refusal is expected to log through the save path's own error
    // reporting; nothing else may.
    const unexpected = errs.filter(e => !/no longer matches/.test(e));
    check(unexpected.length === 0, `no page/console errors (got ${JSON.stringify(unexpected.slice(0, 3))})`);
    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
