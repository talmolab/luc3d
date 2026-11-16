/**
 * track-reassign-carries-forward.mjs — picking a different track for a
 * detection in the Instances panel's Track dropdown (`swapAssignTrack`,
 * ui/identity-assignment.js) must apply from that frame through the END of
 * the recording, on that camera only:
 *   - the detection that already holds the picked track takes the old one (a swap);
 *   - a track nobody holds is a plain reassign;
 *   - earlier frames, and the other cameras, keep their tracks.
 * tests/test-identity.js has tests for this, but they can never run: the
 * classic runner cannot load ui/identity-assignment.js (it imports app.js).
 *
 * Three fixtures, each edited through the real dropdown, with every detection
 * told apart by position (animal A on the left, B on the right):
 *   1. eager, ungrouped: a swap, a plain reassign on another camera, then a
 *      swap back further on (edits stack);
 *   2. eager, grouped: the group row's dropdown changes every camera;
 *   3. lazy (saved, then reopened with handleLoadProjectSlpLazy): frames that
 *      were not loaded when the edit was made must come back from the file's
 *      data already changed (luc3d #195 writes the edit to the store).
 *
 * Run: node tests/e2e/track-reassign-carries-forward.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8257);
const CAMS = ['cam0', 'cam1', 'cam2'];
const EAGER_FRAMES = 60;
const LAZY_FRAMES = 2000;      // > LAZY_PLAYBACK_AHEAD (600) past the edit, so later frames are not loaded

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (!c && extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
    if (!c) fails++;
};

// What each (frame, camera) should hold, as "A<track>,B<track>", after `edits`
// (applied in order). An edit {frame, cam, from, to} swaps from<->to on `cam`
// (every camera when cam is null) from `frame` on.
function expected(frames, edits) {
    const out = {};
    for (const f of frames) {
        for (const cam of CAMS) {
            let tr = { A: 0, B: 1 };
            for (const e of edits) {
                if (f < e.frame || (e.cam != null && e.cam !== cam)) continue;
                for (const k of ['A', 'B']) {
                    if (tr[k] === e.from) tr[k] = e.to; else if (tr[k] === e.to) tr[k] = e.from;
                }
            }
            out[f + ':' + cam] = 'A' + tr.A + ',B' + tr.B;
        }
    }
    return out;
}
function compare(label, got, want) {
    const bad = Object.keys(want).filter(k => got[k] !== want[k]);
    check(bad.length === 0, `${label}: ${Object.keys(want).length - bad.length}/${Object.keys(want).length} (frame, camera) pairs as expected`,
        bad.slice(0, 6).map(k => `${k} got ${got[k]} want ${want[k]}`));
}
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const fixturePath = path.join(repoRoot, '_track-reassign-fixture.slp');

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 300)); });
    let sinkFd = null;
    await page.exposeFunction('__tstWrite', (b64) => {
        if (sinkFd === null) sinkFd = fs.openSync(fixturePath, 'w');
        fs.writeSync(sinkFd, Buffer.from(b64, 'base64'));
    });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.SleapIO && window.h5wasm && window.__lucid && window.__lucid.state, null, { timeout: 120000 });

    // In-page helpers: build a fixture, read every (frame, camera), tag a dropdown.
    await page.evaluate((CAMS) => {
        window.__tr = {
            // Two animals per camera per frame: A (left, track 0), B (right, track 1).
            async build({ frames, grouped, install }) {
                const pd = await import('./pose/pose-data.js');
                const AS = await import('./ui/app-state.js');
                const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
                const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
                const cams = CAMS.map((n, i) => new Camera(n, M, [0, 0, 0, 0, 0], [0, 0.3 * (i - 1), 0], [12 * (1 - i), 0, 0], [512, 512]));
                const s = new Session(cams, new Skeleton('skeleton', ['nose', 'tail'], [[0, 1]]), ['track_0', 'track_1', 'track_2'], 'TrackReassign');
                for (let f = 0; f < frames; f++) {
                    const fg = new FrameGroup(f);
                    s.addFrameGroup(fg);
                    const groups = [];
                    for (let a = 0; a < 2; a++) {
                        const g = grouped ? new InstanceGroup(f * 2 + a + 1, -1) : null;
                        CAMS.forEach((cn, ci) => {
                            const x = (a === 0 ? 100 : 380) + (f % 50) * 0.5 + ci * 3;
                            const inst = new Instance([[x, 200 + ci], [x + 20, 230 + ci]], a, 'predicted', 0.9);
                            if (g) { fg.addInstance(cn, inst); g.addInstance(cn, inst); }
                            else s.addUnlinkedInstance(f, cn, inst);
                        });
                        if (g) groups.push(g);
                    }
                    if (grouped) s.instanceGroups.set(f, groups);
                }
                if (install) {
                    AS.state.session = s; AS.state.sessions = [s]; AS.state.activeSessionIdx = 0;
                    AS.state.totalFrames = frames; AS.state.currentFrame = 0;
                    AS.state.triangulationResults.clear();
                }
                return s;
            },
            // "A<track>,B<track>" for each (frame, camera) of `frames` that is loaded.
            read(frames) {
                const s = window.__lucid.state.session, out = {};
                for (const f of frames) {
                    const fg = s.getFrameGroup(f);
                    for (const cn of CAMS) {
                        if (!fg) { out[f + ':' + cn] = 'not loaded'; continue; }
                        const insts = fg.getInstances(cn).concat(fg.getUnlinkedInstances(cn).map(u => u.instance));
                        out[f + ':' + cn] = insts.map(i => (i.getPoint(0)[0] < 256 ? 'A' : 'B') + i.trackIdx).sort().join(',');
                    }
                }
                return out;
            },
            // Show `frame` in the Instances panel and give id="__pick" to the
            // Track dropdown of the row on `cam` (null: a group row) now on track `from`.
            async tag(frame, cam, from) {
                const AS = await import('./ui/app-state.js');
                const IP = await import('./ui/info-panel.js');
                AS.state.currentFrame = frame;
                IP.updateInfoPanel();
                const old = document.getElementById('__pick');
                if (old) old.removeAttribute('id');
                const pickSel = (tr) => tr.querySelector('td:first-child select');
                if (cam == null) {
                    for (const tr of document.querySelectorAll('#instanceGroupsTable tbody tr')) {
                        const sel = pickSel(tr);
                        if (sel && sel.value === String(from)) { sel.id = '__pick'; return true; }
                    }
                    return false;
                }
                let camera = null;
                for (const tr of document.querySelectorAll('#unlinkedTable tbody tr')) {
                    if (tr.classList.contains('unlinked-camera-header')) { camera = tr.textContent.trim(); continue; }
                    const sel = pickSel(tr);
                    if (camera === cam && sel && sel.value === String(from)) { sel.id = '__pick'; return true; }
                }
                return false;
            },
        };
    }, CAMS);

    // Pick track `to` in the dropdown of the row on `cam` (null: group row) holding `from`, at `frame`.
    const pick = async ({ frame, cam, from, to }) => {
        const found = await page.evaluate(({ frame, cam, from }) => window.__tr.tag(frame, cam, from), { frame, cam, from });
        check(found, `frame ${frame}: found the ${cam || 'group'} row on track_${from}`);
        if (!found) return;
        const sel = page.locator('#__pick');
        await sel.focus();                       // the real select fills its list on focus
        await sel.selectOption(String(to));
        await page.waitForFunction(() => !document.getElementById('__pick'), null, { timeout: 10000 })
            .catch(() => {});                    // the handler re-renders the panel
    };

    // ---- 1. eager, ungrouped ---------------------------------------------------
    console.log('\n• eager, ungrouped detections');
    await page.evaluate((frames) => window.__tr.build({ frames, grouped: false, install: true }), EAGER_FRAMES);
    const all = range(0, EAGER_FRAMES), edits = [];
    compare('before any edit', await page.evaluate((f) => window.__tr.read(f), all), expected(all, edits));

    // A swap: cam1's A takes track_1 at frame 20, so B (which held it) takes track_0.
    edits.push({ frame: 20, cam: 'cam1', from: 0, to: 1 });
    await pick(edits[0]);
    compare('swap on cam1 from frame 20', await page.evaluate((f) => window.__tr.read(f), all), expected(all, edits));

    // A plain reassign: cam0's B to track_2, which nobody holds, at frame 40.
    edits.push({ frame: 40, cam: 'cam0', from: 1, to: 2 });
    await pick(edits[1]);
    compare('plain reassign on cam0 from frame 40', await page.evaluate((f) => window.__tr.read(f), all), expected(all, edits));

    // Swap back on cam1 at frame 50: frames 20–49 keep the first swap.
    edits.push({ frame: 50, cam: 'cam1', from: 1, to: 0 });
    await pick(edits[2]);
    compare('swap back on cam1 from frame 50', await page.evaluate((f) => window.__tr.read(f), all), expected(all, edits));

    // ---- 2. eager, grouped -------------------------------------------------------
    console.log('\n• eager, grouped detections (group row dropdown)');
    await page.evaluate((frames) => window.__tr.build({ frames, grouped: true, install: true }), EAGER_FRAMES);
    const gEdits = [{ frame: 30, cam: null, from: 0, to: 1 }];
    compare('before the edit', await page.evaluate((f) => window.__tr.read(f), all), expected(all, []));
    await pick(gEdits[0]);
    compare('group A to track_1 from frame 30, every camera', await page.evaluate((f) => window.__tr.read(f), all), expected(all, gEdits));

    // ---- 3. lazy: saved, reopened, edited ----------------------------------------
    console.log('\n• lazy project (saved, reopened)');
    await page.evaluate(async (frames) => {
        const fileio = await import('./import-export/file-io.js');
        const s = await window.__tr.build({ frames, grouped: false, install: false });
        const views = s.cameras.map(c => ({ name: c.name, videoWidth: 512, videoHeight: 512, frameCount: frames }));
        const videoFiles = s.cameras.map(c => ({ name: c.name, assignedCamera: c.name, videoPath: c.name + '.mp4' }));
        const bytes = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(s, views, videoFiles));
        let str = ''; const C = 0x8000;
        for (let o = 0; o < bytes.length; o += C) str += String.fromCharCode.apply(null, bytes.subarray(o, o + C));
        await window.__tstWrite(btoa(str));
    }, LAZY_FRAMES);
    if (sinkFd !== null) { fs.closeSync(sinkFd); sinkFd = null; }

    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__tstPick'; inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
    });
    await page.setInputFiles('#__tstPick', fixturePath);
    await page.evaluate(() => {
        window.__tstLoad = { done: false, err: null };
        (async () => {
            try {
                const sl = await import('./loading/session-loader.js');
                await sl.handleLoadProjectSlpLazy(document.getElementById('__tstPick').files[0]);
                window.__tstLoad.done = true;
            } catch (e) { window.__tstLoad.err = String(e && e.stack || e).slice(0, 500); }
        })();
    });
    for (let i = 0; i < 400; i++) {
        const st = await page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || ''));
            if (b) { b.click(); return 'clicked'; }
            return window.__tstLoad.done ? 'done' : (window.__tstLoad.err ? 'err' : 'wait');
        });
        if (st === 'done' || st === 'err') break;
        await new Promise(r => setTimeout(r, 250));
    }
    const loadErr = await page.evaluate(() => window.__tstLoad.err);
    check(!loadErr, 'lazy reopen completed', loadErr || undefined);

    const F = 400, LATER = [1500, 1700, 1999], EARLIER = [0, 100];
    const pre = await page.evaluate(async ({ F, LATER, EARLIER }) => {
        const tri = await import('./pose/triangulation.js');
        await tri.ensureLazyFrameData(F);
        const s = window.__lucid.state.session;
        return { lazy: !!s.lazyLoader, resident: s.frameGroups.size, laterLoaded: LATER.filter(f => s.frameGroups.has(f)),
            earlierLoaded: EARLIER.filter(f => s.frameGroups.has(f)), atF: window.__tr.read([F]) };
    }, { F, LATER, EARLIER });
    check(pre.lazy && pre.laterLoaded.length === 0,
        `lazy, and frames ${LATER.join(', ')} are not loaded when the edit is made`, pre);
    compare(`frame ${F} before the edit`, pre.atF, expected([F], []));

    const lEdits = [{ frame: F, cam: 'cam1', from: 0, to: 1 }];
    await pick(lEdits[0]);
    const lazyFrames = [...EARLIER, F - 1, F, F + 1, F + 300, ...LATER];
    const got = await page.evaluate(async (frames) => {
        const tri = await import('./pose/triangulation.js');
        for (const f of frames) await tri.ensureLazyFrameData(f);   // loads the not-loaded ones from the store
        return window.__tr.read(frames);
    }, lazyFrames);
    compare(`swap on cam1 from frame ${F}, read back after loading every frame`, got, expected(lazyFrames, lEdits));

    check(errs.length === 0, 'no page or console errors', errs.slice(0, 3));
    await browser.close();
} finally {
    server.kill();
    if (!process.env.KEEP) { try { fs.unlinkSync(fixturePath); } catch {} }
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
