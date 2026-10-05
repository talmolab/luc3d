/**
 * triangulate-all-shows-reproj-only.mjs — after Triangulate All, the toolbar
 * shows only "Reproj" (#243): User, Predicted and Errors are unticked, Reproj
 * is ticked, because proofreading the 3D comes next.
 *
 * Every route that ends a Triangulate All is driven through the REAL controls,
 * on the shared BA rig fixture (`fixtures/ba-rig-fixture.js`, identities set):
 *   A. the Triangulate All button (Settings default DLT; identities exist, so
 *      it runs `groupByIdentityAndTriangulateAll`);
 *   B. Triangulate All ▸ Ref on a LAZY session — `triangulateAllFrames`' windowed
 *      sweep, the path a reopened large project takes;
 *   C. Triangulate All ▸ Ref on an eager session — `triangulateAllFrames`'
 *      in-memory path;
 *   D. Edit ▸ Group by Track & Triangulate All, through its dialog.
 * Each starts from all four boxes ticked and must end Reproj-only, with the
 * status line saying so. Also:
 *   E. single-frame Triangulate does NOT touch the boxes;
 *   F. a Triangulate All when the boxes are already Reproj-only changes nothing
 *      and does not add the note.
 *   G. a selected user instance is deselected when its type is hidden — the
 *      boxes fire their normal change handler, not a silent `.checked` write.
 *
 * Run: node tests/e2e/triangulate-all-shows-reproj-only.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8266);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // Install a fresh fixture session (lazy or eager) as the active session.
    const useSession = (name, eager) => page.evaluate(async ({ name, eager }) => {
        const AS = await import('/ui/app-state.js');
        const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
        const F = window.__F || (window.__F = await buildBaRigFixture());
        const s = F.mkSession(name, eager ? { eager: true } : undefined);
        AS.state.sessions = [s];
        AS.state.activeSessionIdx = 0;
        AS.state.session = s;
        AS.state.totalFrames = F.NF;
        AS.state.currentFrame = 0;
        AS.state.views = [];
        AS.state.triangulationResults = new Map();
    }, { name, eager });

    const BOXES = ['visUser', 'visPredicted', 'visReprojections', 'visErrors'];
    const setBoxes = (vals) => page.evaluate(({ BOXES, vals }) => {
        BOXES.forEach((id, i) => {
            const el = document.getElementById(id);
            if (el.checked !== vals[i]) { el.checked = vals[i]; el.dispatchEvent(new Event('change', { bubbles: true })); }
        });
    }, { BOXES, vals });
    const readBoxes = () => page.evaluate(BOXES => BOXES.map(id => document.getElementById(id).checked), BOXES);
    const status = () => page.evaluate(() => document.getElementById('statusText').textContent);
    const REPROJ_ONLY = '[false,false,true,false]';

    // Run `trigger` (in the page) and wait for a Triangulate All status line.
    // The status is cleared first: two routes can end on identical text.
    const runAndWait = async (trigger) => {
        await page.evaluate(() => { document.getElementById('statusText').textContent = ''; });
        await page.evaluate(trigger);
        await page.waitForFunction(() => {
            const t = document.getElementById('statusText').textContent;
            return /^(Triangulated|Grouped)|error/i.test(t);
        }, null, { timeout: 60000 });
        return status();
    };
    const succeeded = (msg) => /^(Triangulated|Grouped) /.test(msg);

    const routes = [
        { key: 'A', label: 'Triangulate All button (group by identity)', eager: true,
          trigger: () => document.getElementById('tbTriangulateAll').click() },
        { key: 'B', label: 'Triangulate All ▸ Ref, lazy session (windowed sweep)', eager: false,
          trigger: () => document.querySelector('#triangulateAllDropdown .tri-dropdown-item[data-method="ba"]').click() },
        { key: 'C', label: 'Triangulate All ▸ Ref, eager session (in-memory)', eager: true,
          trigger: () => document.querySelector('#triangulateAllDropdown .tri-dropdown-item[data-method="ba"]').click() },
        { key: 'D', label: 'Edit ▸ Group by Track & Triangulate All', eager: true,
          trigger: async () => {
              document.getElementById('menuGroupByTrack').click();
              await new Promise(r => setTimeout(r, 50));
              document.getElementById('gbtGo').click();
          } },
    ];

    // Boxes are set BEFORE the session is installed: toggling one redraws the
    // overlays, and on the fixture's minimal lazy loader (no `prefetch`) that
    // throws — a fixture gap that reproduces on main with no Triangulate All
    // involved, not something under test here.
    for (const r of routes) {
        await setBoxes([true, true, true, true]);
        await useSession('reprojOnly_' + r.key, r.eager);
        const msg = await runAndWait(r.trigger);
        const boxes = JSON.stringify(await readBoxes());
        check(succeeded(msg), `${r.key}. ${r.label}: ran ("${msg.slice(0, 70)}…")`);
        check(boxes === REPROJ_ONLY, `${r.key}. boxes end Reproj-only (User, Predicted, Reproj, Errors = ${boxes})`);
        check(/showing Reproj only/.test(msg), `${r.key}. the status line says so`);
    }

    // ---- E. single-frame Triangulate leaves the boxes alone ------------------------
    await useSession('reprojOnly_E', true);
    await setBoxes([true, true, true, true]);
    await page.evaluate(async () => {
        // Group the current frame first (single-frame Triangulate needs groups).
        const TRI = await import('/pose/triangulation.js');
        TRI.ensureGroupsFromIdentities && TRI.ensureGroupsFromIdentities(window.__lucid.state.session, 0);
        document.getElementById('tbTriangulate').click();
    });
    await page.waitForTimeout(500);
    check(JSON.stringify(await readBoxes()) === '[true,true,true,true]',
        'E. single-frame Triangulate leaves User / Predicted / Reproj / Errors as they were');

    // ---- F. already Reproj-only: no change, no note --------------------------------------
    await useSession('reprojOnly_F', true);
    await setBoxes([false, false, true, false]);
    const msgF = await runAndWait(() => document.getElementById('tbTriangulateAll').click());
    check(JSON.stringify(await readBoxes()) === REPROJ_ONLY, 'F. boxes stay Reproj-only');
    check(!/showing Reproj only/.test(msgF), `F. no note when nothing changed ("${msgF.slice(0, 60)}…")`);

    // ---- G. a selection of a now-hidden type is cleared -----------------------------------
    await useSession('reprojOnly_G', true);
    await setBoxes([true, true, true, true]);
    await runAndWait(() => document.getElementById('tbTriangulateAll').click());   // creates groups
    await setBoxes([true, true, true, true]);
    const selected = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const TRI = await import('/pose/triangulation.js');
        const g = (TRI.getInstanceGroupsForFrame(0) || [])[0];
        if (!g || !AS.interactionManager) return false;
        AS.interactionManager.selectedInstanceGroup = g;
        AS.interactionManager.selectedReprojected = false;
        return true;
    });
    check(selected, 'G. precondition: a (predicted) group is selected');
    await runAndWait(() => document.getElementById('tbTriangulateAll').click());
    const stillSelected = await page.evaluate(async () => !!(await import('/ui/app-state.js')).interactionManager.selectedInstanceGroup);
    check(!stillSelected, 'G. hiding Predicted cleared the selection, as a click on the box would');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
