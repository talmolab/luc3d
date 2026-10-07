/**
 * track-all-switches-to-id.mjs — after Track All, the toolbar's Color toggle
 * moves from "Tracks" to "ID" (#242), in the real app.
 *
 * Fixture: two synthetic animals seen by three calibrated cameras over a few
 * frames (the same rig as tests/test-tracker-gui.mjs). Asserted through the
 * real toolbar buttons:
 *  1. With Color on Tracks, clicking Track All assigns identities and leaves
 *     the toggle on ID (button highlight AND `state.colorByIdentity`), and the
 *     status line says it switched.
 *  2. The 3D viewer is recolored on the spot (`update3DViewport` runs for the
 *     switch), not only on the next frame change.
 *  3. The user can still switch back to Tracks with the button, and a Track
 *     Frame (single frame) does NOT flip it again.
 *  4. Running Track All with Color already on ID changes nothing and does not
 *     claim a switch.
 *
 * Run: node tests/e2e/track-all-switches-to-id.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8265);
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
        const session = new Session(CAMS, new Skeleton('sk', NODES, []), ['track_0', 'track_1'], 'TrackAllColor');
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

    const toggle = () => page.evaluate(() => ({
        tracks: document.getElementById('colorByTracks').classList.contains('active'),
        id: document.getElementById('colorById').classList.contains('active'),
        state: !!window.__lucid.state.colorByIdentity,
        status: document.getElementById('statusText').textContent,
        identities: window.__lucid.state.session.identities.length,
        threeD: window.__3d,
    }));
    const runTrackAll = async () => {
        const before = await page.evaluate(() => document.getElementById('statusText').textContent);
        await page.click('#tbTrackAll');
        await page.waitForFunction(b => {
            const t = document.getElementById('statusText').textContent;
            return t !== b && /Assigned \d+ identities|error/i.test(t);
        }, before, { timeout: 30000 });
    };

    // ---- 1 + 2. Tracks -> Track All -> ID -----------------------------------------
    await page.click('#colorByTracks');
    let t = await toggle();
    check(t.tracks && !t.id && !t.state, 'precondition: Color is on Tracks');
    const threeDBefore = t.threeD;
    await runTrackAll();
    t = await toggle();
    check(t.identities === 2, `Track All assigned identities (${t.identities})`);
    check(t.id && !t.tracks && t.state, 'after Track All the toggle is on ID (button and state)');
    check(/now coloring by ID/.test(t.status), `status says so: "${t.status}"`);
    const hasViewer = await page.evaluate(async () => !!(await import('/ui/app-state.js')).viewport3d);
    if (hasViewer) check(t.threeD > threeDBefore, `the 3D viewer was refreshed for the recolor (${threeDBefore} -> ${t.threeD})`);
    else console.log('  - no 3D viewer in this build; skipped the 3D recolor check');

    // ---- 3. user can switch back; Track Frame does not flip it -------------------------
    await page.click('#colorByTracks');
    t = await toggle();
    check(t.tracks && !t.id && !t.state, 'the Tracks button still switches back');
    await page.click('#tbTrackFrame');
    await page.waitForTimeout(300);
    t = await toggle();
    check(t.tracks && !t.state, 'Track Frame (one frame) leaves Color on Tracks');

    // ---- 4. Track All with Color already on ID ------------------------------------------
    await page.click('#colorById');
    await runTrackAll();
    t = await toggle();
    check(t.id && t.state, 'Color stays on ID');
    check(!/now coloring by ID/.test(t.status), `status does not claim a switch: "${t.status}"`);

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
