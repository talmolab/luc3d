/**
 * hev1-retag.mjs — on an engine that plays HEVC only when tagged `hvc1`
 * (Safari, the macOS app's WKWebView), a `hev1` video is played through a
 * re-tagged, disk-backed view of the File (loading/hev1-retag.js, applied in
 * OnDemandVideoDecoder.init / switchSource); everywhere else the original File
 * is used, by identity.
 *
 * The real gate is "canPlayType: hvc1 yes, hev1 no". Neither Playwright browser
 * here answers that (Chromium on Linux plays no HEVC; Playwright's Linux WebKit
 * plays both tags), so the "Safari" runs force it with
 * `window.__lucidHev1RetagGate = true`, and the "Chrome-like" runs use the
 * browser's own answer. Videos are picked through the real inputs
 * (Playwright's file chooser), so the Files carry `webkitRelativePath` as the
 * loaders get them.
 *
 * What reaches the video consumers is observed from outside: every
 * `URL.createObjectURL` of a video (the `<video>` element and peekFrame) and
 * every `Blob.prototype.slice` (mp4box's index, mediabunny's range source and
 * the codec diagnosis all read through `readBlobRange`, which slices).
 *
 *  1. Load Session Folder (per camera), gate forced on: Camera0 holds the hev1
 *     clip, Camera1 an H.264 clip.
 *     - the hev1 video's blob URL is made from the patched File: same name,
 *       type, lastModified and webkitRelativePath, bytes "hvc1" at the entry;
 *     - after it, no read of the ORIGINAL File (only the probe reads it,
 *       before), and the original still reads "hev1" and carries no marker;
 *     - the H.264 camera gets its original File (identity);
 *     - where the engine plays HEVC (WebKit): it loads, every consumer's
 *       decoder.file / _source is the patched File, state.videoFiles keeps the
 *       ORIGINAL (videoPath, name: what a save writes), frames decode, the
 *       status ends "played 1 HEVC video tagged hev1 as hvc1 (files
 *       unchanged)", and a session switch (switchSource) gets the SAME
 *       patched File. Where it does not (Chromium): the failure's codec
 *       diagnosis read the patched File (it reports the fourcc it read).
 *  2. The same folder, gate as the browser says (Chrome-like): every blob URL
 *     and every read is of the original File; no note.
 *  3. Videos prompt (File ▸ Load Videos), gate forced on: the same choke point.
 *
 * Run: node tests/e2e/hev1-retag.mjs               (Chromium)
 *      BROWSER=webkit node tests/e2e/hev1-retag.mjs (Playwright WebKit)
 * Spawns its own http.server (PORT=, default 9841).
 */
