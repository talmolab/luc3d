/**
 * track-all-worker.mjs — Track All's tracker on a worker (pose/tracker-pool.js
 * + pose/tracker-worker.js) gives EXACTLY the inline tracker's result.
 *
 * The worker runs the same CrossViewTracker on copies of the same 2D, in the
 * same order, and the main thread commits what it returns through the inline
 * commit (`commitTrackedFrame`). So every identity, per-frame identity entry,
 * group, member and 3D coordinate must be bit-identical to a run with the
 * worker off (`window.LUCID_TRACKER_WORKER = 0`, the inline fallback).
 *
 * The scene is synthetic and deliberately untidy, so association has real
 * decisions to make: 3 animals random-walking through each other in front of 4
 * distorted cameras, per-node dropouts, whole detections missing (targets die
 * and are re-born), false detections, raw track ids that collide, and the
 * per-camera slot order shuffled every frame. Asserted:
 *  1. Windowed lazy Track All, 5,000 frames (three 2,000-frame sweep windows,
 *     so the release lag and the hand-over between windows are exercised):
 *     worker == inline, the worker really ran (one tracker worker started),
 *     and the inline run started none.
 *  2. Eager (non-windowed) Track All with every detection in the UNLINKED pool,
 *     so commit promotes it: worker == inline, including what was promoted.
 *  3. Track Frame Range on the lazy project (the identity-pool path):
 *     worker == inline.
 *  4. Negative control: the same comparison DOES see a difference when ONE
 *     keypoint of one detection is moved by 1e-9 px — so (1)-(3) are not
 *     comparing digests that cannot differ, and a last-bit change in the 3D
 *     would be caught.
 *  5. A worker that fails mid-run fails the pass with an error status — it
 *     does not hang, and the app is left usable.
 *
 * Run: node tests/e2e/track-all-worker.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8291);
let fails = 0;
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
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

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

    const compare = (label, w, i) => {
        let at = -1;
        if (w.text !== i.text) {
            const a = w.text.split('\n'), b = i.text.split('\n');
            at = a.findIndex((l, k) => l !== b[k]);
            if (at < 0) at = Math.min(a.length, b.length);
            console.log('      first difference, line ' + at + ':\n        worker: ' + String(a[at]).slice(0, 160) + '\n        inline: ' + String(b[at]).slice(0, 160));
        }
        return at < 0;
    };

    // ---- 1. windowed lazy Track All
    const lazy = await page.evaluate(async () => {
        const TR = await import('/pose/tracker.js');
        const sc = await window.__scene(5000, 20261012);
        const w = await window.__track(sc, 'lazy', true, () => TR.trackAll());
        const i = await window.__track(sc, 'lazy', false, () => TR.trackAll());
        return { w, i };
    });
    check(lazy.w.ok && lazy.i.ok, `windowed lazy Track All ran both ways (worker ${lazy.w.ms.toFixed(0)} ms, inline ${lazy.i.ms.toFixed(0)} ms; "${lazy.w.status.slice(0, 60)}…")`);
    check(lazy.w.workers === 1 && lazy.i.workers === 0, `…on one tracker worker, and inline on none (${lazy.w.workers} / ${lazy.i.workers})`);
    check(lazy.w.groups > 10000 && lazy.w.identities >= 3, `…with real work to compare: ${lazy.w.groups.toLocaleString('en-US')} groups, ${lazy.w.identities} identities`);
    check(compare('lazy', lazy.w, lazy.i), `worker == inline, bit for bit: identities, per-frame identities, groups, members, 3D (${lazy.w.text.length.toLocaleString('en-US')} chars)`);

    // ---- 2. eager, unlinked pool
    const eager = await page.evaluate(async () => {
        const TR = await import('/pose/tracker.js');
        const sc = await window.__scene(1500, 7);
        const w = await window.__track(sc, 'eager', true, () => TR.trackAll());
        const i = await window.__track(sc, 'eager', false, () => TR.trackAll());
        return { w, i };
    });
    check(eager.w.ok && eager.i.ok && eager.w.workers === 1 && eager.i.workers === 0 && eager.w.groups > 1000,
          `eager Track All ran both ways, on the worker and inline (${eager.w.groups.toLocaleString('en-US')} groups)`);
    check(/ linked cam\d/.test(eager.w.text) && /unlinked cam\d/.test(eager.w.text), '…promoting unlinked detections into groups and leaving the rest unlinked');
    check(compare('eager', eager.w, eager.i), '…worker == inline, bit for bit, including what was promoted');

    // ---- 3. Track Frame Range (identity pool), lazy
    const range = await page.evaluate(async () => {
        const TR = await import('/pose/tracker.js');
        const sc = await window.__scene(5000, 99);
        const run = async () => { const a = await TR.trackAll(); if (!a || !a.ok) return a; return TR.trackFrameRange(1000, 3500); };
        const w = await window.__track(sc, 'lazy', true, run);
        const i = await window.__track(sc, 'lazy', false, run);
        return { w, i };
    });
    check(range.w.ok && range.i.ok && range.w.workers === 2 && range.i.workers === 0,
          `Track All then Track Frame Range ran both ways (workers ${range.w.workers} / ${range.i.workers}; "${range.w.status.slice(0, 70)}…")`);
    check(compare('range', range.w, range.i), '…worker == inline, bit for bit');

    // ---- 4. negative control: one keypoint of one detection nudged by 1e-9 px
    const ctl = await page.evaluate(async () => {
        const TR = await import('/pose/tracker.js');
        const sc = await window.__scene(5000, 20261012);
        const w = await window.__track(sc, 'lazy', true, () => TR.trackAll());
        const obs = sc.obs.slice(), fi = 3210, frame = new Map(obs[fi]);
        const list = frame.get('cam2').slice(), d = list[0], pts = d.points.slice();
        const k = pts.findIndex(p => p);
        pts[k] = [pts[k][0] + 1e-9, pts[k][1]];
        list[0] = Object.assign({}, d, { points: pts });
        frame.set('cam2', list);
        obs[fi] = frame;
        const i = await window.__track(Object.assign({}, sc, { obs }), 'lazy', false, () => TR.trackAll());
        const a = w.text.split('\n'), b = i.text.split('\n');
        return { same: w.text === i.text, lines: a.filter((l, j) => l !== b[j]).length, at: (a.find((l, j) => l !== b[j]) || '').split(' ')[0] };
    });
    check(!ctl.same, `negative control: the comparison sees one keypoint nudged by 1e-9 px (${ctl.lines} line(s) differ, from frame ${ctl.at})`);

    // ---- 5. a worker that fails mid-run
    const fail = await page.evaluate(async () => {
        const TR = await import('/pose/tracker.js');
        const sc = await window.__scene(5000, 5);
        const RealPost = Worker.prototype.postMessage;
        let n = 0;
        Worker.prototype.postMessage = function (m, t) {
            if (m && m.type === 'frames' && ++n === 5) m = { type: 'frames', id: m.id, fis: null };   // the worker throws on this batch
            return RealPost.call(this, m, t);
        };
        try {
            const r = await Promise.race([window.__track(sc, 'lazy', true, () => TR.trackAll()),
                new Promise(res => setTimeout(() => res({ hung: true }), 30000))]);
            return { hung: !!r.hung, ok: r.ok, status: r.status,
                     overlay: document.getElementById('loadingOverlay').classList.contains('hidden') };
        } finally { Worker.prototype.postMessage = RealPost; }
    });
    check(!fail.hung && fail.ok === false && /error: the tracker worker failed/.test(fail.status) && fail.overlay,
          `a worker failing mid-run fails the pass, does not hang, and closes the overlay ("${(fail.status || '').slice(0, 90)}…")`);

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
