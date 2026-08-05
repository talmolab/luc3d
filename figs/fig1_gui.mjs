/**
 * GUI montage (DOCS/SLIDES ONLY, NOT A FIGURE SOURCE) — multi-camera grid + 3D
 * viewport with camera frustums.
 *
 * ***No `figs/panels/*.py` may read anything this script writes.*** Every output
 * is prefixed `gui-` for exactly that reason: this pass used to write
 * `fig1b-*.png`, names indistinguishable from Fig 1's real panel sources, and
 * `panels/fig1_03_reconstruction.py` silently read two of them
 * (`fig1b-e-3d-camview-clean.png`, `fig1b-d2-3d-rig.png`) for weeks — 2026-08-03
 * output predating `setIdentityPalette()`, so Fig 1c shipped the app's green/
 * magenta/cyan identity palette while Fig 1b was Okabe-Ito (a BLOCKER review
 * finding, misdiagnosed twice). Panel sources come from `fig1_tracking.mjs`
 * (`tri3d-*.png`, `fig1.json`); this script is for whole-window screenshots for
 * docs and slides, which are illegible at print size. Keep the `gui-` prefix.
 *
 * Drives the REAL app over REAL data (figs/session: 8 cameras, 3 mice, 15-node
 * skeleton, 60 fps, trimmed from 20260605_133431-HardFight) through the actual
 * pipeline the figure claims: load -> Track All (cross-view ReID) -> Group by
 * Identity & Triangulate All. Nothing here is posed or mocked; the 3D viewport
 * shows genuine triangulated output and the reprojection overlays are the app's.
 *
 * Screenshots written to figs/out/:
 *   gui-a-predictions.png       raw per-camera predictions, colored BY TRACK
 *                               (fragmented: the same animal gets a different
 *                               color in every view -- the problem statement)
 *   gui-b-identities.png        after Track All, colored BY IDENTITY
 *                               (one color per animal across all 8 views)
 *   gui-c-full.png              full GUI after triangulation, 3D framed on the
 *                               animals -- the montage shot
 *   gui-c-track-colored.png     same frame/perspective, colored BY TRACK
 *   gui-c2-full-rig.png         full GUI with the 3D pane at the rig overview
 *   gui-d-3d-camview.png        3D viewport alone at a camera's perspective
 *   gui-d-3d-camview-track.png  the same, colored BY TRACK
 *   gui-d2-3d-rig.png           3D viewport, rig overview (all 8 frustums)
 *   gui-e-3d-camview-clean.png  3D viewport, chrome off, animals filling frame
 *   gui-f-grid.png              just the camera grid
 *   gui-g-timeline.png          per-camera track/identity timeline
 *   gui-h-panel.png             instance info panel (per-instance reprojection error)
 *   gui-i-3d-matched.png        3D pane widened to the camera's aspect ratio
 *   gui-i-full-matched.png      the whole window in that matched layout
 *
 * Usage: node figs/fig1_gui.mjs        (env: PORT, FRAME, NANIMALS)
 */
import {
    launch, loadSession, gotoFrame, trackAll, triangulateAll, setColorMode,
    setIdentityPalette, showCameraView, showInitialView, set3dChrome, setLayout,
    hide3dButtons, clearOverlays, shoot, shootEl, done, log,
} from './_drive.mjs';

const FRAME = Number(process.env.FRAME || 150);
const NANIMALS = Number(process.env.NANIMALS || 3);
const VIEW_CAM = process.env.VIEW_CAM || 'Camera0_mid';

const ctx = await launch({ port: Number(process.env.PORT || 8086), width: 2560, height: 1440, scale: 2 });
const { page } = ctx;
try {
    await loadSession(page);
    await gotoFrame(page, FRAME);

    // (a) The problem: per-camera SLEAP tracks. 320 track_N labels across 8
    // cameras for 3 animals, with no correspondence between views.
    await setColorMode(page, 'tracks');
    await shoot(page, 'gui-a-predictions');

    // (b) After the cross-view tracker: 3 global identities, same color everywhere.
    await trackAll(page, NANIMALS);
    // Colourblind-safe identity colours; must follow trackAll (see fig1_tracking.mjs).
    await setIdentityPalette(page);
    await clearOverlays(page);
    await setColorMode(page, 'id');
    await gotoFrame(page, FRAME);
    await shoot(page, 'gui-b-identities');

    // (c) Triangulated. The 3D viewport is put at VIEW_CAM's own perspective via
    // the app's "Show Camera View" -- the 3D skeletons then land exactly where
    // that camera's 2D pane shows the animals, so the two panels are directly
    // comparable. An arbitrary orbit angle is unverifiable and reads as decoration.
    const tri = await triangulateAll(page);
    await clearOverlays(page);
    await gotoFrame(page, FRAME);
    await showCameraView(page, VIEW_CAM);
    await setColorMode(page, 'id');
    await shoot(page, 'gui-c-full');
    await shootEl(page, '#viewport3dContainer', 'gui-d-3d-camview');

    // (c-track) The same frame, same perspective, colored by TRACK instead --
    // the pair (c-track, c-full) is the evidence that identity is what makes the
    // 2D views and the 3D reconstruction agree on which animal is which.
    await setColorMode(page, 'tracks');
    await shoot(page, 'gui-c-track-colored');
    await shootEl(page, '#viewport3dContainer', 'gui-d-3d-camview-track');
    await setColorMode(page, 'id');

    // (e) Same perspective with the rig chrome off: 3D pose only, to overlay on
    // or sit beside the matching 2D pane.
    await set3dChrome(page, { labels: false, pyramids: false, spheres: false });
    await shootEl(page, '#viewport3dContainer', 'gui-e-3d-camview-clean');
    await set3dChrome(page, { labels: true, pyramids: true, spheres: true });

    // (d2) The rig overview -- all 8 frustums, which is what shows the geometry.
    await showInitialView(page);
    await shootEl(page, '#viewport3dContainer', 'gui-d2-3d-rig');
    await shoot(page, 'gui-c2-full-rig');
    await showCameraView(page, VIEW_CAM);

    // (f)(g)(h) component crops (for slides -- the figure's own crops come from
    // fig1_tracking.mjs).
    await shootEl(page, '#videoDock', 'gui-f-grid');
    await shootEl(page, '#timelineContainer', 'gui-g-timeline');
    await shootEl(page, '#infoPanel', 'gui-h-panel');

    // (i) The like-for-like pair: the 3D pane widened to VIEW_CAM's aspect ratio
    // and put at its perspective, next to that same camera's 2D pane. Same frame,
    // same viewpoint, same ID colors -- so the reader can check the 3D against the
    // image instead of taking it on faith.
    await setLayout(page, { hideInfoPanel: true, timelineHeight: 0, threeDWidth: 'match' });
    await showCameraView(page, VIEW_CAM);
    await set3dChrome(page, { labels: false });
    await hide3dButtons(page, true);
    await shootEl(page, '#viewport3dContainer', 'gui-i-3d-matched');
    await shoot(page, 'gui-i-full-matched');
    await hide3dButtons(page, false);

    log('[summary] ' + JSON.stringify({ frame: FRAME, ...tri }));
} finally {
    await done(ctx);
}
