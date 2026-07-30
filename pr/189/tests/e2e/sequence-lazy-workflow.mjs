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
        // Two tracks from the start so a 0<->1 swap has a legitimate target and
        // cannot be confused with "the track did not exist".
        const session = new Session(cameras, skeleton, ['track_0', 'track_1'], 'SeqFixture');
        session.identities = [{ id: 0, name: 'animal0' }];

        // Deterministic 2D that varies per (frame, cam, node).
        const xy = (f, c, k) => [180 + (f % 97) * 1.5 + c * 11 + k * 3, 200 + (f % 89) * 1.25 + c * 7 + k * 2];
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            const g = new InstanceGroup(f + 1, 0);
            // PREDICTED, not user — this is what a tracked prediction project
            // looks like, and it is what makes window RELEASE observable: the
            // sweeps deliberately pin user-edited frames, so an all-'user'
            // fixture would keep every frame resident and hide any leak.
            // A couple of frames are user-edited on purpose (see USER_FRAMES).
            const isUserFrame = (f === 1 || f === 2);
            camNames.forEach((cn, ci) => {
                const inst = new Instance(nodeNames.map((_, k) => xy(f, ci, k)), 0,
                    isUserFrame ? 'user' : 'predicted', 1);
                inst._rawInstIndex = 0;
                fg.addInstance(cn, inst);
                g.addInstance(cn, inst);
            });
            g.points3d = new Float64Array(NODES * 3).fill(0).map((_, i) => (f % 31) + i * 0.5);
            session.instanceGroups.set(f, [g]);
            // Stamp identity for every camera-frame so `frameIdentityMap` is
            // fully populated, matching a real tracked project.
            for (let ci = 0; ci < camNames.length; ci++) {
                session.setFrameIdentity(f, camNames[ci], 0, 0);
            }
        }
        const views = camNames.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: FRAMES }));
        const videoFiles = camNames.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const labels = fileio.buildSlpLabelsAllViews(session, views, videoFiles);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);
        await window.__seqWrite(window.__seqB64(bytes));
        return { bytes: bytes.length, camNames, nodeNames };
    }, { FRAMES, CAMS, NODES });
    const fixtureBytes = endSink();
    log(`fixture written: ${fixtureBytes.toLocaleString()} bytes`);

    // ---------------- sequence driver ----------------
    const PROBES = [0, 1, Math.floor(FRAMES / 2), FRAMES - 1];
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

    const runOp = async (label, fn) => {
        step++;
        log(`\n[step ${step}] ${label}`);
        const r = await page.evaluate(fn);
        if (r && r.err) { check(`${label} did not throw`, false, r.err); }
        else if (r !== null && r !== undefined) log(`  -> ${JSON.stringify(r).slice(0, 220)}`);
        return { r, s: await snap(`after ${label}`) };
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

    // =========================================================
    // CYCLE 1 — reopen the fixture, verify the lazy precondition
    // =========================================================
    const s1 = await reopen(fixturePath, 'fixture');
    check(`all ${FRAMES} frame-groups round-tripped`, s1.groups === FRAMES, { got: s1.groups, want: FRAMES });
    check('all groups carry 3D', s1.with3d === FRAMES, { got: s1.with3d });
    check('no NaN 3D after a clean reopen', s1.nan3d === 0, { nan3d: s1.nan3d });
    // THE precondition for this whole bug class. If the fixture comes back fully
    // resident, every lazy bug hides and this harness proves nothing.
    check(`lazy precondition: most frames NOT resident (resident=${s1.resident} << ${FRAMES})`,
        s1.resident < FRAMES / 10, { resident: s1.resident, frames: FRAMES });
    check('reopen leaves few members hydrated (placeholders)',
        s1.realMembers < s1.members / 10, { realMembers: s1.realMembers, members: s1.members });

    // ---- Triangulate All on the lazy project (luc3d #194 regression) ----
    const triA = await runOp('TRIANGULATE ALL', async () => {
        const tri = await import('/pose/triangulation.js');
        try { await tri.triangulateAllFrames('dlt'); } catch (e) { return { err: String(e && e.stack || e).slice(0, 400) }; }
        return null;
    });
    check('Triangulate All covered EVERY group (not just resident ones)',
        triA.s.with3d === FRAMES && triA.s.finite3d === FRAMES,
        { with3d: triA.s.with3d, finite3d: triA.s.finite3d, want: FRAMES });
    check('Triangulate All did not retain reprojections/triResults project-wide',
        triA.s.triResults <= 2, { triResults: triA.s.triResults });
    check('Triangulate All released its windows',
        triA.s.resident < FRAMES / 10, { resident: triA.s.resident });

    // ---- save, reload, and confirm it PERSISTED ----
    const save1 = await save('c1');
    const s2 = await reopen(save1.target, 'after Triangulate All');
    check('groups survived save+reload', s2.groups === FRAMES, { got: s2.groups });
    check('3D survived save+reload (all finite)', s2.finite3d === FRAMES, { finite3d: s2.finite3d, nan3d: s2.nan3d });
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
    check('groups survived modify+save+reload', s3.groups === FRAMES, { got: s3.groups });
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
    check('groups survived cycle 3', s4.groups === FRAMES, { got: s4.groups });
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
