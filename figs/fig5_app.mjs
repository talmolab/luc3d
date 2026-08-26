/**
 * Fig 6 — app panels: the rig as LUC3D actually renders it, and multi-camera frames
 * with real instance overlays.
 *
 * Runs on a SLAP-2M session built by figs/fig5_session.py. Two states:
 *
 *   fig6-rig.png        the 3D viewport with every camera frustum, framed UPRIGHT --
 *                       overhead cameras at the top of the frame, side cameras at the
 *                       side, animals below. `rigFit()` takes "up" from the data
 *                       rather than assuming +Z, because this rig family's calibration
 *                       frame has +Z pointing DOWN; assuming Z-up renders the whole
 *                       rig inverted.
 *   fig6-view-*.png     each camera's video + overlay at native resolution, with the
 *                       proofread instances drawn, plus a manifest of where every
 *                       animal is and what colour the app drew it.
 *
 * Videos are optional: with VIDEOS=0 the session loads labels + calibration only,
 * which is all the 3D viewport needs, and the per-view export is skipped.
 *
 * The skeleton EDGE SET is overridden to the complete 26-edge plotting skeleton
 * (setSkeletonEdges / MOUSE_EDGES, from src/skeleton_style.py) before any export
 * (Eric 2026-08-16): the session's own sparse edge list reads as spiky lines
 * rather than a mouse at print size. Display-only -- nothing on the tracking or
 * triangulation path reads skeleton.edges, and the manifest's numbers (scale,
 * bodyMm, counts) were diff-verified unchanged against the pre-override run.
 *
 * Three things this records that the layout script cannot derive on its own:
 *
 *   PALETTE       the app's stock identity colours are pure #00ff00 / #00ffff /
 *                 #ff00ff, which collapse into one another under deuteranopia. The
 *                 identities' own `.color` is what `getGroupColor()` reads, so
 *                 reassigning it from the Okabe-Ito set and redrawing makes the app
 *                 draw the figure's overlays colourblind-safe -- in the 2D panes AND
 *                 in the 3D viewport, which share that lookup.
 *   scale         millimetres-per-pixel for each view AT THE ANIMALS' DEPTH, computed
 *                 with the app's own `reprojectPointCamera()` (so the real distortion
 *                 model is applied): project the animals' 3D centroid displaced
 *                 +/-L/2 along two directions perpendicular to that camera's viewing
 *                 ray and measure the pixel separation. Perspective means this is a
 *                 local scale, exact only in the fronto-parallel plane through the
 *                 animals -- which is what a scale bar on a perspective image means.
 *                 `noseToTrunkMm` is carried alongside as the units check: if the
 *                 calibration were not in millimetres this comes out nothing like a
 *                 mouse.
 *   contentBBox   the non-background bounding box of each 3D render, so the layout can
 *                 crop the viewport's empty black field instead of printing it.
 *
 * Usage:
 *   SESSION_REL=figs/session-slap-<id> node figs/fig5_app.mjs
 *   SESSION_REL=... VIDEOS=0 node figs/fig5_app.mjs      # rig panel only
 */
import {
    launch, loadSession, gotoFrame, trackAll, triangulateAll, setColorMode,
    setOverlayStyle, setLayout, set3dChrome, hide3dButtons, rigFit, frame3d,
    shootEl, exportViews, clearOverlays, writeManifest, done, log, setSkeletonEdges,
} from './_drive.mjs';

// FRAME 20 since 2026-08-16 (Eric): picked from an 8-frame probe sheet
// (_probe_fig6a_frames.mjs) — at 120 the magnified 3D group's proportions read
// stretched; at 20 all four animals are distinct and plausibly proportioned.
const FRAME = Number(process.env.FRAME || 20);
const NANIMALS = Number(process.env.NANIMALS || 4);
// 1.9 is the display gain the other figure scripts use on these dark IR frames (see
// figs/README.md). At 1.0 the two DARK animals in this session are invisible, so the
// tile reads as "labels on empty bedding" -- which is a rendering choice, not the data.
const BRIGHT = Number(process.env.BRIGHT || 1.9);
const WITH_VIDEO = process.env.VIDEOS !== '0';
const CAMS6 = (process.env.CAMS || 'back,backL,mid,midL,top,topL').split(',');
const TAG = process.env.TAG || 'fig6';

