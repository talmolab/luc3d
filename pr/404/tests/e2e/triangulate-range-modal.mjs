/**
 * triangulate-range-modal.mjs — Analysis ▸ Triangulate Multiple Frames, through
 * its real modal, re-solves exactly the frames it SHOWS, with the method
 * Settings ▸ Default Triangulation names; and Group by Track survives a frame
 * that has 3D grouping but no 2D.
 *
 * ## The bugs (all in ui/export-modals.js)
 *   1. The modal's Start / End boxes show 1-based frame numbers
 *      (`inputStart.value = s + 1`), but Continue read them with `parseInt` and
 *      used them as 0-based indices. So the DEFAULT full range (1 … N) checked
 *      frame index N, which does not exist, and refused with "Frame N+1 does not
 *      have identity assignment" — the modal could not run on its own defaults.
 *      Every typed range ran one frame late: Start 21, End 40 re-solved indices
 *      21 … 40 (displayed 22 … 41), and never checked displayed frame 21.
 *   2. `runMultiFrameTriangulation` called `triangulateMultiFrameInstances`
 *      without a method, so it always solved with DLT whatever Settings ▸
 *      Default Triangulation said — the "every caller states its method" rule
 *      (`resolveTriangulationMethod`, tests/test-triangulation-method-
 *      propagation.mjs). The summary did not name a method, so nothing showed it.
 *   3. `groupByTrackAndTriangulateAll`'s sweep callback dereferenced `fg`
 *      without the `if (!fg) return;` guard `groupByIdentityAndTriangulateAll`
 *      has. A frame with an `instanceGroups` entry and no FrameGroup — which the
 *      sweep visits by contract (`sweepLazyFrameWindows`' `_hasFrameData`) —
 *      threw a TypeError part-way through, after every earlier frame's groups
 *      had already been deleted and rebuilt and before any later frame's were.
 *
 * ## What this pins (synthetic eager project, `fixtures/ba-rig-fixture.js`)
 *   A. The default full range runs, with no error, and re-solves every frame.
 *   B. Start 21, End 40 re-solves exactly indices 20 … 39 — displayed 21 … 40.
 *   C. A displayed frame with no groups is refused under its displayed number,
 *      and only when it is IN the typed range: no groups on index 20 refuses
 *      Start 21 ("Frame 21"), and Start 22 runs.
 *   D. With Settings ▸ Default Triangulation set to Refined in the real Settings
 *      dialog, every re-solved group is BA — bit-identical to an independent BA
 *      solve of its member cameras — and the summary and status name "Refined".
 *      Back on DLT, the same names "DLT".
 *   G. Group by Track, through its real modal, on a project whose index 30 has
 *      3D grouping but no FrameGroup: no error, frames on BOTH sides of it are
 *      regrouped, and its own groups are left as they were.
 *
 * "Re-solved" is detected by `points3d` identity: every solve stores a fresh
 * array, so a group whose `points3d` is the same object as before the run was
 * not touched by it. That is robust to how many frames the fixture has.
 *
 * Run:  PORT=8411 node tests/e2e/triangulate-range-modal.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8311);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const NF = 60;

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

  // ---- page-side helpers ----------------------------------------------------
  await page.evaluate(async (NF) => {
    const AS = await import('/ui/app-state.js');
    const TRI = await import('/pose/triangulation.js');
    const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
    const F = await buildBaRigFixture({ frames: NF, cycle: 8 });
    const T = window.__T = { AS, TRI, F, cams: F.cams };
    // A fresh eager project with a DLT group per animal on every frame.
    T.boot = async (name) => {
      const s = F.mkSession(name, { eager: true });
      AS.state.sessions = [s];
      AS.state.activeSessionIdx = 0;
      AS.state.session = s;
      AS.state.totalFrames = NF;
      AS.state.currentFrame = 0;
      AS.state.views = [];
      AS.state.triangulationResults = new Map();
      await TRI.triangulateAllFrames('dlt');
      T.s = s;
      T.snap();
      return [...s.instanceGroups.values()].reduce((n, gs) => n + gs.length, 0);
    };
    // Remember every group's current 3D (and the group objects per frame).
    T.snap = () => {
      T.prior3d = new Map();
      T.priorGroups = new Map();
      for (const [f, gs] of T.s.instanceGroups) {
        T.priorGroups.set(f, gs.slice());
        for (const g of gs) T.prior3d.set(g, g.points3d);
      }
    };
    T.resolved = () => {
      const fr = [];
      for (const [f, gs] of T.s.instanceGroups) if (gs.some(g => g.points3d !== T.prior3d.get(g))) fr.push(f);
      return fr.sort((a, b) => a - b);
    };
    T.resolvedGroups = () => [...T.s.instanceGroups.values()].flat().filter(g => g.points3d !== T.prior3d.get(g));
    T.status = () => ((document.getElementById('statusText') || {}).textContent || '').trim();
  }, NF);

  const statusOf = () => page.evaluate(() => window.__T.status());
  const errorText = () => page.evaluate(() => {
    const e = document.getElementById('tfError');
    return e && e.style.display !== 'none' ? e.textContent.trim() : null;
  });
  // Open Triangulate Multiple Frames from its menu item, optionally type a
  // range into the Start / End boxes (as a user does: type, then Tab), Continue.
  // Returns once it either finished (Close shown) or refused (error shown).
  async function runRangeModal(start, end) {
    await page.locator('#menuTriangulateMulti').dispatchEvent('click');
    await page.waitForSelector('#tfContinue');
    if (start != null) { await page.fill('#tfInputStart', String(start)); await page.press('#tfInputStart', 'Tab'); }
    if (end != null) { await page.fill('#tfInputEnd', String(end)); await page.press('#tfInputEnd', 'Tab'); }
    const shown = await page.evaluate(() => [document.getElementById('tfInputStart').value, document.getElementById('tfInputEnd').value]);
    await page.click('#tfContinue');
    await page.waitForFunction(() => document.getElementById('tfClose') ||
      (document.getElementById('tfError') && document.getElementById('tfError').style.display !== 'none'), null, { timeout: 120000 });
    const r = {
      shown,
      done: await page.evaluate(() => !!document.getElementById('tfClose')),
      error: await errorText(),
      label: await page.evaluate(() => ((document.getElementById('tfProgressLabel') || {}).textContent || '').trim()),
      status: await statusOf(),
      resolved: await page.evaluate(() => window.__T.resolved()),
    };
    // Close (finished) or Cancel (refused) — either way the modal goes.
    if (r.done) await page.click('#tfClose'); else await page.click('#tfCancel');
    return r;
  }
  const range = (a, b) => { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const brief = (a) => a.length ? `${a.length} frames, ${a[0]}…${a[a.length - 1]}` : 'none';

  // ---- A. the default full range --------------------------------------------
  console.log('A. default full range:');
  const nGroups = await page.evaluate(() => window.__T.boot('A'));
  check(nGroups === 2 * NF, `precondition: ${NF} frames with 2 groups each (${nGroups} groups)`);
  const A = await runRangeModal(null, null);
  check(same(A.shown, ['1', String(NF)]), `the boxes show 1 … ${NF} (got ${A.shown.join(' … ')})`);
  check(A.done && A.error == null, `it runs, with no refusal (error: ${JSON.stringify(A.error)})`);
  check(same(A.resolved, range(0, NF - 1)), `every frame is re-solved (${brief(A.resolved)})`);
  check(new RegExp(`triangulated ${NF} frames \\(${2 * NF} groups`).test(A.label), `summary: "${A.label}"`);

  // ---- B. a typed range -----------------------------------------------------
  console.log('B. typed range 21 … 40:');
  await page.evaluate(() => window.__T.snap());
  const B = await runRangeModal(21, 40);
  check(B.done && B.error == null, `it runs (error: ${JSON.stringify(B.error)})`);
  check(same(B.resolved, range(20, 39)),
    `exactly indices 20 … 39 — displayed 21 … 40 — are re-solved (${brief(B.resolved)})`);
  check(/triangulated 20 frames \(40 groups/.test(B.label), `summary: "${B.label}"`);

  // ---- C. a displayed frame with no groups ----------------------------------
  console.log('C. displayed frame 21 has no groups:');
  await page.evaluate(() => { window.__T.s.instanceGroups.delete(20); window.__T.snap(); });
  const C1 = await runRangeModal(21, 40);
  check(!C1.done && C1.error === 'Frame 21 does not have identity assignment.',
    `Start 21 is refused, naming displayed frame 21 (error: ${JSON.stringify(C1.error)})`);
  check(C1.resolved.length === 0, `...and nothing is re-solved (${brief(C1.resolved)})`);
  const C2 = await runRangeModal(22, 40);
  check(C2.done && C2.error == null && same(C2.resolved, range(21, 39)),
    `Start 22 runs, over indices 21 … 39 (error: ${JSON.stringify(C2.error)}; ${brief(C2.resolved)})`);

  // ---- D. the Settings method ------------------------------------------------
  console.log('D. Settings ▸ Default Triangulation:');
  async function setDefaultMethod(method) {
    await page.locator('#menuSettings').dispatchEvent('click');
    await page.locator('.settings-overlay').getByText('Default Triangulation', { exact: true }).first().click();
    await page.click(`.tri-method-choice[data-method="${method}"]`);
    await page.click('.settings-btn-apply');
    return page.evaluate(async () => (await import('/ui/settings.js')).getDefaultTriangulationMethod());
  }
  const now = await setDefaultMethod('ba');
  check(now === 'ba', `precondition: the Settings dialog set the default to Refined (${now})`);
  await page.evaluate(() => window.__T.boot('D'));
  const D = await runRangeModal(11, 30);
  const dGroups = await page.evaluate(() => {
    const T = window.__T;
    const gs = T.resolvedGroups();
    let ba = 0, bitIdentical = 0;
    for (const g of gs) {
      if (g.triangulationMethod === 'ba') ba++;
      const members = T.cams.filter(c => g.getInstance(c.name));
      const ref = T.TRI.triangulateAndReproject(g, members, { method: 'ba' }).points3d;
      // Either side may be flat (Float64Array(3N)) or boxed rows; compare flat.
      const flat = (p) => p ? Array.from(p).flatMap(v => (v != null && typeof v === 'object') ? Array.from(v) : [v]) : null;
      const a = flat(g.points3d), b = flat(ref);
      let ok = a && b && a.length === b.length && a.length > 0;
      for (let i = 0; ok && i < b.length; i++) if (!Object.is(a[i], b[i])) ok = false;
      if (ok) bitIdentical++;
    }
    return { n: gs.length, ba, bitIdentical };
  });
  check(D.done && same(D.resolved, range(10, 29)), `displayed 11 … 30 re-solved (${brief(D.resolved)})`);
  check(dGroups.n === 40 && dGroups.ba === 40,
    `every re-solved group is Refined (${dGroups.ba} of ${dGroups.n} BA)`);
  check(dGroups.bitIdentical === dGroups.n && dGroups.n > 0,
    `...and its 3D is bit-identical to an independent Refined solve (${dGroups.bitIdentical} of ${dGroups.n})`);
  check(/\bRefined\b/.test(D.label), `the summary names the method: "${D.label}"`);
  check(/\bRefined\b/.test(D.status), `the status names the method: "${D.status}"`);
  await setDefaultMethod('dlt');
  await page.evaluate(() => window.__T.snap());
  const D2 = await runRangeModal(11, 12);
  const d2Methods = await page.evaluate(() => window.__T.resolvedGroups().map(g => g.triangulationMethod));
  check(D2.done && d2Methods.length === 4 && d2Methods.every(m => m === 'dlt') && /\bDLT\b/.test(D2.label),
    `back on DLT: the re-solved groups are DLT and the summary says so (${JSON.stringify(d2Methods)}; "${D2.label}")`);

  // ---- G. Group by Track past a 3D-only frame --------------------------------
  console.log('G. Group by Track with a 3D-only frame:');
  await page.evaluate(() => window.__T.boot('G'));
  const K = 30;
  await page.evaluate((K) => { window.__T.s.frameGroups.delete(K); window.__T.snap(); }, K);
  const errsBefore = errs.length;
  await page.locator('#menuGroupByTrack').dispatchEvent('click');
  await page.waitForSelector('#gbtGo');
  await page.click('#gbtGo');
  await page.waitForFunction(() => !document.getElementById('gbtGo'), null, { timeout: 120000 });
  const G = await page.evaluate((K) => {
    const T = window.__T;
    const rebuilt = [];
    for (const [f, gs] of T.s.instanceGroups) {
      const before = T.priorGroups.get(f) || [];
      if (gs.some(g => before.indexOf(g) < 0)) rebuilt.push(f);
    }
    const kNow = T.s.instanceGroups.get(K) || [];
    const kBefore = T.priorGroups.get(K) || [];
    return {
      status: T.status(),
      rebuilt: rebuilt.sort((a, b) => a - b),
      kKept: kBefore.length === 2 && kNow.length === 2 && kNow.every((g, i) => g === kBefore[i] && g.points3d === T.prior3d.get(g)),
    };
  }, K);
  const gErrs = errs.slice(errsBefore);
  check(/^Grouped /.test(G.status) && gErrs.length === 0,
    `it completes with no error (status: "${G.status}"; page errors: ${JSON.stringify(gErrs)})`);
  check(same(G.rebuilt, range(0, NF - 1).filter(f => f !== K)),
    `frames on both sides of ${K} are regrouped (${brief(G.rebuilt)}; ${G.rebuilt.includes(K + 1) ? 'includes' : 'MISSING'} ${K + 1})`);
  check(G.kKept, `frame ${K}'s own groups and 3D are left as they were`);

  const otherErrs = errs.filter(e => !gErrs.includes(e));
  check(otherErrs.length === 0, `no page errors elsewhere (${JSON.stringify(otherErrs)})`);
} catch (e) {
  console.error(e);
  fails++;
} finally {
  if (browser) await browser.close();
  server.kill();
}
console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
