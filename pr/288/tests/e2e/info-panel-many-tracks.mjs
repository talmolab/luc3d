/**
 * info-panel-many-tracks.mjs — the Instances panel must not cost O(tracks) per
 * row per update.
 *
 * `updateFrameInfo` rebuilds both instance tables on every update (~10 Hz in
 * playback), with a Track <select> per row. Each used to hold an <option> for
 * EVERY session track: an un-tracked prediction project with 863 tracks and ~40
 * rows made ~35,000 options per update, and the rebuild took ~200 ms, so it ran
 * on every frame and capped playback at ~5 fps (tests/e2e/_bench-playback.mjs).
 * The selects are now filled lazily (ui/lazy-select.js).
 *
 * Drives the REAL `updateFrameInfo` on 8 cameras x (3 groups + 5 unlinked
 * instances per camera) with 10 and with 1,000 tracks, and asserts:
 *   1. the two track counts produce the SAME number of <option>s per update —
 *      at most 3 per Track select;
 *   2. every closed Track select shows what the eager build showed (its
 *      track's name, "(none)" / "—" for a trackless row);
 *   3. a real click fills the full list (head, every track in order, tail)
 *      before the list opens, without changing the select's width; focus does
 *      too (the keyboard path);
 *   4. picking from the filled list still assigns the track (swap included),
 *      "(none)" still un-tracks a group, and "(+) New Track" still opens the
 *      inline name box.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8093);

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (!c && extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
    if (!c) fails++;
};

const CAMS = 8;
const UNLINKED_TRACKS = (nt) => [0, 1, Math.floor(nt / 2), null, nt - 1];

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // Build a frame-0 session with `nt` tracks and render it through the real
    // updateFrameInfo. Returns what the two instance tables hold.
    const render = (nt) => page.evaluate(async ({ nt, CAMS, ulTracks }) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const IP = await import('/ui/info-panel.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const mtx = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
        const camNames = Array.from({ length: CAMS }, (_, i) => 'cam' + i);
        const cams = camNames.map((n, i) => new Camera(n, mtx, [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [512, 512]));
        const skel = new Skeleton('skeleton', ['nose', 'tail'], [[0, 1]]);
        const tracks = Array.from({ length: nt }, (_, i) => 'track_' + i);
        const s = new Session(cams, skel, tracks, 'S');
        for (let k = 0; k < 5; k++) s.addIdentity('animal_' + k);
        const mk = (tr, type) => new Instance([[1, 2], [3, 4]], tr, type, 1);
        const fg = new FrameGroup(0); s.addFrameGroup(fg);
        // Three groups: a low track, the LAST track, and a trackless one.
        const groupTracks = [3, nt - 1, null];
        const groups = groupTracks.map((tr, gi) => {
            const g = new InstanceGroup(gi + 1, -1);
            for (const cn of camNames) { const inst = mk(tr, 'user'); g.addInstance(cn, inst); fg.addInstance(cn, inst); }
            return g;
        });
        s.instanceGroups.set(0, groups);
        for (const cn of camNames) for (const tr of ulTracks) s.addUnlinkedInstance(0, cn, mk(tr, 'predicted'));

        AS.state.session = s;
        AS.state.sessions = [s];
        AS.state.currentFrame = 0;
        AS.state.triangulationResults.clear();

        const t0 = performance.now();
        IP.updateFrameInfo(0, groups);
        void document.body.offsetHeight;          // include the style/layout it causes
        const ms = performance.now() - t0;

        const read = (tableId) => Array.from(document.querySelectorAll('#' + tableId + ' tbody tr'))
            .filter(tr => !tr.classList.contains('unlinked-camera-header'))
            .map(tr => {
                const sel = tr.querySelector('td:first-child select');
                if (!sel) return null;      // reprojection sub-rows carry no select
                return {
                    n: sel.options.length,
                    value: sel.value,
                    shown: sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].textContent : null,
                };
            })
            .filter(Boolean);
        return {
            ms,
            options: document.querySelectorAll('#instanceGroupsTable option, #unlinkedTable option').length,
            groupRows: read('instanceGroupsTable'),
            ulRows: read('unlinkedTable'),
            // which track each group row shows, in table order (it sorts)
            expectGroups: groupTracks.map(tr => tr == null ? '(none)' : tracks[tr]),
        };
    }, { nt, CAMS, ulTracks: UNLINKED_TRACKS(nt) });

    // ---- 1. option count is independent of the track count ----------------
    const small = await render(10);
    const big = await render(1000);
    console.log(`    10 tracks: ${small.options} options, ${small.ms.toFixed(1)} ms | ` +
        `1000 tracks: ${big.options} options, ${big.ms.toFixed(1)} ms`);
    const rows = CAMS * UNLINKED_TRACKS(10).length + 3;
    check(big.groupRows.length + big.ulRows.length === rows, `${rows} Track selects rendered`,
        { groups: big.groupRows.length, unlinked: big.ulRows.length });
    check(big.options === small.options,
        `1,000 tracks produce exactly as many <option>s per update as 10 (${big.options})`,
        { small: small.options, big: big.options });
    const maxPer = Math.max(...big.groupRows.concat(big.ulRows).map(r => r.n));
    check(maxPer <= 3, `every closed Track select holds at most 3 options (max ${maxPer})`);
    // An eager build held 1,002 per Track select (+7 per identity select).
    check(big.options < rows * (1000 + 2) / 10,
        `nowhere near rows x tracks (${big.options} vs ${rows * 1002} eager)`);

    // ---- 2. closed selects show what the eager build showed ---------------
    const gShown = big.groupRows.map(r => r.shown).sort();
    check(JSON.stringify(gShown) === JSON.stringify(big.expectGroups.slice().sort()),
        'group rows show track_3, track_999 and (none)', gShown);
    const ulExpect = UNLINKED_TRACKS(1000).map(tr => tr == null ? '—' : 'track_' + tr);
    const ulShown = big.ulRows.map(r => r.shown);
    const perCam = [];
    for (let c = 0; c < CAMS; c++) perCam.push(ulShown.slice(c * 5, c * 5 + 5).join(','));
    check(perCam.every(x => x === ulExpect.join(',')),
        `every camera's unlinked rows show ${ulExpect.join(', ')}`, perCam[0]);
    check(big.ulRows.every((r, i) => r.value === String(UNLINKED_TRACKS(1000)[i % 5] ?? -1)),
        'and each select\'s value is its track index (-1 when trackless)');

    // ---- 3. a real click fills the list before it opens --------------------
    const ulTrackSel = (i) => page.locator('#unlinkedTable tbody tr:not(.unlinked-camera-header) td:first-child select').nth(i);
    const widthBefore = await ulTrackSel(0).evaluate(el => el.offsetWidth);
    await ulTrackSel(0).click();
    await page.keyboard.press('Escape');
    const clicked = await ulTrackSel(0).evaluate(el => ({
        n: el.options.length,
        first: [el.options[0].value, el.options[0].textContent],
        second: [el.options[1].value, el.options[1].textContent],
        last: [el.options[el.options.length - 1].value, el.options[el.options.length - 1].textContent],
        inOrder: Array.from(el.options).slice(1, -1).every((o, i) => o.value === String(i) && o.textContent === 'track_' + i),
        value: el.value,
        width: el.offsetWidth,
    }));
    check(clicked.n === 1002, `a click fills head + 1,000 tracks + tail (${clicked.n})`);
    check(clicked.inOrder, 'every track, in track order, value = index');
    check(clicked.first.join('|') === '-1|—' && clicked.last.join('|') === '__new__|(+) New Track',
        'head "—" and tail "(+) New Track" are kept', [clicked.first, clicked.last]);
    check(clicked.value === '0', 'the selection is unchanged by filling', clicked.value);
    check(clicked.width === widthBefore, `the select keeps its closed width (${widthBefore}px)`, clicked.width);

    await ulTrackSel(1).evaluate(el => el.focus());
    const focused = await ulTrackSel(1).evaluate(el => ({ n: el.options.length, value: el.value }));
    check(focused.n === 1002 && focused.value === '1', 'focus (the keyboard path) fills it too', focused);
    const untouched = await ulTrackSel(2).evaluate(el => el.options.length);
    check(untouched === 3, 'a select nobody touched stays unfilled', untouched);

    // ---- 4. picking from the filled list still assigns ---------------------
    // cam0's track_0 row -> track_500, which cam0's third row holds: a swap.
    await ulTrackSel(0).selectOption('500');
    const picked = await page.evaluate(() => {
        const s = window.__lucid.state.session;
        const ul = s.getFrameGroup(0).getUnlinkedInstances('cam0').map(u => u.instance.trackIdx);
        const sels = Array.from(document.querySelectorAll('#unlinkedTable tbody tr:not(.unlinked-camera-header) td:first-child select'));
        return { ul, shown: sels.slice(0, 5).map(el => el.options[el.selectedIndex].textContent) };
    });
    check(picked.ul[0] === 500 && picked.ul[2] === 0,
        'picking track_500 assigns it, and the row that held it takes track_0', picked.ul);
    check(picked.shown[0] === 'track_500' && picked.shown[2] === 'track_0',
        'the rebuilt panel shows the swap', picked.shown);

    // A group row: "(none)" un-tracks the whole group.
    const grpTrackSel = page.locator('#instanceGroupsTable tbody tr td:first-child select');
    const gIdx = await grpTrackSel.evaluateAll(els => els.findIndex(el => el.value === '3'));
    await grpTrackSel.nth(gIdx).focus();
    await grpTrackSel.nth(gIdx).selectOption('-1');
    const noneRes = await page.evaluate(() => {
        const g = window.__lucid.state.session.instanceGroups.get(0).find(x => x.id === 1);
        return [...g.instances.values()].map(i => i.trackIdx);
    });
    check(noneRes.every(t => t == null), '"(none)" on a group row makes every member trackless', noneRes);

    // "(+) New Track" still opens the inline name box.
    await ulTrackSel(3).focus();
    await ulTrackSel(3).selectOption('__new__');
    const box = await page.evaluate(() => {
        const el = document.activeElement;
        return el && el.tagName === 'INPUT' ? { value: el.value, inUnlinked: !!el.closest('#unlinkedTable') } : null;
    });
    check(box && box.inUnlinked && box.value === 'track_1000',
        '"(+) New Track" replaces the select with the name box (default track_1000)', box);
    await page.keyboard.press('Escape');

    check(errs.length === 0, 'no page errors', errs);
    await browser.close();
} catch (e) {
    console.error(e);
    fails++;
    if (browser) await browser.close();
} finally {
    server.kill();
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
