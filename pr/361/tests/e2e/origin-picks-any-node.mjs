/**
 * origin-picks-any-node.mjs — Set Origin takes ANY node of a fitted plane, not
 * only one on its outline.
 *
 * A plane is a group of nodes and its fit is a surface through all of them, so
 * a node in the MIDDLE of the floor is as good an origin as one at its edge —
 * and on a real cage it is usually the better one, because that is where a
 * physical mark tends to be. The picker never asked for an outline node; only
 * the wizard's own wording did ("Click a corner of a fitted plane"), which is a
 * restriction a user would reasonably believe and act on.
 *
 * The fixture is the case the wording ruled out: a five-node plane, four
 * corners plus ONE node strictly inside the quad. What this pins:
 *
 *   1. The instruction says "any node", and says it before the user has to
 *      guess. A regex on the copy, because the copy is the whole bug.
 *   2. The interior node is PICKABLE in 3D — the raycast collects one mesh per
 *      `plane.nodeIds` entry, so being off the outline is not a property the
 *      viewport can even see.
 *   3. Clicking it advances the wizard and makes THAT node the origin: the
 *      recorded point is its 3D, to the millimetre, and the index is its own.
 *   4. The whole wizard completes from it — arrow, Continue, a frame whose
 *      origin is the interior node and whose +Z is the plane's normal. An
 *      origin you can pick but not finish would be no better than one you
 *      cannot pick.
 *   5. The negative control: a node of an UN-FIT plane is still refused. The
 *      widening is about WHICH node of a fitted plane, and must not become
 *      "any node anywhere" — an un-fit plane has no normal, so it has no +Z to
 *      offer and picking it would dead-end the wizard.
 *
 * Run: node origin-picks-any-node.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8263);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

// The fixture, stated here so the assertions below are against numbers this
// file chose rather than against whatever the app produced. The plane is
// TILTED (z = 1000 + 0.25x) and exactly coplanar, so "on the plane" is a real
// constraint and the interior node is not trivially the centroid of anything
// axis-aligned.
const Z = (x) => 1000 + 0.25 * x;
const CORNERS = [
    [-300, -300, Z(-300)],
    [300, -300, Z(300)],
    [300, 300, Z(300)],
    [-300, 300, Z(-300)],
];
// Strictly inside the quad, and deliberately NOT its centre — a marker the
// user put on the floor, which is the case that motivates this.
const INTERIOR = [-60, 110, Z(-60)];

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

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

    const built = await page.evaluate(async ({ CORNERS, INTERIOR }) => {
        const AS = await import('/ui/app-state.js');
        const P = await import('/ui/plane-definition.js');
        if (!P.planeState.active) P.togglePlaneMode();
        const model = P.planeModel();
        const mk = (name, xyz) => { const n = model.addNode(name); n.setPoint3d(xyz); return n; };

        const floor = P.createPlane('Ground');
        const ring = ['A', 'B', 'C', 'D'].map((nm, i) => mk(nm, CORNERS[i]));
        ring.forEach(n => model.addNodeToPlane(floor, n.id));
        // Added LAST, so its index in the plane's node order is 4 — past every
        // outline node, which is what a "corners only" reading would have cut
        // the list off before.
        const mid = mk('floor mark', INTERIOR);
        model.addNodeToPlane(floor, mid.id);
        // The edge ring is the four corners only: the interior node is in the
        // plane but on none of its edges, which is exactly the shape the old
        // wording denied.
        for (let i = 0; i < 4; i++) floor.addEdge(ring[i].id, ring[(i + 1) % 4].id);

        // A SECOND plane, never fitted — §5's control.
        const wall = P.createPlane('unfit wall');
        [['E', [-300, -300, 1400]], ['F', [300, -300, 1400]], ['G', [300, -300, 1900]]]
            .forEach(([nm, xyz]) => model.addNodeToPlane(wall, mk(nm, xyz).id));

        // A `MouseEvent`'s clientX/clientY are integers, so a synthetic click
        // lands on a whole pixel — and with the un-fit wall in the scene
        // `fitToScene` pulls the camera back far enough that a default-sized
        // corner is about a pixel across, which half a pixel of rounding is
        // enough to miss. Bigger corners make the click land where the test
        // aimed it; a real pointer has the same target the slider gives it.
        P.planeState.nodeSize3d = 14;
        const fit = P.fitPlane(floor, { confirmed: true });
        P.refreshPlanePanel();
        P.syncPlanes3D();
        return {
            hasViewport: !!AS.viewport3d,
            fitOk: !!fit.ok,
            floorId: floor.id,
            wallId: wall.id,
            midIdx: floor.nodeIds.indexOf(mid.id),
            nNodes: floor.nodeIds.length,
            wallFitted: !!wall.planeFit,
        };
    }, { CORNERS, INTERIOR });
    check(built.hasViewport && built.fitOk,
        'a real viewport, and the five-node floor took a Fit');
    check(built.midIdx === 4 && built.nNodes === 5,
        `the interior node is the plane's LAST node, past every corner (idx ${built.midIdx}/${built.nNodes})`);
    check(built.wallFitted === false, 'the second plane is deliberately left un-fit');

    // --- §1 the instruction ------------------------------------------------
    const entered = await page.evaluate(async () => {
        const O = await import('/ui/origin-definition.js');
        document.getElementById('btnSetOrigin').click();
        return {
            active: O.originState.active,
            step: O.originState.step,
            stepText: document.getElementById('originStepText').textContent,
            btnTitle: document.getElementById('btnSetOrigin').title,
        };
    });
    check(entered.active && entered.step === 'node', 'Set Origin enters at the node step');
    check(/any node/i.test(entered.stepText) && !/corner/i.test(entered.stepText),
        `the instruction offers ANY node and never says "corner" (got "${entered.stepText}")`);
    check(/any node/i.test(entered.btnTitle),
        `so does the button's own tooltip (got "${entered.btnTitle}")`);

    // --- §2/§3 picking the interior node -----------------------------------
    const picked = await page.evaluate(async ({ INTERIOR, floorId, midIdx }) => {
        const O = await import('/ui/origin-definition.js');
        const AS = await import('/ui/app-state.js');
        const vp = AS.viewport3d;
        const dom = vp.renderer.domElement;

        vp.fitToScene();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        // How many of the floor's corner meshes the picker would accept. The
        // group is rebuilt per sync, so this is read fresh rather than cached.
        let pickable = 0;
        vp._planeGroup.traverse(c => {
            if (c.isMesh && c.userData && c.userData.planeFitted &&
                c.userData.planeId === floorId) pickable++;
        });

        const v = new THREE.Vector3(INTERIOR[0], INTERIOR[1], INTERIOR[2]).project(vp.threeCamera);
        const r = dom.getBoundingClientRect();
        const x = r.left + (v.x + 1) / 2 * r.width;
        const y = r.top + (1 - v.y) / 2 * r.height;
        const onScreen = Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
        dom.dispatchEvent(new MouseEvent('click', {
            clientX: Math.round(x), clientY: Math.round(y), bubbles: true }));

        return {
            pickable, onScreen,
            step: O.originState.step,
            planeId: O.originState.planeId,
            nodeIdx: O.originState.nodeIdx,
            originPoint: O.originState.originPoint && O.originState.originPoint.slice(),
            normal: O.originState.normal && O.originState.normal.slice(),
            status: document.getElementById('statusText').textContent,
            wantIdx: midIdx,
        };
    }, { INTERIOR, floorId: built.floorId, midIdx: built.midIdx });
    check(picked.pickable === 5,
        `all FIVE of the floor's nodes are pickable, not just its four corners (got ${picked.pickable})`);
    check(picked.onScreen, 'the interior node is on screen for the click');
    check(picked.step === 'axis',
        `clicking a node off the outline advances the wizard (got '${picked.step}')`);
    check(picked.planeId === built.floorId && picked.nodeIdx === picked.wantIdx,
        `it records the INTERIOR node, by plane and index (got plane ${picked.planeId}, idx ${picked.nodeIdx})`);
    check(picked.originPoint &&
        picked.originPoint.every((v, i) => Math.abs(v - INTERIOR[i]) < 0.01),
        'and the origin is that node\'s own 3D, to the millimetre (got ' +
        JSON.stringify(picked.originPoint && picked.originPoint.map(v => +v.toFixed(2))) +
        ' vs ' + JSON.stringify(INTERIOR) + ')');
    check(/Origin node/.test(picked.status) && !/corner/i.test(picked.status),
        `the status names it a node, not a corner (got "${picked.status}")`);

    // --- §4 the wizard finishes from it ------------------------------------
    const applied = await page.evaluate(async ({ INTERIOR }) => {
        const O = await import('/ui/origin-definition.js');
        O.pickOriginAxis('positive');
        document.getElementById('btnOriginContinue').click();
        const f = O.originState.frame;
        return {
            active: O.originState.active,
            has: !!f,
            origin: f && Array.from(f.origin),
            zAxis: f && Array.from(f.zAxis),
            sourceNode: f && f.sourceNode,
            sourcePlane: f && f.sourcePlane,
            readout: document.getElementById('originResult').textContent,
            want: INTERIOR,
        };
    }, { INTERIOR });
    check(applied.has && !applied.active,
        'choosing an arrow and clicking Continue applies a frame and leaves the mode');
    check(applied.origin && applied.origin.every((v, i) => Math.abs(v - INTERIOR[i]) < 0.01),
        `the applied frame's origin IS the interior node (got ${JSON.stringify(applied.origin && applied.origin.map(v => +v.toFixed(2)))})`);
    check(Math.abs(Math.hypot(...applied.zAxis) - 1) < 1e-9 &&
        Math.abs(applied.zAxis[2]) > 0.9,
        `+Z came from the floor's normal, which is near-vertical (got ${JSON.stringify(applied.zAxis.map(v => +v.toFixed(4)))})`);
    check(applied.sourceNode === 'floor mark' && applied.sourcePlane === 'Ground',
        `and the readout names the node it came from (got "${applied.sourceNode}" on "${applied.sourcePlane}")`);
    check(/floor mark/.test(applied.readout),
        'which is what the Defined Origin panel shows');

    // --- §5 the control: an UN-FIT plane's node is still refused -----------
    const refused = await page.evaluate(async ({ wallId }) => {
        const O = await import('/ui/origin-definition.js');
        const P = await import('/ui/plane-definition.js');
        const AS = await import('/ui/app-state.js');
        const vp = AS.viewport3d;
        const dom = vp.renderer.domElement;

        // Back to a clean slate, then re-enter the wizard.
        O.clearOrigin();
        document.getElementById('btnSetOrigin').click();
        vp.fitToScene();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        let wallPickable = 0;
        vp._planeGroup.traverse(c => {
            if (c.isMesh && c.userData && c.userData.planeFitted &&
                c.userData.planeId === wallId) wallPickable++;
        });

        const wall = P.getPlane(wallId);
        const pts = P.planePoints3d(wall);
        const pd = await import('/pose/pose-data.js');
        const p = pd.getPoint3d(pts, 0);
        const v = new THREE.Vector3(p[0], p[1], p[2]).project(vp.threeCamera);
        const r = dom.getBoundingClientRect();
        const onScreen = Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
        dom.dispatchEvent(new MouseEvent('click', {
            clientX: Math.round(r.left + (v.x + 1) / 2 * r.width),
            clientY: Math.round(r.top + (1 - v.y) / 2 * r.height),
            bubbles: true,
        }));
        const out = { wallPickable, onScreen, step: O.originState.step,
            planeId: O.originState.planeId };
        O.exitOriginMode();
        return out;
    }, { wallId: built.wallId });
    check(refused.wallPickable === 0,
        'no node of the UN-FIT plane is pickable at all');
    check(refused.onScreen && refused.step === 'node' && refused.planeId === null,
        `clicking one leaves the wizard where it was (step '${refused.step}')`);

} catch (err) {
    console.error('FATAL', err);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\n✅ ALL CHECKS PASSED' : `\n❌ ${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
