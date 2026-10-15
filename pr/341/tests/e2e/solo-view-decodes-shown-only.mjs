/**
 * solo-view-decodes-shown-only.mjs — with one camera solo'd (or panes closed),
 * stepping, playback and overlay drawing touch ONLY the views on screen.
 *
 * Every view keeps a decoder whether or not it is docked, and the controller
 * used to decode, play and capture all of them regardless: on an 17-camera,
 * 120 fps project, solo'ing one camera left jumps at ~2 s, single steps at
 * ~170 ms and playback at ~11 new pictures/s — exactly the numbers of the full
 * grid. `VideoController._shownViews` (fed `isViewDocked`) now limits that work
 * to docked views. Skipping a view is only safe if docking it again never
 * shows a stale picture, so the redraws are asserted pixel by pixel:
 *
 *  1. Grid: a step decodes every view, and every canvas shows the new frame.
 *  2. Solo: steps decode the solo view ONLY, and overlays are drawn on it only.
 *  3. Switching the solo view (Down) shows the CURRENT frame on the newly
 *     docked camera, which was never decoded while it was hidden.
 *  4. `g` restores the grid with every canvas on the current frame.
 *  5. Playback while solo plays only the solo view's <video>; switching the
 *     solo view DURING playback restarts it on the new view (the old one
 *     pauses, the new one plays) instead of painting a paused <video>.
 *  6. Closing every pane but one in GRID mode behaves like solo (the rule is
 *     "docked", not "solo mode").
 *  7. (within 2) The views that went off screen release their decoded frames
 *     ONCE (`releaseFrames`); the solo view keeps its own.
 *
 * Fake decoders paint frame f as rgb(f % 256, 40 * viewIndex, 7), so a canvas'
 * pixel says which frame — and whose — it shows.
 *
 * Run: node solo-view-decodes-shown-only.mjs   (spawns its own http.server)
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

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;   // absent demo assets
        console.log('  [console.error]', t.slice(0, 300));
        fails++;
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const CAMS = ['camA', 'camB', 'camC', 'camD'];

    // A 4-camera session in grid mode, every view backed by a fake decoder.
    await page.evaluate(async (camNames) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const { Skeleton, Camera, Session } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const cams = camNames.map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [640, 480]));
        const session = new Session(cams, skel, ['track_0'], 'S1');

        const N = 300;
        function fakeDecoder(vi) {
            const src = document.createElement('canvas');
            src.width = 64; src.height = 48;
            const sctx = src.getContext('2d');
            const d = {
                samples: new Array(N), _fps: 30, _videoReady: true,
                calls: [], playing: false, pos: 0, released: 0,
                async getFrame(f) {
                    d.calls.push(f);
                    sctx.fillStyle = `rgb(${f % 256},${40 * vi},7)`;
                    sctx.fillRect(0, 0, 64, 48);
                    return createImageBitmap(src);
                },
                drawCurrentFrame() { return false; },
                getCurrentFrameIndex() { return d.pos; },
                seekNativeSettled(f) { d.pos = f; return Promise.resolve(); },
                playNative() { d.playing = true; },
                pauseNative() { d.playing = false; },
                releaseFrames() { d.released++; },
            };
            return d;
        }

        AS.state.sessions = [session];
        AS.state.session = session;
        AS.state.activeSessionIdx = 0;
        AS.state.totalFrames = N;
        AS.state.currentFrame = 10;
        AS.state.views = cams.map((c, i) => ({
            name: c.name, videoWidth: 640, videoHeight: 480, canvas: null, decoder: fakeDecoder(i),
        }));
        AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name }));
        AS.state.viewMode = 'grid';
        AS.state.singleViewIndex = 0;
        AS.paneManager.clearAll();
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
        if (AS.interactionManager) AS.interactionManager.lastInteractedView = 'camC';

        // Count overlay draws per view: drawFrameOverlays opens with a clear of
        // its canvas, so wrap clearRect on each view's CURRENT overlay context.
        window.__overlayDraws = {};
        window.__countOverlays = function () {
            for (const v of AS.state.views) {
                const ctx = v.overlayCtx;
                if (!ctx || ctx.__counted) continue;
                ctx.__counted = true;
                const orig = ctx.clearRect.bind(ctx);
                ctx.clearRect = function () {
                    window.__overlayDraws[v.name] = (window.__overlayDraws[v.name] || 0) + 1;
                    return orig.apply(null, arguments);
                };
            }
        };
        await new Promise(r => requestAnimationFrame(r));
    }, CAMS);

    // Let every pending seek land: the controller is idle and two frames have painted.
    const settle = () => page.evaluate(async () => {
        const vc = window.__lucid.videoController;
        for (let i = 0; i < 200; i++) {
            await new Promise(r => requestAnimationFrame(r));
            if (!vc._isSeeking && vc._scrubTarget === null) break;
        }
        await new Promise(r => setTimeout(r, 50));
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    });

    const snap = () => page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const out = { frame: AS.state.currentFrame, mode: AS.state.viewMode, views: {} };
        AS.state.views.forEach((v, i) => {
            let px = null;
            if (v.canvas && v.canvas.isConnected) {
                const d = v.ctx.getImageData(Math.floor(v.canvas.width / 2), Math.floor(v.canvas.height / 2), 1, 1).data;
                px = { frame: d[0], view: Math.round(d[1] / 40) };
            }
            out.views[v.name] = {
                docked: AS.paneManager.dockedViews.get(v.name) > 0,
                calls: v.decoder.calls.slice(), playing: v.decoder.playing, px, released: v.decoder.released,
                overlays: window.__overlayDraws[v.name] || 0, index: i,
            };
        });
        return out;
    });
    const resetCounts = () => page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        for (const v of AS.state.views) v.decoder.calls.length = 0;
        window.__overlayDraws = {};
        window.__countOverlays();
    });
    const press = async (key) => {
        await page.evaluate(() => document.body.focus());
        await page.keyboard.press(key);
        await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
    };
    // Each docked canvas shows `frame`, painted by its OWN decoder.
    const showsFrame = (s, name, frame) => {
        const v = s.views[name];
        return !!(v.px && v.px.frame === frame && v.px.view === v.index);
    };

    await settle();

    // =================================================================
    // 1 — grid: a step decodes every view
    // =================================================================
    await resetCounts();
    await press('ArrowRight');
    await settle();
    let s = await snap();
    check(s.frame === 11, `grid: ArrowRight steps to frame 11 (got ${s.frame})`);
    for (const c of CAMS) {
        check(s.views[c].calls.includes(11), `grid: ${c} decoded frame 11 (calls ${JSON.stringify(s.views[c].calls)})`);
        check(showsFrame(s, c, 11), `grid: ${c}'s canvas shows frame 11 (px ${JSON.stringify(s.views[c].px)})`);
    }

    // =================================================================
    // 2 — solo: steps decode, and overlays draw, on the solo view only
    // =================================================================
    await press('v');
    await settle();
    await resetCounts();
    for (let i = 0; i < 3; i++) { await press('ArrowRight'); await settle(); }
    s = await snap();
    check(s.mode === 'single' && s.views.camC.docked, `v solos camC (mode ${s.mode})`);
    check(s.frame === 14, `solo: three steps reach frame 14 (got ${s.frame})`);
    check(JSON.stringify(s.views.camC.calls) === '[12,13,14]',
        `solo: camC decoded 12, 13, 14 (got ${JSON.stringify(s.views.camC.calls)})`);
    for (const c of ['camA', 'camB', 'camD']) {
        check(s.views[c].calls.length === 0, `solo: hidden ${c} decoded nothing (got ${JSON.stringify(s.views[c].calls)})`);
        check(s.views[c].overlays === 0, `solo: no overlay drawn for hidden ${c} (got ${s.views[c].overlays})`);
    }
    check(s.views.camC.overlays >= 3, `solo: overlays drawn on camC each step (got ${s.views.camC.overlays})`);
    check(showsFrame(s, 'camC', 14), `solo: camC's canvas shows frame 14 (px ${JSON.stringify(s.views.camC.px)})`);
    // The hidden views' decoded frames are released (8 MB each at 1680x1200: a
    // full grid's caches kept Chrome garbage-collecting), the solo view's kept.
    check(['camA', 'camB', 'camD'].every(c => s.views[c].released === 1),
        `solo: each hidden view released its frames once (${JSON.stringify(['camA', 'camB', 'camD'].map(c => s.views[c].released))})`);
    check(s.views.camC.released === 0, `solo: camC kept its frames (released ${s.views.camC.released})`);

    // =================================================================
    // 3 — switching the solo view shows the current frame on the new view
    // =================================================================
    await press('ArrowDown');
    await settle();
    s = await snap();
    check(s.views.camD.docked && !s.views.camC.docked, 'Down: camD is now the solo view');
    check(showsFrame(s, 'camD', 14),
        `Down: camD — hidden during those steps — shows the CURRENT frame 14 (px ${JSON.stringify(s.views.camD.px)})`);

    // =================================================================
    // 4 — back to the grid: every canvas on the current frame
    // =================================================================
    await press('g');
    await settle();
    s = await snap();
    check(s.mode === 'grid', `g returns to the grid (mode ${s.mode})`);
    for (const c of CAMS) {
        check(s.views[c].docked && showsFrame(s, c, 14),
            `grid again: ${c} shows frame 14 (px ${JSON.stringify(s.views[c].px)})`);
    }

    // =================================================================
    // 5 — playback while solo plays only the solo view, and follows a switch
    // =================================================================
    await press('v');
    await settle();
    s = await snap();
    const soloName = CAMS.find(c => s.views[c].docked);
    await page.evaluate(() => window.__lucid.videoController.startPlayback());
    await page.evaluate(() => new Promise(r => setTimeout(r, 150)));
    s = await snap();
    check(s.views[soloName].playing, `play while solo: ${soloName} plays`);
    check(CAMS.filter(c => c !== soloName).every(c => !s.views[c].playing),
        `play while solo: no hidden view plays (${CAMS.filter(c => s.views[c].playing)})`);
    await press('ArrowDown');
    await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
    s = await snap();
    const nextName = CAMS.find(c => s.views[c].docked);
    check(nextName && nextName !== soloName, `Down during playback solos the next view (${soloName} -> ${nextName})`);
    check(nextName && s.views[nextName].playing, `the newly solo'd ${nextName} PLAYS (restarted on it)`);
    check(!s.views[soloName].playing, `the previous solo view ${soloName} is paused`);
    check(await page.evaluate(() => window.__lucid.state.isPlaying), 'playback is still on after the switch');
    await page.evaluate(() => window.__lucid.videoController.stopPlayback());
    await settle();

    // =================================================================
    // 6 — the rule is "docked", not "solo mode": close panes in the grid
    // =================================================================
    await press('g');
    await settle();
    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        for (const p of Array.from(AS.paneManager.api.panels)) {
            const r = sp.panelRenderers.get(p.id);
            if (r && r.getViewName() !== 'camB') p.api.close();
        }
        await new Promise(r => requestAnimationFrame(r));
    });
    await settle();
    await resetCounts();
    await press('ArrowRight');
    await settle();
    s = await snap();
    check(s.mode === 'grid' && s.views.camB.docked && CAMS.filter(c => s.views[c].docked).length === 1,
        `grid with three panes closed: only camB docked (${CAMS.filter(c => s.views[c].docked)})`);
    check(s.views.camB.calls.length === 1 && showsFrame(s, 'camB', s.frame),
        `closed panes: camB decoded the step and shows frame ${s.frame} (calls ${JSON.stringify(s.views.camB.calls)})`);
    check(['camA', 'camC', 'camD'].every(c => s.views[c].calls.length === 0),
        `closed panes: the closed views decoded nothing (${JSON.stringify(['camA', 'camC', 'camD'].map(c => s.views[c].calls))})`);

    await browser.close();
} catch (e) {
    console.log('  ✗ threw:', e && e.message ? e.message : String(e));
    fails++;
    if (browser) await browser.close().catch(() => {});
} finally {
    server.kill();
}

console.log(fails === 0 ? '\nsolo-view-decodes-shown-only: PASS' : `\nsolo-view-decodes-shown-only: FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
