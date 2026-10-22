/**
 * id-switch-highlight.mjs — the animated box around a selected ID-switch row's
 * two animals (ui/id-switch-highlight.js), in the real app's camera views.
 *
 * Fixture: two calibrated views (no video), three animals per frame as grouped
 * 2D instances with identities id_0 / id_1 / id_2; id_0 and id_1 sit together on
 * the left, id_2 far right. The session carries one ID-switch result for
 * id_0 ↔ id_1, close from frame 40 to 50 at 30 fps, so the row's interval is
 * frames 10 (1 s before) to 80 (1 s after). Asserted:
 *  1. Selecting the row draws, in EACH view, a box on the view's own
 *     `.id-switch-canvas` around id_0 + id_1 — and nothing near id_2.
 *  2. It animates while paused (the outline changes between two moments).
 *  3. Stepping past the interval clears every canvas; coming back redraws.
 *  4. The box wears the colour of the progress-bar section the frame is in:
 *     orange over the lead-in (10) and lead-out (51), red over the close spell
 *     (40..50) — and the bar itself is orange | red | orange.
 *     The bar's playhead line sits on the fill's leading edge at every frame and
 *     stands proud of the bar.
 *  5. Clicking the bar goes to that frame (also a few px above its 6 px), dragging
 *     along it scrubs, and neither sends the row back to its lead-in.
 *  6. When the animals move between frames, the old box is cleared completely (a
 *     repaint clears only the rectangle the last one drew, not the whole canvas).
 *  7. "Clear" in the tab stops it.
 *  8. The box encloses only nodes the Tracking Wizard weights above 0: with
 *     id_0's TTI stretched out to the top right it reaches the tail; weighting TTI
 *     0 in Settings ▸ Tracking Wizard and clicking Apply re-fits it at once (same
 *     frame) to the bodies; and an instance whose only visible node is weighted 0
 *     still counts (falls back to all its nodes) in that view and only that view.
 *  9. Lazy project: clicking the row lands on a frame that is not resident yet.
 *     The box appears as soon as that frame is hydrated — with no frame change,
 *     which is all a hydration is — not only once play is pressed.
 *
 * Run: node tests/e2e/id-switch-highlight.mjs     (HL_SHOT=/path.png saves a screenshot)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8278);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
        const sp = await import('/ui/sessions-panes.js');
        const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'Trunk'];
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = ['camA', 'camB'].map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [20 * i, 0, 0], [640, 480]));
        const s = new pd.Session(cams, new pd.Skeleton('m', NODES, []), [], 'HL');
        const ids = ['id_0', 'id_1', 'id_2'].map(n => s.addIdentity(n).id);
        const home = [[120, 200], [190, 230], [540, 380]];          // id_0, id_1 together; id_2 far away
        let gid = 1;
        for (let f = 0; f < 120; f++) {
            const fg = new pd.FrameGroup(f); s.addFrameGroup(fg);
            const gs = [];
            for (let a = 0; a < 3; a++) {
                const g = new pd.InstanceGroup(gid++, ids[a]);
                for (const c of cams) {
                    const [cx, cy] = home[a];
                    const pts = NODES.map((_, k) => [cx + 12 * k - 24, cy + (k % 2) * 8]);
                    const inst = new pd.Instance(pts, null, 'predicted', 0.9);
                    g.addInstance(c.name, inst); fg.addInstance(c.name, inst);
                }
                gs.push(g);
            }
            s.instanceGroups.set(f, gs);
        }
        AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
        AS.state.totalFrames = 120; AS.state.currentFrame = 0; AS.state.fps = 30;
        AS.paneManager.clearAll();
        AS.state.views = cams.map(c => ({ name: c.name, videoWidth: 640, videoHeight: 480, canvas: null }));
        AS.state.videoFiles = cams.map(c => ({ name: c.name, assignedCamera: c.name }));
        sp.populateViewStrip();
        AS.paneManager.addAllViewsAsGrid();
        if (AS.timeline) { AS.timeline.setTotalFrames(120); AS.timeline.setData(s); }
        // one stored check result: id_0 ↔ id_1, close 40..50
        const flag = { frame: 50, startFrame: 40, nameA: 'id_0', nameB: 'id_1', identityA: ids[0], identityB: ids[1], score: -80, cue: 'size' };
        s._idSwitch = { results: { size: { ok: true, flags: [flag], changes: [], encounters: [{}], sampleHz: 15, step: 2, fps: 30, fpsFromVideo: false } },
                        reviewed: new Set(), showRepeats: false, current: null };
        const M = await import('/ui/id-switch-modal.js');
        M.refreshIdSwitchPanel(s); M.openIdSwitchPanel();
    });

    // pixel census of each view's highlight canvas: opaque pixels near the pair, near id_2, and a digest
    const census = () => page.evaluate(() => {
        const AS = window.__lucid;
        return AS.state.views.map(v => {
            const c = v.wrapper && v.wrapper.querySelector('.id-switch-canvas');
            if (!c) return { canvas: false };
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, sx = c.width / 640, sy = c.height / 480;
            let pair = 0, far = 0, total = 0, hash = 0, orange = 0, red = 0;
            for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
                const i = (y * c.width + x) * 4; if (!d[i + 3]) continue;
                total++; hash = (hash * 31 + x * 7 + y + d[i]) >>> 0;
                const r = d[i], g = d[i + 1], b = d[i + 2];
                // classify by HUE, not level: the pulse and the dark halo under the stroke darken it
                if (d[i + 3] > 64 && r > 100 && b < 0.4 * r) { if (g > 0.55 * r && g < 0.85 * r) orange++; else if (g < 0.4 * r) red++; }
                const vx = x / sx, vy = y / sy;
                if (vx < 300 && vy < 320) pair++; else if (vx > 450 && vy > 300) far++;
            }
            return { canvas: true, inWrapper: c.parentNode === v.wrapper, pair, far, total, hash, orange, red };
        });
    });

    // ---- 1. select the row -> lands at frame 10 (in range) -> box around id_0 + id_1 in every view
    await page.click('#idSwitchPanel .id-switch-row .id-switch-main');
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 10, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(150);
    let c1 = await census();
    check(c1.length === 2 && c1.every(v => v.canvas && v.inWrapper && v.pair > 200 && v.far === 0),
        `both views draw the box on their own canvas, around id_0 + id_1 and not id_2 (${JSON.stringify(c1.map(v => [v.pair, v.far]))})`);

    if (process.env.HL_SHOT) await page.screenshot({ path: process.env.HL_SHOT });
    // ---- 2. animated while paused
    await page.waitForTimeout(250);
    const c2 = await census();
    check(c2.every((v, i) => v.hash !== c1[i].hash), 'the outline moves while paused (marching ants)');
    check(c1.every(v => v.orange > 100 && v.orange > 5 * v.red),
        `lead-in (frame 10): the box is orange (${JSON.stringify(c1.map(v => [v.orange, v.red]))})`);
    const bar = await page.evaluate(() => {
        const b = document.querySelector('#idSwitchPanel .id-switch-row.is-current .id-switch-pbar');
        return b && { track: b.querySelector('.id-switch-ptrack').style.backgroundImage, band: b.querySelector('.id-switch-pband').style.background };
    });
    check(!!bar && /rgba\(255, 176, 32/.test(bar.track) && /rgba\(240, 60, 50/.test(bar.band),
        `the bar is orange lead-in/out around a red close spell (${JSON.stringify(bar)})`);

    // ---- 5. click / drag on the bar (interval 10..80): x of t across it -> frame round(10 + 70 t)
    const barBox = await page.locator('#idSwitchPanel .id-switch-row.is-current .id-switch-pbar').boundingBox();
    const atT = t => barBox.x + t * barBox.width, midY = barBox.y + barBox.height / 2;
    const cur = () => page.evaluate(() => window.__lucid.state.currentFrame);
    await page.mouse.click(atT(0.25), midY);
    await page.waitForTimeout(100);
    check(await cur() === 28, `clicking a quarter of the way along goes to frame 28 (${await cur()})`);
    const stillSel = await page.evaluate(() => !!document.querySelector('#idSwitchPanel .id-switch-row.is-current .id-switch-pbar'));
    check(stillSel, 'the row stays selected with its bar (the click is not a row click)');
    await page.mouse.click(atT(0.5), barBox.y - 4);
    await page.waitForTimeout(100);
    check(await cur() === 45, `a click 4 px above the bar still lands, halfway: frame 45 (${await cur()})`);
    await page.mouse.move(atT(0.25), midY); await page.mouse.down();
    await page.mouse.move(atT(0.6), midY + 20, { steps: 5 });                   // drifting off the bar keeps scrubbing
    const mid = await cur();
    await page.mouse.move(atT(0.75), midY, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(100);
    const headAt = await page.evaluate(() => document.querySelector('#idSwitchPanel .id-switch-row.is-current .id-switch-phead').style.left);
    check(mid === 52 && await cur() === 63 && headAt === '75.71%',
        `dragging scrubs: 52 mid-drag, 63 on release, playhead at 75.71% (${mid}, ${await cur()}, ${headAt})`);

    // ---- 3. step past the interval (frame 80 is its last) -> cleared; back in -> redrawn
    await page.click('#idSwitchPanel .id-switch-row .id-switch-end');               // frame 50, in range
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 50, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(150);
    const close = await census();
    const head = await page.evaluate(() => {
        const b = document.querySelector('#idSwitchPanel .id-switch-row.is-current .id-switch-pbar');
        const fill = b.querySelector('.id-switch-pfill').getBoundingClientRect(), h = b.querySelector('.id-switch-phead');
        const bar = b.getBoundingClientRect(), r = h.getBoundingClientRect();
        return { left: h.style.left, width: b.querySelector('.id-switch-pfill').style.width,
                 centre: r.left + r.width / 2, edge: fill.right, above: bar.top - r.top, below: r.bottom - bar.bottom };
    });
    check(head.left === head.width && head.left === '57.14%',
        `frame 50: the playhead is at the fill's edge, 40/70 of the way (${head.left} vs fill ${head.width})`);
    check(head.above >= 3 && head.below >= 3, `the playhead stands proud of the bar (${head.above}px above, ${head.below}px below)`);
    check(close.every(v => v.red > 100 && v.red > 5 * v.orange),
        `close spell (frame 50): the box is red (${JSON.stringify(close.map(v => [v.orange, v.red]))})`);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    const after = await census();
    check(after.every(v => v.orange > 100 && v.orange > 5 * v.red),
        `lead-out (frame 51): the box is orange again (${JSON.stringify(after.map(v => [v.orange, v.red]))})`);
    for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 81, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(150);
    const out = await census();
    check(out.every(v => v.total === 0), `past the interval (frame 81): every highlight canvas is clear (${out.map(v => v.total)})`);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(150);
    const back = await census();
    check(back.every(v => v.pair > 200), 'stepping back into the interval (frame 80) draws it again');

    // ---- 6. the box moves: frame 79 has id_0 + id_1 250 px to the right -> nothing left where they were
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js'); const S = window.__lucid.state.session;
        const groups = S.instanceGroups.get(79);
        for (const g of groups.slice(0, 2)) for (const cam of ['camA', 'camB']) {
            const old = g.getInstance(cam), pts = [];
            for (let k = 0; k < old.numNodes; k++) pts.push([old.getX(k) + 250, old.getY(k)]);
            g.addInstance(cam, new pd.Instance(pts, null, 'predicted', 0.9));
        }
    });
    await page.keyboard.press('ArrowLeft');                                           // 80 -> 79
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 79, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(200);
    const moved = await page.evaluate(() => window.__lucid.state.views.map(v => {
        const c = v.wrapper.querySelector('.id-switch-canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, sx = c.width / 640;
        let oldPlace = 0, newPlace = 0;
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
            if (!d[(y * c.width + x) * 4 + 3]) continue;
            if (x / sx < 300) oldPlace++; else newPlace++;
        }
        return { oldPlace, newPlace };
    }));
    check(moved.every(v => v.oldPlace === 0 && v.newPlace > 200),
        `the box moved with them and nothing is left where it was (${JSON.stringify(moved)})`);

    // ---- 8. zero-weight nodes are left out of the box. Frame 78: id_0's TTI (node 3) out at (420, 60) in
    //      both views. Frame 77: in camB only, id_1 has nothing visible but its TTI, out at (420, 60).
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js'); const S = window.__lucid.state.session;
        const reshape = (f, a, cam, fn) => {
            const g = S.instanceGroups.get(f)[a], old = g.getInstance(cam), pts = [];
            for (let k = 0; k < old.numNodes; k++) pts.push(fn(k, old.getX(k), old.getY(k)));
            g.addInstance(cam, new pd.Instance(pts, null, 'predicted', 0.9));
        };
        for (const cam of ['camA', 'camB']) reshape(78, 0, cam, (k, x, y) => k === 3 ? [420, 60] : [x, y]);
        reshape(77, 1, 'camB', k => k === 3 ? [420, 60] : [NaN, NaN]);
    });
    const tailCensus = () => page.evaluate(() => window.__lucid.state.views.map(v => {
        const c = v.wrapper.querySelector('.id-switch-canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, sx = c.width / 640, sy = c.height / 480;
        let tail = 0, pair = 0;
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
            if (!d[(y * c.width + x) * 4 + 3]) continue;
            const vx = x / sx, vy = y / sy;
            if (vx > 330 && vx < 450 && vy < 140) tail++; else if (vx < 300 && vy < 320) pair++;
        }
        return { tail, pair };
    }));
    await page.keyboard.press('ArrowLeft');                                           // 79 -> 78
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 78, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(200);
    const wide = await tailCensus();
    check(wide.every(v => v.tail > 50), `every node weighted 1: the box reaches id_0's outstretched TTI (${JSON.stringify(wide)})`);
    await page.evaluate(async () => (await import('/ui/settings-modal.js')).showSettingsModal('wizard'));
    await page.fill('input[aria-label="Weight for node TTI"]', '0');
    await page.click('.settings-btn-apply');
    await page.waitForTimeout(200);
    const tight = await tailCensus();
    const frameAfterApply = await cur();
    check(frameAfterApply === 78 && tight.every(v => v.tail === 0 && v.pair > 200),
        `TTI weighted 0 + Apply, still frame 78: the box shrinks to the bodies, the tail is outside it (${JSON.stringify(tight)})`);
    await page.keyboard.press('ArrowLeft');                                           // 78 -> 77
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 77, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(200);
    const fallback = await tailCensus();
    check(fallback[0].tail === 0 && fallback[1].tail > 50,
        `frame 77: id_1 shows only its zero-weight TTI in camB, so camB's box falls back to it; camA's does not reach it (${JSON.stringify(fallback)})`);
    const masks = await page.evaluate(async () => {
        const H = await import('/ui/id-switch-highlight.js'), St = await import('/ui/settings.js');
        const out = { tti: H.idSwitchBoxNodeMask(['Nose', 'TTI', 'Trunk']) };
        St.setNodeWeights({ Nose: 0, TTI: 0, Trunk: 0 });
        out.allZero = H.idSwitchBoxNodeMask(['Nose', 'TTI', 'Trunk']);
        St.setNodeWeights({});
        out.noneZero = H.idSwitchBoxNodeMask(['Nose', 'TTI', 'Trunk']);
        return out;
    });
    check(JSON.stringify(masks) === JSON.stringify({ tti: [true, false, true], allZero: null, noneZero: null }),
        `the node mask: TTI left out; every node weighted 0, or none, encloses them all (${JSON.stringify(masks)})`);

    // ---- 9. the landing frame is not resident (a lazy project): take frame 10 (the row's lead-in) out of
    //      frameGroups, click the row, then put it back the way a hydration does — same frame, no seek
    await page.evaluate(() => {
        const S = window.__lucid.state.session;
        window.__hlStash = S.frameGroups.get(10); S.frameGroups.delete(10);
    });
    await page.click('#idSwitchPanel .id-switch-row .id-switch-line1');               // the heading, not the bar under it
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 10, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(150);
    const unresident = await census();
    check(await cur() === 10 && unresident.every(v => v.total === 0),
        `row clicked, frame 10 not resident yet: no box (${unresident.map(v => v.total)})`);
    await page.evaluate(() => { window.__lucid.state.session.addFrameGroup(window.__hlStash); delete window.__hlStash; });
    await page.waitForTimeout(150);
    const hydrated = await census();
    check(await cur() === 10 && hydrated.every(v => v.pair > 200 && v.far === 0),
        `frame 10 hydrated, still on frame 10: the box appears without a frame change (${JSON.stringify(hydrated.map(v => [v.pair, v.far]))})`);

    // ---- 7. Clear stops it
    await page.click('#idSwitchClear');
    await page.waitForTimeout(150);
    const cleared = await census();
    const target = await page.evaluate(async () => (await import('/ui/id-switch-highlight.js')).getIdSwitchHighlight());
    check(target === null && cleared.every(v => v.total === 0), '"Clear" stops the highlight and clears the canvases');
    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (e) {
    console.error(e); fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `FAIL (${fails})` : 'PASS');
process.exit(fails ? 1 : 0);
