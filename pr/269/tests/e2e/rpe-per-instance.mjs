/**
 * rpe-per-instance.mjs — real-browser test for issue #135: the Reprojection
 * Error panel's per-node/per-camera breakdown must show ONE table per instance
 * (labelled by track/identity), not a single cross-track average.
 *
 * Boots the app, injects a session with triangulated instances on frame 0
 * carrying DISTINCT reprojection errors, drives the real
 * `info-panel.updateFrameInfo`, and inspects `#errorBreakdownTable`.
 *
 * Beyond the original per-instance-split assertions, this also pins the three
 * places where the feature's FIRST implementation disagreed with the rest of
 * the app once it was rebased onto current main — each is a silently-wrong
 * label/color, not a crash, so only a real-DOM check catches them:
 *
 *   1. Per-frame identity must win over the group's stale `identityId`
 *      (issue #155/#168: `group.identityId` is only refreshed on the frame the
 *      assignment fired on, so it names the PRE-fix animal on every frame a
 *      propagated swap fix covers).
 *   2. The track must be found by scanning every member camera, not by taking
 *      `instances`' first entry — a group whose first view is trackless but
 *      whose siblings are tracked must still be labelled by its track.
 *   3. The dot color must equal `getGroupColor` for the same group, in BOTH
 *      color-by-track and color-by-identity mode, so the panel agrees with the
 *      2D views and the 3D viewport.
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
    const OV = await import('/ui/overlays.js');
    const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
    const mtx = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
    const cams = ['cam1', 'cam2'].map((n, i) => new Camera(n, mtx, [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [512, 512]));
    const skel = new Skeleton('skeleton', ['nose', 'tail'], [[0, 1]]);
    const s = new Session(cams, skel, ['mouseA', 'mouseB', 'mouseC'], 'S');
    const idB = s.addIdentity('Bob');           // gB carries a group identity
    const idCarol = s.addIdentity('Carol');     // ...which a per-frame entry overrides
    const mk = (tr) => new Instance([[1, 2], [3, 4]], tr, 'user', 1);
    const fg = new FrameGroup(0); s.addFrameGroup(fg);
    const gA = new InstanceGroup(1, -1); gA.addInstance('cam1', mk(0)); gA.addInstance('cam2', mk(0));
    const gB = new InstanceGroup(2, idB.id); gB.addInstance('cam1', mk(1)); gB.addInstance('cam2', mk(1));
    // gC's FIRST member view is trackless; only its sibling carries the track.
    const gC = new InstanceGroup(3, -1); gC.addInstance('cam1', mk(null)); gC.addInstance('cam2', mk(2));
    for (const g of [gA, gB, gC]) for (const [cn, inst] of g.instances) fg.addInstance(cn, inst);
    s.instanceGroups.set(0, [gA, gB, gC]);

    AS.state.session = s;
    AS.state.sessions = [s];
    AS.state.currentFrame = 0;
    AS.state.colorByIdentity = false;
    // Results with clearly DIFFERENT per-node/per-camera errors.
    const results = [
      { group: gA, errors: { cam1: [1.0, 2.0], cam2: [3.0, 4.0] }, meanError: 2.5, method: 'dlt' },
      { group: gB, errors: { cam1: [10.0, 20.0], cam2: [30.0, 40.0] }, meanError: 25.0, method: 'dlt' },
      { group: gC, errors: { cam1: [5.0, 6.0], cam2: [7.0, 8.0] }, meanError: 6.5, method: 'dlt' },
    ];
    AS.state.triangulationResults.set(0, results);

    // Resolve any CSS color (hex, rgb(), var(--x)) to a comparable string.
    const norm = (css) => {
      const el = document.createElement('div');
      el.style.backgroundColor = css;
      document.body.appendChild(el);
      const v = getComputedStyle(el).backgroundColor;
      el.remove();
      return v;
    };

    // Read one rendered block per instance: label, dot color, mean, first cell.
    const readBlocks = () => {
      const div = document.getElementById('errorBreakdownTable');
      return Array.from(div.children).map((block) => {
        const hdr = block.children[0];
        const tbl = block.querySelector('table');
        const firstBodyRow = tbl ? tbl.querySelector('tbody tr') : null;
        const cells = firstBodyRow ? firstBodyRow.querySelectorAll('td') : [];
        return {
          label: hdr.children[1] ? hdr.children[1].textContent : null,
          dot: getComputedStyle(hdr.children[0]).backgroundColor,
          mean: hdr.children[2] ? hdr.children[2].textContent : null,
          firstCell: cells.length >= 2 ? cells[1].textContent : null, // [0]=node, [1]=cam1
        };
      });
    };

    // ---- Phase 1: baseline render, color by TRACK ----------------------
    IP.updateFrameInfo(0, [gA, gB, gC]);
    const byTrack = readBlocks();
    const expectByTrack = [gA, gB, gC].map(g => norm(OV.getGroupColor(g, s, false, 0, null)));

    // ---- Phase 2: same frame, color by IDENTITY -------------------------
    AS.state.colorByIdentity = true;
    IP.updateFrameInfo(0, [gA, gB, gC]);
    const byIdentity = readBlocks();
    const expectByIdentity = [gA, gB, gC].map(g => norm(OV.getGroupColor(g, s, true, 0, null)));
    AS.state.colorByIdentity = false;

    // ---- Phase 3: per-frame identity overrides a STALE group.identityId --
    // gB still has group.identityId === Bob, but frame 0 now says Carol for
    // its live (camera, track) — exactly the state a propagated swap fix
    // leaves behind. The label must read Carol.
    s.setFrameIdentity(0, 'cam1', 1, idCarol.id);
    s.setFrameIdentity(0, 'cam2', 1, idCarol.id);
    IP.updateFrameInfo(0, [gA, gB, gC]);
    const afterPerFrame = readBlocks();

    return {
      byTrack, expectByTrack, byIdentity, expectByIdentity, afterPerFrame,
      staleGroupIdentityName: s.getIdentity(gB.identityId).name,
      nTables: document.getElementById('errorBreakdownTable').querySelectorAll('table').length,
    };
  });

  console.log('    by track:   ', JSON.stringify(info.byTrack));
  console.log('    by identity:', JSON.stringify(info.byIdentity));
  console.log('    per-frame:  ', JSON.stringify(info.afterPerFrame));

  const labelsOf = (blocks) => blocks.map(b => b.label);

  // --- original #135 assertions: one table per instance, own values --------
  check(info.nTables === 3, `one breakdown table per instance (3) (got ${info.nTables})`);
  check(labelsOf(info.byTrack).includes('mouseA'),
    `identityless instance labelled by track (mouseA) (labels=${JSON.stringify(labelsOf(info.byTrack))})`);
  check(labelsOf(info.byTrack).some(l => l.indexOf('Bob') === 0),
    `identified instance labelled by identity first (Bob · mouseB) (labels=${JSON.stringify(labelsOf(info.byTrack))})`);
  const cells = info.byTrack.map(b => b.firstCell);
  check(cells.includes('1.0') && cells.includes('10.0') && cells.includes('5.0'),
    `each table shows its OWN cam1/nose error (1.0, 10.0, 5.0), not an average (got ${JSON.stringify(cells)})`);
  check(info.byTrack.some(b => b.mean === '2.5 px') && info.byTrack.some(b => b.mean === '25.0 px'),
    `each header shows that instance's own mean error (got ${JSON.stringify(info.byTrack.map(b => b.mean))})`);

  // --- (2) track resolved by scanning ALL member cameras -------------------
  check(labelsOf(info.byTrack).includes('mouseC'),
    `group whose FIRST view is trackless is still labelled by its sibling's track ` +
    `(mouseC, not "Instance N") (labels=${JSON.stringify(labelsOf(info.byTrack))})`);

  // --- (3) dot color agrees with getGroupColor, in BOTH color modes --------
  // Sorted by label, so compare as sets against the three expected colors.
  const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
  check(sameSet(info.byTrack.map(b => b.dot), info.expectByTrack),
    `color-by-track dots match getGroupColor (got ${JSON.stringify(info.byTrack.map(b => b.dot))}, ` +
    `expected ${JSON.stringify(info.expectByTrack)})`);
  check(sameSet(info.byIdentity.map(b => b.dot), info.expectByIdentity),
    `color-by-identity dots match getGroupColor (got ${JSON.stringify(info.byIdentity.map(b => b.dot))}, ` +
    `expected ${JSON.stringify(info.expectByIdentity)})`);
  check(new Set(info.byTrack.map(b => b.dot)).size === 3,
    `the three instances get three DISTINCT dot colors (got ${JSON.stringify(info.byTrack.map(b => b.dot))})`);

  // --- (1) per-frame identity beats the stale group.identityId -------------
  check(info.staleGroupIdentityName === 'Bob',
    `precondition: gB.identityId still names the stale identity (got ${info.staleGroupIdentityName})`);
  check(labelsOf(info.afterPerFrame).some(l => l.indexOf('Carol') === 0),
    `per-frame identity wins over stale group.identityId (Carol · mouseB) ` +
    `(labels=${JSON.stringify(labelsOf(info.afterPerFrame))})`);
  check(!labelsOf(info.afterPerFrame).some(l => l.indexOf('Bob') === 0),
    `the stale identity (Bob) is NOT shown once frame 0 says Carol ` +
    `(labels=${JSON.stringify(labelsOf(info.afterPerFrame))})`);

  check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs[0] : ''));

  // ---------------------------------------------------------------------------
  // Phase 4 (fresh page): no PHANTOM tables after the REAL "Triangulate All".
  //
  // "Triangulate All" routes to `groupByIdentityAndTriangulateAll` whenever
  // identities exist. That DELETES and rebuilds each frame's `instanceGroups`
  // but never prunes `state.triangulationResults`, and `ui/rendering.js`'s lazy
  // fill CONCATENATES its freshly-computed entries onto whatever was already
  // stored — so a frame the user had already triangulated holds results for both
  // the deleted groups and their replacements. Unfiltered, that renders two
  // tables per animal. The panel must show one table per LIVE group.
  // ---------------------------------------------------------------------------
  console.log('  -- phase 4: real Triangulate All over an already-triangulated frame --');
  const page2 = await browser.newPage();
  const errs2 = [];
  page2.on('pageerror', e => errs2.push(String(e)));
  await page2.goto(`http://localhost:${PORT}/index.html`);
  await page2.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

  const ta = await page2.evaluate(async () => {
    const pd = await import('/pose/pose-data.js');
    const AS = await import('/ui/app-state.js');
    const IP = await import('/ui/info-panel.js');
    const TRI = await import('/pose/triangulation.js');
    const EM = await import('/ui/export-modals.js');
    const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

    const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
    const camA = new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
    const camB = new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.3, 0], [20, 0, 0], [640, 480]);
    const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
    const session = new Session([camA, camB], skel, ['track_0', 'track_1'], 'RPETriangulateAll');
    const NF = 3;
    for (let f = 0; f < NF; f++) {
      const fg = new FrameGroup(f);
      session.addFrameGroup(fg);
      for (const [tr, base] of [[0, [10, 5, 50]], [1, [-8, 4, 45]]]) {
        const p1 = [base[0] + f * 0.2, base[1], base[2]];
        const p2 = [base[0] + 1 + f * 0.2, base[1] + 1, base[2] + 1];
        for (const cam of [camA, camB]) {
          fg.addInstance(cam.name, new Instance([cam.project(p1), cam.project(p2)], tr, 'predicted', 1));
        }
      }
    }
    AS.state.sessions = [session];
    AS.state.activeSessionIdx = 0;
    AS.state.session = session;
    AS.state.totalFrames = NF;
    AS.state.currentFrame = 0;
    AS.state.triangulationResults = new Map();
    AS.state.views = [];

    // Real Track-All-shaped output: two identities, per-camera track→identity.
    const red = session.addIdentity('Red');
    const blue = session.addIdentity('Blue');
    for (const cn of ['camA', 'camB']) {
      session.assignTrackToIdentity(0, red.id, cn);
      session.assignTrackToIdentity(1, blue.id, cn);
    }
    for (let f = 0; f < NF; f++) {
      const fg = session.frameGroups.get(f);
      const groups = [];
      for (const [gi, idObj] of [[0, red], [1, blue]]) {
        const grp = new InstanceGroup(f * 10 + gi + 1, idObj.id);
        for (const cam of [camA, camB]) grp.addInstance(cam.name, fg.instances.get(cam.name)[gi]);
        groups.push(grp);
      }
      session.instanceGroups.set(f, groups);
    }

    const readPanel = () => {
      const div = document.getElementById('errorBreakdownTable');
      return {
        tables: div.querySelectorAll('table').length,
        labels: Array.from(div.children).map(b =>
          (b.children[0] && b.children[0].children[1]) ? b.children[0].children[1].textContent : null),
      };
    };

    // The user triangulates the current frame first (very common), THEN hits
    // Triangulate All — which is what leaves the superseded results behind.
    TRI.triangulateCurrentFrame('dlt');
    IP.updateFrameInfo(0, TRI.getInstanceGroupsForFrame(0));
    const afterSingle = readPanel();

    await EM.groupByIdentityAndTriangulateAll();
    // It ends with drawAllOverlays + updateInfoPanel, so the panel is rendered.
    const stored = AS.state.triangulationResults.get(0) || [];
    const live = session.instanceGroups.get(0) || [];
    return {
      afterSingle,
      afterAll: readPanel(),
      storedResults: stored.length,
      liveGroups: live.length,
      supersededResults: stored.filter(r => !live.includes(r.group)).length,
    };
  });

  console.log('    after single-frame Triangulate:', JSON.stringify(ta.afterSingle));
  console.log('    after real Triangulate All:    ', JSON.stringify(ta.afterAll),
    `stored=${ta.storedResults} live=${ta.liveGroups} superseded=${ta.supersededResults}`);

  check(ta.afterSingle.tables === 2,
    `precondition: single-frame Triangulate renders one table per animal (got ${ta.afterSingle.tables})`);
  check(ta.supersededResults > 0,
    `precondition: Triangulate All leaves superseded results behind (got ${ta.supersededResults}) — ` +
    `if this ever hits 0 the triangulation path started pruning them and the filter is now belt-and-braces`);
  check(ta.afterAll.tables === 2,
    `after real Triangulate All: one table per LIVE animal, no phantom duplicates ` +
    `(got ${ta.afterAll.tables} tables for ${ta.liveGroups} groups)`);
  check(new Set(ta.afterAll.labels).size === ta.afterAll.labels.length,
    `no duplicated instance labels (got ${JSON.stringify(ta.afterAll.labels)})`);
  check(ta.afterAll.labels.some(l => l && l.indexOf('Red') === 0) &&
        ta.afterAll.labels.some(l => l && l.indexOf('Blue') === 0),
    `both animals still labelled by identity (got ${JSON.stringify(ta.afterAll.labels)})`);
  check(errs2.length === 0, 'no page errors in phase 4' + (errs2.length ? ': ' + errs2[0] : ''));

  await browser.close();
} finally {
  server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
