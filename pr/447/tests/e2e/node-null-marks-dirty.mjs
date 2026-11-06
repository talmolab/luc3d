/**
 * node-null-marks-dirty.mjs — every right-click node-null toggle flags the
 * project as unsaved.
 *
 * Right-click (or Ctrl+click) on a user node toggles it null, and the toggle is
 * saved, but `onNodeSetNull` (`pose/initialization.js`) only called the GROUP's
 * `markDirty()` (re-triangulation), never the project-level one. On a freshly
 * opened project `state.isDirty` stayed false: no save dot, no prompt on
 * closing the tab or switching sessions. The unlinked-instance branch in
 * `ui/interaction.js` toggled `nulledNodes` without calling any callback.
 *
 * Asserted here, by real right-clicks on the overlay canvas, each starting from
 * `clearDirty()`:
 *   1. a grouped user node        (`_toggleNodeNull` → `onNodeSetNull`)
 *   2. an unlinked user node      (→ `onUnlinkedNodeSetNull`)
 *   3. a reprojected node         (reprojected branch → `onNodeSetNull`)
 *   4. a plane node in Define Planes (`onPlaneChanged`) — already marked dirty;
 *      kept so all four null paths are pinned together.
 * Each also checks the node really toggled, so a missed click cannot pass, and
 * that `session.isDirty` (what the switch-away prompt reads) follows.
 *
 * Confirmed to fail (1–3) without the fix.
 *
 * Run: node tests/e2e/node-null-marks-dirty.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;
        console.log('  [console.error]', t.slice(0, 300));
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    // Two cameras, one frame: a grouped user instance in camA only (camB
    // shows its reprojection), and an unlinked user instance in camB.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const SL = await import('/import-export/save-load.js');
        const { Camera, Session, Skeleton, FrameGroup, Instance, InstanceGroup, UnlinkedInstance } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = ['camA', 'camB'].map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [640, 480]));
        const session = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], 'S1');

        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        const grouped = new Instance([[200, 200], [260, 260]], 0, 'user', 1);
        fg.addInstance('camA', grouped);
        const group = new InstanceGroup(1, 0);
        group.addInstance('camA', grouped);
        group.addReprojectedInstance('camB', new Instance([[420, 120], [480, 140]], 0, 'reprojected', 1));
        session.instanceGroups.set(0, [group]);
        const ul = new Instance([[150, 380], [220, 400]], null, 'user', 1);
        fg.addUnlinkedInstance('camB', new UnlinkedInstance(ul, 'camB'));

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 1;
        AS.state.currentFrame = 0;
        AS.state.views = cams.map(c => ({ name: c.name, videoWidth: 640, videoHeight: 480, canvas: null }));
        AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name }));
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();

        window.__t = { group, grouped, ul, SL, AS };
        window.__videoToClient = (viewName, vx, vy) => {
            const v = AS.state.views.find(x => x.name === viewName);
            const r = v.overlayCanvas.getBoundingClientRect();
            return [r.left + vx * (r.width / v.videoWidth), r.top + vy * (r.height / v.videoHeight)];
        };
        window.__dirty = () => ({
            state: AS.state.isDirty === true,
            session: AS.state.session.isDirty === true,
        });
    });
    await page.waitForFunction(
        () => window.__lucid.state.views.every(v => !!v.overlayCanvas), null, { timeout: 30000 });
    await page.waitForTimeout(300);

    const rightClick = async (view, vx, vy) => {
        const [x, y] = await page.evaluate(([v, a, b]) => window.__videoToClient(v, a, b), [view, vx, vy]);
        await page.mouse.click(x, y, { button: 'right' });
    };
    const clean = () => page.evaluate(() => window.__t.SL.clearDirty());
    // The mousedown handler can run a beat after `mouse.click` resolves; wait
    // for the toggle itself (bounded) before reading the dirty flag.
    const settle = (expr, want) => page.waitForFunction(
        ([e, w]) => (0, eval)(e) === w, [expr, want], { timeout: 3000 }).catch(() => {});

    // 1 — grouped user node.
    await clean();
    check(!(await page.evaluate(() => window.__lucid.state.isDirty)), 'starts clean');
    await rightClick('camA', 200, 200);
    await settle('!!(window.__t.grouped.nulledNodes && window.__t.grouped.nulledNodes.has(0))', true);
    let m = await page.evaluate(() => ({
        nulled: !!(window.__t.grouped.nulledNodes && window.__t.grouped.nulledNodes.has(0)),
        d: window.__dirty(),
    }));
    check(m.nulled, 'right-click nulls the grouped user node');
    check(m.d.state && m.d.session, `grouped null marks the project dirty (${JSON.stringify(m.d)})`);

    // ...and restoring it is an edit too.
    await clean();
    await rightClick('camA', 200, 200);
    await settle('window.__t.grouped.nulledNodes.has(0)', false);
    m = await page.evaluate(() => ({
        nulled: window.__t.grouped.nulledNodes.has(0), d: window.__dirty(),
    }));
    check(!m.nulled, 'right-click again restores it');
    check(m.d.state && m.d.session, `restoring marks the project dirty (${JSON.stringify(m.d)})`);

    // 2 — unlinked user node.
    await clean();
    await rightClick('camB', 150, 380);
    await settle('!!(window.__t.ul.nulledNodes && window.__t.ul.nulledNodes.has(0))', true);
    m = await page.evaluate(() => ({
        nulled: !!(window.__t.ul.nulledNodes && window.__t.ul.nulledNodes.has(0)),
        d: window.__dirty(),
    }));
    check(m.nulled, 'right-click nulls the unlinked user node');
    check(m.d.state && m.d.session, `unlinked null marks the project dirty (${JSON.stringify(m.d)})`);

    // 3 — reprojected node (camB has no main instance for the group).
    await clean();
    await rightClick('camB', 420, 120);
    await settle("!!(window.__t.group.getReprojectedInstance('camB').nulledNodes && window.__t.group.getReprojectedInstance('camB').nulledNodes.has(0))", true);
    m = await page.evaluate(async () => {
        const r = window.__t.group.getReprojectedInstance('camB');
        return { nulled: !!(r && r.nulledNodes && r.nulledNodes.has(0)), d: window.__dirty() };
    });
    check(m.nulled, 'right-click nulls the reprojected node');
    check(m.d.state && m.d.session, `reprojected null marks the project dirty (${JSON.stringify(m.d)})`);

    // 4 — plane node in Define Planes.
    const planeReady = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        if (!P.isPlaneModeActive()) P.togglePlaneMode();
        if (!P.isPlaneModeActive()) return 'plane mode did not turn on';
        const model = P.planeModel();
        const plane = P.createPlane('floor');
        const nodes = [0, 1, 2, 3].map(k => model.addNode('c' + k));
        nodes.forEach(nd => plane.addNode(nd.id));
        const inst = P.placePlaneOnView(plane, 'camA', 450, 350);
        const idx = nodes.map(nd => model.pool.indexOf(nd.id));
        window.__planeAt = [inst.getX(idx[0]), inst.getY(idx[0])];
        window.__planeIdx = idx;
        return 'ok';
    });
    if (planeReady !== 'ok') {
        check(false, `plane fixture: ${planeReady}`);
    } else {
        await clean();
        const at = await page.evaluate(() => window.__planeAt);
        await rightClick('camA', at[0], at[1]);
        await settle('window.__lucid.state.isDirty', true);
        m = await page.evaluate(async () => {
            const P = await import('/ui/plane-definition.js');
            return {
                nulled: P.getPlaneInstance('camA').isNodeNulled(window.__planeIdx[0]),
                d: window.__dirty(),
            };
        });
        check(m.nulled, 'right-click nulls the plane node');
        check(m.d.state && m.d.session, `plane-node null marks the project dirty (${JSON.stringify(m.d)})`);
    }

    await browser.close();
} catch (e) {
    console.log('  ✗ threw:', e && e.stack || e);
    fails++;
    if (browser) await browser.close().catch(() => {});
} finally {
    server.kill();
}

console.log(fails ? `\nFAIL — ${fails} check(s) failed` : '\nPASS');
process.exit(fails ? 1 : 0);
