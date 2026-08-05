/**
 * Fig 1c — the RIG panel, framed properly.
 *
 * The app's own "Show Initial View" fits the scene bounds, which on this rig means
 * the animals end up a few pixels across and the panel reads as an empty box (that
 * is what the first pass of Fig 1c looked like). This sweeps a few real framings so
 * one can be chosen by eye:
 *
 *   rig-cam<CAM>-el<E>-pad<P>.png   orbit azimuth taken from a REAL top camera,
 *                                   elevation E degrees above horizontal, zoomed
 *                                   out to `pad` x the distance that just fits every
 *                                   camera frustum plus the animals.
 *
 * Low elevation puts the overhead cameras in the upper part of the frame and the
 * animals in the lower part, so the panel shows what the rig actually is: cameras
 * looking DOWN at an arena.
 *
 * Usage: node figs/fig1_rig.mjs   (env: PORT, FRAME, NANIMALS, ELEVS, PADS, STARTCAMS)
 */
import {
    launch, loadSession, gotoFrame, trackAll, triangulateAll, setColorMode,
    setOverlayStyle, setIdentityPalette, setLayout, set3dChrome, hide3dButtons,
    rigFit, shootEl, clearOverlays, writeManifest, done, log, CAMS,
} from './_drive.mjs';

const FRAME = Number(process.env.FRAME || 150);
const NANIMALS = Number(process.env.NANIMALS || 3);
const ELEVS = (process.env.ELEVS || '8,18,28,38').split(',').map(Number);
const PADS = (process.env.PADS || '1.04').split(',').map(Number);
const STARTCAMS = (process.env.STARTCAMS || 'Camera1_topB,Camera4_topR,Camera5_topL')
    .split(',');
// The panel is ~58 x 46 mm, so render into a pane of the same landscape aspect --
// a portrait pane spends most of the frame on empty arena.
const PANE_W = Number(process.env.PANE_W || 1600);

const PRINT_STYLE = {
    predNodeSize: 5, predEdgeWeight: 3,
    userNodeSize: 5, userEdgeWeight: 3, userLabelSize: 0,
    reprojNodeSize: 5, reprojEdgeWeight: 3,
};

const ctx = await launch({ port: Number(process.env.PORT || 8087), width: 2560, height: 1440, scale: 2 });
const { page } = ctx;
try {
    await loadSession(page, { cams: CAMS });
    await gotoFrame(page, FRAME);
    await setOverlayStyle(page, PRINT_STYLE);
    const tracked = await trackAll(page, NANIMALS);
    // Colourblind-safe identity colours, and the SAME ones fig1_tracking.mjs uses --
    // the rig tile sits beside the 2D/3D tiles in Fig 1c, so an animal that is teal
    // there cannot be magenta here. Must follow trackAll (the Identity constructor
    // reads the palette once, at construction time).
    const palette = await setIdentityPalette(page);
    const tri = await triangulateAll(page);
    await clearOverlays(page);
    await gotoFrame(page, FRAME);
    await setColorMode(page, 'id');
    await hide3dButtons(page, true);

    await setLayout(page, { hideInfoPanel: true, timelineHeight: 0, threeDWidth: PANE_W });
    // Frustums yes, the app's screen-space text labels no -- they are sized for
    // interactive use and pile up illegibly at print size. fig1.py draws its own
    // from the projected positions rigFit() returns.
    await set3dChrome(page, {
        labels: false, pyramids: true, spheres: true, grid: false,
        pyramidLength: Number(process.env.PYR || 22), sphereSize: 2,
    });

    const shots = [];
    for (const cam of STARTCAMS) {
        for (const el of ELEVS) {
            for (const pad of PADS) {
                const info = await rigFit(page, {
                    startCam: cam, elevation: el, pad, targetBias: 0.10, fill: 0.88,
                });
                const name = `rig-${cam.replace('Camera', 'c')}-el${el}-pad${String(pad).replace('.', '')}`;
                await shootEl(page, '#viewport3dContainer', name);
                shots.push({ name: name + '.png', startCam: cam, elevation: el, pad, ...info });
            }
        }
    }
    await hide3dButtons(page, false);
    writeManifest('fig1-rig', { frame: FRAME, tracked, triangulated: tri,
        identityPalette: palette, shots });
    log(`[summary] ${shots.length} rig framings written`);
} finally {
    await done(ctx);
}
