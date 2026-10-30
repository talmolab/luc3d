/**
 * seekbar-preview.mjs — the selected view's thumbnail above the seekbar's hover
 * tooltip (ui/seekbar-preview.js), and the decoder call behind it
 * (`peekFrame`, loading/video.js), in the real app.
 *
 * Part A — the UI, on a 4-camera grid of fake decoders whose frames encode
 * (frame, view) in their pixels:
 *  1. Hovering shows the ACTIVE pane's view at the hovered frame (pixels and
 *     label), above the tooltip bubble without overlapping it, and clamped over
 *     the bar at both ends.
 *  2. It follows a change of active pane, and the solo view in single-view mode
 *     — not `lastInteractedView`, which moving the pointer over a view sets.
 *  3. Hovering never calls getFrame (the playback path) or moves the frame.
 *  4. With a slow decoder, a fast sweep decodes only a few frames (newest wins,
 *     nothing queued), ends on the frame under the cursor, and a frame hovered
 *     before is shown from the cache with no new decode.
 *  5. Hidden during a drag and on leave; back on release over the bar; absent
 *     when the view has no image at that frame ("No image at this frame").
 *
 * Part B — `OnDemandVideoDecoder.peekFrame` on a real B-frame video
 * (tests/fixtures/barcode-60, frame number burned in as a barcode):
 *  6. mediabunny: every frame peeked is the frame asked for, and a peek leaves
 *     the step cursor, the last stepped frame and the backend's frame cache
 *     (contents AND LRU order) exactly as they were; the bitmap is the caller's.
 *  7. HTML5 (`LUCID_VIDEO_BACKEND='html5'`): frame-accurate too, and the
 *     playback `<video>` is never seeked.
 *
 * Run: node tests/e2e/seekbar-preview.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8287);
const SHOT_DIR = process.env.SHOT_DIR || '';
const CLIP = 'tests/fixtures/barcode-60/barcode-60.mp4';
if (!fs.existsSync(path.join(repoRoot, CLIP))) {
    console.error(`  ✗ ${CLIP} is missing — regenerate it with tests/fixtures/barcode-60/make_fixture.sh`);
    process.exit(1);
}
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;   // absent demo assets
        console.log('  [console.error]', t.slice(0, 300));
        fails++;
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });

    // =================================================================
    // Part A — the UI on fake decoders
    // =================================================================
    const CAMS = ['camA', 'camB', 'camC', 'camD'];
    const N = 300;
    await page.evaluate(async ({ camNames, N }) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Skeleton, Camera, Session } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const cams = camNames.map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [640, 480]));
        const session = new Session(cams, skel, ['track_0'], 'S1');

        window.__peekDelay = 0;
        window.__peekMissing = new Set();      // frames with no image (as in an embedded .slp)
        function fakeDecoder(vi) {
            const src = document.createElement('canvas');
            src.width = 64; src.height = 48;
            const sctx = src.getContext('2d');
            const paint = (f) => { sctx.fillStyle = `rgb(${f % 256},${40 * vi},7)`; sctx.fillRect(0, 0, 64, 48); };
            const d = {
                samples: new Array(N), _fps: 30, _videoReady: true,
                calls: [], peeks: [], inFlight: 0, maxInFlight: 0, pos: 0,
                async getFrame(f) { d.calls.push(f); paint(f); return createImageBitmap(src); },
                async peekFrame(f, width) {
                    d.peeks.push(f);
                    d.inFlight++; d.maxInFlight = Math.max(d.maxInFlight, d.inFlight);
                    try {
                        if (window.__peekDelay) await new Promise(r => setTimeout(r, window.__peekDelay));
                        if (window.__peekMissing.has(f)) return null;
                        paint(f);
                        return createImageBitmap(src, { resizeWidth: Math.round(width), resizeHeight: Math.round(width * 0.75) });
                    } finally { d.inFlight--; }
                },
                drawCurrentFrame() { return false; },
                getCurrentFrameIndex() { return d.pos; },
                seekNativeSettled(f) { d.pos = f; return Promise.resolve(); },
                playNative() {}, pauseNative() {}, releaseFrames() {},
            };
            return d;
        }
        AS.state.sessions = [session];
        AS.state.session = session;
        AS.state.activeSessionIdx = 0;
        AS.state.totalFrames = N;
        AS.state.fps = 30;
        AS.state.currentFrame = 10;
        AS.state.views = cams.map((c, i) => ({
            name: c.name, videoWidth: 640, videoHeight: 480, canvas: null, decoder: fakeDecoder(i),
        }));
        AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name }));
        AS.state.viewMode = 'grid';
        AS.state.singleViewIndex = 0;
        AS.paneManager.clearAll();
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
        sp.activatePanelForView('camC');
        await new Promise(r => requestAnimationFrame(r));
    }, { camNames: CAMS, N });

    const bar = await page.evaluate(() => {
        const r = document.getElementById('seekbar').getBoundingClientRect();
        return { left: r.left, width: r.width, y: r.top + r.height / 2, top: r.top };
    });
    const xAt = (fraction) => Math.round(bar.left + fraction * bar.width);
    const frameAt = (x) => Math.round(Math.max(0, Math.min(1, (x - bar.left) / bar.width)) * (N - 1));

    // The box, its pixels (centre: frame in red, view in green / 40) and the tooltip's place.
    const preview = () => page.evaluate(() => {
        const box = document.getElementById('seekbarPreview');
        if (!box) return { exists: false };
        const cv = box.querySelector('canvas');
        const r = box.getBoundingClientRect();
        const tip = document.getElementById('seekbarTooltip').getBoundingClientRect();
        const bar = document.getElementById('seekbar').getBoundingClientRect();
        let px = null;
        if (cv.width && cv.height) {
            const d = cv.getContext('2d').getImageData(cv.width >> 1, cv.height >> 1, 1, 1).data;
            px = { frame: d[0], view: Math.round(d[1] / 40), blank: d[3] === 0 };
        }
        return {
            exists: true, hidden: box.hidden, label: box.querySelector('.seekbar-preview-label').textContent,
            pending: box.classList.contains('is-pending'), empty: box.classList.contains('is-empty'),
            emptyText: getComputedStyle(box, '::before').content,
            left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
            tipTop: tip.top, tipLeft: tip.left, tipRight: tip.right,
            barLeft: bar.left, barRight: bar.right, px,
        };
    });
    // Until the hovered frame is the one drawn (or `ms` passes).
    const settled = (frame) => page.waitForFunction((f) => {
        const box = document.getElementById('seekbarPreview');
        if (!box || box.hidden || box.classList.contains('is-pending')) return false;
        const cv = box.querySelector('canvas');
        const d = cv.getContext('2d').getImageData(cv.width >> 1, cv.height >> 1, 1, 1).data;
        return box.classList.contains('is-empty') || d[0] === f % 256;
    }, frame, { timeout: 5000 }).then(() => true, () => false);
    const decoderLog = () => page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const o = {};
        for (const v of AS.state.views) o[v.name] = { calls: v.decoder.calls.slice(), peeks: v.decoder.peeks.slice(), maxInFlight: v.decoder.maxInFlight };
        o.currentFrame = AS.state.currentFrame;
        return o;
    });
    const resetLog = () => page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        for (const v of AS.state.views) { v.decoder.calls.length = 0; v.decoder.peeks.length = 0; v.decoder.maxInFlight = 0; }
    });

    // ---- 1: the active pane's view at the hovered frame, above the bubble ----
    let p = await preview();
    check(p.exists && p.hidden, 'the preview box exists and is hidden before any hover');
    await resetLog();
    let x = xAt(0.4);
    await page.mouse.move(x, bar.y);
    check(await settled(frameAt(x)), `hover: settles on the hovered frame ${frameAt(x)}`);
    p = await preview();
    check(!p.hidden && p.px && p.px.frame === frameAt(x) % 256 && p.px.view === 2,
        `shows camC (the active pane) at frame ${frameAt(x)} (px ${JSON.stringify(p.px)})`);
    check(p.label === 'camC', `labelled with the camera (${JSON.stringify(p.label)})`);
    check(Math.abs(p.width - 226) <= 1 && Math.abs(p.height - (168 + 2)) <= 1,
        `224 px wide + border, 4:3 like the view (${p.width}×${p.height})`);
    check(p.bottom <= p.tipTop - 2 && p.bottom >= p.tipTop - 10,
        `sits just above the tooltip bubble (box bottom ${p.bottom.toFixed(1)}, bubble top ${p.tipTop.toFixed(1)})`);
    check(Math.abs((p.left + p.right) / 2 - x) <= 1, 'centred over the cursor mid-bar');
    if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 'seekbar-preview-mid.png') });

    let log = await decoderLog();
    check(CAMS.every(c => log[c].calls.length === 0), `hovering never calls getFrame (${JSON.stringify(CAMS.map(c => log[c].calls))})`);
    check(log.currentFrame === 10, `hovering does not move the frame (${log.currentFrame})`);
    check(CAMS.filter(c => c !== 'camC').every(c => log[c].peeks.length === 0), 'only the selected view is decoded');

    for (const [frac, side] of [[0.0, 'left'], [1.0, 'right']]) {
        await page.mouse.move(xAt(frac) + (frac ? -1 : 1), bar.y);
        await settled(frameAt(xAt(frac)));
        p = await preview();
        const inside = p.left >= p.barLeft - 1 && p.right <= p.barRight + 1;
        check(inside, `${side} end: clamped over the bar (${p.left.toFixed(0)}–${p.right.toFixed(0)} within ${p.barLeft.toFixed(0)}–${p.barRight.toFixed(0)})`);
    }

    // ---- 2: follows the active pane, and the solo view; not lastInteractedView ----
    await page.evaluate(async () => { (await import('/ui/sessions-panes.js')).activatePanelForView('camA'); });
    x = xAt(0.55);
    await page.mouse.move(x, bar.y);
    await settled(frameAt(x));
    p = await preview();
    check(p.px && p.px.view === 0 && p.label === 'camA', `follows a change of active pane to camA (px ${JSON.stringify(p.px)}, ${p.label})`);
    await page.evaluate(() => { window.__lucid.interactionManager.lastInteractedView = 'camD'; });
    await page.mouse.move(x + 3, bar.y);
    await settled(frameAt(x + 3));
    p = await preview();
    check(p.px && p.px.view === 0, `lastInteractedView (set by moving over a view) does not steal it (px ${JSON.stringify(p.px)})`);

    await page.mouse.move(700, 300);
    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        AS.state.viewMode = 'single'; AS.state.singleViewIndex = 1;
    });
    await page.mouse.move(x, bar.y);
    await settled(frameAt(x));
    p = await preview();
    check(p.px && p.px.view === 1 && p.label === 'camB', `single-view mode: the solo view, camB (px ${JSON.stringify(p.px)}, ${p.label})`);
    await page.evaluate(async () => { (await import('/ui/app-state.js')).state.viewMode = 'grid'; });

    // ---- 4: a slow decoder — newest wins, nothing queued, cache hits are instant ----
    await page.mouse.move(700, 300);
    await page.evaluate(() => { window.__peekDelay = 120; });
    await resetLog();
    const sweep = [];
    const t0 = Date.now();
    for (let k = 0; k <= 30; k++) {
        const sx = xAt(0.05 + k * 0.025);
        sweep.push(frameAt(sx));
        await page.mouse.move(sx, bar.y);
        await page.waitForTimeout(15);
    }
    const sweepMs = Date.now() - t0;
    const last = sweep[sweep.length - 1];
    check(await settled(last), `after a fast sweep it settles on the frame under the cursor (${last})`);
    log = await decoderLog();
    const peeksA = log.camA.peeks;
    check(log.camA.maxInFlight === 1, `one decode at a time (max in flight ${log.camA.maxInFlight})`);
    // One 120 ms decode after another for the sweep's length, plus the last frame — not one per frame.
    const bound = Math.ceil(sweepMs / 120) + 1;
    check(peeksA.length <= bound && peeksA.length <= new Set(sweep).size / 2,
        `the ${sweepMs} ms sweep over ${new Set(sweep).size} frames decoded only ${peeksA.length} (≤ ${bound}): ${JSON.stringify(peeksA)}`);
    check(peeksA[peeksA.length - 1] === last, 'the last decode is the frame under the cursor');
    await resetLog();
    await page.mouse.move(xAt(0.05 + 30 * 0.025) - 0, bar.y + 1);
    const again = sweep[sweep.length - 1];
    await settled(again);
    log = await decoderLog();
    check(log.camA.peeks.length === 0, `re-hovering a frame shown before comes from the cache (decodes: ${JSON.stringify(log.camA.peeks)})`);
    await page.evaluate(() => { window.__peekDelay = 0; });

    // ---- 5: drag, leave, release, no image ----
    x = xAt(0.3);
    await page.mouse.move(x, bar.y);
    await settled(frameAt(x));
    await page.mouse.down();
    await page.mouse.move(xAt(0.35), bar.y);
    p = await preview();
    check(p.hidden, 'hidden during a drag (the views show the scrubbed frame)');
    await page.mouse.up();
    await page.waitForTimeout(30);
    p = await preview();
    check(!p.hidden, 'back on release over the bar');
    await page.mouse.move(700, 300);
    p = await preview();
    check(p.hidden, 'hidden on leaving the bar');

    const missingX = xAt(0.92);   // past the sweep: never decoded, so not in the cache
    await page.evaluate((f) => window.__peekMissing.add(f), frameAt(missingX));
    await page.mouse.move(missingX, bar.y);
    await settled(frameAt(missingX));
    p = await preview();
    check(!p.hidden && p.empty && /No image/.test(p.emptyText) && p.px && p.px.blank,
        `a frame with no image: blank, saying so (${p.emptyText})`);
    await page.mouse.move(missingX + 6, bar.y);
    await settled(frameAt(missingX + 6));
    p = await preview();
    check(!p.empty && p.px && p.px.frame === frameAt(missingX + 6) % 256, 'and the next frame with one draws again');
    await page.mouse.move(700, 300);

    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        for (const v of AS.state.views) v.decoder = null;
    });
    await page.mouse.move(xAt(0.5), bar.y);
    await page.waitForTimeout(50);
    p = await preview();
    check(p.hidden, 'no box when the selected view has no decoder (the tooltip alone)');
    const tipShown = await page.evaluate(() => !document.getElementById('seekbarTooltip').hidden);
    check(tipShown, 'the tooltip still shows');
    await page.mouse.move(700, 300);

    // =================================================================
    // Part B — peekFrame on a real B-frame video
    // =================================================================
    const r = await page.evaluate(async (CLIP) => {
        const { OnDemandVideoDecoder } = await import('/loading/video.js');
        const cv = document.createElement('canvas'); cv.width = 256; cv.height = 32;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        const frameNumber = (bmp) => {
            if (!bmp) return null;
            cx.clearRect(0, 0, 256, 32);
            cx.drawImage(bmp, 0, 0, 256, 32);
            const d = cx.getImageData(0, 16, 256, 1).data;
            let v = 0;
            for (let i = 0; i < 16; i++) if (d[(8 + 16 * i) * 4] > 128) v |= 1 << i;
            return v;
        };
        const blob = await (await fetch('/' + CLIP)).blob();
        const file = new File([blob], 'barcode-60.mp4', { type: 'video/mp4' });
        const order = [37, 5, 52, 20, 44, 11, 29, 58, 2, 47, 14, 33, 0, 59];
        const out = {};

        // mediabunny
        const dec = new OnDemandVideoDecoder({ cacheSize: 200 });
        await dec.init(file);
        out.backend = !!dec._mbBackend;
        await dec.getFrame(10); await dec.getFrame(11);      // a paused step: cursor open at 12
        const be = dec._mbBackend;
        const cursor = dec._stepCursor, lastStep = dec._lastStepFrame;
        const keys = Array.from(be.cache.keys());
        out.cursorOpen = !!cursor;
        out.mb = [];
        for (const f of order) {
            const bmp = await dec.peekFrame(f, 256);
            out.mb.push({ f, got: frameNumber(bmp) });
            if (bmp) bmp.close();
        }
        const cachedBmp = await dec.peekFrame(11, 128);      // a cached frame: copied, scaled
        out.cachedCopy = { got: frameNumber(cachedBmp), w: cachedBmp.width, h: cachedBmp.height };
        cachedBmp.close();
        out.cacheIntact = !!be.cache.get(11) && be.cache.get(11).width === 256;
        out.sameCursor = dec._stepCursor === cursor;
        out.sameLastStep = dec._lastStepFrame === lastStep;
        out.sameKeys = JSON.stringify(Array.from(be.cache.keys())) === JSON.stringify(keys);
        out.stepAfter = frameNumber(await dec.getFrame(12));
        out.cursorKept = dec._stepCursor === cursor;
        out.outOfRange = [await dec.peekFrame(-1, 64), await dec.peekFrame(60, 64)];
        dec.close();
        out.afterClose = await dec.peekFrame(5, 64);

        // HTML5 (no backend)
        window.LUCID_VIDEO_BACKEND = 'html5';
        const h = new OnDemandVideoDecoder({ cacheSize: 200 });
        try { await h.init(file); } finally { delete window.LUCID_VIDEO_BACKEND; }
        out.htmlBackend = !!h._mbBackend;
        const t0 = h._videoEl.currentTime;
        let seeks = 0;
        h._videoEl.addEventListener('seeking', () => seeks++);
        out.html = [];
        for (const f of order) {
            const bmp = await h.peekFrame(f, 256);
            out.html.push({ f, got: frameNumber(bmp) });
            if (bmp) bmp.close();
        }
        // two at once: serialized on the private element, both right
        const [b1, b2] = await Promise.all([h.peekFrame(7, 256), h.peekFrame(41, 256)]);
        out.htmlConcurrent = [frameNumber(b1), frameNumber(b2)];
        b1 && b1.close(); b2 && b2.close();
        out.htmlPlaybackUntouched = h._videoEl.currentTime === t0 && seeks === 0;
        out.htmlOwnElement = !!h._peekEl && h._peekEl !== h._videoEl;
        h.close();
        out.htmlReleased = h._peekEl === null;
        return out;
    }, CLIP);

    check(r.backend && r.cursorOpen, 'mediabunny: backend up, step cursor open after a paused step');
    const mbWrong = r.mb.filter(x => x.got !== x.f);
    check(mbWrong.length === 0, `mediabunny: every peek is the frame asked for (${r.mb.length} jumps)` + (mbWrong.length ? ` — wrong: ${JSON.stringify(mbWrong)}` : ''));
    check(r.cachedCopy.got === 11 && r.cachedCopy.w === 128 && r.cachedCopy.h === 16,
        `a cached frame is copied at the asked width (${JSON.stringify(r.cachedCopy)})`);
    check(r.cacheIntact, 'closing that copy leaves the cached bitmap usable');
    check(r.sameCursor && r.sameLastStep, 'peeks leave the step cursor and the last stepped frame alone');
    check(r.sameKeys, 'peeks leave the frame cache untouched (contents and LRU order)');
    check(r.stepAfter === 12 && r.cursorKept, `the next step still continues the open cursor (frame ${r.stepAfter})`);
    check(r.outOfRange.every(b => b === null), 'out of range: null');
    check(r.afterClose === null, 'after close: null');
    check(!r.htmlBackend, 'HTML5: no backend');
    const htmlWrong = r.html.filter(x => x.got !== x.f);
    check(htmlWrong.length === 0, `HTML5: every peek is the frame asked for (${r.html.length} jumps)` + (htmlWrong.length ? ` — wrong: ${JSON.stringify(htmlWrong)}` : ''));
    check(r.htmlConcurrent[0] === 7 && r.htmlConcurrent[1] === 41, `HTML5: concurrent peeks are serialized, both right (${r.htmlConcurrent})`);
    check(r.htmlPlaybackUntouched && r.htmlOwnElement, 'HTML5: its own <video>; the playback one is never seeked');
    check(r.htmlReleased, 'HTML5: close() releases it');
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
