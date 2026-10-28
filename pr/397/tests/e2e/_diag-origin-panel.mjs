// Screenshots + overflow measurements of the DEFINED ORIGIN readout in the
// Define Plane panel (investigation tool, not a test). WIDE=1 restages it with
// six-figure mm coordinates. Sibling of _diag-origin-shot.mjs, which shoots the
// wizard steps instead.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const PORT = 8253;
const repoRoot = '/Users/joshuapark/Documents/repos/luc3d/.claude/worktrees/3d-origin-change';
const OUT = process.env.OUT || '/tmp/origin.png';
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

  await page.evaluate(async () => {
    const pd = await import('/pose/pose-data.js');
    const AS = await import('/ui/app-state.js');
    const sp = await import('/ui/sessions-panes.js');
    const { Camera, Session, Skeleton } = pd;
    const K = [[600,0,320],[0,600,240],[0,0,1]];
    const cams = ['camA','camB'].map((n,i) => new Camera(n,K,[0,0,0,0,0],[0,0.2*i,0],[20*i,0,0],[640,480]));
    const session = new Session(cams, new Skeleton('sk',['a','b'],[[0,1]]), ['track_0'], 'S1');
    AS.state.sessions=[session]; AS.state.activeSessionIdx=0; AS.state.session=session;
    AS.state.totalFrames=10;
    AS.state.views = cams.map(c => ({ name:c.name, videoWidth:640, videoHeight:480, canvas:null }));
    AS.state.videoFiles = cams.map(c => ({ name:c.name, assignedCamera:c.name }));
    sp.populateViewStrip(); AS.paneManager.addAllViewsAsGrid();
  });
  await page.waitForFunction(() => window.__lucid.state.views.every(v => !!v.overlayCanvas), { timeout: 10000 });

  await page.evaluate(async () => {
    const P = await import('/ui/plane-definition.js');
    const T = await import('/pose/triangulation.js');
    const AS = await import('/ui/app-state.js');
    const model = P.planeModel(); const cams = AS.state.session.cameras;
    // A tilted floor, so the rotation is non-trivial and the numbers are wide.
    const TF=[[-40.678,-30.234,1216.588],[40,-30,1220],[40,30,1225],[-40,30,1221]];
    const floor = P.createPlane('Ground');
    ['corner one','h1','f2','f3'].forEach(n => model.createNodeInPlane(n, floor));
    for (let k=0;k<4;k++) floor.addEdge(floor.nodeIds[k], floor.nodeIds[(k+1)%4]);
    const setPts = (plane, view, pts) => {
      const inst = P.getPlaneInstance(view);
      const idx = plane.nodeIds.map(id => model.pool.indexOf(id));
      pts.forEach((q,k) => inst.setPoint(idx[k], q[0], q[1]));
    };
    for (const cam of cams) { P.placePlaneOnView(floor, cam.name, 320, 240); setPts(floor, cam.name, TF.map(q=>cam.project(q))); }
    P.planeState.selectedPlaneId = floor.id; P.refreshPlanePanel();
    document.getElementById('btnPlaneTriangulate').click();
    const fit = T.fitPlaneToPoints3d(P.planePoints3d(floor));
    floor.planeFit = { centroid: fit.centroid, normal: fit.normal, rms: fit.rms, nPoints: fit.nPoints };
    floor.filled = true;
    P.enterPlaneMode();
    P.refreshPlanePanel(); P.syncPlanes3D();
    window.__floorId = floor.id;
  });
  await page.waitForTimeout(400);

  const m = await page.evaluate(async () => {
    const O = await import('/ui/origin-definition.js');
    O.enterOriginMode();
    O.pickOriginNode(window.__floorId, 0);
    O.pickOriginAxis('negative');
    document.getElementById('btnOriginContinue').click();
    const host = document.getElementById('originResult');
    const sec = document.getElementById('originResultSection');
    const panel = document.querySelector('.plane-panel');
    return {
      resultScrollW: host.scrollWidth, resultClientW: host.clientWidth,
      secScrollW: sec.scrollWidth, secClientW: sec.clientWidth,
      panelScrollW: panel ? panel.scrollWidth : null,
      panelClientW: panel ? panel.clientWidth : null,
      // The widest thing inside the readout, vs. the box it has to live in.
      widest: (function () {
        var r = host.getBoundingClientRect(); var worst = 0; var who = '';
        host.querySelectorAll('*').forEach(function (el) {
          var b = el.getBoundingClientRect();
          if (b.right - r.left > worst) { worst = b.right - r.left; who = el.className || el.tagName; }
        });
        return { px: Math.round(worst), who: who, box: Math.round(r.width) };
      })(),
      text: host.textContent,
    };
  });
  console.log(JSON.stringify(m, null, 1));
  // WIDE=1 restages the readout with the coordinates a room-sized, mm-calibrated
  // project actually carries — the case the old five-column table clipped.
  if (process.env.WIDE) {
    console.log(JSON.stringify(await page.evaluate(async () => {
      const O = await import('/ui/origin-definition.js');
      const f = O.originState.frame;
      f.origin = [-12345.678, -98765.432, 123456.789];
      f.translation = [-12345.678, -98765.432, 123456.789];
      f.sourceNode = 'north-west bench corner';
      O.renderOriginResult();
      const host = document.getElementById('originResult');
      const panel = document.querySelector('.plane-panel');
      return { wideScrollW: host.scrollWidth, wideClientW: host.clientWidth,
               widePanelScrollW: panel.scrollWidth, widePanelClientW: panel.clientWidth };
    })));
  }
  await page.evaluate(() => document.getElementById('originResultSection').scrollIntoView());
  await page.waitForTimeout(300);
  const el = await page.$('#originResultSection');
  const box = await el.boundingBox();
  await page.screenshot({ path: OUT, clip: { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 } });
  console.log('saved', OUT);

  // The Danger Zone is a separate block below the readout, and it ships
  // COLLAPSED — open it and shoot it on its own, or the panel's own scroll
  // clips it out of the readout's frame.
  await page.evaluate(() => {
    const dd = document.getElementById('originDangerDetails');
    if (dd) dd.open = true;
    const sec = document.getElementById('originDangerSection');
    if (sec) sec.scrollIntoView({ block: 'end' });
  });
  await page.waitForTimeout(300);
  const dEl = await page.$('#originDangerSection');
  if (dEl) {
    const dBox = await dEl.boundingBox();
    const dOut = OUT.replace(/\.png$/, '') + '-danger.png';
    await page.screenshot({ path: dOut, clip: { x: dBox.x - 4, y: dBox.y - 4, width: dBox.width + 8, height: dBox.height + 8 } });
    console.log('saved', dOut);
  }
} finally { await browser.close(); server.kill(); }
