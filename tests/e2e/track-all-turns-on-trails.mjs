/**
 * track-all-turns-on-trails.mjs — when Track All finishes, node trails are
 * turned on at ¼ second (if they are off), in the real app: each animal's
 * recent path is where an identity switch shows.
 *
 * Fixture: two synthetic animals seen by three calibrated cameras over a few
 * frames (the rig of tests/e2e/track-all-switches-to-id.mjs). Asserted through
 * the real toolbar buttons and menus:
 *  1. With trails off, clicking Track All leaves them on at ¼ s: the state,
 *     the Trails button's blue and tooltip, the ¼ s checkmark in BOTH trail
 *     menus, and the status line, which says so.
 *  2. A length the user picked is left alone: with trails at 1 s, Track All
 *     keeps 1 s and does not claim to have turned trails on.
 *  3. Track Frame (one frame) does not turn trails on.
 *  4. Turning trails off after a Track All sticks until the next Track All,
 *     which turns them on again — the default it was asked for.
 *
 * Run: node tests/e2e/track-all-turns-on-trails.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerTrackSetup } from './fixtures/track-setup.js';

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
    await answerTrackSetup(page, 2);

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
        const session = new Session(CAMS, new Skeleton('sk', NODES, []), ['track_0', 'track_1'], 'TrackAllTrails');
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
    });

    const read = () => page.evaluate(() => {
        const checked = (sel) => [...document.querySelectorAll(sel)]
            .filter(el => el.querySelector('.trail-check').textContent === '✓')
            .map(el => el.querySelector('.trail-label').textContent);
        const btn = document.getElementById('tbTrails');
        return {
            sec: window.__lucid.state.trailSeconds,
            len: window.__lucid.state.trailLength,
            blue: btn.classList.contains('active'),
            tip: btn.title,
            toolbar: checked('#trailsMenu [data-trail-sec], #trailsMenu [data-trail-custom]'),
            menubar: checked('#menuTrailsSubmenu [data-trail-sec], #menuTrailsSubmenu [data-trail-custom]'),
            status: document.getElementById('statusText').textContent,
            identities: window.__lucid.state.session.identities.length,
        };
    });
    const runTrackAll = async () => {
        const before = await page.evaluate(() => document.getElementById('statusText').textContent);
        await page.click('#tbTrackAll');
        await page.waitForFunction(b => {
            const t = document.getElementById('statusText').textContent;
            return t !== b && /Assigned \d+ identities|error/i.test(t);
        }, before, { timeout: 30000 });
        // Track All ends on its summary box; close it as a user would.
        await page.click('#trackSummaryClose', { timeout: 30000 });
    };
    const pickLength = async (key) => {
        await page.click('.menu-item[data-menu="tracks"]');
        await page.hover('#menuTrailsParent');
        await page.click('#menuTrails' + key);
    };

    // ---- 1. off -> Track All -> ¼ s ---------------------------------------------------
    let t = await read();
    check(t.sec === 0 && !t.blue, 'precondition: trails are off');
    await runTrackAll();
    t = await read();
    check(t.identities === 2, `Track All assigned identities (${t.identities})`);
    check(t.sec === 0.25 && t.len === 8, `trails are on at ¼ s = ${t.len} frames at 30 fps (${t.sec} s)`);
    check(t.blue && t.tip === 'Node trails: ¼ second (8 frames)', `the Trails button is blue and says so ("${t.tip}")`);
    check(JSON.stringify(t.toolbar) === '["¼ second (8 frames)"]' && JSON.stringify(t.menubar) === '["¼ second (8 frames)"]',
        `¼ second is checked in both trail menus (${t.toolbar} / ${t.menubar})`);
    check(/node trails on \(¼ second\)/.test(t.status), `the status line says so: "${t.status}"`);

    // ---- 2. a length the user picked is kept -----------------------------------------
    await pickLength('Second');
    await runTrackAll();
    t = await read();
    check(t.sec === 1 && t.blue, `a 1 s trail the user picked is kept (${t.sec} s)`);
    check(!/node trails on/.test(t.status), `and the status does not claim to have turned trails on: "${t.status}"`);

    // ---- 3. Track Frame does not turn them on ----------------------------------------
    await pickLength('Off');
    await page.hover('#tbTrackAll'); await page.click('#tbTrackFrame');   // This frame, in the Track menu
    await page.waitForTimeout(300);
    t = await read();
    check(t.sec === 0 && !t.blue, 'Track Frame (one frame) leaves trails off');

    // ---- 4. off stays off until the next Track All, which turns them on again ---------
    await runTrackAll();
    t = await read();
    check(t.sec === 0.25 && t.blue, 'the next Track All turns them on at ¼ s again');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
