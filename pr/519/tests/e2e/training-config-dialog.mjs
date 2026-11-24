/**
 * training-config-dialog.mjs — the Training panel's Full Configuration dialog (`ui/training-config-dialog.js`,
 * sleap-app's TrainingConfigDialog) in the web app:
 *
 *  1. "Full Configuration..." shows once there are configs; it opens "Training Configuration" with the tabs
 *     Pipeline, Centroid, Centered Instance, "All changes saved", the Pipeline sections in the nav.
 *  2. A Pipeline field (Accelerator) is written to EVERY model's config.
 *  3. A model tab shows the panel's own values (Max Epochs set on the panel's Centroid tab); an edit there shows
 *     in the panel at once (Max Epochs 42), and goes to that model only (Centered Instance keeps 200).
 *  4. Fields that depend on another appear with it: LR Scheduler Step → Step Size / Gamma, not LR Patience; a
 *     nullable field (Crop Size) empties to null (Auto) and takes a number.
 *  5. Search "plateau patience" → one click goes to the field on a model tab.
 *  6. Save configuration files… downloads centroid.yaml and centered_instance.yaml with the edits; the
 *     training config as sent carries them too.
 *  7. Esc in a search box clears it and keeps the dialog; Reset to profile defaults… (confirmed) on a model tab
 *     puts that model's preset back (max_epochs 200, no step_lr) and leaves the other model's edits; Esc closes.
 *
 * Usage: node tests/e2e/training-config-dialog.mjs   (PORT= to move its server; SHOT=file.png screenshots 3)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTrainingSession } from './fixtures/training-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 9397);
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
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', (e) => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('dialog', (d) => d.accept());
    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 60000 });
    await page.waitForSelector('.panel-rail-btn[data-tab="tabTraining"]', { state: 'attached' });
    await page.evaluate(async () => { (await import('./ui/training-panel.js')).showTrainingPanel(); });
    await loadTrainingSession(page);
    await page.selectOption('#trnModelType', 'top_down');
    const T = () => page.evaluate(async () => {
        const s = (await import('./ui/training-panel.js'))._trainingState();
        return { slots: Object.fromEntries(Object.entries(s.cfg.slots).map(([k, v]) => [k, v.doc])), hp: s.cfg.hp, active: s.cfg.activeTab };
    });
    const field = (id) => `#trnConfigDialog .tcd-field[data-field="${id}"]`;

    console.log('\n1. Open');
    await page.fill('#trnMaxEpochs', '7');
    await page.dispatchEvent('#trnMaxEpochs', 'change');
    check(await page.isVisible('#trnFullConfig'), '"Full Configuration..." shows with configs loaded');
    await page.click('#trnFullConfig');
    await page.waitForSelector('#trnConfigDialog');
    const o1 = await page.evaluate(() => ({
        title: document.getElementById('tcdTitle').textContent,
        tabs: Array.from(document.querySelectorAll('#trnConfigDialog .tcd-tabs .trn-seg-btn')).map((b) => b.textContent),
        pressed: document.querySelector('#trnConfigDialog .tcd-tabs [aria-pressed="true"]').textContent,
        saved: document.querySelector('#trnConfigDialog .tcd-saved').textContent,
        nav: Array.from(document.querySelectorAll('#trnConfigDialog .tcd-nav-btn')).map((b) => b.textContent),
        modal: document.getElementById('trnConfigDialog').hasAttribute('data-shortcut-modal'),
    }));
    check(o1.title === 'Training Configuration' && o1.tabs.join() === 'Pipeline,Centroid,Centered Instance' && o1.pressed === 'Pipeline' &&
        /All changes saved/.test(o1.saved) && o1.modal, 'Training Configuration: Pipeline / Centroid / Centered Instance, All changes saved', o1);
    check(o1.nav.join() === 'Pipeline Type,Pre-processing / Post-processing,Performance,Evaluation,Output', 'the Pipeline sections in the nav', o1.nav);

    console.log('\n2. A Pipeline field goes to every model');
    await page.selectOption(field('accelerator') + ' select', 'cpu');
    const t2 = await T();
    check(t2.slots.centroid.trainer_config.trainer_accelerator === 'cpu' && t2.slots.centered_instance.trainer_config.trainer_accelerator === 'cpu',
        'Accelerator CPU → both configs');
    check(await page.isHidden(field('dataloaderWorkers')) === (t2.slots.centroid.data_config.data_pipeline_fw === 'torch_dataset'),
        'Dataloader Workers shows only with a caching pipeline');

    console.log('\n3. A model tab: the panel\'s values, edits back in the panel');
    await page.click('#trnConfigDialog .tcd-tabs .trn-seg-btn[data-tab="centroid"]');
    await page.waitForSelector(field('maxEpochs'));
    check(await page.inputValue(field('maxEpochs') + ' input') === '7', 'Max Epochs shows the panel\'s 7');
    await page.fill(field('maxEpochs') + ' input', '42');
    await page.dispatchEvent(field('maxEpochs') + ' input', 'change');
    const t3 = await T();
    check(t3.slots.centroid.trainer_config.max_epochs === 42 && t3.hp.centroid.maxEpochs === 42 && t3.hp.centered_instance.maxEpochs === 200,
        'Max Epochs 42: the centroid config and the panel\'s field, not the other model', { c: t3.hp.centroid.maxEpochs, ci: t3.hp.centered_instance.maxEpochs });
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

    console.log('\n4. Dependent and nullable fields');
    await page.selectOption(field('lrSchedulerType') + ' select', 'step_lr');
    const v4b = await page.evaluate(() => {
        const q = (id) => document.querySelector(`#trnConfigDialog .tcd-field[data-field="${id}"]`);
        return { step: !q('lrStepSize').hidden, gamma: !q('lrGamma').hidden, patience: !q('lrPatience').hidden };
    });
    const t4 = await T();
    check(v4b.step && v4b.gamma && !v4b.patience && t4.slots.centroid.trainer_config.lr_scheduler.step_lr.step_size === 10 &&
        t4.slots.centroid.trainer_config.lr_scheduler.reduce_lr_on_plateau == null, 'LR Scheduler Step: Step Size / Gamma shown, one scheduler block', { v4b, s: t4.slots.centroid.trainer_config.lr_scheduler });
    await page.click('#trnConfigDialog .tcd-tabs .trn-seg-btn[data-tab="centered_instance"]');
    await page.fill(field('cropSize') + ' input', '');
    await page.dispatchEvent(field('cropSize') + ' input', 'change');
    const c4a = (await T()).slots.centered_instance.data_config.preprocessing.crop_size;
    await page.fill(field('cropSize') + ' input', '128');
    await page.dispatchEvent(field('cropSize') + ' input', 'change');
    const c4b = (await T()).slots.centered_instance.data_config.preprocessing.crop_size;
    check(c4a === null && c4b === 128 && await page.getAttribute(field('cropSize') + ' input', 'placeholder') === 'Auto', 'Crop Size: empty = null (Auto), then 128', { c4a, c4b });

    console.log('\n5. Search');
    await page.click('#trnConfigDialog .tcd-tabs .trn-seg-btn[data-tab="pipeline"]');
    await page.fill('#tcdSearch', 'plateau patience');
    await page.waitForSelector('#trnConfigDialog .tcd-result');
    const r5 = await page.evaluate(() => Array.from(document.querySelectorAll('#trnConfigDialog .tcd-result')).map((r) => r.textContent));
    await page.click('#trnConfigDialog .tcd-result');
    const s5 = await page.evaluate(() => ({ tab: document.querySelector('#trnConfigDialog .tcd-tabs [aria-pressed="true"]').dataset.tab,
        flash: !!document.querySelector('#trnConfigDialog .tcd-field.tcd-flash[data-field="plateauPatience"]'), open: !!document.getElementById('trnConfigDialog') }));
    check(r5.length === 1 && /Plateau Patience/.test(r5[0]) && /Per-Head/.test(r5[0]) && s5.tab !== 'pipeline' && s5.flash && s5.open,
        '"plateau patience" → Plateau Patience (Per-Head); a click goes to it on a model tab', { r5, s5 });

    console.log('\n6. Save configuration files');
    const downloads = [];
    page.on('download', (d) => downloads.push(d));
    await page.click('#tcdSave');
    await page.waitForFunction(() => true);
    for (let i = 0; i < 50 && downloads.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    const files = {};
    for (const d of downloads) {
        const p = await d.path();
        files[d.suggestedFilename()] = fs.readFileSync(p, 'utf8');
    }
    check(Object.keys(files).sort().join() === 'centered_instance.yaml,centroid.yaml', 'one YAML per model: centroid.yaml, centered_instance.yaml', Object.keys(files));
    check(/max_epochs: 42/.test(files['centroid.yaml'] || '') && /trainer_accelerator: cpu/.test(files['centered_instance.yaml'] || '') &&
        /crop_size: 128/.test(files['centered_instance.yaml'] || '') && /use_wandb: false/.test(files['centroid.yaml'] || ''),
        'they carry the edits (and W&B off)', Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length])));

    console.log('\n7. Esc in the search, Reset to profile defaults, Esc');
    await page.fill('#tcdSearch', 'gamma');
    await page.waitForSelector('#trnConfigDialog .tcd-result');
    await page.press('#tcdSearch', 'Escape');
    check(await page.evaluate(() => !!document.getElementById('trnConfigDialog') && document.getElementById('tcdSearch').value === '' &&
        document.querySelector('#trnConfigDialog .tcd-results').hidden), 'Esc in the search clears it; the dialog stays');
    const confirms = [];
    page.removeAllListeners('dialog');
    page.on('dialog', (d) => { confirms.push(d.message()); d.accept(); });
    await page.click('#tcdReset');
    await page.waitForFunction(async () => {
        const s = (await import('./ui/training-panel.js'))._trainingState();
        return s.cfg.slots.centroid.doc.trainer_config.max_epochs === 200;
    }, null, { timeout: 10000 });
    const t7 = await T();
    check(t7.slots.centroid.trainer_config.max_epochs === 200 && t7.hp.centroid.maxEpochs === 200 && !(t7.slots.centroid.trainer_config.lr_scheduler || {}).step_lr &&
        t7.slots.centroid.trainer_config.trainer_accelerator !== 'cpu', 'the Centroid preset is back (max_epochs 200, no Step scheduler, accelerator as before)');
    check(/restores the Centroid config to the values loaded from the baseline profile/.test(confirms[0] || '') &&
        t7.slots.centered_instance.data_config.preprocessing.crop_size === 128, 'Reset is scoped to the tab: Centered Instance keeps its edit', { confirms, crop: t7.slots.centered_instance.data_config.preprocessing.crop_size });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('trnConfigDialog'));
    check(true, 'Esc closes the dialog');
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} check(s) failed` : '\nall passed');
process.exit(fails ? 1 : 0);
