/**
 * node-trail-shade.mjs — the node-trail SHADE: how much darker or lighter than
 * its track a trail is drawn, so the skeleton on the current frame stands apart
 * from the history behind it (SLEAP 1.4's View ▸ Trail Shade).
 *
 * Asserted through the real menus and the real `drawAllOverlays` path:
 *  1. Both trail menus — the toolbar's Trails button and Tracks ▸ Node Trails —
 *     hold a Length group and, below it, a Shade group: Very dark / Dark /
 *     Normal / Light / Very light, darkest first, each with a sample swatch.
 *     Dark is the default and is checked in both. The length items are
 *     unchanged.
 *  2. With Dark, every trail segment the app strokes is exactly
 *     `trailColor(track color, 'dark', age)` — darker than its track.
 *  3. Picking Light from the toolbar redraws at once in the lighter colors,
 *     moves the checkmark in BOTH menus and names it in the status bar; a pick
 *     from Tracks ▸ Node Trails does the same the other way round. A shade
 *     pick leaves the trail length alone, and a length pick leaves the shade.
 *  4. The shade is remembered across a reload (localStorage — display taste,
 *     never written to the .slp), and an unrecognised stored value falls back
 *     to Dark.
 *  5. The overlay-video export starts from the app's shade, offers the same
 *     five in a "Trail shade" select, and a stored export shade this build
 *     does not offer falls back to Dark rather than leaving the select blank.
 *
 * Run: node tests/e2e/node-trail-shade.mjs   (SHOT_DIR=… saves the menu and a
 * comparison of the five shades over a dark and a light background)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8298);
const SHOT_DIR = process.env.SHOT_DIR || '';
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined && !c ? '  ' + JSON.stringify(extra).slice(0, 600) : ''));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const SHADES = ['Very dark', 'Dark', 'Normal', 'Light', 'Very light'];

let browser;
try {
    browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1700, height: 900 }, deviceScaleFactor: 2 });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.evaluate(() => { try { localStorage.removeItem('nodeTrailShade'); } catch (e) { /* none */ } });
    await page.reload();
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });

    const settleOpen = () => page.waitForTimeout(250);
    const settleClose = () => page.waitForTimeout(700);
    const awayFromMenu = () => page.mouse.move(400, 500);
    const menus = () => page.evaluate(() => {
        const read = (sel) => {
            const root = document.querySelector(sel);
            const items = (q) => [...root.querySelectorAll(q)].map(el => ({
                text: el.querySelector('.trail-label').textContent,
                on: el.querySelector('.trail-check').textContent === '✓',
                aria: el.getAttribute('aria-checked'),
                swatch: !!(el.querySelector('.trail-shade-swatch') &&
                    el.querySelector('.trail-shade-swatch').style.background.indexOf('linear-gradient') === 0),
            }));
            return {
                headings: [...root.querySelectorAll('.trail-menu-heading')].map(h => h.textContent),
                lengths: items('[data-trail-sec], [data-trail-custom]').map(i => i.text),
                shades: items('[data-trail-shade]'),
            };
        };
        return {
            toolbar: read('#trailsMenu'), menubar: read('#menuTrailsSubmenu'),
            shade: window.__lucid.state.trailShade, sec: window.__lucid.state.trailSeconds,
            status: document.getElementById('statusText').textContent,
        };
    });
    const checkedShade = (m) => ({
        toolbar: m.toolbar.shades.filter(s => s.on).map(s => s.text),
        menubar: m.menubar.shades.filter(s => s.on).map(s => s.text),
    });

    // ---- 1. both menus: Length, then Shade; Dark by default ----------------------
    let m = await menus();
    for (const which of ['toolbar', 'menubar']) {
        const g = m[which];
        check(JSON.stringify(g.headings) === '["Length","Shade"]', `${which}: a Length group, then a Shade group (${g.headings.join(', ')})`);
        check(JSON.stringify(g.shades.map(s => s.text)) === JSON.stringify(SHADES),
            `${which}: the shades are ${SHADES.join(' / ')}`, g.shades.map(s => s.text));
        check(g.shades.every(s => s.swatch), `${which}: every shade shows a sample swatch`);
        check(JSON.stringify(g.lengths) === JSON.stringify(['Off', '¼ second (8 frames)', '½ second (15 frames)',
            '1 second (30 frames)', '2 seconds (60 frames)', 'Custom…']), `${which}: the length items are unchanged`, g.lengths);
    }
    check(m.shade === 'dark', `the default shade is Dark (state.trailShade = "${m.shade}")`);
    let cs = checkedShade(m);
    check(JSON.stringify(cs) === '{"toolbar":["Dark"],"menubar":["Dark"]}', 'Dark is checked in both menus', cs);
    check(m.toolbar.shades.every(s => s.aria === (s.on ? 'true' : 'false')), 'aria-checked follows the checkmark');

    if (SHOT_DIR) {
        await page.hover('#tbTrails');
        await settleOpen();
        const box = await page.evaluate(() => {
            const b = document.getElementById('tbTrails').getBoundingClientRect();
            const r = document.getElementById('trailsMenu').getBoundingClientRect();
            return { x: Math.min(b.left, r.left) - 12, y: 0, width: Math.max(b.right, r.right) - Math.min(b.left, r.left) + 24, height: r.bottom + 12 };
        });
        await page.screenshot({ path: path.join(SHOT_DIR, 'node-trail-shade-menu.png'), clip: box });
        await awayFromMenu();
        await settleClose();
    }

    // ---- a session with trails, drawn through the real drawAllOverlays ------------
    // Two animals walk circles; every stroke on each view's overlay is recorded
    // from the frame's opening clearRect. Trails draw first (behind everything),
    // so a frame's first TRACKS × trailLength strokes are its trail segments.
    await page.evaluate(async () => {
        const { SioLazyLoader } = await import('/loading/sio-lazy-loader.js');
        const tri = await import('/pose/triangulation.js');
        const { Session } = await import('/pose/pose-data.js');
        const st = window.__lucid.state;
        const SIO = window.SleapIO;
        const NF = 300, W = 480, H = 320;
        const CAMS = ['camA'];
        const TRACKS = ['t0', 't1'];
        const NODES = ['nose', 'mid', 'tail'];
        const at = (f, k, n) => {
            const r = k ? 70 : 110, th = f * 0.05 + k * 2.4 - n * 0.22;
            return [W / 2 + r * Math.cos(th), H / 2 + r * Math.sin(th) * 0.8];
        };
        async function slpBytes(cam) {
            const skeleton = new SIO.Skeleton({ name: 'sk', nodes: NODES });
            const video = new SIO.Video({ filename: cam + '.mp4', shape: [NF, H, W, 1] });
            const tracks = TRACKS.map(n => new SIO.Track(n));
            const lfs = [];
            for (let f = 0; f < NF; f++) {
                const insts = tracks.map((track, k) => new SIO.PredictedInstance({
                    points: NODES.map((_, n) => at(f, k, n)), skeleton, track, score: 0.9 }));
                lfs.push(new SIO.LabeledFrame({ video, frameIdx: f, instances: insts }));
            }
            return SIO.saveSlpToBytes(new SIO.Labels({ skeletons: [skeleton], videos: [video], tracks, labeledFrames: lfs }));
        }
        const loader = new SioLazyLoader();
        await Promise.all(CAMS.map(async cam => loader.open(cam, new File([await slpBytes(cam)], cam + '.slp'))));
        const session = new Session([], { name: 'sk', nodes: NODES, edges: [[0, 1], [1, 2]] }, loader.trackNames.slice(), 'shade');
        session.lazyLoader = loader;
        st.sessions = [session];
        st.session = session;
        st.totalFrames = NF;
        st.triangulationResults = new Map();

        const rec = window.__shadeRec = {};
        window.__shadeViews = CAMS.map(cam => {
            const canvas = document.createElement('canvas');
            canvas.width = W; canvas.height = H;
            canvas.style.width = W + 'px';
            const ctx = canvas.getContext('2d');
            const strokes = rec[cam] = [];
            const clearRect = ctx.clearRect.bind(ctx), stroke = ctx.stroke.bind(ctx);
            ctx.clearRect = (...a) => { strokes.length = 0; return clearRect(...a); };
            ctx.stroke = (...a) => { strokes.push(String(ctx.strokeStyle).toLowerCase()); return stroke(...a); };
            return { name: cam, overlayCanvas: canvas, overlayCtx: ctx, videoWidth: W, videoHeight: H, zoom: { scale: 1 } };
        });
        st.views = window.__shadeViews;
        st.trailLength = 10;
        st.currentFrame = 100;
        await tri.batchLoadLazyFrames(60, 80);
    });

    // The trail strokes of the last draw, and what `trailColor` says they must be.
    const drawn = () => page.evaluate(async () => {
        const ov = await import('/ui/overlays.js');
        const st = window.__lucid.state;
        const f = st.currentFrame, L = st.trailLength, cam = 'camA';
        const fg = st.session.frameGroups.get(f);
        const tracks = fg.getUnlinkedInstances(cam).map(u => u.instance.trackIdx)
            .concat(((fg.instances.get && fg.instances.get(cam)) || []).map(i => i.trackIdx));
        const want = [];
        for (const t of tracks) for (let k = 1; k <= L; k++) want.push(ov.trailColor(ov.getTrackColor(t), st.trailShade, k / (L + 2)));
        const got = window.__shadeRec[cam].slice(0, want.length);
        const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
        const trackLum = Math.min(...tracks.map(t => lum(ov.getTrackColor(t))));
        const trackLumMax = Math.max(...tracks.map(t => lum(ov.getTrackColor(t))));
        return { shade: st.trailShade, tracks, want: want.slice().sort(), got: got.slice().sort(),
                 darker: got.every(h => lum(h) < trackLum), lighter: got.every(h => lum(h) > trackLumMax) };
    });
    const redraw = () => page.evaluate(async () => {
        const r = await import('/ui/rendering.js');
        r.drawAllOverlays(window.__lucid.state.currentFrame);
    });

    // ---- 2. Dark, drawn -----------------------------------------------------------
    await redraw();
    let d = await drawn();
    check(d.tracks.length === 2, `two animals on the frame (${d.tracks.length})`);
    check(JSON.stringify(d.got) === JSON.stringify(d.want), 'Dark: every trail segment is trailColor(track, "dark", age)', d);
    check(d.darker, 'Dark: every trail segment is darker than both tracks\' own colors');

    // ---- 3. picking a shade: toolbar, then Tracks ▸ Node Trails -------------------
    await page.hover('#tbTrails');
    await settleOpen();
    await page.click('#trailsMenu [data-trail-shade="light"]');
    m = await menus();
    cs = checkedShade(m);
    check(m.shade === 'light', `the toolbar's "Light" sets state.trailShade (got "${m.shade}")`);
    check(JSON.stringify(cs) === '{"toolbar":["Light"],"menubar":["Light"]}', 'and moves the checkmark in BOTH menus', cs);
    check(m.status === 'Node trail shade: Light', `the status bar names it (got "${m.status}")`);
    d = await drawn();   // no explicit redraw: the pick itself redraws
    check(JSON.stringify(d.got) === JSON.stringify(d.want) && d.lighter,
        'Light: the pick redraws at once, every trail segment lighter than its track', d);
    check(m.sec === 10 / 30, `a shade pick leaves the trail length alone (${m.sec} s)`);
    await awayFromMenu();
    await settleClose();

    await page.click('.menu-item[data-menu="tracks"]');
    await page.hover('#menuTrailsParent');
    await page.click('#menuTrailsShadeVeryDark');
    m = await menus();
    cs = checkedShade(m);
    check(m.shade === 'veryDark' && JSON.stringify(cs) === '{"toolbar":["Very dark"],"menubar":["Very dark"]}',
        'Tracks ▸ Node Trails ▸ Very dark sets it and moves the toolbar menu\'s checkmark', { shade: m.shade, cs });
    d = await drawn();
    check(JSON.stringify(d.got) === JSON.stringify(d.want) && d.darker, 'Very dark: drawn as trailColor(track, "veryDark", age)', d);

    await page.click('.menu-item[data-menu="tracks"]');
    await page.hover('#menuTrailsParent');
    await page.click('#menuTrailsSecond');
    m = await menus();
    check(m.shade === 'veryDark' && m.sec === 1, `a length pick leaves the shade alone (${m.shade}, ${m.sec} s)`);

    // Off: picking a shade says the trails are off rather than appearing to do nothing.
    await page.click('.menu-item[data-menu="tracks"]');
    await page.hover('#menuTrailsParent');
    await page.click('#menuTrailsOff');
    await page.click('.menu-item[data-menu="tracks"]');
    await page.hover('#menuTrailsParent');
    await page.click('#menuTrailsShadeNormal');
    m = await menus();
    check(m.status === 'Node trail shade: Normal (trails are off)', `with trails off the status says so (got "${m.status}")`);

    // ---- comparison picture: the five shades over a dark and a light floor --------
    if (SHOT_DIR) {
        await page.evaluate(async () => {
            const r = await import('/ui/rendering.js');
            const st = window.__lucid.state;
            st.trailLength = 20;
            const keys = ['veryDark', 'dark', 'normal', 'light', 'veryLight'];
            const names = ['Very dark', 'Dark (default)', 'Normal', 'Light', 'Very light'];
            const box = document.createElement('div');
            box.id = 'shadeShot';
            box.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#1b1b1f;padding:12px;display:grid;' +
                'grid-template-columns:repeat(5,auto);gap:10px;font:13px system-ui;color:#ddd;';
            for (const floor of ['#2e2e2e', '#bdbdbd']) {
                for (let i = 0; i < keys.length; i++) {
                    st.trailShade = keys[i];
                    r.drawAllOverlays(st.currentFrame);
                    const src = window.__shadeViews[0].overlayCanvas;
                    const cell = document.createElement('div');
                    const c = document.createElement('canvas');
                    c.width = src.width; c.height = src.height;
                    c.style.width = (src.width / 1.5) + 'px';
                    const g = c.getContext('2d');
                    g.fillStyle = floor; g.fillRect(0, 0, c.width, c.height);
                    g.drawImage(src, 0, 0);
                    const label = document.createElement('div');
                    label.textContent = names[i];
                    label.style.margin = '0 0 4px';
                    cell.appendChild(label); cell.appendChild(c);
                    box.appendChild(cell);
                }
            }
            document.body.appendChild(box);
        });
        await page.locator('#shadeShot').screenshot({ path: path.join(SHOT_DIR, 'node-trail-shade-compare.png') });
        await page.evaluate(() => document.getElementById('shadeShot').remove());
    }

    // ---- 5. the overlay-video export --------------------------------------------
    const ex = await page.evaluate(async () => {
        const mod = await import('/ui/overlay-export-modal.js');
        const L = await import('/ui/overlay-export-layout.js');
        const st = window.__lucid.state;
        st.trailShade = 'light';
        const seeded = mod.settingsFromVisibilityPanel().trailShade;
        localStorage.setItem(L.SETTINGS_KEY, JSON.stringify({ trailShade: 'sepia' }));
        const fallback = mod.loadOverlayExportSettings().trailShade;
        localStorage.setItem(L.SETTINGS_KEY, JSON.stringify({ trailShade: 'veryLight' }));
        const stored = mod.loadOverlayExportSettings().trailShade;
        localStorage.removeItem(L.SETTINGS_KEY);
        return { seeded, fallback, stored };
    });
    check(ex.seeded === 'light', `the export starts from the app's shade (${ex.seeded})`);
    check(ex.stored === 'veryLight', `a shade stored by the export is remembered (${ex.stored})`);
    check(ex.fallback === 'dark', `a stored export shade this build does not offer falls back to Dark (${ex.fallback})`);

    await page.evaluate(async () => {
        const mod = await import('/ui/overlay-export-modal.js');
        mod.showOverlayExportModal();
    });
    await page.waitForSelector('#ovTrailShade', { timeout: 20000 });
    const sel = await page.evaluate(() => {
        const s = document.getElementById('ovTrailShade');
        return { value: s.value, options: [...s.options].map(o => o.textContent) };
    });
    check(JSON.stringify(sel.options) === JSON.stringify(SHADES), `the export's Trail shade select offers ${SHADES.join(' / ')}`, sel.options);
    check(sel.value === 'light', `and opens on the app's shade (${sel.value})`);
    await page.keyboard.press('Escape');

    // ---- 4. remembered across a reload --------------------------------------------
    await page.evaluate(() => localStorage.setItem('nodeTrailShade', 'veryLight'));
    await page.reload();
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 60000 });
    m = await menus();
    cs = checkedShade(m);
    check(m.shade === 'veryLight' && JSON.stringify(cs) === '{"toolbar":["Very light"],"menubar":["Very light"]}',
        'after a reload the remembered shade is restored and checked in both menus', { shade: m.shade, cs });
    await page.evaluate(() => localStorage.setItem('nodeTrailShade', 'sepia'));
    await page.reload();
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 60000 });
    m = await menus();
    check(m.shade === 'dark', `an unrecognised stored shade falls back to Dark (${m.shade})`);
    await page.evaluate(() => localStorage.removeItem('nodeTrailShade'));

    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
