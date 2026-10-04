/**
 * track-auto-size-switch-check.mjs — the body-size ID-switch check runs on its
 * own after Track All and after Track Frame Range (pose/tracker.js ->
 * ui/size-switch-modal.js `runSizeSwitchCheck({auto:true})`), in the real app.
 *
 * Fixture A (tracked by the REAL tracker): two mouse-shaped animals of different
 * size seen by three calibrated cameras for 65 s at 30 fps, kept apart, so the
 * tracker makes no switch. Asserted:
 *  1. Track All clears stale switch markers, runs the check, and appends its
 *     result to Track All's own status line — with no dialog when nothing is found.
 *  2. Track Frame Range runs it too, over the WHOLE session's identities: after
 *     Track All a 10 s window is checked against the full 65 s; on a fresh
 *     session the window alone is too little tracking, so the status says it was
 *     skipped and why — the range itself still succeeds.
 *  3. With the Tracking Wizard's `autoSwitchCheck` off, neither runs it.
 * Fixture B (labels swapped after one encounter, as in tests/e2e/size-switch-check.mjs):
 *  4. The automatic path opens the dialog when a switch IS found, its status
 *     carries the tracking pass's message, and rows navigate through the
 *     navigator ui-wiring registered (no navigateToFrame passed in).
 *
 * Run: node tests/e2e/track-auto-size-switch-check.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8273);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('dialog', d => d.accept('2'));   // Track All asks for the animal count
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // Fixture A builder: real 2D detections in 3 cameras, to be tracked by the real tracker.
    await page.evaluate(() => {
        window.__buildTrackable = async (name) => {
            const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
            const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
                'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
            const T = { Nose: [45, 0, 0], Ear_R: [25, -11, 4], Ear_L: [25, 11, 4], Head: [30, 0, 3], Neck: [20, 0, 2],
                Trunk: [-5, 0, 4], TTI: [-40, 0, 0], Shoulder_left: [10, 12, 0], Shoulder_right: [10, -12, 0],
                Haunch_left: [-25, 15, 0], Haunch_right: [-25, -15, 0], Tail_0: [-65, 0, 0], Tail_1: [-88, 0, 0],
                Tail_2: [-110, 0, 0], TailTip: [-132, 0, 0] };
            const cam = (n, rvec, tvec) => new pd.Camera(n, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
            const CAMS = [cam('c0', [0, 0, 0], [0, 0, 0]), cam('c1', [0, 0.35, 0], [-12, 0, 3]), cam('c2', [0.35, 0, 0], [0, -12, 3])];
            const s = new pd.Session(CAMS, new pd.Skeleton('mouse', NODES, []), ['track_0', 'track_1'], name);
            const FRAMES = 65 * 30, SC = [0.05, 0.06];   // template mm -> rig units; animal 1 is 20% bigger
            for (let f = 0; f < FRAMES; f++) {
                const fg = new pd.FrameGroup(f);
                [[-8, 0, 48], [8, 0, 48]].forEach((c0, ai) => {
                    const ctr = [c0[0] + 0.6 * Math.sin(f / 90 + ai), c0[1] + 0.6 * Math.cos(f / 70 + ai), c0[2]];
                    const h = f / 200 + ai * 2, ch = Math.cos(h), sh = Math.sin(h);
                    const pts3 = NODES.map(n => { const [x, y, z] = T[n].map(v => v * SC[ai]); return [ctr[0] + ch * x - sh * y, ctr[1] + sh * x + ch * y, ctr[2] + z]; });
                    CAMS.forEach(c => fg.addInstance(c.name, new pd.Instance(pts3.map(p => c.project(p)), ai, 'predicted', 1.0)));
                });
                s.addFrameGroup(fg);
            }
            AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
            AS.state.totalFrames = FRAMES; AS.state.currentFrame = 0; AS.state.views = []; AS.state.fps = 30;
            if (AS.timeline) { AS.timeline.setTotalFrames(FRAMES); AS.timeline.setData(s); }
            return FRAMES;
        };
    });
    const statusText = () => page.evaluate(() => document.getElementById('statusText').textContent);
    const modalOpen = () => page.evaluate(() => !!document.querySelector('.size-switch-modal'));

    // ---- 1. Track All
    await page.evaluate(async () => {
        await window.__buildTrackable('A');
        const AS = await import('/ui/app-state.js');
        AS.timeline.setSwitchMarkers([{ frame: 100, nameA: 'x', nameB: 'y', score: -99 }]);   // stale, from "an earlier run"
        const tr = await import('/pose/tracker.js'); tr.setTrackerNumAnimals(2);
        await tr.trackAll();
    });
    let st = await statusText();
    const markersA = await page.evaluate(async () => (await import('/ui/app-state.js')).timeline.getSwitchMarkers().length);
    check(/^Assigned 2 identities/.test(st) && /ID-switch check \(body size\): no possible switches/.test(st),
        `Track All: check ran, result appended to its status ("${st}")`);
    check(markersA === 0, 'Track All: the stale marker from before was cleared');
    check(!(await modalOpen()), 'Track All: no dialog when nothing is found');

    // ---- 2a. Track Frame Range on the session Track All just tracked: the check covers the WHOLE
    //          session (65 s), so it runs even though the window itself is only 10 s
    await page.evaluate(async () => { const tr = await import('/pose/tracker.js'); await tr.trackFrameRange(600, 899); });
    st = await statusText();
    check(/\(601–900\)/.test(st) && /ID-switch check \(body size\): no possible switches/.test(st),
        `Track Frame Range after Track All: check ran over the whole session ("${st}")`);

    // ---- 2b. Track Frame Range on a fresh session: 10 s of tracking -> skipped, range still succeeds
    const rr = await page.evaluate(async () => {
        await window.__buildTrackable('B');
        const tr = await import('/pose/tracker.js'); tr.setTrackerNumAnimals(2);
        return await tr.trackFrameRange(0, 299);
    });
    st = await statusText();
    check(rr && rr.ok, 'Track Frame Range: the range run succeeded');
    check(/^Assigned 2 identities .*\(1–300\)/.test(st) && /ID-switch check \(body size\): skipped — needs at least 60 s of tracking/.test(st),
        `Track Frame Range: check ran and reports why it was skipped ("${st}")`);

    // ---- 3. setting off: neither pass runs it
    await page.evaluate(async () => {
        const S = await import('/ui/settings.js');
        S.setTrackingThresholds(Object.assign(S.getTrackingThresholds(), { autoSwitchCheck: 0 }));
        await window.__buildTrackable('C');
        const tr = await import('/pose/tracker.js'); tr.setTrackerNumAnimals(2);
        await tr.trackAll();
        window.__stAll = document.getElementById('statusText').textContent;
        await tr.trackFrameRange(0, 299);
        window.__stRange = document.getElementById('statusText').textContent;
        S.setTrackingThresholds(Object.assign(S.getTrackingThresholds(), { autoSwitchCheck: 1 }));
    });
    const off = await page.evaluate(() => [window.__stAll, window.__stRange]);
    check(off.every(t => /^Assigned/.test(t) && !/ID-switch check/.test(t)), `setting off: neither Track All nor the range ran it (${JSON.stringify(off)})`);

    // ---- 4. automatic path with a switch: dialog opens, rows navigate via the registered navigator
    const fx = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
        const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
            'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
        const TEMPLATE = { Nose: [45, 0, 0], Ear_R: [25, -11, 4], Ear_L: [25, 11, 4], Head: [30, 0, 3], Neck: [20, 0, 2],
            Trunk: [-5, 0, 4], TTI: [-40, 0, 0], Shoulder_left: [10, 12, 0], Shoulder_right: [10, -12, 0],
            Haunch_left: [-25, 15, 0], Haunch_right: [-25, -15, 0], Tail_0: [-65, 0, 0], Tail_1: [-88, 0, 0],
            Tail_2: [-110, 0, 0], TailTip: [-132, 0, 0] };
        const SCALES = [1.0, 1.15, 0.85], STEP = 4, SWAP = 16;
        let seed = 7; const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
        const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
        const pose = (sc, cx, cy, h) => { const out = new Float64Array(45), c = Math.cos(h), s = Math.sin(h);
            NODES.forEach((n, i) => { const [x, y, z] = TEMPLATE[n]; out[i * 3] = cx + sc * (c * x - s * y) + 1.5 * gauss();
                out[i * 3 + 1] = cy + sc * (s * x + c * y) + 1.5 * gauss(); out[i * 3 + 2] = sc * z + 1.5 * gauss(); }); return out; };
        const home = [[0, 0], [400, 0], [200, 350]], PAIRS = [[0, 1], [1, 2], [0, 2]];
        const events = []; for (let e = 0; e < 24; e++) events.push({ pair: PAIRS[e % 3], t0: 300 + e * 260 });
        const T = 300 + 24 * 260 + 300;
        const session = new pd.Session([], new pd.Skeleton('m', NODES, []), [], 'Swapped');
        for (let i = 0; i < 3; i++) session.addIdentity('id_' + i);
        let gid = 1; const label = [0, 1, 2]; let swapFrame = null;
        for (let t = 0; t < T; t++) {
            const pos = home.map(h => [h[0] + 15 * Math.sin(t / 37 + h[0]), h[1] + 15 * Math.cos(t / 41 + h[1])]);
            for (const ev of events) { const d = t - ev.t0; if (d < 0 || d > 100) continue;
                const [a, b] = ev.pair, mid = [(home[a][0] + home[b][0]) / 2, (home[a][1] + home[b][1]) / 2];
                const f = d < 40 ? d / 40 : d <= 60 ? 1 : 1 - (d - 60) / 40;
                for (const [k, side] of [[a, -1], [b, 1]]) pos[k] = [home[k][0] + f * (mid[0] + side * 10 - home[k][0]), home[k][1] + f * (mid[1] - home[k][1])]; }
            session.instanceGroups.set(t * STEP, [0, 1, 2].map(k => { const g = new pd.InstanceGroup(gid++, session.identities[label[k]].id);
                g.points3d = pose(SCALES[k], pos[k][0], pos[k][1], (t / 50 + k) % (2 * Math.PI)); return g; }));
            if (t === events[SWAP].t0 + 60) { const [a, b] = events[SWAP].pair; [label[a], label[b]] = [label[b], label[a]]; swapFrame = t * STEP; }
        }
        AS.state.sessions = [session]; AS.state.activeSessionIdx = 0; AS.state.session = session;
        AS.state.totalFrames = T * STEP; AS.state.currentFrame = 0; AS.state.fps = 60;
        if (AS.timeline) { AS.timeline.setTotalFrames(T * STEP); AS.timeline.setData(session); }
        const M = await import('/ui/id-switch-modal.js');
        await M.runSizeSwitchCheck({ auto: true, statusPrefix: 'Assigned 3 identities across 27360 frames' });
        return { swapFrame };
    });
    st = await statusText();
    check(await modalOpen(), 'automatic path: the dialog opens when a switch is found');
    check(/^Assigned 3 identities across 27360 frames · ID-switch check \(body size\): 1 possible switch/.test(st), `automatic path: status keeps the pass's message ("${st}")`);
    const rowFrame = await page.evaluate(() => +document.querySelector('.size-switch-row').dataset.frame);
    await page.click('.size-switch-row');
    await page.waitForFunction(f => window.__lucid.state.currentFrame === f, rowFrame, { timeout: 10000 }).catch(() => {});
    const cur = await page.evaluate(() => window.__lucid.state.currentFrame);
    check(Math.abs(rowFrame - fx.swapFrame) <= 40 && cur === rowFrame, `row at the switch (${rowFrame} vs ${fx.swapFrame}) navigates via the registered navigator (now ${cur})`);
    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
