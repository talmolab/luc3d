/**
 * sequence-lazy-workflow.mjs — drive REAL user sequences against a LAZILY
 * REOPENED project and assert data integrity after every step.
 *
 * ## Why this exists
 *
 * Every bug in this class so far has been the same shape: an operation that
 * iterates RESIDENT state (`session.frameGroups`, or group members' 2D) on a
 * project whose 2D is lazy, and therefore silently processes a tiny subset. They
 * do not throw. They do not OOM. They return plausible-looking counts and then
 * get SAVED. Examples already found and fixed: `trackAll` (bailed with "No frames
 * to track"), `triangulateAllFrames` (31 of 180,210 frames — luc3d #194).
 *
 * Single-operation tests miss these because the damage shows up a cycle later:
 * save -> reload -> the numbers are wrong. So this harness runs SEQUENCES —
 * load, operate, save, reload, operate, save, reload — and after each step
 * re-derives an invariant snapshot and compares it against what the step should
 * have done. A step that silently under-applies changes the snapshot in a way the
 * next reload makes permanent, which is exactly what this catches.
 *
 * ## Why a synthetic fixture, and why it must be BIG in frame count
 *
 * Residency is what makes the bug class visible, and residency is driven by FRAME
 * COUNT, not file size: a lazily reopened project materializes 2D on scrub, so
 * with thousands of frames almost none are resident (measured on the real project:
 * 31 of 180,210). An 8-frame fixture comes back fully resident and every one of
 * these bugs hides. So the fixture is thousands of frames but only a few nodes —
 * fast to build and save, faithful on the axis that matters.
 *
 * ## Invariants checked after every step
 *
 * - group count, groups carrying 3D, groups whose 3D is all-finite
 * - 2D coordinate checksum over a fixed probe set (catches silent coordinate loss)
 * - frameIdentityMap size, identity/track assignment on probe frames
 * - resident frameGroups (memory-bound regression guard)
 * - usedJSHeapSize, so a step that quietly retains the project is visible
 * - the status bar's Labeled Frames / Instances / Triangulated, which must be
 *   WHOLE-PROJECT counts, not the resident window (at reopen, around Triangulate
 *   All and after Track All — see `checkCounters`)
 *
 * ## Usage
 *   node tests/e2e/sequence-lazy-workflow.mjs                 # default: 6000 frames
 *   FRAMES=20000 CAMS=4 node tests/e2e/sequence-lazy-workflow.mjs
 *   KEEP=1 ...        # keep the generated .slp files for inspection
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8202);
const FRAMES = Number(process.env.FRAMES || 6000);
const CAMS = Number(process.env.CAMS || 3);
const NODES = Number(process.env.NODES || 5);
const KEEP = !!process.env.KEEP;

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const log = (m) => console.log(`[${el()}] ${m}`);

let fails = 0;
const check = (msg, cond, extra) => {
    console.log((cond ? '    ok   ' : '    FAIL ') + msg +
        (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
    if (!cond) fails++;
};

const outFiles = [];
const outPath = (tag) => {
    const p = path.join(repoRoot, `_seq-${tag}.slp`);
    outFiles.push(p);
    return p;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch({ headless: true, args: ['--enable-precise-memory-info'] });
    const page = await browser.newPage();
    page.on('pageerror', e => { log('[pageerror] ' + String(e).slice(0, 300)); fails++; });
    page.on('crash', () => { log('*** RENDERER CRASHED ***'); fails++; });
    page.on('console', m => {
        const t = m.text();
        if (/triangulate-all|track-all|No frames|windowed sweep|\[seq\]/.test(t)) log('  [page] ' + t.slice(0, 200));
    });

    // ---- file sink plumbing: the page "saves" through a mocked picker ----
    let sink = { fd: null, bytes: 0, target: null };
    await page.exposeFunction('__seqWrite', (b64) => {
        if (sink.fd === null) sink.fd = fs.openSync(sink.target, 'w');
        const buf = Buffer.from(b64, 'base64');
        fs.writeSync(sink.fd, buf);
        sink.bytes += buf.length;
    });
    const beginSink = (target) => { sink = { fd: null, bytes: 0, target }; };
    const endSink = () => { if (sink.fd !== null) fs.closeSync(sink.fd); return sink.bytes; };

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm, { timeout: 120000 });
    log('app booted');

    // Install the save-picker mock + shared page helpers once.
    await page.evaluate(() => {
        window.__seqB64 = (u8) => {
            let s = ''; const C = 0x8000;
            for (let o = 0; o < u8.length; o += C) s += String.fromCharCode.apply(null, u8.subarray(o, o + C));
            return btoa(s);
        };
        window.showSaveFilePicker = async () => ({
            createWritable: async () => ({
                write: async (chunk) => {
                    const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                    await window.__seqWrite(window.__seqB64(u8));
                },
                close: async () => {},
            }),
        });

        /**
         * Invariant snapshot. Deliberately RE-DERIVED from live state each time
         * rather than remembered, so a step that mutates state in place is caught.
         */
        window.__seqSnap = (probeFrames) => {
            const st = window.__lucid.state;
            const s = st.session;
            if (!s) return { err: 'no session' };
            let groups = 0, with3d = 0, finite3d = 0, nan3d = 0, members = 0, realMembers = 0;
            for (const [, gs] of s.instanceGroups) {
                for (const g of gs) {
                    groups++;
                    const p = g.points3d;
                    if (p && p.length) {
                        with3d++;
                        let anyNaN = false;
                        for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) { anyNaN = true; break; }
                        if (anyNaN) nan3d++; else finite3d++;
                    }
                    if (g.instances) {
                        members += g.instances.size;
                        for (const [, inst] of g.instances) {
                            if (inst && inst.hasAnyUsablePoint && inst.hasAnyUsablePoint()) realMembers++;
                        }
                    }
                }
            }
            // Probe a fixed set of frames for 2D + track/identity detail. Hydrate
            // is NOT done here on purpose: the probe reads whatever the app would
            // read, so a step that lost data shows up rather than being papered over.
            const probes = [];
            for (const f of probeFrames) {
                const gs = s.instanceGroups.get(f) || [];
                const rec = { f, n: gs.length, tracks: [], xy: 0, ids: [] };
                for (const g of gs) {
                    rec.ids.push(g.identityId);
                    for (const [cn, inst] of (g.instances || new Map())) {
                        rec.tracks.push(cn + ':' + inst.trackIdx);
                        if (inst.hasAnyUsablePoint && inst.hasAnyUsablePoint()) {
                            for (let k = 0; k < inst.numNodes; k++) {
                                if (inst.hasPoint(k)) { rec.xy += inst.getX(k) + inst.getY(k); }
                            }
                        }
                    }
                }
                rec.tracks.sort();
                probes.push(rec);
            }
            return {
                groups, with3d, finite3d, nan3d, members, realMembers,
                fim: s.frameIdentityMap ? s.frameIdentityMap.size : 0,
                identities: s.identities ? s.identities.length : 0,
                tracks: s.tracks ? s.tracks.length : 0,
                igFrames: s.instanceGroups.size,
                resident: s.frameGroups ? s.frameGroups.size : 0,
                triResults: st.triangulationResults ? st.triangulationResults.size : 0,
                usedMB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(0),
                probes,
            };
        };

        /** What the status bar shows right now. */
        window.__seqCountersShown = () => {
            const num = (id) => {
                const m = ((document.getElementById(id) || {}).textContent || '').match(/-?\d+/);
                return m ? Number(m[0]) : null;
            };
            return {
                cam: ((document.getElementById('statusCamera') || {}).textContent || '').replace(/^Camera:\s*/, ''),
                labeled: num('statusLabeledFrames'),
                instances: num('statusInstances'),
                triangulated: num('statusTriangulatedFrames'),
            };
        };

        /**
         * Ground truth for the status bar, derived independently of the app's
         * counting code. Triangulated: frames with 3D, straight off the
         * whole-project `instanceGroups`. Labeled Frames / Instances: hydrate
         * EVERY frame through the app's own loader, then apply the counters'
         * original resident rule — on a fully resident project that is the
         * whole-project answer. The resident window is put back afterwards, so
         * the steps after this one see the residency they would have seen.
         */
        window.__seqCounterTruth = async (cam) => {
            const st = window.__lucid.state;
            const s = st.session;
            const tri = await import('/pose/triangulation.js');
            let triangulated = 0;
            for (const [, gs] of s.instanceGroups) {
                for (const g of gs) { if (g.points3d) { triangulated++; break; } }
            }
            const before = new Set(s.frameGroups.keys());
            await tri.batchLoadLazyFrames(0, s.lazyLoader.nFrames);
            let labeled = 0, instances = 0;
            s.frameGroups.forEach((fg) => {
                let has = false;
                for (const inst of (fg.instances.get(cam) || [])) {
                    const t = inst.type || 'user';
                    if (t === 'user') { has = true; instances++; } else if (t === 'predicted') has = true;
                }
                for (const ul of fg.getUnlinkedInstances(cam)) {
                    if ((ul.instance.type || 'user') === 'user') { has = true; instances++; }
                }
                if (has) labeled++;
            });
            const hydrated = s.frameGroups.size;
            for (const [f, fg] of [...s.frameGroups]) {
                if (before.has(f) || f === st.currentFrame) continue;
                let user = false;
                for (const [, insts] of fg.instances) if (insts.some(i => i.type === 'user')) { user = true; break; }
                if (!user) s.frameGroups.delete(f);
            }
            s.lazyLoader.releaseWindow(0, s.lazyLoader.nFrames);
            return { labeled, instances, triangulated, residentBefore: before.size, hydrated };
        };
    });

    // ---------------- build the fixture ----------------
    log(`building fixture: ${FRAMES} frames x ${CAMS} cameras x ${NODES} nodes ...`);
    const fixturePath = outPath('fixture');
    beginSink(fixturePath);
    const buildInfo = await page.evaluate(async ({ FRAMES, CAMS, NODES }) => {
        const [pd, fileio] = await Promise.all([
            import('/pose/pose-data.js'), import('/import-export/file-io.js'),
        ]);
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const camNames = Array.from({ length: CAMS }, (_, i) => 'cam' + i);
        const nodeNames = Array.from({ length: NODES }, (_, i) => 'n' + i);
        const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
        // Well-conditioned ring of cameras so triangulation is stable.
        const cameras = camNames.map((n, i) => {
            const a = (i / CAMS) * 1.2 - 0.6;
            return new Camera(n, M, [0, 0, 0, 0, 0], [0, a, 0], [-40 * Math.sin(a), 0, 40 * (1 - Math.cos(a))], [512, 512]);
        });
        const skeleton = new Skeleton('skeleton', nodeNames, nodeNames.slice(1).map((_, i) => [i, i + 1]));
        // TWO animals, each with its own track AND its own identity, and
        // `frameIdentityMap` entries for BOTH tracks on every camera-frame. That
        // is what a real tracked project looks like, and it matters here:
        //   - a 0<->1 track swap has a legitimate target on both sides, so it
        //     cannot be confused with "that track did not exist";
        //   - identity FOLLOWS the swap (frameIdentityMap is keyed by
        //     (frameIdx, camName, trackIdx)), which is the whole semantics of
        //     "swap these two animals";
        //   - "Propagate IDs -> Tracks" has two identities to derive tracks from.
        // With a single identity (and fim entries for track 0 only) the swap left
        // every instance on an unidentified track, and Propagate then correctly
        // blanked them — a fixture artifact that looked exactly like a product bug.
        const session = new Session(cameras, skeleton, ['track_0', 'track_1'], 'SeqFixture');
        session.identities = [{ id: 0, name: 'animal0' }, { id: 1, name: 'animal1' }];

        // Deterministic 2D that varies per (frame, cam, node).
        const xy = (f, c, k) => [180 + (f % 97) * 1.5 + c * 11 + k * 3, 200 + (f % 89) * 1.25 + c * 7 + k * 2];
        const ANIMALS = 2;
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            // PREDICTED, not user — this is what a tracked prediction project
            // looks like, and it is what makes window RELEASE observable: the
            // sweeps deliberately pin user-edited frames, so an all-'user'
            // fixture would keep every frame resident and hide any leak.
            // A couple of frames are user-edited on purpose.
            const isUserFrame = (f === 1 || f === 2);
            const groupsThisFrame = [];
            for (let a = 0; a < ANIMALS; a++) {
                const g = new InstanceGroup(f * ANIMALS + a + 1, a);
                camNames.forEach((cn, ci) => {
                    // Offset animal 1 well away from animal 0 so triangulation is
                    // unambiguous and a mis-assignment is detectable.
                    const inst = new Instance(
                        nodeNames.map((_, k) => {
                            const p = xy(f, ci, k);
                            return a === 0 ? p : [p[0] + 120, p[1] + 60];
                        }), a, isUserFrame ? 'user' : 'predicted', 1);
                    inst._rawInstIndex = a;
                    fg.addInstance(cn, inst);
                    g.addInstance(cn, inst);
                });
                g.points3d = new Float64Array(NODES * 3).fill(0)
                    .map((_, i) => (f % 31) + i * 0.5 + a * 40);
                groupsThisFrame.push(g);
                // Identity per (frame, camera, track) for BOTH animals.
                for (let ci = 0; ci < camNames.length; ci++) {
                    session.setFrameIdentity(f, camNames[ci], a, a);
                }
            }
            session.instanceGroups.set(f, groupsThisFrame);
        }
        const views = camNames.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: FRAMES }));
        const videoFiles = camNames.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const labels = fileio.buildSlpLabelsAllViews(session, views, videoFiles);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);
        await window.__seqWrite(window.__seqB64(bytes));
        return { bytes: bytes.length, camNames, nodeNames, animals: ANIMALS };
    }, { FRAMES, CAMS, NODES });
    const fixtureBytes = endSink();
    log(`fixture written: ${fixtureBytes.toLocaleString()} bytes`);

    // ---------------- sequence driver ----------------
    const PROBES = [0, 1, Math.floor(FRAMES / 2), FRAMES - 1];
    // Two animals per frame (see the fixture), so group counts are per-ANIMAL.
    const ANIMALS = buildInfo.animals;
    const GROUPS = FRAMES * ANIMALS;
    let step = 0;
    const history = [];

    const reopen = async (file, label) => {
        step++;
        log(`\n[step ${step}] REOPEN ${label} (${path.basename(file)})`);
        await page.evaluate(() => {
            const old = document.getElementById('__seqPick');
            if (old) old.remove();
            const inp = document.createElement('input');
            inp.type = 'file'; inp.id = '__seqPick';
            inp.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(inp);
        });
        await page.setInputFiles('#__seqPick', file);
        await page.evaluate(() => {
            window.__seqLoad = { done: false, err: null };
            (async () => {
                try {
                    const sl = await import('/loading/session-loader.js');
                    await sl.handleLoadProjectSlpLazy(document.getElementById('__seqPick').files[0]);
                    window.__seqLoad.done = true;
                } catch (e) { window.__seqLoad.err = String(e && e.stack || e).slice(0, 400); }
            })();
        });
        for (let i = 0; i < 1200; i++) {
            const s = await page.evaluate(() => {
                const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || ''));
                if (b) { b.click(); return 'clicked'; }
                return window.__seqLoad.done ? 'done' : (window.__seqLoad.err ? 'err' : 'wait');
            });
            if (s === 'done' || s === 'err') break;
            await new Promise(r => setTimeout(r, 250));
        }
        const err = await page.evaluate(() => window.__seqLoad.err);
        check(`reopen ${label} completed`, !err, err || undefined);
        return await snap(`after reopen ${label}`);
    };

    const snap = async (label) => {
        const s = await page.evaluate((p) => window.__seqSnap(p), PROBES);
        history.push({ step, label, snap: s });
        log(`  ${label}: groups=${s.groups} 3D=${s.with3d} (finite ${s.finite3d}/NaN ${s.nan3d}) ` +
            `fim=${s.fim} resident=${s.resident} triRes=${s.triResults} heap=${s.usedMB}MB`);
        return s;
    };

    const runOp = async (label, fn, arg) => {
        step++;
        log(`\n[step ${step}] ${label}`);
        const r = await page.evaluate(fn, arg);
        if (r && r.err) { check(`${label} did not throw`, false, r.err); }
        else if (r !== null && r !== undefined) log(`  -> ${JSON.stringify(r).slice(0, 220)}`);
        return { r, s: await snap(`after ${label}`) };
    };

    /**
     * The status bar must count the WHOLE project. On a lazy project
     * `frameGroups` is a small resident window, and the counters used to walk
     * it: "Triangulated: 5789" right after triangulating all 108,000 frames.
     * Prompt a redraw the way any paused frame change does, then give the
     * counters' deferred baseline rebuild (`updateFrameCounters`) time to land —
     * that rebuild is what picks up an operation on non-resident frames.
     */
    const checkCounters = async (label, want) => {
        const shownCam = await page.evaluate(async () => {
            // This fixture has no videos, hence no views and no default camera:
            // make one active the way clicking into its view does. The LAST
            // camera, so a count that ignored the active camera would show.
            const s = window.__lucid.state.session;
            const im = window.__lucid.interactionManager;
            if (im && s && s.cameras.length) im.lastInteractedView = s.cameras[s.cameras.length - 1].name;
            const rendering = await import('/ui/rendering.js');
            rendering.updateFrameCounters();
            return window.__seqCountersShown().cam;
        });
        check(`${label}: status bar names a camera (${shownCam})`, !!shownCam && shownCam !== '-');
        const truth = await page.evaluate((c) => window.__seqCounterTruth(c), shownCam);
        // `want` pins the fixture's own expectation, so a truth that drifted
        // (e.g. hydration losing frames) cannot quietly agree with a wrong count.
        for (const k of Object.keys(want || {})) {
            check(`${label}: fixture sanity — ${k} is ${want[k]}`, truth[k] === want[k], { truth: truth[k], want: want[k] });
        }
        const target = { labeled: truth.labeled, instances: truth.instances, triangulated: truth.triangulated };
        let shown = null;
        const t = Date.now();
        for (let i = 0; i < 50; i++) {
            shown = await page.evaluate(() => window.__seqCountersShown());
            if (shown.labeled === target.labeled && shown.instances === target.instances &&
                shown.triangulated === target.triangulated) break;
            await new Promise(r => setTimeout(r, 100));
        }
        log(`  counters ${label}: shown ${JSON.stringify(shown)} want ${JSON.stringify(target)} ` +
            `(resident ${truth.residentBefore}, settled in ${Date.now() - t} ms)`);
        check(`${label}: Triangulated = frames with 3D across the WHOLE project (${target.triangulated})`,
            shown.triangulated === target.triangulated, { shown: shown.triangulated, want: target.triangulated });
        check(`${label}: Labeled Frames = whole-project count for ${shownCam} (${target.labeled})`,
            shown.labeled === target.labeled, { shown: shown.labeled, want: target.labeled });
        check(`${label}: Instances = whole-project user instances in ${shownCam} (${target.instances})`,
            shown.instances === target.instances, { shown: shown.instances, want: target.instances });
        return { shown, truth };
    };

    const save = async (tag) => {
        step++;
        log(`\n[step ${step}] SAVE -> _seq-${tag}.slp`);
        const target = outPath(tag);
        beginSink(target);
        const r = await page.evaluate(async () => {
            const saveLoad = await import('/import-export/save-load.js');
            const t = performance.now();
            let err = null;
            try { await saveLoad.saveAs({ skipSizeWarning: true }); }
            catch (e) { err = String(e && e.stack || e).slice(0, 500); }
            return { ms: Math.round(performance.now() - t), err };
        });
        const bytes = endSink();
        check(`save ${tag} completed`, !r.err, r.err || undefined);
        check(`save ${tag} wrote a real file`, bytes > 1000, bytes);
        log(`  wrote ${bytes.toLocaleString()} bytes in ${r.ms} ms`);
        return { target, bytes };
    };

    // Groups whose points3d live in the slab pool (pose-data.js
    // `pooledPoints3d`), and how many ArrayBuffers they share between them —
    // one per group was the GC cost the pool removes.
    const pooled3d = () => page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const s = window.__lucid.state.session;
        let with3d = 0, pooled = 0; const bufs = new Set();
        for (const [, gs] of s.instanceGroups) for (const g of gs) {
            if (!g.points3d) continue;
            with3d++; if (pd.isPooledPoints3d(g.points3d)) pooled++;
            bufs.add(g.points3d.buffer);
        }
        return { with3d, pooled, buffers: bufs.size };
    });
    const checkPooled = async (label) => {
        const p = await pooled3d();
        check(`${label}: every group's 3D is in the slab pool, sharing few buffers (${p.buffers} for ${p.with3d} groups)`,
            p.with3d > 0 && p.pooled === p.with3d && p.buffers * 50 < p.with3d, p);
    };

    // =========================================================
    // CYCLE 1 — reopen the fixture, verify the lazy precondition
    // =========================================================
    const s1 = await reopen(fixturePath, 'fixture');
    check(`all ${GROUPS} instance groups round-tripped (${FRAMES} frames x ${ANIMALS} animals)`,
        s1.groups === GROUPS, { got: s1.groups, want: GROUPS });
    check('all groups carry 3D', s1.with3d === GROUPS, { got: s1.with3d, want: GROUPS });
    check('no NaN 3D after a clean reopen', s1.nan3d === 0, { nan3d: s1.nan3d });
    // THE precondition for this whole bug class. If the fixture comes back fully
    // resident, every lazy bug hides and this harness proves nothing.
    check(`lazy precondition: most frames NOT resident (resident=${s1.resident} << ${FRAMES})`,
        s1.resident < FRAMES / 10, { resident: s1.resident, frames: FRAMES });
    check('reopen leaves few members hydrated (placeholders)',
        s1.realMembers < s1.members / 10, { realMembers: s1.realMembers, members: s1.members });

    // ---- Status-bar counters at reopen: whole project, not the resident window ----
    const c1 = await checkCounters('after reopen', { triangulated: FRAMES });
    check('after reopen: the counters are not the resident window (so this check can fail)',
        c1.truth.residentBefore < FRAMES / 10 && c1.shown.labeled > c1.truth.residentBefore,
        { resident: c1.truth.residentBefore, labeled: c1.shown.labeled });

    // Start Triangulate All from a project with NO 3D, which is what it is run on
    // in practice (per-camera .slp -> Track All -> Triangulate All), so every 3D
    // point it reports is one it made — and so the counters have to follow a
    // change to thousands of frames that are not resident.
    await runOp('CLEAR all 3D (a project not yet triangulated)', async () => {
        const s = window.__lucid.state.session;
        let n = 0;
        for (const [, gs] of s.instanceGroups) for (const g of gs) { if (g.points3d) { g.points3d = null; n++; } }
        return { cleared: n };
    });
    await checkCounters('before Triangulate All', { triangulated: 0 });

    // ---- Triangulate All on the lazy project (luc3d #194 regression) ----
    const triA = await runOp('TRIANGULATE ALL', async () => {
        const tri = await import('/pose/triangulation.js');
        try { await tri.triangulateAllFrames('dlt'); } catch (e) { return { err: String(e && e.stack || e).slice(0, 400) }; }
        return null;
    });
    check('Triangulate All covered EVERY group (not just resident ones)',
        triA.s.with3d === GROUPS && triA.s.finite3d === GROUPS,
        { with3d: triA.s.with3d, finite3d: triA.s.finite3d, want: GROUPS });
    check('Triangulate All did not retain reprojections/triResults project-wide',
        triA.s.triResults <= 2, { triResults: triA.s.triResults });
    check('Triangulate All released its windows',
        triA.s.resident < FRAMES / 10, { resident: triA.s.resident });
    await checkPooled('after Triangulate All');
    // The reported bug: "Triangulated: <resident count>" after triangulating
    // every frame of a lazy project.
    const cTri = await checkCounters('after Triangulate All', { triangulated: FRAMES });
    check('after Triangulate All: Triangulated is not the resident count',
        cTri.shown.triangulated !== cTri.truth.residentBefore,
        { shown: cTri.shown.triangulated, resident: cTri.truth.residentBefore });

    // The counters' cost model. Their whole-project baseline is rebuilt after a
    // redraw of the SAME frame — which every edit and operation ends in — and
    // never because the frame changed: stepping and scrubbing must cost no
    // whole-project work, or the fix would trade a wrong number for a slow app.
    // A rebuild is observable as `forEachInstanceRow` walking a frame RANGE,
    // which only the counters do.
    const nav = await page.evaluate(async () => {
        const st = window.__lucid.state;
        const loader = st.session.lazyLoader;
        const init = await import('/pose/initialization.js');
        const rendering = await import('/ui/rendering.js');
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const orig = loader.forEachInstanceRow;
        let ranged = 0;
        loader.forEachInstanceRow = function (fn, opts) {
            if (opts && opts.start != null) ranged++;
            return orig.call(this, fn, opts);
        };
        try {
            await wait(1000);                    // let a rebuild already asked for land
            ranged = 0;
            const start = st.currentFrame;
            const visited = [];
            for (let i = 1; i <= 12; i++) {      // the app's own navigation entry point
                init.navigateToFrame(start + i * 37);
                visited.push(st.currentFrame);
                await wait(80);
            }
            await wait(1200);
            const onNavigate = ranged;
            rendering.drawAllOverlays(st.currentFrame);   // what an edit ends in
            await wait(1200);
            const onRedraw = ranged - onNavigate;
            init.navigateToFrame(start);
            await wait(300);
            return { visited: new Set(visited).size, onNavigate, onRedraw };
        } finally {
            loader.forEachInstanceRow = orig;
        }
    });
    check('stepping through frames starts NO whole-project counter rebuild',
        nav.visited === 12 && nav.onNavigate === 0, nav);
    check('a same-frame redraw (what every edit and operation ends in) does rebuild them',
        nav.onRedraw > 0, nav);

    // ---- save, reload, and confirm it PERSISTED ----
    const save1 = await save('c1');
    const s2 = await reopen(save1.target, 'after Triangulate All');
    check('groups survived save+reload', s2.groups === GROUPS, { got: s2.groups, want: GROUPS });
    check('3D survived save+reload (all finite)', s2.finite3d === GROUPS, { finite3d: s2.finite3d, nan3d: s2.nan3d });
    check('frameIdentityMap survived save+reload', s2.fim === s1.fim, { got: s2.fim, want: s1.fim });

    // =========================================================
    // CYCLE 2 — modify, save, reload, verify the edit persisted
    // =========================================================
    const edit = await runOp('MODIFY a keypoint', async () => {
        const st = window.__lucid.state;
        const tri = await import('/pose/triangulation.js');
        const s = st.session;
        // Hydrate the frame the way scrubbing would, then edit it.
        await tri.ensureLazyFrameData(0);
        const gs = s.instanceGroups.get(0) || [];
        for (const g of gs) {
            for (const [cn, inst] of g.instances) {
                if (!inst.hasPoint(0)) continue;
                const before = [inst.getX(0), inst.getY(0)];
                inst.setPoint(0, before[0] + 7.5, before[1] - 3.25);
                inst.type = 'user';
                inst.modified = true;
                g.markDirty();
                return { cam: cn, before, after: [inst.getX(0), inst.getY(0)] };
            }
        }
        return { err: 'no hydrated instance found on frame 0 to edit' };
    });
    const editedAfter = edit.r && edit.r.after;
    check('edit applied', !!editedAfter, edit.r);

    const save2 = await save('c2');
    const s3 = await reopen(save2.target, 'after modify');
    check('groups survived modify+save+reload', s3.groups === GROUPS, { got: s3.groups, want: GROUPS });
    check('3D still all-finite after modify cycle', s3.nan3d === 0, { nan3d: s3.nan3d });
    // The edited coordinate must come back. Probe frame 0 needs hydration first.
    const persisted = await page.evaluate(async (want) => {
        const tri = await import('/pose/triangulation.js');
        await tri.ensureLazyFrameData(0);
        const s = window.__lucid.state.session;
        const gs = s.instanceGroups.get(0) || [];
        const seen = [];
        for (const g of gs) {
            for (const [cn, inst] of g.instances) {
                if (inst.hasPoint(0)) seen.push([cn, inst.getX(0), inst.getY(0)]);
            }
        }
        return { seen, want };
    }, editedAfter);
    check('the edited keypoint persisted through save+reload',
        !!editedAfter && persisted.seen.some(([, x, y]) =>
            Math.abs(x - editedAfter[0]) < 1e-6 && Math.abs(y - editedAfter[1]) < 1e-6),
        persisted);

    // =========================================================
    // CYCLE 3 — run everything else, then save+reload again
    // =========================================================
    // exportLabels streams through the mocked `showSaveFilePicker` (luc3d #195),
    // so it lands in a real file we can parse — which also proves the streamed
    // JSON is syntactically valid, not just the right length.
    step++;
    log(`\n[step ${step}] EXPORT LABELS (JSON, streamed)`);
    const jsonPath = path.join(repoRoot, '_seq-labels.json');
    outFiles.push(jsonPath);
    beginSink(jsonPath);
    const expErr = await page.evaluate(async () => {
        const em = await import('/ui/export-modals.js');
        try { await em.exportLabels(); } catch (e) { return String(e && e.stack || e).slice(0, 400); }
        return null;
    });
    endSink();
    check('exportLabels did not throw', !expErr, expErr || undefined);
    let expFrames = -1, expValid = false;
    try {
        const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        expValid = true;
        expFrames = parsed.frames ? Object.keys(parsed.frames).length : 0;
        check('streamed JSON has the skeleton/cameras/tracks header',
            !!(parsed.skeleton && parsed.cameras && parsed.tracks),
            { keys: Object.keys(parsed) });
    } catch (e) {
        check('streamed JSON export parses', false, String(e).slice(0, 200));
    }
    check('streamed JSON export is valid JSON', expValid);
    check('JSON export covers every frame, not just resident ones',
        expFrames === FRAMES, { got: expFrames, want: FRAMES });
    await snap('after EXPORT LABELS');

    const swap = await runOp('SWAP TRACKS over the whole range', async () => {
        const ia = await import('/ui/identity-assignment.js');
        const st = window.__lucid.state;
        const total = st.session.lazyLoader ? st.session.lazyLoader.nFrames : st.session.frameGroups.size;
        let swapped = 0;
        try { swapped = ia.swapTracks(0, 1, 0, total - 1); }
        catch (e) { return { err: String(e && e.stack || e).slice(0, 300) }; }
        return { swapped, total, nTracks: st.session.tracks.length };
    });
    // Every frame has a track_0 instance per camera, so a 0<->1 swap over the full
    // range must touch every camera-frame. Resident-only iteration touches ~none.
    check('track swap applied across the whole range (not resident-only)',
        swap.r && swap.r.swapped >= FRAMES,
        { swapped: swap.r && swap.r.swapped, atLeast: FRAMES });

    const save3 = await save('c3');
    const s4 = await reopen(save3.target, 'after export+swap');
    check('groups survived cycle 3', s4.groups === GROUPS, { got: s4.groups, want: GROUPS });
    check('3D still all-finite after cycle 3', s4.nan3d === 0, { nan3d: s4.nan3d });
    // NOT just "the tracks changed" — a swap that writes an INVALID trackIdx
    // (null/undefined/out-of-range) also "changes" them, and that reads as success
    // while actually being corruption that persists to disk. Require every probe
    // instance to still carry a valid track index.
    const badTracks = [];
    for (const p of s4.probes) {
        for (const t of p.tracks) {
            const v = t.split(':')[1];
            if (v === 'null' || v === 'undefined' || v === 'NaN') badTracks.push(`f${p.f} ${t}`);
            else {
                const n = Number(v);
                if (!Number.isInteger(n) || n < -1 || n >= Math.max(2, s4.tracks)) badTracks.push(`f${p.f} ${t}`);
            }
        }
    }
    check('every probe instance still has a VALID track index after swap+save+reload',
        badTracks.length === 0, { bad: badTracks.slice(0, 12), nTracks: s4.tracks });

    // =========================================================
    // CYCLE 4 — range triangulation, Propagate IDs → Tracks
    // =========================================================
    // Triangulate Range had the #194 defect too (fixed in #195): it read
    // `instanceGroups.get(f)` and triangulated from whatever 2D was resident. To
    // prove coverage rather than just "it ran", blank the 3D across a mid-project
    // range FIRST, then re-triangulate only that range and require it back —
    // while everything outside the range must be untouched.
    const R0 = Math.floor(FRAMES * 0.25), R1 = Math.min(FRAMES - 1, R0 + 400);
    const blanked = await runOp(`BLANK 3D over frames ${R0}..${R1}`, async ({ R0, R1 }) => {
        const s = window.__lucid.state.session;
        let n = 0;
        for (const [f, gs] of s.instanceGroups) {
            if (f < R0 || f > R1) continue;
            for (const g of gs) { if (g.points3d) { g.points3d.fill(NaN); n++; } }
        }
        return { blanked: n };
    }, { R0, R1 });
    const rangeRes = await page.evaluate(async ({ R0, R1 }) => {
        const tri = await import('/pose/triangulation.js');
        try {
            const r = await tri.triangulateMultiFrameInstances(R0, R1, null, 'dlt');
            return { triangulated: r.triangulated, totalGroups: r.totalGroups };
        } catch (e) { return { err: String(e && e.stack || e).slice(0, 400) }; }
    }, { R0, R1 });
    step++;
    log(`\n[step ${step}] TRIANGULATE RANGE ${R0}..${R1} -> ${JSON.stringify(rangeRes)}`);
    check('Triangulate Range did not throw', !rangeRes.err, rangeRes.err || undefined);
    const sRange = await snap('after TRIANGULATE RANGE');
    check('Triangulate Range restored 3D for the whole range (not resident-only)',
        sRange.nan3d === 0 && sRange.finite3d === GROUPS,
        { nan3d: sRange.nan3d, finite3d: sRange.finite3d, blanked: blanked.r && blanked.r.blanked });
    check('Triangulate Range covered ~every frame in the range',
        rangeRes.triangulated >= (R1 - R0 + 1) * 0.99,
        { triangulated: rangeRes.triangulated, rangeSize: R1 - R0 + 1 });

    const prop = await runOp('PROPAGATE IDs -> TRACKS', async () => {
        const s = window.__lucid.state.session;
        const before = s.tracks.slice();
        try {
            const res = s.propagateIdentitiesToTracks();
            return { tracksBefore: before, tracksAfter: s.tracks.slice(), res };
        } catch (e) { return { err: String(e && e.stack || e).slice(0, 400) }; }
    });
    check('Propagate IDs -> Tracks produced identity-derived tracks',
        !!(prop.r && prop.r.res && prop.r.res.tracks > 0),
        prop.r && prop.r.res);

    const save4 = await save('c4');
    const s5 = await reopen(save4.target, 'after range+propagate');
    check('groups survived cycle 4', s5.groups === GROUPS, { got: s5.groups, want: GROUPS });
    check('3D still all-finite after cycle 4', s5.nan3d === 0, { nan3d: s5.nan3d });
    check('propagated tracks persisted through save+reload',
        s5.tracks > 0, { tracks: s5.tracks });
    const badTracks4 = [];
    for (const p of s5.probes) {
        for (const t of p.tracks) {
            const v = t.split(':')[1];
            const n = Number(v);
            if (v === 'null' || v === 'undefined' || !Number.isInteger(n) || n < -1 || n >= Math.max(1, s5.tracks)) {
                badTracks4.push(`f${p.f} ${t}`);
            }
        }
    }
    check('track indices remain valid after propagate+save+reload',
        badTracks4.length === 0, { bad: badTracks4.slice(0, 12), nTracks: s5.tracks });

    // =========================================================
    // CYCLE 5+ — repeat save/reload to expose cumulative drift
    // =========================================================
    // A single round trip can hide a defect that compounds: counts that shrink a
    // little each cycle, 3D that degrades, tracks that creep. Repeat the plain
    // save→reopen cycle and require the invariants to be EXACTLY stable.
    let prev = s5;
    let cur = null;
    for (let rep = 1; rep <= 3; rep++) {
        const sv = await save('r' + rep);
        cur = await reopen(sv.target, `repeat ${rep}`);
        check(`repeat ${rep}: group count exactly stable`, cur.groups === prev.groups,
            { got: cur.groups, want: prev.groups });
        check(`repeat ${rep}: groups-with-3D exactly stable`, cur.with3d === prev.with3d,
            { got: cur.with3d, want: prev.with3d });
        check(`repeat ${rep}: no NaN 3D introduced`, cur.nan3d === 0, { nan3d: cur.nan3d });
        check(`repeat ${rep}: frameIdentityMap exactly stable`, cur.fim === prev.fim,
            { got: cur.fim, want: prev.fim });
        check(`repeat ${rep}: track count exactly stable`, cur.tracks === prev.tracks,
            { got: cur.tracks, want: prev.tracks });
        check(`repeat ${rep}: still lazy (windows released)`, cur.resident < FRAMES / 10,
            { resident: cur.resident });
        prev = cur;
    }

    // =========================================================
    // CYCLE 5b — DELETE A TRACK (durable re-index)
    // =========================================================
    // `deleteTrackAt` splices the name out of `session.tracks` and re-indexes
    // instances (deleted -> trackless, higher -> shift down one). On a lazy
    // project the persistent assignment is the store's track column, so without
    // the #195 store re-index this was silent project-wide CORRUPTION: every
    // instance above the deleted index would be saved pointing at the wrong track.
    //
    // Set up a third track and move every animal-1 instance onto it, then delete
    // the now-empty track index 1 and require: (a) instances that were on track 2
    // shifted down to 1, (b) no group was dissolved (nothing was on the deleted
    // track), and (c) that survives save+reload.
    //
    // The move goes through the app's own `swapTracks`, NOT a raw
    // `loader.remapTracksFromIdentity`. That distinction is the test: a raw store
    // remap leaves the project-wide `instanceGroups` placeholders holding their
    // old `trackIdx`, and `deleteTrackAt` decides what to DISSOLVE from exactly
    // that field — so the bypass would have this step dissolve half the project's
    // groups while the store says otherwise. The app must never reach that state,
    // so the harness must not manufacture it; every store writer syncs memory.
    const delRes = await runOp('DELETE TRACK (index 1 of 3)', async () => {
        const ops = await import('/ui/track-identity-ops.js');
        const ident = await import('/ui/identity-assignment.js');
        const s = window.__lucid.state.session;
        if (s.tracks.length < 3) s.tracks.push('track_2');
        // Move every animal-1 instance to the new track 2 (store + memory).
        ident.swapTracks(1, 2, 0, Infinity);
        const before = { tracks: s.tracks.slice() };
        let deleted = null;
        try { deleted = ops.deleteTrackAt(s, 1); }
        catch (e) { return { err: String(e && e.stack || e).slice(0, 400) }; }
        // Count store rows per track AFTER the delete.
        const counts = {};
        const loader = s.lazyLoader;
        if (loader && loader.forEachInstanceRow) {
            loader.forEachInstanceRow((cam, f, trk) => { counts[trk] = (counts[trk] || 0) + 1; });
        }
        return { deleted, before, tracksAfter: s.tracks.slice(), storeCounts: counts };
    });
    check('deleteTrackAt did not throw', !(delRes.r && delRes.r.err), delRes.r && delRes.r.err);
    if (delRes.r && !delRes.r.err) {
        const c = delRes.r.storeCounts || {};
        // Everything that was on track 2 must now be on track 1; nothing may be
        // left referencing an index at/beyond the shortened list, and nothing may
        // still sit on the old index 2.
        const nTracks = delRes.r.tracksAfter.length;
        const stale = Object.keys(c).map(Number).filter(t => t >= nTracks);
        check('no store row references a track index past the shortened list',
            stale.length === 0, { stale, nTracks, counts: c });
        check('rows from the shifted track landed on the new index',
            (c[1] || 0) > 0, { counts: c });
    }
    const save5b = await save('c5b');
    const s6b = await reopen(save5b.target, 'after track delete');
    check('groups survived track delete', s6b.groups === GROUPS, { got: s6b.groups, want: GROUPS });
    const badDel = [];
    for (const p of s6b.probes) {
        for (const t of p.tracks) {
            const v = t.split(':')[1];
            if (v === 'undefined' || v === 'NaN') { badDel.push(`f${p.f} ${t}`); continue; }
            if (v === 'null') continue;               // trackless is legitimate here
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0 || n >= Math.max(1, s6b.tracks)) badDel.push(`f${p.f} ${t}`);
        }
    }
    check('track indices remain in range after delete+save+reload',
        badDel.length === 0, { bad: badDel.slice(0, 12), nTracks: s6b.tracks });

    // =========================================================
    // CYCLE 5c — an interactive DELETE is durable
    // =========================================================
    // The Delete key, Edit ▸ Delete Instance, the toolbar's "- Instance" and the
    // group context menu's "Delete group" used to edit only the RESIDENT frame.
    // On a lazy project the store is the source of truth, so the deleted
    // instance came straight back twice over: a windowed sweep (here Triangulate
    // All) releases a frame with no user instance and re-hydrates it from the
    // store, and the streaming save writes the store rows of any camera-frame
    // with no user instance. Every case below is predicted-only, which is
    // exactly the frame both of those treat as rebuildable.
    //   D_UL    an ungrouped prediction, deleted (the reported case)
    //   D_MEM   one view of a group (per-camera delete; the group keeps >=2)
    //   D_GRP   a whole group (Shift+Delete)
    //   D_CTX   a whole group, from the group context menu
    //   D_LONE  every view but one of a group -> the survivor is auto-ungrouped
    // D_MEM and D_LONE delete animal 0's row 0 / animal 1's rows, so the rows
    // left in those camera-frames are renumbered — the saved grouping is only
    // right if the survivors' `_rawInstIndex` followed the compaction.
    const D = { D_UL: 210, D_MEM: 220, D_GRP: 230, D_CTX: 240, D_LONE: 250 };
    const AWAY = Math.floor(FRAMES * 0.8);
    await page.evaluate(() => {
        /** Per camera: node-0 positions of the grouped and ungrouped instances. */
        window.__seqFrameShape = (f) => {
            const s = window.__lucid.state.session;
            const fg = s.frameGroups.get(f);
            if (!fg) return null;
            const key = (inst) => inst.hasPoint(0) ? inst.getX(0).toFixed(3) + ',' + inst.getY(0).toFixed(3) : 'none';
            const cams = {};
            for (const c of s.cameras) {
                cams[c.name] = {
                    linked: fg.getInstances(c.name).map(key).sort(),
                    unlinked: fg.getUnlinkedInstances(c.name).map(u => key(u.instance)).sort(),
                };
            }
            return { groups: (s.instanceGroups.get(f) || []).length, cams };
        };
        window.__seqStoreRows = () => {
            let n = 0;
            window.__lucid.state.session.lazyLoader.forEachInstanceRow(() => { n++; });
            return n;
        };
    });
    const del5c = await runOp('DELETE through the real Delete paths (5 frames)', async ({ D, AWAY }) => {
        const st = window.__lucid.state;
        const s = st.session;
        const im = window.__lucid.interactionManager;
        const tri = await import('/pose/triangulation.js');
        const wiring = await import('/ui/ui-wiring.js');
        const saveLoad = await import('/import-export/save-load.js');
        const rowsBefore = window.__seqStoreRows();
        const cams = s.cameras.map(c => c.name);
        const groupsOf = (f) => (s.instanceGroups.get(f) || []).slice();
        // Each delete starts from a CLEAN project, so `dirty[k]` is that delete's
        // own doing: an unmarked delete is lost without a prompt on closing the
        // tab, or on switching sessions (which evicts the session's store).
        const at = async (f) => {
            await tri.ensureLazyFrameData(f); st.currentFrame = f; im.clearSelection(); saveLoad.clearDirty();
        };
        const out = { before: {}, after: {}, dirty: {} };
        let expectDeleted = 0;

        await at(D.D_UL);
        out.before.D_UL = window.__seqFrameShape(D.D_UL);
        const ul = s.unlinkGroup(D.D_UL, groupsOf(D.D_UL)[1]).find(u => u.cameraName === cams[0]);
        if (!ul) return { err: 'no ungrouped instance on D_UL' };
        im.selectedUnlinked = ul;
        im.lastInteractedView = cams[0];
        im._deleteSelected();
        expectDeleted += 1;
        out.dirty.D_UL = st.isDirty && s.isDirty;

        await at(D.D_MEM);
        out.before.D_MEM = window.__seqFrameShape(D.D_MEM);
        im.select(groupsOf(D.D_MEM)[0], -1);
        im.lastInteractedView = cams[1];
        im._deleteSelected(false);
        expectDeleted += 1;
        out.dirty.D_MEM = st.isDirty && s.isDirty;

        await at(D.D_GRP);
        out.before.D_GRP = window.__seqFrameShape(D.D_GRP);
        im.select(groupsOf(D.D_GRP)[1], -1);
        im.lastInteractedView = cams[0];
        im._deleteSelected(true);
        expectDeleted += cams.length;
        out.dirty.D_GRP = st.isDirty && s.isDirty;

        await at(D.D_CTX);
        out.before.D_CTX = window.__seqFrameShape(D.D_CTX);
        wiring.showGroupContextMenu(0, 0, groupsOf(D.D_CTX)[1]);
        document.getElementById('ctxDeleteGroup').click();
        expectDeleted += cams.length;
        out.dirty.D_CTX = st.isDirty && s.isDirty;

        await at(D.D_LONE);
        out.before.D_LONE = window.__seqFrameShape(D.D_LONE);
        const lone = groupsOf(D.D_LONE)[1];
        for (let c = 0; c < cams.length - 1; c++) {
            im.select(lone, -1);
            im.lastInteractedView = cams[c];
            im._deleteSelected(false);
            expectDeleted += 1;
        }
        out.dirty.D_LONE = st.isDirty && s.isDirty;

        for (const k in D) out.after[k] = window.__seqFrameShape(D[k]);
        st.currentFrame = AWAY;
        im.clearSelection();
        return { ...out, rowsBefore, rowsAfter: window.__seqStoreRows(), expectDeleted };
    }, { D, AWAY });
    const d5 = del5c.r || {};
    check('cycle 5c: the deletes ran', !!(d5.after && d5.expectDeleted), d5.err || undefined);
    check('cycle 5c: every delete marked the project (and its session) dirty',
        !!d5.dirty && Object.keys(D).every(k => d5.dirty[k] === true), d5.dirty);
    // What each delete must have done to its frame in memory. These pin the
    // in-memory semantics (unchanged by the store write) so a later "came
    // back" cannot be a delete that never happened.
    const shapeOf = (k) => (d5.after || {})[k] || null;
    const n = (sh, cam) => sh ? sh.cams[cam].linked.length + sh.cams[cam].unlinked.length : -1;
    check('cycle 5c: D_UL lost exactly the deleted ungrouped instance',
        !!shapeOf('D_UL') && n(shapeOf('D_UL'), 'cam0') === 1 && shapeOf('D_UL').cams.cam0.unlinked.length === 0 &&
        shapeOf('D_UL').groups === 1, shapeOf('D_UL'));
    check('cycle 5c: D_MEM lost one view of a group, which kept the rest',
        !!shapeOf('D_MEM') && n(shapeOf('D_MEM'), 'cam1') === 1 && shapeOf('D_MEM').groups === ANIMALS, shapeOf('D_MEM'));
    check('cycle 5c: D_GRP and D_CTX each lost a whole group',
        ['D_GRP', 'D_CTX'].every(k => shapeOf(k) && shapeOf(k).groups === ANIMALS - 1 &&
            Object.keys(shapeOf(k).cams).every(c => n(shapeOf(k), c) === 1)),
        { D_GRP: shapeOf('D_GRP'), D_CTX: shapeOf('D_CTX') });
    check('cycle 5c: D_LONE\'s survivor was auto-ungrouped',
        !!shapeOf('D_LONE') && shapeOf('D_LONE').groups === ANIMALS - 1 &&
        shapeOf('D_LONE').cams['cam' + (CAMS - 1)].unlinked.length === 1, shapeOf('D_LONE'));
    // THE durability property: the rows left the store, not just the window.
    check(`cycle 5c: the store lost exactly the ${d5.expectDeleted} deleted rows`,
        d5.rowsBefore - d5.rowsAfter === d5.expectDeleted,
        { before: d5.rowsBefore, after: d5.rowsAfter, want: d5.expectDeleted });

    // A windowed sweep releases every predicted-only frame and re-hydrates it
    // from the store — the in-memory way a delete used to be undone.
    const sweep5c = await runOp('TRIANGULATE ALL (releases the deleted frames)', async ({ D }) => {
        const tri = await import('/pose/triangulation.js');
        const s = window.__lucid.state.session;
        try { await tri.triangulateAllFrames('dlt'); } catch (e) { return { err: String(e && e.stack || e).slice(0, 400) }; }
        const released = {};
        for (const k in D) released[k] = !s.frameGroups.has(D[k]);
        const shapes = {};
        for (const k in D) { await tri.ensureLazyFrameData(D[k]); shapes[k] = window.__seqFrameShape(D[k]); }
        return { released, shapes };
    }, { D });
    const sw = sweep5c.r || {};
    check('cycle 5c: Triangulate All released the deleted frames (so re-hydration is really tested)',
        !!sw.released && Object.values(sw.released).every(Boolean), sw.released);
    for (const k of Object.keys(D)) {
        check(`cycle 5c: ${k} re-hydrated after the sweep exactly as deleted`,
            !!sw.shapes && JSON.stringify(sw.shapes[k]) === JSON.stringify(shapeOf(k)),
            { got: sw.shapes && sw.shapes[k], want: shapeOf(k) });
    }

    const save5c = await save('c5c');
    await reopen(save5c.target, 'after interactive deletes');
    const after5c = await page.evaluate(async ({ D }) => {
        const tri = await import('/pose/triangulation.js');
        const shapes = {};
        for (const k in D) { await tri.ensureLazyFrameData(D[k]); shapes[k] = window.__seqFrameShape(D[k]); }
        return { shapes, rows: window.__seqStoreRows() };
    }, { D });
    check('cycle 5c: the reopened store holds the post-delete row count',
        after5c.rows === d5.rowsAfter, { got: after5c.rows, want: d5.rowsAfter });
    for (const k of Object.keys(D)) {
        check(`cycle 5c: ${k}'s delete persisted through save+reload (instances AND grouping)`,
            JSON.stringify(after5c.shapes[k]) === JSON.stringify(shapeOf(k)),
            { got: after5c.shapes[k], want: shapeOf(k) });
    }

    // =========================================================
    // CYCLE 6 — TRACK ALL on the reopened project
    // =========================================================
    // Direct coverage for `sweepTrackAllFrames`, which luc3d #195 re-pointed at the
    // shared `sweepLazyFrameWindows`. Track All is the most expensive path in the
    // app and the one whose windowing must not regress: it RESETS
    // `frameIdentityMap`/`instanceGroups` and rebuilds them for every frame, so if
    // the sweep only visited resident frames the project would come back nearly
    // empty — the original `trackAll` bug ("No frames to track"), one layer deeper.
    const trackRes = await runOp('TRACK ALL', async () => {
        // `trackerNumAnimals` is module-private and only settable through
        // `promptNumAnimals()`, so drive the real path with a stubbed prompt
        // rather than reaching into module state.
        const origPrompt = window.prompt;
        window.prompt = () => '2';
        // Start clean, so the dirty flag afterwards is Track All's own doing.
        // The automatic ID-switch checks that follow Track All are switched off
        // for this one run: when one runs it calls markDirty() itself, which
        // would hide a tracker that never marks the project.
        const saveLoad = await import('/import-export/save-load.js');
        const settings = await import('/ui/settings.js');
        const prevThresholds = settings.getTrackingThresholds();
        settings.setTrackingThresholds(Object.assign({}, prevThresholds,
            { autoSwitchCheck: 0, autoImageSwitchCheck: 0 }));
        saveLoad.clearDirty();
        try {
            const tk = await import('/pose/tracker.js');
            const t = performance.now();
            const wasDirty = window.__lucid.state.isDirty;
            await tk.trackAll();
            return { ms: Math.round(performance.now() - t), wasDirty, isDirty: window.__lucid.state.isDirty };
        } catch (e) {
            return { err: String(e && e.stack || e).slice(0, 400) };
        } finally {
            window.prompt = origPrompt;
            settings.setTrackingThresholds(prevThresholds);
        }
    });
    check('Track All did not throw', !(trackRes.r && trackRes.r.err),
        trackRes.r && trackRes.r.err);
    // The tracking result is the project's newest state; without the flag the
    // save dot never shows and closing the tab loses it without a prompt.
    check('Track All marked the project dirty (unsaved changes)',
        trackRes.r && trackRes.r.wasDirty === false && trackRes.r.isDirty === true,
        trackRes.r && { wasDirty: trackRes.r.wasDirty, isDirty: trackRes.r.isDirty });
    check('Track All rebuilt grouping for ~every frame (not resident-only)',
        trackRes.s.igFrames >= FRAMES * 0.95,
        { igFrames: trackRes.s.igFrames, frames: FRAMES });
    check('Track All rebuilt frameIdentityMap across the project',
        trackRes.s.fim >= FRAMES * CAMS * 0.95,
        { fim: trackRes.s.fim, expectAtLeast: Math.round(FRAMES * CAMS * 0.95) });
    check('Track All released its windows (memory bounded)',
        trackRes.s.resident < FRAMES / 10, { resident: trackRes.s.resident });
    // ...and the 2D of the members it hydrated: outside the resident frames every
    // unedited member is back to a placeholder on the ONE shared NaN buffer, as
    // after a reopen (pose/lazy-residency.js `releaseFrameMembers2D`). Before,
    // all of them kept an ArrayBuffer each — half the cost of every full GC on a
    // real project.
    const after2d = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const s = window.__lucid.state.session;
        let members = 0, placeholders = 0, sharedBuf = 0, ownOffResident = 0;
        for (const [f, gs] of s.instanceGroups) {
            const resident = s.frameGroups.has(f);
            for (const g of gs) for (const [, m] of g.instances) {
                members++;
                if (m._lazy2d) { placeholders++; if (pd.isLazyPlaceholderXY(m._xy)) sharedBuf++; }
                else if (!resident && m.type === 'predicted' && !m.modified) ownOffResident++;
            }
        }
        return { members, placeholders, sharedBuf, ownOffResident, resident: s.frameGroups.size };
    });
    check('after Track All, unedited members of non-resident frames gave their 2D back (one shared buffer)',
        after2d.ownOffResident === 0 && after2d.placeholders > after2d.members * 0.9 && after2d.sharedBuf === after2d.placeholders,
        after2d);
    // Track All rebuilds the grouping of every frame, almost none of them
    // resident; the counters must follow it.
    await checkCounters('after Track All');

    const save6 = await save('c6');
    const s7 = await reopen(save6.target, 'after Track All');
    check('grouping from Track All survived save+reload',
        s7.igFrames >= FRAMES * 0.95, { igFrames: s7.igFrames, frames: FRAMES });
    await checkPooled('after Track All + save + reopen');
    check('frameIdentityMap from Track All survived save+reload',
        s7.fim >= FRAMES * CAMS * 0.95, { fim: s7.fim });

    // =========================================================
    // CYCLE 7 — PLAYBACK gives back what it played (pose/lazy-residency.js)
    // =========================================================
    // The app's real lazy playback loader (`onPlaybackStateChange(true)`), driven
    // without video: the playhead advances ~60 fps in 100 ms ticks and every
    // frame is drawn, so `fillLazyReprojections` derives each frame's
    // reprojections as real playback does. Before the trim every played frame
    // stayed resident with those caches, and playback degraded run by run. Two
    // edits sit on frames the run leaves far behind and must survive it: an
    // ungrouped frame with one of its predictions DELETED (evicting it would
    // resurrect the prediction), and the frame the ungroup itself touched.
    const PLAY_FROM = 20, PLAY_FRAMES = Math.min(3000, FRAMES - 40);
    const play = await runOp(`PLAY ${PLAY_FRAMES} frames (lazy playback loader, no video)`, async ({ PLAY_FROM, PLAY_FRAMES }) => {
        const st = window.__lucid.state, s = st.session;
        const [tri, uw, rendering, LR] = await Promise.all([
            import('/pose/triangulation.js'), import('/ui/ui-wiring.js'),
            import('/ui/rendering.js'), import('/pose/lazy-residency.js')]);
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        // The edit: ungroup an animal on frame 5, then delete one of the
        // predictions that became unlinked.
        const EF = 5;
        await tri.ensureLazyFrameData(EF);
        const g = (s.instanceGroups.get(EF) || [])[0];
        if (!g) return { err: 'no group on frame ' + EF };
        s.unlinkGroup(EF, g, false);
        const fg = s.frameGroups.get(EF);
        const camWith = [...fg.unlinkedInstances.keys()].find(c => fg.unlinkedInstances.get(c).length > 0);
        const victim = fg.unlinkedInstances.get(camWith)[0];
        fg.removeUnlinkedById(victim.id);
        const unlinkedBefore = [...fg.unlinkedInstances.values()].reduce((a, l) => a + l.length, 0);
        const victimRow = victim.instance._rawInstIndex;

        st.trailLength = 0;
        st.currentFrame = PLAY_FROM;
        st.isPlaying = true;
        uw.onPlaybackStateChange(true);
        let maxResident = 0;
        try {
            for (let f = PLAY_FROM; f < PLAY_FROM + PLAY_FRAMES; f += 6) {
                st.currentFrame = f;
                rendering.drawAllOverlays(f);
                await wait(20);
                maxResident = Math.max(maxResident, s.frameGroups.size);
            }
        } finally {
            st.isPlaying = false;
            uw.onPlaybackStateChange(false);
        }
        await wait(300);
        const fgAfter = s.frameGroups.get(EF);
        const ahead = LR.lazyPlaybackLookahead(s.lazyLoader);
        const early = PLAY_FROM + 200;   // played, then left > behind + slack frames behind
        return {
            maxResident, resident: s.frameGroups.size, ahead, behind: LR.LAZY_PLAYBACK_BEHIND,
            slack: LR.LAZY_TRIM_SLACK, triResults: st.triangulationResults.size,
            editedResident: !!fgAfter,
            unlinkedAfter: fgAfter ? [...fgAfter.unlinkedInstances.values()].reduce((a, l) => a + l.length, 0) : null,
            unlinkedBefore,
            victimBack: fgAfter ? (fgAfter.unlinkedInstances.get(camWith) || []).some(u => u.instance._rawInstIndex === victimRow) : null,
            earlyResident: s.frameGroups.has(early),
            earlyReproj: (s.instanceGroups.get(early) || []).some(gg => gg.reprojections || (gg.reprojectedInstances && gg.reprojectedInstances.size)),
        };
    }, { PLAY_FROM, PLAY_FRAMES });
    if (play.r && !play.r.err) {
        const p = play.r;
        // Window + slack + the frames kept for edits, plus one tick of growth
        // before the trim that follows it.
        const bound = p.ahead + p.behind + 1 + p.slack + 2 + 64;
        check(`playback kept the resident window bounded (max ${p.maxResident} <= ${bound}, ${PLAY_FRAMES} frames played)`,
            p.maxResident <= bound, p);
        check('played frames far behind the playhead were given back, with their derived reprojections',
            !p.earlyResident && !p.earlyReproj, p);
        check('derived triangulation results stay bounded too', p.triResults <= bound, { triResults: p.triResults });
        check('the edited frame stayed resident', p.editedResident, p);
        check('the deleted prediction did NOT come back', p.victimBack === false && p.unlinkedAfter === p.unlinkedBefore, p);
    } else {
        check('playback step ran', false, play.r);
    }
    // Paused navigation is bounded too: `ensureLazyFrameData`, where a frame
    // enters while paused, trims around the frame it hydrated. 200 scattered
    // jumps through the app's own navigation entry point, each hydrating the
    // frame plus 30 prefetched — about 6,000 frames without the trim.
    const scrub = await runOp('SCRUB 200 scattered jumps (paused)', async () => {
        const st = window.__lucid.state, s = st.session;
        const [init, LR] = await Promise.all([import('/pose/initialization.js'), import('/pose/lazy-residency.js')]);
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const n = s.lazyLoader.nFrames;
        const unlinked5 = () => { const fg = s.frameGroups.get(5); return fg ? [...fg.unlinkedInstances.values()].reduce((a, l) => a + l.length, 0) : null; };
        const before5 = unlinked5();
        let maxResident = 0, notShown = 0;
        for (let k = 0; k < 200; k++) {
            const f = (k * 2671 + 113) % n;
            init.navigateToFrame(f);
            await wait(5);
            if (!s.frameGroups.has(f)) notShown++;
            maxResident = Math.max(maxResident, s.frameGroups.size);
        }
        return { maxResident, resident: s.frameGroups.size, win: LR.LAZY_NAV_WINDOW, slack: LR.LAZY_TRIM_SLACK,
                 notShown, edited5: s.frameGroups.has(5), before5, after5: unlinked5() };
    });
    if (scrub.r && !scrub.r.err) {
        const c = scrub.r;
        // Both sides of the frame, its 30-frame prefetch, slack, and the frames
        // kept for edits (frame 0's member edit, frame 5's deletion).
        const bound = 2 * c.win + 1 + c.slack + 31 + 2;
        check(`scrubbing kept the resident window bounded (max ${c.maxResident} <= ${bound})`, c.maxResident <= bound, c);
        check('every frame navigated to was resident when drawn', c.notShown === 0, c);
        check('the edited frame survived the scrubbing, its deletion intact',
            c.edited5 && c.after5 === c.before5, c);
    } else {
        check('scrub step ran', false, scrub.r);
    }
    // Playback evicted thousands of frames: the project must still save and
    // reopen whole (one group fewer — the ungroup above).
    const save7 = await save('c7');
    const s8 = await reopen(save7.target, 'after playback');
    check('grouping survived playback + save + reload (minus the one ungroup)',
        s8.groups === s7.groups - 1, { got: s8.groups, want: s7.groups - 1 });
    check('3D still all-finite after playback', s8.nan3d === 0, { nan3d: s8.nan3d });
    // (>=: the ungroup may add retained per-frame identities — luc3d #201.)
    check('frameIdentityMap survived playback + save + reload', s8.fim >= s7.fim, { got: s8.fim, want: s7.fim });

    // =========================================================
    // Memory: the whole point is that N cycles do not grow without bound
    // =========================================================
    log('');
    log('=== heap across the sequence ===');
    for (const h of history) {
        log(`  step ${String(h.step).padStart(2)}  ${String(h.snap.usedMB).padStart(5)} MB  resident=${String(h.snap.resident).padStart(5)}  ${h.label}`);
    }
    const firstReopen = history.find(h => h.label.startsWith('after reopen'));
    const lastReopen = [...history].reverse().find(h => h.label.startsWith('after reopen'));
    if (firstReopen && lastReopen && firstReopen !== lastReopen) {
        const growth = lastReopen.snap.usedMB - firstReopen.snap.usedMB;
        // Reopen-to-reopen the app should return to a comparable footprint. A
        // steadily climbing baseline across cycles is the leak signature.
        check(`heap does not balloon across cycles (Δ${growth} MB reopen→reopen)`,
            growth < Math.max(400, firstReopen.snap.usedMB * 0.6),
            { first: firstReopen.snap.usedMB, last: lastReopen.snap.usedMB });
    }
} catch (err) {
    log('FATAL ' + String(err && err.stack || err).slice(0, 700));
    fails++;
} finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
    server.kill();
    if (!KEEP) for (const f of outFiles) { try { fs.unlinkSync(f); } catch (e) {} }
    else log('kept: ' + outFiles.join(', '));
}

log(fails === 0 ? `\nPASS (${el()})` : `\nFAIL (${fails}) (${el()})`);
process.exit(fails === 0 ? 0 : 1);
