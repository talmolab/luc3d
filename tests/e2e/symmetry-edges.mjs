/**
 * symmetry-edges.mjs — the Visibility panel's Symmetry Edges, in the real app.
 *
 * Reads real canvas pixels through `drawFrameOverlays`, because what matters is
 * what lands on screen: a thin solid grey line, behind the skeleton, on every
 * instance type, unaffected by the type's own Edge Style or colour.
 *
 *  1. Off by default, and off draws exactly what it drew before.
 *  2. The line is grey, solid and as thick as its weight, whatever the edge style.
 *  3. It sits behind the skeleton's own edges.
 *  4. Every instance type gets it; a missing or nulled node drops it.
 *  5. The toggle and the weight persist; the toggle reports what it found.
 *  6. Export Video Overlays is seeded with it and offers it.
 *
 * Run: PORT=<free port> node tests/e2e/symmetry-edges.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8198);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    const ready = () => page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await ready();

    // Ear_L (100,40), Ear_R (100,160), Nose (300,100); one real edge, Nose to Ear_L.
    await page.evaluate(async () => {
        const overlays = await import('/ui/overlays.js');
        const { Instance, InstanceGroup, UnlinkedInstance, FrameGroup } = await import('/pose/pose-data.js');
        const PTS = [[100, 40], [100, 160], [300, 100]];
        const skeleton = { nodes: ['Ear_L', 'Ear_R', 'Nose'], edges: [[2, 0]] };
        const session = { skeleton, tracks: [] };
        const typeOpts = (extra) => Object.assign(
            { nodeSize: 1, lineWidth: 3, alpha: 1, showLabels: false, showNodes: false, nodeStyle: 'circle' }, extra);
        window.T = {
            PTS, Instance, overlays,
            // kind: 'user' | 'predicted' (group members), 'reproj', 'reprojInstance',
            // 'unlinkedUser', 'unlinkedPredicted'
            draw(kind, { on = true, weight = 1, style = 'solid', pts = PTS, nulled = null } = {}) {
                const c = document.createElement('canvas');
                c.width = 400; c.height = 200;
                const ctx = c.getContext('2d', { willReadFrequently: true });
                const fg = new FrameGroup(0);
                const groups = [];
                let unlinked = [];
                const inst = (type) => {
                    const i = new Instance(pts, 0, type, 1);
                    if (nulled) i.nulledNodes = new Set(nulled);
                    return i;
                };
                if (kind === 'user' || kind === 'predicted') {
                    fg.addInstance('cam', inst(kind));
                } else if (kind === 'reproj') {
                    const g = new InstanceGroup(1, -1);
                    g.reprojections = { cam: pts };
                    groups.push(g);
                } else if (kind === 'reprojInstance') {
                    const g = new InstanceGroup(1, -1);
                    g.addReprojectedInstance('cam', new Instance(pts, 0, 'reprojected', 1));
                    groups.push(g);
                } else {
                    unlinked = [new UnlinkedInstance(inst(kind === 'unlinkedUser' ? 'user' : 'predicted'), 'cam', 'u1')];
                }
                overlays.drawFrameOverlays(ctx, 'cam', fg, groups, session, {
                    showUser: true, showPredicted: true, showReprojected: true, showErrors: false,
                    showSymmetryEdges: on, symmetryEdgeWeight: weight, showUnlinkedBadge: false,
                    unlinkedInstances: unlinked,
                    userOpts: typeOpts({ preLineStyle: style, postLineStyle: style }),
                    predictedOpts: typeOpts({ preLineStyle: style, postLineStyle: style }),
                    reprojOpts: typeOpts({ lineStyle: style, brightness: 1 }),
                    videoWidth: 400, videoHeight: 200, canvasWidth: 400, canvasHeight: 200,
                });
                return ctx;
            },
            // Thickness and colour of whatever crosses row y (Ear_L to Ear_R runs along x = 100).
            acrossRow(ctx, y) {
                const d = ctx.getImageData(60, y, 80, 1).data;
                let n = 0, last = null;
                for (let x = 0; x < 80; x++) {
                    if (d[x * 4 + 3] > 0) { n++; last = [d[x * 4], d[x * 4 + 1], d[x * 4 + 2], d[x * 4 + 3]]; }
                }
                return { n, rgba: last };
            },
        };
    });

    // ---- §1 default ----
    console.log('§1 Off by default');
    const off = await page.evaluate(async () => {
        const { getVisibilitySettings } = await import('/ui/rendering.js');
        const v = getVisibilitySettings();
        const { draw, acrossRow } = window.T;
        const bytes = (ctx) => Array.from(ctx.getImageData(0, 0, 400, 200).data);
        const a = bytes(draw('user', { on: false }));
        const b = bytes(draw('user', { on: null }));
        return {
            setting: v.showSymmetryEdges, weight: v.symmetryEdgeWeight,
            across: acrossRow(draw('user', { on: false }), 100).n,
            same: a.length === b.length && a.every((x, i) => x === b[i]),
        };
    });
    check(off.setting === false, 'the panel starts with it off');
    check(off.weight === 1, 'at weight 1');
    check(off.across === 0, 'and off draws no line');
    check(off.same, 'a caller that leaves it unset draws the same pixels as off');

    // ---- §2 the line ----
    console.log('§2 Thin, solid, grey');
    const line = await page.evaluate(() => {
        const { draw, acrossRow } = window.T;
        const out = { thin: acrossRow(draw('user'), 100), thick: acrossRow(draw('user', { weight: 4 }), 100) };
        for (const style of ['solid', 'dotted', 'dashed', 'wedge']) {
            const ctx = draw('user', { style });
            // Every row of the line, so a dash anywhere shows up as an empty row.
            let empty = 0;
            for (let y = 60; y < 140; y++) if (acrossRow(ctx, y).n === 0) empty++;
            out[style] = { empty, rgb: acrossRow(ctx, 100).rgba.slice(0, 3) };
        }
        return out;
    });
    check(line.thin.n <= 2, `weight 1 is very thin (${line.thin.n} px wide)`);
    check(line.thick.n >= 4 && line.thick.n <= 5, `the weight sets the thickness (${line.thick.n} px at 4)`);
    const isGrey = (rgb) => rgb[0] === rgb[1] && rgb[1] === rgb[2] && rgb[0] > 60 && rgb[0] < 200;
    check(isGrey(line.thin.rgba), `the line is grey (rgb ${line.thin.rgba.slice(0, 3)})`);
    for (const style of ['solid', 'dotted', 'dashed', 'wedge']) {
        check(line[style].empty === 0 && isGrey(line[style].rgb), `it stays solid grey with ${style} edges`);
    }

    // ---- §3 order ----
    console.log('§3 Behind the skeleton');
    const order = await page.evaluate(() => {
        const { overlays, Instance } = window.T;
        const c = document.createElement('canvas');
        c.width = 400; c.height = 200;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        // A real edge running over the same pair, on a third node placed on top of it.
        const inst = new Instance([[100, 40], [100, 160], [100, 100]], 0, 'user', 1);
        overlays.drawSkeleton(ctx, inst, { nodes: ['Ear_L', 'Ear_R', 'Nose'], edges: [[0, 2]] }, {
            color: '#ff0000', nodeSize: 1, lineWidth: 5, showNodes: false, lineStyle: 'solid', alpha: 1,
            symmetryEdges: [[0, 1]], symmetryLineWidth: 1,
        });
        return Array.from(ctx.getImageData(100, 70, 1, 1).data);
    });
    check(order[0] === 255 && order[1] === 0, `where they overlap the skeleton's edge is on top (rgb ${order.slice(0, 3)})`);

    // ---- §4 every type ----
    console.log('§4 Every instance type');
    const kinds = await page.evaluate(() => {
        const { draw, acrossRow, PTS } = window.T;
        const out = {};
        for (const kind of ['user', 'predicted', 'reproj', 'reprojInstance', 'unlinkedUser', 'unlinkedPredicted']) {
            out[kind] = acrossRow(draw(kind), 100).n;
        }
        out.missing = acrossRow(draw('user', { pts: [PTS[0], null, PTS[2]] }), 100).n;
        out.nulled = acrossRow(draw('user', { nulled: [1] }), 100).n;
        return out;
    });
    for (const kind of ['user', 'predicted', 'reproj', 'reprojInstance', 'unlinkedUser', 'unlinkedPredicted']) {
        check(kinds[kind] > 0 && kinds[kind] <= 2, `${kind} draws it (${kinds[kind]} px)`);
    }
    check(kinds.missing === 0, 'a missing node drops the line');
    check(kinds.nulled === 0, 'a nulled node drops the line');

    // ---- §5 the panel ----
    console.log('§5 Panel');
    await page.evaluate(async () => {
        await (await import('/pose/initialization.js')).loadDemoSession();
    });
    await page.waitForFunction(() => window.__lucid.state.session, null, { timeout: 60000 });
    const toggled = await page.evaluate(async () => {
        const { state } = window.__lucid;
        const statusText = () => document.getElementById('statusText').textContent;
        document.querySelector('.panel-tab[data-tab="tabVisibility"]').click();
        const el = document.getElementById('visSymmetryEdges');
        const flip = (on) => { el.checked = on; el.dispatchEvent(new Event('change', { bubbles: true })); };
        const saved = state.session.skeleton;
        state.session.skeleton = { nodes: ['Nose', 'Tail'], edges: [[0, 1]] };
        flip(true);
        const none = statusText();
        flip(false);
        state.session.skeleton = { nodes: ['Ear_L', 'Ear_R', 'Nose'], edges: [] };
        flip(true);
        const one = statusText();
        state.session.skeleton = saved;
        const w = document.getElementById('visSymmetryEdgeWeight');
        w.value = '3';
        w.dispatchEvent(new Event('input', { bubbles: true }));
        w.dispatchEvent(new Event('change', { bubbles: true }));
        const tab = document.getElementById('tabVisibility');
        return { none, one, overflow: tab.scrollWidth - tab.clientWidth, val: document.getElementById('visSymmetryEdgeWeightVal').textContent };
    });
    check(/no left\/right/.test(toggled.none), `a skeleton with no pairs says so ("${toggled.none}")`);
    check(/1 pair/.test(toggled.one), `one with a pair counts it ("${toggled.one}")`);
    check(toggled.val === '3', 'the slider shows its value');
    check(toggled.overflow <= 0, `the section fits the panel (overflow ${toggled.overflow} px)`);
    await page.reload();
    await ready();
    const restored = await page.evaluate(() => ({
        on: document.getElementById('visSymmetryEdges').checked,
        w: document.getElementById('visSymmetryEdgeWeight').value,
        label: document.getElementById('visSymmetryEdgeWeightVal').textContent,
    }));
    check(restored.on && restored.w === '3' && restored.label === '3', 'a reload restores the toggle and the weight');

    // ---- §6 export ----
    console.log('§6 Export Video Overlays');
    const seeded = await page.evaluate(async () => {
        localStorage.removeItem('overlayExportSettings.v1');
        const { settingsFromVisibilityPanel } = await import('/ui/overlay-export-modal.js');
        const { overlayOptionsFrom } = await import('/ui/overlay-export-layout.js');
        const s = settingsFromVisibilityPanel();
        const o = overlayOptionsFrom(s, 400, 200, 800, 400);
        await (await import('/pose/initialization.js')).loadDemoSession();
        document.getElementById('menuExportOverlayVideo').click();
        return { on: s.layers.symmetryEdges, w: s.symmetryEdgeWeight, optOn: o.showSymmetryEdges, optW: o.symmetryEdgeWeight };
    });
    check(seeded.on === true && seeded.w === 3, 'the export is seeded from the panel');
    check(seeded.optOn === true && seeded.optW === 6, `its weight scales with the output like other sizes (${seeded.optW} at 2×)`);
    await page.waitForSelector('#ovExportOverlay', { timeout: 10000 });
    const row = await page.evaluate(() => Array.from(document.querySelectorAll('#ovSettings label, #ovSettings div'))
        .some(el => el.textContent.trim() === 'Symmetry edges'));
    check(row, 'its Layers group offers it');

    check(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0].slice(0, 200) : ''}`);
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails ? `\n${fails} FAILED` : '\nPASSED');
process.exit(fails ? 1 : 0);
