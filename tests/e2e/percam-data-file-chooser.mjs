/**
 * percam-data-file-chooser.mjs — which data file each camera of a per-camera
 * session folder loads, and when the user is asked (#413, #214).
 *
 * #413: a SLAP-2M session downloaded from Hugging Face holds five candidates per
 * camera (`*.predictions.proofread.slp`, its `.analysis.h5`, `*.predictions.slp`,
 * `*.reprojections.slp`, its `.h5`); with no `_vN` anywhere the newest file on
 * disk won, and every camera loaded REPROJECTIONS. Now the loader decides only
 * when there is nothing to decide, and otherwise asks:
 *
 *   auto   one data file; or only `.slp` files with the newest LUC3D export
 *          newest overall; an `X.slp.*.h5` beside `X.slp` does not count
 *   ask    several files, none LUC3D's; a LUC3D export with a NEWER SLEAP
 *          `.slp`; a mix of `.slp` and `.h5`; a saved file that has gone
 *
 * Covered here, all through the shipping loaders with real in-page video:
 *   §1 a folder with nothing to decide loads without the dialog
 *   §2 the dialog: which rows it marks, the defaults, a changed row, Save
 *      Options → what loads, what is remembered (browser) and what the session
 *      carries for a saved project (`dataFileChoices`)
 *   §3 the saved choice is reused with no dialog — even with a NEWER LUC3D
 *      export added since (new files are ignored by design)
 *   §4 a saved file that is gone: dialog, that row red; Esc cancels and the
 *      app is left exactly as it was
 *   §5 multi-session (File ▸ Load Multiple Sessions, real directory-handle
 *      walk): ONE dialog, one tab per session, the tab needing a choice first
 *
 * Run: node tests/e2e/percam-data-file-chooser.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8274);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrs = [];
    page.on('pageerror', e => pageErrs.push(String(e).slice(0, 300)));

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 30000 });

    // ---- fixtures, built once in the page ---------------------------------
    await page.evaluate(async () => {
        try { localStorage.clear(); } catch (e) { /* none */ }
        const enc = await import('/ui/video-encode.js');
        const fio = await import('/import-export/file-io.js');
        const pd = await import('/pose/pose-data.js');
        const SIO = window.SleapIO;
        const NFRAMES = 12, W = 320, H = 240;
        const CAMS = ['cam1', 'cam2', 'cam3', 'cam4'];

        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const cctx = canvas.getContext('2d');
        const wr = await enc.createMp4Writer({ canvas, width: W, height: H, fps: 10, bitrate: 400000, frameCount: NFRAMES, keyFrameEveryFrames: 4 });
        for (let i = 0; i < NFRAMES; i++) { cctx.fillStyle = 'rgb(' + (20 * i) + ',40,80)'; cctx.fillRect(0, 0, W, H); await wr.addFrame(i); }
        const mp4 = (await wr.finish()).blob;

        let toml = '';
        CAMS.forEach((cn, i) => {
            toml += '[cam_' + i + ']\nname = "' + cn + '"\nsize = [' + W + ', ' + H + ']\n'
                + 'matrix = [[600.0, 0.0, 160.0], [0.0, 600.0, 120.0], [0.0, 0.0, 1.0]]\n'
                + 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\n'
                + 'rotation = [0.0, ' + (0.2 * i) + ', 0.0]\ntranslation = [' + (15 * i) + ', 0.0, 0.0]\n\n';
        });

        const tick = () => new Promise(res => setTimeout(res, 15));
        async function lucidExport(cam, tag, perFrame) {
            const K = [[600, 0, 160], [0, 600, 120], [0, 0, 1]];
            const cams = CAMS.map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [W, H]));
            const s = new pd.Session(cams, new pd.Skeleton('sk', ['nose', 'body', 'tail'], [[0, 1], [1, 2]]), [tag + '_track'], 'gen');
            for (let f = 0; f < 4; f++) {
                const fg = new pd.FrameGroup(f);
                s.addFrameGroup(fg);
                for (let t = 0; t < perFrame; t++) fg.addInstance(cam, new pd.Instance([[10 + f, 20], [30 + f, 40], [50 + f, 60]], 0, 'user', 1));
            }
            const blob = await fio.exportSlpClientSide(s, cam, false,
                { videoPath: cam + '.mp4', file: null, videoWidth: W, videoHeight: H, frameCount: NFRAMES }, cam + '.slp', null);
            await tick();
            return blob;
        }
        function sleapLabels(cam, tag, perFrame) {
            const nodes = ['nose', 'body', 'tail'].map(n => new SIO.Node(n));
            const sk = new SIO.Skeleton({ nodes, edges: [new SIO.Edge(nodes[0], nodes[1])], name: 'sk' });
            const video = new SIO.Video({ filename: cam + '.mp4',
                backendMetadata: { type: 'MediaVideo', shape: [NFRAMES, H, W, 1], filename: cam + '.mp4', grayscale: false, bgr: false },
                openBackend: false });
            video.shape = [NFRAMES, H, W, 1];
            const tracks = [];
            const lfs = [];
            for (let t = 0; t < perFrame; t++) tracks.push(new SIO.Track(tag + '_track' + (t ? '_' + t : '')));
            for (let f = 0; f < 4; f++) {
                lfs.push(new SIO.LabeledFrame({ video, frameIdx: f, instances: tracks.map((tr, t) => new SIO.PredictedInstance({
                    points: [[10 + f + 40 * t, 20], [30 + f + 40 * t, 40], [50 + f + 40 * t, 60]].map(xy => ({ xy, visible: true, complete: true, score: 0.9 })),
                    skeleton: sk, track: tr, score: 0.9 })) }));
            }
            return new SIO.Labels({ labeledFrames: lfs, videos: [video], skeletons: [sk], tracks,
                provenance: { sleap_version: '1.2.9' } });
        }
        const sleapSlp = async (cam, tag, n) => new Blob([await SIO.saveSlpToBytes(sleapLabels(cam, tag, n))]);
        // The analysis writer is not on window.SleapIO; the bundle is the same module instance.
        const SIOmod = await import('/lib/sleap-io/index.browser.js');
        const analysisH5 = async (cam, tag, n) => new Blob([await SIOmod.saveAnalysisH5ToBytes(sleapLabels(cam, tag, n))]);

        window.__F = {
            mp4, toml,
            proof1: await sleapSlp('cam1', 'PROOF', 2),
            proof1h5: await analysisH5('cam1', 'PROOFH5', 2),
            pred1: await sleapSlp('cam1', 'PRED', 1),
            reproj1: await sleapSlp('cam1', 'REPROJ', 3),
            reproj1h5: await analysisH5('cam1', 'REPROJH5', 3),
            lucid2: await lucidExport('cam2', 'LUCID2', 3),
            newsleap2: await sleapSlp('cam2', 'NEWSLEAP', 1),
            oldsleap3: await sleapSlp('cam3', 'OLDSLEAP', 1),
            lucid3: await lucidExport('cam3', 'LUCID3', 3),
            h5only4: await analysisH5('cam4', 'H5ONLY', 2),
            lucid1late: await lucidExport('cam1', 'LATE1', 3),
        };
        window.__mk = function (blob, rel, mtime) {
            const f = new File([blob], rel.split('/').pop(), { type: 'application/octet-stream', lastModified: mtime });
            Object.defineProperty(f, 'webkitRelativePath', { value: rel });
            return f;
        };
        // [relative-to-session path, fixture key, mtime]
        window.__folder = function (root, entries) {
            const F = window.__F, mk = window.__mk;
            const files = [mk(new Blob([F.toml]), root + '/calibration.toml', 1)];
            for (const cn of CAMS) files.push(mk(F.mp4, root + '/' + cn + '/' + cn + '.mp4', 1));
            for (const [rel, key, mtime] of entries) files.push(mk(F[key], root + '/' + rel, mtime));
            return files;
        };
        window.__census = function () {
            const AS = window.__lucid.state, s = AS.session;
            const per = {};
            if (!s) return null;
            for (const c of s.cameras) per[c.name] = { n: 0, tracks: new Set() };
            for (const [, fg] of s.frameGroups) {
                for (const [cn, xs] of fg.unlinkedInstances) for (const u of xs) {
                    per[cn].n++;
                    const ti = u.instance.trackIdx;
                    per[cn].tracks.add(ti != null && ti >= 0 ? s.tracks[ti] : '(none)');
                }
                for (const [cn, xs] of fg.instances) for (const x of xs) { per[cn].n++; per[cn].tracks.add(s.tracks[x.trackIdx]); }
            }
            const out = {};
            for (const k in per) out[k] = { n: per[k].n, tracks: Array.from(per[k].tracks).sort() };
            return out;
        };
        window.__dialogs = 0;
        new MutationObserver(() => {
            const d = document.querySelector('.data-file-chooser');
            if (d && !d.dataset.counted) { d.dataset.counted = '1'; window.__dialogs++; }
        }).observe(document.body, { childList: true, subtree: true });
    });

    const OLD = 1000, MID = 2000, NEW = 3000, NEWEST = 4000;
    const SESS_A = [
        ['cam1/cam1.predictions.proofread.slp', 'proof1', OLD],
        ['cam1/cam1.predictions.proofread.slp.analysis.h5', 'proof1h5', OLD],
        ['cam1/cam1.predictions.slp', 'pred1', OLD],
        ['cam1/cam1.reprojections.slp', 'reproj1', NEW],          // written last, as hf did
        ['cam1/cam1.reprojections.slp.h5', 'reproj1h5', NEWEST],
        ['cam2/cam2_v1.slp', 'lucid2', MID],
        ['cam2/cam2.predictions.slp', 'newsleap2', NEW],           // SLEAP file NEWER than the export
        ['cam3/cam3.predictions.slp', 'oldsleap3', OLD],
        ['cam3/cam3.slp', 'lucid3', NEW],
        ['cam4/cam4.predictions.analysis.h5', 'h5only4', OLD],
    ];

    // Start a load; resolves once it returns (the dialog, if any, is answered
    // from Node while it is pending).
    const startLoad = (root, entries) => page.evaluate(({ root, entries }) => {
        window.__loadDone = false;
        window.__loadPromise = import('/loading/session-loader.js').then(sl =>
            sl.handleLoadSessionFolderPerCamera(window.__folder(root, entries), false)).then(() => { window.__loadDone = true; });
    }, { root, entries });
    const waitLoad = () => page.waitForFunction(() => window.__loadDone === true, { timeout: 120000 });

    // ---- §1 nothing to decide ---------------------------------------------
    console.log('\n-- §1 a folder with nothing to decide loads without asking --');
    await startLoad('sessAuto', [
        ['cam1/cam1.predictions.proofread.slp', 'proof1', OLD],
        ['cam1/cam1.predictions.proofread.slp.analysis.h5', 'proof1h5', NEW],   // derived: not a competitor
        ['cam2/cam2_v1.slp', 'lucid2', NEW],
        ['cam2/cam2.predictions.slp', 'newsleap2', OLD],                         // SLEAP file OLDER than the export
        ['cam3/cam3.slp', 'lucid3', OLD],
        ['cam4/cam4.predictions.analysis.h5', 'h5only4', OLD],
    ]);
    await waitLoad();
    const r1 = await page.evaluate(() => ({ census: window.__census(), dialogs: window.__dialogs,
        choices: window.__lucid.state.session.dataFileChoices, status: document.getElementById('statusText').textContent }));
    console.log('  ' + JSON.stringify(r1).slice(0, 400));
    check(r1.dialogs === 0, 'no dialog');
    check(r1.census.cam1.tracks.join() === 'PROOF_track,PROOF_track_1',
        `cam1: the .slp, not its own .analysis.h5 export (got ${r1.census.cam1.tracks})`);
    check(r1.census.cam2.tracks.join() === 'LUCID2_track', `cam2: the LUC3D export over an older SLEAP file (got ${r1.census.cam2.tracks})`);
    check(r1.census.cam3.n === 12, `cam3: the one file (got ${r1.census.cam3.n})`);
    check(r1.census.cam4.n === 8, `cam4: the one analysis .h5 (got ${r1.census.cam4.n})`);
    check(r1.choices === null, 'nothing the user chose, so nothing for a saved project to carry');

    // ---- §2 the dialog ------------------------------------------------------
    console.log('\n-- §2 a SLAP-2M-like folder asks, with sensible defaults --');
    await startLoad('sessA', SESS_A);
    await page.waitForSelector('.data-file-chooser', { timeout: 60000 });
    const d2 = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.dfc-table tbody tr')).map(tr => {
            const sel = tr.querySelector('select');
            return {
                cam: tr.querySelector('.dfc-cam').textContent,
                cls: tr.className,
                selected: sel.options[sel.selectedIndex].textContent,
                options: Array.from(sel.options).map(o => o.textContent),
            };
        });
        return { rows, tabs: document.querySelectorAll('.dfc-tab').length,
                 loadingCardVisible: !!document.querySelector('#loadingOverlay:not(.hidden)') };
    });
    console.log('  ' + JSON.stringify(d2).slice(0, 700));
    const row = (c) => d2.rows.find(r => r.cam === c) || {};
    check(d2.rows.length === 4 && d2.tabs === 0, `one session: four camera rows, no tabs (got ${d2.rows.length} rows, ${d2.tabs} tabs)`);
    check(/dfc-attention/.test(row('cam1').cls) && /dfc-attention/.test(row('cam2').cls),
        'cam1 (several SLEAP files) and cam2 (a SLEAP file newer than the export) are marked');
    check(!/dfc-attention/.test(row('cam3').cls) && !/dfc-attention/.test(row('cam4').cls), 'cam3 and cam4 are not');
    check(/^proofread — cam1\.predictions\.proofread\.slp$/.test(row('cam1').selected),
        `cam1 defaults to the proofread file, not the newest-on-disk reprojections (got "${row('cam1').selected}")`);
    check(row('cam1').options.length === 6 && row('cam1').options[5] === 'None (no annotations)',
        `cam1 lists all five files plus None (got ${row('cam1').options.length})`);
    check(row('cam1').options.indexOf('copy of cam1.reprojections.slp — cam1.reprojections.slp.h5') >= 0,
        'a derived .h5 is listed as a copy of its .slp');
    check(/^LUC3D export, \d{4}-\d\d-\d\d \d\d:\d\d — cam2_v1\.slp$/.test(row('cam2').selected), `cam2 defaults to the LUC3D export (got "${row('cam2').selected}")`);

    // The user picks the newer SLEAP file for cam2, then saves.
    await page.selectOption('select[aria-label="Data file for cam2"]', { label: 'predictions — cam2.predictions.slp' });
    await page.click('#dfcSave');
    await waitLoad();
    const r2 = await page.evaluate(() => {
        const vmetaP = import('/import-export/visibility-metadata.js');
        return vmetaP.then(vm => ({
            census: window.__census(),
            stored: JSON.parse(localStorage.getItem('lucidDataFileChoices') || 'null'),
            choices: window.__lucid.state.session.dataFileChoices,
            lucid: vm.writeVisibilityMetadata({}, window.__lucid.state.session),
            dialogOpen: !!document.querySelector('.data-file-chooser'),
        }));
    });
    console.log('  ' + JSON.stringify(r2).slice(0, 700));
    check(!r2.dialogOpen, 'Save Options closes the dialog');
    check(r2.census.cam1.tracks.join() === 'PROOF_track,PROOF_track_1', `cam1 loaded the proofread file (got ${r2.census.cam1.tracks})`);
    check(r2.census.cam2.tracks.join() === 'NEWSLEAP_track', `cam2 loaded the file the user picked (got ${r2.census.cam2.tracks})`);
    check(r2.census.cam3.tracks.join() === 'LUCID3_track' && r2.census.cam4.n === 8, 'cam3 and cam4 as the rule settles them');
    check(JSON.stringify(r2.stored) === JSON.stringify({ sessA: { 'cam1': 'cam1.predictions.proofread.slp', 'cam2': 'cam2.predictions.slp' } }),
        `only the rows the user decided are remembered, by folder + camera dir (got ${JSON.stringify(r2.stored)})`);
    check(JSON.stringify(r2.choices) === JSON.stringify({ cam1: 'cam1/cam1.predictions.proofread.slp', cam2: 'cam2/cam2.predictions.slp' }),
        `the session carries them for a saved project (got ${JSON.stringify(r2.choices)})`);
    check(JSON.stringify(r2.lucid.dataFileChoices) === JSON.stringify(r2.choices),
        'and they reach metadata.lucid.dataFileChoices');

    // ---- §3 saved choice reused; new files ignored -------------------------
    console.log('\n-- §3 the saved choice loads with no dialog, new files ignored --');
    const dialogsBefore = await page.evaluate(() => window.__dialogs);
    await startLoad('sessA', SESS_A.concat([['cam1/cam1_v9.slp', 'lucid1late', NEWEST + 1000]]));
    await waitLoad();
    const r3 = await page.evaluate(() => ({ census: window.__census(), dialogs: window.__dialogs }));
    check(r3.dialogs === dialogsBefore, 'no dialog');
    check(r3.census.cam1.tracks.join() === 'PROOF_track,PROOF_track_1',
        `cam1 still loads the saved proofread file, not the LUC3D export added since (got ${r3.census.cam1.tracks})`);
    check(r3.census.cam2.tracks.join() === 'NEWSLEAP_track', 'cam2 still loads its saved file');

    // ---- §4 saved file gone: red row; Esc cancels, nothing changes ---------
    console.log('\n-- §4 a saved file that is gone brings the dialog back; Esc cancels --');
    const before4 = await page.evaluate(() => ({ nSessions: window.__lucid.state.sessions.length,
        name: window.__lucid.state.session.name }));
    await startLoad('sessA', SESS_A.filter(e => e[1] !== 'newsleap2'));
    await page.waitForSelector('.data-file-chooser', { timeout: 60000 });
    const d4 = await page.evaluate(() => {
        const tr = Array.from(document.querySelectorAll('.dfc-table tbody tr')).find(t => t.querySelector('.dfc-cam').textContent === 'cam2');
        const c1 = Array.from(document.querySelectorAll('.dfc-table tbody tr')).find(t => t.querySelector('.dfc-cam').textContent === 'cam1');
        return { cls: tr.className, note: (tr.querySelector('.dfc-missing-note') || {}).textContent || null,
                 color: getComputedStyle(tr.querySelector('.dfc-missing-note')).color, cam1cls: c1.className,
                 cam1sel: c1.querySelector('select').selectedOptions[0].textContent };
    });
    console.log('  ' + JSON.stringify(d4));
    check(/dfc-missing/.test(d4.cls) && d4.note === 'Saved file not found: cam2.predictions.slp',
        `cam2's row names the missing file (got ${d4.cls} / ${d4.note})`);
    check(/rgb\(231, 76, 60\)/.test(d4.color), `in red (got ${d4.color})`);
    check(!/dfc-missing|dfc-attention/.test(d4.cam1cls) && /proofread/.test(d4.cam1sel),
        'cam1, whose saved file is still there, shows it and is not marked');
    await page.keyboard.press('Escape');
    await waitLoad();
    const r4 = await page.evaluate(() => ({ dialogOpen: !!document.querySelector('.data-file-chooser'),
        nSessions: window.__lucid.state.sessions.length, name: window.__lucid.state.session && window.__lucid.state.session.name,
        status: document.getElementById('statusText').textContent, census: window.__census() }));
    check(!r4.dialogOpen, 'Esc closes the dialog');
    check(/Load cancelled/.test(r4.status), `the status says the load was cancelled (got "${r4.status}")`);
    check(r4.nSessions === before4.nSessions && r4.name === before4.name && r4.census.cam2.tracks.join() === 'NEWSLEAP_track',
        'and the open session is untouched');

    // ---- §5 multi-session: one dialog, one tab per session ------------------
    console.log('\n-- §5 multi-session: one dialog, a tab per session --');
    await page.evaluate(() => {
        // A real directory-handle walk (`enumerateDirectoryHandle`) over two sessions.
        const F = window.__F;
        const fh = (name, blob, mtime) => ({ kind: 'file', name, getFile: async () => new File([blob], name, { lastModified: mtime }) });
        const dh = (name, entries) => ({ kind: 'directory', name, [Symbol.asyncIterator]: async function* () { for (const e of entries) yield [e.name, e]; } });
        const session = (name, camFiles) => dh(name, [fh('calibration.toml', new Blob([F.toml]), 1)].concat(
            ['cam1', 'cam2', 'cam3', 'cam4'].map(cn => dh(cn, [fh(cn + '.mp4', F.mp4, 1)].concat(camFiles[cn] || [])))));
        const parent = dh('parent', [
            session('sessM1', { cam1: [fh('cam1.slp', F.lucid1late, 1)], cam4: [fh('cam4.analysis.h5', F.h5only4, 1)] }),
            session('sessM2', { cam1: [fh('cam1.predictions.slp', F.pred1, 1), fh('cam1.reprojections.slp', F.reproj1, 2)],
                                cam3: [fh('cam3.slp', F.lucid3, 1)] }),
        ]);
        window.showDirectoryPicker = async () => parent;
        window.__loadDone = false;
        import('/loading/session-loader.js').then(sl => sl.handleLoadMultiSession()).then(() => { window.__loadDone = true; });
    });
    await page.waitForSelector('.data-file-chooser', { timeout: 60000 });
    const d5 = await page.evaluate(() => ({
        tabs: Array.from(document.querySelectorAll('.dfc-tab')).map(t => ({ text: t.textContent.trim(), active: t.classList.contains('active'), dot: !!t.querySelector('.dfc-dot') })),
        visibleRows: Array.from(document.querySelectorAll('.dfc-panel:not([hidden]) tbody tr .dfc-cam')).map(e => e.textContent),
    }));
    console.log('  ' + JSON.stringify(d5));
    check(d5.tabs.length === 2 && d5.tabs[0].text.startsWith('sessM1') && d5.tabs[1].text.startsWith('sessM2'), 'a tab per session');
    check(!d5.tabs[0].dot && d5.tabs[1].dot && d5.tabs[1].active, 'the session needing a choice is marked and opens first');
    check(d5.visibleRows.join() === 'cam1,cam3', `its panel lists its cameras with data (got ${d5.visibleRows})`);
    await page.click('.dfc-tab[data-tab="0"]');
    const d5b = await page.evaluate(() => Array.from(document.querySelectorAll('.dfc-panel:not([hidden]) tbody tr .dfc-cam')).map(e => e.textContent));
    check(d5b.join() === 'cam1,cam4', `clicking the other tab shows that session (got ${d5b})`);
    // Close the skeleton prompt that follows a multi-session load.
    const skipper = setInterval(() => page.evaluate(() => { const b = document.getElementById('msSkelSkip'); if (b) b.click(); }).catch(() => {}), 300);
    await page.click('#dfcSave');
    await waitLoad();
    clearInterval(skipper);
    const r5 = await page.evaluate(async () => {
        const AS = window.__lucid.state;
        const byName = {};
        for (const s of AS.sessions) {
            if (s.name !== 'sessM1' && s.name !== 'sessM2') continue;
            const per = {};
            for (const [, fg] of s.frameGroups) for (const [cn, xs] of fg.unlinkedInstances) for (const u of xs) {
                (per[cn] = per[cn] || new Set()).add(s.tracks[u.instance.trackIdx]);
            }
            byName[s.name] = Object.fromEntries(Object.entries(per).map(([k, v]) => [k, Array.from(v).sort().join()]));
        }
        return { byName, stored: JSON.parse(localStorage.getItem('lucidDataFileChoices') || 'null') };
    });
    console.log('  ' + JSON.stringify(r5));
    check(r5.byName.sessM2 && r5.byName.sessM2.cam1 === 'PRED_track', `sessM2/cam1 loaded the default (predictions over reprojections) (got ${JSON.stringify(r5.byName.sessM2)})`);
    check(r5.byName.sessM1 && r5.byName.sessM1.cam1 === 'LATE1_track' && r5.byName.sessM1.cam4 === 'H5ONLY_track,H5ONLY_track_1',
        `sessM1 loaded what the rule settled (got ${JSON.stringify(r5.byName.sessM1)})`);
    check(r5.stored && r5.stored.sessM2 && r5.stored.sessM2.cam1 === 'cam1.predictions.slp' && !r5.stored.sessM1,
        'only sessM2/cam1 is remembered');

    check(pageErrs.length === 0, `no uncaught page errors (got ${JSON.stringify(pageErrs.slice(0, 2))})`);
    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
