/**
 * plane-angle.mjs — "Set Angle Between Two Planes", in the real app.
 *
 * The user's case: an open-top box annotated as five planes, whose walls come
 * out a degree or two off perpendicular because every plane is fitted
 * independently through noisy triangulated corners. This drives the real panel
 * button, the real dialog and the real commit over a floor and a wall whose
 * true angle is known analytically (their 2D is synthesized by projecting a
 * ground-truth 3D quad through the real `Camera.project`), so the angle the
 * feature reports can be checked against arithmetic rather than against itself.
 *
 * What it pins that the ESM unit tests cannot:
 *   * the button's gating (two FITTED planes, not two planes)
 *   * the dialog: readout, revert-on-invalid, Esc-cancels, Apply
 *   * the AUTO-LOCK, and the Triangulate error modal that auto-lock makes
 *     necessary — the user asked for both, and the modal is the only thing
 *     telling them why Triangulate appears to skip part of their plane
 *   * the 3D ghost preview living in its own group and never touching
 *     `_planeGroup`
 *   * the EDIT LOCK: while the dialog is open the 3D view stays orbitable but
 *     plane data is frozen in all three places it could be edited from
 *   * that the whole thing is inert until Apply
 *
 * Run: node plane-angle.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8196);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol);

// Ground truth. The floor is the z = 220 plane; the wall is hinged to it along
// the shared edge h0-h1 and leans at exactly 60 degrees, because its in-plane
// direction away from the hinge is 60 * (0, cos 60, sin 60).
const B = 60 * Math.PI / 180;
const OFF = [0, 60 * Math.cos(B), 60 * Math.sin(B)];
const H0 = [-40, -30, 220];
const H1 = [40, -30, 220];
const TRUTH_FLOOR = [H0, H1, [40, 30, 220], [-40, 30, 220]];
const TRUTH_WALL = [
    H0, H1,
    [H1[0] + OFF[0], H1[1] + OFF[1], H1[2] + OFF[2]],
    [H0[0] + OFF[0], H0[1] + OFF[1], H0[2] + OFF[2]],
];

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
    // A two-camera session with real canvases
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
    });
    await page.waitForFunction(
        () => window.__lucid.state.views.every(v => !!v.overlayCanvas), { timeout: 10000 });

    // Helpers: the same index-translation shims define-plane-mode.mjs installs,
    // so the assertions below are about behaviour rather than arithmetic.
    await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const AS = await import('/ui/app-state.js');
        const PA = await import('/pose/plane-angle.js');
        const SL = await import('/import-export/save-load.js');
        window.__P = P; window.__AS = AS; window.__PA = PA; window.__saveLoad = SL;
        window.__vp = () => AS.viewport3d;
        window.__poolIdx = (plane) => plane.nodeIds.map(id => P.planeModel().pool.indexOf(id));
        window.__nodesOf = (plane) => plane.nodeIds.map(id => P.planeModel().pool.getNode(id));
        window.__namesOf = (plane) => window.__nodesOf(plane).map(n => n && n.name);
        window.__pinsOf = (plane) => window.__nodesOf(plane).map(n => n && n.pin);
        window.__xyzOf = (plane) => window.__nodesOf(plane).map(
            n => n && n.hasPoint3d() ? n.getPoint3d().map(v => Number(v.toFixed(6))) : null);
        window.__setPts = (plane, view, pts) => {
            const inst = P.getPlaneInstance(view);
            const idx = window.__poolIdx(plane);
            pts.forEach((q, k) => inst.setPoint(idx[k], q[0], q[1]));
        };
        /** The angle between two planes, straight from the model's own fits. */
        window.__angle = (a, b) => (a.planeFit && b.planeFit)
            ? PA.planeAngleDeg(a.planeFit.normal, b.planeFit.normal) : null;
        /**
         * The angle between where the CORNERS actually are, ignoring both
         * planes' stored fits.
         *
         * `__angle` reads the stored fits, and a stored fit is deliberately not
         * re-derived when a node moves (`ui/plane-definition.js`: "a corner
         * nudge must not move the frame it defines"). So after a re-solve the
         * stored fit can still read 90 degrees while the corners have wandered
         * off it — which would make the hold-vs-no-hold sections below pass
         * whatever happened. This measures the points.
         */
        window.__pointAngle = async (a, b) => {
            const T = await import('/pose/triangulation.js');
            const fa = T.fitPlaneToPoints3d(P.planePoints3d(a));
            const fb = T.fitPlaneToPoints3d(P.planePoints3d(b));
            return (fa && fb) ? PA.planeAngleDeg(fa.normal, fb.normal) : null;
        };
        window.__dlg = () => {
            const el = document.getElementById('planeDialogMessage');
            return el ? el.textContent : null;
        };
        /**
         * Give every plane a fit WITHOUT moving a node.
         *
         * The real Fit button flattens the corners onto the fitted plane, which
         * shifts shared corners by ~1e-13 — enough for `planPlaneFit`'s exact
         * `Object.is` diff to call them moved and mark the OTHER plane's fit
         * stale. Two planes sharing an edge therefore invalidate each other
         * forever, and no number of alternating clicks leaves both fitted.
         * That is real app behaviour, and section 1 exercises it through the
         * real buttons; the later sections are about the DIALOG, so they use
         * the real fit function on the real points and assign the result
         * directly, which moves nothing and settles immediately.
         */
        window.__ensureFits = async () => {
            const T = await import('/pose/triangulation.js');
            for (const plane of P.planeModel().planes) {
                const fit = T.fitPlaneToPoints3d(P.planePoints3d(plane));
                if (fit) {
                    plane.planeFit = {
                        centroid: fit.centroid, normal: fit.normal,
                        rms: fit.rms, nPoints: fit.nPoints, constrained: false,
                    };
                }
            }
            P.refreshPlanePanel();
        };
        window.__dismissDlg = () => {
            const b = document.getElementById('btnPlaneDialogDismiss');
            if (b) { b.click(); return true; }
            return false;
        };
    });

    // =================================================================
    // 1 — the button exists and is gated on TWO fitted planes
    // =================================================================
    console.log('\n1. The button is gated on two fitted planes');
    let m = await page.evaluate(() => {
        const btn = document.getElementById('btnSetPlaneAngle');
        return { exists: !!btn, disabled: btn && btn.disabled, title: btn && btn.title };
    });
    check(m.exists, 'the Set Angle Between Planes button exists in the Planes panel');
    check(m.disabled, 'and starts disabled, with no planes fitted');
    check(/two planes/i.test(m.title || ''), 'its title says why (got "' + m.title + '")');

    // Build the floor and the wall, SHARING their two hinge nodes.
    m = await page.evaluate(async ([TF, TW]) => {
        const P = window.__P, AS = window.__AS;
        const model = P.planeModel();
        const cams = AS.state.session.cameras;
        const out = {};

        const floor = P.createPlane('floor');
        ['h0', 'h1', 'f2', 'f3'].forEach(n => model.createNodeInPlane(n, floor));
        for (let k = 0; k < 4; k++) floor.addEdge(floor.nodeIds[k], floor.nodeIds[(k + 1) % 4]);

        // The wall REFERENCES the floor's two hinge nodes — one node, one xyz.
        // That sharing is what makes the shared edge a real hinge.
        const wall = P.createPlane('wall');
        model.addNodeToPlane(wall, floor.nodeIds[0]);
        model.addNodeToPlane(wall, floor.nodeIds[1]);
        ['w2', 'w3'].forEach(n => model.createNodeInPlane(n, wall));
        for (let k = 0; k < 4; k++) wall.addEdge(wall.nodeIds[k], wall.nodeIds[(k + 1) % 4]);

        out.sharedNames = window.__PA.sharedNodeIds(wall, floor)
            .map(id => model.pool.getNode(id).name);

        // Place both planes on both views and write pixel-exact 2D.
        for (const plane of [floor, wall]) {
            const truth = plane === floor ? TF : TW;
            for (const cam of cams) {
                P.placePlaneOnView(plane, cam.name, 320, 240);
                window.__setPts(plane, cam.name, truth.map(q => cam.project(q)));
            }
        }

        // Solve, then fit, through the real buttons.
        for (const plane of [floor, wall]) {
            P.planeState.selectedPlaneId = plane.id;
            P.refreshPlanePanel();
            document.getElementById('btnPlaneTriangulate').click();
        }
        for (const plane of [wall, floor]) {
            P.planeState.selectedPlaneId = plane.id;
            P.refreshPlanePanel();
            document.getElementById('btnPlaneFit').click();
        }
        // A fit flattens corners by ~1e-13, which counts as "moved" and can
        // mark the other plane's fit stale. Re-fit whichever lost its fit until
        // both hold one; the geometry is exactly planar so this converges.
        for (let round = 0; round < 4 && (!floor.planeFit || !wall.planeFit); round++) {
            for (const plane of [floor, wall]) {
                if (plane.planeFit) continue;
                P.planeState.selectedPlaneId = plane.id;
                P.refreshPlanePanel();
                document.getElementById('btnPlaneFit').click();
            }
        }
        window.__dismissDlg();

        out.floorFitted = !!floor.planeFit;
        out.wallFitted = !!wall.planeFit;
        out.angle = window.__angle(floor, wall);
        const btn = document.getElementById('btnSetPlaneAngle');
        out.enabled = !btn.disabled;
        out.floorNames = window.__namesOf(floor);
        out.wallNames = window.__namesOf(wall);
        return out;
    }, [TRUTH_FLOOR, TRUTH_WALL]);

    check(eq(m.sharedNames, ['h0', 'h1']), 'the wall shares the floor\'s two hinge nodes');
    check(eq(m.floorNames, ['h0', 'h1', 'f2', 'f3']), 'the floor has its four corners');
    check(eq(m.wallNames, ['h0', 'h1', 'w2', 'w3']), 'and the wall has the hinge plus two of its own');
    check(m.floorFitted && m.wallFitted, 'both planes triangulate and fit through the real buttons');
    check(near(m.angle, 60, 0.05),
        'and the model measures their angle as the ground truth 60° (got ' +
        (m.angle === null ? 'null' : m.angle.toFixed(4)) + ')');
    check(m.enabled, 'with two fitted planes the button becomes available');

    // =================================================================
    // 2 — the dialog reads out the current state and previews in 3D
    // =================================================================
    console.log('\n2. The dialog, and the 3D ghost preview');
    m = await page.evaluate(() => {
        const out = {};
        out.planeGroupBefore = window.__vp()._planeGroup.children.length;
        out.ghostBefore = window.__vp()._angleGroup.children.length;
        document.getElementById('btnSetPlaneAngle').click();
        out.open = !!document.getElementById('planeAngleOverlay');
        out.readout = document.getElementById('planeAngleReadout').textContent;
        out.target = document.getElementById('planeAngleTarget').value;
        out.applyDisabled = document.getElementById('btnPlaneAngleApply').disabled;
        out.fixedOpts = Array.from(document.getElementById('planeAngleFixed').options).map(o => o.textContent);
        out.movingOpts = Array.from(document.getElementById('planeAngleMoving').options).map(o => o.textContent);
        out.ghostAfter = window.__vp()._angleGroup.children.length;
        out.planeGroupAfter = window.__vp()._planeGroup.children.length;
        return out;
    });
    check(m.open, 'clicking the button opens the dialog');
    check(/Current angle: 60\./.test(m.readout),
        'the readout states the current angle (got "' + m.readout.replace(/\n/g, ' | ') + '")');
    check(/shared edge/.test(m.readout), 'and that the hinge is the shared edge');
    check(/2 node\(s\) stay put/.test(m.readout), 'naming how many corners stay put');
    check(m.target === '90', 'the target defaults to 90 (square it up)');
    check(!m.applyDisabled, 'Apply is available for a valid plan');
    check(eq(m.fixedOpts.slice().sort(), ['floor', 'wall']), 'both fitted planes are offered as fixed');
    check(eq(m.movingOpts.slice().sort(), ['floor', 'wall']), 'and as moving');
    check(m.ghostBefore === 0 && m.ghostAfter > 0,
        'the 3D ghost appears when the dialog opens (' + m.ghostBefore + ' -> ' + m.ghostAfter + ')');
    check(m.planeGroupBefore === m.planeGroupAfter,
        'and _planeGroup is untouched, so the real planes are not disturbed');

    // Revert-on-invalid, then Esc.
    m = await page.evaluate(() => {
        const t = document.getElementById('planeAngleTarget');
        const set = v => {
            t.value = v;
            t.dispatchEvent(new Event('input', { bubbles: true }));
            t.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const out = {};
        set('120');
        out.clampedHigh = t.value;
        set('-5');
        out.clampedLow = t.value;
        set('');
        out.reverted = t.value;
        set('45');
        out.ok45 = t.value;
        out.readout45 = document.getElementById('planeAngleReadout').textContent;
        out.ghost45 = window.__vp()._angleGroup.children.length;
        return out;
    });
    check(m.clampedHigh === '90', 'a target above 90 is not accepted (reverted to 90)');
    check(m.clampedLow === '0', 'nor is a negative one');
    check(m.reverted === '90', 'an empty field reverts to the default rather than being committed');
    check(m.ok45 === '45' && m.ghost45 > 0, 'a valid target keeps the ghost live');

    m = await page.evaluate(() => ({ angle: window.__angle(window.__P.planeModel().planes[0], window.__P.planeModel().planes[1]) }));
    check(near(m.angle, 60, 0.05), 'and nothing has been committed while the dialog is open');

    await page.keyboard.press('Escape');
    m = await page.evaluate(() => ({
        open: !!document.getElementById('planeAngleOverlay'),
        ghost: window.__vp()._angleGroup.children.length,
        angle: window.__angle(window.__P.planeModel().planes[0], window.__P.planeModel().planes[1]),
    }));
    check(!m.open, 'Esc closes the dialog (the app-wide modal convention)');
    check(m.ghost === 0, 'and clears the ghost with it');
    check(near(m.angle, 60, 0.05), 'Esc commits nothing');

    // Cancel also clears the ghost.
    m = await page.evaluate(() => {
        document.getElementById('btnSetPlaneAngle').click();
        const mid = window.__vp()._angleGroup.children.length;
        document.getElementById('btnPlaneAngleCancel').click();
        return { mid, after: window.__vp()._angleGroup.children.length,
                 open: !!document.getElementById('planeAngleOverlay') };
    });
    check(m.mid > 0 && m.after === 0 && !m.open, 'Cancel closes the dialog and clears the ghost');

    // =================================================================
    // 3 — Apply squares the wall up, and locks what it moved
    // =================================================================
    console.log('\n3. Apply: 60° -> 90°, and the moved nodes are Plane-locked');
    m = await page.evaluate(() => {
        const P = window.__P;
        const model = P.planeModel();
        const floor = model.planes[0], wall = model.planes[1];
        const out = { before: { pins: window.__pinsOf(wall), xyz: window.__xyzOf(wall) } };

        window.__saveLoad.clearDirty();
        document.getElementById('btnSetPlaneAngle').click();
        // Hold the FLOOR fixed and move the WALL.
        const fx = document.getElementById('planeAngleFixed');
        const mv = document.getElementById('planeAngleMoving');
        fx.value = String(floor.id);
        fx.dispatchEvent(new Event('change', { bubbles: true }));
        mv.value = String(wall.id);
        mv.dispatchEvent(new Event('change', { bubbles: true }));
        const t = document.getElementById('planeAngleTarget');
        t.value = '90';
        t.dispatchEvent(new Event('input', { bubbles: true }));
        out.fixedName = fx.options[fx.selectedIndex].textContent;
        out.movingName = mv.options[mv.selectedIndex].textContent;
        out.warn = document.getElementById('planeAngleWarn').textContent;

        document.getElementById('btnPlaneAngleApply').click();

        out.open = !!document.getElementById('planeAngleOverlay');
        out.ghost = window.__vp()._angleGroup.children.length;
        out.angle = window.__angle(floor, wall);
        out.pins = window.__pinsOf(wall);
        out.heldIn = window.__nodesOf(wall)
            .filter(n => n.pin === 'plane-locked')
            .map(n => { const p = model.getPlane(n.pinPlaneId); return p ? p.name : null; });
        out.xyz = window.__xyzOf(wall);
        out.names = window.__namesOf(wall);
        out.floorPins = window.__pinsOf(floor);
        out.status = (document.getElementById('statusText') || {}).textContent || '';
        out.dirty = window.__AS.state.isDirty === true;
        out.floorFit = !!floor.planeFit;
        return out;
    });
    check(m.fixedName === 'floor' && m.movingName === 'wall', 'the floor is fixed and the wall moves');
    check(!m.open, 'Apply closes the dialog');
    check(m.ghost === 0, 'and clears the ghost, because the real plane now shows the result');
    check(near(m.angle, 90, 1e-6),
        'the wall is now at 90° to the floor (got ' + m.angle.toFixed(9) + ')');

    // The hinge corners must not have moved at all.
    check(eq(m.xyz[0], m.before.xyz[0]) && eq(m.xyz[1], m.before.xyz[1]),
        'the two shared hinge corners did not move');
    check(!eq(m.xyz[2], m.before.xyz[2]) && !eq(m.xyz[3], m.before.xyz[3]),
        'while the wall\'s own two corners did');
    check(m.floorFit, 'the floor keeps its fit, because none of ITS corners moved');

    // The auto-hold. PLANE-locked, not Locked: the assertion is about the
    // plane's orientation, so a later solve may still move these corners — but
    // only within the plane the angle was just set on.
    check(eq(m.pins, ['none', 'none', 'plane-locked', 'plane-locked']),
        'the two moved corners are now Plane-locked, and the hinge corners are not (got ' +
        JSON.stringify(m.pins) + ')');
    check(eq(m.heldIn, ['wall', 'wall']),
        `and they are held in the plane that moved (got ${JSON.stringify(m.heldIn)})`);
    check(eq(m.floorPins, ['none', 'none', 'none', 'none']),
        'the fixed plane\'s corners are left unpinned');
    check(/Plane-locked/.test(m.status),
        'the status line says so (got "' + m.status.slice(0, 180) + '")');
    check(m.dirty, 'and the project is marked dirty');

    // A vertical wall's free corners sit directly above the hinge in y.
    check(near(m.xyz[2][1], m.before.xyz[0][1], 1e-4) &&
          near(m.xyz[3][1], m.before.xyz[1][1], 1e-4),
        'the wall is vertical: its free corners share the hinge\'s y');

    // =================================================================
    // 4 — a re-solve may move the held corners, but not OFF the plane
    // =================================================================
    console.log('\n4. Triangulate re-solves the held corners, and the angle survives');
    m = await page.evaluate(async () => {
        const P = window.__P;
        const wall = P.planeModel().planes[1];

        // Perturb the wall's 2D on one view first. This is the step that makes
        // the hold's protection OBSERVABLE: `applyAngleEdit` rewrote the 2D to
        // agree with the rotated 3D, so without a perturbation a re-solve would
        // faithfully reproduce the 90 degrees and held-vs-not-held would look
        // identical. Moving the annotation is what a user doing more work on
        // this plane would do.
        const inst = P.getPlaneInstance('camB');
        const idx = window.__poolIdx(wall);
        [2, 3].forEach(k => {
            const pt = inst.getPoint(idx[k]);
            inst.setPoint(idx[k], pt[0] + 14, pt[1] - 10);
        });

        P.planeState.selectedPlaneId = wall.id;
        P.refreshPlanePanel();
        const out = { before: window.__xyzOf(wall), pins: window.__pinsOf(wall) };
        document.getElementById('btnPlaneTriangulate').click();
        out.dlg = window.__dlg();
        out.after = window.__xyzOf(wall);
        out.angle = await window.__pointAngle(P.planeModel().planes[0], wall);
        window.__dismissDlg();
        return out;
    });
    check(eq(m.pins, ['none', 'none', 'plane-locked', 'plane-locked']),
        'precondition: the two rotated corners are Plane-locked');
    check(m.dlg === null,
        'Triangulate raises NO locked-nodes dialog — nothing here is frozen outright');
    check(!eq(m.after[2], m.before[2]) && !eq(m.after[3], m.before[3]),
        'the held corners DO move: the solver still gets to refine them');
    check(near(m.angle, 90, 1e-6),
        'and the CORNERS still make 90° with the floor — they landed back on ' +
        'the wall (got ' + m.angle.toFixed(6) + ')');
    check(eq(m.after[0], m.before[0]) && eq(m.after[1], m.before[1]),
        'and the hinge corners, whose 2D did not change, stay put');

    // =================================================================
    // 5 — setting them Free hands the corners back completely
    // =================================================================
    console.log('\n5. Setting the corners Free lets the solve leave the plane');
    m = await page.evaluate(async () => {
        const P = window.__P;
        const model = P.planeModel();
        const wall = model.planes[1];
        window.__nodesOf(wall).forEach(n => model.pool.setPin(n.id, 'none'));
        // Perturb again: the previous solve already agreed with the 2D on camB.
        const inst = P.getPlaneInstance('camB');
        const idx = window.__poolIdx(wall);
        [2, 3].forEach(k => {
            const pt = inst.getPoint(idx[k]);
            inst.setPoint(idx[k], pt[0] - 18, pt[1] + 13);
        });
        P.planeState.selectedPlaneId = wall.id;
        P.refreshPlanePanel();
        const out = { pins: window.__pinsOf(wall), before: window.__xyzOf(wall) };
        document.getElementById('btnPlaneTriangulate').click();
        out.dlg = window.__dlg();
        out.after = window.__xyzOf(wall);
        out.angle = await window.__pointAngle(model.planes[0], wall);
        window.__dismissDlg();
        return out;
    });
    check(eq(m.pins, ['none', 'none', 'none', 'none']), 'the corners are Free');
    check(m.dlg === null, 'Triangulate raises no dialog');
    check(!eq(m.after[2], m.before[2]) && !eq(m.after[3], m.before[3]),
        're-solves both corners from their (perturbed) 2D, as asked');
    check(m.angle !== null && Math.abs(m.angle - 90) > 1e-3,
        'and with nothing holding them they leave the plane, so the angle drifts ' +
        `off 90° (got ${m.angle === null ? 'null' : m.angle.toFixed(4)}°) — which is ` +
        'exactly what the hold in §4 prevents');

    // =================================================================
    // 5b — a LOCKED node still gets the modal Triangulate owes it
    // =================================================================
    // The angle edit no longer creates Locked nodes, but the user can, and the
    // rule that Triangulate must SAY it skipped them (rather than burying it in
    // a success line) is the same rule. This is the only place it is asserted.
    console.log('\n5b. Triangulate still names a plane\'s Locked nodes in a modal');
    m = await page.evaluate(() => {
        const P = window.__P;
        const model = P.planeModel();
        const wall = model.planes[1];
        const nodes = window.__nodesOf(wall);
        model.pool.setPin(nodes[2].id, 'locked');
        model.pool.setPin(nodes[3].id, 'locked');
        const inst = P.getPlaneInstance('camB');
        const idx = window.__poolIdx(wall);
        [2, 3].forEach(k => {
            const pt = inst.getPoint(idx[k]);
            inst.setPoint(idx[k], pt[0] + 11, pt[1] + 9);
        });
        P.planeState.selectedPlaneId = wall.id;
        P.refreshPlanePanel();
        const out = { before: window.__xyzOf(wall) };
        document.getElementById('btnPlaneTriangulate').click();
        out.dlg = window.__dlg();
        out.after = window.__xyzOf(wall);
        out.dismissed = window.__dismissDlg();
        out.stillOpen = !!document.getElementById('planeDialog');
        window.__nodesOf(wall).forEach(n => model.pool.setPin(n.id, 'none'));
        return out;
    });
    check(m.dlg !== null, 'Triangulate raises the dialog rather than only a status line');
    check(/Locked/.test(m.dlg || ''), 'the message says the nodes are Locked');
    check(/w2/.test(m.dlg || '') && /w3/.test(m.dlg || ''),
        'and NAMES them rather than counting them (got "' +
        String(m.dlg).replace(/\n+/g, ' | ').slice(0, 140) + '")');
    check(/Nodes table/.test(m.dlg || ''), 'and says where to unlock them');
    check(m.dismissed && !m.stillOpen, 'the dialog dismisses with OK');
    check(eq(m.after[2], m.before[2]) && eq(m.after[3], m.before[3]),
        'and the Locked corners were not re-solved, even though their 2D moved');

    // =================================================================
    // 6 — a pre-Locked node refuses the edit outright
    // =================================================================
    console.log('\n6. A Locked node that would move refuses the whole edit');
    m = await page.evaluate(async () => {
        const P = window.__P;
        const model = P.planeModel();
        const floor = model.planes[0], wall = model.planes[1];
        // Lock one of the corners the rotation would have to move. Pinning
        // clears the fit of every plane holding that node, so fit afterwards.
        const w2 = window.__nodesOf(wall)[2];
        model.pool.setPin(w2.id, 'locked');
        await window.__ensureFits();

        const out = { bothFitted: !!(floor.planeFit && wall.planeFit),
                      before: window.__xyzOf(wall) };
        out.diag = {
            floorFit: !!floor.planeFit, wallFit: !!wall.planeFit,
            btnDisabled: document.getElementById('btnSetPlaneAngle').disabled,
            nFitted: (await import('/ui/origin-definition.js')).fittedPlanes().length,
            pins: window.__pinsOf(wall),
            has3d: window.__nodesOf(wall).map(n => n.hasPoint3d()),
        };

        document.getElementById('btnSetPlaneAngle').click();
        out.diag.opened = !!document.getElementById('planeAngleOverlay');
        out.diag.fallbackDlg = window.__dlg();
        if (!out.diag.opened) { window.__dismissDlg(); return out; }
        const fx = document.getElementById('planeAngleFixed');
        const mv = document.getElementById('planeAngleMoving');
        fx.value = String(floor.id); fx.dispatchEvent(new Event('change', { bubbles: true }));
        mv.value = String(wall.id); mv.dispatchEvent(new Event('change', { bubbles: true }));
        const t = document.getElementById('planeAngleTarget');
        t.value = '90'; t.dispatchEvent(new Event('input', { bubbles: true }));

        out.warn = document.getElementById('planeAngleWarn').textContent;
        out.applyDisabled = document.getElementById('btnPlaneAngleApply').disabled;
        out.ghost = window.__vp()._angleGroup.children.length;
        out.after = window.__xyzOf(wall);
        document.getElementById('btnPlaneAngleCancel').click();
        return out;
    });
    if (!m.bothFitted || !m.diag.opened) console.log('    diag:', JSON.stringify(m.diag));
    check(m.bothFitted, 'precondition: both planes are fitted again');
    check(m.diag.opened, 'and the dialog opens');
    check(m.applyDisabled, 'Apply is disabled — the edit cannot be committed');
    check(/Locked/.test(m.warn || '') && /w2/.test(m.warn || ''),
        'the dialog explains which Locked node blocks it (got "' +
        String(m.warn).replace(/\n+/g, ' | ').slice(0, 160) + '")');
    check(m.ghost === 0, 'and no ghost is shown for a plan that cannot run');
    check(eq(m.after, m.before), 'nothing moved');

    // =================================================================
    // 6b — the Plane-locked warning NAMES its nodes, in the real dialog
    // =================================================================
    console.log('\n6b. The Plane-locked warning names the node and the plane holding it');
    m = await page.evaluate(async () => {
        const P = window.__P;
        const model = P.planeModel();
        const floor = model.planes[0], wall = model.planes[1];
        // Held in the FIXED plane, so the rotation cannot honour it and the
        // commit would project the node back — the warned case, not the
        // refused one.
        const w2 = window.__nodesOf(wall)[2];
        model.pool.setPin(w2.id, 'plane-locked', floor.id);
        await window.__ensureFits();

        const out = { node: w2.name, fixedName: floor.name };
        document.getElementById('btnSetPlaneAngle').click();
        const fx = document.getElementById('planeAngleFixed');
        const mv = document.getElementById('planeAngleMoving');
        fx.value = String(floor.id); fx.dispatchEvent(new Event('change', { bubbles: true }));
        mv.value = String(wall.id); mv.dispatchEvent(new Event('change', { bubbles: true }));
        const t = document.getElementById('planeAngleTarget');
        t.value = '90'; t.dispatchEvent(new Event('input', { bubbles: true }));

        out.warn = document.getElementById('planeAngleWarn').textContent;
        const line = document.querySelector('#planeAngleWarn .plane-angle-warning');
        out.tip = line ? line.title : null;
        out.applyDisabled = document.getElementById('btnPlaneAngleApply').disabled;
        document.getElementById('btnPlaneAngleCancel').click();
        model.pool.setPin(w2.id, 'none');
        await window.__ensureFits();
        return out;
    });
    check(!m.applyDisabled, 'the edit is warned about, not refused');
    check(new RegExp(m.node + ' \\(in "' + m.fixedName + '"\\)').test(m.warn || ''),
        'the rendered warning names the NODE and the plane holding it (got "' +
        String(m.warn).replace(/\n+/g, ' | ').slice(0, 200) + '")');
    check(/1 node is Plane-locked/.test(m.warn || ''), 'with the singular wording');
    check(new RegExp(m.node).test(m.tip || ''),
        'and the line carries the untruncated list as a tooltip (got "' +
        String(m.tip) + '")');

    // =================================================================
    // 7 — the button is locked inside Set Origin Mode
    // =================================================================
    console.log('\n7. Set Origin Mode locks the button, like every other panel button');
    m = await page.evaluate(async () => {
        const O = await import('/ui/origin-definition.js');
        const P = window.__P;
        const model = P.planeModel();
        window.__nodesOf(model.planes[1]).forEach(n => model.pool.setPin(n.id, 'none'));
        await window.__ensureFits();
        const before = document.getElementById('btnSetPlaneAngle').disabled;
        O.enterOriginMode();
        const during = document.getElementById('btnSetPlaneAngle').disabled;
        O.exitOriginMode();
        const after = document.getElementById('btnSetPlaneAngle').disabled;
        return { before, during, after, active: O.isOriginModeActive() };
    });
    check(!m.before, 'the button is live before entering the mode');
    check(m.during, 'disabled inside Set Origin Mode');
    check(!m.after && !m.active, 'and restored on the way out');

    // =================================================================
    // 8 — a triangulated plane with NO stored fit is still offered
    // =================================================================
    // The reported bug: a user with five annotated planes saw two in the
    // dropdown. A plane loses its stored `planeFit` whenever a node it holds is
    // pinned — which the angle edit itself does — and the dialog used to ask
    // `fittedPlanes()`, so those planes vanished from it. A plane that has been
    // triangulated has a plane; it does not need to have been Fitted.
    console.log('\n8. A triangulated plane with no stored fit is still offered');
    m = await page.evaluate(async () => {
        const P = window.__P;
        const PA = await import('/ui/plane-angle.js');
        const O = await import('/ui/origin-definition.js');
        const model = P.planeModel();
        const floor = model.planes[0], wall = model.planes[1];
        const out = {};

        // Pin a floor-only corner through the Nodes table, exactly as a user
        // would: click its padlock, then pick Locked from the picker. The
        // handler clears the fit of every plane standing on it.
        const row = Array.from(document.querySelectorAll('#planeNodesTable tbody tr.plane-node-main'))
            .find(r => r.querySelector('.plane-node-name').value === 'f2');
        row.querySelector('.plane-node-pin-btn').click();
        document.querySelector('#planePinPopover .plane-pin-option[data-pin="locked"]').click();

        out.floorFit = !!floor.planeFit;
        out.wallFit = !!wall.planeFit;
        out.floorHas3d = window.__nodesOf(floor).every(n => n.hasPoint3d());
        out.nFitted = O.fittedPlanes().length;
        out.usable = PA.anglePlanes().map(p => p.name);
        out.btnDisabled = document.getElementById('btnSetPlaneAngle').disabled;

        document.getElementById('btnSetPlaneAngle').click();
        out.opened = !!document.getElementById('planeAngleOverlay');
        if (out.opened) {
            const fx = document.getElementById('planeAngleFixed');
            out.options = Array.from(fx.options).map(o => o.textContent);
            fx.value = String(floor.id);
            fx.dispatchEvent(new Event('change', { bubbles: true }));
            const mv = document.getElementById('planeAngleMoving');
            mv.value = String(wall.id);
            mv.dispatchEvent(new Event('change', { bubbles: true }));
            out.readout = document.getElementById('planeAngleReadout').textContent;
            out.applyDisabled = document.getElementById('btnPlaneAngleApply').disabled;
            document.getElementById('btnPlaneAngleCancel').click();
        }
        out.floorFitAfter = !!floor.planeFit;
        out.pinAfter = model.pool.getNode(window.__nodesOf(floor)[2].id).pin;
        return out;
    });
    check(!m.floorFit && m.floorHas3d,
        'pinning a corner clears the floor\'s stored fit, though its 3D is all there');
    check(m.nFitted === 1,
        `so the old question — how many planes are FITTED — now answers 1 (got ${m.nFitted})`);
    check(eq(m.usable, ['floor', 'wall']),
        `but both planes are still usable (got ${JSON.stringify(m.usable)})`);
    check(!m.btnDisabled, 'and the button stays live');
    check(m.opened && eq(m.options, ['floor', 'wall']),
        `the dropdown lists both (got ${JSON.stringify(m.options)})`);
    check(/\d+\.\d+°/.test(m.readout || ''),
        `the current angle is measured from the derived fit (got "${String(m.readout).replace(/\n+/g, ' | ').slice(0, 80)}")`);
    check(!m.applyDisabled, 'and the edit can be applied');
    check(!m.floorFitAfter && m.pinAfter === 'locked',
        'opening and cancelling wrote nothing — the derived fit was not stored');

    // =================================================================
    // 9 — the dialog sits BESIDE the 3D view, leaves it usable, and says
    //     which plane is which
    // =================================================================
    console.log('\n9. The dialog is beside the 3D view, not over it, and names the planes in 3D');
    m = await page.evaluate(() => {
        const P = window.__P;
        const model = P.planeModel();
        const floor = model.planes[0], wall = model.planes[1];
        const out = {};

        document.getElementById('btnSetPlaneAngle').click();
        const overlay = document.getElementById('planeAngleOverlay');
        const modal = overlay.querySelector('.plane-confirm-modal');
        out.opened = !!overlay;

        // Not modal: the backdrop must not eat the pointer, or the 3D view
        // underneath cannot be orbited while the dialog is open.
        out.overlayPE = getComputedStyle(overlay).pointerEvents;
        out.modalPE = getComputedStyle(modal).pointerEvents;
        out.scrim = getComputedStyle(overlay).backgroundColor;
        // What the user would actually hit when clicking into the 3D view.
        const host = document.getElementById('viewport3dContainer');
        const hr = host.getBoundingClientRect();
        const hit = document.elementFromPoint(
            Math.round(hr.left + hr.width / 2), Math.round(hr.top + hr.height / 2));
        out.hitIsInViewport = !!(hit && host.contains(hit));

        const mr = modal.getBoundingClientRect();
        out.modalRight = Math.round(mr.right);
        out.hostLeft = Math.round(hr.left);
        out.parkedLeft = mr.right <= hr.left + 1;

        // The role outlines, keyed by plane id, with the colour each wears.
        const rolesOf = () => {
            const g = window.__vp()._planeRoleGroup;
            const by = {};
            g.children.forEach(c => {
                const id = String(c.name).split('_')[1];
                by[id] = '#' + c.material.color.getHexString();
            });
            return by;
        };
        out.roles = rolesOf();
        out.fixedId = String(floor.id);
        out.movingId = String(wall.id);

        // Swapping the roles swaps the outlines, not just the dropdowns.
        document.getElementById('btnPlaneAngleSwap').click();
        out.rolesAfterSwap = rolesOf();

        out.planeGroupBefore = window.__vp()._planeGroup.children.length;
        document.getElementById('btnPlaneAngleCancel').click();
        out.rolesAfterClose = Object.keys(rolesOf()).length;
        out.planeGroupAfter = window.__vp()._planeGroup.children.length;
        return out;
    });
    check(m.opened, 'the dialog opens');
    check(m.overlayPE === 'none' && m.modalPE === 'auto',
        `the backdrop passes the pointer through and the dialog keeps it (got ${m.overlayPE} / ${m.modalPE})`);
    check(/rgba\(0, 0, 0, 0\)|transparent/.test(m.scrim),
        `and draws no scrim over the 3D view (got "${m.scrim}")`);
    check(m.hitIsInViewport,
        'a click in the middle of the 3D view reaches the viewport, not the overlay');
    check(m.parkedLeft,
        `the dialog opens to the LEFT of the 3D view (modal right ${m.modalRight}, view left ${m.hostLeft})`);
    check(m.roles[m.fixedId] === '#4da3ff' && m.roles[m.movingId] === '#ffd24d',
        `each plane is outlined in its role's colour (got ${JSON.stringify(m.roles)})`);
    check(m.rolesAfterSwap[m.fixedId] === '#ffd24d' && m.rolesAfterSwap[m.movingId] === '#4da3ff',
        'swapping the roles swaps the outlines too');
    check(m.rolesAfterClose === 0, 'and closing clears them');
    check(m.planeGroupBefore === m.planeGroupAfter && m.planeGroupBefore > 0,
        'the real planes are never touched — the outlines are their own group');

    // =================================================================
    // 10 — the edit lock: the VIEW stays live, the DATA is frozen
    // =================================================================
    console.log('\n10. Nothing can be edited while the dialog is open');
    m = await page.evaluate(async () => {
        const P = window.__P, AS = window.__AS;
        const model = P.planeModel();
        const wall = model.planes[1];
        const out = {};

        // Clean slate. Two preconditions, both of which would otherwise make
        // the "draggable before, not during" comparison vacuous:
        //   - the earlier sections drove the panel directly without entering
        //     Defining Plane Mode, and OUTSIDE that mode nothing is draggable;
        //   - §5b/§8 left corners pinned, and a pin both clears its planes'
        //     fits and makes that corner undraggable.
        P.enterPlaneMode();
        model.planes.forEach(pl => pl.nodeIds.forEach(id => model.pool.setPin(id, 'none')));
        await window.__ensureFits();
        P.refreshPlanePanel();
        P.syncPlanes3D();

        // How many corners offer a 3D drag right now. `planeEditable` gates
        // both the drag and the `move` cursor, so it is the whole affordance.
        const editable3d = () => {
            let n = 0;
            window.__vp()._planeGroup.traverse(c => {
                if (c.isMesh && c.userData && c.userData.planeEditable) n++;
            });
            return n;
        };
        // The real 2D gate, through the callback bag `ui/interaction.js` holds.
        const drag2d = (idx) => AS.interactionManager.callbacks
            .beginPlaneDrag(AS.state.views[0].name, idx, false);

        const wallIdx = model.pool.indexOf(wall.nodeIds[2]);
        out.before3d = editable3d();
        out.before2d = drag2d(wallIdx).allowed;
        out.beforeTriDisabled = document.getElementById('btnPlaneTriangulate').disabled;

        document.getElementById('btnSetPlaneAngle').click();
        out.opened = !!document.getElementById('planeAngleOverlay');

        out.bodyLocked = document.body.classList.contains('plane-angle-lock');
        out.during3d = editable3d();
        const d2 = drag2d(wallIdx);
        out.during2d = d2.allowed;
        out.dragStatus = document.getElementById('statusText').textContent;
        // The two edit paths that do NOT go through `beginPlaneDrag`: the
        // right-click null toggle (which invalidates the node's 3D) and
        // dropping a plane row onto a view (a <tr> takes no `disabled`).
        out.nullLocked = AS.interactionManager.callbacks.isPlaneDataLocked();
        out.nullStatus = document.getElementById('statusText').textContent;
        out.dropped = P.handlePlaneDrop(wall.id, AS.state.views[0].name, 10, 10);
        out.dropStatus = document.getElementById('statusText').textContent;
        // Every control in the panel, not a hand-picked few: a new button added
        // to this panel later must be caught by the same lock.
        const panel = document.getElementById('planePanel');
        const ctrls = Array.from(panel.querySelectorAll('button, select, input'));
        out.nCtrls = ctrls.length;
        out.nEnabled = ctrls.filter(c => !c.disabled).length;
        out.enabledNames = ctrls.filter(c => !c.disabled)
            .map(c => c.id || c.className).slice(0, 5);
        // The dialog's OWN controls are not in the panel, so the lock cannot
        // reach them — it would otherwise disable its own Apply button.
        out.applyLive = !document.getElementById('btnPlaneAngleApply').disabled;
        out.cancelLive = !document.getElementById('btnPlaneAngleCancel').disabled;

        // Frozen data, LIVE preview: the ghost must still follow the number.
        const t = document.getElementById('planeAngleTarget');
        t.value = '45';
        t.dispatchEvent(new Event('change', { bubbles: true }));
        out.ghostWhileLocked = window.__vp()._angleGroup.children.length;

        document.getElementById('btnPlaneAngleCancel').click();
        out.afterLocked = document.body.classList.contains('plane-angle-lock');
        out.after3d = editable3d();
        out.after2d = drag2d(wallIdx).allowed;
        out.afterTriDisabled = document.getElementById('btnPlaneTriangulate').disabled;
        out.afterEnabled = Array.from(panel.querySelectorAll('button, select, input'))
            .filter(c => !c.disabled).length;

        // Leaving the mode must take the dialog with it, or the panel it locked
        // goes away underneath it.
        document.getElementById('btnSetPlaneAngle').click();
        out.reopened = !!document.getElementById('planeAngleOverlay');
        P.exitPlaneMode();
        out.openAfterExit = !!document.getElementById('planeAngleOverlay');
        out.lockedAfterExit = document.body.classList.contains('plane-angle-lock');
        P.enterPlaneMode();
        return out;
    });
    check(m.before3d > 0 && m.before2d,
        `precondition: corners are draggable in 3D (${m.before3d}) and in 2D before the dialog opens`);
    check(m.opened, 'the dialog opens');
    check(m.during3d === 0,
        `no corner offers a 3D drag while it is open (got ${m.during3d})`);
    check(!m.during2d, 'and a 2D corner drag is refused');
    check(/Set Angle/.test(m.dragStatus || ''),
        `the refusal says why rather than looking broken (got "${String(m.dragStatus).slice(0, 70)}")`);
    check(m.nullLocked && /Set Angle/.test(m.nullStatus || ''),
        'the right-click null toggle is locked out too (it invalidates 3D), and says so');
    check(m.dropped === null && /Set Angle/.test(m.dropStatus || ''),
        'and a plane cannot be dropped onto a view, which no `disabled` could stop');
    check(m.bodyLocked, 'the panel is marked locked, so the lock is visible and not just a dead click');
    check(m.nEnabled === 0,
        `every one of the panel's ${m.nCtrls} controls is disabled (${m.nEnabled} left live: ${JSON.stringify(m.enabledNames)})`);
    check(m.applyLive && m.cancelLive,
        'the dialog\'s own Apply and Cancel stay live — they are not in the locked panel');
    check(m.ghostWhileLocked > 0,
        'the ghost still follows the typed angle: the DATA is frozen, the preview is not');
    check(!m.afterLocked && m.after3d === m.before3d && m.after2d,
        'closing the dialog restores dragging in both views');
    check(m.afterEnabled > 0 && m.afterTriDisabled === m.beforeTriDisabled,
        `and restores each control to its own state rather than blanket-enabling (${m.afterEnabled} live again)`);
    check(m.reopened, 'the dialog reopens');
    check(!m.openAfterExit && !m.lockedAfterExit,
        'leaving Defining Plane Mode closes it and lifts the lock with it');

} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
