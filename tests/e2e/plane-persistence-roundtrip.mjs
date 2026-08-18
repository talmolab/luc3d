/**
 * plane-persistence-roundtrip.mjs — Define Planes state, saved and reopened.
 *
 * Until `import-export/plane-metadata.js` landed, nothing the Define Planes
 * pipeline produced reached the project file: nodes, planes, the per-view 2D,
 * the triangulated 3D, the plane fit and the origin frame all lived only in
 * memory, and plane edits deliberately did NOT mark the project dirty because
 * flagging a project dirty for state a save would drop is worse than losing it.
 * This test pins the two halves of undoing that, in the real app:
 *
 *  1. Every plane/node MUTATION marks the project unsaved — and the plane
 *     panel's display sliders, which are browser-local taste and are NOT
 *     written to the file, do not.
 *  2. Save -> reopen brings all of it back, through both `.slp` writers, with
 *     the identities intact: the corner two planes SHARE is still one node,
 *     a point still sits on its own node rather than its neighbour's, a pinned
 *     coordinate is still pinned and still has its value, and the origin frame
 *     rebuilds to the same rotation.
 *
 * The scope split is the part that is easy to get wrong and is asserted
 * directly: the pool / planes / origin are PROJECT-scoped and so are written
 * identically into every session's `metadata.lucid`, while the per-view 2D is
 * SESSION-scoped and must not leak between sessions.
 *
 * Two negative controls, because "it came back non-empty" is not the bar:
 *   * a project that never opened the feature writes NONE of the keys, so
 *     untouched projects keep producing identical bytes (save-golden-digest);
 *   * a load into a model that still holds the previous project must REPLACE
 *     it — `resetPlaneState()` is what makes that true, and skipping it keeps
 *     the old planes and silently drops the new ones.
 *
 * Run: node plane-persistence-roundtrip.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8191);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol);

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
        const O = await import('/ui/origin-definition.js');
        const PM = await import('/import-export/plane-metadata.js');
        const fileio = await import('/import-export/file-io.js');
        const saveLoad = await import('/import-export/save-load.js');
        const lazyMod = await import('/loading/sio-lazy-loader.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const SioLazyLoader = lazyMod.SioLazyLoader || lazyMod.default;

        const NODES = 4;
        const skelOf = () => new Skeleton('skeleton',
            Array.from({ length: NODES }, (_, i) => 'n' + i),
            Array.from({ length: NODES - 1 }, (_, i) => [i, i + 1]));

        // Two sessions with DISTINCT camera names, so a per-view 2D leak
        // between them is visible rather than plausible.
        const SPECS = [
            { name: 'sessA', cams: ['a_cam0', 'a_cam1'], fx: 1000, nFrames: 3 },
            { name: 'sessB', cams: ['b_cam0', 'b_cam1'], fx: 2000, nFrames: 2 },
        ];

        function buildSession(spec) {
            const mtx = [[spec.fx, 0, 128], [0, spec.fx, 128], [0, 0, 1]];
            const cams = spec.cams.map((cn, ci) =>
                new Camera(cn, mtx, [0, 0, 0, 0, 0], [0, 0.1 * ci, 0], [10 * ci, 0, 0], [256, 256]));
            const session = new Session(cams, skelOf(), ['t0'], spec.name);
            for (let f = 0; f < spec.nFrames; f++) {
                const fg = new FrameGroup(f); session.addFrameGroup(fg);
                const g = new InstanceGroup(f * 10 + 1, -1);
                for (const cn of spec.cams) {
                    const pts = Array.from({ length: NODES }, (_, k) => [50 + k + f, 60 + k + f]);
                    const inst = new Instance(pts, 0, 'predicted', 0.9);
                    g.addInstance(cn, inst); fg.addInstance(cn, inst);
                }
                session.instanceGroups.set(f, [g]);
            }
            return session;
        }
        const viewsFor = (spec) => spec.cams.map(cn =>
            ({ name: cn, videoWidth: 256, videoHeight: 256, frameCount: spec.nFrames }));
        const videoFilesFor = (spec) => spec.cams.map(cn =>
            ({ name: cn, assignedCamera: cn, videoPath: cn + '.mp4' }));

        /** Make `session` the active one, with its views installed. */
        function activate(session, spec) {
            AS.state.session = session;
            AS.state.activeSessionIdx = AS.state.sessions.indexOf(session);
            AS.state.views = viewsFor(spec);
        }

        const res = {};

        // =============================================================
        // Build a project: two planes sharing an edge, placed on both
        // sessions, triangulated-looking 3D, a pin, a fill, an origin.
        // =============================================================
        PM.resetPlaneState();
        const sessions = SPECS.map(buildSession);
        AS.state.sessions = sessions;
        AS.state.videoFiles = SPECS.flatMap(videoFilesFor);
        activate(sessions[0], SPECS[0]);

        const model = P.planeModel();
        const floor = P.createPlane('floor');
        const wall = P.createPlane('wall');
        const a0 = model.createNodeInPlane('a0', floor);
        const s0 = model.createNodeInPlane('s0', floor);
        const s1 = model.createNodeInPlane('s1', floor);
        const a1 = model.createNodeInPlane('a1', floor);
        // s0/s1 join the wall too — ONE node each, which is the entire point
        // of the global pool and the thing a bad restore splits apart.
        model.addNodeToPlane(wall, s0.id);
        model.addNodeToPlane(wall, s1.id);
        const b0 = model.createNodeInPlane('b0', wall);

        floor.addEdge(a0.id, s0.id);
        floor.addEdge(s0.id, s1.id);
        floor.addEdge(s1.id, a1.id);
        floor.filled = true;
        a0.setPoint3d([0, 0, 0]);
        s0.setPoint3d([10, 0, 0]);
        s1.setPoint3d([10, 10, 0]);
        a1.setPoint3d([0, 10, 0]);
        a0.error = 0.42;
        model.pool.setImmutable(s1.id, true);
        floor.triangulation = { views: ['a_cam0', 'a_cam1'], nNodes: 4, meanError: 0.75 };
        floor.planeFit = { centroid: [5, 5, 0], normal: [0, 0, 1], rms: 0.01, nPoints: 4 };

        // Per-view 2D on session A, with a nulled and a reprojected corner.
        P.placePlaneOnView(floor, 'a_cam0', 120, 120);
        P.placePlaneOnView(wall, 'a_cam0', 80, 80);
        P.placePlaneOnView(floor, 'a_cam1', 140, 100);
        const instA0 = model.getInstance('a_cam0');
        const poolIdx = (id) => model.pool.indexOf(id);
        [[a0, 100, 200], [s0, 110, 205], [s1, 120, 210], [a1, 130, 215], [b0, 140.5, 220.25]]
            .forEach(([n, x, y]) => instA0.setPoint(poolIdx(n.id), x, y));
        instA0.nulledNodes.add(poolIdx(a1.id));
        instA0.setNodeDerived(poolIdx(b0.id), true);

        // …and DIFFERENT 2D on session B, on its own cameras.
        activate(sessions[1], SPECS[1]);
        P.planeModel();                       // re-binds the model to sessB's map
        P.placePlaneOnView(wall, 'b_cam0', 60, 60);
        const instB0 = model.getInstance('b_cam0');
        instB0.setPoint(poolIdx(s0.id), 11, 22);
        instB0.setPoint(poolIdx(b0.id), 33, 44);

        activate(sessions[0], SPECS[0]);
        P.planeModel();

        // The origin: a corner of the fitted floor, +Z along its normal.
        const originFrame = (await import('/pose/origin-frame.js'))
            .buildOriginFrame([10, 10, 0], [0, 0, 1]);
        originFrame.sourcePlane = 'floor';
        originFrame.sourceNode = 's1';
        O.originState.frame = originFrame;

        const IDS = {
            floor: floor.id, wall: wall.id,
            a0: a0.id, s0: s0.id, s1: s1.id, a1: a1.id, b0: b0.id,
        };
        res.ids = IDS;

        // =============================================================
        // 1. Edits mark the project unsaved
        // =============================================================
        {
            const dirtyOf = (fn) => {
                saveLoad.clearDirty();
                fn();
                return AS.state.isDirty === true;
            };
            res.dirty = {
                createPlane: dirtyOf(() => { const p = P.createPlane('scratch'); P.deletePlane(p.id); }),
                deletePlane: dirtyOf(() => {
                    const p = P.createPlane('scratch2');
                    saveLoad.clearDirty();
                    P.deletePlane(p.id);
                }),
                renameNode: dirtyOf(() => {
                    // Exactly what the Nodes-table input's change handler does.
                    a0.name = 'a0';
                    document.getElementById('planePanel') && null;
                }),
                place: dirtyOf(() => {
                    P.unplacePlaneFromView(wall, 'a_cam0');
                    saveLoad.clearDirty();
                    P.placePlaneOnView(wall, 'a_cam0', 80, 80);
                }),
                unplace: dirtyOf(() => P.unplacePlaneFromView(wall, 'a_cam0')),
            };
            P.placePlaneOnView(wall, 'a_cam0', 80, 80);   // put it back
            // The display sliders are browser-local taste and are NOT written
            // to the project, so they must NOT mark it dirty.
            saveLoad.clearDirty();
            P.planeState.nodeSize = 9;
            P.planeState.edgeWidth = 4;
            P.planeState.nodeSize3d = 7;
            res.dirty.sliderStaysClean = AS.state.isDirty === false;
        }

        // The real DOM handlers, driven through the panel rather than
        // simulated — this is what catches a handler that mutates without
        // marking. Requires the panel to exist and a plane to be selected.
        {
            P.planeState.selectedPlaneId = floor.id;
            P.refreshPlanePanel();
            const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
            const nameInput = document.querySelector('#planeNodesTable .plane-text-input');
            const colorInput = document.querySelector('#planeNodesTable .plane-node-color');
            const pinInput = document.querySelector('#planeNodesTable .plane-node-pin');
            res.panelDirty = {};
            if (nameInput) {
                saveLoad.clearDirty();
                nameInput.value = 'renamed-in-panel';
                fire(nameInput, 'change');
                res.panelDirty.rename = AS.state.isDirty === true;
                res.panelDirty.renameTook = model.pool.nodeAt(0).name === 'renamed-in-panel';
                model.pool.nodeAt(0).name = 'a0';
            }
            if (colorInput) {
                saveLoad.clearDirty();
                colorInput.value = '#123456';
                fire(colorInput, 'change');
                res.panelDirty.color = AS.state.isDirty === true;
            }
            if (pinInput) {
                saveLoad.clearDirty();
                pinInput.checked = !pinInput.checked;
                fire(pinInput, 'change');
                res.panelDirty.pin = AS.state.isDirty === true;
                pinInput.checked = !pinInput.checked;
                fire(pinInput, 'change');
            }
            // The fill button is a plane-state edit too.
            const fillBtn = document.getElementById('btnPlaneFill');
            if (fillBtn && !fillBtn.disabled) {
                saveLoad.clearDirty();
                fillBtn.click();
                res.panelDirty.fill = AS.state.isDirty === true;
                fillBtn.click();                       // restore `filled: true`
            }
            // Re-assert the fixture: the panel poking above must not change
            // what the round trip is measured against. The pin handler clears
            // the fit of every plane standing on that node (pinning changes
            // what a fit is allowed to do), so the fit has to be put back.
            model.pool.setImmutable(IDS.s1, true);
            floor.filled = true;
            floor.planeFit = { centroid: [5, 5, 0], normal: [0, 0, 1], rms: 0.01, nPoints: 4 };
            for (const n of model.pool.nodes) {
                if (n.id === IDS.a0) n.color = '#ff0000';
            }
            res.fixtureColors = model.pool.colors();
            res.fixtureNames = model.pool.names();
        }

        // =============================================================
        // Snapshot of the truth, for comparison after the round trip
        // =============================================================
        function snapshot() {
            const m = P.planeState.model;
            return {
                nodes: m.pool.nodes.map(n => ({
                    id: n.id, name: n.name, color: n.color, immutable: n.immutable,
                    xyz: n.hasPoint3d() ? n.getPoint3d() : null, error: n.error,
                })),
                planes: m.planes.map(p => ({
                    id: p.id, name: p.name, color: p.color, nodeIds: p.nodeIds.slice(),
                    edges: p.edges.map(e => [e[0], e[1]]), filled: p.filled,
                    triangulation: p.triangulation, planeFit: p.planeFit,
                })),
                origin: O.originState.frame && {
                    origin: O.originState.frame.origin,
                    zAxis: O.originState.frame.zAxis,
                    R: O.originState.frame.R,
                    sourcePlane: O.originState.frame.sourcePlane,
                    sourceNode: O.originState.frame.sourceNode,
                },
            };
        }
        function placementSnapshot(session) {
            const m = P.planeState.model;
            const out = {};
            (session.planePlacements || new Map()).forEach((inst, view) => {
                const pts = [];
                for (let i = 0; i < inst.numNodes; i++) {
                    const nid = inst.nodeIds[i];
                    if (!inst.hasPoint(i) && !inst.isNodeNulled(i) && !inst.isNodeDerived(i)) continue;
                    pts.push({
                        n: nid,
                        xy: inst.hasPoint(i) ? [inst.getX(i), inst.getY(i)] : null,
                        off: inst.isNodeNulled(i) || undefined,
                        derived: inst.isNodeDerived(i) || undefined,
                    });
                }
                out[view] = { planes: Array.from(inst.placedPlanes).sort((a, b) => a - b), points: pts };
            });
            return out;
        }
        res.before = snapshot();
        res.beforePlacements = { sessA: placementSnapshot(sessions[0]), sessB: placementSnapshot(sessions[1]) };

        // =============================================================
        // 2. Save, then reopen through the real adapter
        // =============================================================
        const PLANE_KEYS = PM.PLANE_METADATA_KEYS;
        res.declaredKeys = PLANE_KEYS;
        const FOREIGN_KEYS = ['sessionName', 'trustTracks', 'frameIdentityMap',
            'identities', 'skeleton', 'tracks'];

        /** Parse a `.slp` and report each session's plane payload, unrestored. */
        async function readBack(bytes, filename) {
            const slpData = await fileio.parseSlpViaSleapIO(new File([bytes], filename), () => {});
            return (slpData.sessions || []).map(sd => {
                const lucid = (sd.metadata && sd.metadata.lucid) || {};
                const present = {};
                for (const k of PLANE_KEYS) {
                    if (Object.prototype.hasOwnProperty.call(lucid, k)) present[k] = lucid[k];
                }
                const foreign = {};
                for (const k of FOREIGN_KEYS) {
                    foreign[k] = Object.prototype.hasOwnProperty.call(lucid, k);
                }
                return {
                    sessionName: lucid.sessionName || null,
                    presentKeys: Object.keys(present).sort(),
                    lucid: lucid,
                    foreignKeysIntact: foreign,
                };
            });
        }

        /**
         * Ingest a parsed file exactly as the importer does: reset, then read
         * each session in order. Returns the restored model + placements.
         */
        function ingest(perSession) {
            PM.resetPlaneState();
            const fresh = perSession.map((s, i) => new Session([], skelOf(), ['t0'], 'reopened' + i));
            perSession.forEach((s, i) => PM.readPlaneMetadata(fresh[i], s.lucid));
            const snap = snapshot();
            const places = fresh.map(f => placementSnapshot(f));
            return { snap, places, sessionNames: perSession.map(s => s.sessionName) };
        }

        // ---- (a) EAGER writer, session A ----
        {
            const labels = fileio.buildSlpLabelsAllViews(
                sessions[0], viewsFor(SPECS[0]), videoFilesFor(SPECS[0]));
            const bytes = await window.SleapIO.saveSlpToBytes(labels);
            res.eagerRaw = await readBack(bytes, 'eager.slp');
            res.eager = ingest(res.eagerRaw);
        }

        // Restore the live model for the next writer (ingest replaced it).
        function restoreLive() {
            PM.resetPlaneState();
            PM.readPlaneMetadata(sessions[0], res.eagerRaw[0].lucid);
            AS.state.session = sessions[0];
        }

        // ---- (b) an untouched project writes NOTHING ----
        {
            PM.resetPlaneState();
            const plain = buildSession({ ...SPECS[0], name: 'plain' });
            const labels = fileio.buildSlpLabelsAllViews(
                plain, viewsFor(SPECS[0]), videoFilesFor(SPECS[0]));
            const bytes = await window.SleapIO.saveSlpToBytes(labels);
            const back = await readBack(bytes, 'untouched.slp');
            res.untouchedKeys = back[0] ? back[0].presentKeys : ['<no session>'];
            restoreLive();
        }

        // ---- (c) STREAMING writer, both sessions ----
        async function perCamFixture(spec, camName, camIdx) {
            const mtx = [[spec.fx, 0, 128], [0, spec.fx, 128], [0, 0, 1]];
            const cam = new Camera(camName, mtx, [0, 0, 0, 0, 0], [0, 0.1 * camIdx, 0], [10 * camIdx, 0, 0], [256, 256]);
            const s = new Session([cam], skelOf(), ['t0'], spec.name);
            for (let f = 0; f < spec.nFrames; f++) {
                const fg = new FrameGroup(f); s.addFrameGroup(fg);
                const pts = Array.from({ length: NODES }, (_, k) => [50 + k + f, 60 + k + f]);
                fg.addInstance(camName, new Instance(pts, 0, 'predicted', 0.9));
            }
            const labels = fileio.buildSlpLabels(s, camName, false, {
                videoWidth: 256, videoHeight: 256, frameCount: spec.nFrames, videoPath: camName + '.mp4',
            });
            return new File([await window.SleapIO.saveSlpToBytes(labels)], camName + '.slp');
        }
        {
            for (let i = 0; i < sessions.length; i++) {
                const loader = new SioLazyLoader();
                for (let ci = 0; ci < SPECS[i].cams.length; ci++) {
                    await loader.open(SPECS[i].cams[ci], await perCamFixture(SPECS[i], SPECS[i].cams[ci], ci));
                }
                sessions[i].lazyLoader = loader;
            }
            AS.state.sessions = sessions;
            AS.state.session = sessions[0];
            AS.state.activeSessionIdx = 0;
            AS.state.views = SPECS.flatMap(viewsFor);
            let err = null, bytes = null;
            try { bytes = await saveLoad.saveAllSessionsStreaming(sessions); }
            catch (e) { err = String((e && e.stack) || e); }
            res.streamErr = err;
            if (!err) {
                res.streamRaw = await readBack(bytes, 'streaming.slp');
                res.streaming = ingest(res.streamRaw);
            }
        }

        // =============================================================
        // 3. A load REPLACES the previous project's planes
        // =============================================================
        {
            PM.resetPlaneState();
            const stale = P.planeState.model;
            stale.createNodeInPlane('stale-node', stale.createPlane('stale-plane'));
            O.originState.frame = originFrame;
            res.staleBefore = {
                planes: stale.planes.map(p => p.name),
                origin: !!O.originState.frame,
            };
            // WITHOUT the reset first: this is the guard that stops a second
            // project's planes from being appended to the first's.
            const sess = new Session([], skelOf(), ['t0'], 'x');
            PM.readPlaneMetadata(sess, res.eagerRaw[0].lucid);
            res.withoutReset = P.planeState.model.planes.map(p => p.name);

            // WITH the reset, as every load path does.
            PM.resetPlaneState();
            res.afterReset = {
                nodes: P.planeState.model.pool.size,
                planes: P.planeState.model.planes.length,
                origin: O.originState.frame,
                selected: P.planeState.selectedPlaneId,
            };
            const sess2 = new Session([], skelOf(), ['t0'], 'y');
            PM.readPlaneMetadata(sess2, res.eagerRaw[0].lucid);
            res.afterProperLoad = P.planeState.model.planes.map(p => p.name);
            res.selectedAfterLoad = P.planeState.selectedPlaneId;
        }

        return res;
    });

    // =====================================================================
    console.log('\n-- 1. plane edits mark the project unsaved --');
    // =====================================================================
    check(out.dirty.createPlane, 'creating a plane marks the project dirty');
    check(out.dirty.deletePlane, 'deleting one does too');
    check(out.dirty.place, 'placing a plane on a view does');
    check(out.dirty.unplace, 'and un-placing it does');
    check(out.dirty.sliderStaysClean,
        'but the node-size / edge-width / 3D-size sliders do NOT — they are ' +
        'browser-local display taste and are not written to the project');

    console.log('\n-- 1b. through the real panel handlers --');
    check(out.panelDirty.renameTook === true, 'the Nodes-table name input actually renames');
    check(out.panelDirty.rename === true, 'and marks the project dirty');
    check(out.panelDirty.color === true, 'the node colour picker marks it dirty on commit');
    check(out.panelDirty.pin === true, 'the pin checkbox marks it dirty');
    check(out.panelDirty.fill === true, 'the Fill button marks it dirty');

    // =====================================================================
    console.log('\n-- 2. the eager writer puts plane state on disk --');
    // =====================================================================
    const eagerSess = out.eagerRaw[0];
    check(!!eagerSess, 'the file has a session');
    if (eagerSess) {
        check(eq(eagerSess.presentKeys, out.declaredKeys.slice().sort()),
            `every declared key is written (got ${JSON.stringify(eagerSess.presentKeys)})`);
        check(Object.values(eagerSess.foreignKeysIntact).every(Boolean),
            `and every other metadata.lucid key survived (got ${JSON.stringify(eagerSess.foreignKeysIntact)})`);
        check(eagerSess.lucid.planeNodes.length === 5, 'all five nodes are written');
        check(eagerSess.lucid.planes.length === 2, 'and both planes');
        // The NaN case: an untriangulated node must not be written as nulls.
        const b0rec = eagerSess.lucid.planeNodes.find(n => n.id === out.ids.b0);
        check(b0rec && !('xyz' in b0rec),
            'an untriangulated node omits `xyz` entirely — JSON turns NaN into null');
    }

    console.log('\n-- 3. and it all comes back --');
    const before = out.before, after = out.eager && out.eager.snap;
    check(!!after, 'the reopened file restores a model');
    if (after) {
        check(eq(after.nodes, before.nodes),
            'every node comes back identical — id, name, colour, pin, 3D and error');
        check(eq(after.planes, before.planes),
            'and every plane — membership, edges, fill, solve summary and plane fit');
        const s1After = after.nodes.find(n => n.id === out.ids.s1);
        check(s1After && s1After.immutable === true && eq(s1After.xyz, [10, 10, 0]),
            'the pinned corner keeps BOTH its pin and its coordinate');
        const floorAfter = after.planes.find(p => p.id === out.ids.floor);
        const wallAfter = after.planes.find(p => p.id === out.ids.wall);
        check(floorAfter && wallAfter &&
            floorAfter.nodeIds.includes(out.ids.s0) && wallAfter.nodeIds.includes(out.ids.s0) &&
            floorAfter.nodeIds.includes(out.ids.s1) && wallAfter.nodeIds.includes(out.ids.s1),
            'the two SHARED corners are still shared — the planes still meet');
        check(floorAfter && floorAfter.planeFit !== null,
            'a fitted plane comes back FIT, so Set Origin can still offer its corners');
    }

    console.log('\n-- 4. the origin frame --');
    if (after && after.origin && before.origin) {
        check(eq(after.origin.origin, before.origin.origin), 'the origin point round-trips');
        check(eq(after.origin.zAxis, before.origin.zAxis), 'and the chosen +Z');
        check(eq(after.origin.R, before.origin.R), 'and the rotation rebuilds bit-for-bit');
        check(after.origin.sourcePlane === 'floor' && after.origin.sourceNode === 's1',
            'and the labels the result table shows');
    } else {
        check(false, 'the origin frame came back');
    }

    console.log('\n-- 5. per-view 2D is SESSION-scoped --');
    const placeBefore = out.beforePlacements.sessA;
    const placeAfter = out.eager && out.eager.places[0];
    if (placeAfter) {
        check(eq(Object.keys(placeAfter).sort(), Object.keys(placeBefore).sort()),
            `the same views come back (got ${JSON.stringify(Object.keys(placeAfter))})`);
        check(eq(placeAfter, placeBefore),
            'with every point on its own node, and the nulled / reprojected ' +
            'flags on the right ones');
        const a0cam = placeAfter['a_cam0'];
        const derived = a0cam && a0cam.points.filter(p => p.derived).map(p => p.n);
        check(eq(derived, [out.ids.b0]),
            `the reprojected corner is still the reprojected one (got ${JSON.stringify(derived)})`);
        const off = a0cam && a0cam.points.filter(p => p.off).map(p => p.n);
        check(eq(off, [out.ids.a1]), `and the nulled one still nulled (got ${JSON.stringify(off)})`);
        const b0pt = a0cam && a0cam.points.find(p => p.n === out.ids.b0);
        check(b0pt && near(b0pt.xy[0], 140.5) && near(b0pt.xy[1], 220.25),
            'sub-pixel 2D is exact, not rounded');
    } else {
        check(false, 'session A placements came back');
    }

    // =====================================================================
    console.log('\n-- 6. an untouched project writes NO plane keys --');
    // =====================================================================
    check(eq(out.untouchedKeys, []),
        `a project that never opened Define Planes writes none of ${JSON.stringify(out.declaredKeys)} ` +
        `(got ${JSON.stringify(out.untouchedKeys)})`);

    // =====================================================================
    console.log('\n-- 7. the streaming writer agrees with the eager one --');
    // =====================================================================
    check(!out.streamErr, `the streaming save succeeded (${out.streamErr || 'ok'})`);
    if (out.streaming) {
        check(out.streamRaw.length === 2, `both sessions are in the file (got ${out.streamRaw.length})`);
        check(eq(out.streaming.snap.nodes, before.nodes), 'nodes match the eager writer');
        check(eq(out.streaming.snap.planes, before.planes), 'and so do planes');
        check(eq(out.streaming.snap.origin, before.origin), 'and the origin frame');

        // The project-scoped half is written into EVERY session's dict…
        const bothCarry = out.streamRaw.every(s =>
            s.presentKeys.includes('planeNodes') && s.presentKeys.includes('planes'));
        check(bothCarry, 'every session carries the project-scoped pool + planes');
        check(eq(out.streamRaw[0].lucid.planeNodes, out.streamRaw[1].lucid.planeNodes),
            'identically, so opening either session restores the same geometry');

        // …while the per-view 2D is not.
        const aViews = Object.keys(out.streaming.places[0] || {}).sort();
        const bViews = Object.keys(out.streaming.places[1] || {}).sort();
        check(eq(aViews, ['a_cam0', 'a_cam1']),
            `session A got only its own views (got ${JSON.stringify(aViews)})`);
        check(eq(bViews, ['b_cam0']),
            `session B got only its own (got ${JSON.stringify(bViews)})`);
        check(eq(out.streaming.places[1], out.beforePlacements.sessB),
            'and session B\'s 2D is its own values, not session A\'s');
    }

    // =====================================================================
    console.log('\n-- 8. a load REPLACES the previous project --');
    // =====================================================================
    check(eq(out.staleBefore.planes, ['stale-plane']), 'the model starts holding another project');
    check(eq(out.withoutReset, ['stale-plane']),
        'reading into a NON-empty model is refused rather than merged — which ' +
        'is exactly why every load path must call resetPlaneState() first');
    check(out.afterReset.nodes === 0 && out.afterReset.planes === 0,
        'resetPlaneState empties the pool and the planes');
    check(out.afterReset.origin === null, 'and drops the applied origin');
    check(out.afterReset.selected === null, 'and the plane selection');
    check(eq(out.afterProperLoad, ['floor', 'wall']),
        `so the loaded project's planes are the ones that survive (got ${JSON.stringify(out.afterProperLoad)})`);
    check(out.selectedAfterLoad === out.ids.floor,
        'and the editor selects a plane that actually exists');

} catch (err) {
    console.error('\nFATAL', err);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'} — ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
