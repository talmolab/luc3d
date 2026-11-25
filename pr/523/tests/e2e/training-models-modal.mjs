/**
 * training-models-modal.mjs — Training ▸ Edit models… (`ui/training-models-modal.js`): the models a run trains, each
 * on its camera views with its own settings, and the panel's summary of them, on the shared two-view session
 * (cam1, cam2; 6 labelled frames each):
 *   1. The panel: one model "All views" (sleap-app's training) with both views, its settings line, the Run summary;
 *      no settings on the panel itself. Edit models… opens the modal on it ("follows every view").
 *   2. The Views table is folded; open, it lists each view's labelled frames and scrolls within a capped height.
 *   3. + New model with cam2 ticked: "Model 2" on cam2, shown in the side panel; cam2 now trains both models and
 *      gets the most specific one after training (Model 2), unless the user picks another.
 *   4. A tag's ✕ takes a view out (the model stops following every view; the footer warns about the unused view);
 *      "+ Add view" puts it back. By name is off when the views share no word.
 *   5. Hover lights cameras in the 3D view (`Viewport3D.tintCameras` focus): a model card → its views, a tag → that
 *      view; nothing hovered → the shown model's views.
 *   6. Cancel keeps the panel's models; Apply hands them over (two cards, Model 2's settings its own); Delete in the
 *      side panel removes a model; Esc closes.
 *   7. A split's new models never take an old model's id, and a config picked right after the split goes to the
 *      new model; the validation fraction survives a change of model type; a tag's ✕ by keyboard leaves focus on
 *      its card's "+ Add view".
 * Usage: node tests/e2e/training-models-modal.mjs   (PORT= to move its server; SHOT=file.png screenshots the modal)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTrainingSession } from './fixtures/training-session.js';
import { openModels, applyModels } from './fixtures/training-models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9402);
const BASE = `http://localhost:${PORT}`;

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (c || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 900)));
    if (!c) fails++;
};

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));
let browser;
try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', (e) => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('dialog', (d) => d.accept());
    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    await page.waitForSelector('.panel-rail-btn[data-tab="tabTraining"]', { state: 'attached' });
    await page.evaluate(async () => { (await import('./ui/training-panel.js')).showTrainingPanel(); });
    await loadTrainingSession(page);
    // Record what the modal's 3D view is told to light (`tintCameras`), whatever WebGL does.
    await page.evaluate(async () => {
        const V = (await import('./ui/viewport3d.js')).Viewport3D;
        const orig = V.prototype.tintCameras;
        V.prototype.tintCameras = function (spec) { window.__tint = JSON.parse(JSON.stringify(spec)); return orig.call(this, spec); };
    });
    const cards = () => page.$$eval('#trnModelCards .trn-sum-card', (cs) => cs.map((c) => ({
        name: c.querySelector('.trn-sum-name').textContent, tags: Array.from(c.querySelectorAll('.trn-sum-tag')).map((t) => t.textContent),
        meta: c.querySelector('.trn-sum-meta').textContent })));
    const mcards = () => page.$$eval('#trnMmModels .trn-mm-card', (cs) => cs.map((c) => ({
        name: c.querySelector('.trn-mm-name').textContent, sel: c.classList.contains('sel'),
        tags: Array.from(c.querySelectorAll('.trn-mm-tag')).map((t) => t.dataset.view), auto: !!c.querySelector('.trn-mm-auto') })));
    const status = () => page.evaluate(() => ({ text: document.getElementById('trnMmStatus').textContent, warn: document.getElementById('trnMmStatus').classList.contains('inf-mm-warn') }));

    console.log('\n1. The panel and the modal');
    await page.waitForFunction(() => document.querySelectorAll('#trnModelCards .trn-sum-card').length === 1);
    const c1 = await cards();
    check(c1.length === 1 && c1[0].name === 'All views' && c1[0].tags.join() === 'cam1,cam2' && /^12 labelled frames · /.test(c1[0].meta),
        'one model, All views, on cam1 and cam2 (12 labelled frames)', c1);
    const panelIds = await page.evaluate(() => ['trnModelType', 'trnMaxEpochs', 'trnFullConfig', 'trnViews', 'trnPostTarget'].filter((id) => document.getElementById(id)));
    check(panelIds.length === 0, 'no settings on the panel itself', panelIds);
    const run = await page.$$eval('#trnRunSummary span', (ss) => ss.map((s) => s.textContent));
    check(run[0] === 'Validation' && /^10% of each model’s frames/.test(run[1]) && run[2] === 'Afterwards' && run[3] === 'inference on 20 random frames',
        'Run summary: validation and post-training inference', run);
    await openModels(page);
    const m1 = await mcards();
    check(m1.length === 1 && m1[0].sel && m1[0].tags.join() === 'cam1,cam2' && m1[0].auto, 'the modal shows All views, following every view', m1);
    check(await page.inputValue('#trnMmName') === 'All views' && await page.isVisible('#trnModelType') && await page.isVisible('#trnFullConfig'),
        'its settings in the side panel');
    check((await status()).text === 'Every labelled view trains a model · 1 model · 1 training job', 'footer: every view trains a model', await status());

    console.log('\n2. The Views table');
    check(await page.evaluate(() => !document.getElementById('trnMmViewsFold').open), 'folded by default');
    await page.click('#trnMmViewsFold > summary');
    const v2 = await page.evaluate(() => {
        const box = document.getElementById('trnMmViews');
        const cs = getComputedStyle(box);
        return { rows: Array.from(box.querySelectorAll('.trn-mm-vrow[data-view]')).map((r) => r.dataset.view + ':' + r.children[2].textContent),
            maxH: cs.maxHeight, overflow: cs.overflowY };
    });
    check(v2.rows.join() === 'cam1:6,cam2:6' && v2.maxH === '240px' && v2.overflow === 'auto', 'each view with its 6 frames, in a capped scrolling box', v2);

    console.log('\n3. A second model, a view in both');
    await page.check('#trnMmViews .trn-mm-vrow[data-view="cam2"] input[type="checkbox"]');
    await page.click('#trnMmAddModel');
    const m3 = await mcards();
    check(m3.length === 2 && m3[1].name === 'Model 2' && m3[1].sel && m3[1].tags.join() === 'cam2' && await page.inputValue('#trnMmName') === 'Model 2',
        '+ New model takes the ticked view and shows the new model', m3);
    await page.fill('#trnMmName', 'Side');
    await page.dispatchEvent('#trnMmName', 'change');
    check((await mcards())[1].name === 'Side', 'renamed in the side panel', await mcards());
    const inf = await page.evaluate(() => {
        const r = document.querySelector('#trnMmViews .trn-mm-vrow[data-view="cam2"]');
        const s = r.querySelector('.trn-mm-infer select');
        return { chips: Array.from(r.querySelectorAll('.trn-mm-chip')).map((c) => c.textContent + (c.classList.contains('on') ? '+' : '-')),
            options: s ? Array.from(s.options).map((o) => o.textContent) : null, value: s ? s.options[s.selectedIndex].textContent : null,
            cam1: document.querySelector('#trnMmViews .trn-mm-vrow[data-view="cam1"] .trn-mm-infer').textContent };
    });
    check(inf.chips.join() === 'All views+,Side+' && inf.options && inf.options.join() === 'All views,Side' && inf.value === 'Side' && inf.cam1 === 'All views',
        'cam2 trains both; after training it gets the more specific model (Side)', inf);
    await page.selectOption('#trnMmViews .trn-mm-vrow[data-view="cam2"] .trn-mm-infer select', { label: 'All views' });
    const pref = await page.evaluate(async () => (await import('./ui/training-panel.js'))._trainingState().work.runCfg.inferWith);
    check(pref.cam2 === 'm1', 'the user\'s pick is kept for cam2', pref);
    check((await status()).text === 'Every labelled view trains a model · 2 models · 2 training jobs', 'footer counts both models', await status());

    console.log('\n4. Tags');
    await page.click('#trnMmModels .trn-mm-card:nth-child(1) .trn-mm-tag[data-view="cam1"] .trn-mm-tagx');
    const m4 = await mcards();
    const s4 = await status();
    check(m4[0].tags.join() === 'cam2' && !m4[0].auto, '✕ takes cam1 out of All views (no longer following every view)', m4);
    check(s4.warn && s4.text === 'cam1 trains no model: its 6 labelled frames go unused.', 'the footer warns about cam1', s4);
    await page.selectOption('#trnMmModels .trn-mm-card:nth-child(1) .trn-mm-addview', 'cam1');
    check((await mcards())[0].tags.join() === 'cam1,cam2' && !(await status()).warn, '+ Add view puts it back, in view order');
    const byName = await page.evaluate(() => { const b = document.getElementById('trnMmSplitName'); return { disabled: b.disabled, text: b.textContent }; });
    check(byName.disabled && byName.text === 'By name', 'By name is off: cam1 and cam2 share no word to group by', byName);

    console.log('\n5. Hover lights cameras');
    const tint = () => page.evaluate(() => window.__tint || null);
    await page.mouse.move(5, 5);
    const t0 = await tint();
    check(!!t0 && (t0.focus || []).join() === 'cam2' && t0.colors.cam2, 'nothing hovered: the shown model (Side) is lit', t0);
    await page.hover('#trnMmModels .trn-mm-card:nth-child(1) .trn-mm-meta');
    const t1 = await tint();
    check((t1.focus || []).join() === 'cam1,cam2', 'hovering All views lights both its cameras', t1);
    await page.hover('#trnMmModels .trn-mm-card:nth-child(1) .trn-mm-tag[data-view="cam1"]');
    const t2 = await tint();
    const foot = await page.textContent('#trnMm3dFoot');
    check((t2.focus || []).join() === 'cam1' && foot === 'cam1 → All views', 'hovering a tag lights that camera, named with its models', { t2, foot });
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

    console.log('\n6. Cancel, Apply, Delete, Esc');
    await page.click('#trnMmCancel');
    await page.waitForFunction(() => !document.getElementById('trnModelsModal'));
    check((await cards()).length === 1, 'Cancel: the panel keeps its one model');
    await openModels(page);
    await page.click('#trnMmAddModel');
    await page.selectOption('#trnMmModels .trn-mm-card:nth-child(2) .trn-mm-addview', 'cam2');
    await page.fill('#trnMaxEpochs', '9');
    await page.dispatchEvent('#trnMaxEpochs', 'change');
    await applyModels(page);
    const c6 = await cards();
    check(c6.length === 2 && c6[1].name === 'Model 2' && c6[1].tags.join() === 'cam2' && /9 epochs$/.test(c6[1].meta) && /200 epochs$/.test(c6[0].meta),
        'Apply: two models on the panel, Model 2 with its own Max Epochs', c6);
    const st = await page.evaluate(async () => (await import('./ui/training-panel.js'))._trainingState().groups.map((g) => g.name + ':' + g.views.join('+')));
    check(st.join() === 'All views:cam1+cam2,Model 2:cam2', 'the next run trains both models', st);
    await page.click('#trnModelCards .trn-sum-card:nth-child(2) .trn-sum-edit');
    await page.waitForSelector('#trnModelsModal');
    check(await page.inputValue('#trnMmName') === 'Model 2', 'a card\'s pencil opens the modal on that model');
    await page.click('#trnMmDelete');
    check((await mcards()).map((m) => m.name).join() === 'All views', 'Delete removes the shown model');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('trnModelsModal'));
    check((await cards()).length === 2, 'Esc closes without applying');

    console.log('\n7. Splits, the validation fraction, keyboard focus');
    await openModels(page);
    const W = () => page.evaluate(async () => (await import('./ui/training-panel.js'))._trainingState().work.models
        .map((m) => ({ id: m.id, name: m.name, centroid: m.slots.centroid ? m.slots.centroid.name : null, type: m.modelType,
            vf: Object.values(m.hp).map((h) => h.validationFraction) })));
    const before = (await W()).map((m) => m.id);
    await page.selectOption('#trnModelType', 'top_down');
    await page.click('#trnMmSplitEach');
    const after = await W();
    check(after.length === 2 && after.every((m) => before.indexOf(m.id) === -1) && after.every((m) => m.type === 'top_down'),
        'the split\'s models have new ids and the shown model\'s Top-Down', { before, after });
    await page.selectOption('#trnSlot-centroid', 'preset:baseline_large_rf.centroid.yaml');
    const w7 = await W();
    check(w7[0].centroid === 'Preset: Centroid (Large RF)' && w7[1].centroid === 'Preset: Centroid (Medium RF)',
        'a config picked right after the split goes to the shown new model only', w7.map((m) => m.centroid));
    await page.click('#trnMmRunFold > summary');
    await page.fill('#trnValFraction', '0.2');
    await page.dispatchEvent('#trnValFraction', 'change');
    await page.selectOption('#trnModelType', 'bottom_up');
    const w7b = await W();
    check(w7b[0].type === 'bottom_up' && w7b.every((m) => m.vf.every((v) => v === 0.2)), 'a new model type keeps the run\'s validation fraction (0.2)', w7b);
    await page.focus('#trnMmModels .trn-mm-card:nth-child(1) .trn-mm-tag .trn-mm-tagx');
    await page.keyboard.press('Enter');
    const fk = await page.evaluate(() => document.activeElement && document.activeElement.dataset.fk);
    check(fk === 'add|' + w7b[0].id, 'a tag\'s ✕ by keyboard: focus moves to its card\'s + Add view', fk);
    await page.click('#trnMmCancel');
} catch (e) {
    console.log('  ✗ threw: ' + (e && e.stack || e));
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
