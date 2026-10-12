/**
 * toolbar-animal-count.mjs — the Track group's Animals field (`#tbNumAnimals`).
 *
 * The animal count every tracking run uses was asked for once, in a native
 * `prompt()` on the first Track Frame / Track All, and then shown nowhere: a
 * user who forgot what they typed had no way to find out short of re-typing it
 * into the Track Frame Range dialog. The field shows it and edits it.
 *
 * Asserted, through the real app:
 *  1. It sits FIRST in the Track group, left of Track Frame on the same row —
 *     after Track All it read as "Track All Animals" — and starts blank, with
 *     an "auto" placeholder.
 *  2. The first-use prompt still fires once, and its answer appears in the
 *     field. A second run does not prompt.
 *  3. Typing a count and pressing Enter sets it, hands focus back (so the
 *     shortcuts work again), and is what Track All uses — read off the summary
 *     box's "for N animals", with N chosen to differ from what auto-detect
 *     would find on this fixture.
 *  4. A bad entry (0, 2.5, -3, a stray "e") is refused and the field reverts,
 *     rather than being read as blank = auto-detect.
 *  5. Esc throws away what was typed.
 *  6. App shortcuts do not fire while typing in it — `p`, which is first
 *     shown to toggle Predictions from outside the field.
 *  7. Blank is auto-detect, and it is an ANSWER: the prompt does not come back
 *     on the next run. Before this a blank answer re-prompted on every run.
 *     Checked on a fresh page, through the prompt itself.
 *  8. The Track Frame Range dialog opens with the field's count and writes its
 *     own back into the field.
 *
 * The 1440px fit is asserted by toolbar-3d-toggle-button.mjs §7.
 *
 * Negative controls, run once: with the prompt gated on the count being null
 * again (the old rule) §7 and §8 fail; without the `badInput` guard the stray
 * "e" is read as auto-detect and §4 and §5 fail.
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

// A fresh app with a trackable two-camera, two-animal session installed (the
// track-marks-dirty.mjs fixture). Every native dialog is answered from
// `answers` in order and counted, so a prompt that should not fire is caught.
async function openApp(browser, answers) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const dialogs = [];
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('dialog', async d => {
        dialogs.push(d.message());
        if (d.type() === 'prompt' && answers.length) await d.accept(answers.shift());
        else await d.dismiss();
    });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    await page.evaluate(async ({ NF }) => {
        const { Skeleton, Camera, Instance, FrameGroup, Session } = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const settings = await import('/ui/settings.js');
        // The automatic ID-switch checks after Track All are not what this
        // file is about, and they only add time.
        settings.setTrackingThresholds(Object.assign({}, settings.getTrackingThresholds(),
            { autoSwitchCheck: 0, autoImageSwitchCheck: 0 }));
        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = [
            new Camera('camA', K, [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]),
            new Camera('camB', K, [0, 0, 0, 0, 0], [0, 0.3, 0], [20, 0, 0], [640, 480]),
        ];
        const ANIMALS = [[[10, 5, 50], [11, 6, 51]], [[-10, 5, 50], [-9, 6, 51]]];
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const session = new Session(cams, skel, ['track_0', 'track_1'], 'AnimalCount');
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
        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = session.numFrames;
        AS.state.currentFrame = 0;
    }, { NF });
    return { page, dialogs };
}

const read = (page) => page.evaluate(async () => {
    const tracker = await import('/pose/tracker.js');
    const f = document.getElementById('tbNumAnimals');
    return {
        value: f.value,
        count: tracker.getTrackerNumAnimals(),
        focused: document.activeElement === f,
        status: document.getElementById('statusText').textContent,
    };
});

// Replace the field's contents the way a user would, then press `key`.
async function typeInto(page, text, key) {
    await page.click('#tbNumAnimals');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    if (text) await page.keyboard.type(text);
    if (key) await page.keyboard.press(key);
}

let browser;
try {
    browser = await chromium.launch();

    // ------------------------------------------------------------ 1. placement
    const A = await openApp(browser, ['4']);
    const page = A.page;
    const geo = await page.evaluate(() => {
        const f = document.getElementById('tbNumAnimals');
        const label = f.closest('label');
        const tf = document.getElementById('tbTrackFrame');
        const fr = f.getBoundingClientRect(), lr = label.getBoundingClientRect(), tr = tf.getBoundingClientRect();
        return {
            sameGroup: label.closest('.toolbar-group') === tf.closest('.toolbar-group'),
            firstInGroup: label.closest('.toolbar-group').firstElementChild === label,
            leftOfTrackFrame: lr.right <= tr.left,
            sameRow: Math.abs((fr.top + fr.bottom) / 2 - (tr.top + tr.bottom) / 2) < 2,
            labelText: label.textContent.trim(),
            placeholder: f.placeholder,
            value: f.value,
        };
    });
    console.log('1. placement');
    check(geo.sameGroup && geo.firstInGroup, 'the field is first in the Track group');
    check(geo.leftOfTrackFrame && geo.sameRow, 'it sits left of Track Frame, on the same row');
    check(geo.labelText === 'Animals', `labelled "${geo.labelText}"`);
    check(geo.value === '' && geo.placeholder === 'auto', `starts blank with an "auto" placeholder (value "${geo.value}")`);

    // ------------------------------------------------- 2. the prompt fills it
    console.log('2. the first-use prompt');
    await page.click('#tbTrackFrame');
    let r = await read(page);
    check(A.dialogs.length === 1 && /Number of animals/.test(A.dialogs[0]),
        `Track Frame prompts once on first use (${A.dialogs.length} dialog(s))`);
    check(r.count === 4 && r.value === '4', `the prompt's answer shows in the field ("${r.value}")`);
    await page.click('#tbTrackFrame');
    check(A.dialogs.length === 1, `a second Track Frame does not prompt (${A.dialogs.length} dialog(s))`);

    // ------------------------------------------ 3. typing a count, Track All
    console.log('3. typing a count');
    await typeInto(page, '3', 'Enter');
    r = await read(page);
    check(r.count === 3 && r.value === '3', `Enter sets the count to 3 (count ${r.count})`);
    check(!r.focused, 'Enter hands focus back, so the shortcuts work again');
    // Three, where auto-detect would find two: the summary can only say three
    // if the typed count reached the run.
    await page.click('#tbTrackAll');
    await page.waitForSelector('#trackSummaryOverlay', { timeout: 60000 });
    const animalsRow = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#trackSummaryOverlay *'))
            .map(e => e.textContent).find(t => /^for \d+ animals?/.test(t)) || '');
    check(/^for 3 animals/.test(animalsRow), `Track All runs with the typed count ("${animalsRow}")`);
    check(A.dialogs.length === 1, 'Track All does not prompt either');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#trackSummaryOverlay', { state: 'detached' });

    // ----------------------------------------------------- 4. bad entries
    console.log('4. bad entries revert');
    for (const bad of ['0', '2.5', '-3', 'e']) {
        await typeInto(page, bad, 'Enter');
        r = await read(page);
        check(r.count === 3 && r.value === '3' && /whole number/.test(r.status),
            `"${bad}" is refused and the field reverts to 3 (value "${r.value}", count ${r.count})`);
    }

    // --------------------------------------------------------- 5. Esc
    console.log('5. Esc');
    await typeInto(page, '7', 'Escape');
    r = await read(page);
    check(r.count === 3 && r.value === '3' && !r.focused, `Esc discards "7" and releases focus (value "${r.value}")`);

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
    await page.click('#tbNumAnimals');
    await page.keyboard.press('p');
    check((await pred()) === predBefore, '"p" typed in the field does not toggle Predictions');
    await page.keyboard.press('Escape');

    // ---------------------------------------------------- 7. blank = auto
    console.log('7. blank is auto-detect');
    await typeInto(page, '', 'Enter');
    r = await read(page);
    check(r.count === null && r.value === '', `clearing the field sets auto-detect (count ${r.count})`);
    await page.click('#tbTrackFrame');
    check(A.dialogs.length === 1, 'a cleared field does not bring the prompt back');
    await A.page.close();

    // A blank ANSWER to the prompt counts as an answer too.
    const B = await openApp(browser, ['']);
    await B.page.click('#tbTrackFrame');
    await B.page.click('#tbTrackFrame');
    r = await read(B.page);
    check(B.dialogs.length === 1, `a blank answer to the prompt is not asked again (${B.dialogs.length} dialog(s))`);
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
    check(B.dialogs.length === 1, 'and no prompt stacks on top of it');
    await B.page.close();
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}

console.log(fails ? `\nFAIL — ${fails} check(s) failed` : '\nPASS — toolbar Animals field');
process.exit(fails ? 1 : 0);
