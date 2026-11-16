/**
 * save-opens-in-recording-folder.mjs — File ▸ Save opens in the folder the
 * recording was opened from (`loading/recording-folder.js`).
 *
 * ## The bug
 * The save picker had no `startIn`, so Chromium opened it wherever the last
 * save of this site went. Labelling recordings one after another, the user's
 * labels for recording B were saved into recording A's folder, twice. The
 * session folder loaders picked with `<input webkitdirectory>`, which gives the
 * page the files but never the folder, so nothing could say where B was.
 *
 * Playwright's headless Chromium has no `showDirectoryPicker`, so the pickers
 * are stubbed: `showDirectoryPicker` returns an in-memory folder (an async
 * iterator of [name, handle], as the real handle is) holding a calibration and
 * two cameras' videos; `showSaveFilePicker` records its options and returns an
 * in-memory file whose writable collects the bytes.
 *
 *  1. Open Session Folder (per camera) on recording A: the folder picker gets
 *     its own `id`; File ▸ Save's picker gets `startIn` = A's folder and A's
 *     name; the save completes, and the file never mentions the handle.
 *  2. A fresh page (as when the user reloads to label the next recording) on
 *     recording B: Save opens in B's folder, not A's.
 *  3. B opened in the SAME page after A was saved: Save As (Save would write
 *     the file A's save chose) opens in B's folder, B being the active session;
 *     switching back to A, Save As opens in A's.
 *  4. Multi-session folder (a parent of A and B): each session opens in its
 *     own subfolder.
 *  5. Single-SLP folder mode: the same.
 *  6. A browser without `showDirectoryPicker` (the folder input): the folder
 *     still loads, and Save passes no `startIn` (today's behaviour).
 *  7. Save As on a project opened from a file, with no recording folder: it
 *     opens beside that file.
 *  8. File ▸ Save Compact Copy opens in the recording's folder too.
 *
 * Run: node tests/e2e/save-opens-in-recording-folder.mjs   (spawns its own
 * http.server; PORT= to move it)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8391);
const CALIB = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'campy-recording', 'calibration.toml'), 'utf8');

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-save-folder-'));

/**
 * In the page: in-memory folder handles, pickers that record their options,
 * and the loaders. `window.__t` holds them.
 */
async function setUpPage(page, { directoryPicker = true } = {}) {
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });
    await page.evaluate(async ({ calib, directoryPicker }) => {
        const enc = await import('./ui/video-encode.js');
        const canvas = document.createElement('canvas');
        canvas.width = 160; canvas.height = 120;
        const cctx = canvas.getContext('2d');
        const wr = await enc.createMp4Writer({ canvas, width: 160, height: 120, fps: 20,
            bitrate: 300000, frameCount: 10, keyFrameEveryFrames: 5 });
        for (let i = 0; i < 10; i++) {
            cctx.fillStyle = 'rgb(' + (20 * i) + ',60,90)'; cctx.fillRect(0, 0, 160, 120);
            await wr.addFrame(i);
        }
        const mp4 = new Uint8Array(await (await wr.finish()).blob.arrayBuffer());

        const fileHandle = (name, bytes, type) => ({
            kind: 'file', name,
            getFile: async () => new File([bytes], name, { type: type || '' }),
        });
        const dirHandle = (name, entries) => ({
            kind: 'directory', name,
            async *[Symbol.asyncIterator]() { for (const e of entries) yield [e.name, e]; },
            async *entries() { for (const e of entries) yield [e.name, e]; },
        });
        const recording = (name) => dirHandle(name, [
            fileHandle('calibration.toml', calib),
            dirHandle('Camera0', [fileHandle('0.mp4', mp4, 'video/mp4')]),
            dirHandle('Camera1', [fileHandle('0.mp4', mp4, 'video/mp4')]),
        ]);

        const t = window.__t = { dirCalls: [], saveCalls: [], written: [], nextDir: null };
        t.recording = recording;
        t.dirHandle = dirHandle;
        if (directoryPicker) {
            window.showDirectoryPicker = async (opts) => { t.dirCalls.push(opts || {}); return t.nextDir; };
        } else {
            delete window.showDirectoryPicker;
        }
        window.showSaveFilePicker = async (opts) => {
            t.saveCalls.push(opts || {});
            const chunks = [];
            const h = {
                kind: 'file', name: opts && opts.suggestedName,
                createWritable: async () => ({
                    write: async (c) => { chunks.push(new Uint8Array(c.buffer ? c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) : c)); },
                    close: async () => { t.written.push(chunks); },
                    abort: async () => {},
                }),
            };
            return h;
        };
        t.loader = await import('./loading/session-loader.js');
        t.panes = await import('./ui/sessions-panes.js');
        t.save = await import('./import-export/save-load.js');
        t.state = (await import('./ui/app-state.js')).state;
        t.lastSave = () => {
            const o = t.saveCalls[t.saveCalls.length - 1] || {};
            return { startIn: o.startIn ? o.startIn.name + ':' + o.startIn.kind : null, suggestedName: o.suggestedName || null,
                hasStartIn: 'startIn' in o };
        };
        t.status = () => document.getElementById('statusText').textContent;
    }, { calib: CALIB, directoryPicker });
}

