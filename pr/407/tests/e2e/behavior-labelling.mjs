/**
 * behavior-labelling.mjs — manual behavior labelling in the real app:
 * Label Behaviors mode, the Behavior tab, the timeline's Behavior rows and
 * Shift+drag menu, and identities carrying their labels.
 *
 *  1. Without an ethogram nothing changes: no Behavior rows on the timeline,
 *     and Shift+drag still just reports the range.
 *  2. Mode keys (real key presses): a behavior's letter starts and stops a
 *     state for the focal animal and does NOT reach the catalog action bound
 *     to the same letter (`r` = Toggle Reprojections); digits pick the focal
 *     animal instead of assigning an identity; a social behavior with three
 *     animals waits for its target and its own key stops it; `[` `]` arm a
 *     range that Shift+letter labels "not"; Mod+Z undoes; Esc leaves the mode
 *     and closes running states. Outside the mode the same letter is the
 *     catalog's again.
 *  3. The mode and Defining Plane Mode exclude each other.
 *  4. The Behavior tab: one button per behavior codes at the playhead without
 *     the mode; the bout list jumps (1 s early) and edits.
 *  5. Timeline: one Behavior row per animal; Shift+drag on a row opens the
 *     range menu for THAT animal, and a behavior button labels the range.
 *  6. Rename Identity renames the animal's bouts; an ID-switch-style range swap
 *     moves them; a tracking pass on a labelled session asks first.
 *
 * Run: node tests/e2e/behavior-labelling.mjs   (spawns its own http.server; PORT= to move it)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8194);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // A camera-less project of three animals with 3D (frames step without a decoder).
    await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const NODES = ['Nose', 'Head', 'Neck', 'Trunk', 'TTI'];
        const T = 2000;
        const session = new pd.Session([], new pd.Skeleton('m', NODES, [[0, 1], [1, 2], [2, 3], [3, 4]]), [], 'BehaviorUi');
        for (let i = 0; i < 3; i++) session.addIdentity('id_' + i);
        let gid = 1;
        for (let t = 0; t < T; t++) {
            session.instanceGroups.set(t, [0, 1, 2].map(k => {
                const g = new pd.InstanceGroup(gid++, session.identities[k].id);
                const p = new Float64Array(15);
                for (let n = 0; n < 5; n++) { p[3 * n] = 200 * k + 10 * n; p[3 * n + 1] = 30 * Math.sin(t / 40 + k); p[3 * n + 2] = 5; }
                g.points3d = p;
                return g;
            }));
        }
        AS.state.sessions = [session]; AS.state.activeSessionIdx = 0; AS.state.session = session;
        AS.state.totalFrames = T; AS.state.currentFrame = 0; AS.state.views = []; AS.state.fps = 30;
        AS.timeline.setTotalFrames(T); AS.timeline.setData(session);
        (await import('/ui/info-panel.js')).updateInfoPanel();
    });
    const frame = () => page.evaluate(async () => (await import('/ui/app-state.js')).state.currentFrame);
    const goTo = (f) => page.evaluate(async (f) => (await import('/pose/initialization.js')).navigateToFrame(f), f);
    const bouts = (filter) => page.evaluate(async (filter) => {
        const L = await import('/pose/behavior-labels.js'); const AS = await import('/ui/app-state.js');
        return L.listBouts(AS.state.session, filter || {}).map(b => [b.behaviorId, b.animal, b.target, b.start, b.end, b.present]);
    }, filter);
    const behaviorRows = () => page.evaluate(async () => (await import('/ui/app-state.js')).timeline._trackSegments
        .filter(r => r._isBehavior).map(r => r.trackName));

    console.log('\n-- 1. no ethogram, no change --');
    check((await behaviorRows()).length === 0, 'no Behavior rows on the timeline');

    // The ethogram, through the editor's own model (the modal is exercised in §4).
    await page.evaluate(async () => {
        const eth = await import('/pose/behavior-ethogram.js');
        eth.addBehavior({ name: 'rear', key: 'r' });
        eth.addBehavior({ name: 'groom', key: 'g', group: 'posture' });
        eth.addBehavior({ name: 'walk', key: 'w', group: 'posture' });
        eth.addBehavior({ name: 'chase', key: 'c', social: true });
        (await import('/ui/behavior-coding.js')).requestBehaviorRepaint({ ethogram: true });
        (await import('/ui/app-state.js')).timeline.refreshTracks((await import('/ui/app-state.js')).state.session);
    });
    check(eq(await behaviorRows(), ['id_0', 'id_1', 'id_2']), 'with an ethogram: one Behavior row per animal');

    console.log('\n-- 2. Label Behaviors mode keys --');
    await page.mouse.click(300, 300);
    await page.keyboard.press('Meta+Shift+L');
    check(await page.evaluate(async () => (await import('/ui/behavior-mode.js')).isBehaviorModeActive()), 'Mod+Shift+L enters the mode');
    check(await page.isVisible('#behaviorModeBar'), 'the mode bar shows');
    check(await page.evaluate(() => document.querySelector('.panel-tab[data-tab="tabBehavior"]').classList.contains('active')),
        'the Behavior tab opens');
    const reprojBefore = await page.isChecked('#visReprojections');
    await goTo(100);
    await page.keyboard.press('r');
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('r');
    check(eq(await bouts(), [['b1', 'id_0', '', 100, 120, true]]), 'r … r codes rear 100–120 for animal 1');
    check(await page.isChecked('#visReprojections') === reprojBefore, 'and r did not toggle Reprojections (its catalog action)');
    await page.keyboard.press('2');
    const focal = await page.evaluate(async () => (await import('/ui/behavior-coding.js')).focalAnimal((await import('/ui/app-state.js')).state.session));
    check(focal === 'id_1', 'digit 2 picks animal 2');
    await page.keyboard.press('c');
    check(await page.evaluate(async () => !!(await import('/ui/behavior-coding.js')).behaviorUi().pending), 'chase (social, 3 animals) waits for its target');
    await page.keyboard.press('3');
    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('c');
    check(eq(await bouts({ behaviorId: 'b4' }), [['b4', 'id_1', 'id_2', 120, 130, true]]), '3 picks the target; c again stops it (no second question)');
    await goTo(200);
    await page.keyboard.press('BracketLeft');
    await goTo(240);
    await page.keyboard.press('BracketRight');
    await page.keyboard.press('Shift+G');
    check(eq(await bouts({ behaviorId: 'b2', present: false }), [['b2', 'id_1', '', 200, 240, false]]), '[ ] arm a range; Shift+G labels it "not groom"');
    await page.keyboard.press('Meta+Z');
    check((await bouts({ behaviorId: 'b2', present: false })).length === 0, 'Mod+Z undoes it');
    await goTo(300);
    await page.keyboard.press('w');
    await goTo(320);
    await page.keyboard.press('Escape');
    check(!(await page.evaluate(async () => (await import('/ui/behavior-mode.js')).isBehaviorModeActive())), 'Esc leaves the mode');
    check(eq(await bouts({ behaviorId: 'b3' }), [['b3', 'id_1', '', 300, 320, true]]), 'leaving closes the running state at the playhead');
    await page.keyboard.press('r');
    check(await page.isChecked('#visReprojections') !== reprojBefore, 'outside the mode r is Toggle Reprojections again');
    await page.keyboard.press('r');

    console.log('\n-- 3. one mode at a time --');
    const modes = await page.evaluate(async () => {
        const M = await import('/ui/behavior-mode.js'); const PD = await import('/ui/plane-definition.js');
        M.enterBehaviorMode(); PD.enterPlaneMode();
        const a = [M.isBehaviorModeActive(), PD.isPlaneModeActive()];
        M.enterBehaviorMode();
        const b = [M.isBehaviorModeActive(), PD.isPlaneModeActive()];
        M.exitBehaviorMode();
        return { a, b };
    });
    check(eq(modes.a, [false, true]), 'entering Define Planes leaves Label Behaviors mode');
    check(eq(modes.b, [true, false]), 'and entering Label Behaviors leaves Define Planes');

    console.log('\n-- 4. Behavior tab --');
    await page.click('#behaviorEthogramBtn');
    check(await page.isVisible('.behavior-ethogram-modal'), 'Edit ethogram… opens the editor');
    check(await page.locator('#behaviorEdRows tr[data-id]').count() === 4, 'listing the four behaviors');
    await page.keyboard.press('Escape');
    check(!(await page.isVisible('.behavior-ethogram-modal')), 'Esc closes it');
    await goTo(500);
    await page.click('#behaviorCodingBody .behavior-animal[data-animal="id_2"]');
    await page.click('#behaviorCodingBody .behavior-chip-btn[data-behavior="b1"]');
    await goTo(520);
    await page.click('#behaviorCodingBody .behavior-chip-btn[data-behavior="b1"]');
    check(eq(await bouts({ animal: 'id_2', behaviorId: 'b1' }), [['b1', 'id_2', '', 500, 520, true]]),
        'the tab\'s behavior button codes at the playhead without the mode');
    await page.waitForFunction(() => document.querySelectorAll('#behaviorBoutsBody .behavior-bout').length >= 4);
    await goTo(0);
    await page.click('#behaviorBoutsBody .behavior-bout[data-key="b1|id_2||500|520"] .behavior-bout-main');
    check(await frame() === 470, `a bout click lands 1 s early (frame ${await frame()})`);
    await goTo(510);
    await page.click('#behaviorBoutsBody .behavior-bout.is-current [data-act="set-end"]');
    check(eq(await bouts({ animal: 'id_2', behaviorId: 'b1' }), [['b1', 'id_2', '', 500, 510, true]]), 'End ← playhead edits the bout');

    console.log('\n-- 5. timeline Shift+drag menu --');
    const box = await page.evaluate(async () => {
        const tl = (await import('/ui/app-state.js')).timeline;
        const rect = tl._canvas.getBoundingClientRect();
        let cumY = tl._layout.trackAreaTop, prev = null, y = null;
        for (const row of tl._trackSegments) {
            if (prev != null && row.cameraName !== prev) cumY += tl.VIEW_GROUP_GAP;
            if (row._isBehavior && row.trackName === 'id_0') { y = cumY + 5; break; }
            cumY += tl.TRACK_ROW_HEIGHT + tl.TRACK_ROW_GAP; prev = row.cameraName;
        }
        return { x0: rect.left + tl._frameToX(1000), x1: rect.left + tl._frameToX(1100), y: rect.top + y };
    });
    await page.keyboard.down('Shift');
    await page.mouse.move(box.x0, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x1, box.y, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    check(await page.isVisible('#behaviorRangeMenu'), 'Shift+drag opens the range menu');
    check(await page.inputValue('#behaviorRangeMenu select') === 'id_0', 'for the animal whose row the drag started on');
    await page.click('#behaviorRangeMenu .behavior-chip-btn[data-behavior="b2"]');
    const g = await bouts({ animal: 'id_0', behaviorId: 'b2' });
    check(g.length === 1 && g[0][5] === true && Math.abs(g[0][3] - 1000) <= 2 && Math.abs(g[0][4] - 1100) <= 2,
        `a behavior button labels the range (${JSON.stringify(g)})`);
    check(!(await page.isVisible('#behaviorRangeMenu')), 'and closes the menu');
    const segs = await page.evaluate(async () => (await import('/ui/app-state.js')).timeline._trackSegments
        .find(r => r._isBehavior && r.trackName === 'id_0').segments.length);
    check(segs >= 2, `the id_0 row draws its bouts (${segs} segments)`);

    console.log('\n-- 6. identities carry their labels --');
    await page.evaluate(() => document.getElementById('menuRenameIdentity').click());
    await page.click('.rename-list >> text=id_0');
    await page.fill('#renameNameInput', 'Alice');
    await page.click('#renameApply');
    check((await bouts({ animal: 'Alice' })).length >= 2 && (await bouts({ animal: 'id_0' })).length === 0, 'Rename Identity renames the bouts');
    check(eq(await behaviorRows(), ['Alice', 'id_1', 'id_2']), 'and the timeline row');
    const swapped = await page.evaluate(async () => {
        const AS = await import('/ui/app-state.js'); const s = AS.state.session;
        s.swapIdentitiesInRange(1050, 1999, s.identities[0].id, s.identities[2].id);
        const L = await import('/pose/behavior-labels.js');
        return L.listBouts(s, { behaviorId: 'b2' }).map(b => [b.animal, b.start, b.end]);
    });
    check(swapped.some(b => b[0] === 'Alice' && b[2] === 1049) && swapped.some(b => b[0] === 'id_2' && b[1] === 1050),
        `a range swap (an ID-switch fix) splits and moves the bout (${JSON.stringify(swapped)})`);
    const ask = page.evaluate(async () => {
        const C = await import('/ui/behavior-confirm.js'); const AS = await import('/ui/app-state.js');
        return C.confirmRetrackWithBehaviorLabels(AS.state.session, 'Track All');
    });
    await page.waitForSelector('#behaviorRetrackConfirm');
    check(/Behavior bouts in this session/.test(await page.textContent('#behaviorRetrackConfirm')), 'a tracking pass on a labelled session asks first, with counts');
    await page.keyboard.press('Escape');
    check((await ask) === false, 'Esc cancels it');

    console.log('\n-- 7. chips on the video --');
    const chips = await page.evaluate(async () => {
        const ov = await import('/ui/overlays.js'); const C = await import('/ui/behavior-coding.js');
        const AS = await import('/ui/app-state.js'); const pd = await import('/pose/pose-data.js');
        const eth = await import('/pose/behavior-ethogram.js');
        const at = C.behaviorChipsAt(AS.state.session, 1020);       // Alice grooms 1001–1049 (after the swap)
        const forAlice = at && at('Alice'), forId1 = at && at('id_1');
        const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 240;
        const ctx = canvas.getContext('2d');
        const inst = new pd.Instance([[120, 200], [130, 200]], 0, 'predicted', 0.9);
        ov.drawBehaviorChips(ctx, [inst], [forAlice], { labelSize: 11, canvasWidth: 240, canvasHeight: 240, labelDisplayScale: 1 });
        const want = eth.behaviorById('b2').color;
        const rgb = [1, 3, 5].map(i => parseInt(want.slice(i, i + 2), 16));
        let hits = 0;
        const px = ctx.getImageData(0, 0, 240, 200).data;
        for (let i = 0; i < px.length; i += 4) {
            if (Math.abs(px[i] - rgb[0]) < 30 && Math.abs(px[i + 1] - rgb[1]) < 30 && Math.abs(px[i + 2] - rgb[2]) < 30) hits++;
        }
        C.setBehaviorChipsVisible(false);
        const hidden = C.behaviorChipsAt(AS.state.session, 1020);
        C.setBehaviorChipsVisible(true);
        return { forAlice, forId1, hits, hidden: hidden === null };
    });
    check(chips.forAlice && chips.forAlice.length === 1 && chips.forAlice[0].text === 'groom' && chips.forId1 === null,
        `the frame's chips name what each animal is doing (${JSON.stringify(chips.forAlice)})`);
    check(chips.hits > 50, `a chip is drawn above the animal in its behavior's color (${chips.hits} px)`);
    check(chips.hidden, 'the tab\'s "On video" switch turns them off');

    check(errs.length === 0, `no page errors (${errs.join(' | ').slice(0, 300)})`);
    console.log(fails === 0 ? '\nPASS' : `\nFAIL — ${fails} check(s)`);
    await browser.close();
    browser = null;
    process.exitCode = fails === 0 ? 0 : 1;
} finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
}
