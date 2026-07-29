/**
 * save-multiinstance-ref-integrity.mjs — regression guard for issue #158
 * (2D pose/track data silently misattributed between animals on save/reload).
 *
 * Root cause: `refFor()` in `import-export/slp-streaming-write.js` resolves
 * which raw per-camera store row a grouped `InstanceGroup` member came from
 * by matching `Instance.trackIdx` against the store's per-row track column —
 * and silently defaulted to `instIndex = 0` whenever that match failed
 * (trackless instance, or no row in range had that trackIdx). This is wrong
 * whenever a camera-frame has MORE THAN ONE raw instance (multi-animal —
 * this app's core use case) and the grouped member is trackless: multiple
 * `InstanceGroup`s can collide onto the identical `[lfIndex, 0]` ref, so on
 * reload the WRONG animal's 2D pose/track gets attached to a group.
 *
 * Verified against Elly's real ~108k-frame×3-camera cage5 dataset (see
 * scratch/2026-07-13-elly-perf/): with the old heuristic, 8 real ref
 * collisions occurred in the first 3000 frames alone. The existing
 * multi-session/reopen-calibration/lazy-calibration e2e tests all use exactly
 * ONE instance per camera per frame, where `instIndex = 0` is trivially
 * correct regardless of whether the matching logic works — so none of them
 * could ever catch this.
 *
 * The fix tags each `Instance` with `_rawInstIndex` (its exact row offset)
 * when first materialized from the lazy store (`pose/triangulation.js`:
 * `ensureLazyFrameData`/`buildLazyFrameGroupSync`/`batchLoadLazyFrames`), and
 * `refFor` uses that directly instead of guessing.
 *
 * This test builds a synthetic lazy session with a camera-frame holding
 * THREE raw predicted instances, TWO of them trackless (the exact
 * ambiguous-under-the-old-heuristic shape), groups two of them into distinct
 * `InstanceGroup`s (mirroring what Track All + Triangulate All would
 * produce), materializes them through the REAL lazy-loading path (so
 * `_rawInstIndex` tagging is genuinely exercised, not hand-set), saves via
 * the real streaming writer, and reloads via the real parse +
 * reconstruction path — asserting each group's 2D pose is the CORRECT
 * animal's, not a neighbor's.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8094);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
  if (process.env.SHOW_PHASES) page.on('console', m => { const t = m.text(); if (t.includes('phase:')) console.log('  [page]', t); });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

  const r = await page.evaluate(async () => {
    const pd = await import('/pose/pose-data.js');
    const fileio = await import('/import-export/file-io.js');
    const lazyMod = await import('/loading/sio-lazy-loader.js');
    const AS = await import('/ui/app-state.js');
    const saveLoad = await import('/import-export/save-load.js');
    const triang = await import('/pose/triangulation.js');
    const slpimp = await import('/import-export/slp-import.js');
    const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
    const SioLazyLoader = lazyMod.SioLazyLoader || lazyMod.default;
    const state = AS.state;

    const NODES = 3;
    const CAM_A = 'camA', CAM_B = 'camB';
    // Frame 0, camA: THREE raw predicted instances, TWO trackless — the exact
    // shape the old trackIdx heuristic could not disambiguate. Distinct point
    // values per instance so a misattribution is directly observable.
    const RAW_A = [
      { points: [[10, 10], [11, 11], [12, 12]], trackIdx: null },  // row 0 — trackless
      { points: [[50, 50], [51, 51], [52, 52]], trackIdx: null },  // row 1 — trackless (ambiguous twin)
      { points: [[90, 90], [91, 91], [92, 92]], trackIdx: 0 },     // row 2 — has a track
    ];
    const RAW_B = [{ points: [[20, 20], [21, 21], [22, 22]], trackIdx: null }];

    function skelFor() {
      return new Skeleton('skeleton', Array.from({ length: NODES }, (_, i) => 'n' + i),
        Array.from({ length: NODES - 1 }, (_, i) => [i, i + 1]));
    }

    async function buildCameraFixture(camName, camIdx, rawInstances) {
      const mtx = [[1000, 0, 128], [0, 1000, 128], [0, 0, 1]];
      const cam = new Camera(camName, mtx, [0, 0, 0, 0, 0], [0, 0.1 * camIdx, 0], [10 * camIdx, 0, 0], [256, 256]);
      const skel = skelFor();
      const s = new Session([cam], skel, ['t0'], camName);
      const fg = new FrameGroup(0); s.addFrameGroup(fg);
      for (const raw of rawInstances) {
        const inst = new Instance(raw.points, raw.trackIdx, 'predicted', 0.9);
        fg.addInstance(camName, inst);
      }
      const views = [{ name: camName, videoWidth: 256, videoHeight: 256, frameCount: 1 }];
      const labels = fileio.buildSlpLabels(s, camName, false, { videoWidth: 256, videoHeight: 256, frameCount: 1, videoPath: camName + '.mp4' });
      const bytes = await window.SleapIO.saveSlpToBytes(labels);
      return new File([bytes], camName + '.slp');
    }

    const mtxA = [[1000, 0, 128], [0, 1000, 128], [0, 0, 1]];
    const camA = new Camera(CAM_A, mtxA, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [256, 256]);
    const camB = new Camera(CAM_B, [[1000, 0, 128], [0, 1000, 128], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0.1, 0], [10, 0, 0], [256, 256]);
    const skel = skelFor();
    const session = new Session([camA, camB], skel, ['t0'], 'refIntegrityTest');

    const loader = new SioLazyLoader();
    await loader.open(CAM_A, await buildCameraFixture(CAM_A, 0, RAW_A));
    await loader.open(CAM_B, await buildCameraFixture(CAM_B, 1, RAW_B));
    session.lazyLoader = loader;

    state.sessions = [session];
    state.session = session;
    state.activeSessionIdx = 0;

    // Materialize frame 0 through the REAL lazy-loading path (not hand-built
    // FrameGroups/Instances) so `_rawInstIndex` tagging is genuinely
    // exercised — this is the whole point of the test.
    triang.buildLazyFrameGroupSync(0);
    const fg0 = session.frameGroups.get(0);
    const camAInsts = fg0.getInstances(CAM_A).concat(fg0.getUnlinkedInstances(CAM_A).map(u => u.instance));
    const camBInsts = fg0.getInstances(CAM_B).concat(fg0.getUnlinkedInstances(CAM_B).map(u => u.instance));

    // Group the FIRST trackless camA instance (row 0) with camB's instance,
    // and the SECOND trackless camA instance (row 1) alone — mirroring what
    // Track All + Triangulate All would produce for two animals, one seen in
    // both cameras and one only in camA.
    const instA0 = camAInsts.find(i => i.getX(0) === 10);
    const instA1 = camAInsts.find(i => i.getX(0) === 50);
    const instB0 = camBInsts[0];

    const groupA0B0 = new InstanceGroup(1, -1);
    groupA0B0.addInstance(CAM_A, instA0);
    groupA0B0.addInstance(CAM_B, instB0);
    groupA0B0.points3d = [[1, 1, 1], [2, 2, 2], [3, 3, 3]];

    const groupA1 = new InstanceGroup(2, -1);
    groupA1.addInstance(CAM_A, instA1);
    groupA1.points3d = [[9, 9, 9], [8, 8, 8], [7, 7, 7]];

    session.instanceGroups.set(0, [groupA0B0, groupA1]);

    const views = [
      { name: CAM_A, videoWidth: 256, videoHeight: 256, frameCount: 1 },
      { name: CAM_B, videoWidth: 256, videoHeight: 256, frameCount: 1 },
    ];
    const videoFiles = [
      { name: CAM_A, assignedCamera: CAM_A, videoPath: CAM_A + '.mp4' },
      { name: CAM_B, assignedCamera: CAM_B, videoPath: CAM_B + '.mp4' },
    ];

    let saveErr = null, bytes = null;
    try {
      bytes = await saveLoad.saveAllSessionsStreaming([session]);
    } catch (e) { saveErr = String(e && e.stack || e); }
    if (saveErr) return { saveErr };

    const file = new File([bytes], 'refintegrity.slp');
    const slpData = await fileio.parseSlpViaSleapIO(file, () => {});
    const sess0 = slpData.sessions[0];

    let recon = null, reconErr = null;
    const fresh = new Session([], skel, slpData.tracks, 'reopened');
    try {
      recon = await slpimp.reconstructInstanceGroupsFromSession(fresh, sess0._typedSession, sess0, slpData.skeleton.nodes, {});
    } catch (e) { reconErr = String(e && e.stack || e); }

    const groups = (fresh.instanceGroups.get(0) || []);
    const findGroupByCamAX = (x) => groups.find(g => { const inst = g.getInstance ? g.getInstance(CAM_A) : g.instances.get(CAM_A); return inst && inst.getX(0) === x; });
    const reGroupA0 = findGroupByCamAX(10);
    const reGroupA1 = findGroupByCamAX(50);

    return {
      reconOk: !!recon, reconErr,
      refCollisions: recon ? recon.refCollisions : null,
      nGroups: groups.length,
      groupA0HasCamB: !!(reGroupA0 && (reGroupA0.getInstance ? reGroupA0.getInstance(CAM_B) : reGroupA0.instances.get(CAM_B))),
      groupA0CamBPoint: reGroupA0 ? (reGroupA0.getInstance ? reGroupA0.getInstance(CAM_B) : reGroupA0.instances.get(CAM_B)).getX(0) : null,
      groupA1HasCamB: !!(reGroupA1 && (reGroupA1.getInstance ? reGroupA1.getInstance(CAM_B) : reGroupA1.instances.get(CAM_B))),
      // points3d is a flat Float64Array (luc3d #189) — boxed here so it
      // survives the page->node structured-clone/JSON boundary readably.
      groupA0Points3d: reGroupA0 ? pd.toBoxedPoints3d(reGroupA0.points3d) : null,
      groupA1Points3d: reGroupA1 ? pd.toBoxedPoints3d(reGroupA1.points3d) : null,
    };
  });

  console.log('  measured:', JSON.stringify(r));
  if (r.saveErr) {
    check(false, 'save did not throw: ' + r.saveErr);
  } else {
    check(r.reconOk === true, 'reconstruction succeeded' + (r.reconErr ? ': ' + r.reconErr : ''));
    check(r.refCollisions === 0, `zero ref collisions detected (got ${r.refCollisions})`);
    check(r.nGroups === 2, `both groups reconstructed (got ${r.nGroups})`);
    check(r.groupA0HasCamB === true && r.groupA0CamBPoint === 20,
      `group containing camA's row-0 instance keeps ITS OWN camB partner (point=20), not misattributed (got camB point=${r.groupA0CamBPoint})`);
    check(r.groupA1HasCamB === false,
      'group containing camA\'s row-1 (trackless twin) instance has NO camB member (it never had one) — would be true if refFor collided rows 0/1');
    check(JSON.stringify(r.groupA0Points3d) === JSON.stringify([[1, 1, 1], [2, 2, 2], [3, 3, 3]]),
      `group A0's 3D points are its own, not swapped with A1's (got ${JSON.stringify(r.groupA0Points3d)})`);
    check(JSON.stringify(r.groupA1Points3d) === JSON.stringify([[9, 9, 9], [8, 8, 8], [7, 7, 7]]),
      `group A1's 3D points are its own, not swapped with A0's (got ${JSON.stringify(r.groupA1Points3d)})`);
  }

  await browser.close();
} finally {
  server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
