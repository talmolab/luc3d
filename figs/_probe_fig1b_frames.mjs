/**
 * Fig 1b/c frame probe (investigation tool, not a deposit). Frame 276 was
 * chosen by the completeness scan (every camera exactly 3 detections, all
 * assigned) but its third animal (id 3, reared on the near wall) reads as a
 * jumble with the complete skeleton. This probe RELAXES the criterion —
 * no view with MORE than NANIMALS detections (no surplus '?'), both figure
 * cameras (Camera0_mid, Camera7_sideR) with exactly 3 assigned, >=13/15
 * nodes each — then RANKS candidates by 3D pose sanity (max pairwise node
 * distance per animal vs the session median: jumbled/stretched frames score
 * high) and exports the after-tracking tiles for the best K frames.
 *
 * Usage: node figs/_probe_fig1b_frames.mjs      (env: K=6, PORT)
 * Writes figs/out/fig1probe-f<frame>-<cam>.png + prints the ranking.
 */
import {
    launch, loadSession, gotoFrame, trackAll, triangulateAll, setColorMode,
    setOverlayStyle, setIdentityPalette, setSkeletonEdges, exportViews,
    clearOverlays, done, log, CAMS,
} from './_drive.mjs';

const NANIMALS = 3;
const FIG_CAMS = ['Camera0_mid', 'Camera7_sideR'];
const K = Number(process.env.K || 6);
const PRINT_STYLE = {
    predNodeSize: 5, predEdgeWeight: 3,
    userNodeSize: 5, userEdgeWeight: 3, userLabelSize: 1,
    reprojNodeSize: 5, reprojEdgeWeight: 3,
};

const ctx = await launch({ port: Number(process.env.PORT || 8094), width: 2560, height: 1440, scale: 2 });
const { page } = ctx;
try {
    await loadSession(page, { cams: CAMS });
    await setOverlayStyle(page, PRINT_STYLE);
    await setSkeletonEdges(page);
    await trackAll(page, NANIMALS);
    await triangulateAll(page);
    await setColorMode(page, 'id');

    const RELAXED = process.env.RELAX === '1';
    const ranking = await page.evaluate(({ figCams, nAnimals, RELAX }) => {
        const s = window.__lucid.state.session;
        const nFrames = 300;
        const perFrame = [];
        // per-animal median body extent for normalization
        const extents = new Map();          // identityId -> [maxdist per frame]
        const frameInfo = [];
        for (let f = 0; f < nFrames; f++) {
            const groups = s.instanceGroups.get(f) || [];
            const fg = s.frameGroups.get(f);
            if (!fg) { frameInfo.push(null); continue; }
            // surplus check: no camera with more than nAnimals detections
            let surplus = false;
            fg.instances.forEach((list, cam) => {
                const n = Array.isArray(list) ? list.length : list.size;
                if (n > nAnimals) surplus = true;
            });
            // figure cams: exactly nAnimals detections, all assigned
            const camCount = {};
            const camAssigned = {};
            const assigned = new Set();
            for (const g of groups) {
                if (g.identityId == null) continue;
                g.instances.forEach((inst, cam) => {
                    camAssigned[cam] = (camAssigned[cam] || 0) + 1;
                });
            }
            fg.instances.forEach((list, cam) => {
                const arr = Array.isArray(list) ? list : [...list.values()];
                camCount[cam] = arr.length;
            });
            const figOK = figCams.every(c => camCount[c] === nAnimals
                                          && camAssigned[c] === nAnimals);
            // 3D sanity per group
            const dists = [];
            let nodesOK = true;
            for (const g of groups) {
                if (g.identityId == null || !g.points3d) continue;
                const pts = [];
                const P = g.points3d;
                const n = P.length / 3 | 0;
                for (let k = 0; k < n; k++) {
                    const x = P[3 * k], y = P[3 * k + 1], z = P[3 * k + 2];
                    if (Number.isFinite(x)) pts.push([x, y, z]);
                }
                if (pts.length < 13) nodesOK = false;
                let m = 0;
                for (let i = 0; i < pts.length; i++)
                    for (let j = i + 1; j < pts.length; j++) {
                        const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]);
                        if (d > m) m = d;
                    }
                dists.push(m);
                if (!extents.has(g.identityId)) extents.set(g.identityId, []);
                extents.get(g.identityId).push(m);
            }
            frameInfo.push({ f, surplus, figOK, nodesOK, dists,
                             nGroups: groups.filter(g => g.identityId != null).length });
        }
        // median extent across all groups/frames
        const all = [];
        extents.forEach(v => all.push(...v));
        all.sort((a, b) => a - b);
        const med = all[all.length >> 1] || 1;
        const out = [];
        for (const fi of frameInfo) {
            if (!fi || !fi.figOK || !fi.nodesOK) continue;
            // surplus allowed in NON-figure cameras when RELAX=1 (ledger will say '1 unassigned')
            if (fi.surplus && !RELAX) continue;
            if (fi.nGroups !== nAnimals) continue;
            const worst = Math.max(...fi.dists.map(d => d / med));
            out.push({ frame: fi.f, worstExtent: +worst.toFixed(3), surplus: fi.surplus });
        }
        out.sort((a, b) => a.worstExtent - b.worstExtent);
        return { medianExtent: med, candidates: out };
    }, { figCams: FIG_CAMS, nAnimals: NANIMALS, RELAX: RELAXED });

    log(`median 3D extent ${ranking.medianExtent.toFixed(1)}mm; ` +
        `${ranking.candidates.length} candidate frames`);
    log('best: ' + JSON.stringify(ranking.candidates.slice(0, 12)));
    const picks = ranking.candidates.slice(0, K).map(c => c.frame);
    for (const f of picks) {
        await clearOverlays(page);
        await gotoFrame(page, f);
        await exportViews(page, { cams: FIG_CAMS, prefix: `fig1probe-f${f}`, brightness: 1.9 });
        log(`probe exported frame ${f}`);
    }
} finally {
    await done(ctx);
}
