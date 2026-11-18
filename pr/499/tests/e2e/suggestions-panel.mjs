/**
 * suggestions-panel.mjs — the Suggestions panel (`ui/suggestions-panel.js`) in
 * the real app, end to end.
 *
 * Fixture: one session, three camera views (top, side, back) of 300 frames,
 * a prediction (score 0.8) in every view-frame, and user instances in `side`
 * on frames 0 and 150.
 *
 *  1. The rail has a Suggestions panel; empty, it says so and Prev / Next are off.
 *  2. Generate (Stride, 5 per video, All videos in session) suggests 5 frames
 *     in each view. The table is grouped by view: the focused view first,
 *     tagged "current" and open, the others folded; frames read 1-based; the
 *     project is marked unsaved.
 *  3. Focusing another view moves its group first and names it in Target.
 *     Target "Current video" + Replace re-generates that view only (the others
 *     keep theirs); Add over all views skips frames already suggested.
 *  4. Labeled: the group header and the footer count user-labeled rows.
 *  5. Prev / Next and the `,` / `.` shortcuts walk the rows in display order,
 *     seek the row's view and frame, select it, and open its group; a row
 *     click does the same; a group header folds.
 *  6. Add current frame, Remove, Clear all (its dialog closes on Esc).
 *  7. Save → reopen: File ▸ Save (eager writer) writes `suggestions_json` with
 *     each view's video index; the eager reader, the lazy reader, and the
 *     streaming writer + lazy reader all bring the same list back, and the
 *     panel shows it. A project with no suggestions writes an empty
 *     `suggestions_json`, as before.
 *
 * Run: node tests/e2e/suggestions-panel.mjs
 *      KEEP_DIR=<dir> also writes the saved file there (for
 *      scripts/validate_slp_sleap_compat.py).
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const server = await startServer(repoRoot);
const PORT = server.port;
const FRAMES = 300;
const CAMS = ['top', 'side', 'back'];

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 400)));
    if (!c) fails++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let browser;
try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const t = m.text();
        if (/Failed to load resource|net::ERR|404/.test(t)) return;
        console.log('  [console.error]', t.slice(0, 300));
        fails++;
    });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });

    // ---- helpers in the page ----
    await page.evaluate(() => {
        window.__sg = {
            async panel() {
                const P = await import('/ui/suggestions-panel.js');
                P.refreshSuggestionsPanel({ force: true });
                const pill = document.getElementById('suggCount');
                const groups = [...document.querySelectorAll('#suggTable tr.sugg-group')].map(tr => ({
                    camera: tr.dataset.camera,
                    open: tr.getAttribute('aria-expanded') === 'true',
                    current: tr.classList.contains('sugg-current'),
                    tag: !!tr.querySelector('.sugg-tag'),
                    count: tr.querySelector('.sugg-group-count').textContent,
                }));
                const rows = [...document.querySelectorAll('#suggTable tr.sugg-item')].map(tr => ({
                    camera: tr.dataset.camera, frame: Number(tr.dataset.frame),
                    shown: tr.cells[0].textContent, labeled: !!tr.querySelector('.sugg-dot'),
                    score: tr.cells[3].textContent, selected: tr.classList.contains('selected'),
                }));
                const AS = await import('/ui/app-state.js');
                return {
                    pill: pill && pill.textContent, groups, rows,
                    status: document.getElementById('suggStatus').textContent,
                    empty: !document.getElementById('suggEmpty').hidden,
                    prevDisabled: document.getElementById('suggPrev').disabled,
                    currentName: document.getElementById('suggTargetCurrentName').textContent,
                    allCount: document.getElementById('suggTargetAllCount').textContent,
                    list: (AS.state.session && AS.state.session.suggestions || []).map(s => [s.camera, s.frameIdx, s.group]),
                    frame: AS.state.currentFrame,
                    view: AS.interactionManager && AS.interactionManager.lastInteractedView,
                    dirty: AS.state.isDirty,
                };
            },
            async focus(name) {
                const AS = await import('/ui/app-state.js');
                AS.interactionManager.lastInteractedView = name;
            },
            setNum(id, v) {
                const el = document.getElementById(id);
                el.value = String(v);
                el.dispatchEvent(new Event('change', { bubbles: true }));
            },
            async suggestionsJson(bytes) {
                const h5 = await import('h5wasm');
                const M = await h5.ready;
                const p = '/tmp/__sg_' + Math.random().toString(16).slice(2) + '.slp';
                M.FS.writeFile(p, bytes);
                const f = new h5.File(p, 'r');
                try {
                    const d = f.get('suggestions_json');
                    if (!d) return null;
                    const v = d.value;
                    return Array.from(v, x => JSON.parse(typeof x === 'string' ? x : new TextDecoder().decode(x)));
                } finally { f.close(); M.FS.unlink(p); }
            },
            async captureSave() {
                const SL = await import('/import-export/save-load.js');
                delete window.showSaveFilePicker;
                const captured = [];
                const realCOU = URL.createObjectURL.bind(URL);
                URL.createObjectURL = (blob) => { captured.push(blob); return realCOU(blob); };
                try { await SL.saveProjectSlp(); }
                finally { URL.createObjectURL = realCOU; }
                if (!captured.length) throw new Error('no blob');
                return new Uint8Array(await captured[captured.length - 1].arrayBuffer());
            },
        };
    });

    // ---- fixture ----
    await page.evaluate(async ({ FRAMES, CAMS }) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, FrameGroup, Session, UnlinkedInstance } = pd;
        const M = [[900, 0, 256], [0, 900, 256], [0, 0, 1]];
        const cameras = CAMS.map((n, i) => new Camera(n, M, [0, 0, 0, 0, 0], [0, i * 0.4, 0], [i * 10, 0, 0], [512, 512]));
        const skeleton = new Skeleton('skeleton', ['a', 'b'], [[0, 1]]);
        const s = new Session(cameras, skeleton, ['track_0'], 'Sugg');
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            s.addFrameGroup(fg);
            CAMS.forEach((cn, ci) => {
                fg.addUnlinkedInstance(cn, new UnlinkedInstance(new Instance([[100 + ci, 100 + f % 50], [120 + ci, 110]], 0, 'predicted', 0.8), cn));
                if (cn === 'side' && (f === 0 || f === 150)) {
                    fg.addUnlinkedInstance(cn, new UnlinkedInstance(new Instance([[200, 200], [210, 210]], 0, 'user', 0), cn));
                }
            });
        }
        AS.state.sessions = [s]; AS.state.session = s; AS.state.activeSessionIdx = 0;
        AS.state.views = CAMS.map(n => ({ name: n, videoWidth: 512, videoHeight: 512 }));
        AS.state.videoFiles = CAMS.map(n => ({ name: n + '.mp4', assignedCamera: n, videoPath: n + '.mp4' }));
        AS.state.totalFrames = FRAMES;
        AS.state.currentFrame = 0;
        AS.state.isDirty = false;
        AS.interactionManager.lastInteractedView = 'top';
        const rail = await import('/ui/panel-rail.js');
        rail.showPanelTab('tabSuggestions');
    }, { FRAMES, CAMS });

    // ---- 1. empty ----
    console.log('\n-- 1. the panel --');
    const railBtn = await page.$('.panel-rail-btn[data-tab="tabSuggestions"]');
    check(!!railBtn, 'the rail has a Suggestions button');
    check(await page.isVisible('#tabSuggestions #suggGenerate'), 'the panel is on screen with Generate Suggestions');
    let p = await page.evaluate(() => window.__sg.panel());
    check(p.pill === '0 suggestions' && p.empty && p.prevDisabled, 'empty: 0 suggestions, a hint, Prev off', p);
    check(p.currentName === 'top' && p.allCount === '(3)', 'Target names the focused view and counts the views', p);

    // ---- 2. generate over all views ----
    console.log('\n-- 2. Generate, all videos --');
    await page.evaluate(() => window.__sg.setNum('suggPerVideo', 5));
    await page.click('#suggGenerate');
    p = await page.evaluate(() => window.__sg.panel());
    check(p.pill === '15 suggestions', '5 per view x 3 views', p.pill);
    check(eq(p.groups.map(g => g.camera), ['top', 'side', 'back']), 'grouped by view, focused view first', p.groups);
    check(p.groups[0].open && p.groups[0].current && p.groups[0].tag && !p.groups[1].open && !p.groups[2].open,
        'the focused view is open and tagged current; the others are folded', p.groups);
    check(eq(p.rows.map(r => r.shown), ['1', '61', '121', '181', '241']), 'frames read 1-based', p.rows.map(r => r.shown));
    check(p.rows.every(r => r.camera === 'top' && r.score === '0.80'), 'rows show the mean prediction score', p.rows[0]);
    check(p.dirty === true, 'the project is marked unsaved');

    // ---- 3. focus + target ----
    console.log('\n-- 3. Target --');
    await page.evaluate(() => window.__sg.focus('back'));
    p = await page.evaluate(() => window.__sg.panel());
    check(p.groups[0].camera === 'back' && p.groups[0].open && p.groups[0].tag, 'focusing back moves its group first and opens it', p.groups);
    check(p.currentName === 'back', 'Target names back', p.currentName);
    await page.check('#suggTargetCurrent');
    await page.click('#suggModeReplace');
    await page.click('#suggGenerate');
    p = await page.evaluate(() => window.__sg.panel());
    const per = (q, c) => q.list.filter(s => s[0] === c).length;
    check(p.list.length === 15 && per(p, 'back') === 5 && per(p, 'top') === 5 && per(p, 'side') === 5,
        'Current video + Replace: back\'s 5 are replaced, the other views keep theirs', p.list);
    await page.check('#suggTargetAll');
    await page.click('#suggModeAdd');
    await page.click('#suggGenerate');
    p = await page.evaluate(() => window.__sg.panel());
    const backFrames = p.list.filter(s => s[0] === 'back').map(s => s[1]);
    check(p.list.length === 30 && backFrames.length === 10 && new Set(backFrames).size === 10,
        'All videos + Add: 5 more per view, none repeated', p.list.length);

    // ---- 4. labeled ----
    console.log('\n-- 4. Labeled --');
    const side = p.groups.find(g => g.camera === 'side');
    check(side && side.count === '1/10', 'side\'s header counts its labeled row (frame 1)', side);
    check(p.status === '1/30 labeled (3.3%)', 'the footer counts the whole session', p.status);

    // ---- 5. navigation ----
    console.log('\n-- 5. Prev / Next --');
    const order = (q) => q.groups.map(g => g.camera);
    // Start on a frame that is no suggestion, so Next starts from the top.
    await page.evaluate(async () => { (await import('/ui/app-state.js')).state.currentFrame = 7; });
    await page.click('#suggNext');
    p = await page.evaluate(() => window.__sg.panel());
    const firstBack = p.list.filter(s => s[0] === 'back')[0];
    check(p.view === 'back' && p.frame === firstBack[1], 'Next with nothing selected seeks the first row (back)', { view: p.view, frame: p.frame, firstBack });
    check(p.rows.filter(r => r.selected).length === 1 && p.rows.find(r => r.selected).frame === firstBack[1], 'and selects it');
    await page.click('#suggNext');
    p = await page.evaluate(() => window.__sg.panel());
    const secondBack = p.list.filter(s => s[0] === 'back')[1];
    check(p.frame === secondBack[1], 'Next again: the second row', p.frame);
    await page.click('#suggGenerate', { trial: true });   // no-op; keeps focus out of inputs
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('.');
    p = await page.evaluate(() => window.__sg.panel());
    const thirdBack = p.list.filter(s => s[0] === 'back')[2];
    check(p.frame === thirdBack[1], '"." is Next', p.frame);
    await page.keyboard.press(',');
    p = await page.evaluate(() => window.__sg.panel());
    check(p.frame === secondBack[1], '"," is Prev', p.frame);
    // From the first row, Prev wraps to the last row of the last group (side).
    await page.keyboard.press(',');
    await page.keyboard.press(',');
    p = await page.evaluate(() => window.__sg.panel());
    const lastSide = p.list.filter(s => s[0] === 'side').slice(-1)[0];
    check(p.view === 'side' && p.frame === lastSide[1], 'Prev from the first row wraps to the last (side)', { view: p.view, frame: p.frame });
    check(order(p)[0] === 'side' && p.groups[0].open, 'the view it lands in is now current: its group comes first, open', p.groups);
    // A row click in another group.
    await page.click('#suggCollapseAll');
    await page.click('#suggTable tr.sugg-group[data-camera="top"]');
    p = await page.evaluate(() => window.__sg.panel());
    check(p.groups.find(g => g.camera === 'top').open, 'a group header opens its group');
    const topRow = p.rows.filter(r => r.camera === 'top')[2];
    await page.click(`#suggTable tr.sugg-item[data-camera="top"][data-frame="${topRow.frame}"]`);
    p = await page.evaluate(() => window.__sg.panel());
    check(p.view === 'top' && p.frame === topRow.frame && p.rows.find(r => r.selected).frame === topRow.frame,
        'a row click seeks its view and frame and selects it', { view: p.view, frame: p.frame });
    await page.click('#suggTable tr.sugg-group[data-camera="top"]');
    p = await page.evaluate(() => window.__sg.panel());
    check(!p.groups.find(g => g.camera === 'top').open && !p.rows.some(r => r.camera === 'top'), 'a group header folds its group');
    await page.click('#suggExpandAll');
    p = await page.evaluate(() => window.__sg.panel());
    check(p.groups.every(g => g.open) && p.rows.length === 30, 'Expand all opens every group', p.groups);

    // ---- 6. edits ----
    console.log('\n-- 6. edits --');
    await page.click(`#suggTable tr.sugg-item[data-camera="top"][data-frame="${topRow.frame}"]`);
    await page.click('#suggRemove');
    p = await page.evaluate(() => window.__sg.panel());
    check(p.list.length === 29 && !p.list.some(s => s[0] === 'top' && s[1] === topRow.frame), 'Remove drops the selected row');
    await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        AS.interactionManager.lastInteractedView = 'side';
        AS.state.currentFrame = 150;
    });
    await page.click('#suggAddCurrent');
    p = await page.evaluate(() => window.__sg.panel());
    check(p.list.length === 30 && p.list.some(s => s[0] === 'side' && s[1] === 150), 'Add current frame adds (side, 150)');
    await page.click('#suggAddCurrent');
    p = await page.evaluate(() => window.__sg.panel());
    check(p.list.length === 30, 'adding it twice does nothing');
    await page.click('#suggClearAll');
    check(await page.isVisible('#planeDialog'), 'Clear all asks first');
    await page.keyboard.press('Escape');
    p = await page.evaluate(() => window.__sg.panel());
    check(!(await page.$('#planeDialog')) && p.list.length === 30, 'Esc closes the dialog and keeps the list');
    await page.click('#suggRemoveUnlabeled');
    p = await page.evaluate(() => window.__sg.panel());
    check(eq(p.list.map(s => s[0] + ':' + s[1]).sort(), ['side:0', 'side:150']), 'Remove unlabeled keeps the two labeled rows', p.list);
    await page.click('#suggClearAll');
    await page.click('#btnPlaneDialogConfirm');
    p = await page.evaluate(() => window.__sg.panel());
    check(p.list.length === 0 && p.empty, 'Clear all empties the list');
    await page.click('#suggAddLabeled');
    p = await page.evaluate(() => window.__sg.panel());
    check(eq(p.list, [['side', 0, 0], ['side', 150, 0]]), 'Add labeled frames adds every user-labeled view-frame', p.list);

    // ---- 7. save / reopen ----
    console.log('\n-- 7. save and reopen --');
    // A known list: stride 4 over every view, plus the two labeled side frames.
    await page.evaluate(() => window.__sg.setNum('suggPerVideo', 4));
    await page.click('#suggGenerate');
    p = await page.evaluate(() => window.__sg.panel());
    const expected = p.list;
    check(expected.length === 14, 'the list to save: 14 suggestions', expected.length);

    const saved = await page.evaluate(async (CAMS) => {
        try {
            window.__sgEager = await window.__sg.captureSave();
            return { json: await window.__sg.suggestionsJson(window.__sgEager) };
        } catch (e) { return { err: String(e && e.stack || e).slice(0, 500) }; }
    }, CAMS);
    check(!saved.err, 'File ▸ Save completed', saved.err);
    const want = expected.map(s => ({ video: String(CAMS.indexOf(s[0])), frame_idx: s[1], group: 0 }));
    check(saved.json && eq(saved.json, want), 'suggestions_json: one entry per row, on its view\'s video, group 0', saved.json && saved.json.slice(0, 3));
    if (process.env.KEEP_DIR) {
        const b = await page.evaluate(() => Array.from(window.__sgEager));
        fs.mkdirSync(process.env.KEEP_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.KEEP_DIR, 'suggestions.slp'), Buffer.from(b));
    }

    async function load(kind, globalName) {
        await page.evaluate(({ kind, g }) => {
            window.__loadDone = false;
            (async () => {
                try {
                    if (kind === 'eager') {
                        const imp = await import('/import-export/slp-import.js');
                        await imp.handleLoadSlpFile(new File([window[g]], g + '.slp'));
                    } else {
                        const sl = await import('/loading/session-loader.js');
                        await sl.handleLoadProjectSlpLazy(new File([window[g]], g + '.slp'));
                    }
                    window.__loadDone = true;
                } catch (e) { window.__loadDone = 'ERR ' + String(e && e.stack || e).slice(0, 500); }
            })();
        }, { kind, g: globalName });
        for (let i = 0; i < 400; i++) {
            const s = await page.evaluate(() => {
                const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || '') && x.offsetParent);
                if (b) b.click();
                return { done: window.__loadDone, prompt: !!document.getElementById('videoSelectOverlay') };
            });
            if (s.prompt) await page.keyboard.press('Escape');
            if (s.done) return s.done;
            await page.waitForTimeout(250);
        }
        return 'timeout';
    }

    let r = await load('eager', '__sgEager');
    check(r === true, 'eager reopen completed', r);
    p = await page.evaluate(async () => {
        const rail = await import('/ui/panel-rail.js');
        rail.showPanelTab('tabSuggestions');
        return window.__sg.panel();
    });
    check(eq(p.list, expected), 'eager reopen: the same suggestions, in order', p.list);
    check(p.pill === '14 suggestions' && p.status === '2/14 labeled (14.3%)', 'and the panel shows them, labeled rows counted', { pill: p.pill, status: p.status });

    r = await load('lazy', '__sgEager');
    check(r === true, 'lazy reopen completed', r);
    p = await page.evaluate(() => window.__sg.panel());
    check(eq(p.list, expected), 'lazy reopen: the same suggestions', p.list);
    check(p.status === '2/14 labeled (14.3%)', 'labeled is read from the store for frames not resident', p.status);
    const lazyScores = p.rows.map(r => r.score);
    check(lazyScores.length > 0 && lazyScores.every(s => s === '0.80'), 'the store gives the mean score', lazyScores);

    const stream = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        const SL = await import('/import-export/save-load.js');
        try {
            window.__sgStream = await SL.saveAllSessionsStreaming(AS.state.sessions);
            return { json: await window.__sg.suggestionsJson(window.__sgStream) };
        } catch (e) { return { err: String(e && e.stack || e).slice(0, 500) }; }
    });
    check(!stream.err, 'the streaming writer completed', stream.err);
    check(stream.json && eq(stream.json, want), 'streaming writer: the same suggestions_json', stream.json && stream.json.slice(0, 3));
    r = await load('lazy', '__sgStream');
    check(r === true, 'lazy reopen of the streamed file completed', r);
    p = await page.evaluate(() => window.__sg.panel());
    check(eq(p.list, expected), 'streamed file reopens with the same suggestions', p.list);

    // A project with none still writes the empty dataset it always did.
    const none = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js');
        AS.state.session.suggestions = [];
        window.__sgNone = await window.__sg.captureSave();
        return window.__sg.suggestionsJson(window.__sgNone);
    });
    check(Array.isArray(none) && none.length === 0, 'no suggestions: an empty suggestions_json', none);
} catch (e) {
    console.log('  ✗ threw: ' + (e && e.stack || e));
    fails++;
} finally {
    if (browser) await browser.close();
    await server.close();
}

console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
