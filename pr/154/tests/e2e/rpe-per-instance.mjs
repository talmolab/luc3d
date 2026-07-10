/**
 * rpe-per-instance.mjs — real-browser test for issue #135: the Reprojection
 * Error panel's per-node/per-camera breakdown must show ONE table per instance
 * (labelled by track/identity), not a single cross-track average.
 *
 * Boots the app, injects a session with two triangulated instances on frame 0
 * carrying DISTINCT reprojection errors, drives the real
 * `info-panel.updateFrameInfo`, and inspects `#errorBreakdownTable`.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8092);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

  const info = await page.evaluate(async () => {
    const pd = await import('/pose/pose-data.js');
    const AS = await import('/ui/app-state.js');
    const IP = await import('/ui/info-panel.js');
    const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
    const mtx = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
    const cams = ['cam1', 'cam2'].map((n, i) => new Camera(n, mtx, [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [512, 512]));
    const skel = new Skeleton('skeleton', ['nose', 'tail'], [[0, 1]]);
    const s = new Session(cams, skel, ['mouseA', 'mouseB'], 'S');
    const idB = s.addIdentity('Bob');           // gB also carries an identity
    const mk = (tr) => new Instance([[1, 2], [3, 4]], tr, 'user', 1);
    const fg = new FrameGroup(0); s.addFrameGroup(fg);
    const gA = new InstanceGroup(1, -1); gA.addInstance('cam1', mk(0)); gA.addInstance('cam2', mk(0));
    const gB = new InstanceGroup(2, idB.id); gB.addInstance('cam1', mk(1)); gB.addInstance('cam2', mk(1));
    for (const [cn, inst] of gA.instances) fg.addInstance(cn, inst);
    for (const [cn, inst] of gB.instances) fg.addInstance(cn, inst);
    s.instanceGroups.set(0, [gA, gB]);

    AS.state.session = s;
    AS.state.sessions = [s];
    AS.state.currentFrame = 0;
    // Two results with clearly DIFFERENT per-node/per-camera errors.
    AS.state.triangulationResults.set(0, [
      { group: gA, errors: { cam1: [1.0, 2.0], cam2: [3.0, 4.0] }, meanError: 2.5, method: 'dlt' },
      { group: gB, errors: { cam1: [10.0, 20.0], cam2: [30.0, 40.0] }, meanError: 25.0, method: 'dlt' },
    ]);

    IP.updateFrameInfo(0, [gA, gB]);

    const div = document.getElementById('errorBreakdownTable');
    const tables = div.querySelectorAll('table');
    const labels = Array.from(div.querySelectorAll('span')).map(s => s.textContent).filter(Boolean);
    // Collect the first data cell of each table (nose row, cam1 col) to confirm
    // the two tables carry the two DIFFERENT instances' values, not an average.
    const firstCells = Array.from(tables).map(t => {
      const firstBodyRow = t.querySelector('tbody tr');
      const cells = firstBodyRow ? firstBodyRow.querySelectorAll('td') : [];
      return cells.length >= 2 ? cells[1].textContent : null; // [0]=node name, [1]=cam1
    });
    return { nTables: tables.length, labels, firstCells };
  });

  console.log('    render:', JSON.stringify(info));
  check(info.nTables === 2, `two per-instance breakdown tables (got ${info.nTables})`);
  check(info.labels.includes('mouseA'),
    `trackless-identity instance labelled by track (mouseA) (labels=${JSON.stringify(info.labels)})`);
  check(info.labels.some(l => l.indexOf('Bob') === 0),
    `identified instance labelled by identity first (Bob · mouseB) (labels=${JSON.stringify(info.labels)})`);
  check(info.firstCells.includes('1.0') && info.firstCells.includes('10.0'),
    `each table shows its OWN cam1/nose error (1.0 and 10.0), not an average (got ${JSON.stringify(info.firstCells)})`);
  check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));

  await browser.close();
} finally {
  server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
