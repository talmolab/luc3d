#!/usr/bin/env node
/**
 * Fig 1d's 3D pose, exported as NUMBERS instead of pixels.
 *
 * The Blender re-render of Fig 1d's two 3D tiles (fig1_hardfight_scene.py ->
 * blender-images/fig1d_scene.py) needs the app's OWN reconstruction at the
 * panel's frame -- the same trackAll + triangulateAll the video-tile overlays
 * come from, with each animal tagged by the same identity (and identity
 * COLOUR) the overlays are drawn in. Re-triangulating offline with
 * blender-images/hardfight_common.py would be a slightly DIFFERENT pose (its
 * association and view-rejection rules are not the app's), and its animals
 * arrive in reference-view instance order with no link to the app's id_0/1/2 --
 * the Blender mice could silently swap colours against the video tile.
 * Exporting the app's own instance groups makes colour-vs-video agreement true
 * by construction.
 *
 * Runs the exact pipeline prefix of fig1_tracking.mjs (load figs/session,
 * trackAll, triangulateAll, setIdentityPalette) and dumps, for FRAME:
 * per-group { identityId, name, color, points3d (N x 3, calib-world mm,
 * NaN -> null) } plus the skeleton's node names. The 3D is in the CALIBRATION
 * frame (+Z down on this rig); fig1_hardfight_scene.py carries it into the
 * floor-aligned frame with the same cached alignment every HardFight figure
 * uses (blender-images/renders/hardfight_alignment.json).
 *
 * Usage: node figs/fig1d_pose_export.mjs     (env: PORT, FRAME, NANIMALS)
 * Writes: figs/out/fig1d_pose.json
 */
import {
    launch, loadSession, trackAll, triangulateAll,
    setIdentityPalette, writeManifest, done, log,
} from './_drive.mjs';

const FRAME = Number(process.env.FRAME || 198);
const NANIMALS = Number(process.env.NANIMALS || 3);
const PORT = Number(process.env.PORT || 8093);

const ctx = await launch({ port: PORT });
const { page } = ctx;
try {
    // deferVideos: tracking and triangulation read only the .slp detections and
    // the calibration; no pixel is needed, and skipping the 8 videos makes this
    // a seconds-long run (state.totalFrames stays 0, so no gotoFrame either).
    const session = await loadSession(page, { deferVideos: true });
    const tracked = await trackAll(page, NANIMALS);
    const tri = await triangulateAll(page);
    // AFTER trackAll, exactly as fig1_tracking.mjs orders it (Identity reads the
    // palette at construction; the helper rewrites existing identities' .color)
    const palette = await setIdentityPalette(page);

    const pose = await page.evaluate((f) => {
        const s = window.__lucid.state.session;
        const groups = [];
        for (const g of (s.instanceGroups.get(f) || [])) {
            if (!g.points3d) continue;
            const p = g.points3d;   // flat Float64Array(3N) since luc3d #189
            const pts = [];
            for (let i = 0; i + 2 < p.length; i += 3) {
                const ok = Number.isFinite(p[i]) && Number.isFinite(p[i + 1])
                    && Number.isFinite(p[i + 2]);
                pts.push(ok ? [p[i], p[i + 1], p[i + 2]] : null);
            }
            const id = s.getIdentity(g.identityId);
            groups.push({
                identityId: g.identityId,
                name: id ? id.name : null,
                color: id ? id.color : null,
                nCameras: g.instances.size,
                points3d: pts,
            });
        }
        groups.sort((a, b) => a.identityId - b.identityId);
        return { nodes: s.skeleton.nodes.slice(), groups };
    }, FRAME);

    for (const g of pose.groups) {
        const n = g.points3d.filter(Boolean).length;
        log(`  ${g.name} ${g.color}: ${n}/${pose.nodes.length} nodes, `
            + `${g.nCameras} cameras`);
    }
    writeManifest('fig1d_pose.json', {
        session, frame: FRAME, nAnimals: NANIMALS,
        tracked, triangulated: tri, identityPalette: palette,
        coordinateFrame: 'calib-world mm (+Z down on this rig); align with '
            + 'blender-images/renders/hardfight_alignment.json',
        ...pose,
    });
} finally {
    await done(ctx);
}
