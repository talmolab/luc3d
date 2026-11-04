/**
 * tail-mark-track-all.mjs — Track All's tail-mark pass (pose/tail-mark.js) in the
 * real app, with the real tracker. Two animals in three calibrated cameras; the
 * videos are stand-ins (`getFrame` paints each animal's tail from its keypoints,
 * dark bands on animal 0's, which only the fixture knows about).
 *  1. Off by default: Track All reads no video and leaves the labels as tracked.
 *  2. The first-use dialog offers the choice, and its answer applies to that run:
 *     the marked animal ends on the chosen identity, for id_0 and for id_1.
 *  3. The Track menu shows the choice, follows the session, and setting it marks the
 *     project dirty; the summary box and status line say what the pass did.
 *  4. A range does not run the pass.
 *  5. Neither tail marked: the pass says so and changes no label.
 *  6. No videos: the pass says so, and tracking still succeeds.
 *
 * Run: node tests/e2e/tail-mark-track-all.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8297);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    await page.evaluate(() => {
        // `marked`: the animal whose tail is painted with bands (null: neither). `videos: false`: no views.
        window.__build = async (opts) => {
            const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
            const st = await import('/ui/settings.js');
            st.setTrackingThresholds({ autoSwitchCheck: 0, autoImageSwitchCheck: 0 });
            const NODES = ['Nose', 'Head', 'Neck', 'Trunk', 'TTI', 'Tail_0', 'Tail_1', 'Tail_2', 'TailTip'];
            const T = { Nose: [45, 0, 0], Head: [30, 0, 3], Neck: [20, 0, 2], Trunk: [-5, 0, 4], TTI: [-40, 0, 0],
                Tail_0: [-90, 0, 0], Tail_1: [-140, 0, 0], Tail_2: [-180, 0, 0], TailTip: [-220, 0, 0] };
            const cam = (n, rvec, tvec) => new pd.Camera(n, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
            const CAMS = [cam('c0', [0, 0, 0], [0, 0, 0]), cam('c1', [0, 0.35, 0], [-12, 0, 3]), cam('c2', [0.35, 0, 0], [0, -12, 3])];
            const s = new pd.Session(CAMS, new pd.Skeleton('mouse', NODES, []), ['track_0', 'track_1'], 'fixture');
            const FRAMES = 600, SC = 0.06;
            for (let f = 0; f < FRAMES; f++) {
                const fg = new pd.FrameGroup(f);
                // animal 1 is listed first in the data, so the tracker's id_0 is not animal 0 by accident of order
                [[8, 4, 48, 1], [-8, -4, 48, 0]].forEach(([x, y, z, ai]) => {
                    const ctr = [x + 0.6 * Math.sin(f / 90 + ai), y + 0.4 * Math.cos(f / 70 + ai), z];
                    const pts3 = NODES.map((n) => [ctr[0] + T[n][0] * SC, ctr[1] + T[n][1] * SC, ctr[2] + T[n][2] * SC]);
                    CAMS.forEach((c) => fg.addInstance(c.name, new pd.Instance(pts3.map((p) => c.project(p)), ai, 'predicted', 1.0)));
                });
                s.addFrameGroup(fg);
            }
            const paint = (camName, f) => {
                const cv = new OffscreenCanvas(640, 480), ctx = cv.getContext('2d');
                ctx.fillStyle = '#0c0c0c'; ctx.fillRect(0, 0, 640, 480);
                const ti = NODES.indexOf('TTI'), t1 = NODES.indexOf('Tail_1');
                for (const inst of s.frameGroups.get(f).instances.get(camName)) {
                    const a = inst.getPoint(ti), b = inst.getPoint(t1);
                    ctx.strokeStyle = '#666'; ctx.lineWidth = 5;
                    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
                    if (inst.trackIdx !== opts.marked) continue;
                    ctx.strokeStyle = '#0c0c0c'; ctx.lineWidth = 8;
                    for (const u of [0.25, 0.5, 0.75]) {
                        ctx.beginPath();
                        ctx.moveTo(a[0] + (u - 0.04) * (b[0] - a[0]), a[1] + (u - 0.04) * (b[1] - a[1]));
                        ctx.lineTo(a[0] + (u + 0.04) * (b[0] - a[0]), a[1] + (u + 0.04) * (b[1] - a[1]));
                        ctx.stroke();
                    }
                }
                return cv;
            };
            AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
            AS.state.totalFrames = FRAMES; AS.state.currentFrame = 0; AS.state.fps = 30;
            AS.state.triangulationResults = new Map();
            window.__reads = 0;
            AS.state.views = [];
            if (opts.videos !== false) {
                window.__fakeViews = CAMS.map((c) => ({ name: c.name, cameraName: c.name, decoder: { samples: [], getFrame: async (f) => { window.__reads++; return paint(c.name, f); } } }));
            } else window.__fakeViews = null;
            if (AS.timeline) { AS.timeline.setTotalFrames(FRAMES); AS.timeline.setData(s); }
            return FRAMES;
        };
        // The marked animal's identity, from the groups: the per-frame answer the labels give.
        window.__markedIdentityNames = () => {
            const s = window.__lucid.state.session, out = new Map();
            for (const [, groups] of s.instanceGroups) for (const g of groups) {
                const inst = g.instances.get('c0');
                if (!inst || inst.trackIdx !== 0) continue;
                const nm = s.identities.find((i) => i.id === g.identityId).name;
                out.set(nm, (out.get(nm) || 0) + 1);
            }
            return Object.fromEntries(out);
        };
    });

    // Track All, with `tail` chosen in the first-use dialog, on the stand-in views.
    const trackAll = async (answer) => page.evaluate(async (ans) => {
        const AS = await import('/ui/app-state.js');
        const tr = await import('/pose/tracker.js');
        const wait = () => new Promise((r) => {
            const t = setInterval(() => {
                const m = document.querySelector('.track-setup-modal');
                if (!m) return;
                clearInterval(t);
                m.querySelector('#trackSetupAnimals').value = '2';
                m.querySelector('#trackSetupTailMarks').value = ans.tail;
                m.querySelector('#trackSetupAnimals').dispatchEvent(new Event('input', { bubbles: true }));
                window.__dialogOffered = [...m.querySelectorAll('#trackSetupTailMarks option')].map((o) => o.value);
                m.querySelector('#trackSetupContinue').click();
                r();
            }, 30);
        });
        if (ans.dialog) wait();
        if (window.__fakeViews) AS.state.views = window.__fakeViews;
        await tr.trackAll();
        AS.state.views = [];
        const r = AS.state.session._tailMarkResult || null;
        const box = document.getElementById('trackSummaryTailMarks');
        const out = { result: r && { ok: r.ok, reason: r.reason, swapped: r.swapped, markedName: r.markedName },
            status: document.getElementById('statusText').textContent, note: box ? box.textContent : null,
            menu: document.getElementById('tbTailMarks').value, ids: AS.state.session.identities.map((i) => i.name),
            dirty: AS.state.isDirty, reads: window.__reads, marked: window.__markedIdentityNames() };
        document.querySelectorAll('.track-summary-modal button').forEach((b) => { if (/close/i.test(b.textContent)) b.click(); });
        return out;
    }, answer);

    console.log('1. off by default');
    await page.evaluate(() => window.__build({ marked: 0 }));
    let r = await trackAll({ tail: '', dialog: true });
    check(JSON.stringify(await page.evaluate(() => window.__dialogOffered)) === '["","id_0","id_1"]', 'the dialog offers Off, id_0 and id_1');
    check(r.result === null && r.reads === 0, 'no pass and no video read');
    check(r.note === null, 'the summary says nothing about tail marks');
    check(r.ids.length === 2, 'two identities tracked');
    const asTracked = r.marked;
    console.log('   as tracked, the marked animal is on', JSON.stringify(asTracked));

    for (const name of ['id_0', 'id_1']) {
        console.log('2. the dialog\'s answer applies to that run: ' + name);
        await page.evaluate(() => window.__build({ marked: 0 }));
        r = await trackAll({ tail: name, dialog: true });
        check(r.result && r.result.ok, 'the pass ran: ' + JSON.stringify(r.result));
        check(r.reads > 0, 'it read the video (' + r.reads + ' frames)');
        check(Object.keys(r.marked).length === 1 && r.marked[name] > 0, 'the marked animal is on ' + name + ' on every frame: ' + JSON.stringify(r.marked));
        check(r.menu === name, 'the Track menu shows the choice');
        check(new RegExp('tail marks on ' + name).test(r.status), 'the status line says so: ' + r.status.slice(0, 120));
        check(new RegExp('tail marks on ' + name).test(r.note || ''), 'the summary box says so: ' + r.note);
    }

    console.log('3. the Track menu');
    const menu = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js'); const sl = await import('/import-export/save-load.js');
        await window.__build({ marked: 0 });
        const el = document.getElementById('tbTailMarks');
        const rd = await import('/ui/rendering.js');
        rd.drawAllOverlays(0);
        const afterSwitch = el.value;
        AS.state.isDirty = false;
        el.value = 'id_1'; el.dispatchEvent(new Event('change', { bubbles: true }));
        return { afterSwitch, session: AS.state.session.tailMarkedIdentity, dirty: AS.state.isDirty };
    });
    check(menu.afterSwitch === '', 'it follows the session: a fresh one reads Off');
    check(menu.session === 'id_1', 'choosing writes it to the session');
    check(menu.dirty === true, 'and marks the project dirty');
    r = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const tr = await import('/pose/tracker.js');
        tr.setTrackerNumAnimals(2);
        return (await tr.trackFrameRange(0, 100)).ok && AS.state.session._tailMarkResult === undefined;
    });
    check(r === true, '4. a range does not run the pass');

    console.log('5. neither tail marked');
    await page.evaluate(() => window.__build({ marked: null }));
    r = await trackAll({ tail: 'id_1', dialog: true });
    check(r.result && !r.result.ok && /no tail marks/.test(r.result.reason), 'it says so: ' + JSON.stringify(r.result));
    check(JSON.stringify(r.marked) === JSON.stringify(asTracked), 'and leaves the labels as tracked');
    check(/tail marks not used/.test(r.status), 'the status line says it: ' + r.status.slice(0, 120));

    console.log('6. no videos');
    await page.evaluate(() => window.__build({ marked: 0, videos: false }));
    r = await trackAll({ tail: 'id_0', dialog: true });
    check(r.result && !r.result.ok && /videos/.test(r.result.reason), 'it says so: ' + JSON.stringify(r.result));
    check(r.ids.length === 2, 'and tracking still succeeded');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\nFAILED: ${fails}` : '\nAll passed.');
process.exit(fails ? 1 : 0);
