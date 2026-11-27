/**
 * slp-newer-format.mjs — a `.slp` newer than LUC3D can read is refused on every
 * path, says so, and changes nothing.
 *
 * Python sleap-io 0.10 writes SLP format 3.0 by default, where every table is a
 * group of columns. LUC3D's two readers know the 2.x layout only: both used to
 * read such a file as 0 frames with no error, and File ▸ Open reported "SLP loaded
 * (… 0 labeled frames)". The rule is `loading/slp-format-check.js` (unit test:
 * `tests/test-slp-format-check.mjs`); the vendored reader has its own copy
 * (`LUCID local patch (luc3d newer-format)`).
 *
 * `tests/fixtures/slp-format-30/py_written_30_columnar.slp` is a real file from
 * Python's release branch. Files with other format ids are LUC3D's own or other
 * real 2.x files with only that attribute changed, so they prove the check goes by
 * `format_id` and not by what the tables happen to look like.
 *
 *  1. Both readers and every vendored entry refuse it, in exactly the same words.
 *  2. Each loader says so, with nothing open: no session, no prefix, no retry.
 *  3. With a project open, every loader leaves it as it was. The one that matters
 *     most is `handleLoadProjectSlpLazy`, which File ▸ Open uses above 200 MB and
 *     which frees the open project BEFORE its read.
 *  4. A refused file does not become the save target: File ▸ Open used to record
 *     the handle first, so the next Save overwrote that file with the open project.
 *  5. Per-camera folders, on both routes: the refused camera gets a view and no
 *     data, the others load, and the status gives the reason and names the camera.
 *  6. A multi-session load ends on that status, not on "Loaded 2 sessions".
 *  7. The environment step refuses too, rather than using the readable cameras.
 *  8. A project file with sessions, marked 3.0, is refused on both routes.
 *  9. 2.x files are unaffected: a format just below the limit reads everywhere, a
 *     file that is not HDF5 still gets its own error, and a big 2.x file still
 *     replaces the open project through the lazy route.
 *
 * Run: node tests/e2e/slp-newer-format.mjs   (serves the app itself; PORT=…)
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const server = await startServer(repoRoot);
const PORT = server.port;
const VIDEO = path.join(repoRoot, 'tests', 'fixtures', 'barcode-60', 'barcode-60.mp4');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-newer-format-'));

let fails = 0;
const check = (c, m, extra) => { console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : ' — ' + extra)); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const refusalFor = (name, version = '3.0') => `${name} uses SLP format ${version}, which is newer than this version of LUC3D supports (max 2.x). Update LUC3D to read it, or re-save the file from Python sleap-io with \`legacy_format=True\`.`;


let browser;
try {
    browser = await launchBrowser({ headless: true });

    /** A fresh app with the helpers below, so one section's state can't reach the next. */
    async function freshPage() {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        page.consoleLines = [];
        page.on('console', m => page.consoleLines.push(m.text()));
        page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
        page.on('dialog', d => d.accept());
        await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction(() => window.SleapIO && window.h5wasm && window.__lucid && window.__lucid.state, null, { timeout: 120000 });
        await page.evaluate(() => {
            window.__fixture = async () => new Uint8Array(await (await fetch('/tests/fixtures/slp-format-30/py_written_30_columnar.slp')).arrayBuffer());
            window.__real2x = async () => new Uint8Array(await (await fetch('/tests/fixtures/slp-compound/sleap-compound-small.slp')).arrayBuffer());
            // A copy of a file with only `format_id` changed.
            let n = 0;
            window.__withFormatId = async (bytes, id) => {
                const h5 = window.h5wasm;
                await h5.ready;
                const p = '/newer-format-' + (n++) + '.slp';
                h5.FS.writeFile(p, bytes);
                const f = new h5.File(p, 'a');
                const meta = f.get('metadata');
                meta.delete_attribute('format_id');
                meta.create_attribute('format_id', id);
                f.close();
                const out = h5.FS.readFile(p);
                h5.FS.unlink(p);
                return new Uint8Array(out);
            };
            // A project .slp the way LUC3D writes one: 3 frames, grouped, with sessions.
            window.__projectBytes = async (name, cams) => {
                const pd = await import('/pose/pose-data.js');
                const fileio = await import('/import-export/file-io.js');
                const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
                const cameras = cams.map((c, i) => new pd.Camera(c, M, [0, 0, 0, 0, 0], [0, 0.3 * i, 0], [-12 * i, 0, 2 * i], [512, 512]));
                const s = new pd.Session(cameras, new pd.Skeleton('skeleton', ['a', 'b'], [[0, 1]]), ['track_0'], name);
                for (let f = 0; f < 3; f++) {
                    const fg = new pd.FrameGroup(f);
                    s.addFrameGroup(fg);
                    const g = new pd.InstanceGroup(f + 1, 0);
                    cams.forEach((cn, ci) => {
                        const inst = new pd.Instance([[100 + f + ci, 120], [140 + f, 160 + ci]], 0, 'user', 1);
                        fg.addInstance(cn, inst);
                        g.addInstance(cn, inst);
                    });
                    s.instanceGroups.set(f, [g]);
                }
                const views = cams.map(c => ({ name: c, videoWidth: 512, videoHeight: 512, frameCount: 3 }));
                const vfs = cams.map(c => ({ name: c, assignedCamera: c, videoPath: c + '.mp4' }));
                return await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(s, views, vfs));
            };
            // What a refused load must leave exactly as it found.
            window.__snapshot = async () => {
                const AS = await import('/ui/app-state.js');
                const s = AS.state.session;
                let instances = 0;
                if (s) {
                    for (const [, fg] of s.frameGroups) {
                        for (const [, xs] of fg.instances) instances += xs.length;
                        for (const [, xs] of fg.unlinkedInstances) instances += xs.length;
                    }
                }
                return {
                    sessions: AS.state.sessions.map(x => x.name),
                    active: s ? s.name : null,
                    frameGroups: s ? s.frameGroups.size : null,
                    groups: s ? s.instanceGroups.size : null,
                    instances,
                    lazy: !!(s && s.lazyLoader),
                    views: AS.state.views.length,
                    planes: (await import('/ui/plane-definition.js')).planeModel().planes.length,
                };
            };
            window.__status = () => ({
                text: document.getElementById('statusText').textContent,
                dot: document.getElementById('statusDot').className,
            });
        });
        return page;
    }

    /**
     * Run a loader on page-global bytes, dismissing the prompts it raises.
     * `code` sees `f`, a File; `size` overrides what `f.size` reports, which is
     * what the routes above 150 and 200 MB go by.
     */
    async function run(page, code, globalName, fileName, size) {
        await page.evaluate(([code, g, name, size]) => {
            window.__done = false;
            window.__returned = undefined;
            const f = new File([window[g]], name);
            if (size) Object.defineProperty(f, 'size', { value: size });
            (new Function('f', 'return (async () => { ' + code + ' })()'))(f)
                .then(r => { window.__returned = r; window.__done = true; }, e => { window.__done = 'THREW ' + (e && e.stack || e); });
        }, [code, globalName, fileName, size || 0]);
        for (let i = 0; i < 240; i++) {
            const s = await page.evaluate(() => {
                const b = [...document.querySelectorAll('button')].find(x => x.offsetParent && /^(Skip|Later|Cancel|Not now)$/i.test((x.textContent || '').trim()));
                if (b) { b.click(); return { clicked: true }; }
                return { done: window.__done, prompt: !!document.getElementById('videoSelectOverlay') };
            });
            if (s.prompt) await page.keyboard.press('Escape');
            if (s.done) return { done: s.done, returned: await page.evaluate(() => window.__returned) };
            await page.waitForTimeout(250);
        }
        return { done: 'timeout' };
    }
    const EAGER = "return (await import('/import-export/slp-import.js')).handleLoadSlpFile(f);";
    const LAZY = "return (await import('/loading/session-loader.js')).handleLoadProjectSlpLazy(f);";
    const ROUTED = "return (await import('/import-export/save-load.js')).handleLoadProject(f);";
    const OVER_200_MB = 250 * 1024 * 1024;
    const OVER_150_MB = 180 * 1024 * 1024;

    /** The two ways a refusal could still look like something else. */
    const noRetry = (page) => !page.consoleLines.some(l => /falling back/i.test(l));
    const overlayGone = (page) => page.evaluate(() => {
        const o = document.getElementById('loadingOverlay');
        return !o || getComputedStyle(o).display === 'none';
    });

    // =================================================================
    console.log('\n-- 1. both readers refuse the real file, in exactly the same words --');
    {
        const page = await freshPage();
        const r = await page.evaluate(async () => {
            const fio = await import('/import-export/file-io.js');
            const { SioLazyLoader } = await import('/loading/sio-lazy-loader.js');
            const sio = await import('/lib/sleap-io/index.browser.js');
            const bytes = await window.__fixture();
            const file = new File([bytes], 'mice.slp');
            const h5wasmUrl = new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href;
            const outcome = async (fn) => {
                try {
                    const v = await fn();
                    return { read: true, frames: v && (v.frames ? v.frames.length : v.labeledFrames ? v.labeledFrames.length : v.nFrames) };
                } catch (e) { return { name: e.name, message: e.message, formatId: e.formatId }; }
            };
            return {
                'vendored, as File ▸ Open reads (parseSlpViaSleapIO)': await outcome(() => fio.parseSlpViaSleapIO(file)),
                'vendored, per-camera lazy (SioLazyLoader.open)': await outcome(() => new SioLazyLoader().open('cam', file)),
                'vendored, project lazy (SioLazyLoader.openProjectSlp)': await outcome(() => new SioLazyLoader().openProjectSlp(file)),
                'vendored loadSlp(File), no retry on the main thread': await outcome(() => sio.loadSlp(file, { openVideos: false, h5: { h5wasmUrl } })),
                'vendored readSlp': await outcome(() => sio.loadSlp(bytes, { openVideos: false, h5: { stream: 'download', filenameHint: 'mice.slp', h5wasmUrl } })),
                'vendored readSlpLazy': await outcome(() => sio.loadSlp(bytes, { openVideos: false, lazy: true, h5: { stream: 'download', filenameHint: 'mice.slp', h5wasmUrl } })),
                'raw worker (parseSlpH5)': await outcome(() => fio.parseSlpH5(file)),
                'raw worker, columnar (per-camera folders)': await outcome(() => fio.parseSlpH5(file, null, { columnar: true })),
                'the format probe (checkSlpFileFormat)': await outcome(() => fio.checkSlpFileFormat(file)),
            };
        });
        for (const [where, o] of Object.entries(r)) {
            check(o.name === 'UnsupportedSlpFormatError' && o.message === refusalFor('mice.slp'),
                where, JSON.stringify(o).slice(0, 220));
        }
        check(eq(Object.values(r).filter(o => o.formatId !== undefined).map(o => o.formatId), [3, 3, 3, 3, 3, 3]),
            'the vendored error carries formatId');
        await page.close();
    }

    // =================================================================
    console.log('\n-- 2. each loader says so, with nothing open --');
    for (const [label, code, size] of [
        ['handleLoadSlpFile (File ▸ Load SLP)', EAGER],
        ['handleLoadProjectSlpLazy', LAZY],
        ['handleLoadProject (File ▸ Open)', ROUTED],
        ['handleLoadProject, above 200 MB (lazy route)', ROUTED, OVER_200_MB],
    ]) {
        const page = await freshPage();
        await page.evaluate(async () => { window.__new = await window.__fixture(); });
        const r = await run(page, code, '__new', 'mice.slp', size);
        const st = await page.evaluate(() => window.__status());
        const snap = await page.evaluate(() => window.__snapshot());
        check(r.done === true && r.returned === false, label + ': tells its caller the file did not open', JSON.stringify(r));
        check(st.text === refusalFor('mice.slp') && /error/.test(st.dot), '  the status is the refusal, with no prefix, in red', JSON.stringify(st));
        check(snap.sessions.length === 0 && snap.active === null, '  no session was made', JSON.stringify(snap));
        check(noRetry(page), '  and it did not retry through the raw worker');
        check(await overlayGone(page), '  and the progress card is gone');
        await page.close();
    }

    // =================================================================
    console.log('\n-- 3. with a project open, every loader leaves it as it was --');
    {
        const page = await freshPage();
        await page.evaluate(async () => {
            window.__new = await window.__fixture();
            window.__project = await window.__projectBytes('open-project', ['cam0', 'cam1']);
        });
        const opened = await run(page, EAGER, '__project', 'open-project.slp');
        await page.evaluate(async () => { (await import('/ui/plane-definition.js')).createPlane('floor'); });
        const before = await page.evaluate(() => window.__snapshot());
        check(opened.done === true && before.frameGroups === 3 && before.instances === 6 && before.planes === 1,
            'a 2.x project is open, with a plane defined', JSON.stringify(before));

        for (const [label, code, size] of [
            ['handleLoadSlpFile', EAGER],
            ['handleLoadProjectSlpLazy', LAZY],
            ['handleLoadProject', ROUTED],
            ['handleLoadProject, above 200 MB (the lazy route frees the project first)', ROUTED, OVER_200_MB],
        ]) {
            await page.evaluate(() => { document.getElementById('statusText').textContent = 'before'; });
            const r = await run(page, code, '__new', 'mice.slp', size);
            const st = await page.evaluate(() => window.__status());
            const after = await page.evaluate(() => window.__snapshot());
            check(r.done === true && st.text === refusalFor('mice.slp'), label + ': refused', JSON.stringify([r, st]));
            check(eq(after, before), '  the open project is untouched', JSON.stringify(after));
        }

        // Add SLP goes through a picker.
        const newPath = path.join(tmpRoot, 'mice.slp');
        fs.copyFileSync(path.join(repoRoot, 'tests', 'fixtures', 'slp-format-30', 'py_written_30_columnar.slp'), newPath);
        page.once('filechooser', fc => fc.setFiles(newPath));
        await page.evaluate(async () => { await (await import('/import-export/slp-import.js')).handleAddSlp(); });
        let st = await page.evaluate(() => window.__status());
        check(st.text === refusalFor('mice.slp'), 'handleAddSlp: refused', JSON.stringify(st));
        check(eq(await page.evaluate(() => window.__snapshot()), before), '  the open project is untouched');

        // So does the single-SLP folder loader ("Add session folder").
        const recDir = path.join(tmpRoot, 'rec');
        fs.mkdirSync(path.join(recDir, 'videos'), { recursive: true });
        fs.copyFileSync(newPath, path.join(recDir, 'mice.slp'));
        for (const cam of ['cam0', 'cam1']) fs.copyFileSync(VIDEO, path.join(recDir, 'videos', cam + '.mp4'));
        page.once('filechooser', fc => fc.setFiles(recDir));
        await page.evaluate(async () => { await (await import('/loading/session-loader.js')).handleLoadSessionFolderSingleSlp(); });
        st = await page.evaluate(() => window.__status());
        check(st.text === refusalFor('mice.slp'), 'handleLoadSessionFolderSingleSlp: refused', JSON.stringify(st));
        check(eq(await page.evaluate(() => window.__snapshot()), before), '  the open project is untouched');
        check(noRetry(page), 'none of them retried through the raw worker');
        await page.close();
    }

    // =================================================================
    console.log('\n-- 4. a refused file does not become the save target --');
    {
        /** Click a File menu item with its picker stubbed, and wait for the load to end. */
        async function menu(page, id, bytesGlobal, name) {
            await page.evaluate(([id, g, name]) => {
                const bytes = window[g];
                window.showOpenFilePicker = async () => [{ __tag: name, kind: 'file', name, getFile: async () => new File([bytes], name) }];
                document.getElementById('statusText').textContent = 'waiting';
                document.getElementById(id).click();
            }, [id, bytesGlobal, name]);
            for (let i = 0; i < 240; i++) {
                const s = await page.evaluate(() => {
                    const b = [...document.querySelectorAll('button')].find(x => x.offsetParent && /^(Skip|Later|Cancel|Not now)$/i.test((x.textContent || '').trim()));
                    if (b) { b.click(); return { clicked: true }; }
                    return { status: document.getElementById('statusText').textContent, prompt: !!document.getElementById('videoSelectOverlay') };
                });
                if (s.prompt) await page.keyboard.press('Escape');
                if (/^SLP loaded|uses SLP format/.test(s.status || '')) return s.status;
                await page.waitForTimeout(250);
            }
            return 'timeout';
        }
        const tag = async (page) => {
            // The handle is recorded once the loader's promise resolves, just after its status.
            await page.waitForTimeout(300);
            return page.evaluate(() => { const h = window.__lucid.state.slpFileHandle; return h ? h.__tag : null; });
        };
        const page = await freshPage();
        await page.evaluate(async () => {
            window.__new = await window.__fixture();
            window.__project = await window.__projectBytes('open-project', ['cam0', 'cam1']);
        });

        // With nothing open, File ▸ Load SLP picks a file itself.
        let t = await menu(page, 'menuLoadSlp', '__new', 'mice.slp');
        check(t === refusalFor('mice.slp') && (await tag(page)) === null, 'File ▸ Load SLP, refused: nothing recorded', t);
        t = await menu(page, 'menuLoadProject', '__new', 'mice.slp');
        check(t === refusalFor('mice.slp') && (await tag(page)) === null, 'File ▸ Open, refused: nothing recorded', t);

        t = await menu(page, 'menuLoadProject', '__project', 'open-project.slp');
        check(/^SLP loaded/.test(t) && (await tag(page)) === 'open-project.slp', 'File ▸ Open of a 2.x file: recorded', t);

        // The trap itself: a project is open, its handle set, and a refused file comes along.
        t = await menu(page, 'menuLoadProject', '__new', 'mice.slp');
        check(t === refusalFor('mice.slp'), 'File ▸ Open of the 3.0 file over it: refused', t);
        check((await tag(page)) === 'open-project.slp', 'the next Save still goes to the open project\'s own file', await tag(page));
        await page.close();

        const page2 = await freshPage();
        await page2.evaluate(async () => { window.__project = await window.__projectBytes('open-project', ['cam0', 'cam1']); });
        t = await menu(page2, 'menuLoadSlp', '__project', 'open-project.slp');
        check(/^SLP loaded/.test(t) && (await tag(page2)) === 'open-project.slp', 'File ▸ Load SLP of a 2.x file: recorded', t);
        await page2.close();
    }

    // =================================================================
    // Per-camera folders need a small real video, a calibration and a 2.x .slp.
    const FOLDER_HELPERS = async () => {
        const pd = await import('/pose/pose-data.js');
        const fio = await import('/import-export/file-io.js');
        const CAMS = ['cam1', 'cam2'], W = 320, H = 240;
        const mp4 = await (await fetch('/tests/fixtures/barcode-60/barcode-60.mp4')).blob();
        let toml = '';
        CAMS.forEach((cn, i) => {
            toml += '[cam_' + i + ']\nname = "' + cn + '"\nsize = [' + W + ', ' + H + ']\n'
                + 'matrix = [[600.0, 0.0, 160.0], [0.0, 600.0, 120.0], [0.0, 0.0, 1.0]]\n'
                + 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\n'
                + 'rotation = [0.0, ' + (0.2 * i) + ', 0.0]\ntranslation = [' + (15 * i) + ', 0.0, 0.0]\n\n';
        });
        const makeSlp = async (cam, root) => {
            const K = [[600, 0, 160], [0, 600, 120], [0, 0, 1]];
            const cams = CAMS.map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [W, H]));
            const s = new pd.Session(cams, new pd.Skeleton('sk', ['nose', 'body', 'tail'], [[0, 1], [1, 2]]), ['t'], 'gen');
            for (let f = 0; f < 4; f++) {
                const fg = new pd.FrameGroup(f);
                s.addFrameGroup(fg);
                fg.addInstance(cam, new pd.Instance([[10 + f, 20], [30 + f, 40], [50 + f, 60]], 0, 'user', 1));
            }
            const vfi = { videoPath: root + '/' + cam + '/' + cam + '.mp4', file: null, videoWidth: W, videoHeight: H, frameCount: 60 };
            return await fio.exportSlpClientSide(s, cam, false, vfi, cam + '.slp', null);
        };
        window.__folderParts = { CAMS, mp4, toml, makeSlp, newBytes: await window.__fixture() };
        window.__mkFile = (bits, relPath, size) => {
            const f = new File(bits, relPath.split('/').pop(), { type: 'application/octet-stream' });
            Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
            if (size) Object.defineProperty(f, 'size', { value: size });
            return f;
        };
        // [ camera, how many instances it holds ] for the session now open.
        window.__perCamera = async () => {
            const AS = await import('/ui/app-state.js');
            const s = AS.state.session, per = {};
            if (!s) return null;
            for (const c of s.cameras) per[c.name] = 0;
            if (s.lazyLoader && s.lazyLoader.labelsByCam) {
                for (const [cam, labels] of s.lazyLoader.labelsByCam) per[cam] = labels._lazyDataStore ? labels._lazyDataStore.framesData.frame_id.length : -1;
            } else {
                for (const [, fg] of s.frameGroups) {
                    for (const [cn, xs] of fg.instances) per[cn] = (per[cn] || 0) + xs.length;
                    for (const [cn, xs] of fg.unlinkedInstances) per[cn] = (per[cn] || 0) + xs.length;
                }
            }
            return { per, lazy: !!s.lazyLoader, views: AS.state.views.length };
        };
    };

    console.log('\n-- 5. per-camera folders: a view and no data, and the status says why --');
    for (const [label, size] of [['small files (eager route)', 0], ['large files (lazy route)', OVER_150_MB]]) {
        const page = await freshPage();
        await page.evaluate(FOLDER_HELPERS);
        // One camera refused, one fine.
        const mixed = await page.evaluate(async (size) => {
            const P = window.__folderParts, ROOT = 'sess';
            const files = [window.__mkFile([P.toml], ROOT + '/calibration.toml')];
            for (const c of P.CAMS) files.push(window.__mkFile([P.mp4], ROOT + '/' + c + '/' + c + '.mp4'));
            files.push(window.__mkFile([P.newBytes], ROOT + '/cam1/cam1.slp', size));
            files.push(window.__mkFile([await P.makeSlp('cam2', ROOT)], ROOT + '/cam2/cam2.slp', size));
            const loader = await import('/loading/session-loader.js');
            await loader.handleLoadSessionFolderPerCamera(files, false);
            return { cams: await window.__perCamera(), status: window.__status() };
        }, size);
        check(mixed.cams && mixed.cams.views === 2, label + ': both cameras have a view', JSON.stringify(mixed.cams));
        check(mixed.cams && mixed.cams.per.cam1 === 0 && mixed.cams.per.cam2 > 0, '  the refused camera holds nothing, the other its data', JSON.stringify(mixed.cams));
        check(mixed.cams && mixed.cams.lazy === !!size, '  by the route expected', JSON.stringify(mixed.cams));
        check(mixed.status.text.includes(refusalFor('cam1.slp')) && /error/.test(mixed.status.dot), '  the status gives the reason, in red', JSON.stringify(mixed.status));
        check(mixed.status.text.includes('1 annotation file(s) could not be read: cam1 (cam1.slp)'), '  and names the camera', mixed.status.text);
        await page.close();

        // Every camera refused.
        const page2 = await freshPage();
        await page2.evaluate(FOLDER_HELPERS);
        const all = await page2.evaluate(async (size) => {
            const P = window.__folderParts, ROOT = 'sess';
            const files = [window.__mkFile([P.toml], ROOT + '/calibration.toml')];
            for (const c of P.CAMS) {
                files.push(window.__mkFile([P.mp4], ROOT + '/' + c + '/' + c + '.mp4'));
                files.push(window.__mkFile([P.newBytes], ROOT + '/' + c + '/' + c + '.slp', size));
            }
            const loader = await import('/loading/session-loader.js');
            await loader.handleLoadSessionFolderPerCamera(files, false);
            return { cams: await window.__perCamera(), status: window.__status() };
        }, size);
        check(all.cams && all.cams.views === 2 && !all.cams.lazy && all.cams.per.cam1 === 0 && all.cams.per.cam2 === 0,
            label + ', every camera refused: the views, and no data', JSON.stringify(all.cams));
        check(all.status.text.includes('2 annotation file(s) could not be read') && /uses SLP format 3\.0/.test(all.status.text) && /error/.test(all.status.dot),
            '  and the status says why', JSON.stringify(all.status));
        await page2.close();
    }

    // =================================================================
    console.log('\n-- 6. a multi-session load ends on the reason --');
    {
        const page = await freshPage();
        await page.evaluate(FOLDER_HELPERS);
        await page.evaluate(async () => {
            const P = window.__folderParts;
            const dir = (name, entries) => ({
                kind: 'directory', name,
                [Symbol.asyncIterator]: async function* () { for (const e of entries) yield [e.name, e]; },
            });
            const file = (name, bits) => ({ kind: 'file', name, getFile: async () => new File(bits, name) });
            const session = (name) => dir(name, [
                file('calibration.toml', [P.toml]),
                ...P.CAMS.map(c => dir(c, [file(c + '.mp4', [P.mp4]), file(c + '.slp', [P.newBytes])])),
            ]);
            window.showDirectoryPicker = async () => dir('parent', [session('sessionA'), session('sessionB')]);
            const loader = await import('/loading/session-loader.js');
            window.__multiDone = loader.handleLoadMultiSession().then(() => true, e => 'THREW ' + e);
        });
        await page.waitForSelector('#msSkelSkip', { timeout: 60000 });
        await page.click('#msSkelSkip');
        check(await page.evaluate(() => window.__multiDone) === true, 'the load finished');
        await page.waitForTimeout(300);
        const st = await page.evaluate(() => window.__status());
        check(/uses SLP format 3\.0/.test(st.text) && st.text.includes('4 annotation file(s) could not be read') && /error/.test(st.dot),
            'the last status gives the reason, in red, after the skeleton prompt', JSON.stringify(st));
        check((await page.evaluate(() => window.__snapshot())).sessions.length === 2, 'and both sessions are there, with their views');
        await page.close();
    }

    // =================================================================
    console.log('\n-- 7. the environment step refuses too --');
    {
        const page = await freshPage();
        const r = await page.evaluate(async () => {
            const AS = await import('/ui/app-state.js');
            const pd = await import('/pose/pose-data.js');
            const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
            const cams = ['cam0', 'cam1'].map((n, i) => new pd.Camera(n, M, [0, 0, 0, 0, 0], [0, 0.3 * i, 0], [-12 * i, 0, 0], [512, 512]));
            const s = new pd.Session(cams, new pd.Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t'], 'env');
            AS.state.sessions = [s]; AS.state.session = s;
            const bytes = await window.__fixture();
            const good = await window.__projectBytes('env', ['cam0', 'cam1']);
            s._envFiles = { cam0: [new File([bytes], 'cam0.externals.slp')], cam1: [new File([good], 'cam1.externals.slp')] };
            const was = AS.viewport3d;
            AS.setViewport3D(was || {});
            document.getElementById('statusText').textContent = 'waiting';
            document.getElementById('btnSetEnv').click();
            for (let i = 0; i < 200 && document.getElementById('statusText').textContent === 'waiting'; i++) await new Promise(res => setTimeout(res, 100));
            for (let i = 0; i < 200 && /^Loading/.test(document.getElementById('statusText').textContent); i++) await new Promise(res => setTimeout(res, 100));
            AS.setViewport3D(was);
            return window.__status();
        });
        check(r.text === refusalFor('cam0.externals.slp') && /error/.test(r.dot), 'it says so, rather than triangulating from the readable camera', JSON.stringify(r));
        await page.close();
    }

    // =================================================================
    console.log('\n-- 8. a project file with sessions, marked 3.0, is refused on both routes --');
    {
        const page = await freshPage();
        await page.evaluate(async () => {
            window.__project = await window.__projectBytes('with-sessions', ['cam0', 'cam1']);
            window.__marked = await window.__withFormatId(window.__project, 3);
            window.__marked41 = await window.__withFormatId(window.__project, 4.1);
        });
        let r = await run(page, EAGER, '__marked', 'marked.slp');
        check(r.returned === false && (await page.evaluate(() => window.__status())).text === refusalFor('marked.slp'), 'eager');
        r = await run(page, LAZY, '__marked', 'marked.slp');
        check(r.returned === false && (await page.evaluate(() => window.__status())).text === refusalFor('marked.slp'), 'lazy');
        r = await run(page, EAGER, '__marked41', 'later.slp');
        check((await page.evaluate(() => window.__status())).text === refusalFor('later.slp', '4.1'), 'a later format names itself');
        check((await page.evaluate(() => window.__snapshot())).sessions.length === 0, 'no session from any of them');
        await page.close();
    }

    // =================================================================
    console.log('\n-- 9. 2.x files are unaffected --');
    {
        const page = await freshPage();
        await page.evaluate(async () => {
            window.__project = await window.__projectBytes('fine', ['cam0', 'cam1']);
            window.__justBelow = await window.__withFormatId(window.__project, 2.99);
            window.__noId = await (async () => {
                const h5 = window.h5wasm;
                await h5.ready;
                const p = '/no-format-id.slp';
                h5.FS.writeFile(p, window.__project);
                const f = new h5.File(p, 'a');
                f.get('metadata').delete_attribute('format_id');
                f.close();
                const out = h5.FS.readFile(p);
                h5.FS.unlink(p);
                return new Uint8Array(out);
            })();
            window.__real = await window.__real2x();
        });
        const readers = await page.evaluate(async () => {
            const fio = await import('/import-export/file-io.js');
            const { SioLazyLoader } = await import('/loading/sio-lazy-loader.js');
            const out = {};
            for (const [name, bytes] of [['real SLEAP file', window.__real], ['format 2.99', window.__justBelow], ['no format_id', window.__noId]]) {
                const file = new File([bytes], 'x.slp');
                const lazy = new SioLazyLoader();
                const opened = await lazy.open('cam', file);
                out[name] = {
                    vendored: (await fio.parseSlpViaSleapIO(file)).frames.length,
                    raw: (await fio.parseSlpH5(file)).frames.length,
                    lazy: opened.nFrames,
                    probe: (await fio.checkSlpFileFormat(file)) === undefined,
                };
            }
            return out;
        });
        for (const [name, o] of Object.entries(readers)) {
            check(o.vendored > 0 && o.vendored === o.raw && o.lazy > 0 && o.probe, name + ' reads in every reader', JSON.stringify(o));
        }
        const notHdf5 = await page.evaluate(async () => {
            const fio = await import('/import-export/file-io.js');
            const f = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'junk.slp');
            const probe = await fio.checkSlpFileFormat(f).then(() => 'resolved', e => 'rejected: ' + e.message);
            const raw = await fio.parseSlpH5(f).then(() => 'read', e => e.message);
            return { probe, raw };
        });
        check(notHdf5.probe === 'resolved', 'the probe leaves a file that is not HDF5 to the real read', JSON.stringify(notHdf5));
        check(/Not a readable HDF5\/SLP file/.test(notHdf5.raw), 'which still says so in its own words, with its stack', notHdf5.raw.slice(0, 120));

        // The lazy route still replaces the open project with a file it can read.
        const opened = await run(page, EAGER, '__project', 'first.slp');
        check(opened.done === true && (await page.evaluate(() => window.__snapshot())).frameGroups === 3, 'a project is open');
        await page.evaluate(async () => { window.__second = await window.__projectBytes('second', ['camA', 'camB']); });
        const big = await run(page, ROUTED, '__second', 'second.slp', OVER_200_MB);
        const after = await page.evaluate(() => window.__snapshot());
        check(big.done === true && big.returned !== false && after.lazy && after.sessions.length === 1, 'a big 2.x file replaces it through the lazy route', JSON.stringify([big, after]));
        await page.close();
    }
} catch (e) {
    console.log('  ✗ threw:', e && e.stack || e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
