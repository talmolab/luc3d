/**
 * lazy-embedded-calibration.mjs — regression guard for calibration loss on the
 * lazy/session-folder load path (#134 / eric/fix-save).
 *
 * A LUCID project `.slp` carries its calibration inside `sessions_json`, but the
 * session-folder loader previously read calibration ONLY from a separate
 * `calibration.toml` — so reopening a saved project with no `.toml` fell back to
 * placeholder identity cameras and silently lost the calibration. `SioLazyLoader`
 * now captures the embedded calibration; the folder loader builds real cameras
 * from it. This test drives the loader on a saved calibrated `.slp` and asserts
 * the calibration (intrinsics + extrinsics + distortion) is recovered intact.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8082);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 200)); fails++; });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

  const r = await page.evaluate(async () => {
    const pd = await import('/pose/pose-data.js');
    const fileio = await import('/import-export/file-io.js');
    const lazyMod = await import('/loading/sio-lazy-loader.js');
    const SioLazyLoader = lazyMod.SioLazyLoader || lazyMod.default;
    const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
    const K = [[1234.5, 0, 640.25], [0, 1234.5, 360.75], [0, 0, 1]];
    const cams = [
      new Camera('side', K, [0.11, -0.22, 0.001, 0.002, 0.05], [0.1, 0.2, 0.3], [10.5, -3.2, 1.0], [1280, 720]),
      new Camera('top', K, [0.09, -0.18, 0.003, 0.004, 0.04], [0.4, 0.5, 0.6], [-8.1, 2.4, 0.7], [1280, 720]),
    ];
    const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
    const s = new Session(cams, skel, ['t0'], 'CalTest');
    const fg = new FrameGroup(0); s.addFrameGroup(fg);
    const g = new InstanceGroup(1, -1);
    for (const c of cams) { const inst = new Instance([[1, 2], [3, 4]], 0, 'user', 1); g.addInstance(c.name, inst); fg.addInstance(c.name, inst); }
    g.points3d = [[1, 2, 3], [4, 5, 6]]; s.instanceGroups.set(0, [g]);
    const views = cams.map(c => ({ name: c.name, videoWidth: 1280, videoHeight: 720, frameCount: 5 }));
    const vf = cams.map(c => ({ name: c.name, assignedCamera: c.name, videoPath: c.name + '.mp4' }));
    const bytes = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(s, views, vf));
    const file = new File([bytes], 'proj.slp');

    const loader = new SioLazyLoader();
    await loader.open('side', file, () => {});
    const cal = loader.calibration;

    // Build cameras the way the session-folder loader now does.
    let builtSide = null;
    if (cal) {
      for (const key of Object.keys(cal).filter(k => k !== 'metadata')) {
        const cd = cal[key];
        if ((cd.name || key) === 'side') {
          builtSide = new Camera(cd.name || key, cd.matrix, cd.distortions || cd.dist, cd.rotation || cd.rvec, cd.translation || cd.tvec, cd.size);
        }
      }
    }
    return {
      captured: !!cal,
      keys: cal ? Object.keys(cal).filter(k => k !== 'metadata') : null,
      built: builtSide ? {
        matrix00: builtSide.matrix[0][0],
        rvec: builtSide.rvec,
        tvec: builtSide.tvec,
        dist0: builtSide.dist[0],
        isIdentity: builtSide.matrix[0][0] === 1 && builtSide.matrix[1][1] === 1,
      } : null,
    };
  });

  console.log('  measured:', JSON.stringify(r));
  check(r.captured === true, 'SioLazyLoader captured the embedded calibration');
  check(Array.isArray(r.keys) && r.keys.length === 2, `both cameras present (got ${JSON.stringify(r.keys)})`);
  check(!!r.built, 'a real Camera was built from the embedded calibration');
  if (r.built) {
    check(r.built.isIdentity === false, 'built camera is NOT a placeholder identity matrix');
    check(Math.abs(r.built.matrix00 - 1234.5) < 0.01, `intrinsics preserved (fx=${r.built.matrix00})`);
    check(JSON.stringify(r.built.rvec) === JSON.stringify([0.1, 0.2, 0.3]), `extrinsic rvec preserved (${JSON.stringify(r.built.rvec)})`);
    check(JSON.stringify(r.built.tvec) === JSON.stringify([10.5, -3.2, 1.0]), `extrinsic tvec preserved (${JSON.stringify(r.built.tvec)})`);
    check(Math.abs(r.built.dist0 - 0.11) < 0.001, `distortion preserved (k1=${r.built.dist0})`);
  }

  await browser.close();
} finally {
  server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
