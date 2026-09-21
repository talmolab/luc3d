// Screenshot helper for the Define Plane UI (investigation tool, not a test).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const repoRoot = '/Users/joshuapark/Documents/talmolab/repos/luc3d/.claude/worktrees/3d-origin-change';
const OUT = process.env.OUT || '/tmp/plane.png';
const PORT = 8197;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

await page.evaluate(async () => {
  const pd = await import('/pose/pose-data.js');
  const AS = await import('/ui/app-state.js');
  const sp = await import('/ui/sessions-panes.js');
  const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
  const cams = ['camA', 'camB'].map((n, i) =>
    new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [640, 480]));
  const s = new pd.Session(cams, new pd.Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], 'S1');
  AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
  AS.state.totalFrames = 10;
  AS.state.views = cams.map(c => ({ name: c.name, videoWidth: 640, videoHeight: 480, canvas: null }));
  AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name }));
  sp.populateViewStrip();
  AS.paneManager.addAllViewsAsGrid();
});
await page.waitForFunction(() => window.__lucid.state.views.every(v => !!v.overlayCanvas));

await page.click('.menu-item[data-menu="view"]');
await page.click('#menuDefinePlanes');
// Entering the mode no longer mints a plane, so make one before the editor
// (and its name field) come alive.
await page.click('#btnNewPlaneSkeleton');
await page.fill('#planeSkeletonName', 'floor');
await page.dispatchEvent('#planeSkeletonName', 'change');
// `+ Node` only mints a POOL node now — putting it in the plane is `+ Add` in
// the Edit Plane section, so the shot has to drive both controls.
for (const n of ['fl', 'fr', 'br', 'bl']) {
  await page.fill('#planeNodeNameInput', n);
  await page.click('#btnAddPlaneNode');
  await page.selectOption('#planeAddNodeSelect', { label: n });
  await page.click('#btnAddExistingPlaneNode');
}
for (const [s, d] of [['fl', 'fr'], ['fr', 'br'], ['br', 'bl'], ['bl', 'fl']]) {
  await page.selectOption('#planeEdgeSrcSelect', { label: s });
  await page.selectOption('#planeEdgeDstSelect', { label: d });
  await page.click('#btnAddPlaneEdge');
}
await page.dragAndDrop('#planeSkeletonsTable tbody tr', '.video-cell[data-view-name="camA"]');
await page.dragAndDrop('#planeSkeletonsTable tbody tr', '.video-cell[data-view-name="camB"]');

// Spread the planes out, fill + triangulate, expand the row, and select one —
// so the shot shows node colours, the nulled (hollow) node, the selection halo,
// the polygon fill, and the triangulation readout.
await page.evaluate(async () => {
  const P = await import('/ui/plane-definition.js');
  const R = await import('/ui/rendering.js');
  const AS = await import('/ui/app-state.js');
  const model = P.planeModel();
  const sk = model.planes[0];
  const poolIdx = sk.nodeIds.map(id => model.pool.indexOf(id));
  const cams = AS.state.session.cameras;
  // A real, slightly non-planar quad in world space, projected into both
  // views — so Triangulate/Fit have genuine correspondences to work with.
  const TRUTH = [[-60, -45, 210], [60, -45, 214], [66, 40, 220], [-66, 40, 226]];
  ['camA', 'camB'].forEach(name => {
    const cam = cams.find(c => c.name === name);
    const inst = P.getPlaneInstance(name);
    TRUTH.map(q => cam.project(q)).forEach((q, k) => inst.setPoint(poolIdx[k], q[0], q[1]));
  });
  const a = P.getPlaneInstance('camA');
  sk.filled = true;
  P.planeState.expanded.add(sk.id);
  AS.interactionManager.selectPlane(a, -1);
  P.refreshPlanePanel();
  R.drawAllOverlays(AS.state.currentFrame);
});

// Drive the real buttons so the shot shows what a user would get.
await page.click('#btnPlaneTriangulate');
await page.click('#btnPlaneFit');
await page.evaluate(async () => {
  const AS = await import('/ui/app-state.js');
  if (AS.viewport3d) AS.viewport3d.fitToScene();
});
// Collapse the editor so the shot frames the Plane Skeletons table, its
// expanded placements, and the appearance sliders.
await page.evaluate(() => {
  document.getElementById('planeEditorDetails').open = false;
  document.getElementById('planePanel').scrollTop = 0;
});
await new Promise(r => setTimeout(r, 400));
await page.screenshot({ path: OUT });
console.log('wrote', OUT);
await browser.close();
server.kill();
