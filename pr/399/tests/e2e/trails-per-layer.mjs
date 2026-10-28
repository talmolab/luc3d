/**
 * trails-per-layer.mjs — node trails attach to the nodes of whatever is being
 * displayed: Predictions and Reprojections each have their own trails, and
 * with both shown, both are drawn.
 *
 * Fixture: two synthetic animals walking across three calibrated cameras for
 * 12 frames (the rig of tests/e2e/track-all-switches-to-id.mjs, with skeleton
 * edges), run through the REAL Track All and Triangulate All buttons, so the
 * groups, identities, 3D points and reprojections are the app's own. Every
 * view is then drawn through the real `drawAllOverlays` onto a recording
 * canvas the size of the video, and the toolbar's Predictions / Reprojections
 * boxes are toggled as a user would.
 *
 * The trail strokes are told apart from the skeletons' by drawing the same
 * frame with trails off (trails draw first, behind everything), and every
 * trail segment's two ends are matched against the node positions of the
 * frames in the trail window:
 *  1. Reprojections only: every trail segment runs between REPROJECTED nodes
 *     (Triangulate All drops past frames' reprojection caches, so those come
 *     from the group's 3D points projected through the camera), and there is
 *     one per animal per node per age step.
 *  2. Predictions only: every trail segment runs between PREDICTED nodes.
 *  3. Both shown: both sets, each complete.
 *  4. Neither shown: no trails.
 *  5. No trail stroke in any of these is wider than its own layer's edges.
 *
 * Run: node tests/e2e/trails-per-layer.mjs   (SHOT_DIR=… saves both-shown)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerTrackSetup } from './fixtures/track-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8267);
const SHOT_DIR = process.env.SHOT_DIR || '';
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined && !c ? '  ' + JSON.stringify(extra).slice(0, 700) : ''));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await answerTrackSetup(page, 2);   // Track All asks for the animal count

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const NF = 12, CUR = 10, L = 6;
    await page.evaluate(async ({ NF }) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, FrameGroup, Session } = pd;
        const NODES = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
        const OFFSETS = [[0, 0, 0], [2, 1, 0], [-2, 1, 0], [0, -2, 1], [1.5, 0, -1.5], [-1.5, 0, 1.5]];
        const cam = (name, rvec, tvec) =>
            new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
        const CAMS = [cam('c0', [0, 0, 0], [0, 0, 0]), cam('c1', [0, 0.35, 0], [-12, 0, 3]), cam('c2', [0.35, 0, 0], [0, -12, 3])];
        const session = new Session(CAMS, new Skeleton('sk', NODES, [[0, 1], [0, 2], [0, 3]]), ['track_0', 'track_1'], 'TrailLayers');
        for (let f = 0; f < NF; f++) {
            const fg = new FrameGroup(f);
            // Small 2D noise so the triangulated 3D, and so the reprojections,
            // sit visibly apart from the predictions they came from.
            const jit = (c, k, n) => 0.6 * Math.sin(1.7 * f + 2.3 * k + 0.9 * n + c.name.charCodeAt(1));
            [[-7 + 0.5 * f, 0.2 * f, 48], [7 - 0.5 * f, -0.2 * f, 48]].forEach((ctr, ai) => CAMS.forEach(c =>
                fg.addInstance(c.name, new Instance(
                    OFFSETS.map((o, n) => {
                        const uv = c.project([ctr[0] + o[0], ctr[1] + o[1], ctr[2] + o[2]]);
                        return [uv[0] + jit(c, ai, n), uv[1] - jit(c, ai, n + 1)];
                    }), ai, 'predicted', 1.0))));
            session.addFrameGroup(fg);
        }
        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = NF;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = [];
    }, { NF });

    // ---- the app's own tracking + triangulation ---------------------------------
    const waitStatus = async (click, re) => {
        const before = await page.evaluate(() => document.getElementById('statusText').textContent);
        await page.click(click);
        await page.waitForFunction(({ b, re }) => {
            const t = document.getElementById('statusText').textContent;
            return t !== b && new RegExp(re, 'i').test(t);
        }, { b: before, re }, { timeout: 30000 });
    };
    await waitStatus('#tbTrackAll', 'Assigned \\d+ identities|error');
    await page.click('#trackSummaryClose', { timeout: 30000 });
    await waitStatus('#tbTriangulateAll', 'triangulated \\d+|error');
    const prep = await page.evaluate(() => {
        const s = window.__lucid.state.session;
        const groups = [...s.instanceGroups.values()].flat();
        return {
            identities: s.identities.length,
            groups: groups.length,
            with3d: groups.filter(g => g.points3d && g.points3d.some(v => Number.isFinite(v))).length,
        };
    });
    check(prep.identities === 2 && prep.groups === 2 * NF && prep.with3d === 2 * NF,
        `Track All + Triangulate All: 2 identities, ${2 * NF} groups, all triangulated`, prep);
    // The past frames of the trail window have NO cached reprojection — only the
    // frame on screen during Triangulate All does — so their reprojection trail
    // comes from the 3D points projected through the camera.
    const uncached = await page.evaluate(({ CUR, L }) => {
        const s = window.__lucid.state.session;
        let n = 0;
        for (let f = CUR - L; f < CUR; f++) for (const g of s.instanceGroups.get(f)) {
            if (!(g.reprojections && Object.keys(g.reprojections).length) && !(g.reprojectedInstances && g.reprojectedInstances.size)) n++;
        }
        return n;
    }, { CUR, L });
    check(uncached === 2 * L, `the ${2 * L} groups behind the current frame have no cached reprojection (${uncached})`);

    // Recording canvases for the three views, 640×480 like the video, so canvas
    // coordinates ARE video coordinates.
    await page.evaluate(({ CUR, L }) => {
        const st = window.__lucid.state;
        window.__rec = {};
        st.views = ['c0', 'c1', 'c2'].map(name => {
            const canvas = document.createElement('canvas');
            canvas.width = 640; canvas.height = 480;
            const ctx = canvas.getContext('2d');
            const segs = window.__rec[name] = [];
            let at = null, pending = [];
            const o = { clearRect: ctx.clearRect.bind(ctx), beginPath: ctx.beginPath.bind(ctx), moveTo: ctx.moveTo.bind(ctx),
                lineTo: ctx.lineTo.bind(ctx), stroke: ctx.stroke.bind(ctx) };
            ctx.clearRect = (...a) => { segs.length = 0; return o.clearRect(...a); };
            ctx.beginPath = () => { pending = []; return o.beginPath(); };
            ctx.moveTo = (x, y) => { at = [x, y]; return o.moveTo(x, y); };
            ctx.lineTo = (x, y) => { if (at) pending.push([at[0], at[1], x, y]); at = [x, y]; return o.lineTo(x, y); };
            ctx.stroke = (...a) => { segs.push({ w: ctx.lineWidth, s: pending.slice() }); return o.stroke(...a); };
            return { name, overlayCanvas: canvas, overlayCtx: ctx, videoWidth: 640, videoHeight: 480, zoom: { scale: 1 } };
        });
        st.currentFrame = CUR;
        st.trailLength = L;
    }, { CUR, L });

    const setBox = (id, on) => page.evaluate(({ id, on }) => {
        const el = document.getElementById(id);
        if (el.checked !== on) { el.checked = on; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }, { id, on });

    // Draw the current frame with trails off and on; the strokes the trail draw
    // has in FRONT of the trail-less one are the trails (drawn first). Then class
    // every trail segment by the node positions its two ends sit on.
    const measure = () => page.evaluate(async ({ CUR, L }) => {
        const r = await import('/ui/rendering.js');
        // Expected reprojections from the app's triangulation code — the cached
        // reprojection where a frame has one, else the 3D points through
        // `reprojectPointsCamera` — never from the overlay code under test.
        const { reprojectPointsCamera } = await import('/pose/triangulation.js');
        const st = window.__lucid.state, s = st.session;
        st.trailLength = 0; r.drawAllOverlays(CUR);
        const base = {};
        for (const v of st.views) base[v.name] = window.__rec[v.name].length;
        st.trailLength = L; r.drawAllOverlays(CUR);
        const out = { views: {}, edges: {} };
        const key = (x, y) => Math.round(x * 1000) + ',' + Math.round(y * 1000);
        for (const v of st.views) {
            const cam = s.cameras.find(c => c.name === v.name);
            const pred = new Set(), reproj = new Set();
            for (let f = CUR - L; f <= CUR; f++) {
                const fg = s.frameGroups.get(f);
                for (const u of fg.getUnlinkedInstances(v.name)) for (let n = 0; n < u.instance.numNodes; n++) pred.add(key(u.instance.getX(n), u.instance.getY(n)));
                for (const i of (fg.instances.get(v.name) || [])) for (let n = 0; n < i.numNodes; n++) pred.add(key(i.getX(n), i.getY(n)));
                for (const g of (s.instanceGroups.get(f) || [])) {
                    const pts = (g.reprojections && g.reprojections[v.name]) || reprojectPointsCamera(g.points3d, cam);
                    for (const p of pts) if (p) reproj.add(key(p[0], p[1]));
                }
            }
            const all = window.__rec[v.name];
            const trailStrokes = all.slice(0, all.length - base[v.name]);
            let onPred = 0, onReproj = 0, other = 0;
            const widths = { pred: [], reproj: [] };
            for (const st2 of trailStrokes) for (const sg of st2.s) {
                const a = key(sg[0], sg[1]), b = key(sg[2], sg[3]);
                if (pred.has(a) && pred.has(b)) { onPred++; widths.pred.push(st2.w); }
                else if (reproj.has(a) && reproj.has(b)) { onReproj++; widths.reproj.push(st2.w); }
                else other++;
            }
            out.views[v.name] = { onPred, onReproj, other, maxW: { pred: Math.max(0, ...widths.pred), reproj: Math.max(0, ...widths.reproj) } };
        }
        out.edges = {
            pred: parseInt(document.getElementById('visPredEdgeWeight').value),
            reproj: parseInt(document.getElementById('visReprojEdgeWeight').value),
        };
        return out;
    }, { CUR, L });

    // One segment per animal per node per age step: 2 × 6 × L.
    const FULL = 2 * 6 * L;
    const each = (m, f) => Object.keys(m.views).every(v => f(m.views[v]));

    // ---- 1. Reprojections only ------------------------------------------------------
    await setBox('visUser', false); await setBox('visPredicted', false); await setBox('visReprojections', true);
    let m = await measure();
    check(each(m, v => v.onReproj === FULL && v.onPred === 0 && v.other === 0),
        `1. Reprojections only: every trail segment runs between reprojected nodes, ${FULL} per view`, m.views);

    // ---- 2. Predictions only ----------------------------------------------------------
    await setBox('visPredicted', true); await setBox('visReprojections', false);
    m = await measure();
    check(each(m, v => v.onPred === FULL && v.onReproj === 0 && v.other === 0),
        `2. Predictions only: every trail segment runs between predicted nodes, ${FULL} per view`, m.views);

    // ---- 3. both ------------------------------------------------------------------------
    await setBox('visReprojections', true);
    m = await measure();
    check(each(m, v => v.onPred === FULL && v.onReproj === FULL && v.other === 0),
        `3. both shown: both sets of trails, each complete`, m.views);
    check(each(m, v => v.maxW.pred <= m.edges.pred && v.maxW.reproj <= m.edges.reproj),
        `5. no trail is wider than its own layer's edges (Predictions ${m.edges.pred}, Reprojections ${m.edges.reproj} px)`, { views: m.views, edges: m.edges });
    if (SHOT_DIR) {
        await page.evaluate(() => {
            const c = window.__lucid.state.views[0].overlayCanvas;
            const box = document.createElement('div');
            box.id = 'layersShot';
            box.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#3a3a3a;';
            box.appendChild(c);
            document.body.appendChild(box);
        });
        await page.locator('#layersShot').screenshot({ path: path.join(SHOT_DIR, 'trails-per-layer-both.png') });
        await page.evaluate(() => document.getElementById('layersShot').remove());
    }

    // ---- 4. neither ---------------------------------------------------------------------
    await setBox('visPredicted', false); await setBox('visReprojections', false);
    m = await measure();
    check(each(m, v => v.onPred + v.onReproj + v.other === 0), '4. neither shown: no trails', m.views);

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
