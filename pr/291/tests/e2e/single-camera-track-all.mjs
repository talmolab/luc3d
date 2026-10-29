/**
 * single-camera-track-all.mjs — Track All and the ID-switch checks on a
 * SINGLE-CAMERA session, in the real app (pose/single-camera-tracking.js,
 * pose/sleap-tracker.js, ui/id-switch-modal.js).
 *
 * The fixture is what File ▸ Load SLP makes of a one-video SLEAP predictions
 * file: one placeholder camera, every detection unlinked, on fragmented
 * tracklets. Three mouse-shaped animals of different size, 75 s at 30 fps;
 * animals 0 and 1 meet every 10 s. Asserted:
 *  1. The Track All button runs SLEAP's tracker (one track per animal across all
 *     the input's tracklet breaks), says so, colours by ID, marks the project
 *     dirty, turns node trails on at ¼ s (as after a multi-camera Track All),
 *     and says the body-size check is not run automatically on one camera
 *     (it is optional there; the menu runs it — see 3).
 *  2. Track Frame and Track Frame Range (the call and its dialog) refuse on one
 *     camera, saying why — not asking for a calibration — and change nothing.
 *  3. A swap planted in the tracks (animals 0 and 1 exchanged for the last 26%)
 *     is found by Tracks ▸ Check ID Switches (Body Size) as a row; Fix switch
 *     names the TRACKS in its dialog and puts every detection back on its
 *     animal's track; Undo plants the swap back exactly. The row's window (its
 *     landing frame, progress bar and where Fix takes the current frame as the
 *     boundary) reaches 2 s either side of the close spell on one camera.
 *  4. Where to look: Track All leaves candidate moments on the session, and the
 *     coat-brightness check (what Tracks ▸ Check ID Switches (Coat Brightness)
 *     runs; here with a stand-in sampler — the coats differ) tests them. A swap
 *     planted while the two animals are far apart, with a candidate moment
 *     there, gets a row AT the moment, saying why it was looked at — which
 *     survives the saved checklist (metadata.lucid.idSwitchReview) — on top of
 *     the encounter rows, which are what they were without it.
 *     Its progress dialog has no sample-crop square: that is the image
 *     check's, and this check cuts no crops (it showed an empty black one).
 *  5. A swap planted at a contact, which both the (label-free) size check and the
 *     coat-brightness check find, is ONE "Both" row on the size result (violet +
 *     amber), and its ticks are on the seekbar.
 *  6. The single-camera options (`skipEmpty`, `clearestEndLeads`) are the
 *     coat-brightness check's: the label-free size and image checks (stand-in
 *     embedder) take none of them.
 *  7. Duplicate removal is offered in the Tracking Wizard, off by default (box
 *     IoU 0.5, OKS 0.6); switched on, Track All leaves a planted partial copy of
 *     an animal without a track and says so, and every animal keeps its track.
 *  7b. The Wizard's detection filters apply on one camera: at Min visible nodes
 *     12 the Wizard counts the one detection with 11 nodes, and Track All leaves
 *     it without a track, saying so in the status and the summary box (as
 *     filtered, not as a duplicate).
 *  7c. The Instances tab's Ungrouped table shows each instance's mean node
 *     score under its instance score (a missing node counts as 0; "-" without
 *     node scores), explained on the "Score / Node" header
 *     (tests/e2e/info-panel-instance-tables.mjs checks the table fits).
 *  8. The review list: a lone animal hopping onto the tracks of SLEAP's copies of
 *     itself (a second animal elsewhere, a third entering later) leaves places
 *     to review: the status counts them, the ID Switches tab lists them as grey
 *     rows saying why ("a lone animal's track changes"), the summary box counts
 *     them and makes reviewing the next step; Fix on a review row swaps from the
 *     frame you are on to the end of the video, between two tracks picked in the
 *     dialog (three tracks here), and Esc cancels it; the fixed row offers Fix
 *     again…, which from a frame past its own window (before the next place)
 *     swaps back, leaving only the stretch between the two fixes swapped.
 *  1b. Track All ends on the summary box, planned for one camera: it counts
 *     tracks, lists coat brightness / images / body size, recommends saving and
 *     never Triangulate All, has an Identities row per track, and the ID
 *     Switches tab reopens it.
 *
 * Run: node tests/e2e/single-camera-track-all.mjs
 */
