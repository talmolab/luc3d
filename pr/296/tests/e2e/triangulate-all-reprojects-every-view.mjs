/**
 * triangulate-all-reprojects-every-view.mjs — after any triangulation, a
 * group's reprojection is drawn in EVERY camera, including one where that
 * animal has no 2D instance on the frame.
 *
 * ## The bug
 * Seen on a real 3-mouse, 8-camera recording: after Triangulate All ▸ Refined,
 * one mouse's reprojection vanished from Camera6_sideL on a frame where it was
 * hidden behind another mouse, and another's from Camera3_mid. Neither camera
 * had a detection of that mouse, so neither group had an instance there. Right
 * after Track All, both reprojections WERE drawn.
 *
 * The bulk sweeps solve each group from the cameras it has instances in
 * (`groupCameras`), and `triangulateAndReproject` returns reprojections for the
 * cameras it is given. Three sweeps stored that member-only result:
 *   * `triangulateAllFrames`' in-memory path — the one a project takes when it
 *     is not windowed, and the one the report came from;
 *   * `triangulateMultiFrameInstances`;
 *   * Tracks ▸ Group by Track (`ui/export-modals.js`).
 * `ui/rendering.js`'s lazy fill only fills a group whose reprojections are
 * EMPTY, so it never added the missing camera. Single-frame Triangulate
 * (`storeReprojectedInstances`) and the windowed Triangulate All (the lazy fill
 * with every session camera) always covered every camera, so the result
 * depended on which path ran.
 *
 * ## What this pins
 * On a frame where `Blue` has no instance in `camC`, every path draws Blue's
 * reprojection in camC, at the same pixels as single-frame Triangulate — read
 * from a REAL overlay canvas, not just from the data. The added reprojection
 * must not change the error numbers either: a camera with no instance has
 * nothing to measure against.
 *
 * Confirmed to fail on the pre-fix build: phases A, B and C draw nothing in
 * camC, while the reference and phase D pass.
 *
 * None of the three sweeps stores reprojections any more — they keep only the
 * 3D, and the display derives every camera's reprojection and the per-camera
 * errors from it when a frame is shown (`ui/rendering.js`'s reprojection fill;
 * see `tests/e2e/triangulate-all-bounded-derived-state.mjs` and
 * `tests/e2e/bulk-triangulation-bounded-derived-state.mjs`). So each phase
 * draws frame 0 (`drawAllOverlays(0)`) before reading the group, as the app
 * does after every sweep, and the checks are on what that draw produces.
 *
 * Fixture: `fixtures/ba-rig-fixture.js` (3 cameras with real k1 distortion,
 * 2 animals). Read its header before editing the geometry.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8301);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

  const out = await page.evaluate(async () => {
    const AS = await import('/ui/app-state.js');
    const TRI = await import('/pose/triangulation.js');
    const RND = await import('/ui/rendering.js');
    const OV = await import('/ui/overlays.js');
    const EM = await import('/ui/export-modals.js');
    const SET = await import('/ui/settings.js');
    const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
    const F = await buildBaRigFixture();
    const MISSING_CAM = 'camC', MISSING_TRACK = 1;   // Blue is absent from camC on frame 0

    const boot = (session) => {
      AS.state.sessions = [session];
      AS.state.activeSessionIdx = 0;
      AS.state.session = session;
      AS.state.totalFrames = F.NF;
      AS.state.currentFrame = 0;
      AS.state.views = [];
      AS.state.triangulationResults = new Map();
    };
    // An eager session with Blue's camC instance removed on frame 0, as if
    // that camera never detected it.
    const mkEager = (name) => {
      const s = F.mkSession(name, { eager: true });
      const list = s.getFrameGroup(0).instances.get(MISSING_CAM);
      const i = list.findIndex(inst => inst.trackIdx === MISSING_TRACK);
      list.splice(i, 1);
      return s;
    };
    // The same on a windowed (lazy) session: the loader never yields it.
    const mkLazy = (name) => {
      const s = F.mkSession(name);
      const get = s.lazyLoader.getFrameSync.bind(s.lazyLoader);
      s.lazyLoader.getFrameSync = (fi) => {
        const m = get(fi);
        if (m && fi === 0) m.set(MISSING_CAM, m.get(MISSING_CAM).filter(r => r.trackIdx !== MISSING_TRACK));
        return m;
      };
      return s;
    };
    // The group with no camC instance on frame 0.
    const blueOf = () => (TRI.getInstanceGroupsForFrame(0) || []).find(g => !g.getInstance(MISSING_CAM));
    const resultFor = (g) => (AS.state.triangulationResults.get(0) || []).find(r => r.group === g);

    // What the user sees: draw ONLY this group into camC on a real canvas and
    // count painted pixels within 6 px of each reprojected node.
    const drawnNear = (session, g, pts) => {
      const c = document.createElement('canvas');
      c.width = 1280; c.height = 1024;
      const ctx = c.getContext('2d');
      OV.drawFrameOverlays(ctx, MISSING_CAM, null, [g], session, { showReprojected: true });
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      let nodesHit = 0, painted = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 0) painted++;
      for (const p of pts || []) {
        if (!p) continue;
        let hit = false;
        for (let dy = -6; dy <= 6 && !hit; dy++) {
          for (let dx = -6; dx <= 6 && !hit; dx++) {
            const x = Math.round(p[0]) + dx, y = Math.round(p[1]) + dy;
            if (x >= 0 && y >= 0 && x < c.width && y < c.height && px[(y * c.width + x) * 4 + 3] > 0) hit = true;
          }
        }
        if (hit) nodesHit++;
      }
      return { nodesHit, painted };
    };
    const maxDelta = (a, b) => {
      if (!a || !b || a.length !== b.length) return Infinity;
      let w = 0;
      for (let k = 0; k < a.length; k++) {
        if (!a[k] && !b[k]) continue;
        if (!a[k] || !b[k]) return Infinity;
        w = Math.max(w, Math.abs(a[k][0] - b[k][0]), Math.abs(a[k][1] - b[k][1]));
      }
      return w;
    };
    const record = (session, g) => {
      const pts = g && g.reprojections ? g.reprojections[MISSING_CAM] : null;
      const r = g ? resultFor(g) : null;
      return {
        members: g ? g.cameraNames.slice().sort() : null,
        pts: pts || null,
        draw: g ? drawnNear(session, g, pts || reference.pts) : null,
        meanError: r ? r.meanError : null,
        errorCams: r && r.errors ? Object.keys(r.errors).sort() : null,
      };
    };

    const prevPref = SET.getDefaultTriangulationMethod();
    SET.setDefaultTriangulationMethod('ba');

    // ---- reference: single-frame Triangulate (always covered every camera) --
    const s0 = mkEager('REF_SINGLE_FRAME');
    boot(s0);
    TRI.triangulateCurrentFrame('ba');
    const g0 = blueOf();
    const reference = {
      members: g0.cameraNames.slice().sort(),
      pts: g0.getReprojectedInstance(MISSING_CAM).toPointsArray(),
      meanError: (resultFor(g0) || {}).meanError,
    };
    reference.draw = drawnNear(s0, g0, reference.pts);

    // ---- A: Triangulate All ▸ Refined, in-memory path (the report) ----------
    const sA = mkEager('A_TRIANGULATE_ALL');
    boot(sA);
    await TRI.triangulateAllFrames('ba');
    const A = record(sA, blueOf());
    A.status = (document.getElementById('statusText') || {}).textContent || '';
    A.windowed = !!sA.lazyLoader;

    // ---- B: triangulateMultiFrameInstances (frame-range sweep) -------------
    const sB = mkEager('B_MULTI_FRAME');
    boot(sB);
    // It triangulates existing groups; let Triangulate All make them, then
    // throw its reprojections away so B has to produce its own.
    await TRI.triangulateAllFrames('ba');
    for (const g of TRI.getInstanceGroupsForFrame(0)) { g.reprojections = null; g.reprojectedInstances.clear(); }
    AS.state.triangulationResults = new Map();
    await TRI.triangulateMultiFrameInstances(0, F.NF - 1, null, 'ba');
    // The backend draws nothing (its modal does, `runMultiFrameTriangulation`).
    RND.drawAllOverlays(0);
    const B = record(sB, blueOf());

    // ---- C: Tracks ▸ Group by Track, through its real modal -----------------
    const sC = mkEager('C_GROUP_BY_TRACK');
    boot(sC);
    EM.showGroupByTrackModal();
    document.getElementById('gbtGo').click();
    for (let i = 0; i < 200 && document.getElementById('gbtGo'); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    RND.drawAllOverlays(0);
    const C = record(sC, blueOf());
    C.modalGone = !document.getElementById('gbtGo');

    // ---- D: windowed Triangulate All (already worked: the lazy fill) -------
    const sD = mkLazy('D_WINDOWED');
    boot(sD);
    await TRI.triangulateAllFrames('ba');   // ends with drawAllOverlays → lazy fill
    RND.drawAllOverlays(0);
    const D = record(sD, blueOf());
    D.released = sD.lazyLoader.released.length;

    SET.setDefaultTriangulationMethod(prevPref);
    return { reference, A, B, C, D, deltas: {
      A: maxDelta(A.pts, reference.pts), B: maxDelta(B.pts, reference.pts),
      C: maxDelta(C.pts, reference.pts), D: maxDelta(D.pts, reference.pts),
    } };
  });

  const nNodes = out.reference.pts.filter(Boolean).length;
  console.log(`    Blue's members on frame 0: ${out.reference.members.join(', ')}; ` +
    `${nNodes} reprojected nodes in camC`);
  for (const k of ['A', 'B', 'C', 'D']) {
    const p = out[k];
    console.log(`    ${k}: camC reprojection ${p.pts ? 'present' : 'MISSING'}, ` +
      `${p.draw.nodesHit}/${nNodes} nodes drawn, max |delta| vs reference ${out.deltas[k]} px`);
  }

  // ---- preconditions -----------------------------------------------------
  check(JSON.stringify(out.reference.members) === '["camA","camB"]',
    `precondition: Blue has instances in camA and camB only on frame 0 ` +
    `(got ${JSON.stringify(out.reference.members)})`);
  check(out.reference.draw.nodesHit === nNodes && nNodes > 0,
    `reference: single-frame Triangulate draws Blue in camC (${out.reference.draw.nodesHit}/${nNodes} nodes)`);
  check(!out.A.windowed && /^Triangulated \d+ frames via Refined/.test(out.A.status),
    `precondition: A took the IN-MEMORY Triangulate All path (status "${out.A.status}")`);
  check(out.D.released > 0,
    `precondition: D took the WINDOWED path (releaseWindow called ${out.D.released}x)`);
  check(out.C.modalGone, 'precondition: the Group by Track modal ran and closed');

  // ---- the fix ------------------------------------------------------------
  const label = { A: 'Triangulate All ▸ Refined (in-memory)', B: 'triangulateMultiFrameInstances',
    C: 'Group by Track', D: 'Triangulate All ▸ Refined (windowed)' };
  for (const k of ['A', 'B', 'C', 'D']) {
    const p = out[k];
    check(JSON.stringify(p.members) === '["camA","camB"]',
      `${label[k]}: Blue still has no camC instance (members ${JSON.stringify(p.members)})`);
    check(p.pts != null, `${label[k]}: Blue has a camC reprojection`);
    check(p.draw.nodesHit === nNodes,
      `${label[k]}: it is DRAWN — ${p.draw.nodesHit}/${nNodes} nodes painted on the camC overlay`);
    check(out.deltas[k] < 1e-6,
      `${label[k]}: at the same pixels as single-frame Triangulate (max |delta| ${out.deltas[k]} px)`);
  }
  // The added camera carries no error: only cameras with an instance are measured.
  for (const k of ['A', 'B', 'C']) {
    check(JSON.stringify(out[k].errorCams) === '["camA","camB"]',
      `${label[k]}: errors are still reported for camA and camB only ` +
      `(got ${JSON.stringify(out[k].errorCams)})`);
    check(out[k].meanError === out.reference.meanError,
      `${label[k]}: Blue's mean error is unchanged — ${out[k].meanError} px vs single-frame ` +
      `${out.reference.meanError} px`);
  }

  check(errs.length === 0, `no page errors (${errs.length})` + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
