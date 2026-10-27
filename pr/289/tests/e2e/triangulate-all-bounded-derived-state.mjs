/**
 * triangulate-all-bounded-derived-state.mjs — Triangulate All keeps only the
 * 3D; each frame's reprojections and errors are derived from it when the frame
 * is shown, and kept for a bounded number of frames.
 *
 * ## The bug
 * On an eagerly loaded 17-camera, 34-node, 36,000-frame project, Triangulate
 * All ▸ Refined crashed the renderer ("Aw, Snap!", error code 5) at ~80% with
 * one animal, and at ~55% with three. Its in-memory path kept every group's
 * reprojections into every camera and every frame's per-camera errors in
 * `state.triangulationResults` — ~52 KB of small arrays per group, +1.9 GB of
 * the renderer's ~4 GB JS heap. The windowed path already kept only the 3D.
 *
 * ## What this pins (synthetic eager project, DERIVED_FRAMES_KEEP + 100 frames)
 *   1. After Triangulate All (inline, and on the worker pool): every group has
 *      its 3D — bit-identical to an independent solve of its member cameras —
 *      and only the frame on screen has reprojections or results. THE memory
 *      shape, which fails on the old build (it kept all frames).
 *   2. Showing a frame derives exactly what the old path stored: errors in the
 *      member cameras, value for value, both means, and reprojections in every
 *      camera — including one the animal has no detection in — without
 *      re-solving (the result's 3D is the group's own array).
 *   3. Showing every frame in turn keeps at most DERIVED_FRAMES_KEEP frames'
 *      state: the most recent ones, plus a frame holding an edited (dirty)
 *      group, which keeps its old reprojections until re-triangulated, and is
 *      re-solved rather than reprojected. A dropped frame shown again gets the
 *      same numbers back.
 *   4. With a reprojection-error threshold set, the fill STILL reprojects the
 *      stored 3D. It used to re-solve, which drew a different 3D than the one
 *      in the 3D view and the saved file (review of PR #289); see
 *      `fillLazyReprojections` in ui/rendering.js.
 *   5. Save Reprojections (`buildReprojH5`) writes every frame, shown or not
 *      — it used to skip any group with no stored reprojections.
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
const PORT = Number(process.env.PORT || 8303);

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
    const SET = await import('/ui/settings.js');
    const FIO = await import('/import-export/file-io.js');
    const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
    const KEEP = RND.DERIVED_FRAMES_KEEP || 600;   // (|| for running this on an older build)
    const NF = KEEP + 100;
    const F = await buildBaRigFixture({ frames: NF, cycle: 8 });
    const cams = F.cams;
    const MISSING_CAM = 'camC', MISSING_TRACK = 1, MISSING_FRAME = 3, DIRTY_FRAME = 5;

    const boot = (session) => {
      AS.state.sessions = [session];
      AS.state.activeSessionIdx = 0;
      AS.state.session = session;
      AS.state.totalFrames = NF;
      AS.state.currentFrame = 0;
      AS.state.views = [];
      AS.state.triangulationResults = new Map();
    };
    const mkEager = (name) => {
      const s = F.mkSession(name, { eager: true });
      const list = s.getFrameGroup(MISSING_FRAME).instances.get(MISSING_CAM);
      list.splice(list.findIndex(inst => inst.trackIdx === MISSING_TRACK), 1);
      return s;
    };
    const groupsOf = (f) => TRI.getInstanceGroupsForFrame(f) || [];
    const sameArr = (a, b) => {
      if (a == null || b == null) return a === b;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        if (Array.isArray(x) || Array.isArray(y)) { if (!sameArr(x, y)) return false; }
        else if (!Object.is(x, y)) return false;
      }
      return true;
    };
    const keyList = (o) => Object.keys(o || {}).sort().join(',');
    const derivedFrames = (s) => {
      const fr = [];
      for (const [f, gs] of s.instanceGroups) {
        if (gs.some(g => g.reprojections || (g.reprojectedInstances && g.reprojectedInstances.size))) fr.push(f);
      }
      return fr.sort((a, b) => a - b);
    };
    const statusText = () => ((document.getElementById('statusText') || {}).textContent || '').trim();

    // What the old in-memory path stored for a group: the solve of its member
    // cameras (prep.groupCameras), plus reprojections into the other cameras.
    const expectedFor = (g) => {
      const members = cams.filter(c => g.getInstance(c.name));
      const r = TRI.triangulateAndReproject(g, members, { method: g.triangulationMethod === 'ba' ? 'ba' : 'dlt' });
      r.reprojections = TRI.reprojectIntoEveryCamera(Object.assign({}, r.reprojections), r.points3d, cams);
      r.memberNames = members.map(c => c.name).sort().join(',');
      return r;
    };
    // Compare what the fill derived for frame f against `expected` (by group).
    const verifyFrame = (f, expected, wantFast) => {
      const results = AS.state.triangulationResults.get(f) || [];
      const bad = [];
      for (const g of groupsOf(f)) {
        const e = expected.get(g);
        const r = results.find(x => x.group === g);
        if (!r) { bad.push('no result'); continue; }
        if (wantFast && r.points3d !== g.points3d) bad.push('re-solved instead of reprojecting');
        if (keyList(r.errors) !== e.memberNames) bad.push('error cameras ' + keyList(r.errors));
        for (const cn of Object.keys(e.errors)) {
          if (!sameArr(r.errors[cn], e.errors[cn])) bad.push('errors ' + cn);
          if (!sameArr(r.errorsUndistorted[cn], e.errorsUndistorted[cn])) bad.push('undistorted errors ' + cn);
        }
        if (!Object.is(r.meanError, e.meanError)) bad.push(`mean ${r.meanError} vs ${e.meanError}`);
        if (!Object.is(r.meanErrorUndistorted, e.meanErrorUndistorted)) bad.push('undistorted mean');
        for (const c of cams) if (!sameArr(g.reprojections && g.reprojections[c.name], e.reprojections[c.name])) bad.push('reprojection ' + c.name);
      }
      return bad;
    };

    const prevPref = SET.getDefaultTriangulationMethod();
    const prevThr = SET.getTrackingThresholds();
    SET.setDefaultTriangulationMethod('ba');
    const res = {};

    // ---- 1. Triangulate All ▸ Refined, in-memory path ----------------------
    const sA = mkEager('A');
    boot(sA);
    await TRI.triangulateAllFrames('ba');
    res.statusA = statusText();
    res.windowedA = !!sA.lazyLoader;
    let groups = 0, with3d = 0, notBa = 0, dirty = 0, d3mismatch = 0;
    const expected = new Map();
    for (const [, gs] of sA.instanceGroups) {
      for (const g of gs) {
        groups++;
        if (g.points3d && g.points3d.length) with3d++;
        if (g.triangulationMethod !== 'ba') notBa++;
        if (g.dirty) dirty++;
        const e = expectedFor(g);
        expected.set(g, e);
        if (!sameArr(Array.from(g.points3d), Array.from(e.points3d))) d3mismatch++;
      }
    }
    Object.assign(res, { groups, with3d, notBa, dirty, d3mismatch,
      resultFramesA: [...AS.state.triangulationResults.keys()], derivedA: derivedFrames(sA) });
    let errSum = 0, errN = 0;
    for (const e of expected.values()) if (e.meanError != null) { errSum += e.meanError; errN++; }
    res.expectedAvg = (errSum / errN).toFixed(2);

    // ---- 2+3. show every frame in turn --------------------------------------
    const blue = groupsOf(MISSING_FRAME).find(g => !g.getInstance(MISSING_CAM));
    res.bluePrecondition = !!blue;
    groupsOf(DIRTY_FRAME)[0].markDirty();
    const perFrameBad = [];
    let missingCamOk = false;
    let maxResults = 0;
    for (let f = 1; f < NF; f++) {
      AS.state.currentFrame = f;
      RND.drawAllOverlays(f);
      maxResults = Math.max(maxResults, AS.state.triangulationResults.size);
      if (f === DIRTY_FRAME) {
        const r = (AS.state.triangulationResults.get(f) || []).find(x => x.group === groupsOf(f)[0]);
        res.dirtyResolved = !!r && r.points3d !== groupsOf(f)[0].points3d;
        continue;
      }
      const bad = verifyFrame(f, expected, true);
      if (bad.length) perFrameBad.push({ f, bad: bad.slice(0, 3) });
      if (f === MISSING_FRAME) missingCamOk = !!(blue.reprojections && blue.reprojections[MISSING_CAM]) && !bad.length;
    }
    res.perFrameBad = perFrameBad.slice(0, 5);
    res.nBadFrames = perFrameBad.length;
    res.missingCamOk = missingCamOk;
    res.maxResults = maxResults;
    res.derivedAfter = derivedFrames(sA);
    res.resultFramesAfter = [...AS.state.triangulationResults.keys()].sort((a, b) => a - b);
    const want = [DIRTY_FRAME];
    for (let f = NF - KEEP; f < NF; f++) want.push(f);
    res.wantRetained = want;

    // a dropped frame shown again: the same numbers back
    AS.state.currentFrame = 10;
    RND.drawAllOverlays(10);
    res.revisitBad = verifyFrame(10, expected, true);

    // ---- 4. a reprojection-error threshold still shows the stored 3D ----------
    SET.setTrackingThresholds(Object.assign({}, prevThr, { reprojErrorThreshold: 5 }));
    res.thresholdSet = SET.getTrackingThreshold('reprojErrorThreshold');
    AS.state.currentFrame = 20;
    RND.drawAllOverlays(20);
    const g20 = groupsOf(20)[0];
    const r20 = (AS.state.triangulationResults.get(20) || []).find(x => x.group === g20);
    res.thresholdStored = !!r20 && r20.points3d === g20.points3d;
    SET.setTrackingThresholds(prevThr);

    // ---- 5. Save Reprojections writes every frame ----------------------------
    await window.h5wasm.ready;
    const blob = await FIO.buildReprojH5(sA);
    const fn = '/_reproj_bounded.h5';
    window.h5wasm.FS.writeFile(fn, new Uint8Array(await blob.arrayBuffer()));
    const h5 = new window.h5wasm.File(fn, 'r');
    let shape, data, frameIdx;
    try {
      const d = h5.get('reprojections');
      shape = d.shape; data = d.value;
      frameIdx = Array.from(h5.get('frame_indices').value);
    } finally { h5.close(); }
    const [nF, nT, nC, nN] = shape;
    let expEntries = 0, exportMissing = 0, exportWrong = 0;
    for (let fi = 0; fi < nF; fi++) {
      for (const g of groupsOf(frameIdx[fi])) {
        const e = expected.get(g);
        for (let ci = 0; ci < nC; ci++) {
          const pts = e.reprojections[cams[ci].name];
          for (let k = 0; k < Math.min(nN, pts.length); k++) {
            if (!pts[k]) continue;
            expEntries++;
            const b = ((((fi * nT + g.identityId) * nC + ci) * nN + k) * 2);
            if (Number.isNaN(data[b])) exportMissing++;
            else if (data[b] !== pts[k][0] || data[b + 1] !== pts[k][1]) exportWrong++;
          }
        }
      }
    }
    Object.assign(res, { exportFrames: nF, expEntries, exportMissing, exportWrong });

    // ---- 1b. the same on the worker pool -------------------------------------
    window.LUCID_TRIANGULATION_WORKERS = 2;
    const OrigWorker = window.Worker;
    let triWorkers = 0;
    window.Worker = function (url, o) {
      if (String(url).includes('triangulation-worker')) triWorkers++;
      return new OrigWorker(url, o);
    };
    window.Worker.prototype = OrigWorker.prototype;
    const sW = mkEager('W');
    boot(sW);
    try { await TRI.triangulateAllFrames('ba'); } finally {
      window.Worker = OrigWorker;
      delete window.LUCID_TRIANGULATION_WORKERS;
    }
    res.triWorkers = triWorkers;
    res.statusW = statusText();
    let wMismatch = 0;
    const aGroups = [...sA.instanceGroups.values()].flat(), wGroups = [...sW.instanceGroups.values()].flat();
    for (let i = 0; i < aGroups.length; i++) {
      if (!wGroups[i] || !sameArr(Array.from(aGroups[i].points3d), Array.from(wGroups[i].points3d))) wMismatch++;
    }
    res.wMismatch = wMismatch;
    res.wGroups = wGroups.length;
    res.resultFramesW = [...AS.state.triangulationResults.keys()];
    res.derivedW = derivedFrames(sW);

    // ---- DLT, one frame -------------------------------------------------------
    const sD = mkEager('D');
    boot(sD);
    await TRI.triangulateAllFrames('dlt');
    const expD = new Map();
    for (const g of groupsOf(40)) expD.set(g, expectedFor(g));
    AS.state.currentFrame = 40;
    RND.drawAllOverlays(40);
    res.dltBad = verifyFrame(40, expD, true);
    res.dltMethods = groupsOf(40).map(g => g.triangulationMethod);

    SET.setDefaultTriangulationMethod(prevPref);
    return Object.assign(res, { NF, KEEP, worstIdealR: F.worstIdealR, rFoldPx: F.rFoldPx });
  });

  console.log(`    ${out.NF} frames, ${out.groups} groups; keep ${out.KEEP} frames; status "${out.statusA}"`);
  check(out.worstIdealR < 0.5 * out.rFoldPx,
    `precondition: every observation well inside the distortion fold radius (${out.worstIdealR.toFixed(0)} < ${(0.5 * out.rFoldPx).toFixed(0)} px)`);
  check(!out.windowedA && new RegExp(`^Triangulated ${out.NF} frames via Refined`).test(out.statusA),
    `precondition: the IN-MEMORY Triangulate All path ran over all ${out.NF} frames`);
  check(out.groups === 2 * out.NF && out.with3d === out.groups && out.notBa === 0 && out.dirty === 0,
    `every group has Refined 3D and is clean (${out.with3d}/${out.groups}, ${out.notBa} not Refined, ${out.dirty} dirty)`);
  check(out.d3mismatch === 0, `every group's 3D is bit-identical to an independent solve of its member cameras (${out.d3mismatch} differ)`);
  check(out.statusA.includes(`avg error: ${out.expectedAvg}px`) && +out.expectedAvg > 0 && +out.expectedAvg < 10,
    `the status's average error is the solves' (${out.expectedAvg} px)`);
  check(JSON.stringify(out.resultFramesA) === '[0]' && JSON.stringify(out.derivedA) === '[0]',
    `only the frame on screen has results or reprojections after Triangulate All ` +
    `(results ${JSON.stringify(out.resultFramesA.slice(0, 5))}…${out.resultFramesA.length}, reprojections ${out.derivedA.length} frames)`);

  check(out.bluePrecondition, `precondition: an animal has no camC instance on frame 3`);
  check(out.nBadFrames === 0,
    `each frame shown derives the old path's numbers, value for value, without re-solving (${out.nBadFrames} frames differ` +
    (out.nBadFrames ? `: ${JSON.stringify(out.perFrameBad)}` : '') + ')');
  check(out.missingCamOk, 'including the reprojection into a camera the animal has no detection in');
  check(out.dirtyResolved === true, 'an edited (dirty) group is re-solved, not reprojected');
  check(out.maxResults <= out.KEEP + 1, `results never held more than ${out.KEEP} frames + the dirty one (max ${out.maxResults})`);
  check(JSON.stringify(out.resultFramesAfter) === JSON.stringify(out.wantRetained) &&
        JSON.stringify(out.derivedAfter) === JSON.stringify(out.wantRetained),
    `after showing all ${out.NF} frames, kept exactly the last ${out.KEEP} and the dirty frame ` +
    `(results ${out.resultFramesAfter.length}, reprojections ${out.derivedAfter.length}; first kept ${out.resultFramesAfter.slice(0, 3)})`);
  check(out.revisitBad.length === 0, `a dropped frame shown again gets the same numbers back (${JSON.stringify(out.revisitBad)})`);
  check(out.thresholdSet === 5 && out.thresholdStored === true,
    `with a reprojection-error threshold (${out.thresholdSet} px) the fill still shows the stored 3D, not a re-solve`);
  check(out.exportFrames === out.NF && out.expEntries > 0 && out.exportMissing === 0 && out.exportWrong === 0,
    `Save Reprojections writes every frame, shown or not (${out.exportFrames} frames, ${out.expEntries} points, ` +
    `${out.exportMissing} missing, ${out.exportWrong} wrong)`);
  check(out.triWorkers > 0 && out.wGroups === out.groups,
    `precondition: the worker-pool run started ${out.triWorkers} triangulation workers and has the same ${out.wGroups} groups`);
  check(out.wMismatch === 0, `worker pool: 3D bit-identical to inline (${out.wMismatch} groups differ)`);
  check(JSON.stringify(out.resultFramesW) === '[0]' && JSON.stringify(out.derivedW) === '[0]',
    `worker pool: only the frame on screen has results or reprojections`);
  check(out.dltBad.length === 0 && out.dltMethods.every(m => m === 'dlt'),
    `DLT: a shown frame derives the solve's numbers (${JSON.stringify(out.dltBad)})`);
  check(errs.length === 0, `no page errors (${errs.length})${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);

  await browser.close();
} finally {
  server.kill();
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\ntriangulate-all-bounded-derived-state: PASS');
process.exit(fails ? 1 : 0);