import { chromium } from 'playwright';
import { answerTrackSetup } from './fixtures/track-setup.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8276);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push(String(e).slice(0, 300)));
    await answerTrackSetup(page, 3);   // Track All's first-run dialog: the animal count
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js'); const AS = await import('/ui/app-state.js');
        const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
            'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
        const T = { Nose: [45, 0], Ear_R: [25, -11], Ear_L: [25, 11], Head: [30, 0], Neck: [20, 0], Trunk: [-5, 0], TTI: [-40, 0],
            Shoulder_left: [10, 12], Shoulder_right: [10, -12], Haunch_left: [-25, 15], Haunch_right: [-25, -15],
            Tail_0: [-65, 0], Tail_1: [-88, 0], Tail_2: [-110, 0], TailTip: [-132, 0] };
        const FPS = 30, FRAMES = 75 * FPS, SIZES = [0.5, 0.8, 1.0];
        let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        const pose = (a, f) => {
            const t = f / FPS, phase = (t % 10) / 10;
            let cx, cy;
            if (a === 2) { cx = 520 + 40 * Math.sin(t / 3); cy = 380 + 30 * Math.cos(t / 4); }
            else { const d = 140 * Math.abs(Math.cos(Math.PI * phase)); cx = 280 + (a === 0 ? -d : d); cy = 200 + 20 * Math.sin(t + a); }
            const h = a === 2 ? t / 2 : (a === 0 ? 0 : Math.PI) + 0.3 * Math.sin(t), c = Math.cos(h), s = Math.sin(h);
            return NODES.map(n => { const [x, y] = T[n]; const X = x * SIZES[a], Y = y * SIZES[a]; return [cx + c * X - s * Y + (rnd() - 0.5), cy + s * X + c * Y + (rnd() - 0.5)]; });
        };
        const cam = new pd.Camera('mouse_video', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
        const tracks = []; for (let i = 0; i < 60; i++) tracks.push('track_' + i);
        const s = new pd.Session([cam], new pd.Skeleton('mouse', NODES, []), tracks, 'one camera');
        for (let f = 0; f < FRAMES; f++) for (let a = 0; a < 3; a++) {
            s.addUnlinkedInstance(f, cam.name, new pd.Instance(pose(a, f), (3 * Math.floor(f / 120) + a) % 60, 'predicted', 0.9));
        }
        AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
        AS.state.totalFrames = FRAMES; AS.state.currentFrame = 0; AS.state.views = []; AS.state.fps = FPS;
        if (AS.timeline) { AS.timeline.setTotalFrames(FRAMES); AS.timeline.setData(s); }
        // per frame: the track of animal 0, 1, 2 (instances are added in animal order)
        window.__tracks = () => {
            const S = AS.state.session, out = [];
            for (let f = 0; f < FRAMES; f++) out.push(S.frameGroups.get(f).getUnlinkedInstances('mouse_video').map(u => u.instance.trackIdx));
            return out;
        };
    });
    const status = () => page.evaluate(() => document.getElementById('statusText').textContent);

    console.log('\n1. Track All on one camera runs SLEAP\'s tracker');
    await page.evaluate(() => { window.__lucid.state.isDirty = false; });
    await page.click('#tbTrackAll');
    await page.waitForFunction(() => /ID-switch check|error/.test(document.getElementById('statusText').textContent), { timeout: 60000 });
    const st1 = await status();
    check(/^Tracked 3 animals across 2,250 frames with SLEAP's tracker/.test(st1) && /now coloring by ID/.test(st1),
        'status names SLEAP\'s tracker and the switch to Color: ID: ' + st1.slice(0, 90));
    const trails = await page.evaluate(() => window.__lucid.state.trailSeconds);
    check(trails === 0.25 && /node trails on \(¼ second\)/.test(st1), `node trails turned on at ¼ s, as after a multi-camera Track All (${trails}), and the status says so`);
    check(/ID-switch check \(body size\): not run automatically on one camera \(optional/.test(st1) && !/possible switch/.test(st1),
        'the automatic body-size check is not run on one camera, and the status says so');
    check(/ID-switch check \(coat brightness\): skipped — needs the session's videos to be loaded/.test(st1),
        'the automatic coat-brightness check runs instead (here skipped: no video in this fixture)');
    const tr = await page.evaluate(() => window.__tracks());
    const perAnimal = [0, 1, 2].map(a => new Set(tr.map(r => r[a])));
    check(perAnimal.every(x => x.size === 1) && new Set(perAnimal.map(x => [...x][0])).size === 3,
        'each animal on ONE track for all 75 s, across the input\'s 18 tracklet breaks');
    const info = await page.evaluate(() => {
        const S = window.__lucid.state.session;
        return { tracks: S.tracks.join(','), ids: S.identities.map(i => i.name).join(','), dirty: window.__lucid.state.isDirty };
    });
    check(info.tracks === 'track_0,track_1,track_2' && info.ids === 'id_0,id_1,id_2', `tracks and identities rewritten (${info.tracks} / ${info.ids})`);
    check(info.dirty === true, 'the project is marked dirty');

    console.log('\n1b. Track All ends on the summary box, planned for one camera');
    const box = await page.evaluate(() => {
        const o = document.getElementById('trackSummaryOverlay');
        if (!o) return null;
        return { text: o.textContent, stats: [...o.querySelectorAll('.track-summary-stat')].map(r => r.textContent),
                 checks: [...o.querySelectorAll('.track-summary-check')].map(r => r.getAttribute('data-cue') + ':' + r.className.replace(/.*\bis-/, '') + ':' + (r.title || '')),
                 primary: (o.querySelector('#trackSummaryPrimary') || {}).textContent, ids: o.querySelectorAll('.track-summary-id').length,
                 gallery: o.querySelectorAll('#identityGallery .identity-gallery-row').length };
    });
    check(!!box && /Track All finished/.test(box.text), 'the summary box opens after single-camera Track All');
    check(box && box.stats[0] === 'Tracks3for 3 animals' && box.ids === 3, `it counts the TRACKS, one per animal (${box && box.stats[0]}, ${box && box.ids} bars)`);
    check(box && box.checks.join('|').startsWith('brightness:skipped:') && /^image:off:/.test(box.checks[1]) && /^size:off:not run automatically on one camera — optional/.test(box.checks[2]),
        'its checks: coat brightness (skipped here: no video), images (not run), body size (not run on one camera, the reason on hover)');
    check(box && !/Triangulate/.test(box.text) && box.primary === 'Save project' && /File ▸ Save/.test(box.text),
        `no Triangulate All on one camera: the next step is saving (primary "${box && box.primary}")`);
    check(box && box.gallery === 3, `the Identities section has a row per track (${box && box.gallery}), from the single-camera stand-in`);
    await page.click('#trackSummaryClose');
    const re = await page.evaluate(async () => {
        const b = document.getElementById('idSwitchTrackSummary');
        if (!b) return { button: false };
        b.click();
        const o = document.getElementById('trackSummaryOverlay');
        const out = { button: true, reopened: !!o, stats: o ? o.querySelector('.track-summary-stat').textContent : '' };
        if (o) document.getElementById('trackSummaryClose').click();
        return out;
    });
    check(re.button && re.reopened && re.stats === 'Tracks3for 3 animals', `the ID Switches tab reopens it (${JSON.stringify(re)})`);

    console.log('\n2. Track Frame and Track Frame Range refuse on one camera');
    await page.hover('#tbTrackAll');                  // Track ▾: its menu opens on hover (#395); "This frame" is in it
    await page.waitForTimeout(250);
    await page.click('#tbTrackFrame');
    check(/on a single camera use Track All/.test(await status()), 'Track Frame says to use Track All');
    const range = await page.evaluate(async () => { const t = await import('/pose/tracker.js'); return t.trackFrameRange(0, 300); });
    check(range.ok === false && /Track Frame Range is for multi-camera sessions/.test(await status()), 'Track Frame Range refuses, saying why');
    // Its dialog refuses the same way, before opening, and does not ask for a calibration (one camera needs none).
    await page.evaluate(() => { document.getElementById('statusText').textContent = ''; });
    const dlgOpened = await page.evaluate(async () => { const m = await import('/ui/track-range-modal.js');
        m.showTrackRangeModal({}); const el = document.querySelector('.track-range-modal'); if (el) el.closest('.multi-frame-modal-overlay').remove(); return !!el; });
    const rangeMsg = await status();
    check(!dlgOpened && /Track Frame Range is for multi-camera sessions/.test(rangeMsg) && !/calibration/i.test(rangeMsg),
        `…and so does its dialog, without asking for a calibration (opened ${dlgOpened}: ${rangeMsg.slice(0, 90)})`);
    check(JSON.stringify(await page.evaluate(() => window.__tracks())) === JSON.stringify(tr), '…and neither changed a track');

    console.log('\n3. A planted swap: found, fixed on the tracks, undone');
    const [t0, t1] = [tr[0][0], tr[0][1]];
    const planted = await page.evaluate(([t0, t1]) => {
        const S = window.__lucid.state.session;
        for (let f = 1655; f < 2250; f++) for (const u of S.frameGroups.get(f).getUnlinkedInstances('mouse_video')) {
            if (u.instance.trackIdx === t0) u.instance.trackIdx = t1; else if (u.instance.trackIdx === t1) u.instance.trackIdx = t0;
        }
        return window.__tracks();
    }, [t0, t1]);
    await page.click('#menuCheckSizeSwitches', { force: true }).catch(() => page.evaluate(() => document.getElementById('menuCheckSizeSwitches').click()));
    await page.waitForFunction(() => /Check ID Switches: /.test(document.getElementById('statusText').textContent), { timeout: 60000 });
    check(/Check ID Switches: 1 possible switch/.test(await status()), 'the size check finds one possible switch: ' + (await status()).slice(0, 80));
    const rowFrames = await page.evaluate(() => Array.from(document.querySelectorAll('#idSwitchPanel .id-switch-row')).map(r => Number(r.dataset.frame)));
    const rowFrame = rowFrames.find(f => Math.abs(f - 1650) < 60);
    check(rowFrames.length === 1 && rowFrame != null, `its one row is at the planted encounter (rows at ${rowFrames.join(', ')})`);
    const rowSel = `#idSwitchPanel .id-switch-row[data-frame="${rowFrame}"]`;
    await page.click(rowSel + ' .id-switch-line1');
    const win = await page.evaluate((rf) => {
        const S = window.__lucid.state.session, m = S._idSwitch.results.size.flags.find(x => x.frame === rf);
        const row = document.querySelector(`#idSwitchPanel .id-switch-row[data-frame="${rf}"]`), bar = document.querySelector('#idSwitchPanel .id-switch-pbar');
        return { start: m.startFrame, go: Number(row.dataset.go), now: window.__lucid.state.currentFrame, fps: window.__lucid.state.fps || 30,
                 p0: bar && Number(bar.dataset.p0), p1: bar && Number(bar.dataset.p1), title: bar ? bar.getAttribute('title') : '' };
    }, rowFrame);
    check(win.go === Math.max(0, win.start - 2 * win.fps) && win.now === win.go && win.p0 === win.go && win.p1 === rowFrame + 2 * win.fps && /^2 s before/.test(win.title),
        `on one camera the row's window reaches 2 s either side: lands at ${win.go} (close ${win.start}–${rowFrame}), bar ${win.p0}–${win.p1}, "${win.title.slice(0, 40)}"`);
    const cur = rowFrame + Math.round(1.5 * win.fps);                   // 1.5 s after the close spell: outside a ±1 s window
    await page.evaluate(async (f) => { const I = await import('/pose/initialization.js'); I.navigateToFrame(f); }, cur);
    await page.click(rowSel + ' .id-switch-fix');
    const dlg = await page.evaluate(() => { const d = document.querySelector('.id-switch-fix-modal'); return d ? d.textContent : ''; });
    check(/\(their tracks\)/.test(dlg) && !/in every camera view/.test(dlg), 'the dialog says it swaps their tracks');
    check(new RegExp('Starts at frame ' + (cur + 1).toLocaleString('en-US') + ': the frame you are on').test(dlg),   // frames shown 1-based
        `the boundary is the current frame, 1.5 s after the close spell (inside the 2-s window): "${(dlg.match(/Starts at[^.]*\./) || [''])[0]}"`);
    await page.click('#idSwitchFixOk');
    const fixed = await page.evaluate(() => window.__tracks());
    let wrong = 0;
    for (let f = cur; f < 2250; f++) for (let a = 0; a < 3; a++) if (fixed[f][a] !== tr[f][a]) wrong++;
    check(wrong === 0, `after Fix every detection from the fix on is back on its animal's track (${wrong} wrong)`);
    check(JSON.stringify(fixed.slice(0, 1655)) === JSON.stringify(tr.slice(0, 1655)), '…and nothing before the swap moved');
    await page.click(rowSel + ' .id-switch-line1');
    await page.click(rowSel + ' .id-switch-undo');
    check(JSON.stringify(await page.evaluate(() => window.__tracks())) === JSON.stringify(planted), 'Undo puts the planted swap back exactly');

    console.log('\n4. A switch away from every encounter, found at a candidate moment');
    const cand = await page.evaluate(() => Array.isArray(window.__lucid.state.session._idSwitchCandidates));
    check(cand, 'Track All left the candidate moments on the session');
    const row4 = await page.evaluate(async ([t0, t1, tr]) => {
        const S = window.__lucid.state.session, B = await import('/ui/brightness-sampler.js'), Set_ = await import('/ui/settings.js'), M0 = await import('/ui/id-switch-modal.js');
        // a stand-in for the video: each animal's coat is the brightness of its size (animals 0 / 1 / 2 by how they
        // were added), with noise re-seeded per run so two runs see the same vectors
        const coatOf = new Map();
        for (const fg of S.frameGroups.values()) fg.getUnlinkedInstances('mouse_video').forEach((u, a) => coatOf.set(u.instance, [40, 120, 210][a]));
        window.__fakeBright = (session) => {
            let seed = 9; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
            return { views: ['mouse_video'], inFlight: 2, prepareFrames: async () => {}, releaseFrames: () => {},
                getEmbeddings: async (frame, items) => items.map(it => {
                    // what the progress dialog shows while it reads: the sample-crop square is the image check's
                    const sq = document.querySelector('.id-switch-progress-crop');
                    window.__brightSquare = window.__brightSquare || (sq ? (sq.hidden ? 'hidden' : 'shown') : 'no dialog');
                    const inst = it.group.instances.get('mouse_video');
                    return [{ camera: 'mouse_video', vector: B.brightnessFeatures(Array.from({ length: 11 }, () => coatOf.get(inst) * (0.85 + 0.3 * r()))) }];
                }) };
        };
        Set_.setTrackingThresholds({ brightnessCheckThreshold: -50 });   // encounter rows too (the default -800 is for real coats)
        M0.clearIdSwitchResults(S);                                     // 3's size rows are about other tracks
        // back to the clean tracks, then swap animals 0 and 1 from frame 1800 (the last 20%), where they are 280 px apart
        for (let f = 0; f < 2250; f++) S.frameGroups.get(f).getUnlinkedInstances('mouse_video').forEach((u, a) => {
            u.instance.trackIdx = f >= 1800 && a < 2 ? tr[f][1 - a] : tr[f][a];
        });
        S._idSwitchCandidates = [{ frame: 1800, startFrame: 1796, identityA: Math.min(t0, t1), identityB: Math.max(t0, t1), cues: ['tracklet'] }];
        const M = await import('/ui/id-switch-modal.js');
        const cands = S._idSwitchCandidates;
        S._idSwitchCandidates = null;
        const run = () => M.runIdSwitchChecks({ brightness: true, inject: { createBrightnessSampler: window.__fakeBright } });
        await run();
        const without = Array.from(document.querySelectorAll('#idSwitchPanel .id-switch-row')).map(r => ({ frame: Number(r.dataset.frame), key: r.dataset.key }));
        S._idSwitchCandidates = cands;
        await run();
        const rows = Array.from(document.querySelectorAll('#idSwitchPanel .id-switch-row')).map(r => ({ frame: Number(r.dataset.frame), key: r.dataset.key, text: r.textContent }));
        const repeats = S._idSwitch.results.brightness.flags.filter(m => m.continues).map(m => m.frame);
        const R = await import('/ui/id-switch-review.js');
        const saved = JSON.parse(JSON.stringify(R.serializeIdSwitchReview(S)));
        const copy = { _idSwitch: null };
        R.ingestIdSwitchReview(copy, saved);
        const back = copy._idSwitch ? copy._idSwitch.results.brightness.flags.filter(m => m.look) : [];
        return { rows, without, repeats, back: back.map(m => [m.frame, m.look]), square: window.__brightSquare };
    }, [t0, t1, tr]);
    const mrow = row4.rows.find(r => Math.abs(r.frame - 1800) <= 2);
    check(!row4.without.some(r => Math.abs(r.frame - 1800) <= 2) && mrow, `the moment adds a row AT the switch (rows ${row4.rows.map(r => r.frame).join(', ')}; without it ${row4.without.map(r => r.frame).join(', ')})`);
    // Without the moment the swap's only row is the pair's encounter BEFORE it, whose evidence window ran across
    // the switch. That is the same swapped stretch, so the moment's row takes it over (one row, one fix) …
    const pairOf = k => k.split(':').slice(2).sort().join();
    const taken = row4.without.filter(r => r.frame < 1800 && pairOf(r.key) === pairOf(mrow.key));
    check(taken.length === 1 && !row4.rows.some(r => r.key === taken[0].key) && row4.repeats.includes(taken[0].frame),
        `…taking over the pair's encounter row before it, now a repeat (${taken.map(r => r.frame)})`);
    // … and leaves every other row as it was
    check(JSON.stringify(row4.rows.filter(r => r !== mrow).map(r => r.key)) === JSON.stringify(row4.without.filter(r => !taken.includes(r)).map(r => r.key)),
        '…and every other row is as it was without moments');
    check(mrow && /input tracklet changes animal/.test(mrow.text) && !/close/.test(mrow.text),
        'the row says why it was looked at, and does not call it a close encounter: ' + (mrow || {}).text);
    check(row4.back.length === 1 && JSON.stringify(row4.back[0][1]) === '["tracklet"]', 'the cue survives the saved checklist: ' + JSON.stringify(row4.back));
    check(row4.square === 'hidden', 'its progress dialog shows no sample-crop square (it cuts no crops; it was an empty black one): ' + row4.square);

    console.log('\n5. "Both": a swap at a contact, found by the size and coat-brightness checks');
    const br = await page.evaluate(async (planted) => {
        const S = window.__lucid.state.session, M = await import('/ui/id-switch-modal.js');
        // the planted swap of 3 (animals 0 and 1 exchanged at their encounter, frame 1655 on)
        for (let f = 0; f < 2250; f++) S.frameGroups.get(f).getUnlinkedInstances('mouse_video').forEach((u, a) => { u.instance.trackIdx = planted[f][a]; });
        S._idSwitchCandidates = null;
        await M.runIdSwitchChecks({ size: true, brightness: true, inject: { createBrightnessSampler: window.__fakeBright } });
        const rows = Array.from(document.querySelectorAll('#idSwitchPanel .id-switch-row')).map(r => ({ frame: Number(r.dataset.frame), cls: r.className, text: r.textContent }));
        const st = S._idSwitch;
        return { status: document.getElementById('statusText').textContent, rows,
                 brOk: !!(st.results.brightness && st.results.brightness.ok),
                 marks: Array.from(document.querySelectorAll('#seekbarMarks .seekbar-mark')).map(m => m.className) };
    }, planted);
    check(br.brOk && /Check ID Switches \(coat brightness\): \d+ possible switch/.test(br.status), 'the brightness check ran: ' + br.status.slice(0, 120));
    const bothRow = br.rows.find(r => Math.abs(r.frame - 1650) <= 60 && /cue-both/.test(r.cls));
    check(bothRow && /cue-both-size-brightness/.test(bothRow.cls) && /Both/.test(bothRow.text),
        'the switch both checks find is one "Both" row (size + brightness): ' + JSON.stringify(br.rows.map(r => [r.frame, r.cls.replace('id-switch-row ', '')])));
    check(br.rows.filter(r => Math.abs(r.frame - 1650) <= 60).length === 1, '…listed once');
    check(br.marks.some(c => /cue-both-size-brightness/.test(c)), 'and its seekbar tick wears both colours');

    console.log('\n6. The single-camera options: coat brightness takes them, the label-free size and image checks do not');
    const img = await page.evaluate(async () => {
        const S = window.__lucid.state.session, M = await import('/ui/id-switch-modal.js');
        const animalOf = new Map();
        for (const fg of S.frameGroups.values()) fg.getUnlinkedInstances('mouse_video').forEach((u, a) => animalOf.set(u.instance, a));
        let seed = 5; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        const proto = [0, 1, 2].map(a => Float32Array.from({ length: 16 }, (_, i) => Math.sin(3 * a + i)));
        const fake = async () => ({ views: ['mouse_video'], inFlight: 2, getEmbeddings: async (frame, items) => items.map(it =>
            [{ camera: 'mouse_video', vector: Float32Array.from(proto[animalOf.get(it.group.instances.get('mouse_video'))], v => v + 0.3 * (r() - 0.5)) }]) });
        await M.runIdSwitchChecks({ image: true, inject: { createEmbedder: fake, hasWebGPU: async () => true } });
        const res = S._idSwitch.results.image;
        return { ok: !!(res && res.ok), threshold: res && res.threshold, continueBelow: res && res.continueBelow, skipEmpty: res && res.skipEmpty,
                 lead: ['size', 'image', 'brightness'].map(c => S._idSwitch.results[c] && S._idSwitch.results[c].clearestEndLeads),
                 sizeSkip: S._idSwitch.results.size && S._idSwitch.results.size.skipEmpty, brSkip: S._idSwitch.results.brightness && S._idSwitch.results.brightness.skipEmpty };
    });
    check(img.ok && img.threshold === -0.8 && img.continueBelow === undefined && !img.skipEmpty,
        `the image check ran label-free at its own threshold (${img.threshold}), with no single-camera options (continueBelow ${img.continueBelow}, skipEmpty ${img.skipEmpty})`);
    check(img.brSkip === true && img.sizeSkip === undefined,
        `coat brightness on one camera skips encounters with no samples; the label-free size check has no such rule (size ${img.sizeSkip}, brightness ${img.brSkip})`);
    check(img.lead[0] === undefined && img.lead[1] === undefined && img.lead[2] === true,
        `…and lets the clearest of nearby 'end' rows lead (size / image / brightness: ${img.lead})`);

    console.log('\n7. Duplicate removal: opt-in in the Tracking Wizard, then a planted copy keeps no track');
    await page.evaluate(async () => { const M = await import('/ui/settings-modal.js'); M.showSettingsModal('wizard'); });
    const wiz = await page.evaluate(() => {
        const q = l => document.querySelector(`.settings-overlay [aria-label="${l}"]`);
        const t = q('Single camera: remove duplicate detections'), iou = q('Single camera: duplicate box IoU'), oks = q('Single camera: duplicate OKS');
        return { toggle: t ? t.checked : null, iou: iou && Number(iou.value), oks: oks && Number(oks.value) };
    });
    check(wiz.toggle === false && wiz.iou === 0.5 && wiz.oks === 0.6,
        `the wizard offers it, off by default, with box IoU 0.5 and OKS 0.6 (${JSON.stringify(wiz)})`);
    await page.locator('.settings-overlay [aria-label="Single camera: remove duplicate detections"]').locator('xpath=..').scrollIntoViewIfNeeded();
    await page.locator('.settings-overlay [aria-label="Single camera: remove duplicate detections"]').locator('xpath=..').click();   // the switch's label
    await page.click('.settings-overlay .settings-btn-apply');
    check(await page.evaluate(async () => (await import('/ui/settings.js')).getTrackingThreshold('scRemoveDuplicates')) === 1, 'switched on with Apply');
    const dup = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js'), S = window.__lucid.state.session;
        // SLEAP's second, partial instance on animal 0 at frame 300, a little weaker
        const a0 = S.frameGroups.get(300).getUnlinkedInstances('mouse_video')[0].instance;
        const pts = []; for (let k = 0; k < a0.numNodes; k++) pts.push(k % 4 === 0 ? null : [a0.getX(k) + 1, a0.getY(k) - 1]);
        const copy = new pd.Instance(pts, null, 'predicted', 0.5);
        S.addUnlinkedInstance(300, 'mouse_video', copy);
        window.__copy = copy;
    });
    await page.evaluate(() => { document.getElementById('statusText').textContent = ''; document.getElementById('tbTrackAll').click(); });
    await page.waitForFunction(() => /Tracked \d+ animal|Track All error/.test(document.getElementById('statusText').textContent), { timeout: 60000 });
    const st7 = await status(), after = await page.evaluate(() => ({ copy: window.__copy.trackIdx, tr: window.__tracks() }));
    check(/1 duplicate detection removed first \(left without a track\)/.test(st7), 'the status says one duplicate was removed: ' + st7.slice(0, 160));
    check(after.copy === null, 'the copy keeps no track');
    const per7 = [0, 1, 2].map(a => new Set(after.tr.map(r => r[a])));
    check(per7.every(x => x.size === 1) && new Set(per7.map(x => [...x][0])).size === 3, 'each animal is still on one track throughout');
    const box7 = await page.evaluate(() => { const o = document.getElementById('trackSummaryOverlay'); return o ? [...o.querySelectorAll('.track-summary-stat')].map(r => r.textContent) : null; });
    check(box7 && box7.includes('Without a track1 detection1 duplicate removed first'), 'the summary box counts the removed duplicate: ' + JSON.stringify(box7 && box7.slice(-2)));
    await page.evaluate(() => { const c = document.getElementById('trackSummaryClose'); if (c) c.click(); });
    await page.evaluate(async () => (await import('/ui/settings.js')).setTrackingThresholds({ scRemoveDuplicates: 0 }));

    console.log('\n7b. The Tracking Wizard\'s detection filters apply on one camera, as the Wizard counts them');
    // The planted copy (11 of 15 nodes) is the one detection below a minimum of 12 visible nodes.
    await page.evaluate(async () => { const M = await import('/ui/settings-modal.js'); M.showSettingsModal('wizard'); });
    await page.evaluate(() => {
        const i = document.querySelector('.settings-overlay .settings-num-input[aria-label="Min visible nodes (filter)"]');
        i.value = '12'; i.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => {
        const r = document.querySelector('.settings-overlay [data-testid="detection-filter-preview"]');
        return r && r.querySelector('tr[data-camera="mouse_video"] .dfp-removed');
    }, { timeout: 20000 });
    const readout = await page.evaluate(() =>
        document.querySelector('.settings-overlay [data-testid="detection-filter-preview"] tr[data-camera="mouse_video"] .dfp-removed').textContent.trim());
    check(/\(1\)$/.test(readout), 'the Wizard counts the one detection the filter removes on this camera: ' + readout);
    await page.click('.settings-overlay .settings-btn-apply');
    check(await page.evaluate(async () => (await import('/ui/settings.js')).getTrackingThreshold('filterMinVisibleNodes')) === 12, 'set with Apply');
    await page.evaluate(() => { document.getElementById('statusText').textContent = ''; document.getElementById('tbTrackAll').click(); });
    await page.waitForFunction(() => /Tracked \d+ animal|Track All error/.test(document.getElementById('statusText').textContent), { timeout: 60000 });
    const st7b = await status(), after7b = await page.evaluate(() => ({ copy: window.__copy.trackIdx, tr: window.__tracks() }));
    check(/1 detection removed by the detection filters \(left without a track\)/.test(st7b) && !/duplicate/.test(st7b),
        'the status counts it as filtered, not as a duplicate: ' + st7b.slice(0, 200));
    check(after7b.copy === null, 'the filtered detection keeps no track');
    const per7b = [0, 1, 2].map(a => new Set(after7b.tr.map(r => r[a])));
    check(per7b.every(x => x.size === 1) && new Set(per7b.map(x => [...x][0])).size === 3, 'each animal is still on one track throughout');
    const box7b = await page.evaluate(() => { const o = document.getElementById('trackSummaryOverlay'); return o ? [...o.querySelectorAll('.track-summary-stat')].map(r => r.textContent) : null; });
    check(box7b && box7b.includes('Without a track1 detection1 removed by the detection filters'),
        'the summary box counts it under the filters: ' + JSON.stringify(box7b && box7b.slice(-2)));
    await page.evaluate(() => { const c = document.getElementById('trackSummaryClose'); if (c) c.click(); });
    await page.evaluate(async () => (await import('/ui/settings.js')).setTrackingThresholds({ filterMinVisibleNodes: 0 }));

    console.log('\n7c. The Instances tab shows each instance\'s mean node score, under its instance score');
    const ns = await page.evaluate(async () => {
        const S = window.__lucid.state.session, IP = await import('/ui/info-panel.js');
        // node scores of 0.6 on every node: 0.60 for animal 0 (15 nodes), 0.44 for the 11-node copy (a missing node is 0)
        const a0 = S.frameGroups.get(300).getUnlinkedInstances('mouse_video')[0].instance;
        a0.setPointScores(new Array(15).fill(0.6)); window.__copy.setPointScores(new Array(15).fill(0.6));
        window.__lucid.state.currentFrame = 300; IP.updateInfoPanel(); IP.updateFrameInfo(300, []);
        const t = document.getElementById('unlinkedTable');
        const heads = [...t.querySelectorAll('thead th')].map(th => th.textContent.trim());
        const col = heads.indexOf('Score / Node');
        const cells = [...t.querySelectorAll('tbody tr')].filter(tr => tr.children.length === heads.length)
            .map(tr => [...tr.children[col].querySelectorAll(':scope > div')].map(d => d.textContent).join('/'));
        const head = t.querySelectorAll('thead th')[col];
        return { heads, cells, tip: head && head.dataset.infotip || '' };
    });
    check(ns.heads.join('|') === 'Track / Identity|Type|Points|Score / Node', 'the Ungrouped table\'s last column is Score / Node: ' + ns.heads.join('|'));
    check(ns.cells.slice().sort().join(',') === '0.50/0.44,0.90/-,0.90/-,0.90/0.60',
        'under each instance score, its mean node score: 0.60 and 0.44 (a missing node counts as 0), "-" without node scores: ' + ns.cells.join(','));
    check(/Min mean node score/.test(ns.tip), 'its header explains the second line is what the "Min mean node score" filter tests');

    console.log('\n8. The review list: a lone animal hopping tracks is on it, and a review row Fixes from here to the end');
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js'), AS = await import('/ui/app-state.js');
        const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
            'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
        const T = { Nose: [45, 0], Ear_R: [25, -11], Ear_L: [25, 11], Head: [30, 0], Neck: [20, 0], Trunk: [-5, 0], TTI: [-40, 0],
            Shoulder_left: [10, 12], Shoulder_right: [10, -12], Haunch_left: [-25, 15], Haunch_right: [-25, -15],
            Tail_0: [-65, 0], Tail_1: [-88, 0], Tail_2: [-110, 0], TailTip: [-132, 0] };
        const at = (cx, cy, h = 0) => NODES.map(n => { const [x, y] = T[n], c = Math.cos(h), si = Math.sin(h); return [cx + c * x - si * y, cy + si * x + c * y]; });
        const N = 900, ENTER = 600, walk = f => [600 + 300 * Math.sin(f / 30), 240 + 40 * Math.sin(f / 50)];
        const cam = new pd.Camera('lone_video', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [1280, 960]);
        const s = new pd.Session([cam], new pd.Skeleton('mouse', NODES, []), ['t0', 't1', 't2'], 'lone');
        for (let f = 0; f < N; f++) {
            const [x, y] = walk(f);
            s.addUnlinkedInstance(f, cam.name, new pd.Instance(at(x, y), 0, 'predicted', 0.9));           // A: alone, fast
            s.addUnlinkedInstance(f, cam.name, new pd.Instance(at(300, 800), 2, 'predicted', 0.9));       // C: far away, still
            if (f >= ENTER) s.addUnlinkedInstance(f, cam.name, new pd.Instance(at(1150, 600 - 0.2 * (f - ENTER), Math.PI), 1, 'predicted', 0.9));
            else if (f % 50 === 25) { const [nx, ny] = walk(f + 1); s.addUnlinkedInstance(f, cam.name, new pd.Instance(at(nx, ny), null, 'predicted', 0.7)); }
        }
        AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
        AS.state.totalFrames = N; AS.state.currentFrame = 0; AS.state.fps = 30;
        if (AS.timeline) { AS.timeline.setTotalFrames(N); AS.timeline.setData(s); }
        window.__lone = () => { const S = AS.state.session, out = [];
            for (let f = 0; f < N; f++) out.push(S.frameGroups.get(f).getUnlinkedInstances('lone_video').map(u => u.instance.trackIdx));
            return out; };
    });
    await page.evaluate(() => { document.getElementById('statusText').textContent = ''; document.getElementById('tbTrackAll').click(); });
    await page.waitForFunction(() => /Tracked \d+ animal|Track All error/.test(document.getElementById('statusText').textContent), { timeout: 60000 });
    const st8 = await status();
    const rv = await page.evaluate(() => {
        const r = window.__lucid.state.session._idSwitch && window.__lucid.state.session._idSwitch.results.review;
        return r ? { n: r.flags.length, handover: r.flags.filter(m => m.look.includes('handover')).length } : null;
    });
    check(!!rv && rv.n > 0 && rv.handover > 0 && new RegExp(rv.n + ' places? to review in the ID Switches tab').test(st8),
        `Track All leaves ${rv && rv.n} places to review (${rv && rv.handover} handovers), and the status says so: …${st8.slice(st8.indexOf('detection') - 20, st8.indexOf('ID Switches tab') + 15)}`);
    const box8 = await page.evaluate(() => { const o = document.getElementById('trackSummaryOverlay'); return o ? { stats: [...o.querySelectorAll('.track-summary-stat')].map(r => r.textContent),
        primary: (o.querySelector('#trackSummaryPrimary') || {}).textContent, text: o.textContent } : null; });
    check(box8 && box8.stats.some(x => new RegExp('^To review' + rv.n + ' place').test(x)) && box8.primary === 'Review the list' && /most likely to hold a switch/.test(box8.text),
        `the summary box counts them and makes reviewing them the next step (primary "${box8 && box8.primary}")`);
    await page.click('#trackSummaryPrimary');                                     // Review the list: the tab, on the first row
    const tab = await page.evaluate(() => ({ rows: document.querySelectorAll('#idSwitchPanel .id-switch-row.cue-review').length,
        head: (document.querySelector('#idSwitchPanel .id-switch-summary') || {}).textContent || '',
        note: (document.querySelector('#idSwitchPanel .id-switch-row.cue-review .id-switch-line2') || {}).textContent || '',
        score: document.querySelectorAll('#idSwitchPanel .id-switch-row.cue-review .id-switch-score').length,
        current: !!document.querySelector('#idSwitchPanel .id-switch-row.is-current'),
        ticks: document.querySelectorAll('.seekbar-mark.cue-review').length }));
    check(tab.rows === rv.n && new RegExp(rv.n + ' places? to look at').test(tab.head) && tab.score === 0,
        `the ID Switches tab lists them as review rows, with no score (${tab.rows} rows, "${tab.head}")`);
    check(/a lone animal's track changes/.test(tab.note), 'a row says why it is on the list: ' + tab.note.slice(0, 90));
    check(tab.current && tab.ticks > 0, `"Review the list" lands on the first row, and the rows have grey seekbar ticks (${tab.ticks})`);
    const before = await page.evaluate(() => window.__lone());
    const sel = await page.evaluate(() => { const r = document.querySelector('#idSwitchPanel .id-switch-row.cue-review'); return r.dataset.key; });
    const rowSel8 = `#idSwitchPanel .id-switch-row[data-key="${sel}"]`;
    await page.click(rowSel8 + ' .id-switch-line1');
    const here = await page.evaluate(() => window.__lucid.state.currentFrame);
    await page.click(rowSel8 + ' .id-switch-fix');
    const fixDlg = await page.evaluate(() => { const d = document.querySelector('.id-switch-fix-modal'); return d ? { text: d.textContent,
        picks: d.querySelectorAll('select.id-switch-pair-pick').length, a: (d.querySelector('#idSwitchFixA') || {}).value, b: (d.querySelector('#idSwitchFixB') || {}).value } : null; });
    check(fixDlg && fixDlg.picks === 2 && /the end of the video — later places on the list fix their own stretches/.test(fixDlg.text) &&
        /Starts at frame [\d,]+: the frame you are on/.test(fixDlg.text),
        `Fix on a review row: two tracks to pick (three tracks here), from the frame you are on to the end of the video (${fixDlg && fixDlg.a} ↔ ${fixDlg && fixDlg.b})`);
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => !document.querySelector('.id-switch-fix-modal')) && JSON.stringify(await page.evaluate(() => window.__lone())) === JSON.stringify(before),
        'Esc cancels it and changes nothing');
    await page.click(rowSel8 + ' .id-switch-fix');
    const pickA = fixDlg.a, pickB = fixDlg.a === 'id_2' ? 'id_0' : 'id_2';      // a pair other than the row's
    await page.selectOption('#idSwitchFixB', pickB);
    await page.click('#idSwitchFixOk');
    const after8 = await page.evaluate(() => window.__lone());
    const ida = Number(pickA.slice(3)), idb = Number(pickB.slice(3));
    let bad = 0, swapped = 0;
    for (let f = 0; f < before.length; f++) for (let q = 0; q < before[f].length; q++) {
        const t = before[f][q], want = f < here ? t : t === ida ? idb : t === idb ? ida : t;
        if (after8[f][q] !== want) bad++; else if (want !== t) swapped++;
    }
    check(bad === 0 && swapped > 0, `it swaps the two PICKED tracks (${pickA} ↔ ${pickB}) from the frame you were on to the end (${swapped} detections moved, ${bad} wrong)`);

    // Labels that swap back before the next place: Fix again on the same row, from a frame past its own window.
    const acts = await page.evaluate((s) => [...document.querySelectorAll(s + ' .id-switch-actions button')].map(b => b.textContent), rowSel8);
    check(acts.includes('Fix again…') && acts.includes('Undo fix'), `a fixed review row keeps a "Fix again…" button beside Undo (${acts.join(', ')})`);
    const later = await page.evaluate((key) => {
        const S = window.__lucid.state.session, flags = S._idSwitch.results.review.flags;
        const m = flags.find(x => 'review:' + x.frame + ':' + x.nameA + ':' + x.nameB === key) || flags[0];
        const next = flags.filter(x => x.frame > m.frame).map(x => Math.min(x.startFrame, x.frame));
        return { own: m.frame + 60, next: next.length ? Math.min(...next) : window.__lucid.state.totalFrames };
    }, sel);
    const here2 = Math.min(later.next - 1, later.own + 30);
    check(here2 > later.own && here2 > here, `a frame past the row's own window but before the next place (${here2}; window to ${later.own}, next place at ${later.next})`);
    await page.evaluate(async (f) => { const I = await import('/pose/initialization.js'); I.navigateToFrame(f); }, here2);
    await page.click(rowSel8 + ' .id-switch-fix');
    const dlg2 = await page.evaluate(() => (document.querySelector('.id-switch-fix-modal') || {}).textContent || '');
    check(/Starts at frame [\d,]+: the frame you are on/.test(dlg2) && /before the next place, go to where they do and click Fix again on this row/.test(dlg2),
        'Fix again starts from the frame you are on, and the dialog says when to use it');
    await page.selectOption('#idSwitchFixA', pickA);
    await page.selectOption('#idSwitchFixB', pickB);
    await page.click('#idSwitchFixOk');
    const after8b = await page.evaluate(() => window.__lone());
    bad = 0; swapped = 0;
    for (let f = 0; f < before.length; f++) for (let q = 0; q < before[f].length; q++) {
        const t = before[f][q], want = f < here || f >= here2 ? t : t === ida ? idb : t === idb ? ida : t;
        if (after8b[f][q] !== want) bad++; else if (want !== t) swapped++;
    }
    check(bad === 0 && swapped > 0, `the two fixes leave only the stretch between them swapped (${swapped} detections, ${bad} wrong)`);
    await page.click(rowSel8 + ' .id-switch-line1');
    const note2 = await page.evaluate((s) => (document.querySelector(s + ' .id-switch-fixed-note') || {}).textContent || '', rowSel8);
    check(/^Fixed: .* swapped on frames [\d,]+–[\d,]+; again on frames [\d,]+–[\d,]+$/.test(note2), 'the row lists both fixes: ' + note2);

    // A check's row on the review list (the tab shows the two as one row): it offers the check's Fix switch… and,
    // beside it, the place's own "Fix from here…"; once fixed it keeps "Fix again…" — the place's fix, from the
    // frame you are on — as a review row does.
    for (let k = 0; k < 2; k++) { await page.click(rowSel8 + ' .id-switch-line1'); await page.click(rowSel8 + ' .id-switch-undo'); }
    check(JSON.stringify(await page.evaluate(() => window.__lone())) === JSON.stringify(before), 'Undo twice takes back both fixes');
    const merged = await page.evaluate(async (key) => {
        const S = window.__lucid.state.session, st = S._idSwitch, flags = st.results.review.flags;
        const m = flags.find(x => 'review:' + x.frame + ':' + x.nameA + ':' + x.nameB === key);
        if (!m) return null;
        st.results.brightness = { ok: true, fps: 30, sampleHz: 10, step: 3, imageHz: 4, crops: 0, cameras: [S.cameras[0].name], encounters: [], changes: [], flags: [{ frame: m.frame, startFrame: m.startFrame,
            identityA: m.identityA, identityB: m.identityB, nameA: m.nameA, nameB: m.nameB, kind: 'onset', score: -500, switchBackAt: null }] };
        const R = await import('/ui/id-switch-review.js'), M = await import('/ui/id-switch-modal.js');
        R.linkIdSwitchResults(st.results); M.refreshIdSwitchPanel(S);
        return { key: 'brightness:' + m.frame + ':' + m.nameA + ':' + m.nameB, frame: m.frame, a: m.nameA, b: m.nameB, total: window.__lucid.state.totalFrames };
    }, sel);
    check(!!merged, 'the place to put a check row on');
    const rowSelM = `#idSwitchPanel .id-switch-row[data-key="${merged.key}"]`;
    check(await page.evaluate((s) => { const r = document.querySelector(s); return !!r && r.classList.contains('cue-both') && /on the review list/.test(r.textContent); }, rowSelM),
        'the check row and the place show as one row, "on the review list"');
    const beforeM = await page.evaluate(() => window.__lone());
    await page.click(rowSelM + ' .id-switch-line1');
    const acts0 = await page.evaluate((s) => [...document.querySelectorAll(s + ' .id-switch-actions button')].map(b => b.textContent), rowSelM);
    check(JSON.stringify(acts0) === JSON.stringify(['Fix switch…', 'Fix from here…']), `unfixed, it offers the check's Fix and the place's (${acts0.join(', ')})`);
    await page.click(rowSelM + ' .id-switch-fix[data-place]');
    const dlgP = await page.evaluate(() => (document.querySelector('.id-switch-fix-modal') || {}).textContent || '');
    check(/the end of the video — later places on the list fix their own stretches/.test(dlgP), 'Fix from here… is the place\'s fix, to the end of the video');
    await page.click('#idSwitchFixCancel');
    check(JSON.stringify(await page.evaluate(() => window.__lone())) === JSON.stringify(beforeM), '…and Cancel changes nothing');
    await page.click(rowSelM + ' .id-switch-fix');
    const dlgM = await page.evaluate(() => (document.querySelector('.id-switch-fix-modal') || {}).textContent || '');
    check(!/later places on the list fix their own stretches/.test(dlgM) && !(await page.$('#idSwitchFixA')),
        'its first Fix is the check\'s own (no pair to pick, not "to the end of the video")');
    await page.click('#idSwitchFixOk');
    const actsM = await page.evaluate((s) => [...document.querySelectorAll(s + ' .id-switch-actions button')].map(b => b.textContent), rowSelM);
    check(actsM.includes('Fix again…') && actsM.includes('Undo fix'), `once fixed it keeps "Fix again…" beside Undo (${actsM.join(', ')})`);
    const midM = await page.evaluate(() => window.__lone());
    const hereM = Math.min(merged.frame + 40, merged.total - 2);
    await page.evaluate(async (f) => { const I = await import('/pose/initialization.js'); I.navigateToFrame(f); }, hereM);
    await page.click(rowSelM + ' .id-switch-fix');
    const dlgM2 = await page.evaluate(() => (document.querySelector('.id-switch-fix-modal') || {}).textContent || '');
    check(/Starts at frame [\d,]+: the frame you are on/.test(dlgM2) && /the end of the video — later places on the list fix their own stretches/.test(dlgM2),
        'Fix again is the place\'s fix: from the frame you are on to the end of the video');
    const pa = await page.$eval('#idSwitchFixA', e => e.value).catch(() => merged.a), pb = await page.$eval('#idSwitchFixB', e => e.value).catch(() => merged.b);
    await page.click('#idSwitchFixOk');
    const afterM = await page.evaluate(() => window.__lone());
    const ma = Number(pa.slice(3)), mb = Number(pb.slice(3));
    bad = 0; swapped = 0;
    for (let f = 0; f < midM.length; f++) for (let q = 0; q < midM[f].length; q++) {
        const t = midM[f][q], want = f < hereM ? t : t === ma ? mb : t === mb ? ma : t;
        if (afterM[f][q] !== want) bad++; else if (want !== t) swapped++;
    }
    check(bad === 0 && swapped > 0 && JSON.stringify(midM) !== JSON.stringify(beforeM),
        `Fix again swaps ${pa} ↔ ${pb} from the frame you are on to the end (${swapped} detections moved, ${bad} wrong)`);
    const noteM = await page.evaluate((s) => { const r = document.querySelector(s);
        return { current: !!r && r.classList.contains('is-current'), note: (r && r.querySelector('.id-switch-fixed-note') || {}).textContent || '' }; }, rowSelM);
    check(noteM.current && /^Fixed: .* swapped on frames [\d,]+–[\d,]+; again on frames [\d,]+–[\d,]+$/.test(noteM.note),
        `the row stays selected and lists both fixes: ${noteM.note}`);

    // A place that is not on the review list: a coat-brightness row where an animal comes back (`look` 'return')
    // shown as one row with an image row. Once the image row's Fix is taken it still offers the return's own fix.
    for (let k = 0; k < 2; k++) { await page.click(rowSelM + ' .id-switch-line1'); await page.click(rowSelM + ' .id-switch-undo'); }
    const ret = await page.evaluate(async (frame) => {
        const S = window.__lucid.state.session, st = S._idSwitch, m = st.results.review.flags.find(x => x.frame === frame);
        const row = (cue, extra) => Object.assign({ frame: m.frame, startFrame: m.startFrame, identityA: m.identityA, identityB: m.identityB,
            nameA: m.nameA, nameB: m.nameB, kind: 'onset', score: -500, switchBackAt: null }, extra);
        st.results.image = { ok: true, fps: 30, sampleHz: 10, step: 3, imageHz: 4, crops: 0, cameras: [S.cameras[0].name], encounters: [], changes: [],
            flags: [row('image', {})] };
        st.results.brightness.flags = [row('brightness', { look: ['return'] })];
        st.results.review.flags = st.results.review.flags.filter(x => x !== m);     // not on the review list
        const R = await import('/ui/id-switch-review.js'), M = await import('/ui/id-switch-modal.js');
        R.linkIdSwitchResults(st.results); M.refreshIdSwitchPanel(S);
        return { key: 'image:' + m.frame + ':' + m.nameA + ':' + m.nameB, frame: m.frame, total: window.__lucid.state.totalFrames };
    }, merged.frame);
    const rowSelR = `#idSwitchPanel .id-switch-row[data-key="${ret.key}"]`;
    await page.click(rowSelR + ' .id-switch-line1');
    const actsR0 = await page.evaluate((s) => [...document.querySelectorAll(s + ' .id-switch-actions button')].map(b => b.textContent), rowSelR);
    check(JSON.stringify(actsR0) === JSON.stringify(['Fix switch…', 'Fix from here…']), `an image row shown with a return offers both fixes (${actsR0.join(', ')})`);
    await page.click(rowSelR + ' .id-switch-fix');
    await page.click('#idSwitchFixOk');
    const actsR = await page.evaluate((s) => [...document.querySelectorAll(s + ' .id-switch-actions button')].map(b => b.textContent), rowSelR);
    check(actsR.includes('Fix again…') && actsR.includes('Undo fix'), `once its image Fix is taken it keeps "Fix again…" for the return (${actsR.join(', ')})`);
    const midR = await page.evaluate(() => window.__lone()), hereR = Math.min(ret.frame + 40, ret.total - 2);
    await page.evaluate(async (f) => { const I = await import('/pose/initialization.js'); I.navigateToFrame(f); }, hereR);
    await page.click(rowSelR + ' .id-switch-fix');
    const dlgR = await page.evaluate(() => (document.querySelector('.id-switch-fix-modal') || {}).textContent || '');
    check(/Starts at frame [\d,]+: the frame you are on/.test(dlgR) && /the end of the video — later places/.test(dlgR),
        'Fix again on it is the return\'s fix: from the frame you are on to the end of the video');
    const ra = await page.$eval('#idSwitchFixA', e => e.value).catch(() => null), rb = await page.$eval('#idSwitchFixB', e => e.value).catch(() => null);
    await page.click('#idSwitchFixOk');
    const afterR = await page.evaluate(() => window.__lone());
    const fixR = await page.evaluate(() => { const f = window.__lucid.state.session._idSwitch.fixes; return f[f.length - 1]; });
    const xa = Number((ra || fixR.nameA).slice(3)), xb = Number((rb || fixR.nameB).slice(3));
    bad = 0; swapped = 0;
    for (let f = 0; f < midR.length; f++) for (let q = 0; q < midR[f].length; q++) {
        const t = midR[f][q], want = f < hereR ? t : t === xa ? xb : t === xb ? xa : t;
        if (afterR[f][q] !== want) bad++; else if (want !== t) swapped++;
    }
    check(bad === 0 && swapped > 0 && fixR.from === hereR && fixR.key.startsWith('brightness:'),
        `it swaps from the frame you are on to the end, as the return's fix (${swapped} detections moved, ${bad} wrong)`);

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n✗ ${fails} check(s) failed` : '\n✓ all checks passed');
process.exit(fails ? 1 : 0);
