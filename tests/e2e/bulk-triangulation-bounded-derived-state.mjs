/**
 * bulk-triangulation-bounded-derived-state.mjs — Group by Track, Triangulate
 * Range and the multi-frame identity assignment keep only the 3D; a frame's
 * reprojections and errors are derived from it when the frame is shown.
 *
 * ## The bug
 * Triangulate All's in-memory path kept every group's reprojections into every
 * camera and every frame's per-camera errors in `state.triangulationResults` —
 * ~52 KB per group on a 17-camera, 34-node project, +1.9 GB on 36,000 frames,
 * and with three animals the renderer ran out of memory at 56% (fixed by
 * #351; `tests/e2e/triangulate-all-bounded-derived-state.mjs`). Three other
 * bulk paths kept the same state for every frame they processed:
 *   * Tracks ▸ Group by Track (`ui/export-modals.js`);
 *   * Triangulate Range (`triangulateMultiFrameInstances`), whose range can be
 *     the whole project;
 *   * the multi-frame identity assignment (`runMultiFrameAssignment`,
 *     `ui/identity-assignment.js`), which kept each frame's reprojections AND a
 *     reprojected `Instance` per camera per group.
 * And each ended by walking `state.triangulationResults` to update the
 * timeline, so with that map no longer holding every frame the walk would
 * have missed them (the assignment never wrote it at all).
 *
 * ## What this pins (synthetic eager project, DERIVED_FRAMES_KEEP + 100 frames)
 *   G. Group by Track, through its real modal: every group's 3D is
 *      bit-identical to an independent solve of its member cameras; only the
 *      frame on screen has results or reprojections (THE memory shape, which
 *      fails on the old build — it kept every frame); the status's average
 *      error is the solves'; every regrouped frame's timeline mark is updated;
 *      a shown frame derives the old path's numbers without re-solving. A
 *      re-run that adopts every group leaves no frame holding results for the
 *      groups it replaced.
 *   R. Triangulate Range (backend): re-solves exactly the range, drops the
 *      derived state of the frames it re-solved and of no other, returns the
 *      frames and the error sums; a shown frame derives the new solve's numbers.
 *      Then through its real modal: the timeline marks are the frames it
 *      re-solved, and only the frame on screen has derived state.
 *   M. Multi-frame identity assignment over every frame: at most
 *      DERIVED_FRAMES_KEEP frames keep derived state (the last ones); every
 *      assigned frame's timeline mark is updated; a dropped frame shown again
 *      is reprojected from its stored 3D.
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
const PORT = Number(process.env.PORT || 8304);

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
    const EM = await import('/ui/export-modals.js');
    const IA = await import('/ui/identity-assignment.js');
    const PD = await import('/pose/pose-data.js');
    const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
    const KEEP = RND.DERIVED_FRAMES_KEEP || 600;   // (|| for running this on an older build)
    const NF = KEEP + 100;
    const F = await buildBaRigFixture({ frames: NF, cycle: 8 });
    const cams = F.cams;
    const MISSING_CAM = 'camC', MISSING_TRACK = 1, MISSING_FRAME = 3;

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
    const allGroups = (s) => [...s.instanceGroups.values()].flat();
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
    const resultFrames = () => [...AS.state.triangulationResults.keys()].sort((a, b) => a - b);
    const statusText = () => ((document.getElementById('statusText') || {}).textContent || '').trim();
    const range = (a, b) => { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; };
    const setEq = (calls, want) => {
      const got = [...new Set(calls)].sort((a, b) => a - b);
      return JSON.stringify(got) === JSON.stringify([...want].sort((a, b) => a - b));
    };

    // What the old paths stored for a group: the solve of its member cameras
    // (`groupCameras`), plus reprojections into the other cameras.
    const expectedFor = (g) => {
      const members = cams.filter(c => g.getInstance(c.name));
      const r = TRI.triangulateAndReproject(g, members, { method: g.triangulationMethod === 'ba' ? 'ba' : 'dlt' });
      r.reprojections = TRI.reprojectIntoEveryCamera(Object.assign({}, r.reprojections), r.points3d, cams);
      r.memberNames = members.map(c => c.name).sort().join(',');
      return r;
    };
    const expectAll = (s, pick) => {
      const m = new Map();
      for (const g of allGroups(s)) if (!pick || pick(g)) m.set(g, expectedFor(g));
      return m;
    };
    const d3Mismatch = (expected) => {
      let n = 0;
      for (const [g, e] of expected) if (!sameArr(Array.from(g.points3d), Array.from(e.points3d))) n++;
      return n;
    };
    const avgOf = (expected) => {
      let sum = 0, n = 0;
      for (const e of expected.values()) if (e.meanError != null) { sum += e.meanError; n++; }
      return { sum, n, avg: (sum / n).toFixed(2) };
    };
    // Show frame f, then compare what the fill derived against `expected`.
    const showAndVerify = (f, expected) => {
      AS.state.currentFrame = f;
      RND.drawAllOverlays(f);
      const results = AS.state.triangulationResults.get(f) || [];
      const bad = [];
      for (const g of groupsOf(f)) {
        const e = expected.get(g);
        const r = results.find(x => x.group === g);
        if (!e) { bad.push('no expectation'); continue; }
        if (!r) { bad.push('no result'); continue; }
        if (r.points3d !== g.points3d) bad.push('re-solved instead of reprojecting');
        if (keyList(r.errors) !== e.memberNames) bad.push('error cameras ' + keyList(r.errors));
        for (const cn of Object.keys(e.errors)) {
          if (!sameArr((r.errors || {})[cn], e.errors[cn])) bad.push('errors ' + cn);
          if (!sameArr((r.errorsUndistorted || {})[cn], e.errorsUndistorted[cn])) bad.push('undistorted errors ' + cn);
        }
        if (!Object.is(r.meanError, e.meanError)) bad.push(`mean ${r.meanError} vs ${e.meanError}`);
        if (!Object.is(r.meanErrorUndistorted, e.meanErrorUndistorted)) bad.push('undistorted mean');
        for (const c of cams) if (!sameArr(g.reprojections && g.reprojections[c.name], e.reprojections[c.name])) bad.push('reprojection ' + c.name);
      }
      return bad;
    };
    // A timeline that records which frames' modified marks were set. Every
    // other method is a no-op: the frames are the question here, not the paint.
    const origTimeline = AS.timeline;
    const spyTimeline = () => {
      const calls = [];
      AS.setTimeline(new Proxy({}, {
        get: (t, k) => k === 'setFrameModified' ? (f) => { calls.push(f); } : () => {},
      }));
      return calls;
    };
    const waitGone = async (id, ms) => {
      for (let i = 0; i < ms / 50 && document.getElementById(id); i++) await new Promise(r => setTimeout(r, 50));
      return !document.getElementById(id);
    };
    const waitFor = async (id, ms) => {
      for (let i = 0; i < ms / 50 && !document.getElementById(id); i++) await new Promise(r => setTimeout(r, 50));
      return !!document.getElementById(id);
    };

    const prevPref = SET.getDefaultTriangulationMethod();
    SET.setDefaultTriangulationMethod('ba');
    const res = { NF, KEEP };

    try {
      // ---- G. Tracks ▸ Group by Track, through its real modal ---------------
      const sG = mkEager('G');
      boot(sG);
      let tl = spyTimeline();
      EM.showGroupByTrackModal();
      document.getElementById('gbtGo').click();
      res.gModalGone = await waitGone('gbtGo', 120000);
      res.gStatus = statusText();
      const gGroups = allGroups(sG);
      const expG = expectAll(sG);
      Object.assign(res, {
        gGroups: gGroups.length,
        gWith3d: gGroups.filter(g => g.points3d && g.points3d.length).length,
        gNotBa: gGroups.filter(g => g.triangulationMethod !== 'ba').length,
        gDirty: gGroups.filter(g => g.dirty).length,
        gD3Mismatch: d3Mismatch(expG),
        gExpectedAvg: avgOf(expG).avg,
        gResultFrames: resultFrames(), gDerived: derivedFrames(sG),
        gTimelineOk: setEq(tl, range(0, NF - 1)), gTimelineCalls: new Set(tl).size,
      });
      res.gBlue = groupsOf(MISSING_FRAME).some(g => !g.getInstance(MISSING_CAM));
      res.gShowBad = [];
      for (const f of [MISSING_FRAME, 10, NF - 1]) {
        const bad = showAndVerify(f, expG);
        if (bad.length) res.gShowBad.push({ f, bad: bad.slice(0, 3) });
      }
      // Re-run: identical membership + method, so every group is adopted (no
      // solve). The groups are new objects, so the shown frames' results —
      // which name the old ones — must go too.
      res.gShownBefore = resultFrames();
      AS.state.currentFrame = 0;
      tl = spyTimeline();
      EM.showGroupByTrackModal();
      document.getElementById('gbtGo').click();
      res.gModalGone2 = await waitGone('gbtGo', 120000);
      res.gStatus2 = statusText();
      res.gResultFrames2 = resultFrames();
      res.gDerived2 = derivedFrames(sG);
      res.gStaleEntries = 0;
      for (const [f, list] of AS.state.triangulationResults) {
        for (const r of list) if (!groupsOf(f).includes(r.group)) res.gStaleEntries++;
      }
      res.gTimelineOk2 = setEq(tl, range(0, NF - 1));

      // ---- R. Triangulate Range (backend) -------------------------------------
      const sR = mkEager('R');
      boot(sR);
      AS.setTimeline(origTimeline);
      await TRI.triangulateAllFrames('ba');
      const OUT = 50, IN = 300, R0 = 100, R1 = NF - 1;
      AS.state.currentFrame = OUT; RND.drawAllOverlays(OUT);
      AS.state.currentFrame = IN; RND.drawAllOverlays(IN);
      AS.state.currentFrame = 0;
      res.rShownBefore = resultFrames();
      const before3d = new Map(allGroups(sR).map(g => [g, Float64Array.from(g.points3d)]));
      const r = await TRI.triangulateMultiFrameInstances(R0, R1, null, 'dlt');
      const inRange = (g) => { for (const [f, gs] of sR.instanceGroups) if (gs.includes(g)) return f >= R0 && f <= R1; return false; };
      const expR = expectAll(sR, inRange);
      let outChanged = 0, outNotBa = 0;
      for (const g of allGroups(sR)) {
        if (inRange(g)) continue;
        if (!sameArr(Array.from(g.points3d), Array.from(before3d.get(g)))) outChanged++;
        if (g.triangulationMethod !== 'ba') outNotBa++;
      }
      const avgR = avgOf(expR);
      Object.assign(res, {
        rRet: { triangulated: r.triangulated, totalGroups: r.totalGroups, errN: r.errN,
                framesOk: JSON.stringify(r.frames) === JSON.stringify(range(R0, R1)),
                hasTotalErrors: 'totalErrors' in r },
        rWantFrames: R1 - R0 + 1,
        rErrOk: r.errN === avgR.n && Math.abs(r.errSum - avgR.sum) < 1e-9 * Math.max(1, avgR.sum),
        rInNotDlt: [...expR.keys()].filter(g => g.triangulationMethod !== 'dlt').length,
        rD3Mismatch: d3Mismatch(expR), rInGroups: expR.size,
        rOutChanged: outChanged, rOutNotBa: outNotBa,
        rResultFrames: resultFrames(), rDerived: derivedFrames(sR),
      });
      res.rShowBad = showAndVerify(IN, expR);

      // ---- R2. Triangulate Range through its real modal ----------------------
      const sR2 = mkEager('R2');
      boot(sR2);
      await TRI.triangulateAllFrames('ba');
      const prior3d = new Map(allGroups(sR2).map(g => [g, g.points3d]));
      tl = spyTimeline();
      EM.showTriangulateMultiFrameModal();
      const setInput = (id, v) => {
        const el = document.getElementById(id);
        el.value = String(v);
        el.dispatchEvent(new Event('change'));
      };
      setInput('tfInputStart', 201);
      setInput('tfInputEnd', 400);
      document.getElementById('tfContinue').click();
      res.r2Done = await waitFor('tfClose', 120000);
      res.r2Label = ((document.getElementById('tfProgressLabel') || {}).textContent || '').trim();
      const resolvedFrames = [];
      for (const [f, gs] of sR2.instanceGroups) if (gs.some(g => g.points3d !== prior3d.get(g))) resolvedFrames.push(f);
      res.r2Resolved = resolvedFrames.length;
      res.r2TimelineOk = resolvedFrames.length > 0 && setEq(tl, resolvedFrames);
      res.r2TimelineCalls = new Set(tl).size;
      res.r2ResultFrames = resultFrames();
      res.r2Derived = derivedFrames(sR2);
      const expR2 = expectAll(sR2, (g) => g.points3d !== prior3d.get(g));
      res.r2ExpectedAvg = avgOf(expR2).avg;
      res.r2Groups = expR2.size;
      const closeBtn = document.getElementById('tfClose');
      if (closeBtn) closeBtn.click();

      // ---- M. multi-frame identity assignment, every frame --------------------
      const sM = F.mkSession('M', { eager: true });
      for (const [, fg] of sM.frameGroups) {
        for (const cam of cams) {
          const list = fg.instances.get(cam.name) || [];
          fg.instances.set(cam.name, []);
          for (const inst of list) fg.addUnlinkedInstance(cam.name, new PD.UnlinkedInstance(inst, cam.name));
        }
      }
      boot(sM);
      SET.setDefaultTriangulationMethod('dlt');   // brand-new groups take the default; DLT keeps the run short
      tl = spyTimeline();
      const overlayEl = document.createElement('div');
      document.body.appendChild(overlayEl);
      await IA.runMultiFrameAssignment(0, NF - 1, cams.map(c => c.name), overlayEl);
      overlayEl.remove();
      const mGroups = allGroups(sM);
      Object.assign(res, {
        mFramesWith2: [...sM.instanceGroups.values()].filter(gs => gs.length === 2).length,
        mGroups: mGroups.length,
        mGood3d: mGroups.filter(g => g.cameraNames.length === 3 && PD.points3dNodeCount(g.points3d) === F.NNODE).length,
        mDirty: mGroups.filter(g => g.dirty).length,
        mDerived: derivedFrames(sM),
        mWantDerived: range(NF - KEEP, NF - 1),
        mTimelineOk: setEq(tl, range(0, NF - 1)), mTimelineCalls: new Set(tl).size,
      });
      // a dropped frame shown again: reprojected from its stored 3D
      AS.state.currentFrame = 10;
      RND.drawAllOverlays(10);
      const results10 = AS.state.triangulationResults.get(10) || [];
      res.mRevisitBad = [];
      for (const g of groupsOf(10)) {
        const rr = results10.find(x => x.group === g);
        if (!rr) { res.mRevisitBad.push('no result'); continue; }
        if (rr.points3d !== g.points3d) res.mRevisitBad.push('re-solved instead of reprojecting');
        for (const c of cams) {
          if (!sameArr(g.reprojections && g.reprojections[c.name], TRI.reprojectPointsCamera(g.points3d, c))) res.mRevisitBad.push('reprojection ' + c.name);
        }
      }
    } finally {
      AS.setTimeline(origTimeline);
      SET.setDefaultTriangulationMethod(prevPref);
    }
    return res;
  });

  const NF = out.NF;
  console.log(`    ${NF} frames, keep ${out.KEEP}`);

  // ---- G ---------------------------------------------------------------------
  console.log(`    G: "${out.gStatus}"`);
  check(out.gModalGone, 'G precondition: the Group by Track modal ran and closed');
  check(out.gGroups === 2 * NF && out.gWith3d === out.gGroups && out.gNotBa === 0 && out.gDirty === 0,
    `G: every group has Refined 3D and is clean (${out.gWith3d}/${out.gGroups}, ${out.gNotBa} not Refined, ${out.gDirty} dirty)`);
  check(out.gD3Mismatch === 0, `G: every group's 3D is bit-identical to an independent solve of its member cameras (${out.gD3Mismatch} differ)`);
  check(new RegExp(`triangulated ${NF.toLocaleString('en-US')} frames via Refined \\(avg error: ${out.gExpectedAvg}px;`).test(out.gStatus) &&
        +out.gExpectedAvg > 0 && +out.gExpectedAvg < 10,
    `G: the status counts every frame and its average error is the solves' (${out.gExpectedAvg} px)`);
  check(JSON.stringify(out.gResultFrames) === '[0]' && JSON.stringify(out.gDerived) === '[0]',
    `G: only the frame on screen has results or reprojections ` +
    `(results ${out.gResultFrames.length} frames, reprojections ${out.gDerived.length} frames)`);
  check(out.gTimelineOk, `G: the timeline mark of every regrouped frame is updated (${out.gTimelineCalls} of ${NF} frames)`);
  check(out.gBlue, 'G precondition: an animal has no camC instance on frame 3');
  check(out.gShowBad.length === 0,
    `G: a shown frame derives the old path's numbers, value for value, without re-solving — including camC on frame 3 ` +
    `(${JSON.stringify(out.gShowBad)})`);
  check(out.gModalGone2 && new RegExp(`\\b${(2 * NF).toLocaleString('en-US')} kept existing 3D, 0 solved via Refined, 0 via DLT`).test(out.gStatus2),
    `G re-run: every group adopted, none solved ("${out.gStatus2}")`);
  check(out.gShownBefore.length > 1 && JSON.stringify(out.gResultFrames2) === '[0]' &&
        JSON.stringify(out.gDerived2) === '[0]' && out.gStaleEntries === 0,
    `G re-run: the frames shown before (${JSON.stringify(out.gShownBefore)}) no longer hold results for replaced groups ` +
    `(results ${JSON.stringify(out.gResultFrames2)}, ${out.gStaleEntries} stale entries)`);
  check(out.gTimelineOk2, 'G re-run: the timeline mark of every regrouped frame is updated');

  // ---- R ---------------------------------------------------------------------
  check(JSON.stringify(out.rShownBefore) === '[0,50,300]',
    `R precondition: frames 0, 50 and 300 had derived state before the range (${JSON.stringify(out.rShownBefore)})`);
  check(out.rRet.triangulated === out.rWantFrames && out.rRet.totalGroups === 2 * out.rWantFrames &&
        out.rRet.framesOk && !out.rRet.hasTotalErrors,
    `R: returns the re-solved frames and groups (${out.rRet.triangulated} frames, ${out.rRet.totalGroups} groups, ` +
    `frames ${out.rRet.framesOk ? 'listed in order' : 'WRONG'})`);
  check(out.rErrOk, `R: its error sum and count are the solves' (${out.rRet.errN} groups)`);
  check(out.rInNotDlt === 0 && out.rD3Mismatch === 0 && out.rInGroups === 2 * out.rWantFrames,
    `R: every group in the range has DLT 3D bit-identical to an independent solve (${out.rD3Mismatch} differ, ${out.rInNotDlt} not DLT)`);
  check(out.rOutChanged === 0 && out.rOutNotBa === 0,
    `R: no group outside the range changed (${out.rOutChanged} changed, ${out.rOutNotBa} not Refined)`);
  check(JSON.stringify(out.rResultFrames) === '[0,50]' && JSON.stringify(out.rDerived) === '[0,50]',
    `R: derived state dropped for the re-solved frames only — 300 gone, 0 and 50 kept, none added ` +
    `(results ${JSON.stringify(out.rResultFrames)}, reprojections ${JSON.stringify(out.rDerived)})`);
  check(out.rShowBad.length === 0, `R: a re-solved frame shown again derives the new solve's numbers (${JSON.stringify(out.rShowBad)})`);

  console.log(`    R2: "${out.r2Label}"`);
  check(out.r2Done && out.r2Resolved === 200 && out.r2Groups === 400,
    `R2 precondition: the Triangulate Range modal re-solved a 200-frame range (${out.r2Resolved} frames, ${out.r2Groups} groups)`);
  check(new RegExp(`triangulated 200 frames \\(400 groups, avg error: ${out.r2ExpectedAvg}px\\)`).test(out.r2Label),
    `R2: the modal's summary is the solves' (${out.r2ExpectedAvg} px)`);
  check(out.r2TimelineOk, `R2: the timeline marks are exactly the frames it re-solved (${out.r2TimelineCalls} frames)`);
  check(JSON.stringify(out.r2ResultFrames) === '[0]' && JSON.stringify(out.r2Derived) === '[0]',
    `R2: only the frame on screen has results or reprojections (results ${JSON.stringify(out.r2ResultFrames)}, ` +
    `reprojections ${out.r2Derived.length} frames)`);

  // ---- M ---------------------------------------------------------------------
  check(out.mFramesWith2 === NF && out.mGood3d === 2 * NF && out.mDirty === 0,
    `M precondition: the assignment grouped both animals in all 3 cameras on every frame, with 3D ` +
    `(${out.mFramesWith2}/${NF} frames, ${out.mGood3d}/${out.mGroups} groups)`);
  check(JSON.stringify(out.mDerived) === JSON.stringify(out.mWantDerived),
    `M: only the last ${out.KEEP} frames keep derived state (${out.mDerived.length} frames, first ${out.mDerived[0]})`);
  check(out.mTimelineOk, `M: the timeline mark of every assigned frame is updated (${out.mTimelineCalls} of ${NF} frames)`);
  check(out.mRevisitBad.length === 0, `M: a dropped frame shown again is reprojected from its stored 3D (${JSON.stringify(out.mRevisitBad)})`);

  check(errs.length === 0, `no page errors (${errs.length})${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
  await browser.close();
} finally {
  server.kill();
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nbulk-triangulation-bounded-derived-state: PASS');
process.exit(fails ? 1 : 0);
