/**
 * Fig 5a — SOURCE PANELS for "what the app reports while you proofread".
 *
 * Fig 5a used to borrow Fig 2a's tiles, which come from a DELIBERATELY CRIPPLED
 * two-anchor solve: every non-anchor residual there is inflated by construction
 * (up to 24.6 px), which is Fig 2's point and the opposite of Fig 5's. Fig 5 is
 * about proofreading a FULLY-INFORMED 3D, so this stages the same frame of the
 * same recording with the 3D solved from ALL eight views and records the app's own
 * per-view reprojection errors for that solve.
 *
 * Writes figs/out/fig5a-*.png and figs/out/fig5a.json.
 *
 * Usage: node figs/fig5_panel_a.mjs   (env: PORT, FRAME, NANIMALS, SHOWCAMS, BRIGHT)
 */
import {
    launch, loadSession, gotoFrame, trackAll, triangulateAll, setColorMode,
    setOverlayStyle, setVisibility, reprojErrors, exportViews, writeManifest,
    done, log, CAMS, setIdentityPalette,
} from './_drive.mjs';

const FRAME = Number(process.env.FRAME || 150);
const NANIMALS = Number(process.env.NANIMALS || 3);
const BRIGHT = Number(process.env.BRIGHT || 1.9);
const SHOWCAMS = (process.env.SHOWCAMS || 'Camera0_mid,Camera2_topC,Camera4_topR')
    .split(',');
const PRINT_STYLE = {
    predNodeSize: 5, predEdgeWeight: 3,
    // userLabelSize 1, not 0: ui/overlays.js:2031 passes
    // `labelSize: (userOpts && userOpts.labelSize) || 11`, so a slider value of 0
    // falls back to 11 and the predicted instances' identity pills are drawn at full
    // size -- which a magnified crop turns into a label bigger than the animal.
    userNodeSize: 5, userEdgeWeight: 3, userLabelSize: 1,
    reprojNodeSize: 6, reprojEdgeWeight: 3,
};

const ctx = await launch({ port: Number(process.env.PORT || 8091), width: 2560, height: 1440, scale: 2 });
const { page } = ctx;
try {
    const loaded = await loadSession(page, { cams: CAMS });
    await gotoFrame(page, FRAME);
    await setOverlayStyle(page, PRINT_STYLE);
    await setColorMode(page, 'id');
    const tracked = await trackAll(page, NANIMALS);
    // Identities are constructed by tracking and the constructor reads the palette
    // once, so the colourblind-safe override has to land here. The app ships
    // IDENTITY_COLORS as #00ff00/#ff00ff/#00ffff, which converge under deuteranopia.
    await setIdentityPalette(page);
    const tri = await triangulateAll(page);
    const err = await reprojErrors(page);

    // The proofreading decision as the app presents it: detections, the
    // reprojection of the all-views 3D, and the error vectors between them.
    await setVisibility(page, { predicted: true, user: true, reprojections: true, errors: true });
    await setOverlayStyle(page, { ...PRINT_STYLE, reprojLabelSize: 0 });
    const views = await exportViews(page, { cams: SHOWCAMS, prefix: 'fig5a', brightness: BRIGHT });

    writeManifest('fig5a.json', {
        generated_by: 'figs/fig5_panel_a.mjs',
        session: loaded, frame: FRAME, nAnimals: NANIMALS, brightness: BRIGHT,
        overlayStyle: PRINT_STYLE, cameras: CAMS, showCams: SHOWCAMS,
        solve: 'all eight views (no anchors, no excluded cameras)',
        tracked, triangulatedAllViews: tri, reprojErrorsAllViews: err,
        views: { check: views },
    });
    log('[summary] all-views mean reproj err ' +
        (err || []).map(r => `id${r.identity}=${r.meanError}`).join(' '));
} finally {
    await done(ctx);
}
