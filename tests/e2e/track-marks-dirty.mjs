/**
 * track-marks-dirty.mjs — every tracking pass flags the project as unsaved.
 *
 * Track Frame, Track Frame Range and Track All rewrite project state
 * (`session.instanceGroups`, `session.frameIdentityMap`, `session.identities`)
 * but for a long time none of them called `markDirty()`. After Track All on a
 * fresh project the save dot and the `• Lucid` title never appeared,
 * `state.isDirty` / `session.isDirty` stayed false, and closing the tab or
 * switching sessions gave no unsaved-changes prompt — so the whole tracking
 * result could be lost silently.
 *
 * Asserted here, through the real app:
 *
 *  1. **All three entry points mark dirty**, on an eager session AND on a
 *     windowed lazy one (the `sweepTrackAllFrames` path a reopened large
 *     project takes). Each check starts from `clearDirty()`, and asserts every
 *     place the flag shows: `state.isDirty`, the per-session `session.isDirty`
 *     (what the switch-away prompt reads), the window title and the save dot.
 *  2. **A pass that matches NOTHING still marks dirty when it wiped a prior
 *     result.** A pass clears before it re-tracks, so "found no matches" after
 *     an earlier run means memory no longer matches the file. Marking only when
 *     `numTargets > 0` would leave that unflagged — exactly the
 *     re-run-with-different-settings workflow (#212). Each case asserts the
 *     prior result really was wiped, so it cannot pass vacuously.
 *  3. **A pass that bails out before touching anything does NOT mark dirty**
 *     (a NaN range, too few tracked views; on ONE camera Track Frame, Track
 *     Frame Range and a lazy project's Track All) — the flag is set at the
 *     mutation point, not on entry, so a refused click is not an edit. One
 *     camera's Track All itself (SLEAP's tracker) does mark dirty.
 *
 * The automatic ID-switch checks that follow Track All / Track Frame Range are
 * switched OFF for the whole file: when one runs it calls `markDirty()` itself
 * (its checklist is saved in the .slp), which would make (1) pass on a build
 * where the tracker never marks anything. Confirmed: with the tracker's
 * `markDirty()` calls removed, every check in (1) and (2) fails.
 *
 * Run: node tests/e2e/track-marks-dirty.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8099);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const NF = 30;

// "Every place the flag shows" for one dirty-state probe.
const isFullyDirty = (d) => d.state && d.session && d.title && d.dot;
const isFullyClean = (d) => !d.state && !d.session && !d.title && !d.dot;
const fmt = (d) => JSON.stringify(d);

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', msg => { if (msg.type() === 'error') console.log('  [console.error]', msg.text().slice(0, 300)); });
    // The animal count is set through setTrackerNumAnimals, so no native
    // prompt() may fire; fail loudly rather than hiding it.
    page.on('dialog', async d => { console.log('  [unexpected dialog]', d.message()); fails++; await d.dismiss(); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    await page.evaluate(async ({ NF }) => {
        const pd = await import('/pose/pose-data.js');
        const { Skeleton, Camera, Instance, FrameGroup, Session } = pd;
        const AS = await import('/ui/app-state.js');
        const SL = await import('/import-export/save-load.js');
        const settings = await import('/ui/settings.js');
        // See the file header: an auto check that runs marks dirty by itself.
        settings.setTrackingThresholds(Object.assign({}, settings.getTrackingThresholds(),
            { autoSwitchCheck: 0, autoImageSwitchCheck: 0 }));

        // Two cameras with real relative geometry and two well-separated
        // animals (the track-frame-range.mjs fixture).
        window.__mkCams = () => {
            const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
            return [
                new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
                new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.3, 0], [20, 0, 0], [640, 480]),
            ];
        };
        const ANIMALS = [
            [[10, 5, 50], [11, 6, 51]],
            [[-10, 5, 50], [-9, 6, 51]],
        ];
        window.__mkSession = (cams) => {
            const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
            const session = new Session(cams, skel, ['track_0', 'track_1'], 'DirtyFixture');
            for (let f = 0; f < NF; f++) {
                const fg = new FrameGroup(f);
                session.addFrameGroup(fg);
                ANIMALS.forEach((nodes, ai) => {
                    const moved = nodes.map(p => [p[0] + f * 0.2, p[1], p[2]]);
                    for (const cam of cams) {
                        fg.addInstance(cam.name, new Instance(moved.map(p => cam.project(p)), ai, 'predicted', 1));
                    }
                });
            }
            return session;
        };
        window.__install = (session) => {
            AS.state.sessions = [session];
            AS.state.activeSessionIdx = 0;
            AS.state.session = session;
            AS.state.totalFrames = session.numFrames;
            AS.state.currentFrame = 0;
        };
        window.__clean = () => SL.clearDirty();
        window.__dirty = () => {
            const dot = document.getElementById('saveDirtyDot');
            return {
                state: AS.state.isDirty === true,
                session: !!(AS.state.session && AS.state.session.isDirty === true),
                title: document.title.startsWith('•'),
                dot: !!(dot && dot.style.display === 'inline-block'),
            };
        };
        window.__status = () => document.getElementById('statusText').textContent;
    }, { NF });

    // ---------------------------------------------------------------- phase 1
    // Eager session: each entry point, from a clean state.
    const a = await page.evaluate(async () => {
        const tracker = await import('/pose/tracker.js');
        const session = window.__mkSession(window.__mkCams());
        window.__install(session);
        tracker.setTrackerNumAnimals(2);
        const out = {};

        window.__clean();
        out.cleanBefore = window.__dirty();
        tracker.trackCurrentFrame();
        out.frame = { dirty: window.__dirty(), groups: (session.instanceGroups.get(0) || []).length, status: window.__status() };

        window.__clean();
        const range = await tracker.trackFrameRange(5, 12);
        out.range = { dirty: window.__dirty(), ok: range.ok, status: window.__status() };

        window.__clean();
        const all = await tracker.trackAll();
        out.all = { dirty: window.__dirty(), ok: all.ok, identities: session.identities.length,
            groupFrames: session.instanceGroups.size, status: window.__status() };
        return out;
    });
    console.log('  phase 1 (eager):', JSON.stringify(a, null, 2));
    check(isFullyClean(a.cleanBefore), `precondition: clearDirty() leaves the project clean ${fmt(a.cleanBefore)}`);
    check(a.frame.groups === 2, `precondition: Track Frame grouped both animals (${a.frame.groups} groups, "${a.frame.status}")`);
    check(isFullyDirty(a.frame.dirty), `Track Frame marks the project dirty ${fmt(a.frame.dirty)}`);
    check(a.range.ok, `precondition: Track Frame Range succeeded ("${a.range.status}")`);
    check(isFullyDirty(a.range.dirty), `Track Frame Range marks the project dirty ${fmt(a.range.dirty)}`);
    check(a.all.ok && a.all.identities === 2 && a.all.groupFrames === NF,
        `precondition: Track All tracked the whole project (${a.all.identities} identities, ${a.all.groupFrames}/${NF} frames)`);
    check(isFullyDirty(a.all.dirty), `Track All marks the project dirty ${fmt(a.all.dirty)}`);

    // ---------------------------------------------------------------- phase 2
    // A pass that matches nothing, after an earlier run: it still wiped that
    // run's result, so memory no longer matches the file.
    const b = await page.evaluate(async () => {
        const tracker = await import('/pose/tracker.js');
        const AS = await import('/ui/app-state.js');
        const session = window.__mkSession(window.__mkCams());
        window.__install(session);
        tracker.setTrackerNumAnimals(2);
        await tracker.trackAll();
        const out = { groupsBefore: (session.instanceGroups.get(5) || []).length, identitiesBefore: session.identities.length };

        // Track Frame on a frame camB no longer sees: no cross-view match.
        session.getFrameGroup(5).instances.set('camB', []);
        AS.state.currentFrame = 5;
        window.__clean();
        tracker.trackCurrentFrame();
        out.frame = { dirty: window.__dirty(), groupsAfter: (session.instanceGroups.get(5) || []).length, status: window.__status() };

        // Track All once camB sees nothing anywhere: no identities at all.
        for (const fi of session.frameIndices) session.getFrameGroup(fi).instances.set('camB', []);
        window.__clean();
        const all = await tracker.trackAll();
        out.all = { dirty: window.__dirty(), ok: all.ok, identitiesAfter: session.identities.length,
            groupFramesAfter: session.instanceGroups.size, status: window.__status() };
        return out;
    });
    console.log('  phase 2 (zero-match re-run):', JSON.stringify(b, null, 2));
    check(b.groupsBefore === 2 && b.identitiesBefore === 2,
        `precondition: an earlier Track All left a result to wipe (${b.groupsBefore} groups on frame 5, ${b.identitiesBefore} identities)`);
    check(b.frame.groupsAfter === 0 && /no cross-view matches/i.test(b.frame.status),
        `precondition: the zero-match Track Frame wiped frame 5's groups (${b.frame.groupsAfter} left, "${b.frame.status}")`);
    check(isFullyDirty(b.frame.dirty), `a zero-match Track Frame that wiped groups still marks dirty ${fmt(b.frame.dirty)}`);
    check(b.all.ok && b.all.identitiesAfter === 0 && b.all.groupFramesAfter === 0,
        `precondition: the zero-match Track All wiped every identity and group (${b.all.identitiesAfter} identities, ${b.all.groupFramesAfter} frames)`);
    check(isFullyDirty(b.all.dirty), `a zero-match Track All that wiped a prior result still marks dirty ${fmt(b.all.dirty)}`);

    // ---------------------------------------------------------------- phase 3
    // Bail-outs touch nothing, so they must not mark anything.
    const c = await page.evaluate(async () => {
        const tracker = await import('/pose/tracker.js');
        const settings = await import('/ui/settings.js');
        const out = {};

        const session = window.__mkSession(window.__mkCams());
        window.__install(session);
        tracker.setTrackerNumAnimals(2);

        window.__clean();
        const nan = await tracker.trackFrameRange(5, NaN);
        out.nan = { dirty: window.__dirty(), ok: nan.ok, groups: session.instanceGroups.size, status: window.__status() };

        // Exclude camB from tracking (Tracking Wizard ▸ Camera Views): fewer
        // than two tracked views, so both passes refuse before touching state.
        settings.setCameraWeights({ camB: 0 });
        window.__clean();
        tracker.trackCurrentFrame();
        out.oneViewFrame = { dirty: window.__dirty(), groups: session.instanceGroups.size, status: window.__status() };
        window.__clean();
        const r = await tracker.trackAll();
        out.oneViewAll = { dirty: window.__dirty(), ok: r.ok, groups: session.instanceGroups.size, status: window.__status() };
        settings.setCameraWeights({});

        // A single-camera session runs SLEAP's tracker (pose/single-camera-tracking.js). Its refusals —
        // Track Frame, Track Frame Range, and Track All on a LAZY project — touch nothing…
        const solo = window.__mkSession(window.__mkCams().slice(0, 1));
        window.__install(solo);
        window.__clean();
        tracker.trackCurrentFrame();
        out.oneCamFrame = { dirty: window.__dirty(), status: window.__status() };
        window.__clean();
        const sr = await tracker.trackFrameRange(0, 10);
        out.oneCamRange = { dirty: window.__dirty(), ok: sr.ok, status: window.__status() };
        solo.lazyLoader = { isSync: true, nFrames: solo.frameGroups.size };
        window.__clean();
        const sl = await tracker.trackAll();
        out.oneCamLazy = { dirty: window.__dirty(), ok: sl.ok, status: window.__status() };
        // …while Track All itself rewrites the tracks, so it marks dirty like any tracking pass.
        solo.lazyLoader = null;
        window.__clean();
        const s = await tracker.trackAll();
        out.oneCam = { dirty: window.__dirty(), ok: s.ok, status: window.__status() };
        return out;
    });
    console.log('  phase 3 (bail-outs):', JSON.stringify(c, null, 2));
    check(!c.nan.ok && /invalid frame range/i.test(c.nan.status) && c.nan.groups === 0,
        `precondition: a NaN range is refused ("${c.nan.status}")`);
    check(isFullyClean(c.nan.dirty), `a refused NaN range does not mark dirty ${fmt(c.nan.dirty)}`);
    check(/at least 2 views/i.test(c.oneViewFrame.status) && c.oneViewFrame.groups === 0,
        `precondition: Track Frame with one tracked view is refused ("${c.oneViewFrame.status}")`);
    check(isFullyClean(c.oneViewFrame.dirty), `a refused Track Frame does not mark dirty ${fmt(c.oneViewFrame.dirty)}`);
    check(!c.oneViewAll.ok && /at least 2 views/i.test(c.oneViewAll.status),
        `precondition: Track All with one tracked view is refused ("${c.oneViewAll.status}")`);
    check(isFullyClean(c.oneViewAll.dirty), `a refused Track All does not mark dirty ${fmt(c.oneViewAll.dirty)}`);
    check(/single camera use Track All/i.test(c.oneCamFrame.status), `precondition: Track Frame on one camera is refused ("${c.oneCamFrame.status}")`);
    check(isFullyClean(c.oneCamFrame.dirty), `a refused one-camera Track Frame does not mark dirty ${fmt(c.oneCamFrame.dirty)}`);
    check(!c.oneCamRange.ok && /multi-camera sessions/i.test(c.oneCamRange.status),
        `precondition: Track Frame Range on one camera is refused ("${c.oneCamRange.status}")`);
    check(isFullyClean(c.oneCamRange.dirty), `a refused one-camera Track Frame Range does not mark dirty ${fmt(c.oneCamRange.dirty)}`);
    check(!c.oneCamLazy.ok && /lazily loaded/i.test(c.oneCamLazy.status),
        `precondition: Track All on a lazy one-camera project is refused ("${c.oneCamLazy.status}")`);
    check(isFullyClean(c.oneCamLazy.dirty), `a refused lazy one-camera Track All does not mark dirty ${fmt(c.oneCamLazy.dirty)}`);
    check(c.oneCam.ok && /SLEAP's tracker/.test(c.oneCam.status), `one-camera Track All runs SLEAP's tracker ("${c.oneCam.status.slice(0, 70)}")`);
    check(isFullyDirty(c.oneCam.dirty), `…and marks dirty ${fmt(c.oneCam.dirty)}`);

    // ---------------------------------------------------------------- phase 4
    // Windowed lazy session — the `sweepTrackAllFrames` path a reopened large
    // project takes, which never goes through runCrossViewTrackerProgress.
    const d = await page.evaluate(async ({ NF }) => {
        const pd = await import('/pose/pose-data.js');
        const fileio = await import('/import-export/file-io.js');
        const lazyMod = await import('/loading/sio-lazy-loader.js');
        const tracker = await import('/pose/tracker.js');
        const SioLazyLoader = lazyMod.SioLazyLoader || lazyMod.default;
        const { Skeleton, Camera, Session } = pd;

        const cams = window.__mkCams();
        const session = window.__mkSession(cams);
        const views = cams.map(c2 => ({ name: c2.name, videoWidth: 640, videoHeight: 480, frameCount: NF }));
        const vf = cams.map(c2 => ({ name: c2.name, assignedCamera: c2.name, videoPath: c2.name + '.mp4' }));
        const bytes = await window.SleapIO.saveSlpToBytes(fileio.buildSlpLabelsAllViews(session, views, vf));

        const loader = new SioLazyLoader();
        await loader.openProjectSlp(new File([bytes], 'dirty.slp'), () => { });
        const reSession = new Session(
            cams.map(c2 => new Camera(c2.name, c2.matrix, c2.dist, c2.rvec, c2.tvec, c2.size)),
            new Skeleton(loader.skeleton.name, loader.skeleton.nodes, loader.skeleton.edges),
            loader.trackNames.length ? loader.trackNames.slice() : ['track_0', 'track_1'], 'DirtyLazy');
        reSession.lazyLoader = loader;
        reSession._lazyReopened = true;
        window.__install(reSession);
        tracker.setTrackerNumAnimals(2);

        const out = {
            windowed: !!(loader.isSync && typeof loader.releaseWindow === 'function'),
            residentBefore: reSession.frameGroups.size,
        };
        window.__clean();
        const all = await tracker.trackAll();
        out.all = { dirty: window.__dirty(), ok: all.ok, groupFrames: reSession.instanceGroups.size, status: window.__status() };

        window.__clean();
        const range = await tracker.trackFrameRange(10, 19);
        out.range = { dirty: window.__dirty(), ok: range.ok, status: window.__status() };
        return out;
    }, { NF });
    console.log('  phase 4 (windowed lazy):', JSON.stringify(d, null, 2));
    check(d.windowed, 'precondition: the reopened project really takes the windowed sweep path');
    check(d.residentBefore === 0, `precondition: nothing resident before the run (${d.residentBefore} frame groups)`);
    check(d.all.ok && d.all.groupFrames === NF,
        `precondition: the windowed Track All tracked every frame (${d.all.groupFrames}/${NF}, "${d.all.status}")`);
    check(isFullyDirty(d.all.dirty), `windowed Track All marks the project dirty ${fmt(d.all.dirty)}`);
    check(d.range.ok, `precondition: the windowed Track Frame Range succeeded ("${d.range.status}")`);
    check(isFullyDirty(d.range.dirty), `windowed Track Frame Range marks the project dirty ${fmt(d.range.dirty)}`);

    await browser.close();
} catch (e) {
    console.log('  FATAL', e && e.stack || e);
    fails++;
} finally {
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
