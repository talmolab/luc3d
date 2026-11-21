/**
 * temporal-smoothing-adaptive.mjs — Temporal Smoothing's adaptive method (3D
 * adaptive temporal averaging, pose/adaptive-temporal-averaging.js) through
 * the real toolbar, on the shared BA rig fixture (3 distorted cameras, 2 px
 * noise on every 2D observation, two animals drifting):
 *   A. Adaptive is the default, except for someone who had set a window (no
 *      method stored); the Smooth menu's Method radio sets Settings ▸
 *      Temporal Smoothing's Method, and the Settings panel shows only the
 *      chosen method's rows (the windows figure only for the windows);
 *   B. Smooth (all frames) with Adaptive smooths every group, weighing every
 *      point by its views (no fallback), lowers frame-to-frame jitter, and
 *      says so in the status (method, mean window);
 *   C. Remove smoothing gives back the original 3D exactly, Restore the
 *      smoothed 3D exactly; This frame then writes the All frames value on
 *      its frame and nothing else;
 *   D. File save → reopen: `metadata.lucid.temporalSmoothing` holds the
 *      method, gate and longest half-window; the reopened project has the same
 *      smoothed 3D, the run's settings and a blue Smooth button;
 *   E. the Windows radio sets the windows method back.
 *
 * Run: node tests/e2e/temporal-smoothing-adaptive.mjs
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const server = await startServer(repoRoot);
const PORT = server.port;
let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
    if (!c) fails++;
};

let browser;
try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });

    const NF = 60, MID = 30;
    const waitStatus = (re) => page.waitForFunction(
        (src) => new RegExp(src).test(document.getElementById('statusText').textContent),
        re.source, { timeout: 60000 });
    const status = () => page.evaluate(() => document.getElementById('statusText').textContent);

    // Fresh eager fixture session, triangulated by the Triangulate All button.
    await page.evaluate(async ({ NF }) => {
        const AS = await import('/ui/app-state.js');
        const { buildBaRigFixture } = await import('/tests/e2e/fixtures/ba-rig-fixture.js');
        const F = window.__F = await buildBaRigFixture({ frames: NF });
        const s = F.mkSession('Adaptive', { eager: true });
        AS.state.sessions = [s];
        AS.state.activeSessionIdx = 0;
        AS.state.session = s;
        AS.state.totalFrames = F.NF;
        AS.state.currentFrame = 0;
        AS.state.views = [];
        AS.state.triangulationResults = new Map();
        // Snapshots by frame:identity, NaN as null.
        window.__snap = (sess, pick) => {
            const out = {};
            for (const [f, gs] of sess.instanceGroups) for (const g of gs) {
                const v = pick(g);
                out[f + ':' + g.identityId] = v ? Array.from(v, x => (Number.isNaN(x) ? null : x)) : null;
            }
            return out;
        };
        window.__same = (a, b, only) => {
            const keys = Object.keys(a).filter(k => !only || only(k));
            if (keys.length !== Object.keys(b).filter(k => !only || only(k)).length) return false;
            return keys.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
        };
        document.getElementById('statusText').textContent = '';
        document.getElementById('tbTriangulateAll').click();
    }, { NF });
    await waitStatus(/^(Triangulated|Grouped) /);
    await page.waitForFunction(() => {
        const s = window.__lucid.state.session;
        return s && s.instanceGroups.size >= 60 && [...s.instanceGroups.values()].every(gs => gs.every(g => g.points3d));
    }, null, { timeout: 60000 });
    await page.evaluate(() => { window.__raw = window.__snap(window.__lucid.state.session, g => g.points3d); });

    // ---- A. the Method radio and the Settings panel --------------------------------
    console.log('\n-- A. Method --');
    const methodNow = () => page.evaluate(async () => ({
        stored: (await import('/ui/settings.js')).getSmoothingParams().smoothMethod,
        radio: (document.querySelector('#smoothingDropdown input[name="tbSmoothMethod"]:checked') || {}).value,
    }));
    const fresh = await methodNow();
    check(fresh.stored === 1 && fresh.radio === '1', 'Adaptive is the default (Settings and the menu radio)', fresh);
    // Someone who set a window before the method existed (no stored method) keeps the windows.
    const legacy = await page.evaluate(async () => {
        const S = await import('/ui/settings.js');
        S.setSmoothingParams({ smoothGaussianWindow: 9 });
        const r = { method: S.getSmoothingParams().smoothMethod,
            radio: document.querySelector('#smoothingDropdown input[name="tbSmoothMethod"]:checked').value };
        S.setSmoothingParams({});
        return r;
    });
    check(legacy.method === 0 && legacy.radio === '0', 'a Gaussian window set before (no method stored) keeps the windows', legacy);
    await page.hover('#tbSmooth');
    await page.click('#smoothingDropdown input[name="tbSmoothMethod"][value="0"]');
    await page.click('#smoothingDropdown input[name="tbSmoothMethod"][value="1"]');
    const stored = (await methodNow()).stored;
    check(stored === 1, 'the radios set Settings ▸ Temporal Smoothing ▸ Method (Windows, then Adaptive)', stored);
    await page.mouse.move(700, 600);
    await page.waitForTimeout(450);
    await page.hover('#tbSmooth');
    await page.click('#smoothingDropdown [data-scope="settings"]');
    await page.waitForSelector('.settings-panel[data-panel="smoothing"]', { state: 'visible' });
    const panel = () => page.evaluate(() => {
        const p = document.querySelector('.settings-panel[data-panel="smoothing"]');
        const vis = (el) => !!el && el.offsetParent !== null;
        const rows = [...p.querySelectorAll('.settings-threshold-row')];
        return {
            select: p.querySelector('select[aria-label="Method"]').value,
            windows: rows.filter(r => r.dataset.smoothMethod === 'windows').map(vis),
            adaptive: rows.filter(r => r.dataset.smoothMethod === 'adaptive').map(vis),
            figure: vis(p.querySelector('.smooth-fig')),
        };
    });
    const p1 = await panel();
    check(p1.select === '1' && p1.adaptive.length === 2 && p1.adaptive.every(Boolean) &&
        p1.windows.length === 4 && !p1.windows.some(Boolean) && !p1.figure,
        'Settings shows Adaptive: its gate and half-window, not the windows or their figure', p1);
    await page.selectOption('.settings-panel[data-panel="smoothing"] select[aria-label="Method"]', '0');
    const p2 = await panel();
    check(p2.windows.every(Boolean) && !p2.adaptive.some(Boolean) && p2.figure,
        'switching the select to the windows shows the windows and the figure instead', p2);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const after = await page.evaluate(async () => (await import('/ui/settings.js')).getSmoothingParams().smoothMethod);
    check(after === 1, 'Esc discards the panel\'s edit (still Adaptive)', after);

    // ---- B. all frames ------------------------------------------------------------
    console.log('\n-- B. All frames --');
    await page.evaluate(() => { document.getElementById('statusText').textContent = ''; });
    await page.mouse.move(700, 600);
    await page.waitForTimeout(450);
    await page.click('#tbSmooth');
    await waitStatus(/Smoothed/);
    const st = await status();
    const b = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const s = window.__lucid.state.session;
        let smoothed = 0, groups = 0;
        for (const gs of s.instanceGroups.values()) for (const g of gs) { groups++; if (pd.isPoints3dSmoothed(g.points3d)) smoothed++; }
        // Mean |second difference| of every node, before and after.
        const jitter = (snap) => {
            let sum = 0, n = 0;
            for (let f = 1; f < 59; f++) for (const id of [0, 1]) {
                const a = snap[(f - 1) + ':' + id], c = snap[f + ':' + id], d = snap[(f + 1) + ':' + id];
                if (!a || !c || !d) continue;
                for (let i = 0; i < c.length; i += 3) {
                    let s2 = 0;
                    for (let ax = 0; ax < 3; ax++) { const v = d[i + ax] - 2 * c[i + ax] + a[i + ax]; s2 += v * v; }
                    if (Number.isFinite(s2)) { sum += Math.sqrt(s2); n++; }
                }
            }
            return sum / n;
        };
        window.__smoothed = window.__snap(s, g => g.points3d);
        return {
            smoothed, groups,
            before: jitter(window.__raw), after: jitter(window.__smoothed),
            active: document.getElementById('tbSmooth').classList.contains('active'),
        };
    });
    check(b.groups === 2 * NF && b.smoothed === b.groups, `every group smoothed (${b.smoothed}/${b.groups})`);
    // The fixture's animals drift about 2 noise SDs a frame, so most windows
    // are 1-3 frames (as ata3d's steady 3 mm/frame case): a modest drop.
    check(b.after < 0.85 * b.before, `frame-to-frame jitter ${b.before.toFixed(3)} -> ${b.after.toFixed(3)}`);
    check(/adaptive, gate 3 SD, up to 31 frames; mean window \d+\.\d frames\)/.test(st) && !/spread/.test(st),
        'the status names the method and the mean window, and no point fell back', st);
    check(b.active, 'the Smooth button is blue');

    // ---- C. Remove / Restore / This frame -----------------------------------------------
    console.log('\n-- C. Remove / Restore / This frame --');
    const toggle = async () => {
        await page.mouse.move(700, 600);
        await page.waitForTimeout(450);
        await page.hover('#tbSmooth');
        await page.click('#tbSmoothToggle');
        await page.waitForTimeout(150);
    };
    await toggle();
    check(await page.evaluate(() => window.__same(window.__snap(window.__lucid.state.session, g => g.points3d), window.__raw)),
        'Remove smoothing gives back the original 3D exactly');
    await toggle();
    check(await page.evaluate(() => window.__same(window.__snap(window.__lucid.state.session, g => g.points3d), window.__smoothed)),
        'Restore smoothing puts back the smoothed 3D exactly', await status());
    await toggle();
    await page.evaluate((MID) => { window.__lucid.state.currentFrame = MID; }, MID);
    await page.mouse.move(700, 600);
    await page.waitForTimeout(450);
    await page.hover('#tbSmooth');
    await page.click('#smoothingDropdown [data-scope="frame"]');
    await page.waitForTimeout(150);
    const c = await page.evaluate((MID) => {
        const now = window.__snap(window.__lucid.state.session, g => g.points3d);
        return {
            mid: window.__same(now, window.__smoothed, k => k.startsWith(MID + ':')),
            rest: window.__same(now, window.__raw, k => !k.startsWith(MID + ':')),
        };
    }, MID);
    check(c.mid && c.rest, `This frame writes frame ${MID} exactly as All frames did, and no other frame`, c);

    // ---- D. save -> reopen --------------------------------------------------------------
    console.log('\n-- D. save -> reopen --');
    await page.evaluate(() => { document.getElementById('statusText').textContent = ''; });
    await page.mouse.move(700, 600);
    await page.waitForTimeout(450);
    await page.click('#tbSmooth');
    await waitStatus(/Smoothed/);
    const saved = await page.evaluate(async () => {
        const fileio = await import('/import-export/file-io.js');
        const AS = await import('/ui/app-state.js');
        const F = window.__F, s = AS.state.session;
        const views = F.camNames.map(n => ({ name: n, videoWidth: 1280, videoHeight: 1024, frameCount: F.NF }));
        const videoFiles = F.camNames.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        AS.state.views = views; AS.state.videoFiles = videoFiles;
        window.__bytes = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(s, views, videoFiles));
        const slp = await fileio.parseSlpViaSleapIO(new File([window.__bytes], 'x.slp'), () => {});
        window.__smoothedBeforeSave = window.__snap(s, g => g.points3d);
        return ((slp.sessions[0].metadata || {}).lucid || {}).temporalSmoothing;
    });
    check(JSON.stringify(saved) === '{"scope":"all","method":"adaptive","k":3,"hmax":15}',
        'metadata.lucid.temporalSmoothing = scope, method, gate and longest half-window', saved);
    await page.evaluate(async () => {
        const imp = await import('/import-export/slp-import.js');
        window.__loadDone = false;
        imp.handleLoadSlpFile(new File([window.__bytes], 'adaptive.slp'))
            .then(() => { window.__loadDone = true; }, (e) => { window.__loadDone = 'ERR ' + (e && e.stack || e); });
    });
    let done = false;
    for (let i = 0; i < 240 && !done; i++) {
        const s = await page.evaluate(() => ({ done: window.__loadDone, prompt: !!document.getElementById('videoSelectOverlay') }));
        if (s.prompt) await page.keyboard.press('Escape');
        done = s.done;
        if (!done) await page.waitForTimeout(250);
    }
    check(done === true, 'the saved project reopens', done);
    const re = await page.evaluate(async () => {
        const SM = await import('/import-export/smoothing-metadata.js');
        const BTN = await import('/ui/smoothing-button.js');
        const s = window.__lucid.state.session;
        BTN.syncSmoothingButton();
        const run = SM.smoothingRunOf(s);
        return {
            same: window.__same(window.__snap(s, g => g.points3d), window.__smoothedBeforeSave),
            run: run && run.config ? { scope: run.scope, method: run.config.method, k: run.config.k, hmax: run.config.hmax } : null,
            active: document.getElementById('tbSmooth').classList.contains('active'),
        };
    });
    check(re.same, 'the reopened 3D is the smoothed 3D, bit for bit');
    check(re.run && re.run.method === 'adaptive' && re.run.k === 3 && re.run.hmax === 15 && re.run.scope === 'all',
        'the run\'s settings come back', re.run);
    check(re.active, 'the Smooth button is blue after the reopen');

    // ---- E. back to the windows -------------------------------------------------------------
    console.log('\n-- E. Windows --');
    await page.mouse.move(700, 600);
    await page.waitForTimeout(450);
    await page.hover('#tbSmooth');
    await page.click('#smoothingDropdown input[name="tbSmoothMethod"][value="0"]');
    const back = await page.evaluate(async () => (await import('/ui/settings.js')).getSmoothingParams().smoothMethod);
    check(back === 0, 'the Windows radio sets the windows back', back);
    await page.keyboard.press('Escape');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
