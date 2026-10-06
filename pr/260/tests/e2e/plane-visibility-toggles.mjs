/**
 * plane-visibility-toggles.mjs — the Visibility panel's `Planes` section.
 *
 * An annotated cage is scene geometry, so it is drawn in EVERY mode. That is
 * right when you are checking a pose against the floor and wrong when five
 * filled walls sit on top of the frame you are labelling, so four toggles say
 * which parts survive outside Defining Plane Mode: planes and nodes, 2D and 3D.
 *
 * What this pins:
 *
 *   1. All four controls exist, sit inside `#tabVisibility` (the container
 *      carrying the delegated save listener) and are ON by default — planes
 *      were always drawn before this section existed, so any other default
 *      would silently hide existing users' work.
 *   2. `planeVisibility()` reports the checkboxes, and reports ALL FOUR ON when
 *      the mode is active whatever they say.
 *   3. 2D: the plane BODY and the NODES are independently switchable. Each of
 *      the four states is asserted by counting pixels of two different colours
 *      on a real overlay canvas, so "off" means no ink rather than ink nobody
 *      looked at.
 *   4. The change repaints BY ITSELF. A toggle missing from the change-listener
 *      list leaves the old pixels on screen until the user nudges a frame,
 *      which reads exactly like a broken toggle — so no assertion below calls
 *      `drawAllOverlays` after flipping a box.
 *   5. 3D: same split, over a REAL viewport — `planeEdge_*`/fill meshes follow
 *      "Planes in 3D Views" and `planeNode_*` meshes follow "Nodes in 3D
 *      Views". The payload in `_planes` stays whole either way, because a
 *      drag, the selected-node marker and the mesh-object highlight all resolve
 *      ids against it.
 *   6. Defining Plane Mode overrides all four: with every box unticked,
 *      entering the mode brings 2D ink and 3D meshes back. The panel edits
 *      parts the user has to be able to see.
 *   7. They decide WHETHER a plane is drawn, never HOW. A shown plane keeps its
 *      own `Fill`: switching the plane's `Fill` off takes the 2D fill and the
 *      3D fill mesh away in BOTH modes, and switching a toggle never writes
 *      `plane.filled` or dirties the project. A visibility override that
 *      fabricated a fill would make the same plane look different outside the
 *      mode from inside it, and is the same confusion
 *      `mesh-membership-highlight.mjs` pins against for the mesh highlight.
 *   8. The state persists (it is in `visCheckIds`) and survives a reload.
 *
 * Run: node plane-visibility-toggles.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8277);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // --- §1 the four controls -------------------------------------------
    const boxes = await page.evaluate(async () => {
        const V = await import('/ui/plane-visibility.js');
        const tab = document.getElementById('tabVisibility');
        const out = {};
        for (const key of Object.keys(V.PLANE_VIS_IDS)) {
            const el = document.getElementById(V.PLANE_VIS_IDS[key]);
            out[key] = el ? {
                id: V.PLANE_VIS_IDS[key],
                checked: el.checked,
                inVisTab: !!(tab && tab.contains(el)),
                label: (el.closest('.vis-slider-row') || {}).textContent?.trim() || null,
            } : null;
        }
        // The section heading the four rows hang under.
        const heads = [...document.querySelectorAll('#tabVisibility h3')].map(h => h.textContent.trim());
        return { out, heads };
    });
    const keys = ['planes2d', 'planes3d', 'nodes2d', 'nodes3d'];
    check(keys.every(k => boxes.out[k]),
        'all four controls exist (' + keys.map(k => boxes.out[k] && boxes.out[k].id).join(', ') + ')');
    check(keys.every(k => boxes.out[k] && boxes.out[k].checked === true),
        'every one is ON by default — planes were always drawn, so off would hide existing work');
    check(keys.every(k => boxes.out[k] && boxes.out[k].inVisTab),
        'all four sit inside #tabVisibility, so the delegated save listener sees them');
    check(boxes.heads.includes('Planes'),
        `the Visibility tab has a "Planes" section (got ${JSON.stringify(boxes.heads)})`);
    check(/2D/.test(boxes.out.planes2d.label || '') && /3D/.test(boxes.out.planes3d.label || '') &&
          /Node/i.test(boxes.out.nodes2d.label || '') && /Node/i.test(boxes.out.nodes3d.label || ''),
        'each row says which of plane/node and which of 2D/3D it is');

    // --- a calibrated session, a real 3D viewport, one PLACED plane ------
    // The plane is FILLED and has NO edges: with no edges the only
    // plane-coloured ink is the fill and the name label, so §7 can take the
    // `Fill` away and measure the difference rather than inferring it. Node
    // colours are forced apart from the plane colour so the two populations of
    // pixels can be counted separately.
    const built = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Camera, Session, Skeleton, FrameGroup } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = [
            new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.6, 0], [-400, 0, 0], [640, 480]),
        ];
        const session = new Session(cams, new Skeleton('sk', ['a', 'b'], [[0, 1]]), ['t0'], 'S1');
        session.addFrameGroup(new FrameGroup(0));

        const oc = document.createElement('canvas');
        oc.width = 640; oc.height = 480;
        document.body.appendChild(oc);
        window.__oc = oc;

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 1;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = [{
            name: 'camA', decoder: null, canvas: null, ctx: null,
            overlayCanvas: oc, overlayCtx: oc.getContext('2d'),
            videoWidth: 640, videoHeight: 480, zoom: { scale: 1 },
        }];

        const init = await import('/pose/initialization.js');
        init.setup3DViewport();

        const P = await import('/ui/plane-definition.js');
        if (!P.planeState.active) P.togglePlaneMode();
        const model = P.planeModel();
        const mk = (name, xyz) => {
            const n = model.addNode(name);
            n.setPoint3d(xyz);
            n.color = '#00ff00';
            return n;
        };
        const ns = [
            mk('A', [-110, -90, 970]), mk('B', [130, -90, 970]),
            mk('C', [130, 120, 970]), mk('D', [-110, 120, 970]),
        ];
        const floor = P.createPlane('floor');
        floor.color = '#ff0000';
        floor.filled = true;
        ns.forEach(n => model.addNodeToPlane(floor, n.id));
        // 2D: a real placement in camA, well inside the canvas.
        model.placePlane(floor, 'camA', 320, 240, 640, 480);
        // Back to the DEFAULT mode — that is what these toggles are about.
        P.togglePlaneMode();
        P.refreshPlanePanel();
        P.syncPlanes3D();

        return {
            hasViewport: !!AS.viewport3d,
            modeActive: P.planeState.active,
            filled: floor.filled,
            edges: floor.edges.length,
            placed: model.placedPlanes('camA').length,
        };
    });
    check(built.hasViewport === true, 'a real 3D viewport came up');
    check(built.modeActive === false, 'and we are in the DEFAULT mode, which is what the toggles govern');
    check(built.placed === 1, 'one plane is placed in camA');
    check(built.filled === true && built.edges === 0,
        'the plane is FILLED and has no edges — the fixture that makes §7 measurable');

    // Ink counters. `body` = plane-coloured (the fill and the name label),
    // `nodes` = node-coloured (the corner dots and their names). Two colours
    // rather than one total, so "the body went away" cannot be satisfied by the
    // nodes going away instead.
    await page.evaluate(() => {
        window.__ink = () => {
            const c = window.__oc;
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let body = 0, nodes = 0, any = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 3] === 0) continue;
                any++;
                if (d[i] > 60 && d[i + 1] < 60 && d[i + 2] < 60) body++;
                else if (d[i + 1] > 60 && d[i] < 60 && d[i + 2] < 60) nodes++;
            }
            return { body, nodes, any };
        };
    });
    const redraw = () => page.evaluate(async () => {
        const R = await import('/ui/rendering.js');
        R.drawAllOverlays(0);
    });
    const ink = () => page.evaluate(() => window.__ink());
    const setBox = async (id, on) => {
        await page.evaluate(([i, v]) => {
            const el = document.getElementById(i);
            el.checked = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, [id, on]);
        await page.waitForTimeout(250);
    };

    // --- §2 planeVisibility() -------------------------------------------
    const readVis = (modeActive) => page.evaluate(async (m) => {
        const V = await import('/ui/plane-visibility.js');
        return V.planeVisibility(m);
    }, modeActive);
    let v = await readVis(false);
    check(v.planes2d && v.planes3d && v.nodes2d && v.nodes3d,
        'planeVisibility(false) reports all four on while every box is ticked');
    check(!('fillAll' in v),
        'and it reports nothing about HOW to draw a plane — no fill override exists');

    // --- §3/§4 2D, all four states ---------------------------------------
    await redraw();
    const bothOn = await ink();
    check(bothOn.body > 1000,
        `the plane body is painted with both on (${bothOn.body} plane-coloured px)`);
    check(bothOn.nodes > 20,
        `and so are its nodes (${bothOn.nodes} node-coloured px)`);

    // Planes off, nodes on. No manual redraw: the change must repaint itself.
    await setBox('visPlanes2D', false);
    const nodesOnly = await ink();
    check(nodesOnly.body === 0,
        `unticking "Planes in 2D Views" removes the body on its own, no manual redraw (${nodesOnly.body} px)`);
    check(nodesOnly.nodes > 20,
        `and leaves the NODES drawn — the two toggles are independent (${nodesOnly.nodes} px)`);

    // Both off: nothing at all.
    await setBox('visPlaneNodes2D', false);
    const noneOn = await ink();
    check(noneOn.any === 0,
        `with both off the overlay is empty (${noneOn.any} inked px)`);

    // Planes on, nodes off — the other asymmetry, which a single shared flag
    // would fail.
    await setBox('visPlanes2D', true);
    const bodyOnly = await ink();
    check(bodyOnly.body > 1000,
        `the body comes back by itself (${bodyOnly.body} px)`);
    check(bodyOnly.nodes === 0,
        `with the nodes still off (${bodyOnly.nodes} node-coloured px)`);

    v = await readVis(false);
    check(v.planes2d === true && v.nodes2d === false,
        'planeVisibility() agrees with the boxes after the flipping');

    // --- §5 3D ------------------------------------------------------------
    const meshes = () => page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const grp = AS.viewport3d.scene.children.find(ch => ch.name === 'planes');
        let nodes = 0, edges = 0, fills = 0, planes = 0;
        if (grp) {
            for (const g of grp.children) {
                planes++;
                for (const ch of g.children) {
                    if (/^planeNode_/.test(ch.name)) nodes++;
                    else if (/^planeEdge_/.test(ch.name)) edges++;
                    else fills++;
                }
            }
        }
        const P = await import('/ui/plane-definition.js');
        return { nodes, edges, fills, planes, payload: AS.viewport3d._planes.length, dummy: !!P };
    });

    // Both on. The plane has no edges by construction, so its body in 3D is
    // exactly its FILL, which it has because the fixture clicked `Fill`.
    await setBox('visPlanes3D', true);
    await setBox('visPlaneNodes3D', true);
    const m3both = await meshes();
    check(m3both.nodes === 4, `all four corners are in the 3D scene (${m3both.nodes})`);
    check(m3both.fills === 1, `and the plane's fill (${m3both.fills})`);

    await setBox('visPlanes3D', false);
    const m3nodes = await meshes();
    check(m3nodes.fills === 0 && m3nodes.edges === 0,
        `unticking "Planes in 3D Views" removes the body meshes (${m3nodes.fills} fill, ${m3nodes.edges} edge)`);
    check(m3nodes.nodes === 4,
        `and leaves the corners (${m3nodes.nodes}) — independent, as in 2D`);
    check(m3nodes.payload === 1,
        'the payload in `_planes` is still whole, so a drag / marker / highlight can still resolve its id');

    await setBox('visPlaneNodes3D', false);
    const m3none = await meshes();
    check(m3none.nodes === 0 && m3none.fills === 0 && m3none.edges === 0,
        'with both off the 3D scene holds no plane meshes');
    check(m3none.payload === 1, 'and the payload is STILL whole');

    // --- §6 the mode overrides all four -----------------------------------
    // Everything is unticked now except "Planes in 2D Views"; untick that too,
    // so the mode has all four to override.
    await setBox('visPlanes2D', false);
    check((await ink()).any === 0, 'every box is off and the 2D overlay is empty');

    v = await readVis(true);
    check(v.planes2d && v.planes3d && v.nodes2d && v.nodes3d,
        'planeVisibility(TRUE) reports all four on regardless of the boxes');

    const inMode = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const R = await import('/ui/rendering.js');
        P.togglePlaneMode();
        P.syncPlanes3D();
        R.drawAllOverlays(0);
        const AS = await import('/ui/app-state.js');
        const grp = AS.viewport3d.scene.children.find(ch => ch.name === 'planes');
        let nodes = 0, fills = 0;
        if (grp) for (const g of grp.children) for (const ch of g.children) {
            if (/^planeNode_/.test(ch.name)) nodes++; else if (!/^planeEdge_/.test(ch.name)) fills++;
        }
        return { ink: window.__ink(), nodes, fills, active: P.planeState.active };
    });
    check(inMode.active === true, 'entering Defining Plane Mode');
    check(inMode.ink.nodes > 20 && inMode.ink.body > 0,
        `draws the plane in 2D again despite every box being off (${inMode.ink.body} body, ${inMode.ink.nodes} node px)`);
    check(inMode.nodes === 4,
        `and the corners in 3D again (${inMode.nodes})`);
    check(inMode.fills === 1,
        'and its fill, because the plane really is Filled (the mode changes WHETHER, not HOW)');
    const bodyInMode = inMode.ink.body;
    check(bodyInMode > 1000,
        `the 2D body is the filled quad, same as outside the mode (${bodyInMode} px)`);

    // --- §7 WHETHER, never HOW --------------------------------------------
    // Take the plane's own `Fill` away and the fill goes, in BOTH modes. A
    // visibility override that fabricated one would leave the 2D body at its
    // filled size here and make the same plane look different inside the mode
    // from outside it.
    const unfilled = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const R = await import('/ui/rendering.js');
        const AS = await import('/ui/app-state.js');
        const read = () => {
            const grp = AS.viewport3d.scene.children.find(ch => ch.name === 'planes');
            let fills = 0;
            if (grp) for (const g of grp.children) for (const ch of g.children) {
                if (!/^planeNode_|^planeEdge_/.test(ch.name)) fills++;
            }
            return { ink: window.__ink(), fills };
        };
        P.planeModel().planes[0].filled = false;
        P.syncPlanes3D();
        R.drawAllOverlays(0);
        const inside = read();               // still in Defining Plane Mode

        P.togglePlaneMode();                 // back to the default mode
        ['visPlanes2D', 'visPlanes3D', 'visPlaneNodes2D', 'visPlaneNodes3D']
            .forEach(id => {
                const el = document.getElementById(id);
                el.checked = true;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            });
        AS.state.isDirty = false;
        P.syncPlanes3D();
        R.drawAllOverlays(0);
        const outside = read();

        return { inside, outside, active: P.planeState.active, dirty: AS.state.isDirty };
    });
    check(unfilled.active === false, 'back in the default mode with all four boxes ticked');
    check(unfilled.inside.fills === 0 && unfilled.outside.fills === 0,
        'un-Filling the plane removes its 3D fill in BOTH modes — no visibility override');
    check(unfilled.outside.ink.body < 400 && unfilled.inside.ink.body < 400,
        `and in 2D only its name label is left, in both modes (${unfilled.inside.ink.body} / ` +
        `${unfilled.outside.ink.body} px, was ${bodyInMode} filled)`);
    check(unfilled.outside.ink.nodes > 20,
        `while its corners are still drawn (${unfilled.outside.ink.nodes} px) — ` +
        'an unfilled plane is not a hidden one');
    check(unfilled.dirty === false,
        'and flipping the toggles never dirtied the project, so the saved bytes cannot move');

    // --- §8 persistence ----------------------------------------------------
    await setBox('visPlanes3D', false);
    await setBox('visPlaneNodes2D', false);
    const stored = await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) {
            let val;
            try { val = JSON.parse(localStorage.getItem(k)); } catch (e) { continue; }
            if (val && typeof val === 'object' && 'visPlanes3D' in val) {
                return {
                    key: k,
                    planes2d: val.visPlanes2D, planes3d: val.visPlanes3D,
                    nodes2d: val.visPlaneNodes2D, nodes3d: val.visPlaneNodes3D,
                };
            }
        }
        return null;
    });
    check(stored !== null, 'the four toggles are written to localStorage (they are in visCheckIds)');
    check(stored && stored.planes3d === false && stored.nodes2d === false &&
          stored.planes2d === true && stored.nodes3d === true,
        `and stored exactly as set (${JSON.stringify(stored && [stored.planes2d, stored.planes3d, stored.nodes2d, stored.nodes3d])})`);

    await page.reload();
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    const afterReload = await page.evaluate(async () => {
        const V = await import('/ui/plane-visibility.js');
        const r = V.planeVisibility(false);
        return { r, boxes: Object.keys(V.PLANE_VIS_IDS).map(k => document.getElementById(V.PLANE_VIS_IDS[k]).checked) };
    });
    check(afterReload.r.planes3d === false && afterReload.r.nodes2d === false &&
          afterReload.r.planes2d === true && afterReload.r.nodes3d === true,
        'and they come back the same after a reload');

    console.log('');
    check(errs.length === 0, 'no page errors / console errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (err) {
    console.error('FATAL', err);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}

console.log(fails === 0 ? '\n✅ ALL CHECKS PASSED' : `\n❌ ${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
