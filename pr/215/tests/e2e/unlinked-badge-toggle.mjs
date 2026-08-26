/**
 * unlinked-badge-toggle.mjs — the Visibility panel's "Show ? badge" toggle.
 *
 * tests/test-unlinked-badge.js covers the DRAW half (drawUnlinkedInstances
 * honouring `showUnlinkedBadge`). This covers the wiring that connects a real
 * checkbox to it, which that test cannot reach:
 *
 *   checkbox -> getVisibilitySettings().showUnlinkedBadge
 *            -> drawAllOverlays -> drawFrameOverlays -> drawUnlinkedInstances
 *   checkbox -> localStorage (survives a reload)
 *
 * The failure this guards against is a toggle that looks right and does nothing
 * — wired into the DOM but missing from `visCheckIds` (so it forgets), or missing
 * from the change-listener list (so the canvas doesn't repaint until you nudge
 * the frame), or read from the wrong element id (so it silently reads `true`
 * forever). Each of those is invisible in a unit test and invisible on a
 * screenshot taken right after clicking.
 *
 * It also asserts the DEFAULT is on, because the badge is an editing affordance:
 * a regression that flipped the default would quietly remove it for everyone.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8137);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // ---- a session with ONE unlinked instance in one view -------------------
    // Needed for the repaint assertion below to mean anything: with no views,
    // drawAllOverlays iterates nothing and paints nothing, so a "did it repaint"
    // probe would pass or fail for reasons unrelated to the toggle.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, UnlinkedInstance, FrameGroup, Session } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = [new Camera('cam1', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])];
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const session = new Session(cams, skel, ['t0'], 'BadgeTest');

        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        // Well away from the canvas edges so the badge (offset up-left by
        // 2*nodeSize, radius 10) cannot be clipped out of the pixels we count.
        const inst = new Instance([[200, 200], [260, 260]], 0, 'user', 0);
        fg.addUnlinkedInstance('cam1', new UnlinkedInstance(inst, 'cam1'));

        const oc = document.createElement('canvas');
        oc.width = 640; oc.height = 480;
        document.body.appendChild(oc);
        window.__overlayCanvas = oc;

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 1;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = [{
            name: 'cam1', decoder: null, canvas: null, ctx: null,
            overlayCanvas: oc, overlayCtx: oc.getContext('2d'),
            videoWidth: 640, videoHeight: 480, zoom: { scale: 1 },
        }];
    });

    // Amber "?" glyph pixels on the overlay canvas. Small by design — the badge
    // disc is black, only the glyph is amber (see tests/test-unlinked-badge.js).
    const amber = () => page.evaluate(() => {
        const c = window.__overlayCanvas;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] === 0) continue;
            if (Math.abs(d[i] - 0xfb) < 40 && Math.abs(d[i + 1] - 0xbf) < 40 && Math.abs(d[i + 2] - 0x24) < 40) n++;
        }
        return n;
    });

    // ---- the control exists, in the Visibility panel, on by default ---------
    const box = await page.evaluate(() => {
        const el = document.getElementById('visUnlinkedBadge');
        if (!el) return null;
        const tab = document.getElementById('tabVisibility');
        return {
            checked: el.checked,
            inVisTab: !!(tab && tab.contains(el)),
            label: (el.closest('.vis-slider-row') || {}).textContent?.trim() || null,
        };
    });
    check(box !== null, 'the #visUnlinkedBadge control exists');
    check(box && box.checked === true, 'it is ON by default — the badge is an affordance, not opt-in');
    // Must live inside #tabVisibility: that container carries the DELEGATED
    // change/input listener that persists every vis control. Outside it, the
    // toggle would work but silently never save.
    check(box && box.inVisTab, 'it sits inside #tabVisibility, so the delegated save listener sees it');
    check(box && /badge/i.test(box.label || ''), `its row is labelled (got ${JSON.stringify(box && box.label)})`);

    // ---- getVisibilitySettings reflects it ---------------------------------
    const readSetting = async () => page.evaluate(async () => {
        const R = await import('/ui/rendering.js');
        return R.getVisibilitySettings().showUnlinkedBadge;
    });
    check((await readSetting()) === true, 'getVisibilitySettings() reports true while ticked');

    // ---- the badge really is painted while the toggle is on -----------------
    await page.evaluate(async () => {
        const R = await import('/ui/rendering.js');
        R.drawAllOverlays(0);
    });
    const amberOn = await amber();
    check(amberOn > 3, `the badge is painted on the overlay canvas while ticked (${amberOn} amber px)`);

    // ---- untick: the setting flips AND the canvas repaints without it -------
    // The toggle must repaint by itself. A wiring bug where it is missing from
    // the change-listener list leaves the OLD pixels on screen until the user
    // happens to step a frame — which looks exactly like "the toggle is broken".
    // So: do NOT call drawAllOverlays here; only dispatch the change.
    await page.evaluate(() => {
        const el = document.getElementById('visUnlinkedBadge');
        el.checked = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(400);

    check((await readSetting()) === false, 'unticking flips getVisibilitySettings() to false');
    const amberOff = await amber();
    check(amberOff === 0,
        `the change repaints on its own and the badge is gone (${amberOff} amber px, no manual redraw)`);

    // …and the instance itself is still drawn — hiding the badge must not hide
    // the detection it was pointing at.
    const inkOff = await page.evaluate(() => {
        const c = window.__overlayCanvas;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
    });
    check(inkOff > 0, `the unlinked instance is still rendered without its badge (${inkOff} inked px)`);

    // ---- it persists ------------------------------------------------------
    const stored = await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) {
            let v;
            try { v = JSON.parse(localStorage.getItem(k)); } catch (e) { continue; }
            if (v && typeof v === 'object' && 'visUnlinkedBadge' in v) {
                return { key: k, value: v.visUnlinkedBadge };
            }
        }
        return null;
    });
    check(stored !== null, 'the unticked state is written to localStorage (it is in visCheckIds)');
    check(stored && stored.value === false, `and stored as false (got ${JSON.stringify(stored && stored.value)})`);

    // ---- and survives a reload -------------------------------------------
    await page.reload();
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    const afterReload = await page.evaluate(() => {
        const el = document.getElementById('visUnlinkedBadge');
        return el ? el.checked : null;
    });
    check(afterReload === false, 'the toggle is still off after a reload');
    check((await readSetting()) === false, 'and getVisibilitySettings() agrees after the reload');

    // ---- re-ticking restores it ------------------------------------------
    await page.evaluate(() => {
        const el = document.getElementById('visUnlinkedBadge');
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(400);
    check((await readSetting()) === true, 're-ticking restores the setting');
    // The reload wiped the synthetic session, so rebuild just enough to repaint
    // and confirm the badge comes BACK — a one-way toggle would pass every
    // assertion above.
    const amberBack = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const R = await import('/ui/rendering.js');
        const { Skeleton, Camera, Instance, UnlinkedInstance, FrameGroup, Session } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const session = new Session(
            [new Camera('cam1', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])],
            new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0'], 'BadgeTest');
        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        fg.addUnlinkedInstance('cam1',
            new UnlinkedInstance(new Instance([[200, 200], [260, 260]], 0, 'user', 0), 'cam1'));
        const oc = document.createElement('canvas');
        oc.width = 640; oc.height = 480;
        document.body.appendChild(oc);
        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 1;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = [{
            name: 'cam1', decoder: null, canvas: null, ctx: null,
            overlayCanvas: oc, overlayCtx: oc.getContext('2d'),
            videoWidth: 640, videoHeight: 480, zoom: { scale: 1 },
        }];
        R.drawAllOverlays(0);
        const d = oc.getContext('2d').getImageData(0, 0, oc.width, oc.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] === 0) continue;
            if (Math.abs(d[i] - 0xfb) < 40 && Math.abs(d[i + 1] - 0xbf) < 40 && Math.abs(d[i + 2] - 0x24) < 40) n++;
        }
        return n;
    });
    check(amberBack > 3, `and the badge is painted again (${amberBack} amber px)`);

    console.log('');
    check(errs.length === 0, 'no page errors / console errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}

console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
