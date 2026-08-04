/**
 * triangulate-all-ba-display.mjs — "Triangulate All ▸ Bundle Adjustment" must
 * REPORT bundle adjustment's reprojection error, not DLT's.
 *
 * ## The bug
 * Single-frame Triangulate with BA updates the displayed reprojection error.
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
 * The single-frame path escapes this because `triangulateCurrentFrame` stores
 * its own BA result AND populates `reprojections`, so the lazy-fill condition is
 * false and nothing clobbers it. Phase B pins that asymmetry from the other end.
 *
 * The fix mirrors the precedent already in `reTriangulateGroup`: honor
 * `group.triangulationMethod`.
 *
 * ## Fixture correctness (read before editing the geometry)
 *   * `Camera.project()` does NOT apply distortion. A real observation is
 *     `cam.distortPoint(cam.project(X))`. Feeding ideal points as raw detections
 *     makes the whole undistort/reproject pipeline self-inconsistent and every
 *     measurement below meaningless. Use `observe()`.
 *   * `undistortPoint`'s Newton iteration degrades badly as the radius
 *     approaches the k1 fold radius `r_fold = 1/sqrt(-3*k1)`. Every synthetic
 *     observation must sit well inside it. The precondition assertion below
 *     measures the worst **ideal** projection radius (NOT the distorted one —
 *     barrel distortion compresses, so filtering on the distorted radius admits
 *     ideal radii past the fold) and requires it under 50% of `r_fold`.
 *   * The cameras carry REAL pure-k1 barrel distortion (k1 = -0.30, the middle
 *     of LUCID's real rigs at -0.24..-0.37). With zero distortion BA and DLT
 *     very nearly coincide and this test would prove nothing — so it asserts its
 *     own separation precondition (BA measurably better than DLT) too.
 *   * Rig trick: for ANY `rvec`, `tvec = [0, 0, D]` places the camera at
 *     distance D from the world origin looking straight at it. So the three
 *     cameras below all frame the same point cloud with genuinely different
 *     viewpoints while keeping every projection near the principal point.
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
    const pd = await import('/pose/pose-data.js');
    const AS = await import('/ui/app-state.js');
    const TRI = await import('/pose/triangulation.js');
    const RND = await import('/ui/rendering.js');
    const IP = await import('/ui/info-panel.js');
    const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

    // ---- deterministic RNG (LCG + Box-Muller) ---------------------------
    let _s = 20260804 >>> 0;
    const u = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
    const gauss = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());

    // ---- rig: 1280x1024, f=1000, pure-k1 barrel -------------------------
    const F = 1000, CX = 640, CY = 512;
    const K = [[F, 0, CX], [0, F, CY], [0, 0, 1]];
    const K1 = -0.30;
    const DIST = [K1, 0, 0, 0, 0];
    const R_FOLD_PX = F / Math.sqrt(-3 * K1);   // fold radius in pixels
    const D = 50;                               // camera distance to origin
    const RVECS = [[0, 0, 0], [0, 0.45, 0], [0.40, -0.40, 0]];
    const NAMES = ['camA', 'camB', 'camC'];
    const cams = NAMES.map((n, i) => new Camera(n, K, DIST, RVECS[i], [0, 0, D], [1280, 1024]));

    const NF = 8, NTRACK = 2, NNODE = 8, NOISE = 2.0;

    // Ground truth: two animals, NNODE nodes, drifting across NF frames, all
    // inside a small box around the origin so every projection stays near the
    // principal point (see the fold-radius note in the header).
    const truth = [];
    const base = [];
    for (let t = 0; t < NTRACK; t++) {
      const b = [];
      for (let k = 0; k < NNODE; k++) {
        b.push([(u() - 0.5) * 12 + (t === 0 ? -3 : 3), (u() - 0.5) * 12, (u() - 0.5) * 12]);
      }
      base.push(b);
    }
    for (let f = 0; f < NF; f++) {
      const perTrack = [];
      for (let t = 0; t < NTRACK; t++) {
        perTrack.push(base[t].map(p => [p[0] + f * 0.15, p[1] + f * 0.1, p[2]]));
      }
      truth.push(perTrack);
    }

    // Worst IDEAL projection radius over the whole fixture — the precondition
    // that keeps `undistortPoint` in its accurate regime.
    let worstIdealR = 0;
    for (let f = 0; f < NF; f++) {
      for (let t = 0; t < NTRACK; t++) {
        for (const X of truth[f][t]) {
          for (const cam of cams) {
            const q = cam.project(X);
            worstIdealR = Math.max(worstIdealR, Math.hypot(q[0] - CX, q[1] - CY));
          }
        }
      }
    }

    /** What the real camera sees: ideal projection, distorted, plus noise. */
    const observe = (cam, X) => {
      const q = cam.distortPoint(cam.project(X));
      return [q[0] + gauss() * NOISE, q[1] + gauss() * NOISE];
    };

    // Fixed observation table, shared by every phase so the phases are
    // comparing the same numbers.
    const obs = new Map();                        // f -> camName -> [track][node][2]
    for (let f = 0; f < NF; f++) {
      const perCam = new Map();
      for (const cam of cams) {
        const perTrack = [];
        for (let t = 0; t < NTRACK; t++) perTrack.push(truth[f][t].map(X => observe(cam, X)));
        perCam.set(cam.name, perTrack);
      }
      obs.set(f, perCam);
    }

    const skel = new Skeleton('sk', Array.from({ length: NNODE }, (_, i) => 'n' + i),
      Array.from({ length: NNODE - 1 }, (_, i) => [i, i + 1]));

    // Track-All-shaped state: identities exist and every (frame, camera, track)
    // carries a per-frame identity, but nothing is grouped yet — so both
    // Triangulate paths auto-group via `ensureGroupsFromIdentities`. Stamped
    // with `setFrameIdentity` rather than `assignTrackToIdentity` because the
    // latter walks `frameGroups`, which is EMPTY on a lazy session.
    const mkSession = (name) => {
      const s = new Session(cams, skel, ['track_0', 'track_1'], name);
      const ids = [s.addIdentity('Red'), s.addIdentity('Blue')];
      for (let f = 0; f < NF; f++) {
        for (const cam of cams) {
          for (let t = 0; t < NTRACK; t++) s.setFrameIdentity(f, cam.name, t, ids[t].id);
        }
      }
      return s;
    };

    // ---- independent reference errors -----------------------------------
    // Standalone groups over the SAME observations, solved both ways. No
    // `includedCameras` override: the app path doesn't pass one either, so both
    // sides see the same live Camera Views / threshold settings.
    const refGroupsFor = (f) => {
      const gs = [];
      for (let t = 0; t < NTRACK; t++) {
        const g = new InstanceGroup(9000 + t, -1);
        for (const cam of cams) {
          g.addInstance(cam.name,
            new Instance(obs.get(f).get(cam.name)[t].map(p => [p[0], p[1]]), t, 'predicted', 1));
        }
        gs.push(g);
      }
      return gs;
    };
    /** Aggregate a results list exactly the way info-panel.updateFrameInfo does. */
    const aggregate = (results) => {
      let sum = 0, n = 0;
      for (const r of results) {
        if (r.meanError == null || !r.errors) continue;
        for (const cn in r.errors) for (const e of r.errors[cn]) if (e != null) { sum += e; n++; }
      }
      return n ? sum / n : null;
    };
    const refDlt = aggregate(refGroupsFor(0).map(g => TRI.triangulateAndReproject(g, cams, { method: 'dlt' })));
    const refBa = aggregate(refGroupsFor(0).map(g => TRI.triangulateAndReproject(g, cams, { method: 'ba' })));

    // =====================================================================
    // Phase A — the REAL "Triangulate All ▸ Bundle Adjustment" on a session
    // that takes the windowed/lazy sweep (a reopened real project's path).
    // =====================================================================
    const sA = mkSession('BA_ALL_LAZY');
    // Minimal sync lazy loader: what `sweepLazyFrameWindows` /
    // `batchLoadLazyFrames` / `buildLazyFrameGroupSync` actually require.
    const released = [];
    sA.lazyLoader = {
      isSync: true,
      nFrames: NF,
      getFrameSync(fi) {
        if (!obs.has(fi)) return null;
        const m = new Map();
        for (const cam of cams) {
          m.set(cam.name, obs.get(fi).get(cam.name).map((pts, t) => ({
            points: pts.map(p => [p[0], p[1]]), trackIdx: t, type: 'predicted', score: 1,
          })));
        }
        return m;
      },
      getFrame(fi) { return Promise.resolve(this.getFrameSync(fi) || new Map()); },
      releaseWindow(s, e) { released.push([s, e]); },
    };

    AS.state.sessions = [sA];
    AS.state.activeSessionIdx = 0;
    AS.state.session = sA;
    AS.state.totalFrames = NF;
    AS.state.currentFrame = 0;
    AS.state.views = [];
    AS.state.triangulationResults = new Map();

    await TRI.triangulateAllFrames('ba');   // ends with drawAllOverlays(currentFrame)

    const groupsA = TRI.getInstanceGroupsForFrame(0) || [];
    const storedA = AS.state.triangulationResults.get(0) || [];
    const seenA = aggregate(storedA);
    // Is the re-solve's 3D the SAME 3D the sweep stored on the group? The lazy
    // fill deliberately does NOT write `points3d` back, so if the two ever
    // diverged the group would hold one solve's 3D while the panel showed
    // another's error. With the method honored they must be bit-identical.
    let worst3dDelta = 0;
    for (const r of storedA) {
      const a = r.points3d, b = r.group.points3d;
      if (!a || !b || a.length !== b.length) { worst3dDelta = Infinity; break; }
      for (let i = 0; i < a.length; i++) {
        if (Number.isNaN(a[i]) && Number.isNaN(b[i])) continue;
        worst3dDelta = Math.max(worst3dDelta, Math.abs(a[i] - b[i]));
      }
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
    const sB = mkSession('BA_ONE_EAGER');
    for (let f = 0; f < NF; f++) {
      const fg = new FrameGroup(f);
      sB.addFrameGroup(fg);
      for (const cam of cams) {
        for (let t = 0; t < NTRACK; t++) {
          fg.addInstance(cam.name,
            new Instance(obs.get(f).get(cam.name)[t].map(p => [p[0], p[1]]), t, 'predicted', 1));
        }
      }
    }
    AS.state.sessions = [sB];
    AS.state.session = sB;
    AS.state.currentFrame = 0;
    AS.state.triangulationResults = new Map();

    TRI.triangulateCurrentFrame('ba');
    RND.drawAllOverlays(0);
    const groupsB = TRI.getInstanceGroupsForFrame(0) || [];
    const seenB = aggregate(AS.state.triangulationResults.get(0) || []);
    IP.updateFrameInfo(0, groupsB);
    const shownB = (document.getElementById('errorDisplay') || {}).textContent || '';

    return {
      worstIdealR, rFoldPx: R_FOLD_PX,
      refDlt, refBa,
      nGroupsA: groupsA.length, nStoredA: storedA.length,
      methodsA: groupsA.map(g => g.triangulationMethod),
      seenA, shownA, shownA2, methodA, released: released.length, worst3dDelta,
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
    `(got ${JSON.stringify(out.methodsA)}) — the 3D really is BA's`);

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
