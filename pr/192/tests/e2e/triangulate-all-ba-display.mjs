/**
 * triangulate-all-ba-display.mjs — "Triangulate All ▸ Bundle Adjustment" must
 * REPORT bundle adjustment's reprojection error, not DLT's.
 *
 * ## The bug
 * Single-frame Triangulate with BA updated the displayed reprojection error.
 * "Triangulate All" with BA appeared to change nothing: the headline error kept
 * showing DLT's value (while the method label still read "Bundle Adjustment",
 * because that falls back to `group.triangulationMethod`).
 *
 * The BA result was computed correctly and then discarded for display:
 *
 *   1. `sweepTriangulateAllFrames` (the memory-bounded windowed path, the one a
 *      real reopened project takes) clears `state.triangulationResults` and
 *      nulls `group.reprojections` / `reprojectedInstances` project-wide, on
 *      purpose — those are derived state and retaining them for 531,799 groups
 *      is ~1.9 GB (see its docstring).
 *   2. It then triangulates each group with BA and stores `points3d` +
 *      `triangulationMethod = 'ba'`. The 3D really is BA's.
 *   3. `ui/rendering.js`'s `drawAllOverlays` lazy fill sees "has points3d but no
 *      reprojections" and recomputes — and it called
 *      `triangulateAndReproject(grp, cameras)` with NO options, so the
 *      dispatcher's `options.method === 'ba' ? 'ba' : 'dlt'` silently yielded
 *      **'dlt'**. It then wrote that DLT re-solve's `errors`/`meanError` into
 *      `state.triangulationResults`, which is exactly what the Info Panel reads.
 *
 * The single-frame path escaped this because `triangulateCurrentFrame` stores its
 * own BA result AND populates `reprojections`, so the lazy-fill condition is
 * false and nothing clobbers it. Phase B pins that asymmetry from the other end.
 *
 * The fix mirrors the precedent already in `reTriangulateGroup`: honor
 * `group.triangulationMethod`.
 *
 * Fixture (real k1 barrel distortion, fold-radius safety, the rig trick) lives in
 * `fixtures/ba-rig-fixture.js` — read its header before editing the geometry.
 * Sibling test: `triangulate-all-ba-export.mjs` covers the export half.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8097);

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
  await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

  const out = await page.evaluate(async () => {
    const AS = await import('/ui/app-state.js');
    const TRI = await import('/pose/triangulation.js');
    const RND = await import('/ui/rendering.js');
    const IP = await import('/ui/info-panel.js');
    const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
    const F = await buildBaRigFixture();

    // ---- independent reference errors, solved both ways ------------------
    const refDlt = F.aggregate(F.refSolve(0, 'dlt'));
    const refBa = F.aggregate(F.refSolve(0, 'ba'));
    const refBaPts = F.refSolve(0, 'ba').map(r => r.points3d);

    // =====================================================================
    // Phase A — the REAL "Triangulate All ▸ Bundle Adjustment" on a session
    // that takes the windowed/lazy sweep (a reopened real project's path).
    // =====================================================================
    const sA = F.mkSession('BA_ALL_LAZY');       // lazy by default
    AS.state.sessions = [sA];
    AS.state.activeSessionIdx = 0;
    AS.state.session = sA;
    AS.state.totalFrames = F.NF;
    AS.state.currentFrame = 0;
    AS.state.views = [];
    AS.state.triangulationResults = new Map();

    await TRI.triangulateAllFrames('ba');   // ends with drawAllOverlays(currentFrame)

    const groupsA = TRI.getInstanceGroupsForFrame(0) || [];
    const storedA = AS.state.triangulationResults.get(0) || [];
    const seenA = F.aggregate(storedA);
    // Is the re-solve's 3D the SAME 3D the sweep stored on the group? The lazy
    // fill deliberately does NOT write `points3d` back, so if the two ever
    // diverged the group would hold one solve's 3D while the panel showed
    // another's error. With the method honored they must be bit-identical.
    let worst3dDelta = 0;
    for (const r of storedA) {
      worst3dDelta = Math.max(worst3dDelta, F.points3dDelta(r.points3d, r.group.points3d));
    }
    // Render the panel the way frame navigation does and read what the user sees.
    IP.updateFrameInfo(0, groupsA);
    const shownA = (document.getElementById('errorDisplay') || {}).textContent || '';
    const methodA = (document.getElementById('errorMethod') || {}).textContent || '';

    // A second navigation-shaped repaint must not drift either.
    RND.drawAllOverlays(0);
    IP.updateFrameInfo(0, TRI.getInstanceGroupsForFrame(0) || []);
    const shownA2 = (document.getElementById('errorDisplay') || {}).textContent || '';

    // =====================================================================
    // Phase B — the single-frame path (the one that always worked), pinned so
    // the asymmetry is nailed from both ends.
    // =====================================================================
    const sB = F.mkSession('BA_ONE_EAGER', { eager: true });
    AS.state.sessions = [sB];
    AS.state.session = sB;
    AS.state.currentFrame = 0;
    AS.state.triangulationResults = new Map();

    TRI.triangulateCurrentFrame('ba');
    RND.drawAllOverlays(0);
    const groupsB = TRI.getInstanceGroupsForFrame(0) || [];
    const seenB = F.aggregate(AS.state.triangulationResults.get(0) || []);
    IP.updateFrameInfo(0, groupsB);
    const shownB = (document.getElementById('errorDisplay') || {}).textContent || '';

    return {
      worstIdealR: F.worstIdealR, rFoldPx: F.rFoldPx,
      refDlt, refBa,
      nGroupsA: groupsA.length, nStoredA: storedA.length,
      methodsA: groupsA.map(g => g.triangulationMethod),
      seenA, shownA, shownA2, methodA, released: sA.lazyLoader.released.length, worst3dDelta,
      // Does the group's 3D actually equal an independent BA solve's?
      baPtsDelta: Math.max.apply(null, groupsA.map((g, i) => F.points3dDelta(g.points3d, refBaPts[i]))),
      nGroupsB: groupsB.length, seenB, shownB,
      methodsB: groupsB.map(g => g.triangulationMethod),
    };
  });

  console.log(`    fixture: worst ideal radius ${out.worstIdealR.toFixed(1)} px of ` +
    `fold ${out.rFoldPx.toFixed(1)} px (${(100 * out.worstIdealR / out.rFoldPx).toFixed(1)}%)`);
  console.log(`    reference frame-0 mean error: DLT ${out.refDlt.toFixed(6)} px, ` +
    `BA ${out.refBa.toFixed(6)} px`);
  console.log(`    phase A (Triangulate All ▸ BA): stored mean ${String(out.seenA)} ` +
    `| panel "${out.shownA}" | method "${out.methodA}" | repaint "${out.shownA2}"`);
  console.log(`    phase B (single-frame ▸ BA):    stored mean ${String(out.seenB)} ` +
    `| panel "${out.shownB}"`);

  // ---- fixture preconditions ---------------------------------------------
  check(out.worstIdealR < 0.5 * out.rFoldPx,
    `every synthetic observation stays inside 50% of the k1 fold radius ` +
    `(${out.worstIdealR.toFixed(1)} px vs ${(0.5 * out.rFoldPx).toFixed(1)} px) — ` +
    `otherwise undistortPoint is inaccurate and the fixture is invalid`);
  check(out.refDlt != null && out.refBa != null, 'reference DLT and BA errors both computed');
  check(out.refBa < out.refDlt - 0.02,
    `precondition: BA is measurably better than DLT on this fixture ` +
    `(BA ${out.refBa.toFixed(4)} vs DLT ${out.refDlt.toFixed(4)} px) — if this ever ` +
    `collapses the test cannot distinguish the two and proves nothing`);
  check(out.nGroupsA === 2 && out.nGroupsB === 2,
    `both phases produced 2 groups on frame 0 (A=${out.nGroupsA}, B=${out.nGroupsB})`);
  check(out.released > 0,
    `precondition: the WINDOWED sweep really ran (releaseWindow called ${out.released}x) — ` +
    `the eager path stores its own results and does not exhibit the bug`);
  check(out.methodsA.every(m => m === 'ba'),
    `Triangulate All stamped triangulationMethod='ba' on every group ` +
    `(got ${JSON.stringify(out.methodsA)})`);
  check(out.baPtsDelta === 0,
    `...and the stored 3D really is BA's, bit for bit, versus an independent BA ` +
    `solve (worst |delta| ${out.baPtsDelta})`);

  // ---- THE BUG -----------------------------------------------------------
  const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;
  check(out.nStoredA === 2,
    `frame 0 has one stored triangulation result per group (got ${out.nStoredA})`);
  check(near(out.seenA, out.refBa, 1e-6),
    `Triangulate All ▸ BA reports BA's mean error: stored ${String(out.seenA)} px ` +
    `should equal BA ${out.refBa.toFixed(6)} px (DLT is ${out.refDlt.toFixed(6)} px)`);
  check(!near(out.seenA, out.refDlt, 1e-6),
    `...and NOT a silent DLT recompute (stored ${String(out.seenA)} px vs ` +
    `DLT ${out.refDlt.toFixed(6)} px)`);
  check(out.shownA === out.refBa.toFixed(2) + ' px',
    `the Info Panel headline shows BA's value: "${out.shownA}" should be ` +
    `"${out.refBa.toFixed(2)} px" (DLT would show "${out.refDlt.toFixed(2)} px")`);
  check(out.shownA2 === out.shownA,
    `a second navigation-shaped repaint does not drift the value ` +
    `("${out.shownA2}" vs "${out.shownA}")`);
  check(out.methodA === 'Bundle Adjustment',
    `the method label reads "Bundle Adjustment" (got "${out.methodA}")`);
  check(out.worst3dDelta === 0,
    `the re-solve's 3D is bit-identical to the 3D the sweep stored on the group ` +
    `(worst |delta| ${out.worst3dDelta}) — the lazy fill deliberately does NOT write ` +
    `points3d back, so any divergence would leave the group holding one solve's 3D ` +
    `while the panel reported another solve's error`);

  // ---- the other end of the asymmetry ------------------------------------
  check(out.methodsB.every(m => m === 'ba'),
    `single-frame Triangulate stamped triangulationMethod='ba' (got ${JSON.stringify(out.methodsB)})`);
  check(near(out.seenB, out.refBa, 1e-6),
    `single-frame Triangulate ▸ BA still reports BA's mean error: stored ` +
    `${String(out.seenB)} px should equal BA ${out.refBa.toFixed(6)} px`);
  check(out.shownB === out.refBa.toFixed(2) + ' px',
    `single-frame Info Panel headline still shows BA's value: "${out.shownB}" ` +
    `should be "${out.refBa.toFixed(2)} px"`);

  check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));

  await browser.close();
} finally {
  server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
