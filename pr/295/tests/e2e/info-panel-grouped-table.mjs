/**
 * info-panel-grouped-table.mjs — the info panel's Grouped Instances table
 * (ui/info-panel.js `updateFrameInfo`), in the real app.
 *
 * Asserted:
 *  1. It fits a 300 px info panel (the default width) with no sideways scroll,
 *     even with a group marked dirty, a five-character error, and room left for
 *     the tab's vertical scrollbar (11 px in Chrome; headless Chromium hides
 *     scrollbars, so the allowance is subtracted by hand). Measured as the
 *     table's MIN-CONTENT width: the table is `width: 100%`, so its rendered
 *     width always equals the space it is given and cannot show an overflow.
 *     Side by side, its track and identity dropdowns made it 389 px wide; they
 *     are now STACKED in one "Track / Identity" column, both the same width
 *     and left-aligned.
 *  2. Every row has one cell per header column. The reprojection row used to
 *     lack one, so each later cell sat a column to the left.
 *  3. The reprojection row leads with a "Reprojection" badge in the Track /
 *     Identity column (the group's name is on the row above, and in the
 *     tooltip); its view count is under Views, Type is empty, and the error
 *     dash is under Error.
 *
 * Run: node tests/e2e/info-panel-grouped-table.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8298);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    // 1440 px wide, so the info panel opens at its default 300 px.
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // Three groups seen by cam1-cam4, each reprojected into cam5. Names are
    // ordinary ones; the error column holds a three-digit value; one group is
    // dirty, which adds its marker beside the track dropdown.
    const t = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const IP = await import('/ui/info-panel.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const mtx = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
        const cams = [1, 2, 3, 4, 5].map((i) =>
            new Camera('cam' + i, mtx, [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [512, 512]));
        const s = new Session(cams, new Skeleton('skeleton', ['nose', 'tail'], [[0, 1]]), ['track_0', 'track_1', 'track_2'], 'S');
        ['mouse1', 'mouse2', 'mouse3'].forEach(n => s.addIdentity(n));
        const mk = (tr, type) => new Instance([[1, 2], [3, 4]], tr, type, 1);
        const fg = new FrameGroup(0); s.addFrameGroup(fg);
        const groups = [0, 1, 2].map((tr) => {
            const g = new InstanceGroup(tr + 1, tr);
            for (let c = 1; c <= 4; c++) g.addInstance('cam' + c, mk(tr, tr ? 'predicted' : 'user'));
            for (const [cn, inst] of g.instances) fg.addInstance(cn, inst);
            g.addReprojectedInstance('cam5', mk(tr, 'predicted'));
            return g;
        });
        groups[1].dirty = true;
        groups[1].instances.values().next().value.modified = true;   // "Pred*"
        s.instanceGroups.set(0, groups);
        AS.state.session = s; AS.state.sessions = [s]; AS.state.currentFrame = 0;
        AS.state.triangulationResults.set(0, groups.map((g, i) =>
            ({ group: g, errors: {}, meanError: [2.5, 14.25, 999.9][i], method: 'dlt' })));
        IP.updateFrameInfo(0, groups);
        // What the app does once a frame is triangulated: reveal the Error column.
        (await import('/ui/rendering.js')).setReprojErrorVisible(true);
        const tab = document.getElementById('tabInstances');
        tab.style.overflowY = 'scroll';   // a scrollbar, where the browser draws one

        const table = document.getElementById('instanceGroupsTable');
        const sec = table.closest('.info-section');
        const cs = getComputedStyle(sec);
        const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
        const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
        const rows = [...table.querySelectorAll('tbody tr')].map(tr => ({
            reproj: !!tr.querySelector('.badge-reproj'),
            selects: [...tr.querySelectorAll('select')].map(s => ({ cell: [...tr.children].indexOf(s.closest('td')), ...box(s) })),
            cells: [...tr.children].map(td => ({
                text: td.textContent.trim(),
                title: td.title,
                badge: td.querySelector('.badge-reproj') ? td.querySelector('.badge-reproj').textContent : null,
                shown: getComputedStyle(td).display !== 'none',
            })),
        }));
        return {
            headers, rows,
            panelWidth: Math.round(document.getElementById('infoPanelWrapper').getBoundingClientRect().width),
            minContent: (() => {
                table.style.width = 'min-content';
                const w = table.getBoundingClientRect().width;
                table.style.width = '';
                return w;
            })(),
            available: sec.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
            scrollbar: tab.offsetWidth - tab.clientWidth,
            hScroll: tab.scrollWidth - tab.clientWidth,
        };
    });

    const col = (name) => t.headers.indexOf(name);
    const reprojRows = t.rows.filter(r => r.reproj);
    const groupRows = t.rows.filter(r => !r.reproj);

    // ---- 1. it fits ---------------------------------------------------------------
    check(t.panelWidth >= 299 && t.panelWidth <= 301, `the info panel is at its default 300 px (${t.panelWidth})`);
    // Chrome's scrollbar here is 11 px (styles.css asks for 6, the platform
    // draws 11); headless Chromium draws none, so take it off by hand.
    const room = t.available - (t.scrollbar > 0 ? 0 : 11);
    check(t.minContent <= room,
        `the table fits the panel: needs ${t.minContent.toFixed(1)} px, has ${room.toFixed(1)} px with a scrollbar showing`);
    check(t.hScroll <= 0, `the Instances tab does not scroll sideways (overflow ${t.hScroll} px)`);
    check(JSON.stringify(t.headers) === JSON.stringify(['Track / Identity', 'Views', 'Type', 'Error', '']),
        `the headers are ${JSON.stringify(t.headers)}`);
    for (const [i, r] of groupRows.entries()) {
        const [trk, idn] = r.selects;
        check(r.selects.length === 2 && trk.cell === 0 && idn.cell === 0,
            `group row ${i}: both dropdowns are in the Track / Identity cell`);
        check(trk && idn && idn.top >= trk.bottom && Math.abs(idn.left - trk.left) < 0.5 && Math.abs(idn.width - trk.width) < 0.5,
            `group row ${i}: identity is stacked under track, same left edge and width (${trk && trk.width.toFixed(0)} px)`);
    }

    // ---- 2. one cell per header column, in every row ------------------------------
    for (const [i, r] of t.rows.entries()) {
        check(r.cells.length === t.headers.length,
            `row ${i} (${r.reproj ? 'reprojection' : 'group'}) has ${r.cells.length} cells for ${t.headers.length} headers`);
    }

    // ---- 3. the reprojection row --------------------------------------------------
    check(reprojRows.length === 3, `every group shows a reprojection row (got ${reprojRows.length})`);
    for (const [i, r] of reprojRows.entries()) {
        const lead = r.cells[0];
        check(lead.badge === 'Reprojection' && lead.title === 'Reprojection of track_' + i,
            `reprojection row ${i}: "Reprojection" badge leads the row, tooltip "${lead.title}"`);
        check(r.cells[col('Views')].text === '1/5', `reprojection row ${i}: "1/5" is under Views (got "${r.cells[col('Views')].text}")`);
        check(r.cells[col('Type')].text === '', `reprojection row ${i}: Type is empty`);
        const err = r.cells[col('Error')];
        check(err.shown && err.text === '-', `reprojection row ${i}: the error dash is under Error, and shown`);
    }
} catch (e) {
    console.log('  ✗ threw: ' + (e && e.stack || e));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
