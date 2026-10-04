/**
 * size-switch-check.mjs — Tracks ▸ Check ID Switches (Body Size), in the real app.
 *
 * Fixture: a synthetic TRACKED session (InstanceGroups with identities + 3D
 * skeletons, no video): three animals of clearly different size meet at 24
 * scheduled close encounters, and the identity labels of one pair are exchanged
 * after encounter 16 for the rest of the session — a switch that persists, the
 * shape the size check was validated on (pose/size-switch-check.js; unit-level
 * coverage in tests/test-size-switch-check.mjs). Asserted through the real menu:
 *  1. The dialog's first change point is the switch encounter, naming the
 *     swapped pair; any others come after it and involve a swapped identity
 *     (its encounters with the third animal look off too); the status line
 *     reports the count.
 *  2. The timeline carries the markers (the change point plus faint repeats).
 *  2b. In a short (600 px) window the dialog stays inside it with its buttons
 *     visible, and only the list scrolls (one scroller, sticky column heads).
 *  3. Clicking the row navigates the viewer to that frame.
 *  4. Esc closes the dialog and leaves the markers; "Clear markers" removes them.
 *  5. On an untracked session the action warns instead of running.
 *  6. The dialog states the sampling it used and that, with no video loaded,
 *     the frame rate is the app's value rather than a measured one.
 *
 * Run: node tests/e2e/size-switch-check.mjs     (SHOT=/path.png saves a timeline screenshot,
 *      DIALOG_SHOT=/path.png the short-window dialog)
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

    // ---- 1. run it from the real menu item
    await page.evaluate(() => document.getElementById('menuCheckSizeSwitches').click());
    await page.waitForSelector('.size-switch-modal', { timeout: 60000 });
    const ui = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.size-switch-row')).map(r => ({ frame: +r.dataset.frame, text: r.textContent }));
        const AS = window.__lucid;
        return { rows, status: document.getElementById("statusText").textContent,
                 rate: (document.querySelector('.size-switch-rate') || {}).textContent || '' };
    });
    console.log('    rows:', JSON.stringify(ui.rows));
    // The swapped identities also carry the "wrong" label in their encounters with the THIRD animal
    // after the switch, so those can surface as change points too — but only after the switch, and
    // only involving a swapped identity. The first change point is the switch itself.
    const row = ui.rows[0] || {};
    check(ui.rows.length >= 1 && ui.rows.every(r => r.frame >= fx.swapFrame - 40 && fx.pair.some(n => r.text.includes(n))),
        `every change point (${ui.rows.length}) is at/after the switch and involves a swapped identity`);
    check(Math.abs(row.frame - fx.swapFrame) <= 40, `…at the switch encounter (frame ${row.frame}, switch at ${fx.swapFrame})`);
    check(fx.pair.every(n => (row.text || '').includes(n)), `…naming the swapped pair (${fx.pair.join(' ↔ ')}): "${row.text}"`);
    check(/15\.0 samples\/s \(every 4th frame at 60 fps/.test(ui.rate) && /not measured/.test(ui.rate),
        `dialog states the sampling and that the frame rate is not from a video ("${ui.rate.slice(0, 110)}…")`);
    check(/ 1 possible switch /.test(ui.status), `status counts one switch, not its follow-ons ("${ui.status}")`);
    check(ui.rows.slice(1).every(r => /follows the switch at/.test(r.text)), 'the other change points are labelled as its follow-ons');

    // ---- 2. timeline markers
    const markers = await page.evaluate(async () => (await import('/ui/app-state.js')).timeline.getSwitchMarkers());
    check(markers.some(m => !m.continues && Math.abs(m.frame - fx.swapFrame) <= 40), `timeline has the change-point marker (${markers.length} markers)`);
    check(markers.some(m => m.continues), 'timeline also shows the still-swapped repeats');
    if (process.env.SHOT) {
        await page.evaluate(async () => { const tl = (await import('/ui/app-state.js')).timeline; tl.setZoom(1); tl.redraw(); });
        const box = await page.locator('#timelineContainer, .timeline-container').first().boundingBox().catch(() => null);
        await page.screenshot({ path: process.env.SHOT, clip: box || undefined });
    }

    // ---- 2b. a short window: the dialog stays inside it, buttons visible, only the list scrolls
    await page.setViewportSize({ width: 1600, height: 600 });
    await page.evaluate(() => { const cb = document.getElementById('sizeSwitchRepeats'); if (cb && !cb.checked) cb.click(); });
    const fit = await page.evaluate(() => {
        const m = document.querySelector('.size-switch-modal'), l = document.getElementById('sizeSwitchList'),
            b = document.getElementById('sizeSwitchClose').getBoundingClientRect(), r = m.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, vh: innerHeight, btnBottom: b.bottom, listScrolls: l.scrollHeight > l.clientHeight + 1,
                 modalScrolls: m.scrollHeight > m.clientHeight + 1, listOverflow: getComputedStyle(l).overflowY, rows: l.querySelectorAll('tr').length, listH: l.clientHeight };
    });
    check(fit.top >= 0 && fit.bottom <= fit.vh && fit.btnBottom <= fit.vh,
        `short window: dialog (${Math.round(fit.top)}-${Math.round(fit.bottom)} px) and Close button fit in ${fit.vh} px`);
    check(fit.listScrolls && fit.listOverflow === 'auto' && !fit.modalScrolls, `the list is the one scroller (${fit.rows} rows in ${fit.listH} px; the dialog itself does not scroll)`);
    if (process.env.DIALOG_SHOT) {
        await page.evaluate(() => { document.getElementById('sizeSwitchList').scrollTop = 60; });
        await page.screenshot({ path: process.env.DIALOG_SHOT });
    }
    await page.evaluate(() => { const cb = document.getElementById('sizeSwitchRepeats'); if (cb && cb.checked) cb.click(); });
    await page.setViewportSize({ width: 1600, height: 900 });

    // ---- 3. click the row -> navigate there
    await page.click('.size-switch-row');
    await page.waitForFunction(f => window.__lucid.state.currentFrame === f, row.frame, { timeout: 10000 }).catch(() => {});
    const cur = await page.evaluate(() => window.__lucid.state.currentFrame);
    check(cur === row.frame, `clicking the row jumps to frame ${row.frame} (now ${cur})`);

    // ---- 4. Esc closes, markers stay; Clear removes them
    await page.keyboard.press('Escape');
    const afterEsc = await page.evaluate(async () => ({ open: !!document.querySelector('.size-switch-modal'),
        n: (await import('/ui/app-state.js')).timeline.getSwitchMarkers().length }));
    check(!afterEsc.open && afterEsc.n === markers.length, `Esc closes the dialog and keeps the ${afterEsc.n} markers`);
    await page.evaluate(() => document.getElementById('menuCheckSizeSwitches').click());
    await page.waitForSelector('.size-switch-modal', { timeout: 60000 });
    await page.click('#sizeSwitchClear');
    const cleared = await page.evaluate(async () => (await import('/ui/app-state.js')).timeline.getSwitchMarkers().length);
    check(cleared === 0 && !(await page.$('.size-switch-modal')), 'Clear markers removes them and closes the dialog');

    // ---- 5. untracked session warns
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
        const s = new pd.Session([], new pd.Skeleton('m', ['Nose', 'TTI'], []), [], 'Empty');
        AS.state.sessions = [s]; AS.state.session = s;
        document.getElementById('menuCheckSizeSwitches').click();
    });
    await page.waitForTimeout(300);
    const warn = await page.evaluate(() => ({ status: document.getElementById('statusText').textContent, open: !!document.querySelector('.size-switch-modal') }));
    check(!warn.open && /Track All/.test(warn.status), `untracked session: no dialog, a warning ("${warn.status}")`);

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? 'PASS' : `FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
