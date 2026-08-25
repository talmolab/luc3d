/**
 * Fig 1 — SOURCE PANELS (not the finished figure). figs/fig1.py lays these out.
 *
 * The full-window GUI screenshot is unusable at print size: 8 panes 4-across plus
 * a timeline and an info panel, with each mouse a few dozen pixels wide. So this
 * exports the pieces at NATIVE resolution and records where the animals are, what
 * track/identity each carries, and the exact colour the app drew it in. The
 * composer crops tight, lays them out large, and adds the arrows and labels.
 *
 * Nothing is mocked: the tiles are CLEAN video frames (`exportViews` with
 * `overlay: false`) after the real pipeline runs on real data (figs/session --
 * 8 cameras, 3 mice, 15-node skeleton, 60 fps, trimmed from
 * 20260605_133431-HardFight). SINCE 2026-08-25 the app's burned-in canvas
 * overlays are NOT composited into the tiles: the panels draw their own Fig 13
 * -style overlays in matplotlib (src/skeleton_style.draw_pose_overlay) from the
 * per-node `points` every `details[]` entry carries -- source-image pixels, in
 * the session skeleton's node order, which the manifest records as
 * `skeletonNodes` so the panel can verify it against SLAP_NODES. Colors, boxes
 * and labels still come from the manifest exactly as before (the app's own
 * color function).
 *
 * The skeleton EDGE SET is still overridden to the complete 26-edge plotting
 * skeleton (setSkeletonEdges / MOUSE_EDGES, from src/skeleton_style.py) before
 * any export (Eric 2026-08-16). With overlay:false it no longer affects the
 * video tiles' look (matplotlib draws MOUSE_EDGES itself); it is kept because
 * the 3D viewport exports below still read it, and it remains display-only --
 * nodes, detections, tracking and triangulation are untouched (nothing on those
 * paths reads skeleton.edges).
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
 * SINCE 2026-08-25 the two 3D exports (tri3d-camview.png / tri3d-rig.png) are NO
 * LONGER ON THE PANEL: Fig 1d's 3D tiles are Blender renders (Eric: "nice blender
 * renders ... i think they look like a mess atm") -- see figs/fig1d_pose_export.mjs
 * -> figs/fig1_hardfight_scene.py -> blender-images/fig1d_scene.py. The exports and
 * their manifest fields are still written (they document the app's own viewport and
 * the rigFit/camScreen numbers CAPTIONS.md used to quote), but only the video tile
 * and fig1.json's frame/palette/stats feed panels/fig1_03_reconstruction.py now.
 *
 * Usage: node figs/fig1_tracking.mjs     (env: PORT, FRAME, NANIMALS, CAMS, VIEW_CAM)
 */
import {
    launch, loadSession, gotoFrame, trackAll, triangulateAll, setColorMode,
    setTimelineMode, setOverlayStyle, setIdentityPalette, setSkeletonEdges, showCameraView,
    showInitialView, setLayout, set3dChrome, hide3dButtons, exportViews,
    rigFit, writeManifest, shootEl, clearOverlays, done, log, CAMS,
} from './_drive.mjs';

