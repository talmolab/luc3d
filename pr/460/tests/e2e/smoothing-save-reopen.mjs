/**
 * smoothing-save-reopen.mjs — Temporal Smoothing survives File ▸ Save and a
 * reopen (import-export/smoothing-metadata.js).
 *
 * The 3D a group held before smoothing (the source every pass filters) is saved
 * in `/session_data/unsmoothed_points_3d`, row-parallel to `points_3d` with NaN
 * rows for groups that have none; the last run's scope and windows go in
 * `metadata.lucid.temporalSmoothing`. After a reopen, eager AND lazy:
 *   - the same groups are smoothed, with the same smoothed 3D and the same source
 *     bit for bit; a group re-solved before the save stays unsmoothed;
 *   - the toolbar button is blue and the last run's scope ("All frames") is lit;
 *   - a re-run (window 3) gives what window 3 gave before the save — it replaces
 *     the window-9 run instead of smoothing its output;
 *   - windows 0 restores the source exactly;
 *   - re-solving one group drops only its smoothed state, and the next save
 *     writes no source for it.
 * Multi-session: an unsmoothed session saved BEFORE the smoothed one (so the
 * table starts with padding rows), through the eager writer, reopened eagerly
 * (a lazy reopen opens one session, and the streaming writer needs every
 * session lazy). The streaming writer is run from a lazy reopen, after an edit.
 * A never-smoothed project writes neither the table nor the key.
 *
 * Fixture: 1,500 frames x 2 animals x 3 nodes = 9,000 points_3d rows, past one
 * 8,192-row staging buffer, so the table's flush and padding paths both run.
 *
 * Run: node tests/e2e/smoothing-save-reopen.mjs
 *      KEEP_DIR=<dir> also writes the saved files there (for
 *      scripts/validate_slp_sleap_compat.py).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8297);
const FRAMES = 1500, CAMS = 3, NODES = 3;
const LAPSED = [100, 0];        // [frame, animal] re-solved before the save
const KEEP_DIR = process.env.KEEP_DIR || null;

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm && window.__lucid, null, { timeout: 120000 });

    // ---- helpers on window ----
    await page.evaluate(() => {
        window.__sm = {
            // frame:identity -> Array copy of a typed array (NaN kept as null)
            snap(session, pick) {
                const out = {};
                for (const [f, gs] of session.instanceGroups) {
                    for (const g of gs) {
                        const v = pick(g);
                        out[f + ':' + g.identityId] = v ? Array.from(v, x => Number.isNaN(x) ? null : x) : null;
                    }
                }
                return out;
            },
            same(a, b) {
                const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
                if (ka.join() !== kb.join()) return { ok: false, why: 'keys', na: ka.length, nb: kb.length };
                for (const k of ka) {
                    const x = a[k], y = b[k];
                    if ((x == null) !== (y == null)) return { ok: false, why: 'presence', k, x, y };
                    if (x && (x.length !== y.length || x.some((v, i) => v !== y[i]))) return { ok: false, why: 'value', k, x, y };
                }
                return { ok: true, n: ka.length };
            },
            async layout(bytes, names) {
                const h5 = await import('h5wasm');
                const M = await h5.ready;
                const p = '/tmp/__sm_' + Math.random().toString(16).slice(2) + '.slp';
                M.FS.writeFile(p, bytes);
                const f = new h5.File(p, 'r');
                const out = {};
                try {
                    for (const n of names) {
                        const d = f.get(n);
                        out[n] = d ? { rows: d.shape[0], filters: (d.filters || []).map(x => x.id) } : null;
                    }
                } finally { f.close(); M.FS.unlink(p); }
                return out;
            },
            async lucidOf(bytes, i) {
                const fileio = await import('/import-export/file-io.js');
                const slp = await fileio.parseSlpViaSleapIO(new File([bytes], 'x.slp'), () => {});
                return (slp.sessions[i || 0].metadata || {}).lucid || {};
            },
        };
    });

    // ---- 1. fixture: smooth (window 3, then 9), lapse one group, save eager ----
    const built = await page.evaluate(async ({ FRAMES, CAMS, NODES, LAPSED }) => {
        const pd = await import('/pose/pose-data.js');
        const fileio = await import('/import-export/file-io.js');
        const TS = await import('/pose/temporal-smoothing.js');
        const SM = await import('/import-export/smoothing-metadata.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const camNames = Array.from({ length: CAMS }, (_, i) => 'cam' + i);
        const nodeNames = Array.from({ length: NODES }, (_, i) => 'n' + i);
        const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
        const cameras = camNames.map((n, i) => {
            const a = (i / CAMS) * 1.2 - 0.6;
            return new Camera(n, M, [0, 0, 0, 0, 0], [0, a, 0], [-40 * Math.sin(a), 0, 40 * (1 - Math.cos(a))], [512, 512]);
        });
        const skeleton = new Skeleton('skeleton', nodeNames, nodeNames.slice(1).map((_, i) => [i, i + 1]));
        let seed = 7;
        const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
        const mkSession = (name, frames) => {
            const s = new Session(cameras, skeleton, ['track_0', 'track_1'], name);
            s.identities = [new pd.Identity(0, 'id_0'), new pd.Identity(1, 'id_1')];
            for (let f = 0; f < frames; f++) {
                const fg = new FrameGroup(f);
                s.addFrameGroup(fg);
                const gs = [];
                for (let a = 0; a < 2; a++) {
                    const g = new InstanceGroup(f * 2 + a + 1, a);
                    camNames.forEach((cn, ci) => {
                        const inst = new Instance(nodeNames.map((_, k) =>
                            [150 + (f % 97) * 1.5 + ci * 11 + k * 3 + a * 120, 200 + (f % 89) * 1.25 + ci * 7 + k * 2 + a * 60]),
                        a, 'predicted', 0.9);
                        fg.addInstance(cn, inst);
                        g.addInstance(cn, inst);
                    });
                    const p = new Float64Array(NODES * 3);
                    for (let i = 0; i < p.length; i++) p[i] = 10 * Math.sin(f / 50 + i) + a * 40 + i + 2 * rnd();
                    if (f === 300 && a === 1) p[3] = p[4] = p[5] = NaN;   // a missing node stays missing
                    g.points3d = pd.pooledPoints3d(p);
                    g.triangulationMethod = 'dlt';
                    gs.push(g);
                }
                s.instanceGroups.set(f, gs);
            }
            return s;
        };
        const session = mkSession('Smoothed', FRAMES);
        const plain = mkSession('Plain', 40);

        // Window 3 first: what a re-run at window 3 must give after the reopen.
        const p3 = { smoothGaussianWindow: 3, smoothMedianWindow: 0, smoothMaxGap: 5, smoothMinSegment: 3 };
        const p9 = { smoothGaussianWindow: 9, smoothMedianWindow: 3, smoothMaxGap: 5, smoothMinSegment: 3 };
        // The lapsed group's own 3D, which every run reads as its source.
        const lg = session.instanceGroups.get(LAPSED[0])[LAPSED[1]];
        const lapsedValues = lg.points3d.map(v => v + 0.25);
        lg.points3d = pd.pooledPoints3d(lapsedValues.slice());
        TS.smoothSession(session, p3);
        window.__smExpW3 = window.__sm.snap(session, g => g.points3d);
        const r9 = TS.smoothSession(session, p9);
        SM.noteSmoothingRun(session, 'all', TS.resolveSmoothingParams(p9));
        // Re-solved after the run (a new array, as every re-solve assigns).
        lg.points3d = pd.pooledPoints3d(lapsedValues.slice());
        window.__smExpSmoothed = window.__sm.snap(session, g => g.points3d);
        window.__smExpSource = window.__sm.snap(session, g => pd.unsmoothedPoints3d(g.points3d));
        window.__smP3 = p3;

        const views = camNames.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: FRAMES }));
        const videoFiles = camNames.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        AS.state.sessions = [session]; AS.state.session = session; AS.state.activeSessionIdx = 0;
        AS.state.views = views; AS.state.videoFiles = videoFiles;
        window.__smEager = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(session, views, videoFiles));
        window.__smPlain = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(plain, views, videoFiles));
        window.__smPlainSession = plain;
        window.__smSmoothedSession = session;
        const nSmoothed = Object.values(window.__smExpSource).filter(Boolean).length;
        return { frames: r9.frames, nSmoothed, lapsedSmoothed: pd.isPoints3dSmoothed(lg.points3d) };
    }, { FRAMES, CAMS, NODES, LAPSED });

    console.log('\n-- 1. fixture --');
    check(built.nSmoothed === FRAMES * 2 - 1, `every group but the re-solved one is smoothed (${built.nSmoothed})`);
    check(!built.lapsedSmoothed, 'the re-solved group is not');

    // ---- 2. file contents ----
    console.log('\n-- 2. what the file holds --');
    const lay = await page.evaluate(() => window.__sm.layout(window.__smEager,
        ['session_data/points_3d', 'session_data/unsmoothed_points_3d']));
    const src = lay['session_data/unsmoothed_points_3d'];
    check(!!src && src.rows === lay['session_data/points_3d'].rows,
        'unsmoothed_points_3d is row-parallel to points_3d', lay);
    check(!!src && src.filters.includes(1), 'and gzipped', src);
    const lucid = await page.evaluate(() => window.__sm.lucidOf(window.__smEager));
    const ts = lucid.temporalSmoothing;
    check(ts && ts.scope === 'all' && ts.gaussianWindow === 9 && ts.medianWindow === 3 && ts.maxGap === 5 && ts.minSegment === 3,
        'metadata.lucid.temporalSmoothing = scope + windows of the last run', ts);
    const plainLay = await page.evaluate(() => window.__sm.layout(window.__smPlain, ['session_data/unsmoothed_points_3d']));
    const plainLucid = await page.evaluate(() => window.__sm.lucidOf(window.__smPlain));
    check(plainLay['session_data/unsmoothed_points_3d'] === null && !('temporalSmoothing' in plainLucid),
        'a never-smoothed project writes neither the table nor the key');

    // ---- loaders ----
    async function loadEager(globalName) {
        await page.evaluate(async (g) => {
            const imp = await import('/import-export/slp-import.js');
            window.__loadDone = false;
            imp.handleLoadSlpFile(new File([window[g]], g + '.slp'))
                .then(() => { window.__loadDone = true; }, (e) => { window.__loadDone = 'ERR ' + (e && e.stack || e); });
        }, globalName);
        for (let i = 0; i < 400; i++) {
            const s = await page.evaluate(() => ({ done: window.__loadDone, prompt: !!document.getElementById('videoSelectOverlay') }));
            if (s.prompt) await page.keyboard.press('Escape');
            if (s.done) return s.done;
            await page.waitForTimeout(250);
        }
        return 'timeout';
    }
    async function loadLazy(globalName) {
        await page.evaluate((g) => {
            window.__loadDone = false;
            (async () => {
                try {
                    const sl = await import('/loading/session-loader.js');
                    await sl.handleLoadProjectSlpLazy(new File([window[g]], g + '.slp'));
                    window.__loadDone = true;
                } catch (e) { window.__loadDone = 'ERR ' + String(e && e.stack || e).slice(0, 500); }
            })();
        }, globalName);
        for (let i = 0; i < 400; i++) {
            const s = await page.evaluate(() => {
                const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || ''));
                if (b) b.click();
                return window.__loadDone;
            });
            if (s) return s;
            await page.waitForTimeout(250);
        }
        return 'timeout';
    }
    const selectSession = (name) => page.evaluate(async (name) => {
        const AS = await import('/ui/app-state.js');
        const i = AS.state.sessions.findIndex(s => s.name === name);
        if (i < 0) return AS.state.sessions.map(s => s.name).join(', ');
        AS.state.session = AS.state.sessions[i];
        AS.state.activeSessionIdx = i;
        return true;
    }, name);

    // The whole after-reopen contract, on the active session.
    async function verifyReopened(label, { rerun = true } = {}) {
        const res = await page.evaluate(async ({ rerun }) => {
            const pd = await import('/pose/pose-data.js');
            const TS = await import('/pose/temporal-smoothing.js');
            const AS = await import('/ui/app-state.js');
            const BTN = await import('/ui/smoothing-button.js');
            const s = AS.state.session;
            const out = { lazy: !!s.lazyLoader };
            out.smoothed = window.__sm.same(window.__sm.snap(s, g => g.points3d), window.__smExpSmoothed);
            out.source = window.__sm.same(window.__sm.snap(s, g => pd.unsmoothedPoints3d(g.points3d)), window.__smExpSource);
            BTN.syncSmoothingButton();
            const q = (sel) => document.querySelector(sel);
            out.button = q('#tbSmooth').classList.contains('active');
            out.allLit = q('#smoothingDropdown [data-scope="all"]').classList.contains('applied');
            out.frameLit = q('#smoothingDropdown [data-scope="frame"]').classList.contains('applied');
            // Re-run at window 3: must equal window 3 before the save.
            if (rerun) {
                TS.smoothSession(s, window.__smP3);
                out.rerun = window.__sm.same(window.__sm.snap(s, g => g.points3d), window.__smExpW3);
            }
            // Windows 0: the source, exactly (an unsmoothed group keeps its own 3D).
            TS.unsmoothSession(s);
            const expRestored = {};
            for (const k in window.__smExpSource) expRestored[k] = window.__smExpSource[k] || window.__smExpSmoothed[k];
            out.restored = window.__sm.same(window.__sm.snap(s, g => g.points3d), expRestored);
            BTN.syncSmoothingButton();
            out.buttonAfterRestore = q('#tbSmooth').classList.contains('active');
            return out;
        }, { rerun });
        check(res.smoothed.ok, `${label}: the smoothed 3D is what was saved (${res.smoothed.n} groups)`, res.smoothed.ok ? undefined : res.smoothed);
        check(res.source.ok, `${label}: every source is back bit for bit, the re-solved group has none`, res.source.ok ? undefined : res.source);
        check(res.button && res.allLit && !res.frameLit, `${label}: button blue, "All frames" lit, "This frame" not`, res);
        if (rerun) check(res.rerun.ok, `${label}: a window-3 re-run gives window 3's result (replaces, never stacks)`, res.rerun.ok ? undefined : res.rerun);
        check(res.restored.ok, `${label}: windows 0 restores the source exactly`, res.restored.ok ? undefined : res.restored);
        check(!res.buttonAfterRestore, `${label}: button off after the restore`);
        return res;
    }

    console.log('\n-- 3. eager reopen --');
    let r = await loadEager('__smEager');
    check(r === true, 'handleLoadSlpFile completed', r);
    let v = await verifyReopened('eager');
    check(!v.lazy, 'precondition: eager');

    console.log('\n-- 4. lazy reopen --');
    r = await loadLazy('__smEager');
    check(r === true, 'handleLoadProjectSlpLazy completed', r);
    v = await verifyReopened('lazy');
    check(v.lazy, 'precondition: the lazy reopen IS lazy');

    // ---- 5. multi-session (the eager writer: a lazy reopen is one session) ----
    console.log('\n-- 5. two sessions --');
    r = await loadEager('__smEager');
    check(r === true, 'eager reopen again', r);
    const multiEager = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const SL = await import('/import-export/save-load.js');
        // The unsmoothed session first, so the table starts with padding rows.
        AS.state.sessions = [window.__smPlainSession, AS.state.session];
        AS.state.activeSessionIdx = 1;
        delete window.showSaveFilePicker;
        const captured = [];
        const realCOU = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => { captured.push(blob); return realCOU(blob); };
        try { await SL.saveProjectSlp(); }
        catch (e) { return { err: String(e && e.stack || e).slice(0, 500) }; }
        finally { URL.createObjectURL = realCOU; }
        if (!captured.length) return { err: 'no blob' };
        window.__smMultiEager = new Uint8Array(await captured[captured.length - 1].arrayBuffer());
        return { bytes: window.__smMultiEager.length };
    });
    check(!multiEager.err, 'saveProjectSlp (eager, 2 sessions) completed', multiEager.err);
    let mlay = await page.evaluate(() => window.__sm.layout(window.__smMultiEager,
        ['session_data/points_3d', 'session_data/unsmoothed_points_3d']));
    check(mlay['session_data/unsmoothed_points_3d'] && mlay['session_data/unsmoothed_points_3d'].rows === mlay['session_data/points_3d'].rows,
        'eager, 2 sessions: the table spans both sessions\' rows', mlay);

    r = await loadEager('__smMultiEager');
    check(r === true, 'eager reopen of the 2-session file completed', r);
    const plainState = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const pd = await import('/pose/pose-data.js');
        const p = AS.state.sessions.find(x => x.name === 'Plain');
        let n = 0;
        if (p) for (const [, gs] of p.instanceGroups) for (const g of gs) if (pd.isPoints3dSmoothed(g.points3d)) n++;
        return { sessions: AS.state.sessions.map(x => x.name), plainSmoothed: n, found: !!p,
            plainIdx: AS.state.sessions.indexOf(p) };
    });
    check(plainState.found && plainState.plainSmoothed === 0, 'the unsmoothed session reopens unsmoothed', plainState);
    const plainLucid2 = await page.evaluate((i) => window.__sm.lucidOf(window.__smMultiEager, i), plainState.plainIdx);
    check(!('temporalSmoothing' in plainLucid2), 'the unsmoothed session carries no temporalSmoothing key');
    check((await selectSession('Smoothed')) === true, 'the smoothed session is there', await selectSession('Smoothed'));
    await verifyReopened('eager, 2 sessions');

    // ---- 6. streaming writer from a lazy reopen; an edit after the reopen ----
    console.log('\n-- 6. streaming writer, with an edit after the reopen --');
    r = await loadLazy('__smEager');
    check(r === true, 'lazy reopen again', r);
    const edit = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const pd = await import('/pose/pose-data.js');
        const saveLoad = await import('/import-export/save-load.js');
        const s = AS.state.session;
        // Re-solve one group (a new array, as every re-solve assigns): only its
        // smoothed state may lapse.
        const eg = s.instanceGroups.get(200)[1];
        eg.points3d = pd.pooledPoints3d(eg.points3d.slice());
        window.__smExpSource['200:1'] = null;
        window.__smExpSmoothed['200:1'] = Array.from(eg.points3d, x => Number.isNaN(x) ? null : x);
        const neighbourStill = pd.isPoints3dSmoothed(s.instanceGroups.get(201)[1].points3d);
        try {
            window.__smStream = await saveLoad.saveAllSessionsStreaming(AS.state.sessions);
        } catch (e) { return { err: String(e && e.stack || e).slice(0, 500) }; }
        return { neighbourStill, edited: pd.isPoints3dSmoothed(eg.points3d) };
    });
    check(!edit.err, 'saveAllSessionsStreaming completed', edit.err);
    check(!edit.edited && edit.neighbourStill, 're-solving a group after the reopen drops only its smoothing', edit);
    const slay = await page.evaluate(() => window.__sm.layout(window.__smStream,
        ['session_data/points_3d', 'session_data/unsmoothed_points_3d']));
    check(slay['session_data/unsmoothed_points_3d'] && slay['session_data/unsmoothed_points_3d'].rows === slay['session_data/points_3d'].rows,
        'streamed: the table is row-parallel to points_3d', slay);
    // No window-3 comparison from here: the edited group's new 3D is the
    // source its neighbours' window-3 answer now reads.
    r = await loadLazy('__smStream');
    check(r === true, 'lazy reopen of the streamed file completed', r);
    await verifyReopened('streamed, lazy', { rerun: false });
    r = await loadEager('__smStream');
    check(r === true, 'eager reopen of the streamed file completed', r);
    await verifyReopened('streamed, eager', { rerun: false });

    if (KEEP_DIR) {
        for (const g of ['__smEager', '__smMultiEager', '__smStream', '__smPlain']) {
            const b64 = await page.evaluate((g) => {
                const bytes = window[g]; let s = ''; const C = 0x8000;
                for (let o = 0; o < bytes.length; o += C) s += String.fromCharCode.apply(null, bytes.subarray(o, o + C));
                return btoa(s);
            }, g);
            fs.writeFileSync(path.join(KEEP_DIR, g.replace('__sm', 'smoothing-') + '.slp'), Buffer.from(b64, 'base64'));
        }
        console.log('  (kept the files in ' + KEEP_DIR + ')');
    }

    check(errs.length === 0, 'no page errors', errs.slice(0, 3));
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
