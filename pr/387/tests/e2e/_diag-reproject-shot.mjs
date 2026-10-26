// Screenshot: Triangulate reprojecting a plane into the view it was not placed
// on (investigation tool, not a test). camA/camB are hand-annotated (solid
// corners); camC gets ghosted, dashed corners written by the reprojection pass.
// OUT=/path/shot.png node tests/e2e/_diag-reproject-shot.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const repoRoot = '/Users/joshuapark/Documents/talmolab/repos/luc3d/.claude/worktrees/3d-origin-change';
const OUT = process.env.OUT || '/tmp/reproject.png';
const PORT = 8206;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
await page.evaluate(async () => {
  const pd = await import('/pose/pose-data.js');
  const AS = await import('/ui/app-state.js');
  const sp = await import('/ui/sessions-panes.js');
  const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
  const spec = [['camA', [0, 0, 0], [0, 0, 0]], ['camB', [0, 0.35, 0], [-60, 0, 0]],
                ['camC', [0, -0.35, 0], [60, 0, 0]]];
  const cams = spec.map(([n, r, t]) => new pd.Camera(n, K, [0, 0, 0, 0, 0], r, t, [640, 480]));
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
await page.evaluate(async () => {
  const P = await import('/ui/plane-definition.js');
  const T = await import('/pose/triangulation.js');
  const AS = await import('/ui/app-state.js');
  const R = await import('/ui/rendering.js');
  const model = P.planeModel();
  const plane = P.createPlane(); plane.name = 'floor';
  ['fl', 'fr', 'br', 'bl'].forEach(n => model.createNodeInPlane(n, plane));
  for (let k = 0; k < 4; k++) plane.addEdge(plane.nodeIds[k], plane.nodeIds[(k + 1) % 4]);
  const idx = plane.nodeIds.map(id => model.pool.indexOf(id));
  const TRUTH = [[-60, -45, 210], [60, -45, 214], [66, 40, 220], [-66, 40, 226]];
  ['camA', 'camB'].forEach(name => {
    P.placePlaneOnView(plane, name, 320, 240);
    const inst = P.getPlaneInstance(name);
    const cam = AS.state.session.cameras.find(c => c.name === name);
    TRUTH.map(q => T.reprojectPointCamera(q, cam))
      .forEach((q, k) => inst.setPoint(idx[k], q[0], q[1]));
  });
  plane.filled = true;
  P.refreshPlanePanel();
  R.drawAllOverlays(AS.state.currentFrame);
});
await page.click('#btnPlaneTriangulate');
await new Promise(r => setTimeout(r, 500));
if (process.env.CELL) {
  await page.locator(`.video-cell[data-view-name="${process.env.CELL}"]`).screenshot({ path: OUT });
} else {
  await page.screenshot({ path: OUT });
}
console.log('wrote', OUT);
await browser.close();
server.kill();
