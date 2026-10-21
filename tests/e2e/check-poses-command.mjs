/**
 * check-poses-command.mjs — Tracks ▸ Check Poses (ui/pose-check-command.js):
 * the 2D pose check on its own, in the real app, with no Track All.
 *
 * Track All's verdicts are never saved, so a reopened project has no marks
 * until the next Track All; this command is the way back. On the shared
 * planted-outlier scene (tests/e2e/fixtures/pose-check-scene.js):
 *  1. With no session, the menu item says so and does nothing else.
 *  2. Clicked from the Tracks menu on an untracked session: the status bar
 *     names what it found ("2D poses: … 4 outliers of 11,700 checked — …"),
 *     the flags name exactly the planted detections, and the views wear the red
 *     "✕" on them and nothing on a clean frame; hovering a node says
 *     "Pose: outlier (score …)" — not "not tracked": nothing was tracked.
 *  3. It tracks nothing and edits nothing: no identity group appears, every
 *     detection stays where it was, and the project is NOT marked dirty.
 *  4. It reads the Tracking Wizard's thresholds when it runs: with "outlier
 *     from" at 0, the same four are uncommon (amber "?").
 *  5. After Track All with "leave outliers out of tracking", Check Poses
 *     replaces the verdicts without touching the tracking: the left-out
 *     detections stay ungrouped, and the tooltip no longer claims "not tracked"
 *     for a check that tracked nothing.
 *  6. Next / Previous Flagged Pose: real `]` / `[` presses step through exactly
 *     the planted frames, each with a status line naming what was flagged there;
 *     past the last one it stays put and says so (no wrap); the Tracks menu items
 *     do the same; both are in Settings ▸ Keyboard Shortcuts, rebindable; and on
 *     a session with no check yet the key says to run one and goes nowhere.
 *
 * Run: node tests/e2e/check-poses-command.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPoseCheckScene, planted as plantedIn, showViews as showViewsIn, badgePixels as badgePixelsIn, tipOn as tipOnIn, RED, AMBER } from './fixtures/pose-check-scene.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8329);
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined && !c ? '  ' + JSON.stringify(extra).slice(0, 600) : ''));
    if (!c) fails++;
};

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
    await installPoseCheckScene(page);
    const planted = () => plantedIn(page);
    const showViews = (frame) => showViewsIn(page, frame);
    const badgePixels = (cam, frame, which, color) => badgePixelsIn(page, cam, frame, which, color);
    const tipOn = (cam, frame, which) => tipOnIn(page, cam, frame, which);
    const setThresholds = (th) => page.evaluate(async (th) => (await import('/ui/settings.js')).setTrackingThresholds(Object.assign({ autoSwitchCheck: 0 }, th)), th);
    const status = () => page.evaluate(() => document.getElementById('statusText').textContent);
    // Tracks ▸ Check Poses, the real menu item; resolves once its status line is up.
    const runFromMenu = async () => {
        await page.evaluate(() => { document.getElementById('statusText').textContent = ''; document.getElementById('menuCheckPoses').click(); });
        await page.waitForFunction(() => {
            const t = document.getElementById('statusText').textContent;
            return t && document.getElementById('loadingOverlay').classList.contains('hidden');
        }, null, { timeout: 60000 });
        return status();
    };

    // ---- 1. no session --------------------------------------------------------------------------
    check(await page.evaluate(() => !!document.getElementById('menuCheckPoses') &&
        document.getElementById('menuCheckPoses').closest('#menuTracks') !== null), 'Tracks ▸ Check Poses exists');
    let st = await runFromMenu();
    check(st === 'No session with cameras loaded', `no session: says so (${st})`);

    // ---- 2. on an untracked session ---------------------------------------------------------
    await page.evaluate(() => window.__build());
    await setThresholds({});
    await page.evaluate(async () => { (await import('/ui/app-state.js')).state.isDirty = false; });
    const groupsBefore = await page.evaluate(() => window.__lucid.state.session.instanceGroups.size);
    st = await runFromMenu();
    check(/^2D poses: (?:[\d,]+ uncommon, )?4 outliers of 11,700 checked — marked \? and ✕ in the views; hover a node for its score$/.test(st),
        `status line: "${st}"`);
    const pc = await page.evaluate(() => {
        const p = window.__lucid.state.session.poseCheck;
        return p && { excluded: p.excluded, outliers: p.flags.filter(f => f.cls === 2).map(f => f.camera + '@' + f.frame) };
    });
    check(pc && pc.excluded === false, 'the verdicts are on the session, nothing left out');
    check(pc && JSON.stringify(pc.outliers) === JSON.stringify(['c0@300', 'c0@900', 'c1@1200', 'c0@1500']), `the flags name the planted detections: ${JSON.stringify(pc && pc.outliers)}`);
    await showViews(300);
    check(await badgePixels('c0', 300, 'planted', RED) > 20, 'the planted pose wears the red badge');
    check(await badgePixels('c0', 301, 'clean', RED) === 0 && await badgePixels('c0', 301, 'clean', AMBER) === 0, 'a frame without one: no badge');
    let t = await tipOn('c0', 300, 'planted');
    check(/^\w+\n(\(score: [\d.]+\)\n)?Pose: outlier \(score \d+\.\d\)$/.test(t), `hover on the planted pose: ${JSON.stringify(t)}`);

    // ---- 3. it tracks nothing and edits nothing ----------------------------------------------
    const after = await page.evaluate(() => ({ groups: window.__lucid.state.session.instanceGroups.size, dirty: window.__lucid.state.isDirty }));
    check(after.groups === groupsBefore && after.groups === 0, `no identity group appears (${after.groups})`);
    let pl = await planted();
    check(pl.length === 4 && pl.every(p => !p.grouped && p.unlinked), 'every planted detection stays where it was (ungrouped)', pl);
    check(after.dirty === false, 'the project is not marked dirty');

    // ---- 4. it reads the Tracking Wizard's thresholds --------------------------------------------
    await setThresholds({ poseOutlierZ: 0 });
    st = await runFromMenu();
    check(/^2D poses: [\d,]+ uncommon of 11,700 checked — /.test(st), `"outlier from" 0: uncommon only (${st})`);
    check(await badgePixels('c0', 300, 'planted', AMBER) > 20 && await badgePixels('c0', 300, 'planted', RED) === 0, '...and the badge is the amber "?"');

    // ---- 5. after a Track All that left outliers out -----------------------------------------------
    await page.evaluate(async () => { (await import('/ui/app-state.js')).state.views = []; });
    await page.evaluate(() => window.__build());
    await setThresholds({ poseExcludeOutliers: 1 });
    await page.evaluate(async () => (await import('/pose/tracker.js')).trackAll());
    await page.evaluate(() => { const b = document.getElementById('trackSummaryClose'); if (b) b.click(); });
    const tracked = await page.evaluate(() => window.__lucid.state.session.instanceGroups.size);
    pl = await planted();
    check(tracked > 0 && pl.every(p => !p.grouped), 'Track All left the planted outliers out', pl);
    st = await runFromMenu();
    check(/4 outliers of 11,700 checked/.test(st), `Check Poses after it: ${st}`);
    pl = await planted();
    check(pl.every(p => !p.grouped) && await page.evaluate(() => window.__lucid.state.session.instanceGroups.size) === tracked,
        '...the tracking is untouched', pl);
    await showViews(300);
    t = await tipOn('c0', 300, 'planted');
    check(/\nPose: outlier \(score \d+\.\d\)$/.test(t), `...and the tooltip makes no "not tracked" claim for a check that tracked nothing: ${JSON.stringify(t)}`);

    // ---- 6. ] / [ : step through the flagged frames ---------------------------------------------
    const frame = () => page.evaluate(() => window.__lucid.state.currentFrame);
    const press = async (key) => {
        await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
        await page.keyboard.press(key);
        return { frame: await frame(), status: await status() };
    };
    await page.evaluate(async () => { (await import('/ui/app-state.js')).state.currentFrame = 0; });
    const stops = [];
    let r;
    for (let i = 0; i < 4; i++) { r = await press(']'); stops.push(r.frame); if (i === 0) check(/^Flagged frame 1 of 4 \(frame 301\): outlier in c0 \(score \d+\.\d\)$/.test(r.status), `] status: "${r.status}"`); }
    check(JSON.stringify(stops) === JSON.stringify([300, 900, 1200, 1500]), `] steps through exactly the planted frames: ${JSON.stringify(stops)}`);
    check(/^Flagged frame 3 of 4 \(frame 1,201\)/.test((await page.evaluate(async () => {
        const PS = await import('/pose/pose-check-session.js');
        return PS.describeFlaggedFrame(window.__lucid.state.session.poseCheck, 1200);
    }))), 'the c1 stop is flagged frame 3 of 4, with thousands commas');
    r = await press(']');
    check(r.frame === 1500 && r.status === 'No flagged pose after frame 1,501 (4 flagged frames)', `past the last: stays put and says so (${r.frame}, "${r.status}")`);
    r = await press('[');
    check(r.frame === 1200 && /^Flagged frame 3 of 4 \(frame 1,201\): outlier in c1/.test(r.status), `[ steps back (${r.frame}, "${r.status}")`);
    await page.evaluate(() => document.getElementById('menuPrevFlaggedPose').click());
    check(await frame() === 900, 'Tracks ▸ Previous Flagged Pose steps back too');
    await page.evaluate(() => document.getElementById('menuNextFlaggedPose').click());
    check(await frame() === 1200, 'Tracks ▸ Next Flagged Pose steps forward');
    const cat = await page.evaluate(async () => (await import('/ui/settings.js')).getActions()
        .filter(a => a.id === 'nextFlaggedPose' || a.id === 'prevFlaggedPose').map(a => a.id + '=' + a.binding + (a.editable ? ' editable' : '')));
    check(JSON.stringify(cat) === JSON.stringify(['nextFlaggedPose=] editable', 'prevFlaggedPose=[ editable']), `listed in Settings ▸ Keyboard Shortcuts: ${JSON.stringify(cat)}`);
    await page.evaluate(() => window.__build());
    await page.evaluate(async () => { (await import('/ui/app-state.js')).state.currentFrame = 10; });
    r = await press(']');
    check(r.frame === 10 && r.status === 'No pose check on this session — run Track All or Tracks ▸ Check Poses first',
        `no check yet: says to run one, goes nowhere (${r.frame}, "${r.status}")`);

    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
}
console.log(fails ? `FAIL (${fails})` : 'PASS');
process.exit(fails ? 1 : 0);
