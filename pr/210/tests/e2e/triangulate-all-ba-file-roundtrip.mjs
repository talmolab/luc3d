/**
 * triangulate-all-ba-file-roundtrip.mjs — FILE-LEVEL proof that bundle-adjusted
 * 3D actually reaches disk, survives a reopen, and is still what the app shows.
 *
 * The sibling `triangulate-all-ba-export.mjs` asserts governance on in-memory
 * `group.points3d`. That is the wrong layer for the question "does my export
 * carry BA's numbers?", so this test never trusts an in-memory proxy: it drives
 * the REAL export entry points, captures the REAL bytes they hand to the browser
 * (by intercepting `URL.createObjectURL`, which is how every one of them delivers
 * its file), reads those bytes BACK — HDF5 through the vendored h5wasm, JSON
 * through `JSON.parse` — and compares against an independently computed BA solve.
 * Every comparison is made against BOTH candidate solutions, so a passing run
 * states which one landed in the file rather than merely "unchanged".
 *
 * Entry points covered, all driven for real:
 *   * `exportPoints3dH5`  — the most direct: this IS the triangulated-3D export.
 *   * `exportReprojH5`    — reprojections must derive from BA's 3D, not DLT's.
 *   * `exportLabels`      — JSON labels export.
 *   * `saveProjectSlp`    — the SLP `/session_data/points_3d` table.
 *
 * NOT driven, and why: `saveAs` / `quickSave` cannot be exercised headlessly —
 * they open `showSaveFilePicker`, which needs a real user gesture. They differ
 * from `saveProjectSlp` ONLY in the sink: all three build their bytes with the
 * same private `buildSlpBytes`, and `quickSave` literally calls
 * `saveProjectSlp()` when `showSaveFilePicker` is absent (which is the path this
 * test takes, since it deletes the API to force every export down its blob
 * fallback). So the BYTES are covered; the file-handle plumbing is not.
 * `exportCameraSlpStreaming` / `exportSlpClientSide` / `exportSlpMultiSession`
 * are also not covered here — they export per-camera 2D + reprojections rather
 * than the 3D table, and need view/videoFile wiring this fixture does not build.
 *
 * ## THE CYCLE (phase 5). Per CLAUDE.md this bug class only shows up a cycle
 * later, so a single-operation test is not enough:
 *   Triangulate All ▸ BA → export → save → REOPEN → is the display still BA? →
 *   export again → do both exports agree, and both carry BA?
 * The reopen is what caught the missing persistence of
 * `group.triangulationMethod`: with BA 3D but an unknown method, the display fill
 * re-derived reprojections with DLT and reported DLT's error for BA points.
 *
 * Fixture (real pure-k1 barrel distortion, fold-radius safety, the rig trick) is
 * `fixtures/ba-rig-fixture.js` — read its header before editing the geometry.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8101);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.SleapIO && window.h5wasm && window.__lucid, { timeout: 120000 });

  const out = await page.evaluate(async () => {
    const AS = await import('/ui/app-state.js');
    const TRI = await import('/pose/triangulation.js');
    const EM = await import('/ui/export-modals.js');
    const FIO = await import('/import-export/file-io.js');
    const SL = await import('/import-export/save-load.js');
    const SI = await import('/import-export/slp-import.js');
    const IP = await import('/ui/info-panel.js');
    const RND = await import('/ui/rendering.js');
    const SET = await import('/ui/settings.js');
    const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
    const F = await buildBaRigFixture();
    const log = [];

    // Force every export down its BLOB fallback and capture the bytes it would
    // have written. This is the real file content, not a re-derivation.
    delete window.showSaveFilePicker;
    const captured = [];
    const realCOU = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { captured.push(blob); return realCOU(blob); };
    const grab = async (fn) => {
      captured.length = 0;
      await fn();
      if (!captured.length) throw new Error('no blob was produced');
      return new Uint8Array(await captured[captured.length - 1].arrayBuffer());
    };

    // Read an HDF5 byte buffer back through the app's own vendored h5wasm.
    await window.h5wasm.ready;
    let h5n = 0;
    const readH5 = (bytes, names) => {
      const fn = '/_rt_' + (h5n++) + '.h5';
      window.h5wasm.FS.writeFile(fn, bytes);
      const f = new window.h5wasm.File(fn, 'r');
      const out = {};
      try {
        for (const n of names) {
          const d = f.get(n);
          out[n] = d ? { value: Array.from(d.value), shape: d.shape } : null;
        }
      } finally { f.close(); }
      return out;
    };

    // ---- reference solves, independent of anything the app stores ----------
    const refBa = F.refSolve(0, 'ba');
    const refDlt = F.refSolve(0, 'dlt');
    const flatOf = (results) => {                 // frame 0, track order, flat xyz
      const o = [];
      for (const r of results) for (const v of r.points3d) o.push(v);
      return o;
    };
    const baFlat = flatOf(refBa), dltFlat = flatOf(refDlt);
    const worstDelta = (a, b) => {
      if (!a || !b || a.length !== b.length) return Infinity;
      let w = 0;
      for (let i = 0; i < a.length; i++) {
        if (Number.isNaN(a[i]) && Number.isNaN(b[i])) continue;
        w = Math.max(w, Math.abs(a[i] - b[i]));
      }
      return w;
    };
    const baVsDlt = worstDelta(baFlat, dltFlat);

    // ---- the project: Triangulate All ▸ Bundle Adjustment ------------------
    const prevPref = SET.getDefaultTriangulationMethod();
    SET.setDefaultTriangulationMethod('ba');
    const session = F.mkSession('BA_FILE_ROUNDTRIP', { eager: true });
    AS.state.sessions = [session];
    AS.state.activeSessionIdx = 0;
    AS.state.session = session;
    AS.state.totalFrames = F.NF;
    AS.state.currentFrame = 0;
    AS.state.views = F.camNames.map(n => ({ name: n, videoWidth: 1280, videoHeight: 1024, frameCount: F.NF }));
    AS.state.videoFiles = F.camNames.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
    AS.state.triangulationResults = new Map();
    await TRI.triangulateAllFrames('ba');
    const methodsAfterTri = (TRI.getInstanceGroupsForFrame(0) || []).map(g => g.triangulationMethod);

    // The exporters index the 3D by identityId; map that to the reference order.
    const trackOf = (g) => { for (const [, i] of g.instances) if (i && i.trackIdx != null) return i.trackIdx; return -1; };
    const groupOrder = (TRI.getInstanceGroupsForFrame(0) || [])
      .map(g => ({ id: g.identityId, t: trackOf(g) }));
    /** Pull frame-0 xyz out of a (frames, tracks, nodes, 3) flat buffer, in reference track order. */
    const pickFrame0 = (flat, shape, frameRow) => {
      const [, nT, nN] = shape;
      const o = [];
      for (const { id, t } of groupOrder.slice().sort((a, b) => a.t - b.t)) {
        void t;
        for (let n = 0; n < nN; n++) {
          const base = ((frameRow * nT + id) * nN + n) * 3;
          o.push(flat[base], flat[base + 1], flat[base + 2]);
        }
      }
      return o;
    };

    // ===================================================================
    // Phase 1 — exportPoints3dH5: real bytes, read back through h5wasm.
    // ===================================================================
    const p3dBytes = await grab(() => EM.exportPoints3dH5());
    const p3d = readH5(p3dBytes, ['points_3d', 'frame_indices']);
    const fRow = p3d.frame_indices.value.indexOf(0);
    const p3dFrame0 = pickFrame0(p3d.points_3d.value, p3d.points_3d.shape, fRow);
    log.push(`points3d.h5: ${p3dBytes.length} B, shape ${JSON.stringify(p3d.points_3d.shape)}`);

    // ===================================================================
    // Phase 2 — exportReprojH5: the reprojections must come from BA's 3D.
    // Reference = BA's own 3D pushed through the same reprojection function.
    // ===================================================================
    const rpBytes = await grab(() => EM.exportReprojH5());
    const rp = readH5(rpBytes, ['reprojections', 'frame_indices', 'camera_names']);
    const rShape = rp.reprojections.shape;      // [frames, tracks, cameras, nodes, 2]
    const rRow = rp.frame_indices.value.indexOf(0);
    const camNamesInFile = rp.camera_names ? rp.camera_names.value : [];
    const readReproj = () => {
      const [, nT, nC, nN] = rShape;
      const o = [];
      for (const { id } of groupOrder.slice().sort((a, b) => a.t - b.t)) {
        for (let c = 0; c < nC; c++) for (let n = 0; n < nN; n++) {
          const base = (((rRow * nT + id) * nC + c) * nN + n) * 2;
          o.push(rp.reprojections.value[base], rp.reprojections.value[base + 1]);
        }
      }
      return o;
    };
    const expectReproj = (results) => {
      const o = [];
      for (const r of results) {
        for (const camName of camNamesInFile) {
          const cam = F.cams.find(c => c.name === camName);
          const pts = TRI.reprojectPointsCamera(r.points3d, cam);
          for (const p of pts) { o.push(p ? p[0] : NaN); o.push(p ? p[1] : NaN); }
        }
      }
      return o;
    };
    const rpGot = readReproj();
    const rpVsBa = worstDelta(rpGot, expectReproj(refBa));
    const rpVsDlt = worstDelta(rpGot, expectReproj(refDlt));
    log.push(`reprojections.h5: ${rpBytes.length} B, shape ${JSON.stringify(rShape)}, cams ${JSON.stringify(camNamesInFile)}`);

    // ===================================================================
    // Phase 3 — exportLabels (JSON). FINDING: this export is 2D ONLY. Its
    // `frames` map is { frameIdx: { camName: [{points, trackIdx, type, score,
    // modified}] } } and it emits no 3D of any kind, so the triangulation method
    // cannot affect it — the 2D it writes is the solver's INPUT, not its output.
    // Asserted rather than assumed, so if a 3D field is ever added here it must
    // come with a BA assertion.
    // ===================================================================
    const lblBytes = await grab(() => EM.exportLabels());
    const labels = JSON.parse(new TextDecoder().decode(lblBytes));
    const lblText = new TextDecoder().decode(lblBytes);
    const lblFrame0 = labels.frames ? labels.frames['0'] : null;
    const lbl2dCount = lblFrame0
      ? Object.keys(lblFrame0).reduce((a, cn) => a + lblFrame0[cn].length, 0) : 0;
    // Do the 2D values in the file still match the fixture's observations?
    const lbl2dMatches = (() => {
      if (!lblFrame0) return false;
      for (const cn of F.camNames) {
        const insts = lblFrame0[cn];
        if (!insts) return false;
        for (const inst of insts) {
          const want = F.obs.get(0).get(cn)[inst.trackIdx];
          if (!want || want.length !== inst.points.length) return false;
          for (let k = 0; k < want.length; k++) {
            if (inst.points[k][0] !== want[k][0] || inst.points[k][1] !== want[k][1]) return false;
          }
        }
      }
      return true;
    })();
    const lblHas3d = /points3d|points_3d|instanceGroups/.test(lblText);
    log.push(`labels.json: ${lblBytes.length} B, keys ${JSON.stringify(Object.keys(labels))}, ` +
      `frame-0 2D instances ${lbl2dCount}, mentions 3D: ${lblHas3d}`);

    // ===================================================================
    // Phase 4 — saveProjectSlp: the SLP /session_data/points_3d table, plus the
    // persisted triangulationMethod in sessions_json.
    // ===================================================================
    const slpBytes = await grab(() => SL.saveProjectSlp());
    const slp = readH5(slpBytes, ['/session_data/points_3d']);
    const slpPts = slp['/session_data/points_3d'];
    // Frame groups are written in frame order, groups within a frame in list
    // order — so frame 0's rows are the first (nGroups * nNodes) of them.
    const slpFrame0 = slpPts ? slpPts.value.slice(0, groupOrder.length * F.NNODE * 3) : null;
    // Per-group `metadata.lucid` lands in `/session_data/instance_group_meta`
    // (one JSON string per group) under SLP 2.8's columnar layout — NOT in the
    // slim `sessions_json`. That is where the persisted method must appear.
    let methodsInFile = null, nMetaRows = 0;
    {
      const fn = '/_rt_sj.slp';
      window.h5wasm.FS.writeFile(fn, slpBytes);
      const f = new window.h5wasm.File(fn, 'r');
      try {
        const ds = f.get('/session_data/instance_group_meta');
        const rows = ds ? ds.value : null;
        if (rows) {
          nMetaRows = rows.length;
          methodsInFile = rows.slice(0, groupOrder.length).map((s) => {
            try { const j = JSON.parse(s); return (j.lucid && j.lucid.triangulationMethod) || null; }
            catch (e) { return null; }
          });
        }
      } finally { f.close(); }
    }
    log.push(`project.slp: ${slpBytes.length} B, points_3d shape ${JSON.stringify(slpPts && slpPts.shape)}, ` +
      `instance_group_meta rows ${nMetaRows}, frame-0 methods ${JSON.stringify(methodsInFile)}`);

    // ===================================================================
    // Phase 5 — THE CYCLE. Reopen the saved .slp through the real reader, then
    // check the display is STILL BA, then export again and compare.
    // ===================================================================
    // Read the file back with the REAL streaming reader, then rebuild grouping
    // with the REAL reconstruction (`reconstructInstanceGroupsFromSession`) — the
    // code that has to restore both `points3d` and `triangulationMethod`. The
    // host Session is rebuilt from the fixture's 2D (identical observations), so
    // everything under test comes out of the file.
    const file = new File([slpBytes], 'ba_roundtrip.slp', { type: 'application/octet-stream' });
    const parsed = await FIO.parseSlpViaSleapIO(file, () => {});
    const rawSession = parsed && parsed.sessions && parsed.sessions[0];
    const typedSession = rawSession && rawSession._typedSession;
    const reSession = F.mkSession('REOPENED', { eager: true });
    let reGroups = null, reMethods = null, reFlat = null, recon = null;
    if (typedSession) {
      recon = await SI.reconstructInstanceGroupsFromSession(
        reSession, typedSession, rawSession, reSession.skeleton.nodes, {});
      reGroups = reSession.instanceGroups.get(0) || null;
      if (reGroups) {
        reMethods = reGroups.map(g => g.triangulationMethod);
        const sorted = reGroups.slice().sort((a, b) => a.identityId - b.identityId);
        reFlat = [];
        for (const g of sorted) for (const v of (g.points3d || [])) reFlat.push(v);
      }
    }

    // Install the reopened session as the live one and drive the display path.
    let shownAfterReopen = null, methodLabelAfterReopen = null;
    if (reGroups && reGroups.length) {
      AS.state.sessions = [reSession];
      AS.state.session = reSession;
      AS.state.currentFrame = 0;
      AS.state.triangulationResults = new Map();
      RND.drawAllOverlays(0);
      IP.updateFrameInfo(0, TRI.getInstanceGroupsForFrame(0) || []);
      shownAfterReopen = (document.getElementById('errorDisplay') || {}).textContent || '';
      methodLabelAfterReopen = (document.getElementById('errorMethod') || {}).textContent || '';
    }
    // What SHOULD the panel read? BA's frame mean, aggregated the panel's way.
    const expectShown = (() => {
      let s = 0, n = 0;
      for (const r of refBa) for (const cn in r.errors) for (const e of r.errors[cn]) if (e != null) { s += e; n++; }
      return n ? (s / n).toFixed(2) + ' px' : null;
    })();
    const expectShownDlt = (() => {
      let s = 0, n = 0;
      for (const r of refDlt) for (const cn in r.errors) for (const e of r.errors[cn]) if (e != null) { s += e; n++; }
      return n ? (s / n).toFixed(2) + ' px' : null;
    })();

    // Export the 3D again from the REOPENED project and compare to the first.
    let p3dFrame0Again = null, againBytes = 0;
    if (reGroups && reGroups.length) {
      const b2 = await grab(() => EM.exportPoints3dH5());
      againBytes = b2.length;
      const q = readH5(b2, ['points_3d', 'frame_indices']);
      const r2 = q.frame_indices.value.indexOf(0);
      const g2 = (TRI.getInstanceGroupsForFrame(0) || []).map(g => ({ id: g.identityId, t: g.identityId }));
      const [, nT, nN] = q.points_3d.shape;
      p3dFrame0Again = [];
      for (const { id } of g2.slice().sort((a, b) => a.id - b.id)) {
        for (let n = 0; n < nN; n++) {
          const base = ((r2 * nT + id) * nN + n) * 3;
          p3dFrame0Again.push(q.points_3d.value[base], q.points_3d.value[base + 1], q.points_3d.value[base + 2]);
        }
      }
    }

    URL.createObjectURL = realCOU;
    SET.setDefaultTriangulationMethod(prevPref);

    return {
      log, baVsDlt, methodsAfterTri, nRefNodes: F.NNODE,
      p3d: { bytes: p3dBytes.length, vsBa: worstDelta(p3dFrame0, baFlat), vsDlt: worstDelta(p3dFrame0, dltFlat) },
      reproj: { bytes: rpBytes.length, vsBa: rpVsBa, vsDlt: rpVsDlt },
      labels: { bytes: lblBytes.length, n2d: lbl2dCount, matches2d: lbl2dMatches, has3d: lblHas3d,
                keys: Object.keys(labels) },
      slp: { bytes: slpBytes.length, methodsInFile, nMetaRows, recon,
             vsBa: worstDelta(slpFrame0, baFlat), vsDlt: worstDelta(slpFrame0, dltFlat) },
      reopen: { nGroups: reGroups ? reGroups.length : 0, methods: reMethods,
                vsBa: worstDelta(reFlat, baFlat), vsDlt: worstDelta(reFlat, dltFlat),
                shown: shownAfterReopen, methodLabel: methodLabelAfterReopen,
                expectShown, expectShownDlt },
      again: { bytes: againBytes, vsFirst: worstDelta(p3dFrame0Again, p3dFrame0),
               vsBa: worstDelta(p3dFrame0Again, baFlat) },
    };
  });

  out.log.forEach(l => console.log('    ' + l));
  console.log(`    BA vs DLT 3D separation: ${out.baVsDlt} world units`);
  console.log(`    reopen: methods ${JSON.stringify(out.reopen.methods)} | ` +
    `panel "${out.reopen.shown}" (BA would be "${out.reopen.expectShown}", ` +
    `DLT "${out.reopen.expectShownDlt}") | label "${out.reopen.methodLabel}"`);

  check(out.baVsDlt > 1e-4,
    `precondition: BA's and DLT's 3D differ measurably (${out.baVsDlt}) — otherwise no ` +
    `file-level assertion below can tell them apart`);
  check(out.methodsAfterTri.every(m => m === 'ba'),
    `precondition: Triangulate All ▸ BA left every group on 'ba' ` +
    `(${JSON.stringify(out.methodsAfterTri)})`);

  const fileOk = (label, r) => {
    check(r.bytes > 0, `${label}: produced real bytes (${r.bytes})`);
    check(r.vsBa === 0, `${label}: the values IN THE FILE are bit-identical to an ` +
      `independent BA solve (worst |delta| ${r.vsBa})`);
    check(r.vsDlt > 1e-4, `${label}: ...and are NOT DLT's (worst |delta| from DLT ${r.vsDlt})`);
  };

  fileOk('exportPoints3dH5 -> points_3d', out.p3d);
  fileOk('exportReprojH5 -> reprojections', out.reproj);
  // exportLabels is 2D-only — pinned as a FINDING, not treated as a 3D export.
  check(out.labels.bytes > 0, `exportLabels: produced real bytes (${out.labels.bytes})`);
  check(out.labels.n2d === 6,
    `exportLabels: frame 0 carries its 2D (3 cameras x 2 tracks = 6 instances, got ${out.labels.n2d})`);
  check(out.labels.matches2d,
    `exportLabels: those 2D values are exactly the fixture's observations`);
  check(!out.labels.has3d,
    `exportLabels emits NO 3D at all (keys ${JSON.stringify(out.labels.keys)}) — so the ` +
    `triangulation method cannot affect it; the 2D it writes is the solver's INPUT. ` +
    `If a 3D field is ever added here, this assertion fails and a BA check must be added`);
  fileOk('saveProjectSlp -> /session_data/points_3d', out.slp);

  check(out.slp.methodsInFile && out.slp.methodsInFile.length === 2 &&
        out.slp.methodsInFile.every(m => m === 'ba'),
    `saveProjectSlp: the triangulation method is PERSISTED per group in ` +
    `/session_data/instance_group_meta as metadata.lucid.triangulationMethod ` +
    `(${out.slp.nMetaRows} rows, frame-0 methods ${JSON.stringify(out.slp.methodsInFile)}) — ` +
    `without it a reopened project has BA 3D with an unknown method`);

  // ---- the cycle ---------------------------------------------------------
  check(out.reopen.nGroups === 2, `reopen: frame 0 came back with 2 groups (got ${out.reopen.nGroups})`);
  check(out.reopen.vsBa === 0,
    `reopen: the 3D read back out of the file is still bit-identical to BA's ` +
    `(worst |delta| ${out.reopen.vsBa})`);
  check(out.reopen.vsDlt > 1e-4, `reopen: ...and is not DLT's (${out.reopen.vsDlt})`);
  check(out.reopen.methods && out.reopen.methods.every(m => m === 'ba'),
    `reopen: triangulationMethod survived the round trip as 'ba' ` +
    `(got ${JSON.stringify(out.reopen.methods)})`);
  check(out.reopen.shown === out.reopen.expectShown,
    `reopen: the Info Panel still shows BA's error, "${out.reopen.shown}" === ` +
    `"${out.reopen.expectShown}" (a DLT re-derive would show "${out.reopen.expectShownDlt}") — ` +
    `this is the assertion that fails when triangulationMethod is not persisted`);
  check(out.reopen.methodLabel === 'Bundle Adjustment',
    `reopen: and labels it "Bundle Adjustment" (got "${out.reopen.methodLabel}")`);
  check(out.again.vsFirst === 0,
    `re-export from the REOPENED project agrees with the first export bit for bit ` +
    `(worst |delta| ${out.again.vsFirst})`);
  check(out.again.vsBa === 0,
    `...and still carries BA's 3D (worst |delta| ${out.again.vsBa})`);

  check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));

  await browser.close();
} finally {
  server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
