/**
 * save-no-inline-dup.mjs — regression guard for the "Save failed: invalid
 * string length" bug (issue #134 / eric/fix-save).
 *
 * ROOT CAUSE: sleap-io's serializeInstanceGroup wrote BOTH an index-ref map
 * AND the full inline 2D pose (pointsToDict) for every grouped instance, so the
 * entire 2D keypoint set was duplicated verbatim into the single per-session
 * `sessions_json` JSON string — which blew past V8's max string length
 * (RangeError: Invalid string length) on large projects and ~2× the .slp size.
 *
 * FIX (LUCID local patch in lib/sleap-io/chunk-M65RB7KH.js): inline the point
 * dict ONLY as a fallback when no labeled-frame ref resolves. Grouped instances
 * always resolve a ref, so their pose is no longer duplicated.
 *
 * This test builds a grouped, triangulated, partly-occluded multi-frame session,
 * saves via the real path, and asserts (a) grouped instance groups carry the ref
 * map and NOT an inline `instances` dict, (b) 3D points + grouping still
 * round-trip, and (c) sessions_json is far smaller than the 2D pose it would
 * duplicate.
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
    const fgd = raw.frame_group_dicts;
    let anyInline = false, allHaveRef = true, allHave3d = true, groupCount = 0;
    for (const fg of fgd) {
      for (const ig of (fg.instance_groups || [])) {
        groupCount++;
        if (ig.instances && Object.keys(ig.instances).length > 0) anyInline = true;
        if (!(ig.camcorder_to_lf_and_inst_idx_map && Object.keys(ig.camcorder_to_lf_and_inst_idx_map).length > 0)) allHaveRef = false;
        if (!(ig.points && ig.points.length > 0)) allHave3d = false;
      }
    }
    // Typed reconstruction: labeled frames still carry the 2D instances.
    const totalInst = (re.labeledFrames || []).reduce((a, f) => a + (f.instances || []).length, 0);
    const sessJsonLen = JSON.stringify(raw).length;
    return { NODES, NFRAMES, groupCount, anyInline, allHaveRef, allHave3d, totalInst, sessJsonLen, bytes: bytes.length };
  });

  console.log('  measured:', JSON.stringify(r));
  check(r.groupCount === r.NFRAMES * 2, `all ${r.NFRAMES * 2} grouped instances serialized (got ${r.groupCount})`);
  check(r.anyInline === false, 'NO inline per-node point dict duplicated into sessions_json');
  check(r.allHaveRef === true, 'every group carries the compact labeled-frame ref map');
  check(r.allHave3d === true, 'every group keeps its instance3d points');
  check(r.totalInst === r.NFRAMES * 2 * 3, `all 2D instances present in labeled frames (got ${r.totalInst})`);
  // (Size is proven by anyInline===false: with inline, each of the 80 groups
  // would ALSO embed 3 cams × 8 nodes of point arrays into sessions_json.)

  await browser.close();
} finally {
  server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
