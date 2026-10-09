/**
 * status-counters-eager.mjs — the status bar's Labeled Frames / Instances /
 * Triangulated on an EAGER project, in the real app.
 *
 * On an eager project every frame is resident, and `updateFrameCounters` used
 * to count by walking every FrameGroup — on EVERY redraw, so on every frame
 * step: ~10 ms of each ~18 ms step on a 36,000-frame x 17-camera project. It
 * now counts from a per-frame baseline and re-counts only the drawn frame into
 * it (`refreshCountedFrame`, ui/frame-counters.js). Being O(1) is only worth it
 * if the numbers stay right, so this drives the real `updateFrameCounters`
 * (ui/rendering.js) and checks the status-bar TEXT against a full count after:
 *
 *  1. load — and that 60 frame steps afterwards iterate the frames ZERO times;
 *  2. an edit to the frame on screen (shows at once, survives navigating away);
 *  3. an edit touching two cameras at once, one of them not the active view;
 *  4. a bulk change to frames NOT on screen, followed by the same-frame redraw
 *     every such operation ends with (the background rebuild must catch it);
 *  5. a switch of the active camera.
 *
 * Run: node status-counters-eager.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8198);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // An eager session: 3 cameras, 3,000 frames, a mix of user / predicted,
    // grouped / unlinked instances, and 3D on some groups.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Session, FrameGroup, Instance, InstanceGroup } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = ['camA', 'camB', 'camC'].map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [640, 480]));
        const s = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0'], 'S1');
        const inst = (type) => new Instance([[10, 10], [20, 20]], 0, type, 1);
        let gid = 1;
        for (let f = 0; f < 3000; f++) {
            if (f % 9 === 0) continue;                              // unlabeled frame
            const fg = new FrameGroup(f);
            s.addFrameGroup(fg);
            if (f % 3 === 0) {                                      // a grouped instance across cameras
                const g = new InstanceGroup(gid++, 0);
                for (const c of cams) {
                    const it = inst(f % 2 ? 'predicted' : 'user');
                    g.addInstance(c.name, it);
                    fg.addInstance(c.name, it);
                }
                if (f % 6 === 0) g.points3d = new Float64Array(6).fill(f);
                s.instanceGroups.set(f, [g]);
            }
            for (const c of cams) {                                 // ungrouped ones
                if ((f + c.name.length) % 4 === 0) s.addUnlinkedInstance(f, c.name, inst('user'));
                if ((f + c.name.length) % 5 === 0) s.addUnlinkedInstance(f, c.name, inst('predicted'));
            }
        }
        AS.state.sessions = [s];
        AS.state.session = s;
        AS.state.activeSessionIdx = 0;
        AS.state.totalFrames = 3000;
        AS.state.currentFrame = 100;
        AS.state.views = cams.map(c => ({ name: c.name, videoWidth: 640, videoHeight: 480, canvas: null }));
        if (AS.interactionManager) AS.interactionManager.lastInteractedView = 'camA';

        // The oracle: a full count, the way the status bar defines it.
        const FC = await import('/ui/frame-counters.js');
        window.__truth = (cam) => {
            const c = FC.countFrameCounters(s, cam, null);
            let tri = 0;
            for (const [, gs] of s.instanceGroups) if (gs.some(g => g.points3d)) tri++;
            return { labeled: c.labeled, instances: c.instances, triangulated: tri };
        };
        window.__shown = () => {
            const num = (id) => {
                const m = /(\d+)\s*$/.exec((document.getElementById(id) || {}).textContent || '');
                return m ? Number(m[1]) : null;
            };
            return { labeled: num('statusLabeledFrames'), instances: num('statusInstances'), triangulated: num('statusTriangulatedFrames') };
        };
        // Count walks of the frames: the old per-step count iterated frameGroups.
        window.__walks = 0;
        const fgs = s.frameGroups;
        const realForEach = fgs.forEach.bind(fgs), realEntries = fgs.entries.bind(fgs);
        fgs.forEach = (fn, t) => { window.__walks++; return realForEach(fn, t); };
        fgs.entries = () => { window.__walks++; return realEntries(); };
    });

    const update = (frame) => page.evaluate(async (frame) => {
        const AS = await import('/ui/app-state.js');
        const R = await import('/ui/rendering.js');
        if (frame != null) AS.state.currentFrame = frame;
        R.updateFrameCounters();
    }, frame);
    const shownVsTruth = (cam) => page.evaluate((cam) => ({ shown: window.__shown(), truth: window.__truth(cam) }), cam);
    const same = (r) => JSON.stringify(r.shown) === JSON.stringify(r.truth);
    const settle = () => page.evaluate(() => new Promise(r => setTimeout(r, 800)));   // > the 250 ms rebuild delay + slices

    // =================================================================
    // 1 — load, then 60 frame steps with no walk
    // =================================================================
    await update(100);
    let r = await shownVsTruth('camA');
    check(same(r), `after load the status bar shows the full count (${JSON.stringify(r.shown)} vs ${JSON.stringify(r.truth)})`);
    await page.evaluate(() => { window.__walks = 0; });
    for (let f = 101; f <= 160; f++) await update(f);
    const walks = await page.evaluate(() => window.__walks);
    check(walks === 0, `60 frame steps iterated the frames ${walks} times (expected 0)`);
    r = await shownVsTruth('camA');
    check(same(r), `after stepping: still the full count (${JSON.stringify(r.shown)})`);

    // =================================================================
    // 2 — an edit to the frame on screen
    // =================================================================
    const before = r.shown;
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        AS.state.session.addUnlinkedInstance(AS.state.currentFrame, 'camA', new pd.Instance([[1, 1], [2, 2]], 0, 'user', 1));
    });
    await update(null);                                             // the redraw after the edit
    r = await shownVsTruth('camA');
    check(same(r) && r.shown.instances === before.instances + 1,
        `an edit on the drawn frame shows at once (Instances ${before.instances} -> ${r.shown.instances})`);
    for (let f = 161; f <= 170; f++) await update(f);               // navigate away
    await settle();
    r = await shownVsTruth('camA');
    check(same(r), `after navigating away (and any rebuild) the edit is still counted (${JSON.stringify(r.shown)})`);

    // =================================================================
    // 3 — one edit, two cameras (the active one and another)
    // =================================================================
    await update(301);                                               // an unlabeled-for-camB-ish frame
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const s = AS.state.session, f = AS.state.currentFrame;
        s.addUnlinkedInstance(f, 'camA', new pd.Instance([[1, 1], [2, 2]], 0, 'user', 1));
        s.addUnlinkedInstance(f, 'camB', new pd.Instance([[1, 1], [2, 2]], 0, 'user', 1));
    });
    await update(null);
    r = await shownVsTruth('camA');
    check(same(r), `two-camera edit: camA (active) exact (${JSON.stringify(r.shown)})`);
    await page.evaluate(async () => { const AS = await import('/ui/app-state.js'); AS.interactionManager.lastInteractedView = 'camB'; });
    await update(302);
    r = await shownVsTruth('camB');
    check(same(r), `two-camera edit: camB, made active on the next frame, exact (${JSON.stringify(r.shown)} vs ${JSON.stringify(r.truth)})`);

    // =================================================================
    // 4 — a bulk change OFF screen, then the same-frame redraw ops end with
    // =================================================================
    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const s = AS.state.session;
        // Ungroup and drop 3D on frames 1200..2400 (what a range delete / re-track does).
        for (let f = 1200; f < 2400; f++) s.instanceGroups.delete(f);
        // And clear every camB instance on frames 2400..2700.
        for (let f = 2400; f < 2700; f++) {
            const fg = s.frameGroups.get(f);
            if (!fg) continue;
            fg.instances.delete('camB');
            if (fg.unlinkedInstances) fg.unlinkedInstances.delete('camB');
        }
    });
    await update(null);                                             // same frame: schedules the rebuild
    await settle();
    r = await shownVsTruth('camB');
    check(same(r), `bulk change off screen: exact after the rebuild (${JSON.stringify(r.shown)} vs ${JSON.stringify(r.truth)})`);

    // =================================================================
    // 5 — switch the active camera
    // =================================================================
    for (const cam of ['camC', 'camA']) {
        await page.evaluate(async (cam) => { const AS = await import('/ui/app-state.js'); AS.interactionManager.lastInteractedView = cam; }, cam);
        await update(500);
        r = await shownVsTruth(cam);
        check(same(r), `switch to ${cam}: exact (${JSON.stringify(r.shown)} vs ${JSON.stringify(r.truth)})`);
    }

    await browser.close();
} catch (e) {
    console.log('  ✗ threw:', e && e.message ? e.message : String(e));
    fails++;
    if (browser) await browser.close().catch(() => {});
} finally {
    server.kill();
}

console.log(fails === 0 ? '\nstatus-counters-eager: PASS' : `\nstatus-counters-eager: FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
