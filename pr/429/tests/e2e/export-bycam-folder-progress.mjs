/**
 * export-bycam-folder-progress.mjs — File ▸ Export SLEAP File By Cam's folder
 * picker and progress.
 *
 *  1. The folder picker opens in the project's folder: `showDirectoryPicker` is
 *     called with `startIn` = the project's `.slp` handle (`state.slpFileHandle`,
 *     kept by Load Project) and the export's own `id`. Without a handle it gets
 *     the `id` only (so it opens where the last export went, not wherever any
 *     picker of the site last went). `folderPickerStartFor` (Load Project's video
 *     prompt) still returns the handle only for the file being opened.
 *  2. Progress is the app's card (ui/loading-overlay.js), not the button text:
 *     one step per camera ("Step k of n"). A fully loaded project writes each
 *     camera in one go (spinner + "Writing <cam>.slp…"); on a lazily opened
 *     project the sweep's frames fill the bar (5). The modal steps aside while
 *     the card shows.
 *  3. End state: the card is hidden, the modal closed, the files written, and
 *     the status names the folder. Esc mid-camera cancels: the card goes, the
 *     modal comes back, nothing is written for that camera.
 *  5. A reopened (lazy) project builds every camera in ONE sweep ("Reading N
 *     cameras", its frames on the bar), and each camera's file holds that camera
 *     only — the store's fast path used to re-emit the whole shared project into
 *     every camera's file. Files save side by side (both writables open at
 *     once), so a share's slow close() does not hold up the next file.
 *  4. In the picked folder, a camera's file goes into the camera's own folder
 *     (the folder load's `cameraDirMap`, else the folder its video sits in), next
 *     to the `.slp` its 2D came from, as `<source stem>_proofread.slp` — an
 *     earlier `_proofread` file is replaced and never taken for the source; the
 *     recorded source wins over a higher `_vN`. A camera with no folder there is
 *     written as `<camera>.slp` in the picked folder, as before.
 *
 * Playwright cannot drive the native dialog, so `showDirectoryPicker` is a stub
 * over an in-memory folder tree.
 *
 * Run: PORT=9351 node tests/e2e/export-bycam-folder-progress.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9351);
const LAZY_FRAMES = Number(process.env.FRAMES || 12000);
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });

    // The picker stub (records its options; writes into memory) and a recorder of
    // every state the progress card goes through.
    await page.evaluate(() => {
        window.__picks = [];
        window.__written = {};
        // An in-memory folder tree: { dirs: {name: node}, files: {name: {size, lastModified}} }.
        window.__tree = { dirs: {}, files: {} };
        window.__blobs = {}; window.__inflight = 0; window.__maxInflight = 0; window.__closeDelay = 0;
        const mkDir = (name, node, prefix) => ({
            kind: 'directory', name,
            getDirectoryHandle: async (n, o) => {
                if (!node.dirs[n]) {
                    if (!(o && o.create)) throw new DOMException(n + ' not found', 'NotFoundError');
                    node.dirs[n] = { dirs: {}, files: {} };
                }
                return mkDir(n, node.dirs[n], prefix + n + '/');
            },
            // A writable counts as in flight from createWritable until its close()
            // returns; `__closeDelay` ms stands in for a share's slow close().
            getFileHandle: async (fname) => ({
                kind: 'file', name: fname,
                createWritable: async () => {
                    window.__maxInflight = Math.max(window.__maxInflight, ++window.__inflight);
                    return {
                        write: async (blob) => {
                            node.files[fname] = { size: blob.size, lastModified: Date.now() };
                            window.__written[prefix + fname] = blob.size;
                            window.__blobs[prefix + fname] = blob;
                        },
                        close: async () => {
                            await new Promise(r => setTimeout(r, window.__closeDelay));
                            window.__inflight--;
                        },
                    };
                },
            }),
            values: async function* () {
                for (const n of Object.keys(node.dirs)) yield mkDir(n, node.dirs[n], prefix + n + '/');
                for (const n of Object.keys(node.files))
                    yield { kind: 'file', name: n, getFile: async () => ({ lastModified: node.files[n].lastModified }) };
            },
        });
        window.showDirectoryPicker = async (opts) => {
            window.__picks.push(opts);
            return mkDir('exports', window.__tree, '');
        };
        window.__card = [];
        const snap = () => {
            const $ = id => document.getElementById(id);
            const shown = id => !$(id).classList.contains('hidden');
            const modal = document.querySelector('.slp-bycam-modal');
            window.__card.push({
                visible: shown('loadingOverlay'),
                title: $('loadingTitle').textContent,
                status: $('loadingStatus').textContent,
                sub: shown('loadingSubstatus') ? $('loadingSubstatus').textContent : '',
                bar: shown('loadingProgress'),
                spinner: shown('loadingSpinner'),
                frac: parseFloat($('loadingProgressFill').dataset.fraction),
                modalShown: !!(modal && modal.closest('.multi-frame-modal-overlay').style.display !== 'none'),
            });
        };
        new MutationObserver(snap).observe(document.getElementById('loadingOverlay'),
            { subtree: true, childList: true, characterData: true, attributes: true });
    });

    /** Open the modal, click Download All, wait until it finishes; returns the card's states. */
    async function runExport() {
        await page.evaluate(async () => {
            window.__card.length = 0;
            (await import('/ui/export-modals.js')).showSlpExportByCamModal();
        });
        await page.waitForSelector('.slp-bycam-modal', { timeout: 5000 });
        return await page.evaluate(async () => {
            document.getElementById('slpByCamDownloadAll').click();
            for (let i = 0; i < 1200; i++) {
                await new Promise(r => setTimeout(r, 50));
                const btn = document.getElementById('slpByCamDownloadAll');
                const overlayHidden = document.getElementById('loadingOverlay').classList.contains('hidden');
                if ((!btn || !btn.disabled) && overlayHidden && window.__card.length) break;
            }
            const popup = document.querySelector('.export-result-overlay');
            const modal = document.querySelector('.slp-bycam-modal');
            return {
                card: window.__card.slice(),
                cardHidden: document.getElementById('loadingOverlay').classList.contains('hidden'),
                modalOpen: !!modal,
                modalShown: !!(modal && modal.closest('.multi-frame-modal-overlay').style.display !== 'none'),
                popup: popup ? popup.textContent.trim() : null,
                status: document.getElementById('statusText').textContent,
                written: Object.assign({}, window.__written),
                picks: window.__picks.slice(),
            };
        });
    }
    async function closePopup() {
        await page.evaluate(() => { const p = document.querySelector('.export-result-overlay'); if (p) p.remove(); });
    }
    async function closeModal() {
        await page.evaluate(() => { const b = document.getElementById('slpByCamClose'); if (b) b.click(); });
    }

    // =================================================================
    // A fully loaded (eager) project: two cameras.
    // =================================================================
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Session, FrameGroup, Instance } = pd;
        const K = [[600, 0, 160], [0, 600, 120], [0, 0, 1]];
        const skel = new Skeleton('sk', ['nose', 'body', 'tail'], [[0, 1], [1, 2]]);
        const s = new Session(['camA', 'camB'].map((n, i) => new Camera(
            n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [320, 240])), skel, ['track_0'], 'Eager');
        for (let f = 0; f < 50; f++) {
            s.addFrameGroup(new FrameGroup(f));
            for (const cn of ['camA', 'camB'])
                s.getFrameGroup(f).addInstance(cn, new Instance([[10 + f, 20], [30, 40], [50, 60]], 0, 'predicted', 0.9));
        }
        AS.setProjectSkeleton(skel);
        AS.state.sessions = [s];
        AS.state.session = s;
        AS.state.activeSessionIdx = 0;
        AS.state.videoFiles = s.cameras.map(c => ({ name: c.name, assignedCamera: c.name, sessionIdx: 0 }));
    });

    console.log('1. Folder picker start');
    await page.evaluate(() => {
        window.__projHandle = { kind: 'file', name: 'project.slp', getFile: async () => new File([], 'project.slp') };
        window.__lucid.state.slpFileHandle = window.__projHandle;
    });
    let r = await runExport();
    const p0 = r.picks[0] || {};
    check(r.picks.length === 1, 'Download All asked for a folder once', r.picks.length);
    check(await page.evaluate(() => window.__picks[0] && window.__picks[0].startIn === window.__projHandle),
        'picker starts in the project file\'s folder (startIn = state.slpFileHandle)');
    check(p0.id === 'lucid-export-folder' && p0.mode === 'readwrite', 'picker has the export\'s own id, readwrite', p0);
    await closePopup();

    await page.evaluate(() => { window.__picks.length = 0; window.__lucid.state.slpFileHandle = null; });
    r = await runExport();
    check(r.picks.length === 1 && !('startIn' in r.picks[0]) && r.picks[0].id === 'lucid-export-folder',
        'without a project file: no startIn, the export\'s id only', r.picks[0]);
    await closePopup();

    const fps = await page.evaluate(async () => {
        const { folderPickerStartFor } = await import('/loading/session-loader.js');
        window.__lucid.state.slpFileHandle = window.__projHandle;
        const same = folderPickerStartFor(new File([], 'project.slp')) === window.__projHandle;
        const other = folderPickerStartFor(new File([], 'other.slp'));
        window.__lucid.state.slpFileHandle = null;
        return { same, other };
    });
    check(fps.same && fps.other === null, 'folderPickerStartFor still matches only the file being opened', fps);

    console.log('2/3. Progress card — fully loaded project');
    check(r.card.length > 0 && r.card.some(s => s.visible), 'the progress card showed');
    check(r.card.every(s => !s.visible || s.title === 'Export SLEAP by Camera'), 'card titled "Export SLEAP by Camera"');
    for (const [k, cam] of [[1, 'camA'], [2, 'camB']]) {
        check(r.card.some(s => s.visible && s.spinner && s.status === 'Writing ' + cam + '.slp…' && /^Step \d of 2/.test(s.sub) && s.sub.startsWith('Step ' + k)),
            `step ${k} of 2: spinner + "Writing ${cam}.slp…"`);
    }
    check(r.card.filter(s => s.visible).every(s => !s.modalShown), 'the modal steps aside while the card shows');
    check(r.cardHidden && !r.modalOpen, 'end: card hidden, modal closed');
    check(/Download Successful/.test(r.popup || ''), 'end: "Download Successful"', r.popup);
    check(r.written['camA.slp'] > 0 && r.written['camB.slp'] > 0, 'both files written', r.written);
    check(/Exported 2 SLP files to exports/.test(r.status), 'status names the folder', r.status);
    check(!(await page.evaluate(() => document.getElementById('slpByCamDownloadAll'))), 'no "Downloading… (k/n)" button left');
    await closePopup();

    // =================================================================
    // 4. Each camera's file goes next to its source .slp, as <stem>_proofread.slp.
    // =================================================================
    console.log('4. Next to each camera\'s source .slp');
    await page.evaluate(() => {
        const st = window.__lucid.state;
        // camA: found by the folder its video sits in; its folder holds the source
        //   and a NEWER proofread file from an earlier export (never the source).
        // camB: found by the folder load's cameraDirMap; the recorded source wins
        //   over a higher _vN.
        st.videoFiles[0].videoPath = 'sess/21241563/21241563-20260921105806.mp4';
        st.videoFiles[1].videoPath = 'sess/camB/0.mp4';
        st.videoFiles[1].slpFilename = 'b_loaded.slp';
        st.cameraDirMap = { camB: 'Camera_B_dir' };
        window.__written = {};
        window.__tree = { files: { 'project.slp': { size: 1, lastModified: 1 } }, dirs: {
            '21241563': { dirs: {}, files: {
                '21241563-20260921105806.mp4': { size: 5, lastModified: 1 },
                '21241563-20260921105806_nn.slp': { size: 7, lastModified: 100 },
                '21241563-20260921105806_nn_proofread.slp': { size: 3, lastModified: 999 },
            } },
            'Camera_B_dir': { dirs: {}, files: {
                'b_loaded.slp': { size: 7, lastModified: 100 },
                'b_v3.slp': { size: 7, lastModified: 200 },
            } },
        } };
    });
    r = await runExport();
    check(Object.keys(r.written).sort().join(',') ===
        '21241563/21241563-20260921105806_nn_proofread.slp,Camera_B_dir/b_loaded_proofread.slp',
        'files written next to their sources, named <source>_proofread.slp (the earlier one replaced)', r.written);
    const src = await page.evaluate(() => {
        const t = window.__tree;
        return [t.dirs['21241563'].files['21241563-20260921105806_nn.slp'].size,
                t.dirs.Camera_B_dir.files['b_loaded.slp'].size, Object.keys(t.files).join(',')];
    });
    check(src[0] === 7 && src[1] === 7 && src[2] === 'project.slp', 'sources untouched; nothing written in the folder itself', src);
    check(r.card.some(s => s.visible && s.status === 'Writing 21241563/21241563-20260921105806_nn_proofread.slp…'),
        'the card names the camera folder and file');
    check(/Exported 2 SLP files to exports: 2 in camera folders as <source>_proofread\.slp$/.test(r.status), 'status says where', r.status);
    await closePopup();

    // Only camA's folder is there: camB falls back to camB.slp in the folder itself.
    await page.evaluate(() => {
        window.__written = {};
        delete window.__tree.dirs.Camera_B_dir;
    });
    r = await runExport();
    check(Object.keys(r.written).sort().join(',') === '21241563/21241563-20260921105806_nn_proofread.slp,camB.slp',
        'a camera without a folder in the picked folder: <camera>.slp there, as before', r.written);
    check(/: 1 in camera folders as <source>_proofread\.slp; 1 as <camera>\.slp \(no camera folder found\)$/.test(r.status),
        'status counts both', r.status);
    await closePopup();
    await page.evaluate(() => {
        const st = window.__lucid.state;
        st.cameraDirMap = {};
        window.__tree = { dirs: {}, files: {} };
    });

    // =================================================================
    // A reopened (lazy) project: every camera is built in ONE sweep, whose
    // frames fill the bar; each camera's file holds that camera only (the
    // store's fast path used to re-emit the whole shared project per camera);
    // the files save side by side.
    // =================================================================
    console.log('2/3/5. Reopened lazy project: one sweep, one camera per file, saves overlap');
    const loadErr = await page.evaluate(async (FRAMES) => {
        const [pd, fileio] = await Promise.all([import('/pose/pose-data.js'), import('/import-export/file-io.js')]);
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const cams = ['cam0', 'cam1'];
        const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
        const s = new Session(cams.map((n, i) => new Camera(n, M, [0, 0, 0, 0, 0], [0, 0.3 * i, 0], [0, 0, 40], [512, 512])),
            new Skeleton('skeleton', ['n0', 'n1', 'n2'], [[0, 1], [1, 2]]), ['t0'], 'Lazy');
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            s.addFrameGroup(fg);
            const g = new InstanceGroup(f + 1, 0);
            cams.forEach((cn, ci) => {
                const inst = new Instance([[50 + ci, 60], [60, 68], [70, 76]], 0, 'predicted', 1);
                inst._rawInstIndex = 0;
                fg.addInstance(cn, inst);
                g.addInstance(cn, inst);
            });
            g.points3d = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
            s.instanceGroups.set(f, [g]);
        }
        const views = cams.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: FRAMES }));
        const videoFiles = cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const bytes = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(s, views, videoFiles));
        const file = new File([bytes], 'lazy-project.slp');
        window.__tstLoad = { done: false, err: null };
        (async () => {
            try { await (await import('/loading/session-loader.js')).handleLoadProjectSlpLazy(file); window.__tstLoad.done = true; }
            catch (e) { window.__tstLoad.err = String(e && e.stack || e).slice(0, 500); }
        })();
        for (let i = 0; i < 600 && !window.__tstLoad.done && !window.__tstLoad.err; i++) {
            const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || '') && x.offsetParent);
            if (b) b.click();
            await new Promise(r => setTimeout(r, 100));
        }
        const st = window.__lucid.state;
        if (!st.session.lazyLoader) return 'not lazy';
        if (!(st.videoFiles || []).some(v => v.assignedCamera === 'cam0'))
            st.videoFiles = cams.map(n => ({ name: n, assignedCamera: n, sessionIdx: 0 }));
        return window.__tstLoad.err;
    }, LAZY_FRAMES);
    check(!loadErr, 'lazy project opened', loadErr || undefined);

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });   // so the bar has time to move

    const lazy = await page.evaluate(async () => {
        window.__card.length = 0; window.__written = {}; window.__blobs = {};
        window.__maxInflight = 0; window.__closeDelay = 300;
        (await import('/ui/export-modals.js')).showSlpExportByCamModal();
        document.getElementById('slpByCamDownloadAll').click();
        for (let i = 0; i < 2400; i++) {
            await new Promise(r => setTimeout(r, 50));
            if (document.getElementById('loadingOverlay').classList.contains('hidden') && window.__card.length
                && !document.querySelector('.slp-bycam-modal')) break;
        }
        window.__closeDelay = 0;
        // Read before the files are read back: the popup dismisses itself.
        const popup = (document.querySelector('.export-result-overlay') || {}).textContent || null;
        const cardHidden = document.getElementById('loadingOverlay').classList.contains('hidden');
        const h5url = new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href;
        const content = {};
        for (const [path, blob] of Object.entries(window.__blobs)) {
            const back = await window.SleapIO.readSlpStreaming(new File([blob], path), { openVideos: false, h5wasmUrl: h5url });
            content[path] = { videos: back.videos.map(v => v.filename), frames: back.labeledFrames.length };
        }
        return { card: window.__card.slice(), written: Object.assign({}, window.__written), content,
                 maxInflight: window.__maxInflight, cardHidden, popup };
    });
    const total = LAZY_FRAMES.toLocaleString('en-US');
    const bars = lazy.card.filter(s => s.visible && s.bar && s.status.startsWith('Reading 2 cameras:') && s.sub.startsWith('Step 1 of 3'));
    const fr = bars.map(s => s.frac);
    check(bars.length > 0, `step 1 of 3: one sweep for both cameras, "Reading 2 cameras: n/${total} frames…"`, bars.slice(-1)[0]);
    check(fr.every((f, i) => i === 0 || f >= fr[i - 1]), 'the sweep\'s bar only rises', fr);
    check(fr.some(f => f > 0 && f < 1), 'the bar moved during the sweep', fr);
    check(bars.some(s => s.status === `Reading 2 cameras: ${total}/${total} frames…` && s.frac === 1), `the sweep ends at ${total}/${total}`);
    check(!lazy.card.some(s => s.visible && /^Writing /.test(s.status)), 'no camera is built again after the sweep');
    check(lazy.cardHidden && /Download Successful/.test(lazy.popup || ''), 'lazy end: card hidden, "Download Successful"', lazy.popup);
    check(lazy.written['cam0.slp'] > 0 && lazy.written['cam1.slp'] > 0, 'lazy: both files written', lazy.written);
    for (const cam of ['cam0', 'cam1']) {
        const c = lazy.content[cam + '.slp'] || {};
        check(JSON.stringify(c.videos) === JSON.stringify([cam + '.mp4']) && c.frames === LAZY_FRAMES,
            `${cam}.slp holds ${cam} only (1 video, ${total} frames), not the whole project`, c);
    }
    check(lazy.maxInflight === 2, 'the two files saved side by side (both writables open at once)', lazy.maxInflight);
    const style = await page.evaluate(async () => {
        const { progressCardStyle } = await import('/tests/e2e/fixtures/progress-card.js');
        const ov = document.getElementById('loadingOverlay');
        ov.classList.remove('hidden');
        const out = progressCardStyle(ov.querySelector('.loading-card'), ov);
        ov.classList.add('hidden');
        return out;
    });
    check(style.ok, 'the card is the app\'s standard progress card', style.why || undefined);
    await closePopup();

    console.log('3. Esc mid-camera cancels');
    const cancel = await page.evaluate(async () => {
        window.__card.length = 0; window.__written = {};
        (await import('/ui/export-modals.js')).showSlpExportByCamModal();
        document.getElementById('slpByCamDownloadAll').click();
        let sent = false;
        for (let i = 0; i < 2400; i++) {
            await new Promise(r => setTimeout(r, 20));
            if (!sent && window.__card.some(s => s.bar && /^Reading 2 cameras: /.test(s.status) && s.frac < 1)) {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                sent = true;
            }
            const btn = document.getElementById('slpByCamDownloadAll');
            if (sent && btn && !btn.disabled) break;
        }
        const modal = document.querySelector('.slp-bycam-modal');
        return {
            sent, written: Object.assign({}, window.__written),
            cardHidden: document.getElementById('loadingOverlay').classList.contains('hidden'),
            modalShown: !!(modal && modal.closest('.multi-frame-modal-overlay').style.display !== 'none'),
            popup: !!document.querySelector('.export-result-overlay'),
            status: document.getElementById('statusText').textContent,
        };
    });
    check(cancel.sent, 'Esc sent while the sweep\'s bar was moving');
    check(cancel.cardHidden && cancel.modalShown, 'cancel: card hidden, modal back', cancel);
    check(Object.keys(cancel.written).length === 0, 'cancel: nothing written', cancel.written);
    check(!cancel.popup, 'cancel: no success/failure popup');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await closeModal();

    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
