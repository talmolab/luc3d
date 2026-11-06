/**
 * _bench-compute-coexist.mjs — does a long LUCID run make the rest of the
 * machine stutter? Measures LUCID's heavy compute paths on a REAL recording
 * while a 1080p60 video plays in a second window, and the OS is probed from
 * outside the browser.
 *
 * Not a test (needs a real dataset, a display, real Chrome and its GPU). Takes
 * the browser lock (scripts/browser-lock.mjs). Usage:
 *   DATASET=<per-camera folder: <cam>/<video>.mp4 + <cam>/<predictions>.slp + calibration.toml>
 *   SCENARIOS=idle,track,tri,size,image-gpu,image-cpu   (default: all)
 *   IMAGE_CAP_S=300   stop (Cancel) an image check after this many seconds; the
 *                     time from Cancel to the dialog closing is reported
 *   LABEL=before      written to verify/compute-coexist/<label>-<time>.json
 *   APP_DIR=<dir>     the build to serve (default: this working tree)
 *   NANIMALS=''       Track All's animal count ('' = auto)
 *   HC=<n>            pretend navigator.hardwareConcurrency is n (pool sizes)
 *   MAX_S=235         hard cap on the whole bench
 *   SCENARIOS also takes tri@N (N triangulation workers, fixed) and tri-ba / tri-ba@N (Refined)
 *
 * Per scenario, on the wall clock of the scenario's run:
 *   LUCID tab   — main-thread long tasks (count, total, max), rAF frame-time
 *                 p50/p95/max, peak JS heap (performance.memory)
 *   media tab   — getVideoPlaybackQuality dropped/total frames (and the ratio),
 *                 rAF p95/max — the video is served from 127.0.0.1, another
 *                 SITE than LUCID's localhost, so it gets its own renderer like
 *                 a YouTube tab would; both windows are visible side by side
 *   OS          — system CPU % (top), Chrome's CPU % and RSS (sum over its
 *                 processes, and the largest one), GPU "Device Utilization %"
 *                 (ioreg, no sudo), thermal/performance warnings (pmset), and
 *                 the lateness of a 10 ms timer in a separate Node process
 *                 (OS responsiveness)
 */
import { chromium } from 'playwright';
import { spawn, execSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { answerTrackSetup } from './fixtures/track-setup.js';
import { acquireBrowserLock } from '../../scripts/browser-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const DATASET = process.env.DATASET;
const APP_DIR = process.env.APP_DIR || repoRoot;
const SCEN = (process.env.SCENARIOS || 'idle,track,tri,size,image-gpu,image-cpu').split(',').map((s) => s.trim()).filter(Boolean);
const IMAGE_CAP_S = Number(process.env.IMAGE_CAP_S || 300);
const IDLE_S = Number(process.env.IDLE_S || 20);
const LABEL = process.env.LABEL || 'run';
const NANIMALS = process.env.NANIMALS ?? '';
const PORT = Number(process.env.PORT || 8170);
const MPORT = PORT + 1;
if (!DATASET) { console.error('set DATASET'); process.exit(2); }
const log = (m) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);

