/**
 * Drive calibrat3 end to end on a session folder and record everything the
 * benchmark needs: the exported TOML, the saved session (so the SAME detections
 * can be scored by independent code), and per-stage wall clock.
 *
 * A trimmed, instrumented sibling of tests/e2e/real-session.mjs -- no playback
 * measurement, plus the knobs the benchmark varies:
 *
 *   SESSION=/path OUT=/path/prefix [TARGET=800|ALL_FRAMES=1] [REF_CAM=Camera6]
 *   [BASE=http://localhost:8080] node calibrat3_run.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://localhost:8080';
const SESSION = process.env.SESSION, OUT = process.env.OUT;
if (!SESSION || !OUT) { console.error('SESSION= and OUT= are required'); process.exit(2); }
const ALL_FRAMES = process.env.ALL_FRAMES === '1';
const TARGET = process.env.TARGET || '800';
const REF_CAM = process.env.REF_CAM || null;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1700, height: 1050 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
const t0 = Date.now();
const step = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const waitState = (pred, arg, opts) => Promise.race([
    page.waitForFunction(pred, arg, opts),
    (async () => { for (;;) { await page.waitForTimeout(1000); const b = await page.evaluate(() => { const e = document.getElementById('errorMsg'); return e && e.style.display === 'block' ? e.textContent : null; }).catch(() => null); if (b) throw new Error(`app error banner: ${b}`); } })(),
]);
const timing = {};

try {
    await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
    await waitState(() => document.getElementById('workerStatus').classList.contains('ok'), null, { timeout: 300000 });

    // ---- load -----------------------------------------------------------------
    const tL = Date.now();
    // 10 min, not Playwright's default 30 s: setInputFiles COPIES the directory's
    // contents into the browser, and a session of eight 67 MB videos blew the default
    // (the run then failed before a single frame was decoded).
    await page.setInputFiles('#folderInput', SESSION, { timeout: 600000 });
    await waitState(() => window.__calibrat3.state.views.length >= 2 && window.__calibrat3.state.totalFrames > 0, null, { timeout: 900000 });
    timing.load_s = (Date.now() - tL) / 1000;
    const info = await page.evaluate(() => ({
        layout: window.__calibrat3.state.sessionLayout,
        views: window.__calibrat3.state.views.map(v => v.name),
        frames: window.__calibrat3.state.totalFrames,
        board: window.__calibrat3.state.board,
        size: [window.__calibrat3.state.views[0].info.width, window.__calibrat3.state.views[0].info.height],
    }));
    step(`session: ${info.views.length} views ${info.size.join('x')}, ${info.frames} frames, layout ${info.layout}, board ${JSON.stringify(info.board)}`);

    // ---- detection ------------------------------------------------------------
    if (ALL_FRAMES) { await page.check('#allFramesCheck'); await page.dispatchEvent('#allFramesCheck', 'change'); }
    else { await page.fill('#targetSamples', TARGET); await page.dispatchEvent('#targetSamples', 'input'); }
    const tD = Date.now();
    await page.click('#runDetectionBtn');
    await waitState(() => !window.__calibrat3.state.detectionRunning && window.__calibrat3.state.detections && window.__calibrat3.state.detections.size > 0, null, { timeout: 7200000 });
    timing.detection_s = (Date.now() - tD) / 1000;
    const det = await page.evaluate(() => window.__calibrat3.state.detections.summary(6));
    step(`detection: ${det.frames} frames x ${info.views.length} views in ${timing.detection_s.toFixed(0)} s; per view ${JSON.stringify(det.perView)}`);

    // ---- intrinsics -----------------------------------------------------------
    const tI = Date.now();
    await page.click('#computeIntrinsicsBtn');
    await waitState(() => document.getElementById('computeIntrinsicsBtn').disabled === false && window.__calibrat3.state.intrinsics.length > 0, null, { timeout: 7200000 });
    timing.intrinsics_s = (Date.now() - tI) / 1000;
    const intr = await page.evaluate(() => window.__calibrat3.state.intrinsics.map(r => r ? { rms: r.rmsError, used: r.framesUsed, fx: r.fx, k1: r.k1 } : null));
    step(`intrinsics in ${timing.intrinsics_s.toFixed(0)} s: ${intr.map((r, i) => r ? `${info.views[i]} rms=${r.rms.toFixed(2)} fx=${r.fx.toFixed(0)}` : `${info.views[i]} FAILED`).join('; ')}`);

    // ---- extrinsics -----------------------------------------------------------
    // THE REFERENCE ("bridge") CAMERA IS SET BEFORE THE CHAIN IS BUILT, not after:
    // stage-extrinsics reads the select at solve time, and it is also the camera the
    // world frame is pinned to.
    if (REF_CAM !== null) {
        const idx = info.views.findIndex(n => n === REF_CAM || new RegExp(`(^|[-_ ])${REF_CAM}([-_ .]|$)`).test(n));
        if (idx < 0) throw new Error(`REF_CAM ${REF_CAM} not among ${info.views.join(', ')}`);
        await page.selectOption('#referenceCamera', String(idx));
        step(`reference camera: ${info.views[idx]} (index ${idx})`);
        timing.reference_camera = info.views[idx];
    }
    const tE = Date.now();
    await page.click('#computeExtrinsicsBtn');
    await waitState(() => window.__calibrat3.state.reproj !== null, null, { timeout: 7200000 });
    timing.extrinsics_s = (Date.now() - tE) / 1000;
    const ext0 = await page.evaluate(() => window.__calibrat3.state.reproj.summary);
    step(`extrinsics in ${timing.extrinsics_s.toFixed(0)} s: ${ext0.points} points, ${ext0.observations} obs; median ${ext0.overall.median.toFixed(2)} px p95 ${ext0.overall.p95.toFixed(1)}`);

    // ---- bundle adjustment ----------------------------------------------------
    await page.waitForSelector('#runSbaBtn:not([disabled])', { timeout: 120000 });
    const tS = Date.now();
    await page.click('#runSbaBtn');
    await waitState(() => window.__calibrat3.state.sbaResult !== null, null, { timeout: 10800000 });
    await page.waitForSelector('#runSbaBtn:not([disabled])', { timeout: 10800000 });
    timing.sba_s = (Date.now() - tS) / 1000;
    const ext1 = await page.evaluate(() => window.__calibrat3.state.reproj.summary);
    step(`SBA in ${timing.sba_s.toFixed(0)} s: median ${ext1.overall.median.toFixed(2)} px p95 ${ext1.overall.p95.toFixed(1)}`);

    // ---- deposits -------------------------------------------------------------
    const { writeFileSync } = await import('node:fs');
    const toml = await page.evaluate(async () => (await import('./ui/stage-export.js')).buildToml());
    writeFileSync(`${OUT}.toml`, toml);
    const json = await page.evaluate(async () => { const { serializeSession } = await import('./import-export/session-save.js'); return JSON.stringify(serializeSession(window.__calibrat3.state)); });
    writeFileSync(`${OUT}.session.json`, json);
    timing.total_s = (Date.now() - t0) / 1000;
    writeFileSync(`${OUT}.timing.json`, JSON.stringify({
        session: SESSION, allFrames: ALL_FRAMES, target: ALL_FRAMES ? null : Number(TARGET),
        views: info.views, size: info.size, totalFrames: info.frames,
        // Per view, the frames a board was actually found in -- the detector's yield,
        // which is the other half of "whose corners" and is not recoverable from the
        // frame count alone (one camera of the 8-camera rig is found by one detector
        // in 2651 frames and by the other in 1001).
        detectionFrames: det.frames, detectionPerView: det.perView, timing,
        appSummary: { initial: ext0.overall, refined: ext1.overall },
    }, null, 1));
    step(`wrote ${OUT}.{toml,session.json,timing.json} (${(json.length / 1e6).toFixed(1)} MB session)`);
} catch (e) {
    errors.push(`driver: ${e.message}`);
    const logTail = await page.evaluate(() => Array.from(document.querySelectorAll('#logBody .log-entry')).slice(-20).map(x => x.textContent).join('\n')).catch(() => '');
    console.log('--- app log tail ---\n' + logTail);
} finally {
    await browser.close();
}
if (errors.length) { console.log('\nFAILED:\n' + errors.join('\n')); process.exit(1); }
console.log('\nDONE');
