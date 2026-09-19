import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const PORT = 8251;
const repoRoot = '/Users/joshuapark/Documents/repos/luc3d/.claude/worktrees/3d-origin-change';
const OUT = process.env.OUT;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
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

  // Build floor + wall at 60 deg, sharing the hinge edge.
  await page.evaluate(async () => {
    const P = await import('/ui/plane-definition.js');
    const T = await import('/pose/triangulation.js');
    const AS = await import('/ui/app-state.js');
    const model = P.planeModel(); const cams = AS.state.session.cameras;
    const B = 60*Math.PI/180, OFF=[0,60*Math.cos(B),60*Math.sin(B)];
    const H0=[-40,-30,220], H1=[40,-30,220];
    const TF=[H0,H1,[40,30,220],[-40,30,220]];
    const TW=[H0,H1,[H1[0]+OFF[0],H1[1]+OFF[1],H1[2]+OFF[2]],[H0[0]+OFF[0],H0[1]+OFF[1],H0[2]+OFF[2]]];
    const floor = P.createPlane('Ground');
    ['h0','h1','f2','f3'].forEach(n => model.createNodeInPlane(n, floor));
    for (let k=0;k<4;k++) floor.addEdge(floor.nodeIds[k], floor.nodeIds[(k+1)%4]);
    const wall = P.createPlane('right wall');
    model.addNodeToPlane(wall, floor.nodeIds[0]); model.addNodeToPlane(wall, floor.nodeIds[1]);
    ['w2','w3'].forEach(n => model.createNodeInPlane(n, wall));
    for (let k=0;k<4;k++) wall.addEdge(wall.nodeIds[k], wall.nodeIds[(k+1)%4]);
    const setPts = (plane, view, pts) => {
      const inst = P.getPlaneInstance(view);
      const idx = plane.nodeIds.map(id => model.pool.indexOf(id));
      pts.forEach((q,k) => inst.setPoint(idx[k], q[0], q[1]));
    };
    for (const plane of [floor, wall]) {
      const truth = plane===floor?TF:TW;
      for (const cam of cams) { P.placePlaneOnView(plane, cam.name, 320, 240); setPts(plane, cam.name, truth.map(q=>cam.project(q))); }
    }
    for (const plane of [floor, wall]) {
      P.planeState.selectedPlaneId = plane.id; P.refreshPlanePanel();
      document.getElementById('btnPlaneTriangulate').click();
      const fit = T.fitPlaneToPoints3d(P.planePoints3d(plane));
      plane.planeFit = { centroid: fit.centroid, normal: fit.normal, rms: fit.rms, nPoints: fit.nPoints };
      plane.filled = true;
    }
    P.planeState.selectedPlaneId = wall.id;
    model.pool.setPin(model.pool.nodeAt(2).id, 'plane-locked', floor.id);
    P.planeState.expanded.add(wall.id);
    P.enterPlaneMode();
    P.refreshPlanePanel(); P.syncPlanes3D();
  });
  await page.waitForTimeout(600);
  // Frame the scene, or the default camera sits inside a camera label.
  await page.evaluate(async () => {
    const AS = await import('/ui/app-state.js');
    AS.viewport3d.fitToScene();
    AS.viewport3d.lookAtOrigin && AS.viewport3d.lookAtOrigin();
  });
  await page.waitForTimeout(400);
  if (process.env.SHOT !== 'panel') {
    await page.evaluate(() => { document.getElementById('btnSetPlaneAngle').click(); });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const t = document.getElementById('planeAngleTarget');
      t.value = '90'; t.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: OUT });
  } else {
    // Expand two nodes and hover a padlock, so the shot shows the resting row,
    // the expanded panel and the picker at once.
    await page.evaluate(() => {
      const P = window.__P || null;
      const rows = Array.from(document.querySelectorAll('#planeNodesTable tbody tr.plane-node-main'));
      rows[2].querySelector('.plane-node-expander').click();
      const again = Array.from(document.querySelectorAll('#planeNodesTable tbody tr.plane-node-main'));
      again[4].querySelector('.plane-node-expander').click();
    });
    await page.waitForTimeout(200);
    const rows = await page.$$('#planeNodesTable tbody tr.plane-node-main .plane-node-pin-btn');
    await rows[1].hover();
    await page.waitForTimeout(250);
    const el = await page.$(process.env.SHOT_EL || '#planeNodesDetails');
    const box = await el.boundingBox();
    await page.screenshot({ path: OUT, clip: { x: box.x, y: Math.max(0, box.y - 40), width: box.width, height: box.height + 40 } });
  }
  console.log('saved', OUT);
} finally { await browser.close(); server.kill(); }
