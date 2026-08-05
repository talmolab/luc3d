/**
 * Smoke probe: does the trimmed session load with video into the real app?
 *
 * DOCS/DEBUG ONLY, NOT A FIGURE SOURCE. Its one screenshot is written as
 * `gui-probe-full.png` so no `figs/panels/*.py` can mistake it for a panel
 * source: the sibling `fig1_gui.mjs` used to write `fig1b-*.png` and
 * `panels/fig1_03_reconstruction.py` silently read two of those stale
 * pre-`setIdentityPalette()` files for weeks, shipping Fig 1c in a different
 * identity palette from Fig 1b (a BLOCKER review finding). Panel sources come
 * from `fig1_tracking.mjs` / `fig2_protocol.mjs` / `fig5_panel_a.mjs` /
 * `fig6_app.mjs` only. Keep the `gui-` prefix.
 */
import { launch, loadSession, gotoFrame, shoot, done } from './_drive.mjs';

const ctx = await launch({ port: Number(process.env.PORT || 8086) });
try {
    const res = await loadSession(ctx.page);
    await gotoFrame(ctx.page, 40);
    const info = await ctx.page.evaluate(() => {
        const s = window.__lucid.state.session;
        const views = window.__lucid.state.views || [];
        let groups = 0, with3d = 0;
        if (s && s.instanceGroups) for (const [, gs] of s.instanceGroups) for (const g of gs) { groups++; if (g.points3d) with3d++; }
        const fg = s && s.frameGroups && s.frameGroups.get(window.__lucid.state.currentFrame);
        return {
            frame: window.__lucid.state.currentFrame,
            views: views.length,
            viewCanvases: views.map(v => v && v.canvas ? `${v.canvas.width}x${v.canvas.height}` : null),
            instancesThisFrame: fg ? fg.instances.length : null,
            groups, with3d,
            tracks: s ? s.tracks.length : 0,
            identities: s && s.identities ? s.identities.length : 0,
            totalFrames: window.__lucid.state.totalFrames,
        };
    });
    console.log('[probe]', JSON.stringify(info, null, 2));
    await shoot(ctx.page, 'gui-probe-full');
} finally {
    await done(ctx);
}
