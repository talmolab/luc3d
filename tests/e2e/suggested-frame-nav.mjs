/**
 * suggested-frame-nav.mjs — Previous / Next suggested frame (Opt+Shift+← / →,
 * `ui/suggested-frame-nav.js`): the frames the session's suggestions name, every
 * view at once, in the list's order, and their ticks on the seekbar.
 *
 * Fixture: one session, three camera views (top, side, back) of 60 frames with a
 * prediction in every view-frame, and suggestions ranked as a relabel scan writes
 * them, not in frame order: 30 in back, top and side; 5 in side and top; 44 on a
 * camera the session no longer has; 17 in top; 5 again in back; 42 in side. The
 * session's suggested frames are therefore [30, 5, 17, 42].
 *
 *  1. The seekbar ticks those frames. The keys step in that order, each frame once,
 *     and the status line says "Suggestion k of n: frame F". Steps stop at both
 *     ends and say so. Plain → still steps one frame, and the keys step no frame of
 *     their own (this is the video-less path).
 *  2. Off a suggested frame, a step carries on from the one last stepped to: Next to
 *     the one after it, Previous back to it.
 *  3. The Suggestions panel's Prev / Next (`,` / `.`) go on from the focused view's
 *     row on the frame a step landed on.
 *  4. An edit in the panel (Add current frame) moves the ticks with it.
 *  5. A suggestion on a frame the session cannot show is named, not landed on.
 *  6. The two shortcuts are dispatched catalog entries, on keys no other dispatched
 *     action uses. Stepping is not an edit (the project stays saved).
 *  7. The same project saved, then opened as a session folder with its videos (60
 *     frames, decoded): the suggestions come back in order, the ticks show, the keys
 *     land on each frame, and the seekbar's thumb follows.
 *
 * Run: node tests/e2e/suggested-frame-nav.mjs
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const server = await startServer(repoRoot);
const PORT = server.port;
const FRAMES = 60;
const CAMS = ['top', 'side', 'back'];
const CLIP = path.join(repoRoot, 'tests', 'fixtures', 'barcode-60', 'barcode-60.mp4');   // 60 frames, 256 x 32
const RANKED = [['back', 30], ['top', 30], ['side', 30], ['side', 5], ['top', 5], ['gone', 44],
    ['top', 17], ['back', 5], ['side', 42]];
const NEXT = 'Alt+Shift+ArrowRight', PREV = 'Alt+Shift+ArrowLeft';

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : ' — ' + JSON.stringify(extra).slice(0, 400)));
    if (!c) fails++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function newAppPage(browser) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });
    return page;
}

const view = (page) => page.evaluate(() => ({
    frame: window.__lucid.state.currentFrame,
    status: document.getElementById('statusText').textContent,
    ticks: [...document.querySelectorAll('#seekbarSuggestionMarks .seekbar-suggestion-mark')].map(m => Number(m.dataset.frame)).sort((p, q) => p - q),
    thumb: parseFloat(document.getElementById('seekbarThumb').style.left),
    total: window.__lucid.state.totalFrames,
    dirty: !!window.__lucid.state.isDirty,
}));

/** Press a key on the page itself (nothing focused), wait for `frame` (a decode is async), then read where it went. */
async function stepTo(page, key, frame) {
    await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
    await page.keyboard.press(key);
    await page.waitForFunction(f => window.__lucid.state.currentFrame === f, frame, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(50);   // a stray extra step would show by now
    return view(page);
}

async function goTo(page, frame) {
    await page.evaluate(async (f) => { (await import('/pose/initialization.js')).navigateToFrame(f); }, frame);
    await page.waitForFunction(f => window.__lucid.state.currentFrame === f, frame, { timeout: 20000 }).catch(() => {});
}

/** Steps 1 and 2 on [30, 5, 17, 42] from frame 0. `video`: the thumb check too. */
async function stepRanks(page, tag, video) {
    await goTo(page, 0);
    let v;
    for (const [frame, k] of [[30, 1], [5, 2], [17, 3], [42, 4]]) {
        v = await stepTo(page, NEXT, frame);
        check(v.frame === frame && v.status === `Suggestion ${k} of 4: frame ${frame + 1}`, `${tag}: Next → frame ${frame} (rank ${k})`, [v.frame, v.status]);
    }
    if (video) {
        // A seek sets the frame before it decodes and moves the thumb once it has, so
        // a step pressed while the last one still decodes leaves the thumb on that
        // frame until the new one is drawn (CI's runner read 17 here). Wait for it.
        const want = 100 * 42 / (v.total - 1);
        await page.waitForFunction(t => Math.abs(parseFloat(document.getElementById('seekbarThumb').style.left) - t) < 0.01,
            want, { timeout: 20000 }).catch(() => {});
        v = await view(page);
        check(Math.abs(v.thumb - want) < 0.01, `${tag}: the seekbar thumb is on frame 42`, [v.thumb, v.total]);
    }
    v = await stepTo(page, NEXT, 42);
    check(v.frame === 42 && v.status === 'No next suggestion: 4 of 4 is the last', `${tag}: Next at the last stays there and says so`, [v.frame, v.status]);
    v = await stepTo(page, PREV, 17);
    check(v.frame === 17 && v.status === 'Suggestion 3 of 4: frame 18', `${tag}: Previous → rank 3`, [v.frame, v.status]);
    await stepTo(page, PREV, 5);
    await stepTo(page, PREV, 30);
    v = await stepTo(page, PREV, 30);
    check(v.frame === 30 && v.status === 'No previous suggestion: 1 of 4 is the first', `${tag}: Previous at the first stays there and says so`, [v.frame, v.status]);

    await stepTo(page, NEXT, 5);                                   // rank 2
    v = await stepTo(page, 'ArrowRight', 6);
    check(v.frame === 6, `${tag}: → still steps one frame`, v.frame);
    v = await stepTo(page, NEXT, 17);
    check(v.frame === 17 && v.status === 'Suggestion 3 of 4: frame 18', `${tag}: off rank 2, Next → rank 3`, [v.frame, v.status]);
    await goTo(page, 20);
    v = await stepTo(page, PREV, 17);
    check(v.frame === 17 && v.status === 'Suggestion 3 of 4: frame 18', `${tag}: off rank 3, Previous → back to rank 3`, [v.frame, v.status]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suggested-frame-nav-'));
let browser;
try {
    browser = await launchBrowser();
    const page = await newAppPage(browser);
    await page.evaluate(async ({ FRAMES, CAMS, RANKED }) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, FrameGroup, Session, UnlinkedInstance } = pd;
        const M = [[300, 0, 128], [0, 300, 16], [0, 0, 1]];
        const cameras = CAMS.map((n, i) => new Camera(n, M, [0, 0, 0, 0, 0], [0, i * 0.4, 0], [i * 10, 0, 0], [256, 32]));
        const s = new Session(cameras, new Skeleton('skeleton', ['a', 'b'], [[0, 1]]), ['track_0'], 'Ranked');
        for (let f = 0; f < FRAMES; f++) {
            const fg = new FrameGroup(f);
            s.addFrameGroup(fg);
            CAMS.forEach((cn, ci) => fg.addUnlinkedInstance(cn,
                new UnlinkedInstance(new Instance([[100 + ci, 10 + f % 10], [120 + ci, 20]], 0, 'predicted', 0.8), cn)));
        }
        s.suggestions = RANKED.map(([camera, frameIdx]) => ({ camera, frameIdx, group: 0 }));
        AS.state.sessions = [s]; AS.state.session = s; AS.state.activeSessionIdx = 0;
        AS.state.views = CAMS.map(n => ({ name: n, videoWidth: 256, videoHeight: 32 }));
        AS.state.videoFiles = CAMS.map(n => ({ name: n + '.mp4', assignedCamera: n, videoPath: 'videos/' + n + '.mp4' }));
        AS.state.totalFrames = FRAMES;
        AS.state.currentFrame = 0;
        AS.state.isDirty = false;
        AS.interactionManager.lastInteractedView = 'top';
        (await import('/ui/info-panel.js')).updateInfoPanel();
        (await import('/ui/panel-rail.js')).showPanelTab('tabSuggestions');
    }, { FRAMES, CAMS, RANKED });

    console.log('\n-- 1, 2. the keys, without video --');
    let v = await view(page);
    check(eq(v.ticks, [5, 17, 30, 42]), "the seekbar ticks the session's suggested frames, not the other camera's", v.ticks);
    await stepRanks(page, 'no video', false);

    console.log('\n-- 3. the panel goes on from a step --');
    // On frame 17, focused view top: the panel's selected row is top's 17.
    const sel = await page.evaluate(() => [...document.querySelectorAll('#suggTable tr.sugg-item.selected')].map(tr => [tr.dataset.camera, Number(tr.dataset.frame)]));
    check(eq(sel, [['top', 17]]), "the panel selects the focused view's row on the frame stepped to", sel);
    // The panel's rows, focused view first: top 30, 5, 17; side 30, 5, 42; back 30, 5; gone 44.
    await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
    await page.keyboard.press('.');
    await page.waitForFunction(() => window.__lucid.state.currentFrame === 30, null, { timeout: 10000 }).catch(() => {});
    const after = await page.evaluate(async () => ({ frame: window.__lucid.state.currentFrame,
        view: (await import('/ui/app-state.js')).interactionManager.lastInteractedView }));
    check(after.frame === 30 && after.view === 'side', "the panel's Next goes on from there: side's 30", after);
    v = await stepTo(page, NEXT, 5);
    check(v.frame === 5 && v.status === 'Suggestion 2 of 4: frame 6', 'and Next suggested frame from there goes to rank 2', [v.frame, v.status]);

    console.log('\n-- 4. an edit moves the ticks --');
    await goTo(page, 50);
    await page.click('#suggAddCurrent');
    v = await view(page);
    check(eq(v.ticks, [5, 17, 30, 42, 50]), "Add current frame ticks frame 50 too", v.ticks);
    v = await stepTo(page, NEXT, 50);
    check(v.status === 'No next suggestion: 5 of 5 is the last', 'and it is the last suggestion, the one listed last', v.status);
    await page.evaluate(async () => {   // back to the fixture's list
        const AS = await import('/ui/app-state.js');
        AS.state.session.suggestions = AS.state.session.suggestions.filter(s => s.frameIdx !== 50);
        AS.state.isDirty = false;
        (await import('/ui/info-panel.js')).updateInfoPanel();
    });

    console.log('\n-- 5. a frame the session cannot show --');
    await goTo(page, 17);
    await page.evaluate(() => { window.__lucid.state.totalFrames = 25; });
    v = await stepTo(page, NEXT, 17);
    check(v.frame === 17 && v.status === "Suggestion 4 of 4 is frame 43, past this session's last frame (25)",
        'past the last frame: named, not landed on', [v.frame, v.status]);
    await page.evaluate(() => { window.__lucid.state.totalFrames = 60; });

    console.log('\n-- 6. the catalog --');
    const cat = await page.evaluate(async () => {
        const s = await import('/ui/settings.js');
        const acts = s.getActions();
        const mine = acts.filter(a => a.id === 'prevSuggestedFrame' || a.id === 'nextSuggestedFrame');
        const keys = new Set(mine.map(a => a.binding));
        return {
            mine: mine.map(a => [a.id, a.category, a.binding, a.dispatched]),
            clash: acts.filter(a => a.dispatched && !mine.includes(a) && keys.has(a.binding)).map(a => a.id),
            dirty: !!window.__lucid.state.isDirty,
        };
    });
    check(eq(cat.mine, [['prevSuggestedFrame', 'Navigation', 'Alt+Shift+ArrowLeft', true], ['nextSuggestedFrame', 'Navigation', 'Alt+Shift+ArrowRight', true]]),
        'both shortcuts are dispatched Navigation entries', cat.mine);
    check(cat.clash.length === 0, 'no other dispatched action uses their keys', cat.clash);
    check(cat.dirty === false, 'stepping is not an edit: the project is still saved');

    // The project as a session folder: labels.slp + videos/<camera>.mp4.
    const b64 = await page.evaluate(async () => {
        const SL = await import('/import-export/save-load.js');
        delete window.showSaveFilePicker;
        const captured = [];
        const realCOU = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => { captured.push(blob); return realCOU(blob); };
        try { await SL.saveProjectSlp(); } finally { URL.createObjectURL = realCOU; }
        const u = new Uint8Array(await captured[captured.length - 1].arrayBuffer());
        let s = '';
        for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
        return btoa(s);
    });
    await page.close();
    const folder = path.join(tmp, 'Ranked');
    fs.mkdirSync(path.join(folder, 'videos'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'labels.slp'), Buffer.from(b64, 'base64'));
    for (const cn of CAMS) fs.copyFileSync(CLIP, path.join(folder, 'videos', cn + '.mp4'));

    console.log('\n-- 7. saved, then opened as a session folder with its videos --');
    const p2 = await newAppPage(browser);
    p2.once('filechooser', fc => fc.setFiles(folder));
    await p2.evaluate(async () => { await (await import('/loading/session-loader.js')).handleLoadSessionFolderSingleSlp(); });
    await p2.waitForFunction(n => window.__lucid.state.views.length === n && window.__lucid.state.views.every(x => x.decoder), CAMS.length, { timeout: 60000 });
    const back = await p2.evaluate(() => (window.__lucid.state.session.suggestions || []).map(s => [s.camera, s.frameIdx]));
    check(eq(back, RANKED.filter(([c]) => c !== 'gone')), "the suggestions come back in the file's order (the other camera's is not saved)", back);
    v = await view(p2);
    check(v.total === FRAMES && eq(v.ticks, [5, 17, 30, 42]), '60 frames from the videos, and the ticks', v);
    await p2.evaluate(async () => { (await import('/ui/app-state.js')).interactionManager.lastInteractedView = 'top'; });
    await stepRanks(p2, 'video', true);
    await p2.close();
} catch (e) {
    console.log('  ✗ threw: ' + (e && e.stack || e));
    fails++;
} finally {
    if (browser) await browser.close();
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
