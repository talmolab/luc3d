/**
 * run-buttons-blue.mjs — the toolbar's Track and Triangulate buttons turn blue
 * once that step has been run, while its result stands (ui/run-buttons.js,
 * pose/run-state.js), as Smooth does. Driven through the real buttons on a
 * small calibrated two-animal fixture (the track-all-switches-to-id rig):
 *   1. a fresh session: both grey;
 *   2. Track All: Track blue, Triangulate still grey (Track All's own 3D does
 *      not count);
 *   3. Triangulate All: Triangulate blue too; a node-move re-solve of every
 *      group and Temporal Smoothing keep it blue;
 *   4. Track All again: it replaces the 3D, so Triangulate goes grey while
 *      Track stays blue; Triangulate All with Refined (another code path)
 *      turns it blue too;
 *   5. Track This frame and Triangulate This frame count as runs, and so does
 *      a frame range;
 *   6. per session: switching to an untouched session greys both, switching
 *      back restores them.
 *
 * Run: node tests/e2e/run-buttons-blue.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerTrackSetup } from './fixtures/track-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8297);
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
    await answerTrackSetup(page, 2);
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    // Two sessions on the same rig; the first is active.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, FrameGroup, Session } = pd;
        const NODES = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
        const OFFSETS = [[0, 0, 0], [2, 1, 0], [-2, 1, 0], [0, -2, 1], [1.5, 0, -1.5], [-1.5, 0, 1.5]];
        const cam = (name, rvec, tvec) =>
            new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
        const CAMS = [cam('c0', [0, 0, 0], [0, 0, 0]), cam('c1', [0, 0.35, 0], [-12, 0, 3]), cam('c2', [0.35, 0, 0], [0, -12, 3])];
        const mk = (name) => {
            const session = new Session(CAMS, new Skeleton('sk', NODES, []), ['track_0', 'track_1'], name);
            for (let f = 0; f < 8; f++) {
                const fg = new FrameGroup(f);
                [[-7 + 0.3 * f, 0, 48], [7 - 0.3 * f, 0, 48]].forEach((ctr, ai) => CAMS.forEach(c =>
                    fg.addInstance(c.name, new Instance(
                        OFFSETS.map(o => c.project([ctr[0] + o[0] + 0.05 * Math.sin(f + ai), ctr[1] + o[1], ctr[2] + o[2]])),
                        ai, 'predicted', 1.0))));
                session.addFrameGroup(fg);
            }
            return session;
        };
        const a = mk('RunA'), b = mk('RunB');
        AS.state.sessions = [a, b];
        AS.state.activeSessionIdx = 0;
        AS.state.session = a;
        AS.state.totalFrames = 8;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = [];
        (await import('/ui/settings.js')).setSmoothingParams({ smoothGaussianWindow: 3, smoothMedianWindow: 0 });
    });

    // [Track blue, Triangulate blue, Smooth blue] after a redraw, as on screen.
    const blue = () => page.evaluate(async () => {
        (await import('/ui/rendering.js')).drawAllOverlays(window.__lucid.state.currentFrame);
        return ['tbTrackAll', 'tbTriangulateAll', 'tbSmooth'].map(id => document.getElementById(id).classList.contains('active'));
    });
    const S = (b) => JSON.stringify(b);
    const clearStatus = () => page.evaluate(() => { document.getElementById('statusText').textContent = ''; });
    const waitStatus = (re) => page.waitForFunction(
        (src) => new RegExp(src).test(document.getElementById('statusText').textContent), re.source, { timeout: 30000 });
    const trackAll = async () => {
        await clearStatus();
        await page.click('#tbTrackAll');
        await waitStatus(/Assigned \d+ identities|error/i);
        await page.click('#trackSummaryClose', { timeout: 30000 });
    };
    const triangulateAll = async () => {
        await clearStatus();
        await page.click('#tbTriangulateAll');
        await waitStatus(/^(Triangulated|Grouped) /);
    };
    const menuItem = async (button, item, re) => {
        await clearStatus();
        await page.hover('#' + button);
        await page.waitForTimeout(150);
        await page.click('#' + item);
        await waitStatus(re);
        await page.mouse.move(700, 600);
    };

    // ---- 1. fresh -------------------------------------------------------------------
    check(S(await blue()) === '[false,false,false]', `1. fresh session: all grey (${S(await blue())})`);

    // ---- 2. Track All ---------------------------------------------------------------
    await trackAll();
    const has3d = await page.evaluate(async () => {
        const TRI = await import('/pose/triangulation.js');
        return (TRI.getInstanceGroupsForFrame(0) || []).filter(g => g.points3d && g.points3d.some(Number.isFinite)).length;
    });
    check(has3d > 0, `precondition: Track All left 3D on frame 1 (${has3d} groups)`);
    check(S(await blue()) === '[true,false,false]', `2. after Track All: Track blue, Triangulate grey (${S(await blue())})`);

    // ---- 3. Triangulate All, then a re-solve and smoothing ---------------------------
    await triangulateAll();
    check(S(await blue()) === '[true,true,false]', `3. after Triangulate All: Track and Triangulate blue (${S(await blue())})`);
    await page.evaluate(async () => {
        const TRI = await import('/pose/triangulation.js');
        for (const [, list] of window.__lucid.state.session.instanceGroups) list.forEach(g => TRI.reTriangulateGroup(g));
    });
    check(S(await blue()) === '[true,true,false]', '3. a node-move re-solve of every group keeps Triangulate blue');
    await clearStatus();
    await page.click('#tbSmooth');
    await waitStatus(/^Smoothed /);
    check(S(await blue()) === '[true,true,true]', `3. smoothing keeps it blue, and Smooth turns blue (${S(await blue())})`);

    // ---- 4. Track All again replaces the 3D --------------------------------------------
    await trackAll();
    check(S(await blue()) === '[true,false,false]', `4. re-tracking: Triangulate (and Smooth) grey, Track blue (${S(await blue())})`);

    // Refined goes through a different path (triangulateAllFrames) than DLT
    // after tracking (groupByIdentityAndTriangulateAll).
    await page.evaluate(async () => (await import('/ui/settings.js')).setDefaultTriangulationMethod('ba'));
    await triangulateAll();
    check(S(await blue()) === '[true,true,false]', `4. Triangulate All with Refined turns it blue (${S(await blue())})`);
    await page.evaluate(async () => (await import('/ui/settings.js')).setDefaultTriangulationMethod('dlt'));
    await trackAll();

    // ---- 5. This frame and a range -----------------------------------------------------
    await menuItem('tbTriangulateAll', 'tbTriangulate', /^Triangulated frame /);
    check(S(await blue()) === '[true,true,false]', `5. Triangulate ▸ This frame turns it blue (${S(await blue())})`);
    await trackAll();
    check((await blue())[1] === false, '5. (re-tracked: grey again)');
    await page.evaluate(async () => {
        await (await import('/pose/triangulation.js')).triangulateMultiFrameInstances(2, 4, null, 'dlt');
    });
    check((await blue())[1] === true, '5. a frame-range triangulation turns it blue');

    // ---- 6. per session ------------------------------------------------------------------
    const switchTo = (i) => page.evaluate((i) => {
        const st = window.__lucid.state;
        st.activeSessionIdx = i;
        st.session = st.sessions[i];
    }, i);
    await switchTo(1);
    check(S(await blue()) === '[false,false,false]', `6. an untouched session: all grey (${S(await blue())})`);
    await menuItem('tbTrackAll', 'tbTrackFrame', /identities \/ \d+ cross-view targets|No cross-view/);
    check(S(await blue()) === '[true,false,false]', `6. Track ▸ This frame turns Track blue there (${S(await blue())})`);
    await switchTo(0);
    check(S(await blue()) === '[true,true,false]', `6. back on the first session: as it was (${S(await blue())})`);

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