// ---- the co-running media: a 1080p60 ~20 Mb/s H.264 clip, made once with ffmpeg
const mediaDir = path.join(os.tmpdir(), 'lucid-coexist-media');
fs.mkdirSync(mediaDir, { recursive: true });
const clip = path.join(mediaDir, 'clip1080p60.mp4');
if (!fs.existsSync(clip)) {
    log('making the 1080p60 test clip (ffmpeg)…');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=60,noise=alls=12:allf=t', '-t', '60',
        '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '20M', '-maxrate', '25M', '-bufsize', '40M', '-pix_fmt', 'yuv420p', '-g', '120',
        '-movflags', '+faststart', clip]);
}
fs.writeFileSync(path.join(mediaDir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>media</title>
<style>html,body{margin:0;background:#000;height:100%}video{width:100%;height:100%;object-fit:contain}</style></head>
<body><video id="v" src="clip1080p60.mp4" muted loop autoplay playsinline></video><script>
window.__media = { q: [], raf: [] };
const v = document.getElementById('v');
setInterval(() => { const q = v.getVideoPlaybackQuality(); window.__media.q.push([Date.now(), q.droppedVideoFrames, q.totalVideoFrames, v.paused ? 1 : 0]); }, 250);
let last = 0;
const tick = (t) => { const now = Date.now(); if (last) window.__media.raf.push([now, t - last]); last = t; requestAnimationFrame(tick); };
requestAnimationFrame(tick); v.play().catch(() => {});
</script></body></html>`);

// ---- LUCID-tab probe (installed before the app loads)
const PROBE = () => {
    const P = window.__probe = { lt: [], raf: [], heap: [], pressure: [] };
    try {   // the OS's own CPU pressure (Compute Pressure API): nominal / fair / serious / critical
        new PressureObserver((recs) => { for (const r of recs) P.pressure.push([Date.now(), r.state]); }).observe('cpu', { sampleInterval: 500 });
    } catch (e) { /* unsupported */ }
    try {
        new PerformanceObserver((l) => { for (const e of l.getEntries()) P.lt.push([performance.timeOrigin + e.startTime, e.duration]); })
            .observe({ type: 'longtask', buffered: true });
    } catch (e) { /* no longtask */ }
    let last = 0;
    const tick = (t) => { if (last) P.raf.push([Date.now(), t - last]); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setInterval(() => { if (performance.memory) P.heap.push([Date.now(), performance.memory.usedJSHeapSize]); }, 500);
};

// ---- OS probes
const samples = { top: [], ps: [], gpu: [], therm: [], drift: [] };
let chromePid = null;
let allCpu = 0;
const descendants = () => {
    const rows = execSync('ps -A -o pid=,ppid=,%cpu=,rss=').toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    allCpu = rows.reduce((a, r) => a + (r[2] || 0), 0);
    const kids = new Map();
    for (const [pid, ppid] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
    const set = new Set([chromePid]), stack = [chromePid];
    while (stack.length) for (const k of kids.get(stack.pop()) || []) if (!set.has(k)) { set.add(k); stack.push(k); }
    return rows.filter((r) => set.has(r[0]));
};
const topProc = spawn('top', ['-l', '0', '-s', '1', '-n', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
topProc.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
        const m = /CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle/.exec(line);
        if (m) samples.top.push([Date.now(), 100 - Number(m[3])]);
    }
});
// a 10 ms timer in its own process: how late it fires is how sluggish the OS is
const driftProc = spawn(process.execPath, ['-e', `
let exp = Date.now() + 10; const lat = [];
setInterval(() => { const now = Date.now(); lat.push(now - exp); exp = now + 10;
  if (lat.length >= 50) { process.stdout.write(JSON.stringify([now, lat.splice(0)]) + '\\n'); } }, 10);`], { stdio: ['ignore', 'pipe', 'ignore'] });
let driftBuf = '';
driftProc.stdout.on('data', (d) => {
    driftBuf += d.toString();
    let i;
    while ((i = driftBuf.indexOf('\n')) >= 0) { const [t, lat] = JSON.parse(driftBuf.slice(0, i)); driftBuf = driftBuf.slice(i + 1); for (const x of lat) samples.drift.push([t, x]); }
});
const sampler = setInterval(() => {
    const now = Date.now();
    try {
        if (chromePid) {
            const rows = descendants();
            const ours = rows.reduce((a, r) => a + r[2], 0);
            samples.ps.push([now, ours, rows.reduce((a, r) => a + r[3], 0) / 1024, Math.max(...rows.map((r) => r[3])) / 1024, rows.length, allCpu - ours]);
        }
    } catch (e) { /* ignore */ }
    try {
        const io = execSync('ioreg -r -d 1 -c IOAccelerator').toString();
        const m = /"Device Utilization %"=(\d+)/.exec(io);
        if (m) samples.gpu.push([now, Number(m[1])]);
    } catch (e) { /* ignore */ }
    try {
        const th = execSync('pmset -g therm').toString();
        const lvl = /(CPU_Speed_Limit|Thermal_Level|Performance_Warning)\s*=\s*(\d+)/g; const o = {}; let m;
        while ((m = lvl.exec(th))) o[m[1]] = Number(m[2]);
        samples.therm.push([now, o]);
    } catch (e) { /* ignore */ }
}, 1000);

// ---- summaries
const pct = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const within = (arr, t0, t1) => arr.filter((x) => x[0] >= t0 && x[0] <= t1);
const r1 = (x) => Math.round(x * 10) / 10;
async function summarize(name, t0, t1, lucid, media, extra) {
    const P = await lucid.evaluate(() => window.__probe).catch(() => null);
    const M = await media.evaluate(() => window.__media).catch(() => null);
    const out = { name, seconds: r1((t1 - t0) / 1000), ...extra };
    if (P) {
        const lt = within(P.lt, t0, t1).map((x) => x[1]), raf = within(P.raf, t0, t1).map((x) => x[1]);
        const heap = within(P.heap, t0, t1).map((x) => x[1]);
        out.lucid = { longTasks: lt.length, longTaskMs: Math.round(lt.reduce((a, b) => a + b, 0)), longTaskMaxMs: Math.round(Math.max(0, ...lt)),
            rafP50: r1(pct(raf, 0.5)), rafP95: r1(pct(raf, 0.95)), rafMax: Math.round(Math.max(0, ...raf)), heapPeakMB: Math.round(Math.max(0, ...heap) / 1048576) };
        // pressure: seconds in each state over the window (the state before t0 carries in)
        const pr = P.pressure.filter((x) => x[0] <= t1), dur = {};
        for (let i = 0; i < pr.length; i++) { const a = Math.max(pr[i][0], t0), b = Math.min(i + 1 < pr.length ? pr[i + 1][0] : t1, t1); if (b > a) dur[pr[i][1]] = r1((dur[pr[i][1]] || 0) + (b - a) / 1000); }
        out.lucid.pressureS = dur;
    } else out.lucid = { crashed: true };
    if (M) {
        const q = within(M.q, t0, t1), raf = within(M.raf, t0, t1).map((x) => x[1]);
        const d = q.length > 1 ? q[q.length - 1][1] - q[0][1] : NaN, tot = q.length > 1 ? q[q.length - 1][2] - q[0][2] : NaN;
        out.media = { dropped: d, frames: tot, dropPct: r1(100 * d / Math.max(1, tot)), rafP95: r1(pct(raf, 0.95)), rafMax: Math.round(Math.max(0, ...raf)),
            rafOver50: raf.filter((x) => x > 50).length };
    }
    const top = within(samples.top, t0, t1).map((x) => x[1]), ps = within(samples.ps, t0, t1), gpu = within(samples.gpu, t0, t1).map((x) => x[1]);
    const drift = within(samples.drift, t0, t1).map((x) => x[1]), th = within(samples.therm, t0, t1).map((x) => x[1]);
    out.os = { sysCpuMean: r1(top.reduce((a, b) => a + b, 0) / Math.max(1, top.length)), sysCpuMax: r1(Math.max(0, ...top)),
        chromeCpuMean: r1(ps.reduce((a, r) => a + r[1], 0) / Math.max(1, ps.length)), chromeCpuMax: r1(Math.max(0, ...ps.map((r) => r[1]))),
        otherProcsCpuMean: r1(ps.reduce((a, r) => a + (r[5] || 0), 0) / Math.max(1, ps.length)),
        chromeRssPeakMB: Math.round(Math.max(0, ...ps.map((r) => r[2]))), largestProcRssPeakMB: Math.round(Math.max(0, ...ps.map((r) => r[3]))),
        gpuMean: r1(gpu.reduce((a, b) => a + b, 0) / Math.max(1, gpu.length)), gpuMax: Math.max(0, ...gpu),
        timerLateP50: pct(drift, 0.5), timerLateP99: pct(drift, 0.99), timerLateMax: Math.max(0, ...drift),
        // otherProcsCpuMean: every other process (other apps, other sessions' browsers): a busy machine shows here
        thermal: th.find((o) => Object.values(o).some((v) => v !== 0 && v !== 100)) || null };
    log(name + ': ' + JSON.stringify(out));
    return out;
}

// ---- driving LUCID
const server = spawn('python3', ['server.py', String(PORT)], { cwd: APP_DIR, stdio: 'ignore' });
const mserver = spawn('python3', ['-m', 'http.server', String(MPORT), '--bind', '127.0.0.1'], { cwd: mediaDir, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

async function openLucid(browser, { noGpu } = {}) {
    const ctx = await browser.newContext({ viewport: null });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log('pageerror: ' + String(e).slice(0, 300)));
    page.on('crash', () => log('LUCID PAGE CRASHED'));
    page.on('console', (m) => { const t = m.text(); if (/\[(triangulation-pool|image-embedder|tracker-pool)\]|ID switches, images/.test(t)) log('console: ' + t.slice(0, 300)); });
    page.on('dialog', (d) => d.accept(String(NANIMALS)));
    await page.addInitScript(PROBE);
    if (process.env.HC) await page.addInitScript((hc) => { Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => hc, configurable: true }); }, Number(process.env.HC));
    if (noGpu) await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true }); });
    await answerTrackSetup(page, NANIMALS);
    await placeWindow(page, 0, 0, 1000, 940);
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 60000 });
    await page.evaluate(async () => {
        const st = await import('./ui/settings.js');
        st.setTrackingThresholds({ autoSwitchCheck: 0, autoImageSwitchCheck: 0 });
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.webkitdirectory = true; inp.id = '__dir';
        inp.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(inp);
        setInterval(() => { for (const b of document.querySelectorAll('button')) { const t = b.textContent.trim(); if ((t === 'Continue' || t === 'OK') && b.offsetParent !== null) b.click(); } }, 300);
    });
    await page.setInputFiles('#__dir', DATASET);
    const t0 = Date.now();
    await page.evaluate(async () => {
        const sl = await import('./loading/session-loader.js');
        await sl.handleLoadSessionFolderPerCamera(Array.from(document.getElementById('__dir').files).filter((f) => !/(^|\/)\./.test(f.webkitRelativePath || f.name)), false);
    });
    await page.waitForFunction(() => window.__lucid.state.session && window.__lucid.state.session.cameras && window.__lucid.state.session.cameras.length > 1, null, { timeout: 30 * 60000, polling: 1000 });
    log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await new Promise((r) => setTimeout(r, 5000));
    return page;
}
async function placeWindow(page, left, top, width, height) {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left, top, width, height, windowState: 'normal' } });
}
async function step(page, button, re, what) {
    // cleared first: two runs of the same step can end on the same status text
    const prev = await page.evaluate(() => { document.getElementById('statusText').textContent = ''; return ''; });
    const t0 = Date.now();
    await page.evaluate((id) => document.getElementById(id).click(), button);
    for (;;) {
        const st = await page.evaluate(() => ({ s: document.getElementById('statusText').textContent, hidden: document.getElementById('loadingOverlay').classList.contains('hidden') }));
        if (st.hidden && st.s !== prev && re.test(st.s)) return { t0, t1: Date.now(), status: st.s.slice(0, 160) };
        if (Date.now() - t0 > 60 * 60000) throw new Error(what + ' timed out');
        await new Promise((r) => setTimeout(r, 250));
    }
}
async function imageCheck(page) {
    const t0 = Date.now();
    await page.evaluate(async () => {
        const m = await import('./ui/id-switch-modal.js');
        window.__chk = null;
        m.runIdSwitchChecks({ image: true }).then((r) => { window.__chk = { ok: true, r: r && r.image ? { ok: r.image.ok, reason: r.image.reason, timing: r.image.timing, model: r.image.model, flags: (r.image.flags || []).length } : r }; },
            (e) => { window.__chk = { ok: false, err: String(e && e.stack || e) }; });
    });
    let cancelAt = 0, cancelMs = null;
    for (;;) {
        const done = await page.evaluate(() => window.__chk);
        if (done) {
            const t1 = Date.now();
            if (cancelAt) cancelMs = t1 - cancelAt;
            const prog = await page.evaluate(() => (window.__lastProg || ''));
            return { t0, t1, result: done, cancelled: !!cancelAt, cancelMs, prog };
        }
        if (!cancelAt && Date.now() - t0 > IMAGE_CAP_S * 1000) {
            await page.evaluate(() => { const m = /frame ([\d,]+) of ([\d,]+)/.exec(document.body.innerText); window.__lastProg = m ? m[0] : ''; const b = document.getElementById('idSwitchCancel'); if (b) b.click(); });
            cancelAt = Date.now();
            log('image check: Cancel clicked at the cap');
        }
        if (cancelAt && Date.now() - cancelAt > 120000) return { t0, t1: Date.now(), result: null, cancelled: true, cancelMs: 'HUNG > 120 s' };
        await new Promise((r) => setTimeout(r, 250));
    }
}

const releaseLock = await acquireBrowserLock({ label: 'compute guardrails bench' });
// MAX_S: a hard cap on the whole bench (default 235 s): the browser is closed and what was measured is written
const MAX_S = Number(process.env.MAX_S || 235);
const hardStop = setTimeout(() => { log('MAX_S reached — stopping'); result.error = 'MAX_S reached'; if (browser) browser.close().catch(() => {}); }, MAX_S * 1000);
let browser;
const result = { label: LABEL, dataset: DATASET, app: APP_DIR, machine: { cpu: os.cpus()[0].model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), os: `${os.type()} ${os.release()}` }, runs: [] };
try {
    const tag = '--lucid-coexist-bench=' + process.pid;     // finds OUR Chrome among others (other sessions' browsers)
    browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--window-size=1000,940', '--enable-unsafe-webgpu', tag] });
    result.machine.chrome = browser.version();
    // find the launched Chrome's main process (its children are the GPU/renderers/utility processes)
    const out = execSync('ps -A -o pid=,args=').toString().split('\n').filter((l) => /Google Chrome\.app\/Contents\/MacOS\/Google Chrome /.test(l) && l.includes(tag));
    chromePid = out.length ? Number(out[0].trim().split(/\s+/)[0]) : null;
    log('chrome pid ' + chromePid + ' ' + result.machine.chrome);
    const mctx = await browser.newContext({ viewport: null });
    const media = await mctx.newPage();
    await placeWindow(media, 1005, 0, 500, 330);
    await media.goto(`http://127.0.0.1:${MPORT}/index.html`);
    await media.waitForFunction(() => window.__media && window.__media.q.length > 4);
    let page = null, tracked = false;
    const ensure = async (noGpu) => {
        if (page && page.__noGpu === !!noGpu) return;
        if (page) await page.context().close();
        page = await openLucid(browser, { noGpu }); page.__noGpu = !!noGpu; tracked = false;
        result.gpuAdapter = result.gpuAdapter || await page.evaluate(async () => { try { const a = await navigator.gpu.requestAdapter(); return a && a.info ? a.info.vendor + ' ' + a.info.architecture : null; } catch (e) { return null; } });
    };
    const track = async () => {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await step(page, 'tbTrackAll', /Assigned \d+ identities/, 'Track All');
        tracked = true;
        return s;
    };
    for (const sc of SCEN) {
        log('=== ' + sc);
        if (sc === 'idle') {
            await ensure(false);
            const t0 = Date.now(); await new Promise((r) => setTimeout(r, IDLE_S * 1000));
            result.runs.push(await summarize('idle (media + LUCID loaded)', t0, Date.now(), page, media, {}));
        } else if (sc === 'track') {
            await ensure(false);
            const s = await track();
            result.runs.push(await summarize('Track All', s.t0, s.t1, page, media, { status: s.status }));
        } else if (/^tri/.test(sc)) {
            // tri | tri@N (N triangulation workers) | tri-ba@N (Refined)
            await ensure(false);
            if (!tracked) await track();
            const mm = /^tri(-ba)?(?:@(\d+))?$/.exec(sc);
            await page.evaluate(async ([m, n]) => { (await import('./ui/settings.js')).setDefaultTriangulationMethod(m); window.LUCID_TRIANGULATION_WORKERS = n; }, [mm[1] ? 'ba' : 'dlt', mm[2] != null ? Number(mm[2]) : undefined]);
            await new Promise((r) => setTimeout(r, 3000));
            const s = await step(page, 'tbTriangulateAll', /^(Triangulated|Grouped) /, 'Triangulate All');
            result.runs.push(await summarize('Triangulate All (' + sc + ')', s.t0, s.t1, page, media, { status: s.status }));
        } else if (sc === 'size') {
            await ensure(false);
            if (!tracked) await track();
            await new Promise((r) => setTimeout(r, 3000));
            const t0 = Date.now();
            await page.evaluate(async () => { const m = await import('./ui/id-switch-modal.js'); await m.runIdSwitchChecks({ size: true }); });
            result.runs.push(await summarize('ID-switch check (body size)', t0, Date.now(), page, media, {}));
        } else if (sc === 'image-gpu' || sc === 'image-cpu') {
            await ensure(sc === 'image-cpu');
            if (!tracked) await track();
            await new Promise((r) => setTimeout(r, 3000));
            const s = await imageCheck(page);
            result.runs.push(await summarize('Image check (' + (sc === 'image-cpu' ? 'CPU, WebGPU off' : 'GPU') + ')', s.t0, s.t1, page, media,
                { cancelled: s.cancelled, cancelMs: s.cancelMs, result: s.result && s.result.r ? { ok: s.result.r.ok, reason: s.result.r.reason, model: s.result.r.model, timing: s.result.r.timing && { crops: s.result.r.timing.crops, cropsPerS: s.result.r.timing.cropsPerS, workers: s.result.r.timing.workers, backend: s.result.r.timing.backend } } : s.result, prog: s.prog }));
        }
    }
} catch (e) {
    log('FAILED: ' + (e && e.stack || e));
    result.error = String(e && e.stack || e);
} finally {
    clearInterval(sampler); clearTimeout(hardStop);
    topProc.kill(); driftProc.kill();
    if (browser) await browser.close().catch(() => {});
    await releaseLock();
    server.kill(); mserver.kill();
    const dir = path.join(repoRoot, 'verify', 'compute-coexist');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${LABEL}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 1));
    log('wrote ' + path.relative(repoRoot, file));
    process.exit(0);
}
