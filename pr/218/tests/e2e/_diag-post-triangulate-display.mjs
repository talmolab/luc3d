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

    // =====================================================================
    // THE PROBE — navigate like a user and ask what the overlay/panel sees.
    // =====================================================================
    // Reported symptom: after Triangulate All the reprojections vanish from the
    // instance panel and the IDs vanish from the 2D views, EXCEPT on the frame
    // that was on screen (and, in one report, except for a single camera). The
    // windowed sweep deliberately does NOT retain `group.reprojections` (~1.9 GB
    // at 531,799 groups) and relies on `drawAllOverlays` recomputing them per
    // frame on demand. So the question is not "did the sweep run" (coverage is
    // asserted above) but "does the on-demand recompute actually fire when you
    // navigate, for EVERY camera".
    log('');
    log('=== navigating to probe frames and reading what the UI would draw ===');
    const probes = [0, 1, 2, Math.floor(FRAMES / 4), Math.floor(FRAMES / 2), FRAMES - 2];
    const rows = await page.evaluate(async (probeFrames) => {
        const out = [];
        const st = window.__lucid.state;
        const init = await import('/pose/initialization.js');
        const tri = await import('/pose/triangulation.js');
        for (const f of probeFrames) {
            // Drive the REAL navigation path the transport/timeline uses, so
            // hydration happens exactly as it does for a user.
            await init.navigateToFrame(f);
            // navigateToFrame kicks async hydration + a redraw; give it a beat.
            for (let i = 0; i < 40; i++) {
                await new Promise(r => setTimeout(r, 25));
                if (st.session.frameGroups.has(f)) break;
            }
            await new Promise(r => setTimeout(r, 60));

            const groups = st.session.instanceGroups.get(f) || [];
            const camNames = st.session.cameras.map(c => c.name);
            let withReproj = 0, reprojCams = new Set(), membersWith2d = 0, members = 0, with3d = 0;
            for (const g of groups) {
                if (tri.points3dNodeCount ? tri.points3dNodeCount(g.points3d) > 0 : !!g.points3d) with3d++;
                const rp = g.reprojections ? Object.keys(g.reprojections) : [];
                if (rp.length) { withReproj++; rp.forEach(c => reprojCams.add(c)); }
                for (const [cn, inst] of g.instances) {
                    members++;
                    if (inst && inst.hasAnyUsablePoint && inst.hasAnyUsablePoint()) membersWith2d++;
                }
            }
            // What the instance panel's reprojection-error column reads.
            const triRes = (st.triangulationResults.get(f) || []).length;
            out.push({
                f, resident: st.session.frameGroups.has(f), groups: groups.length, with3d,
                withReproj, reprojCams: Array.from(reprojCams).sort(),
                members, membersWith2d, triRes, nCams: camNames.length, camNames,
            });
        }
        return out;
    }, probes);

    console.log('');
    console.log('  frame | resident | groups | 3D | w/reproj | reprojCams | members(2D) | triResults');
    for (const r of rows) {
        console.log(`  ${String(r.f).padStart(6)} | ${String(r.resident).padStart(8)} | ` +
            `${String(r.groups).padStart(6)} | ${String(r.with3d).padStart(2)} | ` +
            `${String(r.withReproj).padStart(8)} | ${String(r.reprojCams.length + '/' + r.nCams).padStart(10)} | ` +
            `${String(r.members + '(' + r.membersWith2d + ')').padStart(11)} | ${String(r.triRes).padStart(10)}`);
    }
    const broken = rows.filter(r => r.groups > 0 && r.withReproj < r.groups);
    const partialCam = rows.filter(r => r.withReproj > 0 && r.reprojCams.length < r.nCams);
    console.log('');
    console.log(`SUMMARY: ${broken.length}/${rows.length} probe frames show FEWER reprojected groups than groups;`);
    console.log(`         ${partialCam.length}/${rows.length} show reprojections for only SOME cameras.`);
    if (partialCam.length) {
        for (const r of partialCam) {
            console.log(`         frame ${r.f}: reproj cams = [${r.reprojCams.join(', ')}] of [${r.camNames.join(', ')}]`);
        }
    }

    await browser.close();
    server.kill();
    process.exit(0);
} catch (err) {
    console.error(err);
    process.exit(1);
}
