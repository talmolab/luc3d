/**
 * define-plane-mode.mjs — "Defining Plane Mode" (View ▸ Define Planes) in the
 * real app, end to end.
 *
 * This is step 1 of re-defining the 3D viewer's origin: the user annotates a
 * plane, and a later step solves it into a translation + rotation. What that
 * later solve consumes is the `PlaneInstance` — a per-view set of 2D points —
 * so the assertions here are about the annotation existing, being editable,
 * and being drawn, not about looks:
 *
 *  1. The View menu item enters the mode: banner visible, info-panel tab bar
 *     swapped for the Define Plane panel. Exit restores the panel exactly.
 *  2. The editor's three sections are real <details>, so all of Nodes, Node
 *     Connections, and the whole "Define Plane Skeleton" block collapse.
 *  3. Adding nodes/connections mutates the SELECTED plane skeleton and the
 *     tables follow.
 *  4. Dropping a skeleton onto a view creates a PlaneInstance ON THAT VIEW,
 *     seeded around the drop point and clamped inside the frame. A SECOND drop
 *     of the same plane on the same view is refused rather than stacking or
 *     re-seeding, so carefully placed nodes can't be destroyed by a stray drag.
 *  5. The placement is actually DRAWN — `drawAllOverlays` must call the plane
 *     pass AFTER `drawFrameOverlays`, which opens with a clearRect. A
 *     regression that reorders them leaves the overlay blank, which this
 *     catches by sampling pixels. Placements are frame-independent.
 *  6. REGRESSION GUARD: the drag payload must not use `text/plain`.
 *     `ui/sessions-panes.js` tells dockview to accept any text/plain drag over
 *     the dock and turn it into a new video panel, so a text/plain payload
 *     here would be swallowed as a bogus view name instead of placing a plane.
 *  7. Per-node colour is scoped to the SKELETON, so a node is the same colour
 *     on every view — that is the cross-view correspondence cue. Changing it
 *     changes what is drawn on every placement.
 *  8. A PlaneInstance behaves like a UserInstance under the mouse: click to
 *     select, drag a node, Alt+drag the whole plane, right-click to toggle a
 *     node off. And the mode gate: OUTSIDE Defining Plane Mode the exact same
 *     drag must do nothing, so plane nodes never compete with pose nodes.
 *  9. Placements stay in sync with their skeleton across node add/remove, and
 *     deleting a skeleton takes its placements with it.
 *
 * Run: node define-plane-mode.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8194);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;   // absent demo assets
        console.log('  [console.error]', t.slice(0, 300));
        fails++;
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // =================================================================
    // Build a two-camera session with real canvases so overlays can draw
    // =================================================================
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Camera, Session, Skeleton } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = ['camA', 'camB'].map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [640, 480]));
        const session = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], 'S1');

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 10;
        AS.state.views = cams.map(c => ({
            name: c.name, videoWidth: 640, videoHeight: 480, canvas: null,
        }));
        AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name }));
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();

        // Map video pixels -> client pixels for the mouse-driven tests. Inverse
        // of InteractionManager.canvasToVideo on the no-rotation fast path.
        window.__videoToClient = (viewName, vx, vy) => {
            const v = AS.state.views.find(x => x.name === viewName);
            const r = v.overlayCanvas.getBoundingClientRect();
            return [
                r.left + vx * (r.width / v.videoWidth),
                r.top + vy * (r.height / v.videoHeight),
            ];
        };
    });
    await page.waitForFunction(
        () => window.__lucid.state.views.every(v => !!v.overlayCanvas), { timeout: 10000 });

    const toClient = (view, vx, vy) =>
        page.evaluate(([v, x, y]) => window.__videoToClient(v, x, y), [view, vx, vy]);

    // =================================================================
    // 1 — enter / exit the mode via the real View menu item
    // =================================================================
    console.log('\n1. Mode enter/exit');
    await page.click('.menu-item[data-menu="view"]');
    await page.click('#menuDefinePlanes');

    let m = await page.evaluate(() => ({
        barShown: getComputedStyle(document.getElementById('planeModeBar')).display !== 'none',
        barText: document.querySelector('.plane-mode-label').textContent,
        hasExit: !!document.getElementById('planeModeExit'),
        panelShown: getComputedStyle(document.getElementById('planePanel')).display !== 'none',
        tabsHidden: getComputedStyle(document.querySelector('.panel-tabs')).display === 'none',
        contentsHidden: Array.from(document.querySelectorAll('.panel-tab-content'))
            .every(el => getComputedStyle(el).display === 'none'),
    }));
    check(m.barShown, 'banner is visible');
    check(m.barText === 'Defining Plane Mode', `banner reads "Defining Plane Mode" (got "${m.barText}")`);
    check(m.hasExit, 'banner has an exit button');
    check(m.panelShown, 'Define Plane panel is shown in the info panel');
    check(m.tabsHidden, 'info-panel tab bar is hidden while in the mode');
    check(m.contentsHidden, 'no normal tab content is showing');

    await page.click('#planeModeExit');
    m = await page.evaluate(() => ({
        barHidden: getComputedStyle(document.getElementById('planeModeBar')).display === 'none',
        panelHidden: getComputedStyle(document.getElementById('planePanel')).display === 'none',
        tabsBack: getComputedStyle(document.querySelector('.panel-tabs')).display !== 'none',
        // Exactly the previously-active tab is visible again — the swap must be
        // exact, not "show everything".
        visibleContents: Array.from(document.querySelectorAll('.panel-tab-content'))
            .filter(el => getComputedStyle(el).display !== 'none').map(el => el.id),
    }));
    check(m.barHidden, 'exit hides the banner');
    check(m.panelHidden, 'exit hides the Define Plane panel');
    check(m.tabsBack, 'exit restores the tab bar');
    check(eq(m.visibleContents, ['tabInstances']), `exit restores exactly the active tab (got ${JSON.stringify(m.visibleContents)})`);

    // Re-enter for the rest of the run.
    await page.click('.menu-item[data-menu="view"]');
    await page.click('#menuDefinePlanes');

    // =================================================================
    // 2 — collapsible sections
    // =================================================================
    console.log('\n2. Collapsible sections');
    m = await page.evaluate(() => {
        const ids = ['planeEditorDetails', 'planeNodesDetails', 'planeEdgesDetails'];
        const els = ids.map(id => document.getElementById(id));
        const out = {
            allDetails: els.every(e => e && e.tagName === 'DETAILS'),
            summaries: els.map(e => e && e.querySelector('summary').textContent.trim()),
            openByDefault: els.every(e => e.open),
        };
        // Collapse each and confirm the section actually shrinks to its
        // summary. Measure the <details> itself, not the body: Chromium keeps
        // a closed details' content in a `content-visibility` slot, so the
        // body still reports its intrinsic height even though nothing of it is
        // laid out or painted.
        els.forEach(e => { e.open = false; });
        out.collapsedHeights = els.map(e => e.offsetHeight);
        out.summaryHeights = els.map(e => e.querySelector('summary').offsetHeight);
        els.forEach(e => { e.open = true; });
        out.expandedHeights = els.map(e => e.offsetHeight);
        return out;
    });
    check(m.allDetails, 'all three sections are <details>');
    check(eq(m.summaries, ['Define Plane Skeleton', 'Nodes', 'Node Connections']),
        `section order is Define Plane Skeleton -> Nodes -> Node Connections (got ${JSON.stringify(m.summaries)})`);
    check(m.openByDefault, 'sections start expanded');
    check(m.collapsedHeights.every((h, i) => h <= m.summaryHeights[i] + 2),
        `collapsing shrinks each section to its summary (got ${JSON.stringify(m.collapsedHeights)} vs summaries ${JSON.stringify(m.summaryHeights)})`);
    check(m.expandedHeights.every((h, i) => h > m.collapsedHeights[i]),
        `expanding restores each section (got ${JSON.stringify(m.expandedHeights)})`);

    // =================================================================
    // 3 — the editor builds a plane skeleton
    // =================================================================
    console.log('\n3. Plane skeleton editor');
    await page.fill('#planeSkeletonName', 'floor');
    await page.dispatchEvent('#planeSkeletonName', 'change');
    for (const n of ['fl', 'fr', 'br', 'bl']) {
        await page.fill('#planeNodeNameInput', n);
        await page.click('#btnAddPlaneNode');
    }
    // Connect the four corners into a quad.
    for (const [s, d] of [[0, 1], [1, 2], [2, 3], [3, 0]]) {
        await page.selectOption('#planeEdgeSrcSelect', String(s));
        await page.selectOption('#planeEdgeDstSelect', String(d));
        await page.click('#btnAddPlaneEdge');
    }
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const sk = P.getSelectedPlaneSkeleton();
        return {
            name: sk.name,
            nodes: sk.nodes.slice(),
            edges: sk.edges.map(e => e.slice()),
            nodeRows: document.querySelectorAll('#planeNodesTable tbody tr').length,
            edgeRows: document.querySelectorAll('#planeEdgesTable tbody tr').length,
            skelRows: document.querySelectorAll('#planeSkeletonsTable tbody tr').length,
            rowDraggable: document.querySelector('#planeSkeletonsTable tbody tr').draggable,
            // Column 0 is the expander, 1 is the name.
            rowName: document.querySelector('#planeSkeletonsTable tbody tr').children[1].textContent,
        };
    });
    check(m.name === 'floor', `name is editable (got "${m.name}")`);
    check(eq(m.nodes, ['fl', 'fr', 'br', 'bl']), `four nodes added (got ${JSON.stringify(m.nodes)})`);
    check(eq(m.edges, [[0, 1], [1, 2], [2, 3], [3, 0]]), `four connections added (got ${JSON.stringify(m.edges)})`);
    check(m.nodeRows === 4, `node table has 4 rows (got ${m.nodeRows})`);
    check(m.edgeRows === 4, `connection table has 4 rows (got ${m.edgeRows})`);
    check(m.skelRows === 1, `plane-skeleton table has 1 row (got ${m.skelRows})`);
    check(m.rowDraggable, 'plane-skeleton row is draggable');
    check(m.rowName === 'floor', `plane-skeleton row is named (got "${m.rowName}")`);

    // A second skeleton, to prove the table lists them all.
    await page.click('#btnNewPlaneSkeleton');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        return {
            count: P.planeState.skeletons.length,
            rows: document.querySelectorAll('#planeSkeletonsTable tbody tr').length,
            // The new (empty) skeleton must not be draggable — a drop would
            // produce an invisible placement.
            newRowDraggable: document.querySelectorAll('#planeSkeletonsTable tbody tr')[1].draggable,
        };
    });
    check(m.count === 2, `second skeleton created (got ${m.count})`);
    check(m.rows === 2, `table lists both (got ${m.rows})`);
    check(m.newRowDraggable === false, 'a node-less plane skeleton is not draggable');

    // Re-select the first one for the drop tests.
    await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        P.planeState.selectedSkeletonId = P.planeState.skeletons[0].id;
        P.refreshPlanePanel();
    });

    // =================================================================
    // 4 — drop onto a view
    // =================================================================
    console.log('\n4. Drag-and-drop placement');

    // 4a — a REAL browser drag, row -> video cell. This is the path that goes
    // through dockview's own drop handling on the dock container; the
    // programmatic call below cannot show that the drop is reachable at all.
    await page.dragAndDrop('#planeSkeletonsTable tbody tr',
        '.video-cell[data-view-name="camA"]');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const placed = P.getPlacements('camA');
        const out = {
            n: placed.length,
            // dockview must NOT have turned the drag into a new video panel.
            views: Array.from(document.querySelectorAll('.video-cell[data-view-name]'))
                .map(el => el.getAttribute('data-view-name')).sort(),
        };
        // Clear it again so the per-view assertions below start from zero.
        placed.forEach(p => P.removePlacement(p.id));
        P.refreshPlanePanel();
        return out;
    });
    check(m.n === 1, `a real drag onto camA places one plane (got ${m.n})`);
    check(eq(m.views, ['camA', 'camB']),
        `the drag did not spawn a bogus dockview panel (got ${JSON.stringify(m.views)})`);

    // 4b — a programmatic drop at a known point, for the seeding assertions.
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const AS = await import('/ui/app-state.js');
        const view = AS.state.views.find(v => v.name === 'camB');
        const rect = view.overlayCanvas.getBoundingClientRect();
        // Drop dead-centre of camB's canvas.
        const p = P.handlePlaneDrop(
            P.planeState.skeletons[0].id, 'camB',
            rect.left + rect.width / 2, rect.top + rect.height / 2);
        const pts = p && p.toPointsArray();
        return {
            placed: !!p,
            isPlaneInstance: !!p && p.constructor.name === 'PlaneInstance',
            type: p && p.type,
            viewName: p && p.viewName,
            nPoints: p && p.numNodes,
            allInFrame: pts && pts.every(q => q && q[0] >= 0 && q[0] <= 640 && q[1] >= 0 && q[1] <= 480),
            // Seeded around the drop point, so the centroid lands near centre.
            centroid: p && p.centroid().map(Math.round),
            // Distinct positions — a degenerate all-same-point seed would draw
            // as a dot and be useless to annotate from.
            distinct: pts && new Set(pts.map(q => q.join(','))).size,
            onCamA: P.getPlacements('camA').length,
            onCamB: P.getPlacements('camB').length,
            // Placements live in the skeleton row's expander, not a table.
            expanderCount: document.querySelector('#planeSkeletonsTable tbody tr .plane-placed-count').textContent,
            expanderEnabled: !document.querySelector('#planeSkeletonsTable tbody tr .plane-expander').disabled,
            headers: Array.from(document.querySelectorAll('#planeSkeletonsTable thead th'))
                .map(h => h.textContent.trim()),
            noPlacementsTable: !document.getElementById('planePlacementsTable'),
        };
    });
    check(m.placed, 'drop creates a placement');
    check(m.isPlaneInstance, `the placement is a PlaneInstance (got ${m.isPlaneInstance})`);
    check(m.type === 'plane', `its type is 'plane', not a pose type (got "${m.type}")`);
    check(m.viewName === 'camB', `placement lands on the dropped-on view (got "${m.viewName}")`);
    check(m.nPoints === 4, `placement has one point per node (got ${m.nPoints})`);
    check(m.allInFrame, 'every seeded point is inside the frame');
    check(m.distinct === 4, `seeded points are distinct (got ${m.distinct})`);
    check(Math.abs(m.centroid[0] - 320) <= 4 && Math.abs(m.centroid[1] - 240) <= 4,
        `seed is centred on the drop point (got ${JSON.stringify(m.centroid)})`);
    check(m.onCamA === 0, 'the other view gets nothing');
    check(m.onCamB === 1, 'the dropped-on view has exactly one placement');
    check(m.expanderCount === '1', `the row's expander shows the placement count (got "${m.expanderCount}")`);
    check(m.expanderEnabled, 'the expander is enabled once something is placed');
    check(eq(m.headers, ['', 'Name', 'Nodes', '']),
        `Links and Placed columns are gone (got ${JSON.stringify(m.headers)})`);
    check(m.noPlacementsTable, 'the standalone Placements table is gone');

    // 4c — re-dropping the same plane on the same view is REFUSED, and must
    // not disturb the existing placement's points.
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const AS = await import('/ui/app-state.js');
        const before = P.getPlacements('camB')[0].toPointsArray();
        const view = AS.state.views.find(v => v.name === 'camB');
        const rect = view.overlayCanvas.getBoundingClientRect();
        // Drop somewhere clearly different from the first drop.
        const p = P.handlePlaneDrop(P.planeState.skeletons[0].id, 'camB',
            rect.left + rect.width * 0.2, rect.top + rect.height * 0.2);
        return {
            refused: p === null,
            count: P.getPlacements('camB').length,
            unchanged: JSON.stringify(before) ===
                JSON.stringify(P.getPlacements('camB')[0].toPointsArray()),
            status: document.getElementById('statusText').textContent,
        };
    });
    check(m.refused, 'a second drop of the same plane on the same view is refused');
    check(m.count === 1, `still exactly one placement on that view (got ${m.count})`);
    check(m.unchanged, 'the existing placement keeps its points untouched');
    check(/already placed/i.test(m.status), `the refusal is reported (got "${m.status}")`);

    // =================================================================
    // 5 — drawn on the overlay
    // =================================================================
    console.log('\n5. Placement is drawn on the overlay');
    m = await page.evaluate(async () => {
        const R = await import('/ui/rendering.js');
        const AS = await import('/ui/app-state.js');
        function litPixels(name) {
            const v = AS.state.views.find(x => x.name === name);
            const d = v.overlayCtx.getImageData(0, 0, v.overlayCanvas.width, v.overlayCanvas.height).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
            return n;
        }
        R.drawAllOverlays(AS.state.currentFrame);
        const before = { camA: litPixels('camA'), camB: litPixels('camB') };
        // Frame-independent: a plane is static scene geometry.
        AS.state.currentFrame = 5;
        R.drawAllOverlays(5);
        const after = { camA: litPixels('camA'), camB: litPixels('camB') };
        return { before, after };
    });
    check(m.before.camB > 0, `camB overlay has plane pixels (got ${m.before.camB})`);
    check(m.before.camA === 0, `camA overlay stays blank (got ${m.before.camA})`);
    check(m.after.camB > 0, `plane survives a frame change (got ${m.after.camB})`);

    // =================================================================
    // 6 — drag payload must not collide with dockview's text/plain handler
    // =================================================================
    console.log('\n6. Drag payload does not collide with dockview');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const row = document.querySelector('#planeSkeletonsTable tbody tr');
        const types = {};
        const dt = { setData(type, val) { types[type] = val; }, effectAllowed: null };
        const ev = new Event('dragstart', { bubbles: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
        row.dispatchEvent(ev);
        return {
            keys: Object.keys(types),
            mime: P.PLANE_DRAG_MIME,
            payload: types[P.PLANE_DRAG_MIME],
            firstId: P.planeState.skeletons[0].id,
        };
    });
    check(!m.keys.includes('text/plain'),
        `dragstart sets no text/plain (would be eaten by dockview; got ${JSON.stringify(m.keys)})`);
    check(eq(m.keys, [m.mime]), `dragstart sets only ${m.mime}`);
    check(m.payload === String(m.firstId), `payload is the skeleton id (got "${m.payload}")`);

    // =================================================================
    // 7 — per-node colour, scoped to the skeleton
    // =================================================================
    console.log('\n7. Per-node colour');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const R = await import('/ui/rendering.js');
        const AS = await import('/ui/app-state.js');
        const rows = Array.from(document.querySelectorAll('#planeNodesTable tbody tr'));
        const pickers = rows.map(r => r.querySelector('input[type=color]'));
        const sk = P.planeState.skeletons[0];

        // Count pixels of an exact RGB on camB's overlay.
        function countColor(name, hex) {
            const v = AS.state.views.find(x => x.name === name);
            const d = v.overlayCtx.getImageData(0, 0, v.overlayCanvas.width, v.overlayCanvas.height).data;
            const r = parseInt(hex.slice(1, 3), 16),
                  g = parseInt(hex.slice(3, 5), 16),
                  b = parseInt(hex.slice(5, 7), 16);
            let n = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i] === r && d[i + 1] === g && d[i + 2] === b && d[i + 3] > 200) n++;
            }
            return n;
        }

        const out = {
            pickerCount: pickers.filter(Boolean).length,
            defaultsDistinct: new Set(sk.nodeColors).size,
            defaultFirst: pickers[0] ? pickers[0].value : null,
        };

        // Recolour node 0 to a colour nothing else uses, and confirm it lands
        // on the canvas.
        const TARGET = '#00ff00';
        R.drawAllOverlays(AS.state.currentFrame);
        out.beforeCount = countColor('camB', TARGET);
        pickers[0].value = TARGET;
        pickers[0].dispatchEvent(new Event('change', { bubbles: true }));
        out.modelColor = sk.getNodeColor(0);
        out.afterCount = countColor('camB', TARGET);

        // Scoped to the SKELETON: place the same plane on camA and it must be
        // the same colour there too.
        const view = AS.state.views.find(v => v.name === 'camA');
        const rect = view.overlayCanvas.getBoundingClientRect();
        P.handlePlaneDrop(sk.id, 'camA',
            rect.left + rect.width / 2, rect.top + rect.height / 2);
        R.drawAllOverlays(AS.state.currentFrame);
        out.camACount = countColor('camA', TARGET);

        // A node REMOVAL must take its colour with it, or every later node
        // silently inherits the wrong one.
        const colorsBefore = sk.nodeColors.slice();
        sk.removeNode(0);
        out.colorsShifted = JSON.stringify(sk.nodeColors) ===
            JSON.stringify(colorsBefore.slice(1));
        // Restore for the sections below.
        sk.addNode('fl', colorsBefore[0]);
        return out;
    });
    check(m.pickerCount === 4, `every node row has a colour picker (got ${m.pickerCount})`);
    check(m.defaultsDistinct === 4, `default node colours are distinct (got ${m.defaultsDistinct} unique)`);
    check(/^#[0-9a-f]{6}$/.test(m.defaultFirst || ''), `picker shows the node's colour (got "${m.defaultFirst}")`);
    check(m.modelColor === '#00ff00', `editing the picker updates the model (got "${m.modelColor}")`);
    check(m.beforeCount === 0 && m.afterCount > 0,
        `the new colour is drawn (${m.beforeCount} px -> ${m.afterCount} px)`);
    check(m.camACount > 0,
        `the colour is per-SKELETON, so it applies on another view too (got ${m.camACount} px)`);
    check(m.colorsShifted, 'removing a node removes its colour, keeping the rest aligned');

    // =================================================================
    // 8 — the placements dropdown on each plane row
    // =================================================================
    console.log('\n8. Placements dropdown');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const sk = P.planeState.skeletons[0];
        const table = document.getElementById('planeSkeletonsTable');
        const expander = () => table.querySelector('tbody tr .plane-expander');
        const items = () => Array.from(table.querySelectorAll('.plane-placement-item'));

        P.planeState.expanded.delete(sk.id);
        P.refreshPlanePanel();
        const out = { collapsedItems: items().length };

        expander().click();
        out.expandedItems = items().length;
        out.views = items().map(el => el.querySelector('.plane-placement-view').textContent).sort();
        out.caretOpen = table.querySelector('.plane-expander').classList.contains('open');

        // A second skeleton's dropdown must be independent.
        out.secondExpanderDisabled =
            table.querySelectorAll('tbody tr .plane-expander')[1].disabled;

        expander().click();
        out.recollapsedItems = items().length;
        expander().click(); // leave it open for the sections below
        return out;
    });
    check(m.collapsedItems === 0, `collapsed by default (got ${m.collapsedItems} items)`);
    check(m.expandedItems === 2, `expanding lists both placements (got ${m.expandedItems})`);
    check(eq(m.views, ['camA', 'camB']), `it names the views (got ${JSON.stringify(m.views)})`);
    check(m.caretOpen, 'the caret shows the open state');
    check(m.secondExpanderDisabled, 'an unplaced plane has a disabled expander');
    check(m.recollapsedItems === 0, 'clicking again collapses it');

    // =================================================================
    // 9 — shared Node Size / Edge Weight
    // =================================================================
    console.log('\n9. Shared appearance sliders');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const R = await import('/ui/rendering.js');
        const AS = await import('/ui/app-state.js');
        function lit(name) {
            const v = AS.state.views.find(x => x.name === name);
            const d = v.overlayCtx.getImageData(0, 0, v.overlayCanvas.width, v.overlayCanvas.height).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
            return n;
        }
        const size = document.getElementById('planeNodeSize');
        const weight = document.getElementById('planeEdgeWeight');
        const sizeVal = document.getElementById('planeNodeSizeVal');

        // Known corner positions, so the hit-radius probe below is exact.
        const sk0 = P.planeState.skeletons[0];
        P.getPlacementOn('camB', sk0.id).setPointsFrom(
            [[200, 200], [400, 200], [400, 350], [200, 350]]);

        R.drawAllOverlays(AS.state.currentFrame);
        const out = { small: lit('camB'), startSize: P.planeState.nodeSize };

        size.value = '16';
        size.dispatchEvent(new Event('input', { bubbles: true }));
        out.stateSize = P.planeState.nodeSize;
        out.readout = sizeVal.textContent;
        out.big = lit('camB');
        size.value = '5';
        size.dispatchEvent(new Event('input', { bubbles: true }));
        // The hit radius must follow the drawn size, or you can see a node you
        // cannot grab. Probe DIAGONALLY out from corner 0 — straight along a
        // side would sit on an edge, and an edge hit would mask the node
        // threshold entirely. Distance is picked to sit between the r=5 and
        // r=16 thresholds (`nodeSize + 3 + 2*displayToVideo`), so it must miss
        // at the small size and hit at the big one.
        const im = AS.interactionManager;
        const dtv = im._displayToVideo(AS.state, 'camB');
        const probe = 11 + 2 * dtv;
        const px = 200 - probe / Math.SQRT2, py = 200 - probe / Math.SQRT2;
        out.probeDist = probe;
        out.hitAtSmallSize = !!im.findNearestPlaneNode(px, py, 'camB');
        size.value = '16';
        size.dispatchEvent(new Event('input', { bubbles: true }));
        out.hitAtBigSize = !!im.findNearestPlaneNode(px, py, 'camB');
        size.value = '13';
        size.dispatchEvent(new Event('input', { bubbles: true }));

        weight.value = '10';
        weight.dispatchEvent(new Event('input', { bubbles: true }));
        out.stateWeight = P.planeState.edgeWidth;
        out.thick = lit('camB');
        weight.value = '3';
        weight.dispatchEvent(new Event('input', { bubbles: true }));

        // The 3D size is a THIRD, independent value: 3D only, and it must not
        // touch the 2D one (they are in unrelated units).
        const size3d = document.getElementById('planeNodeSize3d');
        out.start3d = P.planeState.nodeSize3d;
        out.markup3d = parseInt(size3d.value, 10);
        const before2d = P.planeState.nodeSize;
        size3d.value = '11';
        size3d.dispatchEvent(new Event('input', { bubbles: true }));
        out.state3d = P.planeState.nodeSize3d;
        out.readout3d = document.getElementById('planeNodeSize3dVal').textContent;
        out.twoDUntouched = P.planeState.nodeSize === before2d;
        out.pushedToViewport = AS.viewport3d && AS.viewport3d.planeNodeSize;
        size3d.value = '4';
        size3d.dispatchEvent(new Event('input', { bubbles: true }));

        // ONE shared value: it is not stored per skeleton.
        out.notPerSkeleton = P.planeState.skeletons.every(s => s.nodeSize === undefined);
        return out;
    });
    check(m.startSize === 13, `2D node size seeds from the markup default of 13 (got ${m.startSize})`);
    check(m.stateSize === 16, `the slider drives planeState.nodeSize (got ${m.stateSize})`);
    check(m.readout === '16', `the readout follows (got "${m.readout}")`);
    check(m.big > m.small, `a bigger node size draws more (${m.small} -> ${m.big} px)`);
    check(m.hitAtBigSize && !m.hitAtSmallSize,
        `the hit radius follows the drawn size — ${m.probeDist.toFixed(1)} px out ` +
        `misses at r=5 and hits at r=16 (small=${m.hitAtSmallSize}, big=${m.hitAtBigSize})`);
    check(m.stateWeight === 10, `the edge slider drives planeState.edgeWidth (got ${m.stateWeight})`);
    check(m.thick > m.small, `a heavier edge weight draws more (${m.small} -> ${m.thick} px)`);
    check(m.notPerSkeleton, 'the values are shared, not stored per skeleton');
    check(m.start3d === 4 && m.markup3d === 4,
        `3D node size seeds from its own markup default (got ${m.start3d})`);
    check(m.state3d === 11 && m.readout3d === '11',
        `the 3D slider drives planeState.nodeSize3d (got ${m.state3d}/"${m.readout3d}")`);
    check(m.twoDUntouched, 'moving the 3D size leaves the 2D size alone');
    check(m.pushedToViewport === 11,
        `it reaches the viewport as planeNodeSize (got ${m.pushedToViewport})`);

    // =================================================================
    // 10 — triangulate across the views the plane is placed on
    // =================================================================
    console.log('\n10. Triangulate');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sk = P.planeState.skeletons[0];
        const cams = AS.state.session.cameras;

        // Put the two placements on the exact reprojections of a known 3D
        // quad, so a correct solve must recover it to sub-pixel accuracy.
        const TRUTH = [[-40, -30, 220], [40, -30, 225], [45, 25, 230], [-45, 25, 215]];
        ['camA', 'camB'].forEach(name => {
            const cam = cams.find(c => c.name === name);
            const p = P.getPlacementOn(name, sk.id);
            // `project` is the ideal (undistorted) projection; these cameras
            // have zero distortion, so it matches what the app would render.
            p.setPointsFrom(TRUTH.map(q => cam.project(q)));
            p.nulledNodes.clear();
        });

        const out = {};
        // The button is the real entry point.
        const triBtn = document.getElementById('btnPlaneTriangulate');
        out.btnEnabled = !triBtn.disabled;
        triBtn.click();

        out.hasPoints3d = !!sk.points3d;
        out.tri = sk.triangulation && {
            views: sk.triangulation.views.slice(),
            nNodes: sk.triangulation.nNodes,
            meanError: sk.triangulation.meanError,
        };
        out.recovered = TRUTH.map((_, k) =>
            pd.hasPoint3d(sk.points3d, k) ? Array.from(pd.getPoint3d(sk.points3d, k)) : null);
        out.truth = TRUTH;
        out.status = document.getElementById('statusText').textContent;
        // Result is surfaced, not silent.
        out.autoExpanded = P.planeState.expanded.has(sk.id);
        out.summaryShown = !!document.querySelector('.plane-tri-summary');
        out.nodeLines = document.querySelectorAll('.plane-tri-node').length;

        // A node toggled OFF in one view leaves only one observation, so that
        // node must drop out of the solve rather than be silently invented.
        P.getPlacementOn('camA', sk.id).toggleNodeNull(0);
        triBtn.click();
        out.afterNullNodes = sk.triangulation.nNodes;
        out.node0Gone = !pd.hasPoint3d(sk.points3d, 0);
        P.getPlacementOn('camA', sk.id).toggleNodeNull(0);

        // Editing the 2D must invalidate a stale 3D solve.
        triBtn.click();
        const before = !!sk.points3d;
        P.getPlacementOn('camB', sk.id).setPoint(2, 10, 10);
        AS.interactionManager.callbacks.onPlaneChanged(P.getPlacementOn('camB', sk.id));
        out.invalidated = before && !sk.points3d;
        return out;
    });
    check(m.btnEnabled, 'the triangulate button is enabled with 2 views placed');
    check(m.hasPoints3d, 'triangulating produces points3d');
    check(m.tri && eq(m.tri.views, ['camA', 'camB']),
        `it records the contributing views (got ${JSON.stringify(m.tri && m.tri.views)})`);
    check(m.tri && m.tri.nNodes === 4, `all four corners solve (got ${m.tri && m.tri.nNodes})`);
    {
        const worst = m.recovered.reduce((acc, got, k) => {
            if (!got) return Infinity;
            const t = m.truth[k];
            return Math.max(acc, Math.hypot(got[0] - t[0], got[1] - t[1], got[2] - t[2]));
        }, 0);
        check(worst < 0.01, `the recovered 3D matches the known truth (worst node off by ${worst.toExponential(2)})`);
    }
    check(m.tri && m.tri.meanError < 0.01,
        `reprojection error is ~0 for exact input (got ${m.tri && m.tri.meanError})`);
    check(/Triangulated/.test(m.status), `it reports to the status bar (got "${m.status}")`);
    check(m.autoExpanded && m.summaryShown, 'the result is surfaced in the row, not silent');
    check(m.nodeLines === 4, `per-node 3D is listed (got ${m.nodeLines} lines)`);
    check(m.afterNullNodes === 3 && m.node0Gone,
        `a node toggled off in one view drops out of the solve (got ${m.afterNullNodes} nodes)`);
    check(m.invalidated, 'editing the 2D clears the now-stale 3D solve');

    // =================================================================
    // 10b — the action buttons live below the table and follow the selection
    // =================================================================
    console.log('\n10b. Shared action row');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const ids = ['btnPlaneTriangulate', 'btnPlaneFill', 'btnPlaneFit'];
        const btns = () => ids.map(i => document.getElementById(i));
        const out = {
            allExist: btns().every(Boolean),
            // They must be OUT of the table now.
            noneInTable: btns().every(b => !b.closest('#planeSkeletonsTable')),
            // …and below it in document order.
            belowTable: btns().every(b =>
                document.getElementById('planeSkeletonsTable')
                    .compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING),
            labels: btns().map(b => b.textContent.trim()),
        };
        // Selected -> enabled.
        P.planeState.selectedSkeletonId = P.planeState.skeletons[0].id;
        P.refreshPlanePanel();
        out.enabledWhenSelected = btns().every(b => !b.disabled);
        // No selection -> greyed out.
        P.planeState.selectedSkeletonId = null;
        P.refreshPlanePanel();
        out.disabledWhenNone = btns().every(b => b.disabled);
        out.titleWhenNone = document.getElementById('btnPlaneFit').title;
        P.planeState.selectedSkeletonId = P.planeState.skeletons[0].id;
        P.refreshPlanePanel();
        return out;
    });
    check(m.allExist, 'Triangulate / Fill / Fit all exist');
    check(m.noneInTable, 'they are no longer per-row buttons inside the table');
    check(m.belowTable, 'they sit below the Plane Skeletons table');
    check(eq(m.labels, ['Triangulate', 'Fill', 'Fit']),
        `labelled Triangulate / Fill / Fit (got ${JSON.stringify(m.labels)})`);
    check(m.enabledWhenSelected, 'all three are enabled when a plane skeleton is selected');
    check(m.disabledWhenNone, 'all three are greyed out when none is selected');
    check(/Select a plane skeleton/.test(m.titleWhenNone),
        `the disabled state explains itself (got "${m.titleWhenNone}")`);

    // =================================================================
    // 10c — Triangulate shows the plane in the 3D viewer
    // =================================================================
    console.log('\n10c. Plane appears in the 3D viewer');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const AS = await import('/ui/app-state.js');
        const sk = P.planeState.skeletons[0];
        const cams = AS.state.session.cameras;
        // Section 7's node removal dropped the two edges that touched node 0.
        // Restore the full ring so this and the sections below work on a real
        // closed quad rather than an open chain.
        sk.edges = [[0, 1], [1, 2], [2, 3], [3, 0]];
        const TRUTH = [[-40, -30, 220], [40, -30, 225], [45, 25, 230], [-45, 25, 215]];
        ['camA', 'camB'].forEach(name => {
            const cam = cams.find(c => c.name === name);
            const p = P.getPlacementOn(name, sk.id);
            p.setPointsFrom(TRUTH.map(q => cam.project(q)));
            p.nulledNodes.clear();
        });

        const vp = AS.viewport3d;
        const out = { hasViewport: !!vp, hasApi: !!(vp && vp.setPlanes) };
        if (!vp) return out;

        // The plane group must be a SIBLING of the skeleton group, or the
        // per-frame updateSkeleton clear would wipe it.
        out.groupNames = vp.scene.children.filter(c => c.type === 'Group').map(c => c.name);
        out.planeGroupEmptyBefore = vp._planeGroup.children.length === 0;

        document.getElementById('btnPlaneTriangulate').click();
        out.planeGroupAfter = vp._planeGroup.children.length;
        const g = vp._planeGroup.children[0];
        out.groupName = g && g.name;
        out.nodeMeshes = g ? g.children.filter(c => c.name.startsWith('planeNode_')).length : 0;
        out.edgeMeshes = g ? g.children.filter(c => c.name.startsWith('planeEdge_')).length : 0;
        out.wantNodes = sk.nodes.length;
        out.wantEdges = sk.edges.length;
        // Positions must be the raw world coords — no transform on the way in.
        const n0 = g && g.children.find(c => c.name === 'planeNode_0');
        out.node0Pos = n0 ? [n0.position.x, n0.position.y, n0.position.z] : null;
        out.truth0 = TRUTH[0];

        // Fill must reach 3D too.
        out.fillBefore = g ? g.children.filter(c => c.name === 'planeFill').length : 0;
        sk.filled = true;
        P.syncPlanes3D();
        out.fillAfter = vp._planeGroup.children[0].children
            .filter(c => c.name === 'planeFill').length;
        sk.filled = false;
        P.syncPlanes3D();

        // A frame change must NOT wipe it — that is why it is a sibling group.
        vp.setFrame([]);
        out.survivesFrame = vp._planeGroup.children.length;

        // "Fit 3D to Scene" must FRAME the plane. Without plane nodes in
        // fitToScene's point set the view stays on the cameras (near the
        // origin) and the plane — the whole reason for the mode — is off
        // screen. The plane sits at z~220 while the cameras sit at z~0.
        vp.fitToScene();
        out.orbitTarget = [vp.controls.target.x, vp.controls.target.y, vp.controls.target.z];

        // Invalidating the 3D drops it from the scene.
        sk.clearTriangulation();
        P.syncPlanes3D();
        out.afterInvalidate = vp._planeGroup.children.length;
        return out;
    });
    check(m.hasViewport && m.hasApi, 'the 3D viewport exposes setPlanes');
    check(m.groupNames && m.groupNames.includes('planes'),
        `a dedicated 'planes' group exists (got ${JSON.stringify(m.groupNames)})`);
    check(m.planeGroupEmptyBefore, 'it starts empty');
    check(m.planeGroupAfter === 1, `Triangulate puts the plane in the scene (got ${m.planeGroupAfter})`);
    check(m.nodeMeshes === m.wantNodes && m.edgeMeshes === m.wantEdges,
        `with a mesh per node and per edge (got ${m.nodeMeshes}/${m.edgeMeshes}, want ${m.wantNodes}/${m.wantEdges})`);
    check(m.node0Pos && m.node0Pos.every((v, i) => Math.abs(v - m.truth0[i]) < 0.01),
        `3D positions are the world coords with no transform (got ${JSON.stringify(m.node0Pos && m.node0Pos.map(v => +v.toFixed(2)))} vs ${JSON.stringify(m.truth0)})`);
    check(m.fillBefore === 0 && m.fillAfter === 1, 'the Fill toggle adds a fill mesh in 3D too');
    check(m.survivesFrame === 1, 'a frame change does not wipe the plane from the scene');
    check(m.orbitTarget && m.orbitTarget[2] > 50,
        `"Fit 3D to Scene" frames the plane, not just the cameras (orbit target z=${m.orbitTarget && m.orbitTarget[2].toFixed(1)}, plane is at z~222)`);
    check(m.afterInvalidate === 0, 'invalidating the 3D removes it from the scene');

    // =================================================================
    // 10d — Fit: plane of best fit, applied to 3D and back to every 2D view
    // =================================================================
    console.log('\n10d. Fit plane of best fit');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const T = await import('/pose/triangulation.js');
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sk = P.planeState.skeletons[0];
        const cams = AS.state.session.cameras;

        // A deliberately NON-planar quad: three corners on z=220, one pushed
        // 6 mm off. Fit must flatten it.
        const RAW = [[-40, -30, 220], [40, -30, 220], [45, 25, 220], [-45, 25, 226]];
        ['camA', 'camB'].forEach(name => {
            const cam = cams.find(c => c.name === name);
            const p = P.getPlacementOn(name, sk.id);
            p.setPointsFrom(RAW.map(q => cam.project(q)));
            p.nulledNodes.clear();
        });
        document.getElementById('btnPlaneTriangulate').click();

        const before2d = P.getPlacementOn('camA', sk.id).toPointsArray();
        const beforeFit = T.fitPlaneToPoints3d(sk.points3d);
        const out = { rmsBefore: beforeFit.rms };

        document.getElementById('btnPlaneFit').click();

        out.hasFit = !!sk.planeFit;
        out.fitNormal = sk.planeFit && sk.planeFit.normal.slice();
        out.fitRms = sk.planeFit && sk.planeFit.rms;

        // Every corner must now lie ON the fitted plane.
        let worst = 0;
        for (let k = 0; k < 4; k++) {
            const q = pd.getPoint3d(sk.points3d, k);
            const c = sk.planeFit.centroid, nv = sk.planeFit.normal;
            worst = Math.max(worst, Math.abs(
                (q[0] - c[0]) * nv[0] + (q[1] - c[1]) * nv[1] + (q[2] - c[2]) * nv[2]));
        }
        out.worstResidual = worst;
        // …and a re-fit of the flattened points has ~zero RMS.
        out.rmsAfter = T.fitPlaneToPoints3d(sk.points3d).rms;

        // The 2D must have MOVED to match, in every placed view.
        const after2d = P.getPlacementOn('camA', sk.id).toPointsArray();
        out.moved2dA = Math.max(...after2d.map((q, k) =>
            Math.hypot(q[0] - before2d[k][0], q[1] - before2d[k][1])));
        // And the 2D must be the exact reprojection of the corrected 3D.
        let worst2d = 0;
        ['camA', 'camB'].forEach(name => {
            const cam = cams.find(c => c.name === name);
            const p = P.getPlacementOn(name, sk.id);
            for (let k = 0; k < 4; k++) {
                const uv = T.reprojectPointCamera(pd.getPoint3d(sk.points3d, k), cam);
                worst2d = Math.max(worst2d, Math.hypot(uv[0] - p.getX(k), uv[1] - p.getY(k)));
            }
        });
        out.worst2dMismatch = worst2d;

        // The 3D viewer must have been updated, not left showing the old cloud.
        const vp = AS.viewport3d;
        const g = vp._planeGroup.children[0];
        const n3 = g && g.children.find(c => c.name === 'planeNode_3');
        const q3 = pd.getPoint3d(sk.points3d, 3);
        out.viewerMatches = !!n3 && Math.hypot(
            n3.position.x - q3[0], n3.position.y - q3[1], n3.position.z - q3[2]) < 1e-6;

        out.status = document.getElementById('statusText').textContent;

        // Degenerate guards: collinear and too-few points must REFUSE, not
        // return an arbitrary normal.
        const collinear = pd.makePoints3d(3);
        [[0, 0, 0], [1, 1, 1], [2, 2, 2]].forEach((q, k) => pd.setPoint3d(collinear, k, q));
        out.collinearRefused = T.fitPlaneToPoints3d(collinear) === null;
        const two = pd.makePoints3d(2);
        [[0, 0, 0], [1, 0, 0]].forEach((q, k) => pd.setPoint3d(two, k, q));
        out.twoPointsRefused = T.fitPlaneToPoints3d(two) === null;
        return out;
    });
    check(m.rmsBefore > 1, `precondition: the raw quad is non-planar (${m.rmsBefore.toFixed(2)} mm RMS)`);
    check(m.hasFit, 'Fit stores the fitted plane');
    check(m.fitNormal && Math.abs(Math.hypot(...m.fitNormal) - 1) < 1e-9,
        `the normal is unit length (got ${JSON.stringify(m.fitNormal && m.fitNormal.map(v => +v.toFixed(4)))})`);
    check(m.worstResidual < 1e-9,
        `every corner is flattened onto the fitted plane (worst residual ${m.worstResidual.toExponential(2)})`);
    check(m.rmsAfter < 1e-9, `a re-fit of the result has ~zero RMS (${m.rmsAfter.toExponential(2)})`);
    check(m.moved2dA > 0.5, `the 2D annotation moved to match (max ${m.moved2dA.toFixed(2)} px)`);
    check(m.worst2dMismatch < 1e-6,
        `the 2D is the exact reprojection of the corrected 3D in every view (worst ${m.worst2dMismatch.toExponential(2)} px)`);
    check(m.viewerMatches, 'the 3D viewer shows the corrected points, not the old cloud');
    check(/Fitted plane/.test(m.status), `it reports to the status bar (got "${m.status}")`);
    check(m.collinearRefused, 'collinear points are refused (their normal is arbitrary)');
    check(m.twoPointsRefused, 'fewer than 3 points are refused');

    // =================================================================
    // 10e — dragging a FITTED plane's corners in the 3D viewport
    // =================================================================
    console.log('\n10e. 3D corner dragging (fitted planes only, in-plane only)');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const T = await import('/pose/triangulation.js');
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sk = P.planeState.skeletons[0];
        const vp = AS.viewport3d;
        const dom = vp.renderer.domElement;
        const out = { hasFit: !!sk.planeFit };

        // Frame the plane and let a render land, so the matrices `project()`
        // and the raycaster read are the same ones on screen.
        vp.fitToScene();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const rect = dom.getBoundingClientRect();
        out.canvasSized = rect.width > 10 && rect.height > 10;

        const nodeMeshes = () => vp._planeGroup.children[0].children
            .filter(c => c.name.startsWith('planeNode_'));
        out.editableFlagged = nodeMeshes().every(c => c.userData.planeEditable === true);
        out.idsTagged = nodeMeshes().every(c => c.userData.planeId === sk.id);

        // Where a corner lands on the canvas, in client coords.
        const screenOf = (k) => {
            const p = pd.getPoint3d(sk.points3d, k);
            const v = new THREE.Vector3(p[0], p[1], p[2]).project(vp.threeCamera);
            const r = dom.getBoundingClientRect();
            return {
                x: r.left + (v.x + 1) / 2 * r.width,
                y: r.top + (1 - v.y) / 2 * r.height,
                onScreen: Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1,
            };
        };
        const fire = (type, x, y) => dom.dispatchEvent(new PointerEvent(type, {
            clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
            bubbles: true, cancelable: true, pointerId: 1,
        }));

        const K = 2;
        const start = screenOf(K);
        out.nodeOnScreen = start.onScreen;
        const before3d = Array.from(pd.getPoint3d(sk.points3d, K));
        const otherBefore = Array.from(pd.getPoint3d(sk.points3d, 0));
        const before2dA = P.getPlacementOn('camA', sk.id).toPointsArray()[K].slice();
        const fitBefore = {
            centroid: sk.planeFit.centroid.slice(),
            normal: sk.planeFit.normal.slice(),
        };

        // --- the drag: press on the corner, move, release ---
        fire('pointerdown', start.x, start.y);
        out.grabbed = !!vp._planeDrag;
        out.grabbedNode = vp._planeDrag && vp._planeDrag.nodeIdx;
        // The orbit must not run under the drag, or the scene would spin.
        out.controlsOffDuringDrag = vp.controls.enabled === false;

        fire('pointermove', start.x + 70, start.y + 45);
        const mid3d = Array.from(pd.getPoint3d(sk.points3d, K));
        out.movedDuringDrag = Math.hypot(
            mid3d[0] - before3d[0], mid3d[1] - before3d[1], mid3d[2] - before3d[2]);

        fire('pointerup', start.x + 70, start.y + 45);
        out.released = vp._planeDrag === null;
        out.controlsBackOn = vp.controls.enabled === true;

        const after3d = Array.from(pd.getPoint3d(sk.points3d, K));
        out.moved3d = Math.hypot(
            after3d[0] - before3d[0], after3d[1] - before3d[1], after3d[2] - before3d[2]);

        // RULE 2: the corner may only travel IN the plane it was fitted to.
        const c = sk.planeFit.centroid, nv = sk.planeFit.normal;
        out.offPlane = Math.abs(
            (after3d[0] - c[0]) * nv[0] + (after3d[1] - c[1]) * nv[1] + (after3d[2] - c[2]) * nv[2]);
        // …and the plane itself must NOT have moved. Centroid + normal are the
        // origin definition; a corner nudge must not drag the frame with it.
        out.fitUnchanged = fitBefore.centroid.every((v, i) => v === sk.planeFit.centroid[i])
            && fitBefore.normal.every((v, i) => v === sk.planeFit.normal[i]);
        // Only the grabbed corner moves.
        const otherAfter = Array.from(pd.getPoint3d(sk.points3d, 0));
        out.otherNodeStill = otherBefore.every((v, i) => v === otherAfter[i]);

        // The 2D in every placed view follows the 3D, exactly.
        const after2dA = P.getPlacementOn('camA', sk.id).toPointsArray()[K];
        out.moved2d = Math.hypot(after2dA[0] - before2dA[0], after2dA[1] - before2dA[1]);
        let worst2d = 0;
        ['camA', 'camB'].forEach(name => {
            const cam = AS.state.session.cameras.find(x => x.name === name);
            const p = P.getPlacementOn(name, sk.id);
            const uv = T.reprojectPointCamera(pd.getPoint3d(sk.points3d, K), cam);
            worst2d = Math.max(worst2d, Math.hypot(uv[0] - p.getX(K), uv[1] - p.getY(K)));
        });
        out.worst2dMismatch = worst2d;

        // The mesh in the scene tracks it too (the drag goes through the model,
        // not by nudging the mesh behind the model's back).
        const n2 = vp._planeGroup.children[0].children.find(c2 => c2.name === 'planeNode_' + K);
        out.meshMatches = !!n2 && Math.hypot(
            n2.position.x - after3d[0], n2.position.y - after3d[1], n2.position.z - after3d[2]) < 1e-9;

        // Releasing over the scene must not be read as a camera click.
        const camBefore = vp.selectedCamera;
        dom.dispatchEvent(new MouseEvent('click', {
            clientX: start.x + 70, clientY: start.y + 45, bubbles: true,
        }));
        out.noCameraSelected = vp.selectedCamera === camBefore;

        // --- RULE 1: an un-fit plane is inert ---
        const fitSaved = sk.planeFit;
        sk.planeFit = null;
        P.syncPlanes3D();
        out.unfitNotEditable = nodeMeshes().every(c2 => c2.userData.planeEditable !== true);
        const s2 = screenOf(K);
        const beforeUnfit = Array.from(pd.getPoint3d(sk.points3d, K));
        fire('pointerdown', s2.x, s2.y);
        out.unfitNotGrabbed = !vp._planeDrag;
        fire('pointermove', s2.x + 70, s2.y + 45);
        fire('pointerup', s2.x + 70, s2.y + 45);
        out.unfitUnmoved = beforeUnfit.every((v, i) => v === pd.getPoint3d(sk.points3d, K)[i]);

        // --- and so is a fitted plane outside Defining Plane Mode ---
        sk.planeFit = fitSaved;
        P.exitPlaneMode();
        out.outsideModeNotEditable = nodeMeshes().every(c2 => c2.userData.planeEditable !== true);
        P.enterPlaneMode();
        P.planeState.selectedSkeletonId = sk.id;
        P.refreshPlanePanel();
        out.backInModeEditable = nodeMeshes().every(c2 => c2.userData.planeEditable === true);
        return out;
    });
    check(m.hasFit && m.canvasSized, 'precondition: a fitted plane on a laid-out 3D canvas');
    check(m.editableFlagged, 'a fitted plane\'s corner meshes are marked draggable');
    check(m.idsTagged, 'each corner mesh carries its plane id and node index');
    check(m.nodeOnScreen, 'the corner under test is on screen');
    check(m.grabbed && m.grabbedNode === 2, `pressing a corner grabs it (got node ${m.grabbedNode})`);
    check(m.controlsOffDuringDrag, 'the orbit controls are disabled for the duration of the drag');
    check(m.movedDuringDrag > 1, `the corner moves during the drag, not only on release (${m.movedDuringDrag.toFixed(1)} mm)`);
    check(m.released && m.controlsBackOn, 'releasing ends the drag and restores the orbit controls');
    check(m.moved3d > 1, `the dragged corner moved in 3D (${m.moved3d.toFixed(1)} mm)`);
    check(m.offPlane < 1e-9,
        `it stayed ON the fitted plane (off by ${m.offPlane.toExponential(2)} mm)`);
    check(m.fitUnchanged, 'the fitted plane itself is unchanged — a corner nudge does not move the frame');
    check(m.otherNodeStill, 'the other corners are untouched');
    check(m.moved2d > 1, `the 2D annotation followed in the placed views (${m.moved2d.toFixed(1)} px)`);
    check(m.worst2dMismatch < 1e-6,
        `2D is the exact reprojection of the dragged 3D in every view (worst ${m.worst2dMismatch.toExponential(2)} px)`);
    check(m.meshMatches, 'the 3D scene shows the corner at its new position');
    check(m.noCameraSelected, 'a drag released over the scene is not read as a camera click');
    check(m.unfitNotEditable && m.unfitNotGrabbed && m.unfitUnmoved,
        'a plane that has NOT been fit cannot be dragged in 3D');
    check(m.outsideModeNotEditable, 'a fitted plane is inert outside Defining Plane Mode');
    check(m.backInModeEditable, 're-entering the mode makes it draggable again');

    // =================================================================
    // 11 — fill the polygon
    // =================================================================
    console.log('\n11. Polygon fill');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const R = await import('/ui/rendering.js');
        const AS = await import('/ui/app-state.js');
        const sk = P.planeState.skeletons[0];
        // A convex quad whose INTERIOR we can sample.
        P.getPlacementOn('camB', sk.id).setPointsFrom(
            [[200, 200], [400, 200], [400, 350], [200, 350]]);

        // Sample well inside the quad but clear of every other mark: the
        // centroid (300,275) carries the plane-name label, the corners carry
        // node discs and their labels, and the edges are on the boundary.
        function interiorPixel() {
            const v = AS.state.views.find(x => x.name === 'camB');
            const t = (255 / v.videoWidth) * v.overlayCanvas.width;
            const u = (315 / v.videoHeight) * v.overlayCanvas.height;
            const d = v.overlayCtx.getImageData(Math.round(t), Math.round(u), 1, 1).data;
            return { a: d[3], rgb: [d[0], d[1], d[2]] };
        }

        const out = {};
        const fillBtn = () => document.getElementById('btnPlaneFill');
        R.drawAllOverlays(AS.state.currentFrame);
        out.beforeAlpha = interiorPixel().a;
        out.beforeActive = fillBtn().classList.contains('active');

        fillBtn().click();
        out.filled = sk.filled;
        out.afterAlpha = interiorPixel().a;
        out.afterActive = fillBtn().classList.contains('active');
        out.afterRgb = interiorPixel().rgb;
        out.planeColor = sk.color;

        fillBtn().click();   // toggles back off
        out.unfilled = sk.filled;
        out.unfilledAlpha = interiorPixel().a;

        // Polygon order follows the CONNECTIONS, not node index order — a quad
        // linked 0-2-1-3 is a bowtie if you fill it in index order.
        const bow = P.planeState.skeletons[0];
        const savedEdges = bow.edges.map(e => e.slice());
        bow.edges = [[0, 2], [2, 1], [1, 3], [3, 0]];
        out.cycleOrder = P.planePolygonOrder(bow);
        bow.edges = [[0, 1], [1, 2]];              // open chain — no cycle
        out.chainOrder = P.planePolygonOrder(bow);
        bow.edges = savedEdges;
        out.quadOrder = P.planePolygonOrder(bow);
        return out;
    });
    check(m.beforeAlpha === 0, `the polygon interior starts empty (alpha ${m.beforeAlpha})`);
    check(!m.beforeActive, 'the fill button starts inactive');
    check(m.filled && m.afterAlpha > 0,
        `clicking the mesh button fills the polygon (alpha ${m.beforeAlpha} -> ${m.afterAlpha})`);
    check(m.afterActive, 'the fill button shows the active state');
    {
        const c = m.planeColor;
        const want = [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
        // Semi-transparent over a transparent canvas, so the hue survives but
        // not the exact bytes — check it is the plane's colour family.
        const near = m.afterRgb.every((v, i) => Math.abs(v - want[i]) <= 12);
        check(near, `the fill uses the plane colour (got rgb(${m.afterRgb}) vs ${c})`);
    }
    check(!m.unfilled && m.unfilledAlpha === 0, 'clicking again un-fills it');
    check(eq(m.cycleOrder, [0, 2, 1, 3]),
        `polygon order follows the connection cycle (got ${JSON.stringify(m.cycleOrder)})`);
    check(eq(m.chainOrder, [0, 1, 2, 3]),
        `an open chain falls back to index order (got ${JSON.stringify(m.chainOrder)})`);
    check(eq(m.quadOrder, [0, 1, 2, 3]),
        `the natural quad round-trips (got ${JSON.stringify(m.quadOrder)})`);

    // =================================================================
    // 12 — PlaneInstance behaves like a UserInstance under the mouse
    // =================================================================
    console.log('\n12. Mouse interaction');

    // Work on camB's placement. Put its nodes at known positions first.
    await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const R = await import('/ui/rendering.js');
        const AS = await import('/ui/app-state.js');
        // Drop camA's placement so only camB is in play.
        P.getPlacements('camA').forEach(p => P.removePlacement(p.id));
        const p = P.getPlacements('camB')[0];
        p.setPointsFrom([[200, 200], [400, 200], [400, 350], [200, 350]]);
        p.nulledNodes.clear();
        P.planeState.expanded.add(p.skeletonId);
        if (AS.interactionManager) AS.interactionManager.selectPlane(null, -1);
        P.refreshPlanePanel();
        R.drawAllOverlays(AS.state.currentFrame);
    });

    // 8a — click a node: selects the plane.
    let pt = await toClient('camB', 200, 200);
    await page.mouse.move(pt[0], pt[1]);
    await page.mouse.down();
    await page.mouse.up();
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const AS = await import('/ui/app-state.js');
        const im = AS.interactionManager;
        return {
            selected: !!im.selectedPlane,
            selectedIsCamB: !!im.selectedPlane && im.selectedPlane.viewName === 'camB',
            rowHighlighted: !!document.querySelector('.plane-placement-item.plane-selected'),
            status: document.getElementById('statusSelection').textContent,
            unmoved: eq2(P.getPlacements('camB')[0].getPoint(0), [200, 200]),
        };
        function eq2(a, b) { return a && Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5; }
    });
    check(m.selected && m.selectedIsCamB, 'clicking a plane node selects that plane');
    check(m.rowHighlighted, 'the Placements row highlights the selection');
    check(/plane floor/.test(m.status), `status bar names the selected plane (got "${m.status}")`);
    check(m.unmoved, 'a click without movement does not move the node');

    // 8b — drag a node.
    const from = await toClient('camB', 200, 200);
    const to = await toClient('camB', 260, 240);
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    await page.mouse.move(to[0], to[1], { steps: 8 });
    await page.mouse.up();
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const p = P.getPlacements('camB')[0];
        return { pts: p.toPointsArray().map(q => q.map(Math.round)), modified: p.modified };
    });
    check(Math.abs(m.pts[0][0] - 260) <= 2 && Math.abs(m.pts[0][1] - 240) <= 2,
        `dragging a node moves it (node 0 now ${JSON.stringify(m.pts[0])}, want ~[260,240])`);
    check(eq(m.pts[1], [400, 200]) && eq(m.pts[3], [200, 350]),
        `the other nodes stay put (got ${JSON.stringify(m.pts)})`);
    check(m.modified, 'the drag marks the instance modified');

    // 8c — Alt+drag translates the WHOLE plane.
    const aFrom = await toClient('camB', 400, 200);
    const aTo = await toClient('camB', 420, 230);
    await page.keyboard.down('Alt');
    await page.mouse.move(aFrom[0], aFrom[1]);
    await page.mouse.down();
    await page.mouse.move(aTo[0], aTo[1], { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        return { pts: P.getPlacements('camB')[0].toPointsArray().map(q => q.map(Math.round)) };
    });
    // Every node should have shifted by the same (+20, +30).
    const shifted = [[280, 270], [420, 230], [420, 380], [220, 380]];
    check(m.pts.every((q, i) => Math.abs(q[0] - shifted[i][0]) <= 3 && Math.abs(q[1] - shifted[i][1]) <= 3),
        `Alt+drag translates every node by the same delta (got ${JSON.stringify(m.pts)}, want ~${JSON.stringify(shifted)})`);

    // 8d — right-click toggles a node off (and back on).
    const rc = await toClient('camB', 420, 230);
    await page.mouse.click(rc[0], rc[1], { button: 'right' });
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const p = P.getPlacements('camB')[0];
        return { nulled: p.isNodeNulled(1), usable: p.hasAnyUsablePoint(), n: p.nulledNodes.size };
    });
    check(m.nulled, 'right-click toggles a plane node off');
    check(m.n === 1, `only that one node is off (got ${m.n})`);
    check(m.usable, 'the plane still has usable points for a later solve');
    await page.mouse.click(rc[0], rc[1], { button: 'right' });
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        return { nulled: P.getPlacements('camB')[0].isNodeNulled(1) };
    });
    check(!m.nulled, 'right-clicking again toggles it back on');

    // 8e — THE MODE GATE. Outside Defining Plane Mode the identical drag must
    // do nothing, so plane nodes never compete with pose nodes for a click.
    // Baseline is read from the live placement rather than hardcoded: the
    // drags above land within the deadzone tolerance, not on exact integers.
    const gateBefore = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        return P.getPlacements('camB')[0].getPoint(1);
    });
    await page.click('#planeModeExit');
    const gFrom = await toClient('camB', gateBefore[0], gateBefore[1]);
    const gTo = await toClient('camB', 500, 300);
    await page.mouse.move(gFrom[0], gFrom[1]);
    await page.mouse.down();
    await page.mouse.move(gTo[0], gTo[1], { steps: 8 });
    await page.mouse.up();
    m = await page.evaluate(async (gb) => {
        const P = await import('/ui/plane-definition.js');
        const AS = await import('/ui/app-state.js');
        const im = AS.interactionManager;
        return {
            pt1: P.getPlacements('camB')[0].getPoint(1),
            selected: !!im.selectedPlane,
            hitTestNull: im.findNearestPlaneNode(gb[0], gb[1], 'camB') === null,
        };
    }, gateBefore);
    check(Math.abs(m.pt1[0] - gateBefore[0]) < 0.5 && Math.abs(m.pt1[1] - gateBefore[1]) < 0.5,
        `outside the mode the same drag does NOT move a plane node (was ${JSON.stringify(gateBefore.map(Math.round))}, now ${JSON.stringify(m.pt1.map(Math.round))})`);
    check(!m.selected, 'exiting the mode clears the plane selection');
    check(m.hitTestNull, 'plane hit testing returns nothing outside the mode');

    // Back in for the last section.
    await page.click('.menu-item[data-menu="view"]');
    await page.click('#menuDefinePlanes');

    // =================================================================
    // 13 — placements stay in sync with their skeleton
    // =================================================================
    console.log('\n13. Placements track their skeleton');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const sk = P.planeState.skeletons[0];
        P.planeState.selectedSkeletonId = sk.id;
        P.refreshPlanePanel();
        const before = P.getPlacements('camB')[0].toPointsArray();

        // Add a node: existing placements grow by one point that has a REAL
        // position (an unpositioned node draws nothing, so the user would have
        // no way to grab it and place it).
        document.getElementById('planeNodeNameInput').value = 'centre';
        document.getElementById('btnAddPlaneNode').click();
        const p0 = P.getPlacements('camB')[0];
        const afterAdd = p0.toPointsArray();

        // Remove node 0: the placement must splice at the SAME index, and the
        // skeleton's edges must renumber without dangling.
        document.querySelectorAll('#planeNodesTable tbody tr')[0]
            .querySelector('button').click();
        const p = P.getPlacements('camB')[0];
        const afterRemove = p.toPointsArray();

        const out = {
            beforeLen: before.length,
            afterAddLen: afterAdd.length,
            newPointPositioned: !!afterAdd[4] && Number.isFinite(afterAdd[4][0]),
            afterRemoveLen: afterRemove.length,
            nodeLen: sk.nodes.length,
            // The surviving points are the old ones shifted down by one.
            shiftedCorrectly: JSON.stringify(afterRemove.slice(0, 3)) === JSON.stringify(before.slice(1)),
            edgesInRange: sk.edges.every(e =>
                e[0] >= 0 && e[0] < sk.nodes.length && e[1] >= 0 && e[1] < sk.nodes.length),
            colorsAligned: sk.nodeColors.length === sk.nodes.length,
        };

        // Deleting the skeleton takes its placements with it.
        P.deletePlaneSkeleton(sk.id);
        P.refreshPlanePanel();
        out.placementsAfterDelete = P.getAllPlacements().length;
        out.placementRowsAfterDelete = document.querySelectorAll('.plane-placement-item').length;
        return out;
    });
    check(m.afterAddLen === m.beforeLen + 1, `adding a node grows the placement (${m.beforeLen} -> ${m.afterAddLen})`);
    check(m.newPointPositioned, 'the new point gets a real position, not an unreachable null');
    check(m.afterRemoveLen === m.nodeLen, `placement length tracks node count (${m.afterRemoveLen} vs ${m.nodeLen})`);
    check(m.shiftedCorrectly, 'removing node 0 splices the placement at the same index');
    check(m.edgesInRange, 'connections stay in range after a node removal');
    check(m.colorsAligned, 'node colours stay aligned with the node list');
    check(m.placementsAfterDelete === 0, `deleting a skeleton removes its placements (got ${m.placementsAfterDelete})`);
    check(m.placementRowsAfterDelete === 0, 'the expanded placement list empties too');

    // =================================================================
    // 14 — Set Origin Mode: pick a corner, pick a +Z, get the transform
    // =================================================================
    console.log('\n14. Set Origin Mode');

    // Section 13 deleted the last skeleton, so build a fresh fitted plane.
    const TRUTH14 = [[-40, -30, 220], [40, -30, 220], [45, 25, 220], [-45, 25, 220]];
    m = await page.evaluate(async (TRUTH) => {
        const P = await import('/ui/plane-definition.js');
        const O = await import('/ui/origin-definition.js');
        const AS = await import('/ui/app-state.js');
        const out = {};
        const cams = AS.state.session.cameras;

        out.btnExists = !!document.getElementById('btnSetOrigin');
        // No fitted plane yet -> the button must refuse, and say why.
        P.refreshPlanePanel();
        out.disabledWithNoFit = document.getElementById('btnSetOrigin').disabled;
        out.titleWithNoFit = document.getElementById('btnSetOrigin').title;
        O.enterOriginMode();
        out.refusedToEnter = !O.originState.active;
        out.refusalStatus = document.getElementById('statusText').textContent;

        const sk = P.createPlaneSkeleton('bench');
        ['a', 'b', 'c', 'd'].forEach(n => sk.addNode(n));
        [[0, 1], [1, 2], [2, 3], [3, 0]].forEach(([s, d]) => sk.addEdge(s, d));
        P.planeState.selectedSkeletonId = sk.id;
        ['camA', 'camB'].forEach(name => {
            const cam = cams.find(c => c.name === name);
            const view = AS.state.views.find(v => v.name === name);
            P.addPlacement(sk, name, view.videoWidth / 2, view.videoHeight / 2);
            P.getPlacementOn(name, sk.id).setPointsFrom(TRUTH.map(q => cam.project(q)));
        });
        P.refreshPlanePanel();
        document.getElementById('btnPlaneTriangulate').click();
        document.getElementById('btnPlaneFit').click();
        out.fitted = !!sk.planeFit;
        out.skId = sk.id;
        out.enabledWithFit = !document.getElementById('btnSetOrigin').disabled;
        return out;
    }, TRUTH14);
    check(m.btnExists, 'a Set Origin button exists');
    check(m.disabledWithNoFit, 'it is greyed out with no fitted plane');
    check(/Fit a plane first/.test(m.titleWithNoFit),
        `the disabled state explains itself (got "${m.titleWithNoFit}")`);
    check(m.refusedToEnter, 'entering the mode with no fitted plane is refused, not a dead-end wizard');
    check(/Fit a plane first/.test(m.refusalStatus), `the refusal is reported (got "${m.refusalStatus}")`);
    check(m.fitted && m.enabledWithFit, 'with a fitted plane it becomes available');

    // --- entering the mode ---
    m = await page.evaluate(async () => {
        const O = await import('/ui/origin-definition.js');
        const P = await import('/ui/plane-definition.js');
        const AS = await import('/ui/app-state.js');
        document.getElementById('btnSetOrigin').click();
        const vp = AS.viewport3d;
        const out = {
            active: O.originState.active,
            step: O.originState.step,
            barShown: getComputedStyle(document.getElementById('originModeBar')).display !== 'none',
            planeBarHidden: getComputedStyle(document.getElementById('planeModeBar')).display === 'none',
            instructionShown: getComputedStyle(document.getElementById('originInstruction')).display !== 'none',
            stepText: document.getElementById('originStepText').textContent,
            confirmHidden: getComputedStyle(document.getElementById('originConfirmRow')).display === 'none',
            pickMode: vp._originPickMode,
            // Every other button is locked out…
            otherButtonsDisabled: ['btnSetOrigin', 'btnPlaneFit', 'btnPlaneTriangulate',
                'btnNewPlaneSkeleton', 'planeModeExit']
                .every(id => document.getElementById(id).disabled),
            // …except the mode's own way out and the wizard's controls.
            exitEnabled: !document.getElementById('originModeExit').disabled,
            wizardEnabled: !document.getElementById('btnOriginCancel').disabled
                && !document.getElementById('btnOriginContinue').disabled,
            menuLocked: document.body.classList.contains('origin-mode-lock'),
        };
        // Corner DRAGGING must be off, or a corner could move out from under
        // the click that is selecting it.
        out.draggingOff = vp._planeGroup.children[0].children
            .filter(c => c.name.startsWith('planeNode_'))
            .every(c => c.userData.planeEditable !== true);
        out.stillPickable = vp._planeGroup.children[0].children
            .filter(c => c.name.startsWith('planeNode_'))
            .every(c => c.userData.planeFitted === true);
        return out;
    });
    check(m.active && m.step === 'node', `clicking Set Origin enters the mode at step 'node' (got '${m.step}')`);
    check(m.barShown && m.planeBarHidden, 'the Set Origin banner replaces the plane banner');
    check(m.instructionShown && /Click a corner of a fitted plane/.test(m.stepText),
        `the 3D view carries the instruction (got "${m.stepText}")`);
    check(m.confirmHidden, 'Cancel/Continue stay hidden until there is something to confirm');
    check(m.pickMode === 'node', `the viewport is armed for node picking (got '${m.pickMode}')`);
    check(m.otherButtonsDisabled, 'every other button is disabled for the duration');
    check(m.exitEnabled && m.wizardEnabled, 'Exit and the wizard buttons stay live');
    check(m.menuLocked, 'the menu bar is locked too (its items are divs, so CSS does it)');
    check(m.draggingOff, 'corner dragging is turned off while picking');
    check(m.stillPickable, 'but those same corners stay pickable');

    // --- the instruction box gets out of the way ---
    // It floats over the very corner/arrow the wizard is asking for, so the
    // grip drags it. Only the grip: the box staying `pointer-events: none` is
    // what keeps it from eating picks across its whole footprint.
    {
        const grip = await page.locator('#originDragHandle').boundingBox();
        const before = await page.locator('#originInstruction').boundingBox();
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(grip.x + grip.width / 2 - 60, grip.y + grip.height / 2 + 100, { steps: 8 });
        await page.mouse.up();
        const after = await page.locator('#originInstruction').boundingBox();
        const st = await page.evaluate(async () => {
            const O = await import('/ui/origin-definition.js');
            const AS = await import('/ui/app-state.js');
            return {
                step: O.originState.step,
                pickMode: AS.viewport3d._originPickMode,
                boxPointerEvents: getComputedStyle(
                    document.getElementById('originInstruction')).pointerEvents,
            };
        });
        check(Math.abs(after.x - (before.x - 60)) <= 2 && Math.abs(after.y - (before.y + 100)) <= 2,
            `dragging the grip moves the instruction box (${before.x},${before.y} -> ${after.x},${after.y})`);
        check(st.step === 'node' && st.pickMode === 'node',
            'dragging the box leaves the wizard step and the armed picker alone');
        check(st.boxPointerEvents === 'none',
            'the box itself still takes no pointer events, so picks fall through it');

        // Clamped: a drag aimed past the viewport's edge must not park it
        // off-screen, where it could not be dragged back.
        const host = await page.locator('#viewport3dContainer').boundingBox();
        const g2 = await page.locator('#originDragHandle').boundingBox();
        await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2);
        await page.mouse.down();
        await page.mouse.move(host.x - 400, host.y - 400, { steps: 6 });
        await page.mouse.up();
        const clamped = await page.locator('#originInstruction').boundingBox();
        check(clamped.x >= host.x - 1 && clamped.y >= host.y - 1
            && clamped.x + clamped.width <= host.x + host.width + 1,
            `the box is clamped inside the 3D viewport (box x=${clamped.x}, host x=${host.x})`);
    }

    // --- step 1: pick a corner in the 3D view ---
    m = await page.evaluate(async (TRUTH) => {
        const O = await import('/ui/origin-definition.js');
        const P = await import('/ui/plane-definition.js');
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const vp = AS.viewport3d;
        const dom = vp.renderer.domElement;
        const sk = P.planeState.skeletons[P.planeState.skeletons.length - 1];

        vp.fitToScene();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const toScreen = (p) => {
            const v = new THREE.Vector3(p[0], p[1], p[2]).project(vp.threeCamera);
            const r = dom.getBoundingClientRect();
            return {
                x: r.left + (v.x + 1) / 2 * r.width,
                y: r.top + (1 - v.y) / 2 * r.height,
                onScreen: Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1,
            };
        };
        const click = (x, y) => dom.dispatchEvent(new MouseEvent('click', {
            clientX: x, clientY: y, bubbles: true,
        }));

        const out = {};
        // A click on empty space must be consumed, not turned into a camera pick.
        const camBefore = vp.selectedCamera;
        click(dom.getBoundingClientRect().left + 5, dom.getBoundingClientRect().top + 5);
        out.missConsumed = vp.selectedCamera === camBefore && O.originState.step === 'node';

        const K = 1;
        const target = toScreen(pd.getPoint3d(sk.points3d, K));
        out.onScreen = target.onScreen;
        click(target.x, target.y);

        out.step = O.originState.step;
        out.nodeIdx = O.originState.nodeIdx;
        out.originPoint = O.originState.originPoint && O.originState.originPoint.slice();
        out.wantPoint = TRUTH[K];
        out.normal = O.originState.normal && O.originState.normal.slice();
        out.pickMode = vp._originPickMode;
        out.stepText = document.getElementById('originStepText').textContent;
        out.legendShown = getComputedStyle(document.getElementById('originLegend')).display !== 'none';

        // Two arrows + the corner marker.
        const names = vp._originGroup.children.map(c => c.name);
        out.arrowNames = names;
        out.arrowMeshes = [];
        vp._originGroup.traverse(c => { if (c.isMesh && c.userData.originAxis) out.arrowMeshes.push(c.userData.originAxis); });
        return out;
    }, TRUTH14);
    check(m.missConsumed, 'a click on empty space is consumed, not read as a camera pick');
    check(m.onScreen, 'the corner under test is on screen');
    check(m.step === 'axis', `picking a corner advances to the axis step (got '${m.step}')`);
    check(m.nodeIdx === 1, `it records which corner (got ${m.nodeIdx})`);
    check(m.originPoint && m.originPoint.every((v, i) => Math.abs(v - m.wantPoint[i]) < 0.01),
        `the origin is that corner's 3D position (got ${JSON.stringify(m.originPoint && m.originPoint.map(v => +v.toFixed(2)))} vs ${JSON.stringify(m.wantPoint)})`);
    check(m.normal && Math.abs(Math.hypot(...m.normal) - 1) < 1e-9, 'the fitted plane normal comes with it');
    check(m.pickMode === 'axis', `the viewport re-arms for axis picking (got '${m.pickMode}')`);
    check(/red or the blue arrow/.test(m.stepText), `the instruction advances (got "${m.stepText}")`);
    check(m.legendShown, 'the red/blue legend appears with the arrows');
    check(eq(m.arrowNames, ['originAxis_positive', 'originAxis_negative', 'originMarker']),
        `both candidate arrows plus the corner marker are drawn (got ${JSON.stringify(m.arrowNames)})`);
    check(m.arrowMeshes.length === 4,
        `each arrow is a pickable shaft + head mesh (got ${m.arrowMeshes.length})`);

    // --- step 2: pick an arrow, then Continue ---
    m = await page.evaluate(async () => {
        const O = await import('/ui/origin-definition.js');
        const P = await import('/ui/plane-definition.js');
        const OF = await import('/pose/origin-frame.js');
        const AS = await import('/ui/app-state.js');
        const vp = AS.viewport3d;
        const dom = vp.renderer.domElement;
        const out = {};

        const clickWorld = (p) => {
            const v = new THREE.Vector3(p[0], p[1], p[2]).project(vp.threeCamera);
            const r = dom.getBoundingClientRect();
            dom.dispatchEvent(new MouseEvent('click', {
                clientX: r.left + (v.x + 1) / 2 * r.width,
                clientY: r.top + (1 - v.y) / 2 * r.height,
                bubbles: true,
            }));
        };

        // Arrow length is scaled to the PLANE's reach from the picked corner
        // (70%), not to the camera baseline — recomputed here from the known
        // truth rather than read back from the module, so it pins that rule.
        const pd = await import('/pose/pose-data.js');
        const skA = P.planeState.skeletons[P.planeState.skeletons.length - 1];
        const o = O.originState.originPoint, n = O.originState.normal;
        let far = 0;
        for (let k = 0; k < skA.nodes.length; k++) {
            const q = pd.getPoint3d(skA.points3d, k);
            far = Math.max(far, Math.hypot(q[0] - o[0], q[1] - o[1], q[2] - o[2]));
        }
        out.wantArrowLen = far * 0.7;
        out.arrowLen = O.originState.arrowLength;
        // 40% along the BLUE (-n) arrow: on its shaft, and well clear of the
        // red one, which points the other way.
        const L = out.wantArrowLen * 0.4;
        clickWorld([o[0] - n[0] * L, o[1] - n[1] * L, o[2] - n[2] * L]);
        out.chosen = O.originState.chosen;
        out.step = O.originState.step;
        out.confirmShown = getComputedStyle(document.getElementById('originConfirmRow')).display !== 'none';
        out.stepText = document.getElementById('originStepText').textContent;
        // The loser is dimmed, not removed — the choice must stay visible.
        const opacity = {};
        vp._originGroup.traverse(c => {
            if (c.isMesh && c.userData.originAxis) opacity[c.userData.originAxis] = c.material.opacity;
        });
        out.opacity = opacity;

        // Switching arrows without cancelling.
        clickWorld([o[0] + n[0] * L, o[1] + n[1] * L, o[2] + n[2] * L]);
        out.switched = O.originState.chosen;
        // …and back to blue, which is the one under test below.
        clickWorld([o[0] - n[0] * L, o[1] - n[1] * L, o[2] - n[2] * L]);
        out.reSwitched = O.originState.chosen;

        const pivotBefore = [vp._framePivot.position.x, vp._framePivot.position.y, vp._framePivot.position.z];
        // The camera's offset from its pivot, which the re-base must preserve:
        // what is on screen should not jump, only what the next drag keys on.
        const offBefore = vp.threeCamera.position.clone().sub(vp.controls.target);
        document.getElementById('btnOriginContinue').click();

        const f = O.originState.frame;
        out.hasFrame = !!f;
        if (!f) return out;
        out.origin = f.origin.slice();
        out.zAxis = f.zAxis.slice();
        out.wantZ = [-n[0], -n[1], -n[2]];
        out.R = f.R.map(r => r.slice());
        out.translation = f.translation.slice();
        out.rotationVector = f.rotationVector.slice();
        out.angleDeg = f.angleDeg;

        // The frame must actually be a frame: orthonormal, right-handed, and
        // it must send the picked corner to the new origin.
        const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        out.orthonormal = [0, 1, 2].every(i => Math.abs(dot(f.R[i], f.R[i]) - 1) < 1e-12)
            && Math.abs(dot(f.R[0], f.R[1])) < 1e-12
            && Math.abs(dot(f.R[1], f.R[2])) < 1e-12
            && Math.abs(dot(f.R[0], f.R[2])) < 1e-12;
        const det = f.R[0][0] * (f.R[1][1] * f.R[2][2] - f.R[1][2] * f.R[2][1])
            - f.R[0][1] * (f.R[1][0] * f.R[2][2] - f.R[1][2] * f.R[2][0])
            + f.R[0][2] * (f.R[1][0] * f.R[2][1] - f.R[1][1] * f.R[2][0]);
        out.det = det;
        out.originMapsToZero = Math.hypot(...OF.applyOriginFrame(f, f.origin));
        // Every other corner of the plane must land at z = 0 in the new frame —
        // that is what "the plane IS the new XY plane" means.
        const sk = skA;
        out.worstZ = 0;
        for (let k = 0; k < sk.nodes.length; k++) {
            const q = OF.applyOriginFrame(f, Array.from(pd.getPoint3d(sk.points3d, k)));
            out.worstZ = Math.max(out.worstZ, Math.abs(q[2]));
        }
        // Round-trip through the inverse.
        const probe = [12.5, -7.25, 301.75];
        const back = OF.unapplyOriginFrame(f, OF.applyOriginFrame(f, probe));
        out.roundTrip = Math.hypot(back[0] - probe[0], back[1] - probe[1], back[2] - probe[2]);

        // The DISPLAY is re-based: the grid pivot moved onto the new origin…
        out.pivotBefore = pivotBefore;
        out.pivotAfter = [vp._framePivot.position.x, vp._framePivot.position.y, vp._framePivot.position.z];
        // …and the grid + axes are its children, so they came along.
        out.pivotChildren = vp._framePivot.children.map(c => c.type).sort();
        // …while no DATA moved.
        out.planeStillAtWorld = Math.abs(pd.getPoint3d(sk.points3d, 0)[2] - 220) < 0.01;

        // …and so is the INTERACTION: orbit and zoom now key on the new origin,
        // spinning about the new +Z, without the picture jumping.
        out.targetAfter = vp.controls.target.toArray();
        out.upAfter = vp.threeCamera.up.toArray();
        out.controlsUp = vp._controlsUp.toArray();
        const offAfter = vp.threeCamera.position.clone().sub(vp.controls.target);
        out.offDrift = offAfter.clone().sub(offBefore).length();
        out.distBefore = offBefore.length();
        out.distAfter = offAfter.length();
        // A wheel tick dollies along the camera->target ray, so "zoom keys on
        // the new origin" is exactly "the camera walks toward the new origin".
        const posBeforeZoom = vp.threeCamera.position.clone();
        vp.renderer.domElement.dispatchEvent(new WheelEvent('wheel', {
            deltaY: -240, bubbles: true, cancelable: true,
        }));
        vp.controls.update();
        const moved = vp.threeCamera.position.clone().sub(posBeforeZoom);
        out.zoomMoved = moved.length();
        // The direction it walked, vs. the direction of the new origin.
        const toOrigin = vp.controls.target.clone().sub(posBeforeZoom).normalize();
        out.zoomTowardOrigin = moved.length() > 1e-9 ? moved.normalize().dot(toOrigin) : 0;

        // The mode ends so the result is readable.
        out.modeExited = !O.originState.active;
        out.buttonsRestored = !document.getElementById('btnSetOrigin').disabled;
        out.instructionHidden = getComputedStyle(document.getElementById('originInstruction')).display === 'none';
        out.pickModeCleared = vp._originPickMode === null;
        out.arrowsCleared = vp._originGroup.children.length === 0;
        out.status = document.getElementById('statusText').textContent;
        return out;
    });
    check(m.arrowLen && Math.abs(m.arrowLen - m.wantArrowLen) < 1e-9,
        `the candidate arrows are scaled to the plane's extent, not the camera baseline ` +
        `(got ${m.arrowLen && m.arrowLen.toFixed(2)} mm, want ${m.wantArrowLen.toFixed(2)})`);
    check(m.chosen === 'negative' && m.step === 'confirm',
        `clicking the blue arrow chooses it and advances to confirm (got '${m.chosen}'/'${m.step}')`);
    check(m.confirmShown && /Continue re-bases/.test(m.stepText), 'Cancel/Continue appear with an explanation');
    check(m.opacity && m.opacity.negative > m.opacity.positive,
        `the unchosen arrow is dimmed, not removed (chosen ${m.opacity.negative} vs other ${m.opacity.positive})`);
    check(m.switched === 'positive' && m.reSwitched === 'negative',
        'the choice can be switched without cancelling');
    check(m.hasFrame, 'Continue builds the frame');
    check(m.zAxis && m.zAxis.every((v, i) => Math.abs(v - m.wantZ[i]) < 1e-12),
        '+Z is the arrow the user picked, not the raw plane normal');
    check(m.orthonormal, 'R is orthonormal');
    check(Math.abs(m.det - 1) < 1e-12, `R is right-handed (det ${m.det})`);
    check(m.originMapsToZero < 1e-9,
        `the picked corner maps to the new origin (${m.originMapsToZero.toExponential(2)} mm off)`);
    check(m.worstZ < 1e-9,
        `every corner of the plane lands at z=0 in the new frame (worst ${m.worstZ.toExponential(2)} mm)`);
    check(m.roundTrip < 1e-9, `the inverse round-trips (${m.roundTrip.toExponential(2)} mm)`);
    check(m.pivotAfter && m.pivotAfter.every((v, i) => Math.abs(v - m.origin[i]) < 1e-9),
        `the grid pivot moves onto the new origin (${JSON.stringify(m.pivotAfter.map(v => +v.toFixed(2)))})`);
    check(m.pivotChildren && m.pivotChildren.length === 2,
        `the grid and axis helper are its children (got ${JSON.stringify(m.pivotChildren)})`);
    check(m.planeStillAtWorld, 'no DATA moved — the plane is still at its calibration coordinates');
    check(m.targetAfter && m.targetAfter.every((v, i) => Math.abs(v - m.origin[i]) < 1e-6),
        `the orbit pivot moves onto the new origin too (${JSON.stringify(m.targetAfter.map(v => +v.toFixed(2)))})`);
    check(m.upAfter && m.upAfter.every((v, i) => Math.abs(v - m.zAxis[i]) < 1e-9),
        'the camera up vector becomes the new +Z');
    check(m.controlsUp && m.controlsUp.every((v, i) => Math.abs(v - m.zAxis[i]) < 1e-9),
        'the controls were rebuilt on that axis — r147 bakes the orbit axis in at construction');
    check(m.offDrift < 1e-6 && Math.abs(m.distAfter - m.distBefore) < 1e-6,
        `the view does not jump: the camera keeps its direction and distance (drift ${m.offDrift.toExponential(2)})`);
    check(m.zoomMoved > 1e-6 && m.zoomTowardOrigin > 0.999999,
        `a wheel tick zooms straight at the new origin (${m.zoomMoved.toFixed(2)} mm, cos ${m.zoomTowardOrigin.toFixed(6)})`);
    check(m.modeExited && m.buttonsRestored, 'the mode ends and the UI unlocks');
    check(m.instructionHidden && m.pickModeCleared && m.arrowsCleared,
        'the wizard overlay, picker and arrows are all torn down');
    check(/Origin set/.test(m.status), `it reports to the status bar (got "${m.status}")`);

    // --- the result table ---
    m = await page.evaluate(async () => {
        const O = await import('/ui/origin-definition.js');
        const shown = getComputedStyle(document.getElementById('originResultSection')).display !== 'none';
        const rows = Array.from(document.querySelectorAll('#originResult .origin-table:not(.origin-matrix) tr'))
            .map(tr => tr.children[0].textContent);
        const matrixCells = document.querySelectorAll('#originResult .origin-matrix td').length;
        const text = document.getElementById('originResult').textContent;
        const f = O.originState.frame;
        // The matrix rendered must be the matrix computed.
        const cells = Array.from(document.querySelectorAll('#originResult .origin-matrix td'))
            .map(td => parseFloat(td.textContent));
        let worst = 0;
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
            worst = Math.max(worst, Math.abs(cells[r * 3 + c] - f.R[r][c]));
        }
        return { shown, rows, matrixCells, text, worst, angleDeg: f.angleDeg };
    });
    check(m.shown, 'the result section appears in the panel');
    check(m.rows.includes('Origin (old frame)') && m.rows.includes('Translation t'),
        `both the origin AND the mapping's translation are listed, labelled (got ${JSON.stringify(m.rows)})`);
    check(m.rows.includes('Rotation vector'), 'the rotation vector is listed');
    check(m.matrixCells === 9, `the 3x3 rotation matrix is rendered (got ${m.matrixCells} cells)`);
    check(m.worst < 1e-3, `the rendered matrix matches the computed one (worst ${m.worst.toExponential(2)})`);
    check(/p_new = R/.test(m.text), 'the convention is stated, so the two vectors cannot be confused');
    check(/Rotation angle/.test(m.text), `the angle is reported (${m.angleDeg.toFixed(2)}deg)`);

    // --- Cancel, Esc, and Reset ---
    m = await page.evaluate(async () => {
        const O = await import('/ui/origin-definition.js');
        const P = await import('/ui/plane-definition.js');
        const AS = await import('/ui/app-state.js');
        const vp = AS.viewport3d;
        const sk = P.planeState.skeletons[P.planeState.skeletons.length - 1];
        const out = {};

        // Cancel returns to step 1 WITHOUT leaving the mode.
        O.enterOriginMode();
        O.pickOriginNode(sk.id, 0);
        O.pickOriginAxis('positive');
        out.beforeCancel = O.originState.step;
        document.getElementById('btnOriginCancel').click();
        out.afterCancelStep = O.originState.step;
        out.afterCancelActive = O.originState.active;
        out.afterCancelPicks = O.originState.originPoint === null && O.originState.chosen === null;
        out.afterCancelArrows = vp._originGroup.children.length;
        // The applied frame is untouched by cancelling a NEW pick.
        out.frameKept = !!O.originState.frame;

        // Esc leaves the mode entirely and unlocks.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        out.afterEscActive = O.originState.active;
        out.afterEscUnlocked = !document.getElementById('btnSetOrigin').disabled;
        out.afterEscBarHidden = getComputedStyle(document.getElementById('originModeBar')).display === 'none';

        // An un-fit plane offers no corner.
        const before = O.fittedPlanes().length;
        sk.clearTriangulation();
        P.syncPlanes3D();
        out.fittedBefore = before;
        out.fittedAfterInvalidate = O.fittedPlanes().length;
        P.refreshPlanePanel();
        out.buttonDisabledAgain = document.getElementById('btnSetOrigin').disabled;

        // Reset puts the grid back on the calibration origin.
        O.clearOrigin();
        out.frameCleared = O.originState.frame === null;
        out.pivotReset = [vp._framePivot.position.x, vp._framePivot.position.y, vp._framePivot.position.z]
            .every(v => v === 0);
        out.resultHidden = getComputedStyle(document.getElementById('originResultSection')).display === 'none';
        // …and the orbit back with it, or the user would keep pivoting on an
        // origin nothing on screen shows any more.
        out.targetReset = vp.controls.target.toArray().every(v => Math.abs(v) < 1e-6);
        out.upReset = vp.threeCamera.up.toArray();
        out.controlsUpReset = vp._controlsUp.toArray();
        return out;
    });
    check(m.beforeCancel === 'confirm' && m.afterCancelStep === 'node',
        `Cancel returns to the corner step (got '${m.afterCancelStep}')`);
    check(m.afterCancelActive, 'Cancel stays in the mode — Exit is the way out');
    check(m.afterCancelPicks && m.afterCancelArrows === 0, 'Cancel clears both picks and the arrows');
    check(m.frameKept, 'cancelling a new pick does not discard the origin already applied');
    check(!m.afterEscActive && m.afterEscUnlocked && m.afterEscBarHidden,
        'Esc leaves the mode and unlocks the UI');
    check(m.fittedBefore === 1 && m.fittedAfterInvalidate === 0,
        'invalidating a plane drops it from the fitted set');
    check(m.buttonDisabledAgain, 'with no fitted plane left, Set Origin greys out again');
    check(m.frameCleared && m.pivotReset && m.resultHidden,
        'Reset restores the calibration frame and hides the table');
    check(m.targetReset && eq(m.upReset, [0, 0, 1]) && eq(m.controlsUpReset, [0, 0, 1]),
        `Reset puts the orbit back on the calibration origin and world +Z (up ${JSON.stringify(m.upReset)})`);

} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
