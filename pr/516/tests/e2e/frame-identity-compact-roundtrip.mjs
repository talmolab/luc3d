/**
 * frame-identity-compact-roundtrip.mjs — a project's per-detection identities
 * (`Session.frameIdentityMap`) survive save + reopen when the `.slp` stores
 * only the entries its instance groups do not already imply, and the large 2D
 * and group tables come out gzipped.
 *
 * After Track All the map holds one entry per grouped 2D detection, each equal
 * to its group's identity — 101 MB of JSON on a real 8-camera project — so the
 * writers now store only the exceptions (`frameIdentityMap`), a marker
 * (`frameIdentityMapFromGroups`) and the keys the groups imply but the map did
 * not hold (`frameIdentityMapDropped`), and the readers rebuild the rest from
 * the groups (import-export/frame-identity-metadata.js).
 *
 * The fixture is Track-All-shaped (every tracked member mapped to its group's
 * identity), plus one of each case the rebuild has to get right:
 *   a. a view whose entry was switched to another identity      -> listed
 *   b. an "explicit no identity" (-1) on a key no group implies   -> listed
 *   c. a grouped detection whose entry was removed                -> dropped
 *   d. two groups claiming the same (frame, camera, track)        -> listed
 *   e. the same collision with the entry removed                  -> dropped
 *   f. an entry for a trackless member (track -1)                 -> listed
 *
 * Path: eager writer (buildSlpLabelsAllViews + saveSlpToBytes) -> reopen EAGER
 * (handleLoadSlpFile) and LAZY (handleLoadProjectSlpLazy) -> streaming writer
 * (saveAllSessionsStreaming) from the lazy project -> reopen both ways again.
 * Every reopen must give back the saved map entry for entry. Plus: the file
 * layout (gzip on the overflowing tables, none on the small ones), the
 * fallback to the full list when the exceptions would not be smaller, and a
 * negative control showing the listed entries alone are NOT the map.
 *
 * Run: node tests/e2e/frame-identity-compact-roundtrip.mjs
 *      KEEP_DIR=<dir> also writes the eager and streamed files there (e.g. to
 *      check them with scripts/validate_slp_sleap_compat.py).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8251);
// 1,500 frames x 3 cameras x 2 animals = 9,000 instances: past one 8,192-row
// staging buffer, so the eager writer's instances / pred_points / members
// tables take the chunked (gzipped) path while frames (4,500 rows) does not.
const FRAMES = 1500, CAMS = 3, NODES = 3;
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

    // Helpers live on window so later evaluate() calls can reach them.
    await page.evaluate(() => {
        window.__fim = {
            sorted(session) {
                return session.exportFrameIdentityEntries()
                    .map(e => e[0] + '=' + e[1]).sort();
            },
            async lucidOf(bytes) {
                const fileio = await import('/import-export/file-io.js');
                const slp = await fileio.parseSlpViaSleapIO(new File([bytes], 'x.slp'), () => {});
                return (slp.sessions[0].metadata || {}).lucid || {};
            },
            // Each dataset's row count and HDF5 filter ids (1 = gzip), read from the file.
            async layout(bytes, names) {
                const h5 = await import('h5wasm');
                const M = await h5.ready;
                const p = '/tmp/__fim_' + Math.random().toString(16).slice(2) + '.slp';
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
        };
    });

    // ---- 1. build the fixture, save it through the EAGER writer ----
    const built = await page.evaluate(async ({ FRAMES, CAMS, NODES }) => {
        const pd = await import('/pose/pose-data.js');
        const fileio = await import('/import-export/file-io.js');
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
        const tracks = Array.from({ length: 6 }, (_, i) => 'track_' + i);
        const session = new Session(cameras, skeleton, tracks, 'CompactFim');
        session.identities = [new pd.Identity(0, 'id_0'), new pd.Identity(1, 'id_1')];
        const xy = (f, c, k, a) => [150 + (f % 97) * 1.5 + c * 11 + k * 3 + a * 120, 200 + (f % 89) * 1.25 + c * 7 + k * 2 + a * 60];
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            const gs = [];
            for (let a = 0; a < 2; a++) {
                const g = new InstanceGroup(f * 2 + a + 1, a);
                camNames.forEach((cn, ci) => {
                    // Members carry the track of their animal; the collisions
                    // (d, e) give animal 1's cam0 member animal 0's track, the
                    // trackless case (f) clears animal 0's cam2 track.
                    let t = a;
                    if ((f === 13 || f === 14) && a === 1 && ci === 0) t = 0;
                    if (f === 15 && a === 0 && ci === 2) t = null;
                    const inst = new Instance(nodeNames.map((_, k) => xy(f, ci, k, a)), t, 'predicted', 0.9);
                    fg.addInstance(cn, inst);
                    g.addInstance(cn, inst);
                });
                g.points3d = new Float64Array(NODES * 3).map((_, i) => (f % 31) + i * 0.5 + a * 40);
                gs.push(g);
            }
            session.instanceGroups.set(f, gs);
        }
        // Track-All-shaped map: every tracked member -> its group's identity.
        for (const [f, gs] of session.instanceGroups) {
            for (const g of gs) for (const [cn, inst] of g.instances) {
                if (inst.trackIdx != null && inst.trackIdx >= 0) session.setFrameIdentity(f, cn, inst.trackIdx, g.identityId);
            }
        }
        session.setFrameIdentity(10, 'cam1', 0, 1);      // a. switched view
        session.setFrameIdentity(11, 'cam0', 5, -1);     // b. explicit none, no group
        session.deleteFrameIdentity(12, 'cam2', 1);      // c. removed
        // d. frame 13 collision: the loop above left (13,cam0,0) = 1 (last group wins)
        session.deleteFrameIdentity(14, 'cam0', 0);      // e. collision, removed
        session.setFrameIdentity(15, 'cam2', null, 0);   // f. trackless member's entry

        const views = camNames.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: FRAMES }));
        const videoFiles = camNames.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        AS.state.sessions = [session]; AS.state.session = session; AS.state.activeSessionIdx = 0;
        AS.state.views = views; AS.state.videoFiles = videoFiles;
        const ex = session.frameIdentityExceptions();
        const fullJsonBytes = JSON.stringify(session.exportFrameIdentityEntries()).length;
        const labels = fileio.buildSlpLabelsAllViews(session, views, videoFiles);
        window.__fimEager = await window.SleapIO.saveSlpToBytes(labels);
        window.__fimExpected = window.__fim.sorted(session);

        // Fallback fixture: a map that agrees with no group -> the full list.
        const contra = new Session(cameras, skeleton, tracks, 'Contra');
        contra.identities = session.identities;
        for (const [f, gs] of session.instanceGroups) contra.instanceGroups.set(f, gs);
        for (const fr of session.frameGroups.values()) contra.addFrameGroup(fr);
        for (const [f, gs] of session.instanceGroups) {
            for (const g of gs) for (const [cn, inst] of g.instances) {
                if (inst.trackIdx != null && inst.trackIdx >= 0) contra.setFrameIdentity(f, cn, inst.trackIdx, 1 - g.identityId);
            }
        }
        window.__fimContraExpected = window.__fim.sorted(contra);
        window.__fimContra = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(contra, views, videoFiles));
        return {
            mapSize: session.frameIdentityMap.size,
            entries: ex.entries.map(e => e[0] + '=' + e[1]).sort(),
            dropped: ex.dropped.slice().sort(),
            fullJsonBytes,
            bytes: window.__fimEager.length,
        };
    }, { FRAMES, CAMS, NODES });

    console.log('\n-- 1. what the writer keeps --');
    // 9,000 members - 1 trackless - 2 collisions sharing a key, then +b -c -e +f.
    check(built.mapSize === FRAMES * CAMS * 2 - 1 - 2 + 1 - 1 - 1 + 1,
        'fixture map is Track-All-shaped (one entry per tracked member, plus/minus the edits)', built.mapSize);
    check(JSON.stringify(built.entries) === JSON.stringify(['10:cam1:0=1', '11:cam0:5=-1', '13:cam0:0=1', '15:cam2:-1=0']),
        'exceptions = the switched view, the explicit none, the collision, the trackless entry', built.entries);
    check(JSON.stringify(built.dropped) === JSON.stringify(['12:cam2:1', '14:cam0:0']),
        'dropped = the removed detection and the removed collision', built.dropped);

    const eagerLucid = await page.evaluate(async () => {
        const l = await window.__fim.lucidOf(window.__fimEager);
        return { marker: l.frameIdentityMapFromGroups, n: (l.frameIdentityMap || []).length,
            dropped: (l.frameIdentityMapDropped || []).length, bytes: JSON.stringify(l.frameIdentityMap).length };
    });
    check(eagerLucid.marker === true && eagerLucid.n === 4 && eagerLucid.dropped === 2,
        'eager file: marker set, 4 listed entries, 2 dropped keys', eagerLucid);
    check(eagerLucid.bytes * 100 < built.fullJsonBytes,
        `eager file: the stored list is ${eagerLucid.bytes} B vs ${built.fullJsonBytes} B for the full map`);

    // ---- 2. file layout: gzip where the table overflowed, none where not ----
    console.log('\n-- 2. eager file layout --');
    const lay = await page.evaluate(() => window.__fim.layout(window.__fimEager,
        ['frames', 'instances', 'pred_points', 'points', 'session_data/instance_group_members',
            'session_data/instance_groups', 'session_data/frame_groups', 'session_data/points_3d']));
    const gz = (d) => !!d && d.filters.includes(1);
    check(gz(lay.instances) && lay.instances.rows === FRAMES * CAMS * 2, 'instances (9,000 rows) is gzipped', lay.instances);
    check(gz(lay.pred_points), 'pred_points is gzipped', lay.pred_points);
    check(gz(lay['session_data/instance_group_members']), 'instance_group_members is gzipped', lay['session_data/instance_group_members']);
    check(!gz(lay.frames), 'frames (4,500 rows, under one buffer) stays uncompressed', lay.frames);
    check(!gz(lay['session_data/frame_groups']),
        'frame_groups (1,500 rows) stays uncompressed', lay['session_data/frame_groups']);
    check(gz(lay['session_data/points_3d']), 'points_3d keeps its gzip', lay['session_data/points_3d']);

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
    const reopened = (expectedGlobal) => page.evaluate((eg) => {
        const s = window.__lucid.state.session;
        const got = window.__fim.sorted(s);
        const exp = window[eg];
        const gotSet = new Set(got), expSet = new Set(exp);
        return {
            size: got.length, expected: exp.length,
            same: got.length === exp.length && got.every((k, i) => k === exp[i]),
            missing: exp.filter(k => !gotSet.has(k)).slice(0, 5),
            extra: got.filter(k => !expSet.has(k)).slice(0, 5),
            lazy: !!s.lazyLoader,
        };
    }, expectedGlobal);

    console.log('\n-- 3. reopen the eager file --');
    let r = await loadEager('__fimEager');
    check(r === true, 'handleLoadSlpFile completed', r);
    let m = await reopened('__fimExpected');
    check(m.same, `eager reopen gives back the map entry for entry (${m.size}/${m.expected})`, m.same ? undefined : m);

    r = await loadLazy('__fimEager');
    check(r === true, 'handleLoadProjectSlpLazy completed', r);
    m = await reopened('__fimExpected');
    check(m.lazy, 'precondition: the lazy reopen IS lazy');
    check(m.same, `lazy reopen gives back the map entry for entry (${m.size}/${m.expected})`, m.same ? undefined : m);

    // ---- 4. streaming writer, from the lazy project ----
    console.log('\n-- 4. streaming writer (from the lazy reopen) --');
    const streamed = await page.evaluate(async () => {
        const saveLoad = await import('/import-export/save-load.js');
        const AS = await import('/ui/app-state.js');
        try {
            window.__fimStream = await saveLoad.saveAllSessionsStreaming(AS.state.sessions);
        } catch (e) { return { err: String(e && e.stack || e).slice(0, 500) }; }
        const l = await window.__fim.lucidOf(window.__fimStream);
        return { marker: l.frameIdentityMapFromGroups, n: (l.frameIdentityMap || []).length,
            dropped: (l.frameIdentityMapDropped || []).length };
    });
    check(!streamed.err, 'saveAllSessionsStreaming completed', streamed.err);
    check(streamed.marker === true && streamed.n === 4 && streamed.dropped === 2,
        'streamed file: marker set, 4 listed entries, 2 dropped keys', streamed);
    const slay = await page.evaluate(() => window.__fim.layout(window.__fimStream, ['frames', 'instances', 'pred_points', 'points']));
    check(gz(slay.frames) && gz(slay.instances) && gz(slay.pred_points) && gz(slay.points),
        'streamed file: all four 2D tables gzipped (the streaming writer always chunks them)', slay);
    if (KEEP_DIR) {
        for (const g of ['__fimEager', '__fimStream']) {
            const b64 = await page.evaluate((g) => {
                const bytes = window[g]; let s = ''; const C = 0x8000;
                for (let o = 0; o < bytes.length; o += C) s += String.fromCharCode.apply(null, bytes.subarray(o, o + C));
                return btoa(s);
            }, g);
            fs.writeFileSync(path.join(KEEP_DIR, g.replace('__fim', 'fim-') + '.slp'), Buffer.from(b64, 'base64'));
        }
        console.log('  (kept the eager and streamed files in ' + KEEP_DIR + ')');
    }

    r = await loadLazy('__fimStream');
    check(r === true, 'lazy reopen of the streamed file completed', r);
    m = await reopened('__fimExpected');
    check(m.same, `lazy reopen of the streamed file gives back the map (${m.size}/${m.expected})`, m.same ? undefined : m);
    r = await loadEager('__fimStream');
    check(r === true, 'eager reopen of the streamed file completed', r);
    m = await reopened('__fimExpected');
    check(m.same, `eager reopen of the streamed file gives back the map (${m.size}/${m.expected})`, m.same ? undefined : m);
    const pts = await page.evaluate(() => {
        const s = window.__lucid.state.session;
        const g = (s.instanceGroups.get(700) || [])[1];
        const inst = g && g.instances.get('cam2');
        return inst ? inst.getPoint(2) : null;
    });
    const expXY = [150 + (700 % 97) * 1.5 + 2 * 11 + 2 * 3 + 120, 200 + (700 % 89) * 1.25 + 2 * 7 + 2 * 2 + 60];
    check(pts && Math.abs(pts[0] - expXY[0]) < 1e-3 && Math.abs(pts[1] - expXY[1]) < 1e-3,
        '2D read back out of the gzipped tables is the 2D that was saved', { got: pts, expected: expXY });

    // ---- 5. fallback + negative control ----
    console.log('\n-- 5. fallback and negative control --');
    const contra = await page.evaluate(async () => {
        const l = await window.__fim.lucidOf(window.__fimContra);
        return { marker: l.frameIdentityMapFromGroups, n: (l.frameIdentityMap || []).length, expected: window.__fimContraExpected.length };
    });
    check(contra.marker === undefined && contra.n === contra.expected,
        'a map the groups do not imply is written in full, without the marker', contra);
    r = await loadEager('__fimContra');
    m = await reopened('__fimContraExpected');
    check(r === true && m.same, 'and it reopens unchanged', m.same ? undefined : m);

    const control = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const l = await window.__fim.lucidOf(window.__fimEager);
        const s = new pd.Session(window.__lucid.state.session.cameras, window.__lucid.state.session.skeleton, [], 'ctl');
        s.ingestFrameIdentityEntries(l.frameIdentityMap);
        return { size: s.frameIdentityMap.size, expected: window.__fimExpected.length };
    });
    check(control.size === 4 && control.size !== control.expected,
        'negative control: the listed entries alone are NOT the map — the rebuild from groups is what restores it', control);

    check(errs.length === 0, 'no page errors', errs.slice(0, 3));
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
