/**
 * custom-delete-modal.mjs — real-browser smoke test for the Custom Instance
 * Delete modal (Edit ▸ Custom Instance Delete…, issue #72). Boots the app,
 * injects a minimal multi-view session into the shared app-state singleton,
 * opens the modal via the menu handler, and asserts the modal renders + its
 * live count reacts to the filter dropdowns. Run from repo root with the app
 * served (see README); PORT overridable via BASE.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const PORT = 8097;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: process.cwd(), stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
try {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 30000 });

  // Build a minimal session in the SAME app-state singleton the app uses.
  await page.evaluate(async () => {
    const PD = await import('/pose/pose-data.js');
    const AS = await import('/ui/app-state.js');
    const { Session, Instance, InstanceGroup, FrameGroup, UnlinkedInstance } = PD;
    const inst = (type, tr) => new Instance([[0, 0], [1, 1]], tr, type, type === 'user' ? undefined : 0.9);
    const s = new Session([{ name: 'cam1' }, { name: 'cam2' }], null, ['t0', 't1'], 'S1');
    const fg = new FrameGroup(0);
    const a1 = inst('predicted', 0), a2 = inst('predicted', 0);
    const b1 = inst('user', 1), b2 = inst('predicted', 1);
    const gA = new InstanceGroup(1, -1); gA.addInstance('cam1', a1); gA.addInstance('cam2', a2);
    gA.addReprojectedInstance('cam1', inst('reprojected', 0));
    const gB = new InstanceGroup(2, -1); gB.addInstance('cam1', b1); gB.addInstance('cam2', b2);
    fg.addInstance('cam1', a1); fg.addInstance('cam2', a2); fg.addInstance('cam1', b1); fg.addInstance('cam2', b2);
    fg.addUnlinkedInstance('cam1', new UnlinkedInstance(inst('predicted', null), 'cam1'));
    s.frameGroups.set(0, fg); s.instanceGroups.set(0, [gA, gB]);
    AS.state.session = s; AS.state.sessions = [s]; AS.state.currentFrame = 0; AS.state.totalFrames = 1;
  });

  // Open via the real menu handler.
  await page.evaluate(() => document.getElementById('menuCustomDeleteInstance').click());
  await page.waitForSelector('.multi-frame-modal h3', { timeout: 5000 });
  const title = await page.textContent('.multi-frame-modal h3');
  check(title.trim() === 'Custom Instance Delete', 'modal opens with correct title');

  // Default = All / Any / Current frame → 4 grouped + 1 unlinked = 5.
  const countAll = await page.textContent('#cdCount');
  check(/Delete 5 instances/.test(countAll), 'default count = 5 (' + countAll.trim() + ')');

  // Switch type → User: only B cam1 user (grouped) = 1.
  await page.selectOption('#cdType', 'user');
  const countUser = await page.textContent('#cdCount');
  check(/Delete 1 instance\b/.test(countUser), 'user count = 1 (' + countUser.trim() + ')');

  // Switch type → Reprojected: gA has 1 reprojection.
  await page.selectOption('#cdType', 'reprojected');
  const countRe = await page.textContent('#cdCount');
  check(/Delete 1 instance\b/.test(countRe), 'reprojected count = 1 (' + countRe.trim() + ')');

  // Delete button enabled when count>0; frame-range slider hidden by default.
  const applyDisabled = await page.getAttribute('#cdApply', 'disabled');
  check(applyDisabled === null, 'Delete button enabled when matches exist');
  const rangeHidden = await page.evaluate(() => document.getElementById('cdRangeWrap').style.display);
  check(rangeHidden === 'none', 'frame-range slider hidden unless a range scope is chosen');

  // Choosing "Frame range…" reveals the slider.
  await page.selectOption('#cdFrames', 'clip');
  const rangeShown = await page.evaluate(() => document.getElementById('cdRangeWrap').style.display);
  check(rangeShown === 'block', 'frame-range slider revealed for clip scope');

  // Esc closes (CLAUDE.md convention).
  await page.keyboard.press('Escape');
  const gone = await page.evaluate(() => !document.querySelector('.multi-frame-modal'));
  check(gone, 'Esc closes the modal');

  check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));
  await browser.close();
} finally {
  server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
