/**
 * _bench-progress-overlay.mjs — Track All / Triangulate All PROGRESS OVERLAY
 * bench on a real multi-camera project, run HEADED in real Google Chrome
 * (HEVC recordings + a real display, as `_bench-playback.mjs` explains).
 *
 * It drives the real toolbar buttons — Track All, then Triangulate All once per
 * requested method — and for each operation records:
 *   - total run time (button click -> success status line), measured in-page;
 *   - every overlay update (text + progress-bar fraction, timestamped by a
 *     MutationObserver), so the cadence and monotonicity of the bar can be read;
 *   - how many frames the page actually PAINTED while the overlay was up (a rAF
 *     counter) — a chunked loop that never yields paints ~0;
 *   - optional screenshots every SHOT_MS while the overlay is visible.
 *
 * Not a test (needs the real dataset + a display). Usage:
 *     node tests/e2e/_bench-progress-overlay.mjs
 *   env:
 *     DATASET=<dir>      session folder (default: the HardFight_1kModels set)
 *     LABEL=baseline     output folder label
 *     METHODS=ba,dlt     Triangulate All runs, in order, after Track All
 *                        (ba = "Refined": triangulateAllFrames; dlt with
 *                        identities: groupByIdentityAndTriangulateAll)
 *     SHOT_MS=0          screenshot period while the overlay is up (0 = none;
 *                        screenshots perturb timing, so time with SHOT_MS=0)
 *     NANIMALS=3         answer to Track All's animal-count prompt
 *     OPS=load,track,tri which operations to run (the load is always run and
 *                        recorded as op `load`; OPS=load stops after it)
 *     STAGES=1           print each stage's duration
 *     CONSOLE=<regex>    echo matching page console lines, timestamped
 *     DIGEST=1           hash the loaded session's poses (compare two APP_ROOTs)
 *     PROFILE_VIDEO=1    time each video decoder's init phases + long tasks
 *     DIGEST_OPS=1       after each Track All / Triangulate All, hash its full
 *                        output (identities, frameIdentityMap, instanceGroups
 *                        incl. members' coords, points3d, method,
 *                        reprojections, triangulationResults) — compare two
 *                        APP_ROOTs to prove a change is output-identical
 *     TRI_WORKERS=N      Triangulate All worker-pool size (0 = inline)
 *     CPU_PROFILE=1      record a V8 CPU profile per op (main thread) and print
 *                        the top functions by self time + idle share; the raw
 *                        .cpuprofile is saved next to summary.json (open in
 *                        DevTools ▸ Performance)
 *     PORT=8124
 *
 * Output: verify/progress-bench/<LABEL>-<timestamp>/{summary.json,*.png}
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { acquireBrowserLock } from '../../scripts/browser-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
// APP_ROOT=<dir> serves a different checkout (e.g. a `git archive HEAD` export)
// so a before/after comparison runs the identical harness.
const appRoot = process.env.APP_ROOT ? path.resolve(process.env.APP_ROOT) : repoRoot;

const DATASET = process.env.DATASET ||
    '/Users/soline/Documents/luc3d/LabMeetingPrep/Oline/20260605_133431-HardFight_1kModels';
const LABEL = process.env.LABEL || 'baseline';
const METHODS = (process.env.METHODS || 'ba,dlt').split(',').map(s => s.trim()).filter(Boolean);
const SHOT_MS = Number(process.env.SHOT_MS || 0);
const PORT = Number(process.env.PORT || 8124);
// OPS=load      stop after the load; default runs Track All + Triangulate All too.
const OPS = (process.env.OPS || 'load,track,tri').split(',');
// STAGES=1      print every stage's duration (consecutive overlay texts, digits masked).
const STAGES = process.env.STAGES === '1';
const EXCLUDE = /(^|\/)\.|\/troubleshooting\//;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR = path.join(repoRoot, 'verify', 'progress-bench', `${LABEL}-${stamp}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const log = (m) => process.stdout.write(m + '\n');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
if (!fs.existsSync(DATASET)) { console.error('DATASET not found: ' + DATASET); process.exit(2); }

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: appRoot, stdio: 'ignore' });
await sleep(1200);

// a visible browser window: one such run at a time across sessions (scripts/browser-lock.mjs)
const releaseBrowserLock = await acquireBrowserLock({ label: '_bench-progress-overlay' });
let browser;
const summary = { label: LABEL, appRoot, dataset: DATASET, when: new Date().toISOString(), ops: [] };
try {
    browser = await chromium.launch({
        channel: 'chrome', headless: false,
        args: ['--window-size=1800,1120', '--window-position=0,0'],
    });
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    page.on('pageerror', e => log('  [pageerror] ' + String(e).slice(0, 300)));
    page.on('dialog', d => d.accept(process.env.NANIMALS || '3'));
    // CONSOLE=<regex>: echo matching console lines, timestamped from the start.
    if (process.env.CONSOLE) {
        const re = new RegExp(process.env.CONSOLE);
        const c0 = Date.now();
        page.on('console', m => { const t = m.text(); if (re.test(t)) log(`  [${((Date.now() - c0) / 1000).toFixed(2)}s] ${t.slice(0, 200)}`); });
    }

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 30000 });
    // TRI_WORKERS=N: Triangulate All worker-pool size (0 = solve inline).
    if (process.env.TRI_WORKERS != null) {
        await page.evaluate((n) => { window.LUCID_TRIANGULATION_WORKERS = n; }, Number(process.env.TRI_WORKERS));
    }

    // In-page recorder: overlay updates + painted frames while the overlay is up.
    await page.evaluate(() => {
        const R = window.__prog = { rec: null };
        const overlay = document.getElementById('loadingOverlay');
        const status = document.getElementById('loadingStatus');
        const barFrac = () => {
            const b = document.getElementById('loadingProgressFill');
            const wrap = document.getElementById('loadingProgress');
            if (!b || !wrap || wrap.classList.contains('hidden')) return null;
            const v = parseFloat(b.dataset.fraction);
            return Number.isFinite(v) ? v : null;
        };
        const snap = () => {
            if (!R.rec) return;
            const text = status.textContent;
            const frac = barFrac();
            const visible = !overlay.classList.contains('hidden');
            const etaEl = document.getElementById('loadingEta');
            const eta = etaEl && !etaEl.classList.contains('hidden') ? etaEl.textContent : null;
            const etaMs = etaEl && etaEl.dataset.ms ? Number(etaEl.dataset.ms) : null;
            const last = R.rec.updates[R.rec.updates.length - 1];
            if (last && last.text === text && last.frac === frac && last.visible === visible &&
                last.eta === eta) return;
            R.rec.updates.push({ t: Math.round(performance.now() - R.rec.t0), text, frac, visible, eta, etaMs });
        };
        new MutationObserver(snap).observe(overlay, { attributes: true, childList: true,
            subtree: true, characterData: true });
        const tick = () => {
            if (R.rec && !overlay.classList.contains('hidden')) R.rec.paints++;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        R.start = (name) => { R.rec = { name, t0: performance.now(), updates: [], paints: 0 }; };
    });

    const cdp = process.env.CPU_PROFILE === '1' ? await page.context().newCDPSession(page) : null;
    if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); }
    function summarizeProfile(name, prof) {
        fs.writeFileSync(path.join(OUT_DIR, name + '.cpuprofile'), JSON.stringify(prof));
        const dt = new Map();          // node id -> self ms (from sample deltas)
        for (let i = 0; i < prof.samples.length; i++) {
            dt.set(prof.samples[i], (dt.get(prof.samples[i]) || 0) + (prof.timeDeltas[i + 1] || 0) / 1000);
        }
        const self = new Map(); let total = 0, idle = 0, gc = 0;
        for (const n of prof.nodes) {
            const ms = dt.get(n.id) || 0;
            total += ms;
            const fn = n.callFrame.functionName || '(anonymous)';
            if (fn === '(idle)') { idle += ms; continue; }
            if (fn === '(garbage collector)') gc += ms;
            const file = (n.callFrame.url || '').split('/').slice(-2).join('/');
            const key = `${fn}  ${file}:${n.callFrame.lineNumber + 1}`;
            self.set(key, (self.get(key) || 0) + ms);
        }
        const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22);
        log(`   cpu: ${(total / 1000).toFixed(1)} s sampled, main thread idle ${(100 * idle / total).toFixed(0)}%, GC ${(gc / 1000).toFixed(1)} s`);
        for (const [k, ms] of top) log(`     ${(ms / 1000).toFixed(2).padStart(6)} s  ${(100 * ms / total).toFixed(1).padStart(5)}%  ${k}`);
    }

    async function runOp(name, startFn, doneRe) {
        log(`\n== ${name}`);
        if (cdp) await cdp.send('Profiler.start');
        const prevStatus = await page.evaluate(() => document.getElementById('statusText').textContent);
        await page.evaluate((n) => window.__prog.start(n), name);
        await startFn();
        const shots = [];
        const t0 = Date.now();
        let nextShot = Date.now() + (SHOT_MS || 1e12);
        for (;;) {
            const s = await page.evaluate(() => ({
                status: document.getElementById('statusText').textContent,
                hidden: document.getElementById('loadingOverlay').classList.contains('hidden'),
                text: document.getElementById('loadingStatus').textContent,
                eta: (document.getElementById('loadingEta') || {}).textContent || '',
            })).catch(() => null);
            if (s && s.hidden && s.status !== prevStatus && doneRe.test(s.status)) break;
            if (s && s.hidden && /error/i.test(s.status) && s.status !== prevStatus) throw new Error(name + ': ' + s.status);
            if (Date.now() - t0 > 60 * 60 * 1000) throw new Error(name + ' timed out');
            if (SHOT_MS && Date.now() >= nextShot && s && !s.hidden) {
                const f = path.join(OUT_DIR, `${name}-${String(shots.length).padStart(2, '0')}.png`);
                await page.screenshot({ path: f, timeout: 20000 }).catch(e => log('  shot failed: ' + e.message));
                shots.push({ file: path.basename(f), atS: +((Date.now() - t0) / 1000).toFixed(1), text: s.text, eta: s.eta });
                log(`  shot ${path.basename(f)} @${shots[shots.length - 1].atS}s  "${s.text}" | ${s.eta}`);
                nextShot = Date.now() + SHOT_MS;
            }
            await sleep(SHOT_MS ? 100 : 250);
        }
        if (cdp) summarizeProfile(name, (await cdp.send('Profiler.stop')).profile);
        const rec = await page.evaluate(() => {
            const r = window.__prog.rec;
            // The final hide. MutationObserver callbacks run at the end of the
            // task that hid the overlay, so this includes the synchronous tail.
            const hide = [...r.updates].reverse().find(u => !u.visible);
            return { ...r, totalMs: hide ? hide.t : null,
                     status: document.getElementById('statusText').textContent };
        });
        const vis = rec.updates.filter(u => u.visible);
        const gaps = vis.slice(1).map((u, i) => u.t - vis[i].t);
        gaps.sort((a, b) => a - b);
        const fracs = vis.map(u => u.frac).filter(f => f != null);
        // Monotone WITHIN a stage: a multi-step run legitimately restarts the
        // bar at each new label ("Parsing annotations" -> "Building session").
        const label = (u) => u.text.split(':')[0];
        const withBar = vis.filter(u => u.frac != null);
        const monotone = withBar.every((u, i) => i === 0 || label(u) !== label(withBar[i - 1]) ||
            u.frac >= withBar[i - 1].frac - 1e-9);
        const out = {
            name, totalMs: rec.totalMs, status: rec.status, updates: vis.length,
            paints: rec.paints,
            paintsPerSec: rec.totalMs ? +(rec.paints / (rec.totalMs / 1000)).toFixed(1) : null,
            updateGapMs: gaps.length ? { median: gaps[Math.floor(gaps.length / 2)],
                p95: gaps[Math.floor(gaps.length * 0.95)], max: gaps[gaps.length - 1] } : null,
            barUpdates: fracs.length, barMonotone: monotone,
            // Displayed estimate vs the time that actually remained, at a few
            // points through the run (the overlay hides at rec.totalMs).
            etaAccuracy: rec.totalMs ? [0.1, 0.25, 0.5, 0.75, 0.9].map(p => {
                const at = rec.totalMs * p;
                const u = vis.filter(x => x.t <= at && x.etaMs != null).pop();
                if (!u) return { at: p, eta: null };
                const actual = rec.totalMs - u.t;
                return { at: p, shown: u.eta, estS: +(u.etaMs / 1000).toFixed(1),
                         actualS: +(actual / 1000).toFixed(1),
                         errPct: Math.round((u.etaMs - actual) / actual * 100) };
            }) : null,
            // Consecutive updates collapsed into stages (digits masked), with
            // how long each stage's text stayed up.
            stages: (() => {
                const st = [];
                for (const u of rec.updates) {
                    const key = u.visible ? u.text.replace(/[\d,.]+/g, '#') : '(hidden)';
                    const last = st[st.length - 1];
                    if (last && last.key === key) { last.lastText = u.text; continue; }
                    st.push({ key, t: u.t, firstText: u.text, lastText: u.text });
                }
                return st.map((x, i) => ({ ms: (i + 1 < st.length ? st[i + 1].t : rec.totalMs) - x.t,
                    at: x.t, text: x.key === '(hidden)' ? '(overlay hidden)' : x.lastText }))
                    .filter(x => x.ms > 0 || x.text !== '(overlay hidden)');
            })(),
            sampleTexts: vis.filter((_, i) => i % Math.max(1, Math.floor(vis.length / 8)) === 0)
                .map(u => `${u.t}ms ${u.frac != null ? '[' + (u.frac * 100).toFixed(1) + '%] ' : ''}${u.text}${u.eta ? ' | ' + u.eta : ''}`),
            shots,
        };
        log(JSON.stringify({ ...out, shots: undefined, sampleTexts: undefined, etaAccuracy: undefined, stages: undefined }, null, 0));
        if (STAGES) out.stages.forEach(x => log(`   stage @${x.at}ms  ${String(x.ms).padStart(6)} ms  ${x.text}`));
        (out.etaAccuracy || []).forEach(a => log('   eta @' + Math.round(a.at * 100) + '%: ' +
            (a.shown ? `"${a.shown}" (est ${a.estS}s, actual ${a.actualS}s, ${a.errPct > 0 ? '+' : ''}${a.errPct}%)` : 'none shown')));
        out.sampleTexts.forEach(t => log('   ' + t));
        if (process.env.DIGEST_OPS === '1') {
            out.outputDigest = await page.evaluate(() => {
                // Generic deterministic hash: Maps/objects by sorted key, arrays and
                // typed arrays in order, numbers by their exact f64 bits.
                let h1 = 0x811c9dc5 >>> 0, h2 = 0x01000193 >>> 0;
                const f64 = new Float64Array(1), u8 = new Uint8Array(f64.buffer);
                const byte = (b) => { h1 = Math.imul(h1 ^ b, 16777619) >>> 0; h2 = Math.imul(h2 ^ b, 2246822519) >>> 0; };
                const num = (v) => { f64[0] = v; for (let i = 0; i < 8; i++) byte(u8[i]); };
                const str = (t) => { num(t.length); for (let i = 0; i < t.length; i++) num(t.charCodeAt(i)); };
                const cmp = (a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
                const seen = new WeakSet();
                const walk = (v) => {
                    if (v === null) { str('null'); return; }
                    const t = typeof v;
                    if (t === 'undefined') { str('undef'); return; }
                    if (t === 'number') { str('n'); num(v); return; }
                    if (t === 'string') { str('s'); str(v); return; }
                    if (t === 'boolean') { str(v ? 'T' : 'F'); return; }
                    if (t === 'function') return;
                    if (seen.has(v)) { str('<cycle>'); return; }
                    seen.add(v);
                    if (ArrayBuffer.isView(v)) { str('ta'); num(v.length); for (let i = 0; i < v.length; i++) num(v[i]); }
                    else if (Array.isArray(v)) { str('a'); num(v.length); for (const x of v) walk(x); }
                    else if (v instanceof Map) { str('m'); const ks = [...v.keys()].sort(cmp); num(ks.length); for (const k of ks) { walk(k); walk(v.get(k)); } }
                    else if (v instanceof Set) { str('set'); const ks = [...v].sort(cmp); num(ks.length); for (const k of ks) walk(k); }
                    else { str('o'); const ks = Object.keys(v).sort(); for (const k of ks) { str(k); walk(v[k]); } }
                    seen.delete(v);
                };
                const st = window.__lucid.state, s = st.session;
                const part = (v) => { h1 = 0x811c9dc5 >>> 0; h2 = 0x01000193 >>> 0; walk(v); return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'); };
                let groups = 0, with3d = 0;
                for (const [, gs] of s.instanceGroups) for (const g of gs) { groups++; if (g.points3d && g.points3d.length) with3d++; }
                return {
                    identities: part(s.identities), frameIdentityMap: part(s.frameIdentityMap),
                    instanceGroups: part(s.instanceGroups), triangulationResults: part(st.triangulationResults),
                    groups, with3d,
                };
            });
            log('   output digest: ' + JSON.stringify(out.outputDigest));
        }
        summary.ops.push({ ...out, updatesFull: vis });
        return out;
    }

    // Load the per-camera folder, disk-backed (same as _bench-playback.mjs),
    // recorded as the `load` op (File ▸ Load Single Session Folder's handler).
    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.webkitdirectory = true; inp.id = '__benchDir';
        inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
        setInterval(() => {
            for (const b of document.querySelectorAll('button')) {
                const t = b.textContent.trim();
                if ((t === 'Continue' || t === 'OK') && b.offsetParent !== null) b.click();
            }
        }, 300);
    });
    await page.setInputFiles('#__benchDir', DATASET);
    // PROFILE_VIDEO=1: time each OnDemandVideoDecoder.init phase (wall clock,
    // concurrent across decoders) and log main-thread long tasks during the load.
    if (process.env.PROFILE_VIDEO === '1') {
        await page.evaluate(async () => {
            const { OnDemandVideoDecoder } = await import('./loading/video.js');
            const P = window.__vprof = { calls: [], long: [] };
            const t0 = performance.now();
            for (const m of ['init', '_awaitPlayable', '_initMp4box', '_initMediabunny']) {
                const orig = OnDemandVideoDecoder.prototype[m];
                if (!orig) continue;
                OnDemandVideoDecoder.prototype[m] = async function (...a) {
                    const s = performance.now();
                    try { return await orig.apply(this, a); }
                    finally { P.calls.push({ m, start: Math.round(s - t0), ms: Math.round(performance.now() - s) }); }
                };
            }
            new PerformanceObserver(l => { for (const e of l.getEntries()) P.long.push({ start: Math.round(e.startTime - t0), ms: Math.round(e.duration) }); })
                .observe({ entryTypes: ['longtask'] });
        });
    }
    await runOp('load', () => page.evaluate((src) => {
        window.__benchLoad = { done: false, err: null };
        (async () => {
            try {
                const sl = await import('./loading/session-loader.js');
                const ex = new RegExp(src);
                const files = Array.from(document.getElementById('__benchDir').files)
                    .filter(f => !ex.test(f.webkitRelativePath || f.name));
                await sl.handleLoadSessionFolderPerCamera(files, false);
                window.__benchLoad.done = true;
            } catch (e) { window.__benchLoad.err = String(e && e.stack || e).slice(0, 600); }
        })();
    }, EXCLUDE.source), /^Loaded \d+ camera/);
    const lerr = await page.evaluate(() => window.__benchLoad.err);
    if (lerr) throw new Error('load failed: ' + lerr);
    await page.waitForFunction(() => window.__benchLoad.done, null, { timeout: 120000, polling: 500 });
    await sleep(1500);
    summary.project = await page.evaluate(() => {
        const s = window.__lucid.state.session;
        return { cameras: s.cameras.length, frameGroups: s.frameGroups.size,
                 lazy: !!s.lazyLoader, windowed: !!(s.lazyLoader && s.lazyLoader.isSync &&
                     typeof s.lazyLoader.releaseWindow === 'function') };
    });
    log('project: ' + JSON.stringify(summary.project));
    if (process.env.PROFILE_VIDEO === '1') {
        const P = await page.evaluate(() => window.__vprof);
        const by = {};
        for (const c of P.calls) (by[c.m] = by[c.m] || []).push(c);
        for (const m of Object.keys(by)) log(`  video ${m}: ` + by[m].map(c => `${c.ms}ms@${c.start}`).join(' '));
        const lt = P.long.filter(l => l.ms >= 50);
        log(`  long tasks >=50ms: ${lt.length}, total ${lt.reduce((a, l) => a + l.ms, 0)} ms: ` +
            lt.map(l => `${l.ms}@${l.start}`).join(' '));
    }
    // DIGEST=1: hash everything the load put in the session (every frame, camera,
    // instance: track name, type, score, coords, occlusion), so two checkouts'
    // loads of the same folder can be compared exactly (APP_ROOT=<other>).
    if (process.env.DIGEST === '1') {
        summary.digest = await page.evaluate(() => {
            const s = window.__lucid.state.session;
            let h1 = 0x811c9dc5 >>> 0, h2 = 0x01000193 >>> 0;
            const f64 = new Float64Array(1), u8 = new Uint8Array(f64.buffer);
            const num = (v) => { f64[0] = v; for (let i = 0; i < 8; i++) { h1 = Math.imul(h1 ^ u8[i], 16777619) >>> 0; h2 = Math.imul(h2 ^ u8[i], 2246822519) >>> 0; } };
            const str = (t) => { num(t.length); for (let i = 0; i < t.length; i++) num(t.charCodeAt(i)); };
            let nInst = 0, nPts = 0, nOcc = 0;
            const frames = Array.from(s.frameGroups.keys()).sort((a, b) => a - b);
            for (const fi of frames) {
                const fg = s.frameGroups.get(fi);
                num(fi);
                const byCam = new Map();
                for (const [cam, list] of fg.instances) for (const inst of list) (byCam.get(cam) || byCam.set(cam, []).get(cam)).push(inst);
                for (const [cam, list] of fg.unlinkedInstances) for (const ul of list) (byCam.get(cam) || byCam.set(cam, []).get(cam)).push(ul.instance);
                for (const cam of Array.from(byCam.keys()).sort()) {
                    str(cam);
                    for (const inst of byCam.get(cam)) {
                        nInst++;
                        str(inst.trackIdx == null ? '<none>' : String(s.tracks[inst.trackIdx]));
                        str(inst.type); num(inst.score);
                        for (let k = 0; k < inst.numNodes; k++) {
                            num(inst.getX(k)); num(inst.getY(k));
                            const o = inst.isOccluded ? inst.isOccluded(k) : false;
                            num(o ? 1 : 0);
                            if (!Number.isNaN(inst.getX(k))) nPts++;
                            if (o) nOcc++;
                        }
                    }
                }
            }
            const st = window.__lucid.state;
            return { hash: h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'),
                     frames: frames.length, instances: nInst, points: nPts, occluded: nOcc, tracks: s.tracks.length,
                     // Video/view state, in order (the parallel decoder init must not reorder it).
                     views: st.views.map(v => v.name + ':' + v.videoWidth + 'x' + v.videoHeight).join(','),
                     videoFiles: st.videoFiles.map(v => v.name + ':' + v.frameCount + ':' + v.assignedCamera).join(','),
                     decoders: st.decoderPool.length, cameras: s.cameras.map(c => c.name).join(','),
                     totalFrames: st.totalFrames, fps: +st.fps.toFixed(4) };
        });
        log('digest: ' + JSON.stringify(summary.digest));
    }

    if (!OPS.includes('track')) throw new Error('__stop');
    await runOp('trackAll', () => page.evaluate(() => document.getElementById('tbTrackAll').click()),
        /Assigned \d+ identities/);

    for (const m of (OPS.includes('tri') ? METHODS : [])) {
        await page.evaluate(async (m) => {
            const st = await import('./ui/settings.js');
            st.setDefaultTriangulationMethod(m);
        }, m);
        await sleep(500);
        await runOp('triangulateAll-' + m,
            () => page.evaluate(() => document.getElementById('tbTriangulateAll').click()),
            /^(Triangulated|Grouped) /);
    }
} catch (e) {
    if (e.message !== '__stop') throw e;
} finally {
    fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
    log('\nwrote ' + path.relative(repoRoot, OUT_DIR));
    if (browser) await browser.close().catch(() => {});
    await releaseBrowserLock();
    server.kill();
}
