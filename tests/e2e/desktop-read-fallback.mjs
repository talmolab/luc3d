/**
 * desktop-read-fallback.mjs — folder READS in the desktop app's WebKit
 * webviews go through `<input webkitdirectory>`, never the shim's write-only
 * `showDirectoryPicker`.
 *
 * On macOS/Linux the desktop shim installs a WRITE-capable
 * `window.showDirectoryPicker` and sets `window.lucidDesktop.fsaWriteOnly`;
 * its handles cannot give disk-backed Files. So every folder READ site asks
 * `canReadDirectoryHandles()` (`ui/browser-hints.js`) and, when it says no,
 * picks with webkitdirectory — Load Multiple Sessions through
 * `directoryHandleFromFileList` (`loading/file-list-directory.js`), which
 * rebuilds the tree so its handle walk runs unchanged.
 *
 * The page is made to look like the desktop app with an init script:
 * `lucidDesktop = {isDesktop, fsaWriteOnly}`, no `showOpenFilePicker`, and a
 * `showDirectoryPicker` stub that only COUNTS calls (and rejects) — any call
 * from a read site is a failure. Folders are written to disk and picked
 * through Playwright's file chooser (`setFiles(dir)` on the webkitdirectory
 * input).
 *
 *  1. File ▸ Load Multiple Sessions: the chooser is a webkitdirectory input,
 *     both sessions load (cameras, videos decoded), the parent skeleton.json is
 *     auto-loaded through the rebuilt tree, the picker stub is never called
 *     and no status mentions Chrome.
 *  2. The videos prompt's Select Session Folder: `folderPickerStartFor` gives
 *     no start handle on desktop, and even with one forced in, `pickFolderNear`
 *     reads through webkitdirectory.
 *  3. The prompt's Select Parent Directory (`pickParentDirectoryForSessions`)
 *     matches both sessions through webkitdirectory.
 *  4. Control — a plain Chromium page (no `lucidDesktop`): Load Multiple
 *     Sessions still calls `showDirectoryPicker` with `{mode: 'read'}`, and
 *     `folderPickerStartFor` still returns the handle.
 *
 * Run: node tests/e2e/desktop-read-fallback.mjs   (spawns its own http.server;
 * PORT= to move it)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9341);
const CALIB = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'campy-recording', 'calibration.toml'), 'utf8');

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-desktop-read-'));

// Stands in for the desktop shim (worker B's lucid-desktop.js): what matters
// here is only what LUCID can see of it.
const DESKTOP_INIT = () => {
    window.lucidDesktop = { isDesktop: true, fsaWriteOnly: true };
    try { delete window.showOpenFilePicker; } catch (e) { /* */ }
    window.showOpenFilePicker = undefined;
    window.__dirPickerCalls = [];
    window.showDirectoryPicker = async (opts) => {
        window.__dirPickerCalls.push(opts || null);
        const e = new Error('write-only polyfill used for a read');
        e.name = 'AbortError';
        throw e;
    };
};
const CHROME_INIT = () => {
    window.__dirPickerCalls = [];
    window.showDirectoryPicker = async (opts) => {
        window.__dirPickerCalls.push(opts || null);
        const e = new Error('cancelled'); e.name = 'AbortError'; throw e;
    };
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

async function openPage(browser, init) {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    await ctx.addInitScript(init);
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 300)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });
    return page;
}

