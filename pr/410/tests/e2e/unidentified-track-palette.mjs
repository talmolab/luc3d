/**
 * unidentified-track-palette.mjs — when coloring by Identity, a track is drawn
 * from UNIDENTIFIED_TRACK_COLORS (muted), never from Track mode's vivid
 * TRACK_COLORS, which sit on the identity colors' hues (track_4's green read as
 * id_0). Track mode keeps the vivid palette. In the real app.
 *
 * Fixture: two synthetic animals seen by three calibrated cameras (the rig of
 * tests/e2e/track-all-switches-to-id.mjs), plus a third detection, track_2,
 * seen by camera c0 only, so Track All (2 animals) leaves it without an
 * identity. Asserted after Track All, which switches coloring to Identity:
 *  1. track_2's name label, drawn by the real `drawFrameOverlays`, is in the
 *     muted palette.
 *  2. A GROUPED instance whose identity is removed labels itself in the muted
 *     palette too: the label takes its skeleton's color. Before, it fell back
 *     to drawInstanceLabels' Track-mode color.
 *  3. The timeline's track rows and the Visibility tab's track swatches are in
 *     the muted palette, switch to the vivid one on the Tracks button and back
 *     on the Identity button. Rows are recolored in place, not rebuilt.
 * Track mode's own canvas colors are covered by
 * tests/test-track-identity-palette.mjs §7 (predicted labels are drawn only in
 * Identity mode, so there is no Track-mode label to read here).
 *
 * Run: node tests/e2e/unidentified-track-palette.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerTrackSetup } from './fixtures/track-setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8267);
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
    await answerTrackSetup(page, 2);   // Track All asks for the animal count

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, FrameGroup, Session } = pd;
        const NODES = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'];
        const OFFSETS = [[0, 0, 0], [2, 1, 0], [-2, 1, 0], [0, -2, 1], [1.5, 0, -1.5], [-1.5, 0, 1.5]];
        const cam = (name, rvec, tvec) =>
            new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
        const CAMS = [cam('c0', [0, 0, 0], [0, 0, 0]), cam('c1', [0, 0.35, 0], [-12, 0, 3]), cam('c2', [0.35, 0, 0], [0, -12, 3])];
        const session = new Session(CAMS, new Skeleton('sk', NODES, []),
            ['track_0', 'track_1', 'track_2'], 'UnidentifiedTrackPalette');
        for (let f = 0; f < 4; f++) {
            const fg = new FrameGroup(f);
            [[-7 + 0.3 * f, 0, 48], [7 - 0.3 * f, 0, 48]].forEach((ctr, ai) => CAMS.forEach(c =>
                fg.addInstance(c.name, new Instance(
                    OFFSETS.map(o => c.project([ctr[0] + o[0], ctr[1] + o[1], ctr[2] + o[2]])), ai, 'predicted', 1.0))));
            // track_2: one camera only, so no cross-view support and no identity.
            fg.addInstance('c0', new Instance(
                OFFSETS.map(o => CAMS[0].project([o[0], 9 + o[1], 48 + o[2]])), 2, 'predicted', 1.0));
            session.addFrameGroup(fg);
        }
        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = 4;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = [];

        // Normalize any CSS color to '#rrggbb' through the canvas parser.
        const nctx = document.createElement('canvas').getContext('2d');
        window.__norm = (c) => { nctx.fillStyle = '#000000'; nctx.fillStyle = c; return nctx.fillStyle; };

        // Every name label drawn for camera `cam` on frame 0, as [{text, color}],
        // through the same drawFrameOverlays the views and the video export use.
        window.__labels = async (camName) => {
            const st = window.__lucid.state, s = st.session;
            const ov = await import('/ui/overlays.js');
            const vis = (await import('/ui/rendering.js')).getVisibilitySettings();
            const tri = await import('/pose/triangulation.js');
            const fg = s.frameGroups.get(0);
            const ofg = { frameIdx: 0, instances: {} };
            for (const [c, insts] of fg.instances) ofg.instances[c] = insts;
            const canvas = document.createElement('canvas');
            canvas.width = 640; canvas.height = 480;
            const ctx = canvas.getContext('2d');
            const out = [];
            const fillText = ctx.fillText.bind(ctx);
            ctx.fillText = (t, x, y, w) => { out.push({ text: String(t), color: ctx.fillStyle }); return fillText(t, x, y, w); };
            ov.drawFrameOverlays(ctx, camName, ofg, tri.getInstanceGroupsForFrame(0), s, {
                colorByIdentity: st.colorByIdentity,
                showUser: true, showPredicted: true, showReprojected: false,
                userOpts: vis.userOpts, predictedOpts: vis.predictedOpts, reprojOpts: vis.reprojOpts,
                videoWidth: 640, videoHeight: 480, canvasWidth: 640, canvasHeight: 480,
                unlinkedInstances: fg.getUnlinkedInstances(camName) || [],
            });
            return out;
        };

        // Which palette a color belongs to. Unlinked predictions draw their
        // label in desaturateColor(base, 0.15), so each palette also owns
        // those variants.
        window.__family = async (c) => {
            const ov = await import('/ui/overlays.js');
            const n = window.__norm(c);
            const owns = (pal) => pal.some(p => window.__norm(p) === n || window.__norm(ov.desaturateColor(p, 0.15)) === n);
            return owns(ov.UNIDENTIFIED_TRACK_COLORS) ? 'muted' : owns(ov.TRACK_COLORS) ? 'vivid' : 'other:' + n;
        };
    });

    // ---- Track All (switches coloring to Identity) ---------------------------------
    await page.click('#colorByTracks');
    const before = await page.evaluate(() => document.getElementById('statusText').textContent);
    await page.click('#tbTrackAll');
    await page.waitForFunction(b => {
        const t = document.getElementById('statusText').textContent;
        return t !== b && /Assigned \d+ identities|error/i.test(t);
    }, before, { timeout: 30000 });
    await page.click('#trackSummaryClose', { timeout: 30000 });
    const pre = await page.evaluate(() => {
        const s = window.__lucid.state.session;
        return {
            ids: s.identities.length, byId: !!window.__lucid.state.colorByIdentity,
            ghostId: s.getIdentityForTrack(2, 'c0', 0),
        };
    });
    check(pre.ids === 2 && pre.byId, `precondition: Track All assigned ${pre.ids} identities and colors by Identity`);
    check(!pre.ghostId, 'precondition: track_2 (one camera) has no identity on frame 0');

    // ---- 1. track_2's label ---------------------------------------------------------
    let labels = await page.evaluate(() => window.__labels('c0'));
    const ghost = labels.find(l => l.text === 'track_2');
    check(!!ghost, `track_2 is labelled in c0 (labels: ${JSON.stringify(labels.map(l => l.text))})`);
    if (ghost) {
        const fam = await page.evaluate(c => window.__family(c), ghost.color);
        check(fam === 'muted', `track_2's label is in the muted palette (${ghost.color}: ${fam})`);
    }
    const idLabels = labels.filter(l => /^id_/.test(l.text));
    check(idLabels.length === 2, `both animals are labelled by identity (${idLabels.map(l => l.text).join(', ')})`);

    // ---- 2. a grouped instance with its identity removed ------------------------------
    const stripped = await page.evaluate(async () => {
        const s = window.__lucid.state.session;
        const tri = await import('/pose/triangulation.js');
        const g = tri.getInstanceGroupsForFrame(0).find(gr => gr.instances.has('c0') && gr.instances.size > 1);
        if (!g) return null;
        for (const [cam, inst] of g.instances) s.deleteFrameIdentity(0, cam, inst.trackIdx);
        g.identityId = null;
        return { trackIdx: g.instances.get('c0').trackIdx };
    });
    check(!!stripped, 'found a group on frame 0 to strip of its identity');
    if (stripped) {
        labels = await page.evaluate(() => window.__labels('c0'));
        const name = 'track_' + stripped.trackIdx;
        const lab = labels.find(l => l.text === name);
        check(!!lab, `the stripped group's instance is labelled ${name}`);
        if (lab) {
            const fam = await page.evaluate(c => window.__family(c), lab.color);
            check(fam === 'muted', `and its label is in the muted palette, like its skeleton (${lab.color}: ${fam})`);
        }
    }

    // ---- 3. timeline rows and Visibility swatches follow the mode ----------------------
    const panels = () => page.evaluate(async () => {
        const tl = window.__lucid.timeline;
        const rows = (tl && tl._trackSegments || []).filter(r => r._isTrack && r._trackColored);
        const sw = Array.from(document.querySelectorAll('#visTimelineTracks .vis-color-swatch'))
            .map(e => e.style.background || e.style.backgroundColor);
        const fam = async (list) => { const o = []; for (const c of list) o.push(await window.__family(c)); return o; };
        return { rows: await fam(rows.map(r => r.color)), swatches: await fam(sw),
            sameRow: rows.length > 0 && rows[0] === window.__row0, nRows: rows.length };
    });
    await page.evaluate(async () => {
        (await import('/ui/info-panel.js')).populateTimelineVisibility(window.__lucid.state.session);
        const tl = window.__lucid.timeline;
        window.__row0 = (tl && tl._trackSegments || []).filter(r => r._isTrack && r._trackColored)[0];
    });
    const all = (arr, v) => arr.length > 0 && arr.every(x => x === v);
    let p = await panels();
    check(all(p.rows, 'muted'), `Identity mode: ${p.nRows} timeline track rows are muted (${p.rows.join(',')})`);
    check(all(p.swatches, 'muted'), `Identity mode: the Visibility track swatches are muted (${p.swatches.join(',')})`);
    await page.click('#colorByTracks');
    p = await panels();
    check(all(p.rows, 'vivid'), `Track mode: the rows turn vivid (${p.rows.join(',')})`);
    check(p.sameRow, 'recolored in place: the same row objects, not a rebuild');
    check(all(p.swatches, 'vivid'), `Track mode: the swatches turn vivid (${p.swatches.join(',')})`);
    await page.click('#colorById');
    p = await panels();
    check(all(p.rows, 'muted') && all(p.swatches, 'muted'), 'back on Identity: rows and swatches are muted again');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
