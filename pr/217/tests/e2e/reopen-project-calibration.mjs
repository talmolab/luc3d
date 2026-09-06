/**
 * reopen-project-calibration.mjs — regression test for calibration lost when a
 * saved project `.slp` is reopened as a single-`.slp` session folder WITHOUT a
 * `calibration.toml` (#134 / eric/fix-save).
 *
 * A LUCID project `.slp` embeds its calibration in `sessions_json`. Saving a
 * session as a project produces one `.slp` and no `.toml`; reopening that folder
 * routes through `handleLoadSessionFolderSingleSlp`, which previously read
 * calibration ONLY from a `.toml` → the reopened session got no cameras and lost
 * calibration + 3D. This builds a calibrated project, saves it to a fixture
 * folder that contains the `.slp` + videos but NO `.toml`, reopens it through the
 * real loader, and asserts the cameras come back with their real (non-identity)
 * intrinsics + extrinsics.
 *
 * Run from repo root with the app served (see occlusion-roundtrip.mjs). BASE
 * overridable.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const BASE = process.env.BASE || 'http://localhost:8080';

const CAM_ORDER = ['side', 'back', 'mid'];
// Distinct, non-identity calibration per camera so we can prove it round-trips.
const MATRIX = [[1000.0, 0.0, 255.5], [0.0, 1000.0, 255.5], [0.0, 0.0, 1.0]];
const RVECS = [[0.10, 0.20, 0.30], [0.01, -0.02, 0.03], [-0.15, 0.05, 0.25]];
const TVECS = [[10.5, -3.2, 1.0], [-8.1, 2.4, 0.7], [4.4, 5.5, -6.6]];
const DISTS = [[-0.11, 0.02, 0, 0, 0], [-0.09, 0.01, 0, 0, 0], [-0.20, 0.03, 0, 0, 0]];

let failures = 0;
function check(cond, msg) { console.log((cond ? '    ✓ ' : '    ✗ ') + msg); if (!cond) failures++; }

async function buildCalibratedSlpBytes(page) {
  const arr = await page.evaluate(async ({ cams, matrix, rvecs, tvecs, dists }) => {
    const [pd, fileio] = await Promise.all([
      import('/pose/pose-data.js'), import('/import-export/file-io.js'),
    ]);
    const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
    const cameras = cams.map((n, i) => new Camera(n, matrix, dists[i], rvecs[i], tvecs[i], [512, 512]));
    const skeleton = new Skeleton('skeleton', ['nose', 'neck', 'tail'], [[0, 1], [1, 2]]);
    const session = new Session(cameras, skeleton, ['track_0'], 'CalReopen');
    const fg = new FrameGroup(0); session.addFrameGroup(fg);
    const group = new InstanceGroup(1, -1);
    cams.forEach((cn) => {
      const inst = new Instance([[100, 200], [300, 400], [500, 600]], 0, 'user', 1);
      fg.addInstance(cn, inst); group.addInstance(cn, inst);
    });
    group.points3d = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    session.instanceGroups.set(0, [group]);
    const views = cams.map((n) => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: 100 }));
    const videoFiles = cams.map((n) => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
    const labels = fileio.buildSlpLabelsAllViews(session, views, videoFiles);
    const bytes = await window.SleapIO.saveSlpToBytes(labels);
    return Array.from(bytes);
  }, { cams: CAM_ORDER, matrix: MATRIX, rvecs: RVECS, tvecs: TVECS, dists: DISTS });
  return Buffer.from(arr);
}

// Fixture folder with the project.slp + videos but deliberately NO calibration.toml.
function writeFixtureNoToml(slpBytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-calib-'));
  const fixture = path.join(root, 'reopen_session');
  fs.mkdirSync(path.join(fixture, 'videos'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'project.slp'), slpBytes);
  for (const cam of CAM_ORDER) {
    fs.copyFileSync(path.join(REPO, 'sample_session', cam + '.mp4'),
      path.join(fixture, 'videos', cam + '.mp4'));
  }
  return { root, fixture };
}

async function reopenAndInspect(page, fixture) {
  page.once('filechooser', async (fc) => { await fc.setFiles(fixture); });
  await page.evaluate(async () => {
    const m = await import('/loading/session-loader.js');
    await m.handleLoadSessionFolderSingleSlp();
  });
  await page.waitForFunction(() => {
    const s = window.__lucid.state;
    return s.session && s.session.cameras && s.session.cameras.length >= 3;
  }, null, { timeout: 40000 }).catch(() => {});
  return await page.evaluate(() => {
    const s = window.__lucid.state;
    const sess = s.session;
    return (sess && sess.cameras ? sess.cameras : []).map((c) => ({
      name: c.name, matrix00: c.matrix ? c.matrix[0][0] : null,
      rvec: c.rvec, tvec: c.tvec,
      identity: c.matrix && c.matrix[0][0] === 1 && c.matrix[1][1] === 1,
    }));
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let tmpRoot = null;
  try {
    page.on('pageerror', (e) => { console.log('    [pageerror] ' + e.message); failures++; });
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 20000 });
    await page.waitForTimeout(400);

    console.log('  Build calibrated project → save .slp → reopen folder (NO calibration.toml)');
    const slpBytes = await buildCalibratedSlpBytes(page);
    check(slpBytes.length > 0, `saved a non-empty project .slp (${slpBytes.length} bytes)`);

    const { root, fixture } = writeFixtureNoToml(slpBytes);
    tmpRoot = root;
    const cams = await reopenAndInspect(page, fixture);
    console.log('    cameras:', JSON.stringify(cams));

    check(cams.length === 3, `all 3 cameras restored (got ${cams.length})`);
    check(cams.every((c) => !c.identity), 'no camera is a placeholder identity matrix');
    // Verify each camera's extrinsics match what we saved (by name).
    for (let i = 0; i < CAM_ORDER.length; i++) {
      const c = cams.find((x) => x.name === CAM_ORDER[i]);
      check(!!c && Math.abs(c.matrix00 - 1000.0) < 0.01, `${CAM_ORDER[i]}: intrinsics recovered`);
      check(!!c && JSON.stringify(c.rvec) === JSON.stringify(RVECS[i]), `${CAM_ORDER[i]}: rvec recovered (${c && JSON.stringify(c.rvec)})`);
      check(!!c && JSON.stringify(c.tvec) === JSON.stringify(TVECS[i]), `${CAM_ORDER[i]}: tvec recovered (${c && JSON.stringify(c.tvec)})`);
    }
  } finally {
    await page.close();
    await browser.close();
    if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

await main();
console.log(failures === 0
  ? '\nPASS: calibration survives save → reopen (single-.slp folder, no calibration.toml).'
  : `\nFAIL: ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
