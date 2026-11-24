/**
 * multi-camera-review-list.mjs — the review list multi-camera Track All leaves (pose/multi-camera-review.js) in the
 * real app: two animals of the same size on three calibrated cameras, side by side and facing the same way, meet at
 * one point every 10 s for 75 s.
 *  1. Track All (the real button, the real cross-view tracker) leaves a review list: a row at each meeting, where the
 *     two 3D paths nearly cross (pair id_0/id_1, "their 3D paths nearly cross"), a check row where both are first in
 *     view (frame 1, "every animal first in view") and one at the end; the status counts them; the summary box has
 *     "To review" and "Review the list" as its primary, with Triangulation Wizard… beside it.
 *  2. On a place, "◂ Earlier encounter" (multi-camera too) goes to 1 s before the pair's close encounters by 3D
 *     distance (pairEncounters3d), latest first, then says there is none; after it the place's Fix may start before
 *     the place, and swaps the two identities from there to the end in EVERY view (and in the 3D groups).
 *  3. On several cameras the pre-judge is opt-in (imageCheckPrejudgeMultiCamera, off by default): off, the image check
 *     runs without one and "About these flags" says how to turn it on. On, it pre-judges the list (each animal's
 *     views at a sample averaged first): with a stand-in embedder whose two looks trade places from 0:40, the place
 *     at 0:20 "looks right" and the one at 0:40 "looks swapped"; the check rows get no note; "About these flags"
 *     says how several cameras are combined.
 *
 * Run: node tests/e2e/multi-camera-review-list.mjs
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import { answerTrackSetup } from './fixtures/track-setup.js';

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const server = await startServer();

let browser;
try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await answerTrackSetup(page, 2);
    await page.goto(`${server.url}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });

    const FPS = 30, N = 75 * FPS, MEET = Array.from({ length: 7 }, (_, k) => 150 + 300 * k);   // 0:05, 0:15, … 1:05
    await page.evaluate(async ({ N, FPS }) => {
        const pd = await import('/pose/pose-data.js'), AS = await import('/ui/app-state.js');
        const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
            'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
        const T = { Nose: [45, 0, 0], Ear_R: [25, -11, 4], Ear_L: [25, 11, 4], Head: [30, 0, 3], Neck: [20, 0, 2],
            Trunk: [-5, 0, 4], TTI: [-40, 0, 0], Shoulder_left: [10, 12, 0], Shoulder_right: [10, -12, 0],
            Haunch_left: [-25, 15, 0], Haunch_right: [-25, -15, 0], Tail_0: [-65, 0, 0], Tail_1: [-88, 0, 0],
            Tail_2: [-110, 0, 0], TailTip: [-132, 0, 0] };
        const cam = (n, rvec, tvec) => new pd.Camera(n, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
        const CAMS = [cam('c0', [0, 0, 0], [0, 0, 0]), cam('c1', [0, 0.35, 0], [-12, 0, 3]), cam('c2', [0.35, 0, 0], [0, -12, 3])];
        const s = new pd.Session(CAMS, new pd.Skeleton('mouse', NODES, []), ['track_0', 'track_1'], 'meet');
        for (let f = 0; f < N; f++) {
            const fg = new pd.FrameGroup(f), t = f / FPS, d = 15 * Math.abs(Math.cos(Math.PI * ((t % 10) / 10)));
            for (let a = 0; a < 2; a++) {
                const ctr = [a ? d : -d, 0, 48], h = Math.PI / 2, ch = Math.cos(h), sh = Math.sin(h);
                const pts3 = NODES.map(n => { const [x, y, z] = T[n].map(v => v * 0.05); return [ctr[0] + ch * x - sh * y, ctr[1] + sh * x + ch * y, ctr[2] + z]; });
                CAMS.forEach(c => fg.addInstance(c.name, new pd.Instance(pts3.map(p => c.project(p)), a, 'predicted', 1.0)));
            }
            s.addFrameGroup(fg);
        }
        AS.state.sessions = [s]; AS.state.activeSessionIdx = 0; AS.state.session = s;
        AS.state.totalFrames = N; AS.state.currentFrame = 0; AS.state.views = []; AS.state.fps = FPS;
        AS.state.triangulationResults = new Map();
        if (AS.timeline) { AS.timeline.setTotalFrames(N); AS.timeline.setData(s); }
        // per frame, per camera c0..c2: the identity of animal 0's and animal 1's detection (trackIdx = animal)
        window.__ids = () => { const S = AS.state.session, out = [];
            for (let f = 0; f < N; f++) out.push(['c0', 'c1', 'c2'].map(c => [0, 1].map(t => S.getFrameIdentityValue(f, c, t))));
            return out; };
        window.__groups = () => { const S = AS.state.session, out = [];
            for (let f = 0; f < N; f++) out.push((S.instanceGroups.get(f) || []).map(g => [g.identityId, g.instances.get('c0') ? g.instances.get('c0').trackIdx : -1]));
            return out; };
    }, { N, FPS });
    const status = () => page.evaluate(() => document.getElementById('statusText').textContent);

    console.log('\n1. Track All leaves a review list on several cameras');
    await page.click('#tbTrackAll');
    await page.waitForSelector('#trackSummaryOverlay', { timeout: 60000 });
    const rv = await page.evaluate(() => { const S = window.__lucid.state.session, r = S._idSwitch && S._idSwitch.results.review;
        return r ? r.flags.map(m => ({ frame: m.frame, start: m.startFrame, look: m.look.join(), a: m.nameA, b: m.nameB })) : null; });
    const cross = (rv || []).filter(m => m.look === 'crossing');
    check(cross.length === MEET.length && MEET.every(f => cross.some(m => m.start - 30 <= f && f <= m.frame + 30)) && cross.every(m => m.a === 'id_0' && m.b === 'id_1'),
        `a row at each meeting, where the 3D paths nearly cross, between id_0 and id_1 (${cross.map(m => m.start + '–' + m.frame).join(', ')})`);
    check(rv && rv[0].look === 'videoStart' && rv[0].frame === 0 && rv[rv.length - 1].look === 'videoEnd' && rv[rv.length - 1].frame === N - 1 && rv.length === MEET.length + 2,
        `check rows where both are first in view (frame 1) and at the end, nothing else (${rv && rv.length} rows)`);
    const st1 = await status();
    check(new RegExp((MEET.length + 2) + ' places to review in the ID Switches tab').test(st1) && /^Assigned 2 identities/.test(st1),
        'the status counts them: …' + st1.slice(st1.indexOf('places') - 3, st1.indexOf('tab') + 3));
    const box = await page.evaluate(() => { const o = document.getElementById('trackSummaryOverlay');
        return { stats: [...o.querySelectorAll('.track-summary-stat')].map(r => [...r.children].map(c => c.textContent).join('|')),
                 primary: (o.querySelector('#trackSummaryPrimary') || {}).textContent, buttons: [...o.querySelectorAll('button')].map(b => b.textContent) }; });
    check(box.stats.some(x => x.startsWith('To review|' + (MEET.length + 2) + ' places')) && box.primary === 'Review the list' &&
        box.buttons.includes('Triangulation Wizard…'), `the summary box: "To review", "Review the list" first, Triangulation Wizard… beside it (${JSON.stringify(box.buttons)})`);
    await page.click('#trackSummaryPrimary');
    const tab = await page.evaluate(() => [...document.querySelectorAll('#idSwitchPanel .id-switch-row.cue-review')].map(r => r.textContent));
    check(tab.length === MEET.length + 2 && /every animal first in view/.test(tab[0]) && /their 3D paths nearly cross/.test(tab[1]) && /the end of the tracking/.test(tab[tab.length - 1]),
        'the ID Switches tab lists them, each saying why');

    console.log('\n2. "◂ Earlier encounter" and the place\'s Fix, on several cameras');
    // one place at 1:10 (frame 2100), between id_0 and id_1, as a reviewer meets a swap with no row of its own
    const key2 = await page.evaluate(async () => {
        const S = window.__lucid.state.session, st = S._idSwitch, R = await import('/ui/id-switch-review.js'), M = await import('/ui/id-switch-modal.js');
        const id = n => S.identities.find(i => i.name === n).id;
        st.results.review.flags = [{ frame: 2100, startFrame: 2100, identityA: id('id_0'), identityB: id('id_1'), nameA: 'id_0', nameB: 'id_1',
            kind: 'onset', score: 0, look: ['crossing'], switchBackAt: null, cue: 'review' }];
        R.linkIdSwitchResults(st.results); M.refreshIdSwitchPanel(S);
        const P = await import('/pose/multi-camera-review.js');
        window.__enc = P.pairEncounters3d(S, id('id_0'), id('id_1'), 0, 2099, { fps: 30 });
        return R.idSwitchRowKey(st.results.review.flags[0]);
    });
    const enc = await page.evaluate(() => window.__enc);
    check(enc.length === MEET.length && enc.every((e, i) => e.start <= MEET[i] && MEET[i] <= e.end),
        `the pair's close encounters by 3D distance: one per meeting (${enc.map(e => e.start + '–' + e.end).join(', ')})`);
    const rowSel = `#idSwitchPanel .id-switch-row[data-key="${key2}"]`;
    await page.click(rowSel + ' .id-switch-line1');
    const acts = await page.evaluate(s => [...document.querySelectorAll(s + ' .id-switch-actions button')].map(b => b.textContent + '|' + (b.title || '')), rowSel);
    check(acts.some(a => a.startsWith('◂ Earlier encounter')), 'a place offers "◂ Earlier encounter" on several cameras too');
    check(acts.some(a => a.startsWith('Fix switch…|Swap the two identities in every view from')), 'its Fix says it swaps the two identities in every view');
    const steps = [];
    for (let i = 0; i < 3; i++) {
        await page.click(rowSel + ' .id-switch-back');
        steps.push(await page.evaluate(() => ({ f: window.__lucid.state.currentFrame, st: document.getElementById('statusText').textContent })));
    }
    const want = enc.slice().reverse().map(e => Math.max(0, e.start - 30));
    check(steps.every((x, i) => x.f === want[i] && /^Earlier encounter of id_0 ↔ id_1: /.test(x.st) && x.st.includes('(' + (i + 1) + ' back)')),
        `each press goes to 1 s before the next earlier encounter, latest first (${steps.map(x => x.f)}; want ${want.slice(0, 3)})`);
    for (let i = 3; i < MEET.length; i++) await page.click(rowSel + ' .id-switch-back');
    await page.click(rowSel + ' .id-switch-back');
    check(/^No earlier close encounter of id_0 and id_1 before this place/.test(await status()), 'past the first, it says there is none');
    // Fix from a frame before the place, after stepping back
    const from = want[1] + 20, before = await page.evaluate(() => window.__ids()), gBefore = await page.evaluate(() => window.__groups());
    await page.evaluate(async f => { const I = await import('/pose/initialization.js'); I.navigateToFrame(f); }, from);
    await page.click(rowSel + ' .id-switch-fix');
    const dlg = await page.evaluate(() => (document.querySelector('.id-switch-fix-modal') || {}).textContent || '');
    check(/before this place \(you went back to an earlier encounter\)/.test(dlg) && /in every camera view/.test(dlg),
        'the dialog: from the frame you are on, before the place, in every camera view');
    await page.click('#idSwitchFixOk');
    const after = await page.evaluate(() => window.__ids()), gAfter = await page.evaluate(() => window.__groups());
    const ids = new Set(before.flat(2).filter(v => v != null && v >= 0));
    const [x, y] = [...ids];
    let bad = 0, moved = 0;
    for (let f = 0; f < N; f++) for (let c = 0; c < 3; c++) for (let t = 0; t < 2; t++) {
        const v = before[f][c][t], w = f < from || v == null || v < 0 ? v : v === x ? y : v === y ? x : v;
        if (after[f][c][t] !== w) bad++; else if (w !== v) moved++;
    }
    let gBad = 0;
    for (let f = 0; f < N; f++) gBefore[f].forEach((g, i) => { const v = g[0], w = f < from ? v : v === x ? y : v === y ? x : v; if (gAfter[f][i][0] !== w) gBad++; });
    check(bad === 0 && moved > 0 && gBad === 0, `it swaps the pair from there to the end in all three views and the 3D groups (${moved} detections moved, ${bad} + ${gBad} wrong)`);

    console.log('\n3. The image check pre-judges the list on several cameras');
    const runImageCheck = (on) => page.evaluate(async (on) => {
        const Set_ = await import('/ui/settings.js');
        const def = Set_.getTrackingThresholdDefs().find(d => d.id === 'imageCheckPrejudgeMultiCamera');
        const untouched = Set_.getTrackingThreshold('imageCheckPrejudgeMultiCamera');
        Set_.setTrackingThresholds(Object.assign(Set_.getTrackingThresholds(), { imageCheckPrejudgeMultiCamera: on ? 1 : 0 }));
        const S = window.__lucid.state.session, st = S._idSwitch, R = await import('/ui/id-switch-review.js'), M = await import('/ui/id-switch-modal.js');
        const id = n => S.identities.find(i => i.name === n).id;
        // labels by place for this part: id_0 is the animal on the left, id_1 the one on the right
        for (const gs of S.instanceGroups.values()) for (const g of gs) { const c = g.instances.get('c0'); if (c) g.identityId = id(c.trackIdx ? 'id_1' : 'id_0'); }
        const row = (frame, look) => ({ frame, startFrame: frame, identityA: id('id_0'), identityB: id('id_1'), nameA: 'id_0', nameB: 'id_1', kind: 'onset',
            score: 0, look: [look], switchBackAt: null, cue: 'review' });
        st.results.review.flags = [row(0, 'videoStart'), Object.assign(row(605, 'crossing'), { startFrame: 595 }), Object.assign(row(1205, 'crossing'), { startFrame: 1195 }), row(2249, 'videoEnd')];
        st.fixes = []; st.stepBack = null; delete st.results.image;
        R.linkIdSwitchResults(st.results); M.refreshIdSwitchPanel(S);
        // a stand-in embedder on three cameras: each animal (known by its side) has a look per camera; from 0:40 the two
        // looks trade places, so the images say the labels change hands there
        let seed = 7, embedded = 0; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        const proto = ['c0', 'c1', 'c2'].map((c, ci) => [0, 1].map(a => Float32Array.from({ length: 16 }, (_, i) => Math.sin(3 * a + ci + i))));
        const createEmbedder = async () => ({ views: ['c0', 'c1', 'c2'], inFlight: 2, getEmbeddings: async (frame, items) => (embedded++, items).map(it => ['c0', 'c1', 'c2'].map((cam, ci) => {
            const inst = it.group.instances.get('c0'), a = inst ? inst.trackIdx : 0, look = frame >= 1200 ? 1 - a : a;
            return { camera: cam, vector: Float32Array.from(proto[ci][look], v => v + 0.3 * (r() - 0.5)) };
        })) });
        await M.runIdSwitchChecks({ image: true, inject: { createEmbedder, hasWebGPU: async () => true } });
        const res = st.results.image, rows = [...document.querySelectorAll('#idSwitchPanel .id-switch-row')];
        const text = f => { const el = rows.find(x => Number(x.dataset.frame) === f); return el ? el.querySelector('.id-switch-line2').textContent : ''; };
        return { ok: !!(res && res.ok), reason: res && res.reason, verdicts: res && res.prejudge ? res.prejudge.rows.map(p => p.verdict) : null,
                 at600: text(605), at1200: text(1205), atStart: text(0), atEnd: text(2249),
                 about: (document.querySelector('#idSwitchPanel .id-switch-about') || {}).textContent || '',
                 embedded, def: def && def.default, untouched };
    }, on);
    const off = await runImageCheck(false);
    check(off.def === 0 && off.untouched === 0, `the switch is off by default (default ${off.def}, before this test set it: ${off.untouched})`);
    check(off.ok && off.verdicts === null && !/images:/.test(off.at600 + off.at1200),
        `off by default: the image check gets no review rows and runs without a pre-judge (${off.reason || 'ok'}, ${JSON.stringify(off.verdicts)})`);
    check(/optional on several cameras/.test(off.about) && /pre-judge the review list on several cameras/.test(off.about),
        '…and About these flags says how to turn it on');
    const pj = await runImageCheck(true);
    // review rows are the only thing that makes checkImageSwitches embed every sample (backgroundHz = Infinity), and
    // its `prejudge` is non-null exactly when it got some; so null above means the background sampling was left alone.
    // (Here encounters every 10 s already put every sample in a scored window, so both runs embed the same frames.)
    check(off.embedded > 0 && off.embedded === pj.embedded,
        `…and so its sampling is unchanged: ${off.embedded} frames embedded, as with the pre-judge on this fully covered video`);
    check(pj.ok, `the image check ran (${pj.reason || 'ok'})`);
    check(JSON.stringify(pj.verdicts) === '["kept","swapped"]',
        `verdicts from the three cameras' pooled views: 0:20 looks right, 0:40 looks swapped (${JSON.stringify(pj.verdicts)})`);
    check(/images: look right/.test(pj.at600) && /images: look swapped/.test(pj.at1200), 'the rows say so');
    check(!/images/.test(pj.atStart) && !/images/.test(pj.atEnd), 'the check rows get no pre-judge');
    check(/across the cameras/.test(pj.about) && /On several cameras each animal's views at a moment are averaged first/.test(pj.about) && /about 1 swap in 4/.test(pj.about) && /a lead, not the answer/.test(pj.about),
        'About these flags: the multi-camera review list, how the cameras are combined, and what that measured (built-in model)');

    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (e) {
    console.error(e); fails++;
} finally {
    if (browser) await browser.close();
    await server.close();
}
console.log(fails ? `\n✗ ${fails} check(s) failed` : '\n✓ all checks passed');
process.exit(fails ? 1 : 0);
