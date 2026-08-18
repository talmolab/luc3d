/**
 * Fig 2a — SOURCE PANELS for the reprojection-aided labelling protocol.
 *
 * Stages the protocol in the REAL app on real data, in the order a labeller does it:
 *
 *   1  ANCHORS   two views carry labels. Any two, as long as they see the animal --
 *                here one overhead and one side view, so the baseline is wide.
 *   2  3D        triangulate from ONLY those two views. This is done through the
 *                app's own Camera Views weights (Tracking Wizard ▸ Camera Views,
 *                weight 0 = excluded from tracking and triangulation), so the 3D
 *                really is a two-view solve -- not an eight-view solve relabelled.
 *   3  REPROJECT the remaining views get the 3D point drawn back into them, dotted,
 *                with predictions switched OFF so what is left in those tiles is
 *                only what LUC3D put there. That is the panel's whole claim: the
 *                labeller did not touch these views.
 *   4  ACCEPT    predictions back ON plus the error vectors, which is the actual
 *                decision a labeller makes -- accept the reprojection, or nudge it.
 *
 * Also records the app's OWN per-view reprojection errors for both the two-anchor
 * and the all-views solve, so the panel's annotations quote this run.
 *
 * The skeleton EDGE SET is overridden to the complete 26-edge plotting skeleton
 * (setSkeletonEdges / MOUSE_EDGES, from src/skeleton_style.py) before any export
 * (Eric 2026-08-16): the session's own sparse edge list reads as spiky lines
 * rather than a mouse at print size. Display-only -- nothing on the tracking or
 * triangulation path reads skeleton.edges, and the manifest's reprojection
 * errors were diff-verified unchanged against the pre-override run.
 *
 * Writes figs/out/fig2p-*.png and figs/out/fig2-protocol.json.
 *
 * Usage: node figs/fig2_protocol.mjs   (env: PORT, FRAME, NANIMALS, ANCHORS, SHOWCAMS)
 */
import {
    launch, loadSession, gotoFrame, trackAll, triangulateAll, setColorMode,
    setOverlayStyle, setVisibility, setAnchorViews, reprojErrors, setLayout,
    set3dChrome, hide3dButtons, rigFit, frame3d, shootEl, exportViews, clearOverlays,
    writeManifest, done, log, CAMS, setIdentityPalette, setSkeletonEdges,
} from './_drive.mjs';

const FRAME = Number(process.env.FRAME || 150);
const NANIMALS = Number(process.env.NANIMALS || 3);
const BRIGHT = Number(process.env.BRIGHT || 1.9);
// One overhead + one side view: a wide baseline, which is what makes a two-view
// solve well conditioned. Both see all three animals at this frame.
const ANCHORS = (process.env.ANCHORS || 'Camera1_topB,Camera6_sideL').split(',');
// The views the figure shows as "not labelled".
const SHOWCAMS = (process.env.SHOWCAMS || 'Camera0_mid,Camera4_topR,Camera2_topC')
    .split(',');

const PRINT_STYLE = {
    predNodeSize: 5, predEdgeWeight: 3,
    userNodeSize: 5, userEdgeWeight: 3, userLabelSize: 0,
    reprojNodeSize: 6, reprojEdgeWeight: 3,
};

const ctx = await launch({ port: Number(process.env.PORT || 8088), width: 2560, height: 1440, scale: 2 });
const { page } = ctx;
try {
    const loaded = await loadSession(page, { cams: CAMS });
    await gotoFrame(page, FRAME);
    await setOverlayStyle(page, PRINT_STYLE);
    // Complete plotting skeleton for every tile (display-only; see header note).
    const skelEdges = await setSkeletonEdges(page);
    await setColorMode(page, 'id');

    const tracked = await trackAll(page, NANIMALS);
    // Identities exist only after tracking, and the constructor reads the palette once,
    // so the override has to land here -- not before loadSession.
    await setIdentityPalette(page);

    // ---- reference: triangulate from ALL views -------------------------------
    const triAll = await triangulateAll(page);
    await clearOverlays(page);
    await gotoFrame(page, FRAME);
    const errAll = await reprojErrors(page);

    // ---- the protocol: triangulate from the TWO anchor views only ------------
    await setAnchorViews(page, ANCHORS);
    const tri2 = await triangulateAll(page);
    await clearOverlays(page);
    await gotoFrame(page, FRAME);
    const err2 = await reprojErrors(page);

    // 1+2. The anchor views as the labeller leaves them: labels visible, no
    //      reprojection drawn over them.
    await setVisibility(page, { predicted: true, user: true, reprojections: false, errors: false });
    const anchors = await exportViews(page, { cams: ANCHORS, prefix: 'fig2p-anchor', brightness: BRIGHT });

    // 3. The unlabelled views: ONLY the reprojection.
    await setVisibility(page, { predicted: false, user: false, reprojections: true, errors: false });
    const reproj = await exportViews(page, { cams: SHOWCAMS, prefix: 'fig2p-reproj', brightness: BRIGHT });

    // 4. The accept/nudge decision: reprojection against the detection, with the
    //    error vectors the app draws between them. Reprojection labels off -- this
    //    tile is shown MAGNIFIED, where a pane-sized label covers the animal.
    await setVisibility(page, { predicted: true, user: true, reprojections: true, errors: true });
    await setOverlayStyle(page, { ...PRINT_STYLE, reprojLabelSize: 0 });
    const check = await exportViews(page, { cams: SHOWCAMS, prefix: 'fig2p-check', brightness: BRIGHT });

    // The 3D built from two views, seen from the rig.
    await hide3dButtons(page, true);
    await setLayout(page, { hideInfoPanel: true, timelineHeight: 0, threeDWidth: 1400 });
    await set3dChrome(page, {
        labels: false, pyramids: true, spheres: true, grid: false,
        pyramidLength: 22, sphereSize: 2,
    });
    const rig = await rigFit(page, {
        startCam: ANCHORS[0], elevation: 20, pad: 1.04, targetBias: 0.10, fill: 0.88,
    });
    await shootEl(page, '#viewport3dContainer', 'fig2p-3d');
    // Also a shot framed on the ANIMALS. The rig overview is the right picture for
    // "here is the geometry", but at the 42 mm a figure column allows, the animals in
    // it are ~2 mm across; step 2's claim is "you now have a 3D pose", so that needs
    // a tile where the pose is legible.
    const near = await frame3d(page, { azimuth: 40, elevation: 22, pad: 2.4 });
    await shootEl(page, '#viewport3dContainer', 'fig2p-3d-animals');
    await hide3dButtons(page, false);

    writeManifest('fig2-protocol', {
        session: loaded, frame: FRAME, nAnimals: NANIMALS, brightness: BRIGHT,
        overlayStyle: PRINT_STYLE, anchors: ANCHORS, showCams: SHOWCAMS,
        cameras: CAMS, tracked, skeletonEdges: skelEdges,
        triangulatedAllViews: triAll, triangulatedTwoAnchors: tri2,
        reprojErrorsAllViews: errAll, reprojErrorsTwoAnchors: err2,
        views: { anchor: anchors, reproj, check },
        threeD: { rig: 'fig2p-3d.png', framing: rig,
                  animals: 'fig2p-3d-animals.png', animalsFraming: near },
    });

    const mean2 = (err2 || []).map(e => e.meanError).filter(Number.isFinite);
    const meanA = (errAll || []).map(e => e.meanError).filter(Number.isFinite);
    log(`[summary] frame ${FRAME}: 2-anchor mean reproj err ` +
        `[${mean2.join(', ')}] px vs all-views [${meanA.join(', ')}] px`);
} finally {
    await done(ctx);
}
