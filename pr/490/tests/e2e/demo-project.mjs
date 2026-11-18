/**
 * demo-project.mjs — File ▸ Open Demo (`loading/demo-project.js`): the SLAP-2M
 * clip in talmolab/slap-2m's `demo/` folder, read from the pinned commit
 * (the harness caches pinned Hugging Face files on disk).
 *
 * §1  An empty app offers the demo: the dock button and the File menu item.
 * §2  `?demo` opens it: 8 cameras, 450 frames, two animals' 2D in the six
 *     proofread cameras, the calibration, the project's name in the tab, and
 *     nothing unsaved. The dock button is gone.
 * §3  Every file is as large as `DEMO_FILES` says (the progress bar's total),
 *     so a re-uploaded file with a moved pin cannot go unnoticed.
 * §4  File ▸ Open Demo over an open project asks first, then REPLACES it (one
 *     session, not two); a refusal keeps the project as it was.
 * §5  File ▸ New Project empties the session list and strip (it used to keep
 *     the old sessions, so the next folder loaded joined them) and the dirty
 *     flag, and the dock offers the demo again.
 *
 * Run: node tests/e2e/demo-project.mjs
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const server = await startServer(repoRoot);
const PORT = server.port;

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const summary = () => {
    const s = window.__lucid.state;
    const ses = s.session;
    const perCam = {};
    if (ses) {
        for (const fg of ses.frameGroups.values()) {
            for (const map of [fg.instances, fg.unlinkedInstances]) {
                for (const [cam, list] of map || []) perCam[cam] = (perCam[cam] || 0) + list.length;
            }
        }
    }
    return {
        sessions: s.sessions.length,
        views: s.views.map(v => v.name),
        cameras: ses ? ses.cameras.length : 0,
        frames: s.totalFrames,
        perCam,
        title: document.title,
        dirty: s.isDirty,
        btnHidden: document.getElementById('dockDemoBtn').hidden,
    };
};

let browser;
try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    console.log('§1 an empty app offers the demo');
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    check(await page.isVisible('#dockDemoBtn'), 'the empty dock shows "Open the demo"');
    check(await page.locator('#menuOpenDemo').count() === 1, 'File ▸ Open Demo exists');

    console.log('\n§2 ?demo opens it');
    await page.goto(`http://localhost:${PORT}/index.html?demo`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state.session &&
        window.__lucid.state.views.length === 8, null, { timeout: 120000 });
    const s = await page.evaluate(summary);
    check(s.sessions === 1, `one session (${s.sessions})`);
    check(s.views.join() === 'back,backL,mid,midL,side,sideL,top,topL', `the eight cameras, in calibration order (${s.views.join()})`);
    check(s.cameras === 8, `the calibration's 8 cameras (${s.cameras})`);
    check(s.frames === 450, `450 frames (${s.frames})`);
    const proofread = ['back', 'backL', 'mid', 'midL', 'top', 'topL'];
    check(proofread.every(c => s.perCam[c] === 900), `two animals in every frame of the six proofread cameras (${JSON.stringify(s.perCam)})`);
    check(!s.perCam.side && !s.perCam.sideL, 'no 2D in side / sideL (none in the dataset)');
    check(s.title === 'SLAP-2M demo - LUC3D', `the tab is named for the demo (${s.title})`);
    check(!s.dirty, 'nothing unsaved');
    check(s.btnHidden, 'the dock button is gone once the demo is open');

    console.log('\n§3 each file is the size DEMO_FILES says');
    const sizes = await page.evaluate(async () => {
        const m = await import(new URL('loading/demo-project.js', document.baseURI).href);
        let last = null;
        const files = await m.fetchDemoFiles(m.DEMO_BASE_URL, (done, total) => { last = [done, total]; });
        return {
            pinned: /\/resolve\/[0-9a-f]{40}\/demo\/$/.test(m.DEMO_BASE_URL),
            bad: files.map((f, i) => [m.DEMO_FILES[i][0], f.size, m.DEMO_FILES[i][1], f.webkitRelativePath])
                .filter(([rel, got, want, wrp]) => got !== want || wrp !== m.DEMO_PROJECT_NAME + '/' + rel),
            last,
        };
    });
    check(sizes.pinned, 'DEMO_BASE_URL is pinned to a commit');
    check(sizes.bad.length === 0, `sizes and relative paths match (${JSON.stringify(sizes.bad)})`);
    check(sizes.last && sizes.last[0] === sizes.last[1], `the byte count ends at the total (${sizes.last})`);

    console.log('\n§4 Open Demo over an open project asks, then replaces it');
    await page.evaluate(() => { window.__lucid.state.isDirty = true; });
    let asked = null;
    page.once('dialog', d => { asked = d.message(); d.dismiss(); });
    await page.evaluate(() => { document.getElementById('menuOpenDemo').click(); });
    const kept = await page.evaluate(() => ({ sessions: window.__lucid.state.sessions.length, dirty: window.__lucid.state.isDirty }));
    check(asked && /unsaved/i.test(asked), `it asked first (${asked})`);
    check(kept.sessions === 1 && kept.dirty, 'Cancel keeps the project as it was');

    page.once('dialog', d => d.accept());
    await page.evaluate(() => { window.__demoSessionBefore = window.__lucid.state.session; document.getElementById('menuOpenDemo').click(); });
    await page.waitForFunction(() => window.__lucid.state.session && window.__lucid.state.session !== window.__demoSessionBefore &&
        window.__lucid.state.views.length === 8 && !document.getElementById('loadingOverlay').offsetParent, null, { timeout: 120000 });
    const r = await page.evaluate(summary);
    check(r.sessions === 1, `still one session, not two (${r.sessions})`);
    check(r.frames === 450 && !r.dirty, 'the demo, freshly opened');

    console.log('\n§5 File ▸ New Project closes the demo entirely');
    page.once('dialog', d => d.accept());
    await page.evaluate(() => {
        window.__lucid.state.isDirty = true;
        document.getElementById('menuNewProject').click();
    });
    const n = await page.evaluate(() => {
        return {
            sessions: window.__lucid.state.sessions.length,
            strip: document.querySelectorAll('#sessionStripList .session-strip-item').length,
            dirty: window.__lucid.state.isDirty,
            btn: !document.getElementById('dockDemoBtn').hidden,
        };
    });
    check(n.sessions === 0 && n.strip === 0, `no session left in the list or on the strip (${n.sessions}, ${n.strip})`);
    check(!n.dirty, 'nothing unsaved');
    check(n.btn, 'the empty dock offers the demo again');
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
