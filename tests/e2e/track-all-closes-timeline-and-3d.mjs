/**
 * track-all-closes-timeline-and-3d.mjs — Track All closes the Timeline and the
 * 3D viewer if they are open, in the real app.
 *
 * Fixture: the two-animal, three-camera rig from track-all-switches-to-id.mjs.
 * Asserted through the real toolbar buttons:
 *  1. Both open -> Track All -> both collapsed: the Timeline button no longer
 *     reads active, the 3D button reads "Show 3D View", and the 3D render loop
 *     is paused (Viewport3D.setVisible(false)), not just hidden.
 *  2. Reopening each with its button restores the size it had before.
 *  3. Both already closed -> Track All leaves them closed (never OPENS them).
 *  4. Track Frame Range and Track Frame leave both open.
 *
 * Run: node tests/e2e/track-all-closes-timeline-and-3d.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8266);
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
    // Track All / Track Frame ask for the animal count the first time.
    page.on('dialog', d => d.accept('2'));

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, FrameGroup, Session } = pd;
        const NODES = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
        const OFFSETS = [[0, 0, 0], [2, 1, 0], [-2, 1, 0], [0, -2, 1], [1.5, 0, -1.5], [-1.5, 0, 1.5]];
        const cam = (name, rvec, tvec) =>
            new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
        const CAMS = [cam('c0', [0, 0, 0], [0, 0, 0]), cam('c1', [0, 0.35, 0], [-12, 0, 3]), cam('c2', [0.35, 0, 0], [0, -12, 3])];
        const session = new Session(CAMS, new Skeleton('sk', NODES, []), ['track_0', 'track_1'], 'TrackAllTimeline');
        for (let f = 0; f < 4; f++) {
            const fg = new FrameGroup(f);
            [[-7 + 0.3 * f, 0, 48], [7 - 0.3 * f, 0, 48]].forEach((ctr, ai) => CAMS.forEach(c =>
                fg.addInstance(c.name, new Instance(
                    OFFSETS.map(o => c.project([ctr[0] + o[0], ctr[1] + o[1], ctr[2] + o[2]])), ai, 'predicted', 1.0))));
            session.addFrameGroup(fg);
        }
        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 4;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = [];
        // Count 3D refreshes: the viewer must be recolored when Color switches.
        // It is created lazily by the first update3DViewport (calibrated
        // session + visible panel), so build it now, then watch setFrame —
        // update3DViewport is imported by value elsewhere and cannot be patched.
        (await import('/pose/initialization.js')).update3DViewport(0);
        window.__3d = 0;
        const v3d = AS.viewport3d;   // live binding: read after the init above
        if (v3d && typeof v3d.setFrame === 'function') {
            const orig = v3d.setFrame.bind(v3d);
            v3d.setFrame = (...a) => { window.__3d++; return orig(...a); };
        }
    });

    const tl = () => page.evaluate(() => {
        const c = document.getElementById('timelineContainer');
        const b = document.getElementById('timelineToggleBtn');
        return { collapsed: c.classList.contains('collapsed'), height: c.getBoundingClientRect().height,
                 btnActive: !!(b && b.classList.contains('active')) };
    });
    const v3 = () => page.evaluate(async () => {
        const c = document.getElementById('viewport3dContainer');
        const v = (await import('/ui/app-state.js')).viewport3d;
        return { collapsed: c.classList.contains('collapsed'), width: c.getBoundingClientRect().width,
                 label: document.getElementById('viewport3dToggleBtn').textContent,
                 rendering: v ? v._visible !== false : null };
    });
    const openTimeline = async () => { if ((await tl()).collapsed) await page.click('#timelineToggleBtn'); };
    const open3d = async () => { if ((await v3()).collapsed) await page.click('#viewport3dToggleBtn'); };
    const runTrackAll = async () => {
        const before = await page.evaluate(() => document.getElementById('statusText').textContent);
        await page.click('#tbTrackAll');
        await page.waitForFunction(b => {
            const t = document.getElementById('statusText').textContent;
            return t !== b && /Assigned \d+ identities|error/i.test(t);
        }, before, { timeout: 30000 });
        // Track All ends on its summary box (tests/e2e/track-all-summary.mjs); close it as a user would.
        await page.click('#trackSummaryClose', { timeout: 30000 });
    };

    // ---- 1. open -> Track All -> closed --------------------------------------------------
    await openTimeline();
    await open3d();
    await page.evaluate(() => {
        document.getElementById('timelineContainer').style.height = '180px';
        document.getElementById('viewport3dContainer').style.width = '320px';
    });
    await page.waitForTimeout(400);   // width transition
    let s = await tl();
    check(!s.collapsed && s.height > 0, `precondition: Timeline is open (${s.height}px)`);
    const openHeight = s.height;
    let d = await v3();
    check(!d.collapsed && d.width > 0 && d.label === 'Hide 3D View', `precondition: 3D viewer is open (${d.width}px)`);
    const openWidth = d.width;
    await runTrackAll();
    const ids = await page.evaluate(() => window.__lucid.state.session.identities.length);
    check(ids === 2, `Track All assigned identities (${ids})`);
    s = await tl();
    check(s.collapsed && s.height === 0, `after Track All the Timeline is collapsed (${s.height}px)`);
    check(!s.btnActive, 'the Timeline toolbar button no longer reads active');
    await page.waitForTimeout(100);   // let the MutationObserver relabel the button
    d = await v3();
    check(d.collapsed, 'after Track All the 3D viewer is collapsed');
    check(d.label === 'Show 3D View', `the 3D toolbar button reads "${d.label}"`);
    if (d.rendering === null) console.log('  - no Viewport3D instance in this build; skipped the render-loop check');
    else check(d.rendering === false, 'the 3D render loop is paused, not just hidden');

    // ---- 2. reopening restores the prior height -------------------------------------------
    await page.click('#timelineToggleBtn');
    s = await tl();
    check(!s.collapsed && Math.abs(s.height - openHeight) < 1, `reopening restores ${openHeight}px (${s.height}px)`);
    check(s.btnActive, 'and the button reads active again');
    await page.click('#viewport3dToggleBtn');
    await page.waitForTimeout(400);   // width transition
    d = await v3();
    check(!d.collapsed && Math.abs(d.width - openWidth) < 1, `reopening the 3D viewer restores ${openWidth}px (${d.width}px)`);
    if (d.rendering !== null) check(d.rendering === true, 'and its render loop resumes');

    // ---- 3. already closed -> stays closed ---------------------------------------------------
    await page.click('#timelineToggleBtn');
    await page.click('#viewport3dToggleBtn');
    check((await tl()).collapsed && (await v3()).collapsed, 'precondition: Timeline and 3D viewer closed by the user');
    await runTrackAll();
    check((await tl()).collapsed, 'Track All leaves a closed Timeline closed (does not toggle it open)');
    check((await v3()).collapsed, 'Track All leaves a closed 3D viewer closed (does not toggle it open)');

    // ---- 4. Track Frame Range / Track Frame leave it open ------------------------------------
    await openTimeline();
    await open3d();
    await page.evaluate(async () => { await (await import('/pose/tracker.js')).trackFrameRange(0, 2); });
    check(!(await tl()).collapsed && !(await v3()).collapsed, 'Track Frame Range leaves the Timeline and 3D viewer open');
    await page.click('#tbTrackFrame');
    await page.waitForTimeout(300);
    check(!(await tl()).collapsed && !(await v3()).collapsed, 'Track Frame leaves the Timeline and 3D viewer open');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
