/**
 * _diag-trackall-worker-profile.mjs — where does Track All's time go, inline
 * vs on the tracker worker (pose/tracker-pool.js)? Loads one recording, then
 * runs Track All alternately with the worker off and on (REPEAT pairs) under a
 * Chrome trace, and reports per run:
 *   - wall time (click to status);
 *   - busy time per thread from the trace (top-level tasks on the renderer main
 *     thread and on the tracker's DedicatedWorker thread);
 *   - with the worker: its startup (spawn -> ready), the batches (count, mean
 *     frames), how long the worker held each one, the idle gaps between them,
 *     and the main thread's time in the result handlers (commits).
 *
 * Not a test (real dataset, real Chrome). Takes the browser lock. Usage:
 *   DATASET=<per-camera folder> NANIMALS=3 node tests/e2e/_diag-trackall-worker-profile.mjs
 *   env: REPEAT=2  PORT=8174  EXCLUDE=<regex>  TRACE=1 (keep the trace JSON under verify/)
 *        PROFILE=1 (V8 CPU sampling too: the top functions by self time on each thread)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { acquireBrowserLock } from '../../scripts/browser-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const DATASET = process.env.DATASET;
const NANIMALS = process.env.NANIMALS ?? '';
const REPEAT = Number(process.env.REPEAT || 2);
const PORT = Number(process.env.PORT || 8174);
const EXCLUDE = process.env.EXCLUDE || '(^|/)\\.|/troubleshooting/';
if (!DATASET) { console.error('set DATASET'); process.exit(2); }
const log = (m) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));

/** Busy ms per thread name over [t0, t1] (µs), from top-level task events. */
function threadBusy(trace, t0, t1) {
    const names = new Map(), busy = new Map();
    for (const e of trace.traceEvents) if (e.ph === 'M' && e.name === 'thread_name') names.set(e.pid + ':' + e.tid, e.args.name);
    // top-level tasks only: RunTask / ThreadControllerImpl::RunTask, clipped to the window
    for (const e of trace.traceEvents) {
        if (e.ph !== 'X' || !(e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask')) continue;
        const a = Math.max(e.ts, t0), b = Math.min(e.ts + (e.dur || 0), t1);
        if (b <= a) continue;
        const k = names.get(e.pid + ':' + e.tid) || ('tid ' + e.tid);
        busy.set(k, (busy.get(k) || 0) + (b - a) / 1000);
    }
    return busy;
}

/** Self ms per function per thread from the V8 sampling profiler's ProfileChunk events. */
function profileSelf(trace) {
    const names = new Map();
    for (const e of trace.traceEvents) if (e.ph === 'M' && e.name === 'thread_name') names.set(e.pid + ':' + e.tid, e.args.name);
    const prof = new Map();                          // profile id -> {thread, nodes: Map, self: Map}
    for (const e of trace.traceEvents) {
        if (e.name !== 'ProfileChunk' && e.name !== 'Profile') continue;
        const key = e.id;
        if (!prof.has(key)) prof.set(key, { thread: names.get(e.pid + ':' + e.tid) || ('tid ' + e.tid), nodes: new Map(), self: new Map() });
        const p = prof.get(key), d = e.args && e.args.data;
        if (!d || !d.cpuProfile) continue;
        for (const n of d.cpuProfile.nodes || []) p.nodes.set(n.id, n);
        const samples = d.cpuProfile.samples || [], deltas = d.timeDeltas || [];
        for (let i = 0; i < samples.length; i++) {
            const n = p.nodes.get(samples[i]);
            const cf = n ? n.callFrame : null;
            const name = cf ? (cf.functionName || '(anonymous)') + ' ' + (cf.url || '').split('/').slice(-1)[0].split('?')[0] + ':' + (cf.lineNumber + 1) : '?';
            p.self.set(name, (p.self.get(name) || 0) + (deltas[i + 1] != null ? deltas[i + 1] : deltas[i] || 0) / 1000);
        }
    }
    const byThread = new Map();
    for (const p of prof.values()) {
        const m = byThread.get(p.thread) || new Map();
        for (const [k, v] of p.self) m.set(k, (m.get(k) || 0) + v);
        byThread.set(p.thread, m);
    }
    return byThread;
}

const releaseLock = await acquireBrowserLock({ label: '_diag-trackall-worker-profile' });
let browser;
try {
    browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--window-size=1500,950'] });
    const page = await browser.newPage({ viewport: { width: 1480, height: 860 } });
    page.on('pageerror', (e) => log('pageerror: ' + String(e).slice(0, 300)));
    page.on('dialog', (d) => d.accept(String(NANIMALS)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    await page.evaluate(async () => {
        const st = await import('./ui/settings.js');
        st.setTrackingThresholds({ autoSwitchCheck: 0, autoImageSwitchCheck: 0 });
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.webkitdirectory = true; inp.id = '__dir';
        inp.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(inp);
        setInterval(() => { for (const b of document.querySelectorAll('button')) { const t = b.textContent.trim(); if ((t === 'Continue' || t === 'OK') && b.offsetParent !== null) b.click(); } }, 300);
        // Instrument the tracker worker: spawn/ready, each batch's post and result, and the result handlers.
        const Real = window.Worker;
        window.__tw = null;
        window.Worker = function (url, opts) {
            const w = new Real(url, opts);
            if (!/tracker-worker\.js/.test(String(url))) return w;
            const s = window.__tw = { spawn: performance.now(), ready: null, posts: [], results: [], handlerMs: 0 };
            const post = w.postMessage.bind(w);
            w.postMessage = (m, t) => { if (m && m.type === 'frames') s.posts.push({ id: m.id, t: performance.now(), n: m.fis.length }); return post(m, t); };
            let h = null;
            Object.defineProperty(w, 'onmessage', {
                get: () => h,
                set: (fn) => { h = fn; w.addEventListener('message', (e) => {
                    const t = performance.now();
                    if (e.data.type === 'ready') s.ready = t;
                    fn.call(w, e);
                    if (e.data.type === 'tracked') { const d = performance.now() - t; s.handlerMs += d; s.results.push({ id: e.data.id, t, d }); }
                }); },
            });
            return w;
        };
        window.Worker.prototype = Real.prototype;
    });
    await page.setInputFiles('#__dir', DATASET);
    await page.evaluate(async (ex) => {
        const sl = await import('./loading/session-loader.js');
        const re = new RegExp(ex);
        await sl.handleLoadSessionFolderPerCamera(Array.from(document.getElementById('__dir').files).filter((f) => !re.test(f.webkitRelativePath || f.name)), false);
    }, EXCLUDE);
    await page.waitForFunction(() => window.__lucid.state.session && window.__lucid.state.session.cameras && window.__lucid.state.session.cameras.length > 1, null, { timeout: 30 * 60000, polling: 1000 });
    await new Promise((r) => setTimeout(r, 3000));
    const info = await page.evaluate(() => { const s = window.__lucid.state.session; return { cams: s.cameras.length, frames: s.lazyLoader ? s.lazyLoader.nFrames : s.frameGroups.size, lazy: !!s.lazyLoader }; });
    log(`loaded: ${info.cams} cameras, ${info.frames} frames, lazy ${info.lazy}`);

    const runOnce = async (worker, k) => {
        await page.evaluate((w) => { window.LUCID_TRACKER_WORKER = w ? undefined : 0; window.__tw = null; }, worker);
        const prev = await page.evaluate(() => { document.getElementById('statusText').textContent = ''; return ''; });   // runs end on identical lines
        await browser.startTracing(page, { categories: ['toplevel', 'disabled-by-default-devtools.timeline', 'devtools.timeline']
            .concat(process.env.PROFILE ? ['disabled-by-default-v8.cpu_profiler'] : []) });
        const t0 = await page.evaluate(() => { const t = performance.timeOrigin + performance.now(); document.getElementById('tbTrackAll').click(); return t; });
        const wall0 = Date.now();
        for (;;) {
            const st = await page.evaluate(() => ({ s: document.getElementById('statusText').textContent, hidden: document.getElementById('loadingOverlay').classList.contains('hidden') }));
            if (st.hidden && st.s !== prev && /Assigned \d+ identities/.test(st.s)) break;
            if (st.hidden && /error/i.test(st.s)) throw new Error('Track All failed: ' + st.s);
            if (Date.now() - wall0 > 30 * 60000) throw new Error('Track All timed out');
            await new Promise((r) => setTimeout(r, 100));
        }
        const wall = Date.now() - wall0;
        const buf = await browser.stopTracing();
        const trace = JSON.parse(buf.toString());
        if (process.env.TRACE) { const d = path.join(repoRoot, 'verify', 'trackall-profile'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${worker ? 'worker' : 'inline'}-${k}.json`), buf); }
        // the window: the first and last top-level task on the main thread around the run
        const ts = trace.traceEvents.filter((e) => e.ph === 'X' && e.ts).map((e) => e.ts);
        const busy = threadBusy(trace, Math.min(...ts), Math.max(...ts));
        const tw = await page.evaluate(() => window.__tw);
        let line = `${worker ? 'WORKER' : 'INLINE'} #${k}: wall ${(wall / 1000).toFixed(2)} s; busy ` +
            [...busy].filter(([, ms]) => ms > 50).sort((a, b) => b[1] - a[1]).map(([n, ms]) => `${n} ${(ms / 1000).toFixed(2)} s`).join(', ');
        if (tw) {
            const res = new Map(tw.results.map((r) => [r.id, r]));
            let held = 0, gaps = 0, lastEnd = null;
            for (const p of tw.posts) {
                const r = res.get(p.id);
                if (!r) continue;
                const start = Math.max(p.t, lastEnd == null ? p.t : lastEnd);
                if (lastEnd != null && p.t > lastEnd) gaps += p.t - lastEnd;       // the worker had nothing queued
                held += r.t - start;
                lastEnd = r.t;
            }
            const frames = tw.posts.reduce((s, p) => s + p.n, 0);
            line += `\n      worker: startup ${(tw.ready - tw.spawn).toFixed(0)} ms; ${tw.posts.length} batches (${(frames / Math.max(1, tw.posts.length)).toFixed(0)} frames each); ` +
                `held ${(held / 1000).toFixed(2)} s; starved (nothing queued) ${(gaps / 1000).toFixed(2)} s; ` +
                `main thread in result handlers ${(tw.handlerMs / 1000).toFixed(2)} s; first post ${(tw.posts[0].t - tw.spawn).toFixed(0)} ms after spawn, ` +
                `last result ${((tw.results[tw.results.length - 1].t - tw.spawn) / 1000).toFixed(2)} s after spawn`;
        }
        log(line);
        if (process.env.PROFILE) {
            for (const [thread, m] of profileSelf(trace)) {
                if (!/CrRendererMain|DedicatedWorker/.test(thread)) continue;
                const tot = [...m.values()].reduce((a, b) => a + b, 0);
                const top = [...m].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.TOP || 25));
                log(`   ${worker ? 'WORKER' : 'INLINE'} #${k} ${thread}: ${(tot / 1000).toFixed(2)} s sampled\n` +
                    top.map(([n, ms]) => `      ${(ms / 1000).toFixed(3).padStart(7)} s  ${n}`).join('\n'));
            }
        }
    };
    for (let r = 0; r < REPEAT; r++) { await runOnce(false, r + 1); await runOnce(true, r + 1); }
} finally {
    if (browser) await browser.close().catch(() => {});
    await releaseLock();
    server.kill();
}
