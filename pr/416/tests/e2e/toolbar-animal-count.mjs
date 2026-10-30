/**
 * toolbar-animal-count.mjs — the Track group's Animals field (`#tbNumAnimals`),
 * and the animal count it edits being saved with the project.
 *
 * The animal count every tracking run uses was asked for once, in a native
 * `prompt()` on the first Track Frame / Track All (now the first-use dialog,
 * ui/track-setup-modal.js, which also shows the node weights), and then shown nowhere: a
 * user who forgot what they typed had no way to find out short of re-typing it
 * into the Track Frame Range dialog. The field shows it and edits it, and the
 * count now lives on the SESSION (`Session.numAnimals`), saved in the `.slp`.
 *
 * Asserted, through the real app:
 *  1. It sits in the Track menu (hover "Track"), below the run items (This
 *     frame / All frames / Frame range…), and starts blank, with an "auto"
 *     placeholder.
 *  2. The first-use dialog still opens once, and its answer appears in the
 *     field. A second run does not ask.
 *  3. Typing a count and pressing Enter sets it, hands focus back (so the
 *     shortcuts work again), marks the project unsaved (it is project state
 *     now), and is what Track All uses — read off the summary box's "for N
 *     animals", with N chosen to differ from what auto-detect would find.
 *  4. A bad entry (0, 2.5, -3, a stray "e") is refused and the field reverts,
 *     rather than being read as blank = auto-detect, and changes nothing.
 *  5. Esc throws away what was typed, and changes nothing.
 *  6. App shortcuts do not fire while typing in it — `p`, which is first
 *     shown to toggle Predictions from outside the field.
 *  7. Blank is auto-detect, and it is an ANSWER: the dialog does not come back
 *     on the next run. Before this a blank answer re-prompted on every run.
 *     Checked on a fresh page, through the dialog itself.
 *  8. The Track Frame Range dialog opens with the field's count and writes its
 *     own back into the field.
 *  9. The count is PER SESSION and the field follows the active one: a second
 *     session starts unanswered (blank, and Track Frame asks — pre-filled
 *     with the last count given, so the same animals are one Enter), and
 *     switching back shows the first session's count again.
 * 10. Saved with the project: a count typed into the field survives a real
 *     save, a fresh page and a reopen through File > Load Project...
 *     (`handleLoadProject`). The reopened project is NOT dirty, shows the count
 *     in the field, and Track All runs with it without asking.
 *
 * The 1440px fit is asserted by toolbar-3d-toggle-button.mjs §7. The format
 * itself (both writers, "auto", nothing written for a never-asked session) is
 * pinned by visibility-settings-roundtrip.mjs §7–9.
 *
 * Negative controls, run once: with the dialog gated on the count being null
 * again (the old rule) §7 and §8 fail; without the `badInput` guard the stray
 * "e" is read as auto-detect and §4 and §5 fail; with `numAnimals` dropped
 * from the metadata writer §10 fails (the reopened session asks).
 *
 * Run: node tests/e2e/toolbar-animal-count.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8343);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const NF = 30;

// A fresh app with a trackable two-animal session installed (the
// track-marks-dirty.mjs fixture). Every first-use dialog (the animal count +
// node weights) is answered from `answers` in order — Cancel once they run out
// — and recorded with its text and pre-filled count, so one that should not
// open is caught (`shown`). No native dialog should open at all any more.
async function openApp(browser, answers, opts) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('dialog', async d => {
        console.log('  [unexpected native dialog]', d.message()); fails++;
        await d.dismiss();
    });
    await page.addInitScript((answers) => {
        window.__setupDialogs = [];
        new MutationObserver(() => {
            const modal = document.querySelector('.track-setup-modal');
            if (!modal || modal.dataset.seen) return;
            modal.dataset.seen = '1';
            const input = modal.querySelector('#trackSetupAnimals');
            window.__setupDialogs.push({ message: modal.textContent, def: input.value });
            if (!answers.length) { modal.querySelector('#trackSetupCancel').click(); return; }
            input.value = answers.shift();
            input.dispatchEvent(new Event('input', { bubbles: true }));
            modal.querySelector('#trackSetupContinue').click();
        }).observe(document, { childList: true, subtree: true });
    }, answers);
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 30000 });
    await page.evaluate(async ({ NF, install }) => {
        const { Skeleton, Camera, Instance, FrameGroup, Session } = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const settings = await import('/ui/settings.js');
        const rendering = await import('/ui/rendering.js');
        // The automatic ID-switch checks after Track All are not what this
        // file is about, and they only add time.
        settings.setTrackingThresholds(Object.assign({}, settings.getTrackingThresholds(),
            { autoSwitchCheck: 0, autoImageSwitchCheck: 0 }));
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const ANIMALS = [[[10, 5, 50], [11, 6, 51]], [[-10, 5, 50], [-9, 6, 51]]];
        window.__CAMS = ['cam0', 'cam1', 'cam2'];
        window.__mkSession = (name) => {
            const cams = window.__CAMS.map((n, i) =>
                new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.15 * i, 0], [10 * i, 0, 0], [640, 480]));
            const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
            const session = new Session(cams, skel, ['track_0', 'track_1'], name);
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
        // Make sessions[idx] the active one the way every load path and the
        // session switch end: assign the state, then draw.
        window.__activate = (sessions, idx) => {
            AS.state.sessions = sessions;
            AS.state.activeSessionIdx = idx;
            AS.state.session = sessions[idx];
            AS.state.totalFrames = sessions[idx].numFrames;
            AS.state.currentFrame = 0;
            rendering.drawAllOverlays(0);
        };
        if (install) window.__activate([window.__mkSession('AnimalCount')], 0);
    }, { NF, install: !(opts && opts.empty) });
    return { page };
}

// Every first-use dialog this app's page has opened so far.
const shown = (app) => app.page.evaluate(() => window.__setupDialogs.slice());

const read = (page) => page.evaluate(async () => {
    const tracker = await import('/pose/tracker.js');
    const f = document.getElementById('tbNumAnimals');
    const s = window.__lucid.state;
    return {
        value: f.value,
        count: tracker.getTrackerNumAnimals(),
        stored: s.session ? s.session.numAnimals : undefined,
        dirty: s.isDirty === true,
        focused: document.activeElement === f,
        status: document.getElementById('statusText').textContent,
    };
});

const clean = (page) => page.evaluate(async () => (await import('/import-export/save-load.js')).clearDirty());

// Replace the field's contents the way a user would, then press `key`.
async function typeInto(page, text, key) {
    await page.hover('#tbTrackAll'); await page.click('#tbNumAnimals');   // in the Track menu
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    if (text) await page.keyboard.type(text);
    if (key) await page.keyboard.press(key);
}

// Track All through the real button; returns the summary's "for N animals".
async function trackAllAnimalsRow(page) {
    await page.click('#tbTrackAll');
    await page.waitForSelector('#trackSummaryOverlay', { timeout: 60000 });
    const row = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#trackSummaryOverlay *'))
            .map(e => e.textContent).find(t => /^for \d+ animals?/.test(t)) || '');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#trackSummaryOverlay', { state: 'detached' });
    return row;
}

let browser;
try {
    browser = await chromium.launch();

    // ------------------------------------------------------------ 1. placement
    const A = await openApp(browser, ['4']);
    const page = A.page;
    const hiddenBefore = !(await page.locator('#tbNumAnimals').isVisible());
    await page.hover('#tbTrackAll');
    await page.waitForTimeout(200);
    const shownOnHover = await page.locator('#tbNumAnimals').isVisible();
    const geo = await page.evaluate(() => {
        const f = document.getElementById('tbNumAnimals');
        const label = f.closest('label');
        const menu = document.querySelector('#trackDropdown .tri-dropdown-menu');
        const range = document.getElementById('tbTrackFrameRange');
        return {
            inTrackMenu: !!menu && menu.contains(label),
            belowRunItems: range.getBoundingClientRect().bottom <= label.getBoundingClientRect().top,
            labelText: label.textContent.trim(),
            placeholder: f.placeholder,
            value: f.value,
        };
    });
    console.log('1. placement');
    check(hiddenBefore && shownOnHover, 'the field is tucked in the Track menu and shows on hover');
    check(geo.inTrackMenu && geo.belowRunItems, 'below This frame / All frames / Frame range…');
    check(geo.labelText === 'Animals', `labelled "${geo.labelText}"`);
    check(geo.value === '' && geo.placeholder === 'auto', `starts blank with an "auto" placeholder (value "${geo.value}")`);

    // ------------------------------------------------- 2. the dialog fills it
    console.log('2. the first-use dialog');
    await page.hover('#tbTrackAll'); await page.click('#tbTrackFrame');   // This frame, in the Track menu
    let r = await read(page);
    let dl = await shown(A);
    check(dl.length === 1 && /Number of animals/.test(dl[0].message),
        `Track Frame asks once on first use (${dl.length} dialog(s))`);
    check(r.count === 4 && r.value === '4', `the dialog's answer shows in the field ("${r.value}")`);
    await page.hover('#tbTrackAll'); await page.click('#tbTrackFrame');   // This frame, in the Track menu
    dl = await shown(A);
    check(dl.length === 1, `a second Track Frame does not ask (${dl.length} dialog(s))`);

    // ------------------------------------------ 3. typing a count, Track All
    console.log('3. typing a count');
    await clean(page);
    await typeInto(page, '3', 'Enter');
    r = await read(page);
    check(r.count === 3 && r.value === '3' && r.stored === 3, `Enter sets the session's count to 3 (stored ${r.stored})`);
    check(!r.focused, 'Enter hands focus back, so the shortcuts work again');
    check(r.dirty, 'changing the count marks the project unsaved');
    // Three, where auto-detect would find two: the summary can only say three
    // if the typed count reached the run.
    const animalsRow = await trackAllAnimalsRow(page);
    check(/^for 3 animals/.test(animalsRow), `Track All runs with the typed count ("${animalsRow}")`);
    check((await shown(A)).length === 1, 'Track All does not ask either');

    // ----------------------------------------------------- 4. bad entries
    console.log('4. bad entries revert');
    await clean(page);
    for (const bad of ['0', '2.5', '-3', 'e']) {
        await typeInto(page, bad, 'Enter');
        r = await read(page);
        check(r.count === 3 && r.value === '3' && /whole number/.test(r.status),
            `"${bad}" is refused and the field reverts to 3 (value "${r.value}", count ${r.count})`);
    }
    check(!(await read(page)).dirty, 'and none of them marks the project unsaved');

    // --------------------------------------------------------- 5. Esc
    console.log('5. Esc');
    await typeInto(page, '7', 'Escape');
    r = await read(page);
    check(r.count === 3 && r.value === '3' && !r.focused && !r.dirty,
        `Esc discards "7", releases focus and changes nothing (value "${r.value}")`);

    // ----------------------------------------------- 6. shortcuts held off
    console.log('6. shortcuts');
    const pred = () => page.evaluate(() => document.getElementById('visPredicted').checked);
    // `p` really is a shortcut from outside the field, or the check below
    // would pass for nothing.
    const predBefore = await pred();
    await page.mouse.click(400, 300);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('p');
    check((await pred()) !== predBefore, '"p" outside the field toggles Predictions');
    await page.keyboard.press('p');
    await page.hover('#tbTrackAll'); await page.click('#tbNumAnimals');   // in the Track menu
    await page.keyboard.press('p');
    check((await pred()) === predBefore, '"p" typed in the field does not toggle Predictions');
    await page.keyboard.press('Escape');

    // ---------------------------------------------------- 7. blank = auto
    console.log('7. blank is auto-detect');
    await typeInto(page, '', 'Enter');
    r = await read(page);
    check(r.count === null && r.value === '' && r.stored === 'auto',
        `clearing the field sets auto-detect (stored ${JSON.stringify(r.stored)})`);
    await page.hover('#tbTrackAll'); await page.click('#tbTrackFrame');   // This frame, in the Track menu
    check((await shown(A)).length === 1, 'a cleared field does not bring the dialog back');
    await A.page.close();

    // A blank ANSWER in the dialog counts as an answer too.
    const B = await openApp(browser, ['', '2']);
    await B.page.hover('#tbTrackAll'); await B.page.click('#tbTrackFrame');   // This frame, in the Track menu
    await B.page.hover('#tbTrackAll'); await B.page.click('#tbTrackFrame');   // This frame, in the Track menu
    r = await read(B.page);
    dl = await shown(B);
    check(dl.length === 1, `a blank answer in the dialog is not asked again (${dl.length} dialog(s))`);
    check(r.count === null && r.value === '', 'and the field shows auto-detect');

    // --------------------------------------- 8. Track Frame Range dialog
    console.log('8. Track Frame Range dialog');
    await typeInto(B.page, '5', 'Enter');
    await B.page.evaluate(() => document.getElementById('tbTrackFrameRange').click());
    await B.page.waitForSelector('#trackRangeAnimals');
    const pre = await B.page.inputValue('#trackRangeAnimals');
    check(pre === '5', `the dialog opens with the field's count ("${pre}")`);
    await B.page.fill('#trackRangeAnimals', '6');
    await B.page.click('#trackRangeContinue');
    await B.page.waitForSelector('#trackRangeAnimals', { state: 'detached' });
    await B.page.waitForFunction(() => document.getElementById('tbNumAnimals').value === '6', null, { timeout: 5000 })
        .catch(() => {});
    r = await read(B.page);
    check(r.count === 6 && r.value === '6', `its count is written back into the field ("${r.value}")`);
    check((await shown(B)).length === 1, 'and the first-use dialog does not stack on top of it');

    // ------------------------------------------- 9. one count per session
    console.log('9. per session');
    await B.page.evaluate(() => {
        const first = window.__lucid.state.session;
        window.__two = [first, window.__mkSession('Second')];
        window.__activate(window.__two, 1);
    });
    r = await read(B.page);
    check(r.value === '' && r.stored === null, `a second session starts unanswered, and the field shows it (value "${r.value}")`);
    await B.page.hover('#tbTrackAll'); await B.page.click('#tbTrackFrame');   // This frame, in the Track menu
    dl = await shown(B);
    check(dl.length === 2, `so Track Frame asks for it (${dl.length} dialog(s))`);
    check(dl.length === 2 && dl[1].def === '6',
        `pre-filled with the last count given ("${dl[1] && dl[1].def}")`);
    r = await read(B.page);
    check(r.stored === 2 && r.value === '2', `the answer is the second session's (stored ${r.stored})`);
    await B.page.evaluate(() => window.__activate(window.__two, 0));
    r = await read(B.page);
    check(r.stored === 6 && r.value === '6', `switching back shows the first session's count again (value "${r.value}")`);
    await B.page.close();

    // --------------------------------------- 10. saved with the project
    console.log('10. saved with the project');
    const C = await openApp(browser, []);
    await typeInto(C.page, '5', 'Enter');
    const bytes = await C.page.evaluate(async () => {
        const fileio = await import('/import-export/file-io.js');
        const s = window.__lucid.state.session;
        const views = window.__CAMS.map(n => ({ name: n, videoWidth: 640, videoHeight: 480, frameCount: 60 }));
        const videoFiles = window.__CAMS.map(n => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const labels = fileio.buildSlpLabelsAllViews(s, views, videoFiles);
        return Array.from(await window.SleapIO.saveSlpToBytes(labels));
    });
    await C.page.close();

    // A NEW page: nothing in memory, so whatever comes back came from the file.
    // Reopened the way a user reopens a project — File > Load Project...
    const D = await openApp(browser, [], { empty: true });
    await D.page.evaluate((arr) => {
        window.__loadDone = false;
        import('/import-export/save-load.js').then(m =>
            m.handleLoadProject(new File([new Uint8Array(arr)], 'project.slp')))
            .finally(() => { window.__loadDone = true; });
    }, bytes);
    // The loader asks where the videos are; Esc skips that, as a user
    // reopening a project without its videos at hand would.
    await D.page.waitForSelector('#videoSelectOverlay', { timeout: 40000 })
        .then(() => D.page.keyboard.press('Escape')).catch(() => {});
    await D.page.waitForFunction(() => window.__loadDone, null, { timeout: 40000 }).catch(() => {});
    await D.page.waitForFunction(() => document.getElementById('tbNumAnimals').value !== '', null, { timeout: 5000 })
        .catch(() => {});
    const loadState = await D.page.evaluate(() => ({
        done: window.__loadDone,
        session: window.__lucid.state.session && window.__lucid.state.session.name,
        cams: window.__lucid.state.session ? window.__lucid.state.session.cameras.length : 0,
        status: document.getElementById('statusText').textContent,
        overlays: Array.from(document.querySelectorAll('[class*="modal-overlay"], [id$="Overlay"]'))
            .filter(e => e.offsetParent !== null).map(e => e.id || e.className),
    }));
    console.log('    loaded:', JSON.stringify(loadState));
    r = await read(D.page);
    check(r.stored === 5, `the reopened session carries the count (stored ${JSON.stringify(r.stored)})`);
    check(r.value === '5', `and the field shows it ("${r.value}")`);
    check(!r.dirty, 'reopening does not mark the project unsaved');
    const reopenedRow = await trackAllAnimalsRow(D.page);
    dl = await shown(D);
    check(dl.length === 0, `Track All does not ask (${dl.length} dialog(s))`);
    check(/^for 5 animals/.test(reopenedRow), `and runs with the saved count ("${reopenedRow}")`);
    await D.page.close();
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}

console.log(fails ? `\nFAIL — ${fails} check(s) failed` : '\nPASS — toolbar Animals field');
process.exit(fails ? 1 : 0);
