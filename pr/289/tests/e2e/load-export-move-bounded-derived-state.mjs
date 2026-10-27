/**
 * load-export-move-bounded-derived-state.mjs — loading an `.slp` with 3D, the
 * overlay video export and moving a view between sessions keep only the 3D; a
 * frame's reprojections and errors are derived from it when it is shown.
 *
 * ## The bug
 * A group's derived state — its reprojections into every camera, a
 * reprojected `Instance` per camera, and its frame's per-camera errors in
 * `state.triangulationResults` — is ~75 KB per frame per animal on a
 * 17-camera, 34-node project. Triangulate All stopped keeping it for every
 * frame in #351 (`triangulate-all-bounded-derived-state.mjs`); the bulk paths
 * followed (`bulk-triangulation-bounded-derived-state.mjs`). Three more paths
 * kept it for EVERY frame they touched:
 *   * File ▸ Load SLP (`handleLoadSlpFile`) reprojected every group of a file
 *     with 3D into every camera and scored it, at load, before anything was
 *     shown;
 *   * the overlay video export (`ensureReprojections`) filled and kept every
 *     exported frame's — by RE-SOLVING each group rather than reprojecting
 *     its stored 3D;
 *   * moving a view to another session (`moveVideosToSession`) kept the
 *     re-solve's reprojections and reprojected instances for every group that
 *     held the view, and left the frame's results naming the moved view.
 *
 * ## What this pins (synthetic eager project, DERIVED_FRAMES_KEEP + 100 frames)
 *   L. Load: only the frame on screen has derived state after the load (THE
 *      memory shape — the old build had every frame); the Reprojections and
 *      Errors layers are still switched on; a shown frame gets the old load's
 *      numbers, value for value, by reprojecting the FILE's 3D; with a
 *      reprojection-error threshold set the file's 3D is still reprojected,
 *      never re-solved — and the negative control (the same 3D in an array not
 *      read from the file, with no recorded method, as Track All leaves it) IS
 *      re-solved, so it is the file mark that holds it. (A triangulated group
 *      keeps its stored 3D under a threshold too, so the control drops the
 *      method: otherwise it would be held by that, not by the file mark.)
 *   E. Overlay export of every frame, through the real modal: at most
 *      DERIVED_FRAMES_KEEP frames keep derived state (the old build kept all of
 *      them); the exported frames' reprojections are the stored 3D's, not a
 *      re-solve's (a group whose stored 3D is deliberately NOT what its 2D
 *      solves to tells the two apart).
 *   M. Moving a view out, through the real modal: every group is re-solved
 *      without it, bit-identical to an independent solve; only the frame on
 *      screen has derived state (the old build had every frame); no frame's
 *      results still name the moved view; a shown frame derives the
 *      re-solve's numbers from the stored 3D.
 *
 * Fixture: `fixtures/ba-rig-fixture.js` (3 cameras with real k1 distortion,
 * 2 animals). Read its header before editing the geometry.
 *
 * Run:  PORT=<free port> node tests/e2e/load-export-move-bounded-derived-state.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8305);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 300)); });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 60000 });

  // Helpers shared by every phase, installed once on the page.
  await page.evaluate(async () => {
    const AS = await import('/ui/app-state.js');
    const TRI = await import('/pose/triangulation.js');
    const RND = await import('/ui/rendering.js');
    const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
    const KEEP = RND.DERIVED_FRAMES_KEEP || 600;   // (|| for running this on an older build)
    const NF = KEEP + 100;
    const F = await buildBaRigFixture({ frames: NF, cycle: 8 });
    const H = {
      KEEP, NF, F, cams: F.cams,
      boot(session) {
        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = NF;
        AS.state.currentFrame = 0;
        AS.state.fps = 30;
        AS.state.views = [];
        AS.state.triangulationResults = new Map();
      },
      groupsOf: (s, f) => (s.instanceGroups.get(f) || []),
      allGroups: (s) => [...s.instanceGroups.values()].flat(),
      sameArr(a, b) {
        if (a == null || b == null) return a === b;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
          const x = a[i], y = b[i];
          if (Array.isArray(x) || Array.isArray(y) || ArrayBuffer.isView(x)) { if (!H.sameArr(x, y)) return false; }
          else if (!Object.is(x, y)) return false;
        }
        return true;
      },
      keyList: (o) => Object.keys(o || {}).sort().join(','),
      derivedFrames(s) {
        const fr = [];
        for (const [f, gs] of s.instanceGroups) {
          if (gs.some(g => g.reprojections || (g.reprojectedInstances && g.reprojectedInstances.size))) fr.push(f);
        }
        return fr.sort((a, b) => a - b);
      },
      resultFrames: () => [...AS.state.triangulationResults.keys()].sort((a, b) => a - b),
      // 3D that is deliberately NOT what the group's 2D solves to, so
      // "reprojected the stored 3D" and "re-solved" cannot coincide.
      shift3d(g, d) {
        const p = Float64Array.from(g.points3d);
        for (let i = 0; i < p.length; i++) p[i] += d * ((i % 3) + 1);
        g.points3d = p;
      },
    };
    window.__H = H;
  });

  // ===========================================================================
  // L. File ▸ Load SLP
  // ===========================================================================
  const saved = await page.evaluate(async () => {
    const H = window.__H;
    const TRI = await import('/pose/triangulation.js');
    const FIO = await import('/import-export/file-io.js');
    const s = H.F.mkSession('L', { eager: true });
    H.boot(s);
    await TRI.triangulateAllFrames('dlt');
    H.shift3d(H.groupsOf(s, 10)[0], 0.3);
    const views = H.cams.map(c => ({ name: c.name, videoWidth: 1280, videoHeight: 1024, frameCount: H.NF }));
    const videoFiles = H.cams.map(c => ({ name: c.name, assignedCamera: c.name, videoPath: c.name + '.mp4' }));
    window.__Lbytes = await window.SleapIO.saveSlpToBytes(FIO.buildSlpLabelsAllViews(s, views, videoFiles));
    window.__Lsaved10 = Array.from(H.groupsOf(s, 10)[0].points3d);
    // Layers OFF before the load, so "the load switches them on" is observable.
    for (const id of ['visReprojections', 'visErrors']) document.getElementById(id).checked = false;
    return window.__Lbytes.byteLength;
  });
  check(saved > 1000, `precondition: the project with 3D saved (${saved.toLocaleString('en-US')} bytes)`);

  await page.evaluate(async () => {
    const imp = await import('/import-export/slp-import.js');
    window.__loadDone = false;
    imp.handleLoadSlpFile(new File([window.__Lbytes], 'bounded-load.slp'))
      .then(() => { window.__loadDone = true; }, (e) => { window.__loadDone = 'ERR ' + e; });
  });
  let loaded = 'timeout';
  for (let i = 0; i < 240; i++) {
    const st = await page.evaluate(() => ({ done: window.__loadDone, prompt: !!document.getElementById('videoSelectOverlay') }));
    if (st.prompt) await page.keyboard.press('Escape');          // "no videos": the load goes on
    if (st.done) { loaded = st.done; break; }
    await page.waitForTimeout(250);
  }
  check(loaded === true, `precondition: the file loads through handleLoadSlpFile (${loaded})`);

  const L = await page.evaluate(async () => {
    const H = window.__H;
    const AS = await import('/ui/app-state.js');
    const TRI = await import('/pose/triangulation.js');
    const RND = await import('/ui/rendering.js');
    const SET = await import('/ui/settings.js');
    const LR = await import('/pose/lazy-residency.js');
    const s = AS.state.session;
    const groups = H.allGroups(s);
    const cams = s.cameras;
    const res = {
      cur: AS.state.currentFrame,
      groups: groups.length,
      with3d: groups.filter(g => g.points3d && g.points3d.length).length,
      notDlt: groups.filter(g => g.triangulationMethod !== 'dlt').length,
      dirty: groups.filter(g => g.dirty).length,
      derived: H.derivedFrames(s),
      results: H.resultFrames(),
      layers: ['visReprojections', 'visErrors'].map(id => document.getElementById(id).checked),
      file10: H.sameArr(Array.from(H.groupsOf(s, 10)[0].points3d), window.__Lsaved10),
    };
    // What the old load computed for a group, from its stored 3D.
    const oldLoad = (g) => {
      const obs = g.observedPoints;
      const errors = {}, errorsU = {};
      let sum = 0, n = 0, sumU = 0, nU = 0;
      const reprojections = {};
      for (const c of cams) reprojections[c.name] = TRI.reprojectPointsCamera(g.points3d, c);
      for (const cn in reprojections) {
        if (!obs[cn]) continue;
        errors[cn] = TRI.computeReprojectionErrors(obs[cn], reprojections[cn]);
        for (const e of errors[cn]) if (e != null) { sum += e; n++; }
      }
      for (const c of cams) {
        if (!obs[c.name]) continue;
        const ideal = TRI.reprojectPoints(g.points3d, c.projectionMatrix);
        errorsU[c.name] = TRI.computeReprojectionErrors(obs[c.name].map(p => p != null ? c.undistortPoint(p) : null), ideal);
        for (const e of errorsU[c.name]) if (e != null) { sumU += e; nU++; }
      }
      return { reprojections, errors, errorsU, mean: n ? sum / n : null, meanU: nU ? sumU / nU : null };
    };
    const showAndVerify = (f) => {
      AS.state.currentFrame = f;
      RND.drawAllOverlays(f);
      const list = AS.state.triangulationResults.get(f) || [];
      const bad = [];
      for (const g of H.groupsOf(s, f)) {
        const r = list.find(x => x.group === g);
        if (!r) { bad.push('no result'); continue; }
        if (r.points3d !== g.points3d) bad.push('re-solved instead of reprojecting');
        const e = oldLoad(g);
        for (const c of cams) if (!H.sameArr(g.reprojections && g.reprojections[c.name], e.reprojections[c.name])) bad.push('reprojection ' + c.name);
        if (H.keyList(r.errors) !== H.keyList(e.errors)) bad.push('error cameras ' + H.keyList(r.errors));
        for (const cn of Object.keys(e.errors)) {
          if (!H.sameArr(r.errors[cn], e.errors[cn])) bad.push('errors ' + cn);
          if (!H.sameArr((r.errorsUndistorted || {})[cn], e.errorsU[cn])) bad.push('undistorted errors ' + cn);
        }
        if (Math.abs(r.meanError - e.mean) > 1e-12 * Math.max(1, e.mean)) bad.push(`mean ${r.meanError} vs ${e.mean}`);
        if (Math.abs(r.meanErrorUndistorted - e.meanU) > 1e-12 * Math.max(1, e.meanU)) bad.push('undistorted mean');
        for (const c of cams) if (!g.reprojectedInstances || !g.reprojectedInstances.get(c.name)) bad.push('no reprojected instance ' + c.name);
      }
      return bad;
    };
    res.showBad = [];
    for (const f of [10, 200, H.NF - 1]) {
      const bad = showAndVerify(f);
      if (bad.length) res.showBad.push({ f, bad: bad.slice(0, 4) });
    }
    // Frame 10, animal 0: the file's 3D is NOT what its 2D solves to.
    const g10 = H.groupsOf(s, 10)[0];
    const solved = TRI.triangulateAndReproject(g10, cams.filter(c => g10.getInstance(c.name)), { method: 'dlt' });
    res.fileNotASolve = !H.sameArr(Array.from(solved.points3d), Array.from(g10.points3d));

    // A threshold set: the file's 3D is still reprojected, never re-solved.
    const prevThr = SET.getTrackingThresholds();
    SET.setTrackingThresholds(Object.assign({}, prevThr, { reprojErrorThreshold: 5 }));
    res.threshold = SET.getTrackingThreshold('reprojErrorThreshold');
    try {
      LR.dropDerivedReprojections(s, 10, AS.state.triangulationResults);
      const badThr = showAndVerify(10);
      res.thresholdBad = badThr;
      // The file mark alone holds it: the file's 3D with no recorded method.
      res.controlMethod = g10.triangulationMethod;
      g10.triangulationMethod = undefined;
      LR.dropDerivedReprojections(s, 10, AS.state.triangulationResults);
      res.fileNoMethodBad = showAndVerify(10);
      // Negative control: the same 3D, in an array not read from the file, and
      // with no recorded method — a triangulated group keeps its stored 3D
      // under a threshold too, so with its method it would be held by that.
      g10.points3d = Float64Array.from(g10.points3d);
      LR.dropDerivedReprojections(s, 10, AS.state.triangulationResults);
      AS.state.currentFrame = 10;
      RND.drawAllOverlays(10);
      const r = (AS.state.triangulationResults.get(10) || []).find(x => x.group === g10);
      res.controlResolved = !!r && r.points3d !== g10.points3d;
    } finally {
      if ('controlMethod' in res) g10.triangulationMethod = res.controlMethod;
      SET.setTrackingThresholds(prevThr);
    }
    return res;
  });
  const LNF = await page.evaluate(() => window.__H.NF);
  check(L.groups === 2 * LNF && L.with3d === L.groups && L.notDlt === 0 && L.dirty === 0,
    `L precondition: every group came back with its DLT 3D, clean (${L.with3d}/${L.groups}, ${L.notDlt} not DLT, ${L.dirty} dirty)`);
  check(JSON.stringify(L.derived) === JSON.stringify([L.cur]) && JSON.stringify(L.results) === JSON.stringify([L.cur]),
    `L: after the load only the frame on screen (${L.cur}) has reprojections or results ` +
    `(reprojections ${L.derived.length} frames, results ${L.results.length} frames)`);
  check(L.layers.every(Boolean), `L: the load still switches the Reprojections and Errors layers on (${JSON.stringify(L.layers)})`);
  check(L.showBad.length === 0,
    `L: a shown frame gets the old load's numbers, value for value, from the file's 3D (${JSON.stringify(L.showBad)})`);
  check(L.file10 && L.fileNotASolve, 'L precondition: frame 10\'s file 3D survived the round trip and is NOT what its 2D solves to');
  check(L.threshold === 5 && L.thresholdBad.length === 0,
    `L: with a ${L.threshold} px reprojection-error threshold the file's 3D is still reprojected, not re-solved ` +
    `(${JSON.stringify(L.thresholdBad)})`);
  check(L.fileNoMethodBad.length === 0,
    `L: the file's 3D with no recorded method is still reprojected (${JSON.stringify(L.fileNoMethodBad)})`);
  check(L.controlResolved === true,
    'L negative control: the same 3D in an array not read from the file, with no recorded method, IS re-solved');

  // ===========================================================================
  // E. Export Video Overlays, every frame
  // ===========================================================================
  const Epre = await page.evaluate(async () => {
    const H = window.__H;
    const AS = await import('/ui/app-state.js');
    const TRI = await import('/pose/triangulation.js');
    const s = H.F.mkSession('E', { eager: true });
    H.boot(s);
    await TRI.triangulateAllFrames('dlt');
    // Frame 650's first animal: stored 3D that is not its 2D's solve, still
    // clean and still DLT — the fill reprojects it, a re-solve would not.
    const PERTURBED = H.NF - 50;
    H.shift3d(H.groupsOf(s, PERTURBED)[0], 0.3);
    window.__E = { s, PERTURBED };
    AS.state.views = H.cams.map(c => ({
      name: c.name, decoder: null, canvas: null, ctx: null,
      overlayCanvas: null, overlayCtx: null, videoWidth: 1280, videoHeight: 1024,
    }));
    for (const id of ['visReprojections', 'visErrors']) document.getElementById(id).checked = true;
    try { localStorage.removeItem('overlayExportSettings.v1'); } catch (e) { /* ignore */ }
    return { derived: H.derivedFrames(s) };
  });
  await page.evaluate(() => document.getElementById('menuExportOverlayVideo').click());
  await page.waitForSelector('#ovExportOverlay', { timeout: 10000 });
  await page.waitForTimeout(600);
  await page.evaluate(async () => {
    const H = window.__H;
    // One small tile keeps the encode short; the overlay fill runs per frame
    // whatever is docked.
    let guard = 0;
    while (document.querySelectorAll('#ovDock [data-view-name]').length > 1 && guard++ < 20) {
      const tabs = document.querySelectorAll('#ovDock .dv-default-tab-action');
      tabs[tabs.length - 1].click();
      await new Promise(r => setTimeout(r, 150));
    }
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('ovRes', '480');
    set('ovMode', 'stitched');
    set('ovStartField', '1');
    set('ovEndField', String(H.NF));
  });
  const dl = page.waitForEvent('download', { timeout: 300000 });
  await page.evaluate(() => document.getElementById('ovExport').click());
  const download = await dl;
  await page.waitForFunction(() => !document.getElementById('ovExportOverlay'), { timeout: 60000 });
  const E = await page.evaluate(async () => {
    const H = window.__H;
    const AS = await import('/ui/app-state.js');
    const TRI = await import('/pose/triangulation.js');
    const { s, PERTURBED } = window.__E;
    const g = H.groupsOf(s, PERTURBED)[0];
    let reprojBad = 0;
    for (const c of H.cams) if (!H.sameArr(g.reprojections && g.reprojections[c.name], TRI.reprojectPointsCamera(g.points3d, c))) reprojBad++;
    const solved = TRI.triangulateAndReproject(g, H.cams.filter(c => g.getInstance(c.name)), { method: 'dlt' });
    return {
      derived: H.derivedFrames(s),
      results: H.resultFrames(),
      reprojBad,
      perturbedNotASolve: !H.sameArr(Array.from(solved.points3d), Array.from(g.points3d)),
      lastHas: H.derivedFrames(s).includes(H.NF - 1),
      perturbed: PERTURBED,
      active: AS.state.session === s,
    };
  });
  check(JSON.stringify(Epre.derived) === '[0]' && E.active,
    `E precondition: Triangulate All left derived state on the frame on screen only (${JSON.stringify(Epre.derived)})`);
  check(/_overlay_f1-\d+\.mp4$/.test(download.suggestedFilename()),
    `E precondition: the export of every frame ran and downloaded (${download.suggestedFilename()})`);
  const ENF = LNF, EKEEP = await page.evaluate(() => window.__H.KEEP);
  check(E.derived.length <= EKEEP + 1 && E.lastHas && E.derived.includes(E.perturbed),
    `E: after exporting ${ENF} frames at most ${EKEEP} (+ the frame on screen) keep reprojections ` +
    `(${E.derived.length} frames, first ${E.derived[0]})`);
  check(E.results.length <= EKEEP + 1,
    `E: and at most ${EKEEP} (+ the frame on screen) keep results (${E.results.length} frames)`);
  check(E.perturbedNotASolve && E.reprojBad === 0,
    `E: an exported frame's reprojections are its stored 3D's, not a re-solve's (${E.reprojBad} cameras differ)`);

  // ===========================================================================
  // M. Move a view to another session
  // ===========================================================================
  const M = await page.evaluate(async () => {
    const H = window.__H;
    const AS = await import('/ui/app-state.js');
    const TRI = await import('/pose/triangulation.js');
    const RND = await import('/ui/rendering.js');
    const PD = await import('/pose/pose-data.js');
    const SP = await import('/ui/sessions-panes.js');
    const MOVED = 'camC';
    const s = H.F.mkSession('M', { eager: true });
    H.boot(s);
    await TRI.triangulateAllFrames('dlt');
    for (const f of [50, 300, 0]) { AS.state.currentFrame = f; RND.drawAllOverlays(f); }
    const res = { shownBefore: H.resultFrames(), cur: AS.state.currentFrame };
    const dest = new PD.Session(s.cameras.slice(), s.skeleton, [], 'Destination');
    if (!Array.isArray(dest.videoFileIndices)) dest.videoFileIndices = [];
    AS.state.sessions.push(dest);
    const p = SP.showMoveVideoModal([MOVED], 0, 1);
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent === 'Continue' && b.offsetParent);
    if (btn) btn.click();
    await p;
    res.clicked = !!btn;
    const groups = H.allGroups(s);
    res.groups = groups.length;
    res.withMoved = groups.filter(g => g.getInstance(MOVED)).length;
    let mismatch = 0;
    const expected = new Map();
    for (const g of groups) {
      const members = s.cameras.filter(c => g.getInstance(c.name));
      const e = TRI.triangulateAndReproject(g, members, { method: 'dlt' });
      e.reprojections = TRI.reprojectIntoEveryCamera(Object.assign({}, e.reprojections), e.points3d, s.cameras);
      e.memberNames = members.map(c => c.name).sort().join(',');
      expected.set(g, e);
      if (!H.sameArr(Array.from(g.points3d), Array.from(e.points3d))) mismatch++;
    }
    res.mismatch = mismatch;
    res.dirty = groups.filter(g => g.dirty).length;
    res.derived = H.derivedFrames(s);
    res.results = H.resultFrames();
    res.namingMoved = 0;
    for (const [, list] of AS.state.triangulationResults) for (const r of list) if (r.errors && r.errors[MOVED]) res.namingMoved++;
    // A frame shown after the move derives the re-solve's numbers from the
    // stored 3D.
    res.showBad = [];
    for (const f of [300, H.NF - 1]) {
      AS.state.currentFrame = f;
      RND.drawAllOverlays(f);
      const list = AS.state.triangulationResults.get(f) || [];
      for (const g of H.groupsOf(s, f)) {
        const e = expected.get(g), r = list.find(x => x.group === g);
        if (!r) { res.showBad.push({ f, bad: 'no result' }); continue; }
        if (r.points3d !== g.points3d) res.showBad.push({ f, bad: 're-solved instead of reprojecting' });
        if (H.keyList(r.errors) !== e.memberNames) res.showBad.push({ f, bad: 'error cameras ' + H.keyList(r.errors) });
        for (const cn of Object.keys(e.errors)) {
          if (!H.sameArr(r.errors[cn], e.errors[cn])) res.showBad.push({ f, bad: 'errors ' + cn });
          if (!H.sameArr(r.errorsUndistorted[cn], e.errorsUndistorted[cn])) res.showBad.push({ f, bad: 'undistorted errors ' + cn });
        }
        if (!Object.is(r.meanError, e.meanError)) res.showBad.push({ f, bad: `mean ${r.meanError} vs ${e.meanError}` });
        for (const c of s.cameras) {
          if (!H.sameArr(g.reprojections && g.reprojections[c.name], e.reprojections[c.name])) res.showBad.push({ f, bad: 'reprojection ' + c.name });
        }
      }
    }
    return res;
  });
  check(M.clicked && JSON.stringify(M.shownBefore) === '[0,50,300]',
    `M precondition: frames 0, 50 and 300 had derived state, and the move ran through the modal (${JSON.stringify(M.shownBefore)})`);
  check(M.groups === 2 * LNF && M.withMoved === 0 && M.dirty === 0,
    `M: every group lost camC and is clean (${M.withMoved} still hold it, ${M.dirty} dirty)`);
  check(M.mismatch === 0, `M: every group's 3D is bit-identical to an independent solve without camC (${M.mismatch} differ)`);
  check(JSON.stringify(M.derived) === JSON.stringify([M.cur]) && JSON.stringify(M.results) === JSON.stringify([M.cur]),
    `M: after the move only the frame on screen (${M.cur}) has reprojections or results ` +
    `(reprojections ${M.derived.length} frames, results ${JSON.stringify(M.results.slice(0, 5))})`);
  check(M.namingMoved === 0, `M: no frame's results still name the moved view (${M.namingMoved})`);
  check(M.showBad.length === 0,
    `M: a shown frame derives the re-solve's numbers from the stored 3D (${JSON.stringify(M.showBad.slice(0, 4))})`);

  check(errs.length === 0, `no page errors (${errs.length})${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
  await browser.close();
} finally {
  server.kill();
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nload-export-move-bounded-derived-state: PASS');
process.exit(fails ? 1 : 0);
