/**
 * ui-smoke-representation-change.mjs — broad real-browser smoke test over the
 * UI surfaces that read the two representations changed in luc3d #189:
 *
 *   - `InstanceGroup.points3d`  boxed [x,y,z]|null rows -> flat Float64Array(3N)
 *   - `InstanceGroup.observedPoints`  stored object -> derived getter
 *
 * Unit tests pin the data model; this pins the SCREEN. It builds a real
 * cross-view project in the real app, runs the real Track/Triangulate paths,
 * then drives the info panel, the 3D viewport, the timeline, the overlay
 * renderer, the visibility submenu toggles and the export-summary paths —
 * asserting each produces the SAME observable output it did before, and that
 * NOTHING throws.
 *
 * Any `pageerror` or `console.error` fails the run: a stale `.some(...)` on a
 * Float64Array or an assignment to the read-only `observedPoints` getter shows
 * up as a TypeError here even when no assertion covers that exact line.
 *
 * Run: node ui-smoke-representation-change.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8099);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();

    const runtimeErrors = [];
    page.on('pageerror', e => runtimeErrors.push('pageerror: ' + String(e).slice(0, 400)));
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        // Ignore network noise from absent demo video assets, and the
        // `blob:stub` this test itself feeds the download anchor below.
        if (/Failed to load resource|net::ERR|404|blob:stub/.test(t)) return;
        runtimeErrors.push('console.error: ' + t.slice(0, 400));
    });
    page.on('dialog', async d => { await d.accept(''); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    // ---------------------------------------------------------------
    // Build a real 3-camera project and run the real triangulation path
    // ---------------------------------------------------------------
    const built = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const exportModals = await import('/ui/export-modals.js');
        const { Skeleton, Camera, Instance, FrameGroup, Session, InstanceGroup } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = [
            new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.35, 0], [22, 0, 0], [640, 480]),
            new Camera('camC', K, [0, 0, 0, 0, 0], [0, -0.35, 0], [-22, 0, 0], [640, 480]),
        ];
        const skel = new Skeleton('sk', ['nose', 'mid', 'tail'], [[0, 1], [1, 2]]);
        const session = new Session(cams, skel, ['track_0', 'track_1'], 'SmokeSession');

        const NF = 8;
        const truth = [];
        for (let f = 0; f < NF; f++) {
            session.addFrameGroup(new FrameGroup(f));
            const fg = session.frameGroups.get(f);
            const pts3 = [
                [10 + f * 0.3, 5, 50],
                [11 + f * 0.3, 6, 51],
                [12 + f * 0.3, 7, 52],
            ];
            truth.push(pts3);
            for (const cam of cams) {
                fg.addInstance(cam.name, new Instance(pts3.map(p => cam.project(p)), 0, 'predicted', 1));
            }
        }

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = NF;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = cams.map(c => ({ name: c.name, videoWidth: 640, videoHeight: 480 }));

        session.addIdentity('Red');
        const redId = session.identities[0].id;
        for (let f = 0; f < NF; f++) {
            const grp = new InstanceGroup(f + 1, redId);
            const fg = session.frameGroups.get(f);
            for (const cam of cams) grp.addInstance(cam.name, fg.instances.get(cam.name)[0]);
            session.instanceGroups.set(f, [grp]);
        }
        for (const cam of cams) session.assignTrackToIdentity(0, redId, cam.name);

        // Real bulk triangulation (the path Track All -> Triangulate All uses)
        await exportModals.groupByIdentityAndTriangulateAll();

        const g0 = session.instanceGroups.get(0)[0];
        return {
            nFrames: NF,
            truth0: truth[0],
            points3dIsFlat: g0.points3d instanceof Float64Array,
            points3dLen: g0.points3d ? g0.points3d.length : -1,
            nodeCount: pd.points3dNodeCount(g0.points3d),
            validCount: pd.countPoints3d(g0.points3d),
            recovered0: pd.getPoint3d(g0.points3d, 0),
            // observedPoints must still expose the LIVE member arrays
            observedKeys: Object.keys(g0.observedPoints).sort(),
            observedMatches: JSON.stringify(g0.observedPoints.camA) === JSON.stringify(g0.getInstance('camA').toPointsArray()),
            hasReprojections: !!g0.reprojections && Object.keys(g0.reprojections).length === 3,
            usedCameras: g0.usedCameras ? Array.from(g0.usedCameras).sort() : null,
        };
    });

    console.log('\n-- data model after real Triangulate All --');
    check(built.points3dIsFlat, 'points3d is a flat Float64Array');
    check(built.points3dLen === 9, `points3d length is 3*nNodes (got ${built.points3dLen})`);
    check(built.nodeCount === 3, `3 nodes (got ${built.nodeCount})`);
    check(built.validCount === 3, `all 3 nodes triangulated (got ${built.validCount})`);
    const err0 = built.recovered0
        ? Math.hypot(built.recovered0[0] - built.truth0[0][0],
                     built.recovered0[1] - built.truth0[0][1],
                     built.recovered0[2] - built.truth0[0][2])
        : Infinity;
    check(err0 < 1e-6, `triangulation recovers the true 3D point (err=${err0.toExponential(2)})`);
    check(JSON.stringify(built.observedKeys) === '["camA","camB","camC"]',
        `observedPoints derives all 3 members (got ${JSON.stringify(built.observedKeys)})`);
    check(built.observedMatches, 'observedPoints mirrors the member coordinates');
    check(built.hasReprojections, 'reprojections present for all 3 cameras');
    // NOT a regression: groupByIdentityAndTriangulateAll uses {triangulateOnly}
    // and has never populated usedCameras (verified against HEAD~). Asserted so a
    // future change to that path is noticed rather than silently absorbed here.
    check(built.usedCameras === null,
        `usedCameras unset on the triangulateOnly path, as before (got ${JSON.stringify(built.usedCameras)})`);

    // ---------------------------------------------------------------
    // Info panel — the main observedPoints/points3d consumer on screen
    // ---------------------------------------------------------------
    const panel = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const infoPanel = await import('/ui/info-panel.js');
        const rendering = await import('/ui/rendering.js');
        rendering.setReprojErrorVisible(true);
        infoPanel.updateInfoPanel();
        infoPanel.updateFrameInfo && infoPanel.updateFrameInfo(AS.state.currentFrame);
        rendering.updateFrameCounters && rendering.updateFrameCounters();

        const sec = document.getElementById('reprojErrorSection');
        const txt = sec ? sec.innerText : '';
        // Pull every number the reprojection readout rendered.
        const nums = (txt.match(/\d+\.\d+/g) || []).map(Number);
        return {
            sectionVisible: !!sec && sec.style.display !== 'none',
            text: txt.replace(/\s+/g, ' ').trim().slice(0, 300),
            numbers: nums,
            instancePanelText: (document.getElementById('instanceList') || {}).innerText || '',
            frameCounters: (document.getElementById('frameCounters') || {}).innerText || '',
        };
    });

    console.log('\n-- info panel --');
    check(panel.sectionVisible, 'reprojection-error section is visible');
    check(panel.numbers.length > 0, `reprojection readout rendered numbers (${panel.numbers.length})`);
    // The synthetic project is geometrically exact, so every error must be ~0.
    // A broken observedPoints (undefined -> skipped, or mismatched) would either
    // render nothing or render a large/NaN error.
    const maxErr = panel.numbers.length ? Math.max(...panel.numbers) : Infinity;
    check(maxErr < 0.01, `all reprojection errors ~0 on exact synthetic data (max=${maxErr})`);
    check(!/NaN/.test(panel.text), 'no NaN in the reprojection readout');
    console.log('     readout:', panel.text.slice(0, 160));

    // ---------------------------------------------------------------
    // 3D viewport — reads points3d directly
    // ---------------------------------------------------------------
    const vp = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const init = await import('/pose/initialization.js');
        init.update3DViewport(AS.state.currentFrame);
        const v = AS.viewport3d;
        if (!v || !v._skeletonGroup) return { ok: false, reason: 'no viewport' };
        let meshes = 0;
        v._skeletonGroup.traverse(o => { if (o.isMesh) meshes++; });
        // Environment overlay path also reads points3d.
        const groups = AS.state.session.instanceGroups.get(0);
        v.setEnvironment(groups);
        let envMeshes = 0;
        v._envGroup.traverse(o => { if (o.isMesh) envMeshes++; });
        v.clearEnvironment();
        // fitToScene consumes the mesh bounding sphere — NaN coords would poison it.
        v.fitToScene();
        const camPos = v.threeCamera.position;
        return {
            ok: true, meshes, envMeshes,
            camFinite: isFinite(camPos.x) && isFinite(camPos.y) && isFinite(camPos.z),
        };
    });

    console.log('\n-- 3D viewport --');
    check(vp.ok, '3D viewport present');
    // 3 nodes + 2 edges per group.
    check(vp.meshes >= 5, `skeleton meshes built from flat points3d (got ${vp.meshes})`);
    check(vp.envMeshes >= 5, `environment overlay meshes built (got ${vp.envMeshes})`);
    check(vp.camFinite, 'fitToScene produced finite camera position (no NaN geometry)');

    // ---------------------------------------------------------------
    // Overlay renderer + visibility submenu toggles
    // ---------------------------------------------------------------
    const overlays = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const rendering = await import('/ui/rendering.js');
        const out = { combos: 0, threw: null };
        const ids = ['visUser', 'visPredicted', 'visReprojections', 'visErrors', 'visLegend'];
        try {
            // Exercise every visibility toggle: the error-vector path is the one
            // that reads observed vs reprojected points per view.
            for (const on of [true, false]) {
                for (const id of ids) {
                    const el = document.getElementById(id);
                    if (el) { el.checked = on; el.dispatchEvent(new Event('change', { bubbles: true })); }
                }
                for (let f = 0; f < AS.state.totalFrames; f++) {
                    rendering.drawAllOverlays(f);
                    out.combos++;
                }
            }
            // Restore, then draw once more with errors ON.
            for (const id of ids) {
                const el = document.getElementById(id);
                if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
            }
            rendering.drawAllOverlays(0);
        } catch (e) {
            out.threw = String(e && e.stack || e).slice(0, 400);
        }
        return out;
    });

    console.log('\n-- overlays / visibility submenu --');
    check(overlays.threw == null, `drawAllOverlays across all toggles + frames (${overlays.combos} draws)${overlays.threw ? ' — ' + overlays.threw : ''}`);

    // ---------------------------------------------------------------
    // Reprojection-error statistics (overlays.js computeReprojectionStats path)
    // ---------------------------------------------------------------
    const stats = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const ov = await import('/ui/overlays.js');
        if (typeof ov.computeReprojectionStats !== 'function') return { skipped: true };
        const groups = AS.state.session.instanceGroups.get(0);
        const s = ov.computeReprojectionStats(groups, AS.state.session.cameras.map(c => c.name));
        return { skipped: false, json: JSON.stringify(s).slice(0, 300) };
    });
    console.log('\n-- reprojection stats --');
    if (stats.skipped) console.log('  (computeReprojectionStats not exported — covered via info panel)');
    else { check(!/NaN|null/.test(stats.json), 'reprojection stats finite'); console.log('     ', stats.json.slice(0, 160)); }

    // ---------------------------------------------------------------
    // Timeline
    // ---------------------------------------------------------------
    const tl = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        if (!AS.timeline) return { ok: false };
        AS.timeline.setData(AS.state.session);
        AS.timeline.draw && AS.timeline.draw();
        return {
            ok: true,
            rows: (AS.timeline._trackSegments || []).length,
            names: (AS.timeline._trackNames || []).slice(0, 6),
        };
    });
    console.log('\n-- timeline --');
    check(tl.ok && tl.rows > 0, `timeline built rows (got ${tl.rows})`);

    // ---------------------------------------------------------------
    // Export summary paths (read points3d to count triangulated frames)
    // ---------------------------------------------------------------
    const exp = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const fileio = await import('/import-export/file-io.js');
        const out = {};
        // points3d.h5 export data — reads points3d per node.
        const p3 = fileio.buildPoints3dExportData(AS.state.session);
        out.frames = p3.frame_indices.length;
        out.nodes = p3.node_names.length;
        // points_3d is [frame][track][node] = [x,y,z]
        const first = p3.points_3d[0] && p3.points_3d[0][0] && p3.points_3d[0][0][0];
        out.firstPt = first ? Array.from(first) : null;
        out.anyNaN = JSON.stringify(p3.points_3d).includes('null');
        // Legacy SLP export data — reads points3d into frame_group_dicts.
        const slp = fileio.buildSlpExportData(AS.state.session, AS.state.views);
        out.slpFrames = slp.frames.length;
        return out;
    });
    console.log('\n-- export data builders --');
    check(exp.frames === built.nFrames, `points3d.h5 export covers all frames (${exp.frames}/${built.nFrames})`);
    check(exp.nodes === 3, `points3d.h5 export has 3 nodes (got ${exp.nodes})`);
    check(exp.firstPt && Math.abs(exp.firstPt[0] - built.truth0[0][0]) < 1e-6
        && Math.abs(exp.firstPt[2] - built.truth0[0][2]) < 1e-6,
        `points3d.h5 export carries real coordinates (got ${JSON.stringify(exp.firstPt)}, expected ~${JSON.stringify(built.truth0[0])})`);
    check(exp.slpFrames > 0, `legacy SLP export builds frames (${exp.slpFrames})`);

    // ---------------------------------------------------------------
    // JSON project round-trip (the boxed on-disk shape must survive)
    // ---------------------------------------------------------------
    const rt = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const pd = await import('/pose/pose-data.js');
        const saveLoad = await import('/import-export/save-load.js');
        let json = null;
        const origCreate = URL.createObjectURL;
        // saveProject() triggers a download; capture the Blob instead.
        let captured = null;
        URL.createObjectURL = (blob) => { captured = blob; return 'blob:stub'; };
        try { saveLoad.saveProject(); } finally { URL.createObjectURL = origCreate; }
        if (!captured) return { skipped: true };
        json = JSON.parse(await captured.text());

        const sess = json.sessions ? json.sessions[0] : json;
        // `frames` is a frameIdx-keyed object, not an array.
        const fr = Object.values(sess.frames || {}).find(f => f.instanceGroups && f.instanceGroups.length);
        const gd = fr && fr.instanceGroups[0];
        const before = AS.state.session.instanceGroups.get(0)[0];
        return {
            skipped: false,
            onDiskIsBoxed: Array.isArray(gd && gd.points3d) && Array.isArray(gd.points3d[0]),
            onDiskFirst: gd && gd.points3d && gd.points3d[0],
            onDiskObserved: gd && gd.observedPoints ? Object.keys(gd.observedPoints).sort() : null,
            inMemoryFirst: pd.getPoint3d(before.points3d, 0),
        };
    });
    console.log('\n-- JSON project format --');
    if (rt.skipped) { check(false, 'saveProject produced a blob'); }
    else {
        check(rt.onDiskIsBoxed, 'points3d still serialized as BOXED [x,y,z] rows (format unchanged)');
        check(JSON.stringify(rt.onDiskFirst) === JSON.stringify(rt.inMemoryFirst),
            `on-disk value matches in-memory (${JSON.stringify(rt.onDiskFirst)})`);
        check(JSON.stringify(rt.onDiskObserved) === '["camA","camB","camC"]',
            `observedPoints still written for backward compat (got ${JSON.stringify(rt.onDiskObserved)})`);
    }

    // ---------------------------------------------------------------
    // Editing paths that used to hand-sync observedPoints
    // ---------------------------------------------------------------
    const edit = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const pd = await import('/pose/pose-data.js');
        const g = AS.state.session.instanceGroups.get(0)[0];
        const before = Object.keys(g.observedPoints).sort();
        // Remove a member the way the edit-group / delete paths do.
        g.instances.delete('camB');
        const afterRemove = Object.keys(g.observedPoints).sort();
        // Add it back.
        const inst = new pd.Instance([[1, 2], [3, 4], [5, 6]], 0, 'user', 1);
        g.addInstance('camB', inst);
        const afterAdd = Object.keys(g.observedPoints).sort();
        const matchesMember = JSON.stringify(g.observedPoints.camB) === JSON.stringify(inst.toPointsArray());
        // Live mutation (drag) must still be visible: the getter re-derives on
        // every read, even though it now returns a snapshot rather than the
        // member's own array (luc3d #189 follow-up #1).
        inst.setPoint(0, 999, 2);
        const seesDrag = g.observedPoints.camB[0][0] === 999;
        return { before, afterRemove, afterAdd, matchesMember, seesDrag };
    });
    console.log('\n-- edit-group membership sync (was hand-patched, now derived) --');
    check(JSON.stringify(edit.afterRemove) === '["camA","camC"]',
        `removing a member drops it from observedPoints (got ${JSON.stringify(edit.afterRemove)})`);
    check(JSON.stringify(edit.afterAdd) === '["camA","camB","camC"]',
        `adding a member restores it (got ${JSON.stringify(edit.afterAdd)})`);
    check(edit.matchesMember, 'added member is reflected in observedPoints');
    check(edit.seesDrag, 'live drag mutation visible through observedPoints');

    // ---------------------------------------------------------------
    // Info-panel tabs — every submenu must render with the new data model
    // ---------------------------------------------------------------
    const TABS = ['tabInstances', 'tabCameras', 'tabSkeleton', 'tabSession', 'tabVideos', 'tabVisibility'];
    console.log('\n-- info panel tabs --');
    for (const tab of TABS) {
        const r = await page.evaluate((t) => {
            const el = document.querySelector(`[data-tab="${t}"]`);
            if (!el) return { missing: true };
            el.click();
            const pane = document.getElementById(t);
            return {
                missing: false,
                shown: !!pane && pane.style.display !== 'none',
                len: pane ? pane.innerText.replace(/\s+/g, ' ').trim().length : 0,
                nan: pane ? /NaN|undefined/.test(pane.innerText) : false,
            };
        }, tab);
        check(!r.missing && r.shown && r.len > 0, `${tab} renders (${r.len} chars)`);
        check(!r.nan, `${tab} has no NaN/undefined text`);
    }

    // ---------------------------------------------------------------
    // Menu actions that read/write the changed representations
    // ---------------------------------------------------------------
    console.log('\n-- menu actions --');
    const MENU_ACTIONS = [
        'menuGroupByIdentity', 'menuGroupByTrack',
        'menuPropagateIdsToTracks', 'menuPropagateTracksToIds',
        'menuFitScene', 'menuResetView',
    ];
    for (const id of MENU_ACTIONS) {
        const before = runtimeErrors.length;
        await page.evaluate((mid) => {
            const el = document.getElementById(mid);
            if (el) el.click();
        }, id);
        await page.waitForTimeout(400);
        // Dismiss any modal the action opened so the next click is not blocked.
        await page.evaluate(() => {
            document.querySelectorAll('.modal-overlay, .lucid-loading-progress-modal').forEach(el => el.remove());
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        check(runtimeErrors.length === before,
            `${id} ran without a runtime error${runtimeErrors.length > before ? ' — ' + runtimeErrors[before] : ''}`);
    }

    // Everything above must have left the 3D + info panel still consistent.
    const after = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const pd = await import('/pose/pose-data.js');
        const infoPanel = await import('/ui/info-panel.js');
        infoPanel.updateInfoPanel();
        let flat = 0, boxed = 0, groups = 0;
        for (const [, gs] of AS.state.session.instanceGroups) {
            for (const g of gs) {
                groups++;
                if (g.points3d == null) continue;
                if (g.points3d instanceof Float64Array) flat++; else boxed++;
            }
        }
        return { groups, flat, boxed };
    });
    console.log('\n-- post-action invariant --');
    check(after.boxed === 0,
        `every group's points3d is still flat after all menu actions (${after.flat} flat / ${after.boxed} boxed of ${after.groups})`);

    // ---------------------------------------------------------------
    // Runtime errors anywhere in the run
    // ---------------------------------------------------------------
    console.log('\n-- runtime errors --');
    check(runtimeErrors.length === 0, `no pageerror / console.error during the whole run (${runtimeErrors.length})`);
    for (const e of runtimeErrors.slice(0, 12)) console.log('     ', e);

} catch (err) {
    console.error('FATAL', err);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
