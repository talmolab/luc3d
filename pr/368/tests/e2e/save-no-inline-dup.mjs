/**
 * save-no-inline-dup.mjs — regression guard for the "Save failed: invalid
 * string length" / "large project silently loses 3D on reload" bug family
 * (issues #134, #156, #158, #161).
 *
 * ORIGINAL ROOT CAUSE: sleap-io serialized the entire per-session grouping —
 * including every grouped instance's inline 2D pose AND all triangulated 3D
 * points — into ONE `sessions_json` JSON string, which blew past V8's max string
 * length on write and, worse, past h5wasm's ~0.45 GB vlen-string READ ceiling
 * (returning 0 sessions → silent loss of calibration/3D/IDs on reload).
 *
 * FIX (SLP 2.8, sleap-io.js #224 porting Python sleap-io #546): 3D points +
 * frame-group/instance-group grouping move OUT of `sessions_json` into a columnar
 * `/session_data` HDF5 group; `sessions_json` stays slim (calibration + video map
 * + session metadata + a frame-group range). No inline duplication is even
 * possible anymore.
 *
 * This test builds a grouped, triangulated, partly-occluded multi-frame session,
 * saves via the real path, and asserts (a) `sessions_json` carries NO inline
 * `frame_group_dicts` (all grouping is columnar), (b) every group's 3D points +
 * per-camera members still round-trip via `readSlpStreaming`, and (c)
 * `sessions_json` stays tiny (no per-frame numeric payload inline).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8087);
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
    const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
    const mtx = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
    const cams = ['cam1', 'cam2', 'cam3'].map((n, i) => new Camera(n, mtx, [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [512, 512]));
    const NODES = 8, NFRAMES = 40;
    const skel = new Skeleton('skeleton', Array.from({ length: NODES }, (_, i) => 'n' + i), Array.from({ length: NODES - 1 }, (_, i) => [i, i + 1]));
    const s = new Session(cams, skel, ['t0', 't1'], 'RT');
    const idA = s.addIdentity('A'), idB = s.addIdentity('B');
    for (let f = 0; f < NFRAMES; f++) {
      const fg = new FrameGroup(f); s.addFrameGroup(fg);
      const groups = [];
      for (let gi = 0; gi < 2; gi++) {
        const id = gi === 0 ? idA : idB;
        const g = new InstanceGroup(f * 10 + gi, id.id);
        for (const c of cams) {
          const pts = Array.from({ length: NODES }, (_, k) => [100 + k + f * 0.01, 200 + k]);
          const inst = new Instance(pts, gi, 'user', 1);
          if (gi === 0) inst.nulledNodes = new Set([2]); // an occluded node
          g.addInstance(c.name, inst); fg.addInstance(c.name, inst);
        }
        g.points3d = Array.from({ length: NODES }, (_, k) => [k + f * 0.001, k * 2, k * 3 + 50]);
        groups.push(g);
      }
      s.instanceGroups.set(f, groups);
    }
    const views = cams.map(c => ({ name: c.name, videoWidth: 512, videoHeight: 512, frameCount: NFRAMES }));
    const vf = cams.map(c => ({ name: c.name, assignedCamera: c.name, videoPath: c.name + '.mp4' }));
    const labels = fileio.buildSlpLabelsAllViews(s, views, vf);
    const bytes = await window.SleapIO.saveSlpToBytes(labels);
    const file = new File([bytes], 'x.slp');
    const re = await window.SleapIO.readSlpStreaming(file, { openVideos: false, rawSessions: true, h5wasmUrl: new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href });

    const raw = re.rawSessionsJson[0];
    // SLP 2.8 (#546/#224): 3D grouping moved OUT of the inline `frame_group_dicts`
    // (the single per-session JSON string that overflowed V8's max length) into a
    // columnar `/session_data` group. sessions_json must carry NO frame_group_dicts.
    const hasInlineFgd = Array.isArray(raw.frame_group_dicts) && raw.frame_group_dicts.length > 0;
    // Typed round-trip: every group's 3D points + per-camera members come back
    // from the columnar /session_data datasets.
    const sess = (re.sessions || [])[0];
    let groupCount = 0, allHave3d = true, allHaveMembers = true;
    if (sess && sess.frameGroups) {
      for (const [, fg] of sess.frameGroups) {
        for (const ig of (fg.instanceGroups || [])) {
          groupCount++;
          if (!(ig.instance3d && ig.instance3d.points && ig.instance3d.points.length > 0)) allHave3d = false;
          if (!(ig.instanceByCamera && ig.instanceByCamera.size > 0)) allHaveMembers = false;
        }
      }
    }
    // Labeled frames still carry the 2D instances (unchanged).
    const totalInst = (re.labeledFrames || []).reduce((a, f) => a + (f.instances || []).length, 0);
    const sessJsonLen = JSON.stringify(raw).length;
    return { NODES, NFRAMES, groupCount, hasInlineFgd, allHave3d, allHaveMembers, totalInst, sessJsonLen, bytes: bytes.length };
  });

  console.log('  measured:', JSON.stringify(r));
  check(r.groupCount === r.NFRAMES * 2, `all ${r.NFRAMES * 2} groups round-trip from /session_data (got ${r.groupCount})`);
  check(r.hasInlineFgd === false, 'sessions_json carries NO inline frame_group_dicts (SLP 2.8 columnar /session_data)');
  check(r.allHave3d === true, 'every group keeps its 3D points (columnar points_3d)');
  check(r.allHaveMembers === true, 'every group keeps its per-camera members (columnar refs)');
  check(r.totalInst === r.NFRAMES * 2 * 3, `all 2D instances present in labeled frames (got ${r.totalInst})`);
  // sessions_json stays tiny — no per-frame 2D/3D numeric payload lives in the JSON
  // string anymore (with inline, 80 groups × 3 cams × 8 nodes would bloat it).
  check(r.sessJsonLen < 50000, `sessions_json is small (${r.sessJsonLen} bytes) — no per-frame numeric payload inline`);

  await browser.close();
} finally {
  server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
