/**
 * Fig 1 — SOURCE PANELS (not the finished figure). figs/fig1.py lays these out.
 *
 * The full-window GUI screenshot is unusable at print size: 8 panes 4-across plus
 * a timeline and an info panel, with each mouse a few dozen pixels wide. So this
 * exports the pieces at NATIVE resolution and records where the animals are, what
 * track/identity each carries, and the exact colour the app drew it in. The
 * composer crops tight, lays them out large, and adds the arrows and labels.
 *
 * Nothing is mocked: the tiles are the app's own canvases (video + overlay) after
 * the real pipeline runs on real data (figs/session -- 8 cameras, 3 mice, 15-node
 * skeleton, 60 fps, trimmed from 20260605_133431-HardFight).
 *
 * Three states of the SAME frame:
 *   before-*   per-camera SLEAP tracks, coloured BY TRACK, Tracks timeline.
 *              Many track_N labels for 3 animals, no correspondence across views.
 *   after-*    after Track All (cross-view re-ID), coloured BY IDENTITY, IDs
 *              timeline. One colour per animal in every view.
 *   tri3d-*    after Triangulate All: the 3D viewport at a real camera's
 *              perspective (the app's "Show Camera View"), so the 3D lands where
 *              that camera's 2D pane shows the animals and the two are directly
 *              comparable -- plus the rig overview with all 8 frustums.
 *
 * Writes figs/out/{before,after}-f<FRAME>-<cam>.png (1280x1024), the 3D crops,
 * the two timelines, and figs/out/fig1.json.
 *
 * Usage: node figs/fig1_tracking.mjs     (env: PORT, FRAME, NANIMALS, CAMS, VIEW_CAM)
 */
import {
    launch, loadSession, gotoFrame, trackAll, triangulateAll, setColorMode,
    setTimelineMode, setOverlayStyle, showCameraView, showInitialView, setLayout,
    set3dChrome, hide3dButtons, exportViews, writeManifest, shootEl, clearOverlays,
    done, log, CAMS,
} from './_drive.mjs';

const FRAME = Number(process.env.FRAME || 150);
const NANIMALS = Number(process.env.NANIMALS || 3);
const VIEW_CAM = process.env.VIEW_CAM || 'Camera0_mid';
const BRIGHT = Number(process.env.BRIGHT || 1.9);
const cams = (process.env.CAMS || '').trim() ? process.env.CAMS.split(',') : CAMS;

// Print geometry: the app's screen defaults are tuned for panes at ~1:3 CSS scale,
// so at native resolution they are chunky X's that swamp a 40 mm tile.
const PRINT_STYLE = {
    predNodeSize: 5, predEdgeWeight: 3,
    userNodeSize: 5, userEdgeWeight: 3, userLabelSize: 0,
    reprojNodeSize: 5, reprojEdgeWeight: 3,
};

const ctx = await launch({ port: Number(process.env.PORT || 8086), width: 2560, height: 1440, scale: 2 });
const { page } = ctx;
try {
    const loaded = await loadSession(page, { cams });
    await gotoFrame(page, FRAME);
    await setOverlayStyle(page, PRINT_STYLE);

    // ---- BEFORE: per-camera tracks -------------------------------------------
    await setColorMode(page, 'tracks');
    await setTimelineMode(page, 'tracks');
    const before = await exportViews(page, { cams, prefix: 'before', brightness: BRIGHT });
    await shootEl(page, '#timelineContainer', 'before-timeline');

    // ---- AFTER: cross-view identities ----------------------------------------
    const tracked = await trackAll(page, NANIMALS);
    await clearOverlays(page);
    await gotoFrame(page, FRAME);
    await setColorMode(page, 'id');
    await setTimelineMode(page, 'identities');
    const after = await exportViews(page, { cams, prefix: 'after', brightness: BRIGHT });
    await shootEl(page, '#timelineContainer', 'after-timeline');

    // ---- 3D: triangulated, viewed from a real camera --------------------------
    const tri = await triangulateAll(page);
    await clearOverlays(page);
    await gotoFrame(page, FRAME);
    await setColorMode(page, 'id');
    await hide3dButtons(page, true);

    // Match the 3D pane to VIEW_CAM's aspect ratio so "Show Camera View" is a
    // true like-for-like of that camera's 2D tile.
    await setLayout(page, { hideInfoPanel: true, timelineHeight: 0, threeDWidth: 'match' });
    await showCameraView(page, VIEW_CAM);
    await set3dChrome(page, { labels: false });
    await shootEl(page, '#viewport3dContainer', 'tri3d-camview');

    await showInitialView(page);
    await set3dChrome(page, { labels: true, pyramids: true, spheres: true });
    await shootEl(page, '#viewport3dContainer', 'tri3d-rig');
    await hide3dButtons(page, false);

    const stats = await page.evaluate((f) => {
        const s = window.__lucid.state.session;
        const gs = s.instanceGroups.get(f) || [];
        // Mean per-instance reprojection error over this frame's groups, and the
        // node coverage of the 3D -- the numbers the figure caption can quote.
        let n3d = 0, nodes = 0, filled = 0;
        for (const g of gs) {
            if (!g.points3d) continue;
            n3d++;
            const p = g.points3d;
            for (let i = 0; i + 2 < p.length; i += 3) {
                nodes++;
                if (Number.isFinite(p[i]) && Number.isFinite(p[i + 1]) && Number.isFinite(p[i + 2])) filled++;
            }
        }
        return {
            groupsThisFrame: gs.length, with3dThisFrame: n3d,
            nodes3d: nodes, nodes3dFilled: filled,
            nCameras: s.cameras.length,
            nNodes: s.skeleton ? s.skeleton.nodes.length : null,
        };
    }, FRAME);

    // Distinct track labels used for these 3 animals in this ONE frame across all
    // views -- the number the "no cross-view correspondence" claim rests on.
    const distinct = new Set();
    for (const v of before) for (const d of v.details) if (d.track) distinct.add(v.name + '/' + d.track);
    const distinctNames = new Set();
    for (const v of before) for (const d of v.details) if (d.track) distinctNames.add(d.track);

    writeManifest('fig1', {
        session: loaded, frame: FRAME, nAnimals: NANIMALS, viewCam: VIEW_CAM,
        brightness: BRIGHT, overlayStyle: PRINT_STYLE, cameras: cams,
        tracked, triangulated: tri, stats,
        distinctTrackLabels: distinct.size, distinctTrackNames: distinctNames.size,
        before, after,
        timelines: { before: 'before-timeline.png', after: 'after-timeline.png' },
        threeD: { camview: 'tri3d-camview.png', rig: 'tri3d-rig.png' },
    });

    log(`[summary] frame ${FRAME}: ${distinct.size} per-camera track labels ` +
        `(${distinctNames.size} distinct names) across ${cams.length} views -> ` +
        `${tracked.identities} identities; ${tri.with3d}/${tri.groups} groups with 3D`);
} finally {
    await done(ctx);
}
