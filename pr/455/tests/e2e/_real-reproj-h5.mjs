/**
 * _real-reproj-h5.mjs — File ▸ Export Reprojections (H5) on a real project,
 * opened lazily the way File ▸ Load Project opens a large one.
 *
 * Not a test (needs a real project). Usage:
 *     PROJECT=/path/to/<recording>_luc3d_tailmarks.slp OUT=/path/to/reprojections.h5 \
 *         node tests/e2e/_real-reproj-h5.mjs [port]
 *
 * Reports load and export times, the progress card's lines as they change,
 * the heap, and compares sampled frames with `reprojectPointsCamera` of each
 * group's 3D. Check the written file with h5py afterwards.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.argv[2] || 8342);
const PROJECT = process.env.PROJECT;
const OUT = process.env.OUT || path.join(repoRoot, '_real-reprojections.h5');
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
  });
  const t0 = Date.now();
  const dl = page.waitForEvent('download', { timeout: 900000 });
  await page.evaluate(() => document.getElementById('menuExportReprojH5').click());
  const done = await Promise.race([
    dl.then(d => ({ d })),
    page.waitForFunction(() => /failed|error/i.test(document.getElementById('statusText').textContent),
      null, { timeout: 900000, polling: 500 }).then(() => ({ d: null })),
  ]);
  const ms = Date.now() - t0;
  const after = await page.evaluate(() => ({ status: document.getElementById('statusText').textContent,
    card: window.__card, usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576) }));
  log(`[${el()}] export ${(ms / 1000).toFixed(1)} s, status: ${after.status}, heap ${after.usedMB} MB`);
  log('  card: ' + after.card.slice(0, 4).concat(after.card.length > 6 ? ['…'] : [], after.card.slice(-2)).join('\n        '));
  check(!!done.d, 'export downloaded');
  if (done.d) {
    await done.d.saveAs(OUT);
    log(`  wrote ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
    check(after.card.some(l => /^Export Reprojections \| Writing reprojections: [\d,]+\/[\d,]+ frames/.test(l)), 'progress card counted frames');
    // Compare sampled frames with an independent reprojection.
    // Served by the http server (a Playwright route would buffer it in Node).
    const served = path.join(repoRoot, `_real-reproj-${process.pid}.h5`);
    fs.symlinkSync(path.resolve(OUT), served);
    const cmp = await page.evaluate(async (url) => {
      const TC = await import('/pose/triangulation-core.js');
      const bin = new Uint8Array(await (await fetch(url)).arrayBuffer());
      window.h5wasm.FS.writeFile('/_real_reproj.h5', bin);
      const h5 = new window.h5wasm.File('/_real_reproj.h5', 'r');
      const s = window.__lucid.state.session;
      const idPos = new Map(s.identities.map((x, i) => [x.id, i]));
      let checked = 0, bad = 0, nanBad = 0;
      try {
        const d = h5.get('reprojections');
        const fidx = h5.get('frame_indices').value;
        const [nF, , nC, nN] = d.shape;
        for (let k = 0; k < 400; k++) {
          const fi = Math.floor(k * (nF - 1) / 399);
          const row = d.slice([[fi, fi + 1]]);
          for (const g of s.instanceGroups.get(fidx[fi]) || []) {
            const t = idPos.get(g.identityId);
            if (t == null) continue;
            for (let c = 0; c < nC; c++) {
              const exp = g.reprojections ? g.reprojections[s.cameras[c].name]
                : TC.reprojectPointsCamera(g.points3d, s.cameras[c]);
              for (let n = 0; n < nN; n++) {
                const b = ((t * nC + c) * nN + n) * 2;
                if (!exp || !exp[n]) { if (!Number.isNaN(row[b])) nanBad++; continue; }
                checked++;
                if (row[b] !== exp[n][0] || row[b + 1] !== exp[n][1]) bad++;
              }
            }
          }
        }
        return { shape: d.shape, checked, bad, nanBad, tracks: Array.from(h5.get('track_names').value) };
      } finally { h5.close(); window.h5wasm.FS.unlink('/_real_reproj.h5'); }
    }, '/' + path.basename(served)).finally(() => fs.unlinkSync(served));
    log('  ' + JSON.stringify(cmp));
    check(cmp.shape[0] === loaded.frames && cmp.shape[1] === loaded.identities, 'one row per frame with groups, one track per identity');
    check(cmp.checked > 0 && cmp.bad === 0 && cmp.nanBad === 0, `400 sampled frames match the app's reprojections (${cmp.checked} points)`);
  }
} finally {
  if (browser) await browser.close();
  server.kill();
}
log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
