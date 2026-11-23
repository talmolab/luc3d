/**
 * volume-fusion.mjs — File ▸ Load Volume 3D and Triangulate ▸ Fuse with volume, end to end.
 *
 * On the bundle-adjustment rig fixture (3 cameras with real k1 distortion, 2 animals, 8 nodes, 2 px noise;
 * `fixtures/ba-rig-fixture.js`), a .vol3d.h5 is written IN the page with h5wasm (the file layout
 * scripts/export_volume3d.py writes: node order reversed and an extra node, to exercise matching by name) and
 * loaded through the real handler (`handleLoadVolume3d`). The volume is the truth, sharper than the 2D:
 *   1. the File menu item exists; Triangulate's "Fuse with volume" checkbox is greyed out until a volume is
 *      loaded, then on;
 *   2. This frame (`triangulateCurrentFrame`): with fusion off, plain DLT; on, every group is fused
 *      (`group.volumeFused`) and lands nearer the truth;
 *   3. All frames on a LAZY session, through a forced 2-worker pool (the volume travels in each job): every
 *      group fused and nearer the truth than an independent plain DLT;
 *   4. the display fill (ui/rendering.js) keeps a fused group's stored 3D even when the reprojection threshold is
 *      on (a re-solve there would drop the volume);
 *   5. fusion off again: Triangulate All gives exactly the plain DLT (bit-identical), no group marked fused;
 *   6. the skeleton check (Triangulate ▸ Skeleton check, with the volume as a source): the file names one chain
 *      (bones n5-n6, n6-n7) and its row for frame 0, animal 0 puts n6
 *      and n7 four bones off. With the check, This frame and All frames (through the workers) take that chain
 *      from the plain solve (on the truth); with it off, the group keeps the volume's misplaced chain.
 * Run: node tests/e2e/volume-fusion.mjs
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const server = await startServer(repoRoot);
const PORT = server.port;
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/index.html`)).ok) break; } catch {}
  await new Promise(r => setTimeout(r, 250));
}

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

try {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => {
    if (m.type() !== 'error' || /Failed to load resource|net::ERR|404/.test(m.text())) return;   // absent demo assets
    errs.push('console: ' + m.text());
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

  const out = await page.evaluate(async () => {
    const AS = await import('/ui/app-state.js');
    const TRI = await import('/pose/triangulation.js');
    const RND = await import('/ui/rendering.js');
    const V3D = await import('/pose/volume3d.js');
    const RUN = await import('/pose/skeleton-check-run.js');
    const VFILE = await import('/import-export/volume3d-file.js');
    const FIO = await import('/import-export/file-io.js');
    const SET = await import('/ui/settings.js');
    const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
    const F = await buildBaRigFixture({ frames: 6 });
    const r = {};
    const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    /** mean node distance of a group's 3D to the nearest animal's truth at frame f */
    const errTruth = (pts, f) => Math.min.apply(null, F.truth[f].map(T => {
      let s = 0, n = 0;
      for (let k = 0; k < F.NNODE; k++) {
        const X = [pts[3 * k], pts[3 * k + 1], pts[3 * k + 2]];
        if (X.every(Number.isFinite)) { s += dist3(X, T[k]); n++; }
      }
      return n ? s / n : Infinity;
    }));
    const useSession = (s) => {
      AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
      AS.state.totalFrames = F.NF; AS.state.currentFrame = 0; AS.state.views = [];
      AS.state.triangulationResults = new Map();
    };
    SET.updateTrackingThresholds({ reprojErrorThreshold: 0 });

    // ---- 1. menu, checkbox, a real file through the real handler
    r.menuItem = !!document.getElementById('menuLoadVolume3d');
    const box = document.getElementById('tbVolumeFusion');
    const sE = F.mkSession('VOL_EAGER', { eager: true });
    useSession(sE);
    V3D.setVolumeSettings({ enabled: true });
    document.getElementById('triangulateDropdown').dispatchEvent(new Event('mouseenter'));
    r.boxDisabledBefore = !!(box && box.disabled);

    const SD = 0.02;    // the volume: the truth, sharper than the 2D (2 px ~ 0.1 world units here)
    const names = ['extra'].concat(Array.from({ length: F.NNODE }, (_, i) => 'n' + (F.NNODE - 1 - i)));
    const J = names.length, R = F.NF * F.NTRACK;
    const frames = new Int32Array(R), means = new Float32Array(R * J * 3), covs = new Float32Array(R * J * 6);
    // frame 0, animal 0: the volume puts n6 and n7 four bone lengths off (a chain reaching for a neighbour)
    const BONE = dist3(F.truth[0][0][5], F.truth[0][0][6]), SHIFT = 4 * BONE;
    r.shift = SHIFT;
    for (let f = 0; f < F.NF; f++) for (let t = 0; t < F.NTRACK; t++) {
      const row = f * F.NTRACK + t;
      frames[row] = f;
      names.forEach((n, j) => {
        const k = Number(n.slice(1));
        let X = n === 'extra' ? [0, 0, 0] : F.truth[f][t][k];
        if (f === 0 && t === 0 && (k === 6 || k === 7)) X = [X[0] + SHIFT, X[1], X[2]];
        means.set(X, (row * J + j) * 3);
        covs.set([SD * SD, 0, 0, SD * SD, 0, SD * SD], (row * J + j) * 6);
      });
    }
    const mod = await FIO.initH5wasm();
    const fname = '/e2e_volume_' + Date.now() + '.h5';
    const hf = new mod.File(fname, 'w');
    hf.create_dataset({ name: 'frame_indices', data: frames });
    hf.create_dataset({ name: 'means', data: means, shape: [R, J, 3] });
    hf.create_dataset({ name: 'covs', data: covs, shape: [R, J, 6] });
    hf.create_dataset({ name: 'node_names', data: names });
    hf.create_attribute('format', 'lucid-volume3d/1');
    hf.create_attribute('cov_scale', new Float64Array([1.0]));
    hf.create_attribute('skeleton_chains', JSON.stringify([{ name: 'end', bones: [['n5', 'n6'], ['n6', 'n7']], nodes: ['n6', 'n7'] }]));
    hf.close();
    const bytes = mod.FS.readFile(fname);
    mod.FS.unlink(fname);
    const data = await VFILE.handleLoadVolume3d(new File([bytes], 'e2e.vol3d.h5'));
    r.loaded = !!data;
    r.rows = data ? data.frameIndices.length : 0;
    r.boxOnAfter = !!(box && !box.disabled && box.checked);
    r.coverage = V3D.volumeNodeCoverage(sE);
    r.chains = V3D.volumeChains(sE).map(c => c.name);
    r.status = (document.getElementById('statusText') || {}).textContent || '';
    /** distance of node k, in the frame-f group nearest animal t (by node 0), to that animal's truth */
    const chainErr = (groups, f, t, k) => {
      let best = null, bestD = Infinity;
      for (const g of groups) {
        const d = dist3([g.points3d[0], g.points3d[1], g.points3d[2]], F.truth[f][t][0]);
        if (d < bestD) { bestD = d; best = g; }
      }
      return best ? dist3([best.points3d[3 * k], best.points3d[3 * k + 1], best.points3d[3 * k + 2]], F.truth[f][t][k]) : Infinity;
    };

    // ---- 2. This frame: plain, then fused
    V3D.setVolumeSettings({ enabled: false });
    TRI.triangulateCurrentFrame('dlt');
    const plain0 = (TRI.getInstanceGroupsForFrame(0) || []).map(g => Float64Array.from(g.points3d));
    V3D.setVolumeSettings({ enabled: true });
    RUN.setSkeletonCheckSettings({ enabled: true });   // the volume's chains are checked by Triangulate ▸ Skeleton check
    TRI.triangulateCurrentFrame('dlt');
    const g0 = TRI.getInstanceGroupsForFrame(0) || [];
    r.frameFused = g0.map(g => !!g.volumeFused);
    r.frameErrPlain = plain0.map(p => errTruth(p, 0));
    r.frameErrFused = g0.map(g => errTruth(g.points3d, 0));
    r.frameChain = [6, 7].map(k => chainErr(g0, 0, 0, k));
    RUN.setSkeletonCheckSettings({ enabled: false });
    TRI.triangulateCurrentFrame('dlt');
    r.frameChainOff = [6, 7].map(k => chainErr(TRI.getInstanceGroupsForFrame(0) || [], 0, 0, k));
    RUN.setSkeletonCheckSettings({ enabled: true });

    // ---- 3. All frames, lazy session, through 2 workers
    window.LUCID_TRIANGULATION_WORKERS = 2;
    const sL = F.mkSession('VOL_LAZY');
    useSession(sL);
    V3D.setSessionVolume(sL, data);
    await TRI.triangulateAllFrames('dlt');
    r.released = sL.lazyLoader.released.length;
    r.allChain = [6, 7].map(k => chainErr(sL.instanceGroups.get(0) || [], 0, 0, k));
    r.allFused = []; r.allErrFused = []; r.allErrRef = [];
    for (let f = 0; f < F.NF; f++) {
      const gs = sL.instanceGroups.get(f) || [];
      gs.forEach(g => { r.allFused.push(!!g.volumeFused); r.allErrFused.push(errTruth(g.points3d, f)); });
      F.refSolve(f, 'dlt').forEach(x => r.allErrRef.push(errTruth(x.points3d, f)));
    }

    // ---- 4. the display fill keeps the fused 3D with the reprojection threshold on
    SET.updateTrackingThresholds({ reprojErrorThreshold: 15 });
    const before = (sL.instanceGroups.get(0) || []).map(g => Float64Array.from(g.points3d));
    (sL.instanceGroups.get(0) || []).forEach(g => { g.reprojections = null; if (g.reprojectedInstances) g.reprojectedInstances.clear(); });
    AS.state.triangulationResults = new Map();
    RND.drawAllOverlays(0);
    const shown = AS.state.triangulationResults.get(0) || [];
    r.fillShown = shown.length;
    r.fillKeeps = shown.every(x => {
      const i = (sL.instanceGroups.get(0) || []).indexOf(x.group);
      return i >= 0 && F.points3dDelta(x.points3d, before[i]) === 0;
    });
    SET.updateTrackingThresholds({ reprojErrorThreshold: 0 });

    // ---- 5. off again: exactly plain DLT
    V3D.setVolumeSettings({ enabled: false });
    RUN.setSkeletonCheckSettings({ enabled: false });
    await TRI.triangulateAllFrames('dlt');
    r.offFused = 0; r.offDelta = 0;
    for (let f = 0; f < F.NF; f++) {
      const gs = sL.instanceGroups.get(f) || [];
      const ref = F.refSolve(f, 'dlt').map(x => x.points3d);
      gs.forEach(g => {
        if (g.volumeFused) r.offFused++;
        r.offDelta = Math.max(r.offDelta, Math.min.apply(null, ref.map(p => F.points3dDelta(g.points3d, p))));
      });
    }
    V3D.setVolumeSettings({ enabled: true });
    delete window.LUCID_TRIANGULATION_WORKERS;
    return r;
  });

  const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  check(out.menuItem, 'File ▸ Load Volume 3D is in the menu');
  check(out.boxDisabledBefore, '"Fuse with volume" is greyed out before a volume is loaded');
  check(out.loaded && out.rows === 12, `the .vol3d.h5 loads through the real handler (${out.rows} rows)`);
  check(out.boxOnAfter, '"Fuse with volume" is on once loaded');
  check(out.coverage.matched === 8 && out.coverage.total === 8, `nodes matched by name: ${out.coverage.matched}/${out.coverage.total}`);
  check(out.chains.join() === 'end', `the file's skeleton chain is read (${out.chains.join()})`);
  check(/Skeleton check: end/.test(out.status), 'the load status names it: ' + out.status);   // "Its chains for Triangulate ▸ Skeleton check: end."
  check(out.frameFused.length === 2 && out.frameFused.every(Boolean), 'This frame: every group fused');
  console.log(`    This frame, mean node error to the truth: plain ${mean(out.frameErrPlain).toFixed(4)}, fused ${mean(out.frameErrFused).toFixed(4)}`);
  check(mean(out.frameErrFused) < 0.5 * mean(out.frameErrPlain), 'This frame: fused nearer the truth than plain DLT');
  console.log(`    skeleton check, n6/n7 off the truth (the volume put them ${out.shift.toFixed(3)} off): This frame ${out.frameChain.map(x => x.toFixed(3)).join(', ')}; check off ${out.frameChainOff.map(x => x.toFixed(3)).join(', ')}; All frames ${out.allChain.map(x => x.toFixed(3)).join(', ')}`);
  check(out.frameChainOff.every(x => x > 0.5 * out.shift), 'skeleton check off: the group keeps the volume\'s misplaced chain');
  check(out.frameChain.every(x => x < 0.1 * out.shift), 'This frame: the chain comes back from the plain solve');
  check(out.allChain.every(x => x < 0.1 * out.shift), 'All frames (2 workers): the same');
  check(out.released > 0, `All frames took the windowed (lazy) path (${out.released} window releases)`);
  check(out.allFused.length === 12 && out.allFused.every(Boolean), `All frames: every group fused (${out.allFused.filter(Boolean).length}/${out.allFused.length})`);
  console.log(`    All frames (2 workers), mean error: independent plain DLT ${mean(out.allErrRef).toFixed(4)}, fused ${mean(out.allErrFused).toFixed(4)}`);
  check(mean(out.allErrFused) < 0.5 * mean(out.allErrRef), 'All frames: fused nearer the truth than plain DLT');
  check(out.fillShown === 2 && out.fillKeeps, 'the display keeps the fused 3D with the reprojection threshold on');
  check(out.offFused === 0, 'fusion off: no group marked fused');
  check(out.offDelta === 0, `fusion off: Triangulate All equals plain DLT exactly (worst delta ${out.offDelta})`);
  check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await browser.close();
} catch (e) {
  console.error(e);
  fails++;
} finally {
  server.kill('SIGTERM');
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
