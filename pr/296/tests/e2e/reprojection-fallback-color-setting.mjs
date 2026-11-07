/**
 * reprojection-fallback-color-setting.mjs — real-browser regression test for
 * luc3d#209.
 *
 * Bug: bulk sweeps ("Triangulate All" — the path Bundle Adjustment is
 * normally run through) populate a group's raw `reprojections` without ever
 * materializing `reprojectedInstances` (pose/triangulation.js
 * triangulateAllFrames, for memory reasons over a whole project). When a
 * group is in that state, `drawFrameOverlays` (ui/overlays.js) takes its
 * "fall back to raw reprojection data" branch — and that branch referenced
 * `reprojXColor`, a `var` declared only inside the SIBLING `if (reprojInst)`
 * branch above it. Being `var` (function-scoped) it existed but was never
 * assigned in the `else` branch, so it was `undefined` there, and
 * `drawReprojectedSkeleton`'s `options.color || '#ff6b6b'` fallback silently
 * hardcoded every such reprojection's node color to '#ff6b6b' — ignoring the
 * Visibility panel's Reprojections color setting (white/black/track)
 * entirely. Because '#ff6b6b' is also TRACK_COLORS[0] ("red"), this read
 * exactly like "reprojections are forced into track color, overriding the
 * panel" and, combined with `ui/rendering.js`'s lazy fill toggling a group
 * in and out of the "has reprojectedInstances" state across redraws,
 * produced a red/white flash as the user scrubbed through BA-triangulated
 * frames.
 *
 * Fix: hoist the color computation out of the `if` so both branches share
 * the same, correctly-scoped `reprojXColor`.
 *
 * Also covers the 'dark' setting (the track color in the Dark trail shade), on
 * both branches, and its button and export menu.
 *
 * Run: node reprojection-fallback-color-setting.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8098);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', msg => { if (msg.type() === 'error') console.log('  [console.error]', msg.text().slice(0, 300)); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    const r = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const overlays = await import('/ui/overlays.js');
        const { InstanceGroup } = pd;

        // A group in exactly the state a bulk "Triangulate All" sweep leaves
        // it in: raw `reprojections` populated, `reprojectedInstances` never
        // materialized (still the empty Map from the constructor).
        const group = new InstanceGroup(1, -1);
        group.reprojections = { camA: [[10, 10], [20, 20]] };
        const skeleton = { nodes: [{}, {}], edges: [[0, 1]] };

        function drawWith(reprojNodeColor) {
            const canvas = document.createElement('canvas');
            canvas.width = 200; canvas.height = 200;
            const ctx = canvas.getContext('2d');
            const recorded = [];
            const proto = CanvasRenderingContext2D.prototype;
            for (const prop of ['fillStyle', 'strokeStyle']) {
                const desc = Object.getOwnPropertyDescriptor(proto, prop);
                Object.defineProperty(ctx, prop, {
                    get() { return desc.get.call(this); },
                    set(v) { recorded.push({ prop, v }); desc.set.call(this, v); },
                });
            }
            overlays.drawFrameOverlays(ctx, 'camA', null, [group], null, {
                showReprojected: true,
                reprojNodeColor,
            });
            // The default 'circle' node marker fills with `fillStyle` (see
            // drawNodeShape's 'circle' case) — that is the reprojection-node
            // color the Visibility panel setting controls. `strokeStyle` is
            // also used for the (deliberately track-colored, by design) edge
            // lines, so it's excluded here to isolate the marker color.
            return recorded.filter(r => r.prop === 'fillStyle' && typeof r.v === 'string' && r.v.startsWith('#')).map(r => r.v);
        }

        // Node and edge colors for 'dark'/'track' on either branch, at a Brightness.
        function colorsOf(reprojNodeColor, brightness, materialized) {
            const g = new InstanceGroup(1, -1);
            if (materialized) {
                g.addReprojectedInstance('camA', new pd.Instance([[10, 10], [20, 20]], 0, 'reprojected', 1));
            } else {
                g.reprojections = { camA: [[10, 10], [20, 20]] };
            }
            const canvas = document.createElement('canvas');
            canvas.width = 200; canvas.height = 200;
            const ctx = canvas.getContext('2d');
            const fills = [], strokes = [];
            const proto = CanvasRenderingContext2D.prototype;
            for (const [prop, list] of [['fillStyle', fills], ['strokeStyle', strokes]]) {
                const desc = Object.getOwnPropertyDescriptor(proto, prop);
                Object.defineProperty(ctx, prop, {
                    get() { return desc.get.call(this); },
                    set(v) { list.push(v); desc.set.call(this, v); },
                });
            }
            overlays.drawFrameOverlays(ctx, 'camA', null, [g], { skeleton, tracks: [] }, {
                showReprojected: true,
                reprojNodeColor,
                reprojOpts: { nodeSize: 4, lineWidth: 2, alpha: 1, brightness, showLabels: false, nodeStyle: 'circle', lineStyle: 'solid' },
            });
            return { node: fills[fills.length - 1], edge: strokes[strokes.length - 1] };
        }
        const dark = {};
        for (const materialized of [false, true]) for (const brightness of [0.5, 1]) {
            const key = (materialized ? 'instance' : 'raw') + '@' + brightness;
            const c = colorsOf('dark', brightness, materialized);
            dark[key] = { ...c, expected: overlays.trailColor(c.edge, 'dark') };
        }

        return {
            black: drawWith('black'),
            white: drawWith('white'),
            dark,
            track: colorsOf('track', 0.5, false),
        };
    });

    console.log('  measured:', JSON.stringify(r));
    const BUG_COLOR = '#ff6b6b';
    check(r.black.includes('#000000'), `reprojNodeColor:'black' draws a #000000 marker (got ${JSON.stringify(r.black)})`);
    check(!r.black.includes(BUG_COLOR), `reprojNodeColor:'black' does NOT fall back to the hardcoded bug color ${BUG_COLOR} (got ${JSON.stringify(r.black)})`);
    check(r.white.includes('#ffffff'), `reprojNodeColor:'white' draws a #ffffff marker (got ${JSON.stringify(r.white)})`);
    check(!r.white.includes(BUG_COLOR), `reprojNodeColor:'white' does NOT fall back to the hardcoded bug color ${BUG_COLOR} (got ${JSON.stringify(r.white)})`);

    for (const [key, c] of Object.entries(r.dark)) {
        check(c.node === c.expected && c.node !== c.edge,
            `'dark' (${key}) draws the edge color in the Dark trail shade (${c.edge} → ${c.node})`);
    }
    check(r.track.node === r.track.edge, `'track' still matches its edges (${r.track.node})`);

    // The panel row: picks it, fits, survives a reload.
    const row = () => page.evaluate(() => {
        const el = document.getElementById('visReprojNodeColor');
        const active = el.querySelector('.line-style-btn.active');
        return { value: el.getAttribute('data-value'), active: active && active.getAttribute('data-style') };
    });
    const picked = await page.evaluate(async () => {
        document.querySelector('.panel-tab[data-tab="tabVisibility"]').click();
        document.querySelector('#visReprojNodeColor [data-style="dark"]').click();
        const { getVisibilitySettings } = await import('/ui/rendering.js');
        const tab = document.getElementById('tabVisibility');
        return {
            setting: getVisibilitySettings().reprojNodeColor,
            overflow: tab.scrollWidth - tab.clientWidth,
            inside: document.querySelector('#visReprojNodeColor [data-style="dark"]').getBoundingClientRect().right
                <= tab.getBoundingClientRect().right,
        };
    });
    check(picked.setting === 'dark', 'the Dark button sets it');
    check(picked.overflow <= 0 && picked.inside, `the row fits the default panel width (overflow ${picked.overflow} px)`);
    await page.reload();
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    const restored = await row();
    check(restored.value === 'dark' && restored.active === 'dark', 'a reload restores it, with the button lit');

    // Export Video Overlays: seeded with it, and its menu can show it.
    const exp = await page.evaluate(async () => {
        const { settingsFromVisibilityPanel } = await import('/ui/overlay-export-modal.js');
        const seeded = settingsFromVisibilityPanel().reproj.nodeColor;
        await (await import('/pose/initialization.js')).loadDemoSession();   // the modal needs a project
        document.getElementById('menuExportOverlayVideo').click();
        return seeded;
    });
    check(exp === 'dark', 'the export is seeded with it');
    await page.waitForSelector('#ovExportOverlay', { timeout: 10000 });
    const menu = await page.evaluate(() => {
        const sel = Array.from(document.querySelectorAll('#ovSettings select'))
            .find(x => ['white', 'track'].every(v => Array.from(x.options).some(o => o.value === v)));
        return sel ? { value: sel.value, offers: Array.from(sel.options).some(o => o.value === 'dark') } : null;
    });
    check(menu && menu.offers && menu.value === 'dark', `its Marker color menu offers it and shows it selected (${JSON.stringify(menu)})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
