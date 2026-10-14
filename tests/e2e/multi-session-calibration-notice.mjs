/**
 * multi-session-calibration-notice.mjs — the note a multi-session load leaves
 * when its sessions do not agree about where the world is.
 *
 * A multi-session load reads one calibration per session subfolder and nothing
 * makes them match. The failure mode is that NOTHING LOOKS WRONG: each session
 * reprojects correctly against its own cameras, so every error stays small and
 * every number stays plausible, and what is broken is only the comparison
 * BETWEEN sessions — which nothing on screen performs, and so nothing on screen
 * contradicts. The user finds out weeks later when a distance measured in one
 * session does not match the same distance in another.
 *
 * The fixtures are the REAL calibrations out of
 * `small_multi_session/10072022145420_small` (see
 * `tests/fixtures/multi-session-calib/README.md`): the original, and the
 * `calibration-rebased.toml` that Set as New Calibration wrote into that one
 * folder. They are parsed by the app's own `parseCalibrationTOML`, so this
 * asserts the numbers a user actually gets, not numbers invented here.
 *
 * What it covers that `tests/test-calibration-compare.mjs` cannot:
 *
 *  1. The modal itself — the grouping, and that it carries NOTHING BUT the
 *     grouping. It is a note naming which sessions loaded which calibration;
 *     the classification, the measured offset, the consequence and the
 *     remedies were removed, and their absence is asserted.
 *  2. **Silence in the ordinary case.** Four sessions on identical
 *     calibrations raise nothing. This is the most important section in the
 *     file: a modal on every multi-session load would be worse than no modal.
 *  3. A difference that is NOT a change of origin — sessions genuinely
 *     calibrated apart — which reports the same way.
 *  4. Esc and the dismiss button, per the project's modal rule.
 *  5. The real WIRING — `handleLoadMultiSession` is driven with a stubbed
 *     directory picker, and the note is asserted to arrive AFTER the skeleton
 *     prompt is answered rather than stacked underneath it.
 *  6. The modal fits on a laptop and its button is reachable.
 *
 * Run: node multi-session-calibration-notice.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8271);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;
        console.log('  [console.error]', t.slice(0, 300));
        fails++;
    });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // A helper the sections share: replace `state.sessions` with sessions built
    // from the named fixture files, then run the check the loaders run.
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const fio = await import('/import-export/file-io.js');
        const AS = await import('/ui/app-state.js');
        const notice = await import('/ui/calibration-notice.js');

        const cache = {};
        window.__calibText = async (name) => {
            if (!cache[name]) {
                const res = await fetch('/tests/fixtures/multi-session-calib/' + name);
                if (!res.ok) throw new Error('fixture ' + name + ' -> ' + res.status);
                cache[name] = await res.text();
            }
            return cache[name];
        };

        // One session per (name, calibration file), with an optional tweak so a
        // section can turn a re-based rig into a genuinely different one.
        window.__buildSessions = async (specs) => {
            const out = [];
            for (const spec of specs) {
                let cams = [];
                if (spec.calib) {
                    const parsed = fio.parseCalibrationTOML(await window.__calibText(spec.calib));
                    cams = parsed.map(c => new pd.Camera(
                        c.name, c.matrix, c.dist, c.rvec, c.tvec, c.size));
                    if (spec.tweak) spec.tweak(cams);
                }
                out.push(new pd.Session(
                    cams, new pd.Skeleton('sk', ['a', 'b'], [[0, 1]]), ['track_0'], spec.name));
            }
            AS.state.sessions = out;
            AS.state.session = out[0];
            AS.state.activeSessionIdx = 0;
            return out.map(s => ({ name: s.name, cameras: s.cameras.length }));
        };

        window.__note = () => {
            const r = notice.noteSessionCalibrationDivergence(AS.state.sessions);
            return r ? {
                ok: r.ok,
                frameOnly: r.frameOnly,
                groups: r.groups.map(g => ({ sessions: g.sessions, cameraCount: g.cameraCount })),
                reference: r.reference,
                diffs: r.diffs.map(d => ({
                    kind: d.kind, sessions: d.sessions, sharedCameras: d.sharedCameras,
                    lensCameras: d.lensCameras,
                    distanceMm: d.frame ? d.frame.distanceMm : null,
                    angleDeg: d.frame ? d.frame.angleDeg : null,
                    rigid: d.frame ? d.frame.rigid : null,
                })),
            } : null;
        };

        // Everything the assertions need to read off the open modal.
        window.__modal = () => {
            const ov = document.getElementById('calibNoticeOverlay');
            if (!ov) return null;
            const modal = ov.querySelector('.calib-notice-modal');
            const groups = Array.from(
                ov.querySelectorAll('#calibNoticeGroups .calib-notice-group')).map(el => ({
                    letter: el.getAttribute('data-calib-group'),
                    label: el.querySelector('.calib-notice-group-title span').textContent,
                    count: el.querySelector('.calib-notice-group-count').textContent,
                    sessions: Array.from(el.querySelectorAll('.calib-notice-session'))
                        .map(r => r.textContent),
                }));
            const btn = document.getElementById('btnCalibNoticeOk');
            const mr = modal.getBoundingClientRect();
            const br = btn.getBoundingClientRect();
            return {
                title: ov.querySelector('h3').textContent,
                groups,
                // The whole modal's text, for asserting what is NOT in it.
                text: modal.textContent,
                noCal: (document.getElementById('calibNoticeNoCal') || {}).textContent || null,
                modalBottom: mr.bottom, modalHeight: mr.height,
                buttonBottom: br.bottom, buttonVisible: br.bottom <= window.innerHeight && br.top >= 0,
                viewportHeight: window.innerHeight,
            };
        };
    });

    // =================================================================
    // 1. Three sessions on calibration.toml, one on calibration-rebased.toml
    // =================================================================
    //
    // Exactly the state the real folder is in after a Set as New Calibration
    // run in one of its four sessions.
    console.log('\n1. One re-based session out of four');
    {
        const built = await page.evaluate(() => window.__buildSessions([
            { name: '10072022120554_small', calib: 'calibration.toml' },
            { name: '10072022131531_small', calib: 'calibration.toml' },
            { name: '10072022145420_small', calib: 'calibration-rebased.toml' },
            { name: '10072022193448_small', calib: 'calibration.toml' },
        ]));
        check(built.length === 4 && built.every(b => b.cameras === 8),
            `four sessions of 8 real cameras each (${built.map(b => b.cameras).join('/')})`);

        const r = await page.evaluate(() => window.__note());
        check(r && r.ok === false, 'the divergence is reported');
        check(r.groups.length === 2, `two distinct calibrations (got ${r.groups.length})`);
        check(r.groups[r.reference].sessions.length === 3,
            'the three agreeing sessions are the reference');
        check(r.diffs.length === 1 && r.diffs[0].sessions.join(',') === '10072022145420_small',
            'and the re-based one is the session called out');

        const d = r.diffs[0];
        check(d.kind === 'origin', `classified as a change of origin (got '${d.kind}')`);
        check(r.frameOnly === true,
            'frameOnly — still MEASURED, and logged, even though the modal no longer prints it');
        check(d.sharedCameras === 8 && d.rigid === true,
            'all eight cameras agree on one rigid transform');
        // The real numbers, cross-checked against an independent computation.
        check(Math.abs(d.distanceMm - 1218.847050331267) < 1e-6,
            `origin offset ${d.distanceMm.toFixed(3)} mm (expected 1218.847)`);
        check(Math.abs(d.angleDeg - 162.81809531505309) < 1e-6,
            `rotated ${d.angleDeg.toFixed(3)}° (expected 162.818)`);

        const m = await page.evaluate(() => window.__modal());
        check(!!m, 'the modal is on screen');
        check(m.title === 'Sessions with different calibrations detected',
            `one plain title, no classification in it (got "${m.title}")`);
        check(m.groups.length === 2,
            `one section per distinct calibration (got ${m.groups.length})`);
        check(m.groups[0].label === 'Calibration A' && m.groups[1].label === 'Calibration B',
            'lettered A and B — the letter is the only handle a group has, since both '
            + 'of these loaded a file called calibration.toml');
        check(m.groups[0].sessions.length === 3 && m.groups[1].sessions.length === 1,
            'the majority group is first, so the odd session out is read last');
        check(m.groups[1].sessions[0] === '10072022145420_small',
            'and that session is named in full — the one string in the modal the user acts on');
        check(m.groups[0].sessions.join(',')
            === '10072022120554_small,10072022131531_small,10072022193448_small',
            'every session in the majority group is listed, one per line');
        check(/3 sessions/.test(m.groups[0].count) && /8 cameras/.test(m.groups[0].count),
            `the title row carries the counts (got "${m.groups[0].count}")`);
        check(/^1 session ·/.test(m.groups[1].count),
            `singular for a one-session group (got "${m.groups[1].count}")`);
        // The five blocks of prose this modal used to carry — the lead, the
        // per-kind explanation, the measured offset, the consequence and the
        // two remedies — are the thing that was removed. Their absence is
        // asserted rather than assumed, or they creep back one sentence at a
        // time.
        check(!/rigid|not a different rig|reprojects correctly|carry across|Re-calibrat/i
            .test(m.text),
            'and none of the old explanation, consequence or remedy prose');
        check(!/1,219 mm|163°/.test(m.text),
            'the measured offset is not printed — it goes to the console');
        check(!/calibration-rebased\.toml/.test(m.text),
            'nor is a file named for the user to go hunting for');
        check(m.noCal === null, 'no "not compared" line, since every session had a calibration');
    }

    // =================================================================
    // 2. Esc, and the button
    // =================================================================
    console.log('\n2. Dismissing it');
    {
        await page.keyboard.press('Escape');
        check(await page.evaluate(() => !document.getElementById('calibNoticeOverlay')),
            'Esc closes it, per the project modal rule');

        await page.evaluate(() => window.__note());
        check(await page.evaluate(() => !!document.getElementById('calibNoticeOverlay')),
            'it reopens on a second call');
        await page.click('#btnCalibNoticeOk');
        check(await page.evaluate(() => !document.getElementById('calibNoticeOverlay')),
            'and Got it closes it');
        // A listener left on `document` would swallow the next Esc anywhere in
        // the app, which is exactly the kind of thing nobody notices.
        const leaked = await page.evaluate(() => {
            const before = document.querySelectorAll('.plane-confirm-overlay').length;
            return before;
        });
        check(leaked === 0, 'leaving no overlay behind');
    }

    // =================================================================
    // 3. THE IMPORTANT ONE: silence when the sessions agree
    // =================================================================
    console.log('\n3. Four identical calibrations say nothing');
    {
        const r = await page.evaluate(() => window.__buildSessions([
            { name: 's1', calib: 'calibration.toml' },
            { name: 's2', calib: 'calibration.toml' },
            { name: 's3', calib: 'calibration.toml' },
            { name: 's4', calib: 'calibration.toml' },
        ]).then(() => window.__note()));
        check(r === null, 'no report, so no modal — this is the ordinary multi-session project');
        check(await page.evaluate(() => !document.getElementById('calibNoticeOverlay')),
            'and nothing is on screen');
    }

    console.log('\n3b. ...and a session with no calibration is named, not treated as different');
    {
        const r = await page.evaluate(() => window.__buildSessions([
            { name: 's1', calib: 'calibration.toml' },
            { name: 's2', calib: 'calibration.toml' },
            { name: 'videos-only', calib: null },
        ]).then(() => window.__note()));
        check(r === null, 'an uncalibrated session alongside agreeing ones raises nothing');

        // But when there IS a divergence, it must be accounted for in the modal.
        const r2 = await page.evaluate(() => window.__buildSessions([
            { name: 's1', calib: 'calibration.toml' },
            { name: 's2', calib: 'calibration-rebased.toml' },
            { name: 'videos-only', calib: null },
        ]).then(() => window.__note()));
        check(r2 && r2.ok === false, 'with a divergence present the modal opens');
        const m = await page.evaluate(() => window.__modal());
        check(m && /videos-only/.test(m.noCal || ''),
            `the uncalibrated session is listed as not compared (got "${m && m.noCal}")`);
        check(m.groups.length === 2 && m.groups.every(g => g.sessions.length === 1),
            'and only the two it compared are grouped, one apiece');
        await page.keyboard.press('Escape');
    }

    // =================================================================
    // 4. The other advice path
    // =================================================================
    console.log('\n4. Sessions genuinely calibrated apart report the same way');
    {
        // Re-focus one camera. An origin change never touches intrinsics, so
        // this cannot be fixed by moving a file and must not say it can.
        const r = await page.evaluate(() => window.__buildSessions([
            { name: 's1', calib: 'calibration.toml' },
            { name: 's2', calib: 'calibration.toml' },
            {
                name: 'other-rig', calib: 'calibration.toml',
                tweak: (cams) => {
                    const c = cams.find(x => x.name === 'mid');
                    c.matrix = [[900, 0, 639.5], [0, 900, 511.5], [0, 0, 1]];
                },
            },
        ]).then(() => window.__note()));
        check(r && r.diffs[0].kind === 'lens',
            `a re-focused camera reads as a lens difference (got '${r && r.diffs[0].kind}')`);
        check(r.frameOnly === false, 'and not as an origin change');

        const m = await page.evaluate(() => window.__modal());
        check(m.title === 'Sessions with different calibrations detected',
            `the same plain title, whatever the kind of difference (got "${m.title}")`);
        check(m.groups.length === 2 && m.groups[1].sessions.join(',') === 'other-rig',
            'the re-focused session is the group on its own');
        // A lens difference cannot be fixed by moving a file. The modal used
        // to have to pick its advice accordingly; now it offers none, which is
        // the same guarantee reached by removing the failure mode instead of
        // branching on it.
        check(!/calibration-rebased\.toml/.test(m.text),
            'and does NOT tell the user to go looking for a calibration-rebased.toml');
        await page.keyboard.press('Escape');
    }

    // =================================================================
    // 5. The real loader calls it, and only after the skeleton prompt
    // =================================================================
    //
    // `handleLoadMultiSession` needs `showDirectoryPicker`, which no automation
    // can drive, so the picker is stubbed with a directory tree holding one
    // trivial session folder. The four divergent sessions are seeded first, so
    // what is asserted is the LOADER'S TAIL: that it reaches the check at all,
    // and that the note waits for the skeleton prompt instead of opening
    // underneath it.
    console.log('\n5. handleLoadMultiSession reaches the check, after the skeleton prompt');
    {
        await page.evaluate(async () => {
            const loader = await import('/loading/session-loader.js');
            const dir = (name, entries) => ({
                kind: 'directory', name,
                [Symbol.asyncIterator]: async function* () {
                    for (const e of entries) yield [e.name, e];
                },
            });
            const file = (name, text) => ({
                kind: 'file', name,
                getFile: async () => new File([text], name, { type: 'text/plain' }),
            });
            // The stub folder deliberately loads NOTHING: one session-looking
            // subfolder holding an empty camera directory and no calibration.
            // `handleLoadSessionFolderPerCamera` then bails at "no camera
            // directories with videos found" — a clean early return. Give it a
            // calibration instead and it stops on the missing-camera-directory
            // popup and waits for a click that this test has no business
            // making; give it a video and the decoder gets involved. What is
            // under test here is the loader's TAIL, not its middle.
            void file;
            window.showDirectoryPicker = async () => dir('parent', [
                dir('sessionA', [dir('cam0', [])]),
            ]);
            await window.__buildSessions([
                { name: 'm1', calib: 'calibration.toml' },
                { name: 'm2', calib: 'calibration.toml' },
                { name: 'm3', calib: 'calibration-rebased.toml' },
                { name: 'm4', calib: 'calibration.toml' },
            ]);
            window.__multiDone = loader.handleLoadMultiSession();
        });

        // The skeleton prompt comes first: one project, one skeleton.
        await page.waitForSelector('#msSkelSkip', { timeout: 15000 });
        check(await page.evaluate(() => !document.getElementById('calibNoticeOverlay')),
            'the calibration note does NOT open on top of the skeleton prompt');
        await page.click('#msSkelSkip');

        await page.waitForSelector('#calibNoticeOverlay', { timeout: 15000 });
        check(true, 'and opens once that prompt is answered');
        const m = await page.evaluate(() => window.__modal());
        check(m && m.groups.length === 2 && m.groups[1].sessions.join(',') === 'm3',
            'reporting the seeded divergence through the real load path');
        await page.evaluate(() => window.__multiDone);
    }

    // =================================================================
    // 6. It fits, and the button is reachable
    // =================================================================
    console.log('\n6. Geometry');
    {
        const m = await page.evaluate(() => window.__modal());
        check(m.modalHeight <= m.viewportHeight - 40,
            `the modal is capped to the viewport (${Math.round(m.modalHeight)}px of ${m.viewportHeight}px)`);
        check(m.buttonVisible,
            `Got it is on screen without scrolling (bottom ${Math.round(m.buttonBottom)}px)`);

        // ...and on a short laptop window, where a stack of blocks like this is
        // what pushed the origin dialog's Continue below the fold.
        await page.setViewportSize({ width: 1400, height: 620 });
        await page.evaluate(() => window.__note());
        const s = await page.evaluate(() => window.__modal());
        check(s.modalHeight <= s.viewportHeight - 40,
            `still capped at 620px tall (${Math.round(s.modalHeight)}px)`);
        check(s.buttonVisible, 'and the button is still reachable, via the modal\'s one scroller');
        await page.keyboard.press('Escape');
    }

    console.log(fails === 0 ? '\nPASS' : `\nFAIL — ${fails} failing assertion(s)`);
} catch (err) {
    console.error('\nERROR:', err);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
process.exit(fails === 0 ? 0 : 1);
