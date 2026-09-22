/**
 * track-frame-range.mjs — real-browser coverage for "Track Frame Range" (#212).
 *
 * Track Frame Range is the middle ground between Track Frame (one frame) and
 * Track All (the whole video), so a user can re-run tracking over a narrow
 * window around a known ID switch while changing Tracking Wizard settings.
 *
 * The three things that can silently go wrong, and are asserted here:
 *
 *  1. **It must not touch frames outside the range.** Unlike Track All — which
 *     legitimately wipes `identities` / `frameIdentityMap` / `instanceGroups`
 *     wholesale — a range run clears only its own frames. A regression here is
 *     invisible in the range the user is looking at and destroys everything
 *     else: exactly the failure class that keeps showing up in this codebase
 *     (an operation reports a plausible count and the damage surfaces a cycle
 *     later, after the wrong state has been saved).
 *  2. **Re-running the same range must not grow the identity list.** The whole
 *     point of #212 is iterating on settings over one window; without the
 *     identity pool in `commitTrackedFrame`, every re-run would mint a fresh
 *     id_N per animal because a range run starts the tracker from scratch.
 *  3. **The windowed lazy path must honor start/end.** `sweepTrackAllFrames`
 *     drives `sweepLazyFrameWindows`, whose `start`/`end` options had no caller
 *     before this feature — a mistake there tracks the whole project while
 *     reporting the range's frame count.
 *
 * Plus the toolbar path end to end: the Track Frame split button's dropdown
 * item opens the modal, Esc cancels with no side effects, and Continue runs.
 *
 * Run: node track-frame-range.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8098);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

// Frames the fixtures carry, and the window every range run uses.
const NF = 30;
const LO = 10;
const HI = 19;

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', msg => { if (msg.type() === 'error') console.log('  [console.error]', msg.text().slice(0, 300)); });
    // No dialog should ever appear: the modal collects the animal count itself,
    // so tracker.js's native prompt() must not fire on this path. Fail loudly
    // if one does rather than accepting it and hiding the regression.
    page.on('dialog', async d => {
        console.log('  [unexpected dialog]', d.message());
        fails++;
        await d.dismiss();
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 20000 });

    // Shared fixture builder, installed once and reused by every phase below.
    await page.evaluate(async ({ NF }) => {
        const pd = await import('/pose/pose-data.js');
        const { Skeleton, Camera, Instance, FrameGroup, Session } = pd;

        // Two cameras with real relative geometry (mirrors tests/test-tracker.js's
        // makeTestCamera) so the tracker's epipolar/triangulation math has real
        // cross-view correspondences to find, and two well-separated animals so
        // identity reuse is actually observable.
        window.__mkCams = () => {
            const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
            return [
                new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
                new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.3, 0], [20, 0, 0], [640, 480]),
            ];
        };
        window.__ANIMALS = [
            [[10, 5, 50], [11, 6, 51]],
            [[-10, 5, 50], [-9, 6, 51]],
        ];
        window.__mkSession = (cams) => {
            const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
            const session = new Session(cams, skel, ['track_0', 'track_1'], 'RangeFixture');
            for (let f = 0; f < NF; f++) {
                const fg = new FrameGroup(f);
                session.addFrameGroup(fg);
                window.__ANIMALS.forEach((nodes, ai) => {
                    const moved = nodes.map(p => [p[0] + f * 0.2, p[1], p[2]]);
                    for (const cam of cams) {
                        fg.addInstance(cam.name, new Instance(
                            moved.map(p => cam.project(p)), ai, 'predicted', 1));
                    }
                });
            }
            return session;
        };
        // Stable, comparable snapshots of the two structures a range run must
        // leave alone outside [lo, hi].
        window.__snapshot = (session, keep) => {
            const ids = [];
            for (const rec of session.frameIdentityEntries()) {
                if (!keep(rec.frameIdx)) continue;
                ids.push(rec.frameIdx + '|' + rec.camName + '|' + rec.trackIdx + '=' + rec.identityId);
            }
            ids.sort();
            const groups = [];
            for (const [fi, list] of session.instanceGroups) {
                if (!keep(fi)) continue;
                groups.push(fi + '=' + list.map(g => g.identityId).sort().join(','));
            }
            groups.sort();
            return { ids, groups };
        };
        window.__install = (session) => {
            const AS = window.__ASMOD;
            AS.state.sessions = [session];
            AS.state.activeSessionIdx = 0;
            AS.state.session = session;
            AS.state.totalFrames = session.numFrames;
            AS.state.currentFrame = 0;
        };
        window.__ASMOD = await import('/ui/app-state.js');
    }, { NF });

    // ---------------------------------------------------------------- phase 1
    // Non-lazy session: Track All, then a range run over [LO, HI].
    const a = await page.evaluate(async ({ LO, HI }) => {
        const tracker = await import('/pose/tracker.js');
        const session = window.__mkSession(window.__mkCams());
        window.__install(session);

        tracker.setTrackerNumAnimals(2);
        await tracker.trackAll();
        const afterAll = {
            identities: session.identities.length,
            fimSize: session.frameIdentityMap.size,
            groupFrames: session.instanceGroups.size,
        };
        const outsideBefore = window.__snapshot(session, f => f < LO || f > HI);
        const insideBefore = window.__snapshot(session, f => f >= LO && f <= HI);

        await tracker.trackFrameRange(LO, HI);
        const status = document.getElementById('statusText').textContent;
        const outsideAfter = window.__snapshot(session, f => f < LO || f > HI);
        const insideAfter = window.__snapshot(session, f => f >= LO && f <= HI);

        // Re-run the identical range: the identity pool must recycle, not grow.
        await tracker.trackFrameRange(LO, HI);

        return {
            afterAll, status,
            identitiesAfterRange: session.identities.length,
            identitiesAfterRerun: session.identities.length,
            outsideUnchanged: JSON.stringify(outsideBefore) === JSON.stringify(outsideAfter),
            outsideIdCount: outsideAfter.ids.length,
            insideRepopulated: insideAfter.ids.length > 0 && insideAfter.groups.length > 0,
            insideIdCountBefore: insideBefore.ids.length,
            insideIdCountAfter: insideAfter.ids.length,
            fimSizeAfter: session.frameIdentityMap.size,
        };
    }, { LO, HI });

    console.log('  phase 1 (non-lazy):', JSON.stringify(a, null, 2));
    check(a.afterAll.identities === 2, `precondition: Track All found both animals (${a.afterAll.identities} identities)`);
    check(a.afterAll.groupFrames === NF, `precondition: Track All grouped every frame (${a.afterAll.groupFrames}/${NF})`);
    check(!/error/i.test(a.status), `Track Frame Range reported no error (status: "${a.status}")`);
    check(new RegExp(`\\(${LO}[^0-9][^)]*${HI}\\)`).test(a.status) || a.status.includes(`${LO}`),
        `status names the range it tracked (status: "${a.status}")`);
    check(/10 frames/.test(a.status), `status reports the RANGE's frame count, not the project's (status: "${a.status}")`);
    check(a.outsideUnchanged,
        `frames outside [${LO}, ${HI}] are byte-identical before and after the range run (${a.outsideIdCount} identity entries + their groups)`);
    check(a.insideRepopulated, 'frames inside the range were re-tracked (identities + groups repopulated)');
    check(a.insideIdCountAfter === a.insideIdCountBefore,
        `the range kept the same number of in-range identity entries (${a.insideIdCountBefore} -> ${a.insideIdCountAfter})`);
    check(a.identitiesAfterRange === 2,
        `a range run recycles the existing identities instead of minting new ones (${a.identitiesAfterRange}, expected 2)`);
    check(a.identitiesAfterRerun === 2,
        `re-running the same range again still does not grow the identity list (${a.identitiesAfterRerun}, expected 2)`);
    check(a.fimSizeAfter === a.afterAll.fimSize,
        `frameIdentityMap is the same size after the range run (${a.fimSizeAfter} / ${a.afterAll.fimSize}) — nothing orphaned or dropped`);

    // ---------------------------------------------------------------- phase 2
    // Clamping: a range that runs off the end of the project is clipped, not
    // refused, and still reports only the frames it really covered.
    const b = await page.evaluate(async ({ NF }) => {
        const tracker = await import('/pose/tracker.js');
        const session = window.__mkSession(window.__mkCams());
        window.__install(session);
        tracker.setTrackerNumAnimals(2);

        await tracker.trackFrameRange(NF - 3, NF + 500);
        const clamped = document.getElementById('statusText').textContent;
        const trackedFrames = Array.from(session.instanceGroups.keys()).sort((x, y) => x - y);

        // Reversed input must normalize rather than silently track nothing.
        const s2 = window.__mkSession(window.__mkCams());
        window.__install(s2);
        await tracker.trackFrameRange(8, 3);
        const reversedFrames = Array.from(s2.instanceGroups.keys()).sort((x, y) => x - y);

        // A junk endpoint must be REFUSED, not silently swept as NaN (every
        // comparison against NaN is false, so it slips past an ordering check).
        const s3 = window.__mkSession(window.__mkCams());
        window.__install(s3);
        await tracker.trackFrameRange(5, NaN);
        const nanStatus = document.getElementById('statusText').textContent;
        const nanFrames = s3.instanceGroups.size;

        return { clamped, trackedFrames, reversedFrames, nanStatus, nanFrames };
    }, { NF });

    console.log('  phase 2 (clamping):', JSON.stringify(b));
    check(b.trackedFrames.length === 3 && b.trackedFrames[0] === NF - 3 && b.trackedFrames[2] === NF - 1,
        `a range past the last frame clamps to the project (tracked ${JSON.stringify(b.trackedFrames)})`);
    check(!/error/i.test(b.clamped), `clamped range reported no error (status: "${b.clamped}")`);
    check(b.reversedFrames.length === 6 && b.reversedFrames[0] === 3 && b.reversedFrames[5] === 8,
        `a reversed range (8 -> 3) normalizes to 3–8 (tracked ${JSON.stringify(b.reversedFrames)})`);
    check(/invalid frame range/i.test(b.nanStatus) && b.nanFrames === 0,
        `a non-integer endpoint is refused outright rather than swept as NaN (status: "${b.nanStatus}", ${b.nanFrames} frames touched)`);

    // ---------------------------------------------------------------- phase 3
    // Windowed lazy project (the `sweepLazyFrameWindows` start/end path, which
    // had no caller before this feature).
    const c = await page.evaluate(async ({ NF, LO, HI }) => {
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
        const labels = fileio.buildSlpLabelsAllViews(session, views, vf);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);

        const loader = new SioLazyLoader();
        await loader.openProjectSlp(new File([bytes], 'range.slp'), () => { });

        const cameras2 = cams.map(c2 => new Camera(c2.name, c2.matrix, c2.dist, c2.rvec, c2.tvec, c2.size));
        const skeleton2 = new Skeleton(loader.skeleton.name, loader.skeleton.nodes, loader.skeleton.edges);
        const reSession = new Session(cameras2, skeleton2,
            loader.trackNames.length ? loader.trackNames.slice() : ['track_0', 'track_1'], 'RangeLazy');
        reSession.lazyLoader = loader;
        reSession._lazyReopened = true;
        window.__install(reSession);

        const windowed = !!(loader.isSync && typeof loader.releaseWindow === 'function');
        const residentBefore = reSession.frameGroups.size;

        tracker.setTrackerNumAnimals(2);
        await tracker.trackFrameRange(LO, HI);

        const touched = new Set();
        for (const rec of reSession.frameIdentityEntries()) touched.add(rec.frameIdx);
        const sorted = Array.from(touched).sort((x, y) => x - y);

        return {
            windowed, residentBefore,
            nFrames: loader.nFrames,
            status: document.getElementById('statusText').textContent,
            identities: reSession.identities.length,
            touchedMin: sorted.length ? sorted[0] : null,
            touchedMax: sorted.length ? sorted[sorted.length - 1] : null,
            touchedCount: sorted.length,
        };
    }, { NF, LO, HI });

    console.log('  phase 3 (windowed lazy):', JSON.stringify(c, null, 2));
    check(c.windowed, 'precondition: the reopened project really takes the windowed sweep path');
    check(c.residentBefore === 0, `precondition: nothing resident before the run (${c.residentBefore} frame groups)`);
    check(c.nFrames === NF, `precondition: loader reports the whole project (${c.nFrames}/${NF})`);
    check(!/error/i.test(c.status), `windowed range run reported no error (status: "${c.status}")`);
    check(c.identities > 0, `windowed range run assigned identities (${c.identities})`);
    check(c.touchedCount > 0 && c.touchedMin >= LO && c.touchedMax <= HI,
        `the windowed sweep stayed inside [${LO}, ${HI}] (touched ${c.touchedMin}–${c.touchedMax}, ${c.touchedCount} entries) — start/end are honored, not ignored`);

    // ---------------------------------------------------------------- phase 4
    // The toolbar path: dropdown item -> modal -> Esc / Continue.
    await page.evaluate(async () => {
        const tracker = await import('/pose/tracker.js');
        const session = window.__mkSession(window.__mkCams());
        window.__install(session);
        tracker.setTrackerNumAnimals(2);
        window.__ASMOD.state.currentFrame = 4;
    });

    const trackFrameBtn = page.locator('#tbTrackFrame');
    check(await trackFrameBtn.count() === 1, 'Track Frame is still a clickable toolbar button');
    check(await page.locator('#trackFrameDropdown #tbTrackFrameRange').count() === 1,
        'the Track Frame split button carries a "Track Frame Range" dropdown item');

    // Hovering the button must reveal the menu (pure CSS, same as Triangulate).
    await trackFrameBtn.hover();
    await page.waitForTimeout(250);
    const rangeItem = page.locator('#tbTrackFrameRange');
    check(await rangeItem.isVisible(), 'hovering Track Frame reveals the dropdown menu');

    // The menu is revealed purely by :hover, so every click on the item has to
    // re-establish hover first — a modal opening over the toolbar drops it.
    const openRangeModal = async () => {
        await trackFrameBtn.hover();
        await page.waitForTimeout(200);
        await rangeItem.click();
        await page.waitForSelector('#trackRangeStart', { timeout: 5000 });
    };

    await rangeItem.click();
    await page.waitForSelector('#trackRangeStart', { timeout: 5000 });
    const prefill = await page.evaluate(() => ({
        start: document.getElementById('trackRangeStart').value,
        end: document.getElementById('trackRangeEnd').value,
        animals: document.getElementById('trackRangeAnimals').value,
        hasCancel: !!document.getElementById('trackRangeCancel'),
        hasContinue: !!document.getElementById('trackRangeContinue'),
    }));
    console.log('  phase 4 (modal):', JSON.stringify(prefill));
    check(prefill.start === '4', `the modal pre-fills Start with the current frame (got "${prefill.start}")`);
    check(Number(prefill.end) > Number(prefill.start), `the modal pre-fills a non-empty End (got "${prefill.end}")`);
    check(prefill.animals === '2', `the modal pre-fills the known animal count (got "${prefill.animals}")`);
    check(prefill.hasCancel && prefill.hasContinue, 'the modal has both a Cancel and a Continue button');

    // Esc must close it without running anything (CLAUDE.md modal convention).
    await page.evaluate(() => {
        document.getElementById('statusText').textContent = 'SENTINEL';
        window.__ASMOD.state.session.instanceGroups.clear();
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const afterEsc = await page.evaluate(() => ({
        open: !!document.getElementById('trackRangeStart'),
        status: document.getElementById('statusText').textContent,
        groups: window.__ASMOD.state.session.instanceGroups.size,
    }));
    check(!afterEsc.open, 'Esc closes the modal');
    check(afterEsc.status === 'SENTINEL' && afterEsc.groups === 0, 'Esc ran no tracking');

    // ---- the dual slider, and its two-way binding to the number fields ----
    await openRangeModal();
    const sliderPresent = await page.evaluate(() => ({
        container: !!document.querySelector('.range-slider-container'),
        start: !!document.getElementById('trackRangeSliderStart'),
        end: !!document.getElementById('trackRangeSliderEnd'),
        fill: !!document.getElementById('trackRangeFill'),
        // The fill must actually be painted. `--accent-color` was referenced by
        // six declarations and never defined; an undefined custom property is
        // invalid at computed-value time, so the fill resolved to `transparent`
        // and the bar was invisible — including on the Export Video Overlays
        // slider this one mirrors.
        fillBg: getComputedStyle(document.getElementById('trackRangeFill')).backgroundColor,
        min: document.getElementById('trackRangeSliderStart').min,
        max: document.getElementById('trackRangeSliderEnd').max,
    }));
    console.log('  phase 5 (slider):', JSON.stringify(sliderPresent));
    check(sliderPresent.container && sliderPresent.start && sliderPresent.end && sliderPresent.fill,
        'the modal has a dual range slider like Export Video Overlays');
    check(sliderPresent.min === '0' && sliderPresent.max === String(NF - 1),
        `the slider spans the session extent (${sliderPresent.min}–${sliderPresent.max})`);
    check(sliderPresent.fillBg !== 'rgba(0, 0, 0, 0)' && sliderPresent.fillBg !== 'transparent',
        `the slider fill is actually painted, not transparent (${sliderPresent.fillBg})`);

    // slider -> inputs
    const fromSlider = await page.evaluate(() => {
        const s = document.getElementById('trackRangeSliderStart');
        const e = document.getElementById('trackRangeSliderEnd');
        s.value = '7'; s.dispatchEvent(new Event('input', { bubbles: true }));
        e.value = '21'; e.dispatchEvent(new Event('input', { bubbles: true }));
        return {
            start: document.getElementById('trackRangeStart').value,
            end: document.getElementById('trackRangeEnd').value,
            fillLeft: document.getElementById('trackRangeFill').style.left,
            fillWidth: document.getElementById('trackRangeFill').style.width,
            summary: document.getElementById('trackRangeSummary').textContent,
        };
    });
    console.log('  phase 5 (slider -> inputs):', JSON.stringify(fromSlider));
    check(fromSlider.start === '7' && fromSlider.end === '21',
        `dragging the slider updates the number fields (${fromSlider.start}–${fromSlider.end})`);
    check(/15 frames/.test(fromSlider.summary), `and the summary (${fromSlider.summary})`);
    check(parseFloat(fromSlider.fillLeft) > 0 && parseFloat(fromSlider.fillWidth) > 0,
        `the fill bar spans the selection (left ${fromSlider.fillLeft}, width ${fromSlider.fillWidth})`);

    // inputs -> slider
    await page.fill('#trackRangeStart', '2');
    await page.fill('#trackRangeEnd', '9');
    const fromInputs = await page.evaluate(() => ({
        sliderStart: document.getElementById('trackRangeSliderStart').value,
        sliderEnd: document.getElementById('trackRangeSliderEnd').value,
    }));
    check(fromInputs.sliderStart === '2' && fromInputs.sliderEnd === '9',
        `typing in the number fields moves the slider (${fromInputs.sliderStart}–${fromInputs.sliderEnd})`);

    // The two thumbs share a track; dragging one past the other must push it
    // rather than invert the range and disable Continue mid-drag.
    const crossed = await page.evaluate(() => {
        const s = document.getElementById('trackRangeSliderStart');
        s.value = '25'; s.dispatchEvent(new Event('input', { bubbles: true }));
        return {
            sliderEnd: document.getElementById('trackRangeSliderEnd').value,
            disabled: document.getElementById('trackRangeContinue').disabled,
        };
    });
    check(crossed.sliderEnd === '25' && !crossed.disabled,
        `dragging start past end pushes end instead of inverting (end now ${crossed.sliderEnd}, Continue enabled)`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);

    // Continue must run the range and show the Track All loading overlay.
    await openRangeModal();
    await page.fill('#trackRangeStart', '12');
    await page.fill('#trackRangeEnd', '17');
    const summary = await page.textContent('#trackRangeSummary');
    check(/6 frames/.test(summary), `the modal previews the range size (summary: "${summary}")`);

    // Invalid input must block Continue inline instead of closing.
    await page.fill('#trackRangeEnd', '3');
    const invalid = await page.evaluate(() => ({
        disabled: document.getElementById('trackRangeContinue').disabled,
        error: document.getElementById('trackRangeError').textContent,
    }));
    check(invalid.disabled && invalid.error.length > 0,
        `an end-before-start range disables Continue and explains why ("${invalid.error}")`);
    await page.fill('#trackRangeEnd', '17');

    const sawOverlay = page.waitForFunction(
        () => /Assigning identities/.test(document.getElementById('loadingStatus').textContent),
        { timeout: 5000 }).then(() => true).catch(() => false);
    await page.click('#trackRangeContinue');
    const overlayShown = await sawOverlay;
    check(overlayShown, 'Continue shows the same "Assigning identities" loading overlay as Track All');

    await page.waitForFunction(
        () => document.getElementById('loadingOverlay').classList.contains('hidden'),
        { timeout: 20000 });
    const afterRun = await page.evaluate(() => ({
        open: !!document.getElementById('trackRangeStart'),
        status: document.getElementById('statusText').textContent,
        frames: Array.from(window.__ASMOD.state.session.instanceGroups.keys()).sort((x, y) => x - y),
    }));
    console.log('  phase 4 (after Continue):', JSON.stringify(afterRun));
    check(!afterRun.open, 'the modal closes when Continue runs');
    check(!/error/i.test(afterRun.status), `the modal-driven run reported no error (status: "${afterRun.status}")`);
    check(afterRun.frames.length === 6 && afterRun.frames[0] === 12 && afterRun.frames[5] === 17,
        `the modal-driven run tracked exactly the frames it was given (${JSON.stringify(afterRun.frames)})`);
    // The run must leave the viewer on its own result, not wherever the user
    // happened to be (frame 4, set before phase 4 opened the modal).
    await page.waitForFunction(() => window.__ASMOD.state.currentFrame === 17, { timeout: 5000 })
        .catch(() => { });
    const parked = await page.evaluate(() => window.__ASMOD.state.currentFrame);
    check(parked === 17,
        `the viewer is parked on the LAST frame tracked (currentFrame ${parked}, expected 17 — was 4 before the run)`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
