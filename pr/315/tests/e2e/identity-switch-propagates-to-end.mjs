/**
 * identity-switch-propagates-to-end.mjs — a MANUAL identity switch must apply
 * from the current frame through the END of the timeline, in EVERY view
 * (luc3d #172, "IDs only partially propagating when switching").
 *
 * ## The bug this pins
 *
 * `Session.propagateIdentity` walks forward from the current frame and stamps
 * `identityId` onto ONE (camera, rawTrackIdx) pair — so it only reaches frames
 * where that exact raw track index is still present, and only in the cameras the
 * selected group happens to have an instance in at the moment of the fix. Real
 * per-camera tracker output FRAGMENTS: the same animal is track 4 for a few
 * hundred frames, then track 12, then track 20. Identity, by contrast, is dense
 * across the whole project (`frameIdentityMap` has an entry per
 * frame x camera x track — that is why it is per-frame keyed at all). So a
 * correction propagated along a track dies at the first fragment boundary:
 * "only a small fragment of the ID propagates down the timeline and i would
 * have to do it many many times", plus the reporter's "the propagation appears
 * limited to tracks visible in the current view".
 *
 * ## Fixture shape (both properties are load-bearing)
 *
 *  - FRAGMENTED raw tracks: animal `a` occupies track `2*floor(f/SEG) + a`, so
 *    track parity identifies the animal for the whole project while the track
 *    INDEX changes every SEG frames. A fixture with one contiguous track per
 *    animal (what `sequence-lazy-workflow.mjs` builds) cannot see this bug.
 *  - LAZY: thousands of frames so almost none come back resident. Asserted, so
 *    the harness cannot silently stop testing the lazy path.
 *  - animal 0 is MISSING from the last camera on the correction frame only, so
 *    "all views" vs "views the group is visible in" is directly observable.
 *
 * Usage:
 *   node tests/e2e/identity-switch-propagates-to-end.mjs
 *   FRAMES=8000 SEG=500 CAMS=4 KEEP=1 node tests/e2e/...
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8207);
const FRAMES = Number(process.env.FRAMES || 3000);
const SEG = Number(process.env.SEG || 200);
const CAMS = Number(process.env.CAMS || 3);
const NODES = Number(process.env.NODES || 3);
const KEEP = !!process.env.KEEP;
// The frame the user makes the correction on. Deliberately NOT 0 and not a
// segment boundary: the fix must cover the tail of the current fragment too.
const FIXFRAME = Number(process.env.FIXFRAME || Math.floor(SEG * 1.5));
const NSEG = Math.ceil(FRAMES / SEG);
const ANIMALS = 2;

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
    const p = path.join(repoRoot, `_idsw-${tag}.slp`);
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

    let sink = { fd: null, bytes: 0, target: null };
    await page.exposeFunction('__idWrite', (b64) => {
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

    await page.evaluate(() => {
        window.__idB64 = (u8) => {
            let s = ''; const C = 0x8000;
            for (let o = 0; o < u8.length; o += C) s += String.fromCharCode.apply(null, u8.subarray(o, o + C));
            return btoa(s);
        };
        window.showSaveFilePicker = async () => ({
            createWritable: async () => ({
                write: async (chunk) => {
                    const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                    await window.__idWrite(window.__idB64(u8));
                },
                close: async () => {},
            }),
        });

        /**
         * Re-derive, for every frame of the project, which identity each animal
         * currently resolves to — through the SAME resolver the canvas, the 3D
         * viewport and the ID timeline use (`getIdentityIdForTrack` on the
         * group's live per-camera trackIdx, falling back to `group.identityId`
         * exactly as `getGroupColor` does). Nothing is remembered; a step that
         * under-applies shows up as a shortfall here.
         *
         * Animal = trackIdx parity (see the fixture note in the file header).
         */
        window.__idScan = ({ camNames }) => {
            const s = window.__lucid.state.session;
            if (!s) return { err: 'no session' };
            // perCam[cam][animal] = # frames resolving to identity `animal ^ 1`
            // (i.e. the SWAPPED label) and to `animal` (the original label).
            const perCam = {};
            for (const cn of camNames) perCam[cn] = { swapped: 0, original: 0, none: 0, seen: 0 };
            let framesWithBothSwapped = 0;
            const detail = [];
            let lastFrameSeen = -1;
            for (const [f, gs] of s.instanceGroups) {
                let swappedThisFrame = 0, animalsThisFrame = 0;
                for (const g of gs) {
                    for (const [cn, inst] of (g.instances || new Map())) {
                        if (inst == null || inst.trackIdx == null || inst.trackIdx < 0) continue;
                        const animal = inst.trackIdx % 2;
                        let v = s.getIdentityIdForTrack(cn, inst.trackIdx, f);
                        if (v == null && g.identityId != null && g.identityId >= 0) v = g.identityId;
                        const rec = perCam[cn];
                        if (!rec) continue;
                        rec.seen++;
                        if (v == null) rec.none++;
                        else if (v === (animal ^ 1)) { rec.swapped++; swappedThisFrame++; }
                        else if (v === animal) rec.original++;
                    }
                    animalsThisFrame++;
                }
                // A frame counts as fully swapped when BOTH animals read as the
                // other's identity in EVERY camera they appear in.
                let camViews = 0;
                for (const g of gs) for (const [, i] of (g.instances || new Map())) if (i && i.trackIdx != null && i.trackIdx >= 0) camViews++;
                if (camViews > 0 && swappedThisFrame === camViews) framesWithBothSwapped++;
                if (f > lastFrameSeen) lastFrameSeen = f;
                if (detail.length < 3 || f >= lastFrameSeen) { /* no-op, kept cheap */ }
            }
            // Explicit probe of the LAST frame — the assertion that matters.
            const lastF = Math.max(...s.instanceGroups.keys());
            const last = [];
            for (const g of (s.instanceGroups.get(lastF) || [])) {
                for (const [cn, inst] of (g.instances || new Map())) {
                    if (inst == null || inst.trackIdx == null) continue;
                    let v = s.getIdentityIdForTrack(cn, inst.trackIdx, lastF);
                    if (v == null && g.identityId != null && g.identityId >= 0) v = g.identityId;
                    last.push({ cam: cn, trk: inst.trackIdx, animal: inst.trackIdx % 2, id: v });
                }
            }
            // Group-level `identityId` on the last frame. Separate from the
            // per-frame scan on purpose: this is the field saved into the
            // columnar `instance_groups` table and the one
            // `propagateIdentitiesToTracks` (IDs -> Tracks) reads directly, so a
            // swap that only rewrote `frameIdentityMap` would be silently undone
            // by the next IDs -> Tracks. Animal = track parity, as everywhere here.
            const lastGroups = [];
            for (const g of (s.instanceGroups.get(lastF) || [])) {
                let animal = null;
                for (const [, inst] of (g.instances || new Map())) {
                    if (inst && inst.trackIdx != null && inst.trackIdx >= 0) { animal = inst.trackIdx % 2; break; }
                }
                lastGroups.push({ animal, identityId: g.identityId });
            }
            return {
                perCam, framesWithBothSwapped, lastF, last, lastGroups, detail,
                igFrames: s.instanceGroups.size,
                fim: s.frameIdentityMap ? s.frameIdentityMap.size : 0,
                tracks: s.tracks ? s.tracks.slice() : [],
                identities: (s.identities || []).map(i => ({ id: i.id, name: i.name })),
                resident: s.frameGroups ? s.frameGroups.size : 0,
            };
        };
    });

    // ---------------- build the fixture ----------------
    log(`building fixture: ${FRAMES} frames x ${CAMS} cams x ${NODES} nodes, ` +
        `tracks fragmented every ${SEG} frames (${NSEG * ANIMALS} tracks)`);
    const fixturePath = outPath('fixture');
    beginSink(fixturePath);
    const buildInfo = await page.evaluate(async ({ FRAMES, CAMS, NODES, SEG, NSEG, ANIMALS, FIXFRAME }) => {
        const [pd, fileio] = await Promise.all([
            import('/pose/pose-data.js'), import('/import-export/file-io.js'),
        ]);
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;
        const camNames = Array.from({ length: CAMS }, (_, i) => 'cam' + i);
        const nodeNames = Array.from({ length: NODES }, (_, i) => 'n' + i);
        const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
        const cameras = camNames.map((n, i) => {
            const a = (i / CAMS) * 1.2 - 0.6;
            return new Camera(n, M, [0, 0, 0, 0, 0], [0, a, 0],
                [-40 * Math.sin(a), 0, 40 * (1 - Math.cos(a))], [512, 512]);
        });
        const skeleton = new Skeleton('skeleton', nodeNames, nodeNames.slice(1).map((_, i) => [i, i + 1]));
        // Fragmented raw tracks: trk_<2*seg + animal>.
        const trackNames = Array.from({ length: NSEG * ANIMALS }, (_, i) => 'trk_' + i);
        const session = new Session(cameras, skeleton, trackNames, 'IdSwitchFixture');
        session.identities = [{ id: 0, name: 'animal0' }, { id: 1, name: 'animal1' }];
        const trackOf = (f, a) => 2 * Math.floor(f / SEG) + a;

        const xy = (f, c, k) => [180 + (f % 97) * 1.5 + c * 11 + k * 3, 200 + (f % 89) * 1.25 + c * 7 + k * 2];
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            const groupsThisFrame = [];
            for (let a = 0; a < ANIMALS; a++) {
                const trk = trackOf(f, a);
                const g = new InstanceGroup(f * ANIMALS + a + 1, a);
                camNames.forEach((cn, ci) => {
                    // Animal 0 is OCCLUDED in the last camera on the correction
                    // frame only — the "not visible in this view right now" case.
                    if (a === 0 && f === FIXFRAME && ci === CAMS - 1) return;
                    const inst = new Instance(
                        nodeNames.map((_, k) => {
                            const p = xy(f, ci, k);
                            return a === 0 ? p : [p[0] + 120, p[1] + 60];
                        }), trk, 'predicted', 1);
                    inst._rawInstIndex = a;
                    fg.addInstance(cn, inst);
                    g.addInstance(cn, inst);
                    // Dense per-(frame, camera, track) identity — what Track All
                    // and a real tracked project produce.
                    session.setFrameIdentity(f, cn, trk, a);
                });
                g.points3d = new Float64Array(NODES * 3).fill(0)
                    .map((_, i) => (f % 31) + i * 0.5 + a * 40);
                groupsThisFrame.push(g);
            }
            session.instanceGroups.set(f, groupsThisFrame);
        }
        const views = camNames.map(n => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: FRAMES }));
        const videoFiles = camNames.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const labels = fileio.buildSlpLabelsAllViews(session, views, videoFiles);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);
        await window.__idWrite(window.__idB64(bytes));
        return { bytes: bytes.length, camNames, nTracks: trackNames.length, fim: session.frameIdentityMap.size };
    }, { FRAMES, CAMS, NODES, SEG, NSEG, ANIMALS, FIXFRAME });
    const fixtureBytes = endSink();
    log(`fixture written: ${fixtureBytes.toLocaleString()} bytes (fim=${buildInfo.fim})`);
    const camNames = buildInfo.camNames;

    // ---------------- reopen lazily ----------------
    const reopen = async (file, label) => {
        log(`REOPEN ${label} (${path.basename(file)})`);
        await page.evaluate(() => {
            const old = document.getElementById('__idPick');
            if (old) old.remove();
            const inp = document.createElement('input');
            inp.type = 'file'; inp.id = '__idPick';
            inp.style.cssText = 'position:fixed;left:-9999px';
            document.body.appendChild(inp);
        });
        await page.setInputFiles('#__idPick', file);
        await page.evaluate(() => {
            window.__idLoad = { done: false, err: null };
            (async () => {
                try {
                    const sl = await import('/loading/session-loader.js');
                    await sl.handleLoadProjectSlpLazy(document.getElementById('__idPick').files[0]);
                    window.__idLoad.done = true;
                } catch (e) { window.__idLoad.err = String(e && e.stack || e).slice(0, 400); }
            })();
        });
        for (let i = 0; i < 1200; i++) {
            const s = await page.evaluate(() => {
                const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || ''));
                if (b) { b.click(); return 'clicked'; }
                return window.__idLoad.done ? 'done' : (window.__idLoad.err ? 'err' : 'wait');
            });
            if (s === 'done' || s === 'err') break;
            await new Promise(r => setTimeout(r, 250));
        }
        const err = await page.evaluate(() => window.__idLoad.err);
        check(`reopen ${label} completed`, !err, err || undefined);
        return await page.evaluate((a) => window.__idScan(a), { camNames });
    };

    const s0 = await reopen(fixturePath, 'fixture');
    check('all frames came back', s0.igFrames === FRAMES, { got: s0.igFrames, want: FRAMES });
    check(`lazy precondition: most frames NOT resident (${s0.resident} << ${FRAMES})`,
        s0.resident < FRAMES / 10, { resident: s0.resident, frames: FRAMES });
    check('fragmented track list round-tripped in order',
        s0.tracks.length === NSEG * ANIMALS && s0.tracks[0] === 'trk_0' &&
        s0.tracks[s0.tracks.length - 1] === 'trk_' + (NSEG * ANIMALS - 1),
        { n: s0.tracks.length, first: s0.tracks[0], last: s0.tracks[s0.tracks.length - 1] });
    check('frameIdentityMap survived the reopen (dense identity)',
        s0.fim >= FRAMES * CAMS * ANIMALS - CAMS, { fim: s0.fim, want: FRAMES * CAMS * ANIMALS });
    check('BEFORE the switch nothing reads as swapped',
        s0.framesWithBothSwapped === 0, { framesWithBothSwapped: s0.framesWithBothSwapped });

    // ---------------- the user action: switch the two IDs ----------------
    log(`\nSWITCH IDs on frame ${FIXFRAME} (assign animal1 to the animal-0 group)`);
    const act = await page.evaluate(async ({ FIXFRAME }) => {
        const [tri, ia] = await Promise.all([
            import('/pose/triangulation.js'), import('/ui/identity-assignment.js'),
        ]);
        const st = window.__lucid.state;
        const s = st.session;
        // Scrub to the frame, the way a user would (hydrates its 2D).
        await tri.ensureLazyFrameData(FIXFRAME);
        st.currentFrame = FIXFRAME;
        const gs = s.instanceGroups.get(FIXFRAME) || [];
        let target = null;
        for (const g of gs) {
            for (const [, inst] of g.instances) {
                if (inst && inst.trackIdx != null && inst.trackIdx % 2 === 0) { target = g; break; }
            }
            if (target) break;
        }
        if (!target) return { err: 'no animal-0 group on the correction frame' };
        const im = window.__lucid.interactionManager;
        if (!im) return { err: 'no interactionManager' };
        im.selectedInstanceGroup = target;
        im.selectedUnlinked = null;
        const before = {
            groupIdentity: target.identityId,
            cams: [...target.instances.keys()],
        };
        let err = null;
        const t = performance.now();
        try { ia.assignIdentityToSelected(1, 'animal1'); }
        catch (e) { err = String(e && e.stack || e).slice(0, 400); }
        const ms = Math.round(performance.now() - t);
        const statusEl = document.getElementById('statusText');
        return { before, err, ms, status: statusEl ? statusEl.textContent : null };
    }, { FIXFRAME });
    check('the identity switch did not throw', !act.err, act.err || undefined);
    log(`  status line: ${JSON.stringify(act.status)}   (${act.ms} ms)`);
    check('the switch is fast enough not to hang the UI', act.ms != null && act.ms < 5000, { ms: act.ms });

    const s1 = await page.evaluate((a) => window.__idScan(a), { camNames });
    const FRAMES_FROM_FIX = FRAMES - FIXFRAME;
    log(`  frames fully swapped: ${s1.framesWithBothSwapped} / ${FRAMES_FROM_FIX} expected ` +
        `(fix frame ${FIXFRAME} .. ${FRAMES - 1})`);
    for (const cn of camNames) {
        log(`  ${cn}: swapped=${s1.perCam[cn].swapped} original=${s1.perCam[cn].original} none=${s1.perCam[cn].none}`);
    }
    check('the switch propagated to the END of the timeline, not one fragment',
        s1.framesWithBothSwapped >= FRAMES_FROM_FIX - 1,
        { swappedFrames: s1.framesWithBothSwapped, wantAtLeast: FRAMES_FROM_FIX - 1, fixFrame: FIXFRAME });
    check('the LAST frame of the project reads as swapped for BOTH animals',
        s1.last.length > 0 && s1.last.every(r => r.id === (r.animal ^ 1)),
        { lastFrame: s1.lastF, entries: s1.last });
    check('the switch reached EVERY camera, including one the group was not visible in',
        camNames.every(cn => s1.perCam[cn].swapped >= FRAMES_FROM_FIX * ANIMALS - 2),
        Object.fromEntries(camNames.map(cn => [cn, s1.perCam[cn]])));
    check('frames BEFORE the correction were left alone (forward-only, issue #155)',
        s1.framesWithBothSwapped <= FRAMES_FROM_FIX,
        { swappedFrames: s1.framesWithBothSwapped, max: FRAMES_FROM_FIX });
    check('group-level identityId swapped too (what IDs -> Tracks reads)',
        s1.lastGroups.length > 0 && s1.lastGroups.every(g => g.identityId === (g.animal ^ 1)),
        { lastGroups: s1.lastGroups });
    // The user-visible count must not overstate what changed.
    const reported = act.status && /\((?:propagated|swapped)[^\d]*(\d+)/.exec(act.status);
    if (reported) {
        const n = Number(reported[1]);
        log(`  reported count = ${n}`);
        check('the reported count is not an overstatement',
            n <= s1.fim + s1.igFrames * ANIMALS, { reported: n });
        check('the reported count reflects a whole-timeline change (not a fragment)',
            n >= FRAMES_FROM_FIX, { reported: n, wantAtLeast: FRAMES_FROM_FIX });
    } else {
        check('the status line reports a propagation count', false, { status: act.status });
    }

    // ---------------- save -> reopen: did it stick? ----------------
    log('\nSAVE and REOPEN');
    const target = outPath('resaved');
    beginSink(target);
    const saveRes = await page.evaluate(async () => {
        const saveLoad = await import('/import-export/save-load.js');
        const t = performance.now();
        let err = null;
        try { await saveLoad.saveAs({ skipSizeWarning: true }); }
        catch (e) { err = String(e && e.stack || e).slice(0, 500); }
        return { ms: Math.round(performance.now() - t), err };
    });
    const bytes = endSink();
    check('save completed', !saveRes.err, saveRes.err || undefined);
    log(`  wrote ${bytes.toLocaleString()} bytes in ${saveRes.ms} ms`);

    const s2 = await reopen(target, 'after the switch');
    check('the switch SURVIVED save + reopen (whole timeline)',
        s2.framesWithBothSwapped >= FRAMES_FROM_FIX - 1,
        { swappedFrames: s2.framesWithBothSwapped, wantAtLeast: FRAMES_FROM_FIX - 1 });
    check('the LAST frame still reads as swapped after the round trip',
        s2.last.length > 0 && s2.last.every(r => r.id === (r.animal ^ 1)),
        { lastFrame: s2.lastF, entries: s2.last });
    check('group-level identityId survived the round trip (columnar instance_groups)',
        s2.lastGroups.length > 0 && s2.lastGroups.every(g => g.identityId === (g.animal ^ 1)),
        { lastGroups: s2.lastGroups });
} catch (err) {
    log('FATAL ' + String(err && err.stack || err).slice(0, 900));
    fails++;
} finally {
    if (browser) { try { await browser.close(); } catch (e) {} }
    server.kill();
    if (!KEEP) for (const f of outFiles) { try { fs.unlinkSync(f); } catch (e) {} }
    else log('kept: ' + outFiles.join(', '));
}

log(fails === 0 ? `\nPASS (${el()})` : `\nFAIL (${fails}) (${el()})`);
process.exit(fails === 0 ? 0 : 1);
