/**
 * node-score-tooltip.mjs — resting the pointer on a node shows its name, and on
 * a prediction the model's score for THAT node: SLEAP 1.6.5's node tooltip
 * (`trunk` / `(score: 0.94)`), in the real app with real mouse input.
 *
 * The data half is pinned in Node (tests/test-node-scores.mjs) against
 * hand-built stores. What only a real browser can show:
 *
 *  1. The scores survive the REAL eager load (`handleLoadSlpFile` -> sleap-io's
 *     reader -> `_typedInstanceToSlpData` -> the importer), which used to keep
 *     only the instance score.
 *  2. The tooltip itself: SLEAP's text, a prediction's per-node score and a
 *     user node's bare name, Qt's delay before the first tip and none for the
 *     next, nothing on an edge or on empty canvas, and gone on a new frame or a
 *     press. Read from the DOM after real `page.mouse` moves.
 *  3. A save keeps them: both writers wrote the INSTANCE score onto every node,
 *     so a reopened project showed one number for all of an instance's nodes.
 *     The eager writer is checked by saving and reopening through the real
 *     load path again, the streaming writer on a camera-frame the user edited
 *     (the one place it rebuilds a prediction instead of copying the store row).
 *  4. A lazy project reads its scores from the REAL columnar store, by each
 *     instance's `_rawInstIndex`, for every node of every instance — and the
 *     hover shows them.
 *
 * Run: node tests/e2e/node-score-tooltip.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8297);
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined && !c ? '  ' + JSON.stringify(extra).slice(0, 600) : ''));
    if (!c) fails++;
};
const f32 = (v) => Math.fround(v);

// The eager fixture: one camera, a prediction P (track t0) and a user
// instance U (track t1) on every frame. P's per-node scores differ from each
// other AND from its instance score, so any one of them standing in for the
// others is visible.
const NODES = ['head', 'trunk', 'tail'];
const P_SCORES = [0.91, 0.42, 0.07];
const P_INSTANCE_SCORE = 0.6;
const P = [[100, 100], [220, 160], [340, 220]];
const U = [[100, 360], [220, 400], [340, 440]];

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 60000 });

    /** Load `.slp` bytes (a page global) through the real File ▸ Load path, skipping the video prompt. */
    async function loadThroughApp(globalName, fileName) {
        await page.evaluate(async ([g, fn]) => {
            const imp = await import('/import-export/slp-import.js');
            window.__loadDone = false;
            imp.handleLoadSlpFile(new File([window[g]], fn))
                .then(() => { window.__loadDone = true; }, (e) => { window.__loadDone = 'ERR ' + e; });
        }, [globalName, fileName]);
        for (let i = 0; i < 120; i++) {
            const s = await page.evaluate(() => ({ done: window.__loadDone, prompt: !!document.getElementById('videoSelectOverlay') }));
            if (s.prompt) await page.keyboard.press('Escape');          // "no videos": the load goes on
            if (s.done) return s.done;
            await page.waitForTimeout(250);
        }
        return 'timeout';
    }

    /** One view per camera, laid out on screen, with the InteractionManager attached. */
    async function showViews(cams, frameIdx, totalFrames) {
        await page.evaluate(async ([cams, frameIdx, totalFrames]) => {
            const AS = await import('/ui/app-state.js');
            const sp = await import('/ui/sessions-panes.js');
            const R = await import('/ui/rendering.js');
            AS.state.totalFrames = totalFrames;
            AS.state.currentFrame = frameIdx;
            AS.state.isPlaying = false;
            AS.state.triangulationResults = AS.state.triangulationResults || new Map();
            AS.state.views = cams.map(n => ({ name: n, videoWidth: 640, videoHeight: 480, frameCount: totalFrames, canvas: null }));
            AS.state.videoFiles = cams.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
            AS.state.viewMode = 'grid';
            AS.state.singleViewIndex = 0;
            AS.paneManager.clearAll();
            sp.populateViewStrip();
            AS.paneManager.addAllViewsAsGrid();
            await new Promise(r => requestAnimationFrame(r));
            sp.refreshPaneInteractions();
            await new Promise(r => requestAnimationFrame(r));
            R.drawAllOverlays(frameIdx);
        }, [cams, frameIdx, totalFrames]);
    }

    /** Screen position of a video-space point on a camera's overlay canvas. */
    const screenOf = (cam, vx, vy) => page.evaluate(async ([cam, x, y]) => {
        const AS = await import('/ui/app-state.js');
        const v = AS.state.views.find(w => w.name === cam);
        const r = v.overlayCanvas.getBoundingClientRect();
        return [r.left + (x / v.videoWidth) * r.width, r.top + (y / v.videoHeight) * r.height];
    }, [cam, vx, vy]);

    /** The node tooltip as the user sees it. */
    const tip = () => page.evaluate(() => {
        const el = document.getElementById('nodeTip');
        if (!el || el.hidden) return { shown: false };
        const r = el.getBoundingClientRect();
        return { shown: true, text: el.textContent, lines: el.innerText.split('\n'), rect: [r.left, r.top, r.right, r.bottom],
                 pe: getComputedStyle(el).pointerEvents };
    });
    const hover = async (cam, pt) => { const [x, y] = await screenOf(cam, pt[0], pt[1]); await page.mouse.move(x, y); return [x, y]; };

    // =====================================================================
    // 1. The real eager load keeps every node's score
    // =====================================================================
    await page.evaluate(async ([NODES, P, U, PS, PIS]) => {
        const SIO = window.SleapIO;
        const skeleton = new SIO.Skeleton({ name: 'sk', nodes: NODES, edges: [[0, 1], [1, 2]] });
        const video = new SIO.Video({ filename: 'camA.mp4', shape: [5, 480, 640, 1] });
        const t0 = new SIO.Track('t0'), t1 = new SIO.Track('t1');
        const lfs = [];
        for (let f = 0; f < 5; f++) {
            const dx = f * 2;   // the animal moves a little each frame
            lfs.push(new SIO.LabeledFrame({ video, frameIdx: f, instances: [
                new SIO.PredictedInstance({
                    points: P.map((p, k) => ({ xy: [p[0] + dx, p[1]], visible: true, complete: true, score: PS[k] })),
                    skeleton, track: t0, score: PIS }),
                new SIO.Instance({ points: U.map(p => ({ xy: [p[0] + dx, p[1]], visible: true, complete: true })), skeleton, track: t1 }),
            ] }));
        }
        window.__eagerBytes = await SIO.saveSlpToBytes(new SIO.Labels({ skeletons: [skeleton], videos: [video], tracks: [t0, t1], labeledFrames: lfs }));
    }, [NODES, P, U, P_SCORES, P_INSTANCE_SCORE]);

    const loaded = await loadThroughApp('__eagerBytes', 'eager.slp');
    check(loaded === true, 'the eager .slp loads through handleLoadSlpFile', loaded);

    /** P and U on a frame, with every node's score as the app reports it. */
    const readEager = (frameIdx) => page.evaluate(async (frameIdx) => {
        const s = window.__lucid.state.session;
        const fg = s.getFrameGroup(frameIdx);
        const all = [];
        for (const [, insts] of fg.instances) for (const i of insts) all.push(i);
        for (const [, uls] of fg.unlinkedInstances) for (const u of uls) all.push(u.instance);
        const pick = (type) => all.find(i => i.type === type);
        const scores = (i) => i ? [0, 1, 2].map(k => s.predictedNodeScore('camA', frameIdx, i, k)) : null;
        return { pred: scores(pick('predicted')), predOwn: !!(pick('predicted') && pick('predicted').hasPointScores()),
                 predInstanceScore: pick('predicted') && pick('predicted').score,
                 user: scores(pick('user')) };
    }, frameIdx);
    const e0 = await readEager(0);
    check(e0.pred && e0.pred.every((v, k) => v === f32(P_SCORES[k])),
        `every node of the prediction keeps its own score (${JSON.stringify(e0.pred)})`);
    check(e0.predInstanceScore !== null && Math.abs(e0.predInstanceScore - P_INSTANCE_SCORE) < 1e-6, 'and the instance score is still the instance score');
    check(e0.user && e0.user.every(Number.isNaN), 'the user instance has none');

    // The raw h5wasm worker: what an eager per-camera folder load reads with
    // (columnar, `addColumnarFramesToSession`), and the importer's fallback
    // (nested `frames`).
    const raw = await page.evaluate(async () => {
        const fileio = await import('/import-export/file-io.js');
        const loader = await import('/loading/session-loader.js');
        const { Session } = await import('/pose/pose-data.js');
        const file = new File([window.__eagerBytes], 'camA.slp');
        const col = (await fileio.parseSlpH5(file, null, { columnar: true })).columnar;
        const s = new Session([], { name: 'sk', nodes: ['head', 'trunk', 'tail'], edges: [] }, ['t0', 't1'], 'percam');
        loader.addColumnarFramesToSession(s, 'camA', col, new Int32Array([0, 1]));
        const insts = s.getFrameGroup(0).getInstances('camA');
        const scoresOf = (i) => [0, 1, 2].map(k => s.predictedNodeScore('camA', 0, i, k));
        const nested = (await fileio.parseSlpH5(file, null)).frames.find(f => f.frameIdx === 0).instances;
        return {
            columnar: insts.map(i => ({ type: i.type, scores: scoresOf(i) })),
            nested: nested.map(d => ({ type: d.type, scores: d.pointScores ? Array.from(d.pointScores) : null })),
        };
    });
    const rawPred = raw.columnar.find(x => x.type === 'predicted'), rawUser = raw.columnar.find(x => x.type === 'user');
    check(rawPred && rawPred.scores.every((v, k) => v === f32(P_SCORES[k])),
        `per-camera (columnar worker): every node keeps its own score (${JSON.stringify(rawPred && rawPred.scores)})`);
    check(rawUser && rawUser.scores.every(Number.isNaN), 'and the user instance has none');
    const nPred = raw.nested.find(x => x.type === 'predicted'), nUser = raw.nested.find(x => x.type === 'user');
    check(nPred && nPred.scores && nPred.scores.every((v, k) => Math.fround(v) === f32(P_SCORES[k])),
        `the worker's nested frames carry them too (${JSON.stringify(nPred && nPred.scores)})`);
    check(nUser && nUser.scores === null, 'and none for the user instance');

    // =====================================================================
    // 2. The tooltip, driven with the real mouse
    // =====================================================================
    await showViews(['camA'], 0, 5);
    const laidOut = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const c = AS.state.views[0].overlayCanvas;
        return !!c && c.getBoundingClientRect().width > 100;
    });
    check(laidOut, 'camA overlay canvas is laid out on screen');

    // Park the pointer on empty canvas first, so the first hover is a fresh one.
    await hover('camA', [560, 40]);
    await page.waitForTimeout(100);

    const [tx, ty] = await hover('camA', P[1]);
    await page.waitForTimeout(250);
    check(!(await tip()).shown, 'no tip before the delay (Qt waits before the first tooltip)');
    await page.waitForTimeout(700);
    let t = await tip();
    check(t.shown && t.text === 'trunk\n(score: 0.42)', 'resting on a predicted node: its name, then ITS score', t);
    check(t.shown && t.lines.length === 2 && t.lines[0] === 'trunk' && t.lines[1] === '(score: 0.42)', 'shown as two lines, as SLEAP does', t.lines);
    check(t.shown && t.pe === 'none', 'the tip never takes the pointer (it would steal the hover)');
    if (t.shown) {
        const [l, tp, r, b] = t.rect;
        const dx = Math.max(l - tx, tx - r, 0), dy = Math.max(tp - ty, ty - b, 0);
        check(Math.hypot(dx, dy) < 40, `beside the pointer (${Math.round(Math.hypot(dx, dy))} px away)`);
        check(!(tx >= l && tx <= r && ty >= tp && ty <= b), 'and not covering it');
    }

    await hover('camA', P[0]);
    await page.waitForTimeout(80);
    t = await tip();
    check(t.shown && t.text === 'head\n(score: 0.91)', 'the next node shows at once, with its own score', t);

    await hover('camA', U[1]);
    await page.waitForTimeout(80);
    t = await tip();
    check(t.shown && t.text === 'trunk', 'a user node: its name alone', t);

    await hover('camA', [560, 40]);
    await page.waitForTimeout(80);
    check(!(await tip()).shown, 'empty canvas: no tip');

    // Still "awake" right after: a brief pass over empty space does not
    // restore the delay (Qt's fall-asleep window).
    await hover('camA', P[2]);
    await page.waitForTimeout(80);
    t = await tip();
    check(t.shown && t.text === 'tail\n(score: 0.07)', 'back onto a node within the window: shown at once', t);

    // An edge is not a node: SLEAP's tooltips are on nodes.
    await hover('camA', [(P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2]);
    await page.waitForTimeout(1000);
    check(!(await tip()).shown, 'on an edge: no tip');

    // Asleep again after a while off the nodes: the delay is back.
    await hover('camA', [560, 40]);
    await page.waitForTimeout(2300);
    await hover('camA', P[1]);
    await page.waitForTimeout(250);
    check(!(await tip()).shown, 'after resting off the nodes, the delay applies again');
    await page.waitForTimeout(700);
    check((await tip()).text === 'trunk\n(score: 0.42)', 'and the tip then appears');

    // A new frame moves the node out from under a still pointer.
    await page.evaluate(async () => { (await import('/pose/initialization.js')).navigateToFrame(1); });
    await page.waitForTimeout(80);
    check(!(await tip()).shown, 'a new frame: the tip for the old one goes');
    await page.evaluate(async () => { (await import('/pose/initialization.js')).navigateToFrame(0); });

    // A press puts it away (and starts whatever the press does).
    await hover('camA', [560, 40]);
    await page.waitForTimeout(2300);
    await hover('camA', P[1]);
    await page.waitForTimeout(1000);
    check((await tip()).shown, 'shown again before the press');
    await page.mouse.down();
    await page.waitForTimeout(50);
    check(!(await tip()).shown, 'a press: the tip goes');
    await page.mouse.up();
    await hover('camA', [560, 40]);

    // =====================================================================
    // 3a. The eager writer keeps every node's score — save, reopen for real
    // =====================================================================
    const saved = await page.evaluate(async () => {
        const fileio = await import('/import-export/file-io.js');
        const AS = await import('/ui/app-state.js');
        const { Instance } = await import('/pose/pose-data.js');
        const s = AS.state.session;
        // A prediction made in LUCID has no per-node scores: it keeps the
        // instance score on every node, as before.
        s.addUnlinkedInstance(2, 'camA', new Instance([[500, 50], [520, 60], [540, 70]], null, 'predicted', 0.33));
        const labels = fileio.buildSlpLabelsAllViews(s, AS.state.views, AS.state.videoFiles);
        window.__eagerSaved = await window.SleapIO.saveSlpToBytes(labels);
        return window.__eagerSaved.byteLength;
    });
    check(saved > 1000, `the eager writer saved (${saved} bytes)`);
    const reloaded = await loadThroughApp('__eagerSaved', 'eager-resaved.slp');
    check(reloaded === true, 'and the saved file reopens through handleLoadSlpFile', reloaded);
    const r0 = await readEager(0);
    check(r0.pred && r0.pred.every((v, k) => v === f32(P_SCORES[k])),
        `after save + reopen every node still has its OWN score, not ${P_INSTANCE_SCORE} on all three (${JSON.stringify(r0.pred)})`);
    const lucidMade = await page.evaluate(() => {
        const s = window.__lucid.state.session;
        const uls = s.getFrameGroup(2).getUnlinkedInstances('camA').map(u => u.instance);
        const i = uls.find(x => x.type === 'predicted' && Math.abs(x.getX(0) - 500) < 1e-3);
        return i ? [0, 1, 2].map(k => s.predictedNodeScore('camA', 2, i, k)) : null;
    });
    check(lucidMade && lucidMade.every(v => v === f32(0.33)),
        `a LUCID-made prediction still writes its instance score per node (${JSON.stringify(lucidMade)})`);

    // =====================================================================
    // 4. A lazy project: the real store, the real hydration, every node
    // =====================================================================
    const NF = 30;
    const lazy = await page.evaluate(async (NF) => {
        const SIO = window.SleapIO;
        const { SioLazyLoader } = await import('/loading/sio-lazy-loader.js');
        const tri = await import('/pose/triangulation.js');
        const { Session, Camera } = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const NODES = ['head', 'trunk', 'tail'];
        // Expected score of node k of track t on frame f — all distinct, none
        // equal to an instance score.
        const expScore = (f, t, k) => Math.round((0.05 + ((f * 7 + t * 13 + k * 29) % 90) / 100) * 1000) / 1000;
        window.__expScore = expScore;
        const skeleton = new SIO.Skeleton({ name: 'sk', nodes: NODES, edges: [[0, 1], [1, 2]] });
        const video = new SIO.Video({ filename: 'camL.mp4', shape: [NF, 480, 640, 1] });
        const tracks = [new SIO.Track('t0'), new SIO.Track('t1')];
        const lfs = [];
        for (let f = 0; f < NF; f++) {
            const insts = [];
            if (f === 5) {   // a user row in the store, BEFORE the predictions: offsets must skip it
                insts.push(new SIO.Instance({ points: NODES.map((_, k) => ({ xy: [400 + k * 20, 40], visible: true, complete: true })), skeleton, track: null }));
            }
            for (let t = 0; t < 2; t++) {
                insts.push(new SIO.PredictedInstance({
                    points: NODES.map((_, k) => ({ xy: [100 + k * 120 + f, 120 + t * 220 + k * 30], visible: true, complete: true, score: expScore(f, t, k) })),
                    skeleton, track: tracks[t], score: 0.5 }));
            }
            lfs.push(new SIO.LabeledFrame({ video, frameIdx: f, instances: insts }));
        }
        const bytes = await SIO.saveSlpToBytes(new SIO.Labels({ skeletons: [skeleton], videos: [video], tracks, labeledFrames: lfs }));
        const loader = new SioLazyLoader();
        await loader.open('camL', new File([bytes], 'camL.slp'));
        const cam = new Camera('camL', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
        const session = new Session([cam], { name: 'sk', nodes: NODES.slice(), edges: [[0, 1], [1, 2]] }, loader.trackNames.slice(), 'lazy');
        session.lazyLoader = loader;
        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        await tri.batchLoadLazyFrames(0, NF);

        let checked = 0, wrong = [], pooled = 0, userRows = 0, userScored = 0;
        for (let f = 0; f < NF; f++) {
            const fg = session.getFrameGroup(f);
            const insts = fg.getUnlinkedInstances('camL').map(u => u.instance).concat(fg.getInstances('camL'));
            for (const inst of insts) {
                if (inst.hasPointScores()) pooled++;
                if (inst.type === 'user') {
                    userRows++;
                    if ([0, 1, 2].some(k => !Number.isNaN(session.predictedNodeScore('camL', f, inst, k)))) userScored++;
                    continue;
                }
                const t = loader.trackNames[inst.trackIdx] === 't1' ? 1 : 0;
                for (let k = 0; k < 3; k++) {
                    checked++;
                    const got = session.predictedNodeScore('camL', f, inst, k);
                    if (got !== Math.fround(expScore(f, t, k)) && got !== expScore(f, t, k)) wrong.push({ f, t, k, got, want: expScore(f, t, k) });
                }
            }
        }
        return { checked, wrong: wrong.slice(0, 5), nWrong: wrong.length, pooled, userRows, userScored, frames: session.frameGroups.size };
    }, NF);
    check(lazy.frames === NF, `the lazy session hydrated every frame (${lazy.frames})`);
    check(lazy.checked === NF * 2 * 3 && lazy.nWrong === 0,
        `every node of every lazy prediction reads its own score from the store (${lazy.checked} checked, ${lazy.nWrong} wrong)`, lazy.wrong);
    check(lazy.pooled === 0, 'and nothing is copied onto the lazy instances (the store stays the only copy)');
    check(lazy.userRows === 1 && lazy.userScored === 0, 'the store\'s user row has no score');

    // The hover on a lazy project.
    await showViews(['camL'], 7, NF);
    const t1trunk = [100 + 120 + 7, 120 + 220 + 30];
    await hover('camL', [600, 30]);
    await page.waitForTimeout(2300);
    await hover('camL', t1trunk);
    await page.waitForTimeout(1000);
    t = await tip();
    const want = await page.evaluate(() => window.__expScore(7, 1, 1));
    check(t.shown && t.text === 'trunk\n(score: ' + want.toFixed(2) + ')', `lazy: the tip shows the store's score for that node (${want})`, t);
    await hover('camL', [600, 30]);

    // =====================================================================
    // 3b. The streaming writer, on a camera-frame the user edited
    // =====================================================================
    const stream = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const saveLoad = await import('/import-export/save-load.js');
        const fileio = await import('/import-export/file-io.js');
        const s = AS.state.session;
        const expScore = window.__expScore;
        // A user instance on frame 9 makes camL/9 an overlay: the writer
        // rebuilds that camera-frame's predictions instead of copying the row.
        const u = s.addNewInstance(9, 'camL', s.skeleton, null);
        u.setPointsFrom([[500, 400], [520, 410], [540, 420]]);
        let bytes, err = null;
        try { bytes = await saveLoad.saveAllSessionsStreaming([s]); } catch (e) { err = String((e && e.stack) || e); }
        if (err) return { err };
        const data = await fileio.parseSlpViaSleapIO(new File([bytes], 'lazy-resaved.slp'), () => {});
        const byFrame = (f) => {
            const fr = data.frames.find(x => x.frameIdx === f);
            return fr ? fr.instances.filter(i => i.type === 'predicted') : [];
        };
        const read = (f) => byFrame(f).map(i => ({
            t: data.tracks[i.trackIdx] === 't1' ? 1 : 0,
            got: Array.from(i.pointScores || []),
        })).map(r => ({ ...r, want: [0, 1, 2].map(k => Math.fround(expScore(f, r.t, k))) }));
        return { overlay: read(9), copied: read(12), userOn9: data.frames.find(x => x.frameIdx === 9).instances.some(i => i.type === 'user') };
    });
    check(!stream.err, 'the streaming writer saved', stream.err);
    if (!stream.err) {
        check(stream.userOn9, 'frame 9 was written as an overlay (it carries the user instance)');
        const same = (r) => r.got.length === 3 && r.got.every((v, k) => Math.fround(v) === r.want[k]);
        check(stream.overlay.length === 2 && stream.overlay.every(same),
            'the predictions rebuilt on the edited frame keep each node\'s OWN score, not 0.5 on all three', stream.overlay);
        check(stream.copied.length === 2 && stream.copied.every(same), 'and a frame copied from the store keeps them too', stream.copied);
    }

    check(errs.length === 0, 'no page errors', errs);
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL — ${fails} check(s)`);
process.exit(fails === 0 ? 0 : 1);
