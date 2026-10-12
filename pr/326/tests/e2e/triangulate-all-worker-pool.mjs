/**
 * triangulate-all-worker-pool.mjs — Triangulate All solved on the worker pool
 * (pose/triangulation-pool.js + triangulation-worker.js) must produce EXACTLY
 * what the inline solve produces, on every Triangulate All route.
 *
 * The pool runs the same `triangulateAndReproject` (pose/triangulation-core.js)
 * in workers, on inputs captured at submit time, and applies results in
 * submission order. If any of that drifts — a camera matrix rebuilt slightly
 * differently in the worker, a setting resolved differently, an option dropped,
 * results applied out of order, a lazy window released before its inputs were
 * captured — 3D, errors, methods or per-frame results would differ. So each
 * route runs twice on an identical synthetic project (4 distorted cameras, 2
 * animals, 600 frames, missing nodes, nulled nodes, an excluded camera, a
 * reprojection-error threshold): once inline (LUCID_TRIANGULATION_WORKERS = 0)
 * and once on a forced 4-worker pool, and the two outputs must hash identically
 * (exact f64 bits).
 *
 *   1. triangulateAllFrames('ba')  — resident (eager) path, keeps reprojections
 *   2. triangulateAllFrames('ba')  — windowed lazy path: windows are released
 *                                     while their solves are still in flight
 *   3. groupByIdentityAndTriangulateAll('dlt') — the Triangulate All ▸ DLT route
 *
 * Also asserted: the pool really solved batches on workers for each route, the
 * results are non-trivial (3D present), and a control run WITHOUT the threshold
 * and camera exclusion hashes differently — so a worker ignoring either setting
 * could not pass.
 *
 * Run: node tests/e2e/triangulate-all-worker-pool.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8146);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrs = [];
    page.on('pageerror', e => pageErrs.push(String(e).slice(0, 300)));
    page.on('dialog', d => d.accept());
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const r = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const tri = await import('/pose/triangulation.js');
        const em = await import('/ui/export-modals.js');
        const settings = await import('/ui/settings.js');
        const AS = await import('/ui/app-state.js');
        const state = AS.state;

        // Count batches actually posted to triangulation workers, to prove the
        // pool really ran for each route (its workers persist between runs, so
        // counting constructions would not).
        let solveMsgs = 0;
        const RealWorker = window.Worker;
        window.Worker = function (url, opts) {
            const w = new RealWorker(url, opts);
            if (String(url).includes('triangulation-worker.js')) {
                const post = w.postMessage.bind(w);
                w.postMessage = (m, t) => { if (m && m.type === 'solve') solveMsgs++; return post(m, t); };
            }
            return w;
        };

        const NF = 600, NODES = 6, CAMS = ['camA', 'camB', 'camC', 'camD'];
        function build(lazy) {
            let seed = 4242;
            const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
            const cams = CAMS.map((n, i) => new pd.Camera(n,
                [[900 + 40 * i, 0, 640], [0, 905 + 40 * i, 512], [0, 0, 1]],
                [-0.2 + 0.05 * i, 0.05, 0.001, -0.001, 0.01],
                [0.15 * i - 0.2, 0.3 - 0.2 * i, 0.05 * i], [60 * i - 90, 20 * i - 30, 1100 + 50 * i], [1280, 1024]));
            const sk = new pd.Skeleton('sk', Array.from({ length: NODES }, (_, k) => 'n' + k),
                Array.from({ length: NODES - 1 }, (_, k) => [k, k + 1]));
            const s = new pd.Session(cams, sk, ['t0', 't1'], 'pool-test');
            for (let f = 0; f < NF; f++) {
                const fg = new pd.FrameGroup(f);
                s.addFrameGroup(fg);
                const groups = [];
                for (let a = 0; a < 2; a++) {
                    const base = [Math.sin(f / 40 + a) * 150, Math.cos(f / 55 + a) * 120, 80 * a];
                    const g = new pd.InstanceGroup(f * 2 + a, -1);
                    cams.forEach((cam, ci) => {
                        const pts = [];
                        for (let k = 0; k < NODES; k++) {
                            const P = [base[0] + 15 * k, base[1] - 8 * k, base[2] + 5 * k];
                            const d = cam.distortPoint(cam.project(P));
                            // Missing nodes, and one gross outlier per few frames.
                            if (rnd() < 0.08) { pts.push(null); continue; }
                            const out = (ci === 2 && k === 3 && f % 7 === 0) ? 60 : 0;
                            pts.push([d[0] + (rnd() - 0.5) * 3 + out, d[1] + (rnd() - 0.5) * 3]);
                        }
                        const inst = new pd.Instance(pts, a, 'predicted', 0.9);
                        if (f % 11 === 0 && ci === 1) inst.nulledNodes = new Set([2]);
                        fg.addInstance(cam.name, inst);
                        g.addInstance(cam.name, inst);
                    });
                    groups.push(g);
                }
                s.instanceGroups.set(f, groups);
            }
            if (lazy) {
                // A windowing lazy loader whose frames are already resident: the
                // sweep releases each window after onFrame, while its solves may
                // still be in flight on the pool.
                s.lazyLoader = { isSync: true, nFrames: NF, getFrameSync() { return null; }, releaseWindow() {} };
            }
            return s;
        }
        function identities(s) {
            for (let a = 0; a < 2; a++) {
                const id = s.getOrCreateIdentityForTrack(a);
                for (let f = 0; f < NF; f++) for (const c of CAMS) s.setFrameIdentity(f, c, a, id.id);
            }
        }

        // Deterministic hash of everything the operation produced.
        function digest(s) {
            let h1 = 0x811c9dc5 >>> 0, h2 = 0x01000193 >>> 0;
            const f64 = new Float64Array(1), u8 = new Uint8Array(f64.buffer);
            const num = (v) => { f64[0] = v; for (let i = 0; i < 8; i++) { h1 = Math.imul(h1 ^ u8[i], 16777619) >>> 0; h2 = Math.imul(h2 ^ u8[i], 2246822519) >>> 0; } };
            const str = (t) => { num(t.length); for (let i = 0; i < t.length; i++) num(t.charCodeAt(i)); };
            const seen = new WeakSet();
            const cmp = (a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a) < String(b) ? -1 : 1;
            const walk = (v) => {
                if (v === null) return str('null');
                if (v === undefined) return str('undef');
                const t = typeof v;
                if (t === 'number') { str('n'); return num(v); }
                if (t === 'string') return str('s' + v);
                if (t === 'boolean') return str(v ? 'T' : 'F');
                if (t === 'function' || seen.has(v)) return;
                seen.add(v);
                if (ArrayBuffer.isView(v)) { str('ta'); for (let i = 0; i < v.length; i++) num(v[i]); }
                else if (Array.isArray(v)) { str('a' + v.length); v.forEach(walk); }
                else if (v instanceof Map) { const ks = [...v.keys()].sort(cmp); str('m' + ks.length); for (const k of ks) { walk(k); walk(v.get(k)); } }
                else if (v instanceof Set) { const ks = [...v].sort(cmp); str('set' + ks.length); ks.forEach(walk); }
                else { for (const k of Object.keys(v).sort()) { str(k); walk(v[k]); } }
                seen.delete(v);
            };
            let groups3d = 0;
            for (const [, gs] of s.instanceGroups) for (const g of gs) if (g.points3d && g.points3d.length) groups3d++;
            walk(s.instanceGroups); walk(state.triangulationResults);
            return { hash: h1.toString(16) + h2.toString(16), groups3d };
        }

        async function run(workers, route) {
            window.LUCID_TRIANGULATION_WORKERS = workers;
            const s = build(route === 'windowed');
            if (route === 'dlt') identities(s);
            state.sessions = [s]; state.activeSessionIdx = 0; state.session = s;
            state.triangulationResults = new Map();
            const before = solveMsgs;
            if (route === 'dlt') await em.groupByIdentityAndTriangulateAll('dlt');
            else await tri.triangulateAllFrames('ba');
            return { ...digest(s), batches: solveMsgs - before, status: document.getElementById('statusText').textContent };
        }

        // A reprojection-error threshold and an excluded camera: both are
        // settings the pool resolves on the main thread and ships to workers.
        const prevThr = settings.getTrackingThresholds();
        const prevW = settings.getCameraWeights();
        settings.setTrackingThresholds({ ...prevThr, reprojErrorThreshold: 12 });
        settings.setCameraWeights({ ...prevW, camD: 0 });
        const applied = { thr: settings.getTrackingThreshold('reprojErrorThreshold'), camD: settings.isCameraTracked('camD') };

        const out = {};
        for (const route of ['eager', 'windowed', 'dlt']) {
            const inline = await run(0, route);
            const pooled = await run(4, route);
            out[route] = { inline, pooled };
        }
        out.applied = applied;
        settings.setTrackingThresholds(prevThr);
        settings.setCameraWeights(prevW);
        // Control: without the threshold / exclusion the output must DIFFER —
        // otherwise a worker that ignored those settings would still pass.
        out.control = await run(0, 'eager');
        window.Worker = RealWorker;
        return out;
    });

    for (const route of ['eager', 'windowed', 'dlt']) {
        const { inline, pooled } = r[route];
        console.log(`  ${route}: inline ${inline.hash} (${inline.groups3d} groups with 3D) vs pool ${pooled.hash}; ` +
            `${pooled.batches} batches solved on workers`);
        check(inline.groups3d > 1000, `${route}: inline run produced 3D (${inline.groups3d} groups)`);
        check(inline.batches === 0, `${route}: LUCID_TRIANGULATION_WORKERS=0 solved inline (no batch sent to a worker)`);
        check(pooled.batches >= 3, `${route}: the forced pool really solved on workers (${pooled.batches} batches)`);
        check(inline.hash === pooled.hash, `${route}: pool output is bit-identical to inline`);
        check(/^(Triangulated|Grouped) /.test(pooled.status) && /^(Triangulated|Grouped) /.test(inline.status),
            `${route}: both runs report success ("${pooled.status.slice(0, 90)}")`);
    }
    check(r.control.hash !== r.eager.inline.hash,
        `the threshold + excluded camera really change the result (control ${r.control.hash}), so ignoring them would be caught`);
    check(r.applied.thr === 12 && r.applied.camD === false,
        `settings the pool must resolve were in effect: threshold ${r.applied.thr} px, camD excluded=${!r.applied.camD}`);
    check(pageErrs.length === 0, `no page errors (${pageErrs.join(' | ')})`);
    await browser.close();
} finally {
    server.kill();
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