const PRINT_STYLE = {
    predNodeSize: 5, predEdgeWeight: 3,
    // 1, NOT 0: the identity pills over predicted instances are drawn with
    // `labelSize: (userOpts && userOpts.labelSize) || 11` (ui/overlays.js), and `0 ||
    // 11` is 11 -- so asking for 0 gets the DEFAULT size, which is how "id_0"/"id_2"
    // pills ended up printed on the tiles. 1 px * displayScale is sub-pixel at print.
    userNodeSize: 5, userEdgeWeight: 3, userLabelSize: 1,
    // 0 hides the reprojections' "id_N" text. At print size those labels are ~3 pt
    // of unreadable type sitting on the animals -- text on an image tile, which the
    // journal's own conventions rule out.
    reprojNodeSize: 5, reprojEdgeWeight: 3, reprojLabelSize: 0,
};

// TAB10, PERMUTED TO AGREE WITH THE BLENDER RENDERS (Eric, 2026-08-19: Fig 6a's
// camera-view inset must carry the same colour per animal as the cage tile it is
// expanded from). The renders paint H5 track k with tab10[k]; the h5 track order and
// this app's identity order do NOT agree, and the measured mapping is track 0 -> id_3,
// 1 -> id_2, 2 -> id_0, 3 -> id_1 (blender-images/enrichment_scene.TRACK_TO_IDENTITY,
// with how it was derived). Inverting it, id_0..id_3 take tab10 entries 2, 3, 1, 0 --
// which is the order below. VERIFIED after export by projecting each h5 track into all
// six views and reading the painted colour: 100% agreement on all four animals.
// KEEP IN STEP with enrichment_scene.COMBOS[(4,0)]'s frame; re-derive if either moves.
//
// This replaced an Okabe-Ito set chosen for deuteranopia separability and luminance on
// dark IR frames. That property is lost here: tab10's green (#2CA02C) and red
// (#D62728) converge under deuteranopia, and its blue is darker against black bedding.
// The identities are also labelled by number in the app's own overlays, so colour is
// not the only cue -- but do not describe this panel's colours as colourblind-safe.
const PALETTE = (process.env.PALETTE
    || '#2CA02C,#D62728,#FF7F0E,#1F77B4,#9467BD,#8C564B,#E377C2').split(',');

/** Repaint every identity from `pal` and redraw, in 2D and in the 3D viewport. */
async function recolorIdentities(page, pal) {
    const got = await page.evaluate(async (colors) => {
        const st = window.__lucid.state;
        const s = st.session;
        const ids = (s && s.identities) || [];
        // Sort by id so the assignment is deterministic across runs, not dependent on
        // the order the tracker happened to create identities in.
        const order = [...ids].sort((a, b) => a.id - b.id);
        order.forEach((idObj, i) => { idObj.color = colors[i % colors.length]; });
        const r = await import('/ui/rendering.js');
        const init = await import('/pose/initialization.js');
        r.drawAllOverlays(st.currentFrame);
        init.update3DViewport(st.currentFrame);
        return order.map(o => ({ name: o.name, color: o.color }));
    }, pal);
    await page.waitForTimeout(400);
    log('[palette] ' + JSON.stringify(got));
    return got;
}

/**
 * Millimetres per pixel at the animals' depth, per view, via the app's own projection.
 *
 * Also returns body-length distributions over EVERY triangulated pose in the session:
 * the units check. A scale bar is only meaningful if the calibration's length unit
 * really is the millimetre, and nothing in the calibration file says so -- but the
 * reconstruction itself settles it, because an adult mouse is ~160 mm nose to tail tip
 * with a ~95 mm tail. (Do not use one frame: with four animals in a crowded arena a
 * single frame's median is four numbers and one bad triangulation moves it.)
 *
 * `projCentroidPx` is the depth check: it must land on the mean of the 2D animal
 * centroids `exportViews()` records for the same view, or the depth -- and therefore
 * the scale -- is wrong.
 */
