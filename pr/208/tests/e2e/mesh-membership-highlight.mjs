/**
 * mesh-membership-highlight.mjs — the selected 3D Mesh Object, drawn in 3D.
 *
 * A 3D Mesh Object is a GROUP OF PLANES, and every one of those planes is
 * already on screen. So selecting an object does not add a body to the scene:
 * it lights up the planes that belong to it — filling each member's face and
 * redrawing its corners and edges in one fixed yellow, on the planes
 * themselves.
 *
 * This file needs a real `Viewport3D` — a WebGL context and a live scene graph
 * — because what it pins is where THREE actually puts the highlight. The
 * payload wiring (which ids leave `syncPlanes3D`) is pinned away from WebGL in
 * `mesh-object-roundtrip.mjs` §4; a payload assertion cannot see a drawing
 * that is correct in its inputs and wrong on screen.
 *
 * What is asserted:
 *
 *  1. Selecting an object highlights its MEMBERS and nothing else, and
 *     deselecting clears the highlight entirely.
 *  1b. The member FACES are filled — an outline alone left each plane wearing
 *     its own colour, so on a cage of coloured walls "is this one a member?"
 *     came down to a few corner dots. The fill is in a fixed yellow, NOT the
 *     object's colour (which the fixture sets to something else to prove it),
 *     it respects depth while the outline does not, and the planes' own fills
 *     are left untouched.
 *  2. THE REGRESSION. Every highlight sits EXACTLY on its plane's own corner,
 *     to the last bit, even with a defined origin. The first version of this
 *     feature drew the object's DERIVED geometry instead, which is built in
 *     the user's origin frame, into a group that hangs off the scene and is
 *     therefore drawn in CALIBRATION world — so defining an origin made the
 *     object float away from the very cage it was built from, translated and
 *     rotated by the frame.
 *
 *     The negative control matters as much as the assertion: with the same
 *     frame set, the derived geometry's first vertex is shown to be somewhere
 *     ELSE. Without that, "the highlight is at the node" would also pass on a
 *     build where the frame was simply ignored everywhere, which is a
 *     different bug with the same symptom here and the wrong numbers in the
 *     panel and both exporters.
 *
 *  3. Adding a plane in the panel lights it up; removing it puts it out. That
 *     is the feedback loop the membership editor exists for.
 *
 * Run: node mesh-membership-highlight.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8231);

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
        if (/Failed to load resource|net::ERR|404/.test(t)) return;
        console.log('  [console.error]', t.slice(0, 300));
        fails++;
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // A calibrated session, so `setup3DViewport` really builds a viewport.
    // Without calibration it never comes up and every assertion below would
    // pass for the wrong reason — which is why `hasViewport` is asserted first.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        const K = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
        const cams = [
            new Camera('cam1', K, [0, 0, 0, 0, 0], [0.01, 0.02, 0.03], [0, 0, 500], [512, 512]),
            new Camera('cam2', K, [0, 0, 0, 0, 0], [0.04, 0.05, 0.06], [100, 0, 500], [512, 512]),
        ];
        const skel = new Skeleton('skeleton', ['nose', 'tail'], [[0, 1]]);
        const session = new Session(cams, skel, ['mouseA'], 'HighlightTest');

        const fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        const g = new InstanceGroup(1, 0);
        g.addInstance('cam1', new Instance([[10, 20], [30, 40]], 0, 'user', 1));
        g.addInstance('cam2', new Instance([[12, 22], [32, 42]], 0, 'user', 1));
        for (const [cn, inst] of g.instances) fg.addInstance(cn, inst);
        g.points3d = new Float64Array([0, 0, 10, 0, 0, 20]);
        session.instanceGroups.set(0, [g]);

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 1;
        AS.state.currentFrame = 0;

        const init = await import('/pose/initialization.js');
        init.setup3DViewport();
    });
    await page.waitForTimeout(600);

    const out = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const P = await import('/ui/plane-definition.js');
        const MO = await import('/ui/mesh-objects.js');
        const PM = await import('/import-export/plane-metadata.js');
        const OF = await import('/pose/origin-frame.js');
        const origin = await import('/ui/origin-definition.js');

        const res = {};
        res.hasViewport = !!AS.viewport3d;
        if (!AS.viewport3d) return res;

        // --- A cage: floor + one wall sharing an edge, plus a LONE plane ---
        // Deliberately off-origin and asymmetric, so a leaked transform cannot
        // coincidentally map a corner onto itself.
        PM.resetPlaneState();
        const model = P.planeModel();
        const floor = P.createPlane('floor');
        const wall = P.createPlane('wall');
        const lone = P.createPlane('lone');

        const mk = (name, xyz) => { const n = model.addNode(name); n.setPoint3d(xyz); return n; };
        const a = mk('a', [13, -7, 2]);
        const b = mk('b', [113, -7, 2]);
        const c = mk('c', [113, 93, 2]);
        const d = mk('d', [13, 93, 2]);
        const e = mk('e', [113, 93, 102]);
        const f = mk('f', [13, 93, 102]);
        const g1 = mk('g1', [500, 500, 500]);
        const g2 = mk('g2', [560, 500, 500]);
        const g3 = mk('g3', [560, 560, 500]);

        const ring = (plane, nodes) => {
            nodes.forEach(n => model.addNodeToPlane(plane, n.id));
            for (let i = 0; i < nodes.length; i++) {
                plane.addEdge(nodes[i].id, nodes[(i + 1) % nodes.length].id);
            }
        };
        ring(floor, [a, b, c, d]);
        ring(wall, [d, c, e, f]);       // shares the d-c edge with the floor
        ring(lone, [g1, g2, g3]);       // shares nothing, and is NOT a member

        // The planes carry their own fills, in their own colours — the
        // realistic case, and what makes "the highlight is additive" a real
        // claim rather than one asserted over an empty scene. `lone` is left
        // UNFILLED so the highlight is also shown to fill a member the user
        // never filled.
        floor.filled = true;
        wall.filled = true;

        // An object holding the floor and the wall only.
        document.getElementById('btnNewMeshObject').click();
        const obj = MO.getSelectedMeshObject();
        // Give the OBJECT a colour, so the highlight being a fixed yellow is
        // shown to be deliberate rather than a default nobody set.
        const colorInput = document.getElementById('meshObjectColor');
        colorInput.value = '#ff8800';
        colorInput.dispatchEvent(new Event('input', { bubbles: true }));
        res.objectColor = obj.color;

        const addSelect = () => document.getElementById('meshObjectAddPlaneSelect');
        const addBtn = () => document.getElementById('btnAddMeshObjectPlane');
        const addPlaneById = (id) => {
            addSelect().value = String(id);
            addBtn().click();
        };
        addPlaneById(floor.id);
        addPlaneById(wall.id);
        res.membership = obj.planeIds.slice();
        res.expectedMembership = [floor.id, wall.id];

        // --- Reading the scene ------------------------------------------
        const group = () => AS.viewport3d.scene.children
            .find(ch => ch.name === 'meshMembership');
        res.groupExists = !!group();

        // World positions of every highlighted CORNER, keyed by the plane id
        // its name carries. `updateMatrixWorld` because nothing has rendered
        // between the sync and this read.
        const highlightNodes = () => {
            const grp = group();
            if (!grp) return [];
            grp.updateMatrixWorld(true);
            return grp.children
                .filter(ch => /^meshMemberNode_/.test(ch.name))
                .map(ch => ({
                    planeId: Number(ch.name.split('_')[1]),
                    k: Number(ch.name.split('_')[2]),
                    pos: [ch.matrixWorld.elements[12],
                        ch.matrixWorld.elements[13],
                        ch.matrixWorld.elements[14]],
                    color: '#' + ch.material.color.getHexString(),
                }));
        };
        const edgeCount = () => {
            const grp = group();
            return grp ? grp.children.filter(ch => /^meshMemberEdge_/.test(ch.name)).length : 0;
        };
        // The FACES — the part that makes a member look like a member. Each
        // carries the plane id in its name and a triangle count in its
        // geometry, so "filled" can be asserted rather than assumed.
        const faces = () => {
            const grp = group();
            if (!grp) return [];
            return grp.children
                .filter(ch => /^meshMemberFace_/.test(ch.name))
                .map(ch => ({
                    planeId: Number(ch.name.split('_')[1]),
                    tris: ch.geometry.getAttribute('position').count / 3,
                    color: '#' + ch.material.color.getHexString(),
                    opacity: ch.material.opacity,
                    depthTest: ch.material.depthTest,
                    doubleSided: ch.material.side === 2,
                }));
        };

        P.syncPlanes3D();
        const lit = highlightNodes();
        res.litPlaneIds = Array.from(new Set(lit.map(h => h.planeId))).sort((x, y) => x - y);
        res.expectedLitPlaneIds = [floor.id, wall.id].sort((x, y) => x - y);
        res.loneIsLit = lit.some(h => h.planeId === lone.id);
        res.litNodeCount = lit.length;          // 4 floor + 4 wall
        res.litEdgeCount = edgeCount();         // 4 + 4
        res.litColor = lit.length ? lit[0].color : null;

        const litFaces = faces();
        res.faceCount = litFaces.length;
        res.facePlaneIds = litFaces.map(x => x.planeId).sort((x, y) => x - y);
        res.faceTris = litFaces.map(x => x.tris).sort();      // a quad fans to 2
        res.faceColors = Array.from(new Set(litFaces.map(x => x.color)));
        res.faceOpacity = litFaces.length ? litFaces[0].opacity : null;
        res.faceDepthTest = litFaces.length ? litFaces[0].depthTest : null;
        res.faceDoubleSided = litFaces.every(x => x.doubleSided);
        // The outline deliberately IGNORES depth while the face respects it.
        res.edgeDepthTest = (() => {
            const grp = group();
            const e = grp.children.find(ch => /^meshMemberEdge_/.test(ch.name));
            return e ? e.material.depthTest : null;
        })();
        // The planes' OWN fills are untouched — the highlight is additive.
        res.planeOwnFillColors = (() => {
            const pg = AS.viewport3d.scene.children.find(ch => ch.name === 'planes');
            const out = [];
            pg.traverse(ch => {
                if (ch.name === 'planeFill') out.push('#' + ch.material.color.getHexString());
            });
            return out.sort();
        })();

        // =================================================================
        // THE REGRESSION: a defined origin must not move the highlight.
        // =================================================================
        // A frame with a big translation AND a real rotation, so any leaked
        // transform shows up far outside float noise.
        const frame = OF.buildOriginFrame([137, -42, 19], [0, 1, 0.5]);
        res.frameBuilt = !!frame;
        origin.originState.frame = frame;
        AS.viewport3d.setOriginFrame(frame);    // the grid/axes DO move
        P.syncPlanes3D();

        const framed = highlightNodes();
        // Exact equality, not a tolerance: the highlight is drawn from the
        // same doubles as the plane, so there is no arithmetic to be off by.
        const nodeXyz = {};
        [[floor, [a, b, c, d]], [wall, [d, c, e, f]]].forEach(([plane, nodes]) => {
            nodeXyz[plane.id] = nodes.map(n => Array.from(n.xyz));
        });
        res.everyHighlightOnItsNode = framed.length > 0 && framed.every(h => {
            const want = nodeXyz[h.planeId] && nodeXyz[h.planeId][h.k];
            return !!want && want[0] === h.pos[0] && want[1] === h.pos[1] && want[2] === h.pos[2];
        });
        res.framedNodeCount = framed.length;
        // How far the OLD behaviour would have been out, reported so a failure
        // says something useful rather than just "false".
        res.worstDrift = framed.reduce((m, h) => {
            const want = (nodeXyz[h.planeId] || [])[h.k];
            if (!want) return m;
            return Math.max(m,
                Math.abs(want[0] - h.pos[0]),
                Math.abs(want[1] - h.pos[1]),
                Math.abs(want[2] - h.pos[2]));
        }, 0);

        // NEGATIVE CONTROL: the frame is genuinely in force. The DERIVED
        // geometry — what the panel quotes and both exporters write — is in
        // the origin frame, so its vertices are NOT the node coordinates.
        const geom = MO.meshObjectGeometry(obj);
        const nodeSet = [a, b, c, d, e, f].map(n => Array.from(n.xyz));
        const v0 = [geom.vertices[0], geom.vertices[1], geom.vertices[2]];
        res.derivedVertexIsElsewhere = !nodeSet.some(
            p => Math.abs(p[0] - v0[0]) < 1e-9 &&
                Math.abs(p[1] - v0[1]) < 1e-9 &&
                Math.abs(p[2] - v0[2]) < 1e-9);
        res.derivedFirstVertex = v0;

        origin.originState.frame = null;
        AS.viewport3d.setOriginFrame(null);
        P.syncPlanes3D();

        // =================================================================
        // The membership editor's feedback loop
        // =================================================================
        addPlaneById(lone.id);
        res.afterAddLit = Array.from(new Set(highlightNodes().map(h => h.planeId)))
            .sort((x, y) => x - y);
        res.expectedAfterAdd = [floor.id, wall.id, lone.id].sort((x, y) => x - y);
        // `lone` has `filled === false`, so it has no fill of its own. It still
        // gets a highlight face: what is being shown is MEMBERSHIP, not the
        // plane's display setting.
        res.afterAddFaces = faces().map(x => x.planeId).sort((x, y) => x - y);
        res.loneIsFilledByPlane = (() => {
            const pg = AS.viewport3d.scene.children.find(ch => ch.name === 'planes');
            let n = 0;
            pg.traverse(ch => { if (ch.name === 'planeFill') n++; });
            return n;    // still 2 — `lone` never gained a fill of its own
        })();

        const rows = () => Array.from(
            document.querySelectorAll('#meshObjectMembers .mesh-object-member'));
        rows()[2].querySelector('button').click();      // take `lone` back out
        res.afterRemoveLit = Array.from(new Set(highlightNodes().map(h => h.planeId)))
            .sort((x, y) => x - y);

        // Deselecting clears the highlight outright.
        MO.meshObjectState.selectedObjectId = null;
        P.syncPlanes3D();
        res.clearedNodeCount = highlightNodes().length;
        res.clearedEdgeCount = edgeCount();
        res.groupStillThere = !!group();

        return res;
    });

    console.log('\n--- 1. The selection lights up its member planes ---');
    check(out.hasViewport === true,
        'a real Viewport3D came up (without this every check below is vacuous)');
    if (out.hasViewport) {
        check(out.groupExists === true, 'the scene has a meshMembership group');
        check(eq(out.membership, out.expectedMembership), 'the object holds floor + wall');
        check(eq(out.litPlaneIds, out.expectedLitPlaneIds),
            'and exactly those planes are highlighted');
        check(out.loneIsLit === false,
            'a plane that is NOT a member is left alone — the negative control');
        check(out.litNodeCount === 8, 'every member corner is marked (4 + 4)');
        check(out.litEdgeCount === 8, 'and every member edge (4 + 4)');

        console.log('\n--- 1b. The member FACES are filled, which is what reads ---');
        check(out.faceCount === 2, 'each member plane gets a filled face');
        check(eq(out.facePlaneIds, out.expectedLitPlaneIds),
            'for the members and only the members');
        check(eq(out.faceTris, [2, 2]), 'fanned over the plane\'s own ring (a quad -> 2 tris)');
        check(eq(out.faceColors, ['#ffe600']),
            'in ONE fixed yellow: ' + JSON.stringify(out.faceColors));
        check(out.litColor === '#ffe600', 'and the corners and outline match it');
        check(out.objectColor === '#ff8800',
            'NOT the object\'s own colour, which is set to something else entirely — ' +
            'a highlight has to be legible against whatever the planes are wearing');
        check(out.faceOpacity > 0.28,
            'more opaque than the plane fills it covers (' + out.faceOpacity + ' > 0.28)');
        check(out.faceDoubleSided === true, 'and double-sided, like the fill it sits on');
        check(out.faceDepthTest === true,
            'the FACE respects depth, or the cage\'s back walls would paint over its front');
        check(out.edgeDepthTest === false,
            'while the outline ignores it, so an occluded member still announces itself');
        check(out.planeOwnFillColors.length === 2 &&
            out.planeOwnFillColors.every(c => c !== '#ffe600'),
            'NEGATIVE CONTROL: the planes\' own two fills are still there in their own ' +
            'colours — the highlight is ADDITIVE, not a recolour (' +
            JSON.stringify(out.planeOwnFillColors) + ')');

        console.log('\n--- 2. THE REGRESSION: an origin must not move the highlight ---');
        check(out.frameBuilt === true, 'a frame with a translation and a rotation was built');
        check(out.framedNodeCount === 8, 'the highlight survives the frame being set');
        check(out.everyHighlightOnItsNode === true,
            'and every corner sits EXACTLY on its plane node, drift ' + out.worstDrift);
        check(out.derivedVertexIsElsewhere === true,
            'NEGATIVE CONTROL: the frame is really in force — the derived geometry the ' +
            'panel and the exporters use is elsewhere (' +
            JSON.stringify(out.derivedFirstVertex.map(v => Math.round(v * 100) / 100)) + ')');

        console.log('\n--- 3. Editing membership changes what is lit ---');
        check(eq(out.afterAddLit, out.expectedAfterAdd), '+ Add lights the plane up');
        check(eq(out.afterAddFaces, out.expectedAfterAdd),
            'including a face for a member the user never FILLED — membership is what ' +
            'is being shown, not the plane\'s own display setting');
        check(out.loneIsFilledByPlane === 2,
            'and that plane still has no fill of its own (2, unchanged) — the highlight ' +
            'did not reach into the plane drawing to make one');
        check(eq(out.afterRemoveLit, out.expectedLitPlaneIds), 'and a member\'s x puts it out');
        check(out.clearedNodeCount === 0 && out.clearedEdgeCount === 0,
            'deselecting clears the highlight');
        check(out.groupStillThere === true, 'but keeps the group, ready for the next selection');
    }

    console.log(fails === 0 ? '\nPASS — 0 failure(s)' : `\nFAIL — ${fails} failure(s)`);
} catch (err) {
    console.log('  ✗ threw: ' + (err && err.message ? err.message : String(err)));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
process.exit(fails === 0 ? 0 : 1);
