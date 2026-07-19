/**
 * save-slim-metadata.mjs — round-trip guard for the slim-metadata change (#134).
 *
 * buildSlpLabelsAllViews no longer writes trackIdx/type/score/occluded per
 * grouped instance into sessions_json (they're reconstructed from the standard
 * SLP instance on load); only modified + nulledNodes are persisted, and only
 * when set. This test builds a grouped session with a mix of user/predicted,
 * tracked, modified, and occluded instances, saves it, and reconstructs it via
 * the REAL reconstructInstanceGroupsFromSession — asserting every field
 * round-trips losslessly and that sessions_json no longer carries the redundant
 * fields.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8084);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 200)); fails++; });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

  const r = await page.evaluate(async () => {
    const pd = await import('/pose/pose-data.js');
    const fileio = await import('/import-export/file-io.js');
    const slpImport = await import('/import-export/slp-import.js');
    const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
    const mtx = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
    const camDefs = ['cam1', 'cam2'];
    const cams = camDefs.map((n, i) => new Camera(n, mtx, [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [512, 512]));
    const NODES = 4;
    const skel = new Skeleton('sk', Array.from({ length: NODES }, (_, i) => 'n' + i), Array.from({ length: NODES - 1 }, (_, i) => [i, i + 1]));

    function buildSession() {
      const s = new Session(cams, skel, ['trackA', 'trackB'], 'RT');
      const idA = s.addIdentity('A'), idB = s.addIdentity('B');
      const fg = new FrameGroup(0); s.addFrameGroup(fg);
      // Group A: track 0, identity A, cam1 = USER + modified + node2 occluded/nulled; cam2 = predicted score 0.77.
      const gA = new InstanceGroup(1, idA.id);
      const a1 = new Instance([[10, 20], [11, 21], [12, 22], [13, 23]], 0, 'user', 1);
      a1.modified = true; a1.nulledNodes = new Set([2]);
      const a2 = new Instance([[30, 40], [31, 41], [32, 42], [33, 43]], 0, 'predicted', 0.77);
      gA.addInstance('cam1', a1); gA.addInstance('cam2', a2);
      fg.addInstance('cam1', a1); fg.addInstance('cam2', a2);
      gA.points3d = [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]];
      // Group B: track 1, identity B, both predicted, unmodified.
      const gB = new InstanceGroup(2, idB.id);
      const b1 = new Instance([[50, 60], [51, 61], [52, 62], [53, 63]], 1, 'predicted', 0.55);
      const b2 = new Instance([[70, 80], [71, 81], [72, 82], [73, 83]], 1, 'predicted', 0.66);
      gB.addInstance('cam1', b1); gB.addInstance('cam2', b2);
      fg.addInstance('cam1', b1); fg.addInstance('cam2', b2);
      s.instanceGroups.set(0, [gA, gB]);
      return s;
    }

    const s = buildSession();
    const views = camDefs.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: 5 }));
    const vf = camDefs.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
    const labels = fileio.buildSlpLabelsAllViews(s, views, vf);
    const bytes = await window.SleapIO.saveSlpToBytes(labels);
    const file = new File([bytes], 'x.slp');
    const re = await window.SleapIO.readSlpStreaming(file, { openVideos: false, rawSessions: true, h5wasmUrl: new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href });

    // (1) Metadata must be slim. Under SLP 2.8 (#546/#224) the per-group
    // metadata.lucid.instanceMeta lives in the columnar /session_data/
    // instance_group_meta dataset, surfaced on the TYPED InstanceGroup (not in
    // the inline sessions_json, which no longer carries frame_group_dicts).
    const raw = re.rawSessionsJson[0];
    const typedForMeta = (re.sessions && re.sessions[0]) || null;
    let sawTrackIdxField = false, sawTypeField = false, sawScoreField = false, metaEntries = 0;
    if (typedForMeta && typedForMeta.frameGroups) {
      for (const [, fg] of typedForMeta.frameGroups) {
        for (const ig of (fg.instanceGroups || [])) {
          const im = (ig.metadata && ig.metadata.lucid && ig.metadata.lucid.instanceMeta) || {};
          for (const cam of Object.keys(im)) {
            metaEntries++;
            if ('trackIdx' in im[cam]) sawTrackIdxField = true;
            if ('type' in im[cam]) sawTypeField = true;
            if ('score' in im[cam]) sawScoreField = true;
          }
        }
      }
    }

    // (2) Reconstruct into a fresh session via the REAL loader.
    const fresh = new Session(cams, skel, ['trackA', 'trackB'], 'RT');
    fresh.addIdentity('A'); fresh.addIdentity('B');
    const typedSession = re.labels && re.labels.sessions ? re.labels.sessions[0] : (re.sessions ? re.sessions[0] : null);
    // readSlpStreaming returns a Labels-like; find the typed RecordingSession.
    const typed = (re.sessions && re.sessions[0]) || (re.labels && re.labels.sessions && re.labels.sessions[0]) || re._typedSessions?.[0];
    await slpImport.reconstructInstanceGroupsFromSession(fresh, typed || re.rawTypedSessions?.[0] || re.typedSessions?.[0], raw, skel.nodes, {});

    const groups = fresh.instanceGroups.get(0) || [];
    const byIdentity = {};
    for (const g of groups) byIdentity[g.identityId] = g;
    const gA2 = groups.find(g => g.getInstance('cam1') && g.getInstance('cam1').modified) || groups[0];
    // Find reconstructed A/B by their instance data.
    let recA = null, recB = null;
    for (const g of groups) {
      const c1 = g.getInstance('cam1');
      if (c1 && Math.abs(c1.points[0][0] - 10) < 0.5) recA = g;
      if (c1 && Math.abs(c1.points[0][0] - 50) < 0.5) recB = g;
    }
    const outA = recA ? {
      cam1Type: recA.getInstance('cam1').type,
      cam1Track: recA.getInstance('cam1').trackIdx,
      cam1Modified: recA.getInstance('cam1').modified,
      cam1Nulled: recA.getInstance('cam1').nulledNodes ? Array.from(recA.getInstance('cam1').nulledNodes) : null,
      cam2Type: recA.getInstance('cam2').type,
      cam2Score: recA.getInstance('cam2').score,
      identityId: recA.identityId,
      has3d: !!(recA.points3d && recA.points3d.length),
    } : null;
    const outB = recB ? {
      cam1Type: recB.getInstance('cam1').type,
      cam1Track: recB.getInstance('cam1').trackIdx,
      cam1Modified: recB.getInstance('cam1').modified,
      cam1Score: recB.getInstance('cam1').score,
    } : null;

    return { metaEntries, sawTrackIdxField, sawTypeField, sawScoreField, nGroups: groups.length, outA, outB };
  });

  console.log('  measured:', JSON.stringify(r));
  check(r.sawTrackIdxField === false, 'sessions_json metadata carries NO trackIdx field (reconstructed)');
  check(r.sawTypeField === false, 'sessions_json metadata carries NO type field (reconstructed)');
  check(r.sawScoreField === false, 'sessions_json metadata carries NO score field (reconstructed)');
  check(r.metaEntries === 1, `only the modified/occluded instance emits metadata (got ${r.metaEntries})`);
  check(r.nGroups === 2, `both groups reconstructed (got ${r.nGroups})`);
  check(!!r.outA, 'group A reconstructed');
  if (r.outA) {
    check(r.outA.cam1Type === 'user', `A.cam1 type=user reconstructed (got ${r.outA.cam1Type})`);
    check(r.outA.cam1Track === 0, `A.cam1 trackIdx=0 reconstructed (got ${r.outA.cam1Track})`);
    check(r.outA.cam1Modified === true, 'A.cam1 modified=true preserved');
    check(JSON.stringify(r.outA.cam1Nulled) === '[2]', `A.cam1 nulledNodes=[2] preserved (got ${JSON.stringify(r.outA.cam1Nulled)})`);
    check(r.outA.cam2Type === 'predicted', `A.cam2 type=predicted reconstructed (got ${r.outA.cam2Type})`);
    check(Math.abs(r.outA.cam2Score - 0.77) < 0.02, `A.cam2 score≈0.77 reconstructed (got ${r.outA.cam2Score})`);
    check(r.outA.identityId === 0, `A identityId=0 preserved (got ${r.outA.identityId})`);
    check(r.outA.has3d === true, 'A 3D points preserved');
  }
  if (r.outB) {
    check(r.outB.cam1Track === 1, `B.cam1 trackIdx=1 reconstructed (got ${r.outB.cam1Track})`);
    check(r.outB.cam1Modified === false, 'B.cam1 modified=false (unmodified stays unmodified)');
    check(Math.abs(r.outB.cam1Score - 0.55) < 0.02, `B.cam1 score≈0.55 reconstructed (got ${r.outB.cam1Score})`);
  }

  await browser.close();
} finally {
  server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
