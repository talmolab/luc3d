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
 *  4. "Clear" in the tab stops it.
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
            let pair = 0, far = 0, total = 0, hash = 0;
            for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
                const i = (y * c.width + x) * 4; if (!d[i + 3]) continue;
                total++; hash = (hash * 31 + x * 7 + y + d[i]) >>> 0;
                const vx = x / sx, vy = y / sy;
                if (vx < 300 && vy < 320) pair++; else if (vx > 450 && vy > 300) far++;
            }
            return { canvas: true, inWrapper: c.parentNode === v.wrapper, pair, far, total, hash };
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

    // ---- 3. step past the interval (frame 80 is its last) -> cleared; back in -> redrawn
    await page.click('#idSwitchPanel .id-switch-row .id-switch-end');               // frame 50, in range
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 50, null, { timeout: 10000 }).catch(() => {});
    for (let i = 0; i < 31; i++) await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 81, null, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(150);
    const out = await census();
    check(out.every(v => v.total === 0), `past the interval (frame 81): every highlight canvas is clear (${out.map(v => v.total)})`);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(150);
    const back = await census();
    check(back.every(v => v.pair > 200), 'stepping back into the interval (frame 80) draws it again');

    // ---- 4. Clear stops it
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
