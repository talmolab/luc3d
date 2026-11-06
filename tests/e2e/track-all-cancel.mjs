/**
 * track-all-cancel.mjs — the progress card's Cancel (and Esc) stops Track All and
 * Track Frame Range part-way, on the tracker worker and inline, and leaves the
 * project consistent.
 *
 * Same untidy synthetic scene as track-all-worker.mjs. Cancel is pressed from the
 * card once the bar passes ~30% (a MutationObserver on the fill), then:
 *  1. the pass resolves `{ok: false, cancelled: true}` promptly and the card closes,
 *     with its Cancel button gone and the status saying which frames were tracked;
 *  2. the frames tracked before Cancel are EXACTLY what a full run gives them
 *     (groups, members, 3D, per-frame identities), and no later frame has any —
 *     also nothing arrives after the pass returned (the worker was terminated);
 *  3. a lazy project gives back the windows it held (resident frames drop to ~0);
 *  4. Esc cancels as the button does;
 *  5. Track All run again afterwards gives exactly a fresh run's result;
 *  6. a range run cancelled part-way keeps the frames outside the range untouched.
 *
 * Run: node tests/e2e/track-all-cancel.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8613);
let fails = 0;
const T0 = Date.now();
const lap = (m) => console.log(`  [${((Date.now() - T0) / 1000).toFixed(1)} s] ${m}`);
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    await page.evaluate(() => {
        // Count tracker workers started (pose/tracker-pool.js).
        const RealWorker = window.Worker;
        window.__trackerWorkers = 0;
        window.Worker = function (url, opts) {
            if (/tracker-worker\.js/.test(String(url))) window.__trackerWorkers++;
            return new RealWorker(url, opts);
        };
        window.Worker.prototype = RealWorker.prototype;

        /** The untidy synthetic scene: obs.get(fi).get(camName) = [{points, trackIdx, score}] (fresh copies per call). */
        window.__scene = async (N, seed) => {
            const pd = await import('/pose/pose-data.js');
            let s = seed >>> 0;
            const u = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
            const gauss = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
            const F = 1000, K = [[F, 0, 640], [0, F, 512], [0, 0, 1]], DIST = [-0.1, 0, 0, 0, 0], D = 60;
            const RV = [[0, 0, 0], [0, 0.5, 0], [0.45, -0.35, 0], [-0.4, -0.3, 0.2]];
            const cams = RV.map((r, i) => new pd.Camera('cam' + i, K, DIST, r, [0, 0, D], [1280, 1024]));
            const NA = 3, NN = 10;
            const shape = [], c = [], v = [];
            for (let a = 0; a < NA; a++) {
                shape.push(Array.from({ length: NN }, () => [(u() - 0.5) * 4, (u() - 0.5) * 4, (u() - 0.5) * 4]));
                c.push([(a - 1) * 5, (u() - 0.5) * 4, 0]); v.push([0, 0, 0]);
            }
            const obs = [];
            for (let f = 0; f < N; f++) {
                for (let a = 0; a < NA; a++) for (let d = 0; d < 3; d++) {
                    v[a][d] = 0.9 * v[a][d] + 0.12 * gauss();
                    c[a][d] += v[a][d];
                    if (c[a][d] > 7) { c[a][d] = 14 - c[a][d]; v[a][d] = -v[a][d]; }
                    if (c[a][d] < -7) { c[a][d] = -14 - c[a][d]; v[a][d] = -v[a][d]; }
                }
                const perCam = new Map();
                for (const cam of cams) {
                    const list = [];
                    for (let a = 0; a < NA; a++) {
                        if (u() < 0.04) continue;                                   // missed detection
                        const pts = shape[a].map(o => {
                            const q = cam.distortPoint(cam.project([c[a][0] + o[0], c[a][1] + o[1], c[a][2] + o[2]]));
                            const keep = u() >= 0.08;                               // per-node dropout
                            const p = [q[0] + gauss() * 1.5, q[1] + gauss() * 1.5];
                            return keep ? p : null;
                        });
                        list.push({ points: pts, trackIdx: u() < 0.02 ? (a + 1) % NA : a, score: 0.5 + 0.5 * u() });
                    }
                    if (u() < 0.03) list.push({                                     // false detection
                        points: Array.from({ length: NN }, () => [640 + (u() - 0.5) * 400, 512 + (u() - 0.5) * 400]),
                        trackIdx: NA, score: 0.3 * u() });
                    for (let i = list.length - 1; i > 0; i--) {                     // shuffle the slot order
                        const j = Math.floor(u() * (i + 1)); const t = list[i]; list[i] = list[j]; list[j] = t;
                    }
                    perCam.set(cam.name, list);
                }
                obs.push(perCam);
            }
            const skel = new pd.Skeleton('sk', Array.from({ length: NN }, (_, i) => 'n' + i),
                Array.from({ length: NN - 1 }, (_, i) => [i, i + 1]));
            const copy = (d) => ({ points: d.points.map(p => p && [p[0], p[1]]), trackIdx: d.trackIdx, type: 'predicted', score: d.score });
            return { pd, cams, skel, N, NA, obs, copy };
        };

        /** A fresh session over the scene, installed as the app's only session. */
        window.__install = async (sc, mode) => {
            const AS = await import('/ui/app-state.js');
            const TR = await import('/pose/tracker.js');
            const { pd, cams, skel, N, NA, obs, copy } = sc;
            const s = new pd.Session(cams, skel, Array.from({ length: NA + 1 }, (_, i) => 'track_' + i), 'WORKER_' + mode);
            if (mode === 'lazy') {
                s.lazyLoader = { isSync: true, nFrames: N,
                    getFrameSync(fi) {
                        if (fi < 0 || fi >= N) return null;
                        const m = new Map();
                        obs[fi].forEach((list, cam) => m.set(cam, list.map(copy)));
                        return m;
                    },
                    getFrame(fi) { return Promise.resolve(this.getFrameSync(fi) || new Map()); }, releaseWindow() {} };
            } else {
                for (let fi = 0; fi < N; fi++) obs[fi].forEach((list, cam) => list.forEach((d, i) => {
                    const c2 = copy(d), inst = new pd.Instance(c2.points, c2.trackIdx, 'predicted', c2.score);
                    inst._rawInstIndex = i;
                    s.addUnlinkedInstance(fi, cam, inst);                           // commit promotes these
                }));
            }
            AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
            AS.state.totalFrames = N; AS.state.currentFrame = 0; AS.state.views = []; AS.state.triangulationResults = new Map();
            TR.setTrackerNumAnimals(NA);                                            // no "Number of animals" prompt
            return s;
        };

        /** Everything a tracking pass writes, canonically, with every double's exact value. */
        window.__digest = (s, N) => {
            const name = new Map(s.identities.map(i => [i.id, i.name]));
            const num = (x) => Number.isNaN(x) ? 'NaN' : String(x);              // String(double) round-trips exactly
            const instKey = (inst) => inst.trackIdx + '@' + inst._rawInstIndex;
            const out = ['identities ' + s.identities.map(i => i.name).join(',')];
            const fim = Array.from(s.frameIdentityMap).sort((a, b) => a[0] - b[0]);
            out.push('fim ' + fim.map(e => e[0] + '=' + (e[1] === -1 ? '-1' : name.get(e[1]))).join(';'));
            let groups = 0;
            for (let fi = 0; fi < N; fi++) {
                const gs = s.instanceGroups.get(fi) || [];
                for (const g of gs) {
                    groups++;
                    const mem = []; g.instances.forEach((inst, cam) => mem.push(cam + ':' + instKey(inst)));
                    out.push(fi + ' ' + name.get(g.identityId) + ' [' + mem.join(' ') + '] ' +
                        (g.points3d ? Array.from(g.points3d, num).join(',') : 'null'));
                }
                const fg = s.frameGroups.get(fi);                                   // eager: what stayed unlinked
                if (fg) {
                    const un = []; fg.unlinkedInstances.forEach((list, cam) => list.forEach(x => un.push(cam + ':' + instKey(x.instance))));
                    const ln = []; fg.instances.forEach((list, cam) => list.forEach(x => ln.push(cam + ':' + instKey(x))));
                    out.push(fi + ' linked ' + ln.join(' ') + ' | unlinked ' + un.join(' '));
                }
            }
            return { text: out.join('\n'), groups, identities: s.identities.length };
        };

        /** Run `fn` (a tracking pass) with the worker on or off; its digest and how many workers it started. */
        window.__track = async (sc, mode, worker, fn, thresholds) => {
            const ST = await import('/ui/settings.js');
            document.querySelectorAll('.track-summary-modal, .modal-overlay').forEach(e => e.remove());
            window.LUCID_TRACKER_WORKER = worker ? undefined : 0;
            const before = ST.getTrackingThresholds();
            if (thresholds) ST.setTrackingThresholds(Object.assign({}, before, thresholds));
            const s = await window.__install(sc, mode);
            const w0 = window.__trackerWorkers, t0 = performance.now();
            let r;
            try { r = await fn(s); } finally { if (thresholds) ST.setTrackingThresholds(before); }
            const ms = performance.now() - t0;
            document.querySelectorAll('.track-summary-modal, .modal-overlay').forEach(e => e.remove());
            return Object.assign(window.__digest(s, sc.N), { ok: !!(r && r.ok), workers: window.__trackerWorkers - w0, ms,
                status: document.getElementById('statusText').textContent });
        };
    });


    // The ID-switch checks that follow a full run are not under test here, and are most of its time.
    await page.evaluate(async () => {
        const ST = await import('/ui/settings.js');
        ST.setTrackingThresholds(Object.assign({}, ST.getTrackingThresholds(), { autoSwitchCheck: 0, autoImageSwitchCheck: 0 }));
    });

    await page.evaluate(() => {
        /** Press the card's Cancel (or Esc) once the bar passes `at`; resolves what the press saw. */
        window.__cancelAt = (at, how) => new Promise((resolve) => {
            const fill = document.getElementById('loadingProgressFill');
            const obs = new MutationObserver(() => {
                const f = parseFloat(fill.dataset.fraction);
                const btn = document.getElementById('loadingCancel');
                if (!(f >= at) || f >= 1 || btn.hidden) return;
                obs.disconnect();
                if (how === 'esc') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                else btn.click();
                resolve({ fraction: f, label: btn.textContent, disabled: btn.disabled, t: performance.now() });
            });
            obs.observe(fill, { attributes: true, attributeFilter: ['data-fraction'] });
        });
        /** Per-frame lines of what tracking wrote at frames in [lo, hi]: groups (members + 3D) and per-frame identities. */
        window.__frames = (s, lo, hi) => {
            const name = new Map(s.identities.map(i => [i.id, i.name]));
            const num = (x) => Number.isNaN(x) ? 'NaN' : String(x);
            const out = [];
            for (let fi = lo; fi <= hi; fi++) for (const g of (s.instanceGroups.get(fi) || [])) {
                const mem = []; g.instances.forEach((inst, cam) => mem.push(cam + ':' + inst.trackIdx + '@' + inst._rawInstIndex));
                out.push(fi + ' ' + name.get(g.identityId) + ' [' + mem.join(' ') + '] ' + (g.points3d ? Array.from(g.points3d, num).join(',') : 'null'));
            }
            const fim = [];
            for (const r of s.frameIdentityEntries()) if (r.frameIdx >= lo && r.frameIdx <= hi)
                fim.push(r.frameIdx + ':' + r.camName + ':' + r.trackIdx + '=' + (r.identityId === -1 ? '-1' : name.get(r.identityId)));
            fim.sort();
            return out.join('\n') + '\n' + fim.join(';');
        };
        window.__lastGroupFrame = (s) => { let m = -1; s.instanceGroups.forEach((g, fi) => { if (g.length && fi > m) m = fi; }); return m; };
        /** Track All with Cancel pressed at `at`, then a full run on a fresh session; compares the tracked prefix. */
        window.__cancelCase = async (sc, mode, worker, how, at) => {
            const TR = await import('/pose/tracker.js');
            const fn = () => TR.trackAll();
            window.LUCID_TRACKER_WORKER = worker ? undefined : 0;
            const s = await window.__install(sc, mode);
            const w0 = window.__trackerWorkers;
            const pressed = window.__cancelAt(at || 0.1, how);
            const t0 = performance.now();
            const r = await fn(s);
            const tDone = performance.now();
            const p = await Promise.race([pressed, Promise.resolve(null)]);
            const status = document.getElementById('statusText').textContent;
            const overlayHidden = document.getElementById('loadingOverlay').classList.contains('hidden');
            const cancelHidden = document.getElementById('loadingCancel').hidden;
            const last = window.__lastGroupFrame(s), groups0 = Array.from(s.instanceGroups.values()).reduce((a, g) => a + g.length, 0);
            const resident = s.frameGroups.size;
            await new Promise(res => setTimeout(res, 600));      // anything still on its way would land now
            const groups1 = Array.from(s.instanceGroups.values()).reduce((a, g) => a + g.length, 0);
            const m = /tracked, (\d[\d,]*)–/.exec(status);
            const firstUntracked = m ? Number(m[1].replace(/,/g, '')) - 1 : null;   // displayed frames are 1-based
            const partial = window.__frames(s, 0, sc.N - 1);
            // the reference: a full run on a fresh session
            window.LUCID_TRACKER_WORKER = worker ? undefined : 0;
            const ref = await window.__install(sc, mode);
            const rr = await fn(ref);
            document.querySelectorAll('.track-summary-modal, .modal-overlay').forEach(e => e.remove());
            const refPrefix = firstUntracked != null ? window.__frames(ref, 0, firstUntracked - 1) : null;
            return { r, rr: { ok: rr && rr.ok }, pressed: p, ms: tDone - (p ? p.t : t0), status, overlayHidden, cancelHidden,
                     last, firstUntracked, groups0, groups1, resident, workers: window.__trackerWorkers - w0,
                     prefixSame: refPrefix != null && partial === refPrefix, refLast: window.__lastGroupFrame(ref) };
        };
    });

    const report = (tag, c) => {
        check(c.pressed && c.pressed.label === 'Cancelling…' && c.pressed.disabled,
              `${tag}: Cancel pressed at ${c.pressed ? Math.round(c.pressed.fraction * 100) : '?'}% → the button reads "Cancelling…", disabled`);
        check(c.r && c.r.ok === false && c.r.cancelled === true && c.ms < 3000,
              `${tag}: the pass resolved cancelled ${c.ms.toFixed(0)} ms after the press`);
        check(c.overlayHidden && c.cancelHidden, `${tag}: the card closed and its Cancel button is gone`);
        check(/cancelled: frames 1–[\d,]+ were tracked, [\d,]+–[\d,]+ are untracked/.test(c.status), `${tag}: status "${c.status.slice(0, 110)}"`);
        check(c.last >= 0 && c.firstUntracked != null && c.last < c.firstUntracked && c.refLast > c.firstUntracked,
              `${tag}: no group past the last tracked frame (last group ${c.last}, first untracked ${c.firstUntracked}, full run to ${c.refLast})`);
        check(c.prefixSame, `${tag}: the frames tracked before Cancel equal a full run's, bit for bit`);
        check(c.groups0 === c.groups1, `${tag}: nothing arrived after the pass returned (${c.groups0.toLocaleString('en-US')} groups)`);
    };

    lap('// ---- lazy (windowed)');
    // ---- lazy (windowed), on the worker and inline; eager, both ways; Esc on one
    const res = await page.evaluate(async () => {
        const sc = await window.__scene(12000, 20261105);
        const scE = await window.__scene(16000, 11);
        return {
            lazyW: await window.__cancelCase(sc, 'lazy', true, 'click', 0.1),
            lazyI: await window.__cancelCase(sc, 'lazy', false, 'click', 0.1),
            eagerW: await window.__cancelCase(scE, 'eager', true, 'click', 0.1),
            eagerI: await window.__cancelCase(scE, 'eager', false, 'esc', 0.1),
        };
    });
    report('lazy, worker', res.lazyW);
    check(res.lazyW.workers === 2, `lazy, worker: ran on the tracker worker (${res.lazyW.workers} started over both runs)`);
    check(res.lazyW.resident <= 2, `lazy, worker: the sweep gave back its windows (${res.lazyW.resident} frames resident after Cancel)`);
    report('lazy, inline', res.lazyI);
    check(res.lazyI.resident <= 2, `lazy, inline: the sweep gave back its windows (${res.lazyI.resident} frames resident)`);
    report('eager, worker', res.eagerW);
    report('eager, inline, Esc', res.eagerI);

    lap('// ---- Track All again');
    // ---- Track All again after a cancelled one == a fresh run
    const again = await page.evaluate(async () => {
        const TR = await import('/pose/tracker.js');
        const sc = await window.__scene(12000, 3);
        window.LUCID_TRACKER_WORKER = undefined;
        const s = await window.__install(sc, 'lazy');
        window.__cancelAt(0.1, 'click');
        const r1 = await TR.trackAll();
        document.querySelectorAll('.track-summary-modal, .modal-overlay').forEach(e => e.remove());
        const r2 = await TR.trackAll();
        document.querySelectorAll('.track-summary-modal, .modal-overlay').forEach(e => e.remove());
        const a = window.__frames(s, 0, sc.N - 1);
        const ref = await window.__install(sc, 'lazy');
        await TR.trackAll();
        document.querySelectorAll('.track-summary-modal, .modal-overlay').forEach(e => e.remove());
        return { c1: r1.cancelled, ok2: r2.ok, same: a === window.__frames(ref, 0, sc.N - 1), names: s.identities.map(i => i.name).join(',') };
    });
    check(again.c1 && again.ok2 && again.same, `Track All after a cancelled one completes and equals a fresh run (identities ${again.names})`);

    lap('// ---- a cancelled range run');
    // ---- a cancelled range run leaves the frames outside the range alone
    const range = await page.evaluate(async () => {
        const TR = await import('/pose/tracker.js');
        const sc = await window.__scene(20000, 99);
        window.LUCID_TRACKER_WORKER = undefined;
        const s = await window.__install(sc, 'lazy');
        await TR.trackAll();
        document.querySelectorAll('.track-summary-modal, .modal-overlay').forEach(e => e.remove());
        const before = window.__frames(s, 0, 999) + '|' + window.__frames(s, 17001, sc.N - 1);
        window.__cancelAt(1e-6, 'click');
        const r = await TR.trackFrameRange(1000, 17000);
        const after = window.__frames(s, 0, 999) + '|' + window.__frames(s, 17001, sc.N - 1);
        const status = document.getElementById('statusText').textContent;
        const m = /tracked, (\d[\d,]*)–/.exec(status);
        const fu = m ? Number(m[1].replace(/,/g, '')) - 1 : null;
        let late = 0; for (let fi = fu; fi <= 17000; fi++) late += (s.instanceGroups.get(fi) || []).length;
        return { cancelled: r.cancelled, same: before === after, status, late, fu };
    });
    check(range.cancelled && range.same && range.late === 0 && range.fu > 1000,
          `a cancelled Track Frame Range leaves frames outside it untouched and none past Cancel tracked ("${range.status.slice(0, 100)}")`);

    lap('check(errs.length === 0');
    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
