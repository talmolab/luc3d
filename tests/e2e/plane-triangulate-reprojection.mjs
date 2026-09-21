/**
 * plane-triangulate-reprojection.mjs — Triangulate fills in the views a plane
 * was NOT placed on, by reprojecting its solved 3D into their PlaneInstances.
 *
 * A plane is reference geometry the user is trying to get right, so the useful
 * thing is not only seeing where it lands in the other views but being able to
 * grab a corner there and correct it. That rules out a read-only reprojection
 * overlay: the points go into the real `PlaneInstance`, so they draw and drag
 * like any other plane corner.
 *
 * Which creates the trap this file mostly exists to guard. A reprojected corner
 * is EXACTLY the projection of the current 3D, so its reprojection residual is
 * zero by construction. Feed it back into the next solve and it adds no
 * information while dragging the reported error toward zero — a quality readout
 * that improves every time you press the button, and a 2-view plane that looks
 * like a 5-view one. So each written point is flagged `derived` and excluded
 * from the solve and from the error average until the user drags it, at which
 * point it is their annotation and counts.
 *
 * Sections:
 *  1. Three cameras, a plane placed on two. Triangulate places it on the third,
 *     with every corner flagged derived and equal to `reprojectPointCamera` of
 *     the 3D — and it DRAWS there.
 *  2. Derived corners are not evidence: a second Triangulate reports the same
 *     views and the same mean error, not a better one.
 *  3. Dragging a derived corner promotes it: the flag clears and the next
 *     Triangulate counts that view.
 *  4. A camera the plane is BEHIND is skipped, not given a mirrored ghost.
 *  5. Stale derived corners are refreshed, never left showing an old solve.
 *  6. The 2+ views gate counts hand-placed views, so reprojections cannot make
 *     a single-view plane look solvable.
 *  7. A placed view's own annotation is never overwritten.
 *
 * Run: node plane-triangulate-reprojection.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8205);

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

    // -----------------------------------------------------------------
    // FOUR cameras: three looking at the plane from different positions,
    // and one turned around so the plane is behind it.
    // -----------------------------------------------------------------
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Camera, Session, Skeleton } = pd;
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const spec = [
            ['camA', [0, 0, 0], [0, 0, 0]],
            ['camB', [0, 0.35, 0], [-60, 0, 0]],
            ['camC', [0, -0.35, 0], [60, 0, 0]],
            // Rotated a half turn about Y at the same spot as camA: the scene in
            // front of camA is behind camD. Asserted, not assumed, in section 4.
            ['camD', [0, Math.PI, 0], [0, 0, 0]],
        ];
        const cams = spec.map(([n, rvec, tvec]) =>
            new Camera(n, K, [0, 0, 0, 0, 0], rvec, tvec, [640, 480]));
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

    // A real quad in world space, in front of camA/B/C. Annotated by hand on
    // camA and camB only — camC and camD are what the feature has to fill in.
    const TRUTH = [[-60, -45, 210], [60, -45, 214], [66, 40, 220], [-66, 40, 226]];
    await page.evaluate(async (TRUTH) => {
        const P = await import('/ui/plane-definition.js');
        const AS = await import('/ui/app-state.js');
        window.__P = P;
        window.__TRUTH = TRUTH;
        window.__cam = (n) => AS.state.session.cameras.find(c => c.name === n);
        window.__plane = () => P.planeModel().planes[0];
        window.__poolIdx = (plane) =>
            plane.nodeIds.map(id => P.planeModel().pool.indexOf(id));
        /** A plane's 2D on one view, in PLANE order, or null where unset. */
        window.__pts = (view) => {
            const inst = P.getPlaneInstance(view);
            if (!inst) return null;
            return window.__poolIdx(window.__plane()).map(i =>
                inst.hasPoint(i) ? inst.getPoint(i) : null);
        };
        /** Which of a plane's corners are flagged derived on one view. */
        window.__derived = (view) => {
            const inst = P.getPlaneInstance(view);
            if (!inst) return null;
            return window.__poolIdx(window.__plane()).map(i => inst.isNodeDerived(i));
        };
        window.__placedViews = () => P.planeModel().placedViews(window.__plane());
    }, TRUTH);

    await page.click('.menu-item[data-menu="view"]');
    await page.click('#menuDefinePlanes');

    // =================================================================
    console.log('\n1. Triangulate reprojects into the views the plane is not on');
    // =================================================================
    let m = await page.evaluate(async () => {
        const P = window.__P;
        const R = await import('/ui/rendering.js');
        const T = await import('/pose/triangulation.js');
        const AS = await import('/ui/app-state.js');
        const model = P.planeModel();
        const plane = P.createPlane();
        plane.name = 'floor';
        ['fl', 'fr', 'br', 'bl'].forEach(n => model.createNodeInPlane(n, plane));
        for (let k = 0; k < 4; k++) plane.addEdge(plane.nodeIds[k], plane.nodeIds[(k + 1) % 4]);
        const idx = window.__poolIdx(plane);

        // Hand-annotate camA and camB ONLY, with a small FIXED click error per
        // corner. Without it the annotations are exact projections of TRUTH,
        // the reprojection error is ~1e-14, and section 2 could not tell an
        // honest error from a flattered one — both would read as zero.
        const JITTER = {
            camA: [[1.4, -0.9], [-1.1, 1.6], [0.8, 1.2], [-1.5, -1.3]],
            camB: [[-1.2, 1.1], [1.5, 0.7], [-0.9, -1.4], [1.3, -1.1]],
        };
        ['camA', 'camB'].forEach(name => {
            P.placePlaneOnView(plane, name, 320, 240);
            const inst = P.getPlaneInstance(name);
            const cam = window.__cam(name);
            window.__TRUTH.map(q => T.reprojectPointCamera(q, cam))
                .forEach((q, k) => inst.setPoint(
                    idx[k], q[0] + JITTER[name][k][0], q[1] + JITTER[name][k][1]));
        });

        // Select it in the panel, as a user creating it would — the action row's
        // Triangulate button is gated on a selection, and section 1b clicks it.
        P.planeState.selectedPlaneId = plane.id;
        P.refreshPlanePanel();

        const out = {};
        out.placedBefore = window.__placedViews();
        out.cPtsBefore = window.__pts('camC');

        const res = P.triangulatePlane(plane);
        out.ok = res.ok;
        out.reason = res.reason;
        out.views = res.views;
        out.reprojectedViews = res.reprojectedViews;
        out.reprojectedNodes = res.reprojectedNodes;
        out.meanError = res.meanError;
        out.placedAfter = window.__placedViews();
        out.cPts = window.__pts('camC');
        out.cDerived = window.__derived('camC');
        out.aDerived = window.__derived('camA');

        // Every written point must be exactly what reprojecting the node's own
        // 3D into that camera gives — not an approximation of it.
        const camC = window.__cam('camC');
        out.cWant = plane.nodeIds.map(id => {
            const node = model.pool.getNode(id);
            return node.hasPoint3d() ? T.reprojectPointCamera(node.getPoint3d(), camC) : null;
        });
        // …and near where the ground truth projects, so a sign/transform error
        // in the write cannot pass by being self-consistent. The tolerance is
        // loose because the hand annotations carry deliberate click error.
        out.cTruth = window.__TRUTH.map(q => T.reprojectPointCamera(q, camC));

        // It has to actually DRAW there: the plane is now placed on camC, so
        // camC's overlay must be non-empty inside the quad.
        plane.filled = true;
        R.drawAllOverlays(AS.state.currentFrame);
        const v = AS.state.views.find(x => x.name === 'camC');
        const cx = Math.round((320 / v.videoWidth) * v.overlayCanvas.width);
        const cy = Math.round((240 / v.videoHeight) * v.overlayCanvas.height);
        out.cAlpha = v.overlayCtx.getImageData(cx, cy, 1, 1).data[3];
        const vD = AS.state.views.find(x => x.name === 'camD');
        out.dAlpha = vD.overlayCtx.getImageData(cx, cy, 1, 1).data[3];
        plane.filled = false;
        R.drawAllOverlays(AS.state.currentFrame);
        return out;
    });
    check(eq(m.placedBefore, ['camA', 'camB']),
        `precondition: placed on camA+camB only (got ${JSON.stringify(m.placedBefore)})`);
    check(m.cPtsBefore === null || m.cPtsBefore.every(p => p === null),
        'precondition: camC has no 2D for the plane');
    check(m.ok, `triangulation succeeds (${m.reason || ''})`);
    check(eq(m.views, ['camA', 'camB']), 'the solve reports the two hand-placed views');
    check(eq(m.reprojectedViews, ['camC']),
        `and reports reprojecting onto camC (got ${JSON.stringify(m.reprojectedViews)})`);
    check(m.reprojectedNodes === 4, `all four corners written (${m.reprojectedNodes})`);
    check(eq(m.placedAfter, ['camA', 'camB', 'camC']),
        `the plane is now placed on camC too (got ${JSON.stringify(m.placedAfter)})`);
    check(m.cPts && m.cPts.every(p => p && isFinite(p[0]) && isFinite(p[1])),
        'camC has a finite 2D point per corner');
    check(m.cPts && m.cWant && m.cPts.every((p, k) =>
        Math.abs(p[0] - m.cWant[k][0]) < 1e-9 && Math.abs(p[1] - m.cWant[k][1]) < 1e-9),
        'each is exactly reprojectPointCamera of that node\'s 3D');
    check(m.cPts && m.cTruth && m.cPts.every((p, k) =>
        Math.hypot(p[0] - m.cTruth[k][0], p[1] - m.cTruth[k][1]) < 8),
        'and lands within a few px of where the ground truth projects');
    check(eq(m.cDerived, [true, true, true, true]),
        `every camC corner is flagged derived (got ${JSON.stringify(m.cDerived)})`);
    check(eq(m.aDerived, [false, false, false, false]),
        'while the hand-annotated view is untouched');
    check(m.cAlpha > 0, `the plane is drawn on camC (alpha ${m.cAlpha})`);
    check(m.dAlpha === 0, 'and not on camD, which it is behind — the sample can fail');

    // -----------------------------------------------------------------
    // 1b — the BUTTON repaints the views it just wrote into
    // -----------------------------------------------------------------
    // Triangulate used to change only 3D, so its handler never redrew the 2D
    // overlays. Now it WRITES 2D, and without a repaint the new placement is
    // real, listed in the panel, and invisible until some unrelated event
    // happens to redraw. Section 1 called `drawAllOverlays` itself and so could
    // not catch that; this drives the real button and repaints nothing.
    console.log('\n1b. Clicking Triangulate repaints the view it reprojected onto');
    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        window.__plane().filled = true;
        // Wipe camC's overlay, so anything sampled after the click was drawn BY
        // the click.
        const v = AS.state.views.find(x => x.name === 'camC');
        v.overlayCtx.clearRect(0, 0, v.overlayCanvas.width, v.overlayCanvas.height);
        window.__sampleC = () => {
            const cx = Math.round((320 / v.videoWidth) * v.overlayCanvas.width);
            const cy = Math.round((240 / v.videoHeight) * v.overlayCanvas.height);
            return v.overlayCtx.getImageData(cx, cy, 1, 1).data[3];
        };
        window.__blankBefore = window.__sampleC();
    });
    await page.click('#btnPlaneTriangulate');
    m = await page.evaluate(async () => {
        const out = { before: window.__blankBefore, after: window.__sampleC() };
        const R = await import('/ui/rendering.js');
        const AS = await import('/ui/app-state.js');
        window.__plane().filled = false;
        R.drawAllOverlays(AS.state.currentFrame);
        return out;
    });
    check(m.before === 0, 'precondition: camC\'s overlay was wiped');
    check(m.after > 0,
        `clicking Triangulate repainted camC by itself (alpha ${m.before} -> ${m.after})`);

    // =================================================================
    console.log('\n2. A reprojected corner is not evidence');
    // =================================================================
    m = await page.evaluate(async () => {
        const P = window.__P;
        const plane = window.__plane();
        const out = { first: {}, second: {} };
        // Re-run on the state section 1 left: camC is now PLACED and carries
        // four derived corners whose residual is zero by construction. If they
        // counted, both the view list and the mean error would move.
        const before = plane.triangulation;
        out.first = { views: before.views.slice(), meanError: before.meanError };
        const res = P.triangulatePlane(plane);
        out.second = { views: res.views, meanError: res.meanError, ok: res.ok };
        out.nodeErrorsFinite = plane.nodeIds.every(id =>
            P.planeModel().pool.getNode(id).error != null);
        // Third time, to be sure it is a fixed point and not just slow drift.
        const res3 = P.triangulatePlane(plane);
        out.third = { views: res3.views, meanError: res3.meanError };
        out.cStillDerived = window.__derived('camC');

        // What the number WOULD be if derived corners counted: the same
        // per-node residuals averaged over every placed view, camC included.
        // camC's residual is zero by construction, so this is the flattered
        // figure the flag exists to prevent — computed here rather than argued,
        // so the assertion above is measurably about something.
        const T = await import('/pose/triangulation.js');
        const model = P.planeModel();
        const idx = window.__poolIdx(plane);
        let sum = 0, n = 0;
        model.placedViews(plane).forEach(viewName => {
            const inst = P.getPlaneInstance(viewName);
            const cam = window.__cam(viewName);
            plane.nodeIds.forEach((id, k) => {
                const node = model.pool.getNode(id);
                if (!node.hasPoint3d() || !inst.hasPoint(idx[k])) return;
                const rp = T.reprojectPointCamera(node.getPoint3d(), cam);
                sum += Math.hypot(rp[0] - inst.getX(idx[k]), rp[1] - inst.getY(idx[k]));
                n++;
            });
        });
        out.flattered = n ? sum / n : null;
        return out;
    });
    check(eq(m.second.views, ['camA', 'camB']),
        `re-triangulating still reports only the hand-placed views (got ${JSON.stringify(m.second.views)})`);
    check(m.first.meanError != null && Math.abs(m.second.meanError - m.first.meanError) < 1e-9,
        `and the SAME mean error (${m.first.meanError} -> ${m.second.meanError}), not a flattered one`);
    check(Math.abs(m.third.meanError - m.first.meanError) < 1e-9,
        'a third run does not move it either');
    check(m.nodeErrorsFinite, 'per-node errors are still reported');
    check(m.first.meanError > 0.3,
        `the reported error is a real number, not a rounding artefact (${m.first.meanError.toFixed(3)} px)`);
    check(m.flattered != null && m.flattered < m.first.meanError * 0.8,
        `counting the reprojected view WOULD flatter it (${m.first.meanError.toFixed(3)} -> ` +
        `${m.flattered.toFixed(3)} px) — which is what the flag prevents`);
    check(eq(m.cStillDerived, [true, true, true, true]),
        'and the reprojected corners stay flagged');

    // =================================================================
    console.log('\n3. Dragging a reprojected corner promotes it to evidence');
    // =================================================================
    const dragTarget = await page.evaluate(() => {
        const pts = window.__pts('camC');
        return { from: pts[0], to: [pts[0][0] + 14, pts[0][1] + 10] };
    });
    {
        const [cx1, cy1] = await page.evaluate(
            ([v, x, y]) => window.__videoToClient(v, x, y),
            ['camC', dragTarget.from[0], dragTarget.from[1]]);
        const [cx2, cy2] = await page.evaluate(
            ([v, x, y]) => window.__videoToClient(v, x, y),
            ['camC', dragTarget.to[0], dragTarget.to[1]]);
        await page.mouse.move(cx1, cy1);
        await page.mouse.down();
        await page.mouse.move(cx2, cy2, { steps: 6 });
        await page.mouse.up();
    }
    m = await page.evaluate(async () => {
        const P = window.__P;
        const plane = window.__plane();
        const out = {};
        out.derivedAfterDrag = window.__derived('camC');
        out.movedTo = window.__pts('camC')[0];
        // The drag invalidated that node's 3D, so re-triangulate: camC now
        // carries one real observation and must count as a contributing view.
        const res = P.triangulatePlane(plane);
        out.views = res.views;
        out.ok = res.ok;
        out.meanError = res.meanError;
        // The other three were re-derived from the new solve, so they are
        // flagged again — only the corner the user touched is theirs.
        out.derivedAfterRetri = window.__derived('camC');
        return out;
    });
    check(eq(m.derivedAfterDrag, [false, true, true, true]),
        `the dragged corner is no longer derived (got ${JSON.stringify(m.derivedAfterDrag)})`);
    check(Math.abs(m.movedTo[0] - dragTarget.to[0]) < 2 &&
        Math.abs(m.movedTo[1] - dragTarget.to[1]) < 2,
        'and it moved where the mouse put it');
    check(m.ok && eq(m.views, ['camA', 'camB', 'camC']),
        `camC now counts as a contributing view (got ${JSON.stringify(m.views)})`);
    check(m.meanError > 0,
        `and the error reflects the real disagreement the drag introduced (${m.meanError.toFixed(3)} px)`);
    check(eq(m.derivedAfterRetri, [false, true, true, true]),
        'the promoted corner stays the user\'s; the rest are re-derived');

    // -----------------------------------------------------------------
    // 3b — but toggling a corner OFF does not promote it
    // -----------------------------------------------------------------
    // Right-clicking a node routes through the same `onPlaneChanged` hook as a
    // drag. Turning a corner off says nothing about WHERE it is, so if that
    // cleared the flag, un-toggling it later would leave a reprojection quietly
    // counting as an annotation.
    console.log('\n3b. Toggling a reprojected corner off does not promote it');
    {
        const pts = await page.evaluate(() => window.__pts('camC'));
        const [rx, ry] = await page.evaluate(
            ([v, x, y]) => window.__videoToClient(v, x, y),
            ['camC', pts[2][0], pts[2][1]]);
        await page.mouse.move(rx, ry);
        await page.mouse.click(rx, ry, { button: 'right' });
    }
    m = await page.evaluate(async () => {
        const P = window.__P;
        const inst = P.getPlaneInstance('camC');
        const idx = window.__poolIdx(window.__plane());
        const out = {
            nulled: inst.isNodeNulled(idx[2]),
            derived: inst.isNodeDerived(idx[2]),
        };
        // Un-toggle: still derived, so still not evidence.
        inst.toggleNodeNull(idx[2]);
        out.afterUnToggle = { nulled: inst.isNodeNulled(idx[2]), derived: inst.isNodeDerived(idx[2]) };
        const res = P.triangulatePlane(window.__plane());
        out.views = res.views;
        return out;
    });
    check(m.nulled, 'the right-click toggled the corner off');
    check(m.derived, 'and it is STILL flagged derived');
    check(!m.afterUnToggle.nulled && m.afterUnToggle.derived,
        'un-toggling leaves it derived, not promoted to an annotation');
    check(eq(m.views, ['camA', 'camB', 'camC']),
        'camC still counts only through the corner that was actually dragged');

    // =================================================================
    console.log('\n4. A camera the plane is BEHIND gets no mirrored ghost');
    // =================================================================
    m = await page.evaluate(async () => {
        const T = await import('/pose/triangulation.js');
        const P = window.__P;
        const model = P.planeModel();
        const plane = window.__plane();
        const out = {};
        const camD = window.__cam('camD');
        // The precondition, asserted rather than assumed: every corner is
        // behind camD (negative homogeneous depth).
        out.depths = plane.nodeIds.map(id => {
            const node = model.pool.getNode(id);
            return node.hasPoint3d() ? T.cameraDepth(node.getPoint3d(), camD) : null;
        });
        // And the trap: reprojecting anyway yields a finite, plausible pixel.
        const ghost = T.reprojectPointCamera(model.pool.getNode(plane.nodeIds[0]).getPoint3d(), camD);
        out.ghostFinite = isFinite(ghost[0]) && isFinite(ghost[1]);
        out.dPlaced = model.isPlanePlaced(plane, 'camD');
        out.dPts = window.__pts('camD');
        const res = P.triangulatePlane(plane);
        out.behindViews = res.behindViews;
        out.reprojectedViews = res.reprojectedViews;
        out.dPlacedAfter = model.isPlanePlaced(plane, 'camD');
        out.dPtsAfter = window.__pts('camD');
        return out;
    });
    check(m.depths.every(d => d != null && d < 0),
        `precondition: every corner is behind camD (depths ${m.depths.map(d => d.toFixed(1))})`);
    check(m.ghostFinite,
        'precondition: reprojecting it anyway yields a finite, plausible-looking pixel');
    check(!m.dPlacedAfter, 'camD is not placed');
    check(m.dPtsAfter === null || m.dPtsAfter.every(p => p === null),
        'and no point is written into it');
    check(eq(m.behindViews, ['camD']),
        `it is reported as behind (got ${JSON.stringify(m.behindViews)})`);
    check(!(m.reprojectedViews || []).includes('camD'),
        'and not claimed as reprojected');

    // =================================================================
    console.log('\n5. Stale reprojections are refreshed, not left behind');
    // =================================================================
    m = await page.evaluate(async () => {
        const P = window.__P;
        const T = await import('/pose/triangulation.js');
        const model = P.planeModel();
        const plane = window.__plane();
        const idx = window.__poolIdx(plane);
        const out = {};
        // Corner 2 is still derived on camC. Move the SAME corner by a lot on
        // camA and camB so its 3D genuinely changes, then re-triangulate.
        out.before = window.__pts('camC')[2];
        ['camA', 'camB'].forEach(name => {
            const inst = P.getPlaneInstance(name);
            inst.setPoint(idx[2], inst.getX(idx[2]) + 25, inst.getY(idx[2]) + 18);
        });
        model.invalidateNode3D(plane.nodeIds[2]);
        P.triangulatePlane(plane);
        out.after = window.__pts('camC')[2];
        const node = model.pool.getNode(plane.nodeIds[2]);
        out.want = T.reprojectPointCamera(node.getPoint3d(), window.__cam('camC'));
        out.stillDerived = window.__derived('camC')[2];
        return out;
    });
    check(Math.hypot(m.after[0] - m.before[0], m.after[1] - m.before[1]) > 1,
        `the stale corner moved with the new solve (${Math.hypot(m.after[0] - m.before[0], m.after[1] - m.before[1]).toFixed(2)} px)`);
    check(Math.abs(m.after[0] - m.want[0]) < 1e-9 && Math.abs(m.after[1] - m.want[1]) < 1e-9,
        'and matches the reprojection of the new 3D exactly');
    check(m.stillDerived, 'and is still flagged derived');

    // =================================================================
    console.log('\n6. The 2+ views gate counts HAND-PLACED views');
    // =================================================================
    m = await page.evaluate(async () => {
        const P = window.__P;
        const model = P.planeModel();
        const out = {};
        // A second plane, annotated on ONE view and reprojected nowhere yet.
        const solo = P.createPlane();
        solo.name = 'wall';
        ['w0', 'w1', 'w2'].forEach(n => model.createNodeInPlane(n, solo));
        P.placePlaneOnView(solo, 'camA', 200, 200);
        const one = P.triangulatePlane(solo);
        out.onePlaced = { ok: one.ok, reason: one.reason };

        // Now fake the dangerous state directly: placed on a second view, but
        // every corner there DERIVED. Placement count says 2; evidence says 1.
        const inst = P.getPlaneInstance('camB') || model.ensureInstance('camB');
        const idx = solo.nodeIds.map(id => model.pool.indexOf(id));
        idx.forEach((i, k) => {
            inst.setPoint(i, 150 + 20 * k, 150 + 10 * k);
            inst.setNodeDerived(i, true);
        });
        inst.placedPlanes.add(solo.id);
        out.placedViews = model.placedViews(solo);
        const two = P.triangulatePlane(solo);
        out.derivedOnly = { ok: two.ok, reason: two.reason };
        out.noTriangulation = solo.triangulation === null;

        // Un-flag them — the same 2D now counts, and the solve runs.
        idx.forEach(i => inst.setNodeDerived(i, false));
        const three = P.triangulatePlane(solo);
        out.promoted = { ok: three.ok, views: three.views };
        model.deletePlane(solo);
        return out;
    });
    check(!m.onePlaced.ok && /placed on 1 view/.test(m.onePlaced.reason),
        `one placement is refused (got "${m.onePlaced.reason}")`);
    check(eq(m.placedViews, ['camA', 'camB']),
        'precondition: the plane is now PLACED on two views');
    check(!m.derivedOnly.ok, 'but a derived-only second view is still refused');
    check(/hand-placed corners on only 1 view \(camA\)/.test(m.derivedOnly.reason),
        `and the reason says why, naming the view (got "${m.derivedOnly.reason}")`);
    check(/not evidence/.test(m.derivedOnly.reason),
        'and that reprojected corners do not count');
    check(m.noTriangulation, 'nothing was published for the refused solve');
    check(m.promoted.ok && eq(m.promoted.views, ['camA', 'camB']),
        'un-flagging the same points makes it solvable');

    // =================================================================
    console.log('\n7. A view the user placed is never overwritten');
    // =================================================================
    m = await page.evaluate(async () => {
        const P = window.__P;
        const plane = window.__plane();
        const out = {};
        // camA is hand-annotated. Put a corner somewhere deliberately wrong and
        // check Triangulate leaves it exactly there: the reprojection pass must
        // not "correct" an observation into agreement with the model.
        const idx = window.__poolIdx(plane);
        const inst = P.getPlaneInstance('camA');
        inst.setPoint(idx[3], 111, 222);
        P.planeModel().invalidateNode3D(plane.nodeIds[3]);
        P.triangulatePlane(plane);
        out.kept = inst.getPoint(idx[3]);
        out.derived = window.__derived('camA');
        return out;
    });
    check(eq(m.kept, [111, 222]),
        `the hand-placed corner is exactly where the user left it (got ${JSON.stringify(m.kept)})`);
    check(m.derived.every(d => d === false),
        'and no corner of a hand-annotated view is flagged derived');

} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
