/**
 * track-setup-modal.mjs — the dialog Track All / Track Frame open the first
 * time they run on a session (ui/track-setup-modal.js): the number of animals,
 * with the node weights laid out under it for review.
 *
 * It replaced a native `prompt()` that asked for the count alone. Node weights
 * reach the tracker's association cost but live in Tracks ▸ Tracking Wizard and
 * are saved per BROWSER, so a weight left at 0 from another project dropped a
 * node from this one's matching with nothing on the way to the run saying so.
 *
 * Asserted, through the real app and the real keyboard:
 *  1. Track All on an unanswered session opens it, and no native dialog: titled
 *     "Track All", the count field focused, blank, "auto" placeholder; one row
 *     per skeleton node IN ORDER, each showing the weight a run would use (two
 *     stored overrides among them), a weight of 0 greyed as in the Wizard.
 *     Under them, the image ID-switch check: its switch (off, the default) and
 *     its options, hidden while it is off.
 *  2. Esc, and the Cancel button, close it with nothing changed: no run, no
 *     count, no weight or image-check setting written, the project not dirty —
 *     and the next Track All asks again.
 *  3. Bad input is refused inline, never clamped: a count of 0, a weight of
 *     1.5 (the error names the node), an image-check flag threshold of 5, with
 *     Continue disabled and Enter not closing it.
 *  4. Continue (typed count + typed weight + image check switched on with two
 *     options changed + Enter) runs Track All with that count; the weights are
 *     written to the SAME setting the Tracking Wizard edits (its field shows the
 *     new value) and merged into the stored ones — a weight kept for a node of
 *     ANOTHER skeleton survives; the image-check settings are stored, and the
 *     run itself attempted the check (skipped here: no videos are loaded).
 *  5. Answered once, it is not asked again: a second Track All runs at once.
 *  6. A second session is unanswered, so Track Frame asks — titled "Track
 *     Frame", pre-filled with the last count given, and with no image-check
 *     section (a single frame is never checked).
 *  7. Track Frame Range shows the same weight grid and image-check section
 *     with the stored values: a bad weight disables Continue, Esc writes
 *     nothing, and Continue writes the edited weight (merged) and image-check
 *     option before the range runs — and that range run attempts the check.
 *  8. No scroll-within-scroll: with a 40-node skeleton in a short window the
 *     CARD scrolls, its weight grid never does, and Continue is reachable.
 *
 * That the run reads the weights given in the dialog (not the ones before it)
 * is pinned in Node by tests/test-tracker-gui.mjs.
 *
 * Run: node tests/e2e/track-setup-modal.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8377);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const NODES = ['Nose', 'Head', 'LeftEar', 'RightEar', 'Neck', 'TailBase', 'TailMid', 'TailTip'];

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    const native = [];
    page.on('dialog', async d => { native.push(d.message()); await d.dismiss(); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // Two synthetic animals seen by three calibrated cameras (the rig of
    // track-all-turns-on-trails.mjs), with a mouse-like skeleton.
    await page.evaluate(async (NODES) => {
        const pd = await import('/pose/pose-data.js');
        const AS = await import('/ui/app-state.js');
        const settings = await import('/ui/settings.js');
        const saveLoad = await import('/import-export/save-load.js');
        const { Skeleton, Camera, Instance, FrameGroup, Session } = pd;
        // The automatic ID-switch checks after Track All are not what this file
        // is about, and they only add time.
        settings.setTrackingThresholds(Object.assign({}, settings.getTrackingThresholds(),
            { autoSwitchCheck: 0, autoImageSwitchCheck: 0 }));
        const cam = (name, rvec, tvec) =>
            new Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], rvec, tvec, [640, 480]);
        window.__mkSession = (name, nodes) => {
            const CAMS = [cam('c0', [0, 0, 0], [0, 0, 0]), cam('c1', [0, 0.35, 0], [-12, 0, 3]), cam('c2', [0.35, 0, 0], [0, -12, 3])];
            const session = new Session(CAMS, new Skeleton('mouse', nodes, []), ['track_0', 'track_1'], name);
            for (let f = 0; f < 4; f++) {
                const fg = new FrameGroup(f);
                [[-7 + 0.3 * f, 0, 48], [7 - 0.3 * f, 0, 48]].forEach((ctr, ai) => CAMS.forEach(c =>
                    fg.addInstance(c.name, new Instance(nodes.map((_, k) => c.project(
                        [ctr[0] + 2 * Math.cos(k), ctr[1] + 2 * Math.sin(k), ctr[2] + (k % 3)])), ai, 'predicted', 1.0))));
                session.addFrameGroup(fg);
            }
            return session;
        };
        window.__activate = (sessions, idx) => {
            AS.state.sessions = sessions;
            AS.state.activeSessionIdx = idx;
            AS.state.session = sessions[idx];
            AS.state.totalFrames = 4;
            AS.state.currentFrame = 0;
            AS.state.triangulationResults = new Map();
            AS.state.views = [];
        };
        window.__first = window.__mkSession('SetupA', NODES);
        window.__activate([window.__first], 0);
        // Stored overrides: two for this skeleton, one for a node it does not have.
        settings.setNodeWeights({ TailMid: 0.5, TailTip: 0, otherSkeletonNode: 0.3 });
        saveLoad.clearDirty();
    }, NODES);

    const dialog = () => page.evaluate(() => {
        const m = document.querySelector('.track-setup-modal');
        if (!m) return null;
        const a = m.querySelector('#trackSetupAnimals');
        return {
            title: m.querySelector('h3').textContent,
            animals: a.value,
            placeholder: a.placeholder,
            focused: document.activeElement === a,
            imageSwitch: (m.querySelector('input[data-setting="autoImageSwitchCheck"]') || {}).checked,
            imageOptionsShown: !!m.querySelector('.track-setup-options') && !m.querySelector('.track-setup-options').hidden,
            imageOptions: [...m.querySelectorAll('.track-setup-options .settings-kbd-label, .track-setup-options .track-setup-switch-row')]
                .map(e => e.textContent.trim()),
            gpuTime: (m.querySelector('input[data-setting="imageCheckGpuTimePct"]') || {}).value,
            cpuTime: (m.querySelector('input[data-setting="imageCheckCpuTimePct"]') || {}).value,
            notes: m.querySelectorAll('.settings-threshold-note').length,
            rows: [...m.querySelectorAll('.track-setup-weights .settings-node-weight-row')].map(r => ({
                name: r.querySelector('.settings-kbd-label').textContent,
                value: r.querySelector('input').value,
                greyed: r.classList.contains('settings-view-excluded'),
            })),
            error: m.querySelector('#trackSetupError').textContent,
            continueDisabled: m.querySelector('#trackSetupContinue').disabled,
        };
    });
    const appState = () => page.evaluate(async () => {
        const settings = await import('/ui/settings.js');
        const s = window.__lucid.state;
        return {
            numAnimals: s.session.numAnimals,
            identities: s.session.identities.length,
            dirty: s.isDirty === true,
            weights: settings.getNodeWeights(),
            image: ['autoImageSwitchCheck', 'imageChangeThreshold', 'imageCheckHz', 'imageCheckMaxViews', 'imageCheckGpuTimePct', 'imageCheckCpuTimePct', 'imageCheckWebNN']
                .map(id => settings.getTrackingThreshold(id)),
            status: document.getElementById('statusText').textContent,
            summary: !!document.getElementById('trackSummaryOverlay'),
        };
    });
    const STORED = JSON.stringify({ TailMid: 0.5, TailTip: 0, otherSkeletonNode: 0.3 });

    // ------------------------------------------------------------ 1. opens
    console.log('1. Track All on an unanswered session');
    await page.click('#tbTrackAll');
    await page.waitForSelector('.track-setup-modal', { timeout: 5000 });
    let d = await dialog();
    check(native.length === 0, `no native dialog (${native.length})`);
    check(d.title === 'Track All', `titled "${d.title}"`);
    check(d.focused && d.animals === '' && d.placeholder === 'auto',
        `the count field is focused, blank, with an "auto" placeholder (value "${d.animals}")`);
    check(JSON.stringify(d.rows.map(r => r.name)) === JSON.stringify(NODES),
        `one row per skeleton node, in order (${d.rows.map(r => r.name).join(', ')})`);
    check(JSON.stringify(d.rows.map(r => r.value)) === JSON.stringify(['1', '1', '1', '1', '1', '1', '0.5', '0']),
        `each shows the weight a run would use, stored ones included (${d.rows.map(r => r.value).join(', ')})`);
    check(JSON.stringify(d.rows.map(r => r.greyed)) === JSON.stringify([false, false, false, false, false, false, false, true]),
        'a node weighted 0 is greyed out, as in the Tracking Wizard');
    check(d.imageSwitch === false && !d.imageOptionsShown,
        'the image ID-switch check is offered, off (the default), its options hidden');
    const IMAGE_DEFAULTS = JSON.stringify([0, -0.8, 2, 3, 80, 80, 0]);
    // The switch's own <input> is visually hidden; a user clicks its label.
    const imageSwitch = '.track-setup-modal .track-image-check-block > .track-setup-switch-row';
    await page.click(imageSwitch);
    d = await dialog();
    check(d.imageSwitch === true && d.imageOptionsShown &&
        JSON.stringify(d.imageOptions) === JSON.stringify(['Flag threshold', 'Crops per second', 'Views per animal', 'GPU time (%)', 'CPU time (%)', 'Try WebNN (experimental)']),
        `switching it on shows its six options (${d.imageOptions.join(', ')})`);
    check(d.gpuTime === '80' && d.cpuTime === '80' && d.notes === 0,
        `the two caps read as whole percentages (${d.gpuTime}, ${d.cpuTime}), with no "N of C cores" note`);
    {
        // GPU time and CPU time share a row, Try WebNN starts the row under them; each cap has a short ⓘ
        const lay = await page.evaluate(() => {
            const row = id => document.querySelector(`.track-setup-modal .settings-node-weight-row[data-row="${id}"]`).getBoundingClientRect();
            const g = row('imageCheckGpuTimePct'), c = row('imageCheckCpuTimePct'), w = row('imageCheckWebNN');
            const tips = [...document.querySelectorAll('.track-setup-modal .track-setup-options [data-infotip]')].map(e => e.dataset.infotip);
            const cpuLabel = document.querySelector('.track-setup-modal .settings-node-weight-row[data-row="imageCheckCpuTimePct"] .settings-kbd-label');
            return { sameRow: Math.abs(g.top - c.top) < 1 && c.left > g.left, webnnBelow: w.top >= g.bottom - 1 && Math.abs(w.left - g.left) < 1,
                     tips, cpuLabelWhole: cpuLabel.scrollWidth <= cpuLabel.clientWidth, cpuLabelTitle: cpuLabel.hasAttribute('title') };
        });
        check(lay.sameRow && lay.webnnBelow, 'GPU time and CPU time sit on one row, Try WebNN on the row under them');
        check(lay.tips.length === 2 && lay.tips.every(t => t.length <= 80 && /GPU|CPU/.test(t)) && !lay.cpuLabelTitle,
            `each cap has a short ⓘ instead of a native tooltip (${JSON.stringify(lay.tips)})`);
        check(lay.cpuLabelWhole, '"CPU time (%)" is shown whole');
        const btn = page.locator('.track-setup-modal .settings-node-weight-row[data-row="imageCheckGpuTimePct"] .info-tip-btn');
        const bb = await btn.boundingBox();
        await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await page.mouse.move(bb.x + bb.width / 2 + 1, bb.y + bb.height / 2 + 1);
        const tip = await page.evaluate(() => {
            // the tip takes no pointer events, so elementFromPoint cannot see it: compare stacking order with
            // the dialog's overlay instead (both are fixed children of <body>); at 10000 vs 20000 it drew behind
            const t = document.querySelector('.info-tip:not([hidden])'), o = document.querySelector('.multi-frame-modal-overlay');
            if (!t || !o) return null;
            return { text: t.textContent, onTop: t.parentElement === document.body && o.parentElement === document.body
                && Number(getComputedStyle(t).zIndex) > Number(getComputedStyle(o).zIndex) };
        });
        check(!!tip && /GPU/.test(tip.text) && tip.onTop, `hovering the GPU ⓘ shows its tip ABOVE the dialog ("${tip && tip.text}")`);
        await page.mouse.move(5, 5);
    }
    await page.focus('#trackSetupAnimals');

    // ----------------------------------------------------------- 2. cancel
    console.log('2. Esc and Cancel change nothing');
    await page.keyboard.type('3');
    await page.keyboard.press('Escape');
    let s = await appState();
    check(!(await dialog()), 'Esc closes it');
    check(s.numAnimals === null && s.identities === 0 && !s.summary,
        `no run and no count (numAnimals ${s.numAnimals}, ${s.identities} identities)`);
    check(JSON.stringify(s.weights) === STORED && !s.dirty, 'no weight written, project not dirty');
    check(JSON.stringify(s.image) === IMAGE_DEFAULTS, `the image check stays off and unchanged (${s.image})`);
    await page.click('#tbTrackAll');
    await page.waitForSelector('.track-setup-modal', { timeout: 5000 });
    check(true, 'the next Track All asks again');
    await page.click('#trackSetupCancel');
    s = await appState();
    check(!(await dialog()) && s.numAnimals === null && s.identities === 0 && JSON.stringify(s.weights) === STORED,
        'the Cancel button changes nothing either');

    // ------------------------------------------------------ 3. validation
    console.log('3. bad input is refused, not clamped');
    await page.click('#tbTrackAll');
    await page.waitForSelector('.track-setup-modal', { timeout: 5000 });
    await page.keyboard.type('0');
    d = await dialog();
    check(d.continueDisabled && /whole number, 1 or more/.test(d.error), `a count of 0: "${d.error}"`);
    await page.keyboard.press('Enter');
    check(!!(await dialog()), 'and Enter does not close it');
    await page.fill('#trackSetupAnimals', '2');
    const tailMid = '.track-setup-modal input[data-node="TailMid"]';
    await page.fill(tailMid, '1.5');
    d = await dialog();
    check(d.continueDisabled && /TailMid/.test(d.error) && /between 0 and 1/.test(d.error),
        `a weight of 1.5: "${d.error}"`);
    check(d.rows.find(r => r.name === 'TailMid').value === '1.5', 'the typed value is left as typed, not clamped');
    await page.fill(tailMid, '0.5');
    await page.click(imageSwitch);
    const flagThr = '.track-setup-modal input[data-setting="imageChangeThreshold"]';
    await page.fill(flagThr, '5');
    d = await dialog();
    check(d.continueDisabled && /Flag threshold must be between -4 and 0/.test(d.error), `a flag threshold of 5: "${d.error}"`);
    await page.fill(flagThr, '-0.5');
    await page.fill('.track-setup-modal input[data-setting="imageCheckHz"]', '3');

    // ---------------------------------------------------------- 4. continue
    console.log('4. Continue runs with the count, and writes the weights');
    await page.click(tailMid, { clickCount: 3 });
    await page.keyboard.type('0.25');
    d = await dialog();
    check(!d.continueDisabled && d.error === '', 'a valid form enables Continue');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#trackSummaryOverlay', { timeout: 30000 });
    s = await appState();
    check(!(await dialog()), 'Enter closes it');
    check(JSON.stringify(s.image) === JSON.stringify([1, -0.5, 3, 3, 80, 80, 0]),
        `the image check is stored on, with the two edited options (${s.image})`);
    check(/ID-switch check \(images\): skipped — needs the session's videos/.test(s.status),
        'and this run attempted it (skipped: no videos are loaded)');
    check(s.numAnimals === 2 && s.identities === 2, `Track All ran with 2 animals (${s.identities} identities)`);
    check(JSON.stringify(s.weights) === JSON.stringify({ TailMid: 0.25, TailTip: 0, otherSkeletonNode: 0.3 }),
        `the edited weight is stored, the rest kept — another skeleton's too (${JSON.stringify(s.weights)})`);
    await page.click('#trackSummaryClose');
    const wizard = await page.evaluate(async () => {
        (await import('/ui/settings-modal.js')).showSettingsModal('wizard');
        const v = document.querySelector('input[aria-label="Weight for node TailMid"]').value;
        // Close it properly: removing the overlay would leave its document-level
        // keydown listener behind, swallowing every key after it.
        document.querySelector('.settings-modal-close').click();
        return v;
    });
    check(wizard === '0.25', `the Tracking Wizard shows the same weight ("${wizard}")`);

    // ---------------------------------------------------------- 5. not again
    console.log('5. answered once');
    await page.click('#tbTrackAll');
    await page.waitForSelector('#trackSummaryOverlay', { timeout: 30000 });
    check(!(await dialog()), 'a second Track All runs without asking');
    await page.click('#trackSummaryClose');

    // ------------------------------------------------- 6. another session
    console.log('6. a second, unanswered session');
    await page.evaluate((NODES) => window.__activate([window.__first, window.__mkSession('SetupB', NODES)], 1), NODES);
    await page.click('#tbTrackFrame');
    await page.waitForSelector('.track-setup-modal', { timeout: 5000 });
    d = await dialog();
    check(d.title === 'Track Frame', `Track Frame asks, titled "${d.title}"`);
    check(d.imageSwitch === undefined, 'with no image-check section');
    check(d.animals === '2', `pre-filled with the last count given ("${d.animals}")`);
    check(d.rows.find(r => r.name === 'TailMid').value === '0.25', 'and shows the weights as now stored');
    await page.keyboard.press('Enter');
    s = await appState();
    check(!(await dialog()) && s.numAnimals === 2 && s.identities === 2, 'Enter tracks the frame with that count');

    // ------------------------------------------------ 7. Track Frame Range
    console.log('7. the Track Frame Range dialog');
    const openRange = async () => {
        await page.evaluate(() => document.getElementById('tbTrackFrameRange').click());
        await page.waitForSelector('.track-range-modal', { timeout: 5000 });
    };
    const rangeRows = () => page.evaluate(() => [...document.querySelectorAll('.track-range-modal .track-setup-weights .settings-node-weight-row')]
        .map(r => ({ name: r.querySelector('.settings-kbd-label').textContent, value: r.querySelector('input').value,
            greyed: r.classList.contains('settings-view-excluded') })));
    await openRange();
    let rr = await rangeRows();
    check(JSON.stringify(rr.map(r => r.name)) === JSON.stringify(NODES), 'it lists every skeleton node, in order');
    check(JSON.stringify(rr.map(r => r.value)) === JSON.stringify(['1', '1', '1', '1', '1', '1', '0.25', '0']) && rr[7].greyed,
        `with the stored weights, 0 greyed (${rr.map(r => r.value).join(', ')})`);
    const rangeImage = () => page.evaluate(() => {
        const m = document.querySelector('.track-range-modal');
        const opts = m.querySelector('.track-setup-options');
        return {
            label: (m.querySelector('.track-image-check-block > .track-setup-switch-row') || {}).textContent,
            on: (m.querySelector('input[data-setting="autoImageSwitchCheck"]') || {}).checked,
            shown: !!opts && !opts.hidden,
            thr: (m.querySelector('input[data-setting="imageChangeThreshold"]') || {}).value,
            hz: (m.querySelector('input[data-setting="imageCheckHz"]') || {}).value,
        };
    });
    let ri = await rangeImage();
    check(ri.label === 'Check for ID switches by image after tracking the range',
        `the image-check section is there, worded for the range ("${ri.label}")`);
    check(ri.on && ri.shown && ri.thr === '-0.5' && ri.hz === '3',
        `showing the stored settings: on, threshold ${ri.thr}, ${ri.hz} crops/s`);
    const rangeSwitch = '.track-range-modal .track-image-check-block > .track-setup-switch-row';
    await page.click(rangeSwitch);
    ri = await rangeImage();
    check(!ri.on && !ri.shown, 'switching it off hides its options');
    const rangeTail = '.track-range-modal input[data-node="TailTip"]';
    await page.fill(rangeTail, '-1');
    let rerr = await page.evaluate(() => ({ err: document.getElementById('trackRangeError').textContent,
        disabled: document.getElementById('trackRangeContinue').disabled }));
    check(rerr.disabled && /TailTip/.test(rerr.err), `a weight of -1 is refused: "${rerr.err}"`);
    await page.fill(rangeTail, '0.75');
    await page.keyboard.press('Escape');
    s = await appState();
    check(!(await page.$('.track-range-modal')) && s.weights.TailTip === 0 &&
        JSON.stringify(s.image) === JSON.stringify([1, -0.5, 3, 3, 80, 80, 0]), 'Esc closes it and writes nothing (image check still on)');
    await openRange();
    await page.fill(rangeTail, '0.75');
    await page.fill('.track-range-modal input[data-setting="imageChangeThreshold"]', '-1');
    await page.evaluate(() => { document.getElementById('statusText').textContent = ''; });
    await page.click('#trackRangeContinue');
    await page.waitForSelector('.track-range-modal', { state: 'detached' });
    await page.waitForFunction(() => /identit/i.test(document.getElementById('statusText').textContent), null, { timeout: 30000 });
    s = await appState();
    check(JSON.stringify(s.image) === JSON.stringify([1, -1, 3, 3, 80, 80, 0]), `Continue stores the edited threshold (${s.image})`);
    check(/ID-switch check \(images\): skipped — needs the session's videos/.test(s.status),
        'and the range run attempted the check (skipped: no videos are loaded)');
    check(JSON.stringify(s.weights) === JSON.stringify({ TailMid: 0.25, TailTip: 0.75, otherSkeletonNode: 0.3 }),
        `Continue stores the edited weight, the rest kept (${JSON.stringify(s.weights)})`);
    check(!(await dialog()), 'and the first-use dialog does not stack on top of it');

    // ---------------------------------------- 8. one scroller, long skeleton
    console.log('8. a long skeleton in a short window');
    await page.setViewportSize({ width: 1200, height: 560 });
    const LONG = Array.from({ length: 40 }, (_, k) => 'node_' + k);
    await page.evaluate((LONG) => window.__activate([window.__mkSession('SetupLong', LONG)], 0), LONG);
    await page.click('#tbTrackAll');
    await page.waitForSelector('.track-setup-modal', { timeout: 5000 });
    const geo = await page.evaluate(() => {
        const m = document.querySelector('.track-setup-modal');
        const list = m.querySelector('.track-setup-weights');
        const r = m.getBoundingClientRect();
        m.scrollTop = m.scrollHeight;
        const btn = m.querySelector('#trackSetupContinue').getBoundingClientRect();
        return {
            cardScrolls: m.scrollHeight > m.clientHeight && getComputedStyle(m).overflowY === 'auto',
            listScrolls: list.scrollHeight > list.clientHeight || !/visible/.test(getComputedStyle(list).overflowY),
            inWindow: r.top >= 0 && r.bottom <= window.innerHeight,
            continueVisible: btn.top >= r.top && btn.bottom <= r.bottom,
            rows: m.querySelectorAll('.track-setup-weights .settings-node-weight-row').length,
        };
    });
    check(geo.rows === 40, `all 40 nodes are listed (${geo.rows})`);
    check(geo.inWindow && geo.cardScrolls, 'the card fits the window and scrolls');
    check(!geo.listScrolls, 'the weight grid does not scroll by itself');
    check(geo.continueVisible, 'Continue is reachable at the bottom');
    await page.keyboard.press('Escape');

    check(native.length === 0, `no native dialog at any point (${native.length})`);
    check(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
