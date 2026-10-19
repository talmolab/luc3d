/**
 * track-all-pose-check.mjs — Track All's 2D pose check (pose/pose-check.js,
 * pose/pose-check-session.js), in the real app: an outlier pose is counted in
 * the summary, marked in its view, explained on hover — and left out of
 * tracking when the Tracking Wizard says so.
 *
 * The scene: two articulated animals (head and tail swing, pixel noise) in front
 * of three calibrated cameras for 65 s at 30 fps. Planted in it, four outlier
 * predictions — animal 0's back half drawn on animal 1 in camera c0 at frames
 * 300, 900 and 1,500, and animal 1's nodes scattered over its box in c1 at 1,200.
 *  1. Track All (the real button, defaults): the summary's "2D poses" row counts
 *     the four as outliers, with a line per camera on hover.
 *  2. By default outliers stay in tracking (a garbled pose is usually still the
 *     right animal).
 *  3. In the view, the planted pose wears the red "✕" badge and a frame without
 *     one wears none; hovering one of its nodes says "Pose: outlier (score …)",
 *     a clean pose "Pose: common (…)".
 *  4. With "leave outliers out of tracking" on: the row says "outliers not
 *     tracked"; each planted detection is in no identity group — Track All leaves
 *     it in its frame's ungrouped pool, where a load puts every prediction —
 *     while its animal is still tracked from the other views; the hover adds
 *     ", not tracked"; and Track Frame on a planted frame leaves it out too (it
 *     reuses the pass's models — one frame is too little to learn from).
 *  5. Negative controls: with the check OFF the forced assignment DOES group
 *     planted detections (so (4) is the check's doing), the summary has no pose
 *     row and no verdicts stay on the session; with "outlier from" set to 0 they
 *     are flagged "uncommon" (amber badge, tooltip) and tracked.
 *
 * Run: node tests/e2e/track-all-pose-check.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8327);
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined && !c ? '  ' + JSON.stringify(extra).slice(0, 600) : ''));
    if (!c) fails++;
};

const PLANTED = [{ cam: 'c0', frame: 300, animal: 0 }, { cam: 'c0', frame: 900, animal: 0 },
    { cam: 'c0', frame: 1500, animal: 0 }, { cam: 'c1', frame: 1200, animal: 1 }];

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 60000 });

    // The scene, with the planted detections tagged `__planted` so the checks can find them.
    await page.evaluate(async (PLANTED) => {
        window.__build = async () => {
            const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
            const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
                'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
            const T = { Nose: [45, 0, 0], Ear_R: [25, -11, 4], Ear_L: [25, 11, 4], Head: [30, 0, 3], Neck: [20, 0, 2],
                Trunk: [-5, 0, 4], TTI: [-40, 0, 0], Shoulder_left: [10, 12, 0], Shoulder_right: [10, -12, 0],
                Haunch_left: [-25, 15, 0], Haunch_right: [-25, -15, 0], Tail_0: [-65, 0, 0], Tail_1: [-88, 0, 0],
                Tail_2: [-110, 0, 0], TailTip: [-132, 0, 0] };
            const HEAD = ['Nose', 'Ear_R', 'Ear_L', 'Head'], TAIL = ['Tail_0', 'Tail_1', 'Tail_2', 'TailTip'];
            const BACK = ['TTI', 'Haunch_left', 'Haunch_right', 'Tail_0', 'Tail_1', 'Tail_2', 'TailTip'];
            let seed = 7;
            const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
            const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
            const cam = (n, rvec, tvec) => new pd.Camera(n, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
            const CAMS = [cam('c0', [0, 0, 0], [0, 0, 0]), cam('c1', [0, 0.35, 0], [-12, 0, 3]), cam('c2', [0.35, 0, 0], [0, -12, 3])];
            const s = new pd.Session(CAMS, new pd.Skeleton('mouse', NODES, []), ['track_0', 'track_1'], 'pose');
            const FRAMES = 65 * 30, SC = [0.05, 0.06];
            // Rotate a body-frame point about a pivot in the xy plane (head and tail swing).
            const swing = (p, piv, a) => { const c = Math.cos(a), sn = Math.sin(a), x = p[0] - piv[0], y = p[1] - piv[1]; return [piv[0] + c * x - sn * y, piv[1] + sn * x + c * y, p[2]]; };
            for (let f = 0; f < FRAMES; f++) {
                const fg = new pd.FrameGroup(f);
                const proj = [[], []];
                [[-8, 0, 48], [8, 0, 48]].forEach((c0, ai) => {
                    const ctr = [c0[0] + 0.6 * Math.sin(f / 90 + ai), c0[1] + 0.6 * Math.cos(f / 70 + ai), c0[2]];
                    const h = f / 200 + ai * 2, ch = Math.cos(h), sh = Math.sin(h);
                    const tailA = 0.5 * Math.sin(f / 37 + ai), headA = 0.35 * Math.sin(f / 53 + 2 * ai);
                    const pts3 = NODES.map(n => {
                        let b = T[n];
                        if (TAIL.includes(n)) b = swing(b, T.TTI, tailA);
                        if (HEAD.includes(n)) b = swing(b, T.Neck, headA);
                        const [x, y, z] = b.map(v => v * SC[ai]);
                        return [ctr[0] + ch * x - sh * y, ctr[1] + sh * x + ch * y, ctr[2] + z];
                    });
                    CAMS.forEach((c, ci) => { proj[ai][ci] = pts3.map(p => { const q = c.project(p); return [q[0] + 0.5 * gauss(), q[1] + 0.5 * gauss()]; }); });
                });
                for (const pl of PLANTED) {
                    if (pl.frame !== f) continue;
                    const ci = CAMS.findIndex(c => c.name === pl.cam), own = proj[pl.animal][ci], other = proj[1 - pl.animal][ci];
                    if (pl.cam === 'c0') {
                        BACK.forEach(n => { const k = NODES.indexOf(n); own[k] = other[k].slice(); });   // back half on the other animal
                    } else {
                        const xs = own.map(p => p[0]), ys = own.map(p => p[1]);
                        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
                        for (let k = 0; k < own.length; k++) own[k] = [x0 + (x1 - x0) * rnd(), y0 + (y1 - y0) * rnd()];
                    }
                }
                CAMS.forEach((c, ci) => [0, 1].forEach(ai => {
                    const inst = new pd.Instance(proj[ai][ci], ai, 'predicted', 1.0);
                    if (PLANTED.some(pl => pl.frame === f && pl.cam === c.name && pl.animal === ai)) inst.__planted = true;
                    fg.addUnlinkedInstance(c.name, new pd.UnlinkedInstance(inst, c.name));   // as a load leaves predictions: ungrouped
                }));
                s.addFrameGroup(fg);
            }
            AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
            AS.state.totalFrames = FRAMES; AS.state.currentFrame = 0; AS.state.views = []; AS.state.fps = 30;
            AS.state.triangulationResults = new Map();
            if (AS.timeline) { AS.timeline.setTotalFrames(FRAMES); AS.timeline.setData(s); }
            (await import('/pose/tracker.js')).setTrackerNumAnimals(2);
        };
    }, PLANTED);

    const summary = () => page.evaluate(() => {
        const o = document.getElementById('trackSummaryOverlay');
        if (!o) return null;
        return Array.from(o.querySelectorAll('.track-summary-stat')).map(r => ({
            text: Array.from(r.children).map(c => c.textContent).join('|'), title: r.title || (r.querySelector('[title]') || {}).title || '' }));
    });
    const closeSummary = () => page.evaluate(() => { const b = document.getElementById('trackSummaryClose'); if (b) b.click(); });
    const setThresholds = (th) => page.evaluate(async (th) => (await import('/ui/settings.js')).setTrackingThresholds(Object.assign({ autoSwitchCheck: 0 }, th)), th);
    // Where each planted detection ended up: in a group (its identity) or in the ungrouped pool.
    const planted = () => page.evaluate(() => {
        const s = window.__lucid.state.session, out = [];
        for (const fi of s.frameIndices) {
            const fg = s.getFrameGroup(fi);
            for (const cam of ['c0', 'c1', 'c2']) {
                const all = (fg.getInstances(cam) || []).concat((fg.getUnlinkedInstances(cam) || []).map(u => u.instance));
                for (const inst of all) {
                    if (!inst.__planted) continue;
                    const groups = s.instanceGroups.get(fi) || [];
                    const g = groups.find(gr => gr.getInstance(cam) === inst);
                    // the planted animal's group in the other views this frame
                    const others = groups.filter(gr => gr !== g && ['c0', 'c1', 'c2'].filter(c => c !== cam).some(c => gr.getInstance(c) && gr.getInstance(c).trackIdx === inst.trackIdx));
                    out.push({ frame: fi, cam, grouped: !!g, unlinked: (fg.getUnlinkedInstances(cam) || []).some(u => u.instance === inst),
                        trackedElsewhere: others.length > 0 });
                }
            }
        }
        return out;
    });

    // One view per camera on screen (the scene has no videos), redrawn on `frame`.
    const showViews = (frame) => page.evaluate(async (frame) => {
        const AS = await import('/ui/app-state.js'), sp = await import('/ui/sessions-panes.js'), R = await import('/ui/rendering.js');
        const cams = ['c0', 'c1', 'c2'];
        AS.state.currentFrame = frame; AS.state.isPlaying = false;
        AS.state.views = cams.map(n => ({ name: n, videoWidth: 640, videoHeight: 480, frameCount: 1950, canvas: null }));
        AS.state.videoFiles = cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        AS.state.viewMode = 'grid'; AS.state.singleViewIndex = 0;
        AS.paneManager.clearAll(); sp.populateViewStrip(); AS.paneManager.addAllViewsAsGrid();
        await new Promise(r => requestAnimationFrame(r));
        sp.refreshPaneInteractions();
        await new Promise(r => requestAnimationFrame(r));
        R.drawAllOverlays(frame);
    }, frame);
    // Pixels of a badge color in a box just outside the planted (or a clean) pose's bottom-right corner.
    const badgePixels = (cam, frame, which, color) => page.evaluate(async ([cam, frame, which, color]) => {
        const AS = await import('/ui/app-state.js'), R = await import('/ui/rendering.js');
        AS.state.currentFrame = frame; R.drawAllOverlays(frame);
        const v = AS.state.views.find(w => w.name === cam), cv = v.overlayCanvas;
        const fg = AS.state.session.getFrameGroup(frame);
        const all = (fg.getInstances(cam) || []).concat((fg.getUnlinkedInstances(cam) || []).map(u => u.instance));
        const inst = which === 'planted' ? all.find(i => i.__planted) : all.find(i => !i.__planted);
        const sx = cv.width / v.videoWidth, sy = cv.height / v.videoHeight;
        let x1 = -Infinity, y1 = -Infinity;
        for (let k = 0; k < inst.numNodes; k++) { x1 = Math.max(x1, inst.getX(k) * sx); y1 = Math.max(y1, inst.getY(k) * sy); }
        const R0 = 40, data = cv.getContext('2d').getImageData(Math.round(x1 - 6), Math.round(y1 - 6), R0, R0).data;
        const [cr, cg, cb] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
        let n = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200 && Math.abs(data[i] - cr) < 12 && Math.abs(data[i + 1] - cg) < 12 && Math.abs(data[i + 2] - cb) < 12) n++;
        return n;
    }, [cam, frame, which, color]);
    const RED = '#ff3b30', AMBER = '#ffb300';
    // The node tooltip after real mouse moves onto a node of the planted (or a clean) pose.
    const tipOn = async (cam, frame, which) => {
        const xy = await page.evaluate(async ([cam, frame, which]) => {
            const AS = await import('/ui/app-state.js'), R = await import('/ui/rendering.js');
            AS.state.currentFrame = frame; R.drawAllOverlays(frame);
            const v = AS.state.views.find(w => w.name === cam);
            const fg = AS.state.session.getFrameGroup(frame);
            const all = (fg.getInstances(cam) || []).concat((fg.getUnlinkedInstances(cam) || []).map(u => u.instance));
            const inst = which === 'planted' ? all.find(i => i.__planted) : all.find(i => !i.__planted);
            const k = 5;   // Head: on the planted c0 poses it is the animal's own (the tip names whichever node is nearest)
            const r = v.overlayCanvas.getBoundingClientRect();
            return [r.left + inst.getX(k) / v.videoWidth * r.width, r.top + inst.getY(k) / v.videoHeight * r.height];
        }, [cam, frame, which]);
        await page.mouse.move(xy[0] + 30, xy[1] + 30);
        await page.mouse.move(xy[0], xy[1]);
        await page.waitForTimeout(900);
        const t = await page.evaluate(() => { const el = document.getElementById('nodeTip'); return el && !el.hidden ? el.innerText : ''; });
        await page.mouse.move(5, 5); await page.waitForTimeout(300);
        return t;
    };

    // ---- 1. Track All (defaults) -> the summary row -------------------------------------------
    await page.evaluate(() => window.__build());
    await setThresholds({});
    await page.click('#tbTrackAll');
    await page.waitForSelector('#trackSummaryOverlay', { timeout: 60000 });
    let stats = await summary();
    let poseRow = stats.find(r => r.text.startsWith('2D poses|'));
    let m = poseRow && /^2D poses\|(?:([\d,]+) uncommon, )?([\d,]+) outliers\|of ([\d,]+)$/.exec(poseRow.text);
    check(m && +m[2].replace(/,/g, '') === 4, `summary: the four planted poses are outliers, and nothing says they were left out (${poseRow && poseRow.text})`);
    check(m && +(m[1] || '0').replace(/,/g, '') <= 3 && +m[3].replace(/,/g, '') === 3 * 2 * 1950,
        `...of every detection, with next to nothing else flagged (${poseRow && poseRow.text})`);
    check(poseRow && /c0: [\d,]+ uncommon, 3 outliers of [\d,]+/.test(poseRow.title) && /c1: [\d,]+ uncommon, 1 outlier of/.test(poseRow.title) &&
        /c2: [\d,]+ uncommon, 0 outliers of/.test(poseRow.title),
        `hover: a line per camera (${poseRow && poseRow.title.replace(/\n/g, ' / ')})`);
    const flags = await page.evaluate(() => window.__lucid.state.session.poseCheck.flags.filter(f => f.cls === 2).map(f => f.camera + '@' + f.frame));
    check(JSON.stringify(flags) === JSON.stringify(['c0@300', 'c0@900', 'c1@1200', 'c0@1500']), `the flags name the planted detections: ${JSON.stringify(flags)}`);
    await closeSummary();

    // ---- 2. by default outliers are flagged, and still tracked --------------------------------------
    let pl = await planted();
    check(pl.length === 4 && pl.some(p => p.grouped), `outliers stay in tracking by default (${pl.filter(p => p.grouped).length} of 4 grouped)`, pl);

    // ---- 3. the mark in the view, and the tooltip --------------------------------------------------
    await showViews(300);
    check(await badgePixels('c0', 300, 'planted', RED) > 20, 'the planted pose wears the red badge');
    check(await badgePixels('c0', 301, 'clean', RED) === 0 && await badgePixels('c0', 301, 'clean', AMBER) === 0, 'a frame without one: no badge');
    check(await badgePixels('c1', 1200, 'planted', RED) > 20, 'so does the scattered one in c1');
    let t = await tipOn('c0', 300, 'planted');
    check(/^\w+\n(\(score: [\d.]+\)\n)?Pose: outlier \(score \d+\.\d\)$/.test(t), `hover on the planted pose: ${JSON.stringify(t)}`);
    t = await tipOn('c0', 301, 'clean');
    check(/\nPose: common \(score -?\d+\.\d\)$/.test(t), `hover on a clean pose: ${JSON.stringify(t)}`);

    // ---- 4. "leave outliers out of tracking" -----------------------------------------------------
    await page.evaluate(() => window.__build());
    await setThresholds({ poseExcludeOutliers: 1 });
    await page.evaluate(async () => (await import('/pose/tracker.js')).trackAll());
    stats = await summary();
    poseRow = stats && stats.find(r => r.text.startsWith('2D poses|'));
    check(poseRow && /^2D poses\|(?:[\d,]+ uncommon, )?4 outliers\|of [\d,]+ · outliers not tracked$/.test(poseRow.text),
        `left out: the summary says outliers were not tracked (${poseRow && poseRow.text})`);
    await closeSummary();
    pl = await planted();
    check(pl.length === 4 && pl.every(p => !p.grouped && p.unlinked), '...each planted detection is in no group (Track All left it in the ungrouped pool)', pl);
    check(pl.every(p => p.trackedElsewhere), '...while its animal is still tracked from the other views', pl);
    await showViews(300);
    t = await tipOn('c0', 300, 'planted');
    check(/^\w+\n(\(score: [\d.]+\)\n)?Pose: outlier \(score \d+\.\d\), not tracked$/.test(t), `...and the hover says so: ${JSON.stringify(t)}`);
    // Track Frame reuses the pass's models, and its choice to leave outliers out.
    await page.evaluate(async () => { (await import('/ui/app-state.js')).state.currentFrame = 900; (await import('/pose/tracker.js')).trackCurrentFrame(); });
    pl = await planted();
    const at900 = pl.find(p => p.frame === 900);
    check(at900 && !at900.grouped && at900.trackedElsewhere, 'Track Frame on a planted frame leaves it out too', at900);

    // ---- 5. negative controls ---------------------------------------------------------------------
    await page.evaluate(() => window.__build());
    await setThresholds({ poseCheck: 0, poseExcludeOutliers: 1 });
    await page.evaluate(async () => (await import('/pose/tracker.js')).trackAll());
    stats = await summary();
    check(stats && !stats.some(r => r.text.startsWith('2D poses|')), 'check off: no pose row in the summary');
    await closeSummary();
    pl = await planted();
    check(pl.some(p => p.grouped), `check off: the forced assignment groups planted detections (${pl.filter(p => p.grouped).length} of 4) — so their absence in (4) is the check's doing`, pl);
    check(await page.evaluate(() => window.__lucid.state.session.poseCheck === null), 'check off: no verdicts are left on the session');

    await page.evaluate(() => window.__build());
    await setThresholds({ poseOutlierZ: 0, poseExcludeOutliers: 1 });
    await page.evaluate(async () => (await import('/pose/tracker.js')).trackAll());
    stats = await summary();
    const row0 = stats && stats.find(r => r.text.startsWith('2D poses|'));
    check(row0 && /^2D poses\|[\d,]+ uncommon\|of [\d,]+$/.test(row0.text), `"outlier from" 0: flagged uncommon, no outliers (${row0 && row0.text})`);
    await closeSummary();
    pl = await planted();
    check(pl.some(p => p.grouped), `...and tracked like any detection (${pl.filter(p => p.grouped).length} of 4 grouped)`, pl);
    await showViews(300);
    check(await badgePixels('c0', 300, 'planted', AMBER) > 20 && await badgePixels('c0', 300, 'planted', RED) === 0,
        '...the badge is the amber "?", not the red "✕"');
    t = await tipOn('c0', 300, 'planted');
    check(/\nPose: uncommon \(score \d+\.\d\)$/.test(t), `...and the hover says uncommon: ${JSON.stringify(t)}`);

    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
}
console.log(fails ? `FAIL (${fails})` : 'PASS');
process.exit(fails ? 1 : 0);
