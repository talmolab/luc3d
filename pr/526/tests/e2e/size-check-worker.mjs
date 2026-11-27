/**
 * size-check-worker.mjs — the body-size ID-switch check scores on a worker
 * (pose/size-check-pool.js, pose/size-check-worker.js), with the result it
 * gets in the page.
 *
 * A synthetic 3-animal recording (456 s at 60 fps, 24 encounters, two of them
 * followed by a label swap — the Node test's scenario) is installed as the
 * active session, then:
 *
 * §1  Scored on the worker, the result is the in-page result, value for value;
 *     and the app's size check (`runSizeSwitchCheck` → `runSize`) uses the
 *     worker, with the same contacts, scores and flags (the app then adds its
 *     own fields, e.g. `elapsedMs`).
 * §2  `window.LUCID_SIZE_CHECK_WORKER = 0` scores in the page.
 * §3  A worker that cannot start (the constructor throws) or that fails as it
 *     loads: scored in the page, same result.
 * §4  An abort while the worker scores rejects with AbortError.
 *
 * Run: node tests/e2e/size-check-worker.mjs
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const server = await startServer(repoRoot);
const PORT = server.port;

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

let browser;
try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    // The Node test's synthetic recording (tests/test-id-switch-check.mjs buildSession), as the active session.
    await page.evaluate(async () => {
        const url = (p) => new URL(p, document.baseURI).href;
        const PD = await import(url('pose/pose-data.js'));
        const AS = await import(url('ui/app-state.js'));
        const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
            'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
        const TEMPLATE = { Nose: [45, 0, 0], Ear_R: [25, -11, 4], Ear_L: [25, 11, 4], Head: [30, 0, 3], Neck: [20, 0, 2],
            Trunk: [-5, 0, 4], TTI: [-40, 0, 0], Shoulder_left: [10, 12, 0], Shoulder_right: [10, -12, 0],
            Haunch_left: [-25, 15, 0], Haunch_right: [-25, -15, 0], Tail_0: [-65, 0, 0], Tail_1: [-88, 0, 0], Tail_2: [-110, 0, 0], TailTip: [-132, 0, 0] };
        const SCALES = [1.0, 1.15, 0.85];
        let s0 = 7 >>> 0; const r = () => ((s0 = (s0 * 1664525 + 1013904223) >>> 0) / 4294967296);
        const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
        const pose = (scale, cx, cy, heading) => {
            const out = new Float64Array(NODES.length * 3), c = Math.cos(heading), s = Math.sin(heading);
            NODES.forEach((n, i) => { const [x, y, z] = TEMPLATE[n];
                out[i * 3] = cx + scale * (c * x - s * y) + 1.5 * gauss(); out[i * 3 + 1] = cy + scale * (s * x + c * y) + 1.5 * gauss(); out[i * 3 + 2] = scale * z + 1.5 * gauss(); });
            return out;
        };
        const fps = 60, home = [[0, 0], [400, 0], [200, 350]], PAIRS = [[0, 1], [1, 2], [0, 2]], events = [];
        for (let e = 0; e < 24; e++) events.push({ pair: PAIRS[e % 3], t0: 300 + e * 260 });
        const U = 300 + 24 * 260 + 300, nFrames = Math.floor(U / 15 * fps);
        const session = new PD.Session([], new PD.Skeleton('m', NODES, []), [], 'size-check-worker');
        for (let i = 0; i < 3; i++) session.addIdentity('id_' + i);
        const swaps = [3, 10].map(e => ({ u: events[e].t0 + 60, pair: events[e].pair }));
        let gid = 1;
        for (let f = 0; f < nFrames; f++) {
            const u = f * 15 / fps;
            const pos = home.map(h => [h[0] + 15 * Math.sin(u / 37 + h[0]), h[1] + 15 * Math.cos(u / 41 + h[1])]);
            for (const ev of events) {
                const d = u - ev.t0; if (d < 0 || d > 100) continue;
                const [a, b] = ev.pair, mid = [(home[a][0] + home[b][0]) / 2, (home[a][1] + home[b][1]) / 2];
                const w = d < 40 ? d / 40 : d <= 60 ? 1 : 1 - (d - 60) / 40;
                for (const [k, side] of [[a, -1], [b, 1]]) { const t = [mid[0] + side * 10, mid[1]]; pos[k] = [home[k][0] + w * (t[0] - home[k][0]), home[k][1] + w * (t[1] - home[k][1])]; }
            }
            const label = [0, 1, 2];
            for (const sw of swaps) if (u >= sw.u) { const [a, b] = sw.pair; [label[a], label[b]] = [label[b], label[a]]; }
            session.instanceGroups.set(f, [0, 1, 2].map(k => { const g = new PD.InstanceGroup(gid++, session.identities[label[k]].id); g.points3d = pose(SCALES[k], pos[k][0], pos[k][1], (u / 50 + k) % (2 * Math.PI)); return g; }));
        }
        AS.state.sessions = [session]; AS.state.activeSessionIdx = 0; AS.state.session = session;
        AS.state.fps = fps; AS.state.totalFrames = nFrames; AS.state.currentFrame = 0;
        window.__SC = await import(url('pose/id-switch-check.js'));
        window.__POOL = await import(url('pose/size-check-pool.js'));
        window.__MODAL = await import(url('ui/id-switch-modal.js'));
        window.__here = JSON.stringify(await window.__SC.checkSizeSwitches(session, { fps }));
    });
    const here = await page.evaluate(() => JSON.parse(window.__here));
    check(here.ok && here.encounters.length > 0 && here.flags.length > 0,
        `precondition: scored in the page, ${here.encounters.length} contacts, ${here.flags.length} flags`);
    const runs = () => page.evaluate(() => Object.assign({}, window.__POOL.sizeCheckRuns));

    const viaPool = (setup) => page.evaluate(async (setup) => {
        const SC = window.__SC, POOL = window.__POOL, s = window.__lucid.state.session;
        const OrigWorker = window.Worker;
        if (setup === 'off') window.LUCID_SIZE_CHECK_WORKER = 0;
        if (setup === 'throws') window.Worker = function () { throw new Error('no workers here'); };
        if (setup === 'fails') window.Worker = function () { return new OrigWorker(URL.createObjectURL(new Blob(['throw new Error("boom")'], { type: 'text/javascript' }))); };
        try { return JSON.stringify(await SC.checkSizeSwitches(s, { fps: 60, scoreGrid: POOL.scoreSizeGridOffThread })); }
        finally { window.Worker = OrigWorker; delete window.LUCID_SIZE_CHECK_WORKER; }
    }, setup);

    console.log('\n§1 scored on the worker: the in-page result; the app uses the worker');
    let r0 = await runs();
    const onWorker = await viaPool('worker');
    let r1 = await runs();
    check(r1.worker === r0.worker + 1 && r1.fellBack === r0.fellBack && r1.inPage === r0.inPage, `the worker scored it (${JSON.stringify(r1)})`);
    check(onWorker === await page.evaluate(() => window.__here), 'its result is the in-page result, value for value');
    r0 = await runs();
    const viaApp = await page.evaluate(async () => {
        const res = await window.__MODAL.runSizeSwitchCheck({});
        const pick = (r) => JSON.stringify(r.encounters.map(e => [e.frame, e.startFrame, e.identityA, e.identityB, e.score, !!e.flagged]));
        return { app: pick(res.size), here: pick(JSON.parse(window.__here)), flags: [res.size.flags.length, JSON.parse(window.__here).flags.length] };
    });
    r1 = await runs();
    check(r1.worker === r0.worker + 1 && r1.fellBack === r0.fellBack && r1.inPage === r0.inPage, `the app's size check scored on the worker (${JSON.stringify(r1)})`);
    check(viaApp.app === viaApp.here && viaApp.flags[0] === viaApp.flags[1], `with the in-page contacts, scores and flags (${viaApp.flags[0]} flags)`);

    console.log('\n§2 the kill switch scores in the page');
    r0 = await runs();
    const off = await viaPool('off');
    r1 = await runs();
    check(r1.inPage === r0.inPage + 1 && r1.worker === r0.worker, `LUCID_SIZE_CHECK_WORKER = 0: in the page (${JSON.stringify(r1)})`);
    check(off === await page.evaluate(() => window.__here), 'same result');

    console.log('\n§3 a worker that cannot help: scored in the page');
    for (const how of ['throws', 'fails']) {
        r0 = await runs();
        const res = await viaPool(how);
        r1 = await runs();
        check(r1.fellBack === r0.fellBack + 1 && r1.worker === r0.worker, `${how === 'throws' ? 'the Worker constructor throws' : 'the worker fails as it loads'}: in the page (${JSON.stringify(r1)})`);
        check(res === await page.evaluate(() => window.__here), 'same result');
    }

    console.log('\n§4 an abort stops it');
    const aborted = await page.evaluate(async () => {
        const ctl = new AbortController(), s = window.__lucid.state.session;
        const p = window.__SC.checkSizeSwitches(s, { fps: 60, signal: ctl.signal, scoreGrid: window.__POOL.scoreSizeGridOffThread });
        setTimeout(() => ctl.abort(), 0);
        try { await p; return 'resolved'; } catch (e) { return e.name; }
    });
    check(aborted === 'AbortError', `rejects with AbortError (${aborted})`);
    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
