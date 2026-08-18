// Screenshot: a quad plus an INTERIOR node, filled (investigation tool, not a
// test). Shows the two fill outlines side by side:
//   MODE=hull  no edges  -> the fill hulls the outer four, covering the middle
//   MODE=ring  5 edges   -> the user's ring, which deliberately notches in to it
// OUT=/path/shot.png MODE=hull node tests/e2e/_diag-fill-hull.mjs
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const repoRoot = '/Users/joshuapark/Documents/talmolab/repos/luc3d/.claude/worktrees/3d-origin-change';
const OUT = process.env.OUT;
const PORT = 8203;
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
  const cams = ['camA'].map((n, i) =>
    new pd.Camera(n, K, [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]));
  const s = new pd.Session(cams, new pd.Skeleton('sk', ['a','b'], [[0,1]]), ['track_0'], 'S1');
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
await page.evaluate(async (mode) => {
  const P = await import('/ui/plane-definition.js');
  const R = await import('/ui/rendering.js');
  const AS = await import('/ui/app-state.js');
  const m = P.planeModel();
  const sk = P.createPlane(); sk.name = 'floor';
  const XY = [[120,140],[520,180],[470,420],[150,400],[300,280]];
  ['A','B','C','D','Ground'].forEach(n => m.createNodeInPlane(n, sk));
  P.placePlaneOnView(sk, 'camA', 320, 240);
  const inst = P.getPlaneInstance('camA');
  sk.nodeIds.forEach((id, i) => inst.setPoint(m.pool.indexOf(id), XY[i][0], XY[i][1]));
  if (mode === 'ring') {
    for (let k = 0; k < 5; k++) sk.addEdge(sk.nodeIds[k], sk.nodeIds[(k + 1) % 5]);
  }
  sk.filled = true;
  P.refreshPlanePanel();
  R.drawAllOverlays(AS.state.currentFrame);
}, process.env.MODE || 'hull');
await new Promise(r => setTimeout(r, 400));
await page.locator('.video-cell[data-view-name="camA"]').screenshot({ path: OUT });
console.log('wrote', OUT);
await browser.close();
server.kill();
