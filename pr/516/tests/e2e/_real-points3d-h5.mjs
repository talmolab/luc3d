/**
 * _real-points3d-h5.mjs — File ▸ Export 3D Points (H5) on a real project,
 * opened lazily the way File ▸ Load Project opens a large one.
 *
 * Not a test (needs a real project). Usage:
 *     PROJECT=/path/to/<recording>_luc3d_tailmarks.slp OUT=/path/to/points3d.h5 \
 *         node tests/e2e/_real-points3d-h5.mjs [port]
 *
 * Reports load and export times, the progress card's lines as they change,
 * the heap (and its peak during the export), and compares sampled rows with
 * each group's 3D. Check the written file with h5py afterwards.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.argv[2] || 8344);
const PROJECT = process.env.PROJECT;
const OUT = process.env.OUT || path.join(repoRoot, '_real-points3d.h5');
if (!PROJECT) { console.error('set PROJECT=<project .slp>'); process.exit(2); }

let fails = 0;
const log = (m) => process.stdout.write(m + '\n');
const check = (c, m) => { log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const t00 = Date.now();
const el = () => ((Date.now() - t00) / 1000).toFixed(1) + 's';

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));
let browser;
try {
  browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('pageerror', e => log(`  [${el()}] [pageerror] ` + String(e).slice(0, 300)));
  page.on('crash', () => { log(`  [${el()}] *** RENDERER CRASHED ***`); fails++; });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__lucid && window.SleapIO, null, { timeout: 30000 });

  // The loader ends in an attach-videos modal; skip it (and any missing-files note).
  await page.evaluate(() => {
    setInterval(() => {
      for (const b of Array.from(document.querySelectorAll('button'))) {
        const t = b.textContent.trim();
        if ((t === 'Continue' || t.startsWith('Skip')) && b.offsetParent !== null) b.click();
      }
    }, 250);
    const inp = document.createElement('input');
    inp.type = 'file'; inp.id = '__projPicker'; inp.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(inp);
  });
  await page.setInputFiles('#__projPicker', PROJECT);
  log(`[${el()}] loading ${path.basename(PROJECT)} (${(fs.statSync(PROJECT).size / 1048576).toFixed(0)} MB)`);
  await page.evaluate(() => {
    window.__load = { done: false, err: null };
    import('/loading/session-loader.js').then(sl =>
      sl.handleLoadProjectSlpLazy(document.getElementById('__projPicker').files[0])
        .then(() => { window.__load.done = true; })
        .catch(e => { window.__load.err = String(e && e.stack || e).slice(0, 400); }));
  });
  await page.waitForFunction(() => window.__load.done || window.__load.err, null, { timeout: 900000, polling: 1000 });
  const loaded = await page.evaluate(() => {
    const s = window.__lucid.state.session;
    let groups = 0, frames = 0;
    for (const [, gs] of s.instanceGroups) { frames++; groups += gs.length; }
    return { err: window.__load.err, lazy: !!s.lazyLoader, frames, groups, cameras: s.cameras.length,
      nodes: s.skeleton.nodes.length, tracks: s.tracks.length, identities: s.identities.length,
      usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576) };
  });
  log(`[${el()}] loaded ${JSON.stringify(loaded)}`);
  check(!loaded.err && loaded.lazy, 'project opened lazily');

  // Record the progress card's text as it changes.
  await page.evaluate(() => {
    window.__card = [];
    const st = document.getElementById('loadingStatus');
    const ti = document.getElementById('loadingTitle');
    new MutationObserver(() => {
      const line = (ti.textContent ? ti.textContent + ' | ' : '') + st.textContent;
      if (window.__card[window.__card.length - 1] !== line) window.__card.push(line);
    }).observe(st, { childList: true, characterData: true, subtree: true });
    window.__peak = 0;
    window.__peakTimer = setInterval(() => {
      window.__peak = Math.max(window.__peak, performance.memory.usedJSHeapSize);
    }, 100);
  });
  const t0 = Date.now();
  const dl = page.waitForEvent('download', { timeout: 900000 });
  await page.evaluate(() => document.getElementById('menuExportPoints3dH5').click());
  const done = await Promise.race([
    dl.then(d => ({ d })),
    page.waitForFunction(() => /failed|error/i.test(document.getElementById('statusText').textContent),
      null, { timeout: 900000, polling: 500 }).then(() => ({ d: null })),
  ]);
  const ms = Date.now() - t0;
  const after = await page.evaluate(() => ({ status: document.getElementById('statusText').textContent,
    card: window.__card, usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
    peakMB: (clearInterval(window.__peakTimer), Math.round(window.__peak / 1048576)) }));
  log(`[${el()}] export ${(ms / 1000).toFixed(1)} s, status: ${after.status}, heap ${after.usedMB} MB (peak ${after.peakMB} MB)`);
  log('  card: ' + after.card.slice(0, 4).concat(after.card.length > 6 ? ['…'] : [], after.card.slice(-2)).join('\n        '));
  check(!!done.d, 'export downloaded');
  if (done.d) {
    await done.d.saveAs(OUT);
    log(`  wrote ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
    check(after.card.some(l => /^Export 3D Points \| Writing 3D points: [\d,]+\/[\d,]+ frames/.test(l)), 'progress card counted frames');
    // Compare sampled rows with each group's 3D.
    // Served by the http server (a Playwright route would buffer it in Node).
    const served = path.join(repoRoot, `_real-points3d-${process.pid}.h5`);
    fs.symlinkSync(path.resolve(OUT), served);
    const cmp = await page.evaluate(async (url) => {
      const bin = new Uint8Array(await (await fetch(url)).arrayBuffer());
      window.h5wasm.FS.writeFile('/_real_points3d.h5', bin);
      const h5 = new window.h5wasm.File('/_real_points3d.h5', 'r');
      const s = window.__lucid.state.session;
      const idPos = new Map(s.identities.map((x, i) => [x.id, i]));
      let checked = 0, bad = 0, nanBad = 0, framesWith3d = 0;
      for (const [, gs] of s.instanceGroups) {
        if (gs.some(g => g.points3d && idPos.has(g.identityId))) framesWith3d++;
      }
      try {
        const d = h5.get('points_3d');
        const fidx = h5.get('frame_indices').value;
        const [nF, nT, nN] = d.shape;
        for (let k = 0; k < 400; k++) {
          const fi = Math.floor(k * (nF - 1) / 399);
          const row = d.slice([[fi, fi + 1]]);
          const filled = new Set();
          for (const g of s.instanceGroups.get(fidx[fi]) || []) {
            const t = idPos.get(g.identityId);
            if (t == null || !g.points3d) continue;
            for (let n = 0; n < nN; n++) {
              const b = (t * nN + n) * 3;
              filled.add(b);
              const p = g.points3d.subarray(n * 3, n * 3 + 3);
              if (n * 3 + 2 >= g.points3d.length || p.some(Number.isNaN)) { if (!Number.isNaN(row[b])) nanBad++; continue; }
              checked++;
              if (row[b] !== p[0] || row[b + 1] !== p[1] || row[b + 2] !== p[2]) bad++;
            }
          }
          for (let b = 0; b < nT * nN * 3; b += 3) if (!filled.has(b) && !Number.isNaN(row[b])) nanBad++;
        }
        return { shape: d.shape, errShape: h5.get('reprojection_error').shape, framesWith3d,
          checked, bad, nanBad, tracks: Array.from(h5.get('track_names').value) };
      } finally { h5.close(); window.h5wasm.FS.unlink('/_real_points3d.h5'); }
    }, '/' + path.basename(served)).finally(() => fs.unlinkSync(served));
    log('  ' + JSON.stringify(cmp));
    check(cmp.shape[0] === cmp.framesWith3d && cmp.shape[1] === loaded.identities, 'one row per frame with 3D, one track per identity');
    check(cmp.checked > 0 && cmp.bad === 0 && cmp.nanBad === 0, `400 sampled rows match the groups' 3D (${cmp.checked} nodes)`);
  }
} finally {
  if (browser) await browser.close();
  server.kill();
}
log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