// FRAME 276, NOT 150 -- AND THE CHOICE IS THE PANEL'S ARGUMENT.
// Panel b exists to show 3 x 8 = 24 detections collapsing to 3 identities, one per
// animal in every view. At frame 150 two views (Camera3_sideC, Camera7_sideR) each
// carried a FOURTH detection in a 3-animal scene -- a duplicate of an animal already
// matched in that view -- and re-ID's per-view assignment is one-to-one, so the
// surplus was correctly left unassigned and the panel drew it as `?`. That is a real
// and defensible behaviour, but it is the wrong thing for THIS panel to lead with: a
// stray `?` invites the reader to ask what went wrong instead of reading the collapse.
// Every one of the 300 frames in this window was scanned (load once, Track All once,
// then read s.frameGroups + getIdentityIdForTrack for all 300 -- no per-frame export)
// for "every camera has exactly NANIMALS detections AND re-ID assigned all of them".
// Exactly TWO frames qualify: 276 and 278. 276 is used; at 278 the third animal
// (reared against the near wall in Camera7_sideR) has several skeleton edges falling
// off it onto the black frame, which at 40 mm reads as noise. In both, all 3 animals
// carry all 15 nodes in both figure cameras.
// FRAME 198 since 2026-08-16 (Eric): 276 was the completeness-scan pick (all 8
// cameras exactly 3 detections, all assigned — only 276/278 qualify), but its
// third animal is reared against the near wall and its skeleton reads as a
// jumble with the complete edge set. 198 was picked from a relaxed probe
// (_probe_fig1b_frames.mjs: both FIGURE cameras complete and assigned, 3D
// extents sane, ranked by worst-animal extent): the cyan animal is compact in
// both shown views. The cost, accepted deliberately: one surplus detection in
// a NON-shown camera, so the ledger reads "1 unassigned" instead of 276's 0.
const FRAME = Number(process.env.FRAME || 198);
const NANIMALS = Number(process.env.NANIMALS || 3);
const VIEW_CAM = process.env.VIEW_CAM || 'Camera0_mid';
const BRIGHT = Number(process.env.BRIGHT || 1.9);
const cams = (process.env.CAMS || '').trim() ? process.env.CAMS.split(',') : CAMS;
// Rig-tile geometry, in CSS px: the export lands at 2x this (deviceScaleFactor 2),
// i.e. 1600x900. See the rig block below for why it is landscape, and why it is NOT
// bigger than that.
const RIG_W = Number(process.env.RIG_W || 800);
const RIG_H = Number(process.env.RIG_H || 450);
const RIG_CAM = process.env.RIG_CAM || 'Camera4_topR';
const RIG_EL = Number(process.env.RIG_EL || 22);

// Print geometry: the app's screen defaults are tuned for panes at ~1:3 CSS scale,
// so at native resolution they are chunky X's that swamp a 40 mm tile.
// userLabelSize is 1, NOT 0. In ID colour mode the app also labels PREDICTED
// instances with their identity (ui/overlays.js step 3a), sizing that text from
// `(userOpts && userOpts.labelSize) || 11` -- so a 0 falls through to the 11 px
// default and the identity pills get BAKED INTO the exported canvas. They then
// collide with the labels fig1.py draws from the manifest (two mice close
// together printed "id_1" over "id_0" in the first pass) and they spell the
// internal ids. 1 keeps the slider positive so nothing else changes behaviour
// while rendering the pill at ~3 px, i.e. invisible in a 1280 px tile: every
// visible annotation is then drawn by the composer, from the manifest.
const PRINT_STYLE = {
    predNodeSize: 5, predEdgeWeight: 3,
    userNodeSize: 5, userEdgeWeight: 3, userLabelSize: 1,
    reprojNodeSize: 5, reprojEdgeWeight: 3,
};

