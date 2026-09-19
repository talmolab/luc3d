/**
 * mesh-object-roundtrip.mjs — 3D Mesh Objects in the real app.
 *
 * A 3D Mesh Object is the third layer of the plane model: a node is a point, a
 * plane is a group of nodes, and an object is a group of PLANES whose shape is
 * derived from which nodes those planes share. `tests/test-mesh-object-*.mjs`
 * pin the model and the geometry away from the DOM; this file pins the parts
 * only the real app can show:
 *
 *  1. The panel drives the model — creating, naming, colouring, checking planes
 *     in and out and flipping normals all go through the real handlers, and each
 *     marks the project unsaved.
 *  2. The table reports the SHAPE, not just the membership: the badge and the
 *     report change when the planes stop being joined.
 *  3. Save -> reopen brings the objects back by ID, through a real `.slp`, with
 *     membership pointing at the same planes.
 *  4. The scope is PROJECT: the key is written into every session's
 *     `metadata.lucid`, like `planes` and unlike `planePlacements`.
 *
 * Three negative controls, because "it came back non-empty" is not the bar:
 *   * a project that never made an object writes NO `meshObjects` key, so
 *     `save-golden-digest` cannot move for anyone not using the feature;
 *   * the whole feature is ADDITIVE — deleting a member plane must leave the
 *     plane model exactly as it would be with no objects present, and must not
 *     be cascaded into the object;
 *   * removing an object must not remove its planes or their nodes.
 *
 * Run: node mesh-object-roundtrip.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8214);

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
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    const out = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const P = await import('/ui/plane-definition.js');
        const MO = await import('/ui/mesh-objects.js');
        const PM = await import('/import-export/plane-metadata.js');
        const fileio = await import('/import-export/file-io.js');
        const saveLoad = await import('/import-export/save-load.js');
        const { Skeleton, Camera, Instance, FrameGroup, Session } = pd;

        const NODES = 3;
        const skelOf = () => new Skeleton('skeleton',
            Array.from({ length: NODES }, (_, i) => 'n' + i), []);

        const SPECS = [
            { name: 'sessA', cams: ['camA1', 'camA2'], nFrames: 2, fx: 900 },
            { name: 'sessB', cams: ['camB1', 'camB2'], nFrames: 2, fx: 950 },
        ];

        function buildSession(spec) {
            const cams = spec.cams.map((cn, ci) => new Camera(
                cn, [[spec.fx, 0, 128], [0, spec.fx, 128], [0, 0, 1]],
                [0, 0, 0, 0, 0], [0, 0.1 * ci, 0], [10 * ci, 0, 0], [256, 256]));
            const session = new Session(cams, skelOf(), ['t0'], spec.name);
            for (let f = 0; f < spec.nFrames; f++) {
                const fg = new FrameGroup(f);
                session.addFrameGroup(fg);
                for (const cn of spec.cams) {
                    const pts = Array.from({ length: NODES }, (_, k) => [50 + k + f, 60 + k + f]);
                    fg.addInstance(cn, new Instance(pts, 0, 'predicted', 0.9));
                }
            }
            return session;
        }
        const viewsFor = (spec) => spec.cams.map(cn =>
            ({ name: cn, videoWidth: 256, videoHeight: 256, frameCount: spec.nFrames }));
        const videoFilesFor = (spec) => spec.cams.map(cn =>
            ({ name: cn, assignedCamera: cn, videoPath: cn + '.mp4' }));

        const res = {};
        const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
        // The page has its own scope; the Node-side `eq` is not in it.
        const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

        // =============================================================
        // A cage: floor + back wall + side wall, joined by SHARED nodes —
        // the geometry in the screenshot that prompted this feature.
        // =============================================================
        PM.resetPlaneState();
        const sessions = SPECS.map(buildSession);
        AS.state.sessions = sessions;
        AS.state.videoFiles = SPECS.flatMap(videoFilesFor);
        AS.state.session = sessions[0];
        AS.state.activeSessionIdx = 0;
        AS.state.views = viewsFor(SPECS[0]);

        const model = P.planeModel();
        const floor = P.createPlane('floor');
        const back = P.createPlane('back');
        const side = P.createPlane('side');

        // Corner nodes. `c03`/`c04` are SHARED, which is what joins the walls
        // to the floor and to each other.
        const mk = (name, xyz) => { const n = model.addNode(name); n.setPoint3d(xyz); return n; };
        const c0 = mk('c0', [0, 0, 0]);
        const c1 = mk('c1', [1, 0, 0]);
        const c2 = mk('c2', [1, 1, 0]);
        const c3 = mk('c3', [0, 1, 0]);
        const c4 = mk('c4', [0, 1, 1]);
        const c5 = mk('c5', [1, 1, 1]);
        const c6 = mk('c6', [0, 0, 1]);

        const ring = (plane, nodes) => {
            nodes.forEach(n => model.addNodeToPlane(plane, n.id));
            for (let i = 0; i < nodes.length; i++) {
                plane.addEdge(nodes[i].id, nodes[(i + 1) % nodes.length].id);
            }
        };
        ring(floor, [c0, c1, c2, c3]);
        ring(back, [c3, c2, c5, c4]);     // shares the c3-c2 edge with the floor
        ring(side, [c0, c3, c4, c6]);     // shares c0-c3 with the floor, c3-c4 with the back

        P.refreshPlanePanel();

        // =============================================================
        // 1. The panel creates and edits the object
        // =============================================================
        saveLoad.clearDirty();
        res.dirtyBefore = AS.state.isDirty;

        document.getElementById('btnNewMeshObject').click();
        res.dirtyAfterCreate = AS.state.isDirty;
        res.objectCount = model.meshObjects.size;
        const obj = model.meshObjects.objects[0];
        res.autoSelected = MO.meshObjectState.selectedObjectId === obj.id;
        res.editorVisible = document.getElementById('meshObjectEditor').style.display !== 'none';

        // Rename + recolour through the real inputs.
        const nameInput = document.getElementById('meshObjectName');
        nameInput.value = 'cage';
        fire(nameInput, 'input');
        fire(nameInput, 'change');
        res.renamed = obj.name;

        const colorInput = document.getElementById('meshObjectColor');
        colorInput.value = '#ff8800';
        fire(colorInput, 'input');
        fire(colorInput, 'change');
        res.recolored = obj.color;

        // Membership: one checkbox per plane in the project.
        const boxes = () => Array.from(
            document.querySelectorAll('#meshObjectMembers input[type=checkbox]'));
        res.memberRowCount = boxes().length;

        saveLoad.clearDirty();
        boxes()[0].checked = true; fire(boxes()[0], 'change');
        res.dirtyAfterMembership = AS.state.isDirty;
        boxes()[1].checked = true; fire(boxes()[1], 'change');
        boxes()[2].checked = true; fire(boxes()[2], 'change');
        res.membership = obj.planeIds.slice();
        res.expectedMembership = [floor.id, back.id, side.id];

        // =============================================================
        // 2. The table reports the SHAPE
        // =============================================================
        const badgeText = () => {
            const row = document.querySelector('#meshObjectsTable tbody tr .mesh-object-badge');
            return row ? row.textContent : null;
        };
        const reportText = () =>
            document.getElementById('meshObjectReport').textContent;

        res.joinedBadge = badgeText();
        res.joinedReport = reportText();
        res.joinedGeom = (() => {
            const g = MO.meshObjectGeometry(obj);
            return {
                vertices: g.vertices.length / 3,
                faces: g.faces.length,
                shells: g.connectivity.shells,
                naked: g.connectivity.nakedEdges,
                closed: g.connectivity.isClosed,
            };
        })();

        // Un-check the side wall: the remaining two still share an edge, so it
        // is still ONE shell — membership changed, topology tracked it.
        boxes()[2].checked = false; fire(boxes()[2], 'change');
        res.twoFaceGeom = (() => {
            const g = MO.meshObjectGeometry(obj);
            return { faces: g.faces.length, shells: g.connectivity.shells, vertices: g.vertices.length / 3 };
        })();
        boxes()[2].checked = true; fire(boxes()[2], 'change');

        // Flip normals is stored on the object, because for an OPEN cage
        // nothing can derive which side is outside.
        saveLoad.clearDirty();
        const flipBox = document.getElementById('meshObjectFlip');
        flipBox.checked = true; fire(flipBox, 'change');
        res.dirtyAfterFlip = AS.state.isDirty;
        res.flipStored = obj.flipNormals;

        // =============================================================
        // 3. A DISJOINT object is reported as such
        // =============================================================
        const lone = P.createPlane('lonely');
        const l = [mk('l0', [9, 9, 0]), mk('l1', [10, 9, 0]), mk('l2', [10, 10, 0])];
        ring(lone, l);
        const obj2 = model.meshObjects.createObject('two bits');
        obj2.addPlane(floor.id);
        obj2.addPlane(lone.id);
        MO.meshObjectState.selectedObjectId = obj2.id;
        P.refreshPlanePanel();
        res.disjointShells = MO.meshObjectGeometry(obj2).connectivity.shells;
        res.disjointReport = reportText();
        model.meshObjects.deleteObject(obj2);
        MO.meshObjectState.selectedObjectId = obj.id;
        P.refreshPlanePanel();

        // =============================================================
        // 4. The 3D viewport gets the surface only while selected
        // =============================================================
        // A bare page has no Viewport3D — one is only built by `setup3DViewport`
        // on a real session load, and it needs WebGL. What is worth pinning here
        // is the WIRING: that `syncPlanes3D` pushes the selected object's derived
        // geometry and pushes NULL when nothing is selected. The THREE side of
        // `setMeshObject` is exercised by the viewport's own e2e coverage.
        {
            const realVp = AS.viewport3d;
            res.hadRealViewport = !!realVp;
            const captured = [];
            AS.setViewport3D({
                setPlanes() {},
                setOriginFrame() {},
                setMeshObject(p) {
                    captured.push(p === null ? null : {
                        color: p.color,
                        vertices: p.vertices.length / 3,
                        triangles: p.triangles.length / 3,
                        faces: p.faces.length,
                    });
                },
            });
            P.syncPlanes3D();                                   // selected
            MO.meshObjectState.selectedObjectId = null;
            P.syncPlanes3D();                                   // nothing selected
            MO.meshObjectState.selectedObjectId = obj.id;
            P.syncPlanes3D();                                   // selected again
            res.captured = captured;
            AS.setViewport3D(realVp);
        }

        // =============================================================
        // 5. Save -> reopen, through a real .slp
        // =============================================================
        async function readBack(bytes, name) {
            const parsed = await fileio.parseSlpViaSleapIO(new File([bytes], name));
            return (parsed.sessions || []).map(s => ({
                sessionName: s.sessionName,
                lucid: (s.metadata && s.metadata.lucid) || {},
                presentKeys: PM.PLANE_METADATA_KEYS.filter(
                    k => ((s.metadata && s.metadata.lucid) || {})[k] !== undefined),
            }));
        }

        const labels = fileio.buildSlpLabelsAllViews(
            sessions[0], viewsFor(SPECS[0]), videoFilesFor(SPECS[0]));
        const raw = await readBack(await window.SleapIO.saveSlpToBytes(labels), 'cage.slp');
        res.writtenKeys = raw[0] ? raw[0].presentKeys : ['<no session>'];
        res.writtenObjects = raw[0] ? raw[0].lucid.meshObjects : null;

        // Ingest exactly as the importer does: reset, then read each session.
        PM.resetPlaneState();
        res.afterReset = P.planeModel().meshObjects.size;
        const fresh = raw.map((s, i) => new Session([], skelOf(), ['t0'], 'reopened' + i));
        raw.forEach((s, i) => PM.readPlaneMetadata(fresh[i], s.lucid));

        const back2 = P.planeModel();
        const robj = back2.meshObjects.objects[0];
        res.reopened = robj ? {
            count: back2.meshObjects.size,
            id: robj.id,
            name: robj.name,
            color: robj.color,
            flipNormals: robj.flipNormals,
            planeIds: robj.planeIds.slice(),
            planeCount: robj.planeCount(back2),
            dangling: robj.danglingCount(back2),
        } : null;
        res.originalId = obj.id;
        res.originalPlaneIds = [floor.id, back.id, side.id];
        // The derived shape has to come back too — it is rebuilt, not stored.
        res.reopenedGeom = robj ? (() => {
            const g = MO.meshObjectGeometry(robj);
            return { vertices: g.vertices.length / 3, faces: g.faces.length, shells: g.connectivity.shells };
        })() : null;

        // =============================================================
        // 6. PROJECT scope: every session's dict carries the same objects
        // =============================================================
        {
            PM.resetPlaneState();
            PM.readPlaneMetadata(sessions[0], raw[0].lucid);
            AS.state.session = sessions[0];
            const dictA = {}, dictB = {};
            PM.writePlaneMetadata(dictA, sessions[0]);
            PM.writePlaneMetadata(dictB, sessions[1]);
            res.scopeSameObjects = eq(dictA.meshObjects, dictB.meshObjects);
            res.scopeBothPresent = dictA.meshObjects !== undefined && dictB.meshObjects !== undefined;
        }

        // =============================================================
        // 7. NEGATIVE CONTROL: an untouched project writes no key
        // =============================================================
        {
            PM.resetPlaneState();
            const plain = buildSession({ ...SPECS[0], name: 'plain' });
            const plainLabels = fileio.buildSlpLabelsAllViews(
                plain, viewsFor(SPECS[0]), videoFilesFor(SPECS[0]));
            const backPlain = await readBack(
                await window.SleapIO.saveSlpToBytes(plainLabels), 'plain.slp');
            res.untouchedKeys = backPlain[0] ? backPlain[0].presentKeys : ['<no session>'];
        }

        // =============================================================
        // 8. NEGATIVE CONTROL: the feature is ADDITIVE
        // =============================================================
        {
            // Snapshot of everything the plane model exposes, so "identical"
            // means identical rather than "looks similar".
            const snap = (m) => JSON.stringify({
                planes: m.planes.map(p => ({
                    id: p.id, name: p.name, nodeIds: p.nodeIds.slice(),
                    edges: p.edges.map(e => [e[0], e[1]]),
                })),
                nodes: m.pool.nodes.map(n => ({ id: n.id, name: n.name })),
            });

            const build = (withObject) => {
                PM.resetPlaneState();
                const m = P.planeModel();
                const f = P.createPlane('f');
                const w = P.createPlane('w');
                const n1 = m.addNode('x'); n1.setPoint3d([0, 0, 0]);
                const n2 = m.addNode('y'); n2.setPoint3d([1, 0, 0]);
                const n3 = m.addNode('z'); n3.setPoint3d([1, 1, 0]);
                [n1, n2, n3].forEach(n => { m.addNodeToPlane(f, n.id); m.addNodeToPlane(w, n.id); });
                if (withObject) {
                    const o = m.meshObjects.createObject('grp');
                    o.addPlane(f.id); o.addPlane(w.id);
                }
                m.deletePlane(f);        // the operation that would need a cascade
                return { snap: snap(m), objs: m.meshObjects.objects.map(o => o.planeIds.slice()) };
            };

            const plainRun = build(false);
            const groupedRun = build(true);
            res.additiveIdentical = plainRun.snap === groupedRun.snap;
            // No cascade ran: the object still names the deleted plane, and the
            // lazy resolve is what makes that harmless.
            res.noCascade = groupedRun.objs[0].length === 2;

            // Removing an object keeps its planes and their nodes.
            PM.resetPlaneState();
            const m2 = P.planeModel();
            const pp = P.createPlane('keepme');
            const nn = m2.addNode('keepnode'); nn.setPoint3d([0, 0, 0]);
            m2.addNodeToPlane(pp, nn.id);
            const oo = m2.meshObjects.createObject('doomed');
            oo.addPlane(pp.id);
            MO.meshObjectState.selectedObjectId = oo.id;
            P.refreshPlanePanel();
            document.querySelector('#meshObjectsTable tbody tr .plane-actions button').click();
            res.afterObjectDelete = {
                objects: m2.meshObjects.size,
                planes: m2.planes.length,
                nodes: m2.pool.size,
                selection: MO.meshObjectState.selectedObjectId,
            };
        }

        return res;
    });

    // =========================================================
    console.log('\n--- 1. The panel drives the model ---');
    // =========================================================
    check(out.dirtyBefore === false, 'the project starts saved');
    check(out.dirtyAfterCreate === true, '+ New 3D Mesh Object marks it unsaved');
    check(out.objectCount === 1, 'and creates exactly one object');
    check(out.autoSelected === true, 'the new object is selected');
    check(out.editorVisible === true, 'so its editor is shown');
    check(out.renamed === 'cage', 'the name input renames it');
    check(out.recolored === '#ff8800', 'the colour input recolours it');
    check(out.memberRowCount === 3, 'the membership list has a row per plane in the project');
    check(out.dirtyAfterMembership === true, 'checking a plane in marks the project unsaved');
    check(eq(out.membership, out.expectedMembership),
        'and membership is stored as PLANE IDS, in the order they were checked');
    check(out.dirtyAfterFlip === true, 'flipping normals marks the project unsaved');
    check(out.flipStored === true, 'and is stored on the object');

    // =========================================================
    console.log('\n--- 2. The table reports the derived SHAPE ---');
    // =========================================================
    check(out.joinedGeom.vertices === 7,
        'the cage welds to seven vertices — the shared corners are one node each');
    check(out.joinedGeom.faces === 3, 'three faces');
    check(out.joinedGeom.shells === 1, 'ONE shell: the three planes are genuinely joined');
    check(out.joinedGeom.closed === false, 'open, as a cage with no lid must be');
    check(/open/.test(out.joinedBadge || ''), 'the badge says open: ' + out.joinedBadge);
    check(/7 vertices/.test(out.joinedReport), 'the report states the vertex count');
    check(/belong to only one face/.test(out.joinedReport),
        'and explains what a naked edge IS, rather than only naming it');
    check(/naked/.test(out.joinedBadge || ''), 'while the badge stays terse');

    check(out.twoFaceGeom.faces === 2, 'un-checking a plane drops its face');
    check(out.twoFaceGeom.shells === 1, 'the remaining two still share an edge, so still one shell');
    check(out.twoFaceGeom.vertices === 6, 'and the vertex set shrinks to the six they use');

    // =========================================================
    console.log('\n--- 3. Planes that share nothing are reported as separate shells ---');
    // =========================================================
    check(out.disjointShells === 2, 'a floor plus an unconnected plane is TWO shells');
    check(/shells/.test(out.disjointReport), 'the report says so');
    check(/SHARE a node/.test(out.disjointReport), 'and says what joining actually requires');

    // =========================================================
    console.log('\n--- 4. The viewport surface follows the selection ---');
    // =========================================================
    check(out.captured.length === 3, 'syncPlanes3D pushes the object on every call');
    check(out.captured[0] && out.captured[0].vertices === 7 && out.captured[0].faces === 3,
        'a selected object is pushed with its derived geometry: ' + JSON.stringify(out.captured[0]));
    check(out.captured[0] && out.captured[0].color === '#ff8800', 'in the object\'s colour');
    check(out.captured[0] && out.captured[0].triangles === 6, 'ear-clipped to 6 triangles (3 quads)');
    check(out.captured[1] === null, 'and NULL is pushed when nothing is selected');
    check(eq(out.captured[0], out.captured[2]), 're-selecting pushes the same geometry again');

    // =========================================================
    console.log('\n--- 5. Save -> reopen ---');
    // =========================================================
    check(out.writtenKeys.indexOf('meshObjects') >= 0,
        'meshObjects is written: ' + JSON.stringify(out.writtenKeys));
    check(Array.isArray(out.writtenObjects) && out.writtenObjects.length === 1,
        'one object on disk');
    check(out.afterReset === 0, 'resetPlaneState empties the objects first');
    check(out.reopened !== null, 'an object comes back');
    check(out.reopened.count === 1, 'exactly one');
    check(out.reopened.id === out.originalId, 'with the ID from the file, not a fresh one');
    check(out.reopened.name === 'cage', 'its name');
    check(out.reopened.color === '#ff8800', 'its colour');
    check(out.reopened.flipNormals === true, 'and its flipNormals');
    check(eq(out.reopened.planeIds, out.originalPlaneIds),
        'membership points at the same plane IDs, in order');
    check(out.reopened.dangling === 0, 'every member resolves');
    check(eq(out.reopenedGeom, { vertices: 7, faces: 3, shells: 1 }),
        'and the DERIVED shape rebuilds identically — it was never stored');

    // =========================================================
    console.log('\n--- 6. Objects are PROJECT-scoped ---');
    // =========================================================
    check(out.scopeBothPresent === true, 'both sessions carry the key');
    check(out.scopeSameObjects === true,
        'with identical bytes — unlike planePlacements, this is not per session');

    // =========================================================
    console.log('\n--- 7. NEGATIVE CONTROL: untouched projects write nothing ---');
    // =========================================================
    check(eq(out.untouchedKeys, []),
        'a project that never opened the feature writes NO plane keys at all: ' +
        JSON.stringify(out.untouchedKeys));

    // =========================================================
    console.log('\n--- 8. NEGATIVE CONTROL: the feature is additive ---');
    // =========================================================
    check(out.additiveIdentical === true,
        'deleting a member plane leaves the plane model byte-identical to a run with no objects');
    check(out.noCascade === true,
        'no cascade ran — the object still names the deleted plane, and resolves lazily');
    check(out.afterObjectDelete.objects === 0, 'deleting an object removes the grouping');
    check(out.afterObjectDelete.planes === 1, 'but NOT its planes');
    check(out.afterObjectDelete.nodes === 1, 'and NOT their nodes');
    check(out.afterObjectDelete.selection === null, 'and the selection is cleared');

} catch (e) {
    console.log('  ✗ threw: ' + ((e && e.stack) || e));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS — 0 failure(s)' : `\nFAIL — ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
