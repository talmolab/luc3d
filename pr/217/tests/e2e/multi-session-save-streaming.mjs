/**
 * multi-session-save-streaming.mjs — regression guard for memory-bounded
 * MULTI-session `.slp` save (eric/fix-save follow-up).
 *
 * Loading 3 large lazy prediction sessions together (e.g. three duplicated
 * ~108k-frame × 3-camera cage5 folders) always fell through to the eager
 * `buildSlpLabelsAllViews` + one `saveSlpToBytes` call whenever more than one
 * session was loaded — the same "materialize everything" bug the streaming
 * writer was built to avoid for a single session, just multiplied by N.
 *
 * `saveAllSessionsStreaming()` (import-export/save-load.js) generalizes the
 * single-session streaming writer (slp-streaming-write.js) to N sessions via
 * two passes — PASS 1 builds each session's ref-based `RecordingSession`
 * graph (against a running GLOBAL output-frame counter — sleap-io resolves
 * `lf_idx` against one flat, file-wide labeled-frames table, never
 * per-session) then evicts its lazy loader/frameGroups/instanceGroups; once
 * every session's ref graph is final, the writer opens once and PASS 2
 * re-streams each session's 2D data from a freshly (cheaply) reopened lazy
 * loader.
 *
 * This test builds two SYNTHETIC lazy sessions with DISTINCT camera names,
 * calibrations, and frame counts (so any cross-session index confusion would
 * be immediately visible), drives the real `saveAllSessionsStreaming()`, then
 * reopens the result through the real parse + reconstruction path
 * (`parseSlpViaSleapIO` + `reconstructInstanceGroupsFromSession`) and asserts
 * every session's cameras/calibration/tracking/3D land back on the CORRECT
 * session, uncontaminated by the other.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8093);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
try {
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

  const r = await page.evaluate(async () => {
    const pd = await import('/pose/pose-data.js');
    const fileio = await import('/import-export/file-io.js');
    const lazyMod = await import('/loading/sio-lazy-loader.js');
    const AS = await import('/ui/app-state.js');
    const saveLoad = await import('/import-export/save-load.js');
    const slpimp = await import('/import-export/slp-import.js');
    const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
    const SioLazyLoader = lazyMod.SioLazyLoader || lazyMod.default;

    const SESS_SPECS = [
      { name: 'sessA', camNames: ['a_cam0', 'a_cam1'], nFrames: 6, fx: 1000, identities: ['idA0', 'idA1'] },
      { name: 'sessB', camNames: ['b_cam0', 'b_cam1'], nFrames: 5, fx: 2000, identities: ['idB0'] },
    ];
    const NODES = 4;

    // Build one small per-camera PREDICTION .slp file (mirrors what a real
    // SLEAP per-camera export looks like: one video, one camera, no grouping)
    // for every camera of every synthetic session, using the SAME
    // single-camera builder (`buildSlpLabels`) real prediction exports use.
    function skelFor() {
      return new Skeleton('skeleton', Array.from({ length: NODES }, (_, i) => 'n' + i),
        Array.from({ length: NODES - 1 }, (_, i) => [i, i + 1]));
    }

    async function buildPerCameraFixture(spec, camName, camIdx) {
      const mtx = [[spec.fx, 0, 128], [0, spec.fx, 128], [0, 0, 1]];
      const cam = new Camera(camName, mtx, [0, 0, 0, 0, 0], [0, 0.1 * camIdx, 0], [10 * camIdx, 0, 0], [256, 256]);
      const skel = skelFor();
      const s = new Session([cam], skel, ['t0'], spec.name);
      for (let f = 0; f < spec.nFrames; f++) {
        const fg = new FrameGroup(f); s.addFrameGroup(fg);
        const pts = Array.from({ length: NODES }, (_, k) => [50 + k + f, 60 + k + f]);
        const inst = new Instance(pts, 0, 'predicted', 0.9);
        fg.addInstance(camName, inst);
      }
      const views = [{ name: camName, videoWidth: 256, videoHeight: 256, frameCount: spec.nFrames }];
      const vf = [{ name: camName, assignedCamera: camName, videoPath: camName + '.mp4' }];
      const labels = fileio.buildSlpLabels(s, camName, false, { videoWidth: 256, videoHeight: 256, frameCount: spec.nFrames, videoPath: camName + '.mp4' });
      const bytes = await window.SleapIO.saveSlpToBytes(labels);
      return new File([bytes], camName + '.slp');
    }

    // Build the REAL multi-session app state: a lazy Session per spec, each
    // with a real SioLazyLoader (opened from the per-camera fixtures above),
    // and frameGroups/instanceGroups populated as if Track All + Triangulate
    // All had already run (grouping the two cameras' predicted instances per
    // frame, with fake-but-present 3D points).
    const sessions = [];
    const allViews = [];
    const allVideoFiles = [];
    for (const spec of SESS_SPECS) {
      const mtx = [[spec.fx, 0, 128], [0, spec.fx, 128], [0, 0, 1]];
      const cams = spec.camNames.map((cn, ci) => new Camera(cn, mtx, [0, 0, 0, 0, 0], [0, 0.1 * ci, 0], [10 * ci, 0, 0], [256, 256]));
      const skel = skelFor();
      const session = new Session(cams, skel, ['t0'], spec.name);
      const loader = new SioLazyLoader();
      for (let ci = 0; ci < spec.camNames.length; ci++) {
        const file = await buildPerCameraFixture(spec, spec.camNames[ci], ci);
        await loader.open(spec.camNames[ci], file);
      }
      session.lazyLoader = loader;

      const identityIds = spec.identities.map(nm => session.addIdentity(nm).id);
      for (let f = 0; f < spec.nFrames; f++) {
        const fg = new FrameGroup(f); session.addFrameGroup(fg);
        const g = new InstanceGroup(f * 10, identityIds[0]);
        for (const cn of spec.camNames) {
          const pts = Array.from({ length: NODES }, (_, k) => [50 + k + f, 60 + k + f]);
          const inst = new Instance(pts, 0, 'predicted', 0.9);
          g.addInstance(cn, inst); fg.addInstance(cn, inst);
        }
        g.points3d = Array.from({ length: NODES }, (_, k) => [k + f * 0.1, k * 2, spec.fx / 1000 + k]);
        session.instanceGroups.set(f, [g]);
      }
      sessions.push(session);
      for (const cn of spec.camNames) {
        allViews.push({ name: cn, videoWidth: 256, videoHeight: 256, frameCount: spec.nFrames });
        allVideoFiles.push({ name: cn, assignedCamera: cn, videoPath: cn + '.mp4' });
      }
    }

    AS.state.sessions = sessions;
    AS.state.session = sessions[0];
    AS.state.activeSessionIdx = 0;
    AS.state.views = allViews;
    AS.state.videoFiles = allVideoFiles;

    // Peak-memory sampler (signal only — this fixture is CI-sized, not a
    // memory-bound proof; the real-data validation covers that).
    let peak = 0;
    const sampler = setInterval(() => {
      const u = performance.memory ? performance.memory.usedJSHeapSize : 0;
      if (u > peak) peak = u;
    }, 50);

    let saveErr = null, bytes = null;
    try {
      bytes = await saveLoad.saveAllSessionsStreaming(sessions);
    } catch (e) { saveErr = String(e && e.stack || e); }
    clearInterval(sampler);
    if (saveErr) return { saveErr };

    // Every session's lazyLoader should be evicted as a side effect of the save.
    const evicted = sessions.every(s => s.lazyLoader === null);

    // Reopen via the REAL production parse + reconstruction path.
    const file = new File([bytes], 'multi.slp');
    const slpData = await fileio.parseSlpViaSleapIO(file, () => {});
    const out = { bytes: bytes.length, nSessions: (slpData.sessions || []).length, evicted, peakMB: Math.round(peak / 1e6), perSession: [] };

    for (let si = 0; si < (slpData.sessions || []).length; si++) {
      const sess0 = slpData.sessions[si];
      const calibKeys = Object.keys(sess0.calibration || {}).filter(k => k !== 'metadata');
      const fresh = new Session(
        calibKeys.map(k => { const c = sess0.calibration[k]; return new Camera(c.name || k, c.matrix, c.distortions, c.rotation, c.translation, c.size); }),
        new Skeleton(slpData.skeleton.name, slpData.skeleton.nodes, slpData.skeleton.edges),
        slpData.tracks, 'reopened' + si);
      let recon = null;
      if (sess0._typedSession) {
        recon = await slpimp.reconstructInstanceGroupsFromSession(fresh, sess0._typedSession, sess0, slpData.skeleton.nodes, {});
      }
      let groups = 0, groupsWith3d = 0;
      for (const [, gs] of fresh.instanceGroups) for (const g of gs) { groups++; if (g.points3d && g.points3d.some(p => p)) groupsWith3d++; }
      out.perSession.push({
        calibCamNames: calibKeys.map(k => (sess0.calibration[k].name || k)).sort(),
        calibFx: calibKeys.length ? sess0.calibration[calibKeys[0]].matrix[0][0] : null,
        groups, groupsWith3d, reconOk: !!recon,
      });
    }
    return out;
  });

  console.log('  measured:', JSON.stringify(r));
  if (r.saveErr) {
    check(false, 'saveAllSessionsStreaming did not throw: ' + r.saveErr);
  } else {
    check(r.nSessions === 2, `both sessions present in the saved file (got ${r.nSessions})`);
    check(r.evicted === true, 'every session\'s lazyLoader was evicted as a side effect of the save');
    const [A, B] = r.perSession;
    check(!!A && !!B, 'both sessions reconstructed');
    if (A && B) {
      check(JSON.stringify(A.calibCamNames) === JSON.stringify(['a_cam0', 'a_cam1']), `session A keeps ONLY its own cameras (got ${JSON.stringify(A.calibCamNames)})`);
      check(JSON.stringify(B.calibCamNames) === JSON.stringify(['b_cam0', 'b_cam1']), `session B keeps ONLY its own cameras (got ${JSON.stringify(B.calibCamNames)})`);
      check(A.calibFx === 1000, `session A calibration not swapped with B's (fx=${A.calibFx})`);
      check(B.calibFx === 2000, `session B calibration not swapped with A's (fx=${B.calibFx})`);
      check(A.reconOk === true && B.reconOk === true, 'both sessions used the typed reconstruction path');
      check(A.groups === 6 && A.groupsWith3d === 6, `session A: all 6 groups reconstructed with 3D (got ${A.groups}/${A.groupsWith3d})`);
      check(B.groups === 5 && B.groupsWith3d === 5, `session B: all 5 groups reconstructed with 3D (got ${B.groups}/${B.groupsWith3d})`);
    }
  }

  await browser.close();
} finally {
  server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
