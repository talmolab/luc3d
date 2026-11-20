/**
 * export-bycam-reopened-video.mjs — File ▸ Export SLEAP File By Cam on a project
 * reopened with Load Project, before any video is loaded, writes each camera's
 * video as the project file has it: the same filename and [frames, height,
 * width] (`cameraExportVideo`, import-export/file-io.js).
 *
 * It used to write `<camera>.mp4` with shape [0, 0, 0]. SLEAP 1.6.6 then could
 * not find the video, and its GUI failed to open the file: the status bar
 * divides by the video's frame count (ZeroDivisionError in
 * `MainWindow.updateStatusMessage`).
 *
 *  1. Every camera's file names that camera's video from the project file
 *     (`rec/<cam>/<cam>-20260920.mp4`), with its frame count, height and width.
 *  2. With a video attached, the attached video's path still wins.
 *
 * Run: PORT=9373 node tests/e2e/export-bycam-reopened-video.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9373);
const FRAMES = 400;
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
    page.setDefaultTimeout(180000);
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });

    const loadErr = await page.evaluate(async (FRAMES) => {
        const [pd, fileio] = await Promise.all([import('/pose/pose-data.js'), import('/import-export/file-io.js')]);
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const cams = ['cam0', 'cam1'];
        const M = [[900, 0, 320], [0, 900, 240], [0, 0, 1]];
        const s = new Session(cams.map((n, i) => new Camera(n, M, [0, 0, 0, 0, 0], [0, 0.3 * i, 0], [0, 0, 40], [640, 480])),
            new Skeleton('skeleton', ['n0', 'n1', 'n2'], [[0, 1], [1, 2]]), ['t0'], 'Reopened');
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            s.addFrameGroup(fg);
            const g = new InstanceGroup(f + 1, 0);
            cams.forEach((cn) => {
                const inst = new Instance([[50, 60], [60, 68], [70, 76]], 0, 'predicted', 0.9);
                inst._rawInstIndex = 0;
                fg.addInstance(cn, inst);
                g.addInstance(cn, inst);
            });
            s.instanceGroups.set(f, [g]);
        }
        // Each camera's video is FRAMES + 7 + i frames long, so the two shapes differ.
        const views = cams.map((n, i) => ({ name: n, videoWidth: 640, videoHeight: 480, frameCount: FRAMES + 7 + i }));
        const videoFiles = cams.map(n => ({ name: n, assignedCamera: n, videoPath: `rec/${n}/${n}-20260920.mp4` }));
        const bytes = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(s, views, videoFiles));
        window.__tstLoad = { done: false, err: null };
        (async () => {
            try { await (await import('/loading/session-loader.js')).handleLoadProjectSlpLazy(new File([bytes], 'reopened.slp')); window.__tstLoad.done = true; }
            catch (e) { window.__tstLoad.err = String(e && e.stack || e).slice(0, 500); }
        })();
        for (let i = 0; i < 600 && !window.__tstLoad.done && !window.__tstLoad.err; i++) {
            const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || '') && x.offsetParent);
            if (b) b.click();
            await new Promise(r => setTimeout(r, 100));
        }
        if (!window.__lucid.state.session.lazyLoader) return 'not lazy';
        window.__lucid.state.videoFiles = [];   // no video loaded yet
        // The picker stub: an in-memory folder that keeps every written blob.
        window.__blobs = {};
        const mkDir = (name, node, prefix) => ({
            kind: 'directory', name,
            getDirectoryHandle: async (n, o) => {
                if (!node.dirs[n]) { if (!(o && o.create)) throw new DOMException(n + ' not found', 'NotFoundError'); node.dirs[n] = { dirs: {}, files: {} }; }
                return mkDir(n, node.dirs[n], prefix + n + '/');
            },
            getFileHandle: async (fname) => ({ kind: 'file', name: fname, createWritable: async () => ({
                write: async (blob) => { node.files[fname] = { lastModified: Date.now() }; window.__blobs[prefix + fname] = blob; },
                close: async () => {},
            }) }),
            values: async function* () {
                for (const n of Object.keys(node.dirs)) yield mkDir(n, node.dirs[n], prefix + n + '/');
                for (const n of Object.keys(node.files)) yield { kind: 'file', name: n, getFile: async () => ({ lastModified: node.files[n].lastModified }) };
            },
        });
        window.showDirectoryPicker = async () => mkDir('exports', { dirs: {}, files: {} }, '');
        return window.__tstLoad.err;
    }, FRAMES);
    check(!loadErr, 'project reopened lazily, no video loaded', loadErr || undefined);

    /** Run the export; returns { [file]: videos_json entries }. */
    const runExport = () => page.evaluate(async () => {
        window.__blobs = {};
        (await import('/ui/export-modals.js')).showSlpExportByCamModal();
        document.getElementById('slpByCamDownloadAll').click();
        for (let i = 0; i < 1200; i++) {
            await new Promise(r => setTimeout(r, 50));
            if (document.getElementById('loadingOverlay').classList.contains('hidden') && Object.keys(window.__blobs).length
                && !document.querySelector('.slp-bycam-modal')) break;
        }
        const h5 = await import('h5wasm');
        await h5.ready;
        const out = {};
        for (const [p, blob] of Object.entries(window.__blobs)) {
            const fp = '/__vid_' + p.replace(/\W/g, '_');
            h5.FS.writeFile(fp, new Uint8Array(await blob.arrayBuffer()));
            const f = new h5.File(fp, 'r');
            out[p] = [].concat(f.get('videos_json').value).map(v => {
                const d = JSON.parse(v);
                return { filename: d.filename, shape: d.backend && d.backend.shape };
            });
            f.close();
            h5.FS.unlink(fp);
        }
        return out;
    });

    console.log('1. No video loaded: the project file\'s video record');
    const noVid = await runExport();
    check(Object.keys(noVid).length === 2, 'both cameras written', Object.keys(noVid));
    ['cam0', 'cam1'].forEach((cam, i) => {
        const vids = noVid[cam + '.slp'] || [];
        check(vids.length === 1 && vids[0].filename === `rec/${cam}/${cam}-20260920.mp4`,
            `${cam}: the project file's video name, not ${cam}.mp4`, vids);
        check(vids.length === 1 && JSON.stringify(vids[0].shape.slice(0, 3)) === JSON.stringify([FRAMES + 7 + i, 480, 640]),
            `${cam}: the project file's shape [${FRAMES + 7 + i}, 480, 640], not zeros`, vids);
    });

    console.log('2. An attached video still wins');
    await page.evaluate(() => {
        window.__lucid.state.videoFiles = [{ name: 'cam0', assignedCamera: 'cam0', sessionIdx: 0,
            videoPath: 'moved/cam0.mp4', videoWidth: 320, videoHeight: 240, frameCount: 99 }];
    });
    const withVid = await runExport();
    const v0 = (withVid['cam0.slp'] || withVid[Object.keys(withVid).find(k => k.endsWith('cam0.slp'))] || [])[0] || {};
    check(v0.filename === 'moved/cam0.mp4' && JSON.stringify((v0.shape || []).slice(0, 3)) === '[99,240,320]',
        'cam0: the attached video\'s path and shape', withVid);

    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
