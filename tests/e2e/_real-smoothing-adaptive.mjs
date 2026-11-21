/**
 * _real-smoothing-adaptive.mjs — Temporal Smoothing's adaptive method on a real
 * project, opened lazily as File ▸ Load Project opens a large one, run through
 * the toolbar's Smooth button.
 *
 * Not a test (needs a real project with 3D). Usage:
 *     PROJECT=/path/to/project.slp node tests/e2e/_real-smoothing-adaptive.mjs
 *     FRAME_CHECKS=200 (This frame vs All frames on that many frames)
 *
 * Reports, per run (adaptive at gate 3 and 4, adaptive weighing every point by
 * its node's sigma instead of its views, and the windows median 3 + Gaussian
 * 7), against the 3D from before any smoothing (each group's source):
 *   - frame-to-frame jitter: |x[t+1] - 2 x[t] + x[t-1]| per node, mm;
 *   - agreement: |smoothed - unsmoothed| per node, mm, overall and by speed
 *     (|x[t+1] - x[t-1]| / 2 under 1 mm/frame vs over 10);
 *   - the run's time, mean window and fallback count (its status).
 * Then checks This frame against All frames, bit for bit, on random frames, and
 * how many group members were read from the store (released 2D).
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PROJECT = process.env.PROJECT;
const FRAME_CHECKS = Number(process.env.FRAME_CHECKS || 200);
if (!PROJECT) { console.error('set PROJECT=<project .slp>'); process.exit(2); }

const log = (m) => process.stdout.write(m + '\n');
const t00 = Date.now();
const el = () => ((Date.now() - t00) / 1000).toFixed(1) + 's';
let fails = 0;
const check = (c, m) => { log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = await startServer(repoRoot);
let browser;
try {
    browser = await launchBrowser({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.on('pageerror', e => log(`  [${el()}] [pageerror] ` + String(e).slice(0, 300)));
    page.on('crash', () => { log(`  [${el()}] *** RENDERER CRASHED ***`); fails++; });
    await page.goto(`http://localhost:${server.port}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.SleapIO, null, { timeout: 60000 });

    // The loader ends in an attach-videos modal; skip it.
    await page.evaluate(() => {
        setInterval(() => {
            for (const b of Array.from(document.querySelectorAll('button'))) {
                const t = b.textContent.trim();
                if ((t === 'Continue' || t.startsWith('Skip') || t === 'Later') && b.offsetParent !== null) b.click();
            }
        }, 250);
        const inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__projPicker'; inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
    });
    await page.setInputFiles('#__projPicker', PROJECT);
    log(`[${el()}] loading ${path.basename(PROJECT)} (${(fs.statSync(PROJECT).size / 1048576).toFixed(0)} MB)`);
    await page.evaluate(() => {
        window.__load = { done: false, err: null };
        import('/loading/session-loader.js').then(sl =>
            sl.handleLoadProjectSlpLazy(document.getElementById('__projPicker').files[0])
                .then(() => { window.__load.done = true; })
                .catch(e => { window.__load.err = String(e && e.stack || e).slice(0, 400); }));
    });
    await page.waitForFunction(() => window.__load.done || window.__load.err, null, { timeout: 900000, polling: 1000 });
    await page.waitForTimeout(1500);

    const info = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const SM = await import('/import-export/smoothing-metadata.js');
        const s = window.__lucid.state.session;
        let groups = 0, withSource = 0, members = 0, released = 0;
        const ids = new Set();
        for (const [, gs] of s.instanceGroups) for (const g of gs) {
            if (!g.points3d) continue;
            groups++; ids.add(g.identityId);
            if (pd.unsmoothedPoints3d(g.points3d)) withSource++;
            for (const m of g.instances.values()) { members++; if (m && m._lazy2d) released++; }
        }
        // The 3D from before any smoothing: the run's input, the yardstick.
        window.__raw = new Map();
        for (const [f, gs] of s.instanceGroups) for (const g of gs) {
            if (!g.points3d) continue;
            const src = pd.unsmoothedPoints3d(g.points3d) || g.points3d;
            window.__raw.set(f + '|' + g.identityId, Float64Array.from(src));
        }
        const run = SM.smoothingRunOf(s);
        return {
            err: window.__load.err, lazy: !!s.lazyLoader, frames: s.instanceGroups.size, groups, withSource,
            identities: [...ids], cameras: s.cameras.map(c => c.name), nodes: s.skeleton.nodes.length,
            members, released, storeRows: !!(s.lazyLoader && s.lazyLoader.storeRowPoints),
            lastRun: run,
        };
    });
    log(`[${el()}] loaded ${JSON.stringify(info)}`);
    check(!info.err && info.groups > 0, 'project opened, with 3D');

    // Metrics of the session's 3D now against window.__raw.
    const metrics = () => page.evaluate(async () => {
        const TS = await import('/pose/temporal-smoothing.js');
        const s = window.__lucid.state.session;
        const { tracks } = TS.collectTrajectories(s);
        const jitRaw = [], jitNow = [], dev = [], devSlow = [], devFast = [];
        const norm3 = (a, i, b, j) => Math.hypot(a[i] - b[j], a[i + 1] - b[j + 1], a[i + 2] - b[j + 2]);
        for (const [id, byFrame] of tracks) {
            const fr = [...byFrame.keys()].sort((a, b) => a - b);
            for (let i = 0; i < fr.length; i++) {
                const f = fr[i];
                const now = byFrame.get(f).points3d, raw = window.__raw.get(f + '|' + id);
                if (!raw) continue;
                const prevOk = i > 0 && fr[i - 1] === f - 1, nextOk = i + 1 < fr.length && fr[i + 1] === f + 1;
                const rawP = prevOk ? window.__raw.get((f - 1) + '|' + id) : null;
                const rawN = nextOk ? window.__raw.get((f + 1) + '|' + id) : null;
                const nowP = prevOk ? byFrame.get(f - 1).points3d : null;
                const nowN = nextOk ? byFrame.get(f + 1).points3d : null;
                for (let o = 0; o + 2 < now.length; o += 3) {
                    if (!Number.isFinite(raw[o]) || !Number.isFinite(now[o])) continue;
                    const d = norm3(now, o, raw, o);
                    dev.push(d);
                    if (rawP && rawN && Number.isFinite(rawP[o]) && Number.isFinite(rawN[o])) {
                        const speed = norm3(rawN, o, rawP, o) / 2;
                        if (speed < 1) devSlow.push(d); else if (speed > 10) devFast.push(d);
                        let s2 = 0, n2 = 0;
                        for (let a = 0; a < 3; a++) {
                            const r = rawN[o + a] - 2 * raw[o + a] + rawP[o + a];
                            const q = nowN[o + a] - 2 * now[o + a] + nowP[o + a];
                            s2 += r * r; n2 += q * q;
                        }
                        if (Number.isFinite(s2) && Number.isFinite(n2)) { jitRaw.push(Math.sqrt(s2)); jitNow.push(Math.sqrt(n2)); }
                    }
                }
            }
        }
        const q = (arr, p) => {
            if (!arr.length) return NaN;
            const a = Float64Array.from(arr).sort();
            return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))];
        };
        const frac = (arr, t) => arr.filter(v => v > t).length / Math.max(1, arr.length);
        return {
            jitter: { raw: [q(jitRaw, 0.5), q(jitRaw, 0.9), q(jitRaw, 0.99)], now: [q(jitNow, 0.5), q(jitNow, 0.9), q(jitNow, 0.99)], n: jitRaw.length },
            dev: { med: q(dev, 0.5), p90: q(dev, 0.9), p99: q(dev, 0.99), max: q(dev, 1), over5: frac(dev, 5), over10: frac(dev, 10), n: dev.length },
            slow: { med: q(devSlow, 0.5), p99: q(devSlow, 0.99), n: devSlow.length },
            fast: { med: q(devFast, 0.5), p99: q(devFast, 0.99), n: devFast.length },
        };
    });

    const runAll = (params) => page.evaluate(async (params) => {
        const S = await import('/ui/settings.js');
        S.setSmoothingParams(params);
        const st = document.getElementById('statusText');
        st.textContent = '';
        const done = new Promise(res => {
            const mo = new MutationObserver(() => {
                if (/^Smoothed |^Temporal smoothing/.test(st.textContent)) { mo.disconnect(); res(); }
            });
            mo.observe(st, { childList: true, characterData: true, subtree: true });
        });
        const t = performance.now();
        document.getElementById('tbSmooth').click();
        await done;
        return { ms: performance.now() - t, status: st.textContent };
    }, params);

    const f1 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '–');
    const RUNS = [
        ['adaptive, gate 3 (default)', { smoothMethod: 1 }],
        ['adaptive, gate 3, node sigma only', { smoothMethod: 1, smoothAtaCovariance: 'sigma' }],
        ['adaptive, gate 4', { smoothMethod: 1, smoothAtaK: 4 }],
        ['adaptive, gate 2', { smoothMethod: 1, smoothAtaK: 2 }],
        ['windows: median 3 + Gaussian 7', { smoothMethod: 0, smoothMedianWindow: 3, smoothGaussianWindow: 7 }],
    ];
    const rows = [];
    for (const [label, params] of RUNS) {
        const r = await runAll(params);
        const m = await metrics();
        rows.push({ label, r, m });
        log(`[${el()}] ${label}: ${(r.ms / 1000).toFixed(1)} s — ${r.status}`);
        log(`    jitter median/p90/p99 mm: ${m.jitter.raw.map(f1).join('/')} -> ${m.jitter.now.map(f1).join('/')} (n ${m.jitter.n.toLocaleString('en-US')})`);
        log(`    |smoothed - unsmoothed| mm: median ${f1(m.dev.med)}, p90 ${f1(m.dev.p90)}, p99 ${f1(m.dev.p99)}, max ${f1(m.dev.max)}; >5 mm ${(100 * m.dev.over5).toFixed(2)} %, >10 mm ${(100 * m.dev.over10).toFixed(2)} %`);
        log(`    by speed: under 1 mm/frame median ${f1(m.slow.med)} p99 ${f1(m.slow.p99)} (n ${m.slow.n.toLocaleString('en-US')}); over 10 mm/frame median ${f1(m.fast.med)} p99 ${f1(m.fast.p99)} (n ${m.fast.n.toLocaleString('en-US')})`);
    }
    const main = rows[0];
    check(main.m.jitter.now[0] < main.m.jitter.raw[0], `adaptive lowers the median jitter (${f1(main.m.jitter.raw[0])} -> ${f1(main.m.jitter.now[0])} mm)`);

    // This frame vs All frames, on random frames (the default adaptive run).
    const tf = await page.evaluate(async ({ n }) => {
        const S = await import('/ui/settings.js');
        const TS = await import('/pose/temporal-smoothing.js');
        const SM = await import('/import-export/smoothing-metadata.js');
        const s = window.__lucid.state.session;
        S.setSmoothingParams({ smoothMethod: 1 });
        const params = S.getSmoothingParams();
        TS.smoothSession(s, params);
        const all = new Map();
        for (const [f, gs] of s.instanceGroups) for (const g of gs) if (g.points3d) all.set(f + '|' + g.identityId, Float64Array.from(g.points3d));
        TS.removeSmoothing(s, { scope: 'all', config: TS.resolveSmoothingParams(params) });
        const frames = [...s.instanceGroups.keys()];
        let seed = 99;
        const pick = [];
        for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; pick.push(frames[seed % frames.length]); }
        let diff = 0, compared = 0, ms = 0;
        for (const f of pick) {
            const t = performance.now();
            TS.smoothFrame(s, params, f);
            ms += performance.now() - t;
            for (const g of s.instanceGroups.get(f) || []) {
                if (!g.points3d) continue;
                const a = all.get(f + '|' + g.identityId);
                compared++;
                for (let i = 0; i < a.length; i++) {
                    const x = g.points3d[i], y = a[i];
                    if (!(x === y || (Number.isNaN(x) && Number.isNaN(y)))) { diff++; break; }
                }
            }
        }
        // Put back what the file held (its own last run is unaffected: not saved).
        TS.unsmoothSession(s);
        void SM;
        return { compared, diff, msPerFrame: ms / n };
    }, { n: FRAME_CHECKS });
    check(tf.diff === 0 && tf.compared > 0,
        `This frame = All frames on ${FRAME_CHECKS} random frames (${tf.compared} groups, ${tf.diff} differ; ${tf.msPerFrame.toFixed(1)} ms per frame)`);

    // Markdown table for the PR.
    log('\n| run | time | mean window | jitter median (p90) mm | \\|smoothed - unsmoothed\\| median / p99 / max mm | > 5 mm | fast (> 10 mm/frame) median / p99 mm |');
    log('|---|---|---|---|---|---|---|');
    log(`| unsmoothed | | | ${f1(main.m.jitter.raw[0])} (${f1(main.m.jitter.raw[1])}) | | | |`);
    for (const { label, r, m } of rows) {
        const mw = (r.status.match(/mean window ([\d.]+) frames/) || [])[1] || '';
        log(`| ${label} | ${(r.ms / 1000).toFixed(1)} s | ${mw} | ${f1(m.jitter.now[0])} (${f1(m.jitter.now[1])}) | ${f1(m.dev.med)} / ${f1(m.dev.p99)} / ${f1(m.dev.max)} | ${(100 * m.dev.over5).toFixed(2)} % | ${f1(m.fast.med)} / ${f1(m.fast.p99)} |`);
    }
} finally {
    if (browser) await browser.close();
    server.kill();
}
log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
