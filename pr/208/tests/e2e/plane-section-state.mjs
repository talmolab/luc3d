/**
 * plane-section-state.mjs — the Define Planes panel's sections.
 *
 * Two things, both about a panel the user scrolls past constantly:
 *
 *  1. MAJOR sections are marked and sub-sections are not. Both levels are the
 *     same bordered `.plane-details` box, so without this "Plane Appearance"
 *     (inside Planes) read as top-level as "3D Mesh Objects" beside it.
 *  2. Which sections are open SURVIVES A RELOAD. Loading a project reloads the
 *     page, and the markup's `open` attributes come back — so every section was
 *     expanded again and the user refolded the same ones after every load.
 *
 * The interesting assertions are the negative ones: that the restore does not
 * fight the user on a repaint, that Danger Zone is deliberately NOT remembered,
 * and that none of this reaches the project file.
 *
 * Run: node plane-section-state.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8233);
const KEY = 'planeSectionsOpen';

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });

    const boot = async () => {
        await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
        await page.evaluate(async () => {
            const P = await import('/ui/plane-definition.js');
            if (!P.planeState.active) P.togglePlaneMode();
            P.refreshPlanePanel();
        });
        await page.waitForTimeout(120);
    };

    const openOf = (id) => page.evaluate((i) => {
        const el = document.getElementById(i);
        return el ? el.open : null;
    }, id);
    const stored = () => page.evaluate((k) => {
        try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return 'THREW'; }
    }, KEY);

    await page.goto(`http://localhost:${PORT}/index.html`);
    await boot();

    console.log('\n--- 1. Major sections are outlined, sub-sections are not ---');
    // The mark is the section's own 1px border, recoloured to the accent, ALL
    // THE WAY AROUND — a marked header alone says where a section starts, and
    // it is where a tall one ENDS that is ambiguous in a single scrolling
    // column. Read off computed style rather than class names: what matters is
    // what the user sees.
    const style = await page.evaluate(() => {
        const box = (id) => {
            const d = document.getElementById(id);
            if (!d) return null;
            const s = getComputedStyle(d);
            const sum = getComputedStyle(d.querySelector('summary'));
            return {
                top: s.borderTopColor,
                right: s.borderRightColor,
                bottom: s.borderBottomColor,
                left: s.borderLeftColor,
                width: s.borderTopWidth,
                headerBg: sum.backgroundColor,
            };
        };
        return {
            nodes: box('planeNodesDetails'),
            editor: box('planeEditorDetails'),
            planes: box('planePlanesDetails'),
            mesh: box('meshObjectsDetails'),
            origin: box('originResultDetails'),
            danger: box('originDangerDetails'),
            // Nested inside Edit Plane / Planes — peers in markup, not in rank.
            members: box('planeMembersDetails'),
            edges: box('planeEdgesDetails'),
            appearance: box('planeAppearanceDetails'),
        };
    });

    const accent = style.nodes.top;
    const plain = style.members.top;
    check(accent !== plain,
        'a major section is outlined in the accent, a sub-section is not (' +
        accent + ' vs ' + plain + ')');
    for (const id of ['nodes', 'editor', 'planes', 'mesh', 'origin']) {
        const b = style[id];
        check(b && b.top === accent && b.right === accent &&
            b.bottom === accent && b.left === accent,
            id + ': the accent runs all FOUR sides, not just the top');
        check(b && b.width === '1px', id + ': and stays a thin line — ' + (b ? b.width : 'missing'));
    }
    for (const id of ['members', 'edges', 'appearance']) {
        const b = style[id];
        check(b && b.top === plain && b.bottom === plain,
            id + ' (a SUB-section): keeps the plain border');
    }
    check(style.nodes.headerBg !== style.members.headerBg,
        'and a major header is tinted differently from a sub one');
    // Danger Zone is a major too, in its own colour — the red is the whole
    // point of that block not looking like its neighbours.
    check(style.danger.top === style.danger.bottom && style.danger.top !== accent,
        'Danger Zone is outlined the same way but NOT in the accent: ' + style.danger.top);
    check(style.danger.top !== plain, 'and not in the plain border colour either');

    console.log('\n--- 2. Collapsed sections survive a reload ---');
    check(await openOf('planeNodesDetails') === true, 'Nodes starts open (the markup default)');
    await page.evaluate(() => {
        document.getElementById('planeNodesDetails').open = false;
        document.getElementById('planeAppearanceDetails').open = false;
    });
    await page.waitForTimeout(80);
    const saved = await stored();
    check(saved && saved.planeNodesDetails === false, 'collapsing Nodes is written to localStorage');
    check(saved && saved.planeAppearanceDetails === false,
        'and so is a SUB-section — Edit Plane is the tallest thing in the panel and ' +
        'most of that height is its sub-sections');

    await page.reload();
    await boot();
    check(await openOf('planeNodesDetails') === false,
        'after a reload Nodes is STILL collapsed — this is the bug: a project load ' +
        'is a page load, and the markup used to win');
    check(await openOf('planeAppearanceDetails') === false, 'and so is Plane Appearance');
    check(await openOf('planePlanesDetails') === true,
        'while a section nobody touched keeps the markup default');

    console.log('\n--- 3. The restore does not fight the user ---');
    // It runs ONCE, in setupPlaneDefinition. Restoring on every repaint would
    // reopen a section the instant it was collapsed.
    await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        document.getElementById('planePlanesDetails').open = false;
        P.refreshPlanePanel();
        P.createPlane('floor');
        P.refreshPlanePanel();
    });
    await page.waitForTimeout(120);
    check(await openOf('planePlanesDetails') === false,
        'a repaint (and a plane created under it) leaves a collapsed section collapsed');

    console.log('\n--- 4. NEGATIVE CONTROL: Danger Zone is NOT remembered ---');
    // It ships collapsed because it holds the three actions that rewrite the
    // calibration every downstream tool reads. A Danger Zone that reopens
    // because it was expanded once, weeks ago, in another project, is exactly
    // the state being collapsed is for.
    await page.evaluate(() => { document.getElementById('originDangerDetails').open = true; });
    await page.waitForTimeout(80);
    const afterDanger = await stored();
    check(!afterDanger || afterDanger.originDangerDetails === undefined,
        'opening it writes nothing: ' + JSON.stringify(afterDanger));
    await page.reload();
    await boot();
    check(await openOf('originDangerDetails') === false,
        'and it comes back COLLAPSED, however it was left');

    console.log('\n--- 5. NEGATIVE CONTROL: none of this is project state ---');
    // Browser-local display taste, the same class as the appearance sliders.
    // Writing it into the .slp would move save-golden-digest.mjs and would mean
    // opening a colleague's project refolds your panel.
    const proj = await page.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        const AS = await import('/ui/app-state.js');
        const saveLoad = await import('/import-export/save-load.js');
        const PM = await import('/import-export/plane-metadata.js');
        if (!P.planeState.active) P.togglePlaneMode();
        saveLoad.clearDirty();
        document.getElementById('meshObjectsDetails').open = false;
        document.getElementById('planeNodesDetails').open = true;
        await new Promise(r => setTimeout(r, 60));
        const lucid = {};
        PM.writePlaneMetadata(lucid, AS.state.sessions ? AS.state.sessions[0] : null);
        return { dirty: AS.state.isDirty, keys: Object.keys(lucid) };
    });
    check(proj.dirty === false,
        'folding a section does not mark the project unsaved — it changed nothing in it');
    check(proj.keys.indexOf('planeSections') < 0 && proj.keys.indexOf('sectionsOpen') < 0,
        'and no section key reaches the plane metadata: ' + JSON.stringify(proj.keys));

    console.log('\n--- 6. Unreadable storage degrades to the markup default ---');
    // Private windows, blocked site data and quota errors all make localStorage
    // throw. A section that cannot be remembered still has to open and close.
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    let broke = false;
    p2.on('pageerror', () => { broke = true; });
    await p2.addInitScript(() => {
        const die = () => { throw new Error('storage blocked'); };
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() { return { getItem: die, setItem: die, removeItem: die }; },
        });
    });
    await p2.goto(`http://localhost:${PORT}/index.html`);
    await p2.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    await p2.evaluate(async () => {
        const P = await import('/ui/plane-definition.js');
        if (!P.planeState.active) P.togglePlaneMode();
    });
    const survived = await p2.evaluate(() => {
        const d = document.getElementById('planeNodesDetails');
        const before = d.open;
        d.open = !before;
        return { before, after: d.open };
    });
    await p2.waitForTimeout(120);
    check(survived.before === true, 'with storage throwing, the markup default is used');
    check(survived.after === false, 'and the section still toggles');
    check(broke === false, 'without throwing out of the toggle handler');
    await ctx2.close();

    console.log(fails === 0 ? '\nPASS — 0 failure(s)' : `\nFAIL — ${fails} failure(s)`);
} catch (err) {
    console.log('  ✗ threw: ' + (err && err.message ? err.message : String(err)));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
process.exit(fails === 0 ? 0 : 1);