async function measureScale(page, cams, L) {
    const res = await page.evaluate(async ({ cams, L }) => {
        const tri = await import('/pose/triangulation.js');
        const st = window.__lucid.state;
        const s = st.session;
        const nodeName = (s.skeleton && s.skeleton.nodes) || [];
        const get = (p, i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
        const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        const pairs = [['Nose', 'TailTip'], ['TTI', 'TailTip'], ['Nose', 'TTI']];
        const spans = pairs.map(() => []);
        // Largest distance between any two keypoints of one animal: the animal's own
        // extent, and the ONLY body-size statistic that does not depend on the node
        // ORDER agreeing between two files. It does not: this session's per-camera .slp
        // and figs/out/fig6.json list the same 15 nodes in different orders, so a
        // named-pair length computed with the wrong list is meaningless (and looks
        // plausible often enough to fool you). Extent is order-invariant.
        const extent = [];
        for (const [, gs] of s.instanceGroups) {
            for (const g of gs) {
                if (!g.points3d) continue;
                pairs.forEach(([na, nb], k) => {
                    const ia = nodeName.indexOf(na), ib = nodeName.indexOf(nb);
                    if (ia < 0 || ib < 0) return;
                    const a = get(g.points3d, ia), b = get(g.points3d, ib);
                    if (a.every(Number.isFinite) && b.every(Number.isFinite)) {
                        spans[k].push(dist(a, b));
                    }
                });
                const P = [];
                for (let i = 0; i < g.points3d.length / 3; i++) {
                    const p = get(g.points3d, i);
                    if (p.every(Number.isFinite)) P.push(p);
                }
                if (P.length >= 10) {
                    let mx = 0;
                    for (let i = 0; i < P.length; i++) {
                        for (let j = i + 1; j < P.length; j++) mx = Math.max(mx, dist(P[i], P[j]));
                    }
                    extent.push(mx);
                }
            }
        }
        const pct = (v, q) => {
            if (!v.length) return null;
            const s2 = [...v].sort((p, r) => p - r);
            return +s2[Math.min(s2.length - 1, Math.floor(q * s2.length))].toFixed(1);
        };
        const med = (v) => pct(v, 0.5);
        const bodyMm = {};
        pairs.forEach(([a, b], k) => { bodyMm[`${a}-${b}`] = { median: med(spans[k]), n: spans[k].length }; });
        bodyMm.animalExtent = { n: extent.length, p10: pct(extent, 0.10),
                                median: med(extent), p90: pct(extent, 0.90) };

        // centroid of every finite 3D keypoint in THIS frame -- the depth the scale
        // bar is exact at
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const g of (s.instanceGroups.get(st.currentFrame) || [])) {
            if (!g.points3d) continue;
            const p = g.points3d;
            for (let i = 0; i < p.length / 3; i++) {
                const [x, y, z] = get(p, i);
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
                sx += x; sy += y; sz += z; n++;
            }
        }
        if (!n) return null;
        const C = [sx / n, sy / n, sz / n];
        const nrm = (v) => { const m = Math.hypot(...v); return v.map(q => q / m); };
        const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
                                 a[0] * b[1] - a[1] * b[0]];
        const per = {};
        for (const name of cams) {
            const cam = s.cameras.find(c => c.name === name);
            if (!cam) continue;
            const R = cam.rotationMatrix, t = cam.tvec;
            // camera centre = -R^T t
            const Cc = [0, 1, 2].map(i => -(R[0][i] * t[0] + R[1][i] * t[1] + R[2][i] * t[2]));
            const ray = nrm([C[0] - Cc[0], C[1] - Cc[1], C[2] - Cc[2]]);
            // two directions perpendicular to the ray: the image plane's own axes,
            // i.e. the camera's x and y rows rejected onto the plane normal to `ray`
            const seed = Math.abs(ray[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
            const e1 = nrm(cross(ray, seed));
            const e2 = nrm(cross(ray, e1));
            const dists = [e1, e2].map((e) => {
                const a = tri.reprojectPointCamera(C.map((v, i) => v - e[i] * L / 2), cam);
                const b = tri.reprojectPointCamera(C.map((v, i) => v + e[i] * L / 2), cam);
                return Math.hypot(a[0] - b[0], a[1] - b[1]);
            });
            const pc = tri.reprojectPointCamera(C, cam);
            per[name] = {
                pxPerUnit: (dists[0] + dists[1]) / 2 / L,
                anisotropy: +(Math.abs(dists[0] - dists[1])
                              / ((dists[0] + dists[1]) / 2)).toFixed(4),
                projCentroidPx: pc.map(v => +v.toFixed(1)),
            };
        }
        return { L, centroid3d: C.map(v => +v.toFixed(1)), nKeypoints3d: n,
                 bodyMm, perView: per };
    }, { cams, L });
    if (res) {
        log('[scale] units check (median over all triangulated poses): '
            + Object.entries(res.bodyMm).map(([k, v]) => `${k} ${v.median} (n=${v.n})`).join(', '));
        log(`[scale] px per unit at the animals: `
            + Object.entries(res.perView).map(([k, v]) => `${k} ${v.pxPerUnit.toFixed(3)}`).join(', '));
    } else {
        log('[scale] no 3D in this frame -- skipped');
    }
    return res;
}

/**
 * Bounding box of the non-background pixels of a PNG, in source pixels.
 * Decoded in the page (a browser is the one PNG decoder we are guaranteed to have).
 */
async function contentBBox(page, file, tol = 30, margin = 12) {
    const bb = await page.evaluate(async ({ url, tol, margin }) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        // The pane draws a 2 px light border, so the outermost columns are NOT
        // background -- sample inside the margin, and scan inside it too, or the box
        // comes back as the whole image (which is how this was first written).
        const at = (x, y) => 4 * (y * c.width + x);
        const b0 = at(margin + 2, margin + 2);
        const b = [d[b0], d[b0 + 1], d[b0 + 2]];
        let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
        for (let y = margin; y < c.height - margin; y++) {
            for (let x = margin; x < c.width - margin; x++) {
                const i = at(x, y);
                if (Math.abs(d[i] - b[0]) <= tol && Math.abs(d[i + 1] - b[1]) <= tol
                    && Math.abs(d[i + 2] - b[2]) <= tol) continue;
                if (x < x0) x0 = x;
                if (y < y0) y0 = y;
                if (x > x1) x1 = x;
                if (y > y1) y1 = y;
            }
        }
        return x1 < 0 ? null : { x0, y0, x1, y1, width: c.width, height: c.height,
                                 bg: b, tol, margin };
    }, { url: `/figs/out/${file}`, tol, margin });
    log(`[bbox] ${file} ${JSON.stringify(bb)}`);
    return bb;
}

