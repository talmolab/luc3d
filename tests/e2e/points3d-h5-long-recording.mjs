/**
 * points3d-h5-long-recording.mjs — File ▸ Export 3D Points (H5) on a long
 * recording.
 *
 * ## The bug
 * On a lazily opened 15-minute, 150 fps, 5-camera, 2-mouse project (135,219
 * frames, 15 nodes, 15 tracklets) the export took the heap from 1.3 to 3.9 GB
 * (cap ~4 GB), with no progress card. `buildPoints3dExportData` boxed every
 * node of every frame ([x, y, z] arrays, one row per tracklet although groups
 * are placed by identity), then `buildPoints3dH5` copied the identity rows
 * into two whole float64 arrays and handed them to h5wasm at once. Projects
 * with 29 tracklets were expected to crash. A group was also put in the row
 * numbered by its identity id, so ids that are not 0..n-1 were lost.
 *
 * ## What this pins
 *   1. 135,181 frames, 29 tracklets, 2 identities, 15 nodes export: the track
 *      axis is the identities, `points_3d` and `reprojection_error` are chunked
 *      + gzip float64, frames without 3D are left out, progress is reported
 *      more than once and ends at the total, and sampled frames hold each
 *      group's 3D exactly (NaN for a missing node / animal; the error is all
 *      NaN, as before). Fails on the old build.
 *   2. Identities whose ids are not 0..n-1 are placed by position, and
 *      `buildPoints3dExportData` (boxed) agrees with the file.
 *   3. The menu item shows the "Export 3D Points" progress card, downloads
 *      points3d.h5 and reports success.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8343);

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
  // a lazy project after Track All has them). Every 13th frame has no 3D.
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
          const g = new InstanceGroup(f * 2 + a, ids[a]);
          if (f % 13 !== 6) {                             // else: 2D only, no 3D
            const p = new Float64Array(NN * 3);
            for (let n = 0; n < NN; n++) {
              const t = (f % 900) * 0.01;
              p[n * 3] = (a ? 4 : -4) + Math.sin(t + n) * 3 + f * 1e-6;
              p[n * 3 + 1] = Math.cos(t * 0.7 + n) * 3;
              p[n * 3 + 2] = n * 0.2;
            }
            if (f % 11 === 5) p.fill(NaN, 6, 9);          // node 2 missing
            if (f % 17 === 4) p[13] = NaN;                // node 4 partly NaN = missing
            g.points3d = p;
          }
          gs.push(g);
        }
        s.instanceGroups.set(f, gs);
      }
      return s;
    };
    // Read back + compare sampled rows with the groups' own 3D.
    window.__readBack = async (blob, session, sampleRows) => {
      const fn = '/_points3d_long.h5';
      window.h5wasm.FS.writeFile(fn, new Uint8Array(await blob.arrayBuffer()));
      const h5 = new window.h5wasm.File(fn, 'r');
      const out = { bad: [], checked: 0, nanChecked: 0, errNotNaN: 0 };
      try {
        const d = h5.get('points_3d');
        const e = h5.get('reprojection_error');
        out.shape = d.shape;
        out.errShape = e.shape;
        out.dtype = [d.dtype, e.dtype];
        out.chunks = [d.metadata.chunks, e.metadata.chunks];
        out.filters = [(d.filters || []).map(x => x.id), (e.filters || []).map(x => x.id)];
        out.trackNames = Array.from(h5.get('track_names').value);
        out.nodeNames = Array.from(h5.get('node_names').value);
        const frameIdx = Array.from(h5.get('frame_indices').value);
        out.frameIdx = frameIdx;
        const [, nT, nN] = d.shape;
        const idPos = new Map(session.identities.map((x, i) => [x.id, i]));
        for (const r of sampleRows) {
          const row = d.slice([[r, r + 1]]);
          const erow = e.slice([[r, r + 1]]);
          for (const v of erow) if (!Number.isNaN(v)) out.errNotNaN++;
          const filled = new Set();
          for (const g of session.instanceGroups.get(frameIdx[r]) || []) {
            if (!g.points3d) continue;
            const t = idPos.get(g.identityId);
            for (let n = 0; n < nN; n++) {
              const b = (t * nN + n) * 3;
              filled.add(b);
              const p = g.points3d.subarray(n * 3, n * 3 + 3);
              if (p.some(Number.isNaN)) {
                out.nanChecked++;
                if (!(Number.isNaN(row[b]) && Number.isNaN(row[b + 1]) && Number.isNaN(row[b + 2])))
                  out.bad.push(`row ${r} t${t} n${n} should be NaN`);
              } else {
                out.checked++;
                if (row[b] !== p[0] || row[b + 1] !== p[1] || row[b + 2] !== p[2])
                  out.bad.push(`row ${r} t${t} n${n}: ${row[b]},${row[b + 1]},${row[b + 2]} vs ${Array.from(p)}`);
              }
            }
          }
          for (let b = 0; b < nT * nN * 3; b += 3) {
            if (filled.has(b)) continue;
            out.nanChecked++;
            if (!Number.isNaN(row[b])) out.bad.push(`row ${r} slot ${b} should be NaN`);
          }
        }
      } finally { h5.close(); window.h5wasm.FS.unlink(fn); }
      out.bad = out.bad.slice(0, 5);
      return out;
    };
  });

  // ---- 1. the 135,181-frame recording ---------------------------------------
  console.log('1. 135,181 frames, 29 tracklets, 2 identities, 15 nodes');
  const r1 = await page.evaluate(async () => {
    const FIO = await import('/import-export/file-io.js');
    await window.h5wasm.ready;
    const NF = 135181;
    const s = window.__mkSession(NF);
    const expFrames = [];
    for (let f = 0; f < NF; f++) if (f % 13 !== 6) expFrames.push(f);
    const prog = [];
    const t0 = performance.now();
    let blob, err = null;
    try {
      blob = await FIO.buildPoints3dH5(s, { onProgress: (d, t) => { prog.push([d, t]); } });
    } catch (e) { err = String(e && e.message || e); }
    const ms = performance.now() - t0;
    if (err) return { err };
    const n = expFrames.length;
    const sample = [0, 1, 2, 3, 4, 5, 6, 400, 401, 1000, 54321, 98765, n - 2, n - 1];
    const rb = await window.__readBack(blob, s, sample);
    const sameFrames = rb.frameIdx.length === n && rb.frameIdx.every((v, i) => v === expFrames[i]);
    delete rb.frameIdx;
    return { ms, size: blob.size, n, sameFrames, prog: prog.length, last: prog[prog.length - 1],
      monotonic: prog.every((p, i) => i === 0 || p[0] > prog[i - 1][0]), ...rb };
  });
  if (r1.err) check(false, 'export failed: ' + r1.err);
  else {
    console.log(`     ${(r1.ms / 1000).toFixed(1)} s, ${(r1.size / 1048576).toFixed(1)} MB, ${r1.prog} progress calls`);
    check(JSON.stringify(r1.shape) === JSON.stringify([r1.n, 2, 15, 3]), 'points_3d is (frames with 3D, identities, nodes, 3): ' + JSON.stringify(r1.shape));
    check(JSON.stringify(r1.errShape) === JSON.stringify([r1.n, 2, 15]), 'reprojection_error is (frames, identities, nodes): ' + JSON.stringify(r1.errShape));
    check(r1.dtype.every(t => t === '<d'), 'float64: ' + JSON.stringify(r1.dtype));
    check(JSON.stringify(r1.trackNames) === '["mouse0","mouse1"]', 'track_names are the identities');
    check(r1.nodeNames.length === 15, 'node_names has 15 nodes');
    check(r1.sameFrames, 'frame_indices are the frames with 3D, in order');
    check(r1.chunks.every(c => Array.isArray(c) && c[0] > 1 && c[0] < r1.n), 'both chunked by frames: ' + JSON.stringify(r1.chunks));
    check(r1.filters.every(f => f.includes(1)), 'gzip filter on both datasets');
    check(r1.prog > 1 && r1.monotonic && r1.last[0] === r1.n && r1.last[1] === r1.n, 'progress reported in steps up to the total');
    check(r1.checked > 300 && r1.nanChecked > 0 && r1.bad.length === 0,
      `sampled rows equal the groups' 3D (${r1.checked} nodes, ${r1.nanChecked} NaN slots) ${r1.bad.join('; ')}`);
    check(r1.errNotNaN === 0, 'reprojection_error is NaN, as before');
  }

  // ---- 2. identity ids that are not positions; boxed builder agrees ---------
  console.log('2. identities with ids 7 and 3');
  const r2 = await page.evaluate(async () => {
    const FIO = await import('/import-export/file-io.js');
    const s = window.__mkSession(50, { idIds: [7, 3] });
    // A group on no identity row, alone on frame 6 (which has no 3D otherwise).
    const stray = new (await import('/pose/pose-data.js')).InstanceGroup(999, 42);
    stray.points3d = new Float64Array(45).fill(1);
    s.instanceGroups.get(6).push(stray);
    const blob = await FIO.buildPoints3dH5(s);
    const rb = await window.__readBack(blob, s, [0, 1, 2, 3, 4, 5, 6, 44]);
    const boxed = FIO.buildPoints3dExportData(s);
    // The boxed export, flattened, equals the file's sampled rows.
    const fn = '/_points3d_boxed.h5';
    window.h5wasm.FS.writeFile(fn, new Uint8Array(await blob.arrayBuffer()));
    const h5 = new window.h5wasm.File(fn, 'r');
    let boxedSame = true;
    try {
      const all = h5.get('points_3d').value;
      const flat = boxed.points_3d.flat(3);
      boxedSame = flat.length === all.length && flat.every((v, i) => Object.is(v, all[i]));
    } finally { h5.close(); window.h5wasm.FS.unlink(fn); }
    return { ...rb, frameIdx: undefined, has6: rb.frameIdx.includes(6),
      boxedSame, boxedTracks: boxed.track_names, boxedRows: boxed.points_3d[0].length,
      boxedFrames: boxed.frame_indices.length, n: rb.frameIdx.length };
  });
  check(JSON.stringify(r2.shape) === JSON.stringify([r2.n, 2, 15, 3]), 'two identity rows');
  check(!r2.has6, 'a frame whose only 3D is on no identity row is left out');
  check(r2.checked > 0 && r2.bad.length === 0, 'each group in its identity\'s row ' + r2.bad.join('; '));
  check(r2.boxedSame && r2.boxedRows === 2 && r2.boxedFrames === r2.n && r2.boxedTracks.join() === 'mouse0,mouse1',
    'buildPoints3dExportData holds the same frames, rows and values');

  // ---- 3. the menu item ------------------------------------------------------
  console.log('3. File ▸ Export 3D Points (H5)');
  await page.evaluate(async () => {
    const AS = await import('/ui/app-state.js');
    const s = window.__mkSession(40000);
    AS.state.sessions = [s];
    AS.state.activeSessionIdx = 0;
    AS.state.session = s;
    window.__titles = new Set();
    window.__bars = 0;
    const title = document.getElementById('loadingTitle');
    const status = document.getElementById('loadingStatus');
    new MutationObserver(() => { if (title.textContent) window.__titles.add(title.textContent); })
      .observe(title, { childList: true, characterData: true, subtree: true });
    new MutationObserver(() => { if (/Writing 3D points: [\d,]+\/[\d,]+ frames/.test(status.textContent)) window.__bars++; })
      .observe(status, { childList: true, characterData: true, subtree: true });
  });
  const dl = page.waitForEvent('download', { timeout: 120000 });
  await page.evaluate(() => document.getElementById('menuExportPoints3dH5').click());
  const download = await dl;
  await page.waitForFunction(() => /exported/i.test(document.getElementById('statusText').textContent), null, { timeout: 60000 });
  const r3 = await page.evaluate(() => ({
    titles: [...window.__titles], bars: window.__bars,
    status: document.getElementById('statusText').textContent,
    hidden: document.getElementById('loadingOverlay').classList.contains('hidden'),
  }));
  check(download.suggestedFilename() === 'points3d.h5', 'downloads points3d.h5');
  check(r3.titles.includes('Export 3D Points'), 'progress card titled "Export 3D Points"');
  check(r3.bars > 0, 'the card counts frames written');
  check(/Points3d H5 exported \([\d.]+ MB\)/.test(r3.status) && r3.hidden, 'success status, card closed: ' + r3.status);

  check(errs.length === 0, 'no page errors ' + errs.slice(0, 3).join(' | '));
  await browser.close();
} finally {
  server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
