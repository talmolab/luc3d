/**
 * plane-lock-holds.mjs — a `plane-locked` node stays in EVERY plane it belongs
 * to, in every editor, on planes nobody has clicked Fit on.
 *
 * `plane-locked` promises one thing: this corner may move, but only within the
 * planes it is a member of. Two planes leave it a line; three leave it a
 * point. That promise was not kept, and the reason is a loop:
 *
 *   1. `constrainPoint3dForNode` — the single place the soft pin is honoured —
 *      projected onto the plane's STORED `planeFit`, and returned the proposed
 *      position untouched when there was none.
 *   2. `setPinState` clears the `planeFit` of every plane holding the node
 *      whose pin just changed — INCLUDING the plane just named as the lock
 *      target.
 *
 * So plane-locking a node's last act was to remove the plane it was being
 * locked to, and the pin was inert from the moment it was created. On a real
 * five-plane project (a cage: Ground plus four walls, corners locked and one
 * corner plane-locked) four of the five planes carried no stored fit, typing
 * `z = 2000` into the held corner left it **683 mm** off its plane, and nothing
 * anywhere said so. In that same project the held corner sits in THREE of the
 * planes, so what it is really entitled to is one position.
 *
 * Two more paths never asked at all: the 3D corner drag, which took the
 * viewport's own constraint (the plane under the cursor, which is not
 * necessarily the holding plane) as final, and `applyPlaneFit`, which is free
 * to move a plane-locked corner because `planeImmutableMask` deliberately
 * reports only `locked`.
 *
 * What this pins, section by section:
 *
 *   1. The precondition — plane-locking really does clear the fits of the
 *      planes holding the node, so §2-§6 are testing the configuration users
 *      are actually in and not a contrived one — and the corner is held by
 *      BOTH the planes it is in, which leaves it a line.
 *   2. The typed x/y/z editor lands the corner on that line, at the NEAREST
 *      point of it, and SAYS so.
 *   3. `Triangulate` cannot push it off.
 *   4. `Fit` on one of the two planes cannot either.
 *   5. The 3D viewport offers the drag (a derived surface counts) and the drag
 *      is held to the line, not to the plane under the cursor.
 *   6. Adding the corner to a THIRD plane locks it outright — every edit
 *      resolves to the one point the three planes meet at.
 *   7. Set Origin's corner picker is NOT widened by any of it.
 *
 * Nothing here is checked against the app's own fits. The reference geometry is
 * rebuilt from the OTHER corners of each plane, and "nearest" is asserted as
 * the optimality condition it is — the move has to be perpendicular to the set
 * the corner is allowed to slide in.
 *
 * Run: node plane-lock-holds.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8253);

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

    // A three-camera session, enough for a real triangulation in §3.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Camera, Session, Skeleton } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = [
            new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.6, 0], [-400, 0, 0], [640, 480]),
            new Camera('camC', K, [0, 0, 0, 0, 0], [0, -0.6, 0], [400, 0, 0], [640, 480]),
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
    });

    // A REAL viewport, so §5 drags through the same payload the user's pointer
    // does and §6 can read the picker's own userData rather than a stand-in.
    await page.evaluate(async () => {
        const init = await import('/pose/initialization.js');
        init.setup3DViewport();
    });
    await page.waitForTimeout(600);

    // The cage, in the shape the real project has it: a Ground plane whose four
    // corners are exactly coplanar, three of them Locked and one plane-locked;
    // plus a wall that SHARES the plane-locked corner. The sharing is not a
    // convenience for §4 and §5 — it is the subject. Two planes hold that
    // corner, so what it may move in is the LINE they meet in.
    //
    // Ground is TILTED — z = 1000 + 0.3x, exactly coplanar — and the tilt is
    // load-bearing. On an axis-aligned plane the nearest point to an edit that
    // changes only the PERPENDICULAR coordinate is the corner's own current
    // position, so typing `z` would leave every number identical and the test
    // could not tell a held node from an ignored edit. Tilted, a change to z
    // moves x as well, and "it moved, and it is still on the plane" become two
    // separable claims.
    const built = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        if (!P.planeState.active) P.togglePlaneMode();
        const model = P.planeModel();

        const mk = (name, xyz) => {
            document.getElementById('planeNodeNameInput').value = name;
            document.getElementById('btnAddPlaneNode').click();
            const nd = model.pool.nodes[model.pool.nodes.length - 1];
            nd.setPoint3d(xyz);
            return nd;
        };
        const A = mk('A', [-100, -100, 970]);
        const B = mk('B', [100, -100, 1030]);
        const C = mk('C', [100, 100, 1030]);
        const D = mk('D', [-100, 100, 970]);
        // Wall corners, well off the Ground plane.
        const E = mk('E', [-100, -100, 1400]);
        const F = mk('F', [100, -100, 1400]);

        const ground = P.createPlane('Ground');
        [A, B, C, D].forEach(nd => ground.addNode(nd.id));
        const wall = P.createPlane('right wall');
        [A, B, F, E].forEach(nd => wall.addNode(nd.id));

        // Pins THROUGH THE REAL CONTROL — click the padlock, then the state in
        // the popover — so §1 is testing `setNodePin`'s actual side effects and
        // not a model call that skips them. Ground is selected first, so the
        // plane-locked target resolves to it.
        P.planeState.selectedPlaneId = ground.id;
        P.refreshPlanePanel();
        // The pin nominates no plane — what holds A is what A is in — so the
        // selection above matters only for which panel is on screen.
        const setPin = (node, pin) => {
            const rows = [...document.querySelectorAll(
                '#planeNodesTable tbody tr.plane-node-main')];
            const row = rows.find(tr =>
                tr.getAttribute('data-plane-node-id') === String(node.id));
            if (!row) return false;
            row.querySelector('.plane-node-pin-btn').click();
            const opt = document.querySelector(
                '#planePinPopover .plane-pin-option[data-pin="' + pin + '"]');
            if (!opt) return false;
            opt.click();
            return true;
        };
        const pinned = [
            setPin(A, 'plane-locked'),
            setPin(B, 'locked'), setPin(C, 'locked'), setPin(D, 'locked'),
        ];
        P.refreshPlanePanel();

        return {
            ids: { A: A.id, B: B.id, C: C.id, D: D.id, E: E.id, F: F.id },
            planes: { ground: ground.id, wall: wall.id },
            pinned: pinned,
        };
    });
    check(built.pinned.every(Boolean),
        'all four pins went in through the real padlock control');

    // The reference geometry, rebuilt from corners the pin does not touch.
    //
    // Each plane holding A is reconstructed from its OTHER three corners, which
    // is a plane exactly (three points, one plane) and owes nothing to the code
    // under test. `dist` is how far A is from the WORST of them, so "A is where
    // it is allowed to be" is one number.
    //
    // `tangent` is the direction A may still slide in when two planes hold it
    // — the cross product of their normals — and it is what makes NEAREST
    // checkable without reimplementing the projection: the nearest point of a
    // set to a target is the one where the leftover displacement is
    // perpendicular to the set.
    await page.evaluate(async (ids) => {
        const P = await import('/ui/plane-definition.js');
        const pool = () => P.planeModel().pool;
        const g = (id) => Array.from(pool().getNode(id).xyz);
        const planeOf = (triple) => {
            const [p, q, r] = triple.map(g);
            const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
            const v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
            let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
                     u[0] * v[1] - u[1] * v[0]];
            const L = Math.hypot(n[0], n[1], n[2]);
            n = [n[0] / L, n[1] / L, n[2] / L];
            return { n, d: n[0] * p[0] + n[1] * p[1] + n[2] * p[2] };
        };
        // Which planes are in play is stated per section, never discovered, so
        // a section cannot quietly stop testing what its name says.
        window.__ref = {
            // Ground minus A, and the wall minus A. §6 adds the third.
            triples: [[ids.B, ids.C, ids.D], [ids.B, ids.F, ids.E]],
            planes() { return this.triples.map(planeOf); },
            state() {
                const a = g(ids.A);
                const pl = this.planes();
                const offs = pl.map(q => Math.abs(q.n[0] * a[0] + q.n[1] * a[1] +
                                                  q.n[2] * a[2] - q.d));
                return { xyz: a, dist: Math.max.apply(null, offs), offs };
            },
            // How far the move from `was` to A runs ALONG the line, which for
            // the nearest point is zero.
            tangentSlip(was) {
                const pl = this.planes();
                const [p, q] = [pl[0].n, pl[1].n];
                let t = [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2],
                         p[0] * q[1] - p[1] * q[0]];
                const L = Math.hypot(t[0], t[1], t[2]);
                t = [t[0] / L, t[1] / L, t[2] / L];
                const a = g(ids.A);
                return Math.abs((was[0] - a[0]) * t[0] + (was[1] - a[1]) * t[1] +
                                (was[2] - a[2]) * t[2]);
            },
        };
    }, built.ids);
    const distOfA = () => page.evaluate(() => window.__ref.state());
    const slipFrom = (was) => page.evaluate(w => window.__ref.tangentSlip(w), was);

    const statusText = () => page.evaluate(() => {
        const el = document.getElementById('statusText') ||
            document.querySelector('.status-bar');
        return el ? el.textContent.trim() : '';
    });

    // =========================================================
    console.log('\n--- 1. Plane-locking A cleared the fits, and BOTH planes hold it ---');
    // =========================================================
    const pre = await page.evaluate(async (b) => {
        const P = await import('/ui/plane-definition.js');
        const model = P.planeModel();
        const A = model.pool.getNode(b.ids.A);
        const lock = model.planeLockForNode(b.ids.A);
        return {
            pin: A.pin,
            hasPinPlaneId: A.pinPlaneId !== undefined,
            rank: lock.rank,
            holders: lock.planes.map(p => p.name).sort(),
            groundStoredFit: !!model.getPlane(b.planes.ground).planeFit,
            wallStoredFit: !!model.getPlane(b.planes.wall).planeFit,
            groundUsableFit: !!model.usableFitForPlane(b.planes.ground),
            lockedB: model.pool.getNode(b.ids.B).pin,
        };
    }, built);
    check(pre.pin === 'plane-locked', 'A is plane-locked: ' + pre.pin);
    check(pre.hasPinPlaneId === false,
        'and NO plane was nominated — the pin has no `pinPlaneId` to go stale');
    check(pre.lockedB === 'locked', 'B is Locked outright');
    check(pre.groundStoredFit === false,
        'Ground has NO stored planeFit — plane-locking A removed it');
    check(pre.wallStoredFit === false, 'and neither does the wall');
    check(pre.groundUsableFit === true,
        'but Ground still HAS a plane: three solved corners define one');
    check(pre.rank === 2,
        'A is in two planes, so it is pinned in two directions (rank ' + pre.rank + ')');
    check(JSON.stringify(pre.holders) === JSON.stringify(['Ground', 'right wall']),
        'and both of them are named as holders: ' + JSON.stringify(pre.holders));

    const start = await distOfA();
    check(start.dist < 1e-9,
        'A starts exactly on the line the two planes meet in (' +
        start.dist.toExponential(2) + ' mm)');

    // =========================================================
    console.log('\n--- 2. Typing a coordinate projects onto the LINE ---');
    // =========================================================
    // Through the real DOM: expand A's row, type into its Z field, fire the
    // `change` the input commits on.
    const typed = await page.evaluate(async (ids) => {
        const rows = [...document.querySelectorAll('#planeNodesTable tbody tr.plane-node-main')];
        const row = rows.find(tr => tr.getAttribute('data-plane-node-id') === String(ids.A));
        if (!row) return { ok: false, why: 'no row for A' };
        row.querySelector('.plane-node-expander').click();
        await new Promise(r => setTimeout(r, 60));
        const inp = document.querySelector(
            'tr.plane-node-detail .plane-node-xyz-input[data-axis="z"]');
        if (!inp) return { ok: false, why: 'no z input' };
        const wasDisabled = inp.disabled;
        inp.value = '2000';
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 120));
        return { ok: true, wasDisabled };
    }, built.ids);
    check(typed.ok, 'A\'s Z field is reachable: ' + (typed.why || 'yes'));
    check(typed.wasDisabled === false,
        'and it is ENABLED — plane-locked is not Locked, the edit is accepted');

    const afterType = await distOfA();
    check(afterType.dist < 1e-6,
        'after typing z = 2000 A is STILL on both its planes (' +
        afterType.dist.toExponential(2) + ' mm off the worse of them)');
    check(Math.abs(afterType.xyz[2] - 2000) > 1,
        'the typed 2000 was not taken literally (z is now ' +
        afterType.xyz[2].toFixed(2) + ')');
    check(Math.hypot(afterType.xyz[0] - start.xyz[0], afterType.xyz[1] - start.xyz[1],
        afterType.xyz[2] - start.xyz[2]) > 1,
        'but the edit DID move the node — it was accepted, not discarded');
    // The NEAREST point of the line, not merely some point on it. Asserted as
    // the optimality condition — what is left of the typed position, measured
    // along the only direction A can still move in, has to be zero — so the
    // check owes nothing to the projection it is checking.
    const slip = await slipFrom([-100, -100, 2000]);
    check(slip < 1e-6,
        'and it is the NEAREST point of that line to what was typed (' +
        slip.toExponential(2) + ' mm of slip along the line)');

    const msg = await statusText();
    check(/plane-locked/i.test(msg) && /nearest point/i.test(msg) &&
          /line where/i.test(msg),
        'and the status names the LINE and says the corner was moved to the ' +
        'nearest point of it, since the number came back different from the ' +
        'one typed: ' + JSON.stringify(msg.slice(0, 190)));

    // The displayed field agrees with the stored value, or the panel would be
    // reporting a position the model does not hold.
    const shown = await page.evaluate(() => {
        const q = (ax) => document.querySelector(
            'tr.plane-node-detail .plane-node-xyz-input[data-axis="' + ax + '"]');
        return ['x', 'y', 'z'].map(ax => (q(ax) ? q(ax).value : null));
    });
    check(shown[2] !== '2000' && Number(shown[2]).toFixed(1) ===
        afterType.xyz[2].toFixed(1),
        'the Z field shows the projected value, not the typed one: ' +
        JSON.stringify(shown[2]));

    // An edit that is ALREADY on the line is taken exactly, with no nudge.
    // "May move, but only within its planes" has to mean the movement the
    // planes allow is free, or the pin would be a freeze with extra steps.
    const inPlane = await page.evaluate(async (ids) => {
        const P = await import('/ui/plane-definition.js');
        const pool = P.planeModel().pool;
        const before = Array.from(pool.getNode(ids.A).xyz);
        // Slide along the LINE: y is fixed by the wall, and dz = 0.3 dx keeps
        // z = 1000 + 0.3x, so this is the one direction A is free in.
        // Both fields are written and ONE `change` fired, because the commit
        // reads all three inputs together — committing them one at a time would
        // put an off-plane intermediate through the projection and then measure
        // against the wrong starting point.
        const want = [before[0] + 40, before[1], before[2] + 12];
        const q = (ax) => document.querySelector(
            'tr.plane-node-detail .plane-node-xyz-input[data-axis="' + ax + '"]');
        ['x', 'y', 'z'].forEach((ax, k) => { q(ax).value = String(want[k]); });
        q('z').dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 120));
        const after = Array.from(pool.getNode(ids.A).xyz);
        return {
            err: Math.hypot(after[0] - want[0], after[1] - want[1], after[2] - want[2]),
            want, after,
        };
    }, built.ids);
    check(inPlane.err < 1e-6,
        'an on-the-line edit is taken verbatim (' + inPlane.err.toExponential(2) +
        ' mm from what was typed)');
    const afterInPlane = await distOfA();
    check(afterInPlane.dist < 1e-6, 'and it is of course still on the line');

    // =========================================================
    console.log('\n--- 3. Triangulate cannot push it off either ---');
    // =========================================================
    // Place Ground on all three views and hand-place its corners, then solve.
    // The 2D is seeded from the reprojection of a deliberately off-line point,
    // so an unconstrained solve would land A off both planes.
    await page.evaluate(async (b) => {
        const P = await import('/ui/plane-definition.js');
        const T = await import('/pose/triangulation.js');
        const AS = await import('/ui/app-state.js');
        const model = P.planeModel();
        const ground = model.getPlane(b.planes.ground);
        for (const cam of AS.state.session.cameras) {
            model.placePlane(ground, cam.name, 320, 240, 640, 480);
        }
        // Aim every view's A at one common off-plane point.
        const off = [-140, -160, 1250];
        const pi = model.pool.indexOf(b.ids.A);
        for (const cam of AS.state.session.cameras) {
            const uv = T.reprojectPointCamera(off, cam);
            const inst = model.getInstance(cam.name);
            inst.setPoint(pi, uv[0], uv[1]);
            inst.setNodeDerived(pi, false);
        }
        P.triangulatePlane(ground);
    }, built);
    await page.waitForTimeout(200);

    const afterTri = await distOfA();
    check(afterTri.dist < 1e-6,
        'A is on both its planes after Triangulate (' +
        afterTri.dist.toExponential(2) + ' mm)');
    const triMoved = Math.hypot(afterTri.xyz[0] - inPlane.after[0],
        afterTri.xyz[1] - inPlane.after[1], afterTri.xyz[2] - inPlane.after[2]);
    check(triMoved > 1,
        'and the solve really did move it along the line (' + triMoved.toFixed(2) +
        ' mm), so this is not a no-op');

    // =========================================================
    console.log('\n--- 4. Fitting one of the two planes cannot take it away ---');
    // =========================================================
    // A fit flattens onto the WALL alone, which would take A off Ground, and
    // `planeImmutableMask` reports only `locked` — so the fit is free to move A
    // and the only thing stopping it is the constrain hook.
    const fitOut = await page.evaluate(async (b) => {
        const P = await import('/ui/plane-definition.js');
        const model = P.planeModel();
        const wall = model.getPlane(b.planes.wall);
        // Bend the wall out of planarity so the fit has real work to do, using
        // a node the pin does not protect.
        model.pool.getNode(b.ids.E).setPoint3d([-140, -60, 1400]);
        const plan = P.planPlaneFit(wall);
        if (!plan || !plan.ok) return { ok: false, code: plan && plan.code };
        const res = P.applyPlaneFit(wall, plan);
        return { ok: true, rms: res.rms, nPoints: res.nPoints };
    }, built);
    check(fitOut.ok, 'the wall fit ran: ' + JSON.stringify(fitOut));

    // The wall now HAS a stored fit, and the reference has to follow: a stored
    // fit is used unexcluded, so the plane A must satisfy is that fit and not
    // the one through B/F/E. They agree here because the fit is CONSTRAINED
    // through B, which is Locked — asserted below rather than assumed.
    const fitHolds = await page.evaluate(async (b) => {
        const P = await import('/ui/plane-definition.js');
        const model = P.planeModel();
        const f = model.getPlane(b.planes.wall).planeFit;
        const pool = model.pool;
        const off = (id) => {
            const p = pool.getNode(id).xyz;
            return Math.abs((p[0] - f.centroid[0]) * f.normal[0] +
                            (p[1] - f.centroid[1]) * f.normal[1] +
                            (p[2] - f.centroid[2]) * f.normal[2]);
        };
        return { stored: !!f, b: off(b.ids.B), f: off(b.ids.F), e: off(b.ids.E) };
    }, built);
    check(fitHolds.stored && fitHolds.b < 1e-6 && fitHolds.f < 1e-6 && fitHolds.e < 1e-6,
        'the wall\'s stored fit passes through B, F and E, so the reference ' +
        'plane through them is that fit: ' +
        [fitHolds.b, fitHolds.f, fitHolds.e].map(v => v.toExponential(1)).join(', '));

    const afterFit = await distOfA();
    check(afterFit.dist < 1e-6,
        'A is STILL on Ground AND on the wall after fitting the wall (' +
        afterFit.dist.toExponential(2) + ' mm)');

    // The control: that fit genuinely wanted to move A. An unheld corner in the
    // same plane did move, so the assertion above is not passing because the
    // fit was a no-op.
    const movedE = await page.evaluate(async (ids) => {
        const P = await import('/ui/plane-definition.js');
        const e = P.planeModel().pool.getNode(ids.E).xyz;
        return Math.hypot(e[0] - (-140), e[1] - (-60), e[2] - 1400);
    }, built.ids);
    check(movedE > 1e-9,
        'while an unpinned corner of the same plane WAS flattened (' +
        movedE.toFixed(3) + ' mm), so the fit was not idle');

    // =========================================================
    console.log('\n--- 5. The 3D drag: offered, and held to the line ---');
    // =========================================================
    // Ground has no stored fit, so the old payload marked its corners inert and
    // the drag could not even start. The surface a derived fit supplies is just
    // as real, and the handler has to agree with the payload or the corner
    // advertises a drag that does nothing.
    const payload = await page.evaluate(async (b) => {
        const AS = await import('/ui/app-state.js');
        const P = await import('/ui/plane-definition.js');
        P.syncPlanes3D();
        const seen = (AS.viewport3d && AS.viewport3d._planes) || [];
        const pick = (id) => seen.find(p => p.id === id) || null;
        const g = pick(b.planes.ground), w = pick(b.planes.wall);
        return {
            groundEditable: g ? !!g.editable : null,
            groundHasSurface: g ? !!g.planeFit : null,
            groundFittedFlag: g ? !!g.fitted : null,
            wallFittedFlag: w ? !!w.fitted : null,
            wallEditable: w ? !!w.editable : null,
        };
    }, built);
    check(payload.groundHasSurface === true,
        'Ground reaches the viewport WITH a surface, though nobody fitted it');
    check(payload.groundEditable === true,
        'so its corners are draggable in 3D');
    check(payload.wallEditable === true, 'and the fitted wall\'s are too');

    // Drag A as a corner of the WALL. The viewport constrains to the wall — the
    // plane under the cursor — and the pin has to override that.
    const dragged = await page.evaluate(async (b) => {
        const AS = await import('/ui/app-state.js');
        const model = (await import('/ui/plane-definition.js')).planeModel();
        const wall = model.getPlane(b.planes.wall);
        const idx = wall.nodeIds.indexOf(b.ids.A);
        // A point ON the wall and well OFF Ground, which is exactly what a real
        // drag up the wall would hand the handler.
        const fit = model.usableFitForPlane(wall);
        const target = [-100, -100, 1300];
        const d = (target[0] - fit.centroid[0]) * fit.normal[0] +
                  (target[1] - fit.centroid[1]) * fit.normal[1] +
                  (target[2] - fit.centroid[2]) * fit.normal[2];
        const onWall = [target[0] - d * fit.normal[0], target[1] - d * fit.normal[1],
                        target[2] - d * fit.normal[2]];
        AS.viewport3d.onPlaneNodeDragged(wall.id, idx, onWall);
        AS.viewport3d.onPlaneNodeDragEnd(wall.id, idx);
        return { idx, onWall };
    }, built);
    check(dragged.idx >= 0, 'A is a corner of the wall (index ' + dragged.idx + ')');

    const afterDrag = await distOfA();
    check(afterDrag.dist < 1e-6,
        'dragged up the WALL, A still lands on the line (' +
        afterDrag.dist.toExponential(2) + ' mm)');
    const dragSlip = await slipFrom(dragged.onWall);
    check(dragSlip < 1e-6,
        'and at the nearest point of it to where the pointer was (' +
        dragSlip.toExponential(2) + ' mm of slip)');
    check(Math.abs(afterDrag.xyz[2] - dragged.onWall[2]) > 1,
        'it did not go where the pointer asked (z ' + afterDrag.xyz[2].toFixed(1) +
        ', asked ' + dragged.onWall[2].toFixed(1) + ')');
    const dragMsg = await statusText();
    check(/plane-locked/i.test(dragMsg),
        'and the drag-end status explains the corner lagging the pointer: ' +
        JSON.stringify(dragMsg.slice(0, 160)));

    // An UNHELD corner of the same plane still goes exactly where it is put —
    // the drag was not broken for everyone in the process.
    const freeDrag = await page.evaluate(async (b) => {
        const AS = await import('/ui/app-state.js');
        const model = (await import('/ui/plane-definition.js')).planeModel();
        const wall = model.getPlane(b.planes.wall);
        const idx = wall.nodeIds.indexOf(b.ids.E);
        const fit = model.usableFitForPlane(wall);
        const t = [-90, -50, 1380];
        const d = (t[0] - fit.centroid[0]) * fit.normal[0] +
                  (t[1] - fit.centroid[1]) * fit.normal[1] +
                  (t[2] - fit.centroid[2]) * fit.normal[2];
        const on = [t[0] - d * fit.normal[0], t[1] - d * fit.normal[1],
                    t[2] - d * fit.normal[2]];
        AS.viewport3d.onPlaneNodeDragged(wall.id, idx, on);
        const got = Array.from(model.pool.getNode(b.ids.E).xyz);
        return Math.hypot(got[0] - on[0], got[1] - on[1], got[2] - on[2]);
    }, built);
    check(freeDrag < 1e-9,
        'an unheld corner lands exactly where the drag put it (' +
        freeDrag.toExponential(2) + ' mm)');

    // =========================================================
    console.log('\n--- 6. A THIRD plane locks the corner outright ---');
    // =========================================================
    // Three planes that meet at a corner leave one position, so the pin becomes
    // a freeze that nobody had to set — and this is not a corner case: in the
    // real five-plane cage the held node is in Ground, the right wall AND the
    // front wall. Nothing is re-pinned to get here; adding the node to a plane
    // is the whole of it.
    const third = await page.evaluate(async (b) => {
        const P = await import('/ui/plane-definition.js');
        const model = P.planeModel();
        const mk = (name, xyz) => {
            document.getElementById('planeNodeNameInput').value = name;
            document.getElementById('btnAddPlaneNode').click();
            const nd = model.pool.nodes[model.pool.nodes.length - 1];
            nd.setPoint3d(xyz);
            return nd;
        };
        // x = -100, through A and D and two new corners: independent of both
        // Ground (tilted about y) and the wall (which faces y).
        const G = mk('G', [-100, -100, 1400]);
        const H = mk('H', [-100, 100, 1400]);
        const front = P.createPlane('front wall');
        [model.pool.getNode(b.ids.A), model.pool.getNode(b.ids.D), G, H]
            .forEach(nd => front.addNode(nd.id));
        P.refreshPlanePanel();
        window.__ref.triples.push([b.ids.D, G.id, H.id]);
        const lock = model.planeLockForNode(b.ids.A);
        return {
            ids: { G: G.id, H: H.id }, plane: front.id,
            rank: lock.rank, holders: lock.planes.map(p => p.name).sort(),
            pin: model.pool.getNode(b.ids.A).pin,
        };
    }, built);
    check(third.rank === 3,
        'three planes pin A in all three directions (rank ' + third.rank + ')');
    check(third.pin === 'plane-locked',
        'and nothing was re-pinned to do it — the pin is still just plane-locked');
    check(third.holders.length === 3,
        'all three are named as holders: ' + JSON.stringify(third.holders));

    // Every edit now resolves to the same point, whatever is typed.
    const frozen = await page.evaluate(async (b) => {
        const P = await import('/ui/plane-definition.js');
        const model = P.planeModel();
        const at = (want) => Array.from(model.constrainPoint3dForNode(b.ids.A, want));
        const p1 = at([1e4, -2e4, 3e4]);
        const p2 = at([-5, 5, -5]);
        const cur = Array.from(model.pool.getNode(b.ids.A).xyz);
        return {
            p1, p2, cur,
            spread: Math.hypot(p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]),
            fromCurrent: Math.hypot(p1[0] - cur[0], p1[1] - cur[1], p1[2] - cur[2]),
        };
    }, built);
    check(frozen.spread < 1e-6,
        'two wildly different edits give the SAME position (' +
        frozen.spread.toExponential(2) + ' mm apart)');
    // The third plane does NOT pass through where A happened to be, so the
    // next edit moves it — which is the pin working, not a fault. On the real
    // project that first snap is 1.7 mm; here it is larger because §5 dragged
    // the corner along the line first.
    check(frozen.fromCurrent > 1,
        'the point they meet at is not where A was sitting, so the next edit ' +
        'snaps it there (' + frozen.fromCurrent.toFixed(2) + ' mm away)');

    // Through the real field, not the model call, so the editor honours it too.
    await page.evaluate(async (ids) => {
        const rows = [...document.querySelectorAll('#planeNodesTable tbody tr.plane-node-main')];
        const row = rows.find(tr => tr.getAttribute('data-plane-node-id') === String(ids.A));
        if (row && !document.querySelector('tr.plane-node-detail')) {
            row.querySelector('.plane-node-expander').click();
            await new Promise(r => setTimeout(r, 60));
        }
        const q = (ax) => document.querySelector(
            'tr.plane-node-detail .plane-node-xyz-input[data-axis="' + ax + '"]');
        ['x', 'y', 'z'].forEach((ax, k) => { q(ax).value = String([500, 500, 500][k]); });
        q('z').dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 120));
    }, built.ids);
    const afterFrozenType = await distOfA();
    check(afterFrozenType.dist < 1e-6,
        'typing (500, 500, 500) leaves A on all three planes (' +
        afterFrozenType.dist.toExponential(2) + ' mm)');
    check(Math.hypot(afterFrozenType.xyz[0] - frozen.p1[0],
        afterFrozenType.xyz[1] - frozen.p1[1],
        afterFrozenType.xyz[2] - frozen.p1[2]) < 1e-6,
        'at exactly the point the three planes meet at, whatever was typed');

    // And it stays there: a second, different edit is a no-op.
    const settled = await page.evaluate(async (ids) => {
        const P = await import('/ui/plane-definition.js');
        const before = Array.from(P.planeModel().pool.getNode(ids.A).xyz);
        const q = (ax) => document.querySelector(
            'tr.plane-node-detail .plane-node-xyz-input[data-axis="' + ax + '"]');
        ['x', 'y', 'z'].forEach((ax, k) => { q(ax).value = String([-9000, 7, 12][k]); });
        q('z').dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 120));
        const after = Array.from(P.planeModel().pool.getNode(ids.A).xyz);
        return Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
    }, built.ids);
    check(settled < 1e-6,
        'and a second, wilder edit moves it not at all (' +
        settled.toExponential(2) + ' mm) — it is locked in all but name');
    const frozenMsg = await statusText();
    check(/plane-locked/i.test(frozenMsg) && /point where/i.test(frozenMsg),
        'and the status names the point, not a plane: ' +
        JSON.stringify(frozenMsg.slice(0, 190)));

    // =========================================================
    console.log('\n--- 7. Set Origin\'s picker is NOT widened ---');
    // =========================================================
    // The drag surface and the origin wizard ask different questions. The
    // wizard offers a plane's corner as the project's origin, which is a
    // declaration the user makes by clicking Fit — so a derived surface must
    // not make an un-Fit plane eligible.
    check(payload.groundFittedFlag === false,
        'Ground is not marked `fitted`, having never been Fit');
    check(payload.wallFittedFlag === true, 'the wall, which was Fit in §4, is');
    const picker = await page.evaluate(async (b) => {
        const AS = await import('/ui/app-state.js');
        const O = await import('/ui/origin-definition.js');
        const flags = [];
        AS.viewport3d._planeGroup.traverse(function (c) {
            if (c.isMesh && c.userData && c.userData.planeId !== undefined) {
                flags.push({ planeId: c.userData.planeId, fitted: !!c.userData.planeFitted });
            }
        });
        const ofGround = flags.filter(f => f.planeId === b.planes.ground);
        const ofWall = flags.filter(f => f.planeId === b.planes.wall);
        return {
            groundPickable: ofGround.some(f => f.fitted),
            wallPickable: ofWall.length > 0 && ofWall.every(f => f.fitted),
            nFitted: O.fittedPlanes().length,
        };
    }, built);
    check(picker.groundPickable === false,
        'no corner of un-Fit Ground is offered to the origin wizard');
    check(picker.wallPickable === true, 'every corner of the Fit wall is');
    check(picker.nFitted === 1,
        'and `fittedPlanes()` still counts stored fits only (' + picker.nFitted + ')');

    console.log(`\n${fails === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${fails} CHECK(S) FAILED`}`);
} catch (e) {
    console.error('FATAL', e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
process.exit(fails === 0 ? 0 : 1);
