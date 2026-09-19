/**
 * triangulate-all-ba-export.mjs — what is EXPORTED must be what is DISPLAYED.
 * No code path may silently replace bundle-adjusted 3D with a DLT re-solve.
 *
 * ## The bug
 * The regrouping sweeps DELETE a frame's `instanceGroups` and rebuild fresh
 * `InstanceGroup` objects around the SAME `Instance` objects. The fresh object
 * carries no `points3d` and no `triangulationMethod`, so both sweeps
 * unconditionally re-solved every group with `triangulateAndReproject`'s DEFAULT
 * method — which is a SILENT DLT — and stamped `triangulationMethod = 'dlt'`:
 *
 *   * `groupByIdentityAndTriangulateAll` (`ui/export-modals.js`) — also where
 *     "Triangulate All ▸ DLT" routes whenever identities exist, and reachable
 *     directly as Tracks ▸ Group by Identity.
 *   * `groupByTrackAndTriangulateAll` (same file) — Tracks ▸ Group by Track.
 *
 * So running either after a BA "Triangulate All" silently downgraded the whole
 * project's 3D to DLT. Save/export read `group.points3d`, so the exported file
 * stopped matching what the user had computed and was looking at — a data bug,
 * not a display one, and invisible until someone compared files.
 *
 * ## The rule now in force
 * **The selected method GOVERNS these two operations.** With Settings ▸ Default
 * Triangulation set to Bundle Adjustment, Group by Track / Group by ID &
 * Triangulate All leave BA 3D on *every* group — new, changed, or
 * unchanged-but-previously-DLT. An explicit pick beats the default:
 * "Triangulate All ▸ DLT" routes to `groupByIdentityAndTriangulateAll('dlt')`, so
 * an explicit DLT request stays DLT even under a BA default.
 *
 * The free fast path survives only where it is genuinely a no-op: a group is
 * ADOPTED (`adoptPrior3d`, no solve at all) when its membership is unchanged
 * (`findEquivalentPriorGroup`, by Instance object identity) AND its existing 3D
 * already came from the requested method. So a DLT re-run over a DLT project
 * solves nothing, while switching the default to BA re-solves the project — which
 * is the point. Phases D/E pin both directions.
 *
 * The BA/DLT cost ratio and the wall-clock difference between an all-adopt sweep
 * and an all-re-solve sweep are measured and printed below, so the tradeoff is on
 * the record rather than assumed.
 *
 * Fixture (real k1 barrel distortion, fold-radius safety, the rig trick) lives in
 * `fixtures/ba-rig-fixture.js` — read its header before editing the geometry.
 * Sibling test: `triangulate-all-ba-display.mjs` covers the display half.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8098);

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
    const EM = await import('/ui/export-modals.js');
    const FIO = await import('/import-export/file-io.js');
    const SET = await import('/ui/settings.js');
    const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
    const F = await buildBaRigFixture();

    const refBaPts = F.refSolve(0, 'ba').map(r => r.points3d);
    const refDltPts = F.refSolve(0, 'dlt').map(r => r.points3d);
    // How far apart ARE the two solutions? If this is ~0 the test cannot tell
    // "kept BA" from "silently re-solved with DLT" and proves nothing.
    const baVsDlt = Math.max.apply(null, refBaPts.map((p, i) => F.points3dDelta(p, refDltPts[i])));
    const cost = F.timeMethods(40);

    /**
     * The 3D a real export writes, read straight out of the session by the same
     * pure builder `buildPoints3dH5` and the JSON labels export use. Returned as
     * identityIdx -> flat [x,y,z,...] for frame 0, NOT as one flat blob: "Group by
     * Track" legitimately ADDS track-derived identities (`id_0`, `id_1`) to the
     * roster, which changes the export's track axis without touching any 3D. Keying
     * by identity keeps the assertion about the 3D.
     */
    const exported3d = (session) => {
      const d = FIO.buildPoints3dExportData(session);
      const fi = d.frame_indices.indexOf(0);
      if (fi < 0) return null;
      const byIdentity = {};
      d.points_3d[fi].forEach((perTrack, ti) => {
        const flat = [];
        for (const p of perTrack) flat.push(p[0], p[1], p[2]);
        byIdentity[ti] = flat;
      });
      return byIdentity;
    };
    const flatDelta = (a, b) => {
      if (!a || !b || a.length !== b.length) return Infinity;
      let worst = 0;
      for (let i = 0; i < a.length; i++) {
        if (Number.isNaN(a[i]) && Number.isNaN(b[i])) continue;
        worst = Math.max(worst, Math.abs(a[i] - b[i]));
      }
      return worst;
    };
    /** The trackIdx this group is built from — indexes the reference solves. */
    const trackOf = (g) => {
      for (const [, inst] of g.instances) if (inst && inst.trackIdx != null) return inst.trackIdx;
      return -1;
    };
    const flatten = (pts) => Array.from(pts);
    /**
     * THE export assertion: for every live group, the 3D the exporter emits at
     * that group's identity slot must equal an independent BA solve of the same
     * observations — and must NOT equal the DLT solve.
     */
    const exportVsRefs = (session, groups) => {
      const ex = exported3d(session);
      let worstVsBa = 0, minVsDlt = Infinity, missing = 0;
      for (const g of groups) {
        const t = trackOf(g);
        const got = ex ? ex[g.identityId] : null;
        if (!got || t < 0) { missing++; continue; }
        worstVsBa = Math.max(worstVsBa, flatDelta(got, flatten(refBaPts[t])));
        minVsDlt = Math.min(minVsDlt, flatDelta(got, flatten(refDltPts[t])));
      }
      return { worstVsBa, minVsDlt, missing };
    };

    const boot = (session) => {
      AS.state.sessions = [session];
      AS.state.activeSessionIdx = 0;
      AS.state.session = session;
      AS.state.totalFrames = F.NF;
      AS.state.currentFrame = 0;
      AS.state.views = [];
      AS.state.triangulationResults = new Map();
    };

    const prevPref = SET.getDefaultTriangulationMethod();
    const status = () => (document.getElementById('statusText') || {}).textContent || '';
    // Provenance counters read straight out of the real status line.
    const provenance = () => {
      const m = /([\d,]+) kept existing 3D, ([\d,]+) solved via Bundle Adjustment, ([\d,]+) via DLT/
        .exec(status());
      if (!m) return null;
      const n = (s) => parseInt(s.replace(/,/g, ''), 10);
      return { reused: n(m[1]), solvedBa: n(m[2]), solvedDlt: n(m[3]) };
    };

    // =====================================================================
    // Phase A — Triangulate All ▸ BA, then "Group by Identity".
    // Lazy session, so this is the real reopened-project path.
    //
    // Settings ▸ Default Triangulation = BA, because that is the user this bug
    // was reported by: someone who has selected Bundle Adjustment. Under the
    // governance rule the setting is exactly what keeps BA 3D across a regroup.
    // (Pre-fix these sweeps ignored the setting entirely and always produced DLT,
    // so this phase still has teeth — confirmed.)
    // =====================================================================
    SET.setDefaultTriangulationMethod('ba');
    const sA = F.mkSession('BA_THEN_GROUP_BY_IDENTITY');
    boot(sA);
    await TRI.triangulateAllFrames('ba');
    const groupsBeforeA = TRI.getInstanceGroupsForFrame(0) || [];
    const methodsBeforeA = groupsBeforeA.map(g => g.triangulationMethod);
    const exportBeforeA = exportVsRefs(sA, groupsBeforeA);

    await EM.groupByIdentityAndTriangulateAll();

    const groupsA = TRI.getInstanceGroupsForFrame(0) || [];
    const methodsAfterA = groupsA.map(g => g.triangulationMethod);
    const exportA = exportVsRefs(sA, groupsA);

    // =====================================================================
    // Phase B — Triangulate All ▸ BA, then the real "Group by Track" modal
    // (module-local function, only reachable through its UI). Eager session:
    // the modal's own track-stat scan reads `session.frameGroups`, and Group by
    // Track requires cross-camera trackIdx correspondence anyway.
    // =====================================================================
    const sB = F.mkSession('BA_THEN_GROUP_BY_TRACK', { eager: true });
    boot(sB);
    await TRI.triangulateAllFrames('ba');

    EM.showGroupByTrackModal();
    const goBtn = document.getElementById('gbtGo');
    const nTrackCbs = document.querySelectorAll('.gbt-track-cb:checked').length;
    const nCamCbs = document.querySelectorAll('.gbt-cam-cb:checked').length;
    goBtn.click();
    // The handler is async; wait for the modal to tear itself down.
    for (let i = 0; i < 200 && document.getElementById('gbtGo'); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    const modalGone = !document.getElementById('gbtGo');

    const groupsB = TRI.getInstanceGroupsForFrame(0) || [];
    const methodsAfterB = groupsB.map(g => g.triangulationMethod);
    const exportB = exportVsRefs(sB, groupsB);

    // =====================================================================
    // Phase C — a group with NO prior 3D takes the user's Settings method,
    // not a hardcoded DLT. Same sweep, but nothing was triangulated first.
    // =====================================================================
    const sC = F.mkSession('FRESH_GROUPING_HONORS_SETTING');   // still Settings=BA
    boot(sC);
    await EM.groupByIdentityAndTriangulateAll();
    const groupsC = TRI.getInstanceGroupsForFrame(0) || [];
    const methodsC = groupsC.map(g => g.triangulationMethod);
    const exportC = exportVsRefs(sC, groupsC);
    const provC = provenance();

    // =====================================================================
    // Phase D — GOVERNANCE, direction 1: default DLT over a DLT-solved project
    // must ADOPT everything and solve nothing. This is the free fast path, and
    // it must survive the method-match rule.
    // =====================================================================
    SET.setDefaultTriangulationMethod('dlt');
    const sD = F.mkSession('DLT_OVER_DLT_ADOPTS');
    boot(sD);
    await TRI.triangulateAllFrames('dlt');
    const nGroupsAllD = [...sD.instanceGroups.values()].reduce((a, g) => a + g.length, 0);
    const tD0 = performance.now();
    await EM.groupByIdentityAndTriangulateAll();
    const msD = performance.now() - tD0;
    const groupsD = TRI.getInstanceGroupsForFrame(0) || [];
    const methodsD = groupsD.map(g => g.triangulationMethod);
    const provD = provenance();

    // =====================================================================
    // Phase E — GOVERNANCE, direction 2: switch the default to BA and re-run the
    // SAME operation over a DLT-solved project. Every group must come out BA,
    // including the unchanged-membership ones that phase D adopted. This is the
    // user's rule, and the case adoption-on-membership-alone silently violated.
    // =====================================================================
    SET.setDefaultTriangulationMethod('ba');
    const sE = F.mkSession('BA_DEFAULT_RESOLVES_DLT_GROUPS');
    boot(sE);
    await TRI.triangulateAllFrames('dlt');
    const methodsBeforeE = (TRI.getInstanceGroupsForFrame(0) || []).map(g => g.triangulationMethod);
    const exportBeforeE = exportVsRefs(sE, TRI.getInstanceGroupsForFrame(0) || []);
    const tE0 = performance.now();
    await EM.groupByIdentityAndTriangulateAll();
    const msE = performance.now() - tE0;
    const groupsE = TRI.getInstanceGroupsForFrame(0) || [];
    const methodsE = groupsE.map(g => g.triangulationMethod);
    const exportE = exportVsRefs(sE, groupsE);
    const provE = provenance();

    // =====================================================================
    // Phase F — an EXPLICIT pick beats the default. "Triangulate All ▸ DLT"
    // routes to groupByIdentityAndTriangulateAll('dlt'); under a BA default that
    // must still produce DLT, or an explicit user choice is being overridden.
    // =====================================================================
    const sF = F.mkSession('EXPLICIT_DLT_UNDER_BA_DEFAULT');
    boot(sF);
    await EM.groupByIdentityAndTriangulateAll('dlt');   // still Settings=BA here
    const groupsF = TRI.getInstanceGroupsForFrame(0) || [];
    const methodsF = groupsF.map(g => g.triangulationMethod);
    const exportF = exportVsRefs(sF, groupsF);
    const settingDuringF = SET.getDefaultTriangulationMethod();

    SET.setDefaultTriangulationMethod(prevPref);

    return {
      baVsDlt, cost,
      nGroupsA: groupsA.length, methodsBeforeA, methodsAfterA, exportBeforeA, exportA,
      nGroupsB: groupsB.length, methodsAfterB, nTrackCbs, nCamCbs, modalGone, exportB,
      nGroupsC: groupsC.length, methodsC, exportC, provC,
      nGroupsAllD, methodsD, provD, msD,
      methodsBeforeE, exportBeforeE, methodsE, exportE, provE, msE,
      methodsF, exportF, settingDuringF,
    };
  });

  console.log(`    BA vs DLT: solutions differ by up to ${out.baVsDlt.toFixed(6)} world units; ` +
    `cost ratio ${out.cost.ratio.toFixed(2)}x (DLT ${out.cost.dltMs.toFixed(1)} ms, ` +
    `BA ${out.cost.baMs.toFixed(1)} ms over the same work)`);
  const fmt = (e) => `vsBA ${e.worstVsBa} vsDLT ${e.minVsDlt} missing ${e.missing}`;
  console.log(`    phase A (Group by Identity): methods ${JSON.stringify(out.methodsBeforeA)} -> ` +
    `${JSON.stringify(out.methodsAfterA)} | export before: ${fmt(out.exportBeforeA)} ` +
    `| export after: ${fmt(out.exportA)}`);
  console.log(`    phase B (Group by Track modal): ${out.nTrackCbs} tracks / ${out.nCamCbs} cams ` +
    `selected, modal closed=${out.modalGone} | methods ${JSON.stringify(out.methodsAfterB)} | ` +
    `export: ${fmt(out.exportB)}`);
  console.log(`    phase C (fresh grouping, Settings=BA): methods ${JSON.stringify(out.methodsC)} | ` +
    `export: ${fmt(out.exportC)} | provenance ${JSON.stringify(out.provC)}`);
  console.log(`    phase D (Settings=DLT over DLT): methods ${JSON.stringify(out.methodsD)} | ` +
    `provenance ${JSON.stringify(out.provD)} | ${out.msD.toFixed(0)} ms for ` +
    `${out.nGroupsAllD} groups project-wide`);
  console.log(`    phase E (Settings=BA over DLT): methods ${JSON.stringify(out.methodsBeforeE)} -> ` +
    `${JSON.stringify(out.methodsE)} | export ${fmt(out.exportE)} | ` +
    `provenance ${JSON.stringify(out.provE)} | ${out.msE.toFixed(0)} ms`);
  console.log(`    phase F (explicit DLT, Settings=${out.settingDuringF}): ` +
    `methods ${JSON.stringify(out.methodsF)} | export ${fmt(out.exportF)}`);
  console.log(`    adopt-vs-re-solve wall clock: ${out.msD.toFixed(0)} ms (all adopted) vs ` +
    `${out.msE.toFixed(0)} ms (all re-solved with BA) = ` +
    `${(out.msE / Math.max(out.msD, 1e-9)).toFixed(2)}x`);

  // ---- preconditions ------------------------------------------------------
  check(out.baVsDlt > 1e-4,
    `precondition: BA's and DLT's 3D differ measurably (${out.baVsDlt.toFixed(6)} world units) — ` +
    `if they coincide this test cannot detect a silent downgrade`);
  check(out.methodsBeforeA.every(m => m === 'ba'),
    `precondition: Triangulate All ▸ BA left every group on 'ba' ` +
    `(got ${JSON.stringify(out.methodsBeforeA)})`);
  check(out.exportBeforeA.worstVsBa === 0 && out.exportBeforeA.missing === 0,
    `precondition: straight after Triangulate All ▸ BA, the exporter already emits ` +
    `BA's 3D (${fmt(out.exportBeforeA)})`);

  // Each phase asserts the same three things about what the EXPORTER emits:
  // it equals BA's solve exactly, it is NOT DLT's, and no group is missing.
  const exportOk = (label, e, nGroups, expectedGroups, methods) => {
    check(nGroups === expectedGroups, `${label}: kept ${expectedGroups} groups on frame 0 (got ${nGroups})`);
    check(methods.every(m => m === 'ba'),
      `${label}: triangulationMethod NOT downgraded to 'dlt' (got ${JSON.stringify(methods)})`);
    check(e.missing === 0, `${label}: every group appears in the export (missing ${e.missing})`);
    check(e.worstVsBa === 0,
      `${label}: the EXPORTED 3D (buildPoints3dExportData — what buildPoints3dH5 and the ` +
      `JSON labels export write) is bit-identical to an independent BA solve ` +
      `(worst |delta| ${e.worstVsBa})`);
    check(e.minVsDlt > 1e-4,
      `${label}: ...and is NOT the DLT solve (closest |delta| to DLT ${e.minVsDlt}, ` +
      `must be non-zero)`);
  };

  // ---- phase A: Group by Identity -----------------------------------------
  exportOk('Group by Identity after BA', out.exportA, out.nGroupsA, 2, out.methodsAfterA);

  // ---- phase B: Group by Track (driven through its real modal) -------------
  check(out.nTrackCbs === 2 && out.nCamCbs === 3,
    `the Group by Track modal opened with all tracks/cameras selected ` +
    `(${out.nTrackCbs} tracks, ${out.nCamCbs} cams)`);
  check(out.modalGone, 'the Group by Track modal completed and closed');
  exportOk('Group by Track after BA', out.exportB, out.nGroupsB, 2, out.methodsAfterB);

  // ---- phase C: no prior 3D => honor the user's global setting -------------
  check(out.methodsC.every(m => m === 'ba'),
    `a group with NO prior 3D is solved with the user's Settings method (BA), not a ` +
    `hardcoded DLT (got ${JSON.stringify(out.methodsC)})`);
  exportOk('fresh grouping with Settings=BA', out.exportC, out.nGroupsC, 2, out.methodsC);
  check(out.provC && out.provC.solvedBa > 0 && out.provC.solvedDlt === 0 && out.provC.reused === 0,
    `...and the status line reports that provenance honestly ` +
    `(${JSON.stringify(out.provC)}) — nothing adopted, nothing solved by DLT`);

  // ---- phase D: GOVERNANCE, DLT over DLT adopts everything ----------------
  check(out.methodsD.every(m => m === 'dlt'),
    `Settings=DLT over a DLT project leaves every group on 'dlt' ` +
    `(got ${JSON.stringify(out.methodsD)})`);
  check(out.provD && out.provD.reused === out.nGroupsAllD &&
        out.provD.solvedBa === 0 && out.provD.solvedDlt === 0,
    `...and ADOPTS every one of the ${out.nGroupsAllD} project-wide groups, solving ` +
    `none (${JSON.stringify(out.provD)}) — the free fast path must survive the ` +
    `method-match rule`);

  // ---- phase E: GOVERNANCE, a BA default re-solves DLT groups --------------
  check(out.methodsBeforeE.every(m => m === 'dlt') && out.exportBeforeE.worstVsBa > 1e-4,
    `precondition: phase E starts from genuinely DLT 3D ` +
    `(methods ${JSON.stringify(out.methodsBeforeE)}, ${out.exportBeforeE.worstVsBa} from BA)`);
  check(out.methodsE.every(m => m === 'ba'),
    `THE RULE: with Settings=BA, Group by ID & Triangulate All leaves BA on EVERY ` +
    `group — including unchanged-membership groups that already had valid DLT 3D ` +
    `(got ${JSON.stringify(out.methodsE)}); adopting on membership alone would have ` +
    `kept DLT here and made the setting a no-op`);
  exportOk('Settings=BA over a DLT project', out.exportE, out.methodsE.length, 2, out.methodsE);
  check(out.provE && out.provE.reused === 0 && out.provE.solvedBa === out.nGroupsAllD &&
        out.provE.solvedDlt === 0,
    `...and nothing was adopted: all ${out.nGroupsAllD} groups re-solved via BA ` +
    `(${JSON.stringify(out.provE)})`);

  // ---- phase F: an explicit pick beats the default -------------------------
  check(out.settingDuringF === 'ba',
    `precondition: the Settings default was still BA during phase F (got ${out.settingDuringF})`);
  check(out.methodsF.every(m => m === 'dlt'),
    `an EXPLICIT 'dlt' (what "Triangulate All ▸ DLT" now passes) beats a BA default ` +
    `(got ${JSON.stringify(out.methodsF)})`);
  check(out.exportF.worstVsBa > 1e-4 && out.exportF.minVsDlt === 0,
    `...and the exported 3D really is DLT's, not BA's ` +
    `(vsBA ${out.exportF.worstVsBa}, vsDLT ${out.exportF.minVsDlt})`);

  check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));

  await browser.close();
} finally {
  server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
