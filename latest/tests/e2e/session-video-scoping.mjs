/**
 * session-video-scoping.mjs — end-to-end regression test (real browser).
 *
 * Drives the actual app in headless Chromium and asserts that loading a video
 * into one session never leaks that video's view/camera/videoFileIndices into
 * another session. This is the regression guard for the multi-session
 * "second session shows both videos" bug (fixed in `handleLoadVideos` by
 * scoping camera/view creation to the videos loaded THIS call — `newVideoFiles`
 * — instead of the global `state.videoFiles`).
 *
 * How to run (see tests/e2e/README.md):
 *   1. cd tests/e2e && npm install        # installs playwright + chromium
 *   2. from the repo root: python3 -m http.server 8080
 *   3. node tests/e2e/session-video-scoping.mjs
 *      # or: BASE=http://localhost:8080 node tests/e2e/session-video-scoping.mjs
 *
 * Exit code 0 = all scenarios pass, 1 = a leak (or driver error) was detected.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const BASE = process.env.BASE || 'http://localhost:8080';
const BACK = [path.join(REPO, 'sample_session', 'back.mp4')];
const MID = [path.join(REPO, 'sample_session', 'mid.mp4')];

let failures = 0;
function check(cond, msg) {
    if (cond) { console.log('    ✓ ' + msg); }
    else { console.log('    ✗ ' + msg); failures++; }
}

async function getState(page) {
    return await page.evaluate(() => {
        const s = window.__lucid.state;
        const pm = window.__lucid.paneManager;
        return {
            active: s.activeSessionIdx,
            views: s.views.map(v => v.name),
            docked: (pm && pm.api) ? pm.api.panels.map(p => p.params && p.params.viewName) : [],
            sessions: s.sessions.map((se) => ({
                name: se.name,
                cams: se.cameras.map(c => c.name),
                vfi: se.videoFileIndices.slice(),
            })),
        };
    });
}
async function waitViews(page, min, timeout = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        if (await page.evaluate(() => window.__lucid.state.views.length) >= min) return true;
        await page.waitForTimeout(150);
    }
    throw new Error('timed out waiting for ' + min + ' view(s)');
}
const loadVideos = (page) => page.evaluate(() => document.getElementById('menuLoadVideos').click());
const addSession = (page) => page.click('#btnAddSession');
const switchTo = (page, idx) => page.evaluate((i) => {
    const el = document.querySelector(`.session-strip-item[data-session-idx="${i}"]`)
        || document.querySelectorAll('.session-strip-item')[i];
    if (!el) throw new Error('no session-strip item ' + i);
    el.click();
}, idx);

async function bootPage(browser, fileQueue) {
    const page = await browser.newPage();
    const q = fileQueue.slice();
    page.on('filechooser', async fc => { await fc.setFiles(q.shift() || []); });
    page.on('pageerror', e => { console.log('    [pageerror] ' + e.message); failures++; });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 15000 });
    await page.waitForTimeout(400);
    return page;
}

// Assert session `si` owns exactly the one camera/view/index it loaded.
function assertIsolated(st, si, expectedView) {
    const s = st.sessions[si];
    check(s.vfi.length === 1, `${s.name} owns exactly 1 videoFileIndex (got [${s.vfi}])`);
    check(s.cams.length === 1 && s.cams[0] === expectedView, `${s.name} has exactly camera [${expectedView}] (got [${s.cams}])`);
    if (st.active === si) {
        check(st.views.length === 1 && st.views[0] === expectedView, `active viewer shows only [${expectedView}] (got [${st.views}])`);
        check(st.docked.length === 1 && st.docked[0] === expectedView, `docked panels are only [${expectedView}] (got [${st.docked}])`);
    }
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    try {
        // Scenario A: + load(back), + load(mid) — then switch back and forth.
        console.log('  Scenario A: +load back, +load mid, switch s0<->s1');
        {
            const page = await bootPage(browser, [BACK, MID]);
            await addSession(page); await page.waitForTimeout(200);
            await loadVideos(page); await waitViews(page, 1); await page.waitForTimeout(500);
            await addSession(page); await page.waitForTimeout(200);
            await loadVideos(page); await waitViews(page, 1); await page.waitForTimeout(500);
            let st = await getState(page);
            assertIsolated(st, 1, 'mid');
            assertIsolated(st, 0, 'back');
            await switchTo(page, 0); await page.waitForTimeout(1200);
            assertIsolated(await getState(page), 0, 'back');
            await switchTo(page, 1); await page.waitForTimeout(1200);
            assertIsolated(await getState(page), 1, 'mid');
            await page.close();
        }

        // Scenario B: load into boot session (no +), then + load into session 2.
        console.log('  Scenario B: load back (boot), +load mid');
        {
            const page = await bootPage(browser, [BACK, MID]);
            await loadVideos(page); await waitViews(page, 1); await page.waitForTimeout(500);
            await addSession(page); await page.waitForTimeout(200);
            await loadVideos(page); await waitViews(page, 1); await page.waitForTimeout(500);
            const st = await getState(page);
            assertIsolated(st, 1, 'mid');
            assertIsolated(st, 0, 'back');
            await page.close();
        }
    } finally {
        await browser.close();
    }
}

await main();
console.log(failures === 0
    ? '\nPASS: no cross-session video leaks.'
    : `\nFAIL: ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
