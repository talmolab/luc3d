/**
 * track-all-pose-check.mjs — Track All's 2D pose check (pose/pose-check.js,
 * pose/pose-check-session.js), in the real app: an outlier pose is counted in
 * the summary, marked in its view, explained on hover — and left out of
 * tracking when the Tracking Wizard says so.
 *
 * The scene (tests/e2e/fixtures/pose-check-scene.js): two articulated animals in
 * front of three calibrated cameras for 65 s at 30 fps, with four planted outlier
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
import { installPoseCheckScene, planted as plantedIn, showViews as showViewsIn, badgePixels as badgePixelsIn, tipOn as tipOnIn, RED, AMBER } from './fixtures/pose-check-scene.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8327);
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
    // The shared probes (tests/e2e/fixtures/pose-check-scene.js), bound to this page.
    const planted = () => plantedIn(page);
    const showViews = (frame) => showViewsIn(page, frame);
    const badgePixels = (cam, frame, which, color) => badgePixelsIn(page, cam, frame, which, color);
    const tipOn = (cam, frame, which) => tipOnIn(page, cam, frame, which);

    const summary = () => page.evaluate(() => {
        const o = document.getElementById('trackSummaryOverlay');
        if (!o) return null;
        return Array.from(o.querySelectorAll('.track-summary-stat')).map(r => ({
            text: Array.from(r.children).map(c => c.textContent).join('|'), title: r.title || (r.querySelector('[title]') || {}).title || '' }));
    });
    const closeSummary = () => page.evaluate(() => { const b = document.getElementById('trackSummaryClose'); if (b) b.click(); });
    const setThresholds = (th) => page.evaluate(async (th) => (await import('/ui/settings.js')).setTrackingThresholds(Object.assign({ autoSwitchCheck: 0 }, th)), th);

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
