/**
 * edge-style-wedge.mjs — the "wedge" edge style (SLEAP's View > Edge Style > Wedge).
 *
 * A wedge is a triangle: its base on the edge's source node, half the node radius
 * wide on each side, and its tip on the destination, filled at half opacity and
 * outlined in the full colour. Everything here reads real canvas pixels, because
 * the failure modes are visual: a tip at the wrong end, wedges that darken or
 * punch holes where they cross, a width that ignores the type's node size.
 *
 *  1. Every edge-style row in the Visibility panel offers it, and it persists.
 *  2. The shape: wide at the source, tip at the destination, half-opacity fill.
 *  3. Overlaps fill evenly whichever way the crossing edges point.
 *  4. Reprojections (both paths), unlinked instances and the selection highlight
 *     draw wedges too, each with its own type's node size.
 *  5. Solid edges are pixel-identical to a plain stroked line.
 *  6. A click on the wide part of a wedge hits the instance; with lines it doesn't.
 *  7. Export Video Overlays is seeded with it and offers it.
 *
 * Run: PORT=<free port> node tests/e2e/edge-style-wedge.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8197);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const ROWS = ['visUserPreLineStyle', 'visUserPostLineStyle', 'visPredPreLineStyle',
    'visPredPostLineStyle', 'visReprojLineStyle'];

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    // ---- §1 the panel ----
    console.log('§1 Visibility panel');
    const pickWedge = async (id) => page.evaluate((rowId) => {
        const btn = document.querySelector('#' + rowId + ' .line-style-btn[data-style="wedge"]');
        if (!btn) return null;
        btn.click();
        return document.getElementById(rowId).getAttribute('data-value');
    }, id);
    for (const id of ROWS) check(await pickWedge(id) === 'wedge', `${id} has a Wedge button that selects it`);
    const seenBySettings = await page.evaluate(async () => {
        const { getVisibilitySettings } = await import('/ui/rendering.js');
        const v = getVisibilitySettings();
        return [v.userOpts.preLineStyle, v.userOpts.postLineStyle, v.predictedOpts.preLineStyle,
            v.predictedOpts.postLineStyle, v.reprojOpts.lineStyle];
    });
    check(seenBySettings.every(s => s === 'wedge'), `getVisibilitySettings reports all five (${seenBySettings})`);
    await page.reload();
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    const restored = await page.evaluate((rows) => rows.map(id => {
        const el = document.getElementById(id);
        const active = el.querySelector('.line-style-btn.active');
        return [el.getAttribute('data-value'), active && active.getAttribute('data-style')];
    }), ROWS);
    check(restored.every(r => r[0] === 'wedge' && r[1] === 'wedge'), 'a reload restores all five, with the button lit');
    const fit = await page.evaluate((rows) => {
        document.querySelector('.panel-tab[data-tab="tabVisibility"]').click();
        const tab = document.getElementById('tabVisibility');
        const right = tab.getBoundingClientRect().right;
        return {
            overflow: tab.scrollWidth - tab.clientWidth,
            inside: rows.every(id => document.querySelector('#' + id + ' [data-style="wedge"]')
                .getBoundingClientRect().right <= right),
        };
    }, ROWS);
    check(fit.overflow <= 0 && fit.inside, `all four buttons fit the default panel width (overflow ${fit.overflow} px)`);

    // Pixel helpers shared by §2-§5. Everything is drawn on a 200x100 canvas with
    // no video transform, so canvas coordinates are the coordinates passed in.
    await page.evaluate(async () => {
        const overlays = await import('/ui/overlays.js');
        const { Instance, UnlinkedInstance } = await import('/pose/pose-data.js');
        window.T = {
            overlays,
            Instance,
            UnlinkedInstance,
            canvas() {
                const c = document.createElement('canvas');
                c.width = 200; c.height = 100;
                return c.getContext('2d', { willReadFrequently: true });
            },
            // Opaque-pixel run length in the column x (how wide the shape is there).
            columnExtent(ctx, x) {
                const d = ctx.getImageData(x, 0, 1, 100).data;
                let n = 0;
                for (let y = 0; y < 100; y++) if (d[y * 4 + 3] > 0) n++;
                return n;
            },
            alphaAt(ctx, x, y) { return ctx.getImageData(x, y, 1, 1).data[3]; },
            inst(pts) { return new Instance(pts, 0, 'user', 1); },
            SKEL: { nodes: ['a', 'b'], edges: [[0, 1]] },
        };
    });

    // ---- §2 the shape ----
    console.log('§2 Shape');
    const shape = await page.evaluate(() => {
        const { overlays, canvas, inst, SKEL, columnExtent, alphaAt } = window.T;
        const draw = (edges, style) => {
            const ctx = canvas();
            overlays.drawSkeleton(ctx, inst([[20, 50], [180, 50]]), { nodes: SKEL.nodes, edges },
                { color: '#ff0000', nodeSize: 20, lineWidth: 1, lineStyle: style, showNodes: false });
            return ctx;
        };
        const fwd = draw([[0, 1]], 'wedge');
        const rev = draw([[1, 0]], 'wedge');
        const line = draw([[0, 1]], 'solid');
        return {
            nearSrc: columnExtent(fwd, 25), mid: columnExtent(fwd, 100), nearDst: columnExtent(fwd, 175),
            revNearSrc: columnExtent(rev, 175), revNearDst: columnExtent(rev, 25),
            lineNearSrc: columnExtent(line, 25), lineNearDst: columnExtent(line, 175),
            fillAlpha: alphaAt(fwd, 60, 50),
            half: overlays.wedgeHalfWidth(20),
            dash: overlays.getLineDashPattern('wedge').length,
        };
    });
    check(shape.half === 10, `half-width is half the node radius (${shape.half} for a radius of 20)`);
    check(shape.nearSrc >= 19 && shape.nearSrc <= 22, `about 2 × half-width wide at the source (${shape.nearSrc} px)`);
    check(shape.mid >= 10 && shape.mid <= 13, `half that at the middle (${shape.mid} px)`);
    check(shape.nearDst <= 4, `a tip at the destination (${shape.nearDst} px)`);
    check(shape.revNearSrc === shape.nearSrc && shape.revNearDst === shape.nearDst,
        'reversing the edge reverses the wedge');
    check(shape.lineNearSrc === shape.lineNearDst, `a solid line stays one width (${shape.lineNearSrc} px)`);
    check(Math.abs(shape.fillAlpha - 128) <= 2, `filled at half opacity (alpha ${shape.fillAlpha})`);
    check(shape.dash === 0, 'no dash pattern on the outline');

    // ---- §3 overlaps ----
    console.log('§3 Overlaps');
    const overlap = await page.evaluate(() => {
        const { overlays, canvas, inst, alphaAt } = window.T;
        // Two wedges lying over each other, pointing opposite ways: a mixed
        // winding would cancel to a hole, and separate fills would darken.
        const ctx = canvas();
        overlays.drawSkeleton(ctx, inst([[20, 50], [180, 50], [180, 50], [20, 50]]),
            { nodes: ['a', 'b', 'c', 'd'], edges: [[0, 1], [2, 3]] },
            { color: '#ff0000', nodeSize: 20, lineWidth: 1, lineStyle: 'wedge', showNodes: false });
        return { center: alphaAt(ctx, 100, 50) };
    });
    check(Math.abs(overlap.center - 128) <= 2, `crossing wedges fill once, no hole or double fill (alpha ${overlap.center})`);

    // ---- §4 other draw paths ----
    console.log('§4 Other draw paths');
    const paths = await page.evaluate(() => {
        const { overlays, canvas, inst, SKEL, columnExtent, UnlinkedInstance } = window.T;
        const reproj = canvas();
        overlays.drawReprojectedSkeleton(reproj, [[20, 50], [180, 50]], SKEL,
            { color: '#fff', edgeColor: '#00ff00', nodeSize: 20, lineWidth: 1, lineStyle: 'wedge', showNodes: false, alpha: 1 });
        const reprojNoStyle = canvas();
        overlays.drawReprojectedSkeleton(reprojNoStyle, [[20, 50], [180, 50]], SKEL,
            { color: '#fff', edgeColor: '#00ff00', nodeSize: 20, lineWidth: 1, showNodes: false });

        // Unlinked: a prediction takes the predicted node size and pre-ID style,
        // a user instance the user ones. nodeShape is drawn too, so measure away
        // from the nodes (x=50) where only the edge is.
        const ul = (type, lineStyle, predStyle) => {
            const ctx = canvas();
            const i = inst([[20, 50], [180, 50]]);
            i.type = type;
            overlays.drawUnlinkedInstances(ctx, [new UnlinkedInstance(i, 'cam', 'u1')], SKEL, {
                nodeSize: 20, lineWidth: 1, lineStyle, showLabels: false, showUnlinkedBadge: false,
                predictedRender: { nodeSize: 40, lineWidth: 1, lineStyle: predStyle, nodeStyle: 'circle' },
                session: { skeleton: SKEL, tracks: [] }, frameIdx: 0,
            });
            return ctx;
        };
        const ulUser = ul('user', 'wedge', 'solid');
        const ulPred = ul('predicted', 'solid', 'wedge');
        const ulSolid = ul('user', 'solid', 'solid');

        const sel = (opts) => {
            const ctx = canvas();
            overlays.drawSelectionHighlight(ctx, [[20, 50], [180, 50]], SKEL, Object.assign(
                { color: '#ffffff', nodeSize: 2, lineWidth: 1 }, opts));
            return ctx;
        };
        return {
            reprojSrc: columnExtent(reproj, 25), reprojDst: columnExtent(reproj, 175),
            reprojNoStyleSrc: columnExtent(reprojNoStyle, 40), reprojNoStyleDst: columnExtent(reprojNoStyle, 160),
            ulUser: columnExtent(ulUser, 50), ulPred: columnExtent(ulPred, 50), ulSolid: columnExtent(ulSolid, 50),
            selWedge: columnExtent(sel({ lineStyle: 'wedge', wedgeNodeSize: 40 }), 50),
            selOwnSize: columnExtent(sel({ lineStyle: 'wedge' }), 50),
            selLine: columnExtent(sel({}), 50),
        };
    });
    check(paths.reprojSrc > paths.reprojDst + 10, `reprojection fallback path draws a wedge (${paths.reprojSrc} → ${paths.reprojDst} px)`);
    check(paths.reprojNoStyleSrc <= 3 && paths.reprojNoStyleDst <= 3, 'with no style passed it keeps its thin dashed line');
    check(paths.ulUser > paths.ulSolid + 5, `unlinked user instance: pre-ID wedge (${paths.ulUser} px vs ${paths.ulSolid} solid)`);
    check(paths.ulPred > paths.ulUser + 5, `unlinked prediction: wedge at the predicted node size (${paths.ulPred} px vs ${paths.ulUser})`);
    check(paths.selWedge > 20, `selection highlight retraces the wedge at the instance's size (${paths.selWedge} px)`);
    check(paths.selOwnSize < paths.selWedge, 'and that size comes from wedgeNodeSize, not the highlight node size');
    // 2 px of edge plus the 2 px top and bottom of the selection's dashed box.
    check(paths.selLine <= 6, `selection on line edges stays a thin line (${paths.selLine} px, box included)`);

    // ---- §5 lines unchanged ----
    console.log('§5 Lines unchanged');
    const same = await page.evaluate(() => {
        const { overlays, canvas, inst, SKEL } = window.T;
        const ctx = canvas();
        overlays.drawSkeleton(ctx, inst([[20, 30], [180, 70]]), SKEL,
            { color: '#ff0000', nodeSize: 20, lineWidth: 3, lineStyle: 'solid', showNodes: false });
        const ref = canvas();
        ref.lineWidth = 3; ref.lineCap = 'round'; ref.strokeStyle = '#ff0000';
        ref.beginPath(); ref.moveTo(20, 30); ref.lineTo(180, 70); ref.stroke();
        const a = ctx.getImageData(0, 0, 200, 100).data, b = ref.getImageData(0, 0, 200, 100).data;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    });
    check(same, 'a solid edge is pixel-identical to a plain stroked line');

    // ---- §6 hit test ----
    console.log('§6 Clicking a wedge');
    await page.evaluate(async () => {
        await (await import('/pose/initialization.js')).loadDemoSession();
    });
    await page.waitForFunction(() => window.__lucid.state.session && window.__lucid.interactionManager, null, { timeout: 60000 });
    const hit = await page.evaluate(() => {
        const { state, interactionManager: im } = window.__lucid;
        const { Instance } = window.T;
        const s = state.session;
        const cam = s.cameras[0].name;
        const edge = s.skeleton.edges[0];
        const nN = s.skeleton.nodes.length;
        // Far apart and off the other nodes, so only this one edge can be hit.
        const pts = Array.from({ length: nN }, () => null);
        pts[edge[0]] = [100, 300]; pts[edge[1]] = [500, 300];
        const inst = new Instance(pts, 0, 'user', 1);
        const groups = [{ getInstance: (v) => (v === cam ? inst : null), instances: new Map([[cam, inst]]) }];
        const realGet = im._getInstanceGroups;
        im._getInstanceGroups = () => groups;
        const size = document.getElementById('visUserNodeSize');
        const savedSize = size.value;
        size.value = '50';
        // 60 px along, 18 px off the axis: past the node, inside a half-width of
        // 25 × (1 − 60/400) = 21.25, but well off a thin line.
        const off = () => im.findNearestNode(160, 318, cam, 0);
        // And far outside it even as a wedge.
        const outside = () => im.findNearestNode(160, 360, cam, 0);
        const row = document.getElementById('visUserPostLineStyle');
        const savedStyle = row.getAttribute('data-value');
        const wedgeHit = off();
        const wedgeOutside = outside();
        row.setAttribute('data-value', 'solid');
        const lineHit = off();
        row.setAttribute('data-value', savedStyle);
        size.value = savedSize;
        im._getInstanceGroups = realGet;
        return { wedge: !!wedgeHit, wedgeEdge: wedgeHit && wedgeHit.nodeIdx, outside: !!wedgeOutside, line: !!lineHit };
    });
    check(hit.wedge && hit.wedgeEdge === -1, 'a click inside the wide part of a wedge hits the edge');
    check(!hit.outside, 'a click well outside it does not');
    check(!hit.line, 'the same click misses when the edges are lines');

    // ---- §7 export ----
    console.log('§7 Export Video Overlays');
    const seeded = await page.evaluate(async () => {
        localStorage.removeItem('overlayExportSettings.v1');
        const { settingsFromVisibilityPanel } = await import('/ui/overlay-export-modal.js');
        const s = settingsFromVisibilityPanel();
        return [s.user.lineStyle, s.pred.lineStyle, s.reproj.lineStyle];
    });
    check(seeded.every(v => v === 'wedge'), `the export is seeded with it (${seeded})`);
    await page.evaluate(() => document.getElementById('menuExportOverlayVideo').click());
    await page.waitForSelector('#ovExportOverlay', { timeout: 10000 });
    const selects = await page.evaluate(() => Array.from(document.querySelectorAll('#ovSettings select'))
        .filter(sel => Array.from(sel.options).some(o => o.value === 'dotted'))
        .map(sel => ({ value: sel.value, offersWedge: Array.from(sel.options).some(o => o.value === 'wedge') })));
    check(selects.length === 3 && selects.every(s => s.offersWedge), `all ${selects.length} of its Line style menus offer wedge`);
    check(selects.every(s => s.value === 'wedge'), 'and show it selected, not blank');

    check(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0].slice(0, 200) : ''}`);
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails ? `\n${fails} FAILED` : '\nPASSED');
process.exit(fails ? 1 : 0);
