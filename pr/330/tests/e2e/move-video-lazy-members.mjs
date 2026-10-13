/**
 * move-video-lazy-members.mjs — moving a view to another session must re-solve
 * the origin session's groups from REAL 2D on a lazy project.
 *
 * `moveVideosToSession` (ui/sessions-panes.js) drops the moved camera from every
 * InstanceGroup of the origin session and re-triangulates the rest. On a lazy
 * project a member of a frame that is not resident is a `_lazy2d` placeholder
 * whose 2D is all-NaN — after a lazy reopen, and since #280 after Track All /
 * Triangulate All as well (`releaseFrameMembers2d`, pose/lazy-residency.js).
 * Triangulating placeholders found no 3D, so each group silently KEPT its old
 * points3d, solved WITH the view that had just moved, and was marked clean.
 *
 * Fixture: a synthetic project (4 calibrated cameras, 2 animals) saved and
 * reopened LAZILY, so nearly every frame's members are placeholders. A second,
 * empty session is added and one camera is moved into it through the real
 * "Move videos" modal. The oracle for each probed group is the app's own solve
 * run on the group's REAL 2D (hydrated from the store for the oracle and given
 * back), with the remaining cameras and the group's method — what the move
 * should have produced. Checked on non-resident frames (the bug) and on the
 * resident current frame (always worked), plus: the stale 3D is really gone,
 * the moved camera is out of every group, and the members went back to
 * placeholders afterwards (no residency growth from the move).
 *
 * Confirmed to fail on main at aa6b0dc3 (non-resident groups keep their stale
 * 3D) and to pass with the fix.
 *
 * Run:  node tests/e2e/move-video-lazy-members.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8231);
const FRAMES = 300, CAMS = 4, NODES = 5, MOVED = 'cam3';

let fails = 0;
const check = (msg, cond, extra) => {
    console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
    if (!cond) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-move-'));
const fixturePath = path.join(tmp, 'fixture.slp');

let browser;
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror] ' + String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm && window.__lucid, { timeout: 120000 });

    // ---- fixture: build, save, hand the bytes to Node ----
    const b64 = await page.evaluate(async ({ FRAMES, CAMS, NODES }) => {
        const [pd, fileio] = await Promise.all([import('/pose/pose-data.js'), import('/import-export/file-io.js')]);
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const camNames = Array.from({ length: CAMS }, (_, i) => 'cam' + i);
        const nodeNames = Array.from({ length: NODES }, (_, i) => 'n' + i);
        const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
        const cameras = camNames.map((n, i) => {
            const a = (i / CAMS) * 1.4 - 0.7;
            return new Camera(n, M, [0, 0, 0, 0, 0], [0, a, 0], [-40 * Math.sin(a), 0, 40 * (1 - Math.cos(a))], [512, 512]);
        });
        const session = new Session(cameras, new Skeleton('skeleton', nodeNames, nodeNames.slice(1).map((_, i) => [i, i + 1])),
            ['track_0', 'track_1'], 'MoveFixture');
        session.identities = [{ id: 0, name: 'animal0' }, { id: 1, name: 'animal1' }];
        // 2D that differs per (frame, camera, node) and per animal, and a stored
        // 3D that is deliberately NOT what the 2D triangulates to — so "kept the
        // old 3D" and "re-solved" can never coincide.
        const xy = (f, c, k, a) => [180 + (f % 97) * 1.5 + c * 11 + k * 3 + a * 120, 200 + (f % 89) * 1.25 + c * 7 + k * 2 + a * 60];
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            const gs = [];
            for (let a = 0; a < 2; a++) {
                const g = new InstanceGroup(f * 2 + a + 1, a);
                camNames.forEach((cn, ci) => {
                    const inst = new Instance(nodeNames.map((_, k) => xy(f, ci, k, a)), a, 'predicted', 1);
                    inst._rawInstIndex = a;
                    fg.addInstance(cn, inst);
                    g.addInstance(cn, inst);
                });
                g.points3d = new Float64Array(NODES * 3).fill(1000 + f + a);
                gs.push(g);
                for (const cn of camNames) session.setFrameIdentity(f, cn, a, a);
            }
            session.instanceGroups.set(f, gs);
        }
        const views = camNames.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: FRAMES }));
        const videoFiles = camNames.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const bytes = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(session, views, videoFiles));
        let s = ''; for (let o = 0; o < bytes.length; o += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(o, o + 0x8000));
        return btoa(s);
    }, { FRAMES, CAMS, NODES });
    fs.writeFileSync(fixturePath, Buffer.from(b64, 'base64'));

    // ---- reopen it lazily ----
    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__mvPick'; inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
    });
    await page.setInputFiles('#__mvPick', fixturePath);
    await page.evaluate(() => {
        window.__mvLoad = { done: false, err: null };
        (async () => {
            try {
                const sl = await import('/loading/session-loader.js');
                await sl.handleLoadProjectSlpLazy(document.getElementById('__mvPick').files[0]);
                window.__mvLoad.done = true;
            } catch (e) { window.__mvLoad.err = String(e && e.stack || e).slice(0, 400); }
        })();
    });
    for (let i = 0; i < 400; i++) {
        const st = await page.evaluate(() => {
            const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || '') && x.offsetParent);
            if (b) b.click();
            return window.__mvLoad.done ? 'done' : (window.__mvLoad.err ? 'err' : 'wait');
        });
        if (st !== 'wait') break;
        await new Promise(r => setTimeout(r, 250));
    }
    const loadErr = await page.evaluate(() => window.__mvLoad.err);
    check('lazy reopen completed', !loadErr, loadErr || undefined);

    // ---- the oracle, before the move ----
    const PROBES = [0, 60, 120, 181, 242, FRAMES - 1];
    const before = await page.evaluate(async ({ PROBES, MOVED }) => {
        const st = window.__lucid.state, s = st.session;
        const [lr, tri, pd] = await Promise.all([import('/pose/lazy-residency.js'), import('/pose/triangulation.js'), import('/pose/pose-data.js')]);
        const out = { lazy: !!s.lazyLoader, sessions: st.sessions.length, current: st.currentFrame, probes: [] };
        let placeholders = 0, members = 0;
        for (const [, gs] of s.instanceGroups) for (const g of gs) for (const [, m] of g.instances) { members++; if (m._lazy2d) placeholders++; }
        out.placeholders = placeholders; out.members = members;
        for (const f of PROBES) {
            const resident = s.frameGroups.has(f);
            const hydrated = lr.hydrateFrameMembers2d(s, f) > 0;
            const rec = { f, resident, groups: [] };
            for (const g of (s.instanceGroups.get(f) || [])) {
                // The solve the move should run: same group minus MOVED, real 2D.
                const probe = new pd.InstanceGroup(-1, g.identityId);
                for (const [cn, m] of g.instances) if (cn !== MOVED) probe.addInstance(cn, m);
                probe.triangulationMethod = g.triangulationMethod;
                const cams = s.cameras.filter(c => probe.instances.has(c.name));
                const r = tri.triangulateAndReproject(probe, cams, { method: tri.resolveTriangulationMethod(g) });
                rec.groups.push({ id: g.id, old: Array.from(g.points3d), want: Array.from(r.points3d) });
            }
            if (hydrated) lr.releaseFrameMembers2d(s, f);
            out.probes.push(rec);
        }
        return out;
    }, { PROBES, MOVED });
    check('fixture is lazy, with most members placeholders', before.lazy && before.placeholders > before.members * 0.8,
        { placeholders: before.placeholders, members: before.members });
    check('fixture: the probes include non-resident frames and the resident current frame',
        before.probes.some(p => !p.resident) && before.probes.some(p => p.resident), before.probes.map(p => [p.f, p.resident]));

    // ---- add a second session and move MOVED into it through the real modal ----
    const moved = await page.evaluate(async ({ MOVED }) => {
        const st = window.__lucid.state;
        const [pd, sp] = await Promise.all([import('/pose/pose-data.js'), import('/ui/sessions-panes.js')]);
        const src = st.session;
        const dest = new pd.Session(src.cameras.slice(), src.skeleton, [], 'Destination');
        if (!Array.isArray(dest.videoFileIndices)) dest.videoFileIndices = [];
        st.sessions.push(dest);
        const fromIdx = st.sessions.indexOf(src), toIdx = st.sessions.length - 1;
        const p = sp.showMoveVideoModal([MOVED], fromIdx, toIdx);
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent === 'Continue' && b.offsetParent);
        if (btn) btn.click();
        await p;
        return { fromIdx, toIdx, clicked: !!btn };
    }, { MOVED });
    check('the move ran through the modal', moved.clicked, moved);

    // ---- after ----
    const after = await page.evaluate(({ PROBES, MOVED }) => {
        const s = window.__lucid.state.sessions[0];
        const probes = PROBES.map(f => ({
            f, groups: (s.instanceGroups.get(f) || []).map(g => ({
                id: g.id, now: g.points3d ? Array.from(g.points3d) : null, hasMoved: g.instances.has(MOVED),
                dirty: g.dirty, lazyMembers: [...g.instances.values()].filter(m => m._lazy2d).length, nMembers: g.instances.size,
            })),
        }));
        let withMoved = 0;
        for (const [, gs] of s.instanceGroups) for (const g of gs) if (g.instances.has(MOVED)) withMoved++;
        return { probes, withMoved, resident: s.frameGroups.size };
    }, { PROBES, MOVED });

    const close = (a, b) => a && b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1e-9 * Math.max(1, Math.abs(b[i])));
    let reSolvedNonRes = 0, nonRes = 0, reSolvedRes = 0, res = 0, stale = 0, released = 0, relevant = 0;
    for (const b of before.probes) {
        const a = after.probes.find(p => p.f === b.f);
        for (const bg of b.groups) {
            const ag = a.groups.find(g => g.id === bg.id);
            const ok = ag && close(ag.now, bg.want);
            if (ag && close(ag.now, bg.old)) stale++;
            if (b.resident) { res++; if (ok) reSolvedRes++; }
            else {
                nonRes++; if (ok) reSolvedNonRes++;
                relevant++; if (ag && ag.lazyMembers === ag.nMembers) released++;
            }
        }
    }
    check(`non-resident groups were re-solved from their real 2D without ${MOVED} (${reSolvedNonRes}/${nonRes})`,
        nonRes > 0 && reSolvedNonRes === nonRes);
    check(`the resident frame's groups too (${reSolvedRes}/${res})`, res > 0 && reSolvedRes === res);
    check('no probed group kept its stale 3D', stale === 0, { stale });
    check(`${MOVED} is out of every group`, after.withMoved === 0, { withMoved: after.withMoved });
    check(`members of non-resident frames went back to placeholders after the re-solve (${released}/${relevant})`,
        relevant > 0 && released === relevant);
} catch (err) {
    console.log('FATAL ' + String(err && err.stack || err).slice(0, 700));
    fails++;
} finally {
    if (browser) { try { await browser.close(); } catch (e) { /* ignore */ } }
    server.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
