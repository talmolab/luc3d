/**
 * info-panel-reprojection-row.mjs — the Grouped Instances table's reprojection
 * rows (ui/info-panel.js `updateFrameInfo`), in the real app.
 *
 * Asserted:
 *  1. The badge reads "Reprojection" (it used to read "Reproj").
 *  2. Every row has one cell per header column. The reprojection row used to
 *     have no Identity cell, so each later cell sat one column to the left:
 *     the view count under Identity, the badge under Views, the error under
 *     Type.
 *  3. Each reprojection-row cell is under its own header — the badge under
 *     Type, the view count under Views, the error dash under Error — with the
 *     Error column shown, as it is once a frame has triangulation results.
 *
 * Run: node tests/e2e/info-panel-reprojection-row.mjs
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
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // Two groups seen by cam1 + cam2, each reprojected into cam3.
    const t = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const IP = await import('/ui/info-panel.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const mtx = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
        const cams = ['cam1', 'cam2', 'cam3'].map((n, i) =>
            new Camera(n, mtx, [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [512, 512]));
        const s = new Session(cams, new Skeleton('skeleton', ['nose', 'tail'], [[0, 1]]), ['mouseA', 'mouseB'], 'S');
        const mk = (tr, type) => new Instance([[1, 2], [3, 4]], tr, type, 1);
        const fg = new FrameGroup(0); s.addFrameGroup(fg);
        const groups = [0, 1].map((tr) => {
            const g = new InstanceGroup(tr + 1, -1);
            g.addInstance('cam1', mk(tr, 'user'));
            g.addInstance('cam2', mk(tr, 'user'));
            for (const [cn, inst] of g.instances) fg.addInstance(cn, inst);
            g.addReprojectedInstance('cam3', mk(tr, 'predicted'));
            return g;
        });
        s.instanceGroups.set(0, groups);
        AS.state.session = s; AS.state.sessions = [s]; AS.state.currentFrame = 0;
        AS.state.triangulationResults.set(0, groups.map((g) =>
            ({ group: g, errors: { cam1: [1, 2], cam2: [3, 4] }, meanError: 2.5, method: 'dlt' })));
        IP.updateFrameInfo(0, groups);
        // What the app does once a frame is triangulated: reveal the Error column.
        (await import('/ui/rendering.js')).setReprojErrorVisible(true);

        const table = document.getElementById('instanceGroupsTable');
        const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
        const rows = [...table.querySelectorAll('tbody tr')].map(tr => ({
            reproj: !!tr.querySelector('.badge-reproj'),
            cells: [...tr.children].map(td => ({
                text: td.textContent.trim(),
                badge: td.querySelector('.badge-reproj') ? td.querySelector('.badge-reproj').textContent : null,
                shown: getComputedStyle(td).display !== 'none',
            })),
        }));
        const errorShown = getComputedStyle(table.querySelector('thead th.reproj-error-col')).display !== 'none';
        return { headers, rows, errorShown };
    });

    const col = (name) => t.headers.indexOf(name);
    const reprojRows = t.rows.filter(r => r.reproj);
    check(reprojRows.length === 2, `both groups show a reprojection row (got ${reprojRows.length})`);
    check(t.errorShown, 'the Error column is shown (the frame has triangulation results)');

    // ---- 1. the badge text --------------------------------------------------------
    const badges = reprojRows.flatMap(r => r.cells.map(c => c.badge).filter(Boolean));
    check(badges.length === 2 && badges.every(b => b === 'Reprojection'),
        `the badge reads "Reprojection" (got ${JSON.stringify(badges)})`);

    // ---- 2. one cell per header column, in every row ------------------------------
    for (const [i, r] of t.rows.entries()) {
        check(r.cells.length === t.headers.length,
            `row ${i} (${r.reproj ? 'reprojection' : 'group'}) has ${r.cells.length} cells for ${t.headers.length} headers`);
    }

    // ---- 3. each reprojection cell is under its own header ------------------------
    for (const [i, r] of reprojRows.entries()) {
        const badgeAt = r.cells.findIndex(c => c.badge);
        check(badgeAt === col('Type'), `reprojection row ${i}: the badge is under Type (column ${badgeAt}, Type is ${col('Type')})`);
        check(r.cells[col('Views')] && r.cells[col('Views')].text === '1/3',
            `reprojection row ${i}: "1/3" is under Views (got "${r.cells[col('Views')] && r.cells[col('Views')].text}")`);
        check(r.cells[col('Identity')] && r.cells[col('Identity')].text === '',
            `reprojection row ${i}: the Identity cell is empty`);
        const err = r.cells[col('Error')];
        check(err && err.shown && err.text === '-', `reprojection row ${i}: the error dash is under Error, and shown`);
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
