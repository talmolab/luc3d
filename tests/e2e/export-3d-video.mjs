/**
 * export-3d-video.mjs — real-browser test for File ▸ "Export 3D Video"
 * (`showExport3DVideoModal` in ui/export-modals.js).
 *
 * This modal had NO end-to-end coverage while it owned its own hand-rolled
 * WebCodecs + mp4-muxer encoder. It now shares ui/video-encode.js with "Export
 * Video Overlays", so a break in that seam would hit both — and only one of them
 * was tested. This covers the 3D side of it:
 *
 *  - the menu item exists and opens the modal
 *  - the resolution picker's H.264 level strings are ones the encoder accepts
 *    (they are handed to mediabunny as `fullCodecString`, which VALIDATES them —
 *     a bad string would throw at setup, mid-export)
 *  - exporting a short range downloads a real, non-trivial MP4 whose `avc1`
 *    sample entry carries the chosen resolution
 *  - a short clip is NOT prompted for a streaming destination (it stays on the
 *    frictionless download path)
 *  - Esc closes the modal (CLAUDE.md modal convention)
 *
 * Runs against a synthetic calibrated session — no video fixture needed, so the
 * rendered 3D frames are near-empty. What is under test is the encode/mux/
 * deliver path, not the pixels.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8122);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // ---- synthetic session: 3 calibrated cameras, 12 frames, 3D points ------
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const names = ['cam1', 'cam2', 'cam3'];
        const cams = names.map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [100 * (i + 1), 0, 0], [0.1 * (i + 1), 0.2, 0.3], [640, 480]));
        const skel = new Skeleton('sk', ['head', 'tail'], [[0, 1]]);
        const session = new Session(cams, skel, ['t0'], 'Video3DTest');

        // A group per frame, each with 3D points so the viewport has something
        // to draw and `setFrame` is exercised on every encoded frame.
        for (let f = 0; f < 12; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            const g = new InstanceGroup(1, -1);
            for (const n of names) {
                const inst = new Instance([[100 + f, 120], [200, 220 + f]], f, 'user', 1);
                g.addInstance(n, inst);
                fg.addInstance(n, inst);
            }
            g.points3d = new Float64Array([f * 2, 0, 10, f * 2, 5, 10]);
            session.instanceGroups.set(f, [g]);
        }

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 12;
        AS.state.currentFrame = 0;
        AS.state.fps = 30;
        AS.state.triangulationResults = new Map();
        AS.state.views = names.map(n => ({
            name: n, decoder: null, canvas: null, ctx: null,
            overlayCanvas: null, overlayCtx: null, videoWidth: 640, videoHeight: 480,
        }));
    });

    // ---- menu item ---------------------------------------------------------
    const menu = await page.evaluate(() => {
        const el = document.getElementById('menuExportVideo3d');
        return el ? el.textContent.trim() : null;
    });
    check(menu === 'Export 3D Video', `File menu has "Export 3D Video" (got ${JSON.stringify(menu)})`);

    // A short clip must NOT trigger the streaming destination prompt. Headless
    // Chromium rejects showSaveFilePicker instantly with AbortError, so if the
    // threshold logic regressed the export would abort instead of downloading —
    // count the calls to be sure it is never even reached.
    await page.evaluate(() => {
        window.__pickerCalls = 0;
        const real = window.showSaveFilePicker;
        window.showSaveFilePicker = function (...a) {
            window.__pickerCalls++;
            return real.apply(this, a);
        };
    });

    await page.evaluate(() => document.getElementById('menuExportVideo3d').click());
    await page.waitForTimeout(800);
    const opened = await page.evaluate(() =>
        !!document.querySelector('select') && !!document.querySelector('.multi-frame-modal'));
    check(opened, 'the modal opened');

    // ---- resolution options -------------------------------------------------
    // Pick the smallest preset so the render/encode loop is quick.
    const resInfo = await page.evaluate(() => {
        const sels = Array.from(document.querySelectorAll('.multi-frame-modal select'));
        const res = sels.find(s => Array.from(s.options).some(o => /480p|720p/.test(o.textContent)));
        if (!res) return null;
        const opts = Array.from(res.options).map(o => ({ v: o.value, t: o.textContent.trim() }));
        res.value = '480';
        res.dispatchEvent(new Event('change', { bubbles: true }));
        return { opts, value: res.value, out: (document.getElementById('v3dExportOutSize') || {}).textContent };
    });
    check(resInfo !== null, 'the quality picker is present');
    check(resInfo && resInfo.value === '480', 'selected the 480 tier for a fast run');

    // The quality tiers are shared with "Export Video Overlays" and must be the
    // four the user asked for, each STATING its number — a label like "2K" hides
    // which resolution you are about to get.
    check(resInfo && resInfo.opts.map(o => o.v).join(',') === '480,720,1080,2160',
        `tiers are 480/720/1080/2160 (got ${resInfo ? resInfo.opts.map(o => o.v).join(',') : 'null'})`);
    check(resInfo && resInfo.opts.map(o => o.t).join(' | ') ===
        '480p (854×480) | 720p (1280×720) | 1080p (1920×1080) | 2160p (3840×2160)',
        `each tier label states its pixel size (got ${resInfo ? resInfo.opts.map(o => o.t).join(' | ') : 'null'})`);
    // …and the chosen tier is echoed back as literal encoded pixels, so the
    // resolution is on screen and not only inside the dropdown.
    check(resInfo && /^854×480 · /.test(resInfo.out || ''),
        `the Output readout reflects the chosen tier (got ${JSON.stringify(resInfo && resInfo.out)})`);

    // Every advertised H.264 level must be one mediabunny will accept as a
    // fullCodecString — otherwise createMp4Writer throws at setup for that
    // resolution and only that resolution, which is easy to ship unnoticed.
    // The strings are no longer hand-written per tier: they come from the shared
    // `h264CodecFor`, so probe them AT the tier dimensions rather than assuming
    // 640x360 is representative — a level that covers 480p may not cover 4K.
    const codecCheck = await page.evaluate(async () => {
        const mb = await import('mediabunny');
        const L = await import('/ui/overlay-export-layout.js');
        const out = {};
        for (const k of Object.keys(L.RES_PRESETS)) {
            const p = L.RES_PRESETS[k];
            const s = L.h264CodecFor(p.refW, p.h);
            const key = k + 'p → ' + s + ' @ ' + p.refW + 'x' + p.h;
            try {
                const ok = await mb.canEncodeVideo('avc', {
                    width: p.refW, height: p.h,
                    bitrate: L.bitrateFor(p.refW, p.h, 30, 'medium'),
                    fullCodecString: s,
                });
                // `canEncodeVideo` VALIDATES the string (throws on a malformed
                // one) and separately reports support. A false here is a real
                // "this machine cannot encode 4K", not a bad level — record it
                // distinctly so an unsupported CI box doesn't read as a bug.
                out[key] = ok ? 'accepted' : 'valid-but-unsupported-here';
            } catch (e) { out[key] = e.name + ': ' + e.message; }
        }
        return out;
    });
    const badCodec = Object.entries(codecCheck)
        .filter(([, v]) => v !== 'accepted' && v !== 'valid-but-unsupported-here');
    check(badCodec.length === 0,
        'every tier maps to a valid H.264 level string' + (badCodec.length ? ': ' + JSON.stringify(badCodec) : ''));
    const unsupported = Object.entries(codecCheck).filter(([, v]) => v === 'valid-but-unsupported-here');
    if (unsupported.length) console.log('    (not encodable on this machine: ' + unsupported.map(([k]) => k).join(', ') + ')');

    // ---- export -------------------------------------------------------------
    // The whole session is only 12 frames, so the default full range is already
    // a fast run; no need to narrow it.
    const btns = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.multi-frame-modal button')).map(b => b.textContent.trim()));
    check(btns.some(t => /^Export/i.test(t)), `modal has an Export button (buttons: ${btns.join(', ')})`);

    const dl = page.waitForEvent('download', { timeout: 120000 });
    await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.multi-frame-modal button'))
            .find(x => /^Export/i.test(x.textContent.trim()));
        b.click();
    });
    const download = await dl;
    const name = download.suggestedFilename();
    check(/\.mp4$/.test(name), `downloaded an .mp4 (got ${name})`);
    check(/_3d_480_/.test(name), `filename records the 3D export and tier (got ${name})`);

    const fs = await import('node:fs/promises');
    const tmp = path.join(repoRoot, 'tests', 'e2e', `.tmp-3d-${process.pid}.mp4`);
    await download.saveAs(tmp);
    const buf = await fs.readFile(tmp);
    await fs.unlink(tmp).catch(() => {});

    check(buf.length > 1000, `mp4 is non-trivial (${buf.length} bytes)`);
    check(buf.slice(4, 8).toString('latin1') === 'ftyp', 'output is a real MP4 (ftyp box)');

    // avc1 VisualSampleEntry: skip the ftyp compatible-brand match by requiring
    // 6 zero reserved bytes then data_reference_index == 1.
    const avcDims = (b) => {
        const needle = Buffer.from('avc1', 'latin1');
        for (let at = b.indexOf(needle); at >= 0; at = b.indexOf(needle, at + 1)) {
            const body = at + 4;
            if (body + 28 > b.length) break;
            if (!b.slice(body, body + 6).every(x => x === 0)) continue;
            if (b.readUInt16BE(body + 6) !== 1) continue;
            return { width: b.readUInt16BE(body + 24), height: b.readUInt16BE(body + 26) };
        }
        return null;
    };
    const dims = avcDims(buf);
    check(dims !== null, 'mp4 carries an avc1 sample entry');
    check(dims && dims.width === 854 && dims.height === 480,
        `mp4 is the chosen 480 tier (got ${dims ? dims.width + 'x' + dims.height : 'null'}, expected 854x480)`);

    const pickerCalls = await page.evaluate(() => window.__pickerCalls);
    check(pickerCalls === 0,
        `a short clip never asks for a streaming destination (picker calls: ${pickerCalls})`);

    // ---- Esc closes ---------------------------------------------------------
    await page.waitForTimeout(500);
    await page.evaluate(() => document.getElementById('menuExportVideo3d').click());
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const closed = await page.evaluate(() => !document.querySelector('.multi-frame-modal'));
    check(closed, 'Esc closes the modal');

    console.log('');
    check(errs.length === 0, 'no page errors / console errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}

console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