import * as playwright from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9841);
const BROWSER = process.env.BROWSER || 'chromium';
const HEV1 = path.join(repoRoot, 'tests/fixtures/hev1-retag/hev1.mp4');
const AVC = path.join(repoRoot, 'tests/fixtures/barcode-60/barcode-60.mp4');
for (const f of [HEV1, AVC]) {
    if (!fs.existsSync(f)) { console.error(`  ✗ ${f} is missing — regenerate with its make_fixture.sh`); process.exit(1); }
}

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-hev1-'));
function writeFolder(name) {
    const dir = path.join(tmpRoot, name);
    for (const [cam, src, file] of [['Camera0', HEV1, 'back_h265.mp4'], ['Camera1', AVC, 'side_h264.mp4']]) {
        fs.mkdirSync(path.join(dir, cam), { recursive: true });
        fs.copyFileSync(src, path.join(dir, cam, file));
    }
    return dir;
}
const hev1Bytes = fs.readFileSync(HEV1);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await playwright[BROWSER].launch({ headless: true });
    console.log('browser: ' + BROWSER + ' ' + browser.version());
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => { if (/hev1-retag/.test(m.text())) console.log('  [console]', m.text().slice(0, 200)); });

    // Record what the video consumers get.
    await page.addInitScript(() => {
        const log = window.__videoLog = [];
        const isVideo = (b) => b instanceof File && /\.mp4$/i.test(b.name);
        const cou = URL.createObjectURL;
        URL.createObjectURL = function (b) {
            if (isVideo(b)) log.push({ ev: 'url', file: b });
            return cou.apply(this, arguments);
        };
        const slice = Blob.prototype.slice;
        Blob.prototype.slice = function () {
            if (isVideo(this)) log.push({ ev: 'read', file: this });
            return slice.apply(this, arguments);
        };
    });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });

    const engine = await page.evaluate(() => {
        const v = document.createElement('video');
        return { hev1: v.canPlayType('video/mp4; codecs="hev1.1.6.L120.90"'), hvc1: v.canPlayType('video/mp4; codecs="hvc1.1.6.L120.90"') };
    });
    console.log('canPlayType:', JSON.stringify(engine));

    const resetApp = (gate) => page.evaluate(async (gate) => {
        const sl = await import('/import-export/save-load.js');
        sl.newProject(true);
        const AS = await import('/ui/app-state.js');
        AS.state.sessions = []; AS.state.activeSessionIdx = 0; AS.state.session = null;
        AS.state.videoFiles = []; AS.state.views = []; AS.state.decoderPool = [];
        if (gate === null) delete window.__lucidHev1RetagGate; else window.__lucidHev1RetagGate = gate;
        window.__videoLog.length = 0;
    }, gate);

    /** What the consumers got, per video name, plus the loaded state. */
    const inspect = () => page.evaluate(async () => {
        const s = window.__lucid.state;
        const ascii = async (blob, at) => {
            const b = new Uint8Array(await blob.slice(at, at + 4).arrayBuffer());
            return String.fromCharCode(...b);
        };
        const log = window.__videoLog.slice();   // before our own reads below
        const byName = {};
        for (let i = 0; i < log.length; i++) {
            const e = log[i], n = e.file.name;
            const r = byName[n] || (byName[n] = { urls: [], reads: 0, readsOfOriginalAfterUrl: 0, readsOfPatched: 0, firstUrl: -1 });
            if (e.ev === 'url') { r.urls.push(e.file); if (r.firstUrl < 0) r.firstUrl = i; }
            else {
                r.reads++;
                if (e.file.lucidHev1Retag) r.readsOfPatched++;
                else if (r.firstUrl >= 0) r.readsOfOriginalAfterUrl++;
            }
        }
        const out = {};
        for (const [n, r] of Object.entries(byName)) {
            const u = r.urls[0];
            const tag = u && u.lucidHev1Retag;
            out[n] = {
                urls: r.urls.length, reads: r.reads, readsOfPatched: r.readsOfPatched,
                readsOfOriginalAfterUrl: r.readsOfOriginalAfterUrl,
                allUrlsSameFile: r.urls.every(x => x === u),
                patched: !!tag,
                name: u && u.name, type: u && u.type, rel: u && u.webkitRelativePath,
                lastModifiedSame: tag ? u.lastModified === tag.original.lastModified : null,
                sizeSame: tag ? u.size === tag.original.size : null,
                patchedTag: tag ? await ascii(u, tag.offsets[0]) : null,
                originalTag: tag ? await ascii(tag.original, tag.offsets[0]) : null,
                originalHasMarker: tag ? ('lucidHev1Retag' in tag.original) : null,
                originalRel: tag ? tag.original.webkitRelativePath : null,
            };
        }
        const vfs = s.videoFiles.map(vf => ({
            name: vf.name, videoPath: vf.videoPath, fileName: vf.file && vf.file.name,
            fileIsOriginal: !!vf.file && !vf.file.lucidHev1Retag,
            decoderFilePatched: !!(vf.decoder && vf.decoder.file && vf.decoder.file.lucidHev1Retag),
            decoderFileIsVfFile: !!vf.decoder && vf.decoder.file === vf.file,
            decoderSourceIsFile: !!vf.decoder && vf.decoder._source === vf.decoder.file,
            patchedOfThis: !!(vf.decoder && vf.decoder.file && vf.decoder.file.lucidHev1Retag && vf.decoder.file.lucidHev1Retag.original === vf.file),
            frames: vf.decoder ? vf.decoder.samples.length : null,
            mediabunny: !!(vf.decoder && vf.decoder._mbBackend),
        }));
        return { consumers: out, vfs, status: document.getElementById('statusText').textContent };
    });

    const loadPerCamera = async (dir) => {
        page.once('filechooser', async (fc) => { await fc.setFiles(dir); });
        await page.evaluate(async () => {
            const loader = await import('/loading/session-loader.js');
            await loader.handleLoadSessionFolderPerCamera();
        });
    };

    // =================================================================
    console.log('\n1. Load Session Folder (per camera), gate forced on');
    {
        const dir = writeFolder('rec-on');
        await resetApp(true);
        await loadPerCamera(dir);
        const r = await inspect();
        console.log('  status:', r.status.slice(0, 300));
        const h = r.consumers['back_h265.mp4'] || {};
        const a = r.consumers['side_h264.mp4'] || {};
        check(h.urls >= 1 && h.patched, `the hev1 video's <video> blob URL is made from a patched File (${h.urls} URL(s))`);
        check(h.allUrlsSameFile, 'every blob URL of it is the same patched File');
        check(h.name === 'back_h265.mp4' && h.type === 'video/mp4' && h.lastModifiedSame && h.sizeSame,
            `same name, type, size, lastModified (${h.name}, ${h.type})`);
        check(h.rel === h.originalRel && /Camera0\/back_h265\.mp4$/.test(h.rel || ''), `webkitRelativePath preserved (${h.rel})`);
        check(h.patchedTag === 'hvc1', `the patched File reads "${h.patchedTag}" at the sample entry`);
        check(h.originalTag === 'hev1' && h.originalHasMarker === false, `the original File is untouched (reads "${h.originalTag}", no marker)`);
        check(h.readsOfOriginalAfterUrl === 0, `no consumer reads the original after the blob URL (${h.reads} reads, ${h.readsOfPatched} of the patched File)`);
        check(a.urls >= 1 && a.patched === false, 'the H.264 camera gets its original File (not patched)');

        const hv = r.vfs.find(v => v.fileName === 'back_h265.mp4');
        const av = r.vfs.find(v => v.fileName === 'side_h264.mp4');
        check(av && av.decoderFileIsVfFile && av.fileIsOriginal, 'H.264 camera: decoder.file IS state.videoFiles[i].file (identity)');
        if (hv) {
            // The engine plays HEVC (Playwright WebKit): every consumer is checked.
            check(hv.fileIsOriginal && hv.patchedOfThis && hv.decoderFilePatched && hv.decoderSourceIsFile,
                'loaded: decoder.file and _source are the patched view OF state.videoFiles[i].file, which stays the original');
            check(/Camera0\/back_h265\.mp4$/.test(hv.videoPath) && hv.fileName === 'back_h265.mp4',
                `what a save writes keeps the original file name and path (${hv.videoPath})`);
            console.log('  (frame-accurate mediabunny backend on it: ' + hv.mediabunny + ')');
            check(hv.frames === 30, `the index (mp4box / mediabunny) reads 30 frames from it (${hv.frames})`);
            check(h.readsOfPatched > 0, `the index and decoder read the patched File (${h.readsOfPatched} reads)`);
            check(/played 1 HEVC video tagged hev1 as hvc1 \(files unchanged\)$/.test(r.status), 'the status ends with the quiet note');
            const fr = await page.evaluate(async () => {
                const vf = window.__lucid.state.videoFiles.find(v => v.file.name === 'back_h265.mp4');
                const bmp = await vf.decoder.getFrame(17);
                const ok = !!bmp && (bmp.width || bmp.displayWidth) === 128;
                // switchSource: the same original gives the same patched File.
                const before = vf.decoder.file;
                await vf.decoder.switchSource(vf.file);
                return { ok, same: vf.decoder.file === before, frames: vf.decoder.samples.length };
            });
            check(fr.ok, 'a frame decodes');
            check(fr.same && fr.frames === 30, 'switchSource(original) gives the SAME patched File (one probe per File)');
        } else {
            check(!/played \d+ HEVC/.test(r.status), 'this engine plays no HEVC: the load fails, with no "played" note');
            check(/HEVC/.test(r.status), 'and the status explains the HEVC failure');
            check(h.readsOfPatched > 0, `the codec diagnosis read the patched File (${h.readsOfPatched} reads)`);
        }
    }

    // =================================================================
    console.log('\n2. Same folder, gate as the browser says (Chrome-like here)');
    {
        const dir = writeFolder('rec-off');
        await resetApp(null);
        const gateReal = await page.evaluate(async () => (await import('/loading/hev1-retag.js')).hev1RetagNeeded());
        check(gateReal === false, `this browser does not need the re-tag (canPlayType hev1 "${engine.hev1}", hvc1 "${engine.hvc1}")`);
        await loadPerCamera(dir);
        const r = await inspect();
        const h = r.consumers['back_h265.mp4'] || {};
        check(h.urls >= 1 && !h.patched && h.readsOfPatched === 0, 'the hev1 video: original File only (no patched File made or read)');
        check(r.vfs.every(v => v.decoderFileIsVfFile && v.fileIsOriginal), `every loaded decoder.file IS state.videoFiles[i].file (${r.vfs.length} loaded)`);
        check(!/played \d+ HEVC/.test(r.status), 'no note');
    }

    // =================================================================
    console.log('\n3. Videos prompt (Load Videos), gate forced on');
    {
        await resetApp(true);
        const vid = path.join(tmpRoot, 'prompt');
        fs.mkdirSync(vid, { recursive: true });
        fs.writeFileSync(path.join(vid, 'top_h265.mp4'), hev1Bytes);
        page.once('filechooser', async (fc) => { await fc.setFiles(path.join(vid, 'top_h265.mp4')); });
        await page.evaluate(async () => {
            const loader = await import('/loading/session-loader.js');
            await loader.handleLoadVideos();
        });
        const r = await inspect();
        const h = r.consumers['top_h265.mp4'] || {};
        check(h.urls >= 1 && h.patched && h.patchedTag === 'hvc1' && h.originalTag === 'hev1', 'patched File to <video>, original untouched');
        check(h.readsOfOriginalAfterUrl === 0, 'no read of the original after it');
        const hv = r.vfs.find(v => v.fileName === 'top_h265.mp4');
        if (hv) {
            check(hv.patchedOfThis && hv.fileIsOriginal && hv.frames === 30, 'loaded through the patched view; state keeps the original');
            check(/played 1 HEVC video tagged hev1 as hvc1 \(files unchanged\)$/.test(r.status), `status note (${r.status})`);
        }
    }
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
