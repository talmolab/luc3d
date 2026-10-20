/**
 * custom-delete-modal.mjs — real-browser test for the Edit ▸ "Custom Instance
 * Delete…" dialog. The matching/cascade/durability logic is unit tested
 * (tests/test-custom-delete-ops.js) and round-trip tested
 * (tests/e2e/custom-delete-roundtrip.mjs); this covers the parts only a real DOM
 * can: the menu item exists and opens the dialog, the live count and per-camera
 * breakdown track the selects, the cascade warning appears, Esc closes, and the
 * Delete button actually mutates the model.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8102);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // Inject a session into the real app-state singleton: 3 cameras, one
    // all-predicted group + one MIXED group (so the cascade line has something to
    // say) + two ungrouped instances.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session, UnlinkedInstance } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = ['cam1', 'cam2', 'cam3'].map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [640, 480]));
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const session = new Session(cams, skel, ['t0', 't1'], 'ModalTest');
        const mk = (t, type) => new Instance([[1, 2], [3, 4]], t, type, 1);

        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        const gA = new InstanceGroup(1, -1);              // all predicted, 2 members
        gA.addInstance('cam1', mk(0, 'predicted'));
        gA.addInstance('cam2', mk(0, 'predicted'));
        const gB = new InstanceGroup(2, -1);              // MIXED, 2 members
        gB.addInstance('cam1', mk(1, 'user'));
        gB.addInstance('cam2', mk(1, 'predicted'));
        for (const g of [gA, gB]) {
            for (const [cn, inst] of g.instances) fg.addInstance(cn, inst);
            g.points3d = new Float64Array([1, 2, 3, 4, 5, 6]);
        }
        session.instanceGroups.set(0, [gA, gB]);
        fg.addUnlinkedInstance('cam3', new UnlinkedInstance(mk(null, 'predicted'), 'cam3'));
        fg.addUnlinkedInstance('cam3', new UnlinkedInstance(mk(1, 'user'), 'cam3'));

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 1;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = [];
    });

    // ---- the menu item exists and opens the dialog -------------------------
    const menuExists = await page.evaluate(() => !!document.getElementById('menuCustomDeleteInstance'));
    check(menuExists, 'Edit menu has a "Custom Instance Delete..." item');
    const menuLabel = await page.evaluate(() => {
        const el = document.getElementById('menuCustomDeleteInstance');
        return el ? el.textContent.trim() : null;
    });
    check(menuLabel === 'Custom Instance Delete...',
        `menu label matches SLEAP's wording (got ${JSON.stringify(menuLabel)})`);

    // The Edit dropdown is collapsed by default, so open it the way a user
    // would — this also asserts the item is reachable from the real menu.
    await page.click('.menu-item[data-menu="edit"]');
    await page.waitForSelector('#menuCustomDeleteInstance', { state: 'visible', timeout: 5000 });
    await page.click('#menuCustomDeleteInstance');
    await page.waitForSelector('.multi-frame-modal', { timeout: 5000 });
    const title = await page.evaluate(() => {
        const h = document.querySelector('.multi-frame-modal h3');
        return h ? h.textContent : null;
    });
    check(title === 'Custom Instance Delete', `dialog opened with the right title (got ${JSON.stringify(title)})`);

    const read = () => page.evaluate(() => ({
        count: document.getElementById('cdCount').textContent,
        cascade: document.getElementById('cdCascade').style.display === 'none'
            ? null : document.getElementById('cdCascade').textContent,
        rows: Array.from(document.querySelectorAll('#cdBreakdown tr')).map(tr =>
            Array.from(tr.children).map(td => td.textContent)),
        applyDisabled: document.getElementById('cdApply').disabled,
        type: document.getElementById('cdType').value,
        grouping: document.getElementById('cdGrouping').value,
        frames: document.getElementById('cdFrames').value,
        hasTrackRow: !!document.getElementById('cdTrack'),
        hasIdentityRow: !!document.getElementById('cdIdentity'),
        frameOpts: Array.from(document.getElementById('cdFrames').options).map(o => o.textContent),
        typeOpts: Array.from(document.getElementById('cdType').options).map(o => o.textContent),
    }));

    // ---- defaults -----------------------------------------------------------
    const d = await read();
    console.log('    defaults:', JSON.stringify(d));
    check(d.type === 'predicted', `default type is "predicted", matching SLEAP (got ${d.type})`);
    check(d.grouping === 'any', `default grouping is "any" (got ${d.grouping})`);
    check(d.frames === 'currentFrame', `default scope is current frame, matching SLEAP (got ${d.frames})`);
    check(d.hasTrackRow, 'track filter row present (session has tracks)');
    check(!d.hasIdentityRow, 'identity filter row absent (session has no identities)');
    check(d.frameOpts.join('|') === 'Current frame|Current session',
        `scope offers only implemented options (got ${JSON.stringify(d.frameOpts)})`);
    check(d.typeOpts.some(t => t.indexOf('All instances') === 0),
        `type offers "All instances (user + predicted)" (got ${JSON.stringify(d.typeOpts)})`);
    check(!d.typeOpts.some(t => /Unlinked/i.test(t)) &&
          !d.frameOpts.some(t => /Unlinked/i.test(t)),
        'no option says "Unlinked" — in SLEAP that means a from_predicted orphan, not "ungrouped"');

    // predicted, any grouping, current frame -> gA(2) + gB.cam2(1) + ungrouped cam3(1) = 4
    check(/^4 instances/.test(d.count), `live count reads 4 for predicted (got "${d.count}")`);
    check(!d.applyDisabled, 'Delete enabled when the count is non-zero');
    // Breakdown: header + cam1(1) + cam2(2) + cam3(1) + Total
    const bodyRows = d.rows.slice(1);
    check(bodyRows.length === 4,
        `per-camera breakdown has 3 camera rows + Total (got ${bodyRows.length}: ${JSON.stringify(bodyRows)})`);
    check(bodyRows[bodyRows.length - 1][0] === 'Total' && bodyRows[bodyRows.length - 1][1] === '4',
        `breakdown Total row reads 4 (got ${JSON.stringify(bodyRows[bodyRows.length - 1])})`);

    // ---- the cascade warning ------------------------------------------------
    check(!!d.cascade, `cascade warning shown (got ${JSON.stringify(d.cascade)})`);
    check(/group\(s\) removed/.test(d.cascade || ''),
        'cascade mentions the all-predicted group being removed');
    check(/lose their 3D/.test(d.cascade || ''),
        'cascade warns that groups lose their 3D');

    // Deleting the USER member of the mixed group promotes its predicted survivor.
    await page.selectOption('#cdType', 'user');
    await page.selectOption('#cdGrouping', 'grouped');
    await page.selectOption('#cdView', 'cam:cam1');
    const promo = await read();
    console.log('    user/grouped/cam1:', JSON.stringify({ count: promo.count, cascade: promo.cascade }));
    check(/^1 instance /.test(promo.count), `count updates live to 1 (got "${promo.count}")`);
    check(/promoted to User/.test(promo.cascade || ''),
        `cascade warns about the silent predicted->User promotion (got ${JSON.stringify(promo.cascade)})`);

    // ---- zero-match state ---------------------------------------------------
    await page.selectOption('#cdTrack', 'none');
    const zero = await read();
    check(/^No instances match/.test(zero.count), `zero-match message shown (got "${zero.count}")`);
    check(zero.applyDisabled, 'Delete disabled when nothing matches');
    check(zero.rows.length === 0, 'breakdown cleared when nothing matches');

    // ---- Esc closes ---------------------------------------------------------
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.multi-frame-modal'), { timeout: 5000 });
    check(true, 'Esc closes the dialog (CLAUDE.md modal convention)');

    // ---- Delete actually mutates the model ---------------------------------
    await page.click('.menu-item[data-menu="edit"]');
    await page.waitForSelector('#menuCustomDeleteInstance', { state: 'visible', timeout: 5000 });
    await page.click('#menuCustomDeleteInstance');
    await page.waitForSelector('.multi-frame-modal', { timeout: 5000 });
    await page.selectOption('#cdType', 'predicted');
    await page.selectOption('#cdGrouping', 'ungrouped');
    const beforeDel = await page.evaluate(() => {
        const fg = window.__lucid.state.session.getFrameGroup(0);
        return (fg.getUnlinkedInstances('cam3') || []).length;
    });
    await page.click('#cdApply');
    await page.waitForFunction(() => !document.querySelector('.multi-frame-modal'), { timeout: 5000 });
    const afterDel = await page.evaluate(() => {
        const fg = window.__lucid.state.session.getFrameGroup(0);
        return {
            pool: (fg.getUnlinkedInstances('cam3') || []).length,
            status: document.getElementById('statusText').textContent,
            groups: (window.__lucid.state.session.instanceGroups.get(0) || []).length,
        };
    });
    console.log('    after delete:', JSON.stringify(afterDel), `(pool was ${beforeDel})`);
    check(beforeDel === 2, `precondition: cam3 pool had 2 entries (got ${beforeDel})`);
    check(afterDel.pool === 1,
        `Delete removed the predicted ungrouped instance, kept the user one (got ${afterDel.pool})`);
    check(afterDel.groups === 2, `grouped instances untouched by an "ungrouped only" delete (got ${afterDel.groups})`);
    check(/Deleted 1 instance/.test(afterDel.status), `status reports the deletion (got "${afterDel.status}")`);

    check(errs.length === 0, 'no page errors / console errors' + (errs.length ? ': ' + errs[0] : ''));
} finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
