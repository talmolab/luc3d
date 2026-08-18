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
 *  2. The panel is THREE SIBLING SECTIONS — Nodes (the project-wide pool), Edit
 *     Plane, and the Planes list — each a real <details> that collapses, with
 *     the global Nodes table NOT nested inside the plane editor. Node creation
 *     is not a sub-step of editing one plane.
 *  3. `+ Node` MINTS A POOL NODE AND TOUCHES NO PLANE: it creates none and
 *     joins none, `+ Add` is the only way into a plane, and a duplicate name is
 *     refused. Renaming is the Name field (not the selector) and reaches the
 *     dropdown and the Planes table live. The selector lists every plane with
 *     `+ New Plane` pinned last, and agrees with the Planes table both ways.
 *  4. Dropping a plane onto a view places it THERE, seeded around the drop
 *     point and clamped inside the frame. A SECOND drop of the same plane on
 *     the same view is refused rather than stacking or re-seeding, so carefully
 *     placed nodes can't be destroyed by a stray drag.
 *  5. The placement is actually DRAWN — `drawAllOverlays` must call the plane
 *     pass AFTER `drawFrameOverlays`, which opens with a clearRect. A
 *     regression that reorders them leaves the overlay blank, which this
 *     catches by sampling pixels. Placements are frame-independent.
 *  6. REGRESSION GUARD: the drag payload must not use `text/plain`.
 *     `ui/sessions-panes.js` tells dockview to accept any text/plain drag over
 *     the dock and turn it into a new video panel, so a text/plain payload
 *     here would be swallowed as a bogus view name instead of placing a plane.
 *  7. Per-node colour is scoped to the NODE, so a corner is the same colour on
 *     every view and in every plane — that is the cross-view correspondence
 *     cue. Changing it changes what is drawn everywhere.
 *  8. A PlaneInstance behaves like a UserInstance under the mouse: click to
 *     select, drag a node, Alt+drag the whole plane, right-click to toggle a
 *     node off. And the mode gate: OUTSIDE Defining Plane Mode the exact same
 *     drag must do nothing, so plane nodes never compete with pose nodes.
 *  9. The per-view 2D stays in sync with the node pool across add/remove.
 * 15. NODES ARE GLOBAL AND SHARED. One node in two planes is ONE 3D point and
 *     ONE 2D point per view; deleting it cleans up both planes; a node only
 *     placed planes reference is the only one that takes a click.
 * 16. PINNED (immutable) nodes. Not draggable in 2D or in 3D, held bit-exactly
 *     by a constrained fit, `frozen-unsolved` surfaced in the panel, a blocking
 *     fit error mutates NOTHING, and a fit that moves a shared node marks the
 *     other plane's fit stale.
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

    // Helpers for the new model. Nodes are GLOBAL and a view has ONE instance
    // covering the whole pool, so almost every assertion below has to translate
    // between a plane's own node order and the pool order the 2D is indexed by.
    // Installing that translation once keeps the assertions about behaviour
    // rather than about index arithmetic.
    await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        window.__P = P;
        /** The i-th plane, in creation order. */
        window.__plane = (i) => P.planeModel().planes[i];
        /** Pool indices of a plane's nodes, in the PLANE's order. */
        window.__poolIdx = (plane) =>
            plane.nodeIds.map(id => P.planeModel().pool.indexOf(id));
        /** The pool nodes of a plane, in the plane's order. */
        window.__nodesOf = (plane) =>
            plane.nodeIds.map(id => P.planeModel().pool.getNode(id));
        window.__namesOf = (plane) => window.__nodesOf(plane).map(n => n && n.name);
        /** Write a plane's 2D on a view from PLANE-ordered points. */
        window.__setPts = (plane, view, pts) => {
            const inst = P.getPlaneInstance(view);
            const idx = window.__poolIdx(plane);
            pts.forEach((q, k) => inst.setPoint(idx[k], q[0], q[1]));
        };
        /** Read a plane's 2D on a view, in PLANE order. */
        window.__getPts = (plane, view) => {
            const inst = P.getPlaneInstance(view);
            return window.__poolIdx(plane).map(i => inst.getPoint(i));
        };
        /** Edges as NAME pairs, so assertions do not depend on id numbering. */
        window.__edgeNames = (plane) => plane.edges.map(e => [
            P.planeModel().pool.getNode(e[0]).name,
            P.planeModel().pool.getNode(e[1]).name,
        ]);
    });

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
    // 1b — entering the mode mints NO plane
    // =================================================================
    //
    // A phantom `plane_1` nobody created is worse than an empty list: it is
    // indistinguishable from one the user made and forgot, so it gets dragged
    // onto a view, triangulated, and wondered about. The empty state has to
    // carry its own instructions instead.
    console.log('\n1b. No default plane on entry');
    m = await page.evaluate(() => ({
        planeCount: window.__P.planeModel().planes.length,
        emptyShown: getComputedStyle(document.getElementById('planeEditorEmpty')).display !== 'none',
        contentHidden: getComputedStyle(document.getElementById('planeEditorContent')).display === 'none',
        listEmptyShown: getComputedStyle(document.getElementById('planeSkeletonsEmpty')).display !== 'none',
        nameDisabled: document.getElementById('planeSkeletonName').disabled,
        emptyText: document.getElementById('planeEditorEmpty').textContent,
        // The SELECTOR is the one control that stays live with no plane: it is
        // now a primary way to make the first one, so hiding it with the rest
        // of the body would leave the section a dead end.
        selectShown: getComputedStyle(document.getElementById('planeSelect')).display !== 'none',
        selectOutsideContent:
            !document.getElementById('planeSelect').closest('#planeEditorContent'),
        selectOptions: Array.from(document.querySelectorAll('#planeSelect option'))
            .map(o => o.textContent),
        placeholderDisabled: document.querySelector('#planeSelect option').disabled,
    }));
    check(m.planeCount === 0, `entering the mode creates no plane (got ${m.planeCount})`);
    check(m.listEmptyShown, 'the Planes list shows its empty state');
    check(m.emptyShown && m.contentHidden, 'the Edit Plane section is empty-stated, not shown half-dead');
    check(m.nameDisabled, 'and its name field is disabled rather than editable-but-inert');
    // The empty state points UP at the dropdown in this very section — the
    // stale "pick one in Planes below" would send the user the wrong way.
    check(/above/.test(m.emptyText) && /dropdown/i.test(m.emptyText) && !/below/.test(m.emptyText),
        `the empty state points at the Plane dropdown above it (got ${JSON.stringify(m.emptyText)})`);
    check(m.selectShown && m.selectOutsideContent,
        'the plane selector stays live outside the empty-stated body');
    check(eq(m.selectOptions, ['— no planes yet —', '+ New Plane']),
        `with no planes it is a placeholder plus + New Plane (got ${JSON.stringify(m.selectOptions)})`);
    check(m.placeholderDisabled,
        'the placeholder is disabled, so "nothing selected" cannot be chosen back');

    // Everything from here needs a plane to act on. Make the FIRST one through
    // the dropdown — with no plane anywhere that is the shortest path, and it
    // must work from the placeholder state.
    await page.selectOption('#planeSelect', { label: '+ New Plane' });
    m = await page.evaluate(() => ({
        planeCount: window.__P.planeModel().planes.length,
        selectedIsNew: window.__P.planeState.selectedPlaneId ===
            window.__P.planeModel().planes[0].id,
        selectValue: document.getElementById('planeSelect').value,
        selectLabel: document.getElementById('planeSelect')
            .selectedOptions[0].textContent,
        contentShown: getComputedStyle(document.getElementById('planeEditorContent')).display !== 'none',
        noPlaceholder: !Array.from(document.querySelectorAll('#planeSelect option'))
            .some(o => /no planes yet|select a plane/.test(o.textContent)),
    }));
    check(m.planeCount === 1, `+ New Plane in the dropdown creates a plane (got ${m.planeCount})`);
    check(m.selectedIsNew && m.contentShown, 'and selects it for editing');
    check(m.selectValue === String(await page.evaluate(() => window.__plane(0).id)) &&
        m.selectLabel !== '+ New Plane',
        `the dropdown lands on the new plane, not on "+ New Plane" (got "${m.selectLabel}")`);
    check(m.noPlaceholder, 'the placeholder is gone once something is selected');

    // =================================================================
    // 2 — three sibling sections, each collapsible
    // =================================================================
    //
    // The IA is the data model made visible: nodes are GLOBAL and outlive the
    // planes referencing them, so the Nodes table is a top-level section and
    // NOT a sub-step of editing one plane. A regression that re-nests it would
    // put node creation back inside the plane editor, which is exactly the
    // thing the pool refactor made wrong.
    console.log('\n2. Three sibling sections, each collapsible');
    m = await page.evaluate(() => {
        // Listed in DOM order, so `summaries` and `sectionOrder` cannot drift
        // apart — a hard-coded list in the old order would keep passing while
        // the panel said something else.
        const ids = ['planeNodesDetails', 'planeEditorDetails', 'planePlanesDetails',
                     'planeMembersDetails', 'planeEdgesDetails'];
        const els = ids.map(id => document.getElementById(id));
        const label = (e) => {
            const l = e.querySelector('.plane-summary-label');
            return (l || e.querySelector('summary')).textContent.trim();
        };
        const out = {
            allDetails: els.every(e => e && e.tagName === 'DETAILS'),
            summaries: els.map(e => e && label(e)),
            openByDefault: els.every(e => e.open),
            // The three TOP-LEVEL sections are siblings under #planePanel, in
            // work order, each in its own .info-section.
            sectionOrder: Array.from(document.querySelectorAll('#planePanel > .info-section'))
                .map(s => {
                    const d = s.querySelector(':scope > details');
                    return d ? d.id : (s.querySelector('h3') ? 'h3:' + s.querySelector('h3').textContent : s.id);
                }).slice(0, 3),
            // The global Nodes table is NOT inside the plane editor…
            nodesTableOutsideEditor:
                !document.getElementById('planeNodesTable').closest('#planeEditorDetails'),
            // …while the selected plane's members table IS.
            membersTableInsideEditor:
                !!document.getElementById('planeMembersTable').closest('#planeEditorDetails'),
            connectionsInsideEditor:
                !!document.getElementById('planeEdgesTable').closest('#planeEditorDetails'),
            // The pool's node-creation controls travel with the pool.
            addNodeOutsideEditor:
                !document.getElementById('btnAddPlaneNode').closest('#planeEditorDetails'),
            frozenWarningWithPool:
                !!document.getElementById('planeFrozenWarning').closest('#planeNodesDetails'),
            // The selector is the editor's TOP row and the editable name is
            // below it, in the body — two controls, not one overloaded field.
            selectInEditor: !!document.getElementById('planeSelect').closest('#planeEditorDetails'),
            selectIsSelect: document.getElementById('planeSelect').tagName,
            selectBeforeName: !!(document.getElementById('planeSelect')
                .compareDocumentPosition(document.getElementById('planeSkeletonName')) &
                Node.DOCUMENT_POSITION_FOLLOWING),
            nameInsideContent:
                !!document.getElementById('planeSkeletonName').closest('#planeEditorContent'),
        };
        // Collapse each and confirm the section actually shrinks to its
        // summary. Measure the <details> itself, not the body: Chromium keeps
        // a closed details' content in a `content-visibility` slot, so the
        // body still reports its intrinsic height even though nothing of it is
        // laid out or painted. One at a time, so a nested section is never
        // measured while its parent is shut.
        out.collapsedHeights = [];
        out.summaryHeights = [];
        out.expandedHeights = [];
        els.forEach(e => {
            e.open = false;
            out.collapsedHeights.push(e.offsetHeight);
            out.summaryHeights.push(e.querySelector('summary').offsetHeight);
            e.open = true;
            out.expandedHeights.push(e.offsetHeight);
        });
        return out;
    });
    check(m.allDetails, 'all five sections are <details>');
    check(eq(m.summaries, ['Nodes', 'Edit Plane', 'Planes',
                           'Nodes In This Plane', 'Node Connections']),
        `section order is Nodes -> Edit Plane (members, connections) -> Planes (got ${JSON.stringify(m.summaries)})`);
    check(m.selectInEditor && m.selectIsSelect === 'SELECT' && m.selectBeforeName &&
        m.nameInsideContent,
        'the editor leads with a <select> plane picker and keeps the editable name below it');
    // Nodes -> Edit Plane -> Planes: the editor sits directly under the
    // pool it draws nodes from, and the roster you switch between goes last.
    check(eq(m.sectionOrder, ['planeNodesDetails', 'planeEditorDetails', 'planePlanesDetails']),
        `the three top-level sections are siblings of #planePanel in that order (got ${JSON.stringify(m.sectionOrder)})`);
    check(m.nodesTableOutsideEditor && m.addNodeOutsideEditor && m.frozenWarningWithPool,
        'the global Nodes table, + Node and the pinned-node warning are their OWN section, not nested in the plane editor');
    check(m.membersTableInsideEditor && m.connectionsInsideEditor,
        'the selected plane\'s members and connections live in the plane section');
    check(m.openByDefault, 'sections start expanded');
    check(m.collapsedHeights.every((h, i) => h <= m.summaryHeights[i] + 2),
        `collapsing shrinks each section to its summary (got ${JSON.stringify(m.collapsedHeights)} vs summaries ${JSON.stringify(m.summaryHeights)})`);
    check(m.expandedHeights.every((h, i) => h > m.collapsedHeights[i]),
        `expanding restores each section (got ${JSON.stringify(m.expandedHeights)})`);

    // =================================================================
    // 3 — the editor builds a plane
    // =================================================================
    console.log('\n3. Plane editor');

    // 3a — + Node MINTS A POOL NODE AND TOUCHES NO PLANE. It used to create a
    // plane when none was selected and add the node to it, so a stray click on
    // an empty panel silently produced a `plane_1` the user then had to notice
    // and delete — and it made "make a node" and "put a node in this plane" one
    // act, which the shared-node model says they are not.
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const model = P.planeModel();
        const planesBefore = model.planes.length;
        const poolBefore = model.pool.size;
        P.planeState.selectedPlaneId = null;
        P.refreshPlanePanel();
        document.getElementById('planeNodeNameInput').value = 'orphan';
        document.getElementById('btnAddPlaneNode').click();
        const node = model.pool.nodes.find(n => n.name === 'orphan');
        const out = {
            planesBefore, poolBefore,
            planesAfter: model.planes.length,
            poolAfter: model.pool.size,
            inPool: !!node,
            inNPlanes: node ? model.planesForNode(node.id).length : -1,
            stillNoSelection: P.planeState.selectedPlaneId === null,
            // A node in no plane is a valid resting state the pool table
            // already renders — dimmed, not an error.
            rowUnused: node ? !!document.querySelector(
                'tr[data-plane-node-id="' + node.id + '"].plane-node-unused') : false,
            // The mint clears the field, so the next one is one keystroke away.
            inputCleared: document.getElementById('planeNodeNameInput').value === '',
            status: document.getElementById('statusText').textContent,
        };
        // Clean up: the sections below count the plane's own nodes.
        if (node) model.deleteNode(node.id);
        P.planeState.selectedPlaneId = model.planes[0].id;
        P.refreshPlanePanel();
        return out;
    });
    check(m.planesAfter === m.planesBefore,
        `+ Node with NO plane selected creates NO plane (${m.planesBefore} -> ${m.planesAfter})`);
    check(m.stillNoSelection, 'and does not silently select one either');
    check(m.inPool && m.poolAfter === m.poolBefore + 1,
        `the node lands in the global pool (${m.poolBefore} -> ${m.poolAfter})`);
    check(m.inNPlanes === 0, `and in no plane at all (got ${m.inNPlanes})`);
    check(m.rowUnused, 'the pool table renders it as an unused node rather than an error');
    check(m.inputCleared, 'the name field is cleared for the next one');
    check(/no plane yet/i.test(m.status),
        `and it says where the node went (got "${m.status}")`);

    // 3b — renaming. The dropdown above SELECTS; this field is what renames,
    // and both the dropdown and the Planes table must follow it live.
    await page.fill('#planeSkeletonName', 'floor');
    await page.dispatchEvent('#planeSkeletonName', 'change');
    m = await page.evaluate(() => ({
        modelName: window.__plane(0).name,
        selectLabel: document.getElementById('planeSelect').selectedOptions[0].textContent,
        selectValue: document.getElementById('planeSelect').value,
        rowName: document.querySelector('#planeSkeletonsTable tbody tr').children[1].textContent,
        title: document.getElementById('planeEditorTitle').textContent,
    }));
    check(m.modelName === 'floor' && m.selectLabel === 'floor' && m.rowName === 'floor' &&
        m.title === 'floor',
        `renaming updates the model, the dropdown, the Planes row and the header ` +
        `(got ${JSON.stringify([m.modelName, m.selectLabel, m.rowName, m.title])})`);
    check(m.selectValue === String(await page.evaluate(() => window.__plane(0).id)),
        'and the dropdown still selects by id, so a rename cannot move the selection');

    // 3c — four nodes, minted into the POOL only …
    for (const n of ['fl', 'fr', 'br', 'bl']) {
        await page.fill('#planeNodeNameInput', n);
        await page.click('#btnAddPlaneNode');
    }
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const model = P.planeModel();
        return {
            poolNames: model.pool.nodes.map(n => n.name),
            planeCount: model.planes.length,
            // THE inversion: creating nodes leaves every plane untouched.
            memberNames: window.__namesOf(P.getSelectedPlane()),
            memberRows: document.querySelectorAll('#planeMembersTable tbody tr').length,
            membersEmptyShown:
                getComputedStyle(document.getElementById('planeMembersEmpty')).display !== 'none',
            unusedRows: document.querySelectorAll('#planeNodesTable tbody tr.plane-node-unused').length,
            // …and all four are offered to + Add, which is now the ONLY way in.
            addOptions: Array.from(document.querySelectorAll('#planeAddNodeSelect option'))
                .map(o => o.textContent.split('  (')[0]),
        };
    });
    check(eq(m.poolNames, ['fl', 'fr', 'br', 'bl']),
        `+ Node puts all four in the pool (got ${JSON.stringify(m.poolNames)})`);
    check(m.planeCount === 1, `and creates no extra plane (got ${m.planeCount})`);
    check(eq(m.memberNames, []) && m.memberRows === 0 && m.membersEmptyShown,
        `the selected plane is UNTOUCHED by node creation (got ${JSON.stringify(m.memberNames)})`);
    check(m.unusedRows === 4, `all four read as unused, in no plane (got ${m.unusedRows})`);
    check(eq(m.addOptions, ['fl', 'fr', 'br', 'bl']),
        `and every one is offered to + Add (got ${JSON.stringify(m.addOptions)})`);

    // A repeated name is refused: names identify a node across planes, so a
    // second "fl" is never what was meant.
    await page.fill('#planeNodeNameInput', 'fl');
    await page.click('#btnAddPlaneNode');
    m = await page.evaluate(() => ({
        pool: window.__P.planeModel().pool.size,
        status: document.getElementById('statusText').textContent,
    }));
    check(m.pool === 4 && /already exists/i.test(m.status),
        `a duplicate node name is refused, not silently minted (pool ${m.pool}, "${m.status}")`);
    await page.fill('#planeNodeNameInput', '');

    // 3d — … and + Add is what puts them in the plane, in the order added.
    for (const n of ['fl', 'fr', 'br', 'bl']) {
        await page.selectOption('#planeAddNodeSelect', { label: n });
        await page.click('#btnAddExistingPlaneNode');
    }
    // Connect the four corners into a quad. The dropdowns carry NODE IDS now,
    // so they are driven by label — which is also what the user sees.
    for (const [s, d] of [['fl', 'fr'], ['fr', 'br'], ['br', 'bl'], ['bl', 'fl']]) {
        await page.selectOption('#planeEdgeSrcSelect', { label: s });
        await page.selectOption('#planeEdgeDstSelect', { label: d });
        await page.click('#btnAddPlaneEdge');
    }
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const plane = P.getSelectedPlane();
        const rows = Array.from(document.querySelectorAll('#planeNodesTable tbody tr'));
        return {
            name: plane.name,
            nodes: window.__namesOf(plane),
            edges: window.__edgeNames(plane),
            // Edges are stored as NODE IDS, never index pairs — an index pair
            // re-points at a neighbour the moment the pool shifts.
            edgesAreIds: plane.edges.every(e =>
                plane.nodeIds.indexOf(e[0]) >= 0 && plane.nodeIds.indexOf(e[1]) >= 0),
            poolSize: P.planeModel().pool.size,
            nodeRows: rows.length,
            // The Nodes table is the POOL and acts on the NODE only — there is
            // no membership column any more; membership is the members table.
            headers: Array.from(document.querySelectorAll('#planeNodesTable thead th'))
                .map(h => h.textContent.trim()),
            noMembershipCheckbox: document.querySelectorAll('#planeNodesTable .plane-node-member').length,
            // The selected plane's own nodes, in the plane's order.
            memberHeaders: Array.from(document.querySelectorAll('#planeMembersTable thead th'))
                .map(h => h.textContent.trim()),
            memberNames: Array.from(document.querySelectorAll('#planeMembersTable tbody tr'))
                .map(r => r.children[0].textContent.trim()),
            // Colour is shown here read-only: it is a property of the NODE and
            // is edited in one place (the Nodes table).
            memberSwatches: document.querySelectorAll('#planeMembersTable tbody .plane-member-swatch').length,
            memberColorPickers: document.querySelectorAll('#planeMembersTable input[type=color]').length,
            // The section header names the plane the controls act on.
            editorTitle: document.getElementById('planeEditorTitle').textContent,
            // Every pool node is already in this plane, so there is nothing
            // left to add — a dead dropdown would be worse than saying so.
            addDisabled: document.getElementById('planeAddNodeSelect').disabled &&
                document.getElementById('btnAddExistingPlaneNode').disabled,
            addHint: document.getElementById('planeAddNodeHint').textContent,
            edgeRows: document.querySelectorAll('#planeEdgesTable tbody tr').length,
            planeRows: document.querySelectorAll('#planeSkeletonsTable tbody tr').length,
            rowDraggable: document.querySelector('#planeSkeletonsTable tbody tr').draggable,
            // Column 0 is the expander, 1 is the name.
            rowName: document.querySelector('#planeSkeletonsTable tbody tr').children[1].textContent,
        };
    });
    check(m.name === 'floor', `name is editable (got "${m.name}")`);
    check(eq(m.nodes, ['fl', 'fr', 'br', 'bl']), `four nodes added (got ${JSON.stringify(m.nodes)})`);
    check(eq(m.edges, [['fl', 'fr'], ['fr', 'br'], ['br', 'bl'], ['bl', 'fl']]),
        `four connections added (got ${JSON.stringify(m.edges)})`);
    check(m.edgesAreIds, 'connections are stored as node IDs, not index pairs');
    check(m.poolSize === 4, `the four nodes are in the global pool (got ${m.poolSize})`);
    check(m.nodeRows === 4, `node table has 4 rows (got ${m.nodeRows})`);
    check(eq(m.headers, ['Name', 'Color', 'Pin', '3D', '']),
        `the Nodes table is the pool, with Color / Pin / 3D and NO membership column (got ${JSON.stringify(m.headers)})`);
    check(m.noMembershipCheckbox === 0,
        `no per-row "In" checkbox survives in the pool table (got ${m.noMembershipCheckbox})`);
    check(eq(m.memberHeaders, ['Name', 'Color', '']),
        `the members table is Name / Color / × (got ${JSON.stringify(m.memberHeaders)})`);
    check(eq(m.memberNames, ['fl', 'fr', 'br', 'bl']),
        `nodes put in with + Add are in the edited plane, in the order added (got ${JSON.stringify(m.memberNames)})`);
    check(m.memberSwatches === 4 && m.memberColorPickers === 0,
        `the members table shows colour read-only (got ${m.memberSwatches} swatches, ${m.memberColorPickers} pickers)`);
    check(m.editorTitle === 'floor',
        `the plane section header names the selected plane (got "${m.editorTitle}")`);
    check(m.addDisabled && /already in "floor"/.test(m.addHint),
        `with nothing left to add the control is disabled and explains itself (got "${m.addHint}")`);
    check(m.edgeRows === 4, `connection table has 4 rows (got ${m.edgeRows})`);
    check(m.planeRows === 1, `planes table has 1 row (got ${m.planeRows})`);
    check(m.rowDraggable, 'plane row is draggable');
    check(m.rowName === 'floor', `plane row is named (got "${m.rowName}")`);

    // A second plane, to prove the table lists them all.
    await page.click('#btnNewPlaneSkeleton');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        return {
            count: P.planeModel().planes.length,
            rows: document.querySelectorAll('#planeSkeletonsTable tbody tr').length,
            // The new (empty) plane must not be draggable — a drop would
            // produce an invisible placement.
            newRowDraggable: document.querySelectorAll('#planeSkeletonsTable tbody tr')[1].draggable,
            // The pool is global, so the new plane's Nodes table still lists
            // the four nodes…
            nodeRows: document.querySelectorAll('#planeNodesTable tbody tr').length,
            // …while the new plane's OWN members table is empty, and every one
            // of those four is offered by the add-an-existing-node dropdown —
            // which is what makes sharing a node reachable in one click.
            memberRows: document.querySelectorAll('#planeMembersTable tbody tr').length,
            membersEmptyShown:
                getComputedStyle(document.getElementById('planeMembersEmpty')).display !== 'none',
            addOptions: Array.from(document.querySelectorAll('#planeAddNodeSelect option'))
                .map(o => o.textContent.split('  (')[0]),
            addEnabled: !document.getElementById('btnAddExistingPlaneNode').disabled,
            editorTitle: document.getElementById('planeEditorTitle').textContent,
        };
    });
    check(m.count === 2, `second plane created (got ${m.count})`);
    check(m.rows === 2, `table lists both (got ${m.rows})`);
    check(m.newRowDraggable === false, 'a node-less plane is not draggable');
    check(m.nodeRows === 4, `the pool is shown whatever plane is selected (got ${m.nodeRows} rows)`);
    check(m.memberRows === 0 && m.membersEmptyShown,
        `a fresh plane has no members, and says so (got ${m.memberRows} rows, empty shown=${m.membersEmptyShown})`);
    check(eq(m.addOptions, ['fl', 'fr', 'br', 'bl']) && m.addEnabled,
        `every pool node not in the plane is offered for adding (got ${JSON.stringify(m.addOptions)})`);
    check(m.editorTitle !== 'floor',
        `the plane section header follows the selection (got "${m.editorTitle}")`);

    // =================================================================
    // 3e — the plane selector: it lists every plane and agrees with the table
    // =================================================================
    //
    // Two controls write the same one piece of state (`selectedPlaneId`) and
    // both re-read it on the next render, so they cannot drift; these
    // assertions are what pins that, in both directions.
    console.log('\n3e. Plane selector');
    m = await page.evaluate(() => {
        const opts = () => Array.from(document.querySelectorAll('#planeSelect option'));
        return {
            labels: opts().map(o => o.textContent),
            values: opts().map(o => o.value),
            planeNames: window.__P.planeModel().planes.map(p => p.name),
            planeIds: window.__P.planeModel().planes.map(p => String(p.id)),
        };
    });
    check(eq(m.labels.slice(0, -1), m.planeNames),
        `the dropdown lists every plane, in creation order (got ${JSON.stringify(m.labels)})`);
    check(m.labels[m.labels.length - 1] === '+ New Plane',
        `+ New Plane is pinned LAST (got ${JSON.stringify(m.labels)})`);
    check(eq(m.values.slice(0, -1), m.planeIds),
        'options carry plane IDS, so a rename only relabels them');

    // Choosing a plane in the dropdown == clicking its row, and vice versa.
    await page.selectOption('#planeSelect', { label: 'floor' });
    const viaSelect = await page.evaluate(() => ({
        selected: window.__P.planeState.selectedPlaneId,
        title: document.getElementById('planeEditorTitle').textContent,
        members: window.__namesOf(window.__P.getSelectedPlane()),
        rowSelected: document.querySelectorAll('#planeSkeletonsTable tbody tr')[0]
            .classList.contains('plane-selected'),
    }));
    check(viaSelect.title === 'floor' && eq(viaSelect.members, ['fl', 'fr', 'br', 'bl']),
        `picking a plane in the dropdown edits it (got "${viaSelect.title}")`);
    check(viaSelect.rowSelected, 'and the Planes table highlights the same row');

    await page.click('#planeSkeletonsTable tbody tr:nth-child(2)');
    m = await page.evaluate(() => ({
        selected: window.__P.planeState.selectedPlaneId,
        secondId: window.__plane(1).id,
        secondName: window.__plane(1).name,
        selectValue: document.getElementById('planeSelect').value,
        selectLabel: document.getElementById('planeSelect').selectedOptions[0].textContent,
    }));
    check(m.selected === m.secondId && m.selectValue === String(m.secondId),
        `clicking a Planes row moves the dropdown with it (got value "${m.selectValue}")`);
    check(m.selectLabel === m.secondName,
        `and the dropdown shows that plane's name (got "${m.selectLabel}" vs "${m.secondName}")`);

    // + New Plane creates AND selects, and must not stay showing as the value —
    // it is an action, not a plane.
    await page.selectOption('#planeSelect', { label: '+ New Plane' });
    m = await page.evaluate(() => {
        const P = window.__P;
        const model = P.planeModel();
        const out = {
            count: model.planes.length,
            selectedIsLast: P.planeState.selectedPlaneId ===
                model.planes[model.planes.length - 1].id,
            selectValue: document.getElementById('planeSelect').value,
            selectLabel: document.getElementById('planeSelect').selectedOptions[0].textContent,
            lastLabel: Array.from(document.querySelectorAll('#planeSelect option'))
                .pop().textContent,
            rows: document.querySelectorAll('#planeSkeletonsTable tbody tr').length,
            // The name field must be live on the new plane — that is where it
            // gets a real name, since the dropdown cannot rename anything.
            nameValue: document.getElementById('planeSkeletonName').value,
            nameEnabled: !document.getElementById('planeSkeletonName').disabled,
        };
        // Back to two planes and the first selected, for the sections below.
        P.deletePlane(model.planes[model.planes.length - 1].id);
        P.planeState.selectedPlaneId = model.planes[0].id;
        P.refreshPlanePanel();
        out.afterCleanup = model.planes.length;
        return out;
    });
    check(m.count === 3 && m.rows === 3,
        `+ New Plane creates one and lists it (got ${m.count} planes, ${m.rows} rows)`);
    check(m.selectedIsLast, 'and selects it for editing');
    check(m.selectLabel !== '+ New Plane' && m.lastLabel === '+ New Plane',
        `the dropdown falls back to the new plane and keeps + New Plane last (showing "${m.selectLabel}")`);
    check(m.nameEnabled && m.nameValue === m.selectLabel,
        `the Name field is live and carries the same name (got "${m.nameValue}")`);
    check(m.afterCleanup === 2, 'cleanup left two planes for the sections below');

    // Re-select the first one for the drop tests.
    await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        P.planeState.selectedPlaneId = P.planeModel().planes[0].id;
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
        const placed = P.placedPlanesOn('camA');
        const out = {
            n: placed.length,
            // dockview must NOT have turned the drag into a new video panel.
            views: Array.from(document.querySelectorAll('.video-cell[data-view-name]'))
                .map(el => el.getAttribute('data-view-name')).sort(),
        };
        // Clear it again so the per-view assertions below start from zero.
        placed.forEach(p => P.unplacePlaneFromView(p, 'camA'));
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
        const plane = window.__plane(0);
        const view = AS.state.views.find(v => v.name === 'camB');
        const rect = view.overlayCanvas.getBoundingClientRect();
        // Drop dead-centre of camB's canvas.
        const p = P.handlePlaneDrop(
            plane.id, 'camB',
            rect.left + rect.width / 2, rect.top + rect.height / 2);
        const pts = p && window.__getPts(plane, 'camB');
        const cx = pts.reduce((a, q) => a + q[0], 0) / pts.length;
        const cy = pts.reduce((a, q) => a + q[1], 0) / pts.length;
        return {
            placed: !!p,
            isPlaneInstance: !!p && p.constructor.name === 'PlaneInstance',
            type: p && p.type,
            viewName: p && p.viewName,
            nPoints: pts && pts.length,
            // ONE instance per VIEW, covering the whole pool — not one per
            // (view, plane): a node shared by two planes must have one 2D point.
            instanceIsShared: P.getPlaneInstance('camB') === p,
            poolSized: p && p.numNodes === P.planeModel().pool.size,
            allInFrame: pts && pts.every(q => q && q[0] >= 0 && q[0] <= 640 && q[1] >= 0 && q[1] <= 480),
            // Seeded around the drop point, so the centroid lands near centre.
            centroid: [Math.round(cx), Math.round(cy)],
            // Distinct positions — a degenerate all-same-point seed would draw
            // as a dot and be useless to annotate from.
            distinct: pts && new Set(pts.map(q => q.join(','))).size,
            onCamA: P.placedPlanesOn('camA').length,
            onCamB: P.placedPlanesOn('camB').length,
            // Placements live in the plane row's expander, not a table.
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
    check(m.nPoints === 4, `the plane has one point per node (got ${m.nPoints})`);
    check(m.instanceIsShared && m.poolSized,
        'a view has ONE instance, indexed by the whole node pool');
    check(m.allInFrame, 'every seeded point is inside the frame');
    check(m.distinct === 4, `seeded points are distinct (got ${m.distinct})`);
    check(Math.abs(m.centroid[0] - 320) <= 4 && Math.abs(m.centroid[1] - 240) <= 4,
        `seed is centred on the drop point (got ${JSON.stringify(m.centroid)})`);
    check(m.onCamA === 0, 'the other view gets nothing');
    check(m.onCamB === 1, 'the dropped-on view has exactly one plane placed');
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
        const plane = window.__plane(0);
        const before = window.__getPts(plane, 'camB');
        const view = AS.state.views.find(v => v.name === 'camB');
        const rect = view.overlayCanvas.getBoundingClientRect();
        // Drop somewhere clearly different from the first drop.
        const p = P.handlePlaneDrop(plane.id, 'camB',
            rect.left + rect.width * 0.2, rect.top + rect.height * 0.2);
        return {
            refused: p === null,
            count: P.placedPlanesOn('camB').length,
            unchanged: JSON.stringify(before) ===
                JSON.stringify(window.__getPts(plane, 'camB')),
            status: document.getElementById('statusText').textContent,
        };
    });
    check(m.refused, 'a second drop of the same plane on the same view is refused');
    check(m.count === 1, `still exactly one plane placed on that view (got ${m.count})`);
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
            firstId: P.planeModel().planes[0].id,
        };
    });
    check(!m.keys.includes('text/plain'),
        `dragstart sets no text/plain (would be eaten by dockview; got ${JSON.stringify(m.keys)})`);
    check(eq(m.keys, [m.mime]), `dragstart sets only ${m.mime}`);
    check(m.payload === String(m.firstId), `payload is the plane id (got "${m.payload}")`);

    // =================================================================
    // 7 — per-node colour, scoped to the NODE
    // =================================================================
    console.log('\n7. Per-node colour');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const R = await import('/ui/rendering.js');
        const AS = await import('/ui/app-state.js');
        const rows = Array.from(document.querySelectorAll('#planeNodesTable tbody tr'));
        const pickers = rows.map(r => r.querySelector('input[type=color]'));
        const plane = window.__plane(0);
        const pool = P.planeModel().pool;

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
            defaultsDistinct: new Set(pool.colors()).size,
            defaultFirst: pickers[0] ? pickers[0].value : null,
        };

        // Recolour node 0 to a colour nothing else uses, and confirm it lands
        // on the canvas.
        const TARGET = '#00ff00';
        R.drawAllOverlays(AS.state.currentFrame);
        out.beforeCount = countColor('camB', TARGET);
        pickers[0].value = TARGET;
        pickers[0].dispatchEvent(new Event('change', { bubbles: true }));
        out.modelColor = pool.nodeAt(0).color;
        out.afterCount = countColor('camB', TARGET);

        // Scoped to the NODE: place the same plane on camA and it must be the
        // same colour there too.
        const view = AS.state.views.find(v => v.name === 'camA');
        const rect = view.overlayCanvas.getBoundingClientRect();
        P.handlePlaneDrop(plane.id, 'camA',
            rect.left + rect.width / 2, rect.top + rect.height / 2);
        R.drawAllOverlays(AS.state.currentFrame);
        out.camACount = countColor('camA', TARGET);

        // A node REMOVAL must not disturb any other node's colour. (The old
        // parallel `nodeColors` array is gone — the colour lives on the node —
        // so this is the same invariant stated against the new model: nothing
        // shifts under a deletion.)
        const colorsBefore = pool.nodes.map(n => n.color);
        const removedName = pool.nodeAt(0).name;
        P.planeModel().deleteNode(pool.nodeAt(0).id);
        out.survivingColors = pool.nodes.map(n => n.color);
        out.wantSurviving = colorsBefore.slice(1);
        // Restore for the sections below, with its original colour and place in
        // the plane's order.
        const restored = P.planeModel().createNodeInPlane(removedName, plane, {
            color: colorsBefore[0],
        });
        plane.moveNode(plane.indexOfNode(restored.id), 0);
        return out;
    });
    check(m.pickerCount === 4, `every node row has a colour picker (got ${m.pickerCount})`);
    check(m.defaultsDistinct === 4, `default node colours are distinct (got ${m.defaultsDistinct} unique)`);
    check(/^#[0-9a-f]{6}$/.test(m.defaultFirst || ''), `picker shows the node's colour (got "${m.defaultFirst}")`);
    check(m.modelColor === '#00ff00', `editing the picker updates the model (got "${m.modelColor}")`);
    check(m.beforeCount === 0 && m.afterCount > 0,
        `the new colour is drawn (${m.beforeCount} px -> ${m.afterCount} px)`);
    check(m.camACount > 0,
        `the colour is per-NODE, so it applies on another view too (got ${m.camACount} px)`);
    check(eq(m.survivingColors, m.wantSurviving),
        'deleting a node leaves every other node its own colour');

    // =================================================================
    // 8 — the placements dropdown on each plane row
    // =================================================================
    console.log('\n8. Placements dropdown');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const sk = window.__plane(0);
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
        const sk0 = window.__plane(0);
        window.__setPts(sk0, 'camB', [[200, 200], [400, 200], [400, 350], [200, 350]]);

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

        // ONE shared value: it is not stored per plane.
        out.notPerSkeleton = P.planeModel().planes.every(s => s.nodeSize === undefined);
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
    check(m.notPerSkeleton, 'the values are shared, not stored per plane');
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
        const sk = window.__plane(0);
        const cams = AS.state.session.cameras;
        const idx = window.__poolIdx(sk);

        // Put the two placements on the exact reprojections of a known 3D
        // quad, so a correct solve must recover it to sub-pixel accuracy.
        const TRUTH = [[-40, -30, 220], [40, -30, 225], [45, 25, 230], [-45, 25, 215]];
        ['camA', 'camB'].forEach(name => {
            const cam = cams.find(c => c.name === name);
            // `project` is the ideal (undistorted) projection; these cameras
            // have zero distortion, so it matches what the app would render.
            window.__setPts(sk, name, TRUTH.map(q => cam.project(q)));
            P.getPlaneInstance(name).nulledNodes.clear();
        });

        const out = {};
        // The button is the real entry point.
        const triBtn = document.getElementById('btnPlaneTriangulate');
        out.btnEnabled = !triBtn.disabled;
        triBtn.click();

        const pts = () => P.planePoints3d(sk);
        out.hasPoints3d = window.__nodesOf(sk).some(n => n.hasPoint3d());
        out.tri = sk.triangulation && {
            views: sk.triangulation.views.slice(),
            nNodes: sk.triangulation.nNodes,
            meanError: sk.triangulation.meanError,
        };
        // The 3D lives on the NODES, and `planePoints3d` is only a view of it.
        out.on3dNodes = window.__nodesOf(sk).map(n => n.getPoint3d());
        out.recovered = TRUTH.map((_, k) =>
            pd.hasPoint3d(pts(), k) ? Array.from(pd.getPoint3d(pts(), k)) : null);
        out.truth = TRUTH;
        out.status = document.getElementById('statusText').textContent;
        // Result is surfaced, not silent.
        out.autoExpanded = P.planeState.expanded.has(sk.id);
        out.summaryShown = !!document.querySelector('.plane-tri-summary');
        out.nodeLines = document.querySelectorAll('.plane-tri-node').length;

        // A node toggled OFF in one view leaves only one observation, so that
        // node must drop out of the solve rather than be silently invented.
        P.getPlaneInstance('camA').toggleNodeNull(idx[0]);
        triBtn.click();
        out.afterNullNodes = sk.triangulation.nNodes;
        out.node0Gone = !pd.hasPoint3d(pts(), 0);
        P.getPlaneInstance('camA').toggleNodeNull(idx[0]);

        // Editing the 2D must invalidate the now-stale solve — of the node that
        // moved, and of the fit that stood on it. Its neighbours keep their 3D:
        // the edit says nothing about them, and a node's 3D is the node's.
        triBtn.click();
        const before = window.__nodesOf(sk).map(n => n.hasPoint3d());
        P.getPlaneInstance('camB').setPoint(idx[2], 10, 10);
        AS.interactionManager.callbacks.onPlaneChanged(
            P.getPlaneInstance('camB'), [idx[2]]);
        out.invalidated = before.every(Boolean) &&
            !window.__nodesOf(sk)[2].hasPoint3d();
        out.neighboursKept = window.__nodesOf(sk)
            .filter((_, k) => k !== 2).every(n => n.hasPoint3d());
        out.summaryCleared = sk.triangulation === null;
        return out;
    });
    check(m.btnEnabled, 'the triangulate button is enabled with 2 views placed');
    check(m.hasPoints3d, 'triangulating produces 3D');
    check(m.on3dNodes && m.on3dNodes.every(Boolean),
        'the 3D is stored on the NODES, not on the plane');
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
    check(m.invalidated, 'editing the 2D clears that node\'s now-stale 3D');
    check(m.neighboursKept, 'and only that node\'s — its neighbours keep theirs');
    check(m.summaryCleared, 'the plane\'s solve summary and fit go with it');

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
        P.planeState.selectedPlaneId = P.planeModel().planes[0].id;
        P.refreshPlanePanel();
        out.enabledWhenSelected = btns().every(b => !b.disabled);
        // No selection -> greyed out.
        P.planeState.selectedPlaneId = null;
        P.refreshPlanePanel();
        out.disabledWhenNone = btns().every(b => b.disabled);
        out.titleWhenNone = document.getElementById('btnPlaneFit').title;
        // …and the whole Edit Plane body empty-states, rather than
        // offering a name field and an add-node dropdown with nothing to act on.
        out.editorEmptyShown =
            getComputedStyle(document.getElementById('planeEditorEmpty')).display !== 'none';
        out.editorContentHidden =
            getComputedStyle(document.getElementById('planeEditorContent')).display === 'none';
        out.editorTitleWhenNone = document.getElementById('planeEditorTitle').textContent;
        out.nameDisabled = document.getElementById('planeSkeletonName').disabled;
        out.memberRowsWhenNone = document.querySelectorAll('#planeMembersTable tbody tr').length;
        out.addDisabledWhenNone = document.getElementById('btnAddExistingPlaneNode').disabled;
        // The pool is NOT gated on a selection — nodes exist without a plane.
        out.poolStillListed = document.querySelectorAll('#planeNodesTable tbody tr').length;
        P.planeState.selectedPlaneId = P.planeModel().planes[0].id;
        P.refreshPlanePanel();
        return out;
    });
    check(m.allExist, 'Triangulate / Fill / Fit all exist');
    check(m.noneInTable, 'they are no longer per-row buttons inside the table');
    check(m.belowTable, 'they sit below the Planes table');
    check(eq(m.labels, ['Triangulate', 'Fill', 'Fit']),
        `labelled Triangulate / Fill / Fit (got ${JSON.stringify(m.labels)})`);
    check(m.enabledWhenSelected, 'all three are enabled when a plane skeleton is selected');
    check(m.disabledWhenNone, 'all three are greyed out when none is selected');
    check(/Select a plane/.test(m.titleWhenNone),
        `the disabled state explains itself (got "${m.titleWhenNone}")`);
    check(m.editorEmptyShown && m.editorContentHidden && m.nameDisabled &&
        m.memberRowsWhenNone === 0 && m.addDisabledWhenNone,
        'with no plane selected the Edit Plane body empty-states instead of showing dead controls');
    check(/none selected/i.test(m.editorTitleWhenNone),
        `and its header says so (got "${m.editorTitleWhenNone}")`);
    check(m.poolStillListed > 0,
        `the Nodes pool is NOT gated on a plane selection (got ${m.poolStillListed} rows)`);

    // =================================================================
    // 10c — Triangulate shows the plane in the 3D viewer
    // =================================================================
    console.log('\n10c. Plane appears in the 3D viewer');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const AS = await import('/ui/app-state.js');
        const sk = window.__plane(0);
        const cams = AS.state.session.cameras;
        // Section 7's node deletion dropped the two edges that touched node 0.
        // Restore the full ring so this and the sections below work on a real
        // closed quad rather than an open chain. Edges are NODE ID pairs.
        sk.edges = [];
        for (let k = 0; k < 4; k++) sk.addEdge(sk.nodeIds[k], sk.nodeIds[(k + 1) % 4]);
        const TRUTH = [[-40, -30, 220], [40, -30, 225], [45, 25, 230], [-45, 25, 215]];
        ['camA', 'camB'].forEach(name => {
            const cam = cams.find(c => c.name === name);
            window.__setPts(sk, name, TRUTH.map(q => cam.project(q)));
            P.getPlaneInstance(name).nulledNodes.clear();
        });

        const vp = AS.viewport3d;
        const out = { hasViewport: !!vp, hasApi: !!(vp && vp.setPlanes) };
        if (!vp) return out;

        // The plane group must be a SIBLING of the skeleton group, or the
        // per-frame updateSkeleton clear would wipe it.
        out.groupNames = vp.scene.children.filter(c => c.type === 'Group').map(c => c.name);
        // Section 10's 2D edit only invalidated the node it touched (a node's
        // 3D is the node's), so the plane is still in the scene. Clear it
        // outright to restore this section's precondition.
        P.planeModel().invalidatePlane3D(sk);
        P.syncPlanes3D();
        out.planeGroupEmptyBefore = vp._planeGroup.children.length === 0;

        document.getElementById('btnPlaneTriangulate').click();
        out.planeGroupAfter = vp._planeGroup.children.length;
        const g = vp._planeGroup.children[0];
        out.groupName = g && g.name;
        out.nodeMeshes = g ? g.children.filter(c => c.name.startsWith('planeNode_')).length : 0;
        out.edgeMeshes = g ? g.children.filter(c => c.name.startsWith('planeEdge_')).length : 0;
        out.wantNodes = sk.nodeIds.length;
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

        // Invalidating the 3D drops it from the scene. `clearTriangulation`
        // alone no longer does that — it clears the plane's SOLVE RESULTS and
        // deliberately cannot touch node 3D (a pinned coordinate must survive
        // an invalidation cascade), so the plane is still drawable from its
        // nodes. Dropping the points is `invalidatePlane3D`.
        sk.clearTriangulation();
        P.syncPlanes3D();
        out.afterClearSummary = vp._planeGroup.children.length;
        P.planeModel().invalidatePlane3D(sk);
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
    check(m.afterClearSummary === 1,
        'clearing a plane\'s solve summary does NOT destroy its nodes\' 3D');
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
        const sk = window.__plane(0);
        const cams = AS.state.session.cameras;
        const pts = () => P.planePoints3d(sk);

        // A deliberately NON-planar quad: three corners on z=220, one pushed
        // 6 mm off. Fit must flatten it.
        const RAW = [[-40, -30, 220], [40, -30, 220], [45, 25, 220], [-45, 25, 226]];
        ['camA', 'camB'].forEach(name => {
            const cam = cams.find(c => c.name === name);
            window.__setPts(sk, name, RAW.map(q => cam.project(q)));
            P.getPlaneInstance(name).nulledNodes.clear();
        });
        document.getElementById('btnPlaneTriangulate').click();

        const before2d = window.__getPts(sk, 'camA');
        const beforeFit = T.fitPlaneToPoints3d(pts());
        const out = { rmsBefore: beforeFit.rms };

        document.getElementById('btnPlaneFit').click();

        out.hasFit = !!sk.planeFit;
        out.fitNormal = sk.planeFit && sk.planeFit.normal.slice();
        out.fitRms = sk.planeFit && sk.planeFit.rms;
        // With nothing pinned this MUST be the unconstrained fit — routing the
        // free case through the constrained solver would move floats for no
        // reason and quietly change every number below.
        out.unconstrained = !!sk.planeFit && !sk.planeFit.constrained;

        // Every corner must now lie ON the fitted plane.
        let worst = 0;
        for (let k = 0; k < 4; k++) {
            const q = pd.getPoint3d(pts(), k);
            const c = sk.planeFit.centroid, nv = sk.planeFit.normal;
            worst = Math.max(worst, Math.abs(
                (q[0] - c[0]) * nv[0] + (q[1] - c[1]) * nv[1] + (q[2] - c[2]) * nv[2]));
        }
        out.worstResidual = worst;
        // …and a re-fit of the flattened points has ~zero RMS.
        out.rmsAfter = T.fitPlaneToPoints3d(pts()).rms;

        // The 2D must have MOVED to match, in every placed view.
        const after2d = window.__getPts(sk, 'camA');
        out.moved2dA = Math.max(...after2d.map((q, k) =>
            Math.hypot(q[0] - before2d[k][0], q[1] - before2d[k][1])));
        // And the 2D must be the exact reprojection of the corrected 3D.
        let worst2d = 0;
        ['camA', 'camB'].forEach(name => {
            const cam = cams.find(c => c.name === name);
            const q2 = window.__getPts(sk, name);
            for (let k = 0; k < 4; k++) {
                const uv = T.reprojectPointCamera(pd.getPoint3d(pts(), k), cam);
                worst2d = Math.max(worst2d, Math.hypot(uv[0] - q2[k][0], uv[1] - q2[k][1]));
            }
        });
        out.worst2dMismatch = worst2d;

        // The 3D viewer must have been updated, not left showing the old cloud.
        const vp = AS.viewport3d;
        const g = vp._planeGroup.children[0];
        const n3 = g && g.children.find(c => c.name === 'planeNode_3');
        const q3 = pd.getPoint3d(pts(), 3);
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
    check(m.unconstrained, 'with nothing pinned it takes the unconstrained path');
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
        const sk = window.__plane(0);
        const pts = () => P.planePoints3d(sk);
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
            const p = pd.getPoint3d(pts(), k);
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
        const before3d = Array.from(pd.getPoint3d(pts(), K));
        const otherBefore = Array.from(pd.getPoint3d(pts(), 0));
        const before2dA = window.__getPts(sk, 'camA')[K].slice();
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
        const mid3d = Array.from(pd.getPoint3d(pts(), K));
        out.movedDuringDrag = Math.hypot(
            mid3d[0] - before3d[0], mid3d[1] - before3d[1], mid3d[2] - before3d[2]);

        fire('pointerup', start.x + 70, start.y + 45);
        out.released = vp._planeDrag === null;
        out.controlsBackOn = vp.controls.enabled === true;

        const after3d = Array.from(pd.getPoint3d(pts(), K));
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
        const otherAfter = Array.from(pd.getPoint3d(pts(), 0));
        out.otherNodeStill = otherBefore.every((v, i) => v === otherAfter[i]);

        // The 2D in every placed view follows the 3D, exactly.
        const after2dA = window.__getPts(sk, 'camA')[K];
        out.moved2d = Math.hypot(after2dA[0] - before2dA[0], after2dA[1] - before2dA[1]);
        let worst2d = 0;
        ['camA', 'camB'].forEach(name => {
            const cam = AS.state.session.cameras.find(x => x.name === name);
            const q2 = window.__getPts(sk, name)[K];
            const uv = T.reprojectPointCamera(pd.getPoint3d(pts(), K), cam);
            worst2d = Math.max(worst2d, Math.hypot(uv[0] - q2[0], uv[1] - q2[1]));
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
        const beforeUnfit = Array.from(pd.getPoint3d(pts(), K));
        fire('pointerdown', s2.x, s2.y);
        out.unfitNotGrabbed = !vp._planeDrag;
        fire('pointermove', s2.x + 70, s2.y + 45);
        fire('pointerup', s2.x + 70, s2.y + 45);
        out.unfitUnmoved = beforeUnfit.every((v, i) => v === pd.getPoint3d(pts(), K)[i]);

        // --- and so is a fitted plane outside Defining Plane Mode ---
        sk.planeFit = fitSaved;
        P.exitPlaneMode();
        out.outsideModeNotEditable = nodeMeshes().every(c2 => c2.userData.planeEditable !== true);
        P.enterPlaneMode();
        P.planeState.selectedPlaneId = sk.id;
        P.refreshPlanePanel();
        out.backInModeEditable = nodeMeshes().every(c2 => c2.userData.planeEditable === true);

        // --- RULE 3: a PINNED corner is inert even on a fitted, editable
        // plane. The viewport marks draggability per PLANE, so this is enforced
        // by the drag callback; blocking it must be visible, not silent.
        const pinnedNode = window.__nodesOf(sk)[K];
        pinnedNode.immutable = true;
        const beforePin = Array.from(pd.getPoint3d(pts(), K));
        const s3 = screenOf(K);
        fire('pointerdown', s3.x, s3.y);
        fire('pointermove', s3.x + 70, s3.y + 45);
        fire('pointerup', s3.x + 70, s3.y + 45);
        out.pinnedUnmoved3d = beforePin.every((v, i) => v === pd.getPoint3d(pts(), K)[i]);
        out.pinnedStatus = document.getElementById('statusText').textContent;
        pinnedNode.immutable = false;
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
    check(m.pinnedUnmoved3d, 'a PINNED corner cannot be dragged in the 3D viewport');
    check(/pinned/i.test(m.pinnedStatus || ''),
        `and the refusal says why (got "${m.pinnedStatus}")`);

    // =================================================================
    // 11 — fill the polygon
    // =================================================================
    console.log('\n11. Polygon fill');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const R = await import('/ui/rendering.js');
        const AS = await import('/ui/app-state.js');
        const sk = window.__plane(0);
        // A convex quad whose INTERIOR we can sample.
        window.__setPts(sk, 'camB', [[200, 200], [400, 200], [400, 350], [200, 350]]);

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

        // Polygon order follows the CONNECTIONS, not membership order — a quad
        // linked 0-2-1-3 is a bowtie if you fill it in membership order. Edges
        // are NODE ID pairs; the reported order is still LOCAL indices.
        const bow = window.__plane(0);
        const id = (k) => bow.nodeIds[k];
        const savedEdges = bow.edges.map(e => e.slice());
        bow.edges = [[id(0), id(2)], [id(2), id(1)], [id(1), id(3)], [id(3), id(0)]];
        out.cycleOrder = P.planePolygonOrder(bow);
        bow.edges = [[id(0), id(1)], [id(1), id(2)]];   // open chain — no cycle
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
        `an open chain falls back to membership order (got ${JSON.stringify(m.chainOrder)})`);
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
        const sk = window.__plane(0);
        // Un-place camA so only camB is in play.
        P.unplacePlaneFromView(sk, 'camA');
        window.__setPts(sk, 'camB', [[200, 200], [400, 200], [400, 350], [200, 350]]);
        P.getPlaneInstance('camB').nulledNodes.clear();
        P.planeState.expanded.add(sk.id);
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
            unmoved: eq2(window.__getPts(window.__plane(0), 'camB')[0], [200, 200]),
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
        return {
            pts: window.__getPts(window.__plane(0), 'camB').map(q => q.map(Math.round)),
            modified: P.getPlaneInstance('camB').modified,
        };
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
        return { pts: window.__getPts(window.__plane(0), 'camB').map(q => q.map(Math.round)) };
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
        const p = P.getPlaneInstance('camB');
        const idx = window.__poolIdx(window.__plane(0));
        return { nulled: p.isNodeNulled(idx[1]), usable: p.hasAnyUsablePoint(), n: p.nulledNodes.size };
    });
    check(m.nulled, 'right-click toggles a plane node off');
    check(m.n === 1, `only that one node is off (got ${m.n})`);
    check(m.usable, 'the plane still has usable points for a later solve');
    await page.mouse.click(rc[0], rc[1], { button: 'right' });
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const idx = window.__poolIdx(window.__plane(0));
        return { nulled: P.getPlaneInstance('camB').isNodeNulled(idx[1]) };
    });
    check(!m.nulled, 'right-clicking again toggles it back on');

    // 8e — THE MODE GATE. Outside Defining Plane Mode the identical drag must
    // do nothing, so plane nodes never compete with pose nodes for a click.
    // Baseline is read from the live placement rather than hardcoded: the
    // drags above land within the deadzone tolerance, not on exact integers.
    const gateBefore = await page.evaluate(async () => {
        return window.__getPts(window.__plane(0), 'camB')[1];
    });
    await page.click('#planeModeExit');
    const gFrom = await toClient('camB', gateBefore[0], gateBefore[1]);
    const gTo = await toClient('camB', 500, 300);
    await page.mouse.move(gFrom[0], gFrom[1]);
    await page.mouse.down();
    await page.mouse.move(gTo[0], gTo[1], { steps: 8 });
    await page.mouse.up();
    m = await page.evaluate(async (gb) => {
        const AS = await import('/ui/app-state.js');
        const im = AS.interactionManager;
        return {
            pt1: window.__getPts(window.__plane(0), 'camB')[1],
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
    // 13 — the per-view 2D stays in sync with the node pool
    // =================================================================
    console.log('\n13. The 2D tracks the node pool');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const sk = window.__plane(0);
        const pool = P.planeModel().pool;
        P.planeState.selectedPlaneId = sk.id;
        P.refreshPlanePanel();
        const before = P.getPlaneInstance('camB').toPointsArray();

        // Mint a node: the view's instance grows by one column, but the node is
        // in NO plane yet so it is unpositioned and invisible.
        document.getElementById('planeNodeNameInput').value = 'centre';
        document.getElementById('btnAddPlaneNode').click();
        const afterAdd = P.getPlaneInstance('camB').toPointsArray();
        const centre = pool.nodes.find(n => n.name === 'centre');
        const addedIdx = pool.indexOf(centre.id);
        const mintTouchedNoPlane = !sk.hasNode(centre.id);
        const unpositionedWhileUnused = afterAdd[addedIdx] === null;

        // + Add is what puts it in the plane — and because the plane is PLACED
        // here, that is what seeds a REAL position (an unpositioned node draws
        // nothing, so the user would have no way to grab it and place it).
        document.getElementById('planeAddNodeSelect').value = String(centre.id);
        document.getElementById('btnAddExistingPlaneNode').click();
        const afterJoin = P.getPlaneInstance('camB').toPointsArray();

        // Delete a node from the POOL: every view's 2D must splice at the SAME
        // index, and the plane's edges through it must go with it.
        const goneId = sk.nodeIds[0];
        const goneIdx = pool.indexOf(goneId);
        const edgesTouching = sk.edges.filter(e => e[0] === goneId || e[1] === goneId).length;
        P.planeModel().deleteNode(goneId);
        const afterRemove = P.getPlaneInstance('camB').toPointsArray();

        const out = {
            beforeLen: before.length,
            afterAddLen: afterAdd.length,
            mintTouchedNoPlane: mintTouchedNoPlane,
            unpositionedWhileUnused: unpositionedWhileUnused,
            newPointPositioned: !!afterJoin[addedIdx] && Number.isFinite(afterJoin[addedIdx][0]),
            afterRemoveLen: afterRemove.length,
            poolSize: pool.size,
            goneIdx: goneIdx,
            edgesTouchingBefore: edgesTouching,
            // The surviving points are the old ones with that index spliced out.
            splicedCorrectly: JSON.stringify(afterRemove) ===
                JSON.stringify(afterJoin.filter((_, i) => i !== goneIdx)),
            // Edges are ID pairs, so "in range" means "still names live nodes".
            edgesLive: sk.edges.every(e => pool.has(e[0]) && pool.has(e[1])),
            edgesDropped: sk.edges.every(e => e[0] !== goneId && e[1] !== goneId),
            membershipDropped: !sk.hasNode(goneId),
        };

        // Deleting the PLANE un-places it everywhere — but keeps its nodes.
        // Nodes are plane-independent now: a node outliving its plane is a
        // valid pool member, and auto-pruning it would throw away a pinned
        // coordinate or a positioned 2D point as a side effect of tidying up.
        const nodesBefore = pool.size;
        const nodeIdsBefore = sk.nodeIds.slice();
        P.deletePlane(sk.id);
        P.refreshPlanePanel();
        out.planesAfterDelete = P.planeModel().planes.length;
        out.placedAfterDelete = P.placedPlanesOn('camB').length;
        out.placementRowsAfterDelete = document.querySelectorAll('.plane-placement-item').length;
        out.poolAfterDelete = pool.size;
        out.nodesKept = nodeIdsBefore.every(id => pool.has(id));
        out.nodesBefore = nodesBefore;
        // …and they are still listed and editable, which is the only place they
        // can now be destroyed.
        out.nodeRowsAfterDelete = document.querySelectorAll('#planeNodesTable tbody tr').length;
        out.visibleAfterDelete = P.planeModel().visibleNodeIndices('camB').length;
        return out;
    });
    check(m.afterAddLen === m.beforeLen + 1, `minting a node grows the view's 2D (${m.beforeLen} -> ${m.afterAddLen})`);
    check(m.mintTouchedNoPlane, 'and + Node still leaves the placed plane alone');
    check(m.unpositionedWhileUnused,
        'a node in no plane has no position anywhere — nothing draws it yet');
    check(m.newPointPositioned,
        '+ Add into a PLACED plane seeds a real position, not an unreachable null');
    check(m.afterRemoveLen === m.poolSize, `2D length tracks the pool (${m.afterRemoveLen} vs ${m.poolSize})`);
    check(m.splicedCorrectly, 'deleting a node splices every view\'s 2D at the same index');
    check(m.edgesTouchingBefore > 0 && m.edgesDropped,
        `the edges through a deleted node go with it (${m.edgesTouchingBefore} of them)`);
    check(m.edgesLive, 'every surviving connection still names live nodes');
    check(m.membershipDropped, 'and the plane no longer references it');
    check(m.planesAfterDelete === 1, `deleting a plane removes it (got ${m.planesAfterDelete} left)`);
    check(m.placedAfterDelete === 0, `it is un-placed from every view (got ${m.placedAfterDelete})`);
    check(m.placementRowsAfterDelete === 0, 'the expanded placement list empties too');
    check(m.visibleAfterDelete === 0, 'and nothing of it is drawable on the view any more');
    check(m.poolAfterDelete === m.nodesBefore && m.nodesKept,
        `deleting a plane KEEPS its nodes (pool ${m.nodesBefore} -> ${m.poolAfterDelete})`);
    check(m.nodeRowsAfterDelete === m.poolAfterDelete,
        `the Nodes table still lists them, so they can be managed (got ${m.nodeRowsAfterDelete} rows)`);

    // =================================================================
    // 14 — Set Origin Mode: pick a corner, pick a +Z, get the transform
    // =================================================================
    console.log('\n14. Set Origin Mode');

    // Section 13 deleted the annotated plane, so build a fresh fitted one.
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

        const sk = P.createPlane('bench');
        ['a', 'b', 'c', 'd'].forEach(n => P.planeModel().createNodeInPlane(n, sk));
        for (let k = 0; k < 4; k++) sk.addEdge(sk.nodeIds[k], sk.nodeIds[(k + 1) % 4]);
        P.planeState.selectedPlaneId = sk.id;
        ['camA', 'camB'].forEach(name => {
            const cam = cams.find(c => c.name === name);
            const view = AS.state.views.find(v => v.name === name);
            P.placePlaneOnView(sk, name, view.videoWidth / 2, view.videoHeight / 2);
            window.__setPts(sk, name, TRUTH.map(q => cam.project(q)));
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

    // The lock disables BUTTONS; the plane selector and the name field are not
    // buttons, so they are refused in their own handlers. Both would otherwise
    // run a full panel rebuild, which re-enables the very buttons the lock just
    // turned off — a locked UI that silently unlocks itself.
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const before = P.planeModel().planes.length;
        const sel = document.getElementById('planeSelect');
        sel.value = 'new';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        const out = {
            before, after: P.planeModel().planes.length,
            selValue: sel.value,
            selStatus: document.getElementById('statusText').textContent,
        };
        const name = document.getElementById('planeSkeletonName');
        const wasNamed = P.getSelectedPlane().name;
        name.value = 'renamed-under-the-lock';
        name.dispatchEvent(new Event('change', { bubbles: true }));
        out.nameKept = P.getSelectedPlane().name === wasNamed;
        out.fieldRestored = name.value === wasNamed;
        out.stillLocked = ['btnSetOrigin', 'btnPlaneFit', 'btnPlaneTriangulate',
            'btnNewPlaneSkeleton'].every(id => document.getElementById(id).disabled);
        return out;
    });
    check(m.after === m.before && m.selValue !== 'new',
        `the plane selector cannot mint a plane under the lock (${m.before} -> ${m.after})`);
    check(m.nameKept && m.fieldRestored, 'and the name field cannot rename one');
    check(/Set Origin Mode/.test(m.selStatus), `both say why (got "${m.selStatus}")`);
    check(m.stillLocked, 'and neither rebuild re-enables the locked buttons');

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
        const sk = P.planeModel().planes[P.planeModel().planes.length - 1];

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
        const target = toScreen(pd.getPoint3d(P.planePoints3d(sk), K));
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
        const skA = P.planeModel().planes[P.planeModel().planes.length - 1];
        const ptsA = P.planePoints3d(skA);
        const o = O.originState.originPoint, n = O.originState.normal;
        let far = 0;
        for (let k = 0; k < skA.nodeIds.length; k++) {
            const q = pd.getPoint3d(ptsA, k);
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
        const ptsAfter = P.planePoints3d(sk);
        out.worstZ = 0;
        for (let k = 0; k < sk.nodeIds.length; k++) {
            const q = OF.applyOriginFrame(f, Array.from(pd.getPoint3d(ptsAfter, k)));
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
        out.planeStillAtWorld = Math.abs(pd.getPoint3d(ptsAfter, 0)[2] - 220) < 0.01;

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
        const sk = P.planeModel().planes[P.planeModel().planes.length - 1];
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

    // =================================================================
    // 15 — TWO PLANES SHARING NODES (the reason the pool exists)
    // =================================================================
    //
    // Two walls meeting along a line. The corners on that line are ONE node
    // each: one 3D position, one 2D point per view. If they were duplicated per
    // plane, the line would split apart the moment either wall was re-solved —
    // and it would do so silently, which is why this is pinned here.
    console.log('\n15. Two planes sharing an intersection line');

    // shared line at x=0, y in [0,40], z=200. A is flat (z=200); B is tilted.
    const TRUTH15 = {
        s0: [0, 0, 200], s1: [0, 40, 200],
        a0: [-50, 0, 200], a1: [-50, 40, 200],
        b0: [50, 0, 180], b1: [50, 40, 180],
    };
    m = await page.evaluate(async (T) => {
        const P = await import('/ui/plane-definition.js');
        const AS = await import('/ui/app-state.js');
        const model = P.planeModel();
        const cams = AS.state.session.cameras;
        const out = {};

        // Clear the stage: un-place everything so only the two new walls draw.
        model.planes.forEach(p => model.placedViews(p)
            .forEach(v => P.unplacePlaneFromView(p, v)));

        const poolBefore = model.pool.size;
        const A = P.createPlane('wallA');
        const B = P.createPlane('wallB');
        const node = {};
        // A owns a0/a1 and MINTS the two shared corners…
        ['a0', 's0', 's1', 'a1'].forEach(n => { node[n] = model.createNodeInPlane(n, A); });
        // …and B REFERENCES those same two, which is the whole point.
        node.b0 = model.createNodeInPlane('b0', B);
        model.addNodeToPlane(B, node.s0.id);
        model.addNodeToPlane(B, node.s1.id);
        node.b1 = model.createNodeInPlane('b1', B);
        [A, B].forEach(pl => {
            for (let k = 0; k < 4; k++) pl.addEdge(pl.nodeIds[k], pl.nodeIds[(k + 1) % 4]);
        });
        out.aNames = window.__namesOf(A);
        out.bNames = window.__namesOf(B);
        // Two 4-node walls sharing two corners need SIX new nodes, not eight.
        // A delta, because earlier sections left their own nodes in the pool
        // (deleting a plane keeps them).
        out.poolGrew = model.pool.size - poolBefore;
        out.sharedPlanes = model.planesForNode(node.s0.id).map(p => p.name);

        ['camA', 'camB'].forEach(name => {
            const cam = cams.find(c => c.name === name);
            const view = AS.state.views.find(v => v.name === name);
            P.placePlaneOnView(A, name, view.videoWidth / 2, view.videoHeight / 2);
            P.placePlaneOnView(B, name, view.videoWidth / 2, view.videoHeight / 2);
            window.__setPts(A, name, out.aNames.map(n => cam.project(T[n])));
            window.__setPts(B, name, out.bNames.map(n => cam.project(T[n])));
            P.getPlaneInstance(name).nulledNodes.clear();
        });

        // ONE 2D point per view for a shared corner, by construction.
        const idxA = window.__poolIdx(A), idxB = window.__poolIdx(B);
        out.sharedPoolIdxSame = idxA[1] === idxB[1] && idxA[2] === idxB[2];

        P.planeState.selectedPlaneId = A.id;
        P.refreshPlanePanel();
        document.getElementById('btnPlaneTriangulate').click();
        P.planeState.selectedPlaneId = B.id;
        P.refreshPlanePanel();
        document.getElementById('btnPlaneTriangulate').click();

        // ONE 3D position: the same node, read through either plane.
        const ptsA = P.planePoints3d(A), ptsB = P.planePoints3d(B);
        out.sharedFromA = [ptsA[3], ptsA[4], ptsA[5]];
        out.sharedFromB = [ptsB[3], ptsB[4], ptsB[5]];
        out.sharedTruth = T.s0;
        out.oneNodeObject = model.pool.getNode(node.s0.id) === model.pool.getNode(node.s0.id);

        // Move it once; BOTH planes must see the move — there is no second copy
        // to fall out of step.
        model.pool.getNode(node.s0.id).setPoint3d([1, 2, 3]);
        const a2 = P.planePoints3d(A), b2 = P.planePoints3d(B);
        out.movedTogether = a2[3] === 1 && a2[4] === 2 && a2[5] === 3 &&
            b2[3] === 1 && b2[4] === 2 && b2[5] === 3;
        model.pool.getNode(node.s0.id).setPoint3d(T.s0);

        // The Nodes table is the POOL; membership of the SELECTED plane is its
        // own members table, and the add-an-existing-node dropdown is how a
        // user builds a shared corner by hand. B is selected here.
        const rowOf = (name) => Array.from(document.querySelectorAll('#planeNodesTable tbody tr'))
            .find(r => r.querySelector('input[type=text]').value === name);
        const memberNames = () =>
            Array.from(document.querySelectorAll('#planeMembersTable tbody tr'))
                .map(r => r.children[0].textContent.trim());
        const memberRowOf = (name) =>
            Array.from(document.querySelectorAll('#planeMembersTable tbody tr'))
                .find(r => r.children[0].textContent.trim() === name);
        P.refreshPlanePanel();
        out.membersOfB = memberNames();
        out.sharedRowMarked = rowOf('s0').classList.contains('plane-node-shared');
        // A node already in this plane must NOT be offered again; one that is
        // not in it must be.
        const options = () => Array.from(
            document.querySelectorAll('#planeAddNodeSelect option')).map(o => o.value);
        out.a0Offered = options().indexOf(String(node.a0.id)) >= 0;
        out.s0NotOffered = options().indexOf(String(node.s0.id)) < 0;
        // Add a0 to B through the real control — this is the headline gesture.
        const select = document.getElementById('planeAddNodeSelect');
        select.value = String(node.a0.id);
        document.getElementById('btnAddExistingPlaneNode').click();
        out.a0InBoth = model.planesForNode(node.a0.id).map(p => p.name);
        out.a0InMembersOfB = memberNames().indexOf('a0') >= 0;
        out.addStatus = document.getElementById('statusText').textContent;
        // …and take it out again with the members table's ×: that removes the
        // REFERENCE only, never the node.
        memberRowOf('a0').querySelector('td:last-child button').click();
        out.a0AfterRemove = model.planesForNode(node.a0.id).map(p => p.name);
        out.a0StillInPool = model.pool.has(node.a0.id);
        out.a0GoneFromMembers = memberNames().indexOf('a0') < 0;
        out.a0StillInNodesTable = !!rowOf('a0');

        out.ids = { s0: node.s0.id, s1: node.s1.id, a0: node.a0.id, b0: node.b0.id };
        out.A = A.id; out.B = B.id;
        return out;
    }, TRUTH15);
    check(eq(m.aNames, ['a0', 's0', 's1', 'a1']), `wallA references four nodes (got ${JSON.stringify(m.aNames)})`);
    check(eq(m.bNames, ['b0', 's0', 's1', 'b1']), `wallB references the SAME two shared ones (got ${JSON.stringify(m.bNames)})`);
    check(m.poolGrew === 6, `two 4-node walls sharing two corners cost SIX nodes, not eight (got ${m.poolGrew})`);
    check(eq(m.sharedPlanes, ['wallA', 'wallB']), `a shared node knows both planes (got ${JSON.stringify(m.sharedPlanes)})`);
    check(m.sharedPoolIdxSame, 'a shared corner is ONE pool index, so ONE 2D point per view');
    check(m.sharedFromA.every((v, i) => Math.abs(v - m.sharedTruth[i]) < 0.01),
        `the shared corner triangulates to its truth (got ${JSON.stringify(m.sharedFromA.map(v => +v.toFixed(2)))})`);
    check(eq(m.sharedFromA, m.sharedFromB),
        'and BOTH planes read the identical 3D — one node, one position');
    check(m.movedTogether, 'moving it once moves it in both planes (there is no second copy)');
    check(eq(m.membersOfB, ['b0', 's0', 's1', 'b1']),
        `the members table shows the SELECTED plane's nodes, shared ones included (got ${JSON.stringify(m.membersOfB)})`);
    check(m.sharedRowMarked, 'a shared node is marked as such in the table');
    check(m.a0Offered && m.s0NotOffered,
        `the add dropdown offers pool nodes not already in the plane, and only those (a0=${m.a0Offered}, s0 offered=${!m.s0NotOffered})`);
    check(eq(m.a0InBoth, ['wallA', 'wallB']) && m.a0InMembersOfB,
        `+ Add puts an EXISTING node into a second plane (got ${JSON.stringify(m.a0InBoth)})`);
    check(/shared with 1/.test(m.addStatus),
        `and says the node is now shared (got "${m.addStatus}")`);
    check(eq(m.a0AfterRemove, ['wallA']) && m.a0StillInPool && m.a0GoneFromMembers &&
        m.a0StillInNodesTable,
        'the members × removes the reference only — the node survives in the pool and its table');

    // Hit testing must follow VISIBILITY, not the instance's length: an
    // instance covers the whole pool, so a node whose only plane is not placed
    // here would otherwise be grabbable while drawing nothing.
    {
        const b0 = await page.evaluate(async (T) => {
            const AS = await import('/ui/app-state.js');
            return AS.state.session.cameras.find(c => c.name === 'camA').project(T.b0);
        }, TRUTH15);
        m = await page.evaluate(async ([bx, by]) => {
            const P = await import('/ui/plane-definition.js');
            const AS = await import('/ui/app-state.js');
            const im = AS.interactionManager;
            const model = P.planeModel();
            const B = model.planes.find(p => p.name === 'wallB');
            const out = { hitWhilePlaced: !!im.findNearestPlaneNode(bx, by, 'camA') };
            P.unplacePlaneFromView(B, 'camA');
            out.visibleAfter = model.visibleNodeIndices('camA').length;
            out.hitAfterUnplace = !!im.findNearestPlaneNode(bx, by, 'camA');
            // The 2D survives un-placing, so re-placing restores it exactly.
            out.pointKept = !!P.getPlaneInstance('camA').hasPoint(
                model.pool.indexOf(B.nodeIds[0]));
            P.placePlaneOnView(B, 'camA', 320, 240);
            out.hitAfterReplace = !!im.findNearestPlaneNode(bx, by, 'camA');
            return out;
        }, b0);
        check(m.hitWhilePlaced, 'a placed plane\'s node takes a click');
        check(!m.hitAfterUnplace,
            'a node whose plane is NOT placed on this view is not grabbable');
        check(m.visibleAfter === 4,
            `only the placed plane's nodes stay visible (got ${m.visibleAfter})`);
        check(m.pointKept, 'un-placing keeps the 2D, so re-placing restores the user\'s work');
        check(m.hitAfterReplace, 're-placing makes it grabbable again');
    }

    // =================================================================
    // 16 — PINNED (immutable) nodes
    // =================================================================
    console.log('\n16. Pinned nodes');

    // 16a — a pinned node cannot be dragged in 2D, and says why.
    const pinTarget = await page.evaluate(async (T) => {
        const P = await import('/ui/plane-definition.js');
        const AS = await import('/ui/app-state.js');
        const model = P.planeModel();
        const A = model.planes.find(p => p.name === 'wallA');
        P.planeState.selectedPlaneId = A.id;
        P.refreshPlanePanel();
        // Pin through the real checkbox, so the panel path is what is tested.
        const row = Array.from(document.querySelectorAll('#planeNodesTable tbody tr'))
            .find(r => r.querySelector('input[type=text]').value === 's0');
        const pin = row.querySelector('.plane-node-pin');
        pin.checked = true;
        pin.dispatchEvent(new Event('change', { bubbles: true }));
        const node = model.pool.getNode(A.nodeIds[1]);
        return {
            pinned: node.immutable,
            at: P.getPlaneInstance('camA').getPoint(model.pool.indexOf(node.id)),
            xyz: node.getPoint3d(),
        };
    }, TRUTH15);
    check(pinTarget.pinned, 'the Pin checkbox pins the node');
    {
        const from = await toClient('camA', pinTarget.at[0], pinTarget.at[1]);
        const to = await toClient('camA', pinTarget.at[0] + 60, pinTarget.at[1] + 40);
        await page.mouse.move(from[0], from[1]);
        await page.mouse.down();
        await page.mouse.move(to[0], to[1], { steps: 8 });
        await page.mouse.up();
        m = await page.evaluate(async () => {
            const P = await import('/ui/plane-definition.js');
            const AS = await import('/ui/app-state.js');
            const model = P.planeModel();
            const A = model.planes.find(p => p.name === 'wallA');
            const idx = model.pool.indexOf(A.nodeIds[1]);
            return {
                at: P.getPlaneInstance('camA').getPoint(idx),
                xyz: model.pool.getNode(A.nodeIds[1]).getPoint3d(),
                status: document.getElementById('statusText').textContent,
                selected: !!AS.interactionManager.selectedPlane,
            };
        });
        check(Math.abs(m.at[0] - pinTarget.at[0]) < 0.5 && Math.abs(m.at[1] - pinTarget.at[1]) < 0.5,
            `a pinned node cannot be dragged in 2D (was ${JSON.stringify(pinTarget.at.map(Math.round))}, now ${JSON.stringify(m.at.map(Math.round))})`);
        check(eq(m.xyz, pinTarget.xyz), 'and its 3D is untouched');
        check(/pinned/i.test(m.status), `the refusal explains itself (got "${m.status}")`);
        check(m.selected, 'the click still SELECTS, so the node stays reachable for un-pinning');
    }

    // 16b — pinned-but-never-triangulated is surfaced, not hidden.
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const model = P.planeModel();
        const A = model.planes.find(p => p.name === 'wallA');
        const ghost = model.createNodeInPlane('ghost', A, { immutable: true });
        P.refreshPlanePanel();
        const row = Array.from(document.querySelectorAll('#planeNodesTable tbody tr'))
            .find(r => r.querySelector('input[type=text]').value === 'ghost');
        const warn = document.getElementById('planeFrozenWarning');
        return {
            state: P.nodeFreezeState(ghost),
            badgeClass: row.querySelector('.plane-node-state').className,
            badgeText: row.querySelector('.plane-node-state').textContent,
            warnShown: getComputedStyle(warn).display !== 'none',
            warnText: warn.textContent,
            ghostId: ghost.id,
        };
    });
    check(m.state === 'frozen-unsolved',
        `a node pinned before triangulation is 'frozen-unsolved' (got '${m.state}')`);
    check(/frozen-unsolved/.test(m.badgeClass),
        `the table marks that state distinctly (got "${m.badgeClass}")`);
    check(/no 3D/i.test(m.badgeText), `and says so in words (got "${m.badgeText}")`);
    check(m.warnShown && /ghost/.test(m.warnText) && /block/i.test(m.warnText),
        `the panel explains the dead end in the open, not only in a tooltip (got "${(m.warnText || '').slice(0, 120)}")`);

    // 16c — a BLOCKING fit error mutates nothing at all.
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const model = P.planeModel();
        const A = model.planes.find(p => p.name === 'wallA');
        const before = {
            xyz: window.__nodesOf(A).map(n => n.getPoint3d()),
            pts2d: window.__getPts(A, 'camA').map(q => q && q.slice()),
            fit: A.planeFit,
            tri: A.triangulation,
        };
        const plan = P.planPlaneFit(A);
        document.getElementById('btnPlaneFit').click();
        const after = {
            xyz: window.__nodesOf(A).map(n => n.getPoint3d()),
            pts2d: window.__getPts(A, 'camA').map(q => q && q.slice()),
        };
        const dlg = document.getElementById('planeDialog');
        return {
            planOk: plan.ok,
            code: plan.code,
            message: plan.message,
            xyzUnchanged: JSON.stringify(before.xyz) === JSON.stringify(after.xyz),
            pts2dUnchanged: JSON.stringify(before.pts2d) === JSON.stringify(after.pts2d),
            fitUnchanged: A.planeFit === before.fit,
            triUnchanged: A.triangulation === before.tri,
            dialogShown: !!dlg,
            dialogText: dlg ? dlg.textContent : '',
            status: document.getElementById('statusText').textContent,
        };
    });
    check(!m.planOk && m.code === 'no_anchor_3d',
        `a pinned node with no 3D BLOCKS the fit, by code (got '${m.code}')`);
    check(/ghost/.test(m.message) && /triangulate/i.test(m.message),
        `the error names the node and what to do (got "${(m.message || '').slice(0, 140)}")`);
    check(m.xyzUnchanged && m.pts2dUnchanged && m.fitUnchanged && m.triUnchanged,
        'a blocked fit mutates NOTHING — no 3D, no 2D, no stored fit');
    check(m.dialogShown && /ghost/.test(m.dialogText),
        'the blocking message is shown, not just logged');

    // The dialog is a modal, so Esc must close it (project rule).
    await page.keyboard.press('Escape');
    m = await page.evaluate(() => ({ gone: !document.getElementById('planeDialog') }));
    check(m.gone, 'Esc closes the fit dialog');

    // 16d — a constrained fit holds every pinned node BIT-EXACTLY.
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const model = P.planeModel();
        const A = model.planes.find(p => p.name === 'wallA');
        // Drop the dead-end node; pin the two shared corners instead (they have
        // 3D), and push a mutable corner off the plane so the fit has work.
        const ghost = window.__nodesOf(A).find(n => n.name === 'ghost');
        model.deleteNode(ghost.id);
        const nodes = window.__nodesOf(A);
        nodes[1].immutable = true;      // s0
        nodes[2].immutable = true;      // s1
        nodes[3].immutable = false;
        const anchorsBefore = [nodes[1].getPoint3d(), nodes[2].getPoint3d()];
        const q = nodes[3].getPoint3d();
        nodes[3].setPoint3d([q[0], q[1], q[2] + 8]);   // 8 mm off plane
        const before2d = window.__getPts(A, 'camA').map(x => x && x.slice());

        P.planeState.selectedPlaneId = A.id;
        P.refreshPlanePanel();
        const res = P.fitPlane(A, { confirmed: true });

        const after = window.__nodesOf(A);
        const c = A.planeFit.centroid, nv = A.planeFit.normal;
        const dist = (p) => Math.abs((p[0] - c[0]) * nv[0] + (p[1] - c[1]) * nv[1] +
            (p[2] - c[2]) * nv[2]);
        const after2d = window.__getPts(A, 'camA');
        return {
            ok: res.ok,
            constrained: !!A.planeFit.constrained,
            // `===` per coordinate: the constrained projection copies frozen
            // points verbatim, so anything but bit-identical is a bug.
            anchorsExact: [1, 2].every((k, i) =>
                after[k].getPoint3d().every((v, j) => v === anchorsBefore[i][j])),
            anchorsOnPlane: [1, 2].every(k => dist(after[k].getPoint3d()) < 1e-9),
            mutableOnPlane: [0, 3].every(k => dist(after[k].getPoint3d()) < 1e-9),
            mutableMoved: dist(before2d ? [q[0], q[1], q[2] + 8] : [0, 0, 0]) === 0 ||
                Math.abs(after[3].getPoint3d()[2] - (q[2] + 8)) > 1e-6,
            // A pinned node's 2D must NOT be rewritten from its 3D: that is the
            // user's annotation, and the residual between them is the
            // diagnostic that says the pin no longer agrees with the image.
            anchor2dUntouched: [1, 2].every(k =>
                after2d[k][0] === before2d[k][0] && after2d[k][1] === before2d[k][1]),
            mutable2dMoved: Math.hypot(after2d[3][0] - before2d[3][0],
                after2d[3][1] - before2d[3][1]) > 0.5,
            skipped: (res.skippedIds || []).length,
        };
    });
    check(m.ok && m.constrained, 'with a pinned node the fit takes the CONSTRAINED path');
    check(m.anchorsExact, 'every pinned node is held bit-exactly (===, not "close")');
    check(m.anchorsOnPlane, 'the fitted plane passes through them');
    check(m.mutableOnPlane && m.mutableMoved, 'the mutable corners are flattened onto it');
    check(m.anchor2dUntouched, 'a pinned node\'s 2D annotation is left alone');
    check(m.mutable2dMoved, 'while a mutable node\'s 2D follows its corrected 3D');
    check(m.skipped === 2, `the refused 3D writes are reported, not swallowed (got ${m.skipped})`);

    // 16e — fitting one plane marks the other's fit STALE when it moves a node
    // they share. Nodes are global, so this is silent corruption otherwise.
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const model = P.planeModel();
        const A = model.planes.find(p => p.name === 'wallA');
        const B = model.planes.find(p => p.name === 'wallB');
        // Un-pin the shared corners so a fit is allowed to move them.
        window.__nodesOf(A).forEach(n => { n.immutable = false; });

        P.planeState.selectedPlaneId = A.id;
        P.refreshPlanePanel();
        P.fitPlane(A, { confirmed: true });
        const aFitBefore = A.planeFit;

        // Push a SHARED corner off B's plane so fitting B has to move it.
        const shared = window.__nodesOf(B)[1];
        const p = shared.getPoint3d();
        shared.setPoint3d([p[0], p[1], p[2] + 10]);

        P.planeState.selectedPlaneId = B.id;
        P.refreshPlanePanel();
        const plan = P.planPlaneFit(B);
        const movedShared = plan.movedNodeIds.indexOf(shared.id) >= 0;
        const staleIds = plan.stalePlaneIds.slice();
        document.getElementById('btnPlaneFit').click();
        return {
            aHadFit: !!aFitBefore,
            movedShared: movedShared,
            staleNamesA: staleIds.map(id => model.getPlane(id).name),
            aFitCleared: A.planeFit === null,
            bFitKept: !!B.planeFit,
            status: document.getElementById('statusText').textContent,
        };
    });
    check(m.aHadFit, 'precondition: wallA is fitted');
    check(m.movedShared, 'fitting wallB moves a node wallA also stands on');
    check(eq(m.staleNamesA, ['wallA']),
        `so wallA is reported stale (got ${JSON.stringify(m.staleNamesA)})`);
    check(m.aFitCleared, 'wallA\'s stored fit is dropped rather than left silently wrong');
    check(m.bFitKept, 'while wallB keeps the fit it just computed');
    check(/wallA/.test(m.status) && /stale/i.test(m.status),
        `and the user is told which plane went stale (got "${m.status}")`);

    // =================================================================
    // 17 — deleting a SHARED node cleans up every plane that used it
    // =================================================================
    console.log('\n17. Deleting a shared node');
    m = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const model = P.planeModel();
        const A = model.planes.find(p => p.name === 'wallA');
        const B = model.planes.find(p => p.name === 'wallB');
        const shared = window.__nodesOf(A)[1];          // s0, in both planes
        const poolIdx = model.pool.indexOf(shared.id);
        const before = {
            pool: model.pool.size,
            aNodes: A.nodeIds.length,
            bNodes: B.nodeIds.length,
            aEdges: A.edges.length,
            bEdges: B.edges.length,
            pts: P.getPlaneInstance('camA').toPointsArray(),
            planes: model.planesForNode(shared.id).map(p => p.name),
        };
        // The × in the Nodes table, which for a SHARED node must confirm first.
        P.refreshPlanePanel();
        const row = Array.from(document.querySelectorAll('#planeNodesTable tbody tr'))
            .find(r => r.querySelector('input[type=text]').value === shared.name);
        row.querySelector('td:last-child button').click();
        const dlg = document.getElementById('planeDialog');
        const out = {
            before: before,
            confirmShown: !!dlg,
            confirmText: dlg ? dlg.textContent : '',
            stillThereBeforeConfirm: model.pool.has(shared.id),
        };
        if (dlg) document.getElementById('btnPlaneDialogConfirm').click();

        out.pool = model.pool.size;
        out.goneFromPool = !model.pool.has(shared.id);
        out.aNodes = A.nodeIds.length;
        out.bNodes = B.nodeIds.length;
        out.aHasIt = A.hasNode(shared.id);
        out.bHasIt = B.hasNode(shared.id);
        out.aEdgesLive = A.edges.every(e => model.pool.has(e[0]) && model.pool.has(e[1]));
        out.bEdgesLive = B.edges.every(e => model.pool.has(e[0]) && model.pool.has(e[1]));
        out.aEdges = A.edges.length;
        out.bEdges = B.edges.length;
        // Every view's 2D spliced at that index, in step with the pool.
        const after = P.getPlaneInstance('camA').toPointsArray();
        out.spliced = JSON.stringify(after) ===
            JSON.stringify(before.pts.filter((_, i) => i !== poolIdx));
        out.instanceLen = after.length;
        out.otherViewLen = P.getPlaneInstance('camB').numNodes;
        // The remaining nodes still resolve — an index-based edge or membership
        // would now be pointing at a neighbour.
        out.aNames = window.__namesOf(A);
        out.bNames = window.__namesOf(B);
        return out;
    });
    check(eq(m.before.planes, ['wallA', 'wallB']), 'precondition: the node is in both planes');
    check(m.confirmShown && /wallA/.test(m.confirmText) && /wallB/.test(m.confirmText),
        'deleting a shared node asks first, naming the planes it will change');
    check(m.stillThereBeforeConfirm, 'and nothing is destroyed until it is confirmed');
    check(m.goneFromPool && m.pool === m.before.pool - 1,
        `confirming removes it from the pool (${m.before.pool} -> ${m.pool})`);
    check(!m.aHasIt && !m.bHasIt, 'both planes stop referencing it');
    check(m.aNodes === m.before.aNodes - 1 && m.bNodes === m.before.bNodes - 1,
        `both plane node lists shrink (${m.before.aNodes}/${m.before.bNodes} -> ${m.aNodes}/${m.bNodes})`);
    check(m.aEdges === m.before.aEdges - 2 && m.bEdges === m.before.bEdges - 2,
        `the two edges through it go from EACH plane (${m.before.aEdges}/${m.before.bEdges} -> ${m.aEdges}/${m.bEdges})`);
    check(m.aEdgesLive && m.bEdgesLive, 'no surviving edge points at a deleted node');
    check(m.spliced, 'every view\'s 2D is spliced at the same index');
    check(m.instanceLen === m.pool && m.otherViewLen === m.pool,
        `every view's instance still spans the pool (${m.instanceLen}/${m.otherViewLen} vs ${m.pool})`);
    check(eq(m.aNames, ['a0', 's1', 'a1']) && eq(m.bNames, ['b0', 's1', 'b1']),
        `the surviving names resolve in both planes (got ${JSON.stringify(m.aNames)} / ${JSON.stringify(m.bNames)})`);

} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
