/**
 * Fig 6a frame probe (investigation tool, not a deposit): render the
 * animals-framed 3D viewport shot at several candidate frames so Eric can
 * pick one whose triangulated proportions look right (frame 120's cyan
 * animal reads stretched with the complete skeleton). Same setup as
 * fig6_app.mjs (skeleton override, trackAll/triangulateAll, Okabe-Ito
 * recolor, frame3d azim 40 / elev 22 / pad 2.4), labels-only (no videos).
 *
 * Usage: SESSION_REL=figs/session-slap-10072022145420 node figs/_probe_fig6a_frames.mjs
 *        (env FRAMES=20,50,... to override candidates)
 * Writes figs/out/fig6probe-f<frame>.png
 */
import {
    launch, loadSession, gotoFrame, trackAll, triangulateAll, setColorMode,
    setLayout, hide3dButtons, frame3d, set3dChrome, clearOverlays, shootEl,
    setSkeletonEdges, setOverlayStyle, done, log,
} from './_drive.mjs';

const NANIMALS = Number(process.env.NANIMALS || 4);
const CAMS6 = (process.env.CAMS || 'back,backL,mid,midL,top,topL').split(',');
const FRAMES = (process.env.FRAMES || '20,50,80,110,140,170,200,230')
    .split(',').map(Number);
const PALETTE = '#E69F00,#009E73,#CC79A7,#56B4E9'.split(',');

async function recolorIdentities(page, pal) {
    await page.evaluate(async (colors) => {
        const st = window.__lucid.state;
        const ids = (st.session && st.session.identities) || [];
        [...ids].sort((a, b) => a.id - b.id)
            .forEach((idObj, i) => { idObj.color = colors[i % colors.length]; });
        const r = await import('/ui/rendering.js');
        const init = await import('/pose/initialization.js');
        r.drawAllOverlays(st.currentFrame);
        init.update3DViewport(st.currentFrame);
    }, pal);
    await page.waitForTimeout(300);
}

const ctx = await launch({ port: Number(process.env.PORT || 8093), width: 2560, height: 1440, scale: 2 });
const { page } = ctx;
try {
    await loadSession(page, { cams: CAMS6, deferVideos: false });
    await setSkeletonEdges(page);
    await setColorMode(page, 'id');
    await trackAll(page, NANIMALS);
    await triangulateAll(page);
    await clearOverlays(page);
    await recolorIdentities(page, PALETTE);
    await hide3dButtons(page, true);
    await setLayout(page, { hideInfoPanel: true, timelineHeight: 0, threeDWidth: 1600 });
    await set3dChrome(page, { labels: false, pyramids: false, spheres: false, grid: false });
    for (const f of FRAMES) {
        await gotoFrame(page, f);
        await frame3d(page, { azimuth: 40, elevation: 22, pad: 2.4 });
        await shootEl(page, '#viewport3dContainer', `fig6probe-f${f}`);
        log(`probe frame ${f} done`);
    }
} finally {
    await done(ctx);
}
