/**
 * skeleton-check.mjs — Triangulate ▸ Skeleton check, end to end.
 *
 * On the bundle-adjustment rig fixture (3 cameras with real k1 distortion, 2 animals, 8 nodes on a path skeleton
 * n0..n7, 2 px noise; `fixtures/ba-rig-fixture.js`) one camera's detection of n6, for one animal on frame 4, is moved
 * 400 px (a detection on a neighbour), so plain triangulation stretches that animal's n5-n6-n7. The path skeleton has
 * no hub, so the check holds it at its centre (n3): chains n0+n1+n2 and n4+n5+n6+n7.
 *   1. the checkbox is in the Triangulate menu, off by default, and sets the browser-local setting;
 *   2. Triangulate All, eager, check off: n6 is off (the plain solve), no group marked;
 *   3. the same with the check on: the run's pass measures the bones, re-solves only the flagged group, and n6
 *      comes back from the two cameras that agree (near the truth); the status line says so; every other group is
 *      exactly the plain solve;
 *   4. the same on a LAZY session through 2 forced workers (the pass hydrates only the windows it needs);
 *   5. This frame, with the bones measured from the 3D already there: the same repair, inline;
 *   6. the display keeps a repaired group's stored 3D with the reprojection threshold on (a re-solve would undo it);
 *   7. Settings ▸ Triangulation Wizard ▸ Skeleton check: custom parts from node tiles. A stored part with a node the
 *      skeleton lacks shows warned; tiles dragged from the bank start a part, go to its end or before a tile, are
 *      reordered within it and dragged back out; a click or Enter on a node adds it to the selected part; below, the
 *      parts the check will judge and any it leaves out; nothing stored until Apply, Apply stores them, the
 *      Triangulate menu's tooltip names them, and Triangulate All checks with them.
 * Run: node tests/e2e/skeleton-check.mjs
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const server = await startServer(repoRoot);
const PORT = server.port;
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/index.html`)).ok) break; } catch {}
  await new Promise(r => setTimeout(r, 250));
}

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const eq7 = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => {
    if (m.type() !== 'error' || /Failed to load resource|net::ERR|404/.test(m.text())) return;   // absent demo assets
    errs.push('console: ' + m.text());
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

  const out = await page.evaluate(async () => {
    const AS = await import('/ui/app-state.js');
    const TRI = await import('/pose/triangulation.js');
    const RND = await import('/ui/rendering.js');
    const RUN = await import('/pose/skeleton-check-run.js');
    const SET = await import('/ui/settings.js');
    const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
    const F = await buildBaRigFixture({ frames: 14 });
    const r = {};
    const BAD_F = 4, BAD_T = 0, BAD_K = 6;
    // one camera's n6 of animal 0 on frame 4, 400 px off
    const o = F.obs.get(BAD_F).get('camA')[BAD_T][BAD_K];
    F.obs.get(BAD_F).get('camA')[BAD_T][BAD_K] = [o[0] + 400, o[1]];
    const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const node = (pts, k) => [pts[3 * k], pts[3 * k + 1], pts[3 * k + 2]];
    /** the frame's group whose n0 is nearest animal t's truth */
    const groupOf = (s, f, t) => {
      let best = null, bd = Infinity;
      for (const g of s.instanceGroups.get(f) || []) {
        const d = dist3(node(g.points3d, 0), F.truth[f][t][0]);
        if (d < bd) { bd = d; best = g; }
      }
      return best;
    };
    const useSession = (s) => {
      AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
      AS.state.totalFrames = F.NF; AS.state.currentFrame = 0; AS.state.views = [];
      AS.state.triangulationResults = new Map();
    };
    const statusText = () => (document.getElementById('statusText') || {}).textContent || '';
    SET.updateTrackingThresholds({ reprojErrorThreshold: 0 });

    // ---- 1. the checkbox
    const box = document.getElementById('tbSkeletonCheck');
    r.box = !!box;
    r.offByDefault = !!box && !box.checked && RUN.getSkeletonCheckSettings().enabled === false;
    if (box) { box.checked = true; box.dispatchEvent(new Event('change')); }
    r.boxTurnsOn = RUN.getSkeletonCheckSettings().enabled === true;

    // ---- 2. eager, check off: the plain solve
    RUN.setSkeletonCheckSettings({ enabled: false });
    const sOff = F.mkSession('SK_OFF', { eager: true });
    useSession(sOff);
    await TRI.triangulateAllFrames('dlt');
    const gOff = groupOf(sOff, BAD_F, BAD_T);
    r.offErr = dist3(node(gOff.points3d, BAD_K), F.truth[BAD_F][BAD_T][BAD_K]);
    r.offMarked = [...sOff.instanceGroups.values()].flat().some(g => g.skeletonRepaired);
    const plain = new Map([...sOff.instanceGroups].map(([f, gs]) => [f, gs.map(g => Float64Array.from(g.points3d))]));

    // ---- 3. eager, check on
    RUN.setSkeletonCheckSettings({ enabled: true });
    const sOn = F.mkSession('SK_ON', { eager: true });
    useSession(sOn);
    document.getElementById('triangulateDropdown').dispatchEvent(new Event('mouseenter'));
    r.tooltip = (box && box.closest('label') && box.closest('label').title) || '';
    await TRI.triangulateAllFrames('dlt');
    r.status = statusText();
    const gOn = groupOf(sOn, BAD_F, BAD_T);
    r.onErr = dist3(node(gOn.points3d, BAD_K), F.truth[BAD_F][BAD_T][BAD_K]);
    r.onMarked = !!gOn.skeletonRepaired;
    r.othersSame = true; r.othersMarked = 0;
    for (const [f, gs] of sOn.instanceGroups) {
      gs.forEach((g, i) => {
        if (g === gOn) return;
        if (g.skeletonRepaired) r.othersMarked++;
        const p = plain.get(f)[i];
        if (!(p && p.length === g.points3d.length && Array.from(p).every((v, j) => Object.is(v, g.points3d[j])))) r.othersSame = false;
      });
    }

    // ---- 4. lazy, through 2 workers
    window.LUCID_TRIANGULATION_WORKERS = 2;
    const sL = F.mkSession('SK_LAZY');
    useSession(sL);
    await TRI.triangulateAllFrames('dlt');
    r.lazyReleased = sL.lazyLoader.released.length;
    const gL = groupOf(sL, BAD_F, BAD_T);
    r.lazyErr = dist3(node(gL.points3d, BAD_K), F.truth[BAD_F][BAD_T][BAD_K]);
    r.lazyMarked = !!gL.skeletonRepaired;
    delete window.LUCID_TRIANGULATION_WORKERS;

    // ---- 5. This frame, bones measured from the 3D already there (the plain solve)
    const sF = F.mkSession('SK_FRAME', { eager: true });
    useSession(sF);
    RUN.setSkeletonCheckSettings({ enabled: false });
    await TRI.triangulateAllFrames('dlt');
    RUN.setSkeletonCheckSettings({ enabled: true });
    RUN.invalidateSkeletonCheck(sF);
    AS.state.currentFrame = BAD_F;
    TRI.triangulateCurrentFrame('dlt');
    const gF = groupOf(sF, BAD_F, BAD_T);
    r.frameErr = dist3(node(gF.points3d, BAD_K), F.truth[BAD_F][BAD_T][BAD_K]);
    r.frameMarked = !!gF.skeletonRepaired;
    r.frameStatus = statusText();

    // ---- 6. the display keeps the repaired 3D with the reprojection threshold on
    useSession(sOn);
    AS.state.currentFrame = BAD_F;
    SET.updateTrackingThresholds({ reprojErrorThreshold: 15 });
    const before = Float64Array.from(gOn.points3d);
    (sOn.instanceGroups.get(BAD_F) || []).forEach(g => { g.reprojections = null; if (g.reprojectedInstances) g.reprojectedInstances.clear(); });
    AS.state.triangulationResults = new Map();
    RND.drawAllOverlays(BAD_F);
    const shown = (AS.state.triangulationResults.get(BAD_F) || []).find(x => x.group === gOn);
    r.fillKeeps = !!shown && Array.from(shown.points3d).every((v, j) => Object.is(v, before[j]));
    SET.updateTrackingThresholds({ reprojErrorThreshold: 0 });
    RUN.setSkeletonCheckSettings({ enabled: false });
    window.__sk = { F, useSession, groupOf, node, dist3, BAD_F, BAD_T, BAD_K };
    return r;
  });

  // ---- 7. Settings ▸ Triangulation Wizard: custom parts from node tiles
  // a part stored before (with a node this skeleton lacks) shows, warned
  await page.evaluate(async () => {
    (await import('/pose/skeleton-check-run.js')).setSkeletonCheckSettings({ chains: 'n1, nt' });
    (await import('/ui/settings-modal.js')).showSettingsModal('triangulation');
  });
  await page.waitForSelector('.sk-chain-bank .sk-chain-tile', { timeout: 10000 });
  const bankTile = (n) => page.locator('.sk-chain-bank .sk-chain-tile', { hasText: new RegExp('^' + n + '$') });
  const partTile = (p, n) => page.locator(`.sk-chain-part[data-part="${p}"] .sk-chain-part-tile`, { hasText: new RegExp('^' + n + '×$') });
  const state7 = () => page.evaluate(async () => {
    const RUN = await import('/pose/skeleton-check-run.js');
    const rows = [...document.querySelectorAll('.sk-chain-parts .sk-chain-part:not(.sk-chain-new)')]
      .map(r => [...r.querySelectorAll('.sk-chain-tile-name')].map(t => t.textContent));
    const preview = document.querySelector('.settings-chains-preview');
    return { rows, unknown: [...document.querySelectorAll('.sk-chain-tile-unknown .sk-chain-tile-name')].map(t => t.textContent),
             preview: preview ? preview.textContent : '', stored: RUN.getSkeletonCheckSettings().chains,
             bank: document.querySelectorAll('.sk-chain-bank .sk-chain-tile').length };
  });
  const before7 = await state7();
  await page.click('.sk-chain-part[data-part="0"] .sk-chain-part-x');                   // remove the stored part
  await bankTile('n3').dragTo(page.locator('.sk-chain-new'));                          // start a part
  await bankTile('n5').dragTo(page.locator('.sk-chain-part[data-part="0"]'));          // onto the row: its end
  await bankTile('n7').dragTo(page.locator('.sk-chain-part[data-part="0"]'));
  await bankTile('n4').dragTo(partTile(0, 'n5'), { targetPosition: { x: 2, y: 8 } });  // before n5
  await bankTile('n6').click();                                                       // a click adds to the selected part
  const built7 = await state7();
  await partTile(0, 'n6').dragTo(partTile(0, 'n7'), { targetPosition: { x: 2, y: 8 } });   // reorder: n6 before n7
  // without the mouse: New part, then Enter on nodes
  await page.click('.sk-chain-new');
  await bankTile('n0').focus();
  await page.keyboard.press('Enter');
  const keyed7 = await state7();
  await partTile(1, 'n0').dragTo(page.locator('.sk-chain-bank'));                      // back onto the bank: out
  const done7 = await state7();
  await page.click('.settings-btn-apply:not(.settings-btn-triangulate)');
  const applied7 = await page.evaluate(async () => (await import('/pose/skeleton-check-run.js')).getSkeletonCheckSettings().chains);
  await page.keyboard.press('Escape');
  const run7 = await page.evaluate(async () => {
    const TRI = await import('/pose/triangulation.js');
    const RUN = await import('/pose/skeleton-check-run.js');
    const { F, useSession, groupOf, node, dist3, BAD_F, BAD_T, BAD_K } = window.__sk;
    const o = { closed: !document.querySelector('.settings-overlay') };
    RUN.setSkeletonCheckSettings({ enabled: true });
    const s = F.mkSession('SK_TYPED', { eager: true });
    useSession(s);
    document.getElementById('triangulateDropdown').dispatchEvent(new Event('mouseenter'));
    const box = document.getElementById('tbSkeletonCheck');
    o.tooltip = (box && box.closest('label') && box.closest('label').title) || '';
    await TRI.triangulateAllFrames('dlt');
    const g = groupOf(s, BAD_F, BAD_T);
    o.err = dist3(node(g.points3d, BAD_K), F.truth[BAD_F][BAD_T][BAD_K]);
    o.marked = !!g.skeletonRepaired;
    const sk = RUN.skeletonCheckForRun(s);
    o.customChains = sk ? sk.chains.filter(c => c.custom).map(c => c.name) : [];
    RUN.setSkeletonCheckSettings({ enabled: false, chains: '' });
    return o;
  });

  check(out.box, 'Triangulate ▸ Skeleton check is in the menu');
  check(out.offByDefault, 'it is off by default');
  check(out.boxTurnsOn, 'ticking it turns the setting on');
  check(/n4\+n5\+n6\+n7/.test(out.tooltip), 'its tooltip names the skeleton\'s parts: ' + out.tooltip.slice(-80));
  console.log(`    n6 off the truth: plain ${out.offErr.toFixed(3)}; checked: eager ${out.onErr.toFixed(3)}, lazy ${out.lazyErr.toFixed(3)}, This frame ${out.frameErr.toFixed(3)}`);
  check(out.offErr > 1 && !out.offMarked, 'check off: n6 stays stretched by the bad detection, no group marked');
  check(out.onErr < 0.25 * out.offErr && out.onMarked, 'Triangulate All with the check: n6 comes back from the cameras that agree');
  check(/skeleton check repaired 1 of 1 groups/.test(out.status), 'the status line says so: ' + out.status);
  check(out.othersSame && out.othersMarked === 0, 'every other group is exactly the plain solve, unmarked');
  check(out.lazyReleased > 0 && out.lazyErr < 0.25 * out.offErr && out.lazyMarked, `lazy, 2 workers: the same (${out.lazyReleased} window releases)`);
  check(out.frameErr < 0.25 * out.offErr && out.frameMarked && /skeleton check repaired 1 group/.test(out.frameStatus),
    'This frame: the same, inline: ' + out.frameStatus);
  check(out.fillKeeps, 'the display keeps the repaired 3D with the reprojection threshold on');
  check(before7.bank === 8 && eq7(before7.rows, [['n1', 'nt']]) && eq7(before7.unknown, ['nt']) && /no node named nt/.test(before7.preview),
    'Settings: a tile per node; a stored part with a node the skeleton lacks shows, warned: ' + before7.preview.slice(-60));
  check(eq7(built7.rows, [['n3', 'n4', 'n5', 'n7', 'n6']]), 'dragged from the bank: a new part, onto its end, before a tile; a click adds to its end: ' + JSON.stringify(built7.rows));
  check(eq7(keyed7.rows, [['n3', 'n4', 'n5', 'n6', 'n7'], ['n0']]), 'dragged within a part to reorder; New part and Enter on a node start another: ' + JSON.stringify(keyed7.rows));
  check(/n4\+n5\+n6\+n7 \(custom\)/.test(keyed7.preview) && /n0: a part needs two nodes or more/.test(keyed7.preview),
    'below the parts: what the check will judge, and a part it leaves out: ' + keyed7.preview.slice(0, 150));
  check(eq7(done7.rows, [['n3', 'n4', 'n5', 'n6', 'n7']]), 'a tile dragged back onto the nodes comes out (its emptied part goes)');
  check(done7.stored === 'n1, nt', 'nothing is stored before Apply');
  check(applied7 === 'n3, n4, n5, n6, n7', 'Apply stores the parts');
  check(run7.closed, 'Esc closes Settings');
  check(/n4\+n5\+n6\+n7 \(custom\)/.test(run7.tooltip), 'the Triangulate menu\'s tooltip names the custom part');
  check(run7.customChains.join() === 'n4+n5+n6+n7' && run7.err < 0.25 * out.offErr && run7.marked,
    'Triangulate All checks with the custom part: n6 comes back (' + run7.err.toFixed(3) + ')');
  check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await browser.close();
} catch (e) {
  console.error(e);
  fails++;
} finally {
  server.kill('SIGTERM');
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
