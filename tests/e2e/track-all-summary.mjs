/**
 * track-all-summary.mjs — the box that opens when Track All finishes
 * (ui/track-summary-modal.js, text from ui/track-summary.js), in the real app.
 *
 * Fixture A (tracked by the REAL tracker): two animals of different size, three
 * calibrated cameras, 65 s at 30 fps, kept apart — so the automatic body-size
 * check runs and finds nothing, the case where the next step used to be unclear.
 *  1. Clicking Track All opens ONE summary: identities for the animal count,
 *     frames tracked, frames with both animals, how long tracking took (with its
 *     fps and real-time multiplier), what the 2D pose check flagged, a row per
 *     identity, the body-size check "No close encounters to check" with its own
 *     time, the image check "Not run" (no time), and a Next step that says size cannot separate similar animals —
 *     with Default Triangulation… as the focused primary button and "Check by images…"
 *     beside it.
 *  2. While it is open the app's shortcuts do not act under it (`p` leaves
 *     Predicted alone); Esc closes it, and the shortcut works again after.
 *  2b. Closed, it can be reopened: the ID Switches tab has "Show Track All
 *     summary" ABOVE "Possible ID switches", which reopens the same box. A check
 *     run after it was closed is reported there (not "Not run", and no longer
 *     offered); after Clear both read "Not run" and the button stays; a session
 *     with no Track All has no button.
 *  2c. A check started from the box's own buttons comes BACK to the box when it
 *     ends, instead of leaving the user on the ID Switches tab: "Check by body
 *     size" (the real menu item) reopens it with that row filled in and its time;
 *     "Check by images…" cancelled with Esc reopens it reading "Cancelled" and
 *     still offering the check; run again, it reopens with the image row filled
 *     in and "Neither check flagged an ID switch." The tab is never opened.
 *  3. Enter presses the focused primary: the box closes, Settings opens on Default
 *     Triangulation, and nothing is triangulated. The panel's Triangulate All is
 *     on that panel only; with an edit pending it reads "Apply & Triangulate All"
 *     and stores the edit before running; it closes Settings and runs Triangulate All.
 *  4. A second Track All replaces the box rather than stacking another.
 *  5. Track Frame Range does not open it.
 * Fixture B (one camera sees nothing): nothing is matched across views.
 *  6. The summary says "Nothing was tracked.", lists no checks, and its primary
 *     opens the Tracking Wizard. Its 60 frames are too few for the 2D pose check
 *     to learn from, and its row says "Not checked".
 * Fixture C (labels swapped after one encounter, as in track-auto-size-switch-check):
 *  7. With a switch found, the primary is "Review switches": it closes the box,
 *     shows the ID Switches tab and lands on the first flagged switch.
 *  8. With neither check run by the pass, the box's "Check by images…" finds the
 *     switch: the box comes back saying so, with "Review switches" as its primary
 *     (the tab still shut until that is pressed).
 *
 * Run: node tests/e2e/track-all-summary.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerTrackSetup } from './fixtures/track-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8291);
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
    await answerTrackSetup(page, 2);   // Track All asks for the animal count the first time
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    await page.evaluate(() => {
        // Fixture A, or B with `blindCam` (that camera sees no animal, so nothing is matched).
        window.__buildTrackable = async (name, opts) => {
            opts = opts || {};
            const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
            const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
                'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
            const T = { Nose: [45, 0, 0], Ear_R: [25, -11, 4], Ear_L: [25, 11, 4], Head: [30, 0, 3], Neck: [20, 0, 2],
                Trunk: [-5, 0, 4], TTI: [-40, 0, 0], Shoulder_left: [10, 12, 0], Shoulder_right: [10, -12, 0],
                Haunch_left: [-25, 15, 0], Haunch_right: [-25, -15, 0], Tail_0: [-65, 0, 0], Tail_1: [-88, 0, 0],
                Tail_2: [-110, 0, 0], TailTip: [-132, 0, 0] };
            const cam = (n, rvec, tvec) => new pd.Camera(n, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
            const CAMS = opts.blindCam
                ? [cam('c0', [0, 0, 0], [0, 0, 0]), cam('c1', [0, 0.35, 0], [-12, 0, 3])]
                : [cam('c0', [0, 0, 0], [0, 0, 0]), cam('c1', [0, 0.35, 0], [-12, 0, 3]), cam('c2', [0.35, 0, 0], [0, -12, 3])];
            const s = new pd.Session(CAMS, new pd.Skeleton('mouse', NODES, []), ['track_0', 'track_1'], name);
            const FRAMES = opts.frames || 65 * 30, SC = [0.05, 0.06];
            for (let f = 0; f < FRAMES; f++) {
                const fg = new pd.FrameGroup(f);
                [[-8, 0, 48], [8, 0, 48]].forEach((c0, ai) => {
                    const ctr = [c0[0] + 0.6 * Math.sin(f / 90 + ai), c0[1] + 0.6 * Math.cos(f / 70 + ai), c0[2]];
                    const h = f / 200 + ai * 2, ch = Math.cos(h), sh = Math.sin(h);
                    const pts3 = NODES.map(n => { const [x, y, z] = T[n].map(v => v * SC[ai]); return [ctr[0] + ch * x - sh * y, ctr[1] + sh * x + ch * y, ctr[2] + z]; });
                    CAMS.forEach(c => { if (c.name !== 'c1' || !opts.blindCam) fg.addInstance(c.name, new pd.Instance(pts3.map(p => c.project(p)), ai, 'predicted', 1.0)); });
                });
                s.addFrameGroup(fg);
            }
            AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
            AS.state.totalFrames = FRAMES; AS.state.currentFrame = 0; AS.state.views = []; AS.state.fps = 30;
            AS.state.triangulationResults = new Map();
            if (AS.timeline) { AS.timeline.setTotalFrames(FRAMES); AS.timeline.setData(s); }
            return FRAMES;
        };
        // A stand-in for the image model (no GPU, no download): a seeded appearance vector per animal plus
        // noise, from 4 cameras. The animal is the fixture's truth (`_animal`, Fixture C) or else the identity.
        // While `__gate` is a pending promise it waits before the check starts, so a test can cancel it.
        window.__gate = null;
        window.__fakeImg = async () => {
            if (window.__gate) await window.__gate;
            let seed = 11; const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
            const g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
            const proto = new Map(), cams = ['c0', 'c1', 'c2', 'c3'];
            const look = (grp) => { const key = grp._animal != null ? grp._animal : 'id' + grp.identityId;
                if (!proto.has(key)) proto.set(key, Float32Array.from({ length: 64 }, g)); return proto.get(key); };
            return { views: cams, getEmbeddings: async (frame, items) => items.map(it => { const p = look(it.group);
                return cams.map(cam => ({ camera: cam, vector: Float32Array.from(p, v => v + 1.2 * g()) })); }) };
        };
        // Tracks ▸ Check ID Switches (Images) wired as ui/ui-wiring.js wires it, with the stand-in model: the
        // summary's button clicks the menu item, so this is the only part of that path a test replaces.
        window.__useFakeImageMenu = async (on) => {
            const M = await import('/ui/id-switch-modal.js');
            const item = document.getElementById('menuCheckImageSwitches');
            if (!on) { if (window.__realImageMenu) item.replaceWith(window.__realImageMenu); window.__realImageMenu = null; return; }
            const copy = item.cloneNode(true);
            copy.addEventListener('click', () => { window.__imgDone = M.runIdSwitchChecks({ image: true, inject: { createEmbedder: window.__fakeImg } }); });
            window.__realImageMenu = item; item.replaceWith(copy);
        };
    });

    const summary = () => page.evaluate(() => {
        const ov = document.querySelectorAll('#trackSummaryOverlay');
        const o = ov[0];
        if (!o) return { count: 0 };
        const txt = (sel) => Array.from(o.querySelectorAll(sel)).map(e => e.textContent.trim());
        return {
            count: ov.length,
            title: o.querySelector('h3').textContent,
            stats: Array.from(o.querySelectorAll('.track-summary-stat')).map(r =>
                Array.from(r.children).map(c => c.textContent).join('|')),
            ids: Array.from(o.querySelectorAll('.track-summary-id')).map(r =>
                r.querySelector('.track-summary-id-name').textContent + ' ' + r.querySelector('.track-summary-id-share').textContent),
            checks: Array.from(o.querySelectorAll('.track-summary-check')).map(r => ({
                cue: r.dataset.cue, cls: r.className, text: r.querySelector('.track-summary-check-text').textContent,
                time: r.querySelector('.track-summary-check-time').textContent })),
            headline: (o.querySelector('.track-summary-headline') || {}).textContent || '',
            caveat: (o.querySelector('.track-summary-caveat') || {}).textContent || '',
            steps: txt('.track-summary-steps li, .track-summary-steps p'),
            buttons: Array.from(o.querySelectorAll('.modal-actions button')).map(b => b.textContent),
            primary: (o.querySelector('#trackSummaryPrimary') || {}).textContent,
            focused: document.activeElement && document.activeElement.id,
        };
    });
    const statusText = () => page.evaluate(() => document.getElementById('statusText').textContent);

    // ---- 1. Track All (the real button) -> the summary --------------------------------------
    await page.evaluate(async () => { await window.__buildTrackable('A'); (await import('/pose/tracker.js')).setTrackerNumAnimals(2); });
    await page.click('#tbTrackAll');
    await page.waitForSelector('#trackSummaryOverlay', { timeout: 60000 });
    let s = await summary();
    check(s.count === 1 && s.title === 'Track All finished', `one summary opens, titled "${s.title}"`);
    check(s.stats[0] === 'Identities|2|for 2 animals', `identities row: ${s.stats[0]}`);
    check(s.stats[1] === 'Frames tracked|1,950 of 1,950|100%', `frames tracked row: ${s.stats[1]}`);
    check(s.stats[2] === 'All 2 animals|1,950 frames|100%', `all-animals row: ${s.stats[2]}`);
    // 1,950 frames at 30 fps: the multiplier is the tracking fps over 30.
    const tm = /^Tracking time\|(?:<0\.1|\d+(?:\.\d)?) s\|([\d,.]+) fps · ([\d,.]+)×$/.exec(s.stats[3] || '');
    const tfps = tm ? +tm[1].replace(/,/g, '') : NaN, tx = tm ? +tm[2].replace(/,/g, '') : NaN;
    check(tm && Math.abs(tfps / 30 - tx) <= Math.max(0.05, tx * 0.02), `tracking time row with fps and real-time multiplier: ${s.stats[3]}`);
    // The 2D pose check ran on every detection (pose/pose-check.js); the fixture's poses are clean.
    check(/^2D poses\|None flagged\|of [\d,]+$/.test(s.stats[4] || '') && s.stats.length === 5,
        `2D poses row, nothing flagged in clean poses: ${s.stats[4]}`);
    check(JSON.stringify(s.ids) === JSON.stringify(['id_0 100%', 'id_1 100%']), `a row per identity: ${JSON.stringify(s.ids)}`);
    const size = s.checks.find(c => c.cue === 'size'), image = s.checks.find(c => c.cue === 'image');
    // The fixture keeps the animals apart, so there is nothing for the check to score.
    check(size && size.text === 'No close encounters to check' && /is-clear/.test(size.cls),
        `body-size check row says it ran and found nothing: "${size && size.text}"`);
    check(size && /^(<0\.1|\d+(\.\d)?) s$/.test(size.time), `body-size check row shows how long it took: "${size && size.time}"`);
    check(image && image.text === 'Not run' && image.time === '', `image check row, with no time: "${image && image.text}"`);
    check(s.headline === 'No ID switches were flagged.', `next-step headline: "${s.headline}"`);
    check(/similar size/.test(s.caveat), `says body size cannot separate similar animals: "${s.caveat}"`);
    check(s.steps.some(t => /Default Triangulation/.test(t) && /Triangulate All/.test(t)), `next steps say to choose, then triangulate: ${JSON.stringify(s.steps)}`);
    check(JSON.stringify(s.buttons) === JSON.stringify(['Check by images…', 'Close', 'Default Triangulation…']),
        `buttons: ${JSON.stringify(s.buttons)}`);
    check(s.focused === 'trackSummaryPrimary', `the recommended step is focused (${s.focused})`);
    check(/^Assigned 2 identities/.test(await statusText()), 'the status line still carries the pass\'s message');

    // ---- 2. shortcuts do not act under it; Esc closes ---------------------------------------
    const pred = () => page.evaluate(() => document.getElementById('visPredicted').checked);
    const p0 = await pred();
    await page.keyboard.press('p');
    check((await pred()) === p0, '`p` (Toggle Predicted) does nothing while the summary is open');
    await page.keyboard.press('Escape');
    check((await summary()).count === 0, 'Esc closes the summary');
    await page.keyboard.press('p');
    check((await pred()) === !p0, 'after it closes, `p` reaches the app again (the key listener was removed)');
    await page.keyboard.press('p');

    // ---- 2b. closed, it can be reopened from the ID Switches tab -----------------------------
    const tab = () => page.evaluate(() => {
        const host = document.getElementById('idSwitchPanel');
        const first = host && host.firstElementChild;
        return { button: !!document.getElementById('idSwitchTrackSummary'),
            first: first ? first.className : '', heading: (host && host.querySelector('h3') || {}).textContent || '' };
    });
    await page.evaluate(async () => (await import('/ui/id-switch-modal.js')).openIdSwitchPanel());
    let t2 = await tab();
    check(t2.button && /id-switch-track-summary/.test(t2.first) && /Possible ID switches/i.test(t2.heading),
        `the ID Switches tab has "Show Track All summary" above "Possible ID switches" (${JSON.stringify(t2)})`);
    const first = s;
    await page.click('#idSwitchTrackSummary');
    s = await summary();
    check(s.count === 1 && s.title === first.title && JSON.stringify(s.stats.slice(0, 3)) === JSON.stringify(first.stats.slice(0, 3)) &&
        s.stats[3] === first.stats[3] && JSON.stringify(s.ids) === JSON.stringify(first.ids),
        'the button reopens the same summary: title, counts, tracking time and identities');
    check(JSON.stringify(s.checks.map(c => c.text)) === JSON.stringify(first.checks.map(c => c.text)) &&
        JSON.stringify(s.buttons) === JSON.stringify(first.buttons), `…the same check rows and buttons (${JSON.stringify(s.buttons)})`);
    check(s.focused === 'trackSummaryPrimary', 'its recommended step is focused again');
    await page.keyboard.press('Escape');
    // a check run after the box was closed is reported when it is reopened, not "Not run"
    await page.evaluate(async () => {
        const M = await import('/ui/id-switch-modal.js');
        const fake = async () => {
            const proto = new Map();
            return { views: ['c0'], getEmbeddings: async (frame, items) => items.map(it => {
                if (!proto.has(it.group.identityId)) proto.set(it.group.identityId, Float32Array.from({ length: 32 }, () => Math.random() - 0.5));
                return [{ camera: 'c0', vector: Float32Array.from(proto.get(it.group.identityId), v => v + 0.05 * (Math.random() - 0.5)) }];
            }) };
        };
        await M.runIdSwitchChecks({ image: true, inject: { createEmbedder: fake } });
        await M.openIdSwitchPanel();
    });
    await page.click('#idSwitchTrackSummary');
    s = await summary();
    const img = s.checks.find(c => c.cue === 'image');
    check(img && img.text === 'No close encounters to check' && /is-clear/.test(img.cls) && /s$/.test(img.time),
        `after the image check ran, the reopened row reports it with its time: "${img && img.text}" (${img && img.time})`);
    check(!s.buttons.includes('Check by images…'), `…and no longer offers to run it (${JSON.stringify(s.buttons)})`);
    await page.keyboard.press('Escape');
    // cleared results read "Not run" again; the button stays (it is above the empty state too)
    await page.evaluate(() => document.getElementById('idSwitchClear').click());
    t2 = await tab();
    check(t2.button && /id-switch-track-summary/.test(t2.first), 'after Clear, the button is still at the top of the tab');
    await page.click('#idSwitchTrackSummary');
    s = await summary();
    check(s.checks.every(c => c.text === 'Not run'), `after Clear, both checks read "Not run": ${JSON.stringify(s.checks.map(c => c.text))}`);

    // ---- 2c. a check run from the box comes back to the box ------------------------------------
    check(JSON.stringify(s.buttons) === JSON.stringify(['Check by body size', 'Check by images…', 'Close', 'Default Triangulation…']),
        `precondition: the reopened box offers both checks (${JSON.stringify(s.buttons)})`);
    const onTab = () => page.evaluate(() => !!document.querySelector('#tabIdSwitches.active'));
    const leaveTab = () => page.evaluate(() => document.querySelector('.panel-tab:not([data-tab="tabIdSwitches"])').click());
    // whether the box came back, with `cue`'s row no longer reading `was` (before this, the tab opened instead)
    const backWith = (cue, was) => page.waitForFunction(([c, w]) => {
        const r = document.querySelector('#trackSummaryOverlay .track-summary-check[data-cue="' + c + '"] .track-summary-check-text');
        return !!r && r.textContent !== w;
    }, [cue, was], { timeout: 30000 }).then(() => true, () => false);
    await leaveTab();
    // body size: the real menu item, the real check
    await page.click('#trackSummaryOverlay [data-action="sizeCheck"]');
    check(await backWith('size', 'Not run'), 'the box comes back when "Check by body size" ends');
    s = await summary();
    let szc = s.checks.find(c => c.cue === 'size'), imc = s.checks.find(c => c.cue === 'image');
    check(s.count === 1 && szc.text === 'No close encounters to check' && /is-clear/.test(szc.cls) && /^(<0\.1|\d+(\.\d)?) s$/.test(szc.time),
        `"Check by body size" ends back in the box, its row filled in with its time: "${szc.text}" (${szc.time})`);
    check(imc.text === 'Not run' && JSON.stringify(s.buttons) === JSON.stringify(['Check by images…', 'Close', 'Default Triangulation…']),
        `…the image check still not run and still offered (${JSON.stringify(s.buttons)})`);
    check(JSON.stringify(s.ids) === JSON.stringify(first.ids) && s.stats[1] === first.stats[1] && s.stats[3] === first.stats[3],
        '…with the counts and tracking time re-shown');
    check(!(await onTab()), '…and the ID Switches tab was not opened');
    // images, cancelled: the box comes back saying so, and still offers it
    await page.evaluate(async () => { await window.__useFakeImageMenu(true);
        window.__gate = new Promise(res => { window.__openGate = res; }); });
    await page.click('#trackSummaryOverlay [data-action="imageCheck"]');
    await page.waitForSelector('.id-switch-progress', { timeout: 10000 });
    check((await summary()).count === 0, 'while the image check runs the box is closed (its progress dialog is up)');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.__gate = null; window.__openGate(); return window.__imgDone; });
    check(await backWith('image', 'Not run'), 'the box comes back when the image check is cancelled');
    s = await summary();
    imc = s.checks.find(c => c.cue === 'image');
    check(s.count === 1 && imc.text === 'Cancelled' && /is-cancelled/.test(imc.cls),
        `cancelled with Esc, the box comes back reading "${imc.text}"`);
    check(s.buttons.includes('Check by images…') && !(await onTab()), `…still offering the check, the tab not opened (${JSON.stringify(s.buttons)})`);
    // images, run to the end
    await page.click('#trackSummaryOverlay [data-action="imageCheck"]');
    check(await backWith('image', 'Cancelled'), 'the box comes back when "Check by images…" ends');
    await page.evaluate(() => window.__imgDone);
    s = await summary();
    imc = s.checks.find(c => c.cue === 'image');
    check(s.count === 1 && imc.text === 'No close encounters to check' && /is-clear/.test(imc.cls) && /s$/.test(imc.time),
        `"Check by images…" ends back in the box, its row filled in: "${imc.text}" (${imc.time})`);
    check(s.headline === 'Neither check flagged an ID switch.' && JSON.stringify(s.buttons) === JSON.stringify(['Close', 'Default Triangulation…']),
        `…the next step follows from it ("${s.headline}", ${JSON.stringify(s.buttons)})`);
    check(s.focused === 'trackSummaryPrimary' && !(await onTab()), '…its primary focused, and the tab not opened');
    check(/^Check ID Switches \(images\): nothing flagged/.test(await statusText()), 'the status line still reports the check');
    await page.keyboard.press('Escape');
    // reopened from the tab, it says the same
    await page.evaluate(async () => (await import('/ui/id-switch-modal.js')).openIdSwitchPanel());
    await page.click('#idSwitchTrackSummary');
    s = await summary();
    check(JSON.stringify(s.checks.map(c => c.text)) === JSON.stringify(['No close encounters to check', 'No close encounters to check']),
        `reopened from the tab, it reports both checks the same way (${JSON.stringify(s.checks.map(c => c.text))})`);
    await page.evaluate(() => window.__useFakeImageMenu(false));
    await page.keyboard.press('Escape');
    // a session that never ran Track All has no button
    await page.evaluate(async () => { await window.__buildTrackable('noTrackAll', { frames: 30 });
        (await import('/ui/id-switch-modal.js')).refreshIdSwitchPanel(); });
    check(!(await tab()).button, 'a session without a Track All has no button');

    // ---- 3. Enter presses the primary: Default Triangulation opens, nothing runs -------------
    await page.evaluate(async () => { await window.__buildTrackable('A2'); await (await import('/pose/tracker.js')).trackAll(); });
    check((await summary()).focused === 'trackSummaryPrimary', 'precondition: summary open with its primary focused');
    const st3Before = await statusText();
    await page.keyboard.press('Enter');
    const shown3 = await page.evaluate(() => {
        const o = document.querySelector('.settings-overlay');
        const panel = o && [...o.querySelectorAll('[data-panel]')].find(p => p.classList.contains('settings-panel') && p.offsetParent !== null);
        return { open: !!o, panel: panel && panel.dataset.panel, triBlue: document.getElementById('tbTriangulateAll').classList.contains('active') };
    });
    check((await summary()).count === 0, 'Enter closed the summary');
    check(shown3.open && shown3.panel === 'triangulation', `…and opened Settings on Default Triangulation (${JSON.stringify(shown3)})`);
    check(!shown3.triBlue && (await statusText()) === st3Before, '…without triangulating');
    const triBtn = '.settings-btn-triangulate';
    const triBtnInfo = () => page.evaluate(sel => {
        const b = document.querySelector(sel);
        return b && { text: b.textContent, shown: b.offsetParent !== null, disabled: b.disabled };
    }, triBtn);
    let tb = await triBtnInfo();
    check(tb.shown && !tb.disabled && tb.text === 'Triangulate All', `the panel offers Triangulate All (${JSON.stringify(tb)})`);
    await page.click('.settings-nav-item:has-text("Temporal Smoothing")');
    check(!(await triBtnInfo()).shown, '…on that panel only');
    await page.click('.settings-nav-item:has-text("Default Triangulation")');
    // An edit pending: it says so, and is stored by the time the toolbar button runs.
    const stored3 = () => page.evaluate(async () => (await import('/ui/settings.js')).getDefaultTriangulationMethod());
    const before3 = await stored3();
    const other3 = before3 === 'ba' ? 'dlt' : 'ba';
    await page.click(`.tri-method-choice[data-method="${other3}"]`);
    check((await triBtnInfo()).text === 'Apply & Triangulate All', 'with an edit pending it reads "Apply & Triangulate All"');
    // Stopped at the toolbar button, so the other method does not run here.
    await page.evaluate(() => {
        window.__clicked3 = false;
        window.__stop3 = (e) => { window.__clicked3 = true; e.stopImmediatePropagation(); };
        document.getElementById('tbTriangulateAll').addEventListener('click', window.__stop3, true);
    });
    await page.click(triBtn);
    const clicked3 = await page.evaluate(() => {
        document.getElementById('tbTriangulateAll').removeEventListener('click', window.__stop3, true);
        return window.__clicked3;
    });
    check(clicked3 && await stored3() === other3 && !(await page.$('.settings-overlay')),
        '…it stores the edit, closes Settings and clicks the toolbar button');
    await page.evaluate(async m => (await import('/ui/settings.js')).setDefaultTriangulationMethod(m), before3);
    // Nothing pending: it runs Triangulate All. It groups by identity first ("Grouped …, triangulated …").
    await page.evaluate(async () => (await import('/ui/settings-modal.js')).showSettingsModal('triangulation'));
    await page.click(triBtn);
    const TRI = /triangulated \d+/i;
    await page.waitForFunction(re => new RegExp(re, 'i').test(document.getElementById('statusText').textContent), TRI.source, { timeout: 60000 })
        .catch(() => {});
    const st3 = await statusText();
    check(TRI.test(st3) && !(await page.$('.settings-overlay')), `…and ran Triangulate All, Settings closed ("${st3.slice(0, 80)}")`);

    // ---- 4. a second Track All replaces the box ---------------------------------------------
    await page.evaluate(async () => {
        const tr = await import('/pose/tracker.js');
        await window.__buildTrackable('A3'); await tr.trackAll(); await tr.trackAll();
    });
    check((await summary()).count === 1, 'two Track All runs leave one summary, not two');
    await page.click('#trackSummaryClose');
    check((await summary()).count === 0, 'Close closes it');

    // ---- 5. Track Frame Range does not open it -----------------------------------------------
    const rr = await page.evaluate(async () => (await import('/pose/tracker.js')).trackFrameRange(0, 299));
    check(rr && rr.ok && (await summary()).count === 0, 'Track Frame Range finishes without a summary');

    // ---- 6. nothing tracked ------------------------------------------------------------------
    await page.evaluate(async () => {
        await window.__buildTrackable('B', { blindCam: true, frames: 60 });
        await (await import('/pose/tracker.js')).trackAll();
    });
    s = await summary();
    check(s.count === 1 && s.headline === 'Nothing was tracked.', `nothing matched: "${s.headline}"`);
    // 60 frames are too few for the 2D pose check to learn a camera's poses from, and the row says so.
    check(s.stats[0] === 'Identities|0|for 2 animals' && s.stats[1] === 'Frames tracked|0 of 60|0.0%' &&
        /^Tracking time\|/.test(s.stats[2]) && s.stats[3] === '2D poses|Not checked|too few complete poses to learn from' &&
        s.stats.length === 4, `stats (no all-animals row): ${JSON.stringify(s.stats)}`);
    check(s.checks.length === 0 && s.ids.length === 0, 'no check rows and no identity rows');
    check(s.primary === 'Tracking Wizard…', `primary: ${s.primary}`);
    await page.click('#trackSummaryPrimary');
    const wiz = await page.evaluate(() => !!document.querySelector('.settings-overlay'));
    check(wiz && (await summary()).count === 0, 'its primary closes the summary and opens the Tracking Wizard');
    await page.evaluate(() => { const o = document.querySelector('.settings-overlay'); if (o) o.remove(); });

    // ---- 7. a switch found -> Review switches ------------------------------------------------
    await page.evaluate(() => { window.__buildSwap = async () => {
        const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
        const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
            'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
        const TEMPLATE = { Nose: [45, 0, 0], Ear_R: [25, -11, 4], Ear_L: [25, 11, 4], Head: [30, 0, 3], Neck: [20, 0, 2],
            Trunk: [-5, 0, 4], TTI: [-40, 0, 0], Shoulder_left: [10, 12, 0], Shoulder_right: [10, -12, 0],
            Haunch_left: [-25, 15, 0], Haunch_right: [-25, -15, 0], Tail_0: [-65, 0, 0], Tail_1: [-88, 0, 0],
            Tail_2: [-110, 0, 0], TailTip: [-132, 0, 0] };
        const SCALES = [1.0, 1.15, 0.85], STEP = 4, SWAP = 16;
        let seed = 7; const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
        const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
        const pose = (sc, cx, cy, h) => { const out = new Float64Array(45), c = Math.cos(h), s = Math.sin(h);
            NODES.forEach((n, i) => { const [x, y, z] = TEMPLATE[n]; out[i * 3] = cx + sc * (c * x - s * y) + 1.5 * gauss();
                out[i * 3 + 1] = cy + sc * (s * x + c * y) + 1.5 * gauss(); out[i * 3 + 2] = sc * z + 1.5 * gauss(); }); return out; };
        const home = [[0, 0], [400, 0], [200, 350]], PAIRS = [[0, 1], [1, 2], [0, 2]];
        const events = []; for (let e = 0; e < 24; e++) events.push({ pair: PAIRS[e % 3], t0: 300 + e * 260 });
        const T = 300 + 24 * 260 + 300;
        const session = new pd.Session([], new pd.Skeleton('m', NODES, []), [], 'Swapped');
        for (let i = 0; i < 3; i++) session.addIdentity('id_' + i);
        let gid = 1; const label = [0, 1, 2];
        for (let t = 0; t < T; t++) {
            const pos = home.map(h => [h[0] + 15 * Math.sin(t / 37 + h[0]), h[1] + 15 * Math.cos(t / 41 + h[1])]);
            for (const ev of events) { const d = t - ev.t0; if (d < 0 || d > 100) continue;
                const [a, b] = ev.pair, mid = [(home[a][0] + home[b][0]) / 2, (home[a][1] + home[b][1]) / 2];
                const f = d < 40 ? d / 40 : d <= 60 ? 1 : 1 - (d - 60) / 40;
                for (const [k, side] of [[a, -1], [b, 1]]) pos[k] = [home[k][0] + f * (mid[0] + side * 10 - home[k][0]), home[k][1] + f * (mid[1] - home[k][1])]; }
            session.instanceGroups.set(t * STEP, [0, 1, 2].map(k => { const g = new pd.InstanceGroup(gid++, session.identities[label[k]].id);
                g.points3d = pose(SCALES[k], pos[k][0], pos[k][1], (t / 50 + k) % (2 * Math.PI)); g._animal = k; return g; }));
            if (t === events[SWAP].t0 + 60) { const [a, b] = events[SWAP].pair; [label[a], label[b]] = [label[b], label[a]]; }
        }
        AS.state.sessions = [session]; AS.state.activeSessionIdx = 0; AS.state.session = session;
        AS.state.totalFrames = T * STEP; AS.state.currentFrame = 0; AS.state.fps = 60;
        if (AS.timeline) { AS.timeline.setTotalFrames(T * STEP); AS.timeline.setData(session); }
        return { session, T };
    }; });
    const fx = await page.evaluate(async () => {
        const { session, T } = await window.__buildSwap();
        // What runTrackingPass does after the tracker: the automatic checks, then the summary.
        const M = await import('/ui/id-switch-modal.js');
        const res = await M.runSizeSwitchCheck({ auto: true, statusPrefix: 'Assigned 3 identities' });
        const TS = await import('/ui/track-summary.js');
        (await import('/ui/track-summary-modal.js')).showTrackSummaryModal(
            TS.summarizeTrackedIdentities(session, { frames: T, animals: 3 }),
            { size: TS.describeSwitchCheck(true, res.size, 3), image: TS.describeSwitchCheck(false, null, 3) });
        return { firstGo: +document.querySelector('#idSwitchPanel .id-switch-row').dataset.go };
    });
    s = await summary();
    const sizeB = s.checks.find(c => c.cue === 'size');
    check(sizeB && /^1 possible switch in \d+ close encounters$/.test(sizeB.text) && /is-found/.test(sizeB.cls), `found: "${sizeB && sizeB.text}"`);
    check(s.headline === 'Review the possible ID switches.' && s.primary === 'Review switches',
        `primary is Review switches ("${s.headline}" / "${s.primary}")`);
    check(JSON.stringify(s.buttons) === JSON.stringify(['Close', 'Review switches']), `no alternative checks offered: ${JSON.stringify(s.buttons)}`);
    await page.evaluate(() => document.querySelector('.panel-tab[data-tab="tabInfo"], .panel-tab:not([data-tab="tabIdSwitches"])').click());
    await page.click('#trackSummaryPrimary');
    await page.waitForFunction(f => window.__lucid.state.currentFrame === f, fx.firstGo, { timeout: 10000 }).catch(() => {});
    const after = await page.evaluate(() => ({
        tab: !!document.querySelector('#tabIdSwitches.active'),
        current: !!document.querySelector('#idSwitchPanel .id-switch-row.is-current'),
        frame: window.__lucid.state.currentFrame,
    }));
    check((await summary()).count === 0, 'Review switches closes the summary');
    check(after.tab, 'and shows the ID Switches tab');
    check(after.current && after.frame === fx.firstGo, `and lands on the first switch (frame ${after.frame}, want ${fx.firstGo})`);

    // ---- 8. the box's "Check by images…" finds the switch -> back to the box, Review switches ----
    await page.evaluate(async () => {
        const { session, T } = await window.__buildSwap();
        (await import('/ui/id-switch-modal.js')).clearIdSwitchResults(session);
        // As Track All leaves it when neither check runs on its own
        const TS = await import('/ui/track-summary.js'), TSM = await import('/ui/track-summary-modal.js');
        const opts = { frames: T, animals: 3 };
        const checks = { size: TS.describeSwitchCheck(false, null, 3), image: TS.describeSwitchCheck(false, null, 3) };
        TSM.rememberTrackSummary(session, opts, checks, 3);
        TSM.showTrackSummaryModal(TS.summarizeTrackedIdentities(session, opts), checks, { session });
        await window.__useFakeImageMenu(true);
    });
    await leaveTab();
    await page.click('#trackSummaryOverlay [data-action="imageCheck"]');
    check(await backWith('image', 'Not run'), 'the box comes back when the image check that found the switch ends');
    await page.evaluate(() => window.__imgDone);
    s = await summary();
    const im8 = s.checks.find(c => c.cue === 'image');
    check(im8 && /^1 possible switch in \d+ close encounters$/.test(im8.text) && /is-found/.test(im8.cls),
        `the image check run from the box comes back reporting the switch: "${im8 && im8.text}"`);
    check(s.headline === 'Review the possible ID switches.' && s.primary === 'Review switches' && s.focused === 'trackSummaryPrimary',
        `…and the next step is to review it ("${s.headline}" / "${s.primary}")`);
    check(!(await onTab()), '…with the ID Switches tab still shut');
    await page.click('#trackSummaryPrimary');
    check((await summary()).count === 0 && await onTab(), 'Review switches then closes the box and shows the tab');
    await page.evaluate(() => window.__useFakeImageMenu(false));

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