let browser;
try {
    browser = await chromium.launch();
    const page = await openPage(browser, DESKTOP_INIT);

    // Two 20-frame videos per session, written with the app's own encoder.
    const mp4 = Buffer.from(await page.evaluate(async () => {
        const enc = await import('/ui/video-encode.js');
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 48;
        const cctx = canvas.getContext('2d');
        const wr = await enc.createMp4Writer({ canvas, width: 64, height: 48, fps: 20,
            bitrate: 200000, frameCount: 20, keyFrameEveryFrames: 5 });
        for (let i = 0; i < 20; i++) {
            cctx.fillStyle = 'rgb(' + (10 * i) + ',60,90)'; cctx.fillRect(0, 0, 64, 48);
            await wr.addFrame(i);
        }
        const buf = new Uint8Array(await (await wr.finish()).blob.arrayBuffer());
        let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
        return btoa(s);
    }), 'base64');

    const parent = path.join(tmpRoot, 'experiment');
    for (const sess of ['sessA', 'sessB']) {
        fs.mkdirSync(path.join(parent, sess), { recursive: true });
        fs.writeFileSync(path.join(parent, sess, 'calibration.toml'), CALIB);
        for (const cam of ['Camera0', 'Camera1']) {
            fs.mkdirSync(path.join(parent, sess, cam), { recursive: true });
            fs.writeFileSync(path.join(parent, sess, cam, '0.mp4'), mp4);
        }
    }
    fs.writeFileSync(path.join(parent, 'skeleton.json'),
        JSON.stringify({ skeleton: { name: 'desk', nodes: ['nose', 'tail'], edges: [] } }));

    const statuses = [];
    await page.exposeFunction('__noteStatus', (t) => { statuses.push(t); });
    await page.evaluate(() => {
        const el = document.getElementById('statusText');
        new MutationObserver(() => window.__noteStatus(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    });

    // =================================================================
    console.log('\n1. Load Multiple Sessions on the desktop app');
    {
        check(await page.evaluate(async () => (await import('/ui/browser-hints.js')).canReadDirectoryHandles()) === false,
            'canReadDirectoryHandles() is false with fsaWriteOnly');
        let chooserInfo = null;
        page.once('filechooser', async (fc) => {
            chooserInfo = await fc.element().evaluate(el => ({ dir: !!el.webkitdirectory }));
            await fc.setFiles(parent);
        });
        await page.evaluate(() => document.getElementById('menuLoadMultiSessionFolder').click());
        await page.waitForFunction(() => /Loaded skeleton from skeleton\.json/.test(document.getElementById('statusText').textContent)
            || /error/i.test(document.getElementById('statusDot').className), null, { timeout: 60000 });
        const r = await page.evaluate(() => {
            const s = window.__lucid.state;
            return {
                status: document.getElementById('statusText').textContent,
                sessions: s.sessions.map(x => x.name),
                cameras: s.sessions.map(x => x.cameras.map(c => c.name).join('+')),
                views: s.views.map(v => v.name),
                frames: s.views.map(v => v.decoder ? v.decoder.samples.length : null),
                skeleton: s.session && s.session.skeleton ? s.session.skeleton.nodes.map(n => n.name || n).join(',') : null,
                calls: window.__dirPickerCalls.length,
            };
        });
        console.log('  measured:', JSON.stringify(r));
        check(chooserInfo && chooserInfo.dir, 'the folder was picked with a webkitdirectory input');
        check(r.calls === 0, 'the write-only showDirectoryPicker was never called');
        check(r.sessions.length === 2 && r.sessions.every((n, i) => n.indexOf(['sessA', 'sessB'][i]) >= 0),
            `both sessions loaded, in folder order (${r.sessions})`);
        check(r.cameras.every(c => c === 'Camera0+Camera1'), `each with its calibration's cameras (${r.cameras})`);
        check(r.views.length === 2 && r.frames.every(n => n === 20), `the first session's videos decode (${r.frames})`);
        check(r.skeleton === 'nose,tail', `the parent skeleton.json was read through the rebuilt tree (${r.skeleton})`);
        check(!statuses.some(t => /Chrome|Edge/.test(t)), 'no status told the user to use Chrome or Edge');
    }

    // =================================================================
    console.log('\n2. Select Session Folder in the videos prompt');
    {
        const noStart = await page.evaluate(async () => {
            const loader = await import('/loading/session-loader.js');
            const AS = await import('/ui/app-state.js');
            const keep = AS.state.slpFileHandle;
            AS.state.slpFileHandle = { kind: 'file', name: 'proj.slp' };
            const r = loader.folderPickerStartFor({ name: 'proj.slp' });
            AS.state.slpFileHandle = keep;
            return r === null;
        });
        check(noStart, 'folderPickerStartFor gives no start handle on desktop (prompt uses the upload picker)');

        let chooserDir = null;
        page.once('filechooser', async (fc) => {
            chooserDir = await fc.element().evaluate(el => !!el.webkitdirectory);
            await fc.setFiles(path.join(parent, 'sessA'));
        });
        const picked = page.evaluate(async () => {
            const loader = await import('/loading/session-loader.js');
            // A start handle forced in anyway: pickFolderNear must still read via webkitdirectory.
            const files = await loader.forceVideoSelectionWithFolder('', 'sessA',
                { startIn: { kind: 'file', name: 'proj.slp' } });
            return Array.isArray(files) ? files.map(f => f.webkitRelativePath).sort() : files;
        });
        await page.waitForSelector('#videoSelectOverlay');
        await page.evaluate(() => Array.from(document.querySelectorAll('#videoSelectOverlay button'))
            .find(b => b.textContent === 'Select Session Folder').click());
        const got = await picked;
        check(chooserDir === true, 'pickFolderNear opened a webkitdirectory input');
        check(JSON.stringify(got) === JSON.stringify(['sessA/Camera0/0.mp4', 'sessA/Camera1/0.mp4']),
            `and returned the folder's videos (${JSON.stringify(got)})`);
        check(await page.evaluate(() => window.__dirPickerCalls.length) === 0, 'showDirectoryPicker still never called');
    }

    // =================================================================
    console.log('\n3. Select Parent Directory (pickParentDirectoryForSessions)');
    {
        page.once('filechooser', async (fc) => { await fc.setFiles(parent); });
        const r = await page.evaluate(async () => {
            const loader = await import('/loading/session-loader.js');
            const res = await loader.pickParentDirectoryForSessions(['sessA', 'sessB']);
            return {
                matched: Array.from(res.matched.entries()).map(([k, v]) => k + ':' + v.map(f => f.webkitRelativePath).sort().join('|')),
                unmatched: res.unmatched,
                calls: window.__dirPickerCalls.length,
            };
        });
        console.log('  measured:', JSON.stringify(r));
        check(r.unmatched.length === 0 && r.matched.length === 2, 'both sessions matched');
        check(r.matched[0] === 'sessA:experiment/sessA/Camera0/0.mp4|experiment/sessA/Camera1/0.mp4',
            'with their camera-folder files');
        check(r.calls === 0, 'without calling showDirectoryPicker');
    }
    await page.context().close();

    // =================================================================
    console.log('\n4. Control: plain Chromium keeps the File System Access path');
    {
        const cpage = await openPage(browser, CHROME_INIT);
        let chooser = false;
        cpage.once('filechooser', async (fc) => { chooser = true; await fc.setFiles([]); });
        const r = await cpage.evaluate(async () => {
            const hints = await import('/ui/browser-hints.js');
            const loader = await import('/loading/session-loader.js');
            const AS = await import('/ui/app-state.js');
            await loader.handleLoadMultiSession();
            AS.state.slpFileHandle = { kind: 'file', name: 'proj.slp' };
            const start = loader.folderPickerStartFor({ name: 'proj.slp' });
            AS.state.slpFileHandle = null;
            return {
                can: hints.canReadDirectoryHandles(),
                calls: window.__dirPickerCalls,
                status: document.getElementById('statusText').textContent,
                start: !!start,
            };
        });
        check(r.can === true, 'canReadDirectoryHandles() is true');
        check(r.calls.length === 1 && JSON.stringify(r.calls[0]) === '{"mode":"read"}',
            `Load Multiple Sessions called showDirectoryPicker({mode:'read'}) (${JSON.stringify(r.calls)})`);
        check(!chooser, 'and opened no upload input');
        check(r.status === 'No folder selected', `a cancel reads as before ("${r.status}")`);
        check(r.start, 'folderPickerStartFor still returns the project file handle');
        await cpage.context().close();
    }

    console.log(fails === 0 ? '\nPASS' : `\nFAIL — ${fails} failing assertion(s)`);
} catch (err) {
    console.error('\nERROR:', err);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}
process.exit(fails === 0 ? 0 : 1);
