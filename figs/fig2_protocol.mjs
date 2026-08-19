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
    set3dChrome, hide3dButtons, rigFit, frame3d, showCameraView,
    shootEl, exportViews, clearOverlays,
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
// Margin left around the 3D pose in the "3D from the 2 anchors" tile, as a
// multiple of the tightest fit. 1.0 puts the outermost keypoint exactly on the
// frame edge, so this is the breathing room -- not a zoom factor to taste.
const FIT3D_PAD = Number(process.env.FIT3D_PAD || 1.18);

/**
 * Aim the 3D viewport at the frame's animals and narrow its FOV until they fill it.
 *
 * Called right after `showCameraView`, so the camera POSITION and ROLL stay the
 * calibrated ones; only the look-at and the field of view move. That makes the tile
 * a CROP of what sideL sees rather than a new viewpoint, which is the whole point of
 * putting it under the sideL video.
 *
 * THE FOV IS COMPUTED, NOT DIALLED IN. A hand-set zoom (2.6x was the first try) has
 * no way to know where the outermost keypoint is and clipped the third animal off the
 * left edge. Here every 3D point is resolved onto the camera's own right/up/forward
 * axes and the vertical half-angle is taken as the max of what the point needs
 * vertically and what it needs horizontally once the pane's aspect is divided out --
 * so nothing can fall outside the frame, whatever the pose does.
 */
async function zoomOnAnimals(page, pad) {
    const res = await page.evaluate((padv) => {
        const v = window.__lucid.viewport3d;
        const st = window.__lucid.state;
        const s = st.session;
        if (!v || !s) return null;
        const gs = s.instanceGroups.get(st.currentFrame) || [];
        const pts = [];
        let cx = 0, cy = 0, cz = 0;
        for (const g of gs) {
            const p = g.points3d;                 // flat Float64Array(3N) since #189
            if (!p) continue;
            for (let i = 0; i + 2 < p.length; i += 3) {
                const x = p[i], y = p[i + 1], z = p[i + 2];
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
                pts.push([x, y, z]); cx += x; cy += y; cz += z;
            }
        }
        const n = pts.length;
        if (!n) return { n: 0 };
        cx /= n; cy /= n; cz /= n;
        const cam = v.threeCamera;
        const fov0 = cam.fov;
        v.controls.target.set(cx, cy, cz);
        v.controls.update();                      // keeps position, re-aims at target
        cam.updateMatrixWorld(true);
        const e = cam.matrixWorld.elements;       // column-major: right, up, -forward
        const right = [e[0], e[1], e[2]];
        const up = [e[4], e[5], e[6]];
        const fwd = [-e[8], -e[9], -e[10]];
        const pos = [e[12], e[13], e[14]];
        const aspect = cam.aspect || 1;
        let tan = 0;
        for (const p of pts) {
            const d = [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]];
            const depth = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
            if (depth <= 1e-6) continue;          // behind the camera
            const vert = Math.abs(d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / depth;
            const horz = Math.abs(d[0] * right[0] + d[1] * right[1] + d[2] * right[2])
                / depth / aspect;
            tan = Math.max(tan, vert, horz);
        }
        if (!(tan > 0)) return { n, why: 'no point in front of the camera' };
        cam.fov = Math.min(fov0, 2 * Math.atan(tan * padv) * 180 / Math.PI);
        cam.updateProjectionMatrix();
        if (v.renderer && v.scene) v.renderer.render(v.scene, cam);
        return { n, centroid: [cx, cy, cz].map(x => +x.toFixed(1)), aspect: +aspect.toFixed(3),
                 fov0: +fov0.toFixed(2), fov: +cam.fov.toFixed(2),
                 zoom: +(fov0 / cam.fov).toFixed(2), pad: padv };
    }, pad);
    log('[zoomOnAnimals] ' + JSON.stringify(res));
    await page.waitForTimeout(400);
    return res;
}

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
    //
    // FROM THE sideL ANCHOR'S OWN VIEWPOINT, NOT AN ARBITRARY ORBIT (Eric,
    // 2026-08-19: "re render that with the camera in the same camera angle as sideL
    // and zoom in a bit"). This tile sits directly under the "cam 6 sideL - anchor"
    // video in the panel, so putting the 3D at that camera's real pose lets a reader
    // check the reconstruction against the pixels it came from -- the same reasoning
    // Fig 1d's middle tile uses. `showCameraView` is the app's own "Show Camera
    // View" button, so the pose and FOV are the session's calibrated extrinsics.
    await showCameraView(page, ANCHORS[1]);
    const near = await zoomOnAnimals(page, FIT3D_PAD);
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