const ctx = await launch({ port: Number(process.env.PORT || 8086), width: 2560, height: 1440, scale: 2 });
const { page } = ctx;
try {
    const loaded = await loadSession(page, { cams });
    await gotoFrame(page, FRAME);
    await setOverlayStyle(page, PRINT_STYLE);
    // Complete plotting skeleton for every tile, incl. the pre-tracking "before"
    // exports (display-only; see header note).
    const skelEdges = await setSkeletonEdges(page);
    // The session skeleton's node ORDER: `details[].points` rows are in this
    // order, and the panels' draw_pose_overlay assumes SLAP_NODES -- recorded so
    // the panel can verify instead of assuming.
    const skeletonNodes = await page.evaluate(() => {
        const s = window.__lucid.state.session;
        return s && s.skeleton ? [...s.skeleton.nodes] : null;
    });

    // ---- BEFORE: per-camera tracks -------------------------------------------
    await setColorMode(page, 'tracks');
    await setTimelineMode(page, 'tracks');
    const before = await exportViews(page, { cams, prefix: 'before', brightness: BRIGHT, overlay: false });
    await shootEl(page, '#timelineContainer', 'before-timeline');

    // ---- AFTER: cross-view identities ----------------------------------------
    const tracked = await trackAll(page, NANIMALS);
    // Colourblind-safe identity colours. The app's shipped IDENTITY_COLORS start
    // #00ff00, #ff00ff, #00ffff -- i.e. exactly the three identities in this frame --
    // and under deuteranopia the green and the magenta converge, so the two animals
    // the panel exists to tell apart become the same colour. AFTER trackAll: the
    // Identity constructor reads the palette once, at construction time.
    const palette = await setIdentityPalette(page);
    await clearOverlays(page);
    await gotoFrame(page, FRAME);
    await setColorMode(page, 'id');
    await setTimelineMode(page, 'identities');
    const after = await exportViews(page, { cams, prefix: 'after', brightness: BRIGHT, overlay: false });
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
    // Rig chrome OFF for this tile: it sits beside VIEW_CAM's own video tile and the
    // only thing being compared is the pose. From inside a camera the other frustums
    // are edge-on slivers that read as stray lines, and the reference grid (a bare
    // GridHelper at world Z=0, which on this rig floats ABOVE everything) can cut
    // across the animals.
    await set3dChrome(page, { labels: false, pyramids: false, spheres: false, grid: false });
    await shootEl(page, '#viewport3dContainer', 'tri3d-camview');

    // ---- 3D: the rig overview -------------------------------------------------
    // EXPORTED LANDSCAPE, FRAMED BY rigFit(), AND DELIBERATELY NOT HUGE. The previous
    // rig export was `showInitialView()` into whatever pane the camview tile had left
    // behind: 800x1696 PORTRAIT with the rig in ~19% of the frame, the ground-plane
    // grid and the axis gizmo taking most of the rest, and the right-hand camera
    // LABELS running off the edge of the canvas -- clipped in the source, so no crop
    // could recover them. Four separate causes, all of them in the export rather than
    // in the panel:
    //
    //   1. THE PANE ASPECT. `threeDWidth: 'match'` sizes the 3D pane to VIEW_CAM's
    //      aspect for the camview tile; the rig is a wide, flat shell and wants the
    //      opposite. RIG_W x RIG_H is 16:9, so the fit has room sideways instead of
    //      spending the frame on empty arena, and nothing runs off an edge.
    //   2. THE FRAMING. `showInitialView()` is the app's own fit to the scene BOUNDS
    //      and it also resets the up vector to +Z -- which on this rig is DOWN, so it
    //      renders the whole thing inverted, animals floating above the cameras.
    //      `rigFit()` takes "up" from the data and fits the real content on screen.
    //      It is still called first, because it is what clears the camera-view
    //      declutter that hides VIEW_CAM's own frustum (viewport3d.showInitialView).
    //   3. THE SIZE -- AND BIGGER IS WORSE HERE, which is counter-intuitive enough to
    //      be worth the paragraph. This tile is LINE ART: three.js draws the camera
    //      frustums with `LineBasicMaterial`, whose `linewidth` is ignored by every
    //      WebGL backend, so every frustum edge is exactly ONE DEVICE PIXEL wide no
    //      matter how large the canvas is. The printed weight of that line is
    //      therefore (tile width in mm) / (crop width in px) -- it gets THINNER as the
    //      export grows. A first re-staging at 4000x2560 put the crop at 3400 px for a
    //      ~48 mm tile: 71 px/mm, a 0.014 mm stroke, which came out as a barely-there
    //      grey smudge in the proof. At 1600x900 the crop is ~1270 px, 26 px/mm and a
    //      0.038 mm stroke -- the same apparent weight the old 800 px export had, and
    //      about the pixel density of the video tile beside it, while still carrying
    //      1.3x the linear resolution of the old crop on a tile 1.6x the area. The
    //      skeletons are unaffected either way (world-space spheres and tubes scale
    //      with the canvas); only the 1-px chrome cares. `sphereSize` is raised to 3
    //      so each camera also gets a solid dot -- real ink that survives print.
    //   4. THE LABELS. The app's camera labels are screen-space bitmaps at a FIXED
    //      pixel size, so they do not scale with the export either: enlarging the
    //      canvas makes them smaller relative to the rig, not bigger, and framing the
    //      rig tightly enough for them to be legible piles them on top of each other
    //      (at 800 px they already overlapped AND clipped). They are therefore OFF,
    //      and this tile carries geometry only -- how many cameras there are and where
    //      they sit. `rigFit()` returns every camera's projected pixel position, so a
    //      composer that wants names can typeset its own at the journal's size.
    await showInitialView(page);
    // Height too, which setLayout() does not take: the pane is stretched to the full
    // window height by the flex row, and 1280 px of it is what forced the portrait
    // aspect in the first place.
    await page.evaluate((h) => {
        document.getElementById('viewport3dContainer').style.height = h + 'px';
    }, RIG_H);
    const rigPane = await setLayout(page, { threeDWidth: RIG_W });
    await set3dChrome(page, {
        labels: false, pyramids: true, spheres: true, grid: false,
        pyramidLength: 22, sphereSize: 3,
    });
    const rig = await rigFit(page, {
        startCam: RIG_CAM, elevation: RIG_EL, pad: 1.04, targetBias: 0.10, fill: 0.88,
    });
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

    // The association ledger for this ONE frame, across ALL views. Three numbers
    // that are easy to conflate, so all three are written out and named:
    //
    //   detections       one per (camera, track) pair = every 2D instance in the
    //                    frame. This is the count of per-camera track LABELS the
    //                    reader is asked to reconcile, and the number the "no
    //                    cross-view correspondence" claim rests on.
    //   distinctNames    the same set collapsed by track NAME. Strictly smaller
    //                    whenever two cameras happen to have numbered unrelated
    //                    tracks the same (track_89 in cam0 and cam5 here) -- the
    //                    collisions are coincidence, and `track_127` even means a
    //                    DIFFERENT animal in cam1 than in cam4, so this number
    //                    must NOT be quoted as "labels to reconcile". Reported
    //                    only so the coincidence can be stated.
    //   assigned         detections that came out of Track All with an identity.
    //                    Less than `detections` when a view has more detections
    //                    than there are animals: the per-view assignment is
    //                    one-to-one, so a duplicate detection of an animal that is
    //                    already matched is deliberately left unassigned.
    const detKeys = new Set();
    for (const v of before) for (const d of v.details) if (d.track) detKeys.add(v.name + '/' + d.track);
    const distinctNames = new Set();
    for (const v of before) for (const d of v.details) if (d.track) distinctNames.add(d.track);
    const collidingNames = [...distinctNames].filter(
        n => before.filter(v => v.details.some(d => d.track === n)).length > 1);
    let assigned = 0, unassigned = [];
    for (const v of after) for (const d of v.details) {
        if (d.identity) assigned++;
        else unassigned.push({ camera: v.name, track: d.track, nVisible: d.nVisible });
    }
    // Identities are only "consistent across all N views" if every view really
    // carries every identity. Checked here rather than asserted in the caption.
    const idNames = [...new Set(after.flatMap(v => v.details.map(d => d.identity).filter(Boolean)))];
    const viewsMissingAnIdentity = after
        .filter(v => idNames.some(id => !v.details.some(d => d.identity === id)))
        .map(v => v.name);

    const ledger = {
        detections: detKeys.size,
        distinctNames: distinctNames.size,
        collidingNames,
        identities: idNames.length,
        assigned,
        unassigned,
        viewsMissingAnIdentity,
    };

    writeManifest('fig1', {
        session: loaded, frame: FRAME, nAnimals: NANIMALS, viewCam: VIEW_CAM,
        brightness: BRIGHT, overlayStyle: PRINT_STYLE, cameras: cams,
        tracked, triangulated: tri, stats, ledger, identityPalette: palette,
        skeletonEdges: skelEdges,
        skeletonNodes,
        distinctTrackLabels: detKeys.size, distinctTrackNames: distinctNames.size,
        before, after,
        timelines: { before: 'before-timeline.png', after: 'after-timeline.png' },
        threeD: {
            camview: 'tri3d-camview.png', rig: 'tri3d-rig.png',
            rigPane: rigPane.threeD, rigFraming: rig,
        },
    });

    log(`[summary] frame ${FRAME}: ${detKeys.size} detections / per-camera track ` +
        `labels across ${cams.length} views (${distinctNames.size} distinct names; ` +
        `${collidingNames.length} name(s) reused by >1 camera) -> ` +
        `${tracked.identities} identities, ${assigned} assigned, ` +
        `${unassigned.length} unassigned [` +
        unassigned.map(u => `${u.camera}/${u.track}`).join(', ') + `]; ` +
        `views missing an identity: ${viewsMissingAnIdentity.length}; ` +
        `${tri.with3d}/${tri.groups} groups with 3D`);
} finally {
    await done(ctx);
}
