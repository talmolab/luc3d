/**
 * plane-node-selection.mjs — a node can be SELECTED in the Nodes table, and
 * the 3D view says which corner it is.
 *
 * The Nodes table is the project's whole node pool: nine rows of name, colour
 * and padlock, none of which answers "which of the dots on my cage is this?".
 * Clicking a row now RINGS that corner in 3D, and the next click anywhere else
 * takes the rings away again.
 *
 * What this pins:
 *
 *   1. Clicking a row selects it — the row is marked and the marker is drawn
 *      ON the node, at coordinates read from the POOL rather than from the
 *      payload the marker itself was built from.
 *   2. A node shared by two planes gets ONE marker, not one per plane. A pool
 *      node has one position, which is what a shared corner IS, and a second
 *      marker on top of the first would only z-fight with it.
 *   3. Selecting another node moves the selection rather than adding to it.
 *   4. Clicking elsewhere IN THE PANEL clears it, and so does clicking the 3D
 *      view. Both go through the one capture-phase listener, so neither can be
 *      the surface somebody forgot to wire.
 *   5. Clicking the row's NAME FIELD still selects — its neighbours
 *      (`stopPropagation` on the swatch and the padlock) do not defeat the
 *      listener — and the field keeps focus, because selecting must not
 *      rebuild the table out from under the click that is focusing it.
 *   6. The marker FOLLOWS the node: moving it and re-syncing leaves it on the
 *      corner, not where the corner used to be.
 *   7. A node in NO plane selects in the panel and is marked nowhere. The 3D view
 *      draws planes; a node no plane references is not in it, and inventing a
 *      marker for it would draw a point the user cannot see anywhere else.
 *   8. Deleting the selected node clears the selection, marker and all.
 *
 * Run: node plane-node-selection.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8261);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // A calibrated session, so `setup3DViewport` really builds a viewport —
    // asserted first, because every scene read below would otherwise pass for
    // the wrong reason.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Camera, Session, Skeleton } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = [
            new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.6, 0], [-400, 0, 0], [640, 480]),
        ];
        const session = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]),
            ['track_0'], 'S1');
        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 10;
        AS.state.views = cams.map(c => ({
            name: c.name, videoWidth: 640, videoHeight: 480, canvas: null,
        }));
        const init = await import('/pose/initialization.js');
        init.setup3DViewport();
    });
    await page.waitForTimeout(600);

    // A floor and a wall SHARING one corner, plus a node in no plane at all.
    // Off-origin and asymmetric, so a marker that landed on the wrong corner
    // cannot coincidentally match.
    const built = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const P = await import('/ui/plane-definition.js');
        if (!P.planeState.active) P.togglePlaneMode();
        const model = P.planeModel();
        const mk = (name, xyz) => { const n = model.addNode(name); n.setPoint3d(xyz); return n; };

        const A = mk('A', [-110, -90, 970]);      // shared by both planes
        const B = mk('B', [130, -90, 1030]);
        const C = mk('C', [130, 120, 1030]);
        const D = mk('D', [-110, 120, 970]);
        const E = mk('E', [-110, -90, 1400]);
        const F = mk('F', [130, -90, 1400]);
        const lonely = mk('lonely', [500, 500, 500]);   // in no plane

        const floor = P.createPlane('floor');
        [A, B, C, D].forEach(n => model.addNodeToPlane(floor, n.id));
        const wall = P.createPlane('wall');
        [A, B, F, E].forEach(n => model.addNodeToPlane(wall, n.id));
        P.refreshPlanePanel();
        P.syncPlanes3D();

        return {
            hasViewport: !!AS.viewport3d,
            ids: { A: A.id, B: B.id, lonely: lonely.id },
            planes: { floor: floor.id, wall: wall.id },
        };
    });
    check(built.hasViewport === true, 'a real 3D viewport came up');

    // Reading the scene. Positions come out of the object's world MATRIX, and
    // the node they are compared against out of the POOL — so this never asks
    // the payload whether the payload is right.
    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const P = await import('/ui/plane-definition.js');
        window.__sel = {
            marks() {
                const grp = AS.viewport3d.scene.children.find(ch => ch.name === 'nodeSelection');
                if (!grp) return null;
                grp.updateMatrixWorld(true);
                return grp.children
                    .filter(ch => /^planeNodeSelected_/.test(ch.name))
                    .map(ch => ({
                        planeId: Number(ch.name.split('_')[1]),
                        pos: [ch.matrixWorld.elements[12], ch.matrixWorld.elements[13],
                            ch.matrixWorld.elements[14]],
                    }));
            },
            marked() {
                return [...document.querySelectorAll(
                    '#planeNodesTable tbody tr.plane-node-selected')]
                    .map(tr => Number(tr.getAttribute('data-plane-node-id')));
            },
            xyz(id) { return Array.from(P.planeModel().pool.getNode(id).xyz); },
            far(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); },
            rowFor(id) {
                return [...document.querySelectorAll('#planeNodesTable tbody tr.plane-node-main')]
                    .find(tr => tr.getAttribute('data-plane-node-id') === String(id));
            },
        };
    });
    const marks = () => page.evaluate(() => window.__sel.marks());
    const clickRow = (id) => page.evaluate((nid) => {
        window.__sel.rowFor(nid).querySelector('.plane-node-name').click();
    }, id);

    check((await marks()) !== null, 'the scene has a nodeSelection group');
    check((await marks()).length === 0, 'nothing is marked before anything is clicked');

    // --- §1/§2 selecting the SHARED corner ------------------------------
    await clickRow(built.ids.A);
    const selA = await page.evaluate((b) => {
        const h = window.__sel.marks();
        const a = window.__sel.xyz(b.ids.A);
        return {
            marked: window.__sel.marked(),
            count: h.length,
            planeIds: h.map(x => x.planeId).sort((p, q) => p - q),
            worst: h.length ? Math.max(...h.map(x => window.__sel.far(x.pos, a))) : Infinity,
        };
    }, built);
    check(selA.marked.length === 1 && selA.marked[0] === built.ids.A,
        'clicking node A marks exactly its rows and no other node');
    check(selA.count === 1,
        'a corner TWO planes share still gets exactly one marker, not one per plane');
    check(selA.planeIds.length === 1 &&
        (selA.planeIds[0] === built.planes.floor || selA.planeIds[0] === built.planes.wall),
        'and it is drawn through one of the two planes that hold it');
    check(selA.worst < 1e-9,
        'the marker sits exactly on A, at the coordinates the POOL holds (' +
        selA.worst.toExponential(2) + ' mm)');

    // --- §3 selection MOVES ---------------------------------------------
    await clickRow(built.ids.B);
    const selB = await page.evaluate((b) => ({
        marked: window.__sel.marked(),
        count: window.__sel.marks().length,
        onB: window.__sel.marks().every(h =>
            window.__sel.far(h.pos, window.__sel.xyz(b.ids.B)) < 1e-9),
    }), built);
    check(selB.marked.length === 1 && selB.marked[0] === built.ids.B,
        'selecting B leaves only B marked — selection moves, it does not accumulate');
    check(selB.count === 1 && selB.onB,
        'and the one marker is on B now, none left behind on A');

    // --- §4 clicking elsewhere in the PANEL clears it --------------------
    await page.evaluate(() => {
        document.querySelector('#planeNodesTable thead').click();
    });
    const afterPanel = await page.evaluate(() => ({
        marked: window.__sel.marked().length, marks: window.__sel.marks().length,
    }));
    check(afterPanel.marked === 0 && afterPanel.marks === 0,
        'a click elsewhere in the panel clears the selection and the marker');

    // ...and so does a click in the 3D VIEW, on the canvas the viewport really
    // renders into, which is the surface the user's pointer hits.
    await clickRow(built.ids.A);
    check((await marks()).length === 1, 'A is selected again, as the control for the next check');
    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        AS.viewport3d.renderer.domElement.dispatchEvent(
            new MouseEvent('click', { bubbles: true }));
    });
    const after3d = await page.evaluate(() => ({
        marked: window.__sel.marked().length, marks: window.__sel.marks().length,
    }));
    check(after3d.marked === 0 && after3d.marks === 0,
        'a click in the 3D view clears it too');

    // --- §5 the name field selects, and keeps the caret ------------------
    await page.evaluate((b) => {
        const input = window.__sel.rowFor(b.ids.A).querySelector('.plane-node-name');
        input.focus();
        input.click();
    }, built);
    const typing = await page.evaluate((b) => {
        const input = window.__sel.rowFor(b.ids.A).querySelector('.plane-node-name');
        return {
            marked: window.__sel.marked(),
            focused: document.activeElement === input,
            value: input.value,
        };
    }, built);
    check(typing.marked.length === 1 && typing.marked[0] === built.ids.A,
        'clicking the name field selects the node it belongs to');
    check(typing.focused === true && typing.value === 'A',
        'and the field it clicked still has focus — selecting did not rebuild the table');

    // --- §6 the marker follows the node ----------------------------------
    const moved = await page.evaluate(async (b) => {
        const P = await import('/ui/plane-definition.js');
        P.planeModel().pool.getNode(b.ids.A).setPoint3d([-40, -200, 1111]);
        P.syncPlanes3D();
        const a = window.__sel.xyz(b.ids.A);
        const h = window.__sel.marks();
        return {
            count: h.length,
            worst: h.length ? Math.max(...h.map(x => window.__sel.far(x.pos, a))) : Infinity,
        };
    }, built);
    check(moved.count === 1 && moved.worst < 1e-9,
        'moving the node and re-syncing leaves the marker ON it, not where it was');

    // --- §7 a node in no plane -------------------------------------------
    await clickRow(built.ids.lonely);
    const lonely = await page.evaluate(() => ({
        marked: window.__sel.marked(), marks: window.__sel.marks().length,
    }));
    check(lonely.marked.length === 1 && lonely.marked[0] === built.ids.lonely,
        'a node in no plane still selects in the panel');
    check(lonely.marks === 0,
        'and is marked nowhere, because no plane draws it in 3D');

    // --- §8 deleting the selected node ------------------------------------
    await clickRow(built.ids.B);
    check((await marks()).length === 1, 'B is selected, as the control for the delete');
    const deleted = await page.evaluate(async (b) => {
        const P = await import('/ui/plane-definition.js');
        P.planeModel().deleteNode(b.ids.B);
        P.refreshPlanePanel();
        P.syncPlanes3D();
        return {
            marked: window.__sel.marked().length,
            marks: window.__sel.marks().length,
            selectedNodeId: P.planeState.selectedNodeId,
        };
    }, built);
    check(deleted.selectedNodeId === null,
        'deleting the selected node clears the selection');
    check(deleted.marked === 0 && deleted.marks === 0,
        'and leaves no stale marker hanging where its corner was');

} catch (err) {
    console.error('FATAL', err);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\n✅ ALL CHECKS PASSED' : `\n❌ ${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