const ctx = await launch({ port: Number(process.env.PORT || 8089), width: 2560, height: 1440, scale: 2 });
const { page } = ctx;
try {
    const loaded = await loadSession(page, { cams: CAMS6, deferVideos: !WITH_VIDEO });
    await gotoFrame(page, FRAME);
    await setOverlayStyle(page, PRINT_STYLE);
    // Complete plotting skeleton for every tile (display-only; see header note).
    const skelEdges = await setSkeletonEdges(page);
    await setColorMode(page, 'id');

    // The proofread labels already carry per-camera identity, but the app's 3D needs
    // instance GROUPS, which Track All builds. On proofread input this is close to a
    // no-op for correctness and is the same call the app's own button makes.
    const tracked = await trackAll(page, NANIMALS);
    const tri = await triangulateAll(page);
    await clearOverlays(page);
    await gotoFrame(page, FRAME);
    await setColorMode(page, 'id');
    const palette = await recolorIdentities(page, PALETTE);
    const scale = await measureScale(page, CAMS6, Number(process.env.SCALE_L || 50));

    // ---- the rig, upright ----------------------------------------------------
    await hide3dButtons(page, true);
    await setLayout(page, { hideInfoPanel: true, timelineHeight: 0, threeDWidth: 1600 });
    await set3dChrome(page, {
        labels: false, pyramids: true, spheres: true, grid: false,
        pyramidLength: Number(process.env.PYR || 26), sphereSize: 2,
    });
    const rig = await rigFit(page, {
        startCam: process.env.STARTCAM || CAMS6[CAMS6.length - 1],
        elevation: Number(process.env.ELEV || 18),
        pad: 1.04, targetBias: 0.10, fill: 0.88,
    });
    await shootEl(page, '#viewport3dContainer', `${TAG}-rig`);
    const rigBBox = await contentBBox(page, `${TAG}-rig.png`);

    // and a shot framed on the animals, where the 3D pose is legible at print size.
    // Camera frustums OFF for this one: the layout crops it to its non-background box,
    // and with pyramids on that box swallows the rig's lower cameras, so a third of the
    // print area goes to frustums that panel a already shows.
    await set3dChrome(page, { pyramids: false, spheres: false });
    const near = await frame3d(page, { azimuth: 40, elevation: 22, pad: 2.4 });
    await shootEl(page, '#viewport3dContainer', `${TAG}-3d-animals`);
    const animalsBBox = await contentBBox(page, `${TAG}-3d-animals.png`);
    await hide3dButtons(page, false);

    // ---- per-camera frames with overlays ------------------------------------
    let views = null;
    if (WITH_VIDEO) {
        await setLayout(page, { hideInfoPanel: true, timelineHeight: 0, threeDWidth: 400 });
        await gotoFrame(page, FRAME);
        views = await exportViews(page, { cams: CAMS6, prefix: `${TAG}-view`, brightness: BRIGHT });
    } else {
        log('[views] skipped (VIDEOS=0)');
    }

    writeManifest(`${TAG}-app`, {
        session: loaded, sessionRel: process.env.SESSION_REL || 'figs/session',
        frame: FRAME, nAnimals: NANIMALS, cameras: CAMS6, brightness: BRIGHT,
        overlayStyle: PRINT_STYLE, tracked, triangulated: tri,
        palette, scale, skeletonEdges: skelEdges,
        threeD: { rig: `${TAG}-rig.png`, framing: rig, rigBBox,
                  animals: `${TAG}-3d-animals.png`, animalsFraming: near,
                  animalsBBox },
        views,
    });
    log(`[summary] ${tri.with3d}/${tri.groups} groups with 3D; ` +
        `${tracked.identities} identities; rig zsign ${rig && rig.zsign}`);
} finally {
    await done(ctx);
}
