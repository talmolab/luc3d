/**
 * compute-coexistence.mjs — LUCID's heavy runs next to a playing video: the user
 * should not NOTICE the machine working (pose/compute-governor.js;
 * prompts/compute-guardrails-report.md has the measurements behind the bounds).
 *
 * A 1080p60 ~20 Mb/s H.264 clip plays in a second, visible window, served from
 * 127.0.0.1 — another SITE than LUCID's localhost, so it has its own renderer,
 * as a YouTube tab would. LUCID then runs, on a real recording:
 *   Track All, Triangulate All (Refined, the heaviest CPU run), and the image
 *   ID-switch check on the GPU, cancelled after IMAGE_S seconds.
 * Asserted:
 *   1. the video drops at most 1% of its frames over the runs (measured: 0);
 *   2. LUCID's main thread never blocks for more than 2 s at once (measured
 *      worst: 1.1 s, the image check's per-camera fit);
 *   3. the page and the browser survive every run, and the triangulation pool
 *      followed the OS's CPU pressure (where Chrome has the Compute Pressure API);
 *   4. Cancel closes the image check within 2 s (measured: ~0.25 s).
 * SKIPS (exit 0) without installed Chrome, without a hardware WebGPU adapter, or
 * without the dataset. Headed (the video must be visible to count drops): takes
 * the browser lock (scripts/browser-lock.mjs). ~2 minutes.
 *   DATASET=<recording: <camera>/<video>.mp4 (+ calibration.toml)>
 *           default: lucid_folders/10072022145420 (10 min, 6 cameras, 18,255 frames)
 *   PREDICTIONS=<the same <camera>/ folders holding the predictions .slp>
 *           default: lucid_folders/slap_GT/10072022145420 (or DATASET itself)
 *   (a recording that small runs Triangulate All inline, and the image check needs > 60 s of tracking)
 *   IMAGE_S=40
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { answerTrackSetup } from './fixtures/track-setup.js';
import { acquireBrowserLock } from '../../scripts/browser-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const LF = path.join(os.homedir(), 'Documents/talmolab/lucid_folders');
const DATASET = process.env.DATASET || path.join(LF, '10072022145420');
const PREDICTIONS = process.env.PREDICTIONS || (process.env.DATASET ? DATASET : path.join(LF, 'slap_GT/10072022145420'));
const IMAGE_S = Number(process.env.IMAGE_S || 40);
const PORT = Number(process.env.PORT || 8296), MPORT = PORT + 1;
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const skip = (why) => { console.log('SKIP — ' + why); process.exit(0); };

if (!fs.existsSync(DATASET) || !fs.existsSync(PREDICTIONS)) skip('no dataset at ' + DATASET + ' / ' + PREDICTIONS);
// Per camera folder: its videos (from DATASET) and predictions .slp (from PREDICTIONS), read in place
// and presented as one folder (webkitRelativePath <root>/<camera>/<file>); plus the calibration.
const files = [], rel = [];
const calib = [DATASET, PREDICTIONS].map((d) => path.join(d, 'calibration.toml')).find((p) => fs.existsSync(p));
if (calib) { files.push(calib); rel.push('rec/calibration.toml'); }
for (const e of fs.readdirSync(DATASET, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const vids = fs.readdirSync(path.join(DATASET, e.name)).filter((f) => /\.mp4$/.test(f) && !f.startsWith('.'));
    const pdir = path.join(PREDICTIONS, e.name);
    const slps = fs.existsSync(pdir) ? fs.readdirSync(pdir).filter((f) => /\.slp$/.test(f) && !f.startsWith('.')) : [];
    if (vids.length !== 1 || !slps.length) continue;
    files.push(path.join(DATASET, e.name, vids[0])); rel.push('rec/' + e.name + '/' + vids[0]);
    for (const f of slps) { files.push(path.join(pdir, f)); rel.push('rec/' + e.name + '/' + f); }
}
if (!calib || rel.filter((r) => /\.mp4$/.test(r)).length < 2) skip('the dataset needs a calibration and 2+ cameras with a video and predictions');

const mediaDir = path.join(os.tmpdir(), 'lucid-coexist-media');
fs.mkdirSync(mediaDir, { recursive: true });
const clip = path.join(mediaDir, 'clip1080p60.mp4');
if (!fs.existsSync(clip)) {
    try {
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60,noise=alls=12:allf=t', '-t', '60',
            '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '20M', '-maxrate', '25M', '-bufsize', '40M', '-pix_fmt', 'yuv420p', '-g', '120', '-movflags', '+faststart', clip]);
    } catch (e) { skip('ffmpeg is needed to make the 1080p60 clip'); }
}
fs.writeFileSync(path.join(mediaDir, 'index.html'), `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000;height:100%}video{width:100%;height:100%}</style>
<video id="v" src="clip1080p60.mp4" muted loop autoplay playsinline></video><script>
const v = document.getElementById('v'); v.play().catch(() => {});
window.__q = () => { const q = v.getVideoPlaybackQuality(); return [q.droppedVideoFrames, q.totalVideoFrames]; };</script>`);

const server = spawn('python3', ['server.py', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
const mserver = spawn('python3', ['-m', 'http.server', String(MPORT), '--bind', '127.0.0.1'], { cwd: mediaDir, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const release = await acquireBrowserLock({ label: 'compute-coexistence e2e' });
let browser;
try {
    try { browser = await chromium.launch({ headless: false, channel: 'chrome' }); }
    catch (e) { skip('installed Chrome is needed (channel: chrome)'); }
    const place = async (page, left, top, width, height) => {
        const cdp = await page.context().newCDPSession(page);
        const { windowId } = await cdp.send('Browser.getWindowForTarget');
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left, top, width, height, windowState: 'normal' } });
    };
    const lctx = await browser.newContext({ viewport: null });
    const page = await lctx.newPage();
    let crashed = false;
    const errs = [], poolLogs = [];
    page.on('crash', () => { crashed = true; });
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    page.on('console', (m) => { if (/\[triangulation-pool\] workers/.test(m.text())) poolLogs.push(m.text()); });
    await page.addInitScript(() => {
        window.__lt = [];
        try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch (e) { /* none */ }
    });
    await answerTrackSetup(page, '');
    await place(page, 0, 0, 1000, 900);
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 60000 });
    const gpu = await page.evaluate(async () => {
        try { const a = navigator.gpu && await navigator.gpu.requestAdapter(); return a ? { ok: true, fallback: !!(a.info && a.info.isFallbackAdapter) } : { ok: false }; }
        catch (e) { return { ok: false }; }
    });
    if (!gpu.ok || gpu.fallback) skip('no hardware WebGPU adapter');
    const hasPressure = await page.evaluate(() => typeof PressureObserver === 'function');

    const mctx = await browser.newContext({ viewport: null });
    const media = await mctx.newPage();
    await place(media, 1005, 0, 480, 300);
    await media.goto(`http://127.0.0.1:${MPORT}/index.html`);
    await media.waitForFunction(() => window.__q()[1] > 30, null, { timeout: 30000 });

    await page.evaluate(async () => {
        (await import('./ui/settings.js')).setTrackingThresholds({ autoSwitchCheck: 0, autoImageSwitchCheck: 0 });
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.id = '__files'; inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
        setInterval(() => { for (const b of document.querySelectorAll('button')) { const t = b.textContent.trim(); if ((t === 'Continue' || t === 'OK' || t === 'Got it') && b.offsetParent !== null) b.click(); } }, 300);
    });
    await page.setInputFiles('#__files', files);
    // the per-camera loader reads each file's folder from webkitRelativePath, which a plain multi-file input lacks
    await page.evaluate(async (rel) => {
        const fl = Array.from(document.getElementById('__files').files);
        fl.forEach((f, i) => Object.defineProperty(f, 'webkitRelativePath', { value: rel[i] }));
        await (await import('./loading/session-loader.js')).handleLoadSessionFolderPerCamera(fl, false);
    }, rel);
    await page.waitForFunction(() => { const s = window.__lucid.state.session; return s && s.cameras && s.cameras.length > 1 && (window.__lucid.state.views || []).some((v) => v && v.decoder); },
        null, { timeout: 5 * 60000, polling: 1000 });
    await page.waitForTimeout(3000);

    const q0 = await media.evaluate(() => window.__q());
    const step = async (button, re) => {
        await page.evaluate(() => { document.getElementById('statusText').textContent = ''; });
        await page.evaluate((id) => document.getElementById(id).click(), button);
        await page.waitForFunction((src) => { const s = document.getElementById('statusText').textContent;
            return document.getElementById('loadingOverlay').classList.contains('hidden') && new RegExp(src).test(s); }, re.source, { timeout: 5 * 60000, polling: 250 });
    };
    await step('tbTrackAll', /Assigned \d+ identities/);
    await page.evaluate(async () => { (await import('./ui/settings.js')).setDefaultTriangulationMethod('ba'); });
    await step('tbTriangulateAll', /^(Triangulated|Grouped) /);
    // the Track All summary stays open (its capture-phase Esc would take the key meant for the check's dialog)
    await page.evaluate(() => { const b = document.getElementById('trackSummaryClose'); if (b) b.click(); });
    // the image check on the GPU, cancelled after IMAGE_S
    await page.evaluate(async () => { const M = await import('./ui/id-switch-modal.js'); window.__img = M.runIdSwitchChecks({ image: true }).then((r) => r, (e) => ({ err: String(e) })); });
    await page.waitForFunction(() => /frame \d/.test(document.querySelector('.id-switch-progress-text')?.textContent || '') || !document.getElementById('idSwitchCancel'),
        null, { timeout: 3 * 60000 });
    await page.waitForTimeout(IMAGE_S * 1000);
    const running = await page.evaluate(() => !!document.getElementById('idSwitchCancel'));
    let cancelMs = 0;
    if (running) {
        // keys go to the focused window (the video's was opened last); notices are dismissed above (the HEVC
        // codec notice, if left open, takes the first Esc for itself, as the topmost modal)
        await page.bringToFront();
        const t0 = Date.now();
        await page.keyboard.press('Escape');

        const done = await Promise.race([page.evaluate(() => window.__img.then(() => true)), new Promise((r) => setTimeout(() => r(false), 10000))]);
        cancelMs = done ? Date.now() - t0 : Infinity;
    }
    const img = await page.evaluate(() => window.__img.then((r) => r && r.image ? { ok: r.image.ok, reason: r.image.reason } : r));
    const q1 = await media.evaluate(() => window.__q());
    const dropped = q1[0] - q0[0], total = q1[1] - q0[1];
    const lt = await page.evaluate(() => window.__lt);

    check(total > 600 && dropped <= 0.01 * total, `the video next to LUCID dropped ${dropped} of ${total} frames (≤ 1%)`);
    check(Math.max(0, ...lt) < 2000, `LUCID's longest main-thread block: ${Math.round(Math.max(0, ...lt))} ms (< 2 s; ${lt.length} long tasks)`);
    check(!crashed && await page.evaluate(() => 1 + 1).catch(() => 0) === 2, 'the LUCID page survived every run');
    check(!hasPressure || poolLogs.length > 0, hasPressure ? `Triangulate All followed the CPU pressure: ${poolLogs[0] || 'no governor log'}` : 'no Compute Pressure API here: fixed half pool');
    check(!running || cancelMs < 2000, running ? `Cancel closed the image check in ${cancelMs} ms (< 2 s); result: ${JSON.stringify(img)}` : 'the image check finished before the cap: ' + JSON.stringify(img));
    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close().catch(() => {});
    await release();
    server.kill(); mserver.kill();
}
console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
