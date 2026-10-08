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
 *     dirty, and says the automatic body-size check is not run on one camera
 *     (2D size is unreliable there; the menu still runs it — see 3).
 *  2. Track Frame and Track Frame Range refuse on one camera, saying why, and
 *     change nothing.
 *  3. A swap planted in the tracks (animals 0 and 1 exchanged for the last 26%)
 *     is found by Tracks ▸ Check ID Switches (Body Size) as a row; Fix switch
 *     names the TRACKS in its dialog and puts every detection back on its
 *     animal's track; Undo plants the swap back exactly. The row's window (its
 *     landing frame, progress bar and where Fix takes the current frame as the
 *     boundary) reaches 2 s either side of the close spell on one camera.
 *  4. Where to look: Track All leaves candidate moments on the session, and the
 *     checks test them. A swap planted while the two animals are far apart,
 *     with a candidate moment there, gets a row AT the moment, saying why it was
 *     looked at — which survives the saved checklist (metadata.lucid.idSwitchReview)
 *     — on top of the encounter rows, which are what they were without it.
 *  5. The coat-brightness check (what Tracks ▸ Check ID Switches (Coat
 *     Brightness) runs), with a stand-in sampler (the coats differ): a change point both it and
 *     the size check find is ONE "Both" row on the size result (violet + amber),
 *     and its ticks are on the seekbar.
 *  6. The image check (stand-in embedder) on one camera ends a run of flagged
 *     encounters only at a clearly positive one: `continueBelow` = +|threshold|
 *     (pose/single-camera-tracking.js `singleCameraImageContinueBelow`).
 *
 * Run: node tests/e2e/single-camera-track-all.mjs
 */
import { chromium } from 'playwright';
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
    page.on('dialog', d => d.accept('3'));   // Track All asks for the animal count
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
    check(/ID-switch check \(body size\): not run on one camera/.test(st1) && !/possible switch/.test(st1),
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

    console.log('\n2. Track Frame and Track Frame Range refuse on one camera');
    await page.click('#tbTrackFrame');
    check(/on a single camera use Track All/.test(await status()), 'Track Frame says to use Track All');
    const range = await page.evaluate(async () => { const t = await import('/pose/tracker.js'); return t.trackFrameRange(0, 300); });
    check(range.ok === false && /Track Frame Range is for multi-camera sessions/.test(await status()), 'Track Frame Range refuses, saying why');
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
        const S = window.__lucid.state.session;
        // back to the clean tracks, then swap animals 0 and 1 from frame 1800 (the last 20%), where they are 280 px apart
        for (let f = 0; f < 2250; f++) S.frameGroups.get(f).getUnlinkedInstances('mouse_video').forEach((u, a) => {
            u.instance.trackIdx = f >= 1800 && a < 2 ? tr[f][1 - a] : tr[f][a];
        });
        S._idSwitchCandidates = [{ frame: 1800, startFrame: 1796, identityA: Math.min(t0, t1), identityB: Math.max(t0, t1), cues: ['tracklet'] }];
        const M = await import('/ui/id-switch-modal.js');
        const cands = S._idSwitchCandidates;
        S._idSwitchCandidates = null;
        await M.runIdSwitchChecks({ size: true });
        const without = Array.from(document.querySelectorAll('#idSwitchPanel .id-switch-row')).map(r => ({ frame: Number(r.dataset.frame), key: r.dataset.key }));
        S._idSwitchCandidates = cands;
        await M.runIdSwitchChecks({ size: true });
        const rows = Array.from(document.querySelectorAll('#idSwitchPanel .id-switch-row')).map(r => ({ frame: Number(r.dataset.frame), key: r.dataset.key, text: r.textContent }));
        const repeats = S._idSwitch.results.size.flags.filter(m => m.continues).map(m => m.frame);
        const R = await import('/ui/id-switch-review.js');
        const saved = JSON.parse(JSON.stringify(R.serializeIdSwitchReview(S)));
        const copy = { _idSwitch: null };
        R.ingestIdSwitchReview(copy, saved);
        const back = copy._idSwitch ? copy._idSwitch.results.size.flags.filter(m => m.look) : [];
        return { rows, without, repeats, back: back.map(m => [m.frame, m.look]) };
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

    console.log('\n5. Coat brightness, and "Both" with the size check');
    const br = await page.evaluate(async () => {
        const S = window.__lucid.state.session, M = await import('/ui/id-switch-modal.js'), B = await import('/ui/brightness-sampler.js');
        // a stand-in for the video: each animal's coat is the brightness of its size (animals 0 / 1 / 2 by how they were added)
        const coatOf = new Map();
        for (const fg of S.frameGroups.values()) fg.getUnlinkedInstances('mouse_video').forEach((u, a) => coatOf.set(u.instance, [40, 120, 210][a]));
        let seed = 9; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        const fake = (session) => ({
            views: ['mouse_video'], inFlight: 2,
            prepareFrames: async () => {}, releaseFrames: () => {},
            getEmbeddings: async (frame, items) => items.map(it => {
                const inst = it.group.instances.get('mouse_video');
                return [{ camera: 'mouse_video', vector: B.brightnessFeatures(Array.from({ length: 11 }, () => coatOf.get(inst) * (0.85 + 0.3 * r()))) }];
            }),
        });
        await M.runIdSwitchChecks({ size: true, brightness: true, inject: { createBrightnessSampler: fake } });
        const rows = Array.from(document.querySelectorAll('#idSwitchPanel .id-switch-row')).map(r => ({ frame: Number(r.dataset.frame), cls: r.className, text: r.textContent }));
        const st = S._idSwitch;
        return { status: document.getElementById('statusText').textContent, rows,
                 brOk: !!(st.results.brightness && st.results.brightness.ok),
                 marks: Array.from(document.querySelectorAll('#seekbarMarks .seekbar-mark')).map(m => m.className) };
    });
    check(br.brOk && /Check ID Switches \(coat brightness\): \d+ possible switch/.test(br.status), 'the brightness check ran: ' + br.status.slice(0, 120));
    const bothRow = br.rows.find(r => Math.abs(r.frame - 1800) <= 30 && /cue-both/.test(r.cls));
    check(bothRow && /cue-both-size-brightness/.test(bothRow.cls) && /Both/.test(bothRow.text),
        'the switch both checks find is one "Both" row (size + brightness): ' + JSON.stringify(br.rows.map(r => [r.frame, r.cls.replace('id-switch-row ', '')])));
    check(br.rows.filter(r => Math.abs(r.frame - 1800) <= 30).length === 1, '…listed once');
    check(br.marks.some(c => /cue-both-size-brightness/.test(c)), 'and its seekbar tick wears both colours');

    console.log('\n6. The image check on one camera ends a run only at a clearly positive encounter');
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
        return { ok: !!(res && res.ok), threshold: res && res.threshold, continueBelow: res && res.continueBelow };
    });
    check(img.ok && img.threshold === -25 && img.continueBelow === 25,
        `the image check ran at threshold ${img.threshold} with runs ending only above ${img.continueBelow} (want -25 / +25)`);

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n✗ ${fails} check(s) failed` : '\n✓ all checks passed');
process.exit(fails ? 1 : 0);