/** Open recording `name` through Open Session Folder (per camera). */
const openPerCamera = (page, name) => page.evaluate(async (name) => {
    const t = window.__t;
    t.nextDir = t.recording(name);
    await t.loader.handleLoadSessionFolderPerCamera();
    return { views: t.state.views.length, session: t.state.session && t.state.session.name, sessions: t.state.sessions.length };
}, name);

const saveAs = (page) => page.evaluate(async () => {
    const t = window.__t;
    await t.save.saveAs();
    return Object.assign(t.lastSave(), { status: t.status() });
});

let browser;
try {
    browser = await chromium.launch();
    const newPage = async (opts) => {
        const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
        page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
        await setUpPage(page, opts);
        return page;
    };

    // =================================================================
    console.log('\n1. Recording A, per-camera folder, then File ▸ Save');
    let page = await newPage();
    {
        const r = await openPerCamera(page, '20260605_123859-HardFight');
        check(r.views === 2 && r.session === '20260605_123859-HardFight', 'A loads: 2 views, session named after the folder (' + JSON.stringify(r) + ')');
        const d = await page.evaluate(() => window.__t.dirCalls[0]);
        check(d && d.id === 'lucid-recording-folder' && d.mode === 'read', 'folder picker has its own id, read-only (' + JSON.stringify(d) + ')');
        const s = await page.evaluate(async () => {
            const t = window.__t;
            await t.save.quickSave();
            const bytes = t.written[0] ? t.written[0].reduce((n, c) => n + c.length, 0) : 0;
            const text = t.written[0] ? new TextDecoder('latin1').decode(new Uint8Array(t.written[0].flatMap(c => Array.from(c)))) : '';
            return Object.assign(t.lastSave(), { status: t.status(), bytes, mentionsHandle: /_recordingFolder|recordingFolder/.test(text) });
        });
        check(s.startIn === '20260605_123859-HardFight:directory', 'Save opens in A\'s folder (' + s.startIn + ')');
        check(s.suggestedName === '20260605_123859-HardFight.slp', 'suggested name is A\'s (' + s.suggestedName + ')');
        check(/^Saved/.test(s.status) && s.bytes > 0, 'the save completes (' + s.status + ', ' + s.bytes + ' bytes)');
        check(!s.mentionsHandle, 'the file does not mention the folder handle');
    }

    // =================================================================
    console.log('\n2. Reload, then recording B: Save opens in B\'s folder');
    await page.close();
    page = await newPage();
    {
        await openPerCamera(page, '20260605_131220-HardFight');
        const s = await page.evaluate(async () => { await window.__t.save.quickSave(); return window.__t.lastSave(); });
        check(s.startIn === '20260605_131220-HardFight:directory', 'Save opens in B\'s folder, not A\'s (' + s.startIn + ')');
        check(s.suggestedName === '20260605_131220-HardFight.slp', 'suggested name is B\'s (' + s.suggestedName + ')');
    }

    // =================================================================
    console.log('\n3. A, saved, then B in the same page');
    await page.close();
    page = await newPage();
    {
        await openPerCamera(page, 'recA');
        await page.evaluate(async () => { await window.__t.save.quickSave(); });
        const r = await openPerCamera(page, 'recB');
        check(r.sessions === 2 && r.session === 'recB', 'B is a second session and the active one (' + JSON.stringify(r) + ')');
        let s = await saveAs(page);
        check(s.startIn === 'recB:directory', 'Save As opens in B\'s folder (' + s.startIn + ')');
        await page.evaluate(async () => { await window.__t.panes.switchSession(0); });
        s = await saveAs(page);
        check(s.startIn === 'recA:directory', 'after switching to A, Save As opens in A\'s folder (' + s.startIn + ')');
    }

    // =================================================================
    console.log('\n4. Multi-session folder: each session keeps its own subfolder');
    await page.close();
    page = await newPage();
    {
        const r = await page.evaluate(async () => {
            const t = window.__t;
            t.nextDir = t.dirHandle('day1', [t.recording('recA'), t.recording('recB')]);
            await t.loader.handleLoadMultiSession();
            return t.state.sessions.map(s => s.name + ':' + (s._recordingFolder ? s._recordingFolder.name : null));
        });
        check(JSON.stringify(r) === JSON.stringify(['recA:recA', 'recB:recB']), 'each session holds its own folder (' + r.join(', ') + ')');
        const names = [];
        for (const i of [0, 1]) {
            await page.evaluate(async (i) => { await window.__t.panes.switchSession(i); }, i);
            names.push((await saveAs(page)).startIn);
        }
        check(names[0] === 'recA:directory' && names[1] === 'recB:directory', 'Save As follows the active session (' + names.join(', ') + ')');
    }

    // =================================================================
    console.log('\n5. Single-SLP folder mode');
    await page.close();
    page = await newPage();
    {
        const s = await page.evaluate(async () => {
            const t = window.__t;
            // A plain SLEAP file (poses on frames 0..2) at the top, videos in videos/.
            const pd = await import('./pose/pose-data.js');
            const fio = await import('./import-export/file-io.js');
            const cams = ['Camera0', 'Camera1'];
            const sess = new pd.Session(cams.map(n => new pd.Camera(n, [[600, 0, 80], [0, 600, 60], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [160, 120])),
                new pd.Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], 'sleap');
            for (let f = 0; f < 3; f++) {
                const fg = new pd.FrameGroup(f); sess.addFrameGroup(fg);
                cams.forEach((cn, ci) => fg.addInstance(cn, new pd.Instance([[30 + f, 4 + ci], [70 + ci, 24]], 0, 'user', 1)));
            }
            const labels = fio.buildSlpLabelsAllViews(sess,
                cams.map(n => ({ name: n, videoWidth: 160, videoHeight: 120, frameCount: 10 })),
                cams.map(n => ({ name: n, assignedCamera: n, videoPath: 'videos/' + n + '.mp4' })));
            labels.sessions.length = 0;
            const slp = await window.SleapIO.saveSlpToBytes(labels);
            const mp4 = await (await (async () => { for await (const [n, h] of t.recording('x')) if (n === 'Camera0') for await (const [, v] of h) return v.getFile(); })()).arrayBuffer();
            const fh = (name, bytes) => ({ kind: 'file', name, getFile: async () => new File([bytes], name) });
            t.nextDir = t.dirHandle('recS', [fh('labels.slp', slp),
                t.dirHandle('videos', cams.map(n => fh(n + '.mp4', mp4)))]);
            await t.loader.handleLoadSessionFolderSingleSlp();
            await t.save.quickSave();
            return Object.assign(t.lastSave(), { session: t.state.session && t.state.session.name });
        });
        check(s.session === 'recS' && s.startIn === 'recS:directory', 'Save opens in the folder (' + JSON.stringify(s) + ')');
    }

    // =================================================================
    console.log('\n6. No showDirectoryPicker: the folder input, as before');
    await page.close();
    page = await newPage({ directoryPicker: false });
    {
        const dir = path.join(tmpRoot, 'recInput');
        for (const cam of ['Camera0', 'Camera1']) fs.mkdirSync(path.join(dir, cam), { recursive: true });
        fs.writeFileSync(path.join(dir, 'calibration.toml'), CALIB);
        const mp4 = Buffer.from(await page.evaluate(async () => {
            const f = await window.__t.recording('x');
            for await (const [n, h] of f) if (n === 'Camera0') for await (const [, v] of h) {
                const b = new Uint8Array(await (await v.getFile()).arrayBuffer());
                let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s);
            }
        }), 'base64');
        for (const cam of ['Camera0', 'Camera1']) fs.writeFileSync(path.join(dir, cam, '0.mp4'), mp4);
        page.once('filechooser', async (fc) => { await fc.setFiles(dir); });
        const r = await page.evaluate(async () => {
            const t = window.__t;
            await t.loader.handleLoadSessionFolderPerCamera();
            await t.save.quickSave();
            return Object.assign(t.lastSave(), { views: t.state.views.length, status: t.status() });
        });
        check(r.views === 2, 'the folder loads through the input (' + r.views + ' views)');
        check(!r.hasStartIn && r.suggestedName === 'recInput.slp', 'Save passes no startIn, suggests the session name (' + JSON.stringify(r) + ')');
    }

    // =================================================================
    console.log('\n7. Save As with no recording folder opens beside the project file');
    {
        const s = await page.evaluate(async () => {
            const t = window.__t;
            t.state.slpFileHandle = { kind: 'file', name: 'opened.slp' };
            await t.save.saveAs();
            return t.lastSave();
        });
        check(s.startIn === 'opened.slp:file', 'startIn is the file Save As replaces (' + s.startIn + ')');
    }

    // =================================================================
    console.log('\n8. Save Compact Copy opens in the recording\'s folder');
    await page.close();
    page = await newPage();
    {
        await openPerCamera(page, 'recC');
        const run = page.evaluate(async () => {
            const t = window.__t;
            let opts = null;
            await t.save.saveCompactCopy({ pickFile: async (o) => { opts = o; return null; } });
            return opts && { startIn: opts.startIn ? opts.startIn.name + ':' + opts.startIn.kind : null, suggestedName: opts.suggestedName };
        });
        await page.click('#compactSaveContinue');
        const s = await run;
        check(s && s.startIn === 'recC:directory' && s.suggestedName === 'recC_compact.slp',
            'the compact copy\'s picker opens in the folder (' + JSON.stringify(s) + ')');
    }
} finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
