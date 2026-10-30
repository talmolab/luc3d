/**
 * percam-slp-choice-export-time.mjs — a camera directory's `.slp` is chosen by
 * when LUC3D EXPORTED it, not by its file name (#214).
 *
 * Reported as "I exported the .slp files, put them back in the session folder,
 * reloaded, and only some of the views came back". Reproduced on a real
 * 8-camera folder: every camera dir still held a `_v1` from an earlier "Export
 * SLEAP File Per Session", and "Export SLEAP File By Cam" writes `<camera>.slp`
 * with NO suffix — so under "highest `_vN` wins" every camera reloaded the
 * stale `_v1` (no user labels anywhere), and the two cameras whose stale `_v1`
 * was EMPTY came back blank. Only a status-bar note hinted at it.
 *
 * `handleLoadSessionFolderPerCamera` now reads each candidate's provenance
 * (`readSlpProvenances`: the `metadata` attribute only) and `chooseCameraSlp`
 * loads the newest LUC3D export by its `exported_at`, which travels inside the
 * file. Six cameras, each one a way the old rule lost data or would have:
 *
 *   cam1  the reported folder: stale `cam1_v1.slp` (older on disk) + fresh
 *         unversioned `cam1.slp` (newer on disk)          → the fresh file
 *   cam2  the same pair copied in one go (equal mtimes)   → the fresh file
 *   cam3  mtimes INVERTED (a sync touched the old file)   → the chooser asks
 *         (disk order disagrees with export order: a SLEAP re-save of an older
 *         export keeps its stamp, so only the user can tell), with the fresh
 *         file pre-selected — the old file never loads on its own
 *   cam4  the stale `_v1` is EMPTY (the blank-view case)  → the fresh file
 *   cam5  a LUC3D export + a SLEAP prediction written AFTER it → the only
 *         camera the data-file chooser asks about (#413), with the export
 *         pre-selected; Save Options loads it and remembers the choice
 *   cam6  an unreadable `cam6_v2.slp` beside a good export → the good export
 *         (the suffix used to pick the broken file and leave the view empty)
 *
 * Every candidate carries its own track name and instance count, so each
 * assertion names the file that was actually read. Real videos (encoded
 * in-page via `ui/video-encode.js`) and the app's own exporter, so the whole
 * load is the production path.
 *
 * Run: node tests/e2e/percam-slp-choice-export-time.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8273);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrs = [];
    const logs = [];
    page.on('pageerror', e => pageErrs.push(String(e).slice(0, 300)));
    page.on('console', m => { if (/\[data-files\]|\[slp-provenance\]/.test(m.text())) logs.push(m.text()); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 30000 });

    const r = await page.evaluate(async () => {
        const enc = await import('/ui/video-encode.js');
        const loader = await import('/loading/session-loader.js');
        const fio = await import('/import-export/file-io.js');
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const SIO = window.SleapIO;

        const CAMS = ['cam1', 'cam2', 'cam3', 'cam4', 'cam5', 'cam6'];
        const NFRAMES = 12, W = 320, H = 240, ROOT = 'sess';
        const tick = () => new Promise(res => setTimeout(res, 15));   // distinct exported_at ms

        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const cctx = canvas.getContext('2d');
        const wr = await enc.createMp4Writer({
            canvas, width: W, height: H, fps: 10,
            bitrate: 400000, frameCount: NFRAMES, keyFrameEveryFrames: 4,
        });
        for (let i = 0; i < NFRAMES; i++) {
            cctx.fillStyle = 'rgb(' + (20 * i) + ',40,80)'; cctx.fillRect(0, 0, W, H);
            await wr.addFrame(i);
        }
        const mp4 = (await wr.finish()).blob;

        let toml = '';
        CAMS.forEach((cn, i) => {
            toml += '[cam_' + i + ']\nname = "' + cn + '"\nsize = [' + W + ', ' + H + ']\n'
                + 'matrix = [[600.0, 0.0, 160.0], [0.0, 600.0, 120.0], [0.0, 0.0, 1.0]]\n'
                + 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\n'
                + 'rotation = [0.0, ' + (0.2 * i) + ', 0.0]\ntranslation = ['
                + (15 * i) + ', 0.0, 0.0]\n\n';
        });

        function mkFile(bits, relPath, lastModified) {
            const f = new File(bits, relPath.split('/').pop(),
                { type: 'application/x-hdf5', lastModified: lastModified });
            Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
            return f;
        }

        // A LUC3D one-camera export whose track name and count identify it.
        // perFrame 0 gives an export with no frames at all (cam4's stale file).
        async function lucidExport(cam, tag, perFrame) {
            const K = [[600, 0, 160], [0, 600, 120], [0, 0, 1]];
            const cams = CAMS.map((n, i) =>
                new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [W, H]));
            const skel = new pd.Skeleton('sk', ['nose', 'body', 'tail'], [[0, 1], [1, 2]]);
            const s = new pd.Session(cams, skel, [tag + '_track'], 'gen');
            for (let f = 0; f < 4 && perFrame > 0; f++) {
                const fg = new pd.FrameGroup(f);
                s.addFrameGroup(fg);
                for (let t = 0; t < perFrame; t++) {
                    fg.addInstance(cam, new pd.Instance(
                        [[10 + f, 20], [30 + f, 40], [50 + f, 60]], 0, 'user', 1));
                }
            }
            const vfi = {
                videoPath: ROOT + '/' + cam + '/' + cam + '.mp4', file: null,
                videoWidth: W, videoHeight: H, frameCount: NFRAMES,
            };
            const blob = await fio.exportSlpClientSide(s, cam, false, vfi, cam + '.slp', null);
            await tick();
            return blob;
        }

        // A file ANOTHER program wrote: SLEAP-style predictions, with a
        // provenance that is not LUC3D's.
        async function sleapPredictions(cam, tag, perFrame) {
            const nodes = ['nose', 'body', 'tail'].map(n => new SIO.Node(n));
            const sk = new SIO.Skeleton({ nodes, edges: [new SIO.Edge(nodes[0], nodes[1])], name: 'sk' });
            const fname = ROOT + '/' + cam + '/' + cam + '.mp4';
            const video = new SIO.Video({
                filename: fname,
                backendMetadata: { type: 'MediaVideo', shape: [NFRAMES, H, W, 1], filename: fname, grayscale: false, bgr: false },
                openBackend: false,
            });
            video.shape = [NFRAMES, H, W, 1];
            const track = new SIO.Track(tag + '_track');
            const lfs = [];
            for (let f = 0; f < 4; f++) {
                const insts = [];
                for (let t = 0; t < perFrame; t++) {
                    insts.push(new SIO.PredictedInstance({
                        points: [[10 + f, 20], [30 + f, 40], [50 + f, 60]].map(xy => ({ xy, visible: true, complete: true, score: 0.9 })),
                        skeleton: sk, track: track, score: 0.9,
                    }));
                }
                lfs.push(new SIO.LabeledFrame({ video, frameIdx: f, instances: insts }));
            }
            const labels = new SIO.Labels({
                labeledFrames: lfs, videos: [video], skeletons: [sk], tracks: [track],
                provenance: { source: 'sleap', sleap_version: '1.4.1' },
            });
            return new Blob([await SIO.saveSlpToBytes(labels)]);
        }

        const OLD_T = 1000, NEW_T = 2000;   // fake mtimes
        const P = (cam, name) => ROOT + '/' + cam + '/' + name;
        const files = [mkFile([toml], ROOT + '/calibration.toml', 1)];
        for (const cn of CAMS) files.push(mkFile([mp4], P(cn, cn + '.mp4'), 1));

        // Export order is the truth each camera is checked against: OLD first.
        const ex = {};
        for (const cn of ['cam1', 'cam2', 'cam3']) ex[cn + 'old'] = await lucidExport(cn, 'OLD_' + cn, 1);
        ex.cam4old = await lucidExport('cam4', 'EMPTY_cam4', 0);
        ex.cam5 = await lucidExport('cam5', 'NEW_cam5', 3);
        for (const cn of ['cam1', 'cam2', 'cam3', 'cam4', 'cam6']) ex[cn + 'new'] = await lucidExport(cn, 'NEW_' + cn, 3);
        const sleap5 = await sleapPredictions('cam5', 'SLEAP_cam5', 2);

        files.push(mkFile([ex.cam1old], P('cam1', 'cam1_v1.slp'), OLD_T));
        files.push(mkFile([ex.cam1new], P('cam1', 'cam1.slp'), NEW_T));
        files.push(mkFile([ex.cam2old], P('cam2', 'cam2_v1.slp'), NEW_T));
        files.push(mkFile([ex.cam2new], P('cam2', 'cam2.slp'), NEW_T));
        files.push(mkFile([ex.cam3old], P('cam3', 'cam3_v1.slp'), NEW_T));      // inverted
        files.push(mkFile([ex.cam3new], P('cam3', 'cam3.slp'), OLD_T));
        files.push(mkFile([ex.cam4old], P('cam4', 'cam4_v1.slp'), OLD_T));
        files.push(mkFile([ex.cam4new], P('cam4', 'cam4.slp'), NEW_T));
        files.push(mkFile([ex.cam5], P('cam5', 'cam5_v1.slp'), OLD_T));
        files.push(mkFile([sleap5], P('cam5', 'cam5.predictions.slp'), NEW_T));
        files.push(mkFile([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], P('cam6', 'cam6_v2.slp'), OLD_T));
        files.push(mkFile([ex.cam6new], P('cam6', 'cam6.slp'), OLD_T));

        // What the suffix rule ALONE picks for each camera — the negative control.
        const byCam = {};
        for (const f of files) {
            const cn = f.webkitRelativePath.split('/')[1];
            if (/\.slp$/.test(f.name)) (byCam[cn] = byCam[cn] || []).push(f);
        }
        const suffixPick = {};
        for (const cn of CAMS) suffixPick[cn] = loader.chooseCameraSlp(byCam[cn]).file.name;

        // The provenance reader itself, on one camera's candidates.
        const provs = await fio.readSlpProvenances(byCam.cam5.concat(byCam.cam6));

        AS.state.sessions = []; AS.state.activeSessionIdx = 0;
        AS.state.videoFiles = []; AS.state.session = null; AS.state.views = [];
        try { localStorage.removeItem('lucidDataFileChoices'); } catch (e) { /* ignore */ }
        // Answer the data-file chooser as a user who keeps its defaults would,
        // recording what it showed.
        const dialogs = [];
        const poll = setInterval(() => {
            const m = document.querySelector('.data-file-chooser');
            if (!m) return;
            dialogs.push([...m.querySelectorAll('tbody tr')].map(tr => ({
                cam: tr.querySelector('.dfc-cam').textContent, cls: tr.className,
                sel: tr.querySelector('select').selectedOptions[0].textContent,
            })));
            m.querySelector('#dfcSave').click();
        }, 50);
        await loader.handleLoadSessionFolderPerCamera(files, false);
        clearInterval(poll);
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem('lucidDataFileChoices')); } catch (e) { /* ignore */ }

        const s = AS.state.session;
        const per = {}, userPer = {}, predPer = {};
        for (const c of s.cameras) { per[c.name] = 0; userPer[c.name] = 0; predPer[c.name] = 0; }
        for (const [, fg] of s.frameGroups) {
            const add = (cn, inst) => {
                per[cn]++;
                if (inst.type === 'user') userPer[cn]++; else predPer[cn]++;
            };
            for (const [cn, xs] of fg.instances) xs.forEach(x => add(cn, x));
            for (const [cn, xs] of fg.unlinkedInstances) xs.forEach(u => add(cn, u.instance));
        }
        return {
            views: AS.state.views.map(v => v.name),
            tracks: s.tracks.slice(),
            per, userPer, predPer, suffixPick,
            provs: provs.map(p => p && { source: p.source, exported_at: p.exported_at }),
            dialogs, saved, dataFileChoices: s.dataFileChoices,
            status: (document.getElementById('statusText') || {}).textContent || '',
            statusDot: (document.getElementById('statusDot') || {}).className || '',
        };
    });

    console.log('  measured:', JSON.stringify(r).slice(0, 900));

    // ---- negative control: the suffix rule alone loses on every camera ------
    check(r.suffixPick.cam1 === 'cam1_v1.slp' && r.suffixPick.cam4 === 'cam4_v1.slp'
        && r.suffixPick.cam6 === 'cam6_v2.slp',
        `the suffix rule alone would load the stale/empty/unreadable file (${JSON.stringify(r.suffixPick)})`);

    // ---- the reader ---------------------------------------------------------
    check(r.provs[0] && r.provs[0].source === 'lucid' && !!r.provs[0].exported_at,
        `readSlpProvenances reads a LUC3D export's stamp (got ${JSON.stringify(r.provs[0])})`);
    check(r.provs[1] && r.provs[1].source === 'sleap' && !r.provs[1].exported_at,
        `…and another program's provenance as it is (got ${JSON.stringify(r.provs[1])})`);
    check(r.provs[2] === null, 'an unreadable file gives null, not an error');

    // ---- what loaded ---------------------------------------------------------
    check(r.views.length === 6, `all 6 views exist (got ${JSON.stringify(r.views)})`);
    check(r.per.cam1 === 12, `cam1 (the reported folder): the later export, not the stale _v1 (got ${r.per.cam1}, want 12)`);
    check(r.per.cam2 === 12, `cam2 (copied folder, equal mtimes): the later export (got ${r.per.cam2})`);
    check(r.per.cam3 === 12, `cam3 (old file touched later): the later export, the chooser's default (got ${r.per.cam3})`);
    check(r.per.cam4 === 12, `cam4 (stale _v1 is EMPTY): the view is not blank (got ${r.per.cam4})`);
    check(r.per.cam5 === 12 && r.userPer.cam5 === 12 && r.predPer.cam5 === 0,
        `cam5: the LUC3D export loads over the later SLEAP file (got ${r.userPer.cam5} user / ${r.predPer.cam5} predicted)`);
    check(r.per.cam6 === 12, `cam6: the good export loads over an unreadable higher version (got ${r.per.cam6})`);
    check(r.tracks.every(t => t.startsWith('NEW_')),
        `only the files exported last were read (tracks ${JSON.stringify(r.tracks)})`);

    // ---- the one question asked ----------------------------------------------
    const d = r.dialogs[0] || [];
    const asked = d.filter(x => /dfc-attention|dfc-missing/.test(x.cls)).map(x => x.cam);
    check(r.dialogs.length === 1 && JSON.stringify(asked) === '["cam3","cam5"]',
        `the chooser opened once, asking about cam3 and cam5 only (got ${JSON.stringify(r.dialogs)})`);
    const c3 = d.find(x => x.cam === 'cam3');
    check(c3 && /^LUC3D export, .* — cam3\.slp$/.test(c3.sel),
        `cam3's later export is pre-selected over the old file touched later (got ${JSON.stringify(c3)})`);
    const c5 = d.find(x => x.cam === 'cam5');
    check(c5 && /^LUC3D export, .* — cam5_v1\.slp$/.test(c5.sel),
        `with cam5's LUC3D export pre-selected over the later SLEAP file (got ${JSON.stringify(c5)})`);
    const c1 = d.find(x => x.cam === 'cam1');
    check(c1 && /^LUC3D export, .* — cam1\.slp$/.test(c1.sel), `the settled rows show the file the rule chose (got ${JSON.stringify(c1)})`);
    check(r.saved && JSON.stringify(r.saved.sess) === '{"cam3":"cam3.slp","cam5":"cam5_v1.slp"}',
        `Save Options remembers only the rows the user decided (got ${JSON.stringify(r.saved)})`);
    check(r.dataFileChoices && JSON.stringify(r.dataFileChoices) === '{"cam3":"cam3/cam3.slp","cam5":"cam5/cam5_v1.slp"}',
        `and the session carries it for project.slp (got ${JSON.stringify(r.dataFileChoices)})`);

    // ---- and what it said ----------------------------------------------------
    check(r.status === 'Loaded 6 camera(s)', `a plain success (got "${r.status}")`);
    check(logs.some(l => /cam1: "cam1\.slp" \(auto, newest-export\)/.test(l)),
        'the console says the newest export was chosen on its own');
    check(logs.some(l => /cam5: "cam5_v1\.slp" \(chosen\)/.test(l)),
        'and that cam5 was the user\'s choice');

    check(pageErrs.length === 0, `no uncaught page errors (got ${JSON.stringify(pageErrs.slice(0, 2))})`);
    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
