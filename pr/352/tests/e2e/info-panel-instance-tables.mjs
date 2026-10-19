/**
 * info-panel-instance-tables.mjs — the info panel's two instance tables,
 * Grouped Instances and Ungrouped Instances (ui/info-panel.js
 * `updateFrameInfo`), in the real app.
 *
 * Asserted:
 *  1. Both fit a 300 px info panel (the default width), and the Instances tab
 *     does not scroll sideways — with a dirty group, a five-character error,
 *     a trackless ungrouped instance, and room left for the tab's vertical
 *     scrollbar (11 px in Chrome; headless Chromium hides scrollbars, so the
 *     allowance is subtracted by hand). Measured as each table's MIN-CONTENT
 *     width: the tables are `width: 100%`, so their rendered width always
 *     equals the space they are given and cannot show an overflow. Side by
 *     side, the dropdowns made Grouped ~390 px and Ungrouped ~324 px wide; in
 *     both tables they are now STACKED in one "Track / Identity" column, the
 *     same width, left-aligned, track on top.
 *  2. Every Grouped row has one cell per header column. The reprojection row
 *     used to lack one, so each later cell sat a column to the left.
 *  3. The reprojection row leads with a "Reprojection" badge in the Track /
 *     Identity column (the group's name is on the row above, and in the
 *     tooltip); its view count is under Views, Type is empty, and the error
 *     dash is under Error.
 *  4. Every Ungrouped data row has one cell per header column, with Type,
 *     Points and Score under their headers; each camera's header row spans
 *     the whole table.
 *  5. In both tables the identity dropdown ends in "(+) New Identity" (it read
 *     "(+) New ID"), beside the track dropdown's "(+) New Track".
 *  6. In both tables, every track and identity dropdown's "nothing" option
 *     reads "(none)" (the Ungrouped table's read "—"), and the trackless row
 *     shows it.
 *
 * Run: node tests/e2e/info-panel-instance-tables.mjs
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
    // 1440 px wide, so the info panel opens at its default 300 px.
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // Three groups seen by cam1-cam4, each reprojected into cam5; one group is
    // dirty (its marker sits beside the track dropdown) and one has a
    // three-digit error. Plus ungrouped detections on cam4 and cam5, one of
    // them trackless.
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
        const mk = (tr, type, score) => new Instance([[1, 2], [3, 4]], tr, type, score == null ? 1 : score);
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
        s.addUnlinkedInstance(0, 'cam4', mk(2, 'user'));
        s.addUnlinkedInstance(0, 'cam5', mk(0, 'predicted', 0.87));
        s.addUnlinkedInstance(0, 'cam5', mk(null, 'predicted', 0.42));
        AS.state.triangulationResults.set(0, groups.map((g, i) =>
            ({ group: g, errors: {}, meanError: [2.5, 14.25, 999.9][i], method: 'dlt' })));
        IP.updateFrameInfo(0, groups);
        // What the app does once a frame is triangulated: reveal the Error column.
        (await import('/ui/rendering.js')).setReprojErrorVisible(true);
        const tab = document.getElementById('tabInstances');
        tab.style.overflowY = 'scroll';   // a scrollbar, where the browser draws one

        const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
        const readTable = (id) => {
            const table = document.getElementById(id);
            const sec = table.closest('.info-section');
            const cs = getComputedStyle(sec);
            table.style.width = 'min-content';
            const minContent = table.getBoundingClientRect().width;
            table.style.width = '';
            return {
                minContent,
                available: sec.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
                headers: [...table.querySelectorAll('thead th')].map(th => th.textContent.trim()),
                rows: [...table.querySelectorAll('tbody tr')].map(tr => ({
                    cameraHeader: tr.classList.contains('unlinked-camera-header'),
                    reproj: !!tr.querySelector('.badge-reproj'),
                    span: [...tr.children].reduce((n, td) => n + td.colSpan, 0),
                    selects: [...tr.querySelectorAll('select')].map(s => ({ cell: [...tr.children].indexOf(s.closest('td')), value: s.value,
                        lastOption: s.options.length ? s.options[s.options.length - 1].textContent : null,
                        noneOption: [...s.options].filter(o => o.value === '-1').map(o => o.textContent).join('|'),
                        shownText: s.selectedIndex >= 0 ? s.options[s.selectedIndex].textContent : null, ...box(s) })),
                    cells: [...tr.children].map(td => ({
                        text: td.textContent.trim(),
                        title: td.title,
                        badge: td.querySelector('.badge-reproj') ? td.querySelector('.badge-reproj').textContent : null,
                        shown: getComputedStyle(td).display !== 'none',
                    })),
                })),
            };
        };
        return {
            grouped: readTable('instanceGroupsTable'),
            ungrouped: readTable('unlinkedTable'),
            panelWidth: Math.round(document.getElementById('infoPanelWrapper').getBoundingClientRect().width),
            scrollbar: tab.offsetWidth - tab.clientWidth,
            hScroll: tab.scrollWidth - tab.clientWidth,
        };
    });

    // Chrome's scrollbar here is 11 px (styles.css asks for 6, the platform
    // draws 11); headless Chromium draws none, so take it off by hand.
    const room = (tbl) => tbl.available - (t.scrollbar > 0 ? 0 : 11);
    const checkStacked = (label, r) => {
        const [trk, idn] = r.selects;
        check(r.selects.length === 2 && trk.cell === 0 && idn.cell === 0,
            `${label}: both dropdowns are in the Track / Identity cell`);
        check(trk && idn && idn.top >= trk.bottom && Math.abs(idn.left - trk.left) < 0.5 && Math.abs(idn.width - trk.width) < 0.5,
            `${label}: identity is stacked under track, same left edge and width (${trk && trk.width.toFixed(0)} px)`);
    };

    // ---- 1. both tables fit -------------------------------------------------------
    check(t.panelWidth >= 299 && t.panelWidth <= 301, `the info panel is at its default 300 px (${t.panelWidth})`);
    for (const [name, tbl] of [['Grouped', t.grouped], ['Ungrouped', t.ungrouped]]) {
        check(tbl.minContent <= room(tbl),
            `${name} Instances fits the panel: needs ${tbl.minContent.toFixed(1)} px, has ${room(tbl).toFixed(1)} px with a scrollbar showing`);
    }
    check(t.hScroll <= 0, `the Instances tab does not scroll sideways (overflow ${t.hScroll} px)`);

    // ---- 2 + 3. Grouped Instances -------------------------------------------------
    const G = t.grouped;
    const gcol = (name) => G.headers.indexOf(name);
    check(JSON.stringify(G.headers) === JSON.stringify(['Track / Identity', 'Views', 'Type', 'Error', '']),
        `Grouped headers are ${JSON.stringify(G.headers)}`);
    G.rows.filter(r => !r.reproj).forEach((r, i) => checkStacked(`group row ${i}`, r));
    for (const [i, r] of G.rows.entries()) {
        check(r.cells.length === G.headers.length,
            `Grouped row ${i} (${r.reproj ? 'reprojection' : 'group'}) has ${r.cells.length} cells for ${G.headers.length} headers`);
    }
    const reprojRows = G.rows.filter(r => r.reproj);
    check(reprojRows.length === 3, `every group shows a reprojection row (got ${reprojRows.length})`);
    for (const [i, r] of reprojRows.entries()) {
        const lead = r.cells[0];
        check(lead.badge === 'Reprojection' && lead.title === 'Reprojection of track_' + i,
            `reprojection row ${i}: "Reprojection" badge leads the row, tooltip "${lead.title}"`);
        check(r.cells[gcol('Views')].text === '1/5', `reprojection row ${i}: "1/5" is under Views (got "${r.cells[gcol('Views')].text}")`);
        check(r.cells[gcol('Type')].text === '', `reprojection row ${i}: Type is empty`);
        const err = r.cells[gcol('Error')];
        check(err.shown && err.text === '-', `reprojection row ${i}: the error dash is under Error, and shown`);
    }

    // ---- 4. Ungrouped Instances ---------------------------------------------------
    const U = t.ungrouped;
    const ucol = (name) => U.headers.indexOf(name);
    check(JSON.stringify(U.headers) === JSON.stringify(['Track / Identity', 'Type', 'Points', 'Score']),
        `Ungrouped headers are ${JSON.stringify(U.headers)}`);
    const camRows = U.rows.filter(r => r.cameraHeader);
    const dataRows = U.rows.filter(r => !r.cameraHeader);
    check(JSON.stringify(camRows.map(r => r.cells[0].text)) === '["cam4","cam5"]',
        `one camera header per camera (${camRows.map(r => r.cells[0].text).join(', ')})`);
    check(camRows.every(r => r.span === U.headers.length), 'each camera header spans the whole table');
    check(dataRows.length === 3, `three ungrouped rows (got ${dataRows.length})`);
    dataRows.forEach((r, i) => checkStacked(`ungrouped row ${i}`, r));
    for (const [i, r] of dataRows.entries()) {
        check(r.cells.length === U.headers.length,
            `ungrouped row ${i} has ${r.cells.length} cells for ${U.headers.length} headers`);
    }
    const typesPtsScores = dataRows.map(r => [r.cells[ucol('Type')].text, r.cells[ucol('Points')].text, r.cells[ucol('Score')].text].join(' '));
    check(JSON.stringify(typesPtsScores) === JSON.stringify(['User 2/2 1.00', 'Pred 2/2 0.87', 'Pred 2/2 0.42']),
        `Type, Points and Score are under their headers (${typesPtsScores.join(' | ')})`);
    check(dataRows[2].selects[0].value === '-1' && dataRows[2].selects[0].shownText === '(none)',
        `the trackless row shows "(none)" for its track (got "${dataRows[2].selects[0].shownText}")`);

    // ---- 5. "(+) New Identity" -----------------------------------------------------
    for (const [name, rows] of [['Grouped', G.rows.filter(r => !r.reproj)], ['Ungrouped', dataRows]]) {
        const last = rows.map(r => r.selects[1] && r.selects[1].lastOption);
        check(last.length > 0 && last.every(x => x === '(+) New Identity'),
            `${name}: every identity dropdown ends in "(+) New Identity" (got ${JSON.stringify([...new Set(last)])})`);
    }

    // ---- 6. "(none)" in every dropdown ----------------------------------------------
    for (const [name, rows] of [['Grouped', G.rows.filter(r => !r.reproj)], ['Ungrouped', dataRows]]) {
        const nones = rows.flatMap(r => r.selects.map(x => x.noneOption));
        check(nones.length === rows.length * 2 && nones.every(x => x === '(none)'),
            `${name}: every track and identity dropdown's "nothing" option reads "(none)" (got ${JSON.stringify([...new Set(nones)])})`);
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
