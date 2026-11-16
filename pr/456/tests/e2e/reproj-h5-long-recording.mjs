/**
 * reproj-h5-long-recording.mjs — File ▸ Export Reprojections (H5) on a long
 * recording.
 *
 * ## The bug
 * A lazily opened 15-minute, 150 fps, 5-camera, 2-mouse project (135,181
 * frames, 15 nodes) ended the export with only "Reprojections H5 error:
 * Requested allocation of 4704229200 bytes exceeds maximum memory of
 * 2147483648 bytes" in the status bar, and no progress card. `buildReprojH5`
 * built the whole (frames, tracks, cameras, nodes, 2) float64 array at once and
 * handed it to h5wasm (2 GB heap), and sized the track axis by every tracklet
 * (29 after Track All) although groups are placed by identity (2): 4.7 GB.
 *
 * ## What this pins
 *   1. The same shape (135,181 frames, 29 tracks, 2 identities, 5 cameras,
 *      15 nodes) exports: the track axis is the identities, the dataset is
 *      chunked + gzip, progress is reported more than once and ends at the
 *      total, and sampled frames hold exactly `reprojectPointsCamera` of each
 *      group's 3D (NaN for a missing node / animal). Fails on the old build.
 *   2. Identities whose ids are not 0..n-1 are placed by position.
 *   3. The menu item shows the "Export Reprojections" progress card, downloads
 *      reprojections.h5 and reports success.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8341);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ acceptDownloads: true });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

  // A synthetic session: identities, extra tracklets, groups with 3D only (as
  // a lazy project after Track All has them).
  await page.evaluate(async () => {
    const pd = await import('/pose/pose-data.js');
    const { Skeleton, Camera, InstanceGroup, Session, Identity } = pd;
    const K = [[1000, 0, 640], [0, 1000, 512], [0, 0, 1]];
    window.__mkSession = (NF, opts) => {
      opts = opts || {};
      const NC = 5, NN = 15, NTRK = 29;
      const cams = Array.from({ length: NC }, (_, i) =>
        new Camera('cam' + i, K, [-0.2, 0, 0, 0, 0], [0.1 * i, 0.3 * (i - 2), 0], [0, 0, 60], [1280, 1024]));
      const skel = new Skeleton('sk', Array.from({ length: NN }, (_, i) => 'n' + i),
        Array.from({ length: NN - 1 }, (_, i) => [i, i + 1]));
      const s = new Session(cams, skel, Array.from({ length: NTRK }, (_, i) => 'track_' + i), 'long');
      if (opts.idIds) s.identities = opts.idIds.map((id, i) => new Identity(id, 'mouse' + i));
      else { s.addIdentity('mouse0'); s.addIdentity('mouse1'); }
      const ids = s.identities.map(x => x.id);
      for (let f = 0; f < NF; f++) {
        const gs = [];
        for (let a = 0; a < 2; a++) {
          if (f % 7 === 3 && a === 1) continue;           // mouse1 undetected
          const p = new Float64Array(NN * 3);
          for (let n = 0; n < NN; n++) {
            const t = (f % 900) * 0.01;
            p[n * 3] = (a ? 4 : -4) + Math.sin(t + n) * 3;
            p[n * 3 + 1] = Math.cos(t * 0.7 + n) * 3;
            p[n * 3 + 2] = n * 0.2;
          }
          if (f % 11 === 5) p.fill(NaN, 6, 9);            // node 2 missing
          const g = new InstanceGroup(f * 2 + a, ids[a]);
          g.points3d = p;
          gs.push(g);
        }
        s.instanceGroups.set(f, gs);
      }
      return s;
    };
    // Read back + compare sampled frames with an independent reprojection.
    window.__readBack = async (blob, session, sample) => {
      const TC = await import('/pose/triangulation-core.js');
      const fn = '/_reproj_long.h5';
      window.h5wasm.FS.writeFile(fn, new Uint8Array(await blob.arrayBuffer()));
      const h5 = new window.h5wasm.File(fn, 'r');
      const out = { bad: [], checked: 0, nanChecked: 0 };
      try {
        const d = h5.get('reprojections');
        out.shape = d.shape;
        out.chunks = d.metadata.chunks;
        out.filters = (d.filters || []).map(x => x.id);
        out.trackNames = Array.from(h5.get('track_names').value);
        out.cameraNames = Array.from(h5.get('camera_names').value);
        const frameIdx = h5.get('frame_indices').value;
        out.nFrameIdx = frameIdx.length;
        const [, nT, nC, nN] = d.shape;
        const idPos = new Map(session.identities.map((x, i) => [x.id, i]));
        for (const fi of sample) {
          const row = d.slice([[fi, fi + 1]]);
          const groups = session.instanceGroups.get(frameIdx[fi]) || [];
          const filled = new Set();
          for (const g of groups) {
            const t = idPos.get(g.identityId);
            for (let c = 0; c < nC; c++) {
              const exp = TC.reprojectPointsCamera(g.points3d, session.cameras[c]);
              for (let n = 0; n < nN; n++) {
                const b = ((t * nC + c) * nN + n) * 2;
                filled.add(b);
                if (!exp[n]) {
                  out.nanChecked++;
                  if (!Number.isNaN(row[b]) || !Number.isNaN(row[b + 1])) out.bad.push(`f${fi} t${t} c${c} n${n} not NaN`);
                } else {
                  out.checked++;
                  if (row[b] !== exp[n][0] || row[b + 1] !== exp[n][1]) out.bad.push(`f${fi} t${t} c${c} n${n} ${row[b]} vs ${exp[n][0]}`);
                }
              }
            }
          }
          for (let b = 0; b < nT * nC * nN * 2; b += 2) {
            if (filled.has(b)) continue;
            out.nanChecked++;
            if (!Number.isNaN(row[b])) out.bad.push(`f${fi} slot ${b} should be NaN`);
          }
        }
      } finally { h5.close(); window.h5wasm.FS.unlink(fn); }
      out.bad = out.bad.slice(0, 5);
      return out;
    };
  });

  // ---- 1. the 135,181-frame recording ---------------------------------------
  console.log('1. 135,181 frames, 29 tracklets, 2 identities, 5 cameras, 15 nodes');
  const r1 = await page.evaluate(async () => {
    const FIO = await import('/import-export/file-io.js');
    await window.h5wasm.ready;
    const NF = 135181;
    const s = window.__mkSession(NF);
    const prog = [];
    const t0 = performance.now();
    let blob, err = null;
    try {
      blob = await FIO.buildReprojH5(s, { onProgress: (d, t) => { prog.push([d, t]); } });
    } catch (e) { err = String(e && e.message || e); }
    const ms = performance.now() - t0;
    if (err) return { err };
    const sample = [0, 3, 5, 436, 437, 1000, 54321, 98765, NF - 2, NF - 1];
    const rb = await window.__readBack(blob, s, sample);
    return { ms, size: blob.size, prog: prog.length, last: prog[prog.length - 1],
      monotonic: prog.every((p, i) => i === 0 || p[0] > prog[i - 1][0]), ...rb };
  });
  if (r1.err) check(false, 'export failed: ' + r1.err);
  else {
    console.log(`     ${(r1.ms / 1000).toFixed(1)} s, ${(r1.size / 1048576).toFixed(1)} MB, ${r1.prog} progress calls`);
    check(JSON.stringify(r1.shape) === JSON.stringify([135181, 2, 5, 15, 2]), 'shape is (frames, identities, cameras, nodes, 2): ' + JSON.stringify(r1.shape));
    check(JSON.stringify(r1.trackNames) === '["mouse0","mouse1"]', 'track_names are the identities');
    check(r1.nFrameIdx === 135181, 'frame_indices has every frame');
    check(r1.cameraNames.length === 5, 'camera_names has 5 cameras');
    check(Array.isArray(r1.chunks) && r1.chunks[0] > 1 && r1.chunks[0] < 135181, 'chunked by frames: ' + JSON.stringify(r1.chunks));
    check(r1.filters.includes(1), 'gzip filter on the dataset');
    check(r1.prog > 1 && r1.monotonic && r1.last[0] === 135181 && r1.last[1] === 135181, 'progress reported in steps up to the total');
    check(r1.checked > 1000 && r1.nanChecked > 0 && r1.bad.length === 0,
      `sampled frames equal reprojectPointsCamera (${r1.checked} points, ${r1.nanChecked} NaN slots) ${r1.bad.join('; ')}`);
  }

  // ---- 2. identity ids that are not positions -------------------------------
  console.log('2. identities with ids 7 and 3');
  const r2 = await page.evaluate(async () => {
    const FIO = await import('/import-export/file-io.js');
    const s = window.__mkSession(50, { idIds: [7, 3] });
    const blob = await FIO.buildReprojH5(s);
    return window.__readBack(blob, s, [0, 3, 5, 49]);
  });
  check(JSON.stringify(r2.shape) === JSON.stringify([50, 2, 5, 15, 2]), 'two identity rows');
  check(r2.checked > 0 && r2.bad.length === 0, 'each group in its identity\'s row ' + r2.bad.join('; '));

  // ---- 3. the menu item ------------------------------------------------------
  console.log('3. File ▸ Export Reprojections (H5)');
  await page.evaluate(async () => {
    const AS = await import('/ui/app-state.js');
    const s = window.__mkSession(30000);
    AS.state.sessions = [s];
    AS.state.activeSessionIdx = 0;
    AS.state.session = s;
    window.__titles = new Set();
    window.__bars = 0;
    const title = document.getElementById('loadingTitle');
    const status = document.getElementById('loadingStatus');
    new MutationObserver(() => { if (title.textContent) window.__titles.add(title.textContent); })
      .observe(title, { childList: true, characterData: true, subtree: true });
    new MutationObserver(() => { if (/Writing reprojections: [\d,]+\/30,000 frames/.test(status.textContent)) window.__bars++; })
      .observe(status, { childList: true, characterData: true, subtree: true });
  });
  const dl = page.waitForEvent('download', { timeout: 120000 });
  await page.evaluate(() => document.getElementById('menuExportReprojH5').click());
  const download = await dl;
  await page.waitForFunction(() => /exported/i.test(document.getElementById('statusText').textContent), null, { timeout: 60000 });
  const r3 = await page.evaluate(() => ({
    titles: [...window.__titles], bars: window.__bars,
    status: document.getElementById('statusText').textContent,
    hidden: document.getElementById('loadingOverlay').classList.contains('hidden'),
  }));
  check(download.suggestedFilename() === 'reprojections.h5', 'downloads reprojections.h5');
  check(r3.titles.includes('Export Reprojections'), 'progress card titled "Export Reprojections"');
  check(r3.bars > 0, 'the card counts frames written');
  check(/Reprojections H5 exported \([\d.]+ MB\)/.test(r3.status) && r3.hidden, 'success status, card closed: ' + r3.status);

  check(errs.length === 0, 'no page errors ' + errs.slice(0, 3).join(' | '));
  await browser.close();
} finally {
  server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
