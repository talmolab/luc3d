/**
 * size-switch-check.mjs — Tracks ▸ Check ID Switches (Body Size), in the real app.
 *
 * Fixture: a synthetic TRACKED session (InstanceGroups with identities + 3D
 * skeletons, no video): three animals of clearly different size meet at 24
 * scheduled close encounters, and the identity labels of one pair are exchanged
 * after encounter 16 for the rest of the session — a switch that persists, the
 * shape the size check was validated on (pose/size-switch-check.js; unit-level
 * coverage in tests/test-size-switch-check.mjs). Asserted through the real menu:
 *  1. The ID Switches tab of the right panel opens; its first change point is
 *     the switch encounter, naming the swapped pair; any others come after it
 *     and involve a swapped identity (its encounters with the third animal look
 *     off too); the status line reports the count.
 *  2. The timeline carries the markers (the change point plus faint repeats).
 *  3. The tab is the panel's one scroller (the list has no scroller of its own);
 *     "Show repeats" lists the still-swapped encounters too.
 *  4. Clicking a row navigates the viewer to that frame.
 *  5. The checklist: ticking a row counts it reviewed and dims its timeline
 *     marker; "Next unreviewed" jumps to the next unticked row; the results and
 *     ticks survive leaving the tab, a re-run, and switching sessions away and
 *     back (results are per session); "Clear" removes results and markers.
 *  6. On an untracked session the action warns instead of running.
 *  7. The tab states the sampling it used and that, with no video loaded, the
 *     frame rate is the app's value rather than a measured one.
 *
 * Run: node tests/e2e/size-switch-check.mjs     (SHOT=/path.png saves a timeline screenshot,
 *      PANEL_SHOT=/path.png the ID Switches tab)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8271);
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
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // ---- build the tracked fixture in the page
    const fx = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
            'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
        const TEMPLATE = { Nose: [45, 0, 0], Ear_R: [25, -11, 4], Ear_L: [25, 11, 4], Head: [30, 0, 3], Neck: [20, 0, 2],
            Trunk: [-5, 0, 4], TTI: [-40, 0, 0], Shoulder_left: [10, 12, 0], Shoulder_right: [10, -12, 0],
            Haunch_left: [-25, 15, 0], Haunch_right: [-25, -15, 0], Tail_0: [-65, 0, 0], Tail_1: [-88, 0, 0],
            Tail_2: [-110, 0, 0], TailTip: [-132, 0, 0] };
        const SCALES = [1.0, 1.15, 0.85], STEP = 4, SWAP = 16;
        let seed = 7; const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
        const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
        const pose = (sc, cx, cy, h) => {
            const out = new Float64Array(45), c = Math.cos(h), s = Math.sin(h);
            NODES.forEach((n, i) => { const [x, y, z] = TEMPLATE[n];
                out[i * 3] = cx + sc * (c * x - s * y) + 1.5 * gauss(); out[i * 3 + 1] = cy + sc * (s * x + c * y) + 1.5 * gauss();
                out[i * 3 + 2] = sc * z + 1.5 * gauss(); });
            return out;
        };
        const home = [[0, 0], [400, 0], [200, 350]], PAIRS = [[0, 1], [1, 2], [0, 2]];
        const events = []; for (let e = 0; e < 24; e++) events.push({ pair: PAIRS[e % 3], t0: 300 + e * 260 });
        const T = 300 + 24 * 260 + 300;
        const session = new pd.Session([], new pd.Skeleton('m', NODES, []), [], 'SizeSwitchFixture');
        for (let i = 0; i < 3; i++) session.addIdentity('id_' + i);
        let gid = 1; const label = [0, 1, 2]; let swapFrame = null;
        for (let t = 0; t < T; t++) {
            const pos = home.map(h => [h[0] + 15 * Math.sin(t / 37 + h[0]), h[1] + 15 * Math.cos(t / 41 + h[1])]);
            for (const ev of events) {
                const d = t - ev.t0; if (d < 0 || d > 100) continue;
                const [a, b] = ev.pair, mid = [(home[a][0] + home[b][0]) / 2, (home[a][1] + home[b][1]) / 2];
                const f = d < 40 ? d / 40 : d <= 60 ? 1 : 1 - (d - 60) / 40;
                for (const [k, side] of [[a, -1], [b, 1]]) pos[k] = [home[k][0] + f * (mid[0] + side * 10 - home[k][0]), home[k][1] + f * (mid[1] - home[k][1])];
            }
            session.instanceGroups.set(t * STEP, [0, 1, 2].map(k => {
                const g = new pd.InstanceGroup(gid++, session.identities[label[k]].id);
                g.points3d = pose(SCALES[k], pos[k][0], pos[k][1], (t / 50 + k) % (2 * Math.PI)); return g;
            }));
            if (t === events[SWAP].t0 + 60) { const [a, b] = events[SWAP].pair; [label[a], label[b]] = [label[b], label[a]]; swapFrame = t * STEP; }
        }
        AS.state.sessions = [session]; AS.state.activeSessionIdx = 0; AS.state.session = session;
        AS.state.totalFrames = T * STEP; AS.state.currentFrame = 0; AS.state.views = []; AS.state.fps = 60;   // 15 Hz samples, 4 frames apart
        if (AS.timeline) { AS.timeline.setTotalFrames(T * STEP); AS.timeline.setData(session); }
        return { swapFrame, pair: events[SWAP].pair.map(k => 'id_' + k), totalFrames: T * STEP };
    });

    // ---- 1. run it from the real menu item: the ID Switches tab opens
    await page.evaluate(() => document.getElementById('menuCheckSizeSwitches').click());
    await page.waitForSelector('#tabIdSwitches.active .id-switch-row', { timeout: 60000 });
    const rowsNow = () => page.evaluate(() => Array.from(document.querySelectorAll('#idSwitchPanel .id-switch-row'))
        .map(r => ({ frame: +r.dataset.frame, key: r.dataset.key, text: r.textContent, reviewed: r.classList.contains('is-reviewed') })));
    const ui = await page.evaluate(() => ({ status: document.getElementById('statusText').textContent,
        rate: (document.querySelector('#idSwitchPanel .id-switch-rate') || {}).textContent || '',
        done: (document.querySelector('.id-switch-done') || {}).textContent || '' }));
    ui.rows = await rowsNow();
    console.log('    rows:', JSON.stringify(ui.rows.map(r => [r.frame, r.text])));
    // The swapped identities also carry the "wrong" label in their encounters with the THIRD animal
    // after the switch, so those can surface as change points too — but only after the switch, and
    // only involving a swapped identity. The first change point is the switch itself.
    const row = ui.rows[0] || {};
    check(ui.rows.length >= 1 && ui.rows.every(r => r.frame >= fx.swapFrame - 40 && fx.pair.some(n => r.text.includes(n))),
        `every change point (${ui.rows.length}) is at/after the switch and involves a swapped identity`);
    check(Math.abs(row.frame - fx.swapFrame) <= 40, `…at the switch encounter (frame ${row.frame}, switch at ${fx.swapFrame})`);
    check(fx.pair.every(n => (row.text || '').includes(n)), `…naming the swapped pair (${fx.pair.join(' ↔ ')}): "${row.text}"`);
    check(/15\.0 samples\/s \(every 4th frame at 60 fps/.test(ui.rate) && /not measured/.test(ui.rate),
        `the tab states the sampling and that the frame rate is not from a video ("${ui.rate.slice(0, 110)}…")`);
    check(/ 1 possible switch /.test(ui.status) && /ID Switches tab/.test(ui.status), `status counts one switch, not its follow-ons, and points at the tab ("${ui.status}")`);
    check(ui.rows.slice(1).every(r => /follows the switch at/.test(r.text)), 'the other change points are labelled as its follow-ons');
    check(/^0 of \d+ reviewed/.test(ui.done.trim()), `checklist starts at "${ui.done.trim()}"`);

    // ---- 2. timeline markers
    const markers = await page.evaluate(async () => (await import('/ui/app-state.js')).timeline.getSwitchMarkers());
    check(markers.some(m => !m.continues && Math.abs(m.frame - fx.swapFrame) <= 40), `timeline has the change-point marker (${markers.length} markers)`);
    check(markers.some(m => m.continues), 'timeline also shows the still-swapped repeats');
    if (process.env.SHOT) {
        await page.evaluate(async () => { const tl = (await import('/ui/app-state.js')).timeline; tl.setZoom(1); tl.redraw(); });
        const box = await page.locator('#timelineContainer, .timeline-container').first().boundingBox().catch(() => null);
        await page.screenshot({ path: process.env.SHOT, clip: box || undefined });
    }

    // ---- 3. one scroller; Show repeats
    await page.evaluate(() => document.getElementById('idSwitchRepeats').click());
    const withRep = await rowsNow();
    const scroll = await page.evaluate(() => ({ tab: getComputedStyle(document.getElementById('tabIdSwitches')).overflowY,
        list: getComputedStyle(document.getElementById('idSwitchList')).overflowY }));
    check(withRep.length > ui.rows.length && withRep.some(r => /still swapped/.test(r.text)),
        `"Show repeats" lists the still-swapped encounters too (${ui.rows.length} -> ${withRep.length} rows)`);
    check(scroll.tab === 'auto' && scroll.list === 'visible', `the tab is the one scroller (tab ${scroll.tab}, list ${scroll.list})`);
    if (process.env.PANEL_SHOT) await page.screenshot({ path: process.env.PANEL_SHOT });
    await page.evaluate(() => document.getElementById('idSwitchRepeats').click());

    // ---- 4. click a row -> navigate there
    await page.click('#idSwitchPanel .id-switch-row .id-switch-main');
    await page.waitForFunction(f => window.__lucid.state.currentFrame === f, row.frame, { timeout: 10000 }).catch(() => {});
    const cur = await page.evaluate(() => window.__lucid.state.currentFrame);
    check(cur === row.frame, `clicking the row jumps to frame ${row.frame} (now ${cur})`);

    // ---- 5. the checklist
    await page.click('#idSwitchPanel .id-switch-row .id-switch-tick');
    const afterTick = await page.evaluate(async () => {
        const m = (await import('/ui/app-state.js')).timeline.getSwitchMarkers();
        return { done: document.querySelector('.id-switch-done').textContent.trim(), first: document.querySelector('.id-switch-row').classList.contains('is-reviewed'),
                 reviewedMarkers: m.filter(x => x.reviewed).length };
    });
    check(/^1 of /.test(afterTick.done) && afterTick.first && afterTick.reviewedMarkers >= 1,
        `ticking a row: "${afterTick.done}", row dimmed, its timeline marker dimmed (${afterTick.reviewedMarkers})`);
    if (ui.rows.length > 1) {
        await page.click('#idSwitchNext');
        await page.waitForFunction(f => window.__lucid.state.currentFrame === f, ui.rows[1].frame, { timeout: 10000 }).catch(() => {});
        const nf = await page.evaluate(() => window.__lucid.state.currentFrame);
        check(nf === ui.rows[1].frame, `"Next unreviewed" jumps to the next unticked row (frame ${nf}, expected ${ui.rows[1].frame})`);
    } else {
        check(await page.evaluate(() => document.getElementById('idSwitchNext').disabled), '"Next unreviewed" is disabled once all are ticked');
    }
    // leave the tab and come back; re-run; switch sessions away and back — results and ticks persist
    await page.click('.panel-tab[data-tab="tabInstances"]');
    // at the default panel width the tab sits in "More ▾" — reach it the way a user would
    if (await page.isVisible('.panel-tab[data-tab="tabIdSwitches"]')) await page.click('.panel-tab[data-tab="tabIdSwitches"]');
    else { await page.click('.panel-tab-more-btn'); await page.click('.panel-tab-more-item:has-text("ID Switches")'); }
    let back = await rowsNow();
    check(back.length === ui.rows.length && back[0].reviewed, `reopening the tab shows the same ${back.length} rows, first still ticked`);
    await page.evaluate(() => document.getElementById('menuCheckSizeSwitches').click());
    await page.waitForFunction(() => /Check ID Switches:/.test(document.getElementById('statusText').textContent), null, { timeout: 60000 });
    await page.waitForTimeout(200);
    back = await rowsNow();
    check(back.length === ui.rows.length && back[0].reviewed, 're-running the check keeps the tick on the change point it found again');
    const perSession = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js'); const IP = await import('/ui/info-panel.js');
        const a = AS.state.session, b = new pd.Session([], new pd.Skeleton('m', ['Nose', 'TTI'], []), [], 'Other');
        AS.state.sessions = [a, b]; AS.state.session = b; AS.state.activeSessionIdx = 1; IP.updateInfoPanel();
        const onB = { rows: document.querySelectorAll('#idSwitchPanel .id-switch-row').length, empty: !!document.querySelector('#idSwitchPanel .id-switch-empty'),
                      markers: AS.timeline.getSwitchMarkers().length };
        AS.state.session = a; AS.state.activeSessionIdx = 0; IP.updateInfoPanel();
        return { onB, onA: { rows: document.querySelectorAll('#idSwitchPanel .id-switch-row').length, markers: AS.timeline.getSwitchMarkers().length } };
    });
    check(perSession.onB.rows === 0 && perSession.onB.empty && perSession.onB.markers === 0 &&
          perSession.onA.rows === ui.rows.length && perSession.onA.markers === markers.length,
        `results are per session (other session: ${perSession.onB.rows} rows, ${perSession.onB.markers} markers; back: ${perSession.onA.rows} rows, ${perSession.onA.markers} markers)`);
    await page.click('#idSwitchClear');
    const cleared = await page.evaluate(async () => ({ n: (await import('/ui/app-state.js')).timeline.getSwitchMarkers().length,
        rows: document.querySelectorAll('#idSwitchPanel .id-switch-row').length, empty: !!document.querySelector('#idSwitchPanel .id-switch-empty') }));
    check(cleared.n === 0 && cleared.rows === 0 && cleared.empty, '"Clear" removes the results and the markers, leaving the empty state');

    // ---- 5. untracked session warns
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
        const s = new pd.Session([], new pd.Skeleton('m', ['Nose', 'TTI'], []), [], 'Empty');
        AS.state.sessions = [s]; AS.state.session = s;
        document.getElementById('menuCheckSizeSwitches').click();
    });
    await page.waitForTimeout(300);
    const warn = await page.evaluate(() => ({ status: document.getElementById('statusText').textContent, rows: document.querySelectorAll('#idSwitchPanel .id-switch-row').length }));
    check(!warn.rows && /Track All/.test(warn.status), `untracked session: no results, a warning ("${warn.status}")`);

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
